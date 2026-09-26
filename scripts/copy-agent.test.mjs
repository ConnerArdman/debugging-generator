/**
 * copy-agent.test.mjs
 *
 * The proof that `scripts/copy-agent.mjs` - the Chrome extension's `prebuild`/`predev` step -
 * publishes the browser agent bundle byte for byte and publishes it *only* where it is supposed
 * to.
 *
 * WHAT THIS SUITE OWNS. Two contracts, and they pull in opposite directions. The first is the
 * copy itself: the target must hold exactly the source's bytes (SHA-256 equal), both source-map
 * names must appear beside it, a second run must report `unchanged` and rewrite nothing so Vite's
 * watcher stays quiet during `vite build --watch`, and `--check` must report drift - with a reason
 * - when the copy is stale. The second is that the destination is untrusted: every path the script
 * writes is generated output under `apps/chrome-extension/public/`, which `@crxjs/vite-plugin`
 * republishes verbatim into the packed extension, so a symbolic link planted at the target, at
 * either source-map name, or at any directory component below the repository root would let
 * whoever planted it choose which file the agent's bytes overwrite (CWE-22). Those cases must
 * write nothing at all and fail with exit code 2 - in `--check` mode too, because "re-run without
 * --check" is no fix for a link that decides where bytes land. Each `describe` below owns one of
 * those concerns, so a contract that loses its coverage is visible in the test report rather than
 * inferable from it.
 *
 * WHY EVERY FIXTURE IS A THROWAWAY TREE. The module under test resolves its own paths from
 * `REPO_ROOT`, but `copyAgent({ root })` takes the root as an argument precisely so it can be
 * pointed at a fixture. Every test here builds a miniature repository - `SOURCE_REL` with content,
 * optionally its `.map` - under `fs.mkdtempSync(os.tmpdir())`, never inside this checkout, whose
 * `git status` must stay clean and whose `apps/chrome-extension/public` must not be conjured into
 * existence by a test run. `afterEach` removes every root the test created, including the ones a
 * failing assertion left behind.
 *
 * WHY THE BYTES ARE DELIBERATELY AWKWARD. {@link BUNDLE_BYTES} is assembled from text plus three
 * raw bytes that are not valid UTF-8, and it carries a CRLF and a non-ASCII character. A copy that
 * transcodes, adds a BOM or normalises line endings cannot survive that comparison, which is what
 * makes "byte for byte" a tested property rather than a stated one. The literals stay innocuous
 * prose (`AGENT-BYTES` and friends) for a second reason: this file is tracked content and
 * `pnpm check:secrets` scans tracked content, so nothing here may look like a credential.
 *
 * HARNESS. The root `vitest.config.ts` collects this file into the `tooling` project
 * (`scripts/*.test.mjs`, environment `node`, `globals: false`), which `pnpm test` runs as part of
 * the blocking test gate (`pnpm verify`). `describe`/`it`/`expect` are imported
 * explicitly because that project sets no globals. Everything runs in process against the exported
 * `copyAgent`, `parseArgs`, `usage` and `main`: no git, no network, no child process, no shared
 * state, so the suite is fast and order-independent.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CopyAgentError,
  REPO_ROOT,
  SOURCE_REL,
  TARGET_REL,
  copyAgent,
  main,
  parseArgs,
  usage,
} from './copy-agent.mjs';

/**
 * Both names the script writes the source map under, mirrored from the module's own private
 * constant. Stated here rather than imported so that renaming one in the module is a test failure
 * instead of a silent change: `apps/chrome-extension/manifest.config.ts` and the bundle's trailing
 * `//# sourceMappingURL=` comment both depend on these exact names.
 */
const MAP_NAMES = ['agent.iife.js.map', 'browser-agent.iife.js.map'];

/**
 * The fixture bundle's bytes: text, a CRLF, a non-ASCII character, then three bytes that are not
 * valid UTF-8, then esbuild's trailing source-map comment.
 *
 * The invalid bytes are the point. Any read/write round trip through a string would replace them
 * with U+FFFD, and a line-ending or BOM transformation would move or lengthen the buffer, so the
 * SHA-256 comparisons below fail loudly on exactly the transformations the script promises never to
 * perform.
 */
const BUNDLE_BYTES = Buffer.concat([
  Buffer.from('(() => {\r\n  globalThis.AGENT_BYTES = "caf\u00e9";\n', 'utf8'),
  Buffer.from([0x00, 0xff, 0xfe]),
  Buffer.from('\n})();\n//# sourceMappingURL=browser-agent.iife.js.map\n', 'utf8'),
]);

/** The fixture source map's bytes. Shape only: nothing in this suite parses it. */
const MAP_BYTES = Buffer.from(
  '{"version":3,"sources":["AGENT-SOURCE"],"mappings":"AAAA"}\n',
  'utf8',
);

/**
 * Roots created by the running test, removed by {@link afterEach} whether it passed or failed.
 *
 * @type {string[]}
 */
const roots = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Build a throwaway repository containing just the source bundle (and, unless `map` is false, its
 * source map) and register it for cleanup.
 *
 * @param {{ map?: boolean, bundle?: Buffer }} [options]
 * @returns {string} absolute path of the fixture root
 */
function makeRoot({ map = true, bundle = BUNDLE_BYTES } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-agent-test-'));
  roots.push(root);

  const source = path.join(root, SOURCE_REL);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, bundle);
  if (map) fs.writeFileSync(`${source}.map`, MAP_BYTES);

  return root;
}

/**
 * The directory the target and its source maps live in: `apps/chrome-extension/public`.
 *
 * @param {string} root
 * @returns {string}
 */
function targetDirectory(root) {
  return path.dirname(path.join(root, TARGET_REL));
}

/**
 * Its entries, sorted, or `undefined` when the directory does not exist - which is itself an
 * assertion in the "missing source" block: a failed run must not create it.
 *
 * @param {string} root
 * @returns {string[] | undefined}
 */
function listTargetDirectory(root) {
  try {
    return fs.readdirSync(targetDirectory(root)).sort();
  } catch {
    return undefined;
  }
}

/**
 * Hex SHA-256 of a file's bytes, read without following a symbolic link so that a test can never
 * accidentally assert about a link's target while believing it asserts about the target.
 *
 * @param {string} file
 * @returns {string}
 */
function sha256File(file) {
  const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    return createHash('sha256').update(fs.readFileSync(handle)).digest('hex');
  } finally {
    fs.closeSync(handle);
  }
}

/** Hex SHA-256 of a buffer. @param {Buffer} buffer @returns {string} */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Create `public/` inside a fixture root, plant a victim file at the root and a symbolic link to
 * it at `linkName` inside `public/`, and return both paths.
 *
 * Relative link targets (`../../../victim.txt`) rather than absolute ones, because that is the
 * shape a stale generated tree or an unpacked archive produces, and because a relative link proves
 * the traversal leaves the published directory.
 *
 * @param {string} root
 * @param {string} linkName file name inside `public/` to plant the link at
 * @returns {{ link: string, victim: string }}
 */
function plantSymlinkedFile(root, linkName) {
  const directory = targetDirectory(root);
  fs.mkdirSync(directory, { recursive: true });

  const victim = path.join(root, 'victim.txt');
  fs.writeFileSync(victim, 'VICTIM-UNTOUCHED\n');

  const link = path.join(directory, linkName);
  fs.symlinkSync(path.relative(directory, victim), link);

  return { link, victim };
}

/**
 * Run `operation`, require it to fail as a `CopyAgentError` carrying exit code 2, and hand the
 * error back for message assertions.
 *
 * Exit code 2 rather than 1 is load bearing: 1 means "the copy is stale, re-run without --check",
 * and re-running is the one thing that must not happen while a link chooses the victim.
 *
 * @param {() => unknown} operation
 * @returns {CopyAgentError}
 */
function expectExitTwo(operation) {
  let caught;
  try {
    operation();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(CopyAgentError);
  const error = /** @type {CopyAgentError} */ (caught);
  expect(error.exitCode).toBe(2);
  return error;
}

/**
 * Every `.tmp` file left in the target directory. The atomic write creates one there and renames
 * it away; `apps/chrome-extension/public/` is published verbatim into the packed extension, so a
 * leftover would ship.
 *
 * @param {string} root
 * @returns {string[]}
 */
function leftoverTemporaries(root) {
  return (listTargetDirectory(root) ?? []).filter((entry) => entry.endsWith('.tmp'));
}

describe('copyAgent: the first copy', () => {
  it('writes the bundle byte for byte and both source-map names beside it', () => {
    const root = makeRoot();

    const result = copyAgent({ root });

    expect(result.action).toBe('copied');
    expect(result.bytes).toBe(BUNDLE_BYTES.byteLength);
    expect(result.source).toBe(path.join(root, SOURCE_REL));
    expect(result.target).toBe(path.join(root, TARGET_REL));
    expect(result.reason).toBeUndefined();

    const target = path.join(root, TARGET_REL);
    expect(sha256File(target)).toBe(sha256(BUNDLE_BYTES));
    expect(sha256File(target)).toBe(sha256File(path.join(root, SOURCE_REL)));
    expect(fs.lstatSync(target).isFile()).toBe(true);

    expect(result.maps.map((file) => path.basename(file)).sort()).toEqual([...MAP_NAMES].sort());
    for (const name of MAP_NAMES) {
      expect(sha256File(path.join(targetDirectory(root), name))).toBe(sha256(MAP_BYTES));
    }
  });

  it('copies the bundle alone when the telemetry build produced no source map', () => {
    const root = makeRoot({ map: false });

    const result = copyAgent({ root });

    expect(result.action).toBe('copied');
    expect(result.maps).toEqual([]);
    expect(listTargetDirectory(root)).toEqual(['agent.iife.js']);
    expect(copyAgent({ root, check: true }).action).toBe('unchanged');
  });

  it('leaves no temporary file behind in the published directory', () => {
    const root = makeRoot();

    copyAgent({ root });

    expect(leftoverTemporaries(root)).toEqual([]);
    expect(listTargetDirectory(root)).toEqual(['agent.iife.js', ...MAP_NAMES].sort());
  });
});

describe('copyAgent: the unchanged fast path', () => {
  it('reports unchanged and rewrites nothing on a second run', () => {
    const root = makeRoot();
    copyAgent({ root });

    const target = path.join(root, TARGET_REL);
    const before = fs.lstatSync(target);

    const result = copyAgent({ root });

    expect(result.action).toBe('unchanged');
    expect(result.maps).toEqual([]);

    const after = fs.lstatSync(target);
    // The inode is the resolution-independent witness: the write path renames a fresh file into
    // place, so an unchanged inode means no write happened at all.
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(sha256File(target)).toBe(sha256(BUNDLE_BYTES));
  });

  it('republishes a target whose bytes were altered', () => {
    const root = makeRoot();
    copyAgent({ root });

    const target = path.join(root, TARGET_REL);
    fs.writeFileSync(target, Buffer.from('ALTERED-BYTES\n', 'utf8'));

    const result = copyAgent({ root });

    expect(result.action).toBe('copied');
    expect(sha256File(target)).toBe(sha256(BUNDLE_BYTES));
    expect(leftoverTemporaries(root)).toEqual([]);
  });
});

describe('copyAgent: the --check drift gate', () => {
  it('reports drift naming a target that does not exist', () => {
    const root = makeRoot();

    const result = copyAgent({ root, check: true });

    expect(result.action).toBe('drift');
    expect(result.reason).toContain(TARGET_REL);
    expect(result.reason).toContain('does not exist');
    expect(listTargetDirectory(root)).toBeUndefined();
  });

  it('reports drift, with byte counts, for a target that no longer matches', () => {
    const root = makeRoot();
    copyAgent({ root });

    const target = path.join(root, TARGET_REL);
    fs.appendFileSync(target, Buffer.from('APPENDED\n', 'utf8'));

    const result = copyAgent({ root, check: true });

    expect(result.action).toBe('drift');
    expect(result.reason).toContain('differs from the source');
    expect(result.reason).toContain(String(BUNDLE_BYTES.byteLength));
    expect(result.maps).toEqual([]);
  });

  it('reports drift for a missing source-map copy and writes nothing', () => {
    const root = makeRoot();
    copyAgent({ root });
    fs.rmSync(path.join(targetDirectory(root), MAP_NAMES[1]));

    const result = copyAgent({ root, check: true });

    expect(result.action).toBe('drift');
    expect(result.reason).toContain(MAP_NAMES[1]);
    expect(listTargetDirectory(root)).toEqual(['agent.iife.js', MAP_NAMES[0]].sort());
  });

  it('reports unchanged for a copy that is in sync', () => {
    const root = makeRoot();
    copyAgent({ root });

    const result = copyAgent({ root, check: true });

    expect(result.action).toBe('unchanged');
    expect(result.reason).toBeUndefined();
  });
});

describe('copyAgent: a symbolic link at the target', () => {
  it('refuses to write, leaving the link and its victim untouched', () => {
    const root = makeRoot();
    const { link, victim } = plantSymlinkedFile(root, path.basename(TARGET_REL));
    const victimBefore = sha256File(victim);

    const error = expectExitTwo(() => copyAgent({ root }));

    expect(error.message).toContain('is a symbolic link');
    expect(error.message).toContain(TARGET_REL);
    expect(error.message).toContain('victim.txt');
    expect(error.hint).toContain('Remove whatever occupies that path');

    // Nothing was written: the victim still holds its own bytes, the target is still the link
    // rather than a file the run created, and no temporary file was left next to it.
    expect(sha256File(victim)).toBe(victimBefore);
    expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM-UNTOUCHED\n');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(leftoverTemporaries(root)).toEqual([]);
    expect(listTargetDirectory(root)).toEqual([path.basename(TARGET_REL)]);
  });

  it('fails --check with exit 2 instead of certifying the link as in sync', () => {
    const root = makeRoot();
    const { victim } = plantSymlinkedFile(root, path.basename(TARGET_REL));
    // Make the link's victim byte-identical to the bundle. Even when the far side holds exactly the
    // bundle's bytes, `--check` must refuse a symbolic link at the target path with exit 2 rather
    // than follow it and report the copy as in sync.
    fs.writeFileSync(victim, BUNDLE_BYTES);

    const error = expectExitTwo(() => copyAgent({ root, check: true }));

    expect(error.message).toContain('is a symbolic link');
    expect(error.message).toContain(TARGET_REL);
    expect(sha256File(victim)).toBe(sha256(BUNDLE_BYTES));
  });

  it('rejects a target that is a directory rather than a regular file', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, TARGET_REL), { recursive: true });

    const error = expectExitTwo(() => copyAgent({ root }));

    expect(error.message).toContain('is not a regular file');
    expect(error.message).toContain(TARGET_REL);
  });
});

describe('copyAgent: a symbolic link at a source-map name', () => {
  for (const name of MAP_NAMES) {
    it(`refuses to write when ${name} is a link, leaving its victim untouched`, () => {
      const root = makeRoot();
      const { link, victim } = plantSymlinkedFile(root, name);

      const error = expectExitTwo(() => copyAgent({ root }));

      expect(error.message).toContain('is a symbolic link');
      expect(error.message).toContain(name);
      expect(error.message).toContain('victim.txt');

      expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM-UNTOUCHED\n');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      // The bundle itself must not have been published either: the guard runs before any write,
      // so one unusable destination stops the whole run rather than half of it.
      expect(listTargetDirectory(root)).toEqual([name]);
      expect(leftoverTemporaries(root)).toEqual([]);
    });
  }

  it('rejects a source-map name that is a link even when the build produced no map', () => {
    const root = makeRoot({ map: false });
    plantSymlinkedFile(root, MAP_NAMES[0]);

    const error = expectExitTwo(() => copyAgent({ root }));

    expect(error.message).toContain('is a symbolic link');
    expect(error.message).toContain(MAP_NAMES[0]);
    expect(listTargetDirectory(root)).toEqual([MAP_NAMES[0]]);
  });
});

describe('copyAgent: a symbolic link in the directory chain', () => {
  it('refuses to write through a symlinked public/ directory', () => {
    const root = makeRoot();
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(root, 'apps', 'chrome-extension'), { recursive: true });
    fs.symlinkSync(
      path.relative(path.join(root, 'apps', 'chrome-extension'), elsewhere),
      targetDirectory(root),
    );

    const error = expectExitTwo(() => copyAgent({ root }));

    expect(error.message).toContain('is a symbolic link');
    expect(error.message).toContain('apps/chrome-extension/public');
    expect(error.message).toContain('elsewhere');

    // The directory the link pointed at is still empty: no bundle, no map, no temporary file.
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('fails --check with exit 2 for a symlinked directory component', () => {
    const root = makeRoot();
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(root, 'apps'), { recursive: true });
    fs.symlinkSync(
      path.relative(path.join(root, 'apps'), elsewhere),
      path.join(root, 'apps', 'chrome-extension'),
    );

    const error = expectExitTwo(() => copyAgent({ root, check: true }));

    expect(error.message).toContain('is a symbolic link');
    expect(error.message).toContain('apps/chrome-extension');
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('rejects a regular file occupying a directory component', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'apps'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps', 'chrome-extension'), 'NOT-A-DIRECTORY\n');

    const error = expectExitTwo(() => copyAgent({ root }));

    expect(error.message).toContain('is not a directory');
    expect(error.message).toContain('apps/chrome-extension');
    expect(fs.readFileSync(path.join(root, 'apps', 'chrome-extension'), 'utf8')).toBe(
      'NOT-A-DIRECTORY\n',
    );
  });
});

describe('copyAgent: a missing or empty source bundle', () => {
  it('fails with exit 2 and the build hint, creating nothing', () => {
    const root = makeRoot();
    fs.rmSync(path.join(root, SOURCE_REL));

    const error = expectExitTwo(() => copyAgent({ root }));

    expect(error.message).toContain('has not been built');
    expect(error.hint).toContain('pnpm --filter @debuggen/telemetry build');
    // No directory, no placeholder: an empty agent.iife.js would load in Chrome and capture
    // nothing, which is far harder to diagnose than this failure.
    expect(listTargetDirectory(root)).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'apps'))).toBe(false);
  });

  it('fails with exit 2 for a zero-byte bundle, creating nothing', () => {
    const root = makeRoot({ bundle: Buffer.alloc(0) });

    const error = expectExitTwo(() => copyAgent({ root }));

    expect(error.message).toContain('is empty');
    expect(listTargetDirectory(root)).toBeUndefined();
  });
});

describe('the command-line surface', () => {
  it('parses the documented flags and rejects anything else', () => {
    expect(parseArgs([])).toEqual({ check: false, quiet: false, help: false });
    expect(parseArgs(['--check', '--quiet'])).toEqual({ check: true, quiet: true, help: false });
    expect(parseArgs(['-q', '-h'])).toEqual({ check: false, quiet: true, help: true });

    const error = expectExitTwo(() => parseArgs(['--force']));
    expect(error.message).toContain('--force');
    expect(error.showUsage).toBe(true);
  });

  it('resolves the repository root from the script rather than from the working directory', () => {
    // The `prebuild` hook runs with `apps/chrome-extension` as the working directory, so a
    // cwd-relative root would resolve the copy somewhere else entirely.
    expect(path.isAbsolute(REPO_ROOT)).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'scripts', 'copy-agent.mjs'))).toBe(true);
    expect(path.isAbsolute(SOURCE_REL)).toBe(false);
    expect(path.isAbsolute(TARGET_REL)).toBe(false);
  });

  it('documents the target-path rule and its exit code in the usage text', () => {
    const text = usage();

    expect(text).toContain('Target path safety');
    expect(text).toContain('symbolic link');
    expect(text).toContain('the target path is unusable');
    expect(text).toContain(SOURCE_REL);
    expect(text).toContain(TARGET_REL);
  });

  it('prints usage for --help and exits 0 without touching the filesystem', async () => {
    const written = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    try {
      await expect(main(['--help'])).resolves.toBe(0);
    } finally {
      stdout.mockRestore();
    }

    // `main` resolves its paths from REPO_ROOT - the real checkout - so the only flag safe to
    // exercise here is the one that reads and writes nothing at all. Every filesystem behaviour is
    // driven through `copyAgent({ root })` above, against a throwaway tree.
    expect(written.join('')).toContain('Target path safety');
    expect(written.join('')).toContain('Exit codes');
  });
});
