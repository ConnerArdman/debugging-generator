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
 * The repository also answers {@link ModificationCorroborationReader}, the
 * metadata-only read the telemetry ingest path corroborates patch stamps with,
 * which never loads a diff.
 *
 * Every shape crossing that seam is imported, never restated:
 * {@link ModificationRecord}, {@link ModificationStatus},
 * {@link ModificationStatusPatch}, `MODIFICATION_STATUSES`,
 * `OPEN_MODIFICATION_STATUSES` and `parseModificationRecord` all come from
 * `@debuggen/instrumentation`. A second declaration of any of them in this
 * workspace would be the defect AAP §0.4.2 names.
 *
 * ## The three invariants enforced on the way in
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
 * 3. **A file's history is one chain.** Within one session, the records of one
 *    file must form a single line: every record is layered on **at most once**
 *    (the single-child rule), a chained record may only be layered on the
 *    **sole current head** of that line — a record with no child, not
 *    `reverted`, and with every other open record of the file among its
 *    ancestors — and a new unchained record (a root) may only be appended once
 *    every earlier record of the file is `reverted`. Two records naming one
 *    parent, or two open chains over one file, would each claim to describe
 *    the bytes on disk; cleanup could then restore one branch and conflict on,
 *    or strand, the other. `append` enforces all three readings inside its
 *    `BEGIN IMMEDIATE` transaction, which serialises the check against every
 *    other writer — this connection's and any other process's — so the check
 *    and the insert see one state. The partial unique index
 *    `idx_modifications_previous_record_id_unique` (schema version 2, in
 *    `./migrations.ts`) is the **second line of defence**: it refuses a second
 *    child even from a writer that bypassed this repository, and an insert it
 *    refuses is reported as the same typed chain-fork conflict. Forks written
 *    before version 2 are flagged `chain_fork = 1` by that migration, exempt
 *    from the index but never from these checks, which count every child that
 *    is not `reverted`, whatever its flag. A `reverted` child is history rather
 *    than a branch: the installer's delta rollback (AAP 0.4.2) reverts a
 *    follow-up record while its parent stays `applied`, and the next follow-up
 *    on that file is layered on the same parent again.
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
 *   exactly what that code means. Also every refusal of invariant 3, with a
 *   `details.reason` of `chain-parent-has-child`, `chain-parent-not-head` or
 *   `chain-root-while-open`: the journal's record of the file no longer
 *   supports the patch the caller is about to make, which is the same
 *   situation seen from the journal's side.
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
import { MODIFICATIONS_PAGE_DIFF_BUDGET, MODIFICATION_DIFF_MAX_BYTES } from '@debuggen/protocol';
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

/**
 * The terminal status, named once for the single-child probe: a `reverted`
 * layer never blocks a new one. Typed against the upstream vocabulary for the
 * reason {@link CONFLICT_STATUS} is.
 */
const REVERTED_STATUS: ModificationStatus = 'reverted';

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

/**
 * Whether an id is already journalled, answered from the primary key without
 * reading or validating the row.
 *
 * `append` asks this before its chain checks, so re-offering a record that is
 * already stored is reported as the duplicate it is rather than as the chain
 * fork it would otherwise also look like.
 */
const SELECT_ID_EXISTS_SQL = 'SELECT 1 AS present FROM modifications WHERE id = ?';

/**
 * The oldest record layered on a given record that is not `reverted`, if any —
 * whatever its `chain_fork` flag.
 *
 * The single-child probe of `append`. Served by the non-unique
 * `idx_modifications_previous_record_id`: the partial unique index of schema
 * version 2 cannot answer it, because this lookup must also see the pre-existing
 * forks that index exempts. The second placeholder binds
 * {@link REVERTED_STATUS}: a reverted layer was rolled back and no longer
 * describes bytes the file can hold, so it never blocks a new layer — the same
 * exclusion the index makes. Ordered by `rowid` so the child it names is
 * deterministic.
 */
const SELECT_FIRST_CHILD_SQL = `SELECT id FROM modifications
WHERE previous_record_id = ? AND status <> ?
ORDER BY rowid ASC
LIMIT 1`;

/** Reads one session's records in append order. */
const SELECT_BY_SESSION_SQL = `SELECT ${SELECTED} FROM modifications
WHERE session_id = ?
ORDER BY applied_at ASC, rowid ASC`;

/**
 * Reads the corroboration facts of one session's records — file, status and
 * application time only — in append order.
 *
 * The telemetry ingest path's read (see
 * {@link ModificationCorroborationReader}): it runs for every batch that
 * carries a patch-stamped span, so it selects none of the columns only a
 * restore or a display needs — above all not `diff`, which may hold megabytes
 * of the developer's source. The `session_id`-prefixed indexes serve the
 * filter.
 */
const SELECT_CORROBORATIONS_BY_SESSION_SQL = `SELECT file, status, applied_at FROM modifications
WHERE session_id = ?
ORDER BY applied_at ASC, rowid ASC`;

/**
 * Reads the patch evidence of one session's records of one file — file,
 * status, application time and diff — in append order.
 *
 * The ingest path's second read (see {@link ModificationCorroborationReader}):
 * the source resolver asks it only for a file the metadata read above found in
 * force, to prove a patch stamp's exact position and symbol against the diff
 * the patch wrote, so no other file's diff is ever loaded. Still no hash and
 * no backup path. The `session_id`-prefixed indexes serve the filter.
 */
const SELECT_PATCH_EVIDENCE_BY_SESSION_FILE_SQL = `SELECT file, status, applied_at, diff FROM modifications
WHERE session_id = ? AND file = ?
ORDER BY applied_at ASC, rowid ASC`;

/**
 * Reads a window of one session's records in append order: exactly
 * {@link SELECT_BY_SESSION_SQL} — derived from it, so the two orders cannot
 * drift — bounded by `LIMIT ? OFFSET ?`. Run by
 * {@link ModificationsRepo.listPageBySession} only once
 * {@link SELECT_PAGE_DIFF_BYTES_SQL} has decided how many records the page
 * holds, with exactly that many as its `LIMIT`, so no row past the page is
 * read.
 */
const SELECT_PAGE_BY_SESSION_SQL = `${SELECT_BY_SESSION_SQL}
LIMIT ? OFFSET ?`;

/**
 * Measures a window of one session's records before any of them is read: each
 * record's id and the UTF-8 byte length of its diff, in the append order of
 * {@link SELECT_BY_SESSION_SQL}.
 *
 * `octet_length()` of a column is answered from the row's record header — the
 * serial type of a text value encodes its length — so SQLite computes it
 * without loading the diff (the `Column` opcode is compiled with the
 * byte-length-only flag). The diff column is `TEXT` in a UTF-8 database, so
 * the value is exactly protocol's `utf8ByteLength` of the diff this repository
 * would return: `node:sqlite` writes a lone surrogate as U+FFFD, three bytes,
 * the same count protocol assigns it.
 */
const SELECT_PAGE_DIFF_BYTES_SQL = `SELECT id, octet_length(diff) AS diff_bytes FROM modifications
WHERE session_id = ?
ORDER BY applied_at ASC, rowid ASC
LIMIT ? OFFSET ?`;

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
 * The head is the record no live later record is layered on top of, which is a
 * stronger statement than "the newest by timestamp": two records of one chain
 * can carry the same `applied_at` reading, and the link is what orders them. A
 * `reverted` layer does not count as layered on — both placeholders after the
 * file bind {@link REVERTED_STATUS} — and an open candidate is preferred over a
 * reverted one, so after the installer rolls a follow-up delta back the head is
 * the parent the file holds again: the record the next follow-up is layered on,
 * which `append`'s single-child probe accepts. The remaining ordering only
 * settles several candidates of the same kind, where the most recently applied
 * one is the right answer.
 */
const SELECT_CHAIN_HEAD_SQL = `SELECT ${SELECTED} FROM modifications AS head
WHERE head.session_id = ?
  AND head.file = ?
  AND NOT EXISTS (
    SELECT 1 FROM modifications AS later
    WHERE later.session_id = head.session_id
      AND later.file = head.file
      AND later.previous_record_id = head.id
      AND later.status <> ?
  )
ORDER BY (head.status = ?) ASC, head.applied_at DESC, head.rowid DESC
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
 * One session's backup references, metadata only: the three columns the
 * retention sweep's membership probe reads, never the diff or the patched
 * hash. An index range read — the `session_id` prefix of
 * `idx_modifications_session_id_file` — so a probe examines that session's
 * records and no other row of the journal; streamed row by row by
 * {@link scanSessionBackupReferences}, so no `DISTINCT`, no sort and no array
 * is built.
 */
export const SELECT_SESSION_BACKUP_REFERENCES_SQL =
  'SELECT backup_path, original_hash, status FROM modifications WHERE session_id = ?';

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

/** The window of {@link ModificationsRepo.listPageBySession}. */
export interface ModificationPageWindow {
  /**
   * The most records the page holds, a non-negative safe integer. `0` is a
   * count-only request: the page reads the journal's length and no record.
   */
  readonly limit: number;

  /** How many of the session's records to skip, in application order. */
  readonly offset: number;

  /**
   * The most diff text the page may carry, summed over its records in **UTF-8
   * bytes** — the encoding the page travels in, the unit protocol's
   * `utf8ByteLength` and `modificationsDiffBytes` measure and the store's
   * `octet_length()` reports. Defaults to protocol's
   * `MODIFICATIONS_PAGE_DIFF_BUDGET`. Must be at least protocol's
   * `MODIFICATION_DIFF_MAX_BYTES`, the most bytes one journalled diff can
   * encode to, which is what guarantees that the first record of a page always
   * fits and a paging loop never stalls.
   */
  readonly maxDiffBytes?: number | undefined;
}

/**
 * One page of a session's modification journal.
 *
 * `records` holds at most `limit` records in application order, and ends
 * early — before `limit` — when the next record's diff would take the page's
 * diff bytes past their budget; it is never empty while `offset < total` and
 * `limit > 0`. The following page therefore starts at `offset +
 * records.length`.
 */
export interface ModificationPage {
  /** This page's records, validated, in the order they were applied. */
  readonly records: ModificationRecord[];

  /** How many records the session's journal holds in total. */
  readonly total: number;
}

/** Narrowing for {@link ModificationsRepo.listBackupPaths}. */
export interface ListBackupPathsOptions {
  /**
   * Keep only the paths referenced by records in these statuses.
   *
   * The union of every status says which files under the backups directory are
   * still referenced at all, and `['conflict']` says which of those must never
   * be deleted, because a conflicting record's backup is the developer's only
   * pristine copy. The retention sweep asks the same two questions of only the
   * files it is about to judge, one session directory at a time, through
   * {@link scanSessionBackupReferences}, rather than materialising either list.
   *
   * Absent means every status; an empty array matches nothing, as in
   * {@link ListModificationsOptions.statuses}.
   */
  readonly statuses?: readonly ModificationStatus[] | undefined;

  /** Keep only the paths referenced by one session's records. */
  readonly sessionId?: SessionId | undefined;
}

/**
 * The facts of one modification record that prove a file was instrumented
 * when a span ran: which file, in which status, since when.
 *
 * A `Pick` of the upstream {@link ModificationRecord}, never a restatement, so
 * a change to any of the three fields there changes this shape too. It is what
 * the source resolver's `patch` route corroborates a patch stamp with
 * (`../source/resolve.ts`), and all it needs: no hash, no backup path, no diff.
 */
export type ModificationCorroboration = Pick<ModificationRecord, 'file' | 'status' | 'appliedAt'>;

/**
 * One record's patch evidence: its {@link ModificationCorroboration} facts and
 * the diff the patch wrote, whose added lines carry the span `meta` literal the
 * source resolver's `patch` route checks a stamp's exact position and symbol
 * against. Also a `Pick` of the upstream {@link ModificationRecord}.
 */
export type ModificationPatchEvidence = Pick<
  ModificationRecord,
  'file' | 'status' | 'appliedAt' | 'diff'
>;

/**
 * The journal's metadata-only read for the telemetry ingest path.
 *
 * A separate interface rather than a member of {@link ModificationsRepo}: that
 * interface is also implemented by in-memory journals in other suites, which
 * have no reason to know about the ingest path, and
 * {@link createModificationsRepo} returns both.
 */
export interface ModificationCorroborationReader {
  /**
   * Lists the corroboration facts of one session's records, in append order —
   * the order {@link ModificationsRepo.listBySession} guarantees.
   *
   * Reads only the `file`, `status` and `applied_at` columns. Each row is
   * checked on the way out: a status outside the vocabulary, a blank file or a
   * timestamp that is not a finite number fails the whole read, as a corrupt
   * row fails every other read here, rather than being skipped.
   *
   * @param sessionId The session to list.
   * @returns The facts, oldest first; an empty array is a success.
   */
  listCorroborationsBySession(sessionId: SessionId): Promise<Result<ModificationCorroboration[]>>;

  /**
   * Lists the patch evidence of one session's records of one file, in append
   * order: the `file`, `status`, `applied_at` and `diff` columns, and only for
   * rows whose stored `file` equals `file` exactly.
   *
   * Asked only for a file {@link listCorroborationsBySession} found in force,
   * so a session's other diffs are never read. Each row is checked on the way
   * out as that read checks its own, and a `diff` that is not text fails the
   * read too.
   *
   * @param sessionId The session to list.
   * @param file The file exactly as the journal stores it.
   * @returns The evidence, oldest first; an empty array is a success.
   */
  listPatchEvidenceBySessionFile(
    sessionId: SessionId,
    file: string,
  ): Promise<Result<ModificationPatchEvidence[]>>;
}

/**
 * One journal record's reference to a backup file: the metadata the retention
 * sweep's membership probe reads, and nothing else.
 *
 * A record's backup lives in its own session's directory:
 * `backups/<sessionId>/<originalHash>`, the path the backup store composes, or
 * a relocation into a subdirectory of that same directory, which `backupPath`
 * then names (`@debuggen/instrumentation`'s `patch/backup-store.ts`). The
 * store never opens a recorded path outside the record's own session
 * directory; it substitutes the composed path. So `originalHash` names the
 * composed file even when `backupPath` does not, and `backupPath` is the
 * stored text exactly — the journal validates only that it is not blank — so a
 * consumer comparing it with a walked path normalises it first.
 */
export interface BackupReference {
  /** The backup path the record names, as stored. */
  readonly backupPath: string;
  /** The digest of the original bytes: the file name of the composed backup. */
  readonly originalHash: string;
  /** The record's status. */
  readonly status: ModificationStatus;
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
   * Also refuses, as `MODIFICATION_CONFLICT`, anything that would fork the
   * file's history within the session (this module's invariant 3): a chained
   * record whose parent already has a record layered on it that is not
   * `reverted` (`chain-parent-has-child`); a chained record whose parent is not the sole
   * current head of the file's chain — the parent is `reverted`, or another
   * open record of the file is not among its ancestors
   * (`chain-parent-not-head`); and an unchained record while the session still
   * holds an open record for the file (`chain-root-while-open`) — a new root is
   * legal only once every earlier record of the file is `reverted`. The checks
   * run inside the append's own `BEGIN IMMEDIATE` transaction, so two writers
   * racing onto one parent are serialised and the second is refused; the
   * partial unique index on `previous_record_id` refuses a second child even
   * from a writer that bypassed this repository, and that refusal comes back
   * as the same `chain-parent-has-child` conflict. To extend a file's chain,
   * layer the new record on {@link ModificationsRepo.latestRecordForFile}.
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
   * Reads one diff-budgeted page of a session's journal, in the application
   * order {@link ModificationsRepo.listBySession} uses, with the journal's
   * length — what `GET /sessions/:id/modifications` serves, so the editor's
   * `ModificationsList` never receives every diff of a large journal in one
   * body.
   *
   * At most three statements inside one transaction, so the page and the
   * total describe the same state:
   *
   * 1. a `COUNT(*)` by `session_id` — the only statement for `limit: 0` or an
   *    `offset` at or past the end, which therefore read no record at all;
   * 2. the window **measured**: each record's id and `octet_length(diff)`,
   *    which SQLite answers from the row header without loading the diff. The
   *    page is the longest prefix of the window whose diffs fit `maxDiffBytes`
   *    UTF-8 bytes — always at least one record, because no journalled diff
   *    exceeds `MODIFICATION_DIFF_MAX_BYTES`; a first record measuring more
   *    than the budget is therefore a corrupt row;
   * 3. exactly that many full rows read and parsed, in the same order.
   *
   * No diff past the page is ever read, and the record that ends a page is
   * measured, never parsed. A row of the page that no longer parses fails the
   * read, as in `listBySession`. Diffs are never logged.
   *
   * @param sessionId The session whose journal to page.
   * @param window The page window and diff budget; see
   * {@link ModificationPageWindow}.
   * @returns The page, or `err` `STORE_ERROR` for a window outside its domain
   * (`invalid-argument`), a corrupt row or a store failure.
   *
   * @example
   * ```ts
   * const page = await modifications.listPageBySession(sessionId, { limit: 256, offset: 0 });
   * // page.value.records → the first records whose diffs fit the 6 MiB (UTF-8) budget
   * // page.value.total   → the journal's length
   * ```
   */
  listPageBySession(
    sessionId: SessionId,
    window: ModificationPageWindow,
  ): Promise<Result<ModificationPage>>;

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
   * The head is the record no live later record is layered on top of, not
   * merely the newest by timestamp — two records of one chain can share an
   * `applied_at` reading, and the link is what orders them. A `reverted` layer
   * does not count, and an open head is preferred over a reverted one, so after
   * a follow-up delta was rolled back this is the parent the file holds again —
   * the record a new layer must name.
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
   * This is what tells a referenced backup from an orphan left by a crash
   * between the backup write and the journal append, and what protects a
   * conflicting record's backup. It materialises the whole answer, so the
   * retention sweep — which may face a large journal on every start — asks the
   * same question of one session at a time through the indexed, streaming
   * {@link scanSessionBackupReferences} instead.
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

/**
 * A `UNIQUE` index refused the row. See {@link SQLITE_CONSTRAINT_PRIMARYKEY}.
 *
 * The primary key reports its own code, so on this table the only index that
 * can raise this one is schema version 2's partial unique index on
 * `previous_record_id`: the row would have been a second child of its parent.
 */
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
 * The error for a journalled diff that measures more bytes than any diff the
 * journal accepts — a row written past this repository's validation.
 *
 * Reported as the corrupt row it is, by id, with the measured and permitted
 * byte counts as the cause's details: counts only, never any of the diff.
 *
 * @param recordId The row's id.
 * @param diffBytes The diff's measured UTF-8 byte length.
 * @param budgetBytes The page budget it exceeded on its own.
 * @returns The coded error.
 */
function oversizedDiffError(
  recordId: string,
  diffBytes: number,
  budgetBytes: number,
): DebuggenError {
  return corruptRowError(
    recordId,
    new DebuggenError(
      'STORE_ERROR',
      'A journalled diff is larger than any diff the modification journal accepts.',
      {
        details: {
          subsystem: SUBSYSTEM,
          [REPO_BINDING_KEY]: REPO,
          reason: 'diff-over-cap',
          diffBytes,
          budgetBytes,
          maxDiffBytes: MODIFICATION_DIFF_MAX_BYTES,
        },
      },
    ),
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
 * The stable `details.reason` of each refusal that keeps a file's history one
 * chain — invariant 3 of this module's overview.
 *
 * - `chain-parent-has-child` — the named parent already has a record layered on
 *   it that is not `reverted`, whatever its `chain_fork` flag;
 * - `chain-parent-not-head` — the named parent is not the sole current head of
 *   the file's chain: it is `reverted`, or another open record of the file is
 *   not among its ancestors;
 * - `chain-root-while-open` — an unchained record for a file the session still
 *   holds an open record for.
 */
type ChainForkReason = 'chain-parent-has-child' | 'chain-parent-not-head' | 'chain-root-while-open';

/**
 * Which line of defence refused a second child, as `details.detectedBy`: the
 * in-transaction check of `append`, or the partial unique index behind it.
 */
type ChainForkDetector = 'journal-check' | 'unique-index';

/** The message of a second child, whichever line of defence caught it. */
const SECOND_CHILD_MESSAGE =
  'A chained modification record names a previous record that already has a later record layered on it.';

/** The hint of a second child, whichever line of defence caught it. */
const SECOND_CHILD_HINT =
  'A record may be layered on at most once, so that a file\u2019s history stays one chain cleanup can unwind. Nothing was written to the project: re-read the file\u2019s current head (latestRecordForFile) and layer the patch on that record, or revert the file\u2019s open modifications and instrument it again from its current content.';

/**
 * The error for an append that would fork a file's history: code
 * `MODIFICATION_CONFLICT`.
 *
 * That code because the caller's picture of the file no longer matches the
 * journal's — the same situation as a hash that no longer lines up, seen from
 * the journal's side. Carries identifiers only: record ids, the session, the
 * project-relative file, the plan version and the reason — never a hash, a
 * backup path, a diff or any file content.
 *
 * @param message What was refused.
 * @param hint What the caller should do instead.
 * @param reason The stable reason. See {@link ChainForkReason}.
 * @param details Identifiers to attach.
 * @param cause The underlying failure, when an index raised it.
 * @returns The coded error.
 */
function chainForkError(
  message: string,
  hint: string,
  reason: ChainForkReason,
  details: Readonly<Record<string, unknown>>,
  cause?: unknown,
): DebuggenError {
  return new DebuggenError('MODIFICATION_CONFLICT', message, {
    hint,
    details: { subsystem: SUBSYSTEM, [REPO_BINDING_KEY]: REPO, ...details, reason },
    cause,
  });
}

/**
 * The error for an id that is already journalled: code `STORE_ERROR`.
 *
 * Reached from `append`'s in-transaction probe and from the primary key behind
 * it, so both report the same refusal.
 *
 * @param details Identifiers to attach.
 * @param cause The constraint failure, when the primary key raised it.
 * @returns The coded error.
 */
function duplicateRecordError(
  details: Readonly<Record<string, unknown>>,
  cause?: unknown,
): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'A modification record with this id is already journalled.',
    {
      hint: 'Record ids are minted per modification and must not be reused. Nothing was written to the project, so the patch can be abandoned safely.',
      details: {
        subsystem: SUBSYSTEM,
        [REPO_BINDING_KEY]: REPO,
        ...details,
        reason: 'duplicate-record-id',
      },
      cause,
    },
  );
}

/**
 * The error for a store operation that failed for a reason of its own.
 *
 * Classifies the three constraint failures a correct caller can still provoke
 * — an id that is already journalled, a second child refused by the
 * single-child index, and a session that does not exist — so both user
 * interfaces can say something specific, and falls back to
 * `DebuggenError.from` for everything else (a closed handle, a disk failure, a
 * statement this build cannot prepare).
 *
 * The single-child index is the second line of defence behind `append`'s own
 * check, so reaching it means a writer raced or bypassed that check; it is
 * reported as the same typed chain-fork conflict rather than as a generic
 * store failure, because the caller's remedy is the same.
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

  if (errcode === SQLITE_CONSTRAINT_PRIMARYKEY) {
    return duplicateRecordError(context, cause);
  }

  if (errcode === SQLITE_CONSTRAINT_UNIQUE) {
    const detectedBy: ChainForkDetector = 'unique-index';

    return chainForkError(
      SECOND_CHILD_MESSAGE,
      SECOND_CHILD_HINT,
      'chain-parent-has-child',
      { ...context, detectedBy },
      cause,
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
 * What `append` reads, inside its own transaction, about the file a record
 * patches — the view the single-chain checks are decided against.
 */
interface FileHistory {
  /**
   * Every record of the record's `(session, file)`, in append order, whatever
   * its status.
   */
  readonly records: readonly ModificationRecord[];

  /**
   * The oldest record already layered on the parent a chained record names
   * that is not `reverted` — whatever its `chain_fork` flag — or `undefined`
   * when the parent has none, or when the record is unchained.
   */
  readonly existingChildId: string | undefined;
}

/**
 * Whether a record still needs reconciliation: every status but `reverted`.
 *
 * Read from the upstream `OPEN_MODIFICATION_STATUSES` rather than spelled
 * here, so a status added to the vocabulary is classified by the one list both
 * packages share.
 *
 * @param record The record to classify.
 * @returns `true` for an open record.
 */
function isOpenRecord(record: ModificationRecord): boolean {
  const open: readonly ModificationStatus[] = OPEN_MODIFICATION_STATUSES;

  return open.includes(record.status);
}

/**
 * The ids of `head` and of every record it descends from, following
 * `previousRecordId` through one file's records.
 *
 * Bounded twice, like {@link ModificationsRepo.listChain}: a visited set stops
 * a cycle and {@link MAX_CHAIN_LENGTH} stops a corrupted list. Stopping early
 * can only leave an ancestor out, which makes the sole-head check refuse — the
 * conservative direction for a journal that is already inconsistent.
 *
 * @param head The record to walk back from.
 * @param records The file's records, which must include `head`'s ancestors.
 * @returns The ids on `head`'s line, `head` included.
 */
function lineageOf(head: ModificationRecord, records: readonly ModificationRecord[]): Set<string> {
  const byId = new Map(records.map((entry) => [entry.id, entry] as const));
  const lineage = new Set<string>();
  let cursor: ModificationRecord | undefined = head;

  while (cursor !== undefined && !lineage.has(cursor.id) && lineage.size < MAX_CHAIN_LENGTH) {
    lineage.add(cursor.id);
    cursor = cursor.previousRecordId === undefined ? undefined : byId.get(cursor.previousRecordId);
  }

  return lineage;
}

/**
 * Checks that a chained record lines up with the record it is layered on, and
 * that layering it there keeps the file's history one chain.
 *
 * Two groups of checks, in this order:
 *
 * 1. **The link itself** — the parent exists, belongs to the same session,
 *    names the same file, and wrote exactly the bytes this record starts from.
 * 2. **The single-chain invariant** (this module's invariant 3) — the parent
 *    has no live record layered on it — none that is not `reverted`, whatever
 *    its `chain_fork` flag (`chain-parent-has-child`) — and it is the **sole
 *    current head** of the file's chain (`chain-parent-not-head`): it is not
 *    `reverted`, and every other open record of the file is one of its
 *    ancestors. A reverted parent describes bytes the file no longer holds; an
 *    open record off the parent's line is a second chain over the same file.
 *
 * Every read this relies on is made inside `append`'s `BEGIN IMMEDIATE`
 * transaction, which serialises it against every other writer, so the answer
 * still holds when the insert runs. The partial unique index on
 * `previous_record_id` is the second line of defence for the single-child
 * half; nothing but this function enforces the sole-head half, which is why it
 * reads the whole file history rather than only the parent.
 *
 * Returns the rejection rather than a `Result`, because there is nothing to
 * hand back on success and the caller is inside a transaction that must either
 * insert or refuse.
 *
 * @param record The record being appended.
 * @param previousRecordId The parent it names.
 * @param previous The parent as read inside the same transaction, or
 * `undefined` when there is none.
 * @param history The file's records and the parent's existing child, read in
 * the same transaction.
 * @returns The rejection, or `undefined` when the record may be layered there.
 */
function checkChain(
  record: ModificationRecord,
  previousRecordId: string,
  previous: ModificationRecord | undefined,
  history: FileHistory,
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

  if (history.existingChildId !== undefined) {
    const detectedBy: ChainForkDetector = 'journal-check';

    return chainForkError(SECOND_CHILD_MESSAGE, SECOND_CHILD_HINT, 'chain-parent-has-child', {
      ...details,
      existingChildRecordId: history.existingChildId,
      detectedBy,
    });
  }

  if (!isOpenRecord(previous)) {
    return chainForkError(
      'A chained modification record names a previous record that has already been reverted.',
      'A reverted record describes bytes the file no longer holds, so nothing may be layered on it. Nothing was written to the project: once every record of the file is reverted, append the patch without a previous record.',
      'chain-parent-not-head',
      { ...details, parentStatus: previous.status },
    );
  }

  const lineage = lineageOf(previous, history.records);
  const offLine = history.records.filter((entry) => isOpenRecord(entry) && !lineage.has(entry.id));

  if (offLine.length > 0) {
    return chainForkError(
      'A chained modification record names a previous record that is not the current head of its file\u2019s chain.',
      'The session holds another open record for this file that the named record does not descend from, so layering on it would fork the file\u2019s history. Nothing was written to the project: reconcile the file\u2019s open modifications before patching it again.',
      'chain-parent-not-head',
      { ...details, openRecordIds: offLine.map((entry) => entry.id) },
    );
  }

  return undefined;
}

/**
 * Checks that an unchained record — a new root — does not open a second chain
 * over a file the session is still holding one for.
 *
 * A root is legal only while every earlier record of the file in the session is
 * `reverted`: the file then holds its original bytes and a fresh chain can
 * start from them. The patcher appends a root in exactly that situation — its
 * parent resolution layers a patch on the file's last `applied` record and
 * refuses a file with a `pending`, `failed` or `conflict` record — so no
 * legitimate flow needs a second open root, and a record that would be one is
 * a fork of the file's history. Other sessions' records are not consulted: a
 * chain describes one file within one session.
 *
 * @param record The unchained record being appended.
 * @param history The file's records, read inside `append`'s transaction.
 * @returns The rejection, or `undefined` when a new root is legal.
 */
function checkRoot(record: ModificationRecord, history: FileHistory): DebuggenError | undefined {
  const open = history.records.filter(isOpenRecord);

  if (open.length === 0) {
    return undefined;
  }

  return chainForkError(
    'A modification record starts a new chain for a file this session still holds an open modification record for.',
    'Two open chains over one file would each claim to describe its bytes. Nothing was written to the project: layer the patch on the file\u2019s current head (latestRecordForFile) through previousRecordId, or revert the file\u2019s open modifications first.',
    'chain-root-while-open',
    {
      operation: 'append',
      recordId: record.id,
      [LOG_BINDING_KEYS.sessionId]: record.sessionId,
      file: record.file,
      planVersion: record.planVersion,
      openRecordIds: open.map((entry) => entry.id),
    },
  );
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
 * The error for a paging argument outside its domain.
 *
 * Reachable only through a caller defect — `src/server/routes/sessions.ts`
 * passes a window protocol's `parseListPageQuery` already bounded — and
 * refused rather than clamped, because a clamped window would answer a page
 * the caller did not ask for.
 *
 * @param operation The repository method that was called.
 * @param field The argument's name — an identifier from this module.
 * @param expectation What the argument must be, as a fixed phrase.
 * @returns The coded error.
 */
function invalidWindowError(operation: string, field: string, expectation: string): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    `The ${field} passed to the modification journal must be ${expectation}.`,
    {
      hint: 'This is a defect in the caller rather than a setting: correct the argument and retry.',
      details: {
        subsystem: SUBSYSTEM,
        [REPO_BINDING_KEY]: REPO,
        operation,
        field,
        reason: 'invalid-argument',
      },
    },
  );
}

/**
 * Whether `value` is a safe integer of at least `min`.
 *
 * @param value The candidate.
 * @param min The inclusive lower bound.
 * @returns `true` when it is.
 */
function isSafeIntegerFrom(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
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
 * @returns The journal, which is also the
 * {@link ModificationCorroborationReader} the telemetry ingest path reads.
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
export function createModificationsRepo(
  deps: ModificationsRepoDeps,
): ModificationsRepo & ModificationCorroborationReader {
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

  /**
   * The id of the oldest record layered on `recordId` that is not `reverted`,
   * whatever its `chain_fork` flag, or `undefined` when no live record is
   * layered on it.
   */
  function readFirstChildId(recordId: string): Result<string | undefined> {
    const row = store.statement(SELECT_FIRST_CHILD_SQL).get(recordId, REVERTED_STATUS);

    if (row === undefined) {
      return ok(undefined);
    }

    const id = row['id'];

    return typeof id === 'string' ? ok(id) : err(corruptColumnError('append', 'id'));
  }

  /**
   * Appends one record, refusing anything that would break this module's three
   * invariants.
   *
   * Everything between the validation and the insert runs inside one
   * {@link Store.transaction} — `BEGIN IMMEDIATE`, which takes the write lock
   * before the first read — so the duplicate probe, the file's history, the
   * parent and its existing child are all read in the state the insert then
   * writes into. A second writer racing onto the same parent, from this
   * connection or another process, waits for this commit and is then refused by
   * the same checks; a writer that bypasses them meets the single-child index,
   * whose refusal {@link storeOperationError} reports as the same conflict.
   */
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
      ...(candidate.previousRecordId === undefined
        ? {}
        : { previousRecordId: candidate.previousRecordId }),
    };

    const outcome = attempt(
      'append',
      () =>
        store.transaction((): Result<ModificationRecord> => {
          // A record that is already stored is a duplicate before it is
          // anything else: re-offering it would otherwise also read as a second
          // chain over its own file.
          if (store.statement(SELECT_ID_EXISTS_SQL).get(candidate.id) !== undefined) {
            return err(duplicateRecordError({ operation: 'append', ...context }));
          }

          // Every read below is made inside this transaction, so the history
          // the single-chain checks decide on — and the hash the link is
          // checked against — cannot change between the check and the insert.
          const records = readAll(SELECT_BY_SESSION_AND_FILE_SQL, [
            candidate.sessionId,
            candidate.file,
          ]);

          if (isErr(records)) {
            return records;
          }

          const { previousRecordId } = candidate;

          if (previousRecordId === undefined) {
            const rejection = checkRoot(candidate, {
              records: records.value,
              existingChildId: undefined,
            });

            if (rejection !== undefined) {
              return err(rejection);
            }
          } else {
            const previous = readOne(SELECT_BY_ID_SQL, [previousRecordId]);

            if (isErr(previous)) {
              return previous;
            }

            const child = readFirstChildId(previousRecordId);

            if (isErr(child)) {
              return child;
            }

            const rejection = checkChain(candidate, previousRecordId, previous.value, {
              records: records.value,
              existingChildId: child.value,
            });

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
        reason: outcome.error.details?.['reason'],
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

  /**
   * Validates one corroboration row. The columns are checked individually,
   * because there is no record to parse: a status outside the vocabulary, a
   * blank or non-text file and a non-finite timestamp are each a corrupt
   * column, reported by name and never by value.
   */
  function toCorroboration(
    row: StoredRow,
    operation = 'listCorroborationsBySession',
  ): Result<ModificationCorroboration> {
    const file = row['file'];
    const status = row['status'];
    const appliedAt = toColumnNumber(row['applied_at']);

    if (typeof file !== 'string' || file.trim().length === 0) {
      return err(corruptColumnError(operation, 'file'));
    }

    if (!isModificationStatus(status)) {
      return err(corruptColumnError(operation, 'status'));
    }

    if (typeof appliedAt !== 'number' || !Number.isFinite(appliedAt)) {
      return err(corruptColumnError(operation, 'applied_at'));
    }

    return ok({ file, status, appliedAt });
  }

  function listCorroborationsBySession(
    sessionId: SessionId,
  ): Promise<Result<ModificationCorroboration[]>> {
    return Promise.resolve(
      attempt('listCorroborationsBySession', () => {
        const rows = store.statement(SELECT_CORROBORATIONS_BY_SESSION_SQL).all(sessionId);
        const facts: ModificationCorroboration[] = [];

        for (const row of rows) {
          const fact = toCorroboration(row);

          if (isErr(fact)) {
            return fact;
          }

          facts.push(fact.value);
        }

        return ok(facts);
      }),
    );
  }

  function listPatchEvidenceBySessionFile(
    sessionId: SessionId,
    file: string,
  ): Promise<Result<ModificationPatchEvidence[]>> {
    const operation = 'listPatchEvidenceBySessionFile';

    return Promise.resolve(
      attempt(operation, () => {
        const rows = store
          .statement(SELECT_PATCH_EVIDENCE_BY_SESSION_FILE_SQL)
          .all(sessionId, file);
        const evidence: ModificationPatchEvidence[] = [];

        for (const row of rows) {
          const fact = toCorroboration(row, operation);

          if (isErr(fact)) {
            return fact;
          }

          const diff = row['diff'];

          if (typeof diff !== 'string') {
            return err(corruptColumnError(operation, 'diff'));
          }

          evidence.push({ ...fact.value, diff });
        }

        return ok(evidence);
      }),
    );
  }

  function listPageBySession(
    sessionId: SessionId,
    window: ModificationPageWindow,
  ): Promise<Result<ModificationPage>> {
    const operation = 'listPageBySession';

    return Promise.resolve(
      attempt(
        operation,
        (): Result<ModificationPage> => {
          const { limit, offset } = window;
          const budget = window.maxDiffBytes ?? MODIFICATIONS_PAGE_DIFF_BUDGET;

          if (!isSafeIntegerFrom(limit, 0)) {
            return err(invalidWindowError(operation, 'limit', 'a non-negative integer'));
          }

          if (!isSafeIntegerFrom(offset, 0)) {
            return err(invalidWindowError(operation, 'offset', 'a non-negative integer'));
          }

          if (!isSafeIntegerFrom(budget, MODIFICATION_DIFF_MAX_BYTES)) {
            return err(
              invalidWindowError(
                operation,
                'maxDiffBytes',
                `an integer of at least ${String(MODIFICATION_DIFF_MAX_BYTES)}`,
              ),
            );
          }

          // One transaction, so the measured window, the rows read and the
          // total all describe the same state.
          return store.transaction((): Result<ModificationPage> => {
            const counted = store.statement(COUNT_BY_SESSION_SQL).get(sessionId);
            const total = counted === undefined ? undefined : toColumnNumber(counted['total']);

            if (typeof total !== 'number' || !Number.isSafeInteger(total)) {
              return err(corruptColumnError(operation, 'total'));
            }

            // A count-only request, or a window past the end: no record is read.
            if (limit === 0 || offset >= total) {
              return ok({ records: [], total });
            }

            // Measure before reading: the longest prefix of the window whose
            // diffs fit the budget. Stepped, so the record that ends the page
            // is the last one measured; leaving the loop early resets the
            // statement.
            let kept = 0;
            let used = 0;

            for (const row of store
              .statement(SELECT_PAGE_DIFF_BYTES_SQL)
              .iterate(sessionId, limit, offset)) {
              const bytes = toColumnNumber(row['diff_bytes']);

              if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
                return err(corruptColumnError(operation, 'diff'));
              }

              if (used + bytes > budget) {
                // No journalled diff exceeds the budget on its own, so a first
                // record that does is a row written past validation.
                if (kept === 0) {
                  return err(oversizedDiffError(rowIdOf(row), bytes, budget));
                }

                break;
              }

              kept += 1;
              used += bytes;
            }

            // Read exactly the measured prefix, in the same order.
            const records = readAll(SELECT_PAGE_BY_SESSION_SQL, [sessionId, kept, offset]);

            return isErr(records) ? records : ok({ records: records.value, total });
          });
        },
        { [LOG_BINDING_KEYS.sessionId]: sessionId },
      ),
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
      attempt('latestRecordForFile', () =>
        readOne(SELECT_CHAIN_HEAD_SQL, [sessionId, file, REVERTED_STATUS, REVERTED_STATUS]),
      ),
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
    listPageBySession,
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
    listCorroborationsBySession,
    listPatchEvidenceBySessionFile,
  } satisfies ModificationJournal & ModificationsRepo & ModificationCorroborationReader;
}

/* -------------------------------------------------------------------------------------------------
 * The retention sweep's membership probe
 * ---------------------------------------------------------------------------------------------- */

/**
 * Streams the {@link BackupReference} of every record of one session to
 * `visit`, one row at a time, without materialising them.
 *
 * The retention sweep's membership probe. A backup file sits in the directory
 * of the session whose record it protects, and no other session's record can
 * resolve to it (see {@link BackupReference}), so whether a file in
 * `backups/<sessionId>/` is still referenced is a question about that one
 * session's records. The statement is an index range read on `session_id`
 * that selects three metadata columns, so a probe examines exactly that
 * session's records — however large the rest of the journal — and holds none
 * of them: the sweep compares each row with the bounded batch of files it is
 * judging and keeps only the matches. It is called only for a directory that
 * holds a file old enough to be an orphan, which keeps a start-up with
 * nothing aged free of any journal read.
 *
 * A standalone function over the store rather than a {@link ModificationsRepo}
 * member on purpose: the repository implements the `ModificationJournal` port
 * that `@debuggen/instrumentation` and this service's in-memory journal fakes
 * type-check against, and a retention-only streaming read does not belong in
 * that contract.
 *
 * Synchronous from the first row to the last, so no other statement on this
 * connection can interleave with the scan. `visit` must not use the store.
 *
 * @param store The open, migrated store.
 * @param sessionId The session whose records are read — for the sweep, the
 * name of the backup directory it is judging. A name no session has simply
 * yields no row.
 * @param visit Called once per record; answering `false` stops the scan early
 * (every remaining row is then unread), `true` continues.
 * @returns `ok(rowsVisited)`, or `err` `STORE_ERROR`: a column that does not
 * hold the type the DDL declares (`details.column` names it; nothing more is
 * visited, so a caller discards whatever it gathered) or a statement the store
 * refused. Never throws.
 *
 * @example
 * ```ts
 * const referenced = new Set<string>();
 * const scanned = scanSessionBackupReferences(store, sessionId, (reference) => {
 *   if (candidateNames.has(reference.originalHash)) referenced.add(reference.originalHash);
 *   return referenced.size < candidateNames.size;
 * });
 * ```
 */
export function scanSessionBackupReferences(
  store: Store,
  sessionId: SessionId,
  visit: (reference: BackupReference) => boolean,
): Result<number> {
  const operation = 'scanSessionBackupReferences';

  return attempt(operation, (): Result<number> => {
    let visited = 0;

    for (const row of store.statement(SELECT_SESSION_BACKUP_REFERENCES_SQL).iterate(sessionId)) {
      const backupPath = row['backup_path'];
      const originalHash = row['original_hash'];
      const status = row['status'];

      if (typeof backupPath !== 'string') {
        return err(corruptColumnError(operation, 'backup_path'));
      }

      if (typeof originalHash !== 'string') {
        return err(corruptColumnError(operation, 'original_hash'));
      }

      if (!isModificationStatus(status)) {
        return err(corruptColumnError(operation, 'status'));
      }

      visited += 1;

      if (!visit({ backupPath, originalHash, status })) {
        break;
      }
    }

    return ok(visited);
  });
}
