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
 *    with its data intact.
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConsoleLogger, isErr, unwrap } from '@debuggen/shared';
import type { DebuggenError, LogRecord, Result } from '@debuggen/shared';

import { openStore } from './db.js';
import type { OpenStoreOptions, Store } from './db.js';

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
});

afterEach(() => {
  // First, so the teardown below and the next case run against the real
  // `chmod` whatever this case injected.
  clearChmodFault();
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
 * or other access, and that the refusal names that directory and the `chmod`
 * that fixes it, with the policy error it wraps kept as the cause.
 */
function expectLooseDirectoryRefusal(
  opened: Result<Store, DebuggenError>,
  directory: string,
  mode: number,
): DebuggenError {
  const error = refusalFrom(opened);
  expect(error.code).toBe('FS_UNSAFE_PATH');
  expect(error.details?.reason).toBe(MODE_REFUSAL_REASON);
  expect(error.details?.path).toBe(directory);
  expect(error.details?.subsystem).toBe('store');
  expect(error.hint).toContain(`chmod 700 ${directory}`);
  expect(error.hint).toContain('DEBUGGEN_HOME');

  const cause: unknown = error.cause;
  expect(cause).toMatchObject({
    code: 'FS_UNSAFE_PATH',
    details: {
      reason: MODE_REFUSAL_REASON,
      path: directory,
      mode: (mode & PERMISSION_BITS).toString(8),
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
