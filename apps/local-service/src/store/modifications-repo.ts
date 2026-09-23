/**
 * The modification journal: the durable record that makes instrumentation
 * reversible, over `node:sqlite`.
 *
 * This is the most safety-critical module in `src/store/`. Every other table
 * here holds a debugging session's *findings* — telemetry, panels, analyses —
 * and losing a row costs a developer an answer. The `modifications` table holds
 * the only description of what this product did to files in the developer's
 * working tree: which file, what its bytes hashed to before, what they hash to
 * after, where the original was copied, and what state the change is in. A row
 * lost or written out of order here costs a developer their source code.
 * Correctness therefore beats convenience at every decision below.
 *
 * ## The one ordering guarantee this module exists to provide
 *
 * AAP §0.5.1 fixes the crash-safe write sequence, and {@link ModificationsRepo.append}
 * is step 4 of it:
 *
 * ```text
 * 1. read the original bytes          → originalHash
 * 2. build the patched content        → instrumentedHash   (nothing written yet)
 * 3. copy the original to the backup  → backupPath, fsync'd
 * 4. APPEND THIS RECORD as "pending"  → both hashes + the unified diff   ← here
 * 5. temp-write + fsync + rename over the original           (the only write)
 * 6. mark the record "applied"
 * ```
 *
 * Step 4 must be **durable before step 5 begins**, because the journal already
 * knowing the expected post-write hash is what makes a crash at any later point
 * decidable: a file that still hashes to `originalHash` was never written, one
 * that hashes to `instrumentedHash` carries our patch and may be restored, and
 * one that hashes to neither was edited by the developer and is never
 * overwritten. `node:sqlite` is a synchronous binding and {@link Store.transaction}
 * commits before it returns, so every method here does its work synchronously
 * and hands back an already-settled promise: when `append` resolves, the row is
 * committed. The asynchronous signature comes from the
 * {@link ModificationJournal} port, which exists so that a future out-of-process
 * store would not force every caller to change.
 *
 * The one qualification on that guarantee: {@link Store.transaction} nests a
 * savepoint inside a transaction a caller has already opened, so a caller that
 * wraps an append in a transaction of its own has moved durability to *its*
 * commit. That is correct for the retention sweep, which wants one atomic
 * purge, and it is why the patcher appends outside any transaction of its own —
 * the step it is about to take is a write to the developer's file, which no
 * rollback can undo.
 *
 * ## What this module is, in terms of the port
 *
 * {@link ModificationJournal} is declared once, in
 * `@debuggen/instrumentation`'s `schema/modification.ts`, because that package
 * writes the journal and never opens a database. It has two implementations:
 * the in-memory fakes of that package's installer, cleanup and patcher suites,
 * and this repository. {@link ModificationsRepo} extends the port with the
 * queries only the service needs — start-up reconciliation, chain walking,
 * conflict reporting, retention — so the port stays the narrow contract the
 * patcher and cleanup share while the service keeps one place that knows SQL.
 *
 * Every shape crossing that seam is imported, never restated:
 * {@link ModificationRecord}, {@link ModificationStatus},
 * {@link ModificationStatusPatch}, `MODIFICATION_STATUSES`,
 * `OPEN_MODIFICATION_STATUSES` and `parseModificationRecord` all come from
 * `@debuggen/instrumentation`. A second declaration of any of them in this
 * workspace would be the defect AAP §0.4.2 names.
 *
 * ## The two invariants enforced on the way in
 *
 * 1. **A record must be restorable.** `parseModificationRecord` already
 *    guarantees two 64-character lowercase hex digests, a project-relative
 *    POSIX path and a known status. On top of that, `append` refuses a blank
 *    `backupPath` (nothing to restore from), a blank `diff` (nothing to show
 *    the developer, and the patcher refuses to journal a transform that changed
 *    nothing) and `originalHash === instrumentedHash` — a no-op patch, which
 *    would make the reconciliation table of AAP §0.5.1 undecidable, because
 *    "the file holds the original" and "the file holds our patch" would be the
 *    same observation.
 * 2. **A chain must line up hash by hash.** A follow-up plan version that
 *    patches an already-patched file appends a record whose `originalHash` is
 *    the earlier record's `instrumentedHash`, linked through
 *    `previousRecordId` (AAP §0.4.2). `append` loads that parent *inside the
 *    same transaction* and refuses the record unless the parent exists, belongs
 *    to the same session, names the same file and carries exactly that hash.
 *    Refusing here is what makes a partially-failed follow-up install
 *    recoverable: cleanup unwinds a chain in strict reverse order, verifying at
 *    each step that the file hashes to that record's `instrumentedHash` before
 *    writing that record's backup, and a chain that does not line up cannot be
 *    unwound at all.
 *
 * ## Status transitions are refused, never papered over
 *
 * {@link MODIFICATION_STATUS_TRANSITIONS} is the whole lifecycle, and
 * {@link ModificationsRepo.updateStatus} enforces it. An illegal transition is
 * returned as an error rather than applied, because a caller asking for one has
 * lost track of a file's real state — and that is precisely the situation in
 * which a write would overwrite a developer's edit. The `UPDATE` additionally
 * carries the status it observed as an optimistic guard (`WHERE id = ? AND
 * status = ?`), so a record another writer moved in between fails with an
 * instruction to re-read instead of silently taking the transition from a state
 * that no longer holds.
 *
 * ## Privacy
 *
 * A record's `diff` is a slice of the developer's source and its `backupPath`
 * contains their home directory (AAP §0.5.2). Nothing in this module ever logs
 * or attaches to an error: a diff, a file's content, a backup path, or a digest
 * — a digest together with a path is a hash-to-content mapping, so the two
 * hashes never leave this module either. What is logged and what reaches
 * `details` is the record id, the session id, the project-relative file path,
 * the plan version, the status and counts. Values reach SQLite through bound
 * parameters only, which is simultaneously the injection defence and the reason
 * no value can appear in a statement's text, in the statement cache's keys or
 * in a prepare failure.
 *
 * ## Error codes, and why each one
 *
 * - `INSTRUMENTATION_INSTALL_FAILED` — a record or a patch was refused for
 *   what it contains. It names the operation that is blocked: the caller is
 *   mid-sequence and must now not patch. `createModificationRecord` reports a
 *   schema failure the same way.
 * - `MODIFICATION_CONFLICT` — a chained record's `originalHash` is not the
 *   parent's `instrumentedHash`. The recorded hash no longer matches, which is
 *   exactly what that code means.
 * - `SESSION_INVALID_STATE` — a status transition the matrix forbids: the
 *   operation is real but not legal from the record's current status.
 * - `STORE_ERROR` — persistence itself refused or surprised us: an unknown id,
 *   a duplicate id, a session that does not exist, a row that no longer parses,
 *   a lost optimistic guard, a closed handle.
 *
 * @packageDocumentation
 */

import {
  MODIFICATION_STATUSES,
  OPEN_MODIFICATION_STATUSES,
  isModificationStatus,
  parseModificationRecord,
} from '@debuggen/instrumentation';
import type {
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
  ModificationStatusPatch,
} from '@debuggen/instrumentation';
import { DebuggenError, err, isErr, noopLogger, nowEpochMs, ok } from '@debuggen/shared';
import type { Logger, ModificationId, Result, SessionId } from '@debuggen/shared';

import { LOG_BINDING_KEYS } from '../logging.js';
import type { Store } from './db.js';

/* -------------------------------------------------------------------------------------------------
 * Bindings and small vocabularies
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `subsystem` binding every record from this repository carries, matching
 * `./db.ts` and `./migrations.ts` so store lines can be filtered out of a
 * session's log without matching on message text.
 */
const SUBSYSTEM = 'store';

/**
 * The `repo` binding, which distinguishes this repository's records from the
 * other repositories sharing the `store` subsystem.
 */
const REPO = 'modifications';

/** The field name the `repo` binding is emitted under. */
const REPO_BINDING_KEY = 'repo';

/**
 * The status a conflicting record carries, named once rather than spelled at
 * each use.
 *
 * Typed as {@link ModificationStatus}, so it is checked against the upstream
 * vocabulary at compile time: a rename there fails this line rather than
 * quietly producing a query that matches nothing.
 */
const CONFLICT_STATUS: ModificationStatus = 'conflict';

/* -------------------------------------------------------------------------------------------------
 * The transition matrix
 * ---------------------------------------------------------------------------------------------- */

/**
 * Which status a record may move to from each status it can be in.
 *
 * Declared as a `Record` over {@link ModificationStatus} rather than as a
 * hand-written object literal, so the compiler requires an entry for every
 * member of `MODIFICATION_STATUSES`: adding a status upstream fails this
 * declaration instead of silently leaving a state with no rules, which would
 * read as "no transition is legal" and block cleanup on that record forever.
 *
 * The edges, and why each exists (AAP §0.5.1):
 *
 * ```text
 * pending  → applied            the rename landed
 *          → reverted           reconciliation found the file still holding the
 *                               original: nothing was written, so the record is
 *                               closed without a write
 *          → conflict           the file matches neither hash
 *          → failed             the sequence aborted part-way
 * applied  → reverted           the backup was restored and verified
 *          → conflict           the developer edited the file meanwhile
 *          → failed             a later step of the same install failed
 * conflict → reverted           the developer resolved it and the restore
 *                               verified
 *          → failed             resolution itself failed
 * failed   → reverted           reconciliation restored it
 *          → conflict           reconciliation found a divergent file
 * reverted → (terminal)         the backup was verified and deleted; there is
 *                               nothing left to act on
 * ```
 *
 * A write of the status a record already carries is **not** a transition and is
 * not listed here: cleanup and the patcher retry idempotently, so
 * {@link ModificationsRepo.updateStatus} accepts that as a success. See
 * {@link canTransitionModificationStatus}, which is the predicate both this
 * module and any consumer should use rather than reading the table by hand.
 */
export const MODIFICATION_STATUS_TRANSITIONS: Readonly<
  Record<ModificationStatus, readonly ModificationStatus[]>
> = Object.freeze({
  pending: Object.freeze(['applied', 'reverted', 'conflict', 'failed'] as const),
  applied: Object.freeze(['reverted', 'conflict', 'failed'] as const),
  conflict: Object.freeze(['reverted', 'failed'] as const),
  failed: Object.freeze(['reverted', 'conflict'] as const),
  reverted: Object.freeze([] as const),
});

/**
 * Whether a record in `from` may be written as `to`.
 *
 * Same-status writes are legal by design — cleanup re-marks a record it already
 * marked when a pass is retried, and refusing that would turn an idempotent
 * retry into a reported failure — so this returns `true` when `from === to`
 * even for the terminal `reverted` state, where the write is a no-op.
 *
 * @param from The status the record currently carries.
 * @param to The status a caller wants to write.
 * @returns `true` when the write is legal, `false` when
 * {@link MODIFICATION_STATUS_TRANSITIONS} has no such edge.
 */
export function canTransitionModificationStatus(
  from: ModificationStatus,
  to: ModificationStatus,
): boolean {
  if (from === to) {
    return true;
  }

  return MODIFICATION_STATUS_TRANSITIONS[from].includes(to);
}

/* -------------------------------------------------------------------------------------------------
 * SQL
 * ---------------------------------------------------------------------------------------------- */

/**
 * The columns that make up a {@link ModificationRecord}, in the order the DDL
 * declares them.
 *
 * `updated_at` is deliberately absent: it is store-only bookkeeping — when a
 * record's status last moved — and the record schema is a `strictObject` with
 * eleven keys that would reject it. Selecting it would therefore make every
 * read fail validation.
 */
const RECORD_COLUMNS: readonly string[] = Object.freeze([
  'id',
  'session_id',
  'plan_version',
  'file',
  'original_hash',
  'backup_path',
  'instrumented_hash',
  'applied_at',
  'status',
  'diff',
  'previous_record_id',
]);

/** The select list every read below shares. */
const SELECTED = RECORD_COLUMNS.join(', ');

// Why every ordered read below breaks a timestamp tie on `rowid` rather than on
// `id`: the port's guarantee is APPEND ORDER, because cleanup reverses
// `listBySession` to unwind a chain last-applied-first, so this order is not a
// display preference. `applied_at` holds whole milliseconds and an installer
// applying several patches inside one millisecond is ordinary rather than
// exotic, so the tie-breaker decides the real order more often than the
// timestamp does. `id` cannot serve as one: a modification id is `mod_` plus
// sixteen random characters, so ordering by it would randomise exactly those
// same-millisecond appends. SQLite's implicit `rowid` is assigned in insertion
// order — this table is deliberately not `WITHOUT ROWID` — which makes it both
// deterministic and correct. It is never selected, only ordered by.

/**
 * `?` placeholders, joined.
 *
 * Only ever called with a **count**, never with a value: the text a statement
 * is prepared from is assembled from column names and placeholder counts
 * exclusively, so no parameter can reach SQLite other than through a binding.
 *
 * @param count How many placeholders to emit.
 * @returns The joined placeholder list, `''` for a count of zero.
 */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * How many slots every `status IN (…)` list below carries: the full width of
 * the status vocabulary.
 *
 * A status filter is always bound at this fixed width, with a short filter
 * repeating one of its own values to fill the remaining slots — repeating a
 * value inside an `IN` list cannot change which rows match. That keeps every
 * statement text a module constant and the prepared-statement cache at one
 * entry per query shape, instead of one per filter length.
 */
const STATUS_SLOTS = MODIFICATION_STATUSES.length;

/** The fixed-width placeholder list for a status filter. */
const STATUS_IN_LIST = placeholders(STATUS_SLOTS);

/** Appends the record, with both hashes, the backup path and the diff. */
const INSERT_SQL = `INSERT INTO modifications (${RECORD_COLUMNS.join(', ')}, updated_at)
VALUES (${placeholders(RECORD_COLUMNS.length + 1)})`;

/** Reads one record by id. */
const SELECT_BY_ID_SQL = `SELECT ${SELECTED} FROM modifications WHERE id = ?`;

/** Reads one session's records in append order. */
const SELECT_BY_SESSION_SQL = `SELECT ${SELECTED} FROM modifications
WHERE session_id = ?
ORDER BY applied_at ASC, rowid ASC`;

/** Reads one session's records in a set of statuses, in append order. */
const SELECT_BY_SESSION_AND_STATUS_SQL = `SELECT ${SELECTED} FROM modifications
WHERE session_id = ? AND status IN (${STATUS_IN_LIST})
ORDER BY applied_at ASC, rowid ASC`;

/**
 * Reads every record in a set of statuses, across all sessions.
 *
 * The start-up reconciliation query, and deliberately free of any join against
 * `sessions`: AAP §0.5.1 requires an open record to be acted on *regardless of
 * the owning session's status*, so a session left `capturing`, `generated`,
 * `failed` or mid-cleanup still has its files restored. Served by
 * `idx_modifications_status`, and ordered by session and then application time
 * so a chain is encountered in the order it was applied.
 */
const SELECT_BY_STATUS_SQL = `SELECT ${SELECTED} FROM modifications
WHERE status IN (${STATUS_IN_LIST})
ORDER BY session_id ASC, applied_at ASC, rowid ASC`;

/** Reads every record for one file of one session, oldest first. */
const SELECT_BY_SESSION_AND_FILE_SQL = `SELECT ${SELECTED} FROM modifications
WHERE session_id = ? AND file = ?
ORDER BY applied_at ASC, rowid ASC`;

/**
 * Reads the head of the chain for one file of one session.
 *
 * The head is the record no later record is layered on top of, which is a
 * stronger statement than "the newest by timestamp": two records of one chain
 * can carry the same `applied_at` reading, and the link is what orders them.
 * The ordering clause only settles the case of several unchained records for
 * one file, where the most recently applied one is the right answer.
 */
const SELECT_CHAIN_HEAD_SQL = `SELECT ${SELECTED} FROM modifications AS head
WHERE head.session_id = ?
  AND head.file = ?
  AND NOT EXISTS (
    SELECT 1 FROM modifications AS later
    WHERE later.session_id = head.session_id
      AND later.file = head.file
      AND later.previous_record_id = head.id
  )
ORDER BY head.applied_at DESC, head.rowid DESC
LIMIT 1`;

/** Counts one session's records. */
const COUNT_BY_SESSION_SQL = 'SELECT COUNT(*) AS total FROM modifications WHERE session_id = ?';

/** Removes one session's records. Retention only, after its conflict checks. */
const DELETE_BY_SESSION_SQL = 'DELETE FROM modifications WHERE session_id = ?';

/** Every referenced backup path, deduplicated. */
const SELECT_BACKUP_PATHS_SQL = `SELECT DISTINCT backup_path FROM modifications
ORDER BY backup_path ASC`;

/** Every referenced backup path of one session, deduplicated. */
const SELECT_BACKUP_PATHS_BY_SESSION_SQL = `SELECT DISTINCT backup_path FROM modifications
WHERE session_id = ?
ORDER BY backup_path ASC`;

/** Every referenced backup path in a set of statuses, deduplicated. */
const SELECT_BACKUP_PATHS_BY_STATUS_SQL = `SELECT DISTINCT backup_path FROM modifications
WHERE status IN (${STATUS_IN_LIST})
ORDER BY backup_path ASC`;

/** Every referenced backup path of one session in a set of statuses. */
const SELECT_BACKUP_PATHS_BY_SESSION_AND_STATUS_SQL = `SELECT DISTINCT backup_path FROM modifications
WHERE session_id = ? AND status IN (${STATUS_IN_LIST})
ORDER BY backup_path ASC`;

/**
 * The column each member of {@link ModificationStatusPatch} is persisted in.
 *
 * Annotated as a `Record` over the patch's key union rather than inferred, so
 * the compiler requires an entry for every member: a field added to the patch
 * upstream fails this declaration instead of being silently dropped on the way
 * to the database. The identifiers here are the only column names that reach a
 * generated `UPDATE`, which is what keeps that generation free of caller input.
 */
const PATCH_COLUMNS: Readonly<Record<keyof ModificationStatusPatch, string>> = Object.freeze({
  instrumentedHash: 'instrumented_hash',
  diff: 'diff',
  appliedAt: 'applied_at',
  backupPath: 'backup_path',
});

/**
 * Builds the `UPDATE` for a status write, naming only the columns the patch
 * named.
 *
 * `columns` comes from {@link PATCH_COLUMNS} and never from a caller, so the
 * assembled text contains column identifiers and placeholders only. The
 * generated set is bounded by the sixteen subsets of the four patchable
 * columns, so the prepared-statement cache stays small.
 *
 * The trailing `AND status = ?` is the optimistic guard: the caller binds the
 * status it observed, so a record another writer moved in between matches no
 * row and reports zero changes rather than taking a transition from a state
 * that no longer holds.
 *
 * @param columns The patched columns, in {@link PATCH_COLUMNS} order.
 * @returns The statement text.
 */
function updateStatusSql(columns: readonly string[]): string {
  const assignments = ['status = ?', ...columns.map((column) => `${column} = ?`), 'updated_at = ?'];

  return `UPDATE modifications SET ${assignments.join(', ')} WHERE id = ? AND status = ?`;
}

/**
 * How many links {@link ModificationsRepo.listChain} follows before it refuses.
 *
 * A chain holds at most one record per plan version that patched one file, so
 * real chains are two or three links long and this bound is unreachable in
 * practice. It exists as a second guard beside the visited set: a journal
 * corrupted into a long list rather than a cycle must not be able to hold the
 * start-up reconciliation pass in a loop, because nothing serves a developer
 * until that pass finishes.
 */
const MAX_CHAIN_LENGTH = 256;

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/** What {@link createModificationsRepo} is constructed from. */
export interface ModificationsRepoDeps {
  /**
   * The open, migrated store handle from `./db.ts`.
   *
   * The repository owns no connection of its own, which is what puts its
   * statements in the shared prepared-statement cache and its writes inside
   * whatever transaction a caller has already opened — the retention sweep
   * deletes a session's records and its telemetry in one transaction, and
   * either both go or neither does.
   */
  readonly store: Store;

  /**
   * Where the repository reports what it journalled. Defaults to the shared
   * no-op logger, so a suite that does not care about output passes nothing.
   *
   * A child bound to `{ subsystem: 'store', repo: 'modifications' }` is derived
   * from it. See this module's privacy note for what is never put on a record.
   */
  readonly logger?: Logger | undefined;

  /**
   * Reads the current epoch-millisecond time for the `updated_at` column.
   * Defaults to `nowEpochMs()`.
   *
   * Injectable so a suite can assert an exact row without fake timers, and so
   * the service can thread one clock reading through a whole install.
   */
  readonly now?: (() => number) | undefined;
}

/** Narrowing for {@link ModificationsRepo.listBySession}. */
export interface ListModificationsOptions {
  /**
   * Keep only the records in these statuses.
   *
   * Absent means every status. An **empty** array means no status was selected
   * and therefore matches nothing, which is answered with an empty list rather
   * than with every record — the opposite reading would turn a caller's
   * narrowed-to-nothing filter into a full scan. Duplicates are ignored; a
   * value outside the status vocabulary is refused rather than dropped.
   */
  readonly statuses?: readonly ModificationStatus[] | undefined;
}

/** Narrowing for {@link ModificationsRepo.listBackupPaths}. */
export interface ListBackupPathsOptions {
  /**
   * Keep only the paths referenced by records in these statuses.
   *
   * Retention uses it in both directions: the union of every status tells it
   * which files under the backups directory are still referenced at all, and
   * `['conflict']` tells it which of those it must never delete, because a
   * conflicting record's backup is the developer's only pristine copy.
   *
   * Absent means every status; an empty array matches nothing, as in
   * {@link ListModificationsOptions.statuses}.
   */
  readonly statuses?: readonly ModificationStatus[] | undefined;

  /** Keep only the paths referenced by one session's records. */
  readonly sessionId?: SessionId | undefined;
}

/**
 * The modification journal, over the session store.
 *
 * Extends {@link ModificationJournal} — the port `@debuggen/instrumentation`
 * declares and the patcher, installer and cleanup hold — with the queries only
 * this service needs. The four port members keep the port's signatures exactly,
 * because that package type-checks its in-memory fakes against the same
 * interface and a widened parameter here would be a compile error there.
 *
 * Every method answers with a {@link Result} and **never throws**: these calls
 * sit inside the crash-safe write sequence, where an exception raised between
 * the backup and the rename is the one thing that must not happen. Every method
 * is synchronous underneath and returns an already-settled promise, so a
 * resolved `append` means a committed row.
 *
 * Nothing is mutated in place. A returned record is parsed out of its row (or,
 * for `append`, is the validated value that was written), so a caller may keep
 * it without ever observing a status that was not journalled.
 */
export interface ModificationsRepo extends ModificationJournal {
  /**
   * Appends a record, which is step 4 of the write sequence: the row is
   * committed when the returned promise settles, and only then may the caller
   * write the project file. Call it outside any transaction of your own — see
   * the qualification in this module's overview.
   *
   * Refuses, without writing anything: a value that fails
   * `parseModificationRecord`; a blank `backupPath` or `diff`; a record whose
   * two hashes are equal (a no-op patch, which would make reconciliation
   * undecidable); a chained record whose parent is missing, belongs to another
   * session, names another file, or does not carry this record's `originalHash`
   * as its own `instrumentedHash`; a duplicate id; and a session id no
   * `sessions` row holds.
   *
   * `appliedAt` is canonicalised to whole milliseconds, which is the resolution
   * of the store's `applied_at` column, and the **stored** record is what comes
   * back — so a caller comparing it with a later read sees the same values.
   *
   * @param record A validated record, normally from `createModificationRecord`.
   * @returns The stored record, or the refusal.
   */
  append(record: ModificationRecord): Promise<Result<ModificationRecord>>;

  /**
   * Moves a record to `status`, revising the fields a transition legitimately
   * changes.
   *
   * Refuses a transition {@link MODIFICATION_STATUS_TRANSITIONS} has no edge
   * for, and refuses a write whose record another writer moved in between (the
   * optimistic guard), telling the caller to re-read. Writing the status a
   * record already carries is a success: cleanup and the patcher retry
   * idempotently.
   *
   * Only the columns `patch` names are written. The whole prospective row is
   * validated before the write, so a patch can never store a record a later
   * read would refuse.
   *
   * @param id The record to update.
   * @param status The status to write.
   * @param patch Optional revisions to `instrumentedHash`, `diff`, `appliedAt`
   * and `backupPath`.
   * @returns The record as the store now holds it, or the refusal.
   */
  updateStatus(
    id: ModificationId,
    status: ModificationStatus,
    patch?: ModificationStatusPatch,
  ): Promise<Result<ModificationRecord>>;

  /**
   * Lists one session's records in append order — `applied_at` ascending, then
   * insertion order for the ties an installer produces within one millisecond,
   * so the order is total, stable across reads and the order the records were
   * actually appended in.
   *
   * Cleanup iterates the result in reverse to unwind chains
   * last-applied-first, and both user interfaces render it as the session's
   * modification list.
   *
   * @param sessionId The session to list.
   * @param options Optional status narrowing.
   * @returns That session's records; an empty array is a success.
   */
  listBySession(
    sessionId: SessionId,
    options?: ListModificationsOptions,
  ): Promise<Result<ModificationRecord[]>>;

  /**
   * Lists the records still requiring reconciliation — every status except
   * `reverted`, per `OPEN_MODIFICATION_STATUSES`.
   *
   * Called **without** an argument this is the port's method and covers
   * **every session**, which is the whole point of it: AAP §0.5.1 requires an
   * open record to be acted on regardless of the owning session's status, so a
   * file left patched by a crashed or abandoned session is restored or reported
   * before any client is served. Called **with** a session id it narrows to
   * that session, for the editor's modification list and for end-of-session
   * cleanup.
   *
   * @param sessionId Optional session to narrow to.
   * @returns The open records, or the failure.
   */
  listOpen(sessionId?: SessionId): Promise<Result<ModificationRecord[]>>;

  /**
   * The start-up reconciliation set: every non-`reverted` record across all
   * sessions, ordered by session and then by application time so a chain is
   * encountered in the order it was applied.
   *
   * The same query as `listOpen()` with no argument, named explicitly because
   * this is the call `src/main.ts` makes before the service accepts a client,
   * and because "all sessions" reads as a mistake at a call site that says
   * `listOpen`. One indexed query over `status`, with no join against
   * `sessions`.
   *
   * @returns Every open record, or the failure.
   */
  listAllOpen(): Promise<Result<ModificationRecord[]>>;

  /**
   * Reads one record by id.
   *
   * @param id The record to read.
   * @returns The record, `undefined` when no such record exists — absence is
   * not a failure here, unlike in {@link ModificationsRepo.updateStatus} — or
   * the failure when the store refused or the row no longer parses.
   */
  get(id: ModificationId): Promise<Result<ModificationRecord | undefined>>;

  /**
   * Lists every record for one file of one session, oldest first.
   *
   * The conflict watcher asks whether a path is instrumented at all, and the
   * follow-up path asks what an earlier plan version already did to it.
   *
   * @param sessionId The session to look in.
   * @param file The project-relative POSIX path, exactly as the record spells
   * it.
   * @returns The file's records in application order.
   */
  listByFile(sessionId: SessionId, file: string): Promise<Result<ModificationRecord[]>>;

  /**
   * Reads the chain head for one file of one session: the record a restore
   * starts from.
   *
   * The head is the record no later record is layered on top of, not merely the
   * newest by timestamp — two records of one chain can share an `applied_at`
   * reading, and the link is what orders them.
   *
   * @param sessionId The session to look in.
   * @param file The project-relative POSIX path.
   * @returns The head record, or `undefined` when the file has none.
   */
  latestRecordForFile(
    sessionId: SessionId,
    file: string,
  ): Promise<Result<ModificationRecord | undefined>>;

  /**
   * Walks `previousRecordId` back from `recordId` to the chain root and returns
   * the chain **oldest → newest**.
   *
   * A restore iterates the returned array **in reverse** — newest first —
   * verifying at each step that the file's current hash equals *that* record's
   * `instrumentedHash` before writing *that* record's backup, and stopping at
   * the first step that does not verify. Any other order would write an older
   * record's backup over a newer record's patch.
   *
   * Refuses a cycle (a visited-set walk bounded by {@link MAX_CHAIN_LENGTH})
   * and refuses a link whose ancestor is absent: the `ON DELETE SET NULL` edge
   * on `previous_record_id` means a purged ancestor clears the link, so a
   * dangling one is a corrupted journal, and a restore that silently ignored a
   * missing ancestor would write the wrong bytes.
   *
   * @param recordId The record to walk back from — normally the chain head.
   * @returns The chain, oldest first, `[record]` for an unchained record, or
   * the failure.
   */
  listChain(recordId: ModificationId): Promise<Result<ModificationRecord[]>>;

  /**
   * Lists the records in `conflict`: the files the developer edited while they
   * were instrumented, which are never overwritten.
   *
   * Read by the cleanup report, by the editor's modification list and by
   * retention, whose exemption rule keeps a conflicting record's backup until
   * the developer resolves it.
   *
   * @param sessionId Optional session to narrow to; omitted covers every
   * session, ordered by session and then application time.
   * @returns The conflicting records.
   */
  listConflicts(sessionId?: SessionId): Promise<Result<ModificationRecord[]>>;

  /**
   * Lists the distinct backup paths the journal still references.
   *
   * This is what lets retention tell a referenced backup from an orphan left by
   * a crash between the backup write and the journal append, and what protects
   * a conflicting record's backup from a sweep.
   *
   * @param options Optional status and session narrowing.
   * @returns The distinct paths, sorted, or the failure.
   */
  listBackupPaths(options?: ListBackupPathsOptions): Promise<Result<string[]>>;

  /**
   * Counts one session's records, without reading them.
   *
   * @param sessionId The session to count.
   * @returns The count.
   */
  countBySession(sessionId: SessionId): Promise<Result<number>>;

  /**
   * Removes one session's records.
   *
   * **Retention only, and only after its conflict checks.** A record is the
   * only description of a patched file, so deleting one while its file is still
   * patched abandons that file permanently: the caller must have established
   * that every record of the session is `reverted`, or that a remaining
   * conflict has been resolved, before calling this.
   *
   * @param sessionId The session to purge.
   * @returns How many rows were removed.
   */
  deleteBySession(sessionId: SessionId): Promise<Result<number>>;
}

/* -------------------------------------------------------------------------------------------------
 * Internal helpers: values, rows, errors
 * ---------------------------------------------------------------------------------------------- */

/**
 * The value types this module binds.
 *
 * A subset of what `node:sqlite` accepts, restricted to what the
 * `modifications` table declares: text, integer, and `NULL` for the one
 * nullable column. Nothing here ever binds a `bigint` or a buffer, so a
 * mistyped value is a compile error rather than a `STRICT`-table failure at
 * run time.
 */
type BoundValue = string | number | null;

/** A row as `node:sqlite` hands it back, before validation. */
type StoredRow = Record<string, unknown>;

/**
 * The numeric error codes `node:sqlite` reports on the `errcode` property of
 * the error it throws, for the three constraint failures this module can
 * legitimately provoke.
 *
 * Measured against Node 24.21.0 rather than assumed: the extended result codes
 * are stable SQLite values, and matching on them keeps the classification off
 * the message text, which is not a contract.
 */
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

/** A `UNIQUE` index refused the row. See {@link SQLITE_CONSTRAINT_PRIMARYKEY}. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** No `sessions` row holds the record's session id. */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

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

/**
 * Canonicalises an epoch-millisecond reading for an `INTEGER` column.
 *
 * The record schema accepts a sub-millisecond reading, because a more precise
 * answer to "when" is not worse data. `STRICT` tables are stricter: a real
 * value with a fractional part is refused outright, so a caller threading a
 * high-resolution clock through an install would fail at the insert. Rounding
 * to the column's own resolution is the honest fix, and it is only safe because
 * the **stored** record is what every method returns: a caller never holds a
 * timestamp the store does not have.
 *
 * A non-finite reading is passed through untouched so that validation reports
 * it as the bad value it is, rather than this function inventing one.
 *
 * @param value The reading to canonicalise.
 * @returns Whole milliseconds, or `value` when it is not finite.
 */
function toEpochColumn(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : value;
}

/**
 * Normalises a column value that should be a number.
 *
 * `node:sqlite` hands back a `bigint` for an integer column only when the
 * statement was configured to, which this module never does; the conversion is
 * here so that a handle configured elsewhere cannot turn every read into a
 * validation failure. Anything else is passed through for validation to reject.
 *
 * @param value The raw column value.
 * @returns A number where one was recoverable, otherwise `value` unchanged.
 */
function toColumnNumber(value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * Projects a row onto the eleven keys of a {@link ModificationRecord}.
 *
 * Deliberately produces a *candidate* rather than a record: the keys are
 * renamed from `snake_case` and nothing else happens, so
 * `parseModificationRecord` remains the only judge of whether the row is a
 * record. `previous_record_id` is spread in only when it holds a value, because
 * the schema's optional member must be **absent** rather than present and
 * `undefined` — the one representation every layer of the product agrees on.
 *
 * @param row The row as read.
 * @returns The candidate object to validate.
 */
function toRecordCandidate(row: StoredRow): StoredRow {
  const previousRecordId = row['previous_record_id'];

  return {
    id: row['id'],
    sessionId: row['session_id'],
    planVersion: toColumnNumber(row['plan_version']),
    file: row['file'],
    originalHash: row['original_hash'],
    backupPath: row['backup_path'],
    instrumentedHash: row['instrumented_hash'],
    appliedAt: toColumnNumber(row['applied_at']),
    status: row['status'],
    diff: row['diff'],
    ...(previousRecordId === null || previousRecordId === undefined ? {} : { previousRecordId }),
  };
}

/**
 * The id of a row, for an error that may name nothing else about it.
 *
 * @param row The row as read.
 * @returns The id when the column holds a string, `'<unreadable>'` otherwise —
 * a placeholder rather than the raw value, which could be anything.
 */
function rowIdOf(row: StoredRow): string {
  const id = row['id'];

  return typeof id === 'string' ? id : '<unreadable>';
}

/**
 * The error for a row that is in the table but is not a record.
 *
 * Names the id and nothing else. The parse failure travels as `cause`, whose
 * `details.issues` carry field paths and schema messages with the rejected
 * values already stripped, so this error is safe to log in full.
 *
 * @param recordId The row's id.
 * @param cause The validation failure.
 * @returns The coded error.
 */
function corruptRowError(recordId: string, cause: DebuggenError): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'A modification journal row no longer matches the modification record schema.',
    {
      hint: 'The session store may have been written by a different build of Debug Generator. The file this record describes is untouched; report the record id with the service log.',
      details: { subsystem: SUBSYSTEM, [REPO_BINDING_KEY]: REPO, recordId },
      cause,
    },
  );
}

/**
 * The error for a value this module refuses to journal.
 *
 * Coded `INSTRUMENTATION_INSTALL_FAILED` because it names the operation it
 * blocks: the caller is mid-sequence, has written a backup and has not yet
 * touched the project, so the patch must now be abandoned rather than applied.
 *
 * @param message What was refused.
 * @param hint What the caller should do about it.
 * @param details Identifiers only — never a hash, a path outside the project, a
 * diff or any file content.
 * @param cause The underlying failure, when there is one.
 * @returns The coded error.
 */
function refusedRecordError(
  message: string,
  hint: string,
  details: Readonly<Record<string, unknown>>,
  cause?: unknown,
): DebuggenError {
  return new DebuggenError('INSTRUMENTATION_INSTALL_FAILED', message, {
    hint,
    details: { subsystem: SUBSYSTEM, [REPO_BINDING_KEY]: REPO, ...details },
    cause,
  });
}

/**
 * The error for a store operation that failed for a reason of its own.
 *
 * Classifies the two constraint failures a correct caller can still provoke —
 * an id that is already journalled, and a session that does not exist — so both
 * user interfaces can say something specific, and falls back to
 * `DebuggenError.from` for everything else (a closed handle, a disk failure, a
 * statement this build cannot prepare).
 *
 * @param operation The repository method that failed.
 * @param cause Whatever was caught.
 * @param details Identifiers to attach.
 * @returns The coded error.
 */
function storeOperationError(
  operation: string,
  cause: unknown,
  details: Readonly<Record<string, unknown>> = {},
): DebuggenError {
  const errcode = sqliteErrcode(cause);
  const context = {
    subsystem: SUBSYSTEM,
    [REPO_BINDING_KEY]: REPO,
    operation,
    ...details,
  };

  if (errcode === SQLITE_CONSTRAINT_PRIMARYKEY || errcode === SQLITE_CONSTRAINT_UNIQUE) {
    return new DebuggenError(
      'STORE_ERROR',
      'A modification record with this id is already journalled.',
      {
        hint: 'Record ids are minted per modification and must not be reused. Nothing was written to the project, so the patch can be abandoned safely.',
        details: { ...context, reason: 'duplicate-record-id' },
        cause,
      },
    );
  }

  if (errcode === SQLITE_CONSTRAINT_FOREIGNKEY) {
    return new DebuggenError(
      'STORE_ERROR',
      'A modification record names a session the store does not hold.',
      {
        hint: 'The session must exist before its modifications are journalled, and a purged session takes its records with it. Nothing was written to the project.',
        details: { ...context, reason: 'unknown-session' },
        cause,
      },
    );
  }

  const error = DebuggenError.from(cause, 'STORE_ERROR');

  return new DebuggenError(
    'STORE_ERROR',
    'The modification journal could not complete an operation.',
    {
      hint:
        error.hint ??
        'Check that the state directory is writable and that no other Debug Generator service is running against it, then retry.',
      details: { ...context, reason: 'store-failed' },
      cause,
    },
  );
}

/**
 * The error for an id the journal does not hold, where absence blocks the
 * operation.
 *
 * @param operation The repository method that was called.
 * @param recordId The id that was not found.
 * @returns The coded error.
 */
function unknownRecordError(operation: string, recordId: string): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The modification journal holds no record with this id.',
    {
      hint: 'Re-read the session modifications: the record may have been purged with its session, or the id may belong to another store.',
      details: {
        subsystem: SUBSYSTEM,
        [REPO_BINDING_KEY]: REPO,
        operation,
        recordId,
        reason: 'record-not-found',
      },
    },
  );
}

/**
 * Validates and canonicalises a prospective record.
 *
 * One function for both writes, so `append` and `updateStatus` cannot drift on
 * what a storable record is. Four checks beyond the schema's own, each of which
 * exists because the row it rejects would break a later decision rather than
 * merely look wrong:
 *
 * - a blank `backupPath` leaves nothing to restore from. The record schema's
 *   own refinement rejects one too, and this check is kept rather than deferred
 *   to it because the requirement belongs to the journal: a row here must be
 *   restorable, and that must not depend on which refinements a schema one
 *   package away happens to carry;
 * - a blank `diff` leaves the developer nothing to see, and the patcher refuses
 *   to journal a transform that changed nothing;
 * - equal hashes make the reconciliation table undecidable, because "the file
 *   holds the original" and "the file holds our patch" become one observation;
 * - a timestamp outside the `INTEGER` column's resolution is rounded to it, and
 *   re-validated afterwards so the rounding itself cannot produce a record the
 *   schema would reject.
 *
 * @param value The prospective record.
 * @param operation The calling method, for the error's `details`.
 * @returns The canonical record, or the refusal.
 */
function validateRecord(value: unknown, operation: string): Result<ModificationRecord> {
  const parsed = parseModificationRecord(value);

  if (isErr(parsed)) {
    return err(
      refusedRecordError(
        'A value offered to the modification journal does not satisfy the modification record schema.',
        'Check the two SHA-256 digests, the project-relative file path, the plan version and the status. Nothing has been written to the project.',
        { operation },
        parsed.error,
      ),
    );
  }

  const record = parsed.value;

  if (record.backupPath.trim().length === 0) {
    return err(
      refusedRecordError(
        'A modification record must name the backup its original bytes were copied to.',
        'The backup must be written and fsynced before the record is journalled; a record with no backup could never restore the file.',
        { operation, recordId: record.id, file: record.file },
      ),
    );
  }

  if (record.diff.trim().length === 0) {
    return err(
      refusedRecordError(
        'A modification record must carry the unified diff of the change it describes.',
        'A transform that changed nothing must not be journalled as a modification, and the developer is shown this diff rather than the file.',
        { operation, recordId: record.id, file: record.file },
      ),
    );
  }

  if (record.originalHash === record.instrumentedHash) {
    return err(
      refusedRecordError(
        'A modification record must describe a change: its original and instrumented hashes are identical.',
        'Nothing was written, so no record is needed. Equal hashes would also make reconciliation undecidable, because the file would match both of them.',
        { operation, recordId: record.id, file: record.file },
      ),
    );
  }

  const appliedAt = toEpochColumn(record.appliedAt);

  if (appliedAt === record.appliedAt) {
    return ok(record);
  }

  const canonical = parseModificationRecord({ ...record, appliedAt });

  if (isErr(canonical)) {
    return err(
      refusedRecordError(
        'A modification record carries a timestamp the journal cannot store.',
        'appliedAt must be a positive epoch-millisecond reading; the store keeps whole milliseconds.',
        { operation, recordId: record.id, file: record.file },
        canonical.error,
      ),
    );
  }

  return canonical;
}

/**
 * Checks that a chained record lines up with the record it is layered on.
 *
 * Returns the rejection rather than a `Result`, because there is nothing to
 * hand back on success and the caller is inside a transaction that must either
 * insert or refuse.
 *
 * @param record The record being appended.
 * @param previousRecordId The parent it names.
 * @param previous The parent as read inside the same transaction, or
 * `undefined` when there is none.
 * @returns The rejection, or `undefined` when the chain lines up.
 */
function checkChain(
  record: ModificationRecord,
  previousRecordId: string,
  previous: ModificationRecord | undefined,
): DebuggenError | undefined {
  const details = {
    operation: 'append',
    recordId: record.id,
    previousRecordId,
    [LOG_BINDING_KEYS.sessionId]: record.sessionId,
    file: record.file,
    planVersion: record.planVersion,
  };

  if (previous === undefined) {
    return refusedRecordError(
      'A chained modification record names a previous record the journal does not hold.',
      'Journal the earlier plan version\u2019s record first, or append this record without a previous record if it is the first patch of this file.',
      details,
    );
  }

  if (previous.sessionId !== record.sessionId) {
    return refusedRecordError(
      'A chained modification record names a previous record belonging to another session.',
      'A chain describes one file within one session; cross-session links would restore a file with another session\u2019s backups.',
      details,
    );
  }

  if (previous.file !== record.file) {
    return refusedRecordError(
      'A chained modification record names a previous record for a different file.',
      'A chain describes successive patches of one file, and cleanup unwinds it against that one path.',
      details,
    );
  }

  if (previous.originalHash === record.originalHash) {
    return refusedRecordError(
      'A chained modification record repeats the previous record\u2019s original hash instead of continuing from its instrumented hash.',
      'A delta record patches the earlier patch\u2019s output, so its originalHash must be the previous record\u2019s instrumentedHash. If the file was restored to its original bytes first, append this record without a previous record.',
      details,
    );
  }

  if (previous.instrumentedHash !== record.originalHash) {
    return new DebuggenError(
      'MODIFICATION_CONFLICT',
      'A chained modification record does not continue from the bytes the previous record wrote.',
      {
        hint: 'The file changed between plan versions, so this delta cannot be chained onto the earlier record. Revert the earlier modification and instrument the file again from its current content.',
        details: { subsystem: SUBSYSTEM, [REPO_BINDING_KEY]: REPO, ...details },
      },
    );
  }

  return undefined;
}

/**
 * The error for a status transition {@link MODIFICATION_STATUS_TRANSITIONS} has
 * no edge for.
 *
 * Coded `SESSION_INVALID_STATE` — the operation is real but not legal from the
 * state the record is in — and returned rather than applied. A caller asking
 * for an illegal transition has lost track of a file's real state, which is
 * exactly the situation in which a write would overwrite a developer's edit, so
 * the refusal is the safe answer and the hint says what to do instead.
 *
 * @param record The record as it stands.
 * @param status The status that was asked for.
 * @returns The coded error.
 */
function illegalTransitionError(
  record: ModificationRecord,
  status: ModificationStatus,
): DebuggenError {
  const allowed = MODIFICATION_STATUS_TRANSITIONS[record.status];

  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'A modification cannot move to that status from the status it is in.',
    {
      hint:
        allowed.length === 0
          ? `A "${record.status}" record is final: its backup has been verified and deleted, so there is nothing left to act on. Re-read the record before deciding what to write.`
          : `A "${record.status}" record may only move to: ${allowed.join(', ')}. Re-read the record before deciding what to write.`,
      details: {
        subsystem: SUBSYSTEM,
        [REPO_BINDING_KEY]: REPO,
        operation: 'updateStatus',
        recordId: record.id,
        [LOG_BINDING_KEYS.sessionId]: record.sessionId,
        file: record.file,
        from: record.status,
        to: status,
        reason: 'illegal-status-transition',
      },
    },
  );
}

/**
 * The error for a status write whose optimistic guard matched no row.
 *
 * The `UPDATE` carries the status that was read moments earlier, so zero
 * changed rows means another writer moved the record in between — a transition
 * decided against a state that no longer holds. Nothing was written.
 *
 * @param record The record as it was read.
 * @param status The status that was being written.
 * @returns The coded error.
 */
function statusMovedError(record: ModificationRecord, status: ModificationStatus): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The modification journal refused a status write because the record had already moved.',
    {
      hint: 'Another writer changed this record between the read and the write. Nothing was written: re-read the record and decide again.',
      details: {
        subsystem: SUBSYSTEM,
        [REPO_BINDING_KEY]: REPO,
        operation: 'updateStatus',
        recordId: record.id,
        [LOG_BINDING_KEYS.sessionId]: record.sessionId,
        file: record.file,
        expected: record.status,
        to: status,
        reason: 'status-moved',
      },
    },
  );
}

/**
 * The error for a column whose value is not the type the DDL declares.
 *
 * Distinct from {@link corruptRowError}, which reports a whole row that no
 * longer parses: this one covers the aggregate and single-column reads, where
 * there is no record to name.
 *
 * @param operation The repository method that read it.
 * @param column The column's name — an identifier from this module, never
 * caller input.
 * @returns The coded error.
 */
function corruptColumnError(operation: string, column: string): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'A modification journal column does not hold the type the store schema declares.',
    {
      hint: 'The session store may have been written or altered by something other than Debug Generator. Report the operation and column with the service log.',
      details: { subsystem: SUBSYSTEM, [REPO_BINDING_KEY]: REPO, operation, column },
    },
  );
}

/**
 * The error for a status filter naming something outside the vocabulary.
 *
 * Reachable only from JavaScript — the parameter's type excludes it — and
 * refused rather than dropped, because a query that silently ignored part of
 * its filter would answer with more rows than the caller asked for.
 *
 * @param operation The repository method that was called.
 * @returns The coded error.
 */
function unknownStatusError(operation: string): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'A modification journal query named a status the journal does not know.',
    {
      hint: `Use one of: ${MODIFICATION_STATUSES.join(', ')}.`,
      details: {
        subsystem: SUBSYSTEM,
        [REPO_BINDING_KEY]: REPO,
        operation,
        reason: 'unknown-status',
      },
    },
  );
}

/**
 * Builds the fixed-width bind list for a `status IN (…)` filter.
 *
 * Duplicates are collapsed and the list is then padded to
 * {@link STATUS_SLOTS} by repeating one of its own values, which cannot change
 * which rows match and is what lets every status query keep a constant
 * statement text. See {@link STATUS_SLOTS}.
 *
 * @param statuses The statuses asked for.
 * @param operation The calling method, for the error's `details`.
 * @returns The bind list, `undefined` when no status was asked for at all
 * (which matches nothing), or the refusal.
 */
function statusFilterSlots(
  statuses: readonly ModificationStatus[],
  operation: string,
): Result<readonly BoundValue[] | undefined> {
  const unique: ModificationStatus[] = [];

  for (const status of statuses) {
    if (!isModificationStatus(status)) {
      return err(unknownStatusError(operation));
    }

    if (!unique.includes(status)) {
      unique.push(status);
    }
  }

  const filler = unique[0];

  if (filler === undefined) {
    return ok(undefined);
  }

  const slots: BoundValue[] = [...unique];

  while (slots.length < STATUS_SLOTS) {
    slots.push(filler);
  }

  return ok(slots);
}

/**
 * The bind list for {@link INSERT_SQL}, in the column order the statement
 * declares.
 *
 * @param record The canonical record to write.
 * @param touchedAt The bookkeeping timestamp for the `updated_at` column.
 * @returns The values to bind.
 */
function insertValues(record: ModificationRecord, touchedAt: number): readonly BoundValue[] {
  return [
    record.id,
    record.sessionId,
    record.planVersion,
    record.file,
    record.originalHash,
    record.backupPath,
    record.instrumentedHash,
    record.appliedAt,
    record.status,
    record.diff,
    // The nullable column: the schema's optional member is absent rather than
    // null, and `NULL` is how absence is spelled in SQL.
    record.previousRecordId ?? null,
    touchedAt,
  ];
}

/**
 * How many rows a write changed.
 *
 * `node:sqlite` types the count as `number | bigint` because it is read with
 * `sqlite3_changes64()`; a modification write changes at most one row, so the
 * conversion is lossless.
 *
 * @param result What `StatementSync.run` returned.
 * @returns The change count as a number.
 */
function changesOf(result: { readonly changes: number | bigint }): number {
  return typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
}

/**
 * Runs a repository operation, converting anything thrown into a coded error.
 *
 * Every public method goes through this, which is what makes the port's
 * "expected failures come back as `err`, never as an exception" guarantee true
 * in one place rather than at fourteen call sites. It matters here more than it
 * would elsewhere: these calls sit between a backup and a rename, where an
 * exception unwinding past a half-finished sequence is the failure mode the
 * journal exists to prevent.
 *
 * @typeParam T The operation's success value.
 * @param operation The method's name, for the error's `details`.
 * @param fn The work to run.
 * @param details Identifiers to attach to a failure.
 * @returns What `fn` returned, or the classified failure.
 */
function attempt<T>(
  operation: string,
  fn: () => Result<T>,
  details?: Readonly<Record<string, unknown>>,
): Result<T> {
  try {
    return fn();
  } catch (cause) {
    return err(storeOperationError(operation, cause, details));
  }
}

/** What one {@link ModificationsRepo.updateStatus} write did, for its log line. */
interface StatusWrite {
  /** The record as the store now holds it. */
  readonly record: ModificationRecord;

  /** The status it carried before. */
  readonly from: ModificationStatus;

  /** The patched columns, empty when the patch named none. */
  readonly patched: readonly string[];

  /** Whether a row was written, or the call was an idempotent no-op. */
  readonly wrote: boolean;
}

/* -------------------------------------------------------------------------------------------------
 * The repository
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the modification journal over an open store.
 *
 * `src/main.ts` constructs one per process, before start-up reconciliation and
 * before the HTTP and WebSocket surfaces accept a client, and hands it to
 * `src/instrumentation/service.ts` and `src/cleanup/cleanup.ts` as the
 * {@link ModificationJournal} those modules declare. A suite constructs one
 * against a store opened at a sandbox path — `openStore` is the only way a
 * handle exists, so the suite exercises the real DDL, the real pragmas and the
 * real migration ladder.
 *
 * The repository holds no state of its own beyond its dependencies: statements
 * live in the store's cache, and every method is a pure function of the
 * database's contents.
 *
 * @param deps The store, and optionally a logger and a clock.
 * @returns The journal.
 *
 * @example
 * ```ts
 * const modifications = createModificationsRepo({ store, logger });
 *
 * const open = await modifications.listAllOpen();
 * if (open.ok) {
 *   for (const record of open.value) {
 *     // reconcile the record against the file on disk (AAP 0.5.1)
 *   }
 * }
 * ```
 */
export function createModificationsRepo(deps: ModificationsRepoDeps): ModificationsRepo {
  const { store } = deps;
  const now = deps.now ?? nowEpochMs;
  const logger = (deps.logger ?? noopLogger).child({
    [LOG_BINDING_KEYS.subsystem]: SUBSYSTEM,
    [REPO_BINDING_KEY]: REPO,
  });

  /**
   * Reads every row a statement returns and validates each one.
   *
   * A single corrupt row fails the whole read rather than being skipped: a
   * reconciliation pass that silently dropped a record would leave that
   * record's file patched with nothing to say so.
   */
  function readAll(sql: string, values: readonly BoundValue[]): Result<ModificationRecord[]> {
    const rows = store.statement(sql).all(...values);
    const records: ModificationRecord[] = [];

    for (const row of rows) {
      const parsed = parseModificationRecord(toRecordCandidate(row));

      if (isErr(parsed)) {
        return err(corruptRowError(rowIdOf(row), parsed.error));
      }

      records.push(parsed.value);
    }

    return ok(records);
  }

  /** Reads at most one row, absence being a success. */
  function readOne(
    sql: string,
    values: readonly BoundValue[],
  ): Result<ModificationRecord | undefined> {
    const row = store.statement(sql).get(...values);

    if (row === undefined) {
      return ok(undefined);
    }

    const parsed = parseModificationRecord(toRecordCandidate(row));

    if (isErr(parsed)) {
      return err(corruptRowError(rowIdOf(row), parsed.error));
    }

    return ok(parsed.value);
  }

  /** Reads one text column from every row a statement returns. */
  function readTexts(
    operation: string,
    sql: string,
    values: readonly BoundValue[],
    column: string,
  ): Result<string[]> {
    const rows = store.statement(sql).all(...values);
    const texts: string[] = [];

    for (const row of rows) {
      const value = row[column];

      if (typeof value !== 'string') {
        return err(corruptColumnError(operation, column));
      }

      texts.push(value);
    }

    return ok(texts);
  }

  function append(record: ModificationRecord): Promise<Result<ModificationRecord>> {
    // Validation is wrapped too: the input crosses a package boundary, so even
    // reading a property off it has to be inside the guard that turns a throw
    // into a Result.
    const prepared = attempt('append', () => validateRecord(record, 'append'));

    if (isErr(prepared)) {
      return Promise.resolve(prepared);
    }

    const candidate = prepared.value;
    const touchedAt = toEpochColumn(now());
    const context = {
      recordId: candidate.id,
      [LOG_BINDING_KEYS.sessionId]: candidate.sessionId,
      file: candidate.file,
      planVersion: candidate.planVersion,
    };

    const outcome = attempt(
      'append',
      () =>
        store.transaction((): Result<ModificationRecord> => {
          const { previousRecordId } = candidate;

          // The parent is read inside this transaction, so the hash the chain
          // is checked against cannot change between the check and the insert.
          if (previousRecordId !== undefined) {
            const previous = readOne(SELECT_BY_ID_SQL, [previousRecordId]);

            if (isErr(previous)) {
              return previous;
            }

            const rejection = checkChain(candidate, previousRecordId, previous.value);

            if (rejection !== undefined) {
              return err(rejection);
            }
          }

          store.statement(INSERT_SQL).run(...insertValues(candidate, touchedAt));

          return ok(candidate);
        }),
      context,
    );

    // Logged after the transaction has committed, never inside it: a record
    // claiming a row that a failed commit rolled back is worse than no record.
    if (isErr(outcome)) {
      logger.warn('a modification could not be journalled', {
        ...context,
        code: outcome.error.code,
      });
    } else {
      logger.info('a modification was journalled', {
        ...context,
        status: outcome.value.status,
        chained: outcome.value.previousRecordId !== undefined,
      });
    }

    return Promise.resolve(outcome);
  }

  function updateStatus(
    id: ModificationId,
    status: ModificationStatus,
    patch: ModificationStatusPatch = {},
  ): Promise<Result<ModificationRecord>> {
    const outcome = attempt(
      'updateStatus',
      () => {
        if (!isModificationStatus(status)) {
          return err(unknownStatusError('updateStatus'));
        }

        return store.transaction((): Result<StatusWrite> => {
          const existing = readOne(SELECT_BY_ID_SQL, [id]);

          if (isErr(existing)) {
            return existing;
          }

          const current = existing.value;

          if (current === undefined) {
            return err(unknownRecordError('updateStatus', id));
          }

          if (!canTransitionModificationStatus(current.status, status)) {
            return err(illegalTransitionError(current, status));
          }

          // The patch's columns, in the fixed order of PATCH_COLUMNS, and the
          // prospective row they produce. Each member is handled explicitly
          // rather than in a loop so that the string and numeric columns keep
          // their own types all the way to the binding.
          const columns: string[] = [];
          const values: BoundValue[] = [];
          const candidate: StoredRow = { ...current, status };

          if (patch.instrumentedHash !== undefined) {
            candidate['instrumentedHash'] = patch.instrumentedHash;
            columns.push(PATCH_COLUMNS.instrumentedHash);
            values.push(patch.instrumentedHash);
          }

          if (patch.diff !== undefined) {
            candidate['diff'] = patch.diff;
            columns.push(PATCH_COLUMNS.diff);
            values.push(patch.diff);
          }

          if (patch.appliedAt !== undefined) {
            const appliedAt = toEpochColumn(patch.appliedAt);

            candidate['appliedAt'] = appliedAt;
            columns.push(PATCH_COLUMNS.appliedAt);
            values.push(appliedAt);
          }

          if (patch.backupPath !== undefined) {
            candidate['backupPath'] = patch.backupPath;
            columns.push(PATCH_COLUMNS.backupPath);
            values.push(patch.backupPath);
          }

          // The whole prospective row is validated before it is written, so a
          // patch can never store a record a later read would refuse.
          const validated = validateRecord(candidate, 'updateStatus');

          if (isErr(validated)) {
            return validated;
          }

          if (columns.length === 0 && status === current.status) {
            // An idempotent retry from cleanup or the patcher: the record
            // already says what the caller wants it to say, and there is
            // nothing to write.
            return ok({ record: current, from: current.status, patched: columns, wrote: false });
          }

          const written = store
            .statement(updateStatusSql(columns))
            .run(status, ...values, toEpochColumn(now()), id, current.status);

          if (changesOf(written) === 0) {
            return err(statusMovedError(current, status));
          }

          // Read back inside the same transaction, so the caller holds exactly
          // what the store now holds rather than what this method believes it
          // wrote — and so a row that would not parse is reported here instead
          // of on somebody else's read.
          const reread = readOne(SELECT_BY_ID_SQL, [id]);

          if (isErr(reread)) {
            return reread;
          }

          if (reread.value === undefined) {
            return err(unknownRecordError('updateStatus', id));
          }

          return ok({ record: reread.value, from: current.status, patched: columns, wrote: true });
        });
      },
      { recordId: id, to: status },
    );

    if (isErr(outcome)) {
      logger.warn('a modification status write was refused', {
        recordId: id,
        to: status,
        code: outcome.error.code,
      });

      return Promise.resolve(outcome);
    }

    const { record, from, patched, wrote } = outcome.value;
    const fields = {
      recordId: record.id,
      [LOG_BINDING_KEYS.sessionId]: record.sessionId,
      file: record.file,
      planVersion: record.planVersion,
      from,
      status: record.status,
      patchedColumns: patched.length,
    };

    if (wrote) {
      logger.info('a modification changed status', fields);
    } else {
      logger.debug('a modification status write was a no-op', fields);
    }

    return Promise.resolve(ok(record));
  }

  function listBySession(
    sessionId: SessionId,
    options: ListModificationsOptions = {},
  ): Promise<Result<ModificationRecord[]>> {
    return Promise.resolve(
      attempt('listBySession', () => {
        const { statuses } = options;

        if (statuses === undefined) {
          return readAll(SELECT_BY_SESSION_SQL, [sessionId]);
        }

        const slots = statusFilterSlots(statuses, 'listBySession');

        if (isErr(slots)) {
          return slots;
        }

        if (slots.value === undefined) {
          return ok([]);
        }

        return readAll(SELECT_BY_SESSION_AND_STATUS_SQL, [sessionId, ...slots.value]);
      }),
    );
  }

  function listAllOpen(): Promise<Result<ModificationRecord[]>> {
    return Promise.resolve(
      attempt('listAllOpen', () => {
        const slots = statusFilterSlots(OPEN_MODIFICATION_STATUSES, 'listAllOpen');

        if (isErr(slots)) {
          return slots;
        }

        if (slots.value === undefined) {
          return ok([]);
        }

        return readAll(SELECT_BY_STATUS_SQL, slots.value);
      }),
    );
  }

  function listOpen(sessionId?: SessionId): Promise<Result<ModificationRecord[]>> {
    if (sessionId === undefined) {
      return listAllOpen();
    }

    return listBySession(sessionId, { statuses: OPEN_MODIFICATION_STATUSES });
  }

  function get(id: ModificationId): Promise<Result<ModificationRecord | undefined>> {
    return Promise.resolve(attempt('get', () => readOne(SELECT_BY_ID_SQL, [id]), { recordId: id }));
  }

  function listByFile(sessionId: SessionId, file: string): Promise<Result<ModificationRecord[]>> {
    return Promise.resolve(
      attempt('listByFile', () => readAll(SELECT_BY_SESSION_AND_FILE_SQL, [sessionId, file])),
    );
  }

  function latestRecordForFile(
    sessionId: SessionId,
    file: string,
  ): Promise<Result<ModificationRecord | undefined>> {
    return Promise.resolve(
      attempt('latestRecordForFile', () => readOne(SELECT_CHAIN_HEAD_SQL, [sessionId, file])),
    );
  }

  function listChain(recordId: ModificationId): Promise<Result<ModificationRecord[]>> {
    return Promise.resolve(
      attempt(
        'listChain',
        () =>
          // One transaction, so the walk sees one consistent picture of the
          // chain rather than a mixture of before and after a concurrent
          // append.
          store.transaction((): Result<ModificationRecord[]> => {
            const head = readOne(SELECT_BY_ID_SQL, [recordId]);

            if (isErr(head)) {
              return head;
            }

            if (head.value === undefined) {
              return err(unknownRecordError('listChain', recordId));
            }

            const chain: ModificationRecord[] = [head.value];
            const visited = new Set<string>([head.value.id]);
            let cursor = head.value;

            while (cursor.previousRecordId !== undefined) {
              const previousRecordId = cursor.previousRecordId;

              if (visited.has(previousRecordId)) {
                return err(
                  new DebuggenError(
                    'STORE_ERROR',
                    'The modification journal holds a cycle in a record chain.',
                    {
                      hint: 'A chain must end at the first record that patched the file. Report the record ids with the service log; the files these records describe are untouched.',
                      details: {
                        subsystem: SUBSYSTEM,
                        [REPO_BINDING_KEY]: REPO,
                        operation: 'listChain',
                        recordId: cursor.id,
                        previousRecordId,
                        reason: 'chain-cycle',
                      },
                    },
                  ),
                );
              }

              if (chain.length >= MAX_CHAIN_LENGTH) {
                return err(
                  new DebuggenError(
                    'STORE_ERROR',
                    'A modification record chain is longer than the journal will walk.',
                    {
                      hint: `A chain holds one record per plan version that patched one file, so it cannot legitimately exceed ${MAX_CHAIN_LENGTH} links. Report the record id with the service log.`,
                      details: {
                        subsystem: SUBSYSTEM,
                        [REPO_BINDING_KEY]: REPO,
                        operation: 'listChain',
                        recordId,
                        links: chain.length,
                        reason: 'chain-too-long',
                      },
                    },
                  ),
                );
              }

              const previous = readOne(SELECT_BY_ID_SQL, [previousRecordId]);

              if (isErr(previous)) {
                return previous;
              }

              if (previous.value === undefined) {
                // `previous_record_id` is an `ON DELETE SET NULL` foreign key,
                // so purging an ancestor clears the link instead of leaving it
                // dangling. A dangling link therefore means the journal was
                // altered by something else, and a restore that ignored the
                // missing ancestor would write the wrong bytes.
                return err(
                  new DebuggenError(
                    'STORE_ERROR',
                    'A modification record chain refers to a record the journal no longer holds.',
                    {
                      hint: 'The chain cannot be unwound safely while a link is missing. The files these records describe are untouched; report the record ids with the service log.',
                      details: {
                        subsystem: SUBSYSTEM,
                        [REPO_BINDING_KEY]: REPO,
                        operation: 'listChain',
                        recordId: cursor.id,
                        previousRecordId,
                        reason: 'chain-link-missing',
                      },
                    },
                  ),
                );
              }

              visited.add(previous.value.id);
              chain.push(previous.value);
              cursor = previous.value;
            }

            // Collected newest first by construction; the contract is oldest
            // first, and a restore reverses it again.
            chain.reverse();

            return ok(chain);
          }),
        { recordId },
      ),
    );
  }

  function listConflicts(sessionId?: SessionId): Promise<Result<ModificationRecord[]>> {
    if (sessionId !== undefined) {
      return listBySession(sessionId, { statuses: [CONFLICT_STATUS] });
    }

    return Promise.resolve(
      attempt('listConflicts', () => {
        const slots = statusFilterSlots([CONFLICT_STATUS], 'listConflicts');

        if (isErr(slots)) {
          return slots;
        }

        if (slots.value === undefined) {
          return ok([]);
        }

        return readAll(SELECT_BY_STATUS_SQL, slots.value);
      }),
    );
  }

  function listBackupPaths(options: ListBackupPathsOptions = {}): Promise<Result<string[]>> {
    return Promise.resolve(
      attempt('listBackupPaths', () => {
        const { sessionId, statuses } = options;
        const column = PATCH_COLUMNS.backupPath;

        if (statuses === undefined) {
          return sessionId === undefined
            ? readTexts('listBackupPaths', SELECT_BACKUP_PATHS_SQL, [], column)
            : readTexts('listBackupPaths', SELECT_BACKUP_PATHS_BY_SESSION_SQL, [sessionId], column);
        }

        const slots = statusFilterSlots(statuses, 'listBackupPaths');

        if (isErr(slots)) {
          return slots;
        }

        if (slots.value === undefined) {
          return ok([]);
        }

        return sessionId === undefined
          ? readTexts('listBackupPaths', SELECT_BACKUP_PATHS_BY_STATUS_SQL, slots.value, column)
          : readTexts(
              'listBackupPaths',
              SELECT_BACKUP_PATHS_BY_SESSION_AND_STATUS_SQL,
              [sessionId, ...slots.value],
              column,
            );
      }),
    );
  }

  function countBySession(sessionId: SessionId): Promise<Result<number>> {
    return Promise.resolve(
      attempt('countBySession', () => {
        const row = store.statement(COUNT_BY_SESSION_SQL).get(sessionId);
        const total = row === undefined ? undefined : toColumnNumber(row['total']);

        if (typeof total !== 'number' || !Number.isFinite(total)) {
          return err(corruptColumnError('countBySession', 'total'));
        }

        return ok(total);
      }),
    );
  }

  function deleteBySession(sessionId: SessionId): Promise<Result<number>> {
    const outcome = attempt('deleteBySession', () =>
      ok(changesOf(store.transaction(() => store.statement(DELETE_BY_SESSION_SQL).run(sessionId)))),
    );

    if (!isErr(outcome)) {
      logger.info('modification records were purged', {
        [LOG_BINDING_KEYS.sessionId]: sessionId,
        deleted: outcome.value,
      });
    }

    return Promise.resolve(outcome);
  }

  // The `satisfies` clause is the compile-time port conformance check: this
  // repository must stay usable as the `ModificationJournal` that
  // `@debuggen/instrumentation`'s patcher, installer and cleanup declare, and
  // that package type-checks its in-memory fakes against the same interface. A
  // signature that drifted on either side fails here rather than at the first
  // call site.
  return {
    append,
    updateStatus,
    listBySession,
    listOpen,
    listAllOpen,
    get,
    listByFile,
    latestRecordForFile,
    listChain,
    listConflicts,
    listBackupPaths,
    countBySession,
    deleteBySession,
  } satisfies ModificationJournal & ModificationsRepo;
}
