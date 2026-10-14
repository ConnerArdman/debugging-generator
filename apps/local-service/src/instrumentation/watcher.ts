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
 * - **A lost or refused watch is recovered, and the outage is announced.** When
 *   an established handle reports an error, or the platform refuses the initial
 *   watch, the directory's files enter one per-directory recovery: an
 *   `unref()`ed timer retries the watch after
 *   {@link DEFAULT_WATCH_RETRY_INITIAL_MS}, doubling to
 *   {@link DEFAULT_WATCH_RETRY_MAX_MS} and retrying at that ceiling for as long
 *   as a file still waits. Every refused retry asks for one evaluation of each
 *   waiting file, so an edit made while unwatched is still judged (polling at
 *   the retry cadence). A poll never postpones a check already due or running —
 *   unlike an event, it does not restart the debounce — so a retry cadence
 *   shorter than the debounce still lets every evaluation run. A successful
 *   retry evaluates each re-attached file once, for the edit made in the gap.
 *   Each session is told once per outage — "Conflict
 *   detection paused for ‹file›…" — and once more when its files are watched
 *   again. The recovery ends when its last file is re-attached (by a retry or by
 *   a {@link InstrumentationWatcher.refresh}), released, or its session stopped.
 *   Cleanup's own hash check stays the backstop: a file never re-attached is
 *   still compared with its `instrumentedHash` before it is restored.
 * - **Chain heads only.** A follow-up plan version layers a new record over an
 *   earlier one for the same file; only the newest record's `instrumentedHash`
 *   describes the bytes on disk, so one entry per file is kept — the head from
 *   `latestRecordForFile` — and an older link is never evaluated. The one
 *   thing the rest of the chain decides is where the original is: only the
 *   **chain root** (the first link) backed up the pristine file, while every
 *   later link's backup holds the previous version's still-instrumented
 *   output. A conflict on a chained head therefore resolves its root with
 *   `findChainRoot` over the session's open records and hands it to
 *   `detectConflict`, so "Original saved at ‹backup path›", the notice's
 *   `backupPath`, the report's `originalBackupPath` and the "original" side
 *   of its diff all name the root's backup, never the intermediate one.
 * - **Containment and no symbolic links.** Every `record.file` is resolved
 *   inside the session's project root with `resolveWithinProject`, and every
 *   directory between the root and the watched directory must be a real
 *   directory (checked with `lstat`, never followed). The chain is checked when
 *   the watch set is rebuilt, again — synchronously, in the same turn as the
 *   `fs.watch` call — before every recovery retry re-attaches a directory, and
 *   before every evaluation hashes a file or reads it for a diff, because a
 *   directory can be replaced by a link while its watch is down. A file behind
 *   a link is neither watched nor read and is not polled; its recovery keeps
 *   retrying, and the file is watched again once the link is gone. A refusal
 *   is recorded as a {@link WatchIssue} — once per link found — never thrown.
 *   `fs.watch` has no no-follow form, so the platform's own window between the
 *   last `lstat` and the watch syscall is the one that remains.
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
 * already in flight is abandoned before it can mutate anything. A watch
 * recovery keeps re-attaching while suspended — attaching judges nothing — and
 * the evaluations it asks for wait for the resume like any other.
 *
 * ## Privacy
 *
 * Log records and notices carry project-relative paths, record ids, statuses,
 * reasons and error codes only — never file content, a diff, a digest or a
 * backup path in a log line (AAP §0.5.2). The developer-facing sentence names
 * the pristine original's backup path because AAP §0.5.5 requires it to.
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

import { lstatSync, promises as fsPromises, statSync, watch as nodeWatch } from 'node:fs';

import {
  OPEN_MODIFICATION_STATUSES,
  buildConflictReport,
  createBackupStore,
  detectConflict,
  findChainRoot,
  isConflictVerdict,
} from '@debuggen/instrumentation';
import type {
  BackupState,
  BackupStore,
  ModificationConflict,
  ModificationConflictReason,
  ModificationRecord,
  RecordedBackup,
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
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';
import { sha256Hex, sha256OfFile } from '@debuggen/shared/node';

import type { ServiceConfig } from '../config.js';
import { LOG_BINDING_KEYS, describeException, guardLogger, subsystemLogger } from '../logging.js';
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
 * How long, in milliseconds, a directory whose watch was lost or refused waits
 * before its first re-attach attempt. Each refused attempt doubles the wait, up
 * to {@link DEFAULT_WATCH_RETRY_MAX_MS}. Overridable per watcher through
 * {@link InstrumentationWatcherDeps.watchRetryInitialMs}.
 */
export const DEFAULT_WATCH_RETRY_INITIAL_MS = 250;

/**
 * The ceiling, in milliseconds, of the re-attach backoff: while a file still
 * waits for its directory, the watch is retried (and the file evaluated) at
 * least this often and never more often. Overridable per watcher through
 * {@link InstrumentationWatcherDeps.watchRetryMaxMs}.
 */
export const DEFAULT_WATCH_RETRY_MAX_MS = 30_000;

/**
 * The longest delay a Node timer holds; a larger one fires after 1 ms, which
 * would turn a generous retry interval into a hot loop.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * How many files a watch notice names before summarising the rest as
 * "N more files", so a directory holding many instrumented files still reads
 * as one short sentence.
 */
const MAX_FILES_NAMED_PER_NOTICE = 3;

/**
 * The progress stage a conflict row — and a watch paused or resumed row — is
 * filed under: the stage that owns modifications, which is where both user
 * interfaces list them.
 */
const CONFLICT_PROGRESS_STAGE: ProgressStage = 'instrument';

/**
 * The progress status of a conflict row and of a watch notice: `running`,
 * **not** `failed`. The session has not failed — the developer simply has a
 * file the product will leave alone, or a file checked by retrying rather than
 * by an event — and a `failed` row would be rendered as a failing stage.
 */
const CONFLICT_PROGRESS_STATUS: ProgressStatus = 'running';

/**
 * The bound `session.progress` applies to a row's `message`. A conflict
 * sentence reaches it only with a pathological backup path, a watch notice only
 * with pathological file names; clipping keeps the row deliverable instead of
 * letting the schema refuse it.
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
 *   wrote nor the original. For a chained record (a follow-up plan version
 *   layered on an earlier one) that includes the earlier version's
 *   instrumented output: those bytes still carry the tool's wrapper, so they
 *   are not the original, even though the record backed them up.
 * - `reverted-to-original` — the developer restored the pristine original by
 *   hand: the record's own original for an unchained record, and the chain
 *   root's original for a chained one. Still a conflict under AAP §0.5.1's
 *   literal rule: the product did not write those bytes and will not touch
 *   them.
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
  /**
   * Where the pristine original is kept: the path the sentence names after
   * "Original saved at". For an unchained record that is the record's own
   * backup; for a chained record it is the **chain root's** backup
   * (`ModificationConflict.originalBackupPath`), because the record's own
   * backup holds the previous plan version's instrumented output. It falls
   * back to the record's own backup only when the chain root could not be
   * resolved from the journal, which is logged. Never deleted by this module.
   */
  readonly backupPath: string;
  /** The journal's reason, from `MODIFICATION_CONFLICT_REASONS`. */
  readonly reason: ModificationConflict['reason'];
  /** How the change presented itself; see {@link ConflictObservation}. */
  readonly observation: ConflictObservation;
  /**
   * Whether the saved original at {@link ConflictNotice.backupPath} was read
   * back and verified against its digest — for a chained record, the chain
   * root's backup against the root's `originalHash`.
   */
  readonly backupVerified: boolean;
}

/**
 * Receives every conflict this module reports, after the journal transition
 * has been committed.
 *
 * A consumer-declared structural port: `src/main.ts` wires it to the session
 * manager (`conflictReflectingListener`) so the session record's modification
 * list reflects the conflict and a `session.updated` reaches both user
 * interfaces. `cleanup.conflicts` is not touched: only a cleanup pass writes
 * it. This module never imports the manager to do that itself.
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
   * Where the conflict row, and the rows announcing that conflict detection
   * paused or resumed for a directory, go. `SessionProgress` persists each row
   * before broadcasting it, which is what makes the notice survive a session
   * reopen. Absent in contexts that only need the journal transition.
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
  /**
   * The wait before the first re-attach attempt of a lost or refused directory
   * watch, in milliseconds; defaults to {@link DEFAULT_WATCH_RETRY_INITIAL_MS}.
   * A value that is not a finite, positive number is replaced by the default;
   * one beyond what a timer can hold is clamped to it.
   */
  readonly watchRetryInitialMs?: number | undefined;
  /**
   * The ceiling of the re-attach backoff, in milliseconds; defaults to
   * {@link DEFAULT_WATCH_RETRY_MAX_MS}. Validated like
   * {@link watchRetryInitialMs}; a ceiling below the initial wait is raised to
   * it.
   */
  readonly watchRetryMaxMs?: number | undefined;
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
 *   Found when the watch set is rebuilt, or at runtime — before a recovery
 *   retry re-attaches the directory or an evaluation reads the file — when a
 *   directory was replaced by a link; then the file is neither watched nor read
 *   until the link is gone, and the issue is recorded once per link found.
 * - `directory-missing` — the file's directory is gone; the file is evaluated
 *   once, which reports it missing.
 * - `watch-failed` — the platform refused the directory watch (`ENOSPC`, …):
 *   the file enters its directory's recovery, which retries the watch with
 *   bounded backoff and evaluates the file on every refused retry. Also
 *   recorded, without a recovery, when a directory on the way to the file could
 *   not be inspected; the next {@link InstrumentationWatcher.refresh} tries
 *   again.
 * - `watch-lost` — an established watch reported an error and was closed: the
 *   file is evaluated once and enters the same recovery.
 *
 *   Either way the session is told that conflict detection paused for the
 *   file, and told again once it resumed. The issue stays listed until the next
 *   rebuild, as the record of the gap.
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
   * aborts the call; a refused directory watch is retried in the background
   * (see `watch-failed`). Only a journal that cannot be read at all is an
   * `Err`.
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
   * session shares them), clears its timers, withdraws its files from every
   * watch recovery (cancelling a recovery left with no file), drops its
   * entries and waits, bounded, for evaluations already in flight. No
   * transition happens for the session after it resolves. Idempotent; safe for
   * an unknown session.
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
   * A file whose directory watch could not be established, or was lost, is not
   * listed until its directory's recovery (or a refresh) re-attaches it.
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
 * the pristine original's backup path — both taken from the report — and
 * nothing else: never file content, a diff or a digest. The path is the
 * report's `originalBackupPath` when it carries one (a chained record: the
 * chain root's backup) and its `backupPath` otherwise; see
 * {@link originalBackupPathOf}.
 *
 * @param record The record the conflict is about; its values are the fallback
 * when a report field is blank.
 * @param conflict The report from `detectConflict` or `buildConflictReport`.
 * @returns The sentence, verbatim.
 *
 * @example
 * ```ts
 * // A chained record whose report names its chain root's backup:
 * buildConflictMessage(head, { ...conflict, originalBackupPath: root.backupPath });
 * // → "‹file› was edited while instrumented. Debug Generator will not
 * //    overwrite it. Original saved at ‹root.backupPath›."
 * ```
 */
export function buildConflictMessage(
  record: ModificationRecord,
  conflict: ModificationConflict,
): string {
  return composeConflictSentence(
    conflict.file.length > 0 ? conflict.file : record.file,
    originalBackupPathOf(record, conflict),
  );
}

/**
 * Where the pristine original a conflict report names is kept: the report's
 * `originalBackupPath` (a chained record's chain root), else its `backupPath`,
 * else the record's own. The one resolution both the sentence and
 * {@link ConflictNotice.backupPath} use, so the two can never name different
 * files.
 */
function originalBackupPathOf(record: ModificationRecord, conflict: ModificationConflict): string {
  if (conflict.originalBackupPath !== undefined && conflict.originalBackupPath.length > 0) {
    return conflict.originalBackupPath;
  }

  return conflict.backupPath.length > 0 ? conflict.backupPath : record.backupPath;
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
 * Why a directory's watch is down, which chooses the reason clause of the
 * paused notice:
 *
 * - `lost` — an established watch reported an error and was closed.
 * - `refused` — the platform refused to open the watch in the first place.
 */
export type WatchOutageCause = 'lost' | 'refused';

/**
 * Renders the notice that conflict detection paused for files of one
 * directory, sent to the session once per outage:
 *
 * ```text
 * Conflict detection paused for ‹file›: the watch on its folder stopped.
 * Debug Generator keeps retrying and still checks the file before restoring it.
 * ```
 *
 * The second sentence is literal: every refused retry evaluates the file, and
 * cleanup compares it with its `instrumentedHash` before restoring anything.
 * Exported, like {@link buildConflictMessage}, so the suites reference the one
 * definition. It names project-relative files only — at most
 * {@link MAX_FILES_NAMED_PER_NOTICE}, the rest counted — never an absolute
 * path, content or an errno.
 *
 * @example
 * ```ts
 * buildWatchPausedMessage(['src/a.ts', 'src/b.ts'], 'refused');
 * // 'Conflict detection paused for src/a.ts and src/b.ts: the platform refused
 * //  a watch on their folder. Debug Generator keeps retrying and still checks
 * //  the files before restoring them.'
 * ```
 *
 * @param files The project-relative files whose watch is down.
 * @param cause Why the watch is down.
 * @returns The sentence, verbatim.
 */
export function buildWatchPausedMessage(files: readonly string[], cause: WatchOutageCause): string {
  const named = nameFiles(files);
  const plural = named.count > 1;
  const folder = plural ? 'their folder' : 'its folder';
  const reason =
    cause === 'lost'
      ? `the watch on ${folder} stopped`
      : `the platform refused a watch on ${folder}`;
  const checked = plural ? 'the files before restoring them' : 'the file before restoring it';

  return `Conflict detection paused for ${named.text}: ${reason}. Debug Generator keeps retrying and still checks ${checked}.`;
}

/**
 * Renders the notice that conflict detection resumed for files whose watch was
 * re-established — by a retry or by a refresh — sent once per outage to each
 * session that was told it paused:
 *
 * ```text
 * Conflict detection resumed for ‹file›.
 * ```
 *
 * @param files The project-relative files watched again.
 * @returns The sentence, verbatim.
 */
export function buildWatchResumedMessage(files: readonly string[]): string {
  return `Conflict detection resumed for ${nameFiles(files).text}.`;
}

/**
 * Names files compactly — `a`, `a and b`, `a, b and c`, `a, b, c and 2 more
 * files` — and counts the distinct, non-blank ones.
 */
function nameFiles(files: readonly string[]): { readonly text: string; readonly count: number } {
  const distinct = [...new Set(files.filter((file) => file.length > 0))];

  if (distinct.length === 0) {
    return { text: 'an instrumented file', count: 1 };
  }

  const shown = distinct.slice(0, MAX_FILES_NAMED_PER_NOTICE);
  const hidden = distinct.length - shown.length;

  if (hidden > 0) {
    return {
      text: `${shown.join(', ')} and ${String(hidden)} more ${hidden === 1 ? 'file' : 'files'}`,
      count: distinct.length,
    };
  }

  const leading = shown.slice(0, -1);
  const last = shown.at(-1) ?? '';

  return {
    text: leading.length === 0 ? last : `${leading.join(', ')} and ${last}`,
    count: distinct.length,
  };
}

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
  /**
   * The recovery this entry waits in while its directory watch is down; set
   * only while `directoryWatch` is `undefined`, cleared on re-attach or release.
   */
  recovery: DirectoryRecovery | undefined;
  /**
   * The in-project segment at which the last runtime chain check found a
   * symbolic link, while one stands there: the entry is then neither attached
   * nor read. Cleared by the first check that finds the chain safe again, so an
   * `unsafe-path` issue is recorded once per link found.
   */
  unsafeSegment: string | undefined;
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

/**
 * One directory whose watch is down, and the entries waiting for it — across
 * every session of this watcher, as the handle itself is shared. Lives from the
 * outage until its last entry is re-attached, released or stopped.
 */
interface DirectoryRecovery {
  readonly directory: string;
  /** Active, unwatched entries waiting for this directory. */
  readonly orphans: Set<WatchEntry>;
  /**
   * Per session told that conflict detection paused: the files the notice
   * named, so a file is announced once per outage and a session is told it
   * resumed only after it was told it paused.
   */
  readonly announced: Map<SessionState, Set<string>>;
  /** Per session: the entries re-attached so far, named once the session has no orphan left. */
  readonly restored: Map<SessionState, WatchEntry[]>;
  /** The pending re-attach attempt. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The wait before the next attempt; doubles on each refusal, up to the ceiling. */
  nextDelayMs: number;
  /** Attempts made so far. */
  attempts: number;
  /** Set when the recovery ends; an ended recovery never acts again. */
  ended: boolean;
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
  /**
   * The pristine original's backup path the sentence names: the chain root's
   * for a chained record whose root was resolved, else the record's own. The
   * notice's fallback when no report could be composed.
   */
  readonly originalBackupPath: string;
}

/**
 * The errno of a thrown filesystem error, or `'UNKNOWN'`.
 *
 * Read through `describeException`, so only a closed-vocabulary code — an
 * errno / `ERR_*` code, or a `DebuggenError` code — is ever returned: an
 * arbitrary `code` property on a foreign value never reaches a log field, a
 * `WatchIssue` or a conflict notice.
 */
function errnoOf(thrown: unknown): string {
  return describeException(thrown).errorCode ?? 'UNKNOWN';
}

/** Appends `value` to the list `map` holds for `key`, creating the list on first use. */
function appendTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);

  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
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
  const walk = directoryChainOf(projectRoot, file, directory);

  try {
    const rootStats = await fsPromises.stat(walk.rootDirectory);

    if (!rootStats.isDirectory()) {
      return { kind: 'missing' };
    }
  } catch (thrown) {
    return chainFailureOf(thrown);
  }

  for (const step of walk.steps) {
    if (step.absolute === undefined) {
      return { kind: 'unsafe', segment: step.prefix };
    }

    try {
      const judged = judgeChainSegment(await fsPromises.lstat(step.absolute), step.prefix);

      if (judged !== undefined) {
        return judged;
      }
    } catch (thrown) {
      return chainFailureOf(thrown);
    }
  }

  return { kind: 'ok' };
}

/**
 * {@link inspectDirectoryChain}, synchronously, with the same rules and the
 * same answers.
 *
 * Used where the answer gates a synchronous operation that follows the path —
 * a recovery retry's `fs.watch`, an evaluation's first read — so that no turn
 * of the event loop separates the last `lstat` from the operation it guards:
 * a directory swapped for a link while its watch was down is found in the same
 * turn that would otherwise have followed it. The walk is a handful of
 * `lstat`s, bounded by the file's depth below the project root.
 */
function inspectDirectoryChainSync(
  projectRoot: string,
  file: string,
  directory: string,
): DirectoryChainState {
  const walk = directoryChainOf(projectRoot, file, directory);

  try {
    if (!statSync(walk.rootDirectory).isDirectory()) {
      return { kind: 'missing' };
    }
  } catch (thrown) {
    return chainFailureOf(thrown);
  }

  for (const step of walk.steps) {
    if (step.absolute === undefined) {
      return { kind: 'unsafe', segment: step.prefix };
    }

    try {
      const judged = judgeChainSegment(lstatSync(step.absolute), step.prefix);

      if (judged !== undefined) {
        return judged;
      }
    } catch (thrown) {
      return chainFailureOf(thrown);
    }
  }

  return { kind: 'ok' };
}

/** The directories a chain inspection walks, from the root down to the file's directory. */
interface DirectoryChainWalk {
  /** The project root, as reached from the file's directory (it may be a link the developer chose). */
  readonly rootDirectory: string;
  /**
   * Each directory below the root, as its project-relative prefix and its
   * contained absolute path — `undefined` when the prefix does not resolve
   * inside the root, which the walk reports as unsafe.
   */
  readonly steps: readonly { readonly prefix: string; readonly absolute: string | undefined }[];
}

/** The pure part of a chain inspection: what to look at, in order. */
function directoryChainOf(
  projectRoot: string,
  file: string,
  directory: string,
): DirectoryChainWalk {
  const segments = file.split('/').filter((segment) => segment.length > 0);
  segments.pop();

  let rootDirectory = directory;

  for (let index = 0; index < segments.length; index += 1) {
    rootDirectory = dirnamePosix(rootDirectory);
  }

  const steps: { readonly prefix: string; readonly absolute: string | undefined }[] = [];
  let prefix = '';

  for (const segment of segments) {
    prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;

    const resolved = resolveWithinProject(projectRoot, prefix);

    steps.push({ prefix, absolute: isErr(resolved) ? undefined : resolved.value });
  }

  return { rootDirectory, steps };
}

/**
 * One directory of the chain, judged from its `lstat`: a link is unsafe, a
 * non-directory makes the file's directory missing, and a real directory lets
 * the walk go on (`undefined`).
 */
function judgeChainSegment(
  stats: { isSymbolicLink(): boolean; isDirectory(): boolean },
  prefix: string,
): DirectoryChainState | undefined {
  if (stats.isSymbolicLink()) {
    return { kind: 'unsafe', segment: prefix };
  }

  return stats.isDirectory() ? undefined : { kind: 'missing' };
}

/** A chain inspection's failed `stat`: a missing directory, or an unreadable one with its errno. */
function chainFailureOf(thrown: unknown): DirectoryChainState {
  const errno = errnoOf(thrown);

  return MISSING_ERRNO_CODES.has(errno) ? { kind: 'missing' } : { kind: 'unreadable', errno };
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

/**
 * The digest of the pristine original a record's file could have been
 * restored to by hand: the chain root's `originalHash` for a chained record
 * whose root is known, the record's own `originalHash` for an unchained one,
 * and `undefined` for a chained record whose root is not known — its own
 * `originalHash` is the previous plan version's instrumented output, which is
 * not the original.
 */
function pristineHashOf(
  record: ModificationRecord,
  chainRoot: ModificationRecord | undefined,
): string | undefined {
  if (chainRoot !== undefined) {
    return chainRoot.originalHash;
  }

  return record.previousRecordId === undefined ? record.originalHash : undefined;
}

/**
 * Reads a chain root's backup back and verifies it against the root's
 * `originalHash`, so the notice's `backupVerified` and its backup note
 * describe the backup its sentence names.
 *
 * `detectConflict` makes the same check of the judged record's own backup and,
 * for a chained record, reads the root's back only to compose the diff; its
 * verdict reports the record's own backup state, which for a chained record
 * is the intermediate, still-instrumented copy. This is the same read-only
 * check over the root: through `BackupStore.readRecorded` (the path the
 * journal names, so a relocated backup is not reported missing), then a
 * raw-byte SHA-256 of what was read. It writes nothing, never throws, and
 * answers in the verdict's own {@link BackupState} vocabulary.
 */
async function inspectChainRootBackup(
  backups: BackupStore,
  chainRoot: ModificationRecord,
): Promise<BackupState> {
  const path = chainRoot.backupPath;
  let read: Result<RecordedBackup, DebuggenError>;

  try {
    read = await backups.readRecorded(path, chainRoot.originalHash);
  } catch (thrown) {
    return { available: false, path, reason: 'unreadable', detail: errnoOf(thrown) };
  }

  if (isErr(read)) {
    const storeReason = read.error.details?.['reason'];

    return {
      available: false,
      path,
      reason:
        storeReason === 'backup-missing'
          ? 'missing'
          : storeReason === 'stored-digest-mismatch'
            ? 'digest-mismatch'
            : read.error.code === 'FS_UNSAFE_PATH'
              ? 'unusable-path'
              : 'unreadable',
      detail: typeof storeReason === 'string' ? storeReason : read.error.code,
    };
  }

  const { bytes } = read.value;

  return sha256Hex(bytes) === chainRoot.originalHash
    ? { available: true, path, byteLength: bytes.byteLength }
    : { available: false, path, reason: 'digest-mismatch' };
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

/**
 * A re-attach interval actually used: the injected value when it is a finite,
 * positive number, else `fallback`, and never beyond what a timer can hold. A
 * zero is refused like a negative: it would retry a refusing platform in a hot
 * loop.
 */
function resolveRetryInterval(value: number | undefined, fallback: number): number {
  const usable = value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;

  return Math.min(usable, MAX_TIMER_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Section F — the factory
// ---------------------------------------------------------------------------

/**
 * Creates the live conflict detector.
 *
 * The returned watcher holds all of its state — sessions, directory handles,
 * watch recoveries, timers, reported transitions — in this closure, so two
 * watchers in one process never interfere and a suite can run several in
 * parallel.
 *
 * @param deps The journal, the progress emitter, the conflict listener, the
 * state root, and optionally a logger, a clock, a debounce, the re-attach
 * backoff, a watch primitive and a backup-store factory.
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
  // Guarded once, at construction: this module logs on its failure paths — a
  // lost watch, a refused row, a misread clock — where an injected logger that
  // throws must not cost the developer the conflict report being assembled.
  const log = subsystemLogger(guardLogger(deps.logger ?? noopLogger), LOG_SUBSYSTEM).child({
    component: LOG_COMPONENT,
  });
  const clock = deps.now ?? nowEpochMs;
  const debounceMs = resolveDebounce(deps.debounceMs);
  const retryInitialMs = resolveRetryInterval(
    deps.watchRetryInitialMs,
    DEFAULT_WATCH_RETRY_INITIAL_MS,
  );
  const retryMaxMs = Math.max(
    retryInitialMs,
    resolveRetryInterval(deps.watchRetryMaxMs, DEFAULT_WATCH_RETRY_MAX_MS),
  );
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
  /** One recovery per directory whose watch is down, keyed like `directories`. */
  const recoveries = new Map<string, DirectoryRecovery>();
  const reported = new Set<string>();
  /** Whether {@link stamp} has already recorded falling back to the wall clock. */
  let clockFallbackRecorded = false;

  /**
   * The clock, replaced by the wall clock when it throws or answers nonsense:
   * an injected clock is a test seam, and its failure must not cost the
   * developer a conflict report.
   *
   * The fallback is a deliberate best-effort decision, recorded at `debug`
   * with an enumerated reason and, for a throw, the closed exception fields —
   * once per watcher, so a clock broken for good yields one line rather than
   * one per stamped issue.
   */
  function stamp(): number {
    let value: number;

    try {
      value = clock();
    } catch (thrown) {
      return wallClock({ reason: 'clock-threw', ...describeException(thrown) });
    }

    return Number.isFinite(value) && value > 0
      ? value
      : wallClock({ reason: 'clock-reading-unusable' });
  }

  /** The wall-clock fallback of {@link stamp}, recording its first use. */
  function wallClock(fields: LogFields): number {
    if (!clockFallbackRecorded) {
      clockFallbackRecorded = true;
      log.debug('the injected clock could not be read; the wall clock is used instead', fields);
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
   * it). The handle is closed; every file in it is recorded as a `watch-lost`
   * issue, evaluated once — which reports it if it is gone — and handed to the
   * directory's recovery, which retries the watch with bounded backoff, keeps
   * evaluating the files while the platform refuses, and tells each session
   * that conflict detection paused (and, later, that it resumed).
   *
   * @param directoryWatch The handle that reported the error.
   * @param error The handle's error; only its errno is kept.
   */
  function onDirectoryError(directoryWatch: DirectoryWatch, error: Error): void {
    if (directoryWatch.closed) {
      return;
    }

    closeDirectory(directoryWatch);

    const orphaned = [...directoryWatch.entries];
    const errno = errnoOf(error);
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
            "The watch on this file's directory stopped. It is re-established with backoff; until then the file is checked on every retry, and cleanup checks it before restoring anything.",
          errno,
        }),
      );
      schedule(entry);
    }

    enterRecovery(directoryWatch.directory, orphaned, 'lost');
  }

  /**
   * Subscribes an entry to its directory's handle, opening the handle when it
   * is the first entry in that directory. An entry that was waiting in its
   * directory's recovery leaves it — whoever re-attached it, a retry or a
   * rebuild — which cancels the recovery once nothing else waits.
   *
   * @returns `undefined` on success, or the errno the platform refused with.
   */
  function attach(entry: WatchEntry): string | undefined {
    const existing = directories.get(entry.directory);

    if (existing !== undefined && !existing.closed) {
      existing.entries.add(entry);
      entry.directoryWatch = existing;
      leaveRecovery(entry, 'restored');

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
    leaveRecovery(entry, 'restored');

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

  /**
   * Releases an entry for good: no timer, no watch, no place in a recovery, no
   * further action.
   */
  function release(entry: WatchEntry): void {
    entry.active = false;
    entry.dirty = false;
    clearTimer(entry);
    detach(entry);
    leaveRecovery(entry, 'released');

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
  // Watch recovery
  // -------------------------------------------------------------------------

  /**
   * Hands unwatched entries of one directory to its recovery, creating and
   * arming the recovery when none is running, and tells each session which of
   * its files lost conflict detection. An entry already waiting is not
   * announced again, so a rebuild whose attach is refused once more during an
   * outage adds no row.
   *
   * Only entries that are active, unwatched, of a live session and in
   * `directory` are taken; anything else is ignored.
   *
   * @param directory The directory whose watch is down.
   * @param entries The entries left without a watch.
   * @param cause Why the watch is down, for the paused notice.
   */
  function enterRecovery(
    directory: string,
    entries: readonly WatchEntry[],
    cause: WatchOutageCause,
  ): void {
    const eligible = entries.filter(
      (entry) =>
        entry.active &&
        !entry.session.stopped &&
        entry.directoryWatch === undefined &&
        entry.directory === directory,
    );

    if (eligible.length === 0) {
      return;
    }

    let recovery = recoveries.get(directory);

    if (recovery === undefined || recovery.ended) {
      recovery = {
        directory,
        orphans: new Set(),
        announced: new Map(),
        restored: new Map(),
        timer: undefined,
        nextDelayMs: retryInitialMs,
        attempts: 0,
        ended: false,
      };
      recoveries.set(directory, recovery);
    }

    const newlyWaiting = new Map<SessionState, WatchEntry[]>();

    for (const entry of eligible) {
      if (entry.recovery === recovery) {
        continue;
      }

      entry.recovery = recovery;
      recovery.orphans.add(entry);
      appendTo(newlyWaiting, entry.session, entry);
    }

    for (const [session, waiting] of newlyWaiting) {
      announcePaused(recovery, session, waiting, cause);
    }

    if (recovery.timer === undefined && recovery.orphans.size > 0) {
      armRecovery(recovery);
    }
  }

  /**
   * Arms a recovery's next attempt on an `unref()`ed timer, replacing any
   * attempt already armed, so a recovery never holds two timers.
   */
  function armRecovery(recovery: DirectoryRecovery): void {
    if (recovery.timer !== undefined) {
      clearTimeout(recovery.timer);
    }

    const timer = setTimeout(() => {
      recovery.timer = undefined;
      attemptRecovery(recovery);
    }, recovery.nextDelayMs);

    timer.unref();
    recovery.timer = timer;
  }

  /**
   * One re-attach attempt. Every waiting entry is attached through
   * {@link attach}, which opens the directory's handle for the first and shares
   * it with the rest (or shares one another rebuild already opened). Each
   * re-attached entry is evaluated once, so an edit made in the gap is judged;
   * the last one out ends the recovery and sends the resumed notices.
   *
   * Before each attach, the directory chain is checked again, in the same turn
   * as the watch call ({@link chainIsSafe}): the directory may have been
   * replaced by a link while its watch was down, and a retry must never follow
   * it. An entry behind a link stays waiting — neither attached nor polled —
   * and counts as a refusal for the backoff.
   *
   * On a refusal, every entry still waiting is polled once ({@link poll}) — the
   * fallback that keeps edits judged while nothing is watched — and the next
   * attempt is armed after twice the last wait, capped at the ceiling. The
   * attempts go on at the ceiling for as long as an entry waits; suspension
   * does not stop them, while the evaluations obey it through
   * {@link schedule}.
   */
  function attemptRecovery(recovery: DirectoryRecovery): void {
    if (recovery.ended) {
      return;
    }

    recovery.attempts += 1;

    const reattached: WatchEntry[] = [];
    let refused: string | undefined;
    let withheld = 0;

    for (const entry of [...recovery.orphans]) {
      // Re-checked per entry: a notice sent for the previous one may have
      // reached code that released or re-attached this one.
      if (entry.recovery !== recovery) {
        recovery.orphans.delete(entry);
        continue;
      }

      if (!entry.active || entry.session.stopped || entry.directoryWatch !== undefined) {
        leaveRecovery(entry, 'released');
        continue;
      }

      if (!chainIsSafe(entry)) {
        withheld += 1;
        continue;
      }

      refused = attach(entry);

      if (refused !== undefined) {
        break;
      }

      reattached.push(entry);
    }

    for (const entry of reattached) {
      schedule(entry);
    }

    if (!recovery.ended && recovery.orphans.size === 0) {
      endRecovery(recovery);
    }

    if (recovery.ended) {
      return;
    }

    if (refused === undefined && withheld === 0) {
      // Entries that joined while this attempt ran get the next one.
      armRecovery(recovery);

      return;
    }

    const retryInMs = Math.min(recovery.nextDelayMs * 2, retryMaxMs);

    for (const [session, waiting] of orphansBySession(recovery)) {
      log.debug('a directory watch is still refused; its files are checked now and retried', {
        [LOG_BINDING_KEYS.sessionId]: session.sessionId,
        files: waiting.map((entry) => entry.record.file),
        attempt: recovery.attempts,
        retryInMs,
        errno: refused,
        ...(withheld === 0 ? {} : { withheld }),
      });

      for (const entry of waiting) {
        poll(entry);
      }
    }

    recovery.nextDelayMs = retryInMs;
    armRecovery(recovery);
  }

  /**
   * Checks, synchronously, that no symbolic link stands between the project
   * root and an entry's directory ({@link inspectDirectoryChainSync}), so the
   * watch call or read it guards follows in the same turn as the last `lstat`.
   *
   * A link found at a segment not reported yet records one `unsafe-path` issue;
   * the entry keeps the segment until a check finds the chain safe again. A
   * missing or unreadable chain passes: the operation it guards fails on its
   * own, as it would have without the check, and reports that.
   *
   * @returns Whether the entry's directory may be watched and its file read now.
   */
  function chainIsSafe(entry: WatchEntry): boolean {
    const chain = inspectDirectoryChainSync(
      entry.session.projectRoot,
      entry.record.file,
      entry.directory,
    );

    if (chain.kind !== 'unsafe') {
      entry.unsafeSegment = undefined;

      return true;
    }

    if (entry.unsafeSegment !== chain.segment) {
      entry.unsafeSegment = chain.segment;
      pushRuntimeIssue(
        entry.session,
        makeIssue(entry.session, {
          kind: 'unsafe-path',
          code: 'FS_UNSAFE_PATH',
          file: entry.record.file,
          recordId: entry.record.id,
          message: `A symbolic link now stands at '${chain.segment}' inside the project, so the file is neither watched nor read through it. Watching resumes once the link is gone; cleanup checks the file before restoring anything.`,
        }),
      );
    }

    return false;
  }

  /**
   * Takes an entry out of its recovery: `restored` when it was re-attached,
   * `released` when it no longer needs watching (released, stopped). A session
   * left with no waiting entry is settled; a recovery left with none ends.
   */
  function leaveRecovery(entry: WatchEntry, outcome: 'restored' | 'released'): void {
    const { recovery, session } = entry;

    if (recovery === undefined) {
      return;
    }

    entry.recovery = undefined;
    recovery.orphans.delete(entry);

    if (outcome === 'restored') {
      appendTo(recovery.restored, session, entry);
    }

    if (![...recovery.orphans].some((orphan) => orphan.session === session)) {
      settleSession(recovery, session);
    }

    if (recovery.orphans.size === 0) {
      endRecovery(recovery);
    }
  }

  /**
   * Closes one session's part in a recovery: when it was told conflict
   * detection paused and some of its files are watched again, it is told that
   * detection resumed for them. A stopped session is told nothing.
   */
  function settleSession(recovery: DirectoryRecovery, session: SessionState): void {
    const restored = (recovery.restored.get(session) ?? []).filter((entry) => entry.active);
    const wasAnnounced = recovery.announced.has(session);

    recovery.restored.delete(session);
    recovery.announced.delete(session);

    if (restored.length === 0 || session.stopped) {
      return;
    }

    const files = restored.map((entry) => entry.record.file);

    log.info('a directory watch is re-established; conflict detection resumed', {
      [LOG_BINDING_KEYS.sessionId]: session.sessionId,
      files,
      attempts: recovery.attempts,
    });

    if (wasAnnounced) {
      emitWatchNotice(session, buildWatchResumedMessage(files), 'resumed');
    }
  }

  /** Ends a recovery: its timer is cleared and nothing of it acts again. */
  function endRecovery(recovery: DirectoryRecovery): void {
    if (recovery.ended) {
      return;
    }

    recovery.ended = true;

    if (recovery.timer !== undefined) {
      clearTimeout(recovery.timer);
      recovery.timer = undefined;
    }

    if (recoveries.get(recovery.directory) === recovery) {
      recoveries.delete(recovery.directory);
    }

    for (const orphan of recovery.orphans) {
      orphan.recovery = undefined;
    }

    recovery.orphans.clear();
    recovery.announced.clear();
    recovery.restored.clear();
  }

  /** A recovery's waiting entries, grouped by session in arrival order. */
  function orphansBySession(recovery: DirectoryRecovery): Map<SessionState, WatchEntry[]> {
    const grouped = new Map<SessionState, WatchEntry[]>();

    for (const entry of recovery.orphans) {
      appendTo(grouped, entry.session, entry);
    }

    return grouped;
  }

  /**
   * Tells one session that conflict detection paused for those of `entries`
   * whose files its notice has not named yet in this outage.
   */
  function announcePaused(
    recovery: DirectoryRecovery,
    session: SessionState,
    entries: readonly WatchEntry[],
    cause: WatchOutageCause,
  ): void {
    const named = recovery.announced.get(session) ?? new Set<string>();
    const files = entries.map((entry) => entry.record.file).filter((file) => !named.has(file));

    if (files.length === 0) {
      return;
    }

    for (const file of files) {
      named.add(file);
    }

    recovery.announced.set(session, named);
    emitWatchNotice(session, buildWatchPausedMessage(files, cause), 'paused');
  }

  /**
   * Emits one watch notice row through the progress emitter, which persists it
   * before broadcasting. Skipped without an emitter; a refusal or a throw is
   * logged and contained, as for the conflict row.
   */
  function emitWatchNotice(
    session: SessionState,
    message: string,
    notice: 'paused' | 'resumed',
  ): void {
    const { progress } = deps;

    if (progress === undefined) {
      return;
    }

    try {
      const sent = progress.emit(session.sessionId, {
        stage: CONFLICT_PROGRESS_STAGE,
        status: CONFLICT_PROGRESS_STATUS,
        message: clip(message, PROGRESS_MESSAGE_LIMIT),
      });

      if (isErr(sent)) {
        log.warn('the watch notice progress row was refused', {
          [LOG_BINDING_KEYS.sessionId]: session.sessionId,
          notice,
          code: sent.error.code,
        });
      }
    } catch (thrown) {
      log.warn('the watch notice progress row could not be emitted', {
        [LOG_BINDING_KEYS.sessionId]: session.sessionId,
        notice,
        code: DebuggenError.from(thrown).code,
      });
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
   * Asks for one evaluation of an entry waiting in a recovery — the polling
   * fallback. Unlike {@link schedule}, a poll never restarts a debounce that is
   * already counting and never queues behind a running evaluation: the check
   * already due or in flight answers it. Polls arriving faster than the
   * debounce therefore cannot postpone the check forever. An entry behind a
   * link ({@link chainIsSafe}) is not polled.
   */
  function poll(entry: WatchEntry): void {
    if (entry.timer !== undefined || entry.evaluating || entry.unsafeSegment !== undefined) {
      return;
    }

    schedule(entry);
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
   * The sequence: check the directory chain (a link on the way: stop, recorded
   * once) → observe the bytes → compare with the cached head (equal: stop,
   * silently) → confirm the head against the journal (a newer head the file
   * matches: adopt it and stop) → check the chain again → obtain the verdict and
   * report from `detectConflict` → re-read the record immediately before the one permitted
   * mutation → `applied → conflict` → notify once. Every `await` is followed by
   * a liveness check, so a suspend or a stop that lands mid-evaluation stops it
   * before it can mutate anything.
   */
  async function evaluate(entry: WatchEntry): Promise<void> {
    const { session } = entry;
    const epoch = session.epoch;
    const live = (): boolean =>
      entry.active && !session.stopped && session.suspendDepth === 0 && session.epoch === epoch;

    // A directory on the way may have been replaced by a link since the watch
    // set was built: nothing is hashed through one. Checked in this turn, just
    // before the read begins.
    if (!chainIsSafe(entry)) {
      return;
    }

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

    // The verdict reads the file again, for the diff: the chain is re-checked
    // in this turn, just before that read, so no content behind a link reaches
    // a report.
    if (!chainIsSafe(entry)) {
      return;
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
   * The chain root of a chained head: the first record of its follow-up
   * chain, whose backup is the pristine file (AAP §0.4.2). `undefined` for an
   * unchained head, whose own backup already is the pristine file.
   *
   * Resolved with `findChainRoot` over the session's open records — the set
   * cleanup resolves it in — so the live notice and the cleanup report name
   * the same original. A journal that cannot be read, or a chain whose parent
   * is not among the open records, degrades to the head's own backup: the
   * conflict is still reported, and the degradation is logged at `warn` with
   * ids, statuses and codes only — never a path or a digest.
   */
  async function chainRootOf(
    session: SessionState,
    head: ModificationRecord,
  ): Promise<ModificationRecord | undefined> {
    if (head.previousRecordId === undefined) {
      return undefined;
    }

    let listed: Result<ModificationRecord[], DebuggenError>;

    try {
      listed = await modifications.listBySession(session.sessionId, {
        statuses: OPEN_MODIFICATION_STATUSES,
      });
    } catch (thrown) {
      listed = err(DebuggenError.from(thrown, 'STORE_ERROR'));
    }

    if (isErr(listed)) {
      log.warn(
        "the chain root could not be read from the journal; the conflict names the record's own backup",
        { ...recordFields(head), previousRecordId: head.previousRecordId, code: listed.error.code },
      );

      return undefined;
    }

    const root = findChainRoot(head, listed.value);

    if (root === undefined) {
      log.warn(
        "a chained record's chain root is not among the open records; the conflict names the record's own backup",
        { ...recordFields(head), previousRecordId: head.previousRecordId },
      );
    }

    return root;
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
   *
   * For a chained head the finding is about the **chain root's** original:
   * the root is handed to every `detectConflict` and `buildConflictReport`
   * call, so the report carries `originalBackupPath` and its "original" diff
   * side is the root's verified pristine text; the sentence names the root's
   * backup; and whether that backup is verified is read from the root's own
   * backup, not the head's intermediate one.
   */
  async function describeConflict(
    session: SessionState,
    head: ModificationRecord,
    observation: FileObservation,
  ): Promise<ConflictFinding | undefined> {
    const chainRoot = await chainRootOf(session, head);
    const originalBackupPath = chainRoot?.backupPath ?? head.backupPath;
    const pristineHash = pristineHashOf(head, chainRoot);
    const sentence = composeConflictSentence(head.file, originalBackupPath);
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
        chainRoot,
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

        // The saved original the sentence names: the verdict's own backup
        // state for an unchained head, and the chain root's backup — read back
        // and verified here — for a chained one, whose own backup is the
        // previous plan version's instrumented output.
        const original =
          chainRoot === undefined
            ? judged.backup
            : await inspectChainRootBackup(backups.value, chainRoot);
        const backupNote = original.available ? undefined : backupUnavailableNote(original.reason);

        if (isConflictVerdict(judged)) {
          return {
            conflict: judged.conflict,
            reason: judged.conflict.reason,
            // A chained head is judged against its own digests, so a file put
            // back to the chain root's pristine original is `content-changed`
            // to the detector; to the developer it is the original restored.
            observation:
              judged.kind === 'file-missing'
                ? 'file-missing'
                : observation.kind === 'not-regular'
                  ? 'not-a-regular-file'
                  : judged.actualHash === pristineHash
                    ? 'reverted-to-original'
                    : 'content-changed',
            backupNote,
            backupVerified: original.available,
            originalBackupPath,
          };
        }

        // `already-reverted`: the file holds the bytes the head replaced. The
        // detector reports no conflict for it, because nothing is left to
        // restore; the watcher still must (the product did not write those
        // bytes last), so the report is composed through the same builder
        // cleanup uses.
        //
        // For an unchained head those bytes are the pristine original, and the
        // tool's own change is the report's one diff. For a chained head they
        // are the previous plan version's instrumented output, which still
        // carries the tool's wrapper: the developer did not restore the
        // original, and the head's diff starts from those intermediate bytes,
        // so it is no "original → instrumented" view and no diff is offered.
        const chained = head.previousRecordId !== undefined;
        const report = buildConflictReport({
          record: head,
          reason: 'content-changed',
          detectedAt: judged.detectedAt,
          actualHash: judged.actualHash,
          message: sentence,
          diffs:
            !chained && head.diff.length > 0 ? { originalToInstrumented: head.diff } : undefined,
          chainRoot,
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
          observation: chained ? 'content-changed' : 'reverted-to-original',
          backupNote,
          backupVerified: original.available,
          originalBackupPath,
        };
      }
    }

    // The detector could not be consulted or could not answer. The file still
    // differs from what the tool wrote, so the conflict stands; it is reported
    // with what is known, without a diff — still naming the chain root's
    // backup for a chained head.
    const reason: ModificationConflictReason =
      observation.kind === 'missing' ? 'file-missing' : 'content-changed';
    const report = buildConflictReport({
      record: head,
      reason,
      detectedAt: stamp(),
      actualHash: observation.kind === 'regular' ? observation.hash : undefined,
      message: sentence,
      chainRoot,
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
            : observation.kind === 'regular' && observation.hash === pristineHash
              ? 'reverted-to-original'
              : 'content-changed',
      backupNote: undefined,
      backupVerified: false,
      originalBackupPath,
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
    // The one path the sentence names and the notice carries: the report's
    // pristine original when there is a report, the finding's otherwise —
    // for a chained record, the chain root's backup either way.
    const backupPath =
      conflict === undefined ? finding.originalBackupPath : originalBackupPathOf(record, conflict);
    const message =
      conflict === undefined
        ? composeConflictSentence(record.file, backupPath)
        : buildConflictMessage(record, conflict);
    const notice: ConflictNotice = Object.freeze({
      message,
      detail: composeConflictDetail(finding.observation, record.id, finding.backupNote),
      action: 'open-diff',
      recordId: record.id,
      file: record.file,
      backupPath,
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
   * or re-headed entry — and every entry re-attached out of a watch recovery —
   * is evaluated once. An entry whose directory watch the platform refuses
   * enters that directory's recovery.
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
    const refusedByDirectory = new Map<string, WatchEntry[]>();

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
      // This rebuild's own chain check found no link on the way to the file.
      entry.unsafeSegment = undefined;
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
          recovery: undefined,
          unsafeSegment: undefined,
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

      // An entry waiting in a recovery that this rebuild re-attaches leaves it
      // (cancelling the recovery once nothing else waits) and is evaluated
      // once, for an edit made while it was unwatched.
      const wasWaiting = entry.recovery !== undefined;
      const refused = attach(entry);

      if (refused === undefined) {
        if (wasWaiting && !toEvaluate.includes(entry)) {
          toEvaluate.push(entry);
        }

        continue;
      }

      issues.push(
        makeIssue(session, {
          kind: 'watch-failed',
          code: 'INSTRUMENTATION_UNAVAILABLE',
          file: wanted.head.file,
          recordId: wanted.head.id,
          message:
            "The platform refused a watch on the file's directory. It is retried with backoff; until then the file is checked on every retry, and cleanup checks it before restoring anything.",
          errno: refused,
        }),
      );
      appendTo(refusedByDirectory, entry.directory, entry);
    }

    session.issues = issues;

    // One recovery per refused directory, entered once with all of its files,
    // so the session is told in one row per directory.
    for (const [directory, refusedEntries] of refusedByDirectory) {
      enterRecovery(directory, refusedEntries, 'refused');
    }

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

    // Stopping every session already emptied every recovery; any one left is
    // cancelled here so no retry timer outlives the watcher.
    for (const recovery of [...recoveries.values()]) {
      endRecovery(recovery);
    }

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
