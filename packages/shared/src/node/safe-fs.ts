/**
 * The hardened filesystem writer: private-by-construction creation under the
 * product's own state directory, and atomic, mode-preserving replacement of a
 * file inside a developer's project.
 *
 * Two product guarantees are implemented here and nowhere else:
 *
 * 1. **The state directory cannot be hijacked.** Session data, file backups and
 *    the credential file live outside every checkout, under the directory named
 *    by the service's configuration (`$DEBUGGEN_HOME`). That tree is created
 *    `0700` and every file in it `0600`, the ownership and permissions of each
 *    directory are verified before anything is written, and a symlink planted
 *    at a path this module is asked to create is refused rather than followed.
 *    A token file is worth stealing, so "the parent looked fine last time" is
 *    not a check.
 * 2. **A reversible source edit stays reversible.** The instrumentation patcher
 *    writes a modified copy of a file the developer owns. That write is atomic —
 *    a crash leaves either the original or the complete new content, never half
 *    a file — and it preserves the target's existing permissions, so a patch
 *    that is later reverted leaves the file exactly as it was found, mode
 *    included.
 *
 * ## The two-entry boundary
 *
 * This module is reachable only through the `./node` entry in this package's
 * own `exports` map. The package's root entry is bundled into a page — the
 * MAIN-world telemetry agent, the panel renderer, the DevTools panel and the
 * editor webview — and a single `node:fs` specifier in that entry would break
 * those bundles, so everything that touches a filesystem lives under `src/node`
 * behind the separate export. The sibling `./paths.js` holds the *lexical* half
 * of the same concern: it decides whether a path, read as text, stays inside a
 * project root, and it deliberately imports nothing, which is exactly why it
 * cannot see a symlink. This file is the other half, and the only place the
 * product actually refuses to follow one.
 *
 * ## Synchronous by design
 *
 * Every function here is synchronous, and no asynchronous duplicate exists.
 * Three reasons, each load-bearing:
 *
 * - **The write sequences are crash-ordered.** A reversible edit is recorded as
 *   backup, then journal row, then temp write, then fsync, then rename. The
 *   order *is* the recovery contract — it is what lets start-up reconciliation
 *   decide, from a file's digest alone, whether an edit was never written or
 *   must be restored — and interleaving other work between those steps buys
 *   nothing and makes the window in which a crash is ambiguous wider.
 * - **The payloads are small**: one source file, one small JSON file, one
 *   backup. There is no throughput to win.
 * - **The hottest caller has no event loop to block.** Reconciliation runs at
 *   service start-up, before the process begins serving, for the same reason.
 *
 * A caller that wants a `Result` instead of a throw wraps the call with
 * `tryCatch` from the sibling `./result.js`; this module always throws, so it
 * does not take a dependency on that shape.
 *
 * ## Secure writes versus project writes
 *
 * The two atomic writers below are deliberately not one function:
 *
 * - {@link writeSecureFileAtomic} asserts that the parent directories are real
 *   directories owned by the current user with no group or other permissions,
 *   and writes `0600`. Correct for the product's own state directory, which the
 *   product created and owns.
 * - {@link atomicReplaceFile} asserts none of that and preserves the target's
 *   existing mode. Correct for a directory inside a developer's project, which
 *   is an ordinary `0755` and was not created by us.
 *
 * Collapsing them would either refuse to instrument any real project or quietly
 * weaken the credential store, so each one's documentation names the other and
 * says which cases belong to it.
 *
 * ## POSIX scope
 *
 * `O_NOFOLLOW` and the owner and permission-bit checks are POSIX concepts.
 * Behaviour is selected by **capability**, never by platform name: when
 * `fs.constants.O_NOFOLLOW` is absent the flag contributes nothing, and when
 * `process.getuid` is absent (Windows) the owner and permission-bit assertions
 * are skipped. A symlink is still refused everywhere, because `lstat` reports
 * one on every platform. The reduced guarantee off POSIX is stated on each
 * affected function rather than left to be discovered.
 *
 * ## What is deliberately not here
 *
 * Resolving the state directory's location — reading the environment,
 * expanding `~` — belongs to the service's configuration module; this one takes
 * the paths it is given and reads no environment. There is no recursive delete,
 * no copy helper, no watcher and no lock file: each would be a new guarantee to
 * keep, and none is needed by the callers above.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { DebuggenError } from '../errors.js';
import { isWithin, toPosix } from '../paths.js';

/**
 * The mode every directory this product creates for its own state is given:
 * owner read, write and execute, and nothing for anyone else.
 *
 * The state directory tree — session store, file backups, index caches — is
 * created `0700`, and {@link ensureSecureDir} tightens an existing directory in
 * that tree to this value rather than trusting whatever it happens to carry.
 * {@link assertSecureDir} is the predicate form of the same rule.
 *
 * It is a plain number rather than a string because that is what `mkdir` and
 * `chmod` take; it is named because a bare `0o700` in five call sites is five
 * places for the policy to drift.
 */
export const SECURE_DIR_MODE = 0o700;

/**
 * The mode every file this product creates for its own state is given: owner
 * read and write, and nothing for anyone else.
 *
 * This is the mode of the credential file that holds the local service's
 * editor token, of a backup of a developer's source file, and of the session
 * store — "every file `0600`". {@link createFileExclusive} and
 * {@link writeSecureFileAtomic} apply it by default, and both re-apply it with
 * `fchmod` after creation because the mode passed to `open` is masked by the
 * process umask.
 */
export const SECURE_FILE_MODE = 0o600;

/**
 * Permission bits belonging to group and other. A secure directory or file has
 * none of them set, which is the check behind
 * {@link SECURE_DIR_MODE}/{@link SECURE_FILE_MODE} rather than an equality test
 * on the whole mode: a directory carrying the set-group-id bit, or missing its
 * own execute bit, is unusual but not a leak, while one readable by another
 * account is.
 */
const GROUP_AND_OTHER_BITS = 0o077;

/** The permission bits of a mode, with the file-type and set-id bits masked off. */
const PERMISSION_BITS = 0o777;

/**
 * The mode {@link atomicReplaceFile} gives a file it had to create, when the
 * caller named none: the conventional default for a regular file, owner-writable
 * and world-readable.
 *
 * It applies only to the create case. Replacing an existing file always reuses
 * that file's own mode, which is the whole point of that function.
 */
const DEFAULT_REPLACEMENT_FILE_MODE = 0o644;

/**
 * How many bytes of randomness go into a temporary file's name.
 *
 * The temporary sibling of an atomic write lives, briefly, in a directory that
 * other processes may be able to write to (a project directory is an ordinary
 * `0755`). An unpredictable name is what stops another process from creating
 * that path first and turning our exclusive create into a failure — or, worse,
 * planting a symlink at it. Twelve hex characters from a cryptographic source
 * is far beyond what a racing process could enumerate in the microseconds the
 * file exists.
 */
const TEMP_SUFFIX_BYTES = 6;

/**
 * How much of the target's file name a temporary name may repeat.
 *
 * The name is echoed so a temporary file left behind by a killed process is
 * identifiable, but most filesystems cap a single component at 255 bytes, and a
 * long name plus the prefix, pid, random suffix and extension would exceed it —
 * turning a legitimate write into `ENAMETOOLONG`. Truncating the echoed part
 * keeps the name informative and the write possible.
 */
const MAX_ECHOED_NAME_LENGTH = 64;

/**
 * Why this module refused a path, recorded as `details.reason` on the error so
 * a caller can branch or report without parsing a message.
 *
 * Module-internal: the public surface is the eight exports above and below, and
 * every refusal they raise carries the single error code `FS_UNSAFE_PATH`. The
 * reason is the finer diagnosis underneath it.
 *
 * - `symlink-component` — a component of the chain is a symbolic link. It is
 *   refused instead of resolved, because what it points at today is not what it
 *   will point at between the check and the write.
 * - `not-a-directory` — a component exists but is not a directory, so the
 *   chain it is supposed to anchor cannot exist as described.
 * - `foreign-owner` — a component is owned by another account, which can
 *   therefore replace anything inside it.
 * - `group-or-other-permissions` — a component grants group or other access, so
 *   another account can read the credential or backup written beneath it.
 */
type UnsafePathReason =
  'symlink-component' | 'not-a-directory' | 'foreign-owner' | 'group-or-other-permissions';

/**
 * The `O_NOFOLLOW` flag, or `0` where the platform has no such flag.
 *
 * Read through `unknown` on purpose. The type declarations describe the POSIX
 * constant set, so the compiler believes this property is always a number,
 * while on Windows it is genuinely absent at runtime. Detecting the capability
 * rather than asserting the type is the difference between a documented
 * reduction in guarantee and a `NaN` in a bit mask.
 */
function noFollowFlag(): number {
  const flag: unknown = constants.O_NOFOLLOW;
  return typeof flag === 'number' ? flag : 0;
}

/**
 * The `O_DIRECTORY` flag, or `0` where the platform has no such flag.
 *
 * Detected exactly the way {@link noFollowFlag} detects its own constant, and
 * for the same reason: the declarations promise the POSIX set, the runtime does
 * not, and a missing constant must contribute nothing to a bit mask rather than
 * a `NaN`. It pairs with `O_NOFOLLOW` when {@link ensureSecureDir} opens a
 * directory it is about to tighten — together they say "this exact object, and
 * only if it really is a directory".
 */
function directoryFlag(): number {
  const flag: unknown = constants.O_DIRECTORY;
  return typeof flag === 'number' ? flag : 0;
}

/**
 * The current user id, or `undefined` on a platform that has no such concept.
 *
 * Called as a method so it keeps its receiver, and checked for existence
 * because the declaration marks it optional.
 */
function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/** A mode rendered the way a developer will type it into `chmod`. */
function octal(mode: number): string {
  return (mode & PERMISSION_BITS).toString(8).padStart(3, '0');
}

/**
 * Builds the single policy error this module raises.
 *
 * Only the path, the reason and — where they are the point of the refusal — the
 * mode and owner appear in it. File **contents** never do: this module writes
 * credentials and a developer's source, and an error may be logged, persisted
 * with a session and rendered in two user interfaces.
 */
function unsafePath(
  message: string,
  reason: UnsafePathReason,
  pathAbs: string,
  hint: string,
  extra?: Readonly<Record<string, unknown>>,
): DebuggenError {
  return new DebuggenError('FS_UNSAFE_PATH', message, {
    hint,
    details: { path: pathAbs, reason, ...extra },
  });
}

/**
 * Refuses a path because a component of it is a symbolic link.
 *
 * Every refusal of this kind carries the same code, the same reason and the
 * same hint — the developer's next action is always "replace the link" — so
 * only the consequence differs between call sites, and it is a clause rather
 * than a whole sentence to keep that single shape visible. Declared as
 * returning `never` so a caller reads as a terminator and the compiler narrows
 * the code after it.
 *
 * @param componentAbs The offending component, named in both the message and
 * `details.path` because the developer has to act on that exact path.
 * @param consequence What was therefore not done, as a clause completing
 * "…is a symbolic link, so …".
 */
function refuseSymlinkComponent(componentAbs: string, consequence: string): never {
  throw unsafePath(
    `'${componentAbs}' is a symbolic link, so ${consequence}.`,
    'symlink-component',
    componentAbs,
    'Replace the link with a real directory, or point the tool at a location that is not reached through a link.',
  );
}

/**
 * Refuses a component owned by another account.
 *
 * Shared by the verification pass and the creation walk, so the refusal a
 * developer sees for "this directory is not yours" has one wording and one set
 * of details wherever it is raised — and so a change to either cannot apply to
 * one path through the module and not the other. A foreign-owned directory is
 * refused rather than repaired because the account that owns it can replace it,
 * and its contents, at any moment after the check.
 *
 * @param componentAbs The component being judged.
 * @param ownerUid The uid `lstat` reported for it.
 * @param expectedUid This process's own uid.
 */
function assertOwnedByThisAccount(
  componentAbs: string,
  ownerUid: number,
  expectedUid: number,
): void {
  if (ownerUid !== expectedUid) {
    throw unsafePath(
      `'${componentAbs}' is owned by another account, so its contents cannot be kept private.`,
      'foreign-owner',
      componentAbs,
      'Use a directory owned by the account running this tool.',
      { owner: ownerUid, expectedOwner: expectedUid },
    );
  }
}

/**
 * The errno code of a caught value, when it carries one.
 *
 * `catch` binds `unknown`, and the only reason this module ever inspects a
 * caught error is to tell "the file is not there" apart from "the filesystem
 * refused"; everything else is rethrown untouched.
 */
function errnoCodeOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code: unknown = value.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * The directories a check or a tightening pass covers, outermost first.
 *
 * With no `upToAbs`, that is `dirAbs` alone. With one, it is every component
 * from `upToAbs` down to `dirAbs`, both included — so a caller naming its state
 * root gets the root, the intermediate directories and the leaf checked in one
 * call.
 *
 * **Outermost first is deliberate.** When several components are wrong, the
 * outermost one is the one worth reporting: tightening it is the action that
 * makes the rest reachable, and a message naming the leaf of a chain whose root
 * is world-writable sends the developer to the wrong directory.
 *
 * `upToAbs` must be `dirAbs` or an ancestor of it. That is checked with the
 * lexical containment gate in `./paths.js`, so "inside" means the same thing
 * here as everywhere else in the product, and a violation is a programmer
 * error — the caller has passed two unrelated paths — rather than an insecure
 * filesystem, which is why it is reported as `INTERNAL` and not as
 * `FS_UNSAFE_PATH`.
 *
 * @param dirAbs The resolved leaf directory.
 * @param upToAbs The resolved outermost directory to include, or `undefined`
 * for the leaf alone.
 * @returns The chain, outermost first, leaf last.
 * @throws {DebuggenError} With code `INTERNAL` when `upToAbs` does not contain
 * `dirAbs`.
 */
function secureChain(dirAbs: string, upToAbs: string | undefined): string[] {
  if (upToAbs === undefined) {
    return [dirAbs];
  }

  if (!isWithin(toPosix(upToAbs), toPosix(dirAbs))) {
    throw new DebuggenError(
      'INTERNAL',
      `The boundary directory '${upToAbs}' does not contain '${dirAbs}', so there is no chain of directories between them to verify.`,
      {
        hint: 'Pass the directory itself or one of its ancestors as the boundary.',
        details: { path: dirAbs, upTo: upToAbs, reason: 'boundary-not-an-ancestor' },
      },
    );
  }

  const chain: string[] = [];
  let current = dirAbs;
  for (;;) {
    chain.push(current);
    if (current === upToAbs) {
      break;
    }

    const parent = dirname(current);
    if (parent === current) {
      // The filesystem root is its own parent, so this is where a walk that
      // never met the boundary stops. The containment check above makes it
      // unreachable for two paths of the same root; a mismatch of roots (a
      // Windows drive, a network share) would land here instead of looping.
      throw new DebuggenError(
        'INTERNAL',
        `Walking up from '${dirAbs}' reached the filesystem root without meeting the boundary directory '${upToAbs}'.`,
        {
          hint: 'Pass a boundary directory on the same filesystem root as the directory being verified.',
          details: { path: dirAbs, upTo: upToAbs, reason: 'boundary-not-reached' },
        },
      );
    }
    current = parent;
  }

  chain.reverse();
  return chain;
}

/**
 * Verifies one directory of a chain: a real directory, not a symlink, owned by
 * this user, with no group or other permissions.
 *
 * `lstat` is mandatory here — `stat` would resolve a symlink and report the
 * properties of whatever it points at, which is precisely the substitution this
 * check exists to catch. The symlink test therefore runs first, so a link to a
 * perfectly secure directory is still reported as a link rather than as "not a
 * directory".
 *
 * Off POSIX, where there is no user id, the owner and permission-bit tests are
 * skipped and only the two structural tests apply.
 *
 * @throws The runtime's own filesystem error when the directory cannot be
 * inspected (`ENOENT`, `EACCES`, `ENOTDIR`), unchanged.
 * @throws {DebuggenError} With code `FS_UNSAFE_PATH` when the directory fails
 * any applicable test.
 */
function assertComponentSecure(componentAbs: string, requireOwner: boolean): void {
  const stats = lstatSync(componentAbs);

  if (stats.isSymbolicLink()) {
    throw unsafePath(
      `'${componentAbs}' is a symbolic link, and this path must be a real directory.`,
      'symlink-component',
      componentAbs,
      'Replace the link with a real directory, or point the tool at a location that is not reached through a link.',
    );
  }

  if (!stats.isDirectory()) {
    throw unsafePath(
      `'${componentAbs}' exists but is not a directory.`,
      'not-a-directory',
      componentAbs,
      'Move or remove that entry so a directory can take its place.',
    );
  }

  const uid = currentUid();
  if (uid === undefined) {
    // No user id on this platform: the ownership and permission model the two
    // tests below rely on does not exist, and inventing an answer would be
    // worse than saying so. The link and directory tests above still applied.
    return;
  }

  if (requireOwner) {
    assertOwnedByThisAccount(componentAbs, stats.uid, uid);
  }

  if ((stats.mode & GROUP_AND_OTHER_BITS) !== 0) {
    throw unsafePath(
      `'${componentAbs}' has mode ${octal(stats.mode)}, which grants access to group or other accounts.`,
      'group-or-other-permissions',
      componentAbs,
      `Tighten it with 'chmod ${octal(SECURE_DIR_MODE)}'.`,
      { mode: octal(stats.mode), expectedMode: octal(SECURE_DIR_MODE) },
    );
  }
}

/**
 * How far up to verify, shared by every function that takes a boundary.
 *
 * Optional members are declared `| undefined` as well as optional because the
 * repository compiles with `exactOptionalPropertyTypes`: that is what lets one
 * function forward its own possibly-absent option to another without rebuilding
 * the object.
 */
interface SecureBoundaryOptions {
  /**
   * The outermost directory to include in the check: the product's own state
   * root, in practice.
   *
   * Omit it to check the named directory alone. It must be the directory itself
   * or one of its ancestors.
   */
  readonly upTo?: string | undefined;
}

/** Options for {@link assertSecureDir}. */
interface AssertSecureDirOptions extends SecureBoundaryOptions {
  /**
   * Whether the directory must be owned by the account running this process.
   * Defaults to `true`.
   *
   * Passing `false` is for tests and for unusual ownership setups — a shared
   * build agent, a container whose mount is owned by another uid — and it
   * relaxes **only** the owner test: the symlink, directory and
   * group-or-other-permission tests always apply.
   */
  readonly requireOwner?: boolean | undefined;
}

/**
 * Throws unless every directory in the chain is a real directory, not a
 * symlink, owned by this user, with no group or other permissions.
 *
 * This is the precondition behind every write into the product's own state
 * directory: the session store, a backup of a developer's source file, the
 * credential file. {@link createFileExclusive} and
 * {@link writeSecureFileAtomic} call it before they create anything, and
 * {@link ensureSecureDir} calls it afterwards to prove its own postcondition
 * rather than assume it.
 *
 * ## The walk is bounded on purpose
 *
 * Without `opts.upTo` exactly one directory is checked: the one named. With
 * `opts.upTo`, every directory from that boundary down to the named one is
 * checked, outermost first, so the first violation reported is the outermost —
 * the one whose repair makes the rest reachable.
 *
 * The walk never runs to the filesystem root, and could not usefully: `/` is
 * world-readable and owned by another account on every ordinary system, as is
 * the home directory a state root normally sits in. The product owns its state
 * root and everything below it, and that subtree is what this function can make
 * a statement about — so the caller names the boundary, and what is above it is
 * out of scope by construction.
 *
 * ## Off POSIX
 *
 * Where there is no user id (Windows), the owner and permission-bit tests are
 * skipped and the guarantee narrows to "every component exists, is a directory,
 * and is not a symbolic link". The reduction is inherent to the platform's
 * permission model, not a shortcut: nothing here is chosen by platform name.
 *
 * @param dir The directory to verify. Resolved against the process's working
 * directory when relative.
 * @param opts `upTo` to verify a whole chain, `requireOwner: false` to relax
 * only the ownership test.
 * @throws {DebuggenError} With code `FS_UNSAFE_PATH` when a directory in the
 * chain fails a test; `details` carries the offending absolute path, the reason
 * and — when they are the point of the refusal — the mode or owner. With code
 * `INTERNAL` when `upTo` does not contain `dir`, which is a caller mistake
 * rather than an insecure filesystem.
 * @throws The runtime's own filesystem error, with its `code` intact, when a
 * directory cannot be inspected: `ENOENT` for one that does not exist,
 * `ENOTDIR` when a parent is a file, `EACCES` when it cannot be reached. These
 * are deliberately **not** wrapped — a caller deciding what to do next needs
 * the errno, not a paraphrase of it.
 *
 * @example
 * ```ts
 * // Verify the whole chain from the state root down to a session's backups.
 * assertSecureDir(join(stateRoot, 'backups', sessionId), { upTo: stateRoot });
 * ```
 */
export function assertSecureDir(dir: string, opts?: AssertSecureDirOptions): void {
  const dirAbs = resolve(dir);
  const upToAbs = opts?.upTo === undefined ? undefined : resolve(opts.upTo);
  const requireOwner = opts?.requireOwner ?? true;

  for (const componentAbs of secureChain(dirAbs, upToAbs)) {
    assertComponentSecure(componentAbs, requireOwner);
  }
}

/**
 * Whether the filesystem has *something* at `pathAbs` — a directory, a file, a
 * symbolic link, anything at all.
 *
 * `lstat`, not `stat`: a dangling link exists as far as a creation walk is
 * concerned, and resolving it would report the opposite. Every failure is read
 * as "not known to exist", including the ones that are not `ENOENT`: a
 * component under a regular file answers `ENOTDIR`, and a component this
 * process may not look at answers `EACCES`. Neither is a licence to skip it —
 * the `mkdir` that follows will meet the same condition and report the
 * platform's own errno, which is precisely what a caller needs to see.
 */
function isKnownToExist(pathAbs: string): boolean {
  try {
    lstatSync(pathAbs);
    return true;
  } catch {
    // The distinction between "absent" and "unreadable" belongs to `mkdir`,
    // which is about to make it with the real errno attached.
    return false;
  }
}

/**
 * The components a creation pass has to bring into existence, outermost first,
 * always ending at `dirAbs`.
 *
 * This is the no-boundary counterpart of {@link secureChain}: the caller named
 * no ancestor, so the walk finds where its own work starts — it climbs from
 * `dirAbs` while a component is not known to exist and stops at the first one
 * that is. That component is **not** part of the chain: it already existed,
 * this call is not creating it, and it may legitimately be a directory the
 * product does not own (a home directory, a temp directory) whose mode this
 * function has no business tightening.
 *
 * Stopping there is a statement about *work*, not about trust. The climb uses
 * `lstat`, which resolves every interior component, so the path it stops at can
 * itself sit inside a symbolic link — which is exactly why
 * {@link ensureSecureDir} tests the whole prefix above this chain with
 * {@link assertPrefixIsSymlinkFree} before it creates or tightens anything.
 * Reading this function as "the boundary is trusted" is the error that leaves
 * CWE-59 open.
 *
 * `dirAbs` itself is always the last element, existing or not. When it already
 * exists the chain is the single element, and the non-recursive `mkdir` in
 * {@link ensureSecureDir} then turns "it exists" into the `EEXIST` that decides
 * whether it is a directory, a file or a link.
 */
function creationChain(dirAbs: string): string[] {
  const chain = [dirAbs];

  let current = dirAbs;
  for (;;) {
    const parent = dirname(current);
    // The filesystem root is its own parent, which is where a walk that found
    // nothing existing on the way up stops.
    if (parent === current || isKnownToExist(parent)) {
      break;
    }
    chain.push(parent);
    current = parent;
  }

  chain.reverse();
  return chain;
}

/**
 * Refuses one existing component that is a symbolic link, and says nothing
 * about anything else.
 *
 * A link above the chain redirects the whole tree — and everything later
 * written into it — to a location the product did not choose, which is the half
 * of CWE-59 that a per-component walk of the chain alone would still miss.
 *
 * Nothing else about the component is policed here, on purpose. It sits outside
 * the subtree this module can make a statement about, and an existing *file*
 * there has to keep surfacing the platform's own `ENOTDIR` rather than becoming
 * a policy error — so a component that cannot be inspected, or that is not a
 * directory, falls through to `mkdir` and its authentic errno.
 */
function assertExistingComponentIsNotALink(componentAbs: string): void {
  let isLink: boolean;
  try {
    isLink = lstatSync(componentAbs).isSymbolicLink();
  } catch {
    // Unreadable or absent: `mkdir` is the right reporter for that, not this.
    return;
  }

  if (isLink) {
    refuseSymlinkComponent(componentAbs, 'nothing was created or tightened through it');
  }
}

/**
 * Refuses a path reached through a symbolic link at *any* component of its
 * existing prefix, naming the outermost one.
 *
 * This is what a walk of the chain cannot do for itself, and the reason is a
 * property of `lstat`: it declines to resolve a link only at the **final**
 * component of the path it is given, and resolves every interior one. So
 * "climb until a component exists" stops at the deepest path whose `lstat`
 * succeeds — and when a directory already sits inside a planted link's target,
 * that path is *below* the link and the link is never looked at. The tail is
 * then created inside the target, verified as private and owned (it is: the
 * attacker's directory is a perfectly ordinary directory), and reported as a
 * success outside the product's tree. Checking the chain's immediate parent
 * alone has the same blind spot one component further up.
 *
 * Every component is therefore tested, outermost first — the outermost link is
 * the one that redirects everything below it, and naming it sends the developer
 * to the directory whose repair makes the rest reachable, which is the order
 * {@link assertSecureDir} already reports a chain in.
 *
 * Only *identity* is tested here, never ownership or permissions: these
 * components were not created by this call and may legitimately be directories
 * the product neither owns nor should tighten — a home directory, a temp
 * directory, the filesystem root. The one thing they may not be is a link,
 * because then the path names something other than what the caller wrote.
 *
 * A caller whose legitimate layout really is reached through a link resolves it
 * once with `fs.realpathSync` and passes the resolved path, or passes `upTo` to
 * declare the subtree it owns; both are stated on {@link ensureSecureDir}.
 *
 * @param deepestAbs The deepest component of the prefix to test: the parent of
 * the outermost component the caller is about to create.
 */
function assertPrefixIsSymlinkFree(deepestAbs: string): void {
  const components: string[] = [];
  let current = deepestAbs;
  for (;;) {
    components.push(current);

    const parent = dirname(current);
    // The filesystem root is its own parent, so this is where the climb stops.
    if (parent === current) {
      break;
    }
    current = parent;
  }

  components.reverse();
  for (const componentAbs of components) {
    assertExistingComponentIsNotALink(componentAbs);
  }
}

/**
 * Creates one component of a chain, and reports whether *this call* created it.
 *
 * Non-recursive by necessity. `mkdir` never follows a symbolic link at the
 * final component, so a single-component create is the only form whose
 * behaviour is defined against a planted link: the link arrives as `EEXIST`,
 * where it can be diagnosed, instead of being silently resolved as an
 * intermediate component would be.
 *
 * The `EEXIST` triage is three-way, and each branch is load-bearing:
 *
 * - a symbolic link is refused with `FS_UNSAFE_PATH`, naming that exact path;
 * - anything else that is not a directory rethrows the **original** `EEXIST`
 *   untouched, because "a file occupies this path" is the platform's statement
 *   to make and a caller branches on the errno;
 * - a real directory continues, after its ownership is checked — a directory
 *   another account owns cannot be tightened anyway, and creating the
 *   product's own tree inside it would put that tree at that account's mercy.
 *
 * Every other errno propagates unwrapped: `EACCES`, `ENOSPC` and `ENOTDIR` are
 * answers, not policy failures.
 *
 * @returns `true` when this call created the directory, `false` when it was
 * already there and passed the triage.
 */
function createChainComponent(componentAbs: string): boolean {
  try {
    mkdirSync(componentAbs, { mode: SECURE_DIR_MODE });
    return true;
  } catch (error) {
    if (errnoCodeOf(error) !== 'EEXIST') {
      throw error;
    }

    const stats = lstatSync(componentAbs);
    if (stats.isSymbolicLink()) {
      refuseSymlinkComponent(componentAbs, 'nothing was created or tightened through it');
    }
    if (!stats.isDirectory()) {
      throw error;
    }

    const uid = currentUid();
    if (uid !== undefined) {
      assertOwnedByThisAccount(componentAbs, stats.uid, uid);
    }

    return false;
  }
}

/**
 * Tightens one directory of a chain to {@link SECURE_DIR_MODE}, without ever
 * following a link.
 *
 * `chmod` takes a path, so it is looked up a second time — and between the
 * `lstat` that proved the path was a directory and that lookup, another process
 * can replace it with a link to something else. That window is the CWE-367 half
 * of this module's exposure, and the descriptor route closes it: `open` with
 * `O_NOFOLLOW | O_DIRECTORY` refuses a link outright and yields a handle to the
 * object it just resolved, and `fchmod` applies the mode to *that* object, so
 * there is no second lookup left to redirect.
 *
 * The route is chosen by capability, never by platform name. Where
 * `O_NOFOLLOW` is absent the open buys nothing and the function falls back to
 * the `lstat`-then-`chmod` sequence, which keeps the reduced guarantee this
 * module documents for such platforms rather than failing. The same fallback
 * covers a directory that cannot be *opened* but can be `chmod`-ed — one with
 * no read permission for its own owner, for instance — so the function stays at
 * least as capable as the path-based route alone.
 *
 * An `ELOOP` from the open is the one failure that is not a fallback case: it
 * means the platform's no-follow flag met a link at this exact path, which is a
 * refusal, not an inability.
 */
function tightenToSecureDirMode(componentAbs: string): void {
  const noFollow = noFollowFlag();

  if (noFollow !== 0) {
    let fd: number | undefined;
    try {
      fd = openSync(componentAbs, constants.O_RDONLY | directoryFlag() | noFollow);
    } catch (error) {
      if (errnoCodeOf(error) === 'ELOOP') {
        refuseSymlinkComponent(componentAbs, 'its permissions were left untouched');
      }
      // Anything else — no read permission, a platform that rejects this flag
      // combination — is handled by the path-based route below.
    }

    if (fd !== undefined) {
      try {
        fchmodSync(fd, SECURE_DIR_MODE);
      } finally {
        closeSync(fd);
      }
      return;
    }
  }

  // The path-based route: `chmod` follows a link, so the link test has to
  // happen first and on this exact path.
  if (lstatSync(componentAbs).isSymbolicLink()) {
    refuseSymlinkComponent(componentAbs, 'its permissions were left untouched');
  }
  chmodSync(componentAbs, SECURE_DIR_MODE);
}

/**
 * Creates a directory and every missing parent, one component at a time,
 * tightening each to {@link SECURE_DIR_MODE} and verifying the result.
 *
 * This is how the product's state tree comes into existence at the documented
 * `0700`: the service creates its state root and the per-session backup
 * directories beneath it through this function, and the store creates the
 * directory its database file lives in.
 *
 * ## Why the descent is component-by-component
 *
 * A single recursive `mkdir` over the whole path cannot be made safe. The
 * kernel resolves every *non-final* component of a path through its symbolic
 * links, so an intermediate component of the state tree that has been replaced
 * by a link — `backups` swapped for a link into a directory another local
 * account controls — makes the recursive create place the missing tail inside
 * that directory. Whatever is written there afterwards is written outside the
 * tree, and a verification pass that runs after the creation is a report, not a
 * refusal.
 *
 * So the walk starts at a trusted boundary and takes one component at a time:
 *
 * 1. The chain is computed first — from `opts.upTo` down to `dir` when a
 *    boundary was given, otherwise by climbing from `dir` to the first
 *    component that already exists, which becomes the boundary and is left
 *    alone. Either way the chain ends at `dir`.
 * 2. The prefix above the chain is tested for links, because that is where an
 *    intermediate link hides from the climb: `lstat` resolves every *interior*
 *    component of a path, so a directory already sitting inside a planted
 *    link's target makes the climb stop *below* the link. Without a boundary,
 *    **every** component of that prefix must be a real directory, outermost
 *    reported first. With a boundary, the components from it downward are each
 *    verified in step 3, so the only remaining question is whether the boundary
 *    itself is about to be created inside a link.
 * 3. Each component is created with a **non-recursive** `mkdir`, which never
 *    follows a link at the final component: a planted link arrives as `EEXIST`
 *    and is refused by name, an existing file rethrows its own `EEXIST`, and an
 *    existing directory continues only after its ownership is checked.
 * 4. Each component is tightened immediately, through a descriptor opened
 *    `O_NOFOLLOW | O_DIRECTORY` where the platform has those flags, so the mode
 *    lands on the object the descriptor already names and there is no second
 *    path lookup for another process to redirect.
 *
 * ## Why the mode is applied after `mkdir`
 *
 * The mode passed to `mkdir` is masked by the process umask, so a request for
 * `0700` lands as `0700` under the common `umask 022` and as something narrower
 * or wider under another — and a directory that already existed keeps whatever
 * mode it had, which for a directory created by other means is typically
 * `0755`. Neither case is acceptable for a tree holding a credential, so every
 * component is tightened explicitly. An existing over-permissive directory **in
 * the product's own tree is deliberately tightened**; that is the intended
 * repair, and it is why this function is safe to call on every start-up rather
 * than only on first run. A component's mode is never *asserted* before that
 * repair — only its type, its identity and its owner are, because those are the
 * things a repair cannot fix.
 *
 * ## The chain that is tightened, and what stays unverified
 *
 * `opts.upTo` when given, otherwise the outermost component this call actually
 * created, otherwise the named directory alone. So a first run that creates the
 * whole tree tightens and verifies all of it, and a later run that creates
 * nothing still tightens what the caller declared its own.
 *
 * Stated plainly, the way this module states its POSIX reduction: the
 * components *above* the chain are checked for one thing only — that none of
 * them is a symbolic link — and never for ownership or permissions. They
 * already existed, this call did not create them, and they may legitimately be
 * directories the product neither owns nor should tighten: a home directory, a
 * temp directory, the filesystem root. Which components those are depends on
 * the boundary, and the two cases differ deliberately:
 *
 * - **Without `opts.upTo`** there is no declaration to rely on, so the *whole*
 *   existing prefix must be link-free. A layout that genuinely is reached
 *   through a link is served by resolving it once with `fs.realpathSync` and
 *   passing the resolved path.
 * - **With `opts.upTo`** the caller has declared the subtree it owns and
 *   vouches for the path to it, so only that boundary's own parent is tested
 *   for a link, and the components above it are out of scope by construction.
 *   Everything from the boundary down is verified component by component.
 *
 * That is why every product caller passes `upTo: stateRoot`: it is what turns
 * the guarantee from "the tail this call created is private" into "every
 * directory from the state root down is private, and none of them is a link".
 *
 * One window remains, and naming it is part of the guarantee: the components
 * above the chain are inspected and then traversed, so a link planted in that
 * prefix between the inspection and the `mkdir` would still be followed. It is
 * the residue of a filesystem API with no `openat`/`mkdirat`; the components
 * this function creates carry no such window, because a non-recursive `mkdir`
 * and an `O_NOFOLLOW` descriptor decide the question and act on the result in
 * one step.
 *
 * The function returns only after {@link assertSecureDir} has confirmed the
 * result, which makes a successful return a statement about the filesystem and
 * not about the calls that were attempted.
 *
 * @param dir The directory to create. Resolved against the process's working
 * directory when relative.
 * @param opts `upTo` to tighten and verify a whole chain the caller owns.
 * @throws {DebuggenError} With code `FS_UNSAFE_PATH` when a component of the
 * chain — or the directory the chain would be created inside — is a symbolic
 * link, when a component is owned by another account, or when the chain still
 * fails {@link assertSecureDir} after the tightening pass. With code `INTERNAL`
 * when `upTo` does not contain `dir`.
 * @throws The runtime's own filesystem error, with its `code` intact:
 * `ENOTDIR`/`EEXIST` when a path component is an existing regular file,
 * `EACCES` when the parent cannot be written.
 *
 * @example
 * ```ts
 * ensureSecureDir(join(stateRoot, 'backups', sessionId), { upTo: stateRoot });
 * ```
 */
export function ensureSecureDir(dir: string, opts?: SecureBoundaryOptions): void {
  const dirAbs = resolve(dir);
  const upToAbs = opts?.upTo === undefined ? undefined : resolve(opts.upTo);

  // Validated before anything is created, so a caller that passed an unrelated
  // boundary is told about it instead of leaving a directory behind.
  const declaredChain = secureChain(dirAbs, upToAbs);
  const chain = upToAbs === undefined ? creationChain(dirAbs) : declaredChain;

  // A chain always has at least `dirAbs` in it; the fallback is what satisfies
  // the compiler's indexed-access strictness rather than a reachable case.
  const outermostAbs = chain[0] ?? dirAbs;
  if (upToAbs === undefined) {
    // Nothing above the chain has been declared, so nothing above it can be
    // taken on trust: every component the walk will reach through has to be a
    // real directory. The test runs whether or not the chain's outermost
    // component exists, because the tightening pass reaches through the same
    // prefix that a creation would.
    assertPrefixIsSymlinkFree(dirname(outermostAbs));
  } else if (!isKnownToExist(outermostAbs)) {
    // With a boundary, the components from it downward are each verified in the
    // loop below; the one remaining question is whether the boundary itself is
    // about to be created inside a link.
    assertExistingComponentIsNotALink(dirname(outermostAbs));
  }

  // The outermost component this call created, which is the meaning the
  // recursive `mkdir` return value used to carry: what this call is
  // responsible for, and therefore what it can vouch for without a boundary.
  let firstCreated: string | undefined;
  for (const componentAbs of chain) {
    const created = createChainComponent(componentAbs);
    if (created && firstCreated === undefined) {
      firstCreated = componentAbs;
    }
    tightenToSecureDirMode(componentAbs);
  }

  const chainTop = upToAbs ?? firstCreated ?? dirAbs;
  assertSecureDir(dirAbs, { upTo: chainTop });
}

/** The bytes of a payload: text encoded as UTF-8, bytes taken verbatim. */
function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

/**
 * Writes every byte of `bytes` to `fd`.
 *
 * `write` is allowed to write fewer bytes than it was given — on a pipe, on a
 * full disk, on a signal — and it reports how many, so a single call is not a
 * write. Looping on the reported count is what makes "the file holds exactly
 * these bytes" true, and it is why a recorded digest of a backup can be
 * trusted later.
 */
function writeAllSync(fd: number, bytes: Uint8Array): void {
  let written = 0;
  while (written < bytes.byteLength) {
    written += writeSync(fd, bytes, written, bytes.byteLength - written);
  }
}

/**
 * An unpredictable, identifiable path for the temporary sibling of an atomic
 * write.
 *
 * Same directory as the target, always: `rename` is atomic only within one
 * filesystem, and a temporary file in the system temp directory may well be on
 * another. The name is a dotted prefix (so it does not show up in an ordinary
 * listing), the target's own name truncated (so a file left behind by a killed
 * process can be traced to what it was replacing), the process id, and
 * cryptographic randomness (so no other process can predict or pre-create the
 * path).
 */
function temporarySiblingPath(targetAbs: string): string {
  const echoed = basename(targetAbs).slice(0, MAX_ECHOED_NAME_LENGTH);
  const suffix = randomBytes(TEMP_SUFFIX_BYTES).toString('hex');
  return join(dirname(targetAbs), `.${echoed}.${String(process.pid)}.${suffix}.tmp`);
}

/**
 * Removes a path, ignoring every failure.
 *
 * Used on the cleanup path of a failed write, where the original error is what
 * the caller must see: a temporary file that cannot be removed is a stray file,
 * while losing the reason the write failed is losing the diagnosis.
 */
function removeQuietly(pathAbs: string): void {
  try {
    unlinkSync(pathAbs);
  } catch {
    // Nothing to report and nowhere to report it: `ENOENT` means the file was
    // never created, and anything else has already been superseded by the
    // failure being rethrown.
  }
}

/**
 * Flushes a directory entry to disk, best effort.
 *
 * `rename` is atomic with respect to a reader, but the *directory entry* it
 * changed can still be lost in a power failure until the directory itself is
 * flushed. This is what makes a completed atomic write survive that, and it is
 * best effort by necessity: opening a directory for reading is not portable,
 * and some filesystems reject `fsync` on a directory descriptor. A failure here
 * costs durability in a crash, never correctness now, so it is swallowed rather
 * than turned into a failed write.
 */
function syncDirectoryQuietly(dirAbs: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirAbs, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Not supported here; the rename already happened and is visible.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The descriptor is going away with the process in the worst case.
      }
    }
  }
}

/**
 * The shared body of both atomic writers: create an exclusive temporary
 * sibling at `mode`, write it, flush it, rename it over the target, then flush
 * the directory.
 *
 * The sequence is the guarantee. Until the `rename`, the target still holds its
 * previous content in full; after it, the target holds the new content in full;
 * there is no instant at which a reader sees a partial file, and no crash point
 * that leaves one. On any failure once the temporary file may exist, it is
 * removed and the original error is rethrown, so a failed write leaves the
 * directory exactly as it was found — no stray temporary file, no half-written
 * target.
 *
 * The parents are not verified here. Each caller decides that, because the two
 * of them answer the question differently, and that difference is their whole
 * reason for existing separately.
 */
function writeThenRename(targetAbs: string, data: string | Uint8Array, mode: number): void {
  const tempAbs = temporarySiblingPath(targetAbs);

  try {
    // The parent's suitability is the caller's decision and has already been
    // made, so the temporary file does not re-ask.
    createFileExclusive(tempAbs, data, { mode, requireSecureParents: false });
    renameSync(tempAbs, targetAbs);
  } catch (error) {
    // One failure means the temporary path was not ours: `EEXIST` can only come
    // from the exclusive create, and only when something already occupied the
    // path — so removing it would delete a file this process never created.
    // Every other failure happens after the create owned the path, or leaves
    // nothing there for the removal to find.
    if (errnoCodeOf(error) !== 'EEXIST') {
      removeQuietly(tempAbs);
    }
    throw error;
  }

  syncDirectoryQuietly(dirname(targetAbs));
}

/** Options for {@link createFileExclusive}. */
interface CreateFileExclusiveOptions extends SecureBoundaryOptions {
  /**
   * The mode the new file must end up with. Defaults to
   * {@link SECURE_FILE_MODE}.
   *
   * It is applied twice — once as `open`'s argument, once with `fchmod` — so
   * the result does not depend on the process umask.
   */
  readonly mode?: number | undefined;

  /**
   * Whether the parent directory must pass {@link assertSecureDir} first.
   * Defaults to `true`.
   *
   * Pass `false` only where the parent's suitability has already been
   * established by the caller, or where the target is knowingly outside the
   * product's own tree — a temporary sibling inside a developer's project, for
   * instance. The exclusive, no-follow create below applies either way; this
   * option governs the *directory* policy, never the file one.
   */
  readonly requireSecureParents?: boolean | undefined;
}

/**
 * Creates a new file with exactly the given mode, refusing to overwrite
 * anything and refusing to follow a symlink.
 *
 * This is the create primitive behind the product's own state files: a backup
 * of a developer's original source bytes, written under the state root at
 * `0600` and flushed before the record that points at it is persisted, so a
 * crash can never leave a journal row referring to a backup that is not fully
 * on disk.
 *
 * ## What the flags buy
 *
 * `open` is called with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`:
 *
 * - `O_CREAT | O_EXCL` makes creation atomic and exclusive. Two processes
 *   racing for the same path cannot both succeed, and an existing file is never
 *   truncated or appended to — it is a refusal (`EEXIST`).
 * - `O_NOFOLLOW` refuses a symbolic link at the final component. A link planted
 *   at a path this function is asked to create — the classic way to redirect a
 *   privileged write onto a file the attacker chooses — cannot be written
 *   through.
 *
 * Note which errno arrives for a planted link: `O_EXCL` takes precedence, so an
 * existing symlink (even a dangling one) is reported as **`EEXIST`** rather than
 * `ELOOP`, while {@link readFileNoFollow}, which has no `O_EXCL`, reports
 * `ELOOP`. Both are refusals, and in either case the link's target is left
 * byte-for-byte untouched; the flags are not weakened to make one errno tidier
 * than the other.
 *
 * ## Why the mode is applied twice
 *
 * `open`'s mode argument is masked by the process umask, so a `0600` request
 * lands as `0400` under `umask 0277`. `fchmod` on the descriptor that was just
 * opened sets the mode exactly — on the file the descriptor already refers to,
 * so there is no second path lookup to race — which is what makes "a state file
 * is `0600`" a fact rather than a request.
 *
 * The bytes are then written in full (a single `write` may be partial),
 * flushed with `fsync`, and the descriptor is closed in a `finally`, so no
 * descriptor leaks on a failure part-way through.
 *
 * @param path The file to create. It must not already exist.
 * @param data Text, encoded as UTF-8, or bytes written verbatim. An empty
 * payload is legal and creates an empty file.
 * @param opts `mode` to override {@link SECURE_FILE_MODE}, `upTo` to verify a
 * whole chain of parents, `requireSecureParents: false` to skip the directory
 * policy.
 * @throws {DebuggenError} With code `FS_UNSAFE_PATH` when the parent directory
 * policy applies and fails, or `INTERNAL` when `upTo` does not contain the
 * parent.
 * @throws The runtime's own filesystem error, with its `code` intact:
 * `EEXIST` when the path already exists — as a file, a directory or a symlink;
 * `ENOENT` when the parent does not exist; `EACCES` when it cannot be written;
 * `ENOSPC` when the write cannot complete.
 *
 * @example
 * ```ts
 * createFileExclusive(join(backupsDir, digest), originalBytes, { upTo: stateRoot });
 * ```
 */
export function createFileExclusive(
  path: string,
  data: string | Uint8Array,
  opts?: CreateFileExclusiveOptions,
): void {
  const targetAbs = resolve(path);
  const mode = opts?.mode ?? SECURE_FILE_MODE;

  if (opts?.requireSecureParents !== false) {
    assertSecureDir(dirname(targetAbs), { upTo: opts?.upTo });
  }

  const fd = openSync(
    targetAbs,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
    mode,
  );

  try {
    // On the descriptor, not the path: the mode lands on the file that was just
    // created whatever the umask, and no second lookup can be redirected.
    fchmodSync(fd, mode);
    writeAllSync(fd, toBytes(data));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces — or creates — a file in the product's own state directory
 * atomically, at {@link SECURE_FILE_MODE}, after verifying its parents.
 *
 * This is the writer for a state file that has a *current* value rather than a
 * write-once one: the credential file, which is created on first start and
 * rewritten when the developer rotates the token, and a record file that is
 * replaced wholesale. A reader concurrent with the rotation sees either the old
 * token or the new one, never a truncated file — which matters, because a
 * client that reads a half-written credential is a client that cannot connect
 * and cannot say why.
 *
 * ## Sequence
 *
 * The parents are verified with {@link assertSecureDir}; an unpredictably named
 * temporary sibling is created `0600` in the **same directory** (`rename` is
 * atomic only within one filesystem); the bytes are written and flushed; the
 * temporary file is renamed over the target; and the directory entry is flushed
 * best effort. On any failure the temporary file is removed and the original
 * error is rethrown, so nothing is left behind.
 *
 * ## Choosing between this and {@link atomicReplaceFile}
 *
 * Use this one for anything under the product's own state root, which the
 * product created and owns, and where `0600` is the required outcome. Use
 * {@link atomicReplaceFile} for a file inside a developer's project, whose
 * directories are an ordinary `0755` and whose file permissions must survive
 * being written. Using this one there fails the directory policy on every real
 * project; using that one here would leave a credential at whatever mode it
 * already had.
 *
 * ## Symlinks
 *
 * `rename` replaces a *path entry*, so a symlink at the target path is replaced
 * by a regular file rather than written through — the safe outcome for a state
 * file, which the product is the only writer of. The exclusive create of the
 * temporary sibling is still `O_NOFOLLOW`, so nothing is ever written through a
 * link.
 *
 * @param path The state file to write. Created when absent, replaced when
 * present.
 * @param data Text, encoded as UTF-8, or bytes written verbatim.
 * @param opts `upTo` to verify a whole chain of parents the caller owns.
 * @throws {DebuggenError} With code `FS_UNSAFE_PATH` when the parent directory
 * chain fails its policy, or `INTERNAL` when `upTo` does not contain the parent.
 * @throws The runtime's own filesystem error, with its `code` intact:
 * `EACCES` when the directory cannot be written, `EISDIR` when the target is a
 * directory, `ENOSPC` when the write cannot complete.
 *
 * @example
 * ```ts
 * writeSecureFileAtomic(join(stateRoot, 'auth.json'), JSON.stringify(record), {
 *   upTo: stateRoot,
 * });
 * ```
 */
export function writeSecureFileAtomic(
  path: string,
  data: string | Uint8Array,
  opts?: SecureBoundaryOptions,
): void {
  const targetAbs = resolve(path);

  assertSecureDir(dirname(targetAbs), { upTo: opts?.upTo });
  writeThenRename(targetAbs, data, SECURE_FILE_MODE);
}

/** Options for {@link atomicReplaceFile}. */
interface AtomicReplaceFileOptions {
  /**
   * The mode to use **only when the target does not already exist**. Defaults
   * to `0o644`.
   *
   * When the target exists its own mode is reused and this option is ignored,
   * because preserving what was found is the entire purpose of this function.
   */
  readonly mode?: number | undefined;
}

/**
 * Replaces a file atomically, preserving the mode it already had.
 *
 * This is the writer the instrumentation patcher uses for a file **inside a
 * developer's project**. Two properties make it the right one there, and make
 * it the wrong one for the product's own state:
 *
 * - **No directory policy.** A project directory is an ordinary `0755` owned by
 *   the developer's account and was not created by this product, so the
 *   `0700`-and-owned assertion of {@link writeSecureFileAtomic} would refuse
 *   every real project. Nothing about the parents is asserted here.
 * - **The target's mode is preserved.** An existing file's permission bits are
 *   read and re-applied to the replacement, so a temporarily instrumented file
 *   that is later restored is identical to what was found — content *and* mode.
 *   A patch that silently turned an executable script into a plain file, or
 *   widened a file's permissions, would be a modification the product never
 *   recorded and cannot revert.
 *
 * For anything under the product's own state root use
 * {@link writeSecureFileAtomic} instead: this function would leave a credential
 * or a backup at whatever mode it already carried, and would not check that the
 * directory it sits in is private.
 *
 * ## Sequence and crash behaviour
 *
 * An unpredictably named temporary sibling is created in the same directory at
 * the resolved mode, written, flushed, then renamed over the target, and the
 * directory entry is flushed best effort. Until the rename the target still
 * holds its original bytes in full; after it, the new bytes in full. A crash at
 * any point leaves one or the other, never a partial file — which is what makes
 * the patcher's "the file's digest is either the original or the instrumented
 * one" reconciliation sound. On any failure, including a failing rename, the
 * temporary file is removed and the original error is rethrown.
 *
 * ## Symlinks, stated honestly
 *
 * `rename` replaces the **path entry**, so if the target path is itself a
 * symlink, the link is replaced by a regular file and the link's target is left
 * untouched. That is a refusal to write through the link, not a write to it. A
 * caller that genuinely means to write through a link resolves it first with
 * `fs.realpathSync` and passes the resolved path. Note also that the mode is
 * read with `stat`, which does follow a link, so a link's target's mode is what
 * a replacement would adopt.
 *
 * @param path The file to replace. Created when absent.
 * @param data Text, encoded as UTF-8, or bytes written verbatim.
 * @param opts `mode` for the create case only; ignored when the target exists.
 * @throws The runtime's own filesystem error, with its `code` intact:
 * `EACCES` when the directory cannot be written, `ENOENT` when the parent
 * directory does not exist, `EISDIR` when the target is a directory, `ENOSPC`
 * when the write cannot complete. No policy error is raised — this function
 * asserts no policy.
 *
 * @example
 * ```ts
 * // Write the instrumented content over the developer's file, then restore it.
 * atomicReplaceFile(absoluteSourcePath, instrumentedContent);
 * atomicReplaceFile(absoluteSourcePath, originalBytes);
 * ```
 */
export function atomicReplaceFile(
  path: string,
  data: string | Uint8Array,
  opts?: AtomicReplaceFileOptions,
): void {
  const targetAbs = resolve(path);
  writeThenRename(
    targetAbs,
    data,
    existingFileMode(targetAbs) ?? opts?.mode ?? DEFAULT_REPLACEMENT_FILE_MODE,
  );
}

/**
 * The permission bits of an existing file, or `undefined` when there is no file
 * at that path.
 *
 * Only "not there" is treated as an answer; every other failure — no permission
 * to look, a parent that is not a directory — is rethrown with its errno
 * intact, because a write that is about to fail for that reason should fail
 * with the reason and not with a guessed mode.
 */
function existingFileMode(targetAbs: string): number | undefined {
  try {
    return statSync(targetAbs).mode & PERMISSION_BITS;
  } catch (error) {
    if (errnoCodeOf(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Reads a file's bytes, refusing to follow a symbolic link at the final
 * component.
 *
 * Use this for any path whose final component is not fully trusted — one that
 * arrived from another process, or one inside a directory another account can
 * write to. An ordinary read follows links, which is correct when the question
 * is "what does a reader of this path get" (the digest helpers in the sibling
 * `./hash.js` do exactly that, on purpose); this function answers the different
 * question "give me the bytes of the file *at* this path, or refuse".
 *
 * A symlink at the final component makes `open` fail with **`ELOOP`** on Linux
 * and macOS — "too many symbolic links encountered", which is how the platform
 * reports `O_NOFOLLOW` meeting a link. The errno is deliberately left as the
 * platform's own, so a caller can tell it apart from `ENOENT` and from `EACCES`.
 * Where the platform has no such flag the read succeeds as an ordinary read;
 * that reduction is inherent to the platform, and no behaviour here is selected
 * by platform name.
 *
 * The descriptor is closed in a `finally`, so a failure during the read leaks
 * nothing.
 *
 * @param path The file to read.
 * @returns The file's bytes, exactly as stored — never decoded, so content that
 * is not valid UTF-8 survives and a byte-order mark is part of the content.
 * @throws The runtime's own filesystem error, with its `code` intact: `ELOOP`
 * when the final component is a symbolic link, `ENOENT` when nothing is there,
 * `EACCES` when it cannot be read, `EISDIR` when it is a directory.
 *
 * @example
 * ```ts
 * const bytes = readFileNoFollow(join(backupsDir, digest));
 * ```
 */
export function readFileNoFollow(path: string): Buffer {
  const fd = openSync(resolve(path), constants.O_RDONLY | noFollowFlag());
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
