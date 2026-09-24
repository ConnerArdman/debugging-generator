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
 *   1. `residual-marker`   no file listed by `git ls-files -z -- <target>` contains one of the
 *                          literal markers the function-timing patch inserts, so no patched
 *                          source was ever committed.
 *   2. `residual-worktree` `git status --porcelain -- <target>` is empty, so every applied patch
 *                          was reverted and nothing was left behind in the working tree.
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
 * is not a directory, and a target under which git tracks no file at all. The last one is the
 * dangerous case, because it looks like success; it is raised where enumeration happens, so the
 * in-process callers fail closed with the command line.
 *
 * Usage:  node scripts/check-no-residual-instrumentation.mjs [--path <dir>] [--json] [--help]
 * Exits:  0 clean | 1 marker found or working tree dirty | 2 usage or environment error, which
 *         includes a target with no tracked file under it.
 *
 * The script only reads. It writes nothing to disk, never opens anything inside `.git/` (the
 * repository's `origin` URL embeds a credential) and prints no file content beyond a sanitized
 * 120-character excerpt of an offending line.
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
/** Exit code: the check could not be performed (usage, git, a missing or empty target). */
const EXIT_ERROR = 2;

/** Bytes inspected when deciding whether a tracked file is binary. */
const BINARY_SNIFF_BYTES = 8192;
/** Files larger than this are reported as skipped rather than read into memory. */
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
/** Maximum length of the excerpt printed for an offending line. */
const MAX_SNIPPET_LENGTH = 120;
/** `git ls-files` on a large tree can produce a lot of output; give it room. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

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
 * A tracked file the scan deliberately did not read.
 *
 * @typedef {object} SkippedFile
 * @property {string} file Repository-relative POSIX path.
 * @property {'binary'|'symlink'|'not-a-regular-file'|'too-large'|'missing'|'unreadable'} reason
 */

/**
 * Full result of the marker scan.
 *
 * @typedef {object} MarkerScanResult
 * @property {string} repoRoot Absolute path of the git work-tree root.
 * @property {string} target Repository-relative POSIX path that was scanned.
 * @property {string[]} files Every tracked file under `target`.
 * @property {number} filesScanned How many of those files were read and searched.
 * @property {SkippedFile[]} skipped Files intentionally not searched, with the reason.
 * @property {MarkerFinding[]} findings Every marker occurrence, in file then line order.
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
 * Every file git tracks under `target`, repository-relative. Tracked-only enumeration is the point:
 * a patch that was applied but not committed is caught by the working-tree assertion instead, and
 * an untracked scratch file in a developer's tree is not this gate's business.
 *
 * @param {string} repoRoot Absolute work-tree root.
 * @param {string} target Repository-relative POSIX path.
 * @returns {string[]} Tracked paths, repository-relative.
 */
function listTrackedFiles(repoRoot, target) {
  const output = git(repoRoot, ['ls-files', '-z', '--', target]);
  return output.split('\0').filter((entry) => entry !== '');
}

/**
 * Treat a file as binary when the first bytes contain a NUL. Tracked images and fonts are skipped
 * this way without maintaining a second extension list.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isBinary(buffer) {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * Make one source line safe and short enough to print: control characters (which could smuggle
 * terminal escapes into CI logs) collapse to spaces, runs of whitespace collapse to one space, and
 * the result is truncated to `MAX_SNIPPET_LENGTH` characters.
 *
 * @param {string} line
 * @returns {string}
 */
function snippet(line) {
  // Built character by character rather than with a control-character regex, which every linter
  // flags for good reason: C0 controls and DEL become spaces, so no terminal escape can reach a
  // CI log through this excerpt.
  let neutralized = '';
  for (const character of line) {
    const code = character.codePointAt(0) ?? 0;
    neutralized += code < 0x20 || code === 0x7f ? ' ' : character;
  }
  const printable = neutralized.replace(/\s+/g, ' ').trim();
  if (printable.length <= MAX_SNIPPET_LENGTH) {
    return printable;
  }
  // Lengths are UTF-16 code units, so the cut can land between the two halves of a surrogate pair
  // (an emoji, say). A lone high surrogate is not well-formed text: it prints as U+FFFD and reaches
  // the `--json` report as an unpaired `\ud83d` escape that strict JSON parsers reject. Back off by
  // one unit in that case; the excerpt stays within the limit either way.
  let end = MAX_SNIPPET_LENGTH - 3;
  const lastUnit = printable.charCodeAt(end - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    end -= 1;
  }
  return `${printable.slice(0, end)}...`;
}

/**
 * Search one file's bytes for every marker, reporting 1-based line numbers.
 *
 * @param {string} file Repository-relative POSIX path, used in the finding.
 * @param {Buffer} buffer File contents.
 * @returns {MarkerFinding[]}
 */
function scanBuffer(file, buffer) {
  /** @type {MarkerFinding[]} */
  const findings = [];
  // Fast path: most files contain no marker at all, so avoid decoding and splitting them.
  if (!MARKERS.some((marker) => buffer.includes(marker))) {
    return findings;
  }
  const lines = buffer.toString('utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const marker of MARKERS) {
      if (line.includes(marker)) {
        findings.push({ file, line: index + 1, marker, text: snippet(line) });
      }
    }
  }
  return findings;
}

/**
 * Scan every tracked file under `relDir` for the instrumentation markers and report what was
 * searched as well as what was found. `findMarkers` is the terse wrapper around this; the command
 * line uses the full result so its summary line can name the number of files scanned.
 *
 * @param {string} root Any path inside the repository; the git work-tree root is derived from it.
 * @param {string} [relDir] Repository-relative directory to scan. Defaults to `apps/demo-app`.
 * @returns {MarkerScanResult}
 * @throws {ResidualCheckError} When git is unavailable, `root` is not a checkout, `relDir` is
 *   missing, outside the repository or not a directory, or - code `target-empty` - git tracks no
 *   file under it, which leaves the marker assertion with no subject.
 */
export function scanResidualMarkers(root, relDir) {
  const repoRoot = resolveRepoRoot(root);
  const target = normalizeTarget(repoRoot, relDir);
  assertTargetExists(repoRoot, target);

  const files = listTrackedFiles(repoRoot, target);
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
  /** @type {SkippedFile[]} */
  const skipped = [];
  let filesScanned = 0;

  for (const file of files) {
    const absolute = path.join(repoRoot, file);
    let stats;
    try {
      // lstat, not stat: a tracked symlink is never followed, so the scan cannot read outside the
      // work tree. A deleted-but-tracked file lands here too and is surfaced by the worktree check.
      stats = lstatSync(absolute);
    } catch {
      skipped.push({ file, reason: 'missing' });
      continue;
    }
    if (stats.isSymbolicLink()) {
      skipped.push({ file, reason: 'symlink' });
      continue;
    }
    if (!stats.isFile()) {
      skipped.push({ file, reason: 'not-a-regular-file' });
      continue;
    }
    if (stats.size > MAX_SCAN_BYTES) {
      skipped.push({ file, reason: 'too-large' });
      continue;
    }
    let buffer;
    try {
      buffer = readFileSync(absolute);
    } catch {
      skipped.push({ file, reason: 'unreadable' });
      continue;
    }
    if (isBinary(buffer)) {
      skipped.push({ file, reason: 'binary' });
      continue;
    }
    filesScanned += 1;
    findings.push(...scanBuffer(file, buffer));
  }

  return { repoRoot, target, files, filesScanned, skipped, findings };
}

/**
 * Every instrumentation marker occurrence in tracked source under `relDir`. An empty array means
 * the `residual-marker` assertion holds - and it can only mean that, because a target with no
 * tracked file under it raises instead of returning an empty array (see
 * {@link scanResidualMarkers}).
 *
 * @param {string} root Any path inside the repository; the git work-tree root is derived from it.
 * @param {string} [relDir] Repository-relative directory to scan. Defaults to `apps/demo-app`.
 * @returns {MarkerFinding[]}
 * @throws {ResidualCheckError} Everything {@link scanResidualMarkers} throws, including
 *   `target-empty`.
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
 * @property {number} filesScanned Tracked files actually read and searched.
 * @property {SkippedFile[]} skipped Tracked files deliberately not searched.
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
  if (report.skipped.length > 0) {
    parts.push(`${report.skipped.length} skipped (binary, symlink or oversized)`);
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
    '  residual-marker    no file listed by `git ls-files -z -- <target>` contains any of the',
    `                     literals ${MARKERS.join(' or ')} that the`,
    '                     function-timing patch inserts.',
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
    '  1  a marker was found, or the target has uncommitted changes',
    '  2  usage or environment error: unknown option, git unavailable, not a git repository, a',
    '     missing target path, or a target with no tracked file under it (a complete checkout',
    `     contains ${DEFAULT_TARGET_PATH}, and the check refuses to pass over an empty subject)`,
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
