/**
 * The telemetry repository: bulk insertion and the complete read surface of the
 * `telemetry_events` table, over `node:sqlite`.
 *
 * Every piece of evidence this product reasons about arrives here. A capture
 * writes one row per span from all three tiers — the browser agent's
 * interactions, React commits, requests and performance entries; the Node
 * preload's HTTP, route-handler, function and database spans — and every later
 * stage reads them back through this module: the correlator builds a trace tree
 * from them, the aggregates count renders, group duplicate requests and compute
 * the fixed metric set, the analysis stage cites individual events as facts, the
 * generated panels query them by source, the live tail streams them while a
 * capture runs, and the retention sweep removes them when a session ages out.
 *
 * ## The privacy boundary, which is upstream of this module
 *
 * **This repository persists only already-redacted events, and it redacts
 * nothing itself.** Both transformations happen in
 * `../telemetry/ingest.ts` before {@link TelemetryRepo.insertMany} is ever
 * called:
 *
 * 1. `@debuggen/telemetry`'s redactor replaces header values, query-parameter
 *    values, inline SQL literals, token-shaped strings and prop/state previews,
 *    and records what it replaced on the event's `redacted` field (AAP 0.5.2);
 * 2. the `request_key` grouping hash is computed from the **unredacted** URL
 *    under the random per-session key, which is why the key can group two
 *    byte-identical requests while keeping two requests that differ only in a
 *    parameter value apart, even though both URLs are stored with their values
 *    masked.
 *
 * Neither step may move here. A redaction pass at the storage boundary would
 * run *after* the live tail had already broadcast the event, and the request
 * key cannot be recomputed from a stored row at all — the value it hashes is
 * gone by then, by design. A future caller looking for "where redaction
 * happens" should follow the ingest path and not add a second pass below it:
 * two passes would disagree, and the one that runs later would be the one the
 * developer never sees.
 *
 * The same boundary shapes what this module *says*. Log records and errors
 * carry counts, identifiers, column names and `ingest_seq` values and nothing
 * else — never an event's `name`, its attributes, a statement, a URL or any
 * parameter value. That is not stylistic: an error raised here is logged, may
 * be persisted with the session and may be shown in both user interfaces, and
 * it passes through neither the redaction layer nor the outbound model guard
 * (AAP 0.5.2). Validation failures inherit the same discipline for free,
 * because `parseTelemetryEvent` reduces a rejection to field paths and issue
 * codes before it returns.
 *
 * ## The ordering contracts, and the half of each this module owns
 *
 * Two orders are specified, for different readers, and this module serves
 * both, from two row-ordering tables, one in-memory lineage pass and one group
 * ordering:
 *
 * - **The flat canonical chain, for the correlator.** AAP 0.2.3 fixes the
 *   order of a capture as **parent before child, then `startTime`, then
 *   `(producerId, seq)`, then `ingestSeq`**. Every convenience reader —
 *   {@link TelemetryRepo.listByTrace}, which `../telemetry/correlate.ts` pages
 *   through to build a trace tree, and `listByCapture`, `listByRequestKey`,
 *   `listChildren` and `getBySpanId` — orders by {@link CANONICAL_ORDER_BY}
 *   (behind `duration DESC`, or behind the group count, under the other two
 *   sorts), whose last key, the store-assigned `ingest_seq`, can never tie.
 * - **The panel-data order, for generated panels.** AAP 0.4.2 fixes that a
 *   panel query's `sort` orders "with a stable secondary key (`id`)".
 *   {@link TelemetryRepo.query} — the surface `../panels/data.ts` forwards a
 *   panel node's `DataQuery` onto — orders by the key its sort names and then
 *   by the event id, {@link PANEL_SECONDARY_ORDER_BY}; the group orderings of
 *   {@link TelemetryRepo.queryGroups} likewise end in the group key and then
 *   the id of the group's first event. The flat panel orderings read no
 *   arrival number, so a panel's order is a property of the evidence rather
 *   than of which batch reached the store first.
 * - **The canonical parent-first order, for the `spans` panel source.** Under
 *   `start_asc` with {@link TelemetryQuery.parentFirst}, {@link TelemetryRepo.query}
 *   answers the whole of AAP 0.2.3's canonical order — parent before child,
 *   then the flat chain above — because a list of correlated work that shows
 *   a child above the request that caused it misstates causality. Its last key
 *   is the canonical chain's `ingest_seq`, the one panel ordering that reads an
 *   arrival number: AAP 0.2.3 names it as the final tie-breaker, and it only
 *   ever decides between two rows of one producer with one sequence number.
 *
 * All are **total** — `ingest_seq` and `id` are each unique — which is what
 * makes a page of results reproducible between two requests, and what makes
 * `limit`/`offset` paging coherent rather than a lottery over equal
 * timestamps. Of the canonical order the work is split, deliberately:
 *
 * - **SQL orders rows**, by the flat-column chain above, for every reader.
 * - **Parent-before-child is computed in memory**, never in recursive SQL.
 *   The correlator (`packages/telemetry/src/correlation/correlator.ts`)
 *   establishes it for a trace tree when it nests events by
 *   `(traceId, parentSpanId)` and walks the result depth-first; for a flat,
 *   pageable list of rows {@link parentFirstOrder} establishes it over the
 *   flat keys of the whole selection, as a topological order that reads no
 *   event document and emits every row exactly once, cycles included. A
 *   recursive SQL ordering would duplicate that logic in a second language,
 *   and it would be wrong in the one case that matters, where a server span's
 *   clock reads slightly earlier than the browser span that caused it: both
 *   in-memory orders follow the parent link, not the clock. The flat chain is
 *   kept as the convenience readers' order because the correlator's page walk
 *   pages by it. AAP 0.2.3 aligns no clocks: each producer's own estimate of its
 *   offset from the server that answered it travels on its events as
 *   `clockOffsetMs`, is stored in the `clock_offset_ms` column and summarised
 *   per producer by {@link TelemetryRepo.listProducerClockOffsets}, and is
 *   never added to `start_time` or `duration`.
 *
 * `compareEventsCanonical` in that same module is the in-memory twin of
 * {@link CANONICAL_ORDER_BY}, and the two agree key for key. They also agree on
 * *collation*: every producer id is `prd_` plus sixteen characters of
 * `[0-9a-z]`, so SQLite's default `BINARY` comparison over UTF-8 and
 * JavaScript's code-unit comparison order those strings identically.
 *
 * ## What the columns are for
 *
 * The `event` column holds the whole {@link TelemetryEvent} as JSON and is the
 * **authoritative** copy: every read reconstructs the event from it and
 * validates the result. The flat columns exist so filtering and ordering are
 * indexed rather than JSON-walked, which is why `request_key` is denormalised
 * out of the attributes at ingest and why `start_time` and `duration` are
 * `REAL`: the producers emit sub-millisecond doubles and a correlated cross-tier
 * timeline is only correct if that precision round-trips unrounded. Nothing here
 * rounds either value.
 *
 * `clock_offset_ms` (schema version 5, added by `./migrations.ts`) projects the
 * event's optional `clockOffsetMs` — `NULL` when the producer reported none, and
 * for every row written before that version — so the per-producer clock
 * diagnostic is one grouped read. Reads that rebuild events never consult it:
 * the field round-trips through the `event` document like every other.
 *
 * `ingest_seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so the database assigns
 * it and never reuses a value — not even after a retention purge, which is what
 * keeps the ordering sound across the lifetime of a database (see
 * {@link TelemetryRepo.deleteOlderThan}). A replay that conflicts on `id` does
 * consume a sequence value, so gaps are ordinary; only the relative order of
 * the numbers is meaningful.
 *
 * ## What this module does not do
 *
 * It returns rows, counts and occurrence groups. Aggregation proper lives in
 * `packages/telemetry/src/aggregate/*` — render statistics, request and query
 * groups with their duplicate counts, timeline lanes, the component tree
 * snapshot and the metric set — and `../panels/data.ts` is what maps a panel's
 * `DataQuery` onto this repository plus those aggregates. A render or request
 * aggregate computed here would be a second implementation of a shape a panel
 * already validates against, so there is none.
 *
 * The one grouping it does compute is the occurrence count: every
 * `DataQuerySort` member is accepted, and `count_desc` — largest group first —
 * needs a count per group to be a total, pageable order.
 * {@link TelemetryRepo.queryGroups} returns one entry per distinct value of a
 * key drawn from a closed vocabulary ({@link TELEMETRY_GROUP_KEYS}) with its
 * count, first event and timing over the **readable** events of the filter,
 * ordered `count DESC, key ASC, first event id ASC`;
 * {@link TelemetryRepo.query} under `count_desc` ranks rows by the count of the
 * group each belongs to, through a window function over the stored rows — the
 * basis `total` uses. Neither is an alias for a row ordering, and neither
 * computes what an aggregate shape adds on top of a count.
 *
 * ## Failure discipline
 *
 * Every method answers with a {@link Result} and never throws: an ingest batch
 * arrives from a transport and a panel query is answered while a developer
 * watches, so neither may unwind the loop that serves it. Two failure kinds are
 * treated differently on purpose:
 *
 * - **A malformed event offered for insertion is refused**, with the field paths
 *   that failed. Writing it would put a row in the table that no later read
 *   could reconstruct.
 * - **A stored row that no longer validates is skipped, counted and reported**
 *   at `warn` with its `ingest_seq` alone, so one poisoned row cannot blank out
 *   a whole generated panel (AAP 0.5.5). The count travels on
 *   {@link TelemetryPage.skipped} so the caller can say so.
 *
 * Error codes come from `@debuggen/shared`'s closed vocabulary and nothing
 * invents one: `PROTOCOL_INVALID_MESSAGE` for a value that did not match the
 * event schema (the code `parseTelemetryEvent` itself uses, whichever transport
 * delivered it), and `STORE_ERROR` for persistence refusing, for a query
 * argument this module will not accept, and for a row that is in the table but
 * is not an event.
 *
 * @packageDocumentation
 */

import { Buffer } from 'node:buffer';
import type { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_SORTS,
  isDataQuerySort,
} from '@debuggen/panel-schema';
import type { DataQuerySort, IdResolution } from '@debuggen/panel-schema';
import { DebuggenError, err, isErr, noopLogger, ok } from '@debuggen/shared';
import type { CaptureId, Logger, ProducerId, Result, SessionId } from '@debuggen/shared';
import {
  CLOCK_OFFSET_BOUND_MS,
  FETCH_ATTRIBUTE_KEYS,
  RENDER_ATTRIBUTE_KEYS,
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
  TELEMETRY_KINDS,
  TELEMETRY_TIERS,
  isClockOffsetMs,
  isTelemetryKind,
  isTelemetryTier,
  parseTelemetryEvent,
} from '@debuggen/telemetry';
import type { TelemetryEvent, TelemetryKind, TelemetryTier } from '@debuggen/telemetry';

import { LOG_BINDING_KEYS } from '../logging.js';
import type { Store } from './db.js';

/* -------------------------------------------------------------------------------------------------
 * Bindings
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `subsystem` binding every record from this repository carries, matching
 * `./db.ts`, `./migrations.ts` and `./modifications-repo.ts` so store lines can
 * be filtered out of a session's log without matching on message text.
 */
const SUBSYSTEM = 'store';

/**
 * The `repo` binding, which distinguishes this repository's records from the
 * other repositories sharing the `store` subsystem.
 */
const REPO = 'telemetry';

/** The field name the `repo` binding is emitted under. */
const REPO_BINDING_KEY = 'repo';

/* -------------------------------------------------------------------------------------------------
 * Attribute keys read out of the event document
 * ---------------------------------------------------------------------------------------------- */

/**
 * The attribute key the denormalised `request_key` column is copied from.
 *
 * Typed as a member of the request attribute catalog rather than written as a
 * bare string, so a rename in `packages/telemetry/src/schema/attributes.ts`
 * fails this line at compile time instead of quietly producing rows whose
 * column is always `NULL` — which would disable duplicate-request grouping
 * without any read failing.
 */
const REQUEST_KEY_ATTRIBUTE: (typeof FETCH_ATTRIBUTE_KEYS)[number] = 'request_key';

/**
 * The attribute key {@link TelemetryQuery.component} filters on.
 *
 * Typed against the render attribute catalog for the same reason as
 * {@link REQUEST_KEY_ATTRIBUTE}.
 */
const COMPONENT_ATTRIBUTE: (typeof RENDER_ATTRIBUTE_KEYS)[number] = 'component';

/**
 * Whether the grouping key is still a key the *service* assigns.
 *
 * A trust boundary rather than decoration, and the same check
 * `packages/telemetry/src/aggregate/requests.ts` makes before it groups on the
 * key. The column may be written from the attributes only because the ingest
 * path computes the value under a key a producer is forbidden to set; were a
 * future edit to move the key out of that group, a page could choose which of
 * its own requests are reported as duplicates of each other. Reading the
 * catalog here means such an edit shows up as this constant turning `false`,
 * and the insert path then stores `NULL` rather than a producer-supplied digest.
 */
const REQUEST_KEY_IS_SERVICE_ASSIGNED: boolean =
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS.includes(REQUEST_KEY_ATTRIBUTE);

/**
 * The JSON path {@link TelemetryQuery.component} is matched at.
 *
 * Assembled once, at module load, from {@link COMPONENT_ATTRIBUTE} — an
 * identifier drawn from the attribute catalog, never a caller's value. It is
 * the only piece of any statement text below that is not literal, and it is
 * still a constant: the prepared-statement cache therefore holds one entry per
 * query *shape*, and no value reaches SQLite except through a binding.
 */
const COMPONENT_JSON_PATH = `$.attributes.${COMPONENT_ATTRIBUTE}`;

/* -------------------------------------------------------------------------------------------------
 * Ordering
 * ---------------------------------------------------------------------------------------------- */

/**
 * The store's canonical total order over telemetry rows: `startTime`, then the
 * emitting producer, then that producer's own sequence number, then the
 * arrival number that can never tie.
 *
 * Exported so there is exactly one definition of it — every ordering of the
 * convenience readers ends in this chain ({@link TelemetryRepo.listByTrace},
 * the read the correlator pages through, among them), and a suite asserts
 * their order against `compareEventsCanonical` rather than restating the keys.
 * {@link TelemetryRepo.query} orders by it only for a parent-first page
 * ({@link TelemetryQuery.parentFirst}), where it ranks the rows
 * {@link parentFirstOrder} then puts in lineage order; otherwise the
 * panel-data surface orders by {@link PANEL_START_ASC_ORDER_BY} and its
 * siblings, whose secondary key is the event id AAP 0.4.2 names.
 *
 * Why each key, in order (AAP 0.2.3):
 *
 * 1. `start_time` — when the operation began, in epoch milliseconds as a
 *    double. The order a developer expects to read a capture in.
 * 2. `producer_id` — two producers (a page document and a dev-server process)
 *    routinely report the same millisecond, and nothing else separates them.
 *    It sits above `seq` because `seq` only ever disambiguates events of the
 *    *same* producer.
 * 3. `seq` — the per-producer monotonic counter, scoped to
 *    `(producerId, captureId)`, which records emission order more finely than
 *    a timestamp can.
 * 4. `ingest_seq` — the store's own arrival number, distinct by construction,
 *    which is what makes this order **total** and therefore reproducible
 *    across requests and across a page boundary.
 *
 * What it deliberately does not do: nest children under parents. That is
 * applied in memory — by the correlator to a tree, by
 * {@link parentFirstOrder} to a flat page — see this module's overview.
 */
export const CANONICAL_ORDER_BY = 'start_time ASC, producer_id ASC, seq ASC, ingest_seq ASC';

/**
 * The slowest-first ordering of the convenience readers, with the canonical
 * chain as its tie-break.
 *
 * The chain is not decoration: a reader paging through "slowest operations"
 * meets two spans of identical duration all the time (a zero-duration `state`
 * transition, a cached request). Without a total order behind `duration DESC`,
 * the same row could appear on two pages or on none.
 */
export const DURATION_DESC_ORDER_BY = `duration DESC, ${CANONICAL_ORDER_BY}`;

/**
 * The stable secondary key every panel-data ordering ends in: the event `id`,
 * ascending.
 *
 * AAP 0.4.2 fixes it for `POST /sessions/:id/panel-data` — `sort` orders "with
 * a stable secondary key (`id`) per source" — and {@link TelemetryRepo.query}
 * is the repository half of that route. Two properties make it the right key:
 *
 * - **It is unique.** `telemetry_events.id` is `TEXT NOT NULL UNIQUE`, so
 *   an ordering that ends in it never compares two rows as equal: the order is
 *   total, and a multi-page walk visits every row exactly once.
 * - **It belongs to the event, not to its arrival.** The producer assigns it
 *   (`newEventId` in `@debuggen/shared`) and a replay cannot change it, so,
 *   unlike `ingest_seq`, it does not depend on which of two batches reached the
 *   store first — and it is the same value a panel fact cites as evidence.
 *
 * Compared under SQLite's default `BINARY` collation, byte by byte. The ids the
 * producers mint are `evt_` plus sixteen characters of `[0-9a-z]`, which
 * JavaScript's code-unit comparison orders identically.
 */
export const PANEL_SECONDARY_ORDER_BY = 'id ASC';

/**
 * The panel-data `start_asc` ordering: earliest first, the event id breaking
 * ties.
 *
 * The flat order of a source listed by the key its sort names — the `events`
 * log, and every whole-slice scan ({@link TelemetryRepo.scanEvents}) the
 * aggregates read. It is deliberately not the canonical order: a record list
 * sorted chronologically reads by time, and the aggregates are computed from
 * sets, so neither needs lineage. The one panel source that does — `spans`,
 * whose rows are the work of correlated traces — opts into the canonical
 * parent-first order with {@link TelemetryQuery.parentFirst} instead.
 */
export const PANEL_START_ASC_ORDER_BY = `start_time ASC, ${PANEL_SECONDARY_ORDER_BY}`;

/**
 * The panel-data `duration_desc` ordering: slowest first, the event id breaking
 * ties — which, for spans of identical duration, is what keeps a latency
 * panel's pages from repeating or skipping a row.
 */
export const PANEL_DURATION_DESC_ORDER_BY = `duration DESC, ${PANEL_SECONDARY_ORDER_BY}`;

/**
 * What a parent-first ordering reads of one row: the trace it belongs to, its
 * own span id, and the span it names as its parent.
 *
 * Exactly the flat columns `trace_id`, `span_id` and `parent_span_id`, and
 * exactly the same-named fields of a {@link TelemetryEvent} — so the store can
 * order its key rows with {@link parentFirstOrder} and `../panels/data.ts` can
 * derive the same order from the events a page returned, through one
 * implementation.
 */
export interface LineageKey {
  /** The correlation id of the row's interaction. */
  readonly traceId: string;
  /** The row's own span id. */
  readonly spanId: string;
  /** The span the row names as its parent; absent for a root. */
  readonly parentSpanId?: string | undefined;
}

/**
 * Pushes a rank onto a binary min-heap held in a plain array.
 *
 * @param heap The heap; `heap[0]` is its smallest rank.
 * @param rank The rank to add.
 */
function pushRank(heap: number[], rank: number): void {
  let index = heap.length;

  heap.push(rank);

  while (index > 0) {
    const parentIndex = (index - 1) >> 1;
    const parentRank = heap[parentIndex] ?? rank;

    if (parentRank <= rank) {
      break;
    }

    heap[index] = parentRank;
    index = parentIndex;
  }

  heap[index] = rank;
}

/**
 * Removes and returns the smallest rank of a binary min-heap.
 *
 * @param heap The heap, non-empty.
 * @returns The smallest rank, or `undefined` for an empty heap.
 */
function popRank(heap: number[]): number | undefined {
  const top = heap[0];
  const last = heap.pop();

  if (top === undefined || last === undefined || heap.length === 0) {
    return top;
  }

  // Sift the former last element down from the root.
  const length = heap.length;
  let index = 0;

  for (;;) {
    const left = 2 * index + 1;

    if (left >= length) {
      break;
    }

    const right = left + 1;
    const leftRank = heap[left] ?? last;
    const rightRank = right < length ? (heap[right] ?? last) : Number.POSITIVE_INFINITY;
    const child = rightRank < leftRank ? right : left;
    const childRank = Math.min(leftRank, rightRank);

    if (last <= childRank) {
      break;
    }

    heap[index] = childRank;
    index = child;
  }

  heap[index] = last;

  return top;
}

/** The link-list terminator of {@link parentFirstOrder}'s child lists. */
const NO_ROW = -1;

/**
 * Orders rows **parent before child, then by their flat canonical rank** — the
 * canonical order AAP 0.2.3 fixes for a capture: parent-before-child, then
 * `startTime`, then `(producerId, seq)`, then `ingestSeq`.
 *
 * The caller supplies the rows already in the flat chain
 * ({@link CANONICAL_ORDER_BY} in SQL, `compareEventsCanonical` in memory), so a
 * row's position in `keys` is its rank. What this adds is the lineage, as a
 * topological order computed in memory rather than in recursive SQL:
 *
 * - **Parent.** A row's parent is the row of the **same trace** whose span id
 *   is the row's `parentSpanId`; when several rows carry that span id — a
 *   replayed or colliding span — the lowest-ranked one, the occurrence the
 *   correlator also keeps. A row naming no parent, a parent outside the set
 *   (never captured, in another trace, or removed by the caller's filter), or
 *   itself, is a **root** of the ordered set.
 * - **Order.** Kahn's algorithm with a min-heap on rank: of the rows whose
 *   parent has already been emitted (the roots at first), the smallest rank is
 *   emitted next. So no row precedes its parent, and among the rows that could
 *   come next the flat chain decides — which is why a server span whose clock
 *   reads earlier than the browser request that caused it still follows it.
 * - **Cycles.** When nothing is ready while rows remain — every one waits on a
 *   parent that can only come after it, as members of a parent cycle and
 *   their descendants do — the smallest-ranked remaining row is released as
 *   if it were a root. Every row is emitted **exactly once**, whatever the
 *   ancestry, so a page walk over this order can neither repeat nor drop one.
 *
 * Deterministic and total: the result is a function of the ranks and the
 * three identities alone, and it is a permutation of `0 … keys.length - 1`.
 * `O(n log n)` time and `O(n)` memory; nothing is read beyond the keys.
 *
 * @param keys Every row of the ordered set, in flat canonical order.
 * @returns The ranks of `keys`, in parent-first order.
 *
 * @example
 * ```ts
 * // A child whose clock reads 5 ms before its parent's still follows it.
 * parentFirstOrder([
 *   { traceId: t, spanId: 'b1', parentSpanId: 'a0' }, // rank 0: earliest start
 *   { traceId: t, spanId: 'a0' },                     // rank 1: the root
 * ]); // → [1, 0]
 * ```
 */
export function parentFirstOrder(keys: readonly LineageKey[]): number[] {
  const count = keys.length;

  // The lowest-ranked row of each (trace, span) identity. Nested maps rather
  // than a joined string key, so no lookup allocates.
  const bySpan = new Map<string, Map<string, number>>();

  for (const [rank, key] of keys.entries()) {
    let spans = bySpan.get(key.traceId);

    if (spans === undefined) {
      spans = new Map();
      bySpan.set(key.traceId, spans);
    }

    if (!spans.has(key.spanId)) {
      spans.set(key.spanId, rank);
    }
  }

  // Each parent's children as a singly linked list threaded through two
  // arrays; the heap, not the list, decides their order.
  const firstChild = new Array<number>(count).fill(NO_ROW);
  const nextSibling = new Array<number>(count).fill(NO_ROW);
  const ready: number[] = [];

  for (const [rank, key] of keys.entries()) {
    const parent =
      key.parentSpanId === undefined ? undefined : bySpan.get(key.traceId)?.get(key.parentSpanId);

    if (parent === undefined || parent === rank) {
      // Ascending ranks keep the heap property without a sift.
      pushRank(ready, rank);
    } else {
      nextSibling[rank] = firstChild[parent] ?? NO_ROW;
      firstChild[parent] = rank;
    }
  }

  const order: number[] = [];
  const emitted = new Array<boolean>(count).fill(false);
  // Every rank below the cursor has been emitted.
  let cursor = 0;

  while (order.length < count) {
    if (ready.length === 0) {
      // A stall: only a cycle, or rows below one, remain. Release the
      // smallest-ranked of them.
      while (emitted[cursor] === true) {
        cursor += 1;
      }

      pushRank(ready, cursor);
    }

    const rank = popRank(ready);

    // Each row enters the heap at most once — as a root, when its parent is
    // emitted, or when released — so an emitted rank is never popped; the
    // guard keeps that a property of this loop rather than an assumption.
    if (rank === undefined || emitted[rank] === true) {
      continue;
    }

    emitted[rank] = true;
    order.push(rank);

    for (
      let child = firstChild[rank] ?? NO_ROW;
      child !== NO_ROW;
      child = nextSibling[child] ?? NO_ROW
    ) {
      if (emitted[child] !== true) {
        pushRank(ready, child);
      }
    }
  }

  return order;
}

/**
 * How a page of telemetry rows, or of occurrence groups, may be ordered.
 *
 * **Exactly** `DataQuerySort` from `@debuggen/panel-schema`, not a subset of
 * it: `../panels/data.ts` forwards a panel node's `sort` field unchanged, and
 * the three ordering tables below — canonical rows, panel-data rows and
 * groups — are typed `Record<TelemetrySort, …>`, so a member added to that
 * vocabulary fails this module's compilation until every table says what it
 * means.
 */
export type TelemetrySort = DataQuerySort;

/**
 * The sort values {@link TelemetryQuery.sort} and
 * {@link TelemetryGroupQuery.sort} accept — the panel-data vocabulary itself,
 * re-exported rather than restated, for the message of a refusal and for a
 * suite that wants to exercise each one.
 */
export const TELEMETRY_SORTS: readonly TelemetrySort[] = DATA_QUERY_SORTS;

/* -------------------------------------------------------------------------------------------------
 * Grouping
 * ---------------------------------------------------------------------------------------------- */

/**
 * The keys an occurrence count may group rows by — a **closed** vocabulary.
 *
 * `count_desc` means "largest group first", so answering it needs a group, and
 * the group is always one of these: the operation `name`, the span `kind`, the
 * `traceId` of an interaction, the service-assigned `requestKey` that makes
 * byte-identical requests collide (AAP 0.5.2), and the `component` a render
 * names. Each maps to a SQL expression fixed in {@link GROUP_KEY_SQL}; a
 * caller picks a member and never supplies text, so no statement below ever
 * contains a caller's value.
 */
export const TELEMETRY_GROUP_KEYS = Object.freeze([
  'name',
  'kind',
  'traceId',
  'requestKey',
  'component',
] as const);

/** One member of {@link TELEMETRY_GROUP_KEYS}. */
export type TelemetryGroupKey = (typeof TELEMETRY_GROUP_KEYS)[number];

/**
 * The group a `count_desc` row page ranks by when the caller names none:
 * `name`.
 *
 * The operation name is the one key every row carries (the column is
 * `NOT NULL`), so the default puts no row in the ungrouped tail, and "the
 * operations that happened most often, first" is what largest-group-first
 * means for a flat list of spans or events.
 */
export const TELEMETRY_DEFAULT_GROUP_KEY: TelemetryGroupKey = 'name';

/**
 * The component attribute as SQL, `NULL` for a document that is not valid JSON.
 *
 * Every JSON function below is reached only through this guard. SQLite's JSON
 * functions raise `malformed JSON` on an unparseable document rather than
 * answering `NULL`, so one poisoned row would otherwise fail a whole filtered
 * or grouped read — the opposite of this module's rule that an unreadable row
 * is skipped and counted, never allowed to blank out a panel. The nested
 * `CASE` is what guarantees the order: its branch is evaluated only after
 * `json_valid` has answered.
 */
const COMPONENT_VALUE_SQL = `CASE WHEN json_valid(event) THEN json_extract(event, '${COMPONENT_JSON_PATH}') END`;

/**
 * The component group expression: the `component` attribute when it is a JSON
 * string, and `NULL` otherwise — including for a document that is not valid
 * JSON (see {@link COMPONENT_VALUE_SQL}).
 *
 * The attribute bag is open (`z.record(z.string(), z.unknown())`), so a
 * producer may put a number or an object under the key; typing the
 * expression to text is what keeps a group key a string and keeps such a row
 * out of every component group rather than grouping it under a stringified
 * value the filter could never match.
 */
const COMPONENT_GROUP_SQL = `CASE WHEN json_valid(event) THEN CASE WHEN json_type(event, '${COMPONENT_JSON_PATH}') = 'text' THEN json_extract(event, '${COMPONENT_JSON_PATH}') END END`;

/**
 * The SQL expression each group key evaluates to, per row.
 *
 * `NULL` means "belongs to no group": `request_key` is `NULL` for an event
 * that is not a request, and {@link COMPONENT_GROUP_SQL} is `NULL` for an
 * event that names no component. Every expression is a module constant.
 */
const GROUP_KEY_SQL: Readonly<Record<TelemetryGroupKey, string>> = Object.freeze({
  name: 'name',
  kind: 'kind',
  traceId: 'trace_id',
  requestKey: 'request_key',
  component: COMPONENT_GROUP_SQL,
});

/** Widened view of {@link TELEMETRY_GROUP_KEYS}, for {@link isTelemetryGroupKey}. */
const TELEMETRY_GROUP_KEY_VALUES: readonly string[] = TELEMETRY_GROUP_KEYS;

/**
 * Narrows an untrusted value to a {@link TelemetryGroupKey} by membership.
 *
 * Membership in the tuple rather than `key in GROUP_KEY_SQL`, which would
 * also accept `constructor` and every other name on `Object.prototype`.
 *
 * @param value The value to test.
 * @returns Whether it is a group key.
 */
export function isTelemetryGroupKey(value: unknown): value is TelemetryGroupKey {
  return typeof value === 'string' && TELEMETRY_GROUP_KEY_VALUES.includes(value);
}

/**
 * The `count_desc` row ordering for one group key: rows of the most frequent
 * group first, a group's rows kept together, and each group's rows in the
 * order `withinGroup` gives.
 *
 * `COUNT(key) OVER (PARTITION BY key)` is the occurrence count of the row's own
 * group, evaluated over exactly the filtered stored rows — the same set, and
 * the same basis, `total` counts: a row the page then skips as unreadable was
 * still ranked, exactly as it is still counted in `total`, and the page reports
 * it in {@link TelemetryPage.skipped}. A document that is not valid JSON has no
 * component, so under that key it ranks with the rows that belong to no group.
 * `COUNT(key)` rather than `COUNT(*)` counts only non-`NULL` keys, so a
 * row that belongs to no group ranks with a count of zero: after every group.
 * The key itself separates two groups of equal size, and `withinGroup` orders
 * rows inside a group — and the ungrouped tail — and makes the whole order
 * total, which is what keeps a multi-page walk from repeating or skipping a
 * row. Both values it is given end in a unique column.
 *
 * @param groupBy The group key.
 * @param withinGroup The total order inside a group: {@link CANONICAL_ORDER_BY}
 * for the convenience readers, {@link PANEL_SECONDARY_ORDER_BY} for
 * {@link TelemetryRepo.query}.
 * @returns The `ORDER BY` clause.
 */
function countDescOrderBy(groupBy: TelemetryGroupKey, withinGroup: string): string {
  const key = GROUP_KEY_SQL[groupBy];

  return `COUNT(${key}) OVER (PARTITION BY ${key}) DESC, ${key} ASC, ${withinGroup}`;
}

/**
 * A row-ordering table: the `ORDER BY` clause each sort a caller may ask for
 * maps to, given the effective group key — one entry per `DataQuerySort`
 * member, enforced by the type.
 *
 * In both tables `count_desc` is **not** an alias for another sort: it ranks
 * each row by the occurrence count of the group it belongs to under
 * {@link TelemetryQuery.groupBy} (see {@link countDescOrderBy}), which is what
 * "largest group first" means for a list of rows. A page of the groups
 * themselves — one entry per group, with its count — is
 * {@link TelemetryRepo.queryGroups}.
 */
type RowOrderings = Readonly<Record<TelemetrySort, (groupBy: TelemetryGroupKey) => string>>;

/**
 * The canonical row orderings, which every convenience reader pages in.
 *
 * `start_asc` is the canonical chain, `duration_desc` puts the chain behind
 * `duration DESC`, and `count_desc` orders each group's rows by it. This is
 * the table behind {@link TelemetryRepo.listByTrace}, whose `start_asc` pages
 * `../telemetry/correlate.ts` walks, so its clauses change only together with
 * `compareEventsCanonical`.
 */
const CANONICAL_ORDERING_BY_SORT: RowOrderings = Object.freeze({
  start_asc: () => CANONICAL_ORDER_BY,
  duration_desc: () => DURATION_DESC_ORDER_BY,
  count_desc: (groupBy: TelemetryGroupKey) => countDescOrderBy(groupBy, CANONICAL_ORDER_BY),
});

/**
 * The panel-data row orderings, which {@link TelemetryRepo.query} pages in:
 * the key each sort names, then the event id (AAP 0.4.2).
 *
 * `start_asc` is {@link PANEL_START_ASC_ORDER_BY}, `duration_desc` is
 * {@link PANEL_DURATION_DESC_ORDER_BY}, and `count_desc` orders each group's
 * rows, and the ungrouped tail, by {@link PANEL_SECONDARY_ORDER_BY}.
 */
const PANEL_ORDERING_BY_SORT: RowOrderings = Object.freeze({
  start_asc: () => PANEL_START_ASC_ORDER_BY,
  duration_desc: () => PANEL_DURATION_DESC_ORDER_BY,
  count_desc: (groupBy: TelemetryGroupKey) => countDescOrderBy(groupBy, PANEL_SECONDARY_ORDER_BY),
});

/**
 * Compares two group keys the way SQLite's default `BINARY` collation does: by
 * their UTF-8 bytes.
 *
 * JavaScript's `<` compares UTF-16 code units, which disagrees with byte order
 * for a character above U+FFFF against one in U+E000–U+FFFF; comparing the
 * encoded bytes keeps the group order identical to the `key ASC` tie-break of
 * the row ordering in {@link countDescOrderBy}, so a group and its rows page in
 * the same order on both surfaces.
 *
 * @param left One key.
 * @param right The other.
 * @returns Negative, zero or positive, as for `Array.prototype.sort`.
 */
function compareKeysBinary(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * The tie-break every group ordering ends in: the group key, which is unique
 * per group, then the id of the group's first event.
 *
 * The key alone already makes the order total — one group per distinct key —
 * and the event id states a second, always-distinct key explicitly: every row
 * belongs to one group under a key, so two groups never share a first event,
 * and the order stays total even if a future key were to compare two distinct
 * values as equal. It is the event id rather than the arrival number because a
 * page of groups is panel data, whose stable secondary key AAP 0.4.2 fixes as
 * the `id` (see {@link PANEL_SECONDARY_ORDER_BY}); both are compared as
 * SQLite's `BINARY` collation would.
 *
 * @param left One group.
 * @param right The other.
 * @returns Negative, zero or positive, as for `Array.prototype.sort`.
 */
function groupTieBreak(left: TelemetryGroup, right: TelemetryGroup): number {
  return (
    compareKeysBinary(left.key, right.key) ||
    compareKeysBinary(left.firstEventId, right.firstEventId)
  );
}

/**
 * The group orderings, one comparator per `DataQuerySort` member, enforced by
 * the type.
 *
 * - `count_desc` — most occurrences first. The ordering the grouped panel
 *   sources open with, and the reason this read exists.
 * - `duration_desc` — most total time first, the group-level reading of
 *   "longest first", matching `totalDurationMs` in
 *   `packages/telemetry/src/aggregate/*`.
 * - `start_asc` — the group whose earliest occurrence started first.
 */
const GROUP_ORDERING_BY_SORT: Readonly<
  Record<TelemetrySort, (left: TelemetryGroup, right: TelemetryGroup) => number>
> = Object.freeze({
  count_desc: (left, right) => right.count - left.count || groupTieBreak(left, right),
  duration_desc: (left, right) =>
    right.totalDuration - left.totalDuration || groupTieBreak(left, right),
  start_asc: (left, right) =>
    left.firstStartTime - right.firstStartTime || groupTieBreak(left, right),
});

/* -------------------------------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------------------------------- */

/**
 * The page size an omitted {@link TelemetryQuery.limit} means: **200** rows.
 *
 * Taken from `@debuggen/panel-schema`'s `DATA_QUERY_DEFAULT_LIMIT` rather than
 * written as a literal, because AAP 0.4.2 fixes one default for the panel-data
 * surface and this repository is what serves it: a second literal here could
 * drift from the value the request schema validates against and the response
 * echoes, and the drift would show up as a panel that pages incorrectly rather
 * than as a failure.
 */
export const TELEMETRY_QUERY_DEFAULT_LIMIT = DATA_QUERY_DEFAULT_LIMIT;

/**
 * The largest page this repository will return: **5 000** rows.
 *
 * A request for more is **clamped**, not refused — a caller asking for
 * everything gets the ceiling and the `total` that tells them more remains —
 * and the value comes from `DATA_QUERY_MAX_LIMIT` for the reason
 * {@link TELEMETRY_QUERY_DEFAULT_LIMIT} explains.
 */
export const TELEMETRY_QUERY_MAX_LIMIT = DATA_QUERY_MAX_LIMIT;

/** The offset an omitted {@link TelemetryQuery.offset} means. */
export const TELEMETRY_QUERY_DEFAULT_OFFSET = 0;

/**
 * How many ids one existence-lookup statement binds: **500**.
 *
 * SQLite's compiled parameter ceiling is far higher (32 766 on the bundled
 * build), so this is a deliberate bound rather than the limit: a panel
 * specification citing thousands of events is answered by several small
 * statements instead of one enormous one, which keeps each statement inside
 * every SQLite build this service might ever open a file with and keeps the
 * prepared-statement cache holding one entry for the full-width chunk.
 */
export const EXISTENCE_LOOKUP_CHUNK_SIZE = 500;

/**
 * How many rows one purge statement deletes before it commits and the loop
 * takes the write lock again: **5 000**.
 *
 * A retention sweep can face a session with hundreds of thousands of events. A
 * single `DELETE` would hold the write lock for the whole traversal, and an
 * ingest batch arriving in that window would spend its `busy_timeout` waiting
 * and then fail — losing evidence from a capture in flight to reclaim space
 * from one that ended. Bounded batches inside short transactions turn that into
 * a brief wait instead.
 *
 * The wait is one batch for a writer in **this** process too, not only for
 * another connection: `node:sqlite` is synchronous, so the purge yields to the
 * event loop between batches (see {@link TelemetryRepo.deleteOlderThan}), and
 * an ingest request that arrived during a batch is served before the next one
 * starts.
 */
export const DEFAULT_PURGE_BATCH_SIZE = 5000;

/**
 * The largest batch a purge will run: **5 000** rows, the default itself.
 *
 * `batchSize` is a tuning knob, and what it tunes is how long one batch holds
 * the write lock and the event loop. The default is already the largest hold
 * this service accepts, so a caller may ask for smaller batches but not for
 * larger ones. A larger request is **clamped**, not refused — the same policy
 * as {@link TELEMETRY_QUERY_MAX_LIMIT} — because the sweep still has a correct
 * answer to give: it deletes everything it was asked to, in batches of this
 * size.
 */
export const MAX_PURGE_BATCH_SIZE = DEFAULT_PURGE_BATCH_SIZE;

/**
 * How many captures the producer-loss ledger remembers at once: **512**
 * (see {@link TelemetryRepo.beginProducerLossAccounting} and
 * {@link TelemetryRepo.recordProducerLoss}).
 *
 * The ledger is the service's in-process tally of events a producer reported
 * discarding before delivery — the page agent's 5 000-event buffer
 * overflowing while its bridge was away (AAP §0.5.5). It lives in memory
 * rather than in a table because the durable record of a loss is the capture
 * summary's `coverage.producerDroppedEvents`, which the capture stage writes
 * when it closes the window, and the store has no in-place capture update to
 * accumulate into.
 *
 * Being in memory, it can only vouch for what it saw, so it says when it
 * cannot: a capture is **accounted** only while the entry the capture stage
 * began when it opened the window is still held. A service restart before the
 * stop, or the eviction of that entry, leaves the capture unaccounted, and its
 * coverage is then never reported complete.
 *
 * The capture stage releases an entry when it closes the window, so the
 * entries held are the open captures — one per project at most — plus the
 * loss reports that named a capture with no begun entry, and the begun entries
 * of windows the session manager closed on another path (the session ended,
 * was cancelled or failed mid-capture), which nothing reads again. When the
 * bound is passed, the least recently touched of the unbegun entries is
 * forgotten first, and the least recently touched begun entry only once no
 * unbegun entry is left — a capture that then reads as unaccounted, which is
 * the truthful answer for one the ledger can no longer vouch for.
 */
export const PRODUCER_LOSS_LEDGER_CAPACITY = 512;

/**
 * How many captures the ingest arrival tracker behind
 * {@link TelemetryRepo.captureWatermark} remembers at once: **512**.
 *
 * The capture stage's stop barrier (AAP §0.5.5) reads a capture's watermark
 * every hundred milliseconds on the service's one event loop, so the read is
 * an in-memory lookup rather than a `COUNT(*)` over every row the capture
 * holds — a cost that would grow with the very captures the barrier waits
 * longest on. `insertMany` advances the tracker after its transaction commits.
 *
 * The entries held are the captures ingest has written to since they were
 * last released: the capture stage releases one when it closes the window
 * (through {@link TelemetryRepo.releaseProducerLoss}), so the open captures
 * dominate. Past the bound, the capture written to least recently is
 * forgotten. Forgetting is safe for what the tracker is for — change
 * detection: an arrival always carries an `ingest_seq` above every earlier
 * one, so a forgotten capture that receives another batch still reads as
 * moved, and one that receives none reads as standing still.
 */
export const CAPTURE_ARRIVAL_TRACKER_CAPACITY = 512;

/**
 * The most producers {@link TelemetryRepo.listProducerClockOffsets} reports for
 * one call: **1 000**.
 *
 * A producer is one page document or one dev-server process within one
 * capture, so a session normally has a handful — one per page load and one per
 * server restart while a capture runs. The bound keeps a pathological session
 * (a page reloading in a loop through a long capture) from turning a diagnostic
 * read into an unbounded result. The earliest-reporting producers are kept, the
 * rest are left out and the truncation is reported at `warn`.
 */
export const MAX_PRODUCER_CLOCK_OFFSETS = 1_000;

/* -------------------------------------------------------------------------------------------------
 * Statement text
 *
 * Every string below is assembled from column names, placeholder counts and the
 * module's ordering and grouping constants — never from a value. That is the
 * injection defence and the privacy guarantee at once: `Store.statement` caches
 * on the text, so a text containing a value would both leak it into the cache
 * and defeat the cache, and no parameter can reach SQLite except through a
 * binding.
 * ---------------------------------------------------------------------------------------------- */

/** The table this repository owns, named once. */
const TABLE = 'telemetry_events';

/**
 * The columns {@link TelemetryRepo.insertMany} writes, in bind order.
 *
 * `ingest_seq` is absent because the database assigns it. The flat columns are
 * projections of the `event` document kept in step with it on the one write
 * path, so a filter or an ordering never has to walk JSON. `clock_offset_ms`
 * exists from schema version 5, which every store this build opens is at.
 */
const INSERT_COLUMNS: readonly string[] = Object.freeze([
  'id',
  'session_id',
  'capture_id',
  'trace_id',
  'span_id',
  'parent_span_id',
  'kind',
  'tier',
  'name',
  'start_time',
  'duration',
  'producer_id',
  'seq',
  'clock_offset_ms',
  'request_key',
  'event',
]);

/**
 * `?` placeholders, joined.
 *
 * Only ever called with a **count**, never with a value — see the section note
 * above.
 *
 * @param count How many placeholders to emit.
 * @returns The joined placeholder list, `''` for a count of zero.
 */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Writes one event, skipping a row whose `id` the table already holds, and
 * reports the arrival number either way it can.
 *
 * `ON CONFLICT(id) DO NOTHING` is required rather than convenient: the browser
 * agent buffers up to 5 000 events while its bridge is down and replays them
 * after reconnecting (AAP 0.5.5), so a batch overlapping one already stored is
 * an ordinary event. The conflict target is the `id` UNIQUE constraint the
 * schema declares for exactly this purpose, and skipping leaves the stored
 * row — and its arrival number — untouched.
 *
 * `RETURNING ingest_seq` is how the assigned number comes back. It is read with
 * `StatementSync.get`, which answers `undefined` when the conflict clause
 * suppressed the insert, so "was this row written?" is the same question as "did
 * a row come back?" — measured on Node 24.21.0 / SQLite 3.53.4 rather than
 * assumed. `lastInsertRowid` cannot serve here: it is unchanged by a suppressed
 * insert, so a skipped row would silently inherit the previous row's number.
 */
const INSERT_SQL = `INSERT INTO ${TABLE} (${INSERT_COLUMNS.join(', ')})
VALUES (${placeholders(INSERT_COLUMNS.length)})
ON CONFLICT(id) DO NOTHING
RETURNING ingest_seq`;

/**
 * Reads the complete stored row an insert conflicted with.
 *
 * Keyed on `id` alone — the column the conflict was raised on — rather than on
 * `(id, session_id)`, so the insert path learns *whose* row holds the id instead
 * of only that the caller's session does not. Owning session, arrival number
 * and the authoritative document all come back, because deciding whether the
 * suppressed insert was a genuine replay means comparing the whole stored event
 * with the candidate, and reporting it means returning the stored copy (see
 * {@link TelemetryRepo.insertMany}).
 */
const SELECT_STORED_BY_ID_SQL = `SELECT ingest_seq, session_id, event FROM ${TABLE}
WHERE id = ?`;

/**
 * Reads which session owns one capture: the attribution ownership check of
 * {@link TelemetryRepo.insertMany}.
 *
 * The schema's two foreign keys are independent — `session_id` references
 * `sessions` and `capture_id` references `captures` — so neither of them can
 * refuse an event that names session A and a capture of session B, and such a
 * row would then be deleted by B's capture cascade while A still owned it. This
 * read is what closes that gap, and it runs inside the batch transaction, so
 * the answer and the write it guards are one atomic unit. `captures.id` is the
 * table's primary key, so it is an indexed point read, and the insert path
 * memoises it per batch: a batch almost always names one capture, which makes
 * the check one read per batch rather than one per event.
 */
const SELECT_CAPTURE_OWNER_SQL = `SELECT session_id FROM captures WHERE id = ?`;

/** The two columns every read below needs: the arrival number and the document. */
const SELECTED = 'ingest_seq, event';

/** Distinct trace ids of a session, earliest trace first. */
const SELECT_TRACE_IDS_SQL = `SELECT trace_id, MIN(start_time) AS first_start FROM ${TABLE}
WHERE session_id = ?
GROUP BY trace_id
ORDER BY first_start ASC, trace_id ASC`;

/** {@link SELECT_TRACE_IDS_SQL}, narrowed to one capture. */
const SELECT_TRACE_IDS_BY_CAPTURE_SQL = `SELECT trace_id, MIN(start_time) AS first_start FROM ${TABLE}
WHERE session_id = ? AND capture_id = ?
GROUP BY trace_id
ORDER BY first_start ASC, trace_id ASC`;

/**
 * The order {@link SELECT_FIRST_TRACE_ID_SQL} and its capture form take a
 * scope's events in: `start_time`, then the arrival number that can never tie.
 *
 * `ingest_seq` is the table's `INTEGER PRIMARY KEY` — the rowid alias — which
 * every index carries as its implicit last key, so an index whose trailing
 * columns end in `start_time` delivers exactly this order with no sort:
 * `idx_telemetry_events_session_id_capture_id_start_time` for one capture, and
 * `idx_telemetry_events_session_id_start_time_ingest_seq`, which names the
 * arrival number explicitly, for a whole session. The same key sequence as
 * {@link PURGE_ORDER_BY}, written out so the lookup's order is not coupled to
 * the purge's.
 */
const FIRST_EVENT_ORDER_BY = 'start_time ASC, ingest_seq ASC';

/**
 * The trace of a session's earliest event, in `start_time` then arrival-number
 * order: one ordered index probe that stops at the first entry. Binds the
 * session id.
 *
 * Planned as `SEARCH telemetry_events USING INDEX
 * idx_telemetry_events_session_id_start_time_ingest_seq (session_id=?)` with no
 * temporary B-tree, with or without `ANALYZE` statistics: the probe reads one
 * index entry and one row however many events share the session's earliest
 * instant, so its cost grows with neither the number of traces nor the number
 * of events.
 *
 * The tie rule is arrival order, which is deterministic and total because
 * `ingest_seq` is never reused. It picks the same trace as
 * {@link SELECT_TRACE_IDS_SQL}'s first entry whenever the earliest instant
 * belongs to one trace; the two differ only when several traces share that
 * exact `start_time`, where the listing breaks the tie by trace id and this
 * probe by which of those events arrived first. No row means the session
 * holds no event.
 */
const SELECT_FIRST_TRACE_ID_SQL = `SELECT trace_id FROM ${TABLE}
WHERE session_id = ?
ORDER BY ${FIRST_EVENT_ORDER_BY}
LIMIT 1`;

/**
 * {@link SELECT_FIRST_TRACE_ID_SQL}, narrowed to one capture. Binds the session
 * id, then the capture id.
 *
 * Planned as `SEARCH telemetry_events USING INDEX
 * idx_telemetry_events_session_id_capture_id_start_time (session_id=? AND
 * capture_id=?)` with no temporary B-tree: the index's implicit rowid key
 * orders the capture's entries by `start_time` and then `ingest_seq`, so the
 * first entry of the equality range is the answer. Same tie rule, same cost.
 */
const SELECT_FIRST_TRACE_ID_BY_CAPTURE_SQL = `SELECT trace_id FROM ${TABLE}
WHERE session_id = ? AND capture_id = ?
ORDER BY ${FIRST_EVENT_ORDER_BY}
LIMIT 1`;

/**
 * How many rows one capture holds and the highest arrival number among them:
 * {@link TelemetryRepo.captureStamp}. Binds the session id, then the capture
 * id.
 *
 * `ingest_seq` is the table's `INTEGER PRIMARY KEY`, so every entry of
 * `idx_telemetry_events_session_id_capture_id_start_time` carries it: the count
 * and the maximum are one covering range read of the capture's index entries,
 * with no row fetched and no document parsed. `COALESCE` answers `0` for an
 * empty capture, below every number `AUTOINCREMENT` assigns.
 */
const SELECT_CAPTURE_STAMP_SQL = `SELECT COUNT(*) AS total, COALESCE(MAX(ingest_seq), 0) AS max_seq
FROM ${TABLE}
WHERE session_id = ? AND capture_id = ?`;

/**
 * The connection's data version: {@link TelemetryRepo.captureGeneration}'s
 * witness of every commit made by **another** connection.
 *
 * SQLite changes the value this pragma answers on a connection whenever a
 * different connection — in this process or another — has committed a change
 * to the database since the connection last asked, and leaves it unchanged
 * for the connection's own commits. It reads the database header, never a
 * table, so it costs the same whatever the store holds. The same-connection
 * half of the story is the write ledger ({@link WriteLedger}).
 */
const DATA_VERSION_SQL = 'PRAGMA data_version';

/** How many rows of each kind a session holds. */
const COUNT_BY_KIND_SQL = `SELECT kind, COUNT(*) AS total FROM ${TABLE}
WHERE session_id = ?
GROUP BY kind`;

/** {@link COUNT_BY_KIND_SQL}, narrowed to one capture. */
const COUNT_BY_KIND_BY_CAPTURE_SQL = `SELECT kind, COUNT(*) AS total FROM ${TABLE}
WHERE session_id = ? AND capture_id = ?
GROUP BY kind`;

/** How many rows one session holds, for the retention report. */
const COUNT_BY_SESSION_SQL = `SELECT COUNT(*) AS total FROM ${TABLE} WHERE session_id = ?`;

/**
 * The per-producer clock-offset read of {@link TelemetryRepo.listProducerClockOffsets},
 * over the rows `scope` selects. Binds the scope's values, then the row limit.
 *
 * One row per `(capture_id, producer_id)` among the rows that carry an offset,
 * earliest-reporting producer first. The inner grouped read computes the
 * distinct tiers, the range, the count and the first and last arrival numbers;
 * the join then reads the offset of the group's **last** arrival — the latest
 * estimate that producer reported — back through the primary key. SQLite's
 * bare-column rule for `MAX()` cannot serve instead: it holds only for a query
 * with exactly one `MIN` or `MAX` aggregate, and this one has several.
 *
 * `first_ingest_seq ASC` is a total order, because arrival numbers are unique
 * and no two groups can share a first one, and `ingest_seq` is the table's
 * rowid, so the join is one point read per group.
 *
 * @param scope A fixed `WHERE` term from this module — never a value.
 * @returns The statement text.
 */
function producerClockOffsetsSql(scope: string): string {
  return `SELECT reporting.capture_id, reporting.producer_id, reporting.tiers,
  latest.clock_offset_ms AS clock_offset_ms,
  reporting.min_clock_offset_ms, reporting.max_clock_offset_ms,
  reporting.reporting_events, reporting.first_ingest_seq, reporting.last_ingest_seq
FROM (
  SELECT capture_id, producer_id,
    json_group_array(DISTINCT tier) AS tiers,
    MIN(clock_offset_ms) AS min_clock_offset_ms,
    MAX(clock_offset_ms) AS max_clock_offset_ms,
    COUNT(*) AS reporting_events,
    MIN(ingest_seq) AS first_ingest_seq,
    MAX(ingest_seq) AS last_ingest_seq
  FROM ${TABLE}
  WHERE ${scope} AND clock_offset_ms IS NOT NULL
  GROUP BY capture_id, producer_id
) AS reporting
JOIN ${TABLE} AS latest ON latest.ingest_seq = reporting.last_ingest_seq
ORDER BY reporting.first_ingest_seq ASC
LIMIT ?`;
}

/** {@link producerClockOffsetsSql} over one session. Binds the session id, then the limit. */
const SELECT_PRODUCER_CLOCK_OFFSETS_SQL = producerClockOffsetsSql('session_id = ?');

/**
 * {@link producerClockOffsetsSql} over one capture of one session. Binds the
 * session id, the capture id, then the limit.
 */
const SELECT_PRODUCER_CLOCK_OFFSETS_BY_CAPTURE_SQL = producerClockOffsetsSql(
  'session_id = ? AND capture_id = ?',
);

/**
 * The order every purge batch is taken in: `start_time`, then the arrival
 * number that can never tie.
 *
 * It is the trailing key sequence of both schema-version-2 purge indexes —
 * `idx_telemetry_events_start_time_ingest_seq (start_time, ingest_seq)` and
 * `idx_telemetry_events_session_id_start_time_ingest_seq (session_id,
 * start_time, ingest_seq)`, added by `./migrations.ts` — so each batch's
 * subquery is an ordered **covering** index range read that stops after
 * `LIMIT` entries: no table scan, and no temporary B-tree to sort the whole
 * predicate before the first row can be returned. `ingest_seq` closes the key
 * so a batch boundary between two rows of equal `start_time` is deterministic.
 */
const PURGE_ORDER_BY = 'start_time, ingest_seq';

/**
 * Deletes one bounded batch of a session's rows. Binds the session id, then
 * the batch size.
 *
 * The subquery form is used rather than `DELETE … LIMIT`, which needs a
 * compile-time SQLite option (`SQLITE_ENABLE_UPDATE_DELETE_LIMIT`) this service
 * cannot assume of the runtime's bundled build; the outer `DELETE` then reaches
 * each chosen row through the primary key. Read from
 * `idx_telemetry_events_session_id_start_time_ingest_seq` (see
 * {@link PURGE_ORDER_BY}).
 *
 * Exported, like the other two purge statements, so the suite explains the
 * exact text the purge runs rather than a copy of it.
 */
export const DELETE_SESSION_BATCH_SQL = `DELETE FROM ${TABLE}
WHERE ingest_seq IN (
  SELECT ingest_seq FROM ${TABLE} WHERE session_id = ? ORDER BY ${PURGE_ORDER_BY} LIMIT ?
)`;

/**
 * Deletes one bounded batch of rows, of every session, older than a cutoff.
 * Binds the cutoff, then the batch size.
 *
 * Read from `idx_telemetry_events_start_time_ingest_seq` as a range ending at
 * the cutoff. See {@link DELETE_SESSION_BATCH_SQL}.
 */
export const DELETE_OLDER_THAN_BATCH_SQL = `DELETE FROM ${TABLE}
WHERE ingest_seq IN (
  SELECT ingest_seq FROM ${TABLE} WHERE start_time < ? ORDER BY ${PURGE_ORDER_BY} LIMIT ?
)`;

/**
 * Deletes one bounded batch of **one** session's rows older than a cutoff.
 * Binds the session id, the cutoff, then the batch size.
 *
 * One session per statement, not an `IN` list of them: an index range over
 * `(session_id, start_time, ingest_seq)` is only ordered by `start_time` within
 * one `session_id`, so a list of sessions would force a temporary B-tree to
 * merge the ranges before `LIMIT` could apply. The session-restricted purge
 * therefore walks its sessions one at a time, each through the same prepared
 * statement.
 */
export const DELETE_SESSION_OLDER_THAN_BATCH_SQL = `DELETE FROM ${TABLE}
WHERE ingest_seq IN (
  SELECT ingest_seq FROM ${TABLE}
  WHERE session_id = ? AND start_time < ?
  ORDER BY ${PURGE_ORDER_BY} LIMIT ?
)`;

/**
 * The session scope of a read that may be planned on a session-leading index.
 *
 * The default first term of every filtered read. It leaves the planner free to
 * choose any index whose first column is `session_id` — the capture page, the
 * version-3 kind and request-group composites, the purge index — which is the
 * right access path whenever nothing more selective than the session is named.
 */
const SESSION_TERM = 'session_id = ?';

/**
 * The session scope of a read keyed on an id that is selective across the whole
 * table: the same bound session id in the same position, applied to the rows
 * the read returns rather than used to find them.
 *
 * The unary `+` is SQLite's documented way to disqualify a `WHERE` term from
 * driving an index (Query Planner Checklist, "Disqualifying WHERE Clause Terms
 * using Unary-+"); the term still filters, so the result set is unchanged. It
 * is needed because the store never runs `ANALYZE`: under the planner's default
 * estimates a session-leading index that also satisfies the leading
 * `start_time` term of the ordering outranks a single-column index on the id,
 * and the read then walks every row of the session. Without the session term
 * as a candidate, a span, parent-span or trace lookup is answered from
 * `idx_telemetry_events_span_id`, `idx_telemetry_events_parent_span_id` or
 * `idx_telemetry_events_trace_id_start_time`, and an event-id lookup from
 * `sqlite_autoindex_telemetry_events_1` (the index behind `id`'s `UNIQUE`
 * constraint) — each a handful of rows. `./migrations.ts` explains why those
 * ids get no session-leading composite instead.
 */
const RESIDUAL_SESSION_TERM = '+session_id = ?';

/**
 * The capture narrowing of a read that may be planned on the capture index.
 *
 * The default form of the term, which lets
 * `idx_telemetry_events_session_id_capture_id_start_time` serve a capture's
 * page — the default page of the event log and of every panel source.
 */
const CAPTURE_TERM = 'capture_id = ?';

/**
 * The capture narrowing of a read keyed on a request group: the same bound
 * capture id in the same position, applied to the group's rows rather than used
 * to find them.
 *
 * A request group holds the occurrences of one request, so it is far narrower
 * than a capture. Both `(session_id, capture_id, start_time)` and the version-3
 * request-group composite are matched by two equalities and both yield the
 * leading `start_time` term of the panel-data order, which leaves the planner a
 * tie it breaks towards the capture index, walking the whole capture. Written
 * with the unary `+` (see {@link RESIDUAL_SESSION_TERM}), the capture term can no
 * longer drive that index, and the group is read from
 * `idx_telemetry_events_session_id_request_key_start_time_producer_id_seq`
 * under every ordering. The term still filters, so the result set is unchanged.
 */
const RESIDUAL_CAPTURE_TERM = '+capture_id = ?';

/**
 * One page of a capture window's rows for its summary, in canonical order:
 * {@link TelemetryRepo.pageCaptureForSummary}. Binds the session id, the
 * capture id, the page size and the offset.
 *
 * Served from `idx_telemetry_events_session_id_capture_id_start_time`, the
 * capture page's own index, like `listByCapture`'s rows — but without the
 * `COUNT(*)` a row page runs beside its rows: the summary walk pages a capture
 * in small steps, and a count over the whole window on every step would cost
 * more than the step itself on a large capture.
 */
const SELECT_CAPTURE_SUMMARY_PAGE_SQL = `SELECT ${SELECTED} FROM ${TABLE}
WHERE ${SESSION_TERM} AND ${CAPTURE_TERM}
ORDER BY ${CANONICAL_ORDER_BY} LIMIT ? OFFSET ?`;

/**
 * Selects the subset of a column's values that a session holds.
 *
 * Used for both existence lookups, so the two cannot drift on scoping or on
 * chunking. `DISTINCT` matters: one id may match many rows for `trace_id`, and
 * the caller wants the set, not the multiplicity.
 *
 * Both columns are globally indexed, so the session term is always the
 * residual {@link RESIDUAL_SESSION_TERM}, and a capture narrowing is a plain
 * residual too: no index leads with `capture_id`. An `id` lookup is therefore
 * read from `sqlite_autoindex_telemetry_events_1` and a `trace_id` lookup from
 * `idx_telemetry_events_trace_id_start_time`, one index probe per listed value.
 *
 * @param column `'id'` or `'trace_id'` — an identifier from this module, never
 * caller input.
 * @param slots How many values the `IN` list binds.
 * @param byCapture Whether the lookup is narrowed to one capture.
 * @returns The statement text for that shape.
 */
function existenceSql(column: string, slots: number, byCapture: boolean): string {
  const capture = byCapture ? ' AND capture_id = ?' : '';

  return `SELECT DISTINCT ${column} FROM ${TABLE}
WHERE ${RESIDUAL_SESSION_TERM}${capture} AND ${column} IN (${placeholders(slots)})`;
}

/**
 * Selects every filtered row that belongs to a group under one key, with its
 * key, in arrival order.
 *
 * The rows are reconstructed and validated before they are counted — see
 * {@link TelemetryRepo.queryGroups} — so the statement returns the document
 * rather than aggregating in SQL: SQLite cannot tell a stored row that no
 * longer matches the event schema from one that does, and a group count or a
 * representative event taken from such a row would cite evidence no read can
 * show. Arrival order makes the first row seen for a key its smallest
 * `ingest_seq`, which is the group's representative when it is readable.
 *
 * @param groupBy The group key — a vocabulary member, never caller text.
 * @param clause The `WHERE` clause from the filter planner: column names and
 * placeholders only.
 * @returns The statement text; binds the filter values only.
 */
function groupRowsSql(groupBy: TelemetryGroupKey, clause: string): string {
  const key = GROUP_KEY_SQL[groupBy];

  return `SELECT ${SELECTED}, ${key} AS group_key FROM ${TABLE}
WHERE ${clause} AND ${key} IS NOT NULL
ORDER BY ingest_seq ASC`;
}

/**
 * Counts every row a filtered read selects.
 *
 * The one count text both {@link TelemetryRepo.query} (for a page's `total`)
 * and {@link TelemetryRepo.scanEvents} (for its limit check) run, so the two
 * describe one filter by construction and share one cached statement per
 * clause.
 *
 * @param clause The `WHERE` clause from the filter planner: column names and
 * placeholders only.
 * @returns The statement text; binds the filter values only.
 */
function countRowsSql(clause: string): string {
  return `SELECT COUNT(*) AS total FROM ${TABLE} WHERE ${clause}`;
}

/**
 * Reads every row a filtered read selects in the panel-data `start_asc` order,
 * {@link PANEL_START_ASC_ORDER_BY}: the one ordered statement of
 * {@link TelemetryRepo.scanEvents}.
 *
 * No `OFFSET`: the scan is one traversal, bounded by a `LIMIT` one row past the
 * caller's ceiling, so a selection that grew past that ceiling after it was
 * counted is noticed rather than cut short silently.
 *
 * @param clause The `WHERE` clause from the filter planner: column names and
 * placeholders only.
 * @returns The statement text; binds the filter values, then the row bound.
 */
function scanRowsSql(clause: string): string {
  return `SELECT ${SELECTED} FROM ${TABLE} WHERE ${clause}
ORDER BY ${PANEL_START_ASC_ORDER_BY} LIMIT ?`;
}

/**
 * Reads the lineage key of every row a filtered read selects, in the flat
 * canonical order ({@link CANONICAL_ORDER_BY}): the first of the two
 * statements of a parent-first page ({@link TelemetryQuery.parentFirst}).
 *
 * Flat columns only — the arrival number, the trace, the span and its parent —
 * and never the `event` document, so ordering the whole selection costs no
 * JSON parse and no validation: only the rows of the requested page are
 * reconstructed, by {@link rowsByIngestSeqSql}. The rank is the row's position
 * in this read, which is why the ordering columns themselves are not selected.
 *
 * @param clause The `WHERE` clause from the filter planner: column names and
 * placeholders only.
 * @returns The statement text; binds the filter values only.
 */
function lineageKeysSql(clause: string): string {
  return `SELECT ingest_seq, trace_id, span_id, parent_span_id FROM ${TABLE} WHERE ${clause}
ORDER BY ${CANONICAL_ORDER_BY}`;
}

/**
 * Reads the rows of one parent-first page by arrival number: the second of its
 * two statements. Binds the session id, then the arrival numbers.
 *
 * `ingest_seq` is the table's `INTEGER PRIMARY KEY`, so each listed value is
 * one rowid probe. The session term is the residual
 * {@link RESIDUAL_SESSION_TERM}: every number came from a read scoped to that
 * session, and `AUTOINCREMENT` never hands a number to a second row, so the
 * term changes no answer — it keeps "this read cannot return another
 * session's evidence" a property of the statement rather than of its caller.
 * The rows come back in rowid order; the caller restores the page order.
 *
 * @param slots How many arrival numbers the `IN` list binds, at most
 * {@link EXISTENCE_LOOKUP_CHUNK_SIZE}.
 * @returns The statement text for that shape.
 */
function rowsByIngestSeqSql(slots: number): string {
  return `SELECT ${SELECTED} FROM ${TABLE}
WHERE ${RESIDUAL_SESSION_TERM} AND ingest_seq IN (${placeholders(slots)})`;
}

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/**
 * An event ready to be stored: attributed to a session and a capture, but
 * without the arrival number only the database can assign.
 *
 * Derived from {@link TelemetryEvent} rather than declared beside it, so the
 * persisted shape stays defined exactly once, in
 * `packages/telemetry/src/schema/event.ts`. What the omission encodes is the
 * division of labour: `../telemetry/attribute.ts` supplies `sessionId` and
 * `captureId` at ingest — a producer knows neither — and `ingest_seq` is the
 * store's, which is why a caller cannot supply it and why
 * {@link TelemetryRepo.insertMany} hands back events that carry it.
 */
export type PersistableTelemetryEvent = Omit<TelemetryEvent, 'ingestSeq'>;

/** What one {@link TelemetryRepo.insertMany} batch did. */
export interface InsertTelemetryResult {
  /**
   * The batch as the store now holds it, in the order it was offered, each
   * event carrying its `ingestSeq`.
   *
   * Every offered event appears, whether it was written or skipped, so
   * `../telemetry/live-tail.ts` can broadcast persisted objects and
   * `correlate.ts` can use `ingestSeq` as its final ordering tie-break without
   * knowing which rows were replays.
   *
   * A skipped event is **the stored row itself**, reconstructed and validated
   * with its own arrival number — never the caller's candidate. It is only ever
   * skipped after the whole stored event was compared with the candidate and
   * found identical (see {@link TelemetryRepo.insertMany}), so the two agree in
   * every field; returning the stored copy is what makes that agreement a
   * property of the result rather than an assumption about the producer.
   */
  readonly events: TelemetryEvent[];

  /** How many rows were written. */
  readonly inserted: number;

  /** How many rows were already present and were left exactly as they were. */
  readonly skipped: number;
}

/**
 * A narrowed read of the `telemetry_events` table.
 *
 * Every field except `sessionId` is optional and an absent field narrows
 * nothing. The set mirrors the `DataQuery` filter of
 * `@debuggen/panel-schema` — `../panels/data.ts` forwards a panel node's query
 * onto this shape — plus `requestKey`, which the duplicate-request path needs
 * and a panel never names directly.
 */
export interface TelemetryQuery {
  /**
   * The session whose evidence is being read. **Required**: every row belongs
   * to exactly one session, and an unscoped read would let one session's panel
   * cite another's events.
   */
  readonly sessionId: SessionId;

  /** Narrow to one capture window. Absent means every capture of the session. */
  readonly captureId?: CaptureId | undefined;

  /**
   * Narrow to one correlated interaction. Served by
   * `idx_telemetry_events_trace_id_start_time`, with the session scope and
   * every other narrowing applied to the trace's rows as residual filters (see
   * {@link RESIDUAL_SESSION_TERM}), which is what makes the timeline and flame
   * views cheap: the read touches one trace, never the whole session.
   */
  readonly traceId?: string | undefined;

  /**
   * Keep only these span kinds.
   *
   * An **empty** array means no kind was selected and therefore matches
   * nothing, which is answered with an empty page rather than with every row —
   * the opposite reading would turn a caller's narrowed-to-nothing filter into
   * a full scan. Duplicates are harmless; a value outside the vocabulary is
   * refused rather than dropped, because a query that silently ignored part of
   * its filter would answer with more rows than the caller asked for.
   */
  readonly kinds?: readonly TelemetryKind[] | undefined;

  /** Keep only these producer tiers. Empty and unknown values behave as {@link TelemetryQuery.kinds}. */
  readonly tiers?: readonly TelemetryTier[] | undefined;

  /**
   * Keep only events of this one producer tier.
   *
   * Mirrors `DataQuery.filter.tier` of `@debuggen/panel-schema`, which is
   * singular, so a parsed panel filter can be spread onto this shape unchanged
   * and still narrow: were only {@link TelemetryQuery.tiers} accepted, the
   * forwarded `tier` would be an unknown key that narrows nothing, and a
   * database-only panel would be answered with browser and server spans too.
   *
   * Composes with `tiers` by **AND**, like every other field: both present
   * means the event's tier must equal `tier` *and* be listed in `tiers`, so a
   * `tier` outside the list matches nothing. An unknown value is refused with
   * reason `unknown-tier`, as an unknown member of `tiers` is.
   */
  readonly tier?: TelemetryTier | undefined;

  /**
   * Keep only spans lasting at least this many milliseconds.
   *
   * Fractional values are meaningful — durations are doubles — and must be
   * finite and non-negative.
   */
  readonly minDuration?: number | undefined;

  /**
   * Keep only events whose `component` attribute equals this name.
   *
   * The render-oriented filter behind the `renders` and `componentTree` panel
   * sources. It is matched inside the event document with `json_extract` and is
   * therefore **not indexed** — which is why it is always combined with
   * `session_id` (and usually `capture_id`), so the scan is bounded by one
   * capture's rows rather than by the table.
   */
  readonly component?: string | undefined;

  /**
   * Keep only events sharing this request grouping key.
   *
   * The key is the keyed hash computed at ingest, never a URL.
   * {@link TelemetryRepo.listByRequestKey} reads a group's rows from
   * `idx_telemetry_events_session_id_request_key_start_time_producer_id_seq`
   * (schema version 3), which yields its canonical order without a sort, and
   * the group's count from that index or from
   * `idx_telemetry_events_session_id_request_key`, both matched on
   * `(session_id, request_key)`, so duplicate-request grouping is an indexed
   * read.
   */
  readonly requestKey?: string | undefined;

  /**
   * How to order the page. Defaults to `'start_asc'`.
   *
   * Every `DataQuerySort` member is accepted, and what a sort ends in depends
   * on the reader: through {@link TelemetryRepo.query}, the panel-data surface,
   * each sort's key is followed by the event id
   * ({@link PANEL_SECONDARY_ORDER_BY}) — or, for `'start_asc'` with
   * {@link TelemetryQuery.parentFirst}, the whole canonical parent-first
   * order replaces the flat one; through a convenience reader, which
   * takes this field by way of {@link TelemetryReadOptions}, it is followed by
   * the canonical chain ({@link CANONICAL_ORDER_BY}). `'count_desc'` ranks rows
   * by the size of the group each belongs to under
   * {@link TelemetryQuery.groupBy}, and a page of the groups themselves is
   * {@link TelemetryRepo.queryGroups}.
   */
  readonly sort?: TelemetrySort | undefined;

  /**
   * Order a `'start_asc'` page in the **canonical** order of AAP 0.2.3 —
   * parent before child, then `startTime`, then `(producerId, seq)`, then
   * `ingestSeq` — instead of the flat `start_time ASC, id ASC`. Defaults to
   * `false`, which leaves every existing ordering exactly as it was.
   *
   * Parent and child are rows of the filtered selection: a row's parent is the
   * selected row of the same trace whose span id is its `parentSpanId` (the
   * lowest-ranked one should the span id repeat), and a row whose parent is
   * not selected is ordered as a root. A parent cycle cannot stall or drop a
   * row: when nothing is ready, the smallest-ranked row left is released as
   * if it were a root, and every row is emitted exactly once. See
   * {@link parentFirstOrder}, which both this read and `../panels/data.ts`
   * order by.
   *
   * The `spans` panel source sets it under `start_asc`, because its rows are
   * the work of correlated traces and a child listed above the request that
   * caused it — a server clock reading earlier than the browser's — would
   * misstate the causality the view exists to show. `total`, `nextOffset`,
   * `skipped`, the default and the ceiling of `limit` keep their meaning: the
   * selection is ordered whole and the page is cut from that order.
   *
   * Refused (`STORE_ERROR`, reason `invalid-parent-first`) when it is not a
   * boolean, and (`parent-first-requires-start-asc`) when `true` under any
   * other sort, which has no parent-first reading.
   */
  readonly parentFirst?: boolean | undefined;

  /**
   * The group `'count_desc'` ranks rows by. Defaults to
   * {@link TELEMETRY_DEFAULT_GROUP_KEY}.
   *
   * It decides ordering only — it never narrows the rows, so `total` is the
   * same whichever key is named — and the other two sorts do not read it. An
   * unknown key is still refused under every sort, because a caller naming one
   * has a bug the ordering would otherwise hide.
   */
  readonly groupBy?: TelemetryGroupKey | undefined;

  /**
   * How many rows to return. Defaults to {@link TELEMETRY_QUERY_DEFAULT_LIMIT}
   * and is clamped to {@link TELEMETRY_QUERY_MAX_LIMIT}.
   *
   * Zero is legal and means "the count, none of the rows": the panel-data
   * request schema accepts it, and it is the cheapest way to ask how large a
   * filtered source is.
   */
  readonly limit?: number | undefined;

  /** How many rows to skip. Defaults to {@link TELEMETRY_QUERY_DEFAULT_OFFSET}. */
  readonly offset?: number | undefined;
}

/**
 * The narrowing a convenience reader accepts: every {@link TelemetryQuery}
 * field except the ones the reader itself fixes — including
 * {@link TelemetryQuery.parentFirst}, because a convenience reader's order is
 * the flat canonical chain the correlator pages through, fixed by the reader.
 *
 * Derived rather than restated so a field added to the filter is available
 * through every reader in the same edit.
 */
export type TelemetryReadOptions = Omit<
  TelemetryQuery,
  'sessionId' | 'traceId' | 'requestKey' | 'parentFirst'
>;

/** One page of telemetry rows, with everything a pager needs to continue. */
export interface TelemetryPage {
  /** The rows of this page, in the requested order. */
  readonly rows: TelemetryEvent[];

  /**
   * How many rows the filter matches in full, before `limit` and `offset`.
   *
   * Counted over the identical `WHERE` clause, so `total` and `rows` can never
   * describe different filters. Zero is an ordinary answer: a capture with no
   * renders reports `total: 0` and the component renders its empty state.
   */
  readonly total: number;

  /**
   * The offset to ask for next, or **absent** when this page is the last one.
   *
   * Computed from what the statement actually returned rather than from the
   * requested limit, so a short final page ends the walk instead of pointing
   * past the end.
   *
   * It advances by the number of **rows read**, which includes any counted by
   * {@link TelemetryPage.skipped} and is therefore not always
   * `offset + rows.length`. That is deliberate: `offset` and `total` are both
   * measured in table rows, so advancing by the events *kept* would leave a
   * paging loop asking for the same offset forever the moment one row stopped
   * validating.
   *
   * **A page that read no row is terminal**, and carries no `nextOffset` even
   * when `offset` is short of `total`. The ordinary way to get such a page with
   * rows still ahead is the count-only request, `limit: 0`: its "next" offset would
   * be the offset it was asked for, and a pager that followed it would request
   * the same empty page forever. Present, therefore, `nextOffset` is always
   * strictly greater than the page's own offset — the property a page walk such
   * as `../telemetry/correlate.ts` relies on to terminate — and a caller that
   * wants rows after a count-only answer asks again with a positive `limit`.
   *
   * `../panels/data.ts` maps the absence onto the `nextOffset: null` that
   * protocol's `DataPage` echo requires, because after a JSON round trip an
   * absent key and "no more pages" would otherwise be indistinguishable.
   */
  readonly nextOffset?: number;

  /**
   * How many stored rows were left out because they no longer validate.
   *
   * Absent when every row read back cleanly, which is the normal case. Present,
   * it means the table holds rows this build cannot reconstruct — a database
   * written by a different build, or an altered file — and the page is the rest
   * of the evidence rather than nothing (AAP 0.5.5). `../panels/data.ts`
   * surfaces it so a panel can say the view is incomplete; the `ingest_seq` of
   * each skipped row is in the service log and nowhere else.
   */
  readonly skipped?: number;
}

/**
 * The narrowing a {@link TelemetryRepo.scanEvents} call accepts: every
 * {@link TelemetryQuery} filter field, and none of the ordering and paging
 * fields — a scan is always the whole selection in one fixed order.
 *
 * Derived rather than restated so a filter field added to the query is
 * scannable in the same edit.
 */
export type TelemetryScanFilter = Omit<
  TelemetryQuery,
  'sort' | 'parentFirst' | 'groupBy' | 'limit' | 'offset'
>;

/** The whole of a filtered selection, or the honest statement that it was too large. */
export interface TelemetryScan {
  /**
   * Every selected event in `start_time ASC, id ASC` order
   * ({@link PANEL_START_ASC_ORDER_BY}); empty when `complete` is false.
   */
  readonly rows: TelemetryEvent[];

  /**
   * How many rows the filter selects.
   *
   * When `complete`, the rows the scan read — `rows.length` plus
   * {@link TelemetryScan.skipped} — so the three always agree. When not, the
   * count that exceeded the ceiling, or, when the selection grew past the
   * ceiling between the count and the read, the rows the read met before it
   * stopped: a lower bound either way, and never a claim of completeness.
   */
  readonly total: number;

  /** True exactly when `rows` holds every selected event, i.e. the selection is within `maxRows`. */
  readonly complete: boolean;

  /**
   * Rows left out because they no longer validate; absent when none, and
   * always absent from an incomplete scan. The same skip-and-report rule as
   * {@link TelemetryPage.skipped}.
   */
  readonly skipped?: number;
}

/**
 * A grouped read: the same narrowing as {@link TelemetryQuery}, over the groups
 * the filtered rows form under one key.
 *
 * `groupBy` is **required** here — a page of groups with no named key has no
 * meaning — and `sort` defaults to `'count_desc'`, the ordering this read
 * exists to answer. `limit` and `offset` count **groups**, with the same
 * default, ceiling and refusals as a row page. {@link TelemetryQuery.parentFirst}
 * orders rows, not groups, so a grouped read does not take it.
 */
export interface TelemetryGroupQuery extends Omit<TelemetryQuery, 'parentFirst'> {
  /** The key the filtered rows are grouped by. */
  readonly groupBy: TelemetryGroupKey;

  /** How to order the groups. Defaults to `'count_desc'`. */
  readonly sort?: TelemetrySort | undefined;
}

/**
 * One group of rows sharing a key value, as {@link TelemetryRepo.queryGroups}
 * reports it.
 *
 * Counts and identifiers rather than an aggregate's full shape: render
 * statistics, request groups with their duplicate counts and the other panel
 * result shapes stay in `packages/telemetry/src/aggregate/*`. What this carries
 * is what a count-ordered, pageable list needs from SQL — the size of the
 * group, the timing it can be ranked by, and a stored event to cite for it.
 */
export interface TelemetryGroup {
  /**
   * The value the group's rows share. Captured data for `name` and
   * `component`, so it is returned to the caller and never logged.
   */
  readonly key: string;

  /**
   * How many readable filtered events the group holds; always at least one. A
   * stored row that no longer reconstructs as an event is not counted — see
   * {@link TelemetryGroupPage.skipped}.
   */
  readonly count: number;

  /**
   * The id of the group's first readable event — the smallest `ingest_seq`
   * among the events counted — so a panel fact about the group cites an event
   * every read of the store can show. Also the final tie-break of every group
   * ordering, after the key.
   */
  readonly firstEventId: string;

  /**
   * That event's arrival number: what chose it as the group's representative.
   * No group ordering reads it — a page of groups ends in the event id, the
   * panel-data secondary key.
   */
  readonly firstIngestSeq: number;

  /** The earliest `startTime` among the group's counted events, unrounded. */
  readonly firstStartTime: number;

  /** The sum of the counted events' durations in milliseconds, unrounded. */
  readonly totalDuration: number;
}

/** One page of groups, with everything a pager needs to continue. */
export interface TelemetryGroupPage {
  /** The groups of this page, in the requested order. */
  readonly groups: TelemetryGroup[];

  /**
   * How many groups the filter forms in full, before `limit` and `offset`.
   * Rows whose key is `NULL` belong to no group and are not counted, and
   * neither is a group whose every row is unreadable.
   */
  readonly total: number;

  /**
   * The offset to ask for next, or **absent** when this page is the last one —
   * the same contract as {@link TelemetryPage.nextOffset}, in groups.
   *
   * That includes the terminal rule: a page that returned no group — the
   * count-only `limit: 0`, or an offset at or past the end — carries no
   * `nextOffset` even when groups remain after its offset, because its "next"
   * offset would be its own. Present, it is always strictly greater than the
   * page's offset.
   */
  readonly nextOffset?: number;

  /**
   * How many filtered rows carrying a key were left out of every group because
   * they no longer reconstruct as an event — the grouped counterpart of
   * {@link TelemetryPage.skipped}, and **absent** when there were none. Each
   * such row is also reported at `warn` by arrival number alone.
   */
  readonly skipped?: number;
}

/** What {@link createTelemetryRepo} is constructed from. */
export interface TelemetryRepoDeps {
  /**
   * The open, migrated store handle from `./db.ts`.
   *
   * The repository owns no connection of its own, which is what puts its
   * statements in the shared prepared-statement cache and its writes inside
   * whatever transaction a caller has already opened — the retention sweep
   * deletes a session and its telemetry in one transaction, and either both go
   * or neither does.
   */
  readonly store: Store;

  /**
   * Where the repository reports batch counts and unreadable rows. Defaults to
   * the shared no-op logger, so a suite that does not care about output passes
   * nothing.
   *
   * A child bound to `{ subsystem: 'store', repo: 'telemetry' }` is derived
   * from it. See this module's privacy note for what is never put on a record.
   */
  readonly logger?: Logger | undefined;
}

/** Narrowing for {@link TelemetryRepo.deleteOlderThan}. */
export interface DeleteOlderThanOptions {
  /**
   * Restrict the purge to these sessions.
   *
   * Absent means every session, which is what the scheduled retention sweep
   * wants. An **empty** array selects no session and deletes nothing, for the
   * same reason an empty `kinds` filter matches nothing: a narrowed-to-nothing
   * selection must not widen into "everything".
   */
  readonly sessionIds?: readonly SessionId[] | undefined;

  /**
   * How many rows one statement deletes before committing. Defaults to
   * {@link DEFAULT_PURGE_BATCH_SIZE}; must be a positive integer, and is
   * clamped to {@link MAX_PURGE_BATCH_SIZE}.
   */
  readonly batchSize?: number | undefined;
}

/**
 * A fingerprint of one capture's stored events: what
 * {@link TelemetryRepo.captureStamp} returns.
 *
 * Two readings of the same capture are equal exactly when the capture holds the
 * same rows at both, and its {@link CaptureEventStamp.count} says how many
 * events those are — which is what a coverage check needs: whether a capture
 * summary, computed when the capture stopped, still describes every event the
 * store holds. It is not what a cache of the capture's aggregates is validated
 * with; reading it counts the capture's index entries on every call, and
 * {@link CaptureGeneration} answers "has anything changed?" without reading a
 * telemetry row. A stamp is a function of the rows, so equal rows give equal
 * stamps; that differing rows always give differing stamps follows from how
 * the table is written:
 *
 * - `ingest_seq` is `AUTOINCREMENT` and never reused, not even after a purge,
 *   so every row inserted into the capture carries a number above every number
 *   the table has ever assigned — an insert that is still stored always raises
 *   {@link CaptureEventStamp.maxIngestSeq};
 * - rows are never updated in place, so the only other change is a delete,
 *   and a delete not offset by an insert always lowers
 *   {@link CaptureEventStamp.count}.
 *
 * A stamp is a fingerprint and not a version number: compare two stamps for
 * equality, never for order.
 */
export interface CaptureEventStamp {
  /** How many events the capture holds, `0` for an empty capture. */
  readonly count: number;

  /**
   * The highest arrival number among the capture's events, `0` for an empty
   * capture — below every number the store assigns.
   */
  readonly maxIngestSeq: number;
}

/**
 * Where one capture's stored events stand, as far as this connection can
 * observe without reading them: what {@link TelemetryRepo.captureGeneration}
 * returns.
 *
 * **Compare two generations for equality only**, never for order: a caller
 * keeps an aggregate computed from a capture's events together with the
 * generation it read *before* reading those events, and reuses the aggregate
 * exactly while a fresh reading is equal to it, field for field.
 *
 * Equality is sound — equal generations mean the capture holds the rows it
 * held — because every way the capture's rows can change moves a field:
 *
 * - **Another connection's commit** — the dev-server's, a second service's, a
 *   manual edit — moves {@link CaptureGeneration.dataVersion}, whatever it
 *   changed.
 * - **This connection's writes to `telemetry_events` all go through this
 *   repository**, and each is recorded in the connection's write ledger, which
 *   every repository over the connection shares: a batch of
 *   {@link TelemetryRepo.insertMany} that stored at least one row of the
 *   capture moves {@link CaptureGeneration.writes}, and a purge batch of
 *   {@link TelemetryRepo.deleteBySession} or {@link TelemetryRepo.deleteOlderThan}
 *   that deleted at least one row, of any capture, moves
 *   {@link CaptureGeneration.purges}.
 * - **The one other same-connection change is a foreign-key cascade**, which
 *   deletes a whole capture's or session's events together with the
 *   `captures` or `sessions` row. The ids those rows carry are minted and never
 *   reused, so the stale generation of a deleted capture can never validate a
 *   read of a live one.
 *
 * An insert made inside a transaction the caller opened is not known to be
 * committed when the batch returns, and a rollback on this connection moves
 * neither `dataVersion` nor the ledger; so such an insert is stamped again the
 * first time a generation is read once no transaction is open, which
 * invalidates anything computed while its outcome was pending.
 */
export interface CaptureGeneration {
  /** `PRAGMA data_version` of the connection: moves when another connection commits. */
  readonly dataVersion: number;

  /** The ledger value of the latest purge batch on this connection that deleted rows, 0 when none. */
  readonly purges: number;

  /** The ledger value of the latest insert of rows into this capture on this connection, 0 when none. */
  readonly writes: number;
}

/**
 * How far ingest has advanced into one capture window (AAP §0.5.5): what
 * {@link TelemetryRepo.captureWatermark} answers and what the capture stage's
 * stop barrier compares between two polls.
 *
 * It counts **arrivals**: the rows `insertMany` committed for the capture
 * through this repository instance since the tracker began holding it
 * ({@link CAPTURE_ARRIVAL_TRACKER_CAPACITY}). It is a change detector, not a
 * measure of what the store holds — a purge does not lower it, and a restarted
 * service starts it at zero — so the summary's `coverage.storedEvents` comes
 * from the stored rows instead. A new row raises both numbers; a replay the
 * store suppressed as an identical event raises neither, because it is not
 * new evidence.
 */
export interface CaptureIngestWatermark {
  /** How many rows this repository committed for the capture while tracking it. */
  readonly eventCount: number;
  /** The highest `ingest_seq` among those rows, or `0` when none arrived. */
  readonly lastIngestSeq: number;
}

/**
 * One producer's report that it discarded events before they could be
 * delivered — the `droppedCount` a page-agent batch carries after its bounded
 * buffer overflowed while the bridge was away (AAP §0.5.5). What
 * {@link TelemetryRepo.recordProducerLoss} accumulates.
 */
export interface ProducerLossReport {
  /** The session the batch was attributed to. */
  readonly sessionId: SessionId;
  /** The capture window the batch was attributed to. */
  readonly captureId: CaptureId;
  /** The reporting producer, when known: an identifier for the log record, never part of the key. */
  readonly producerId?: ProducerId | undefined;
  /** How many events the producer discarded since its previous report: a whole number from `0`. */
  readonly droppedEvents: number;
}

/**
 * What the producer-loss ledger knows about one capture: what
 * {@link TelemetryRepo.producerLoss} answers (AAP §0.5.5).
 */
export interface ProducerLossTotal {
  /**
   * How many events the producers reported discarding for the capture, as
   * this process received the reports — exact when {@link accounted}, and
   * otherwise only a lower bound (`0` included).
   */
  readonly droppedEvents: number;
  /**
   * Whether the ledger has tracked the capture since its window opened in this
   * process and never forgot it — the only case in which
   * {@link droppedEvents} is the whole loss. `false` after a service restart
   * that fell between the window opening and this read, after the capture's
   * entry was evicted or released, and for a capture no window-opening began.
   */
  readonly accounted: boolean;
}

/** Which page {@link TelemetryRepo.pageCaptureForSummary} reads. Both fields are required. */
export interface CaptureSummaryPageOptions {
  /**
   * How many rows to read: a whole number, clamped to
   * {@link TELEMETRY_QUERY_MAX_LIMIT}. `0` reads nothing and is terminal.
   */
  readonly limit: number;
  /** How many rows of the capture, in canonical order, to skip first: a whole number. */
  readonly offset: number;
}

/**
 * One page of a capture window's stored events, read for the capture summary
 * (AAP §0.5.5), with what the capture stage needs to bound the read by size as
 * well as by count.
 *
 * Deliberately its own shape rather than a {@link TelemetryPage} with one more
 * field: a row page is mapped onto a strict panel-data response, and a size
 * the panel surface never shows does not belong on it.
 */
export interface CaptureSummaryPage {
  /** The page's readable events, in canonical order ({@link CANONICAL_ORDER_BY}). */
  readonly rows: TelemetryEvent[];
  /** How many stored rows the page read, readable or not: `rows.length + skipped`. */
  readonly rowsRead: number;
  /** How many of those rows no longer validate and were left out (reported at `warn`). */
  readonly skipped: number;
  /**
   * The stored size of every row read, unreadable ones included: the summed
   * length, in UTF-16 code units, of their JSON `event` documents — the
   * characters the store actually holds for them, measured on the strings the
   * read already returned rather than by a second query.
   */
  readonly storedChars: number;
  /**
   * The offset to ask for next: present whenever the page came back full, and
   * **absent** when it came back short, which is the capture's end. A capture
   * whose last row closes a full page therefore answers one more, empty page,
   * which is terminal. Present, it is always greater than the page's offset.
   */
  readonly nextOffset?: number;
}

/**
 * The clock offsets one producer reported within one capture — the
 * informational per-producer `clockOffsetMs` of AAP 0.2.3, as the store holds
 * it.
 *
 * Every offset is `server clock − producer clock` in whole milliseconds, as the
 * producer's `ClockOffsetEstimator` (`@debuggen/telemetry`) computed it: a
 * positive value means the server's clock is ahead of the producer's. Only the
 * events that carried an offset are summarised; a producer that reported none
 * has no entry.
 */
export interface ProducerClockOffset {
  /** The capture window the producer's events were attributed to. */
  readonly captureId: CaptureId;

  /** The page document or dev-server process that reported the offsets. */
  readonly producerId: ProducerId;

  /**
   * The distinct tiers of the reporting events, in `TELEMETRY_TIERS` order —
   * `browser` for a page agent; `server` and `db` for a preload.
   */
  readonly tiers: readonly TelemetryTier[];

  /**
   * The offset on the producer's latest reporting event (its highest
   * `ingestSeq`): the estimate the producer held most recently, and the one
   * a reader should compare its timestamps by.
   */
  readonly clockOffsetMs: number;

  /** The smallest offset any reporting event carried. */
  readonly minClockOffsetMs: number;

  /**
   * The largest offset any reporting event carried. A spread between this and
   * {@link ProducerClockOffset.minClockOffsetMs} well beyond the header's
   * one-second resolution means the producer's estimate restarted — its clock
   * moved relative to the server's during the capture.
   */
  readonly maxClockOffsetMs: number;

  /** How many stored events of this producer carried an offset. */
  readonly reportingEvents: number;

  /** The arrival number of the first reporting event. */
  readonly firstIngestSeq: number;

  /** The arrival number of the latest reporting event. */
  readonly lastIngestSeq: number;
}

/** Narrowing for {@link TelemetryRepo.listProducerClockOffsets}. */
export interface ProducerClockOffsetOptions {
  /**
   * Restrict the summary to one capture window of the session. Absent means
   * every capture; an empty string is refused, as every blank narrowing is.
   */
  readonly captureId?: CaptureId | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * The repository's contract
 * ---------------------------------------------------------------------------------------------- */

/**
 * The telemetry repository, over the session store.
 *
 * Every method answers with a {@link Result} and **never throws**. Every method
 * but the two purges is synchronous: `node:sqlite` is a synchronous binding and
 * `Store.transaction` commits before it returns, so a successful
 * {@link TelemetryRepo.insertMany} means committed rows. The purges
 * ({@link TelemetryRepo.deleteBySession}, {@link TelemetryRepo.deleteOlderThan})
 * answer with a promise of a `Result` that never rejects, because they yield
 * to the event loop between batches.
 *
 * Nothing is mutated in place. A returned event is reconstructed from its row
 * and validated, so a caller may keep it without ever observing a value the
 * store does not hold.
 */
export interface TelemetryRepo {
  /**
   * Writes a batch of attributed, **already-redacted** events in one
   * transaction, skipping any whose `id` the table already holds **as the
   * identical event**.
   *
   * Refuses the whole batch, without writing anything, when an element does not
   * match the persisted event schema — including a missing `sessionId` or
   * `captureId`, which is not a partially attributed event but one that should
   * never have been ingested (AAP 0.5.1, 0.7.1). The refusal names the field
   * paths that failed and never a value.
   *
   * Refuses the whole batch, too, when an element's `captureId` names a
   * capture that belongs to a **different** session than its `sessionId` —
   * `STORE_ERROR` with reason `capture-session-mismatch`, the element's
   * `index`, and its own `sessionId` and `captureId` (never the capture's
   * owning session). The schema's foreign keys check each id on its own and
   * cannot catch the pair, and a row stored with one would be deleted by the
   * other session's capture cascade. The owner is read inside the same
   * transaction as the writes, before each element is written, so the check
   * and the write are atomic and the refusal rolls back every element written
   * before it. A capture the store does not hold at all is refused by the
   * foreign key as `unknown-attribution`.
   *
   * A conflict on `id` is an idempotent replay only when the stored event and
   * the candidate are the same event. The stored row is read in full, validated
   * and compared canonically with the candidate — key order inside objects is
   * not significant, numbers compare exactly, and an optional field that is
   * absent equals one that is `undefined`, because the stored JSON document
   * cannot tell those apart. An exact replay is skipped and reported as the
   * **stored** event. Anything else rolls the whole batch back — including the
   * rows written earlier in it, and including two differing copies of one id
   * inside the same batch — with `STORE_ERROR` and one of three reasons, beside
   * the `capture-session-mismatch` and `unknown-attribution` refusals above:
   *
   * - `event-id-reused` — the id belongs to another session's row;
   * - `event-id-conflict` — same session, different content; `details.fields`
   *   names the differing top-level fields (never a value);
   * - `stored-event-unreadable` — the stored row no longer reconstructs, so the
   *   replay cannot be confirmed.
   *
   * Once the transaction has returned, the rows it inserted — never the
   * replays it skipped — advance each capture's ingest watermark
   * ({@link TelemetryRepo.captureWatermark}); a refused batch advances none.
   *
   * @param events The batch, in producer order. An empty batch is a successful
   * no-op that does not touch the database.
   * @returns The stored events with their arrival numbers, plus the insert and
   * skip counts, or the refusal.
   */
  insertMany(
    events: readonly PersistableTelemetryEvent[],
  ): Result<InsertTelemetryResult, DebuggenError>;

  /**
   * Reads one page of a session's events — the panel-data surface.
   *
   * Ordered by the panel-data orderings (AAP 0.4.2): the key the sort names,
   * then the event id as the stable secondary key — `start_time ASC, id ASC`
   * under `'start_asc'`, `duration DESC, id ASC` under `'duration_desc'`.
   * Under `'count_desc'` the rows of the largest group under `groupBy` come
   * first, each group's rows together and in ascending id order, groups of
   * equal size in ascending key order, and rows belonging to no group last, in
   * ascending id order too. Every one of these is a total order, so paging is
   * stable under all three. The flat canonical chain the correlator pages
   * through is the convenience readers' ({@link TelemetryRepo.listByTrace}).
   *
   * With {@link TelemetryQuery.parentFirst} under `'start_asc'`, the page is
   * cut from the canonical **parent-first** order of AAP 0.2.3 instead
   * ({@link parentFirstOrder}), in two statements: one read of every selected
   * row's flat lineage key in {@link CANONICAL_ORDER_BY} — no document parsed —
   * whose length is `total`, and one read of the page's own rows by arrival
   * number, at most {@link EXISTENCE_LOOKUP_CHUNK_SIZE} per statement. Only
   * the page's rows are reconstructed and validated. A count-only request
   * (`limit: 0`) is the one `COUNT(*)` every other page runs. `nextOffset`
   * advances by the window the order was cut to, so a row another connection
   * removed between the two statements is neither returned nor able to stall
   * a walk.
   *
   * @param filter What to match, how to order it and which page to return.
   * @returns The page, or the refusal for an argument this repository will not
   * accept (an unknown sort, group key, kind or tier, a negative or fractional
   * `limit` or `offset`, a non-finite `minDuration`, a `parentFirst` that is
   * not a boolean or is `true` under a sort other than `'start_asc'`).
   */
  query(filter: TelemetryQuery): Result<TelemetryPage, DebuggenError>;

  /**
   * Reads the **whole** filtered selection in one traversal, or says it is
   * larger than `maxRows` without reading it — the full-slice read behind the
   * panel-data aggregates.
   *
   * A render, request, query or metric aggregate is only true when it is
   * computed over every selected event, so its input must be either complete
   * or declared incomplete. Walking {@link TelemetryRepo.query} pages for that
   * input costs a `COUNT(*)` per page plus an `OFFSET` that re-walks every
   * earlier row, so the walk grows quadratically with the capture. This runs
   * at most two statements instead:
   *
   * 1. one `COUNT(*)` over the filter's `WHERE` clause — the identical text
   *    `query` counts with — and, when the count exceeds `maxRows`, nothing
   *    else: the answer is `{ rows: [], total: count, complete: false }`;
   * 2. otherwise one `SELECT … ORDER BY start_time ASC, id ASC LIMIT maxRows + 1`
   *    with no `OFFSET`, consumed row by row and reconstructed in chunks of at
   *    most {@link TELEMETRY_QUERY_MAX_LIMIT} raw rows, so the raw rows are
   *    never all held at once. Should more than `maxRows` rows arrive — another
   *    connection wrote between the two statements — the read stops and the
   *    scan answers incomplete with the rows it met as `total`.
   *
   * The rows are those, and in the order, of every `query({ ...filter, sort:
   * 'start_asc' })` page concatenated. A stored row that no longer validates
   * is skipped, counted in {@link TelemetryScan.skipped} and reported once at
   * `warn` by arrival number alone, as a page's is.
   *
   * @example
   * ```ts
   * const slice = telemetry.scanEvents({ sessionId, captureId, kinds: ['render'] }, 50_000);
   * if (slice.ok && slice.value.complete) {
   *   const stats = aggregateRenders(slice.value.rows);
   * }
   * ```
   *
   * @param filter What to match — the filter fields of {@link TelemetryQuery}.
   * A filter narrowed to nothing (an empty `kinds` or `tiers` list) is
   * answered `{ rows: [], total: 0, complete: true }` without a statement.
   * @param maxRows The most rows the caller will take; a non-negative safe
   * integer. `0` counts only: the scan is complete exactly when the selection
   * is empty.
   * @returns The scan, or the refusal: the filter refusals of
   * {@link TelemetryRepo.query} (a blank session or narrowing, an unknown kind
   * or tier, a non-finite `minDuration`), or `STORE_ERROR` with reason
   * `invalid-max-rows`.
   */
  scanEvents(filter: TelemetryScanFilter, maxRows: number): Result<TelemetryScan, DebuggenError>;

  /**
   * Reads one page of the groups a session's filtered events form under one
   * key, largest group first by default.
   *
   * The grouped half of `count_desc`: one entry per distinct key value, with
   * its occurrence count, its first event and its timing, formed from exactly
   * the rows {@link TelemetryRepo.query} would match for the same filter. Rows
   * whose key is `NULL` — a non-request under `requestKey`, an event naming no
   * component under `component`, a document that is not valid JSON under
   * `component` — belong to no group and are left out. Only **readable**
   * events count: a stored row that no longer reconstructs as an event is left
   * out of every group and reported in {@link TelemetryGroupPage.skipped} and
   * at `warn`, the same skip-and-report rule a row page follows, so no count
   * and no representative event rests on evidence a read cannot show. Every
   * ordering ends in the group key and then the id of the group's first event
   * (both compared as SQLite's `BINARY` collation does), so groups of equal
   * count page deterministically and no group order reads an arrival number.
   *
   * The whole filtered set is read to form the groups, so the cost grows with
   * the rows matched rather than with the page; narrow by capture, kind or
   * trace for a large session.
   *
   * @param query The narrowing, the required group key, and the page.
   * @returns The page of groups, or the refusal for an argument this
   * repository will not accept — the refusals of {@link TelemetryRepo.query},
   * plus a missing group key.
   */
  queryGroups(query: TelemetryGroupQuery): Result<TelemetryGroupPage, DebuggenError>;

  /**
   * Every event of one correlated interaction, in canonical order by default.
   *
   * What the correlator is handed to build a trace tree, and what the
   * `timeline`, `flame` and `waterfall` nodes are served from. Like every
   * convenience reader it orders by the canonical chain
   * ({@link CANONICAL_ORDER_BY}) under each sort, never by the panel-data
   * orderings of {@link TelemetryRepo.query}: the correlator's page walk relies
   * on it.
   *
   * A trace id is not guaranteed unique across the captures of a session — it
   * is minted by a producer, and nothing in the schema keys it to one capture —
   * so `options.captureId` narrows the trace to one capture window: only that
   * capture's events are returned, and `total` counts only them. Absent, every
   * capture's events of the trace are returned together.
   *
   * @param sessionId The session that owns the evidence.
   * @param traceId The correlation id shared by every event of the interaction.
   * @param options The capture narrowing, the remaining filters, ordering and
   * paging.
   * @returns The page, or the refusal for an argument this repository will not
   * accept — the refusals of {@link TelemetryRepo.query}.
   */
  listByTrace(
    sessionId: SessionId,
    traceId: string,
    options?: TelemetryReadOptions,
  ): Result<TelemetryPage, DebuggenError>;

  /** Every event of one capture window. The default page of the event log. */
  listByCapture(
    sessionId: SessionId,
    captureId: CaptureId,
    options?: Omit<TelemetryReadOptions, 'captureId'>,
  ): Result<TelemetryPage, DebuggenError>;

  /**
   * One page of a capture window's events in canonical order, for the capture
   * summary — the bounded read behind the capture stage's summary walk (AAP
   * §0.5.5).
   *
   * Each page reports the stored size of the rows it read beside the rows, so
   * the walk can stop at a size ceiling as well as a count ceiling: attributes
   * are open JSON, and a count alone does not bound how much memory the events
   * of one summary hold. No `COUNT(*)` of the window runs per page (see
   * {@link CaptureSummaryPage.nextOffset}); the caller that needs the window's
   * exact size asks {@link TelemetryRepo.countByKind} once.
   *
   * @param sessionId The session that owns the capture.
   * @param captureId The capture window.
   * @param options The page size and offset, in rows.
   * @returns The page, or `STORE_ERROR` for a blank session or capture id
   * (`blank-session-id`, `blank-capture-id`) or a `limit` or `offset` that is
   * not a whole number (`invalid-limit`, `invalid-offset`).
   */
  pageCaptureForSummary(
    sessionId: SessionId,
    captureId: CaptureId,
    options: CaptureSummaryPageOptions,
  ): Result<CaptureSummaryPage, DebuggenError>;

  /**
   * Every event sharing one request grouping key.
   *
   * The indexed read behind duplicate-request detection: the occurrences of one
   * group, in the order they happened. Read in that canonical order, as a range
   * that stops at the page's end, from
   * `idx_telemetry_events_session_id_request_key_start_time_producer_id_seq`
   * (schema version 3; see {@link TelemetryQuery.requestKey}).
   */
  listByRequestKey(
    sessionId: SessionId,
    requestKey: string,
    options?: TelemetryReadOptions,
  ): Result<TelemetryPage, DebuggenError>;

  /**
   * Every event naming `parentSpanId` as its parent.
   *
   * The child lookup the correlator uses while it nests a trace, and what an
   * expandable timeline row asks for.
   */
  listChildren(
    sessionId: SessionId,
    parentSpanId: string,
    options?: TelemetryReadOptions,
  ): Result<TelemetryPage, DebuggenError>;

  /**
   * One event by its span id.
   *
   * A span id is unique within its trace rather than globally, so the first
   * match in canonical order is returned; a session that holds two traces using
   * the same span id gets the earlier one, deterministically.
   *
   * @returns The event, or `undefined` when the session holds no such span.
   */
  getBySpanId(
    sessionId: SessionId,
    spanId: string,
  ): Result<TelemetryEvent | undefined, DebuggenError>;

  /**
   * The distinct trace ids of a session, ordered by each trace's earliest
   * event.
   *
   * What a panel's trace picker lists, and how the analysis stage finds the
   * interaction a capture is about.
   */
  listTraceIds(sessionId: SessionId, captureId?: CaptureId): Result<string[], DebuggenError>;

  /**
   * The trace of the scope's earliest event, taking events in `start_time`
   * order and then in arrival (`ingest_seq`) order — without listing any other
   * trace.
   *
   * The rule is deterministic and total, because arrival numbers are never
   * reused. It names the same trace as {@link TelemetryRepo.listTraceIds}'s
   * first entry whenever the scope's earliest instant belongs to one trace, and
   * differs from it only on an exact `start_time` tie between traces: the
   * listing breaks that tie by trace id, this lookup by which of the tied
   * events arrived first. After a purge removes the earliest rows, the answer
   * moves to the trace of the earliest arrival among the rows that remain.
   *
   * It exists for the panel-data `trace` source, whose default trace (a query
   * naming none, for a capture whose summary names no primary trace) is this
   * one: the listing groups and sorts every trace of the capture and answers
   * them all, only for one to be kept. This is one ordered index probe with
   * `LIMIT 1` — the capture index for a capture, the session's
   * `(session_id, start_time, ingest_seq)` index for a whole session — so its
   * cost grows with neither the number of traces nor the number of events,
   * including events tied at the earliest instant.
   *
   * @param sessionId The session that owns the evidence.
   * @param captureId Narrow to one capture; absent, every capture of the
   * session is considered, as the listing does.
   * @returns The trace id, `undefined` when there is no event to take one
   * from, or the refusal of {@link TelemetryRepo.listTraceIds}: `STORE_ERROR`
   * with reason `blank-session-id` or `blank-filter`.
   */
  firstTraceId(
    sessionId: SessionId,
    captureId?: CaptureId,
  ): Result<string | undefined, DebuggenError>;

  /**
   * How many events of each kind a session holds, zero-filled over the whole
   * kind vocabulary.
   *
   * Zero-filled rather than sparse so a caller can render every kind's row
   * without deciding what an absent key means. A row carrying a kind outside
   * the vocabulary — only possible from a database written by another build,
   * since the insert path validates and the column has no `CHECK` — is counted
   * nowhere and reported once at `warn`.
   */
  countByKind(
    sessionId: SessionId,
    captureId?: CaptureId,
  ): Result<Record<TelemetryKind, number>, DebuggenError>;

  /**
   * The {@link CaptureEventStamp} of one capture: its event count and the
   * highest arrival number among its events.
   *
   * It exists for the panel-data resolver's coverage checks: the count is how
   * many events the capture holds, which is what tells a stored capture
   * summary that still covers every event from one that retention or further
   * ingest has left behind. It is not the validator of the resolver's cached
   * aggregates — that is {@link TelemetryRepo.captureGeneration}, which reads
   * no telemetry row. One covering index read; no row is fetched and no
   * document parsed, but its cost grows with the capture's size.
   *
   * @param sessionId The session that owns the capture.
   * @param captureId The capture, which must be named.
   * @returns The stamp — `{ count: 0, maxIngestSeq: 0 }` for a capture holding
   * no event, including one this session does not own — or `STORE_ERROR` with
   * reason `blank-session-id` or `blank-capture-id`.
   */
  captureStamp(
    sessionId: SessionId,
    captureId: CaptureId,
  ): Result<CaptureEventStamp, DebuggenError>;

  /**
   * The {@link CaptureGeneration} of one capture: what a cache of the
   * capture's aggregates is validated with, without recounting the capture.
   *
   * One `PRAGMA data_version` and two lookups in the connection's write
   * ledger; no telemetry row, index entry or document is read, so the cost is
   * the same for an empty capture and for one of a million events. That is
   * what lets the panel-data resolver check its cache on every node of every
   * panel request. Compare two generations for equality only — see
   * {@link CaptureGeneration} for why equality is sound.
   *
   * @example
   * ```ts
   * const generation = unwrap(telemetry.captureGeneration(sessionId, captureId));
   * const cached = cache.get(captureId);
   * if (cached !== undefined && sameGeneration(cached.generation, generation)) {
   *   return cached.aggregates;
   * }
   * // Read the events after taking the generation, then cache under it.
   * ```
   *
   * @param sessionId The session that owns the capture.
   * @param captureId The capture, which must be named.
   * @returns The generation — `writes: 0` for a capture this connection has
   * stored nothing into — or `STORE_ERROR` with reason `blank-session-id` or
   * `blank-capture-id`, the refusals of {@link TelemetryRepo.captureStamp}.
   */
  captureGeneration(
    sessionId: SessionId,
    captureId: CaptureId,
  ): Result<CaptureGeneration, DebuggenError>;

  /**
   * The clock offsets each producer of a session reported — the informational
   * clock diagnostic of AAP 0.2.3.
   *
   * One entry per `(captureId, producerId)` whose stored events carry a
   * `clockOffsetMs`, ordered by the arrival of each producer's first reporting
   * event, at most {@link MAX_PRODUCER_CLOCK_OFFSETS} of them (the rest are
   * left out and reported at `warn`). Read from the `clock_offset_ms` column,
   * which every stored event's offset is projected into; rows written before
   * schema version 5, and events a producer created before its first usable
   * sample, carry none and are not counted.
   *
   * What it answers is whether two producers' timestamps can be compared at
   * the precision a timeline draws them. Nothing here, or anywhere else in the
   * service, applies an offset to an event's times.
   *
   * @param sessionId The session whose producers to summarise. A session the
   * store does not hold answers with an empty list, as every session read does.
   * @param options Narrow to one capture window.
   * @returns The summaries, or the refusal for a blank session or capture id.
   */
  listProducerClockOffsets(
    sessionId: SessionId,
    options?: ProducerClockOffsetOptions,
  ): Result<readonly ProducerClockOffset[], DebuggenError>;

  /**
   * Which of `ids` the session actually holds as event ids — **the subset, not
   * a verdict per input**.
   *
   * This is the authoritative half of panel evidence checking.
   * `packages/panel-schema/src/semantic.ts` decides whether a generated panel's
   * facts cite evidence that exists, and it can only see what the bounded
   * `CaptureSummary` carries: the summary holds top-N sections, so a legitimate
   * citation of an event outside the top N resolves to `unverifiable` and the
   * panel is accepted with an unproven claim. `../panels/validate.ts` closes
   * that gap by wrapping this method as the `resolveEventIds` option of
   * `validateAgainstCapture`, after which every citation is decided — which is
   * this store's contribution to the AAP 0.8.4 guarantee that an observed fact
   * must cite evidence the capture holds.
   *
   * Returning the subset rather than a boolean is what lets the caller report
   * *which* references were fabricated instead of only that some were.
   *
   * @param sessionId The session the references must belong to.
   * @param ids The cited ids, in any order, duplicates allowed.
   * @param captureId Narrow to one capture, for a panel generated from it.
   * @returns The ids that exist. An empty input answers with an empty set
   * without touching the database.
   */
  existingEventIds(
    sessionId: SessionId,
    ids: readonly string[],
    captureId?: CaptureId,
  ): Result<Set<string>, DebuggenError>;

  /** Which of `ids` the session holds as trace ids. See {@link TelemetryRepo.existingEventIds}. */
  existingTraceIds(
    sessionId: SessionId,
    ids: readonly string[],
    captureId?: CaptureId,
  ): Result<Set<string>, DebuggenError>;

  /**
   * {@link TelemetryRepo.existingEventIds} as the partition
   * `packages/panel-schema/src/semantic.ts` consumes.
   *
   * The `IdResolution` shape is imported from that package, never restated: its
   * `known`/`unknown` split is what the semantic validator reads, and building
   * it here means `../panels/validate.ts` hands the resolver straight through
   * instead of reconstructing the complement of a set and risking the
   * off-by-one that would report a stored event as fabricated.
   */
  partitionKnownEventIds(
    sessionId: SessionId,
    ids: readonly string[],
    captureId?: CaptureId,
  ): Result<IdResolution, DebuggenError>;

  /** {@link TelemetryRepo.partitionKnownEventIds} for trace ids. */
  partitionKnownTraceIds(
    sessionId: SessionId,
    ids: readonly string[],
    captureId?: CaptureId,
  ): Result<IdResolution, DebuggenError>;

  /** How many events one session holds, so `./retention.ts` can report what it removed. */
  countBySession(sessionId: SessionId): Result<number, DebuggenError>;

  /**
   * The ingest watermark of one capture window: how many rows arrived for it
   * and the highest arrival number among them, read from the bounded
   * in-memory arrival tracker ({@link CAPTURE_ARRIVAL_TRACKER_CAPACITY}) that
   * `insertMany` advances after each commit — no statement runs, so the read
   * costs the same whatever the capture holds.
   *
   * The capture stage's stop barrier (AAP §0.5.5) polls it after disarming the
   * producers and closes the window only once it has stopped moving, so the
   * batches the producers flush on disarm — and any already in flight — are
   * attributed to the capture that recorded them rather than lost. It sees the
   * arrivals of this repository instance only, which is why ingest and the
   * capture stage share the one instance `src/main.ts` builds.
   *
   * @param sessionId The session that owns the capture.
   * @param captureId The capture window.
   * @returns The watermark — `{ eventCount: 0, lastIngestSeq: 0 }` for a
   * capture nothing arrived for while tracked, or one this session does not
   * own — or the refusal for a blank id.
   */
  captureWatermark(
    sessionId: SessionId,
    captureId: CaptureId,
  ): Result<CaptureIngestWatermark, DebuggenError>;

  /**
   * Starts accounting for one capture window's producer loss, in the bounded
   * in-process ledger described at {@link PRODUCER_LOSS_LEDGER_CAPACITY}.
   *
   * The capture stage calls it as soon as the session manager has opened the
   * window, and only then is the capture **accounted**
   * ({@link ProducerLossTotal.accounted}): from that moment every loss report
   * ingest attributes to the capture reaches this entry. A capture id is fresh
   * when its window opens, so a report recorded for it before this call
   * arrived after the opening too and is kept. Calling it again for a capture
   * already accounted changes nothing.
   *
   * @param sessionId The session that owns the capture.
   * @param captureId The capture window just opened.
   * @returns `Ok`, or `STORE_ERROR` for a blank id (`blank-session-id`,
   * `blank-capture-id`).
   */
  beginProducerLossAccounting(
    sessionId: SessionId,
    captureId: CaptureId,
  ): Result<void, DebuggenError>;

  /**
   * Adds one producer-loss report to the capture's running total.
   *
   * The ingest path calls it for a batch that carries a loss count, after
   * attributing the batch; the capture stage reads the total back through
   * {@link TelemetryRepo.producerLoss} when it closes the window and records it
   * in the summary's coverage, which is the persisted record of the loss. A
   * report of `0` changes nothing. The total saturates at
   * `Number.MAX_SAFE_INTEGER` rather than losing precision.
   *
   * A report for a capture whose accounting was never begun in this process —
   * the service restarted while the window was open — or whose entry was
   * evicted or released is still recorded, as a partial entry: its total is a
   * lower bound, and the capture reads as not accounted.
   *
   * @param report The capture, the optional producer and the discarded count.
   * @returns The capture's running total after the report, or `STORE_ERROR`
   * for a blank session, capture or producer id (`blank-session-id`,
   * `blank-capture-id`, `blank-filter`) or a count that is not a whole number
   * from zero within the safe-integer range (`invalid-dropped-count`); a
   * refused report changes nothing.
   */
  recordProducerLoss(report: ProducerLossReport): Result<number, DebuggenError>;

  /**
   * The producer-loss total of one capture, and whether it is the whole loss.
   *
   * @param sessionId The session that owns the capture.
   * @param captureId The capture window.
   * @returns The total with its {@link ProducerLossTotal.accounted} verdict —
   * `{ droppedEvents: 0, accounted: false }` for a capture the ledger holds no
   * entry for — or the refusal for a blank id.
   */
  producerLoss(
    sessionId: SessionId,
    captureId: CaptureId,
  ): Result<ProducerLossTotal, DebuggenError>;

  /**
   * Forgets one capture's producer-loss entry and its ingest arrivals
   * ({@link TelemetryRepo.captureWatermark}), once the capture stage has closed
   * the window and persisted the total in the summary's coverage. Releasing is
   * what keeps the bounded ledger and the bounded arrival tracker holding open
   * captures rather than finished ones. Releasing a capture neither holds
   * changes nothing.
   *
   * @param sessionId The session that owns the capture.
   * @param captureId The capture window just closed.
   * @returns `Ok`, or `STORE_ERROR` for a blank id (`blank-session-id`,
   * `blank-capture-id`).
   */
  releaseProducerLoss(sessionId: SessionId, captureId: CaptureId): Result<void, DebuggenError>;

  /**
   * Deletes every event of one session, in bounded batches of
   * {@link DEFAULT_PURGE_BATCH_SIZE}.
   *
   * Used where the session itself is kept — a capture's evidence aged out while
   * the analysis and panel that cite it stay readable. Deleting the `sessions`
   * row cascades to these rows instead, which is why this is a retention tool
   * rather than part of session deletion.
   *
   * Asynchronous for the reason {@link TelemetryRepo.deleteOlderThan} gives, and
   * with the same guarantees: one committed transaction per batch, a yield
   * between batches, a refusal (`purge-inside-transaction`) instead of a sweep
   * inside a caller's open transaction, and a promise that never rejects.
   *
   * @returns How many rows were deleted, or the failure.
   */
  deleteBySession(sessionId: SessionId): Promise<Result<number, DebuggenError>>;

  /**
   * Deletes every event that started before `cutoffEpochMs`, in bounded
   * batches.
   *
   * The `AUTOINCREMENT` on `ingest_seq` is what makes this safe to run at any
   * time: SQLite never reuses a value after a delete, so the arrival numbers of
   * the rows that remain — and of every row written afterwards — stay
   * monotonically increasing, and the canonical ordering is as total after a
   * purge as it was before one.
   *
   * **Asynchronous, and yielding.** Each batch is one short transaction, and
   * between two batches the purge awaits `setImmediate`, so a same-process
   * ingest batch — which `node:sqlite` could otherwise only run once the whole
   * synchronous sweep had returned — waits for at most one batch. The first
   * batch runs before the call returns its promise.
   *
   * **Refused inside a transaction.** Called while the connection is already
   * inside a transaction — or when one has been opened on it by the time a
   * later batch is due — the purge deletes nothing further and answers
   * `STORE_ERROR` with reason `purge-inside-transaction`. Every batch would
   * otherwise be a savepoint of that transaction: nothing would commit until
   * the caller did, the write lock would be held for the whole sweep, and
   * same-process ingest would wait for all of it. A retention step that must
   * remove a session's telemetry atomically with the session deletes the
   * `sessions` row instead, whose cascade removes these rows in one statement.
   *
   * The promise **never rejects**: every failure, including one raised between
   * batches (the store closed mid-sweep), resolves as an `err`. Rows deleted
   * by batches that committed before a failure stay deleted.
   *
   * @param cutoffEpochMs The threshold, in epoch milliseconds; a row with
   * `startTime < cutoffEpochMs` is removed.
   * @param options Session restriction and batch size.
   * @returns How many rows were deleted, or the failure.
   */
  deleteOlderThan(
    cutoffEpochMs: number,
    options?: DeleteOlderThanOptions,
  ): Promise<Result<number, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Internal shapes and helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * What may be bound to a statement parameter here.
 *
 * Narrower than `node:sqlite`'s own input union on purpose: this table holds
 * text, numbers and one nullable column, and no path below has a reason to bind
 * a `bigint` or a buffer. Anything a caller supplies is either one of these or
 * has already been refused.
 */
type BoundValue = string | number | null;

/** A row as `node:sqlite` hands it back, before anything is read out of it. */
type StoredRow = Record<string, unknown>;

/**
 * The filter the statement builder works from: the public one plus the two span
 * lookups only the convenience readers use.
 *
 * `spanId` and `parentSpanId` are deliberately absent from
 * {@link TelemetryQuery}: they are correlation keys — "this span" and "the
 * children of this span" — rather than panel-facing narrowings, and exposing
 * them would invite a panel node to filter on a value it cannot know.
 */
interface InternalFilter extends TelemetryQuery {
  /** Match one span exactly. */
  readonly spanId?: string | undefined;

  /** Match the children of one span. */
  readonly parentSpanId?: string | undefined;
}

/**
 * A resolved `WHERE` clause, or the verdict that the filter cannot match.
 *
 * The `'nothing'` case exists so an empty `kinds` or `tiers` array is answered
 * without a statement at all: binding an empty `IN ()` list is a syntax error
 * in SQLite, and widening such a filter to "everything" would be worse than
 * either.
 */
type FilterPlan =
  | { readonly kind: 'nothing' }
  | { readonly kind: 'where'; readonly clause: string; readonly values: readonly BoundValue[] };

/** The paging and ordering a query resolved to, after defaults and clamping. */
interface PagePlan {
  /** The effective sort, a checked member of the vocabulary. */
  readonly sort: TelemetrySort;

  /** The effective group key, a checked member of the vocabulary. */
  readonly groupBy: TelemetryGroupKey;

  /** The effective page size, clamped to {@link TELEMETRY_QUERY_MAX_LIMIT}. */
  readonly limit: number;

  /** The effective offset. */
  readonly offset: number;
}

/**
 * The extended SQLite result code for "no `sessions` or `captures` row holds
 * this attribution".
 *
 * Measured against Node 24.21.0 rather than assumed: the extended result codes
 * are stable SQLite values, and matching on them keeps the classification off
 * the message text, which is not a contract.
 */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

/**
 * A `CHECK` constraint refused the row — for this table, the `tier` list or the
 * `clock_offset_ms` bound (schema version 5).
 */
const SQLITE_CONSTRAINT_CHECK = 275;

/**
 * Reads the extended SQLite result code off a thrown value.
 *
 * @param cause Whatever was caught.
 * @returns The numeric code, or `undefined` when the value is not a SQLite
 * error.
 */
function sqliteErrcode(cause: unknown): number | undefined {
  if (typeof cause === 'object' && cause !== null && 'errcode' in cause) {
    const { errcode } = cause;

    return typeof errcode === 'number' ? errcode : undefined;
  }

  return undefined;
}

/** The `details` every error and log record from this module starts from. */
function context(
  operation: string,
  details: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    [LOG_BINDING_KEYS.subsystem]: SUBSYSTEM,
    [REPO_BINDING_KEY]: REPO,
    operation,
    ...details,
  };
}

/**
 * The error for a store operation that failed for a reason of its own.
 *
 * Classifies the two constraint failures a caller can still provoke with a
 * schema-valid event — an attribution no session or capture row holds, and a
 * value outside a column `CHECK` (the `tier` list, or the `clock_offset_ms`
 * bound of a store whose bound differs from this build's) — so both user
 * interfaces can say something specific, and falls back to
 * `DebuggenError.from` for everything else (a closed handle, a disk failure, a
 * statement this build cannot prepare). The two `CHECK`s share one extended
 * result code, and the classification never reads the message text, so the
 * refusal names both.
 *
 * @param operation The repository method that failed.
 * @param cause Whatever was caught.
 * @param details Identifiers and counts to attach — never an event's name,
 * attributes or any captured value.
 * @returns The coded error.
 */
function storeOperationError(
  operation: string,
  cause: unknown,
  details: Readonly<Record<string, unknown>> = {},
): DebuggenError {
  const errcode = sqliteErrcode(cause);

  if (errcode === SQLITE_CONSTRAINT_FOREIGNKEY) {
    return new DebuggenError(
      'STORE_ERROR',
      'Telemetry was attributed to a session or capture the store does not hold.',
      {
        hint: 'The session and its capture must exist before their telemetry is stored, and a purged session takes its events with it. Start a new capture and reproduce the issue again.',
        details: context(operation, { ...details, reason: 'unknown-attribution' }),
        cause,
      },
    );
  }

  if (errcode === SQLITE_CONSTRAINT_CHECK) {
    return new DebuggenError(
      'STORE_ERROR',
      'A telemetry event names a tier or a clock offset the store refuses.',
      {
        hint: `A stored event's tier must be one of: ${TELEMETRY_TIERS.join(', ')}; its clock offset, when present, must be a whole number of milliseconds within ±${String(CLOCK_OFFSET_BOUND_MS)}.`,
        details: context(operation, { ...details, reason: 'column-check' }),
        cause,
      },
    );
  }

  const error = DebuggenError.from(cause, 'STORE_ERROR');

  return new DebuggenError('STORE_ERROR', 'The telemetry store could not complete an operation.', {
    hint:
      error.hint ??
      'Check that the state directory is writable and that no other Debug Generator service is running against it, then retry.',
    details: context(operation, { ...details, reason: 'store-failed' }),
    cause,
  });
}

/**
 * The error for an argument this repository will not accept.
 *
 * Coded `STORE_ERROR` with a `reason`, matching `./modifications-repo.ts`: the
 * operation is real, the store refused it, and one code with an enumerated
 * reason is what lets a caller branch without parsing a message.
 *
 * @param operation The repository method that was called.
 * @param message What was refused.
 * @param hint What the caller should do about it.
 * @param reason The enumerated cause, for the error's `details`.
 * @param details Further identifiers and counts.
 * @returns The coded error.
 */
function argumentError(
  operation: string,
  message: string,
  hint: string,
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
): DebuggenError {
  return new DebuggenError('STORE_ERROR', message, {
    hint,
    details: context(operation, { ...details, reason }),
  });
}

/**
 * The error for a batch element that is not a persisted telemetry event.
 *
 * Coded `PROTOCOL_INVALID_MESSAGE`, the code `parseTelemetryEvent` itself
 * returns: in every real case a transport delivered the value — a WebSocket
 * batch relayed by the Chrome service worker, or an HTTP ingest body from the
 * dev-server preload — and the caller's own error handling already maps that
 * code.
 *
 * The message names the **field paths** that failed and the element's position
 * in the batch. It names no value, and it cannot: the paths come from
 * `parseTelemetryEvent`'s own summary, which drops the offending input before
 * it returns (AAP 0.5.2).
 *
 * @param index Which element of the batch failed.
 * @param total How many elements the batch held.
 * @param cause The validation failure, carried through for its issue summary.
 * @returns The coded error.
 */
function invalidEventError(index: number, total: number, cause: DebuggenError): DebuggenError {
  const paths = fieldPathsOf(cause);
  const fields = paths.length === 0 ? 'the event object itself' : paths.join(', ');

  return new DebuggenError(
    'PROTOCOL_INVALID_MESSAGE',
    `A telemetry batch element did not match the persisted event schema (fields: ${fields}).`,
    {
      hint: 'Every stored event needs the producer fields plus the attribution the service assigns: sessionId and captureId. Nothing of this batch was written.',
      details: context('insertMany', { index, batchSize: total, fields: paths }),
      cause,
    },
  );
}

/**
 * The field paths of a validation failure, read off the summary
 * `parseTelemetryEvent` attaches.
 *
 * Structure only — a path is a field name such as `attributes.component`, never
 * a value — and the read is defensive because `details` is typed as an open
 * record: a future change to the upstream summary degrades to "no paths" rather
 * than to a crash while reporting an error.
 *
 * @param error The validation failure.
 * @returns The distinct field paths, `[]` when the summary carries none.
 */
function fieldPathsOf(error: DebuggenError): string[] {
  const issues = error.details?.['issues'];

  if (!Array.isArray(issues)) {
    return [];
  }

  const paths = new Set<string>();

  for (const issue of issues) {
    if (typeof issue === 'object' && issue !== null && 'path' in issue) {
      const { path } = issue as { path?: unknown };

      if (typeof path === 'string' && path.length > 0) {
        paths.add(path);
      }
    }
  }

  return [...paths];
}

/**
 * The error for a column that does not hold the type the schema declares.
 *
 * @param operation The repository method that was reading.
 * @param column The column's name — an identifier from this module, never
 * caller input.
 * @returns The coded error.
 */
function corruptColumnError(operation: string, column: string): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'A telemetry column does not hold the type the store schema declares.',
    {
      hint: 'The session store may have been written or altered by something other than Debug Generator. Report the operation and column with the service log.',
      details: context(operation, { column }),
    },
  );
}

/**
 * Runs a repository operation, converting anything thrown into a coded error.
 *
 * Every public method goes through this, which is what makes the contract's
 * "expected failures come back as `err`, never as an exception" guarantee true
 * in one place rather than at nineteen call sites.
 *
 * An already-coded {@link DebuggenError} is returned **unchanged**, and that is
 * load-bearing rather than tidy. Two kinds of failure arrive that way: the ones
 * `Store.statement` and `Store.transaction` raise, which already carry the
 * right code and a hint a developer can act on; and the ones this module throws
 * on purpose from inside a transaction, which is how a refusal discovered
 * mid-batch rolls the batch back instead of committing half of it. Anything
 * else — a SQLite constraint failure, a disk error — is classified.
 *
 * @typeParam T The operation's success value.
 * @param operation The method's name, for the error's `details`.
 * @param fn The work to run.
 * @param details Identifiers to attach to a failure.
 * @returns What `fn` returned, or the classified failure.
 */
function attempt<T>(
  operation: string,
  fn: () => Result<T, DebuggenError>,
  details?: Readonly<Record<string, unknown>>,
): Result<T, DebuggenError> {
  try {
    return fn();
  } catch (cause) {
    if (DebuggenError.is(cause)) {
      return err(cause);
    }

    return err(storeOperationError(operation, cause, details));
  }
}

/**
 * {@link attempt} for an asynchronous operation: whatever `fn` throws or
 * rejects with becomes a coded error, so the returned promise **never
 * rejects**.
 *
 * The purges need it because a failure can now arrive after an `await` — the
 * store closed between two batches during shutdown, a disk failure on the
 * fourth batch — and a rejected promise would reach a retention sweep that was
 * written against a `Result`.
 *
 * @typeParam T The operation's success value.
 * @param operation The method's name, for the error's `details`.
 * @param fn The work to run.
 * @param details Identifiers to attach to a failure.
 * @returns What `fn` resolved to, or the classified failure.
 */
async function attemptAsync<T>(
  operation: string,
  fn: () => Promise<Result<T, DebuggenError>>,
  details?: Readonly<Record<string, unknown>>,
): Promise<Result<T, DebuggenError>> {
  try {
    return await fn();
  } catch (cause) {
    if (DebuggenError.is(cause)) {
      return err(cause);
    }

    return err(storeOperationError(operation, cause, details));
  }
}

/**
 * A change count as a number.
 *
 * `node:sqlite` types it as `number | bigint` because it is read with
 * `sqlite3_changes64()`. A batch here is bounded by
 * {@link MAX_PURGE_BATCH_SIZE} or by the caller's array length, so the
 * conversion is lossless.
 *
 * @param result What `StatementSync.run` returned.
 * @returns The change count as a number.
 */
function changesOf(result: { readonly changes: number | bigint }): number {
  return typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
}

/**
 * One connection's record of its own writes to `telemetry_events`: the
 * same-connection half of {@link CaptureGeneration}.
 *
 * `PRAGMA data_version` only moves for **other** connections' commits, so a
 * connection learns of its own writes from this ledger instead. Every value it
 * records is a fresh `counter` value, so no two recorded writes share one and
 * a recorded value never comes back after it has been replaced.
 */
interface WriteLedger {
  /** The last value handed out; each stamp is one above it. Monotonic for the connection's lifetime. */
  counter: number;

  /** The stamp of the latest purge batch that deleted at least one row, `0` when none has. */
  lastPurge: number;

  /** The stamp of the latest batch that stored at least one row of a capture, by {@link captureKey}. */
  readonly lastWrite: Map<string, number>;

  /**
   * Captures written by a batch that ran inside a transaction the caller
   * opened, whose commit was still pending when the batch returned. Each is
   * stamped again once no transaction is open (see
   * {@link TelemetryRepo.captureGeneration}), because a rollback on this
   * connection would otherwise leave the ledger describing rows that are gone.
   */
  readonly unsettled: Set<string>;
}

/**
 * Every live connection's ledger, keyed by the connection itself.
 *
 * Module-level rather than per repository, so every repository built over one
 * {@link Store} — `src/main.ts`'s, a suite's second one, a recording proxy —
 * records into and reads from the same ledger; keyed weakly, so a closed and
 * dropped connection takes its ledger with it.
 */
const WRITE_LEDGERS = new WeakMap<DatabaseSync, WriteLedger>();

/**
 * The ledger of one connection, created empty on first use.
 *
 * @param db The connection, as {@link Store.db} exposes it.
 * @returns Its ledger.
 */
function ledgerOf(db: DatabaseSync): WriteLedger {
  const existing = WRITE_LEDGERS.get(db);

  if (existing !== undefined) {
    return existing;
  }

  const created: WriteLedger = {
    counter: 0,
    lastPurge: 0,
    lastWrite: new Map(),
    unsettled: new Set(),
  };

  WRITE_LEDGERS.set(db, created);

  return created;
}

/**
 * The next value of a ledger's counter, consumed.
 *
 * @param ledger The connection's ledger.
 * @returns A value no earlier stamp of this ledger holds.
 */
function nextStamp(ledger: WriteLedger): number {
  ledger.counter += 1;

  return ledger.counter;
}

/**
 * Reads an integer column, accepting the `bigint` a handle configured to read
 * big integers would hand back.
 *
 * @param value The raw column value.
 * @returns The number, or `undefined` when the column holds something else.
 */
function readInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return typeof value === 'bigint' ? Number(value) : undefined;
}

/**
 * Whether a value is a whole number this repository will accept as a bound,
 * a count or an offset.
 *
 * @param value The value to test.
 * @returns `true` for a finite, non-negative integer.
 */
function isWholeNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads a column holding a clock offset, accepting only what the event schema
 * and the column `CHECK` accept.
 *
 * @param value The raw column value.
 * @returns The offset, or `undefined` when the column holds anything but a
 * whole number of milliseconds within `±CLOCK_OFFSET_BOUND_MS`.
 */
function readClockOffset(value: unknown): number | undefined {
  const offset = readInteger(value);

  return offset !== undefined && isClockOffsetMs(offset) ? offset : undefined;
}

/**
 * Reads a column holding a count or an arrival number: a positive integer.
 *
 * @param value The raw column value.
 * @returns The number, or `undefined` when the column holds anything else.
 */
function readPositiveInteger(value: unknown): number | undefined {
  const number = readInteger(value);

  return number !== undefined && isWholeNumber(number) && number > 0 ? number : undefined;
}

/**
 * Reads the distinct tiers `json_group_array(DISTINCT tier)` collected, in
 * `TELEMETRY_TIERS` order.
 *
 * The aggregate's element order is unspecified, so the vocabulary's order is
 * imposed here rather than trusted from SQLite.
 *
 * @param value The raw column value: a JSON array of tier names.
 * @returns The tiers, or `undefined` when the value is not a non-empty JSON
 * array of vocabulary members.
 */
function readTiers(value: unknown): readonly TelemetryTier[] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return undefined;
  }

  const present = new Set<TelemetryTier>();

  for (const member of parsed as readonly unknown[]) {
    if (!isTelemetryTier(member)) {
      return undefined;
    }

    present.add(member);
  }

  return Object.freeze(TELEMETRY_TIERS.filter((tier) => present.has(tier)));
}

/**
 * The grouping key of an event, read out of its attributes.
 *
 * Never computed here: the value is the keyed hash
 * `../telemetry/ingest.ts` assigned from the **unredacted** URL under the
 * per-session key, and that URL no longer exists by the time a row is written
 * (see this module's overview). The column is a denormalisation of the
 * attribute so that duplicate grouping is an indexed read, and an event that is
 * not a request simply has none.
 *
 * @param event The event being stored.
 * @returns The key, or `null` for an event that carries none — or for any event
 * at all, should the key ever stop being service-assigned
 * ({@link REQUEST_KEY_IS_SERVICE_ASSIGNED}).
 */
function requestKeyOf(event: PersistableTelemetryEvent): string | null {
  if (!REQUEST_KEY_IS_SERVICE_ASSIGNED) {
    return null;
  }

  const value = event.attributes[REQUEST_KEY_ATTRIBUTE];

  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The JSON document stored in the `event` column.
 *
 * `ingestSeq` is stripped rather than stored: the column the database assigns
 * is the authority on the arrival number, and a document carrying a second copy
 * could disagree with it after a replay. Every read injects the row's own
 * `ingest_seq` before validating, so the field is never missing where it is
 * needed.
 *
 * The key is removed from a shallow copy rather than filtered out by a
 * `JSON.stringify` replacer: a replacer is called for every key at every depth,
 * and `attributes` is an open bag that may legitimately carry a key of the same
 * name, which a replacer would silently drop as well.
 *
 * @param event The validated event.
 * @returns The serialised document.
 */
function toStoredDocument(event: TelemetryEvent): string {
  const document: Record<string, unknown> = { ...event };

  delete document['ingestSeq'];

  return JSON.stringify(document);
}

/**
 * The bind list for one insert, in {@link INSERT_COLUMNS} order.
 *
 * @param event The validated event.
 * @param document The serialised document for the `event` column.
 * @returns The values to bind.
 */
function insertValues(event: TelemetryEvent, document: string): readonly BoundValue[] {
  return [
    event.id,
    event.sessionId,
    event.captureId,
    event.traceId,
    event.spanId,
    event.parentSpanId ?? null,
    event.kind,
    event.tier,
    event.name,
    // Bound as the doubles they are. The columns are REAL and nothing here
    // rounds them: the browser producer computes `performance.timeOrigin` plus
    // an entry offset and the server producer converts OpenTelemetry `hrTime`,
    // and a correlated cross-tier timeline is only correct if that
    // sub-millisecond precision survives the round trip.
    event.startTime,
    event.duration,
    event.producerId,
    event.seq,
    // Projected exactly as the producer stamped it — validated, never
    // re-derived — and `NULL` when the event carries no offset.
    event.clockOffsetMs ?? null,
    requestKeyOf(event),
    document,
  ];
}

/* -------------------------------------------------------------------------------------------------
 * Planning a read
 * ---------------------------------------------------------------------------------------------- */

/**
 * Refuses a string narrowing that is present but empty.
 *
 * An empty lookup key matches nothing, so accepting one would answer a caller's
 * bug with a plausible empty page. Reachable from a JavaScript caller and from
 * a value threaded through an optional chain.
 *
 * @param value The narrowing, when present.
 * @param field The field's name, for the refusal.
 * @param operation The calling method.
 * @returns The refusal, or `undefined` when there is nothing to refuse.
 */
function refuseBlank(
  value: string | undefined,
  field: string,
  operation: string,
): DebuggenError | undefined {
  if (value !== undefined && value.length === 0) {
    return argumentError(
      operation,
      `A telemetry query named an empty ${field}.`,
      `Pass a ${field} or omit the field: an empty value matches nothing.`,
      'blank-filter',
      { field },
    );
  }

  return undefined;
}

/**
 * Builds the `WHERE` clause and its bind list from the fields a filter actually
 * carries.
 *
 * Every value is bound; the clause itself is assembled from column names and
 * placeholder counts only. The `IN` lists are sized to the de-duplicated array,
 * which keeps the bind count minimal and the number of distinct statement texts
 * bounded by the vocabulary widths rather than by the caller's input.
 *
 * The session scope is always the first term and the first bound value. It is
 * written as {@link RESIDUAL_SESSION_TERM} when the filter names a trace, span
 * or parent-span id, and as {@link SESSION_TERM} otherwise. A capture narrowing
 * is written as {@link RESIDUAL_CAPTURE_TERM} when the filter also names a
 * request group, and as {@link CAPTURE_TERM} otherwise. Each is a choice of
 * access path only, never of which rows match.
 *
 * @param filter What to match.
 * @param operation The calling method, for a refusal's `details`.
 * @returns The clause and values, the `'nothing'` verdict for a filter that
 * cannot match, or the refusal.
 */
function buildFilter(filter: InternalFilter, operation: string): Result<FilterPlan, DebuggenError> {
  if (filter.sessionId.length === 0) {
    return err(
      argumentError(
        operation,
        'A telemetry query named no session.',
        'Every telemetry row belongs to one session; pass the session id the capture was recorded under.',
        'blank-session-id',
      ),
    );
  }

  for (const [value, field] of [
    [filter.captureId, 'captureId'],
    [filter.traceId, 'traceId'],
    [filter.spanId, 'spanId'],
    [filter.parentSpanId, 'parentSpanId'],
    [filter.requestKey, 'requestKey'],
    [filter.component, 'component'],
  ] as const) {
    const refusal = refuseBlank(value, field, operation);

    if (refusal !== undefined) {
      return err(refusal);
    }
  }

  // A span, parent-span or trace id is selective across the whole table, and
  // its own index answers the read in a handful of rows; the session term is
  // then a residual filter, so the planner cannot prefer a session-leading
  // index that walks the whole session. Any other filter keeps the plain term,
  // which is what lets the capture, kind and request-group indexes serve it.
  // The bound value and its position are the same either way.
  const keyedOnGlobalId =
    filter.traceId !== undefined ||
    filter.spanId !== undefined ||
    filter.parentSpanId !== undefined;
  const clauses: string[] = [keyedOnGlobalId ? RESIDUAL_SESSION_TERM : SESSION_TERM];
  const values: BoundValue[] = [filter.sessionId];

  if (filter.captureId !== undefined) {
    // A request group is narrower than a capture, so a read naming both keeps
    // the capture as a residual filter and is served by the request-group
    // composite rather than by a walk of the whole capture. Same bound value,
    // same position.
    clauses.push(filter.requestKey !== undefined ? RESIDUAL_CAPTURE_TERM : CAPTURE_TERM);
    values.push(filter.captureId);
  }

  if (filter.traceId !== undefined) {
    clauses.push('trace_id = ?');
    values.push(filter.traceId);
  }

  if (filter.spanId !== undefined) {
    clauses.push('span_id = ?');
    values.push(filter.spanId);
  }

  if (filter.parentSpanId !== undefined) {
    clauses.push('parent_span_id = ?');
    values.push(filter.parentSpanId);
  }

  if (filter.requestKey !== undefined) {
    clauses.push('request_key = ?');
    values.push(filter.requestKey);
  }

  if (filter.kinds !== undefined) {
    const kinds = [...new Set(filter.kinds)];

    for (const kind of kinds) {
      if (!isTelemetryKind(kind)) {
        return err(
          argumentError(
            operation,
            'A telemetry query named a kind the store does not know.',
            `Use one of: ${TELEMETRY_KINDS.join(', ')}.`,
            'unknown-kind',
          ),
        );
      }
    }

    if (kinds.length === 0) {
      return ok({ kind: 'nothing' });
    }

    clauses.push(`kind IN (${placeholders(kinds.length)})`);
    values.push(...kinds);
  }

  if (filter.tiers !== undefined) {
    const tiers = [...new Set(filter.tiers)];

    for (const tier of tiers) {
      if (!isTelemetryTier(tier)) {
        return err(
          argumentError(
            operation,
            'A telemetry query named a tier the store does not know.',
            `Use one of: ${TELEMETRY_TIERS.join(', ')}.`,
            'unknown-tier',
          ),
        );
      }
    }

    if (tiers.length === 0) {
      return ok({ kind: 'nothing' });
    }

    clauses.push(`tier IN (${placeholders(tiers.length)})`);
    values.push(...tiers);
  }

  if (filter.tier !== undefined) {
    // The singular `DataQuery.filter.tier`, checked against the same
    // vocabulary and ANDed with any `tiers` list above; see TelemetryQuery.tier.
    const tier: unknown = filter.tier;

    if (!isTelemetryTier(tier)) {
      return err(
        argumentError(
          operation,
          'A telemetry query named a tier the store does not know.',
          `Use one of: ${TELEMETRY_TIERS.join(', ')}.`,
          'unknown-tier',
        ),
      );
    }

    clauses.push('tier = ?');
    values.push(tier);
  }

  if (filter.minDuration !== undefined) {
    if (!Number.isFinite(filter.minDuration) || filter.minDuration < 0) {
      return err(
        argumentError(
          operation,
          'A telemetry query named a minimum duration that is not a duration.',
          'Pass a finite number of milliseconds of zero or more, or omit the field.',
          'invalid-min-duration',
        ),
      );
    }

    clauses.push('duration >= ?');
    values.push(filter.minDuration);
  }

  if (filter.component !== undefined) {
    // The path is a module constant derived from the attribute catalog; the
    // component name is bound. See COMPONENT_JSON_PATH for why this is the one
    // filter that reads inside the document, TelemetryQuery.component for why
    // it is always combined with session_id, and COMPONENT_VALUE_SQL for why a
    // document that is not valid JSON must match nothing rather than fail the
    // whole read.
    clauses.push(`(${COMPONENT_VALUE_SQL}) = ?`);
    values.push(filter.component);
  }

  return ok({ kind: 'where', clause: clauses.join(' AND '), values });
}

/**
 * Resolves the ordering and paging of a query: defaults filled in, the limit
 * clamped, and both integers checked.
 *
 * A limit above the ceiling is clamped rather than refused — a caller asking
 * for everything gets the ceiling and a `total` that says more remains — while
 * a negative or fractional value is refused, because it is a bug rather than an
 * appetite.
 *
 * The sort and the group key are checked by **membership** in their tuples, not
 * by looking them up in the ordering tables: a JavaScript caller passing
 * `'constructor'` would otherwise find a function on `Object.prototype` and
 * reach SQLite with it.
 *
 * @param filter The query as the caller wrote it.
 * @param operation The calling method, for a refusal's `details`.
 * @param defaultSort The sort an omitted `sort` means: `'start_asc'` for rows,
 * `'count_desc'` for groups.
 * @returns The plan, or the refusal.
 */
function buildPagePlan(
  filter: TelemetryQuery,
  operation: string,
  defaultSort: TelemetrySort,
): Result<PagePlan, DebuggenError> {
  const sort: unknown = filter.sort ?? defaultSort;

  if (!isDataQuerySort(sort)) {
    return err(
      argumentError(
        operation,
        'A telemetry query named an ordering the store does not implement.',
        `Use one of: ${TELEMETRY_SORTS.join(', ')}.`,
        'unknown-sort',
      ),
    );
  }

  const groupBy: unknown = filter.groupBy ?? TELEMETRY_DEFAULT_GROUP_KEY;

  if (!isTelemetryGroupKey(groupBy)) {
    return err(
      argumentError(
        operation,
        'A telemetry query named a group key the store does not know.',
        `Use one of: ${TELEMETRY_GROUP_KEYS.join(', ')}.`,
        'unknown-group-key',
      ),
    );
  }

  const requestedLimit = filter.limit ?? TELEMETRY_QUERY_DEFAULT_LIMIT;

  if (!isWholeNumber(requestedLimit)) {
    return err(
      argumentError(
        operation,
        'A telemetry query named a page size that is not a whole number of rows.',
        `Pass an integer of zero or more, or omit the field for ${String(TELEMETRY_QUERY_DEFAULT_LIMIT)}.`,
        'invalid-limit',
      ),
    );
  }

  const offset = filter.offset ?? TELEMETRY_QUERY_DEFAULT_OFFSET;

  if (!isWholeNumber(offset)) {
    return err(
      argumentError(
        operation,
        'A telemetry query named an offset that is not a whole number of rows.',
        'Pass an integer of zero or more, or omit the field to start at the first row.',
        'invalid-offset',
      ),
    );
  }

  return ok({
    sort,
    groupBy,
    limit: Math.min(requestedLimit, TELEMETRY_QUERY_MAX_LIMIT),
    offset,
  });
}

/**
 * Resolves {@link TelemetryQuery.parentFirst} against the page's effective
 * sort.
 *
 * Checked apart from {@link buildPagePlan}, which a grouped read shares: a
 * page of groups has no parent-first reading, and its type does not carry the
 * field. The value is checked by type because a JavaScript caller can send
 * anything, and a truthy string silently reordering a page would be a bug the
 * ordering hides.
 *
 * @param filter The query as the caller wrote it.
 * @param sort The page's effective sort.
 * @param operation The calling method, for a refusal's `details`.
 * @returns Whether the page is parent-first, or the refusal.
 */
function resolveParentFirst(
  filter: TelemetryQuery,
  sort: TelemetrySort,
  operation: string,
): Result<boolean, DebuggenError> {
  const requested: unknown = filter.parentFirst ?? false;

  if (typeof requested !== 'boolean') {
    return err(
      argumentError(
        operation,
        'A telemetry query named a parent-first ordering that is not a boolean.',
        'Pass true to order a start_asc page parent before child, or omit the field.',
        'invalid-parent-first',
      ),
    );
  }

  if (requested && sort !== 'start_asc') {
    return err(
      argumentError(
        operation,
        'A telemetry query asked for a parent-first order under a sort that has none.',
        'Ask for parent-first ordering with sort start_asc only, or omit the field.',
        'parent-first-requires-start-asc',
        { sort },
      ),
    );
  }

  return ok(requested);
}

/**
 * Splits values into chunks of at most {@link EXISTENCE_LOOKUP_CHUNK_SIZE}.
 *
 * @typeParam T The value type: an id, or an arrival number.
 * @param values The de-duplicated values.
 * @returns One array per statement, in input order.
 */
function chunk<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += EXISTENCE_LOOKUP_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + EXISTENCE_LOOKUP_CHUNK_SIZE));
  }

  return chunks;
}

/* -------------------------------------------------------------------------------------------------
 * Reading rows back
 * ---------------------------------------------------------------------------------------------- */

/** What one batch of rows yielded. */
interface ReadRows {
  /** The events that reconstructed and validated. */
  readonly events: TelemetryEvent[];

  /**
   * The `ingest_seq` of every row that did not, for the one `warn` line the
   * query emits. Never the row's content.
   */
  readonly skipped: number[];
}

/**
 * The arrival number used while an event is validated, before the database has
 * assigned the real one.
 *
 * The persisted schema requires a one-based positive integer, so a candidate
 * cannot be validated without *some* value — and validating before the write is
 * the point, since a row no read could reconstruct must never be written. The
 * probe is replaced by the assigned number on the way out, so it never reaches
 * the table (it is not among the stored columns) and never reaches a caller.
 */
const VALIDATION_PROBE_INGEST_SEQ = 1;

/**
 * Reconstructs events from rows, skipping any that no longer validate.
 *
 * The `event` column is authoritative and the row's own `ingest_seq` is injected
 * into the parsed document before validation, which is what keeps the stored
 * document free of a second copy of a number the database owns.
 *
 * A row that cannot be reconstructed is **skipped and counted** rather than
 * failing the read: a single poisoned row must not blank out a whole generated
 * panel (AAP 0.5.5). A row whose `ingest_seq` itself is unreadable is a
 * different matter and fails the read, because that column is the row's
 * identity and there would be nothing to report the skip under.
 *
 * @param rows The rows as read.
 * @param operation The calling method, for a column failure's `details`.
 * @returns The events and the skipped arrival numbers, or the column failure.
 */
function readEvents(
  rows: readonly StoredRow[],
  operation: string,
): Result<ReadRows, DebuggenError> {
  const events: TelemetryEvent[] = [];
  const skipped: number[] = [];

  for (const row of rows) {
    const ingestSeq = readInteger(row['ingest_seq']);

    if (ingestSeq === undefined) {
      return err(corruptColumnError(operation, 'ingest_seq'));
    }

    const document = row['event'];

    if (typeof document !== 'string') {
      skipped.push(ingestSeq);
      continue;
    }

    let candidate: unknown;

    try {
      candidate = JSON.parse(document);
    } catch {
      // The parse failure is deliberately not attached: its message can quote
      // the malformed text, which is captured data (AAP 0.5.2).
      skipped.push(ingestSeq);
      continue;
    }

    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      skipped.push(ingestSeq);
      continue;
    }

    // The parsed document is this read's own object, so the arrival number is
    // written into it rather than into a copy of it: the input the schema sees
    // is the same — a document's own `ingestSeq`, if it carried one, is
    // overwritten either way — at one allocation per row fewer, on the path
    // every whole-capture scan takes once per stored event.
    const parsed = parseTelemetryEvent(Object.assign(candidate, { ingestSeq }));

    if (isErr(parsed)) {
      skipped.push(ingestSeq);
      continue;
    }

    events.push(parsed.value);
  }

  return ok({ events, skipped });
}

/** What {@link readLineage} builds from the rows of {@link lineageKeysSql}. */
interface ReadLineage {
  /** Every row's lineage key, in flat canonical order: a key's index is its rank. */
  readonly keys: LineageKey[];

  /** Every row's arrival number, aligned with {@link ReadLineage.keys}. */
  readonly ingestSeqs: number[];
}

/**
 * Reads the lineage keys of a parent-first page's first statement.
 *
 * Flat columns only, so a row whose `event` document no longer validates is
 * still ordered — and counted in `total` — exactly as a flat page orders and
 * counts it; it is skipped and reported only if it falls inside the page's
 * window, when its document is read. A column that does not hold its
 * declared type can only come from a database this build did not write
 * (`telemetry_events` is `STRICT`), and fails the read.
 *
 * @param rows The rows as read, in {@link CANONICAL_ORDER_BY}.
 * @param operation The calling method, for a column failure's `details`.
 * @returns The keys and arrival numbers, or the column failure.
 */
function readLineage(
  rows: readonly StoredRow[],
  operation: string,
): Result<ReadLineage, DebuggenError> {
  const keys: LineageKey[] = [];
  const ingestSeqs: number[] = [];

  for (const row of rows) {
    const ingestSeq = readInteger(row['ingest_seq']);

    if (ingestSeq === undefined) {
      return err(corruptColumnError(operation, 'ingest_seq'));
    }

    const traceId = row['trace_id'];
    const spanId = row['span_id'];
    const parentSpanId = row['parent_span_id'];

    if (typeof traceId !== 'string') {
      return err(corruptColumnError(operation, 'trace_id'));
    }

    if (typeof spanId !== 'string') {
      return err(corruptColumnError(operation, 'span_id'));
    }

    if (parentSpanId !== null && typeof parentSpanId !== 'string') {
      return err(corruptColumnError(operation, 'parent_span_id'));
    }

    keys.push(parentSpanId === null ? { traceId, spanId } : { traceId, spanId, parentSpanId });
    ingestSeqs.push(ingestSeq);
  }

  return ok({ keys, ingestSeqs });
}

/** What {@link collectGroups} builds from the rows of {@link groupRowsSql}. */
interface CollectedGroups {
  /** One group per key that at least one readable event carries, unordered. */
  readonly groups: TelemetryGroup[];

  /** The arrival numbers of the rows left out because they could not be read. */
  readonly skipped: number[];
}

/**
 * Folds the rows of {@link groupRowsSql} into groups, counting **readable
 * events only**.
 *
 * Every row goes through {@link readEvents} — the reconstruction and schema
 * check every other read applies — before it may count. A row that fails is
 * left out of every group and reported by arrival number, exactly as a row
 * page skips and reports it, so a group's `count` is the number of events a
 * caller can actually read under that key, and its `firstEventId`,
 * `firstStartTime` and `totalDuration` come from those events alone. A group
 * whose rows are all unreadable therefore does not exist, rather than existing
 * with evidence nobody can show.
 *
 * The rows arrive in arrival order, so the first readable event seen for a key
 * is the group's smallest readable `ingest_seq`. Timing is taken from the
 * validated document, which is the authoritative copy (the flat columns are
 * projections of it).
 *
 * @param rows The rows, in arrival order.
 * @param operation The calling method, for a column failure's `details`.
 * @returns The groups and the skipped arrival numbers, or a column failure —
 * a missing arrival number or a non-text key can only come from a database
 * this build did not write.
 */
function collectGroups(
  rows: readonly StoredRow[],
  operation: string,
): Result<CollectedGroups, DebuggenError> {
  const byKey = new Map<string, TelemetryGroup>();
  const skipped: number[] = [];

  for (const row of rows) {
    const read = readEvents([row], operation);

    if (isErr(read)) {
      return read;
    }

    const [event] = read.value.events;

    if (event === undefined) {
      skipped.push(...read.value.skipped);
      continue;
    }

    const key = row['group_key'];

    if (typeof key !== 'string') {
      return err(corruptColumnError(operation, 'group_key'));
    }

    const current = byKey.get(key);

    byKey.set(
      key,
      current === undefined
        ? {
            key,
            count: 1,
            firstEventId: event.id,
            firstIngestSeq: event.ingestSeq,
            firstStartTime: event.startTime,
            totalDuration: event.duration,
          }
        : {
            ...current,
            count: current.count + 1,
            firstStartTime: Math.min(current.firstStartTime, event.startTime),
            totalDuration: current.totalDuration + event.duration,
          },
    );
  }

  return ok({ groups: [...byKey.values()], skipped });
}

/**
 * Refuses a call that named no session.
 *
 * @param sessionId The session id as given.
 * @param operation The calling method.
 * @returns The refusal, or `undefined` when the id is usable.
 */
function requireSession(sessionId: SessionId, operation: string): DebuggenError | undefined {
  if (sessionId.length === 0) {
    return argumentError(
      operation,
      'A telemetry read named no session.',
      'Every telemetry row belongs to one session; pass the session id the capture was recorded under.',
      'blank-session-id',
    );
  }

  return undefined;
}

/**
 * Refuses a call that must name a capture and named none.
 *
 * The type already requires the id; this is the guard for a JavaScript caller
 * and for a value threaded through an optional chain, which would otherwise
 * reach the binding as `undefined` and fail as an opaque store error rather
 * than as the caller's mistake.
 *
 * @param captureId The capture id as given.
 * @param operation The calling method.
 * @returns The refusal, or `undefined` when the id is usable.
 */
function requireCapture(
  captureId: CaptureId | undefined,
  operation: string,
): DebuggenError | undefined {
  if (captureId === undefined || captureId.length === 0) {
    return argumentError(
      operation,
      'A telemetry read named no capture.',
      'This read is about one capture window; pass the id of the capture whose events it covers.',
      'blank-capture-id',
    );
  }

  return undefined;
}

/**
/**
 * The key one capture is filed under in a {@link WriteLedger}, the
 * producer-loss ledger and the arrival tracker.
 *
 * A JSON tuple rather than a joined string, so no pair of ids — however a
 * JavaScript caller shaped them — can collide with another pair.
 *
 * @param sessionId The owning session.
 * @param captureId The capture window.
 * @returns The key.
 */
function captureKey(sessionId: string, captureId: string): string {
  return JSON.stringify([sessionId, captureId]);
}

/** The watermark of a capture the arrival tracker holds nothing for. */
const NO_ARRIVALS: CaptureIngestWatermark = Object.freeze({ eventCount: 0, lastIngestSeq: 0 });

/** One capture's entry in the producer-loss ledger ({@link PRODUCER_LOSS_LEDGER_CAPACITY}). */
interface ProducerLossEntry {
  /** The running total of discarded events reported for the capture in this process. */
  readonly droppedEvents: number;
  /**
   * Whether {@link TelemetryRepo.beginProducerLossAccounting} created or
   * adopted the entry when the capture's window opened — what makes the total
   * the whole loss rather than a lower bound.
   */
  readonly begun: boolean;
}

/**
 * The error for an event id the table already holds under **another** session.
 *
 * `id` is globally unique in the table, so a replay conflicting on it is
 * ordinarily the same producer re-sending its own buffered batch and the stored
 * row belongs to the same session. A conflict whose row belongs elsewhere means
 * two sessions are claiming one event, and reporting the stored row's arrival
 * number would attach this session's evidence to another session's row. The
 * whole batch is rolled back instead.
 *
 * @param eventId The id that collided.
 * @returns The coded error.
 */
function reusedEventIdError(eventId: string): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'A telemetry event id is already stored under a different session.',
    {
      hint: 'Event ids are minted per event and must not be reused across sessions. Nothing of this batch was written; start a new capture and reproduce the issue again.',
      details: context('insertMany', { eventId, reason: 'event-id-reused' }),
    },
  );
}

/**
 * The error for an event whose `captureId` names a capture that belongs to a
 * **different** session than the event's `sessionId`.
 *
 * Attribution assigns both ids together from the bound session's active
 * capture (AAP 0.4.2), so a pair that disagrees is not a partial attribution but a
 * wrong one: stored, the row would claim one session's evidence while living
 * under another session's capture, and deleting that capture would cascade it
 * away from the session that owns it. The whole batch is rolled back instead.
 *
 * Only the event's **own** identifiers are reported. The session that actually
 * owns the capture is deliberately left out of the message and the details:
 * an error raised here is logged and may be shown in both user interfaces, and
 * naming another session there would disclose that session to whoever sees the
 * refusal.
 *
 * @param index The offending element's position in the batch.
 * @param batchSize How many events the batch held.
 * @param sessionId The session the element claims.
 * @param captureId The capture the element names, which that session does not own.
 * @returns The coded error.
 */
function captureOwnershipError(
  index: number,
  batchSize: number,
  sessionId: string,
  captureId: string,
): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'A telemetry event is attributed to a capture that belongs to a different session.',
    {
      hint: "An event's capture must be a capture of the event's own session, so attribution must take both from the same active capture window. Nothing of this batch was written; start a new capture and reproduce the issue again.",
      details: context('insertMany', {
        index,
        batchSize,
        sessionId,
        captureId,
        reason: 'capture-session-mismatch',
      }),
    },
  );
}

/**
 * The error for an event id the session already holds as a **different**
 * event.
 *
 * A producer replaying its own buffered batch re-sends the identical event, so
 * a same-session conflict whose content differs is not a replay: it is an id
 * reused for a second event, and skipping it would report the candidate as
 * stored while the table holds something else — evidence the live tail, the
 * correlator and the model would each read differently. The whole batch is
 * rolled back instead.
 *
 * `fields` carries the differing **top-level field names** only — `attributes`,
 * `startTime`, `source` — because the values on either side are captured data
 * (AAP 0.5.2). The names come from the strict persisted event schema both
 * sides were validated against, so none of them is caller text.
 *
 * @param eventId The id that collided.
 * @param fields The differing top-level field names, sorted.
 * @returns The coded error.
 */
function eventIdConflictError(eventId: string, fields: readonly string[]): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    `A telemetry event id is already stored as a different event (differing fields: ${fields.join(', ')}).`,
    {
      hint: 'A replayed event must be identical to the event first stored under its id; reusing an id for another event is a producer defect. Nothing of this batch was written.',
      details: context('insertMany', { eventId, fields: [...fields], reason: 'event-id-conflict' }),
    },
  );
}

/**
 * The error for an id conflict whose stored row cannot be reconstructed, so
 * whether the candidate is a replay cannot be decided.
 *
 * Refused rather than skipped: skipping would report an event as stored on the
 * strength of a row no read can return, and writing over it would destroy the
 * only copy there is. Also raised in the unreachable case of a suppressed insert
 * with no row behind it, which leaves the question equally unanswerable.
 *
 * @param eventId The id that collided.
 * @param ingestSeq The stored row's arrival number, when it could be read.
 * @returns The coded error.
 */
function unconfirmableReplayError(eventId: string, ingestSeq: number | undefined): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'A telemetry event id is already stored, but the stored row is not a readable event.',
    {
      hint: 'The session store may have been written or altered by something other than Debug Generator, so the replay cannot be confirmed. Nothing of this batch was written; report the event id with the service log.',
      details: context('insertMany', {
        eventId,
        ...(ingestSeq === undefined ? {} : { ingestSeq }),
        reason: 'stored-event-unreadable',
      }),
    },
  );
}

/**
 * A deterministic serialisation of a JSON value: object keys sorted at every
 * depth, arrays kept in order.
 *
 * Only ever applied to values that came out of `JSON.parse`, so every value is
 * `null`, a boolean, a finite number, a string, an array or a plain object.
 * Numbers are written by `JSON.stringify`, whose shortest round-trip form makes
 * two doubles serialise identically exactly when they are the same double —
 * which is the "exact float equality" a replay check needs for sub-millisecond
 * timestamps.
 *
 * @param value A JSON-derived value.
 * @returns Its canonical text.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJson(element)).join(',')}]`;
  }

  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);

    return `{${members.join(',')}}`;
  }

  return JSON.stringify(value);
}

/**
 * The top-level fields in which two events differ **as the store would hold
 * them**.
 *
 * Both sides are passed through {@link toStoredDocument} and parsed back before
 * they are compared, so the comparison is over exactly the document the `event`
 * column stores: `ingestSeq` is excluded (the database owns it), an optional
 * field set to `undefined` equals one that is absent, and key order is
 * irrelevant once {@link canonicalJson} has sorted it. What remains is a
 * field-for-field, value-for-value equality — a different capture, trace,
 * timing, attribute bag or source location each shows up by name.
 *
 * @param candidate The validated event offered for insertion.
 * @param stored The validated event the table holds under the same id.
 * @returns The differing field names, sorted; `[]` for an exact replay.
 */
function differingEventFields(candidate: TelemetryEvent, stored: TelemetryEvent): string[] {
  const offered = JSON.parse(toStoredDocument(candidate)) as Record<string, unknown>;
  const held = JSON.parse(toStoredDocument(stored)) as Record<string, unknown>;
  const canonicalField = (record: Record<string, unknown>, field: string): string | undefined =>
    Object.hasOwn(record, field) ? canonicalJson(record[field]) : undefined;

  return [...new Set([...Object.keys(offered), ...Object.keys(held)])]
    .filter((field) => canonicalField(offered, field) !== canonicalField(held, field))
    .sort();
}

/**
 * Decides what a suppressed insert means, and answers with the event the store
 * holds or throws the refusal that rolls the batch back.
 *
 * Called inside the batch transaction, which is why every refusal is a throw:
 * `Store.transaction` rolls back on it and {@link attempt} returns the coded
 * error unchanged. The checks run in the order that keeps each answer honest —
 * whose row it is, whether it can be read at all, and only then whether it is
 * the same event. The stored copy is reconstructed through {@link readEvents},
 * the path every read uses, so "readable" means the same thing here as on a
 * panel query.
 *
 * @param existing The row {@link SELECT_STORED_BY_ID_SQL} returned, if any.
 * @param candidate The validated event whose insert was suppressed.
 * @param operation The calling method, for a column failure's `details`.
 * @returns The stored event, with its own arrival number, for an exact replay.
 * @throws {DebuggenError} `STORE_ERROR` with reason `event-id-reused`,
 * `event-id-conflict` or `stored-event-unreadable`, or a corrupt-column error.
 */
function resolveReplay(
  existing: StoredRow | undefined,
  candidate: TelemetryEvent,
  operation: string,
): TelemetryEvent {
  if (existing === undefined) {
    throw unconfirmableReplayError(candidate.id, undefined);
  }

  const owner = existing['session_id'];

  if (typeof owner !== 'string') {
    throw corruptColumnError(operation, 'session_id');
  }

  if (owner !== candidate.sessionId) {
    throw reusedEventIdError(candidate.id);
  }

  const read = readEvents([existing], operation);

  if (isErr(read)) {
    throw read.error;
  }

  const [stored] = read.value.events;

  if (stored === undefined) {
    throw unconfirmableReplayError(candidate.id, read.value.skipped[0]);
  }

  const fields = differingEventFields(candidate, stored);

  if (fields.length > 0) {
    throw eventIdConflictError(candidate.id, fields);
  }

  return stored;
}

/**
 * A zero-filled count for every kind in the vocabulary.
 *
 * The assertion is sound by construction: the keys are exactly the members of
 * `TELEMETRY_KINDS`, which is the tuple `TelemetryKind` is derived from, so the
 * record is total. Building it from the tuple rather than writing seventeen
 * literal keys is also what makes a kind added upstream appear here in the same
 * edit.
 *
 * @returns Every kind mapped to `0`.
 */
function zeroFilledKindCounts(): Record<TelemetryKind, number> {
  return Object.fromEntries(TELEMETRY_KINDS.map((kind) => [kind, 0])) as Record<
    TelemetryKind,
    number
  >;
}

/* -------------------------------------------------------------------------------------------------
 * The repository
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the telemetry repository over an open store.
 *
 * `src/main.ts` constructs one per process and hands it to
 * `../telemetry/ingest.ts` (writes), `../telemetry/live-tail.ts` and
 * `../telemetry/correlate.ts` (reads), `../panels/data.ts` and
 * `../panels/validate.ts` (panel data and evidence checking), `../analysis/*`
 * (aggregate inputs) and `./retention.ts` (purges). A suite constructs one
 * against a store opened at a sandbox path — `openStore` is the only way a
 * handle exists, so the suite exercises the real DDL, the real pragmas and the
 * real migration ladder.
 *
 * The repository holds three pieces of state of its own, all bounded and in
 * memory. The connection's write ledger behind
 * {@link TelemetryRepo.captureGeneration} is kept per connection rather than
 * per repository (see {@link WriteLedger}), so two repositories over one store
 * agree. The producer-loss ledger ({@link PRODUCER_LOSS_LEDGER_CAPACITY}) and
 * the ingest arrival tracker behind {@link TelemetryRepo.captureWatermark}
 * ({@link CAPTURE_ARRIVAL_TRACKER_CAPACITY}) are kept per repository. That is
 * why the ingest path that writes events and records losses and the capture
 * stage that reads them back must share the one instance `src/main.ts` builds.
 * A second instance over the same store — a restarted service — starts with
 * both empty: it reports every capture opened before it as unaccounted, and
 * its watermarks count only the arrivals it commits itself. Beyond that,
 * statements live in the store's cache, and every other method is a pure
 * function of the database's contents.
 *
 * @param deps The store, and optionally a logger.
 * @returns The repository.
 *
 * @example
 * ```ts
 * const telemetry = createTelemetryRepo({ store, logger });
 *
 * const written = telemetry.insertMany(redactedAndAttributedEvents);
 * if (written.ok) {
 *   liveTail.broadcast(written.value.events);
 * }
 *
 * const page = telemetry.listByTrace(sessionId, traceId);
 * if (page.ok) {
 *   const tree = correlateEvents(page.value.rows);
 * }
 * ```
 */
export function createTelemetryRepo(deps: TelemetryRepoDeps): TelemetryRepo {
  const { store } = deps;
  const logger = (deps.logger ?? noopLogger).child({
    [LOG_BINDING_KEYS.subsystem]: SUBSYSTEM,
    [REPO_BINDING_KEY]: REPO,
  });
  // Shared with every other repository over this connection: see WriteLedger.
  const ledger = ledgerOf(store.db);

  /**
   * The producer-loss ledger: capture key → its entry. A `Map` iterates in
   * insertion order, and an entry is re-inserted whenever it is begun or
   * reported on, so iteration visits the least recently touched capture first
   * — the order {@link evictProducerLoss} forgets them in.
   * `node:sqlite` and this repository run on the one event-loop thread, so no
   * lock is needed.
   */
  const producerLossLedger = new Map<string, ProducerLossEntry>();

  /**
   * Brings the ledger back within {@link PRODUCER_LOSS_LEDGER_CAPACITY}: the
   * least recently touched **unbegun** entry goes first, since it could never
   * make a capture accounted, and the least recently touched begun one — a
   * capture that then reads as unaccounted — only when no unbegun entry is
   * left.
   *
   * @returns How many entries were forgotten, and how many of them were begun.
   */
  function evictProducerLoss(): { readonly evicted: number; readonly evictedAccounted: number } {
    let evicted = 0;
    let evictedAccounted = 0;

    while (producerLossLedger.size > PRODUCER_LOSS_LEDGER_CAPACITY) {
      let victim: string | undefined;

      for (const [key, entry] of producerLossLedger) {
        if (!entry.begun) {
          victim = key;
          break;
        }
      }

      // Every entry is an open capture's: the least recently touched goes.
      victim ??= producerLossLedger.keys().next().value;

      if (victim === undefined) {
        break;
      }

      if (producerLossLedger.get(victim)?.begun === true) {
        evictedAccounted += 1;
      }

      producerLossLedger.delete(victim);
      evicted += 1;
    }

    return { evicted, evictedAccounted };
  }

  /**
   * The ingest arrival tracker: capture key → the watermark of the rows
   * `insertMany` committed for it ({@link CAPTURE_ARRIVAL_TRACKER_CAPACITY}).
   * Re-inserted on every committed batch that names the capture, so iteration
   * visits the capture written to least recently first — the one
   * {@link recordArrivals} forgets once the bound is passed.
   */
  const arrivalTracker = new Map<string, CaptureIngestWatermark>();

  /**
   * Advances the arrival tracker by one committed batch, then restores its
   * bound. Called only after the batch's transaction has returned, so a batch
   * that rolled back never moves a watermark.
   *
   * @param committed Per capture key, how many rows the batch inserted and the
   * highest arrival number among them.
   * @returns How many captures were forgotten to stay within the bound.
   */
  function recordArrivals(committed: ReadonlyMap<string, CaptureIngestWatermark>): number {
    for (const [key, batch] of committed) {
      const previous = arrivalTracker.get(key) ?? NO_ARRIVALS;

      arrivalTracker.delete(key);
      arrivalTracker.set(
        key,
        Object.freeze({
          // Saturating, as every running total in this repository is.
          eventCount: Math.min(Number.MAX_SAFE_INTEGER, previous.eventCount + batch.eventCount),
          lastIngestSeq: Math.max(previous.lastIngestSeq, batch.lastIngestSeq),
        }),
      );
    }

    let evicted = 0;

    while (arrivalTracker.size > CAPTURE_ARRIVAL_TRACKER_CAPACITY) {
      const oldest = arrivalTracker.keys().next().value;

      if (oldest === undefined) {
        break;
      }

      arrivalTracker.delete(oldest);
      evicted += 1;
    }

    return evicted;
  }

  /**
   * The one read path: plan the filter, count over it, page over it, and
   * reconstruct.
   *
   * Every reader below routes through this, which is what makes their behaviour
   * identical by construction — the same refusals, the same defaults, the same
   * paging rules and the same skip-and-count policy — rather than by seven call
   * sites remembering to agree.
   *
   * The ordering table is the one thing that differs, and it is chosen by the
   * reader rather than by the caller's filter: {@link TelemetryRepo.query}, the
   * panel-data surface, passes {@link PANEL_ORDERING_BY_SORT}; every
   * convenience reader takes the default, {@link CANONICAL_ORDERING_BY_SORT},
   * the order the correlator's page walk depends on (see the module overview).
   * The one ordering a filter may ask for is the parent-first `start_asc`
   * page ({@link TelemetryQuery.parentFirst}), answered by
   * {@link readParentFirstPage} under the same refusals and the same page rules.
   *
   * @param filter What to match, how to order it and which page to return.
   * @param operation The calling method, for a refusal's `details` and logs.
   * @param orderings The row-ordering table the page is ordered by.
   * @returns The page, or the refusal for an argument the read will not accept.
   */
  function readPage(
    filter: InternalFilter,
    operation: string,
    orderings: RowOrderings = CANONICAL_ORDERING_BY_SORT,
  ): Result<TelemetryPage, DebuggenError> {
    return attempt<TelemetryPage>(operation, () => {
      const plan = buildFilter(filter, operation);

      if (isErr(plan)) {
        return plan;
      }

      const paging = buildPagePlan(filter, operation, 'start_asc');

      if (isErr(paging)) {
        return paging;
      }

      const parentFirst = resolveParentFirst(filter, paging.value.sort, operation);

      if (isErr(parentFirst)) {
        return parentFirst;
      }

      if (plan.value.kind === 'nothing') {
        // A filter narrowed to nothing is answered without a statement: an
        // empty `IN ()` list is a SQLite syntax error, and widening such a
        // filter to "everything" would be worse than either.
        return ok({ rows: [], total: 0 });
      }

      const { clause, values } = plan.value;
      const { sort, groupBy, limit, offset } = paging.value;

      if (parentFirst.value) {
        return readParentFirstPage(filter.sessionId, clause, values, limit, offset, operation);
      }

      const ordering = orderings[sort](groupBy);

      // One count over the identical WHERE clause, so `total` and `rows` can
      // never describe different filters.
      const countRow = store.statement(countRowsSql(clause)).get(...values);
      const total = readInteger(countRow?.['total']);

      if (total === undefined) {
        return err(corruptColumnError(operation, 'total'));
      }

      // `limit: 0` is a legitimate request for the count alone, and is answered
      // without touching the rows.
      const rows =
        limit === 0
          ? []
          : store
              .statement(
                `SELECT ${SELECTED} FROM ${TABLE} WHERE ${clause}
ORDER BY ${ordering} LIMIT ? OFFSET ?`,
              )
              .all(...values, limit, offset);

      const read = readEvents(rows, operation);

      if (isErr(read)) {
        return read;
      }

      return ok(finishPage(operation, read.value, total, offset, rows.length));
    });
  }

  /**
   * The page a row read yields, once its rows are reconstructed: the one tail
   * both {@link readPage} and {@link readParentFirstPage} end in, so the skip
   * report and the paging rule cannot differ between them.
   *
   * @param operation The calling method, for the skip report.
   * @param read The reconstructed events and the skipped arrival numbers.
   * @param total How many rows the filter matches in full.
   * @param offset The page's offset.
   * @param advanced How many rows the page's window covered: the statement's
   * rows, unreadable ones included.
   * @returns The page.
   */
  function finishPage(
    operation: string,
    read: ReadRows,
    total: number,
    offset: number,
    advanced: number,
  ): TelemetryPage {
    if (read.skipped.length > 0) {
      // The arrival numbers and nothing else: a row that failed validation
      // may hold any captured value, and this record is logged and may be
      // shown to a developer (AAP 0.5.2).
      logger.warn('skipped telemetry rows that no longer match the event schema', {
        operation,
        skipped: read.skipped.length,
        ingestSeqs: read.skipped,
      });
    }

    // Advanced by the rows the window covered, unreadable ones included, so a
    // skipped row cannot stall a walk. A page that read nothing — the
    // count-only `limit: 0`, or an offset at or past the end — is terminal:
    // its "next" offset would be its own, and a pager following it would never
    // advance (see TelemetryPage.nextOffset).
    const nextOffset = offset + advanced;
    const hasNextPage = advanced > 0 && nextOffset < total;

    return {
      rows: read.events,
      total,
      ...(hasNextPage ? { nextOffset } : {}),
      ...(read.skipped.length > 0 ? { skipped: read.skipped.length } : {}),
    };
  }

  /**
   * One `start_asc` page in the canonical parent-first order
   * ({@link TelemetryQuery.parentFirst}), in two statements and one in-memory
   * pass.
   *
   * 1. {@link lineageKeysSql} reads the flat lineage key of every selected row
   *    in {@link CANONICAL_ORDER_BY} — four columns, no document — and its
   *    length is `total`, so the count and the order describe one read.
   * 2. {@link parentFirstOrder} puts those rows parent before child, and the
   *    page's window `[offset, offset + limit)` is cut from that order.
   * 3. {@link rowsByIngestSeqSql} reads the window's rows by arrival number,
   *    {@link EXISTENCE_LOOKUP_CHUNK_SIZE} per statement, and they are
   *    reconstructed and validated in the window's order — the only documents
   *    the page parses.
   *
   * A row the second read no longer finds — removed by another connection
   * between the two statements — is left out and reported at `debug` by count;
   * `nextOffset` still advances by the whole window, so the walk continues
   * past it. A count-only request is the one `COUNT(*)` a flat page runs.
   *
   * @param sessionId The session the filter is scoped to.
   * @param clause The filter's `WHERE` clause.
   * @param values The filter's bound values.
   * @param limit The effective page size.
   * @param offset The effective offset.
   * @param operation The calling method, for refusals and logs.
   * @returns The page, or a column failure.
   */
  function readParentFirstPage(
    sessionId: SessionId,
    clause: string,
    values: readonly BoundValue[],
    limit: number,
    offset: number,
    operation: string,
  ): Result<TelemetryPage, DebuggenError> {
    if (limit === 0) {
      // The count alone, exactly as a flat page answers it: no key is read.
      const total = readInteger(store.statement(countRowsSql(clause)).get(...values)?.['total']);

      return total === undefined
        ? err(corruptColumnError(operation, 'total'))
        : ok({ rows: [], total });
    }

    const lineage = readLineage(store.statement(lineageKeysSql(clause)).all(...values), operation);

    if (isErr(lineage)) {
      return lineage;
    }

    const { keys, ingestSeqs } = lineage.value;
    const window: number[] = [];

    for (const rank of parentFirstOrder(keys).slice(offset, offset + limit)) {
      const ingestSeq = ingestSeqs[rank];

      if (ingestSeq !== undefined) {
        window.push(ingestSeq);
      }
    }

    const byIngestSeq = new Map<number, StoredRow>();

    for (const part of chunk(window)) {
      for (const row of store.statement(rowsByIngestSeqSql(part.length)).all(sessionId, ...part)) {
        const ingestSeq = readInteger(row['ingest_seq']);

        if (ingestSeq === undefined) {
          return err(corruptColumnError(operation, 'ingest_seq'));
        }

        byIngestSeq.set(ingestSeq, row);
      }
    }

    const rows: StoredRow[] = [];

    for (const ingestSeq of window) {
      const row = byIngestSeq.get(ingestSeq);

      if (row !== undefined) {
        rows.push(row);
      }
    }

    if (rows.length < window.length) {
      // Counts only: which rows went is another connection's business.
      logger.debug('rows of a parent-first page were removed between its two reads', {
        operation,
        removed: window.length - rows.length,
      });
    }

    const read = readEvents(rows, operation);

    if (isErr(read)) {
      return read;
    }

    return ok(finishPage(operation, read.value, keys.length, offset, window.length));
  }

  /**
   * Deletes rows one bounded batch at a time, target after target, until each
   * target's batch comes up short — the only signal that its predicate is
   * exhausted.
   *
   * Each batch is its own transaction, so the write lock is released between
   * them, and between any two batches — within one target or across two — the
   * sweep awaits `setImmediate`, which lets every callback the event loop has
   * queued run first. An ingest batch arriving mid-sweep therefore waits for one
   * batch rather than for the whole purge, whether it comes from another
   * connection or from this process (see {@link DEFAULT_PURGE_BATCH_SIZE}).
   * The first batch runs synchronously, before the caller receives the
   * promise.
   *
   * **A purge never runs inside a transaction it did not open.** Before every
   * batch — the first included — the connection is checked, and a transaction
   * already open on it refuses the purge with `STORE_ERROR` reason
   * `purge-inside-transaction`, naming how many rows earlier batches had
   * already committed. Inside a caller's transaction every batch would be a
   * savepoint of it: nothing would commit until the caller did, the write lock
   * would be held for the whole sweep, and same-process ingest would wait for
   * all of it — exactly what bounded batches exist to prevent. Checking before
   * each batch rather than once also covers a transaction opened by other work
   * while the sweep was yielding, which the batch would otherwise have joined.
   * To remove a session's telemetry atomically with the session itself, delete
   * the `sessions` row instead; its `ON DELETE CASCADE` removes these rows in
   * the same statement.
   *
   * @param operation The calling method, for the refusal's `details`.
   * @param batchSize How many rows one statement removes, already clamped.
   * @param targets One batch runner per predicate, each returning how many
   * rows one run removed.
   * @returns The total removed.
   * @throws {DebuggenError} `STORE_ERROR` with reason
   * `purge-inside-transaction`; {@link attemptAsync} turns it into an `Err`.
   */
  async function purgeInBatches(
    operation: string,
    batchSize: number,
    targets: readonly ((limit: number) => number)[],
  ): Promise<number> {
    let deleted = 0;
    let batches = 0;

    for (const deleteBatch of targets) {
      for (;;) {
        if (batches > 0) {
          await yieldToEventLoop();
        }

        if (store.db.isTransaction) {
          throw argumentError(
            operation,
            'A telemetry purge was asked to run inside an open transaction.',
            'Call the purge outside any transaction, so each bounded batch commits on its own and ingest can run between batches. To delete a session\u2019s telemetry together with the session, delete the session row instead; the cascade removes its events in the same statement.',
            'purge-inside-transaction',
            { deletedBeforeRefusal: deleted, batchesCommitted: batches },
          );
        }

        const removed = store.transaction(() => deleteBatch(batchSize));

        // Committed: the batch ran at the outermost level, since a purge
        // inside a caller's transaction was refused above. Only a batch that
        // removed a row is a change a cached aggregate must notice.
        if (removed > 0) {
          ledger.lastPurge = nextStamp(ledger);
        }

        batches += 1;
        deleted += removed;

        if (removed < batchSize) {
          break;
        }
      }
    }

    return deleted;
  }

  /**
   * The shared implementation of both existence lookups.
   *
   * @param column `'id'` or `'trace_id'` — an identifier from this module.
   * @param operation The calling method.
   * @param sessionId The session the values must belong to.
   * @param ids The values to look up.
   * @param captureId Optional capture narrowing.
   * @returns The subset that exists.
   */
  function existingValues(
    column: string,
    operation: string,
    sessionId: SessionId,
    ids: readonly string[],
    captureId?: CaptureId,
  ): Result<Set<string>, DebuggenError> {
    return attempt(operation, () => {
      const refusal =
        requireSession(sessionId, operation) ?? refuseBlank(captureId, 'captureId', operation);

      if (refusal !== undefined) {
        return err(refusal);
      }

      // De-duplicated first, so a specification citing one event twenty times
      // binds one parameter. Blank values are dropped rather than refused: the
      // columns are NOT NULL and every id this product mints is non-empty, so a
      // blank can only ever be absent — and reporting it as absent is exactly
      // what the caller needs to hear about a fabricated reference.
      const unique = [...new Set(ids)].filter((id) => id.length > 0);

      if (unique.length === 0) {
        return ok(new Set<string>());
      }

      const found = new Set<string>();

      for (const part of chunk(unique)) {
        const rows = store
          .statement(existenceSql(column, part.length, captureId !== undefined))
          .all(
            ...(captureId === undefined ? [sessionId, ...part] : [sessionId, captureId, ...part]),
          );

        for (const row of rows) {
          const value = row[column];

          if (typeof value !== 'string') {
            return err(corruptColumnError(operation, column));
          }

          found.add(value);
        }
      }

      return ok(found);
    });
  }

  /**
   * Turns a subset lookup into the partition `packages/panel-schema`'s semantic
   * validator consumes.
   *
   * The complement is computed here rather than by the caller so that "known"
   * and "unknown" are always derived from the same input list — a caller
   * rebuilding the complement from a different array is how a stored event ends
   * up reported as fabricated.
   */
  function partition(
    lookup: Result<Set<string>, DebuggenError>,
    ids: readonly string[],
  ): Result<IdResolution, DebuggenError> {
    if (isErr(lookup)) {
      return lookup;
    }

    const known = lookup.value;
    const unknown = new Set<string>();

    for (const id of ids) {
      if (!known.has(id)) {
        unknown.add(id);
      }
    }

    return ok({ known, unknown });
  }

  return {
    insertMany(events) {
      const operation = 'insertMany';
      const batchSize = events.length;

      if (batchSize === 0) {
        // No statement, no transaction, no log line: an empty batch is what the
        // ingest path hands over when a producer flushed nothing, and it is not
        // an event worth recording.
        return ok({ events: [], inserted: 0, skipped: 0 });
      }

      // Validated before anything is written, and before a transaction is even
      // opened: a row no later read could reconstruct must never reach the
      // table, and a refusal must leave the batch entirely unwritten. The probe
      // arrival number stands in for the one the database assigns below.
      const validated: TelemetryEvent[] = [];

      for (const [index, candidate] of events.entries()) {
        const parsed = parseTelemetryEvent({
          ...candidate,
          ingestSeq: VALIDATION_PROBE_INGEST_SEQ,
        });

        if (isErr(parsed)) {
          return err(invalidEventError(index, batchSize, parsed.error));
        }

        validated.push(parsed.value);
      }

      return attempt(
        operation,
        () => {
          const insert = store.statement(INSERT_SQL);
          const lookup = store.statement(SELECT_STORED_BY_ID_SQL);
          const ownerLookup = store.statement(SELECT_CAPTURE_OWNER_SQL);
          // The ledger keys of the captures that received at least one row.
          // Filled inside the transaction and only recorded once it returns,
          // so a batch that rolled back records nothing.
          const writtenCaptures = new Set<string>();

          // Per capture, the rows this batch inserted and their highest
          // arrival number — the arrival tracker's input. Gathered inside the
          // transaction, applied only once it has returned.
          const arrived = new Map<string, CaptureIngestWatermark>();

          // One transaction for the whole batch, and one prepared statement
          // reused per row: an ingest batch is the hot path of a running
          // capture, and a per-row transaction would fsync per event.
          const result = store.transaction<InsertTelemetryResult>(() => {
            const stored: TelemetryEvent[] = [];
            let inserted = 0;
            let skipped = 0;

            // The owning session of each capture this batch names, read once
            // per capture: `null` records a capture the store does not hold.
            // Local to this transaction on purpose — a capture's owner is
            // only known to be current inside the transaction that read it.
            const owners = new Map<string, string | null>();

            const ownerOf = (captureId: string): string | null => {
              const known = owners.get(captureId);

              if (known !== undefined) {
                return known;
              }

              const row = ownerLookup.get(captureId);
              let owner: string | null = null;

              if (row !== undefined) {
                const column = row['session_id'];

                if (typeof column !== 'string') {
                  throw corruptColumnError(operation, 'session_id');
                }

                owner = column;
              }

              owners.set(captureId, owner);

              return owner;
            };

            for (const [index, event] of validated.entries()) {
              // Checked before the element is written, inside the transaction
              // that writes it, so the check and the write are atomic. A
              // capture of another session throws, and the throw rolls back
              // every element written before it. A capture the store does not
              // hold at all is left to the `capture_id` foreign key, which
              // refuses it as `unknown-attribution` — one classification for
              // one condition, whichever path meets it first.
              const owner = ownerOf(event.captureId);

              if (owner !== null && owner !== event.sessionId) {
                throw captureOwnershipError(index, batchSize, event.sessionId, event.captureId);
              }

              const written = insert.get(...insertValues(event, toStoredDocument(event)));

              if (written === undefined) {
                // The conflict clause suppressed the insert: this id is already
                // stored — by an earlier batch, or by an earlier element of this
                // one. It is a replay only if the stored event is this event,
                // and the result then carries the stored copy with its own
                // arrival number; anything else throws, and the throw rolls the
                // whole batch back.
                stored.push(resolveReplay(lookup.get(event.id), event, operation));
                skipped += 1;
                continue;
              }

              const ingestSeq = readInteger(written['ingest_seq']);

              if (ingestSeq === undefined) {
                throw corruptColumnError(operation, 'ingest_seq');
              }

              inserted += 1;
              stored.push({ ...event, ingestSeq });
              // A replay was skipped above, so only a new row is an arrival.
              const key = captureKey(event.sessionId, event.captureId);
              const sofar = arrived.get(key) ?? NO_ARRIVALS;

              writtenCaptures.add(key);
              arrived.set(key, {
                eventCount: sofar.eventCount + 1,
                lastIngestSeq: Math.max(sofar.lastIngestSeq, ingestSeq),
              });
            }

            return { events: stored, inserted, skipped };
          });

          // A transaction still open now is the caller's: this batch was a
          // savepoint inside it, and its rows commit or roll back with it.
          const commitPending = store.db.isTransaction;

          // A replay that stored nothing leaves the ledger as it was: the
          // capture's rows did not change.
          for (const key of writtenCaptures) {
            ledger.lastWrite.set(key, nextStamp(ledger));

            if (commitPending) {
              ledger.unsettled.add(key);
            }
          }

          // Committed — or, when a caller runs this inside its own
          // transaction, released to it; an enclosing rollback after this
          // point leaves the watermark ahead of the store, which the barrier
          // reads as movement and so only ever waits longer for.
          const arrivalsEvicted = recordArrivals(arrived);

          logger.debug('stored a telemetry batch', {
            operation,
            batchSize,
            inserted: result.inserted,
            skipped: result.skipped,
            ...(arrivalsEvicted > 0 ? { arrivalsEvicted } : {}),
          });

          return ok(result);
        },
        { batchSize },
      );
    },

    query(filter) {
      // The panel-data surface: ordered by the sort's key, then the event id.
      return readPage(filter, 'query', PANEL_ORDERING_BY_SORT);
    },

    scanEvents(filter, maxRows) {
      const operation = 'scanEvents';

      return attempt<TelemetryScan>(operation, () => {
        // The filter first, through the planner `query` uses, so a scan and a
        // page refuse the same filters with the same reasons.
        const plan = buildFilter(filter, operation);

        if (isErr(plan)) {
          return plan;
        }

        if (!isWholeNumber(maxRows)) {
          return err(
            argumentError(
              operation,
              'A telemetry scan named a row ceiling that is not a whole number of rows.',
              'Pass an integer of zero or more: the most events the caller will take from one scan.',
              'invalid-max-rows',
            ),
          );
        }

        if (plan.value.kind === 'nothing') {
          // No statement, for the reason readPage gives: an empty `IN ()` list
          // is a syntax error, and the selection is empty by definition.
          return ok({ rows: [], total: 0, complete: true });
        }

        const { clause, values } = plan.value;
        const total = readInteger(store.statement(countRowsSql(clause)).get(...values)?.['total']);

        if (total === undefined) {
          return err(corruptColumnError(operation, 'total'));
        }

        if (total > maxRows) {
          // Larger than the caller will hold: answered from the count alone,
          // without reading or parsing a row.
          logger.debug('a telemetry scan exceeded its row ceiling', { operation, total, maxRows });

          return ok({ rows: [], total, complete: false });
        }

        if (maxRows === 0) {
          // The count-only request, and the count is zero.
          return ok({ rows: [], total: 0, complete: true });
        }

        const events: TelemetryEvent[] = [];
        const skipped: number[] = [];
        let pending: StoredRow[] = [];
        let met = 0;

        // Reconstructs the buffered raw rows and releases them, so at most one
        // chunk of raw rows is alive at a time however large the selection.
        const drain = (): DebuggenError | undefined => {
          const read = readEvents(pending, operation);

          pending = [];

          if (isErr(read)) {
            return read.error;
          }

          events.push(...read.value.events);
          skipped.push(...read.value.skipped);

          return undefined;
        };

        // One ordered traversal, bounded one row past the ceiling. Leaving the
        // loop early — the ceiling crossed, or a column failure — returns the
        // iterator, which resets the statement.
        for (const row of store.statement(scanRowsSql(clause)).iterate(...values, maxRows + 1)) {
          met += 1;

          if (met > maxRows) {
            // Another connection stored rows between the count and this read:
            // the selection is larger than the caller will hold after all.
            logger.debug('a telemetry scan outgrew its row ceiling while it read', {
              operation,
              counted: total,
              met,
              maxRows,
            });

            return ok({ rows: [], total: met, complete: false });
          }

          pending.push(row);

          if (pending.length === TELEMETRY_QUERY_MAX_LIMIT) {
            const failure = drain();

            if (failure !== undefined) {
              return err(failure);
            }
          }
        }

        const failure = drain();

        if (failure !== undefined) {
          return err(failure);
        }

        if (skipped.length > 0) {
          // The arrival numbers and nothing else, as on a row page (AAP 0.5.2).
          logger.warn('skipped telemetry rows that no longer match the event schema', {
            operation,
            skipped: skipped.length,
            ingestSeqs: skipped,
          });
        }

        // `met` rather than the count: rows another connection removed between
        // the two statements were never read, and `total` must agree with
        // `rows` plus `skipped`.
        return ok({
          rows: events,
          total: met,
          complete: true,
          ...(skipped.length > 0 ? { skipped: skipped.length } : {}),
        });
      });
    },

    queryGroups(query) {
      const operation = 'queryGroups';

      return attempt<TelemetryGroupPage>(operation, () => {
        // Checked before the page plan, which would otherwise fill in the row
        // default: a page of groups under a key the caller never chose is an
        // answer to a question nobody asked.
        const named: unknown = query.groupBy;

        if (named === undefined) {
          return err(
            argumentError(
              operation,
              'A grouped telemetry query named no group key.',
              `Name the key to group by, one of: ${TELEMETRY_GROUP_KEYS.join(', ')}.`,
              'missing-group-key',
            ),
          );
        }

        const plan = buildFilter(query, operation);

        if (isErr(plan)) {
          return plan;
        }

        const paging = buildPagePlan(query, operation, 'count_desc');

        if (isErr(paging)) {
          return paging;
        }

        if (plan.value.kind === 'nothing') {
          return ok({ groups: [], total: 0 });
        }

        const { clause, values } = plan.value;
        const { sort, groupBy, limit, offset } = paging.value;

        // Every group is formed from readable events only, so the whole
        // filtered set is folded before the page is cut: `total`, each count
        // and each representative then describe the same, readable events,
        // and `limit: 0` still answers with the true number of groups.
        const collected = collectGroups(
          store.statement(groupRowsSql(groupBy, clause)).all(...values),
          operation,
        );

        if (isErr(collected)) {
          return collected;
        }

        const { skipped } = collected.value;

        if (skipped.length > 0) {
          // The arrival numbers and nothing else, as on a row page: a row that
          // failed validation may hold any captured value (AAP 0.5.2).
          logger.warn(
            'left telemetry rows that no longer match the event schema out of every group',
            {
              operation,
              skipped: skipped.length,
              ingestSeqs: skipped,
            },
          );
        }

        const ordered = collected.value.groups.sort(GROUP_ORDERING_BY_SORT[sort]);
        const total = ordered.length;
        const groups = ordered.slice(offset, offset + limit);
        // The same terminal rule as a row page, applied here independently: a
        // page of no groups — the count-only `limit: 0` included — would
        // otherwise point at its own offset (see TelemetryGroupPage.nextOffset).
        const nextOffset = offset + groups.length;
        const hasNextPage = groups.length > 0 && nextOffset < total;

        return ok({
          groups,
          total,
          ...(hasNextPage ? { nextOffset } : {}),
          ...(skipped.length > 0 ? { skipped: skipped.length } : {}),
        });
      });
    },

    listByTrace(sessionId, traceId, options) {
      return readPage({ ...options, sessionId, traceId }, 'listByTrace');
    },

    listByCapture(sessionId, captureId, options) {
      return readPage({ ...options, sessionId, captureId }, 'listByCapture');
    },

    pageCaptureForSummary(sessionId, captureId, options) {
      const operation = 'pageCaptureForSummary';

      return attempt<CaptureSummaryPage>(operation, () => {
        const refusal =
          requireSession(sessionId, operation) ?? requireCapture(captureId, operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        const { limit: requestedLimit, offset } = options;

        if (!isWholeNumber(requestedLimit)) {
          return err(
            argumentError(
              operation,
              'A capture summary page named a page size that is not a whole number of rows.',
              'Pass an integer of zero or more.',
              'invalid-limit',
            ),
          );
        }

        if (!isWholeNumber(offset)) {
          return err(
            argumentError(
              operation,
              'A capture summary page named an offset that is not a whole number of rows.',
              'Pass an integer of zero or more; 0 starts at the first row of the capture.',
              'invalid-offset',
            ),
          );
        }

        // Clamped rather than refused, the policy of every row page.
        const limit = Math.min(requestedLimit, TELEMETRY_QUERY_MAX_LIMIT);

        if (limit === 0) {
          return ok({ rows: [], rowsRead: 0, skipped: 0, storedChars: 0 });
        }

        const rows = store
          .statement(SELECT_CAPTURE_SUMMARY_PAGE_SQL)
          .all(sessionId, captureId, limit, offset);

        // The size of what was read, taken from the documents the read already
        // holds — unreadable rows included, since they were read all the same.
        let storedChars = 0;

        for (const row of rows) {
          const document = row['event'];

          if (typeof document === 'string') {
            storedChars += document.length;
          }
        }

        const read = readEvents(rows, operation);

        if (isErr(read)) {
          return read;
        }

        if (read.value.skipped.length > 0) {
          // The arrival numbers and nothing else, as on a row page (AAP 0.5.2).
          logger.warn('skipped telemetry rows that no longer match the event schema', {
            operation,
            skipped: read.value.skipped.length,
            ingestSeqs: read.value.skipped,
          });
        }

        return ok({
          rows: read.value.events,
          rowsRead: rows.length,
          skipped: read.value.skipped.length,
          storedChars,
          ...(rows.length === limit ? { nextOffset: offset + rows.length } : {}),
        });
      });
    },

    listByRequestKey(sessionId, requestKey, options) {
      return readPage({ ...options, sessionId, requestKey }, 'listByRequestKey');
    },

    listChildren(sessionId, parentSpanId, options) {
      return readPage({ ...options, sessionId, parentSpanId }, 'listChildren');
    },

    getBySpanId(sessionId, spanId) {
      const page = readPage({ sessionId, spanId, limit: 1, sort: 'start_asc' }, 'getBySpanId');

      if (isErr(page)) {
        return page;
      }

      // `undefined` covers both "no such span" and "the one row no longer
      // validates" — the second having already been reported at `warn` by the
      // read path, which is the graceful reading: a single unreadable row must
      // not fail a lookup the panel made to draw one chip.
      return ok(page.value.rows[0]);
    },

    listTraceIds(sessionId, captureId) {
      const operation = 'listTraceIds';

      return attempt(operation, () => {
        const refusal =
          requireSession(sessionId, operation) ?? refuseBlank(captureId, 'captureId', operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        const rows =
          captureId === undefined
            ? store.statement(SELECT_TRACE_IDS_SQL).all(sessionId)
            : store.statement(SELECT_TRACE_IDS_BY_CAPTURE_SQL).all(sessionId, captureId);

        const traceIds: string[] = [];

        for (const row of rows) {
          const traceId = row['trace_id'];

          if (typeof traceId !== 'string') {
            return err(corruptColumnError(operation, 'trace_id'));
          }

          traceIds.push(traceId);
        }

        return ok(traceIds);
      });
    },

    firstTraceId(sessionId, captureId) {
      const operation = 'firstTraceId';

      return attempt(operation, () => {
        const refusal =
          requireSession(sessionId, operation) ?? refuseBlank(captureId, 'captureId', operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        const row =
          captureId === undefined
            ? store.statement(SELECT_FIRST_TRACE_ID_SQL).get(sessionId)
            : store.statement(SELECT_FIRST_TRACE_ID_BY_CAPTURE_SQL).get(sessionId, captureId);

        // `LIMIT 1` answers no row when the scope holds no event.
        if (row === undefined) {
          return ok(undefined);
        }

        const traceId = row['trace_id'];

        // `trace_id` is NOT NULL, so anything but text — NULL included — is a
        // row this build did not write.
        if (typeof traceId !== 'string') {
          return err(corruptColumnError(operation, 'trace_id'));
        }

        return ok(traceId);
      });
    },

    countByKind(sessionId, captureId) {
      const operation = 'countByKind';

      return attempt(operation, () => {
        const refusal =
          requireSession(sessionId, operation) ?? refuseBlank(captureId, 'captureId', operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        const rows =
          captureId === undefined
            ? store.statement(COUNT_BY_KIND_SQL).all(sessionId)
            : store.statement(COUNT_BY_KIND_BY_CAPTURE_SQL).all(sessionId, captureId);

        const counts = zeroFilledKindCounts();
        let outsideVocabulary = 0;

        for (const row of rows) {
          const kind = row['kind'];
          const total = readInteger(row['total']);

          if (typeof kind !== 'string') {
            return err(corruptColumnError(operation, 'kind'));
          }

          if (total === undefined) {
            return err(corruptColumnError(operation, 'total'));
          }

          if (!isTelemetryKind(kind)) {
            // The column carries no CHECK — the kind vocabulary lives once, in
            // the telemetry package, and is enforced by parsing on the write
            // path — so a row like this can only come from a database written
            // by another build. Counted nowhere and reported once, rather than
            // widening the returned record to a key no consumer can handle.
            outsideVocabulary += total;
            continue;
          }

          counts[kind] = total;
        }

        if (outsideVocabulary > 0) {
          logger.warn('ignored telemetry rows whose kind is outside the vocabulary', {
            operation,
            ignored: outsideVocabulary,
          });
        }

        return ok(counts);
      });
    },

    captureStamp(sessionId, captureId) {
      const operation = 'captureStamp';

      return attempt(operation, () => {
        const refusal =
          requireSession(sessionId, operation) ?? requireCapture(captureId, operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        const row = store.statement(SELECT_CAPTURE_STAMP_SQL).get(sessionId, captureId);
        const count = readInteger(row?.['total']);
        const maxIngestSeq = readInteger(row?.['max_seq']);

        if (count === undefined || !isWholeNumber(count)) {
          return err(corruptColumnError(operation, 'total'));
        }

        if (maxIngestSeq === undefined || !isWholeNumber(maxIngestSeq)) {
          return err(corruptColumnError(operation, 'ingest_seq'));
        }

        return ok({ count, maxIngestSeq });
      });
    },

    captureGeneration(sessionId, captureId) {
      const operation = 'captureGeneration';

      return attempt(operation, () => {
        const refusal =
          requireSession(sessionId, operation) ?? requireCapture(captureId, operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        // Prepared first: `Store.statement` is what refuses a closed handle
        // with the store's own coded error, before the connection is touched.
        const row = store.statement(DATA_VERSION_SQL).get();

        if (ledger.unsettled.size > 0 && !store.db.isTransaction) {
          // The transaction those batches ran inside has ended, committed or
          // rolled back: either way the captures' rows may differ from what a
          // generation read while it was open described, so each is stamped
          // anew and every such generation stops validating.
          for (const key of ledger.unsettled) {
            ledger.lastWrite.set(key, nextStamp(ledger));
          }

          ledger.unsettled.clear();
        }

        const dataVersion = readInteger(row?.['data_version']);

        if (dataVersion === undefined || !Number.isSafeInteger(dataVersion)) {
          return err(corruptColumnError(operation, 'data_version'));
        }

        return ok({
          dataVersion,
          purges: ledger.lastPurge,
          writes: ledger.lastWrite.get(captureKey(sessionId, captureId)) ?? 0,
        });
      });
    },

    listProducerClockOffsets(sessionId, options) {
      const operation = 'listProducerClockOffsets';

      return attempt<readonly ProducerClockOffset[]>(operation, () => {
        // Read inside `attempt`, so even a malformed options value from a
        // JavaScript caller answers with a `Result` rather than a throw.
        const captureId = options?.captureId;
        const refusal =
          requireSession(sessionId, operation) ?? refuseBlank(captureId, 'captureId', operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        // One row past the bound, so a truncation is known rather than guessed.
        const fetchLimit = MAX_PRODUCER_CLOCK_OFFSETS + 1;
        const rows =
          captureId === undefined
            ? store.statement(SELECT_PRODUCER_CLOCK_OFFSETS_SQL).all(sessionId, fetchLimit)
            : store
                .statement(SELECT_PRODUCER_CLOCK_OFFSETS_BY_CAPTURE_SQL)
                .all(sessionId, captureId, fetchLimit);

        const offsets: ProducerClockOffset[] = [];

        for (const row of rows.slice(0, MAX_PRODUCER_CLOCK_OFFSETS)) {
          const rowCaptureId = row['capture_id'];
          const producerId = row['producer_id'];

          if (typeof rowCaptureId !== 'string' || rowCaptureId.length === 0) {
            return err(corruptColumnError(operation, 'capture_id'));
          }

          if (typeof producerId !== 'string' || producerId.length === 0) {
            return err(corruptColumnError(operation, 'producer_id'));
          }

          const tiers = readTiers(row['tiers']);

          if (tiers === undefined) {
            return err(corruptColumnError(operation, 'tier'));
          }

          const clockOffsetMs = readClockOffset(row['clock_offset_ms']);
          const minClockOffsetMs = readClockOffset(row['min_clock_offset_ms']);
          const maxClockOffsetMs = readClockOffset(row['max_clock_offset_ms']);

          if (
            clockOffsetMs === undefined ||
            minClockOffsetMs === undefined ||
            maxClockOffsetMs === undefined
          ) {
            return err(corruptColumnError(operation, 'clock_offset_ms'));
          }

          const reportingEvents = readPositiveInteger(row['reporting_events']);

          if (reportingEvents === undefined) {
            return err(corruptColumnError(operation, 'reporting_events'));
          }

          const firstIngestSeq = readPositiveInteger(row['first_ingest_seq']);
          const lastIngestSeq = readPositiveInteger(row['last_ingest_seq']);

          if (firstIngestSeq === undefined || lastIngestSeq === undefined) {
            return err(corruptColumnError(operation, 'ingest_seq'));
          }

          offsets.push(
            Object.freeze({
              captureId: rowCaptureId,
              producerId,
              tiers,
              clockOffsetMs,
              minClockOffsetMs,
              maxClockOffsetMs,
              reportingEvents,
              firstIngestSeq,
              lastIngestSeq,
            }),
          );
        }

        if (rows.length > MAX_PRODUCER_CLOCK_OFFSETS) {
          logger.warn('more producers reported a clock offset than one read lists', {
            operation,
            [LOG_BINDING_KEYS.sessionId]: sessionId,
            listed: MAX_PRODUCER_CLOCK_OFFSETS,
          });
        }

        return ok(Object.freeze(offsets));
      });
    },

    existingEventIds(sessionId, ids, captureId) {
      return existingValues('id', 'existingEventIds', sessionId, ids, captureId);
    },

    existingTraceIds(sessionId, ids, captureId) {
      return existingValues('trace_id', 'existingTraceIds', sessionId, ids, captureId);
    },

    partitionKnownEventIds(sessionId, ids, captureId) {
      return partition(
        existingValues('id', 'partitionKnownEventIds', sessionId, ids, captureId),
        ids,
      );
    },

    partitionKnownTraceIds(sessionId, ids, captureId) {
      return partition(
        existingValues('trace_id', 'partitionKnownTraceIds', sessionId, ids, captureId),
        ids,
      );
    },

    countBySession(sessionId) {
      const operation = 'countBySession';

      return attempt(operation, () => {
        const refusal = requireSession(sessionId, operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        const row = store.statement(COUNT_BY_SESSION_SQL).get(sessionId);
        const total = readInteger(row?.['total']);

        if (total === undefined) {
          return err(corruptColumnError(operation, 'total'));
        }

        return ok(total);
      });
    },

    captureWatermark(sessionId, captureId) {
      const operation = 'captureWatermark';

      return attempt(operation, () => {
        const refusal =
          requireSession(sessionId, operation) ?? requireCapture(captureId, operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        // No statement: the tracker is advanced by `insertMany` after each
        // commit, so this read costs one lookup however much the capture holds.
        return ok(arrivalTracker.get(captureKey(sessionId, captureId)) ?? NO_ARRIVALS);
      });
    },

    recordProducerLoss(report) {
      const operation = 'recordProducerLoss';

      return attempt(operation, () => {
        const { sessionId, captureId, producerId, droppedEvents } = report;
        const refusal =
          requireSession(sessionId, operation) ??
          requireCapture(captureId, operation) ??
          refuseBlank(producerId, 'producerId', operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        if (!isWholeNumber(droppedEvents)) {
          return err(
            argumentError(
              operation,
              'A producer-loss report carried a count that is not a number of events.',
              'Report the discarded events as a whole number from 0 within the safe-integer range.',
              'invalid-dropped-count',
            ),
          );
        }

        const key = captureKey(sessionId, captureId);
        const previous = producerLossLedger.get(key);

        if (droppedEvents === 0) {
          return ok(previous?.droppedEvents ?? 0);
        }

        // Saturating, so a total can never lose precision past the safe range.
        const total = Math.min(
          Number.MAX_SAFE_INTEGER,
          (previous?.droppedEvents ?? 0) + droppedEvents,
        );
        // A capture with no begun entry — accounting never began in this
        // process, or its entry was forgotten — is recorded as a partial
        // entry: a lower bound that never makes the capture accounted.
        const begun = previous?.begun === true;

        // Re-inserted so the capture becomes the most recently touched, then
        // the bound is restored.
        producerLossLedger.delete(key);
        producerLossLedger.set(key, { droppedEvents: total, begun });

        const { evicted, evictedAccounted } = evictProducerLoss();

        logger.info('recorded a producer loss report', {
          operation,
          [LOG_BINDING_KEYS.sessionId]: sessionId,
          [LOG_BINDING_KEYS.captureId]: captureId,
          ...(producerId === undefined ? {} : { producerId }),
          droppedEvents,
          total,
          accounted: begun,
          ...(evicted > 0 ? { evicted } : {}),
          ...(evictedAccounted > 0 ? { evictedAccounted } : {}),
        });

        return ok(total);
      });
    },

    producerLoss(sessionId, captureId) {
      const operation = 'producerLoss';

      return attempt<ProducerLossTotal>(operation, () => {
        const refusal =
          requireSession(sessionId, operation) ?? requireCapture(captureId, operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        const entry = producerLossLedger.get(captureKey(sessionId, captureId));

        return ok(
          Object.freeze({
            droppedEvents: entry?.droppedEvents ?? 0,
            accounted: entry?.begun === true,
          }),
        );
      });
    },

    beginProducerLossAccounting(sessionId, captureId) {
      const operation = 'beginProducerLossAccounting';

      return attempt<void>(operation, () => {
        const refusal =
          requireSession(sessionId, operation) ?? requireCapture(captureId, operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        const key = captureKey(sessionId, captureId);
        const previous = producerLossLedger.get(key);

        // Adopted rather than reset: a capture id is fresh when its window
        // opens, so a report already recorded for it arrived after the opening.
        producerLossLedger.delete(key);
        producerLossLedger.set(key, { droppedEvents: previous?.droppedEvents ?? 0, begun: true });

        const { evicted, evictedAccounted } = evictProducerLoss();

        logger.debug('began producer loss accounting for a capture', {
          operation,
          [LOG_BINDING_KEYS.sessionId]: sessionId,
          [LOG_BINDING_KEYS.captureId]: captureId,
          ...(previous === undefined ? {} : { adopted: previous.droppedEvents }),
          ...(evicted > 0 ? { evicted } : {}),
          ...(evictedAccounted > 0 ? { evictedAccounted } : {}),
        });

        if (evictedAccounted > 0) {
          // Only reachable with more begun entries than the bound: each
          // evicted capture now reads as unaccounted, which is the truthful
          // answer, whether its window is still open or was closed elsewhere.
          logger.warn('forgot the producer loss accounting of a begun capture', {
            operation,
            evictedAccounted,
            capacity: PRODUCER_LOSS_LEDGER_CAPACITY,
          });
        }

        return ok(undefined);
      });
    },

    releaseProducerLoss(sessionId, captureId) {
      const operation = 'releaseProducerLoss';

      return attempt<void>(operation, () => {
        const refusal =
          requireSession(sessionId, operation) ?? requireCapture(captureId, operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        const key = captureKey(sessionId, captureId);
        const released = producerLossLedger.delete(key);
        const releasedArrivals = arrivalTracker.delete(key);

        logger.debug('released the producer loss accounting of a capture', {
          operation,
          [LOG_BINDING_KEYS.sessionId]: sessionId,
          [LOG_BINDING_KEYS.captureId]: captureId,
          released,
          releasedArrivals,
        });

        return ok(undefined);
      });
    },

    deleteBySession(sessionId) {
      const operation = 'deleteBySession';

      return attemptAsync<number>(operation, async () => {
        const refusal = requireSession(sessionId, operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        const statement = store.statement(DELETE_SESSION_BATCH_SQL);
        const deleted = await purgeInBatches(operation, DEFAULT_PURGE_BATCH_SIZE, [
          (limit) => changesOf(statement.run(sessionId, limit)),
        ]);

        logger.debug('purged a session of telemetry', {
          operation,
          [LOG_BINDING_KEYS.sessionId]: sessionId,
          deleted,
        });

        return ok(deleted);
      });
    },

    deleteOlderThan(cutoffEpochMs, options) {
      const operation = 'deleteOlderThan';

      return attemptAsync<number>(operation, async () => {
        if (!Number.isFinite(cutoffEpochMs)) {
          return err(
            argumentError(
              operation,
              'A telemetry purge named a cutoff that is not a time.',
              'Pass the cutoff in Unix epoch milliseconds, for example Date.now() minus the retention window.',
              'invalid-cutoff',
            ),
          );
        }

        const requestedBatchSize = options?.batchSize ?? DEFAULT_PURGE_BATCH_SIZE;

        if (!Number.isSafeInteger(requestedBatchSize) || requestedBatchSize < 1) {
          return err(
            argumentError(
              operation,
              'A telemetry purge named a batch size that cannot bound a statement.',
              `Pass a positive integer of at most ${String(MAX_PURGE_BATCH_SIZE)}, or omit the field for ${String(DEFAULT_PURGE_BATCH_SIZE)} rows per batch.`,
              'invalid-batch-size',
            ),
          );
        }

        // Clamped, not refused: see MAX_PURGE_BATCH_SIZE. The effective value is
        // what the debug line reports, so a clamp is visible in the log.
        const batchSize = Math.min(requestedBatchSize, MAX_PURGE_BATCH_SIZE);
        const sessionIds = options?.sessionIds;

        if (sessionIds === undefined) {
          const statement = store.statement(DELETE_OLDER_THAN_BATCH_SQL);
          const deleted = await purgeInBatches(operation, batchSize, [
            (limit) => changesOf(statement.run(cutoffEpochMs, limit)),
          ]);

          logger.debug('purged telemetry older than a cutoff', { operation, batchSize, deleted });

          return ok(deleted);
        }

        for (const sessionId of sessionIds) {
          if (sessionId.length === 0) {
            return err(
              argumentError(
                operation,
                'A telemetry purge named an empty session id.',
                'Remove the empty entry, or omit sessionIds to purge every session.',
                'blank-session-id',
              ),
            );
          }
        }

        const unique = [...new Set(sessionIds)];

        if (unique.length === 0) {
          // A narrowed-to-nothing selection deletes nothing, for the same
          // reason an empty `kinds` filter matches nothing.
          return ok(0);
        }

        // One session at a time, through one prepared statement: each batch is
        // then an ordered range of the (session_id, start_time, ingest_seq)
        // index, which an IN list of sessions could not be (see
        // DELETE_SESSION_OLDER_THAN_BATCH_SQL). The statement text and its
        // parameter count no longer depend on how many sessions are named.
        const statement = store.statement(DELETE_SESSION_OLDER_THAN_BATCH_SQL);
        const deleted = await purgeInBatches(
          operation,
          batchSize,
          unique.map(
            (sessionId) => (limit: number) =>
              changesOf(statement.run(sessionId, cutoffEpochMs, limit)),
          ),
        );

        logger.debug('purged telemetry older than a cutoff', {
          operation,
          batchSize,
          sessions: unique.length,
          deleted,
        });

        return ok(deleted);
      });
    },
  };
}
