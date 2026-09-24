/**
 * The crash-safe write sequence: the one place in this product — with
 * `../cleanup.ts` — that puts bytes into a developer's working tree.
 *
 * Everything else in the monorepo observes. The page agent listens, the Node
 * preload registers a tracer provider, the code index parses, the pipeline
 * plans and the renderer draws; none of them writes a file the developer owns.
 * This module does, and the promise attached to that (AAP §0.5.1) is absolute:
 * whatever happens — the process dies mid-sequence, the machine loses power,
 * the developer edits the same file while it is patched — the file either comes
 * back byte-for-byte or is left untouched and reported.
 *
 * ## The sequence, which is the specification
 *
 * ```text
 * 0. resolve the target inside projectRoot        (lexically, then canonically)
 * 1. read the original bytes + inode   → originalHash
 * 1a. confirm the baseline the patch assumes      (./conflict.js decides)
 * 2. build the patched content         → instrumentedHash  (nothing written yet)
 * 3. copy the original to the backup   → backupPath, fsync'd
 * 4. append the record as "pending"    → BOTH hashes + the unified diff
 * 5. temp-write + fsync + re-check the target + rename      (the only write)
 * 6. mark the record "applied"
 * ```
 *
 * Two of those steps are there for an adversary rather than for a crash, and
 * both are easy to mistake for belt and braces:
 *
 * - Step 0 resolves the target **twice and then stops resolving it**. Once as a
 *   string, which refuses traversal without touching the disk; once through the
 *   filesystem, which canonicalises every directory component and re-checks
 *   containment; and then the containing directory is *held open*, so the read
 *   and the write address that descriptor instead of the path. The string check
 *   cannot see a symbolic link and the no-follow read in step 1 reaches only the
 *   path's final component, so without the second resolution an in-project
 *   `src/vendor` linking to `/etc` is read, backed up, journaled and
 *   overwritten outside the project (CWE-22). And without the pin the second
 *   resolution is only true of an instant: minutes pass before the rename, and
 *   a directory component replaced in between redirects everything after it to
 *   somewhere nothing validated. Checking a third time would have the same
 *   flaw; not re-resolving the path does not.
 * - Step 5 is **conditional**. Between step 1's read and the install sit a
 *   parse, a transform, two digests, a durable backup and a journal append, and
 *   a developer can save the same file in that time. An unconditional rename
 *   discards that edit with no trace and leaves a record claiming an
 *   `originalHash` for bytes they never had (CWE-367), so the replacement
 *   re-checks the target's bytes and inode, retains whatever it displaces
 *   rather than destroying it, and installs with an operation that refuses an
 *   occupied destination. A change it did not authorise becomes a conflict at
 *   every interleaving, never a loss.
 *
 * Step 4 sits before step 5 deliberately, and that single ordering decision is
 * what turns an ambiguous crash into a decidable one. Because the journal
 * already knows the expected post-write hash, the reconciliation table in
 * `../cleanup.ts` can tell three otherwise indistinguishable situations apart:
 * *nothing was written* (the file still hashes to `originalHash`), *our patch
 * is on disk but was never marked* (it hashes to `instrumentedHash`), and *the
 * developer changed it* (it hashes to neither). Reordering those two steps for
 * convenience silently destroys the guarantee, and no test of the happy path
 * would notice.
 *
 * ## What each crash point leaves behind
 *
 * Read with the per-status table of `../schema/modification.ts`, every boundary
 * resolves to a byte-identical file:
 *
 * ```text
 * after step 3 (backup, no record)  no record; nothing written; file already original
 *                                   → the orphan backup is reaped by the service's
 *                                     retention pass, not here
 * after step 4 (record pending)     pending + hash === originalHash     → record closed
 * mid step 5 (temp written)         pending + hash === originalHash     → record closed
 *                                     (the replacement primitive removes its own temp)
 * after step 5 (renamed)            pending + hash === instrumentedHash → restored
 * after step 6 (marked)             applied + hash === instrumentedHash → restored
 * ```
 *
 * Where this module can still act after a failure it marks the record `failed`
 * rather than leaving a `pending` row that claims a write is in flight; the
 * table treats `pending` and `failed` identically, so a genuine process death
 * and a handled failure reconcile the same way. What it never does is mark a
 * record `applied` before the rename has returned — that is the one lie
 * reconciliation cannot detect.
 *
 * ## What this module does not do
 *
 * - **It does not reconcile.** The start-up table lives in `../cleanup.ts`,
 *   which imports this module for its types and `./conflict.js` for its
 *   decisions. The import direction is cleanup → patch, never the reverse.
 * - **It does not compute the patch.** `./function-timing.js` does, as a pure
 *   function of text; keeping the transform side-effect-free is what lets both
 *   halves be tested honestly.
 * - **It does not order or roll back an install.** `../installer.ts` owns
 *   cross-adapter ordering and rollback. This module returns exactly the
 *   records a call journaled, in application order, so the installer can
 *   reverse-restore that set and nothing else.
 * - **It does not open a database, read the environment or hold a socket.** The
 *   journal is a port (`../schema/modification.ts`), the backup tree is a port
 *   (`./backup-store.js`), and the state directory arrives resolved inside the
 *   store. Nothing here consults `process.env`.
 *
 * ## Byte fidelity, stated precisely
 *
 * Hashes are SHA-256 over **raw bytes** with no newline or encoding
 * normalisation, because the restore-versus-conflict decision is a string
 * comparison of those digests: CRLF and LF content must hash differently or a
 * developer's edit would be silently overwritten. The transform works on text,
 * so the original bytes are decoded strictly (`fatal: true`, and
 * `ignoreBOM: true` so a byte-order mark survives as content rather than being
 * swallowed) and the decode is proven to round-trip back to the exact original
 * bytes before anything is patched. Content that fails either check is refused
 * rather than rewritten into something merely similar.
 *
 * A UTF-8 byte-order mark (`EF BB BF`) is preserved **exactly once, at byte
 * 0** — never stripped, moved or duplicated. TypeScript tooling reads the mark
 * as an encoding mark rather than source text, so the transform is handed the
 * decoded text without it and the mark is put back in front of the transform's
 * output before that output is encoded, hashed, diffed and written. The
 * journaled diff therefore describes the full file on both sides, mark
 * included, and a file without a mark is patched exactly as the transform
 * produced it.
 *
 * @example Patching one planned action
 * ```ts
 * const patcher = createPatcher({
 *   projectRoot,
 *   sessionId,
 *   planVersion: 1,
 *   backups: createBackupStore({ debuggenHome, sessionId }),
 *   journal,
 * });
 *
 * const applied = await patcher.patchAction(action);
 * if (!applied.ok) {
 *   return applied; // the project is untouched, or already reconciled back
 * }
 * // applied.value.record.status === 'applied'; applied.value.location is the
 * // click-to-source position recorded for the wrapped symbol.
 * ```
 */

import { realpathSync } from 'node:fs';

import { createTwoFilesPatch } from 'diff';

import {
  DebuggenError,
  err,
  isErr,
  isSafeRelativePath,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  resolveRealPathWithinProject,
  toPosix,
} from '@debuggen/shared';
import type { Logger, Result, SourceLocation } from '@debuggen/shared';
import {
  atomicReplaceFileIfUnchanged,
  pinFileWithinRoot,
  readFileNoFollow,
  readFileSnapshotNoFollow,
  sha256Hex,
} from '@debuggen/shared/node';
import type {
  AtomicReplaceExpectation,
  AtomicReplaceStaleReason,
  AtomicReplaceVerdict,
  FileSnapshot,
  PinnedFile,
} from '@debuggen/shared/node';

import { MAX_MODIFICATION_DIFF_LENGTH, createModificationRecord } from '../schema/modification.js';
import type {
  ModificationConflict,
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
} from '../schema/modification.js';
import type {
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationMode,
} from '../schema/plan.js';

import type { BackupStore, StoredBackup } from './backup-store.js';
import { detectConflict as defaultDetectConflict, isConflictVerdict } from './conflict.js';
import type { ConflictDetectionContext, ConflictFileReader, ConflictVerdict } from './conflict.js';
import { FunctionTimingPatcher } from './function-timing.js';
import type { FunctionTimingPatch, FunctionTimingRequest } from './function-timing.js';

// ---------------------------------------------------------------------------
// Bounds and vocabulary.
// ---------------------------------------------------------------------------

/**
 * The longest unified diff this module will journal, in characters:
 * {@link MAX_MODIFICATION_DIFF_LENGTH}, re-exported under the name this
 * module's own documentation and suite use.
 *
 * Bounded rather than unbounded because the diff is not a local artifact: it
 * lands in a SQLite text column, travels inside `instrumentation.ready`, and is
 * rendered verbatim by the editor's modification list and the panel's session
 * summary (AAP §0.4.2). A patch past the bound is **truncated with a visible
 * notice** and {@link PatchOutcome.diffTruncated} says so, which is the honest
 * reading — the bytes that were hashed are unaffected, and the record's two
 * hashes remain the authority on what changed.
 */
export const PATCH_DIFF_CHARACTER_LIMIT = MAX_MODIFICATION_DIFF_LENGTH;

/**
 * How many unchanged lines surround each hunk of the journaled diff.
 *
 * Three, matching `CONFLICT_DIFF_CONTEXT_LINES` in `./conflict.js`, so the diff
 * a developer reads when a patch is applied and the diff they read when it
 * conflicts are formatted alike. The `diff` package's own default is four; a
 * fixed value here means the stored text does not change when that default
 * does.
 */
export const PATCH_DIFF_CONTEXT_LINES = 3;

/**
 * The line appended in place of the tail of a diff that exceeded
 * {@link PATCH_DIFF_CHARACTER_LIMIT}.
 *
 * A notice rather than a silent clip: a reader of a truncated patch has to be
 * able to tell that they are looking at part of one. Kept to plain ASCII and no
 * path, so it is safe in a SQLite column, on the wire and in both user
 * interfaces.
 */
export const PATCH_DIFF_TRUNCATION_NOTICE =
  '\n[diff truncated: the recorded hashes remain the authority on what changed]\n';

/**
 * The header labels written above the two sides of the journaled diff.
 *
 * Constants because they appear in stored text that two user interfaces render;
 * a reworded label would change every future record's diff while leaving every
 * stored one alone.
 */
const DIFF_LABELS = Object.freeze({
  original: 'original',
  instrumented: 'instrumented',
});

/**
 * The UTF-8 byte-order mark as {@link decodeSource} yields it: one U+FEFF code
 * unit at offset 0 of the decoded text, which re-encodes to exactly the three
 * bytes `EF BB BF` it was decoded from.
 *
 * Named because it is the one character this module moves across the
 * text-to-transform boundary itself — see {@link separateByteOrderMark}.
 */
const BYTE_ORDER_MARK = '\uFEFF';

/**
 * The action types that reduce to an in-place patch of a named symbol.
 *
 * `'function-timing'` and `'server-span'` only: a server span *is* a function
 * timing on a server-side entry point, and `./function-timing.js` emits the
 * same wrap for both (AAP §0.5.1's "named function timing on either tier →
 * patch"). Every other type in the plan vocabulary is satisfied by a runtime
 * hook and must never reach this module — an adapter that routed one here would
 * be asking for a file to be edited for a signal that needs no edit, so it is
 * refused rather than attempted.
 *
 * Typed as the widened action-type list so membership can be tested against an
 * arbitrary action without this tuple asserting anything about it.
 */
const PATCHABLE_ACTION_TYPES: readonly InstrumentationActionType[] = Object.freeze([
  'function-timing',
  'server-span',
]);

/**
 * The named, individually observable steps of the sequence, in execution order.
 *
 * The order is the specification of AAP §0.5.1 and the tuple is what
 * {@link PatcherOptions.onStage} reports against, which makes every crash point
 * in the module addressable by name from a test: throwing from the observer for
 * a given stage is a failure injected *immediately after* that stage completed.
 *
 * - `'resolve-target'` — the action is a patch target, its path is inside the
 *   project as text, and it is still inside the project once every directory
 *   component has been canonicalised. Nothing has been read.
 * - `'read-original'` — the bytes and the inode they came from are in memory,
 *   hashed as `originalHash`, and decoded to text that provably re-encodes to
 *   those exact bytes.
 * - `'baseline-check'` — the file is in the state the patch assumes: untouched
 *   for a first patch, or holding the previous record's instrumented bytes for
 *   a chained one.
 * - `'build-patch'` — the patched text and `instrumentedHash` exist in memory.
 *   The project is still untouched.
 * - `'store-backup'` — the original bytes are durable under
 *   `<debuggenHome>/backups/<sessionId>/<originalHash>`.
 * - `'journal-pending'` — the record exists with both hashes, the backup path
 *   and the diff. **The linchpoint**: every later crash is decidable.
 * - `'replace-file'` — the temp file was written, flushed, checked against the
 *   bytes and inode step 1 observed, and renamed over the target. This is the
 *   only step that changes the developer's project, and it is the step that
 *   declines to when the target is no longer what was read.
 * - `'mark-applied'` — the record says what the disk says.
 *
 * Frozen because it is a module-level table two other suites read.
 */
export const PATCH_STAGES = Object.freeze([
  'resolve-target',
  'read-original',
  'baseline-check',
  'build-patch',
  'store-backup',
  'journal-pending',
  'replace-file',
  'mark-applied',
] as const);

/** One step of the write sequence. See {@link PATCH_STAGES}. */
export type PatchStage = (typeof PATCH_STAGES)[number];

/**
 * What an observer is told when a stage completes.
 *
 * Identifiers, digests and a project-relative path — never a byte of file
 * content, per the privacy rule this package follows everywhere (AAP §0.5.2).
 * The two hashes are present from the stage that computes them onwards, so an
 * observer can assert the exact state the journal is about to record.
 */
export interface PatchStageEvent {
  /** The stage that just completed. */
  readonly stage: PatchStage;

  /** The target's project-relative POSIX path. */
  readonly file: string;

  /** The symbol being wrapped, as the action spelled it. */
  readonly symbol: string;

  /** The journaled record's id, from `'journal-pending'` onwards. */
  readonly recordId: string | undefined;

  /** The original bytes' digest, from `'read-original'` onwards. */
  readonly originalHash: string | undefined;

  /** The patched content's digest, from `'build-patch'` onwards. */
  readonly instrumentedHash: string | undefined;

  /** The record this patch is layered on, when it is a chained one. */
  readonly previousRecordId: string | undefined;
}

/**
 * The failure-injection and progress seam: a callback invoked after each
 * completed stage, awaited before the next one starts.
 *
 * **Throwing from it aborts the sequence at that boundary**, which is how
 * `./patcher.test.ts` drives AAP §0.5.1's crash points without monkey-patching
 * `node:fs` for the whole process: an observer that throws for
 * `'store-backup'` produces "crashed after the backup, before the journal", one
 * that throws for `'journal-pending'` produces "crashed after the journal,
 * before the write", and one that throws for `'replace-file'` produces
 * "crashed after the rename, before the mark". The one boundary it cannot
 * express is *inside* step 5, between the temp write and the rename; that is
 * what {@link PatchFileSystem.replaceFileIfUnchanged} is injectable for.
 *
 * It is also how the race this sequence defends against is driven: an observer
 * that rewrites the target file after `'journal-pending'` and returns normally
 * *is* a developer saving the file while the patch was being prepared, and the
 * conditional replacement in step 5 must decline rather than overwrite it.
 *
 * A rejection is treated exactly like a throw. Anything else it returns is
 * ignored.
 */
export type PatchStageObserver = (event: PatchStageEvent) => void | Promise<void>;

/**
 * The filesystem primitives the sequence uses, injectable as one object.
 *
 * Extends the reader `./conflict.js` declares — same two members, same
 * byte-fidelity contract — and adds the replacement, so one object satisfies
 * both this module and the conflict detector it delegates the baseline decision
 * to. Injected rather than imported at the call site so a suite can fail a
 * specific primitive on demand while the rest of the sequence runs for real.
 */
export interface PatchFileSystem extends ConflictFileReader {
  /**
   * Canonicalises an absolute path, resolving **every** symbolic link component.
   *
   * The contract is `fs.realpathSync`'s, and this member exists because neither
   * of the other two can answer the question it answers. `resolveWithinProject`
   * is pure string work, so a path whose interior component is a link to
   * somewhere else entirely satisfies it; `readFileBytes`'s `O_NOFOLLOW`
   * constrains the **final** component only, because the kernel has already
   * resolved every interior component before the flag applies. Without this,
   * `src/vendor/thing.ts` under a `src/vendor` that links to `/etc` is read,
   * backed up, journaled and overwritten outside the project (CWE-22).
   *
   * @param absolutePath The path to canonicalise.
   * @returns Its canonical absolute path.
   * @throws The runtime's own filesystem error, with its `code` intact, when
   * the path cannot be resolved.
   */
  readonly realPath: (absolutePath: string) => string;

  /**
   * Holds the directory containing a project-relative file open, and hands back
   * a path whose later use cannot be redirected.
   *
   * The contract is `pinFileWithinRoot`'s (`@debuggen/shared/node`): every
   * component of the canonical root and of the file's directory is opened
   * relative to the one above it with `O_DIRECTORY | O_NOFOLLOW`, and the
   * returned path addresses the resulting descriptor.
   *
   * {@link PatchFileSystem.realPath} and the containment gate above establish
   * where the path led *at one instant*; this establishes that the read and the
   * write go to what was established. Without it the sequence is
   * check-then-use: a directory component replaced between the check and the
   * `open` — or between the `open` and the `rename`, which is minutes later in
   * a session — redirects everything that follows to somewhere the check never
   * saw. Checking again cannot close that; not re-resolving the path can.
   *
   * @param rootAbs The canonical absolute path of the project root.
   * @param relativeFile The project-relative POSIX path of the target.
   * @returns The pinned file, which the caller must release.
   * @throws {DebuggenError} `FS_UNSAFE_PATH` when a component is a symbolic
   * link, or the runtime's own error with its `code` intact.
   */
  readonly pinFile: (rootAbs: string, relativeFile: string) => PinnedFile;

  /**
   * Reads a file's bytes **and** the identity of the inode they came from, from
   * one descriptor, refusing to follow a symbolic link at the final component.
   *
   * The contract is `readFileSnapshotNoFollow`'s (`@debuggen/shared/node`). The
   * identity is not decoration: it is half the precondition of
   * {@link PatchFileSystem.replaceFileIfUnchanged}, and it has to come from the
   * same descriptor as the bytes, or the pair describes an observation that
   * never held.
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
   * The contract is `atomicReplaceFileIfUnchanged`'s
   * (`@debuggen/shared/node`): write an unpredictably named temporary sibling
   * **in the same directory**, flush it, re-read the target and compare it
   * against `expected`, then `rename` — removing the temporary file and
   * rethrowing if any step fails, and removing it and answering `stale` if the
   * comparison does. Same-directory placement is what makes the rename atomic
   * on POSIX, and mode preservation is what keeps a restored file identical to
   * what was found in permissions as well as content.
   *
   * The precondition is the whole reason this is not a plain write. Between
   * this sequence's read and its write sit a parse, a transform, a digest, a
   * backup and a journal append, and a developer can save the same file in that
   * time. An unconditional `rename` discards that edit without a trace
   * (CWE-367); a conditional one refuses, and the edit is still there to be
   * reported as a conflict. A `stale` verdict is a guarantee that the target
   * was not written.
   *
   * An implementation must not assert a directory policy: a developer's project
   * is an ordinary `0755` directory this product did not create, so the
   * `0700`-and-owned assertions of `writeSecureFileAtomic` would refuse every
   * real project, and its forced `0600` would quietly narrow a file the product
   * never recorded a permission change for.
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
}

/**
 * The production {@link PatchFileSystem}: `readFileNoFollow`,
 * `readFileSnapshotNoFollow`, `sha256Hex` and `atomicReplaceFileIfUnchanged`
 * from `@debuggen/shared/node`, over `node:fs`'s `realpathSync`.
 *
 * Frozen and shared, because it holds no state. `sha256OfFile` is deliberately
 * not used even though it streams: this sequence needs the bytes anyway — for
 * the backup and for the diff — and one read that refuses to follow a symbolic
 * link at the final component serves all three purposes, where a streaming
 * digest would follow the link and hash something else.
 *
 * `readFileBytes` is retained beside `readFileSnapshot` because it is the
 * member `./conflict.js` declares and uses: this object is handed to the
 * conflict detector as its reader, and the detector needs bytes and nothing
 * else.
 */
export const defaultPatchFileSystem: PatchFileSystem = Object.freeze({
  readFileBytes: readFileNoFollow,
  hashBytes: sha256Hex,
  realPath: (absolutePath: string): string => realpathSync(absolutePath),
  pinFile: pinFileWithinRoot,
  readFileSnapshot: readFileSnapshotNoFollow,
  replaceFileIfUnchanged: atomicReplaceFileIfUnchanged,
});

/**
 * The baseline decision, as an injectable function: `detectConflict` from
 * `./conflict.js`.
 *
 * Injected so a suite can drive a verdict the filesystem cannot easily be made
 * to produce, and so the decision itself is never re-derived here. The
 * restore-versus-conflict comparison exists in exactly one place in this
 * product, and this module consults it rather than repeating it.
 */
export type ConflictDetector = (
  record: ModificationRecord,
  context: ConflictDetectionContext,
) => Promise<Result<ConflictVerdict>>;

/**
 * The transform, as a bare function: text in, patched text and a source
 * location out.
 *
 * `FunctionTimingPatcher.patch` has exactly this shape, and so does
 * `patchFunctionTiming` bound to its options.
 */
export type FunctionTimingTransform = (
  request: FunctionTimingRequest,
) => Result<FunctionTimingPatch>;

/** The transform as an object, which is what a `FunctionTimingPatcher` is. */
export interface FunctionTimingTransformObject {
  /** See `FunctionTimingPatcher.patch`. */
  patch(request: FunctionTimingRequest): Result<FunctionTimingPatch>;
}

/**
 * Either shape of the transform is accepted.
 *
 * A long-lived caller passes its `FunctionTimingPatcher` so the in-memory
 * ts-morph project is shared across every file of one install; a suite passes a
 * function. When neither is supplied, a patcher is built over
 * {@link PatcherOptions.projectRoot} with syntax verification left on.
 */
export type FunctionTimingSource = FunctionTimingTransform | FunctionTimingTransformObject;

/**
 * What this module needs to know about a project and a session's backups —
 * deliberately a superset of `./conflict.js`'s context and a subset of the
 * `InstrumentationContext` that `../adapter.ts` declares.
 *
 * Exported so `../cleanup.ts` reuses it rather than declaring a third version
 * of the same four fields. It is passed straight through to
 * {@link ConflictDetector}, which is why `message` — the developer-facing
 * sentence a conflict report carries — belongs here too: the wording of a
 * conflict is the service's to own (AAP §0.5.5), not this module's to invent.
 *
 * Importing the adapter's context type instead would point `patch/` at
 * `../adapter.js`, which sits above it and imports it; a structural superset
 * keeps the direction one-way.
 */
export interface PatchContext extends ConflictDetectionContext {
  /**
   * The filesystem primitives to use, defaulting to
   * {@link defaultPatchFileSystem}.
   *
   * Narrows the optional member of the inherited context: this module needs the
   * replacement as well as the two reads, and one object supplying all three is
   * what keeps the bytes a patch is computed from, hashed from and written with
   * provably the same bytes.
   */
  readonly files?: PatchFileSystem | undefined;
}

/**
 * Everything a {@link Patcher} is built from. Nothing is read from the
 * environment and no database is opened: both are ports.
 */
export interface PatcherOptions extends PatchContext {
  /**
   * The session every record and backup belongs to.
   *
   * Must equal {@link PatcherOptions.backups}'s own `sessionId` — a store for
   * another session would file this session's originals in the wrong directory,
   * and `./conflict.js` refuses the mismatch outright — so it is checked when
   * the patcher is built rather than on the first write.
   */
  readonly sessionId: string;

  /**
   * The plan version these patches belong to, counting from 1.
   *
   * A follow-up question produces version *n + 1* as the previous plan plus
   * additive actions (AAP §0.4.2), and a patcher is built per version: the
   * value is recorded on every record this instance journals, and the
   * duplicate-target guard is scoped to it.
   *
   * Taken as given, never cross-checked against a plan document, because this
   * module sees actions and not plans. The value an adapter passes is the
   * install context's `planVersion`, and `../installer.ts` refuses an install
   * whose plan document names a different revision — or whose delta names a
   * predecessor the journal contradicts — before any adapter builds a patcher,
   * so the revision stamped here is the revision the session installed.
   */
  readonly planVersion: number;

  /**
   * Where records are appended and their statuses moved.
   *
   * The service implements it over `node:sqlite`; the suites implement it in
   * memory. This package never opens a database, so the port is the only way a
   * record becomes durable.
   */
  readonly journal: ModificationJournal;

  /** The transform. See {@link FunctionTimingSource}. */
  readonly transform?: FunctionTimingSource | undefined;

  /** The baseline decision. Defaults to `detectConflict` from `./conflict.js`. */
  readonly detectConflict?: ConflictDetector | undefined;

  /**
   * Mints record ids, for a suite that asserts an exact record. Defaults to
   * `newModificationId()` through `createModificationRecord`.
   */
  readonly newId?: (() => string) | undefined;

  /**
   * Cancels the sequence **between** stages, never inside the write.
   *
   * `../installer.ts` aborts a failing install between actions; honouring the
   * signal mid-rename would be the one interruption that could leave a
   * half-known state, so it is checked at stage boundaries only. An abort after
   * the record exists and before the write marks that record `failed`, which
   * reconciles to "nothing was written".
   */
  readonly signal?: AbortSignal | undefined;

  /** The failure-injection and progress seam. See {@link PatchStageObserver}. */
  readonly onStage?: PatchStageObserver | undefined;
}

/**
 * One target to patch, for a caller that holds a file and a symbol rather than
 * a plan action.
 *
 * `../installer.ts` uses {@link Patcher.patchAction} instead, which carries the
 * action's id into the record's provenance. This shape exists for the paths
 * that legitimately have no action: a suite, and a reconciliation fixture.
 */
export interface PatchTarget {
  /**
   * The file to patch: project-relative POSIX, or a host-flavoured spelling of
   * one (backslashes and a `'./'` prefix are normalised before validation).
   *
   * An absolute path, a Windows drive or UNC prefix, a surviving `'..'` segment,
   * a `NUL` or any other control character is refused — before anything is
   * read.
   */
  readonly file: string;

  /**
   * The symbol to wrap, spelled exactly as the declaration spells it.
   *
   * Resolution is exact and never fuzzy: a symbol matching no declaration and a
   * symbol matching several are both refusals in `./function-timing.js`,
   * because a transform that guessed would instrument the wrong function and
   * then record an authoritative-looking source location for it.
   */
  readonly symbol: string;

  /**
   * Which kind of instrumentation this installs, when it comes from a plan.
   *
   * Checked against {@link PATCHABLE_ACTION_TYPES}: only a named-symbol timing
   * or a server span justifies touching a file. Omitted, the target is taken as
   * a function timing.
   */
  readonly type?: InstrumentationActionType | undefined;

  /** The plan action's id, carried into the patch's provenance when known. */
  readonly actionId?: string | undefined;

  /** Overrides the emitted span name, which defaults to the declared name. */
  readonly spanName?: string | undefined;
}

/** Per-attempt inputs that are not part of the target itself. */
export interface PatchAttemptOptions {
  /**
   * The record this patch is layered on top of, for a follow-up plan version
   * whose delta touches an already-instrumented file (AAP §0.4.2).
   *
   * Supply it when the caller already holds the chain's tip — the installer
   * does. When it is omitted the journal is consulted instead: the session's
   * records are listed in append order and the **last `applied` record for the
   * same file** becomes the parent. The lookup is not optional behaviour that
   * can be switched off, because patching over an earlier patch while claiming
   * to be the first record for the file would record an `originalHash` for
   * bytes the developer never had, and cleanup would restore the wrong content.
   */
  readonly previousRecord?: ModificationRecord | undefined;
}

/**
 * What one successful patch produced.
 *
 * Everything a caller needs to show the developer what happened, to link the
 * runtime spans back to source, and to unwind the change: the journaled record
 * in its `applied` state, the recorded position, both digests, the backup, and
 * the chain link when there is one.
 */
export interface PatchOutcome {
  /**
   * The record as the journal now holds it: `status: 'applied'`, with
   * `appliedAt` refreshed at the transition.
   */
  readonly record: ModificationRecord;

  /**
   * The position recorded for the wrapped symbol — project-relative file,
   * 1-based line and column, the symbol's name and `resolvedBy: 'patch'`.
   *
   * This is the first and most precise of the four source-resolution routes
   * (AAP §0.4.2): a function span carries the location captured when the patch
   * was applied, so a click in a generated panel opens the exact declaration.
   */
  readonly location: SourceLocation;

  /** The record's status, which is `'applied'` on every successful outcome. */
  readonly status: ModificationStatus;

  /** SHA-256 of the bytes this patch replaced. */
  readonly originalHash: string;

  /** SHA-256 of the bytes now on disk. */
  readonly instrumentedHash: string;

  /**
   * The stored backup, including whether an identical one was adopted rather
   * than created — normal for two plan versions that saw the same bytes, since
   * a backup is filed under the digest of its content.
   */
  readonly backup: StoredBackup;

  /** The parent record's id for a chained patch, `undefined` for a first one. */
  readonly previousRecordId: string | undefined;

  /**
   * Whether the journaled diff was clipped at
   * {@link PATCH_DIFF_CHARACTER_LIMIT}.
   *
   * Surfaced rather than hidden: a truncated diff is still a faithful prefix,
   * but a user interface showing it should not imply it is the whole change.
   */
  readonly diffTruncated: boolean;

  /**
   * The transform's own result, for a caller that wants the edit ranges, the
   * emitted identifiers or the declaration shape.
   *
   * Exactly what the transform returned, which for a file that starts with a
   * UTF-8 byte-order mark means **without the mark**: the transform is handed
   * the decoded text minus its encoding mark (TypeScript tooling does not read
   * it as source text), so `originalText`, `patchedText`, every edit offset and
   * the recorded {@link PatchOutcome.location} are relative to that BOM-less
   * text. The bytes on disk — and {@link PatchOutcome.instrumentedHash} and the
   * journaled diff — carry the mark once at byte 0. For a file without a mark
   * the two texts are the same.
   *
   * Held in memory only — it carries the file's text, so it is never logged,
   * journaled or sent anywhere (AAP §0.5.2).
   */
  readonly patch: FunctionTimingPatch;

  /** The stages that completed, in order — every member of {@link PATCH_STAGES}. */
  readonly stages: readonly PatchStage[];
}

/**
 * What a failed patch left behind, in the terms `../installer.ts` needs to
 * decide what to unwind.
 *
 * Returned by {@link Patcher.patchActions} rather than thrown, because a batch
 * that stopped part-way has both a failure and a set of applied records, and
 * the caller needs both.
 */
export interface PatchBatchFailure {
  /** The coded failure, exactly as the single-target call returned it. */
  readonly error: DebuggenError;

  /** The target that failed: project-relative POSIX. */
  readonly file: string;

  /** The symbol that was being wrapped. */
  readonly symbol: string;

  /** The failing action's id, when the failure came from an action. */
  readonly actionId: string | undefined;

  /** The stage the sequence reached before it stopped. */
  readonly stage: PatchStage;

  /**
   * The record journaled for the failed attempt, when one exists.
   *
   * Present for every failure from `'journal-pending'` onwards. Its status is
   * `'failed'` where this module could still reach the journal, and
   * `'pending'` where it could not; the reconciliation table treats the two
   * identically.
   */
  readonly record: ModificationRecord | undefined;

  /**
   * Whether the target file may hold the patched bytes.
   *
   * `false` for every failure up to and including `'journal-pending'` — nothing
   * had been written — and `false` for a `'replace-file'` failure too, whether
   * the replacement threw before the rename or declined it because the target
   * had changed. `true` only where the rename returned and the failure came
   * afterwards, which is the case the pre-write journal row exists for: the
   * record is on file with both hashes, so a restore is decidable whether or
   * not this process gets to perform it.
   */
  readonly fileMayHoldPatch: boolean;

  /**
   * The conflict report, when the failure was a baseline conflict.
   *
   * Carried here rather than inside the error's details because a report holds
   * three-way diffs — file content — and an error's details may be logged and
   * persisted (AAP §0.5.2).
   */
  readonly conflict: ModificationConflict | undefined;
}

/**
 * The result of patching a set of actions.
 *
 * Deliberately not a `Result`: a batch that failed half-way is neither a
 * success nor a bare error, and the records it did apply are what
 * `../installer.ts` must reverse-restore.
 */
export interface PatchBatchResult {
  /**
   * The successful patches, in application order. Reverse this list to unwind
   * them — cleanup restores a chain strictly last-applied-first (AAP §0.4.2).
   */
  readonly applied: readonly PatchOutcome[];

  /**
   * Every record this call appended, in append order, including one left
   * `failed`.
   *
   * A superset of `applied`'s records, and the precise set a rollback must
   * consider: a record whose write may have landed is in here even though its
   * patch never completed.
   */
  readonly journaled: readonly ModificationRecord[];

  /** The failure that stopped the batch, or `undefined` if none did. */
  readonly failure: PatchBatchFailure | undefined;
}

/**
 * The patch entry point for one session and one plan version.
 *
 * Built by {@link createPatcher}. Holds three pieces of state, all of them
 * per-instance and all of them observable: the targets it has already patched
 * (for the duplicate guard), the records it has journaled, and the conflicts it
 * has detected.
 */
export interface Patcher {
  /** The session every record and backup belongs to. */
  readonly sessionId: string;

  /** The plan version every record is stamped with. */
  readonly planVersion: number;

  /** The project root every target is resolved inside, POSIX. */
  readonly projectRoot: string;

  /**
   * Patches the symbol one plan action names.
   *
   * @param action The action to install. Its `type` must be patchable and its
   * `mode` must be `'patch'`; anything else is refused rather than applied,
   * because a runtime-mode action asks for a hook and not for an edit.
   * @param options The chain parent, when the caller holds it.
   * @returns `ok(outcome)` with an `applied` record, or `err(error)` whose code
   * names why nothing is instrumented.
   */
  patchAction(
    action: InstrumentationAction,
    options?: PatchAttemptOptions,
  ): Promise<Result<PatchOutcome>>;

  /**
   * Patches a bare file-and-symbol target.
   *
   * @param target The target. See {@link PatchTarget}.
   * @param options The chain parent, when the caller holds it.
   * @returns The same result as {@link Patcher.patchAction}.
   */
  patchTarget(target: PatchTarget, options?: PatchAttemptOptions): Promise<Result<PatchOutcome>>;

  /**
   * Patches actions in the order given, stopping at the first failure.
   *
   * Stopping rather than continuing is the safe reading: the installer that
   * called this is about to unwind, and every further edit would be one more
   * file to restore. Ordering across adapters and the rollback itself stay with
   * `../installer.ts`.
   *
   * @param actions The actions to install, in the order to install them.
   * @returns The applied outcomes, every journaled record, and the failure if
   * there was one.
   */
  patchActions(actions: readonly InstrumentationAction[]): Promise<PatchBatchResult>;

  /**
   * Every record this patcher has appended, in append order.
   *
   * For a caller that drives {@link Patcher.patchAction} itself and still needs
   * the rollback set — including a record whose `'mark-applied'` failed, which
   * no successful outcome would mention.
   */
  journaledRecords(): readonly ModificationRecord[];

  /**
   * Every conflict this patcher has detected, in detection order.
   *
   * The report a baseline refusal produced, kept here because it holds diffs
   * and therefore must not travel inside an error's details.
   */
  detectedConflicts(): readonly ModificationConflict[];
}

// ---------------------------------------------------------------------------
// The public API.
// ---------------------------------------------------------------------------

/**
 * Builds a {@link Patcher} for one session and one plan version.
 *
 * A factory rather than an exported class, so the sequence stays substitutable
 * and the implementation behind it module-private — the same shape
 * `./backup-store.js` uses for the same reason.
 *
 * Nothing is read, written or created here: the first filesystem access happens
 * inside the first patch, and the backup tree appears on the first
 * `BackupStore.put`. Two construction-time defects are thrown rather than
 * returned, because a patcher that cannot name its own session has no operation
 * worth calling and every per-patch failure is a `Result` instead.
 *
 * @param options The project root, session, plan version, backup store and
 * journal, plus the optional transform, detector, filesystem, logger, clock,
 * id generator, abort signal and stage observer. See {@link PatcherOptions}.
 * @returns A patcher scoped to that session and plan version.
 * @throws {DebuggenError} `STORE_ERROR` when the backup store belongs to a
 * different session — it would file this session's originals in another
 * session's directory, and the conflict detector refuses the mismatch too —
 * and `CONFIG_INVALID` when `planVersion` is not a positive integer or
 * `projectRoot` is not an absolute path.
 */
export function createPatcher(options: PatcherOptions): Patcher {
  const projectRoot = normalizePosix(toPosix(options.projectRoot));

  if (!projectRoot.startsWith('/') && !/^[A-Za-z]:\//.test(projectRoot)) {
    throw new DebuggenError('CONFIG_INVALID', 'A patcher must be given an absolute project root.', {
      hint: "Pass the session's resolved projectRoot, or a directory from fs.mkdtemp in a test.",
      details: { reason: 'project-root-not-absolute' },
    });
  }

  if (!Number.isInteger(options.planVersion) || options.planVersion < 1) {
    throw new DebuggenError(
      'CONFIG_INVALID',
      'A patcher must be given a plan version that is a positive integer.',
      {
        hint: 'Plan versions count from 1; a follow-up plan is the previous version plus one.',
        details: { reason: 'plan-version-invalid' },
      },
    );
  }

  if (options.backups.sessionId !== options.sessionId) {
    throw new DebuggenError(
      'STORE_ERROR',
      "A patcher's backup store must belong to the same session as the patcher itself.",
      {
        hint: 'Build the backup store with the session id you are patching for.',
        details: {
          reason: 'session-mismatch',
          sessionId: options.sessionId,
          storeSessionId: options.backups.sessionId,
        },
      },
    );
  }

  return new SequencedPatcher(projectRoot, options);
}

// ---------------------------------------------------------------------------
// The implementation.
// ---------------------------------------------------------------------------

/** One accepted target, after the type and path checks of step 0. */
interface AttemptInput {
  /** The target's project-relative POSIX path, normalised. */
  readonly file: string;

  /** The symbol to wrap. */
  readonly symbol: string;

  /** The action type this patch installs. */
  readonly type: InstrumentationActionType;

  /** The plan action's id, when the attempt came from one. */
  readonly actionId: string | undefined;

  /** The plan action itself, passed to the transform for provenance. */
  readonly action: InstrumentationAction | undefined;

  /** The span-name override, when the caller supplied one. */
  readonly spanName: string | undefined;
}

/**
 * The internal result of one attempt: richer than a `Result`, because a failed
 * attempt carries the state a rollback needs and a `Result`'s `Err` carries
 * only an error.
 */
type Attempt =
  | { readonly kind: 'applied'; readonly outcome: PatchOutcome }
  | { readonly kind: 'failed'; readonly failure: PatchBatchFailure };

/**
 * The sequence, as an object holding one session's resolved dependencies.
 *
 * Module-private: {@link createPatcher} is the only way to get one, so the port
 * stays substitutable and no caller can extend the write path.
 */
class SequencedPatcher implements Patcher {
  readonly sessionId: string;

  readonly planVersion: number;

  readonly projectRoot: string;

  /** Where original bytes are copied before anything is written. */
  readonly #backups: BackupStore;

  /** Where records are appended and their statuses moved. */
  readonly #journal: ModificationJournal;

  /** The filesystem primitives every read, hash and write goes through. */
  readonly #files: PatchFileSystem;

  /** The transform, normalised to a function. */
  readonly #transform: FunctionTimingTransform;

  /** The baseline decision. */
  readonly #detectConflict: ConflictDetector;

  /** Where diagnostics go: paths, digests, ids and reasons only. */
  readonly #logger: Logger;

  /** The clock every record and transition is stamped with. */
  readonly #now: () => number;

  /** The record-id generator, when one was injected. */
  readonly #newId: (() => string) | undefined;

  /** The cancellation signal, checked at stage boundaries only. */
  readonly #signal: AbortSignal | undefined;

  /** The failure-injection and progress seam. */
  readonly #onStage: PatchStageObserver | undefined;

  /** The context handed to the conflict detector, built once. */
  readonly #context: PatchContext;

  /**
   * The `(file, symbol)` pairs this instance has already journaled a record
   * for, so one plan version cannot patch the same symbol twice.
   */
  readonly #reserved = new Set<string>();

  /** Every record this instance appended, in append order. */
  readonly #journaled: ModificationRecord[] = [];

  /** Every conflict this instance detected, in detection order. */
  readonly #conflicts: ModificationConflict[] = [];

  constructor(projectRoot: string, options: PatcherOptions) {
    this.projectRoot = projectRoot;
    this.sessionId = options.sessionId;
    this.planVersion = options.planVersion;
    this.#backups = options.backups;
    this.#journal = options.journal;
    this.#files = options.files ?? defaultPatchFileSystem;
    this.#logger = options.logger ?? noopLogger;
    this.#now = options.now ?? nowEpochMs;
    this.#newId = options.newId;
    this.#signal = options.signal;
    this.#onStage = options.onStage;
    this.#detectConflict = options.detectConflict ?? defaultDetectConflict;
    this.#transform = toTransform(options.transform, projectRoot, this.#logger);
    this.#context = {
      projectRoot,
      backups: options.backups,
      logger: this.#logger,
      now: this.#now,
      files: this.#files,
      ...(options.message !== undefined ? { message: options.message } : {}),
    };
  }

  async patchAction(
    action: InstrumentationAction,
    options: PatchAttemptOptions = {},
  ): Promise<Result<PatchOutcome>> {
    return asResult(await this.#attempt(inputFromAction(action), options, action.mode));
  }

  async patchTarget(
    target: PatchTarget,
    options: PatchAttemptOptions = {},
  ): Promise<Result<PatchOutcome>> {
    return asResult(await this.#attempt(inputFromTarget(target), options, 'patch'));
  }

  async patchActions(actions: readonly InstrumentationAction[]): Promise<PatchBatchResult> {
    const firstRecord = this.#journaled.length;
    const applied: PatchOutcome[] = [];
    let failure: PatchBatchFailure | undefined;

    for (const action of actions) {
      const attempt = await this.#attempt(inputFromAction(action), {}, action.mode);

      if (attempt.kind === 'failed') {
        failure = attempt.failure;
        break;
      }

      applied.push(attempt.outcome);
    }

    return { applied, journaled: this.#journaled.slice(firstRecord), failure };
  }

  /**
   * The sequence of AAP §0.5.1 for one target, step by step.
   *
   * Linear on purpose: the order of these steps *is* the guarantee, so it is
   * written as one readable sequence rather than distributed across helpers
   * that a later edit could reorder without anyone noticing. Every step marks
   * itself completed through {@link SequencedPatcher.#attempt}'s local
   * `completed`, which is where the observer runs and therefore where a test's
   * injected failure lands.
   *
   * Never throws: an unexpected failure is caught at the end and turned into a
   * coded error, because an exception escaping between the backup and the
   * rename is the one thing that must not happen.
   */
  async #attempt(
    input: AttemptInput,
    options: PatchAttemptOptions,
    mode: InstrumentationMode,
  ): Promise<Attempt> {
    const { symbol } = input;
    const stages: PatchStage[] = [];

    let file = input.file;
    let stage: PatchStage = 'resolve-target';
    let originalHash: string | undefined;
    let instrumentedHash: string | undefined;
    let record: ModificationRecord | undefined;
    let previousRecordId: string | undefined;
    let conflict: ModificationConflict | undefined;
    let fileMayHoldPatch = false;
    let pinned: PinnedFile | undefined;

    /**
     * Stops the sequence, leaving a state the reconciliation table can read.
     *
     * A `pending` record is moved to `failed` — the table treats the two
     * identically, so this costs nothing and removes a row that would otherwise
     * claim a write is still in flight. A record already `applied` is left
     * alone: downgrading a patch that did land and was correctly journaled
     * would make reconciliation restore a file this call successfully
     * instrumented. A journal that refuses the transition is logged and
     * tolerated, because the `pending` row it leaves reconciles the same way.
     */
    const failed = async (error: DebuggenError): Promise<Attempt> => {
      if (record !== undefined && record.status === 'pending') {
        try {
          const marked = await this.#journal.updateStatus(record.id, 'failed', {
            appliedAt: this.#now(),
          });

          if (isErr(marked)) {
            this.#logger.warn('a failed modification record could not be marked failed', {
              recordId: record.id,
              file,
              code: marked.error.code,
            });
          } else {
            record = marked.value;
            this.#replaceJournaled(record);
          }
        } catch (cause) {
          this.#logger.warn('the journal threw while marking a modification record failed', {
            recordId: record.id,
            file,
            cause: String(cause),
          });
        }
      }

      this.#logger.warn('a patch was not applied', {
        file,
        symbol,
        stage,
        code: error.code,
        reason: error.details?.['reason'],
        recordId: record?.id,
        fileMayHoldPatch,
      });

      return {
        kind: 'failed',
        failure: {
          error,
          file,
          symbol,
          actionId: input.actionId,
          stage,
          record,
          fileMayHoldPatch,
          conflict,
        },
      };
    };

    /**
     * Records a completed step and hands it to the observer.
     *
     * The observer is awaited, so a rejection stops the sequence exactly as a
     * throw does, and either is re-coded as a patch failure rather than as an
     * internal error: an injected failure is the seam working, not a defect.
     */
    const completed = async (finished: PatchStage): Promise<void> => {
      stages.push(finished);

      const observer = this.#onStage;

      if (observer === undefined) {
        return;
      }

      try {
        await observer({
          stage: finished,
          file,
          symbol,
          recordId: record?.id,
          originalHash,
          instrumentedHash,
          previousRecordId,
        });
      } catch (cause) {
        throw new DebuggenError(
          'INSTRUMENTATION_INSTALL_FAILED',
          `The patch sequence was interrupted after the '${finished}' step.`,
          {
            hint: 'A stage observer failed. Whatever this step left behind is reconciled by the modification journal.',
            details: { reason: 'stage-hook-failed', stage: finished, file, symbol },
            cause,
          },
        );
      }
    };

    try {
      // ---------------------------------------------------------------------
      // Step 0 — resolve the target. Nothing is read until this passes.
      // ---------------------------------------------------------------------
      if (!PATCHABLE_ACTION_TYPES.includes(input.type)) {
        return await failed(
          new DebuggenError(
            'PATCH_UNSUPPORTED',
            'Only a named-symbol timing or a server span is installed by editing a file.',
            {
              hint: 'Every other signal is satisfied by a runtime hook; route this action to its adapter instead.',
              details: { reason: 'unsupported-action-type', type: input.type, file, symbol },
            },
          ),
        );
      }

      if (mode !== 'patch') {
        return await failed(
          new DebuggenError(
            'PATCH_UNSUPPORTED',
            'A runtime-mode action asks for a hook to be switched on, not for a file to be edited.',
            {
              hint: 'Install this action through its adapter; only patch-mode actions reach the patcher.',
              details: { reason: 'not-a-patch-action', mode, file, symbol },
            },
          ),
        );
      }

      if (symbol.trim().length === 0) {
        return await failed(
          new DebuggenError(
            'PATCH_TARGET_NOT_FOUND',
            'A patch target must name the symbol to wrap.',
            {
              hint: 'Name the declaration exactly as the file spells it.',
              details: { reason: 'malformed-symbol', file },
            },
          ),
        );
      }

      file = normalizePosix(toPosix(input.file));

      // The lexical gate first, on the string exactly as the plan wrote it: it
      // refuses traversal, an absolute form and a control character without
      // touching the filesystem, so a hostile target never becomes an
      // existence probe.
      if (!isSafeRelativePath(file)) {
        return await failed(
          new DebuggenError(
            'PATH_OUTSIDE_PROJECT',
            'A patch target must be a safe project-relative POSIX path.',
            {
              hint: 'Plan targets are project-relative; an absolute path or one that climbs out of the project is refused.',
              details: { reason: 'unsafe-relative-path', file },
            },
          ),
        );
      }

      // Then the filesystem-level gate, because the lexical one cannot see a
      // symbolic link and the no-follow read below reaches only the final
      // component. `resolveRealPathWithinProject` canonicalises the root and
      // every directory component of the target and re-checks containment on
      // the canonical pair, so a `src/vendor` that links to `/etc` is refused
      // *here* — before a byte is read, a backup is written or a record is
      // journaled (CWE-22). Every later step uses the canonical path it
      // returns, never the lexical one.
      const resolved = resolveRealPathWithinProject(this.projectRoot, file, this.#files.realPath);

      if (isErr(resolved)) {
        return await failed(unresolvableTarget(resolved.error, file));
      }

      // Contained, but reached through a link that stays inside the project:
      // the file then has two project-relative names, and a record whose `file`
      // is one of them would name a path that is not the bytes it describes —
      // so cleanup would restore through the link and click-to-source would
      // open the other name. Refused rather than guessed, with the same answer
      // `readFailure` gives for a link at the target itself.
      if (resolved.value.relative !== file) {
        return await failed(
          new DebuggenError(
            'FS_UNSAFE_PATH',
            'The path to patch reaches the file through a symbolic link inside the project.',
            {
              hint: 'Instrument the file the link points at, by its own path.',
              details: { reason: 'symlink-inside-project', file, symbol },
            },
          ),
        );
      }

      // Containment is established; now it is *held*. Every component of the
      // canonical root and of the target's directory is opened relative to the
      // one above it, refusing a symbolic link at each step, and the read and
      // the write below address the resulting descriptor rather than the path.
      // The check above answers for one instant; minutes pass before the
      // rename, and a component replaced in between would otherwise redirect
      // it. The pin is released in this method's `finally`.
      try {
        pinned = this.#files.pinFile(resolved.value.projectRoot, resolved.value.relative);
      } catch (cause) {
        return await failed(DebuggenError.is(cause) ? cause : readFailure(cause, file));
      }

      const absolutePath = pinned.path;
      const reservation = reservationKey(file, symbol);

      if (this.#reserved.has(reservation)) {
        return await failed(
          new DebuggenError(
            'INSTRUMENTATION_INSTALL_FAILED',
            'This symbol already has a modification record in this plan version.',
            {
              hint: 'A follow-up plan version installs only its additive actions; reconcile the existing record before patching the same symbol again.',
              details: { reason: 'duplicate-action', file, symbol },
            },
          ),
        );
      }

      const abortedBeforeRead = this.#abortCheck(file, symbol, stage);

      if (abortedBeforeRead !== undefined) {
        return await failed(abortedBeforeRead);
      }

      await completed(stage);

      // ---------------------------------------------------------------------
      // Step 1 — read the original bytes and hash them.
      // ---------------------------------------------------------------------
      stage = 'read-original';

      let snapshot: FileSnapshot;

      // Bytes and inode identity from one descriptor. The identity is half the
      // precondition of step 5: it is what lets the write refuse a file that
      // was replaced by a different one — which is how every editor saves —
      // even when the replacement happens to hold identical bytes.
      try {
        snapshot = this.#files.readFileSnapshot(absolutePath);
      } catch (cause) {
        return await failed(readFailure(cause, file));
      }

      const originalBytes = snapshot.bytes;

      originalHash = this.#files.hashBytes(originalBytes);

      const decoded = decodeSource(originalBytes, file);

      if (isErr(decoded)) {
        return await failed(decoded.error);
      }

      const originalText = decoded.value;

      // The transform works on text and the write puts text back, so the
      // decode has to be lossless or the bytes outside the patched region
      // would not survive. Proven rather than assumed: one re-encode and one
      // digest comparison, which is cheap next to the parse that follows.
      if (this.#files.hashBytes(new TextEncoder().encode(originalText)) !== originalHash) {
        return await failed(
          new DebuggenError(
            'PATCH_UNSUPPORTED',
            'This file cannot be patched because its bytes do not survive a UTF-8 round trip.',
            {
              hint: 'Re-save the file as UTF-8, or time this code through a runtime hook instead.',
              details: { reason: 'encoding-not-round-trippable', file },
            },
          ),
        );
      }

      await completed(stage);

      // ---------------------------------------------------------------------
      // Step 1a — confirm the baseline this patch assumes.
      // ---------------------------------------------------------------------
      stage = 'baseline-check';

      const parent = await this.#resolveChainParent(file, options.previousRecord);

      if (isErr(parent)) {
        return await failed(parent.error);
      }

      // The developer's own text, for a file this session already patched: the
      // transform rewrites the layered bytes it was just handed, but records the
      // target's position in these, so a span points at the line the developer
      // has rather than one shifted by the wrappers above it.
      let locationText: string | undefined;

      if (parent.value !== undefined) {
        previousRecordId = parent.value.id;

        // The detector resolves the parent record's own `file` lexically inside
        // the same project root, and `#resolveChainParent` has already
        // established that `parent.file === file` — the path step 0 proved
        // canonical and contained. So the delegation cannot reach a file this
        // sequence has not already validated, and the lexical resolution there
        // is not a second escape route.
        const baseline = await this.#confirmBaseline(parent.value, originalHash);

        if (isErr(baseline)) {
          conflict = baseline.error.conflict;

          if (conflict !== undefined) {
            this.#conflicts.push(conflict);
          }

          return await failed(baseline.error.error);
        }

        // Only once the baseline is confirmed: the root's backup is the
        // developer's text only while the chain above it is intact, and a
        // conflict must be reported as a conflict, not as an unreadable root.
        const developerText = await this.#chainRootText(parent.value);

        if (isErr(developerText)) {
          return await failed(developerText.error);
        }

        locationText = separateByteOrderMark(developerText.value).transformText;
      }

      const abortedBeforeTransform = this.#abortCheck(file, symbol, stage);

      if (abortedBeforeTransform !== undefined) {
        return await failed(abortedBeforeTransform);
      }

      await completed(stage);

      // ---------------------------------------------------------------------
      // Step 2 — build the patched content in memory. Nothing written yet.
      // ---------------------------------------------------------------------
      stage = 'build-patch';

      // The transform sees the source without its byte-order mark, and the
      // mark is put back — once, at byte 0 — around what it returns. Every
      // step from here on (the encode, `instrumentedHash`, the no-op check,
      // the journaled diff and the write) works on that full file text, so
      // the bytes hashed, described and installed are the same bytes.
      const boundary = separateByteOrderMark(originalText);

      const request: FunctionTimingRequest = {
        file,
        symbol,
        text: boundary.transformText,
        ...(locationText !== undefined ? { locationText } : {}),
        ...(input.action !== undefined ? { action: input.action } : {}),
        ...(input.spanName !== undefined ? { spanName: input.spanName } : {}),
      };

      const patched = this.#transform(request);

      if (isErr(patched)) {
        return await failed(patched.error);
      }

      if (patched.value.file !== file) {
        return await failed(
          new DebuggenError(
            'INTERNAL',
            'The transform described a different file from the one that was read.',
            {
              hint: 'Report this: the patch was abandoned and the project was not modified.',
              details: { reason: 'transform-target-mismatch', file, reported: patched.value.file },
            },
          ),
        );
      }

      const patchedText = boundary.toFileText(patched.value.patchedText);
      const patchedBytes = new TextEncoder().encode(patchedText);

      instrumentedHash = this.#files.hashBytes(patchedBytes);

      // A record whose two digests are equal would authorise a restore that
      // writes the same bytes back — harmless, but it would also tell the
      // developer their file was modified when it was not.
      if (instrumentedHash === originalHash) {
        return await failed(
          new DebuggenError(
            'PATCH_UNSUPPORTED',
            'The transform produced content identical to the original, so nothing was recorded.',
            {
              hint: 'The symbol may already be instrumented; check the session’s modification list.',
              details: { reason: 'no-op-patch', file, symbol },
            },
          ),
        );
      }

      const abortedBeforeBackup = this.#abortCheck(file, symbol, stage);

      if (abortedBeforeBackup !== undefined) {
        return await failed(abortedBeforeBackup);
      }

      await completed(stage);

      // ---------------------------------------------------------------------
      // Step 3 — copy the original bytes to the backup and fsync them.
      // ---------------------------------------------------------------------
      stage = 'store-backup';

      let backup: StoredBackup;

      try {
        const stored = await this.#backups.put(originalHash, originalBytes);

        if (isErr(stored)) {
          return await failed(stored.error);
        }

        backup = stored.value;
      } catch (cause) {
        return await failed(backupWriteFailure(cause, file, originalHash));
      }

      await completed(stage);

      // ---------------------------------------------------------------------
      // Step 4 — journal the record as `pending`, before any project byte
      // changes. This is what makes every later crash decidable.
      // ---------------------------------------------------------------------
      stage = 'journal-pending';

      const rendered = renderDiff(file, originalText, patchedText);

      const created = createModificationRecord(
        {
          sessionId: this.sessionId,
          planVersion: this.planVersion,
          file,
          originalHash,
          backupPath: backup.path,
          instrumentedHash,
          diff: rendered.text,
          ...(previousRecordId !== undefined ? { previousRecordId } : {}),
        },
        {
          now: this.#now,
          ...(this.#newId !== undefined ? { newId: this.#newId } : {}),
        },
      );

      if (isErr(created)) {
        return await failed(created.error);
      }

      const appended = await this.#journal.append(created.value);

      if (isErr(appended)) {
        return await failed(appended.error);
      }

      record = appended.value;
      this.#reserved.add(reservation);
      this.#journaled.push(record);

      const abortedBeforeWrite = this.#abortCheck(file, symbol, stage);

      if (abortedBeforeWrite !== undefined) {
        return await failed(abortedBeforeWrite);
      }

      await completed(stage);

      // ---------------------------------------------------------------------
      // Step 5 — the only write: temp file in the same directory, fsync,
      // re-check that the target is still the file that was read, rename over
      // it, with the target's mode preserved.
      // ---------------------------------------------------------------------
      stage = 'replace-file';

      // The pin makes the write reach the directory that was verified whatever
      // the path names by now — but "whatever the path names by now" is
      // something the developer should be told about rather than written
      // through silently. A directory moved or replaced since the pin was
      // taken is reported as a conflict, so the session does not quietly
      // instrument a file that is no longer where the plan said it was.
      if (!pinned.verifyDirectory()) {
        return await failed(raceLostDuringWrite('directory-changed', file, symbol, backup.path));
      }

      let replacement: AtomicReplaceVerdict;

      // Conditional, not unconditional. Everything between step 1 and here — a
      // parse, a transform, two digests, a backup write and a journal append —
      // is time in which the developer can save the same file, and an
      // unconditional `rename` would discard that edit with no trace and then
      // record an `originalHash` for bytes they no longer had (CWE-367). The
      // condition is the exact bytes step 1 read and the inode it read them
      // from, and the install refuses rather than overwrites, so nothing at
      // the target path is destroyed without being retained and inspected.
      try {
        replacement = this.#files.replaceFileIfUnchanged(absolutePath, patchedBytes, {
          bytes: originalBytes,
          identity: snapshot.identity,
        });
      } catch (cause) {
        return await failed(
          new DebuggenError(
            'INSTRUMENTATION_INSTALL_FAILED',
            'The instrumented content could not be written, so the file still holds its original bytes.',
            {
              hint: 'Check that the file and its directory are writable; the recorded backup is retained either way.',
              details: { reason: 'replace-failed', file, errno: errnoCodeOf(cause) },
              cause,
            },
          ),
        );
      }

      if (replacement.kind === 'stale') {
        // The developer's version is on disk untouched, so this is a conflict
        // and not a failure to write: the record is moved to `failed` with both
        // hashes on it, and reconciliation — which finds a file matching
        // neither digest — reports it and leaves the file alone. AAP §0.5.1:
        // never overwritten.
        return await failed(raceLostDuringWrite(replacement.reason, file, symbol, backup.path));
      }

      fileMayHoldPatch = true;

      await completed(stage);

      // ---------------------------------------------------------------------
      // Step 6 — mark the record `applied`. Only now, and never before.
      // ---------------------------------------------------------------------
      stage = 'mark-applied';

      const marked = await this.#journal.updateStatus(record.id, 'applied', {
        appliedAt: this.#now(),
      });

      if (isErr(marked)) {
        return await failed(
          new DebuggenError(
            'STORE_ERROR',
            'The patch was written but its record could not be marked applied.',
            {
              hint: 'The record still carries both hashes, so the file is restored on the next reconciliation.',
              details: { reason: 'mark-applied-failed', recordId: record.id, file },
              cause: marked.error,
            },
          ),
        );
      }

      record = marked.value;
      this.#replaceJournaled(record);

      await completed(stage);

      this.#logger.debug('a patch was applied', {
        recordId: record.id,
        file,
        symbol,
        planVersion: this.planVersion,
        originalHash,
        instrumentedHash,
        backupReused: backup.reused,
        chained: previousRecordId !== undefined,
      });

      return {
        kind: 'applied',
        outcome: {
          record,
          location: patched.value.location,
          status: record.status,
          originalHash,
          instrumentedHash,
          backup,
          previousRecordId,
          diffTruncated: rendered.truncated,
          patch: patched.value,
          stages,
        },
      };
    } catch (cause) {
      // Reached by an injected stage failure, by a journal or store
      // implementation that threw where its contract says it returns `err`, or
      // by a defect here. Either way the failure is absorbed into a value: the
      // record, if one exists, is moved to `failed`, and the reconciliation
      // table decides what the file needs.
      return await failed(
        DebuggenError.is(cause)
          ? cause
          : new DebuggenError('INTERNAL', 'The patch sequence failed unexpectedly.', {
              hint: 'Report this with the file and symbol; any recorded modification is reconciled on the next start.',
              details: { reason: 'sequence-failed', stage, file, symbol },
              cause,
            }),
      );
    } finally {
      // One descriptor per patched file, held only for the length of the
      // sequence. A session that instruments twenty files must not end holding
      // twenty directory handles.
      pinned?.release();
    }
  }

  /**
   * Finds the record this patch is layered on, or establishes that there is
   * none.
   *
   * An explicit parent is validated rather than trusted — same session, same
   * file, `applied` — because a mismatched one would give the new record an
   * `originalHash` for bytes the developer never had. Without one, the
   * session's records are listed in append order and the **last `applied`
   * record for the same file** is the parent (AAP §0.4.2).
   *
   * Any other open record for the file — `pending`, `failed` or `conflict` —
   * refuses the patch. The baseline of such a file is undecided until
   * reconciliation has run, and layering a new record on an undecided one is
   * how a chain stops being unwindable.
   */
  async #resolveChainParent(
    file: string,
    explicit: ModificationRecord | undefined,
  ): Promise<Result<ModificationRecord | undefined>> {
    if (explicit !== undefined) {
      if (explicit.sessionId !== this.sessionId || explicit.file !== file) {
        return err(
          new DebuggenError(
            'INSTRUMENTATION_INSTALL_FAILED',
            'The record offered as the previous patch describes a different file or session.',
            {
              hint: 'Pass the record whose instrumented bytes the file currently holds, or pass none and let the journal decide.',
              details: { reason: 'chain-parent-mismatch', file, recordId: explicit.id },
            },
          ),
        );
      }

      if (explicit.status !== 'applied') {
        return err(unreconciledRecord(file, explicit));
      }

      return ok(explicit);
    }

    const listed = await this.#journal.listBySession(this.sessionId);

    if (isErr(listed)) {
      return listed;
    }

    let parent: ModificationRecord | undefined;

    for (const candidate of listed.value) {
      if (candidate.file !== file) {
        continue;
      }

      if (candidate.status === 'applied') {
        parent = candidate;
        continue;
      }

      if (candidate.status !== 'reverted') {
        return err(unreconciledRecord(file, candidate));
      }
    }

    return ok(parent);
  }

  /**
   * Asks `./conflict.js` whether the file is in the state the parent record
   * says it should be in.
   *
   * The comparison itself is never repeated here: a restorable verdict *is* the
   * statement "the file hashes to this record's `instrumentedHash`", which is
   * exactly the baseline a chained patch assumes, and it comes with the
   * assurance that the parent's backup can still be read — without which the
   * chain could not be unwound afterwards.
   *
   * The one extra check is a consistency one rather than a second decision: the
   * digest the detector saw must equal the digest this sequence hashed a moment
   * earlier, or the file changed between the two reads and the patch would be
   * computed from bytes that are no longer there.
   */
  async #confirmBaseline(
    parent: ModificationRecord,
    originalHash: string,
  ): Promise<Result<ConflictVerdict, BaselineRefusal>> {
    const detected = await this.#detectConflict(parent, this.#context);

    if (isErr(detected)) {
      return err({ error: detected.error, conflict: undefined });
    }

    const verdict = detected.value;

    if (isConflictVerdict(verdict)) {
      return err({
        error: new DebuggenError(
          'MODIFICATION_CONFLICT',
          'The file changed since it was last instrumented, so Debug Generator will not overwrite it.',
          {
            hint: `The original is saved at ${parent.backupPath}. Resolve the conflict, then ask again.`,
            details: {
              reason: verdict.conflict.reason,
              file: parent.file,
              recordId: parent.id,
            },
          },
        ),
        conflict: verdict.conflict,
      });
    }

    if (verdict.kind === 'already-reverted') {
      return err({
        error: new DebuggenError(
          'MODIFICATION_CONFLICT',
          'The file no longer holds the instrumented content the previous record recorded.',
          {
            hint: 'Reconcile the earlier modification first; a new patch cannot be layered on a reverted one.',
            details: { reason: 'baseline-mismatch', file: parent.file, recordId: parent.id },
          },
        ),
        conflict: undefined,
      });
    }

    if (verdict.actualHash !== originalHash) {
      return err({
        error: new DebuggenError(
          'MODIFICATION_CONFLICT',
          'The file changed while it was being prepared for instrumentation.',
          {
            hint: 'Nothing was written. Ask again once the file has settled.',
            details: { reason: 'content-changed', file: parent.file, recordId: parent.id },
          },
        ),
        conflict: undefined,
      });
    }

    return ok(verdict);
  }

  /**
   * The developer's own text of a file this session already patched: the
   * backup at the **root** of the file's chain.
   *
   * A chained patch is computed against layered bytes — the helper alias and
   * every earlier wrapper are already in them — so a position read from those
   * bytes points below where the developer's function actually is, by as many
   * lines as the layers above it added (AAP §0.4.2 gives the patch route its
   * authority precisely from recording the developer's position). The chain's
   * root record is the one patch whose `originalHash` describes bytes this
   * session never touched, and its backup holds exactly those bytes, so that is
   * the text the transform resolves the position in.
   *
   * The walk follows `previousRecordId` through this session's journal from the
   * parent back to the record with none. Every link must be a record of the same
   * file, and the walk refuses a missing link or a cycle rather than stopping
   * short: a record reached that way would not be the root, and its backup
   * would carry an earlier patch. The root's backup is then read from where the
   * record says it is — the same read restoration performs — and its digest is
   * checked against the root's `originalHash`, because the store does not
   * re-check on read and the bytes are about to decide what the developer is
   * sent to.
   *
   * Called only after the baseline is confirmed, and it reads nothing but the
   * state directory: no project byte is involved.
   *
   * @param parent The applied record the new patch layers on.
   * @returns The root backup's decoded text, or `INSTRUMENTATION_INSTALL_FAILED`
   * with reason `chain-root-unreadable` naming why it could not be established.
   */
  async #chainRootText(parent: ModificationRecord): Promise<Result<string>> {
    const unreadable = (cause: string, extra: Record<string, unknown> = {}): Result<never> =>
      err(
        new DebuggenError(
          'INSTRUMENTATION_INSTALL_FAILED',
          'The original of this already-instrumented file could not be read back, so the position of a further patch in it could not be recorded.',
          {
            hint: 'Nothing was written. End the session to restore the file, then plan the target again.',
            details: {
              reason: 'chain-root-unreadable',
              cause,
              file: parent.file,
              recordId: parent.id,
              ...extra,
            },
          },
        ),
      );

    const listed = await this.#journal.listBySession(this.sessionId);

    if (isErr(listed)) {
      return listed;
    }

    const byId = new Map(listed.value.map((candidate) => [candidate.id, candidate] as const));
    const visited = new Set<string>([parent.id]);
    let root = parent;

    while (root.previousRecordId !== undefined) {
      const previous = byId.get(root.previousRecordId);

      if (previous === undefined) {
        return unreadable('chain-link-missing', { missingRecordId: root.previousRecordId });
      }

      if (previous.file !== parent.file) {
        return unreadable('chain-link-other-file', { linkRecordId: previous.id });
      }

      if (visited.has(previous.id)) {
        return unreadable('chain-cycle', { linkRecordId: previous.id });
      }

      visited.add(previous.id);
      root = previous;
    }

    let bytes: Uint8Array;

    try {
      const read = await this.#backups.readRecorded(root.backupPath, root.originalHash);

      if (isErr(read)) {
        return unreadable('backup-unreadable', {
          rootRecordId: root.id,
          code: read.error.code,
          backupReason: read.error.details?.['reason'],
        });
      }

      bytes = read.value.bytes;
    } catch (cause) {
      return unreadable('backup-unreadable', {
        rootRecordId: root.id,
        errno: errnoCodeOf(cause),
      });
    }

    if (this.#files.hashBytes(bytes) !== root.originalHash) {
      return unreadable('backup-digest-mismatch', { rootRecordId: root.id });
    }

    const decoded = decodeSource(bytes, parent.file);

    if (isErr(decoded)) {
      return unreadable('backup-not-utf8', { rootRecordId: root.id });
    }

    return ok(decoded.value);
  }

  /**
   * The abort check, as a value rather than a throw.
   *
   * Called at stage boundaries only: interrupting between the temp write and
   * the rename is the one cancellation that could leave a state no table
   * describes, so the write itself is never checked.
   */
  #abortCheck(file: string, symbol: string, stage: PatchStage): DebuggenError | undefined {
    if (this.#signal?.aborted !== true) {
      return undefined;
    }

    return new DebuggenError(
      'INSTRUMENTATION_INSTALL_FAILED',
      'The patch was abandoned because the install was cancelled.',
      {
        hint: 'Nothing was written for this target. Start the session again to instrument it.',
        details: { reason: 'aborted', stage, file, symbol },
      },
    );
  }

  /**
   * Keeps {@link Patcher.journaledRecords} in step with a status transition.
   *
   * The list is what a caller reverse-restores from, so a record in it has to
   * carry the status the journal now holds rather than the one it was appended
   * with.
   */
  #replaceJournaled(updated: ModificationRecord): void {
    const index = this.#journaled.findIndex((candidate) => candidate.id === updated.id);

    if (index >= 0) {
      this.#journaled[index] = updated;
    }
  }

  journaledRecords(): readonly ModificationRecord[] {
    return [...this.#journaled];
  }

  detectedConflicts(): readonly ModificationConflict[] {
    return [...this.#conflicts];
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers.
// ---------------------------------------------------------------------------

/**
 * A refused baseline: the coded error, and the conflict report when the
 * detector produced one.
 *
 * Two fields rather than one because they travel to different places. The error
 * goes back to the caller and may be logged and persisted, so it carries
 * identifiers and a reason only; the report holds three-way diffs of the
 * developer's file and therefore stays on {@link Patcher.detectedConflicts},
 * where a caller has to ask for it (AAP §0.5.2).
 */
interface BaselineRefusal {
  /** Why the patch was refused. */
  readonly error: DebuggenError;

  /** The report to show the developer, when the detector produced one. */
  readonly conflict: ModificationConflict | undefined;
}

/**
 * The key one `(file, symbol)` pair is reserved under, once a record for it
 * exists in this plan version.
 *
 * `JSON.stringify` of the pair rather than a joined string: every plausible
 * separator is a legal character in both halves — a POSIX file name may contain
 * `'|'` and so may the text of a symbol — so a naive join would give two
 * different targets one key and the guard would refuse a patch it should allow,
 * or admit one it should refuse. JSON escaping is uniquely decodable, which is
 * all a comparison key needs. The identity is deliberately *not*
 * `actionIdentityKey`'s triple: two actions naming the same symbol with
 * different types (a function timing and a server span) wrap the same
 * declaration, so they must collide here.
 */
function reservationKey(file: string, symbol: string): string {
  return JSON.stringify([file, symbol]);
}

/**
 * The refusal for a file that still carries an unreconciled record.
 *
 * `pending`, `failed` and `conflict` all mean the same thing to this module:
 * what the file currently holds has not been decided yet, so no new record can
 * state an `originalHash` for it. Reconciliation — on the next service start,
 * or at the end of the session — settles it, and only then can the file be
 * patched again.
 */
function unreconciledRecord(file: string, record: ModificationRecord): DebuggenError {
  return new DebuggenError(
    'MODIFICATION_CONFLICT',
    'This file already has an unresolved modification record, so it will not be patched again.',
    {
      hint: `The recorded original is saved at ${record.backupPath}. Resolve that modification first.`,
      details: { reason: 'unreconciled-record', file, recordId: record.id, status: record.status },
    },
  );
}

/**
 * The coded failure for a target that could not be read.
 *
 * Three conditions are named because each has a different developer-facing
 * answer, and the rest keep their errno for a bug report. `ELOOP` is the one
 * worth spelling out: it is how the platform reports `O_NOFOLLOW` meeting a
 * symbolic link at the final component, which is a refusal to read through a
 * link rather than a missing file.
 */
function readFailure(cause: unknown, file: string): DebuggenError {
  const errno = errnoCodeOf(cause);

  if (errno === 'ENOENT') {
    return new DebuggenError('PATCH_TARGET_NOT_FOUND', 'The file to patch is not there.', {
      hint: 'Re-index the project: the plan named a file that no longer exists.',
      details: { reason: 'file-not-found', file },
      cause,
    });
  }

  if (errno === 'ELOOP') {
    return new DebuggenError(
      'FS_UNSAFE_PATH',
      'The path to patch is a symbolic link, and Debug Generator will not write through one.',
      {
        hint: 'Instrument the file the link points at, by its own path.',
        details: { reason: 'symlink-at-target', file },
        cause,
      },
    );
  }

  return new DebuggenError(
    'INSTRUMENTATION_INSTALL_FAILED',
    'The file to patch could not be read, so nothing was modified.',
    {
      hint: 'Check the file is readable and is a regular file, then ask again.',
      details: { reason: 'target-unreadable', file, errno },
      cause,
    },
  );
}

/**
 * The coded failure for original bytes the backup store could not file.
 *
 * Always `INSTRUMENTATION_INSTALL_FAILED` with `details.reason`
 * `'backup-write-failed'` and the store's throw as the cause — nothing was
 * patched, and nothing in the project was touched — but worded for the
 * condition the store actually met, because each has a different remedy:
 *
 * - **`ELOOP`** is how a no-follow open reports a symbolic link at the final
 *   component: something planted a link at the backup path, and the store
 *   refused to follow it rather than write through it or trust what it points
 *   at. Removing the link is what lets the install proceed.
 * - **A `DebuggenError`** is the store's own refusal — `FS_UNSAFE_PATH` from the
 *   state-directory policy of `@debuggen/shared/node` for a directory that is a
 *   link, owned by another account or open to others — and its message and hint
 *   already name the directory and the fix, so both are quoted.
 * - **Any other errno** (`EACCES`, `EROFS`, `ENOSPC`, …) is named, with the
 *   remedy the common ones call for.
 *
 * The errno or code goes into `details.errno` as it always has. The backup
 * path a platform error carries is quoted: it is the product's own state
 * directory, never a byte of the developer's file.
 *
 * @param cause What `BackupStore.put` threw.
 * @param file The project-relative file being patched.
 * @param originalHash The digest the original was to be filed under.
 * @returns The coded failure.
 */
function backupWriteFailure(cause: unknown, file: string, originalHash: string): DebuggenError {
  const errno = errnoCodeOf(cause);
  const headline = 'The original bytes could not be backed up, so nothing was patched';
  const unmodified = 'The project was not modified.';
  const options = {
    details: { reason: 'backup-write-failed', file, originalHash, errno },
    cause,
  };

  if (DebuggenError.is(cause)) {
    return new DebuggenError(
      'INSTRUMENTATION_INSTALL_FAILED',
      `${headline}: ${sentenceOf(cause.message)}`,
      {
        ...options,
        hint:
          cause.hint === undefined || cause.hint.trim().length === 0
            ? `Check the Debug Generator state directory against the refusal above (${cause.code}). ${unmodified}`
            : `${sentenceOf(cause.hint)} ${unmodified}`,
      },
    );
  }

  const path = pathOf(cause);
  const where = path === undefined ? 'at the backup path' : `at '${path}'`;

  if (errno === 'ELOOP') {
    return new DebuggenError(
      'INSTRUMENTATION_INSTALL_FAILED',
      `${headline}: a symbolic link is planted ${where} in the Debug Generator state directory, and it was refused rather than followed (ELOOP).`,
      {
        ...options,
        hint: `Remove the symbolic link ${where} so the backup can be written there, then install again. ${unmodified}`,
      },
    );
  }

  return new DebuggenError(
    'INSTRUMENTATION_INSTALL_FAILED',
    `${headline}: writing the backup ${where} failed with ${errno ?? 'an unrecognised error'}.`,
    { ...options, hint: `${backupWriteRemedy(errno)} ${unmodified}` },
  );
}

/**
 * The next step for a backup write that failed with a platform errno.
 *
 * @param errno The errno, when the failure carried one.
 * @returns One sentence.
 */
function backupWriteRemedy(errno: string | undefined): string {
  switch (errno) {
    case 'EACCES':
    case 'EPERM':
      return `Make the Debug Generator state directory writable by the account the service runs as (${errno}: permission denied).`;
    case 'EROFS':
      return 'Point DEBUGGEN_HOME at a writable location: the Debug Generator state directory is on a read-only file system (EROFS).';
    case 'ENOSPC':
    case 'EDQUOT':
      return `Free space on the disk that holds the Debug Generator state directory (${errno}: no space or quota left).`;
    case 'EISDIR':
      return 'Remove the directory standing at the backup path in the Debug Generator state directory (EISDIR).';
    default:
      return 'Check that the Debug Generator state directory is writable and has space.';
  }
}

/**
 * The `path` a platform error carries, when it carries one.
 *
 * @param value A caught value.
 * @returns The path, or `undefined`.
 */
function pathOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'path' in value) {
    const path: unknown = value.path;

    return typeof path === 'string' && path.length > 0 ? path : undefined;
  }

  return undefined;
}

/**
 * Ends a quoted message the way a sentence mid-paragraph needs.
 *
 * @param text A developer-facing message or hint.
 * @returns The trimmed text, with a full stop when it had no terminal
 * punctuation.
 */
function sentenceOf(text: string): string {
  const trimmed = text.trim();

  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The coded failure for a target whose canonical path could not be established.
 *
 * `resolveRealPathWithinProject` reports one code — `PATH_OUTSIDE_PROJECT` —
 * for every refusal, which is right for a containment gate and wrong for the
 * one refusal that is not about containment at all: a directory that is simply
 * not there. That case is a stale plan, and it has a different answer for the
 * developer, so it is re-coded here. The distinction comes from the platform
 * errno the gate preserved on the error's `cause`; an escape carries no cause
 * and therefore passes through untouched.
 */
function unresolvableTarget(error: DebuggenError, file: string): DebuggenError {
  const errno = errnoCodeOf(error.cause);

  if (errno !== 'ENOENT' && errno !== 'ENOTDIR') {
    return error;
  }

  return new DebuggenError('PATCH_TARGET_NOT_FOUND', 'The file to patch is not there.', {
    hint: 'Re-index the project: the plan named a file that no longer exists.',
    details: { reason: 'file-not-found', file, errno },
    cause: error,
  });
}

/**
 * The conflict for a target that stopped being the file this sequence read,
 * detected by the conditional replacement immediately before the rename.
 *
 * `MODIFICATION_CONFLICT` rather than an install failure, because nothing
 * failed: the write was *declined*, the developer's version is intact on disk,
 * and the wording follows the baseline refusal in
 * {@link SequencedPatcher.#confirmBaseline} so the two read alike whether the
 * change landed before the sequence started or during it.
 *
 * The backup path is named in the hint because it is the one thing the
 * developer cannot see for themselves: the bytes this sequence read are already
 * durable there, whatever happens next.
 */
function raceLostDuringWrite(
  reason: AtomicReplaceStaleReason | 'directory-changed',
  file: string,
  symbol: string,
  backupPath: string,
): DebuggenError {
  const message =
    reason === 'target-missing'
      ? 'The file disappeared while it was being prepared for instrumentation.'
      : reason === 'directory-changed'
        ? 'The directory holding the file was moved or replaced while it was being prepared for instrumentation.'
        : 'The file changed while it was being prepared for instrumentation.';

  return new DebuggenError('MODIFICATION_CONFLICT', message, {
    hint: `Nothing was written, so the file still holds your version; the bytes Debug Generator read are saved at ${backupPath}. Ask again once the file has settled.`,
    details: { reason, file, symbol },
  });
}

/**
 * Decodes the original bytes as UTF-8 for the transform, or refuses them.
 *
 * Strict (`fatal: true`), so content that is not valid UTF-8 is refused instead
 * of being peppered with replacement characters and written back as a file the
 * developer did not have. `ignoreBOM: true` is the load-bearing half: the
 * default *removes* a byte-order mark, and a file text rebuilt from BOM-less
 * text would silently drop three bytes from the front of the file — a change
 * outside the patched region, which is precisely what this module promises
 * never to make. Keeping the mark in the decoded text is what lets the
 * round-trip proof cover it and lets {@link separateByteOrderMark} hand the
 * transform the text without it and then put it back exactly once.
 *
 * The decoder is constructed per call rather than shared at module scope, so
 * importing this module still does nothing at all.
 */
function decodeSource(bytes: Uint8Array, file: string): Result<string> {
  try {
    return ok(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch (cause) {
    return err(
      new DebuggenError(
        'PATCH_UNSUPPORTED',
        'This file is not valid UTF-8, so it cannot be patched safely.',
        {
          hint: 'Time this code through a runtime hook instead, or re-save the file as UTF-8.',
          details: { reason: 'not-utf8', file },
          cause,
        },
      ),
    );
  }
}

/**
 * The decoded source as it crosses the text-to-transform boundary: the text the
 * transform is handed, and the one operation that turns the transform's output
 * back into the file's full text.
 */
interface TransformBoundary {
  /**
   * The decoded source without its leading run of {@link BYTE_ORDER_MARK} —
   * in practice the one mark an editor wrote — or the whole decoded source
   * when it has none.
   */
  readonly transformText: string;

  /**
   * The full text to encode, hash, journal and write: the transform's
   * `patchedText` with the original's leading mark back at offset 0, exactly as
   * the file held it. Returns its argument unchanged for a file that had no
   * mark.
   */
  toFileText(transformedText: string): string;
}

/**
 * Separates a leading UTF-8 byte-order mark from the text the transform sees,
 * so it can be put back — exactly once, at byte 0 — around what the transform
 * returns.
 *
 * TypeScript tooling treats a byte-order mark as an encoding mark, not as
 * source text: ts-morph drops a leading U+FEFF when it creates a source file,
 * so every position it reports is relative to the text *without* it. Handed the
 * BOM-bearing text {@link decodeSource} deliberately preserves,
 * `./function-timing.js` would apply each of those offsets one code unit early
 * to a string that still starts with the mark. Measured against the fixture
 * project, that silently rewrote bytes outside the patched region of a
 * JavaScript target (`}) {` became `}){`) and made every TypeScript target fail
 * the transform's own introduced-diagnostic check — so a file saved by an
 * editor that writes a BOM either could not be instrumented at all or was
 * changed where the patch had no business. Setting the mark aside here keeps
 * the transform a pure function of source text, and keeps the byte-level
 * concern in the module that owns bytes.
 *
 * Exact in both directions:
 *
 * - **The whole leading run is set aside.** In practice that run is the single
 *   mark an editor wrote. A file that also holds zero-width no-break spaces
 *   immediately after it gets the run set aside whole, because ts-morph drops
 *   exactly one leading U+FEFF per parse: handing it text that still began
 *   with one would reintroduce the same one-code-unit skew. The run is put back
 *   verbatim, so its length on disk never changes.
 * - **Never duplicated.** The transform was handed text that does not start
 *   with a U+FEFF, so any at the front of its output were introduced by it and
 *   are dropped before the file's own run is restored.
 *
 * A file without a mark crosses unchanged in both directions, so nothing about
 * its patch differs from what the transform produced.
 *
 * @param text The decoded source, exactly as {@link decodeSource} returned it.
 * @returns The text for the transform, and the inverse to apply to its output.
 */
function separateByteOrderMark(text: string): TransformBoundary {
  const markLength = leadingByteOrderMarkLength(text);

  if (markLength === 0) {
    return { transformText: text, toFileText: (transformedText) => transformedText };
  }

  const mark = text.slice(0, markLength);

  return {
    transformText: text.slice(markLength),
    toFileText: (transformedText) =>
      `${mark}${transformedText.slice(leadingByteOrderMarkLength(transformedText))}`,
  };
}

/**
 * How many {@link BYTE_ORDER_MARK} code units a text starts with: `0` for
 * ordinary source, `1` for a file an editor saved with a BOM.
 *
 * Counted by code unit rather than matched by pattern, so
 * {@link separateByteOrderMark} slices both texts by exactly what was counted.
 */
function leadingByteOrderMarkLength(text: string): number {
  let length = 0;

  while (text.startsWith(BYTE_ORDER_MARK, length)) {
    length += BYTE_ORDER_MARK.length;
  }

  return length;
}

/**
 * Renders the unified diff that is journaled with the record, bounded.
 *
 * `ignoreWhitespace` and `stripTrailingCr` are left at their defaults
 * (`false`), so the diff describes exactly the bytes the two hashes were taken
 * over; a whitespace-insensitive patch would contradict the comparison it is
 * there to explain. Neither `timeout` nor `maxEditLength` is passed, which is
 * what selects the overload that returns a `string` — the guard below states
 * that rather than asserting it away, and costs one comparison.
 *
 * Over the limit the text is clipped and
 * {@link PATCH_DIFF_TRUNCATION_NOTICE} appended, and the caller reports the
 * truncation on the outcome. Clipping rather than dropping is deliberate: the
 * first hunks are the ones a reviewer reads, and the record's hashes remain the
 * authority on the change either way.
 */
function renderDiff(
  file: string,
  originalText: string,
  patchedText: string,
): { readonly text: string; readonly truncated: boolean } {
  const patch: string | undefined = createTwoFilesPatch(
    file,
    file,
    originalText,
    patchedText,
    DIFF_LABELS.original,
    DIFF_LABELS.instrumented,
    { context: PATCH_DIFF_CONTEXT_LINES },
  );

  if (patch === undefined) {
    return { text: '', truncated: false };
  }

  if (patch.length <= PATCH_DIFF_CHARACTER_LIMIT) {
    return { text: patch, truncated: false };
  }

  const keep = Math.max(PATCH_DIFF_CHARACTER_LIMIT - PATCH_DIFF_TRUNCATION_NOTICE.length, 0);

  return { text: `${patch.slice(0, keep)}${PATCH_DIFF_TRUNCATION_NOTICE}`, truncated: true };
}

/**
 * The errno code of a caught value, when it carries one.
 *
 * `catch` binds `unknown`, and the only reason this module inspects a caught
 * error is to tell three conditions it has an answer for apart from every other
 * failure, which keeps its own code. Written the same way as its counterparts
 * in `./backup-store.js` and `@debuggen/shared/node`, because a second, subtly
 * different reading of `error.code` is how one of them starts misclassifying a
 * refusal as a success.
 */
function errnoCodeOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code: unknown = value.code;
    return typeof code === 'string' ? code : undefined;
  }

  return undefined;
}

/**
 * Normalises whichever shape of transform the caller supplied to a function.
 *
 * A `FunctionTimingPatcher` is the shape a long-lived caller holds — it keeps
 * the in-memory ts-morph project that makes patching twenty files cost twenty
 * parses instead of twenty projects — and a bare function is the shape a suite
 * finds convenient. When neither is given, one patcher is built for this
 * patcher's project root with syntax verification left on, so emitted text that
 * would not parse is refused before it can be written over a running
 * developer's file.
 */
function toTransform(
  source: FunctionTimingSource | undefined,
  projectRoot: string,
  logger: Logger,
): FunctionTimingTransform {
  if (typeof source === 'function') {
    return source;
  }

  if (source !== undefined) {
    return (request) => source.patch(request);
  }

  const patcher = new FunctionTimingPatcher({ projectRoot, logger });

  return (request) => patcher.patch(request);
}

/**
 * The attempt input for a plan action.
 *
 * The action's own `file` and `symbol` are the target — a caller cannot state
 * one target and patch another — and the action travels on to the transform so
 * the patch records which action produced it.
 */
function inputFromAction(action: InstrumentationAction): AttemptInput {
  return {
    file: action.file,
    symbol: action.symbol,
    type: action.type,
    actionId: action.id,
    action,
    spanName: undefined,
  };
}

/**
 * The attempt input for a bare target.
 *
 * An absent `type` is read as a function timing, which is the only thing a
 * file-and-symbol target can mean.
 */
function inputFromTarget(target: PatchTarget): AttemptInput {
  return {
    file: target.file,
    symbol: target.symbol,
    type: target.type ?? 'function-timing',
    actionId: target.actionId,
    action: undefined,
    spanName: target.spanName,
  };
}

/**
 * Projects an attempt onto the `Result` the single-target methods return.
 *
 * The state a rollback needs — the journaled record, whether the write may have
 * landed, the conflict report — stays reachable on the patcher itself
 * ({@link Patcher.journaledRecords}, {@link Patcher.detectedConflicts}) and on
 * {@link PatchBatchResult}, because an `Err` carries an error and nothing else,
 * and an error's details must not carry a diff.
 */
function asResult(attempt: Attempt): Result<PatchOutcome> {
  return attempt.kind === 'applied' ? ok(attempt.outcome) : err(attempt.failure.error);
}
