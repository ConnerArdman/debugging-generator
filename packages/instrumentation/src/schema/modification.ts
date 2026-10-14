/**
 * `ModificationRecord` — the journal entry that makes instrumentation
 * reversible, and the single definition of it.
 *
 * This product edits files in a developer's working tree. The promise attached
 * to that is absolute: whatever happens — the process dies mid-write, the
 * machine loses power, the developer edits the same file while it is patched —
 * the file either comes back byte-for-byte or is left untouched and reported.
 * The record below is what makes that promise keepable. It says what was
 * changed, what the bytes hashed to before and after, where the original bytes
 * were copied, and what state the change is in.
 *
 * AAP §0.9.1 lists `packages/instrumentation/src/schema/**` among the schema
 * sources that have a **single** definition, and this shape has four
 * independent readers:
 *
 * - `apps/local-service/src/store/modifications-repo.ts` persists it, column
 *   for column, in the `modifications` table of AAP §0.2.3.
 * - `@debuggen/protocol` embeds it in the `instrumentation.ready` payload and
 *   embeds {@link ModificationConflict} in `cleanup.completed` (AAP §0.4.2).
 * - the VS Code extension renders it in `ModificationsList` and its `DiffView`.
 * - the DevTools panel renders it in `SessionSummary`.
 *
 * A second declaration of this shape anywhere in the monorepo is a defect: the
 * patcher writes these rows, SQLite stores them, and two user interfaces render
 * them, so the only way a developer can trust the "reverted" badge is for there
 * to be one place that says what the fields mean.
 *
 * ## The write sequence this record exists to serve (AAP §0.5.1)
 *
 * The ordering below is the specification, not an implementation detail, and
 * every field of {@link ModificationRecord} is there because one step of it
 * needs the field to already exist:
 *
 * ```text
 * 1. read the original bytes          → originalHash
 * 2. build the patched content        → instrumentedHash   (nothing written yet)
 * 3. copy the original to the backup  → backupPath, fsync'd
 * 4. append THIS RECORD as "pending"  → both hashes + the unified diff
 * 5. temp-write + fsync + rename over the original           (the only write)
 * 6. mark the record "applied"
 * ```
 *
 * Step 4 sits before step 5 deliberately. Because the journal already knows the
 * expected post-write hash, a later reconciliation can tell three otherwise
 * indistinguishable situations apart: *nothing was written* (the file still
 * hashes to `originalHash`), *our patch is on disk but was never marked* (it
 * hashes to `instrumentedHash`), and *the developer changed it* (it hashes to
 * neither). That is why `instrumentedHash` is a **required** field on a
 * `pending` record rather than something filled in after the write; reordering
 * those two steps for convenience silently destroys the guarantee.
 *
 * ## Start-up reconciliation, by status (AAP §0.5.1)
 *
 * `../cleanup.ts` walks every record whose status is in
 * {@link OPEN_MODIFICATION_STATUSES} — **regardless of the owning session's
 * status** — and decides per row:
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
 * ```
 *
 * A file whose hash differs from `instrumentedHash` is **never overwritten**:
 * the original stays in the backup directory and the divergence is reported as
 * a {@link ModificationConflict} with a three-way diff, which is what makes
 * "Debug Generator will not overwrite it" (AAP §0.5.5) a true statement.
 *
 * For a follow-up chain (below) the `hash === originalHash` line has a
 * chain-level counterpart, applied by `../cleanup.ts` to the head of what
 * remains of a chain when its status may close a record over a pristine file
 * (`pending`, `failed`, `conflict`): a file that hashes to the `originalHash`
 * of a record *beneath* the head, over links whose hashes agree, holds content
 * from before every write down to that record, so the head and each of those
 * records are closed without a write and the unwind continues beneath them.
 * That is how a conflict closes once the developer puts back the pristine
 * file — the chain root's original — rather than being re-reported forever.
 *
 * The `otherwise → conflict` lines have a chain-level counterpart too. When a
 * record's conflict is `'content-changed'` or `'file-missing'` and the file
 * holds no record's `instrumentedHash` (or is gone), it holds none of the
 * chain's output, so every open record beneath that one in the chain moves to
 * `conflict` with it (`applied`, `pending` or `failed` → `conflict`; one
 * already there stays) and keeps its backup, covered by that one conflict
 * report. So no record of the chain goes on claiming, as `applied`, bytes the
 * file no longer holds — a claim the patcher would read as another session
 * still holding the file. A stop for any other reason (an unusable backup, a
 * failed verification, a refused fork, a failure, an abort) leaves the records
 * beneath with their status untouched.
 *
 * ## Follow-up chains (AAP §0.4.2)
 *
 * A follow-up question can produce a new plan version whose delta touches a
 * file an earlier plan version already patched. The new record then takes the
 * earlier record's `instrumentedHash` as its own `originalHash` and links the
 * earlier record through {@link ModificationRecord.previousRecordId}. Chains
 * are additive — an earlier version's record is never rewritten — and cleanup
 * unwinds them in strict reverse order, verifying at each step that the file
 * currently hashes to *that* record's `instrumentedHash` before writing *that*
 * record's backup. Without the link, reverse-order restoration cannot be
 * verified hash by hash, which is the only reason the field exists.
 *
 * Only the **chain root** — the first record of the chain, the one with no
 * `previousRecordId` — backs up the pristine file. Every later link's backup
 * holds the previous plan version's instrumented output, which still contains
 * the tool's wrapper, so it is never what a developer should restore by hand.
 * {@link findChainRoot} resolves a record's root from the records beside it,
 * and a conflict about a chained record names the root's backup as
 * {@link ModificationConflict.originalBackupPath}: that is the path "Original
 * saved at ‹path›" (AAP §0.5.5) quotes, and the "original" side of its diff.
 *
 * ## Two constraints on this module, both load-bearing
 *
 * **No Node.** `@debuggen/protocol` embeds this schema as a *value*, and
 * protocol is bundled into the DevTools panel and the VS Code webview. A single
 * `node:*` or `@debuggen/shared/node` import here would break both bundles, so
 * the SHA-256 vocabulary this module needs is declared locally
 * ({@link SHA256_HEX_PATTERN}) rather than imported from the hashing module it
 * describes. Hashes are produced by `sha256Hex`/`sha256OfFile` in
 * `@debuggen/shared/node`, which return lowercase 64-character hex over **raw
 * bytes** with no newline or encoding normalisation — the fidelity the
 * restore-versus-conflict decision rests on.
 *
 * **JSON only.** These records travel over a WebSocket and land in SQLite JSON
 * columns, so every field is a JSON primitive: no `Date`, `Buffer`, `Map`,
 * `Set`, `bigint` or class instance appears below, and timestamps are epoch
 * milliseconds (`nowEpochMs()` from `@debuggen/shared`).
 *
 * ## This package never opens a database
 *
 * Persistence sits behind {@link ModificationJournal}, a port declared here and
 * implemented twice: by the service's `modifications-repo.ts` over synchronous
 * `node:sqlite`, and by the in-memory fakes the installer, cleanup and patcher
 * suites use. `@debuggen/instrumentation` imports neither `node:sqlite` nor any
 * store; the port is the seam.
 *
 * The module has **no sibling imports** — it is independent of `./plan.ts`,
 * `./readiness.ts` and `./target.ts`, and of everything under `../patch/` —
 * which is what lets the patcher, the conflict detector and cleanup all depend
 * on it without a cycle.
 */

import { z } from 'zod';

import {
  DebuggenError,
  err,
  isSafeRelativePath,
  newModificationId,
  normalizePosix,
  nowEpochMs,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

/**
 * The statuses a modification can be in, in the order AAP §0.2.3 lists them for
 * the store's `modifications.status` column.
 *
 * This tuple is the single source of the vocabulary: {@link ModificationStatus}
 * is derived from it, {@link modificationStatusSchema} validates against it
 * directly, and the store's `CHECK` constraint mirrors it. The order is the
 * AAP's and is preserved rather than sorted, because the service's
 * reconciliation documentation, the store DDL and this tuple are read side by
 * side.
 *
 * ## The lifecycle
 *
 * ```text
 * pending ──→ applied ──→ reverted
 *    │           │
 *    └──→ failed │──→ conflict
 * ```
 *
 * - `pending` — journaled with both hashes and the diff, **nothing written to
 *   the project yet** (step 4 of the sequence on this module).
 * - `applied` — the rename completed and the file hashes to
 *   `instrumentedHash`.
 * - `reverted` — the backup was restored, the restored content was verified
 *   against `originalHash`, and the backup was deleted. The only status that
 *   needs no further action, and the only one absent from
 *   {@link OPEN_MODIFICATION_STATUSES}.
 * - `failed` — the write sequence aborted part-way. Terminal until reconciled;
 *   the **backup is retained**, because reconciliation may still have to
 *   restore from it.
 * - `conflict` — the developer edited the file while it was instrumented, or a
 *   hash did not match where it had to — or, for a record beneath such a
 *   record in a follow-up chain, the file was shown to hold none of the
 *   chain's output, so this record's bytes are not on disk either. The
 *   **backup is retained** and the file is left exactly as the developer left
 *   it for as long as it diverges;
 *   every cleanup or reconciliation pass judges it again, restoring it once the
 *   file hashes to `instrumentedHash` (the edit was undone) and closing it once
 *   it hashes to `originalHash` — or, for a chained record, to the
 *   `originalHash` of a record beneath it, which closes those records too —
 *   either way ending `reverted`.
 *
 * Frozen because it is a module-level table read on every validation: a
 * mutation would widen or narrow what every process in the product accepts.
 */
export const MODIFICATION_STATUSES = Object.freeze([
  'pending',
  'applied',
  'reverted',
  'conflict',
  'failed',
] as const);

/**
 * The state of one recorded file modification.
 *
 * Derived from {@link MODIFICATION_STATUSES} rather than declared beside it, so
 * the values and the type cannot drift: adding a status widens this union in
 * the same edit, and every consumer that switches exhaustively over it — the
 * reconciliation table in `../cleanup.ts`, the status badge in the VS Code
 * `ModificationsList` — stops compiling until it says something about the new
 * case.
 */
export type ModificationStatus = (typeof MODIFICATION_STATUSES)[number];

/**
 * The validator for a single {@link ModificationStatus}.
 *
 * Built from {@link MODIFICATION_STATUSES} so the enumeration can never drift
 * from the documented set. Exported on its own because the store reads a status
 * back out of a text column and the protocol validates one inside a status
 * patch, both of which need the field validator without the whole record.
 */
export const modificationStatusSchema = z.enum(MODIFICATION_STATUSES);

/**
 * The status a record is created in: `'pending'`.
 *
 * Named rather than inlined because it is the journal-before-write state of AAP
 * §0.5.1 — the state that exists precisely so a crash between the journal
 * append and the rename is decidable — and {@link createModificationRecord}
 * defaults to it. A caller that passes an explicit status is either restoring a
 * stored row or recording a failure it already knows about.
 */
export const DEFAULT_MODIFICATION_STATUS: ModificationStatus = 'pending';

/**
 * The statuses that still require action from start-up reconciliation:
 * everything except `'reverted'`.
 *
 * This is the filter behind {@link ModificationJournal.listOpen}, and the set
 * AAP §0.5.1 requires the service to act on **regardless of the owning
 * session's status** — a session left in `capturing`, `generated` or `failed`
 * still has files on disk that must be restored, so reconciliation keys off the
 * record, never off the session.
 *
 * `'conflict'` is deliberately included: a conflicting record is not finished
 * business. Every start judges it again — restored once its file hashes to
 * `instrumentedHash` again, closed once it hashes to `originalHash` — and
 * while the file still diverges its backup is retained and it is re-reported,
 * which is the behaviour AAP §0.5.1 specifies for the row and AAP §0.5.5
 * specifies for the message and its "Open diff" action.
 */
export const OPEN_MODIFICATION_STATUSES = Object.freeze([
  'pending',
  'applied',
  'failed',
  'conflict',
] as const);

/**
 * A status that still requires reconciliation. See
 * {@link OPEN_MODIFICATION_STATUSES}.
 *
 * A subset of {@link ModificationStatus}, so a value of this type is usable
 * anywhere a status is expected, while a function that only accepts open
 * statuses — a reconciliation branch, for instance — can say so in its
 * signature.
 */
export type OpenModificationStatus = (typeof OPEN_MODIFICATION_STATUSES)[number];

/**
 * Whether a value is a {@link ModificationStatus}.
 *
 * For the boundaries that hold an unknown string and need a boolean rather than
 * a diagnostic: a row read from the store, a status arriving in a patch. Use
 * {@link modificationStatusSchema} wherever the rejection has to explain
 * itself.
 *
 * @param value Any value.
 * @returns `true` when `value` is one of {@link MODIFICATION_STATUSES},
 * narrowing it to {@link ModificationStatus}.
 */
export function isModificationStatus(value: unknown): value is ModificationStatus {
  return typeof value === 'string' && (MODIFICATION_STATUSES as readonly string[]).includes(value);
}

/**
 * Whether a status still requires reconciliation.
 *
 * Equivalent to "is not `'reverted'`", written as membership of
 * {@link OPEN_MODIFICATION_STATUSES} so that adding a status forces a decision
 * about which side of the line it falls on rather than silently inheriting
 * "open" from a negation.
 *
 * @param value Any value.
 * @returns `true` when `value` is one of {@link OPEN_MODIFICATION_STATUSES},
 * narrowing it to {@link OpenModificationStatus}.
 */
export function isOpenModificationStatus(value: unknown): value is OpenModificationStatus {
  return (
    typeof value === 'string' && (OPEN_MODIFICATION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The shape of a SHA-256 digest as this product writes it: 64 lowercase hex
 * characters, anchored at both ends.
 *
 * It lives here, rather than being imported from the module that produces the
 * digests, for the reason stated at the top of this file: `sha256Hex` and
 * `sha256OfFile` are in `@debuggen/shared/node`, and this module must stay free
 * of Node imports because `@debuggen/protocol` embeds it as a value and is
 * bundled into two browser-like surfaces. `@debuggen/shared` exports no hex
 * pattern, so the pattern is declared once here and reused by every field that
 * carries a digest.
 *
 * **Lowercase only, and deliberately so.** The hashing module documents
 * lowercase output; accepting uppercase would let two spellings of the same
 * digest into the store, and a string comparison — which is what the
 * restore-versus-conflict decision is — would then answer "different" for
 * identical content.
 *
 * **No `g` flag.** A global regular expression carries a mutable `lastIndex`,
 * so repeated `.test()` calls against the same shared instance alternate
 * between true and false. This pattern is module-level and used on every
 * validation, which is exactly the situation that makes that bug invisible
 * until it corrupts a decision. The same convention governs `TRACE_ID_PATTERN`
 * and `SPAN_ID_PATTERN` in `@debuggen/shared`.
 */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The shape of a modification id: `mod_` followed by 16 lowercase alphanumeric
 * characters.
 *
 * Mirrors `newModificationId()` from `@debuggen/shared`, whose alphabet is
 * `0-9a-z` with a three-letter prefix from `ID_PREFIXES`. Exported so the
 * patcher, the store and the suites can recognise an id without importing the
 * generator, and anchored with no `g` flag for the reason given on
 * {@link SHA256_HEX_PATTERN}.
 */
export const MODIFICATION_ID_PATTERN = /^mod_[0-9a-z]{16}$/;

/**
 * The cap on {@link ModificationRecord.diff}: 2 MiB.
 *
 * Generous on purpose — a unified diff of a wrapped function is a few hundred
 * bytes, and the limit exists to stop a pathological case (a minified bundle, a
 * wholesale rewrite) from putting megabytes into a SQLite row and an
 * `instrumentation.ready` WebSocket frame, not to trim ordinary output.
 *
 * Truncation, if it is ever needed, is the **patcher's** decision, not this
 * schema's: a schema that silently shortened a diff would hand both user
 * interfaces a patch that does not describe the bytes that were hashed. The
 * record carries no truncation flag, so a patcher that shortens what it emits
 * says so inside the diff text it writes; this field rejects anything past the
 * cap.
 */
export const MAX_MODIFICATION_DIFF_LENGTH = 2 * 1024 * 1024;

/**
 * The cap on each of the three diffs in a {@link ModificationConflict}: 512 KiB.
 *
 * Lower than {@link MAX_MODIFICATION_DIFF_LENGTH} because a conflict carries up
 * to three patches at once and is delivered inside a `cleanup.completed`
 * message that both user interfaces render immediately. `../patch/conflict.ts`
 * measures each text against this constant before it composes a report. The
 * conflict shape carries no truncation flag either, so a patch that does not
 * fit is left out — an absent member already reads as "no patch to show here" —
 * or accounted for in the developer-facing `message` the producer authors. What
 * it must never do is deliver a clipped patch that presents itself as the whole
 * change.
 */
export const MAX_CONFLICT_DIFF_LENGTH = 512 * 1024;

/**
 * The cap on {@link ModificationRecord.file}, in characters.
 *
 * Above any real project-relative path and below every filesystem's own limit,
 * so an absurd value is rejected at the schema boundary rather than by a
 * syscall halfway through the write sequence.
 */
const MAX_FILE_PATH_LENGTH = 1024;

/**
 * The cap on {@link ModificationRecord.backupPath}, in characters.
 *
 * Larger than {@link MAX_FILE_PATH_LENGTH} because a backup path is absolute:
 * `$DEBUGGEN_HOME/backups/<sessionId>/<originalHash>` plus whatever the
 * developer's home directory contributes. 4096 is the conventional `PATH_MAX`
 * on Linux.
 */
const MAX_BACKUP_PATH_LENGTH = 4096;

/** The cap on a session id, comfortably above the `ses_…` form ids.ts mints. */
const MAX_SESSION_ID_LENGTH = 128;

/** The cap on the developer-facing message of a {@link ModificationConflict}. */
const MAX_CONFLICT_MESSAGE_LENGTH = 2048;

/**
 * Whether a string contains a C0 control character, `DEL`, or a C1 control
 * character.
 *
 * Written as a character-code scan rather than a regular expression on purpose:
 * a literal control range in a regular expression trips ESLint's
 * `no-control-regex`, and the intent — "no unprintable byte may reach a
 * filesystem call, a log line or a user interface" — is clearer as a predicate
 * than as an escape sequence. NUL is the case that matters most: a path
 * containing one is truncated by the C library at the NUL, so the path a
 * syscall acts on is not the path that was validated.
 *
 * `isSafeRelativePath` from `@debuggen/shared` already applies the same rule to
 * project-relative paths; this helper exists for the values that are *not*
 * project-relative — the backup path and the session id — and must still be
 * free of control characters.
 *
 * @param value The string to scan.
 * @returns `true` when at least one control character is present.
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
 * The validator for any SHA-256 digest field in this module.
 *
 * Both hashes on a record and both hashes on a conflict are built from this one
 * schema, so `originalHash`, `instrumentedHash`, `expectedHash` and
 * `actualHash` cannot disagree about what a digest looks like.
 */
export const sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN, {
  error: 'A hash must be a SHA-256 digest written as 64 lowercase hexadecimal characters.',
});

/** The validator for {@link ModificationRecord.id} and `previousRecordId`. */
const modificationIdSchema = z.string().regex(MODIFICATION_ID_PATTERN, {
  error:
    'A modification id must be "mod_" followed by 16 lowercase alphanumeric characters, as newModificationId() produces.',
});

/**
 * The validator for the session a record or conflict belongs to.
 *
 * Not pattern-matched against the `ses_…` form: sessions read back from an
 * older store, or created by a test fixture, are legitimately spelled
 * differently, and rejecting them here would make a stored session
 * unrecoverable. Control characters are refused, though, because the session id
 * is interpolated into the backup directory path
 * (`$DEBUGGEN_HOME/backups/<sessionId>/…`).
 */
const sessionIdSchema = z
  .string()
  .min(1)
  .max(MAX_SESSION_ID_LENGTH)
  .refine((value) => value.trim().length > 0 && !hasControlCharacter(value), {
    error: 'A session id must be a non-blank string with no control characters.',
  });

/**
 * The validator for the file a modification touched: **project-relative POSIX**.
 *
 * `isSafeRelativePath` is the same containment predicate the patcher applies
 * before it resolves the path, the service's `source/open.ts` applies before it
 * forwards a click, and the VS Code URI handler applies independently of both.
 * It rejects an absolute path, a Windows drive or UNC path, a backslash, any
 * surviving `..` segment, a blank string and any control character — so an
 * absolute developer path can never reach a panel or a prompt, and a traversal
 * can never reach a filesystem call.
 *
 * It is a gate, not *the* gate: a string check cannot see that a path inside
 * the project is a symlink pointing out of it, which is why the patcher reads
 * through `readFileNoFollow` and the service re-validates against the session's
 * project root.
 */
const projectRelativeFileSchema = z
  .string()
  .min(1)
  .max(MAX_FILE_PATH_LENGTH)
  .refine(isSafeRelativePath, {
    error:
      'file must be a project-relative POSIX path: no absolute or drive-letter path, no ".." segment, no backslash and no control character.',
  });

/**
 * The validator for the path the original bytes were copied to.
 *
 * **Not project-relative, and deliberately not containment-checked against the
 * project.** Backups live outside every checkout, under
 * `$DEBUGGEN_HOME/backups/<sessionId>/<originalHash>` (AAP §0.2.3, §0.4.2), so
 * that a debugging session never pollutes the developer's `git status` and a
 * backup survives a branch switch. Applying the project-relative rule here
 * would reject every legitimate value.
 *
 * What is still enforced: non-blank, bounded, and free of control characters,
 * because this string is handed to a filesystem call during restoration and is
 * shown to the developer in the conflict message of AAP §0.5.5 ("Original saved
 * at ‹backup path›").
 */
const backupPathSchema = z
  .string()
  .min(1)
  .max(MAX_BACKUP_PATH_LENGTH)
  .refine((value) => value.trim().length > 0 && !hasControlCharacter(value), {
    error: 'A backup path must be a non-blank string with no control characters.',
  });

/**
 * The validator for a timestamp in this module: epoch milliseconds.
 *
 * `z.number()` already refuses `NaN` and both infinities, and `.positive()`
 * refuses `0` and negatives, so what remains is exactly "a finite positive
 * epoch-millisecond reading". Not constrained to an integer: `nowEpochMs()` is
 * `Date.now()` and returns whole milliseconds today, but a sub-millisecond
 * reading is a more precise answer to the same question, and rejecting it would
 * be rejecting better data.
 *
 * Epoch milliseconds are the product's canonical time base (`time.ts` in
 * `@debuggen/shared`), which is what lets a record's timestamp be compared with
 * a telemetry event's `startTime` without a conversion nobody remembers to
 * apply.
 */
const epochMillisecondsSchema = z.number().positive();

/**
 * Maps Zod issues to `{ path, message }` pairs, dropping the rejected values.
 *
 * The privacy rule of AAP §0.5.2 applies to failures as much as to telemetry:
 * this object is logged, persisted with a session and rendered in a user
 * interface, and the redaction layer never sees an error raised this deep in a
 * call stack. A record's `diff` is a slice of the developer's source and its
 * `backupPath` contains their home directory, so what goes into `details` is
 * the *shape* of the failure — which field, and what the schema expected —
 * never the data that caused it. Field paths and the schema's own messages are
 * enough to fix a producer.
 *
 * @param error The Zod error from a failed `safeParse`.
 * @returns One entry per issue, `path` being the dotted path of the offending
 * field (the empty string for an issue on the object itself).
 */
function collectIssues(error: z.ZodError): ReadonlyArray<{ path: string; message: string }> {
  // `issue.path` segments may be numbers (array indices) as well as strings, so
  // each is stringified before joining.
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
}

/**
 * The validator every modification journal entry passes through, and the
 * definition of {@link ModificationRecord}.
 *
 * Eleven fields — ten required and one optional — in the exact order AAP §0.2.3
 * lists the columns of the store's `modifications` table, and **nothing else**.
 * The key set is part of the contract rather than an accident of authorship:
 * the patcher writes these rows, `apps/local-service/src/store` persists them
 * column for column, and `@debuggen/protocol` ships them in
 * `instrumentation.ready`, so a field added here without those three learning
 * about it is a silent data loss. `modification.test.ts` asserts the key set
 * mechanically for that reason.
 *
 * `z.strictObject` rather than `z.object`: unknown keys are **rejected**, not
 * stripped. This shape is not a lenient process boundary like a telemetry event
 * from a page agent — it is a journal the product's central promise depends on,
 * and a producer sending a field this version does not understand is a version
 * mismatch that must surface loudly rather than lose data quietly.
 *
 * No `.transform()`, no `.default()` and no coercion appears below, so a parsed
 * record deep-equals its input. Normalisation is
 * {@link createModificationRecord}'s job, which keeps "what is valid" and "how
 * a value is built" in separate, separately testable places — and means a row
 * read back from SQLite cannot be quietly rewritten on the way out.
 *
 * @example
 * ```ts
 * const parsed = parseModificationRecord(row.record);
 * if (parsed.ok && parsed.value.status === 'applied') {
 *   // The file on disk should hash to parsed.value.instrumentedHash.
 * }
 * ```
 */
export const modificationRecordSchema = z
  .strictObject({
    /**
     * This record's identity: `mod_` plus 16 lowercase alphanumeric characters,
     * from `newModificationId()`.
     *
     * Minted by {@link createModificationRecord} **before** the patcher writes
     * anything, because every later step refers to the record by id: the
     * journal append, the `updateStatus` that marks it `applied`, the
     * `previousRecordId` of a follow-up record, and the `recordId` of a
     * {@link ModificationConflict}.
     */
    id: modificationIdSchema,

    /**
     * The debugging session this modification belongs to.
     *
     * Scopes the backup directory (`$DEBUGGEN_HOME/backups/<sessionId>/…`) and
     * is the key `ModificationJournal.listBySession` groups by. Note that
     * cleanup does **not** filter by session status: AAP §0.5.1 requires
     * reconciliation of every open record whatever state its session is in, so
     * this field identifies a record's owner without gating its restoration.
     */
    sessionId: sessionIdSchema,

    /**
     * Which plan version installed this modification, counting from 1.
     *
     * A follow-up question that needs more evidence produces plan version
     * *n + 1* = the previous plan plus additive actions (AAP §0.4.2), and this
     * field is what lets the installer apply only the delta and the UI show
     * which round of instrumentation a file belongs to. Together with
     * `previousRecordId` it is how a chain over one file is read back in order.
     */
    planVersion: z.int().min(1),

    /**
     * The file that was modified: project-relative POSIX, inside the project.
     *
     * `'src/lib/thing.ts'`, never `'/home/dev/project/src/lib/thing.ts'`. The
     * patcher resolves it against the session's `projectRoot` with
     * `resolveWithinProject`; storing it relative is what keeps the developer's
     * directory layout out of panels, prompts and screenshots, and what lets
     * the record stay meaningful if the project is moved.
     */
    file: projectRelativeFileSchema,

    /**
     * SHA-256 of the file's bytes **before this record's write**.
     *
     * Raw-byte hashing, no newline or encoding normalisation: CRLF and LF
     * content hash differently, and that fidelity is the whole basis of the
     * restore-versus-conflict decision. A whitespace-insensitive comparison
     * here would silently overwrite a developer's edit.
     *
     * Three things key off it. It is the **backup's filename**, which makes the
     * backup write idempotent and lets two records that saw identical content
     * share one backup file. It is what a restore verifies the restored content
     * against before the backup may be deleted. And for a chained record
     * (AAP §0.4.2) it equals the **previous record's `instrumentedHash`**,
     * because the bytes this record replaced were the earlier patch's output —
     * see `previousRecordId`.
     */
    originalHash: sha256HexSchema,

    /**
     * Where the bytes this record replaced were copied, before anything was
     * written.
     *
     * `$DEBUGGEN_HOME/backups/<sessionId>/<originalHash>`, absolute and
     * **outside every checkout** (AAP §0.2.3) so a session never shows up in
     * the developer's `git status`. Created `0600` under a `0700` directory and
     * `fsync`ed by `../patch/backup-store.ts`.
     *
     * For the first record of a file this is the pristine file. For a chained
     * record (`previousRecordId`) it is the previous plan version's
     * instrumented output — still wrapped by this tool — and the pristine file
     * is the chain root's backup instead (see {@link findChainRoot}).
     *
     * The backup is deleted only after a restore has been verified against
     * `originalHash`. A `failed` or `conflict` record keeps its backup — the
     * copy reconciliation needs on the next start, and, for an unchained
     * record, the copy the developer is told about in the AAP §0.5.5 message.
     */
    backupPath: backupPathSchema,

    /**
     * SHA-256 of the content this record writes.
     *
     * Computed from the patched bytes in memory and journaled **before** the
     * rename, which is the single ordering decision that makes every crash
     * point recoverable: with both hashes already recorded, reconciliation can
     * distinguish "nothing was written" (`originalHash`) from "our patch landed
     * but was never marked" (`instrumentedHash`) from "the developer changed
     * it" (neither). That is why this is a required field on a `pending`
     * record rather than something filled in after the write.
     *
     * It is also the authorisation to write: `../patch/conflict.ts` returns a
     * restorable verdict **only** when the file currently hashes to this value.
     */
    instrumentedHash: sha256HexSchema,

    /**
     * When the record was journaled and applied, in epoch milliseconds.
     *
     * The store's `applied_at` column. Set from `nowEpochMs()` when the record
     * is created — that is, at the `pending` append, before the write — and
     * refreshed through {@link ModificationStatusPatch} when the status moves
     * to `applied`, so the value always describes the transition the record's
     * current status names. Same time base as a telemetry event's `startTime`,
     * so the two are directly comparable.
     */
    appliedAt: epochMillisecondsSchema,

    /** The record's state. See {@link MODIFICATION_STATUSES} for the lifecycle. */
    status: modificationStatusSchema,

    /**
     * The unified diff from the original to the instrumented content.
     *
     * Produced by the patcher with the `diff` package over the exact bytes that
     * were hashed (no whitespace-insensitive options), and kept as a **plain
     * string** because it crosses a WebSocket, lands in a SQLite text column
     * and is rendered verbatim by the VS Code `ModificationsList`/`DiffView`
     * and the DevTools `SessionSummary`. This is the field that makes AAP
     * §0.5.1's "every modification tracked and visible" true for the
     * developer: it is how they see what the tool did to their file without
     * reading the file.
     *
     * Bounded by {@link MAX_MODIFICATION_DIFF_LENGTH}. An empty string is
     * accepted by the schema — a no-op patch is not this schema's error to
     * report — but the patcher refuses to journal a transform that changed
     * nothing.
     */
    diff: z.string().max(MAX_MODIFICATION_DIFF_LENGTH),

    /**
     * The record this one is layered on top of, when it is.
     *
     * Present only for a follow-up chain (AAP §0.4.2): plan version *n + 1*
     * patches a file plan version *n* had already patched, so this record's
     * `originalHash` is the linked record's `instrumentedHash` and its backup
     * holds the *already-instrumented* bytes — which is correct, and is exactly
     * what lets cleanup unwind the chain in **strict reverse order**, verifying
     * at each step that the file hashes to that record's `instrumentedHash`
     * before writing that record's backup.
     *
     * Absent — rather than present and `null` — on the first record for a file,
     * because the whole record is stored and transported as JSON and an absent
     * key is the one representation every layer agrees on.
     */
    previousRecordId: modificationIdSchema.optional(),
  })
  .refine((record) => record.previousRecordId !== record.id, {
    error:
      'previousRecordId must name a different record: a record cannot be layered on top of itself.',
    path: ['previousRecordId'],
  });

/**
 * One recorded, reversible modification to a file in the developer's project.
 *
 * Inferred from {@link modificationRecordSchema} rather than declared beside
 * it, so the validator and the type are the same statement: a field added to
 * the schema appears here in the same edit, and no consumer can be compiling
 * against a shape the validator does not accept.
 *
 * The self-reference refinement above is the schema's **only** structural
 * opinion about chains, and it is deliberately narrow: a record pointing at
 * itself is unambiguously wrong and cheap to catch here, while a longer cycle
 * (A → B → A) spans records the schema never sees together. Detecting that
 * belongs to `../cleanup.ts`, which holds the whole chain while it walks it in
 * reverse order and is the only place that can answer the question.
 */
export type ModificationRecord = z.infer<typeof modificationRecordSchema>;

/**
 * Validates an unknown value as a {@link ModificationRecord}, without throwing.
 *
 * This is how a record that arrived from somewhere else becomes a typed value:
 * a row read back from the session store, an `instrumentation.ready` payload
 * received in the DevTools panel or the VS Code webview, a record handed to an
 * in-memory journal by a test.
 *
 * On failure the error is a `DebuggenError` with code
 * `'PROTOCOL_INVALID_MESSAGE'` and a `details.issues` array of
 * `{ path, message }` pairs, one per validation issue. **The rejected values
 * are not in `details`** — see {@link collectIssues} for why. Callers at a
 * stage boundary should re-code it to describe their operation (`'STORE_ERROR'`
 * for a row read back, for instance), because `'PROTOCOL_INVALID_MESSAGE'`
 * describes a transport and is only the right answer when a transport delivered
 * the value.
 *
 * @param value Any value believed to be a modification record.
 * @returns `ok(record)` with the parsed record, or `err(error)` describing
 * every issue found.
 */
export function parseModificationRecord(value: unknown): Result<ModificationRecord> {
  const parsed = modificationRecordSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      'A value did not match the modification record schema.',
      {
        hint: 'A modification record needs a mod_ id, a session id, a positive plan version, a project-relative POSIX file, both SHA-256 hashes, a backup path, an epoch-millisecond timestamp, a known status and a diff string.',
        details: { issues: collectIssues(parsed.error) },
      },
    ),
  );
}

/**
 * Everything {@link createModificationRecord} needs that it cannot derive.
 *
 * Deliberately not `Partial<ModificationRecord>`: `id` and `appliedAt` are
 * *produced* by the constructor, and offering a caller the chance to supply
 * them here would invite two records with the same id. Tests that need
 * determinism inject the generators instead, through
 * {@link CreateModificationRecordOptions}.
 *
 * Every member is `readonly`, and the constructor never mutates the object it
 * is given.
 */
export interface CreateModificationRecordInput {
  /** The session the modification belongs to. */
  readonly sessionId: string;

  /** The plan version installing it, counting from 1. */
  readonly planVersion: number;

  /**
   * The file being modified.
   *
   * Accepted in host form and normalised: backslashes become forward slashes
   * and a `'./'` prefix or redundant segment is collapsed before validation, so
   * a caller holding a path from a Windows-flavoured API or from a ts-morph
   * relative path does not have to pre-clean it. It must still *be* inside the
   * project — normalisation cannot rescue an absolute path or a `'..'` escape,
   * and neither is accepted.
   */
  readonly file: string;

  /** SHA-256 of the bytes this write replaces. See the record's field docs. */
  readonly originalHash: string;

  /** Where those original bytes were copied, and `fsync`ed, first. */
  readonly backupPath: string;

  /** SHA-256 of the content about to be written. Known before the write. */
  readonly instrumentedHash: string;

  /** The unified diff from the original to the instrumented content. */
  readonly diff: string;

  /**
   * The state to record, defaulting to {@link DEFAULT_MODIFICATION_STATUS}.
   *
   * The default is the point: AAP §0.5.1 requires the journal entry to exist as
   * `pending` before any byte is written, so the ordinary caller — the patcher,
   * mid-sequence — passes no status at all. An explicit status is for the paths
   * that already know better: recording a `failed` attempt, or rebuilding a
   * record in a fixture.
   */
  readonly status?: ModificationStatus;

  /** The earlier record in a follow-up chain, when this is one (AAP §0.4.2). */
  readonly previousRecordId?: string;
}

/**
 * The injectable generators {@link createModificationRecord} uses.
 *
 * Both default to the shared implementations (`newModificationId()` and
 * `nowEpochMs()`); both are injectable so a suite can assert an exact record
 * without fake timers or module mocking, and so the patcher can thread one
 * clock through a whole sequence of records.
 */
export interface CreateModificationRecordOptions {
  /** Mints the record id. Defaults to `newModificationId()`. */
  readonly newId?: () => string;

  /** Reads the current epoch-millisecond time. Defaults to `nowEpochMs()`. */
  readonly now?: () => number;
}

/**
 * Builds a validated {@link ModificationRecord}.
 *
 * The one constructor for this shape, so that id minting, `file`
 * normalisation and the `pending` default live in a single place rather than
 * being repeated by the patcher, the installer's rollback path and every
 * fixture. `../patch/patcher.ts` calls it at step 4 of the sequence documented
 * on this module — after the backup has been written and `fsync`ed, and before
 * anything in the project has changed.
 *
 * Pure and total: it reads the clock and the id generator through
 * {@link CreateModificationRecordOptions}, mutates nothing (including the input
 * object, which may be frozen), and **never throws** — an invalid hash, an
 * unsafe path or a non-positive plan version comes back as `err`, and even an
 * unexpected failure inside an injected generator is caught and re-coded rather
 * than escaping into the middle of a write sequence.
 *
 * A validation failure is reported as `'INSTRUMENTATION_INSTALL_FAILED'`
 * rather than as a protocol error, because that is the operation it blocks: the
 * caller is about to patch a file and now must not. The `details.issues` array
 * carries field paths and schema messages only.
 *
 * @param input The values the caller holds. See
 * {@link CreateModificationRecordInput}.
 * @param options Injectable id and clock generators.
 * @returns `ok(record)` with a record that satisfies
 * {@link modificationRecordSchema}, or `err(error)` naming the offending
 * fields.
 *
 * @example
 * ```ts
 * const created = createModificationRecord({
 *   sessionId,
 *   planVersion,
 *   file: './src/lib/thing.ts', // normalised to 'src/lib/thing.ts'
 *   originalHash,
 *   backupPath,
 *   instrumentedHash,
 *   diff,
 * });
 * if (!created.ok) {
 *   return created; // nothing has been written; abort the patch
 * }
 * await journal.append(created.value);
 * ```
 */
export function createModificationRecord(
  input: CreateModificationRecordInput,
  options: CreateModificationRecordOptions = {},
): Result<ModificationRecord> {
  try {
    const mintId = options.newId ?? newModificationId;
    const readClock = options.now ?? nowEpochMs;

    // The caller may hold a host path (backslashes) or a './'-prefixed relative
    // path; both are the same file and both are normalised to the one POSIX
    // spelling the schema accepts. The guard keeps a caller from JavaScript —
    // a fixture, a stored row — from reaching a string method on a non-string:
    // the schema reports that as a type issue instead.
    const file = typeof input.file === 'string' ? normalizePosix(toPosix(input.file)) : input.file;

    const candidate = {
      id: mintId(),
      sessionId: input.sessionId,
      planVersion: input.planVersion,
      file,
      originalHash: input.originalHash,
      backupPath: input.backupPath,
      instrumentedHash: input.instrumentedHash,
      appliedAt: readClock(),
      status: input.status ?? DEFAULT_MODIFICATION_STATUS,
      diff: input.diff,
      // `exactOptionalPropertyTypes` is on, so the key is spread in only when a
      // previous record was named: assigning `undefined` would create a present
      // key whose value cannot be serialised as an absent one.
      ...(input.previousRecordId !== undefined ? { previousRecordId: input.previousRecordId } : {}),
    };

    const parsed = modificationRecordSchema.safeParse(candidate);

    if (parsed.success) {
      return ok(parsed.data);
    }

    return err(
      new DebuggenError(
        'INSTRUMENTATION_INSTALL_FAILED',
        'A modification record could not be journaled because the values offered do not satisfy the modification record schema.',
        {
          hint: 'Check the two SHA-256 hashes, the project-relative file path and the plan version. Nothing has been written to the project, so the patch can be abandoned safely.',
          details: { issues: collectIssues(parsed.error) },
        },
      ),
    );
  } catch (cause) {
    // Reached only if an injected generator throws. This function sits inside
    // the write sequence, so it absorbs the failure into a Result rather than
    // letting an exception unwind past a backup that has already been written.
    return err(
      new DebuggenError('INTERNAL', 'A modification record could not be constructed.', {
        hint: 'An injected id or clock generator threw. The patch has not been applied.',
        cause,
      }),
    );
  }
}

/**
 * Why a modification could not be reverted, one member per branch of the AAP
 * §0.5.1 reconciliation table that ends in a conflict.
 *
 * ```text
 * the file's hash matches neither hash on the record → 'content-changed'
 *   (the developer edited a file while it was instrumented — the headline case)
 * the target file is gone                            → 'file-missing'
 *   (deleted, renamed or moved after the patch was applied)
 * the backup is gone, or cannot be read back          → 'backup-missing'
 *   (restoration is impossible, so the record is surfaced rather than closed)
 * the backup's bytes fail their own digest check      → 'backup-corrupt'
 *   (it no longer hashes to the digest it was filed under, so it cannot be
 *   trusted as the original: nothing is written and it is kept for inspection)
 * the restored content did not hash to originalHash   → 'restore-verification-failed'
 *   (the write completed but produced the wrong bytes; the backup is kept)
 * the file's open records do not form one chain      → 'record-chain-fork'
 *   (two live records layered on one parent, or two open chains over one file,
 *   so no reverse order exists and cleanup refuses the file before reading it)
 * ```
 *
 * Every one of them means the same thing operationally: **no write is
 * authorised**, the backup is retained, and the record stays open so the next
 * start reports it again. Only a file that hashes to `instrumentedHash`
 * authorises a restore, which is the asymmetry that makes the promise safe.
 *
 * Frozen for the same reason {@link MODIFICATION_STATUSES} is: a module-level
 * table read on every validation.
 */
export const MODIFICATION_CONFLICT_REASONS = Object.freeze([
  'content-changed',
  'file-missing',
  'backup-missing',
  'backup-corrupt',
  'restore-verification-failed',
  'record-chain-fork',
] as const);

/**
 * Why a modification could not be reverted. See
 * {@link MODIFICATION_CONFLICT_REASONS}.
 */
export type ModificationConflictReason = (typeof MODIFICATION_CONFLICT_REASONS)[number];

/**
 * The validator for a single {@link ModificationConflictReason}.
 *
 * Built from the tuple, so the enumeration cannot drift from the reconciliation
 * table it mirrors.
 */
export const modificationConflictReasonSchema = z.enum(MODIFICATION_CONFLICT_REASONS);

/**
 * The validator for a conflict report, and the definition of
 * {@link ModificationConflict}.
 *
 * This is the three-way diff report of AAP §0.5.1 — the object that carries
 * "‹file› was edited while instrumented. Debug Generator will not overwrite it.
 * Original saved at ‹backup path›." and its "Open diff" action (AAP §0.5.5)
 * across a process boundary. It is embedded by `cleanup.completed
 * { sessionId, status, conflicts }` (AAP §0.4.2) and rendered by the VS Code
 * `DiffView` and the DevTools `SessionSummary`, so every field is a JSON
 * primitive and no `Error` instance appears anywhere in it. The ‹backup path›
 * of that sentence is `originalBackupPath` when the report carries one (a
 * chained record: the chain root's backup, the pristine file) and
 * `backupPath` otherwise.
 *
 * Produced by `../patch/conflict.ts`, which is a *verdict* module: a conflict
 * is data, not a failure. It is returned as a successful result and reported to
 * the developer — never thrown, and never converted into an `Err` that a caller
 * might log and forget.
 *
 * The wording of `message` is authored by the service and the adapters, which
 * know the developer's context and the recovery action to offer; this schema
 * requires only that something non-empty is there, so the transport cannot
 * deliver a conflict with nothing to show.
 */
export const modificationConflictSchema = z.strictObject({
  /** The {@link ModificationRecord.id} this conflict is about. */
  recordId: modificationIdSchema,

  /** The session that owns the record. See {@link ModificationRecord.sessionId}. */
  sessionId: sessionIdSchema,

  /**
   * The conflicting file: project-relative POSIX, the same spelling the record
   * carries.
   *
   * Project-relative so the message and the "Open diff" action can be rendered
   * in either user interface without leaking the developer's directory layout,
   * and so the editor can resolve it against the workspace folder.
   */
  file: projectRelativeFileSchema,

  /** Which branch of the reconciliation table produced this conflict. */
  reason: modificationConflictReasonSchema,

  /**
   * The hash the tool expected to find: the record's `instrumentedHash`.
   *
   * Stated explicitly in the report rather than left to be looked up, because
   * the report travels to two user interfaces that do not hold the journal, and
   * because a developer reading it deserves to see both sides of the comparison
   * that refused the write.
   */
  expectedHash: sha256HexSchema,

  /**
   * The hash the file actually has, when it has one.
   *
   * Absent for `'file-missing'` — there are no bytes to hash — which is why the
   * field is optional rather than an empty string: a blank digest would be a
   * value that looks like an answer.
   */
  actualHash: sha256HexSchema.optional(),

  /**
   * Where this record's own backup is: the {@link ModificationRecord.backupPath}
   * of the record the conflict is about.
   *
   * The conflict path **retains** the backup (AAP §0.5.1). For an unchained
   * record it holds the pristine file, and this is the path the AAP §0.5.5
   * message quotes so the developer can recover it by hand if they choose to.
   * For a chained record (`previousRecordId`) it holds the previous plan
   * version's instrumented output — the bytes this record replaced, still
   * wrapped by this tool — and the pristine file is at
   * {@link ModificationConflict.originalBackupPath} instead. Present even for
   * `'backup-missing'`, where it records the path that was expected and is the
   * only useful thing left to say, and for `'backup-corrupt'`, where it names
   * the untrusted file that was kept for inspection.
   */
  backupPath: backupPathSchema,

  /**
   * Where the pristine original of the file is: the backup of the record's
   * **chain root**, the first record of its follow-up chain.
   *
   * Present only for a chained record (`previousRecordId`) whose root the
   * producer resolved (`findChainRoot`), and absent — never blank — otherwise,
   * because {@link ModificationConflict.backupPath} is then already the
   * pristine file. "Original saved at ‹path›" (AAP §0.5.5) names this path
   * when it is present and `backupPath` when it is not; a surface that quoted
   * `backupPath` for a chained record would point the developer at bytes that
   * still carry the instrumentation. Like `backupPath`, it is reported even
   * when the backup it names could not be read back, and the report's
   * `message` says so.
   */
  originalBackupPath: backupPathSchema.optional(),

  /** When the conflict was detected, in epoch milliseconds. */
  detectedAt: epochMillisecondsSchema,

  /**
   * The developer-facing explanation.
   *
   * Authored by the service or the adapter that detected the conflict, not by
   * this schema and not by a model: it is shown verbatim in the VS Code
   * `ModificationsList` and the DevTools `SessionSummary`, alongside an "Open
   * diff" action built from `diffs` (AAP §0.5.5). Required and non-empty, so a
   * conflict can never reach a user interface as a blank row.
   */
  message: z.string().min(1).max(MAX_CONFLICT_MESSAGE_LENGTH),

  /**
   * The three-way view, composed from two-way patches.
   *
   * The `diff` package exposes no three-way merge, and this product's
   * dependencies are frozen, so `../patch/conflict.ts` composes the view from
   * the three texts it can obtain — the backup, the patch it applied, and the
   * file as it stands now — and labels each patch:
   *
   * - `originalToInstrumented` — what the tool did;
   * - `instrumentedToCurrent` — what the developer changed on top of it, the
   *   most useful hunk set for the "Open diff" action;
   * - `originalToCurrent` — the net divergence from the pristine file.
   *
   * "Original" is the pristine file in both views that name it: for a chained
   * record, the chain root's backup ({@link ModificationConflict.originalBackupPath}),
   * never the intermediate, still-instrumented bytes the record itself backed
   * up — so `originalToInstrumented` spans every plan version up to and
   * including this record's.
   *
   * The object and every member are optional, because a conflict may leave
   * nothing to diff: `'file-missing'` has no current text, and
   * `'backup-missing'` and `'backup-corrupt'` have no trusted original text.
   * Each member is bounded by
   * {@link MAX_CONFLICT_DIFF_LENGTH}, and because this shape carries no
   * truncation flag, a patch that exceeds the bound is omitted rather than
   * shortened: an absent member reads as "nothing to show here", while a
   * clipped one would claim to be the whole change. Where the omission is worth
   * explaining, it belongs in `message`, which the producer authors.
   */
  diffs: z
    .strictObject({
      /** Original → instrumented: the change the tool made. */
      originalToInstrumented: z.string().max(MAX_CONFLICT_DIFF_LENGTH).optional(),

      /** Instrumented → current: the change the developer made on top of it. */
      instrumentedToCurrent: z.string().max(MAX_CONFLICT_DIFF_LENGTH).optional(),

      /** Original → current: the net divergence from the pristine file. */
      originalToCurrent: z.string().max(MAX_CONFLICT_DIFF_LENGTH).optional(),
    })
    .optional(),
});

/**
 * A modification that could not be reverted, and why.
 *
 * Inferred from {@link modificationConflictSchema}, so the validator and the
 * type stay one statement. Carried in `cleanup.completed` and in the session
 * record's `cleanup.conflicts`, which is what makes a conflicting file
 * something the developer is told about on every reconnect and every service
 * start until they resolve it — rather than a silent omission from a cleanup
 * that reported success.
 */
export type ModificationConflict = z.infer<typeof modificationConflictSchema>;

/**
 * Finds the chain root of a record: the root-most ancestor reachable through
 * `previousRecordId` among the records given.
 *
 * A follow-up chain (AAP §0.4.2) links each later plan version's record to the
 * record it was layered on, and only the first record of the chain backed up
 * the pristine file; every later link's backup holds the previous version's
 * instrumented output. The root is therefore where "Original saved at ‹path›"
 * (AAP §0.5.5) has to point for a chained record, and where the "original"
 * side of its conflict diff comes from — see
 * {@link ModificationConflict.originalBackupPath}.
 *
 * Pure, synchronous and browser-safe: it reads only the records it is handed,
 * so the service, the watcher, cleanup and a user interface holding a
 * session's modification list all resolve the same root the same way.
 *
 * - Only records of the **same session** and the **same file** (compared in
 *   normalised POSIX form, so `./src/a.ts` and `src/a.ts` are one file) are
 *   followed: a chain never crosses either boundary, and a link that seemed to
 *   would be naming a record that does not describe this file's bytes.
 * - A **missing parent** ends the walk: the deepest ancestor that is present is
 *   the root. The caller chooses which records count — cleanup passes the live
 *   ones, so an ancestor already reverted is not a root whose backup can still
 *   be named.
 * - A **cycle** (`A → B → A`, which spans records the schema never sees
 *   together) ends the walk at the last record before it would repeat, and the
 *   walk is bounded by the number of candidate records, so a malformed journal
 *   can neither hang it nor make it answer with the record itself.
 * - When two candidates share an id, the first one given is used.
 *
 * @param record The record whose root is wanted.
 * @param records The records to look the ancestors up in — typically the other
 * records of the same session. May include `record` itself.
 * @returns The root-most ancestor, or `undefined` when `record` has no
 * `previousRecordId` or its parent is not among `records`.
 *
 * @example
 * ```ts
 * const root = findChainRoot(record, sessionRecords);
 * const originalPath = root?.backupPath ?? record.backupPath;
 * ```
 */
export function findChainRoot(
  record: ModificationRecord,
  records: Iterable<ModificationRecord>,
): ModificationRecord | undefined {
  if (record.previousRecordId === undefined) {
    return undefined;
  }

  const file = normalizePosix(toPosix(record.file));
  const candidates = new Map<string, ModificationRecord>();

  for (const candidate of records) {
    if (
      candidate.sessionId === record.sessionId &&
      normalizePosix(toPosix(candidate.file)) === file &&
      !candidates.has(candidate.id)
    ) {
      candidates.set(candidate.id, candidate);
    }
  }

  const visited = new Set<string>([record.id]);
  let root: ModificationRecord | undefined;
  let parentId: string | undefined = record.previousRecordId;

  // Each iteration either moves to a record not yet visited or stops, so the
  // walk takes at most one step per candidate.
  while (parentId !== undefined && !visited.has(parentId)) {
    const parent = candidates.get(parentId);

    if (parent === undefined) {
      break;
    }

    visited.add(parent.id);
    root = parent;
    parentId = parent.previousRecordId;
  }

  return root;
}

/**
 * Validates an unknown value as a {@link ModificationConflict}, without
 * throwing.
 *
 * The counterpart of {@link parseModificationRecord}, for the same reasons and
 * with the same privacy policy: a conflict arrives in a `cleanup.completed`
 * frame or is read back from a session record, and both user interfaces parse
 * it before rendering it.
 *
 * @param value Any value believed to be a conflict report.
 * @returns `ok(conflict)` with the parsed report, or `err(error)` describing
 * every issue found, with field paths and schema messages only.
 */
export function parseModificationConflict(value: unknown): Result<ModificationConflict> {
  const parsed = modificationConflictSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      'A value did not match the modification conflict schema.',
      {
        hint: "A conflict needs the record id, the session id, the project-relative file, a known reason, the expected hash, the record's own backup path, an epoch-millisecond detection time and a non-empty message; a chained record may add its chain root's backup path as originalBackupPath.",
        details: { issues: collectIssues(parsed.error) },
      },
    ),
  );
}

/**
 * The fields {@link ModificationJournal.updateStatus} may change alongside a
 * status transition.
 *
 * Narrow on purpose. `id`, `sessionId`, `planVersion`, `file` and
 * `originalHash` identify what a record *is* and are never patched: changing
 * any of them would re-point the record at different bytes and break the
 * reconciliation that the journal exists to make possible. What may change is
 * what a later step of the sequence learns:
 *
 * - `appliedAt` — refreshed when the status moves, so the timestamp describes
 *   the transition the status names;
 * - `instrumentedHash` — only where the written content was legitimately
 *   revised before the write (a re-rendered patch); never after a rename, since
 *   the recorded value is what reconciliation compares against;
 * - `diff` — the same case, and the truncation the patcher may apply;
 * - `backupPath` — where a backup was relocated, which keeps every path a
 *   conflict report quotes accurate: its own `backupPath`, and — when the
 *   relocated record is a chain root — the `originalBackupPath` of every
 *   chained record's report, which "Original saved at ‹path›" names.
 *
 * Every member is optional and `readonly`: a patch says only what changed.
 */
export interface ModificationStatusPatch {
  /** A revised instrumented-content hash, before the write has happened. */
  readonly instrumentedHash?: string;

  /** A revised or truncated unified diff. */
  readonly diff?: string;

  /** The epoch-millisecond time of the transition being recorded. */
  readonly appliedAt?: number;

  /** A relocated backup path. */
  readonly backupPath?: string;
}

/**
 * The persistence port for the modification journal.
 *
 * A **TypeScript interface only** — no schema, no implementation — because
 * `@debuggen/instrumentation` never opens a database. It writes the journal
 * through this port, and two independent implementations satisfy it:
 *
 * - `apps/local-service/src/store/modifications-repo.ts`, over synchronous
 *   `node:sqlite`. Its methods do their work synchronously and return
 *   already-resolved promises; the port is asynchronous so that an
 *   implementation which is not — a future out-of-process store — does not
 *   force every caller to change.
 * - the in-memory journals in `../installer.test.ts`, `../cleanup.test.ts` and
 *   `../patch/patcher.test.ts`, which is what lets those suites exercise the
 *   real patcher with no filesystem-backed store.
 *
 * ## Required semantics
 *
 * Both implementations must agree on all of the following, because the patcher
 * and cleanup depend on each point:
 *
 * - **`append` preserves insertion order.** Records are appended in the order
 *   the installer applied them, and that order is the order cleanup must
 *   reverse.
 * - **`listBySession` returns that session's records in append order**, so a
 *   chain over one file (AAP §0.4.2) can be walked backwards by iterating the
 *   result in reverse. It returns no other session's records.
 * - **`listOpen` returns every record in {@link OPEN_MODIFICATION_STATUSES}
 *   across all sessions** — that is the whole point of it. AAP §0.5.1 requires
 *   service-start reconciliation to act on an open record *regardless of the
 *   owning session's status*, so a filter by session here would leave a patched
 *   file on disk whenever a session ended in `failed` or was abandoned
 *   mid-capture. `'reverted'` records are excluded; `'conflict'` records are
 *   not.
 * - **`updateStatus` applies the {@link ModificationStatusPatch} and returns
 *   the updated record**, so the caller never has to re-read to learn what it
 *   now holds.
 * - **Expected failures come back as `err`, never as an exception.** An unknown
 *   id, a closed store, a constraint violation: each is an
 *   `err(DebuggenError)` — `'STORE_ERROR'` for a persistence failure — because
 *   these calls sit inside the crash-safe sequence, where an exception thrown
 *   between the backup and the rename is the one thing that must not happen.
 * - **Nothing is mutated in place.** A returned record is safe to keep; an
 *   implementation that hands out a reference it later edits would let a caller
 *   observe a status that was never journaled.
 */
export interface ModificationJournal {
  /**
   * Appends a record, preserving insertion order.
   *
   * Called at step 4 of the sequence on this module — after the backup is
   * durable, before the project is touched — so the returned promise settling
   * is what authorises the write to proceed.
   *
   * @param record A validated record, normally from
   * {@link createModificationRecord}.
   * @returns The stored record, or `err` if it could not be persisted.
   */
  append(record: ModificationRecord): Promise<Result<ModificationRecord>>;

  /**
   * Moves a record to a new status, optionally patching the fields a
   * transition legitimately revises.
   *
   * The `pending` → `applied` transition is called **only after** the rename
   * has returned: marking a record applied before the write has landed is the
   * one lie reconciliation cannot detect.
   *
   * @param id The {@link ModificationRecord.id} to update.
   * @param status The new status.
   * @param patch Optional fields to revise alongside it.
   * @returns The updated record, or `err` for an unknown id or a persistence
   * failure.
   */
  updateStatus(
    id: string,
    status: ModificationStatus,
    patch?: ModificationStatusPatch,
  ): Promise<Result<ModificationRecord>>;

  /**
   * Lists one session's records in append order.
   *
   * Cleanup iterates the result in reverse to unwind chains strictly
   * last-applied-first (AAP §0.4.2), and both user interfaces render it as the
   * session's modification list.
   *
   * @param sessionId The session to list.
   * @returns That session's records — an empty array is a success, not a
   * failure — or `err` on a persistence failure.
   */
  listBySession(sessionId: string): Promise<Result<ModificationRecord[]>>;

  /**
   * Lists every record still requiring reconciliation, across **all** sessions.
   *
   * The filter is {@link OPEN_MODIFICATION_STATUSES}: everything except
   * `'reverted'`. This is what the service calls on start-up, before it accepts
   * a single client, so that a file left patched by a crashed or abandoned
   * session is restored or reported before anyone can look at it.
   *
   * @returns Every open record, or `err` on a persistence failure.
   */
  listOpen(): Promise<Result<ModificationRecord[]>>;
}
