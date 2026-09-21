/**
 * Tests for `./safe-fs.ts`: the two filesystem guarantees the product cannot
 * re-establish anywhere else.
 *
 * The module writes into two places, under two different rules, and the whole
 * point of this suite is that neither rule drifts into the other:
 *
 * 1. **The product's own state directory is private by construction.** It
 *    holds the session store, the backups that make a source edit reversible,
 *    and the plaintext credential the editor client authenticates with. A
 *    directory in that tree that grants group or other access, or a file
 *    created through a symbolic link another local process planted, hands that
 *    credential — or the right to corrupt a backup — to anything else running
 *    on the machine. So the cases below assert the *resulting filesystem*: the
 *    mode a directory actually carries, the mode a file actually carries, and
 *    the refusal to write through a planted link.
 * 2. **An edit inside a developer's project stays reversible.** The
 *    instrumentation patcher replaces a file the developer owns, in a directory
 *    that is an ordinary `0755` it did not create, and the restore must return
 *    that file to exactly what was found — content *and* permissions. Were the
 *    project-side writer to acquire the state directory's `0700`-parent
 *    assertion it would refuse every real project; were it to force `0600` it
 *    would silently change a file's permissions and record a modification it
 *    cannot revert. The two "pair-distinction" cases in the
 *    `atomicReplaceFile` suite are the only mechanical protection against a
 *    later refactor merging the two writers, and they say so where they stand.
 *
 * ## The one place POSIX and the prose diverge: `EEXIST` versus `ELOOP`
 *
 * "A symlink planted at the target path is refused" is a single property with
 * two errnos behind it, because the refusal comes from different flags in each
 * direction, and every expectation here was checked against this runtime before
 * it was written down rather than inferred from the flag names:
 *
 * - `readFileNoFollow` opens with `O_RDONLY | O_NOFOLLOW`, and a symbolic link
 *   at the final component fails with **`ELOOP`** — the platform's way of
 *   reporting `O_NOFOLLOW` meeting a link. That is the case named in the plan,
 *   and it is asserted exactly.
 * - `createFileExclusive` opens with `O_CREAT | O_EXCL | O_NOFOLLOW`, and POSIX
 *   gives `O_EXCL` precedence: an existing symlink — *even a dangling one* — is
 *   reported as **`EEXIST`**. Both errnos are refusals, so that case accepts
 *   either and then asserts the property that actually matters, which no errno
 *   can express on its own: the link's target is byte-for-byte unchanged, and a
 *   dangling link's target was never created. Weakening the module's flags to
 *   make one tidy errno appear everywhere would trade a real guarantee for a
 *   neater assertion.
 *
 * A symbolic link in a *directory* chain is not an errno at all but a policy
 * refusal — a `DebuggenError` coded `FS_UNSAFE_PATH` — because the module
 * refuses to resolve the link rather than asking the kernel to open it. That
 * distinction is asserted too: policy failures are wrapped, runtime errnos are
 * passed through untouched, and several cases pin each half of that contract by
 * checking `DebuggenError.is` as well as the code.
 *
 * ## Three habits, each deliberate
 *
 * - **One fresh sandbox per test.** Every case works inside its own
 *   `mkdtemp` directory, resolved through `realpath` so a temp directory that
 *   is itself reached through a link (as it is on macOS) cannot make a chain
 *   check fail for the wrong reason. Nothing reads or writes the checkout, no
 *   case depends on another's leftovers, and the sandbox is removed afterwards
 *   whether the case passed or failed.
 * - **Modes are set with `chmod`, never requested from `mkdir`/`writeFile`.**
 *   Those take a mode that the process umask then masks, so `0o664` requested
 *   under the common `umask 022` lands as `0o644` and a fixture would quietly
 *   describe a different filesystem than the one it set up. For the same
 *   reason the "an explicit mode is honoured exactly" case asks for a mode with
 *   a group bit: under that umask it is the case that fails if the
 *   implementation stops re-applying the mode with `fchmod` after opening.
 *   `process.umask(mask)` is not an option here — it throws inside a worker
 *   thread, which is where Vitest runs these tests — so the chmod-on-existing
 *   behaviour is proven by tightening a directory that was already `0755`.
 * - **Platform-dependent cases are skipped by capability, never by platform
 *   name.** `it.skipIf` guards on the absence of `process.getuid` (no owner or
 *   permission-bit model) and on the absence of `O_NOFOLLOW`, matching how the
 *   module itself decides, and each guarded name says why it is guarded. The
 *   guards are on the *capability*, not on the uid's value: running as a
 *   privileged user does not change what a mode check reports, so there are no
 *   root-specific branches anywhere below.
 *
 * Payloads are short, obviously synthetic text or explicit byte arrays. The
 * case that stands in for the credential file writes a two-field JSON object
 * with no credential in it, because a realistic-looking secret in a committed
 * test is still a secret in the repository.
 */

import {
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DebuggenError } from '../errors.js';
import {
  SECURE_DIR_MODE,
  SECURE_FILE_MODE,
  assertSecureDir,
  atomicReplaceFile,
  createFileExclusive,
  ensureSecureDir,
  readFileNoFollow,
  writeSecureFileAtomic,
} from './safe-fs.js';

/*
 * ---------------------------------------------------------------------------
 * Capability guards
 * ---------------------------------------------------------------------------
 */

/**
 * Whether this platform has no user ids, and therefore no ownership or
 * permission-bit model for the module to assert against.
 *
 * The capability form of "is `process.getuid` absent" — written with `typeof`,
 * the same way the module under test decides, so the test and the code it
 * covers agree about what "POSIX enough" means. Cases guarded by this are the
 * ones whose *subject* is a mode or an owner; the structural refusals (a
 * symbolic link, a file where a directory belongs) hold everywhere and are not
 * guarded.
 */
const NO_POSIX_IDS = typeof process.getuid !== 'function';

/**
 * Whether this platform has no `O_NOFOLLOW`.
 *
 * Read through `unknown` because the type declarations describe the POSIX
 * constant set — the compiler believes the property is always a number, while
 * on Windows it is genuinely absent — and a `0` value would contribute nothing
 * to a flag mask either way, so both cases mean "the no-follow guarantee is not
 * available here".
 */
const NO_NOFOLLOW = ((): boolean => {
  const flag: unknown = constants.O_NOFOLLOW;
  return typeof flag !== 'number' || flag === 0;
})();

/*
 * ---------------------------------------------------------------------------
 * Fixture modes and payloads
 * ---------------------------------------------------------------------------
 */

/** The permission bits of a mode, with file-type and set-id bits masked off. */
const PERMISSION_BITS = 0o777;

/** An ordinary directory mode: what a developer's project directory carries. */
const PROJECT_DIR_MODE = 0o755;

/** An ordinary file mode: what a source file in a project carries. */
const PROJECT_FILE_MODE = 0o644;

/**
 * A mode with a group bit, used where the point is that the requested mode
 * survives the process umask.
 *
 * Under the common `umask 022` an `open` that is handed this mode produces
 * `0o640`, so a case asserting the file ends up at exactly `0o660` fails the
 * moment the implementation stops re-applying the mode with `fchmod`.
 */
const GROUP_WRITABLE_FILE_MODE = 0o660;

/**
 * A payload larger than any single `write` can be assumed to place.
 *
 * `write` is allowed to report a short count, so a writer without a loop
 * truncates exactly here and nowhere in the small payloads. 192 KiB is
 * comfortably past the 128 KiB the plan names and still trivial to compare.
 */
const LARGE_PAYLOAD_LENGTH = 192 * 1024;

/** Bytes that are not valid UTF-8, so nothing can quietly decode and re-encode them. */
const NON_UTF8_BYTES = Uint8Array.of(0xff, 0xfe, 0x00, 0x01);

/*
 * ---------------------------------------------------------------------------
 * Sandbox
 * ---------------------------------------------------------------------------
 */

/**
 * The current test's sandbox: an absolute, symlink-free path to an empty
 * directory that `mkdtemp` created `0700`.
 *
 * Initialised to the empty string rather than declared with a definite
 * assignment assertion, so the compiler's strictness is satisfied by ordinary
 * code and a case that somehow ran without `beforeEach` would fail on an
 * obviously wrong path instead of on an undefined one.
 */
let sandbox = '';

beforeEach(() => {
  // `realpath` matters: on a platform whose temp directory is reached through a
  // symbolic link, an unresolved path would make every chain check report a
  // symlink component — a correct refusal about the wrong thing.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-safefs-')));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/** The permission bits of the file or directory at `pathAbs`, following links. */
function permissionsOf(pathAbs: string): number {
  return statSync(pathAbs).mode & PERMISSION_BITS;
}

/** A mode rendered the way a developer would type it into `chmod`. */
function octal(mode: number): string {
  return (mode & PERMISSION_BITS).toString(8).padStart(3, '0');
}

/** The bytes of a payload: text encoded as UTF-8, bytes taken verbatim. */
function bytesOf(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

/**
 * Creates a directory (and any missing parent) and sets its mode exactly.
 *
 * The `chmod` is not redundant: `mkdir`'s mode argument is masked by the
 * process umask, so a fixture that only requested a mode would be describing
 * the umask rather than the directory.
 */
function makeDir(pathAbs: string, mode: number): string {
  mkdirSync(pathAbs, { recursive: true });
  chmodSync(pathAbs, mode);
  return pathAbs;
}

/** Writes a file with exact bytes and, when asked, an exact mode. */
function makeFile(pathAbs: string, data: string | Uint8Array, mode?: number): string {
  writeFileSync(pathAbs, bytesOf(data));
  if (mode !== undefined) {
    chmodSync(pathAbs, mode);
  }
  return pathAbs;
}

/** Deterministic bytes, so a large payload can be compared rather than sampled. */
function syntheticBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + 7) % 256;
  }
  return bytes;
}

/** Asserts the file at `pathAbs` holds exactly `expected`, byte for byte. */
function expectFileBytes(pathAbs: string, expected: string | Uint8Array): void {
  const expectedBytes = bytesOf(expected);
  const actual = readFileSync(pathAbs);
  expect(actual.byteLength).toBe(expectedBytes.byteLength);
  expect(Buffer.compare(actual, expectedBytes)).toBe(0);
}

/** The sorted names in a directory, dotted entries included. */
function entriesIn(dirAbs: string): string[] {
  return readdirSync(dirAbs).sort();
}

/**
 * The temporary siblings left in a directory by an atomic write.
 *
 * The module names them `.<target>.<pid>.<random>.tmp`, so the extension is
 * what identifies one, and `readdir` lists dotted entries — a cleanup path that
 * stopped running would show up here rather than being invisible.
 */
function temporaryLeftoversIn(dirAbs: string): string[] {
  return entriesIn(dirAbs).filter((entry) => entry.endsWith('.tmp'));
}

/**
 * Runs `run` and returns what it threw, failing the case when it returns
 * normally.
 *
 * `catch` binds `unknown`, and every expectation below is about a specific
 * property of the thrown value — an errno string, an error code, a detail —
 * so the narrowing happens once, here, instead of in every case.
 */
function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the call was expected to throw, and returned normally instead');
}

/** The errno code of a caught value, when it carries a string one. */
function errnoOf(value: unknown): string | undefined {
  if (value instanceof Error && 'code' in value) {
    const code: unknown = value.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * The errno of a failure the module is supposed to pass through untouched.
 *
 * The `DebuggenError.is` check is part of the assertion, not a formality: a
 * `DebuggenError` carries a `code` of its own, so without it a wrapped policy
 * failure would be read as an errno and a case expecting `ENOENT` could pass
 * against `FS_UNSAFE_PATH`.
 */
function runtimeErrnoFrom(run: () => void): string | undefined {
  const thrown = thrownBy(run);
  expect(DebuggenError.is(thrown)).toBe(false);
  return errnoOf(thrown);
}

/** The `DebuggenError` a policy refusal raises, narrowed for inspection. */
function debuggenErrorFrom(run: () => void): DebuggenError {
  const thrown = thrownBy(run);
  if (DebuggenError.is(thrown)) {
    return thrown;
  }
  return expect.unreachable(
    `expected a DebuggenError, received a value of type '${typeof thrown}'`,
  );
}

/** The `FS_UNSAFE_PATH` refusal this module raises, narrowed for inspection. */
function unsafePathErrorFrom(run: () => void): DebuggenError {
  const error = debuggenErrorFrom(run);
  expect(error.code).toBe('FS_UNSAFE_PATH');
  return error;
}

/*
 * ---------------------------------------------------------------------------
 * The mode constants
 * ---------------------------------------------------------------------------
 */

describe('the mode constants', () => {
  // Cheap, and worth having: three other workspaces reason about these values
  // (the store's directory, the backup files, the credential file), and a
  // change here would silently widen permissions everywhere at once.
  it('names owner-only access for a state directory', () => {
    expect(SECURE_DIR_MODE).toBe(0o700);
  });

  it('names owner-only access for a state file', () => {
    expect(SECURE_FILE_MODE).toBe(0o600);
  });
});

/*
 * ---------------------------------------------------------------------------
 * assertSecureDir
 * ---------------------------------------------------------------------------
 */

describe('assertSecureDir', () => {
  it('accepts a directory owned by this account with no group or other access', () => {
    const dir = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);

    expect(() => {
      assertSecureDir(dir);
    }).not.toThrow();
  });

  it.skipIf(NO_POSIX_IDS)(
    'rejects a world-readable directory and names it (POSIX permission bits)',
    () => {
      const dir = makeDir(join(sandbox, 'state'), PROJECT_DIR_MODE);

      const error = unsafePathErrorFrom(() => {
        assertSecureDir(dir);
      });

      // The absolute path has to be in the error itself: the developer's next
      // action is a `chmod` on exactly this directory, and a message naming
      // "a directory" sends them looking.
      expect(error.details?.path).toBe(dir);
      expect(error.details?.reason).toBe('group-or-other-permissions');
      expect(error.message).toContain(dir);
      expect(error.details?.mode).toBe(octal(PROJECT_DIR_MODE));
    },
  );

  // Group and other bits are rejected individually, not only in the familiar
  // `0755` combination: the check is "no group or other access at all", and an
  // implementation comparing the whole mode against 0o700 — or masking only
  // the other bits — would pass one of these while leaking through the rest.
  for (const mode of [0o740, 0o701, 0o710, 0o704]) {
    it.skipIf(NO_POSIX_IDS)(
      `rejects a directory at mode ${octal(mode)} (POSIX permission bits)`,
      () => {
        const dir = makeDir(join(sandbox, 'state'), mode);

        const error = unsafePathErrorFrom(() => {
          assertSecureDir(dir);
        });

        expect(error.details?.path).toBe(dir);
        expect(error.details?.reason).toBe('group-or-other-permissions');
      },
    );
  }

  it.skipIf(NO_POSIX_IDS)(
    'walks the whole chain under upTo and rejects an intermediate directory (POSIX permission bits)',
    () => {
      const root = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);
      const middle = makeDir(join(root, 'backups'), PROJECT_DIR_MODE);
      const leaf = makeDir(join(middle, 'one'), SECURE_DIR_MODE);

      // The leaf on its own is private, so a check that stopped at the named
      // directory would report success for a tree anyone can walk into.
      expect(() => {
        assertSecureDir(leaf);
      }).not.toThrow();

      const error = unsafePathErrorFrom(() => {
        assertSecureDir(leaf, { upTo: root });
      });

      expect(error.details?.path).toBe(middle);
    },
  );

  it.skipIf(NO_POSIX_IDS)(
    'reports the outermost failing directory of a chain (POSIX permission bits)',
    () => {
      const root = makeDir(join(sandbox, 'state'), PROJECT_DIR_MODE);
      const leaf = makeDir(join(root, 'backups'), PROJECT_DIR_MODE);

      const error = unsafePathErrorFrom(() => {
        assertSecureDir(leaf, { upTo: root });
      });

      // Tightening the outer directory is what makes the inner one reachable,
      // so the outer one is the one worth naming first.
      expect(error.details?.path).toBe(root);
    },
  );

  it('refuses a directory that is itself a symbolic link instead of resolving it', () => {
    const target = makeDir(join(sandbox, 'real'), SECURE_DIR_MODE);
    const link = join(sandbox, 'link');
    symlinkSync(target, link);

    const error = unsafePathErrorFrom(() => {
      assertSecureDir(link);
    });

    expect(error.details?.path).toBe(link);
    expect(error.details?.reason).toBe('symlink-component');
  });

  it('refuses a chain whose parent contains a symbolic link, however private its target', () => {
    const root = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);
    const target = makeDir(join(root, 'real'), SECURE_DIR_MODE);
    const inner = makeDir(join(target, 'one'), SECURE_DIR_MODE);
    const link = join(root, 'link');
    symlinkSync(target, link);

    const error = unsafePathErrorFrom(() => {
      assertSecureDir(join(link, 'one'), { upTo: root });
    });

    expect(error.details?.path).toBe(link);
    expect(error.details?.reason).toBe('symlink-component');

    // What the link points at is a perfectly private directory, reached
    // directly: the refusal is about the link, not about its target. A check
    // that used `stat` instead of `lstat` would accept the path above, which is
    // exactly the substitution this case exists to catch.
    expect(() => {
      assertSecureDir(inner, { upTo: root });
    }).not.toThrow();
  });

  it('refuses a path that exists but is not a directory', () => {
    const file = makeFile(join(sandbox, 'occupied'), 'one line\n');

    const error = unsafePathErrorFrom(() => {
      assertSecureDir(file);
    });

    expect(error.details?.path).toBe(file);
    expect(error.details?.reason).toBe('not-a-directory');
  });

  it('reports a boundary that does not contain the directory as a programmer error', () => {
    const first = makeDir(join(sandbox, 'one'), SECURE_DIR_MODE);
    const second = makeDir(join(sandbox, 'two'), SECURE_DIR_MODE);

    const error = debuggenErrorFrom(() => {
      assertSecureDir(first, { upTo: second });
    });

    // Two unrelated paths mean the caller made a mistake; the filesystem is
    // not insecure, and coding it as though it were would send a developer
    // looking for a permission problem that does not exist.
    expect(error.code).toBe('INTERNAL');
    expect(error.code).not.toBe('FS_UNSAFE_PATH');
    expect(error.details?.reason).toBe('boundary-not-an-ancestor');
    expect(error.details?.upTo).toBe(second);
  });

  it('accepts a boundary equal to the directory itself', () => {
    const dir = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);

    expect(() => {
      assertSecureDir(dir, { upTo: dir });
    }).not.toThrow();
  });

  it('lets ENOENT through for a directory that does not exist', () => {
    // The error policy in one case: a runtime errno is passed through with its
    // code intact, and only a policy refusal is wrapped. A caller deciding
    // whether to create the directory needs to see `ENOENT`, not a paraphrase.
    const code = runtimeErrnoFrom(() => {
      assertSecureDir(join(sandbox, 'absent'));
    });

    expect(code).toBe('ENOENT');
  });

  it.skipIf(NO_POSIX_IDS)(
    'relaxes only the ownership test when requireOwner is false (POSIX permission bits)',
    () => {
      const shared = makeDir(join(sandbox, 'shared'), PROJECT_DIR_MODE);
      const privateDir = makeDir(join(sandbox, 'private'), SECURE_DIR_MODE);

      const error = unsafePathErrorFrom(() => {
        assertSecureDir(shared, { requireOwner: false });
      });

      expect(error.details?.reason).toBe('group-or-other-permissions');
      expect(() => {
        assertSecureDir(privateDir, { requireOwner: false });
      }).not.toThrow();
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * ensureSecureDir
 * ---------------------------------------------------------------------------
 */

describe('ensureSecureDir', () => {
  it.skipIf(NO_POSIX_IDS)(
    'creates every missing component at the secure directory mode (POSIX permission bits)',
    () => {
      const root = join(sandbox, 'state');
      const middle = join(root, 'backups');
      const leaf = join(middle, 'one');

      ensureSecureDir(leaf);

      // Every component, not only the leaf: a private leaf inside a
      // world-writable parent is a directory anyone can replace wholesale.
      expect(permissionsOf(root)).toBe(SECURE_DIR_MODE);
      expect(permissionsOf(middle)).toBe(SECURE_DIR_MODE);
      expect(permissionsOf(leaf)).toBe(SECURE_DIR_MODE);
    },
  );

  it.skipIf(NO_POSIX_IDS)(
    'tightens a directory that already existed at a wider mode (POSIX permission bits)',
    () => {
      // This is the `chmod`-after-`mkdir` behaviour, proven the way it can be
      // proven inside a worker thread: `process.umask(mask)` throws there, so
      // an over-permissive directory is created first and the function is
      // asked to repair it — which is also the real case, a state root a
      // previous tool or an unpacked archive left at 0755.
      const root = makeDir(join(sandbox, 'state'), PROJECT_DIR_MODE);
      const leaf = join(root, 'backups');

      ensureSecureDir(leaf, { upTo: root });

      expect(permissionsOf(root)).toBe(SECURE_DIR_MODE);
      expect(permissionsOf(leaf)).toBe(SECURE_DIR_MODE);
    },
  );

  it('does not throw when called twice on the same directory', () => {
    const leaf = join(sandbox, 'state', 'backups');

    ensureSecureDir(leaf);

    expect(() => {
      ensureSecureDir(leaf);
    }).not.toThrow();
  });

  it.skipIf(NO_POSIX_IDS)(
    'leaves the secure directory mode after a second call (POSIX permission bits)',
    () => {
      const root = join(sandbox, 'state');
      const leaf = join(root, 'backups');

      ensureSecureDir(leaf, { upTo: root });
      ensureSecureDir(leaf, { upTo: root });

      expect(permissionsOf(root)).toBe(SECURE_DIR_MODE);
      expect(permissionsOf(leaf)).toBe(SECURE_DIR_MODE);
    },
  );

  it('lets the runtime errno through when a path component is an existing file', () => {
    const file = makeFile(join(sandbox, 'occupied'), 'one line\n');

    const code = runtimeErrnoFrom(() => {
      ensureSecureDir(join(file, 'inner'));
    });

    // Which of the two arrives is the platform's business; that it is one of
    // them, rather than a wrapped policy error, is the contract.
    expect(['ENOTDIR', 'EEXIST']).toContain(code);
  });

  it('lets the runtime errno through when the directory itself is an existing file', () => {
    const file = makeFile(join(sandbox, 'occupied'), 'one line\n');

    const code = runtimeErrnoFrom(() => {
      ensureSecureDir(file);
    });

    expect(['ENOTDIR', 'EEXIST']).toContain(code);
  });

  it('leaves a chain that satisfies assertSecureDir with the same arguments', () => {
    const root = join(sandbox, 'state');
    const leaf = join(root, 'backups', 'one');

    ensureSecureDir(leaf, { upTo: root });

    // The function's own postcondition, asserted from outside: a successful
    // return is a statement about the filesystem, not about the calls it made.
    expect(() => {
      assertSecureDir(leaf, { upTo: root });
    }).not.toThrow();
  });

  it('refuses to tighten a symbolic link in the chain', () => {
    const root = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);
    const outside = makeDir(join(sandbox, 'outside'), PROJECT_DIR_MODE);
    const link = join(root, 'link');
    symlinkSync(outside, link);

    const error = unsafePathErrorFrom(() => {
      ensureSecureDir(link, { upTo: root });
    });

    expect(error.details?.path).toBe(link);
    expect(error.details?.reason).toBe('symlink-component');
  });

  it.skipIf(NO_POSIX_IDS)(
    'leaves the mode of a link target untouched when it refuses the link (POSIX permission bits)',
    () => {
      // `chmod` follows a link, so tightening one would change the permissions
      // of a directory the product neither owns nor was asked to touch.
      const root = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);
      const outside = makeDir(join(sandbox, 'outside'), PROJECT_DIR_MODE);
      symlinkSync(outside, join(root, 'link'));

      unsafePathErrorFrom(() => {
        ensureSecureDir(join(root, 'link'), { upTo: root });
      });

      expect(permissionsOf(outside)).toBe(PROJECT_DIR_MODE);
    },
  );

  it('reports a boundary that does not contain the directory before creating anything', () => {
    const boundary = makeDir(join(sandbox, 'elsewhere'), SECURE_DIR_MODE);
    const leaf = join(sandbox, 'state', 'backups');

    const error = debuggenErrorFrom(() => {
      ensureSecureDir(leaf, { upTo: boundary });
    });

    expect(error.code).toBe('INTERNAL');
    expect(existsSync(leaf)).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * createFileExclusive
 * ---------------------------------------------------------------------------
 */

describe('createFileExclusive', () => {
  it('writes text as UTF-8, exactly', () => {
    const target = join(sandbox, 'note.txt');

    createFileExclusive(target, 'first line\nsecond line\n');

    expectFileBytes(target, 'first line\nsecond line\n');
  });

  it('writes bytes verbatim, including content that is not valid UTF-8', () => {
    const target = join(sandbox, 'original.bin');

    createFileExclusive(target, NON_UTF8_BYTES);

    // A backup of a developer's file is compared by digest later, so a writer
    // that decoded and re-encoded the bytes would make a restorable edit look
    // like a conflict.
    expectFileBytes(target, NON_UTF8_BYTES);
  });

  it('creates an empty file for an empty payload', () => {
    const target = join(sandbox, 'empty.txt');

    createFileExclusive(target, '');

    expect(statSync(target).size).toBe(0);
  });

  it('writes a payload larger than a single write can be assumed to place', () => {
    const target = join(sandbox, 'large.bin');
    const payload = syntheticBytes(LARGE_PAYLOAD_LENGTH);

    createFileExclusive(target, payload);

    // `write` may report a short count; without a loop the file is truncated
    // here and only here, which is why the length is asserted as well as the
    // content.
    expect(statSync(target).size).toBe(LARGE_PAYLOAD_LENGTH);
    expectFileBytes(target, payload);
  });

  it.skipIf(NO_POSIX_IDS)(
    'creates the file at the secure file mode (POSIX permission bits)',
    () => {
      const target = join(sandbox, 'auth.json');

      createFileExclusive(target, '{"role":"editor","issuedAt":1}');

      expect(permissionsOf(target)).toBe(SECURE_FILE_MODE);
    },
  );

  it.skipIf(NO_POSIX_IDS)('honours an explicit mode exactly (POSIX permission bits)', () => {
    const target = join(sandbox, 'note.txt');

    createFileExclusive(target, 'one line\n', { mode: GROUP_WRITABLE_FILE_MODE });

    // The requested mode carries a group bit the common `umask 022` masks, so
    // this is the assertion that fails if the mode stops being re-applied with
    // `fchmod` after the file is opened.
    expect(permissionsOf(target)).toBe(GROUP_WRITABLE_FILE_MODE);
  });

  it('refuses to overwrite an existing file and leaves its content alone', () => {
    const target = makeFile(join(sandbox, 'note.txt'), 'original\n');

    const code = runtimeErrnoFrom(() => {
      createFileExclusive(target, 'replacement\n');
    });

    expect(code).toBe('EEXIST');
    expectFileBytes(target, 'original\n');
  });

  it('refuses a path occupied by a directory', () => {
    const target = makeDir(join(sandbox, 'occupied'), SECURE_DIR_MODE);

    const code = runtimeErrnoFrom(() => {
      createFileExclusive(target, 'one line\n');
    });

    expect(['EEXIST', 'EISDIR']).toContain(code);
    expect(lstatSync(target).isDirectory()).toBe(true);
  });

  it('refuses a planted symbolic link and leaves its target byte-for-byte unchanged', () => {
    const victim = makeFile(join(sandbox, 'victim.txt'), 'untouched\n');
    const target = join(sandbox, 'note.txt');
    symlinkSync(victim, target);

    const code = runtimeErrnoFrom(() => {
      createFileExclusive(target, 'written through the link\n');
    });

    // `O_EXCL` takes precedence over `O_NOFOLLOW`: POSIX requires `EEXIST`
    // when the path names an existing link, so either errno is a correct
    // refusal here and the module's flags are not weakened to pick one. The
    // security property is the assertion below, which no errno can express:
    // nothing was written through the link.
    expect(['EEXIST', 'ELOOP']).toContain(code);
    expectFileBytes(victim, 'untouched\n');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it('refuses a dangling symbolic link rather than creating what it points at', () => {
    const missing = join(sandbox, 'missing.txt');
    const target = join(sandbox, 'note.txt');
    symlinkSync(missing, target);

    const code = runtimeErrnoFrom(() => {
      createFileExclusive(target, 'one line\n');
    });

    // The dangling case is the dangerous one: without `O_EXCL`'s refusal, a
    // create through the link would place the file wherever the link points —
    // a path the attacker, not the product, chose.
    expect(['EEXIST', 'ELOOP']).toContain(code);
    expect(existsSync(missing)).toBe(false);
  });

  it.skipIf(NO_POSIX_IDS)(
    'refuses an over-permissive parent and creates nothing (POSIX permission bits)',
    () => {
      const parent = makeDir(join(sandbox, 'shared'), PROJECT_DIR_MODE);
      const target = join(parent, 'auth.json');

      const error = unsafePathErrorFrom(() => {
        createFileExclusive(target, '{"role":"editor","issuedAt":1}');
      });

      expect(error.details?.path).toBe(parent);
      // The refusal has to come before the create, not after it: a credential
      // written and then complained about is still a credential anyone can
      // read.
      expect(existsSync(target)).toBe(false);
    },
  );

  it.skipIf(NO_POSIX_IDS)(
    'writes into an over-permissive parent when the directory policy is waived (POSIX permission bits)',
    () => {
      const parent = makeDir(join(sandbox, 'project'), PROJECT_DIR_MODE);
      const target = join(parent, 'note.txt');

      createFileExclusive(target, 'one line\n', { requireSecureParents: false });

      // The waiver governs the *directory* policy only; the file is still
      // created exclusively, without following a link, at the requested mode.
      expectFileBytes(target, 'one line\n');
      expect(permissionsOf(target)).toBe(SECURE_FILE_MODE);
    },
  );

  it.skipIf(NO_POSIX_IDS)(
    'checks the whole parent chain when upTo is given (POSIX permission bits)',
    () => {
      const root = makeDir(join(sandbox, 'state'), PROJECT_DIR_MODE);
      const parent = makeDir(join(root, 'backups'), SECURE_DIR_MODE);
      const target = join(parent, 'one.bin');

      // The immediate parent is private, so without a boundary the write is
      // allowed; with one, the chain above it is what fails.
      createFileExclusive(target, 'one line\n');
      expectFileBytes(target, 'one line\n');

      const error = unsafePathErrorFrom(() => {
        createFileExclusive(join(parent, 'two.bin'), 'one line\n', { upTo: root });
      });

      expect(error.details?.path).toBe(root);
      expect(existsSync(join(parent, 'two.bin'))).toBe(false);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * writeSecureFileAtomic
 * ---------------------------------------------------------------------------
 */

describe('writeSecureFileAtomic', () => {
  it('creates a file that does not exist yet, with exactly the given bytes', () => {
    const target = join(sandbox, 'auth.json');

    writeSecureFileAtomic(target, '{"role":"editor","issuedAt":1}');

    expectFileBytes(target, '{"role":"editor","issuedAt":1}');
  });

  it.skipIf(NO_POSIX_IDS)(
    'creates the file at the secure file mode (POSIX permission bits)',
    () => {
      const target = join(sandbox, 'auth.json');

      writeSecureFileAtomic(target, '{"role":"editor","issuedAt":1}');

      expect(permissionsOf(target)).toBe(SECURE_FILE_MODE);
    },
  );

  it('replaces existing content wholesale rather than appending to or truncating it', () => {
    const target = join(sandbox, 'auth.json');
    const long = '{"role":"editor","issuedAt":1,"note":"the first, longer value"}';
    const short = '{"role":"editor","issuedAt":2}';

    writeSecureFileAtomic(target, long);
    writeSecureFileAtomic(target, short);

    // A shorter second payload is the case that catches both failure modes at
    // once: a concatenation leaves the file longer than `short`, an in-place
    // write without truncation leaves a tail of the previous value.
    expectFileBytes(target, short);
    expect(statSync(target).size).toBe(Buffer.byteLength(short, 'utf8'));
  });

  it('leaves no temporary file behind after a successful write', () => {
    const target = join(sandbox, 'auth.json');

    writeSecureFileAtomic(target, '{"role":"editor","issuedAt":1}');

    expect(entriesIn(sandbox)).toEqual(['auth.json']);
    expect(temporaryLeftoversIn(sandbox)).toEqual([]);
  });

  it.skipIf(NO_POSIX_IDS)(
    'forces the secure file mode onto a file that was wider (POSIX permission bits)',
    () => {
      const target = makeFile(join(sandbox, 'auth.json'), '{"role":"editor"}', PROJECT_FILE_MODE);

      writeSecureFileAtomic(target, '{"role":"editor","issuedAt":2}');

      // The opposite decision from `atomicReplaceFile`: a state file's mode is
      // dictated, not inherited, so rotating a credential that was somehow
      // world-readable makes it private rather than keeping it readable.
      expect(permissionsOf(target)).toBe(SECURE_FILE_MODE);
    },
  );

  it.skipIf(NO_POSIX_IDS)(
    'refuses an over-permissive parent directory (POSIX permission bits)',
    () => {
      const parent = makeDir(join(sandbox, 'shared'), PROJECT_DIR_MODE);
      const target = join(parent, 'auth.json');

      const error = unsafePathErrorFrom(() => {
        writeSecureFileAtomic(target, '{"role":"editor","issuedAt":1}');
      });

      expect(error.details?.path).toBe(parent);
      expect(existsSync(target)).toBe(false);
      expect(temporaryLeftoversIn(parent)).toEqual([]);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * atomicReplaceFile
 * ---------------------------------------------------------------------------
 */

describe('atomicReplaceFile', () => {
  it('writes inside an ordinary project directory without a directory policy', () => {
    // The pair-distinction case. This function is the writer
    // `packages/instrumentation/src/patch/patcher.ts` uses for a file inside a
    // developer's project, whose directories are an ordinary 0755 the product
    // neither created nor owns. If it were ever collapsed into
    // `writeSecureFileAtomic` — or simply grew that function's
    // `assertSecureDir` call — this case would fail with FS_UNSAFE_PATH and
    // every real project would become uninstrumentable.
    const parent = makeDir(join(sandbox, 'project'), PROJECT_DIR_MODE);
    const target = makeFile(join(parent, 'source.ts'), 'export const one = 1;\n');

    expect(() => {
      atomicReplaceFile(target, 'export const one = 2;\n');
    }).not.toThrow();

    expectFileBytes(target, 'export const one = 2;\n');
  });

  // The second half of the pair distinction: the target's own permission bits
  // survive the replacement. Several modes, so the assertion cannot be
  // satisfied by a hardcoded default that happens to match one of them — and
  // an executable file stays executable, which a patch that is later reverted
  // depends on.
  for (const mode of [PROJECT_FILE_MODE, 0o664, 0o755, 0o600]) {
    it.skipIf(NO_POSIX_IDS)(
      `preserves an existing file's mode ${octal(mode)} (POSIX permission bits)`,
      () => {
        const target = makeFile(join(sandbox, 'source.ts'), 'export const one = 1;\n', mode);

        atomicReplaceFile(target, 'export const one = 2;\n');

        expect(permissionsOf(target)).toBe(mode);
        expectFileBytes(target, 'export const one = 2;\n');
      },
    );
  }

  it('creates the file when it does not exist', () => {
    const target = join(sandbox, 'source.ts');

    atomicReplaceFile(target, 'export const one = 1;\n');

    expectFileBytes(target, 'export const one = 1;\n');
  });

  it.skipIf(NO_POSIX_IDS)(
    'uses the documented default mode when it has to create the file (POSIX permission bits)',
    () => {
      const target = join(sandbox, 'source.ts');

      atomicReplaceFile(target, 'export const one = 1;\n');

      expect(permissionsOf(target)).toBe(PROJECT_FILE_MODE);
    },
  );

  it.skipIf(NO_POSIX_IDS)(
    'uses an explicit mode when it has to create the file (POSIX permission bits)',
    () => {
      const target = join(sandbox, 'source.ts');

      atomicReplaceFile(target, 'export const one = 1;\n', { mode: GROUP_WRITABLE_FILE_MODE });

      expect(permissionsOf(target)).toBe(GROUP_WRITABLE_FILE_MODE);
    },
  );

  it.skipIf(NO_POSIX_IDS)(
    'ignores an explicit mode when the target already exists (POSIX permission bits)',
    () => {
      const target = makeFile(join(sandbox, 'source.ts'), 'export const one = 1;\n', 0o600);

      atomicReplaceFile(target, 'export const one = 2;\n', { mode: GROUP_WRITABLE_FILE_MODE });

      // Preserving what was found outranks the option: the option exists for
      // the create case alone.
      expect(permissionsOf(target)).toBe(0o600);
    },
  );

  it('replaces exactly and repeatably', () => {
    const target = makeFile(join(sandbox, 'source.ts'), 'export const one = 1;\n');

    atomicReplaceFile(target, 'export const one = 2;\n');
    atomicReplaceFile(target, 'export const one = 3;\n');

    expectFileBytes(target, 'export const one = 3;\n');
  });

  it('leaves no temporary file behind after a successful replacement', () => {
    const parent = makeDir(join(sandbox, 'project'), PROJECT_DIR_MODE);
    const target = makeFile(join(parent, 'source.ts'), 'export const one = 1;\n');

    atomicReplaceFile(target, 'export const one = 2;\n');

    expect(entriesIn(parent)).toEqual(['source.ts']);
    expect(temporaryLeftoversIn(parent)).toEqual([]);
  });

  it('removes its temporary file when the rename cannot succeed', () => {
    // A deterministic failure with no mocking: a directory at the target path
    // makes the rename fail (POSIX mandates EISDIR for renaming a file onto a
    // directory) *after* the temporary sibling has been created and written,
    // which is the only point at which the cleanup path matters. Without it,
    // every failed patch would leave a stray file in the developer's project.
    const parent = makeDir(join(sandbox, 'project'), PROJECT_DIR_MODE);
    const target = makeDir(join(parent, 'source.ts'), PROJECT_DIR_MODE);
    makeFile(join(target, 'inside.txt'), 'still here\n');

    const code = runtimeErrnoFrom(() => {
      atomicReplaceFile(target, 'export const one = 2;\n');
    });

    expect(code).toBe('EISDIR');
    expect(lstatSync(target).isDirectory()).toBe(true);
    expectFileBytes(join(target, 'inside.txt'), 'still here\n');
    expect(temporaryLeftoversIn(parent)).toEqual([]);
    expect(entriesIn(parent)).toEqual(['source.ts']);
  });

  it('round-trips bytes through readFileNoFollow, including content that is not valid UTF-8', () => {
    const target = join(sandbox, 'original.bin');

    atomicReplaceFile(target, NON_UTF8_BYTES);

    const read = readFileNoFollow(target);
    expect(read.byteLength).toBe(NON_UTF8_BYTES.byteLength);
    expect(Buffer.compare(read, NON_UTF8_BYTES)).toBe(0);
  });

  it('lets ENOENT through when the parent directory does not exist', () => {
    const code = runtimeErrnoFrom(() => {
      atomicReplaceFile(join(sandbox, 'absent', 'source.ts'), 'export const one = 1;\n');
    });

    expect(code).toBe('ENOENT');
  });
});

/*
 * ---------------------------------------------------------------------------
 * readFileNoFollow
 * ---------------------------------------------------------------------------
 */

describe('readFileNoFollow', () => {
  it('returns the stored bytes unchanged, including content that is not valid UTF-8', () => {
    const target = makeFile(join(sandbox, 'original.bin'), NON_UTF8_BYTES);

    const read = readFileNoFollow(target);

    expect(read.byteLength).toBe(NON_UTF8_BYTES.byteLength);
    expect(Buffer.compare(read, NON_UTF8_BYTES)).toBe(0);
  });

  it('returns a large payload in full', () => {
    const payload = syntheticBytes(LARGE_PAYLOAD_LENGTH);
    const target = makeFile(join(sandbox, 'large.bin'), payload);

    const read = readFileNoFollow(target);

    expect(read.byteLength).toBe(LARGE_PAYLOAD_LENGTH);
    expect(Buffer.compare(read, payload)).toBe(0);
  });

  it.skipIf(NO_NOFOLLOW)('refuses a planted symbolic link with ELOOP (requires O_NOFOLLOW)', () => {
    // The assertion the plan names: `O_RDONLY | O_NOFOLLOW` meeting a link at
    // the final component is reported as ELOOP — "too many symbolic links" —
    // and the errno is left as the platform's own so a caller can tell it
    // apart from ENOENT and EACCES. Without `O_NOFOLLOW` this read would
    // silently return the content of whatever the link points at, which for a
    // backup or a credential is another file's content presented as ours.
    const victim = makeFile(join(sandbox, 'victim.txt'), 'another file\n');
    const target = join(sandbox, 'backup.bin');
    symlinkSync(victim, target);

    const code = runtimeErrnoFrom(() => {
      readFileNoFollow(target);
    });

    expect(code).toBe('ELOOP');
  });

  it('lets ENOENT through for a file that does not exist', () => {
    const code = runtimeErrnoFrom(() => {
      readFileNoFollow(join(sandbox, 'absent.bin'));
    });

    expect(code).toBe('ENOENT');
  });

  it('lets the runtime errno through for a directory', () => {
    const target = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);

    const code = runtimeErrnoFrom(() => {
      readFileNoFollow(target);
    });

    expect(['EISDIR', 'EACCES']).toContain(code);
  });
});
