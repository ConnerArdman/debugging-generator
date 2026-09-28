/**
 * Cleanup — taking back every byte this product wrote into a developer's
 * project, in reverse order, without ever overwriting an edit they made.
 *
 * `./patch/patcher.ts` is the only module that puts bytes into a working tree.
 * This one is its inverse, and it is where the reversibility promise is either
 * kept or broken: *original content and hash recorded before any file edit,
 * every modification tracked and visible, cleanup reliable, and conflicting
 * developer edits detected rather than overwritten*. Four operations, each a
 * different question asked of the same journal:
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
 * ## A conflict is judged again on every pass
 *
 * A record's `conflict` status says what its file held when the divergence was
 * seen — by the live watcher, or by an earlier pass — not what it holds now,
 * so a record already in `conflict` goes through step 2 exactly like every
 * other record (AAP §0.5.1: "a file whose current hash equals
 * `instrumentedHash` is restored from the backup; a file that differs is left
 * untouched"):
 *
 * ```text
 * file hashes to instrumentedHash again  → restored from the backup (the developer undid their edit)
 * file hashes to originalHash            → closed without a write (nothing is left to restore)
 * file holds anything else               → left exactly as it is, backup kept, report renewed
 * ```
 *
 * Only the third line keeps the record in `conflict`, and only it keeps the
 * backup: a conflict backup survives for exactly as long as the divergence it
 * was kept for. For a chained record the second line reaches further down the
 * chain — see the chain close below — which is how a conflict closes once the
 * developer puts back the pristine file the chain root recorded.
 *
 * ## Chains across plan versions
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
 * Only the chain root — the root-most live record the links reach — backed up
 * the pristine file; every later link's backup holds an earlier plan version's
 * instrumented output, which still carries the tool's wrapper. So every
 * conflict a chained record produces names the root's backup as the report's
 * `originalBackupPath` — the path "Original saved at ‹path›" quotes — and its
 * diff views start from the root's verified backup: the walk resolves each
 * record's root with `findChainRoot` over the file's live records and hands it
 * to `./patch/conflict.ts` with every verdict and report it asks for. The
 * root's backup is kept for as long as the chain is open, because the root is
 * retained, never reverted, while a record above it conflicts.
 *
 * ### The chain beneath a conflict
 *
 * A walk that stops at a conflict says nothing yet about the records beneath
 * the one it judged, and leaving them in their status would be a claim: an
 * `applied` record says the tool's bytes are on disk, and the patcher treats
 * exactly that claim as another session holding the file. So when the
 * judged record's report proves the file holds none of the chain's output,
 * the rest of the chain goes into `conflict` with it:
 *
 * ```text
 * judged record → conflict, reason content-changed | file-missing
 * the file's digest is no record's instrumentedHash (the judged one included),
 * or there is no file at all
 *   → every open record beneath it in the chain moves to `conflict`
 *     (applied | pending | failed → conflict; a record already in `conflict`
 *     stays there), keeps its backup and is reported as retained
 * ```
 *
 * No further report is composed for them: the judged record's report already
 * covers the file and names the root's backup as `originalBackupPath`. The
 * rule does not apply when the walk stopped for any other reason — an unusable
 * backup, a failed verification, a refused fork, a scope or journal failure,
 * an abort — because none of those proves what the file no longer holds; the
 * records beneath are then `skipped` with their status untouched, as they are
 * after a journal that refuses one of the transitions above. Every later pass
 * judges the chain again, and a `conflict` status serves both ways out of it:
 * the chain close below settles the whole chain once the file is put back to
 * an earlier original, and a file whose edit was undone is restored link by
 * link, because a record in `conflict` is restored the moment its file
 * hashes to its `instrumentedHash`.
 *
 * ### The chain close
 *
 * Stopping at a conflict must not mean stopping forever. Once the developer
 * resolves an edited chain by putting back an earlier version of the file —
 * typically the pristine file from version control, which is the chain root's
 * original — the head's own two digests no longer describe anything on disk,
 * and judging it alone would re-report it on every pass while the records
 * beneath it stay open. So the walk reads the head's verdict one level deeper:
 *
 * ```text
 * head status pending | failed | conflict            (a status that closes over a pristine file)
 * head verdict content-changed, file hash === originalHash of a record R beneath it
 * every link head → … → R hash-consistent            (child.previousRecordId === parent.id,
 *                                                     child.originalHash === parent.instrumentedHash)
 *   → close the head and every record down to and including R without a write
 *     (each → reverted), then continue the walk with the record beneath R
 * ```
 *
 * The file then holds the bytes from before R, so nothing any of those
 * records wrote is on disk to restore or to lose, and the record beneath R —
 * whose output those bytes are — is restorable as usual. R's backup is deleted
 * as verified, because the file hashes to its `originalHash`; the backups of
 * the superseded records above it are not, because their digests are not on
 * disk, and they leave with the session's backup directory once a pass leaves
 * the session clean. An `applied` head is excluded exactly as the per-record
 * table excludes it from closing over a pristine file: content that is not its
 * own is reported as a conflict first, and the next pass closes the chain.
 *
 * Reverse order only exists for a **single linear chain**. The service's
 * journal refuses to append a second record onto one parent or a second open
 * chain over one file, but a journal written before it did — or by a writer
 * that bypassed it — can hold a *fork*: two open records naming the same
 * `previousRecordId`, or more than one open record starting a chain for the
 * same file. Each branch then claims to describe the bytes on disk, and
 * restoring one would write its backup over the other's patch or strand it.
 * So every per-file walk checks the shape of the file's open records
 * **before anything is read or written**, and a forked file is refused whole:
 * nothing is written, every backup is kept, every involved record is reported
 * as a conflict (and moved to `conflict`, so the next pass keeps retaining it),
 * and the refusal is reported as a {@link ChainFork} whose reason is
 * {@link RECORD_CHAIN_FORK_REASON}. The other files of the same pass are
 * restored as usual.
 *
 * ## Another session's bytes are never this session's to restore
 *
 * A digest cannot tell identical bytes apart, and the transform is
 * deterministic. A session whose chain ended in a conflict leaves its records
 * in `conflict`; once the developer puts the pristine file back, the next
 * session over the same file reproduces the old chain's output byte for byte.
 * Judged on the digest alone, the old chain's head is then `restorable`, and a
 * pass over the old session — a repeated end, or a start-up reconciliation
 * that reaches its records first — would write its backups over the new
 * session's live patch and leave the new session reporting an edit nobody
 * made. So before a `restorable` verdict becomes a write, the pass asks
 * whether the bytes on disk are another session's live claim:
 *
 * ```text
 * another session's record Q, same normalised file
 *   status applied | pending | failed               (the patcher's holding set; never conflict or reverted)
 *   Q.instrumentedHash === the digest the verdict read
 *   the judged record R is in conflict, or Q.appliedAt >= R.appliedAt
 *   Q placed at the same canonical file as R         (its project root, from the pass's resolver)
 *
 * pristine original of Q's chain === pristine original of R's chain
 *   → R and every open record beneath it in its chain are closed without a write
 *     (each → reverted, reported as closed, no verified backup deletion queued)
 * a different pristine original, or a Q the pass cannot place
 *   → nothing is written: R and everything beneath it stay open, pinned and skipped,
 *     with the refusal recorded as a failure
 * ```
 *
 * The pristine original of a chain is its root's `originalHash` — the root
 * {@link findChainRoot} resolves among the session's live records — or the
 * record's own for an unchained record. When the two originals agree, the
 * other session's own cleanup restores exactly the bytes this chain would
 * have, so nothing of this chain is left to restore or to lose; its backups
 * leave with the session's backup directory once a pass leaves it clean.
 *
 * Three parts of the rule are load-bearing:
 *
 * - **Only a holding status claims bytes.** Another session's record in
 *   `conflict` is never deferred to — its file held the developer's edit when
 *   it was judged — so the new session's own end restores normally while the
 *   old chain sits in `conflict`. A session never defers to itself.
 * - **A live record yields only to a claim that is not older than it.** Two
 *   sessions' holding records over one file with identical bytes exist only
 *   when one of them went stale — the patcher refuses to patch a file another
 *   session holds — and the later writer is the one whose bytes are on disk.
 *   So a record that is itself `applied`, `pending` or `failed` treats another
 *   session's claim as live only when that claim was journaled at or after its
 *   own; a record already in `conflict` claims nothing and yields to any.
 * - **A claim counts only in the same project.** Records carry
 *   project-relative paths, and two copies of one project instrumented alike
 *   hold identical bytes under identical paths. Closing this session's records
 *   because of a copy elsewhere would leave its own project instrumented with
 *   the journal saying otherwise, so the claim's project root is resolved —
 *   through {@link ReconcileOptions.scopeFor} or
 *   {@link CleanupContext.projectRootOf} — and compared as canonical paths. A
 *   claim in another project is not a claim on this file. A claim the pass
 *   cannot place proves nothing either way, so it is refused: never written
 *   over and never closed beside.
 *
 * The other sessions' open records come from one `ModificationJournal.listOpen`
 * per pass, read lazily at the first `restorable` verdict (a pass that writes
 * nothing never asks) and kept current as the pass's own walks move records.
 * A listing that fails refuses every write that needed it — a failure is
 * recorded and nothing is written blind. A `file-missing` verdict carries no
 * digest, so no bytes on disk can be anyone's claim and it is recreated as
 * before. The rule changes no verdict: every other branch — the chain close,
 * the chain beneath a conflict, the fork refusal, scope, abort and the backup
 * ledger — reads exactly as described above.
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
 * paths. A backup is read and deleted by handing the store the record's
 * journaled `backupPath` with its digest — the journal may have been updated to
 * say where a backup was moved — and the store alone decides whether that path
 * is one it may act on — a relocation only inside the record's own session
 * directory, under the record's digest — so no path is ever composed from
 * strings here and no journal string reaches a filesystem call outside that
 * session's own backup directory.
 *
 * **It never creates a file over one it did not observe.** A target that was
 * gone is recreated with a no-clobber create that fails if anything appeared at
 * the path in the meantime, and that race is reported as a conflict with the
 * backup retained rather than resolved by overwriting what the developer wrote.
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
 * reasons — never a byte of a developer's file.
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
 *   proofs of the cleanup guarantee: files byte-identical, no residual marker
 *   in the demo's tracked source, and the demo still serving.
 */

import { realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';

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
  atomicCreateFileNoClobber,
  atomicReplaceFileIfUnchanged,
  readFileNoFollow,
  readFileSnapshotNoFollow,
  sha256Hex,
} from '@debuggen/shared/node';
import type {
  AtomicCreateVerdict,
  AtomicReplaceExpectation,
  AtomicReplaceVerdict,
  FileSnapshot,
} from '@debuggen/shared/node';

import { findChainRoot } from './schema/modification.js';
import type {
  ModificationConflict,
  ModificationConflictReason,
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
} from './schema/modification.js';
import type {
  BackupStore,
  BackupStoreFailureReason,
  RecordedBackup,
} from './patch/backup-store.js';
import {
  buildConflictReport,
  detectConflict,
  isConflictVerdict,
  isUsableChainRoot,
} from './patch/conflict.js';
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
 *   append and the rename leaves exactly this state. A chain close reports
 *   each record it settles the same way — the file holds content from before
 *   the record, which is its original or older — and so does a close beside
 *   another session's live claim on the same bytes, whose own cleanup
 *   restores the original this record's chain recorded.
 * - `conflict` — no write was authorised. The file and the backup are untouched
 *   and {@link RestoreOutcome.conflict} carries the report.
 * - `skipped` — nothing was attempted: the record was already `reverted`, or the
 *   pass was aborted, or a later plan version of the same chain stopped the
 *   walk and restoring this one could not be justified.
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
 *   original bytes share one file), or the caller asked for it to be kept, or
 *   the record was a superseded layer of a chain close, or was closed beside
 *   another session's live claim, whose `originalHash` is not on disk to
 *   verify a deletion against — that backup leaves with the session's backup
 *   directory.
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
 *   its original bytes: no conflict is outstanding, no record was left open and
 *   nothing failed. A pass with nothing to do is `clean`, which is what makes a
 *   second {@link cleanupSession} call safe and honest.
 * - `conflict` — at least one conflict is outstanding: the pass produced or
 *   renewed a conflict report, refused a file whose records do not form one
 *   chain, or left open a record whose status is `conflict`. A file was edited
 *   (or otherwise diverged) while instrumented, the tool refused to overwrite
 *   it, and its original stays in the backup directory: the record becomes
 *   `conflict`, cleanup leaves the file, and `cleanup.status` becomes
 *   `conflict`.
 * - `partial` — something is outstanding and none of it is a conflict: a record
 *   the pass could not attempt or could not finish (a failure, an abort, a
 *   record it could not place), which a later pass can settle.
 *
 * The verdict describes the state a pass leaves behind, never the work it did:
 * whether this pass restored something beside a conflict does not change the
 * answer, so a second pass over identical state reports exactly what the first
 * one did.
 *
 * The session record's `cleanup.status` adds a fourth value, `pending`, for
 * the state *before* a pass has run; this module never produces it, because a
 * pass that has finished has one of the three answers above.
 */
export const CLEANUP_STATUSES = Object.freeze(['clean', 'partial', 'conflict'] as const);

/** One of {@link CLEANUP_STATUSES}. */
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number];

/**
 * The stable reason of a {@link ChainFork}: one file's open records do not form
 * a single chain, so no reverse order exists and nothing was written.
 *
 * A member of `MODIFICATION_CONFLICT_REASONS` (`./schema/modification.ts`) —
 * checked here with `satisfies` — so the same spelling reaches every conflict
 * report of a refused fork, `cleanup.completed` and both user interfaces, and it
 * matches the `details.reason` vocabulary of this module's errors
 * (`record-chain-cycle` is its sibling), so a caller that logs or branches on
 * reasons reads all of them the same way.
 */
export const RECORD_CHAIN_FORK_REASON = 'record-chain-fork' satisfies ModificationConflictReason;

/**
 * One file a pass refused to restore because its open records do not form a
 * single linear chain.
 *
 * Two shapes produce one, and a single file can show both:
 *
 * - **a shared parent** — two or more records name the same
 *   `previousRecordId`, so each claims to continue from the same bytes;
 * - **more than one root** — two or more records start a chain within the
 *   file's open records (no `previousRecordId`, or one naming a record that is
 *   no longer open), so two chains each claim the file.
 *
 * Every involved record also appears as a conflict in the pass's `conflicts`,
 * which is what both user interfaces render; this report is the structured,
 * machine-readable account of why, for the service's logs and for a caller
 * that wants to tell a fork from an ordinary edit. Identifiers only — never a
 * digest, a backup path or a byte of the file.
 */
export interface ChainFork {
  /** Always {@link RECORD_CHAIN_FORK_REASON}. */
  readonly reason: typeof RECORD_CHAIN_FORK_REASON;

  /** The session that owns the records. */
  readonly sessionId: string;

  /** The project-relative file, normalised as the pass groups it. */
  readonly file: string;

  /** Every open record of the file, in the order a restore would have taken them. */
  readonly recordIds: string[];

  /** The previous records named by more than one of them, sorted; empty when there are none. */
  readonly sharedPreviousRecordIds: string[];

  /** The records that start a chain within the set, sorted; one entry for a linear chain. */
  readonly rootRecordIds: string[];
}

/**
 * The reason on the conflict report of each record of a refused fork:
 * {@link RECORD_CHAIN_FORK_REASON}, never `'content-changed'` — the file may
 * be exactly as this product left it, and telling the developer it was edited
 * would send them looking for an edit that never happened. Each report's
 * message says which fork shape was found.
 */
const CHAIN_FORK_CONFLICT_REASON: ModificationConflictReason = RECORD_CHAIN_FORK_REASON;

/**
 * Why nothing was written over a target that had been observed missing: the
 * no-clobber create found something at the path, because a developer (or a
 * tool acting for them) recreated the file between the observation and the
 * write.
 *
 * The counterpart of the conditional replacement's `target-missing` stale
 * reason, in the same kebab-case vocabulary, so the logs and the conflict
 * message name the race the same way whichever write refused.
 */
const TARGET_APPEARED = 'target-appeared';

/**
 * The backup store's `details.reason` for a stored backup whose bytes do not
 * hash to the digest it is filed under (`./patch/backup-store.ts`).
 *
 * Checked with `satisfies` against the store's own vocabulary, so a rename there
 * fails to compile here instead of silently reporting a corrupt backup as a
 * missing one.
 */
const STORED_DIGEST_MISMATCH = 'stored-digest-mismatch' satisfies BackupStoreFailureReason;

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
 * - `retain` — the record is already in `conflict`, so it is judged again
 *   rather than assumed: restored when the file holds our content once more
 *   (the developer undid their edit), closed without a write when it holds the
 *   recorded original, and otherwise left exactly as it is with its backup
 *   kept and its report renewed. The record was reported once already, so a
 *   file back at the original has nothing left to lose or to report.
 * - `none` — nothing to do, and nothing is read: the record is finished
 *   business.
 *
 * The two dispositions that close over a pristine file — `restore-or-close`
 * and `retain` — also close a **chain** over one: when the head of what
 * remains of a chain finds its file at the `originalHash` of a record beneath
 * it, the head and every record down to that one are closed without a write
 * (see the module overview). `restore-only` never does.
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
 * The reconciliation table — one verdict per record status and file state —
 * as a total function on the record status union. `docs/ARCHITECTURE.md`
 * states the same table under "Reconciliation on service start".
 *
 * ```text
 * pending | failed   hash === originalHash      → close the record (nothing was written)
 *                    hash === instrumentedHash  → restore from the backup
 *                    otherwise                  → conflict
 * applied            hash === instrumentedHash  → restore from the backup
 *                    otherwise                  → conflict
 * conflict           hash === instrumentedHash  → restore from the backup (the edit was undone)
 *                    hash === originalHash      → close the record (nothing was written)
 *                    otherwise                  → retained, backup kept, re-reported
 * reverted           nothing to do
 *
 * chain head, pending | failed | conflict
 *                    hash === originalHash of a record R beneath it, every link
 *                    hash-consistent            → close the head and every record down to R
 *                                                 (nothing of theirs is on disk), then go on
 *                                                 beneath R
 *
 * beneath a record whose conflict is content-changed | file-missing
 *                    hash is no record's instrumentedHash, or no file
 *                                               → applied | pending | failed → conflict,
 *                                                 backup kept (nothing of theirs is on disk)
 *
 * any status, before a restore from the backup
 *                    hash === instrumentedHash of another session's live claim
 *                    on the same file (applied | pending | failed, not older
 *                    than a live record, placed in the same project)
 *                      same pristine original   → close the record and every record beneath it
 *                                                 (the bytes are that session's to restore)
 *                      otherwise, or unplaced   → nothing written, left open, not clean
 * ```
 *
 * The chain-head rule is the chain-level form of the `hash === originalHash`
 * line, applied by the walk rather than per record; `applied` is left out of
 * it for the same reason it is left out of that line. The chain-beneath rule
 * is the chain-level form of the `otherwise → conflict` lines: once the walk
 * has proved the file holds none of the chain's output, no record of the
 * chain is left claiming its bytes are on disk. The last rule qualifies every
 * `→ restore from the backup` line: a digest that is also another session's
 * live claim does not authorise this session's write. All three are applied
 * by the walk; see the module overview.
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
 * `conflict` keeps its backup while the developer's edit is still there — and
 * is restored the moment it is not, because the watcher that marked it only
 * ever sees the edit, never its undoing.
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
        'A modification status reached cleanup that the reconciliation table does not cover. Add the case to reconcileDispositionFor() in packages/instrumentation/src/cleanup.ts.',
      );
  }
}

/**
 * Whether a disposition closes a record, without a write, whose file already
 * holds the recorded original — the `hash === originalHash` line of the table
 * above.
 *
 * `restore-or-close` does, because for a `pending` or `failed` record the write
 * may never have landed. `retain` does, because a record already in `conflict`
 * has been reported once and a file that is now byte-identical to its original
 * has nothing left to lose or to report. `restore-only` does not: for an
 * `applied` record that state is news the developer is told about first.
 *
 * The same answer gates the chain close: a head whose disposition closes over a
 * pristine file closes the chain beneath it over the original of a record
 * further down, and a head that does not is reported first.
 *
 * @param disposition What the record's status entitles it to.
 * @returns Whether a pristine target closes the record.
 */
function closesPristineTarget(disposition: ReconcileDisposition): boolean {
  return disposition === 'restore-or-close' || disposition === 'retain';
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
   * Creates a file that was observed to be absent, atomically, **only while it
   * is still absent**.
   *
   * The contract is `atomicCreateFileNoClobber`'s, and it is used for exactly
   * one case: a target that is **no longer there**. A deleted file with an
   * intact backup is recoverable — the reversibility guarantee is about the
   * bytes, not about the inode — so the file is recreated from the backup and
   * the outcome says so ({@link RestoreOutcome.recreated}). But "absent" is an
   * observation, and a developer can recreate the file between it and the
   * write; an unconditional create-or-rename would then discard what they wrote
   * with no trace (CWE-367). The bytes are therefore staged in a sibling and
   * installed with `link()`, which the kernel refuses when anything — a file, a
   * directory, a symbolic link — occupies the path. An `exists` verdict is a
   * guarantee that nothing was written. Every other case goes through
   * {@link CleanupFileSystem.replaceFileIfUnchanged}.
   *
   * @param absolutePath The file to create.
   * @param content The bytes to write, verbatim.
   * @returns `created`, or `exists` when something occupied the path and
   * nothing was written.
   * @throws The runtime's own filesystem error, with its `code` intact —
   * `ENOENT` when the containing directory is gone too.
   */
  readonly createFileIfAbsent: (absolutePath: string, content: Uint8Array) => AtomicCreateVerdict;
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
  createFileIfAbsent: (absolutePath: string, content: Uint8Array): AtomicCreateVerdict =>
    atomicCreateFileNoClobber(absolutePath, content),
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
   * never a byte of a developer's file.
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

  /**
   * The absolute project root of another session, for the one question a
   * pass asks about a session it did not come for: are the bytes it is about
   * to write over that session's live claim on **this** project's file?
   *
   * Records carry project-relative paths, so two copies of one project
   * instrumented alike hold identical bytes under identical paths; only the
   * owning session's root tells a claim on this file from a claim on a copy
   * (see the module overview). The service answers from each session row's
   * `projectRoot`. Consulted only for another session's record whose digest
   * matches a file about to be restored, after
   * {@link ReconcileOptions.scopeFor} where a pass has one, and memoised per
   * session for the pass.
   *
   * Absent — or answering `undefined`, or throwing — means the claim cannot
   * be placed, and a claim that cannot be placed is never written over and
   * never closed beside: the record it stood against stays open for a pass
   * that can place it, or for the other session's own cleanup to settle.
   *
   * @param sessionId The session whose project is wanted.
   * @returns Its absolute project root, or `undefined` when it is not known.
   */
  readonly projectRootOf?:
    ((sessionId: string) => string | undefined | Promise<string | undefined>) | undefined;
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
   * they would otherwise expect from a cleanup. `true` only when the no-clobber
   * create installed the original into an empty path; a file that appeared
   * there first is kept and reported as a conflict instead.
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
   * `restore-or-close` and `retain` pass `true`, `restore-only` leaves it
   * `false`. A
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

  /**
   * One outcome per record the walk judged or a chain close settled, in the
   * order they were processed — reverse order. A record behind the record
   * that stopped the walk has none: it was never judged.
   */
  readonly outcomes: RestoreOutcome[];

  /** Records whose backup was written back and verified. */
  readonly restored: ModificationRecord[];

  /**
   * Records closed without a write because the file already held the
   * original — each record's own, or, for the records a chain close settled,
   * content from before them — or because the file holds another session's
   * live claim on the same pristine original, which that session restores.
   */
  readonly closed: ModificationRecord[];

  /**
   * Records whose file was left exactly as it is: a conflict this walk
   * detected, a record that arrived in `conflict` and was re-reported, and
   * every open record beneath a conflict that proves the file holds none of
   * the chain's output — moved to `conflict` with it (or kept there) and
   * covered by that conflict's report rather than one of its own. See the
   * module overview.
   */
  readonly retained: ModificationRecord[];

  /** Every conflict report the chain produced, in detection order. */
  readonly conflicts: ModificationConflict[];

  /**
   * Records the chain did not attempt: everything behind a stop that does not
   * prove the file holds none of their output — a failure, an abort, an
   * unusable backup, a failed verification — with their status untouched.
   */
  readonly skipped: ModificationRecord[];

  /** Records the chain could not finish, with their errors. */
  readonly failures: CleanupFailure[];

  /**
   * The record that stopped the chain, when one did.
   *
   * A conflict or a failure at plan version *n* makes every earlier version's
   * expectation unsatisfiable — the file no longer holds what those records
   * wrote — so the walk halts here instead of skipping ahead, and no earlier
   * record gets a report of its own: it is `retained` in `conflict` beside a
   * conflict that proves its output is gone from the file, and `skipped`
   * otherwise. For a refused fork it is the first record in restoration
   * order: the walk stopped before it began.
   */
  readonly stoppedAt: ModificationRecord | undefined;

  /**
   * Why the whole file was refused, when its records do not form a single
   * chain; `undefined` for a chain that could be walked.
   *
   * When present, nothing was read from or written to the file, every backup
   * was kept, and every record is in `retained` with its conflict report — or
   * in `skipped` and `failures` where the journal would not record the
   * conflict, or `skipped` alone after an abort.
   */
  readonly fork: ChainFork | undefined;
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
   * By default a pass that leaves every record of the session `reverted` — the
   * ones it restored or closed itself, and the ones an install rollback or an
   * earlier pass already had — removes the directory, which is the housekeeping
   * half of "a session never pollutes the developer's working tree": the tree
   * was never touched, and the product's own state directory does not keep
   * growing either. A pass that conflicted never removes it — that copy is what
   * the developer was told about.
   */
  readonly keepBackupDirectory?: boolean | undefined;
}

/**
 * What cleaning up one session did — the value the service maps onto the
 * session record's `cleanup` field and broadcasts as `cleanup.completed`.
 *
 * `status` becomes `cleanup.status`, whose fourth value `pending` is the state
 * before this pass ran, `conflicts` becomes `cleanup.conflicts` and travels
 * verbatim inside `cleanup.completed { sessionId, status, conflicts }`, and
 * `completedAt` becomes `cleanup.completedAt`.
 */
export interface CleanupOutcome {
  /** The session that was cleaned up. */
  readonly sessionId: string;

  /** The pass's verdict. See {@link CLEANUP_STATUSES}. */
  readonly status: CleanupStatus;

  /**
   * Every record that ended `reverted`: restored from its backup, or closed
   * because the file already held the recorded original — the record's own,
   * or, for a chain close, content from before it — or closed beside another
   * session's live claim on the same pristine original.
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
   * record, everything behind a conflict in the same file's chain (in
   * `conflict` with it when the conflict proves the file holds none of the
   * chain's output, untouched otherwise), every record of a file whose records
   * do not form a single chain, everything after an abort, and any record the
   * pass could not finish.
   */
  readonly skipped: ModificationRecord[];

  /** Records the pass could not finish, with their errors. */
  readonly failures: CleanupFailure[];

  /**
   * Every file refused because its records do not form a single chain, in the
   * order the pass met them. Empty for an ordinary pass. See {@link ChainFork}.
   */
  readonly forks: ChainFork[];
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

  /**
   * Records closed without a write: nothing had been written for them, the
   * file had been put back to content from before them (a chain close), or
   * the file holds another session's live claim on the same pristine
   * original, which that session's own records restore.
   */
  readonly closed: ModificationRecord[];

  /**
   * Records whose file was left exactly as it is: a conflict detected by this
   * pass, one carried over from an earlier one and re-reported, or a record
   * beneath such a conflict in the same chain, in `conflict` with it. See
   * {@link ChainRestoreOutcome.retained}.
   */
  readonly retained: ModificationRecord[];

  /** Every conflict report, in detection order — the retained ones included. */
  readonly conflicts: ModificationConflict[];

  /** Records the pass did not attempt. */
  readonly skipped: ModificationRecord[];

  /** Records the pass could not finish, with their errors. */
  readonly failures: CleanupFailure[];

  /**
   * Every file refused because its records do not form a single chain, in the
   * order the pass met them. Empty for an ordinary pass. See {@link ChainFork}.
   */
  readonly forks: ChainFork[];

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
 * the backup's disposal — plus three readings of the verdict that only a
 * restorer can make:
 *
 * - **A missing target is not a conflict when the backup is intact.** The
 *   guarantee is about the bytes: a file the developer deleted, renamed or
 *   moved is recreated from its verified backup and the outcome reports
 *   `recreated`.
 * - **A record that is already in `conflict`** is judged on the file as it
 *   stands now, exactly like any other record: restored when the developer has
 *   undone their edit and the file hashes to `instrumentedHash` again (the
 *   journal moves it `conflict → reverted`), closed without a write when it
 *   hashes to `originalHash`, and otherwise re-reported with nothing written,
 *   the report recomposed so the diff they are offered is current.
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
 * record is moved to `conflict`, and every later pass — the next service start
 * included — judges it again: it is re-reported for as long as the divergence
 * lasts, and restored or closed once the file is back at a recorded digest.
 * `err` is reserved for the conditions that make the
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

  const step = await restoreStep(record, context, {
    scope: scope.value,
    files,
    logger,
    now: clockReading(context, logger),
    disposition,
    closeWhenTargetIsOriginal:
      options.closeWhenTargetIsOriginal ?? closesPristineTarget(disposition),
    retainBackup: options.retainBackup ?? false,
    conflictMessage: options.conflictMessage,
    // One record on its own carries no chain: neither its root nor the records
    // beneath it are in view, so it is judged, and closed, alone.
    chainRoot: undefined,
    chain: undefined,
    // One record is one pass: the other sessions' claims are read for it, and
    // only if its verdict would authorise a write.
    claims: new OpenClaims(context, undefined, undefined),
  });

  // A step without a chain settles exactly the record it judged.
  return isErr(step) ? step : ok(step.value.judged.outcome);
}

/**
 * Orders the records that touch one file into the order they must be restored
 * in: **last applied first**.
 *
 * A follow-up plan version that patches an already-patched file produces a
 * record whose `originalHash` is the previous record's `instrumentedHash` and
 * whose `previousRecordId` names it, so the records form a chain and the only
 * sound way to unwind it is backwards. Restoring version 1 first would write
 * the pristine bytes over the doubly-patched file, leave version 2's record
 * pointing at content that no longer exists, and — worse — succeed, because
 * the write itself has no way to know it was out of order.
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
 * remaining records stay open and are re-examined by the next pass once the
 * developer has resolved the conflict. Behind a `content-changed` or
 * `file-missing` conflict whose file holds no record's output they are moved
 * to `conflict` and retained, so none of them goes on claiming its bytes are
 * on disk; behind any other stop they are skipped with their status
 * untouched — see the module overview.
 *
 * **A resolved conflict closes the chain beneath it.** When a record whose
 * status closes over a pristine file finds the file at the `originalHash` of a
 * record beneath it, over hash-consistent links, the file holds content from
 * before all of them: they are closed without a write and the walk continues
 * beneath them — see the module overview. That is still reverse order: nothing
 * is written for a record while a later one's content is on disk.
 *
 * **A fork is refused before the walk starts.** Records that do not form a
 * single linear chain — two naming the same `previousRecordId`, or more than
 * one starting a chain — have no reverse order, so the file is not read or
 * written at all: every record is reported as a conflict and moved to
 * `conflict`, every backup is kept, and {@link ChainRestoreOutcome.fork}
 * says why.
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
    claims: new OpenClaims(context, undefined, undefined),
  });

  await ledger.sweep(logger);

  return outcome;
}

/**
 * Reverts everything one session instrumented — the end-of-session guarantee
 * that every file it patched is restored, or reported where it cannot be.
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
 * A file whose open records do not form a single chain is refused whole before
 * anything of it is read or written — see the module overview — and listed in
 * {@link CleanupOutcome.forks}; the session's other files are still restored,
 * and the pass ends `conflict` whether or not they were, because the refused
 * fork is an outstanding conflict (see {@link CLEANUP_STATUSES}).
 *
 * A conflict the developer has since resolved by putting the original back is
 * closed by the next call rather than reported again — for a file instrumented
 * by several plan versions, that is the original from before the first of them
 * (the chain root's backup, which the conflict report named as
 * `originalBackupPath`), and every record of the chain closes with it, without
 * a write. So ending an already-ended session again is how a resolved conflict
 * is settled.
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
 * project file, writes nothing to the journal and reports `clean`. That is not
 * a special case in the code — a `reverted` record's disposition is `none`, so
 * it is never even read from disk — which is what makes a retried cleanup after
 * a crashed service safe. Its only look at the disk is whether the session's
 * backup directory is still there; once it is gone, the store is not asked
 * anything either.
 *
 * ## Housekeeping
 *
 * Backups of successfully restored files are deleted only after their restored
 * content verified against `originalHash`, and a backup shared by two records —
 * the store is content-addressed, so records that saw identical original bytes
 * share one file — survives until its last holder is done.
 *
 * A pass that ends `clean` for a session the journal holds records of — every
 * one of them now `reverted` — then removes the session's backup directory,
 * **whether or not this pass reverted any of them**. A session whose every
 * record an install rollback already reverted restores nothing here, and is
 * exactly the session whose emptied `backups/<sessionId>/` would otherwise
 * outlive it; so is one whose chain close left a superseded layer's backup for
 * the directory's removal and whose removal then failed. A pass that conflicted
 * keeps the directory, because that copy is the one the developer was pointed
 * at, and so does a caller that asks to with
 * {@link CleanupSessionOptions.keepBackupDirectory}. A session the journal holds
 * no record of is not this pass's to tidy. The removal relies on what the
 * restore itself relies on: the session's installs have stopped before its
 * cleanup runs.
 *
 * Never rejects and never throws. A journal that will not answer is reported as
 * a failure with no record attributed to it, and the status is `partial` —
 * nothing could be attempted, and no conflict was observed: a later pass,
 * against a journal that answers, gives the verdict.
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
  const forks: ChainFork[] = [];

  const listed = await context.journal.listBySession(sessionId);

  if (isErr(listed)) {
    logger.error('cleanup could not read the modification journal', {
      code: listed.error.code,
    });

    // A failure with no conflict observed: nothing was read, so nothing can be
    // said to have diverged, and the verdict is the table's `partial`.
    const unanswered: CleanupFailure[] = [
      { recordId: '', sessionId, file: '', error: listed.error },
    ];

    return {
      sessionId,
      status: statusFor({ conflicts, forks, outstanding: skipped, failures: unanswered }),
      restored,
      conflicts,
      completedAt: clockReading(context, logger),
      skipped,
      failures: unanswered,
      forks,
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
    // Listed lazily: a pass none of whose verdicts authorises a write never
    // asks the journal for anything but this session's records.
    claims: new OpenClaims(context, undefined, undefined),
  };

  for (const group of groupsInReverseApplicationOrder(work)) {
    const chain = await restoreFileChain(group, context, pass);

    pass.claims.observe(chain);
    restored.push(...chain.restored, ...chain.closed);
    conflicts.push(...chain.conflicts);
    skipped.push(...chain.retained, ...chain.skipped);
    failures.push(...chain.failures);

    if (chain.fork !== undefined) {
      forks.push(chain.fork);
    }
  }

  await ledger.sweep(logger);

  // `skipped` already holds every retained record, so it is the whole of what
  // this pass leaves open.
  const status = statusFor({ conflicts, forks, outstanding: skipped, failures });

  // Keyed off the journal's listing rather than this pass's restorations: a
  // clean pass leaves every record of the session `reverted`, including the
  // ones an install rollback reverted before it — whose session restores
  // nothing here and would otherwise keep its emptied directory for good.
  const ownsRecords = listed.value.some((record) => record.sessionId === sessionId);

  if (status === 'clean' && ownsRecords && options.keepBackupDirectory !== true) {
    await removeSessionBackups(sessionId, context, options.scope, logger, restored.length > 0);
  }

  logger.info('session cleanup finished', {
    status,
    restored: restored.length,
    conflicts: conflicts.length,
    skipped: skipped.length,
    failures: failures.length,
    forks: forks.length,
  });

  return {
    sessionId,
    status,
    restored,
    conflicts,
    completedAt: clockReading(context, logger),
    skipped,
    failures,
    forks,
  };
}

/**
 * Reconciles every open record in the journal, whatever state its session is
 * in — the service-start half of the end-of-session guarantee.
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
 * is reconciled in the only order that can be verified. A file whose open
 * records do not form a single chain — a fork an older journal or a bypassing
 * writer left behind — is refused whole before anything of it is read or
 * written, reported in {@link ReconcileOutcome.forks}, and its records are
 * moved to `conflict` so every later start keeps retaining them; the other
 * files are reconciled as usual.
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
 * ## Housekeeping
 *
 * The same as {@link cleanupSession}'s, per session: each backup is deleted
 * only after its restored content verified, a shared one once its last holder
 * is done, and a session this pass reverted at least one record of and left
 * nothing of outstanding — no retained or skipped record, no conflict, no
 * refused fork, no failure — then has its emptied backup directory removed
 * through the store its records were restored with. A session with anything
 * still open keeps its directory whole, because that copy is the one the
 * developer was pointed at. A directory that cannot be removed is a warning,
 * never a failure of the pass: the files are already back.
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
  const forks: ChainFork[] = [];

  const listed = await context.journal.listOpen();

  if (isErr(listed)) {
    logger.error('reconciliation could not read the modification journal', {
      code: listed.error.code,
    });

    // As in `cleanupSession`: a failure with no conflict observed is `partial`.
    const unanswered: CleanupFailure[] = [
      { recordId: '', sessionId: '', file: '', error: listed.error },
    ];

    return {
      status: statusFor({
        conflicts,
        forks,
        outstanding: [...retained, ...skipped],
        failures: unanswered,
      }),
      examined: 0,
      restored,
      closed,
      retained,
      conflicts,
      skipped,
      failures: unanswered,
      forks,
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
  const stores = new Map<string, BackupStore>();

  ledger.register(work);

  const pass: PassSettings = {
    logger,
    files: filesOf(context),
    ledger,
    scope: undefined,
    scopeFor: options.scopeFor,
    conflictMessage: options.conflictMessage,
    stores,
    // The listing this pass already holds is every session's open records —
    // taken before any session filter — so the claims are read from it rather
    // than asked for twice, and placed with the same resolver.
    claims: new OpenClaims(context, options.scopeFor, listed.value),
  };

  for (const group of groupsInReverseApplicationOrder(work, true)) {
    const chain = await restoreFileChain(group, context, pass);

    // A later group may belong to another session over the same file, and
    // must judge the claims as this group left them.
    pass.claims.observe(chain);
    restored.push(...chain.restored);
    closed.push(...chain.closed);
    retained.push(...chain.retained);
    conflicts.push(...chain.conflicts);
    skipped.push(...chain.skipped);
    failures.push(...chain.failures);

    if (chain.fork !== undefined) {
      forks.push(chain.fork);
    }
  }

  await ledger.sweep(logger);

  // After the sweep, so every deferred deletion has run through its verified
  // route before a directory is asked to empty.
  await removeSettledSessionDirectories(
    {
      reverted: [...restored, ...closed],
      conflicts,
      forks,
      outstanding: [...retained, ...skipped],
      failures,
    },
    stores,
    logger,
  );

  const status = statusFor({
    conflicts,
    forks,
    outstanding: [...retained, ...skipped],
    failures,
  });

  logger.info('modification reconciliation finished', {
    status,
    examined: wanted.length,
    restored: restored.length,
    closed: closed.length,
    retained: retained.length,
    conflicts: conflicts.length,
    skipped: skipped.length,
    failures: failures.length,
    forks: forks.length,
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
    forks,
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

  /**
   * The backup store each session's records were placed with, filled as the
   * walk resolves a record's scope.
   *
   * Only {@link reconcileModifications} collects them: it spans sessions, and
   * after the walk it removes the backup directory of every session it left
   * clean through the very store that session's records were restored with,
   * never one composed afresh. Absent for a pass that removes no directory.
   */
  readonly stores?: Map<string, BackupStore> | undefined;

  /**
   * Every other session's open claim on a file, read once for the pass and
   * kept current as its walks move records. See {@link OpenClaims}.
   */
  readonly claims: OpenClaims;
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

  /**
   * The record's chain root — the root-most live record its `previousRecordId`
   * links reach among the file's records — or `undefined` for an unchained
   * record and for a record restored on its own.
   *
   * Its backup is the file's pristine original, so every conflict report of a
   * chained record names it as `originalBackupPath`, diffs from it, and the
   * wording below points there rather than at the record's own backup, which
   * holds an earlier plan version's instrumented output.
   */
  readonly chainRoot: ModificationRecord | undefined;

  /**
   * What remains of the record's chain beneath it, for a step of a chain walk;
   * `undefined` for a record restored on its own, which is never closed
   * together with anything. See {@link closeSupersededChain}.
   */
  readonly chain: ChainStepSettings | undefined;

  /**
   * The pass's view of every other session's open records, consulted before
   * a `restorable` verdict becomes a write. See {@link foreignClaimsOn}.
   */
  readonly claims: OpenClaims;
}

/** What a step of a chain walk knows about the records beneath the one it judges. */
interface ChainStepSettings {
  /**
   * The live records the walk has still to reach after this one, in
   * restoration order: the rest of the file's single chain.
   */
  readonly beneath: readonly ModificationRecord[];

  /**
   * Whether a record's backup must survive its own verified close — the pass
   * ledger's answer, asked for the record a chain close matched.
   */
  readonly retains: (record: ModificationRecord) => boolean;
}

/** One record a step settled, as the walk accounts for it. */
interface SettledRecord {
  /** The record as the walk was handed it, whose ledger keys the walk releases or pins. */
  readonly record: ModificationRecord;

  /** What became of it. */
  readonly outcome: RestoreOutcome;

  /**
   * Whether it was closed as a **superseded** layer of a chain close: the file
   * holds content from before it, so its `originalHash` is not on disk, its
   * backup cannot be deleted as verified, and the ledger must release it
   * without queueing a deletion.
   */
  readonly superseded: boolean;
}

/**
 * What one step of a walk did: the judged record, then every record beneath it
 * a chain close settled in the same step, in restoration order.
 */
interface StepResult {
  /** The record the step judged. */
  readonly judged: SettledRecord;

  /**
   * The records beneath it a chain close settled with it, in restoration
   * order; empty for every other step.
   */
  readonly beneath: readonly SettledRecord[];

  /**
   * A record beneath the judged one whose close the journal refused, which
   * stopped a chain close part-way, with the journal's error; `undefined`
   * otherwise. The judged record and everything in
   * {@link StepResult.beneath} were closed before it.
   */
  readonly refused:
    { readonly record: ModificationRecord; readonly error: DebuggenError } | undefined;
}

/**
 * What reporting a conflict needs from a step's settings: the clock reading the
 * report and the transition share, the logger, the wording override and the
 * record's chain root.
 *
 * Narrower than {@link RestoreSettings} on purpose, so a refused fork — which
 * resolves no scope and reads no file — reports through the same two functions
 * as every other conflict.
 */
type ConflictSettings = Pick<RestoreSettings, 'logger' | 'now' | 'conflictMessage' | 'chainRoot'>;

/**
 * The records a walk is moving into `conflict` beneath the conflicted record
 * that stopped it, and the tally its single log line reports.
 *
 * Created by {@link chainRetentionFor} only when that record's report proves
 * the file holds none of the chain's output, and consulted by the walk for
 * each record behind the stop. Mutable on purpose: it is local to one walk of
 * one file and never escapes it.
 */
interface ChainRetention {
  /** The judged record whose conflict stopped the walk. */
  readonly head: ModificationRecord;

  /** Its report's reason: `content-changed` or `file-missing`. */
  readonly reason: ModificationConflictReason;

  /**
   * The clock reading of the head's step — its report's `detectedAt` — which
   * every transition beneath it carries, so the chain moved into `conflict` at
   * one instant.
   */
  readonly now: number;

  /** How many records beneath the head the journal moved into `conflict`. */
  moved: number;

  /** How many were already in `conflict` and stayed there without a write. */
  kept: number;

  /**
   * The record whose transition the journal refused, which ends the retention:
   * it and every record beneath it are skipped with their status untouched.
   */
  refused: ModificationRecord | undefined;
}

/**
 * Unwinds one file's records in reverse order, halting at the first record that
 * cannot be reverted.
 *
 * The body of {@link restoreChain}, and the per-file step of
 * {@link cleanupSession} and {@link reconcileModifications}, which share one
 * {@link BackupLedger} across every file they visit.
 *
 * Three structural refusals come first, each before a single byte of the file
 * is read: records naming different files, links that cannot be ordered (a
 * duplicate id or a cycle), and records that order but do not form a single
 * chain — a fork, which {@link refuseForkedChain} reports. Only a single linear
 * chain reaches the walk.
 *
 * Behind the record that stops the walk, every record keeps its backup. When
 * that record's conflict proves the file holds none of the chain's output
 * ({@link chainRetentionFor}), the open records behind it move into `conflict`
 * and are `retained` ({@link retainBehindConflict}); behind any other stop, or
 * once the journal refuses one of those transitions, they are `skipped` with
 * their status untouched. Abort is not consulted between those transitions:
 * they follow from one observation of the file, write nothing to it, and a
 * chain left half in `conflict` would only be finished by the next pass.
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
      fork: undefined,
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
      fork: undefined,
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
      fork: undefined,
    };
  }

  // Reverse order exists only for one linear chain. A fork is refused here,
  // before the file is read or written, and never partly restored: writing
  // either branch's backup could overwrite the other's patch.
  const fork = detectChainFork(ordered.value, file);

  if (fork !== undefined) {
    return await refuseForkedChain(ordered.value, fork, context, pass);
  }

  // The records a chain root is looked up among: the live ones, because a
  // reverted ancestor's backup has been deleted and cannot be named as the
  // original. Resolved once, from the records as the walk was handed them.
  const live = liveRecordsOf(ordered.value);
  // Records a chain close already settled in an earlier step of this walk.
  const settledIds = new Set<string>();
  let stoppedAt: ModificationRecord | undefined;
  // Set only by a stop whose conflict proves the file holds none of the
  // chain's output: the records behind it then move into `conflict`.
  let retention: ChainRetention | undefined;

  for (const [index, record] of ordered.value.entries()) {
    if (settledIds.has(record.id)) {
      continue;
    }

    if (stoppedAt !== undefined) {
      // Every earlier plan version expects content the file no longer holds,
      // so none of them is restored and every backup is kept.
      pass.ledger.pin(record);

      if (
        retention !== undefined &&
        retention.refused === undefined &&
        reconcileDispositionFor(record.status) !== 'none'
      ) {
        const held = await retainBehindConflict(record, retention, context);

        if (isErr(held)) {
          // Recorded, never thrown: this record and every one behind it keep
          // their status for the next pass, exactly as behind any failure.
          retention.refused = record;
          skipped.push(record);
          failures.push(failureOf(record, held.error));
        } else {
          retained.push(held.value);
        }

        continue;
      }

      skipped.push(record);
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

    pass.stores?.set(record.sessionId, scope.value.backups);

    const disposition = reconcileDispositionFor(record.status);
    const beneath = liveRecordsOf(ordered.value.slice(index + 1)).filter(
      (candidate) => !settledIds.has(candidate.id),
    );
    const result = await restoreStep(record, context, {
      scope: scope.value,
      files: pass.files,
      logger: pass.logger,
      now: clockReading(context, pass.logger),
      disposition,
      closeWhenTargetIsOriginal: closesPristineTarget(disposition),
      retainBackup: pass.ledger.holds(record),
      conflictMessage: pass.conflictMessage,
      chainRoot: findChainRoot(record, live),
      chain: {
        beneath,
        retains: (candidate: ModificationRecord): boolean => pass.ledger.holds(candidate),
      },
      claims: pass.claims,
    });

    if (isErr(result)) {
      skipped.push(record);
      pass.ledger.pin(record);
      failures.push(failureOf(record, result.error));
      stoppedAt = record;
      continue;
    }

    for (const settled of [result.value.judged, ...result.value.beneath]) {
      const { outcome } = settled;

      settledIds.add(settled.record.id);
      outcomes.push(outcome);

      switch (outcome.kind) {
        case 'restored':
          restored.push(outcome.record);
          pass.ledger.release(settled.record, scope.value.backups, outcome.backup === 'retained');
          break;

        case 'already-original':
          closed.push(outcome.record);
          // A superseded layer's backup is not what the file holds, so no
          // verified deletion may be queued for it; the clean pass's removal of
          // the session directory takes it with the rest.
          pass.ledger.release(
            settled.record,
            scope.value.backups,
            !settled.superseded && outcome.backup === 'retained',
          );
          break;

        case 'conflict':
          retained.push(outcome.record);

          if (outcome.conflict !== undefined) {
            conflicts.push(outcome.conflict);
          }

          pass.ledger.pin(settled.record);
          stoppedAt = settled.record;
          // Only a judged record reaches a conflict — a chain close settles the
          // records beneath it without one — so `beneath` is the rest of its
          // chain.
          retention = chainRetentionFor(settled.record, outcome, beneath);
          break;

        case 'skipped':
          skipped.push(outcome.record);
          pass.ledger.pin(settled.record);
          break;

        default:
          assertNever(
            outcome.kind,
            'A restore outcome reached the chain walker that it does not classify. Add the case in packages/instrumentation/src/cleanup.ts.',
          );
      }
    }

    const refused = result.value.refused;

    if (refused !== undefined) {
      // A chain close stopped part-way: what it closed above this record stays
      // closed, and this record and everything beneath it stay open for the
      // next pass, exactly as behind any failure.
      settledIds.add(refused.record.id);
      skipped.push(refused.record);
      pass.ledger.pin(refused.record);
      failures.push(failureOf(refused.record, refused.error));
      stoppedAt = refused.record;
    }
  }

  if (retention !== undefined) {
    // One line per chain, identifiers and counts only: the head's own warning
    // already carries the file and the backup the developer is pointed at.
    pass.logger.info(
      'the records beneath a conflicted modification were moved to conflict with it; their backups are kept',
      {
        recordId: retention.head.id,
        sessionId: retention.head.sessionId,
        reason: retention.reason,
        moved: retention.moved,
        kept: retention.kept,
        refused: retention.refused === undefined ? 0 : 1,
        ...(retention.refused === undefined ? {} : { refusedRecordId: retention.refused.id }),
      },
    );
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
    fork: undefined,
  };
}

/**
 * Whether the conflict that stopped a walk proves the file holds none of the
 * output of the records beneath the judged one, and so moves them into
 * `conflict` with it; the retention to apply when it does, `undefined`
 * otherwise.
 *
 * Two report reasons describe the file rather than the tool's own bookkeeping:
 *
 * - `file-missing` — there is no file, so it holds nobody's output;
 * - `content-changed` — the file holds bytes the judged record did not write.
 *
 * Each is read against the digests beside it, not taken on its reason alone.
 * A `content-changed` report is also what an `applied` record whose file went
 * back to the bytes it replaced produces, and in a chain those bytes are the
 * output of the record beneath it — still on disk, still that record's to
 * restore. So the report's digest must be no record's `instrumentedHash` —
 * the judged record's or any record's beneath it — and a report without one
 * qualifies only when the file is gone. Every other reason (`backup-missing`,
 * `backup-corrupt`, `restore-verification-failed`, `record-chain-fork`) is
 * about a backup or a write, says nothing about which output the file holds,
 * and never qualifies.
 *
 * @param head The judged record whose conflict stopped the walk, as the walk
 * was handed it.
 * @param outcome Its conflict outcome, carrying the report.
 * @param beneath The open records still to be walked behind it, in
 * restoration order: the rest of its single chain.
 * @returns The retention, or `undefined` when the records beneath are to be
 * skipped with their status untouched.
 */
function chainRetentionFor(
  head: ModificationRecord,
  outcome: RestoreOutcome,
  beneath: readonly ModificationRecord[],
): ChainRetention | undefined {
  const report = outcome.conflict;

  if (report === undefined || beneath.length === 0) {
    return undefined;
  }

  switch (report.reason) {
    case 'content-changed':
    case 'file-missing': {
      const observed = report.actualHash;
      const holdsNoOutput =
        observed === undefined
          ? report.reason === 'file-missing'
          : observed !== head.instrumentedHash &&
            beneath.every((record) => record.instrumentedHash !== observed);

      return holdsNoOutput
        ? {
            head,
            reason: report.reason,
            now: outcome.completedAt,
            moved: 0,
            kept: 0,
            refused: undefined,
          }
        : undefined;
    }

    case 'backup-missing':
    case 'backup-corrupt':
    case 'restore-verification-failed':
    case 'record-chain-fork':
      return undefined;

    default:
      return assertNever(
        report.reason,
        'A conflict reason reached the chain walker that it does not classify. Add the case to chainRetentionFor() in packages/instrumentation/src/cleanup.ts.',
      );
  }
}

/**
 * Moves one record beneath a conflicted record of its chain into `conflict`,
 * or leaves it there when it already is, and returns it as the journal now
 * holds it.
 *
 * The same transition {@link recordConflict} journals, with the head's clock
 * reading, and legal from every open status that can reach it (`applied`,
 * `pending` and `failed` → `conflict`). A record already in `conflict` is not
 * re-written — the journal has no `conflict → conflict` transition and the row
 * already says what it has to. No report is composed and nothing is read or
 * written in the project: the head's report covers the file, and the caller
 * pins the record's backup.
 *
 * @param record The record behind the head, still open.
 * @param retention The chain's retention, whose tally this updates.
 * @param context The pass's context, for the journal.
 * @returns The record in `conflict`, or `err(STORE_ERROR)` for a transition
 * the journal refused.
 */
async function retainBehindConflict(
  record: ModificationRecord,
  retention: ChainRetention,
  context: CleanupContext,
): Promise<Result<ModificationRecord>> {
  if (record.status === 'conflict') {
    retention.kept += 1;

    return ok(record);
  }

  const marked = await context.journal.updateStatus(record.id, 'conflict', {
    appliedAt: retention.now,
  });

  if (isErr(marked)) {
    return err(journalTransitionFailed(record, 'conflict', marked.error));
  }

  retention.moved += 1;

  return ok(marked.value);
}

/**
 * Decides whether one file's records form a single linear chain, and describes
 * the fork when they do not.
 *
 * Structural only — nothing is read from disk, and the `chain_fork` flag the
 * service's store may carry is neither visible nor needed here: the shape of
 * the records is the evidence. Only **live** records are judged: a `reverted`
 * record is finished history that no pass acts on, and the installer's
 * rollback of a failed follow-up delta legitimately leaves one beside a later
 * layer on the same parent — the parent stays `applied`, the rolled-back delta
 * is `reverted`, and the next follow-up is layered on the parent again. The
 * store's single-child index draws the same line. A set of live records is a
 * single chain exactly when no two of them name the same `previousRecordId`
 * and exactly one starts a chain within the set. A record starts one when it
 * has no `previousRecordId` or names a record that is not live in the set —
 * an earlier plan version already reverted — which is the same reading
 * {@link orderRestorationChain} takes. Two siblings of a parent outside the set
 * are therefore both a shared parent and two roots, and are refused on either
 * count.
 *
 * Called after {@link orderRestorationChain} has refused duplicates and
 * cycles, so every non-empty set it sees has at least one root.
 *
 * @param records One file's records, in restoration order, `reverted` ones
 * included when a direct {@link restoreChain} caller passed them.
 * @param file The file's normalised key, for the report.
 * @returns The fork, or `undefined` for a single chain.
 */
function detectChainFork(
  records: readonly ModificationRecord[],
  file: string,
): ChainFork | undefined {
  const live = records.filter((record) => reconcileDispositionFor(record.status) !== 'none');
  const first = live[0];

  if (first === undefined) {
    return undefined;
  }

  const ids = new Set(live.map((record) => record.id));
  const childCounts = new Map<string, number>();
  const rootRecordIds: string[] = [];

  for (const record of live) {
    const previousId = record.previousRecordId;

    if (previousId === undefined || !ids.has(previousId)) {
      rootRecordIds.push(record.id);
    }

    if (previousId !== undefined) {
      childCounts.set(previousId, (childCounts.get(previousId) ?? 0) + 1);
    }
  }

  const sharedPreviousRecordIds = [...childCounts]
    .filter(([, children]) => children > 1)
    .map(([previousId]) => previousId)
    .sort();

  if (sharedPreviousRecordIds.length === 0 && rootRecordIds.length <= 1) {
    return undefined;
  }

  return {
    reason: RECORD_CHAIN_FORK_REASON,
    sessionId: first.sessionId,
    file,
    recordIds: live.map((record) => record.id),
    sharedPreviousRecordIds,
    rootRecordIds: rootRecordIds.sort(),
  };
}

/**
 * Refuses a forked file whole: nothing is read or written, every backup is
 * kept, and every record is reported as a conflict.
 *
 * Each record goes through the same {@link reportSynthesizedConflict} and
 * {@link recordConflict} path every other conflict takes, so it leaves the
 * same trace — one journal transition to `conflict` (a no-op for a record
 * already there; every open status may move to `conflict`), one bounded
 * warning, one report for `cleanup.completed`. The report's reason is
 * {@link CHAIN_FORK_CONFLICT_REASON}, and the fork itself — with the stable
 * {@link RECORD_CHAIN_FORK_REASON} — travels as
 * {@link ChainRestoreOutcome.fork}. Moving the records to `conflict` is what
 * keeps the file safe afterwards: the next pass retains them rather than
 * attempting a restore, and retention keeps a conflicting record's backup.
 *
 * Every record's backup is pinned in the ledger first, so a digest this file
 * shares with a record of another file is not swept either. A journal that
 * refuses a transition leaves that record `skipped` with the failure recorded,
 * exactly as in the walk, and an abort stops between records.
 *
 * @param ordered The file's records, in restoration order.
 * @param fork The fork {@link detectChainFork} found.
 * @param context The pass's context, for the journal, the clock and the signal.
 * @param pass The pass's shared settings.
 * @returns The outcome, with `fork` set.
 */
async function refuseForkedChain(
  ordered: readonly ModificationRecord[],
  fork: ChainFork,
  context: CleanupContext,
  pass: PassSettings,
): Promise<ChainRestoreOutcome> {
  const outcomes: RestoreOutcome[] = [];
  const retained: ModificationRecord[] = [];
  const conflicts: ModificationConflict[] = [];
  const skipped: ModificationRecord[] = [];
  const failures: CleanupFailure[] = [];
  const settings: ConflictSettings = {
    logger: pass.logger,
    now: clockReading(context, pass.logger),
    conflictMessage: pass.conflictMessage,
    chainRoot: undefined,
  };
  // Every record of a fork still has one ancestry of its own through its
  // `previousRecordId`, so each report names the pristine original that record
  // descends from.
  const live = liveRecordsOf(ordered);

  pass.logger.error(
    'the modification records for one file do not form a single chain; nothing was written to it',
    {
      sessionId: fork.sessionId,
      file: fork.file,
      reason: fork.reason,
      records: fork.recordIds.length,
      sharedPreviousRecords: fork.sharedPreviousRecordIds.length,
      roots: fork.rootRecordIds.length,
    },
  );

  for (const record of ordered) {
    pass.ledger.pin(record);
  }

  let aborted = false;

  for (const record of ordered) {
    if (reconcileDispositionFor(record.status) === 'none') {
      // A `reverted` record a direct caller passed along is history, not part
      // of the fork: nothing is reported for it and its status is left alone,
      // exactly as the walk would leave it.
      outcomes.push(skippedOutcome(record, settings.now));
      skipped.push(record);
      continue;
    }

    if (aborted || context.signal?.aborted === true) {
      if (!aborted) {
        pass.logger.warn('cleanup was aborted between records; the rest stay open', {
          recordId: record.id,
          file: fork.file,
        });
      }

      aborted = true;
      skipped.push(record);
      continue;
    }

    const chainRoot = findChainRoot(record, live);
    const reported = await reportSynthesizedConflict(
      record,
      undefined,
      CHAIN_FORK_CONFLICT_REASON,
      undefined,
      chainForkMessage(record, fork, chainRoot),
      context,
      { ...settings, chainRoot },
    );

    if (isErr(reported)) {
      skipped.push(record);
      failures.push(failureOf(record, reported.error));
      continue;
    }

    outcomes.push(reported.value);
    retained.push(reported.value.record);

    if (reported.value.conflict !== undefined) {
      conflicts.push(reported.value.conflict);
    }
  }

  return {
    file: fork.file,
    outcomes,
    restored: [],
    closed: [],
    retained,
    conflicts,
    skipped,
    failures,
    stoppedAt: ordered.find((record) => reconcileDispositionFor(record.status) !== 'none'),
    fork,
  };
}

/**
 * Restores one record: the sequence of the module overview, with the verdict
 * from `./patch/conflict.ts` choosing the branch — and, for a step of a chain
 * walk, closes the chain beneath it when the file already holds content from
 * before it.
 *
 * Shared by {@link restoreModification} and {@link restoreFileChain} so that a
 * record restored on its own and a record restored as part of a chain take
 * exactly the same steps in exactly the same order.
 *
 * A record already in `conflict` (disposition `retain`) takes the same branch
 * as every other record, because the verdict — not the status — says what the
 * file holds now: `restorable` once the developer's edit is undone,
 * `already-reverted` once the file is back at the original, and a conflicting
 * verdict while the edit is still there. Only the last keeps it in `conflict`;
 * {@link recordConflict} then renews its report without a journal write.
 *
 * ## The chain close
 *
 * One conflicting verdict has a chain-level reading. When the judged record is
 * the head of what remains of its chain, its disposition closes a record over a
 * pristine file ({@link closesPristineTarget}: `pending`, `failed`,
 * `conflict`), and the file hashes to the `originalHash` of a record beneath it
 * — over links whose hashes agree, see {@link supersededLayersBeneath} — the
 * file holds content from before every write from the head down to that
 * record. Nothing of those writes is left to restore or to lose, so the head
 * and each of those records are closed without a write
 * ({@link closeSupersededChain}) and the walk continues with the record beneath
 * them, which the file now holds the output of. The lookahead reuses the
 * digest the verdict already took — the file is read once — so the head never
 * passes through `conflict` and no "not reverted" warning is logged for it. An
 * `applied` head is never closed this way: for it, content that is not its own
 * is news, reported as a conflict first, and the next pass — the head then in
 * `conflict` — closes the chain.
 *
 * ## Another session's claim
 *
 * A `restorable` verdict is the only one that authorises a write from an
 * observed digest, so it is the one checked against the other sessions' open
 * records first ({@link foreignClaimsOn}). A digest that is also another
 * session's live claim in the same project, over the same pristine original,
 * closes the record and what remains of its chain without a write
 * ({@link closeClaimedChain}); a claim over a different original, one the pass
 * cannot place, or a listing that cannot be read refuses the write with
 * nothing journaled, which the walk records as a failure and a stop. See the
 * module overview.
 */
async function restoreStep(
  record: ModificationRecord,
  context: CleanupContext,
  settings: RestoreSettings,
): Promise<Result<StepResult>> {
  if (settings.disposition === 'none') {
    // A reverted record is finished business: nothing is resolved, read or
    // hashed, which is what makes a repeated pass free as well as safe.
    settings.logger.debug('a reverted modification needed no action', {
      recordId: record.id,
      file: record.file,
    });

    return ok(judgedOnly(record, skippedOutcome(record, settings.now)));
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

  if (
    judgement.kind === 'content-changed' &&
    settings.closeWhenTargetIsOriginal &&
    settings.chain !== undefined
  ) {
    const superseded = supersededLayersBeneath(
      record,
      judgement.actualHash,
      settings.chain.beneath,
    );

    if (superseded !== undefined) {
      return await closeSupersededChain(
        record,
        superseded,
        judgement.actualHash,
        path,
        context,
        settings,
        settings.chain,
      );
    }
  }

  if (judgement.kind === 'restorable') {
    // The bytes this verdict would write over may be another session's live
    // patch that merely hashes like this record's own output.
    const claims = await foreignClaimsOn(record, judgement.actualHash, path, settings);

    if (isErr(claims)) {
      return claims;
    }

    if (claims.value.length > 0) {
      return await closeClaimedChain(record, claims.value, path, context, settings);
    }
  }

  const acted = await actOnVerdict(record, judgement, path, context, settings);

  return isErr(acted) ? acted : ok(judgedOnly(record, acted.value));
}

/**
 * Acts on one record's verdict: the restore, the close, or the conflict it
 * authorises. The per-record half of {@link restoreStep}.
 */
async function actOnVerdict(
  record: ModificationRecord,
  judgement: ConflictVerdict,
  path: string,
  context: CleanupContext,
  settings: RestoreSettings,
): Promise<Result<RestoreOutcome>> {
  if (settings.disposition === 'retain' && !isConflictVerdict(judgement)) {
    // The conflict described the file as it was when the divergence was seen.
    // It now hashes to a recorded digest again — the developer undid the edit,
    // or put the original back by hand — so the verdict authorises exactly what
    // it would for any other record, and the journal takes the record out of
    // `conflict` (`conflict → reverted`) once that is done and verified.
    settings.logger.info('a conflicted file holds a recorded digest again; it is re-judged', {
      recordId: record.id,
      sessionId: record.sessionId,
      file: record.file,
      verdict: judgement.kind,
    });
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
        return await closeRecord(record, path, context, settings, judgement.actualHash);
      }

      return await reportSynthesizedConflict(
        record,
        path,
        'content-changed',
        judgement.actualHash,
        pristineTargetMessage(record, settings.chainRoot),
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

/** The result of a step that settled only the record it judged. */
function judgedOnly(record: ModificationRecord, outcome: RestoreOutcome): StepResult {
  return {
    judged: { record, outcome, superseded: false },
    beneath: [],
    refused: undefined,
  };
}

/**
 * The records a chain close settles beneath a head whose file hashes to
 * `actualHash`, or `undefined` when no chain close applies.
 *
 * Walks down from the head through `previousRecordId` among the live records
 * still to be walked, and requires every link it crosses to be
 * **hash-consistent** — the child names the parent (`previousRecordId ===
 * parent.id`), belongs to the same session, and replaced exactly the bytes the
 * parent wrote (`child.originalHash === parent.instrumentedHash`) — which is
 * what makes "the file holds the bytes from before this record" provable from
 * the journal alone. The first record whose `originalHash` equals the file's
 * digest ends the walk: the file holds the content from before it, so every
 * write from the head down to it is gone from disk. A link that is missing,
 * inconsistent, crosses sessions or loops ends the walk with `undefined`, and
 * the head is judged on its own terms as ever.
 *
 * The head's own `originalHash` is not compared: a file that holds it is an
 * `already-reverted` verdict, never a `content-changed` one.
 *
 * @param head The record whose verdict was `content-changed`.
 * @param actualHash The digest the verdict took of the file.
 * @param beneath The live records the walk has still to reach, in restoration
 * order. Records of the same file by construction.
 * @returns The records beneath the head, from its parent down to and including
 * the record whose `originalHash` the file holds, in restoration order.
 */
function supersededLayersBeneath(
  head: ModificationRecord,
  actualHash: string,
  beneath: readonly ModificationRecord[],
): ModificationRecord[] | undefined {
  const byId = new Map<string, ModificationRecord>();

  for (const record of beneath) {
    if (!byId.has(record.id)) {
      byId.set(record.id, record);
    }
  }

  const layers: ModificationRecord[] = [];
  const visited = new Set<string>([head.id]);
  let child = head;

  // Each iteration moves to a record not yet visited or ends, so the walk is
  // bounded by the number of records beneath the head.
  while (child.previousRecordId !== undefined && !visited.has(child.previousRecordId)) {
    const parent = byId.get(child.previousRecordId);

    if (
      parent === undefined ||
      parent.sessionId !== head.sessionId ||
      child.originalHash !== parent.instrumentedHash
    ) {
      return undefined;
    }

    visited.add(parent.id);
    layers.push(parent);

    if (parent.originalHash === actualHash) {
      return layers;
    }

    child = parent;
  }

  return undefined;
}

/**
 * Closes the head of a chain and the records beneath it down to the one whose
 * original the file holds — all without writing a byte.
 *
 * Reached from {@link restoreStep} only, once {@link supersededLayersBeneath}
 * has proved from hash-consistent links that the file holds the content from
 * before every one of those writes. Each record goes `→ reverted` through
 * {@link closeRecord}, top-down, the head first, so a journal that refuses part
 * of the way leaves exactly what an ordinary halted walk leaves: the records
 * closed so far are closed, and the refused record and everything beneath it
 * stay open for the next pass, which judges the refused record as the new
 * head.
 *
 * The backups differ by what the file proves:
 *
 * - the **matched** record — the lowest one, whose `originalHash` the file
 *   hashes to — has its backup disposed of exactly as an already-original
 *   close does, through the verified deletion the digest just taken
 *   authorises, or retained by the ledger when another record shares it;
 * - every **superseded** record above it — the head included — has an
 *   `originalHash` that is *not* on disk, so its backup cannot be deleted as
 *   verified without lying to the store's interlock. It is left where it is,
 *   released from the ledger without a queued deletion, and removed with the
 *   session's backup directory by the pass that leaves the session clean.
 *
 * Abort is not consulted between the closes: the step is one decision about
 * one file, taken on one observation, and writes nothing, so splitting it would
 * only leave a half-closed chain for the next pass to finish.
 */
async function closeSupersededChain(
  head: ModificationRecord,
  layers: readonly ModificationRecord[],
  actualHash: string,
  path: string,
  context: CleanupContext,
  settings: RestoreSettings,
  chain: ChainStepSettings,
): Promise<Result<StepResult>> {
  const matched = layers[layers.length - 1];

  settings.logger.info(
    'a chained file holds content from before these modifications; they are closed without a write',
    {
      recordId: head.id,
      sessionId: head.sessionId,
      file: head.file,
      status: head.status,
      matchedRecordId: matched?.id,
      closed: layers.length + 1,
    },
  );

  const closedHead = await closeRecord(head, path, context, settings, undefined);

  if (isErr(closedHead)) {
    return closedHead;
  }

  const beneath: SettledRecord[] = [];

  for (const layer of layers) {
    const isMatched = layer === matched;
    const closed = await closeRecord(
      layer,
      path,
      context,
      { ...settings, retainBackup: isMatched && chain.retains(layer) },
      isMatched ? actualHash : undefined,
    );

    if (isErr(closed)) {
      return ok({
        judged: { record: head, outcome: closedHead.value, superseded: true },
        beneath,
        refused: { record: layer, error: closed.error },
      });
    }

    beneath.push({ record: layer, outcome: closed.value, superseded: !isMatched });
  }

  return ok({
    judged: { record: head, outcome: closedHead.value, superseded: true },
    beneath,
    refused: undefined,
  });
}

/**
 * Closes a record whose file holds another session's live claim on the same
 * pristine original, and every open record beneath it in its chain — all
 * without writing a byte.
 *
 * Reached from {@link restoreStep} only, once {@link foreignClaimsOn} has
 * placed every matching claim at this record's own file and found each one
 * descending from the pristine original this record's chain recorded. The
 * bytes on disk are then that session's to unwind, and its unwinding ends at
 * exactly the original this chain would have written back, so nothing of this
 * chain is left to restore or to lose. Writing its backups instead would put
 * the pristine file under the other session's live patch and leave that
 * session reporting an edit nobody made.
 *
 * Each record goes `→ reverted` through {@link closeRecord}, the transition
 * every close journals, top-down with the judged record first, so a journal
 * that refuses part of the way leaves exactly what a halted chain close
 * leaves: the records closed so far stay closed, and the refused record and
 * everything beneath it stay open for the next pass. Every record is settled
 * as **superseded**: its `originalHash` is not what the file holds, so no
 * verified deletion may be queued for its backup, and the backups leave with
 * the session's backup directory once a pass leaves the session clean. The
 * decision is logged once, with identifiers and a count only.
 *
 * @param record The judged record, whose verdict was `restorable`.
 * @param holders The other sessions' records whose claim the file holds.
 * @param path The resolved target, for the outcomes.
 * @param context The pass's context, for the journal.
 * @param settings The judged record's step settings.
 * @returns The judged record and the records beneath it, closed.
 */
async function closeClaimedChain(
  record: ModificationRecord,
  holders: readonly ModificationRecord[],
  path: string,
  context: CleanupContext,
  settings: RestoreSettings,
): Promise<Result<StepResult>> {
  const layers = settings.chain?.beneath ?? [];

  settings.logger.info(
    'another session holds these bytes over the same original; this session’s modifications are closed without a write',
    {
      recordId: record.id,
      sessionId: record.sessionId,
      status: record.status,
      holderRecordIds: holders.map((holder) => holder.id),
      holderSessionIds: sessionIdsOf(holders),
      closed: layers.length + 1,
    },
  );

  const closedHead = await closeRecord(record, path, context, settings, undefined, false);

  if (isErr(closedHead)) {
    return closedHead;
  }

  const beneath: SettledRecord[] = [];

  for (const layer of layers) {
    const closed = await closeRecord(layer, path, context, settings, undefined, false);

    if (isErr(closed)) {
      return ok({
        judged: { record, outcome: closedHead.value, superseded: true },
        beneath,
        refused: { record: layer, error: closed.error },
      });
    }

    beneath.push({ record: layer, outcome: closed.value, superseded: true });
  }

  return ok({
    judged: { record, outcome: closedHead.value, superseded: true },
    beneath,
    refused: undefined,
  });
}

/**
 * Writes one record's backup back over its file, verifies the result and closes
 * the record — steps 3 to 7 of the sequence, in that order and no other.
 *
 * Three refusals live inside it, and each one leaves the developer's bytes
 * exactly where they are:
 *
 * - the backup cannot be read back from where the record says it is, or does
 *   not hash to the digest it is filed under, so there are no verified original
 *   bytes to write;
 * - the file changed between the verdict and the write, which the conditional
 *   replacement detects and refuses — or, for a target that was gone, something
 *   appeared at the path before the no-clobber create could install the
 *   original (CWE-367 both ways);
 * - the restored content does not hash to `originalHash`, which is the one case
 *   where bytes *were* written and the backup is therefore **kept** rather than
 *   deleted.
 *
 * The backup is read through the record's journaled `backupPath`, not
 * recomposed from its digest: the journal may have been updated to say the
 * backup was moved, and a read by digest would then declare an intact original
 * missing and strand the patched file. The store resolves that path under its
 * own policy — a relocation is honoured only inside the record's own session
 * directory, in a subdirectory of it, under the record's digest; every
 * directory above it is pinned from the state root and proven private through
 * the descriptor it opened, and the file is read through that pin without
 * following a link. Any other recorded path is never opened.
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

  // Annotated rather than inferred: an unannotated `let` assigned inside a
  // `try` evolves from an implicit `any`.
  let backup: Result<RecordedBackup>;

  try {
    backup = await settings.scope.backups.readRecorded(record.backupPath, record.originalHash);
  } catch (error) {
    // A condition the store has no opinion about — a link planted at a
    // relocated backup (`ELOOP`), a directory in its place, a permission
    // change since the verdict. It is still "the original cannot be read
    // back", so it is reported exactly as a refusal would be, with the errno,
    // and nothing is written.
    const reason = DebuggenError.is(error)
      ? (detailsReasonOf(error) ?? error.code)
      : (errnoCodeOf(error) ?? 'unknown');

    logger.warn('a backup could not be read back; nothing was written', {
      recordId: record.id,
      sessionId: record.sessionId,
      file: record.file,
      backupPath: record.backupPath,
      reason,
    });

    return await reportUnusableBackup(record, path, reason, context, settings);
  }

  if (isErr(backup)) {
    return await reportUnusableBackup(
      record,
      path,
      detailsReasonOf(backup.error) ?? backup.error.code,
      context,
      settings,
    );
  }

  const originalBytes = backup.value.bytes;
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
      'backup-corrupt',
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
    // "Missing" is an observation, and the developer can recreate the file
    // between it and this write. The create is no-clobber: it installs the
    // original only if the path is still empty at that instant, and otherwise
    // writes nothing — so a file that appeared is kept, not replaced (CWE-367).
    const written = tryCatch(
      () => files.createFileIfAbsent(path, originalBytes),
      'CLEANUP_PARTIAL',
    );

    if (isErr(written)) {
      if (errnoCodeOf(written.error.cause) === 'ENOENT') {
        // The file's directory is gone too. Recreating the tree is not this
        // product's business, so the record is reported with its backup intact.
        return await reportSynthesizedConflict(
          record,
          path,
          'file-missing',
          undefined,
          missingDirectoryMessage(record, settings.chainRoot),
          context,
          settings,
        );
      }

      return err(filesystemFailure(record, path, 'restore-create', written.error));
    }

    if (written.value.kind === 'exists') {
      logger.warn('a missing file reappeared while it was being restored; nothing was written', {
        recordId: record.id,
        sessionId: record.sessionId,
        file: record.file,
        staleReason: TARGET_APPEARED,
      });

      // The same route a stale conditional replacement takes: the detector is
      // asked again, so the report describes whatever now occupies the path,
      // and the record moves to `conflict` with its backup retained.
      return await reportRaceConflict(record, path, undefined, TARGET_APPEARED, context, settings);
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
 * Reports a backup the restoration could not use, under the reason that names
 * what the store observed.
 *
 * The store's {@link STORED_DIGEST_MISMATCH} means the file is there and was
 * read, but is not the original: `'backup-corrupt'`, worded as the digest
 * mismatch it is. Every other reason — nothing there, an errno such as `ELOOP`,
 * a state-directory policy refusal — means the original could not be read back
 * at all: `'backup-missing'`, with the reason quoted. Either way nothing is
 * written and the backup is kept.
 *
 * @param record The record whose backup could not be used.
 * @param path The resolved target, for the report.
 * @param storeReason The store's `details.reason`, the errno, or the code.
 * @param context The pass's context, for the journal transition.
 * @param settings The step's settings.
 * @returns The conflict outcome.
 */
async function reportUnusableBackup(
  record: ModificationRecord,
  path: string,
  storeReason: string,
  context: CleanupContext,
  settings: RestoreSettings,
): Promise<Result<RestoreOutcome>> {
  if (storeReason === STORED_DIGEST_MISMATCH) {
    return await reportSynthesizedConflict(
      record,
      path,
      'backup-corrupt',
      undefined,
      backupDigestMismatchMessage(record),
      context,
      settings,
    );
  }

  return await reportSynthesizedConflict(
    record,
    path,
    'backup-missing',
    undefined,
    backupUnreadableMessage(record, storeReason),
    context,
    settings,
  );
}

/**
 * Closes a record whose file already holds the recorded original — or, in a
 * chain close, content from before it — without writing a byte.
 *
 * The "nothing was written" branch of the reconciliation table: a crash between
 * the journal append and the atomic rename leaves exactly this state, and the
 * file needs no repair. The backup may be deleted because the hash comparison
 * that got here *is* the verification the deletion requires — the bytes on disk
 * hash to `originalHash`.
 *
 * @param verifiedHash The digest the file was just observed to hold, equal to
 * the record's `originalHash`, which authorises the backup's verified deletion;
 * `undefined` for a superseded layer of a chain close, whose `originalHash` the
 * file does not hold. Such a backup is left where it is and reported
 * `retained`, for the clean pass's removal of the session directory.
 * @param logged Whether the close is logged per record. {@link closeClaimedChain}
 * passes `false`: it logs its one decision for the whole chain, and the
 * per-record wording — "content from before it" — would not describe a file
 * that holds another session's bytes.
 */
async function closeRecord(
  record: ModificationRecord,
  path: string,
  context: CleanupContext,
  settings: RestoreSettings,
  verifiedHash: string | undefined,
  logged = true,
): Promise<Result<RestoreOutcome>> {
  const marked = await context.journal.updateStatus(record.id, 'reverted', {
    appliedAt: settings.now,
  });

  if (isErr(marked)) {
    return err(journalTransitionFailed(record, 'reverted', marked.error));
  }

  const disposition: BackupDisposition =
    verifiedHash === undefined ? 'retained' : await disposeBackup(record, settings, verifiedHash);

  if (logged) {
    settings.logger.info(
      verifiedHash === undefined
        ? 'a superseded modification was closed without a write: the file holds content from before it'
        : 'a modification was closed without a write: the file held the original',
      {
        recordId: record.id,
        sessionId: record.sessionId,
        file: record.file,
        status: record.status,
        backup: disposition,
      },
    );
  }

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
 * Reports a conflict the detector did not compose, for the three situations
 * only a restorer can reach.
 *
 * `'restore-verification-failed'` exists only after a write has been attempted
 * and hashed; a backup that cannot be read back is a `'backup-missing'`, and
 * one that is there but does not hash to its own name a `'backup-corrupt'`,
 * each named with the record id so the developer has something to search the
 * journal with; and a file that already
 * holds the original is reported as `'content-changed'` where the record's
 * status does not permit closing it. A refused fork reports each of its records
 * through here too, with no path because none was resolved.
 * `./patch/conflict.ts` owns the bounding and validation of every report,
 * including these.
 */
async function reportSynthesizedConflict(
  record: ModificationRecord,
  path: string | undefined,
  reason: ModificationConflictReason,
  actualHash: string | undefined,
  message: string,
  context: CleanupContext,
  settings: ConflictSettings,
): Promise<Result<RestoreOutcome>> {
  const report = buildConflictReport({
    record,
    reason,
    detectedAt: settings.now,
    message: settings.conflictMessage ?? message,
    ...(actualHash === undefined ? {} : { actualHash }),
    chainRoot: settings.chainRoot,
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
    concurrentWriteMessage(record, staleReason, settings.chainRoot),
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
 * churn the journal. `path` is `undefined` only for a refused fork, which never
 * resolves one.
 */
async function recordConflict(
  record: ModificationRecord,
  conflict: ModificationConflict,
  path: string | undefined,
  context: CleanupContext,
  settings: ConflictSettings,
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
    ...(conflict.originalBackupPath === undefined
      ? {}
      : { originalBackupPath: conflict.originalBackupPath }),
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
 * — refused by the store, or thrown by the filesystem — is a warning, not a
 * failure of the restore: the developer's file is already back.
 *
 * The backup deleted is the one the record's journaled `backupPath` names, the
 * same one {@link writeRestoration} read, so a relocated backup is removed from
 * where it was moved to rather than looked for where it no longer is.
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

  const removed = await removeRecordedBackup(
    settings.scope.backups,
    record,
    verifiedHash,
    settings.logger,
  );

  if (removed === undefined) {
    return 'retained';
  }

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

/**
 * Asks the store to delete the backup a record names, conditional on a
 * verified restoration, and turns a thrown filesystem error into a logged
 * "kept".
 *
 * Shared by {@link disposeBackup} and {@link BackupLedger.sweep}, the only two
 * places a backup is ever deleted, so both delete from the record's journaled
 * `backupPath` under the store's policy and both treat a throw the same way.
 *
 * @param verifiedHash The digest the restored content hashed to, which the
 * store checks against `originalHash` before it deletes anything.
 * @returns The store's answer, or `undefined` when the delete threw — logged
 * here, with the errno, and meaning the backup was kept.
 */
async function removeRecordedBackup(
  store: BackupStore,
  record: ModificationRecord,
  verifiedHash: string,
  logger: Logger,
): Promise<Result<boolean> | undefined> {
  try {
    return await store.removeRecorded(record.backupPath, record.originalHash, {
      restoredContentHash: verifiedHash,
    });
  } catch (error) {
    logger.warn('the backup of a restored file could not be deleted; it was kept', {
      recordId: record.id,
      originalHash: record.originalHash,
      backupPath: record.backupPath,
      errno: errnoCodeOf(error) ?? 'unknown',
    });

    return undefined;
  }
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
    ...(settings.chainRoot === undefined ? {} : { chainRoot: settings.chainRoot }),
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
// Another session's claim on a file.
// ---------------------------------------------------------------------------

/**
 * Whether a record in this status claims that its session's bytes are on
 * disk: `applied`, and the `pending` and `failed` rows whose write may have
 * landed.
 *
 * The same three statuses as `HOLDING_STATUSES` in `./patch/patcher.ts`, whose
 * hold check this mirrors from the restoring side. `conflict` claims nothing —
 * its file held the developer's edit when it was judged, which is theirs
 * rather than any session's — so a pass never defers to it, and a new
 * session's own end restores normally while an old chain over the same file
 * sits in `conflict`. `reverted` holds nothing at all. Written as an
 * exhaustive `switch` so a status added to `./schema/modification.ts` fails to
 * compile here until somebody decides whether it claims a file.
 *
 * @param status A record's status.
 * @returns Whether the record claims its bytes are on disk.
 */
function claimsFileBytes(status: ModificationStatus): boolean {
  switch (status) {
    case 'applied':
    case 'pending':
    case 'failed':
      return true;

    case 'conflict':
    case 'reverted':
      return false;

    default:
      return assertNever(
        status,
        'A modification status reached the claim check that it does not classify. Add the case to claimsFileBytes() in packages/instrumentation/src/cleanup.ts.',
      );
  }
}

/**
 * The digest of the pristine file a record's chain started from: its chain
 * root's `originalHash`, or the record's own when it has no root in view.
 *
 * @param record The record.
 * @param root Its chain root, as `findChainRoot` resolved it.
 * @returns The pristine original's digest.
 */
function pristineOriginalOf(
  record: ModificationRecord,
  root: ModificationRecord | undefined,
): string {
  return (root ?? record).originalHash;
}

/**
 * Where a claim of another session stands relative to the file a record is
 * about to restore.
 *
 * - `same-file` — its project resolves the claim's path to the canonical file
 *   the record's own path resolved to: it is a claim on these bytes.
 * - `elsewhere` — its project is known and the claim's file is another file
 *   (a copy of the project, or nothing at that path): not a claim on these.
 * - `unplaced` — its project is not known, or its path could not be resolved
 *   safely, so nothing can be concluded either way.
 */
type ClaimPlacement = 'same-file' | 'elsewhere' | 'unplaced';

/**
 * One pass's view of every open record in the journal, for the claim check of
 * {@link foreignClaimsOn}.
 *
 * - **Read once, and only when needed.** The listing is
 *   `ModificationJournal.listOpen`, asked for at the pass's first `restorable`
 *   verdict and memoised — success or failure — for the rest of it;
 *   {@link reconcileModifications} seeds it with the listing it already holds.
 *   A pass that writes nothing never asks, so a repeated end still reads the
 *   journal once, by session, and does nothing else.
 * - **Kept current.** Each walk's settled records replace their listed rows
 *   ({@link OpenClaims.observe}), so a later file of the same pass never takes
 *   a claim this pass already restored, closed or moved into `conflict` for a
 *   live one.
 * - **Placed per session.** A claimant's project root is resolved at most once
 *   per session per pass: through the pass's {@link RecordScopeResolver} when
 *   it has one, then {@link CleanupContext.projectRootOf}. A resolver that
 *   answers `err` or `undefined`, or throws, leaves the session unplaced.
 *
 * Private to this module and local to one pass: it never outlives the call
 * that created it.
 */
class OpenClaims {
  /**
   * The pass's context: its journal, which the listing is read from, and its
   * project-root resolver, called as a member of the context it came with.
   */
  private readonly context: CleanupContext;

  /** The pass's record placement, when it has one. */
  private readonly scopeFor: RecordScopeResolver | undefined;

  /** The memoised listing; `undefined` until the first claim check asks. */
  private listing: Promise<Result<readonly ModificationRecord[]>> | undefined;

  /** Rows this pass has since moved, by id, overriding the listing. */
  private readonly observed = new Map<string, ModificationRecord>();

  /** Each claimant session's project root, memoised per session. */
  private readonly roots = new Map<string, Promise<string | undefined>>();

  /**
   * @param context The pass's context: its journal and its project-root resolver.
   * @param scopeFor The pass's record placement, tried first for a claimant.
   * @param seed A listing the pass already read from `listOpen`, used instead
   * of asking again.
   */
  constructor(
    context: CleanupContext,
    scopeFor: RecordScopeResolver | undefined,
    seed: readonly ModificationRecord[] | undefined,
  ) {
    this.context = context;
    this.scopeFor = scopeFor;
    this.listing = seed === undefined ? undefined : Promise.resolve(ok(seed));
  }

  /**
   * Takes in the records one walk settled — restored, closed or retained — as
   * the journal now holds them.
   *
   * @param chain What the walk did.
   */
  observe(chain: Pick<ChainRestoreOutcome, 'restored' | 'closed' | 'retained'>): void {
    for (const record of [...chain.restored, ...chain.closed, ...chain.retained]) {
      this.observed.set(record.id, record);
    }
  }

  /**
   * Every open record, as the journal listed it and as this pass has since
   * moved it.
   *
   * @returns The records, or the listing's error — the same one every later
   * call of the pass answers.
   */
  async open(): Promise<Result<readonly ModificationRecord[]>> {
    this.listing ??= listOpenRecords(this.context.journal);

    const listed = await this.listing;

    if (isErr(listed)) {
      return listed;
    }

    return ok(listed.value.map((record) => this.observed.get(record.id) ?? record));
  }

  /**
   * The absolute project root of a claimant's session, or `undefined` when the
   * pass cannot place it.
   *
   * @param claimant Another session's record.
   * @param logger Where a resolver's refusal is noted.
   * @returns The root, memoised for the claimant's session.
   */
  projectRootOf(claimant: ModificationRecord, logger: Logger): Promise<string | undefined> {
    const known = this.roots.get(claimant.sessionId);

    if (known !== undefined) {
      return known;
    }

    const resolved = this.resolveRoot(claimant, logger);

    this.roots.set(claimant.sessionId, resolved);

    return resolved;
  }

  /** The uncached half of {@link OpenClaims.projectRootOf}. */
  private async resolveRoot(
    claimant: ModificationRecord,
    logger: Logger,
  ): Promise<string | undefined> {
    if (this.scopeFor !== undefined) {
      try {
        const scope = await this.scopeFor(claimant);

        if (!isErr(scope)) {
          return scope.value.projectRoot;
        }

        logger.debug('the pass could not place another session holding matching bytes', {
          recordId: claimant.id,
          sessionId: claimant.sessionId,
          code: scope.error.code,
        });
      } catch (error) {
        logger.debug('the pass could not place another session holding matching bytes', {
          recordId: claimant.id,
          sessionId: claimant.sessionId,
          code: DebuggenError.from(error).code,
        });
      }
    }

    if (this.context.projectRootOf !== undefined) {
      try {
        const root = await this.context.projectRootOf(claimant.sessionId);

        if (typeof root === 'string' && root.length > 0) {
          return root;
        }
      } catch (error) {
        logger.debug('the project root of another session could not be resolved', {
          sessionId: claimant.sessionId,
          code: DebuggenError.from(error).code,
        });
      }
    }

    return undefined;
  }
}

/**
 * `ModificationJournal.listOpen`, with a throw turned into the `err` the port
 * promises, so the claim check never rejects a pass that must not throw.
 *
 * @param journal The journal.
 * @returns Every open record, or the error that stopped the listing.
 */
async function listOpenRecords(
  journal: ModificationJournal,
): Promise<Result<readonly ModificationRecord[]>> {
  try {
    return await journal.listOpen();
  } catch (error) {
    return err(DebuggenError.from(error, 'STORE_ERROR'));
  }
}

/**
 * Where a claim of another session stands relative to the canonical file a
 * record is about to restore. See {@link ClaimPlacement}.
 *
 * The claimant's path is resolved the way this module resolves every record's
 * — contained in its project and canonicalised through every symbolic link —
 * so two spellings of one project directory compare equal, and two copies of
 * one project never do.
 *
 * @param claimant Another session's record whose digest matched.
 * @param path The canonical path the judged record resolved to.
 * @param settings The judged record's step settings, for the claims index,
 * the filesystem seam and the logger.
 * @returns The placement.
 */
async function placeClaim(
  claimant: ModificationRecord,
  path: string,
  settings: RestoreSettings,
): Promise<ClaimPlacement> {
  const root = await settings.claims.projectRootOf(claimant, settings.logger);

  if (root === undefined) {
    return 'unplaced';
  }

  const canonical = resolveRealPathWithinProject(root, claimant.file, settings.files.realPath);

  if (isErr(canonical)) {
    // Nothing at the claim's path in its own project cannot be the file just
    // read here; any other refusal says nothing about where the claim lives.
    return detailsReasonOf(canonical.error) === 'path-not-resolvable' ? 'elsewhere' : 'unplaced';
  }

  return canonical.value.path === path ? 'same-file' : 'elsewhere';
}

/**
 * The other sessions' live claims on the bytes a `restorable` verdict read:
 * `ok([])` when there are none and the write may proceed, `ok(holders)` when
 * the record is to be closed beside them, and `err` when the write is refused.
 *
 * The rule of the module overview, in order:
 *
 * 1. **Candidates** — every open record of another session, in a status that
 *    claims its bytes ({@link claimsFileBytes}), over the same normalised file,
 *    whose `instrumentedHash` is the digest just read. When the judged record
 *    itself claims its bytes, a candidate journaled before it is stale — it
 *    could not have been patched over while this record held the file — and is
 *    not a candidate; a record in `conflict` claims nothing and yields to any.
 * 2. **Placement** — each candidate's project resolves its path to this very
 *    file, to another one, or cannot be placed ({@link placeClaim}).
 * 3. **Decision** — a candidate that cannot be placed, or that is placed here
 *    but descends from a different pristine original, refuses the write; the
 *    rest placed here are the holders; with none, the write proceeds.
 *
 * Every refusal is logged once at `warn` with identifiers only, and is an
 * `err` the walk records as a failure beside the skipped chain — the pass is
 * not clean, nothing is journaled, and every backup stays pinned.
 *
 * @param record The judged record.
 * @param digest The digest the verdict read, equal to its `instrumentedHash`.
 * @param path The canonical path its file resolved to.
 * @param settings Its step settings.
 * @returns The holders, or the refusal.
 */
async function foreignClaimsOn(
  record: ModificationRecord,
  digest: string,
  path: string,
  settings: RestoreSettings,
): Promise<Result<readonly ModificationRecord[]>> {
  const open = await settings.claims.open();

  if (isErr(open)) {
    settings.logger.warn(
      'the other sessions’ open modifications could not be read; nothing was written',
      {
        recordId: record.id,
        sessionId: record.sessionId,
        code: open.error.code,
      },
    );

    return err(claimsUnreadable(record, open.error));
  }

  const file = fileKeyOf(record);
  const recordClaims = claimsFileBytes(record.status);
  const candidates = open.value.filter(
    (other) =>
      other.sessionId !== record.sessionId &&
      claimsFileBytes(other.status) &&
      other.instrumentedHash === digest &&
      fileKeyOf(other) === file &&
      (!recordClaims || other.appliedAt >= record.appliedAt),
  );

  if (candidates.length === 0) {
    return ok([]);
  }

  const holders: ModificationRecord[] = [];
  const unplaced: ModificationRecord[] = [];

  for (const candidate of candidates) {
    const placement = await placeClaim(candidate, path, settings);

    switch (placement) {
      case 'same-file':
        holders.push(candidate);
        break;

      case 'elsewhere':
        break;

      case 'unplaced':
        unplaced.push(candidate);
        break;

      default:
        assertNever(
          placement,
          'A claim placement reached the claim check that it does not handle. Add the case to foreignClaimsOn() in packages/instrumentation/src/cleanup.ts.',
        );
    }
  }

  const pristine = pristineOriginalOf(
    record,
    settings.chainRoot ?? findChainRoot(record, open.value),
  );
  const otherOriginal = holders.filter(
    (holder) => pristineOriginalOf(holder, findChainRoot(holder, open.value)) !== pristine,
  );

  if (unplaced.length > 0 || otherOriginal.length > 0) {
    const reason: ClaimRefusalReason =
      unplaced.length > 0 ? 'claim-unplaced' : 'claim-over-another-original';
    const withheldBy = [...unplaced, ...otherOriginal];

    settings.logger.warn(
      'another session holds the bytes this restore would replace; nothing was written',
      {
        recordId: record.id,
        sessionId: record.sessionId,
        status: record.status,
        reason,
        holderRecordIds: withheldBy.map((holder) => holder.id),
        holderSessionIds: sessionIdsOf(withheldBy),
      },
    );

    return err(claimRefusal(record, withheldBy, reason));
  }

  if (holders.length === 0) {
    settings.logger.debug('matching bytes of another session belong to another project', {
      recordId: record.id,
      sessionId: record.sessionId,
      candidates: candidates.length,
    });
  }

  return ok(holders);
}

/** The distinct session ids of some records, sorted, for a log line or an error's details. */
function sessionIdsOf(records: readonly ModificationRecord[]): string[] {
  return [...new Set(records.map((record) => record.sessionId))].sort();
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

/**
 * The records a pass may still act on — every one whose disposition is not
 * `none` — in the order given.
 *
 * The set a chain root is resolved in: a `reverted` ancestor is finished
 * history whose backup was deleted once its restore verified, so it can be
 * neither the pristine original a report names nor a link a chain close walks.
 */
function liveRecordsOf(records: readonly ModificationRecord[]): ModificationRecord[] {
  return records.filter((record) => reconcileDispositionFor(record.status) !== 'none');
}

/** The records of the named sessions, in the order they were given. */
function filterBySession(
  records: readonly ModificationRecord[],
  sessionIds: ReadonlySet<string>,
): ModificationRecord[] {
  return records.filter((record) => sessionIds.has(record.sessionId));
}

/** What a finished pass leaves behind: the only input its verdict is derived from. */
interface PassRemainder {
  /** Every conflict report the pass produced or renewed. */
  readonly conflicts: readonly ModificationConflict[];

  /** Every file refused because its records do not form a single chain. */
  readonly forks: readonly ChainFork[];

  /** Every record the pass left open: retained ones and skipped ones alike. */
  readonly outstanding: readonly ModificationRecord[];

  /** Every failure, including one with no record attributed to it. */
  readonly failures: readonly CleanupFailure[];
}

/**
 * The verdict of a finished pass, as {@link CLEANUP_STATUSES} defines it.
 *
 * Derived from what is **outstanding**, never from what the pass did: how many
 * records this pass happened to restore is deliberately not an input, so a pass
 * that restores one file and conflicts on another reports exactly what a second
 * pass over the same state reports.
 *
 * - `conflict` when any conflict is outstanding — a conflict report, a refused
 *   fork (a fork is a conflict whose report an abort may have pre-empted), or
 *   an open record already in `conflict` status (one that the pass could not
 *   re-report because its path, scope or journal refused it).
 * - `clean` when nothing is outstanding at all, which includes the pass that had
 *   nothing to do — the reading that makes a second {@link cleanupSession} call
 *   honest.
 * - `partial` otherwise: a record left open or a failure, with no conflict
 *   among them.
 *
 * A record is outstanding exactly when its disposition is not `none`, the same
 * test both passes filter their work with, so a `reverted` record that reached
 * a list is finished business and never counts.
 */
function statusFor(remainder: PassRemainder): CleanupStatus {
  const open = remainder.outstanding.filter(
    (record) => reconcileDispositionFor(record.status) !== 'none',
  );

  if (
    remainder.conflicts.length > 0 ||
    remainder.forks.length > 0 ||
    open.some((record) => record.status === 'conflict')
  ) {
    return 'conflict';
  }

  return open.length === 0 && remainder.failures.length === 0 ? 'clean' : 'partial';
}

/**
 * Removes a session's backup directory after a clean pass.
 *
 * Only reached when every record of the session is `reverted` and nothing
 * conflicted, and it touches nothing in the developer's project: the directory
 * is the product's own, under `$DEBUGGEN_HOME/backups`. The store refuses to
 * remove anything it did not create and reports what it retained, which is
 * logged rather than escalated — a leftover file in the product's state
 * directory is housekeeping, not a cleanup failure, and the session's files are
 * already back.
 *
 * A pass that reverted records asks the store unconditionally. A pass that
 * found every record already reverted — the session an install rollback
 * unwound, or a repeated end — asks it only while something is still at the
 * directory's path ({@link sessionDirectoryPresent}), so the first such pass
 * removes a directory the rollback emptied and every later one stays free of
 * store calls.
 *
 * @param revertedThisPass Whether this pass restored or closed any record.
 */
async function removeSessionBackups(
  sessionId: string,
  context: CleanupContext,
  scope: RecordScope | undefined,
  logger: Logger,
  revertedThisPass: boolean,
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

  if (!revertedThisPass && !(await sessionDirectoryPresent(store))) {
    logger.debug('the session backup directory is already gone', {
      directory: store.sessionDirectory,
    });

    return;
  }

  await removeBackupDirectory(store, logger);
}

/**
 * Whether anything is at a session's backup directory path, looked at without
 * following a link.
 *
 * Only an `ENOENT` answers "no". Anything else — a directory, a link or a file
 * planted in its place, a permission change on the state root — answers "yes",
 * because the store is the one that judges what is there and reports what it
 * will not remove: asking it is never less safe than not asking, while skipping
 * it on a guess could leave a directory behind for good. Read-only; nothing is
 * created or changed.
 *
 * @param store The session's backup store, whose `sessionDirectory` is probed.
 * @returns `false` only when the path does not exist.
 */
async function sessionDirectoryPresent(store: BackupStore): Promise<boolean> {
  try {
    await lstat(store.sessionDirectory);

    return true;
  } catch (error) {
    return errnoCodeOf(error) !== 'ENOENT';
  }
}

/** What a finished reconciliation pass left behind, per record, for its housekeeping. */
interface SettledPass {
  /** Every record the pass restored or closed. */
  readonly reverted: readonly ModificationRecord[];

  /** Every conflict report the pass produced or renewed. */
  readonly conflicts: readonly ModificationConflict[];

  /** Every file refused because its records do not form a single chain. */
  readonly forks: readonly ChainFork[];

  /** Every record the pass left open: retained ones and skipped ones alike. */
  readonly outstanding: readonly ModificationRecord[];

  /** Every failure, including one with no record attributed to it. */
  readonly failures: readonly CleanupFailure[];
}

/**
 * Removes the backup directory of every session a reconciliation pass left
 * clean — the start-up counterpart of what {@link cleanupSession} does on
 * `session.end`, so a session a crashed service never ended leaves no empty
 * `$DEBUGGEN_HOME/backups/<sessionId>/` behind once its files are back.
 *
 * A session qualifies when the pass reverted at least one of its records and
 * nothing of it is outstanding: no retained or skipped record, no conflict
 * report, no refused fork and no failure names it. The pass is handed every
 * open record of each session it covers, so that is the session's whole open
 * set: every record of it is now `reverted`, every backup was deleted as its
 * restore verified (or kept by a store refusal that was logged), and nothing
 * left in the directory is the copy a developer was pointed at. A session
 * with anything still open keeps its directory whole.
 *
 * The directory is removed through the store the session's records were
 * restored with, which unlinks only the digest-named files it creates and the
 * emptied directory itself, and refuses anything else. Sessions are visited in
 * sorted id order, so the log reads the same for the same journal.
 *
 * @param pass What the pass left behind.
 * @param stores The store each session's records were placed with.
 * @param logger Where the pass logs; bound to each session in turn.
 */
async function removeSettledSessionDirectories(
  pass: SettledPass,
  stores: ReadonlyMap<string, BackupStore>,
  logger: Logger,
): Promise<void> {
  const unsettled = new Set<string>([
    ...pass.outstanding.map((record) => record.sessionId),
    ...pass.conflicts.map((conflict) => conflict.sessionId),
    ...pass.forks.map((fork) => fork.sessionId),
    ...pass.failures.map((failure) => failure.sessionId),
  ]);
  const settled = new Set(
    pass.reverted
      .map((record) => record.sessionId)
      .filter((sessionId) => !unsettled.has(sessionId)),
  );

  for (const sessionId of [...settled].sort()) {
    const store = stores.get(sessionId);

    // Every reverted record's scope was resolved, so its store is known; one
    // that belongs to another session was refused before a byte was written.
    if (store?.sessionId !== sessionId) {
      continue;
    }

    await removeBackupDirectory(store, logger.child({ sessionId }));
  }
}

/**
 * Asks a session's store to remove its backup directory, and turns every way
 * that can go wrong into one logged warning.
 *
 * Shared by {@link removeSessionBackups} and
 * {@link removeSettledSessionDirectories}, the only two places a directory is
 * removed. The store refuses to remove anything it did not create and reports
 * what it retained; its `removeSessionDirectory` may also throw the runtime's
 * own error for a directory it cannot list or remove. Both are logged rather
 * than escalated — a leftover entry in the product's state directory is
 * housekeeping, not a cleanup failure, and the session's files are already
 * back — which keeps both passes true to "never rejects and never throws".
 *
 * @param store The session's backup store.
 * @param logger Where to log, bound to the session.
 */
async function removeBackupDirectory(store: BackupStore, logger: Logger): Promise<void> {
  let removed: Result<number>;

  try {
    removed = await store.removeSessionDirectory();
  } catch (error) {
    logger.warn('the session backup directory was not removed', {
      errno: errnoCodeOf(error) ?? 'unknown',
      directory: store.sessionDirectory,
    });

    return;
  }

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
 * So the pass counts holders. A record whose backup still has another holder —
 * or whose backup is pinned, because a record sharing it conflicted or was
 * skipped and its backup is what the developer was pointed at — keeps its
 * backup, and {@link BackupLedger.sweep} deletes it once the last holder has
 * been restored and nothing pinned it.
 *
 * A record identifies its backup two ways, and the ledger honours both: the
 * `(sessionId, originalHash)` pair the store composes a path from — each
 * session has its own backup directory, so two sessions' identical digests are
 * two different files — and the journaled `backupPath` that cleanup actually
 * reads and deletes, which may have been updated to say the backup was moved.
 * Every record is counted under both keys, and a backup is deletable only when
 * **neither** key is still held or pinned. That is conservative on purpose: two
 * records that share a digest but name different paths hold each other's
 * deletion until both are done, which costs a deferral; two records that name
 * one relocated file under different digests still cannot delete it out from
 * under each other, which is what matters.
 *
 * Private to this module: a caller of {@link restoreChain} gets a ledger built
 * from the records it passed, and {@link cleanupSession} and
 * {@link reconcileModifications} share one across every file they visit.
 */
class BackupLedger {
  /** How many records of this pass are still to be answered for, per key. */
  private readonly holders = new Map<string, number>();

  /** Keys whose backup this pass must not delete at all. */
  private readonly pinned = new Set<string>();

  /**
   * Deferred deletions, one per distinct `(session, digest, recorded path)`,
   * with the store that owns them. Keyed that finely so two records that share
   * a digest but name different files each get their own deletion; two that
   * resolve to the same file delete it once and find it absent the second time,
   * which the store answers idempotently.
   */
  private readonly deferred = new Map<
    string,
    { readonly store: BackupStore; readonly record: ModificationRecord }
  >();

  /**
   * Counts the records a pass is about to process.
   *
   * Nothing is pinned up front — not even the backup of a record that arrives
   * already in `conflict`, because such a record is judged again and one whose
   * edit was undone is restored like any other, its backup then deleted as
   * verified. Being counted as a holder is what keeps a digest it shares with
   * another record alive until it has been answered for, and the walk pins its
   * backup the moment it is not reverted — its outcome is still a conflict, it
   * failed, it was skipped, or the walk never reached it — so a backup the
   * developer is pointed at is never deleted.
   */
  register(records: readonly ModificationRecord[]): void {
    for (const record of records) {
      for (const key of ledgerKeys(record)) {
        this.holders.set(key, (this.holders.get(key) ?? 0) + 1);
      }
    }
  }

  /** Whether this record's backup must survive its own restoration. */
  holds(record: ModificationRecord): boolean {
    return ledgerKeys(record).some(
      (key) => this.pinned.has(key) || (this.holders.get(key) ?? 0) > 1,
    );
  }

  /**
   * Accounts for a record that was restored or closed.
   *
   * @param deferredDelete Whether its backup was kept, in which case the record
   * is remembered for {@link BackupLedger.sweep}.
   */
  release(record: ModificationRecord, store: BackupStore, deferredDelete: boolean): void {
    for (const key of ledgerKeys(record)) {
      this.holders.set(key, Math.max(0, (this.holders.get(key) ?? 0) - 1));
    }

    if (deferredDelete) {
      this.deferred.set(deferredKey(record), { store, record });
    }
  }

  /**
   * Accounts for a record that was not reverted, and forbids the deletion of
   * its backup for the rest of the pass — including a deletion an earlier
   * record had deferred under either of its keys.
   */
  pin(record: ModificationRecord): void {
    const keys = ledgerKeys(record);

    for (const key of keys) {
      this.holders.set(key, Math.max(0, (this.holders.get(key) ?? 0) - 1));
      this.pinned.add(key);
    }

    for (const [key, entry] of this.deferred) {
      if (ledgerKeys(entry.record).some((candidate) => keys.includes(candidate))) {
        this.deferred.delete(key);
      }
    }
  }

  /**
   * Deletes every deferred backup whose last holder has been restored and that
   * nothing pinned, under either of its keys.
   *
   * Each deletion goes to the record's journaled `backupPath`, through the same
   * store-policy route {@link disposeBackup} takes, and stays conditional on the
   * verified restoration. A failure — refused or thrown — is logged and left: a
   * retained backup costs a few kilobytes under the product's own state
   * directory, and every file it belongs to is already back.
   */
  async sweep(logger: Logger): Promise<void> {
    for (const entry of this.deferred.values()) {
      const blocked = ledgerKeys(entry.record).some(
        (key) => this.pinned.has(key) || (this.holders.get(key) ?? 0) > 0,
      );

      if (blocked) {
        continue;
      }

      const removed = await removeRecordedBackup(
        entry.store,
        entry.record,
        entry.record.originalHash,
        logger,
      );

      if (removed === undefined) {
        continue;
      }

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

/**
 * The ledger's keys for one record's backup: the digest inside its session's
 * backup directory, and the journaled path cleanup reads and deletes.
 *
 * Tagged so the two kinds can never collide, and the path is compared in its
 * lexical normal form so two spellings of one path count as one holder.
 */
function ledgerKeys(record: ModificationRecord): readonly [string, string] {
  return [
    `digest\u0000${record.sessionId}\u0000${record.originalHash}`,
    `path\u0000${normalizePosix(toPosix(record.backupPath))}`,
  ];
}

/** The key a deferred deletion is remembered under: both of a record's keys at once. */
function deferredKey(record: ModificationRecord): string {
  const [digestKey, pathKey] = ledgerKeys(record);

  return `${digestKey}\u0000${pathKey}`;
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
// file, a backup path (the value a conflict message shows the developer
// verbatim), a digest, an id, a count, an enumerated reason or an errno. What
// never does: a byte of the content that was read or written, in whole or in
// part - these values are logged, persisted with a session and rendered in two
// user interfaces.
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
 * Why a restore was withheld beside another session's claim on the same
 * bytes, as the `details.reason` of {@link claimRefusal}.
 *
 * - `claim-unplaced` — the claimant's project could not be resolved, so the
 *   bytes may be its live patch of this very file.
 * - `claim-over-another-original` — the claimant is placed at this file, but
 *   its chain started from a different pristine file than this record's, so
 *   neither session's backups can stand in for the other's.
 */
type ClaimRefusalReason = 'claim-unplaced' | 'claim-over-another-original';

/**
 * The error for a restore withheld because another session holds the bytes it
 * would replace: code `CLEANUP_PARTIAL`, identifiers only.
 *
 * Recorded as the pass's failure for the record, which stays open with its
 * status untouched, as does every record beneath it in its chain, and every
 * backup is kept: the other session's own cleanup settles the file, and the
 * next pass over this record then finds it at a recorded digest again.
 *
 * @param record The record whose restore was withheld.
 * @param holders The other sessions' records the refusal stands on.
 * @param reason Which half of the rule refused.
 */
function claimRefusal(
  record: ModificationRecord,
  holders: readonly ModificationRecord[],
  reason: ClaimRefusalReason,
): DebuggenError {
  const holderSessionIds = sessionIdsOf(holders);
  const sessions = holderSessionIds.join(', ');

  return new DebuggenError(
    'CLEANUP_PARTIAL',
    reason === 'claim-unplaced'
      ? 'Another session has a live modification of the same file with the same bytes, and this pass cannot tell which project it belongs to, so nothing was restored.'
      : 'Another session has a live modification over the bytes this restore would replace, and it was instrumented from a different original, so nothing was restored.',
    {
      hint: `End session ${sessions} first: its cleanup restores the file, and the next pass closes this record. Nothing was written and every backup was kept.`,
      details: {
        reason,
        recordId: record.id,
        sessionId: record.sessionId,
        file: record.file,
        holderRecordIds: holders.map((holder) => holder.id),
        holderSessionIds,
      },
    },
  );
}

/**
 * The error for a claim check whose listing of the other sessions' open
 * records failed: code `STORE_ERROR`, with the journal's own error as the
 * cause.
 *
 * Without the listing, a `restorable` verdict cannot be told apart from
 * another session's identical bytes, so the write is refused rather than made
 * blind; the record stays open with its status untouched.
 *
 * @param record The record whose restore was withheld.
 * @param cause The journal's error.
 */
function claimsUnreadable(record: ModificationRecord, cause: DebuggenError): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The open modifications of other sessions could not be read, so a restore was not written.',
    {
      hint: 'Nothing was written and the backup was kept. The record stays open and is reconciled by the next pass that can read the modification journal.',
      details: {
        reason: 'open-records-unreadable',
        recordId: record.id,
        sessionId: record.sessionId,
        file: record.file,
        cause: cause.code,
      },
      cause,
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
// in the voice of the edited-file conflict message: "<file> was edited while
// instrumented. Debug Generator will not overwrite it. Original saved at
// <backup path>." The detector composes that one; these cover the situations
// only a restore reaches. A caller with more context - the service, which
// knows the session and the action to offer - overrides them through
// `conflictMessage`.
// ---------------------------------------------------------------------------

/**
 * Where the wording tells the developer the file's pristine original is: the
 * chain root's backup for a chained record whose root the pass resolved, and
 * the record's own backup otherwise.
 *
 * A chained record's own backup is the previous plan version's instrumented
 * output, so a sentence that called it "the original" would send the
 * developer to bytes that still carry the tool's wrapper. The same gate the
 * conflict report applies decides, so the message and the report's
 * `originalBackupPath` can never name two different files.
 */
function pristineBackupPathOf(
  record: ModificationRecord,
  chainRoot: ModificationRecord | undefined,
): string {
  return chainRoot !== undefined && isUsableChainRoot(record, chainRoot)
    ? chainRoot.backupPath
    : record.backupPath;
}

/**
 * A file that already holds the bytes this record replaced, for a record that
 * was applied.
 *
 * For an unchained record those bytes are the pristine original. For a chained
 * one they are an earlier plan version's instrumented output, which is still
 * this tool's to restore, so the wording says so and points at the chain
 * root's backup for the pristine file.
 */
function pristineTargetMessage(
  record: ModificationRecord,
  chainRoot: ModificationRecord | undefined,
): string {
  const pristine = pristineBackupPathOf(record, chainRoot);

  if (pristine !== record.backupPath) {
    return `${record.file} no longer holds the instrumented content: it currently matches the content this modification replaced — an earlier plan version's instrumented output — so no content was lost, but the change did not come from this tool. The record is kept open and the original from before this file was first instrumented stays at ${pristine}.`;
  }

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
function missingDirectoryMessage(
  record: ModificationRecord,
  chainRoot: ModificationRecord | undefined,
): string {
  return `${record.file} and the directory containing it are gone, so Debug Generator did not recreate it. The original is still at ${pristineBackupPathOf(record, chainRoot)}; the modification record is ${record.id}.`;
}

/** A file written by something else between the verdict and the restore. */
function concurrentWriteMessage(
  record: ModificationRecord,
  staleReason: string | undefined,
  chainRoot: ModificationRecord | undefined,
): string {
  const observed =
    staleReason === undefined
      ? 'while it was being restored'
      : `while it was being restored (${staleReason})`;

  return `${record.file} changed ${observed}, so Debug Generator will not overwrite it. Nothing was written and the original is still at ${pristineBackupPathOf(record, chainRoot)}.`;
}

/**
 * A record of a file whose records do not form a single chain.
 *
 * Names the record's own backup, which is what a developer untangling the fork
 * by hand needs per record, and — for a chained record — the pristine original
 * it descends from, which is what restoring the file by hand needs.
 */
function chainForkMessage(
  record: ModificationRecord,
  fork: ChainFork,
  chainRoot: ModificationRecord | undefined,
): string {
  const shape =
    fork.sharedPreviousRecordIds.length > 0
      ? 'two or more of its modification records are layered on the same earlier record'
      : 'it has more than one open chain of modification records';
  const pristine = pristineBackupPathOf(record, chainRoot);
  const pristineClause =
    pristine === record.backupPath
      ? ''
      : ` The original from before this file was first instrumented is at ${pristine}.`;

  return `${record.file} was not restored: ${shape}, so Debug Generator cannot tell which of them the file holds and did not write to it. Every backup was kept; this record's original is at ${record.backupPath} and the modification record is ${record.id}.${pristineClause}`;
}
