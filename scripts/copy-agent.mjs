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

/** Source bundle missing, I/O failure, or bad usage. */
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
      "pnpm's pre/post scripts are enabled (enable-pre-post-scripts,",
      "pnpm's default); with them disabled, run this script by hand",
      'before `vite build`.',
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
 * `stat` a path, or `undefined` when it cannot be inspected (absent, a broken
 * symlink, an unreadable parent).
 *
 * @param {string} file
 * @returns {fs.Stats | undefined}
 */
function statOptional(file) {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
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
  pre/post scripts are enabled (enable-pre-post-scripts, pnpm's default);
  with them disabled, run this script by hand before \`vite build\`.

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

Exit codes
  0  copied, already identical, or verified with --check
  1  --check found drift; re-run without --check to refresh the copy
  2  the source bundle is missing or empty, an I/O error occurred, or the
     arguments were not understood

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
 * Compare what is on disk with the source, writing nothing.
 *
 * @param {string} root
 * @param {string} target absolute path of the copied bundle
 * @param {Buffer} sourceBuffer
 * @param {Buffer | undefined} sourceMap source map bytes, when one exists
 * @returns {string | undefined} why it drifted, or `undefined` when in sync
 */
function findDrift(root, target, sourceBuffer, sourceMap) {
  const existing = readOptional(target);
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
    const copy = readOptional(mapPath);
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
 * Copy one file verbatim and prove the result.
 *
 * Skips the write when the destination already holds exactly these bytes,
 * which keeps Vite's file watcher quiet during `vite build --watch`. After a
 * write, the destination is read back and its SHA-256 compared with the
 * source's, so a truncated or partially written copy fails loudly instead of
 * shipping a broken agent.
 *
 * @param {string} root
 * @param {string} from absolute source path
 * @param {string} to absolute destination path
 * @param {Buffer} expected bytes `from` is known to hold
 * @returns {boolean} whether bytes were actually written
 */
function copyVerified(root, from, to, expected) {
  const existing = readOptional(to);
  if (existing !== undefined && Buffer.compare(existing, expected) === 0) {
    return false;
  }

  try {
    // copyFileSync, never a utf8 round-trip: no transcoding, no BOM, no
    // line-ending translation, nothing that could alter a single byte.
    fs.copyFileSync(from, to);
  } catch (error) {
    throw ioError(`could not write ${display(root, to)}`, error);
  }

  const written = readOptional(to);
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
 * @param {string} root
 * @param {string} target absolute path of the copied bundle
 * @param {string} sourceMapPath absolute path of the source map
 * @param {Buffer} sourceMap bytes at `sourceMapPath`
 * @returns {string[]} absolute paths actually written
 */
function copySourceMaps(root, target, sourceMapPath, sourceMap) {
  const directory = path.dirname(target);
  /** @type {string[]} */
  const written = [];

  for (const name of TARGET_MAP_NAMES) {
    const mapPath = path.join(directory, name);
    if (copyVerified(root, sourceMapPath, mapPath, sourceMap)) {
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
 * @param {{ root?: string, check?: boolean }} [options] `root` defaults to the
 *   repository root derived from this script's location; `check` verifies
 *   without writing
 * @returns {CopyAgentResult}
 * @throws {CopyAgentError} when the source is missing or empty, the target
 *   cannot be written, or the written copy fails verification
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

  if (check) {
    const reason = findDrift(root, target, sourceBuffer, sourceMap);
    if (reason !== undefined) {
      return { ...base, action: 'drift', maps: [], reason };
    }
    return { ...base, action: 'unchanged', maps: [] };
  }

  const existingStats = statOptional(target);
  if (existingStats !== undefined && !existingStats.isFile()) {
    throw new CopyAgentError(`the target is not a regular file: ${display(root, target)}`, {
      hint: 'Remove whatever occupies that path and re-run the copy.',
    });
  }

  ensureDirectory(root, path.dirname(target));
  const copied = copyVerified(root, source, target, sourceBuffer);
  const maps =
    sourceMap === undefined ? [] : copySourceMaps(root, target, sourceMapPath, sourceMap);

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
