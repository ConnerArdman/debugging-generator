#!/usr/bin/env node
/**
 * copy-agent — install the browser telemetry agent bundle into the Chrome
 * extension, byte for byte.
 *
 * Source: `packages/telemetry/dist/browser-agent.iife.js`, produced by
 * `packages/telemetry/esbuild.agent.mjs` during that package's `build`.
 * Target: `apps/chrome-extension/public/agent.iife.js`.
 *
 * Why a copy instead of an import: `apps/chrome-extension/manifest.config.ts`
 * declares the target file *verbatim* as a content script with
 * `world: "MAIN"`, `run_at: "document_start"` and `all_frames: false`, matched
 * to `http://localhost/*` and `http://127.0.0.1/*`. Chrome loads that script
 * from disk before the page's own scripts run, which is what lets the agent
 * install bippy's React DevTools hook before React loads, so the bundle has to
 * *be* a file inside the extension. Copying it — rather than importing
 * `@debuggen/telemetry` from extension code — also keeps the two workspaces
 * from depending on each other at runtime: the agent bundle is self-contained
 * and imports none of the extension's or the protocol package's code.
 *
 * Why byte for byte: any transformation (re-minification, a banner, a BOM,
 * CRLF translation, rewriting the trailing `//# sourceMappingURL=` comment)
 * risks changing how the agent loads, and would desynchronise this file from
 * the bytes `@crxjs/vite-plugin` republishes verbatim out of `public/`. This
 * script only ever moves bytes; it never edits them.
 *
 * Why the destination is never trusted: every path written here is generated
 * output under `apps/chrome-extension/public/`, the directory
 * `@crxjs/vite-plugin` republishes verbatim into the packed extension. If a
 * component of that path may be a symbolic link, then whoever planted the link
 * — a stale generated tree, an unpacked archive, another tool's convenience
 * symlink — chooses which file the agent's bytes overwrite, and the run looks
 * entirely successful afterwards because every check reads back through the
 * same link (CWE-22). So: the destination is inspected with `lstat` (never
 * `stat`, which reports the link's *target* and therefore calls a link a
 * regular file) before a single byte is compared or written, in `--check` mode
 * as well; every destination read opens with `O_NOFOLLOW`; and every write
 * lands on a freshly created `O_EXCL | O_NOFOLLOW` temporary file inside the
 * verified directory which is then `rename`d over the target, because `rename`
 * replaces a symbolic link instead of following it.
 *
 * The target is git-ignored: the extension's `prebuild`/`predev` hook
 * regenerates it on every build, and it is never committed.
 *
 * Usage: `node scripts/copy-agent.mjs [--check] [--quiet]`, or `--help`.
 *
 * @module scripts/copy-agent
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Repository root, derived from this module's own location rather than from
 * `process.cwd()`: pnpm runs a `prebuild` hook with the *workspace* as the
 * working directory (`apps/chrome-extension`), so a cwd-relative path would
 * resolve differently depending on who invoked the script.
 *
 * @type {string}
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Repository-relative path of the bundle emitted by the telemetry build. */
export const SOURCE_REL = 'packages/telemetry/dist/browser-agent.iife.js';

/** Repository-relative path the Chrome extension manifest declares. */
export const TARGET_REL = 'apps/chrome-extension/public/agent.iife.js';

/** Suffix esbuild appends to the bundle for its external source map. */
const MAP_SUFFIX = '.map';

/**
 * Names under which a sibling source map is written next to the target.
 *
 * Two names, deliberately: the copied bundle keeps esbuild's trailing
 * `//# sourceMappingURL=browser-agent.iife.js.map` comment — editing those
 * bytes would break the byte-for-byte guarantee — so the map is written both
 * under the name that comment resolves to and under the name derived from the
 * copied bundle, which is what tooling that renames maps alongside scripts
 * looks for. Nothing inside the map is ever rewritten.
 */
const TARGET_MAP_NAMES = ['agent.iife.js.map', 'browser-agent.iife.js.map'];

/** Everything is in place (copied, already identical, or `--check` passed). */
const EXIT_OK = 0;

/** `--check` found the target missing or out of date. */
const EXIT_DRIFT = 1;

/** Source bundle missing, unusable target path, I/O failure, or bad usage. */
const EXIT_ERROR = 2;

/**
 * Failure carrying the exit code the CLI should use plus, where one exists, a
 * multi-line hint that states exactly how to recover.
 */
export class CopyAgentError extends Error {
  /**
   * @param {string} message single-line description of what went wrong
   * @param {{ hint?: string, showUsage?: boolean }} [options] recovery detail
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'CopyAgentError';
    /** @type {number} process exit code that corresponds to this failure */
    this.exitCode = EXIT_ERROR;
    /** @type {string | undefined} multi-line recovery instructions */
    this.hint = options.hint;
    /** @type {boolean} whether the CLI should print full usage as well */
    this.showUsage = options.showUsage === true;
  }
}

/**
 * Narrow an unknown thrown value to "has this errno code".
 *
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
function isErrnoCode(error, code) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    /** @type {{ code?: unknown }} */ (error).code === code
  );
}

/**
 * Wrap an unexpected filesystem failure as an exit-2 `CopyAgentError`.
 *
 * @param {string} what
 * @param {unknown} cause
 * @returns {CopyAgentError}
 */
function ioError(what, cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CopyAgentError(`${what}: ${detail}`);
}

/**
 * Convert a platform path to POSIX separators for stable output.
 *
 * @param {string} value
 * @returns {string}
 */
function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * Render an absolute path for humans: repository-relative and POSIX-separated
 * when it lives inside the root, absolute otherwise.
 *
 * @param {string} root
 * @param {string} absolute
 * @returns {string}
 */
function display(root, absolute) {
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative))
    return toPosix(absolute);
  return toPosix(relative);
}

/**
 * Hex SHA-256 of a buffer. Used to verify the copy after writing it, so a
 * truncated or partially written target is reported instead of shipped.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Read a file as a Buffer, or `undefined` when it does not exist. Any other
 * failure becomes an exit-2 `CopyAgentError` with the underlying reason.
 *
 * Follows symbolic links, which makes this the reader for the SOURCE side
 * only: resolving a link on a path the caller asked to read *is* the copy's
 * semantics, and the source tree is this repository's own build output. Every
 * read of a DESTINATION path goes through {@link readNoFollow} instead, where
 * a link is not a convenience but a choice of victim.
 *
 * @param {string} file
 * @returns {Buffer | undefined}
 */
function readOptional(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return undefined;
    if (isErrnoCode(error, 'EISDIR')) {
      throw new CopyAgentError(`expected a file but found a directory: ${file}`);
    }
    throw ioError(`could not read ${file}`, error);
  }
}

/**
 * Explain a missing agent bundle and how to produce it. Deliberately verbose:
 * this is the failure a developer hits on a clean clone, and the fix depends
 * on build ordering that is not obvious from the error alone.
 *
 * @param {string} root
 * @param {string} source
 * @returns {CopyAgentError}
 */
function missingSourceError(root, source) {
  return new CopyAgentError(`the agent bundle has not been built: ${display(root, source)}`, {
    hint: [
      'Build the telemetry package first:',
      '',
      '  pnpm --filter @debuggen/telemetry build',
      '',
      'That runs packages/telemetry/esbuild.agent.mjs, which emits the',
      'bundle. apps/chrome-extension declares @debuggen/telemetry as a',
      'workspace devDependency purely so that `pnpm -r build` builds',
      'telemetry before the extension, and this script runs from the',
      'extension\'s "prebuild"/"predev" hook, which fires only while',
      "pnpm's pre/post scripts are enabled - pnpm-workspace.yaml",
      'declares `enablePrePostScripts: true`, which is also the',
      'default; with them disabled, run this script by hand before',
      '`vite build`.',
      '',
      'Nothing was written. An empty placeholder would produce a Chrome',
      'extension that loads and captures nothing, which is far harder to',
      'diagnose than this failure.',
    ].join('\n'),
  });
}

/**
 * Read and sanity-check the source bundle. A zero-byte or non-regular file is
 * rejected for the same reason a placeholder is never written: a silently
 * empty agent captures nothing and looks like a product bug rather than a
 * build failure.
 *
 * @param {string} root
 * @param {string} source
 * @returns {Buffer}
 */
function readSourceBundle(root, source) {
  /** @type {fs.Stats} */
  let stats;
  try {
    stats = fs.statSync(source);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) throw missingSourceError(root, source);
    throw ioError(`could not stat ${display(root, source)}`, error);
  }

  if (!stats.isFile()) {
    throw new CopyAgentError(`the agent bundle is not a regular file: ${display(root, source)}`, {
      hint: 'Remove whatever occupies that path and rebuild the telemetry package.',
    });
  }

  const buffer = readOptional(source);
  if (buffer === undefined) throw missingSourceError(root, source);

  if (buffer.byteLength === 0) {
    throw new CopyAgentError(`the agent bundle is empty: ${display(root, source)}`, {
      hint: [
        'The telemetry build produced a zero-byte bundle, so the agent',
        'would load in Chrome and capture nothing. Rebuild it and check',
        'packages/telemetry/esbuild.agent.mjs for a failed build:',
        '',
        '  pnpm --filter @debuggen/telemetry build',
      ].join('\n'),
    });
  }

  return buffer;
}

/**
 * `lstat` a path, or `undefined` when nothing is there (`ENOENT`, or `ENOTDIR`
 * from a non-directory earlier in the path).
 *
 * `lstat`, never `stat`: this function's answers drive every destination
 * guard below, and `stat` follows symbolic links, so it describes the link's
 * *target*. A planted link then answers `isFile()` with `true` and the
 * "not a regular file" guard it exists to trip never fires — which is exactly
 * how a symlinked `agent.iife.js` used to redirect this copy onto an
 * arbitrary file. Reporting the link itself is the whole point.
 *
 * Any other failure (a permission problem on a parent, an I/O error) is
 * surfaced as exit 2 rather than silently read as "nothing there": a guard
 * that cannot see a path must not conclude the path is safe.
 *
 * @param {string} file
 * @returns {fs.Stats | undefined} the link's own stats, not its target's
 * @throws {CopyAgentError} when the path exists but cannot be inspected
 */
function lstatOptional(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return undefined;
    throw ioError(`could not inspect ${file}`, error);
  }
}

/**
 * The `--help` text, also printed to stderr on a usage error. It names both
 * paths, the build ordering that produces the source, and the source-map
 * behaviour, because those are the three things that surprise people here.
 *
 * @returns {string}
 */
export function usage() {
  return `copy-agent — copy the browser agent bundle into the Chrome extension

Usage
  node scripts/copy-agent.mjs [--check] [--quiet]
  node scripts/copy-agent.mjs --help

Copies, byte for byte
  from  ${SOURCE_REL}
  to    ${TARGET_REL}

apps/chrome-extension/manifest.config.ts declares the target verbatim as a
content script with world "MAIN", run_at "document_start" and all_frames
false, matched to http://localhost/* and http://127.0.0.1/*, so the bundle
must reach Chrome unmodified: nothing here re-minifies, re-encodes, adds a
banner or normalises line endings.

Build ordering
  The Chrome extension runs this script from its "prebuild" and "predev"
  hooks, so \`pnpm --filter @debuggen/chrome-extension build\` refreshes the
  copy before Vite reads public/. The bundle itself comes from
  \`pnpm --filter @debuggen/telemetry build\`, which runs
  packages/telemetry/esbuild.agent.mjs; apps/chrome-extension declares
  @debuggen/telemetry as a workspace devDependency purely so that
  \`pnpm -r build\` builds telemetry first. The hook fires only while pnpm's
  pre/post scripts are enabled: pnpm-workspace.yaml declares
  \`enablePrePostScripts: true\`, which is also the default. With them
  disabled, run this script by hand before \`vite build\`.

Source maps
  When ${SOURCE_REL}${MAP_SUFFIX}
  exists it is copied next to the target under BOTH ${TARGET_MAP_NAMES[0]}
  and ${TARGET_MAP_NAMES[1]}, because the copied bundle keeps esbuild's
  trailing //# sourceMappingURL=${TARGET_MAP_NAMES[1]} comment and editing
  those bytes would break the byte-for-byte guarantee. Map contents are
  never rewritten.

Options
  --check   verify the target exists and is byte-identical to the source
            without writing anything; exits 1 when it has drifted
  --quiet   suppress the success line; failures are still reported
  --help    print this text

Target path safety
  Nothing is ever written through a symbolic link. Before a byte is compared
  or written — with --check too — every directory component from the
  repository root down to the target's directory, the target itself and both
  source-map names are inspected with lstat; a symbolic link or a
  non-regular file at any of them exits 2 naming the path (and, for a link,
  what it points at) rather than reporting drift, because "re-run without
  --check" is no fix for a link that decides which file gets overwritten:
  remove whatever occupies that path. Writes land on a freshly created
  temporary file inside that verified directory and are renamed over the
  target, which replaces a link instead of following it.

Exit codes
  0  copied, already identical, or verified with --check
  1  --check found drift; re-run without --check to refresh the copy
  2  the source bundle is missing or empty, the target path is unusable (a
     symbolic link or a non-regular file at the target, either of its
     source-map names, or a directory component below the repository root),
     an I/O error occurred, or the arguments were not understood

Both paths resolve from the repository root inferred from this script's own
location, so the result is identical from any working directory. The target
is git-ignored and regenerated on every build; it is never committed.`;
}

/**
 * @typedef {object} CopyAgentOptions
 * @property {boolean} check verify only, never write
 * @property {boolean} quiet suppress the success line
 * @property {boolean} help print usage instead of doing anything
 */

/**
 * Parse the CLI flags. The script takes no positional arguments, so anything
 * unrecognised is a usage error rather than a silently ignored token.
 *
 * @param {readonly string[]} argv arguments after the script path
 * @returns {CopyAgentOptions}
 * @throws {CopyAgentError} on an unrecognised argument (exit code 2)
 */
export function parseArgs(argv) {
  /** @type {CopyAgentOptions} */
  const options = { check: false, quiet: false, help: false };

  for (const arg of argv) {
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--check':
        options.check = true;
        break;
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      default:
        throw new CopyAgentError(`unrecognised argument: ${arg}`, {
          showUsage: true,
        });
    }
  }

  return options;
}

/**
 * Where a symbolic link points, as text, or `undefined` when the link cannot
 * be read. Every rejection message carries it: "the target is a symbolic
 * link" alone leaves the reader guessing which file the run would have
 * overwritten, and that file is the diagnosis.
 *
 * @param {string} link
 * @returns {string | undefined}
 */
function readLinkTarget(link) {
  try {
    return fs.readlinkSync(link);
  } catch {
    return undefined;
  }
}

/**
 * The rejection for a symbolic link anywhere in a destination path.
 *
 * Exit 2 in both modes, `--check` included. `--check`'s exit 1 means "the copy
 * is stale, re-run without --check to refresh it", and re-running is precisely
 * what must not happen while a link chooses where the bytes land; the link is
 * a broken workspace to repair by hand, not drift to reconcile.
 *
 * @param {string} root
 * @param {string} link absolute path of the offending component
 * @param {string} what how that component relates to the copy, for the message
 * @returns {CopyAgentError}
 */
function symlinkError(root, link, what) {
  const destination = readLinkTarget(link);
  const points = destination === undefined ? '' : ` → ${toPosix(destination)}`;

  return new CopyAgentError(`${what} is a symbolic link: ${display(root, link)}${points}`, {
    hint: [
      'Writing through that link would overwrite whatever it points at, and',
      'reading through it would compare the wrong bytes, so nothing was',
      'written and nothing was verified. Remove whatever occupies that path',
      'and re-run the copy:',
      '',
      `  rm ${display(root, link)}`,
      '  node scripts/copy-agent.mjs',
    ].join('\n'),
  });
}

/**
 * Verify every directory component from `root` (exclusive) down to
 * `directory` (inclusive) is a real directory, using `lstat` so a link is seen
 * as a link rather than as whatever it resolves to.
 *
 * The walk never climbs above `root`. `root` is derived from this script's own
 * location, so it is trusted input, and a checkout may legitimately sit under
 * a symlinked ancestor — macOS's `/tmp`, a home directory on a mounted
 * volume, a worktree reached through a convenience link. Everything *below*
 * `root` on this path is either committed or generated by this repository's
 * own tooling, so a link there is never legitimate and is what an attacker (or
 * a careless recovery from a backup) would plant to redirect the write.
 *
 * A missing component ends the walk successfully: nothing below it can exist
 * either, and {@link ensureDirectory} creates the chain with `mkdir`, which
 * follows no link it did not create itself.
 *
 * @param {string} root
 * @param {string} directory absolute path inside `root`
 * @returns {void}
 * @throws {CopyAgentError} exit 2 when a component is a link or not a
 *   directory, or when `directory` does not lie inside `root` at all
 */
function verifyDestinationDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    // Unreachable through the CLI (the target is `root` joined with a fixed
    // relative constant) and rejected anyway: a destination outside `root` is
    // a path this guard has no mandate over, so it must not be written.
    throw new CopyAgentError(
      `the target resolves outside the repository root: ${display(root, directory)}`,
      { hint: 'Run the copy against a repository root that contains the target.' },
    );
  }

  const segments = relative === '' ? [] : relative.split(path.sep);
  let current = root;

  for (const segment of segments) {
    current = path.join(current, segment);
    const stats = lstatOptional(current);
    if (stats === undefined) return;
    if (stats.isSymbolicLink()) {
      throw symlinkError(root, current, 'a directory on the way to the target');
    }
    if (!stats.isDirectory()) {
      throw new CopyAgentError(
        `a directory on the way to the target is not a directory: ${display(root, current)}`,
        { hint: 'Remove whatever occupies that path and re-run the copy.' },
      );
    }
  }
}

/**
 * Verify the final component of a destination path: an existing symbolic link
 * is rejected naming what it points at, an existing non-regular file (a
 * directory, a socket, a device) is rejected, and an absent path is fine —
 * that is the ordinary first run.
 *
 * The parent chain must already have been verified by
 * {@link verifyDestinationDirectory}; on its own this check would still be
 * bypassable through a symlinked parent directory.
 *
 * @param {string} root
 * @param {string} file absolute path whose parents are already verified
 * @param {string} what how the file relates to the copy, for the message
 * @returns {void}
 * @throws {CopyAgentError} exit 2 when the path cannot be written safely
 */
function verifyDestinationFile(root, file, what) {
  const stats = lstatOptional(file);
  if (stats === undefined) return;
  if (stats.isSymbolicLink()) throw symlinkError(root, file, what);
  if (!stats.isFile()) {
    throw new CopyAgentError(`${what} is not a regular file: ${display(root, file)}`, {
      hint: 'Remove whatever occupies that path and re-run the copy.',
    });
  }
}

/**
 * Validate every path this run may write, read back or compare, before it
 * touches a single byte.
 *
 * Runs in `--check` mode too, and before the byte comparison: a drift gate
 * that compares through a symbolic link certifies the link's target as "in
 * sync" and hides exactly the condition it is there to catch.
 *
 * Both source-map names are guarded unconditionally, even when the source
 * build produced no map for this run. Their directory is published verbatim
 * by `@crxjs/vite-plugin`, so a link sitting under either name is a live
 * hazard the moment a map appears, and the copy that would follow it is the
 * same copy.
 *
 * @param {string} root
 * @param {string} target absolute path of the copied bundle
 * @returns {void}
 * @throws {CopyAgentError} exit 2 when any destination path is unusable
 */
function verifyDestinations(root, target) {
  const directory = path.dirname(target);

  verifyDestinationDirectory(root, directory);
  verifyDestinationFile(root, target, 'the target');

  for (const name of TARGET_MAP_NAMES) {
    verifyDestinationFile(root, path.join(directory, name), `the source-map target ${name}`);
  }
}

/**
 * `O_NOFOLLOW` where the platform defines it, `0` where it does not.
 *
 * Windows has no `O_NOFOLLOW`, so the flag is dropped there and the `lstat`
 * guards above are the protection: they close the same hole without the
 * kernel's help, at the cost of the TOCTOU window the flag would have removed.
 *
 * @type {number}
 */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Read a destination file without following a symbolic link at its final
 * component, or `undefined` when it does not exist.
 *
 * The no-follow open is what makes the identity fast path, the post-write
 * SHA-256 verification and the `--check` comparison describe the file this
 * script is responsible for rather than whatever a link points at. It also
 * closes the window between the `lstat` guard and the read: a link planted in
 * between fails the open with `ELOOP` instead of silently redirecting it.
 *
 * @param {string} root
 * @param {string} file absolute destination path
 * @returns {Buffer | undefined} the bytes on disk, or `undefined` if absent
 * @throws {CopyAgentError} exit 2 on a symbolic link or any other I/O failure
 */
function readNoFollow(root, file) {
  /** @type {number | undefined} */
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
    return fs.readFileSync(handle);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return undefined;
    // ELOOP is what O_NOFOLLOW reports for a link at the final component;
    // EMLINK is the same condition on some BSD kernels.
    if (isErrnoCode(error, 'ELOOP') || isErrnoCode(error, 'EMLINK')) {
      throw symlinkError(root, file, 'the destination path');
    }
    if (isErrnoCode(error, 'EISDIR')) {
      throw new CopyAgentError(`expected a file but found a directory: ${display(root, file)}`, {
        hint: 'Remove whatever occupies that path and re-run the copy.',
      });
    }
    throw ioError(`could not read ${display(root, file)}`, error);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/**
 * Serial number for temporary write names, so the three files one run may
 * write (the bundle and both source-map names) can never collide with each
 * other inside this process.
 *
 * @type {number}
 */
let temporaryWriteSerial = 0;

/**
 * The temporary path a write lands on before it is renamed into place: a
 * sibling of `to`, named `<basename>.<pid>-<serial>.tmp`.
 *
 * A sibling, not `os.tmpdir()`, because `rename` is only atomic within one
 * filesystem and `public/` may well sit on a different mount than `/tmp`. The
 * pid and serial make the name collision-resistant across concurrent runs
 * (`pnpm -r build` can run this script from more than one workspace at once);
 * `O_EXCL` then turns any residual collision into an error rather than a
 * clobber of someone else's in-flight write.
 *
 * @param {string} to absolute destination path
 * @returns {string} absolute temporary path in `to`'s directory
 */
function temporaryPathFor(to) {
  temporaryWriteSerial += 1;
  const name = `${path.basename(to)}.${process.pid}-${temporaryWriteSerial}.tmp`;
  return path.join(path.dirname(to), name);
}

/**
 * Write `expected` to `to` atomically, following no symbolic link on the way.
 *
 * Three properties matter here, in this order:
 *
 *   1. No-follow. `fs.copyFileSync(from, to)` and a plain `writeFileSync`
 *      both follow a symbolic link at `to`, which hands the choice of
 *      overwritten file to whoever planted the link. Creating a *new* file
 *      with `O_CREAT | O_EXCL | O_NOFOLLOW` cannot follow anything: the
 *      kernel either creates that exact name or fails.
 *   2. Atomic publication. `rename` replaces the destination — symbolic link
 *      included — in one step, so no reader (Chrome loading the extension,
 *      Vite's watcher during `vite build --watch`) ever sees a half-written
 *      `agent.iife.js`, and a crash leaves either the old file or the new one.
 *   3. Byte fidelity. The buffer written is the one read from the source, so
 *      nothing transcodes, adds a BOM, normalises line endings or touches the
 *      trailing `//# sourceMappingURL=` comment. `writeSync` is looped because
 *      it may report a short count.
 *
 * The temporary file is removed on every path out, successful or not:
 * `apps/chrome-extension/public/` is published verbatim into the packed
 * extension, so a leftover `.tmp` would ship.
 *
 * @param {string} root
 * @param {string} to absolute destination path, already verified
 * @param {Buffer} expected exact bytes to publish at `to`
 * @returns {void}
 * @throws {CopyAgentError} exit 2 on any failure to create, write or rename
 */
function writeNoFollow(root, to, expected) {
  const temporary = temporaryPathFor(to);
  /** @type {number | undefined} */
  let handle;

  try {
    // 0o644: this is a public static asset Chrome reads out of the packed
    // extension, not private state - unlike $DEBUGGEN_HOME, which is 0600.
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;
    handle = fs.openSync(temporary, flags, 0o644);

    let offset = 0;
    while (offset < expected.byteLength) {
      offset += fs.writeSync(handle, expected, offset, expected.byteLength - offset);
    }

    // Flush before publishing: the rename is what makes the name visible, and
    // a crash between the two would otherwise publish a name whose bytes are
    // still only in the page cache.
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;

    fs.renameSync(temporary, to);
  } catch (error) {
    throw ioError(`could not write ${display(root, to)}`, error);
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // The descriptor is being abandoned on a failure path; a failed close
        // adds nothing to the error already on its way up.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Already gone: the rename consumed it on the success path, or the open
      // never created it. Either way there is nothing left to clean up.
    }
  }
}

/**
 * Compare what is on disk with the source, writing nothing.
 *
 * Every read is no-follow ({@link readNoFollow}): the destinations have
 * already been verified by {@link verifyDestinations}, and reading them
 * through a link would let the gate certify the link's target as in sync.
 *
 * @param {string} root
 * @param {string} target absolute path of the copied bundle
 * @param {Buffer} sourceBuffer
 * @param {Buffer | undefined} sourceMap source map bytes, when one exists
 * @returns {string | undefined} why it drifted, or `undefined` when in sync
 */
function findDrift(root, target, sourceBuffer, sourceMap) {
  const existing = readNoFollow(root, target);
  if (existing === undefined) {
    return `${display(root, target)} does not exist`;
  }
  if (Buffer.compare(existing, sourceBuffer) !== 0) {
    return (
      `${display(root, target)} differs from the source ` +
      `(${existing.byteLength} bytes on disk, ` +
      `${sourceBuffer.byteLength} bytes in the bundle)`
    );
  }
  if (sourceMap === undefined) return undefined;

  const directory = path.dirname(target);
  for (const name of TARGET_MAP_NAMES) {
    const mapPath = path.join(directory, name);
    const copy = readNoFollow(root, mapPath);
    if (copy === undefined) {
      return `${display(root, mapPath)} does not exist`;
    }
    if (Buffer.compare(copy, sourceMap) !== 0) {
      return `${display(root, mapPath)} differs from the source map`;
    }
  }

  return undefined;
}

/**
 * Create a directory (and parents), reporting failure as exit 2.
 *
 * @param {string} root
 * @param {string} directory
 * @returns {void}
 */
function ensureDirectory(root, directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw ioError(`could not create ${display(root, directory)}`, error);
  }
}

/**
 * Publish one file verbatim and prove the result.
 *
 * Skips the write when the destination already holds exactly these bytes,
 * which keeps Vite's file watcher quiet during `vite build --watch`. After a
 * write, the destination is read back and its SHA-256 compared with the
 * source's, so a truncated or partially written copy fails loudly instead of
 * shipping a broken agent.
 *
 * Both reads and the write are no-follow, and the destination path must
 * already have passed {@link verifyDestinations}. The bytes come from
 * `expected` — the buffer read from the source — rather than from a
 * `copyFileSync`, so the write can be the atomic no-follow publication
 * {@link writeNoFollow} performs while staying byte for byte.
 *
 * @param {string} root
 * @param {string} to absolute destination path
 * @param {Buffer} expected bytes the source is known to hold
 * @returns {boolean} whether bytes were actually written
 */
function copyVerified(root, to, expected) {
  const existing = readNoFollow(root, to);
  if (existing !== undefined && Buffer.compare(existing, expected) === 0) {
    return false;
  }

  writeNoFollow(root, to, expected);

  const written = readNoFollow(root, to);
  if (written === undefined || sha256(written) !== sha256(expected)) {
    throw new CopyAgentError(`the copy at ${display(root, to)} does not match its source`, {
      hint: [
        'The bytes on disk differ from the bundle immediately after',
        'writing, which usually means another process is writing the',
        'same path or the filesystem is full. Re-run the copy once the',
        'cause is cleared:',
        '',
        '  node scripts/copy-agent.mjs',
      ].join('\n'),
    });
  }

  return true;
}

/**
 * Write the source map next to the target under both names it may be
 * requested by. Contents are copied verbatim — never rewritten — because the
 * bundle's own `sourceMappingURL` comment must keep resolving and the bundle's
 * bytes may not be edited.
 *
 * Both names go through {@link copyVerified}, so both get the identical
 * no-follow treatment the bundle gets: a link planted under a map name
 * redirects a write exactly as well as one planted at the target, and a map is
 * the file a developer opens in DevTools.
 *
 * @param {string} root
 * @param {string} target absolute path of the copied bundle
 * @param {Buffer} sourceMap source map bytes read from the source tree
 * @returns {string[]} absolute paths actually written
 */
function copySourceMaps(root, target, sourceMap) {
  const directory = path.dirname(target);
  /** @type {string[]} */
  const written = [];

  for (const name of TARGET_MAP_NAMES) {
    const mapPath = path.join(directory, name);
    if (copyVerified(root, mapPath, sourceMap)) {
      written.push(mapPath);
    }
  }

  return written;
}

/**
 * @typedef {object} CopyAgentResult
 * @property {"copied" | "unchanged" | "drift"} action what happened: bytes
 *   were written, the target already matched, or `--check` found a mismatch
 * @property {number} bytes size of the source bundle
 * @property {string} source absolute path of the source bundle
 * @property {string} target absolute path of the copied bundle
 * @property {string[]} maps absolute source-map paths written in this run
 * @property {string} [reason] why `action` is `"drift"`
 */

/**
 * Copy the agent bundle into the Chrome extension, or verify the existing
 * copy.
 *
 * Nothing is created when the source bundle is missing: no directory, no
 * placeholder. That is deliberate — an empty `agent.iife.js` would load in
 * Chrome and capture nothing, which is far harder to diagnose than a failed
 * build.
 *
 * Nothing is written or compared through a symbolic link either, in either
 * mode: an unusable destination path (a link or a non-regular file at the
 * target, at either source-map name, or at a directory component below
 * `root`) is an exit-2 failure naming the path, never `"drift"`.
 *
 * @param {{ root?: string, check?: boolean }} [options] `root` defaults to the
 *   repository root derived from this script's location; `check` verifies
 *   without writing
 * @returns {CopyAgentResult}
 * @throws {CopyAgentError} when the source is missing or empty, a destination
 *   path is unusable, the target cannot be written, or the written copy fails
 *   verification
 */
export function copyAgent({ root = REPO_ROOT, check = false } = {}) {
  const source = path.join(root, SOURCE_REL);
  const target = path.join(root, TARGET_REL);

  // Read (and sanity-check) the source first: every early return below this
  // point leaves the filesystem untouched.
  const sourceBuffer = readSourceBundle(root, source);
  const sourceMapPath = `${source}${MAP_SUFFIX}`;
  const sourceMap = readOptional(sourceMapPath);
  const base = { bytes: sourceBuffer.byteLength, source, target };

  // Then validate the destination, before any comparison and before any write,
  // in both modes: a symbolic link at (or above) the target would otherwise
  // decide which file this run overwrites, and would make `--check` compare
  // the link's target and report the copy as in sync.
  verifyDestinations(root, target);

  if (check) {
    const reason = findDrift(root, target, sourceBuffer, sourceMap);
    if (reason !== undefined) {
      return { ...base, action: 'drift', maps: [], reason };
    }
    return { ...base, action: 'unchanged', maps: [] };
  }

  ensureDirectory(root, path.dirname(target));
  const copied = copyVerified(root, target, sourceBuffer);
  const maps = sourceMap === undefined ? [] : copySourceMaps(root, target, sourceMap);

  return { ...base, action: copied ? 'copied' : 'unchanged', maps };
}

/**
 * Write one line to a stream. Used instead of `console` so that the script
 * depends on nothing but `node:` builtins and its output stays exactly one
 * line per run.
 *
 * @param {import("node:stream").Writable} stream
 * @param {string} text
 * @returns {void}
 */
function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

/**
 * The single-line success report.
 *
 * @param {string} root
 * @param {CopyAgentResult} result
 * @param {boolean} check whether this run was a verification
 * @returns {string}
 */
function describeResult(root, result, check) {
  const target = display(root, result.target);

  if (check) {
    const source = display(root, result.source);
    return `copy-agent: verified ${result.bytes} bytes — ` + `${target} matches ${source}`;
  }

  const maps =
    result.maps.length === 0
      ? ''
      : ` (+${result.maps.length} source map ` + `file${result.maps.length === 1 ? '' : 's'})`;

  return `copy-agent: ${result.action} ${result.bytes} bytes → ${target}${maps}`;
}

/**
 * The `--check` failure report: what drifted and how to fix it.
 *
 * @param {string} root
 * @param {CopyAgentResult} result
 * @returns {string}
 */
function describeDrift(root, result) {
  return [
    `copy-agent: --check failed — ${display(root, result.target)} ` + 'is out of date',
    `  reason: ${result.reason ?? 'the copy does not match the source'}`,
    '  fix:    node scripts/copy-agent.mjs',
  ].join('\n');
}

/**
 * Print a failure and return the exit code it maps to.
 *
 * @param {unknown} error
 * @returns {number}
 */
function reportFailure(error) {
  if (error instanceof CopyAgentError) {
    writeLine(process.stderr, `copy-agent: ${error.message}`);
    if (error.hint !== undefined) {
      writeLine(process.stderr, `\n${error.hint}`);
    }
    if (error.showUsage) {
      writeLine(process.stderr, `\n${usage()}`);
    }
    return error.exitCode;
  }

  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeLine(process.stderr, `copy-agent: unexpected failure\n${detail}`);
  return EXIT_ERROR;
}

/**
 * CLI entry point.
 *
 * @param {readonly string[]} [argv] arguments after the script path
 * @returns {Promise<number>} process exit code: 0 in sync, 1 drift, 2 failure
 */
export async function main(argv = process.argv.slice(2)) {
  /** @type {CopyAgentOptions} */
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return reportFailure(error);
  }

  if (options.help) {
    writeLine(process.stdout, usage());
    return EXIT_OK;
  }

  try {
    const result = copyAgent({ root: REPO_ROOT, check: options.check });

    if (result.action === 'drift') {
      // Always reported, even under --quiet: this is a failure.
      writeLine(process.stderr, describeDrift(REPO_ROOT, result));
      return EXIT_DRIFT;
    }

    if (!options.quiet) {
      const line = describeResult(REPO_ROOT, result, options.check);
      writeLine(process.stdout, line);
    }

    return EXIT_OK;
  } catch (error) {
    return reportFailure(error);
  }
}

/**
 * Resolve the process entry path, following symlinks where possible so that it
 * can be compared with `import.meta.url` (which Node reports as a real path).
 *
 * @param {string} entry
 * @returns {string}
 */
function resolveEntryPath(entry) {
  try {
    return fs.realpathSync(entry);
  } catch {
    return path.resolve(entry);
  }
}

/**
 * Whether this module is the process entry point, so importing it (for tests
 * or from another script) never runs the CLI.
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return false;
  return import.meta.url === pathToFileURL(resolveEntryPath(entry)).href;
}

if (isEntryPoint()) {
  // `process.exitCode` rather than `process.exit()` so buffered stdout is
  // flushed before the process ends.
  process.exitCode = await main(process.argv.slice(2));
}
