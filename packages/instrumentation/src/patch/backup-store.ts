/**
 * The backup store: the only place a developer's original file bytes are kept
 * while this product holds an edit over them.
 *
 * Everything the reversibility promise rests on is here. Before the patcher
 * writes one byte into a working tree it hands the original bytes to this
 * module, which copies them outside every checkout, under the product's own
 * state directory, at a path whose **file name is the digest of its content**:
 *
 * ```text
 * <debuggenHome>/backups/<sessionId>/<originalHash>
 * ```
 *
 * No extension, no nesting below the session, no metadata file beside it. The
 * patcher records that path verbatim in `ModificationRecord.backupPath`
 * (`../schema/modification.ts`), the reconciliation pass reads it back at
 * start-up, and cleanup restores from it — so if a backup is missing,
 * truncated, re-encoded or silently replaced, the original cannot be restored
 * and the promise is broken. Every decision below is made in that light.
 *
 * ## The journaled path is where a backup is, within its own session
 *
 * The journal lets a record's `backupPath` change after it was written
 * (`ModificationStatusPatch.backupPath`): a conflict backup can be moved aside,
 * into a quarantine directory, and the record then says where it went so the
 * developer is pointed at the right file. A restore that recomposed the path
 * from the digest would miss a relocated backup, report it missing and strand
 * the patched file. So the operations that act *for a record* —
 * {@link BackupStore.locateRecorded}, {@link BackupStore.readRecorded} and
 * {@link BackupStore.removeRecorded} — take the recorded path and resolve it
 * under one policy:
 *
 * | The recorded path is | It resolves to | Source |
 * | --- | --- | --- |
 * | the path this store composes for the digest | that path | `composed` |
 * | an absolute, normalised path **inside this session's own directory**, in a subdirectory of it, whose file name is the record's digest | the recorded path | `relocated` |
 * | anything else — another session's directory, another state root, a traversal, a path outside the tree | the path this store composes | `substituted` |
 *
 * A relocation is bound to the record twice over: to its **session**, because
 * a store acts only inside its own session's directory — so one session's
 * record can never read, or delete, a backup another session still holds —
 * and to its **digest**, because every backup is filed under the digest of its
 * content and a relocated one keeps that name. It must sit in a subdirectory,
 * never directly in the session directory: that level is where the composed
 * backups live, and it is the only level
 * {@link BackupStore.removeSessionDirectory}'s non-recursive sweep touches, so a
 * relocated backup is never swept with them.
 *
 * A relocated backup is reached through `pinPrivateFileWithinRoot` from
 * `@debuggen/shared/node`: every directory from the state root down is opened
 * relative to the one above it without following a link and held to the
 * store's ownership and permission policy **through the descriptor it opened**,
 * and the read and the unlink then go through that descriptor. A directory
 * swapped for a link after the check therefore cannot redirect either one out
 * of the tree (CWE-367). Before a relocated backup is deleted its bytes are
 * read through the same handle and must hash to the record's digest, and the
 * entry must still be the one that was read. A recorded path outside those
 * bounds is never opened at all: the store reads its own content-addressed
 * location for the digest instead, which is what a record written against a
 * state directory that has since moved needs, and which can only ever yield
 * bytes the caller then checks against `originalHash`. In no case does a string
 * from the journal reach a filesystem call outside this session's own backup
 * directory.
 *
 * ## Guarantees
 *
 * 1. **Byte fidelity.** Bytes in, the same bytes out. Content is accepted as a
 *    `Uint8Array` and returned as a `Buffer`; nothing is ever decoded to text
 *    on the way in or out, so line endings, encodings that are not UTF-8 and a
 *    leading byte-order mark all survive. A string overload is deliberately
 *    *not* offered: it would put an encoding decision in the one module that
 *    must not make one. This is the same literalness the digest helpers in
 *    `@debuggen/shared/node` are built on, and the two only agree because of
 *    it.
 * 2. **Private by construction.** The session directory is created `0700` and
 *    every backup file `0600`, through the hardened primitives in
 *    `@debuggen/shared/node` — `ensureSecureDir`, which creates each missing
 *    directory at `SECURE_DIR_MODE` and **refuses** (`FS_UNSAFE_PATH`,
 *    `group-or-other-permissions`) a state root, `backups` directory or session
 *    directory that already exists with group or other access rather than
 *    tightening it, and `createFileExclusive`, which applies
 *    {@link SECURE_FILE_MODE} twice so the result does not depend on the
 *    process umask. Such a refusal leaves no backup, so the patcher never
 *    writes the source file it was meant to protect. Nothing here widens
 *    either mode, and no octal literal appears in this file.
 * 3. **Durable before it is reported.** `createFileExclusive` writes every byte
 *    (a single `write` may be partial) and `fsync`s the descriptor before it
 *    returns, so a resolved {@link BackupStore.put} means the bytes are on
 *    disk. AAP §0.5.1 requires exactly that ordering: the journal row that
 *    points at a backup is written *after* the backup is durable, and the
 *    patcher depends on it. A plain write here would leave a recoverable crash
 *    unrecoverable.
 * 4. **Nothing is ever overwritten.** Creation is exclusive and refuses to
 *    follow a symbolic link. An existing file at the composed path is verified,
 *    never replaced — see the next section.
 * 5. **Nothing is ever deleted implicitly.** There is no TTL, no sweep, no
 *    "tidy up while we are here". A backup disappears only when a caller names
 *    it, which is what keeps a conflict backup available until the developer
 *    resolves the conflict (AAP §0.5.1) and leaves time-based purging to the
 *    service's own retention pass.
 *
 * ## Why an existing backup is verified rather than rewritten
 *
 * The file name *is* the digest of the content, so a second request to store
 * the same digest is a request to store the same bytes. That happens
 * legitimately: a follow-up question produces a new plan version whose delta
 * touches a file an earlier version already patched, and both versions see the
 * same original content. Treating the collision as success — **after** reading
 * the existing file and confirming it hashes to the name it is filed under — is
 * therefore the correct behaviour and not a workaround, and it is what makes
 * the store idempotent enough for a cleanup retry to be safe.
 *
 * A digest that does *not* match is a different situation entirely: the store's
 * central invariant is broken, so {@link BackupStore.put} refuses, keeps the
 * file it found and reports `STORE_ERROR`. Overwriting it would destroy the
 * only copy of some other content this session may still have to restore.
 *
 * Note which errno a planted symbolic link produces, because the two
 * primitives differ deliberately: `O_EXCL` takes precedence over `O_NOFOLLOW`,
 * so `createFileExclusive` reports an existing link as `EEXIST`, while the
 * no-follow read this module then performs reports it as `ELOOP`. Either way
 * the link is refused, its target is left untouched, and no byte of it is
 * trusted.
 *
 * ## Error policy
 *
 * Policy failures — a string this module will not turn into a path, a digest
 * that disagrees with the bytes it names, a backup that is not there when one
 * was required, a delete whose precondition was not met — come back as
 * `Result<T, DebuggenError>` with a code from the closed tuple in
 * `@debuggen/shared`: `FS_UNSAFE_PATH` for a refused path segment,
 * `STORE_ERROR` for a broken store invariant, `CLEANUP_PARTIAL` for a removal
 * that could not be completed. Each carries a `details.reason` from
 * {@link BackupStoreFailureReason}, so a caller branches on a value instead of
 * parsing a message.
 *
 * Everything else — `ELOOP`, `EACCES`, `EISDIR`, `ENOSPC`, `EROFS` — is thrown
 * with its errno intact, which is the policy `@debuggen/shared/node` documents
 * for itself: only *policy* failures are wrapped, because a caller deciding
 * what to do next needs the platform's own code and not a paraphrase of it.
 * `ENOENT` is the one errno this module does interpret, and only where its
 * meaning is a product state rather than a surprise: "the backup a record
 * points at is gone" is something cleanup has to report, and "there was nothing
 * to delete" is what makes a retry a no-op.
 *
 * ## Asynchronous surface, synchronous primitives
 *
 * Every method that touches a filesystem returns a `Promise`; only
 * {@link BackupStore.locate}, which is pure string work, is synchronous. The
 * port is asynchronous so that a substitute — an in-memory fake in a suite, a
 * different backing store later — is not forced to be synchronous, and so that
 * every failure, policy or errno, reaches the caller through the promise.
 *
 * The primitives underneath are another matter: `@debuggen/shared/node` is
 * synchronous *by design*, because the write sequence a backup belongs to is
 * crash-ordered and interleaving other work between its steps only widens the
 * window in which a crash is ambiguous. Awaiting between steps does not reorder
 * them, so the recovery contract is untouched. Where this module needs an
 * operation those primitives do not cover — asking whether a path exists,
 * unlinking, listing and removing the session directory — it uses
 * `node:fs/promises` directly, which is genuinely asynchronous; where it uses a
 * synchronous primitive it runs it through {@link onPromiseBoundary}, so a
 * blocking read or write never happens in the caller's own turn. The one
 * deliberate exception is the deletion of a relocated backup, which pins its
 * directory, reads and hashes the backup and unlinks it in **one** synchronous
 * step: an `await` between the check and the unlink is exactly the window a
 * swapped directory needs.
 *
 * ## What is deliberately not here
 *
 * - **Configuration.** `debuggenHome` and `sessionId` are injected. This module
 *   reads no environment variable and imports no config: resolving
 *   `$DEBUGGEN_HOME` belongs to the service's configuration module, exactly as
 *   `@debuggen/shared/node` avoids `node:os` and `process.env` for the same
 *   reason — and it is what lets every suite point a store at a directory from
 *   `mkdtemp`.
 * - **Project paths.** This store owns the backup tree and nothing else. It
 *   never reads, writes or hashes a file inside a developer's project; the
 *   patcher and cleanup do that through the conditional, no-clobber writers
 *   of `@debuggen/shared/node` and the digest helpers. The one place the two
 *   meet is
 *   {@link RemoveBackupOptions.restoredContentHash}, where a caller hands over
 *   the digest it computed of the content it restored and this store refuses
 *   the delete unless it matches — "delete only after verification", enforced
 *   rather than remembered.
 * - **Recursive deletion.** {@link BackupStore.removeSessionDirectory} unlinks
 *   the backups it recognises and then removes the empty directory. It refuses
 *   to delete anything it did not create, refuses to act outside
 *   `<debuggenHome>/backups/<sessionId>`, and reports what it left behind.
 * - **Journalling.** Nothing here opens a database. The record that points at a
 *   backup is written by the service's repository behind the journal port
 *   declared in `../schema/modification.ts`.
 * - **Load-time work.** The package declares `sideEffects: false` and this
 *   module honours it: importing it creates no directory, touches no disk and
 *   reads no global.
 */

import { lstatSync, unlinkSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';

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
  ok,
  relativePosix,
  toPosix,
} from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';
import {
  SECURE_FILE_MODE,
  assertSecureDir,
  createFileExclusive,
  ensureSecureDir,
  isSameFileIdentity,
  pinPrivateFileWithinRoot,
  readFileNoFollow,
  readFileSnapshotNoFollow,
  sha256Hex,
} from '@debuggen/shared/node';
import type { PinnedFile } from '@debuggen/shared/node';

import { SHA256_HEX_PATTERN, sha256HexSchema } from '../schema/modification.js';

/**
 * The single directory level between the state root and a session's backups.
 *
 * Named once here because the layout is a contract, not a convention: the
 * recorded `backupPath` of every modification is built from it, the service's
 * retention pass walks it, and `docs/SECURITY.md` tells the developer where to
 * look. A second spelling of it anywhere would strand the backups of one
 * release from the next.
 */
const BACKUPS_DIRECTORY_NAME = 'backups';

/**
 * The longest string this store will interpolate into a path as one component.
 *
 * It bounds both dynamic parts of the layout: a session id, which
 * `newSessionId()` in `@debuggen/shared` mints as a short `ses_…` form and the
 * modification schema caps at the same order of magnitude, and a digest, which
 * is always 64 characters. The limit exists so an absurd value is refused here
 * — before a syscall meets `ENAMETOOLONG` halfway through a write sequence —
 * and it is generous enough that a session read back from an older store, or
 * invented by a fixture, still passes.
 */
const MAX_PATH_SEGMENT_LENGTH = 128;

/**
 * The longest recorded `backupPath` this store will treat as a relocation.
 *
 * The same bound the modification schema puts on the field — the conventional
 * `PATH_MAX` on Linux — so a record that bypassed the schema cannot hand a
 * syscall a path it would refuse with `ENAMETOOLONG` halfway through a restore.
 * A longer string is not an error: it is simply not a relocation, and the
 * store's own location for the digest is used instead.
 */
const MAX_RECORDED_PATH_LENGTH = 4096;

/**
 * How many retained entry names a failed {@link BackupStore.removeSessionDirectory}
 * reports.
 *
 * The names are digests and the count may be large, so the error carries a
 * bounded sample plus the total rather than an unbounded array: the details of
 * a `DebuggenError` are logged, persisted with a session and rendered in two
 * user interfaces.
 */
const MAX_REPORTED_RETAINED_ENTRIES = 20;

/**
 * Why this store refused an operation, recorded as `details.reason` on the
 * error so a caller can branch or report without parsing a message.
 *
 * - `unsafe-path-segment` — a `sessionId` or `originalHash` that is not a safe
 *   single path component: a separator, a drive or stream colon, a `.` or `..`
 *   segment, a control character (a `NUL` truncates a path at the C library, so
 *   the path a syscall acts on would not be the path that was validated), a
 *   blank string or one past its length limit.
 * - `not-a-digest` — a string that is a safe path component but is not the
 *   64-lowercase-hexadecimal form `sha256Hex()` produces. This store files
 *   content under its digest and under nothing else, so a name of any other
 *   shape is refused rather than created.
 * - `content-digest-mismatch` — the bytes handed to {@link BackupStore.put} do
 *   not hash to the `originalHash` they were to be filed under. Refused at the
 *   door: a mislabelled backup would be trusted at restore time and would
 *   overwrite a developer's file with foreign content.
 * - `stored-digest-mismatch` — a stored backup (at the composed path, or a
 *   relocated one about to be deleted) does not hash to its own name, so the
 *   store's invariant is broken. The file is kept and never overwritten.
 * - `backup-missing` — an operation that required a backup found none.
 * - `backup-replaced` — a relocated backup's directory entry changed between
 *   the read that verified it and the unlink that would have deleted it, or —
 *   on a platform that cannot address a directory descriptor as a path — the
 *   directory that was judged no longer sits at its path. Nothing is read from
 *   or deleted at that path: what is there now is not what was verified.
 * - `restored-content-digest-mismatch` — a caller asked to delete a backup and
 *   declared the digest of the content it restored, and the two disagree. The
 *   backup is retained, because it is still the only copy of the original.
 * - `session-directory-not-emptied` — the session's backup directory held
 *   something this store did not create, or could not be removed, so it is
 *   left in place and reported.
 */
export type BackupStoreFailureReason =
  | 'unsafe-path-segment'
  | 'not-a-digest'
  | 'content-digest-mismatch'
  | 'stored-digest-mismatch'
  | 'backup-missing'
  | 'backup-replaced'
  | 'restored-content-digest-mismatch'
  | 'session-directory-not-emptied';

/**
 * The errno code of a caught value, when it carries one.
 *
 * `catch` binds `unknown`, and the only reason this module inspects a caught
 * error is to tell the two conditions it has an opinion about — "nothing is
 * there" (`ENOENT`) and "something already is" (`EEXIST`) — apart from every
 * other failure, which is rethrown untouched with its own code. Written the
 * same way as its counterpart in `@debuggen/shared/node`, because a second,
 * subtly different reading of `error.code` is how one of the two starts
 * misclassifying a refusal as a success.
 */
function errnoCodeOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code: unknown = value.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Runs blocking, synchronous filesystem work after yielding to the microtask
 * queue.
 *
 * The primitives this store writes and reads through are synchronous by design
 * (see this module's overview), while its own surface is asynchronous so that
 * the port stays substitutable. This helper is the join between the two: the
 * `await` means a caller's turn is never spent inside a file read or an `fsync`
 * — which is what any `Promise`-returning method implies — and it keeps the
 * failure channel uniform, since work performed after the yield can only fail
 * by rejecting the promise that was already handed back.
 *
 * @param work The synchronous operation to perform.
 * @returns A promise for the operation's value, rejected with whatever it
 * threw.
 */
async function onPromiseBoundary<T>(work: () => T): Promise<T> {
  await Promise.resolve();
  return work();
}

/**
 * Whether a string contains a C0 control character, `DEL` or a C1 control
 * character.
 *
 * Scanned by character code rather than matched with a regular expression: a
 * literal control range in a pattern trips ESLint's `no-control-regex`, and the
 * intent — no unprintable byte may reach a filesystem call, a log line or a
 * user interface — reads more plainly as a predicate. `NUL` is the case that
 * matters most, because a path containing one is truncated by the C library at
 * the `NUL`, so the path a syscall acts on is not the path that was validated.
 *
 * The same rule is applied to the same two values by the modification schema,
 * which validates them as *data*; this is the half that applies before they
 * become a *path*.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }

  return false;
}

/**
 * Whether `value` is usable as exactly one path component.
 *
 * The rule is deliberately narrower than "a legal file name", because every
 * value this predicate guards is interpolated into a path under the product's
 * own state root and none of them has any business carrying structure:
 *
 * - non-blank, and no longer than `maxLength`;
 * - no `/` and no `\`, so it cannot introduce a level;
 * - no `:`, which on Windows separates a drive letter and names an alternate
 *   data stream, and which nothing this store files has a use for;
 * - not `.` and not `..`, the two names that would move the composed path
 *   rather than extend it;
 * - no control character, per {@link hasControlCharacter}.
 *
 * A value that passes cannot change which directory a composition lands in,
 * which is what makes the lexical join in {@link resolveBackupPath} safe
 * without a containment re-check on every call.
 */
function isSafePathSegment(value: string, maxLength: number): boolean {
  if (value.length === 0 || value.length > maxLength || value.trim().length === 0) {
    return false;
  }

  if (value === '.' || value === '..') {
    return false;
  }

  if (value.includes('/') || value.includes('\\') || value.includes(':')) {
    return false;
  }

  return !hasControlCharacter(value);
}

/**
 * The error a refused path segment produces: code `FS_UNSAFE_PATH`, reason
 * `unsafe-path-segment`.
 *
 * `FS_UNSAFE_PATH` is the product's code for "a path this tool will not use",
 * which is exactly what a refusal here is — the value never becomes a path, so
 * no other code in the closed vocabulary describes it. The offending value is
 * *not* copied into the details: it is unvalidated input, and the details of an
 * error are logged, persisted and rendered. The `field` and the length are
 * enough to find the caller's mistake.
 */
function unsafeSegment(field: 'sessionId' | 'originalHash', value: string): DebuggenError {
  return new DebuggenError(
    'FS_UNSAFE_PATH',
    `A backup ${field} must be a single safe path component: no separator, no ".." segment and no control character.`,
    {
      hint: 'This is a caller or stored-record defect rather than a filesystem condition; the value was refused before any path was composed.',
      details: { reason: 'unsafe-path-segment', field, length: value.length },
    },
  );
}

/**
 * The error a name that is not a digest produces: code `FS_UNSAFE_PATH`, reason
 * `not-a-digest`.
 *
 * Built from the message the shared `sha256HexSchema` carries, so the store and
 * the schema say the same thing about the same shape. The value is omitted from
 * the details for the reason given on {@link unsafeSegment}; a digest is not
 * secret, but a string that failed this check is not known to be a digest.
 */
function notADigest(field: 'originalHash' | 'restoredContentHash'): DebuggenError {
  return new DebuggenError(
    'FS_UNSAFE_PATH',
    `A backup ${field} must be a SHA-256 digest written as 64 lowercase hexadecimal characters.`,
    {
      hint: 'Hashes are produced by sha256Hex()/sha256OfFile() in @debuggen/shared/node, which return exactly that form.',
      details: { reason: 'not-a-digest', field },
    },
  );
}

/**
 * The absolute directory a session's backups live in:
 * `<debuggenHome>/backups/<sessionId>`.
 *
 * Composed with the POSIX helpers from `@debuggen/shared` rather than
 * `node:path`, so the result is the same string on every platform and can be
 * compared with {@link isWithin} without a separator conversion first. Both
 * dynamic parts have already passed {@link isSafePathSegment} by the time this
 * runs, so the normalisation inside `joinPosix` has no `..` to resolve and the
 * result cannot leave the state root.
 */
function resolveSessionDirectory(debuggenHomePosix: string, sessionId: string): string {
  return joinPosix(debuggenHomePosix, BACKUPS_DIRECTORY_NAME, sessionId);
}

/**
 * The absolute path of one backup: the session directory and the digest, with
 * no extension and no further nesting.
 *
 * This is the exact string the patcher records in
 * `ModificationRecord.backupPath` and the exact string cleanup reads back, so
 * the composition lives here and callers never build it themselves — a second
 * spelling is a backup nobody can find.
 */
function resolveBackupPath(sessionDirectory: string, originalHash: string): string {
  return joinPosix(sessionDirectory, originalHash);
}

/**
 * What a verified backup is: where it is, what it holds, and how much of it
 * there is.
 *
 * Returned by {@link BackupStore.verify} and extended by {@link StoredBackup}.
 * The digest is echoed back rather than merely confirmed so that a caller
 * threading this value into a `ModificationRecord` has both fields from one
 * place.
 */
export interface BackupVerification {
  /**
   * The backup's absolute path, POSIX separators, suitable for
   * `ModificationRecord.backupPath` verbatim.
   */
  readonly path: string;

  /**
   * The digest of the bytes stored there — 64 lowercase hexadecimal characters
   * — which is also the file's name. Confirmed by reading the file, not assumed
   * from its name.
   */
  readonly originalHash: string;

  /** How many bytes the backup holds. */
  readonly byteLength: number;
}

/** The outcome of {@link BackupStore.put}. */
export interface StoredBackup extends BackupVerification {
  /**
   * Whether an identical backup was already on disk and was adopted instead of
   * created.
   *
   * `true` is a normal, expected outcome: because a backup is filed under the
   * digest of its content, two plan versions that see the same original bytes
   * name the same file. It is surfaced rather than hidden so a suite can assert
   * which path it took, and so a log line can say so.
   */
  readonly reused: boolean;
}

/** Options for {@link BackupStore.remove}. */
export interface RemoveBackupOptions {
  /**
   * The digest of the content the caller restored, if it is deleting the backup
   * because a restoration succeeded.
   *
   * When given, the delete happens **only** if this equals the `originalHash`
   * the backup is filed under; otherwise the backup is retained and
   * `CLEANUP_PARTIAL` is returned. That is AAP §0.5.1's "backups of
   * successfully restored files are deleted after the restored content's hash
   * is verified" turned into a precondition this store enforces, instead of a
   * step a caller has to remember.
   *
   * Omit it to delete unconditionally — which is right for a backup whose
   * record was closed because nothing was ever written, and for a caller that
   * has already reported a conflict and been told by the developer to discard
   * it.
   */
  readonly restoredContentHash?: string | undefined;
}

/**
 * How a record's recorded `backupPath` was resolved by
 * {@link BackupStore.locateRecorded}.
 *
 * - `composed` — the recorded path is exactly the one this store composes for
 *   the digest: the ordinary case, and the only one a patcher ever writes.
 * - `relocated` — the recorded path differs, and is an absolute, normalised
 *   path in a subdirectory of this session's own backup directory whose file
 *   name is the record's digest: the backup was moved aside within the
 *   session's own tree and the record says where. It is used as recorded.
 * - `substituted` — the recorded path is not one this store will open (another
 *   session's directory, another state root, a traversal, a file not named by
 *   its digest, a relative or control-character path). It is never touched;
 *   the store's own composed location for the digest is used in its place.
 *
 * Frozen because it is a module-level table consumers may switch over.
 */
export const RECORDED_BACKUP_SOURCES = Object.freeze([
  'composed',
  'relocated',
  'substituted',
] as const);

/** One of {@link RECORDED_BACKUP_SOURCES}. */
export type RecordedBackupSource = (typeof RECORDED_BACKUP_SOURCES)[number];

/** Where the backup a record names is, as {@link BackupStore.locateRecorded} resolved it. */
export interface RecordedBackupLocation {
  /**
   * The absolute path the store acts on, POSIX separators: always inside
   * `<debuggenHome>/backups`.
   */
  readonly path: string;

  /** Why this path and not another. See {@link RecordedBackupSource}. */
  readonly source: RecordedBackupSource;
}

/** The outcome of {@link BackupStore.readRecorded}. */
export interface RecordedBackup extends RecordedBackupLocation {
  /**
   * The backup's bytes, exactly as stored. **Not** checked against the digest
   * here, for the reason given on {@link BackupStore.read}; the caller hashes
   * them before it trusts them.
   */
  readonly bytes: Buffer;
}

/**
 * The port every consumer of the backup tree talks to: the patcher when it
 * records a file's original bytes, the conflict detector and cleanup when they
 * restore or discard them, and the suites that substitute it.
 *
 * ## Shape of the contract
 *
 * Small and explicit on purpose. Six digest-keyed operations — locate, put,
 * read, has, verify, remove — three that act for a journal record through its
 * recorded path — locateRecorded, readRecorded, removeRecorded — the removal
 * of the session directory, and two read-only properties are enough for the
 * whole reversibility sequence, and each one names the guarantee it makes
 * rather than the syscall it performs. The patcher files a backup by digest;
 * everything that restores or discards one on a record's behalf goes through
 * the record's path, because that is what the journal says and what it may
 * have been updated to say.
 *
 * Every filesystem operation returns a `Promise`; {@link BackupStore.locate} is
 * synchronous because it is pure string work and touches nothing. Expected
 * failures arrive as `err(DebuggenError)` with a
 * {@link BackupStoreFailureReason} in `details.reason`; a filesystem condition
 * this store has no opinion about is thrown with its errno intact. This
 * module's overview sets out both halves of that policy in full, and an
 * implementation that swaps them around is not a substitute for this port.
 *
 * ## What an implementation must guarantee
 *
 * - bytes are stored and returned verbatim — no decoding, no line-ending or
 *   encoding normalisation;
 * - a backup is durable before `put` resolves;
 * - an existing backup is never overwritten and never followed through a
 *   symbolic link;
 * - nothing is deleted except when a method is called for it, and deleting
 *   something that is already gone succeeds.
 */
export interface BackupStore {
  /** The session whose backups this store owns. */
  readonly sessionId: string;

  /**
   * The absolute directory this store's backups live in:
   * `<debuggenHome>/backups/<sessionId>`, POSIX separators.
   *
   * Exposed for logs, for the conflict message that tells a developer where
   * their original is, and for the suites that assert the directory's mode.
   * Reading it creates nothing: the directory is created on the first
   * {@link BackupStore.put}.
   */
  readonly sessionDirectory: string;

  /**
   * Where a backup for `originalHash` is, or would be.
   *
   * Pure: it validates and composes, and never asks the filesystem anything —
   * so a resolved path says nothing about whether a file is there. Use it to
   * record or display a path, and {@link BackupStore.has} or
   * {@link BackupStore.verify} to ask about the file.
   *
   * @param originalHash The digest the backup is filed under: 64 lowercase
   * hexadecimal characters.
   * @returns The absolute path, or `FS_UNSAFE_PATH` when the digest is not a
   * safe path component (`unsafe-path-segment`) or not a digest at all
   * (`not-a-digest`).
   */
  locate(originalHash: string): Result<string>;

  /**
   * Where the backup a journal record names is, under the policy in this
   * module's overview.
   *
   * Pure, like {@link BackupStore.locate}: it validates and composes and asks
   * the filesystem nothing. The recorded path is accepted as a relocation only
   * when it is an absolute, normalised path with no control character, inside
   * a subdirectory of this store's own session directory, whose file name is
   * `originalHash`; any other recorded path is replaced by the store's own
   * composed location for the digest and reported as `substituted`, so the
   * answer is always a path inside this session's own backup directory.
   *
   * @param recordedPath The record's `backupPath`, as the journal holds it.
   * @param originalHash The record's `originalHash`.
   * @returns The resolved location, or `FS_UNSAFE_PATH` when the digest is not
   * a safe path component or not a digest, exactly as
   * {@link BackupStore.locate} reports it.
   */
  locateRecorded(recordedPath: string, originalHash: string): Result<RecordedBackupLocation>;

  /**
   * Stores `content` as the backup for `originalHash`, creating the session
   * directory if it is not there yet.
   *
   * The session directory is created `0700` and the file `0600`, every byte is
   * written and `fsync`ed before this resolves, an existing identical backup is
   * adopted, and nothing is ever overwritten. The digest of `content` is
   * checked against `originalHash` first, because a mislabelled backup is worse
   * than no backup: it would be restored over a developer's file as if it were
   * the original.
   *
   * @param originalHash The digest of `content`, which becomes the file's name.
   * @param content The original bytes, stored verbatim.
   * @returns The stored backup, with `reused` saying whether it was created or
   * adopted. `FS_UNSAFE_PATH` for a refused digest; `STORE_ERROR` when
   * `content` does not hash to `originalHash` (`content-digest-mismatch`) or
   * when a file already at the path does not hash to its own name
   * (`stored-digest-mismatch`).
   * @throws The runtime's own filesystem error, with its `code` intact —
   * `ELOOP` for a symbolic link planted at the path, `EISDIR`, `EACCES`,
   * `ENOSPC` — and `DebuggenError` with `FS_UNSAFE_PATH` when the state
   * directory itself fails the ownership and permission policy of
   * `@debuggen/shared/node`.
   */
  put(originalHash: string, content: Uint8Array): Promise<Result<StoredBackup>>;

  /**
   * The bytes of the backup filed under `originalHash`, exactly as stored.
   *
   * Read without following a symbolic link at the final component, so a link
   * planted at the path is refused with `ELOOP` rather than yielding
   * attacker-chosen bytes. The digest is *not* re-checked here — use
   * {@link BackupStore.verify} for that — because a caller that only wants to
   * write the bytes back and hash the result should not pay for two reads.
   *
   * @param originalHash The digest the backup is filed under.
   * @returns The bytes, or `STORE_ERROR` with `backup-missing` when nothing is
   * there.
   * @throws The runtime's own filesystem error for any other condition:
   * `ELOOP`, `EISDIR`, `EACCES`.
   */
  read(originalHash: string): Promise<Result<Buffer>>;

  /**
   * The bytes of the backup a journal record names, read from where the record
   * says it is.
   *
   * The read restoration and conflict detection perform, because a record's
   * `backupPath` may have been updated since the patcher wrote it and a read by
   * digest alone would report a relocated backup as missing. A `composed` or
   * `substituted` location is read exactly as {@link BackupStore.read} reads
   * it. A `relocated` one is read through a pinned handle: every directory from
   * the state root down to its parent is opened relative to the one above it
   * without following a link and held to the state-directory policy of
   * `@debuggen/shared/node` — real directories, owned by this account, no group
   * or other permissions — through the descriptor that was opened, and the
   * final component is then read through that descriptor without following a
   * link, so no directory swapped after the check can redirect the read. The
   * digest is not re-checked here, for the reason given on
   * {@link BackupStore.read}.
   *
   * @param recordedPath The record's `backupPath`.
   * @param originalHash The record's `originalHash`.
   * @returns The bytes and where they came from. `STORE_ERROR` with
   * `backup-missing` when nothing is there (or the relocated backup's directory
   * is gone), or with `backup-replaced` when the judged directory of a
   * relocated backup has moved on a platform whose pin detects rather than
   * prevents a swap; `FS_UNSAFE_PATH` for a refused digest or when a directory
   * above a relocated backup fails the state-directory policy. In each of those
   * cases the backup is not opened.
   * @throws The runtime's own filesystem error for any other condition:
   * `ELOOP` for a symbolic link at the final component, `EISDIR`, `EACCES`,
   * `ENOTDIR`.
   */
  readRecorded(recordedPath: string, originalHash: string): Promise<Result<RecordedBackup>>;

  /**
   * Whether a usable backup file is filed under `originalHash`.
   *
   * `true` only for a regular file. Something else at that path — a directory,
   * a symbolic link — answers `false`, and a following
   * {@link BackupStore.put} will refuse it rather than write through it, so a
   * `false` here never becomes a silent overwrite.
   *
   * @param originalHash The digest the backup would be filed under.
   * @returns Whether a regular file is there, or `FS_UNSAFE_PATH` for a refused
   * digest.
   * @throws The runtime's own filesystem error when the path cannot be
   * inspected for a reason other than its absence.
   */
  has(originalHash: string): Promise<Result<boolean>>;

  /**
   * Reads the backup filed under `originalHash` and confirms it hashes to that
   * digest.
   *
   * This is the check the reversibility promise is measured by, so it is done
   * by reading the bytes rather than by trusting the file's name. Cleanup calls
   * it before it restores; a suite calls it to assert a backup survived
   * untouched.
   *
   * @param originalHash The digest the backup is filed under and must hash to.
   * @returns The verified backup, or `STORE_ERROR` with `backup-missing` when
   * nothing is there or `stored-digest-mismatch` when the content disagrees
   * with its name.
   * @throws The runtime's own filesystem error, as {@link BackupStore.read}.
   */
  verify(originalHash: string): Promise<Result<BackupVerification>>;

  /**
   * Deletes the backup filed under `originalHash`, and only when asked.
   *
   * Idempotent: deleting a backup that is not there succeeds with `false`, so a
   * cleanup pass that is retried after a crash does not fail on its own earlier
   * success. Pass {@link RemoveBackupOptions.restoredContentHash} to make the
   * delete conditional on a verified restoration.
   *
   * @param originalHash The digest the backup is filed under.
   * @param options `restoredContentHash` to require a verified restoration
   * first.
   * @returns `true` when a backup was deleted, `false` when there was none.
   * `FS_UNSAFE_PATH` for a refused digest; `CLEANUP_PARTIAL` with
   * `restored-content-digest-mismatch` when a declared restoration digest does
   * not match, in which case the backup is retained.
   * @throws The runtime's own filesystem error when the delete fails for a
   * reason other than the backup's absence: `EACCES`, `EPERM`, `EISDIR`.
   */
  remove(originalHash: string, options?: RemoveBackupOptions): Promise<Result<boolean>>;

  /**
   * Deletes the backup a journal record names, from where the record says it
   * is, and only when asked.
   *
   * The deletion counterpart of {@link BackupStore.readRecorded}, under the same
   * resolution: a `composed` or `substituted` location is deleted exactly as
   * {@link BackupStore.remove} deletes it. A `relocated` one is deleted through
   * the same pinned handle its read uses, in one synchronous step: the backup
   * is read through the handle, must hash to `originalHash` — so a file that is
   * not this record's original is never deleted in its name — and must still
   * be the entry that was read when it is unlinked. Idempotent, and
   * conditional on {@link RemoveBackupOptions.restoredContentHash} exactly as
   * {@link BackupStore.remove} is, so "delete only after verification" holds
   * for a relocated backup too.
   *
   * @param recordedPath The record's `backupPath`.
   * @param originalHash The record's `originalHash`.
   * @param options `restoredContentHash` to require a verified restoration
   * first.
   * @returns `true` when a backup was deleted, `false` when there was none.
   * `FS_UNSAFE_PATH` for a refused digest or a relocated backup whose
   * directories fail the policy; `STORE_ERROR` with `stored-digest-mismatch`
   * when a relocated backup's bytes do not hash to `originalHash`, or with
   * `backup-replaced` when its entry, or its judged directory, changed while it
   * was being deleted;
   * `CLEANUP_PARTIAL` with `restored-content-digest-mismatch` when a declared
   * restoration digest does not match. The backup is retained in every one of
   * those cases.
   * @throws The runtime's own filesystem error when the delete fails for a
   * reason other than the backup's absence.
   */
  removeRecorded(
    recordedPath: string,
    originalHash: string,
    options?: RemoveBackupOptions,
  ): Promise<Result<boolean>>;

  /**
   * Removes this session's whole backup directory, and only when asked.
   *
   * Explicit, non-recursive and fail-closed: it unlinks the digest-named
   * regular files this store creates, refuses to touch anything else, refuses
   * to act on a path outside `<debuggenHome>/backups/<sessionId>`, and then
   * removes the emptied directory. Anything left behind is reported rather than
   * forced, because a file this store did not create is not a file it may
   * delete.
   *
   * Call it after every record of the session has been restored or discarded.
   * Retention and time-based purging belong to the service's own pass; this
   * method has no schedule and no policy of its own.
   *
   * @returns How many backups were deleted — `0` when the directory was already
   * gone, which makes a retry a no-op — or `CLEANUP_PARTIAL` with
   * `session-directory-not-emptied` and a bounded sample of what was retained.
   * `FS_UNSAFE_PATH` when the directory fails the state-directory policy of
   * `@debuggen/shared/node`, for instance because a component of it is a
   * symbolic link.
   * @throws The runtime's own filesystem error when the directory cannot be
   * listed or removed for a reason other than its absence.
   */
  removeSessionDirectory(): Promise<Result<number>>;
}

// ---------------------------------------------------------------------------
// The failures this store reports.
//
// What goes into the `details` of each, and what never does: a backup's PATH
// and its DIGEST do — the path is the same value AAP 0.5.5 shows the developer
// verbatim ("Original saved at <backup path>") and the modification conflict
// schema carries it as a field, and a digest is a hash of content rather than
// content. A backup's BYTES never do, in whole or in part, because the details
// of an error are logged, persisted with a session and rendered in two user
// interfaces, and a backup is a verbatim copy of a developer's source file.
// Nothing below, and no log line in this module, reads a byte of content into a
// message, a field or a detail.
// ---------------------------------------------------------------------------

/**
 * The error for bytes that do not hash to the digest they were to be filed
 * under: code `STORE_ERROR`, reason `content-digest-mismatch`.
 *
 * A caller mistake, caught at the door rather than discovered at restore time.
 * Filing content under the wrong digest would make the restore path write
 * foreign bytes into a developer's file and only then notice that the result
 * does not verify — by which point the original is gone.
 */
function contentDigestMismatch(path: string, expected: string, actual: string): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The bytes offered for backup do not hash to the digest they would be filed under.',
    {
      hint: 'Hash exactly the bytes being backed up, with sha256Hex() from @debuggen/shared/node, and pass that digest.',
      details: { reason: 'content-digest-mismatch', path, expected, actual },
    },
  );
}

/**
 * The error for a stored backup that does not hash to its own name: code
 * `STORE_ERROR`, reason `stored-digest-mismatch`.
 *
 * The store's one invariant, broken. The file is left exactly where it was: it
 * is the only copy of whatever it holds, and something in this session may
 * still have to restore it.
 */
function storedDigestMismatch(path: string, expected: string, actual: string): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'A stored backup does not hash to the digest it is filed under, so it cannot be trusted as an original.',
    {
      hint: 'The backup was kept, not overwritten. Inspect it before deleting it, and treat the instrumented file as a conflict.',
      details: { reason: 'stored-digest-mismatch', path, expected, actual },
    },
  );
}

/**
 * Whether a pin on a relocated backup's directory still reaches the directory
 * that was judged.
 *
 * Always true where the platform enforces the pin: the path goes through the
 * held descriptor, so a swap of the directory tree cannot redirect it. Where it
 * cannot (no `/proc/self/fd`), the path is the ordinary one and this is the
 * detection the shared pin offers instead — checked immediately before each
 * use, so a directory moved away since the walk is refused rather than
 * followed.
 */
function pinHolds(pinned: PinnedFile): boolean {
  return pinned.enforced || pinned.verifyDirectory();
}

/**
 * The error for a relocated backup that changed under this store while it was
 * being used — its entry replaced between the verifying read and the unlink,
 * or its judged directory moved away from its path on a platform where the pin
 * detects a swap rather than prevents it: code `STORE_ERROR`, reason
 * `backup-replaced`.
 *
 * Nothing is read or deleted: what is at the path now is not what was judged,
 * and acting on it in the record's name is the one mistake a verified,
 * pinned access exists to rule out.
 */
function backupReplaced(path: string, originalHash: string): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'A relocated backup changed while it was being used, so it was left alone.',
    {
      hint: 'Something else is writing inside the backup directory. Inspect the entry before deleting it by hand.',
      details: { reason: 'backup-replaced', path, originalHash },
    },
  );
}

/**
 * The error for an operation that required a backup and found none: code
 * `STORE_ERROR`, reason `backup-missing`.
 *
 * Distinct from the benign absence {@link BackupStore.has} and
 * {@link BackupStore.remove} report: those ask whether a backup is there, while
 * a read or a verification was told that it is.
 */
function backupMissing(path: string, originalHash: string): DebuggenError {
  return new DebuggenError('STORE_ERROR', 'No backup is stored under that digest.', {
    hint: 'A record that points at a missing backup cannot be restored; report it as a conflict and leave the file as the developer left it.',
    details: { reason: 'backup-missing', path, originalHash },
  });
}

/**
 * The error for a delete whose declared restoration does not match: code
 * `CLEANUP_PARTIAL`, reason `restored-content-digest-mismatch`.
 *
 * `CLEANUP_PARTIAL` because that is precisely the state it leaves: a record
 * that cannot be closed, and a session whose cleanup status has to say so. The
 * backup is retained.
 */
function restoredContentMismatch(
  path: string,
  originalHash: string,
  restoredContentHash: string,
): DebuggenError {
  return new DebuggenError(
    'CLEANUP_PARTIAL',
    'The restored content does not hash to the recorded original, so its backup was kept.',
    {
      hint: 'Verify what was written to the project file before deleting the backup; it is still the only copy of the original.',
      details: {
        reason: 'restored-content-digest-mismatch',
        path,
        originalHash,
        restoredContentHash,
      },
    },
  );
}

/**
 * The error for a session directory that could not be emptied: code
 * `CLEANUP_PARTIAL`, reason `session-directory-not-emptied`.
 *
 * Carries a bounded sample of what was left, plus the totals, for the reason
 * given on {@link MAX_REPORTED_RETAINED_ENTRIES}.
 */
function sessionDirectoryNotEmptied(
  sessionDirectory: string,
  retained: readonly string[],
  removed: number,
): DebuggenError {
  return new DebuggenError(
    'CLEANUP_PARTIAL',
    'The session backup directory still holds entries this tool did not create, so it was left in place.',
    {
      hint: 'Inspect the directory and remove it by hand once its contents are accounted for.',
      details: {
        reason: 'session-directory-not-emptied',
        sessionDirectory,
        removed,
        retainedCount: retained.length,
        retainedSample: retained.slice(0, MAX_REPORTED_RETAINED_ENTRIES),
      },
    },
  );
}

/**
 * The error a state root this store will not build on produces: code
 * `FS_UNSAFE_PATH`.
 *
 * Not `CONFIG_INVALID`, deliberately. That code belongs to the module that
 * *resolves* `$DEBUGGEN_HOME` and can tell the developer which setting to fix;
 * this module was handed a path and is refusing to compose one from it, which
 * is what `FS_UNSAFE_PATH` names.
 */
function unusableStateRoot(
  reason: 'not-absolute' | 'control-character' | 'network-share',
): DebuggenError {
  return new DebuggenError(
    'FS_UNSAFE_PATH',
    'The state directory a backup store is given must be an absolute local path with no control characters.',
    {
      hint: 'Pass the resolved $DEBUGGEN_HOME from the service configuration, or a directory from fs.mkdtemp in a test.',
      details: { reason },
    },
  );
}

/** Options for {@link createBackupStore}. */
export interface BackupStoreOptions {
  /**
   * The absolute path of the product's own state directory — the resolved
   * `$DEBUGGEN_HOME`, or a temporary directory in a suite.
   *
   * Injected, never read from the environment here: resolving it (reading the
   * variable, expanding `~`, applying the default) belongs to the service's
   * configuration module, and keeping that out of this one is what lets a test
   * point a store at `fs.mkdtemp` output with no environment to restore
   * afterwards.
   *
   * Refused unless it is absolute — a relative state root would be resolved
   * against whatever working directory the process happens to have — and free
   * of control characters. A network-share (`//server/share`) prefix is refused
   * too: lexical normalisation collapses its two leading separators, so the
   * path this store composed would not be the path that was given.
   */
  readonly debuggenHome: string;

  /**
   * The session whose backups this store owns, used verbatim as one path
   * component under `<debuggenHome>/backups/`.
   *
   * `newSessionId()` in `@debuggen/shared` restricts its alphabet to lowercase
   * alphanumerics precisely because of this interpolation. A value that is not
   * a single safe path component is refused rather than escaped: an id with a
   * separator in it would file one session's backups inside another's.
   */
  readonly sessionId: string;

  /**
   * Where this store's diagnostics go. Defaults to `noopLogger`, so library
   * code stays silent unless a consumer asks for output.
   *
   * It logs paths, digests, byte counts and entry names — never a byte of file
   * content, which is the same rule the failure details above follow.
   */
  readonly logger?: Logger | undefined;

  /**
   * Invoked with the recorded path once a relocated backup's directory has been
   * pinned and judged, immediately before the backup is read or unlinked
   * through that pin.
   *
   * The same kind of seam `@debuggen/shared/node`'s writers offer at their
   * install boundary, for the same reason: the instant after a check and before
   * a use is the one a directory swap would exploit, and a suite passes a
   * callback that swaps the directory for a link there to prove the read and
   * the unlink still reach the directory that was judged. Production callers
   * pass nothing. A throw from it propagates, after the pin is released.
   */
  readonly onRelocatedBackupPinned?: ((recordedPath: string) => void) | undefined;
}

/**
 * Builds a {@link BackupStore} over the real filesystem for one session.
 *
 * A factory rather than an exported class, so the port stays substitutable: a
 * suite or a future backing store provides an object of the same shape without
 * anyone having to extend or `new` an implementation. The class behind it is
 * module-private for the same reason.
 *
 * Nothing is created on disk here. The session directory appears on the first
 * {@link BackupStore.put}, which keeps a store that is constructed and never
 * used — a session that ends before anything is patched — from leaving an empty
 * directory behind.
 *
 * @param options The state root, the session id, and optionally a logger.
 * @returns A store for `<debuggenHome>/backups/<sessionId>`.
 * @throws {DebuggenError} With code `FS_UNSAFE_PATH` when `debuggenHome` is not
 * an absolute, control-character-free local path, or when `sessionId` is not a
 * single safe path component. Both are construction-time defects in the caller
 * or in a stored record rather than filesystem conditions, so they are thrown:
 * a store that cannot name its own directory has no operations worth calling,
 * and every per-operation failure is a `Result` instead.
 *
 * @example
 * ```ts
 * const store = createBackupStore({ debuggenHome, sessionId, logger });
 * const stored = await store.put(originalHash, originalBytes);
 * if (stored.ok) {
 *   // stored.value.path goes straight into ModificationRecord.backupPath.
 * }
 * ```
 */
export function createBackupStore(options: BackupStoreOptions): BackupStore {
  const homePosix = toPosix(options.debuggenHome);

  if (hasControlCharacter(homePosix)) {
    throw unusableStateRoot('control-character');
  }

  if (homePosix.startsWith('//')) {
    throw unusableStateRoot('network-share');
  }

  if (!isAbsolutePosix(homePosix) && !isWindowsAbsolute(homePosix)) {
    throw unusableStateRoot('not-absolute');
  }

  if (!isSafePathSegment(options.sessionId, MAX_PATH_SEGMENT_LENGTH)) {
    throw unsafeSegment('sessionId', options.sessionId);
  }

  return new FileSystemBackupStore(
    normalizePosix(homePosix),
    options.sessionId,
    options.logger ?? noopLogger,
    options.onRelocatedBackupPinned,
  );
}

/**
 * The real implementation: one session's backup directory on the local
 * filesystem.
 *
 * Module-private and reached only through {@link createBackupStore}, which has
 * already validated everything the constructor takes — so no method below
 * re-checks the state root or the session id, and every method re-checks the
 * digest it is handed, because that arrives per call.
 */
class FileSystemBackupStore implements BackupStore {
  /** The contract is {@link BackupStore.sessionId}; this is its filesystem implementation. */
  readonly sessionId: string;

  /** The contract is {@link BackupStore.sessionDirectory}; this is its filesystem implementation. */
  readonly sessionDirectory: string;

  /**
   * The validated, normalised state root, POSIX separators.
   *
   * Kept because it is the `upTo` boundary handed to every
   * `@debuggen/shared/node` call: that is what turns the guarantee from "the
   * directory we created is private" into "every directory from the state root
   * down is private, and none of them is a symbolic link".
   */
  readonly #debuggenHome: string;

  /** The backups root, `<debuggenHome>/backups`, used as a containment bound. */
  readonly #backupsRoot: string;

  /** Where diagnostics go; `noopLogger` when the consumer asked for none. */
  readonly #logger: Logger;

  /** The suite seam of {@link BackupStoreOptions.onRelocatedBackupPinned}. */
  readonly #onRelocatedBackupPinned: ((recordedPath: string) => void) | undefined;

  constructor(
    debuggenHomePosix: string,
    sessionId: string,
    logger: Logger,
    onRelocatedBackupPinned: ((recordedPath: string) => void) | undefined,
  ) {
    this.#debuggenHome = debuggenHomePosix;
    this.#backupsRoot = joinPosix(debuggenHomePosix, BACKUPS_DIRECTORY_NAME);
    this.sessionId = sessionId;
    this.sessionDirectory = resolveSessionDirectory(debuggenHomePosix, sessionId);
    this.#logger = logger;
    this.#onRelocatedBackupPinned = onRelocatedBackupPinned;
  }

  /** The contract is {@link BackupStore.locate}; this is its filesystem implementation. */
  locate(originalHash: string): Result<string> {
    // Two checks, in this order, so the reason a caller is told is the most
    // specific one that applies: a string carrying a separator or a control
    // character is refused as a path component before it is judged as a digest,
    // and a safe component that is simply not 64 lowercase hex characters is
    // refused as a digest. A value that passes both cannot move the composed
    // path, which is what makes the join below safe.
    if (!isSafePathSegment(originalHash, MAX_PATH_SEGMENT_LENGTH)) {
      return err(unsafeSegment('originalHash', originalHash));
    }

    if (!sha256HexSchema.safeParse(originalHash).success) {
      return err(notADigest('originalHash'));
    }

    return ok(resolveBackupPath(this.sessionDirectory, originalHash));
  }

  /** The contract is {@link BackupStore.locateRecorded}; this is its filesystem implementation. */
  locateRecorded(recordedPath: string, originalHash: string): Result<RecordedBackupLocation> {
    // The digest is validated first and in every case: a record whose digest is
    // not one this store files under has no backup anywhere, whatever its path
    // says, and the composed path is also the substitute below.
    const composed = this.locate(originalHash);
    if (isErr(composed)) {
      return composed;
    }

    const recorded = toPosix(recordedPath);

    if (recorded === composed.value) {
      return ok({ path: composed.value, source: 'composed' });
    }

    if (this.#isRelocationTarget(recorded, originalHash)) {
      return ok({ path: recorded, source: 'relocated' });
    }

    return ok({ path: composed.value, source: 'substituted' });
  }

  /** The contract is {@link BackupStore.put}; this is its filesystem implementation. */
  async put(originalHash: string, content: Uint8Array): Promise<Result<StoredBackup>> {
    const located = this.locate(originalHash);
    if (isErr(located)) {
      return located;
    }

    const path = located.value;

    // Before anything is created: the name this content will be filed under has
    // to be the digest of that content, or the restore path would later write
    // these bytes into a developer's file believing they are the original.
    const contentDigest = sha256Hex(content);
    if (contentDigest !== originalHash) {
      return err(contentDigestMismatch(path, originalHash, contentDigest));
    }

    const outcome = await onPromiseBoundary(() => this.#createExclusively(path, content));

    if (outcome === 'created') {
      this.#logger.debug('original bytes backed up', {
        backupPath: path,
        originalHash,
        byteLength: content.byteLength,
      });

      return ok({ path, originalHash, byteLength: content.byteLength, reused: false });
    }

    // Something already occupies the path. Because the name is the digest, the
    // expected case is an identical backup from an earlier plan version — but
    // "expected" is not "assumed": the bytes are read back (without following a
    // symbolic link) and hashed before the collision is called a success.
    const verified = await this.verify(originalHash);
    if (isErr(verified)) {
      return verified;
    }

    this.#logger.debug('identical backup already stored, reusing it', {
      backupPath: path,
      originalHash,
      byteLength: verified.value.byteLength,
    });

    return ok({ ...verified.value, reused: true });
  }

  /** The contract is {@link BackupStore.read}; this is its filesystem implementation. */
  async read(originalHash: string): Promise<Result<Buffer>> {
    const located = this.locate(originalHash);
    if (isErr(located)) {
      return located;
    }

    const path = located.value;

    try {
      return ok(await onPromiseBoundary(() => readFileNoFollow(path)));
    } catch (error) {
      // The one errno with a product meaning: a record points at a backup that
      // is not there, which cleanup has to report rather than crash on. `ELOOP`
      // (a symbolic link planted at the path), `EISDIR` and `EACCES` are
      // genuinely exceptional and keep their own codes.
      if (errnoCodeOf(error) === 'ENOENT') {
        return err(backupMissing(path, originalHash));
      }

      throw error;
    }
  }

  /** The contract is {@link BackupStore.readRecorded}; this is its filesystem implementation. */
  async readRecorded(recordedPath: string, originalHash: string): Promise<Result<RecordedBackup>> {
    const located = this.locateRecorded(recordedPath, originalHash);
    if (isErr(located)) {
      return located;
    }

    const { path, source } = located.value;

    if (source !== 'relocated') {
      // The store's own location, read exactly as a digest read reads it.
      const bytes = await this.read(originalHash);

      return isErr(bytes) ? bytes : ok({ path, source, bytes: bytes.value });
    }

    return await onPromiseBoundary(() => this.#readRelocated(path, originalHash));
  }

  /** The contract is {@link BackupStore.has}; this is its filesystem implementation. */
  async has(originalHash: string): Promise<Result<boolean>> {
    const located = this.locate(originalHash);
    if (isErr(located)) {
      return located;
    }

    try {
      // `lstat`, not `stat`: the question is what is *at* this path, and a
      // dangling symbolic link there is something — reported as "not a usable
      // backup" rather than resolved to whatever it points at.
      const stats = await lstat(located.value);
      return ok(stats.isFile());
    } catch (error) {
      if (errnoCodeOf(error) === 'ENOENT') {
        return ok(false);
      }

      throw error;
    }
  }

  /** The contract is {@link BackupStore.verify}; this is its filesystem implementation. */
  async verify(originalHash: string): Promise<Result<BackupVerification>> {
    const located = this.locate(originalHash);
    if (isErr(located)) {
      return located;
    }

    const bytes = await this.read(originalHash);
    if (isErr(bytes)) {
      return bytes;
    }

    // Hashed from the bytes that were read, never inferred from the file's
    // name: the name is what is being checked.
    const storedDigest = sha256Hex(bytes.value);
    if (storedDigest !== originalHash) {
      return err(storedDigestMismatch(located.value, originalHash, storedDigest));
    }

    return ok({
      path: located.value,
      originalHash,
      byteLength: bytes.value.byteLength,
    });
  }

  /** The contract is {@link BackupStore.remove}; this is its filesystem implementation. */
  async remove(originalHash: string, options?: RemoveBackupOptions): Promise<Result<boolean>> {
    const located = this.locate(originalHash);
    if (isErr(located)) {
      return located;
    }

    const path = located.value;
    const verified = this.#refuseUnverifiedDelete(path, originalHash, options);
    if (isErr(verified)) {
      return verified;
    }

    try {
      // `unlink` removes the directory entry, so a symbolic link planted at
      // this path is deleted rather than followed — nothing outside the backup
      // tree is ever touched by a delete.
      await unlink(path);
    } catch (error) {
      // Idempotent by contract: a cleanup pass retried after a crash must not
      // fail on its own earlier success.
      if (errnoCodeOf(error) === 'ENOENT') {
        return ok(false);
      }

      throw error;
    }

    this.#logger.debug('backup deleted', { backupPath: path, originalHash });

    return ok(true);
  }

  /** The contract is {@link BackupStore.removeRecorded}; this is its filesystem implementation. */
  async removeRecorded(
    recordedPath: string,
    originalHash: string,
    options?: RemoveBackupOptions,
  ): Promise<Result<boolean>> {
    const located = this.locateRecorded(recordedPath, originalHash);
    if (isErr(located)) {
      return located;
    }

    const { path, source } = located.value;

    if (source !== 'relocated') {
      return await this.remove(originalHash, options);
    }

    const verified = this.#refuseUnverifiedDelete(path, originalHash, options);
    if (isErr(verified)) {
      return verified;
    }

    // One synchronous step from pin to unlink: no `await` may sit between the
    // judgement of the directory and the deletion made through it.
    const removed = await onPromiseBoundary(() => this.#removeRelocated(path, originalHash));

    if (!isErr(removed) && removed.value) {
      this.#logger.debug('relocated backup deleted', { backupPath: path, originalHash });
    }

    return removed;
  }

  /** The contract is {@link BackupStore.removeSessionDirectory}; this is its filesystem implementation. */
  async removeSessionDirectory(): Promise<Result<number>> {
    const directory = this.sessionDirectory;

    // Defence in depth. The constructor's validation already makes this true by
    // construction, and the check is still here because it is the one assertion
    // standing between a malformed identity and a recursive delete somewhere
    // else on the disk. `isWithin` is the product's containment predicate — it
    // normalises both sides and rejects the prefix-sibling case a bare
    // `startsWith` would accept — and the equality test keeps the backups root
    // itself, shared by every session, out of reach.
    if (directory === this.#backupsRoot || !isWithin(this.#backupsRoot, directory)) {
      return err(unsafeSegment('sessionId', this.sessionId));
    }

    const policy = await onPromiseBoundary(() => this.#assertSessionDirectoryUsable());
    if (isErr(policy)) {
      return policy;
    }

    if (!policy.value) {
      // Already gone: the no-op that makes a retried cleanup safe.
      return ok(0);
    }

    const entries = await this.#listSessionDirectory();
    if (entries === undefined) {
      return ok(0);
    }

    let removed = 0;
    const retained: string[] = [];

    for (const entry of entries) {
      const entryPath = resolveBackupPath(directory, entry.name);

      // Only the files this store creates are deletable: a regular file whose
      // name is a digest, inside this session's own directory. A subdirectory, a
      // symbolic link, or a name of any other shape was put there by something
      // else and is reported instead of removed.
      if (
        !entry.isFile() ||
        !SHA256_HEX_PATTERN.test(entry.name) ||
        !isWithin(directory, entryPath)
      ) {
        retained.push(entry.name);
        continue;
      }

      try {
        await unlink(entryPath);
        removed += 1;
      } catch (error) {
        if (errnoCodeOf(error) !== 'ENOENT') {
          throw error;
        }
      }
    }

    if (retained.length > 0) {
      return err(sessionDirectoryNotEmptied(directory, retained, removed));
    }

    const emptied = await this.#removeEmptiedDirectory(directory, removed);
    if (isErr(emptied)) {
      return emptied;
    }

    this.#logger.debug('session backup directory removed', {
      sessionDirectory: directory,
      removed,
    });

    return ok(removed);
  }

  /**
   * Refuses a delete whose declared restoration does not match the digest the
   * backup is filed under — the precondition {@link BackupStore.remove} and
   * {@link BackupStore.removeRecorded} both enforce.
   *
   * @param path The backup that would be deleted, for the report.
   * @param originalHash The digest it is filed under.
   * @param options The caller's declared restoration, if any.
   * @returns `ok` when the delete may proceed: no restoration was declared, or
   * the declared digest matches.
   */
  #refuseUnverifiedDelete(
    path: string,
    originalHash: string,
    options: RemoveBackupOptions | undefined,
  ): Result<void> {
    const restoredContentHash = options?.restoredContentHash;

    if (restoredContentHash === undefined) {
      return ok(undefined);
    }

    // The declared digest never becomes a path, so only its shape is checked —
    // with the shared pattern rather than a local regular expression, so the
    // store and the modification schema agree on what a digest is.
    if (!SHA256_HEX_PATTERN.test(restoredContentHash)) {
      return err(notADigest('restoredContentHash'));
    }

    if (restoredContentHash !== originalHash) {
      this.#logger.warn('keeping a backup: restored content does not match the recorded original', {
        backupPath: path,
        originalHash,
        restoredContentHash,
      });

      return err(restoredContentMismatch(path, originalHash, restoredContentHash));
    }

    return ok(undefined);
  }

  /**
   * Whether a recorded path this store did not compose is one it will act on
   * as a relocated backup.
   *
   * Lexical, and deliberately strict: an absolute path — POSIX, or a Windows
   * drive path on the platform whose state root is one — no longer than
   * {@link MAX_RECORDED_PATH_LENGTH}, with no control character, already in
   * normal form (so no `.` or `..` segment and no doubled separator can move it
   * after it was judged), not a network share, and bound to the record:
   *
   * - inside **this store's own session directory**, so one session's record
   *   can never reach a backup another session holds;
   * - in a **subdirectory** of it, never directly in it, which is where the
   *   composed backups live and the only level the non-recursive
   *   {@link BackupStore.removeSessionDirectory} sweep touches;
   * - **named by the record's digest**, as every backup is.
   *
   * What this cannot see — a directory inside the tree that has become a link,
   * or been opened up to other accounts — is what the pinned walk that runs
   * before every relocated read or delete establishes.
   */
  #isRelocationTarget(candidate: string, originalHash: string): boolean {
    if (candidate.length === 0 || candidate.length > MAX_RECORDED_PATH_LENGTH) {
      return false;
    }

    if (hasControlCharacter(candidate) || candidate.startsWith('//')) {
      return false;
    }

    if (!isAbsolutePosix(candidate) && !isWindowsAbsolute(candidate)) {
      return false;
    }

    if (normalizePosix(candidate) !== candidate) {
      return false;
    }

    return (
      isWithin(this.sessionDirectory, candidate) &&
      dirnamePosix(candidate) !== this.sessionDirectory &&
      basenamePosix(candidate) === originalHash
    );
  }

  /**
   * Pins the directory holding a relocated backup: every component from the
   * state root down opened relative to the one above it without following a
   * link, and held to the state-directory policy through the descriptor it
   * opened.
   *
   * Synchronous, and only ever called from inside a synchronous read or delete
   * step, so nothing runs between the pin and the use made of it.
   *
   * @returns The pin, `undefined` when a directory on the way is not there, or
   * the policy failure of a directory that is.
   * @throws Any other filesystem error, with its errno intact.
   */
  #pinRelocated(path: string): Result<PinnedFile | undefined> {
    // `#isRelocationTarget` has already placed the path inside this session's
    // directory, which is inside the state root, so this is a downward path
    // from the root the pinned walk descends from.
    const relativeToHome = relativePosix(this.#debuggenHome, path);

    try {
      return ok(pinPrivateFileWithinRoot(this.#debuggenHome, relativeToHome));
    } catch (error) {
      // Checked before the errno test: a `DebuggenError` carries a `code` of
      // its own, so reading it as an errno would misclassify it.
      if (DebuggenError.is(error)) {
        return err(error);
      }

      if (errnoCodeOf(error) === 'ENOENT') {
        return ok(undefined);
      }

      throw error;
    }
  }

  /**
   * Reads a relocated backup through a pinned handle on its directory, the
   * final component without following a link.
   *
   * Synchronous, and called through {@link onPromiseBoundary}.
   *
   * @returns The bytes, `backup-missing` when the file or its directory is not
   * there, or the policy failure of a directory above it.
   * @throws Any other filesystem error, with its errno intact.
   */
  #readRelocated(path: string, originalHash: string): Result<RecordedBackup> {
    const pinned = this.#pinRelocated(path);
    if (isErr(pinned)) {
      return pinned;
    }

    const handle = pinned.value;
    if (handle === undefined) {
      return err(backupMissing(path, originalHash));
    }

    try {
      this.#onRelocatedBackupPinned?.(path);

      if (!pinHolds(handle)) {
        return err(backupReplaced(path, originalHash));
      }

      return ok({ path, source: 'relocated', bytes: readFileNoFollow(handle.path) });
    } catch (error) {
      if (errnoCodeOf(error) === 'ENOENT') {
        return err(backupMissing(path, originalHash));
      }

      throw error;
    } finally {
      handle.release();
    }
  }

  /**
   * Deletes a relocated backup through a pinned handle on its directory, only
   * once its own bytes prove it is the record's original.
   *
   * Synchronous from pin to unlink, and called through
   * {@link onPromiseBoundary}. The backup is read through the handle and must
   * hash to `originalHash`, so no file is ever deleted in the name of a digest
   * it does not carry; the entry must then still be the inode that was read,
   * so a file swapped in beside the verified one is kept. `unlink` through the
   * handle removes an entry of the directory that was judged, and never
   * follows a link.
   *
   * @returns `true` when the backup was deleted, `false` when it or its
   * directory was already gone, or the refusal that kept it.
   * @throws Any other filesystem error, with its errno intact.
   */
  #removeRelocated(path: string, originalHash: string): Result<boolean> {
    const pinned = this.#pinRelocated(path);
    if (isErr(pinned)) {
      return pinned;
    }

    const handle = pinned.value;
    if (handle === undefined) {
      // Its directory is gone, so the backup is too: the idempotent no-op.
      return ok(false);
    }

    try {
      this.#onRelocatedBackupPinned?.(path);

      if (!pinHolds(handle)) {
        return err(backupReplaced(path, originalHash));
      }

      const snapshot = readFileSnapshotNoFollow(handle.path);
      const storedDigest = sha256Hex(snapshot.bytes);

      if (storedDigest !== originalHash) {
        this.#logger.warn('keeping a relocated backup: it does not hash to the record digest', {
          backupPath: path,
          originalHash,
          storedDigest,
        });

        return err(storedDigestMismatch(path, originalHash, storedDigest));
      }

      const current = lstatSync(handle.path, { bigint: true });

      if (
        !pinHolds(handle) ||
        !isSameFileIdentity({ dev: current.dev, ino: current.ino }, snapshot.identity)
      ) {
        this.#logger.warn('keeping a relocated backup: its entry changed after it was verified', {
          backupPath: path,
          originalHash,
        });

        return err(backupReplaced(path, originalHash));
      }

      unlinkSync(handle.path);

      return ok(true);
    } catch (error) {
      // Idempotent by contract: the backup, or its entry, already being gone is
      // the retried pass finding its own earlier success.
      if (errnoCodeOf(error) === 'ENOENT') {
        return ok(false);
      }

      throw error;
    } finally {
      handle.release();
    }
  }

  /**
   * Creates the session directory if needed and the backup file exclusively.
   *
   * Synchronous, and called through {@link onPromiseBoundary}: both primitives
   * are the synchronous, hardened ones from `@debuggen/shared/node`, and the
   * order matters — `ensureSecureDir` walks every component from the state
   * root down with a non-recursive `mkdir`, gives each directory it creates
   * `SECURE_DIR_MODE` through an `O_NOFOLLOW` descriptor, refuses an existing
   * one that is a link, is owned by another account or grants group or other
   * access — never changing its mode — and then *proves* the result, so the
   * file is created into a directory whose privacy is a verified fact rather
   * than an assumption, and a loose directory leaves nothing written at all.
   *
   * `createFileExclusive` opens `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`,
   * re-applies {@link SECURE_FILE_MODE} with `fchmod` on the descriptor it just
   * opened — so the mode does not depend on the process umask — writes every
   * byte in a loop, and `fsync`s before it returns. The mode is passed
   * explicitly even though it is that function's default, because "a backup is
   * `0600`" is a guarantee this file makes and not one it inherits quietly.
   *
   * @returns `'created'` when the file is now on disk, `'exists'` when
   * something already occupied the path — which `O_EXCL` reports as `EEXIST`
   * even for a symbolic link, and which the caller resolves by reading and
   * hashing rather than by overwriting.
   * @throws Any other filesystem error, with its errno intact, and
   * `DebuggenError` with `FS_UNSAFE_PATH` when the state directory fails its
   * ownership or permission policy.
   */
  #createExclusively(path: string, content: Uint8Array): 'created' | 'exists' {
    ensureSecureDir(this.sessionDirectory, { upTo: this.#debuggenHome });

    try {
      createFileExclusive(path, content, {
        mode: SECURE_FILE_MODE,
        upTo: this.#debuggenHome,
      });

      return 'created';
    } catch (error) {
      if (errnoCodeOf(error) === 'EEXIST') {
        return 'exists';
      }

      throw error;
    }
  }

  /**
   * Whether the session directory exists and is safe to act on.
   *
   * Synchronous, and called through {@link onPromiseBoundary}. `assertSecureDir`
   * walks every component from the state root down and refuses a symbolic link,
   * a non-directory, a foreign owner or group-or-other permissions — which is
   * what stops a delete pass from following a redirected path — and it is used
   * here rather than a bare `lstat` so that the removal path applies exactly
   * the same policy as the write path.
   *
   * @returns `ok(true)` when the directory is there and passes, `ok(false)` when
   * it does not exist, and `err` with the policy failure when it exists and is
   * not safe to touch.
   * @throws Any filesystem error other than the directory's absence.
   */
  #assertSessionDirectoryUsable(): Result<boolean> {
    try {
      assertSecureDir(this.sessionDirectory, { upTo: this.#debuggenHome });
      return ok(true);
    } catch (error) {
      // Checked before the errno test: a `DebuggenError` carries a `code` of
      // its own, so reading it as an errno would misclassify it.
      if (DebuggenError.is(error)) {
        return err(error);
      }

      if (errnoCodeOf(error) === 'ENOENT') {
        return ok(false);
      }

      throw error;
    }
  }

  /**
   * The session directory's entries, or `undefined` when the directory
   * disappeared between the policy check above and this listing.
   *
   * `withFileTypes` so each entry's kind is known without a second syscall per
   * name, and because the kind is what decides whether an entry is one of this
   * store's backups. The return type names `Dirent` explicitly rather than
   * inferring it from the overloaded `readdir`, whose signature set also has a
   * `Buffer`-named variant.
   */
  async #listSessionDirectory(): Promise<Dirent[] | undefined> {
    try {
      return await readdir(this.sessionDirectory, { withFileTypes: true });
    } catch (error) {
      if (errnoCodeOf(error) === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  /**
   * Removes the session directory once its backups are gone.
   *
   * `rmdir` and not a recursive remove, deliberately: this store has no
   * recursive delete at all, so the only way the directory goes is empty. An
   * `ENOTEMPTY` therefore means something arrived while the pass was running,
   * which is reported as a partial cleanup rather than forced.
   */
  async #removeEmptiedDirectory(directory: string, removed: number): Promise<Result<void>> {
    try {
      await rmdir(directory);
      return ok(undefined);
    } catch (error) {
      const code = errnoCodeOf(error);

      if (code === 'ENOENT') {
        // Removed by something else after the entries were unlinked. The
        // desired end state, reached by another route.
        return ok(undefined);
      }

      if (code === 'ENOTEMPTY') {
        return err(sessionDirectoryNotEmptied(directory, [], removed));
      }

      throw error;
    }
  }
}
