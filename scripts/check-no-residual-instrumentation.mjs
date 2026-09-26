#!/usr/bin/env node
/**
 * check-no-residual-instrumentation.mjs
 *
 * Repository gate behind `pnpm check:no-residual-instrumentation`, which `pnpm verify` runs. It
 * proves the claim the product's safety story rests on: after a debugging session the
 * instrumentation target -- by default the demo application `apps/demo-app` -- is back in its
 * normal, committed source state.
 *
 * Two independent assertions, both scoped to the target path:
 *
 *   1. `residual-marker`   no entry listed by `git ls-files -z --stage -- <target>` holds one of
 *                          the literal markers the function-timing patch inserts, so no patched
 *                          source was ever committed.
 *   2. `residual-worktree` `git status --porcelain -- <target>` is empty, so every applied patch
 *                          was reverted and nothing was left behind in the working tree.
 *
 * WHAT THE MARKER SCAN READS. Every tracked entry is accounted for, by its index mode and by what
 * stands at its path in the working tree:
 *
 *   * A regular file is searched byte for byte for every marker, whatever it holds: source, an
 *     image, a file with NUL bytes and a minified bundle alike. Up to 16 MiB it is read whole; a
 *     larger one is streamed in 1 MiB chunks that overlap by one byte less than the longest
 *     marker, so an occurrence straddling a chunk boundary is found, and reported on its exact
 *     line, like any other.
 *   * A tracked symbolic link is searched as its target text - the string git stores as the
 *     link's content - and never followed, so the scan cannot read outside the working tree. A
 *     regular file standing where git tracks a link (a checkout with `core.symlinks=false`) holds
 *     that text and is read as a regular file.
 *   * A submodule (a gitlink) is skipped and listed as `submodule`: its content belongs to another
 *     repository, whose own checks answer for it.
 *   * An entry that is not in the working tree as git records it is not read: absent (`missing`);
 *     a directory, FIFO, socket or device at its path (`not-a-regular-file`); a symbolic link
 *     where git tracks a regular file (`symlink`); or a path beneath a directory the working tree
 *     replaced with a symbolic link (`symlinked-directory`), which is never read through. Each is
 *     accepted only when `git status` reports that very path as changed, which makes
 *     `residual-worktree` fail the run, so an unread entry cannot hide a marker behind exit 0.
 *     One that `git status` does not report fails the check instead (see IT FAILS CLOSED).
 *
 * MARKER CONTRACT -- READ BEFORE CHANGING `MARKERS`
 * The literals in `MARKERS` are a contract with the patch template
 * `packages/instrumentation/src/patch/wrap-template.ts`, the only code that writes them into a
 * developer's source file. If that template ever renames the span-helper global or the inserted
 * type alias, `MARKERS` must change in the same commit; otherwise this gate keeps passing while
 * the cleanup guarantee has silently become unverifiable. The match is exact and case-sensitive on
 * purpose: a fuzzy /debuggen/i pattern would fail on required files that legitimately name the
 * development database or role, such as `apps/demo-app/.env.example`.
 *
 * This script is the cheap, always-on complement to `tests/e2e/cleanup.spec.ts`, which additionally
 * compares the SHA-256 of every tracked demo file against a pre-session snapshot. Here there is no
 * database, no browser and no session to set up, so the check runs on every `pnpm verify`. The
 * exported helpers exist so that spec and its helpers can run the very same rules in-process and
 * can therefore never disagree with the command line.
 *
 * IT FAILS CLOSED. Anything that leaves the check without a subject is an error (exit 2), never a
 * quiet pass: git missing, the directory not being a checkout, a `--path` that does not exist or
 * is not a directory, a target under which git tracks no file at all, a tracked entry under the
 * target that exists but cannot be examined or read (a permission denied, an I/O error:
 * `file-unreadable`), and an entry the scan does not read that `git status` does not report
 * either (`file-unscanned`) - a file the skip-worktree bit of a sparse checkout or
 * `git update-index --assume-unchanged` hides from it. The last three are the dangerous cases,
 * because they look like success: a file nobody read would otherwise count as a file without a
 * marker. All three are raised inside the scan itself, so the in-process callers fail closed with
 * the command line; the last two only after every other entry was examined, so one run names
 * every such file with its error code or reason. When a run meets both, `file-unreadable` is the
 * one raised, and `git status` is consulted about unread entries only once every tracked entry
 * could be examined.
 *
 * Usage:  node scripts/check-no-residual-instrumentation.mjs [--path <dir>] [--json] [--help]
 * Exits:  0 clean | 1 marker found or working tree dirty | 2 usage or environment error, which
 *         includes a target with no tracked file under it, a tracked file it cannot read, and one
 *         it did not read that `git status` does not report.
 *
 * The script only reads. It writes nothing to disk, never opens anything inside `.git/` (the
 * repository's `origin` URL embeds a credential) and prints no file content beyond a sanitized
 * 120-character excerpt of an offending line.
 */

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

/** Repository-relative directory checked when `--path` is not given. */
export const DEFAULT_TARGET_PATH = 'apps/demo-app';

/**
 * Exact, case-sensitive literals that a function-timing patch leaves in a patched file: the span
 * helper global and, in `.ts`/`.tsx` files, the inserted one-line type alias.
 *
 * @type {readonly string[]}
 */
export const MARKERS = Object.freeze(['__DEBUGGEN__', '__DebuggenSpanHelper']);

/** Exit code: both assertions hold. */
const EXIT_OK = 0;
/** Exit code: a marker was found, or the working tree is dirty. */
const EXIT_FINDINGS = 1;
/**
 * Exit code: the check could not be performed (usage, git, a missing or empty target, a tracked
 * file that cannot be read, or one it did not read that `git status` does not report).
 */
const EXIT_ERROR = 2;

/**
 * Regular files up to this size are read into memory whole; larger ones are streamed in
 * `STREAM_CHUNK_BYTES` steps, so no tracked file is too large to be searched.
 */
const MAX_WHOLE_READ_BYTES = 16 * 1024 * 1024;
/** Bytes read per step when a file larger than `MAX_WHOLE_READ_BYTES` is streamed. */
const STREAM_CHUNK_BYTES = 1024 * 1024;
/** Every marker as the UTF-8 bytes a file holds it as, in `MARKERS` order. */
const MARKER_BYTES = Object.freeze(MARKERS.map((marker) => Buffer.from(marker, 'utf8')));
/**
 * Bytes each streamed window carries over from the one before: one less than the longest marker,
 * which is the most of an occurrence straddling a chunk boundary that can lie before it.
 */
const STREAM_OVERLAP_BYTES = Math.max(...MARKER_BYTES.map((bytes) => bytes.length)) - 1;
/**
 * `open` flags for a streamed file: read-only, and refusing a symbolic link where the platform
 * supports `O_NOFOLLOW`, so a regular file swapped for a link after `lstat` fails the read
 * (`ELOOP`, a `file-unreadable` error) instead of being followed.
 */
const STREAM_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
/**
 * Bytes of an offending line decoded for its excerpt. Many times what a 120-character excerpt
 * needs, so collapsed whitespace rarely shortens it, and small enough that a finding in a
 * multi-megabyte single-line bundle costs one bounded read rather than a decode of the whole line.
 */
const EXCERPT_WINDOW_BYTES = 4096;
/** The line-feed byte. Lines are counted by it alone: a lone carriage return is not a line break. */
const LINE_FEED = 0x0a;
/** Index mode `git ls-files --stage` reports for a tracked symbolic link. */
const SYMLINK_MODE = '120000';
/** Index mode `git ls-files --stage` reports for a gitlink, the commit of a submodule. */
const GITLINK_MODE = '160000';
/** Maximum length of the excerpt printed for an offending line. */
const MAX_SNIPPET_LENGTH = 120;
/** `git ls-files` on a large tree can produce a lot of output; give it room. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/**
 * `lstat` error codes that mean a tracked path is simply not on disk: `ENOENT` for the path itself,
 * `ENOTDIR` when a parent directory was replaced by a file. Git reports both as deletions, so the
 * worktree assertion answers for them - unless an index flag hides the path from `git status`,
 * which is the `file-unscanned` error. Every other `lstat` error means the path may well exist and
 * could not be examined, which is a file the scan did not read (`file-unreadable`).
 */
const ABSENT_PATH_CODES = new Set(['ENOENT', 'ENOTDIR']);

/**
 * A single marker occurrence.
 *
 * @typedef {object} MarkerFinding
 * @property {string} file Repository-relative POSIX path of the offending file.
 * @property {number} line 1-based line number of the occurrence.
 * @property {string} marker The literal that matched.
 * @property {string} text Sanitized excerpt of the offending line (may be empty).
 */

/**
 * Why a tracked entry was not read. `submodule` is a gitlink, whose content belongs to another
 * repository. Every other reason means the working tree does not hold the entry as git records
 * it: nothing at its path (`missing`); a directory, FIFO, socket or device there
 * (`not-a-regular-file`); a symbolic link where git tracks a regular file (`symlink`); or a
 * symbolic link standing in for one of its parent directories (`symlinked-directory`).
 *
 * @typedef {'missing'|'not-a-regular-file'|'symlink'|'symlinked-directory'|'submodule'} SkipReason
 */

/**
 * A tracked entry the scan did not read. A submodule is always one of these; an entry with any
 * other reason is one only when `git status` reports its path, so the `residual-worktree`
 * assertion fails the run. An unread entry `git status` does not report is the `file-unscanned`
 * error instead, and a file the scan tried to read and could not is the `file-unreadable` error
 * (see {@link scanResidualMarkers}).
 *
 * @typedef {object} SkippedFile
 * @property {string} file Repository-relative POSIX path.
 * @property {SkipReason} reason
 */

/**
 * One path from `git ls-files --stage`, however many merge stages the index holds it at.
 *
 * @typedef {object} TrackedEntry
 * @property {string} file Repository-relative POSIX path.
 * @property {boolean} symlink At least one stage records a symbolic link (mode `120000`).
 * @property {boolean} gitlink Every stage records a gitlink (mode `160000`), a submodule.
 */

/**
 * A tracked entry the scan did not read, before `git status` decides whether it is accepted as a
 * {@link SkippedFile} (`needsStatus` false, or its path reported) or is `file-unscanned`.
 *
 * @typedef {object} UnreadEntry
 * @property {string} file Repository-relative POSIX path.
 * @property {SkipReason} reason
 * @property {boolean} needsStatus Whether only a `git status` report of the path accounts for it.
 */

/**
 * A tracked file that exists, or may exist, but could not be examined or read.
 *
 * @typedef {object} UnreadableFile
 * @property {string} file Repository-relative POSIX path.
 * @property {string} code The failure's errno-style code, such as `EACCES` or `EIO`.
 * @property {unknown} error The value the filesystem call threw, kept as the error's cause.
 */

/**
 * Full result of the marker scan.
 *
 * @typedef {object} MarkerScanResult
 * @property {string} repoRoot Absolute path of the git work-tree root.
 * @property {string} target Repository-relative POSIX path that was scanned.
 * @property {string[]} files Every tracked path under `target`, once each, in `git ls-files` order.
 * @property {number} filesScanned How many of those were read and searched: regular files byte for
 *   byte, symbolic links as their target text.
 * @property {SkippedFile[]} skipped Entries not read, with the reason, in `git ls-files` order.
 * @property {MarkerFinding[]} findings Every marker occurrence, in file, then line, then `MARKERS`
 *   order.
 */

/**
 * Where a line starts and which markers it holds, recorded while a file is searched.
 *
 * @typedef {object} LineHit
 * @property {number} lineStart Byte offset of the line's first byte in the file.
 * @property {Set<number>} markers Indexes into `MARKERS` of the literals found on the line.
 */

/**
 * The line a search has reached, carried from one streamed window to the next.
 *
 * @typedef {object} LineCursor
 * @property {number} line 1-based number of the line holding the window's first byte.
 * @property {number} lineStart Byte offset in the file at which that line starts.
 */

/**
 * What stands above a tracked path, as {@link linkedAncestor} finds it: only real directories (or
 * absent ones, which the path's own `lstat` then reports as missing); a directory the working tree
 * replaced with a symbolic link; or a directory that could not be examined.
 *
 * @typedef {{ kind: 'clear' }
 *   | { kind: 'symlink', directory: string }
 *   | { kind: 'unexaminable', code: string, error: unknown }} Ancestry
 */

/**
 * Raised for every condition that makes the check impossible to perform (exit code 2) as opposed to
 * a genuine finding (exit code 1). `code` is a stable, machine-readable discriminator.
 */
export class ResidualCheckError extends Error {
  /**
   * @param {string} code Stable error code, for example `git-missing` or `target-missing`.
   * @param {string} message Human-readable, actionable description.
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ResidualCheckError';
    this.code = code;
  }
}

/**
 * @param {string} message
 * @returns {ResidualCheckError}
 */
function usageError(message) {
  return new ResidualCheckError('usage', message);
}

/**
 * Run git synchronously and return its stdout. Spawning the `git` binary is deliberate: the check
 * must never read the contents of `.git/`.
 *
 * @param {string} cwd Directory to run git in.
 * @param {string[]} args Arguments, already split.
 * @returns {string} Captured stdout, decoded as UTF-8.
 */
function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error instanceof Error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
      throw new ResidualCheckError(
        'git-missing',
        'the `git` executable was not found on PATH; this check enumerates tracked files with git',
        { cause: error },
      );
    }
    const stderr =
      error instanceof Error &&
      typeof (/** @type {{ stderr?: unknown }} */ (error).stderr) === 'string'
        ? String(/** @type {{ stderr?: unknown }} */ (error).stderr).trim()
        : '';
    throw new ResidualCheckError(
      'git-failed',
      `\`git ${args.join(' ')}\` failed in ${cwd}${stderr === '' ? '' : `: ${stderr}`}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

/**
 * Resolve the git work-tree root that contains `hint`. Passing a subdirectory (or this script's own
 * directory) is fine: git reports the top level either way, which keeps every pathspec below
 * anchored to the repository root.
 *
 * @param {string} [hint] Absolute or cwd-relative path inside the repository.
 * @returns {string} Absolute path of the work-tree root.
 */
function resolveRepoRoot(hint) {
  const start = path.resolve(typeof hint === 'string' && hint.trim() !== '' ? hint : '.');
  let stats;
  try {
    stats = lstatSync(start);
  } catch (error) {
    throw new ResidualCheckError('root-missing', `path does not exist: ${start}`, { cause: error });
  }
  const directory = stats.isDirectory() ? start : path.dirname(start);
  const notARepository =
    `${directory} is not inside a git work tree; ` +
    'run this check from a checkout of the repository';
  let topLevel;
  try {
    topLevel = git(directory, ['rev-parse', '--show-toplevel']).trim();
  } catch (error) {
    if (error instanceof ResidualCheckError && error.code === 'git-missing') {
      throw error;
    }
    throw new ResidualCheckError('not-a-repository', notARepository, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (topLevel === '') {
    throw new ResidualCheckError('not-a-repository', notARepository);
  }
  return path.resolve(topLevel);
}

/**
 * Normalize a target directory to a repository-relative POSIX path. Absolute paths are accepted for
 * the convenience of in-process callers, but anything outside the repository, and the repository
 * root itself, is refused: scanning the root would match this file and the patch template that owns
 * the marker literals, which would make the gate permanently red for no useful reason.
 *
 * @param {string} repoRoot Absolute work-tree root.
 * @param {string} [target] Requested directory.
 * @returns {string} Repository-relative POSIX path.
 */
function normalizeTarget(repoRoot, target) {
  const requested =
    typeof target === 'string' && target.trim() !== '' ? target.trim() : DEFAULT_TARGET_PATH;
  const absolute = path.resolve(repoRoot, requested);
  const relative = path.relative(repoRoot, absolute);
  // Outside means the relative path climbs out through a `..` *segment*. A bare prefix test would
  // also refuse an in-repository directory whose name merely starts with two dots, such as
  // `..cache`, and report it as outside the repository when it is not.
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw usageError(`--path must stay inside the repository; got ${requested}`);
  }
  if (relative === '') {
    throw usageError(
      `--path must name a directory inside the repository, not the repository root; ` +
        `the default is ${DEFAULT_TARGET_PATH}`,
    );
  }
  return relative.split(path.sep).join('/');
}

/**
 * Fail loudly when the subject of the check is absent. A gate that passes because it had nothing to
 * look at is worse than no gate at all, so this is an error (exit 2), never a silent pass.
 *
 * @param {string} repoRoot Absolute work-tree root.
 * @param {string} target Repository-relative POSIX path.
 * @returns {void}
 */
function assertTargetExists(repoRoot, target) {
  const absolute = path.join(repoRoot, target);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch (error) {
    throw new ResidualCheckError(
      'target-missing',
      `target path not found: ${target}. A complete checkout of this repository is expected to ` +
        `contain ${DEFAULT_TARGET_PATH} (the demo application this gate protects); pass ` +
        '--path to check a different directory, such as tests/fixtures/sample-next-app.',
      { cause: error },
    );
  }
  if (!stats.isDirectory()) {
    throw new ResidualCheckError(
      'target-not-a-directory',
      `target path is not a directory: ${target}`,
    );
  }
}

/**
 * Every entry git tracks under `target`, repository-relative, with what its index mode says it is.
 * Tracked-only enumeration is the point: a patch that was applied but not committed is caught by
 * the working-tree assertion instead, and an untracked scratch file in a developer's tree is not
 * this gate's business.
 *
 * `--stage` adds each entry's mode, which decides how it is read: a symbolic link as its target
 * text, a gitlink not at all. An unmerged path is listed once per merge stage; it is kept once, at
 * its first position, with the modes of all its stages.
 *
 * @param {string} repoRoot Absolute work-tree root.
 * @param {string} target Repository-relative POSIX path.
 * @returns {TrackedEntry[]} Tracked entries, in `git ls-files` order.
 * @throws {ResidualCheckError} With code `git-failed` when git fails or prints a record that is
 *   not `<mode> <object> <stage>\t<path>`.
 */
function listTrackedEntries(repoRoot, target) {
  const output = git(repoRoot, ['ls-files', '-z', '--stage', '--', target]);
  /** @type {Map<string, Set<string>>} */
  const modesByPath = new Map();
  for (const record of output.split('\0')) {
    if (record === '') {
      continue;
    }
    const tab = record.indexOf('\t');
    const mode = record.slice(0, record.indexOf(' '));
    if (tab === -1 || !/^[0-7]{6}$/.test(mode)) {
      throw new ResidualCheckError(
        'git-failed',
        `\`git ls-files -z --stage -- ${target}\` printed a record this check cannot parse: ` +
          JSON.stringify(record.slice(0, 80)),
      );
    }
    const file = record.slice(tab + 1);
    const modes = modesByPath.get(file) ?? new Set();
    modes.add(mode);
    modesByPath.set(file, modes);
  }
  return [...modesByPath].map(([file, modes]) => ({
    file,
    symlink: modes.has(SYMLINK_MODE),
    gitlink: [...modes].every((mode) => mode === GITLINK_MODE),
  }));
}

/**
 * The paths under `target` that `git status` reports as changed in any way - staged or not, and
 * including deletions and type changes - read in its NUL-separated form, which never quotes a
 * path. Renames are not paired (`--no-renames`), so every record names exactly one path, and
 * untracked files are not listed: the question is only whether git answers for an entry the scan
 * did not read.
 *
 * @param {string} repoRoot Absolute work-tree root.
 * @param {string} target Repository-relative POSIX path.
 * @returns {Set<string>} Repository-relative POSIX paths.
 */
function changedTrackedPaths(repoRoot, target) {
  const output = git(repoRoot, [
    'status',
    '--porcelain',
    '-z',
    '--no-renames',
    '--untracked-files=no',
    '--',
    target,
  ]);
  // Each record is `XY <path>`: two status letters and a space, then the path.
  return new Set(
    output
      .split('\0')
      .filter((record) => record.length > 3)
      .map((record) => record.slice(3)),
  );
}

/**
 * The first directory above `file`, repository-relative and counted from the repository root
 * down, that the working tree holds as a symbolic link, found by `lstat`-ing each directory in turn;
 * nothing below such a link is examined, because examining it would follow the link.
 *
 * Git never tracks a path beneath a symbolic link, so a link standing where the index records a
 * directory is a local replacement of that directory. `lstat` leaves only the last component of a
 * path unfollowed, so without this walk every tracked file under such a link would be read from
 * wherever it points - content outside the checkout, or a benign stand-in - and reported clean in
 * the tracked file's name. An absent directory is not a link: the path's own `lstat` then reports
 * the file missing. A directory that cannot be examined leaves every path below it unexamined.
 *
 * Many tracked files share each directory, so every answer is cached for the rest of the run and
 * each directory is examined once.
 *
 * @param {string} repoRoot Absolute work-tree root.
 * @param {string} file Repository-relative POSIX path of a tracked entry.
 * @param {Map<string, Ancestry>} cache Answers so far, keyed by repository-relative directory.
 * @returns {Ancestry}
 */
function linkedAncestor(repoRoot, file, cache) {
  const directory = path.posix.dirname(file);
  if (directory === '.') {
    return { kind: 'clear' };
  }
  const known = cache.get(directory);
  if (known !== undefined) {
    return known;
  }
  let found = linkedAncestor(repoRoot, directory, cache);
  if (found.kind === 'clear') {
    try {
      if (lstatSync(path.join(repoRoot, directory)).isSymbolicLink()) {
        found = { kind: 'symlink', directory };
      }
    } catch (error) {
      const code = errorCode(error);
      if (!ABSENT_PATH_CODES.has(code)) {
        found = { kind: 'unexaminable', code, error };
      }
    }
  }
  cache.set(directory, found);
  return found;
}

/**
 * Make one source line safe and short enough to print: control characters (which could smuggle
 * terminal escapes into CI logs) collapse to spaces, runs of whitespace collapse to one space, and
 * the result is truncated to `MAX_SNIPPET_LENGTH` characters, ending in `...` when it was cut.
 *
 * @param {string} line The line, or only its first bytes when `continues` is set.
 * @param {boolean} [continues] The line runs on beyond `line`, so the excerpt ends in `...` even
 *   when what it holds fits.
 * @returns {string}
 */
function snippet(line, continues = false) {
  // Built character by character rather than with a control-character regex, which every linter
  // flags for good reason: C0 controls and DEL become spaces, so no terminal escape can reach a
  // CI log through this excerpt.
  let neutralized = '';
  for (const character of line) {
    const code = character.codePointAt(0) ?? 0;
    neutralized += code < 0x20 || code === 0x7f ? ' ' : character;
  }
  const printable = neutralized.replace(/\s+/g, ' ').trim();
  if (!continues && printable.length <= MAX_SNIPPET_LENGTH) {
    return printable;
  }
  // Lengths are UTF-16 code units, so the cut can land between the two halves of a surrogate pair
  // (an emoji, say). A lone high surrogate is not well-formed text: it prints as U+FFFD and reaches
  // the `--json` report as an unpaired `\ud83d` escape that strict JSON parsers reject. Back off by
  // one unit in that case; the excerpt stays within the limit either way.
  let end = Math.min(printable.length, MAX_SNIPPET_LENGTH - 3);
  const lastUnit = printable.charCodeAt(end - 1);
  if (end < printable.length && lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    end -= 1;
  }
  return `${printable.slice(0, end)}...`;
}

/**
 * The excerpt of the line whose first bytes are `bytes`: the line up to its line feed or, when it
 * runs on beyond `EXCERPT_WINDOW_BYTES`, its first `EXCERPT_WINDOW_BYTES` - decoded without the
 * UTF-8 sequence the window may have cut, and ending in `...` - then made printable by
 * {@link snippet}. The same bounded read serves a file held in memory and a streamed one, so both
 * report a line identically.
 *
 * @param {Buffer} bytes Up to `EXCERPT_WINDOW_BYTES + 1` bytes from the start of the line.
 * @returns {string}
 */
function lineExcerpt(bytes) {
  const end = bytes.indexOf(LINE_FEED);
  const continues = end === -1 && bytes.length > EXCERPT_WINDOW_BYTES;
  const lineBytes = bytes.subarray(0, end === -1 ? EXCERPT_WINDOW_BYTES : end);
  // `stream: true` holds back an incomplete trailing sequence instead of decoding it as U+FFFD.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(lineBytes, {
    stream: continues,
  });
  return snippet(text, continues);
}

/**
 * Search one window of a file's bytes for every marker and record the line of each occurrence.
 *
 * A file held in memory is one window; a streamed file is a run of windows, each starting with the
 * last `STREAM_OVERLAP_BYTES` of the one before, so an occurrence straddling two chunks lies whole
 * in the later window. `fresh` is the index of the first byte no earlier window held: an
 * occurrence ending at or before it lay whole in the previous window, which recorded it, so only
 * occurrences ending beyond it are searched for here. Every line with an occurrence is recorded
 * once, whichever window finds it and however often each marker appears on it.
 *
 * Lines are counted by their line feeds from `cursor`, the line holding `window[0]`. With
 * `carryFrom` set, `cursor` is advanced to the line holding `window[carryFrom]` - where the next
 * window starts - so the next window counts on from there and never counts a carried byte twice.
 * With `carryFrom` null no window follows, and a window without an occurrence counts nothing.
 *
 * @param {Buffer} window The bytes searched.
 * @param {number} windowStart Byte offset of `window[0]` in the file.
 * @param {number} fresh Index of the first byte of `window` that no earlier window held.
 * @param {number | null} carryFrom Index at which the next window starts, or `null` when none does.
 * @param {LineCursor} cursor The line holding `window[0]`; advanced in place when `carryFrom` is set.
 * @param {Map<number, LineHit>} hits Receives every line with an occurrence, keyed by line number.
 * @returns {void}
 */
function searchWindow(window, windowStart, fresh, carryFrom, cursor, hits) {
  /** @type {{ index: number, marker: number }[]} */
  const occurrences = [];
  MARKER_BYTES.forEach((bytes, marker) => {
    let index = window.indexOf(bytes, Math.max(0, fresh - bytes.length + 1));
    while (index !== -1) {
      occurrences.push({ index, marker });
      index = window.indexOf(bytes, index + 1);
    }
  });
  if (occurrences.length === 0 && carryFrom === null) {
    // Fast path: most files contain no marker at all, so their lines are never counted.
    return;
  }
  occurrences.sort((left, right) => left.index - right.index || left.marker - right.marker);

  let { line, lineStart } = cursor;
  let nextFeed = window.indexOf(LINE_FEED);
  /**
   * Count the line feeds before `index`; each one is found once per window.
   *
   * @param {number} index
   */
  const advanceTo = (index) => {
    while (nextFeed !== -1 && nextFeed < index) {
      line += 1;
      lineStart = windowStart + nextFeed + 1;
      nextFeed = window.indexOf(LINE_FEED, nextFeed + 1);
    }
  };
  // Where the next window starts. Without one the cursor is never handed on, so it is never settled.
  const nextWindowAt = carryFrom ?? Number.POSITIVE_INFINITY;
  let settled = carryFrom === null;
  /** Hand the line holding `window[nextWindowAt]` on to the next window, once. */
  const settle = () => {
    advanceTo(nextWindowAt);
    cursor.line = line;
    cursor.lineStart = lineStart;
    settled = true;
  };

  for (const { index, marker } of occurrences) {
    // An occurrence at or after `nextWindowAt` still belongs to this window, which reports it; the
    // cursor handed to the next window must stop short of it.
    if (!settled && index >= nextWindowAt) {
      settle();
    }
    advanceTo(index);
    const hit = hits.get(line) ?? { lineStart, markers: new Set() };
    hit.markers.add(marker);
    hits.set(line, hit);
  }
  if (!settled) {
    settle();
  }
}

/**
 * The findings for the lines a search recorded: one per marker per line, in line then `MARKERS`
 * order, each carrying the excerpt of its line. Windows can record lines out of order (a marker
 * carried into the next window can lie on an earlier line than one found near the end of the
 * previous), so the lines are sorted here.
 *
 * @param {string} file Repository-relative POSIX path, used in each finding.
 * @param {Map<number, LineHit>} hits What the search recorded.
 * @param {(position: number, length: number) => Buffer} readAt The file's bytes from `position`,
 *   at most `length` of them.
 * @returns {MarkerFinding[]}
 */
function findingsFromHits(file, hits, readAt) {
  /** @type {MarkerFinding[]} */
  const findings = [];
  const lines = [...hits].sort(([left], [right]) => left - right);
  for (const [line, hit] of lines) {
    const text = lineExcerpt(readAt(hit.lineStart, EXCERPT_WINDOW_BYTES + 1));
    MARKERS.forEach((marker, index) => {
      if (hit.markers.has(index)) {
        findings.push({ file, line, marker, text });
      }
    });
  }
  return findings;
}

/**
 * Search bytes held in memory - a file read whole, or a symbolic link's target text - for every
 * marker, reporting 1-based line numbers.
 *
 * @param {string} file Repository-relative POSIX path, used in each finding.
 * @param {Buffer} bytes The entry's content.
 * @returns {MarkerFinding[]}
 */
function scanBytes(file, bytes) {
  /** @type {Map<number, LineHit>} */
  const hits = new Map();
  searchWindow(bytes, 0, 0, null, { line: 1, lineStart: 0 }, hits);
  return findingsFromHits(file, hits, (position, length) =>
    bytes.subarray(position, position + length),
  );
}

/**
 * Search a file too large to hold in memory, reading it in `STREAM_CHUNK_BYTES` chunks until the
 * end of the file - wherever that lies by then, whatever `lstat` reported - and each finding's
 * excerpt with one bounded positional read. The descriptor is closed whether the search completes
 * or throws; every error, the close's included, reaches the caller, which records the file as
 * unreadable.
 *
 * @param {string} file Repository-relative POSIX path, used in each finding.
 * @param {string} absolute Absolute path of the file.
 * @returns {MarkerFinding[]}
 */
function scanStreamedFile(file, absolute) {
  const descriptor = openSync(absolute, STREAM_OPEN_FLAGS);
  try {
    /**
     * @param {number} position
     * @param {number} length
     * @returns {Buffer}
     */
    const readAt = (position, length) => {
      const buffer = Buffer.alloc(length);
      return buffer.subarray(0, readSync(descriptor, buffer, 0, length, position));
    };
    /** @type {Map<number, LineHit>} */
    const hits = new Map();
    /** @type {LineCursor} */
    const cursor = { line: 1, lineStart: 0 };
    let carry = Buffer.alloc(0);
    let position = 0;
    let chunk = readAt(position, STREAM_CHUNK_BYTES);
    while (chunk.length > 0) {
      const window = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      const carryFrom = Math.max(0, window.length - STREAM_OVERLAP_BYTES);
      searchWindow(window, position - carry.length, carry.length, carryFrom, cursor, hits);
      carry = window.subarray(carryFrom);
      position += chunk.length;
      chunk = readAt(position, STREAM_CHUNK_BYTES);
    }
    return findingsFromHits(file, hits, readAt);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Search one regular file byte for byte: read whole up to `MAX_WHOLE_READ_BYTES`, streamed beyond.
 *
 * @param {string} file Repository-relative POSIX path, used in each finding.
 * @param {string} absolute Absolute path of the file.
 * @param {number} size The size `lstat` reported, which chooses the reading strategy.
 * @returns {MarkerFinding[]}
 */
function scanRegularFile(file, absolute, size) {
  return size <= MAX_WHOLE_READ_BYTES
    ? scanBytes(file, readFileSync(absolute))
    : scanStreamedFile(file, absolute);
}

/**
 * The errno-style code a filesystem call failed with (`EACCES`, `EIO`, ...), or `UNKNOWN` when the
 * thrown value carries none.
 *
 * @param {unknown} error
 * @returns {string}
 */
function errorCode(error) {
  const code =
    typeof error === 'object' && error !== null
      ? /** @type {{ code?: unknown }} */ (error).code
      : undefined;
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN';
}

/**
 * The `file-unreadable` error for every tracked file the scan could not examine or read, each named
 * with its error code on a line of its own so a long list stays legible in a CI log. The underlying
 * errors travel as an `AggregateError` cause, so an in-process caller keeps the full detail.
 *
 * @param {string} target Repository-relative POSIX path that was scanned.
 * @param {readonly UnreadableFile[]} unreadable At least one entry, in `git ls-files` order.
 * @returns {ResidualCheckError}
 */
function unreadableFilesError(target, unreadable) {
  const count = unreadable.length;
  const listing = unreadable.map(({ file, code }) => `  ${file} (${code})`).join('\n');
  return new ResidualCheckError(
    'file-unreadable',
    `${count} tracked ${plural(count, 'file')} under ${target} could not be read, so the marker ` +
      `scan cannot vouch for ${count === 1 ? 'it' : 'them'} and this check cannot be performed:\n` +
      `${listing}\n` +
      'Make every listed file, and each directory above it, readable by the account running this ' +
      'check - restore its permissions or ownership, or repair the storage behind an I/O error - ' +
      'and re-run it.',
    {
      cause: new AggregateError(
        unreadable.map((entry) => entry.error),
        `${count} tracked ${plural(count, 'file')} could not be read`,
      ),
    },
  );
}

/**
 * The `file-unscanned` error for every tracked entry the scan did not read that `git status` does
 * not report either, each named with its {@link SkipReason} on a line of its own. Such an entry is
 * absent from, or replaced in, the working tree while the index tells git not to compare it -
 * the skip-worktree bit a sparse checkout sets, or `git update-index --assume-unchanged` - so
 * neither assertion answers for it.
 *
 * @param {string} target Repository-relative POSIX path that was scanned.
 * @param {readonly UnreadEntry[]} unscanned At least one entry, in `git ls-files` order.
 * @returns {ResidualCheckError}
 */
function unscannedFilesError(target, unscanned) {
  const count = unscanned.length;
  const them = count === 1 ? 'it' : 'them';
  const listing = unscanned.map(({ file, reason }) => `  ${file} (${reason})`).join('\n');
  return new ResidualCheckError(
    'file-unscanned',
    `${count} tracked ${plural(count, 'file')} under ${target} ${count === 1 ? 'is' : 'are'} not ` +
      `in the working tree as git records ${them}, and \`git status\` does not report ` +
      `${them} as changed, so the marker scan cannot vouch for ${them} and this check cannot be ` +
      `performed:\n${listing}\n` +
      'Git does not compare a path with the working tree while the index marks it skip-worktree ' +
      '(a sparse checkout) or assume-unchanged. Restore every listed file - run ' +
      '`git sparse-checkout disable`, or clear each flag with ' +
      '`git update-index --no-skip-worktree -- <path>` and ' +
      '`git update-index --no-assume-unchanged -- <path>` (one flag per command) and run ' +
      '`git checkout -- <path>` - then re-run the check.',
  );
}

/**
 * Scan every tracked entry under `relDir` for the instrumentation markers and report what was
 * searched as well as what was found. `findMarkers` is the terse wrapper around this; the command
 * line uses the full result so its summary line can name the number of files scanned.
 *
 * Every regular file is searched byte for byte (streamed beyond `MAX_WHOLE_READ_BYTES`), every
 * tracked symbolic link as its target text without being followed, and a submodule is skipped;
 * the header of this file states the full rule, including which unread entries are accepted.
 *
 * @param {string} root Any path inside the repository; the git work-tree root is derived from it.
 * @param {string} [relDir] Repository-relative directory to scan. Defaults to `apps/demo-app`.
 * @returns {MarkerScanResult}
 * @throws {ResidualCheckError} When git is unavailable, `root` is not a checkout, `relDir` is
 *   missing, outside the repository or not a directory; with code `target-empty` when git tracks no
 *   file under it, which leaves the marker assertion with no subject; with code `file-unreadable`
 *   when a tracked entry under it exists, or may exist, but could not be examined or read - a
 *   permission denied, an I/O error - because a file nobody read cannot be reported clean; and
 *   with code `file-unscanned` when an entry it did not read is not reported by `git status`
 *   either. Both name every such file, with its error code or reason, and are raised only after
 *   every other entry was examined, so one run reports them all; `file-unreadable` is raised in
 *   preference, before `git status` is consulted.
 */
export function scanResidualMarkers(root, relDir) {
  const repoRoot = resolveRepoRoot(root);
  const target = normalizeTarget(repoRoot, relDir);
  assertTargetExists(repoRoot, target);

  const entries = listTrackedEntries(repoRoot, target);
  const files = entries.map((entry) => entry.file);
  if (files.length === 0) {
    // The same principle as assertTargetExists above, one step further in: a directory that exists
    // but whose contents git does not track leaves the `residual-marker` assertion with nothing to
    // assert, and a gate that passes because it had nothing to look at is worse than no gate at
    // all. Raised here rather than in the command line so that the in-process callers
    // (`tests/e2e/cleanup.spec.ts` and its helpers) fail closed too.
    throw new ResidualCheckError(
      'target-empty',
      `git tracks no file under ${target} in ${repoRoot}, so the marker scan has no subject and ` +
        'this check cannot be performed. The demo application has not been committed or staged ' +
        'yet, the checkout is sparse or partial, or --path names a directory that holds only ' +
        'untracked or ignored files: stage it with `git add`, restore the full checkout with ' +
        '`git sparse-checkout disable`, or pass a --path that git tracks, such as ' +
        `${DEFAULT_TARGET_PATH} or tests/fixtures/sample-next-app.`,
    );
  }
  /** @type {MarkerFinding[]} */
  const findings = [];
  // Entries the scan did not read, in `git ls-files` order. After the loop `git status` decides
  // which of them are accepted as skipped and which are `file-unscanned`.
  /** @type {UnreadEntry[]} */
  const unread = [];
  // Files the scan could not examine or read. They are collected rather than raised one at a time,
  // so a single run names all of them, and raised after the loop: never a skip, because a file
  // nobody read would otherwise count as a file without a marker.
  /** @type {UnreadableFile[]} */
  const unreadable = [];
  /** @type {Map<string, Ancestry>} */
  const ancestry = new Map();
  let filesScanned = 0;

  for (const entry of entries) {
    const { file } = entry;
    if (entry.gitlink) {
      unread.push({ file, reason: 'submodule', needsStatus: false });
      continue;
    }
    const ancestor = linkedAncestor(repoRoot, file, ancestry);
    if (ancestor.kind === 'unexaminable') {
      unreadable.push({ file, code: ancestor.code, error: ancestor.error });
      continue;
    }
    if (ancestor.kind === 'symlink') {
      unread.push({ file, reason: 'symlinked-directory', needsStatus: true });
      continue;
    }
    const absolute = path.join(repoRoot, file);
    let stats;
    try {
      // lstat, not stat: a tracked symlink is never followed, so the scan cannot read outside the
      // working tree. A deleted-but-tracked file lands here too; any other failure (a parent
      // directory without search permission, an I/O error) leaves a file that may exist
      // unexamined.
      stats = lstatSync(absolute);
    } catch (error) {
      const code = errorCode(error);
      if (ABSENT_PATH_CODES.has(code)) {
        unread.push({ file, reason: 'missing', needsStatus: true });
      } else {
        unreadable.push({ file, code, error });
      }
      continue;
    }
    const isLink = stats.isSymbolicLink();
    if (isLink && !entry.symlink) {
      unread.push({ file, reason: 'symlink', needsStatus: true });
      continue;
    }
    if (!isLink && !stats.isFile()) {
      unread.push({ file, reason: 'not-a-regular-file', needsStatus: true });
      continue;
    }
    try {
      // A tracked link's content, as git stores it, is its target text: read as bytes, never
      // followed. A regular file is searched whole, whatever it holds, however large it is.
      findings.push(
        ...(isLink
          ? scanBytes(file, readlinkSync(absolute, { encoding: 'buffer' }))
          : scanRegularFile(file, absolute, stats.size)),
      );
    } catch (error) {
      // lstat just found an entry here, so whatever the code - EACCES, EIO, even an ENOENT from a
      // file deleted mid-scan - its content was never fully searched.
      unreadable.push({ file, code: errorCode(error), error });
      continue;
    }
    filesScanned += 1;
  }

  if (unreadable.length > 0) {
    // Raised here rather than in the command line, like `target-empty` above, so that the
    // in-process callers fail closed too instead of receiving "no marker" for unread files.
    throw unreadableFilesError(target, unreadable);
  }

  // One `git status`, and only when an entry depends on it: an unread entry whose path git reports
  // as changed fails `residual-worktree`, so it cannot hide a marker behind exit 0. Git does not
  // report a path the index tells it not to compare, and that entry fails closed here instead.
  const reported = unread.some((entry) => entry.needsStatus)
    ? changedTrackedPaths(repoRoot, target)
    : new Set();
  const unscanned = unread.filter((entry) => entry.needsStatus && !reported.has(entry.file));
  if (unscanned.length > 0) {
    throw unscannedFilesError(target, unscanned);
  }

  /** @type {SkippedFile[]} */
  const skipped = unread.map(({ file, reason }) => ({ file, reason }));
  return { repoRoot, target, files, filesScanned, skipped, findings };
}

/**
 * Every instrumentation marker occurrence in tracked source under `relDir`. An empty array means
 * the `residual-marker` assertion holds - and it can only mean that, because a target with no
 * tracked file under it, a target holding a tracked file that cannot be read, and one holding an
 * unread entry `git status` does not report raise instead of returning an empty array (see
 * {@link scanResidualMarkers}). The unread entries `git status` does report leave the
 * `residual-worktree` assertion failing, which {@link worktreeDirty} answers.
 *
 * @param {string} root Any path inside the repository; the git work-tree root is derived from it.
 * @param {string} [relDir] Repository-relative directory to scan. Defaults to `apps/demo-app`.
 * @returns {MarkerFinding[]}
 * @throws {ResidualCheckError} Everything {@link scanResidualMarkers} throws, including
 *   `target-empty`, `file-unreadable` and `file-unscanned`.
 */
export function findMarkers(root, relDir) {
  return scanResidualMarkers(root, relDir).findings;
}

/**
 * `git status --porcelain` entries for `relDir`, one per line, with trailing whitespace removed. An
 * empty array means the `residual-worktree` assertion holds.
 *
 * The pathspec is never omitted: the repository's working tree may legitimately carry unrelated
 * untracked files elsewhere (notably at the root), and this gate must not fail because of them.
 *
 * @param {string} root Any path inside the repository; the git work-tree root is derived from it.
 * @param {string} [relDir] Repository-relative directory to inspect. Defaults to `apps/demo-app`.
 * @returns {string[]}
 * @throws {ResidualCheckError} When git is unavailable, `root` is not a checkout, or `relDir` is
 *   missing, outside the repository or not a directory.
 */
export function worktreeStatus(root, relDir) {
  const repoRoot = resolveRepoRoot(root);
  const target = normalizeTarget(repoRoot, relDir);
  assertTargetExists(repoRoot, target);
  // core.quotePath=false keeps non-ASCII paths readable instead of octal-escaped.
  const output = git(repoRoot, [
    '-c',
    'core.quotePath=false',
    'status',
    '--porcelain',
    '--',
    target,
  ]);
  return output
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '');
}

/**
 * Whether `relDir` has any uncommitted change -- staged, unstaged or untracked.
 *
 * @param {string} root Any path inside the repository; the git work-tree root is derived from it.
 * @param {string} [relDir] Repository-relative directory to inspect. Defaults to `apps/demo-app`.
 * @returns {boolean} `true` when the directory is dirty.
 */
export function worktreeDirty(root, relDir) {
  return worktreeStatus(root, relDir).length > 0;
}

/**
 * The report the command line prints and `--json` serializes.
 *
 * @typedef {object} CheckReport
 * @property {boolean} ok Both assertions hold.
 * @property {number} exitCode 0 when `ok`, otherwise 1.
 * @property {string} target Repository-relative POSIX path that was checked.
 * @property {string[]} markers The literals searched for.
 * @property {number} filesTracked Tracked files under `target`; never zero, because an empty
 *   target is a precondition failure rather than a report (see {@link scanResidualMarkers}).
 * @property {number} filesScanned Tracked entries actually read and searched.
 * @property {SkippedFile[]} skipped Tracked entries not read: submodules, and entries `git status`
 *   reports as changed, which is why `worktree` is dirty whenever one of those is listed.
 * @property {MarkerFinding[]} findings `residual-marker` violations.
 * @property {{ dirty: boolean, entries: string[] }} worktree `residual-worktree` violations.
 */

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} [pluralForm]
 * @returns {string}
 */
function plural(count, singular, pluralForm) {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/**
 * Why a `residual-marker` finding matters and how a developer clears it.
 *
 * @param {CheckReport} report
 * @returns {string[]} Lines of explanation.
 */
function markerExplanation(report) {
  return [
    `Tracked source under ${report.target} still contains instrumentation markers`,
    `(${report.markers.join(', ')}). Those literals are written only by the patch template`,
    'packages/instrumentation/src/patch/wrap-template.ts, so a patched file reached version',
    'control. Revert it through the product -- end the session, or start the local service once so',
    'it reconciles pending modification records from $DEBUGGEN_HOME -- then commit the restored',
    'file. Never hand-edit a patched file: that defeats the hash check cleanup relies on.',
  ];
}

/**
 * Why a `residual-worktree` finding matters and what usually causes it.
 *
 * @param {CheckReport} report
 * @returns {string[]} Lines of explanation.
 */
function worktreeExplanation(report) {
  return [
    `${report.target} has uncommitted changes, so its normal source state is not clean.`,
    'Likely causes: instrumentation was applied and never reverted, or a generated or local file',
    'is not covered by /.gitignore. Restore the files through the product, not by hand.',
  ];
}

/**
 * Render the human-readable report, findings first and the summary line last.
 *
 * @param {CheckReport} report
 * @returns {string} Text ending in a newline.
 */
function renderReport(report) {
  /** @type {string[]} */
  const lines = [];

  for (const finding of report.findings) {
    lines.push(`${finding.file}:${finding.line}: residual-marker: found ${finding.marker}`);
    if (finding.text !== '') {
      lines.push(`    | ${finding.text}`);
    }
  }
  if (report.findings.length > 0) {
    lines.push('', ...markerExplanation(report), '');
  }

  for (const entry of report.worktree.entries) {
    lines.push(`residual-worktree: ${entry}`);
  }
  if (report.worktree.dirty) {
    lines.push('', ...worktreeExplanation(report), '');
  }

  const markerCount = report.findings.length;
  const worktreeCount = report.worktree.entries.length;
  const parts = [
    `${report.filesScanned} ${plural(report.filesScanned, 'file')} scanned`,
    `${markerCount} marker ${plural(markerCount, 'finding')}`,
    `${worktreeCount} worktree ${plural(worktreeCount, 'entry', 'entries')}`,
  ];
  const submodules = report.skipped.filter((entry) => entry.reason === 'submodule').length;
  const notRead = report.skipped.length - submodules;
  if (notRead > 0) {
    parts.push(`${notRead} not read (reported by git status)`);
  }
  if (submodules > 0) {
    parts.push(`${submodules} ${plural(submodules, 'submodule')} skipped`);
  }
  const verdict = report.ok ? 'OK' : 'FAIL';
  lines.push(`residual-instrumentation: ${verdict}: ${report.target}: ${parts.join(', ')}`);

  return `${lines.join('\n')}\n`;
}

/**
 * @returns {string} The `--help` text, without a trailing newline.
 */
function helpText() {
  return [
    'Usage: node scripts/check-no-residual-instrumentation.mjs [options]',
    '',
    "Asserts that an instrumentation target's normal source state carries no leftover debugging",
    'instrumentation. Two independent rules, both scoped to the target path:',
    '',
    '  residual-marker    no entry listed by `git ls-files -z --stage -- <target>` holds any of',
    `                     the literals ${MARKERS.join(' or ')} that`,
    '                     the function-timing patch inserts. Every tracked regular file is',
    '                     searched byte for byte, a large one streamed; every tracked symbolic',
    '                     link as its target text, never followed; a submodule is skipped. An',
    '                     entry missing or replaced in the working tree is not read, and counts',
    '                     only when git status reports it, which fails residual-worktree.',
    '  residual-worktree  `git status --porcelain -- <target>` is empty, so every applied patch',
    '                     was reverted and nothing was left behind.',
    '',
    'Options:',
    `  --path <dir>  repository-relative directory to check (default: ${DEFAULT_TARGET_PATH}).`,
    '                tests/fixtures/sample-next-app is the other target used by this repository.',
    '                --path=<dir> is accepted too. The repository root itself is refused.',
    '  --json        print a machine-readable report on stdout instead of text.',
    '  -h, --help    print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  clean',
    '  1  a marker was found, or the target has uncommitted changes, which includes a tracked',
    '     file the scan did not read because it is missing or replaced in the working tree',
    '  2  usage or environment error: unknown option, git unavailable, not a git repository, a',
    '     missing target path, a target with no tracked file under it (a complete checkout',
    `     contains ${DEFAULT_TARGET_PATH}), a tracked file under it that cannot be read, listed`,
    '     with its error code (make it readable and re-run), or a tracked file missing or',
    '     replaced in the working tree that git status does not report, listed with the reason',
    '     (restore it: `git sparse-checkout disable`, or clear its skip-worktree or',
    '     assume-unchanged flag and `git checkout` it). The check refuses to pass over a subject',
    '     it did not read.',
    '',
    'The check only reads: it writes nothing to disk and never opens anything inside .git/.',
  ].join('\n');
}

/**
 * @typedef {object} CliOptions
 * @property {boolean} help
 * @property {boolean} json
 * @property {string} target
 */

/**
 * @param {readonly string[]} argv Arguments after the script path.
 * @returns {CliOptions}
 * @throws {ResidualCheckError} With code `usage` for an unknown option or a missing value.
 */
function parseArgs(argv) {
  /** @type {CliOptions} */
  const options = { help: false, json: false, target: DEFAULT_TARGET_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--path') {
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw usageError('--path requires a directory argument');
      }
      options.target = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--path=')) {
      const value = arg.slice('--path='.length);
      if (value === '') {
        throw usageError('--path requires a directory argument');
      }
      options.target = value;
      continue;
    }
    throw usageError(
      arg.startsWith('-') ? `unknown option: ${arg}` : `unexpected argument: ${arg}`,
    );
  }
  return options;
}

/**
 * Where to start looking for the work-tree root: this script's own directory, so the check behaves
 * the same however it was invoked and whatever the current directory is.
 *
 * @returns {string}
 */
function scriptDirectory() {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Run the check and return the process exit code. Nothing here calls `process.exit`, so in-process
 * callers (`tests/e2e/cleanup.spec.ts` and its helpers) can assert on the code directly.
 *
 * @param {readonly string[]} [argv] Arguments after the script path, as in `process.argv.slice(2)`.
 * @returns {Promise<number>} 0 clean, 1 findings, 2 usage or environment error.
 */
export async function main(argv = []) {
  /** @type {CliOptions} */
  let options;
  try {
    options = parseArgs(Array.isArray(argv) ? argv : []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`residual-instrumentation: ${message}\n\n${helpText()}\n`);
    return EXIT_ERROR;
  }

  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return EXIT_OK;
  }

  try {
    const scan = scanResidualMarkers(scriptDirectory(), options.target);
    const entries = worktreeStatus(scan.repoRoot, scan.target);
    const ok = scan.findings.length === 0 && entries.length === 0;
    /** @type {CheckReport} */
    const report = {
      ok,
      exitCode: ok ? EXIT_OK : EXIT_FINDINGS,
      target: scan.target,
      markers: [...MARKERS],
      filesTracked: scan.files.length,
      filesScanned: scan.filesScanned,
      skipped: scan.skipped,
      findings: scan.findings,
      worktree: { dirty: entries.length > 0, entries },
    };
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report),
    );
    return report.exitCode;
  } catch (error) {
    const code = error instanceof ResidualCheckError ? error.code : 'internal-error';
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      const failure = { ok: false, exitCode: EXIT_ERROR, error: { code, message } };
      process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    }
    // A bad --path value is only detected once the repository root is known, so the help text is
    // just as useful here as it is for an unknown option.
    const help = code === 'usage' && !options.json ? `\n${helpText()}\n` : '';
    process.stderr.write(`residual-instrumentation: ${code}: ${message}\n${help}`);
    return EXIT_ERROR;
  }
}

/**
 * `file` with every symbolic link resolved, or merely made absolute when it cannot be resolved.
 *
 * @param {string} file
 * @returns {string}
 */
function canonicalPath(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * Whether this module is the process entry point, so importing it (the tests, the end-to-end
 * helpers) never runs the command line.
 *
 * Both sides are canonicalized. Node reports `import.meta.url` as a real path but leaves
 * `process.argv[1]` as typed, so comparing the two as they come makes a run through any symbolic
 * link - a symlinked checkout, a linked workspace, macOS's `/tmp` - skip `main` entirely and exit 0
 * without printing a word: a gate that passes without looking, which is the one outcome it exists
 * to rule out.
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') {
    return false;
  }
  return canonicalPath(fileURLToPath(import.meta.url)) === canonicalPath(entry);
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
