/**
 * The retention sweep: the one module that deletes aged state from the session
 * database and from the `$DEBUGGEN_HOME` directory tree.
 *
 * Everything the product keeps about a debugging session lives outside the
 * developer's project — a row per session and its children in
 * `sessions.sqlite`, one backup directory per session under `backups/`, and
 * the code-index cache under `index/` (AAP 0.4.2). None of it is needed
 * forever, and some of it is sensitive: questions, file paths, redacted
 * telemetry. This module removes what has aged out, and it is written around
 * the one thing it must never do — destroy the only copy of a developer's
 * original file.
 *
 * ## The three rules, in the order they run
 *
 * 1. **Aged sessions.** A session whose `sessions.updated_at` — its last
 *    activity, not its creation — is older than the retention window is
 *    deleted, and the schema's `ON DELETE CASCADE` edges remove everything
 *    scoped to it: progress, plans, the modification journal, captures and
 *    their telemetry, panels, analyses, follow-ups, its tab binding and its
 *    request-key secret. Its backup directory is removed afterwards. A session
 *    whose journal still holds a `conflict` record is **retained** — together
 *    with its backups — until the developer resolves the conflict (AAP 0.5.1).
 * 2. **Orphan backups.** A file under `backups/<sessionId>/` that no journal
 *    row references is deleted once it is older than
 *    {@link ORPHAN_BACKUP_GRACE_DAYS}. The grace window exists because the
 *    patcher writes the backup *before* it journals the record: a crash in
 *    between leaves a legitimately unreferenced file, and a concurrent install
 *    may be about to claim a younger one.
 * 3. **Index caches.** An entry of the code-index cache whose project has not
 *    been opened inside the window is deleted. A cache is a derived artifact:
 *    deleting one costs a re-index, never data.
 *
 * Then, and only when the sweep deleted a session, the write-ahead log is
 * folded back into the database; `VACUUM` runs only when a caller asks for it
 * explicitly, because it rewrites the whole file and must never sit on the
 * start-up path.
 *
 * ## Where this runs
 *
 * `src/main.ts` runs start-up modification reconciliation first and this sweep
 * second, before the service accepts a client, and the editor command
 * `debuggen.purgeSessions` runs it on demand. Because reconciliation has
 * already moved every `pending`, `applied` and `failed` record to `reverted`
 * or `conflict` by the time the start-up sweep runs, `conflict` is the
 * realistic open state here — which is why the conflict exemption is the rule
 * that protects real developer data. A session still holding some *other*
 * open record is not purged either: the journal is the only description of a
 * patched file, so the session is retained and the fact is reported as a
 * {@link RetentionIssue} for the next reconciliation to settle.
 *
 * ## Containment
 *
 * Nothing outside `$DEBUGGEN_HOME` may ever be touched — least of all a file
 * inside a developer's project — so every destructive helper below:
 *
 * - takes the resolved absolute path and re-asserts `isWithin(debuggenHome,
 *   path)` **immediately before** the `unlink`, `rmdir` or `rm` call, so no
 *   future caller can skip the check;
 * - `lstat`s the target and refuses a symbolic link rather than following it —
 *   never `realpath`-then-delete;
 * - re-`lstat`s the containing directory and compares its device and inode
 *   with what the walk observed, so a directory swapped for a link between the
 *   decision and the deletion is refused instead of redirecting the operation.
 *
 * `isWithin` is lexical — it treats `/home-evil` as outside `/home` but cannot
 * see a link — which is why every containment check has an `lstat` beside it.
 * A tree is surveyed before it is removed, and one that holds a link anywhere
 * inside it is reported and left in place rather than removed; `fs.rm` with
 * `recursive` would only unlink such a link and never reach its target, which
 * is the second line of defence should one appear after the survey.
 *
 * ## Results and resilience
 *
 * {@link runRetention} answers with a `Result`. An `Err` means the sweep could
 * not run at all — a closed store, a configuration whose paths are not nested
 * inside the state root, an unusable clock. Every per-item problem (a backup
 * that cannot be removed, a planted link, a row that no longer parses) is
 * recorded in {@link RetentionReport.errors} and the sweep continues: the
 * guarantee is that one bad item never aborts the pass.
 *
 * ## Privacy
 *
 * Log records and the report carry counts, session ids, error codes and paths
 * **relative to `$DEBUGGEN_HOME`** only. No file content, no diff, no question
 * and no request-key secret is read into a log line or a report field; an
 * index-cache entry is parsed only for its `projectRoot`, which is compared and
 * never emitted.
 *
 * @packageDocumentation
 */

import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, readdir, rm, rmdir, unlink } from 'node:fs/promises';

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
  nowEpochMs,
  ok,
  relativePosix,
} from '@debuggen/shared';
import type { Logger, Result, SessionId } from '@debuggen/shared';

import { DEFAULT_RETENTION_DAYS } from '../config.js';
import type { ServiceConfig } from '../config.js';
import type { Store } from './db.js';
import type { ListBackupPathsOptions, ModificationsRepo } from './modifications-repo.js';
import type { PanelsRepo } from './panels-repo.js';
import { MAX_SESSION_LIST_LIMIT } from './sessions-repo.js';
import type { SessionListItem, SessionsRepo } from './sessions-repo.js';
import { DEFAULT_PURGE_BATCH_SIZE } from './telemetry-repo.js';
import type { TelemetryRepo } from './telemetry-repo.js';

/* -------------------------------------------------------------------------------------------------
 * Public constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The retention window, in days, used when the configured one is unusable.
 *
 * Re-exported from `../config.ts` rather than restated, so the documented
 * default of AAP 0.3.4 is one binding however it is imported. The real default
 * reaches this module through `ServiceConfig.retentionDays`, which the
 * configuration loader defaults from `DEBUGGEN_RETENTION_DAYS`; this value is
 * the fallback for a hand-assembled configuration whose window is not a
 * non-negative number.
 */
export { DEFAULT_RETENTION_DAYS };

/**
 * How long an unreferenced backup file is kept before the orphan rule removes
 * it: **7** days (AAP 0.4.2).
 *
 * The patcher's crash-safe sequence copies the original bytes to the backup
 * directory and `fsync`s them *before* it journals the `ModificationRecord`
 * that references them. A crash between those two steps leaves a file no row
 * names — expected, not corrupt — and an install running right now may be a
 * moment away from journalling a file this sweep would otherwise call an
 * orphan. A week is long enough that neither case is ever at risk and short
 * enough that crash debris does not accumulate.
 */
export const ORPHAN_BACKUP_GRACE_DAYS = 7;

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/** Where a {@link RetentionIssue} arose. */
export type RetentionIssueScope = 'session' | 'backup' | 'index-cache' | 'database';

/**
 * One per-item problem the sweep recorded and stepped over.
 *
 * `message` is the `message` of a {@link DebuggenError} payload — a complete
 * sentence naming the item and the failure's code — never a raw stack or an
 * engine message that could quote an absolute path or a value.
 */
export interface RetentionIssue {
  /** Which part of the sweep the problem belongs to. */
  readonly scope: RetentionIssueScope;

  /**
   * What the problem is about: a session id for `session`, a path relative to
   * `$DEBUGGEN_HOME` for `backup` and `index-cache`, or the operation's name
   * (`sessions.list`, `checkpoint`, `vacuum`) for `database`.
   */
  readonly target: string;

  /** The problem, as a sentence safe to show and to log. */
  readonly message: string;
}

/** Tuning for one {@link runRetention} call. Every member is optional. */
export interface RetentionOptions {
  /**
   * The retention window in days, overriding `config.retentionDays` for this
   * call. A finite, non-negative number; `0` purges everything eligible.
   */
  readonly retentionDays?: number | undefined;

  /**
   * The orphan-backup grace window in days. Defaults to
   * {@link ORPHAN_BACKUP_GRACE_DAYS}; a finite, non-negative number.
   */
  readonly orphanBackupGraceDays?: number | undefined;

  /**
   * Compute and report without deleting anything. Every read the real sweep
   * performs is performed, no row is deleted, no file or directory is removed
   * and no checkpoint or `VACUUM` runs; the report holds the counts the real
   * sweep would have produced. Backs the tests and a "what would be purged"
   * affordance. Defaults to `false`.
   */
  readonly dryRun?: boolean | undefined;

  /**
   * Run `VACUUM` after the sweep. Defaults to **`false`**: `VACUUM` rewrites
   * the whole database, holds the write lock for as long as that takes, and
   * must never run on the start-up path. Ignored when {@link dryRun} is set.
   */
  readonly vacuum?: boolean | undefined;
}

/**
 * What one sweep removed — or, for a dry run, would have removed.
 *
 * Arrays are sorted, and the traversal order is fixed, so two sweeps over the
 * same state produce the same report apart from {@link durationMs}.
 */
export interface RetentionReport {
  /**
   * The age threshold, in epoch milliseconds: a session last updated strictly
   * before this instant was a purge candidate, and an index-cache entry last
   * written before it was eligible.
   */
  readonly cutoff: number;

  /** How many sessions were deleted. */
  readonly sessionsDeleted: number;

  /** Their ids, sorted. */
  readonly sessionIdsDeleted: readonly string[];

  /** How many telemetry events those sessions held. */
  readonly telemetryEventsDeleted: number;

  /** How many panels those sessions held. */
  readonly panelsDeleted: number;

  /** How many analyses those sessions held. */
  readonly analysesDeleted: number;

  /** How many modification-journal records those sessions held. */
  readonly modificationsDeleted: number;

  /**
   * How many backup directories were removed: the directories of purged
   * sessions, and session directories the orphan rule left empty.
   */
  readonly backupDirsDeleted: number;

  /** How many unreferenced backup files older than the grace window were removed. */
  readonly orphanBackupsDeleted: number;

  /** How many code-index cache entries were removed. */
  readonly indexCachesDeleted: number;

  /**
   * Aged sessions kept because their journal holds a `conflict` record, sorted.
   * Their rows and their backups stay until the conflict is resolved.
   */
  readonly sessionsRetainedForConflicts: readonly string[];

  /**
   * The bytes of the files removed from `$DEBUGGEN_HOME`, from their `lstat`
   * sizes. Database pages freed by the purge are not included: SQLite reuses
   * them, and only a `VACUUM` returns them to the filesystem.
   */
  readonly bytesReclaimed?: number;

  /** How long the sweep took, in milliseconds of monotonic time. */
  readonly durationMs: number;

  /** Every per-item problem, in the order it was met. */
  readonly errors: readonly RetentionIssue[];
}

/**
 * What {@link runRetention} works with. Every collaborator is injected, so the
 * sweep owns no connection, reads no environment variable and recomputes no
 * path.
 */
export interface RetentionDeps {
  /** The open, migrated store the repositories below are built over. */
  readonly store: Store;

  /** Candidate sessions and the project roots active inside the window. */
  readonly sessions: SessionsRepo;

  /** Per-session event counts, and the batched purge of very large sessions. */
  readonly telemetry: TelemetryRepo;

  /** The conflict exemption, the open-record check and the referenced backup paths. */
  readonly modifications: ModificationsRepo;

  /** Per-session panel and analysis counts. */
  readonly panels: PanelsRepo;

  /**
   * The resolved paths and the window. `debuggenHome` is the containment
   * boundary for every deletion; `backupsDir` and `indexCacheDir` must lie
   * strictly inside it.
   */
  readonly config: Pick<
    ServiceConfig,
    'debuggenHome' | 'backupsDir' | 'indexCacheDir' | 'retentionDays'
  >;

  /** Where the sweep reports. Defaults to the shared no-op logger. */
  readonly logger?: Logger | undefined;

  /** The current epoch-millisecond time. Defaults to `nowEpochMs()`. */
  readonly now?: (() => number) | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Internal constants
 * ---------------------------------------------------------------------------------------------- */

/** Milliseconds in one day, the unit both windows are configured in. */
const MS_PER_DAY = 86_400_000;

/** The `subsystem` binding every record from this module carries. */
const SUBSYSTEM = 'store';

/** The `repo` binding every record from this module carries, beside the repositories' own. */
const COMPONENT = 'retention';

/**
 * The status a record reaches once its file is restored — the only status in
 * which a record no longer describes a patched file.
 *
 * Typed through the journal's own method so the literal is checked against the
 * status vocabulary `@debuggen/instrumentation` defines, rather than restated.
 */
const REVERTED_STATUS: Parameters<ModificationsRepo['updateStatus']>[1] = 'reverted';

/** The one status the conflict exemption protects. */
const CONFLICT_STATUSES: NonNullable<ListBackupPathsOptions['statuses']> = ['conflict'];

/**
 * The largest index-cache document read for its `projectRoot`: 64 MiB.
 *
 * A document is parsed only when its entry is already older than the window,
 * to decide whether a recently active project still owns it. One beyond this
 * size is judged by its modification time alone — the conservative fallback
 * for a derived artifact.
 */
const MAX_INDEX_METADATA_BYTES = 64 * 1024 * 1024;

/**
 * How many `*.json` files directly inside a directory-shaped index-cache entry
 * are consulted for a `projectRoot` before the entry is judged by age alone.
 */
const MAX_INDEX_METADATA_FILES = 8;

/**
 * How deep the survey of a tree about to be removed descends. A session backup
 * directory is two levels deep, with relocated backups one level further; the
 * bound keeps the walk finite over a tree someone has filled by hand.
 */
const MAX_MEASURE_DEPTH = 4;

/** The file extension of a code-index cache entry. */
const INDEX_ENTRY_EXTENSION = '.json';

/**
 * Re-reads a session's last-activity instant inside the deleting transaction,
 * so a session touched after it was listed is never purged.
 */
const SESSION_UPDATED_AT_SQL = 'SELECT updated_at FROM sessions WHERE id = ?';

/**
 * Counts a session's journal records that still describe a patched file,
 * inside the deleting transaction. The journal repository's own checks are
 * asynchronous and therefore cannot run inside `Store.transaction`; this
 * read closes the window between them and the delete.
 */
const SESSION_OPEN_MODIFICATIONS_SQL =
  'SELECT COUNT(*) AS open_records FROM modifications WHERE session_id = ? AND status <> ?';

/** `O_NOFOLLOW` where the platform defines it, so a metadata read never follows a link. */
const OPEN_NO_FOLLOW_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/* -------------------------------------------------------------------------------------------------
 * Internal shapes
 * ---------------------------------------------------------------------------------------------- */

/** The validated inputs of one sweep. */
interface SweepSettings {
  readonly home: string;
  readonly backupsDir: string;
  readonly indexCacheDir: string;
  readonly cutoff: number;
  readonly graceCutoff: number;
  readonly retentionDays: number;
  readonly graceDays: number;
  readonly dryRun: boolean;
  readonly vacuum: boolean;
}

/** Everything one sweep's phases share. */
interface SweepContext {
  readonly deps: RetentionDeps;
  readonly settings: SweepSettings;
  readonly logger: Logger;
}

/** What the phases accumulate; frozen into a {@link RetentionReport} at the end. */
interface SweepState {
  readonly sessionIdsDeleted: string[];
  readonly sessionsRetainedForConflicts: string[];
  readonly errors: RetentionIssue[];
  /**
   * Directories the session phase removed — or, in a dry run, would have
   * removed — so the orphan walk never counts their files a second time.
   */
  readonly removedDirectories: Set<string>;
  telemetryEventsDeleted: number;
  panelsDeleted: number;
  analysesDeleted: number;
  modificationsDeleted: number;
  backupDirsDeleted: number;
  orphanBackupsDeleted: number;
  indexCachesDeleted: number;
  bytesReclaimed: number;
}

/**
 * The device and inode of a directory as the walk observed it. Compared again
 * immediately before a deletion inside that directory.
 */
interface NodeIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** What an `lstat` of a directory the sweep walks may find. */
type DirectoryInspection =
  | { readonly kind: 'absent' }
  | { readonly kind: 'directory'; readonly identity: NodeIdentity }
  | { readonly kind: 'unsafe'; readonly error: DebuggenError };

/**
 * The backup paths the journal still references, read once per phase so every
 * deletion decision in that phase is made against the same snapshot.
 */
interface BackupGuards {
  /** Every path any record references, normalised. */
  readonly referenced: ReadonlySet<string>;
  /** The paths `conflict` records reference — never deleted, whatever else matched. */
  readonly conflicted: ReadonlySet<string>;
}

/** What the in-transaction re-check concluded about one candidate session. */
type SessionEligibility = 'eligible' | 'gone' | 'refreshed' | 'open-modifications';

/** The counts a candidate session contributes to the report once it is deleted. */
interface SessionCounts {
  readonly telemetry: number;
  readonly panels: number;
  readonly analyses: number;
  readonly modifications: number;
}

/* -------------------------------------------------------------------------------------------------
 * Errors and issues
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `code` of a Node filesystem error, or `'unknown'`.
 *
 * Only the code travels into a message: the engine's own message spells the
 * absolute path, which this module reports relative to `$DEBUGGEN_HOME`.
 */
function errnoOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const { code } = cause;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }
  return 'unknown';
}

/** Whether `cause` is the filesystem's "no such file or directory". */
function isMissing(cause: unknown): boolean {
  const code = errnoOf(cause);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * A filesystem operation under `$DEBUGGEN_HOME` that failed.
 *
 * @param operation What was attempted, as a verb phrase ("remove", "read").
 * @param target The path relative to `$DEBUGGEN_HOME`.
 * @param cause The thrown value, kept as the error's `cause`.
 */
function fsFailure(operation: string, target: string, cause: unknown): DebuggenError {
  const errno = errnoOf(cause);
  return new DebuggenError('STORE_ERROR', `Could not ${operation} ${target} (${errno}).`, {
    hint: 'Check that the Debug Generator state directory is owned by you and writable, then run the purge again.',
    details: { subsystem: SUBSYSTEM, component: COMPONENT, operation, target, errno },
    cause,
  });
}

/**
 * A path the sweep refuses to act on: a link, a non-directory where a
 * directory belongs, a path that is not inside the state root, a directory
 * replaced since it was inspected.
 */
function unsafePath(target: string, reason: string, message: string): DebuggenError {
  return new DebuggenError('FS_UNSAFE_PATH', message, {
    hint: 'Nothing was deleted at this path. Inspect it by hand; the next purge will look at it again.',
    details: { subsystem: SUBSYSTEM, component: COMPONENT, target, reason },
  });
}

/** Records one per-item problem and logs it; the sweep then continues. */
function recordIssue(
  context: SweepContext,
  state: SweepState,
  scope: RetentionIssueScope,
  target: string,
  error: DebuggenError,
): void {
  const { message } = error.toPayload();
  state.errors.push({ scope, target, message });
  context.logger.warn('retention sweep skipped an item', {
    scope,
    target,
    code: error.code,
  });
}

/** Whether the store can still be used; records one issue when it cannot. */
function storeUsable(context: SweepContext, state: SweepState, phase: string): boolean {
  if (!context.deps.store.isClosed) {
    return true;
  }
  recordIssue(
    context,
    state,
    'database',
    phase,
    new DebuggenError(
      'STORE_ERROR',
      `The session store closed during the retention sweep (${phase}).`,
      {
        hint: 'The remaining retention work runs on the next start or purge.',
        details: { subsystem: SUBSYSTEM, component: COMPONENT, phase },
      },
    ),
  );
  return false;
}

/* -------------------------------------------------------------------------------------------------
 * Paths and containment
 * ---------------------------------------------------------------------------------------------- */

/** Whether `path` is absolute in either spelling the configuration may produce. */
function isAbsolutePath(path: string): boolean {
  return isAbsolutePosix(path) || isWindowsAbsolute(path);
}

/**
 * `path` relative to the state root, for a log line or a report field.
 * Only ever called for a path already proven to be inside it.
 */
function relativeToHome(home: string, path: string): string {
  return relativePosix(home, path);
}

/**
 * Whether `path` lies strictly inside `home` — never the root itself, never a
 * sibling that merely shares its prefix. The containment half of every
 * destructive helper; the `lstat` half sits beside each call.
 */
function isStrictlyWithin(home: string, path: string): boolean {
  const normalized = normalizePosix(path);
  return isAbsolutePath(normalized) && normalized !== home && isWithin(home, normalized);
}

/**
 * The containment refusal, built once so every helper words it the same way.
 * The target is reported as the bare name, because a path outside the root has
 * no spelling relative to it.
 */
function outsideHome(path: string): DebuggenError {
  return unsafePath(
    basenamePosix(path),
    'outside-state-root',
    `Refused to delete ${basenamePosix(path)}: it is not inside the Debug Generator state directory.`,
  );
}

/** `lstat`, answering `undefined` for a path that does not exist. */
async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (cause) {
    if (isMissing(cause)) {
      return undefined;
    }
    throw cause;
  }
}

/** The identity an `lstat` reported. */
function identityOf(stats: Stats): NodeIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

/**
 * Whether the directory at `path` is still the real directory the walk
 * observed: present, not a link, same device and inode.
 */
async function directoryUnchanged(path: string, expected: NodeIdentity): Promise<boolean> {
  const current = await lstatIfPresent(path);
  return (
    current !== undefined &&
    !current.isSymbolicLink() &&
    current.isDirectory() &&
    current.dev === expected.dev &&
    current.ino === expected.ino
  );
}

/**
 * Inspects a directory the sweep is about to walk: absent, a real directory,
 * or something it must not descend into.
 */
async function inspectDirectory(home: string, path: string): Promise<DirectoryInspection> {
  const target = relativeToHome(home, path);
  let stats: Stats | undefined;
  try {
    stats = await lstatIfPresent(path);
  } catch (cause) {
    return { kind: 'unsafe', error: fsFailure('inspect', target, cause) };
  }
  if (stats === undefined) {
    return { kind: 'absent' };
  }
  if (stats.isSymbolicLink()) {
    return {
      kind: 'unsafe',
      error: unsafePath(
        target,
        'symlink',
        `${target} is a symbolic link; the retention sweep does not follow it and left it in place.`,
      ),
    };
  }
  if (!stats.isDirectory()) {
    return {
      kind: 'unsafe',
      error: unsafePath(
        target,
        'not-a-directory',
        `${target} is not a directory; the retention sweep left it in place.`,
      ),
    };
  }
  return { kind: 'directory', identity: identityOf(stats) };
}

/**
 * Orders two strings by UTF-16 code unit — locale-independent, so the order
 * every walk and every report array uses is the same on every machine.
 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The names inside a directory, sorted so the traversal order is fixed. */
async function listNames(path: string): Promise<string[]> {
  const names = await readdir(path);
  return names.sort(compareText);
}

/* -------------------------------------------------------------------------------------------------
 * Destructive helpers
 *
 * The only three functions in this module that remove anything. Each takes the
 * state root and the resolved absolute path, and each re-asserts containment
 * as the statement immediately before its destructive call — so the check
 * cannot be skipped by a caller that forgot it, and nothing between the check
 * and the call can move the path. Each `lstat`s its target and refuses a link,
 * and each re-verifies the containing directory against the identity the walk
 * observed. None of them follows a link, and none resolves a path with
 * `realpath` before deleting it.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Removes one regular file inside the state root.
 *
 * @param home The state root.
 * @param path The file's resolved absolute path.
 * @param parent The identity of its directory as the walk observed it.
 * @param expected The file's own identity as the walk observed it; a file
 * replaced since is left alone.
 * @returns `ok(bytes)` with the removed file's size, `ok(0)` when it had
 * already gone, or the refusal.
 */
async function removeFileWithin(
  home: string,
  path: string,
  parent: NodeIdentity,
  expected: NodeIdentity,
): Promise<Result<number, DebuggenError>> {
  if (!isStrictlyWithin(home, path)) {
    return err(outsideHome(path));
  }
  const target = relativeToHome(home, path);

  try {
    if (!(await directoryUnchanged(dirnamePosix(path), parent))) {
      return err(
        unsafePath(
          target,
          'directory-changed',
          `The directory holding ${target} changed while the retention sweep ran; nothing was deleted.`,
        ),
      );
    }

    const stats = await lstatIfPresent(path);
    if (stats === undefined) {
      return ok(0);
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return err(
        unsafePath(
          target,
          stats.isSymbolicLink() ? 'symlink' : 'not-a-regular-file',
          `${target} is not a regular file; the retention sweep left it in place.`,
        ),
      );
    }
    if (stats.dev !== expected.dev || stats.ino !== expected.ino) {
      return err(
        unsafePath(
          target,
          'file-replaced',
          `${target} was replaced while the retention sweep ran; nothing was deleted.`,
        ),
      );
    }

    if (!isStrictlyWithin(home, path)) {
      return err(outsideHome(path));
    }
    await unlink(path);
    return ok(stats.size);
  } catch (cause) {
    if (isMissing(cause)) {
      return ok(0);
    }
    return err(fsFailure('remove', target, cause));
  }
}

/**
 * Removes one directory tree inside the state root.
 *
 * `fs.rm` with `recursive` unlinks a link it meets inside the tree instead of
 * descending into it, so nothing a link points at is reached; the directory
 * itself must be a real directory, verified by `lstat` here.
 *
 * @param home The state root.
 * @param path The directory's resolved absolute path.
 * @param parent The identity of its parent directory as the walk observed it.
 * @param expected The directory's own identity as the walk observed it.
 * @returns `ok(true)` when the tree was removed, `ok(false)` when it had
 * already gone, or the refusal.
 */
async function removeTreeWithin(
  home: string,
  path: string,
  parent: NodeIdentity,
  expected: NodeIdentity,
): Promise<Result<boolean, DebuggenError>> {
  if (!isStrictlyWithin(home, path)) {
    return err(outsideHome(path));
  }
  const target = relativeToHome(home, path);

  try {
    if (!(await directoryUnchanged(dirnamePosix(path), parent))) {
      return err(
        unsafePath(
          target,
          'directory-changed',
          `The directory holding ${target} changed while the retention sweep ran; nothing was deleted.`,
        ),
      );
    }

    const stats = await lstatIfPresent(path);
    if (stats === undefined) {
      return ok(false);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return err(
        unsafePath(
          target,
          stats.isSymbolicLink() ? 'symlink' : 'not-a-directory',
          `${target} is not a directory; the retention sweep left it in place.`,
        ),
      );
    }
    if (stats.dev !== expected.dev || stats.ino !== expected.ino) {
      return err(
        unsafePath(
          target,
          'directory-replaced',
          `${target} was replaced while the retention sweep ran; nothing was deleted.`,
        ),
      );
    }

    if (!isStrictlyWithin(home, path)) {
      return err(outsideHome(path));
    }
    await rm(path, { recursive: true, force: true });
    return ok(true);
  } catch (cause) {
    if (isMissing(cause)) {
      return ok(false);
    }
    return err(fsFailure('remove', target, cause));
  }
}

/**
 * Removes one directory inside the state root **only if it is empty**.
 *
 * `rmdir` refuses a non-empty directory atomically, so a backup written into
 * the directory after the walk looked at it keeps the directory alive: that
 * refusal is an ordinary outcome here, not an error.
 *
 * @param home The state root.
 * @param path The directory's resolved absolute path.
 * @param parent The identity of its parent directory as the walk observed it.
 * @param expected The directory's own identity as the walk observed it.
 * @returns `ok(true)` when it was removed, `ok(false)` when it was no longer
 * empty or had already gone, or the refusal.
 */
async function removeEmptyDirectoryWithin(
  home: string,
  path: string,
  parent: NodeIdentity,
  expected: NodeIdentity,
): Promise<Result<boolean, DebuggenError>> {
  if (!isStrictlyWithin(home, path)) {
    return err(outsideHome(path));
  }
  const target = relativeToHome(home, path);

  try {
    if (!(await directoryUnchanged(dirnamePosix(path), parent))) {
      return err(
        unsafePath(
          target,
          'directory-changed',
          `The directory holding ${target} changed while the retention sweep ran; nothing was deleted.`,
        ),
      );
    }
    if (!(await directoryUnchanged(path, expected))) {
      return ok(false);
    }

    if (!isStrictlyWithin(home, path)) {
      return err(outsideHome(path));
    }
    await rmdir(path);
    return ok(true);
  } catch (cause) {
    const errno = errnoOf(cause);
    if (isMissing(cause) || errno === 'ENOTEMPTY' || errno === 'EEXIST') {
      return ok(false);
    }
    return err(fsFailure('remove', target, cause));
  }
}

/** What {@link surveyTree} found in a tree it is about to be asked to remove. */
interface TreeSurvey {
  /** The total `lstat` size of its regular files, for {@link RetentionReport.bytesReclaimed}. */
  bytes: number;
  /** The first symbolic link met inside the tree, if any, as an absolute path. */
  link: string | undefined;
}

/**
 * Surveys a tree before it is removed: the byte total of its regular files, and
 * whether a symbolic link sits anywhere inside it.
 *
 * Read-only. Links are recorded and never followed, the walk stops at
 * {@link MAX_MEASURE_DEPTH}, and an entry that cannot be inspected contributes
 * nothing — the removal itself reports the failure that matters.
 *
 * A link inside a tree this module is about to delete is not a layout the
 * product writes, so its presence is treated as a reason **not** to remove the
 * tree: `fs.rm` would only unlink the link and never reach its target, but a
 * planted link is exactly the anomaly a developer should look at, and the
 * orphan rule still judges the regular files beside it one by one.
 */
async function surveyTree(
  path: string,
  survey: TreeSurvey = { bytes: 0, link: undefined },
  depth = 0,
): Promise<TreeSurvey> {
  let stats: Stats | undefined;
  try {
    stats = await lstatIfPresent(path);
  } catch {
    return survey;
  }
  if (stats === undefined) {
    return survey;
  }
  if (stats.isSymbolicLink()) {
    survey.link ??= path;
    return survey;
  }
  if (stats.isFile()) {
    survey.bytes += stats.size;
    return survey;
  }
  if (!stats.isDirectory() || depth >= MAX_MEASURE_DEPTH) {
    return survey;
  }
  let names: string[];
  try {
    names = await listNames(path);
  } catch {
    return survey;
  }
  for (const name of names) {
    await surveyTree(joinPosix(path, name), survey, depth + 1);
  }
  return survey;
}

/** The refusal to remove a tree that holds a symbolic link. */
function treeHoldsLink(home: string, tree: string, link: string): DebuggenError {
  const target = relativeToHome(home, tree);
  const linkTarget = relativeToHome(home, link);
  return unsafePath(
    target,
    'contains-symlink',
    `${target} contains the symbolic link ${linkTarget}; the retention sweep does not remove a tree holding a link and left it in place.`,
  );
}

/* -------------------------------------------------------------------------------------------------
 * Settings
 * ---------------------------------------------------------------------------------------------- */

/** A configuration or option the sweep cannot run with. */
function invalidSetting(field: string, expected: string): DebuggenError {
  return new DebuggenError(
    'CONFIG_INVALID',
    `The retention sweep cannot run: ${field} must be ${expected}.`,
    {
      hint: 'Pass the resolved service configuration from src/config.ts, whose paths are nested inside DEBUGGEN_HOME, and a non-negative retention window.',
      details: { subsystem: SUBSYSTEM, component: COMPONENT, field },
    },
  );
}

/** Whether `value` is a usable window length in days. */
function isWindowDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validates the injected configuration, options and clock, and derives the two
 * cutoffs.
 *
 * The retention window comes from `options.retentionDays` when a caller passes
 * one (and an unusable one is refused), otherwise from `config.retentionDays`;
 * a configured window that is not a non-negative number falls back to
 * {@link DEFAULT_RETENTION_DAYS} with a warning, because widening to the
 * documented default keeps *more* data, which is the safe direction for a
 * module that deletes.
 *
 * The containment boundary must be an absolute path that is not a filesystem
 * root, and both swept directories must lie strictly inside it: a
 * configuration that pointed `backupsDir` outside `$DEBUGGEN_HOME` would make
 * every containment check below refuse every deletion, so it is rejected once,
 * up front, as `CONFIG_INVALID`.
 */
function resolveSettings(
  deps: RetentionDeps,
  options: RetentionOptions,
  logger: Logger,
): Result<SweepSettings, DebuggenError> {
  const { config } = deps;

  const home = typeof config.debuggenHome === 'string' ? normalizePosix(config.debuggenHome) : '';
  if (!isAbsolutePath(home) || dirnamePosix(home) === home) {
    return err(
      invalidSetting('debuggenHome', 'an absolute directory path that is not a filesystem root'),
    );
  }

  const backupsDir = typeof config.backupsDir === 'string' ? normalizePosix(config.backupsDir) : '';
  if (!isStrictlyWithin(home, backupsDir)) {
    return err(invalidSetting('backupsDir', 'an absolute path strictly inside debuggenHome'));
  }

  const indexCacheDir =
    typeof config.indexCacheDir === 'string' ? normalizePosix(config.indexCacheDir) : '';
  if (!isStrictlyWithin(home, indexCacheDir)) {
    return err(invalidSetting('indexCacheDir', 'an absolute path strictly inside debuggenHome'));
  }

  let retentionDays: number;
  if (options.retentionDays !== undefined) {
    if (!isWindowDays(options.retentionDays)) {
      return err(invalidSetting('retentionDays', 'a finite, non-negative number of days'));
    }
    retentionDays = options.retentionDays;
  } else if (isWindowDays(config.retentionDays)) {
    retentionDays = config.retentionDays;
  } else {
    logger.warn('configured retention window is unusable; using the documented default', {
      defaultDays: DEFAULT_RETENTION_DAYS,
    });
    retentionDays = DEFAULT_RETENTION_DAYS;
  }

  const graceDays = options.orphanBackupGraceDays ?? ORPHAN_BACKUP_GRACE_DAYS;
  if (!isWindowDays(graceDays)) {
    return err(invalidSetting('orphanBackupGraceDays', 'a finite, non-negative number of days'));
  }

  let now: number;
  try {
    now = (deps.now ?? nowEpochMs)();
  } catch (cause) {
    return err(DebuggenError.from(cause, 'CONFIG_INVALID'));
  }
  if (!Number.isFinite(now)) {
    return err(invalidSetting('now()', 'a finite epoch-millisecond reading'));
  }

  const cutoff = now - retentionDays * MS_PER_DAY;
  const graceCutoff = now - graceDays * MS_PER_DAY;
  if (!Number.isFinite(cutoff) || !Number.isFinite(graceCutoff)) {
    return err(invalidSetting('the retention window', 'small enough to express as an instant'));
  }

  return ok({
    home,
    backupsDir,
    indexCacheDir,
    cutoff,
    graceCutoff,
    retentionDays,
    graceDays,
    dryRun: options.dryRun === true,
    vacuum: options.vacuum === true,
  });
}

/* -------------------------------------------------------------------------------------------------
 * Journal snapshots
 * ---------------------------------------------------------------------------------------------- */

/**
 * Reads the backup paths the journal references — all of them, and the
 * `conflict` ones separately — normalised for comparison with walked paths.
 *
 * Both reads must succeed: without them no file under `backups/` can be told
 * apart from an orphan, so a failure makes the caller delete nothing there.
 */
async function readBackupGuards(
  modifications: ModificationsRepo,
): Promise<Result<BackupGuards, DebuggenError>> {
  const referenced = await modifications.listBackupPaths();
  if (isErr(referenced)) {
    return referenced;
  }
  const conflicted = await modifications.listBackupPaths({ statuses: CONFLICT_STATUSES });
  if (isErr(conflicted)) {
    return conflicted;
  }
  return ok({
    referenced: new Set(referenced.value.map((path) => normalizePosix(path))),
    conflicted: new Set(conflicted.value.map((path) => normalizePosix(path))),
  });
}

/** A `sessions` column value as an integer, or `undefined`. */
function readInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return undefined;
}

/**
 * Re-checks one candidate against the database as it stands **now**.
 *
 * Runs inside the deleting transaction in a real sweep (and as a plain read in
 * a dry run): the row must still exist, must still be older than the cutoff —
 * a session touched after it was listed has become active again and is never
 * purged mid-flight — and must hold no journal record that still describes a
 * patched file.
 */
function checkEligibility(store: Store, sessionId: SessionId, cutoff: number): SessionEligibility {
  const row = store.statement(SESSION_UPDATED_AT_SQL).get(sessionId);
  if (row === undefined) {
    return 'gone';
  }
  const updatedAt = readInteger(row['updated_at']);
  if (updatedAt === undefined || updatedAt >= cutoff) {
    return 'refreshed';
  }
  const open = store.statement(SESSION_OPEN_MODIFICATIONS_SQL).get(sessionId, REVERTED_STATUS);
  const openRecords = open === undefined ? undefined : readInteger(open['open_records']);
  if (openRecords === undefined || openRecords > 0) {
    return 'open-modifications';
  }
  return 'eligible';
}

/**
 * {@link checkEligibility} outside a transaction, as a `Result`: the precheck
 * of a real sweep and the whole check of a dry run. A read the store refuses
 * (the handle closed, a statement that no longer prepares) becomes a per-item
 * issue rather than an exception that would end the pass.
 */
function readEligibility(
  store: Store,
  sessionId: SessionId,
  cutoff: number,
): Result<SessionEligibility, DebuggenError> {
  try {
    return ok(checkEligibility(store, sessionId, cutoff));
  } catch (caught) {
    return err(DebuggenError.from(caught, 'STORE_ERROR'));
  }
}

/* -------------------------------------------------------------------------------------------------
 * Rule 1 — aged sessions
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every session last updated strictly before `cutoff`, sorted by id.
 *
 * The age basis is **`sessions.updated_at`** — the session's last activity —
 * not `created_at`: a long-running session is refreshed by every progress
 * step, capture and follow-up, so it can never age out mid-flight however long
 * ago it was created. `SessionsRepo.list({ updatedBefore })` is the candidate
 * query, served by the `updated_at` index. Pages are read in full before any
 * deletion, so the purge cannot shift the offsets it pages with; an id seen
 * twice across pages (a concurrent update reordering the list) is kept once.
 */
function listAgedSessions(
  sessions: SessionsRepo,
  cutoff: number,
): Result<SessionListItem[], DebuggenError> {
  const seen = new Map<string, SessionListItem>();
  let offset = 0;

  for (;;) {
    const page = sessions.list({ updatedBefore: cutoff, limit: MAX_SESSION_LIST_LIMIT, offset });
    if (isErr(page)) {
      return page;
    }
    for (const item of page.value.items) {
      if (!seen.has(item.id)) {
        seen.set(item.id, item);
      }
    }
    offset += page.value.items.length;
    if (page.value.items.length < MAX_SESSION_LIST_LIMIT || offset >= page.value.total) {
      break;
    }
  }

  return ok([...seen.values()].sort((left, right) => compareText(left.id, right.id)));
}

/**
 * Reads what one candidate holds, so the report states what the cascade
 * removes — a cascade reports no count of its own.
 */
async function countSessionContents(
  deps: RetentionDeps,
  sessionId: SessionId,
): Promise<Result<SessionCounts, DebuggenError>> {
  const telemetry = deps.telemetry.countBySession(sessionId);
  if (isErr(telemetry)) {
    return telemetry;
  }
  const documents = deps.panels.countBySession(sessionId);
  if (isErr(documents)) {
    return documents;
  }
  const modifications = await deps.modifications.countBySession(sessionId);
  if (isErr(modifications)) {
    return modifications;
  }
  return ok({
    telemetry: telemetry.value,
    panels: documents.value.panels,
    analyses: documents.value.analyses,
    modifications: modifications.value,
  });
}

/**
 * Deletes one session row — and, through `ON DELETE CASCADE`, every row scoped
 * to it — in its own transaction.
 *
 * One transaction per session rather than one for the sweep, so a long purge
 * never holds the write lock long enough to stall an ingest batch in flight.
 * The eligibility re-check runs inside the same transaction as the delete, so
 * no update between the two can be lost. A session holding more telemetry than
 * one purge batch has its events removed first, in bounded batches that yield
 * to the event loop, and only then is the row deleted; the batched purge is
 * refused inside a transaction by design, which is why it precedes this one.
 */
async function deleteSession(
  context: SweepContext,
  sessionId: SessionId,
  counts: SessionCounts,
): Promise<Result<SessionEligibility | 'deleted', DebuggenError>> {
  const { store, sessions, telemetry } = context.deps;
  const { cutoff } = context.settings;

  const precheck = readEligibility(store, sessionId, cutoff);
  if (isErr(precheck) || precheck.value !== 'eligible') {
    return precheck;
  }

  if (counts.telemetry > DEFAULT_PURGE_BATCH_SIZE) {
    const purged = await telemetry.deleteBySession(sessionId);
    if (isErr(purged)) {
      return purged;
    }
    context.logger.debug('purged the telemetry of a large session in batches before its row', {
      sessionId,
      events: purged.value,
    });
  }

  try {
    const outcome = store.transaction((): SessionEligibility | 'deleted' => {
      const eligibility = checkEligibility(store, sessionId, cutoff);
      if (eligibility !== 'eligible') {
        return eligibility;
      }
      const deleted = sessions.delete(sessionId);
      if (isErr(deleted)) {
        // Thrown so `Store.transaction` rolls back; caught just below.
        throw deleted.error;
      }
      return deleted.value === 0 ? 'gone' : 'deleted';
    });
    return ok(outcome);
  } catch (caught) {
    return err(DebuggenError.from(caught, 'STORE_ERROR'));
  }
}

/**
 * Removes a purged session's backup directory, `backups/<sessionId>`.
 *
 * Refused, with an issue, when the id does not name a directory directly inside
 * the backups root (an id carrying a separator or a traversal), when the
 * directory is a link or not a directory, when a link sits anywhere inside it,
 * or when it still holds a file that a *remaining* journal record references —
 * another session's, or any `conflict` record's. Such a directory is left for
 * the orphan rule, which judges its files one by one.
 */
async function removeSessionBackups(
  context: SweepContext,
  state: SweepState,
  sessionId: SessionId,
  ownPaths: ReadonlySet<string>,
  guards: BackupGuards,
  backupsRoot: NodeIdentity,
): Promise<void> {
  const { home, backupsDir, dryRun } = context.settings;
  const directory = joinPosix(backupsDir, sessionId);

  if (
    dirnamePosix(directory) !== backupsDir ||
    basenamePosix(directory) !== sessionId ||
    !isStrictlyWithin(home, directory)
  ) {
    recordIssue(
      context,
      state,
      'backup',
      sessionId,
      unsafePath(
        sessionId,
        'unsafe-session-id',
        `The id of session ${sessionId} does not name a directory inside the backups root; no backup directory was touched for it.`,
      ),
    );
    return;
  }

  const target = relativeToHome(home, directory);
  const inspection = await inspectDirectory(home, directory);
  if (inspection.kind === 'absent') {
    return;
  }
  if (inspection.kind === 'unsafe') {
    recordIssue(context, state, 'backup', target, inspection.error);
    return;
  }

  const stillReferenced = [...guards.referenced].filter(
    (path) => isWithin(directory, path) && !ownPaths.has(path),
  );
  const conflicted = [...guards.conflicted].filter((path) => isWithin(directory, path));
  if (stillReferenced.length > 0 || conflicted.length > 0) {
    recordIssue(
      context,
      state,
      'backup',
      target,
      unsafePath(
        target,
        'still-referenced',
        `${target} still holds ${String(stillReferenced.length + conflicted.length)} backup(s) other journal records reference; it was kept and its files are judged by the orphan rule.`,
      ),
    );
    return;
  }

  const survey = await surveyTree(directory);
  if (survey.link !== undefined) {
    recordIssue(context, state, 'backup', target, treeHoldsLink(home, directory, survey.link));
    return;
  }
  if (!dryRun) {
    const removed = await removeTreeWithin(home, directory, backupsRoot, inspection.identity);
    if (isErr(removed)) {
      recordIssue(context, state, 'backup', target, removed.error);
      return;
    }
    if (!removed.value) {
      return;
    }
  }

  state.backupDirsDeleted += 1;
  state.bytesReclaimed += survey.bytes;
  state.removedDirectories.add(directory);
}

/**
 * Rule 1: deletes every aged session that holds no open journal record, and
 * its backup directory.
 *
 * Before anything is deleted for a candidate, the journal is asked whether it
 * still holds a `conflict` record for it. If so, the session is **retained**:
 * AAP 0.5.1 exempts a conflict backup until the developer resolves the
 * conflict, and the journal row is what makes that backup interpretable — it
 * names the file, the hashes and the diff — so the row must outlive the window
 * too. A session holding any other open record (which reconciliation in
 * `src/main.ts` normally settles before this sweep runs) is retained as well
 * and reported, because deleting the only record of a patched file would
 * abandon that file permanently.
 */
async function purgeAgedSessions(context: SweepContext, state: SweepState): Promise<void> {
  const { deps, settings, logger } = context;
  const { modifications } = deps;

  if (!storeUsable(context, state, 'sessions.list')) {
    return;
  }
  const candidates = listAgedSessions(deps.sessions, settings.cutoff);
  if (isErr(candidates)) {
    recordIssue(context, state, 'database', 'sessions.list', candidates.error);
    return;
  }
  if (candidates.value.length === 0) {
    return;
  }

  // Read once for the whole phase: which backup paths remaining records still
  // need, and which a conflict protects. Without them no backup directory can
  // be removed safely, but sessions can still be purged — each one's own
  // records are checked individually below.
  const guards = await readBackupGuards(modifications);
  if (isErr(guards)) {
    recordIssue(context, state, 'database', 'modifications.listBackupPaths', guards.error);
  }
  const backupsRoot = await inspectDirectory(settings.home, settings.backupsDir);
  if (backupsRoot.kind === 'unsafe') {
    recordIssue(
      context,
      state,
      'backup',
      relativeToHome(settings.home, settings.backupsDir),
      backupsRoot.error,
    );
  }

  for (const candidate of candidates.value) {
    if (!storeUsable(context, state, 'sessions.delete')) {
      return;
    }
    const sessionId = candidate.id;

    const conflicts = await modifications.listConflicts(sessionId);
    if (isErr(conflicts)) {
      recordIssue(context, state, 'session', sessionId, conflicts.error);
      continue;
    }
    if (conflicts.value.length > 0) {
      state.sessionsRetainedForConflicts.push(sessionId);
      logger.info('retaining an aged session: its journal holds an unresolved conflict', {
        sessionId,
        conflicts: conflicts.value.length,
      });
      continue;
    }

    const open = await modifications.listOpen(sessionId);
    if (isErr(open)) {
      recordIssue(context, state, 'session', sessionId, open.error);
      continue;
    }
    if (open.value.length > 0) {
      recordIssue(
        context,
        state,
        'session',
        sessionId,
        openRecordsRetained(sessionId, open.value.length),
      );
      continue;
    }

    const counts = await countSessionContents(deps, sessionId);
    if (isErr(counts)) {
      recordIssue(context, state, 'session', sessionId, counts.error);
      continue;
    }
    const own = await modifications.listBackupPaths({ sessionId });
    if (isErr(own)) {
      recordIssue(context, state, 'session', sessionId, own.error);
      continue;
    }

    let outcome: SessionEligibility | 'deleted';
    if (settings.dryRun) {
      const eligibility = readEligibility(deps.store, sessionId, settings.cutoff);
      if (isErr(eligibility)) {
        recordIssue(context, state, 'session', sessionId, eligibility.error);
        continue;
      }
      outcome = eligibility.value === 'eligible' ? 'deleted' : eligibility.value;
    } else {
      const deleted = await deleteSession(context, sessionId, counts.value);
      if (isErr(deleted)) {
        recordIssue(context, state, 'session', sessionId, deleted.error);
        continue;
      }
      outcome = deleted.value;
    }

    if (outcome === 'open-modifications') {
      recordIssue(context, state, 'session', sessionId, openRecordsRetained(sessionId, undefined));
      continue;
    }
    if (outcome !== 'deleted') {
      // Gone already, or touched since it was listed: neither is a problem.
      logger.debug('aged session no longer eligible at deletion time', { sessionId, outcome });
      continue;
    }

    state.sessionIdsDeleted.push(sessionId);
    state.telemetryEventsDeleted += counts.value.telemetry;
    state.panelsDeleted += counts.value.panels;
    state.analysesDeleted += counts.value.analyses;
    state.modificationsDeleted += counts.value.modifications;

    if (!isErr(guards) && backupsRoot.kind === 'directory') {
      await removeSessionBackups(
        context,
        state,
        sessionId,
        new Set(own.value.map((path) => normalizePosix(path))),
        guards.value,
        backupsRoot.identity,
      );
    }
  }
}

/** The issue for an aged session kept because its journal still describes a patched file. */
function openRecordsRetained(sessionId: SessionId, count: number | undefined): DebuggenError {
  const held =
    count === undefined
      ? 'open modification records'
      : `${String(count)} open modification record(s)`;
  return new DebuggenError(
    'CLEANUP_PARTIAL',
    `Session ${sessionId} is past the retention window but still holds ${held}; it was retained because its journal is the only record able to restore those files.`,
    {
      hint: 'Restart the Debug Generator service so start-up reconciliation restores or reports those files; the next purge removes the session.',
      details: { subsystem: SUBSYSTEM, component: COMPONENT, sessionId },
    },
  );
}

/* -------------------------------------------------------------------------------------------------
 * Rule 3 — orphan backups
 * ---------------------------------------------------------------------------------------------- */

/**
 * Judges one file of the backup tree: kept when any record references it or a
 * conflict protects it, kept while it is younger than the grace window, and
 * otherwise removed.
 *
 * @returns Whether the file is gone — removed now or, in a dry run, would be.
 */
async function sweepBackupFile(
  context: SweepContext,
  state: SweepState,
  guards: BackupGuards,
  path: string,
  stats: Stats,
  parent: NodeIdentity,
): Promise<boolean> {
  const { home, graceCutoff, dryRun } = context.settings;

  // The conflict set is a subset of the referenced one by construction; it is
  // asked separately so a conflict backup is protected even if the two reads
  // ever disagreed.
  if (guards.conflicted.has(path) || guards.referenced.has(path)) {
    return false;
  }
  if (stats.mtimeMs >= graceCutoff) {
    return false;
  }

  if (!dryRun) {
    const removed = await removeFileWithin(home, path, parent, identityOf(stats));
    if (isErr(removed)) {
      recordIssue(context, state, 'backup', relativeToHome(home, path), removed.error);
      return false;
    }
  }

  state.orphanBackupsDeleted += 1;
  state.bytesReclaimed += stats.size;
  return true;
}

/**
 * Walks one `backups/<sessionId>` directory — exactly one level, the level the
 * backup store writes `<originalHash>` files at.
 *
 * A subdirectory is where a relocated (quarantined) backup lives, and it is
 * never descended into: those files are reached only through the record that
 * names them. A link is reported and left. When every entry was a file this
 * walk removed, the directory itself is removed; a directory that still holds
 * anything — a referenced backup, a young orphan, a subdirectory, a link — is
 * left alone.
 */
async function sweepBackupDirectory(
  context: SweepContext,
  state: SweepState,
  guards: BackupGuards,
  directory: string,
  identity: NodeIdentity,
  backupsRoot: NodeIdentity,
): Promise<void> {
  const { home, dryRun } = context.settings;
  const target = relativeToHome(home, directory);

  let names: string[];
  try {
    names = await listNames(directory);
  } catch (cause) {
    recordIssue(context, state, 'backup', target, fsFailure('read', target, cause));
    return;
  }

  let remaining = names.length;
  let removedAny = false;

  for (const name of names) {
    const path = joinPosix(directory, name);
    const entry = relativeToHome(home, path);
    let stats: Stats | undefined;
    try {
      stats = await lstatIfPresent(path);
    } catch (cause) {
      recordIssue(context, state, 'backup', entry, fsFailure('inspect', entry, cause));
      continue;
    }
    if (stats === undefined) {
      remaining -= 1;
      continue;
    }
    if (stats.isSymbolicLink()) {
      recordIssue(
        context,
        state,
        'backup',
        entry,
        unsafePath(
          entry,
          'symlink',
          `${entry} is a symbolic link; the retention sweep does not follow it and left it in place.`,
        ),
      );
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }
    if (await sweepBackupFile(context, state, guards, path, stats, identity)) {
      remaining -= 1;
      removedAny = true;
    }
  }

  if (!removedAny || remaining > 0) {
    return;
  }

  if (!dryRun) {
    const removed = await removeEmptyDirectoryWithin(home, directory, backupsRoot, identity);
    if (isErr(removed)) {
      recordIssue(context, state, 'backup', target, removed.error);
      return;
    }
    if (!removed.value) {
      return;
    }
  }
  state.backupDirsDeleted += 1;
}

/**
 * Rule 3: removes backup files no journal row references once they are older
 * than the grace window, then any session directory that left empty.
 *
 * The walk is bounded to the layout the backup store writes —
 * `backups/<sessionId>/<originalHash>` — which keeps it cheap and keeps it from
 * ever wandering. It covers the mirror case of Rule 1 as well: the directory of
 * a session whose row is already gone (purged by an earlier sweep that could
 * not remove the directory) is not deleted wholesale, its files age out under
 * the same grace window as any other orphan.
 *
 * The referenced set is read **after** Rule 1, so it reflects the records the
 * purge removed. A directory Rule 1 removed — or, in a dry run, would have
 * removed — is skipped, so its files are never counted twice.
 */
async function sweepOrphanBackups(context: SweepContext, state: SweepState): Promise<void> {
  const { deps, settings } = context;
  const rootTarget = relativeToHome(settings.home, settings.backupsDir);

  const root = await inspectDirectory(settings.home, settings.backupsDir);
  if (root.kind === 'absent') {
    return;
  }
  if (root.kind === 'unsafe') {
    recordIssue(context, state, 'backup', rootTarget, root.error);
    return;
  }

  if (!storeUsable(context, state, 'modifications.listBackupPaths')) {
    return;
  }
  const guards = await readBackupGuards(deps.modifications);
  if (isErr(guards)) {
    // Without the referenced set no file can be told apart from an orphan, so
    // nothing under backups/ is deleted on this pass.
    recordIssue(context, state, 'database', 'modifications.listBackupPaths', guards.error);
    return;
  }

  let names: string[];
  try {
    names = await listNames(settings.backupsDir);
  } catch (cause) {
    recordIssue(context, state, 'backup', rootTarget, fsFailure('read', rootTarget, cause));
    return;
  }

  for (const name of names) {
    const path = joinPosix(settings.backupsDir, name);
    if (dirnamePosix(path) !== settings.backupsDir || !isStrictlyWithin(settings.home, path)) {
      continue;
    }
    if (state.removedDirectories.has(path)) {
      continue;
    }
    const entry = relativeToHome(settings.home, path);

    let stats: Stats | undefined;
    try {
      stats = await lstatIfPresent(path);
    } catch (cause) {
      recordIssue(context, state, 'backup', entry, fsFailure('inspect', entry, cause));
      continue;
    }
    if (stats === undefined) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      recordIssue(
        context,
        state,
        'backup',
        entry,
        unsafePath(
          entry,
          'symlink',
          `${entry} is a symbolic link; the retention sweep does not follow it and left it in place.`,
        ),
      );
      continue;
    }
    if (stats.isDirectory()) {
      await sweepBackupDirectory(
        context,
        state,
        guards.value,
        path,
        identityOf(stats),
        root.identity,
      );
      continue;
    }
    if (stats.isFile()) {
      // Not a layout the backup store writes, but a stray file directly under
      // backups/ is judged exactly like an orphan inside a session directory.
      await sweepBackupFile(context, state, guards.value, path, stats, root.identity);
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Rule 2 — code-index caches
 * ---------------------------------------------------------------------------------------------- */

/**
 * The project roots with at least one session updated at or after `cutoff`:
 * the projects "opened inside the window", whose caches are kept.
 *
 * The session list is ordered by `updated_at` descending, so paging stops at
 * the first session older than the cutoff instead of reading the whole table.
 */
function listActiveProjectRoots(
  sessions: SessionsRepo,
  cutoff: number,
): Result<Set<string>, DebuggenError> {
  const roots = new Set<string>();
  let offset = 0;

  for (;;) {
    const page = sessions.list({ limit: MAX_SESSION_LIST_LIMIT, offset });
    if (isErr(page)) {
      return page;
    }
    for (const item of page.value.items) {
      if (item.updatedAt < cutoff) {
        return ok(roots);
      }
      roots.add(normalizePosix(item.projectRoot));
    }
    offset += page.value.items.length;
    if (page.value.items.length < MAX_SESSION_LIST_LIMIT || offset >= page.value.total) {
      return ok(roots);
    }
  }
}

/** The `projectRoot` strings a parsed cache document records, at either level. */
function projectRootsOf(document: unknown): string[] {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return [];
  }
  const roots: string[] = [];
  if ('projectRoot' in document && typeof document.projectRoot === 'string') {
    roots.push(document.projectRoot);
  }
  if ('index' in document) {
    const { index } = document;
    if (
      typeof index === 'object' &&
      index !== null &&
      'projectRoot' in index &&
      typeof index.projectRoot === 'string'
    ) {
      roots.push(index.projectRoot);
    }
  }
  return roots;
}

/**
 * Reads the project roots one cache document records.
 *
 * The entry format belongs to `@debuggen/code-analysis`, which keys a file by a
 * project hash and records the indexed root as `index.projectRoot`; a
 * top-level `projectRoot` is accepted as well so a format revision does not
 * silently turn every entry into an mtime-only one. The file is opened without
 * following a link, must still be the file the walk inspected, and must be no
 * larger than {@link MAX_INDEX_METADATA_BYTES}. Any failure — unreadable,
 * oversized, not JSON — answers `[]`, which sends the entry down the
 * modification-time branch; the document's content is never logged.
 */
async function readRecordedProjectRoots(path: string, expected: Stats): Promise<string[]> {
  if (expected.size > MAX_INDEX_METADATA_BYTES) {
    return [];
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, OPEN_NO_FOLLOW_FLAGS);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size > MAX_INDEX_METADATA_BYTES
    ) {
      return [];
    }
    const text = await handle.readFile({ encoding: 'utf8' });
    return projectRootsOf(JSON.parse(text) as unknown);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Whether any recorded root is one of the roots active inside the window. */
function isActiveRoot(roots: readonly string[], active: ReadonlySet<string>): boolean {
  return roots.some((root) => active.has(normalizePosix(root)));
}

/**
 * Judges one file-shaped cache entry — the `<key>.json` files the cache
 * writes — and removes it unless it still belongs to a project active inside
 * the window.
 *
 * Two branches, in this order:
 *
 * 1. **Modification time.** An entry written at or after the cutoff is kept
 *    without being read: it was produced by an indexing run inside the window,
 *    which means its project was opened inside the window.
 * 2. **Recorded project root.** An older entry is read for the `projectRoot`
 *    it records, and kept when that root has a session updated inside the
 *    window — a cache hit does not rewrite the entry, so an actively used
 *    project's cache can be old on disk.
 *
 * Otherwise the entry is eligible. The fallback is safe because a cache is a
 * derived artifact: removing one that was still wanted costs one re-index on
 * the project's next session, never data.
 */
async function sweepIndexFile(
  context: SweepContext,
  state: SweepState,
  active: ReadonlySet<string>,
  path: string,
  stats: Stats,
  root: NodeIdentity,
): Promise<void> {
  const { home, cutoff, dryRun } = context.settings;
  if (stats.mtimeMs >= cutoff) {
    return;
  }
  if (path.endsWith(INDEX_ENTRY_EXTENSION)) {
    if (isActiveRoot(await readRecordedProjectRoots(path, stats), active)) {
      return;
    }
  }

  if (!dryRun) {
    const removed = await removeFileWithin(home, path, root, identityOf(stats));
    if (isErr(removed)) {
      recordIssue(context, state, 'index-cache', relativeToHome(home, path), removed.error);
      return;
    }
  }
  state.indexCachesDeleted += 1;
  state.bytesReclaimed += stats.size;
}

/**
 * Judges one directory-shaped cache entry.
 *
 * Its age is the newest modification time among the directory and its direct
 * children, its project roots come from up to {@link MAX_INDEX_METADATA_FILES}
 * `*.json` files directly inside it, and it is removed as a whole tree. It is
 * never descended into beyond that one level, and an entry whose children
 * cannot be inspected is kept.
 */
async function sweepIndexDirectory(
  context: SweepContext,
  state: SweepState,
  active: ReadonlySet<string>,
  path: string,
  stats: Stats,
  root: NodeIdentity,
): Promise<void> {
  const { home, cutoff, dryRun } = context.settings;
  const target = relativeToHome(home, path);

  let names: string[];
  try {
    names = await listNames(path);
  } catch (cause) {
    recordIssue(context, state, 'index-cache', target, fsFailure('read', target, cause));
    return;
  }

  let newest = stats.mtimeMs;
  const documents: { readonly path: string; readonly stats: Stats }[] = [];
  for (const name of names) {
    const child = joinPosix(path, name);
    let childStats: Stats | undefined;
    try {
      childStats = await lstatIfPresent(child);
    } catch (cause) {
      const entry = relativeToHome(home, child);
      recordIssue(context, state, 'index-cache', entry, fsFailure('inspect', entry, cause));
      return;
    }
    if (childStats === undefined) {
      continue;
    }
    newest = Math.max(newest, childStats.mtimeMs);
    if (
      childStats.isFile() &&
      !childStats.isSymbolicLink() &&
      name.endsWith(INDEX_ENTRY_EXTENSION)
    ) {
      documents.push({ path: child, stats: childStats });
    }
  }

  if (newest >= cutoff) {
    return;
  }
  for (const document of documents.slice(0, MAX_INDEX_METADATA_FILES)) {
    if (isActiveRoot(await readRecordedProjectRoots(document.path, document.stats), active)) {
      return;
    }
  }

  const survey = await surveyTree(path);
  if (survey.link !== undefined) {
    recordIssue(context, state, 'index-cache', target, treeHoldsLink(home, path, survey.link));
    return;
  }
  if (!dryRun) {
    const removed = await removeTreeWithin(home, path, root, identityOf(stats));
    if (isErr(removed)) {
      recordIssue(context, state, 'index-cache', target, removed.error);
      return;
    }
    if (!removed.value) {
      return;
    }
  }
  state.indexCachesDeleted += 1;
  state.bytesReclaimed += survey.bytes;
}

/**
 * Rule 2: removes the entries of the code-index cache whose project has not
 * been opened inside the window.
 *
 * Only the direct children of `indexCacheDir` are judged, and the walk never
 * leaves that directory: a link is reported and left, a file or a directory is
 * judged by {@link sweepIndexFile} or {@link sweepIndexDirectory}, and anything
 * else is ignored.
 */
async function sweepIndexCaches(context: SweepContext, state: SweepState): Promise<void> {
  const { deps, settings } = context;
  const rootTarget = relativeToHome(settings.home, settings.indexCacheDir);

  const root = await inspectDirectory(settings.home, settings.indexCacheDir);
  if (root.kind === 'absent') {
    return;
  }
  if (root.kind === 'unsafe') {
    recordIssue(context, state, 'index-cache', rootTarget, root.error);
    return;
  }

  if (!storeUsable(context, state, 'sessions.list')) {
    return;
  }
  const active = listActiveProjectRoots(deps.sessions, settings.cutoff);
  if (isErr(active)) {
    // Without the allowlist an active project's cache could not be told apart
    // from an abandoned one; the caches wait for the next sweep.
    recordIssue(context, state, 'database', 'sessions.list', active.error);
    return;
  }

  let names: string[];
  try {
    names = await listNames(settings.indexCacheDir);
  } catch (cause) {
    recordIssue(context, state, 'index-cache', rootTarget, fsFailure('read', rootTarget, cause));
    return;
  }

  for (const name of names) {
    const path = joinPosix(settings.indexCacheDir, name);
    if (dirnamePosix(path) !== settings.indexCacheDir || !isStrictlyWithin(settings.home, path)) {
      continue;
    }
    const entry = relativeToHome(settings.home, path);

    let stats: Stats | undefined;
    try {
      stats = await lstatIfPresent(path);
    } catch (cause) {
      recordIssue(context, state, 'index-cache', entry, fsFailure('inspect', entry, cause));
      continue;
    }
    if (stats === undefined) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      recordIssue(
        context,
        state,
        'index-cache',
        entry,
        unsafePath(
          entry,
          'symlink',
          `${entry} is a symbolic link; the retention sweep does not follow it and left it in place.`,
        ),
      );
      continue;
    }
    if (stats.isFile()) {
      await sweepIndexFile(context, state, active.value, path, stats, root.identity);
    } else if (stats.isDirectory()) {
      await sweepIndexDirectory(context, state, active.value, path, stats, root.identity);
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Reclaiming database space
 * ---------------------------------------------------------------------------------------------- */

/**
 * Folds the write-ahead log back into the database after a purge, and runs
 * `VACUUM` when the caller asked for it.
 *
 * The checkpoint runs only when this sweep deleted a session: it is cheap, but
 * a sweep that deleted nothing has nothing to reclaim, and the start-up path
 * with no candidates stays free of writes. `VACUUM` runs only on request, never
 * in a dry run, and never inside a caller's open transaction, where SQLite
 * refuses it.
 */
function reclaimDatabaseSpace(context: SweepContext, state: SweepState): void {
  const { store } = context.deps;
  const { dryRun, vacuum } = context.settings;
  if (dryRun) {
    return;
  }

  if (state.sessionIdsDeleted.length > 0) {
    if (!storeUsable(context, state, 'checkpoint')) {
      return;
    }
    try {
      store.checkpoint();
    } catch (caught) {
      recordIssue(
        context,
        state,
        'database',
        'checkpoint',
        DebuggenError.from(caught, 'STORE_ERROR'),
      );
    }
  }

  if (!vacuum || !storeUsable(context, state, 'vacuum')) {
    return;
  }
  if (store.db.isTransaction) {
    recordIssue(
      context,
      state,
      'database',
      'vacuum',
      new DebuggenError(
        'STORE_ERROR',
        'VACUUM was skipped because a transaction is open on the session store.',
        {
          hint: 'Run the purge with vacuum outside any transaction.',
          details: { subsystem: SUBSYSTEM, component: COMPONENT, operation: 'vacuum' },
        },
      ),
    );
    return;
  }
  try {
    store.db.exec('VACUUM');
  } catch (caught) {
    recordIssue(
      context,
      state,
      'database',
      'vacuum',
      new DebuggenError('STORE_ERROR', 'VACUUM of the session store did not complete.', {
        hint: 'The purged rows are gone either way; the space is reused by SQLite and returned on the next successful VACUUM.',
        details: { subsystem: SUBSYSTEM, component: COMPONENT, operation: 'vacuum' },
        cause: caught,
      }),
    );
  }
}

/* -------------------------------------------------------------------------------------------------
 * The sweep
 * ---------------------------------------------------------------------------------------------- */

/** Assembles the report from the accumulated state, with every array sorted. */
function toReport(cutoff: number, state: SweepState, durationMs: number): RetentionReport {
  const sessionIdsDeleted = [...state.sessionIdsDeleted].sort(compareText);
  return {
    cutoff,
    sessionsDeleted: sessionIdsDeleted.length,
    sessionIdsDeleted,
    telemetryEventsDeleted: state.telemetryEventsDeleted,
    panelsDeleted: state.panelsDeleted,
    analysesDeleted: state.analysesDeleted,
    modificationsDeleted: state.modificationsDeleted,
    backupDirsDeleted: state.backupDirsDeleted,
    orphanBackupsDeleted: state.orphanBackupsDeleted,
    indexCachesDeleted: state.indexCachesDeleted,
    sessionsRetainedForConflicts: [...state.sessionsRetainedForConflicts].sort(compareText),
    bytesReclaimed: state.bytesReclaimed,
    durationMs,
    errors: state.errors.map((issue) => ({ ...issue })),
  };
}

/**
 * Runs one retention sweep over the session database and `$DEBUGGEN_HOME`.
 *
 * In order: aged sessions and their backup directories (Rule 1), orphan
 * backups (Rule 3), code-index caches (Rule 2), then a WAL checkpoint when a
 * session was deleted and `VACUUM` when {@link RetentionOptions.vacuum} asks
 * for it. See the module overview for each rule and for the containment
 * discipline every deletion follows.
 *
 * The age basis of Rule 1 is **`sessions.updated_at`**, the session's last
 * activity — not `created_at` — so a long-running session is never purged
 * mid-flight; `cutoff = now() - retentionDays × 86 400 000`, and a session last
 * updated strictly before it is a candidate.
 *
 * Asynchronous because of the filesystem work; the database work is
 * synchronous, one short transaction per purged session.
 *
 * @param deps The store, the four repositories, the resolved paths and window,
 * and optionally a logger and a clock.
 * @param options Window overrides, `dryRun` and `vacuum`.
 * @returns `Ok` with the report — per-item problems are in
 * {@link RetentionReport.errors} — or `Err` only when the sweep cannot run at
 * all: `CONFIG_INVALID` for a configuration, option or clock it cannot use,
 * `STORE_ERROR` for a closed store, `INTERNAL` for a defect that escaped every
 * per-item guard.
 *
 * @example
 * ```ts
 * const swept = await runRetention({ store, sessions, telemetry, modifications, panels, config, logger });
 * if (isErr(swept)) {
 *   logger.error(swept.error.message, { code: swept.error.code });
 * } else if (swept.value.errors.length > 0) {
 *   logger.warn('retention left some items in place', { issues: swept.value.errors.length });
 * }
 * ```
 */
export async function runRetention(
  deps: RetentionDeps,
  options: RetentionOptions = {},
): Promise<Result<RetentionReport, DebuggenError>> {
  const startedAt = performance.now();
  const logger = (deps.logger ?? noopLogger).child({ subsystem: SUBSYSTEM, repo: COMPONENT });

  const settings = resolveSettings(deps, options, logger);
  if (isErr(settings)) {
    return settings;
  }

  if (deps.store.isClosed) {
    return err(
      new DebuggenError(
        'STORE_ERROR',
        'The session store is closed, so the retention sweep cannot run.',
        {
          hint: 'Run the purge while the Debug Generator service is running.',
          details: { subsystem: SUBSYSTEM, component: COMPONENT, operation: 'retention' },
        },
      ),
    );
  }

  const context: SweepContext = { deps, settings: settings.value, logger };
  const state: SweepState = {
    sessionIdsDeleted: [],
    sessionsRetainedForConflicts: [],
    errors: [],
    removedDirectories: new Set<string>(),
    telemetryEventsDeleted: 0,
    panelsDeleted: 0,
    analysesDeleted: 0,
    modificationsDeleted: 0,
    backupDirsDeleted: 0,
    orphanBackupsDeleted: 0,
    indexCachesDeleted: 0,
    bytesReclaimed: 0,
  };

  try {
    await purgeAgedSessions(context, state);
    await sweepOrphanBackups(context, state);
    await sweepIndexCaches(context, state);
    reclaimDatabaseSpace(context, state);
  } catch (caught) {
    // Every per-item operation above is guarded; reaching this is a defect.
    const error = DebuggenError.from(caught, 'INTERNAL');
    logger.error('retention sweep failed unexpectedly', { code: error.code });
    return err(error);
  }

  const report = toReport(settings.value.cutoff, state, performance.now() - startedAt);
  logger.info('retention sweep finished', {
    dryRun: settings.value.dryRun,
    retentionDays: settings.value.retentionDays,
    orphanBackupGraceDays: settings.value.graceDays,
    cutoff: report.cutoff,
    sessionsDeleted: report.sessionsDeleted,
    telemetryEventsDeleted: report.telemetryEventsDeleted,
    panelsDeleted: report.panelsDeleted,
    analysesDeleted: report.analysesDeleted,
    modificationsDeleted: report.modificationsDeleted,
    backupDirsDeleted: report.backupDirsDeleted,
    orphanBackupsDeleted: report.orphanBackupsDeleted,
    indexCachesDeleted: report.indexCachesDeleted,
    sessionsRetainedForConflicts: report.sessionsRetainedForConflicts.length,
    bytesReclaimed: report.bytesReclaimed,
    issues: report.errors.length,
    durationMs: report.durationMs,
  });
  return ok(report);
}
