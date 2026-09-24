/**
 * Unit suite for `./backup-store.ts` — the content-addressed store that holds a
 * developer's original file bytes while this product has an edit over them.
 *
 * `./patcher.test.ts` and `../cleanup.test.ts` drive the store through the happy
 * sequence the reversibility promise is built from. This suite owns the other
 * half: every **refusal** the store makes, because each one is a place where a
 * weaker implementation would restore foreign bytes over a developer's file,
 * delete the only copy of an original, or act on a path the journal was tricked
 * into naming. The invariants pinned here, in order:
 *
 * 1. **The store refuses to exist over an unusable root.** A relative, a
 *    control-character and a network-share state root, and a session id that is
 *    not a single safe path component, are thrown at construction with
 *    `FS_UNSAFE_PATH` and a `details.reason`, and the offending value is never
 *    copied into the error.
 * 2. **Path resolution is pure and bounded.** `locate` and `locateRecorded`
 *    classify a recorded path as `composed`, `relocated` or `substituted`, and a
 *    path outside this session's own subdirectories is never the one acted on.
 * 3. **A backup is filed under the digest of its bytes, and nothing else.**
 *    `put` refuses bytes that do not hash to the digest (`content-digest-mismatch`)
 *    before it creates anything, adopts an identical backup (`reused: true`),
 *    and refuses — without overwriting — a file already at the path that does
 *    not hash to its name (`stored-digest-mismatch`). Bytes survive verbatim
 *    (CRLF, a byte-order mark, bytes that are not UTF-8), the file is `0600` and
 *    its directories `0700`.
 * 4. **`has` answers only for a regular file**, and a directory or a symbolic
 *    link at the path answers `false`.
 * 5. **Nothing is deleted without a matching verification.** A declared
 *    restoration digest that differs is `CLEANUP_PARTIAL`
 *    (`restored-content-digest-mismatch`) and a malformed one `not-a-digest`,
 *    and in both cases the backup is retained; deleting something already gone
 *    is `ok(false)`.
 * 6. **A relocated backup is acted on through a pinned directory.** Its read and
 *    its delete go through `pinPrivateFileWithinRoot`, a relocated file that
 *    does not hash to the record's digest is kept, and a directory or entry that
 *    changed between the judgement and the use is `backup-replaced` — the
 *    backup is retained in every such case.
 * 7. **The session sweep is non-recursive and fail-closed.** It deletes the
 *    digest-named files it created, reports what it retained, and never touches
 *    a relocated backup's subdirectory.
 *
 * ## How the racing cases are reached
 *
 * On Linux the pin is *enforced* — the read and the unlink go through
 * `/proc/self/fd` — so a swapped directory cannot redirect them and
 * `backup-replaced` is unreachable by moving directories alone. The module
 * `@debuggen/shared/node` is therefore mocked as a **pass-through**: every export
 * is the real one, and two of them can be wrapped for one case at a time
 * through {@link sharedHooks} — the pin can be *degraded* to the non-enforcing form
 * a platform without descriptor paths receives, and a callback can run straight
 * after the real verifying snapshot read. With no hook installed the store runs
 * against the real primitives, which is how every other case in this file runs.
 *
 * The session sweep's races are reached the same way: `node:fs/promises` is a
 * pass-through whose `readdir` and `rmdir` run a per-case callback at the exact
 * point a concurrent process could remove, replace or add an entry, and the
 * real call then meets that real change. Two errnos this host cannot provoke
 * for real — a permission denial when the suite runs as root, and a full disk —
 * are injected in place of the primitive that would raise them, and only for
 * the one case that asserts how the store surfaces them.
 *
 * ## Directory policy
 *
 * Every state root is a fresh `fs.mkdtemp` directory (`0700`), and every
 * directory a case plants inside it is created `0700` and then `chmod`-ed to
 * `0700`, so no case depends on the process umask. A mode is loosened only in a
 * case that asserts the refusal of a loose directory. The host may run as root,
 * so a case that needs a permission denial is skipped there. No case writes
 * under `$DEBUGGEN_HOME` or `~/.debuggen`, and every root is removed after its
 * case.
 */

import { Buffer } from 'node:buffer';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DebuggenError, isOk } from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, Result } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';
import type { FileSnapshot, PinnedFile } from '@debuggen/shared/node';

import { RECORDED_BACKUP_SOURCES, createBackupStore } from './backup-store.js';
import type { BackupStore, BackupStoreOptions } from './backup-store.js';

/* -------------------------------------------------------------------------------------------------
 * The pass-through mock of @debuggen/shared/node
 * ---------------------------------------------------------------------------------------------- */

/** The per-case wrappers the pass-through mock consults on every call. */
interface SharedNodeHooks {
  /**
   * Rewrites the pin the store receives from the real
   * `pinPrivateFileWithinRoot`, or `undefined` to hand it over unchanged.
   */
  pin: ((pinned: PinnedFile) => PinnedFile) | undefined;

  /**
   * Runs after the real `readFileSnapshotNoFollow` has read a path and before
   * its snapshot is returned, or `undefined` to run nothing.
   */
  afterSnapshot: ((path: string) => void) | undefined;

  /** Every `relativeFile` the store asked the real pin for, in order. */
  pinned: string[];

  /**
   * An errno a hardened primitive raises *instead of* running, by export name —
   * for the failures this host cannot provoke for real because the suite may
   * run as root (`EACCES`) or on a disk with space to spare (`ENOSPC`).
   */
  faults: Partial<Record<'createFileExclusive' | 'assertSecureDir', string>>;
}

/**
 * The per-case hooks of the pass-through `node:fs/promises` mock: each runs at
 * the exact point where a concurrent process could change the session
 * directory, so the store's handling of that race is exercised against a real
 * filesystem rather than a simulated answer.
 */
interface FsPromisesHooks {
  /** Runs before the real `readdir` lists a directory. */
  beforeReaddir: ((path: string) => void) | undefined;

  /** Runs after the real `readdir` has listed a directory, before the store sees the listing. */
  afterReaddir: ((path: string) => void) | undefined;

  /** Runs before the real `rmdir` removes a directory. */
  beforeRmdir: ((path: string) => void) | undefined;
}

/**
 * The hook state, hoisted so the mock factories below — which Vitest hoists
 * above every import — can already see it.
 */
const sharedHooks = vi.hoisted((): SharedNodeHooks => ({
  pin: undefined,
  afterSnapshot: undefined,
  pinned: [],
  faults: {},
}));

/** The `node:fs/promises` hook state, hoisted for the same reason. */
const fsHooks = vi.hoisted((): FsPromisesHooks => ({
  beforeReaddir: undefined,
  afterReaddir: undefined,
  beforeRmdir: undefined,
}));

/**
 * An `Error` shaped as the runtime shapes a failed system call.
 *
 * @param code The errno code.
 * @param syscall The call that failed.
 * @returns The error.
 */
function errnoError(code: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected ${syscall} failure`), { code, syscall });
}

/**
 * `@debuggen/shared/node` with every export real, and the pin, the snapshot
 * read and two creation-side primitives routed through {@link sharedHooks}. It
 * applies to `./backup-store.ts`'s import and to this file's own.
 */
vi.mock('@debuggen/shared/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@debuggen/shared/node')>();

  return {
    ...actual,
    pinPrivateFileWithinRoot: (rootAbs: string, relativeFile: string): PinnedFile => {
      sharedHooks.pinned.push(relativeFile);
      const pinned = actual.pinPrivateFileWithinRoot(rootAbs, relativeFile);

      return sharedHooks.pin === undefined ? pinned : sharedHooks.pin(pinned);
    },
    readFileSnapshotNoFollow: (path: string): FileSnapshot => {
      const snapshot = actual.readFileSnapshotNoFollow(path);
      sharedHooks.afterSnapshot?.(path);

      return snapshot;
    },
    createFileExclusive: (...args: Parameters<typeof actual.createFileExclusive>): void => {
      const code = sharedHooks.faults.createFileExclusive;

      if (code !== undefined) {
        throw errnoError(code, 'open');
      }

      actual.createFileExclusive(...args);
    },
    assertSecureDir: (...args: Parameters<typeof actual.assertSecureDir>): void => {
      const code = sharedHooks.faults.assertSecureDir;

      if (code !== undefined) {
        throw errnoError(code, 'lstat');
      }

      actual.assertSecureDir(...args);
    },
  };
});

/**
 * `node:fs/promises` with every export real, and the session sweep's listing
 * and removal bracketed by {@link fsHooks}. Only `./backup-store.ts`'s import is
 * affected: this file uses the synchronous API throughout.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...actual,
    // The one overload the store calls: a string path, entries with their types.
    readdir: async (path: string, options: { withFileTypes: true }): Promise<Dirent[]> => {
      fsHooks.beforeReaddir?.(path);
      const entries = await actual.readdir(path, options);
      fsHooks.afterReaddir?.(path);

      return entries;
    },
    rmdir: async (path: string): Promise<void> => {
      fsHooks.beforeRmdir?.(path);
      await actual.rmdir(path);
    },
  };
});

/** Clears every hook, so no case inherits another's interference. */
function resetHooks(): void {
  sharedHooks.pin = undefined;
  sharedHooks.afterSnapshot = undefined;
  sharedHooks.pinned = [];
  sharedHooks.faults = {};
  fsHooks.beforeReaddir = undefined;
  fsHooks.afterReaddir = undefined;
  fsHooks.beforeRmdir = undefined;
}

/**
 * A pin reduced to the form a platform without descriptor paths receives: the
 * ordinary path, `enforced: false`, and the real identity check as the only
 * protection left.
 *
 * @param pinned The real, enforced pin.
 * @returns The degraded pin, sharing the real descriptor and its release.
 */
function degradedPin(pinned: PinnedFile): PinnedFile {
  return { ...pinned, enforced: false, path: join(pinned.directory, pinned.name) };
}

/* -------------------------------------------------------------------------------------------------
 * Host capabilities
 * ---------------------------------------------------------------------------------------------- */

/** Whether this platform has no user ids, and so no owner or mode model to assert. */
const NO_POSIX_IDS = typeof process.getuid !== 'function';

/** Whether the suite runs as root, which no permission bit can deny. */
const RUNS_AS_ROOT = process.getuid?.() === 0;

/** Whether this platform addresses a held descriptor as a path, which is what enforces a pin. */
const ENFORCES_PINS = process.platform === 'linux';

/**
 * Whether this process can plant a symbolic link at all.
 *
 * Windows withholds it without developer mode, and a hardened runner can
 * withhold it anywhere; an unguarded `symlinkSync` would then read as a store
 * defect rather than a host limitation.
 */
const CAN_CREATE_SYMLINKS = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'dg-bs-probe-'));

  try {
    symlinkSync(join(probe, 'absent'), join(probe, 'link'));

    return lstatSync(join(probe, 'link')).isSymbolicLink();
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/* -------------------------------------------------------------------------------------------------
 * Content and digests
 * ---------------------------------------------------------------------------------------------- */

/**
 * A marker inside the bytes a case stores, so a leak of backup content into an
 * error or a log field is a substring search rather than an inference.
 */
const CONTENT_MARKER = 'bs-content-marker-that-must-never-leave-the-store';

/** An original file's bytes. */
const ORIGINAL = Buffer.from(`export const original = '${CONTENT_MARKER}';\n`, 'utf8');

/** Different bytes, for the mismatch cases. */
const OTHER = Buffer.from(`export const other = '${CONTENT_MARKER}-other';\n`, 'utf8');

/**
 * Bytes no text decoding would survive: a UTF-8 byte-order mark, CRLF line
 * endings, and a tail that is not valid UTF-8 at all.
 */
const LITERAL_BYTES = Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from('first line\r\nsecond line\r\n', 'utf8'),
  Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3]),
]);

/** The digest of {@link ORIGINAL}. */
const ORIGINAL_HASH = sha256Hex(ORIGINAL);

/** The digest of {@link OTHER}. */
const OTHER_HASH = sha256Hex(OTHER);

/** The session every case's primary store owns. */
const SESSION_ID = 'ses_bs_primary';

/** A second session, for the cases that prove one session cannot reach another's backups. */
const OTHER_SESSION_ID = 'ses_bs_neighbour';

/** The subdirectory a relocated backup is moved into, inside the session directory. */
const QUARANTINE = 'quarantine';

/** The permission bits of a path. */
function permissionsOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/* -------------------------------------------------------------------------------------------------
 * Result and error helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The value of an `ok` result, or a failure naming the error that came back.
 *
 * @param result The result.
 * @returns Its value.
 */
function okValue<T>(result: Result<T>): T {
  if (!isOk(result)) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }

  return result.value;
}

/**
 * The error of an `err` result, or a failure when it succeeded.
 *
 * @param result The result.
 * @returns Its error.
 */
function errorOf<T>(result: Result<T>): DebuggenError {
  if (isOk(result)) {
    throw new Error('expected an error result, but the operation succeeded');
  }

  return result.error;
}

/**
 * What a synchronous call threw, or a failure when it returned.
 *
 * @param work The call.
 * @returns The thrown value.
 */
function thrownBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }

  throw new Error('expected the call to throw, but it returned');
}

/**
 * The thrown value as a `DebuggenError`, or a failure naming what it was.
 *
 * @param value The thrown value.
 * @returns The error.
 */
function asDebuggenError(value: unknown): DebuggenError {
  if (!DebuggenError.is(value)) {
    throw new Error(`expected a DebuggenError, got ${String(value)}`);
  }

  return value;
}

/**
 * Asserts that nothing a caller could log, persist or render carries the text.
 *
 * `JSON.stringify` of the error covers every enumerable field — the code, the
 * hint and the details — and the message is checked on its own because it is
 * not enumerable.
 *
 * @param error The error.
 * @param text The text that must not appear.
 */
function expectNotCarried(error: DebuggenError, text: string): void {
  expect(error.message).not.toContain(text);
  expect(error.hint ?? '').not.toContain(text);
  expect(JSON.stringify(error)).not.toContain(text);
}

/* -------------------------------------------------------------------------------------------------
 * Logging
 * ---------------------------------------------------------------------------------------------- */

/** One log record a {@link recordingLogger} captured. */
interface RecordedLog {
  /** The severity it was emitted at. */
  readonly level: LogLevel;

  /** The message. */
  readonly message: string;

  /** The structured fields, when the call passed any. */
  readonly fields: LogFields | undefined;
}

/**
 * A logger that records instead of printing, plus the list it records into.
 *
 * @returns The logger and its records.
 */
function recordingLogger(): { readonly logger: Logger; readonly records: RecordedLog[] } {
  const records: RecordedLog[] = [];
  const capture =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields });
    };
  const logger: Logger = {
    level: 'trace',
    trace: capture('trace'),
    debug: capture('debug'),
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    fatal: capture('fatal'),
    child: () => logger,
  };

  return { logger, records };
}

/* -------------------------------------------------------------------------------------------------
 * The per-case state root
 * ---------------------------------------------------------------------------------------------- */

/** The case's state root, a fresh `mkdtemp` directory. */
let home = '';

beforeEach(() => {
  resetHooks();
  home = mkdtempSync(join(tmpdir(), 'dg-bs-'));
});

afterEach(() => {
  resetHooks();
  rmSync(home, { recursive: true, force: true });
  home = '';
});

/**
 * A store over the case's state root.
 *
 * @param overrides Any option to replace.
 * @returns The store.
 */
function storeFor(overrides: Partial<BackupStoreOptions> = {}): BackupStore {
  return createBackupStore({ debuggenHome: home, sessionId: SESSION_ID, ...overrides });
}

/**
 * Creates each directory below the state root that does not exist yet, `0700`
 * whatever the umask.
 *
 * @param segments The path below the state root, one component per argument.
 * @returns The deepest directory.
 */
function privateDirectory(...segments: string[]): string {
  let current = home;

  for (const segment of segments) {
    current = join(current, segment);

    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
    }

    chmodSync(current, 0o700);
  }

  return current;
}

/**
 * Writes a file exclusively, `0600` whatever the umask.
 *
 * @param path The file.
 * @param bytes Its content.
 */
function plantFile(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

/**
 * Plants a relocated backup: a file named `digest` in a subdirectory of the
 * primary session's directory, as a conflict pass that moved one aside would
 * leave it.
 *
 * @param digest The name the file is filed under.
 * @param bytes Its content.
 * @param subdirectory The subdirectory of the session directory.
 * @returns The recorded path and the directory holding it.
 */
function plantRelocated(
  digest: string,
  bytes: Uint8Array,
  subdirectory = QUARANTINE,
): { readonly path: string; readonly directory: string } {
  const directory = privateDirectory('backups', SESSION_ID, subdirectory);
  const path = join(directory, digest);

  plantFile(path, bytes);

  return { path, directory };
}

/**
 * Moves a judged directory aside and puts a different directory, holding a
 * decoy named `digest`, at its path — what a concurrent writer inside the
 * backup tree would do between a check and a use.
 *
 * @param directory The judged directory.
 * @param digest The entry name the decoy takes.
 * @param decoy The decoy's bytes.
 * @returns Where the judged directory now is.
 */
function swapDirectoryForDecoy(directory: string, digest: string, decoy: Uint8Array): string {
  const judged = `${directory}-judged`;

  renameSync(directory, judged);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  plantFile(join(directory, digest), decoy);

  return judged;
}

/* -------------------------------------------------------------------------------------------------
 * 1. The state root and session id a store will build on
 * ---------------------------------------------------------------------------------------------- */

describe('createBackupStore: the state root and session id it refuses', () => {
  it('refuses a relative state root, which would resolve against the working directory', () => {
    const error = asDebuggenError(
      thrownBy(() => createBackupStore({ debuggenHome: 'relative/state', sessionId: SESSION_ID })),
    );

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.details).toStrictEqual({ reason: 'not-absolute' });
    expectNotCarried(error, 'relative/state');
  });

  it.each([
    ['a NUL', '\u0000'],
    ['a C0 control', '\u0001'],
    ['the last C0 control', '\u001f'],
    ['DEL', '\u007f'],
    ['a C1 control', '\u0085'],
  ])('refuses a state root containing %s character', (_label, character) => {
    const error = asDebuggenError(
      thrownBy(() =>
        createBackupStore({ debuggenHome: `${home}/sta${character}te`, sessionId: SESSION_ID }),
      ),
    );

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.details).toStrictEqual({ reason: 'control-character' });
  });

  it.each([
    ['POSIX', '//server/share/state'],
    ['Windows', '\\\\server\\share\\state'],
  ])(
    'refuses a %s network-share state root, whose leading separators would collapse',
    (_label, root) => {
      const error = asDebuggenError(
        thrownBy(() => createBackupStore({ debuggenHome: root, sessionId: SESSION_ID })),
      );

      expect(error.code).toBe('FS_UNSAFE_PATH');
      expect(error.details).toStrictEqual({ reason: 'network-share' });
    },
  );

  it('checks a control character before the network-share prefix and the absoluteness', () => {
    // The most specific reason wins, so the caller is told what to fix first.
    const error = asDebuggenError(
      thrownBy(() =>
        createBackupStore({ debuggenHome: '//server/sha\u0001re', sessionId: SESSION_ID }),
      ),
    );

    expect(error.details).toStrictEqual({ reason: 'control-character' });
  });

  it.each([
    ['a separator', 'ses/inner'],
    ['a backslash', 'ses\\inner'],
    ['a drive or stream colon', 'ses:stream'],
    ['the parent segment', '..'],
    ['the current segment', '.'],
    ['nothing', ''],
    ['only whitespace', '   '],
    ['a NUL', 'ses\u0000tail'],
    ['more than 128 characters', 's'.repeat(129)],
  ])('refuses a session id holding %s, and never copies it into the error', (_label, sessionId) => {
    const error = asDebuggenError(
      thrownBy(() => createBackupStore({ debuggenHome: home, sessionId })),
    );

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.details).toStrictEqual({
      reason: 'unsafe-path-segment',
      field: 'sessionId',
      length: sessionId.length,
    });

    if (sessionId.trim().length > 2) {
      expectNotCarried(error, sessionId);
    }
  });

  it('accepts a session id of exactly 128 characters and creates nothing on disk', () => {
    const sessionId = 's'.repeat(128);
    const store = createBackupStore({ debuggenHome: home, sessionId });

    expect(store.sessionId).toBe(sessionId);
    expect(store.sessionDirectory).toBe(`${home}/backups/${sessionId}`);
    // Construction is pure: a session that ends before anything is patched
    // leaves no directory behind.
    expect(readdirSync(home)).toStrictEqual([]);
  });

  it('normalises the state root it composes every path from', () => {
    const store = createBackupStore({
      debuggenHome: `${home}/./nested/..//`,
      sessionId: SESSION_ID,
    });

    expect(store.sessionDirectory).toBe(`${home}/backups/${SESSION_ID}`);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 2. Pure path resolution
 * ---------------------------------------------------------------------------------------------- */

describe('BackupStore.locate and locateRecorded: pure path resolution', () => {
  it('composes <home>/backups/<session>/<digest> and touches nothing', () => {
    const store = storeFor();

    expect(okValue(store.locate(ORIGINAL_HASH))).toBe(
      `${home}/backups/${SESSION_ID}/${ORIGINAL_HASH}`,
    );
    expect(readdirSync(home)).toStrictEqual([]);
  });

  it.each([
    ['a separator', `${ORIGINAL_HASH.slice(0, 32)}/${ORIGINAL_HASH.slice(33)}`],
    ['a traversal', '..'],
    ['a control character', `${ORIGINAL_HASH.slice(0, 63)}\u0000`],
    ['a length past the segment cap', 'a'.repeat(129)],
    ['nothing', ''],
  ])('refuses a digest holding %s as an unsafe path segment', (_label, digest) => {
    const error = errorOf(storeFor().locate(digest));

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.details).toStrictEqual({
      reason: 'unsafe-path-segment',
      field: 'originalHash',
      length: digest.length,
    });
  });

  it.each([
    ['upper-case hexadecimal', ORIGINAL_HASH.toUpperCase()],
    ['too short', ORIGINAL_HASH.slice(0, 63)],
    ['not hexadecimal', 'g'.repeat(64)],
    ['a plain file name', 'original.ts'],
  ])('refuses a safe segment that is not a digest (%s)', (_label, digest) => {
    const error = errorOf(storeFor().locate(digest));

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.details).toStrictEqual({ reason: 'not-a-digest', field: 'originalHash' });
  });

  it('declares exactly three recorded-path sources', () => {
    expect(RECORDED_BACKUP_SOURCES).toStrictEqual(['composed', 'relocated', 'substituted']);
    expect(Object.isFrozen(RECORDED_BACKUP_SOURCES)).toBe(true);
  });

  it('reads the composed path, in either separator spelling, as composed', () => {
    const store = storeFor();
    const composed = okValue(store.locate(ORIGINAL_HASH));

    expect(okValue(store.locateRecorded(composed, ORIGINAL_HASH))).toStrictEqual({
      path: composed,
      source: 'composed',
    });
    expect(
      okValue(store.locateRecorded(composed.replaceAll('/', '\\'), ORIGINAL_HASH)),
    ).toStrictEqual({ path: composed, source: 'composed' });
  });

  it('accepts a normalised path in a subdirectory of the session, named by the digest, as relocated', () => {
    const store = storeFor();
    const relocated = `${store.sessionDirectory}/${QUARANTINE}/${ORIGINAL_HASH}`;
    const deeper = `${store.sessionDirectory}/${QUARANTINE}/nested/${ORIGINAL_HASH}`;

    expect(okValue(store.locateRecorded(relocated, ORIGINAL_HASH))).toStrictEqual({
      path: relocated,
      source: 'relocated',
    });
    expect(okValue(store.locateRecorded(deeper, ORIGINAL_HASH))).toStrictEqual({
      path: deeper,
      source: 'relocated',
    });
  });

  it.each([
    [
      'a traversal out of the session',
      (dir: string) => `${dir}/${QUARANTINE}/../../elsewhere/${ORIGINAL_HASH}`,
    ],
    ['a doubled separator', (dir: string) => `${dir}/${QUARANTINE}//${ORIGINAL_HASH}`],
    ['a current-directory segment', (dir: string) => `${dir}/./${ORIGINAL_HASH}`],
    [
      'another session’s directory',
      (dir: string) =>
        `${dir.replace(SESSION_ID, OTHER_SESSION_ID)}/${QUARANTINE}/${ORIGINAL_HASH}`,
    ],
    ['another state root', () => `/elsewhere/backups/${SESSION_ID}/${QUARANTINE}/${ORIGINAL_HASH}`],
    ['a file named by another digest', (dir: string) => `${dir}/${QUARANTINE}/${OTHER_HASH}`],
    [
      'a file directly in the session named by another digest',
      (dir: string) => `${dir}/${OTHER_HASH}`,
    ],
    ['a relative path', () => `backups/${SESSION_ID}/${QUARANTINE}/${ORIGINAL_HASH}`],
    ['a network share', () => `//server/backups/${SESSION_ID}/${QUARANTINE}/${ORIGINAL_HASH}`],
    ['a control character', (dir: string) => `${dir}/quar\u0001antine/${ORIGINAL_HASH}`],
    ['nothing', () => ''],
    [
      'a path past the recorded-path cap',
      (dir: string) => `${dir}/${'q'.repeat(4096)}/${ORIGINAL_HASH}`,
    ],
  ])('substitutes the composed path for %s', (_label, recordedFor) => {
    const store = storeFor();
    const recorded = recordedFor(store.sessionDirectory);

    expect(okValue(store.locateRecorded(recorded, ORIGINAL_HASH))).toStrictEqual({
      path: okValue(store.locate(ORIGINAL_HASH)),
      source: 'substituted',
    });
  });

  it('validates the digest before it looks at the recorded path at all', () => {
    const store = storeFor();
    const error = errorOf(
      store.locateRecorded(`${store.sessionDirectory}/${QUARANTINE}/not-a-digest`, 'not-a-digest'),
    );

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.details).toStrictEqual({ reason: 'not-a-digest', field: 'originalHash' });
  });
});

/* -------------------------------------------------------------------------------------------------
 * 3. put
 * ---------------------------------------------------------------------------------------------- */

describe('BackupStore.put: content-addressed, private, never overwriting', () => {
  it('stores the bytes under their digest, 0600 under 0700 directories', async () => {
    const { logger, records } = recordingLogger();
    const store = storeFor({ logger });
    const stored = okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    const expectedPath = `${home}/backups/${SESSION_ID}/${ORIGINAL_HASH}`;

    expect(stored).toStrictEqual({
      path: expectedPath,
      originalHash: ORIGINAL_HASH,
      byteLength: ORIGINAL.byteLength,
      reused: false,
    });
    expect(Buffer.compare(readFileSync(expectedPath), ORIGINAL)).toBe(0);
    expect(readdirSync(store.sessionDirectory)).toStrictEqual([ORIGINAL_HASH]);

    if (!NO_POSIX_IDS) {
      expect(permissionsOf(expectedPath)).toBe(0o600);
      expect(permissionsOf(store.sessionDirectory)).toBe(0o700);
      expect(permissionsOf(join(home, 'backups'))).toBe(0o700);
    }

    // One debug record naming the path, the digest and the size — never a byte
    // of the content it backed up.
    expect(records.map((record) => record.level)).toStrictEqual(['debug']);
    expect(records[0]?.fields).toStrictEqual({
      backupPath: expectedPath,
      originalHash: ORIGINAL_HASH,
      byteLength: ORIGINAL.byteLength,
    });
    expect(JSON.stringify(records)).not.toContain(CONTENT_MARKER);
  });

  it('adopts an identical backup instead of rewriting it, and says so', async () => {
    const store = storeFor();
    const first = okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    const before = statSync(first.path, { bigint: true });
    const second = okValue(await store.put(ORIGINAL_HASH, Buffer.from(ORIGINAL)));
    const after = statSync(first.path, { bigint: true });

    expect(second).toStrictEqual({ ...first, reused: true });
    // The same inode, untouched: a reuse reads and hashes, it never writes.
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(readdirSync(store.sessionDirectory)).toStrictEqual([ORIGINAL_HASH]);
  });

  it('refuses bytes that do not hash to the digest, before creating anything', async () => {
    const store = storeFor();
    const error = errorOf(await store.put(ORIGINAL_HASH, OTHER));

    expect(error.code).toBe('STORE_ERROR');
    expect(error.details).toStrictEqual({
      reason: 'content-digest-mismatch',
      path: `${store.sessionDirectory}/${ORIGINAL_HASH}`,
      expected: ORIGINAL_HASH,
      actual: OTHER_HASH,
    });

    // Refused at the door: not even the session directory was created, so a
    // later restore cannot find a mislabelled backup to trust.
    expect(existsSync(store.sessionDirectory)).toBe(false);
    expect(existsSync(join(home, 'backups'))).toBe(false);
    expect(okValue(await store.has(ORIGINAL_HASH))).toBe(false);

    // A digest and a path are reported; a byte of the content never is.
    expectNotCarried(error, CONTENT_MARKER);
  });

  it('refuses, and keeps, a file already at the path that does not hash to its name', async () => {
    const store = storeFor();
    const path = join(privateDirectory('backups', SESSION_ID), ORIGINAL_HASH);

    plantFile(path, OTHER);

    const error = errorOf(await store.put(ORIGINAL_HASH, ORIGINAL));

    expect(error.code).toBe('STORE_ERROR');
    expect(error.details).toStrictEqual({
      reason: 'stored-digest-mismatch',
      path,
      expected: ORIGINAL_HASH,
      actual: OTHER_HASH,
    });
    // The file it found is the only copy of whatever it holds: never replaced.
    expect(Buffer.compare(readFileSync(path), OTHER)).toBe(0);
    expectNotCarried(error, CONTENT_MARKER);
  });

  it('round-trips bytes no text decoding would survive, exactly', async () => {
    const store = storeFor();
    const digest = sha256Hex(LITERAL_BYTES);
    const stored = okValue(await store.put(digest, LITERAL_BYTES));

    expect(stored.byteLength).toBe(LITERAL_BYTES.byteLength);
    expect(Buffer.compare(readFileSync(stored.path), LITERAL_BYTES)).toBe(0);
    expect(Buffer.compare(okValue(await store.read(digest)), LITERAL_BYTES)).toBe(0);
    expect(okValue(await store.verify(digest))).toStrictEqual({
      path: stored.path,
      originalHash: digest,
      byteLength: LITERAL_BYTES.byteLength,
    });
  });

  it('stores an empty original, which is a file like any other', async () => {
    const store = storeFor();
    const empty = new Uint8Array(0);
    const digest = sha256Hex(empty);
    const stored = okValue(await store.put(digest, empty));

    expect(stored.byteLength).toBe(0);
    expect(readFileSync(stored.path).byteLength).toBe(0);
    expect(okValue(await store.has(digest))).toBe(true);
  });

  it('refuses an unsafe digest without creating anything', async () => {
    const store = storeFor();
    const error = errorOf(await store.put('../escape', ORIGINAL));

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.details).toMatchObject({ reason: 'unsafe-path-segment', field: 'originalHash' });
    expect(readdirSync(home)).toStrictEqual([]);
  });

  it('rejects with the platform’s own code when a directory occupies the path', async () => {
    const store = storeFor();

    privateDirectory('backups', SESSION_ID, ORIGINAL_HASH);

    // Exclusive creation reports the directory as `EEXIST`, and the verifying
    // read that follows meets `EISDIR`: an errno the store has no opinion about
    // is thrown with its code intact rather than paraphrased.
    await expect(store.put(ORIGINAL_HASH, ORIGINAL)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a symbolic link planted at the path and leaves its target untouched',
    async () => {
      const store = storeFor();
      const target = join(home, 'developer-file');

      plantFile(target, ORIGINAL);
      symlinkSync(target, join(privateDirectory('backups', SESSION_ID), ORIGINAL_HASH));

      await expect(store.put(ORIGINAL_HASH, ORIGINAL)).rejects.toMatchObject({ code: 'ELOOP' });
      expect(Buffer.compare(readFileSync(target), ORIGINAL)).toBe(0);
      expect(lstatSync(join(store.sessionDirectory, ORIGINAL_HASH)).isSymbolicLink()).toBe(true);
    },
  );

  it('rejects with the errno of a failed exclusive create and records no backup', async () => {
    const { logger, records } = recordingLogger();
    const store = storeFor({ logger });

    sharedHooks.faults.createFileExclusive = 'ENOSPC';

    // Only `EEXIST` means "something is already there"; every other failure of
    // the create is the caller's to see, with its errno, never a quiet success.
    await expect(store.put(ORIGINAL_HASH, ORIGINAL)).rejects.toMatchObject({
      code: 'ENOSPC',
      syscall: 'open',
    });

    sharedHooks.faults = {};

    // The private directory the create would have gone into was made, and no
    // file is in it: nothing claims a backup that was never written.
    expect(permissionsOf(store.sessionDirectory) & 0o077).toBe(0);
    expect(readdirSync(store.sessionDirectory)).toStrictEqual([]);
    expect(okValue(await store.has(ORIGINAL_HASH))).toBe(false);
    expect(records).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 4. has
 * ---------------------------------------------------------------------------------------------- */

describe('BackupStore.has: a regular file, and nothing else', () => {
  it('answers false when neither the backup nor its session directory exists', async () => {
    expect(okValue(await storeFor().has(ORIGINAL_HASH))).toBe(false);
    expect(readdirSync(home)).toStrictEqual([]);
  });

  it('answers true once the backup is stored, and false again once it is removed', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    expect(okValue(await store.has(ORIGINAL_HASH))).toBe(true);
    expect(okValue(await store.has(OTHER_HASH))).toBe(false);

    expect(okValue(await store.remove(ORIGINAL_HASH))).toBe(true);
    expect(okValue(await store.has(ORIGINAL_HASH))).toBe(false);
  });

  it('answers false for a directory at the path', async () => {
    privateDirectory('backups', SESSION_ID, ORIGINAL_HASH);

    expect(okValue(await storeFor().has(ORIGINAL_HASH))).toBe(false);
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'answers false for a symbolic link at the path, even one that reaches a regular file',
    async () => {
      const target = join(home, 'developer-file');
      const directory = privateDirectory('backups', SESSION_ID);

      plantFile(target, ORIGINAL);
      symlinkSync(target, join(directory, ORIGINAL_HASH));
      symlinkSync(join(home, 'absent'), join(directory, OTHER_HASH));

      expect(okValue(await storeFor().has(ORIGINAL_HASH))).toBe(false);
      expect(okValue(await storeFor().has(OTHER_HASH))).toBe(false);
    },
  );

  it.each([
    ['an unsafe segment', '../escape', 'unsafe-path-segment'],
    ['a non-digest', 'original.ts', 'not-a-digest'],
  ])('refuses %s instead of asking the filesystem', async (_label, digest, reason) => {
    const error = errorOf(await storeFor().has(digest));

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.details).toMatchObject({ reason, field: 'originalHash' });
  });

  it.skipIf(NO_POSIX_IDS || RUNS_AS_ROOT)(
    'rethrows a permission denial with its own code rather than answering false',
    async () => {
      const store = storeFor();
      const directory = privateDirectory('backups', SESSION_ID);

      chmodSync(directory, 0o000);

      try {
        await expect(store.has(ORIGINAL_HASH)).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        chmodSync(directory, 0o700);
      }
    },
  );

  it('rethrows ENOTDIR when a regular file stands where the session directory belongs', async () => {
    const store = storeFor();

    plantFile(join(privateDirectory('backups'), SESSION_ID), OTHER);

    // Not "no backup": the layout under the state root is broken, and a caller
    // deciding whether to restore needs to see that rather than a `false`.
    await expect(store.has(ORIGINAL_HASH)).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(Buffer.compare(readFileSync(join(home, 'backups', SESSION_ID)), OTHER)).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * read and verify
 * ---------------------------------------------------------------------------------------------- */

describe('BackupStore.read and verify: a backup is trusted only after it is hashed', () => {
  it('reports a missing backup as backup-missing, naming the path and the digest', async () => {
    const store = storeFor();
    const path = okValue(store.locate(ORIGINAL_HASH));

    const results: readonly Result<unknown>[] = [
      await store.read(ORIGINAL_HASH),
      await store.verify(ORIGINAL_HASH),
    ];

    for (const result of results) {
      const error = errorOf(result);

      expect(error.code).toBe('STORE_ERROR');
      expect(error.details).toStrictEqual({
        reason: 'backup-missing',
        path,
        originalHash: ORIGINAL_HASH,
      });
    }
  });

  it('reports a backup altered after it was stored as stored-digest-mismatch, and keeps it', async () => {
    const store = storeFor();
    const stored = okValue(await store.put(ORIGINAL_HASH, ORIGINAL));

    // Replaced in place with the same mode, as a stray process would.
    writeFileSync(stored.path, OTHER);

    const error = errorOf(await store.verify(ORIGINAL_HASH));

    expect(error.code).toBe('STORE_ERROR');
    expect(error.details).toStrictEqual({
      reason: 'stored-digest-mismatch',
      path: stored.path,
      expected: ORIGINAL_HASH,
      actual: OTHER_HASH,
    });
    expect(Buffer.compare(readFileSync(stored.path), OTHER)).toBe(0);
    // `read` does not hash — the caller that writes the bytes back does — so it
    // still returns what is there.
    expect(Buffer.compare(okValue(await store.read(ORIGINAL_HASH)), OTHER)).toBe(0);
  });

  it.each<[string, (store: BackupStore) => Promise<Result<unknown>>]>([
    ['read', (store) => store.read('not-a-digest')],
    ['verify', (store) => store.verify('not-a-digest')],
  ])('refuses a non-digest in %s', async (_label, call) => {
    const error = errorOf(await call(storeFor()));

    expect(error.details).toStrictEqual({ reason: 'not-a-digest', field: 'originalHash' });
  });
});

/* -------------------------------------------------------------------------------------------------
 * 5. remove
 * ---------------------------------------------------------------------------------------------- */

describe('BackupStore.remove: deletion only when asked, and only after verification', () => {
  it('keeps the backup when the declared restoration does not match, and reports CLEANUP_PARTIAL', async () => {
    const { logger, records } = recordingLogger();
    const store = storeFor({ logger });
    const stored = okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    const error = errorOf(await store.remove(ORIGINAL_HASH, { restoredContentHash: OTHER_HASH }));

    expect(error.code).toBe('CLEANUP_PARTIAL');
    expect(error.details).toStrictEqual({
      reason: 'restored-content-digest-mismatch',
      path: stored.path,
      originalHash: ORIGINAL_HASH,
      restoredContentHash: OTHER_HASH,
    });

    // Still the only copy of the original, and still verifiable.
    expect(okValue(await store.verify(ORIGINAL_HASH)).byteLength).toBe(ORIGINAL.byteLength);

    const warnings = records.filter((record) => record.level === 'warn');

    expect(warnings.map((record) => record.fields)).toStrictEqual([
      { backupPath: stored.path, originalHash: ORIGINAL_HASH, restoredContentHash: OTHER_HASH },
    ]);
    expectNotCarried(error, CONTENT_MARKER);
  });

  it('refuses a malformed declared restoration as not-a-digest, and keeps the backup', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));

    for (const restoredContentHash of [
      '',
      'restored',
      ORIGINAL_HASH.toUpperCase(),
      `${ORIGINAL_HASH}0`,
    ]) {
      const error = errorOf(await store.remove(ORIGINAL_HASH, { restoredContentHash }));

      expect(error.code).toBe('FS_UNSAFE_PATH');
      expect(error.details).toStrictEqual({ reason: 'not-a-digest', field: 'restoredContentHash' });
    }

    expect(okValue(await store.has(ORIGINAL_HASH))).toBe(true);
  });

  it('deletes once the declared restoration matches the digest', async () => {
    const store = storeFor();
    const stored = okValue(await store.put(ORIGINAL_HASH, ORIGINAL));

    expect(okValue(await store.remove(ORIGINAL_HASH, { restoredContentHash: ORIGINAL_HASH }))).toBe(
      true,
    );
    expect(existsSync(stored.path)).toBe(false);
  });

  it('deletes unconditionally when no restoration is declared', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));

    expect(okValue(await store.remove(ORIGINAL_HASH, { restoredContentHash: undefined }))).toBe(
      true,
    );
    expect(okValue(await store.has(ORIGINAL_HASH))).toBe(false);
  });

  it('answers false for a backup that is already gone, so a retried cleanup is a no-op', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));

    expect(okValue(await store.remove(ORIGINAL_HASH))).toBe(true);
    expect(okValue(await store.remove(ORIGINAL_HASH))).toBe(false);
    expect(okValue(await storeFor({ sessionId: OTHER_SESSION_ID }).remove(ORIGINAL_HASH))).toBe(
      false,
    );
  });

  it('checks the declared restoration before it looks for the backup at all', async () => {
    // A mismatch is a precondition failure whether or not anything is there:
    // the caller's restoration is what is wrong.
    const error = errorOf(
      await storeFor().remove(ORIGINAL_HASH, { restoredContentHash: OTHER_HASH }),
    );

    expect(error.code).toBe('CLEANUP_PARTIAL');
    expect(error.details).toMatchObject({ reason: 'restored-content-digest-mismatch' });
  });

  it('refuses an unsafe digest', async () => {
    const error = errorOf(await storeFor().remove('..'));

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.details).toMatchObject({ reason: 'unsafe-path-segment' });
  });

  it('rejects with EISDIR for a directory at the path, and leaves the directory in place', async () => {
    const occupant = privateDirectory('backups', SESSION_ID, ORIGINAL_HASH);

    plantFile(join(occupant, 'inside'), OTHER);

    // `unlink` never removes a directory, and the store has no recursive
    // delete to fall back on: the errno surfaces and nothing inside is touched.
    await expect(storeFor().remove(ORIGINAL_HASH)).rejects.toMatchObject({ code: 'EISDIR' });
    expect(readdirSync(occupant)).toStrictEqual(['inside']);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 6. Acting for a journal record
 * ---------------------------------------------------------------------------------------------- */

describe('BackupStore.readRecorded and removeRecorded: acting for a journal record', () => {
  it('reads and removes a composed record exactly as a digest read and remove do', async () => {
    const store = storeFor();
    const stored = okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    const read = okValue(await store.readRecorded(stored.path, ORIGINAL_HASH));

    expect(read.source).toBe('composed');
    expect(read.path).toBe(stored.path);
    expect(Buffer.compare(read.bytes, ORIGINAL)).toBe(0);

    const refused = errorOf(
      await store.removeRecorded(stored.path, ORIGINAL_HASH, { restoredContentHash: OTHER_HASH }),
    );

    expect(refused.code).toBe('CLEANUP_PARTIAL');
    expect(existsSync(stored.path)).toBe(true);

    expect(okValue(await store.removeRecorded(stored.path, ORIGINAL_HASH))).toBe(true);
    expect(existsSync(stored.path)).toBe(false);
    expect(okValue(await store.removeRecorded(stored.path, ORIGINAL_HASH))).toBe(false);
    // The composed path is never pinned: only a relocation needs the walk.
    expect(sharedHooks.pinned).toStrictEqual([]);
  });

  it('acts on its own composed path for a substituted record, never on the recorded one', async () => {
    const store = storeFor();
    const stored = okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    const neighbourPath = join(
      privateDirectory('backups', OTHER_SESSION_ID, QUARANTINE),
      ORIGINAL_HASH,
    );

    plantFile(neighbourPath, OTHER);

    const read = okValue(await store.readRecorded(neighbourPath, ORIGINAL_HASH));

    expect(read).toMatchObject({ path: stored.path, source: 'substituted' });
    expect(Buffer.compare(read.bytes, ORIGINAL)).toBe(0);

    // One session's record can never delete a backup another session holds.
    expect(okValue(await store.removeRecorded(neighbourPath, ORIGINAL_HASH))).toBe(true);
    expect(existsSync(stored.path)).toBe(false);
    expect(Buffer.compare(readFileSync(neighbourPath), OTHER)).toBe(0);
    expect(sharedHooks.pinned).toStrictEqual([]);
  });

  it('reports a substituted record whose composed backup is absent as backup-missing', async () => {
    const store = storeFor();
    const error = errorOf(await store.readRecorded(`/elsewhere/${ORIGINAL_HASH}`, ORIGINAL_HASH));

    expect(error.details).toStrictEqual({
      reason: 'backup-missing',
      path: okValue(store.locate(ORIGINAL_HASH)),
      originalHash: ORIGINAL_HASH,
    });
  });

  it('reads a relocated backup through the pinned walk from the state root', async () => {
    const store = storeFor();
    const { path } = plantRelocated(ORIGINAL_HASH, ORIGINAL);
    const read = okValue(await store.readRecorded(path, ORIGINAL_HASH));

    expect(read.source).toBe('relocated');
    expect(read.path).toBe(path);
    expect(Buffer.compare(read.bytes, ORIGINAL)).toBe(0);
    expect(sharedHooks.pinned).toStrictEqual([
      `backups/${SESSION_ID}/${QUARANTINE}/${ORIGINAL_HASH}`,
    ]);
  });

  it('reports a relocated backup whose file or directory is gone as backup-missing', async () => {
    const store = storeFor();
    const directory = privateDirectory('backups', SESSION_ID, QUARANTINE);
    const inExistingDirectory = join(directory, ORIGINAL_HASH);
    const inAbsentDirectory = `${store.sessionDirectory}/moved/${ORIGINAL_HASH}`;

    for (const path of [inExistingDirectory, inAbsentDirectory]) {
      const error = errorOf(await store.readRecorded(path, ORIGINAL_HASH));

      expect(error.code).toBe('STORE_ERROR');
      expect(error.details).toStrictEqual({
        reason: 'backup-missing',
        path,
        originalHash: ORIGINAL_HASH,
      });
    }
  });

  it('deletes a relocated backup that hashes to the record digest, and only once', async () => {
    const { logger, records } = recordingLogger();
    const store = storeFor({ logger });
    const { path, directory } = plantRelocated(ORIGINAL_HASH, ORIGINAL);

    expect(
      okValue(
        await store.removeRecorded(path, ORIGINAL_HASH, { restoredContentHash: ORIGINAL_HASH }),
      ),
    ).toBe(true);
    expect(existsSync(path)).toBe(false);
    // Only the entry goes: the directory it was moved into is not this
    // operation's to remove.
    expect(existsSync(directory)).toBe(true);
    expect(records.map((record) => record.fields)).toStrictEqual([
      { backupPath: path, originalHash: ORIGINAL_HASH },
    ]);

    // Idempotent in both shapes of "already gone".
    expect(okValue(await store.removeRecorded(path, ORIGINAL_HASH))).toBe(false);
    expect(
      okValue(
        await store.removeRecorded(
          `${store.sessionDirectory}/moved/${ORIGINAL_HASH}`,
          ORIGINAL_HASH,
        ),
      ),
    ).toBe(false);
  });

  it('keeps a relocated backup whose bytes are not the record’s original', async () => {
    const { logger, records } = recordingLogger();
    const store = storeFor({ logger });
    const { path } = plantRelocated(ORIGINAL_HASH, OTHER);
    const error = errorOf(await store.removeRecorded(path, ORIGINAL_HASH));

    expect(error.code).toBe('STORE_ERROR');
    expect(error.details).toStrictEqual({
      reason: 'stored-digest-mismatch',
      path,
      expected: ORIGINAL_HASH,
      actual: OTHER_HASH,
    });
    expect(Buffer.compare(readFileSync(path), OTHER)).toBe(0);
    expect(
      records.filter((record) => record.level === 'warn').map((record) => record.fields),
    ).toStrictEqual([{ backupPath: path, originalHash: ORIGINAL_HASH, storedDigest: OTHER_HASH }]);
    expectNotCarried(error, CONTENT_MARKER);
  });

  it('keeps a relocated backup when the declared restoration is mismatched or malformed', async () => {
    const store = storeFor();
    const { path } = plantRelocated(ORIGINAL_HASH, ORIGINAL);
    const mismatched = errorOf(
      await store.removeRecorded(path, ORIGINAL_HASH, { restoredContentHash: OTHER_HASH }),
    );
    const malformed = errorOf(
      await store.removeRecorded(path, ORIGINAL_HASH, { restoredContentHash: 'restored' }),
    );

    expect(mismatched.code).toBe('CLEANUP_PARTIAL');
    expect(mismatched.details).toStrictEqual({
      reason: 'restored-content-digest-mismatch',
      path,
      originalHash: ORIGINAL_HASH,
      restoredContentHash: OTHER_HASH,
    });
    expect(malformed.details).toStrictEqual({
      reason: 'not-a-digest',
      field: 'restoredContentHash',
    });
    expect(Buffer.compare(readFileSync(path), ORIGINAL)).toBe(0);
    // Refused before the walk: a delete whose precondition failed never pins.
    expect(sharedHooks.pinned).toStrictEqual([]);
  });

  it('refuses a relocated backup inside a directory other accounts can read, without opening it', async () => {
    const store = storeFor();
    const { path, directory } = plantRelocated(ORIGINAL_HASH, ORIGINAL);

    // The one loosened mode in this file, and the refusal is the assertion.
    chmodSync(directory, 0o755);

    const readRefusal = errorOf(await store.readRecorded(path, ORIGINAL_HASH));
    const removeRefusal = errorOf(await store.removeRecorded(path, ORIGINAL_HASH));

    for (const refusal of [readRefusal, removeRefusal]) {
      expect(refusal.code).toBe('FS_UNSAFE_PATH');
      expect(refusal.details).toMatchObject({ reason: 'group-or-other-permissions' });
      expectNotCarried(refusal, CONTENT_MARKER);
    }

    expect(Buffer.compare(readFileSync(path), ORIGINAL)).toBe(0);
  });

  it('refuses a relocated backup whose directory is a regular file', async () => {
    const store = storeFor();
    const notADirectory = join(privateDirectory('backups', SESSION_ID), QUARANTINE);

    plantFile(notADirectory, OTHER);

    const error = errorOf(
      await store.readRecorded(`${notADirectory}/${ORIGINAL_HASH}`, ORIGINAL_HASH),
    );

    // The walk opens every component as a directory without following a link,
    // and a file where a directory should be fails that open the same way a
    // link does.
    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.details).toMatchObject({ reason: 'symlink-component' });
    expect(Buffer.compare(readFileSync(notADirectory), OTHER)).toBe(0);
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a relocated backup reached through a linked directory, and reads nothing through it',
    async () => {
      const store = storeFor();
      const elsewhere = privateDirectory('elsewhere');

      plantFile(join(elsewhere, ORIGINAL_HASH), OTHER);
      symlinkSync(elsewhere, join(privateDirectory('backups', SESSION_ID), QUARANTINE), 'dir');

      const recorded = `${store.sessionDirectory}/${QUARANTINE}/${ORIGINAL_HASH}`;

      for (const refusal of [
        errorOf(await store.readRecorded(recorded, ORIGINAL_HASH)),
        errorOf(await store.removeRecorded(recorded, ORIGINAL_HASH)),
      ]) {
        expect(refusal.code).toBe('FS_UNSAFE_PATH');
        expect(refusal.details).toMatchObject({ reason: 'symlink-component' });
      }

      expect(Buffer.compare(readFileSync(join(elsewhere, ORIGINAL_HASH)), OTHER)).toBe(0);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'rejects with ELOOP for a symbolic link at a relocated backup’s own name',
    async () => {
      const store = storeFor();
      const target = join(home, 'developer-file');
      const directory = privateDirectory('backups', SESSION_ID, QUARANTINE);

      plantFile(target, ORIGINAL);
      symlinkSync(target, join(directory, ORIGINAL_HASH));

      await expect(
        store.readRecorded(join(directory, ORIGINAL_HASH), ORIGINAL_HASH),
      ).rejects.toMatchObject({ code: 'ELOOP' });
      await expect(
        store.removeRecorded(join(directory, ORIGINAL_HASH), ORIGINAL_HASH),
      ).rejects.toMatchObject({ code: 'ELOOP' });
      expect(Buffer.compare(readFileSync(target), ORIGINAL)).toBe(0);
    },
  );

  it('propagates a throw from the pinned seam and keeps the backup', async () => {
    const store = storeFor({
      onRelocatedBackupPinned: (): void => {
        throw new RangeError('seam refused');
      },
    });
    const { path } = plantRelocated(ORIGINAL_HASH, ORIGINAL);

    await expect(store.readRecorded(path, ORIGINAL_HASH)).rejects.toThrow(RangeError);
    await expect(store.removeRecorded(path, ORIGINAL_HASH)).rejects.toThrow(RangeError);
    expect(Buffer.compare(readFileSync(path), ORIGINAL)).toBe(0);
  });

  it('never reads a non-string code on a thrown value as an absence', async () => {
    // Only the string `ENOENT` means "gone". A numeric `code` — as some
    // libraries attach — must surface as the failure it is, not become a
    // `backup-missing` or an idempotent `false`.
    const numeric = Object.assign(new Error('numeric code'), { code: 2 });
    const store = storeFor({
      onRelocatedBackupPinned: (): void => {
        throw numeric;
      },
    });
    const { path } = plantRelocated(ORIGINAL_HASH, ORIGINAL);

    await expect(store.readRecorded(path, ORIGINAL_HASH)).rejects.toBe(numeric);
    await expect(store.removeRecorded(path, ORIGINAL_HASH)).rejects.toBe(numeric);
    expect(existsSync(path)).toBe(true);
  });

  it('rejects with the platform’s own code when the pinned walk cannot open a component', async () => {
    const store = storeFor();

    privateDirectory('backups', SESSION_ID);

    // A lexically valid relocation whose directory name exceeds the platform's
    // component limit: the walk's open fails with an errno that is neither an
    // absence nor a link refusal, and it reaches the caller unchanged.
    const recorded = `${store.sessionDirectory}/${'q'.repeat(300)}/${ORIGINAL_HASH}`;

    expect(okValue(store.locateRecorded(recorded, ORIGINAL_HASH)).source).toBe('relocated');
    await expect(store.readRecorded(recorded, ORIGINAL_HASH)).rejects.toMatchObject({
      code: 'ENAMETOOLONG',
    });
    await expect(store.removeRecorded(recorded, ORIGINAL_HASH)).rejects.toMatchObject({
      code: 'ENAMETOOLONG',
    });
  });

  it.skipIf(!ENFORCES_PINS)(
    'reads the judged directory through an enforced pin even after the path is swapped',
    async () => {
      const decoy = Buffer.from('decoy planted after the directory was judged\n', 'utf8');
      const { path, directory } = plantRelocated(ORIGINAL_HASH, ORIGINAL);
      const store = storeFor({
        onRelocatedBackupPinned: (): void => {
          swapDirectoryForDecoy(directory, ORIGINAL_HASH, decoy);
        },
      });
      const read = okValue(await store.readRecorded(path, ORIGINAL_HASH));

      // The descriptor still names the directory that was judged, so the decoy
      // now at the recorded path is not what came back.
      expect(Buffer.compare(read.bytes, ORIGINAL)).toBe(0);
      expect(Buffer.compare(readFileSync(path), decoy)).toBe(0);
    },
  );

  it.each<[string, (store: BackupStore) => Promise<Result<unknown>>]>([
    ['readRecorded', (store) => store.readRecorded('/anywhere', '..')],
    ['removeRecorded', (store) => store.removeRecorded('/anywhere', '..')],
  ])('refuses an unsafe digest in %s', async (_label, call) => {
    const error = errorOf(await call(storeFor()));

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.details).toMatchObject({ reason: 'unsafe-path-segment' });
  });
});

/* -------------------------------------------------------------------------------------------------
 * 6b. A relocated backup that changes between the judgement and the use
 * ---------------------------------------------------------------------------------------------- */

describe('BackupStore relocated backups: a directory or entry that changed is backup-replaced', () => {
  /** A decoy a concurrent writer puts where the judged backup was. */
  const DECOY = Buffer.from(
    'decoy that must never be read or deleted in the record’s name\n',
    'utf8',
  );

  it('reads and deletes through a degraded pin while nothing has moved', async () => {
    sharedHooks.pin = degradedPin;

    const store = storeFor();
    const { path } = plantRelocated(ORIGINAL_HASH, ORIGINAL);

    // Where the platform cannot enforce the pin, the identity check is the only
    // protection, and a directory that is still the judged one passes it.
    expect(
      Buffer.compare(okValue(await store.readRecorded(path, ORIGINAL_HASH)).bytes, ORIGINAL),
    ).toBe(0);
    expect(okValue(await store.removeRecorded(path, ORIGINAL_HASH))).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to read through a degraded pin whose directory was swapped after the walk', async () => {
    sharedHooks.pin = degradedPin;

    const { path, directory } = plantRelocated(ORIGINAL_HASH, ORIGINAL);
    let judged = '';
    const store = storeFor({
      onRelocatedBackupPinned: (): void => {
        judged = swapDirectoryForDecoy(directory, ORIGINAL_HASH, DECOY);
      },
    });
    const error = errorOf(await store.readRecorded(path, ORIGINAL_HASH));

    expect(error.code).toBe('STORE_ERROR');
    expect(error.details).toStrictEqual({
      reason: 'backup-replaced',
      path,
      originalHash: ORIGINAL_HASH,
    });
    // Nothing was read from the decoy, and both files are where they were left.
    expect(Buffer.compare(readFileSync(join(judged, ORIGINAL_HASH)), ORIGINAL)).toBe(0);
    expect(Buffer.compare(readFileSync(path), DECOY)).toBe(0);
    expectNotCarried(error, CONTENT_MARKER);
  });

  it('refuses to delete through a degraded pin whose directory was swapped after the walk', async () => {
    sharedHooks.pin = degradedPin;

    const { path, directory } = plantRelocated(ORIGINAL_HASH, ORIGINAL);
    let judged = '';
    const store = storeFor({
      onRelocatedBackupPinned: (): void => {
        judged = swapDirectoryForDecoy(directory, ORIGINAL_HASH, DECOY);
      },
    });
    const error = errorOf(await store.removeRecorded(path, ORIGINAL_HASH));

    expect(error.code).toBe('STORE_ERROR');
    expect(error.details).toStrictEqual({
      reason: 'backup-replaced',
      path,
      originalHash: ORIGINAL_HASH,
    });
    expect(Buffer.compare(readFileSync(join(judged, ORIGINAL_HASH)), ORIGINAL)).toBe(0);
    expect(Buffer.compare(readFileSync(path), DECOY)).toBe(0);
  });

  it('refuses the unlink when the directory is swapped between the verifying read and the delete', async () => {
    sharedHooks.pin = degradedPin;

    const { logger, records } = recordingLogger();
    const { path, directory } = plantRelocated(ORIGINAL_HASH, ORIGINAL);
    let judged = '';

    sharedHooks.afterSnapshot = (): void => {
      judged = swapDirectoryForDecoy(directory, ORIGINAL_HASH, ORIGINAL);
    };

    const error = errorOf(await storeFor({ logger }).removeRecorded(path, ORIGINAL_HASH));

    // The bytes verified, but the directory that held them is no longer at the
    // path — and even a byte-identical decoy there is not what was judged.
    expect(error.details).toStrictEqual({
      reason: 'backup-replaced',
      path,
      originalHash: ORIGINAL_HASH,
    });
    expect(existsSync(join(judged, ORIGINAL_HASH))).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(
      records.filter((record) => record.level === 'warn').map((record) => record.fields),
    ).toStrictEqual([{ backupPath: path, originalHash: ORIGINAL_HASH }]);
  });

  it.skipIf(!ENFORCES_PINS)(
    'refuses the unlink through an enforced pin when the entry is replaced after the verifying read',
    async () => {
      const { path, directory } = plantRelocated(ORIGINAL_HASH, ORIGINAL);
      const before = statSync(path, { bigint: true }).ino;

      // The pin is the real, enforced one: the directory cannot be redirected,
      // but the entry inside it can still be replaced by a writer in the tree.
      sharedHooks.afterSnapshot = (): void => {
        const staging = join(directory, 'replacement.tmp');

        plantFile(staging, ORIGINAL);
        renameSync(staging, path);
      };

      const error = errorOf(await storeFor().removeRecorded(path, ORIGINAL_HASH));
      const after = statSync(path, { bigint: true }).ino;

      expect(error.code).toBe('STORE_ERROR');
      expect(error.details).toStrictEqual({
        reason: 'backup-replaced',
        path,
        originalHash: ORIGINAL_HASH,
      });
      // A different inode now sits at the name, and it was kept: identical bytes
      // are not the entry that was verified.
      expect(after).not.toBe(before);
      expect(Buffer.compare(readFileSync(path), ORIGINAL)).toBe(0);
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * 7. The session sweep
 * ---------------------------------------------------------------------------------------------- */

describe('BackupStore.removeSessionDirectory: non-recursive and fail-closed', () => {
  it('answers 0 for a session directory that was never created', async () => {
    expect(okValue(await storeFor().removeSessionDirectory())).toBe(0);
    expect(readdirSync(home)).toStrictEqual([]);
  });

  it('deletes every backup it created and then the emptied directory', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    okValue(await store.put(OTHER_HASH, OTHER));

    expect(okValue(await store.removeSessionDirectory())).toBe(2);
    expect(existsSync(store.sessionDirectory)).toBe(false);
    // The shared backups root belongs to every session and is left in place.
    expect(existsSync(join(home, 'backups'))).toBe(true);
    expect(okValue(await store.removeSessionDirectory())).toBe(0);
  });

  it('never sweeps a relocated backup, and reports its subdirectory as retained', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));

    const { path } = plantRelocated(OTHER_HASH, OTHER);
    const error = errorOf(await store.removeSessionDirectory());

    expect(error.code).toBe('CLEANUP_PARTIAL');
    expect(error.details).toStrictEqual({
      reason: 'session-directory-not-emptied',
      sessionDirectory: store.sessionDirectory,
      removed: 1,
      retainedCount: 1,
      retainedSample: [QUARANTINE],
    });
    // The digest-named backup it created is gone; the relocated one is not.
    expect(existsSync(join(store.sessionDirectory, ORIGINAL_HASH))).toBe(false);
    expect(Buffer.compare(readFileSync(path), OTHER)).toBe(0);
  });

  it('retains an entry it did not create and bounds the sample it reports', async () => {
    const store = storeFor();
    const directory = privateDirectory('backups', SESSION_ID);
    const foreign = Array.from(
      { length: 25 },
      (_unused, index) => `foreign-${String(index).padStart(2, '0')}.txt`,
    );

    for (const name of foreign) {
      plantFile(join(directory, name), OTHER);
    }

    const error = errorOf(await store.removeSessionDirectory());
    const details = error.details ?? {};

    expect(details['reason']).toBe('session-directory-not-emptied');
    expect(details['removed']).toBe(0);
    expect(details['retainedCount']).toBe(25);
    expect(details['retainedSample']).toHaveLength(20);
    expect(readdirSync(directory).sort()).toStrictEqual([...foreign].sort());
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a session directory that is a symbolic link, and deletes nothing through it',
    async () => {
      const store = storeFor();
      const elsewhere = privateDirectory('elsewhere');

      plantFile(join(elsewhere, ORIGINAL_HASH), ORIGINAL);
      symlinkSync(elsewhere, join(privateDirectory('backups'), SESSION_ID), 'dir');

      const error = errorOf(await store.removeSessionDirectory());

      expect(error.code).toBe('FS_UNSAFE_PATH');
      expect(Buffer.compare(readFileSync(join(elsewhere, ORIGINAL_HASH)), ORIGINAL)).toBe(0);
    },
  );

  it('retains a digest-named directory, since only regular files are its own', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    privateDirectory('backups', SESSION_ID, OTHER_HASH);

    const error = errorOf(await store.removeSessionDirectory());

    expect(error.details).toMatchObject({
      removed: 1,
      retainedCount: 1,
      retainedSample: [OTHER_HASH],
    });
    expect(lstatSync(join(store.sessionDirectory, OTHER_HASH)).isDirectory()).toBe(true);
  });

  it('rethrows an errno other than absence from the policy check, and deletes nothing', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    sharedHooks.faults.assertSecureDir = 'EACCES';

    await expect(store.removeSessionDirectory()).rejects.toMatchObject({ code: 'EACCES' });

    sharedHooks.faults = {};
    expect(okValue(await store.has(ORIGINAL_HASH))).toBe(true);
  });

  it('answers 0 when the directory disappears between the policy check and the listing', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    fsHooks.beforeReaddir = (path): void => {
      rmSync(path, { recursive: true });
    };

    expect(okValue(await store.removeSessionDirectory())).toBe(0);
    expect(existsSync(store.sessionDirectory)).toBe(false);
  });

  it('rethrows a listing failure other than absence', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    fsHooks.beforeReaddir = (path): void => {
      rmSync(path, { recursive: true });
      plantFile(path, OTHER);
    };

    await expect(store.removeSessionDirectory()).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(Buffer.compare(readFileSync(store.sessionDirectory), OTHER)).toBe(0);
  });

  it('skips a listed backup that another pass removed first, and still empties the directory', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    okValue(await store.put(OTHER_HASH, OTHER));
    fsHooks.afterReaddir = (path): void => {
      rmSync(join(path, OTHER_HASH));
    };

    // The concurrent pass's deletion is not counted as this one's.
    expect(okValue(await store.removeSessionDirectory())).toBe(1);
    expect(existsSync(store.sessionDirectory)).toBe(false);
  });

  it('rethrows an unlink failure other than absence, keeping what it had not reached', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    fsHooks.afterReaddir = (path): void => {
      // Replaced between the listing and the delete by a directory, which
      // `unlink` refuses; the directory's content must survive.
      rmSync(join(path, ORIGINAL_HASH));
      mkdirSync(join(path, ORIGINAL_HASH), { mode: 0o700 });
      plantFile(join(path, ORIGINAL_HASH, 'inside'), OTHER);
    };

    await expect(store.removeSessionDirectory()).rejects.toMatchObject({ code: 'EISDIR' });
    expect(readdirSync(join(store.sessionDirectory, ORIGINAL_HASH))).toStrictEqual(['inside']);
  });

  it('treats a directory another process removed before the rmdir as done', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    fsHooks.beforeRmdir = (path): void => {
      rmSync(path, { recursive: true });
    };

    expect(okValue(await store.removeSessionDirectory())).toBe(1);
    expect(existsSync(store.sessionDirectory)).toBe(false);
  });

  it('reports an entry that arrived before the rmdir as CLEANUP_PARTIAL instead of forcing it', async () => {
    const store = storeFor();
    const arrival = 'arrived-during-the-sweep';

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    fsHooks.beforeRmdir = (path): void => {
      plantFile(join(path, arrival), OTHER);
    };

    const error = errorOf(await store.removeSessionDirectory());

    expect(error.code).toBe('CLEANUP_PARTIAL');
    expect(error.details).toStrictEqual({
      reason: 'session-directory-not-emptied',
      sessionDirectory: store.sessionDirectory,
      removed: 1,
      retainedCount: 0,
      retainedSample: [],
    });
    expect(readdirSync(store.sessionDirectory)).toStrictEqual([arrival]);
  });

  it('rethrows an rmdir failure other than absence or a non-empty directory', async () => {
    const store = storeFor();

    okValue(await store.put(ORIGINAL_HASH, ORIGINAL));
    fsHooks.beforeRmdir = (path): void => {
      rmSync(path, { recursive: true });
      plantFile(path, OTHER);
    };

    await expect(store.removeSessionDirectory()).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(Buffer.compare(readFileSync(store.sessionDirectory), OTHER)).toBe(0);
  });
});
