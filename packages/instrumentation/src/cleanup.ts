/**
 * Cleanup — taking back every byte this product wrote into a developer's
 * project, in reverse order, without ever overwriting an edit they made.
 *
 * `./patch/patcher.ts` is the only module that puts bytes into a working tree.
 * This one is its inverse, and it is where AAP §0.5.1's promise is either kept
 * or broken: *original content and hash recorded before any file edit, every
 * modification tracked and visible, cleanup reliable, and conflicting developer
 * edits detected rather than overwritten*. Four operations, each a different
 * question asked of the same journal:
 *
 * | Operation | Asked by | Question |
 * | --- | --- | --- |
 * | {@link restoreModification} | `installer.ts` unwinding a failed delta | "put this one record's file back" |
 * | {@link restoreChain} | this module, per file | "put a file back through every plan version that touched it" |
 * | {@link cleanupSession} | `apps/local-service/src/cleanup/cleanup.ts` on `session.end` and on editor deactivation | "put this whole session back" |
 * | {@link reconcileModifications} | the same module on service start | "is anything still patched from a session nobody closed?" |
 *
 * ## The sequence, and why its order is not negotiable
 *
 * The patcher's write sequence is: hash the original, build the patched content
 * and hash it, copy the original into the content-addressed backup store,
 * journal the record as `pending` **with both hashes**, replace the file
 * atomically, mark the record `applied`. Restoration runs it backwards, and
 * every step is a precondition for the next:
 *
 * ```text
 * 1. resolve record.file inside projectRoot          (nothing is touched until this holds)
 * 2. the file must currently hash to instrumentedHash (the authority for "this is still ours")
 * 3. read the backup back and check it against originalHash (never write unverified bytes)
 * 4. replace the file only while it is still what step 2 read (a stale target is refused)
 * 5. re-read and hash: the result must equal originalHash
 * 6. mark the record `reverted`
 * 7. and only then delete the backup
 * ```
 *
 * Step 2 is what makes a developer's edit safe: a file that hashes to anything
 * else is **not written**, its backup is **kept**, and the divergence is
 * reported as a {@link ModificationConflict} with a three-way diff. A conflict
 * is therefore a *success* path for this module — the developer's bytes win, the
 * pristine original stays recoverable under `$DEBUGGEN_HOME/backups`, and both
 * user interfaces get something to show. Overwriting would be the only real
 * failure. Step 7 after step 5 is the other half: a backup deleted before the
 * restored content verified would leave a file nobody can prove is original.
 *
 * ## Chains across plan versions (AAP §0.4.2)
 *
 * A follow-up question can produce plan version *n + 1* whose delta patches a
 * file version *n* had already patched. The later record's `originalHash` is
 * the earlier record's `instrumentedHash` and it links the earlier record
 * through `previousRecordId`, so the two backups hold, respectively, the
 * once-patched bytes and the pristine bytes. Unwinding such a chain out of
 * order would write the pristine bytes over the doubly-patched file and leave
 * the later record pointing at content that no longer exists, so
 * {@link restoreChain} restores **strictly last-applied-first**, re-checks the
 * file's hash against *that* record's `instrumentedHash` before each write, and
 * **stops at the first conflict** rather than skipping ahead to an earlier
 * record whose expectation cannot hold any more.
 *
 * ## Start-up reconciliation dispatches on the record, never on the session
 *
 * A session left in `capturing`, `generated` or `failed` still has patched
 * files on disk, so {@link reconcileModifications} walks every record in
 * `OPEN_MODIFICATION_STATUSES` whatever state its session is in, and decides by
 * record status alone. {@link reconcileDispositionFor} is that table, written
 * exhaustively over the status union so a status added to
 * `./schema/modification.ts` cannot be silently ignored here.
 *
 * ## What this module is not
 *
 * **It does not disable runtime hooks.** Cleanup of the browser agent and the
 * dev-server preload is a *message*, not a file operation: the service sends
 * `agent.config` with every hook false (listeners detached, the fetch/XHR patch
 * restored, the fiber hook unsubscribed) and `server-agent.config` with no
 * `captureId` (the pg and Prisma instrumentations disabled and the global
 * tracer provider removed). Those live in `apps/local-service` and
 * `@debuggen/telemetry`; nothing here can reach a socket, and nothing here
 * needs to. This module's scope is exactly file restoration and journal
 * reconciliation, which is why a session can be cleaned up from a cold service
 * start with no page open and no dev server running.
 *
 * **It does not open a database.** The journal arrives as the
 * {@link ModificationJournal} port and the backups as a {@link BackupStore},
 * both injected on the context, so the service's `node:sqlite` repository and a
 * suite's in-memory fake are equally valid collaborators.
 *
 * **It reads no environment variable.** `$DEBUGGEN_HOME` is resolved once by
 * the service and reaches this module only as the backup store's own rooted
 * paths; a backup is located by asking the store for its digest, never by
 * composing a path from strings here.
 *
 * ## Failure policy
 *
 * Expected outcomes are values: a conflict is an `Ok` outcome carrying a report,
 * and a failure that a caller can act on — a path outside the project, a store
 * that will not answer, a filesystem that refuses — is an `Err` carrying a
 * `DebuggenError` with the code that names it (`PATH_OUTSIDE_PROJECT`,
 * `FS_UNSAFE_PATH`, `STORE_ERROR`, `SESSION_NOT_FOUND`, `CLEANUP_PARTIAL`).
 * {@link cleanupSession} and {@link reconcileModifications} never reject and
 * never throw: they aggregate, because a pass over twenty records must not stop
 * at the first unhappy one. Only a broken invariant throws, through
 * `assertNever`. Nothing here writes to the console; every line goes through
 * `context.logger` and carries ids, paths, digests, counts and enumerated
 * reasons — never a byte of a developer's file (AAP §0.5.2).
 *
 * ## Consumers
 *
 * - `apps/local-service/src/cleanup/cleanup.ts` — `session.end`, VS Code
 *   deactivation and the service-start reconciliation, mapping
 *   {@link CleanupOutcome.status} onto the session record's `cleanup.status`
 *   (whose fourth value, `pending`, is its state before a pass has run) and
 *   broadcasting `cleanup.completed { sessionId, status, conflicts }`.
 * - `./installer.ts` — rolling back the records a failed delta install applied,
 *   one {@link restoreModification} per record in reverse.
 * - `src/cleanup.test.ts`, `apps/local-service/test/integration/cleanup-conflict.test.ts`
 *   and `tests/e2e/cleanup.spec.ts` — the unit, integration and end-to-end
 *   proofs of acceptance test 3 (AAP §0.8.4): files byte-identical, no residual
 *   marker in the demo's tracked source, and the demo still serving.
 */

import { realpathSync } from 'node:fs';

import {
  DebuggenError,
  assertNever,
  err,
  isErr,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  resolveRealPathWithinProject,
  resolveWithinProject,
  toPosix,
  tryCatch,
} from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';
import {
  atomicReplaceFile,
  atomicReplaceFileIfUnchanged,
  readFileNoFollow,
  readFileSnapshotNoFollow,
  sha256Hex,
} from '@debuggen/shared/node';
import type {
  AtomicReplaceExpectation,
  AtomicReplaceVerdict,
  FileSnapshot,
} from '@debuggen/shared/node';

import type {
  ModificationConflict,
  ModificationConflictReason,
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
} from './schema/modification.js';
import type { BackupStore } from './patch/backup-store.js';
import { buildConflictReport, detectConflict, isConflictVerdict } from './patch/conflict.js';
import type {
  ConflictDetectionContext,
  ConflictFileReader,
  ConflictVerdict,
} from './patch/conflict.js';

// ---------------------------------------------------------------------------
// The vocabulary a pass reports in.
// ---------------------------------------------------------------------------

/**
 * What happened to one record, as {@link RestoreOutcome.kind}.
 *
 * - `restored` — the backup was written back, the result was verified against
 *   `originalHash`, the record is `reverted`. The only kind that wrote bytes.
 * - `already-original` — the file already held the recorded original, so
 *   nothing was written and the record was closed. This is the "nothing was
 *   written" branch of the reconciliation table: a crash between the journal
 *   append and the rename leaves exactly this state.
 * - `conflict` — no write was authorised. The file and the backup are untouched
 *   and {@link RestoreOutcome.conflict} carries the report.
 * - `skipped` — nothing was attempted: the record was already `reverted`, or the
 *   pass was aborted, or an earlier record in the same chain conflicted and
 *   restoring this one could not be justified.
 *
 * Frozen because it is a module-level table read by consumers that switch over
 * it; a mutation would widen what every reader has to handle.
 */
export const RESTORE_OUTCOME_KINDS = Object.freeze([
  'restored',
  'already-original',
  'conflict',
  'skipped',
] as const);

/** One of {@link RESTORE_OUTCOME_KINDS}. */
export type RestoreOutcomeKind = (typeof RESTORE_OUTCOME_KINDS)[number];

/**
 * What became of the record's backup, as {@link RestoreOutcome.backup}.
 *
 * - `deleted` — the restored content verified against `originalHash` and the
 *   backup was removed, in that order.
 * - `retained` — the backup is still there, deliberately: the record
 *   conflicted, or another open record in the same pass is filed under the same
 *   digest (backups are content-addressed, so two records that saw identical
 *   original bytes share one file), or the caller asked for it to be kept.
 * - `absent` — there was nothing to delete, which is a success: a retried
 *   cleanup pass finds its own earlier work done.
 * - `untouched` — the pass never got as far as the backup.
 */
export const BACKUP_DISPOSITIONS = Object.freeze([
  'deleted',
  'retained',
  'absent',
  'untouched',
] as const);

/** One of {@link BACKUP_DISPOSITIONS}. */
export type BackupDisposition = (typeof BACKUP_DISPOSITIONS)[number];

/**
 * The status a completed pass reports, as {@link CleanupOutcome.status} and
 * {@link ReconcileOutcome.status}.
 *
 * - `clean` — every record in scope is `reverted` and every file in scope holds
 *   its original bytes. A pass with nothing to do is `clean`, which is what
 *   makes a second {@link cleanupSession} call safe and honest.
 * - `partial` — something was restored and something is outstanding.
 * - `conflict` — nothing was restored and something is outstanding.
 *
 * The session record's `cleanup.status` of AAP §0.5.5 adds a fourth value,
 * `pending`, for the state *before* a pass has run; this module never produces
 * it, because a pass that has finished has one of the three answers above.
 */
export const CLEANUP_STATUSES = Object.freeze(['clean', 'partial', 'conflict'] as const);

/** One of {@link CLEANUP_STATUSES}. */
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number];

/**
 * What a pass is allowed to do with a record, decided by the record's status
 * alone.
 *
 * - `restore-or-close` — restore when the file holds our content, and **close
 *   the record without writing** when it already holds the recorded original.
 *   Both are expected for a record that was journaled but whose write may or
 *   may not have landed.
 * - `restore-only` — restore when the file holds our content, and report a
 *   conflict for anything else, including a file that already holds the
 *   original. The write is known to have landed for such a record, so content
 *   that is no longer ours means something outside this product changed it, and
 *   the conservative answer is to tell the developer rather than to close the
 *   record quietly.
 * - `retain` — leave everything exactly as it is, keep the backup, re-report.
 * - `none` — nothing to do, and nothing is read: the record is finished
 *   business.
 */
export const RECONCILE_DISPOSITIONS = Object.freeze([
  'restore-or-close',
  'restore-only',
  'retain',
  'none',
] as const);

/** One of {@link RECONCILE_DISPOSITIONS}. */
export type ReconcileDisposition = (typeof RECONCILE_DISPOSITIONS)[number];

/**
 * The reconciliation table of AAP §0.5.1, as a total function on the record
 * status union.
 *
 * ```text
 * pending | failed   hash === originalHash      → close the record (nothing was written)
 *                    hash === instrumentedHash  → restore from the backup
 *                    otherwise                  → conflict
 * applied            hash === instrumentedHash  → restore from the backup
 *                    otherwise                  → conflict
 * conflict           retained, backup kept, re-reported
 * reverted           nothing to do
 * ```
 *
 * The left column is this function; the hash comparisons are
 * `./patch/conflict.ts`, which owns the restore-versus-conflict decision for
 * the whole product and is consulted rather than repeated. Written as an
 * exhaustive `switch` ending in `assertNever` on purpose: a status added to
 * `./schema/modification.ts` fails to compile here until somebody says what a
 * cleanup pass should do about it, which is the only way a new status cannot be
 * silently treated as "ignore".
 *
 * The same table governs both entry points. `session.end` is not a special
 * case: a session's records are usually all `applied`, but one left `pending`
 * by a crash mid-install gets the three-way branch it needs, and one already
 * `conflict` keeps its backup instead of being restored over the developer's
 * edit.
 *
 * @param status The record's current status.
 * @returns What a pass may do with it.
 */
export function reconcileDispositionFor(status: ModificationStatus): ReconcileDisposition {
  switch (status) {
    case 'pending':
    case 'failed':
      return 'restore-or-close';

    case 'applied':
      return 'restore-only';

    case 'conflict':
      return 'retain';

    case 'reverted':
      return 'none';

    default:
      return assertNever(
        status,
        'A modification status reached cleanup that the reconciliation table of AAP 0.5.1 does not cover. Add the case to reconcileDispositionFor() in packages/instrumentation/src/cleanup.ts.',
      );
  }
}

// ---------------------------------------------------------------------------
// The injection seams.
// ---------------------------------------------------------------------------

/**
 * The filesystem primitives restoration needs, injectable so a suite can fail
 * one of them on demand while the rest of the sequence runs for real.
 *
 * Extends the reader `./patch/conflict.ts` declares — same two members, same
 * byte-fidelity contract, so one object serves the detector and this module —
 * and adds the three operations a restore performs that a detector never does.
 * A {@link PatchFileSystem} from `./patch/patcher.ts` is deliberately *not*
 * reused: it carries the directory-pinning primitive a patch needs and none of
 * these, and the two sets are not the same job.
 */
export interface CleanupFileSystem extends ConflictFileReader {
  /**
   * Canonicalises an absolute path, resolving **every** symbolic link
   * component.
   *
   * The contract is `fs.realpathSync`'s. Containment checked as text cannot see
   * that `src/vendor` is a link to somewhere else entirely, and `O_NOFOLLOW`
   * constrains only the final component — the kernel has already resolved the
   * interior ones before the flag applies. Without this, restoring a record
   * whose interior path component became a link writes a developer's original
   * bytes outside their project (CWE-22).
   *
   * @param absolutePath The path to canonicalise.
   * @returns Its canonical absolute path.
   * @throws The runtime's own filesystem error, with its `code` intact, when
   * the path cannot be resolved — including `ENOENT` for a target whose
   * directory is gone, which this module treats as "the file is missing"
   * rather than as a refusal.
   */
  readonly realPath: (absolutePath: string) => string;

  /**
   * Reads a file's bytes **and** the identity of the inode they came from, from
   * one descriptor, refusing to follow a symbolic link at the final component.
   *
   * The contract is `readFileSnapshotNoFollow`'s. The identity is half the
   * precondition of {@link CleanupFileSystem.replaceFileIfUnchanged} and has to
   * come from the same descriptor as the bytes, or the pair describes an
   * observation that never held.
   *
   * @param absolutePath The file to read.
   * @returns Its bytes and the identity of the file they came from.
   * @throws The runtime's own filesystem error, with its `code` intact.
   */
  readonly readFileSnapshot: (absolutePath: string) => FileSnapshot;

  /**
   * Replaces a file's content atomically **only while it is still what was
   * read**, preserving the mode it already had.
   *
   * The contract is `atomicReplaceFileIfUnchanged`'s. A restore is computed
   * from an observation — "this file hashes to `instrumentedHash`" — and a
   * developer can save the same file between that observation and the write. An
   * unconditional rename would discard their edit with no trace (CWE-367); a
   * conditional one refuses, and the edit is still there to be reported as a
   * conflict. A `stale` verdict is a guarantee that nothing was written.
   *
   * @param absolutePath The file to replace.
   * @param content The bytes to write, verbatim.
   * @param expected What the target must still be for the write to happen.
   * @returns `replaced`, or `stale` with the reason nothing was written.
   * @throws The runtime's own filesystem error, with its `code` intact.
   */
  readonly replaceFileIfUnchanged: (
    absolutePath: string,
    content: Uint8Array,
    expected: AtomicReplaceExpectation,
  ) => AtomicReplaceVerdict;

  /**
   * Writes bytes over a path atomically, creating the file when it is absent,
   * preserving an existing target's mode.
   *
   * The contract is `atomicReplaceFile`'s, and it is used for exactly one case:
   * a target that is **no longer there**. There is no content to make the write
   * conditional on, and a deleted file with an intact backup is recoverable —
   * AAP §0.5.1's guarantee is about the bytes, not about the inode — so the
   * file is recreated from the backup and the outcome says so
   * ({@link RestoreOutcome.recreated}). Every other case goes through
   * {@link CleanupFileSystem.replaceFileIfUnchanged}.
   *
   * @param absolutePath The file to write. Created when absent.
   * @param content The bytes to write, verbatim.
   * @throws The runtime's own filesystem error, with its `code` intact —
   * `ENOENT` when the containing directory is gone too.
   */
  readonly replaceFile: (absolutePath: string, content: Uint8Array) => void;
}

/**
 * The production {@link CleanupFileSystem}: the `@debuggen/shared/node`
 * primitives over `node:fs`'s `realpathSync`.
 *
 * Frozen and shared, because it holds no state. `sha256OfFile` is deliberately
 * not used for the verification read even though it streams: it follows a
 * symbolic link, and the question after a restore is what the bytes *at that
 * path* are, so the same no-follow read that answers it also hashes it.
 */
export const defaultCleanupFileSystem: CleanupFileSystem = Object.freeze({
  readFileBytes: readFileNoFollow,
  hashBytes: sha256Hex,
  realPath: (absolutePath: string): string => realpathSync(absolutePath),
  readFileSnapshot: readFileSnapshotNoFollow,
  replaceFileIfUnchanged: atomicReplaceFileIfUnchanged,
  replaceFile: (absolutePath: string, content: Uint8Array): void => {
    atomicReplaceFile(absolutePath, content);
  },
});

/**
 * Where one record's file lives and where its original is filed: the two things
 * a restore cannot guess.
 *
 * `ModificationRecord.file` is **project-relative**, which is what keeps a
 * developer's directory layout out of panels, prompts and screenshots — and
 * what makes a record meaningless without the root it belongs to. Restoring a
 * record from project A against project B's root would write project A's
 * content into project B, so the root is never inferred from a record, and the
 * backup store is never composed from a path: it is the session's own store,
 * which `./patch/conflict.ts` independently refuses when its session does not
 * match the record's.
 */
export interface RecordScope {
  /** The absolute POSIX path of the project the record's file belongs to. */
  readonly projectRoot: string;

  /** The backup store of the record's own session. */
  readonly backups: BackupStore;
}

/**
 * Resolves the {@link RecordScope} of one record, for a pass that spans
 * sessions.
 *
 * Only {@link reconcileModifications} needs it, and it needs it because
 * `ModificationJournal.listOpen` deliberately returns every open record across
 * **all** sessions while a context carries one project root and one session's
 * backup store. The service holds the missing half — each session's
 * `projectRoot` is a column of its own session row — so it supplies this
 * function; this module refuses to invent it.
 *
 * Returning `err` is the safe answer for a record the caller cannot place: the
 * record is skipped with the failure recorded, and its file is left patched and
 * re-reported on the next start, which is strictly better than restoring it
 * somewhere it does not belong.
 *
 * @param record The record to place.
 * @returns Its scope, or an error explaining why the pass cannot place it.
 */
export type RecordScopeResolver = (
  record: ModificationRecord,
) => Result<RecordScope> | Promise<Result<RecordScope>>;

/**
 * Everything cleanup is allowed to know, and the only way it learns any of it.
 *
 * A deliberate structural **subset** of `InstrumentationContext` (`./adapter.ts`)
 * and a superset of `ConflictDetectionContext` (`./patch/conflict.ts`), so the
 * service's one context object can be passed to an adapter, to the patcher, to
 * the conflict detector and to this module without anybody assembling a second
 * one. The members that appear in all of them carry the same meanings.
 *
 * The code graph, the plan version, the readiness inputs and the session id of
 * the fuller context are all absent here, and that is the point: a session is
 * cleaned up from a cold service start, with no project indexed, no page open
 * and no plan in play. Everything a restore needs is in the journal and on
 * disk.
 */
export interface CleanupContext {
  /**
   * The absolute POSIX path of the developer's project: the root every
   * `record.file` is resolved and contained inside.
   *
   * Used for the records whose session this context belongs to. A pass that
   * spans sessions supplies {@link ReconcileOptions.scopeFor} for the rest.
   */
  readonly projectRoot: string;

  /**
   * The content-addressed backup store holding the originals of the session
   * this context belongs to.
   *
   * Rooted at `<debuggenHome>/backups/<sessionId>`, which is where
   * `$DEBUGGEN_HOME` reaches this module: as the store's own resolved paths,
   * never as an environment variable read here and never as a string this
   * module joins.
   */
  readonly backups: BackupStore;

  /**
   * The journal port. The only place a status transition becomes durable, and
   * the reason this package opens no database.
   */
  readonly journal: ModificationJournal;

  /**
   * Where to log. Ids, paths, digests, counts and enumerated reasons only —
   * never a byte of a developer's file (AAP §0.5.2).
   *
   * Optional here, and required on `InstrumentationContext`, which satisfies
   * this either way. Absent means `noopLogger`.
   */
  readonly logger?: Logger | undefined;

  /**
   * The clock, in epoch milliseconds. Defaults to `nowEpochMs()`.
   *
   * Injected so a suite can assert an exact `detectedAt` or
   * {@link CleanupOutcome.completedAt} without freezing time globally. A
   * reading that is not a finite positive number is refused and the system
   * clock is used instead, with a warning, because the conflict schema requires
   * one and a rejected report far from its cause is the harder bug.
   */
  readonly now?: (() => number) | undefined;

  /**
   * Cancellation, honoured **between** records and never inside a write.
   *
   * A service shutting down mid-pass stops before the next record rather than
   * halfway through one: the remaining records stay open, are reported as
   * skipped, and are picked up by the next reconciliation. Interrupting a
   * rename is the one interruption capable of leaving a half-known state on
   * disk.
   */
  readonly signal?: AbortSignal | undefined;

  /**
   * The filesystem primitives. Defaults to {@link defaultCleanupFileSystem}.
   *
   * Narrower than the optional reader `ConflictDetectionContext` declares —
   * every {@link CleanupFileSystem} is a `ConflictFileReader`, so the same
   * object is forwarded to the detector and both sides see the same bytes and
   * the same digests.
   */
  readonly files?: CleanupFileSystem | undefined;
}

// ---------------------------------------------------------------------------
// What a pass reports back.
// ---------------------------------------------------------------------------

/**
 * What one record's restoration did, or refused to do.
 *
 * Every member is present on every outcome — `undefined` where a kind has no
 * answer rather than absent — so a caller reads one shape whichever branch it
 * came from, and a log line or an assertion never has to know which fields a
 * kind happens to carry.
 */
export interface RestoreOutcome {
  /** Which branch this was. See {@link RESTORE_OUTCOME_KINDS}. */
  readonly kind: RestoreOutcomeKind;

  /**
   * The record as the journal now holds it.
   *
   * The updated row after a status transition, so a caller never re-reads to
   * learn what it now holds; the record as given when nothing was journaled.
   */
  readonly record: ModificationRecord;

  /** The record's project-relative file, echoed for logging and grouping. */
  readonly file: string;

  /**
   * The absolute path the pass resolved, or `undefined` when it stopped before
   * resolving one — a skipped record, or a path refused by the containment
   * gate.
   */
  readonly path: string | undefined;

  /** Whether bytes were written to the project. `true` only for `restored`. */
  readonly wrote: boolean;

  /**
   * Whether the target was missing and was **recreated** from its backup.
   *
   * A deleted, renamed or moved file is not a conflict as long as the recorded
   * original is still readable: the guarantee is about the bytes. It is
   * surfaced so the developer can be told a file reappeared, which is not what
   * they would otherwise expect from a cleanup.
   */
  readonly recreated: boolean;

  /** What became of the backup. See {@link BACKUP_DISPOSITIONS}. */
  readonly backup: BackupDisposition;

  /**
   * The conflict report, when the kind is `conflict`.
   *
   * Carries the reason, both digests, the backup path the developer is pointed
   * at and the three-way diff view. Present for no other kind.
   */
  readonly conflict: ModificationConflict | undefined;

  /** When the pass finished with this record, in epoch milliseconds. */
  readonly completedAt: number;
}

/**
 * A record a pass could not finish, and the error that stopped it.
 *
 * Distinct from a conflict, and the distinction is the developer's: a conflict
 * is an expected outcome with a report to show and a file that is exactly as
 * they left it, while a failure means the pass could not reach an answer — the
 * journal would not accept a transition, a path could not be placed, a
 * filesystem call failed for a reason this module has no opinion about. Both
 * leave the record open for the next pass; only the conflict is worth showing
 * as a conflict.
 *
 * `error` is a live `DebuggenError`, not a JSON payload: this shape is for the
 * service's logs and its retry decision. What crosses the WebSocket in
 * `cleanup.completed` is {@link CleanupOutcome.conflicts}, which is JSON by
 * construction.
 */
export interface CleanupFailure {
  /** The record that could not be finished. */
  readonly recordId: string;

  /** The session that owns it. */
  readonly sessionId: string;

  /** Its project-relative file. */
  readonly file: string;

  /** Why the pass could not finish it. */
  readonly error: DebuggenError;
}

/** Options for {@link restoreModification}. */
export interface RestoreModificationOptions {
  /**
   * Where the record's file and backup live, when it is not the context's own
   * session.
   *
   * Omit it for the ordinary case: the context's `projectRoot` and `backups`
   * are used, and `./patch/conflict.ts` refuses a store that belongs to
   * another session, so a mismatch is reported rather than acted on.
   */
  readonly scope?: RecordScope | undefined;

  /**
   * Whether a file that already holds the recorded original closes the record
   * (`true`) or reports a conflict (`false`, the default).
   *
   * This is the one place the reconciliation table's three-way branch differs
   * from its two-way one, and {@link reconcileDispositionFor} is what chooses:
   * `restore-or-close` passes `true`, `restore-only` leaves it `false`. A
   * caller driving a single record — `./installer.ts` unwinding a delta it just
   * applied — wants the default, because for a record it knows it applied, a
   * file that is no longer ours is news.
   */
  readonly closeWhenTargetIsOriginal?: boolean | undefined;

  /**
   * Keep the backup even after a verified restore.
   *
   * Backups are content-addressed, so two records that saw identical original
   * bytes are filed under the same digest and share one file. A pass that is
   * about to restore a second such record passes `true` for the first and
   * deletes the shared backup once the last holder is done —
   * {@link cleanupSession} and {@link reconcileModifications} do exactly that.
   * The outcome reports `retained` so the deferral is visible.
   */
  readonly retainBackup?: boolean | undefined;

  /**
   * The developer-facing message to put on a conflict report, overriding the
   * wording `./patch/conflict.ts` composes.
   *
   * The service authors it when it knows the developer's context and the
   * recovery action to offer ("Open diff"); omitted, the detector's own wording
   * is used, which already names the file, the divergence and the backup path.
   */
  readonly conflictMessage?: string | undefined;
}

/** Options for {@link restoreChain}. */
export interface RestoreChainOptions {
  /** See {@link RestoreModificationOptions.scope}. Applies to every record. */
  readonly scope?: RecordScope | undefined;

  /** See {@link RestoreModificationOptions.conflictMessage}. */
  readonly conflictMessage?: string | undefined;
}

/**
 * What unwinding one file's chain did.
 *
 * The four lists partition the records the call was given: every record is in
 * exactly one of `restored`, `closed`, `retained` and `skipped`, except that a
 * record which failed appears in `skipped` **and** in `failures` — it was not
 * finished, and the error says why.
 */
export interface ChainRestoreOutcome {
  /** The project-relative file this chain belongs to; `''` for an empty call. */
  readonly file: string;

  /** One outcome per record, in the order they were processed — reverse order. */
  readonly outcomes: RestoreOutcome[];

  /** Records whose backup was written back and verified. */
  readonly restored: ModificationRecord[];

  /** Records closed without a write because the file already held the original. */
  readonly closed: ModificationRecord[];

  /**
   * Records whose file was left exactly as it is: a conflict this walk detected,
   * or a record that arrived in `conflict` and was re-reported.
   */
  readonly retained: ModificationRecord[];

  /** Every conflict report the chain produced, in detection order. */
  readonly conflicts: ModificationConflict[];

  /** Records the chain did not attempt, including everything behind a conflict. */
  readonly skipped: ModificationRecord[];

  /** Records the chain could not finish, with their errors. */
  readonly failures: CleanupFailure[];

  /**
   * The record that stopped the chain, when one did.
   *
   * A conflict or a failure at plan version *n* makes every earlier version's
   * expectation unsatisfiable — the file no longer holds what those records
   * wrote — so the walk halts here instead of skipping ahead, and the earlier
   * records are reported as skipped rather than as conflicts of their own.
   */
  readonly stoppedAt: ModificationRecord | undefined;
}

/** Options for {@link cleanupSession}. */
export interface CleanupSessionOptions {
  /** See {@link RestoreModificationOptions.scope}. Applies to every record. */
  readonly scope?: RecordScope | undefined;

  /** See {@link RestoreModificationOptions.conflictMessage}. */
  readonly conflictMessage?: string | undefined;

  /**
   * Keep the session's backup directory even after a clean pass.
   *
   * By default a pass that restored everything and left no conflict removes the
   * now-empty directory, which is the housekeeping half of "a session never
   * pollutes the developer's working tree": the tree was never touched, and the
   * product's own state directory does not keep growing either. A pass that
   * conflicted never removes it — that copy is what the developer was told
   * about.
   */
  readonly keepBackupDirectory?: boolean | undefined;
}

/**
 * What cleaning up one session did — the value the service maps onto the
 * session record's `cleanup` field and broadcasts as `cleanup.completed`.
 *
 * `status` becomes `cleanup.status` (AAP §0.5.5), whose fourth value `pending`
 * is the state before this pass ran, `conflicts` becomes `cleanup.conflicts`
 * and travels verbatim inside `cleanup.completed { sessionId, status, conflicts }`,
 * and `completedAt` becomes `cleanup.completedAt`.
 */
export interface CleanupOutcome {
  /** The session that was cleaned up. */
  readonly sessionId: string;

  /** The pass's verdict. See {@link CLEANUP_STATUSES}. */
  readonly status: CleanupStatus;

  /**
   * Every record that ended `reverted`: restored from its backup, or closed
   * because the file already held the recorded original.
   *
   * Both mean the same thing to a session — this record is finished and its
   * file holds its original bytes — which is why they share one list here,
   * while {@link ReconcileOutcome} keeps them apart to mirror the two branches
   * of the reconciliation table.
   */
  readonly restored: ModificationRecord[];

  /** Every conflict, in detection order, JSON-ready for `cleanup.completed`. */
  readonly conflicts: ModificationConflict[];

  /** When the pass finished, in epoch milliseconds. */
  readonly completedAt: number;

  /**
   * Records this pass deliberately did not restore: a retained `conflict`
   * record, everything behind a conflict in the same file's chain, everything
   * after an abort, and any record the pass could not finish.
   */
  readonly skipped: ModificationRecord[];

  /** Records the pass could not finish, with their errors. */
  readonly failures: CleanupFailure[];
}

/** Options for {@link reconcileModifications}. */
export interface ReconcileOptions {
  /**
   * How to place a record whose session is not the context's.
   *
   * Required in practice for a service-start pass, which is exactly the pass
   * that meets records from sessions nobody closed. Without it, such a record
   * is skipped with a `SESSION_NOT_FOUND` failure and reported again next
   * start. See {@link RecordScopeResolver}.
   */
  readonly scopeFor?: RecordScopeResolver | undefined;

  /**
   * Restrict the pass to these sessions.
   *
   * For a caller that wants the per-status table applied to one session's open
   * records — a retry after a partial pass, or a test isolating a branch —
   * without narrowing what the journal is asked for.
   */
  readonly sessionIds?: readonly string[] | undefined;

  /** See {@link RestoreModificationOptions.conflictMessage}. */
  readonly conflictMessage?: string | undefined;
}

/**
 * What a service-start reconciliation did, across every session it examined.
 *
 * Unlike {@link CleanupOutcome} this keeps `restored` and `closed` apart,
 * because the two are different branches of the reconciliation table and the
 * difference is diagnostic: a `closed` record is the fingerprint of a crash
 * between the journal append and the rename, and a service that sees many of
 * them is a service that is dying mid-install.
 */
export interface ReconcileOutcome {
  /** The pass's verdict. See {@link CLEANUP_STATUSES}. */
  readonly status: CleanupStatus;

  /** How many open records the journal offered, after any session filter. */
  readonly examined: number;

  /** Records restored from their backups and verified. */
  readonly restored: ModificationRecord[];

  /** Records closed without a write: nothing had been written for them. */
  readonly closed: ModificationRecord[];

  /**
   * Records whose file was left exactly as it is: a conflict detected by this
   * pass, or one carried over from an earlier one and re-reported.
   */
  readonly retained: ModificationRecord[];

  /** Every conflict report, in detection order — the retained ones included. */
  readonly conflicts: ModificationConflict[];

  /** Records the pass did not attempt. */
  readonly skipped: ModificationRecord[];

  /** Records the pass could not finish, with their errors. */
  readonly failures: CleanupFailure[];

  /** When the pass finished, in epoch milliseconds. */
  readonly completedAt: number;
}

// ---------------------------------------------------------------------------
// The public API.
// ---------------------------------------------------------------------------

/**
 * Restores one record's file to the bytes recorded before this product touched
 * it, or refuses and says why.
 *
 * The inverse of one `./patch/patcher.ts` sequence, in the order the module
 * overview sets out: resolve and contain the path, confirm the file still
 * hashes to `instrumentedHash`, read the backup back and check it against
 * `originalHash`, replace the file **only while it is still what was read**,
 * re-read and verify the result against `originalHash`, mark the record
 * `reverted`, and only then delete the backup.
 *
 * ## What it decides, and what it delegates
 *
 * The restore-versus-conflict comparison is `./patch/conflict.ts`'s and is
 * consulted, never repeated: this function reads the verdict and acts. What it
 * adds is the acting — the write, the verification, the journal transition and
 * the backup's disposal — plus two readings of the verdict that only a restorer
 * can make:
 *
 * - **A missing target is not a conflict when the backup is intact.** The
 *   guarantee is about the bytes: a file the developer deleted, renamed or
 *   moved is recreated from its verified backup and the outcome reports
 *   `recreated`.
 * - **A record that is already in `conflict`** is re-reported and nothing is
 *   written, whatever the file now holds: closing a conflict is the developer's
 *   decision, and the report is recomposed from the file as it stands so the
 *   diff they are offered is current.
 * - **A target that already holds the recorded original** is either closed
 *   without a write or reported, depending on
 *   {@link RestoreModificationOptions.closeWhenTargetIsOriginal} — which
 *   {@link reconcileDispositionFor} sets from the record's status, because for
 *   a `pending` record that state means "the write never landed" while for an
 *   `applied` one it means "something outside this product changed the file".
 *
 * ## Conflicts are outcomes, not errors
 *
 * A file that hashes to neither digest, a backup that cannot be read back or
 * does not hash to its own name, a restore whose result does not verify: each
 * returns `ok` with `kind: 'conflict'`, the report in
 * {@link RestoreOutcome.conflict}, **nothing written and the backup kept**. The
 * record is moved to `conflict` so the next service start re-reports it until
 * the developer resolves it. `err` is reserved for the conditions that make the
 * question unanswerable, and each of them also leaves the file and the backup
 * exactly as they were:
 *
 * | Condition | Code |
 * | --- | --- |
 * | `record.file` escapes the project root as text | `PATH_OUTSIDE_PROJECT` |
 * | a symbolic link among its directory components escapes the root, or renames the file inside it | `PATH_OUTSIDE_PROJECT`, `FS_UNSAFE_PATH` |
 * | the backup store belongs to another session | `STORE_ERROR` |
 * | the record cannot be placed in a project at all | `SESSION_NOT_FOUND` |
 * | the journal refused a status transition | `STORE_ERROR` |
 * | a filesystem call failed for a reason this module has no opinion about | `CLEANUP_PARTIAL`, with the errno in `details` |
 *
 * @param record The journal entry to reverse. It is judged on its own terms, so
 * a chained record (`previousRecordId`) is correct here without this function
 * knowing anything about chains — but a *chain* must be unwound by
 * {@link restoreChain}, which orders it.
 * @param context The project root, backup store, journal and optional logger,
 * clock, abort signal and filesystem seam. An `InstrumentationContext`
 * satisfies it and can be passed straight through.
 * @param options The scope for a record from another session, the pristine-file
 * reading, backup retention and the conflict wording.
 * @returns `ok(outcome)` describing what happened, or `err(error)` for one of
 * the conditions above.
 *
 * @example Unwinding a delta install that failed part-way
 * ```ts
 * for (const record of [...applied].reverse()) {
 *   const outcome = await restoreModification(record, context);
 *   if (isErr(outcome)) logger.error('rollback failed', { recordId: record.id });
 *   else if (outcome.value.conflict !== undefined) conflicts.push(outcome.value.conflict);
 * }
 * ```
 */
export async function restoreModification(
  record: ModificationRecord,
  context: CleanupContext,
  options: RestoreModificationOptions = {},
): Promise<Result<RestoreOutcome>> {
  const logger = loggerOf(context);
  const files = filesOf(context);
  const disposition = reconcileDispositionFor(record.status);
  const scope = await scopeOf(record, context, {
    scope: options.scope,
    scopeFor: undefined,
  });

  if (isErr(scope)) {
    return scope;
  }

  return await restoreOne(record, context, {
    scope: scope.value,
    files,
    logger,
    now: clockReading(context, logger),
    disposition,
    closeWhenTargetIsOriginal:
      options.closeWhenTargetIsOriginal ?? disposition === 'restore-or-close',
    retainBackup: options.retainBackup ?? false,
    conflictMessage: options.conflictMessage,
  });
}

/**
 * Orders the records that touch one file into the order they must be restored
 * in: **last applied first**.
 *
 * A follow-up plan version that patches an already-patched file produces a
 * record whose `originalHash` is the previous record's `instrumentedHash` and
 * whose `previousRecordId` names it (AAP §0.4.2), so the records form a chain
 * and the only sound way to unwind it is backwards. Restoring version 1 first
 * would write the pristine bytes over the doubly-patched file, leave version
 * 2's record pointing at content that no longer exists, and — worse — succeed,
 * because the write itself has no way to know it was out of order.
 *
 * The order is total and deterministic even where the links are not:
 *
 * 1. **chain depth**, descending — a record layered on another comes first;
 * 2. **plan version**, descending — the later round of instrumentation first;
 * 3. **`appliedAt`**, descending;
 * 4. **record id**, descending, purely so the result never depends on the
 *    order the journal happened to return.
 *
 * Depth is counted through `previousRecordId` *within the given set*: a link to
 * a record that is not present — an earlier plan version already reverted, for
 * instance — makes this record a root, which is the right reading, because its
 * own `instrumentedHash` is still the authority on the file's current content.
 *
 * A cycle among the links (`A → B → A`) is the one shape this function refuses:
 * reverse order is undefined for it, and guessing would risk a write in the
 * wrong order. The individual record schema catches only a record pointing at
 * itself, because it never sees two records together; this is where the rest is
 * caught, and it is caught **before** anything is read or written.
 *
 * @param records The records that touch one file. An empty array is an empty
 * result.
 * @returns `ok(ordered)` with a new array in restoration order, or `err` with
 * `INTERNAL` when two records share an id or the links form a cycle.
 */
export function orderRestorationChain(
  records: readonly ModificationRecord[],
): Result<ModificationRecord[]> {
  if (records.length === 0) {
    return ok([]);
  }

  const byId = new Map<string, ModificationRecord>();

  for (const record of records) {
    if (byId.has(record.id)) {
      return err(
        new DebuggenError(
          'INTERNAL',
          'A restoration chain was given two records with the same id.',
          {
            hint: 'Group a session’s records by file before ordering them, and pass each record once.',
            details: { reason: 'duplicate-record-id', recordId: record.id, file: record.file },
          },
        ),
      );
    }

    byId.set(record.id, record);
  }

  const depths = new Map<string, number>();

  for (const record of records) {
    const depth = chainDepth(record, byId, depths);

    if (isErr(depth)) {
      return depth;
    }
  }

  const ordered = [...records].sort((left, right) => {
    const byDepth = (depths.get(right.id) ?? 0) - (depths.get(left.id) ?? 0);
    if (byDepth !== 0) {
      return byDepth;
    }

    const byPlanVersion = right.planVersion - left.planVersion;
    if (byPlanVersion !== 0) {
      return byPlanVersion;
    }

    const byAppliedAt = right.appliedAt - left.appliedAt;
    if (byAppliedAt !== 0) {
      return byAppliedAt;
    }

    return right.id.localeCompare(left.id);
  });

  return ok(ordered);
}

/**
 * Unwinds every record that touches **one file**, strictly in reverse order,
 * stopping at the first record that cannot be reverted.
 *
 * Each step re-checks the file against *that* record's `instrumentedHash`
 * before writing *that* record's backup, so a chain is verified link by link
 * rather than assumed: version 2's backup holds the once-patched bytes, and
 * version 1's restore is authorised only once those bytes are what is on disk.
 *
 * **Stopping is the safety property.** A conflict at version *n* means the file
 * is no longer what this product wrote, so every earlier version's expectation
 * is unsatisfiable — skipping ahead could only produce either another refusal
 * or, if the digests happened to line up, a write in the wrong order. The
 * remaining records are reported as skipped, stay open, and are re-examined by
 * the next pass once the developer has resolved the conflict.
 *
 * Never rejects and never throws: every record's fate lands in one of the
 * outcome's lists.
 *
 * @param records The records touching one file, in any order. Records naming
 * different files are refused without a single write, because ordering across
 * files is meaningless and guessing would risk exactly the mis-ordered restore
 * this function exists to prevent — group by file first, as
 * {@link cleanupSession} does.
 * @param context See {@link restoreModification}.
 * @param options The scope for another session's records and the conflict
 * wording.
 * @returns What happened to every record, with the outcomes in the order they
 * were processed.
 */
export async function restoreChain(
  records: readonly ModificationRecord[],
  context: CleanupContext,
  options: RestoreChainOptions = {},
): Promise<ChainRestoreOutcome> {
  const logger = loggerOf(context);
  const ledger = new BackupLedger();

  ledger.register(records);

  const outcome = await restoreFileChain(records, context, {
    logger,
    files: filesOf(context),
    ledger,
    scope: options.scope,
    scopeFor: undefined,
    conflictMessage: options.conflictMessage,
  });

  await ledger.sweep(logger);

  return outcome;
}

/**
 * Reverts everything one session instrumented — the end-of-session guarantee of
 * AAP §0.5.1.
 *
 * Every record of the session that is not already `reverted` is loaded from the
 * journal, grouped by file, and unwound per file in strict reverse order
 * through {@link restoreChain}; the files themselves are taken **latest-touched
 * first**, so a session that instrumented five files unwinds in the reverse of
 * the order it instrumented them. The disposition of each record still comes
 * from {@link reconcileDispositionFor}, so a session that ended mid-install —
 * one record `applied`, the next still `pending`, a third already `conflict` —
 * gets the right reading for each of the three without the caller classifying
 * anything.
 *
 * Called on `session.end`, on editor deactivation (the extension's
 * `deactivate()` ends the active session), and — through
 * {@link reconcileModifications} — on service start, so that a file left
 * patched by a session nobody closed is restored or reported before any client
 * can look at it.
 *
 * ## Idempotent, by construction
 *
 * A second call finds every record `reverted`, has nothing to do, touches no
 * file, writes nothing to the journal and reports `clean`. That is not a
 * special case in the code — a `reverted` record's disposition is `none`, so it
 * is never even read from disk — which is what makes a retried cleanup after a
 * crashed service safe.
 *
 * ## Housekeeping
 *
 * Backups of successfully restored files are deleted only after their restored
 * content verified against `originalHash`, and a backup shared by two records —
 * the store is content-addressed, so records that saw identical original bytes
 * share one file — survives until its last holder is done. A pass that restored
 * everything and left no conflict then removes the session's now-empty backup
 * directory; a pass that conflicted keeps it, because that copy is the one the
 * developer was pointed at.
 *
 * Never rejects and never throws. A journal that will not answer is reported as
 * a failure with no record attributed to it, and the status is `conflict` —
 * nothing could be restored, and something is outstanding.
 *
 * @param sessionId The session to clean up.
 * @param context See {@link restoreModification}. Its `backups` must be this
 * session's store unless {@link CleanupSessionOptions.scope} supplies one.
 * @param options The scope, the conflict wording and the backup-directory
 * reading.
 * @returns The outcome the service maps onto the session's `cleanup` field and
 * broadcasts as `cleanup.completed`.
 */
export async function cleanupSession(
  sessionId: string,
  context: CleanupContext,
  options: CleanupSessionOptions = {},
): Promise<CleanupOutcome> {
  const logger = loggerOf(context).child({ sessionId });
  const restored: ModificationRecord[] = [];
  const conflicts: ModificationConflict[] = [];
  const skipped: ModificationRecord[] = [];
  const failures: CleanupFailure[] = [];

  const listed = await context.journal.listBySession(sessionId);

  if (isErr(listed)) {
    logger.error('cleanup could not read the modification journal', {
      code: listed.error.code,
    });

    return {
      sessionId,
      status: 'conflict',
      restored,
      conflicts,
      completedAt: clockReading(context, logger),
      skipped,
      failures: [{ recordId: '', sessionId, file: '', error: listed.error }],
    };
  }

  const work = listed.value.filter((record) => {
    if (record.sessionId !== sessionId) {
      // A journal that answers with another session's record would have this
      // pass restore a file with a backup store and a project root that do not
      // belong to it. Left untouched and reported, never guessed at.
      logger.warn('the journal returned a record belonging to another session; it was ignored', {
        recordId: record.id,
        recordSessionId: record.sessionId,
      });

      return false;
    }

    return reconcileDispositionFor(record.status) !== 'none';
  });

  const ledger = new BackupLedger();

  ledger.register(work);

  const pass: PassSettings = {
    logger,
    files: filesOf(context),
    ledger,
    scope: options.scope,
    scopeFor: undefined,
    conflictMessage: options.conflictMessage,
  };

  for (const group of groupsInReverseApplicationOrder(work)) {
    const chain = await restoreFileChain(group, context, pass);

    restored.push(...chain.restored, ...chain.closed);
    conflicts.push(...chain.conflicts);
    skipped.push(...chain.retained, ...chain.skipped);
    failures.push(...chain.failures);
  }

  await ledger.sweep(logger);

  const status = statusFor(restored.length, conflicts.length + skipped.length + failures.length);

  if (status === 'clean' && restored.length > 0 && options.keepBackupDirectory !== true) {
    await removeSessionBackups(sessionId, context, options.scope, logger);
  }

  logger.info('session cleanup finished', {
    status,
    restored: restored.length,
    conflicts: conflicts.length,
    skipped: skipped.length,
    failures: failures.length,
  });

  return {
    sessionId,
    status,
    restored,
    conflicts,
    completedAt: clockReading(context, logger),
    skipped,
    failures,
  };
}

/**
 * Reconciles every open record in the journal, whatever state its session is
 * in — the service-start half of AAP §0.5.1.
 *
 * `ModificationJournal.listOpen` returns every record that is not `reverted`,
 * across all sessions, and each is dispatched by **its own status** through
 * {@link reconcileDispositionFor}. Keying off the record rather than the
 * session is the whole point: a session left in `capturing`, `generated`,
 * `failed` or halfway through its own cleanup still has patched files on disk,
 * and a filter by session status is how one of them would be left there.
 *
 * Records are grouped by session and file, and each file's chain is unwound in
 * strict reverse order, so a crash between two plan versions of the same file
 * is reconciled in the only order that can be verified.
 *
 * ## Placing a record
 *
 * A record carries a project-*relative* file and a session id, and nothing
 * else about where it belongs. The context's root and backup store place the
 * records of one session; {@link ReconcileOptions.scopeFor} places the rest,
 * and the service can answer it because each session's `projectRoot` is a
 * column of its own row. A record that cannot be placed is **skipped** with a
 * `SESSION_NOT_FOUND` failure and reported again next start — leaving a file
 * patched is recoverable, while writing one project's content into another is
 * not.
 *
 * Never rejects and never throws.
 *
 * @param context See {@link restoreModification}.
 * @param options The scope resolver, an optional session filter and the
 * conflict wording.
 * @returns What the pass restored, closed, retained, skipped and could not
 * finish.
 */
export async function reconcileModifications(
  context: CleanupContext,
  options: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const logger = loggerOf(context);
  const restored: ModificationRecord[] = [];
  const closed: ModificationRecord[] = [];
  const retained: ModificationRecord[] = [];
  const conflicts: ModificationConflict[] = [];
  const skipped: ModificationRecord[] = [];
  const failures: CleanupFailure[] = [];

  const listed = await context.journal.listOpen();

  if (isErr(listed)) {
    logger.error('reconciliation could not read the modification journal', {
      code: listed.error.code,
    });

    return {
      status: 'conflict',
      examined: 0,
      restored,
      closed,
      retained,
      conflicts,
      skipped,
      failures: [{ recordId: '', sessionId: '', file: '', error: listed.error }],
      completedAt: clockReading(context, logger),
    };
  }

  const wanted =
    options.sessionIds === undefined
      ? listed.value
      : filterBySession(listed.value, new Set(options.sessionIds));

  // A `reverted` record has no business in `listOpen`'s result, but the port is
  // implemented twice and this pass is the one that must not act on a wrong
  // answer, so the disposition table filters rather than trusting the query.
  const work = wanted.filter((record) => reconcileDispositionFor(record.status) !== 'none');
  const ledger = new BackupLedger();

  ledger.register(work);

  const pass: PassSettings = {
    logger,
    files: filesOf(context),
    ledger,
    scope: undefined,
    scopeFor: options.scopeFor,
    conflictMessage: options.conflictMessage,
  };

  for (const group of groupsInReverseApplicationOrder(work, true)) {
    const chain = await restoreFileChain(group, context, pass);

    restored.push(...chain.restored);
    closed.push(...chain.closed);
    retained.push(...chain.retained);
    conflicts.push(...chain.conflicts);
    skipped.push(...chain.skipped);
    failures.push(...chain.failures);
  }

  await ledger.sweep(logger);

  const status = statusFor(
    restored.length + closed.length,
    retained.length + conflicts.length + skipped.length + failures.length,
  );

  logger.info('modification reconciliation finished', {
    status,
    examined: wanted.length,
    restored: restored.length,
    closed: closed.length,
    retained: retained.length,
    conflicts: conflicts.length,
    skipped: skipped.length,
    failures: failures.length,
  });

  return {
    status,
    examined: wanted.length,
    restored,
    closed,
    retained,
    conflicts,
    skipped,
    failures,
    completedAt: clockReading(context, logger),
  };
}

// ---------------------------------------------------------------------------
// One pass, and one record inside it.
//
// The two settings objects below are the difference between a pass and a step:
// a pass holds what every record shares (the logger, the filesystem seam, the
// backup ledger, how to place a record), and a step holds what one record's
// restoration needs (its scope, its clock reading, and what its status
// entitles it to).
// ---------------------------------------------------------------------------

/** What every record of one pass shares. */
interface PassSettings {
  /** Where this pass logs. */
  readonly logger: Logger;

  /** The filesystem primitives, resolved once. */
  readonly files: CleanupFileSystem;

  /** Which backups may be deleted, and when. See {@link BackupLedger}. */
  readonly ledger: BackupLedger;

  /** A scope that applies to every record, when the caller gave one. */
  readonly scope: RecordScope | undefined;

  /** How to place a record whose session is not the context's. */
  readonly scopeFor: RecordScopeResolver | undefined;

  /** The developer-facing conflict wording, when the caller authored one. */
  readonly conflictMessage: string | undefined;
}

/** What restoring one record needs. */
interface RestoreSettings {
  /** Where this record's file and backup live. */
  readonly scope: RecordScope;

  /** The filesystem primitives. */
  readonly files: CleanupFileSystem;

  /** Where this record's steps log. */
  readonly logger: Logger;

  /**
   * The clock reading this record's outcome, conflict report and status
   * transition all carry, taken once so the three cannot disagree.
   */
  readonly now: number;

  /** What the record's status entitles it to. See {@link reconcileDispositionFor}. */
  readonly disposition: ReconcileDisposition;

  /** Whether a file already holding the original closes the record. */
  readonly closeWhenTargetIsOriginal: boolean;

  /** Whether the backup must survive a verified restore. */
  readonly retainBackup: boolean;

  /** The conflict wording override. */
  readonly conflictMessage: string | undefined;
}

/**
 * Unwinds one file's records in reverse order, halting at the first record that
 * cannot be reverted.
 *
 * The body of {@link restoreChain}, and the per-file step of
 * {@link cleanupSession} and {@link reconcileModifications}, which share one
 * {@link BackupLedger} across every file they visit.
 */
async function restoreFileChain(
  records: readonly ModificationRecord[],
  context: CleanupContext,
  pass: PassSettings,
): Promise<ChainRestoreOutcome> {
  const outcomes: RestoreOutcome[] = [];
  const restored: ModificationRecord[] = [];
  const closed: ModificationRecord[] = [];
  const retained: ModificationRecord[] = [];
  const conflicts: ModificationConflict[] = [];
  const skipped: ModificationRecord[] = [];
  const failures: CleanupFailure[] = [];

  const first = records[0];

  if (first === undefined) {
    return {
      file: '',
      outcomes,
      restored,
      closed,
      retained,
      conflicts,
      skipped,
      failures,
      stoppedAt: undefined,
    };
  }

  const file = fileKeyOf(first);
  const foreign = records.filter((record) => fileKeyOf(record) !== file);

  if (foreign.length > 0) {
    // Ordering across files is meaningless, and a guess here is exactly the
    // mis-ordered restore reverse order exists to prevent. Nothing is read.
    for (const record of records) {
      skipped.push(record);
      pass.ledger.pin(record);
    }

    for (const record of foreign) {
      failures.push(failureOf(record, mixedFileChain(file, record)));
    }

    pass.logger.error('a restoration chain named more than one file; nothing was restored', {
      file,
      records: records.length,
      foreign: foreign.length,
    });

    return {
      file,
      outcomes,
      restored,
      closed,
      retained,
      conflicts,
      skipped,
      failures,
      stoppedAt: first,
    };
  }

  const ordered = orderRestorationChain(records);

  if (isErr(ordered)) {
    for (const record of records) {
      skipped.push(record);
      pass.ledger.pin(record);
      failures.push(failureOf(record, ordered.error));
    }

    pass.logger.error('a restoration chain could not be ordered; nothing was restored', {
      file,
      records: records.length,
      code: ordered.error.code,
      reason: detailsReasonOf(ordered.error),
    });

    return {
      file,
      outcomes,
      restored,
      closed,
      retained,
      conflicts,
      skipped,
      failures,
      stoppedAt: first,
    };
  }

  let stoppedAt: ModificationRecord | undefined;

  for (const record of ordered.value) {
    if (stoppedAt !== undefined) {
      // Every earlier plan version expects content the file no longer holds.
      skipped.push(record);
      pass.ledger.pin(record);
      continue;
    }

    if (context.signal?.aborted === true) {
      pass.logger.warn('cleanup was aborted between records; the rest stay open', {
        recordId: record.id,
        file,
      });
      skipped.push(record);
      pass.ledger.pin(record);
      stoppedAt = record;
      continue;
    }

    const scope = await scopeOf(record, context, pass);

    if (isErr(scope)) {
      skipped.push(record);
      pass.ledger.pin(record);
      failures.push(failureOf(record, scope.error));
      stoppedAt = record;
      continue;
    }

    const disposition = reconcileDispositionFor(record.status);
    const result = await restoreOne(record, context, {
      scope: scope.value,
      files: pass.files,
      logger: pass.logger,
      now: clockReading(context, pass.logger),
      disposition,
      closeWhenTargetIsOriginal: disposition === 'restore-or-close',
      retainBackup: pass.ledger.holds(record),
      conflictMessage: pass.conflictMessage,
    });

    if (isErr(result)) {
      skipped.push(record);
      pass.ledger.pin(record);
      failures.push(failureOf(record, result.error));
      stoppedAt = record;
      continue;
    }

    const outcome = result.value;

    outcomes.push(outcome);

    switch (outcome.kind) {
      case 'restored':
        restored.push(outcome.record);
        pass.ledger.release(record, scope.value.backups, outcome.backup === 'retained');
        break;

      case 'already-original':
        closed.push(outcome.record);
        pass.ledger.release(record, scope.value.backups, outcome.backup === 'retained');
        break;

      case 'conflict':
        retained.push(outcome.record);

        if (outcome.conflict !== undefined) {
          conflicts.push(outcome.conflict);
        }

        pass.ledger.pin(record);
        stoppedAt = record;
        break;

      case 'skipped':
        skipped.push(outcome.record);
        pass.ledger.pin(record);
        break;

      default:
        assertNever(
          outcome.kind,
          'A restore outcome reached the chain walker that it does not classify. Add the case in packages/instrumentation/src/cleanup.ts.',
        );
    }
  }

  return {
    file,
    outcomes,
    restored,
    closed,
    retained,
    conflicts,
    skipped,
    failures,
    stoppedAt,
  };
}

/**
 * Restores one record: the sequence of the module overview, with the verdict
 * from `./patch/conflict.ts` choosing the branch.
 *
 * Shared by {@link restoreModification} and {@link restoreFileChain} so that a
 * record restored on its own and a record restored as part of a chain take
 * exactly the same steps in exactly the same order.
 */
async function restoreOne(
  record: ModificationRecord,
  context: CleanupContext,
  settings: RestoreSettings,
): Promise<Result<RestoreOutcome>> {
  if (settings.disposition === 'none') {
    // A reverted record is finished business: nothing is resolved, read or
    // hashed, which is what makes a repeated pass free as well as safe.
    settings.logger.debug('a reverted modification needed no action', {
      recordId: record.id,
      file: record.file,
    });

    return ok(skippedOutcome(record, settings.now));
  }

  const target = resolveTargetPath(record, settings);

  if (isErr(target)) {
    return err(target.error);
  }

  const path = target.value;
  const verdict = await detectConflict(record, conflictContextOf(settings));

  if (isErr(verdict)) {
    return err(verdict.error);
  }

  const judgement = verdict.value;

  if (settings.disposition === 'retain') {
    return await retainRecord(record, judgement, path, context, settings);
  }

  switch (judgement.kind) {
    case 'restorable':
      return await writeRestoration(record, path, false, context, settings);

    case 'file-missing':
      if (judgement.backup.available) {
        // The bytes are what the guarantee is about, and they are still in the
        // backup. Recreated rather than reported.
        settings.logger.warn(
          'an instrumented file is gone; it is being recreated from its backup',
          {
            recordId: record.id,
            sessionId: record.sessionId,
            file: record.file,
          },
        );

        return await writeRestoration(record, path, true, context, settings);
      }

      return await recordConflict(record, judgement.conflict, path, context, settings);

    case 'already-reverted':
      if (settings.closeWhenTargetIsOriginal) {
        return await closeRecord(record, path, context, settings);
      }

      return await reportSynthesizedConflict(
        record,
        path,
        'content-changed',
        judgement.actualHash,
        pristineTargetMessage(record),
        context,
        settings,
      );

    case 'content-changed':
    case 'backup-unavailable':
      return await recordConflict(record, judgement.conflict, path, context, settings);

    default:
      return assertNever(
        judgement,
        'A conflict verdict reached cleanup that it does not handle. Add the case in packages/instrumentation/src/cleanup.ts.',
      );
  }
}

/**
 * Writes one record's backup back over its file, verifies the result and closes
 * the record — steps 3 to 7 of the sequence, in that order and no other.
 *
 * Three refusals live inside it, and each one leaves the developer's bytes
 * exactly where they are:
 *
 * - the backup cannot be read back, or does not hash to the digest it is filed
 *   under, so there are no verified original bytes to write;
 * - the file changed between the verdict and the write, which the conditional
 *   replacement detects and refuses (CWE-367);
 * - the restored content does not hash to `originalHash`, which is the one case
 *   where bytes *were* written and the backup is therefore **kept** rather than
 *   deleted.
 *
 * @param targetMissing Whether the verdict already found the file gone, in
 * which case it is recreated from the backup instead of conditionally
 * replaced. A file that disappears between the verdict and the read is handled
 * the same way, because the race and the steady state are the same situation.
 */
async function writeRestoration(
  record: ModificationRecord,
  path: string,
  targetMissing: boolean,
  context: CleanupContext,
  settings: RestoreSettings,
): Promise<Result<RestoreOutcome>> {
  const { files, logger } = settings;

  const backup = await settings.scope.backups.read(record.originalHash);

  if (isErr(backup)) {
    return await reportSynthesizedConflict(
      record,
      path,
      'backup-missing',
      undefined,
      backupUnreadableMessage(record, detailsReasonOf(backup.error) ?? backup.error.code),
      context,
      settings,
    );
  }

  const originalBytes = backup.value;
  const backupDigest = files.hashBytes(originalBytes);

  if (backupDigest !== record.originalHash) {
    // Writing bytes that do not hash to `originalHash` would replace the
    // developer's file with content nothing has ever verified.
    logger.error('a backup does not hash to the digest it is filed under; nothing was written', {
      recordId: record.id,
      sessionId: record.sessionId,
      file: record.file,
      originalHash: record.originalHash,
      actualHash: backupDigest,
    });

    return await reportSynthesizedConflict(
      record,
      path,
      'backup-missing',
      undefined,
      backupDigestMismatchMessage(record),
      context,
      settings,
    );
  }

  let recreated = targetMissing;

  if (!recreated) {
    const snapshot = tryCatch(() => files.readFileSnapshot(path), 'CLEANUP_PARTIAL');

    if (isErr(snapshot)) {
      if (errnoCodeOf(snapshot.error.cause) === 'ENOENT') {
        recreated = true;
      } else {
        return err(filesystemFailure(record, path, 'read-instrumented-file', snapshot.error));
      }
    } else {
      const currentDigest = files.hashBytes(snapshot.value.bytes);

      if (currentDigest !== record.instrumentedHash) {
        return await reportRaceConflict(record, path, currentDigest, undefined, context, settings);
      }

      const replaced = tryCatch(
        () =>
          files.replaceFileIfUnchanged(path, originalBytes, {
            bytes: snapshot.value.bytes,
            identity: snapshot.value.identity,
          }),
        'CLEANUP_PARTIAL',
      );

      if (isErr(replaced)) {
        return err(filesystemFailure(record, path, 'restore-write', replaced.error));
      }

      if (replaced.value.kind === 'stale') {
        logger.warn('the file changed while it was being restored; nothing was written', {
          recordId: record.id,
          sessionId: record.sessionId,
          file: record.file,
          staleReason: replaced.value.reason,
          ...(replaced.value.retainedAt === undefined
            ? {}
            : { retainedAt: replaced.value.retainedAt }),
        });

        return await reportRaceConflict(
          record,
          path,
          undefined,
          replaced.value.reason,
          context,
          settings,
        );
      }
    }
  }

  if (recreated) {
    const written = tryCatch(() => files.replaceFile(path, originalBytes), 'CLEANUP_PARTIAL');

    if (isErr(written)) {
      if (errnoCodeOf(written.error.cause) === 'ENOENT') {
        // The file's directory is gone too. Recreating the tree is not this
        // product's business, so the record is reported with its backup intact.
        return await reportSynthesizedConflict(
          record,
          path,
          'file-missing',
          undefined,
          missingDirectoryMessage(record),
          context,
          settings,
        );
      }

      return err(filesystemFailure(record, path, 'restore-create', written.error));
    }
  }

  const restoredBytes = tryCatch(() => files.readFileBytes(path), 'CLEANUP_PARTIAL');

  if (isErr(restoredBytes)) {
    // The write landed but its result cannot be read, so the backup must stay:
    // this record is not closed and the next pass judges it again.
    return err(filesystemFailure(record, path, 'verify-restored-file', restoredBytes.error));
  }

  const restoredDigest = files.hashBytes(restoredBytes.value);

  if (restoredDigest !== record.originalHash) {
    logger.error('a restored file does not hash to the recorded original; the backup was kept', {
      recordId: record.id,
      sessionId: record.sessionId,
      file: record.file,
      originalHash: record.originalHash,
      actualHash: restoredDigest,
    });

    return await reportSynthesizedConflict(
      record,
      path,
      'restore-verification-failed',
      restoredDigest,
      verificationFailedMessage(record),
      context,
      settings,
    );
  }

  const marked = await context.journal.updateStatus(record.id, 'reverted', {
    appliedAt: settings.now,
  });

  if (isErr(marked)) {
    // The file is back; only the bookkeeping failed. The backup is deliberately
    // not deleted, so the next pass can still restore from it if it has to.
    return err(journalTransitionFailed(record, 'reverted', marked.error));
  }

  const disposition = await disposeBackup(record, settings, restoredDigest);

  logger.info('a modification was reverted', {
    recordId: record.id,
    sessionId: record.sessionId,
    file: record.file,
    planVersion: record.planVersion,
    recreated,
    backup: disposition,
  });

  return ok({
    kind: 'restored',
    record: marked.value,
    file: record.file,
    path,
    wrote: true,
    recreated,
    backup: disposition,
    conflict: undefined,
    completedAt: settings.now,
  });
}

/**
 * Closes a record whose file already holds the recorded original, without
 * writing a byte.
 *
 * The "nothing was written" branch of the reconciliation table: a crash between
 * the journal append and the atomic rename leaves exactly this state, and the
 * file needs no repair. The backup may be deleted because the hash comparison
 * that got here *is* the verification the deletion requires — the bytes on disk
 * hash to `originalHash`.
 */
async function closeRecord(
  record: ModificationRecord,
  path: string,
  context: CleanupContext,
  settings: RestoreSettings,
): Promise<Result<RestoreOutcome>> {
  const marked = await context.journal.updateStatus(record.id, 'reverted', {
    appliedAt: settings.now,
  });

  if (isErr(marked)) {
    return err(journalTransitionFailed(record, 'reverted', marked.error));
  }

  const disposition = await disposeBackup(record, settings, record.originalHash);

  settings.logger.info('a modification was closed without a write: the file held the original', {
    recordId: record.id,
    sessionId: record.sessionId,
    file: record.file,
    status: record.status,
    backup: disposition,
  });

  return ok({
    kind: 'already-original',
    record: marked.value,
    file: record.file,
    path,
    wrote: false,
    recreated: false,
    backup: disposition,
    conflict: undefined,
    completedAt: settings.now,
  });
}

/**
 * Re-reports a record that is already in conflict, without touching anything.
 *
 * AAP §0.5.1's `conflict` row: retained, backup kept, re-reported on every pass
 * until the developer resolves it. The report is recomposed from the file as it
 * stands now rather than cached, so the diff the developer is offered describes
 * the divergence that exists today; where the file has since come back to
 * either recorded digest, the report says so and the record still stays open,
 * because closing a conflict is the developer's decision and not this module's.
 */
async function retainRecord(
  record: ModificationRecord,
  judgement: ConflictVerdict,
  path: string,
  context: CleanupContext,
  settings: RestoreSettings,
): Promise<Result<RestoreOutcome>> {
  if (isConflictVerdict(judgement)) {
    return await recordConflict(record, judgement.conflict, path, context, settings);
  }

  return await reportSynthesizedConflict(
    record,
    path,
    'content-changed',
    judgement.actualHash,
    retainedConflictMessage(record, judgement.actualHash === record.originalHash),
    context,
    settings,
  );
}

/**
 * Reports a conflict the detector did not compose, for the three situations
 * only a restorer can reach.
 *
 * `'restore-verification-failed'` exists only after a write has been attempted
 * and hashed; a backup that cannot be read back or does not hash to its own
 * name is a `'backup-missing'` this function names with the record id, so the
 * developer has something to search the journal with; and a file that already
 * holds the original is reported as `'content-changed'` where the record's
 * status does not permit closing it. `./patch/conflict.ts` owns the bounding
 * and validation of every report, including these.
 */
async function reportSynthesizedConflict(
  record: ModificationRecord,
  path: string,
  reason: ModificationConflictReason,
  actualHash: string | undefined,
  message: string,
  context: CleanupContext,
  settings: RestoreSettings,
): Promise<Result<RestoreOutcome>> {
  const report = buildConflictReport({
    record,
    reason,
    detectedAt: settings.now,
    message: settings.conflictMessage ?? message,
    ...(actualHash === undefined ? {} : { actualHash }),
  });

  if (isErr(report)) {
    return err(report.error);
  }

  return await recordConflict(record, report.value, path, context, settings);
}

/**
 * Re-asks the detector after a write was refused, so the report describes the
 * file as it is now rather than as it was a moment ago.
 *
 * Reached from two places, both of them races the conditional replacement is
 * there to catch: the file's digest changed between the verdict and the read,
 * or the replacement itself found the target stale. Nothing was written in
 * either case.
 */
async function reportRaceConflict(
  record: ModificationRecord,
  path: string,
  observedHash: string | undefined,
  staleReason: string | undefined,
  context: CleanupContext,
  settings: RestoreSettings,
): Promise<Result<RestoreOutcome>> {
  const second = await detectConflict(record, conflictContextOf(settings));

  if (isErr(second)) {
    return err(second.error);
  }

  if (isConflictVerdict(second.value)) {
    return await recordConflict(record, second.value.conflict, path, context, settings);
  }

  return await reportSynthesizedConflict(
    record,
    path,
    'content-changed',
    observedHash ?? second.value.actualHash,
    concurrentWriteMessage(record, staleReason),
    context,
    settings,
  );
}

/**
 * Moves a record to `conflict` — unless it is already there — and returns the
 * outcome carrying the report.
 *
 * The single place a conflict becomes visible, so every branch above it leaves
 * the same trace: one journal transition, one bounded warning, one report for
 * `cleanup.completed`. A record already in `conflict` is not re-written: its
 * row says what it says, and the point of the pass is to re-report it, not to
 * churn the journal.
 */
async function recordConflict(
  record: ModificationRecord,
  conflict: ModificationConflict,
  path: string,
  context: CleanupContext,
  settings: RestoreSettings,
): Promise<Result<RestoreOutcome>> {
  let current = record;

  if (record.status !== 'conflict') {
    const marked = await context.journal.updateStatus(record.id, 'conflict', {
      appliedAt: settings.now,
    });

    if (isErr(marked)) {
      return err(journalTransitionFailed(record, 'conflict', marked.error));
    }

    current = marked.value;
  }

  settings.logger.warn('a modification was not reverted; the file was left exactly as it is', {
    recordId: record.id,
    sessionId: record.sessionId,
    file: record.file,
    reason: conflict.reason,
    backupPath: record.backupPath,
  });

  return ok({
    kind: 'conflict',
    record: current,
    file: record.file,
    path,
    wrote: false,
    recreated: false,
    backup: 'retained',
    conflict,
    completedAt: settings.now,
  });
}

/**
 * Deletes a record's backup, or explains why it was kept.
 *
 * Called **only** after a restoration has been verified and the record marked
 * `reverted`, and the digest it passes to the store makes that a precondition
 * the store enforces rather than a comment. A backup another record in the same
 * pass is filed under — the store is content-addressed, so records that saw
 * identical original bytes share one file — is retained here and swept by
 * {@link BackupLedger.sweep} once its last holder is done. A delete that fails
 * is a warning, not a failure of the restore: the developer's file is already
 * back.
 */
async function disposeBackup(
  record: ModificationRecord,
  settings: RestoreSettings,
  verifiedHash: string,
): Promise<BackupDisposition> {
  if (settings.retainBackup) {
    settings.logger.debug('a backup was kept: another open record is filed under the same digest', {
      recordId: record.id,
      originalHash: record.originalHash,
    });

    return 'retained';
  }

  const removed = await settings.scope.backups.remove(record.originalHash, {
    restoredContentHash: verifiedHash,
  });

  if (isErr(removed)) {
    settings.logger.warn('the backup of a restored file could not be deleted; it was kept', {
      recordId: record.id,
      originalHash: record.originalHash,
      code: removed.error.code,
      reason: detailsReasonOf(removed.error),
    });

    return 'retained';
  }

  return removed.value ? 'deleted' : 'absent';
}

// ---------------------------------------------------------------------------
// Placing a record: the path, the project and the session.
// ---------------------------------------------------------------------------

/**
 * Resolves a record's project-relative file to the absolute path a restore may
 * write to, or refuses it.
 *
 * Two gates, and the second is the one a string check cannot be:
 *
 * 1. `resolveWithinProject` refuses a traversal, an absolute or drive-letter
 *    form, a backslash and a control character **without touching the
 *    filesystem**, so a hostile path never reaches a syscall. Its code is
 *    `PATH_OUTSIDE_PROJECT`.
 * 2. `resolveRealPathWithinProject` canonicalises the root and the target's
 *    directory — every component of it — and re-checks containment, which is
 *    what catches a `src/vendor` that has become a link to `/etc`: text-level
 *    containment accepts it, and `O_NOFOLLOW` covers only the final component.
 *    A canonical path that lands under a *different* project-relative name is
 *    refused too, with `FS_UNSAFE_PATH`: one file with two names cannot be the
 *    identity a journal row records, and restoring through the alias would
 *    write to a file the record does not describe.
 *
 * A path that cannot be canonicalised at all — the file is gone, or its
 * directory is — is **not** a refusal: the lexical path is returned and the
 * missing-target branch decides what to do, which is how a deleted file is
 * recreated from its backup instead of being reported as unsafe.
 */
function resolveTargetPath(record: ModificationRecord, settings: RestoreSettings): Result<string> {
  const lexical = resolveWithinProject(settings.scope.projectRoot, record.file);

  if (isErr(lexical)) {
    settings.logger.warn('cleanup refused a path that is not inside the project', {
      recordId: record.id,
      sessionId: record.sessionId,
      file: record.file,
      code: lexical.error.code,
      reason: detailsReasonOf(lexical.error),
    });

    return err(lexical.error);
  }

  const canonical = resolveRealPathWithinProject(
    settings.scope.projectRoot,
    record.file,
    settings.files.realPath,
  );

  if (isErr(canonical)) {
    if (detailsReasonOf(canonical.error) === 'path-not-resolvable') {
      return ok(lexical.value);
    }

    settings.logger.warn(
      'cleanup refused a path that leaves the project once symbolic links are resolved',
      {
        recordId: record.id,
        sessionId: record.sessionId,
        file: record.file,
        code: canonical.error.code,
        reason: detailsReasonOf(canonical.error),
      },
    );

    return err(canonical.error);
  }

  const expected = normalizePosix(toPosix(record.file));

  if (canonical.value.relative !== expected) {
    settings.logger.warn('cleanup refused a file reached through a link inside the project', {
      recordId: record.id,
      sessionId: record.sessionId,
      file: record.file,
      canonicalFile: canonical.value.relative,
    });

    return err(aliasedTarget(record, canonical.value.relative));
  }

  return ok(canonical.value.path);
}

/**
 * The context `detectConflict` is asked with, built from one record's settings.
 *
 * Assembled rather than forwarded, because the project root and backup store
 * come from the record's own {@link RecordScope} and not from the context: in a
 * pass that spans sessions those differ per record. The clock is pinned to this
 * record's single reading so the report's `detectedAt`, the status transition's
 * `appliedAt` and the outcome's `completedAt` cannot disagree.
 */
function conflictContextOf(settings: RestoreSettings): ConflictDetectionContext {
  return {
    projectRoot: settings.scope.projectRoot,
    backups: settings.scope.backups,
    logger: settings.logger,
    now: (): number => settings.now,
    files: settings.files,
    ...(settings.conflictMessage === undefined ? {} : { message: settings.conflictMessage }),
  };
}

/**
 * Decides which project and which backup store one record belongs to.
 *
 * An explicit scope wins, then the caller's resolver, then the context's own
 * pair when the record's session matches it. A store that belongs to a
 * different session than the record is refused in every one of those cases:
 * it would compose backup paths under the wrong session directory, report an
 * intact original as missing, and turn a restorable record into a conflict —
 * the one failure mode that makes this module's caution a false alarm.
 */
async function scopeOf(
  record: ModificationRecord,
  context: CleanupContext,
  pass: Pick<PassSettings, 'scope' | 'scopeFor'>,
): Promise<Result<RecordScope>> {
  if (pass.scope !== undefined) {
    return pass.scope.backups.sessionId === record.sessionId
      ? ok(pass.scope)
      : err(scopeSessionMismatch(record, pass.scope.backups.sessionId));
  }

  if (pass.scopeFor !== undefined) {
    const resolved = await pass.scopeFor(record);

    if (isErr(resolved)) {
      return err(resolved.error);
    }

    return resolved.value.backups.sessionId === record.sessionId
      ? ok(resolved.value)
      : err(scopeSessionMismatch(record, resolved.value.backups.sessionId));
  }

  if (context.backups.sessionId === record.sessionId) {
    return ok({ projectRoot: context.projectRoot, backups: context.backups });
  }

  return err(noScopeForSession(record, context.backups.sessionId));
}

// ---------------------------------------------------------------------------
// Ordering: within a file, and across them.
// ---------------------------------------------------------------------------

/**
 * How many `previousRecordId` links separate a record from the root of its
 * chain, within the given set.
 *
 * Iterative and memoised rather than recursive, so a long chain cannot exhaust
 * the stack, and it walks with its own `seen` set so a cycle is detected here —
 * before anything is read or written — instead of looping.
 */
function chainDepth(
  record: ModificationRecord,
  byId: ReadonlyMap<string, ModificationRecord>,
  memo: Map<string, number>,
): Result<number> {
  const pending: ModificationRecord[] = [];
  const seen = new Set<string>();
  let current: ModificationRecord | undefined = record;

  while (current !== undefined && memo.get(current.id) === undefined) {
    if (seen.has(current.id)) {
      return err(chainCycle(current));
    }

    seen.add(current.id);
    pending.push(current);

    const previousId: string | undefined = current.previousRecordId;

    // A link to a record outside the set — an earlier plan version already
    // reverted, for instance — makes this record a root, which is the right
    // reading: its own instrumentedHash is still the authority on the file.
    current = previousId === undefined ? undefined : byId.get(previousId);
  }

  let depth = current === undefined ? -1 : (memo.get(current.id) ?? 0);

  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const ancestor = pending[index];

    depth += 1;

    if (ancestor !== undefined) {
      memo.set(ancestor.id, depth);
    }
  }

  return ok(memo.get(record.id) ?? 0);
}

/**
 * Groups records into the units a chain walk can handle, ordered
 * latest-touched first.
 *
 * Within a group the order is {@link orderRestorationChain}'s; between groups
 * it is the reverse of the order the files were instrumented in — latest
 * `appliedAt` first, then the highest plan version, then the file name so the
 * result never depends on what the journal happened to return. Unwinding in
 * the reverse of the order things were applied is what makes a pass read like
 * an undo rather than like a set of independent repairs.
 *
 * @param records The records to group.
 * @param bySession Whether the session id is part of the grouping key. A
 * service-start pass spans sessions, and two sessions may have instrumented
 * the same project-relative file; grouping those together would order one
 * session's records against another's, which no chain link describes.
 */
function groupsInReverseApplicationOrder(
  records: readonly ModificationRecord[],
  bySession = false,
): ModificationRecord[][] {
  const groups = new Map<string, ModificationRecord[]>();

  for (const record of records) {
    const key = bySession ? `${record.sessionId}\u0000${fileKeyOf(record)}` : fileKeyOf(record);
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, [record]);
    } else {
      existing.push(record);
    }
  }

  return [...groups.values()].sort((left, right) => {
    const byAppliedAt = latestAppliedAt(right) - latestAppliedAt(left);
    if (byAppliedAt !== 0) {
      return byAppliedAt;
    }

    const byPlanVersion = highestPlanVersion(right) - highestPlanVersion(left);
    if (byPlanVersion !== 0) {
      return byPlanVersion;
    }

    return groupKey(left).localeCompare(groupKey(right));
  });
}

/** The latest `appliedAt` in a group; `0` for an empty one. */
function latestAppliedAt(group: readonly ModificationRecord[]): number {
  let latest = 0;

  for (const record of group) {
    if (record.appliedAt > latest) {
      latest = record.appliedAt;
    }
  }

  return latest;
}

/** The highest plan version in a group; `0` for an empty one. */
function highestPlanVersion(group: readonly ModificationRecord[]): number {
  let highest = 0;

  for (const record of group) {
    if (record.planVersion > highest) {
      highest = record.planVersion;
    }
  }

  return highest;
}

/** A group's stable name, for the final ordering tie-break. */
function groupKey(group: readonly ModificationRecord[]): string {
  const first = group[0];

  return first === undefined ? '' : `${first.sessionId}\u0000${fileKeyOf(first)}`;
}

/**
 * A record's file, normalised to the POSIX spelling used as a grouping key.
 *
 * `'./src/a.ts'`, `'src//a.ts'` and `'src/a.ts'` are one file, and grouping
 * them separately would let two records that touch the same bytes be unwound as
 * if they were independent — which is exactly the mis-ordered restore reverse
 * order exists to prevent.
 */
function fileKeyOf(record: ModificationRecord): string {
  return normalizePosix(toPosix(record.file));
}

/** The records of the named sessions, in the order they were given. */
function filterBySession(
  records: readonly ModificationRecord[],
  sessionIds: ReadonlySet<string>,
): ModificationRecord[] {
  return records.filter((record) => sessionIds.has(record.sessionId));
}

/**
 * The verdict of a finished pass.
 *
 * `clean` only when nothing is outstanding, which includes the pass that had
 * nothing to do — the reading that makes a second {@link cleanupSession} call
 * honest. Otherwise `partial` when something was reverted and `conflict` when
 * nothing was: both say "something is still out there", and the difference is
 * whether the pass made progress.
 */
function statusFor(resolved: number, unresolved: number): CleanupStatus {
  if (unresolved === 0) {
    return 'clean';
  }

  return resolved > 0 ? 'partial' : 'conflict';
}

/**
 * Removes a session's backup directory after a clean pass.
 *
 * Only reached when every record was reverted and nothing conflicted, and it
 * touches nothing in the developer's project: the directory is the product's
 * own, under `$DEBUGGEN_HOME/backups`. The store refuses to remove anything it
 * did not create and reports what it retained, which is logged rather than
 * escalated — a leftover file in the product's state directory is housekeeping,
 * not a cleanup failure, and the session's files are already back.
 */
async function removeSessionBackups(
  sessionId: string,
  context: CleanupContext,
  scope: RecordScope | undefined,
  logger: Logger,
): Promise<void> {
  const store =
    scope?.backups.sessionId === sessionId
      ? scope.backups
      : context.backups.sessionId === sessionId
        ? context.backups
        : undefined;

  if (store === undefined) {
    return;
  }

  const removed = await store.removeSessionDirectory();

  if (isErr(removed)) {
    logger.warn('the session backup directory was not removed', {
      code: removed.error.code,
      reason: detailsReasonOf(removed.error),
      directory: store.sessionDirectory,
    });

    return;
  }

  logger.debug('the session backup directory was removed', { deleted: removed.value });
}

// ---------------------------------------------------------------------------
// The backup ledger.
// ---------------------------------------------------------------------------

/**
 * Decides when a backup may be deleted, for a pass that may hold several
 * records filed under the same digest.
 *
 * The backup store is **content-addressed**: a backup's name is the digest of
 * its content, so two records whose files held byte-identical original content
 * — two copies of a small route handler, a file patched by two sessions from
 * the same commit — name one file, and the patcher adopts the existing one
 * rather than writing a second (`StoredBackup.reused`). Deleting it when the
 * first of those records is restored would leave the second with no original to
 * restore from, turning a perfectly reversible edit into a `backup-missing`
 * conflict.
 *
 * So the pass counts holders. A record whose digest still has another holder —
 * or whose digest is pinned, because a record filed under it conflicted or was
 * skipped and its backup is what the developer was pointed at — keeps its
 * backup, and {@link BackupLedger.sweep} deletes it once the last holder has
 * been restored and nothing pinned it. Keys are `(sessionId, originalHash)`
 * pairs, because each session has its own backup directory and two sessions'
 * identical digests are two different files.
 *
 * Private to this module: a caller of {@link restoreChain} gets a ledger built
 * from the records it passed, and {@link cleanupSession} and
 * {@link reconcileModifications} share one across every file they visit.
 */
class BackupLedger {
  /** How many records of this pass are still to be answered for, per digest. */
  private readonly holders = new Map<string, number>();

  /** Digests whose backup this pass must not delete at all. */
  private readonly pinned = new Set<string>();

  /** Digests whose deletion was deferred, with the store that owns them. */
  private readonly deferred = new Map<
    string,
    { readonly store: BackupStore; readonly record: ModificationRecord }
  >();

  /**
   * Counts the records a pass is about to process, and pins the digests of the
   * ones that arrive already in conflict — their backups are retained by
   * definition.
   */
  register(records: readonly ModificationRecord[]): void {
    for (const record of records) {
      const key = ledgerKey(record);

      this.holders.set(key, (this.holders.get(key) ?? 0) + 1);

      if (record.status === 'conflict') {
        this.pinned.add(key);
      }
    }
  }

  /** Whether this record's backup must survive its own restoration. */
  holds(record: ModificationRecord): boolean {
    const key = ledgerKey(record);

    return this.pinned.has(key) || (this.holders.get(key) ?? 0) > 1;
  }

  /**
   * Accounts for a record that was restored or closed.
   *
   * @param deferredDelete Whether its backup was kept, in which case the digest
   * is remembered for {@link BackupLedger.sweep}.
   */
  release(record: ModificationRecord, store: BackupStore, deferredDelete: boolean): void {
    const key = ledgerKey(record);

    this.holders.set(key, Math.max(0, (this.holders.get(key) ?? 0) - 1));

    if (deferredDelete) {
      this.deferred.set(key, { store, record });
    }
  }

  /**
   * Accounts for a record that was not reverted, and forbids the deletion of
   * its digest for the rest of the pass — including a deletion an earlier
   * record had deferred.
   */
  pin(record: ModificationRecord): void {
    const key = ledgerKey(record);

    this.holders.set(key, Math.max(0, (this.holders.get(key) ?? 0) - 1));
    this.pinned.add(key);
    this.deferred.delete(key);
  }

  /**
   * Deletes every deferred backup whose last holder has been restored and whose
   * digest nothing pinned.
   *
   * A failure is logged and left: a retained backup costs a few kilobytes under
   * the product's own state directory, and every file it belongs to is already
   * back.
   */
  async sweep(logger: Logger): Promise<void> {
    for (const [key, entry] of this.deferred) {
      if (this.pinned.has(key) || (this.holders.get(key) ?? 0) > 0) {
        continue;
      }

      const removed = await entry.store.remove(entry.record.originalHash, {
        restoredContentHash: entry.record.originalHash,
      });

      if (isErr(removed)) {
        logger.warn('a shared backup could not be deleted after its last holder was restored', {
          originalHash: entry.record.originalHash,
          code: removed.error.code,
          reason: detailsReasonOf(removed.error),
        });

        continue;
      }

      logger.debug('a shared backup was deleted after its last holder was restored', {
        originalHash: entry.record.originalHash,
        deleted: removed.value,
      });
    }

    this.deferred.clear();
  }
}

/** The ledger's key: one digest inside one session's backup directory. */
function ledgerKey(record: ModificationRecord): string {
  return `${record.sessionId}\u0000${record.originalHash}`;
}

// ---------------------------------------------------------------------------
// Small resolutions the context leaves optional.
// ---------------------------------------------------------------------------

/** The context's logger, or silence. */
function loggerOf(context: CleanupContext): Logger {
  return context.logger ?? noopLogger;
}

/** The context's filesystem seam, or the production one. */
function filesOf(context: CleanupContext): CleanupFileSystem {
  return context.files ?? defaultCleanupFileSystem;
}

/**
 * Reads the clock, refusing a reading a conflict report could not carry.
 *
 * A report's `detectedAt` is validated as a finite positive epoch-millisecond
 * number, so an injected clock returning `0`, `NaN` or a negative number would
 * fail validation far from its cause. Substituting the system clock and saying
 * so keeps the diagnostic next to the mistake — the same reading
 * `./patch/conflict.ts` takes of the same seam.
 */
function clockReading(context: CleanupContext, logger: Logger): number {
  if (context.now === undefined) {
    return nowEpochMs();
  }

  const reading = context.now();

  if (Number.isFinite(reading) && reading > 0) {
    return reading;
  }

  logger.warn('an injected clock returned an unusable reading; using the system clock', {
    reading,
  });

  return nowEpochMs();
}

/** The outcome of a record a pass did not act on. */
function skippedOutcome(record: ModificationRecord, completedAt: number): RestoreOutcome {
  return {
    kind: 'skipped',
    record,
    file: record.file,
    path: undefined,
    wrote: false,
    recreated: false,
    backup: 'untouched',
    conflict: undefined,
    completedAt,
  };
}

/** One record's failure, with the fields a caller groups and logs by. */
function failureOf(record: ModificationRecord, error: DebuggenError): CleanupFailure {
  return {
    recordId: record.id,
    sessionId: record.sessionId,
    file: record.file,
    error,
  };
}

/**
 * The `code` of a caught value, when it carries a string one.
 *
 * Read from the `cause` a `DebuggenError` preserves, which is where the
 * platform's own errno survives `tryCatch`. Written the same way as its
 * counterparts in `./patch/conflict.ts`, `./patch/backup-store.ts` and
 * `@debuggen/shared/node`, because a second, subtly different reading of
 * `error.code` is how one of them starts misclassifying a refusal as a success.
 */
function errnoCodeOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code: unknown = value.code;

    return typeof code === 'string' ? code : undefined;
  }

  return undefined;
}

/**
 * The enumerated `details.reason` an error carries, when it carries one.
 *
 * Every refusal in `@debuggen/shared`'s path module and in this package's
 * backup store documents that vocabulary precisely so a caller can branch on it
 * without parsing a message; this reads it defensively, because `details` is an
 * open record of `unknown` values.
 */
function detailsReasonOf(error: DebuggenError): string | undefined {
  const reason: unknown = error.details?.reason;

  return typeof reason === 'string' ? reason : undefined;
}

// ---------------------------------------------------------------------------
// The failures this module reports.
//
// What goes into a message, a hint or a `details` here: a project-relative
// file, a backup path (the value AAP 0.5.5 shows the developer verbatim), a
// digest, an id, a count, an enumerated reason or an errno. What never does: a
// byte of the content that was read or written, in whole or in part - these
// values are logged, persisted with a session and rendered in two user
// interfaces (AAP 0.5.2).
// ---------------------------------------------------------------------------

/**
 * The error for a chain whose records name different files: code `INTERNAL`.
 *
 * A caller mistake, refused before a single read. Restoring records of
 * different files in one "chain" would order them against each other on
 * `appliedAt` alone, which describes nothing — the links that make reverse
 * order verifiable only exist within a file.
 */
function mixedFileChain(file: string, record: ModificationRecord): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    'A restoration chain was given records that name different files.',
    {
      hint: 'Group the records by file first and call restoreChain() once per file, as cleanupSession() does.',
      details: {
        reason: 'mixed-file-chain',
        recordId: record.id,
        file: record.file,
        chainFile: file,
      },
    },
  );
}

/**
 * The error for a chain whose `previousRecordId` links form a cycle: code
 * `INTERNAL`.
 *
 * Reverse order is undefined for a cycle, and this module's one irreducible
 * requirement is that it restores in reverse order — so the chain is refused
 * with nothing read and nothing written, and every record in it is reported.
 * The record schema catches only a record pointing at itself, because it never
 * sees two records together; this is where the rest is caught.
 */
function chainCycle(record: ModificationRecord): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    'The modification records for one file link to each other in a cycle.',
    {
      hint: 'A follow-up record links the record it is layered on; the links must form a chain, not a loop. Inspect the modifications journal for this file.',
      details: { reason: 'record-chain-cycle', recordId: record.id, file: record.file },
    },
  );
}

/**
 * The error for a file reached through a symbolic link inside the project: code
 * `FS_UNSAFE_PATH`.
 *
 * The path stays inside the project, so it is not an escape, but it resolves to
 * a different project-relative name than the record carries. A record's `file`
 * is an identity — the store's key, the conflict report's field, the editor's
 * navigation target — and a restore through an alias would write to a file the
 * record does not describe.
 */
function aliasedTarget(record: ModificationRecord, canonicalFile: string): DebuggenError {
  return new DebuggenError(
    'FS_UNSAFE_PATH',
    'The instrumented file is reached through a symbolic link inside the project and resolves to a different path.',
    {
      hint: 'Inspect the path by hand. Nothing was written, and the recorded original is still in the backup directory.',
      details: {
        reason: 'aliased-target-path',
        recordId: record.id,
        file: record.file,
        canonicalFile,
      },
    },
  );
}

/**
 * The error for a backup store that belongs to a different session than the
 * record: code `STORE_ERROR`.
 *
 * Refused rather than worked around, for the reason `./patch/conflict.ts`
 * refuses the same mismatch: such a store composes its paths under another
 * session's directory, so every lookup misses, an intact backup is reported as
 * missing, and a restorable record becomes a conflict.
 */
function scopeSessionMismatch(record: ModificationRecord, storeSessionId: string): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The backup store for a modification belongs to a different session than the record.',
    {
      hint: "Resolve each record's scope from its own session: backups are filed per session under $DEBUGGEN_HOME/backups.",
      details: {
        reason: 'backup-store-session-mismatch',
        recordId: record.id,
        recordSessionId: record.sessionId,
        storeSessionId,
      },
    },
  );
}

/**
 * The error for a record a pass cannot place in a project: code
 * `SESSION_NOT_FOUND`.
 *
 * A record carries a project-*relative* file, so restoring it needs the root of
 * the project it belongs to, and that lives on the session row rather than on
 * the record. A pass that meets a record from a session it was not given a
 * scope for skips it and reports this: leaving a file patched is recoverable on
 * the next start, while writing one project's content into another is not.
 */
function noScopeForSession(record: ModificationRecord, contextSessionId: string): DebuggenError {
  return new DebuggenError(
    'SESSION_NOT_FOUND',
    'A modification belongs to a session this cleanup pass cannot place in a project.',
    {
      hint: "Pass scopeFor to reconcileModifications() so every session's project root and backup store can be resolved.",
      details: {
        reason: 'no-scope-for-session',
        recordId: record.id,
        recordSessionId: record.sessionId,
        contextSessionId,
      },
    },
  );
}

/**
 * The error for a journal that refused a status transition: code
 * `STORE_ERROR`, with the store's own error as the cause.
 *
 * Raised after the filesystem work of that step has already happened or been
 * refused, which is why it names the transition: a `'reverted'` failure means
 * the file *is* back and only the bookkeeping is behind — the backup is kept
 * and the next pass judges the record again — while a `'conflict'` failure
 * means the report could not be recorded, and the record stays in its previous
 * status to be re-detected.
 */
function journalTransitionFailed(
  record: ModificationRecord,
  status: ModificationStatus,
  cause: DebuggenError,
): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The modification journal refused a status transition during cleanup.',
    {
      hint: 'The file on disk is unchanged by this failure and the backup was kept; the record stays open and is reconciled on the next service start.',
      details: {
        reason: 'journal-transition-failed',
        recordId: record.id,
        sessionId: record.sessionId,
        file: record.file,
        status,
        cause: cause.code,
      },
      cause,
    },
  );
}

/**
 * The error for a filesystem call that failed for a reason this module has no
 * opinion about: code `CLEANUP_PARTIAL`, with the errno in `details`.
 *
 * `CLEANUP_PARTIAL` rather than `INTERNAL` because it says what a user
 * interface needs to say: this cleanup did not finish, and the session's
 * `cleanup.status` is not `clean`. The step is named so the log line
 * distinguishes a failed read from a failed write from a failed verification —
 * three very different situations for the file on disk.
 */
function filesystemFailure(
  record: ModificationRecord,
  path: string,
  step: string,
  cause: DebuggenError,
): DebuggenError {
  return new DebuggenError(
    'CLEANUP_PARTIAL',
    'A filesystem operation failed while a modification was being reverted.',
    {
      hint: 'The recorded original is still in the backup directory; resolve the filesystem condition and the next service start reconciles the record.',
      details: {
        reason: 'filesystem-failure',
        step,
        recordId: record.id,
        sessionId: record.sessionId,
        file: record.file,
        path,
        errno: errnoCodeOf(cause.cause) ?? cause.code,
      },
      cause,
    },
  );
}

// ---------------------------------------------------------------------------
// The developer-facing wording.
//
// Every message names the file, what was observed and where the original is,
// in the voice of AAP 0.5.5: "<file> was edited while instrumented. Debug
// Generator will not overwrite it. Original saved at <backup path>." The
// detector composes that one; these cover the situations only a restore
// reaches. A caller with more context - the service, which knows the session
// and the action to offer - overrides them through `conflictMessage`.
// ---------------------------------------------------------------------------

/** A file that already holds the recorded original, for a record that was applied. */
function pristineTargetMessage(record: ModificationRecord): string {
  return `${record.file} no longer holds the instrumented content: it currently matches the original Debug Generator recorded, so no content was lost, but the change did not come from this tool. The record is kept open and the original stays at ${record.backupPath}.`;
}

/** A backup that could not be read back. */
function backupUnreadableMessage(record: ModificationRecord, reason: string): string {
  return `${record.file} is still instrumented, but the original recorded for it could not be read back from ${record.backupPath} (${reason}). Nothing was written. Restore the file from version control, or remove the instrumentation by hand; the modification record is ${record.id}.`;
}

/** A backup whose content does not hash to the digest it is filed under. */
function backupDigestMismatchMessage(record: ModificationRecord): string {
  return `${record.file} is still instrumented, but the backup at ${record.backupPath} does not match the digest it was filed under, so it cannot be trusted as the original. Nothing was written and the backup was kept; the modification record is ${record.id}.`;
}

/** A restore that wrote bytes whose digest is not the recorded original. */
function verificationFailedMessage(record: ModificationRecord): string {
  return `${record.file} was written from its recorded original, but the result does not match the digest Debug Generator recorded. The backup at ${record.backupPath} was kept so the file can be restored by hand; the modification record is ${record.id}.`;
}

/** A missing file whose directory is missing too. */
function missingDirectoryMessage(record: ModificationRecord): string {
  return `${record.file} and the directory containing it are gone, so Debug Generator did not recreate it. The original is still at ${record.backupPath}; the modification record is ${record.id}.`;
}

/** A file written by something else between the verdict and the restore. */
function concurrentWriteMessage(
  record: ModificationRecord,
  staleReason: string | undefined,
): string {
  const observed =
    staleReason === undefined
      ? 'while it was being restored'
      : `while it was being restored (${staleReason})`;

  return `${record.file} changed ${observed}, so Debug Generator will not overwrite it. Nothing was written and the original is still at ${record.backupPath}.`;
}

/** A conflict carried over from an earlier pass. */
function retainedConflictMessage(record: ModificationRecord, matchesOriginal: boolean): string {
  const state = matchesOriginal
    ? 'the file now matches the original Debug Generator recorded'
    : 'the file now matches the instrumented content Debug Generator wrote';

  return `${record.file} has an unresolved conflict, so Debug Generator left it alone: ${state}. Resolve the conflict to close the record; the original is at ${record.backupPath}.`;
}
