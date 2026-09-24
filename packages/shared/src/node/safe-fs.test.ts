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
 *   Two of the four guards probe an *effective* capability rather than the
 *   presence of a platform feature, because that is what their cases need and
 *   no constant can answer it. Planting a symbolic link is a privilege on
 *   Windows and can be withheld by a hardened runner anywhere, and handing a
 *   directory to another account is a privilege everywhere — so each is tried
 *   once, in a directory of its own, and the result gates the cases that build
 *   that fixture. This is the same habit, not an exception to it: the question
 *   asked is still "can this host do the thing", never "which host is this" or
 *   "which uid is this", and a host that can do it runs the case.
 *
 * Payloads are short, obviously synthetic text or explicit byte arrays. The
 * case that stands in for the credential file writes a two-field JSON object
 * with no credential in it, because a realistic-looking secret in a committed
 * test is still a secret in the repository.
 */

import {
  chmodSync,
  chownSync,
  constants,
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DebuggenError } from '../errors.js';
import { isWithin, resolveWithinProject, toProjectRelative } from '../paths.js';
import { isErr, isOk, type Result } from '../result.js';
import {
  SECURE_DIR_MODE,
  SECURE_FILE_MODE,
  assertSecureDir,
  atomicReplaceFile,
  atomicReplaceFileIfUnchanged,
  createFileExclusive,
  ensureSecureDir,
  inspectPrivateFileNoFollow,
  isSameFileIdentity,
  pinFileWithinRoot,
  readFileNoFollow,
  readFileSnapshotNoFollow,
  writeSecureFileAtomic,
  type PrivateFileState,
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

/**
 * Whether this process can create a symbolic link at all.
 *
 * Every refusal this module makes about a link needs a link to exist first, and
 * creating one is not a given: Windows requires either developer mode or the
 * privilege, and a hardened or containerised runner can withhold it anywhere.
 * An unguarded `symlinkSync` in a fixture turns that into a *setup* failure,
 * which reads as "safe-fs is broken" rather than "this host cannot host the
 * case" — so the capability is probed once, in a directory of its own, and the
 * answer gates every symlink-dependent case below.
 *
 * A dangling link is enough to answer the question, and cheaper: it needs no
 * target, and `lstat` reporting it as a link is the confirmation that the call
 * did what it claimed rather than, say, copying the target on a filesystem that
 * emulates links.
 */
const CAN_CREATE_SYMLINKS = ((): boolean => {
  const probeRoot = mkdtempSync(join(tmpdir(), 'debuggen-safefs-probe-'));
  try {
    symlinkSync(join(probeRoot, 'absent'), join(probeRoot, 'link'));
    return lstatSync(join(probeRoot, 'link')).isSymbolicLink();
  } catch {
    // Any failure is the answer: no link could be planted, so the cases that
    // need one are skipped rather than failed.
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

/**
 * A uid that is conventionally not the one running a build: the traditional
 * `nobody`/`nfsnobody` account.
 *
 * Only ever used as a *number*. Nothing below looks the account up, requires it
 * to exist as a name, or cares which account it is — the ownership tests need
 * one thing from it, that it is not this process's uid, and the probe below
 * confirms the kernel agreed to assign it before any case relies on it.
 */
const CONVENTIONAL_FOREIGN_UID = 65534;

/**
 * A second candidate, for the unlikely host where this process *is* the uid
 * above.
 *
 * `1` is `daemon` on essentially every POSIX system and, like the first
 * candidate, is used only as a number.
 */
const ALTERNATE_FOREIGN_UID = 1;

/**
 * A uid this process can actually assign to a directory, or `undefined` when it
 * cannot assign any.
 *
 * Handing a directory to another account normally requires privilege, so this
 * is the one guard in the file that probes an *effective* capability rather
 * than the presence of a platform feature — and that is deliberate, not a
 * departure from the habit stated in this file's header. The habit is that a
 * case is skipped for what the host cannot do, never for what it is called or
 * for the value of its uid; "can this process assign a foreign owner" is
 * exactly that capability, and it is the only way to build the fixture the
 * ownership cases need. The AAP's test table requires parent **ownership**
 * rejection to be proven, not only the permission bits, and an owner test can
 * only be proven by a directory that really belongs to someone else.
 *
 * The probe runs in a directory of its own, confirms with `lstat` that the
 * owner changed rather than trusting the call, and removes its fixture. The
 * chowned directory is nested inside a root this process keeps, so the removal
 * works even though the entry itself now belongs to another account.
 */
const FOREIGN_UID = ((): number | undefined => {
  if (typeof process.getuid !== 'function') {
    return undefined;
  }

  const processUid = process.getuid();
  const probeRoot = mkdtempSync(join(tmpdir(), 'debuggen-safefs-probe-'));
  try {
    for (const candidate of [CONVENTIONAL_FOREIGN_UID, ALTERNATE_FOREIGN_UID]) {
      if (candidate === processUid) {
        continue;
      }

      const probeDir = join(probeRoot, `owned-${String(candidate)}`);
      mkdirSync(probeDir);
      try {
        chownSync(probeDir, candidate, lstatSync(probeDir).gid);
      } catch {
        // No privilege for this candidate; try the next, then give up.
        continue;
      }

      if (lstatSync(probeDir).uid === candidate) {
        return candidate;
      }
    }

    return undefined;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

/** Whether this process can hand a directory to another account at all. */
const CAN_ASSIGN_FOREIGN_OWNER = FOREIGN_UID !== undefined;

/**
 * Whether a directory's permission bits actually deny this process a write.
 *
 * They do not for a privileged account — root writes through a `0500`
 * directory — and continuous integration commonly runs as root, so a case whose
 * subject is the *failure* of a write guards on this rather than asserting
 * something that silently becomes vacuous.
 *
 * Every case that guards on this has a companion that provokes the same failure
 * without a mode bit and therefore runs on every account (see
 * {@link withInjectedFs}): the guard buys the real-permissions variant on an
 * unprivileged host, it is never the only coverage of the contract.
 */
const MODE_DENIES_WRITE = typeof process.getuid === 'function' && process.getuid() !== 0;

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

/**
 * Hands `pathAbs` to another account, and proves the kernel did it.
 *
 * The `lstat` is the assertion that makes the fixture worth building: a `chown`
 * that silently did nothing would leave a directory this account still owns,
 * and every ownership case below would then pass for the wrong reason — the
 * owner test it is meant to exercise would simply never fire. The group is
 * carried over unchanged, so the only thing the case changes is the owner.
 *
 * Callable only from a case guarded by {@link CAN_ASSIGN_FOREIGN_OWNER}; the
 * unreachable branch is what turns a missing guard into an explicit failure
 * rather than a confusing `chown` errno.
 */
function assignForeignOwner(pathAbs: string): number {
  if (FOREIGN_UID === undefined) {
    return expect.unreachable(
      'this case must be guarded on CAN_ASSIGN_FOREIGN_OWNER, which is false on this host',
    );
  }

  chownSync(pathAbs, FOREIGN_UID, lstatSync(pathAbs).gid);
  expect(lstatSync(pathAbs).uid).toBe(FOREIGN_UID);
  return FOREIGN_UID;
}

/** This process's own uid, for the `expectedOwner` half of an ownership refusal. */
function ownUid(): number {
  if (typeof process.getuid !== 'function') {
    return expect.unreachable(
      'this case must be guarded on NO_POSIX_IDS, which is true on this host',
    );
  }
  return process.getuid();
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
 * What the module's temporary names end with.
 *
 * It names them `.<target>.<pid>.<random>.tmp`, so the extension is what
 * identifies one — both for the leftover audit below and for the injected
 * failure above, which has to recognise the temporary sibling to fail it and
 * nothing else.
 */
const TEMPORARY_SUFFIX = '.tmp';

/**
 * The temporary siblings left in a directory by an atomic write.
 *
 * `readdir` lists dotted entries, so a cleanup path that stopped running would
 * show up here rather than being invisible.
 */
function temporaryLeftoversIn(dirAbs: string): string[] {
  return entriesIn(dirAbs).filter((entry) => entry.endsWith(TEMPORARY_SUFFIX));
}

/**
 * A state tree whose intermediate component has been replaced by a link out of
 * the tree, and the directory that link points at.
 *
 * This is the shape of the attack the creation walk exists to stop: the root is
 * private and owned by this account, but one component below it is a symbolic
 * link to a directory another local account controls. A creation pass that
 * hands the whole path to the kernel creates the missing tail *inside* that
 * directory, because every non-final component of a path is resolved through
 * its links.
 *
 * The outside directory is deliberately left at an ordinary `0755` and given
 * one entry, so two properties can be asserted after a refusal: that its mode
 * was not tightened through the link, and that its contents are exactly what
 * this fixture put there.
 */
interface LinkedComponentFixture {
  /** The private root a caller would name as its boundary. */
  readonly root: string;

  /** The intermediate component, a symbolic link rather than a directory. */
  readonly link: string;

  /** The directory the link points at, outside the root entirely. */
  readonly outside: string;

  /** The single entry the fixture placed in {@link outside}. */
  readonly outsideEntry: string;
}

/**
 * Builds the {@link LinkedComponentFixture} tree inside the current sandbox.
 *
 * Plants a link, so every case that calls it is guarded by
 * {@link CAN_CREATE_SYMLINKS}.
 */
function plantLinkedComponent(): LinkedComponentFixture {
  const root = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);
  const outside = makeDir(join(sandbox, 'elsewhere'), PROJECT_DIR_MODE);
  const outsideEntry = 'present.txt';
  makeFile(join(outside, outsideEntry), 'placed by the fixture\n');
  const link = join(root, 'backups');
  symlinkSync(outside, link);

  return { root, link, outside, outsideEntry };
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

/**
 * Runs `use` against a freshly imported copy of this module whose `node:fs` has
 * the given overrides merged over the real one.
 *
 * Why it exists: the cases whose subject is the *failure* of a syscall cannot
 * provoke one with a permission bit on a privileged account — root writes
 * through a `0500` directory, and continuous integration commonly runs as root,
 * so those cases guard on {@link MODE_DENIES_WRITE} and assert nothing there.
 * Injecting the failure instead asserts the same propagation contract on every
 * account, which makes the mode-based cases a second opinion on an unprivileged
 * host rather than the only coverage a fail-closed path has.
 *
 * Two properties make it safe to use in the middle of this file:
 * - The replacement reaches the module under test, not this one. Every helper
 *   above holds a binding resolved when this file loaded, so they keep the real
 *   filesystem and can still build a fixture and inspect it afterwards.
 * - The module registry is reset before the import, so `use` receives a copy
 *   built against the injected module rather than the cached real one, and
 *   reset again afterwards — whether `use` passed or threw — so the next case
 *   imports the genuine module.
 *
 * The override is written as a function of the real module so a wrapper can
 * delegate to the real implementation for every input it does not fail, which
 * is what keeps the injection narrow: one syscall on one path, everything else
 * genuinely performed.
 *
 * @param overrides Receives the real `node:fs`, returns what to replace on it.
 * @param use Receives the freshly imported copy of this module.
 */
async function withInjectedFs(
  overrides: (real: typeof import('node:fs')) => Partial<typeof import('node:fs')>,
  use: (injected: typeof import('./safe-fs.js')) => void,
): Promise<void> {
  vi.resetModules();
  vi.doMock('node:fs', async () => {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    return { ...real, ...overrides(real) };
  });

  try {
    use(await import('./safe-fs.js'));
  } finally {
    vi.doUnmock('node:fs');
    vi.resetModules();
  }
}

/**
 * An `openSync` that refuses the temporary sibling of an atomic write and
 * performs every other open for real.
 *
 * The temporary name is what a `0500` directory refuses first, so failing it is
 * the same failure the guarded permissions cases provoke — and failing *only*
 * it is what keeps the case meaningful: an `openSync` that failed everything
 * would also break the snapshot read the precondition is built from, and the
 * case would then prove nothing about the write.
 *
 * @param real The genuine `node:fs`, used for every other path.
 * @param code The errno to raise, matching what the kernel would report.
 * @returns A drop-in replacement for `openSync`.
 */
function openSyncFailingTemporaries(
  real: typeof import('node:fs'),
  code: 'EACCES' | 'ENOSPC',
): typeof real.openSync {
  return (...args: Parameters<typeof real.openSync>): number => {
    const [path] = args;
    if (typeof path === 'string' && path.endsWith(TEMPORARY_SUFFIX)) {
      throw Object.assign(new Error(`${code}: injected failure, open '${path}'`), {
        code,
        syscall: 'open',
        path,
      });
    }
    return real.openSync(...args);
  };
}

/**
 * The value of a `Result` the lexical gate in `../paths.js` was expected to
 * accept.
 *
 * `isOk` rather than a cast, so a guard that stopped narrowing fails
 * `pnpm typecheck` in this file — the same habit `../paths.test.ts` keeps, and
 * the reason the escape block below can read the resolved path at all.
 */
function acceptedPath(result: Result<string>): string {
  if (isOk(result)) {
    return result.value;
  }
  return expect.unreachable(
    `the lexical gate was expected to accept this path: ${result.error.message}`,
  );
}

/** The `DebuggenError` of a `Result` the lexical gate was expected to refuse. */
function refusedBy(result: Result<string>): DebuggenError {
  if (isErr(result)) {
    return result.error;
  }
  return expect.unreachable('the lexical gate was expected to refuse this path, and accepted it');
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

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a directory that is itself a symbolic link instead of resolving it (requires symlink creation)',
    () => {
      const target = makeDir(join(sandbox, 'real'), SECURE_DIR_MODE);
      const link = join(sandbox, 'link');
      symlinkSync(target, link);

      const error = unsafePathErrorFrom(() => {
        assertSecureDir(link);
      });

      expect(error.details?.path).toBe(link);
      expect(error.details?.reason).toBe('symlink-component');
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a chain whose parent contains a symbolic link, however private its target (requires symlink creation)',
    () => {
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
      // that used `stat` instead of `lstat` would accept the path above, which
      // is exactly the substitution this case exists to catch.
      expect(() => {
        assertSecureDir(inner, { upTo: root });
      }).not.toThrow();
    },
  );

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

  /*
   * The ownership cases. A directory at a perfect 0700 that belongs to another
   * account is the failure mode the permission-bit cases above cannot express:
   * its owner can move it, replace it, or replace anything inside it, so a
   * credential or a backup written beneath it is that account's to take. The
   * AAP requires wrong *ownership* to be rejected, not only a wrong mode, and
   * that can only be shown by a directory that really belongs to someone else.
   */

  it.skipIf(NO_POSIX_IDS || !CAN_ASSIGN_FOREIGN_OWNER)(
    'rejects an otherwise-private directory owned by another account (requires assigning a foreign owner)',
    () => {
      const dir = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);
      const foreignUid = assignForeignOwner(dir);

      const error = unsafePathErrorFrom(() => {
        assertSecureDir(dir);
      });

      // The mode is impeccable, so `group-or-other-permissions` here would mean
      // the owner test never ran.
      expect(permissionsOf(dir)).toBe(SECURE_DIR_MODE);
      expect(error.details?.reason).toBe('foreign-owner');
      expect(error.details?.path).toBe(dir);
      expect(error.message).toContain(dir);
      // Both uids, because the developer's next question is "whose is it, and
      // who did the tool expect?" and an error that answers neither sends them
      // to `ls -l`.
      expect(error.details?.owner).toBe(foreignUid);
      expect(error.details?.expectedOwner).toBe(ownUid());
    },
  );

  it.skipIf(NO_POSIX_IDS || !CAN_ASSIGN_FOREIGN_OWNER)(
    'accepts that same foreign-owned directory when requireOwner is false (requires assigning a foreign owner)',
    () => {
      // The other half of the relaxation, which the permission-bit case above
      // cannot reach: `requireOwner: false` must switch off the owner test and
      // nothing else. A container whose mount belongs to another uid is the
      // real caller of this option.
      const dir = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);
      assignForeignOwner(dir);

      expect(() => {
        assertSecureDir(dir, { requireOwner: false });
      }).not.toThrow();
    },
  );

  it.skipIf(NO_POSIX_IDS || !CAN_ASSIGN_FOREIGN_OWNER)(
    'names the foreign-owned intermediate directory of a chain (requires assigning a foreign owner)',
    () => {
      const root = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);
      const middle = makeDir(join(root, 'backups'), SECURE_DIR_MODE);
      const leaf = makeDir(join(middle, 'one'), SECURE_DIR_MODE);
      assignForeignOwner(middle);

      // Named alone the leaf is ours and private, so a check that stopped there
      // would approve a tree whose middle another account can replace.
      expect(() => {
        assertSecureDir(leaf);
      }).not.toThrow();

      const error = unsafePathErrorFrom(() => {
        assertSecureDir(leaf, { upTo: root });
      });

      expect(error.details?.path).toBe(middle);
      expect(error.details?.reason).toBe('foreign-owner');
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

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses to tighten a symbolic link in the chain (requires symlink creation)',
    () => {
      const root = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);
      const outside = makeDir(join(sandbox, 'outside'), PROJECT_DIR_MODE);
      const link = join(root, 'link');
      symlinkSync(outside, link);

      const error = unsafePathErrorFrom(() => {
        ensureSecureDir(link, { upTo: root });
      });

      expect(error.details?.path).toBe(link);
      expect(error.details?.reason).toBe('symlink-component');
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS || NO_POSIX_IDS)(
    'leaves the mode of a link target untouched when it refuses the link (requires symlink creation and POSIX permission bits)',
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

  /*
   * The intermediate-symlink cases. A single recursive `mkdir` over the whole
   * path cannot express these: the kernel resolves every non-final component
   * through its links, so the missing tail is created inside whatever the link
   * points at and only then is the chain inspected. A refusal that arrives
   * after the directory exists outside the tree is not a refusal — the next
   * write into it succeeds — which is why each case below asserts the *absence*
   * of the created directory as well as the error.
   */

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses an intermediate symbolic link under upTo and creates nothing through it (requires symlink creation)',
    () => {
      const { root, link, outside, outsideEntry } = plantLinkedComponent();

      const error = unsafePathErrorFrom(() => {
        ensureSecureDir(join(root, 'backups', 'one'), { upTo: root });
      });

      expect(error.details?.path).toBe(link);
      expect(error.details?.reason).toBe('symlink-component');

      // The security property, which the error alone does not carry: the walk
      // stopped at the link instead of creating the tail behind it.
      expect(entriesIn(outside)).toEqual([outsideEntry]);
      expect(existsSync(join(outside, 'one'))).toBe(false);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses an intermediate symbolic link with no upTo and creates nothing through it (requires symlink creation)',
    () => {
      // The harder half. With no boundary the chain a creation pass verifies is
      // derived from what it created, so a pass that created the tail inside the
      // link's target verifies only that tail — every component it checks is
      // private and owned, and the call returns successfully with a directory
      // sitting outside the tree.
      const { root, link, outside, outsideEntry } = plantLinkedComponent();

      const error = unsafePathErrorFrom(() => {
        ensureSecureDir(join(root, 'backups', 'one'));
      });

      expect(error.details?.path).toBe(link);
      expect(error.details?.reason).toBe('symlink-component');
      expect(entriesIn(outside)).toEqual([outsideEntry]);
      expect(existsSync(join(outside, 'one'))).toBe(false);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'stops at the link rather than at the first missing component of a deeper tail under upTo (requires symlink creation)',
    () => {
      const { root, link, outside, outsideEntry } = plantLinkedComponent();

      const error = unsafePathErrorFrom(() => {
        ensureSecureDir(join(root, 'backups', 'one', 'two'), { upTo: root });
      });

      // Two components are missing, so a walk that began at the outermost
      // *missing* one would start below the link and never see it.
      expect(error.details?.path).toBe(link);
      expect(error.details?.reason).toBe('symlink-component');
      expect(entriesIn(outside)).toEqual([outsideEntry]);
      expect(existsSync(join(outside, 'one'))).toBe(false);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'stops at the link rather than at the first missing component of a deeper tail with no upTo (requires symlink creation)',
    () => {
      const { root, link, outside, outsideEntry } = plantLinkedComponent();

      const error = unsafePathErrorFrom(() => {
        ensureSecureDir(join(root, 'backups', 'one', 'two'));
      });

      expect(error.details?.path).toBe(link);
      expect(error.details?.reason).toBe('symlink-component');
      expect(entriesIn(outside)).toEqual([outsideEntry]);
      expect(existsSync(join(outside, 'one'))).toBe(false);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a link whose target already holds the next component, with no upTo, and creates nothing through it (requires symlink creation)',
    () => {
      // The shape that survives a walk which trusts "the deepest path whose
      // `lstat` succeeds". `lstat` resolves *interior* components, so with a
      // directory already sitting inside the link's target the deepest
      // succeeding path is that directory — below the link — and a walk that
      // starts there never sees the link at all. Only the tail is then created,
      // verified, and reported as private, outside the tree.
      const { root, link, outside, outsideEntry } = plantLinkedComponent();
      const beyond = makeDir(join(outside, 'existing'), SECURE_DIR_MODE);

      const error = unsafePathErrorFrom(() => {
        ensureSecureDir(join(root, 'backups', 'existing', 'created'));
      });

      expect(error.details?.path).toBe(link);
      expect(error.details?.reason).toBe('symlink-component');
      expect(existsSync(join(beyond, 'created'))).toBe(false);
      expect(entriesIn(beyond)).toEqual([]);
      expect(entriesIn(outside).sort()).toEqual(['existing', outsideEntry].sort());
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a link whose target already holds the named directory itself, with no upTo (requires symlink creation)',
    () => {
      // The same shape with nothing left to create: the named directory already
      // exists behind the link, so the only act left is the tightening pass —
      // and tightening a directory outside the tree is a permission change the
      // product was never asked for, which makes the refusal as necessary here
      // as it is for a creation.
      const { root, link, outside } = plantLinkedComponent();
      makeDir(join(outside, 'existing'), PROJECT_DIR_MODE);

      const error = unsafePathErrorFrom(() => {
        ensureSecureDir(join(root, 'backups', 'existing'));
      });

      expect(error.details?.path).toBe(link);
      expect(error.details?.reason).toBe('symlink-component');
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS || NO_POSIX_IDS)(
    'changes no mode outside the tree when an intermediate link already holds the named directory (requires symlink creation and POSIX permission bits)',
    () => {
      const { root, outside } = plantLinkedComponent();
      const beyond = makeDir(join(outside, 'existing'), PROJECT_DIR_MODE);

      unsafePathErrorFrom(() => {
        ensureSecureDir(join(root, 'backups', 'existing'));
      });

      // `0755` is the mode a directory outside the product's tree legitimately
      // carries. A pass that reached it through the link would have made it
      // owner-only — invisible to the developer, and not something this module
      // can undo.
      expect(permissionsOf(beyond)).toBe(PROJECT_DIR_MODE);
      expect(permissionsOf(outside)).toBe(PROJECT_DIR_MODE);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a link whose target already holds the next component under upTo (requires symlink creation)',
    () => {
      // The declared-boundary form of the two cases above, so the symmetry is
      // pinned: a boundary must not make the walk any more willing to descend
      // through a link than it is without one.
      const { root, link, outside } = plantLinkedComponent();
      const beyond = makeDir(join(outside, 'existing'), SECURE_DIR_MODE);

      const error = unsafePathErrorFrom(() => {
        ensureSecureDir(join(root, 'backups', 'existing', 'created'), { upTo: root });
      });

      expect(error.details?.path).toBe(link);
      expect(error.details?.reason).toBe('symlink-component');
      expect(entriesIn(beyond)).toEqual([]);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS || NO_POSIX_IDS)(
    'leaves the mode of the directory an intermediate link points at untouched (requires symlink creation and POSIX permission bits)',
    () => {
      // `chmod` follows a link. A tightening pass that walked *through* the
      // intermediate link would make a directory another account owns
      // owner-only, which is a permission change the product was never asked
      // for and cannot undo.
      const { root, outside } = plantLinkedComponent();

      unsafePathErrorFrom(() => {
        ensureSecureDir(join(root, 'backups', 'one'), { upTo: root });
      });

      expect(permissionsOf(outside)).toBe(PROJECT_DIR_MODE);
    },
  );

  /*
   * The two sides of the boundary rule, pinned because the function's
   * documentation promises them. Without a boundary the whole existing prefix
   * must be literal — the function has no declaration to rely on and cannot
   * tell a long-standing link from one planted a second ago. With a boundary
   * the caller has declared the subtree it owns, so a link above that
   * declaration is the caller's business, and the escape hatch for the strict
   * case is to resolve the path once and pass the result.
   */

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a path reached through a symbolic link anywhere above it when no boundary is declared (requires symlink creation)',
    () => {
      const real = makeDir(join(sandbox, 'real-home'), SECURE_DIR_MODE);
      const linked = join(sandbox, 'home');
      symlinkSync(real, linked);

      const error = unsafePathErrorFrom(() => {
        ensureSecureDir(join(linked, 'state', 'backups'));
      });

      expect(error.details?.path).toBe(linked);
      expect(error.details?.reason).toBe('symlink-component');
      expect(existsSync(join(real, 'state'))).toBe(false);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS || NO_POSIX_IDS)(
    'accepts the same path once the caller has resolved it, the documented way past a linked ancestor (requires symlink creation and POSIX permission bits)',
    () => {
      const real = makeDir(join(sandbox, 'real-home'), SECURE_DIR_MODE);
      const linked = join(sandbox, 'home');
      symlinkSync(real, linked);

      // `fs.realpathSync` is what the refusal above tells a caller to do, so
      // the result of doing it has to work — otherwise the strictness has no
      // way out and a legitimate layout becomes unusable.
      const leaf = join(realpathSync(linked), 'state', 'backups');
      ensureSecureDir(leaf);

      expect(permissionsOf(leaf)).toBe(SECURE_DIR_MODE);
      expect(permissionsOf(join(real, 'state'))).toBe(SECURE_DIR_MODE);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS || NO_POSIX_IDS)(
    'verifies only the declared subtree when upTo is given, so a link above the boundary stays the caller declaration (requires symlink creation and POSIX permission bits)',
    () => {
      const real = makeDir(join(sandbox, 'real-home'), SECURE_DIR_MODE);
      const linked = join(sandbox, 'home');
      symlinkSync(real, linked);
      // The boundary already exists, so nothing is created inside the link and
      // the walk starts at a directory it can inspect directly.
      const declaredRoot = makeDir(join(real, 'state'), SECURE_DIR_MODE);

      ensureSecureDir(join(linked, 'state', 'backups'), { upTo: join(linked, 'state') });

      // The asymmetry, asserted rather than assumed: this succeeded, and what
      // it created is the directory the resolved path names.
      expect(permissionsOf(join(declaredRoot, 'backups'))).toBe(SECURE_DIR_MODE);
      expect(entriesIn(declaredRoot)).toEqual(['backups']);
    },
  );

  it.skipIf(NO_POSIX_IDS || !CAN_ASSIGN_FOREIGN_OWNER)(
    'refuses an existing component owned by another account and creates nothing beneath it (requires assigning a foreign owner)',
    () => {
      // The descent checks ownership *before* it tightens or enters a component
      // that already existed. Both halves of that order matter: a directory
      // another account owns cannot be `chmod`-ed by us at all, and creating the
      // product's own subtree inside it would leave that subtree — backups, the
      // session store — inside a directory its owner can swap out at will.
      const root = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);
      const handedOver = makeDir(join(root, 'backups'), SECURE_DIR_MODE);
      const leaf = join(handedOver, 'one');
      const foreignUid = assignForeignOwner(handedOver);

      const error = unsafePathErrorFrom(() => {
        ensureSecureDir(leaf, { upTo: root });
      });

      expect(error.details?.path).toBe(handedOver);
      expect(error.details?.reason).toBe('foreign-owner');
      expect(error.details?.owner).toBe(foreignUid);
      expect(existsSync(leaf)).toBe(false);
      expect(entriesIn(handedOver)).toEqual([]);
    },
  );
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

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a planted symbolic link and leaves its target byte-for-byte unchanged (requires symlink creation)',
    () => {
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
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a dangling symbolic link rather than creating what it points at (requires symlink creation)',
    () => {
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
    },
  );

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

  it.skipIf(NO_POSIX_IDS || !CAN_ASSIGN_FOREIGN_OWNER)(
    'refuses a parent owned by another account and creates nothing (requires assigning a foreign owner)',
    () => {
      // The parent is 0700, so nothing about its mode is wrong; what is wrong
      // is that its owner can replace it — and therefore replace the file about
      // to be written into it — between this check and any later read. A
      // privileged process would be *allowed* to write here, which is why the
      // refusal has to come from the module's policy rather than from the
      // kernel.
      const parent = makeDir(join(sandbox, 'state'), SECURE_DIR_MODE);
      const target = join(parent, 'auth.json');
      const foreignUid = assignForeignOwner(parent);

      const error = unsafePathErrorFrom(() => {
        createFileExclusive(target, '{"role":"editor","issuedAt":1}');
      });

      expect(error.details?.path).toBe(parent);
      expect(error.details?.reason).toBe('foreign-owner');
      expect(error.details?.owner).toBe(foreignUid);
      expect(existsSync(target)).toBe(false);
      expect(entriesIn(parent)).toEqual([]);
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

  it.skipIf(!CAN_CREATE_SYMLINKS || NO_NOFOLLOW)(
    'refuses a planted symbolic link with ELOOP (requires symlink creation and O_NOFOLLOW)',
    () => {
      // The assertion the plan names: `O_RDONLY | O_NOFOLLOW` meeting a link at
      // the final component is reported as ELOOP — "too many symbolic links" —
      // and the errno is left as the platform's own so a caller can tell it
      // apart from ENOENT and EACCES. Without `O_NOFOLLOW` this read would
      // silently return the content of whatever the link points at, which for a
      // backup or a credential is another file's content presented as ours.
      //
      // Both guards are needed and neither implies the other: the `O_NOFOLLOW`
      // one is here because the exact errno is this case's subject, and the
      // symlink one because the fixture cannot be built without planting a
      // link — a platform can have the flag and still refuse the plant.
      const victim = makeFile(join(sandbox, 'victim.txt'), 'another file\n');
      const target = join(sandbox, 'backup.bin');
      symlinkSync(victim, target);

      const code = runtimeErrnoFrom(() => {
        readFileNoFollow(target);
      });

      expect(code).toBe('ELOOP');
    },
  );

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

/*
 * ---------------------------------------------------------------------------
 * readFileSnapshotNoFollow
 * ---------------------------------------------------------------------------
 *
 * `readFileNoFollow` plus the inode the bytes came from. The identity is what
 * makes a later conditional write able to tell "the same file, unchanged" from
 * "a different file that happens to hold the same bytes" — which is what an
 * editor's save-by-rename produces.
 */

describe('readFileSnapshotNoFollow', () => {
  it('returns the stored bytes and the identity of the file they came from', () => {
    const target = makeFile(join(sandbox, 'source.ts'), NON_UTF8_BYTES);
    const stats = lstatSync(target, { bigint: true });

    const snapshot = readFileSnapshotNoFollow(target);

    expect(Buffer.compare(snapshot.bytes, NON_UTF8_BYTES)).toBe(0);
    // `bigint`, not `number`: an inode number past 2^53 rounds as a double, and
    // two different inodes comparing equal is the direction of that failure
    // that would make the write condition accept a swapped file.
    expect(typeof snapshot.identity.dev).toBe('bigint');
    expect(typeof snapshot.identity.ino).toBe('bigint');
    expect(snapshot.identity.dev).toBe(stats.dev);
    expect(snapshot.identity.ino).toBe(stats.ino);
  });

  it('refuses an entry that is not a regular file', () => {
    // Stated for the platform without `O_NOFOLLOW`, where the flag contributes
    // nothing and the refusal has to come from the stat instead.
    const target = makeDir(join(sandbox, 'directory'), SECURE_DIR_MODE);

    const code = runtimeErrnoFrom(() => {
      readFileSnapshotNoFollow(target);
    });

    expect(['ELOOP', 'EISDIR', 'EACCES']).toContain(code);
  });

  it('reports a different identity after the file is replaced by a rename', () => {
    // The case content comparison alone cannot see: same path, same bytes,
    // different inode - which is how every editor in this product's world
    // saves a file.
    const target = join(sandbox, 'source.ts');
    makeFile(target, 'export const a = 1;\n');
    const before = readFileSnapshotNoFollow(target);

    const replacement = makeFile(join(sandbox, 'replacement.ts'), 'export const a = 1;\n');
    renameSync(replacement, target);
    const after = readFileSnapshotNoFollow(target);

    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
    expect(after.identity.ino).not.toBe(before.identity.ino);
  });

  it.skipIf(!CAN_CREATE_SYMLINKS || NO_NOFOLLOW)(
    'refuses a planted symbolic link with ELOOP (requires symlink creation and O_NOFOLLOW)',
    () => {
      const victim = makeFile(join(sandbox, 'victim.txt'), 'another file\n');
      const target = join(sandbox, 'source.ts');
      symlinkSync(victim, target);

      const code = runtimeErrnoFrom(() => {
        readFileSnapshotNoFollow(target);
      });

      expect(code).toBe('ELOOP');
    },
  );

  it('lets ENOENT through for a file that does not exist', () => {
    const code = runtimeErrnoFrom(() => {
      readFileSnapshotNoFollow(join(sandbox, 'absent.ts'));
    });

    expect(code).toBe('ENOENT');
  });
});

/*
 * ---------------------------------------------------------------------------
 * atomicReplaceFileIfUnchanged
 * ---------------------------------------------------------------------------
 *
 * The conditional write. Every case here is about the same question: does the
 * developer's edit survive? An unconditional `rename` over a source file cannot
 * fail, so a write computed from bytes that are no longer there destroys work
 * silently - CWE-367. These cases pin the refusal, and pin that a refusal
 * leaves the directory exactly as it was found.
 */

describe('atomicReplaceFileIfUnchanged', () => {
  /** The content a target starts with in this block. */
  const ORIGINAL = 'export function work(): void {}\n';

  /** What a caller computed from {@link ORIGINAL} and wants to write. */
  const INSTRUMENTED = 'export function work(): void {\n  /* timed */\n}\n';

  it('writes when the target still holds the expected bytes', () => {
    const target = makeFile(join(sandbox, 'source.ts'), ORIGINAL, PROJECT_FILE_MODE);
    const before = readFileSnapshotNoFollow(target);

    const verdict = atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before);

    expect(verdict).toEqual({ kind: 'replaced' });
    expectFileBytes(target, INSTRUMENTED);
    expect(temporaryLeftoversIn(sandbox)).toEqual([]);
  });

  it('preserves the mode the target already had', () => {
    // The same guarantee `atomicReplaceFile` makes, and for the same reason: a
    // patch that turned an executable script into a plain file would be a
    // modification the product never recorded and cannot revert.
    const target = makeFile(join(sandbox, 'source.ts'), ORIGINAL, 0o751);
    const before = readFileSnapshotNoFollow(target);

    expect(atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before).kind).toBe('replaced');
    expect(octal(permissionsOf(target))).toBe(octal(0o751));
  });

  it('writes bytes verbatim, including content that is not valid UTF-8', () => {
    const target = makeFile(join(sandbox, 'source.bin'), ORIGINAL);
    const before = readFileSnapshotNoFollow(target);

    expect(atomicReplaceFileIfUnchanged(target, NON_UTF8_BYTES, before).kind).toBe('replaced');
    expectFileBytes(target, NON_UTF8_BYTES);
  });

  it('refuses and writes nothing when the content changed after it was read', () => {
    // The developer's edit, arriving between the read and the write. It must
    // still be there afterwards.
    const target = makeFile(join(sandbox, 'source.ts'), ORIGINAL, PROJECT_FILE_MODE);
    const before = readFileSnapshotNoFollow(target);

    const developerEdit = `${ORIGINAL}// edited while instrumented\n`;
    makeFile(target, developerEdit);

    const verdict = atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before);

    expect(verdict).toEqual({ kind: 'stale', reason: 'content-changed' });
    expectFileBytes(target, developerEdit);
    expect(temporaryLeftoversIn(sandbox)).toEqual([]);
  });

  it('refuses when a different file with identical content took the path', () => {
    // Content alone cannot see this: an editor that saves by writing a
    // temporary file and renaming it over the target produces exactly this
    // shape, and the bytes may well be identical.
    const target = makeFile(join(sandbox, 'source.ts'), ORIGINAL);
    const before = readFileSnapshotNoFollow(target);

    renameSync(makeFile(join(sandbox, 'other.ts'), ORIGINAL), target);

    const verdict = atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before);

    expect(verdict).toEqual({ kind: 'stale', reason: 'identity-changed' });
    expectFileBytes(target, ORIGINAL);
  });

  it('refuses when the target has been removed', () => {
    const target = makeFile(join(sandbox, 'source.ts'), ORIGINAL);
    const before = readFileSnapshotNoFollow(target);

    rmSync(target);

    expect(atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before)).toEqual({
      kind: 'stale',
      reason: 'target-missing',
    });
    expect(existsSync(target)).toBe(false);
    expect(temporaryLeftoversIn(sandbox)).toEqual([]);
  });

  it('refuses to create a file that is not there, rather than writing one', () => {
    // A precondition about content has no meaning for a file that does not
    // exist, and creating one would be a modification with no recorded
    // original to restore.
    const target = join(sandbox, 'absent.ts');

    expect(
      atomicReplaceFileIfUnchanged(target, INSTRUMENTED, { bytes: bytesOf(ORIGINAL) }),
    ).toEqual({ kind: 'stale', reason: 'target-missing' });
    expect(existsSync(target)).toBe(false);
  });

  it('compares content alone when the caller observed no identity', () => {
    const target = makeFile(join(sandbox, 'source.ts'), ORIGINAL);

    // Same path, same bytes, new inode: accepted, because the caller did not
    // claim to know which file it read.
    renameSync(makeFile(join(sandbox, 'other.ts'), ORIGINAL), target);

    expect(
      atomicReplaceFileIfUnchanged(target, INSTRUMENTED, { bytes: bytesOf(ORIGINAL) }).kind,
    ).toBe('replaced');
    expectFileBytes(target, INSTRUMENTED);
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses when a symbolic link took the target path, and the file it points at is untouched (requires symlink creation)',
    () => {
      // `rename` replaces a path entry, so an unconditional replacement would
      // quietly swap the link for a regular file. Refusing instead keeps the
      // developer's tree as it was found and leaves the decision to them.
      const target = join(sandbox, 'source.ts');
      makeFile(target, ORIGINAL);
      const before = readFileSnapshotNoFollow(target);

      const victim = makeFile(join(sandbox, 'victim.txt'), 'another file\n');
      rmSync(target);
      symlinkSync(victim, target);

      const verdict = atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before);

      expect(verdict).toEqual({ kind: 'stale', reason: 'identity-changed' });
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expectFileBytes(victim, 'another file\n');
      expect(temporaryLeftoversIn(sandbox)).toEqual([]);
    },
  );

  it('refuses when a directory took the target path', () => {
    const target = join(sandbox, 'source.ts');
    makeFile(target, ORIGINAL);
    const before = readFileSnapshotNoFollow(target);

    rmSync(target);
    makeDir(target, PROJECT_DIR_MODE);

    expect(atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before)).toEqual({
      kind: 'stale',
      reason: 'identity-changed',
    });
    expect(lstatSync(target).isDirectory()).toBe(true);
  });

  it('replaces a large payload in full', () => {
    const payload = syntheticBytes(LARGE_PAYLOAD_LENGTH);
    const target = makeFile(join(sandbox, 'source.bin'), ORIGINAL);
    const before = readFileSnapshotNoFollow(target);

    expect(atomicReplaceFileIfUnchanged(target, payload, before).kind).toBe('replaced');
    expectFileBytes(target, payload);
  });

  it('is a no-op the second time, because the first write replaced the file it named', () => {
    // Replaying a conditional write is safe by construction, and the reason it
    // reports is worth pinning: the replacement is a `rename`, so the entry at
    // that path is a new inode afterwards and the identity half of the
    // condition answers before the content half is consulted.
    const target = makeFile(join(sandbox, 'source.ts'), ORIGINAL);
    const before = readFileSnapshotNoFollow(target);

    expect(atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before).kind).toBe('replaced');
    expect(atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before)).toEqual({
      kind: 'stale',
      reason: 'identity-changed',
    });
    expectFileBytes(target, INSTRUMENTED);

    // Content only, so that the same replay is pinned for a caller that
    // observed no identity: the bytes it named are no longer there.
    expect(atomicReplaceFileIfUnchanged(target, INSTRUMENTED, { bytes: before.bytes })).toEqual({
      kind: 'stale',
      reason: 'content-changed',
    });
  });

  it('restores the original bytes when handed the instrumented ones as the condition', () => {
    // The reverse direction, which is what a cleanup pass performs: the file
    // must hold what the record says it holds before it is restored.
    const target = makeFile(join(sandbox, 'source.ts'), ORIGINAL, PROJECT_FILE_MODE);
    const before = readFileSnapshotNoFollow(target);

    expect(atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before).kind).toBe('replaced');

    const instrumented = readFileSnapshotNoFollow(target);
    expect(atomicReplaceFileIfUnchanged(target, ORIGINAL, instrumented).kind).toBe('replaced');

    expectFileBytes(target, ORIGINAL);
    expect(octal(permissionsOf(target))).toBe(octal(PROJECT_FILE_MODE));
  });

  it('refuses a file created at the target after the displaced entry was retained', () => {
    // The interval the install exists for: the precondition has held, the old
    // entry has been retained, and only then does something appear at the
    // target. `link` refuses to overwrite it, so the newcomer survives and the
    // caller is told - which is the difference between this protocol and
    // compare-then-rename.
    const target = makeFile(join(sandbox, 'source.ts'), ORIGINAL);
    const before = readFileSnapshotNoFollow(target);
    const newcomer = '// written after the retention\n';

    const verdict = atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before, {
      onBeforeInstall: () => {
        writeFileSync(target, newcomer);
      },
    });

    expect(verdict).toEqual({ kind: 'stale', reason: 'identity-changed' });
    expectFileBytes(target, newcomer);
    expect(temporaryLeftoversIn(sandbox)).toEqual([]);
  });

  it('installs normally when nothing appears at the target during the interval', () => {
    // The control for the case above: the seam must not be what makes the
    // refusal happen.
    const target = makeFile(join(sandbox, 'source.ts'), ORIGINAL);
    const before = readFileSnapshotNoFollow(target);
    let reached = false;

    const verdict = atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before, {
      onBeforeInstall: () => {
        reached = true;
      },
    });

    expect(reached).toBe(true);
    expect(verdict).toEqual({ kind: 'replaced' });
    expectFileBytes(target, INSTRUMENTED);
    expect(temporaryLeftoversIn(sandbox)).toEqual([]);
  });

  it('installs a single-named entry, leaving no hard link to the temporary name', () => {
    // The install is a `link`, so the new entry starts with two names. The
    // temporary one has to be dropped, or every patched file would carry a
    // second, hidden name in the developer's project.
    const target = makeFile(join(sandbox, 'source.ts'), ORIGINAL);
    const before = readFileSnapshotNoFollow(target);

    expect(atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before).kind).toBe('replaced');

    expect(lstatSync(target).nlink).toBe(1);
    expect(entriesIn(sandbox)).toEqual(['source.ts']);
  });

  it('lets an injected I/O failure through rather than reporting it as stale', async () => {
    // The same contract as the guarded case below, asserted on every account
    // including root: a `stale` verdict means "nothing was written", so a write
    // that could not be performed must surface as the runtime's own error and
    // never be collapsed into a conflict report to the developer.
    //
    // The failure is injected at the exclusive create of the temporary sibling
    // — the first syscall a `0500` directory refuses — so this case exercises
    // the same branch the permissions case does, on a host where a mode bit
    // asserts nothing. The fixture and every assertion still run against the
    // real filesystem; only the module under test sees the injected `openSync`.
    const target = makeFile(join(sandbox, 'source.ts'), ORIGINAL, PROJECT_FILE_MODE);

    // Two different errnos, because the contract is "the runtime's own error,
    // with its `code` intact" rather than "a known permissions error": a
    // `ENOSPC` on a full disk must reach the caller exactly as `EACCES` does,
    // and neither may be reported as a conflict.
    for (const expected of ['EACCES', 'ENOSPC'] as const) {
      await withInjectedFs(
        (real) => ({ openSync: openSyncFailingTemporaries(real, expected) }),
        (injected) => {
          const before = injected.readFileSnapshotNoFollow(target);

          const code = runtimeErrnoFrom(() => {
            injected.atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before);
          });

          expect(code).toBe(expected);
        },
      );
    }

    // Byte-for-byte, mode included: a failed conditional write leaves the
    // developer's file exactly as it was found.
    expectFileBytes(target, ORIGINAL);
    expect(octal(permissionsOf(target))).toBe(octal(PROJECT_FILE_MODE));
    // And leaves nothing behind: the cleanup path ran even though the error was
    // rethrown rather than handled.
    expect(temporaryLeftoversIn(sandbox)).toEqual([]);
  });

  it.skipIf(!MODE_DENIES_WRITE)(
    'lets a genuine I/O failure through rather than reporting it as stale (requires an unprivileged account)',
    () => {
      // A stale verdict is an answer and must mean "nothing was written". A
      // directory that cannot be written is a different thing entirely, and
      // collapsing the two would make a caller report a conflict to the
      // developer for what is a permissions problem.
      //
      // Guarded on the account: a privileged process writes through a `0500`
      // directory, so the case would assert nothing rather than fail.
      const directory = makeDir(join(sandbox, 'readonly'), PROJECT_DIR_MODE);
      const target = makeFile(join(directory, 'source.ts'), ORIGINAL);
      const before = readFileSnapshotNoFollow(target);
      chmodSync(directory, 0o500);

      try {
        const code = runtimeErrnoFrom(() => {
          atomicReplaceFileIfUnchanged(target, INSTRUMENTED, before);
        });

        expect(code).toBe('EACCES');
        expectFileBytes(target, ORIGINAL);
      } finally {
        chmodSync(directory, PROJECT_DIR_MODE);
      }
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * pinFileWithinRoot
 * ---------------------------------------------------------------------------
 *
 * The answer to the half of the containment problem a check cannot reach.
 * `../paths.ts` can prove where a path led at one instant; these cases prove
 * that the operations afterwards go to the directory that was verified, whatever
 * happens to the path in between.
 */

describe('pinFileWithinRoot', () => {
  /** Builds `<sandbox>/project/src/server/file.ts` and returns the pieces. */
  function makeNestedProject(): {
    readonly root: string;
    readonly directory: string;
    readonly target: string;
    readonly relative: string;
  } {
    const root = makeDir(join(sandbox, 'project'), PROJECT_DIR_MODE);
    const directory = makeDir(join(root, 'src', 'server'), PROJECT_DIR_MODE);
    const target = makeFile(join(directory, 'file.ts'), 'original\n', PROJECT_FILE_MODE);

    return { root, directory, target, relative: 'src/server/file.ts' };
  }

  it('resolves to the same file as the plain path', () => {
    const { root, directory, target, relative } = makeNestedProject();
    const pinned = pinFileWithinRoot(root, relative);

    try {
      expect(pinned.name).toBe('file.ts');
      expect(pinned.directory).toBe(directory);
      expect(Buffer.compare(readFileNoFollow(pinned.path), readFileSync(target))).toBe(0);
      expect(pinned.verifyDirectory()).toBe(true);
    } finally {
      pinned.release();
    }
  });

  it('reports the pinned directory identity from the descriptor itself', () => {
    const { root, directory, relative } = makeNestedProject();
    const pinned = pinFileWithinRoot(root, relative);

    try {
      const stats = lstatSync(directory, { bigint: true });

      expect(pinned.directoryIdentity.dev).toBe(stats.dev);
      expect(pinned.directoryIdentity.ino).toBe(stats.ino);
    } finally {
      pinned.release();
    }
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a path with a symbolic link among its components (requires symlink creation)',
    () => {
      const { root, relative } = makeNestedProject();
      const elsewhere = makeDir(join(sandbox, 'beyond'), PROJECT_DIR_MODE);

      rmSync(join(root, 'src', 'server'), { recursive: true });
      symlinkSync(elsewhere, join(root, 'src', 'server'));

      const error = unsafePathErrorFrom(() => {
        pinFileWithinRoot(root, relative).release();
      });

      expect(error.details?.reason).toBe('symlink-component');
      expect(entriesIn(elsewhere)).toEqual([]);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'keeps writing to the directory it verified after that directory is replaced by a link (requires symlink creation)',
    () => {
      // The attack the pin exists for, and the sharpest case in this file. The
      // verified parent is moved away and a link to a DECOY directory - holding
      // a file of the same name - is planted in its place. A path-based write
      // would follow the link and rewrite the decoy, which is a file outside
      // the project that the caller never named and never validated.
      const { root, directory, target, relative } = makeNestedProject();
      const pinned = pinFileWithinRoot(root, relative);

      try {
        const moved = join(sandbox, 'moved-server');
        const decoy = makeDir(join(sandbox, 'decoy'), PROJECT_DIR_MODE);
        const decoyFile = makeFile(join(decoy, 'file.ts'), 'decoy content\n');

        renameSync(directory, moved);
        symlinkSync(decoy, directory);

        // The plain path now leads to the decoy; the pinned path does not.
        expect(readFileSync(target).toString('utf8')).toBe('decoy content\n');

        const before = readFileSnapshotNoFollow(pinned.path);
        expect(before.bytes.toString('utf8')).toBe('original\n');

        expect(atomicReplaceFileIfUnchanged(pinned.path, 'patched\n', before).kind).toBe(
          'replaced',
        );

        // The write went to the file that was verified, wherever it now lives,
        // and the decoy is untouched.
        expectFileBytes(join(moved, 'file.ts'), 'patched\n');
        expectFileBytes(decoyFile, 'decoy content\n');
        expect(entriesIn(decoy)).toEqual(['file.ts']);

        // And the caller can see that the situation changed, which is what
        // turns "wrote to a relocated directory" into a reportable conflict
        // rather than a silent success.
        expect(pinned.verifyDirectory()).toBe(false);
      } finally {
        pinned.release();
      }
    },
  );

  it('reports a moved directory through verifyDirectory', () => {
    const { root, directory, relative } = makeNestedProject();
    const pinned = pinFileWithinRoot(root, relative);

    try {
      expect(pinned.verifyDirectory()).toBe(true);
      renameSync(directory, join(sandbox, 'moved'));
      expect(pinned.verifyDirectory()).toBe(false);
    } finally {
      pinned.release();
    }
  });

  it('lets ENOENT through for a directory that does not exist', () => {
    const { root } = makeNestedProject();

    const code = runtimeErrnoFrom(() => {
      pinFileWithinRoot(root, 'src/absent/file.ts').release();
    });

    expect(code).toBe('ENOENT');
  });

  it('is releasable twice without failing', () => {
    const { root, relative } = makeNestedProject();
    const pinned = pinFileWithinRoot(root, relative);

    pinned.release();

    expect(() => {
      pinned.release();
    }).not.toThrow();
  });

  it('reports whether the platform enforces the pin', () => {
    // A boolean, not a platform check: the enforcement comes from being able to
    // address a descriptor as a path, and where that is unavailable the
    // reduction is reported rather than hidden.
    const { root, relative } = makeNestedProject();
    const pinned = pinFileWithinRoot(root, relative);

    try {
      expect(typeof pinned.enforced).toBe('boolean');
      expect(pinned.enforced).toBe(existsSync('/proc/self/fd'));
    } finally {
      pinned.release();
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * a project-internal symbolic link whose target is outside the root
 * ---------------------------------------------------------------------------
 */

/**
 * A project root holding two links that leave it, and the directory and file
 * they leave it for.
 *
 * The root and the directory inside it are `0700` so that the refusals asserted
 * below are about the *link* and not about a permission bit: `assertSecureDir`
 * reports the outermost failing component, and an ordinary `0755` root would
 * make every case report that instead of what it is testing.
 */
interface EscapingLinkFixture {
  /** The project root every containment question below is asked against. */
  readonly root: string;

  /** An ordinary directory inside the root, the parent of both links. */
  readonly inside: string;

  /** A link inside the root pointing at {@link externalDir}. */
  readonly linkedDir: string;

  /** A link inside the root pointing at {@link externalFile}. */
  readonly linkedFile: string;

  /** The directory outside the root entirely. */
  readonly externalDir: string;

  /** The file in {@link externalDir}, whose bytes nothing inside the root may reach. */
  readonly externalFile: string;

  /** The exact content of {@link externalFile}, for byte-for-byte comparison. */
  readonly externalContent: string;

  /** The single entry {@link externalDir} holds, as `readdir` reports it. */
  readonly externalEntry: string;
}

/**
 * Builds the {@link EscapingLinkFixture} inside the current sandbox.
 *
 * Plants links, so every case that calls it is guarded by
 * {@link CAN_CREATE_SYMLINKS}.
 */
function plantEscapingLinks(): EscapingLinkFixture {
  const root = makeDir(join(sandbox, 'project'), SECURE_DIR_MODE);
  const inside = makeDir(join(root, 'inside'), SECURE_DIR_MODE);
  const externalDir = makeDir(join(sandbox, 'beyond'), SECURE_DIR_MODE);
  const externalEntry = 'note.txt';
  const externalContent = 'outside the project root\n';
  const externalFile = makeFile(join(externalDir, externalEntry), externalContent);

  const linkedDir = join(inside, 'escape');
  symlinkSync(externalDir, linkedDir);
  const linkedFile = join(inside, 'reachable.txt');
  symlinkSync(externalFile, linkedFile);

  return {
    root,
    inside,
    linkedDir,
    linkedFile,
    externalDir,
    externalFile,
    externalContent,
    externalEntry,
  };
}

/**
 * The escape the lexical gate cannot see, proven on a real filesystem.
 *
 * This block is the Node-side half of a requirement `../paths.test.ts` states
 * but deliberately cannot test: a path that is inside the project root *as
 * text* can still resolve outside it, because a component of it is a symbolic
 * link. `../paths.ts` imports nothing and answers about strings, so it accepts
 * such a path by construction and says so in each function's "Limit of the
 * guarantee" — and that limit is only honest if the rejection is proven
 * somewhere. It is proven here, in the order a resolver has to apply it:
 *
 * 1. the lexical gate **accepts** the unresolved path — the documented limit,
 *    recorded as a fact rather than as prose;
 * 2. the same gate composed with `fs.realpath` **rejects** it — the rule every
 *    resolver in this product follows (the VS Code URI handler validating a
 *    path any web page can supply, the service's source-open, the patcher):
 *    resolve first, then ask this gate about the resolved path;
 * 3. this module refuses the path on its own where its own guarantees reach:
 *    `O_NOFOLLOW` refuses a link at the **final** component, and the directory
 *    policy refuses a link anywhere in a chain it is given to verify.
 *
 * Step 3 is narrower than it is tempting to read it as, and the fourth case
 * below exists to keep it narrow: `O_NOFOLLOW` constrains the final component
 * only, so a read whose *interior* component is a link returns what the link
 * points at. This module is therefore **not** a substitute for step 2. Every
 * caller that accepts a multi-component path from anywhere but itself resolves
 * it with `fs.realpath` and re-checks containment before opening it; the
 * refusals here are the backstop for the final component and for a declared
 * directory chain, not a replacement for that obligation.
 *
 * Every case needs a planted link, so all of them are guarded on the
 * capability to plant one.
 */
describe('a project-internal symbolic link whose target is outside the root', () => {
  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'is accepted by the lexical gate, which is the documented limit of a string check (requires symlink creation)',
    () => {
      const { root, externalEntry } = plantEscapingLinks();

      // Text only: 'inside/escape/note.txt' has no traversal in it and lands
      // under the root when joined, so the gate cannot answer otherwise — and
      // a caller that stopped here would open a file outside the project.
      const resolved = acceptedPath(resolveWithinProject(root, `inside/escape/${externalEntry}`));

      expect(resolved).toBe(`${root}/inside/escape/${externalEntry}`);
      expect(isWithin(root, resolved)).toBe(true);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'is rejected by the gate once the path is resolved with realpath (requires symlink creation)',
    () => {
      const { root, externalDir, externalEntry } = plantEscapingLinks();
      const resolved = acceptedPath(resolveWithinProject(root, `inside/escape/${externalEntry}`));

      // The composition rule, asserted rather than described: realpath first,
      // then the gate. Both halves are needed — the gate alone accepts (the
      // case above), and realpath alone answers no question about containment.
      const real = realpathSync(resolved);
      expect(real).toBe(join(externalDir, externalEntry));
      expect(isWithin(root, real)).toBe(false);

      const error = refusedBy(toProjectRelative(root, real));
      expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS || NO_NOFOLLOW)(
    'is refused by readFileNoFollow at the final component, so the external bytes are never read (requires symlink creation and O_NOFOLLOW)',
    () => {
      const { linkedFile, externalFile, externalContent } = plantEscapingLinks();

      const code = runtimeErrnoFrom(() => {
        readFileNoFollow(linkedFile);
      });

      expect(code).toBe('ELOOP');
      expectFileBytes(externalFile, externalContent);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'is read through when the link is an interior component, which is why a resolver must realpath first (requires symlink creation)',
    () => {
      // Stated as a fact, the way this file states the EEXIST/ELOOP split:
      // `O_NOFOLLOW` constrains the **final** component only, so a read whose
      // interior component is a link is an ordinary read of whatever that link
      // points at. No flag can change that — the kernel resolves interior
      // components before the flag applies — which is exactly why step 2 above
      // is a requirement on every caller that accepts a path from elsewhere,
      // and not a nicety.
      const { linkedDir, externalContent, externalEntry } = plantEscapingLinks();

      const read = readFileNoFollow(join(linkedDir, externalEntry));

      expect(read.toString('utf8')).toBe(externalContent);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'is refused by createFileExclusive, and the external directory gains nothing (requires symlink creation)',
    () => {
      const {
        root,
        linkedDir,
        linkedFile,
        externalDir,
        externalFile,
        externalContent,
        externalEntry,
      } = plantEscapingLinks();

      // A link at the path being created: refused by the exclusive, no-follow
      // open, and the file it points at keeps its bytes.
      const code = runtimeErrnoFrom(() => {
        createFileExclusive(linkedFile, 'written through the link\n', {
          requireSecureParents: false,
        });
      });
      expect(['EEXIST', 'ELOOP']).toContain(code);
      expectFileBytes(externalFile, externalContent);

      // A link as the *parent* of the path being created: refused by the
      // directory policy, which is why that policy exists in addition to the
      // flags — the flags cannot see an interior component.
      const error = unsafePathErrorFrom(() => {
        createFileExclusive(join(linkedDir, 'planted.txt'), 'one line\n', { upTo: root });
      });
      expect(error.details?.path).toBe(linkedDir);
      expect(error.details?.reason).toBe('symlink-component');

      expect(entriesIn(externalDir)).toEqual([externalEntry]);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'is refused by assertSecureDir under the project root (requires symlink creation)',
    () => {
      const { root, linkedDir } = plantEscapingLinks();

      const error = unsafePathErrorFrom(() => {
        assertSecureDir(linkedDir, { upTo: root });
      });

      expect(error.details?.path).toBe(linkedDir);
      expect(error.details?.reason).toBe('symlink-component');
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'is refused by ensureSecureDir, which creates nothing in the external directory (requires symlink creation)',
    () => {
      const { root, linkedDir, externalDir, externalEntry } = plantEscapingLinks();

      const error = unsafePathErrorFrom(() => {
        ensureSecureDir(join(linkedDir, 'sub'), { upTo: root });
      });

      expect(error.details?.path).toBe(linkedDir);
      expect(error.details?.reason).toBe('symlink-component');
      // The creation walk stopped at the link: the directory that would have
      // been created behind it does not exist, and the external directory holds
      // exactly what the fixture put there.
      expect(existsSync(join(externalDir, 'sub'))).toBe(false);
      expect(entriesIn(externalDir)).toEqual([externalEntry]);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * inspectPrivateFileNoFollow
 * ---------------------------------------------------------------------------
 *
 * The `lstat`-only inspector for a state file another writer opens by path:
 * the session store, whose `node:sqlite` connection follows a link at the
 * final component and whose POSIX locks a verifying open/close in the same
 * process would silently release. Every refusal below is a policy error, and
 * every one leaves the entry — and anything it points at — exactly as the
 * fixture made it, because the inspector never opens, writes or tightens.
 */

/**
 * Whether this process can give a file a second hard link.
 *
 * Probed once, in a directory of its own, for the reason symbolic links are:
 * a filesystem without hard links (FAT, some network mounts) would turn the
 * multiply-linked fixture into a setup failure that reads as a defect in the
 * module. The link count is what confirms the call did what it claimed.
 */
const CAN_CREATE_HARD_LINKS = ((): boolean => {
  const probeRoot = mkdtempSync(join(tmpdir(), 'debuggen-safefs-probe-'));
  try {
    const original = join(probeRoot, 'original');
    writeFileSync(original, '');
    linkSync(original, join(probeRoot, 'second'));
    return lstatSync(original).nlink === 2;
  } catch {
    // Any failure is the answer: no second link could be made here.
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

/** The state {@link inspectPrivateFileNoFollow} reports for a file that must exist. */
function inspectedState(pathAbs: string): PrivateFileState {
  const state = inspectPrivateFileNoFollow(pathAbs);
  if (state === undefined) {
    return expect.unreachable(`expected an entry at '${pathAbs}', and the inspector found none`);
  }
  return state;
}

describe('inspectPrivateFileNoFollow', () => {
  it('returns undefined when nothing is at the path', () => {
    expect(inspectPrivateFileNoFollow(join(sandbox, 'absent.sqlite'))).toBeUndefined();
  });

  it('lets an errno other than ENOENT through untouched', () => {
    // A parent that is a file is not "absent": answering `undefined` would let a
    // caller go on to create something that can never exist there.
    const file = makeFile(join(sandbox, 'plain.txt'), 'one line\n');

    const code = runtimeErrnoFrom(() => {
      inspectPrivateFileNoFollow(join(file, 'sessions.sqlite'));
    });

    expect(code).toBe('ENOTDIR');
  });

  it('reports the identity a no-follow read of the same file reports', () => {
    const target = makeFile(join(sandbox, 'sessions.sqlite'), NON_UTF8_BYTES);

    const state = inspectedState(target);
    const snapshot = readFileSnapshotNoFollow(target);

    // `bigint`, for the reason `FileIdentity` states: a rounded inode number is
    // the direction of failure that makes a swapped file compare equal.
    expect(typeof state.identity.dev).toBe('bigint');
    expect(typeof state.identity.ino).toBe('bigint');
    expect(state.identity).toEqual(snapshot.identity);
    expectFileBytes(target, NON_UTF8_BYTES);
  });

  it.skipIf(NO_POSIX_IDS)(
    'reports the permission bits without judging them (POSIX permission bits)',
    () => {
      // A mode is the one property a caller can repair, so a loose one is
      // reported for the caller to tighten rather than refused here.
      const target = makeFile(join(sandbox, 'sessions.sqlite'), 'x', SECURE_FILE_MODE);
      expect(inspectedState(target).mode).toBe(SECURE_FILE_MODE);

      chmodSync(target, PROJECT_FILE_MODE);
      expect(inspectedState(target).mode).toBe(PROJECT_FILE_MODE);
      expect(permissionsOf(target)).toBe(PROJECT_FILE_MODE);
    },
  );

  it('opens no descriptor on the file it inspects', async () => {
    // The property the session store depends on: closing any descriptor this
    // process holds on the database inode drops the connection's POSIX locks.
    // Every `openSync` the module makes is recorded, and none may happen.
    const target = makeFile(join(sandbox, 'sessions.sqlite'), 'x');
    const expected = lstatSync(target, { bigint: true });
    const opened: string[] = [];

    await withInjectedFs(
      (real) => ({
        openSync: (...args: Parameters<typeof real.openSync>): number => {
          opened.push(String(args[0]));
          return real.openSync(...args);
        },
      }),
      (injected) => {
        const state = injected.inspectPrivateFileNoFollow(target);
        expect(state?.identity).toEqual({ dev: expected.dev, ino: expected.ino });
      },
    );

    expect(opened).toEqual([]);
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a symbolic link to a real file, and leaves the file it points at untouched (requires symlink creation)',
    () => {
      const victim = makeFile(join(sandbox, 'victim.txt'), 'another file\n');
      const target = join(sandbox, 'sessions.sqlite');
      symlinkSync(victim, target);

      const error = unsafePathErrorFrom(() => {
        inspectPrivateFileNoFollow(target);
      });

      expect(error.details?.path).toBe(target);
      expect(error.details?.reason).toBe('symlink-component');
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expectFileBytes(victim, 'another file\n');
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a dangling symbolic link, and creates nothing at its target (requires symlink creation)',
    () => {
      const planted = join(sandbox, 'planted.sqlite');
      const target = join(sandbox, 'sessions.sqlite');
      symlinkSync(planted, target);

      const error = unsafePathErrorFrom(() => {
        inspectPrivateFileNoFollow(target);
      });

      expect(error.details?.path).toBe(target);
      expect(error.details?.reason).toBe('symlink-component');
      expect(existsSync(planted)).toBe(false);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'reports a link to a directory as a link rather than as a non-regular file (requires symlink creation)',
    () => {
      // The link test runs first, so the diagnosis names what the developer has
      // to remove rather than what it happens to point at.
      const elsewhere = makeDir(join(sandbox, 'elsewhere'), PROJECT_DIR_MODE);
      const target = join(sandbox, 'sessions.sqlite');
      symlinkSync(elsewhere, target);

      const error = unsafePathErrorFrom(() => {
        inspectPrivateFileNoFollow(target);
      });

      expect(error.details?.reason).toBe('symlink-component');
      expect(entriesIn(elsewhere)).toEqual([]);
    },
  );

  it('refuses a directory at the path as not a regular file', () => {
    const target = makeDir(join(sandbox, 'sessions.sqlite'), SECURE_DIR_MODE);

    const error = unsafePathErrorFrom(() => {
      inspectPrivateFileNoFollow(target);
    });

    expect(error.details?.path).toBe(target);
    expect(error.details?.reason).toBe('not-a-regular-file');
    expect(lstatSync(target).isDirectory()).toBe(true);
  });

  it.skipIf(!CAN_CREATE_HARD_LINKS)(
    'refuses a file with a second hard link through either name, and accepts it once the link is gone (requires hard-link creation)',
    () => {
      // The second name lives outside the private directory: that is the whole
      // exposure, because both names reach one inode and one set of bytes.
      const outside = makeDir(join(sandbox, 'outside'), PROJECT_DIR_MODE);
      const target = makeFile(join(sandbox, 'sessions.sqlite'), 'x');
      const second = join(outside, 'copy.sqlite');
      linkSync(target, second);

      for (const name of [target, second]) {
        const error = unsafePathErrorFrom(() => {
          inspectPrivateFileNoFollow(name);
        });

        expect(error.details?.path).toBe(name);
        expect(error.details?.reason).toBe('multiply-linked');
        expect(error.details?.links).toBe(2);
      }
      expect(lstatSync(target).nlink).toBe(2);

      rmSync(second);
      expect(inspectedState(target).identity.ino).toBe(lstatSync(target, { bigint: true }).ino);
    },
  );

  it.skipIf(NO_POSIX_IDS || !CAN_ASSIGN_FOREIGN_OWNER)(
    'refuses a file owned by another account (requires assigning a foreign owner)',
    () => {
      const target = makeFile(join(sandbox, 'sessions.sqlite'), 'x', SECURE_FILE_MODE);
      const foreignUid = assignForeignOwner(target);

      const error = unsafePathErrorFrom(() => {
        inspectPrivateFileNoFollow(target);
      });

      expect(error.details?.path).toBe(target);
      expect(error.details?.reason).toBe('foreign-owner');
      expect(error.details?.owner).toBe(foreignUid);
      expect(error.details?.expectedOwner).toBe(ownUid());
      expect(error.hint).toMatch(/replace it with a copy owned by the account/);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * isSameFileIdentity
 * ---------------------------------------------------------------------------
 *
 * The comparison a caller of the inspector makes after acting on a path: the
 * entry it tightened or handed to another writer must still be the inode it
 * judged. Same path and same bytes are not enough — a rename replacement has
 * both — so these cases pin the identity pair and its exactness.
 */

describe('isSameFileIdentity', () => {
  it('is true for two observations of the same file, whichever function made them', () => {
    const target = makeFile(join(sandbox, 'sessions.sqlite'), 'x');

    const first = inspectedState(target).identity;
    const second = inspectedState(target).identity;

    expect(isSameFileIdentity(first, second)).toBe(true);
    expect(isSameFileIdentity(first, readFileSnapshotNoFollow(target).identity)).toBe(true);
  });

  it('is false once the path has been replaced by a rename, even with identical bytes', () => {
    const target = makeFile(join(sandbox, 'sessions.sqlite'), 'same bytes\n');
    const before = inspectedState(target).identity;

    const replacement = makeFile(join(sandbox, 'replacement.sqlite'), 'same bytes\n');
    renameSync(replacement, target);
    const after = inspectedState(target).identity;

    expect(isSameFileIdentity(before, after)).toBe(false);
    expectFileBytes(target, 'same bytes\n');
  });

  it('requires both the device and the inode to match, exactly beyond 2^53', () => {
    // As doubles, 2^60 + 1 and 2^60 + 2 are the same number; as `bigint` they
    // are not, and that difference is the one a swapped file would hide in.
    const base = { dev: 2n ** 60n, ino: 2n ** 60n + 1n };

    expect(isSameFileIdentity(base, { dev: base.dev, ino: base.ino })).toBe(true);
    expect(isSameFileIdentity(base, { dev: base.dev + 1n, ino: base.ino })).toBe(false);
    expect(isSameFileIdentity(base, { dev: base.dev, ino: base.ino + 1n })).toBe(false);
  });
});
