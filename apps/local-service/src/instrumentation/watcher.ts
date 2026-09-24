/**
 * The live conflict detector for instrumented files: the observer half of the
 * "reversible and recorded file changes" guarantee (AAP §0.5.1, §0.10).
 *
 * While a session holds applied instrumentation, this module watches every file
 * the installer patched. The moment the developer edits one, it recomputes the
 * file's raw-byte SHA-256, and when the digest no longer equals the journal's
 * `instrumentedHash` it moves that modification record from `applied` to
 * `conflict` and tells both user interfaces — so the product never overwrites
 * work it did not write:
 *
 * ```text
 * ‹file› was edited while instrumented. Debug Generator will not overwrite it.
 * Original saved at ‹backup path›.                      [Open diff]  (AAP §0.5.5)
 * ```
 *
 * ## What this module may change, which is almost nothing
 *
 * It **never writes, renames, truncates, restores or deletes any file** — not in
 * the developer's project, not in `$DEBUGGEN_HOME`, not a backup. It reads bytes
 * and asks questions. Its one permitted mutation anywhere in the system is a
 * single journal status transition, `applied → conflict`, through
 * `ModificationsRepo.updateStatus`. Restoration belongs to
 * `apps/local-service/src/cleanup/cleanup.ts`; this module merely makes sure
 * cleanup finds the record already marked, and makes sure the developer learns
 * about the edit when it happens rather than when the session ends.
 *
 * ## One decision procedure, shared with cleanup
 *
 * The verdict and the three-way report come from `detectConflict` in
 * `@debuggen/instrumentation` — the same read-only procedure cleanup and the
 * patcher use — so the watcher and cleanup can never disagree about a file.
 * The rule for *whether* to report is AAP §0.5.1's literal one: any current
 * digest other than the chain head's `instrumentedHash` is a conflict,
 * including the developer restoring the original bytes by hand. The verdict
 * only chooses the precise reason and the wording of the second line.
 *
 * ## The watch strategy
 *
 * - **Directories, not files.** Editors and formatters save atomically — write a
 *   temporary file beside the target, then rename it over the target. A watch
 *   on the file holds the replaced inode and goes deaf after the first such
 *   save, so this module watches each instrumented file's parent directory
 *   (`persistent: false`, `recursive: false`) and filters events by basename,
 *   treating `change` and `rename` identically.
 * - **One handle per directory**, reference-counted across every watched file in
 *   it (and across sessions of this watcher), closed as soon as its last file is
 *   released.
 * - **Chain heads only.** A follow-up plan version layers a new record over an
 *   earlier one for the same file; only the newest record's `instrumentedHash`
 *   describes the bytes on disk, so one entry per file is kept — the head from
 *   `latestRecordForFile` — and an older link is never evaluated.
 * - **Containment and no symbolic links.** Every `record.file` is resolved
 *   inside the session's project root with `resolveWithinProject`, and every
 *   directory between the root and the watched directory must be a real
 *   directory (checked with `lstat`, never followed). A refusal is recorded as
 *   a {@link WatchIssue}, never thrown.
 * - **Per-file debounce** coalesces an editor's write burst into one
 *   evaluation; timers are `unref()`ed and cleared on every stop, so nothing
 *   keeps the process or a test worker alive.
 *
 * ## The self-write contract with `./service.ts`
 *
 * The installer's first patch write is naturally a no-op here (the file hashes
 * to the record's `instrumentedHash`). A *follow-up delta* install is not: it
 * rewrites an already-instrumented file to a **new** digest while the watched
 * chain head still names the old one, which would look exactly like a developer
 * edit. The caller therefore brackets every install:
 *
 * ```ts
 * watcher.suspend(sessionId);          // 1. before installPlan
 * const installed = await installPlan(…);
 * await watcher.refresh(sessionId);    // 2. rebuild the watch set from the journal
 * watcher.resume(sessionId);           // 3. re-evaluate every watched file once
 * ```
 *
 * While suspended nothing is queued and nothing is evaluated; an evaluation
 * already in flight is abandoned before it can mutate anything.
 *
 * ## Privacy
 *
 * Log records and notices carry project-relative paths, record ids, statuses,
 * reasons and error codes only — never file content, a diff, a digest or a
 * backup path in a log line (AAP §0.5.2). The developer-facing sentence names
 * the backup path because AAP §0.5.5 requires it to.
 *
 * ## Layering
 *
 * Imports `@debuggen/{instrumentation,protocol,shared}`, `@debuggen/shared/node`,
 * `node:fs` and this workspace's config, logging, progress and store modules.
 * It never imports `./service.js` or `./readiness.js` (the service imports this
 * module), and never the session manager: session-record updates travel through
 * the injected {@link ModificationConflictListener}.
 *
 * @module
 */

import { promises as fsPromises, watch as nodeWatch } from 'node:fs';

import {
  buildConflictReport,
  createBackupStore,
  detectConflict,
  isConflictVerdict,
} from '@debuggen/instrumentation';
import type {
  BackupStore,
  ModificationConflict,
  ModificationConflictReason,
  ModificationRecord,
} from '@debuggen/instrumentation';
import type { ProgressStage, ProgressStatus } from '@debuggen/protocol';
import {
  DebuggenError,
  basenamePosix,
  dirnamePosix,
  err,
  isErr,
  noopLogger,
  nowEpochMs,
  ok,
  resolveWithinProject,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result } from '@debuggen/shared';
import { sha256OfFile } from '@debuggen/shared/node';

import type { ServiceConfig } from '../config.js';
import { LOG_BINDING_KEYS, subsystemLogger } from '../logging.js';
import type { SessionProgress } from '../sessions/progress.js';
import type { ModificationsRepo } from '../store/modifications-repo.js';

// ---------------------------------------------------------------------------
// Section A — constants
// ---------------------------------------------------------------------------

/**
 * How long, in milliseconds, a file must stay quiet after an event before it is
 * evaluated.
 *
 * Long enough to coalesce the burst an editor produces for one save (truncate,
 * write, fsync, rename, attribute change), short enough that the conflict
 * notice appears while the developer is still looking at the file. Overridable
 * per watcher through {@link InstrumentationWatcherDeps.debounceMs}.
 */
export const DEFAULT_CONFLICT_DEBOUNCE_MS = 200;

/**
 * The progress stage a conflict row is filed under: the stage that owns
 * modifications, which is where both user interfaces list them.
 */
const CONFLICT_PROGRESS_STAGE: ProgressStage = 'instrument';

/**
 * The progress status of a conflict row: `running`, **not** `failed`. The
 * session has not failed — the developer simply has a file the product will
 * leave alone — and a `failed` row would be rendered as a failing stage.
 */
const CONFLICT_PROGRESS_STATUS: ProgressStatus = 'running';

/**
 * The bound `session.progress` applies to a row's `message`. A conflict
 * sentence reaches it only with a pathological backup path; clipping keeps the
 * row deliverable instead of letting the schema refuse it.
 */
const PROGRESS_MESSAGE_LIMIT = 2_000;

/**
 * The bound `session.progress` applies to a row's `detail`.
 */
const PROGRESS_DETAIL_LIMIT = 4_000;

/**
 * The most runtime issues kept per session between two rebuilds, so a
 * flapping watch cannot grow the list without bound.
 */
const MAX_RUNTIME_ISSUES_PER_SESSION = 100;

/**
 * How long {@link InstrumentationWatcher.stopSession} waits for evaluations
 * already in flight before it returns anyway. Every evaluation re-checks that
 * its session is live before mutating, so an evaluation still running after
 * this bound can no longer transition a record; the wait only lets a
 * notification that follows an already-committed transition finish.
 */
const STOP_DRAIN_TIMEOUT_MS = 5_000;

/** The options every directory watch is opened with. */
const WATCH_OPTIONS: WatchOptionsLike = Object.freeze({ persistent: false, recursive: false });

/** The `subsystem` binding of every log record from this module. */
const LOG_SUBSYSTEM = 'instrumentation';

/** The `component` binding that tells this module's records from its siblings'. */
const LOG_COMPONENT = 'watcher';

/** The errno codes that mean "nothing is there". */
const MISSING_ERRNO_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

// ---------------------------------------------------------------------------
// Section B — ports
// ---------------------------------------------------------------------------

/** The options {@link WatchLike} is called with: never persistent, never recursive. */
export interface WatchOptionsLike {
  /** Always `false`: a watch must never keep the service process alive. */
  readonly persistent: false;
  /** Always `false`: one directory, filtered by basename. */
  readonly recursive: false;
}

/**
 * The listener {@link WatchLike} delivers events to — `fs.watch`'s own shape.
 *
 * `eventType` is `'change'` or `'rename'` from Node and is treated the same
 * either way; `filename` is the entry's basename, or `null` on a platform that
 * could not name it, in which case every watched file in the directory is
 * evaluated.
 */
export type WatchListenerLike = (eventType: string, filename: string | null) => void;

/** The part of `fs.FSWatcher` this module uses. */
export interface WatchHandleLike {
  /** Stops the watch. Called exactly once per handle. */
  close(): void;
  /**
   * Subscribes to the handle's `error` event (the directory vanished, the
   * platform revoked the watch). An unhandled `error` would crash the process,
   * so this module always subscribes.
   */
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * Opens a directory watch: `fs.watch` in production, a synthetic event source
 * in a suite that wants to drive events by hand.
 *
 * May throw synchronously — `ENOENT` when the directory is gone, `ENOSPC` when
 * the platform's watch budget is exhausted — which is caught per directory and
 * recorded as a {@link WatchIssue}.
 */
export type WatchLike = (
  directory: string,
  options: WatchOptionsLike,
  listener: WatchListenerLike,
) => WatchHandleLike;

/**
 * The journal methods this module reads and the one it writes through.
 *
 * A structural subset of {@link ModificationsRepo}, so the service passes its
 * repository straight in and a suite can hand in an in-memory double.
 */
export type WatcherModifications = Pick<
  ModificationsRepo,
  'listBySession' | 'latestRecordForFile' | 'get' | 'updateStatus'
>;

/**
 * How a developer's change presented itself, which chooses the wording of the
 * notice's second line (the journal reason alone cannot tell the first two
 * apart).
 *
 * - `content-changed` — the file holds bytes that are neither what the tool
 *   wrote nor the original.
 * - `reverted-to-original` — the developer restored the original bytes by
 *   hand. Still a conflict under AAP §0.5.1's literal rule: the product did not
 *   write those bytes and will not touch them.
 * - `file-missing` — the file was deleted, moved or renamed away.
 * - `not-a-regular-file` — something other than a regular file (a symbolic
 *   link, a directory) now stands at the path.
 */
export type ConflictObservation =
  'content-changed' | 'reverted-to-original' | 'file-missing' | 'not-a-regular-file';

/**
 * The developer-facing notice for one conflict: the AAP §0.5.5 sentence, its
 * "Open diff" action, and what the action needs to find the stored diff
 * (`GET /sessions/:id/modifications` serves it by record id).
 */
export interface ConflictNotice {
  /** The sentence, from {@link buildConflictMessage}. */
  readonly message: string;
  /** The second line: how the change presented itself and where the diff is. */
  readonly detail: string;
  /** The recovery action both user interfaces offer beside the sentence. */
  readonly action: 'open-diff';
  /** The modification record the conflict is about. */
  readonly recordId: string;
  /** The conflicting file, project-relative POSIX. */
  readonly file: string;
  /** Where the original bytes are kept. Never deleted by this module. */
  readonly backupPath: string;
  /** The journal's reason, from `MODIFICATION_CONFLICT_REASONS`. */
  readonly reason: ModificationConflict['reason'];
  /** How the change presented itself; see {@link ConflictObservation}. */
  readonly observation: ConflictObservation;
  /** Whether the saved original was read back and verified against its digest. */
  readonly backupVerified: boolean;
}

/**
 * Receives every conflict this module reports, after the journal transition
 * has been committed.
 *
 * A consumer-declared structural port: `./service.ts` (or `src/main.ts`) wires
 * it to the session manager so the session record's modification list and
 * `cleanup.conflicts` reflect the conflict and a `session.updated` reaches both
 * user interfaces. This module never imports the manager to do that itself.
 * A rejection or a throw is caught and logged; it never escapes the watcher.
 */
export interface ModificationConflictListener {
  onModificationConflict(input: {
    /** The session that owns the record. */
    readonly sessionId: string;
    /** The record as the journal now holds it: status `conflict`. */
    readonly record: ModificationRecord;
    /** The schema-valid report, including the bounded three-way diff. */
    readonly conflict: ModificationConflict;
    /** The developer-facing notice. */
    readonly notice: ConflictNotice;
  }): void | Promise<void>;
}

/**
 * Everything {@link createInstrumentationWatcher} is given; all of it is
 * injected, and nothing is read from the environment.
 */
export interface InstrumentationWatcherDeps {
  /** The modification journal: `ModificationsRepo` in production. */
  readonly modifications: WatcherModifications;
  /**
   * Where the conflict row goes. `SessionProgress` persists each row before
   * broadcasting it, which is what makes the notice survive a session reopen.
   * Absent in contexts that only need the journal transition.
   */
  readonly progress?: Pick<SessionProgress, 'emit'> | undefined;
  /** Receives the structured conflict; see {@link ModificationConflictListener}. */
  readonly listener?: ModificationConflictListener | undefined;
  /** The resolved state root, where each session's backup store lives. */
  readonly config: Pick<ServiceConfig, 'debuggenHome'>;
  /** The service logger; defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;
  /** The epoch-millisecond clock for `detectedAt`; defaults to `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
  /**
   * The per-file quiet period before an evaluation, in milliseconds; defaults
   * to {@link DEFAULT_CONFLICT_DEBOUNCE_MS}. A value that is not a finite,
   * non-negative number is replaced by the default.
   */
  readonly debounceMs?: number | undefined;
  /** The directory-watch primitive; defaults to `fs.watch`. */
  readonly watch?: WatchLike | undefined;
  /**
   * Builds the read-only backup store `detectConflict` reads the original back
   * through. Defaults to `createBackupStore({ debuggenHome, sessionId })`.
   */
  readonly backupStoreFor?: ((sessionId: string) => BackupStore) | undefined;
}

// ---------------------------------------------------------------------------
// Section C — the watcher's public surface
// ---------------------------------------------------------------------------

/** One file under watch: the chain head the file's bytes are compared with. */
export interface WatchedFile {
  /** The session that owns the record. */
  readonly sessionId: string;
  /** The chain-head record the file is compared with. */
  readonly recordId: string;
  /** The file, project-relative POSIX, exactly as the record spells it. */
  readonly file: string;
  /** The file's absolute POSIX path, resolved inside the project root. */
  readonly absolutePath: string;
  /** The digest the file must keep: the chain head's `instrumentedHash`. */
  readonly instrumentedHash: string;
  /** The plan version that installed the chain head. */
  readonly planVersion: number;
}

/**
 * Why a file of a session is not (or no longer) being watched, or could not be
 * judged. Degradation is reported, never hidden: every issue is also logged at
 * `warn`.
 *
 * - `outside-project` — the record's path escapes the project root.
 * - `unsafe-path` — a symbolic link (or a non-directory) stands between the
 *   project root and the file's directory, so nothing is watched through it.
 * - `directory-missing` — the file's directory is gone; the file is evaluated
 *   once, which reports it missing.
 * - `watch-failed` — the platform refused the directory watch (`ENOSPC`, …).
 * - `watch-lost` — an established watch reported an error and was closed.
 * - `journal-unreadable` — the journal could not answer for this file.
 * - `file-unreadable` — the file exists but could not be read, so no decision
 *   was made about it.
 */
export type WatchIssueKind =
  | 'outside-project'
  | 'unsafe-path'
  | 'directory-missing'
  | 'watch-failed'
  | 'watch-lost'
  | 'journal-unreadable'
  | 'file-unreadable';

/** One recorded {@link WatchIssueKind}, as data. */
export interface WatchIssue {
  /** The session the issue belongs to. */
  readonly sessionId: string;
  /** The record concerned, when one is. */
  readonly recordId?: string;
  /** The project-relative file concerned. */
  readonly file: string;
  /** What went wrong. */
  readonly kind: WatchIssueKind;
  /** The closed-vocabulary code, e.g. `PATH_OUTSIDE_PROJECT`. */
  readonly code: DebuggenErrorCode;
  /** A content-free explanation. */
  readonly message: string;
  /** The platform errno, when one was reported. */
  readonly errno?: string;
  /** When the issue was recorded, in epoch milliseconds. */
  readonly detectedAt: number;
}

/**
 * The live conflict detector of one service process. Holds no global state:
 * two watchers in one process never interfere.
 */
export interface InstrumentationWatcher {
  /**
   * Starts (or rebuilds) the watch set of one session from the journal: one
   * entry per file whose chain head is `applied`, each file's parent directory
   * watched. Every newly watched file is evaluated once unless the session is
   * suspended, so an edit made before the watch began is still caught.
   *
   * A file that cannot be watched is recorded as a {@link WatchIssue} and never
   * aborts the call; only a journal that cannot be read at all is an `Err`.
   *
   * @returns The files now under watch.
   */
  watchSession(input: {
    readonly sessionId: string;
    readonly projectRoot: string;
  }): Promise<Result<readonly WatchedFile[], DebuggenError>>;

  /**
   * Re-reads the journal and rebuilds a watched session's set: newly
   * instrumented files join, files whose chain head moved on are compared with
   * the new head, and files no longer `applied` are released. Called after
   * every install, including a follow-up delta — see the self-write contract
   * in this module's overview.
   *
   * @returns The files now under watch, or `SESSION_NOT_FOUND` for a session
   * {@link watchSession} never started.
   */
  refresh(sessionId: string): Promise<Result<readonly WatchedFile[], DebuggenError>>;

  /**
   * Stops evaluating a session's files until the matching {@link resume}:
   * pending evaluations are cancelled, events are ignored, and an evaluation
   * in flight is abandoned before it can mutate anything. Nestable; safe for a
   * session not yet watched (a later {@link watchSession} starts suspended).
   * Call it **before** `installPlan`.
   */
  suspend(sessionId: string): void;

  /**
   * Ends one {@link suspend}. When the last suspension ends, every watched
   * file of the session is evaluated once against the (refreshed) chain heads.
   * Call it **after** {@link refresh}. A resume without a suspension is a
   * no-op.
   */
  resume(sessionId: string): void;

  /**
   * Stops watching one session: closes its directory handles (when no other
   * session shares them), clears its timers, drops its entries and waits,
   * bounded, for evaluations already in flight. No transition happens for the
   * session after it resolves. Idempotent; safe for an unknown session.
   *
   * Call it **before** cleanup restores the session's files: a restore is a
   * write this module would otherwise have to judge. (Should one race it
   * anyway, the record cleanup marks `reverted` refuses the `conflict`
   * transition, so nothing is reported.)
   */
  stopSession(sessionId: string): Promise<void>;

  /** {@link stopSession} for every session. Idempotent. */
  stopAll(): Promise<void>;

  /** Alias of {@link stopAll}, for the service's shutdown sequence. */
  dispose(): Promise<void>;

  /**
   * The files currently under watch, for one session or for all of them.
   * A file whose directory watch could not be established is not listed.
   */
  watchedFiles(sessionId?: string): readonly WatchedFile[];

  /**
   * The issues recorded since each session's last rebuild, for one session or
   * for all of them. See {@link WatchIssueKind}.
   */
  watchIssues(sessionId?: string): readonly WatchIssue[];
}

// ---------------------------------------------------------------------------
// Section D — the developer-facing wording
// ---------------------------------------------------------------------------

/**
 * Renders the AAP §0.5.5 sentence for one conflict:
 *
 * ```text
 * ‹file› was edited while instrumented. Debug Generator will not overwrite it.
 * Original saved at ‹backup path›.
 * ```
 *
 * The one definition of the sentence, exported so the suites and any user
 * interface reference the same builder. It names the project-relative file and
 * the backup path — both taken from the report, which carries the record's own
 * values — and nothing else: never file content, a diff or a digest.
 *
 * @param record The record the conflict is about; its values are the fallback
 * when a report field is blank.
 * @param conflict The report from `detectConflict` or `buildConflictReport`.
 * @returns The sentence, verbatim.
 */
export function buildConflictMessage(
  record: ModificationRecord,
  conflict: ModificationConflict,
): string {
  return composeConflictSentence(
    conflict.file.length > 0 ? conflict.file : record.file,
    conflict.backupPath.length > 0 ? conflict.backupPath : record.backupPath,
  );
}

/** The sentence itself, over the two values it names. */
function composeConflictSentence(file: string, backupPath: string): string {
  return `${file} was edited while instrumented. Debug Generator will not overwrite it. Original saved at ${backupPath}.`;
}

/**
 * The notice's second line: how the change presented itself, whether the saved
 * original is still verified, and where "Open diff" finds the stored diff.
 */
function composeConflictDetail(
  observation: ConflictObservation,
  recordId: string,
  backupNote: string | undefined,
): string {
  const lines: string[] = [OBSERVATION_WORDING[observation]];

  if (backupNote !== undefined) {
    lines.push(backupNote);
  }

  lines.push(
    observation === 'file-missing'
      ? `Open diff to see what Debug Generator changed (modification ${recordId}).`
      : `Open diff to compare the original, instrumented and current versions (modification ${recordId}).`,
  );

  return lines.join(' ');
}

/** The first clause of the second line, per {@link ConflictObservation}. */
const OBSERVATION_WORDING: Readonly<Record<ConflictObservation, string>> = Object.freeze({
  'content-changed': 'Its contents no longer match what Debug Generator wrote.',
  'reverted-to-original':
    'It was changed back to its original, uninstrumented contents outside Debug Generator.',
  'file-missing': 'It was deleted or moved away after it was instrumented.',
  'not-a-regular-file':
    'Something other than a regular file (for example a symbolic link) now stands at its path.',
});

/**
 * Clips `text` to `limit` characters with a trailing ellipsis, never splitting
 * a surrogate pair.
 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  let end = limit - 1;
  const code = text.charCodeAt(end - 1);

  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }

  return `${text.slice(0, end)}…`;
}

// ---------------------------------------------------------------------------
// Section E — internal state
// ---------------------------------------------------------------------------

/** One watched session. */
interface SessionState {
  readonly sessionId: string;
  /** The project root every record path is resolved against. */
  projectRoot: string;
  /** One entry per watched file, keyed by absolute path. */
  readonly entries: Map<string, WatchEntry>;
  /** Issues since the last rebuild. */
  issues: WatchIssue[];
  /** Nesting depth of {@link InstrumentationWatcher.suspend}. */
  suspendDepth: number;
  /** Bumped on every suspend, resume and stop; an evaluation that sees it move abandons. */
  epoch: number;
  /** Set by stop; a stopped state object is never reused. */
  stopped: boolean;
  /** Whether {@link InstrumentationWatcher.watchSession} has run for it. */
  watching: boolean;
  /** The session's read-only backup store, built on first use. */
  backups: BackupStore | undefined;
  /** Evaluations in flight, drained (bounded) by stop. */
  readonly inFlight: Set<Promise<void>>;
}

/** One watched file of one session. */
interface WatchEntry {
  readonly session: SessionState;
  /** The chain head the file is compared with; replaced when the head moves. */
  record: ModificationRecord;
  readonly absolutePath: string;
  readonly directory: string;
  readonly basename: string;
  /** The directory watch this entry is subscribed to, when one is established. */
  directoryWatch: DirectoryWatch | undefined;
  /** The pending debounce timer. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** An evaluation is running. */
  evaluating: boolean;
  /** An event arrived while evaluating; evaluate again afterwards. */
  dirty: boolean;
  /** Cleared when the entry is released; a released entry never acts again. */
  active: boolean;
}

/** One open directory handle, shared by every entry in the directory. */
interface DirectoryWatch {
  readonly directory: string;
  handle: WatchHandleLike | undefined;
  readonly entries: Set<WatchEntry>;
  closed: boolean;
}

/** What the file on disk looked like when an evaluation began. */
type FileObservation =
  | { readonly kind: 'regular'; readonly hash: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-regular' }
  | { readonly kind: 'unreadable'; readonly errno: string };

/** What the directories between the project root and a file look like. */
type DirectoryChainState =
  | { readonly kind: 'ok' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unsafe'; readonly segment: string }
  | { readonly kind: 'unreadable'; readonly errno: string };

/** A conflict ready to be committed and announced. */
interface ConflictFinding {
  readonly conflict: ModificationConflict | undefined;
  readonly reason: ModificationConflictReason;
  readonly observation: ConflictObservation;
  readonly backupNote: string | undefined;
  readonly backupVerified: boolean;
}

/** The errno of a thrown filesystem error, or `'UNKNOWN'`. */
function errnoOf(thrown: unknown): string {
  if (typeof thrown === 'object' && thrown !== null && 'code' in thrown) {
    const code = (thrown as { readonly code: unknown }).code;

    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }

  return 'UNKNOWN';
}

/** A frozen public view of one entry. */
function toWatchedFile(entry: WatchEntry): WatchedFile {
  return Object.freeze({
    sessionId: entry.session.sessionId,
    recordId: entry.record.id,
    file: entry.record.file,
    absolutePath: entry.absolutePath,
    instrumentedHash: entry.record.instrumentedHash,
    planVersion: entry.record.planVersion,
  });
}

/** The identity of one reportable transition: a record at one instrumented digest. */
function transitionKey(record: ModificationRecord): string {
  return `${record.id}\u0000${record.instrumentedHash}`;
}

/**
 * Reads what stands at `path` without following a link at the final component
 * to decide, then hashes a regular file's raw bytes with the streamed,
 * asynchronous digest (no newline or encoding normalisation).
 */
async function observeFile(path: string): Promise<FileObservation> {
  try {
    const stats = await fsPromises.lstat(path);

    if (!stats.isFile()) {
      return { kind: 'not-regular' };
    }
  } catch (thrown) {
    const errno = errnoOf(thrown);

    return MISSING_ERRNO_CODES.has(errno) ? { kind: 'missing' } : { kind: 'unreadable', errno };
  }

  try {
    return { kind: 'regular', hash: await sha256OfFile(path) };
  } catch (thrown) {
    const errno = errnoOf(thrown);

    return MISSING_ERRNO_CODES.has(errno) ? { kind: 'missing' } : { kind: 'unreadable', errno };
  }
}

/**
 * Checks the directories from the project root down to `file`'s directory:
 * the root must be a directory (it may itself be reached through a link the
 * developer chose), and every directory below it must be a real directory —
 * `lstat`ed, never followed.
 *
 * @param projectRoot The session's project root.
 * @param file The record's project-relative POSIX path, already known to
 * resolve inside the root.
 * @param directory The file's absolute parent directory.
 */
async function inspectDirectoryChain(
  projectRoot: string,
  file: string,
  directory: string,
): Promise<DirectoryChainState> {
  const segments = file.split('/').filter((segment) => segment.length > 0);
  segments.pop();

  let rootDirectory = directory;

  for (let index = 0; index < segments.length; index += 1) {
    rootDirectory = dirnamePosix(rootDirectory);
  }

  try {
    const rootStats = await fsPromises.stat(rootDirectory);

    if (!rootStats.isDirectory()) {
      return { kind: 'missing' };
    }
  } catch (thrown) {
    const errno = errnoOf(thrown);

    return MISSING_ERRNO_CODES.has(errno) ? { kind: 'missing' } : { kind: 'unreadable', errno };
  }

  let prefix = '';

  for (const segment of segments) {
    prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;

    const resolved = resolveWithinProject(projectRoot, prefix);

    if (isErr(resolved)) {
      return { kind: 'unsafe', segment: prefix };
    }

    try {
      const stats = await fsPromises.lstat(resolved.value);

      if (stats.isSymbolicLink()) {
        return { kind: 'unsafe', segment: prefix };
      }

      if (!stats.isDirectory()) {
        return { kind: 'missing' };
      }
    } catch (thrown) {
      const errno = errnoOf(thrown);

      return MISSING_ERRNO_CODES.has(errno) ? { kind: 'missing' } : { kind: 'unreadable', errno };
    }
  }

  return { kind: 'ok' };
}

/** The production {@link WatchLike}: `fs.watch` over one directory. */
const defaultWatch: WatchLike = (directory, options, listener) =>
  nodeWatch(directory, { persistent: options.persistent, recursive: options.recursive }, listener);

/** How a backup-state reason reads in the notice's second line. */
const BACKUP_UNAVAILABLE_WORDING: Readonly<Record<string, string>> = Object.freeze({
  missing: 'is missing',
  'digest-mismatch': 'no longer matches its recorded digest',
  unreadable: 'could not be read',
  'unusable-path': 'could not be located',
});

/** The note for a saved original that could not be verified. */
function backupUnavailableNote(reason: string): string {
  const phrase = BACKUP_UNAVAILABLE_WORDING[reason] ?? 'could not be verified';

  return `The saved original ${phrase}, so it cannot be offered for recovery.`;
}

/** A timer-backed promise that can be cancelled, so a bounded wait leaves no handle behind. */
function cancellableDelay(ms: number): { readonly promise: Promise<void>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });

  return {
    promise,
    cancel(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

/** The debounce actually used: the injected value when it is usable, else the default. */
function resolveDebounce(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_CONFLICT_DEBOUNCE_MS;
}

// ---------------------------------------------------------------------------
// Section F — the factory
// ---------------------------------------------------------------------------

/**
 * Creates the live conflict detector.
 *
 * The returned watcher holds all of its state — sessions, directory handles,
 * timers, reported transitions — in this closure, so two watchers in one
 * process never interfere and a suite can run several in parallel.
 *
 * @param deps The journal, the progress emitter, the conflict listener, the
 * state root, and optionally a logger, a clock, a debounce, a watch primitive
 * and a backup-store factory.
 * @returns The watcher. Nothing is watched until
 * {@link InstrumentationWatcher.watchSession} is called.
 *
 * @example
 * ```ts
 * const watcher = createInstrumentationWatcher({
 *   modifications,
 *   progress,
 *   // e.g. patch the session record's `modifications` through the session
 *   // manager so a `session.updated` reaches both user interfaces
 *   listener: { onModificationConflict: (input) => reflectConflictInSession(input) },
 *   config,
 *   logger,
 * });
 *
 * watcher.suspend(sessionId);
 * await installPlan(plan, context);
 * await watcher.watchSession({ sessionId, projectRoot });
 * watcher.resume(sessionId);
 * // …
 * await watcher.stopSession(sessionId); // on session.end, before cleanup restores
 * ```
 */
export function createInstrumentationWatcher(
  deps: InstrumentationWatcherDeps,
): InstrumentationWatcher {
  const { modifications } = deps;
  const log = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM).child({
    component: LOG_COMPONENT,
  });
  const clock = deps.now ?? nowEpochMs;
  const debounceMs = resolveDebounce(deps.debounceMs);
  const watchDirectory = deps.watch ?? defaultWatch;
  // No logger is handed to the backup store or to detectConflict: both log
  // digests and backup paths, and every record reachable from this module is
  // kept to paths, ids, statuses, reasons and codes (AAP §0.5.2).
  const buildBackups =
    deps.backupStoreFor ??
    ((sessionId: string): BackupStore =>
      createBackupStore({ debuggenHome: deps.config.debuggenHome, sessionId }));

  const sessions = new Map<string, SessionState>();
  const directories = new Map<string, DirectoryWatch>();
  const reported = new Set<string>();

  /** The clock, replaced by the wall clock when it throws or answers nonsense. */
  function stamp(): number {
    try {
      const value = clock();

      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    } catch {
      // Fall through: an injected clock is a test seam, and its failure must
      // not cost the developer a conflict report.
    }

    return nowEpochMs();
  }

  /** The content-free fields every record about one modification carries. */
  function recordFields(record: ModificationRecord): Record<string, unknown> {
    return {
      [LOG_BINDING_KEYS.sessionId]: record.sessionId,
      recordId: record.id,
      file: record.file,
      planVersion: record.planVersion,
    };
  }

  /** The state of one session, created on first mention. */
  function sessionState(sessionId: string): SessionState {
    const existing = sessions.get(sessionId);

    if (existing !== undefined) {
      return existing;
    }

    const created: SessionState = {
      sessionId,
      projectRoot: '',
      entries: new Map(),
      issues: [],
      suspendDepth: 0,
      epoch: 0,
      stopped: false,
      watching: false,
      backups: undefined,
      inFlight: new Set(),
    };

    sessions.set(sessionId, created);

    return created;
  }

  /** Builds one issue, logs it at `warn`, and returns it as data. */
  function makeIssue(
    session: SessionState,
    fields: {
      readonly kind: WatchIssueKind;
      readonly code: DebuggenErrorCode;
      readonly file: string;
      readonly message: string;
      readonly recordId?: string | undefined;
      readonly errno?: string | undefined;
    },
  ): WatchIssue {
    const issue: WatchIssue = Object.freeze({
      sessionId: session.sessionId,
      file: fields.file,
      kind: fields.kind,
      code: fields.code,
      message: fields.message,
      detectedAt: stamp(),
      ...(fields.recordId === undefined ? {} : { recordId: fields.recordId }),
      ...(fields.errno === undefined ? {} : { errno: fields.errno }),
    });

    log.warn('an instrumented file cannot be watched or judged', {
      [LOG_BINDING_KEYS.sessionId]: session.sessionId,
      recordId: fields.recordId,
      file: fields.file,
      kind: fields.kind,
      code: fields.code,
      errno: fields.errno,
    });

    return issue;
  }

  /** Appends an issue discovered between rebuilds, keeping the list bounded. */
  function pushRuntimeIssue(session: SessionState, issue: WatchIssue): void {
    session.issues = [...session.issues, issue].slice(-MAX_RUNTIME_ISSUES_PER_SESSION);
  }

  // -------------------------------------------------------------------------
  // Directory handles
  // -------------------------------------------------------------------------

  /** Closes one directory handle and forgets it. Never throws. */
  function closeDirectory(directoryWatch: DirectoryWatch): void {
    if (directoryWatch.closed) {
      return;
    }

    directoryWatch.closed = true;

    if (directories.get(directoryWatch.directory) === directoryWatch) {
      directories.delete(directoryWatch.directory);
    }

    const { handle } = directoryWatch;
    directoryWatch.handle = undefined;

    if (handle !== undefined) {
      try {
        handle.close();
      } catch (thrown) {
        log.debug('closing a directory watch failed; it is dropped regardless', {
          errno: errnoOf(thrown),
        });
      }
    }
  }

  /** Routes one directory event to the entries whose basename it names. */
  function onDirectoryEvent(directoryWatch: DirectoryWatch, filename: string | null): void {
    if (directoryWatch.closed) {
      return;
    }

    for (const entry of directoryWatch.entries) {
      if (filename === null || filename === entry.basename) {
        schedule(entry);
      }
    }
  }

  /**
   * An established watch failed (the directory vanished, the platform revoked
   * it). The handle is closed, every file in it is recorded as no longer
   * watched and evaluated once — which reports it if it is gone.
   */
  function onDirectoryError(directoryWatch: DirectoryWatch, error: Error): void {
    if (directoryWatch.closed) {
      return;
    }

    closeDirectory(directoryWatch);

    const orphaned = [...directoryWatch.entries];
    directoryWatch.entries.clear();

    for (const entry of orphaned) {
      entry.directoryWatch = undefined;
      pushRuntimeIssue(
        entry.session,
        makeIssue(entry.session, {
          kind: 'watch-lost',
          code: 'INSTRUMENTATION_UNAVAILABLE',
          file: entry.record.file,
          recordId: entry.record.id,
          message:
            "The watch on this file's directory stopped; the file is checked once more and is watched again after the next refresh.",
          errno: errnoOf(error),
        }),
      );
      schedule(entry);
    }
  }

  /**
   * Subscribes an entry to its directory's handle, opening the handle when it
   * is the first entry in that directory.
   *
   * @returns `undefined` on success, or the errno the platform refused with.
   */
  function attach(entry: WatchEntry): string | undefined {
    const existing = directories.get(entry.directory);

    if (existing !== undefined && !existing.closed) {
      existing.entries.add(entry);
      entry.directoryWatch = existing;

      return undefined;
    }

    const created: DirectoryWatch = {
      directory: entry.directory,
      handle: undefined,
      entries: new Set(),
      closed: false,
    };

    try {
      created.handle = watchDirectory(entry.directory, WATCH_OPTIONS, (_eventType, filename) => {
        onDirectoryEvent(created, filename);
      });
      created.handle.on('error', (error: Error) => {
        onDirectoryError(created, error);
      });
    } catch (thrown) {
      closeDirectory(created);

      return errnoOf(thrown);
    }

    directories.set(entry.directory, created);
    created.entries.add(entry);
    entry.directoryWatch = created;

    return undefined;
  }

  /** Unsubscribes an entry, closing the handle when it was the last one. */
  function detach(entry: WatchEntry): void {
    const directoryWatch = entry.directoryWatch;

    if (directoryWatch === undefined) {
      return;
    }

    entry.directoryWatch = undefined;
    directoryWatch.entries.delete(entry);

    if (directoryWatch.entries.size === 0) {
      closeDirectory(directoryWatch);
    }
  }

  /** Cancels an entry's pending evaluation. */
  function clearTimer(entry: WatchEntry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  /** Releases an entry for good: no timer, no watch, no further action. */
  function release(entry: WatchEntry): void {
    entry.active = false;
    entry.dirty = false;
    clearTimer(entry);
    detach(entry);

    if (entry.session.entries.get(entry.absolutePath) === entry) {
      entry.session.entries.delete(entry.absolutePath);
    }
  }

  /** Releases every entry of a session. */
  function releaseAll(session: SessionState): void {
    for (const entry of [...session.entries.values()]) {
      release(entry);
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /**
   * (Re)starts an entry's debounce. Nothing is queued for a released entry, a
   * stopped session or a suspended one; an event arriving mid-evaluation marks
   * the entry for one more evaluation afterwards.
   */
  function schedule(entry: WatchEntry): void {
    const { session } = entry;

    if (!entry.active || session.stopped || session.suspendDepth > 0) {
      return;
    }

    if (entry.evaluating) {
      entry.dirty = true;

      return;
    }

    clearTimer(entry);

    const timer = setTimeout(() => {
      entry.timer = undefined;
      startEvaluation(entry);
    }, debounceMs);

    timer.unref();
    entry.timer = timer;
  }

  /**
   * Runs one evaluation of an entry, tracked so a stop can drain it and so two
   * evaluations of one file never overlap. The asynchronous work's rejection
   * is handled here: a `fs.watch` callback is synchronous and must never leave
   * a floating promise behind.
   */
  function startEvaluation(entry: WatchEntry): void {
    const { session } = entry;

    if (!entry.active || session.stopped || session.suspendDepth > 0) {
      return;
    }

    if (entry.evaluating) {
      entry.dirty = true;

      return;
    }

    entry.evaluating = true;
    entry.dirty = false;

    const running: Promise<void> = evaluate(entry)
      .catch((thrown: unknown) => {
        log.error('a conflict evaluation failed unexpectedly; the file stays watched', {
          ...recordFields(entry.record),
          code: DebuggenError.from(thrown).code,
        });
      })
      .finally(() => {
        session.inFlight.delete(running);
        entry.evaluating = false;

        if (entry.dirty) {
          entry.dirty = false;
          schedule(entry);
        }
      });

    session.inFlight.add(running);
  }

  // -------------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------------

  /**
   * Decides whether one watched file diverged from its chain head and, when it
   * did, records the conflict and announces it.
   *
   * The sequence: observe the bytes → compare with the cached head (equal: stop,
   * silently) → confirm the head against the journal (a newer head the file
   * matches: adopt it and stop) → obtain the verdict and report from
   * `detectConflict` → re-read the record immediately before the one permitted
   * mutation → `applied → conflict` → notify once. Every `await` is followed by
   * a liveness check, so a suspend or a stop that lands mid-evaluation stops it
   * before it can mutate anything.
   */
  async function evaluate(entry: WatchEntry): Promise<void> {
    const { session } = entry;
    const epoch = session.epoch;
    const live = (): boolean =>
      entry.active && !session.stopped && session.suspendDepth === 0 && session.epoch === epoch;

    let head = entry.record;
    const observation = await observeFile(entry.absolutePath);

    if (!live()) {
      return;
    }

    if (observation.kind === 'regular' && observation.hash === head.instrumentedHash) {
      log.debug('an instrumented file still holds the instrumented content', recordFields(head));

      return;
    }

    if (observation.kind === 'unreadable') {
      pushRuntimeIssue(
        session,
        makeIssue(session, {
          kind: 'file-unreadable',
          code: 'INSTRUMENTATION_UNAVAILABLE',
          file: head.file,
          recordId: head.id,
          message:
            'The instrumented file could not be read, so no decision was made about it. It is checked again on its next change.',
          errno: observation.errno,
        }),
      );

      return;
    }

    // The cached head may be stale (a follow-up install without a suspend, or
    // a record another writer already moved): ask the journal before judging.
    const headRead = await modifications.latestRecordForFile(session.sessionId, head.file);

    if (!live()) {
      return;
    }

    if (isErr(headRead)) {
      pushRuntimeIssue(
        session,
        makeIssue(session, {
          kind: 'journal-unreadable',
          code: headRead.error.code,
          file: head.file,
          recordId: head.id,
          message:
            'The modification journal could not name the current record for this file, so no decision was made about it.',
        }),
      );

      return;
    }

    const current = headRead.value;

    if (current === undefined || current.status === 'conflict' || current.status === 'reverted') {
      log.debug('the watched file no longer has an applied record; releasing it', {
        ...recordFields(head),
        status: current?.status,
      });
      release(entry);

      return;
    }

    if (current.status !== 'applied') {
      // `pending` or `failed`: an install or its rollback is mid-sequence, and
      // the refresh that follows it decides what is watched.
      log.debug('the watched file has a record mid-sequence; leaving it to the next refresh', {
        ...recordFields(current),
        status: current.status,
      });

      return;
    }

    if (current.id !== head.id || current.instrumentedHash !== head.instrumentedHash) {
      entry.record = current;
      head = current;

      if (observation.kind === 'regular' && observation.hash === head.instrumentedHash) {
        log.debug('an instrumented file holds a newer chain head; now comparing with it', {
          ...recordFields(head),
        });

        return;
      }
    }

    const finding = await describeConflict(session, head, observation);

    if (!live() || finding === undefined) {
      return;
    }

    await commitConflict(entry, head, finding, live);
  }

  /** The session's read-only backup store, built once. */
  function backupStoreOf(session: SessionState): Result<BackupStore, DebuggenError> {
    if (session.backups !== undefined) {
      return ok(session.backups);
    }

    try {
      const store = buildBackups(session.sessionId);

      if (store.sessionId !== session.sessionId) {
        return err(
          new DebuggenError('STORE_ERROR', 'The backup store belongs to another session.', {
            hint: 'Build the backup store for the session whose records are being watched.',
            details: { reason: 'backup-store-session-mismatch' },
          }),
        );
      }

      session.backups = store;

      return ok(store);
    } catch (thrown) {
      return err(DebuggenError.from(thrown, 'FS_UNSAFE_PATH'));
    }
  }

  /**
   * Obtains the precise verdict and report from `detectConflict` — the
   * procedure cleanup uses — and turns it into a finding.
   *
   * Reached only after the file was observed **not** to hold the head's
   * `instrumentedHash`, which by AAP §0.5.1 is already a conflict; the verdict
   * chooses the reason and the wording. The one exception is a verdict that
   * finds the instrumented content back on disk (`restorable`, or
   * `backup-unavailable`, which is reached only with the instrumented content
   * present): the change was undone before it could be judged, so there is no
   * edit to report and the answer is `undefined`.
   */
  async function describeConflict(
    session: SessionState,
    head: ModificationRecord,
    observation: FileObservation,
  ): Promise<ConflictFinding | undefined> {
    const sentence = composeConflictSentence(head.file, head.backupPath);
    const backups = backupStoreOf(session);

    if (isErr(backups)) {
      log.warn('the backup store could not be opened; reporting the conflict without a diff', {
        ...recordFields(head),
        code: backups.error.code,
      });
    } else {
      const verdict = await detectConflict(head, {
        projectRoot: session.projectRoot,
        backups: backups.value,
        now: stamp,
        message: sentence,
      });

      if (isErr(verdict)) {
        log.warn('conflict detection could not judge the file; reporting it without a diff', {
          ...recordFields(head),
          code: verdict.error.code,
        });
      } else {
        const judged = verdict.value;

        if (judged.kind === 'restorable' || judged.kind === 'backup-unavailable') {
          log.debug('the instrumented content is back on disk; there is no edit to report', {
            ...recordFields(head),
            verdict: judged.kind,
          });

          return undefined;
        }

        const backupNote = judged.backup.available
          ? undefined
          : backupUnavailableNote(judged.backup.reason);

        if (isConflictVerdict(judged)) {
          return {
            conflict: judged.conflict,
            reason: judged.conflict.reason,
            observation:
              judged.kind === 'file-missing'
                ? 'file-missing'
                : observation.kind === 'not-regular'
                  ? 'not-a-regular-file'
                  : 'content-changed',
            backupNote,
            backupVerified: judged.backup.available,
          };
        }

        // `already-reverted`: the developer put the original bytes back by
        // hand. The detector reports no conflict for it, because nothing is
        // left to restore; the watcher still must (the product did not write
        // those bytes), so the report is composed through the same builder
        // cleanup uses, with the tool's own change as its one diff.
        const report = buildConflictReport({
          record: head,
          reason: 'content-changed',
          detectedAt: judged.detectedAt,
          actualHash: judged.actualHash,
          message: sentence,
          diffs: head.diff.length > 0 ? { originalToInstrumented: head.diff } : undefined,
        });

        if (isErr(report)) {
          log.error('a conflict report could not be composed', {
            ...recordFields(head),
            code: report.error.code,
          });
        }

        return {
          conflict: isErr(report) ? undefined : report.value,
          reason: 'content-changed',
          observation: 'reverted-to-original',
          backupNote,
          backupVerified: judged.backup.available,
        };
      }
    }

    // The detector could not be consulted or could not answer. The file still
    // differs from what the tool wrote, so the conflict stands; it is reported
    // with what is known, without a diff.
    const reason: ModificationConflictReason =
      observation.kind === 'missing' ? 'file-missing' : 'content-changed';
    const report = buildConflictReport({
      record: head,
      reason,
      detectedAt: stamp(),
      actualHash: observation.kind === 'regular' ? observation.hash : undefined,
      message: sentence,
    });

    if (isErr(report)) {
      log.error('a conflict report could not be composed', {
        ...recordFields(head),
        code: report.error.code,
      });
    }

    return {
      conflict: isErr(report) ? undefined : report.value,
      reason,
      observation:
        observation.kind === 'missing'
          ? 'file-missing'
          : observation.kind === 'not-regular'
            ? 'not-a-regular-file'
            : 'content-changed',
      backupNote: undefined,
      backupVerified: false,
    };
  }

  /**
   * The one permitted mutation, then the notification.
   *
   * The record is re-read immediately before the write, and the write is made
   * only while it is still the `applied` head at the digest that was judged.
   * `updateStatus` carries its own optimistic guard, so a writer that moved the
   * record in between (cleanup, usually) wins: the refusal is logged at `debug`
   * and nothing is retried or announced.
   */
  async function commitConflict(
    entry: WatchEntry,
    head: ModificationRecord,
    finding: ConflictFinding,
    live: () => boolean,
  ): Promise<void> {
    const { session } = entry;
    const latest = await modifications.get(head.id);

    if (!live()) {
      return;
    }

    if (isErr(latest)) {
      pushRuntimeIssue(
        session,
        makeIssue(session, {
          kind: 'journal-unreadable',
          code: latest.error.code,
          file: head.file,
          recordId: head.id,
          message:
            'The modification journal could not be read back before recording the conflict; it is checked again on the next change.',
        }),
      );

      return;
    }

    const stored = latest.value;

    if (
      stored === undefined ||
      stored.status !== 'applied' ||
      stored.instrumentedHash !== head.instrumentedHash
    ) {
      log.debug('the record moved before the conflict could be recorded; it has a new owner', {
        ...recordFields(head),
        status: stored?.status,
      });

      if (stored === undefined || stored.status === 'conflict' || stored.status === 'reverted') {
        release(entry);
      }

      return;
    }

    const key = transitionKey(stored);

    if (reported.has(key)) {
      release(entry);

      return;
    }

    const updated = await modifications.updateStatus(stored.id, 'conflict');

    if (isErr(updated)) {
      log.debug('a concurrent writer moved the record first; the conflict is not reported twice', {
        ...recordFields(stored),
        code: updated.error.code,
      });

      return;
    }

    reported.add(key);
    release(entry);

    const record = updated.value;

    log.info('an instrumented file was edited; its modification is now a conflict', {
      ...recordFields(record),
      status: record.status,
      reason: finding.reason,
      observation: finding.observation,
    });

    await announce(session.sessionId, record, finding);
  }

  /**
   * Tells both user interfaces: a persisted `session.progress` row (the
   * sentence, and the second line with the "Open diff" pointer) and the
   * structured conflict for the listener, which updates the session record.
   * Neither channel's failure escapes, and neither blocks the other.
   */
  async function announce(
    sessionId: string,
    record: ModificationRecord,
    finding: ConflictFinding,
  ): Promise<void> {
    const { conflict } = finding;
    const message =
      conflict === undefined
        ? composeConflictSentence(record.file, record.backupPath)
        : buildConflictMessage(record, conflict);
    const notice: ConflictNotice = Object.freeze({
      message,
      detail: composeConflictDetail(finding.observation, record.id, finding.backupNote),
      action: 'open-diff',
      recordId: record.id,
      file: record.file,
      backupPath: record.backupPath,
      reason: finding.reason,
      observation: finding.observation,
      backupVerified: finding.backupVerified,
    });

    emitProgress(sessionId, record, notice);

    if (conflict === undefined) {
      log.error('the conflict is recorded but has no report, so the listener is not called', {
        ...recordFields(record),
      });

      return;
    }

    const { listener } = deps;

    if (listener === undefined) {
      return;
    }

    try {
      await listener.onModificationConflict({ sessionId, record, conflict, notice });
    } catch (thrown) {
      log.warn('the conflict listener failed; the journal already records the conflict', {
        ...recordFields(record),
        code: DebuggenError.from(thrown).code,
      });
    }
  }

  /** Emits the conflict row through the progress emitter, which persists before broadcasting. */
  function emitProgress(
    sessionId: string,
    record: ModificationRecord,
    notice: ConflictNotice,
  ): void {
    const { progress } = deps;

    if (progress === undefined) {
      return;
    }

    try {
      const sent = progress.emit(sessionId, {
        stage: CONFLICT_PROGRESS_STAGE,
        status: CONFLICT_PROGRESS_STATUS,
        message: clip(notice.message, PROGRESS_MESSAGE_LIMIT),
        detail: clip(notice.detail, PROGRESS_DETAIL_LIMIT),
      });

      if (isErr(sent)) {
        log.warn('the conflict progress row was refused', {
          ...recordFields(record),
          code: sent.error.code,
        });
      }
    } catch (thrown) {
      log.warn('the conflict progress row could not be emitted', {
        ...recordFields(record),
        code: DebuggenError.from(thrown).code,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Building the watch set
  // -------------------------------------------------------------------------

  /** The files of a session whose directory watch is established. */
  function listWatched(session: SessionState): readonly WatchedFile[] {
    const watched: WatchedFile[] = [];

    for (const entry of session.entries.values()) {
      if (entry.active && entry.directoryWatch !== undefined) {
        watched.push(toWatchedFile(entry));
      }
    }

    return Object.freeze(watched);
  }

  /**
   * Reads the journal and reconciles a session's entries with it: one entry per
   * file whose chain head is `applied`. An existing entry is kept (and its head
   * replaced when it moved); an entry whose file is no longer applied is
   * released; a new file is watched. Unless the session is suspended, every new
   * or re-headed entry is evaluated once.
   */
  async function rebuild(
    session: SessionState,
  ): Promise<Result<readonly WatchedFile[], DebuggenError>> {
    const listed = await modifications.listBySession(session.sessionId, { statuses: ['applied'] });

    if (session.stopped) {
      return ok(Object.freeze([]));
    }

    if (isErr(listed)) {
      log.warn('the modification journal could not be read; the watch set is unchanged', {
        [LOG_BINDING_KEYS.sessionId]: session.sessionId,
        code: listed.error.code,
      });

      return err(listed.error);
    }

    // One entry per file, in journal order; the status is re-checked because a
    // journal double may not honour the narrowing.
    const files: string[] = [];
    const seenFiles = new Set<string>();

    for (const record of listed.value) {
      if (record.status === 'applied' && !seenFiles.has(record.file)) {
        seenFiles.add(record.file);
        files.push(record.file);
      }
    }

    const issues: WatchIssue[] = [];
    const desired = new Map<
      string,
      {
        readonly head: ModificationRecord;
        readonly directory: string;
        readonly basename: string;
        readonly directoryMissing: boolean;
      }
    >();

    for (const file of files) {
      const headRead = await modifications.latestRecordForFile(session.sessionId, file);

      if (session.stopped) {
        return ok(Object.freeze([]));
      }

      if (isErr(headRead)) {
        issues.push(
          makeIssue(session, {
            kind: 'journal-unreadable',
            code: headRead.error.code,
            file,
            message: 'The modification journal could not name the current record for this file.',
          }),
        );
        continue;
      }

      const head = headRead.value;

      if (head === undefined || head.status !== 'applied') {
        log.debug('a file has no applied chain head; it is not watched', {
          [LOG_BINDING_KEYS.sessionId]: session.sessionId,
          file,
          status: head?.status,
        });
        continue;
      }

      const resolved = resolveWithinProject(session.projectRoot, head.file);

      if (isErr(resolved)) {
        issues.push(
          makeIssue(session, {
            kind: 'outside-project',
            code: 'PATH_OUTSIDE_PROJECT',
            file: head.file,
            recordId: head.id,
            message: 'The recorded path is not inside the project root, so it is not watched.',
          }),
        );
        continue;
      }

      const absolutePath = resolved.value;

      if (desired.has(absolutePath)) {
        continue;
      }

      const directory = dirnamePosix(absolutePath);
      const chain = await inspectDirectoryChain(session.projectRoot, head.file, directory);

      if (session.stopped) {
        return ok(Object.freeze([]));
      }

      if (chain.kind === 'unsafe') {
        issues.push(
          makeIssue(session, {
            kind: 'unsafe-path',
            code: 'FS_UNSAFE_PATH',
            file: head.file,
            recordId: head.id,
            message: `A symbolic link stands at '${chain.segment}' inside the project, so nothing is watched through it.`,
          }),
        );
        continue;
      }

      if (chain.kind === 'unreadable') {
        issues.push(
          makeIssue(session, {
            kind: 'watch-failed',
            code: 'INSTRUMENTATION_UNAVAILABLE',
            file: head.file,
            recordId: head.id,
            message: "The file's directory could not be inspected, so it is not watched.",
            errno: chain.errno,
          }),
        );
        continue;
      }

      desired.set(absolutePath, {
        head,
        directory,
        basename: basenamePosix(absolutePath),
        directoryMissing: chain.kind === 'missing',
      });
    }

    // Everything below is synchronous: the reconciliation cannot interleave
    // with an event, a suspend or a stop.
    const toEvaluate: WatchEntry[] = [];

    for (const entry of [...session.entries.values()]) {
      const wanted = desired.get(entry.absolutePath);

      if (wanted === undefined) {
        release(entry);
        continue;
      }

      if (
        wanted.head.id !== entry.record.id ||
        wanted.head.instrumentedHash !== entry.record.instrumentedHash
      ) {
        toEvaluate.push(entry);
      }

      entry.record = wanted.head;
    }

    for (const [absolutePath, wanted] of desired) {
      let entry = session.entries.get(absolutePath);

      if (entry === undefined) {
        entry = {
          session,
          record: wanted.head,
          absolutePath,
          directory: wanted.directory,
          basename: wanted.basename,
          directoryWatch: undefined,
          timer: undefined,
          evaluating: false,
          dirty: false,
          active: true,
        };
        session.entries.set(absolutePath, entry);
        toEvaluate.push(entry);
      }

      if (entry.directoryWatch !== undefined) {
        continue;
      }

      if (wanted.directoryMissing) {
        issues.push(
          makeIssue(session, {
            kind: 'directory-missing',
            code: 'PATCH_TARGET_NOT_FOUND',
            file: wanted.head.file,
            recordId: wanted.head.id,
            message:
              "The file's directory no longer exists; the file is checked once and reported if it is gone.",
          }),
        );

        if (!toEvaluate.includes(entry)) {
          toEvaluate.push(entry);
        }

        continue;
      }

      const refused = attach(entry);

      if (refused !== undefined) {
        issues.push(
          makeIssue(session, {
            kind: 'watch-failed',
            code: 'INSTRUMENTATION_UNAVAILABLE',
            file: wanted.head.file,
            recordId: wanted.head.id,
            message:
              "The platform refused a watch on the file's directory; edits to it are detected at the next refresh or at cleanup.",
            errno: refused,
          }),
        );
      }
    }

    session.issues = issues;

    for (const entry of toEvaluate) {
      schedule(entry);
    }

    const watched = listWatched(session);

    log.debug('the watch set was rebuilt from the journal', {
      [LOG_BINDING_KEYS.sessionId]: session.sessionId,
      watched: watched.length,
      issues: issues.length,
      suspended: session.suspendDepth > 0,
    });

    return ok(watched);
  }

  /** The error for an unusable session id. */
  function invalidSessionId(): DebuggenError {
    return new DebuggenError('SESSION_NOT_FOUND', 'A session id is required to watch its files.', {
      hint: 'Pass the id of the session whose instrumentation was installed.',
      details: { reason: 'blank-session-id' },
    });
  }

  /** Stops one session's state: synchronous release, then a bounded drain. */
  async function stopState(session: SessionState): Promise<void> {
    if (sessions.get(session.sessionId) === session) {
      sessions.delete(session.sessionId);
    }

    session.stopped = true;
    session.epoch += 1;
    releaseAll(session);

    if (session.inFlight.size === 0) {
      return;
    }

    const deadline = cancellableDelay(STOP_DRAIN_TIMEOUT_MS);

    try {
      await Promise.race([
        Promise.allSettled([...session.inFlight]).then(() => undefined),
        deadline.promise,
      ]);
    } finally {
      deadline.cancel();
    }
  }

  // -------------------------------------------------------------------------
  // The public surface
  // -------------------------------------------------------------------------

  async function stopAll(): Promise<void> {
    await Promise.all([...sessions.values()].map((session) => stopState(session)));

    for (const directoryWatch of [...directories.values()]) {
      closeDirectory(directoryWatch);
    }
  }

  return Object.freeze({
    watchSession(input: {
      readonly sessionId: string;
      readonly projectRoot: string;
    }): Promise<Result<readonly WatchedFile[], DebuggenError>> {
      if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
        return Promise.resolve(err(invalidSessionId()));
      }

      const session = sessionState(input.sessionId);

      if (session.watching && session.projectRoot !== input.projectRoot) {
        releaseAll(session);
      }

      session.projectRoot = input.projectRoot;
      session.watching = true;

      return rebuild(session);
    },

    refresh(sessionId: string): Promise<Result<readonly WatchedFile[], DebuggenError>> {
      const session = sessions.get(sessionId);

      if (session === undefined || !session.watching) {
        return Promise.resolve(
          err(
            new DebuggenError('SESSION_NOT_FOUND', 'This session is not being watched.', {
              hint: 'Call watchSession for the session before refreshing it.',
              details: { sessionId },
            }),
          ),
        );
      }

      return rebuild(session);
    },

    suspend(sessionId: string): void {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return;
      }

      const session = sessionState(sessionId);

      session.suspendDepth += 1;
      session.epoch += 1;

      for (const entry of session.entries.values()) {
        clearTimer(entry);
        entry.dirty = false;
      }

      log.debug('conflict evaluation suspended', {
        [LOG_BINDING_KEYS.sessionId]: sessionId,
        depth: session.suspendDepth,
      });
    },

    resume(sessionId: string): void {
      const session = sessions.get(sessionId);

      if (session === undefined || session.suspendDepth === 0) {
        return;
      }

      session.suspendDepth -= 1;

      if (session.suspendDepth > 0) {
        return;
      }

      if (!session.watching && session.entries.size === 0) {
        // Suspended and resumed without ever being watched: nothing to keep.
        sessions.delete(sessionId);

        return;
      }

      log.debug('conflict evaluation resumed; re-evaluating every watched file', {
        [LOG_BINDING_KEYS.sessionId]: sessionId,
        files: session.entries.size,
      });

      for (const entry of session.entries.values()) {
        schedule(entry);
      }
    },

    async stopSession(sessionId: string): Promise<void> {
      const session = sessions.get(sessionId);

      if (session !== undefined) {
        await stopState(session);
      }
    },

    stopAll,

    dispose: stopAll,

    watchedFiles(sessionId?: string): readonly WatchedFile[] {
      if (sessionId !== undefined) {
        const session = sessions.get(sessionId);

        return session === undefined ? Object.freeze([]) : listWatched(session);
      }

      return Object.freeze([...sessions.values()].flatMap((session) => listWatched(session)));
    },

    watchIssues(sessionId?: string): readonly WatchIssue[] {
      if (sessionId !== undefined) {
        const session = sessions.get(sessionId);

        return Object.freeze(session === undefined ? [] : [...session.issues]);
      }

      return Object.freeze([...sessions.values()].flatMap((session) => session.issues));
    },
  } satisfies InstrumentationWatcher);
}
