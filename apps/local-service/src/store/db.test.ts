/**
 * Tests for `./db.ts`: the file policy `openStore` holds the session store to
 * before, during and after SQLite opens it.
 *
 * `$DEBUGGEN_HOME/sessions.sqlite` holds every session's telemetry and the
 * modification journal that restores a developer's patched files, and
 * `node:sqlite` opens it — and its `-wal`, `-shm` and `-journal` sidecars — by
 * path, following a symbolic link at the final component and creating under
 * the process umask. A private directory alone therefore leaves the store
 * redirectable (CWE-59). What is on trial here is the resulting filesystem, not
 * the calls that were attempted:
 *
 * 1. **A store this process creates is private by construction.** A fresh open
 *    leaves a regular, single-link `0600` database, and the sidecars SQLite
 *    creates beside it end `0600` too; a reopened store or leftover sidecar at
 *    any other mode (`0644`, `0400`, `0700`) is set to exactly `0600` in place,
 *    with its data intact. A new store is created in incremental auto-vacuum
 *    mode, while a file an earlier build created without it still opens as it
 *    was until a `VACUUM` converts it.
 * 2. **A mode that cannot be made owner-only fails closed.** A `chmod` the
 *    filesystem refuses, or accepts without effect, on a group- or
 *    other-readable file is `FS_UNSAFE_PATH` (`group-or-other-permissions`):
 *    the database's bytes are untouched, SQLite is never constructed, and a
 *    connection already open is closed. Root runs this project's CI and the
 *    owner's own `chmod` always succeeds, so those failures are injected into
 *    `node:fs` for one targeted path at a time; every other call is real.
 * 3. **An unsafe entry is refused, not followed or repaired.** A link at the
 *    database or at any sidecar, a directory, a hard link, a foreign owner, or a
 *    directory resolved out of the state root: each is `FS_UNSAFE_PATH` with the
 *    reason in `details.reason`, and each case also proves the entry — and the
 *    file a link points at — is exactly as the fixture left it. "Returned an
 *    error" and "wrote nothing" are two claims, and both are asserted.
 * 4. **The open itself is checked.** The recorded inode must still be the one
 *    SQLite opened, and a sidecar appearing after the open is judged before the
 *    migration writes into it. Those two windows cannot be provoked with a real
 *    race in a unit test, so the `node:sqlite` constructor is wrapped for them
 *    alone and every other call is the real binding.
 * 5. **The state directory is judged, never repaired, and never left.** A
 *    configuration whose database is not inside its own state root, or whose
 *    state root is blank, is `CONFIG_INVALID` before any filesystem call — no
 *    file created, no directory created, no mode changed. An existing state
 *    directory that grants group or other access is `FS_UNSAFE_PATH`
 *    (`group-or-other-permissions`) on either route, naming that directory and
 *    the `chmod` that fixes it, with its mode and contents exactly as found.
 * 6. **Checkpointing stays off the event loop, and never stops.** Every
 *    connection carries the declared pragmas, the 64 MiB page cache included.
 *    A file-backed store — never the in-memory one — gets exactly one
 *    background checkpointer; the main connection's `wal_autocheckpoint` is `0`
 *    only while that worker runs, a grown write-ahead log is folded back in
 *    without the main connection checkpointing, and a worker that crashes or
 *    exits hands `wal_autocheckpoint` back at SQLite's default. `checkpoint()`
 *    truncates the log while the worker runs; `close()` — twice, or straight
 *    after the open — leaves no sidecar and no worker behind. The worker is
 *    the real one; `node:worker_threads` is wrapped only to record it, and, for
 *    the crash case alone, to give it failing source.
 * 7. **A close says what its checkpoint achieved.** Closing a store writes one
 *    `info` record after the connection closes, naming the write-ahead log
 *    checkpoint's outcome — `completed`, `busy`, `failed` or `no-wal` — with
 *    numeric frame counts and nothing from the store's contents; an explicit
 *    checkpoint reports the same fields at `debug`, and a second close writes
 *    nothing at all.
 * 8. **A checkpoint on request folds the log in off the event loop.** With the
 *    commit-time checkpoint suspended, the worker thread's connection copies
 *    the log back and truncates it with every row intact; a reader holding the
 *    log answers `busy`; the in-memory store, a closed store and a database
 *    path that has become a link offer no checkpointer; a path that names
 *    another inode is refused by the thread; and overlapping suspensions
 *    restore the connection's threshold only when the last one ends.
 *
 * Every case works inside its own `mkdtemp` sandbox, resolved through `realpath`
 * so a temp directory reached through a link (as on macOS) cannot fail a chain
 * check for the wrong reason, and removed afterwards. No socket is opened and
 * nothing under a real `$DEBUGGEN_HOME` is touched, which is the contract of the
 * `local-service` Vitest project. Platform-dependent cases are skipped by
 * capability — the absence of `process.getuid`, or a probe that could not plant
 * a link or assign a foreign owner — never by platform name.
 */

import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Mode, PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Worker, WorkerOptions } from 'node:worker_threads';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConsoleLogger, isErr, unwrap } from '@debuggen/shared';
import type { DebuggenError, LogRecord, Result } from '@debuggen/shared';

import {
  DEFAULT_WAL_AUTOCHECKPOINT_PAGES,
  STORE_PRAGMAS,
  WAL_CHECKPOINTER_STOP_WAIT_MS,
  openStore,
  openWalCheckpointer,
  suspendAutoCheckpoint,
} from './db.js';
import type { OpenStoreOptions, Store, WalCheckpointer } from './db.js';

/* -------------------------------------------------------------------------------------------------
 * Injected chmod failures
 * ---------------------------------------------------------------------------------------------- */

/**
 * How an injected `chmod` fails: `throw` raises `EPERM` as a filesystem that
 * refuses the call does; `ignore` returns as if it had succeeded and changes
 * nothing, as a filesystem that does not record the bits does.
 */
type ChmodFaultBehaviour = 'throw' | 'ignore';

/** The `chmod` failure the current case injects, and what it intercepted. */
interface ChmodFault {
  /** The one path the fault applies to; `undefined` while nothing is injected. */
  target: string | undefined;

  /** How the call on {@link ChmodFault.target} fails. */
  behaviour: ChmodFaultBehaviour;

  /** Every `chmod` of {@link ChmodFault.target} the fault intercepted, in order. */
  attempts: string[];
}

/**
 * The fault state the `node:fs` mock below reads on every `chmodSync`.
 *
 * `vi.hoisted`, because the mock factory is hoisted above every import and must
 * already be able to see it. With no target set the mock is the real `chmod`,
 * so the capability probes, the fixtures and every other case run against the
 * real filesystem.
 */
const chmodFault = vi.hoisted((): ChmodFault => ({
  target: undefined,
  behaviour: 'throw',
  attempts: [],
}));

/**
 * `node:fs` with `chmodSync` routed through {@link chmodFault}: the real call
 * for every path except the one targeted. It applies to `./db.ts`'s import and
 * to this file's own, which is why a fixture sets its modes before a fault is
 * injected; a fresh import of `./db.js` after `vi.resetModules` is mocked the
 * same way, so the constructor wrapper below composes with it.
 */
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    chmodSync: (path: PathLike, mode: Mode): void => {
      if (typeof path === 'string' && path === chmodFault.target) {
        chmodFault.attempts.push(path);
        if (chmodFault.behaviour === 'throw') {
          throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${path}'`), {
            code: 'EPERM',
            syscall: 'chmod',
            path,
          });
        }
        return;
      }
      real.chmodSync(path, mode);
    },
  };
});

/**
 * Every background checkpointer `./db.ts` spawned during the current case, and
 * the source the next spawn runs instead of the real one when a case injects a
 * failing worker.
 *
 * `vi.hoisted` for the same reason as {@link chmodFault}. With no replacement
 * set the mock below is the real `Worker`, so every case runs the real
 * checkpointer; the only thing added is the record of which workers exist, so
 * a case can prove one was (or was not) spawned, terminate it the way a crash
 * would, and prove it is gone after `close()`.
 */
const workerSpy = vi.hoisted((): { spawned: Worker[]; replacementSource: string | undefined } => ({
  spawned: [],
  replacementSource: undefined,
}));

/** `node:worker_threads` with `Worker` recorded, and its source replaceable per case. */
vi.mock('node:worker_threads', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:worker_threads')>();
  class RecordingWorker extends real.Worker {
    constructor(filename: string | URL, options?: WorkerOptions) {
      super(workerSpy.replacementSource ?? filename, options);
      workerSpy.spawned.push(this);
    }
  }
  return { ...real, Worker: RecordingWorker };
});

/** Makes every later `chmod` of `target` fail as `behaviour` says, and forgets earlier attempts. */
function injectChmodFault(target: string, behaviour: ChmodFaultBehaviour): void {
  chmodFault.target = target;
  chmodFault.behaviour = behaviour;
  chmodFault.attempts = [];
}

/** Restores the real `chmod` for every path. */
function clearChmodFault(): void {
  chmodFault.target = undefined;
  chmodFault.behaviour = 'throw';
  chmodFault.attempts = [];
}

/* -------------------------------------------------------------------------------------------------
 * Capability guards
 * ---------------------------------------------------------------------------------------------- */

/** Whether this platform has no user ids, and so no owner or mode model to assert. */
const NO_POSIX_IDS = typeof process.getuid !== 'function';

/**
 * Whether this process can plant a symbolic link at all.
 *
 * Windows withholds it without developer mode, and a hardened runner can
 * withhold it anywhere; an unguarded `symlinkSync` would then read as a store
 * defect rather than a host limitation. A dangling link answers the question,
 * and `lstat` confirms the call really made one.
 */
const CAN_CREATE_SYMLINKS = ((): boolean => {
  const probeRoot = mkdtempSync(join(tmpdir(), 'debuggen-store-probe-'));
  try {
    symlinkSync(join(probeRoot, 'absent'), join(probeRoot, 'link'));
    return lstatSync(join(probeRoot, 'link')).isSymbolicLink();
  } catch {
    // No link could be planted, so the cases that need one are skipped.
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

/** Whether this process can give a file a second hard link. */
const CAN_CREATE_HARD_LINKS = ((): boolean => {
  const probeRoot = mkdtempSync(join(tmpdir(), 'debuggen-store-probe-'));
  try {
    const original = join(probeRoot, 'original');
    writeFileSync(original, '');
    linkSync(original, join(probeRoot, 'second'));
    return lstatSync(original).nlink === 2;
  } catch {
    // A filesystem without hard links: the multiply-linked case is skipped.
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

/**
 * A uid this process can actually hand a file to, or `undefined` when it can
 * assign none.
 *
 * Assigning another owner needs privilege, so this probes the effective
 * capability: the conventional `nobody` uid first, then `daemon`, each used as
 * a number only and confirmed with `lstat` rather than trusted. On a host that
 * runs its tests as root — as this project's CI does — the case runs.
 */
const FOREIGN_UID = ((): number | undefined => {
  if (typeof process.getuid !== 'function') {
    return undefined;
  }

  const processUid = process.getuid();
  const probeRoot = mkdtempSync(join(tmpdir(), 'debuggen-store-probe-'));
  try {
    for (const candidate of [65534, 1]) {
      if (candidate === processUid) {
        continue;
      }

      const probe = join(probeRoot, `owned-${String(candidate)}`);
      writeFileSync(probe, '');
      try {
        chownSync(probe, candidate, lstatSync(probe).gid);
      } catch {
        // No privilege for this candidate; try the next, then give up.
        continue;
      }

      if (lstatSync(probe).uid === candidate) {
        return candidate;
      }
    }

    return undefined;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

/* -------------------------------------------------------------------------------------------------
 * Fixture modes and names
 * ---------------------------------------------------------------------------------------------- */

/** The permission bits of a mode. */
const PERMISSION_BITS = 0o777;

/** Owner-only access, which every store file must end with. */
const OWNER_ONLY_FILE_MODE = 0o600;

/** Owner-only access for a directory. */
const OWNER_ONLY_DIR_MODE = 0o700;

/** An ordinary file mode, readable by everyone: what a drifted store carries. */
const WORLD_READABLE_FILE_MODE = 0o644;

/** Owner read only: owner-only, but not the `0600` the store requires. */
const OWNER_READ_ONLY_FILE_MODE = 0o400;

/**
 * Owner read, write and execute: owner-only, but not `0600` — the one mode a
 * filesystem that records no per-file bits commonly reports for every file.
 */
const OWNER_ALL_FILE_MODE = 0o700;

/** An ordinary directory mode, for the directory a link points into. */
const ORDINARY_DIR_MODE = 0o755;

/** The sidecars SQLite keeps beside a database, each held to the file policy. */
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/** The message the store logs when it tightens a file in place. */
const TIGHTENED_MESSAGE = 'restricted a session store file to owner-only access';

/** The message the store logs when it accepts an owner-only mode other than `0600`. */
const ACCEPTED_OWNER_ONLY_MESSAGE =
  'accepted a session store file at an owner-only mode other than 600';

/** The refusal reason for a file still granting group or other access. */
const MODE_REFUSAL_REASON = 'group-or-other-permissions';

/** The row every retained-data case writes, and the query that reads it back. */
const PROBE_SEED_SQL =
  "CREATE TABLE retained_probe (body TEXT NOT NULL); INSERT INTO retained_probe VALUES ('still here');";
const PROBE_SELECT_SQL = 'SELECT body FROM retained_probe';
const PROBE_ROW = { body: 'still here' };

/* -------------------------------------------------------------------------------------------------
 * Sandbox
 * ---------------------------------------------------------------------------------------------- */

/** The current case's sandbox: an absolute, symlink-free, empty directory. */
let sandbox = '';

/** The private state directory the store lives in, inside {@link sandbox}. */
let stateDir = '';

/** The database path every case opens: `<stateDir>/sessions.sqlite`. */
let databasePath = '';

/** A directory outside the state tree, where planted links point. */
let outsideDir = '';

/** Every store a case opened, so a failing assertion still leaks no handle. */
let openedStores: Store[] = [];

/** What the store logged during the current case. */
let logs: LogRecord[] = [];

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-store-db-')));
  stateDir = join(sandbox, 'state');
  databasePath = join(stateDir, 'sessions.sqlite');
  outsideDir = join(sandbox, 'outside');
  mkdirSync(outsideDir);
  chmodSync(outsideDir, ORDINARY_DIR_MODE);
  openedStores = [];
  logs = [];
  workerSpy.spawned = [];
  workerSpy.replacementSource = undefined;
});

afterEach(() => {
  // First, so the teardown below and the next case run against the real
  // `chmod` whatever this case injected.
  clearChmodFault();
  workerSpy.replacementSource = undefined;
  // `close` is idempotent, so a store a case already closed is closed again
  // harmlessly.
  for (const store of openedStores) {
    store.close();
  }
  rmSync(sandbox, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/** A logger that records everything the store says, at every level. */
function recordingLogger(): ReturnType<typeof createConsoleLogger> {
  return createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      logs.push(record);
    },
  });
}

/** Opens a store that must open, and tracks it for cleanup. */
function openedStore(options: OpenStoreOptions): Store {
  const store = unwrap(openStore(options));
  openedStores.push(store);
  return store;
}

/**
 * The refusal an open was expected to produce.
 *
 * A store that opened after all is tracked and closed before the case fails,
 * so an unexpected success cannot leave a handle behind for the next case.
 */
function refusalFrom(opened: Result<Store, DebuggenError>): DebuggenError {
  if (isErr(opened)) {
    return opened.error;
  }
  openedStores.push(opened.value);
  return expect.unreachable('openStore was expected to refuse, and opened the store instead');
}

/**
 * Asserts an open was refused as `FS_UNSAFE_PATH` for `reason`, naming `file`.
 *
 * The hint is checked for the path too: the developer's next action is to move
 * that exact entry aside, so a hint that did not name it would be unactionable.
 */
function expectUnsafeFile(
  opened: Result<Store, DebuggenError>,
  reason: string,
  file: string,
): DebuggenError {
  const error = refusalFrom(opened);
  expect(error.code).toBe('FS_UNSAFE_PATH');
  expect(error.details?.reason).toBe(reason);
  expect(error.details?.file).toBe(file);
  expect(error.details?.databasePath).toBe(databasePath);
  expect(error.details?.subsystem).toBe('store');
  expect(error.hint).toContain(file);
  return error;
}

/** The permission bits of the entry at `pathAbs`, without following a link. */
function modeOf(pathAbs: string): number {
  return lstatSync(pathAbs).mode & PERMISSION_BITS;
}

/** The sorted names in a directory, dotted entries included. */
function entriesIn(dirAbs: string): string[] {
  return readdirSync(dirAbs).sort();
}

/** Creates the private state directory a case plants its fixture in. */
function makeStateDir(): void {
  mkdirSync(stateDir);
  chmodSync(stateDir, OWNER_ONLY_DIR_MODE);
}

/** What a file looked like, for proving a refusal left it untouched. */
interface FileFingerprint {
  readonly bytes: Buffer;
  readonly mode: number;
  readonly ino: bigint;
}

/** Records a file's bytes, mode and inode. */
function fingerprint(pathAbs: string): FileFingerprint {
  return {
    bytes: readFileSync(pathAbs),
    mode: statSync(pathAbs).mode & PERMISSION_BITS,
    ino: statSync(pathAbs, { bigint: true }).ino,
  };
}

/** Asserts a file still has exactly the bytes, mode and inode it was fingerprinted with. */
function expectUnchanged(pathAbs: string, before: FileFingerprint): void {
  const after = fingerprint(pathAbs);
  expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
  expect(after.mode).toBe(before.mode);
  expect(after.ino).toBe(before.ino);
}

/**
 * Creates a real SQLite database outside the state tree, world-readable.
 *
 * A valid database is the point: a link to garbage would fail the pragmas on
 * any implementation, while a link to a real database is exactly what the
 * unhardened open would have migrated into and filled with session data.
 */
function makeOutsideDatabase(name: string): string {
  const pathAbs = join(outsideDir, name);
  const db = new DatabaseSync(pathAbs);
  try {
    db.exec(
      "CREATE TABLE outside_rows (value TEXT NOT NULL); INSERT INTO outside_rows VALUES ('kept');",
    );
  } finally {
    db.close();
  }
  chmodSync(pathAbs, WORLD_READABLE_FILE_MODE);
  return pathAbs;
}

/** Asserts no SQLite sidecar exists beside `pathAbs`. */
function expectNoSidecarsBeside(pathAbs: string): void {
  for (const suffix of SIDECAR_SUFFIXES) {
    expect(existsSync(`${pathAbs}${suffix}`)).toBe(false);
  }
}

/**
 * Creates the store at {@link databasePath} with the probe row in it, and
 * closes it, so a case can change its mode and prove a reopen kept the data.
 * Closing the last connection folds the write-ahead log back in and removes
 * the sidecars, so only the database file is left.
 */
function createStoreWithProbeRow(): void {
  const first = openedStore({ databasePath });
  first.db.exec(PROBE_SEED_SQL);
  first.close();
}

/** What `PRAGMA auto_vacuum` answers for a file whose header says `NONE`. */
const NO_AUTO_VACUUM = 0;

/** What `PRAGMA auto_vacuum` answers for a file in incremental auto-vacuum mode. */
const INCREMENTAL_AUTO_VACUUM = 2;

/** The auto-vacuum mode a connection's database file reports. */
function autoVacuumOf(db: DatabaseSync): unknown {
  return db.prepare('PRAGMA auto_vacuum').get()?.['auto_vacuum'];
}

/** The journal mode a connection reports, lower-cased. */
function journalModeOf(db: DatabaseSync): string {
  return String(db.prepare('PRAGMA journal_mode').get()?.['journal_mode']).toLowerCase();
}

/** The session store log records about `pathAbs` carrying `message`. */
function logsAbout(message: string, pathAbs: string): LogRecord[] {
  return logs.filter((record) => record.message === message && record.fields.path === pathAbs);
}

/**
 * Runs `use` against a freshly imported `./db.js` whose `DatabaseSync` runs
 * `before` and `after` around the real constructor.
 *
 * The two windows this reaches — between the file policy and the open, and
 * between the open and the first write — are microseconds wide and cannot be
 * hit by a real racing process in a unit test. Wrapping only the constructor
 * keeps every other call the real binding: the store really opens, really sets
 * its pragmas and really re-verifies. `after` also receives the connection, so
 * a case can prove a refusal closed it. The registry is reset before and after,
 * so the next case imports the genuine module.
 */
async function withWrappedConstructor(
  hooks: {
    readonly before?: (path: string) => void;
    readonly after?: (path: string, connection: DatabaseSync) => void;
  },
  use: (open: typeof openStore) => void,
): Promise<void> {
  vi.resetModules();
  vi.doMock('node:sqlite', async () => {
    const real = await vi.importActual<typeof import('node:sqlite')>('node:sqlite');

    class WrappedDatabaseSync extends real.DatabaseSync {
      constructor(path: string) {
        hooks.before?.(path);
        super(path);
        hooks.after?.(path, this);
      }
    }

    return { ...real, DatabaseSync: WrappedDatabaseSync };
  });

  try {
    const fresh = await import('./db.js');
    use(fresh.openStore);
  } finally {
    vi.doUnmock('node:sqlite');
    vi.resetModules();
  }
}

/* -------------------------------------------------------------------------------------------------
 * A store this process creates or reopens
 * ---------------------------------------------------------------------------------------------- */

describe('a fresh or reopened file-backed store', () => {
  it.skipIf(NO_POSIX_IDS)(
    'creates the database as a regular 0600 file and leaves its WAL sidecars at 0600 after migration (POSIX permission bits)',
    () => {
      const store = openedStore({ databasePath, logger: recordingLogger() });

      const stats = lstatSync(databasePath);
      expect(stats.isFile()).toBe(true);
      expect(stats.nlink).toBe(1);
      expect(modeOf(databasePath)).toBe(OWNER_ONLY_FILE_MODE);
      expect(modeOf(stateDir)).toBe(OWNER_ONLY_DIR_MODE);
      expect(store.schemaVersion).toBeGreaterThanOrEqual(1);

      // The migration is the first write, so WAL mode's sidecars exist now, and
      // SQLite created them with the mode of the placeholder this store made.
      for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
        expect(lstatSync(sidecar).isFile()).toBe(true);
        expect(modeOf(sidecar)).toBe(OWNER_ONLY_FILE_MODE);
      }

      const created = logs.find(
        (record) =>
          record.message === 'created the session store file as an owner-only placeholder',
      );
      expect(created?.fields).toMatchObject({
        subsystem: 'store',
        path: databasePath,
        mode: '600',
      });
    },
  );

  it.skipIf(NO_POSIX_IDS)(
    'tightens a pre-existing world-readable store to 0600 in place, with its data retained (POSIX permission bits)',
    () => {
      const first = openedStore({ databasePath });
      first.db.exec(
        "CREATE TABLE retained_probe (body TEXT NOT NULL); INSERT INTO retained_probe VALUES ('still here');",
      );
      first.close();
      chmodSync(databasePath, WORLD_READABLE_FILE_MODE);
      const inodeBefore = lstatSync(databasePath, { bigint: true }).ino;

      const reopened = openedStore({ databasePath, logger: recordingLogger() });

      expect(modeOf(databasePath)).toBe(OWNER_ONLY_FILE_MODE);
      // In place: the same inode, not a replacement that happens to be private.
      expect(lstatSync(databasePath, { bigint: true }).ino).toBe(inodeBefore);
      expect(reopened.statement('SELECT body FROM retained_probe').get()).toEqual({
        body: 'still here',
      });

      const tightened = logs.find(
        (record) => record.message === TIGHTENED_MESSAGE && record.fields.path === databasePath,
      );
      expect(tightened?.fields).toMatchObject({
        subsystem: 'store',
        previousMode: '644',
        mode: '600',
      });
    },
  );

  it.skipIf(NO_POSIX_IDS)(
    'tightens leftover world-readable -wal and -shm sidecars before SQLite opens them (POSIX permission bits)',
    () => {
      makeStateDir();
      const leftovers = [`${databasePath}-wal`, `${databasePath}-shm`];
      for (const leftover of leftovers) {
        writeFileSync(leftover, '');
        chmodSync(leftover, WORLD_READABLE_FILE_MODE);
      }

      openedStore({ databasePath, logger: recordingLogger() });

      for (const leftover of leftovers) {
        expect(modeOf(leftover)).toBe(OWNER_ONLY_FILE_MODE);
        const tightened = logs.find(
          (record) => record.message === TIGHTENED_MESSAGE && record.fields.path === leftover,
        );
        expect(tightened?.fields).toMatchObject({ previousMode: '644', mode: '600' });
      }
    },
  );

  it('performs no chmod when reopening a store that is already private', () => {
    openedStore({ databasePath }).close();

    openedStore({ databasePath, logger: recordingLogger() });

    expect(logs.filter((record) => record.message === TIGHTENED_MESSAGE)).toEqual([]);
  });

  it('creates a new store in incremental auto-vacuum mode without giving up WAL, and keeps it across a reopen', () => {
    // The mode is only accepted while the file is empty, which is why the
    // pragma leads the sequence: issued after `journal_mode = WAL` it would be
    // ignored and this would read 0.
    const store = openedStore({ databasePath });

    expect(autoVacuumOf(store.db)).toBe(INCREMENTAL_AUTO_VACUUM);
    expect(journalModeOf(store.db)).toBe('wal');

    store.close();
    const reopened = openedStore({ databasePath });

    expect(autoVacuumOf(reopened.db)).toBe(INCREMENTAL_AUTO_VACUUM);
    expect(journalModeOf(reopened.db)).toBe('wal');
  });

  it('reopens a store an earlier build created without auto-vacuum, with its data, until a VACUUM converts it', () => {
    // What a build before incremental auto-vacuum left behind: a WAL database
    // whose header says NONE.
    makeStateDir();
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec('PRAGMA journal_mode = WAL;');
      legacy.exec(PROBE_SEED_SQL);
      expect(autoVacuumOf(legacy)).toBe(NO_AUTO_VACUUM);
    } finally {
      legacy.close();
    }

    const store = openedStore({ databasePath, logger: recordingLogger() });

    // The pragma cannot change an existing file's mode in place: the file still
    // reports NONE, and it opens, migrates and reads as before.
    expect(autoVacuumOf(store.db)).toBe(NO_AUTO_VACUUM);
    expect(journalModeOf(store.db)).toBe('wal');
    expect(store.statement(PROBE_SELECT_SQL).get()).toEqual(PROBE_ROW);

    // The mode is pending on the connection, so the next VACUUM applies it
    // while it rewrites the file.
    store.db.exec('VACUUM;');

    expect(autoVacuumOf(store.db)).toBe(INCREMENTAL_AUTO_VACUUM);
    expect(store.statement(PROBE_SELECT_SQL).get()).toEqual(PROBE_ROW);
  });

  it('opens the in-memory store without creating any file', () => {
    // The path is recognised, never resolved: nothing named after it may appear
    // in the working directory, where a file-backed open of it would land.
    const store = openedStore({ databasePath: ':memory:', logger: recordingLogger() });

    expect(store.path).toBe(':memory:');
    expect(store.schemaVersion).toBeGreaterThanOrEqual(1);
    for (const name of [':memory:', ...SIDECAR_SUFFIXES.map((suffix) => `:memory:${suffix}`)]) {
      expect(existsSync(join(process.cwd(), name))).toBe(false);
    }
    expect(
      logs.filter(
        (record) => record.message.includes('placeholder') || record.message === TIGHTENED_MESSAGE,
      ),
    ).toEqual([]);
  });

  it('opens a store through the service configuration inside its state root', () => {
    const store = openedStore({
      config: { debuggenHome: stateDir, databasePath },
      logger: recordingLogger(),
    });

    expect(store.path).toBe(databasePath);
    expect(lstatSync(databasePath).isFile()).toBe(true);
    expect(lstatSync(databasePath).nlink).toBe(1);
  });

  it.skipIf(NO_POSIX_IDS)(
    'leaves the state root 0700 and the database 0600 on the configuration route (POSIX permission bits)',
    () => {
      openedStore({ config: { debuggenHome: stateDir, databasePath } });

      expect(modeOf(stateDir)).toBe(OWNER_ONLY_DIR_MODE);
      expect(modeOf(databasePath)).toBe(OWNER_ONLY_FILE_MODE);
    },
  );

  it('opens a store the caller vouches for with ensureDirectory: false', () => {
    makeStateDir();

    const store = openedStore({ databasePath, ensureDirectory: false });

    expect(store.path).toBe(databasePath);
    expect(lstatSync(databasePath).isFile()).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The exact-0600 mode, and failing closed when a file cannot be made owner-only
 * ---------------------------------------------------------------------------------------------- */

/** One way a filesystem fails to make a file owner-only, and the errno the store reports for it. */
interface ModeFailure {
  readonly label: string;
  readonly behaviour: ChmodFaultBehaviour;
  readonly errno: string | undefined;
}

/** A `chmod` the filesystem refuses, and one it accepts without changing the bits. */
const MODE_FAILURES: readonly ModeFailure[] = [
  { label: 'refuses the chmod with EPERM', behaviour: 'throw', errno: 'EPERM' },
  { label: 'accepts the chmod without effect', behaviour: 'ignore', errno: undefined },
];

/** Owner-only modes other than `0600`, each with the octal string the store logs for it. */
const OWNER_ONLY_OTHER_MODES = [
  { label: '0400', mode: OWNER_READ_ONLY_FILE_MODE, logged: '400' },
  { label: '0700', mode: OWNER_ALL_FILE_MODE, logged: '700' },
] as const;

describe.skipIf(NO_POSIX_IDS)('the exact-0600 file mode (POSIX permission bits)', () => {
  it.each(OWNER_ONLY_OTHER_MODES)(
    'reopens a pre-existing $label store at exactly 0600 in place, with its data retained',
    ({ mode, logged }) => {
      createStoreWithProbeRow();
      chmodSync(databasePath, mode);
      const inodeBefore = lstatSync(databasePath, { bigint: true }).ino;

      const reopened = openedStore({ databasePath, logger: recordingLogger() });

      expect(modeOf(databasePath)).toBe(OWNER_ONLY_FILE_MODE);
      // In place: the same inode, not a replacement that happens to be 0600.
      expect(lstatSync(databasePath, { bigint: true }).ino).toBe(inodeBefore);
      expect(reopened.statement(PROBE_SELECT_SQL).get()).toEqual(PROBE_ROW);
      expect(logsAbout(TIGHTENED_MESSAGE, databasePath)[0]?.fields).toMatchObject({
        subsystem: 'store',
        previousMode: logged,
        mode: '600',
      });
    },
  );

  it.each(OWNER_ONLY_OTHER_MODES)(
    'sets leftover $label -wal and -shm sidecars to exactly 0600 before SQLite opens them',
    ({ mode, logged }) => {
      makeStateDir();
      const leftovers = [`${databasePath}-wal`, `${databasePath}-shm`];
      for (const leftover of leftovers) {
        writeFileSync(leftover, '');
        chmodSync(leftover, mode);
      }

      openedStore({ databasePath, logger: recordingLogger() });

      for (const leftover of leftovers) {
        expect(modeOf(leftover)).toBe(OWNER_ONLY_FILE_MODE);
        expect(logsAbout(TIGHTENED_MESSAGE, leftover)[0]?.fields).toMatchObject({
          previousMode: logged,
          mode: '600',
        });
      }
    },
  );

  it.each(MODE_FAILURES)(
    'refuses a 0644 database when the filesystem $label, writing nothing and opening no connection',
    async ({ behaviour, errno }) => {
      createStoreWithProbeRow();
      chmodSync(databasePath, WORLD_READABLE_FILE_MODE);
      const before = fingerprint(databasePath);
      injectChmodFault(databasePath, behaviour);
      const constructed: string[] = [];

      await withWrappedConstructor(
        {
          before: (path) => {
            constructed.push(path);
          },
        },
        (open) => {
          const error = expectUnsafeFile(
            open({ databasePath, logger: recordingLogger() }),
            MODE_REFUSAL_REASON,
            databasePath,
          );
          expect(error.details?.mode).toBe('644');
          expect(error.details?.expectedMode).toBe('600');
          expect(error.details?.errno).toBe(errno);
          expect(error.hint).toContain(`chmod 600 ${databasePath}`);
          expect(error.hint).toContain(
            'set DEBUGGEN_HOME to a state directory on a filesystem that records POSIX permissions',
          );
        },
      );

      // The repair really was attempted, exactly once, before the refusal.
      expect(chmodFault.attempts).toEqual([databasePath]);
      // SQLite was never constructed: no connection exists to write or to leak.
      expect(constructed).toEqual([]);
      expectUnchanged(databasePath, before);
      expectNoSidecarsBeside(databasePath);
      expect(logsAbout(TIGHTENED_MESSAGE, databasePath)).toEqual([]);

      // Once the filesystem honours the chmod, the same store opens at 0600
      // with its data: the refusal cost nothing but the start.
      clearChmodFault();
      const reopened = openedStore({ databasePath });
      expect(modeOf(databasePath)).toBe(OWNER_ONLY_FILE_MODE);
      expect(reopened.statement(PROBE_SELECT_SQL).get()).toEqual(PROBE_ROW);
    },
  );

  it.each(MODE_FAILURES)(
    'refuses a leftover 0644 -shm when the filesystem $label, before SQLite opens anything',
    async ({ behaviour, errno }) => {
      makeStateDir();
      const shm = `${databasePath}-shm`;
      writeFileSync(shm, '');
      chmodSync(shm, WORLD_READABLE_FILE_MODE);
      const before = fingerprint(shm);
      injectChmodFault(shm, behaviour);
      const constructed: string[] = [];

      await withWrappedConstructor(
        {
          before: (path) => {
            constructed.push(path);
          },
        },
        (open) => {
          const error = expectUnsafeFile(open({ databasePath }), MODE_REFUSAL_REASON, shm);
          expect(error.details).toMatchObject({ mode: '644', expectedMode: '600' });
          expect(error.details?.errno).toBe(errno);
        },
      );

      expect(chmodFault.attempts).toEqual([shm]);
      expect(constructed).toEqual([]);
      expectUnchanged(shm, before);
      // Only the empty private placeholder and the refused sidecar exist.
      expect(entriesIn(stateDir)).toEqual(['sessions.sqlite', 'sessions.sqlite-shm']);
      expect(statSync(databasePath).size).toBe(0);
    },
  );

  it.each(MODE_FAILURES)(
    'refuses a 0644 -wal that appears after the open when the filesystem $label, closing the connection before the migration',
    async ({ behaviour, errno }) => {
      // An empty -wal, which SQLite counts as absent and so neither replays nor
      // deletes: it is opened as it stands, at the mode it was planted with.
      const wal = `${databasePath}-wal`;
      const connections: DatabaseSync[] = [];

      await withWrappedConstructor(
        {
          after: (path, connection) => {
            if (path === databasePath) {
              connections.push(connection);
              writeFileSync(wal, '');
              chmodSync(wal, WORLD_READABLE_FILE_MODE);
              injectChmodFault(wal, behaviour);
            }
          },
        },
        (open) => {
          const error = expectUnsafeFile(open({ databasePath }), MODE_REFUSAL_REASON, wal);
          expect(error.details).toMatchObject({ mode: '644', expectedMode: '600' });
          expect(error.details?.errno).toBe(errno);
        },
      );

      expect(chmodFault.attempts).toEqual([wal]);
      // The connection the refusal found open was closed before the error returned.
      expect(connections).toHaveLength(1);
      expect(connections[0]?.isOpen).toBe(false);

      // And the refusal came before the migration: the database holds no table.
      clearChmodFault();
      const inspector = new DatabaseSync(databasePath);
      try {
        expect(inspector.prepare('SELECT count(*) AS tables FROM sqlite_master').get()).toEqual({
          tables: 0,
        });
      } finally {
        inspector.close();
      }
    },
  );

  it.each(MODE_FAILURES)(
    'accepts a 0700 database as private when the filesystem $label, noting the mode at debug',
    ({ behaviour, errno }) => {
      // What a filesystem reporting one fixed owner-only mode for every file
      // looks like: nothing another account can reach, so nothing to refuse.
      createStoreWithProbeRow();
      chmodSync(databasePath, OWNER_ALL_FILE_MODE);
      injectChmodFault(databasePath, behaviour);

      const store = openedStore({ databasePath, logger: recordingLogger() });

      expect(chmodFault.attempts).not.toEqual([]);
      expect(modeOf(databasePath)).toBe(OWNER_ALL_FILE_MODE);
      expect(store.statement(PROBE_SELECT_SQL).get()).toEqual(PROBE_ROW);

      const accepted = logsAbout(ACCEPTED_OWNER_ONLY_MESSAGE, databasePath);
      expect(accepted).not.toEqual([]);
      for (const record of accepted) {
        expect(record.level).toBe('debug');
        expect(record.fields).toMatchObject({
          subsystem: 'store',
          previousMode: '700',
          mode: '700',
        });
        expect(record.fields.errno).toBe(errno);
      }
      expect(logsAbout(TIGHTENED_MESSAGE, databasePath)).toEqual([]);
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * An unsafe database path
 * ---------------------------------------------------------------------------------------------- */

describe('an unsafe entry at the database path', () => {
  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a symbolic link to a real database, which it neither migrates nor tightens (requires symlink creation)',
    () => {
      makeStateDir();
      const victim = makeOutsideDatabase('victim.sqlite');
      const before = fingerprint(victim);
      symlinkSync(victim, databasePath);

      expectUnsafeFile(openStore({ databasePath }), 'symlink-component', databasePath);

      expect(lstatSync(databasePath).isSymbolicLink()).toBe(true);
      expectUnchanged(victim, before);
      expectNoSidecarsBeside(victim);
      expect(entriesIn(stateDir)).toEqual(['sessions.sqlite']);

      // The refusal left no handle behind: once the link is gone, the next start
      // creates a private store of its own.
      rmSync(databasePath);
      expect(lstatSync(openedStore({ databasePath }).path).isFile()).toBe(true);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a dangling symbolic link, and creates nothing where it points (requires symlink creation)',
    () => {
      makeStateDir();
      const planted = join(outsideDir, 'planted.sqlite');
      symlinkSync(planted, databasePath);

      expectUnsafeFile(openStore({ databasePath }), 'symlink-component', databasePath);

      expect(existsSync(planted)).toBe(false);
      expect(entriesIn(outsideDir)).toEqual([]);
      expect(lstatSync(databasePath).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a symbolic link even when ensureDirectory is false (requires symlink creation)',
    () => {
      // The switch vouches for the directory, never for the entry at the path.
      makeStateDir();
      const victim = makeOutsideDatabase('victim.sqlite');
      const before = fingerprint(victim);
      symlinkSync(victim, databasePath);

      expectUnsafeFile(
        openStore({ databasePath, ensureDirectory: false }),
        'symlink-component',
        databasePath,
      );

      expectUnchanged(victim, before);
      expectNoSidecarsBeside(victim);
    },
  );

  it('refuses a directory at the database path', () => {
    makeStateDir();
    mkdirSync(databasePath);

    expectUnsafeFile(openStore({ databasePath }), 'not-a-regular-file', databasePath);

    expect(lstatSync(databasePath).isDirectory()).toBe(true);
    expect(entriesIn(databasePath)).toEqual([]);
  });

  it.skipIf(!CAN_CREATE_HARD_LINKS)(
    'refuses a database with a second hard link outside the state tree (requires hard-link creation)',
    () => {
      openedStore({ databasePath }).close();
      const outsideName = join(outsideDir, 'copy.sqlite');
      linkSync(databasePath, outsideName);
      const before = fingerprint(outsideName);

      const error = expectUnsafeFile(openStore({ databasePath }), 'multiply-linked', databasePath);

      expect(error.details?.links).toBe(2);
      expectUnchanged(outsideName, before);
      expectNoSidecarsBeside(databasePath);
    },
  );

  it.skipIf(NO_POSIX_IDS || FOREIGN_UID === undefined)(
    'refuses a database owned by another account (requires assigning a foreign owner)',
    () => {
      openedStore({ databasePath }).close();
      const foreignUid = FOREIGN_UID ?? expect.unreachable('guarded on FOREIGN_UID');
      chownSync(databasePath, foreignUid, lstatSync(databasePath).gid);
      const before = fingerprint(databasePath);

      const error = expectUnsafeFile(openStore({ databasePath }), 'foreign-owner', databasePath);

      expect(error.details?.owner).toBe(foreignUid);
      expect(error.details?.expectedOwner).toBe(process.getuid?.());
      expectUnchanged(databasePath, before);
      expect(lstatSync(databasePath).uid).toBe(foreignUid);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a database whose directory resolves out of the state root, creating nothing there (requires symlink creation)',
    () => {
      // `ensureDirectory: false` skips the directory walk that would otherwise
      // refuse the linked component, so this is the canonical-path check alone.
      makeStateDir();
      const linkedDir = join(stateDir, 'linked');
      symlinkSync(outsideDir, linkedDir);
      const redirected = join(linkedDir, 'sessions.sqlite');

      const error = refusalFrom(
        openStore({
          config: { debuggenHome: stateDir, databasePath: redirected },
          ensureDirectory: false,
        }),
      );

      expect(error.code).toBe('FS_UNSAFE_PATH');
      expect(error.details?.reason).toBe('outside-state-root');
      expect(error.details?.file).toBe(redirected);
      expect(error.details?.canonicalPath).toBe(join(outsideDir, 'sessions.sqlite'));
      expect(error.hint).toContain(linkedDir);
      expect(entriesIn(outsideDir)).toEqual([]);
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * The state directory a store is opened in
 * ---------------------------------------------------------------------------------------------- */

/** The state root a configuration-route case declares, inside {@link sandbox} and never pre-created. */
function unusedStateRoot(): string {
  return join(sandbox, 'home');
}

/**
 * Asserts an open was refused as `CONFIG_INVALID` for `reason`.
 *
 * The configuration is wrong rather than the filesystem, so the code is the
 * configuration one, and `databasePath` in the details is the resolved path the
 * developer passed.
 */
function expectConfigRefusal(
  opened: Result<Store, DebuggenError>,
  reason: string,
  requestedPath: string,
): DebuggenError {
  const error = refusalFrom(opened);
  expect(error.code).toBe('CONFIG_INVALID');
  expect(error.details?.reason).toBe(reason);
  expect(error.details?.subsystem).toBe('store');
  expect(error.details?.databasePath).toBe(requestedPath);
  expect(error.hint).toContain('databasePath');
  return error;
}

/**
 * Asserts an open was refused because `directory` already existed with group
 * or other access, and that the refusal names that directory, the mode it has,
 * the mode it needs and the `chmod` that fixes it, with the policy error it
 * wraps kept as the cause.
 */
function expectLooseDirectoryRefusal(
  opened: Result<Store, DebuggenError>,
  directory: string,
  mode: number,
): DebuggenError {
  const reportedMode = (mode & PERMISSION_BITS).toString(8);
  const error = refusalFrom(opened);
  expect(error.code).toBe('FS_UNSAFE_PATH');
  expect(error.details?.reason).toBe(MODE_REFUSAL_REASON);
  expect(error.details?.path).toBe(directory);
  expect(error.details?.mode).toBe(reportedMode);
  expect(error.details?.subsystem).toBe('store');
  // The mode found and the mode required, as a developer reads them, then the
  // command as it is typed.
  expect(error.hint).toContain(`${directory} has mode 0${reportedMode}`);
  expect(error.hint).toContain('it must be 0700');
  expect(error.hint).toContain(`chmod 700 ${directory}`);
  expect(error.hint).toContain('DEBUGGEN_HOME');

  const cause: unknown = error.cause;
  expect(cause).toMatchObject({
    code: 'FS_UNSAFE_PATH',
    details: {
      reason: MODE_REFUSAL_REASON,
      path: directory,
      mode: reportedMode,
    },
  });
  return error;
}

describe('the state directory a store is opened in', () => {
  it('refuses a configuration whose database lies outside its state root, before creating anything', () => {
    const stateRoot = unusedStateRoot();
    const outsideDatabase = join(outsideDir, 'outside.sqlite');

    // Both with and without the directory walk: the containment is a property
    // of the configuration, so it is decided before either could run.
    for (const ensureDirectory of [undefined, false]) {
      const error = expectConfigRefusal(
        openStore({
          config: { debuggenHome: stateRoot, databasePath: outsideDatabase },
          ...(ensureDirectory === undefined ? {} : { ensureDirectory }),
        }),
        'outside-state-root',
        outsideDatabase,
      );

      expect(error.details?.debuggenHome).toBe(stateRoot);
      expect(error.hint).toContain(stateRoot);
      expect(entriesIn(outsideDir)).toEqual([]);
      expect(existsSync(stateRoot)).toBe(false);
    }
  });

  it('refuses a database in a sibling whose name merely begins with the state root', () => {
    // The lexical gate compares whole components: `<root>-other` is not inside
    // `<root>`, however the two strings begin.
    const stateRoot = unusedStateRoot();
    const sibling = `${stateRoot}-other`;
    const siblingDatabase = join(sibling, 'sessions.sqlite');

    expectConfigRefusal(
      openStore({ config: { debuggenHome: stateRoot, databasePath: siblingDatabase } }),
      'outside-state-root',
      siblingDatabase,
    );

    expect(existsSync(sibling)).toBe(false);
    expect(existsSync(stateRoot)).toBe(false);
  });

  it.skipIf(NO_POSIX_IDS)(
    'leaves the mode of the directory outside the state root untouched when it refuses the configuration (POSIX permission bits)',
    () => {
      expectConfigRefusal(
        openStore({
          config: {
            debuggenHome: unusedStateRoot(),
            databasePath: join(outsideDir, 'outside.sqlite'),
          },
        }),
        'outside-state-root',
        join(outsideDir, 'outside.sqlite'),
      );

      expect(modeOf(outsideDir)).toBe(ORDINARY_DIR_MODE);
    },
  );

  it.each(['', '   '])('refuses a configuration whose state root is blank (%j)', (blank) => {
    expectConfigRefusal(
      openStore({ config: { debuggenHome: blank, databasePath } }),
      'empty-state-root',
      databasePath,
    );

    expect(existsSync(stateDir)).toBe(false);
  });

  it.skipIf(NO_POSIX_IDS)(
    'refuses a state root that already exists at 0755 on the configuration route, changing nothing (POSIX permission bits)',
    () => {
      mkdirSync(stateDir);
      chmodSync(stateDir, ORDINARY_DIR_MODE);

      expectLooseDirectoryRefusal(
        openStore({ config: { debuggenHome: stateDir, databasePath } }),
        stateDir,
        ORDINARY_DIR_MODE,
      );

      expect(modeOf(stateDir)).toBe(ORDINARY_DIR_MODE);
      expect(entriesIn(stateDir)).toEqual([]);
    },
  );

  it.skipIf(NO_POSIX_IDS)(
    'names the state root rather than the database directory when the root is the loose one (POSIX permission bits)',
    () => {
      // The outermost failing directory is the one to fix first, so the
      // refusal names it even though the database lives one level below.
      mkdirSync(stateDir);
      chmodSync(stateDir, ORDINARY_DIR_MODE);
      const nestedDatabase = join(stateDir, 'nested', 'sessions.sqlite');

      expectLooseDirectoryRefusal(
        openStore({ config: { debuggenHome: stateDir, databasePath: nestedDatabase } }),
        stateDir,
        ORDINARY_DIR_MODE,
      );

      expect(modeOf(stateDir)).toBe(ORDINARY_DIR_MODE);
      expect(entriesIn(stateDir)).toEqual([]);
    },
  );

  it.skipIf(NO_POSIX_IDS)(
    'refuses a database directory that already exists at 0755 on the databasePath route, changing nothing (POSIX permission bits)',
    () => {
      mkdirSync(stateDir);
      chmodSync(stateDir, ORDINARY_DIR_MODE);

      expectLooseDirectoryRefusal(openStore({ databasePath }), stateDir, ORDINARY_DIR_MODE);

      expect(modeOf(stateDir)).toBe(ORDINARY_DIR_MODE);
      expect(entriesIn(stateDir)).toEqual([]);
    },
  );

  it.skipIf(NO_POSIX_IDS)(
    'opens a store in a state root that already exists and is private, leaving its mode as it was (POSIX permission bits)',
    () => {
      makeStateDir();

      const store = openedStore({ config: { debuggenHome: stateDir, databasePath } });

      expect(store.path).toBe(databasePath);
      expect(modeOf(stateDir)).toBe(OWNER_ONLY_DIR_MODE);
      expect(modeOf(databasePath)).toBe(OWNER_ONLY_FILE_MODE);
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * An unsafe sidecar
 * ---------------------------------------------------------------------------------------------- */

describe.skipIf(!CAN_CREATE_SYMLINKS)(
  'a symbolic link planted at a sidecar (requires symlink creation)',
  () => {
    it.each(SIDECAR_SUFFIXES)(
      'refuses a link at %s before SQLite opens it, and leaves its target untouched',
      (suffix) => {
        makeStateDir();
        const sidecar = `${databasePath}${suffix}`;
        const victim = join(outsideDir, `victim${suffix}`);
        writeFileSync(victim, 'bytes that belong to another file\n');
        chmodSync(victim, WORLD_READABLE_FILE_MODE);
        const before = fingerprint(victim);
        symlinkSync(victim, sidecar);

        expectUnsafeFile(openStore({ databasePath }), 'symlink-component', sidecar);

        expectUnchanged(victim, before);
        expect(lstatSync(sidecar).isSymbolicLink()).toBe(true);
        // SQLite never ran: the only entries are the empty private placeholder
        // and the planted link.
        expect(entriesIn(stateDir)).toEqual(['sessions.sqlite', `sessions.sqlite${suffix}`]);
        expect(statSync(databasePath).size).toBe(0);
      },
    );

    it.each(SIDECAR_SUFFIXES)(
      'refuses a dangling link at %s, and creates nothing where it points',
      (suffix) => {
        makeStateDir();
        const sidecar = `${databasePath}${suffix}`;
        const planted = join(outsideDir, `planted${suffix}`);
        symlinkSync(planted, sidecar);

        expectUnsafeFile(openStore({ databasePath }), 'symlink-component', sidecar);

        expect(existsSync(planted)).toBe(false);
        expect(entriesIn(outsideDir)).toEqual([]);
      },
    );
  },
);

/* -------------------------------------------------------------------------------------------------
 * The open itself
 * ---------------------------------------------------------------------------------------------- */

describe('the windows around the open', () => {
  it('refuses a database replaced between the file policy and the open', async () => {
    // A different regular file renamed over the path just before SQLite opens
    // it: same name, same owner, same mode — only the inode tells them apart.
    const replacement = join(sandbox, 'replacement.sqlite');

    await withWrappedConstructor(
      {
        before: (path) => {
          if (path === databasePath) {
            writeFileSync(replacement, '');
            chmodSync(replacement, OWNER_ONLY_FILE_MODE);
            renameSync(replacement, path);
          }
        },
      },
      (open) => {
        expectUnsafeFile(open({ databasePath }), 'identity-changed', databasePath);
      },
    );
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a sidecar link that appears after the open, before the migration writes (requires symlink creation)',
    async () => {
      const sidecar = `${databasePath}-wal`;

      await withWrappedConstructor(
        {
          after: (path) => {
            if (path === databasePath) {
              symlinkSync(join(outsideDir, 'planted-wal'), sidecar);
            }
          },
        },
        (open) => {
          expectUnsafeFile(open({ databasePath }), 'symlink-component', sidecar);
        },
      );
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * The pragmas and the background checkpointer
 * ---------------------------------------------------------------------------------------------- */

describe('the connection pragmas and the background write-ahead-log checkpointer', () => {
  /** How long a case waits for the worker to start or to act; generous for a loaded host. */
  const WORKER_WAIT = { timeout: 15_000, interval: 20 } as const;

  /** The per-case timeout of every case that waits on the worker. */
  const CASE_TIMEOUT_MS = 30_000;

  /** Rows of ballast one {@link writeBallast} call commits, each about one page. */
  const BALLAST_ROWS = DEFAULT_WAL_AUTOCHECKPOINT_PAGES + 500;

  /** The bytes of one ballast row: close to a 4 KiB page, so each row dirties about one. */
  const BALLAST_BYTES = 3_500;

  /** The message the store logs once the worker has taken checkpointing over. */
  const RUNNING_MESSAGE = 'the session store write-ahead log is checkpointed in the background';

  /** The message the store logs when the worker is gone and the connection checkpoints itself. */
  const FAILED_MESSAGE =
    'the session store background checkpointer stopped; commits checkpoint the write-ahead log themselves again';

  /** One numeric column of a single-row pragma on the store's own connection. */
  function pragmaNumber(store: Store, sql: string, column: string): number {
    const row: Record<string, unknown> | undefined = store.db.prepare(sql).get();
    const value = row?.[column];
    return typeof value === 'bigint' ? Number(value) : Number(value);
  }

  /** The main connection's `wal_autocheckpoint`, in pages. */
  function autocheckpointOf(store: Store): number {
    return pragmaNumber(store, 'PRAGMA wal_autocheckpoint', 'wal_autocheckpoint');
  }

  /** The write-ahead log's frame count and how many of them are in the database file. */
  function walOf(store: Store): { readonly log: number; readonly checkpointed: number } {
    const row: Record<string, unknown> | undefined = store.db
      .prepare('PRAGMA wal_checkpoint(NOOP)')
      .get();
    return { log: Number(row?.['log']), checkpointed: Number(row?.['checkpointed']) };
  }

  /** Commits one transaction that grows the write-ahead log past SQLite's own threshold. */
  function writeBallast(store: Store): void {
    store.db.exec('CREATE TABLE IF NOT EXISTS ballast (body BLOB NOT NULL);');
    store.transaction(() => {
      const insert = store.statement('INSERT INTO ballast (body) VALUES (randomblob(?))');
      for (let row = 0; row < BALLAST_ROWS; row += 1) {
        insert.run(BALLAST_BYTES);
      }
    });
  }

  /** Opens a file-backed store with the recording logger and waits for its checkpointer to run. */
  async function runningStore(): Promise<Store> {
    const store = openedStore({ databasePath, logger: recordingLogger() });
    await vi.waitFor(() => {
      expect(autocheckpointOf(store)).toBe(0);
    }, WORKER_WAIT);
    return store;
  }

  /** The one worker the current case spawned. */
  function onlyWorker(): Worker {
    expect(workerSpy.spawned).toHaveLength(1);
    const [worker] = workerSpy.spawned;
    if (worker === undefined) {
      return expect.unreachable('no background checkpointer was spawned');
    }
    return worker;
  }

  /** Waits until a worker thread has ended: `threadId` reads -1 once it has. */
  async function expectExited(worker: Worker): Promise<void> {
    await vi.waitFor(() => {
      expect(worker.threadId).toBe(-1);
    }, WORKER_WAIT);
  }

  /** The records the store logged with `message`. */
  function logged(message: string): LogRecord[] {
    return logs.filter((record) => record.message === message);
  }

  it('declares the pragmas in order, the 64 MiB page cache last, and applies them to every connection', () => {
    expect(STORE_PRAGMAS).toEqual([
      'PRAGMA auto_vacuum = INCREMENTAL;',
      'PRAGMA journal_mode = WAL;',
      'PRAGMA foreign_keys = ON;',
      'PRAGMA busy_timeout = 5000;',
      'PRAGMA synchronous = NORMAL;',
      'PRAGMA cache_size = -65536;',
    ]);
    expect(Object.isFrozen(STORE_PRAGMAS)).toBe(true);

    for (const store of [
      openedStore({ databasePath: ':memory:' }),
      openedStore({ databasePath }),
    ]) {
      expect(pragmaNumber(store, 'PRAGMA cache_size', 'cache_size')).toBe(-65_536);
      expect(pragmaNumber(store, 'PRAGMA foreign_keys', 'foreign_keys')).toBe(1);
      expect(pragmaNumber(store, 'PRAGMA busy_timeout', 'timeout')).toBe(5_000);
      expect(pragmaNumber(store, 'PRAGMA synchronous', 'synchronous')).toBe(1);
    }
  });

  it('spawns no worker for the in-memory store, which keeps SQLite’s own checkpointing', () => {
    const store = openedStore({ databasePath: ':memory:', logger: recordingLogger() });

    expect(workerSpy.spawned).toHaveLength(0);
    expect(autocheckpointOf(store)).toBe(DEFAULT_WAL_AUTOCHECKPOINT_PAGES);
    store.close();
    expect(logged(FAILED_MESSAGE)).toEqual([]);
  });

  it(
    'spawns exactly one worker for a file-backed store and hands it checkpointing once it runs',
    async () => {
      const store = openedStore({ databasePath, logger: recordingLogger() });
      const worker = onlyWorker();

      await vi.waitFor(() => {
        expect(autocheckpointOf(store)).toBe(0);
      }, WORKER_WAIT);
      expect(logged(RUNNING_MESSAGE)).toHaveLength(1);
      expect(logged(RUNNING_MESSAGE)[0]).toMatchObject({
        level: 'debug',
        fields: { subsystem: 'store', thresholdPages: DEFAULT_WAL_AUTOCHECKPOINT_PAGES },
      });
      expect(worker.threadId).toBeGreaterThan(0);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'folds a grown write-ahead log back in from the worker while the main connection never checkpoints',
    async () => {
      const store = await runningStore();

      writeBallast(store);
      // The main connection's automatic checkpoint is off, so the commit above
      // left the log for the worker; it grew past SQLite's own threshold.
      expect(autocheckpointOf(store)).toBe(0);
      expect(walOf(store).log).toBeGreaterThanOrEqual(DEFAULT_WAL_AUTOCHECKPOINT_PAGES);

      await vi.waitFor(() => {
        const wal = walOf(store);
        expect(wal.log).toBeGreaterThanOrEqual(DEFAULT_WAL_AUTOCHECKPOINT_PAGES);
        expect(wal.checkpointed).toBe(wal.log);
      }, WORKER_WAIT);

      // The data is in the database file itself: a second, independent
      // connection reading the file alone (no log) sees every row.
      const reader = new DatabaseSync(`file:${databasePath}?immutable=1`, { readOnly: true });
      try {
        const row: Record<string, unknown> | undefined = reader
          .prepare('SELECT COUNT(*) AS rows FROM ballast')
          .get();
        expect(Number(row?.['rows'])).toBe(BALLAST_ROWS);
      } finally {
        reader.close();
      }
      expect(logged(FAILED_MESSAGE)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'truncates the write-ahead log on checkpoint() while the worker runs, and keeps the worker running',
    async () => {
      const store = await runningStore();

      writeBallast(store);
      store.checkpoint();

      expect(statSync(`${databasePath}-wal`).size).toBe(0);
      expect(autocheckpointOf(store)).toBe(0);
      expect(onlyWorker().threadId).toBeGreaterThan(0);
      expect(logs.filter((record) => record.message.includes('busy'))).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'hands checkpointing back to the main connection when the worker exits unexpectedly',
    async () => {
      const store = await runningStore();
      const worker = onlyWorker();

      await worker.terminate();

      await vi.waitFor(() => {
        expect(autocheckpointOf(store)).toBe(DEFAULT_WAL_AUTOCHECKPOINT_PAGES);
      }, WORKER_WAIT);
      expect(logged(FAILED_MESSAGE)).toHaveLength(1);
      expect(logged(FAILED_MESSAGE)[0]).toMatchObject({
        level: 'warn',
        fields: { subsystem: 'store', operation: 'exit' },
      });

      // The store itself is unaffected: it writes, checkpoints on commit again,
      // and closes cleanly without waiting for a worker that is gone.
      writeBallast(store);
      expect(walOf(store).checkpointed).toBeGreaterThan(0);
      const startedAt = performance.now();
      store.close();
      expect(performance.now() - startedAt).toBeLessThan(WAL_CHECKPOINTER_STOP_WAIT_MS);
      expectNoSidecarsBeside(databasePath);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'never takes checkpointing over from a worker that fails as it starts, and reports it once',
    async () => {
      workerSpy.replacementSource = "throw new Error('checkpointer failed to start');";
      const store = openedStore({ databasePath, logger: recordingLogger() });
      const worker = onlyWorker();

      await vi.waitFor(() => {
        expect(logged(FAILED_MESSAGE)).toHaveLength(1);
      }, WORKER_WAIT);
      expect(logged(FAILED_MESSAGE)[0]).toMatchObject({
        level: 'warn',
        fields: { subsystem: 'store', operation: 'worker', reason: 'checkpointer failed to start' },
      });
      expect(autocheckpointOf(store)).toBe(DEFAULT_WAL_AUTOCHECKPOINT_PAGES);
      expect(logged(RUNNING_MESSAGE)).toEqual([]);

      writeBallast(store);
      store.close();
      await expectExited(worker);
      expectNoSidecarsBeside(databasePath);
      expect(logged(FAILED_MESSAGE)).toHaveLength(1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'stops the worker on close, twice over, leaving no sidecar and no thread behind',
    async () => {
      const store = await runningStore();
      const worker = onlyWorker();
      writeBallast(store);

      const startedAt = performance.now();
      store.close();
      store.close();
      expect(performance.now() - startedAt).toBeLessThan(WAL_CHECKPOINTER_STOP_WAIT_MS);

      expect(store.isClosed).toBe(true);
      expectNoSidecarsBeside(databasePath);
      await expectExited(worker);
      expect(logged(FAILED_MESSAGE)).toEqual([]);

      // Everything the case wrote is in the one file left behind.
      const reopened = openedStore({ databasePath });
      const row: Record<string, unknown> | undefined = reopened.db
        .prepare('SELECT COUNT(*) AS rows FROM ballast')
        .get();
      expect(Number(row?.['rows'])).toBe(BALLAST_ROWS);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'closes a store straight after the open without waiting for a worker that has not started',
    async () => {
      const store = openedStore({ databasePath, logger: recordingLogger() });
      const worker = onlyWorker();

      const startedAt = performance.now();
      store.close();
      expect(performance.now() - startedAt).toBeLessThan(WAL_CHECKPOINTER_STOP_WAIT_MS);

      expectNoSidecarsBeside(databasePath);
      await expectExited(worker);
      expect(logged(RUNNING_MESSAGE)).toEqual([]);
      expect(logged(FAILED_MESSAGE)).toEqual([]);
      expect(
        logged('the session store background checkpointer did not stop in time and was terminated'),
      ).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});

/* -------------------------------------------------------------------------------------------------
 * The checkpoint and the close
 * ---------------------------------------------------------------------------------------------- */

/** The message of the close record when the write-ahead log was folded in and truncated. */
const CLOSED_AFTER_CHECKPOINT_MESSAGE =
  'the session store checkpointed its write-ahead log and closed';

/** The message of the close record when the checkpoint did not complete. */
const CLOSED_WITHOUT_CHECKPOINT_MESSAGE =
  'the session store closed without completing its write-ahead log checkpoint';

/** The field names a checkpoint with frame counts reports, sorted. */
const CHECKPOINT_COUNT_FIELDS = ['busy', 'checkpoint', 'checkpointedFrames', 'logFrames'] as const;

/** The session store's records at `level` during the current case. */
function storeRecordsAt(level: LogRecord['level']): LogRecord[] {
  return logs.filter((record) => record.level === level && record.fields.subsystem === 'store');
}

/**
 * The frame counts a checkpoint record carries, asserted to be finite numbers
 * rather than taken on trust.
 */
function frameCountsOf(record: LogRecord | undefined): { logFrames: number; checkpointed: number } {
  const logFrames = record?.fields.logFrames;
  const checkpointed = record?.fields.checkpointedFrames;
  if (typeof logFrames !== 'number' || typeof checkpointed !== 'number') {
    return expect.unreachable('the checkpoint record carried no numeric frame counts');
  }
  expect(Number.isFinite(logFrames)).toBe(true);
  expect(Number.isFinite(checkpointed)).toBe(true);
  return { logFrames, checkpointed };
}

describe('the checkpoint a store reports', () => {
  it('writes one info record with the frame counts once the write-ahead log is folded in and the store closed, and nothing on a second close', () => {
    const store = openedStore({ databasePath, logger: recordingLogger() });
    store.db.exec(PROBE_SEED_SQL);
    const wal = `${databasePath}-wal`;
    expect(statSync(wal).size).toBeGreaterThan(0);
    logs.length = 0;

    store.close();

    const infos = storeRecordsAt('info');
    expect(infos).toHaveLength(1);
    const [closed] = infos;
    expect(closed?.message).toBe(CLOSED_AFTER_CHECKPOINT_MESSAGE);
    expect(closed?.fields).toMatchObject({
      subsystem: 'store',
      databasePath,
      checkpoint: 'completed',
      busy: 0,
    });
    const { logFrames, checkpointed } = frameCountsOf(closed);
    expect(logFrames).toBeGreaterThan(0);
    expect(checkpointed).toBe(logFrames);
    // A status, counts and the path the open record already named: nothing
    // from a row, a statement or a page.
    expect(Object.keys(closed?.fields ?? {}).sort()).toEqual(
      [...CHECKPOINT_COUNT_FIELDS, 'databasePath', 'subsystem'].sort(),
    );
    expect(store.isClosed).toBe(true);
    // Folded in: no log is left beside the database, and the row is in it.
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
    expect(openedStore({ databasePath }).statement(PROBE_SELECT_SQL).get()).toEqual(PROBE_ROW);

    logs.length = 0;
    store.close();

    expect(logs).toEqual([]);
  });

  it('reports a checkpoint a reader holds back as busy, still in the one info record, and closes', () => {
    const store = openedStore({ databasePath, logger: recordingLogger() });
    store.db.exec(PROBE_SEED_SQL);
    // No wait, so the truncating checkpoint reports the reader at once rather
    // than waiting out the store's busy timeout for it.
    store.db.exec('PRAGMA busy_timeout = 0;');

    const reader = new DatabaseSync(databasePath);
    try {
      reader.exec('BEGIN;');
      expect(reader.prepare(PROBE_SELECT_SQL).get()).toEqual(PROBE_ROW);
      // Written after the reader's snapshot, so these frames cannot be copied
      // back while the reader holds it.
      store.db.exec("INSERT INTO retained_probe VALUES ('after the snapshot');");
      logs.length = 0;

      store.close();
    } finally {
      reader.close();
    }

    const infos = storeRecordsAt('info');
    expect(infos).toHaveLength(1);
    const [closed] = infos;
    expect(closed?.message).toBe(CLOSED_WITHOUT_CHECKPOINT_MESSAGE);
    expect(closed?.fields).toMatchObject({ subsystem: 'store', checkpoint: 'busy', busy: 1 });
    const { logFrames, checkpointed } = frameCountsOf(closed);
    expect(checkpointed).toBeLessThan(logFrames);
    expect(store.isClosed).toBe(true);
  });

  it('reports a checkpoint an open transaction refuses as failed, and still closes, rolling the transaction back', () => {
    const store = openedStore({ databasePath, logger: recordingLogger() });
    store.db.exec('BEGIN IMMEDIATE;');
    store.db.exec(PROBE_SEED_SQL);
    logs.length = 0;

    store.close();

    const infos = storeRecordsAt('info');
    expect(infos).toHaveLength(1);
    const [closed] = infos;
    expect(closed?.message).toBe(CLOSED_WITHOUT_CHECKPOINT_MESSAGE);
    expect(closed?.fields).toMatchObject({ subsystem: 'store', checkpoint: 'failed' });
    expect(typeof closed?.fields.checkpointReason).toBe('string');
    expect(closed?.fields).not.toHaveProperty('logFrames');
    expect(storeRecordsAt('error')).toEqual([]);
    expect(store.isClosed).toBe(true);
    expect(
      openedStore({ databasePath })
        .statement(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retained_probe'",
        )
        .get(),
    ).toBeUndefined();
  });

  it('names no checkpoint for the in-memory store, which has no write-ahead log', () => {
    const store = openedStore({ databasePath: ':memory:', logger: recordingLogger() });
    store.db.exec(PROBE_SEED_SQL);
    logs.length = 0;

    store.close();

    expect(storeRecordsAt('info')).toEqual([
      expect.objectContaining({
        message: 'the session store closed',
        fields: { subsystem: 'store', databasePath: ':memory:', checkpoint: 'no-wal' },
      }),
    ]);
  });

  it('reports an explicit checkpoint at debug with the same counts, truncating the log and leaving the store open', () => {
    const store = openedStore({ databasePath, logger: recordingLogger() });
    store.db.exec(PROBE_SEED_SQL);
    logs.length = 0;

    store.checkpoint();

    expect(storeRecordsAt('info')).toEqual([]);
    const debugs = storeRecordsAt('debug');
    expect(debugs).toHaveLength(1);
    const [checkpointed] = debugs;
    expect(checkpointed?.message).toBe('checkpointed the session store write-ahead log');
    expect(checkpointed?.fields).toMatchObject({ checkpoint: 'completed', busy: 0 });
    const counts = frameCountsOf(checkpointed);
    expect(counts.logFrames).toBeGreaterThan(0);
    expect(counts.checkpointed).toBe(counts.logFrames);
    expect(Object.keys(checkpointed?.fields ?? {}).sort()).toEqual(
      [...CHECKPOINT_COUNT_FIELDS, 'subsystem'].sort(),
    );
    expect(statSync(`${databasePath}-wal`).size).toBe(0);
    expect(store.isClosed).toBe(false);
    expect(store.statement(PROBE_SELECT_SQL).get()).toEqual(PROBE_ROW);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Background checkpoints
 * ---------------------------------------------------------------------------------------------- */

/** A table the background-checkpoint cases fill, unrelated to the store schema. */
const BULK_TABLE_SQL = 'CREATE TABLE IF NOT EXISTS bulk_probe (body TEXT NOT NULL)';

/** Adds one row to {@link BULK_TABLE_SQL}. */
const BULK_INSERT_SQL = 'INSERT INTO bulk_probe (body) VALUES (?)';

/** Counts the rows of {@link BULK_TABLE_SQL}. */
const BULK_COUNT_SQL = 'SELECT COUNT(*) AS rows FROM bulk_probe';

/** SQLite's default commit-time checkpoint threshold, in pages. */
const DEFAULT_AUTOCHECKPOINT_PAGES = 1_000;

/** Writes `rows` rows of 200 bytes in one transaction, growing the write-ahead log. */
function writeBulk(store: Store, rows: number): void {
  store.db.exec(BULK_TABLE_SQL);
  store.transaction(() => {
    const insert = store.statement(BULK_INSERT_SQL);
    for (let row = 0; row < rows; row += 1) {
      insert.run('x'.repeat(200));
    }
  });
}

/** The connection's `wal_autocheckpoint`, as the pragma answers it. */
function autoCheckpointOf(store: Store): unknown {
  return store.db.prepare('PRAGMA wal_autocheckpoint').get()?.['wal_autocheckpoint'];
}

describe('background checkpoints of a file-backed store', () => {
  /** Every checkpointer a case opened, closed before the store and the sandbox go. */
  let checkpointers: WalCheckpointer[] = [];

  /** A checkpointer the case requires, tracked for cleanup. */
  function tracked(checkpointer: WalCheckpointer | undefined): WalCheckpointer {
    if (checkpointer === undefined) {
      return expect.unreachable('openWalCheckpointer offered no checkpointer for a WAL file store');
    }
    checkpointers.push(checkpointer);
    return checkpointer;
  }

  beforeEach(() => {
    checkpointers = [];
  });

  afterEach(async () => {
    for (const checkpointer of checkpointers) {
      await checkpointer.close();
    }
  });

  it('folds the log in on a connection of its own, truncating it and keeping every row, while the commit-time checkpoint is suspended', async () => {
    const store = openedStore({ databasePath });
    const suspension = suspendAutoCheckpoint(store);
    expect(suspension?.previousPages).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);
    expect(autoCheckpointOf(store)).toBe(0);

    writeBulk(store, 20_000);
    const checkpointer = tracked(openWalCheckpointer(store));
    // Past the default threshold, so only the suspension explains a log this
    // large: no commit folded it in.
    expect(checkpointer.walBytes()).toBeGreaterThan(DEFAULT_AUTOCHECKPOINT_PAGES * 4096);

    const outcome = await checkpointer.checkpoint();

    if (outcome.status !== 'completed') {
      return expect.unreachable(`the checkpoint answered ${outcome.status}`);
    }
    expect(outcome.busy).toBe(0);
    expect(outcome.logFrames).toBeGreaterThan(0);
    expect(outcome.checkpointedFrames).toBe(outcome.logFrames);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(checkpointer.walBytes()).toBe(0);
    expect(store.statement(BULK_COUNT_SQL).get()).toEqual({ rows: 20_000 });

    expect(suspension?.restore()).toBe(true);
    expect(autoCheckpointOf(store)).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);
  });

  it('answers busy while a reader holds the log back, and completes once the reader lets go', async () => {
    const store = openedStore({ databasePath });
    writeBulk(store, 100);
    const checkpointer = tracked(openWalCheckpointer(store));

    const reader = new DatabaseSync(databasePath);
    try {
      reader.exec('BEGIN;');
      expect(reader.prepare(BULK_COUNT_SQL).get()).toEqual({ rows: 100 });
      // Written after the reader's snapshot, so these frames stay in the log.
      writeBulk(store, 100);

      const held = await checkpointer.checkpoint();

      if (held.status !== 'busy') {
        return expect.unreachable(`the checkpoint answered ${held.status}`);
      }
      expect(held.busy).toBe(1);
      expect(held.checkpointedFrames).toBeLessThan(held.logFrames);
      expect(checkpointer.walBytes()).toBeGreaterThan(0);

      reader.exec('COMMIT;');
      const released = await checkpointer.checkpoint();

      expect(released.status).toBe('completed');
      expect(checkpointer.walBytes()).toBe(0);
    } finally {
      reader.close();
    }
    expect(store.statement(BULK_COUNT_SQL).get()).toEqual({ rows: 200 });
  });

  it('offers no checkpointer for the in-memory store or a closed one, and one that never checkpointed closes at once', async () => {
    expect(openWalCheckpointer(openedStore({ databasePath: ':memory:' }))).toBeUndefined();

    const store = openedStore({ databasePath });
    const idle = tracked(openWalCheckpointer(store));
    expect(idle.walBytes()).toBeGreaterThanOrEqual(0);
    await idle.close();
    expect(await idle.checkpoint()).toEqual({ status: 'closed' });

    store.close();
    expect(openWalCheckpointer(store)).toBeUndefined();
  });

  it('answers every request after close as closed, closes twice harmlessly, and leaves the rows alone', async () => {
    const store = openedStore({ databasePath });
    writeBulk(store, 10);
    const checkpointer = tracked(openWalCheckpointer(store));

    expect((await checkpointer.checkpoint()).status).toBe('completed');
    await checkpointer.close();
    await checkpointer.close();

    expect(await checkpointer.checkpoint()).toEqual({ status: 'closed' });
    expect(store.statement(BULK_COUNT_SQL).get()).toEqual({ rows: 10 });
  });

  it('answers a request still in flight as closed and releases the thread at once when closed', async () => {
    const store = openedStore({ databasePath });
    writeBulk(store, 100);
    const checkpointer = tracked(openWalCheckpointer(store));
    // Started first, so the request below is the one the thread is serving.
    expect((await checkpointer.checkpoint()).status).toBe('completed');

    const reader = new DatabaseSync(databasePath);
    try {
      reader.exec('BEGIN;');
      reader.prepare(BULK_COUNT_SQL).get();
      writeBulk(store, 100);

      // The truncation waits on the reader, so this request is still running
      // when the close arrives.
      const pending = checkpointer.checkpoint();
      await checkpointer.close();

      expect(await pending).toEqual({ status: 'closed' });
      expect(await checkpointer.checkpoint()).toEqual({ status: 'closed' });
    } finally {
      reader.close();
    }
  });

  it('closes the store without claiming a clean checkpoint while the thread is still checkpointing', async () => {
    const store = openedStore({ databasePath, logger: recordingLogger() });
    // No wait: the close must answer at once, whoever holds the log.
    store.db.exec('PRAGMA busy_timeout = 0;');
    writeBulk(store, 100);
    const checkpointer = tracked(openWalCheckpointer(store));
    expect((await checkpointer.checkpoint()).status).toBe('completed');

    const reader = new DatabaseSync(databasePath);
    try {
      reader.exec('BEGIN;');
      reader.prepare(BULK_COUNT_SQL).get();
      writeBulk(store, 100);
      const pending = checkpointer.checkpoint();
      // Inside the thread's wait on the reader, which holds its checkpoint
      // lock; a close that lands after it still meets the reader.
      await new Promise((resolveWait) => {
        setTimeout(resolveWait, 100);
      });
      logs.length = 0;

      store.close();

      const closed = storeRecordsAt('info');
      expect(closed).toHaveLength(1);
      expect(closed[0]?.message).toBe(CLOSED_WITHOUT_CHECKPOINT_MESSAGE);
      expect(['busy', 'failed']).toContain(closed[0]?.fields.checkpoint);
      if (closed[0]?.fields.checkpoint === 'failed') {
        expect(closed[0].fields.checkpointReason).toBe(
          'another connection was checkpointing the write-ahead log',
        );
      }
      expect(store.isClosed).toBe(true);
      await pending;
    } finally {
      reader.close();
    }
  });

  it('refuses to checkpoint through a path that no longer names the file the store opened', async () => {
    const store = openedStore({ databasePath });
    writeBulk(store, 10);
    store.checkpoint();
    const checkpointer = tracked(openWalCheckpointer(store));

    // A different inode at the same path: the thread must not fold anything
    // into a file the service never verified.
    const moved = join(stateDir, 'moved.sqlite');
    renameSync(databasePath, moved);
    writeFileSync(databasePath, readFileSync(moved), { mode: OWNER_ONLY_FILE_MODE });

    const outcome = await checkpointer.checkpoint();

    if (outcome.status !== 'failed') {
      return expect.unreachable(`the checkpoint answered ${outcome.status}`);
    }
    expect(outcome.reason).toContain('no longer the one the service opened');
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'offers no checkpointer once the database path is a symbolic link',
    () => {
      const store = openedStore({ databasePath });
      const moved = join(stateDir, 'moved.sqlite');
      renameSync(databasePath, moved);
      symlinkSync(moved, databasePath);

      expect(openWalCheckpointer(store)).toBeUndefined();
    },
  );

  it('restores the commit-time checkpoint only when the last overlapping suspension ends', () => {
    const store = openedStore({ databasePath });
    const first = suspendAutoCheckpoint(store);
    const second = suspendAutoCheckpoint(store);
    expect(first?.previousPages).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);
    expect(second?.previousPages).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);
    expect(autoCheckpointOf(store)).toBe(0);

    expect(first?.restore()).toBe(true);
    expect(autoCheckpointOf(store)).toBe(0);
    expect(first?.restore()).toBe(false);
    expect(second?.restore()).toBe(true);
    expect(autoCheckpointOf(store)).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);

    // A suspension that outlives its store ends quietly; a closed store has
    // no setting to suspend.
    const outlived = suspendAutoCheckpoint(store);
    store.close();
    expect(outlived?.restore()).toBe(true);
    expect(suspendAutoCheckpoint(store)).toBeUndefined();
  });
});
