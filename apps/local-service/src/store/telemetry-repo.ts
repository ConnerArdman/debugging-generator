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
 * ## The ordering contract, and the half of it this module owns
 *
 * AAP 0.2.3 fixes the canonical order of a capture as **parent before child,
 * then `startTime`, then `(producerId, seq)`, then `ingestSeq`**. The work is
 * split, deliberately:
 *
 * - **This module guarantees a deterministic total order** over rows —
 *   {@link CANONICAL_ORDER_BY} — whose last key, the store-assigned
 *   `ingest_seq`, can never tie. That is what makes a page of results
 *   reproducible between two requests, and what makes `limit`/`offset` paging
 *   coherent rather than a lottery over equal timestamps.
 * - **Parent-before-child is a property of the tree**, established by
 *   `packages/telemetry/src/correlation/correlator.ts` when it nests events by
 *   `(traceId, parentSpanId)` and walks the result depth-first. It is not
 *   attempted here: a recursive SQL ordering would duplicate that logic in a
 *   second language, and it would be wrong in the one case that matters, where
 *   a server span's clock reads slightly earlier than the browser span that
 *   caused it (AAP 0.2.3 records a per-producer offset as informational rather
 *   than aligning the clocks).
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
 * `ingest_seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so the database assigns
 * it and never reuses a value — not even after a retention purge, which is what
 * keeps the ordering sound across the lifetime of a database (see
 * {@link TelemetryRepo.deleteOlderThan}). A replay that conflicts on `id` does
 * consume a sequence value, so gaps are ordinary; only the relative order of
 * the numbers is meaningful.
 *
 * ## What this module does not do
 *
 * It returns rows and counts. Aggregation lives in
 * `packages/telemetry/src/aggregate/*` — render statistics, request and query
 * groups, timeline lanes, the component tree snapshot and the metric set — and
 * `../panels/data.ts` is what maps a panel's `DataQuery` onto this repository
 * plus those aggregates. A render or request aggregate computed here would be a
 * second implementation of a shape a panel already validates against, so there
 * is none.
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

import { DATA_QUERY_DEFAULT_LIMIT, DATA_QUERY_MAX_LIMIT } from '@debuggen/panel-schema';
import type { IdResolution } from '@debuggen/panel-schema';
import { DebuggenError, err, isErr, noopLogger, ok } from '@debuggen/shared';
import type { CaptureId, Logger, Result, SessionId } from '@debuggen/shared';
import {
  FETCH_ATTRIBUTE_KEYS,
  RENDER_ATTRIBUTE_KEYS,
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
  TELEMETRY_KINDS,
  TELEMETRY_TIERS,
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
 * The store's total order over telemetry rows: `startTime`, then the emitting
 * producer, then that producer's own sequence number, then the arrival number
 * that can never tie.
 *
 * Exported so there is exactly one definition of it — every ordered read below
 * ends in this chain, and a suite asserts the order against
 * `compareEventsCanonical` rather than restating the keys.
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
 * What it deliberately does not do: nest children under parents. That is the
 * tree's shape, applied by the correlator — see this module's overview.
 */
export const CANONICAL_ORDER_BY = 'start_time ASC, producer_id ASC, seq ASC, ingest_seq ASC';

/**
 * The slowest-first ordering, with the canonical chain as its tie-break.
 *
 * The chain is not decoration: a latency panel pages through "slowest
 * operations", and two spans of identical duration are common (a zero-duration
 * `state` transition, a cached request). Without a total order behind
 * `duration DESC`, the same row could appear on two pages or on none.
 */
export const DURATION_DESC_ORDER_BY = `duration DESC, ${CANONICAL_ORDER_BY}`;

/**
 * The orderings a caller may ask for, and the `ORDER BY` clause each maps to.
 *
 * Both members are `DataQuerySort` values from `@debuggen/panel-schema`, which
 * is what lets `../panels/data.ts` forward a panel node's `sort` field
 * unchanged. That vocabulary's third member, `count_desc`, is absent on
 * purpose: it orders *aggregates* by occurrence count, which this row store
 * does not compute (see this module's overview), and accepting it here would
 * answer a caller with rows sorted by something they did not ask for.
 */
const ORDERING_BY_SORT: Readonly<Record<TelemetrySort, string>> = Object.freeze({
  start_asc: CANONICAL_ORDER_BY,
  duration_desc: DURATION_DESC_ORDER_BY,
});

/**
 * The sort values {@link TelemetryQuery.sort} accepts, as a tuple, for the
 * message of a refusal and for a suite that wants to exercise each one.
 */
export const TELEMETRY_SORTS: readonly TelemetrySort[] = Object.freeze([
  'start_asc',
  'duration_desc',
]);

/** How a page of telemetry rows may be ordered. */
export type TelemetrySort = 'start_asc' | 'duration_desc';

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
 */
export const DEFAULT_PURGE_BATCH_SIZE = 5000;

/* -------------------------------------------------------------------------------------------------
 * Statement text
 *
 * Every string below is assembled at module load from column names, placeholder
 * counts and the two ordering constants — never from a value. That is the
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
 * path, so a filter or an ordering never has to walk JSON.
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
 * Reads the arrival number of a row a replay conflicted with.
 *
 * Scoped to the session as well as the id so a repository call can never report
 * a number from another session's row, even though `id` is globally unique.
 */
const SELECT_INGEST_SEQ_BY_ID_SQL = `SELECT ingest_seq FROM ${TABLE}
WHERE id = ? AND session_id = ?`;

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
 * Deletes one bounded batch of a session's rows.
 *
 * The subquery form is used rather than `DELETE … LIMIT`, which needs a
 * compile-time SQLite option (`SQLITE_ENABLE_UPDATE_DELETE_LIMIT`) this service
 * cannot assume of the runtime's bundled build. Ordering the subquery by
 * `ingest_seq` makes each batch a contiguous slice, which is both the cheapest
 * traversal and the one whose progress is observable.
 */
const DELETE_SESSION_BATCH_SQL = `DELETE FROM ${TABLE}
WHERE ingest_seq IN (
  SELECT ingest_seq FROM ${TABLE} WHERE session_id = ? ORDER BY ingest_seq LIMIT ?
)`;

/** Deletes one bounded batch of rows older than a cutoff. See {@link DELETE_SESSION_BATCH_SQL}. */
const DELETE_OLDER_THAN_BATCH_SQL = `DELETE FROM ${TABLE}
WHERE ingest_seq IN (
  SELECT ingest_seq FROM ${TABLE} WHERE start_time < ? ORDER BY ingest_seq LIMIT ?
)`;

/**
 * Deletes one bounded batch of rows older than a cutoff within named sessions.
 *
 * @param sessionSlots How many session ids the `IN` list binds.
 * @returns The statement text for that width.
 */
function deleteOlderThanForSessionsSql(sessionSlots: number): string {
  return `DELETE FROM ${TABLE}
WHERE ingest_seq IN (
  SELECT ingest_seq FROM ${TABLE}
  WHERE start_time < ? AND session_id IN (${placeholders(sessionSlots)})
  ORDER BY ingest_seq LIMIT ?
)`;
}

/**
 * Selects the subset of a column's values that a session holds.
 *
 * Used for both existence lookups, so the two cannot drift on scoping or on
 * chunking. `DISTINCT` matters: one id may match many rows for `trace_id`, and
 * the caller wants the set, not the multiplicity.
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
WHERE session_id = ?${capture} AND ${column} IN (${placeholders(slots)})`;
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
   * Every offered event appears, whether it was written or skipped: a skipped
   * event carries the arrival number of the row already in the table, read
   * back rather than invented, so `../telemetry/live-tail.ts` can broadcast
   * persisted objects and `correlate.ts` can use `ingestSeq` as its final
   * ordering tie-break without knowing which rows were replays.
   *
   * For a skipped event the *content* is the caller's and the stored row is
   * untouched — the two are byte-identical in the only case that produces a
   * conflict, a producer replaying its own buffered batch.
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
   * Narrow to one correlated interaction. Served by the
   * `(trace_id, start_time)` index, which is what makes the timeline and flame
   * views cheap.
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
   * The key is the keyed hash computed at ingest, never a URL, and is served by
   * the `(session_id, request_key)` index so duplicate-request grouping is an
   * indexed read.
   */
  readonly requestKey?: string | undefined;

  /** How to order the page. Defaults to `'start_asc'`, the canonical order. */
  readonly sort?: TelemetrySort | undefined;

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
 * field except the ones the reader itself fixes.
 *
 * Derived rather than restated so a field added to the filter is available
 * through every reader in the same edit.
 */
export type TelemetryReadOptions = Omit<TelemetryQuery, 'sessionId' | 'traceId' | 'requestKey'>;

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
   * {@link DEFAULT_PURGE_BATCH_SIZE}; must be a positive integer.
   */
  readonly batchSize?: number | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * The repository's contract
 * ---------------------------------------------------------------------------------------------- */

/**
 * The telemetry repository, over the session store.
 *
 * Every method answers with a {@link Result} and **never throws**, and every
 * method is synchronous underneath: `node:sqlite` is a synchronous binding and
 * `Store.transaction` commits before it returns, so a successful
 * {@link TelemetryRepo.insertMany} means committed rows.
 *
 * Nothing is mutated in place. A returned event is reconstructed from its row
 * and validated, so a caller may keep it without ever observing a value the
 * store does not hold.
 */
export interface TelemetryRepo {
  /**
   * Writes a batch of attributed, **already-redacted** events in one
   * transaction, skipping any whose `id` the table already holds.
   *
   * Refuses the whole batch, without writing anything, when an element does not
   * match the persisted event schema — including a missing `sessionId` or
   * `captureId`, which is not a partially attributed event but one that should
   * never have been ingested (AAP 0.5.1, 0.7.1). The refusal names the field
   * paths that failed and never a value.
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
   * Reads one page of a session's events.
   *
   * @param filter What to match, how to order it and which page to return.
   * @returns The page, or the refusal for an argument this repository will not
   * accept (an unknown sort or kind, a negative or fractional `limit` or
   * `offset`, a non-finite `minDuration`).
   */
  query(filter: TelemetryQuery): Result<TelemetryPage, DebuggenError>;

  /**
   * Every event of one correlated interaction, in canonical order by default.
   *
   * What the correlator is handed to build a trace tree, and what the
   * `timeline`, `flame` and `waterfall` nodes are served from.
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
   * Every event sharing one request grouping key.
   *
   * The indexed read behind duplicate-request detection: the occurrences of one
   * group, in the order they happened.
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
   * Deletes every event of one session, in bounded batches.
   *
   * Used where the session itself is kept — a capture's evidence aged out while
   * the analysis and panel that cite it stay readable. Deleting the `sessions`
   * row cascades to these rows instead, which is why this is a retention tool
   * rather than part of session deletion.
   *
   * @returns How many rows were deleted.
   */
  deleteBySession(sessionId: SessionId): Result<number, DebuggenError>;

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
   * @param cutoffEpochMs The threshold, in epoch milliseconds; a row with
   * `startTime < cutoffEpochMs` is removed.
   * @param options Session restriction and batch size.
   * @returns How many rows were deleted.
   */
  deleteOlderThan(
    cutoffEpochMs: number,
    options?: DeleteOlderThanOptions,
  ): Result<number, DebuggenError>;
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
  /** The `ORDER BY` clause, always ending in the canonical tie-break chain. */
  readonly ordering: string;

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

/** A `CHECK` constraint refused the row — for this table, the `tier` list. */
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
 * `tier` outside the column's `CHECK` list — so both user interfaces can say
 * something specific, and falls back to `DebuggenError.from` for everything
 * else (a closed handle, a disk failure, a statement this build cannot
 * prepare).
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
    return new DebuggenError('STORE_ERROR', 'A telemetry event names a tier the store refuses.', {
      hint: `A stored event's tier must be one of: ${TELEMETRY_TIERS.join(', ')}.`,
      details: context(operation, { ...details, reason: 'unknown-tier' }),
      cause,
    });
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
 * in one place rather than at seventeen call sites.
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
 * A change count as a number.
 *
 * `node:sqlite` types it as `number | bigint` because it is read with
 * `sqlite3_changes64()`. A batch here is bounded by
 * {@link DEFAULT_PURGE_BATCH_SIZE} or by the caller's array length, so the
 * conversion is lossless.
 *
 * @param result What `StatementSync.run` returned.
 * @returns The change count as a number.
 */
function changesOf(result: { readonly changes: number | bigint }): number {
  return typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
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

  const clauses: string[] = ['session_id = ?'];
  const values: BoundValue[] = [filter.sessionId];

  if (filter.captureId !== undefined) {
    clauses.push('capture_id = ?');
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
    // filter that reads inside the document, and TelemetryQuery.component for
    // why it is always combined with session_id.
    clauses.push(`json_extract(event, '${COMPONENT_JSON_PATH}') = ?`);
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
 * @param filter The query as the caller wrote it.
 * @param operation The calling method, for a refusal's `details`.
 * @returns The plan, or the refusal.
 */
function buildPagePlan(filter: TelemetryQuery, operation: string): Result<PagePlan, DebuggenError> {
  const sort = filter.sort ?? 'start_asc';
  const ordering = ORDERING_BY_SORT[sort];

  if (ordering === undefined) {
    return err(
      argumentError(
        operation,
        'A telemetry query named an ordering the store does not implement.',
        `Use one of: ${TELEMETRY_SORTS.join(', ')}. An aggregate ordering such as count_desc is applied where the aggregate is computed, not over rows.`,
        'unknown-sort',
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
    ordering,
    limit: Math.min(requestedLimit, TELEMETRY_QUERY_MAX_LIMIT),
    offset,
  });
}

/**
 * Splits values into chunks of at most {@link EXISTENCE_LOOKUP_CHUNK_SIZE}.
 *
 * @param values The de-duplicated values.
 * @returns One array per statement, in input order.
 */
function chunk(values: readonly string[]): string[][] {
  const chunks: string[][] = [];

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

    const parsed = parseTelemetryEvent({ ...candidate, ingestSeq });

    if (isErr(parsed)) {
      skipped.push(ingestSeq);
      continue;
    }

    events.push(parsed.value);
  }

  return ok({ events, skipped });
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
 * The repository holds no state of its own beyond its dependencies: statements
 * live in the store's cache, and every method is a pure function of the
 * database's contents.
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

  /**
   * The one read path: plan the filter, count over it, page over it, and
   * reconstruct.
   *
   * Every reader below routes through this, which is what makes their behaviour
   * identical by construction — the same refusals, the same defaults, the same
   * total order and the same skip-and-count policy — rather than by seven call
   * sites remembering to agree.
   */
  function readPage(
    filter: InternalFilter,
    operation: string,
  ): Result<TelemetryPage, DebuggenError> {
    return attempt<TelemetryPage>(operation, () => {
      const plan = buildFilter(filter, operation);

      if (isErr(plan)) {
        return plan;
      }

      const paging = buildPagePlan(filter, operation);

      if (isErr(paging)) {
        return paging;
      }

      if (plan.value.kind === 'nothing') {
        // A filter narrowed to nothing is answered without a statement: an
        // empty `IN ()` list is a SQLite syntax error, and widening such a
        // filter to "everything" would be worse than either.
        return ok({ rows: [], total: 0 });
      }

      const { clause, values } = plan.value;
      const { ordering, limit, offset } = paging.value;

      // One count over the identical WHERE clause, so `total` and `rows` can
      // never describe different filters.
      const countRow = store
        .statement(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE ${clause}`)
        .get(...values);
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

      if (read.value.skipped.length > 0) {
        // The arrival numbers and nothing else: a row that failed validation
        // may hold any captured value, and this record is logged and may be
        // shown to a developer (AAP 0.5.2).
        logger.warn('skipped telemetry rows that no longer match the event schema', {
          operation,
          skipped: read.value.skipped.length,
          ingestSeqs: read.value.skipped,
        });
      }

      const nextOffset = offset + rows.length;

      return ok({
        rows: read.value.events,
        total,
        ...(nextOffset < total ? { nextOffset } : {}),
        ...(read.value.skipped.length > 0 ? { skipped: read.value.skipped.length } : {}),
      });
    });
  }

  /**
   * Deletes rows one bounded batch at a time until a batch comes up short,
   * which is the only signal that the predicate is exhausted.
   *
   * Each batch is its own transaction, so the write lock is released between
   * them and an ingest batch arriving mid-sweep waits for one batch rather than
   * for the whole purge (see {@link DEFAULT_PURGE_BATCH_SIZE}).
   *
   * @param batchSize How many rows one statement removes.
   * @param deleteBatch Runs one batch and returns how many rows it removed.
   * @returns The total removed.
   */
  function purgeInBatches(batchSize: number, deleteBatch: (limit: number) => number): number {
    let deleted = 0;

    for (;;) {
      const removed = store.transaction(() => deleteBatch(batchSize));

      deleted += removed;

      if (removed < batchSize) {
        return deleted;
      }
    }
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
          const lookup = store.statement(SELECT_INGEST_SEQ_BY_ID_SQL);

          // One transaction for the whole batch, and one prepared statement
          // reused per row: an ingest batch is the hot path of a running
          // capture, and a per-row transaction would fsync per event.
          const result = store.transaction<InsertTelemetryResult>(() => {
            const stored: TelemetryEvent[] = [];
            let inserted = 0;
            let skipped = 0;

            for (const event of validated) {
              const written = insert.get(...insertValues(event, toStoredDocument(event)));
              let ingestSeq: number | undefined;

              if (written === undefined) {
                // The conflict clause suppressed the insert: this id is already
                // stored. Its arrival number is read back rather than invented,
                // because the caller's copy of the event must carry the number
                // the store actually holds.
                skipped += 1;

                const existing = lookup.get(event.id, event.sessionId);

                if (existing === undefined) {
                  throw reusedEventIdError(event.id);
                }

                ingestSeq = readInteger(existing['ingest_seq']);
              } else {
                inserted += 1;
                ingestSeq = readInteger(written['ingest_seq']);
              }

              if (ingestSeq === undefined) {
                throw corruptColumnError(operation, 'ingest_seq');
              }

              stored.push({ ...event, ingestSeq });
            }

            return { events: stored, inserted, skipped };
          });

          logger.debug('stored a telemetry batch', {
            operation,
            batchSize,
            inserted: result.inserted,
            skipped: result.skipped,
          });

          return ok(result);
        },
        { batchSize },
      );
    },

    query(filter) {
      return readPage(filter, 'query');
    },

    listByTrace(sessionId, traceId, options) {
      return readPage({ ...options, sessionId, traceId }, 'listByTrace');
    },

    listByCapture(sessionId, captureId, options) {
      return readPage({ ...options, sessionId, captureId }, 'listByCapture');
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

    deleteBySession(sessionId) {
      const operation = 'deleteBySession';

      return attempt(operation, () => {
        const refusal = requireSession(sessionId, operation);

        if (refusal !== undefined) {
          return err(refusal);
        }

        const statement = store.statement(DELETE_SESSION_BATCH_SQL);
        const deleted = purgeInBatches(DEFAULT_PURGE_BATCH_SIZE, (limit) =>
          changesOf(statement.run(sessionId, limit)),
        );

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

      return attempt(operation, () => {
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

        const batchSize = options?.batchSize ?? DEFAULT_PURGE_BATCH_SIZE;

        if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
          return err(
            argumentError(
              operation,
              'A telemetry purge named a batch size that cannot bound a statement.',
              `Pass a positive integer, or omit the field for ${String(DEFAULT_PURGE_BATCH_SIZE)} rows per batch.`,
              'invalid-batch-size',
            ),
          );
        }

        const sessionIds = options?.sessionIds;

        if (sessionIds === undefined) {
          const statement = store.statement(DELETE_OLDER_THAN_BATCH_SQL);
          const deleted = purgeInBatches(batchSize, (limit) =>
            changesOf(statement.run(cutoffEpochMs, limit)),
          );

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

        let deleted = 0;

        // Chunked for the same reason the existence lookups are: a sweep naming
        // hundreds of sessions must not assemble one statement whose parameter
        // count depends on how many sessions a developer has accumulated.
        for (const part of chunk(unique)) {
          const statement = store.statement(deleteOlderThanForSessionsSql(part.length));

          deleted += purgeInBatches(batchSize, (limit) =>
            changesOf(statement.run(cutoffEpochMs, ...part, limit)),
          );
        }

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
