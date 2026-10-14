/**
 * The conflict detector: the module that decides whether a file this product
 * instrumented may be restored, and that reports the divergence when it may
 * not.
 *
 * This is where "Debug Generator will not overwrite it" becomes true. One
 * behaviour is non-negotiable: **a file whose bytes do not match what the tool
 * wrote is never modified.** Nothing in this module writes, deletes, renames or
 * truncates anything — it reads bytes, hashes them, compares the digest with
 * the two digests a {@link ModificationRecord} already carries, and returns a
 * verdict. The write authorised by one of those verdicts is performed by
 * `../cleanup.ts`, which is the caller's decision to act on and not this
 * module's.
 *
 * ## The asymmetry, which is the whole point
 *
 * ```text
 * file hashes to record.instrumentedHash  → 'restorable'         → a write is authorised
 * file hashes to record.originalHash      → 'already-reverted'   → nothing to do
 * file hashes to neither                  → 'content-changed'    → nothing is authorised
 * file is not there                       → 'file-missing'       → nothing is authorised
 * backup missing or unverifiable          → 'backup-unavailable' → nothing is authorised
 * ```
 *
 * A match authorises a restore; a mismatch authorises **nothing**. That is why
 * {@link detectConflict} returns a discriminated union rather than a boolean:
 * collapsing it loses the three cases that are neither a restore nor a
 * developer's edit, each of which must still not produce a write, and a caller
 * that forgets one of them stops compiling instead of silently overwriting
 * someone's file.
 *
 * ## The comparison is always against one record
 *
 * Both expected digests come from the record that was journaled **before** the
 * patcher wrote anything (AAP §0.5.1). Nothing here re-derives what a patch
 * "would" produce: the journal already knows the expected post-write hash, and
 * judging each record on its own terms is precisely what makes start-up
 * reconciliation decidable and what makes follow-up chains work.
 *
 * For a chained record (AAP §0.4.2) — plan version *n + 1* patching a file that
 * version *n* had already patched, linked through
 * `ModificationRecord.previousRecordId` — the rule is unchanged: the file is
 * compared with **that** record's `instrumentedHash`. Consequently, with a
 * two-version chain applied, the newest record is restorable while the earlier
 * one is not, which is exactly the state that makes a strict reverse-order
 * unwind correct. Walking a chain, ordering it and deciding what to do with a
 * halted unwind belong to `../cleanup.ts`; this module deliberately judges one
 * record at a time and needs no chain awareness beyond honouring the record it
 * is handed.
 *
 * The one thing a chain changes is the **report**. A chained record's own
 * backup holds the previous plan version's instrumented output, not the
 * pristine file, so a report that called it "the original" would send the
 * developer to bytes that still carry the tool's wrapper. A caller that knows
 * the record's chain root (`findChainRoot` in `../schema/modification.ts`)
 * passes it as {@link ConflictDetectionContext.chainRoot}; the report then
 * names the root's backup as `originalBackupPath`, the default message points
 * there, and the "original" side of the diff views is the root's verified
 * backup. The verdict is untouched by it: it is still judged against the
 * record's own two digests, and the root's backup is read only to explain a
 * conflict, never to authorise a write.
 *
 * ## The report
 *
 * A conflict is **data, not a failure**: it is returned inside a successful
 * `Result`, never thrown and never converted into an `Err` a caller might log
 * and forget. `Err` is reserved for the conditions that make the question
 * unanswerable — a path outside the project, a backup store belonging to
 * another session, a target that cannot be read at all.
 *
 * The report shape is {@link ModificationConflict} from
 * `../schema/modification.js`, the object `cleanup.completed` carries to both
 * user interfaces, so every verdict is JSON-serialisable and holds no `Error`
 * instance. It carries what the AAP §0.5.5 message and its "Open diff" action
 * need — the record id, the project-relative file, the backup path where the
 * original still is, the reason, both sides of the hash comparison and the
 * three-way diff — without this module authoring the developer-facing prose:
 * {@link ConflictDetectionContext.message} lets the caller supply that sentence,
 * and the factual default composed here states only what was observed.
 *
 * ## Three-way, from two-way patches
 *
 * `diff` 9.0.0 exposes no three-way merge and no diff3, and this package's
 * dependencies are frozen at `zod`, `ts-morph` and `diff`, so the three-way
 * view is composed from two-way patches over the three texts that can be
 * obtained (AAP §0.5.1):
 *
 * - `originalToInstrumented` — what the tool did. Taken from the record's own
 *   `diff`, which the patcher produced over the exact bytes it hashed. For a
 *   chained record with a known root it is **rendered** instead, from the
 *   root's verified backup to the reconstructed instrumented text, so it spans
 *   every plan version up to this one; the record's own `diff` starts from the
 *   intermediate bytes and is never used for it.
 * - `instrumentedToCurrent` — what the developer changed on top of the patch,
 *   and the most useful hunk set for "Open diff". The instrumented text is not
 *   on disk any more, so it is reconstructed by applying the record's diff to
 *   the record's own backup and is used **only** if the reconstruction hashes
 *   to `instrumentedHash`.
 * - `originalToCurrent` — the net divergence from the pristine file: the
 *   record's own backup, or the chain root's for a chained record. When the
 *   root's backup cannot be read back or verified, both views that start from
 *   the original are omitted rather than rendered from the intermediate bytes.
 *
 * Every patch is rendered with `ignoreWhitespace` and `stripTrailingCr` left at
 * their defaults (`false`), and reconstruction runs with
 * `autoConvertLineEndings: false`: a diff that hid whitespace would contradict
 * the hash that produced the verdict. A view that cannot be produced is
 * **omitted** rather than approximated, and {@link ConflictingVerdict.omittedDiffs}
 * says which view was left out and why — including the case where a rendered
 * patch exceeds {@link CONFLICT_DIFF_CHARACTER_LIMIT}, since the conflict shape
 * carries no truncation flag and a clipped patch would claim to be the whole
 * change.
 *
 * ## Privacy
 *
 * A developer's source is their own. The report carries no file content beyond
 * the diff itself, and nothing in this module ever logs a byte of content:
 * every log record and every error detail holds paths, digests, ids, counts and
 * enumerated reasons only (AAP §0.5.2).
 *
 * ## Consumers
 *
 * - `../cleanup.ts` — `restoreModification`, `restoreChain`, `cleanupSession`
 *   and the start-up `reconcileModifications` pass all gate their write on a
 *   `'restorable'` verdict and report anything else.
 * - `./patcher.ts` — the baseline check before a chained patch, so the conflict
 *   decision lives in exactly one place rather than being re-derived there.
 * - `./conflict.test.ts` — the unit-level half of acceptance test 3.
 *
 * The import direction is one-way: cleanup and the patcher import this module,
 * and this module imports neither.
 */

import { applyPatch, createTwoFilesPatch } from 'diff';

import {
  DebuggenError,
  err,
  isErr,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  resolveWithinProject,
  toPosix,
} from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';
import { readFileNoFollow, sha256Hex } from '@debuggen/shared/node';

import { MAX_CONFLICT_DIFF_LENGTH, parseModificationConflict } from '../schema/modification.js';
import type {
  ModificationConflict,
  ModificationConflictReason,
  ModificationRecord,
} from '../schema/modification.js';
import type { BackupStore } from './backup-store.js';

/**
 * The cap on each rendered patch in a report: the schema's own
 * {@link MAX_CONFLICT_DIFF_LENGTH}, re-exported under the name this module's
 * callers and suites read.
 *
 * Aliased rather than restated so the producer and the validator cannot drift:
 * a view longer than this is omitted here, and the schema would reject it at
 * the transport boundary if it were not. A conflict may carry three patches at
 * once inside a `cleanup.completed` frame that both user interfaces render
 * immediately, which is why the bound is per view rather than per report.
 */
export const CONFLICT_DIFF_CHARACTER_LIMIT = MAX_CONFLICT_DIFF_LENGTH;

/**
 * The largest text, in bytes, this module will diff on either side of a view:
 * 4 MiB.
 *
 * Diffing is line-wise and quadratic in the worst case, so a pathological input
 * — a generated bundle, a checked-in fixture, a file a developer replaced
 * wholesale — is refused before the work starts rather than after it. The
 * verdict itself is unaffected: it comes from SHA-256 over the raw bytes, which
 * is linear and has no such bound. Only the *explanatory* patch is dropped, and
 * {@link ConflictingVerdict.omittedDiffs} records that it was.
 */
export const CONFLICT_DIFF_INPUT_BYTE_LIMIT = 4 * 1024 * 1024;

/**
 * How many unchanged lines surround each hunk of a rendered patch: 3.
 *
 * Three is the conventional unified-diff default and is what makes the emitted
 * text recognisable to every diff viewer a developer already uses. `diff`'s own
 * default is 4; this module states the value explicitly so the output does not
 * change if that default ever does.
 */
export const CONFLICT_DIFF_CONTEXT_LINES = 3;

/**
 * The cap on the developer-facing `message` of a report, in characters: 2048.
 *
 * Mirrors the bound {@link ModificationConflict} enforces on the field, which
 * the schema keeps module-private. Both the caller's message and the factual
 * default composed here are bounded by it before a report is assembled, so a
 * long path — a backup path may be four kilobytes on its own — can never push a
 * report past validation.
 */
export const CONFLICT_MESSAGE_CHARACTER_LIMIT = 2048;

/**
 * The label appended after a tab to the `---` line of a rendered patch, per
 * view side.
 *
 * Unified-diff readers treat everything after the tab on a file header line as
 * an annotation — conventionally a timestamp — so putting the side's identity
 * there labels the three views inside the text itself while leaving each patch
 * applicable by an ordinary patch tool. The alternative, spelling the label
 * into the filename, would produce headers no tool can resolve back to a file.
 */
const DIFF_LABELS = Object.freeze({
  original: 'original (recorded backup)',
  instrumented: 'instrumented (written by this tool)',
  current: 'current (on disk)',
});

// ---------------------------------------------------------------------------
// What is known about the backup, on every verdict.
// ---------------------------------------------------------------------------

/**
 * Why the recorded original could not be read back, when it could not.
 *
 * Reported on {@link BackupState} for every verdict, because "can this be
 * restored at all" is a different question from "does the file still match",
 * and a caller needs both answers at once: `../cleanup.ts` restores a file that
 * is no longer there *from its backup*, so a missing target with an intact
 * backup is recoverable while a matching target with no backup is not.
 *
 * - `missing` — nothing is at the record's backup path (or, for a recorded path
 *   the store will not open, at the location it composes for `originalHash`).
 * - `digest-mismatch` — a file is there but its bytes do not hash to the digest
 *   it is filed under, so it cannot be trusted as the original. The backup
 *   store keeps it rather than overwriting it, and so must every caller.
 * - `unreadable` — the backup exists but the read failed (permissions, a
 *   symbolic link planted at the path, a directory in its place), or a
 *   directory above a relocated backup failed the state-directory policy. The
 *   errno, or the policy's own reason, is recorded in `detail`.
 * - `unusable-path` — the record's `originalHash` is not a value the backup
 *   store will turn into a path, so no backup could even be located. A
 *   malformed record, surfaced rather than silently treated as "no backup".
 *
 * Frozen because it is a module-level table: a mutation would widen what every
 * consumer of a verdict has to handle.
 */
export const BACKUP_UNAVAILABLE_REASONS = Object.freeze([
  'missing',
  'digest-mismatch',
  'unreadable',
  'unusable-path',
] as const);

/** One of {@link BACKUP_UNAVAILABLE_REASONS}. */
export type BackupUnavailableReason = (typeof BACKUP_UNAVAILABLE_REASONS)[number];

/**
 * What is known about the record's backup at the moment of the verdict.
 *
 * Present on every verdict, including the ones where it changes nothing, so a
 * caller never has to ask the backup store a second question to know whether
 * the original is still recoverable. `path` is always the path the record
 * carries — the value AAP §0.5.5 quotes to the developer — even when nothing is
 * there, because "where the original was supposed to be" is the only useful
 * thing left to say in that case.
 */
export type BackupState =
  | {
      /** The backup was read back and hashes to the record's `originalHash`. */
      readonly available: true;

      /** Where it is: the record's `backupPath`. */
      readonly path: string;

      /** How many bytes the original holds. */
      readonly byteLength: number;
    }
  | {
      /** The original could not be read back. Restoration is impossible. */
      readonly available: false;

      /** Where it was expected: the record's `backupPath`. */
      readonly path: string;

      /** Which of {@link BACKUP_UNAVAILABLE_REASONS} applies. */
      readonly reason: BackupUnavailableReason;

      /**
       * A short, content-free amplification of `reason`: an errno such as
       * `ELOOP`, or the enumerated reason the backup store itself reported.
       * Absent when `reason` already says everything.
       */
      readonly detail?: string;
    };

// ---------------------------------------------------------------------------
// The three views, and why one of them may be absent.
// ---------------------------------------------------------------------------

/**
 * The three views of a conflict, in the order a reader makes sense of them.
 *
 * The names are the member names of {@link ModificationConflict.diffs}, so a
 * diagnostic naming a view and the report field it belongs to cannot disagree.
 */
export const CONFLICT_DIFF_VIEWS = Object.freeze([
  'originalToInstrumented',
  'instrumentedToCurrent',
  'originalToCurrent',
] as const);

/** One of {@link CONFLICT_DIFF_VIEWS}. */
export type ConflictDiffView = (typeof CONFLICT_DIFF_VIEWS)[number];

/**
 * Why a view is absent from a report.
 *
 * The conflict shape carries no truncation flag by design, so an oversized or
 * unobtainable patch is left out entirely and accounted for here instead of
 * being shortened into something that would present itself as the whole change.
 *
 * - `text-unavailable` — one side's text could not be obtained: the file is
 *   gone, the backup is gone, or the instrumented text could not be
 *   reconstructed from the record's diff and verified against
 *   `instrumentedHash`.
 * - `not-utf8` — one side's bytes are not valid UTF-8. The verdict is
 *   unaffected (hashing is byte-based), but a line-wise patch over lossily
 *   decoded bytes would describe content that does not exist.
 * - `input-too-large` — one side exceeds {@link CONFLICT_DIFF_INPUT_BYTE_LIMIT}.
 * - `exceeds-length-limit` — the rendered patch exceeds
 *   {@link CONFLICT_DIFF_CHARACTER_LIMIT}. This is the truncation case, and the
 *   composed message says so in words as well.
 * - `no-differences` — the two sides are identical, so the patch would be an
 *   empty header. Reported rather than emitted, so an empty view is never
 *   mistaken for "no information".
 */
export const CONFLICT_DIFF_OMISSION_REASONS = Object.freeze([
  'text-unavailable',
  'not-utf8',
  'input-too-large',
  'exceeds-length-limit',
  'no-differences',
] as const);

/** One of {@link CONFLICT_DIFF_OMISSION_REASONS}. */
export type ConflictDiffOmissionReason = (typeof CONFLICT_DIFF_OMISSION_REASONS)[number];

/** One view that is not in the report, and why. */
export interface ConflictDiffOmission {
  /** The view that was left out. */
  readonly view: ConflictDiffView;

  /** Why it was left out. */
  readonly reason: ConflictDiffOmissionReason;
}

/**
 * The `diffs` object of a {@link ModificationConflict}, named for reuse.
 *
 * Derived from the schema rather than restated, so the three view names and
 * their optionality stay one statement. {@link buildConflictReport} accepts a
 * value of this type from `../cleanup.ts`, which composes a report of its own
 * for the reason that only exists after a write has been attempted.
 */
export type ConflictDiffs = NonNullable<ModificationConflict['diffs']>;

// ---------------------------------------------------------------------------
// The verdicts.
// ---------------------------------------------------------------------------

/**
 * Every verdict {@link detectConflict} can reach.
 *
 * Exactly one of them — `'restorable'` — authorises a write. The other four
 * authorise nothing, and three of them carry a {@link ModificationConflict} the
 * caller reports as-is.
 */
export const CONFLICT_VERDICT_KINDS = Object.freeze([
  'restorable',
  'already-reverted',
  'content-changed',
  'file-missing',
  'backup-unavailable',
] as const);

/** One of {@link CONFLICT_VERDICT_KINDS}. */
export type ConflictVerdictKind = (typeof CONFLICT_VERDICT_KINDS)[number];

/**
 * What every verdict states, whatever it decided.
 *
 * All of it is JSON-serialisable: a verdict travels no further than the
 * service, but the report inside it crosses a WebSocket, and keeping the whole
 * value plain data is what makes a verdict loggable and a suite able to
 * round-trip it.
 */
export interface ConflictVerdictBase {
  /** The {@link ModificationRecord.id} that was judged. */
  readonly recordId: string;

  /** The session that owns the record. */
  readonly sessionId: string;

  /** The file, project-relative POSIX, exactly as the record spells it. */
  readonly file: string;

  /**
   * The absolute path the file was read from, resolved inside the project root
   * and confirmed to be inside it.
   */
  readonly path: string;

  /**
   * The digest the tool expected to find: the record's `instrumentedHash`.
   *
   * Named `expectedHash` rather than repeated as `instrumentedHash` because
   * that is what it *means* here, and because it is the field name the report
   * carries to both user interfaces.
   */
  readonly expectedHash: string;

  /** The record's `originalHash`: what the pristine file hashed to. */
  readonly originalHash: string;

  /** When the comparison was made, in epoch milliseconds. */
  readonly detectedAt: number;

  /** Whether the recorded original can still be read back. */
  readonly backup: BackupState;
}

/**
 * The file still holds exactly what the tool wrote, and the recorded original
 * is readable: a restore is authorised.
 *
 * The **only** verdict that authorises a write, and the authorisation is the
 * caller's to act on — this module has written nothing.
 */
export interface RestorableVerdict extends ConflictVerdictBase {
  readonly kind: 'restorable';

  /** The file's current digest, equal to {@link ConflictVerdictBase.expectedHash}. */
  readonly actualHash: string;

  /** Narrowed: a restorable verdict is only reached with a verified backup. */
  readonly backup: Extract<BackupState, { available: true }>;
}

/**
 * The file already holds the recorded original: there is nothing to do.
 *
 * A legitimate state, not a defect — the process may have died between the
 * rename and the status update, an earlier cleanup may have restored the file
 * without closing the record, or the developer may have reverted it by hand.
 * The backup may legitimately be gone in this state, which is why its absence
 * does not turn this into a conflict.
 */
export interface AlreadyRevertedVerdict extends ConflictVerdictBase {
  readonly kind: 'already-reverted';

  /** The file's current digest, equal to {@link ConflictVerdictBase.originalHash}. */
  readonly actualHash: string;
}

/** What the three conflict verdicts add. */
interface ConflictingVerdictParts {
  /** The report to hand to the developer, ready for `cleanup.completed`. */
  readonly conflict: ModificationConflict;

  /**
   * Which of the three views are not in {@link ConflictingVerdictParts.conflict},
   * and why.
   *
   * Empty when all three are present. A `'exceeds-length-limit'` entry is the
   * truncation signal: the patch was too long for the transport, so it was
   * omitted rather than clipped, and the report's `message` says so too.
   */
  readonly omittedDiffs: readonly ConflictDiffOmission[];
}

/**
 * The file was changed after it was instrumented: the headline conflict.
 *
 * Its digest matches neither the content the tool wrote nor the original, so
 * the bytes on disk are the developer's and nothing may be written over them.
 * Reached as well for a chained record whose plan version is no longer the
 * outermost one — the file legitimately holds a later version's content — which
 * is what stops a reverse-order unwind from skipping a step.
 */
export interface ContentChangedVerdict extends ConflictVerdictBase, ConflictingVerdictParts {
  readonly kind: 'content-changed';

  /** The file's current digest: neither expected digest. */
  readonly actualHash: string;
}

/**
 * The file is not there any more: deleted, renamed or moved after the patch was
 * applied.
 *
 * Never a conflict-free restore and never a write. The verdict carries the
 * backup state so a caller can distinguish "the original is still recoverable"
 * — `../cleanup.ts` restores the file in that case and notes it — from "both
 * copies are gone", which is only reportable.
 */
export interface FileMissingVerdict extends ConflictVerdictBase, ConflictingVerdictParts {
  readonly kind: 'file-missing';
}

/**
 * The file still holds what the tool wrote, but the recorded original cannot be
 * read back, so restoration is impossible.
 *
 * Surfaced rather than silently closed: the record stays open, the backup path
 * is reported, and the file is left instrumented rather than being "restored"
 * from content nobody verified. The report's reason names what was observed:
 * `'backup-corrupt'` when a backup is there but fails its own digest
 * (`backup.reason === 'digest-mismatch'`), `'backup-missing'` when it is gone,
 * unreadable or cannot be located.
 */
export interface BackupUnavailableVerdict extends ConflictVerdictBase, ConflictingVerdictParts {
  readonly kind: 'backup-unavailable';

  /** The file's current digest, equal to {@link ConflictVerdictBase.expectedHash}. */
  readonly actualHash: string;

  /** Narrowed: this verdict exists because the backup is not usable. */
  readonly backup: Extract<BackupState, { available: false }>;
}

/**
 * The verdicts that carry a report: everything except a restore and a no-op.
 *
 * Useful to a caller that treats all three the same way — keep the file, keep
 * the backup, report the conflict — which is what `../cleanup.ts` does.
 */
export type ConflictingVerdict =
  ContentChangedVerdict | FileMissingVerdict | BackupUnavailableVerdict;

/** The answer {@link detectConflict} gives. */
export type ConflictVerdict = RestorableVerdict | AlreadyRevertedVerdict | ConflictingVerdict;

// ---------------------------------------------------------------------------
// What the caller supplies.
// ---------------------------------------------------------------------------

/**
 * The two filesystem primitives this module uses, injectable as a pair.
 *
 * Injected rather than imported at the call site so a suite can drive a
 * scenario the filesystem cannot easily be made to produce — an errno on
 * demand, a digest that changes between two reads — without monkey-patching
 * `node:fs` for the whole process. {@link defaultConflictFileReader} is what
 * production uses, and the contract either way is byte fidelity: content is
 * read as bytes and hashed as bytes, never decoded, never newline-normalised.
 */
export interface ConflictFileReader {
  /**
   * Reads a file's bytes, refusing to follow a symbolic link at the final
   * component.
   *
   * The refusal matters: the path is composed from a record that may have been
   * written by an earlier run, inside a directory anything on the machine can
   * write to, so a link planted at the target must surface as `ELOOP` rather
   * than yield attacker-chosen bytes that would then be compared against a
   * recorded digest.
   *
   * @param absolutePath The file to read.
   * @returns Its bytes, exactly as stored.
   * @throws The runtime's own filesystem error with its `code` intact —
   * `ENOENT`, `ELOOP`, `EACCES`, `EISDIR`.
   */
  readonly readFileBytes: (absolutePath: string) => Uint8Array;

  /**
   * Hashes bytes with SHA-256 and returns 64 lowercase hexadecimal characters.
   *
   * Over raw bytes and nothing else. CRLF and LF content hash differently and
   * non-UTF-8 bytes hash without loss, which is the fidelity the entire
   * restore-versus-conflict decision rests on: a whitespace-insensitive or
   * decode-then-compare implementation here would silently authorise
   * overwriting a developer's edit.
   */
  readonly hashBytes: (bytes: Uint8Array) => string;
}

/**
 * The production {@link ConflictFileReader}: `readFileNoFollow` and `sha256Hex`
 * from `@debuggen/shared/node`.
 *
 * Frozen and shared, because it holds no state. `sha256OfFile` is deliberately
 * *not* used: it streams, which is the better read for a digest alone, but it
 * follows symbolic links and this module needs the bytes anyway to compose the
 * diff, so one no-follow read serves both.
 */
export const defaultConflictFileReader: ConflictFileReader = Object.freeze({
  readFileBytes: readFileNoFollow,
  hashBytes: sha256Hex,
});

/**
 * Everything {@link detectConflict} needs from its caller.
 *
 * Deliberately a structural subset of the `InstrumentationContext` that
 * `../adapter.ts` declares, so `../cleanup.ts` and `./patcher.ts` pass their
 * own context straight through instead of assembling a second object:
 * `projectRoot`, `backups`, `logger` and `now` carry the same meanings there.
 * Importing that context type here would point this module at `../adapter.ts`,
 * which sits above `patch/` and imports it — hence a subset rather than a
 * reference.
 *
 * Nothing is read from the environment: the backup store already holds the
 * resolved state directory, and the project root arrives as an argument.
 */
export interface ConflictDetectionContext {
  /**
   * The absolute POSIX path of the project the record belongs to.
   *
   * Every path is validated inside it before anything is touched. This module
   * is part of the only subtree allowed near a developer's project, and it
   * still refuses a path that escapes.
   */
  readonly projectRoot: string;

  /**
   * The backup store for the record's session.
   *
   * Used to read the recorded original back; never to write or delete. Its
   * `sessionId` must equal the record's, or the detection is refused — a store
   * for another session would compose a path in the wrong session directory and
   * report a perfectly good backup as missing.
   */
  readonly backups: BackupStore;

  /**
   * Where to log. Defaults to the no-op logger.
   *
   * Paths, digests, ids, counts and enumerated reasons only: never a byte of
   * file content (AAP §0.5.2).
   */
  readonly logger?: Logger | undefined;

  /**
   * The clock, in epoch milliseconds. Defaults to `nowEpochMs()`.
   *
   * Injectable so a suite can assert on `detectedAt`. A reading that is not a
   * finite positive number is refused in favour of the system clock and warned
   * about, because it would otherwise fail the report's own validation far from
   * its cause.
   */
  readonly now?: (() => number) | undefined;

  /**
   * The filesystem primitives to use. Defaults to
   * {@link defaultConflictFileReader}.
   */
  readonly files?: ConflictFileReader | undefined;

  /**
   * The developer-facing sentence to put on any report this call produces.
   *
   * The wording of a conflict belongs to the service and the adapters, which
   * know the developer's context and the recovery action to offer (AAP §0.5.5);
   * this module composes a factual default only so that a report can never
   * reach a user interface as a blank row. Supply it to own the wording, and it
   * is used verbatim, bounded by
   * {@link CONFLICT_MESSAGE_CHARACTER_LIMIT}.
   */
  readonly message?: string | undefined;

  /**
   * The chain root of the record being judged, when it is a chained record:
   * the first record of its follow-up chain, whose backup is the pristine
   * file. `findChainRoot` in `../schema/modification.ts` resolves it from the
   * records beside the judged one.
   *
   * Used only to explain a conflict — never to reach a verdict, which is
   * judged against the record's own digests as ever. When it is usable (see
   * {@link isUsableChainRoot}) and the verdict is a conflict, the root's backup
   * is read back and verified against the root's `originalHash`, read-only
   * like the record's own; the report carries the root's backup path as
   * `originalBackupPath`; the default message for `'content-changed'` and
   * `'file-missing'` names that path and what became of it; and both views
   * that start from the original start from the root's verified text, or are
   * omitted when it cannot be had. A root that is not usable — the record
   * itself, another session's record, another file's, or one given for an
   * unchained record — is ignored with a warning, and the report is composed
   * exactly as without one.
   */
  readonly chainRoot?: ModificationRecord | undefined;
}

/**
 * The inputs {@link buildConflictReport} assembles into a report.
 *
 * Exported for `../cleanup.ts`, which needs one report this module cannot
 * produce: `'restore-verification-failed'` only becomes true *after* a restore
 * has been written, which is a state no read-only detector can observe.
 * Composing it through this function keeps every conflict the developer sees in
 * one shape, with one bounding policy and one validation step.
 */
export interface ConflictReportInput {
  /** The record the conflict is about. Never mutated. */
  readonly record: ModificationRecord;

  /** Which branch of the reconciliation table was taken. */
  readonly reason: ModificationConflictReason;

  /** When the conflict was detected, in epoch milliseconds. */
  readonly detectedAt: number;

  /**
   * The digest the file actually has, when it has one. Omit it for a file that
   * is not there: a blank digest would be a value that looks like an answer.
   */
  readonly actualHash?: string | undefined;

  /**
   * The developer-facing explanation. Bounded here, and required to be
   * non-blank — a report with nothing to show is refused rather than delivered.
   */
  readonly message: string;

  /**
   * The views that could be composed. Each is bounded here, and a view past the
   * cap is dropped from the report rather than shortened.
   */
  readonly diffs?: ConflictDiffs | undefined;

  /**
   * The record's chain root, when it is a chained record whose root the caller
   * resolved. A usable root (see {@link isUsableChainRoot}) puts its backup
   * path on the report as `originalBackupPath`; an unusable one is ignored, so
   * a report never names another file's or another session's backup as the
   * original.
   */
  readonly chainRoot?: ModificationRecord | undefined;
}

// ---------------------------------------------------------------------------
// Narrowing helpers.
// ---------------------------------------------------------------------------

/**
 * Whether a verdict authorises a restore.
 *
 * The one question a caller about to write must ask. Offered as a predicate
 * rather than as a boolean field on the verdict so that the narrowing comes
 * with it: inside the guard, the backup is known to be verified and
 * `actualHash` is known to be present.
 *
 * @param verdict Any verdict from {@link detectConflict}.
 * @returns `true` only for the `'restorable'` verdict.
 */
export function isRestorableVerdict(verdict: ConflictVerdict): verdict is RestorableVerdict {
  return verdict.kind === 'restorable';
}

/**
 * Whether a verdict carries a {@link ModificationConflict} to report.
 *
 * True for `'content-changed'`, `'file-missing'` and `'backup-unavailable'` —
 * the three outcomes that leave the file and the backup exactly as they were
 * and leave the record open. `../cleanup.ts` uses it to collect
 * `cleanup.completed`'s `conflicts` array without repeating the three cases.
 *
 * @param verdict Any verdict from {@link detectConflict}.
 * @returns `true` when `verdict.conflict` is present.
 */
export function isConflictVerdict(verdict: ConflictVerdict): verdict is ConflictingVerdict {
  return (
    verdict.kind === 'content-changed' ||
    verdict.kind === 'file-missing' ||
    verdict.kind === 'backup-unavailable'
  );
}

/**
 * Whether a candidate chain root may stand in for a record's pristine
 * original.
 *
 * The one gate every use of {@link ConflictDetectionContext.chainRoot} and
 * {@link ConflictReportInput.chainRoot} passes through, so a report can never
 * name the wrong file's backup as "the original": the candidate must be a
 * different record than the one judged, of the same session (backups are filed
 * per session, and the judged record's store is the one that reads it) and of
 * the same file, compared in normalised POSIX form — and the judged record must
 * itself be chained, because an unchained record's own backup already is the
 * pristine file.
 *
 * @param record The record a conflict is about.
 * @param chainRoot The candidate root, if the caller supplied one.
 * @returns `true` when `chainRoot` is present and usable for `record`.
 */
export function isUsableChainRoot(
  record: ModificationRecord,
  chainRoot: ModificationRecord | undefined,
): boolean {
  return (
    chainRoot !== undefined &&
    record.previousRecordId !== undefined &&
    chainRoot.id !== record.id &&
    chainRoot.sessionId === record.sessionId &&
    normalizePosix(toPosix(chainRoot.file)) === normalizePosix(toPosix(record.file))
  );
}

// ---------------------------------------------------------------------------
// The public API.
// ---------------------------------------------------------------------------

/**
 * Decides what may be done with one recorded modification, and reports the
 * conflict when the answer is "nothing".
 *
 * Reads the file, hashes its bytes and compares the digest with the two digests
 * the record already carries. **Writes nothing, deletes nothing and mutates
 * nothing** — not the file, not the backup, not the record. Status transitions
 * (`conflict`, `reverted`, …) are the journal's business, written by
 * `../cleanup.ts` and `./patcher.ts`; this function takes no journal and opens
 * no database, so it cannot make one even by accident.
 *
 * ## The decision, in order
 *
 * 1. `record.file` is resolved against `context.projectRoot` with
 *    `resolveWithinProject`. A path that escapes is refused **before anything
 *    is read**, with `PATH_OUTSIDE_PROJECT`.
 * 2. The backup store is confirmed to belong to the record's session.
 * 3. The file's bytes are read without following a symbolic link at the final
 *    component, and hashed as bytes.
 * 4. The recorded original is read back and checked against `originalHash`, so
 *    every verdict can say whether restoration is possible at all.
 * 5. The digest decides: `instrumentedHash` → `'restorable'` (or
 *    `'backup-unavailable'` if the original cannot be read back);
 *    `originalHash` → `'already-reverted'`; neither → `'content-changed'`; no
 *    file → `'file-missing'`.
 * 6. For a conflicting verdict of a chained record whose usable
 *    {@link ConflictDetectionContext.chainRoot} was supplied, the root's backup
 *    is read back and verified against the root's `originalHash` too, so the
 *    report can name and diff against the pristine file. Nothing about the
 *    verdict changes, and a restorable or already-reverted verdict never reads
 *    it.
 *
 * A record whose two digests are equal — a transform that changed nothing,
 * which `./patcher.ts` refuses to journal — resolves as `'restorable'`, and
 * restoring it writes the same bytes back. That is harmless and is the reading
 * the reconciliation table gives such a record.
 *
 * ## Errors versus verdicts
 *
 * A conflict is a **successful** result: `Err` is reserved for the conditions
 * that make the question unanswerable, and each of them leaves the file and the
 * backup untouched too.
 *
 * | Condition | Code |
 * | --- | --- |
 * | `record.file` escapes the project root | `PATH_OUTSIDE_PROJECT` |
 * | the backup store belongs to another session | `STORE_ERROR` |
 * | a symbolic link is planted at the target | `FS_UNSAFE_PATH` |
 * | the target cannot be read for any other reason | `INTERNAL`, with the errno in `details` |
 * | a composed report fails its own schema | `INTERNAL`, with the issues in `details` |
 *
 * @param record The journal entry to judge. Both expected digests are taken
 * from it, never re-derived, and it is judged on its own terms — which is what
 * makes a chained record (`previousRecordId`) correct without this function
 * knowing anything about chains beyond what its report says.
 * @param context The project root, the session's backup store, and optionally a
 * logger, a clock, the filesystem primitives, the developer-facing message and
 * the record's chain root. An `InstrumentationContext` satisfies it
 * structurally and can be passed straight through.
 * @returns `ok(verdict)` with one of the five verdicts, or `err(error)` for one
 * of the conditions above.
 *
 * @example
 * ```ts
 * const verdict = await detectConflict(record, context);
 * if (isErr(verdict)) return verdict;
 * if (isRestorableVerdict(verdict.value)) {
 *   // Only here is a write authorised.
 * } else if (isConflictVerdict(verdict.value)) {
 *   conflicts.push(verdict.value.conflict);
 * }
 * ```
 */
export async function detectConflict(
  record: ModificationRecord,
  context: ConflictDetectionContext,
): Promise<Result<ConflictVerdict>> {
  const logger = context.logger ?? noopLogger;
  const files = context.files ?? defaultConflictFileReader;
  const detectedAt = resolveDetectedAt(context.now, logger);

  // Containment first: nothing is read, hashed or located until the path is
  // known to be inside the project. A record's `file` is normally guaranteed
  // safe by its schema, but this module is one of the two that come near a
  // developer's working tree and does not rely on a caller having validated.
  const resolved = resolveWithinProject(context.projectRoot, record.file);
  if (isErr(resolved)) {
    logger.warn('conflict detection refused a path that is not inside the project', {
      recordId: record.id,
      sessionId: record.sessionId,
      file: record.file,
      code: resolved.error.code,
    });

    return resolved;
  }

  const path = resolved.value;

  // A store for another session composes backup paths in the wrong session
  // directory, which would report an intact backup as missing and turn a
  // restorable record into a conflict. Refused rather than guessed.
  if (context.backups.sessionId !== record.sessionId) {
    return err(backupStoreSessionMismatch(record, context.backups.sessionId));
  }

  const target = readTarget(path, files);
  if (target.kind === 'unreadable') {
    logger.error('conflict detection could not read an instrumented file', {
      recordId: record.id,
      sessionId: record.sessionId,
      file: record.file,
      code: target.error.code,
    });

    return err(target.error);
  }

  const backup = await inspectBackup(record, context.backups, files, logger);
  const chainRoot = usableChainRootOf(record, context.chainRoot, logger);

  // Read only on the conflicting branches below, and at most once: the root's
  // backup explains a conflict and never decides one, so a restorable or
  // already-reverted verdict performs exactly the reads it always did.
  const rootOriginal = async (): Promise<ChainRootOriginal | undefined> =>
    chainRoot === undefined
      ? undefined
      : {
          record: chainRoot,
          inspection: await inspectBackup(chainRoot, context.backups, files, logger),
        };

  const base: ConflictVerdictBase = {
    recordId: record.id,
    sessionId: record.sessionId,
    file: record.file,
    path,
    expectedHash: record.instrumentedHash,
    originalHash: record.originalHash,
    detectedAt,
    backup: backup.state,
  };

  if (target.kind === 'missing') {
    logger.warn('conflict detection: an instrumented file is no longer present', {
      recordId: record.id,
      sessionId: record.sessionId,
      file: record.file,
      backupAvailable: backup.state.available,
    });

    const parts = composeConflictParts({
      reason: 'file-missing',
      record,
      detectedAt,
      backup: backup.state,
      backupBytes: backup.bytes,
      root: await rootOriginal(),
      message: context.message,
      files,
      logger,
    });

    if (isErr(parts)) {
      return parts;
    }

    return ok({ ...base, kind: 'file-missing', ...parts.value });
  }

  const actualHash = files.hashBytes(target.bytes);

  if (actualHash === record.instrumentedHash) {
    if (backup.state.available) {
      logger.debug('conflict detection: the file still holds the instrumented content', {
        recordId: record.id,
        sessionId: record.sessionId,
        file: record.file,
        expectedHash: record.instrumentedHash,
      });

      return ok({
        ...base,
        kind: 'restorable',
        actualHash,
        backup: backup.state,
      });
    }

    // The content is ours, but the only copy of the original is not usable, so
    // there is nothing verified to write back. Reported, not closed — and named
    // for what was observed: a backup that is there but fails its own digest is
    // `backup-corrupt`, which a developer can inspect, while one that is gone or
    // cannot be read is `backup-missing`.
    const corrupt = backup.state.reason === 'digest-mismatch';

    logger.warn(
      corrupt
        ? 'conflict detection: the recorded original does not hash to the digest it is filed under'
        : 'conflict detection: the recorded original cannot be read back',
      {
        recordId: record.id,
        sessionId: record.sessionId,
        file: record.file,
        backupPath: backup.state.path,
        reason: backup.state.reason,
      },
    );

    const parts = composeConflictParts({
      reason: corrupt ? 'backup-corrupt' : 'backup-missing',
      record,
      detectedAt,
      actualHash,
      backup: backup.state,
      backupBytes: backup.bytes,
      currentBytes: target.bytes,
      root: await rootOriginal(),
      message: context.message,
      files,
      logger,
    });

    if (isErr(parts)) {
      return parts;
    }

    return ok({
      ...base,
      kind: 'backup-unavailable',
      actualHash,
      backup: backup.state,
      ...parts.value,
    });
  }

  if (actualHash === record.originalHash) {
    logger.debug('conflict detection: the file already holds the recorded original', {
      recordId: record.id,
      sessionId: record.sessionId,
      file: record.file,
      originalHash: record.originalHash,
    });

    return ok({ ...base, kind: 'already-reverted', actualHash });
  }

  logger.warn('conflict detection: the file no longer matches the instrumented content', {
    recordId: record.id,
    sessionId: record.sessionId,
    file: record.file,
    expectedHash: record.instrumentedHash,
    actualHash,
    backupAvailable: backup.state.available,
  });

  const parts = composeConflictParts({
    reason: 'content-changed',
    record,
    detectedAt,
    actualHash,
    backup: backup.state,
    backupBytes: backup.bytes,
    currentBytes: target.bytes,
    root: await rootOriginal(),
    message: context.message,
    files,
    logger,
  });

  if (isErr(parts)) {
    return parts;
  }

  return ok({ ...base, kind: 'content-changed', actualHash, ...parts.value });
}

/**
 * Assembles and validates one {@link ModificationConflict}.
 *
 * The single place a conflict report is shaped, bounded and checked, so every
 * conflict a developer sees — whichever branch produced it — carries the same
 * fields under the same limits. {@link detectConflict} composes its reports
 * through it, and `../cleanup.ts` uses it for the one reason a read-only
 * detector cannot reach: `'restore-verification-failed'`, which only becomes
 * true after a restore has been written and its result hashed.
 *
 * Bounding is applied rather than assumed: the message is clipped to
 * {@link CONFLICT_MESSAGE_CHARACTER_LIMIT} without splitting a surrogate pair,
 * and any view longer than {@link CONFLICT_DIFF_CHARACTER_LIMIT} is dropped —
 * the conflict shape carries no truncation flag, so an absent view reads
 * honestly as "nothing to show here" while a clipped one would claim to be the
 * whole change. A caller that drops a view this way should say so in its
 * `message`; {@link detectConflict} does.
 *
 * Nothing about the record is changed, and the record is not re-validated: a
 * malformed one fails this function's own validation of the composed report,
 * which is where the diagnostic belongs.
 *
 * `backupPath` is always the record's own. A usable
 * {@link ConflictReportInput.chainRoot} adds `originalBackupPath`, the root's
 * backup path — the pristine file "Original saved at ‹path›" must name for a
 * chained record — and an unusable one is ignored.
 *
 * @param input The record, the reason, the detection time and the
 * developer-facing message, plus the optional current digest, views and chain
 * root.
 * @returns `ok(conflict)` with a report that satisfies
 * `modificationConflictSchema`, or `err(error)` when the message is blank
 * (`INTERNAL`) or the composed report fails validation
 * (`PROTOCOL_INVALID_MESSAGE`, with the field-level issues in `details`).
 */
export function buildConflictReport(input: ConflictReportInput): Result<ModificationConflict> {
  const message = clipToLimit(input.message.trim(), CONFLICT_MESSAGE_CHARACTER_LIMIT);

  if (message.length === 0) {
    return err(
      new DebuggenError(
        'INTERNAL',
        'A conflict report was composed without a developer-facing message.',
        {
          hint: 'Pass a non-blank message describing what was observed; both user interfaces render it verbatim.',
          details: { reason: 'blank-conflict-message', recordId: input.record.id },
        },
      ),
    );
  }

  const diffs = input.diffs === undefined ? undefined : boundDiffs(input.diffs);
  const chainRoot = isUsableChainRoot(input.record, input.chainRoot) ? input.chainRoot : undefined;

  return parseModificationConflict({
    recordId: input.record.id,
    sessionId: input.record.sessionId,
    file: input.record.file,
    reason: input.reason,
    expectedHash: input.record.instrumentedHash,
    ...(input.actualHash === undefined ? {} : { actualHash: input.actualHash }),
    backupPath: input.record.backupPath,
    ...(chainRoot === undefined ? {} : { originalBackupPath: chainRoot.backupPath }),
    detectedAt: input.detectedAt,
    message,
    ...(diffs === undefined ? {} : { diffs }),
  });
}

// ---------------------------------------------------------------------------
// Reading the two sides.
//
// Both reads below are the only filesystem contact this module makes, and both
// are reads. What goes into a log line or an error detail from here is a path,
// a digest, an id, a count or an enumerated reason - never a byte of the
// content that was read (AAP §0.5.2).
// ---------------------------------------------------------------------------

/** The outcome of reading the instrumented file. */
type TargetRead =
  | { readonly kind: 'present'; readonly bytes: Uint8Array }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly error: DebuggenError };

/**
 * Reads the instrumented file, classifying the three outcomes a verdict needs
 * to tell apart.
 *
 * `ENOENT` is a **verdict**, not a failure: a developer may legitimately have
 * deleted or moved the file, and the record still has to be reported and its
 * backup still has to be preserved. `ELOOP` is the one errno this module has a
 * policy opinion about — a symbolic link planted at the target, which the
 * no-follow read exists to refuse — and everything else is reported with its
 * errno intact rather than being guessed at, because a raw errno reported under
 * a policy code would misdescribe what happened.
 */
function readTarget(path: string, files: ConflictFileReader): TargetRead {
  try {
    return { kind: 'present', bytes: files.readFileBytes(path) };
  } catch (error) {
    const code = errnoCodeOf(error);

    if (code === 'ENOENT') {
      return { kind: 'missing' };
    }

    if (code === 'ELOOP') {
      return {
        kind: 'unreadable',
        error: new DebuggenError(
          'FS_UNSAFE_PATH',
          'The instrumented file could not be read because a symbolic link is planted at its path.',
          {
            hint: 'Inspect the path by hand. Nothing was written, and the recorded original is still in the backup directory.',
            details: { reason: 'symlink-at-target', path },
            cause: error,
          },
        ),
      };
    }

    return {
      kind: 'unreadable',
      error: new DebuggenError('INTERNAL', 'The instrumented file could not be read.', {
        hint: 'Check the file and its parent directories. Nothing was written, and the record stays open for the next reconciliation.',
        details: { reason: 'target-unreadable', errno: code ?? 'unknown', path },
        cause: error,
      }),
    };
  }
}

/** What the backup turned out to be, and its bytes when they can be trusted. */
interface BackupInspection {
  /** The state to report on every verdict. */
  readonly state: BackupState;

  /**
   * The original's bytes, present only when they were read **and** verified
   * against `originalHash`.
   *
   * Unverified bytes are deliberately withheld rather than passed on for
   * diffing: a patch composed from content that is not the original would
   * describe a change that never happened.
   */
  readonly bytes?: Uint8Array | undefined;
}

/**
 * A chained record's pristine original: its chain root, and what reading the
 * root's backup back found.
 *
 * Only ever built for a root {@link isUsableChainRoot} accepted, and only on a
 * conflicting branch — see {@link detectConflict}.
 */
interface ChainRootOriginal {
  /** The chain root whose backup is the pristine file. */
  readonly record: ModificationRecord;

  /** Its backup, inspected exactly as the judged record's own is. */
  readonly inspection: BackupInspection;
}

/**
 * The caller's chain root when it is usable for the record, and `undefined`
 * otherwise — with a warning when a root was supplied but refused, since that
 * is a caller resolving the wrong record, and the report falls back to the
 * record's own backup as the only path it can vouch for.
 *
 * Ids and the enumerated refusal only: no path and no content.
 */
function usableChainRootOf(
  record: ModificationRecord,
  chainRoot: ModificationRecord | undefined,
  logger: Logger,
): ModificationRecord | undefined {
  if (chainRoot === undefined) {
    return undefined;
  }

  if (isUsableChainRoot(record, chainRoot)) {
    return chainRoot;
  }

  logger.warn('conflict detection ignored a chain root that does not belong to the record', {
    recordId: record.id,
    sessionId: record.sessionId,
    chainRootId: chainRoot.id,
    chainRootSessionId: chainRoot.sessionId,
    reason:
      record.previousRecordId === undefined
        ? 'record-not-chained'
        : chainRoot.id === record.id
          ? 'chain-root-is-record'
          : chainRoot.sessionId === record.sessionId
            ? 'chain-root-other-file'
            : 'chain-root-other-session',
  });

  return undefined;
}

/**
 * Reads the recorded original back, from where the record says it is, and
 * confirms it is the original.
 *
 * Through `BackupStore.readRecorded` rather than a read by digest: a record's
 * `backupPath` may have been updated since the patcher wrote it — a conflict
 * backup moved aside into a quarantine directory is the case the journal's
 * status patch exists for — and a read that recomposed the path from the digest
 * would report such a backup as missing, turn a restorable record into a
 * conflict and strand the patched file. The store decides where the recorded
 * path may be read from (a relocation only inside the record's own session
 * directory, in a subdirectory of it and under the record's digest; every
 * directory above it pinned from the state root and proven private through the
 * descriptor it opened; the file read through that pin without following a
 * link), so no journal string reaches a filesystem call from here.
 *
 * Deliberately a read plus a hash rather than `BackupStore.verify`, which
 * performs the identical check: this module needs the bytes anyway to compose
 * the three-way view, and one read that both verifies and yields the content is
 * better than two reads of the same file. The comparison is the same one
 * `verify` makes — the digest of the bytes against the digest the file is filed
 * under — and it uses the injected hasher so a suite can drive it.
 *
 * Never throws: every filesystem condition becomes a
 * {@link BackupUnavailableReason}, because "the original cannot be read back"
 * is an answer a verdict must carry rather than an error that replaces it.
 */
async function inspectBackup(
  record: ModificationRecord,
  backups: BackupStore,
  files: ConflictFileReader,
  logger: Logger,
): Promise<BackupInspection> {
  const located = backups.locateRecorded(record.backupPath, record.originalHash);

  if (isErr(located)) {
    return {
      state: {
        available: false,
        path: record.backupPath,
        reason: 'unusable-path',
        detail: storeReasonOf(located.error) ?? located.error.code,
      },
    };
  }

  if (located.value.source === 'substituted') {
    // Not fatal: the store never opens a recorded path outside its own backup
    // tree, and reads its composed location for the digest instead — the bytes
    // are then held to `originalHash` below like any others. Worth saying out
    // loud, because it means the record was written against a different state
    // directory and the path the developer is shown is not where this process
    // looked.
    logger.warn('a record names a backup path this store would not compose', {
      recordId: record.id,
      sessionId: record.sessionId,
      recordedPath: record.backupPath,
      storePath: located.value.path,
    });
  }

  // Annotated rather than inferred: an unannotated `let` assigned inside a
  // `try` evolves from an implicit `any`, and the bytes below would then be
  // read off an unchecked value. The store's `Buffer` satisfies `Uint8Array`.
  let read: Result<Uint8Array>;

  try {
    const recorded = await backups.readRecorded(record.backupPath, record.originalHash);

    read = isErr(recorded) ? recorded : ok(recorded.value.bytes);
  } catch (error) {
    return {
      state: {
        available: false,
        path: record.backupPath,
        reason: 'unreadable',
        detail: errnoCodeOf(error) ?? 'unknown',
      },
    };
  }

  if (isErr(read)) {
    const storeReason = storeReasonOf(read.error);

    // The store's own vocabulary, mapped onto the verdict's: nothing there is
    // `missing`, and a stored file that fails its own name is the same
    // `digest-mismatch` the hash below detects — it was read, it is simply not
    // the original — rather than `unreadable`.
    return {
      state: {
        available: false,
        path: record.backupPath,
        reason:
          storeReason === 'backup-missing'
            ? 'missing'
            : storeReason === 'stored-digest-mismatch'
              ? 'digest-mismatch'
              : 'unreadable',
        detail: storeReason ?? read.error.code,
      },
    };
  }

  const digest = files.hashBytes(read.value);

  if (digest !== record.originalHash) {
    logger.warn('a backup does not hash to the digest it is filed under', {
      recordId: record.id,
      sessionId: record.sessionId,
      backupPath: record.backupPath,
      expectedHash: record.originalHash,
      actualHash: digest,
    });

    return {
      state: {
        available: false,
        path: record.backupPath,
        reason: 'digest-mismatch',
        detail: digest,
      },
    };
  }

  return {
    state: {
      available: true,
      path: record.backupPath,
      byteLength: read.value.byteLength,
    },
    bytes: read.value,
  };
}

// ---------------------------------------------------------------------------
// Composing a report.
// ---------------------------------------------------------------------------

/** What {@link composeConflictParts} needs to build one report. */
interface ConflictCompositionInput {
  /**
   * The branch of the reconciliation table that was taken.
   *
   * `'restore-verification-failed'` is excluded: it describes the result of a
   * write, and this module performs none. `../cleanup.ts` reaches it through
   * {@link buildConflictReport} instead.
   */
  readonly reason: Exclude<ModificationConflictReason, 'restore-verification-failed'>;

  /** The record being judged. */
  readonly record: ModificationRecord;

  /** The detection time carried onto the report. */
  readonly detectedAt: number;

  /** The file's current digest, absent when the file is not there. */
  readonly actualHash?: string | undefined;

  /** The backup state, which decides how the default message reads. */
  readonly backup: BackupState;

  /** The verified original's bytes, when they could be read. */
  readonly backupBytes?: Uint8Array | undefined;

  /** The file's current bytes, when it is there. */
  readonly currentBytes?: Uint8Array | undefined;

  /**
   * The chained record's pristine original, when a usable chain root was
   * supplied. Present, it replaces the record's own backup as the "original"
   * of the views and of the default message's backup sentence.
   */
  readonly root?: ChainRootOriginal | undefined;

  /** The caller's message, if it authored one. Blank counts as absent. */
  readonly message?: string | undefined;

  /** The injected hasher, used to verify the reconstructed instrumented text. */
  readonly files: ConflictFileReader;

  /** Where to log. */
  readonly logger: Logger;
}

/**
 * Builds the report and the omission list a conflicting verdict carries.
 *
 * Composition never fails the detection: if the assembled report does not
 * satisfy its schema — which would be a defect in this module or a malformed
 * record — the failure is logged and a minimal report is attempted, so a
 * conflict is not downgraded into silence. Only when even that cannot be
 * validated does an `Err` come back, and the file and the backup are still
 * exactly as they were.
 */
function composeConflictParts(
  input: ConflictCompositionInput,
): Result<ConflictingVerdictParts, DebuggenError> {
  const sides = gatherDiffSides(input);
  const composed = composeDiffViews(input.record, sides, input.root !== undefined);
  const message = firstNonBlank(input.message) ?? composeDefaultMessage(input, composed.omissions);
  const chainRoot = input.root?.record;

  const report = buildConflictReport({
    record: input.record,
    reason: input.reason,
    detectedAt: input.detectedAt,
    ...(input.actualHash === undefined ? {} : { actualHash: input.actualHash }),
    message,
    ...(composed.diffs === undefined ? {} : { diffs: composed.diffs }),
    chainRoot,
  });

  if (!isErr(report)) {
    return ok({
      conflict: report.value,
      omittedDiffs: omissionsFor(report.value.diffs, composed.omissions),
    });
  }

  input.logger.error('a composed conflict report failed validation; retrying without its diffs', {
    recordId: input.record.id,
    sessionId: input.record.sessionId,
    reason: input.reason,
    code: report.error.code,
  });

  const minimal = buildConflictReport({
    record: input.record,
    reason: input.reason,
    detectedAt: input.detectedAt,
    ...(input.actualHash === undefined ? {} : { actualHash: input.actualHash }),
    message: composeDefaultMessage(input, composed.omissions),
    chainRoot,
  });

  if (isErr(minimal)) {
    return minimal;
  }

  return ok({
    conflict: minimal.value,
    omittedDiffs: omissionsFor(minimal.value.diffs, composed.omissions),
  });
}

/** One side of a view: its text, or the reason there is none. */
type DiffText =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'unavailable'; readonly reason: ConflictDiffOmissionReason };

/** The three texts the views are composed from. */
interface DiffSides {
  /**
   * The pristine file: the record's own verified backup, or — for a chained
   * record with a usable root — the root's verified backup.
   */
  readonly original: DiffText;

  /** What the tool wrote, reconstructed and hash-verified. */
  readonly instrumented: DiffText;

  /** The file as it stands now. */
  readonly current: DiffText;
}

/**
 * Obtains the three texts, or the reason each one is unobtainable.
 *
 * The instrumented text is the interesting case: it is no longer on disk once a
 * developer has edited over it, and no amount of reading recovers it. It is
 * therefore reconstructed by applying the record's own diff to the record's own
 * verified backup — except when the file still holds the instrumented content,
 * where the current text *is* the instrumented text and no reconstruction is
 * needed.
 *
 * The original is the record's own backup for an unchained record. For a
 * chained one it is the chain root's, and only the chain root's: the record's
 * own backup is the previous plan version's instrumented output, so a root
 * backup that cannot be read back or verified leaves the original unavailable
 * rather than falling back to bytes that would present the tool's wrapper as
 * the developer's file.
 */
function gatherDiffSides(input: ConflictCompositionInput): DiffSides {
  const recorded = textOf(input.backupBytes);
  const current = textOf(input.currentBytes);
  const original = input.root === undefined ? recorded : textOf(input.root.inspection.bytes);

  const instrumented =
    input.actualHash !== undefined && input.actualHash === input.record.instrumentedHash
      ? current
      : reconstructInstrumented(recorded, input);

  return { original, instrumented, current };
}

/**
 * Reconstructs the instrumented text from the verified original and the
 * record's diff, and accepts it **only** if it hashes to `instrumentedHash`.
 *
 * `autoConvertLineEndings` is turned off and `fuzzFactor` left at its default
 * `0`, so the reconstruction is exact or it is nothing: a patch applied with
 * line endings silently converted, or fitted with mismatched context, would
 * produce a plausible text that never existed. The hash check is the proof, and
 * a reconstruction that fails it is discarded rather than shown.
 */
function reconstructInstrumented(original: DiffText, input: ConflictCompositionInput): DiffText {
  if (original.kind === 'unavailable') {
    return original;
  }

  const recorded = firstNonBlank(input.record.diff);
  if (recorded === undefined) {
    return { kind: 'unavailable', reason: 'text-unavailable' };
  }

  const applied = applyPatch(original.text, recorded, {
    fuzzFactor: 0,
    autoConvertLineEndings: false,
  });

  if (applied === false) {
    return { kind: 'unavailable', reason: 'text-unavailable' };
  }

  const bytes = new TextEncoder().encode(applied);

  if (bytes.byteLength > CONFLICT_DIFF_INPUT_BYTE_LIMIT) {
    return { kind: 'unavailable', reason: 'input-too-large' };
  }

  if (input.files.hashBytes(bytes) !== input.record.instrumentedHash) {
    input.logger.debug('the instrumented text could not be reconstructed from the recorded diff', {
      recordId: input.record.id,
      sessionId: input.record.sessionId,
      file: input.record.file,
    });

    return { kind: 'unavailable', reason: 'text-unavailable' };
  }

  return { kind: 'text', text: applied };
}

/**
 * Composes the three views, preferring the record's own diff for the view it
 * already is.
 *
 * `originalToInstrumented` is exactly what the patcher recorded, produced over
 * the bytes it hashed, so it is used verbatim when it fits the cap; only when it
 * does not is a fresh patch rendered from the two texts, whose narrower context
 * may fit where the recorded one did not.
 *
 * A chained record's own diff starts from the previous plan version's output,
 * so it is **never** used when the original is the chain root's: the view is
 * always rendered from the root's text to the instrumented text, and omitted
 * when either cannot be had.
 *
 * @param record The record the views describe.
 * @param sides The three texts.
 * @param fromChainRoot Whether `sides.original` is the chain root's backup
 * rather than the record's own.
 */
function composeDiffViews(
  record: ModificationRecord,
  sides: DiffSides,
  fromChainRoot: boolean,
): { readonly diffs: ConflictDiffs | undefined; readonly omissions: ConflictDiffOmission[] } {
  const diffs: ConflictDiffs = {};
  const omissions: ConflictDiffOmission[] = [];

  const recorded = fromChainRoot ? undefined : firstNonBlank(record.diff);

  if (recorded !== undefined && recorded.length <= CONFLICT_DIFF_CHARACTER_LIMIT) {
    diffs.originalToInstrumented = recorded;
  } else {
    const rendered = renderView(
      record.file,
      sides.original,
      sides.instrumented,
      DIFF_LABELS.original,
      DIFF_LABELS.instrumented,
    );

    if (rendered.kind === 'text') {
      diffs.originalToInstrumented = rendered.text;
    } else {
      omissions.push({
        view: 'originalToInstrumented',
        // A recorded diff that was too long is the more useful truth than
        // whatever stopped the recomputation from standing in for it.
        reason: recorded === undefined ? rendered.reason : 'exceeds-length-limit',
      });
    }
  }

  const instrumentedToCurrent = renderView(
    record.file,
    sides.instrumented,
    sides.current,
    DIFF_LABELS.instrumented,
    DIFF_LABELS.current,
  );

  if (instrumentedToCurrent.kind === 'text') {
    diffs.instrumentedToCurrent = instrumentedToCurrent.text;
  } else {
    omissions.push({ view: 'instrumentedToCurrent', reason: instrumentedToCurrent.reason });
  }

  const originalToCurrent = renderView(
    record.file,
    sides.original,
    sides.current,
    DIFF_LABELS.original,
    DIFF_LABELS.current,
  );

  if (originalToCurrent.kind === 'text') {
    diffs.originalToCurrent = originalToCurrent.text;
  } else {
    omissions.push({ view: 'originalToCurrent', reason: originalToCurrent.reason });
  }

  const present = CONFLICT_DIFF_VIEWS.some((view) => diffs[view] !== undefined);

  return { diffs: present ? diffs : undefined, omissions };
}

/**
 * Renders one view as a unified diff, or says why it cannot be rendered.
 *
 * `ignoreWhitespace` and `stripTrailingCr` are left at their defaults
 * (`false`): the verdict came from a digest over raw bytes, and a patch that
 * hid whitespace or line-ending differences would contradict the very
 * comparison it is there to explain — a trailing newline or an LF-to-CRLF
 * conversion is a real change and has to read as one.
 */
function renderView(
  file: string,
  from: DiffText,
  to: DiffText,
  fromLabel: string,
  toLabel: string,
): DiffText {
  if (from.kind === 'unavailable') {
    return from;
  }

  if (to.kind === 'unavailable') {
    return to;
  }

  if (from.text === to.text) {
    return { kind: 'unavailable', reason: 'no-differences' };
  }

  // The abortable overloads of `createTwoFilesPatch` - the ones selected by a
  // `timeout` or `maxEditLength` option - may answer `undefined`. None is used
  // here, so the call is typed as returning a string; the guard states that
  // rather than asserting it away, and costs one comparison.
  const patch: string | undefined = createTwoFilesPatch(
    file,
    file,
    from.text,
    to.text,
    fromLabel,
    toLabel,
    { context: CONFLICT_DIFF_CONTEXT_LINES },
  );

  if (patch === undefined) {
    return { kind: 'unavailable', reason: 'text-unavailable' };
  }

  if (patch.length > CONFLICT_DIFF_CHARACTER_LIMIT) {
    return { kind: 'unavailable', reason: 'exceeds-length-limit' };
  }

  return { kind: 'text', text: patch };
}

/**
 * Decodes bytes as UTF-8 for diffing, or says why they cannot be diffed.
 *
 * Strict decoding, so content that is not valid UTF-8 is refused rather than
 * silently peppered with replacement characters: the verdict is unaffected
 * (hashing is byte-based), but a patch over lossily decoded bytes would
 * describe lines that do not exist in the file. The size bound is applied first,
 * because decoding is the expensive half.
 */
function textOf(bytes: Uint8Array | undefined): DiffText {
  if (bytes === undefined) {
    return { kind: 'unavailable', reason: 'text-unavailable' };
  }

  if (bytes.byteLength > CONFLICT_DIFF_INPUT_BYTE_LIMIT) {
    return { kind: 'unavailable', reason: 'input-too-large' };
  }

  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { kind: 'unavailable', reason: 'not-utf8' };
  }
}

/**
 * Derives the omission list from the report that is actually being delivered.
 *
 * Read off the delivered `diffs` rather than off the composition, so the list
 * cannot claim a view is present when the report does not carry it — including
 * on the fallback path, where a view that was composed did not survive
 * validation and is reported as unavailable, which is what it is to a reader of
 * that report.
 */
function omissionsFor(
  diffs: ConflictDiffs | undefined,
  composed: readonly ConflictDiffOmission[],
): readonly ConflictDiffOmission[] {
  return CONFLICT_DIFF_VIEWS.filter((view) => diffs?.[view] === undefined).map((view) => ({
    view,
    reason: composed.find((omission) => omission.view === view)?.reason ?? 'text-unavailable',
  }));
}

/**
 * Composes the factual default message: what was observed, and where the
 * original is.
 *
 * Deliberately not the developer-facing sentence of AAP §0.5.5 — that wording,
 * with its recovery action, belongs to the service and the adapters, which can
 * offer "Open diff" alongside it and know what the developer was doing. This
 * text exists so that a report can never reach a user interface blank, and it
 * says only what this module observed: the file, the fate of the backup, and
 * whether a view had to be left out for size.
 *
 * Composed twice when it has to be. A backup path may be four kilobytes on its
 * own, well past the field's own bound, so the path-bearing form is tried first
 * and a path-free form replaces it when the result would not fit. The path is
 * on the report as a field regardless, which is where a user interface reads it
 * from anyway.
 *
 * For a chained record with a usable root, the two reasons whose headline is
 * about the file — `'content-changed'` and `'file-missing'` — say where the
 * **pristine** original is: the root's backup, and what reading it back found.
 * `'backup-missing'` and `'backup-corrupt'` are about the record's own backup
 * and keep describing it.
 */
function composeDefaultMessage(
  input: ConflictCompositionInput,
  omissions: readonly ConflictDiffOmission[],
): string {
  const file = input.record.file;
  const backup = input.backup;
  const pristine =
    input.root === undefined
      ? { backup, subject: 'The recorded original' }
      : {
          backup: input.root.inspection.state,
          subject: 'The original from before this file was first instrumented',
        };

  const oversized = omissions
    .filter((omission) => omission.reason === 'exceeds-length-limit')
    .map((omission) => omission.view);

  const sizeClause =
    oversized.length === 0
      ? ''
      : ` The ${oversized.join(' and ')} ${oversized.length === 1 ? 'view' : 'views'} exceeded the ${CONFLICT_DIFF_CHARACTER_LIMIT}-character limit and ${oversized.length === 1 ? 'was' : 'were'} omitted rather than shortened.`;

  const compose = (withPath: boolean): string => {
    const where = withPath ? ` at '${backup.path}'` : " in this session's backup directory";
    const pristineWhere = withPath
      ? ` at '${pristine.backup.path}'`
      : " in this session's backup directory";
    const pristineFate = backupFate(pristine.backup, pristineWhere, pristine.subject);

    if (input.reason === 'file-missing') {
      return `'${file}' is no longer present, so this modification could not be reverted and nothing was written. ${pristineFate}${sizeClause}`;
    }

    if (input.reason === 'backup-corrupt') {
      return `'${file}' still holds the content this tool wrote, but the recorded original${where} no longer hashes to the digest it was filed under, so it cannot be trusted and nothing was written to it. The backup was kept for inspection.${sizeClause}`;
    }

    if (input.reason === 'backup-missing') {
      const why = backup.available ? 'unknown' : unavailableDetail(backup);

      return `'${file}' still holds the content this tool wrote, but the recorded original could not be read back${where} (${why}), so nothing was written to it.${sizeClause}`;
    }

    return `'${file}' was changed after it was instrumented, so nothing was written to it. ${pristineFate}${sizeClause}`;
  };

  const withPath = compose(true);

  return withPath.length <= CONFLICT_MESSAGE_CHARACTER_LIMIT ? withPath : compose(false);
}

/**
 * The sentence that says what became of the recorded original, for a report
 * whose headline is about the file rather than the backup.
 *
 * Three different facts, worded as three: the original is retained; it is
 * there but no longer hashes to the digest it was filed under, so it cannot be
 * trusted; or it could not be read back at all, with the reason and — where it
 * adds something — the errno or store reason behind it.
 *
 * @param backup The state of the backup the sentence is about: the record's
 * own, or a chained record's root.
 * @param where Where the original is, as the caller's path-bearing or path-free
 * form words it.
 * @param subject How the sentence names that original — "The recorded
 * original" for the record's own backup, or the wording that makes plain a
 * chain root's backup is the pristine file.
 * @returns One sentence.
 */
function backupFate(backup: BackupState, where: string, subject: string): string {
  if (backup.available) {
    return `${subject} is retained${where}.`;
  }

  if (backup.reason === 'digest-mismatch') {
    return `${subject}${where} no longer hashes to the digest it was filed under, so it cannot be trusted; it was kept for inspection.`;
  }

  return `${subject} could not be read back${where} (${unavailableDetail(backup)}).`;
}

/**
 * Why an unavailable backup could not be read back, as the parenthesis of a
 * message: the {@link BackupUnavailableReason}, followed by its `detail` where
 * the detail is an errno or an enumerated store reason that adds something.
 *
 * The detail of a `digest-mismatch` is the digest the bytes hashed to, which
 * says nothing a developer can act on and describes content, so it never
 * reaches a message; nor does a `missing` backup's, which only restates the
 * reason.
 *
 * @param backup An unavailable backup's state.
 * @returns The parenthesised text, without the parentheses.
 */
function unavailableDetail(backup: Extract<BackupState, { available: false }>): string {
  if (
    backup.detail !== undefined &&
    (backup.reason === 'unreadable' || backup.reason === 'unusable-path')
  ) {
    return `${backup.reason}: ${backup.detail}`;
  }

  return backup.reason;
}

/**
 * Drops any view past {@link CONFLICT_DIFF_CHARACTER_LIMIT}, and answers
 * `undefined` when nothing is left.
 *
 * Applied to every report, including one composed elsewhere, because the bound
 * belongs to the transport rather than to the producer: a `cleanup.completed`
 * frame with three unbounded patches in it is a frame neither user interface
 * can render. A blank view is dropped too — an empty string says nothing that
 * an absent member does not say better.
 */
function boundDiffs(diffs: ConflictDiffs): ConflictDiffs | undefined {
  const bounded: ConflictDiffs = {};

  for (const view of CONFLICT_DIFF_VIEWS) {
    const patch = diffs[view];

    if (patch !== undefined && patch.length > 0 && patch.length <= CONFLICT_DIFF_CHARACTER_LIMIT) {
      bounded[view] = patch;
    }
  }

  return CONFLICT_DIFF_VIEWS.some((view) => bounded[view] !== undefined) ? bounded : undefined;
}

/**
 * Clips `text` to `limit` characters, appending an ellipsis and never splitting
 * a surrogate pair.
 *
 * A lone surrogate is not valid text: it survives a SQLite round-trip and a
 * JSON frame as a replacement character at best, and is rejected outright by
 * strict decoders at worst. One extra character is dropped instead.
 */
function clipToLimit(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  const ellipsis = '…';
  const cut = limit - ellipsis.length;
  const lastCode = cut > 0 ? text.charCodeAt(cut - 1) : 0;
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;

  return `${text.slice(0, Math.max(0, isHighSurrogate ? cut - 1 : cut))}${ellipsis}`;
}

/**
 * The value when it holds something other than whitespace, and `undefined`
 * otherwise.
 *
 * Returns the value **untrimmed**: it is used on a recorded unified diff as
 * well as on a message, and trimming a patch would move its first hunk header
 * onto the wrong line and make it unapplicable.
 */
function firstNonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * Reads the clock, refusing a reading a report could not carry.
 *
 * The detection time is validated as a finite positive epoch-millisecond number
 * by the conflict schema, so an injected clock returning `0`, `NaN` or a
 * negative number would fail validation far from its cause. Substituting the
 * system clock and saying so keeps the diagnostic next to the mistake.
 */
function resolveDetectedAt(now: (() => number) | undefined, logger: Logger): number {
  if (now === undefined) {
    return nowEpochMs();
  }

  const reading = now();

  if (Number.isFinite(reading) && reading > 0) {
    return reading;
  }

  logger.warn('an injected clock returned an unusable reading; using the system clock', {
    reading,
  });

  return nowEpochMs();
}

/**
 * The `code` of a caught value, when it carries a string one.
 *
 * `catch` binds `unknown`, and the only reason this module inspects a caught
 * error is to tell the conditions it has an opinion about — "nothing is there"
 * (`ENOENT`) and "a link is planted at the path" (`ELOOP`) — apart from every
 * other failure, which is reported with its errno intact. Written the same way
 * as its counterparts in `./backup-store.ts` and `@debuggen/shared/node`,
 * because a second, subtly different reading of `error.code` is how one of them
 * starts misclassifying a refusal as a success.
 */
function errnoCodeOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code: unknown = value.code;

    return typeof code === 'string' ? code : undefined;
  }

  return undefined;
}

/**
 * The enumerated `details.reason` a backup-store error carries, when it carries
 * one.
 *
 * The store documents that vocabulary precisely so a caller can branch on it
 * without parsing a message; this reads it defensively, because `details` is an
 * open record of `unknown` values.
 */
function storeReasonOf(error: DebuggenError): string | undefined {
  const reason: unknown = error.details?.reason;

  return typeof reason === 'string' ? reason : undefined;
}

/**
 * The error for a backup store that belongs to a different session: code
 * `STORE_ERROR`.
 *
 * Refused rather than worked around. A store scoped to another session composes
 * its paths under `<debuggenHome>/backups/<other session>/…`, so every lookup
 * would miss, an intact backup would be reported as missing, and a perfectly
 * restorable record would be reported as a conflict — the one failure mode that
 * turns this module's caution into a false alarm. `STORE_ERROR` rather than
 * `INTERNAL`: it names which collaborator was wrong.
 */
function backupStoreSessionMismatch(
  record: ModificationRecord,
  storeSessionId: string,
): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The backup store handed to conflict detection belongs to a different session.',
    {
      hint: "Pass the backup store for the record's own session; backups are filed per session.",
      details: {
        reason: 'backup-store-session-mismatch',
        recordId: record.id,
        recordSessionId: record.sessionId,
        storeSessionId,
      },
    },
  );
}
