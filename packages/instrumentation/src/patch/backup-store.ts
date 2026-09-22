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
 *    `@debuggen/shared/node` — `ensureSecureDir`, whose mode is
 *    `SECURE_DIR_MODE`, and `createFileExclusive`, which applies
 *    {@link SECURE_FILE_MODE} twice so the result does not depend on the
 *    process umask. Nothing here widens either mode, and no octal literal
 *    appears in this file.
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
 * blocking read or write never happens in the caller's own turn.
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
 *   patcher and cleanup do that through `atomicReplaceFile` and the digest
 *   helpers. The one place the two meet is
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

import type { Dirent } from 'node:fs';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';

import {
  DebuggenError,
  err,
  isAbsolutePosix,
  isErr,
  isWindowsAbsolute,
  isWithin,
  joinPosix,
  noopLogger,
  normalizePosix,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';
import {
  SECURE_FILE_MODE,
  assertSecureDir,
  createFileExclusive,
  ensureSecureDir,
  readFileNoFollow,
  sha256Hex,
} from '@debuggen/shared/node';

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
 * - `stored-digest-mismatch` — the file already at the composed path does not
 *   hash to its own name, so the store's invariant is broken. The file is kept
 *   and never overwritten.
 * - `backup-missing` — an operation that required a backup found none.
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
 * The port every consumer of the backup tree talks to: the patcher when it
 * records a file's original bytes, the conflict detector and cleanup when they
 * restore or discard them, and the suites that substitute it.
 *
 * ## Shape of the contract
 *
 * Small and explicit on purpose. Six operations and two read-only properties —
 * locate, put, read, has, verify, remove, plus the session's own directory —
 * are enough for the whole reversibility sequence, and each one names the
 * guarantee it makes rather than the syscall it performs.
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

  constructor(debuggenHomePosix: string, sessionId: string, logger: Logger) {
    this.#debuggenHome = debuggenHomePosix;
    this.#backupsRoot = joinPosix(debuggenHomePosix, BACKUPS_DIRECTORY_NAME);
    this.sessionId = sessionId;
    this.sessionDirectory = resolveSessionDirectory(debuggenHomePosix, sessionId);
    this.#logger = logger;
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
    const restoredContentHash = options?.restoredContentHash;

    if (restoredContentHash !== undefined) {
      // The declared digest never becomes a path, so only its shape is checked
      // — with the shared pattern rather than a local regular expression, so
      // the store and the modification schema agree on what a digest is.
      if (!SHA256_HEX_PATTERN.test(restoredContentHash)) {
        return err(notADigest('restoredContentHash'));
      }

      if (restoredContentHash !== originalHash) {
        this.#logger.warn(
          'keeping a backup: restored content does not match the recorded original',
          {
            backupPath: path,
            originalHash,
            restoredContentHash,
          },
        );

        return err(restoredContentMismatch(path, originalHash, restoredContentHash));
      }
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
   * Creates the session directory if needed and the backup file exclusively.
   *
   * Synchronous, and called through {@link onPromiseBoundary}: both primitives
   * are the synchronous, hardened ones from `@debuggen/shared/node`, and the
   * order matters — `ensureSecureDir` creates every component from the state
   * root down with a non-recursive `mkdir`, tightens each one to
   * `SECURE_DIR_MODE` through an `O_NOFOLLOW` descriptor and then *proves* the
   * result, so the file is created into a directory whose privacy is a verified
   * fact rather than an assumption.
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
