/**
 * check-no-residual-instrumentation.test.mjs
 *
 * The proof that `scripts/check-no-residual-instrumentation.mjs` - the gate behind
 * `pnpm check:no-residual-instrumentation`, which `pnpm verify` runs - fails when a debugging
 * session left anything behind in the demo application and passes when it did not.
 *
 * WHAT THIS SUITE OWNS. The contract: the demo app's tracked source contains no instrumentation
 * marker - neither literal in `MARKERS` - and `git status --porcelain apps/demo-app` is empty
 * (docs/SECURITY.md, section 6.2, "Enforced in CI"). Each `describe` below owns one part of that
 * sentence or of the machinery around it, so a rule that loses its coverage is visible in the test
 * report rather than inferable from it:
 *
 *   * the marker contract - `MARKERS` agrees with the patch template that writes the literals;
 *   * a clean target passes, including the lowercase word `debuggen` that required files use;
 *   * a committed marker fails, with the exact 1-based line and a sanitized, bounded excerpt;
 *   * an uncommitted target fails, and nothing outside the target can make it fail;
 *   * every tracked entry is searched or accounted for, never passed over: a regular file byte for
 *     byte whatever it holds - streamed when it is large, markers straddling chunk boundaries
 *     included - and a tracked symbolic link as its target text, never followed; a submodule is
 *     skipped and listed; an entry missing or replaced in the working tree is skipped with its
 *     reason only when `git status` reports it, so the check exits 1, and fails the check with
 *     `file-unscanned` (exit 2) when it does not; and one the scan cannot read - on any account,
 *     root included - fails the check with `file-unreadable` (exit 2) naming it and its error code;
 *   * every condition that leaves the check without a subject exits 2, never 0 (it fails closed);
 *   * the command line - options, exit codes, the text and `--json` reports;
 *   * this repository - the gate passes over the real checkout while its demo app is clean.
 *
 * WHY EVERY FIXTURE IS A THROWAWAY REPOSITORY. The rules are about what git tracks and what
 * `git status` reports, so each case builds a real repository under
 * `fs.mkdtempSync(os.tmpdir() + '/dg-residual-')` with `git init -q`, commits with
 * `git -c user.name=test -c user.email=test@example.invalid commit`, and never touches any global
 * git configuration. Nothing is ever written inside this checkout, whose `git status` must stay
 * clean and whose `apps/demo-app` must never receive a marker literal; `afterAll` removes the
 * whole temporary tree. Every repository-locating `GIT_*` variable a git hook may have exported is
 * removed from the environment the fixtures are built with, so a run inside a hook cannot write a
 * fixture into the wrong index.
 *
 * HOW `main` IS DRIVEN IN PROCESS. `main` resolves the repository from the script's own directory,
 * which is this checkout. Git honours `GIT_DIR` and `GIT_WORK_TREE` from any directory, so
 * {@link runMain} sets both to a fixture for the duration of one call: the very module under test
 * then reports on that fixture, which is what lets the report, exit-code and error paths be
 * asserted - and measured by coverage - in process. Only the cases that are about being a command
 * spawn `node`: on a copy placed at `<fixture>/scripts/`, because a copy resolves the repository it
 * sits in, and through a symbolic link, because that is how a gate that skips `main` exits 0
 * without looking.
 *
 * WHY THE UNREADABLE FILE IS INJECTED. A tracked file the scan cannot read must fail the check,
 * and a mode bit cannot make such a file for root, which reads a mode-000 file regardless - and the
 * specified test host runs as root. So the fail-closed contract is asserted on every account by
 * {@link withInjectedFs}: a freshly imported copy of the module whose `node:fs` fails chosen
 * `readFileSync`, `lstatSync`, `readlinkSync` or `readSync` calls with the code the kernel would
 * report and delegates every other call to the real implementation, so the rest of the fixture is
 * genuinely read. The same wrappers record the paths they are called with, which is how the
 * streaming case proves a large file is opened and streamed rather than read whole.
 * {@link runMain} drives that copy's `main` exactly as it drives the real one. The `chmod` case
 * beside it is the real-permissions second opinion, and runs wherever the account is not root.
 *
 * WHY THE MARKERS ARE ASSEMBLED. Fixture source is built from the `MARKERS` export rather than
 * from restated literals, so a renamed marker changes every fixture with it. The two literals
 * appear spelled out exactly once, in the contract assertion, which is the point of that assertion.
 * This file lives under `scripts/`, never under the gate's target.
 *
 * HARNESS. The root `vitest.config.ts` collects this file into the `tooling` project
 * (`scripts/*.test.mjs`, environment `node`, `globals: false`), which `pnpm test` runs, and with it
 * `pnpm verify` and CI, as a blocking gate. `describe`/`it`/`expect` are imported explicitly
 * because that project sets no globals. Every case builds what it asserts about, and the
 * process environment is restored in `finally` blocks, so the suite is order-independent under
 * `--sequence.shuffle`. The git-dependent blocks skip themselves when `git --version` fails.
 */

import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TARGET_PATH,
  MARKERS,
  ResidualCheckError,
  findMarkers,
  main,
  scanResidualMarkers,
  worktreeDirty,
  worktreeStatus,
} from './check-no-residual-instrumentation.mjs';

/* ---------------------------------------------------------------------------
 * Constants mirrored from the module
 *
 * Stated here rather than exported by the module so that changing one there is a test failure
 * instead of a silent change: CI keys on the exit codes, and the excerpt bounds are a disclosure
 * budget for public CI logs.
 * ------------------------------------------------------------------------ */

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_ERROR = 2;

/** Longest excerpt printed for an offending line, ellipsis included. */
const MAX_SNIPPET_LENGTH = 120;

/** Regular files up to this size are read whole; larger ones are streamed. */
const MAX_WHOLE_READ_BYTES = 16 * 1024 * 1024;

/** Bytes read per step when a file is streamed; the chunk boundaries are multiples of it. */
const STREAM_CHUNK_BYTES = 1024 * 1024;

/** Bytes of an offending line decoded for its excerpt; a longer line's excerpt ends in `...`. */
const EXCERPT_WINDOW_BYTES = 4096;

/** The line-feed byte, the only line break the scan counts. */
const LINE_FEED = 0x0a;

/** First line of the `--help` text, which usage errors repeat on stderr. */
const USAGE_HEADING = 'Usage: node scripts/check-no-residual-instrumentation.mjs';

/** A generous per-test budget for the blocks that spawn git and node on a loaded host. */
const GIT_TEST_TIMEOUT_MS = 30_000;

/** Absolute path of this file's directory, which in a checkout is `<root>/scripts`. */
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of this repository's root, derived from this file's location. */
const REPOSITORY_ROOT = path.dirname(SCRIPT_DIRECTORY);

/** File name of the module under test, which a spawned copy keeps. */
const SCRIPT_NAME = 'check-no-residual-instrumentation.mjs';

/** The only code that writes the markers into a developer's source file. */
const TEMPLATE_REL = 'packages/instrumentation/src/patch/wrap-template.ts';

/** The span-helper global the patch reads, assembled from the export (see the header). */
const GLOBAL_MARKER = String(MARKERS[0]);

/** The type alias the patch inserts into `.ts`/`.tsx` files. */
const TYPE_MARKER = String(MARKERS[1]);

/**
 * Whether `git` can be spawned. The git-dependent blocks skip themselves when it cannot rather than
 * failing, because they test this script's wiring and not the host's toolchain.
 */
const GIT_AVAILABLE = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/* ---------------------------------------------------------------------------
 * Fixture source
 * ------------------------------------------------------------------------ */

/**
 * Spellings one edit away from a marker: lowercase, a missing trailing underscore, missing leading
 * underscores, uppercase. The match is exact and case-sensitive on purpose, and these prove it.
 */
const NEAR_MISSES = [
  GLOBAL_MARKER.toLowerCase(),
  GLOBAL_MARKER.slice(0, -1),
  TYPE_MARKER.replace(/^_+/, ''),
  TYPE_MARKER.toUpperCase(),
];

/**
 * An ordinary demo tree: TypeScript, TSX, JSON and an `.env.example` that names the development
 * role `debuggen` in lowercase, as the real `apps/demo-app/.env.example` must.
 *
 * @type {Readonly<Record<string, string>>}
 */
const CLEAN_FILES = Object.freeze({
  'package.json': '{ "name": "fixture-root", "private": true }\n',
  'apps/demo-app/package.json': '{ "name": "fixture-app", "private": true }\n',
  'apps/demo-app/tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
  'apps/demo-app/.env.example': [
    '# Development database for the debuggen demo.',
    'PGUSER=debuggen',
    'PGDATABASE=debuggen_dev',
    '',
  ].join('\n'),
  'apps/demo-app/src/total.ts': [
    'export function total(values: number[]): number {',
    '  return values.reduce((sum, value) => sum + value, 0);',
    '}',
    '',
  ].join('\n'),
  'apps/demo-app/src/label.tsx': [
    'export function Label(props: { text: string }) {',
    '  return <span>{props.text}</span>;',
    '}',
    '',
  ].join('\n'),
  'apps/demo-app/src/near-miss.ts': [
    ...NEAR_MISSES.map((spelling, index) => `export const nearMiss${index} = '${spelling}';`),
    '',
  ].join('\n'),
});

/** The tracked paths of {@link CLEAN_FILES} under the default target, in `git ls-files` order. */
const CLEAN_TARGET_FILES = Object.keys(CLEAN_FILES)
  .filter((file) => file.startsWith(`${DEFAULT_TARGET_PATH}/`))
  .sort();

/**
 * A five-line source file whose third line carries `marker`. Line 3 rather than line 1 is what
 * makes the reported line number an assertion instead of a coincidence.
 *
 * @param {string} marker
 * @returns {{ content: string, line: string }}
 */
function patchedSource(marker) {
  const line = `  const leftover = '${marker}';`;
  return {
    line,
    content: [
      '// A patched file that reached version control.',
      'export function total(values: number[]): number {',
      line,
      '  return values.length;',
      '}',
      '',
    ].join('\n'),
  };
}

/**
 * The shape the function-timing patch really writes: the inserted type alias on line 1 and the
 * helper lookup, which names the global twice and the alias once, on line 3.
 */
const WRAPPER_LINES = [
  `type ${TYPE_MARKER} = { span<T>(name: string, meta: Record<string, unknown>, fn: () => T): T };`,
  'export function total(values: number[]): number {',
  `  const __dbg = (globalThis as { ${GLOBAL_MARKER}?: ${TYPE_MARKER} }).${GLOBAL_MARKER};`,
  "  return __dbg ? __dbg.span('total', {}, () => values.length) : values.length;",
  '}',
  '',
];

/**
 * Width of every line of {@link largeSource}, line feed included. It does not divide
 * `STREAM_CHUNK_BYTES`, so the chunk boundaries of a streamed file fall inside lines, each at its
 * own column.
 */
const LARGE_LINE_BYTES = 100;

/**
 * How many lines {@link largeSource} writes: enough to pass `MAX_WHOLE_READ_BYTES` by half a
 * chunk, so the scan streams the file and its last window is a partial one.
 *
 * @returns {number}
 */
function largeLineCount() {
  return Math.ceil((MAX_WHOLE_READ_BYTES + STREAM_CHUNK_BYTES / 2) / LARGE_LINE_BYTES);
}

/**
 * A marker to write into {@link largeSource}.
 *
 * @typedef {object} LargePlacement
 * @property {number} offset Byte offset of the marker's first byte in the file.
 * @property {string} marker
 */

/**
 * The placement of `marker` across the boundary that ends chunk `chunk - 1`, with `before` of its
 * bytes on the earlier side. Asserts that it really straddles the boundary.
 *
 * @param {number} chunk 1-based index of the chunk the boundary opens.
 * @param {string} marker
 * @param {number} before Bytes of the marker before the boundary, at least one and not all.
 * @returns {LargePlacement}
 */
function straddling(chunk, marker, before) {
  expect(before).toBeGreaterThan(0);
  expect(before).toBeLessThan(marker.length);
  return { offset: chunk * STREAM_CHUNK_BYTES - before, marker };
}

/**
 * Content over `MAX_WHOLE_READ_BYTES` - so the scan streams it - made of fixed-width lines of `-`
 * ending in a line feed, with every placement written over the filler, and the findings the scan
 * must report for it. A placement must stay inside one line, which is asserted, so the line of
 * each marker is plain arithmetic and its excerpt is its whole line.
 *
 * @param {readonly LargePlacement[]} placements
 * @returns {{ content: Buffer, expected: { line: number, marker: string, text: string }[] }}
 *   The bytes, and one finding per marker per line in line then `MARKERS` order.
 */
function largeSource(placements) {
  const content = Buffer.alloc(largeLineCount() * LARGE_LINE_BYTES, '-');
  for (let end = LARGE_LINE_BYTES - 1; end < content.length; end += LARGE_LINE_BYTES) {
    content[end] = LINE_FEED;
  }
  for (const { offset, marker } of placements) {
    expect((offset % LARGE_LINE_BYTES) + marker.length).toBeLessThan(LARGE_LINE_BYTES);
    content.write(marker, offset, 'utf8');
  }
  /** @type {Map<string, { line: number, marker: string, text: string }>} */
  const findings = new Map();
  for (const { offset, marker } of placements) {
    const index = Math.floor(offset / LARGE_LINE_BYTES);
    const start = index * LARGE_LINE_BYTES;
    const text = content.toString('utf8', start, start + LARGE_LINE_BYTES - 1);
    findings.set(`${index}:${marker}`, { line: index + 1, marker, text });
  }
  const expected = [...findings.values()].sort(
    (left, right) =>
      left.line - right.line || MARKERS.indexOf(left.marker) - MARKERS.indexOf(right.marker),
  );
  return { content, expected };
}

/* ---------------------------------------------------------------------------
 * Temporary tree
 * ------------------------------------------------------------------------ */

/** @type {string | undefined} */
let temporaryBase;

/** Monotonic suffix, so fixture names never collide whatever order the cases run in. */
let directoryCount = 0;

/**
 * The run's temporary root, created on first use. Real path, because git reports real paths and
 * the assertions compare against them.
 *
 * @returns {string}
 */
function temporaryRoot() {
  if (temporaryBase === undefined) {
    temporaryBase = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dg-residual-')));
  }
  return temporaryBase;
}

/**
 * A fresh, empty directory under {@link temporaryRoot}.
 *
 * @param {string} label
 * @returns {string} Absolute real path.
 */
function createDirectory(label) {
  directoryCount += 1;
  const directory = path.join(temporaryRoot(), `${label}-${directoryCount}`);
  mkdirSync(directory);
  return directory;
}

afterAll(() => {
  if (temporaryBase !== undefined) {
    rmSync(temporaryBase, { recursive: true, force: true });
    temporaryBase = undefined;
  }
});

/* ---------------------------------------------------------------------------
 * Environment
 * ------------------------------------------------------------------------ */

/**
 * Variables that make git operate on a repository other than the one around its working
 * directory. A git hook exports some of them; {@link childEnvironment} removes all of them, and
 * {@link runMain} replaces them with a fixture's.
 */
const REPOSITORY_LOCATING_VARIABLES = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]);

/**
 * Overrides that remove every repository-locating variable and cap repository discovery at the
 * temporary root, so a fixture that is meant not to be a repository cannot find one further up.
 *
 * @returns {Record<string, string | undefined>}
 */
function isolatedEnvironment() {
  /** @type {Record<string, string | undefined>} */
  const overrides = {};
  for (const name of REPOSITORY_LOCATING_VARIABLES) {
    overrides[name] = undefined;
  }
  overrides.GIT_CEILING_DIRECTORIES = temporaryRoot();
  return overrides;
}

/**
 * The environment for every git and node child this suite spawns: the current one with
 * {@link isolatedEnvironment} applied.
 *
 * @returns {NodeJS.ProcessEnv}
 */
function childEnvironment() {
  const environment = { ...process.env };
  for (const [name, value] of Object.entries(isolatedEnvironment())) {
    if (value === undefined) {
      delete environment[name];
    } else {
      environment[name] = value;
    }
  }
  return environment;
}

/**
 * Apply `overrides` to `process.env`; `undefined` removes a variable.
 *
 * @param {Readonly<Record<string, string | undefined>>} overrides
 * @returns {Map<string, string | undefined>} The previous values, for {@link restoreEnvironment}.
 */
function applyEnvironment(overrides) {
  /** @type {Map<string, string | undefined>} */
  const previous = new Map();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  return previous;
}

/**
 * @param {Map<string, string | undefined>} previous
 * @returns {void}
 */
function restoreEnvironment(previous) {
  for (const [name, value] of previous) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

/**
 * Run a synchronous `operation` with `overrides` applied to `process.env`, restoring it whether the
 * operation returns or throws.
 *
 * @template T
 * @param {Readonly<Record<string, string | undefined>>} overrides
 * @param {() => T} operation
 * @returns {T}
 */
function withEnvironment(overrides, operation) {
  const previous = applyEnvironment(overrides);
  try {
    return operation();
  } finally {
    restoreEnvironment(previous);
  }
}

/**
 * Overrides that point every git command at `repository`, from whatever directory it runs in.
 *
 * @param {string} repository
 * @returns {Record<string, string | undefined>}
 */
function repositoryEnvironment(repository) {
  return {
    ...isolatedEnvironment(),
    GIT_DIR: path.join(repository, '.git'),
    GIT_WORK_TREE: repository,
  };
}

/* ---------------------------------------------------------------------------
 * Git fixtures
 * ------------------------------------------------------------------------ */

/**
 * Settings for the one commit each fixture makes: a throwaway identity, no signing and no hooks,
 * all passed with `-c` so no configuration file is written anywhere.
 */
const COMMIT_OPTIONS = Object.freeze([
  '-c',
  'user.name=test',
  '-c',
  'user.email=test@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
]);

/**
 * Run git in `cwd` for fixture setup and return its stdout.
 *
 * @param {string} cwd
 * @param {readonly string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: childEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Write `content` to `relPath` inside `root`, creating parent directories.
 *
 * @param {string} root
 * @param {string} relPath
 * @param {string | Buffer} content
 * @returns {string} Absolute path written.
 */
function writeFixture(root, relPath, content) {
  const absolute = path.join(root, relPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}

/**
 * Plant a symbolic link at `relPath` inside `root` pointing at `linkTarget` (relative to the link).
 *
 * @param {string} root
 * @param {string} relPath
 * @param {string} linkTarget
 * @returns {void}
 */
function plantSymlink(root, relPath, linkTarget) {
  const absolute = path.join(root, relPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  symlinkSync(linkTarget, absolute);
}

/**
 * Stage everything and commit it, so the tree starts clean.
 *
 * @param {string} repository
 * @returns {void}
 */
function commitAll(repository) {
  git(repository, ['add', '--all']);
  git(repository, [...COMMIT_OPTIONS, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'x']);
}

/**
 * A throwaway repository holding `files`, committed unless `commit` is false. `core.autocrlf` is
 * pinned in the repository's own configuration so a host-wide setting cannot rewrite the CRLF
 * fixture's line endings between the working tree and the index.
 *
 * @param {Readonly<Record<string, string | Buffer>>} files
 * @param {{ commit?: boolean }} [options]
 * @returns {string} Absolute real path of the work tree.
 */
function createRepository(files, { commit = true } = {}) {
  const repository = createDirectory('repo');
  git(repository, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repository, ['config', 'core.autocrlf', 'false']);
  for (const [relPath, content] of Object.entries(files)) {
    writeFixture(repository, relPath, content);
  }
  if (commit) {
    commitAll(repository);
  }
  return repository;
}

/* ---------------------------------------------------------------------------
 * Running the check
 * ------------------------------------------------------------------------ */

/**
 * @typedef {object} CliResult
 * @property {number | null} exitCode
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * The shape of the module's `main`, whether the statically imported one or the `main` of a copy
 * imported by {@link withInjectedFs}.
 *
 * @typedef {(argv?: readonly string[]) => Promise<number>} MainFunction
 */

/**
 * Run `main` in process with both streams captured. With `repository`, every git command `main`
 * spawns operates on that fixture (see the header); `environment` adds further overrides. `main`
 * selects which copy of the module runs - by default the one imported at the top of this file, or
 * the `main` of a copy {@link withInjectedFs} built against an injected `node:fs`, which honours
 * `repository` in exactly the same way because git is what locates the fixture.
 *
 * @param {unknown} argv Passed through untouched, so a non-array can be exercised.
 * @param {{
 *   repository?: string,
 *   environment?: Record<string, string | undefined>,
 *   main?: MainFunction,
 * }} [options]
 * @returns {Promise<CliResult>}
 */
async function runMain(argv, { repository, environment = {}, main: entry = main } = {}) {
  let stdout = '';
  let stderr = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  const previous = applyEnvironment({
    ...(repository === undefined ? {} : repositoryEnvironment(repository)),
    ...environment,
  });
  try {
    const exitCode = await entry(/** @type {string[]} */ (argv));
    return { exitCode, stdout, stderr };
  } finally {
    restoreEnvironment(previous);
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

/**
 * Copy the module under test to `<root>/scripts/`, where it resolves the repository `root` is in.
 *
 * @param {string} root
 * @returns {string} Absolute path of the copy.
 */
function installScriptCopy(root) {
  const copy = path.join(root, 'scripts', SCRIPT_NAME);
  mkdirSync(path.dirname(copy), { recursive: true });
  copyFileSync(path.join(SCRIPT_DIRECTORY, SCRIPT_NAME), copy);
  return copy;
}

/**
 * Run `script` as a command, the way `pnpm check:no-residual-instrumentation` does, from a working
 * directory outside every fixture.
 *
 * @param {string} script
 * @param {readonly string[]} argv
 * @returns {CliResult}
 */
function runCommand(script, argv) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    cwd: temporaryRoot(),
    encoding: 'utf8',
    env: childEnvironment(),
    timeout: GIT_TEST_TIMEOUT_MS,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Run `operation`, require it to throw a `ResidualCheckError` with `code`, and return the error.
 *
 * @param {() => unknown} operation
 * @param {string} code
 * @param {typeof ResidualCheckError} [errorClass] The class the error must be an instance of: by
 *   default the statically imported one; a copy imported by {@link withInjectedFs} has its own.
 * @returns {ResidualCheckError}
 */
function expectResidualError(operation, code, errorClass = ResidualCheckError) {
  /** @type {unknown} */
  let caught;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(errorClass);
  const error = /** @type {ResidualCheckError} */ (caught);
  expect(error.name).toBe('ResidualCheckError');
  expect(error.code).toBe(code);
  expect(error.message).not.toBe('');
  return error;
}

/**
 * Run `use` against a freshly imported copy of the module under test whose `node:fs` has the given
 * overrides merged over the real one.
 *
 * Why it exists: a tracked file the scan cannot read is a fail-closed path, and a mode bit cannot
 * provoke it for root (see the header). Injecting the failure asserts the contract on every
 * account. It is narrow on purpose: each override delegates to the real implementation for every
 * input it does not fail, so the rest of the fixture is genuinely examined, read and reported on.
 * The module registry is reset before the import so the copy is built against the injected module,
 * and again afterwards - passed or thrown - so every later import gets the genuine module. This
 * file's own `node:fs` bindings were resolved when it loaded and are untouched, which is what lets
 * a case build its fixture and inspect it normally.
 *
 * @param {(real: typeof import('node:fs')) => Partial<typeof import('node:fs')>} overrides
 * @param {(injected: typeof import('./check-no-residual-instrumentation.mjs')) => Promise<void>} use
 * @returns {Promise<void>}
 */
async function withInjectedFs(overrides, use) {
  vi.resetModules();
  vi.doMock('node:fs', async () => {
    const real = /** @type {typeof import('node:fs')} */ (await vi.importActual('node:fs'));
    return { ...real, ...overrides(real) };
  });

  try {
    await use(await import('./check-no-residual-instrumentation.mjs'));
  } finally {
    vi.doUnmock('node:fs');
    vi.resetModules();
  }
}

/**
 * Wrap a path-taking `node:fs` call so it fails for the absolute paths in `failures` and delegates
 * every other call to `genuine`. Each failure carries the errno `code`, `syscall` and `path` the
 * real call would report - `EACCES` on an `open` is exactly what a mode-000 file reports to an
 * unprivileged account - or, for a `null` code, no code at all, as a non-errno failure would.
 * Every string path the wrapper is asked for is appended to `calls`, so a case can prove which
 * files the scan went on to read after a failure.
 *
 * @template {(...args: any[]) => any} F
 * @param {F} genuine The real implementation.
 * @param {string} syscall The syscall name the real call reports, such as `open` or `lstat`.
 * @param {ReadonlyMap<string, string | null>} failures Absolute path to errno code.
 * @param {string[]} [calls] Receives every string path argument, in call order.
 * @returns {F}
 */
function failingFsCall(genuine, syscall, failures, calls) {
  return /** @type {F} */ (
    (/** @type {unknown} */ target, /** @type {unknown[]} */ ...rest) => {
      if (typeof target === 'string') {
        calls?.push(target);
        const code = failures.get(target);
        if (code !== undefined) {
          const error = new Error(`${code ?? 'failure'}: injected failure, ${syscall} '${target}'`);
          throw code === null ? error : Object.assign(error, { code, syscall, path: target });
        }
      }
      return genuine(target, ...rest);
    }
  );
}

/**
 * The summary line the text report ends with.
 *
 * @param {'OK' | 'FAIL'} verdict
 * @param {string} counts
 * @param {string} [target]
 * @returns {string}
 */
function summaryLine(verdict, counts, target = DEFAULT_TARGET_PATH) {
  return `residual-instrumentation: ${verdict}: ${target}: ${counts}\n`;
}

/* ---------------------------------------------------------------------------
 * The marker contract
 * ------------------------------------------------------------------------ */

describe('the marker contract', () => {
  it('lists exactly the two literals the patch writes, frozen, and targets apps/demo-app', () => {
    expect(MARKERS).toEqual(['__DEBUGGEN__', '__DebuggenSpanHelper']);
    expect(Object.isFrozen(MARKERS)).toBe(true);
    expect(DEFAULT_TARGET_PATH).toBe('apps/demo-app');
  });

  it('agrees with the declarations in packages/instrumentation/src/patch/wrap-template.ts', () => {
    // `@debuggen/instrumentation` is not a dependency of the root package, so the template is read
    // as text: each literal must be declared there, and the exported tuple must list both.
    const source = readFileSync(path.join(REPOSITORY_ROOT, TEMPLATE_REL), 'utf8');

    /** @param {string} name @returns {string | undefined} */
    const declared = (name) => source.match(new RegExp(`export const ${name} = '([^']*)'`))?.[1];
    expect(declared('SPAN_HELPER_GLOBAL')).toBe(GLOBAL_MARKER);
    expect(declared('SPAN_HELPER_TYPE_NAME')).toBe(TYPE_MARKER);

    const tuple = source.match(
      /export const INSTRUMENTATION_MARKERS = Object\.freeze\(\[([^\]]*)\]/,
    )?.[1];
    expect(
      tuple
        ?.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    ).toEqual(['SPAN_HELPER_GLOBAL', 'SPAN_HELPER_TYPE_NAME']);
  });

  it.skipIf(!GIT_AVAILABLE)(
    'finds each marker on the line of the template declaration that spells it',
    () => {
      // The scanner detects exactly what the writer declares: pointed at the template's own
      // directory, it reports each literal on the 1-based line of its declaration.
      const source = readFileSync(path.join(REPOSITORY_ROOT, TEMPLATE_REL), 'utf8');
      const lines = source.split(/\r?\n/);
      /** @param {string} name @returns {number} */
      const lineOf = (name) => lines.findIndex((line) => line.startsWith(`export const ${name} =`));

      const findings = findMarkers(REPOSITORY_ROOT, path.posix.dirname(TEMPLATE_REL)).filter(
        (finding) => finding.file === TEMPLATE_REL,
      );

      expect(findings).toContainEqual(
        expect.objectContaining({ line: lineOf('SPAN_HELPER_GLOBAL') + 1, marker: GLOBAL_MARKER }),
      );
      expect(findings).toContainEqual(
        expect.objectContaining({ line: lineOf('SPAN_HELPER_TYPE_NAME') + 1, marker: TYPE_MARKER }),
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

/* ---------------------------------------------------------------------------
 * A clean target passes
 * ------------------------------------------------------------------------ */

describe.skipIf(!GIT_AVAILABLE)('a clean target passes', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  /** Built once and only ever read, so the cases below can run in any order. */
  let repository = '';

  beforeAll(() => {
    repository = createRepository(CLEAN_FILES);
  });

  it('finds no marker in ordinary source, including the lowercase word debuggen', () => {
    for (const spelling of NEAR_MISSES) {
      expect(MARKERS.some((marker) => spelling.includes(marker))).toBe(false);
    }
    expect(CLEAN_FILES['apps/demo-app/.env.example']).toContain('debuggen');

    expect(findMarkers(repository)).toEqual([]);
    expect(scanResidualMarkers(repository)).toEqual({
      repoRoot: repository,
      target: DEFAULT_TARGET_PATH,
      files: CLEAN_TARGET_FILES,
      filesScanned: CLEAN_TARGET_FILES.length,
      skipped: [],
      findings: [],
    });
  });

  it('reports an empty worktree status for a committed target', () => {
    expect(worktreeStatus(repository)).toEqual([]);
    expect(worktreeDirty(repository)).toBe(false);
    expect(worktreeDirty(repository, DEFAULT_TARGET_PATH)).toBe(false);
  });

  it('exits 0 with the OK summary naming how many files it scanned', async () => {
    const { exitCode, stdout, stderr } = await runMain([], { repository });

    expect(exitCode).toBe(EXIT_OK);
    expect(stderr).toBe('');
    expect(stdout).toBe(
      summaryLine(
        'OK',
        `${CLEAN_TARGET_FILES.length} files scanned, 0 marker findings, 0 worktree entries`,
      ),
    );
  });

  it('prints an ok --json report with the tracked and scanned counts', async () => {
    const { exitCode, stdout, stderr } = await runMain(['--json'], { repository });

    expect(exitCode).toBe(EXIT_OK);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      exitCode: EXIT_OK,
      target: DEFAULT_TARGET_PATH,
      markers: [...MARKERS],
      filesTracked: CLEAN_TARGET_FILES.length,
      filesScanned: CLEAN_TARGET_FILES.length,
      skipped: [],
      findings: [],
      worktree: { dirty: false, entries: [] },
    });
  });

  it('checks the same target through --path <dir>, --path=<dir> and an absolute path', async () => {
    for (const argv of [
      ['--json', '--path', 'apps/demo-app'],
      ['--json', '--path=apps/demo-app'],
      ['--json', '--path', './apps/demo-app/'],
      ['--json', '--path', path.join(repository, 'apps', 'demo-app')],
    ]) {
      const { exitCode, stdout } = await runMain(argv, { repository });
      expect(exitCode).toBe(EXIT_OK);
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, target: DEFAULT_TARGET_PATH });
    }
  });

  it('checks a --path other than the default and names it in the summary', async () => {
    const { exitCode, stdout } = await runMain(['--path', 'apps/demo-app/src'], { repository });

    expect(exitCode).toBe(EXIT_OK);
    expect(stdout).toBe(
      summaryLine(
        'OK',
        '3 files scanned, 0 marker findings, 0 worktree entries',
        'apps/demo-app/src',
      ),
    );
  });

  it('resolves the work-tree root from a subdirectory or a file inside it', () => {
    const fromSubdirectory = scanResidualMarkers(path.join(repository, 'apps', 'demo-app', 'src'));
    expect(fromSubdirectory.repoRoot).toBe(repository);
    // The target stays repository-relative, never relative to the directory it was reached from.
    expect(fromSubdirectory.target).toBe(DEFAULT_TARGET_PATH);

    expect(scanResidualMarkers(path.join(repository, 'package.json')).repoRoot).toBe(repository);
    expect(scanResidualMarkers(repository, './apps/demo-app/').target).toBe(DEFAULT_TARGET_PATH);
    expect(scanResidualMarkers(repository, '   ').target).toBe(DEFAULT_TARGET_PATH);
  });

  it('starts from the current directory when no root is given', () => {
    const previous = process.cwd();
    process.chdir(path.join(repository, 'apps', 'demo-app', 'src'));
    try {
      expect(scanResidualMarkers(undefined).repoRoot).toBe(repository);
      expect(findMarkers('')).toEqual([]);
      expect(worktreeDirty('  ')).toBe(false);
    } finally {
      process.chdir(previous);
    }
  });

  it('treats an argv that is not an array as no arguments', async () => {
    const { exitCode, stdout } = await runMain('--frobnicate', { repository });

    expect(exitCode).toBe(EXIT_OK);
    expect(stdout).toContain('residual-instrumentation: OK: apps/demo-app:');
  });
});

/* ---------------------------------------------------------------------------
 * A committed marker fails
 * ------------------------------------------------------------------------ */

describe.skipIf(!GIT_AVAILABLE)(
  'a committed marker fails',
  { timeout: GIT_TEST_TIMEOUT_MS },
  () => {
    for (const marker of MARKERS) {
      it(`reports ${marker} on its exact line, in the text and the --json report`, async () => {
        const { content, line } = patchedSource(marker);
        const repository = createRepository({
          'package.json': CLEAN_FILES['package.json'],
          'apps/demo-app/src/patched.ts': content,
        });
        const expected = {
          file: 'apps/demo-app/src/patched.ts',
          line: 3,
          marker,
          text: line.trim(),
        };

        expect(findMarkers(repository)).toEqual([expected]);

        const text = await runMain([], { repository });
        expect(text.exitCode).toBe(EXIT_FINDINGS);
        expect(text.stderr).toBe('');
        expect(text.stdout).toContain(
          `apps/demo-app/src/patched.ts:3: residual-marker: found ${marker}\n    | ${line.trim()}\n`,
        );
        expect(
          text.stdout.endsWith(
            summaryLine('FAIL', '1 file scanned, 1 marker finding, 0 worktree entries'),
          ),
        ).toBe(true);

        const json = await runMain(['--json'], { repository });
        expect(json.exitCode).toBe(EXIT_FINDINGS);
        expect(JSON.parse(json.stdout)).toMatchObject({
          ok: false,
          exitCode: EXIT_FINDINGS,
          findings: [expected],
          worktree: { dirty: false, entries: [] },
        });
      });
    }

    it('reports every marker of a real patched wrapper once per line, in file then line order', async () => {
      const repository = createRepository({
        ...CLEAN_FILES,
        'apps/demo-app/src/total.ts': WRAPPER_LINES.join('\n'),
        'apps/demo-app/src/a-first.ts': patchedSource(GLOBAL_MARKER).content,
      });
      for (const line of WRAPPER_LINES) {
        expect(line.length).toBeLessThanOrEqual(MAX_SNIPPET_LENGTH);
      }

      const findings = findMarkers(repository);

      // Line 3 names the global twice and the alias once: one finding per marker per line, in the
      // order MARKERS lists them.
      expect(findings).toEqual([
        {
          file: 'apps/demo-app/src/a-first.ts',
          line: 3,
          marker: GLOBAL_MARKER,
          text: patchedSource(GLOBAL_MARKER).line.trim(),
        },
        {
          file: 'apps/demo-app/src/total.ts',
          line: 1,
          marker: TYPE_MARKER,
          text: WRAPPER_LINES[0],
        },
        {
          file: 'apps/demo-app/src/total.ts',
          line: 3,
          marker: GLOBAL_MARKER,
          text: String(WRAPPER_LINES[2]).trim(),
        },
        {
          file: 'apps/demo-app/src/total.ts',
          line: 3,
          marker: TYPE_MARKER,
          text: String(WRAPPER_LINES[2]).trim(),
        },
      ]);

      const { exitCode, stdout } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
      expect(stdout).toContain(
        `apps/demo-app/src/total.ts:3: residual-marker: found ${TYPE_MARKER}`,
      );
      // The explanation names the markers and the template that writes them, and that file exists.
      expect(stdout).toContain(`(${MARKERS.join(', ')})`);
      expect(stdout).toContain(TEMPLATE_REL);
      expect(existsSync(path.join(REPOSITORY_ROOT, TEMPLATE_REL))).toBe(true);
      expect(stdout).toContain(
        summaryLine(
          'FAIL',
          `${CLEAN_TARGET_FILES.length + 1} files scanned, 4 marker findings, 0 worktree entries`,
        ),
      );
    });

    it('reports the right line in a CRLF file and never prints a carriage return', () => {
      const repository = createRepository({
        'apps/demo-app/src/crlf.ts': [
          '// A file saved with Windows line endings.',
          'const a = 1;\rconst b = 2;',
          'const c = 3;',
          `const d = '${GLOBAL_MARKER}';\rconst e = 4;`,
          '',
        ].join('\r\n'),
      });

      // A lone CR is not a line break, so it neither shifts the count nor survives into the excerpt.
      expect(findMarkers(repository)).toEqual([
        {
          file: 'apps/demo-app/src/crlf.ts',
          line: 4,
          marker: GLOBAL_MARKER,
          text: `const d = '${GLOBAL_MARKER}'; const e = 4;`,
        },
      ]);
    });

    it('neutralizes control characters and collapses whitespace in the excerpt', async () => {
      const repository = createRepository({
        'apps/demo-app/src/escape.ts': `\t\tconst x = '${GLOBAL_MARKER}';\u001b[2J\u001b[31m alert\u0007\u007f  end  \n`,
      });

      const [finding] = findMarkers(repository);
      expect(finding?.text).toBe(`const x = '${GLOBAL_MARKER}'; [2J [31m alert end`);

      const { stdout } = await runMain([], { repository });
      for (const control of ['\u001b', '\u0007', '\u007f', '\t']) {
        expect(stdout).not.toContain(control);
      }
    });

    it('truncates an excerpt longer than 120 characters to 117 plus an ellipsis', () => {
      const prefix = `const leftover = '${GLOBAL_MARKER}'; //`;
      const exact = prefix + 'x'.repeat(MAX_SNIPPET_LENGTH - prefix.length);
      const over = `${exact}y`;
      const long = prefix + 'z'.repeat(300);
      const repository = createRepository({
        'apps/demo-app/src/exact.ts': `${exact}\n`,
        'apps/demo-app/src/long.ts': `${long}\n`,
        'apps/demo-app/src/over.ts': `${over}\n`,
      });

      const texts = new Map(findMarkers(repository).map((finding) => [finding.file, finding.text]));

      expect(texts.get('apps/demo-app/src/exact.ts')).toBe(exact);
      expect(texts.get('apps/demo-app/src/over.ts')).toBe(`${over.slice(0, 117)}...`);
      const truncated = texts.get('apps/demo-app/src/long.ts') ?? '';
      expect(truncated).toHaveLength(MAX_SNIPPET_LENGTH);
      expect(truncated).toBe(`${long.slice(0, 117)}...`);
    });

    it('never cuts a surrogate pair in half when it truncates an excerpt', () => {
      const prefix = `${GLOBAL_MARKER} `;
      const emoji = '\u{1F600}';
      // The pair straddles the cut (units 116 and 117) in one file and ends right before it in the
      // other; truncation must drop the whole pair in the first and keep it in the second.
      const straddling = `${prefix}${'a'.repeat(116 - prefix.length)}${emoji}${'b'.repeat(20)}`;
      const before = `${prefix}${'a'.repeat(115 - prefix.length)}${emoji}${'b'.repeat(20)}`;
      const repository = createRepository({
        'apps/demo-app/src/before.ts': `${before}\n`,
        'apps/demo-app/src/straddling.ts': `${straddling}\n`,
      });

      const texts = new Map(findMarkers(repository).map((finding) => [finding.file, finding.text]));

      const cut = texts.get('apps/demo-app/src/straddling.ts') ?? '';
      expect(cut).toBe(`${prefix}${'a'.repeat(116 - prefix.length)}...`);
      expect(cut.isWellFormed()).toBe(true);
      expect(JSON.stringify(cut)).not.toMatch(/\\ud[89ab]/i);

      const kept = texts.get('apps/demo-app/src/before.ts') ?? '';
      expect(kept).toBe(`${before.slice(0, 117)}...`);
      expect(kept).toContain(emoji);
      expect(kept.isWellFormed()).toBe(true);
    });

    it('builds the excerpt of a line longer than the excerpt window from its first bytes, ending in ...', () => {
      // The marker, then more blank bytes than the window holds, then text the excerpt never reads.
      const padded = `const leftover = '${GLOBAL_MARKER}';${' '.repeat(EXCERPT_WINDOW_BYTES)}// tail`;
      // A two-byte character whose first byte is the window's last: it is dropped, not decoded
      // into a replacement character.
      const prefix = `${TYPE_MARKER} `;
      const cut = `${prefix}${' '.repeat(EXCERPT_WINDOW_BYTES - prefix.length - 1)}\u00e9${'x'.repeat(8)}`;
      expect(Buffer.byteLength(cut.slice(0, cut.indexOf('\u00e9')))).toBe(EXCERPT_WINDOW_BYTES - 1);
      const repository = createRepository({
        'apps/demo-app/src/cut.ts': `${cut}\n`,
        'apps/demo-app/src/padded.ts': `${padded}\n`,
      });

      const texts = new Map(findMarkers(repository).map((finding) => [finding.file, finding.text]));

      expect(texts.get('apps/demo-app/src/padded.ts')).toBe(
        `const leftover = '${GLOBAL_MARKER}';...`,
      );
      expect(texts.get('apps/demo-app/src/cut.ts')).toBe(`${TYPE_MARKER}...`);
    });

    it('catches a patched file that was staged but never committed, twice over', async () => {
      const repository = createRepository(CLEAN_FILES);
      writeFixture(repository, 'apps/demo-app/src/staged.ts', patchedSource(TYPE_MARKER).content);
      git(repository, ['add', '--', 'apps/demo-app/src/staged.ts']);

      // `git ls-files` lists the index, so the marker scan sees it; `git status` sees it too.
      expect(findMarkers(repository)).toEqual([
        expect.objectContaining({
          file: 'apps/demo-app/src/staged.ts',
          line: 3,
          marker: TYPE_MARKER,
        }),
      ]);
      expect(worktreeStatus(repository)).toEqual(['A  apps/demo-app/src/staged.ts']);

      const { exitCode, stdout } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
      expect(stdout).toContain(
        `apps/demo-app/src/staged.ts:3: residual-marker: found ${TYPE_MARKER}`,
      );
      expect(stdout).toContain('residual-worktree: A  apps/demo-app/src/staged.ts\n');
    });

    it('leaves a marker in an untracked file to the worktree assertion, which still fails', async () => {
      const repository = createRepository({
        'package.json': CLEAN_FILES['package.json'],
        'apps/demo-app/src/total.ts': String(CLEAN_FILES['apps/demo-app/src/total.ts']),
      });
      writeFixture(
        repository,
        'apps/demo-app/src/untracked.ts',
        patchedSource(GLOBAL_MARKER).content,
      );

      expect(findMarkers(repository)).toEqual([]);
      expect(worktreeStatus(repository)).toEqual(['?? apps/demo-app/src/untracked.ts']);

      const { exitCode, stdout } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
      expect(
        stdout.endsWith(summaryLine('FAIL', '1 file scanned, 0 marker findings, 1 worktree entry')),
      ).toBe(true);
    });
  },
);

/* ---------------------------------------------------------------------------
 * An uncommitted target fails
 * ------------------------------------------------------------------------ */

describe.skipIf(!GIT_AVAILABLE)(
  'an uncommitted target fails the worktree assertion',
  { timeout: GIT_TEST_TIMEOUT_MS },
  () => {
    it('lists a modified, a staged and an untracked file, and nothing outside the target', async () => {
      const repository = createRepository(CLEAN_FILES);
      writeFixture(repository, 'apps/demo-app/src/total.ts', 'export const total = 0;\n');
      writeFixture(repository, 'apps/demo-app/src/added.ts', 'export const added = 1;\n');
      git(repository, ['add', '--', 'apps/demo-app/src/added.ts']);
      writeFixture(repository, 'apps/demo-app/src/scratch.ts', 'export const scratch = 2;\n');
      // Outside the target: an untracked file and a modified tracked one at the root.
      writeFixture(repository, 'notes.txt', 'root-level scratch\n');
      writeFixture(repository, 'package.json', '{ "name": "fixture-root", "version": "2.0.0" }\n');
      const expected = [
        ' M apps/demo-app/src/total.ts',
        '?? apps/demo-app/src/scratch.ts',
        'A  apps/demo-app/src/added.ts',
      ].sort();

      expect([...worktreeStatus(repository)].sort()).toEqual(expected);
      expect(worktreeDirty(repository)).toBe(true);

      const text = await runMain([], { repository });
      expect(text.exitCode).toBe(EXIT_FINDINGS);
      for (const entry of expected) {
        expect(text.stdout).toContain(`residual-worktree: ${entry}\n`);
      }
      expect(text.stdout).not.toContain('notes.txt');
      expect(text.stdout).toContain('apps/demo-app has uncommitted changes');
      expect(text.stdout).not.toContain('residual-marker');
      expect(
        text.stdout.endsWith(
          summaryLine(
            'FAIL',
            `${CLEAN_TARGET_FILES.length + 1} files scanned, 0 marker findings, 3 worktree entries`,
          ),
        ),
      ).toBe(true);

      const json = await runMain(['--json'], { repository });
      expect(json.exitCode).toBe(EXIT_FINDINGS);
      const report = JSON.parse(json.stdout);
      expect(report).toMatchObject({ ok: false, exitCode: EXIT_FINDINGS, findings: [] });
      expect(report.worktree.dirty).toBe(true);
      expect([...report.worktree.entries].sort()).toEqual(expected);
    });

    it('stays clean when only files outside the target changed', async () => {
      const repository = createRepository(CLEAN_FILES);
      writeFixture(repository, 'notes.txt', 'root-level scratch\n');
      writeFixture(repository, 'package.json', '{ "name": "fixture-root", "version": "2.0.0" }\n');
      installScriptCopy(repository);

      expect(worktreeStatus(repository)).toEqual([]);
      expect(worktreeDirty(repository)).toBe(false);
      expect(git(repository, ['status', '--porcelain'])).not.toBe('');

      const { exitCode } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_OK);
    });

    it('stays clean when the only new files under the target are ignored build output', async () => {
      const repository = createRepository({
        ...CLEAN_FILES,
        '.gitignore': 'apps/demo-app/.next/\n',
      });
      writeFixture(repository, 'apps/demo-app/.next/cache.json', '{}\n');

      expect(worktreeStatus(repository)).toEqual([]);
      const { exitCode } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_OK);
    });
  },
);

/* ---------------------------------------------------------------------------
 * Every tracked entry is read or accounted for
 * ------------------------------------------------------------------------ */

describe.skipIf(!GIT_AVAILABLE)(
  'every tracked entry is searched whatever it holds, or accounted for by git status, or fails closed',
  { timeout: GIT_TEST_TIMEOUT_MS },
  () => {
    it('searches a binary file byte for byte and reports the marker bytes after its NUL', async () => {
      const repository = createRepository({
        ...CLEAN_FILES,
        // A PNG signature - with its CR, LF, SUB and a NUL - followed by both markers.
        'apps/demo-app/public/logo.png': Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
          Buffer.from(`${GLOBAL_MARKER}\n${TYPE_MARKER}\n`, 'utf8'),
        ]),
        'apps/demo-app/public/clean.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a]),
      });

      const scan = scanResidualMarkers(repository);
      // The signature's two line feeds put the markers on lines 3 and 4; the NUL before the first
      // one becomes a space in the excerpt and is trimmed away.
      expect(scan.findings).toEqual([
        {
          file: 'apps/demo-app/public/logo.png',
          line: 3,
          marker: GLOBAL_MARKER,
          text: GLOBAL_MARKER,
        },
        { file: 'apps/demo-app/public/logo.png', line: 4, marker: TYPE_MARKER, text: TYPE_MARKER },
      ]);
      expect(scan.skipped).toEqual([]);
      expect(scan.filesScanned).toBe(CLEAN_TARGET_FILES.length + 2);

      const { exitCode, stdout } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
      expect(stdout).toContain(
        `apps/demo-app/public/logo.png:3: residual-marker: found ${GLOBAL_MARKER}\n`,
      );
      expect(stdout).not.toContain('clean.png');
      expect(
        stdout.endsWith(
          summaryLine(
            'FAIL',
            `${CLEAN_TARGET_FILES.length + 2} files scanned, 2 marker findings, 0 worktree entries`,
          ),
        ),
      ).toBe(true);
    });

    it('reports a marker in a source file whatever NUL bytes precede it', () => {
      const repository = createRepository({
        'apps/demo-app/src/nul.ts': Buffer.concat([
          Buffer.from('// a NUL byte follows: \0 and ends this line\n', 'utf8'),
          Buffer.from('export const values: number[] = [];\n', 'utf8'),
          Buffer.from(`const leftover = '\0${TYPE_MARKER}';\n`, 'utf8'),
        ]),
      });

      expect(scanResidualMarkers(repository)).toMatchObject({
        filesScanned: 1,
        skipped: [],
        findings: [
          {
            file: 'apps/demo-app/src/nul.ts',
            line: 3,
            marker: TYPE_MARKER,
            text: `const leftover = ' ${TYPE_MARKER}';`,
          },
        ],
      });
    });

    it('streams a tracked file over 16 MiB and reports every marker on its exact line, across chunk boundaries', async () => {
      const lastLine = largeLineCount() - 1;
      const { content, expected } = largeSource([
        // Early in the first chunk, twice on one line: one finding.
        { offset: 2 * LARGE_LINE_BYTES + 10, marker: GLOBAL_MARKER },
        { offset: 2 * LARGE_LINE_BYTES + 40, marker: GLOBAL_MARKER },
        // Straddling chunk boundaries: only the last byte after one, the full overlap needed...
        straddling(5, GLOBAL_MARKER, GLOBAL_MARKER.length - 1),
        straddling(7, TYPE_MARKER, TYPE_MARKER.length - 1),
        // ...only the first byte before one, and an even split.
        straddling(9, GLOBAL_MARKER, 1),
        straddling(11, TYPE_MARKER, TYPE_MARKER.length / 2),
        // Both markers on the last line, the alias first: reported in MARKERS order all the same.
        { offset: lastLine * LARGE_LINE_BYTES + 10, marker: TYPE_MARKER },
        { offset: lastLine * LARGE_LINE_BYTES + 50, marker: GLOBAL_MARKER },
      ]);
      expect(content.length).toBeGreaterThan(MAX_WHOLE_READ_BYTES);
      expect(expected).toHaveLength(7);
      const repository = createRepository(CLEAN_FILES);
      // Written after the commit, so the working tree is dirty as well.
      const large = writeFixture(repository, 'apps/demo-app/src/total.ts', content);
      const findings = expected.map((finding) => ({
        file: 'apps/demo-app/src/total.ts',
        ...finding,
      }));

      const scan = scanResidualMarkers(repository);
      expect(scan.findings).toEqual(findings);
      expect(scan.skipped).toEqual([]);
      expect(scan.filesScanned).toBe(CLEAN_TARGET_FILES.length);
      expect(worktreeStatus(repository)).toEqual([' M apps/demo-app/src/total.ts']);

      // It is streamed through a descriptor, never read whole, and every other file is read whole.
      /** @type {string[]} */
      const wholeReads = [];
      /** @type {string[]} */
      const opened = [];
      await withInjectedFs(
        (real) => ({
          readFileSync: failingFsCall(real.readFileSync, 'open', new Map(), wholeReads),
          openSync: failingFsCall(real.openSync, 'open', new Map(), opened),
        }),
        async (injected) => {
          expect(injected.findMarkers(repository)).toEqual(findings);
        },
      );
      expect(opened).toEqual([large]);
      expect(wholeReads).toEqual(
        CLEAN_TARGET_FILES.filter((file) => file !== 'apps/demo-app/src/total.ts').map((file) =>
          path.join(repository, file),
        ),
      );

      const { exitCode, stdout } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
      for (const { line, marker } of expected) {
        expect(stdout).toContain(
          `apps/demo-app/src/total.ts:${line}: residual-marker: found ${marker}\n`,
        );
      }
      expect(stdout).toContain('residual-worktree:  M apps/demo-app/src/total.ts\n');
    });

    it('streams a large clean file to the end, finds nothing and counts it as scanned', async () => {
      const repository = createRepository({
        ...CLEAN_FILES,
        'apps/demo-app/public/bundle.js': largeSource([]).content,
      });

      const scan = scanResidualMarkers(repository);
      expect(scan).toMatchObject({ filesScanned: CLEAN_TARGET_FILES.length + 1, skipped: [] });
      expect(scan.findings).toEqual([]);

      const { exitCode, stdout } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_OK);
      expect(stdout).toBe(
        summaryLine(
          'OK',
          `${CLEAN_TARGET_FILES.length + 1} files scanned, 0 marker findings, 0 worktree entries`,
        ),
      );
    });

    it('fails closed on a streamed file whose read fails part-way, and still closes it (file-unreadable)', async () => {
      const repository = createRepository(CLEAN_FILES);
      const large = writeFixture(repository, 'apps/demo-app/src/total.ts', largeSource([]).content);
      /** @type {string[]} */
      const opened = [];
      let closed = 0;

      await withInjectedFs(
        (real) => ({
          openSync: failingFsCall(real.openSync, 'open', new Map(), opened),
          // The fourth chunk fails with an I/O error: three were read, so the file was partly
          // searched, which is not searched.
          readSync: (
            /** @type {number} */ descriptor,
            /** @type {Buffer} */ buffer,
            /** @type {number} */ offset,
            /** @type {number} */ length,
            /** @type {number} */ position,
          ) => {
            if (position >= 3 * STREAM_CHUNK_BYTES) {
              throw Object.assign(new Error('EIO: injected failure, read'), {
                code: 'EIO',
                syscall: 'read',
              });
            }
            return real.readSync(descriptor, buffer, offset, length, position);
          },
          closeSync: (/** @type {number} */ descriptor) => {
            closed += 1;
            real.closeSync(descriptor);
          },
        }),
        async (injected) => {
          const error = expectResidualError(
            () => injected.scanResidualMarkers(repository),
            'file-unreadable',
            injected.ResidualCheckError,
          );
          expect(error.message).toContain(
            '1 tracked file under apps/demo-app could not be read, so the marker scan cannot ' +
              'vouch for it and this check cannot be performed:\n' +
              '  apps/demo-app/src/total.ts (EIO)\n',
          );
          expect(/** @type {AggregateError} */ (error.cause).errors).toEqual([
            expect.objectContaining({ code: 'EIO', syscall: 'read' }),
          ]);

          const { exitCode, stdout } = await runMain(['--json'], {
            repository,
            main: injected.main,
          });
          expect(exitCode).toBe(EXIT_ERROR);
          expect(JSON.parse(stdout).error).toEqual({
            code: 'file-unreadable',
            message: error.message,
          });
        },
      );
      expect(opened).toEqual([large, large]);
      expect(closed).toBe(opened.length);
    });

    it('searches a tracked symbolic link as its target text and never follows it', async () => {
      const repository = createRepository({
        ...CLEAN_FILES,
        'vendor/patched.ts': patchedSource(GLOBAL_MARKER).content,
      });
      plantSymlink(repository, 'apps/demo-app/src/linked.ts', '../../../vendor/patched.ts');
      commitAll(repository);

      // The link's target does carry a marker, outside the target...
      expect(findMarkers(repository, 'vendor')).toHaveLength(1);
      // ...and the scan of the target searches the link's own content, its target text, instead.
      const scan = scanResidualMarkers(repository);
      expect(scan.findings).toEqual([]);
      expect(scan.skipped).toEqual([]);
      expect(scan.files).toContain('apps/demo-app/src/linked.ts');
      expect(scan.filesScanned).toBe(CLEAN_TARGET_FILES.length + 1);

      const { exitCode, stdout } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_OK);
      expect(stdout).toBe(
        summaryLine(
          'OK',
          `${CLEAN_TARGET_FILES.length + 1} files scanned, 0 marker findings, 0 worktree entries`,
        ),
      );
    });

    it('reports a marker in the target text of a tracked symbolic link, dangling or not', async () => {
      const linkTarget = `../../generated/${GLOBAL_MARKER}.ts`;
      const repository = createRepository(CLEAN_FILES);
      plantSymlink(repository, 'apps/demo-app/src/linked.ts', linkTarget);
      commitAll(repository);

      expect(findMarkers(repository)).toEqual([
        { file: 'apps/demo-app/src/linked.ts', line: 1, marker: GLOBAL_MARKER, text: linkTarget },
      ]);
      const { exitCode, stdout } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
      expect(stdout).toContain(
        `apps/demo-app/src/linked.ts:1: residual-marker: found ${GLOBAL_MARKER}\n    | ${linkTarget}\n`,
      );
    });

    it('reads a regular file standing where git tracks a symbolic link as the text it holds', () => {
      const repository = createRepository(CLEAN_FILES);
      plantSymlink(repository, 'apps/demo-app/src/linked.ts', 'total.ts');
      commitAll(repository);
      // A checkout with core.symlinks=false writes a link as a regular file; this one carries a
      // marker, and is searched like any other regular file.
      unlinkSync(path.join(repository, 'apps/demo-app/src/linked.ts'));
      writeFixture(repository, 'apps/demo-app/src/linked.ts', patchedSource(TYPE_MARKER).content);

      expect(findMarkers(repository)).toEqual([
        expect.objectContaining({
          file: 'apps/demo-app/src/linked.ts',
          line: 3,
          marker: TYPE_MARKER,
        }),
      ]);
      expect(worktreeStatus(repository)).toEqual([' T apps/demo-app/src/linked.ts']);
    });

    it('fails closed on a tracked symbolic link whose target text cannot be read (file-unreadable)', async () => {
      const repository = createRepository(CLEAN_FILES);
      plantSymlink(repository, 'apps/demo-app/src/linked.ts', 'total.ts');
      commitAll(repository);
      const link = path.join(repository, 'apps/demo-app/src/linked.ts');

      await withInjectedFs(
        (real) => ({
          readlinkSync: failingFsCall(real.readlinkSync, 'readlink', new Map([[link, 'EIO']])),
        }),
        async (injected) => {
          const error = expectResidualError(
            () => injected.scanResidualMarkers(repository),
            'file-unreadable',
            injected.ResidualCheckError,
          );
          expect(error.message).toContain(
            '1 tracked file under apps/demo-app could not be read, so the marker scan cannot ' +
              'vouch for it and this check cannot be performed:\n' +
              '  apps/demo-app/src/linked.ts (EIO)\n',
          );
        },
      );
    });

    it('lists an unmerged path once, however many merge stages the index holds it at', async () => {
      const repository = createRepository(CLEAN_FILES);
      const file = 'apps/demo-app/src/total.ts';
      git(repository, ['checkout', '-q', '-b', 'other']);
      writeFixture(repository, file, 'export const total = 1;\n');
      commitAll(repository);
      git(repository, ['checkout', '-q', 'main']);
      writeFixture(repository, file, 'export const total = 2;\n');
      commitAll(repository);
      const merge = spawnSync('git', [...COMMIT_OPTIONS, 'merge', '-q', '--no-edit', 'other'], {
        cwd: repository,
        encoding: 'utf8',
        env: childEnvironment(),
      });
      // A conflict: the index holds the path at stages 1, 2 and 3.
      expect(merge.status).toBe(1);
      expect(git(repository, ['ls-files', '--stage', '--', file]).trim().split('\n')).toHaveLength(
        3,
      );

      const scan = scanResidualMarkers(repository);
      expect(scan.files).toEqual(CLEAN_TARGET_FILES);
      expect(scan.filesScanned).toBe(CLEAN_TARGET_FILES.length);
      expect(scan).toMatchObject({ skipped: [], findings: [] });
      expect(worktreeStatus(repository)).toEqual([`UU ${file}`]);
      const { exitCode } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
    });

    it('skips a submodule as submodule, and names it in the summary', async () => {
      const repository = createRepository(CLEAN_FILES);
      const commit = git(repository, ['rev-parse', 'HEAD']).trim();
      git(repository, [
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${commit},apps/demo-app/vendor/sub`,
      ]);
      git(repository, [...COMMIT_OPTIONS, 'commit', '-q', '--no-verify', '-m', 'submodule']);
      // An uninitialized submodule: an empty directory, which git status reports as unchanged.
      mkdirSync(path.join(repository, 'apps/demo-app/vendor/sub'), { recursive: true });
      expect(worktreeStatus(repository)).toEqual([]);

      const scan = scanResidualMarkers(repository);
      expect(scan.files).toEqual([...CLEAN_TARGET_FILES, 'apps/demo-app/vendor/sub']);
      expect(scan.skipped).toEqual([{ file: 'apps/demo-app/vendor/sub', reason: 'submodule' }]);
      expect(scan.filesScanned).toBe(CLEAN_TARGET_FILES.length);

      const { exitCode, stdout } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_OK);
      expect(stdout).toBe(
        summaryLine(
          'OK',
          `${CLEAN_TARGET_FILES.length} files scanned, 0 marker findings, 0 worktree entries, ` +
            '1 submodule skipped',
        ),
      );
    });

    it('records a tracked file deleted from disk as missing and as a worktree entry', async () => {
      const repository = createRepository(CLEAN_FILES);
      unlinkSync(path.join(repository, 'apps/demo-app/src/total.ts'));

      const scan = scanResidualMarkers(repository);
      expect(scan.skipped).toEqual([{ file: 'apps/demo-app/src/total.ts', reason: 'missing' }]);
      expect(scan.filesScanned).toBe(CLEAN_TARGET_FILES.length - 1);
      expect(worktreeStatus(repository)).toEqual([' D apps/demo-app/src/total.ts']);

      const { exitCode, stdout } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
      expect(stdout).toContain('residual-worktree:  D apps/demo-app/src/total.ts\n');
      expect(
        stdout.endsWith(
          summaryLine(
            'FAIL',
            `${CLEAN_TARGET_FILES.length - 1} files scanned, 0 marker findings, 1 worktree entry, ` +
              '1 not read (reported by git status)',
          ),
        ),
      ).toBe(true);
    });

    it('records tracked files as missing when their parent directory became a file (ENOTDIR)', async () => {
      // ENOENT and ENOTDIR are the two lstat codes that mean "not on disk"; every other lstat
      // failure is an unreadable file (below). This is the ENOTDIR half, provoked for real.
      const repository = createRepository(CLEAN_FILES);
      const directory = path.join(repository, 'apps/demo-app/src');
      rmSync(directory, { recursive: true });
      writeFileSync(directory, 'no longer a directory\n');
      const underDirectory = CLEAN_TARGET_FILES.filter((file) =>
        file.startsWith('apps/demo-app/src/'),
      );

      const scan = scanResidualMarkers(repository);
      expect(scan.skipped).toEqual(underDirectory.map((file) => ({ file, reason: 'missing' })));
      expect(scan.filesScanned).toBe(CLEAN_TARGET_FILES.length - underDirectory.length);
      expect(worktreeStatus(repository)).toEqual(
        expect.arrayContaining([' D apps/demo-app/src/total.ts', '?? apps/demo-app/src']),
      );

      const { exitCode } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
    });

    it('records a tracked path replaced by a directory as not a regular file', async () => {
      const repository = createRepository(CLEAN_FILES);
      const replaced = path.join(repository, 'apps/demo-app/src/total.ts');
      unlinkSync(replaced);
      mkdirSync(replaced);

      expect(scanResidualMarkers(repository).skipped).toEqual([
        { file: 'apps/demo-app/src/total.ts', reason: 'not-a-regular-file' },
      ]);
      expect(worktreeStatus(repository)).toEqual([' D apps/demo-app/src/total.ts']);
      const { exitCode } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
    });

    it('never opens a FIFO standing at a tracked path, which git reports as modified', async (context) => {
      const repository = createRepository(CLEAN_FILES);
      const fifo = path.join(repository, 'apps/demo-app/src/total.ts');
      unlinkSync(fifo);
      const made = spawnSync('mkfifo', [fifo], { env: childEnvironment() });
      context.skip(
        made.error !== undefined || made.status !== 0,
        'mkfifo is not available on this host; the directory case above covers not-a-regular-file',
      );

      // Opening a FIFO for reading blocks until a writer appears, so a scan that read it would
      // never return: this case finishing at all is half of the assertion.
      expect(scanResidualMarkers(repository).skipped).toEqual([
        { file: 'apps/demo-app/src/total.ts', reason: 'not-a-regular-file' },
      ]);
      expect(worktreeStatus(repository)).toEqual([' M apps/demo-app/src/total.ts']);
      const { exitCode } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
    });

    it('records a symbolic link standing where git tracks a regular file, without following it', async () => {
      const repository = createRepository({
        ...CLEAN_FILES,
        'vendor/patched.ts': patchedSource(GLOBAL_MARKER).content,
      });
      unlinkSync(path.join(repository, 'apps/demo-app/src/total.ts'));
      plantSymlink(repository, 'apps/demo-app/src/total.ts', '../../../vendor/patched.ts');

      const scan = scanResidualMarkers(repository);
      expect(scan.findings).toEqual([]);
      expect(scan.skipped).toEqual([{ file: 'apps/demo-app/src/total.ts', reason: 'symlink' }]);
      expect(worktreeStatus(repository)).toEqual([' T apps/demo-app/src/total.ts']);
      const { exitCode } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
    });

    it('never reads through a directory replaced with a symbolic link', async () => {
      const repository = createRepository(CLEAN_FILES);
      const underDirectory = CLEAN_TARGET_FILES.filter((file) =>
        file.startsWith('apps/demo-app/src/'),
      );
      // A stand-in outside the checkout, holding the same names, one of them patched.
      const elsewhere = createDirectory('elsewhere');
      for (const file of underDirectory) {
        writeFixture(elsewhere, path.posix.basename(file), patchedSource(GLOBAL_MARKER).content);
      }
      rmSync(path.join(repository, 'apps/demo-app/src'), { recursive: true });
      symlinkSync(elsewhere, path.join(repository, 'apps/demo-app/src'));

      const scan = scanResidualMarkers(repository);
      expect(scan.findings).toEqual([]);
      expect(scan.skipped).toEqual(
        underDirectory.map((file) => ({ file, reason: 'symlinked-directory' })),
      );
      expect([...worktreeStatus(repository)].sort()).toEqual(
        [...underDirectory.map((file) => ` D ${file}`), '?? apps/demo-app/src'].sort(),
      );

      const { exitCode, stdout } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
      expect(
        stdout.endsWith(
          summaryLine(
            'FAIL',
            `${CLEAN_TARGET_FILES.length - underDirectory.length} files scanned, 0 marker ` +
              `findings, ${underDirectory.length + 1} worktree entries, ` +
              `${underDirectory.length} not read (reported by git status)`,
          ),
        ),
      ).toBe(true);
    });

    it('fails closed on a missing file git status does not report (skip-worktree, file-unscanned)', async () => {
      const repository = createRepository(CLEAN_FILES);
      git(repository, ['update-index', '--skip-worktree', '--', 'apps/demo-app/src/total.ts']);
      unlinkSync(path.join(repository, 'apps/demo-app/src/total.ts'));
      // A sparse checkout's state: git neither compares the path nor reports it.
      expect(worktreeStatus(repository)).toEqual([]);

      const error = expectResidualError(() => scanResidualMarkers(repository), 'file-unscanned');
      expect(error.message).toBe(
        '1 tracked file under apps/demo-app is not in the working tree as git records it, and ' +
          '`git status` does not report it as changed, so the marker scan cannot vouch for it and ' +
          'this check cannot be performed:\n' +
          '  apps/demo-app/src/total.ts (missing)\n' +
          'Git does not compare a path with the working tree while the index marks it ' +
          'skip-worktree (a sparse checkout) or assume-unchanged. Restore every listed file - run ' +
          '`git sparse-checkout disable`, or clear each flag with ' +
          '`git update-index --no-skip-worktree -- <path>` and ' +
          '`git update-index --no-assume-unchanged -- <path>` (one flag per command) and run ' +
          '`git checkout -- <path>` - then re-run the check.',
      );
      expectResidualError(() => findMarkers(repository), 'file-unscanned');

      const text = await runMain([], { repository });
      expect(text.exitCode).toBe(EXIT_ERROR);
      expect(text.stdout).toBe('');
      expect(text.stderr).toBe(`residual-instrumentation: file-unscanned: ${error.message}\n`);

      const json = await runMain(['--json'], { repository });
      expect(json.exitCode).toBe(EXIT_ERROR);
      expect(JSON.parse(json.stdout)).toEqual({
        ok: false,
        exitCode: EXIT_ERROR,
        error: { code: 'file-unscanned', message: error.message },
      });

      // The remedy the message names, command by command, restores a subject and the check passes.
      for (const flag of ['--no-skip-worktree', '--no-assume-unchanged']) {
        git(repository, ['update-index', flag, '--', 'apps/demo-app/src/total.ts']);
      }
      git(repository, ['checkout', '--', 'apps/demo-app/src/total.ts']);
      expect((await runMain([], { repository })).exitCode).toBe(EXIT_OK);
    });

    it('lists every unread entry git status does not report with its reason, and only those', () => {
      const repository = createRepository(CLEAN_FILES);
      // Hidden by assume-unchanged: a file replaced by a directory, and one replaced by a link.
      git(repository, [
        'update-index',
        '--assume-unchanged',
        '--',
        'apps/demo-app/src/label.tsx',
        'apps/demo-app/src/total.ts',
      ]);
      unlinkSync(path.join(repository, 'apps/demo-app/src/label.tsx'));
      mkdirSync(path.join(repository, 'apps/demo-app/src/label.tsx'));
      unlinkSync(path.join(repository, 'apps/demo-app/src/total.ts'));
      plantSymlink(repository, 'apps/demo-app/src/total.ts', '../../../package.json');
      // Reported: a deleted file that git still compares.
      unlinkSync(path.join(repository, 'apps/demo-app/tsconfig.json'));
      expect(worktreeStatus(repository)).toEqual([' D apps/demo-app/tsconfig.json']);

      const error = expectResidualError(() => scanResidualMarkers(repository), 'file-unscanned');
      expect(error.message).toContain(
        '2 tracked files under apps/demo-app are not in the working tree as git records them, ' +
          'and `git status` does not report them as changed, so the marker scan cannot vouch ' +
          'for them and this check cannot be performed:\n' +
          '  apps/demo-app/src/label.tsx (not-a-regular-file)\n' +
          '  apps/demo-app/src/total.ts (symlink)\n' +
          'Git does not compare',
      );
      expect(error.message).not.toContain('tsconfig.json');
    });

    it('raises file-unreadable before it consults git status about an unread entry', async () => {
      const repository = createRepository(CLEAN_FILES);
      git(repository, ['update-index', '--skip-worktree', '--', 'apps/demo-app/src/label.tsx']);
      unlinkSync(path.join(repository, 'apps/demo-app/src/label.tsx'));
      const locked = path.join(repository, 'apps/demo-app/src/total.ts');

      await withInjectedFs(
        (real) => ({
          readFileSync: failingFsCall(real.readFileSync, 'open', new Map([[locked, 'EACCES']])),
        }),
        async (injected) => {
          const error = expectResidualError(
            () => injected.scanResidualMarkers(repository),
            'file-unreadable',
            injected.ResidualCheckError,
          );
          expect(error.message).toContain('\n  apps/demo-app/src/total.ts (EACCES)\n');
          expect(error.message).not.toContain('label.tsx');
        },
      );
      // With every file readable again, the hidden one fails the check on its own.
      const error = expectResidualError(() => scanResidualMarkers(repository), 'file-unscanned');
      expect(error.message).toContain('\n  apps/demo-app/src/label.tsx (missing)\n');
    });

    it('fails closed on a tracked file it cannot read, on every account (file-unreadable)', async () => {
      const repository = createRepository(CLEAN_FILES);
      const locked = path.join(repository, 'apps/demo-app/src/total.ts');
      /** @type {string[]} */
      const reads = [];

      await withInjectedFs(
        (real) => ({
          readFileSync: failingFsCall(
            real.readFileSync,
            'open',
            new Map([[locked, 'EACCES']]),
            reads,
          ),
        }),
        async (injected) => {
          const error = expectResidualError(
            () => injected.scanResidualMarkers(repository),
            'file-unreadable',
            injected.ResidualCheckError,
          );
          expect(error.message).toBe(
            '1 tracked file under apps/demo-app could not be read, so the marker scan cannot ' +
              'vouch for it and this check cannot be performed:\n' +
              '  apps/demo-app/src/total.ts (EACCES)\n' +
              'Make every listed file, and each directory above it, readable by the account ' +
              'running this check - restore its permissions or ownership, or repair the storage ' +
              'behind an I/O error - and re-run it.',
          );
          expect(error.cause).toBeInstanceOf(AggregateError);
          expect(/** @type {AggregateError} */ (error.cause).errors).toEqual([
            expect.objectContaining({ code: 'EACCES', syscall: 'open', path: locked }),
          ]);
          // The failure is raised after the loop: every tracked file was still read, once each and
          // in `git ls-files` order, so one run names every file it could not read.
          expect(reads).toEqual(CLEAN_TARGET_FILES.map((file) => path.join(repository, file)));

          expectResidualError(
            () => injected.findMarkers(repository),
            'file-unreadable',
            injected.ResidualCheckError,
          );
          // The worktree rule alone has its subject here; the marker rule does not, and that decides.
          expect(injected.worktreeStatus(repository)).toEqual([]);

          const text = await runMain([], { repository, main: injected.main });
          expect(text.exitCode).toBe(EXIT_ERROR);
          expect(text.stdout).toBe('');
          expect(text.stderr).toBe(`residual-instrumentation: file-unreadable: ${error.message}\n`);

          const json = await runMain(['--json'], { repository, main: injected.main });
          expect(json.exitCode).toBe(EXIT_ERROR);
          expect(JSON.parse(json.stdout)).toEqual({
            ok: false,
            exitCode: EXIT_ERROR,
            error: { code: 'file-unreadable', message: error.message },
          });
          expect(json.stderr).toContain('residual-instrumentation: file-unreadable:');
        },
      );

      // The genuine module, whose node:fs was never touched, reads the same file and passes it.
      expect(findMarkers(repository)).toEqual([]);
    });

    it('names every tracked file it cannot examine or read in one report, lstat failures included', async () => {
      const repository = createRepository(CLEAN_FILES);
      /** @param {string} file @returns {string} */
      const absolute = (file) => path.join(repository, file);

      await withInjectedFs(
        (real) => ({
          // EACCES from lstat is what a file under a directory without search permission reports:
          // the file may well exist, so it is unreadable, never `missing`.
          lstatSync: failingFsCall(
            real.lstatSync,
            'lstat',
            new Map([[absolute('apps/demo-app/src/label.tsx'), 'EACCES']]),
          ),
          // An I/O error, and a failure that carries no errno code at all.
          readFileSync: failingFsCall(
            real.readFileSync,
            'open',
            new Map([
              [absolute('apps/demo-app/src/total.ts'), 'EIO'],
              [absolute('apps/demo-app/tsconfig.json'), null],
            ]),
          ),
        }),
        async (injected) => {
          const error = expectResidualError(
            () => injected.scanResidualMarkers(repository),
            'file-unreadable',
            injected.ResidualCheckError,
          );
          expect(error.message).toContain(
            '3 tracked files under apps/demo-app could not be read, so the marker scan cannot ' +
              'vouch for them and this check cannot be performed:\n' +
              '  apps/demo-app/src/label.tsx (EACCES)\n' +
              '  apps/demo-app/src/total.ts (EIO)\n' +
              '  apps/demo-app/tsconfig.json (UNKNOWN)\n' +
              'Make every listed file',
          );
          expect(/** @type {AggregateError} */ (error.cause).errors).toEqual([
            expect.objectContaining({ code: 'EACCES', syscall: 'lstat' }),
            expect.objectContaining({ code: 'EIO', syscall: 'open' }),
            expect.not.objectContaining({ code: expect.anything() }),
          ]);
          expectResidualError(
            () => injected.findMarkers(repository),
            'file-unreadable',
            injected.ResidualCheckError,
          );

          const { exitCode, stdout, stderr } = await runMain(['--json'], {
            repository,
            main: injected.main,
          });
          expect(exitCode).toBe(EXIT_ERROR);
          expect(JSON.parse(stdout).error).toEqual({
            code: 'file-unreadable',
            message: error.message,
          });
          expect(stderr).toBe(`residual-instrumentation: file-unreadable: ${error.message}\n`);
        },
      );
    });

    it('fails closed on every tracked file under a directory it cannot examine (file-unreadable)', async () => {
      const repository = createRepository(CLEAN_FILES);
      const directory = path.join(repository, 'apps/demo-app/src');
      const underDirectory = CLEAN_TARGET_FILES.filter((file) =>
        file.startsWith('apps/demo-app/src/'),
      );
      /** @type {string[]} */
      const examined = [];

      await withInjectedFs(
        (real) => ({
          lstatSync: failingFsCall(
            real.lstatSync,
            'lstat',
            new Map([[directory, 'EACCES']]),
            examined,
          ),
        }),
        async (injected) => {
          const error = expectResidualError(
            () => injected.scanResidualMarkers(repository),
            'file-unreadable',
            injected.ResidualCheckError,
          );
          expect(error.message).toContain(
            `${underDirectory.length} tracked files under apps/demo-app could not be read`,
          );
          for (const file of underDirectory) {
            expect(error.message).toContain(`\n  ${file} (EACCES)\n`);
          }
          expect(/** @type {AggregateError} */ (error.cause).errors).toEqual(
            underDirectory.map(() => expect.objectContaining({ code: 'EACCES', path: directory })),
          );
        },
      );
      // One lstat answers for the directory, and nothing below it is examined.
      expect(examined.filter((entry) => entry === directory)).toHaveLength(1);
      expect(examined.filter((entry) => entry.startsWith(`${directory}${path.sep}`))).toEqual([]);
    });

    it('fails closed on a mode-000 tracked file under real permissions (file-unreadable)', async (context) => {
      context.skip(
        process.getuid?.() === 0,
        'running as root, which reads a mode-000 file regardless; the injected-failure cases ' +
          'above assert the same file-unreadable contract on this account',
      );
      const repository = createRepository(CLEAN_FILES);
      const locked = path.join(repository, 'apps/demo-app/src/total.ts');
      chmodSync(locked, 0o000);
      try {
        const error = expectResidualError(() => scanResidualMarkers(repository), 'file-unreadable');
        expect(error.message).toContain('\n  apps/demo-app/src/total.ts (EACCES)\n');
        expectResidualError(() => findMarkers(repository), 'file-unreadable');

        const { exitCode, stdout } = await runMain(['--json'], { repository });
        expect(exitCode).toBe(EXIT_ERROR);
        expect(JSON.parse(stdout).error.code).toBe('file-unreadable');
      } finally {
        chmodSync(locked, 0o644);
      }
    });
  },
);

/* ---------------------------------------------------------------------------
 * It fails closed
 * ------------------------------------------------------------------------ */

describe('ResidualCheckError', () => {
  it('carries a stable code, its own name and the cause', () => {
    const cause = new Error('underlying');
    const error = new ResidualCheckError('target-missing', 'described', { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ResidualCheckError');
    expect(error.code).toBe('target-missing');
    expect(error.message).toBe('described');
    expect(error.cause).toBe(cause);
    expect(new ResidualCheckError('usage', 'bare').cause).toBeUndefined();
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'every condition without a subject exits 2, never 0',
  { timeout: GIT_TEST_TIMEOUT_MS },
  () => {
    it('refuses a target that does not exist (target-missing)', async () => {
      const repository = createRepository({ 'package.json': CLEAN_FILES['package.json'] });

      const error = expectResidualError(() => scanResidualMarkers(repository), 'target-missing');
      expect(error.message).toContain('target path not found: apps/demo-app');
      expect(error.message).toContain('--path');
      expect(error.message).toContain('tests/fixtures/sample-next-app');
      expectResidualError(() => worktreeStatus(repository), 'target-missing');

      const text = await runMain([], { repository });
      expect(text.exitCode).toBe(EXIT_ERROR);
      expect(text.stdout).toBe('');
      expect(text.stderr).toBe(`residual-instrumentation: target-missing: ${error.message}\n`);

      const json = await runMain(['--json'], { repository });
      expect(json.exitCode).toBe(EXIT_ERROR);
      expect(JSON.parse(json.stdout)).toEqual({
        ok: false,
        exitCode: EXIT_ERROR,
        error: { code: 'target-missing', message: error.message },
      });
      expect(json.stderr).toContain('residual-instrumentation: target-missing:');
    });

    it('refuses a target that is a file, or a symlink to a directory (target-not-a-directory)', async () => {
      const repository = createRepository(CLEAN_FILES);
      plantSymlink(repository, 'apps/demo-link', 'demo-app');
      commitAll(repository);

      for (const target of ['package.json', 'apps/demo-app/src/total.ts', 'apps/demo-link']) {
        const error = expectResidualError(
          () => scanResidualMarkers(repository, target),
          'target-not-a-directory',
        );
        expect(error.message).toBe(`target path is not a directory: ${target}`);
      }

      const { exitCode, stdout } = await runMain(['--json', '--path', 'package.json'], {
        repository,
      });
      expect(exitCode).toBe(EXIT_ERROR);
      expect(JSON.parse(stdout).error.code).toBe('target-not-a-directory');
    });

    it('refuses a target under which git tracks no file (target-empty)', async () => {
      const repository = createRepository({ 'package.json': CLEAN_FILES['package.json'] });
      writeFixture(repository, 'apps/demo-app/notes.md', '# untracked\n');

      const error = expectResidualError(() => scanResidualMarkers(repository), 'target-empty');
      expect(error.message).toContain(`git tracks no file under apps/demo-app in ${repository}`);
      expect(error.message).toContain('git add');
      expect(error.message).toContain('sparse-checkout');
      expectResidualError(() => findMarkers(repository), 'target-empty');
      // The worktree rule alone has a subject here; the marker rule does not, and that decides.
      expect(worktreeStatus(repository)).toEqual(['?? apps/demo-app/']);

      const { exitCode, stdout, stderr } = await runMain(['--json'], { repository });
      expect(exitCode).toBe(EXIT_ERROR);
      expect(JSON.parse(stdout).error.code).toBe('target-empty');
      expect(stderr).toContain('residual-instrumentation: target-empty:');
    });

    it('refuses a target holding only ignored files, which would otherwise look clean', async () => {
      const repository = createRepository({
        'package.json': CLEAN_FILES['package.json'],
        '.gitignore': 'apps/demo-app/\n',
      });
      writeFixture(repository, 'apps/demo-app/src/total.ts', patchedSource(GLOBAL_MARKER).content);

      // Both git views are empty: exactly the case where a naive gate would pass over nothing.
      expect(worktreeStatus(repository)).toEqual([]);
      expectResidualError(() => scanResidualMarkers(repository), 'target-empty');

      const { exitCode, stdout } = await runMain([], { repository });
      expect(exitCode).toBe(EXIT_ERROR);
      expect(stdout).toBe('');
    });

    it('refuses a --path outside the repository or at its root (usage)', async () => {
      const repository = createRepository(CLEAN_FILES);

      for (const [target, message] of [
        ['..', '--path must stay inside the repository; got ..'],
        ['../elsewhere', '--path must stay inside the repository; got ../elsewhere'],
        [path.dirname(repository), '--path must stay inside the repository'],
        ['.', '--path must name a directory inside the repository, not the repository root'],
        [repository, 'not the repository root'],
      ]) {
        const error = expectResidualError(() => findMarkers(repository, target), 'usage');
        expect(error.message).toContain(message);
        expectResidualError(() => worktreeStatus(repository, target), 'usage');
      }

      // In text mode the usage follows the error, because the fix is a different --path.
      const text = await runMain(['--path', '..'], { repository });
      expect(text.exitCode).toBe(EXIT_ERROR);
      expect(text.stdout).toBe('');
      expect(text.stderr).toContain('residual-instrumentation: usage: --path must stay inside');
      expect(text.stderr).toContain(USAGE_HEADING);

      // With --json the error object is the whole machine-readable answer, and no usage follows.
      const json = await runMain(['--json', '--path', '.'], { repository });
      expect(json.exitCode).toBe(EXIT_ERROR);
      expect(JSON.parse(json.stdout)).toEqual({
        ok: false,
        exitCode: EXIT_ERROR,
        error: { code: 'usage', message: expect.stringContaining('not the repository root') },
      });
      expect(json.stderr).toContain('residual-instrumentation: usage:');
      expect(json.stderr).not.toContain(USAGE_HEADING);
    });

    it('refuses only a --path that climbs out, not a directory named ..cache inside', async () => {
      const repository = createRepository({
        ...CLEAN_FILES,
        '..cache/entry.ts': patchedSource(GLOBAL_MARKER).content,
      });

      expect(findMarkers(repository, '..cache')).toEqual([
        expect.objectContaining({ file: '..cache/entry.ts', line: 3, marker: GLOBAL_MARKER }),
      ]);

      const { exitCode, stdout } = await runMain(['--path', '..cache'], { repository });
      expect(exitCode).toBe(EXIT_FINDINGS);
      expect(stdout).toContain(`..cache/entry.ts:3: residual-marker: found ${GLOBAL_MARKER}`);
    });

    it('refuses a directory that is not inside a git work tree (not-a-repository)', () => {
      const plain = createDirectory('plain');
      mkdirSync(path.join(plain, 'apps', 'demo-app'), { recursive: true });

      for (const operation of [scanResidualMarkers, worktreeStatus]) {
        const error = expectResidualError(
          () => withEnvironment(isolatedEnvironment(), () => operation(plain)),
          'not-a-repository',
        );
        expect(error.message).toBe(
          `${plain} is not inside a git work tree; run this check from a checkout of the repository`,
        );
      }
    });

    it('refuses a starting path that does not exist (root-missing)', () => {
      const absent = path.join(temporaryRoot(), 'absent', 'nowhere');

      const error = expectResidualError(() => scanResidualMarkers(absent), 'root-missing');
      expect(error.message).toBe(`path does not exist: ${absent}`);
    });

    it('fails closed when git cannot be found (git-missing)', async () => {
      const repository = createRepository(CLEAN_FILES);

      const error = expectResidualError(
        () => withEnvironment({ PATH: '' }, () => scanResidualMarkers(repository)),
        'git-missing',
      );
      expect(error.message).toContain('`git` executable was not found on PATH');

      const { exitCode, stdout } = await runMain(['--json'], {
        repository,
        environment: { PATH: '' },
      });
      expect(exitCode).toBe(EXIT_ERROR);
      expect(JSON.parse(stdout).error.code).toBe('git-missing');
    });

    it('fails closed when git itself fails, and says which command did (git-failed)', async () => {
      const repository = createRepository(CLEAN_FILES);
      // A corrupt index: `rev-parse` still finds the work tree, `ls-files` then cannot list it.
      writeFileSync(path.join(repository, '.git', 'index'), 'not an index');

      const error = expectResidualError(() => scanResidualMarkers(repository), 'git-failed');
      expect(error.message).toContain(
        `\`git ls-files -z --stage -- apps/demo-app\` failed in ${repository}: `,
      );
      expect(error.message).toContain('index');

      const { exitCode, stdout } = await runMain(['--json'], { repository });
      expect(exitCode).toBe(EXIT_ERROR);
      expect(JSON.parse(stdout).error.code).toBe('git-failed');
    });
  },
);

/* ---------------------------------------------------------------------------
 * The command line
 * ------------------------------------------------------------------------ */

describe('the command line', () => {
  it('prints the help for --help and for -h, and exits 0', async () => {
    for (const flag of ['--help', '-h']) {
      const { exitCode, stdout, stderr } = await runMain([flag]);

      expect(exitCode).toBe(EXIT_OK);
      expect(stderr).toBe('');
      expect(stdout.startsWith(`${USAGE_HEADING} [options]\n`)).toBe(true);
      expect(stdout.endsWith('\n')).toBe(true);
      for (const expected of [
        ...MARKERS,
        DEFAULT_TARGET_PATH,
        '--path=<dir>',
        '--json',
        'Exit codes:',
      ]) {
        expect(stdout).toContain(expected);
      }
    }
  });

  it('answers --help without running the check, whatever else was passed', async () => {
    const { exitCode, stdout } = await runMain(['--json', '--path', 'does/not/exist', '--help']);

    expect(exitCode).toBe(EXIT_OK);
    expect(stdout.startsWith(USAGE_HEADING)).toBe(true);
  });

  it('rejects an unknown option with exit 2 and the usage on stderr', async () => {
    const { exitCode, stdout, stderr } = await runMain(['--frobnicate']);

    expect(exitCode).toBe(EXIT_ERROR);
    expect(stdout).toBe('');
    expect(stderr.startsWith('residual-instrumentation: unknown option: --frobnicate\n\n')).toBe(
      true,
    );
    expect(stderr).toContain(USAGE_HEADING);
  });

  it('rejects a positional argument, because the target is given with --path', async () => {
    const { exitCode, stdout, stderr } = await runMain(['apps/demo-app']);

    expect(exitCode).toBe(EXIT_ERROR);
    expect(stdout).toBe('');
    expect(stderr).toContain('residual-instrumentation: unexpected argument: apps/demo-app');
  });

  it('rejects --path without a value in every spelling, and never as JSON', async () => {
    for (const argv of [
      ['--path'],
      ['--path', ''],
      ['--path', '--json'],
      ['--path='],
      ['--json', '--path'],
    ]) {
      const { exitCode, stdout, stderr } = await runMain(argv);

      expect(exitCode).toBe(EXIT_ERROR);
      // Arguments are parsed before anything is known to be a report, so a usage error goes to
      // stderr even when --json was already seen.
      expect(stdout).toBe('');
      expect(stderr).toContain('residual-instrumentation: --path requires a directory argument');
      expect(stderr).toContain(USAGE_HEADING);
    }
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'the command line, run as a command',
  { timeout: GIT_TEST_TIMEOUT_MS },
  () => {
    it('checks the repository its own file sits in, from any working directory', () => {
      const repository = createRepository(CLEAN_FILES);
      const script = installScriptCopy(repository);

      const { exitCode, stdout, stderr } = runCommand(script, []);

      expect(exitCode).toBe(EXIT_OK);
      expect(stderr).toBe('');
      // The copy itself is an untracked file outside the target, and changes nothing.
      expect(stdout).toBe(
        summaryLine(
          'OK',
          `${CLEAN_TARGET_FILES.length} files scanned, 0 marker findings, 0 worktree entries`,
        ),
      );
    });

    it('exits 1 and names the file and line of a committed marker when run as a command', () => {
      const repository = createRepository({
        ...CLEAN_FILES,
        'apps/demo-app/src/patched.ts': patchedSource(GLOBAL_MARKER).content,
      });
      const script = installScriptCopy(repository);

      const text = runCommand(script, []);
      expect(text.exitCode).toBe(EXIT_FINDINGS);
      expect(text.stdout).toContain(
        `apps/demo-app/src/patched.ts:3: residual-marker: found ${GLOBAL_MARKER}\n`,
      );

      const json = runCommand(script, ['--json']);
      expect(json.exitCode).toBe(EXIT_FINDINGS);
      expect(JSON.parse(json.stdout).findings).toEqual([
        expect.objectContaining({ file: 'apps/demo-app/src/patched.ts', line: 3 }),
      ]);
    });

    it('still runs the check when invoked through a symbolic link to the checkout', () => {
      // Node reports the module's URL as a real path and argv[1] as typed. Compared raw, the two
      // differ through a link, and the command would skip the check and exit 0 in silence over a
      // committed marker; the entry-point test canonicalizes both, which this case holds it to.
      const repository = createRepository({
        ...CLEAN_FILES,
        'apps/demo-app/src/patched.ts': patchedSource(TYPE_MARKER).content,
      });
      installScriptCopy(repository);
      const link = path.join(createDirectory('link'), 'checkout');
      symlinkSync(repository, link);

      const { exitCode, stdout } = runCommand(path.join(link, 'scripts', SCRIPT_NAME), []);

      expect(exitCode).toBe(EXIT_FINDINGS);
      expect(stdout).toContain(
        `apps/demo-app/src/patched.ts:3: residual-marker: found ${TYPE_MARKER}`,
      );
    });

    it('exits 2 with not-a-repository when its directory is not a git work tree', () => {
      const plain = createDirectory('plain');
      mkdirSync(path.join(plain, 'apps', 'demo-app'), { recursive: true });
      const script = installScriptCopy(plain);

      const text = runCommand(script, []);
      expect(text.exitCode).toBe(EXIT_ERROR);
      expect(text.stdout).toBe('');
      expect(text.stderr).toContain('residual-instrumentation: not-a-repository:');

      const json = runCommand(script, ['--json']);
      expect(json.exitCode).toBe(EXIT_ERROR);
      expect(JSON.parse(json.stdout)).toMatchObject({
        ok: false,
        exitCode: EXIT_ERROR,
        error: { code: 'not-a-repository' },
      });
    });

    it('exits 2 with the usage on stderr for an unknown option when run as a command', () => {
      const repository = createRepository(CLEAN_FILES);
      const { exitCode, stdout, stderr } = runCommand(installScriptCopy(repository), ['--nope']);

      expect(exitCode).toBe(EXIT_ERROR);
      expect(stdout).toBe('');
      expect(stderr).toContain('residual-instrumentation: unknown option: --nope');
      expect(stderr).toContain(USAGE_HEADING);
    });
  },
);

/* ---------------------------------------------------------------------------
 * This repository
 * ------------------------------------------------------------------------ */

describe.skipIf(!GIT_AVAILABLE)('this repository', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('passes over this checkout while its apps/demo-app has no uncommitted change', async (context) => {
    const pending = git(REPOSITORY_ROOT, ['status', '--porcelain', '--', DEFAULT_TARGET_PATH]);
    context.skip(
      pending.trim() !== '',
      'apps/demo-app has uncommitted changes in this checkout, which the gate rightly reports; ' +
        'the fixture cases above cover that outcome',
    );

    const text = await runMain([]);
    expect(text.exitCode).toBe(EXIT_OK);
    expect(text.stderr).toBe('');
    expect(text.stdout).toMatch(
      /^residual-instrumentation: OK: apps\/demo-app: \d+ files scanned, 0 marker findings, 0 worktree entries\n$/,
    );

    const json = await runMain(['--json']);
    expect(json.exitCode).toBe(EXIT_OK);
    const report = JSON.parse(json.stdout);
    expect(report).toMatchObject({ ok: true, target: DEFAULT_TARGET_PATH, findings: [] });
    expect(report.filesTracked).toBeGreaterThan(0);
    expect(report.filesScanned).toBeGreaterThan(0);
  });
});
