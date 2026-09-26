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
 *    A directory of that tree that already exists is judged, never repaired:
 *    one that grants group or other access is refused, with its path and mode,
 *    before anything is created beneath it, because what it already holds may
 *    have been read or replaced while it was open. A token file is worth
 *    stealing, so "the parent looked fine last time" is not a check.
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
 * ## Conditional writes, for a replacement computed from what was read
 *
 * {@link atomicReplaceFileIfUnchanged} is {@link atomicReplaceFile} with a
 * precondition: it writes only while the target still holds the bytes, and is
 * still the inode, that {@link readFileSnapshotNoFollow} observed. Guarantee 2
 * above depends on it. An unconditional rename over a source file cannot fail,
 * so a developer's edit arriving between the read and the write is discarded
 * without a trace — and "fully reversible" would then mean reversible to
 * something the developer no longer had. Because `rename` cannot be made
 * conditional, the install is built from the two primitives that can refuse:
 * `rename`, which retains what it displaces, and `link`, which will not
 * overwrite. No entry at the target path is destroyed without first being
 * retained and inspected, at any interleaving.
 *
 * ## No-clobber creation, for a file that was observed to be absent
 *
 * {@link atomicCreateFileNoClobber} is the same guarantee for the one case the
 * conditional writer cannot express: a target that is **not there**. There are
 * no bytes to make the write conditional on, so the condition is absence itself,
 * and the install is `link`, which refuses an occupied destination. A developer
 * who recreates a deleted file between the moment it was seen missing and the
 * moment it is restored therefore keeps their file — the restore reports that
 * the path is occupied instead of renaming over it — and a reader never sees a
 * half-written file either, because the content is complete and flushed under a
 * temporary name before it is given the target's.
 *
 * ## Pinned paths, for a path that must not be re-resolved
 *
 * {@link pinFileWithinRoot} holds the containing directory open and hands back
 * a path that addresses that descriptor, so the read and the write reach the
 * directory that was verified rather than whatever the path names by then.
 * Guarantee 1's project-side counterpart depends on it: a containment *check*
 * on a path is only ever true of an instant, and `O_NOFOLLOW` constrains a
 * path's final component only, so a directory component replaced after the
 * check redirects everything that follows. Pinning removes the re-resolution
 * rather than repeating the check.
 *
 * {@link pinPrivateFileWithinRoot} is the same pin for a file inside the
 * product's own private state tree. It starts at the state root rather than at
 * the filesystem root, and holds every directory it descends into to the
 * state-directory policy of {@link assertSecureDir} — real directory, owned by
 * this account, no group or other permissions — **by inspecting the descriptor
 * it opened** rather than the path, so the directory that was judged is the
 * directory the following read or unlink reaches.
 *
 * ## Inspected files, for a state file another writer opens
 *
 * {@link inspectPrivateFileNoFollow} judges a state file this module does not
 * write — the session store, which `node:sqlite` opens by path — with `lstat`
 * alone: a link, a non-regular entry, a foreign owner or a second hard link is
 * refused, and the inode identity is returned so the caller can prove with
 * {@link isSameFileIdentity} that what it opened is what was judged. It never
 * opens a descriptor, because closing one would release the POSIX locks a live
 * database connection in the same process holds on that inode.
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
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { DebuggenError } from '../errors.js';
import { isWithin, toPosix } from '../paths.js';

/**
 * The mode every directory this product creates for its own state is given:
 * owner read, write and execute, and nothing for anyone else.
 *
 * The state directory tree — session store, file backups, index caches — is
 * created `0700`: {@link ensureSecureDir} applies this value to every directory
 * it creates, and refuses a directory of that tree that already exists with
 * group or other access rather than changing its mode.
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
 * The directory whose entries address this process's own open descriptors.
 *
 * A path beginning here is resolved by the kernel from the *inode* a descriptor
 * holds rather than from the directory tree, which is what gives
 * {@link pinFileWithinRoot} `openat` semantics without a native addon. Named
 * once, and probed for rather than assumed — see
 * {@link canAddressDescriptorsAsPaths}, which is why no behaviour here is
 * selected by platform name.
 */
const DESCRIPTOR_DIRECTORY = '/proc/self/fd';

/**
 * Whether {@link DESCRIPTOR_DIRECTORY} works on this host, once probed.
 *
 * `undefined` until the first pin is taken, so importing this module still
 * opens nothing.
 */
let descriptorPathsUsable: boolean | undefined;

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
 * Module-internal: the public surface is the exports above and below, and every
 * refusal they raise carries the single error code `FS_UNSAFE_PATH`. The
 * reason is the finer diagnosis underneath it.
 *
 * - `symlink-component` — a component of the chain, or the state file itself,
 *   is a symbolic link. It is refused instead of resolved, because what it
 *   points at today is not what it will point at between the check and the
 *   write.
 * - `not-a-directory` — a component exists but is not a directory, so the
 *   chain it is supposed to anchor cannot exist as described.
 * - `not-a-regular-file` — a state file's path holds something other than a
 *   regular file (a directory, a FIFO, a device, a socket), which no writer of
 *   state can use and which opening could block on or trigger side effects of.
 * - `foreign-owner` — a component or a state file is owned by another account,
 *   which can therefore replace or read it whatever its mode says.
 * - `group-or-other-permissions` — a component grants group or other access, so
 *   another account can read the credential or backup written beneath it.
 * - `multiply-linked` — a state file has more than one hard link, so the same
 *   inode is also reachable through a path outside the private tree. The
 *   product never hard-links its own state files, so a second link was made by
 *   something else.
 */
type UnsafePathReason =
  | 'symlink-component'
  | 'not-a-directory'
  | 'not-a-regular-file'
  | 'foreign-owner'
  | 'group-or-other-permissions'
  | 'multiply-linked';

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
 * directory it has just created to apply its mode — together they say "this
 * exact object, and only if it really is a directory".
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
 * @param hint The developer's next action. Defaults to the directory wording
 * every chain refusal uses; {@link inspectPrivateFileNoFollow} passes the
 * file wording, so the same refusal names the right kind of entry to replace.
 */
function assertOwnedByThisAccount(
  componentAbs: string,
  ownerUid: number,
  expectedUid: number,
  hint = 'Use a directory owned by the account running this tool.',
): void {
  if (ownerUid !== expectedUid) {
    throw unsafePath(
      `'${componentAbs}' is owned by another account, so its contents cannot be kept private.`,
      'foreign-owner',
      componentAbs,
      hint,
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
 * The directories a check or a creation pass covers, outermost first.
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

  assertOwnershipAndMode(componentAbs, stats, requireOwner);
}

/**
 * The owner and permission-bit half of the state-directory policy, applied to
 * stats already read — by `lstat` of a path in {@link assertComponentSecure}
 * and in the creation walk of {@link ensureSecureDir}, or by `fstat` of an open
 * descriptor in {@link pinPrivateFileWithinRoot}, which is what lets the last
 * judge the very directory it will act through.
 *
 * The permission refusal names the exact directory in both its message and its
 * hint, because the developer's next action is a `chmod` of that path — or a
 * different state directory — and never a change this module makes for them:
 * a directory that was readable by another account may already have been read,
 * so only the developer can decide whether its contents are still trustworthy.
 * The hint carries the path and the modes only, never anything the directory
 * holds.
 *
 * Off POSIX, where there is no user id, both tests are skipped.
 *
 * @throws {DebuggenError} With code `FS_UNSAFE_PATH` when the directory is owned
 * by another account (when `requireOwner`) or grants group or other access.
 */
function assertOwnershipAndMode(componentAbs: string, stats: Stats, requireOwner: boolean): void {
  const uid = currentUid();
  if (uid === undefined) {
    // No user id on this platform: the ownership and permission model the two
    // tests below rely on does not exist, and inventing an answer would be
    // worse than saying so. The link and directory tests still applied.
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
      `Check what it contains, then tighten it with 'chmod ${octal(SECURE_DIR_MODE)} ${componentAbs}', or point the tool at a directory only this account can reach.`,
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
 * function has no business judging.
 *
 * Stopping there is a statement about *work*, not about trust. The climb uses
 * `lstat`, which resolves every interior component, so the path it stops at can
 * itself sit inside a symbolic link — which is exactly why
 * {@link ensureSecureDir} tests the whole prefix above this chain with
 * {@link assertPrefixIsSymlinkFree} before it creates anything.
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
    refuseSymlinkComponent(componentAbs, 'nothing was created through it');
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
 * the product neither owns nor has any say over — a home directory, a temp
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
 * - a real directory is held to the whole state-directory policy **as it
 *   stands** — owned by this account, no group or other permissions — and is
 *   never `chmod`-ed. A directory another account owns cannot be made private
 *   by us at all, and creating the product's own tree inside it would put that
 *   tree at that account's mercy. A directory of ours that grants group or
 *   other access may already have been read, or had entries planted in it,
 *   while it was open; quietly tightening it would hide that from the one
 *   person who can judge what it now holds, so it is refused with its path and
 *   mode instead: the write refuses to proceed.
 *
 * Because the walk runs outermost first and this triage happens before the
 * next component is created, the outermost failing directory is the one
 * reported, and nothing new ever appears beneath it.
 *
 * Every other errno propagates unwrapped: `EACCES`, `ENOSPC` and `ENOTDIR` are
 * answers, not policy failures.
 *
 * @returns `true` when this call created the directory, `false` when it was
 * already there and passed the triage.
 * @throws {DebuggenError} With code `FS_UNSAFE_PATH` and `details.reason`
 * `symlink-component`, `foreign-owner` or `group-or-other-permissions` (with
 * `details.mode` and `details.expectedMode`) for an existing component that
 * fails the policy.
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
      refuseSymlinkComponent(componentAbs, 'nothing was created through it');
    }
    if (!stats.isDirectory()) {
      throw error;
    }

    // The same owner-and-mode half `assertSecureDir` applies, on the stats just
    // read, so a pre-existing directory is refused here with exactly the code,
    // reason and details the verification pass would report for it.
    assertOwnershipAndMode(componentAbs, stats, true);

    return false;
  }
}

/**
 * Applies {@link SECURE_DIR_MODE} to a directory **this call just created**,
 * without ever following a link.
 *
 * Only ever called for a component {@link createChainComponent} reported as
 * created; a directory that already existed keeps its mode and is judged
 * instead. The mode passed to `mkdir` is masked by the process umask, which can
 * only *remove* bits, so a freshly created component never carries group or
 * other access — but it may carry less than the owner's full `rwx` (`0500`
 * under `umask 0277`). Setting the mode explicitly is what makes "created
 * `0700`" a fact rather than a request, whatever the umask.
 *
 * `chmod` takes a path, so it is looked up a second time — and between the
 * `mkdir` that created the directory and that lookup, another process can
 * replace it with a link to something else. That window is the CWE-367 half
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
function applySecureDirMode(componentAbs: string): void {
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
 * Creates a directory and every missing parent, one component at a time, at
 * exactly {@link SECURE_DIR_MODE}, refuses any component that already exists
 * and fails the state-directory policy, and verifies the result.
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
 *    existing directory continues only when it already satisfies the whole
 *    state-directory policy — owned by this account, no group or other
 *    permissions. Nothing is created beneath a component until it has passed.
 * 4. A component this call created is given {@link SECURE_DIR_MODE}
 *    immediately, through a descriptor opened `O_NOFOLLOW | O_DIRECTORY` where
 *    the platform has those flags, so the mode lands on the object the
 *    descriptor already names and there is no second path lookup for another
 *    process to redirect.
 *
 * ## Why an existing directory is refused rather than tightened
 *
 * The rule: every parent is verified to be a real directory owned by this
 * account with mode `0700`, and the write **refuses to proceed otherwise**.
 * "Mode `0700`" is read here exactly as {@link assertSecureDir}
 * reads it — no group or other permission bit set — so an owner-only directory
 * narrower than `0700` is accepted as it stands, and an operation it does not
 * permit fails later with the platform's own errno. A directory of the state
 * tree that already grants group or other access — a state root a previous
 * tool or an unpacked archive left at `0755`, a `backups` directory someone
 * `chmod`-ed open — has been readable, and possibly writable, by another
 * account for as long as it was that way: the credential, the backups or the
 * session store beneath it may already have been read, and entries may have
 * been planted in it. Silently narrowing the mode would erase the only evidence
 * of that while carrying on as if the tree had always been private, so the call
 * throws `FS_UNSAFE_PATH` with `details.reason: 'group-or-other-permissions'`,
 * the offending absolute path and its mode, and a hint naming the exact
 * `chmod` — the developer checks what the directory holds and tightens it, or
 * points the tool elsewhere. The refusal changes nothing: the directory keeps
 * its mode and gains no entry.
 *
 * ## Why the mode is applied after `mkdir`
 *
 * The mode passed to `mkdir` is masked by the process umask, so a request for
 * `0700` lands as `0700` under the common `umask 022` and as something
 * narrower — `0500` under `umask 0277` — under another. A mask only ever
 * removes bits, so a directory this call creates can never gain group or other
 * access that way, but "created `0700`" is still a promise about the result,
 * so each created component has the mode applied explicitly and the result
 * does not depend on the umask. Existing components are never passed through
 * that step, which is what makes this function safe to call on every start-up:
 * it changes nothing that was already there.
 *
 * ## The chain that is verified, and what stays unverified
 *
 * `opts.upTo` when given, otherwise the outermost component this call actually
 * created, otherwise the named directory alone. So a first run that creates the
 * whole tree creates and verifies all of it at `0700`, and a later run that
 * creates nothing still judges everything the caller declared its own.
 *
 * Stated plainly, the way this module states its POSIX reduction: the
 * components *above* the chain are checked for one thing only — that none of
 * them is a symbolic link — and never for ownership or permissions. They
 * already existed, this call did not create them, and they may legitimately be
 * directories the product neither owns nor has any say over: a home directory,
 * a temp directory, the filesystem root. Which components those are depends on
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
 * @param opts `upTo` to create and verify a whole chain the caller owns.
 * @throws {DebuggenError} With code `FS_UNSAFE_PATH` when a component of the
 * chain — or the directory the chain would be created inside — is a symbolic
 * link (`symlink-component`), when an existing component is owned by another
 * account (`foreign-owner`) or grants group or other access
 * (`group-or-other-permissions`, with `details.mode` and
 * `details.expectedMode`), or when the chain still fails
 * {@link assertSecureDir} after the creation pass. `details.path` is always
 * the outermost offending component. With code `INTERNAL` when `upTo` does not
 * contain `dir`.
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
    // component exists, because judging an existing component reaches through
    // the same prefix that a creation would.
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
    // Outermost first, and each component settled before the next is created:
    // an existing one is judged as it stands and refused before anything
    // appears beneath it, and only a component this call created has its mode
    // set — an existing directory's mode is never changed here.
    if (createChainComponent(componentAbs)) {
      firstCreated ??= componentAbs;
      applySecureDirMode(componentAbs);
    }
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

/**
 * Which file on disk a set of bytes came from: the device and inode number of
 * the entry that was open when they were read.
 *
 * Content alone cannot answer "is this still the same file". A file replaced by
 * a `rename` — which is how every editor in this product's world saves — keeps
 * its path and gets a **new inode**, so a caller comparing only content would
 * happily overwrite a different file that happened to hold the same bytes.
 * Comparing the inode as well turns "the bytes look right" into "this is the
 * file I read".
 *
 * Both members are `bigint`, read through `stat`'s `{ bigint: true }` form and
 * **not** through Node's default numeric one. That is not fastidiousness: a
 * device or inode number beyond 2^53 loses precision as a double, and the
 * failure it produces is the dangerous direction — two *different* inodes
 * rounding to the same value compare equal, and a comparison that exists to
 * refuse a swapped file would accept one. `bigint` comparison is exact for
 * every value the kernel can report.
 */
export interface FileIdentity {
  /** The device the file lives on, as `stat` reports it. */
  readonly dev: bigint;

  /** The file's inode number on that device. */
  readonly ino: bigint;
}

/** A file's bytes together with the identity of the inode they were read from. */
export interface FileSnapshot {
  /** The bytes, exactly as stored. */
  readonly bytes: Buffer;

  /** Which file on disk they came from. See {@link FileIdentity}. */
  readonly identity: FileIdentity;
}

/**
 * Reads a file's bytes **and** the identity of the inode they came from, from
 * one descriptor, refusing to follow a symbolic link at the final component.
 *
 * {@link readFileNoFollow} with the stat a compare-and-swap needs. The single
 * descriptor is the point: an `open` followed by a separate `stat` of the same
 * *path* can describe two different files if the path is replaced in between,
 * and a caller that then treats the pair as one observation has recorded an
 * identity that never held those bytes. `fstat` on the descriptor the bytes
 * were read from cannot disagree with itself.
 *
 * Use it wherever a later write has to be conditional on what was read —
 * {@link atomicReplaceFileIfUnchanged} is the counterpart — and
 * {@link readFileNoFollow} wherever only the bytes matter.
 *
 * @param path The file to read.
 * @returns Its bytes and the identity of the file they came from.
 * @throws The runtime's own filesystem error, with its `code` intact: `ELOOP`
 * when the final component is a symbolic link, `ENOENT` when nothing is there,
 * `EACCES` when it cannot be read, `EISDIR` when it is a directory.
 *
 * @example
 * ```ts
 * const before = readFileSnapshotNoFollow(absoluteSourcePath);
 * // … compute a replacement from before.bytes …
 * atomicReplaceFileIfUnchanged(absoluteSourcePath, patched, before);
 * ```
 */
export function readFileSnapshotNoFollow(path: string): FileSnapshot {
  const targetAbs = resolve(path);

  // Where the platform has no `O_NOFOLLOW`, the open below is an ordinary one
  // and would return the content of whatever a link at this path points at.
  // `lstat` reports a link on every platform, so the refusal is stated here
  // instead of being silently reduced — a link read and then backed up as the
  // developer's own file is a worse outcome than a refusal.
  if (noFollowFlag() === 0 && lstatSync(targetAbs).isSymbolicLink()) {
    throw refuseAsLoop(targetAbs);
  }

  const fd = openSync(targetAbs, constants.O_RDONLY | noFollowFlag());
  try {
    // The stat comes from this descriptor, never from the path: that is what
    // binds the identity below to the bytes returned beside it.
    const stats = fstatSync(fd, { bigint: true });

    if (!stats.isFile()) {
      throw refuseAsLoop(targetAbs);
    }

    return { bytes: readFileSync(fd), identity: { dev: stats.dev, ino: stats.ino } };
  } finally {
    closeSync(fd);
  }
}

/**
 * The error a refused link or non-regular entry is reported as, carrying the
 * `ELOOP` the platform itself would have produced.
 *
 * Coded rather than typed as a `DebuggenError`, because every caller of the
 * reads and writes here already branches on `error.code` and an `ELOOP` from
 * `O_NOFOLLOW` and an `ELOOP` from this check must be indistinguishable to
 * them: the platform that has the flag and the platform that does not then
 * behave the same way rather than one of them silently succeeding.
 */
function refuseAsLoop(pathAbs: string): Error & { code: string } {
  return Object.assign(
    new Error(`ELOOP: not a regular file, or a symbolic link, at '${pathAbs}'`),
    { code: 'ELOOP' },
  );
}

/**
 * What {@link inspectPrivateFileNoFollow} established about an existing state
 * file: which inode the path named, and the permission bits it carried.
 */
export interface PrivateFileState {
  /**
   * The device and inode the path named at the instant it was inspected. Compare
   * a later inspection with {@link isSameFileIdentity} to prove that the entry
   * acted on in between is still the one that was judged.
   */
  readonly identity: FileIdentity;

  /**
   * The permission bits (`mode & 0o777`), with the file-type and set-id bits
   * masked off.
   *
   * Reported rather than judged: a mode is the one property of a state file a
   * caller can *repair*, so deciding whether to tighten it is the caller's
   * policy. Everything this function refuses is a property no repair can fix.
   */
  readonly mode: number;
}

/**
 * Inspects an existing file in the product's own state directory without ever
 * following, opening or modifying it, and refuses anything that is not a
 * regular, single-link file owned by this account.
 *
 * This is the counterpart of {@link createFileExclusive} for a state file that
 * some *other* writer opens by path — the session store is the case in point:
 * `node:sqlite` opens `sessions.sqlite` and its `-wal`, `-shm` and `-journal`
 * sidecars itself, following a symbolic link at the final component, so the
 * only defence is to prove what each path names before that writer reaches it,
 * and again afterwards.
 *
 * ## Refusals, in the order they are tested
 *
 * All are `FS_UNSAFE_PATH`, with the reason in `details.reason`:
 *
 * 1. `symlink-component` — the path itself is a symbolic link, dangling or not.
 *    Tested first, so a link to a perfectly private file is reported as a link.
 * 2. `not-a-regular-file` — a directory, FIFO, socket or device.
 * 3. `foreign-owner` — owned by another account, which can read or replace it
 *    whatever its mode says. Skipped where `process.getuid` is absent.
 * 4. `multiply-linked` — more than one hard link: the inode is shared with a
 *    path that may lie outside the private tree, so whatever is written here is
 *    readable there. The product never hard-links a state file of its own.
 *
 * ## Why no descriptor is ever opened
 *
 * `lstat` answers every question above and takes nothing out of the file, and
 * that is a requirement rather than a preference:
 *
 * - **POSIX advisory locks.** Closing *any* descriptor a process holds on an
 *   inode releases every `fcntl` lock that process holds on it. SQLite keeps its
 *   database and `-shm` locks for the connection's lifetime, so a verifying
 *   `open`/`close` pair in the same process silently drops them and invites
 *   exactly the corruption SQLite documents ("How To Corrupt An SQLite Database
 *   File", §2.2). An inspector that never opens is safe to call on a file a live
 *   connection holds.
 * - **Opening has side effects.** Opening a FIFO blocks until a writer appears,
 *   and opening a device can act on it; `lstat` does neither.
 *
 * ## What a successful return means
 *
 * A statement about an instant. The parent directory is expected to have been
 * verified private and owned already ({@link ensureSecureDir}), which is what
 * stops another account from replacing the entry between this inspection and
 * the caller's next step; a caller that must act on the *same* file inspects
 * again afterwards and compares identities with {@link isSameFileIdentity}.
 *
 * Off POSIX the owner test is skipped, as it is everywhere in this module; the
 * link, type and link-count tests apply on every platform.
 *
 * @param path The state file to inspect. Resolved against the process's working
 * directory when relative.
 * @returns Its identity and permission bits, or `undefined` when nothing is at
 * that path.
 * @throws {DebuggenError} With code `FS_UNSAFE_PATH` for any refusal above;
 * `details` carries the absolute path and the reason, plus the owner or link
 * count when that is the point of the refusal.
 * @throws The runtime's own filesystem error, with its `code` intact, for any
 * failure other than `ENOENT`: `ENOTDIR` when a parent is a file, `EACCES` when
 * the path cannot be reached.
 *
 * @example
 * ```ts
 * const before = inspectPrivateFileNoFollow(databasePath);
 * if (before !== undefined && (before.mode & 0o077) !== 0) {
 *   chmodSync(databasePath, SECURE_FILE_MODE); // a regular, owned, single-link file
 *   const after = inspectPrivateFileNoFollow(databasePath);
 *   if (after === undefined || !isSameFileIdentity(before.identity, after.identity)) {
 *     throw new Error('the entry changed while it was being tightened');
 *   }
 * }
 * ```
 */
export function inspectPrivateFileNoFollow(path: string): PrivateFileState | undefined {
  const targetAbs = resolve(path);

  let stats;
  try {
    // `{ bigint: true }`, so the identity returned is exact: see
    // {@link FileIdentity} for why a rounded inode number is the dangerous
    // direction of a later comparison.
    stats = lstatSync(targetAbs, { bigint: true });
  } catch (error) {
    if (errnoCodeOf(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw unsafePath(
      `'${targetAbs}' is a symbolic link, and this path must be a regular file.`,
      'symlink-component',
      targetAbs,
      'Remove the link so the file can be created in its place, or replace it with a regular file owned by this account.',
    );
  }

  if (!stats.isFile()) {
    throw unsafePath(
      `'${targetAbs}' exists but is not a regular file.`,
      'not-a-regular-file',
      targetAbs,
      'Move or remove that entry so a regular file can take its place.',
    );
  }

  const uid = currentUid();
  if (uid !== undefined) {
    // A uid always fits a double exactly, so the narrowing loses nothing.
    assertOwnedByThisAccount(
      targetAbs,
      Number(stats.uid),
      uid,
      'Remove the file, or replace it with a copy owned by the account running this tool.',
    );
  }

  if (stats.nlink > 1n) {
    const links = Number(stats.nlink);
    throw unsafePath(
      `'${targetAbs}' has ${String(links)} hard links, so the same file is also reachable through a path outside this directory.`,
      'multiply-linked',
      targetAbs,
      'Remove the other links, or replace the file with a copy of it that has a single link.',
      { links },
    );
  }

  return {
    identity: { dev: stats.dev, ino: stats.ino },
    mode: Number(stats.mode) & PERMISSION_BITS,
  };
}

/**
 * Whether two observations name the same inode on the same device.
 *
 * The comparison behind every "is this still the file I judged" question: a
 * file replaced by a `rename` keeps its path and gets a new inode, and a link
 * swapped in and resolved gets the target's, so only the identity pair can
 * tell them apart. Both members are compared as `bigint`, which is exact — see
 * {@link FileIdentity}.
 *
 * @param a An identity from {@link inspectPrivateFileNoFollow},
 * {@link readFileSnapshotNoFollow} or any other source of a {@link FileIdentity}.
 * @param b The identity to compare it with.
 * @returns `true` only when both the device and the inode are equal.
 */
export function isSameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return sameIdentity(a, b);
}

/**
 * A file whose containing directory is held open, so that every operation on it
 * reaches the directory that was verified rather than whatever its path names
 * later.
 *
 * Returned by {@link pinFileWithinRoot}. {@link PinnedFile.path} is the only
 * path a holder should use for I/O, and {@link PinnedFile.release} must be
 * called — a descriptor per patched file otherwise accumulates for the lifetime
 * of the process.
 */
export interface PinnedFile {
  /**
   * The path to use for every read, create, link, rename and unlink of this
   * file and of a temporary sibling beside it.
   *
   * When the pin is {@link PinnedFile.enforced}, this is a path *through the
   * held descriptor* rather than through the directory tree, so replacing any
   * component of the original path afterwards cannot redirect it. `dirname`,
   * `basename` and `join` behave on it exactly as they do on an ordinary path,
   * which is what lets the writers here place a temporary sibling beside it
   * without knowing it is pinned.
   */
  readonly path: string;

  /** The canonical directory path this file was pinned inside. */
  readonly directory: string;

  /** The identity of that directory at the moment it was opened. */
  readonly directoryIdentity: FileIdentity;

  /** The file's name inside {@link PinnedFile.directory}. */
  readonly name: string;

  /**
   * Whether the platform actually enforces the pin.
   *
   * `true` where a descriptor can be addressed as a path (Linux's
   * `/proc/self/fd`), which is what gives these operations `openat`
   * semantics. `false` where it cannot: {@link PinnedFile.path} is then the
   * ordinary path, every component was still checked for a symbolic link
   * while the pin was taken, and {@link PinnedFile.verifyDirectory} still
   * detects a directory swapped afterwards — but a swap *during* the sequence
   * is no longer impossible, only detected. The reduction is inherent to the
   * platform and is reported rather than hidden.
   */
  readonly enforced: boolean;

  /**
   * Whether {@link PinnedFile.directory} still names the directory that was
   * pinned.
   *
   * `lstat` of the original path compared against
   * {@link PinnedFile.directoryIdentity}: `false` means the directory was
   * moved, replaced or turned into a link since the pin was taken. A caller
   * about to write calls this immediately beforehand — on an enforced pin the
   * write is already safe and this makes the situation *visible* rather than
   * silently writing to a relocated directory; on a degraded one it is the only
   * check there is.
   */
  readonly verifyDirectory: () => boolean;

  /** Closes the held descriptor. Idempotent. */
  readonly release: () => void;
}

/**
 * Opens the directory holding a project-relative file, one component at a time,
 * refusing a symbolic link at every step, and returns a handle whose operations
 * cannot be redirected afterwards.
 *
 * This is the answer to the half of CWE-22 that a containment *check* cannot
 * reach. Canonicalising a path and comparing it against the project root —
 * `resolveRealPathWithinProject` in the sibling `../paths.js` — proves where the
 * path led *at that moment*. Every later `open`, `rename` or `link` by that path
 * resolves the components again, so replacing one of them in between redirects
 * the operation to somewhere the check never saw. Checking again does not fix
 * it: there is always another instant between the last check and the use.
 *
 * The fix is not to resolve the path again at all. Each component is opened
 * relative to the descriptor of the one above it — `O_DIRECTORY | O_NOFOLLOW`,
 * so a link anywhere in the chain is refused rather than followed — and the
 * deepest descriptor is kept. Operations then address the directory *inode*,
 * which no change to any path can alter. A component replaced afterwards is
 * simply not consulted, and a directory moved afterwards is still the directory
 * whose contents were verified, which {@link PinnedFile.verifyDirectory} lets a
 * caller notice.
 *
 * The walk starts at the filesystem root and descends every component of
 * `rootAbs` as well as of `relativeFile`, so the chain above the project is
 * pinned too. `rootAbs` is expected to be **canonical** already (the output of
 * `resolveRealPathWithinProject`), which is what makes a refusal here mean "a
 * component was replaced since it was canonicalised" rather than "this project
 * lives under a symlinked home directory".
 *
 * @param rootAbs The canonical absolute path of the project root.
 * @param relativeFile The project-relative POSIX path of the file, whose final
 * component is **not** opened — it is left for the caller's own no-follow open.
 * @returns The pinned file. The caller must `release()` it.
 * @throws {DebuggenError} With code `FS_UNSAFE_PATH` and
 * `details.reason: 'symlink-component'` when a component of either path is a
 * symbolic link or is not a directory.
 * @throws The runtime's own filesystem error, with its `code` intact, when a
 * component cannot be opened: `ENOENT`, `EACCES`.
 *
 * @example
 * ```ts
 * const pinned = pinFileWithinRoot(canonicalRoot, 'src/lib/thing.ts');
 * try {
 *   const before = readFileSnapshotNoFollow(pinned.path);
 *   atomicReplaceFileIfUnchanged(pinned.path, patched, before);
 * } finally {
 *   pinned.release();
 * }
 * ```
 */
export function pinFileWithinRoot(rootAbs: string, relativeFile: string): PinnedFile {
  const targetAbs = resolve(rootAbs, relativeFile);
  const directoryAbs = dirname(targetAbs);

  return pinnedFileFrom(openDirectoryChain(directoryAbs), directoryAbs, basename(targetAbs));
}

/**
 * Pins the directory holding a file inside the product's **private** state
 * tree, verifying every directory from the state root down through the
 * descriptor that was opened, and returns a handle whose operations cannot be
 * redirected afterwards.
 *
 * The private-tree counterpart of {@link pinFileWithinRoot}, for a caller that
 * must read or delete a file below `$DEBUGGEN_HOME` at a path it did not
 * compose itself — a backup the journal says was moved. {@link assertSecureDir}
 * followed by an operation *by path* would judge the directories at one instant
 * and resolve them again at the next, so a directory swapped for a link in
 * between would redirect the read or the unlink out of the tree (CWE-367). Here
 * nothing is resolved twice:
 *
 * 1. The boundary itself is opened by its path with `O_DIRECTORY | O_NOFOLLOW`
 *    — what lies above it is out of scope, exactly as for
 *    {@link assertSecureDir}, but the boundary must not be a link.
 * 2. Each component below it is opened relative to the descriptor of the one
 *    above (through `/proc/self/fd` where the platform offers it), again with
 *    `O_NOFOLLOW`, so a link anywhere in the chain is refused.
 * 3. Every descriptor, the boundary's included, is held to the state-directory
 *    policy with `fstat`: a directory, owned by this account, with no group or
 *    other permission bits. The inode judged is the inode held.
 *
 * {@link PinnedFile.path} then addresses the file through the final
 * descriptor. Where descriptors cannot be addressed as paths the walk still
 * refuses a link at every step and judges each directory it opened, and the
 * handle reports {@link PinnedFile.enforced} as `false`, as
 * {@link pinFileWithinRoot} does.
 *
 * @param rootAbs The state root, the outermost directory held to the policy.
 * @param relativeFile The path of the file relative to `rootAbs`. Its final
 * component is **not** opened — it is left for the caller's own no-follow read
 * or unlink.
 * @returns The pinned file. The caller must `release()` it.
 * @throws {DebuggenError} With code `INTERNAL` when `relativeFile` does not name
 * a file below `rootAbs` (`boundary-not-an-ancestor`), which is a caller
 * mistake; with code `FS_UNSAFE_PATH` when a directory in the chain is a
 * symbolic link or not a directory (`symlink-component`, `not-a-directory`), is
 * owned by another account (`foreign-owner`) or grants group or other access
 * (`group-or-other-permissions`).
 * @throws The runtime's own filesystem error, with its `code` intact, when a
 * component cannot be opened: `ENOENT`, `EACCES`.
 *
 * @example
 * ```ts
 * const pinned = pinPrivateFileWithinRoot(stateRoot, 'backups/ses_1/moved/<digest>');
 * try {
 *   const bytes = readFileNoFollow(pinned.path);
 * } finally {
 *   pinned.release();
 * }
 * ```
 */
export function pinPrivateFileWithinRoot(rootAbs: string, relativeFile: string): PinnedFile {
  const boundaryAbs = resolve(rootAbs);
  const targetAbs = resolve(boundaryAbs, relativeFile);
  const directoryAbs = dirname(targetAbs);

  if (targetAbs === boundaryAbs || !isWithin(toPosix(boundaryAbs), toPosix(directoryAbs))) {
    throw new DebuggenError(
      'INTERNAL',
      `'${relativeFile}' does not name a file below the boundary directory '${boundaryAbs}', so there is no chain of directories to pin.`,
      {
        hint: 'Pass the path of a file inside the boundary, relative to it.',
        details: { path: targetAbs, upTo: boundaryAbs, reason: 'boundary-not-an-ancestor' },
      },
    );
  }

  return pinnedFileFrom(
    openPrivateDirectoryChain(boundaryAbs, directoryAbs),
    directoryAbs,
    basename(targetAbs),
  );
}

/**
 * The {@link PinnedFile} over a directory descriptor that one of the pinned
 * walks returned: the path through the descriptor, the identity check and an
 * idempotent release. Shared so both pins hand out the same contract.
 */
function pinnedFileFrom(
  descriptor: PinnedDirectoryDescriptor,
  directoryAbs: string,
  name: string,
): PinnedFile {
  let released = false;

  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    try {
      closeSync(descriptor.fd);
    } catch {
      // The descriptor is going away with the process in the worst case, and a
      // failure to close is not something a caller can act on.
    }
  };

  const base = descriptor.enforced ? descriptorPath(descriptor.fd) : directoryAbs;

  return {
    path: join(base, name),
    directory: directoryAbs,
    directoryIdentity: descriptor.identity,
    name,
    enforced: descriptor.enforced,
    verifyDirectory: (): boolean => {
      try {
        const stats = lstatSync(directoryAbs, { bigint: true });
        return (
          stats.isDirectory() &&
          stats.dev === descriptor.identity.dev &&
          stats.ino === descriptor.identity.ino
        );
      } catch {
        // Gone, or unreadable: either way it is no longer demonstrably the
        // directory that was pinned.
        return false;
      }
    },
    release,
  };
}

/** The open directory at the end of a pinned walk. */
interface PinnedDirectoryDescriptor {
  /** The descriptor, owned by the {@link PinnedFile} that requested it. */
  readonly fd: number;

  /** Its identity, read from the descriptor itself. */
  readonly identity: FileIdentity;

  /** Whether a descriptor can be addressed as a path on this platform. */
  readonly enforced: boolean;
}

/**
 * Opens every component of an absolute directory path in turn, each relative to
 * the descriptor of the one above it, and returns the deepest.
 *
 * The first component is the filesystem root, which is opened by path because
 * there is nothing above it to be relative to. Every component after it is
 * opened with `O_NOFOLLOW`, so the walk refuses a symbolic link rather than
 * following one, and intermediate descriptors are closed as the walk descends —
 * only the deepest one is handed out.
 */
function openDirectoryChain(directoryAbs: string): PinnedDirectoryDescriptor {
  const enforced = canAddressDescriptorsAsPaths();
  const parts = directoryAbs.split(/[\\/]+/u).filter((part) => part.length > 0);
  const anchor = isWindowsRooted(directoryAbs) ? `${parts.shift() ?? ''}\\` : '/';

  // The anchor is opened by path because there is nothing above it to be
  // relative to, and it is the one component no attacker can replace.
  let fd = openSync(anchor, constants.O_RDONLY | directoryFlag());
  let walked = anchor;

  try {
    for (const part of parts) {
      walked = join(walked, part);

      // Relative to the descriptor when the platform allows it, which is what
      // makes the component that was just verified the one actually descended
      // into. Otherwise the accumulated path, which still refuses a link at
      // each component but can be overtaken between two of them.
      const next = openComponent(enforced ? join(descriptorPath(fd), part) : walked, directoryAbs);

      closeSync(fd);
      fd = next;
    }

    const stats = fstatSync(fd, { bigint: true });

    if (!stats.isDirectory()) {
      throw unsafePath(
        `'${directoryAbs}' is not a directory.`,
        'not-a-directory',
        directoryAbs,
        'Point the tool at a directory inside the project.',
      );
    }

    return { fd, identity: { dev: stats.dev, ino: stats.ino }, enforced };
  } catch (error) {
    // The descriptor in hand is always the one this frame owns: the previous
    // one is closed only after its successor has been opened.
    closeSync(fd);
    throw error;
  }
}

/**
 * The walk behind {@link pinPrivateFileWithinRoot}: from the boundary down to
 * `directoryAbs`, each component opened relative to the one above it with
 * `O_NOFOLLOW`, and each descriptor — the boundary's first — held to the
 * state-directory policy with `fstat`.
 *
 * Judging the descriptor rather than the path is the point: the stats come from
 * the inode this walk is holding, so no later change to any path can make the
 * directory that was judged differ from the directory that is used.
 */
function openPrivateDirectoryChain(
  boundaryAbs: string,
  directoryAbs: string,
): PinnedDirectoryDescriptor {
  const enforced = canAddressDescriptorsAsPaths();
  const parts = relative(boundaryAbs, directoryAbs)
    .split(/[\\/]+/u)
    .filter((part) => part.length > 0);

  // The boundary is opened by its own path — nothing above it is this walk's
  // business — but without following a link at it.
  let fd = openComponent(boundaryAbs, directoryAbs);
  let walked = boundaryAbs;

  try {
    assertDescriptorSecure(fd, walked);

    for (const part of parts) {
      walked = join(walked, part);

      const next = openComponent(enforced ? join(descriptorPath(fd), part) : walked, directoryAbs);

      closeSync(fd);
      fd = next;
      assertDescriptorSecure(fd, walked);
    }

    const stats = fstatSync(fd, { bigint: true });

    return { fd, identity: { dev: stats.dev, ino: stats.ino }, enforced };
  } catch (error) {
    // The descriptor in hand is always the one this frame owns: the previous
    // one is closed only after its successor has been opened.
    closeSync(fd);
    throw error;
  }
}

/**
 * Holds one open directory descriptor of a private walk to the state-directory
 * policy: a directory, owned by this account, with no group or other bits.
 *
 * @throws {DebuggenError} With code `FS_UNSAFE_PATH` when it fails a test.
 */
function assertDescriptorSecure(fd: number, componentAbs: string): void {
  const stats = fstatSync(fd);

  if (!stats.isDirectory()) {
    throw unsafePath(
      `'${componentAbs}' exists but is not a directory.`,
      'not-a-directory',
      componentAbs,
      'Move or remove that entry so a directory can take its place.',
    );
  }

  assertOwnershipAndMode(componentAbs, stats, true);
}

/**
 * Opens one component of a pinned walk, translating the platform's refusal of a
 * symbolic link into this module's own.
 *
 * `O_NOFOLLOW` on a directory open reports `ELOOP` on some platforms and
 * `ENOTDIR` on others when it meets a link, because the link is not a
 * directory. Both mean the same thing here and both become
 * `FS_UNSAFE_PATH`/`symlink-component`, the vocabulary {@link assertSecureDir}
 * already uses, so a caller has one reason to handle rather than two errnos to
 * decode.
 */
function openComponent(componentPath: string, directoryAbs: string): number {
  try {
    return openSync(componentPath, constants.O_RDONLY | directoryFlag() | noFollowFlag());
  } catch (error) {
    const code = errnoCodeOf(error);

    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw unsafePath(
        `A component of '${directoryAbs}' is a symbolic link or is not a directory, so the path cannot be pinned.`,
        'symlink-component',
        directoryAbs,
        'Replace the link with a real directory, or point the tool at a location that is not reached through a link.',
      );
    }

    throw error;
  }
}

/** Whether a path names a Windows drive or share rather than a POSIX root. */
function isWindowsRooted(pathAbs: string): boolean {
  return /^([A-Za-z]:|[\\/]{2})/u.test(pathAbs);
}

/** The path that addresses an open descriptor, on a platform that has one. */
function descriptorPath(fd: number): string {
  return `${DESCRIPTOR_DIRECTORY}/${String(fd)}`;
}

/**
 * Whether this platform lets an open descriptor be addressed as a path, probed
 * once.
 *
 * Linux's `/proc/self/fd/<n>` is what gives the walk above `openat` semantics
 * without a native addon: a path beginning there is resolved from the *inode*
 * the descriptor holds. The probe opens a directory this module knows exists,
 * compares what the descriptor path reports against what the descriptor
 * reports, and caches the answer; it is deliberately a capability test rather
 * than a check of `process.platform`, and it runs on first use so that
 * importing this module still touches nothing.
 */
function canAddressDescriptorsAsPaths(): boolean {
  if (descriptorPathsUsable === undefined) {
    descriptorPathsUsable = probeDescriptorPaths();
  }

  return descriptorPathsUsable;
}

/**
 * Performs the probe {@link canAddressDescriptorsAsPaths} caches.
 *
 * The filesystem root is the probe subject, because it exists on every host
 * this can run on and needs no temporary directory — which keeps the probe
 * free of any write and of any further import.
 */
function probeDescriptorPaths(): boolean {
  let fd: number | undefined;

  try {
    fd = openSync('/', constants.O_RDONLY | directoryFlag());
    const viaDescriptor = statSync(descriptorPath(fd), { bigint: true });
    const viaHandle = fstatSync(fd, { bigint: true });

    return viaDescriptor.dev === viaHandle.dev && viaDescriptor.ino === viaHandle.ino;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to report: the probe's answer is already decided.
      }
    }
  }
}

/** What the target must still be for {@link atomicReplaceFileIfUnchanged} to write. */
export interface AtomicReplaceExpectation {
  /**
   * The bytes the target must still hold, compared byte for byte.
   *
   * The authoritative half of the condition. No normalisation of any kind: CRLF
   * and LF content differ, a byte-order mark is content, and a file that is not
   * valid UTF-8 compares like any other — because the caller's reason for
   * writing was computed from exactly these bytes.
   */
  readonly bytes: Uint8Array;

  /**
   * The identity the target must still have, when the caller observed one.
   *
   * Supply it — {@link readFileSnapshotNoFollow} hands it over — and a file
   * replaced by a different one with identical content is refused too. Omit it
   * and the condition is content only, which is weaker and says so.
   */
  readonly identity?: FileIdentity | undefined;
}

/**
 * Why {@link atomicReplaceFileIfUnchanged} did not write.
 *
 * - `content-changed` — something rewrote the file's bytes.
 * - `identity-changed` — the entry at that path is a different file now, or has
 *   become a symbolic link.
 * - `target-missing` — nothing is at that path any more.
 */
export type AtomicReplaceStaleReason = 'content-changed' | 'identity-changed' | 'target-missing';

/** The outcome of a conditional replacement. */
export type AtomicReplaceVerdict =
  | {
      /** The condition held and the target now holds the new bytes. */
      readonly kind: 'replaced';
    }
  | {
      /** The condition no longer held, and **nothing was written**. */
      readonly kind: 'stale';

      /** Which part of the condition failed. See {@link AtomicReplaceStaleReason}. */
      readonly reason: AtomicReplaceStaleReason;

      /**
       * Where the entry that was displaced from the target path is, when it
       * could not be put back.
       *
       * Present only in the one pathological interleaving described on
       * {@link atomicReplaceFileIfUnchanged}: the entry at the target was
       * retained under a temporary name, found not to be the expected one, and
       * then could not be restored because something else had appeared at the
       * target meanwhile. Both files exist and neither was destroyed; a caller
       * that sees this must tell the developer where the retained one is.
       */
      readonly retainedAt?: string;
    };

/**
 * The refusal half of {@link AtomicReplaceVerdict}, named so that the helpers
 * that can only produce a refusal say so in their signatures.
 */
export type AtomicReplaceStaleVerdict = Extract<AtomicReplaceVerdict, { kind: 'stale' }>;

/** Extra behaviour for {@link atomicReplaceFileIfUnchanged}. */
export interface AtomicReplaceOptions {
  /**
   * Invoked once the precondition has held and the displaced entry has been
   * retained, immediately before the new entry is installed.
   *
   * It exists so that the one interval this function cannot make atomic can be
   * *tested*: a suite passes a callback that writes to the target path, and the
   * install below must then refuse rather than discard what the callback
   * created. Production callers pass nothing. A throw from it propagates, after
   * the same cleanup a failing write receives.
   */
  readonly onBeforeInstall?: (() => void) | undefined;
}

/**
 * Replaces a file atomically **only if it is still what the caller last read**,
 * preserving the mode it already had.
 *
 * {@link atomicReplaceFile} with a precondition, and the difference matters
 * wherever the replacement was computed from the file's previous content. An
 * unconditional `rename` over a path is a write that cannot fail: it discards
 * whatever is there, including an edit a developer made in the seconds between
 * the read and the write, with no trace that anything was lost. That is
 * CWE-367, and for this product it is the difference between "temporarily
 * instrumented, fully reversible" and "silently destroyed the developer's
 * work".
 *
 * ## Sequence
 *
 * 1. The target's mode and kind are read with `lstat`. Nothing there →
 *    `target-missing`; a symbolic link, or an inode other than the expected one
 *    → `identity-changed`. Neither creates anything.
 * 2. An unpredictably named temporary sibling is created in the same directory
 *    at the target's own mode, written and flushed — the expensive part, and
 *    deliberately *before* the check below.
 * 3. The target is re-read through a no-follow descriptor and compared against
 *    {@link AtomicReplaceExpectation}: the identity first, then every byte. A
 *    mismatch removes the temporary file and returns `stale` **without
 *    touching the target**.
 * 4. The entry at the target is **retained**: `rename`d aside to a second
 *    temporary name, which is atomic, so nothing at that path is ever
 *    destroyed. It is then inspected — if it is not the expected entry after
 *    all, a write landed between steps 3 and 4, and it is put back and reported
 *    rather than lost.
 * 5. The new entry is installed with `link`, which **fails if anything exists
 *    at the target**. A write that created a file at the target between step 4
 *    and here is therefore refused rather than discarded.
 * 6. The temporary names are dropped and the directory entry is flushed best
 *    effort.
 *
 * ## Why not one rename
 *
 * `rename` over a path is a write that cannot fail: the destination, whatever
 * it has become since it was compared, is discarded. Compare-then-rename
 * therefore still loses a write that lands in between, and loses it *silently*
 * — the only outcome this product may never produce. POSIX offers no
 * compare-and-swap `rename` (`renameat2`'s `RENAME_EXCHANGE` and
 * `RENAME_NOREPLACE` are Linux-only and are not in Node's `fs`), so the swap is
 * built from the two primitives that *can* refuse: `rename`, which retains what
 * it displaces, and `link`, which will not overwrite. The result is that **no
 * entry at the target path is destroyed without first being retained and
 * inspected**, at any interleaving.
 *
 * What remains is not a loss but a visible gap: between steps 4 and 5 the
 * target path does not exist, for the duration of two adjacent syscalls. A
 * watcher polling in that instant sees the file disappear and reappear, where a
 * plain rename would have shown one modification. That is the trade this
 * function makes deliberately — a transient, self-healing observation in
 * exchange for the impossibility of silent data loss.
 *
 * ## Crash behaviour
 *
 * A crash before step 4 leaves the target untouched and a temporary file
 * behind. A crash between 4 and 5 leaves the target absent and its content
 * under the retained temporary name in the same directory — recoverable by
 * hand, and for this product's use also present in the recorded backup, which
 * is written and flushed before the replacement is attempted. Any failure this
 * function can observe itself removes what it created, restores what it
 * retained, and rethrows the original error.
 *
 * @param path The file to replace. It must already exist; this function refuses
 * to create one, because a precondition about content has no meaning otherwise.
 * @param data The bytes to write, verbatim, or text encoded as UTF-8.
 * @param expected What the target must still be. See
 * {@link AtomicReplaceExpectation}.
 * @param options The install-boundary seam. See {@link AtomicReplaceOptions}.
 * @returns `replaced` when the condition held, or `stale` with the reason it
 * did not. **A `stale` verdict guarantees the target was not written**, and
 * carries `retainedAt` in the one interleaving where the displaced entry could
 * not be put back.
 * @throws The runtime's own filesystem error, with its `code` intact, for a
 * genuine I/O failure: `EACCES` when the directory cannot be written, `EISDIR`
 * when the target is a directory, `ENOSPC` when the write cannot complete. No
 * policy error is raised — this function asserts no directory policy, for the
 * reason given on {@link atomicReplaceFile}.
 *
 * @example
 * ```ts
 * const before = readFileSnapshotNoFollow(absoluteSourcePath);
 * const verdict = atomicReplaceFileIfUnchanged(absoluteSourcePath, instrumented, before);
 * if (verdict.kind === 'stale') {
 *   return reportConflict(verdict.reason); // the file still holds the developer's bytes
 * }
 * ```
 */
export function atomicReplaceFileIfUnchanged(
  path: string,
  data: string | Uint8Array,
  expected: AtomicReplaceExpectation,
  options?: AtomicReplaceOptions,
): AtomicReplaceVerdict {
  const targetAbs = resolve(path);
  const entry = existingEntryFor(targetAbs, expected.identity);

  if (entry.kind === 'stale') {
    return entry;
  }

  const tempAbs = temporarySiblingPath(targetAbs);
  const retainedAbs = temporarySiblingPath(targetAbs);
  let retained = false;

  try {
    // The parent's suitability is the caller's decision — a developer's project
    // directory is an ordinary 0755 this product did not create — so the
    // temporary sibling does not re-ask, exactly as `writeThenRename` does not.
    createFileExclusive(tempAbs, data, { mode: entry.mode, requireSecureParents: false });

    const stale = staleVerdictFor(targetAbs, expected);

    if (stale !== undefined) {
      removeQuietly(tempAbs);
      return stale;
    }

    // Step 4. Atomic, so whatever is at the target now exists under
    // `retainedAbs` and nowhere else — it cannot be destroyed by anything that
    // follows, including a failure in this frame.
    renameSync(targetAbs, retainedAbs);
    retained = true;

    // Which is what makes this check meaningful rather than another guess: it
    // inspects the entry that was actually taken, not the one at a path that
    // may have changed again since.
    const displaced = staleVerdictFor(retainedAbs, expected);

    if (displaced !== undefined) {
      removeQuietly(tempAbs);
      return restoreRetained(retainedAbs, targetAbs, displaced);
    }

    options?.onBeforeInstall?.();

    // Step 5. `link` refuses to overwrite, so a file created at the target
    // since step 4 is reported rather than discarded. The retained entry is the
    // expected one, and the caller holds its bytes in `expected.bytes`, so
    // dropping it loses nothing.
    if (!installByLink(tempAbs, targetAbs)) {
      removeQuietly(tempAbs);
      removeQuietly(retainedAbs);
      return { kind: 'stale', reason: 'identity-changed' };
    }

    removeQuietly(tempAbs);
    removeQuietly(retainedAbs);
  } catch (error) {
    // `EEXIST` can only come from the exclusive create, and only when something
    // already occupied the path, so removing it would delete a file this
    // process never created. See `writeThenRename` for the same reasoning.
    if (errnoCodeOf(error) !== 'EEXIST') {
      removeQuietly(tempAbs);
    }

    // A failure after the retention must not leave the target absent: the
    // entry goes back where it came from before the error is rethrown.
    if (retained) {
      restoreRetained(retainedAbs, targetAbs, { kind: 'stale', reason: 'identity-changed' });
    }

    throw error;
  }

  syncDirectoryQuietly(dirname(targetAbs));

  return { kind: 'replaced' };
}

/**
 * Installs the prepared entry at the target path without overwriting anything.
 *
 * `link` is the only install primitive that refuses an existing destination, so
 * it — and not `rename` — is what turns "install the replacement" into an
 * operation that cannot discard a file someone else created in the meantime.
 * The temporary name is dropped by the caller afterwards, leaving the new entry
 * with a single name.
 *
 * @returns `true` when the entry was installed, `false` when something already
 * occupied the target.
 */
function installByLink(tempAbs: string, targetAbs: string): boolean {
  try {
    linkSync(tempAbs, targetAbs);
    return true;
  } catch (error) {
    if (errnoCodeOf(error) === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

/**
 * Puts a retained entry back at the target path, and reports what happened.
 *
 * Restored with `link` rather than `rename` for the same reason the install
 * uses it: if something has appeared at the target since the retention, a
 * rename would destroy *that*, and this function's whole purpose is that
 * nothing is destroyed. When the target is occupied the retained entry stays
 * where it is and its path travels on the verdict, so the caller can tell the
 * developer where their content went instead of leaving them to find it.
 */
function restoreRetained(
  retainedAbs: string,
  targetAbs: string,
  verdict: AtomicReplaceStaleVerdict,
): AtomicReplaceVerdict {
  if (installByLink(retainedAbs, targetAbs)) {
    removeQuietly(retainedAbs);
    return verdict;
  }

  return { ...verdict, retainedAt: retainedAbs };
}

/** The outcome of {@link atomicCreateFileNoClobber}. */
export type AtomicCreateVerdict =
  | {
      /** Nothing was at the path, and it now holds the new bytes in full. */
      readonly kind: 'created';
    }
  | {
      /**
       * Something already occupied the path — a regular file, a directory, a
       * symbolic link, even a dangling one — and **nothing was written**: the
       * entry that is there is exactly as it was found.
       */
      readonly kind: 'exists';
    };

/** Options for {@link atomicCreateFileNoClobber}. */
export interface AtomicCreateOptions {
  /**
   * The mode the created file is given. Defaults to `0o644`, the mode
   * {@link atomicReplaceFile} gives a file it creates.
   *
   * Applied with `fchmod` as well as `open`, as {@link createFileExclusive}
   * does, so the result does not depend on the process umask.
   */
  readonly mode?: number | undefined;

  /**
   * Invoked once the new content is complete and flushed under its temporary
   * name, immediately before it is installed at the target.
   *
   * The same seam {@link AtomicReplaceOptions.onBeforeInstall} provides, for
   * the same reason: the window between "the target was absent" and "the new
   * entry is installed" is the one this function exists to make safe, and a
   * suite passes a callback that creates a file at the target to prove the
   * install then refuses rather than discards it. Production callers pass
   * nothing. A throw from it propagates, after the temporary file is removed.
   */
  readonly onBeforeInstall?: (() => void) | undefined;
}

/**
 * Creates a file atomically **only if nothing is at the path**, and reports
 * rather than overwrites an entry that is.
 *
 * The creation counterpart of {@link atomicReplaceFileIfUnchanged}, for the one
 * case that function refuses: a target that is absent. A restore that finds a
 * developer's file deleted recreates it from the recorded original, and a
 * developer can recreate the same file — from version control, from their
 * editor's undo — between the moment it was observed missing and the moment
 * the restore writes. {@link atomicReplaceFile} would rename over that new file
 * and discard it with no trace (CWE-367). This function cannot: the install is
 * a `link`, which fails when the destination exists, so the developer's file
 * wins and the caller is told the path is occupied.
 *
 * ## Sequence
 *
 * 1. `lstat` the target. Anything there → `exists`, and no temporary file is
 *    written for a creation already known to be refused.
 * 2. An unpredictably named temporary sibling is created exclusively in the
 *    same directory at the requested mode, written in full and flushed — so the
 *    content is durable before it has the target's name.
 * 3. The temporary file is installed at the target with `link`. `EEXIST` means
 *    something appeared at the target since step 1: nothing is overwritten and
 *    the verdict is `exists`.
 * 4. The temporary name is dropped and the directory entry is flushed best
 *    effort.
 *
 * Why not `open(O_CREAT | O_EXCL)` on the target itself: that is no-clobber,
 * but the file would be visible — to a dev server's watcher, to an editor —
 * while its bytes are still being written, and a crash part-way through would
 * leave a truncated file at the developer's path. Creating under a temporary
 * name and linking gives both properties at once: the target either does not
 * exist or holds the complete content, and an occupied target is never touched.
 *
 * ## Crash behaviour
 *
 * A crash before step 3 leaves the target absent and a temporary file behind; a
 * crash after it leaves the complete target and, at worst, a second name for it
 * under the temporary one. Neither leaves a partial file at the target. Any
 * failure this function can observe removes the temporary file it created and
 * rethrows the original error.
 *
 * ## Symlinks
 *
 * A symbolic link at the target — dangling or not — is an occupied target:
 * `lstat` reports it in step 1, and `link` refuses it in step 3 without
 * following it. Nothing is ever written through a link. As with every project
 * writer in this module, no directory policy is asserted: the parent is a
 * developer's ordinary `0755` directory, and the caller has already decided it
 * is the right one.
 *
 * @param path The file to create. It must not exist.
 * @param data Text, encoded as UTF-8, or bytes written verbatim.
 * @param opts `mode` for the new file, and the install-boundary seam.
 * @returns `created` when the file now holds `data`, or `exists` when the path
 * was occupied — in which case **nothing was written**.
 * @throws The runtime's own filesystem error, with its `code` intact: `ENOENT`
 * when the parent directory does not exist, `EACCES` when it cannot be written,
 * `ENOSPC` when the write cannot complete, and `EPERM`/`ENOTSUP` on a
 * filesystem that does not support hard links — in every one of those cases
 * nothing is left at the target.
 *
 * @example
 * ```ts
 * const verdict = atomicCreateFileNoClobber(absoluteSourcePath, originalBytes);
 * if (verdict.kind === 'exists') {
 *   return reportConflict(); // the developer's new file is untouched
 * }
 * ```
 */
export function atomicCreateFileNoClobber(
  path: string,
  data: string | Uint8Array,
  opts?: AtomicCreateOptions,
): AtomicCreateVerdict {
  const targetAbs = resolve(path);

  if (isKnownToExist(targetAbs)) {
    return { kind: 'exists' };
  }

  const tempAbs = temporarySiblingPath(targetAbs);
  let installed: boolean;

  try {
    // The parent's suitability is the caller's decision, exactly as it is for
    // the other project writers, so the temporary sibling does not re-ask.
    createFileExclusive(tempAbs, data, {
      mode: opts?.mode ?? DEFAULT_REPLACEMENT_FILE_MODE,
      requireSecureParents: false,
    });

    opts?.onBeforeInstall?.();

    // `link` refuses an occupied destination, so a file created at the target
    // since the check above is reported rather than discarded.
    installed = installByLink(tempAbs, targetAbs);
  } catch (error) {
    // `EEXIST` can only come from the exclusive create — `installByLink` turns
    // its own into `false` — and only when something already occupied the
    // temporary path, so removing it would delete a file this process never
    // created. See `writeThenRename` for the same reasoning.
    if (errnoCodeOf(error) !== 'EEXIST') {
      removeQuietly(tempAbs);
    }

    throw error;
  }

  // Installed or refused, the temporary name has served its purpose: after a
  // successful link it is a second name for the new target, and after a refusal
  // it is the only name of content nobody will use.
  removeQuietly(tempAbs);

  if (!installed) {
    return { kind: 'exists' };
  }

  syncDirectoryQuietly(dirname(targetAbs));

  return { kind: 'created' };
}

/** What {@link existingEntryFor} found: a usable regular file, or a refusal. */
type ExistingEntry = { readonly kind: 'file'; readonly mode: number } | AtomicReplaceStaleVerdict;

/**
 * Establishes that the target is a regular file this replacement may proceed
 * against, and reads the mode to give the temporary sibling.
 *
 * `lstat`, never `stat`: a symbolic link that appeared at the target is a
 * changed target, and following it would read the mode of something else
 * entirely and then write a file the caller never named. It is reported as
 * `identity-changed` rather than as an error because that is what it is — the
 * entry at that path is no longer the file the caller read.
 *
 * The inode comparison here is an early exit, not the decision: the
 * authoritative check is {@link staleVerdictFor}, which runs immediately before
 * the rename. Failing fast simply avoids writing a temporary file for a
 * replacement that is already known to be refused.
 */
function existingEntryFor(targetAbs: string, identity: FileIdentity | undefined): ExistingEntry {
  let stats;

  try {
    // `{ bigint: true }`, so the inode comparison below is exact: see
    // {@link FileIdentity} for why a rounded inode number is the dangerous
    // direction of that comparison.
    stats = lstatSync(targetAbs, { bigint: true });
  } catch (error) {
    if (errnoCodeOf(error) === 'ENOENT') {
      return { kind: 'stale', reason: 'target-missing' };
    }
    throw error;
  }

  if (!stats.isFile()) {
    return { kind: 'stale', reason: 'identity-changed' };
  }

  if (identity !== undefined && !isSameFile(identity, stats)) {
    return { kind: 'stale', reason: 'identity-changed' };
  }

  return { kind: 'file', mode: Number(stats.mode) & PERMISSION_BITS };
}

/**
 * Re-reads the target and reports which part of the expectation no longer
 * holds, or `undefined` when all of it does.
 *
 * Called as late as the sequence allows — after the temporary file is written
 * and flushed, immediately before the rename — because every instruction
 * between this check and that rename is window in which a change goes
 * unnoticed.
 *
 * `ELOOP` and `ENOENT` are answers rather than failures here: a link or a
 * deletion arriving at the target after it was read is precisely the change the
 * condition exists to catch, and reporting them as `stale` keeps the caller's
 * one code path — refuse, and report a conflict — instead of making it decode
 * an errno to find out whether anything was written.
 */
function staleVerdictFor(
  targetAbs: string,
  expected: AtomicReplaceExpectation,
): AtomicReplaceStaleVerdict | undefined {
  let snapshot: FileSnapshot;

  try {
    snapshot = readFileSnapshotNoFollow(targetAbs);
  } catch (error) {
    const code = errnoCodeOf(error);

    if (code === 'ENOENT') {
      return { kind: 'stale', reason: 'target-missing' };
    }

    if (code === 'ELOOP') {
      return { kind: 'stale', reason: 'identity-changed' };
    }

    throw error;
  }

  if (expected.identity !== undefined && !sameIdentity(expected.identity, snapshot.identity)) {
    return { kind: 'stale', reason: 'identity-changed' };
  }

  if (
    snapshot.bytes.byteLength !== expected.bytes.byteLength ||
    Buffer.compare(snapshot.bytes, expected.bytes) !== 0
  ) {
    return { kind: 'stale', reason: 'content-changed' };
  }

  return undefined;
}

/** Whether two observations name the same inode on the same device. */
function sameIdentity(expected: FileIdentity, actual: FileIdentity): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

/** Whether a `stat` result names the same inode as a recorded identity. */
function isSameFile(expected: FileIdentity, stats: FileIdentity): boolean {
  return sameIdentity(expected, { dev: stats.dev, ino: stats.ino });
}
