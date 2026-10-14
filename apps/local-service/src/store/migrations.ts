/**
 * Versioned, idempotent application of the session store schema.
 *
 * `./db.ts` calls {@link applyMigrations} exactly once per process from inside
 * `openStore`, after it has opened the `node:sqlite` connection and set that
 * connection's pragmas, and before any repository prepares a statement. The
 * service's entry point runs that open ahead of modification reconciliation,
 * ahead of the retention sweep and ahead of the HTTP and WebSocket surfaces
 * accepting a single client, so a failure here has to arrive as a typed value
 * the entry point can report and exit on — never as a half-migrated database
 * that the repositories then write into.
 *
 * ## The version authority
 *
 * `PRAGMA user_version` is the authority on the schema version of an existing
 * database. It is a single 32-bit integer in the SQLite file header: reading it
 * costs one page read, which is why the overwhelmingly common start — a
 * database already at the current version — can be decided without a query
 * against a table and without a write of any kind.
 *
 * {@link STORE_SCHEMA_VERSION} is the version this build expects. The `meta`
 * table mirrors the stamped version, the digest of the DDL text and two
 * timestamps in human-readable form for a developer inspecting the file with
 * any SQLite client; it is a mirror and never the authority, because a table
 * can only be read after the schema that declares it exists.
 *
 * Four decisions follow from comparing the two, and they are the whole of this
 * module's behaviour:
 *
 * | Stamped version                  | Decision                                            |
 * | -------------------------------- | --------------------------------------------------- |
 * | equal to `STORE_SCHEMA_VERSION`  | no-op success, performing no write at all            |
 * | greater                          | refuse, with an actionable hint: a newer build wrote it |
 * | `0` with the schema already there | adopt it — complete it with the idempotent version-1 DDL, then stamp |
 * | lower                            | apply every ladder step above it, one transaction each |
 *
 * ## The additive-only ladder policy
 *
 * {@link STORE_MIGRATIONS} is the ladder. Step 1 is the DDL text of
 * `./schema.sql`, handed in by the caller. Every later step must be purely
 * additive — `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
 * `ALTER TABLE … ADD COLUMN` — and must never drop, rename or rewrite an
 * object an earlier step declared, save under the one documented exception
 * below.
 *
 * That is a safety requirement rather than a matter of taste. This database
 * holds the modification journal: the rows that record, for every file this
 * tool patched, the hash of the original content, the hash of the patched
 * content and the path of the backup. Those rows are the only thing able to
 * restore a developer's source files after a crash, so an existing database
 * must always be able to migrate forward without losing them. A step that
 * rebuilt a table would put a developer's working tree at the mercy of a schema
 * refactor.
 *
 * ### The one exception: a routing table whose key must change
 *
 * A table outside the modification journal that holds routing state, not
 * history, may be rebuilt when its primary key must change — SQLite cannot
 * alter a key in place — and only under all of these conditions: the rebuild
 * runs inside the step's single transaction; every existing row is copied,
 * and the copy is counted against the source before the old table is dropped,
 * so a mismatch rolls the whole step back; the table keeps its name, its
 * foreign keys and its indexes; and the step stays idempotent. Version 7
 * ({@link BINDING_HOLDER_KEY_MIGRATION}) is the one such step: it re-keys the
 * `bindings` routing table by holder and tab. The `modifications` table and
 * its chains stay additive-only without exception.
 *
 * ## What this module deliberately does not do
 *
 * - **No filesystem access and no path computation.** The DDL arrives as a
 *   string because `./db.ts` owns the three-source loader — an inline string
 *   injected by the packaged editor extension, `./schema.sql` beside the
 *   sources in development, `./store/schema.sql` beside the bundled entry
 *   point. Keeping the read out of here is what lets the installable bundle be
 *   self-contained.
 * - **No connection pragmas.** `auto_vacuum`, `journal_mode`, `foreign_keys`,
 *   `busy_timeout` and `synchronous` are per-connection settings owned by
 *   `./db.ts`. In particular `PRAGMA journal_mode` cannot run inside a
 *   transaction, and every write here happens inside one; `auto_vacuum` must
 *   reach a new file before its first write, which is earlier than any step
 *   here runs.
 * - **No `node:sqlite` runtime dependency.** The binding is imported for its
 *   type only; the live database handle is passed in, which is what lets a test
 *   drive the whole ladder against an in-memory database with an injected
 *   logger and clock, and without a `$DEBUGGEN_HOME` on disk.
 */

import {
  DebuggenError,
  assert,
  err,
  noopLogger,
  nowEpochMs,
  ok,
  type LogFields,
  type Logger,
  type Result,
} from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';
import { CLOCK_OFFSET_BOUND_MS } from '@debuggen/telemetry';

import type { DatabaseSync } from 'node:sqlite';

/**
 * The schema version this build of the service expects an opened store to be
 * at, and the version {@link applyMigrations} migrates an older database up to.
 *
 * **Bump this in the same commit that appends a ladder step to
 * {@link STORE_MIGRATIONS}, never separately.** The two are checked against each
 * other when this module loads: the highest step version must equal this
 * constant, so a step added without a bump — or a bump without a step — fails
 * the service's own start and its test suites rather than shipping a database
 * that no build agrees about.
 *
 * Version 1 is the schema declared by `./schema.sql`. Version 2 adds the
 * single-child invariant of the modification journal's chains and the
 * traversal-aligned telemetry purge indexes — see
 * {@link CHAIN_INTEGRITY_AND_PURGE_INDEXES_MIGRATION}. Version 3 adds the two
 * ordered telemetry lookup indexes, which serve a page of one span kind and the
 * occurrences of one request group in their reading order without a sort — see
 * {@link ORDERED_TELEMETRY_LOOKUP_INDEXES_MIGRATION}. Version 4 adds the session
 * cleanup summary projection, which lets the session list read a row's cleanup
 * status, completion time and conflict count without reading the session's
 * document — see {@link SESSION_CLEANUP_SUMMARIES_MIGRATION}. Version 5 adds
 * the `telemetry_events.clock_offset_ms` column, the informational clock
 * offset each producer reports on its events (AAP 0.2.3) — see
 * {@link PRODUCER_CLOCK_OFFSET_MIGRATION}. Version 6 adds the persisted
 * project-root identity, the canonical path each session's root was admitted
 * under, which the session manager holds every sink to across a restart — see
 * {@link SESSION_ROOT_IDENTITIES_MIGRATION}. Version 7 keys the tab bindings by
 * the credential that made them and the tab, so two paired browsers whose tab
 * ids collide keep their own bindings — see {@link BINDING_HOLDER_KEY_MIGRATION}.
 */
export const STORE_SCHEMA_VERSION = 7;

/**
 * The `subsystem` field every log record from this module carries, so store
 * lines can be filtered out of a session's log without matching on message
 * text.
 */
const SUBSYSTEM = 'store';

/**
 * The table whose presence means "the version-1 schema is already here".
 *
 * `sessions` is the root of the store's foreign-key graph — every other
 * session-scoped table references it — so a database holding it was created by
 * a build that executed the whole DDL in one transaction. Probing a table
 * rather than counting them keeps the check independent of how many tables the
 * current schema happens to declare.
 */
const ADOPTION_PROBE_TABLE = 'sessions';

/** The bookkeeping table this module owns. See `./schema.sql`. */
const META_TABLE = 'meta';

/**
 * The `meta` keys the ladder writes.
 *
 * - `schema_version` — the stamped version, as text. A mirror of
 *   `PRAGMA user_version`, which stays the authority.
 * - `ddl_sha256` — the digest of the DDL text the ladder was given.
 *   Diagnostic only: a mismatch on a later start is logged at `warn` and never
 *   treated as an error, because a comment or whitespace edit to `./schema.sql`
 *   is legitimate and changes the digest without changing the schema.
 * - `created_at` — epoch milliseconds, written once, when the store is first
 *   migrated or adopted, and never refreshed afterwards.
 * - `updated_at` — epoch milliseconds, refreshed on every applied step and on
 *   adoption.
 */
const META_KEYS = {
  schemaVersion: 'schema_version',
  ddlSha256: 'ddl_sha256',
  created: 'created_at',
  updated: 'updated_at',
} as const;

/** Reads the version stamped in the database header. */
const READ_USER_VERSION_SQL = 'PRAGMA user_version';

/** Existence probe for one table, by exact name. */
const TABLE_EXISTS_SQL = `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`;

/** Reads one `meta` value by key. */
const READ_META_SQL = `SELECT value FROM ${META_TABLE} WHERE key = ?`;

/**
 * Writes one `meta` row, overwriting an existing value for the same key, so
 * repeating the write is harmless.
 */
const UPSERT_META_SQL =
  `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?) ` +
  `ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

/**
 * Writes one `meta` row only when the key is absent — the `created_at`
 * behaviour, which must record the first migration and not the latest one.
 */
const INSERT_META_IF_ABSENT_SQL = `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`;

/**
 * The largest value `PRAGMA user_version` can hold: it is a signed 32-bit
 * integer, and a step version outside that range would be silently truncated by
 * the engine into a version no later start could recognise.
 */
const MAX_USER_VERSION = 2_147_483_647;

/**
 * The hint attached to every failure that leaves the store unusable but the
 * developer's project untouched.
 *
 * One sentence of recovery, and one sentence of consequence, because the second
 * is the part a developer cannot infer: removing the store loses the session
 * history, and it does *not* revert files an earlier session instrumented — the
 * journal that could have reverted them is what is being deleted. The service
 * reconciles that journal on start, so the ordering matters: restart with the
 * store in place first, and remove it only once that reports the files are
 * restored.
 */
const REPAIR_HINT =
  'Stop the service and restart it; if the failure repeats, the store file is unusable and can be removed at $DEBUGGEN_HOME/sessions.sqlite. Removing it loses past sessions and does not revert files an earlier session instrumented, so restart once with the file in place first and let cleanup report on them.';

/**
 * What a ladder step is given when it runs.
 *
 * Everything a step could need arrives here rather than being reached for, which
 * is what keeps the steps pure enough to test: the schema text comes from the
 * caller's loader, the logger is the host process's, and the clock is a
 * function so a suite can pin time.
 */
export interface MigrationContext {
  /**
   * The full text of `./schema.sql`, exactly as the caller's loader produced
   * it. Step 1 executes it; a later step normally ignores it, because a later
   * step's statements are its own and are never appended to this file.
   */
  readonly ddl: string;

  /** The host process's logger, for a step with something worth reporting. */
  readonly logger: Logger;

  /**
   * The current time in Unix epoch milliseconds. Injected rather than read from
   * `Date.now` so a suite can assert on a timestamp it chose.
   */
  readonly now: () => number;
}

/**
 * One rung of the store's schema ladder.
 *
 * A step is applied inside its own transaction, at most once per database, in
 * ascending version order. It reports failure by throwing — the caller converts
 * that into a typed error after rolling back — because a step's body is a
 * sequence of statements, and requiring every one of them to be threaded
 * through a result type would obscure the SQL without making anything safer.
 */
export interface StoreMigration {
  /**
   * The version this step migrates the database *to*. Must be a positive
   * integer, unique in the ladder, and greater than every earlier step's
   * version; the highest step's version must equal
   * {@link STORE_SCHEMA_VERSION}.
   */
  readonly version: number;

  /**
   * A short, lower-case phrase naming what the step does, for the log line and
   * for the error message when it fails. It reaches a developer, so it describes
   * the change ("add the capture retention index") rather than the ticket.
   */
  readonly description: string;

  /**
   * Applies the step's statements to `db`.
   *
   * Runs inside a transaction the caller opened, so the body must not issue
   * `BEGIN`, `COMMIT` or `ROLLBACK` of its own, must not set a pragma that
   * cannot run inside a transaction, and must leave stamping the version and
   * writing the bookkeeping rows to the caller.
   *
   * @param db The open database handle, inside the caller's transaction.
   * @param context The schema text, the logger and the clock.
   * @throws Any error the underlying statements raise; the caller rolls back and
   * wraps it.
   */
  apply(db: DatabaseSync, context: MigrationContext): void;
}

/* -------------------------------------------------------------------------------------------------
 * Version 2 — chain integrity and purge traversal
 * ---------------------------------------------------------------------------------------------- */

/**
 * The column that exempts a pre-existing chain fork from the single-child index.
 *
 * `1` marks a record that, when version 2 was applied, shared its
 * `previous_record_id` with at least one other non-`reverted` sibling — a fork
 * written before the store enforced that a record carries at most one live
 * layer. Such rows cannot be made to satisfy a unique index without rewriting
 * or deleting journal rows, which the additive-only policy forbids because
 * those rows are what restore a developer's files. So the step marks them
 * instead, and the index below ignores marked rows. Every row written
 * afterwards takes the default `0` and is held to the invariant by the
 * database itself.
 *
 * Marking a fork is not resolving it. Cleanup in
 * `packages/instrumentation/src/cleanup.ts` detects a fork structurally — two
 * open records naming the same previous record — and refuses to write to that
 * file, reporting a conflict and keeping every backup, whichever value this
 * column holds.
 */
const CHAIN_FORK_COLUMN = 'chain_fork';

/**
 * Whether `modifications` already declares {@link CHAIN_FORK_COLUMN}.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, and every step must be safe to
 * reason about as idempotent, so the column is probed before it is added. The
 * table-valued pragma form is used because it can be filtered by a bound name.
 */
const CHAIN_FORK_COLUMN_EXISTS_SQL = `SELECT 1 AS present FROM pragma_table_info('modifications') WHERE name = ?`;

/**
 * Adds {@link CHAIN_FORK_COLUMN}. `NOT NULL` with a constant default, so every
 * existing row reads `0` without a rewrite, and a `CHECK` so a recovery path
 * that writes the column directly cannot store anything but a flag.
 */
const ADD_CHAIN_FORK_COLUMN_SQL = `ALTER TABLE modifications ADD COLUMN ${CHAIN_FORK_COLUMN} INTEGER NOT NULL DEFAULT 0 CHECK (${CHAIN_FORK_COLUMN} IN (0, 1))`;

/**
 * The status a record leaves the single-child invariant in.
 *
 * `reverted` is terminal in the repository's transition matrix, so a row that
 * reaches it only ever leaves the index below and never re-enters it: the
 * predicate cannot be violated by a status write. It must be excluded because
 * the installer's delta rollback (AAP 0.4.2) reverts a follow-up record while
 * its parent stays `applied`, and the next follow-up on that file is then
 * layered on the same parent again — a reverted sibling is history, not a
 * branch the file can hold.
 */
const TERMINAL_MODIFICATION_STATUS = 'reverted';

/**
 * Marks every non-`reverted` record whose previous record has more than one
 * non-`reverted` child.
 *
 * Every live sibling of a fork is marked, not all but one: the database cannot
 * tell which branch describes the bytes on disk, and choosing one would let the
 * index bless a branch that cleanup would then restore through. A parent with
 * one live child and any number of reverted ones is the rollback-then-retry
 * shape, not a fork, and is left alone.
 */
const MARK_PRE_EXISTING_FORKS_SQL = `UPDATE modifications SET ${CHAIN_FORK_COLUMN} = 1
WHERE status <> '${TERMINAL_MODIFICATION_STATUS}'
  AND previous_record_id IN (
    SELECT previous_record_id FROM modifications
    WHERE previous_record_id IS NOT NULL AND status <> '${TERMINAL_MODIFICATION_STATUS}'
    GROUP BY previous_record_id
    HAVING COUNT(*) > 1
  )`;

/**
 * The single-child invariant of a modification chain, as a database constraint.
 *
 * A chain restores strictly in reverse (AAP 0.4.2): a record's backup is only
 * written once the file hashes to that record's `instrumented_hash`. Two
 * records layered on one parent would each claim to continue from its bytes,
 * and cleanup could restore one branch and then either conflict on or strand
 * the other. `./modifications-repo.ts` refuses such an append inside its
 * `BEGIN IMMEDIATE` transaction; this partial unique index is the second line,
 * which holds even for a writer that bypassed the repository. Partial for three
 * reasons: a root record has no previous record and many roots may coexist; a
 * `reverted` child no longer describes bytes the file can hold (see
 * {@link TERMINAL_MODIFICATION_STATUS}); and {@link CHAIN_FORK_COLUMN} exempts
 * forks that predate the index.
 *
 * The existing non-unique `idx_modifications_previous_record_id` stays: a
 * lookup by previous record id cannot prove the whole predicate, so the planner
 * keeps using that index for the chain-head and child probes.
 */
const CREATE_SINGLE_CHILD_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_modifications_previous_record_id_unique
  ON modifications (previous_record_id)
  WHERE previous_record_id IS NOT NULL
    AND status <> '${TERMINAL_MODIFICATION_STATUS}'
    AND ${CHAIN_FORK_COLUMN} = 0`;

/**
 * The telemetry purge indexes.
 *
 * Retention deletes in bounded batches (`./telemetry-repo.ts`), and each batch
 * must be an index range read that stops after its limit rather than a full
 * scan followed by a temporary sort. Two indexes serve all three purge shapes
 * when every purge orders a batch by `start_time, ingest_seq`:
 *
 * - a global cutoff, `start_time < ?`, reads `(start_time, ingest_seq)`;
 * - a cutoff restricted to named sessions, `session_id = ? AND start_time < ?`,
 *   and a whole-session purge, `session_id = ?`, both read
 *   `(session_id, start_time, ingest_seq)`.
 *
 * `ingest_seq` closes each key so a batch boundary between two rows of equal
 * `start_time` is deterministic. A third `(session_id, ingest_seq)` index would
 * serve the whole-session purge no better than the second one does, and every
 * index on this table is paid for on the ingest hot path of a running capture,
 * so it is deliberately not added.
 */
const CREATE_PURGE_INDEXES_SQL = `CREATE INDEX IF NOT EXISTS idx_telemetry_events_start_time_ingest_seq
  ON telemetry_events (start_time, ingest_seq);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_id_start_time_ingest_seq
  ON telemetry_events (session_id, start_time, ingest_seq);`;

/**
 * Normalises a `changes` count, which `node:sqlite` reports as a `bigint` on a
 * connection opened with `readBigInts`.
 *
 * @param changes The count a statement reported.
 * @returns The count as a number.
 */
function changeCount(changes: number | bigint): number {
  return typeof changes === 'bigint' ? Number(changes) : changes;
}

/**
 * Schema version 2: the modification journal's single-child chain invariant and
 * the telemetry purge indexes.
 *
 * Purely additive, as the ladder policy requires: one column with a constant
 * default, one flag update on rows that already violate the new invariant, and
 * three `IF NOT EXISTS` indexes. No journal row is rewritten beyond that flag,
 * detached or deleted. A pre-existing fork is reported at `warn` with the
 * number of records marked — identifiers and counts only, never a diff or a
 * path, because this line reaches the service log.
 */
const CHAIN_INTEGRITY_AND_PURGE_INDEXES_MIGRATION: StoreMigration = {
  version: 2,
  description: 'enforce single-child modification chains and add the telemetry purge indexes',
  apply: (db, { logger }) => {
    if (db.prepare(CHAIN_FORK_COLUMN_EXISTS_SQL).get(CHAIN_FORK_COLUMN) === undefined) {
      db.exec(ADD_CHAIN_FORK_COLUMN_SQL);
    }

    const marked = changeCount(db.prepare(MARK_PRE_EXISTING_FORKS_SQL).run().changes);
    if (marked > 0) {
      logger.warn(
        'the modification journal holds chain forks written before single-child chains were enforced; cleanup reports their files as conflicts',
        { subsystem: SUBSYSTEM, forkedRecords: marked },
      );
    }

    db.exec(CREATE_SINGLE_CHILD_INDEX_SQL);
    db.exec(CREATE_PURGE_INDEXES_SQL);
  },
};

/* -------------------------------------------------------------------------------------------------
 * Version 3 — ordered telemetry lookups
 * ---------------------------------------------------------------------------------------------- */

/**
 * The two ordered telemetry lookup indexes.
 *
 * ## Why the planner needed them
 *
 * The store never runs `ANALYZE`, so SQLite plans every read from its default
 * estimates, under which an index matched by one equality and one matched by
 * two are rated almost alike (about ten rows against about nine).
 * `idx_telemetry_events_session_id_start_time_ingest_seq`, added by version 2
 * for the purge, also satisfies the leading `start_time` term of every read
 * ordering, which tips that near-tie its way: the planner read a whole
 * session through it — sorting what it found — for a page of one kind and for
 * the occurrences of one request group, even though
 * `idx_telemetry_events_session_id_kind` and
 * `idx_telemetry_events_session_id_request_key` narrow those reads to the rows
 * they return. Each index below is matched by the same equalities *and*
 * yields the read's whole ordering, so it answers the page as an ordered range
 * that stops at `LIMIT`, and the planner prefers it:
 *
 * - `(session_id, kind, start_time, id)` serves a single-kind page of
 *   `./telemetry-repo.ts`'s panel-data surface in its `start_time, id` order,
 *   with a capture narrowing applied as a residual filter. Its count reads this
 *   index or `(session_id, kind)`, whichever the planner rates cheaper; both
 *   are narrowed by the same two equalities.
 * - `(session_id, request_key, start_time, producer_id, seq)` serves
 *   `listByRequestKey` in the canonical order. The canonical chain's last key,
 *   `ingest_seq`, is the table's rowid, which SQLite appends to every index
 *   entry, so the index ends in exactly that chain.
 *
 * ## Why these two keys, and only these
 *
 * Every index on this table is paid for on the ingest path of a running
 * capture, which is why a composite is only worth adding where its inserts
 * are cheap. Here the leading key after `session_id` is low-cardinality — the
 * kind vocabulary has seventeen members — or `NULL` for most rows, since only
 * a request carries a request key, and `start_time` grows as a capture runs.
 * Almost every insert therefore lands at the end of a range already being
 * written: the indexes grow append-mostly.
 *
 * Span, parent-span and trace ids get no composite. They are random keys, so a
 * `(session_id, span_id, …)` entry lands at a random page of the B-tree on
 * every insert; measured on a forty-thousand-event store, such composites cost
 * two to three times the ingest time of a batch. They are not needed either:
 * those ids are selective across the whole table, and
 * `idx_telemetry_events_span_id`, `idx_telemetry_events_parent_span_id` and
 * `idx_telemetry_events_trace_id_start_time` already answer each lookup in a
 * handful of rows once the session scope is applied to the rows they return
 * rather than chosen as the access path. `./telemetry-repo.ts` arranges exactly
 * that by writing the session term as `+session_id = ?` whenever one of those
 * ids, or a list of event ids, is looked up (see its `RESIDUAL_SESSION_TERM`).
 *
 * A `kinds` filter naming several kinds deliberately keeps the planner's
 * ordered session read. No single index yields the start order across several
 * kind ranges, so reading the kind index would mean sorting every matching row
 * before the first page could be returned: forcing it measured about 669 ms
 * against about 9 ms for a deep page of the dominant kinds.
 *
 * The single-column and two-column indexes version 1 declared stay, as the
 * additive-only ladder policy requires.
 */
const CREATE_ORDERED_LOOKUP_INDEXES_SQL = `CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_id_kind_start_time_id
  ON telemetry_events (session_id, kind, start_time, id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_id_request_key_start_time_producer_id_seq
  ON telemetry_events (session_id, request_key, start_time, producer_id, seq);`;

/**
 * Schema version 3: the ordered telemetry lookup indexes — see
 * {@link CREATE_ORDERED_LOOKUP_INDEXES_SQL} for which reads they serve and why
 * no other key gets one.
 *
 * Purely additive: two `IF NOT EXISTS` indexes and nothing else, so no row of
 * any table is read, rewritten or removed, and a store already carrying either
 * index is left as it is.
 */
const ORDERED_TELEMETRY_LOOKUP_INDEXES_MIGRATION: StoreMigration = {
  version: 3,
  description: 'add the ordered telemetry kind and request group indexes',
  apply: (db) => {
    db.exec(CREATE_ORDERED_LOOKUP_INDEXES_SQL);
  },
};

/* -------------------------------------------------------------------------------------------------
 * Version 4 — the session cleanup summary projection
 *
 * Self-contained on purpose: every statement and constant of this step lives in
 * this section, so the step can be renumbered as a unit should another ladder
 * step land first.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The cleanup-status vocabulary the summary table's `CHECK` admits, in the
 * order of `@debuggen/protocol`'s `CLEANUP_STATUSES` (and so of its
 * `cleanupStatusSchema`).
 *
 * Written out as SQL text rather than generated from the protocol tuple, and
 * that is deliberate: a ladder step's DDL is frozen the moment it ships,
 * because a database created by it keeps its `CHECK` for ever. Generating the
 * list would let a later vocabulary change alter what this step creates for a
 * new database while every existing one kept the old constraint — two stores
 * of the same version disagreeing about what they accept. The store suite
 * asserts that this list equals `CLEANUP_STATUSES`, member for member and in
 * order, so a vocabulary change fails the build and is met with a new ladder
 * step instead.
 */
const CLEANUP_STATUS_SQL_LIST = `'pending', 'clean', 'partial', 'conflict'`;

/**
 * The session cleanup summary: the three cleanup facts a session list row
 * shows, one row per session, kept by `./sessions-repo.ts` in the same
 * transaction as every write of the session's document.
 *
 * ## Why a side table rather than three added columns
 *
 * `ALTER TABLE sessions ADD COLUMN` would append each column **after**
 * `record` in every stored row. SQLite reads a row's columns in declaration
 * order, and `record` — the whole `SessionRecord` document, which grows with
 * every plan, modification diff and analysis — spills onto overflow pages once
 * it outgrows its page. Reading a column declared after it makes SQLite walk
 * that document's overflow chain to reach it, which is exactly the per-row
 * document read this projection exists to remove. A separate `WITHOUT ROWID`
 * table keyed by the session id holds only the three facts, so the session
 * list reads the `sessions` projections declared before `record` plus one
 * small primary-key lookup per row, and never touches a document.
 *
 * ## The constraints
 *
 * - `session_id` references `sessions (id)` with `ON DELETE CASCADE`, so
 *   deleting a session — the retention sweep's one statement — removes its
 *   summary with it.
 * - `status` is checked against {@link CLEANUP_STATUS_SQL_LIST}.
 * - `completed_at` is whole epoch milliseconds, `NULL` while cleanup has not
 *   completed — the column form of the record's absent `cleanup.completedAt`.
 * - `conflict_count` is `cleanup.conflicts.length`, never negative.
 *
 * `STRICT`, as every table of `./schema.sql` is, so a mistyped value is refused
 * rather than coerced.
 */
const CREATE_SESSION_CLEANUP_SUMMARIES_SQL = `CREATE TABLE IF NOT EXISTS session_cleanup_summaries (
  session_id     TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN (${CLEANUP_STATUS_SQL_LIST})),
  completed_at   INTEGER,
  conflict_count INTEGER NOT NULL CHECK (conflict_count >= 0)
) STRICT, WITHOUT ROWID`;

/**
 * Derives a summary row from every stored session document that yields one —
 * the only statement in the service that reads a session document with SQL.
 *
 * Every extraction is guarded by `json_valid(record)` inside a `CASE`, which
 * SQLite evaluates lazily, because `json_extract` raises on malformed input and
 * one unreadable document must not fail the whole step. A document yields a
 * row only when all of these hold:
 *
 * - it is valid JSON;
 * - `$.cleanup.status` is text within {@link CLEANUP_STATUS_SQL_LIST};
 * - `$.cleanup.conflicts` is an array — `json_array_length` answers `0` for any
 *   other value, which would pass for "no conflicts";
 * - `$.cleanup.completedAt` is absent, JSON `null` (both stored as `NULL`), an
 *   integer, or a real — rounded to whole milliseconds, the canonicalisation
 *   `./sessions-repo.ts` applies to the same member on every write, so the next
 *   write of that session stores the identical value.
 *
 * A document that fails any of these gets no summary row. The session list
 * reports such a session as unreadable — left out, counted and moved past —
 * exactly as it did while it read the document, and the session's next write
 * creates its row.
 *
 * An upsert rather than a plain insert, so the step stays idempotent and the
 * document stays authoritative: a summary row already present for a session is
 * replaced by what that session's document says. The `WHERE` clause is also
 * what SQLite requires of an `INSERT … SELECT` carrying an upsert clause.
 */
const BACKFILL_SESSION_CLEANUP_SUMMARIES_SQL = `INSERT INTO session_cleanup_summaries (session_id, status, completed_at, conflict_count)
SELECT id, cleanup_status, cleanup_completed_at, cleanup_conflict_count
FROM (
  SELECT
    id,
    CASE WHEN json_valid(record) THEN
      CASE json_type(record, '$.cleanup.status')
        WHEN 'text' THEN json_extract(record, '$.cleanup.status')
      END
    END AS cleanup_status,
    CASE WHEN json_valid(record) THEN
      coalesce(json_type(record, '$.cleanup.completedAt'), 'absent')
    END AS completed_at_type,
    CASE WHEN json_valid(record) THEN
      CASE json_type(record, '$.cleanup.completedAt')
        WHEN 'integer' THEN json_extract(record, '$.cleanup.completedAt')
        WHEN 'real' THEN CAST(round(json_extract(record, '$.cleanup.completedAt')) AS INTEGER)
      END
    END AS cleanup_completed_at,
    CASE WHEN json_valid(record) THEN
      CASE json_type(record, '$.cleanup.conflicts')
        WHEN 'array' THEN json_array_length(record, '$.cleanup.conflicts')
      END
    END AS cleanup_conflict_count
  FROM sessions
)
WHERE cleanup_status IN (${CLEANUP_STATUS_SQL_LIST})
  AND completed_at_type IN ('absent', 'null', 'integer', 'real')
  AND cleanup_conflict_count IS NOT NULL
ON CONFLICT (session_id) DO UPDATE SET
  status = excluded.status,
  completed_at = excluded.completed_at,
  conflict_count = excluded.conflict_count`;

/**
 * How many sessions are left without a summary row once the backfill ran —
 * the sessions whose document yielded none.
 */
const COUNT_UNSUMMARISED_SESSIONS_SQL = `SELECT COUNT(*) AS unsummarised FROM sessions
WHERE NOT EXISTS (
  SELECT 1 FROM session_cleanup_summaries WHERE session_cleanup_summaries.session_id = sessions.id
)`;

/**
 * Schema version 4: the session cleanup summary projection — see
 * {@link CREATE_SESSION_CLEANUP_SUMMARIES_SQL} for why it is a side table and
 * {@link BACKFILL_SESSION_CLEANUP_SUMMARIES_SQL} for which documents yield a
 * row.
 *
 * Purely additive: one `IF NOT EXISTS` table and rows written into that table
 * only. No row of any table an earlier step declared is rewritten or removed.
 * An adopted database — stamped `0` with the schema already present — reaches
 * this step through the ladder once adoption has stamped version 1, so it ends
 * with the table created and backfilled like any other database below
 * version 4.
 *
 * Sessions whose document yielded no row are reported at `warn` by count only —
 * never an id, a path or a question, because the line reaches the service log.
 */
const SESSION_CLEANUP_SUMMARIES_MIGRATION: StoreMigration = {
  version: 4,
  description: 'add the session cleanup summary projection',
  apply: (db, { logger }) => {
    db.exec(CREATE_SESSION_CLEANUP_SUMMARIES_SQL);

    const summarised = changeCount(
      db.prepare(BACKFILL_SESSION_CLEANUP_SUMMARIES_SQL).run().changes,
    );
    const counted = db.prepare(COUNT_UNSUMMARISED_SESSIONS_SQL).get()?.['unsummarised'];
    const unsummarised =
      typeof counted === 'bigint' ? Number(counted) : typeof counted === 'number' ? counted : 0;

    logger.debug('backfilled the session cleanup summaries', {
      subsystem: SUBSYSTEM,
      summarisedSessions: summarised,
    });

    if (unsummarised > 0) {
      logger.warn(
        'some stored sessions have no readable cleanup state; the session list leaves them out until they are next written',
        { subsystem: SUBSYSTEM, unsummarisedSessions: unsummarised },
      );
    }
  },
};

/* -------------------------------------------------------------------------------------------------
 * Version 5 — the per-producer clock offset
 * ---------------------------------------------------------------------------------------------- */

/**
 * The column holding the clock offset an event's producer reported when it
 * created the event.
 *
 * AAP 0.2.3 applies no clock alignment between tiers "beyond a recorded
 * per-producer `clockOffsetMs` (server `Date` header versus local clock,
 * informational)". Each producer — a page document's browser agent, a dev
 * server's Node preload — estimates `server clock − producer clock` in whole
 * milliseconds with `@debuggen/telemetry`'s `ClockOffsetEstimator` and stamps
 * its current estimate on every event it creates, as the optional
 * `clockOffsetMs` field. The field already round-trips through the
 * authoritative `event` JSON document; this column is its flat projection, so
 * `./telemetry-repo.ts` can answer "what offset did each producer of this
 * session report?" with one grouped read instead of a walk over every document.
 *
 * `NULL` means the event carried no offset: every row written before this
 * step, and every event a producer created before its first usable `Date`
 * sample. The value is informational only — nothing in the store, the
 * correlator or the panel data layer adds it to `start_time` or `duration`.
 */
const CLOCK_OFFSET_COLUMN = 'clock_offset_ms';

/**
 * Whether `telemetry_events` already declares {@link CLOCK_OFFSET_COLUMN}.
 *
 * Probed for the reason {@link CHAIN_FORK_COLUMN_EXISTS_SQL} gives: SQLite has
 * no `ADD COLUMN IF NOT EXISTS`, and a step must be safe to reason about as
 * idempotent.
 */
const CLOCK_OFFSET_COLUMN_EXISTS_SQL = `SELECT 1 AS present FROM pragma_table_info('telemetry_events') WHERE name = ?`;

/**
 * Adds {@link CLOCK_OFFSET_COLUMN}: nullable with no default, so every existing
 * row reads `NULL` without a rewrite, and a `CHECK` bounding a present value to
 * `±CLOCK_OFFSET_BOUND_MS`.
 *
 * The bound is interpolated from `@debuggen/telemetry`'s own constant — a
 * number, never caller input — so the column and the event schema's
 * `clockOffsetMs` validation can never disagree about what a reportable offset
 * is. `INTEGER` in this `STRICT` table also refuses a fractional value, which
 * the event schema refuses first: the insert path validates every event before
 * it binds one, so the constraint is the last line for a writer that bypassed
 * the repository. A `NULL` satisfies the `CHECK`, as SQLite defines it.
 */
const ADD_CLOCK_OFFSET_COLUMN_SQL = `ALTER TABLE telemetry_events ADD COLUMN ${CLOCK_OFFSET_COLUMN} INTEGER CHECK (${CLOCK_OFFSET_COLUMN} BETWEEN -${String(CLOCK_OFFSET_BOUND_MS)} AND ${String(CLOCK_OFFSET_BOUND_MS)})`;

/**
 * Schema version 5: the per-producer clock offset column — see
 * {@link CLOCK_OFFSET_COLUMN}.
 *
 * Purely additive: one nullable column and nothing else. No existing row is
 * read or rewritten; every one of them reads `NULL`, which is the truth — the
 * build that wrote it recorded no offset.
 *
 * ## Why no index
 *
 * Deliberately none, for the reason version 3 sets out: every index on this
 * table is paid for on the ingest path of a running capture, on every event,
 * while the offset is read only when someone asks for the clock diagnostic. That
 * read — `listProducerClockOffsets` in `./telemetry-repo.ts` — is scoped to one
 * session (and optionally one capture) and is answered from a session-leading
 * index version 1 declared — `idx_telemetry_events_session_id_capture_id_start_time`
 * or `idx_telemetry_events_session_id_producer_id_seq`, whose key order serves
 * the per-producer grouping — with the offset tested on the rows it returns, so
 * its cost is bounded by one session's rows. An index on the offset itself would
 * serve no read at all: nothing looks an event up by its offset.
 */
const PRODUCER_CLOCK_OFFSET_MIGRATION: StoreMigration = {
  version: 5,
  description: 'record the per-producer clock offset each telemetry event reports',
  apply: (db) => {
    if (db.prepare(CLOCK_OFFSET_COLUMN_EXISTS_SQL).get(CLOCK_OFFSET_COLUMN) === undefined) {
      db.exec(ADD_CLOCK_OFFSET_COLUMN_SQL);
    }
  },
};

/* -------------------------------------------------------------------------------------------------
 * Version 6 — the persisted project-root identity
 *
 * Self-contained on purpose, as version 4 is: every statement and constant of
 * this step lives in this section, so the step can be renumbered as a unit
 * should another ladder step land first.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The persisted project-root identity: one row per session created with an
 * admission proof, holding the canonical path — every symbolic link resolved —
 * its project root was admitted under. `./sessions-repo.ts` writes the row in
 * the same transaction as the session's insert, and never rewrites it.
 *
 * ## Why it is persisted
 *
 * The pipeline indexes and patches a session's project long after the
 * `session.create` request that admitted its root has answered, and a
 * symbolic link on the root's path retargeted in between would otherwise be
 * followed (CWE-367). `SessionManager.confirmProjectRoot` therefore re-proves,
 * immediately before every such sink, that the root still resolves to the
 * directory recorded here. Held in memory only, that proof would not survive a
 * restart: a session read back from the store would have to take whatever its
 * root resolves to *then* as its identity, so a link retargeted while the
 * service was down would be accepted. This row is what the manager holds a
 * restarted process's sinks to instead.
 *
 * ## Why a side table rather than a column or a document field
 *
 * - `ALTER TABLE sessions ADD COLUMN` would append the column **after**
 *   `record`, and reading it would walk the document's overflow chain — the
 *   reason version 4 set out for its own side table.
 * - The `SessionRecord` document is the protocol's session contract, broadcast
 *   to every client and rewritten by every write of the session. The identity
 *   is a service-internal proof, written once and never patched, so it stays
 *   out of both.
 *
 * ## The constraints
 *
 * - `session_id` references `sessions (id)` with `ON DELETE CASCADE`, so
 *   deleting a session — the retention sweep's one statement — removes its
 *   identity with it.
 * - `canonical_root` is non-empty text.
 * - `recorded_at` is whole epoch milliseconds: when the proof was recorded.
 *
 * `STRICT`, as every table of `./schema.sql` is, so a mistyped value is refused
 * rather than coerced, and `WITHOUT ROWID`, since the one lookup is by primary
 * key.
 */
const CREATE_SESSION_ROOT_IDENTITIES_SQL = `CREATE TABLE IF NOT EXISTS session_root_identities (
  session_id     TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  canonical_root TEXT NOT NULL CHECK (length(canonical_root) > 0),
  recorded_at    INTEGER NOT NULL
) STRICT, WITHOUT ROWID`;

/**
 * How many stored sessions that have not ended carry no recorded identity —
 * the sessions whose sinks the session manager now refuses. `ended` is the one
 * terminal status, and a sink never acts on an ended session anyway.
 */
const COUNT_UNIDENTIFIED_LIVE_SESSIONS_SQL = `SELECT COUNT(*) AS unidentified FROM sessions
WHERE status <> 'ended'
  AND NOT EXISTS (
    SELECT 1 FROM session_root_identities WHERE session_root_identities.session_id = sessions.id
  )`;

/**
 * Schema version 6: the persisted project-root identity — see
 * {@link CREATE_SESSION_ROOT_IDENTITIES_SQL} for why it is persisted and why
 * it is a side table.
 *
 * Purely additive: one `IF NOT EXISTS` table and nothing else. No row of any
 * table an earlier step declared is rewritten or removed; the step's one read
 * counts, by the `status` projection, the sessions it leaves without a row.
 *
 * ## No backfill
 *
 * No build before this step recorded an admission proof, so there is nothing
 * to derive a row from. Resolving each stored `project_root` now would record
 * whatever its links lead to at migration time — exactly the identification
 * after the fact this table exists to replace. Sessions stored before this
 * step therefore have no row, and `SessionManager.confirmProjectRoot` refuses
 * every sink of such a session (`PATH_OUTSIDE_PROJECT`, `project-out-of-scope`)
 * rather than identify its root: its pipeline can no longer index or patch,
 * and the developer starts a new session from the folder in VS Code. Such
 * sessions that have not ended are reported at `warn` by count only — never an
 * id or a path, because the line reaches the service log.
 */
const SESSION_ROOT_IDENTITIES_MIGRATION: StoreMigration = {
  version: 6,
  description: 'record the canonical project-root identity each session was admitted under',
  apply: (db, { logger }) => {
    db.exec(CREATE_SESSION_ROOT_IDENTITIES_SQL);

    const counted = db.prepare(COUNT_UNIDENTIFIED_LIVE_SESSIONS_SQL).get()?.['unidentified'];
    const unidentified =
      typeof counted === 'bigint' ? Number(counted) : typeof counted === 'number' ? counted : 0;

    if (unidentified > 0) {
      logger.warn(
        'some stored sessions that have not ended carry no recorded project-root identity; their pipelines are refused until a new session is started',
        { subsystem: SUBSYSTEM, unidentifiedSessions: unidentified },
      );
    }
  },
};

/* -------------------------------------------------------------------------------------------------
 * Version 7 — the tab bindings keyed by holder and tab
 *
 * Self-contained on purpose, as versions 4 and 6 are: every statement and
 * constant of this step lives in this section, so the step can be renumbered
 * as a unit should another ladder step land first.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The column naming the holder of a tab binding: the `tokenHash` of the
 * DevTools credential that made it — the value `../server/clients.ts` keys the
 * live binding by and `../server/auth.ts`'s `requireBoundSession` compares. A
 * digest, never a credential.
 *
 * ## Why the key changes
 *
 * A Chrome tab id is unique only within one browser profile. Two paired
 * extensions — two browsers, or two profiles of one — inspect tabs whose ids
 * collide, and a table keyed by `tab_id` alone let one browser's bind of its
 * tab 7 evict the other browser's binding of *its* tab 7: that session lost
 * its tab and the first principal was refused `TAB_NOT_BOUND` from then on.
 * Keyed by `(bound_by, tab_id)`, each holder's binding of a tab id is its own
 * row, while the unique index on `session_id` still gives a session one bound
 * tab across every holder (AAP §0.2.3).
 *
 * The empty string means "holder not recorded": every row this step copies,
 * because no earlier build recorded one. `./sessions-repo.ts` reads such a row
 * as part of every holder's view of its tab, so the first re-bind of that tab
 * — by whichever credential — consumes it exactly as a bind did before.
 */
const BINDING_HOLDER_COLUMN = 'bound_by';

/**
 * Whether `bindings` already declares {@link BINDING_HOLDER_COLUMN}: the probe
 * that makes the step idempotent — a store this step already re-keyed is left
 * alone — for the reason {@link CHAIN_FORK_COLUMN_EXISTS_SQL} gives.
 */
const BINDING_HOLDER_COLUMN_EXISTS_SQL = `SELECT 1 AS present FROM pragma_table_info('bindings') WHERE name = ?`;

/** The transient name the re-keyed table is built under before it replaces `bindings`. */
const REKEYED_BINDINGS_TABLE = 'bindings_rekeyed';

/**
 * The re-keyed table: the version-1 columns behind the holder, the composite
 * primary key, and the same foreign key and `STRICT` typing `./schema.sql`
 * declares for every table.
 */
const CREATE_REKEYED_BINDINGS_SQL = `CREATE TABLE ${REKEYED_BINDINGS_TABLE} (
  ${BINDING_HOLDER_COLUMN} TEXT    NOT NULL DEFAULT '',
  tab_id     INTEGER NOT NULL,
  session_id TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  url        TEXT    NOT NULL,
  bound_at   INTEGER NOT NULL,
  PRIMARY KEY (${BINDING_HOLDER_COLUMN}, tab_id)
) STRICT`;

/** Copies every existing binding into the re-keyed table, each as recording no holder. */
const COPY_BINDINGS_SQL = `INSERT INTO ${REKEYED_BINDINGS_TABLE} (${BINDING_HOLDER_COLUMN}, tab_id, session_id, url, bound_at)
SELECT '', tab_id, session_id, url, bound_at FROM bindings`;

/** Removes the version-1 table, and with it its index; nothing references `bindings`. */
const DROP_LEGACY_BINDINGS_SQL = 'DROP TABLE bindings';

/** Gives the re-keyed table the name every reader and writer uses. */
const RENAME_REKEYED_BINDINGS_SQL = `ALTER TABLE ${REKEYED_BINDINGS_TABLE} RENAME TO bindings`;

/**
 * One bound tab per session, enforced rather than merely indexed — the index
 * `./schema.sql` declares, re-created on the re-keyed table (and a no-op on a
 * store that already carries it).
 */
const CREATE_BINDINGS_SESSION_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_session_id ON bindings (session_id)';

/** How many rows the re-keyed table holds, to prove every row was copied. */
const COUNT_REKEYED_BINDINGS_SQL = `SELECT COUNT(*) AS n FROM ${REKEYED_BINDINGS_TABLE}`;

/** How many rows the version-1 table holds before it is dropped. */
const COUNT_LEGACY_BINDINGS_SQL = 'SELECT COUNT(*) AS n FROM bindings';

/** A `COUNT(*)` result as a number; `node:sqlite` may answer a `bigint`. */
function countOf(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : 0;
}

/**
 * Schema version 7: the tab bindings keyed by holder and tab — see
 * {@link BINDING_HOLDER_COLUMN} for why.
 *
 * The one step of the ladder that rebuilds a table, under the narrow exception
 * the module overview sets out: `bindings` is routing state, not part of the
 * modification journal, and SQLite cannot change a primary key in place. In
 * the step's single transaction the re-keyed table is created, every row is
 * copied into it recording no holder, the copy is counted against the source,
 * the version-1 table is dropped, and the re-keyed table takes its name and
 * its unique session index. A count that disagrees throws, so the transaction
 * rolls back and the store stays at version 6 with every row where it was.
 *
 * Idempotent: a store whose `bindings` already declares the holder column is
 * left as it is (only the unique session index is ensured). The adoption path
 * re-runs version 1's `IF NOT EXISTS` DDL first, which creates nothing over a
 * re-keyed table, so an adopted store reaches this step unchanged too.
 *
 * Only a count reaches the log — never a tab id, a session id or a URL.
 */
const BINDING_HOLDER_KEY_MIGRATION: StoreMigration = {
  version: 7,
  description: 'key the tab bindings by the credential that made them and the tab',
  apply: (db, { logger }) => {
    if (db.prepare(BINDING_HOLDER_COLUMN_EXISTS_SQL).get(BINDING_HOLDER_COLUMN) === undefined) {
      const existing = countOf(db.prepare(COUNT_LEGACY_BINDINGS_SQL).get()?.['n']);

      db.exec(CREATE_REKEYED_BINDINGS_SQL);
      db.prepare(COPY_BINDINGS_SQL).run();

      const copied = countOf(db.prepare(COUNT_REKEYED_BINDINGS_SQL).get()?.['n']);

      if (copied !== existing) {
        throw new Error(
          `Re-keying the tab bindings copied ${String(copied)} of ${String(existing)} rows.`,
        );
      }

      db.exec(DROP_LEGACY_BINDINGS_SQL);
      db.exec(RENAME_REKEYED_BINDINGS_SQL);

      logger.debug('re-keyed the tab bindings by holder and tab', {
        subsystem: SUBSYSTEM,
        keptBindings: copied,
      });
    }

    db.exec(CREATE_BINDINGS_SESSION_INDEX_SQL);
  },
};

/**
 * The store's schema ladder, in ascending version order.
 *
 * Adding a step is the only supported way to change the schema of a database
 * that may already exist on a developer's machine, and every step must be
 * additive for the reason set out in this module's overview: the modification
 * journal in here is what restores a developer's patched files, so an existing
 * database must always be able to migrate forward without losing a row. The
 * overview's one exception — a routing table outside the journal rebuilt, every
 * row copied, when its key must change — is version 7's alone.
 *
 * Version 1 establishes `./schema.sql`; version 2 enforces single-child
 * modification chains and adds the telemetry purge indexes
 * ({@link CHAIN_INTEGRITY_AND_PURGE_INDEXES_MIGRATION}); version 3 adds the
 * ordered telemetry lookup indexes
 * ({@link ORDERED_TELEMETRY_LOOKUP_INDEXES_MIGRATION}); version 4 adds the
 * session cleanup summary projection and backfills it from the stored
 * documents ({@link SESSION_CLEANUP_SUMMARIES_MIGRATION}); version 5 adds the
 * per-producer clock offset column ({@link PRODUCER_CLOCK_OFFSET_MIGRATION});
 * version 6 adds the persisted project-root identity, with no backfill
 * ({@link SESSION_ROOT_IDENTITIES_MIGRATION}); version 7 re-keys the tab
 * bindings by holder and tab, copying every row
 * ({@link BINDING_HOLDER_KEY_MIGRATION}).
 *
 * Appending a step is two edits in one commit. The step takes the next
 * version: one above the highest version in this list, which is the current
 * {@link STORE_SCHEMA_VERSION} plus one, written as an integer literal because
 * a shipped step keeps its version for ever. {@link STORE_SCHEMA_VERSION} is
 * then set to that same number. The check this module runs when it loads
 * refuses either edit without the other.
 *
 * The shape of a step, with `NEXT` standing for that next version:
 *
 * @example
 * ```ts
 * const CAPTURE_RETENTION_INDEX_MIGRATION: StoreMigration = {
 *   version: NEXT,
 *   description: 'add the capture retention index',
 *   apply: (db) => {
 *     db.exec(
 *       'CREATE INDEX IF NOT EXISTS idx_captures_stopped_at ON captures (stopped_at);',
 *     );
 *   },
 * };
 * ```
 */
export const STORE_MIGRATIONS: readonly StoreMigration[] = [
  {
    version: 1,
    description: 'initial schema',
    /**
     * Executes `./schema.sql` verbatim. Every statement in that file is
     * `IF NOT EXISTS`, so the step is idempotent — which is not a spare
     * property but one {@link applyMigrations} relies on: the adoption path
     * runs this step against a database that already carries part of the
     * schema, where it must leave every existing object alone and create only
     * what is missing.
     */
    apply: (db, { ddl }) => {
      db.exec(ddl);
    },
  },
  CHAIN_INTEGRITY_AND_PURGE_INDEXES_MIGRATION,
  ORDERED_TELEMETRY_LOOKUP_INDEXES_MIGRATION,
  SESSION_CLEANUP_SUMMARIES_MIGRATION,
  PRODUCER_CLOCK_OFFSET_MIGRATION,
  SESSION_ROOT_IDENTITIES_MIGRATION,
  BINDING_HOLDER_KEY_MIGRATION,
];

/**
 * The ladder's bottom rung — the step that establishes the version-1 schema,
 * and the step the adoption path runs to complete a database that carries only
 * part of it.
 *
 * Resolved from the ladder rather than reached for as `STORE_MIGRATIONS[0]`, and
 * never re-expressed as a second call to `db.exec(ddl)`, so adoption and a fresh
 * install run the identical step and no future ladder can develop a second
 * opinion about where it starts or what its first rung does. Resolving it here
 * is also what validates the whole ladder when this module loads.
 */
const INITIAL_SCHEMA_MIGRATION = readInitialSchemaMigration(STORE_MIGRATIONS);

/**
 * The version the initial schema step establishes — the version an adopted
 * database is stamped with, before any later step runs.
 */
const INITIAL_SCHEMA_VERSION = INITIAL_SCHEMA_MIGRATION.version;

/**
 * What {@link applyMigrations} did.
 *
 * `applied` is empty on both paths that migrate nothing forward, which is why
 * `adopted` exists to tell them apart: an already-current database returns
 * `{ applied: [], adopted: false }` and wrote nothing at all, while a database
 * that carried the schema without the stamp returns
 * `{ applied: [], adopted: true }` — it was completed and stamped at the
 * ladder's bottom rung rather than migrated up from a stamped version.
 */
export interface MigrationOutcome {
  /** The version the database was at before this call. `0` for a new file. */
  fromVersion: number;

  /**
   * The version stamped in the database when this call returned. Equals
   * {@link STORE_SCHEMA_VERSION} on every success.
   */
  toVersion: number;

  /**
   * The versions of the ladder steps this call ran to migrate the database
   * forward, in the order run. The bottom rung the adoption path re-runs to
   * complete an unstamped schema is reported by {@link MigrationOutcome.adopted}
   * instead, because it moved the database to no version it was not already at.
   */
  applied: readonly number[];

  /**
   * Whether an existing, unstamped schema was adopted — schema objects were
   * already present at version `0`, so the ladder's bottom rung ran only to
   * create whatever that database was missing, and is reported here rather than
   * in {@link MigrationOutcome.applied}.
   */
  adopted: boolean;
}

/**
 * Inputs to {@link applyMigrations}.
 *
 * The two optional members are injection points rather than conveniences: the
 * colocated store suites drive the ladder with a collecting logger and a pinned
 * clock, which is how the "a second start writes nothing" guarantee is asserted
 * on `meta.updated_at`. Both declare `| undefined` explicitly so a caller
 * assembling options from its own optional configuration can pass the property
 * through without narrowing it first — the repository compiles with
 * `exactOptionalPropertyTypes`, under which `logger?: Logger` would reject
 * `{ logger: undefined }`.
 */
export interface ApplyMigrationsOptions {
  /**
   * The full text of `./schema.sql`, from the caller's loader. Must be
   * non-empty: an empty string means the loader resolved nothing, and executing
   * it would leave an empty database stamped as migrated.
   */
  readonly ddl: string;

  /** Where to report progress. Defaults to the shared no-op logger. */
  readonly logger?: Logger | undefined;

  /**
   * The clock used for the `created_at` and `updated_at` bookkeeping rows, in
   * Unix epoch milliseconds. Defaults to the shared `nowEpochMs`.
   */
  readonly now?: (() => number) | undefined;
}

/**
 * The version stamped in `db`'s header, from `PRAGMA user_version`.
 *
 * `0` on a database this tool has never migrated — the value SQLite gives a
 * freshly created file, and also the value an older build left behind if it
 * created the schema without stamping it, which is why
 * {@link applyMigrations} distinguishes the two by probing for a table rather
 * than by the version alone.
 *
 * @param db An open database handle.
 * @returns The stamped version, as a non-negative integer.
 * @throws A {@link DebuggenError} with code `STORE_ERROR` when the pragma
 * returns nothing, or returns a value that is not an integer — either means the
 * handle is not a working SQLite connection, which every caller has to treat as
 * a failure to open the store rather than as version `0`.
 */
export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare(READ_USER_VERSION_SQL).get();
  const value = row?.['user_version'];

  // `bigint` is accepted because a connection opened with `readBigInts` returns
  // integers in that form; the header field is 32-bit, so the conversion is
  // always exact.
  const version = typeof value === 'bigint' ? Number(value) : value;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new DebuggenError(
      'STORE_ERROR',
      'Reading the schema version of the session store returned no usable value.',
      {
        hint: 'The store file may be corrupt. Close the service and remove $DEBUGGEN_HOME/sessions.sqlite to start a new store; past sessions are lost, instrumented files are not.',
        details: { subsystem: SUBSYSTEM, pragma: 'user_version', received: typeof value },
      },
    );
  }

  return version;
}

/**
 * The value of one `meta` row, or `undefined` when there is none.
 *
 * Tolerates the table being absent, which is the state of a brand-new database
 * before the first ladder step runs: `meta` is declared by the version-1 DDL,
 * so a caller reading bookkeeping before migration — or after a refusal — must
 * not have to guard the call itself.
 *
 * @param db An open database handle.
 * @param key The `meta` key, for example `schema_version`.
 * @returns The stored text, or `undefined` when the table or the row is absent.
 */
export function readMetaValue(db: DatabaseSync, key: string): string | undefined {
  if (!tableExists(db, META_TABLE)) {
    return undefined;
  }

  const value = db.prepare(READ_META_SQL).get(key)?.['value'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Whether `db` declares a table of exactly this name.
 *
 * @param db An open database handle.
 * @param name The table name, matched exactly and case-sensitively.
 * @returns `true` when the table exists.
 */
function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare(TABLE_EXISTS_SQL).get(name) !== undefined;
}

/**
 * Stamps `version` into the database header.
 *
 * `PRAGMA user_version` takes no bound parameter, so the value is interpolated
 * — and therefore asserted first. The assertion is not defence against a
 * hostile caller (the versions come from this module's own ladder, which is
 * validated when the module loads) but against a truncated stamp: a value
 * outside the header's signed 32-bit range would be written as something no
 * later start recognises.
 *
 * @param db An open database handle, inside the caller's transaction.
 * @param version The version to stamp.
 * @throws A {@link DebuggenError} when `version` is not a positive integer
 * within the header's range.
 */
function stampSchemaVersion(db: DatabaseSync, version: number): void {
  assert(
    Number.isInteger(version) && version > 0 && version <= MAX_USER_VERSION,
    `A store schema version must be a positive integer no greater than ${MAX_USER_VERSION}; received ${version}.`,
  );
  db.exec(`PRAGMA user_version = ${version}`);
}

/**
 * Writes the bookkeeping rows that mirror a stamp.
 *
 * Called inside the same transaction as the stamp it describes, so the mirror
 * cannot disagree with the header: either both land or neither does.
 * `created_at` is written only when absent, the other three are upserted, and
 * every statement is idempotent, so re-running the write after a crash between
 * two steps changes nothing but `updated_at`.
 *
 * @param db An open database handle, inside the caller's transaction.
 * @param fields The stamped version, the DDL digest and the current time.
 * @throws Any error the statements raise; the caller rolls back and wraps it.
 */
function writeMetaRows(
  db: DatabaseSync,
  fields: { readonly version: number; readonly ddlSha256: string; readonly nowMs: number },
): void {
  const { version, ddlSha256, nowMs } = fields;
  assert(
    Number.isFinite(nowMs),
    'The clock given to the store migration ladder must return a finite epoch-millisecond value.',
  );

  const timestamp = String(Math.trunc(nowMs));
  const upsert = db.prepare(UPSERT_META_SQL);
  upsert.run(META_KEYS.schemaVersion, String(version));
  upsert.run(META_KEYS.ddlSha256, ddlSha256);
  upsert.run(META_KEYS.updated, timestamp);
  db.prepare(INSERT_META_IF_ABSENT_SQL).run(META_KEYS.created, timestamp);
}

/**
 * Runs `work` inside a `BEGIN IMMEDIATE` transaction, rolling back if it throws.
 *
 * `IMMEDIATE` rather than a deferred begin: the write lock is taken up front,
 * so a second service process racing to migrate the same store fails at the
 * `BEGIN` — where the busy timeout `./db.ts` set applies and the failure is
 * reported before any statement ran — instead of part-way through the ladder
 * when the first write is attempted.
 *
 * @param db An open database handle with no transaction in progress.
 * @param logger Where a secondary rollback failure is noted.
 * @param work The statements to run; must not issue transaction control.
 * @throws Whatever `work` threw, after the rollback attempt.
 */
function runInTransaction(db: DatabaseSync, logger: Logger, work: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    work();
    db.exec('COMMIT');
  } catch (cause) {
    rollbackQuietly(db, logger);
    throw cause;
  }
}

/**
 * Rolls back the open transaction, reporting a failure to do so at `debug`
 * instead of raising it.
 *
 * The rollback runs on a path that is already failing, and the original cause is
 * the one the caller has to report. A rollback error is also routinely benign:
 * SQLite aborts the transaction itself for some errors, and the explicit
 * `ROLLBACK` that follows then reports that no transaction is active. Either
 * way the durable state is the pre-transaction state, which is the guarantee
 * this path exists to provide.
 *
 * @param db An open database handle.
 * @param logger Where the note goes.
 */
function rollbackQuietly(db: DatabaseSync, logger: Logger): void {
  try {
    db.exec('ROLLBACK');
  } catch (rollbackCause) {
    logger.debug('rolling back a failed store migration step reported an error', {
      subsystem: SUBSYSTEM,
      reason: DebuggenError.from(rollbackCause, 'STORE_ERROR').message,
    });
  }
}

/**
 * Wraps a caught value as the typed error the service reports, keeping the
 * original reachable as `cause`.
 *
 * {@link DebuggenError.from} is what normalises the value — `catch` binds
 * `unknown`, and a raw `node:sqlite` error is a plain `Error` — and its code is
 * carried over, so a specific code raised deeper survives while anything else
 * becomes `STORE_ERROR`. The underlying message goes into `details.reason`
 * rather than into the message line, which keeps what a user interface renders
 * short and stable.
 *
 * @param cause The caught value.
 * @param message A complete sentence naming what failed.
 * @param hint The developer's next step.
 * @param details Diagnostic context. Holds identifiers, versions and reasons
 * only: this object is logged and may be persisted with a session, so nothing
 * user-supplied belongs in it.
 * @returns The error to return inside an `Err`.
 */
function wrapStoreFailure(
  cause: unknown,
  message: string,
  hint: string,
  details: LogFields,
): DebuggenError {
  const normalized = DebuggenError.from(cause, 'STORE_ERROR');
  return new DebuggenError(normalized.code, message, {
    hint,
    details: { subsystem: SUBSYSTEM, ...details, reason: normalized.message },
    cause,
  });
}

/**
 * Validates the ladder and returns its lowest step.
 *
 * Runs once, when this module is loaded, because a malformed ladder is a
 * programmer error in this repository rather than a runtime condition a
 * developer could act on: a duplicate, unordered or non-integer version, or a
 * highest version that disagrees with {@link STORE_SCHEMA_VERSION}, would make
 * every decision below unsound. Failing at load makes it the first thing the
 * service's own start and every store suite report.
 *
 * The step itself is returned, not just its version, because the adoption path
 * executes it: the bottom rung is what establishes the version-1 schema, and
 * adoption has to run the same one the ladder would.
 *
 * @param migrations The ladder, as authored.
 * @returns The first step.
 * @throws A {@link DebuggenError} when the ladder is empty, out of order, holds
 * a duplicate or non-integer version, or does not end at
 * {@link STORE_SCHEMA_VERSION}.
 */
function readInitialSchemaMigration(migrations: readonly StoreMigration[]): StoreMigration {
  const first = migrations[0];
  assert(first !== undefined, 'The store schema ladder must declare at least one step.');

  let previous = 0;
  for (const step of migrations) {
    assert(
      Number.isInteger(step.version) && step.version > 0 && step.version <= MAX_USER_VERSION,
      `Store migration versions must be positive integers no greater than ${MAX_USER_VERSION}; found ${step.version}.`,
    );
    assert(
      step.version > previous,
      `The store schema ladder must be strictly ascending; version ${step.version} follows ${previous}.`,
    );
    assert(
      step.description.length > 0,
      `Store migration ${step.version} must carry a description.`,
    );
    previous = step.version;
  }

  assert(
    previous === STORE_SCHEMA_VERSION,
    `The highest store migration version (${previous}) must equal STORE_SCHEMA_VERSION (${STORE_SCHEMA_VERSION}); bump the constant in the same commit as the step.`,
  );

  return first;
}

/**
 * Notes a difference between the DDL this build carries and the one the
 * database was migrated with, at `warn`, and never as a failure.
 *
 * The digest is a diagnostic: a comment or whitespace edit to `./schema.sql`
 * changes it without changing a single schema object, and refusing to open a
 * store over that would turn a documentation edit into an outage. What the line
 * is for is the other case — a developer running a build whose schema text has
 * moved on while the ladder version has not — where it is the only hint
 * available.
 *
 * @param db An open database handle, already at the current version.
 * @param ddlSha256 The digest of the DDL this call was given.
 * @param logger Where the note goes.
 */
function warnOnDigestDrift(db: DatabaseSync, ddlSha256: string, logger: Logger): void {
  let recorded: string | undefined;
  try {
    recorded = readMetaValue(db, META_KEYS.ddlSha256);
  } catch (cause) {
    // The mirror is unreadable while the header says the schema is current.
    // That is worth a line, and nothing more: no caller's behaviour depends on
    // this table, and the store itself is usable.
    logger.debug('could not read the recorded store schema digest', {
      subsystem: SUBSYSTEM,
      reason: DebuggenError.from(cause, 'STORE_ERROR').message,
    });
    return;
  }

  if (recorded !== undefined && recorded !== ddlSha256) {
    logger.warn('the store schema text differs from the one this database was migrated with', {
      subsystem: SUBSYSTEM,
      schemaVersion: STORE_SCHEMA_VERSION,
      recordedDdlSha256: recorded,
      currentDdlSha256: ddlSha256,
    });
  }
}

/**
 * Brings an opened store up to {@link STORE_SCHEMA_VERSION}, doing nothing when
 * it is already there.
 *
 * This is the one entry point of the module and the only function `./db.ts`
 * calls. It is safe to call on every start and on a database in any of the four
 * states the module overview tabulates; it takes the write lock only when there
 * is something to write, and it leaves the database untouched on every failure
 * path.
 *
 * ## Guarantees
 *
 * - **An already-current database is read-only.** The decision costs one header
 *   read plus, at most, one `meta` read for the digest comparison. No
 *   transaction is opened, so a second start cannot even refresh a timestamp —
 *   which is exactly what the store suites assert by snapshotting
 *   `meta.updated_at` across two calls.
 * - **Every step is all-or-nothing.** A step's statements, the version stamp
 *   and the bookkeeping rows commit together inside one `BEGIN IMMEDIATE`
 *   transaction, so a crash or a failing statement leaves the previous version
 *   intact rather than a partially created schema. A ladder of several steps
 *   commits each rung separately, which means an interrupted run resumes from
 *   the last completed rung on the next start instead of starting over.
 * - **An unstamped database is completed before it is stamped.** Finding the
 *   schema already there is treated as a reason to skip *creating* it, never as
 *   proof that all of it is there: the version-1 DDL runs inside the adoption
 *   transaction, so a database carrying only part of the schema — an
 *   interrupted or hand-edited legacy migration — leaves this call with the
 *   missing tables and indexes created rather than with a stamp claiming they
 *   exist. It is idempotent, so on a complete database it creates nothing.
 * - **A newer database is refused, never downgraded.** Running an older build
 *   against a store a newer one wrote returns an error rather than reinterpreting
 *   its rows — the modification journal in there is what restores a developer's
 *   patched files, and misreading it is worse than refusing to start.
 * - **Nothing escapes as an exception** except a broken invariant in this
 *   repository's own ladder, which is validated when the module loads. Every
 *   condition a developer could cause or act on arrives as an `Err` carrying a
 *   code, a message and a hint, which is what the service's entry point reports
 *   before exiting.
 *
 * @param db An open `node:sqlite` handle with its pragmas already set by
 * `./db.ts` and no transaction in progress.
 * @param options The schema text, and optionally a logger and a clock.
 * @returns `Ok` with the versions and the steps applied, or `Err` with a
 * {@link DebuggenError} describing why the store cannot be used.
 *
 * @example Opening a store
 * ```ts
 * const outcome = applyMigrations(db, { ddl, logger });
 * if (isErr(outcome)) {
 *   logger.fatal(outcome.error.message, { hint: outcome.error.hint });
 *   process.exit(1);
 * }
 * logger.info('store ready', { version: outcome.value.toVersion });
 * ```
 */
export function applyMigrations(
  db: DatabaseSync,
  options: ApplyMigrationsOptions,
): Result<MigrationOutcome, DebuggenError> {
  const { ddl } = options;
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? nowEpochMs;

  if (ddl.trim().length === 0) {
    return err(
      new DebuggenError(
        'STORE_ERROR',
        'The session store schema text is empty, so there is nothing to migrate.',
        {
          hint: 'This is a packaging fault rather than a setting: rebuild or reinstall Debug Generator so the store schema ships beside the service entry point.',
          details: { subsystem: SUBSYSTEM, ddlLength: ddl.length },
        },
      ),
    );
  }

  const ddlSha256 = sha256Hex(ddl);

  let fromVersion: number;
  try {
    fromVersion = readSchemaVersion(db);
  } catch (cause) {
    return err(
      wrapStoreFailure(
        cause,
        'Could not read the schema version of the session store.',
        REPAIR_HINT,
        {},
      ),
    );
  }

  // State 1 — already current. The common case, and the reason the version
  // lives in the file header: decided without a transaction and without a write.
  if (fromVersion === STORE_SCHEMA_VERSION) {
    warnOnDigestDrift(db, ddlSha256, logger);
    logger.debug('session store schema is already current', {
      subsystem: SUBSYSTEM,
      fromVersion,
      toVersion: fromVersion,
    });
    return ok({ fromVersion, toVersion: fromVersion, applied: [], adopted: false });
  }

  // State 2 — written by a newer build. Refuse rather than reinterpret.
  if (fromVersion > STORE_SCHEMA_VERSION) {
    return err(
      new DebuggenError(
        'STORE_ERROR',
        `The session store is at schema version ${fromVersion}, which is newer than version ${STORE_SCHEMA_VERSION} that this build understands.`,
        {
          hint: 'Update Debug Generator to the build that wrote this store, or stop the service and remove $DEBUGGEN_HOME/sessions.sqlite to start a fresh one: past sessions are lost, and files instrumented by those sessions are not restored by that removal.',
          details: { subsystem: SUBSYSTEM, fromVersion, expectedVersion: STORE_SCHEMA_VERSION },
        },
      ),
    );
  }

  // States 3 and 4 — the database is behind. `version` tracks what is stamped
  // as the work proceeds, so an error message can say where the store stands.
  let version = fromVersion;
  let adopted = false;
  const context: MigrationContext = { ddl, logger, now };

  // State 3 — schema objects are present but were never stamped, which is what
  // a database created by a build that predated version stamping looks like.
  // Adoption stamps the bottom of the ladder rather than the top, because every
  // later rung still has to run afterwards.
  //
  // Adoption completes the schema before it stamps it, and that ordering is the
  // point. The probe below establishes that *some* of the version-1 schema is
  // there, which is not the same as all of it: a database left behind by an
  // interrupted or hand-edited legacy migration can carry `sessions` and `meta`
  // while later tables and indexes are missing. Stamping that would tell every
  // later start the schema is current — the ladder skips a rung at or below the
  // stamped version — and leave the repositories to fail against the gaps,
  // including the modification journal, which is the only record able to restore
  // a developer's patched files. So the initial rung runs first, inside the same
  // transaction as the stamp: every statement in the version-1 DDL is
  // `IF NOT EXISTS`, so it leaves every object that already exists untouched and
  // creates exactly what is missing, and the stamp then describes a schema that
  // is genuinely complete. On an already-complete database it creates nothing.
  if (version === 0) {
    let schemaPresent: boolean;
    try {
      // Both tables, because what the probe asks is whether an earlier build of
      // this tool wrote this database at all: the root of the store's
      // foreign-key graph, and the bookkeeping table this module owns. A
      // database carrying neither is a new file, and creating the schema through
      // the ladder — reported as `adopted: false`, with version 1 in `applied` —
      // describes what happened to it more accurately than adoption would. What
      // the probe deliberately does not claim is that the schema is complete;
      // the DDL executed inside the transaction below is what makes it so.
      schemaPresent = tableExists(db, ADOPTION_PROBE_TABLE) && tableExists(db, META_TABLE);
    } catch (cause) {
      return err(
        wrapStoreFailure(
          cause,
          'Could not inspect the session store to decide whether its schema already exists.',
          REPAIR_HINT,
          { fromVersion },
        ),
      );
    }

    if (schemaPresent) {
      try {
        runInTransaction(db, logger, () => {
          // The ladder's own bottom rung, not a second copy of it: whatever
          // version 1 means to the ladder is what an adopted database gets.
          // Idempotent, so this is a no-op on the objects already there.
          INITIAL_SCHEMA_MIGRATION.apply(db, context);
          stampSchemaVersion(db, INITIAL_SCHEMA_VERSION);
          writeMetaRows(db, { version: INITIAL_SCHEMA_VERSION, ddlSha256, nowMs: now() });
        });
      } catch (cause) {
        return err(
          wrapStoreFailure(
            cause,
            `Could not complete and record schema version ${INITIAL_SCHEMA_VERSION} on the existing session store.`,
            REPAIR_HINT,
            { fromVersion, targetVersion: INITIAL_SCHEMA_VERSION },
          ),
        );
      }

      version = INITIAL_SCHEMA_VERSION;
      adopted = true;
      logger.info('adopted an existing session store schema', {
        subsystem: SUBSYSTEM,
        fromVersion,
        toVersion: version,
      });
    }
  }

  // State 4 — apply every rung above the stamped version, lowest first, each in
  // its own transaction so an interruption resumes from the last completed one.
  const applied: number[] = [];

  for (const step of STORE_MIGRATIONS) {
    if (step.version <= version) {
      continue;
    }

    try {
      runInTransaction(db, logger, () => {
        step.apply(db, context);
        stampSchemaVersion(db, step.version);
        writeMetaRows(db, { version: step.version, ddlSha256, nowMs: now() });
      });
    } catch (cause) {
      return err(
        wrapStoreFailure(
          cause,
          `Store migration ${step.version} (${step.description}) failed; the session store is unchanged at schema version ${version}.`,
          REPAIR_HINT,
          {
            fromVersion,
            failedVersion: step.version,
            description: step.description,
            appliedVersions: [...applied],
          },
        ),
      );
    }

    logger.info(`applied store migration ${step.version} (${step.description})`, {
      subsystem: SUBSYSTEM,
      fromVersion: version,
      toVersion: step.version,
    });
    applied.push(step.version);
    version = step.version;
  }

  // A postcondition rather than a runtime check: the ladder validated when this
  // module loaded ends at STORE_SCHEMA_VERSION, and every rung above the
  // stamped version has just run, so reaching here at any other version would
  // mean the loop above skipped a rung.
  assert(
    version === STORE_SCHEMA_VERSION,
    `The session store finished migration at version ${version} instead of ${STORE_SCHEMA_VERSION}.`,
  );

  return ok({ fromVersion, toVersion: version, applied, adopted });
}
