/**
 * The retention sweep: the one module that deletes aged state from the session
 * database and from the `$DEBUGGEN_HOME` directory tree.
 *
 * Everything the product keeps about a debugging session lives outside the
 * developer's project — a row per session and its children in
 * `sessions.sqlite`, one backup directory per session under `backups/`, and
 * the code-index cache under `index/` (AAP 0.4.2). None of it is needed
 * forever, and some of it is sensitive: questions, file paths, redacted
 * telemetry. This module removes what has aged out, and it is written around
 * the one thing it must never do — destroy the only copy of a developer's
 * original file.
 *
 * ## The three rules, in the order they run
 *
 * 1. **Aged sessions.** A session whose `sessions.updated_at` — its last
 *    activity, not its creation — is older than the retention window is
 *    deleted, and the schema's `ON DELETE CASCADE` edges remove everything
 *    scoped to it: progress, plans, the modification journal, captures and
 *    their telemetry, panels, analyses, follow-ups, its tab binding and its
 *    request-key secret. Its backup directory is removed afterwards. A session
 *    whose journal still holds a `conflict` record is **retained** — together
 *    with its backups — until the developer resolves the conflict (AAP 0.5.1).
 *    A session that is still **active** is retained too, however old its last
 *    update: one in a pipeline stage (`understanding` through `analyzing`,
 *    including `capturing`), one with an open capture window — ingest into an
 *    open window does not touch `updated_at` — and one the caller reports as
 *    in use. Such a session ages out once the developer ends it or it settles.
 * 2. **Orphan backups.** A file under `backups/<sessionId>/` that no journal
 *    row references is deleted once it is older than
 *    {@link ORPHAN_BACKUP_GRACE_DAYS}. A row references a file when the file
 *    is its composed backup — `backups/<sessionId>/<originalHash>` — or when
 *    its recorded `backup_path` names the file; only the rows of the
 *    directory's own session can, because the backup store never resolves a
 *    record to another session's directory. The grace window exists because the
 *    patcher writes the backup *before* it journals the record: a crash in
 *    between leaves a legitimately unreferenced file, and a concurrent install
 *    may be about to claim a younger one.
 * 3. **Index caches.** An entry of the code-index cache whose project has not
 *    been opened inside the window is deleted, and so — whatever its age — is
 *    one nothing will read again: an entry written under an older envelope
 *    version, and every entry of a project but its newest. A cache is a
 *    derived artifact: deleting one costs a re-index, never data.
 *
 * Then, and only when the sweep deleted something, the pages it freed are
 * returned to the filesystem and the write-ahead log is folded back into the
 * database (see "Returning space to the filesystem" below).
 *
 * ## Returning space to the filesystem
 *
 * A `DELETE` frees database pages but does not shrink the file: SQLite keeps
 * them on its freelist for reuse. After a real sweep that deleted anything,
 * the reclaim reads `PRAGMA auto_vacuum`, `page_size`, `page_count` and
 * `freelist_count` and acts on the store's mode:
 *
 * - **`INCREMENTAL` (2)** — `PRAGMA incremental_vacuum` releases the freelist
 *   in steps of {@link INCREMENTAL_VACUUM_STEP_PAGES}, yielding to the event
 *   loop and checking the signal between steps, until the freelist is empty or
 *   a step makes no progress.
 * - **`NONE` (0)** — the store is converted **once**, `PRAGMA auto_vacuum =
 *   INCREMENTAL` then `VACUUM`, which compacts it and makes every later sweep
 *   take the incremental path. `VACUUM` rewrites the live data and blocks for
 *   as long as that takes, so it runs only when the free share reaches
 *   {@link VACUUM_CONVERSION_MIN_FREE_SHARE}, the free bytes reach
 *   {@link VACUUM_CONVERSION_MIN_FREE_BYTES} and the live bytes stay within
 *   {@link VACUUM_CONVERSION_MAX_LIVE_BYTES} (each tunable through
 *   {@link RetentionOptions.reclaim}), and never inside a transaction.
 *   Otherwise the pages stay reusable, and why is logged at `info`.
 * - **`FULL` (1)** — nothing more: SQLite truncates the file at every commit.
 *
 * A `wal_checkpoint(TRUNCATE)` follows, so the file actually shrinks, and the
 * report states the real shrink in {@link RetentionReport.databaseBytesReclaimed}.
 * No reclaim runs in a dry run or after an abort, and a reclaim that fails is a
 * {@link RetentionIssue}, never an `Err`: the purged rows are gone either way,
 * and their pages are reused until the next sweep returns them.
 *
 * ## Where this runs
 *
 * `src/main.ts` runs start-up modification reconciliation first and this sweep
 * second, and the editor command `debuggen.purgeSessions` runs it on demand
 * while the service serves — **scoped** to the editor's workspace (see "Scoped
 * sweeps" below), while the start-up pass stays machine-wide. The sweep holds
 * the write lock for at most one bounded transaction at a time (see "Atomic per
 * session, bounded per transaction") and stops at the next step boundary once
 * {@link RetentionOptions.signal} is aborted, so it can run beside a serving
 * service and be cut short by a shutdown. Because reconciliation has already moved
 * every `pending`, `applied` and `failed` record to `reverted` or `conflict`
 * by the time the start-up sweep runs, `conflict` is the realistic open state
 * here — which is why the conflict exemption is the rule that protects real
 * developer data. A session
 * still holding some *other* open record is not purged either: the journal is
 * the only description of a patched file, so the session is retained and the
 * fact is reported as a {@link RetentionIssue} for the next reconciliation to
 * settle.
 *
 * ## Scoped sweeps
 *
 * An on-demand purge acts for one editor, whose credential may act only on
 * projects under the workspace folders it announced, so it must not remove
 * another workspace's state (CWE-863). {@link RetentionOptions.scope}
 * narrows every rule to the projects the scope admits, and to state whose
 * project is known:
 *
 * - **Aged sessions** — an aged session is considered only when the scope
 *   admits its stored project root, read by id before anything else about it;
 *   any other session is skipped entirely — not decided, not retained, not
 *   reported. The root of a session never changes, so the check needs no place
 *   in the deleting transaction.
 * - **Orphan backups** — `backups/<sessionId>/` is walked only for a session
 *   whose row still exists and whose root the scope admits. A directory whose
 *   row is gone has no known project, and a stray file directly under
 *   `backups/` belongs to none: both are left to the machine-wide start-up
 *   sweep.
 * - **Index caches** — an entry is removed only when it records at least one
 *   project root and the scope admits every one; an entry that records none,
 *   or one outside the scope, is kept. A file-shaped entry must be a readable
 *   document recording a root. A directory-shaped entry is inspected whole
 *   rather than sampled: it is removed only when it holds at most
 *   {@link MAX_INDEX_METADATA_FILES} `*.json` documents and no subdirectory,
 *   every document was read, each records at least one root, and the scope
 *   admits every root recorded; otherwise it is kept, and why is logged at
 *   `debug`.
 *
 * A scope may answer asynchronously — `session.purge`'s resolves each root to
 * its canonical location on disk, so a link inside workspace A that points
 * into B is B's — and every answer is awaited before, never inside, the
 * `BEGIN IMMEDIATE` transaction that decides a session. A scope that throws,
 * rejects or answers anything but `true` is read as "outside" — the direction
 * that keeps data — and only the failure's code is logged. Every other
 * guarantee of this module holds unchanged in a scoped sweep, and the
 * machine-wide start-up sweep removes exactly what it removed before.
 *
 * ## Atomic per session, bounded per transaction
 *
 * Every rule that makes a session eligible is re-read inside a `BEGIN
 * IMMEDIATE` transaction before anything of it is deleted there: the row still
 * exists, it is still older than the cutoff, it is not active, its journal
 * holds no open or conflicting record, and the caller does not claim it.
 * `node:sqlite` is synchronous, so such a transaction holds the event loop as
 * well as the write lock, and what it may delete is bounded accordingly:
 *
 * - **A session of at most {@link DEFAULT_PURGE_BATCH_SIZE} telemetry events**
 *   — the telemetry store's largest accepted write-lock hold — is decided and
 *   deleted in **one** transaction: its row goes, and the cascade takes every
 *   child row in the same statement. A session refreshed at any moment of the
 *   sweep either keeps every row it had or loses the row and its evidence
 *   together, and a failure anywhere in the cascade rolls the whole session
 *   back.
 * - **A larger session is drained.** Each transaction re-runs every check and
 *   only then deletes one batch of its oldest events
 *   (`DELETE_SESSION_BATCH_SQL`, {@link DEFAULT_PURGE_BATCH_SIZE} rows); the
 *   sweep yields to the event loop between batches; and once no more than one
 *   batch remains, the final transaction deletes the row with the cascade
 *   exactly as above. The guarantee is narrower for such a session: one that
 *   becomes ineligible part-way — refreshed, claimed as in use, a capture
 *   opened, a conflict marked — keeps its row, plans, panels, analyses,
 *   journal, backups and every event not yet drained, while the batches
 *   already committed stay deleted, and the stop is logged at `warn` with the
 *   session id and the drained count. A store failure in a later batch keeps
 *   what the earlier ones committed too; it is reported as a
 *   {@link RetentionIssue}, the sweep carries on with the next session, and the
 *   next sweep resumes the drain.
 *
 * The sweep yields to the event loop after every deleted session, between
 * drain batches and between pages, so the hold is bounded by one batch —
 * never by the largest session, never by the backlog.
 *
 * ## The write-ahead log during a sweep
 *
 * A batch is short only if its commit is. By default SQLite folds the
 * write-ahead log back into the database file inside whichever commit pushes
 * the log past its threshold, and with `synchronous = NORMAL` that is where
 * the `fsync` happens — on the event loop, for as long as the disk takes. A
 * purge commits a batch every few hundred milliseconds and grows the log by
 * tens of megabytes per batch, so on a busy disk nearly every commit paid for
 * a checkpoint, and a single one held the service for seconds.
 *
 * A real sweep of a file-backed store therefore takes the checkpoint out of the
 * commit while it deletes and reclaims: it suspends the connection's
 * commit-time checkpoint (`./db.ts` {@link suspendAutoCheckpoint}) and, after
 * every committed batch, every deleted session and every reclaim step, checks
 * the log's size. Once the log reaches
 * {@link RetentionOptions.walCheckpointBytes} — {@link RETENTION_WAL_CHECKPOINT_BYTES}
 * by default — the sweep **waits** for a checkpoint run by a worker thread on
 * a connection of its own (`./db.ts` {@link openWalCheckpointer}) before its
 * next transaction. The wait is what bounds the log; the thread is what keeps
 * the event loop free while it lasts. The connection's own threshold is
 * restored when the sweep ends, however it ends. A checkpoint that fails
 * restores it at once, and the rest of the sweep runs with SQLite's own
 * checkpoints, as before. The in-memory store has no log and is unaffected;
 * a dry run writes nothing and changes nothing.
 *
 * ## Bounded work
 *
 * Candidates are read in keyset pages of {@link RETENTION_CANDIDATE_PAGE_SIZE}
 * — an index range read of `(updated_at, rowid)`, with no sort however many
 * sessions share a timestamp — and each page is purged before the next is
 * read, so memory does not grow with the backlog. The journal is never read
 * whole: a backup lives in the directory of the session whose record protects
 * it, and no other session's record can resolve to it, so a purged session's
 * directory needs no journal read at all, and an old file in
 * `backups/<sessionId>/` is checked against that one session's records through
 * an indexed probe, in batches of at most {@link BACKUP_PROBE_BATCH_SIZE}. A
 * start-up with nothing aged reads no journal row. The report's id lists and
 * issues are capped at {@link MAX_REPORTED_ITEMS}, with
 * {@link RetentionReport.omitted} counting the rest, while every count stays
 * exact.
 *
 * ## Containment
 *
 * Nothing outside `$DEBUGGEN_HOME` may ever be touched — least of all a file
 * inside a developer's project — so every destructive helper below:
 *
 * - takes the resolved absolute path and re-asserts `isWithin(debuggenHome,
 *   path)` **immediately before** the `unlink`, `rmdir` or `rm` call, so no
 *   future caller can skip the check;
 * - `lstat`s the target and refuses a symbolic link rather than following it —
 *   never `realpath`-then-delete;
 * - re-`lstat`s the containing directory and compares its device and inode
 *   with what the walk observed, so a directory swapped for a link between the
 *   decision and the deletion is refused instead of redirecting the operation.
 *
 * `isWithin` is lexical — it treats `/home-evil` as outside `/home` but cannot
 * see a link — which is why every containment check has an `lstat` beside it.
 * A tree is surveyed before it is removed, and one that holds a link anywhere
 * inside it is reported and left in place rather than removed; `fs.rm` with
 * `recursive` would only unlink such a link and never reach its target, which
 * is the second line of defence should one appear after the survey.
 *
 * ## Results and resilience
 *
 * {@link runRetention} answers with a `Result`. An `Err` means the sweep could
 * not run at all — a closed store, a configuration whose paths are not nested
 * inside the state root, an unusable clock. Every per-item problem (a backup
 * that cannot be removed, a planted link, a row that no longer parses) is
 * recorded in {@link RetentionReport.errors} and the sweep continues: the
 * guarantee is that one bad item never aborts the pass. An aborted
 * {@link RetentionOptions.signal} is not an `Err` either: the sweep starts no
 * further work, skips the database reclaim, and answers `Ok` with the counts
 * so far and {@link RetentionReport.interrupted} set.
 *
 * ## Privacy
 *
 * Log records and the report carry counts, session ids, error codes and paths
 * **relative to `$DEBUGGEN_HOME`** only. No file content, no diff, no question
 * and no request-key secret is read into a log line or a report field; an
 * index-cache entry is parsed only for its `projectRoot` and its envelope
 * version, which are compared and never emitted.
 *
 * @packageDocumentation
 */

import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { INDEX_CACHE_SCHEMA_VERSION } from '@debuggen/code-analysis';
import { isSessionStatus } from '@debuggen/protocol';
import type { SessionStatus } from '@debuggen/protocol';
import {
  DebuggenError,
  basenamePosix,
  dirnamePosix,
  err,
  isAbsolutePosix,
  isErr,
  isWindowsAbsolute,
  isWithin,
  joinPosix,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  relativePosix,
} from '@debuggen/shared';
import type { Logger, Result, SessionId } from '@debuggen/shared';

import { DEFAULT_RETENTION_DAYS } from '../config.js';
import type { ServiceConfig } from '../config.js';
import { openWalCheckpointer, suspendAutoCheckpoint } from './db.js';
import type { AutoCheckpointSuspension, Store, WalCheckpointer } from './db.js';
import { scanSessionBackupReferences } from './modifications-repo.js';
import type { ModificationsRepo } from './modifications-repo.js';
import type { PanelsRepo } from './panels-repo.js';
import { MAX_SESSION_LIST_LIMIT } from './sessions-repo.js';
import type {
  RetentionCandidate,
  RetentionCandidateCursor,
  SessionsRepo,
} from './sessions-repo.js';
import { DEFAULT_PURGE_BATCH_SIZE, DELETE_SESSION_BATCH_SQL } from './telemetry-repo.js';
import type { TelemetryRepo } from './telemetry-repo.js';

/* -------------------------------------------------------------------------------------------------
 * Public constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The retention window, in days, used when the configured one is unusable.
 *
 * Re-exported from `../config.ts` rather than restated, so the documented
 * default of AAP 0.3.4 is one binding however it is imported. The real default
 * reaches this module through `ServiceConfig.retentionDays`, which the
 * configuration loader defaults from `DEBUGGEN_RETENTION_DAYS`; this value is
 * the fallback for a hand-assembled configuration whose window is not a
 * non-negative number.
 */
export { DEFAULT_RETENTION_DAYS };

/**
 * How long an unreferenced backup file is kept before the orphan rule removes
 * it: **7** days (AAP 0.4.2).
 *
 * The patcher's crash-safe sequence copies the original bytes to the backup
 * directory and `fsync`s them *before* it journals the `ModificationRecord`
 * that references them. A crash between those two steps leaves a file no row
 * names — expected, not corrupt — and an install running right now may be a
 * moment away from journalling a file this sweep would otherwise call an
 * orphan. A week is long enough that neither case is ever at risk and short
 * enough that crash debris does not accumulate.
 */
export const ORPHAN_BACKUP_GRACE_DAYS = 7;

/**
 * The statuses in which a session is **in flight** — a pipeline stage is
 * running, or a capture is recording — and which therefore keep an aged session
 * out of the purge whatever its `updated_at` says (AAP 0.5.5's stage sequence:
 * `understanding` through `analyzing`).
 *
 * The complement is the resting statuses, which wait on the developer:
 * `created`, `ready`, `generated`, `failed` and `ended`. A resting session's
 * age is how long the developer has left it, which is what the window
 * measures; an in-flight session's age is not, because the stage or capture
 * that owns it may write to it at any moment. A status this build does not
 * know is treated as in flight — the sweep never deletes a session whose state
 * it cannot interpret.
 */
export const IN_FLIGHT_SESSION_STATUSES: readonly SessionStatus[] = Object.freeze([
  'understanding',
  'investigating',
  'planning',
  'instrumenting',
  'capturing',
  'analyzing',
] satisfies SessionStatus[]);

/**
 * How many purge candidates one keyset page reads: **500**.
 *
 * A page is purged completely — its sessions decided and deleted, and then
 * their backup directories removed — before the next page is read, so this
 * bounds what the sweep holds in memory at once, and the sweep yields to the
 * event loop between pages.
 */
export const RETENTION_CANDIDATE_PAGE_SIZE = 500;

/**
 * How many backup files one journal probe judges at most: **1 000**.
 *
 * Rule 3 collects the files of one session directory that are old enough to
 * be orphans and checks them against that session's records in batches of
 * this size, so its memory is bounded by the batch rather than by the journal
 * or the backup tree.
 */
export const BACKUP_PROBE_BATCH_SIZE = 1_000;

/**
 * The most entries any one list of a {@link RetentionReport} carries:
 * **1 000**. The counts stay exact; {@link RetentionReport.omitted} says how
 * many entries each list left out, so a sweep over a large backlog cannot
 * build an unbounded report.
 */
export const MAX_REPORTED_ITEMS = 1_000;

/**
 * Whether a session holds more telemetry than one purge batch, read inside each
 * of its deciding transactions. Binds the session id, then
 * `DEFAULT_PURGE_BATCH_SIZE + 1`.
 *
 * The inner `LIMIT` bounds the read to one batch and one row of
 * `idx_telemetry_events_session_id_start_time_ingest_seq`, however large the
 * session: the answer is the session's event count when that is at most one
 * batch, and `DEFAULT_PURGE_BATCH_SIZE + 1` otherwise — which is all the
 * choice between one atomic cascade and one more drain batch needs, at the
 * cost of one batch's worth of index entries rather than the whole session's.
 * Exported so the suite explains the exact text the sweep runs.
 */
export const SESSION_TELEMETRY_PROBE_SQL = `SELECT COUNT(*) AS events FROM (
  SELECT 1 FROM telemetry_events WHERE session_id = ? LIMIT ?
)`;

/**
 * How many free pages one `PRAGMA incremental_vacuum` step releases at most:
 * **2 048** — 8 MiB at the default 4 KiB page size.
 *
 * Each step is its own write transaction and holds the event loop while it
 * moves pages, so the reclaim of a large purge is a sequence of short holds
 * with a yield and a signal check between them, never one long one.
 */
export const INCREMENTAL_VACUUM_STEP_PAGES = 2_048;

/**
 * The smallest share of the database file that must be free before the
 * one-time conversion `VACUUM` of a store without auto-vacuum runs: **0.25**.
 * Below it the rewrite would cost more than the space is worth; the pages stay
 * reusable. Tunable per call through {@link RetentionReclaimTuning.minFreeShare}.
 */
export const VACUUM_CONVERSION_MIN_FREE_SHARE = 0.25;

/**
 * The fewest free bytes worth the one-time conversion `VACUUM`: **8 MiB**. A
 * small store freeing a few pages keeps them for reuse instead of being
 * rewritten. Tunable per call through {@link RetentionReclaimTuning.minFreeBytes}.
 */
export const VACUUM_CONVERSION_MIN_FREE_BYTES = 8 * 1024 * 1024;

/**
 * The most live bytes the one-time conversion `VACUUM` will rewrite:
 * **256 MiB**. `VACUUM` copies every live page and blocks the event loop and
 * the write lock for as long as that takes — its cost is proportional to the
 * live data, not to what was freed — so a store holding more keeps its free
 * pages for reuse, and an explicit {@link RetentionOptions.vacuum} is the way
 * to compact it. Tunable per call through
 * {@link RetentionReclaimTuning.maxLiveBytes}.
 */
export const VACUUM_CONVERSION_MAX_LIVE_BYTES = 256 * 1024 * 1024;

/**
 * The write-ahead log size at which a real sweep waits for a background
 * checkpoint before its next transaction: **32 MiB** (see "The write-ahead log
 * during a sweep" in the module overview).
 *
 * One drain batch grows the log by a few tens of megabytes, so the log peaks
 * near this bound plus one batch, and the sweep waits roughly once a batch.
 * Lower waits more often for less each time; higher lets the log — and the
 * final checkpoint of a sweep an abort cuts short, which runs on the event
 * loop as the store closes — grow larger. Tunable per call through
 * {@link RetentionOptions.walCheckpointBytes}.
 */
export const RETENTION_WAL_CHECKPOINT_BYTES = 32 * 1024 * 1024;

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/** Where a {@link RetentionIssue} arose. */
export type RetentionIssueScope = 'session' | 'backup' | 'index-cache' | 'database';

/**
 * One per-item problem the sweep recorded and stepped over.
 *
 * `message` is the `message` of a {@link DebuggenError} payload — a complete
 * sentence naming the item and the failure's code — never a raw stack or an
 * engine message that could quote an absolute path or a value.
 */
export interface RetentionIssue {
  /** Which part of the sweep the problem belongs to. */
  readonly scope: RetentionIssueScope;

  /**
   * What the problem is about: a session id for `session`, a path relative to
   * `$DEBUGGEN_HOME` for `backup` and `index-cache`, or the operation's name
   * (`sessions.listRetentionCandidates`, `modifications.scanSessionBackupReferences`,
   * `sessions.list`, `sessions.getAccessTarget`, `reclaim` — reading the page
   * counts —, `incremental_vacuum`, `auto_vacuum` — the one-time conversion —,
   * `checkpoint`, `vacuum`) for `database`.
   */
  readonly target: string;

  /** The problem, as a sentence safe to show and to log. */
  readonly message: string;
}

/**
 * Which projects one sweep may remove state of: `true` — or a promise of
 * `true` — for a project root the sweep may act on. Handed normalised absolute
 * roots — a session's stored root, or one an index-cache entry records. See
 * {@link RetentionOptions.scope}.
 *
 * The answer may be asynchronous so a scope can resolve a root on disk: the
 * one `session.purge` builds admits a root only when its **canonical**
 * location lies under one of the editor's canonical workspace folders, so a
 * link inside workspace A that resolves into workspace B is not A's. The sweep
 * awaits every answer before — never inside — the transaction that decides a
 * session. Anything but `true`, a throw and a rejection all keep the item.
 *
 * @example A scope that resolves each root, as `session.purge` builds one
 * ```ts
 * const scope: RetentionScope = async (projectRoot) => {
 *   if (isErr(requireProjectScope(principal, projectRoot))) return false;
 *   const canonical = await canonicalizePath(projectRoot);
 *   return !isErr(canonical) && canonicalFolders.some((folder) => isWithin(folder, canonical.value));
 * };
 * ```
 */
export type RetentionScope = (projectRoot: string) => boolean | Promise<boolean>;

/**
 * The gates of the one-time conversion `VACUUM` a store without auto-vacuum
 * gets after a purge (see "Returning space to the filesystem" in the module
 * overview). Every member is optional and defaults to its exported constant;
 * the conversion runs only when all three gates pass. A store already in
 * `INCREMENTAL` or `FULL` mode is not affected.
 *
 * @example Never rewrite more than 64 MiB of live data at start-up
 * ```ts
 * await runRetention(deps, { reclaim: { maxLiveBytes: 64 * 1024 * 1024 } });
 * ```
 */
export interface RetentionReclaimTuning {
  /**
   * The free share of the file, `freelist_count / page_count`, that must be
   * reached: a number in `[0, 1]`. Defaults to
   * {@link VACUUM_CONVERSION_MIN_FREE_SHARE}.
   */
  readonly minFreeShare?: number | undefined;

  /**
   * The free bytes, `freelist_count × page_size`, that must be reached: a
   * finite, non-negative number. Defaults to
   * {@link VACUUM_CONVERSION_MIN_FREE_BYTES}.
   */
  readonly minFreeBytes?: number | undefined;

  /**
   * The live bytes, `(page_count − freelist_count) × page_size`, that must not
   * be exceeded: a finite, non-negative number. Defaults to
   * {@link VACUUM_CONVERSION_MAX_LIVE_BYTES}.
   */
  readonly maxLiveBytes?: number | undefined;
}

/** Tuning for one {@link runRetention} call. Every member is optional. */
export interface RetentionOptions {
  /**
   * Limits the sweep to the state of the projects the scope admits — how
   * `session.purge` runs it for one editor's announced workspace (CWE-863).
   * Absent, as on the start-up path, the sweep is machine-wide. The
   * module overview's "Scoped sweeps" states what each rule then keeps; in
   * short, nothing whose project is unknown or outside the scope is removed,
   * read beyond its owner, or reported, and an index-cache entry is removed
   * only once every document it holds was read and attributed to an admitted
   * project. The predicate may answer asynchronously and is awaited outside
   * every transaction.
   */
  readonly scope?: RetentionScope | undefined;

  /**
   * The retention window in days, overriding `config.retentionDays` for this
   * call. A finite, non-negative number; `0` purges everything eligible.
   */
  readonly retentionDays?: number | undefined;

  /**
   * The orphan-backup grace window in days. Defaults to
   * {@link ORPHAN_BACKUP_GRACE_DAYS}; a finite, non-negative number.
   */
  readonly orphanBackupGraceDays?: number | undefined;

  /**
   * Compute and report without deleting anything. Every read the real sweep
   * performs is performed, no row is deleted, no file or directory is removed
   * and no reclaim, checkpoint or `VACUUM` runs; the report holds the counts
   * the real sweep would have produced, with no database bytes reclaimed.
   * Backs the tests and a "what would be purged" affordance. Defaults to
   * `false`.
   */
  readonly dryRun?: boolean | undefined;

  /**
   * Run `VACUUM` after the sweep, whatever it deleted, and without the gates
   * of {@link RetentionReclaimTuning}. Defaults to **`false`**: `VACUUM`
   * rewrites the whole database and holds the write lock — and the event loop
   * — for as long as that takes, so the start-up path never asks for it. The
   * store is set to `auto_vacuum = INCREMENTAL` first, so the rewrite also
   * converts a store without auto-vacuum and every later sweep releases its
   * pages incrementally. Skipped when the reclaim's own one-time conversion
   * already ran the `VACUUM`. Ignored when {@link dryRun} is set.
   */
  readonly vacuum?: boolean | undefined;

  /**
   * The gates of the one-time conversion `VACUUM` of a store without
   * auto-vacuum. Absent, the exported defaults apply. See
   * {@link RetentionReclaimTuning}.
   */
  readonly reclaim?: RetentionReclaimTuning | undefined;

  /**
   * The write-ahead log size, in bytes, at which the sweep waits for a
   * background checkpoint before its next transaction: a finite, non-negative
   * number. `0` waits whenever the log is not empty. Defaults to
   * {@link RETENTION_WAL_CHECKPOINT_BYTES}; see "The write-ahead log during a
   * sweep" in the module overview. Has no effect on a dry run or on the
   * in-memory store.
   */
  readonly walCheckpointBytes?: number | undefined;

  /**
   * Stops the sweep early. Checked at every step boundary — before each
   * candidate page, each session decision, each drain batch of a large
   * session, each backup and index-cache entry, and each database reclaim
   * step. Once it is aborted the sweep starts no new work, skips the database
   * reclaim, and still answers `Ok` with the counts so far and
   * {@link RetentionReport.interrupted} set; an abort never makes it throw or
   * reject. Work already committed stays committed — at worst the drained
   * batches of one large session (see "Atomic per session, bounded per
   * transaction" in the module overview) — and the next sweep carries on
   * where this one stopped.
   *
   * `src/main.ts` passes the signal its shutdown path aborts, so a stop never
   * waits for a start-up sweep to finish.
   *
   * @example
   * ```ts
   * const controller = new AbortController();
   * const sweeping = runRetention(deps, { signal: controller.signal });
   * // … on shutdown:
   * controller.abort();
   * const swept = await sweeping; // Ok, with `interrupted: true`
   * ```
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * How many entries each capped list of a {@link RetentionReport} left out
 * because it already held {@link MAX_REPORTED_ITEMS}. All zero unless the
 * sweep met a backlog that large.
 */
export interface RetentionOmissions {
  /** Deleted sessions beyond {@link RetentionReport.sessionIdsDeleted}. */
  readonly sessionIdsDeleted: number;
  /** Conflict-retained sessions beyond {@link RetentionReport.sessionsRetainedForConflicts}. */
  readonly sessionsRetainedForConflicts: number;
  /** Active retained sessions beyond {@link RetentionReport.sessionsRetainedActive}. */
  readonly sessionsRetainedActive: number;
  /** Issues beyond {@link RetentionReport.errors}; every one was still logged. */
  readonly errors: number;
}

/**
 * What one sweep removed — or, for a dry run, would have removed.
 *
 * Arrays are sorted, and the traversal order is fixed, so two sweeps over the
 * same state produce the same report apart from {@link durationMs} and
 * {@link databaseBytesReclaimed} — with its share of {@link bytesReclaimed} —
 * which follow the database file's page layout rather than its rows. Every list
 * holds at most {@link MAX_REPORTED_ITEMS} entries — the first ones the sweep
 * met, oldest session first — and {@link omitted} counts the rest; every count
 * is exact.
 */
export interface RetentionReport {
  /**
   * The age threshold, in epoch milliseconds: a session last updated strictly
   * before this instant was a purge candidate, and an index-cache entry last
   * written before it was eligible.
   */
  readonly cutoff: number;

  /** How many sessions were deleted. */
  readonly sessionsDeleted: number;

  /** Their ids, sorted; see {@link omitted} for any beyond the cap. */
  readonly sessionIdsDeleted: readonly string[];

  /**
   * How many telemetry events the sweep deleted: every event those sessions
   * held, plus the batches drained from a large session that then stopped
   * being eligible, was interrupted, or failed part-way (see "Atomic per
   * session, bounded per transaction" in the module overview). Exact either
   * way.
   */
  readonly telemetryEventsDeleted: number;

  /** How many panels those sessions held. */
  readonly panelsDeleted: number;

  /** How many analyses those sessions held. */
  readonly analysesDeleted: number;

  /** How many modification-journal records those sessions held. */
  readonly modificationsDeleted: number;

  /**
   * How many backup directories were removed: the directories of purged
   * sessions, and session directories the orphan rule left empty.
   */
  readonly backupDirsDeleted: number;

  /** How many unreferenced backup files older than the grace window were removed. */
  readonly orphanBackupsDeleted: number;

  /** How many code-index cache entries were removed. */
  readonly indexCachesDeleted: number;

  /**
   * Aged sessions kept because their journal holds a `conflict` record, sorted.
   * Their rows and their backups stay until the conflict is resolved.
   */
  readonly sessionsRetainedForConflicts: readonly string[];

  /**
   * Aged sessions kept because they are still active, sorted: in an in-flight
   * status ({@link IN_FLIGHT_SESSION_STATUSES}), holding an open capture
   * window, or reported in use by {@link RetentionDeps.isSessionInUse}. Their
   * rows, telemetry and backups are untouched.
   */
  readonly sessionsRetainedActive: readonly string[];

  /**
   * The bytes this sweep returned to the filesystem: the `lstat` sizes of the
   * files it removed from `$DEBUGGEN_HOME`, plus
   * {@link databaseBytesReclaimed}. A dry run counts the files it would have
   * removed and no database bytes.
   */
  readonly bytesReclaimed?: number;

  /**
   * The bytes the session database file shrank by during this sweep:
   * `max(0, (page_count at the start − page_count after the reclaim) ×
   * page_size)`, reached on disk by the `wal_checkpoint(TRUNCATE)` that
   * closes the reclaim. Non-zero only when the sweep deleted something and
   * released the freed pages — `PRAGMA incremental_vacuum` on an incremental
   * store, the one-time conversion `VACUUM` of a store without auto-vacuum —
   * or when {@link RetentionOptions.vacuum} asked for a `VACUUM`. `0` for a
   * dry run, a sweep interrupted before its reclaim, and a store whose freed
   * pages stay reusable (see "Returning space to the filesystem" in the module
   * overview). A signal aborted between two incremental steps keeps what the
   * earlier steps released, and the store's close checkpoints it to disk.
   */
  readonly databaseBytesReclaimed?: number;

  /** How long the sweep took, in milliseconds of monotonic time. */
  readonly durationMs: number;

  /**
   * `true` only when {@link RetentionOptions.signal} stopped the sweep before
   * it finished; the counts above are then what it had done so far, and the
   * database reclaim did not run — or stopped between two of its steps.
   * `false` for every sweep that ran to its end.
   */
  readonly interrupted?: boolean;

  /** Every per-item problem, in the order it was met, up to the cap. */
  readonly errors: readonly RetentionIssue[];

  /** How many entries each capped list above left out. */
  readonly omitted: RetentionOmissions;
}

/**
 * What {@link runRetention} works with. Every collaborator is injected, so the
 * sweep owns no connection, reads no environment variable and recomputes no
 * path.
 */
export interface RetentionDeps {
  /** The open, migrated store the repositories below are built over. */
  readonly store: Store;

  /** Candidate sessions, their deletion, and the project roots active inside the window. */
  readonly sessions: SessionsRepo;

  /** Per-session event counts, read inside the deleting transaction. */
  readonly telemetry: TelemetryRepo;

  /**
   * The conflict exemption: each candidate's `conflict` records. The open-record
   * re-check and the backup-reference probe read the same table through the
   * store — inside the deleting transaction, and as an indexed per-session
   * stream respectively.
   */
  readonly modifications: ModificationsRepo;

  /** Per-session panel and analysis counts. */
  readonly panels: PanelsRepo;

  /**
   * The resolved paths and the window. `debuggenHome` is the containment
   * boundary for every deletion; `backupsDir` and `indexCacheDir` must lie
   * strictly inside it.
   */
  readonly config: Pick<
    ServiceConfig,
    'debuggenHome' | 'backupsDir' | 'indexCacheDir' | 'retentionDays'
  >;

  /** Where the sweep reports. Defaults to the shared no-op logger. */
  readonly logger?: Logger | undefined;

  /** The current epoch-millisecond time. Defaults to `nowEpochMs()`. */
  readonly now?: (() => number) | undefined;

  /**
   * Whether a live component holds the session right now, so it must not be
   * purged however old its last update.
   *
   * Asked inside the deleting transaction, after every other check, for a
   * session that would otherwise be deleted — for a large session, inside each
   * of its drain transactions; `true` retains it and reports it in
   * {@link RetentionReport.sessionsRetainedActive}. Absent, nothing is
   * claimed — right only while no client can reach the service. A sweep run
   * while the service serves — the on-demand purge, or a start-up sweep run
   * once the service listens — should pass the session manager's view: the
   * sessions repository's `update` inserts a row that is absent, so a manager
   * writing back a session this sweep had deleted would resurrect its row
   * without its evidence.
   * Synchronous, because the transaction it runs in is; a predicate that
   * throws is taken to mean "in use".
   */
  readonly isSessionInUse?: ((sessionId: SessionId) => boolean) | undefined;

  /**
   * Told of each session this sweep deleted, once the transaction that deleted
   * it has committed — never in a dry run, and never for a session it kept.
   *
   * An on-demand purge run while the service serves passes its trace
   * correlator's `invalidate` here, so a purged session's cached trace trees
   * are dropped with its rows instead of being held until the cache evicts
   * them. Absent at start-up, where no cache exists yet. A listener that
   * throws is logged by code and the sweep carries on: the rows are already
   * gone, and the report still counts the session.
   */
  readonly onSessionDeleted?: ((sessionId: SessionId) => void) | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Internal constants
 * ---------------------------------------------------------------------------------------------- */

/** Milliseconds in one day, the unit both windows are configured in. */
const MS_PER_DAY = 86_400_000;

/** The `subsystem` binding every record from this module carries. */
const SUBSYSTEM = 'store';

/** The `repo` binding every record from this module carries, beside the repositories' own. */
const COMPONENT = 'retention';

/**
 * The status a record reaches once its file is restored — the only status in
 * which a record no longer describes a patched file.
 *
 * Typed through the journal's own method so the literal is checked against the
 * status vocabulary `@debuggen/instrumentation` defines, rather than restated.
 */
const REVERTED_STATUS: Parameters<ModificationsRepo['updateStatus']>[1] = 'reverted';

/** The one status the conflict exemption protects, typed the same way. */
const CONFLICT_STATUS: Parameters<ModificationsRepo['updateStatus']>[1] = 'conflict';

/** {@link IN_FLIGHT_SESSION_STATUSES} as a set, for the in-transaction check. */
const IN_FLIGHT_STATUS_SET: ReadonlySet<string> = new Set<string>(IN_FLIGHT_SESSION_STATUSES);

/**
 * The largest index-cache document read for its `projectRoot`: 64 MiB.
 *
 * A document is parsed only when its entry is already older than the window,
 * to decide whether a recently active project still owns it. One beyond this
 * size is judged by its modification time alone — the conservative fallback
 * for a derived artifact.
 */
const MAX_INDEX_METADATA_BYTES = 64 * 1024 * 1024;

/**
 * How many `*.json` files directly inside a directory-shaped index-cache entry
 * are consulted for a `projectRoot` before the entry is judged by age alone.
 *
 * A scoped sweep never samples: it reads every document of an entry holding at
 * most this many, and keeps — without reading — one holding more, because a
 * document left unread could record another workspace's project. Exported so
 * the suite builds its boundary fixtures from the bound itself.
 */
export const MAX_INDEX_METADATA_FILES = 8;

/**
 * How deep the survey of a tree about to be removed descends. A session backup
 * directory is two levels deep, with relocated backups one level further; the
 * bound keeps the walk finite over a tree someone has filled by hand.
 */
const MAX_MEASURE_DEPTH = 4;

/** The file extension of a code-index cache entry. */
const INDEX_ENTRY_EXTENSION = '.json';

/**
 * Re-reads a session's last-activity instant and status inside the deleting
 * transaction, so a session touched — or moved into a pipeline stage — after
 * it was listed is never purged.
 */
const SESSION_STATE_SQL = 'SELECT updated_at, status FROM sessions WHERE id = ?';

/**
 * Whether a session holds an open capture window, inside the deleting
 * transaction. Served by the partial index over `stopped_at IS NULL`. Ingest
 * into an open window writes telemetry without touching `updated_at`, so an
 * open window is activity the age basis cannot see.
 */
const SESSION_OPEN_CAPTURE_SQL =
  'SELECT EXISTS (SELECT 1 FROM captures WHERE session_id = ? AND stopped_at IS NULL) AS capture_open';

/**
 * A session's journal, counted inside the deleting transaction: every record
 * (what the cascade removes, for the report), those that still describe a
 * patched file, and those in conflict. The journal repository's methods are
 * asynchronous and therefore cannot run inside `Store.transaction`; this one
 * read is what makes the journal half of the decision atomic with the delete.
 * Bound as `(reverted, conflict, sessionId)`.
 */
const SESSION_JOURNAL_SQL = `SELECT COUNT(*) AS records,
  COALESCE(SUM(status <> ?), 0) AS open_records,
  COALESCE(SUM(status = ?), 0) AS conflict_records
FROM modifications WHERE session_id = ?`;

/** `O_NOFOLLOW` where the platform defines it, so a metadata read never follows a link. */
const OPEN_NO_FOLLOW_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/** The store's auto-vacuum mode: `0` none, `1` full, `2` incremental. Column `auto_vacuum`. */
const AUTO_VACUUM_SQL = 'PRAGMA auto_vacuum';

/** The database page size in bytes. Column `page_size`. */
const PAGE_SIZE_SQL = 'PRAGMA page_size';

/** The database size in pages, freelist included. Column `page_count`. */
const PAGE_COUNT_SQL = 'PRAGMA page_count';

/** How many pages sit unused on the freelist. Column `freelist_count`. */
const FREELIST_COUNT_SQL = 'PRAGMA freelist_count';

/**
 * One bounded step of the incremental reclaim. A pragma argument cannot be a
 * bound parameter, so the step size is spelled into the constant text once.
 * Stepped to completion with `.all()`: a single step releases a single page.
 */
const INCREMENTAL_VACUUM_STEP_SQL = `PRAGMA incremental_vacuum(${String(INCREMENTAL_VACUUM_STEP_PAGES)})`;

/**
 * Selects incremental auto-vacuum. On a store that already holds tables it
 * takes effect at the next `VACUUM`, which is why every `VACUUM` of this
 * module runs right after it.
 */
const SET_AUTO_VACUUM_INCREMENTAL_SQL = 'PRAGMA auto_vacuum = INCREMENTAL';

/** Rewrites the whole database compactly; refused by SQLite inside a transaction. */
const VACUUM_SQL = 'VACUUM';

/** `PRAGMA auto_vacuum` values, as SQLite numbers them. */
const AUTO_VACUUM_MODE = Object.freeze({ none: 0, full: 1, incremental: 2 } as const);

/* -------------------------------------------------------------------------------------------------
 * Internal shapes
 * ---------------------------------------------------------------------------------------------- */

/** The validated inputs of one sweep. */
interface SweepSettings {
  readonly home: string;
  readonly backupsDir: string;
  readonly indexCacheDir: string;
  readonly cutoff: number;
  readonly graceCutoff: number;
  readonly retentionDays: number;
  readonly graceDays: number;
  readonly dryRun: boolean;
  readonly vacuum: boolean;
  /** {@link RetentionOptions.scope}; `undefined` for a machine-wide sweep. */
  readonly scope: RetentionScope | undefined;
  /** {@link RetentionOptions.signal}; `undefined` for a sweep nothing can stop. */
  readonly signal: AbortSignal | undefined;
  /** {@link RetentionOptions.reclaim} with every default applied. */
  readonly reclaim: ReclaimGates;
  /** {@link RetentionOptions.walCheckpointBytes} with its default applied. */
  readonly walCheckpointBytes: number;
}

/** {@link RetentionReclaimTuning} with every default applied and validated. */
interface ReclaimGates {
  readonly minFreeShare: number;
  readonly minFreeBytes: number;
  readonly maxLiveBytes: number;
}

/** Everything one sweep's phases share. */
interface SweepContext {
  readonly deps: RetentionDeps;
  readonly settings: SweepSettings;
  readonly logger: Logger;
  /** How the sweep keeps the write-ahead log bounded; see {@link SweepWal}. */
  readonly wal: SweepWal;
}

/**
 * The sweep's handle on the write-ahead log (see "The write-ahead log during a
 * sweep" in the module overview): one per {@link runRetention} call, created
 * before the first phase and closed after the last.
 */
interface SweepWal {
  /**
   * Runs `phase` with the connection's commit-time checkpoint suspended, when
   * a background checkpointer is available for this store; otherwise runs it
   * unchanged. The suspension ends when `phase` settles, however it settles.
   * A dry run never suspends: it writes nothing.
   */
  during(phase: () => Promise<void>): Promise<void>;

  /**
   * Waits for a background checkpoint when the log has reached
   * {@link SweepSettings.walCheckpointBytes} — or, with `force`, whenever it
   * is not empty. Does nothing outside {@link during}, where SQLite's own
   * checkpoints are in force. Stops waiting, without cancelling the
   * checkpoint, when the signal aborts. Never rejects.
   */
  relieve(force?: boolean): Promise<void>;

  /** Ends the checkpointer thread, when one was started. Never rejects. */
  close(): Promise<void>;

  /** Background checkpoints the sweep waited for, for the finish record. */
  readonly checkpoints: number;

  /** The longest of those waits, in milliseconds. */
  readonly longestCheckpointMs: number;
}

/** {@link RetentionOmissions}, as the phases count them up. */
type OmissionCounters = { -readonly [K in keyof RetentionOmissions]: RetentionOmissions[K] };

/** The three capped id lists of the report. */
type ReportedIdList =
  'sessionIdsDeleted' | 'sessionsRetainedForConflicts' | 'sessionsRetainedActive';

/** What the phases accumulate; frozen into a {@link RetentionReport} at the end. */
interface SweepState {
  readonly sessionIdsDeleted: string[];
  readonly sessionsRetainedForConflicts: string[];
  readonly sessionsRetainedActive: string[];
  readonly errors: RetentionIssue[];
  readonly omitted: OmissionCounters;
  /**
   * Directories the session phase would have removed in a **dry run**, so the
   * orphan walk never counts their files a second time. Empty in a real run:
   * a directory the session phase removed is gone from disk before the orphan
   * walk lists the backups root, so no per-session state is kept for it.
   */
  readonly removedDirectories: Set<string>;
  sessionsDeleted: number;
  telemetryEventsDeleted: number;
  panelsDeleted: number;
  analysesDeleted: number;
  modificationsDeleted: number;
  backupDirsDeleted: number;
  orphanBackupsDeleted: number;
  indexCachesDeleted: number;
  /** The `lstat` bytes of the files removed; the report adds {@link databaseBytesReclaimed}. */
  bytesReclaimed: number;
  /** Whether {@link RetentionOptions.signal} stopped the sweep; set once, never cleared. */
  interrupted: boolean;
  /**
   * `PRAGMA page_count` as the sweep began — the baseline of
   * {@link RetentionReport.databaseBytesReclaimed}. `undefined` in a dry run,
   * or when it could not be read.
   */
  databasePagesAtStart: number | undefined;
  /** {@link RetentionReport.databaseBytesReclaimed}, once the reclaim has measured it. */
  databaseBytesReclaimed: number;
}

/**
 * The device and inode of a directory as the walk observed it. Compared again
 * immediately before a deletion inside that directory.
 */
interface NodeIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** What an `lstat` of a directory the sweep walks may find. */
type DirectoryInspection =
  | { readonly kind: 'absent' }
  | { readonly kind: 'directory'; readonly identity: NodeIdentity }
  | { readonly kind: 'unsafe'; readonly error: DebuggenError };

/** The counts a candidate session contributes to the report once it is deleted. */
interface SessionCounts {
  readonly telemetry: number;
  readonly panels: number;
  readonly analyses: number;
  readonly modifications: number;
}

/** Why an aged session was found still active. */
type ActiveReason = 'in-flight' | 'capture-open' | 'in-use';

/**
 * What one in-transaction evaluation of a candidate decided.
 *
 * - `gone` — the row had already been deleted.
 * - `refreshed` — it was updated at or after the cutoff since it was listed
 *   (or its `updated_at` is unreadable, which is never read as "old").
 * - `conflict` — its journal gained a `conflict` record since it was listed.
 * - an {@link ActiveReason} — it is still active.
 * - `open-modifications` — its journal still describes a patched file.
 * - `deleted` — it was deleted (in a dry run: it would have been), with the
 *   counts the cascade removed.
 * - `drained` — every check passed, but the session holds more than one purge
 *   batch of telemetry, so this transaction deleted one batch of `events`
 *   events and left the row for a later transaction. Never answered by a dry
 *   run.
 */
type SessionVerdict =
  | { readonly outcome: 'gone' | 'refreshed' | ActiveReason }
  | { readonly outcome: 'conflict'; readonly conflicts: number }
  | { readonly outcome: 'open-modifications'; readonly openRecords: number | undefined }
  | { readonly outcome: 'deleted'; readonly counts: SessionCounts }
  | { readonly outcome: 'drained'; readonly events: number };

/** Why {@link decideSession} stopped draining a large session before its last transaction. */
type HaltReason = 'interrupted' | 'store-closed';

/**
 * What {@link decideSession} came to over every transaction it ran for one
 * candidate.
 */
interface SessionDecision {
  /**
   * The verdict of its last evaluation; `halted` when the signal or a closed
   * store stopped a drain between batches; `failed` with the issue to record
   * when the store refused a transaction.
   */
  readonly result:
    | Exclude<SessionVerdict, { readonly outcome: 'drained' }>
    | { readonly outcome: 'halted'; readonly reason: HaltReason }
    | { readonly outcome: 'failed'; readonly error: DebuggenError };

  /**
   * How many telemetry events earlier drain batches committed deleted before
   * that result — `0` for a session decided in one transaction, and for every
   * dry run.
   */
  readonly drained: number;
}

/**
 * A `backups/<sessionId>` directory the orphan walk is judging, and what it
 * has found in it so far.
 */
interface WalkedDirectory {
  /** Its resolved absolute path. */
  readonly path: string;
  /** Its name: the id of the session whose records alone can reference its files. */
  readonly sessionId: string;
  /** Its identity as the walk observed it. */
  readonly identity: NodeIdentity;
  /** Entries still in it, as far as the walk has seen. */
  remaining: number;
  /** Whether any of its files was removed (or, in a dry run, would be). */
  removedAny: boolean;
  /** Whether a probe covering it failed, so nothing more of it is removed on this pass. */
  blocked: boolean;
}

/** One file old enough to be an orphan, awaiting the journal probe. */
interface OrphanCandidate {
  /** Its resolved absolute path. */
  readonly path: string;
  /** Its file name — for a composed backup, the digest of the original. */
  readonly name: string;
  /** Its identity as the walk observed it; a file replaced since is left alone. */
  readonly identity: NodeIdentity;
  /** Its `lstat` size, for {@link RetentionReport.bytesReclaimed}. */
  readonly size: number;
  /** The identity of the directory holding it. */
  readonly parent: NodeIdentity;
}

/* -------------------------------------------------------------------------------------------------
 * Errors and issues
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `code` of a Node filesystem error, or `'unknown'`.
 *
 * Only the code travels into a message: the engine's own message spells the
 * absolute path, which this module reports relative to `$DEBUGGEN_HOME`.
 */
function errnoOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const { code } = cause;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }
  return 'unknown';
}

/** Whether `cause` is the filesystem's "no such file or directory". */
function isMissing(cause: unknown): boolean {
  const code = errnoOf(cause);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * A filesystem operation under `$DEBUGGEN_HOME` that failed.
 *
 * @param operation What was attempted, as a verb phrase ("remove", "read").
 * @param target The path relative to `$DEBUGGEN_HOME`.
 * @param cause The thrown value, kept as the error's `cause`.
 */
function fsFailure(operation: string, target: string, cause: unknown): DebuggenError {
  const errno = errnoOf(cause);
  return new DebuggenError('STORE_ERROR', `Could not ${operation} ${target} (${errno}).`, {
    hint: 'Check that the Debug Generator state directory is owned by you and writable, then run the purge again.',
    details: { subsystem: SUBSYSTEM, component: COMPONENT, operation, target, errno },
    cause,
  });
}

/**
 * A path the sweep refuses to act on: a link, a non-directory where a
 * directory belongs, a path that is not inside the state root, a directory
 * replaced since it was inspected.
 */
function unsafePath(target: string, reason: string, message: string): DebuggenError {
  return new DebuggenError('FS_UNSAFE_PATH', message, {
    hint: 'Nothing was deleted at this path. Inspect it by hand; the next purge will look at it again.',
    details: { subsystem: SUBSYSTEM, component: COMPONENT, target, reason },
  });
}

/**
 * Records one per-item problem and logs it; the sweep then continues.
 *
 * Every issue is logged. The report keeps the first {@link MAX_REPORTED_ITEMS}
 * and counts the rest in {@link RetentionReport.omitted}.
 */
function recordIssue(
  context: SweepContext,
  state: SweepState,
  scope: RetentionIssueScope,
  target: string,
  error: DebuggenError,
): void {
  const { message } = error.toPayload();
  if (state.errors.length < MAX_REPORTED_ITEMS) {
    state.errors.push({ scope, target, message });
  } else {
    state.omitted.errors += 1;
  }
  context.logger.warn('retention sweep skipped an item', {
    scope,
    target,
    code: error.code,
  });
}

/** Adds one id to a capped report list, or counts it as omitted. */
function reportId(state: SweepState, list: ReportedIdList, id: string): void {
  if (state[list].length < MAX_REPORTED_ITEMS) {
    state[list].push(id);
  } else {
    state.omitted[list] += 1;
  }
}

/** Whether the store can still be used; records one issue when it cannot. */
function storeUsable(context: SweepContext, state: SweepState, phase: string): boolean {
  if (!context.deps.store.isClosed) {
    return true;
  }
  recordIssue(
    context,
    state,
    'database',
    phase,
    new DebuggenError(
      'STORE_ERROR',
      `The session store closed during the retention sweep (${phase}).`,
      {
        hint: 'The remaining retention work runs on the next start or purge.',
        details: { subsystem: SUBSYSTEM, component: COMPONENT, phase },
      },
    ),
  );
  return false;
}

/** The step boundary at which {@link isInterrupted} found the signal aborted, for its log line. */
type InterruptionPoint =
  'candidate-page' | 'session' | 'drain-batch' | 'backup' | 'index-cache' | 'reclaim';

/**
 * Whether {@link RetentionOptions.signal} has stopped the sweep, checked at a
 * step boundary. The first `true` marks the report interrupted and is logged
 * once at `info`, naming the boundary; every later call answers `true`
 * without logging. Reads only the signal's `aborted` flag — never its reason,
 * which a caller may have filled with anything.
 */
function isInterrupted(context: SweepContext, state: SweepState, at: InterruptionPoint): boolean {
  if (state.interrupted) {
    return true;
  }
  const { signal } = context.settings;
  if (signal?.aborted !== true) {
    return false;
  }
  state.interrupted = true;
  context.logger.info('retention sweep interrupted; the next sweep carries on from here', { at });
  return true;
}

/* -------------------------------------------------------------------------------------------------
 * Paths and containment
 * ---------------------------------------------------------------------------------------------- */

/** Whether `path` is absolute in either spelling the configuration may produce. */
function isAbsolutePath(path: string): boolean {
  return isAbsolutePosix(path) || isWindowsAbsolute(path);
}

/**
 * `path` relative to the state root, for a log line or a report field.
 * Only ever called for a path already proven to be inside it.
 */
function relativeToHome(home: string, path: string): string {
  return relativePosix(home, path);
}

/**
 * Whether `path` lies strictly inside `home` — never the root itself, never a
 * sibling that merely shares its prefix. The containment half of every
 * destructive helper; the `lstat` half sits beside each call.
 */
function isStrictlyWithin(home: string, path: string): boolean {
  const normalized = normalizePosix(path);
  return isAbsolutePath(normalized) && normalized !== home && isWithin(home, normalized);
}

/**
 * The containment refusal, built once so every helper words it the same way.
 * The target is reported as the bare name, because a path outside the root has
 * no spelling relative to it.
 */
function outsideHome(path: string): DebuggenError {
  return unsafePath(
    basenamePosix(path),
    'outside-state-root',
    `Refused to delete ${basenamePosix(path)}: it is not inside the Debug Generator state directory.`,
  );
}

/** `lstat`, answering `undefined` for a path that does not exist. */
async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (cause) {
    if (isMissing(cause)) {
      return undefined;
    }
    throw cause;
  }
}

/** The identity an `lstat` reported. */
function identityOf(stats: Stats): NodeIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

/**
 * Whether the directory at `path` is still the real directory the walk
 * observed: present, not a link, same device and inode.
 */
async function directoryUnchanged(path: string, expected: NodeIdentity): Promise<boolean> {
  const current = await lstatIfPresent(path);
  return (
    current !== undefined &&
    !current.isSymbolicLink() &&
    current.isDirectory() &&
    current.dev === expected.dev &&
    current.ino === expected.ino
  );
}

/**
 * Inspects a directory the sweep is about to walk: absent, a real directory,
 * or something it must not descend into.
 */
async function inspectDirectory(home: string, path: string): Promise<DirectoryInspection> {
  const target = relativeToHome(home, path);
  let stats: Stats | undefined;
  try {
    stats = await lstatIfPresent(path);
  } catch (cause) {
    return { kind: 'unsafe', error: fsFailure('inspect', target, cause) };
  }
  if (stats === undefined) {
    return { kind: 'absent' };
  }
  if (stats.isSymbolicLink()) {
    return {
      kind: 'unsafe',
      error: unsafePath(
        target,
        'symlink',
        `${target} is a symbolic link; the retention sweep does not follow it and left it in place.`,
      ),
    };
  }
  if (!stats.isDirectory()) {
    return {
      kind: 'unsafe',
      error: unsafePath(
        target,
        'not-a-directory',
        `${target} is not a directory; the retention sweep left it in place.`,
      ),
    };
  }
  return { kind: 'directory', identity: identityOf(stats) };
}

/**
 * Orders two strings by UTF-16 code unit — locale-independent, so the order
 * every walk and every report array uses is the same on every machine.
 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The names inside a directory, sorted so the traversal order is fixed. */
async function listNames(path: string): Promise<string[]> {
  const names = await readdir(path);
  return names.sort(compareText);
}

/* -------------------------------------------------------------------------------------------------
 * Destructive helpers
 *
 * The only three functions in this module that remove anything. Each takes the
 * state root and the resolved absolute path, and each re-asserts containment
 * as the statement immediately before its destructive call — so the check
 * cannot be skipped by a caller that forgot it, and nothing between the check
 * and the call can move the path. Each `lstat`s its target and refuses a link,
 * and each re-verifies the containing directory against the identity the walk
 * observed. None of them follows a link, and none resolves a path with
 * `realpath` before deleting it.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Removes one regular file inside the state root.
 *
 * @param home The state root.
 * @param path The file's resolved absolute path.
 * @param parent The identity of its directory as the walk observed it.
 * @param expected The file's own identity as the walk observed it; a file
 * replaced since is left alone.
 * @returns `ok(bytes)` with the removed file's size, `ok(0)` when it had
 * already gone, or the refusal.
 */
async function removeFileWithin(
  home: string,
  path: string,
  parent: NodeIdentity,
  expected: NodeIdentity,
): Promise<Result<number, DebuggenError>> {
  if (!isStrictlyWithin(home, path)) {
    return err(outsideHome(path));
  }
  const target = relativeToHome(home, path);

  try {
    if (!(await directoryUnchanged(dirnamePosix(path), parent))) {
      return err(
        unsafePath(
          target,
          'directory-changed',
          `The directory holding ${target} changed while the retention sweep ran; nothing was deleted.`,
        ),
      );
    }

    const stats = await lstatIfPresent(path);
    if (stats === undefined) {
      return ok(0);
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return err(
        unsafePath(
          target,
          stats.isSymbolicLink() ? 'symlink' : 'not-a-regular-file',
          `${target} is not a regular file; the retention sweep left it in place.`,
        ),
      );
    }
    if (stats.dev !== expected.dev || stats.ino !== expected.ino) {
      return err(
        unsafePath(
          target,
          'file-replaced',
          `${target} was replaced while the retention sweep ran; nothing was deleted.`,
        ),
      );
    }

    if (!isStrictlyWithin(home, path)) {
      return err(outsideHome(path));
    }
    await unlink(path);
    return ok(stats.size);
  } catch (cause) {
    if (isMissing(cause)) {
      return ok(0);
    }
    return err(fsFailure('remove', target, cause));
  }
}

/**
 * Removes one directory tree inside the state root.
 *
 * `fs.rm` with `recursive` unlinks a link it meets inside the tree instead of
 * descending into it, so nothing a link points at is reached; the directory
 * itself must be a real directory, verified by `lstat` here.
 *
 * @param home The state root.
 * @param path The directory's resolved absolute path.
 * @param parent The identity of its parent directory as the walk observed it.
 * @param expected The directory's own identity as the walk observed it.
 * @returns `ok(true)` when the tree was removed, `ok(false)` when it had
 * already gone, or the refusal.
 */
async function removeTreeWithin(
  home: string,
  path: string,
  parent: NodeIdentity,
  expected: NodeIdentity,
): Promise<Result<boolean, DebuggenError>> {
  if (!isStrictlyWithin(home, path)) {
    return err(outsideHome(path));
  }
  const target = relativeToHome(home, path);

  try {
    if (!(await directoryUnchanged(dirnamePosix(path), parent))) {
      return err(
        unsafePath(
          target,
          'directory-changed',
          `The directory holding ${target} changed while the retention sweep ran; nothing was deleted.`,
        ),
      );
    }

    const stats = await lstatIfPresent(path);
    if (stats === undefined) {
      return ok(false);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return err(
        unsafePath(
          target,
          stats.isSymbolicLink() ? 'symlink' : 'not-a-directory',
          `${target} is not a directory; the retention sweep left it in place.`,
        ),
      );
    }
    if (stats.dev !== expected.dev || stats.ino !== expected.ino) {
      return err(
        unsafePath(
          target,
          'directory-replaced',
          `${target} was replaced while the retention sweep ran; nothing was deleted.`,
        ),
      );
    }

    if (!isStrictlyWithin(home, path)) {
      return err(outsideHome(path));
    }
    await rm(path, { recursive: true, force: true });
    return ok(true);
  } catch (cause) {
    if (isMissing(cause)) {
      return ok(false);
    }
    return err(fsFailure('remove', target, cause));
  }
}

/**
 * Removes one directory inside the state root **only if it is empty**.
 *
 * `rmdir` refuses a non-empty directory atomically, so a backup written into
 * the directory after the walk looked at it keeps the directory alive: that
 * refusal is an ordinary outcome here, not an error.
 *
 * @param home The state root.
 * @param path The directory's resolved absolute path.
 * @param parent The identity of its parent directory as the walk observed it.
 * @param expected The directory's own identity as the walk observed it.
 * @returns `ok(true)` when it was removed, `ok(false)` when it was no longer
 * empty or had already gone, or the refusal.
 */
async function removeEmptyDirectoryWithin(
  home: string,
  path: string,
  parent: NodeIdentity,
  expected: NodeIdentity,
): Promise<Result<boolean, DebuggenError>> {
  if (!isStrictlyWithin(home, path)) {
    return err(outsideHome(path));
  }
  const target = relativeToHome(home, path);

  try {
    if (!(await directoryUnchanged(dirnamePosix(path), parent))) {
      return err(
        unsafePath(
          target,
          'directory-changed',
          `The directory holding ${target} changed while the retention sweep ran; nothing was deleted.`,
        ),
      );
    }
    if (!(await directoryUnchanged(path, expected))) {
      return ok(false);
    }

    if (!isStrictlyWithin(home, path)) {
      return err(outsideHome(path));
    }
    await rmdir(path);
    return ok(true);
  } catch (cause) {
    const errno = errnoOf(cause);
    if (isMissing(cause) || errno === 'ENOTEMPTY' || errno === 'EEXIST') {
      return ok(false);
    }
    return err(fsFailure('remove', target, cause));
  }
}

/** What {@link surveyTree} found in a tree it is about to be asked to remove. */
interface TreeSurvey {
  /** The total `lstat` size of its regular files, for {@link RetentionReport.bytesReclaimed}. */
  bytes: number;
  /** The first symbolic link met inside the tree, if any, as an absolute path. */
  link: string | undefined;
}

/**
 * Surveys a tree before it is removed: the byte total of its regular files, and
 * whether a symbolic link sits anywhere inside it.
 *
 * Read-only. Links are recorded and never followed, the walk stops at
 * {@link MAX_MEASURE_DEPTH}, and an entry that cannot be inspected contributes
 * nothing — the removal itself reports the failure that matters.
 *
 * A link inside a tree this module is about to delete is not a layout the
 * product writes, so its presence is treated as a reason **not** to remove the
 * tree: `fs.rm` would only unlink the link and never reach its target, but a
 * planted link is exactly the anomaly a developer should look at, and the
 * orphan rule still judges the regular files beside it one by one.
 */
async function surveyTree(
  path: string,
  survey: TreeSurvey = { bytes: 0, link: undefined },
  depth = 0,
): Promise<TreeSurvey> {
  let stats: Stats | undefined;
  try {
    stats = await lstatIfPresent(path);
  } catch {
    return survey;
  }
  if (stats === undefined) {
    return survey;
  }
  if (stats.isSymbolicLink()) {
    survey.link ??= path;
    return survey;
  }
  if (stats.isFile()) {
    survey.bytes += stats.size;
    return survey;
  }
  if (!stats.isDirectory() || depth >= MAX_MEASURE_DEPTH) {
    return survey;
  }
  let names: string[];
  try {
    names = await listNames(path);
  } catch {
    return survey;
  }
  for (const name of names) {
    await surveyTree(joinPosix(path, name), survey, depth + 1);
  }
  return survey;
}

/** The refusal to remove a tree that holds a symbolic link. */
function treeHoldsLink(home: string, tree: string, link: string): DebuggenError {
  const target = relativeToHome(home, tree);
  const linkTarget = relativeToHome(home, link);
  return unsafePath(
    target,
    'contains-symlink',
    `${target} contains the symbolic link ${linkTarget}; the retention sweep does not remove a tree holding a link and left it in place.`,
  );
}

/* -------------------------------------------------------------------------------------------------
 * Settings
 * ---------------------------------------------------------------------------------------------- */

/** A configuration or option the sweep cannot run with. */
function invalidSetting(field: string, expected: string): DebuggenError {
  return new DebuggenError(
    'CONFIG_INVALID',
    `The retention sweep cannot run: ${field} must be ${expected}.`,
    {
      hint: 'Pass the resolved service configuration from src/config.ts, whose paths are nested inside DEBUGGEN_HOME, and a non-negative retention window.',
      details: { subsystem: SUBSYSTEM, component: COMPONENT, field },
    },
  );
}

/** Whether `value` is a usable window length in days. */
function isWindowDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validates the injected configuration, options and clock, and derives the two
 * cutoffs.
 *
 * The retention window comes from `options.retentionDays` when a caller passes
 * one (and an unusable one is refused), otherwise from `config.retentionDays`;
 * a configured window that is not a non-negative number falls back to
 * {@link DEFAULT_RETENTION_DAYS} with a warning, because widening to the
 * documented default keeps *more* data, which is the safe direction for a
 * module that deletes.
 *
 * The containment boundary must be an absolute path that is not a filesystem
 * root, and both swept directories must lie strictly inside it: a
 * configuration that pointed `backupsDir` outside `$DEBUGGEN_HOME` would make
 * every containment check below refuse every deletion, so it is rejected once,
 * up front, as `CONFIG_INVALID`.
 */
function resolveSettings(
  deps: RetentionDeps,
  options: RetentionOptions,
  logger: Logger,
): Result<SweepSettings, DebuggenError> {
  const { config } = deps;

  const home = typeof config.debuggenHome === 'string' ? normalizePosix(config.debuggenHome) : '';
  if (!isAbsolutePath(home) || dirnamePosix(home) === home) {
    return err(
      invalidSetting('debuggenHome', 'an absolute directory path that is not a filesystem root'),
    );
  }

  const backupsDir = typeof config.backupsDir === 'string' ? normalizePosix(config.backupsDir) : '';
  if (!isStrictlyWithin(home, backupsDir)) {
    return err(invalidSetting('backupsDir', 'an absolute path strictly inside debuggenHome'));
  }

  const indexCacheDir =
    typeof config.indexCacheDir === 'string' ? normalizePosix(config.indexCacheDir) : '';
  if (!isStrictlyWithin(home, indexCacheDir)) {
    return err(invalidSetting('indexCacheDir', 'an absolute path strictly inside debuggenHome'));
  }

  let retentionDays: number;
  if (options.retentionDays !== undefined) {
    if (!isWindowDays(options.retentionDays)) {
      return err(invalidSetting('retentionDays', 'a finite, non-negative number of days'));
    }
    retentionDays = options.retentionDays;
  } else if (isWindowDays(config.retentionDays)) {
    retentionDays = config.retentionDays;
  } else {
    logger.warn('configured retention window is unusable; using the documented default', {
      defaultDays: DEFAULT_RETENTION_DAYS,
    });
    retentionDays = DEFAULT_RETENTION_DAYS;
  }

  const graceDays = options.orphanBackupGraceDays ?? ORPHAN_BACKUP_GRACE_DAYS;
  if (!isWindowDays(graceDays)) {
    return err(invalidSetting('orphanBackupGraceDays', 'a finite, non-negative number of days'));
  }

  const { scope } = options;
  if (scope !== undefined && typeof scope !== 'function') {
    return err(invalidSetting('scope', 'a predicate over project roots'));
  }

  const { signal } = options;
  if (!isAbortSignalLike(signal)) {
    return err(invalidSetting('signal', 'an AbortSignal'));
  }

  const reclaim = resolveReclaimGates(options.reclaim);
  if (isErr(reclaim)) {
    return reclaim;
  }

  const walCheckpointBytes = options.walCheckpointBytes ?? RETENTION_WAL_CHECKPOINT_BYTES;
  if (!isByteCount(walCheckpointBytes)) {
    return err(invalidSetting('walCheckpointBytes', 'a finite, non-negative number of bytes'));
  }

  let now: number;
  try {
    now = (deps.now ?? nowEpochMs)();
  } catch (cause) {
    return err(DebuggenError.from(cause, 'CONFIG_INVALID'));
  }
  if (!Number.isFinite(now)) {
    return err(invalidSetting('now()', 'a finite epoch-millisecond reading'));
  }

  const cutoff = now - retentionDays * MS_PER_DAY;
  const graceCutoff = now - graceDays * MS_PER_DAY;
  if (!Number.isFinite(cutoff) || !Number.isFinite(graceCutoff)) {
    return err(invalidSetting('the retention window', 'small enough to express as an instant'));
  }

  return ok({
    home,
    backupsDir,
    indexCacheDir,
    cutoff,
    graceCutoff,
    retentionDays,
    graceDays,
    dryRun: options.dryRun === true,
    vacuum: options.vacuum === true,
    scope,
    signal,
    reclaim: reclaim.value,
    walCheckpointBytes,
  });
}

/** Whether `value` is a usable byte count: finite and non-negative. */
function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * {@link RetentionOptions.reclaim} with every default applied, or the
 * `CONFIG_INVALID` refusal of a member it cannot use: a share outside
 * `[0, 1]`, or a byte count that is negative or not finite.
 */
function resolveReclaimGates(
  tuning: RetentionReclaimTuning | undefined,
): Result<ReclaimGates, DebuggenError> {
  if (tuning === undefined) {
    return ok({
      minFreeShare: VACUUM_CONVERSION_MIN_FREE_SHARE,
      minFreeBytes: VACUUM_CONVERSION_MIN_FREE_BYTES,
      maxLiveBytes: VACUUM_CONVERSION_MAX_LIVE_BYTES,
    });
  }
  if (typeof tuning !== 'object' || tuning === null) {
    return err(invalidSetting('reclaim', 'an object of reclaim gates'));
  }
  const minFreeShare = tuning.minFreeShare ?? VACUUM_CONVERSION_MIN_FREE_SHARE;
  if (typeof minFreeShare !== 'number' || !(minFreeShare >= 0 && minFreeShare <= 1)) {
    return err(invalidSetting('reclaim.minFreeShare', 'a number from 0 to 1'));
  }
  const minFreeBytes = tuning.minFreeBytes ?? VACUUM_CONVERSION_MIN_FREE_BYTES;
  if (!isByteCount(minFreeBytes)) {
    return err(invalidSetting('reclaim.minFreeBytes', 'a finite, non-negative number of bytes'));
  }
  const maxLiveBytes = tuning.maxLiveBytes ?? VACUUM_CONVERSION_MAX_LIVE_BYTES;
  if (!isByteCount(maxLiveBytes)) {
    return err(invalidSetting('reclaim.maxLiveBytes', 'a finite, non-negative number of bytes'));
  }
  return ok({ minFreeShare, minFreeBytes, maxLiveBytes });
}

/**
 * Whether `value` is absent or reads like an `AbortSignal` — an object whose
 * `aborted` is a boolean, the one member the sweep reads. Structural rather
 * than `instanceof`, so a signal from another realm or a polyfill is accepted.
 */
function isAbortSignalLike(value: unknown): value is AbortSignal | undefined {
  return (
    value === undefined ||
    (typeof value === 'object' &&
      value !== null &&
      'aborted' in value &&
      typeof value.aborted === 'boolean')
  );
}

/* -------------------------------------------------------------------------------------------------
 * The write-ahead log
 * ---------------------------------------------------------------------------------------------- */

/**
 * Awaits `work`, or stops waiting once `signal` aborts.
 *
 * The work itself is not cancelled — a checkpoint already running on the
 * worker finishes there — but a shutdown no longer waits behind it. A signal
 * that cannot be observed (a structural look-alike without
 * `addEventListener`) is waited out, as a signal-less call is.
 *
 * @returns What `work` resolved to, or `undefined` when the signal aborted first.
 */
async function unlessAborted<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  if (signal === undefined || typeof signal.addEventListener !== 'function') {
    return work;
  }
  if (signal.aborted) {
    return undefined;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolveAborted) => {
    onAbort = () => {
      resolveAborted(undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort !== undefined && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Creates the {@link SweepWal} of one sweep.
 *
 * Nothing is started here: the checkpointer is opened by the first
 * {@link SweepWal.during}, and its thread by the first checkpoint the sweep
 * actually waits for, so a start-up sweep with nothing to delete costs one
 * pragma write and its restore.
 *
 * @param store The sweep's store.
 * @param settings The sweep's settings: `dryRun`, `signal` and `walCheckpointBytes`.
 * @param logger The sweep's logger. A checkpoint the sweep waited for is
 * recorded at `debug` with its outcome, frame counts and duration; one that
 * failed at `warn`, with the binding's reason, before the connection's own
 * checkpoints are restored.
 */
function createSweepWal(store: Store, settings: SweepSettings, logger: Logger): SweepWal {
  let checkpointer: WalCheckpointer | undefined;
  let suspension: AutoCheckpointSuspension | undefined;
  /** Set once background checkpoints are unavailable or have failed; never cleared. */
  let unavailable = false;
  let checkpoints = 0;
  let longestCheckpointMs = 0;

  const resume = (): void => {
    suspension?.restore();
    suspension = undefined;
  };

  const relieve = async (force = false): Promise<void> => {
    if (suspension === undefined || checkpointer === undefined || store.isClosed) {
      return;
    }
    const walBytes = checkpointer.walBytes();
    if (walBytes === 0 || (!force && walBytes < settings.walCheckpointBytes)) {
      return;
    }
    if (settings.signal?.aborted === true) {
      return;
    }

    const outcome = await unlessAborted(checkpointer.checkpoint(), settings.signal);
    if (outcome === undefined) {
      return;
    }
    switch (outcome.status) {
      case 'completed':
      case 'busy':
        checkpoints += 1;
        longestCheckpointMs = Math.max(longestCheckpointMs, outcome.durationMs);
        logger.debug('checkpointed the session store write-ahead log off the event loop', {
          checkpoint: outcome.status,
          busy: outcome.busy,
          logFrames: outcome.logFrames,
          checkpointedFrames: outcome.checkpointedFrames,
          walBytes,
          durationMs: Math.round(outcome.durationMs),
        });
        return;
      case 'failed':
        logger.warn(
          'the background checkpoint of the session store failed; the sweep continues with the connection’s own checkpoints',
          { checkpoint: outcome.status, checkpointReason: outcome.reason, walBytes },
        );
        unavailable = true;
        resume();
        return;
      case 'no-wal':
      case 'closed':
        unavailable = true;
        resume();
        return;
    }
  };

  return {
    async during(phase: () => Promise<void>): Promise<void> {
      if (settings.dryRun || unavailable || store.isClosed) {
        await phase();
        return;
      }
      checkpointer ??= openWalCheckpointer(store);
      if (checkpointer === undefined) {
        unavailable = true;
        await phase();
        return;
      }
      suspension = suspendAutoCheckpoint(store);
      try {
        await phase();
      } finally {
        resume();
      }
    },
    relieve,
    async close(): Promise<void> {
      resume();
      await checkpointer?.close();
    },
    get checkpoints(): number {
      return checkpoints;
    },
    get longestCheckpointMs(): number {
      return longestCheckpointMs;
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * The scope of an on-demand sweep
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether the sweep may act on state of `projectRoot`: always for a
 * machine-wide sweep, otherwise when {@link RetentionOptions.scope} admits the
 * normalised root. The answer is awaited, so a scope may resolve the root on
 * disk; no caller holds a transaction open across this call. A scope that
 * throws, rejects, or answers anything but `true` keeps the state; a throw or
 * a rejection is logged by code only.
 */
async function admits(context: SweepContext, projectRoot: string): Promise<boolean> {
  const { scope } = context.settings;
  if (scope === undefined) {
    return true;
  }
  try {
    return (await scope(normalizePosix(projectRoot))) === true;
  } catch (caught) {
    context.logger.warn('the retention scope check failed; the item is kept', {
      code: DebuggenError.from(caught, 'INTERNAL').code,
    });
    return false;
  }
}

/**
 * Whether a scoped sweep may act on the session `sessionId` — or on the
 * `backups/<sessionId>` directory named for it: its row must exist and the
 * scope admit its stored project root. Always `true` for a machine-wide sweep,
 * which reads nothing here. A row that is gone, or a name that is no session's
 * id, has no known project and is outside every scope; a read the store
 * refuses is recorded as an issue and read as outside too. Settled before the
 * session's deciding transaction opens, so awaiting the scope never holds the
 * write lock.
 */
async function sessionInScope(
  context: SweepContext,
  state: SweepState,
  sessionId: SessionId,
): Promise<boolean> {
  if (context.settings.scope === undefined) {
    return true;
  }
  const target = context.deps.sessions.getAccessTarget(sessionId);
  if (isErr(target)) {
    recordIssue(context, state, 'database', 'sessions.getAccessTarget', target.error);
    return false;
  }
  return target.value !== undefined && (await admits(context, target.value.projectRoot));
}

/**
 * Whether a scoped sweep may remove an index-cache entry that records `roots`:
 * only when it records at least one and the scope admits every one, asked one
 * root at a time and stopping at the first it refuses. Always `true` for a
 * machine-wide sweep.
 */
async function cacheEntryInScope(
  context: SweepContext,
  roots: readonly string[],
): Promise<boolean> {
  if (context.settings.scope === undefined) {
    return true;
  }
  if (roots.length === 0) {
    return false;
  }
  for (const root of roots) {
    if (!(await admits(context, root))) {
      return false;
    }
  }
  return true;
}

/* -------------------------------------------------------------------------------------------------
 * The per-session decision
 * ---------------------------------------------------------------------------------------------- */

/** A column value as an integer, or `undefined`. */
function readInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return undefined;
}

/**
 * Whether the caller reports the session as held by a live component, through
 * {@link RetentionDeps.isSessionInUse}. A predicate that throws is taken to
 * mean "in use" — the only safe reading for a module that deletes — and the
 * failure is logged by code.
 */
function claimedInUse(context: SweepContext, sessionId: SessionId): boolean {
  const predicate = context.deps.isSessionInUse;
  if (predicate === undefined) {
    return false;
  }
  try {
    return predicate(sessionId);
  } catch (caught) {
    context.logger.warn('the in-use check failed; the session is kept', {
      sessionId,
      code: DebuggenError.from(caught, 'INTERNAL').code,
    });
    return true;
  }
}

/**
 * Tells {@link RetentionDeps.onSessionDeleted} of a session whose deleting
 * transaction has committed. A listener that throws is logged by code only —
 * the session is gone either way — and never fails the sweep.
 */
function announceDeleted(context: SweepContext, sessionId: SessionId): void {
  const listener = context.deps.onSessionDeleted;
  if (listener === undefined) {
    return;
  }
  try {
    listener(sessionId);
  } catch (caught) {
    context.logger.warn('the listener for a purged session failed', {
      sessionId,
      code: DebuggenError.from(caught, 'INTERNAL').code,
    });
  }
}

/**
 * Inside a deciding transaction whose checks all passed: deletes one batch of
 * a session's oldest telemetry when it holds more than one batch, and answers
 * how many events went.
 *
 * `0` means the session holds at most {@link DEFAULT_PURGE_BATCH_SIZE} events
 * — its probe reads no further than one batch and one row, however large the
 * session — so the caller deletes it whole with the cascade. A batch that
 * deleted nothing answers `0` as well: the cascade is then the one statement
 * certain to make progress, and it removes the rest atomically. A probe whose
 * count column is unreadable is read as "at most one batch" for the same
 * reason; the repository's full count that follows reports the corruption.
 */
function drainOneBatch(store: Store, sessionId: SessionId): number {
  const probe = store
    .statement(SESSION_TELEMETRY_PROBE_SQL)
    .get(sessionId, DEFAULT_PURGE_BATCH_SIZE + 1);
  const held = readInteger(probe?.['events']);
  if (held === undefined || held <= DEFAULT_PURGE_BATCH_SIZE) {
    return 0;
  }
  const { changes } = store
    .statement(DELETE_SESSION_BATCH_SQL)
    .run(sessionId, DEFAULT_PURGE_BATCH_SIZE);
  return Number(changes);
}

/**
 * Evaluates one candidate against the database as it stands **now** and, when
 * `remove` is set and every check passes, deletes it — or, for a session
 * holding more than one purge batch of telemetry, one batch of it.
 *
 * Synchronous from its first read to the delete, so in a real sweep — where it
 * runs as the body of one `Store.transaction` — nothing can land between the
 * decision and the deletion, and nothing of the session is deleted before the
 * decision is final. The checks, in order:
 *
 * 1. the row still exists (`gone` otherwise);
 * 2. it is still older than the cutoff — a session touched after it was listed
 *    has become active again (`refreshed`);
 * 3. its journal holds no `conflict` record (`conflict`) — the exemption of
 *    AAP 0.5.1, re-read here so a conflict the watcher marked after the
 *    candidate's pre-check still protects it;
 * 4. it is not active: not in an in-flight status (`in-flight`) and holding
 *    no open capture window (`capture-open`) — ingest into an open window never
 *    touches `updated_at`, so the age alone cannot see such a session working;
 * 5. its journal holds no other record that still describes a patched file
 *    (`open-modifications`);
 * 6. the caller does not claim it (`in-use`,
 *    {@link RetentionDeps.isSessionInUse}).
 *
 * Only then, when `remove` is set, is the hold bounded: a session holding more
 * than {@link DEFAULT_PURGE_BATCH_SIZE} telemetry events
 * ({@link SESSION_TELEMETRY_PROBE_SQL}) loses one batch of its oldest events
 * (`DELETE_SESSION_BATCH_SQL`) and nothing else, and the answer is `drained`:
 * its row, plans, panels, analyses, journal and remaining events stay for a
 * later transaction, which re-runs every check above first. A session of at
 * most one batch — or the rest of a drained one — has the counts the report
 * states read — telemetry, panels, analyses and journal records, inside the
 * same transaction, so they are exactly what the cascade removes — and its
 * row deleted, the schema's `ON DELETE CASCADE` taking every child row in the
 * same statement. In a dry run the same checks and counts run as plain reads,
 * the whole session is counted at once, and nothing is deleted.
 *
 * @throws Whatever the store throws, and the `DebuggenError` of a repository
 * read or delete that answered `Err` — thrown so the surrounding transaction
 * rolls back; {@link decideSession} turns either into its `failed` result.
 */
function evaluateSession(
  context: SweepContext,
  sessionId: SessionId,
  remove: boolean,
): SessionVerdict {
  const { store, sessions, telemetry, panels } = context.deps;

  const row = store.statement(SESSION_STATE_SQL).get(sessionId);
  if (row === undefined) {
    return { outcome: 'gone' };
  }
  const updatedAt = readInteger(row['updated_at']);
  if (updatedAt === undefined || updatedAt >= context.settings.cutoff) {
    return { outcome: 'refreshed' };
  }

  const journal = store
    .statement(SESSION_JOURNAL_SQL)
    .get(REVERTED_STATUS, CONFLICT_STATUS, sessionId);
  const records = readInteger(journal?.['records']);
  const openRecords = readInteger(journal?.['open_records']);
  const conflictRecords = readInteger(journal?.['conflict_records']);
  if (conflictRecords !== undefined && conflictRecords > 0) {
    return { outcome: 'conflict', conflicts: conflictRecords };
  }

  const status = row['status'];
  if (typeof status !== 'string' || !isSessionStatus(status) || IN_FLIGHT_STATUS_SET.has(status)) {
    return { outcome: 'in-flight' };
  }
  const capture = store.statement(SESSION_OPEN_CAPTURE_SQL).get(sessionId);
  const captureOpen = readInteger(capture?.['capture_open']);
  if (captureOpen === undefined || captureOpen !== 0) {
    return { outcome: 'capture-open' };
  }

  if (
    records === undefined ||
    openRecords === undefined ||
    conflictRecords === undefined ||
    openRecords > 0
  ) {
    return { outcome: 'open-modifications', openRecords };
  }

  // Last, as its contract states: the caller is asked only about a session
  // every rule of this module would delete.
  if (claimedInUse(context, sessionId)) {
    return { outcome: 'in-use' };
  }

  if (remove) {
    const drained = drainOneBatch(store, sessionId);
    if (drained > 0) {
      return { outcome: 'drained', events: drained };
    }
  }

  const events = telemetry.countBySession(sessionId);
  if (isErr(events)) {
    throw events.error;
  }
  const documents = panels.countBySession(sessionId);
  if (isErr(documents)) {
    throw documents.error;
  }
  const counts: SessionCounts = {
    telemetry: events.value,
    panels: documents.value.panels,
    analyses: documents.value.analyses,
    modifications: records,
  };
  if (!remove) {
    return { outcome: 'deleted', counts };
  }

  const deleted = sessions.delete(sessionId);
  if (isErr(deleted)) {
    // Thrown so `Store.transaction` rolls back; caught by `decideSession`.
    throw deleted.error;
  }
  return deleted.value === 0 ? { outcome: 'gone' } : { outcome: 'deleted', counts };
}

/**
 * The issue for a candidate whose decision the store refused. A repository's
 * own coded error is kept; an engine error is wrapped in a fixed sentence, so
 * no engine message — which may quote a value — reaches the report.
 */
function decisionFailed(sessionId: SessionId, cause: unknown): DebuggenError {
  if (DebuggenError.is(cause)) {
    return cause;
  }
  return new DebuggenError(
    'STORE_ERROR',
    `The retention decision for session ${sessionId} failed in the session store; none of its rows were deleted.`,
    {
      hint: 'The next start or purge evaluates the session again.',
      details: { subsystem: SUBSYSTEM, component: COMPONENT, sessionId, operation: 'purge' },
      cause,
    },
  );
}

/**
 * The issue for a large session whose drain the store refused after earlier
 * batches had committed. Always a fixed sentence, whatever the cause — which
 * is kept as the error's `cause` and never quoted — so the report says what
 * was kept and what was not; the cause's own code is kept when it has one.
 */
function drainFailed(sessionId: SessionId, drained: number, cause: unknown): DebuggenError {
  return new DebuggenError(
    DebuggenError.is(cause) ? cause.code : 'STORE_ERROR',
    `The retention purge of session ${sessionId} failed in the session store after ${String(drained)} of its telemetry events were deleted in bounded batches; its row and its remaining evidence were kept.`,
    {
      hint: 'The next start or purge resumes the purge of the session.',
      details: {
        subsystem: SUBSYSTEM,
        component: COMPONENT,
        sessionId,
        operation: 'purge',
        drainedEvents: drained,
      },
      cause,
    },
  );
}

/**
 * Decides one candidate: in a real sweep through `BEGIN IMMEDIATE`
 * transactions that each re-run every check before deleting anything, and in
 * a dry run as one evaluation of plain reads that delete nothing.
 *
 * A session of at most {@link DEFAULT_PURGE_BATCH_SIZE} telemetry events takes
 * one transaction, and its purge is atomic: a session refreshed at any point
 * keeps all of its evidence, and a failure anywhere in the cascade — a
 * trigger, a constraint, a full disk — rolls the whole session back.
 *
 * A larger one is drained, one committed batch per transaction with a yield
 * to the event loop after each, until its final transaction deletes the row
 * with the cascade. The guarantee for it is narrower, as the module overview's
 * "Atomic per session, bounded per transaction" states: when a later
 * transaction finds it ineligible (`refreshed`, `in-use`, `capture-open`, …),
 * or the signal or a closed store stops the drain between batches (`halted`),
 * or the store refuses a transaction (`failed`), the batches already committed
 * stay deleted and everything else of the session stays; {@link SessionDecision.drained}
 * says how many events that is.
 */
async function decideSession(
  context: SweepContext,
  state: SweepState,
  sessionId: SessionId,
): Promise<SessionDecision> {
  const { store } = context.deps;
  const remove = !context.settings.dryRun;
  let drained = 0;

  for (;;) {
    let verdict: SessionVerdict;
    try {
      verdict = remove
        ? store.transaction((): SessionVerdict => evaluateSession(context, sessionId, true))
        : evaluateSession(context, sessionId, false);
    } catch (caught) {
      const error =
        drained === 0 ? decisionFailed(sessionId, caught) : drainFailed(sessionId, drained, caught);
      return { result: { outcome: 'failed', error }, drained };
    }
    if (verdict.outcome !== 'drained') {
      return { result: verdict, drained };
    }

    drained += verdict.events;
    // Before the next batch: the log this one grew, folded in off the event
    // loop once it is large enough to need it.
    await context.wal.relieve();
    // The batch just held the event loop; let queued work run before the next.
    await yieldToEventLoop();
    if (store.isClosed) {
      // Reported once, by the candidate loop's own store check.
      return { result: { outcome: 'halted', reason: 'store-closed' }, drained };
    }
    if (isInterrupted(context, state, 'drain-batch')) {
      return { result: { outcome: 'halted', reason: 'interrupted' }, drained };
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Rule 1 — aged sessions
 * ---------------------------------------------------------------------------------------------- */

/** Records an aged session kept because its journal holds a conflict. */
function retainForConflicts(
  context: SweepContext,
  state: SweepState,
  sessionId: SessionId,
  conflicts: number,
): void {
  reportId(state, 'sessionsRetainedForConflicts', sessionId);
  context.logger.info('retaining an aged session: its journal holds an unresolved conflict', {
    sessionId,
    conflicts,
  });
}

/** Records an aged session kept because it is still active. */
function retainActive(
  context: SweepContext,
  state: SweepState,
  candidate: RetentionCandidate,
  reason: ActiveReason,
): void {
  reportId(state, 'sessionsRetainedActive', candidate.id);
  context.logger.info('retaining an aged session: it is still active', {
    sessionId: candidate.id,
    status: candidate.status,
    reason,
  });
}

/**
 * Decides and — unless it must be kept — deletes one candidate.
 *
 * Before anything else the journal is asked whether it holds a `conflict`
 * record for the session. If so, the session is **retained**: AAP 0.5.1
 * exempts a conflict backup until the developer resolves the conflict, and the
 * journal row is what makes that backup interpretable — it names the file, the
 * hashes and the diff — so the row must outlive the window too. Everything
 * else is decided by {@link decideSession}: atomically with the deletion for a
 * session of at most one purge batch of telemetry, batch by batch for a larger
 * one — whose drained events count in the report however its decision ends,
 * and whose stop part-way is logged at `warn` with its id and drained count.
 *
 * In a scoped sweep a session outside the scope is skipped before any of
 * that: nothing about it is read beyond its project root, and it appears in no
 * list of the report.
 *
 * @returns Whether the session was deleted (in a dry run: would have been).
 */
async function purgeCandidate(
  context: SweepContext,
  state: SweepState,
  candidate: RetentionCandidate,
): Promise<boolean> {
  const sessionId = candidate.id;

  // Settled here, before the deciding transaction below opens: an asynchronous
  // scope is never awaited while `BEGIN IMMEDIATE` holds the write lock.
  if (!(await sessionInScope(context, state, sessionId))) {
    return false;
  }

  const conflicts = await context.deps.modifications.listConflicts(sessionId);
  if (isErr(conflicts)) {
    recordIssue(context, state, 'session', sessionId, conflicts.error);
    return false;
  }
  if (conflicts.value.length > 0) {
    retainForConflicts(context, state, sessionId, conflicts.value.length);
    return false;
  }

  const { result: verdict, drained } = await decideSession(context, state, sessionId);
  // Committed drain batches are gone whatever the last transaction decided,
  // so they count, exactly, in every branch below.
  state.telemetryEventsDeleted += drained;
  if (drained > 0 && verdict.outcome === 'halted') {
    // The sweep itself was stopped — a shutdown's abort or the store closing —
    // not the session: expected, so `info`, and the next sweep resumes it.
    context.logger.info(
      'the purge of a large session stopped part-way because the sweep was stopped; the next sweep carries on with it',
      { sessionId, outcome: verdict.reason, drainedEvents: drained },
    );
  } else if (drained > 0 && verdict.outcome !== 'deleted') {
    context.logger.warn(
      'a large session stopped being eligible part-way through its purge; its row and remaining evidence were kept',
      { sessionId, outcome: verdict.outcome, drainedEvents: drained },
    );
  }

  switch (verdict.outcome) {
    case 'failed':
      recordIssue(context, state, 'session', sessionId, verdict.error);
      return false;
    case 'halted':
      // The signal or a closed store stopped the drain; the candidate loop
      // stops at its next boundary and reports why.
      return false;
    case 'deleted':
      state.sessionsDeleted += 1;
      reportId(state, 'sessionIdsDeleted', sessionId);
      state.telemetryEventsDeleted += verdict.counts.telemetry;
      state.panelsDeleted += verdict.counts.panels;
      state.analysesDeleted += verdict.counts.analyses;
      state.modificationsDeleted += verdict.counts.modifications;
      if (!context.settings.dryRun) {
        announceDeleted(context, sessionId);
      }
      return true;
    case 'conflict':
      retainForConflicts(context, state, sessionId, verdict.conflicts);
      return false;
    case 'in-flight':
    case 'capture-open':
    case 'in-use':
      retainActive(context, state, candidate, verdict.outcome);
      return false;
    case 'open-modifications':
      recordIssue(
        context,
        state,
        'session',
        sessionId,
        openRecordsRetained(sessionId, verdict.openRecords),
      );
      return false;
    case 'gone':
    case 'refreshed':
      // Gone already, or touched since it was listed: neither is a problem.
      context.logger.debug('aged session no longer eligible at deletion time', {
        sessionId,
        outcome: verdict.outcome,
      });
      return false;
  }
}

/**
 * The backups directory of a session, `backups/<sessionId>`, or `undefined`
 * when the id does not name a directory directly inside the backups root (an
 * id carrying a separator or a traversal).
 */
function sessionBackupDirectory(settings: SweepSettings, sessionId: SessionId): string | undefined {
  const directory = joinPosix(settings.backupsDir, sessionId);
  return dirnamePosix(directory) === settings.backupsDir &&
    basenamePosix(directory) === sessionId &&
    isStrictlyWithin(settings.home, directory)
    ? directory
    : undefined;
}

/**
 * Removes the backup directories of the sessions one page purged.
 *
 * A backup lives in the directory of the session whose record it protects —
 * the path the backup store composes, `backups/<sessionId>/<originalHash>`, or
 * a relocation into a subdirectory of that same directory — and the store
 * never resolves one session's record to a file in another session's
 * directory (`@debuggen/instrumentation`'s `patch/backup-store.ts`). A purged
 * session's own records went with its row in the cascade (in a dry run: would
 * have gone), so nothing left in the journal can need its directory, and no
 * journal read is required to remove it. What remains is the containment
 * discipline: a directory that is a link or not a directory, or that holds a
 * link anywhere inside it, is reported and left in place for the orphan rule,
 * which judges its files one by one.
 */
async function removePurgedBackups(
  context: SweepContext,
  state: SweepState,
  purged: readonly SessionId[],
  backupsRoot: NodeIdentity,
): Promise<void> {
  const { home, dryRun } = context.settings;

  for (const sessionId of purged) {
    // A directory left behind by an interrupted sweep has no row any more; the
    // orphan rule of the next sweep removes its files.
    if (isInterrupted(context, state, 'backup')) {
      return;
    }
    const directory = sessionBackupDirectory(context.settings, sessionId);
    if (directory === undefined) {
      recordIssue(
        context,
        state,
        'backup',
        sessionId,
        unsafePath(
          sessionId,
          'unsafe-session-id',
          `The id of session ${sessionId} does not name a directory inside the backups root; no backup directory was touched for it.`,
        ),
      );
      continue;
    }

    const target = relativeToHome(home, directory);
    const inspection = await inspectDirectory(home, directory);
    if (inspection.kind === 'absent') {
      continue;
    }
    if (inspection.kind === 'unsafe') {
      recordIssue(context, state, 'backup', target, inspection.error);
      continue;
    }

    const survey = await surveyTree(directory);
    if (survey.link !== undefined) {
      recordIssue(context, state, 'backup', target, treeHoldsLink(home, directory, survey.link));
      continue;
    }
    if (dryRun) {
      state.removedDirectories.add(directory);
    } else {
      const removed = await removeTreeWithin(home, directory, backupsRoot, inspection.identity);
      if (isErr(removed)) {
        recordIssue(context, state, 'backup', target, removed.error);
        continue;
      }
      if (!removed.value) {
        continue;
      }
    }

    state.backupDirsDeleted += 1;
    state.bytesReclaimed += survey.bytes;
  }
}

/**
 * Rule 1: deletes every aged session that is neither conflicted, active nor
 * still patching a file, and its backup directory.
 *
 * Candidates come in keyset pages — `updated_at ASC, rowid ASC`, strictly
 * before a cutoff computed once for the whole sweep, read from the
 * `updated_at` index without a sort — and each page is completely purged
 * before the next is read: its sessions decided and deleted one transaction at
 * a time, then their backup directories removed. The cursor moves past every
 * candidate of a page whatever happened to it, so a retained session is never
 * read twice and a deleted one cannot shift a later page; a session refreshed
 * mid-sweep simply stops matching the cutoff. The sweep yields to the event
 * loop after every deleted session — whose cascade held it — between the drain
 * batches of a large one, and between pages, and it stops before the next page
 * or the next candidate once {@link RetentionOptions.signal} is aborted.
 *
 * A session holding an open record other than a conflict (which
 * reconciliation in `src/main.ts` normally settles before this sweep runs) is
 * retained and reported, because deleting the only record of a patched file
 * would abandon that file permanently.
 */
async function purgeAgedSessions(context: SweepContext, state: SweepState): Promise<void> {
  const { deps, settings } = context;
  let backupsRoot: DirectoryInspection | undefined;
  let after: RetentionCandidateCursor | undefined;

  for (;;) {
    if (isInterrupted(context, state, 'candidate-page')) {
      return;
    }
    if (!storeUsable(context, state, 'sessions.listRetentionCandidates')) {
      return;
    }
    const page = deps.sessions.listRetentionCandidates({
      updatedBefore: settings.cutoff,
      after,
      limit: RETENTION_CANDIDATE_PAGE_SIZE,
    });
    if (isErr(page)) {
      recordIssue(context, state, 'database', 'sessions.listRetentionCandidates', page.error);
      return;
    }
    const last = page.value.at(-1);
    if (last === undefined) {
      return;
    }

    const purged: SessionId[] = [];
    for (const candidate of page.value) {
      if (isInterrupted(context, state, 'session')) {
        return;
      }
      if (!storeUsable(context, state, 'sessions.delete')) {
        return;
      }
      if (await purgeCandidate(context, state, candidate)) {
        purged.push(candidate.id);
        if (!settings.dryRun) {
          await context.wal.relieve();
          // The cascade just held the event loop; let queued work run.
          await yieldToEventLoop();
        }
      }
    }

    if (purged.length > 0) {
      backupsRoot ??= await inspectBackupsRoot(context, state);
      if (backupsRoot.kind === 'directory') {
        await removePurgedBackups(context, state, purged, backupsRoot.identity);
      }
    }

    if (page.value.length < RETENTION_CANDIDATE_PAGE_SIZE) {
      return;
    }
    after = { updatedAt: last.updatedAt, position: last.position };
    await yieldToEventLoop();
  }
}

/**
 * Inspects the backups root once for Rule 1, recording an issue when it is a
 * link or not a directory. Absent is not a problem: nothing was ever backed up.
 */
async function inspectBackupsRoot(
  context: SweepContext,
  state: SweepState,
): Promise<DirectoryInspection> {
  const { home, backupsDir } = context.settings;
  const inspection = await inspectDirectory(home, backupsDir);
  if (inspection.kind === 'unsafe') {
    recordIssue(context, state, 'backup', relativeToHome(home, backupsDir), inspection.error);
  }
  return inspection;
}

/** The issue for an aged session kept because its journal still describes a patched file. */
function openRecordsRetained(sessionId: SessionId, count: number | undefined): DebuggenError {
  const held =
    count === undefined
      ? 'open modification records'
      : `${String(count)} open modification record(s)`;
  return new DebuggenError(
    'CLEANUP_PARTIAL',
    `Session ${sessionId} is past the retention window but still holds ${held}; it was retained because its journal is the only record able to restore those files.`,
    {
      hint: 'Restart the Debug Generator service so start-up reconciliation restores or reports those files; the next purge removes the session.',
      details: { subsystem: SUBSYSTEM, component: COMPONENT, sessionId },
    },
  );
}

/* -------------------------------------------------------------------------------------------------
 * Rule 3 — orphan backups
 * ---------------------------------------------------------------------------------------------- */

/**
 * Removes one orphan — or, in a dry run, counts it — and reports whether it is
 * gone.
 */
async function removeOrphan(
  context: SweepContext,
  state: SweepState,
  candidate: OrphanCandidate,
): Promise<boolean> {
  const { home, dryRun } = context.settings;
  if (!dryRun) {
    const removed = await removeFileWithin(
      home,
      candidate.path,
      candidate.parent,
      candidate.identity,
    );
    if (isErr(removed)) {
      recordIssue(context, state, 'backup', relativeToHome(home, candidate.path), removed.error);
      return false;
    }
  }
  state.orphanBackupsDeleted += 1;
  state.bytesReclaimed += candidate.size;
  return true;
}

/**
 * Judges one batch of a session directory's old files against that session's
 * records, and removes the ones none of them references.
 *
 * A record references a file of its session's directory when the file is the
 * composed backup of the record — named by the record's `originalHash` — or
 * when the record's normalised `backupPath` names it. Records of any status
 * count, and a file a `conflict` record names is kept even should the two
 * readings ever disagree. The probe is one indexed read of this session's
 * records (`scanSessionBackupReferences`), whatever the size of the rest of
 * the journal. When it fails, nothing of the directory is removed on this
 * pass: without the journal no file can be told apart from an orphan.
 */
async function judgeCandidates(
  context: SweepContext,
  state: SweepState,
  directory: WalkedDirectory,
  candidates: readonly OrphanCandidate[],
): Promise<void> {
  const byName = new Set(candidates.map((candidate) => candidate.name));
  const referenced = new Set<string>();
  const conflicted = new Set<string>();

  if (!storeUsable(context, state, 'modifications.scanSessionBackupReferences')) {
    directory.blocked = true;
    return;
  }
  const scanned = scanSessionBackupReferences(
    context.deps.store,
    directory.sessionId,
    (reference) => {
      const names = [reference.originalHash];
      const recorded = normalizePosix(reference.backupPath);
      if (dirnamePosix(recorded) === directory.path) {
        names.push(basenamePosix(recorded));
      }
      for (const name of names) {
        if (byName.has(name)) {
          referenced.add(name);
          if (reference.status === CONFLICT_STATUS) {
            conflicted.add(name);
          }
        }
      }
      return true;
    },
  );
  if (isErr(scanned)) {
    recordIssue(
      context,
      state,
      'database',
      'modifications.scanSessionBackupReferences',
      scanned.error,
    );
    directory.blocked = true;
    return;
  }

  for (const candidate of candidates) {
    if (isInterrupted(context, state, 'backup')) {
      // What is left of the directory waits for the next sweep, which judges
      // it again from the start.
      directory.blocked = true;
      return;
    }
    if (conflicted.has(candidate.name) || referenced.has(candidate.name)) {
      continue;
    }
    if (await removeOrphan(context, state, candidate)) {
      directory.remaining -= 1;
      directory.removedAny = true;
    }
  }
}

/**
 * Walks one `backups/<sessionId>` directory — exactly one level, the level the
 * backup store writes `<originalHash>` files at — and judges its old files in
 * batches of at most {@link BACKUP_PROBE_BATCH_SIZE}, one indexed journal
 * probe per batch. A file younger than the grace window is kept without being
 * looked up at all, so a directory holding nothing old costs no journal read.
 *
 * A subdirectory is where a relocated (quarantined) backup lives, and it is
 * never descended into: those files are reached only through the record that
 * names them. A link is reported and left. When every entry was a file this
 * walk removed, the directory itself is removed; a directory that still holds
 * anything — a referenced backup, a young orphan, a subdirectory, a link — is
 * left alone, as is one a failed probe covered.
 */
async function walkBackupDirectory(
  context: SweepContext,
  state: SweepState,
  path: string,
  identity: NodeIdentity,
  backupsRoot: NodeIdentity,
): Promise<void> {
  const { home, graceCutoff, dryRun } = context.settings;
  const target = relativeToHome(home, path);

  let names: string[];
  try {
    names = await listNames(path);
  } catch (cause) {
    recordIssue(context, state, 'backup', target, fsFailure('read', target, cause));
    return;
  }

  const directory: WalkedDirectory = {
    path,
    sessionId: basenamePosix(path),
    identity,
    remaining: names.length,
    removedAny: false,
    blocked: false,
  };
  let batch: OrphanCandidate[] = [];

  for (const name of names) {
    if (isInterrupted(context, state, 'backup')) {
      directory.blocked = true;
      break;
    }
    const entryPath = joinPosix(path, name);
    const entry = relativeToHome(home, entryPath);
    let stats: Stats | undefined;
    try {
      stats = await lstatIfPresent(entryPath);
    } catch (cause) {
      recordIssue(context, state, 'backup', entry, fsFailure('inspect', entry, cause));
      continue;
    }
    if (stats === undefined) {
      directory.remaining -= 1;
      continue;
    }
    if (stats.isSymbolicLink()) {
      recordIssue(context, state, 'backup', entry, linkLeftInPlace(entry));
      continue;
    }
    if (!stats.isFile() || stats.mtimeMs >= graceCutoff || directory.blocked) {
      continue;
    }
    batch.push({
      path: entryPath,
      name,
      identity: identityOf(stats),
      size: stats.size,
      parent: identity,
    });
    if (batch.length >= BACKUP_PROBE_BATCH_SIZE) {
      await judgeCandidates(context, state, directory, batch);
      batch = [];
    }
  }
  if (batch.length > 0 && !directory.blocked) {
    await judgeCandidates(context, state, directory, batch);
  }

  if (directory.blocked || !directory.removedAny || directory.remaining > 0) {
    return;
  }
  if (!dryRun) {
    const removed = await removeEmptyDirectoryWithin(home, path, backupsRoot, identity);
    if (isErr(removed)) {
      recordIssue(context, state, 'backup', target, removed.error);
      return;
    }
    if (!removed.value) {
      return;
    }
  }
  state.backupDirsDeleted += 1;
}

/** The refusal to follow a link met by the orphan walk. */
function linkLeftInPlace(entry: string): DebuggenError {
  return unsafePath(
    entry,
    'symlink',
    `${entry} is a symbolic link; the retention sweep does not follow it and left it in place.`,
  );
}

/**
 * Rule 3: removes backup files no journal row references once they are older
 * than the grace window, then any session directory that left empty.
 *
 * The walk is bounded to the layout the backup store writes —
 * `backups/<sessionId>/<originalHash>` — which keeps it cheap and keeps it from
 * ever wandering. It covers the mirror case of Rule 1 as well: the directory of
 * a session whose row is already gone (purged by an earlier sweep that could
 * not remove the directory) is not deleted wholesale, its files age out under
 * the same grace window as any other orphan.
 *
 * Only files older than the grace window are candidates, and only candidates
 * are looked up — one session directory at a time, through an indexed read of
 * that session's records alone — so a backup tree holding nothing old costs no
 * journal read, and neither the journal nor the tree is ever held in memory.
 * A stray file directly under `backups/` belongs to no session directory, so
 * no record can resolve to it: it is judged by the grace window alone. The
 * probes run **after** Rule 1, so they see the records the purge removed. A
 * directory Rule 1 would have removed in a dry run is skipped, so its files
 * are never counted twice.
 *
 * A scoped sweep judges only the entries named for a session whose stored
 * project root the scope admits ({@link sessionInScope}), and of those only
 * directories: an entry named for no session, or for a session outside the
 * scope, is not even inspected, and stray files wait for a machine-wide sweep.
 */
async function sweepOrphanBackups(context: SweepContext, state: SweepState): Promise<void> {
  const { settings } = context;
  const scoped = settings.scope !== undefined;
  const rootTarget = relativeToHome(settings.home, settings.backupsDir);
  if (isInterrupted(context, state, 'backup')) {
    return;
  }

  const root = await inspectDirectory(settings.home, settings.backupsDir);
  if (root.kind === 'absent') {
    return;
  }
  if (root.kind === 'unsafe') {
    recordIssue(context, state, 'backup', rootTarget, root.error);
    return;
  }
  if (!storeUsable(context, state, 'modifications.scanSessionBackupReferences')) {
    return;
  }

  let names: string[];
  try {
    names = await listNames(settings.backupsDir);
  } catch (cause) {
    recordIssue(context, state, 'backup', rootTarget, fsFailure('read', rootTarget, cause));
    return;
  }

  for (const name of names) {
    if (isInterrupted(context, state, 'backup')) {
      return;
    }
    const path = joinPosix(settings.backupsDir, name);
    if (dirnamePosix(path) !== settings.backupsDir || !isStrictlyWithin(settings.home, path)) {
      continue;
    }
    if (state.removedDirectories.has(path)) {
      continue;
    }
    if (scoped && !(await sessionInScope(context, state, name))) {
      continue;
    }
    const entry = relativeToHome(settings.home, path);

    let stats: Stats | undefined;
    try {
      stats = await lstatIfPresent(path);
    } catch (cause) {
      recordIssue(context, state, 'backup', entry, fsFailure('inspect', entry, cause));
      continue;
    }
    if (stats === undefined) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      recordIssue(context, state, 'backup', entry, linkLeftInPlace(entry));
      continue;
    }
    if (stats.isDirectory()) {
      await walkBackupDirectory(context, state, path, identityOf(stats), root.identity);
      continue;
    }
    if (!scoped && stats.isFile() && stats.mtimeMs < settings.graceCutoff) {
      // Not a layout the backup store writes: a stray file directly under
      // backups/ sits in no session's directory, so no record resolves to it,
      // and it is judged by the grace window like any other orphan. It
      // belongs to no project, so only a machine-wide sweep judges it.
      await removeOrphan(context, state, {
        path,
        name,
        identity: identityOf(stats),
        size: stats.size,
        parent: root.identity,
      });
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Rule 2 — code-index caches
 * ---------------------------------------------------------------------------------------------- */

/**
 * The project roots with at least one session updated at or after `cutoff`:
 * the projects "opened inside the window", whose caches are kept.
 *
 * The session list is ordered by `updated_at` descending, so paging stops at
 * the first session older than the cutoff instead of reading the whole table.
 */
function listActiveProjectRoots(
  sessions: SessionsRepo,
  cutoff: number,
): Result<Set<string>, DebuggenError> {
  const roots = new Set<string>();
  let offset = 0;

  for (;;) {
    const page = sessions.list({ limit: MAX_SESSION_LIST_LIMIT, offset });
    if (isErr(page)) {
      return page;
    }
    for (const item of page.value.items) {
      if (item.updatedAt < cutoff) {
        return ok(roots);
      }
      roots.add(normalizePosix(item.projectRoot));
    }
    offset += page.value.items.length;
    if (page.value.items.length < MAX_SESSION_LIST_LIMIT || offset >= page.value.total) {
      return ok(roots);
    }
  }
}

/** The `projectRoot` strings a parsed cache document records, at either level. */
function projectRootsOf(document: unknown): string[] {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return [];
  }
  const roots: string[] = [];
  if ('projectRoot' in document && typeof document.projectRoot === 'string') {
    roots.push(document.projectRoot);
  }
  if ('index' in document) {
    const { index } = document;
    if (
      typeof index === 'object' &&
      index !== null &&
      'projectRoot' in index &&
      typeof index.projectRoot === 'string'
    ) {
      roots.push(index.projectRoot);
    }
  }
  return roots;
}

/**
 * What the sweep reads out of one cache document: the project roots it
 * records and, when it is a code-index cache envelope, the envelope version it
 * was written under.
 */
interface IndexDocumentMetadata {
  /** Every `projectRoot` the document records, at either level. */
  readonly roots: readonly string[];
  /**
   * The envelope's `schemaVersion`, set only for a document that has the shape
   * `@debuggen/code-analysis` writes — a finite top-level `schemaVersion` and
   * an `index` object recording a `projectRoot`. `undefined` for any other
   * document, which the supersession rules therefore never judge.
   */
  readonly envelopeVersion: number | undefined;
}

/** The {@link IndexDocumentMetadata} of a parsed cache document. */
function indexDocumentMetadata(document: unknown): IndexDocumentMetadata {
  const roots = projectRootsOf(document);
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { roots, envelopeVersion: undefined };
  }
  const version = 'schemaVersion' in document ? document.schemaVersion : undefined;
  const index = 'index' in document ? document.index : undefined;
  const isEnvelope =
    typeof version === 'number' &&
    Number.isFinite(version) &&
    typeof index === 'object' &&
    index !== null &&
    'projectRoot' in index &&
    typeof index.projectRoot === 'string';
  return { roots, envelopeVersion: isEnvelope ? version : undefined };
}

/**
 * Reads what one cache document records: its project roots and, for a
 * code-index cache envelope, its envelope version.
 *
 * The entry format belongs to `@debuggen/code-analysis`, which names a file by
 * a project hash and records the indexed root as `index.projectRoot` and the
 * envelope version as `schemaVersion`; a top-level `projectRoot` is accepted as
 * well so a format revision does not silently turn every entry into an
 * mtime-only one. The file is opened without following a link, must still be
 * the file the walk inspected, and must be no larger than
 * {@link MAX_INDEX_METADATA_BYTES}. The document's content is never logged.
 *
 * @returns What it records — no roots and no version for a JSON document that
 * records neither — or `undefined` when it could not be read: unreadable,
 * replaced since the walk, oversized, or not JSON.
 */
async function readIndexDocument(
  path: string,
  expected: Stats,
): Promise<IndexDocumentMetadata | undefined> {
  if (expected.size > MAX_INDEX_METADATA_BYTES) {
    return undefined;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, OPEN_NO_FOLLOW_FLAGS);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size > MAX_INDEX_METADATA_BYTES
    ) {
      return undefined;
    }
    const text = await handle.readFile({ encoding: 'utf8' });
    return indexDocumentMetadata(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Reads the project roots one cache document records.
 *
 * @returns The roots it records — `[]` for a JSON document that records none —
 * or `undefined` when it could not be read (see {@link readIndexDocument}).
 * The machine-wide sweep reads both the same way, sending the entry down the
 * modification-time branch; a scoped sweep tells them apart only to say why it
 * kept an entry, and keeps it either way.
 */
async function readRecordedProjectRoots(
  path: string,
  expected: Stats,
): Promise<readonly string[] | undefined> {
  return (await readIndexDocument(path, expected))?.roots;
}

/** Whether any recorded root is one of the roots active inside the window. */
function isActiveRoot(roots: readonly string[], active: ReadonlySet<string>): boolean {
  return roots.some((root) => active.has(normalizePosix(root)));
}

/**
 * Removes one file-shaped cache entry the sweep has decided to remove — or,
 * in a dry run, only counts it — through {@link removeFileWithin}, so every
 * rule shares the containment, link and replacement checks.
 */
async function removeIndexFile(
  context: SweepContext,
  state: SweepState,
  file: IndexFileCandidate,
  root: NodeIdentity,
): Promise<void> {
  const { home, dryRun } = context.settings;
  if (!dryRun) {
    const removed = await removeFileWithin(home, file.path, root, identityOf(file.stats));
    if (isErr(removed)) {
      recordIssue(context, state, 'index-cache', relativeToHome(home, file.path), removed.error);
      return;
    }
  }
  state.indexCachesDeleted += 1;
  state.bytesReclaimed += file.stats.size;
}

/**
 * Judges one file-shaped cache entry by age — the rule every entry the
 * supersession rules of {@link sweepIndexFiles} kept is still subject to — and
 * removes it unless it still belongs to a project active inside the window.
 *
 * Two branches, in this order:
 *
 * 1. **Modification time.** An entry written at or after the cutoff is kept: it
 *    was produced by an indexing run inside the window, which means its
 *    project was opened inside the window.
 * 2. **Recorded project root.** An older entry is kept when a `projectRoot` it
 *    records has a session updated inside the window — a cache hit does not
 *    rewrite the entry, so an actively used project's cache can be old on disk.
 *
 * Otherwise the entry is eligible. The fallback is safe because a cache is a
 * derived artifact: removing one that was still wanted costs one re-index on
 * the project's next session, never data. A scoped sweep has no such
 * fallback: it removes only an entry that records at least one root and whose
 * recorded roots the scope all admits ({@link cacheEntryInScope}), so an entry
 * that records none — an unreadable or rootless document, or any file that is
 * not a `*.json` document — is kept.
 */
async function sweepIndexFile(
  context: SweepContext,
  state: SweepState,
  active: ReadonlySet<string>,
  file: IndexFileCandidate,
  root: NodeIdentity,
): Promise<void> {
  if (file.stats.mtimeMs >= context.settings.cutoff) {
    return;
  }
  // An unreadable document records no root: the machine-wide sweep judges it
  // by age, and `cacheEntryInScope` keeps it from a scoped one.
  const roots = file.document?.roots ?? [];
  if (isActiveRoot(roots, active) || !(await cacheEntryInScope(context, roots))) {
    return;
  }
  await removeIndexFile(context, state, file, root);
}

/**
 * One file-shaped cache entry as the walk saw it, with what its document
 * records — `undefined` for a file that is not a `*.json` document or could
 * not be read.
 */
interface IndexFileCandidate {
  readonly path: string;
  readonly stats: Stats;
  readonly document: IndexDocumentMetadata | undefined;
}

/**
 * Why a file-shaped entry was removed ahead of the age rule. Logged at
 * `debug` with the entry's path relative to `$DEBUGGEN_HOME`, never with a
 * project root.
 *
 * - `older-envelope` — written under an envelope version older than the one
 *   `@debuggen/code-analysis` reads and writes now. The cache names entries
 *   differently across such versions (version 2 named one file per file state,
 *   version 3 names one per project), so no lookup ever reaches this file
 *   again, and nothing but this sweep would remove it.
 * - `superseded` — a current-version entry every project root of which a newer
 *   current-version entry also records: an index of the same project written
 *   under an identity the cache no longer asks for (an earlier indexer
 *   version, say). The newest entry of each project is the one kept.
 */
type IndexSupersession = 'older-envelope' | 'superseded';

/** Whether `candidate` was written after `held`, with the name breaking a tie so the order is total. */
function isNewerEntry(candidate: IndexFileCandidate, held: IndexFileCandidate): boolean {
  if (candidate.stats.mtimeMs !== held.stats.mtimeMs) {
    return candidate.stats.mtimeMs > held.stats.mtimeMs;
  }
  return candidate.path > held.path;
}

/**
 * The supersession rules over every file-shaped entry at once: which entry,
 * if any, each file was superseded by, decided before any file is removed.
 *
 * Only documents with the envelope shape `@debuggen/code-analysis` writes are
 * judged ({@link IndexDocumentMetadata.envelopeVersion}); anything else is left
 * to the age rule alone. Among current-version envelopes, the newest entry
 * recording each normalised project root is kept, and an entry is superseded
 * only when *every* root it records is kept by a newer entry — so no project
 * loses the last cache it has.
 *
 * @returns The supersession reason per candidate, positionally.
 */
function judgeSupersession(
  files: readonly IndexFileCandidate[],
): readonly (IndexSupersession | undefined)[] {
  const newestByRoot = new Map<string, IndexFileCandidate>();
  for (const file of files) {
    if (file.document?.envelopeVersion !== INDEX_CACHE_SCHEMA_VERSION) {
      continue;
    }
    for (const recorded of file.document.roots) {
      const projectRoot = normalizePosix(recorded);
      const held = newestByRoot.get(projectRoot);
      if (held === undefined || isNewerEntry(file, held)) {
        newestByRoot.set(projectRoot, file);
      }
    }
  }

  return files.map((file): IndexSupersession | undefined => {
    const version = file.document?.envelopeVersion;
    if (version === undefined) {
      return undefined;
    }
    if (version < INDEX_CACHE_SCHEMA_VERSION) {
      return 'older-envelope';
    }
    if (version !== INDEX_CACHE_SCHEMA_VERSION || file.document === undefined) {
      return undefined;
    }
    const { roots } = file.document;
    const supersededEverywhere =
      roots.length > 0 &&
      roots.every((recorded) => {
        const newest = newestByRoot.get(normalizePosix(recorded));
        return newest !== undefined && newest !== file;
      });
    return supersededEverywhere ? 'superseded' : undefined;
  });
}

/**
 * Judges every file-shaped cache entry: first by supersession, then by age.
 *
 * Each `*.json` document is read once, whatever its age, because an entry the
 * cache can no longer reach is recent as often as not — version 2 of the cache
 * wrote a new file for every state of a project, so a project that was worked
 * on today can own dozens. Two rules run ahead of the age rule
 * ({@link judgeSupersession}):
 *
 * 1. an entry of an **older envelope version** is removed — no lookup names it
 *    any more;
 * 2. of the **current-version** entries recording one project, all but the
 *    newest are removed.
 *
 * Both remove an entry even when its project is active inside the window,
 * because the project's newest entry is what an active session reads, and in
 * a scoped sweep both still require {@link cacheEntryInScope}. Every other
 * entry — including the kept newest one — then faces {@link sweepIndexFile}'s
 * age rule exactly as before. Removal goes through {@link removeIndexFile}, so
 * containment, link refusal and the replaced-file check hold for every rule,
 * and a dry run counts exactly what a real sweep removes.
 */
async function sweepIndexFiles(
  context: SweepContext,
  state: SweepState,
  active: ReadonlySet<string>,
  found: readonly { readonly path: string; readonly stats: Stats }[],
  root: NodeIdentity,
): Promise<void> {
  const files: IndexFileCandidate[] = [];
  for (const { path, stats } of found) {
    const document = path.endsWith(INDEX_ENTRY_EXTENSION)
      ? await readIndexDocument(path, stats)
      : undefined;
    files.push({ path, stats, document });
  }

  const supersession = judgeSupersession(files);
  for (const [position, file] of files.entries()) {
    const reason = supersession[position];
    if (reason === undefined) {
      await sweepIndexFile(context, state, active, file, root);
      continue;
    }
    if (!(await cacheEntryInScope(context, file.document?.roots ?? []))) {
      continue;
    }
    context.logger.debug('an index-cache entry was superseded', {
      target: relativeToHome(context.settings.home, file.path),
      reason,
    });
    await removeIndexFile(context, state, file, root);
  }
}

/** One `*.json` document directly inside a directory-shaped cache entry, as the walk saw it. */
interface IndexDocument {
  readonly path: string;
  readonly stats: Stats;
}

/**
 * Why a scoped sweep keeps a directory-shaped cache entry it could not
 * attribute whole. Logged at `debug`, never reported: in a scoped sweep an
 * entry whose project is not established is nobody's to report.
 */
type UnattributedReason =
  'too-many-documents' | 'nested-directory' | 'unreadable-document' | 'rootless-document';

/** What {@link attributeScopedDirectory} established about one directory-shaped entry. */
type DirectoryAttribution =
  | { readonly kind: 'attributed'; readonly roots: readonly string[] }
  | { readonly kind: 'active' }
  | { readonly kind: 'unattributed'; readonly reason: UnattributedReason };

/**
 * Attributes a directory-shaped cache entry, for a **scoped** sweep, by
 * inspecting all of it: every document it holds is read, none is skipped.
 *
 * The entry is attributed only when every one of these holds, checked in this
 * order and stopping at the first that fails:
 *
 * 1. it holds at most {@link MAX_INDEX_METADATA_FILES} `*.json` documents — a
 *    larger one is not read at all (`too-many-documents`);
 * 2. it holds no subdirectory, whose content this one-level walk never reads
 *    and the tree removal would take with it (`nested-directory`);
 * 3. every document was read (`unreadable-document`) and records at least one
 *    project root (`rootless-document`).
 *
 * A document recording a project active inside the window answers `active`,
 * exactly as the machine-wide rule keeps it. Otherwise the answer carries
 * every root every document recorded, for {@link cacheEntryInScope} to judge:
 * one root outside the scope keeps the whole entry.
 */
async function attributeScopedDirectory(
  documents: readonly IndexDocument[],
  nestedDirectories: number,
  active: ReadonlySet<string>,
): Promise<DirectoryAttribution> {
  if (documents.length > MAX_INDEX_METADATA_FILES) {
    return { kind: 'unattributed', reason: 'too-many-documents' };
  }
  if (nestedDirectories > 0) {
    return { kind: 'unattributed', reason: 'nested-directory' };
  }
  const recorded: string[] = [];
  for (const document of documents) {
    const roots = await readRecordedProjectRoots(document.path, document.stats);
    if (roots === undefined) {
      return { kind: 'unattributed', reason: 'unreadable-document' };
    }
    if (roots.length === 0) {
      return { kind: 'unattributed', reason: 'rootless-document' };
    }
    if (isActiveRoot(roots, active)) {
      return { kind: 'active' };
    }
    recorded.push(...roots);
  }
  return { kind: 'attributed', roots: recorded };
}

/**
 * Judges one directory-shaped cache entry.
 *
 * Its age is the newest modification time among the directory and its direct
 * children, and it is removed as a whole tree. It is never descended into
 * beyond that one level, and an entry whose children cannot be inspected is
 * kept. Who owns it depends on the sweep:
 *
 * - **Machine-wide** (start-up): its project roots come from up to
 *   {@link MAX_INDEX_METADATA_FILES} `*.json` files directly inside it, and it
 *   is kept only when one of them records a project active inside the window.
 * - **Scoped** (`session.purge`): it is inspected whole by
 *   {@link attributeScopedDirectory} — every document read, each recording a
 *   root, no subdirectory — and removed only when every root recorded is
 *   admitted by the scope. Anything less keeps it, with the reason logged at
 *   `debug`: a document the sweep did not read may belong to another
 *   workspace, and removing the tree would remove that workspace's state.
 */
async function sweepIndexDirectory(
  context: SweepContext,
  state: SweepState,
  active: ReadonlySet<string>,
  path: string,
  stats: Stats,
  root: NodeIdentity,
): Promise<void> {
  const { home, cutoff, dryRun, scope } = context.settings;
  const target = relativeToHome(home, path);

  let names: string[];
  try {
    names = await listNames(path);
  } catch (cause) {
    recordIssue(context, state, 'index-cache', target, fsFailure('read', target, cause));
    return;
  }

  let newest = stats.mtimeMs;
  let nestedDirectories = 0;
  const documents: IndexDocument[] = [];
  for (const name of names) {
    const child = joinPosix(path, name);
    let childStats: Stats | undefined;
    try {
      childStats = await lstatIfPresent(child);
    } catch (cause) {
      const entry = relativeToHome(home, child);
      recordIssue(context, state, 'index-cache', entry, fsFailure('inspect', entry, cause));
      return;
    }
    if (childStats === undefined) {
      continue;
    }
    newest = Math.max(newest, childStats.mtimeMs);
    if (childStats.isDirectory()) {
      nestedDirectories += 1;
    } else if (
      childStats.isFile() &&
      !childStats.isSymbolicLink() &&
      name.endsWith(INDEX_ENTRY_EXTENSION)
    ) {
      documents.push({ path: child, stats: childStats });
    }
  }

  if (newest >= cutoff) {
    return;
  }
  if (scope === undefined) {
    // The machine-wide rule, unchanged: a sample of the documents decides
    // whether an active project still owns the entry.
    for (const document of documents.slice(0, MAX_INDEX_METADATA_FILES)) {
      const roots = (await readRecordedProjectRoots(document.path, document.stats)) ?? [];
      if (isActiveRoot(roots, active)) {
        return;
      }
    }
  } else {
    const attribution = await attributeScopedDirectory(documents, nestedDirectories, active);
    if (attribution.kind === 'active') {
      return;
    }
    if (attribution.kind === 'unattributed') {
      context.logger.debug(
        'a scoped sweep kept an index-cache directory it could not attribute whole',
        {
          target,
          reason: attribution.reason,
          documents: documents.length,
        },
      );
      return;
    }
    if (!(await cacheEntryInScope(context, attribution.roots))) {
      return;
    }
  }

  const survey = await surveyTree(path);
  if (survey.link !== undefined) {
    recordIssue(context, state, 'index-cache', target, treeHoldsLink(home, path, survey.link));
    return;
  }
  if (!dryRun) {
    const removed = await removeTreeWithin(home, path, root, identityOf(stats));
    if (isErr(removed)) {
      recordIssue(context, state, 'index-cache', target, removed.error);
      return;
    }
    if (!removed.value) {
      return;
    }
  }
  state.indexCachesDeleted += 1;
  state.bytesReclaimed += survey.bytes;
}

/**
 * Rule 2: removes the entries of the code-index cache that nothing will read
 * again — those an older envelope version wrote, those a newer entry of the
 * same project superseded — and those whose project has not been opened
 * inside the window.
 *
 * Only the direct children of `indexCacheDir` are judged, and the walk never
 * leaves that directory: a link is reported and left, a directory is judged
 * by {@link sweepIndexDirectory}, the files are judged together by
 * {@link sweepIndexFiles} once the walk has seen them all, and anything else is
 * ignored.
 */
async function sweepIndexCaches(context: SweepContext, state: SweepState): Promise<void> {
  const { deps, settings } = context;
  const rootTarget = relativeToHome(settings.home, settings.indexCacheDir);
  if (isInterrupted(context, state, 'index-cache')) {
    return;
  }

  const root = await inspectDirectory(settings.home, settings.indexCacheDir);
  if (root.kind === 'absent') {
    return;
  }
  if (root.kind === 'unsafe') {
    recordIssue(context, state, 'index-cache', rootTarget, root.error);
    return;
  }

  if (!storeUsable(context, state, 'sessions.list')) {
    return;
  }
  const active = listActiveProjectRoots(deps.sessions, settings.cutoff);
  if (isErr(active)) {
    // Without the allowlist an active project's cache could not be told apart
    // from an abandoned one; the caches wait for the next sweep.
    recordIssue(context, state, 'database', 'sessions.list', active.error);
    return;
  }

  let names: string[];
  try {
    names = await listNames(settings.indexCacheDir);
  } catch (cause) {
    recordIssue(context, state, 'index-cache', rootTarget, fsFailure('read', rootTarget, cause));
    return;
  }

  // File-shaped entries are judged together once the walk has seen them all,
  // because whether one is superseded depends on the others.
  const files: { readonly path: string; readonly stats: Stats }[] = [];
  for (const name of names) {
    if (isInterrupted(context, state, 'index-cache')) {
      return;
    }
    const path = joinPosix(settings.indexCacheDir, name);
    if (dirnamePosix(path) !== settings.indexCacheDir || !isStrictlyWithin(settings.home, path)) {
      continue;
    }
    const entry = relativeToHome(settings.home, path);

    let stats: Stats | undefined;
    try {
      stats = await lstatIfPresent(path);
    } catch (cause) {
      recordIssue(context, state, 'index-cache', entry, fsFailure('inspect', entry, cause));
      continue;
    }
    if (stats === undefined) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      recordIssue(
        context,
        state,
        'index-cache',
        entry,
        unsafePath(
          entry,
          'symlink',
          `${entry} is a symbolic link; the retention sweep does not follow it and left it in place.`,
        ),
      );
      continue;
    }
    if (stats.isFile()) {
      files.push({ path, stats });
    } else if (stats.isDirectory()) {
      await sweepIndexDirectory(context, state, active.value, path, stats, root.identity);
    }
  }
  await sweepIndexFiles(context, state, active.value, files, root.identity);
}

/* -------------------------------------------------------------------------------------------------
 * Reclaiming database space
 * ---------------------------------------------------------------------------------------------- */

/** What the four space pragmas read at one moment. */
interface DatabaseSpace {
  /** One of {@link AUTO_VACUUM_MODE}'s values, or whatever the store answered. */
  readonly autoVacuum: number;
  /** `PRAGMA page_size`. */
  readonly bytesPerPage: number;
  /** `PRAGMA page_count`: the file's pages, free ones included. */
  readonly totalPages: number;
  /** `PRAGMA freelist_count`. */
  readonly freelistCount: number;
}

/** Why the conversion `VACUUM` of a store without auto-vacuum did not run. */
type ConversionSkip =
  'free-share-below-threshold' | 'free-bytes-below-minimum' | 'live-bytes-above-cap';

/**
 * A reclaim step that failed, as a {@link RetentionIssue}'s error: a fixed
 * sentence naming the operation, the engine's error kept only as the cause.
 */
function reclaimFailed(operation: string, message: string, cause?: unknown): DebuggenError {
  return new DebuggenError('STORE_ERROR', message, {
    hint: 'The purged rows are gone either way; SQLite reuses their pages, and the next sweep returns them to the filesystem.',
    details: { subsystem: SUBSYSTEM, component: COMPONENT, operation },
    cause,
  });
}

/** One integer column of a pragma, or `undefined` when it does not read as one. */
function readPragmaInteger(store: Store, sql: string, column: string): number | undefined {
  return readInteger(store.statement(sql).get()?.[column]);
}

/**
 * Reads one size pragma — `page_count` or `page_size` — recording a `reclaim`
 * issue, and answering `undefined`, when it cannot be read as an integer.
 *
 * @param what What the pragma measures, for the issue's sentence ("size",
 * "page size").
 */
function readSizePragma(
  context: SweepContext,
  state: SweepState,
  sql: typeof PAGE_COUNT_SQL | typeof PAGE_SIZE_SQL,
  what: string,
): number | undefined {
  const column = sql === PAGE_COUNT_SQL ? 'page_count' : 'page_size';
  let value: number | undefined;
  let cause: unknown;
  try {
    value = readPragmaInteger(context.deps.store, sql, column);
  } catch (caught) {
    cause = caught;
  }
  if (value === undefined) {
    recordIssue(
      context,
      state,
      'database',
      'reclaim',
      reclaimFailed('reclaim', `Could not read the ${what} of the session store.`, cause),
    );
  }
  return value;
}

/**
 * Reads the auto-vacuum mode and the page counts, recording a `reclaim` issue
 * — and answering `undefined` — when any of them cannot be read.
 */
function readDatabaseSpace(context: SweepContext, state: SweepState): DatabaseSpace | undefined {
  const { store } = context.deps;
  let space: Partial<Record<keyof DatabaseSpace, number | undefined>>;
  try {
    space = {
      autoVacuum: readPragmaInteger(store, AUTO_VACUUM_SQL, 'auto_vacuum'),
      bytesPerPage: readPragmaInteger(store, PAGE_SIZE_SQL, 'page_size'),
      totalPages: readPragmaInteger(store, PAGE_COUNT_SQL, 'page_count'),
      freelistCount: readPragmaInteger(store, FREELIST_COUNT_SQL, 'freelist_count'),
    };
  } catch (caught) {
    recordIssue(
      context,
      state,
      'database',
      'reclaim',
      reclaimFailed('reclaim', 'Could not read the page counts of the session store.', caught),
    );
    return undefined;
  }
  const { autoVacuum, bytesPerPage, totalPages, freelistCount } = space;
  if (
    autoVacuum === undefined ||
    bytesPerPage === undefined ||
    totalPages === undefined ||
    freelistCount === undefined
  ) {
    recordIssue(
      context,
      state,
      'database',
      'reclaim',
      reclaimFailed('reclaim', 'The session store reported page counts that are not numbers.'),
    );
    return undefined;
  }
  return { autoVacuum, bytesPerPage, totalPages, freelistCount };
}

/**
 * Releases an incremental store's freelist to the filesystem, one
 * {@link INCREMENTAL_VACUUM_STEP_PAGES}-page step at a time.
 *
 * Every step is its own short write transaction, stepped to completion with
 * `.all()`; between steps the sweep yields to the event loop and checks the
 * signal, so a large freelist never becomes one long hold. The loop ends when
 * the freelist is empty, when a step releases nothing — a reader pinning the
 * pages, say; the next sweep tries again — or at the first failure, which is
 * recorded as an `incremental_vacuum` issue.
 */
async function releaseIncrementally(
  context: SweepContext,
  state: SweepState,
  space: DatabaseSpace,
): Promise<void> {
  const { store } = context.deps;
  const freeAtStart = space.freelistCount;
  let free = freeAtStart;
  let steps = 0;

  while (free > 0) {
    if (isInterrupted(context, state, 'reclaim')) {
      break;
    }
    if (!storeUsable(context, state, 'incremental_vacuum')) {
      return;
    }
    let after: number | undefined;
    try {
      store.statement(INCREMENTAL_VACUUM_STEP_SQL).all();
      after = readPragmaInteger(store, FREELIST_COUNT_SQL, 'freelist_count');
    } catch (caught) {
      recordIssue(
        context,
        state,
        'database',
        'incremental_vacuum',
        reclaimFailed(
          'incremental_vacuum',
          'The incremental vacuum of the session store did not complete.',
          caught,
        ),
      );
      return;
    }
    steps += 1;
    if (after === undefined || after >= free) {
      context.logger.debug(
        'the incremental vacuum released no more pages; the rest stay reusable',
        {
          freePages: after ?? free,
          steps,
        },
      );
      free = after ?? free;
      break;
    }
    free = after;
    await context.wal.relieve();
    // The step just held the event loop; let queued work run before the next.
    await yieldToEventLoop();
  }

  if (steps > 0) {
    context.logger.info('released the purged database pages to the filesystem', {
      mode: 'incremental',
      freePagesBefore: freeAtStart,
      freePagesAfter: free,
      steps,
    });
  }
}

/**
 * The first gate of {@link RetentionOptions.reclaim} a store without
 * auto-vacuum fails, or `undefined` when the conversion `VACUUM` may run.
 */
function conversionSkip(space: DatabaseSpace, gates: ReclaimGates): ConversionSkip | undefined {
  const freeShare = space.totalPages > 0 ? space.freelistCount / space.totalPages : 0;
  if (freeShare < gates.minFreeShare) {
    return 'free-share-below-threshold';
  }
  if (space.freelistCount * space.bytesPerPage < gates.minFreeBytes) {
    return 'free-bytes-below-minimum';
  }
  if ((space.totalPages - space.freelistCount) * space.bytesPerPage > gates.maxLiveBytes) {
    return 'live-bytes-above-cap';
  }
  return undefined;
}

/**
 * Sets `auto_vacuum = INCREMENTAL` and runs `VACUUM`: the rewrite that
 * compacts the store and, on a store without auto-vacuum, converts it so every
 * later sweep releases its pages incrementally.
 *
 * Never inside a transaction — SQLite refuses `VACUUM` there, and the refusal
 * is recorded instead of attempted. Every failure is recorded under `target`
 * (`auto_vacuum` for the reclaim's own conversion, `vacuum` for
 * {@link RetentionOptions.vacuum}).
 *
 * @returns Whether the `VACUUM` completed.
 */
function vacuumIncrementally(
  context: SweepContext,
  state: SweepState,
  target: 'auto_vacuum' | 'vacuum',
): boolean {
  const { store } = context.deps;
  if (!storeUsable(context, state, target)) {
    return false;
  }
  if (store.db.isTransaction) {
    recordIssue(
      context,
      state,
      'database',
      target,
      new DebuggenError(
        'STORE_ERROR',
        'VACUUM was skipped because a transaction is open on the session store.',
        {
          hint:
            target === 'vacuum'
              ? 'Run the purge with vacuum outside any transaction.'
              : 'The purged pages stay reusable; the next sweep run outside a transaction converts the store.',
          details: { subsystem: SUBSYSTEM, component: COMPONENT, operation: target },
        },
      ),
    );
    return false;
  }
  try {
    store.db.exec(SET_AUTO_VACUUM_INCREMENTAL_SQL);
    store.db.exec(VACUUM_SQL);
    return true;
  } catch (caught) {
    recordIssue(
      context,
      state,
      'database',
      target,
      new DebuggenError('STORE_ERROR', 'VACUUM of the session store did not complete.', {
        hint: 'The purged rows are gone either way; the space is reused by SQLite and returned on the next successful VACUUM.',
        details: { subsystem: SUBSYSTEM, component: COMPONENT, operation: target },
        cause: caught,
      }),
    );
    return false;
  }
}

/**
 * Returns the pages this sweep's deletions freed, by the store's auto-vacuum
 * mode (see "Returning space to the filesystem" in the module overview).
 *
 * @returns Whether a `VACUUM` ran — the conversion of a store without
 * auto-vacuum — so a requested {@link RetentionOptions.vacuum} need not run a
 * second one.
 */
async function releaseFreedPages(context: SweepContext, state: SweepState): Promise<boolean> {
  if (!storeUsable(context, state, 'reclaim')) {
    return false;
  }
  const space = readDatabaseSpace(context, state);
  if (space === undefined) {
    return false;
  }

  switch (space.autoVacuum) {
    case AUTO_VACUUM_MODE.incremental:
      await releaseIncrementally(context, state, space);
      return false;
    case AUTO_VACUUM_MODE.none: {
      const skip = conversionSkip(space, context.settings.reclaim);
      if (skip !== undefined) {
        context.logger.info(
          'the purged database pages stay reusable; the store file keeps its size',
          {
            reason: skip,
            freePages: space.freelistCount,
            totalPages: space.totalPages,
            bytesPerPage: space.bytesPerPage,
          },
        );
        return false;
      }
      const startedAt = performance.now();
      const vacuumed = vacuumIncrementally(context, state, 'auto_vacuum');
      if (vacuumed) {
        context.logger.info(
          'converted the session store to incremental auto-vacuum and compacted it',
          {
            freePages: space.freelistCount,
            totalPages: space.totalPages,
            bytesPerPage: space.bytesPerPage,
            durationMs: performance.now() - startedAt,
          },
        );
      }
      return vacuumed;
    }
    default:
      // FULL: SQLite already truncated the file at every commit.
      return false;
  }
}

/**
 * Returns what the sweep freed to the filesystem, then folds the write-ahead
 * log back into the database so the file actually shrinks, and measures the
 * shrink.
 *
 * Runs after a real sweep that deleted anything — a session, or the drained
 * batches of one — and after any sweep {@link RetentionOptions.vacuum} asks a
 * `VACUUM` of; a sweep that deleted nothing has nothing to reclaim, so the
 * start-up path with no candidates stays free of writes. Never in a dry run,
 * and never once the signal is aborted (the caller checks before, and the
 * incremental steps between steps). Every failure is a {@link RetentionIssue}
 * with scope `database`.
 *
 * {@link RetentionReport.databaseBytesReclaimed} is `(page_count at the
 * sweep's start − page_count now) × page_size`, floored at zero.
 */
async function reclaimDatabaseSpace(context: SweepContext, state: SweepState): Promise<void> {
  const { store } = context.deps;
  const { dryRun, vacuum } = context.settings;
  if (dryRun) {
    return;
  }
  const deletedRows = state.sessionsDeleted > 0 || state.telemetryEventsDeleted > 0;
  if (!deletedRows && !vacuum) {
    return;
  }

  let vacuumed = false;
  if (deletedRows) {
    vacuumed = await releaseFreedPages(context, state);
  }
  if (vacuum && !vacuumed && !state.interrupted) {
    vacuumIncrementally(context, state, 'vacuum');
  }

  if (!state.interrupted) {
    // Whatever log is left is copied back off the event loop first, so the
    // truncating checkpoint below has only the truncation left to do.
    await context.wal.relieve(true);
    if (!storeUsable(context, state, 'checkpoint')) {
      return;
    }
    try {
      store.checkpoint();
    } catch (caught) {
      recordIssue(
        context,
        state,
        'database',
        'checkpoint',
        DebuggenError.from(caught, 'STORE_ERROR'),
      );
    }
  }

  measureReclaimed(context, state);
}

/**
 * Sets {@link SweepState.databaseBytesReclaimed} from the page count the sweep
 * began with. Nothing is measured without that baseline or with a closed store;
 * a read that fails is recorded as a `reclaim` issue and counts nothing.
 */
function measureReclaimed(context: SweepContext, state: SweepState): void {
  const { store } = context.deps;
  const before = state.databasePagesAtStart;
  if (before === undefined || store.isClosed) {
    return;
  }
  const after = readSizePragma(context, state, PAGE_COUNT_SQL, 'size');
  if (after === undefined) {
    return;
  }
  const bytesPerPage = readSizePragma(context, state, PAGE_SIZE_SQL, 'page size');
  if (bytesPerPage === undefined) {
    return;
  }
  state.databaseBytesReclaimed = Math.max(0, (before - after) * bytesPerPage);
}

/* -------------------------------------------------------------------------------------------------
 * The sweep
 * ---------------------------------------------------------------------------------------------- */

/**
 * Assembles the report from the accumulated state, with every id list sorted.
 * The lists hold at most {@link MAX_REPORTED_ITEMS} entries each; the counters
 * and {@link RetentionReport.omitted} carry the rest.
 */
function toReport(cutoff: number, state: SweepState, durationMs: number): RetentionReport {
  return {
    cutoff,
    sessionsDeleted: state.sessionsDeleted,
    sessionIdsDeleted: [...state.sessionIdsDeleted].sort(compareText),
    telemetryEventsDeleted: state.telemetryEventsDeleted,
    panelsDeleted: state.panelsDeleted,
    analysesDeleted: state.analysesDeleted,
    modificationsDeleted: state.modificationsDeleted,
    backupDirsDeleted: state.backupDirsDeleted,
    orphanBackupsDeleted: state.orphanBackupsDeleted,
    indexCachesDeleted: state.indexCachesDeleted,
    sessionsRetainedForConflicts: [...state.sessionsRetainedForConflicts].sort(compareText),
    sessionsRetainedActive: [...state.sessionsRetainedActive].sort(compareText),
    bytesReclaimed: state.bytesReclaimed + state.databaseBytesReclaimed,
    databaseBytesReclaimed: state.databaseBytesReclaimed,
    durationMs,
    interrupted: state.interrupted,
    errors: state.errors.map((issue) => ({ ...issue })),
    omitted: { ...state.omitted },
  };
}

/**
 * Runs one retention sweep over the session database and `$DEBUGGEN_HOME`.
 *
 * In order: aged sessions and their backup directories (Rule 1), orphan
 * backups (Rule 3), code-index caches (Rule 2), then — when anything was
 * deleted — the reclaim that returns the freed database pages to the
 * filesystem, `VACUUM` when {@link RetentionOptions.vacuum} asks for it, and a
 * WAL checkpoint so the file shrinks. See the module overview for each rule,
 * for the reclaim, and for the containment discipline every deletion follows.
 *
 * The age basis of Rule 1 is **`sessions.updated_at`**, the session's last
 * activity — not `created_at` — so a long-running session is never purged
 * mid-flight; `cutoff = now() - retentionDays × 86 400 000`, and a session last
 * updated strictly before it is a candidate.
 *
 * A session that is still active — in an in-flight status, holding an open
 * capture window, or reported in use by {@link RetentionDeps.isSessionInUse}
 * — is retained however old its last update, and so is one whose journal
 * holds a conflict or still describes a patched file.
 *
 * With {@link RetentionOptions.scope} the sweep acts only on the state of the
 * projects the scope admits (see "Scoped sweeps" in the module overview);
 * without it — the start-up pass — it is machine-wide.
 *
 * Asynchronous because of the filesystem work and the yields; the database
 * work is synchronous, in `BEGIN IMMEDIATE` transactions that each re-run a
 * candidate's checks before deleting anything: one per session of at most
 * {@link DEFAULT_PURGE_BATCH_SIZE} telemetry events, deciding and deleting it
 * atomically — the cascade removes its telemetry, panels, analyses and journal
 * in the same statement, or nothing of it at all — and one per batch for a
 * larger session, whose final transaction runs that same cascade (see "Atomic
 * per session, bounded per transaction" in the module overview). Work is
 * bounded: candidates come in indexed keyset pages, no transaction deletes
 * more than one batch of telemetry, journal probes read one session's records
 * through an index and are batched, and the report's lists are capped.
 *
 * With {@link RetentionOptions.signal} aborted the sweep stops at its next
 * step boundary and still answers `Ok`, with
 * {@link RetentionReport.interrupted} set.
 *
 * @param deps The store, the four repositories, the resolved paths and window,
 * and optionally a logger and a clock.
 * @param options Window overrides, `dryRun`, `vacuum`, `reclaim`,
 * `walCheckpointBytes`, `scope` and `signal`.
 * @returns `Ok` with the report — per-item problems are in
 * {@link RetentionReport.errors} — or `Err` only when the sweep cannot run at
 * all: `CONFIG_INVALID` for a configuration, option or clock it cannot use,
 * `STORE_ERROR` for a closed store, `INTERNAL` for a defect that escaped every
 * per-item guard. An aborted signal is never an `Err`.
 *
 * @example
 * ```ts
 * const swept = await runRetention({ store, sessions, telemetry, modifications, panels, config, logger });
 * if (isErr(swept)) {
 *   logger.error(swept.error.message, { code: swept.error.code });
 * } else if (swept.value.errors.length > 0) {
 *   logger.warn('retention left some items in place', { issues: swept.value.errors.length });
 * }
 * ```
 */
export async function runRetention(
  deps: RetentionDeps,
  options: RetentionOptions = {},
): Promise<Result<RetentionReport, DebuggenError>> {
  const startedAt = performance.now();
  const logger = (deps.logger ?? noopLogger).child({ subsystem: SUBSYSTEM, repo: COMPONENT });

  const settings = resolveSettings(deps, options, logger);
  if (isErr(settings)) {
    return settings;
  }

  if (deps.store.isClosed) {
    return err(
      new DebuggenError(
        'STORE_ERROR',
        'The session store is closed, so the retention sweep cannot run.',
        {
          hint: 'Run the purge while the Debug Generator service is running.',
          details: { subsystem: SUBSYSTEM, component: COMPONENT, operation: 'retention' },
        },
      ),
    );
  }

  const wal = createSweepWal(deps.store, settings.value, logger);
  const context: SweepContext = { deps, settings: settings.value, logger, wal };
  const state: SweepState = {
    sessionIdsDeleted: [],
    sessionsRetainedForConflicts: [],
    sessionsRetainedActive: [],
    errors: [],
    omitted: {
      sessionIdsDeleted: 0,
      sessionsRetainedForConflicts: 0,
      sessionsRetainedActive: 0,
      errors: 0,
    },
    removedDirectories: new Set<string>(),
    sessionsDeleted: 0,
    telemetryEventsDeleted: 0,
    panelsDeleted: 0,
    analysesDeleted: 0,
    modificationsDeleted: 0,
    backupDirsDeleted: 0,
    orphanBackupsDeleted: 0,
    indexCachesDeleted: 0,
    bytesReclaimed: 0,
    interrupted: false,
    databasePagesAtStart: undefined,
    databaseBytesReclaimed: 0,
  };

  try {
    if (!settings.value.dryRun) {
      // The baseline of `databaseBytesReclaimed`: read before anything is deleted.
      state.databasePagesAtStart = readSizePragma(context, state, PAGE_COUNT_SQL, 'size');
    }
    // The two phases that write to the store run with the log kept bounded off
    // the event loop; the two filesystem walks between them do not write it.
    await wal.during(() => purgeAgedSessions(context, state));
    await sweepOrphanBackups(context, state);
    await sweepIndexCaches(context, state);
    // An interrupted sweep leaves the reclaim to the store's close and to the
    // next sweep: it must not start a rewrite on the way to a shutdown.
    if (!isInterrupted(context, state, 'reclaim')) {
      await wal.during(() => reclaimDatabaseSpace(context, state));
    }
  } catch (caught) {
    // Every per-item operation above is guarded; reaching this is a defect.
    const error = DebuggenError.from(caught, 'INTERNAL');
    logger.error('retention sweep failed unexpectedly', { code: error.code });
    return err(error);
  } finally {
    await wal.close();
  }

  const report = toReport(settings.value.cutoff, state, performance.now() - startedAt);
  logger.info('retention sweep finished', {
    dryRun: settings.value.dryRun,
    scoped: settings.value.scope !== undefined,
    retentionDays: settings.value.retentionDays,
    orphanBackupGraceDays: settings.value.graceDays,
    cutoff: report.cutoff,
    sessionsDeleted: report.sessionsDeleted,
    telemetryEventsDeleted: report.telemetryEventsDeleted,
    panelsDeleted: report.panelsDeleted,
    analysesDeleted: report.analysesDeleted,
    modificationsDeleted: report.modificationsDeleted,
    backupDirsDeleted: report.backupDirsDeleted,
    orphanBackupsDeleted: report.orphanBackupsDeleted,
    indexCachesDeleted: report.indexCachesDeleted,
    sessionsRetainedForConflicts:
      report.sessionsRetainedForConflicts.length + report.omitted.sessionsRetainedForConflicts,
    sessionsRetainedActive:
      report.sessionsRetainedActive.length + report.omitted.sessionsRetainedActive,
    bytesReclaimed: report.bytesReclaimed,
    databaseBytesReclaimed: report.databaseBytesReclaimed,
    interrupted: state.interrupted,
    issues: report.errors.length + report.omitted.errors,
    walCheckpoints: wal.checkpoints,
    longestWalCheckpointMs: Math.round(wal.longestCheckpointMs),
    durationMs: report.durationMs,
  });
  return ok(report);
}
