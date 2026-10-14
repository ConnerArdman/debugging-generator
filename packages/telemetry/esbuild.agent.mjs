#!/usr/bin/env node
/**
 * esbuild.agent — build the page-injected browser telemetry agent.
 *
 * Emits exactly one artifact, `packages/telemetry/dist/browser-agent.iife.js`,
 * bundled from `src/browser/agent.ts`. That file is the most
 * environment-constrained thing in this repository: Chrome loads it verbatim
 * from `apps/chrome-extension/public/agent.iife.js` as a content script with
 * `world: "MAIN"`, `run_at: "document_start"` and `all_frames: false`, matched
 * to the developer's local app origins, so it runs *inside the page* before the
 * page's own scripts — which is what lets the agent install bippy's React
 * DevTools hook before React loads.
 *
 * Three consequences shape every option below.
 *
 * 1. The name and location are a contract, not a preference.
 *    `scripts/copy-agent.mjs` copies this exact path into the extension byte for
 *    byte and verifies the SHA-256 of what it wrote; `--check` re-compares the
 *    hashes to detect drift. `apps/chrome-extension/manifest.config.ts` declares
 *    the copied file directly, and the extension's `prebuild`/`predev` hook runs
 *    the copy. None of those three can be fixed from this folder if the output
 *    name drifts, so `outfile` is used rather than `outdir` and the constants
 *    that spell it out live at the top of this file.
 *
 * 2. Rebuilding identical sources must produce identical bytes.
 *    Because the copy step hashes the artifact, anything that varies between
 *    runs — a timestamp, a git hash, a version read from the environment, a
 *    random id — would make `copy-agent --check` report drift on an unchanged
 *    tree and would churn CI. The banner is therefore a fixed string, there is
 *    no footer, and `define` carries exactly one entry.
 *
 * 3. The page is not Node, and nothing in the page may pretend otherwise.
 *    The bundle has no module loader available (`external: []` — everything is
 *    inlined) and no Node runtime beneath it. `packages/telemetry/tsconfig.json`
 *    type-checks the runtime-neutral library, this browser subtree and the
 *    dev-server preload in one program, with `lib` including both DOM and
 *    `@types/node`, so the compiler alone will happily accept `node:fs` in
 *    `src/browser/**`. ESLint covers part of the gap (`@debuggen/protocol` and
 *    `@debuggen/shared/node` are restricted imports there); this script covers
 *    the rest mechanically:
 *      - an `onResolve` guard fails the build on any Node builtin specifier,
 *        naming the importing file (see `createNodeBuiltinGuard`);
 *      - a metafile audit fails the build when a forbidden module reaches the
 *        bundle — `zod`, `@debuggen/protocol`, `@debuggen/shared`'s Node entry,
 *        any `@opentelemetry/*` package, or anything under `apps/` (see
 *        `FORBIDDEN_INPUTS`).
 *    Node builtins are expected *here*: this file runs in Node. The prohibition
 *    applies to the sources being bundled, never to the bundler.
 *
 * Usage: `node esbuild.agent.mjs [--watch] [--dev] [--quiet]`, or `--help`.
 * Invoked by this package's `build` script after `tsup` (which cleans `dist/`),
 * so the output directory is created here rather than assumed.
 *
 * Exit codes, one convention shared with `esbuild.node.mjs` — the other bundler
 * this package's one `build` script runs, so a wrapper or a CI step reads both
 * the same way: 0 success (the artifact was written and the audit passed) or
 * `--help`; 1 the build ran and its result was rejected (esbuild reported
 * errors, or the audit rejected the bundle), which is also the code an
 * unexpected failure ends on; 2 nothing was built, because the argument list was
 * not understood or a precondition of the build does not hold — here, the entry
 * file being absent or not a regular file.
 *
 * @module packages/telemetry/esbuild.agent
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';

/**
 * Absolute path of this package, derived from this module's own location rather
 * than from `process.cwd()`. `package.json` runs the script as
 * `node esbuild.agent.mjs` with the package as the working directory, but
 * `pnpm -r build`, a repository-root invocation and an editor task can all set a
 * different cwd; every path in this file resolves from here so the result is
 * identical from anywhere.
 *
 * @type {string}
 */
export const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root, two levels above this package (`packages/telemetry`). Used
 * only to render paths for humans and to anchor the workspace-directory checks
 * in {@link FORBIDDEN_INPUTS}.
 *
 * @type {string}
 */
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** Package-relative entry point of the browser agent. */
export const ENTRY_REL = 'src/browser/agent.ts';

/**
 * Package-relative output path. Fixed by `scripts/copy-agent.mjs` (`SOURCE_REL`)
 * and, through the copy it performs, by the Chrome extension manifest.
 */
export const OUTFILE_REL = 'dist/browser-agent.iife.js';

/** Package-relative output directory, created before the build runs. */
export const OUTPUT_DIR_REL = 'dist';

/**
 * The only banner the artifact carries: a constant, so the bytes stay stable
 * across rebuilds. Nothing derived from `Date`, `process.env`, git state or
 * randomness may ever join it.
 */
export const BANNER = '/* @debuggen/telemetry browser agent */';

/** Build succeeded and the boundary audit passed, or `--help` printed. */
export const EXIT_OK = 0;

/**
 * The build ran and its result was rejected: esbuild reported errors, or the
 * boundary audit rejected the bundle. An unexpected failure ends here too.
 */
export const EXIT_FAILURE = 1;

/**
 * Nothing was built: the argument list was not understood (an unrecognised
 * flag), or a precondition of the build does not hold — here, the entry file
 * being absent or not a regular file. The same code `esbuild.node.mjs` reports
 * for its own preconditions.
 */
export const EXIT_USAGE = 2;

/** Width used when rendering esbuild diagnostics, matching Prettier's printWidth. */
const TERMINAL_WIDTH = 100;

/**
 * Failure carrying the exit code the CLI should use plus, where one exists, a
 * multi-line hint that states exactly how to recover. Mirrors the shape used by
 * `scripts/copy-agent.mjs` so both scripts read the same way.
 */
export class AgentBuildError extends Error {
  /**
   * @param {string} message single-line description of what went wrong
   * @param {{ exitCode?: number, hint?: string, showUsage?: boolean }} [options]
   *   `exitCode` defaults to {@link EXIT_FAILURE}, the code for a rejected build
   *   result and for an unexpected failure; pass {@link EXIT_USAGE} for every
   *   precondition failure — an unrecognised argument, or an entry point that is
   *   missing or not a regular file — which is how `esbuild.node.mjs` classifies
   *   the same class of condition
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'AgentBuildError';
    /** @type {number} process exit code that corresponds to this failure */
    this.exitCode = options.exitCode ?? EXIT_FAILURE;
    /** @type {string | undefined} multi-line recovery instructions */
    this.hint = options.hint;
    /** @type {boolean} whether the CLI should print full usage as well */
    this.showUsage = options.showUsage === true;
  }
}

/**
 * Normalise a path to POSIX separators so the audit patterns below can be
 * written once and still match on Windows.
 *
 * @param {string} value
 * @returns {string}
 */
function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * Render an absolute path relative to `root` for display, falling back to the
 * absolute path when the target sits outside it (a pnpm virtual-store path can
 * legitimately climb out of the package).
 *
 * @param {string} root
 * @param {string} absolute
 * @returns {string}
 */
function display(root, absolute) {
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return toPosix(absolute);
  }
  return toPosix(relative);
}

/**
 * Whether `child` is `parent` itself or sits underneath it.
 *
 * @param {string} parent absolute path
 * @param {string} child absolute path
 * @returns {boolean}
 */
function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Write one line to a stream. Used instead of `console` so the script depends on
 * nothing but `node:` builtins and the esbuild API, and so stdout carries only
 * the success report while every diagnostic goes to stderr.
 *
 * @param {import("node:stream").Writable} stream
 * @param {string} text
 * @returns {void}
 */
function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

/**
 * Render a byte count with a binary-prefix approximation. Deliberately not
 * `toLocaleString`, whose grouping depends on the host locale: this line is read
 * in CI logs and should look the same everywhere.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  return `${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`;
}

/**
 * The `--help` text. It documents the two things that surprise people here — the
 * artifact name being a contract and the import boundary being enforced at build
 * time — because both are failure modes that look like bugs elsewhere.
 *
 * @returns {string}
 */
export function usage() {
  return `esbuild.agent — build the page-injected browser telemetry agent

Usage
  node esbuild.agent.mjs [--watch] [--dev] [--quiet]
  node esbuild.agent.mjs --help

Emits
  from  ${ENTRY_REL}
  to    ${OUTFILE_REL}

One self-contained IIFE, minified, no source map, no code splitting, nothing
external. Chrome loads the copy of this file that scripts/copy-agent.mjs
installs at apps/chrome-extension/public/agent.iife.js as a MAIN-world content
script at document_start, so the bundle must be a single file that runs
synchronously with no module loader beneath it.

Determinism
  Identical sources produce identical bytes: the banner is a fixed string and
  nothing derived from the clock, the environment, git state or randomness
  enters the output. copy-agent.mjs --check compares SHA-256 hashes, so a
  varying byte would report drift on an unchanged tree.

Import boundary (enforced, not advisory)
  The build fails when the bundle reaches for a Node builtin (node:* or a bare
  builtin name), naming the importing file, and when the bundle pulls in any
  of: zod, @debuggen/protocol, @debuggen/shared's Node entry, an
  @opentelemetry/* package, or anything under apps/. Telemetry event *types*
  are imported with \`import type\`; validation happens at ingest in the local
  service, never in the developer's page.

Options
  --watch   rebuild on change (esbuild context + watch), re-running the import
            boundary audit after every rebuild; Ctrl-C stops it. A failing
            rebuild prints and watching continues, so the exit code on stop is
            the outcome of the last completed rebuild, not of the session
  --dev     opt-in development build: unminified with an inline source map,
            written to the same path. Never what \`pnpm build\` runs; re-run
            without --dev before copying, committing or measuring size
  --quiet   suppress the success line; failures are still reported
  --help    print this text

Exit codes (the same three esbuild.node.mjs uses, so the pair this package's
build script runs reads consistently)
  0  success: ${OUTFILE_REL} was written and passed the audit, or --help
  1  the build ran and its result was rejected: esbuild reported errors, or the
     audit rejected the bundle — also the code an unexpected failure ends on
  2  nothing was built: the argument list was not understood, or a precondition
     of the build does not hold — ${ENTRY_REL} missing or not a regular file

Paths resolve from this script's own location, never from the working
directory, so the result is identical whether it is invoked from the package
root (how package.json runs it), from the repository root, or from an editor
task. dist/ is created if absent, because this package's \`build\` runs tsup
first and tsup cleans dist/.`;
}

/**
 * @typedef {object} AgentBuildOptions
 * @property {boolean} watch rebuild on change instead of exiting
 * @property {boolean} dev unminified build with an inline source map
 * @property {boolean} quiet suppress the success line
 * @property {boolean} help print usage instead of building
 */

/**
 * Parse the CLI flags. The script takes no positional arguments, so anything
 * unrecognised is a usage error rather than a silently ignored token — a typo in
 * `--wathc` must not quietly produce a one-shot build.
 *
 * @param {readonly string[]} argv arguments after the script path
 * @returns {AgentBuildOptions}
 * @throws {AgentBuildError} on an unrecognised argument (exit code 2)
 */
export function parseArgs(argv) {
  /** @type {AgentBuildOptions} */
  const options = { watch: false, dev: false, quiet: false, help: false };

  for (const arg of argv) {
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--watch':
      case '-w':
        options.watch = true;
        break;
      case '--dev':
        options.dev = true;
        break;
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      default:
        throw new AgentBuildError(`unrecognised argument: ${arg}`, {
          exitCode: EXIT_USAGE,
          showUsage: true,
        });
    }
  }

  return options;
}

/**
 * Builtins that `node:module`'s `builtinModules` omits because they are
 * reachable only through the `node:` prefix. Listing them keeps the guard honest
 * for the bare-name spelling as well: a bare `sqlite` import is a dependency on
 * an npm package that does not exist here, and either way it has no business in
 * a script injected into a web page.
 *
 * @type {readonly string[]}
 */
const PREFIX_ONLY_BUILTINS = ['sqlite', 'test', 'sea'];

/**
 * Builtins the AAP calls out explicitly (AAP §0.7.1, this file's brief). They
 * are all in `builtinModules` on Node 24 except `sqlite`; restating them means a
 * future Node release that reorganises `builtinModules` cannot quietly open a
 * hole in the guard.
 *
 * @type {readonly string[]}
 */
const NAMED_BUILTINS = [
  'fs',
  'path',
  'crypto',
  'os',
  'util',
  'events',
  'stream',
  'buffer',
  'process',
  'worker_threads',
  'http',
  'https',
  'net',
  'tls',
  'zlib',
  'url',
  'child_process',
  'module',
  'perf_hooks',
  'async_hooks',
  'sqlite',
];

/**
 * Every module specifier the agent bundle may not import, as bare names. The
 * `node:` prefixed form is handled separately in
 * {@link isNodeBuiltinSpecifier}, because that namespace is reserved by Node and
 * a name it does not yet publish is still not something a page can load.
 *
 * @type {ReadonlySet<string>}
 */
export const NODE_BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...PREFIX_ONLY_BUILTINS,
  ...NAMED_BUILTINS,
]);

/**
 * Whether a specifier names a Node builtin.
 *
 * Relative (`./x.js`), absolute (`/tmp/x.js`) and scoped (`@debuggen/shared`)
 * specifiers are never builtins. A subpath such as `fs/promises`,
 * `stream/web` or `dns/promises` is matched both as a whole and by its first
 * segment, so an unpublished subpath of a real builtin is still caught.
 *
 * @param {string} specifier as written in the import
 * @returns {boolean}
 */
export function isNodeBuiltinSpecifier(specifier) {
  if (specifier.startsWith('node:')) return true;
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('@')) {
    return false;
  }
  if (NODE_BUILTIN_MODULES.has(specifier)) return true;

  const [head] = specifier.split('/');
  return head !== undefined && head !== '' && NODE_BUILTIN_MODULES.has(head);
}

/**
 * esbuild plugin that fails the build on any Node builtin the agent's dependency
 * graph reaches for, reporting every one of them (`logLimit: 0` in
 * {@link createBuildOptions} is what keeps esbuild from truncating the list at
 * its default ten).
 *
 * Without it, `platform: "browser"` reports a bare `import "fs"` as the
 * thoroughly unhelpful `Could not resolve "fs"` — which reads like a missing
 * dependency and invites someone to "fix" it by installing a polyfill. The
 * message below states the rule instead, and esbuild attaches the import site
 * (file, line, column and the offending source line) automatically, so the
 * offender is obvious.
 *
 * The filter is deliberately match-everything: every specifier passes through
 * {@link isNodeBuiltinSpecifier}, and anything that is not a builtin returns
 * `null` so esbuild continues with its own resolution unchanged.
 *
 * @param {{ packageRoot?: string }} [options]
 * @returns {import("esbuild").Plugin}
 */
export function createNodeBuiltinGuard({ packageRoot = PACKAGE_ROOT } = {}) {
  return {
    name: 'debuggen-no-node-builtins',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!isNodeBuiltinSpecifier(args.path)) return null;

        const importer =
          args.importer === '' ? '<entry point>' : display(packageRoot, args.importer);

        return {
          errors: [
            {
              text: `the browser agent must not import the Node builtin "${args.path}"`,
              notes: [
                { text: `imported by ${importer}` },
                {
                  text:
                    "This bundle is injected into the developer's page as a MAIN-world " +
                    'content script at document_start: there is no Node runtime and no ' +
                    'module loader beneath it.',
                },
                {
                  text:
                    'Use a browser capability instead (crypto.getRandomValues, ' +
                    'performance, fetch, URL), move the work to the local service, or — ' +
                    'for hashing and filesystem helpers — keep it in ' +
                    '@debuggen/shared/node, which only the service and the Node preload ' +
                    'may import. Never add a builtin polyfill to make this pass.',
                },
              ],
            },
          ],
        };
      });
    },
  };
}

/**
 * @typedef {object} ForbiddenInputRule
 * @property {string} id short label used in the failure report
 * @property {RegExp | undefined} pattern matched against the POSIX form of both
 *   the metafile-relative and the absolute input path; `undefined` when the rule
 *   is expressed purely as workspace directories
 * @property {readonly string[]} directories repository-relative directories that
 *   no input may sit inside; these catch the workspace form of a dependency,
 *   which esbuild reports as a real path (`../protocol/dist/index.js`) rather
 *   than through the pnpm symlink
 * @property {string} reason why this module may not reach the page, printed with
 *   the violation
 */

/**
 * Modules that must never end up inside the agent bundle, with the reason each
 * one is excluded. The audit runs against `metafile.inputs` after a successful
 * build, so it catches a forbidden module however it arrived — a direct import, a
 * transitive dependency, or an `import type` that lost its `type` keyword and
 * became a runtime import.
 *
 * Adding a rule is the right move when a new module turns out to be unshippable
 * to the page; removing one requires a decision recorded in the AAP, because
 * each of these is a layering guarantee that something else depends on.
 *
 * @type {readonly ForbiddenInputRule[]}
 */
export const FORBIDDEN_INPUTS = [
  {
    id: 'zod',
    pattern: /(^|\/)node_modules\/zod(\/|$)/,
    directories: [],
    reason:
      'The agent constructs plain telemetry objects and imports the event ' +
      'schema types with `import type`. Validation happens once, at ingest in ' +
      'the local service (AAP 0.5.2), so shipping the validator into every ' +
      'localhost page would be both wasted bytes — zod pulls in its whole ' +
      'locale table — and a layering violation.',
  },
  {
    id: '@debuggen/protocol',
    pattern: /(^|\/)node_modules\/@debuggen\/protocol(\/|$)/,
    directories: ['packages/protocol'],
    reason:
      'protocol sits above telemetry in the package graph (AAP 0.2.2). The ' +
      'agent emits raw event batches on its private page channel; the Chrome ' +
      'service worker is what wraps them in protocol envelopes.',
  },
  {
    id: '@debuggen/shared/node',
    pattern: /(^|\/)node_modules\/@debuggen\/shared\/dist\/node(\/|$)/,
    directories: ['packages/shared/dist/node'],
    reason:
      "That entry is the package's Node-only half (hashing, safe filesystem " +
      'helpers) and reaches for node: builtins. The agent may import ' +
      "@debuggen/shared's root entry, which is browser-safe.",
  },
  {
    id: '@opentelemetry/*',
    pattern: /(^|\/)node_modules\/@opentelemetry\//,
    directories: [],
    reason:
      'No OpenTelemetry SDK runs in the page. The agent generates W3C trace ' +
      'and span ids itself and writes the traceparent header by hand (AAP ' +
      '0.2.4 rejected sdk-trace-web and context-zone for ES2017+ output); the ' +
      'SDK belongs to the Node preload under src/node/**.',
  },
  {
    id: 'apps/*',
    pattern: undefined,
    directories: ['apps'],
    reason:
      'Packages never import applications. The agent is copied into the Chrome ' +
      'extension as a finished artifact, and the demo app must stay a pure ' +
      'instrumentation target with no product code inside it.',
  },
];

/**
 * Shortest import chain from the bundle's entry point to `target`, as metafile
 * input keys. Breadth-first, so the chain printed with a violation is the most
 * direct route rather than an arbitrary one, which makes it deterministic and
 * therefore diffable between runs.
 *
 * @param {import("esbuild").Metafile} metafile
 * @param {string} target metafile input key of the offending module
 * @param {string | undefined} entry metafile input key of the entry point
 * @returns {string[]} `[entry, …, target]`, or `[target]` when no route exists
 *   (an input esbuild recorded without a resolvable import edge)
 */
export function findImportChain(metafile, target, entry) {
  if (entry === undefined || entry === target) return [target];

  /** @type {Map<string, string>} child -> parent */
  const parents = new Map();
  /** @type {string[]} */
  const queue = [entry];
  const seen = new Set([entry]);

  while (queue.length > 0) {
    const current = /** @type {string} */ (queue.shift());
    const input = metafile.inputs[current];
    if (input === undefined) continue;

    for (const edge of input.imports) {
      // External imports and generated helpers have no input record of their
      // own; only edges that name a real input can continue the chain.
      if (edge.external === true || metafile.inputs[edge.path] === undefined) continue;
      if (seen.has(edge.path)) continue;

      seen.add(edge.path);
      parents.set(edge.path, current);
      if (edge.path === target) {
        /** @type {string[]} */
        const chain = [target];
        let cursor = target;
        while (parents.has(cursor)) {
          cursor = /** @type {string} */ (parents.get(cursor));
          chain.unshift(cursor);
        }
        return chain;
      }
      queue.push(edge.path);
    }
  }

  return [target];
}

/**
 * @typedef {object} InputViolation
 * @property {string} ruleId which {@link FORBIDDEN_INPUTS} rule matched
 * @property {string} reason the rule's explanation
 * @property {string} input metafile input key, relative to the build's working
 *   directory
 * @property {string} displayPath the same input rendered relative to the
 *   repository root
 * @property {readonly string[]} chain import chain from the entry point
 */

/**
 * Audit a build's inputs against {@link FORBIDDEN_INPUTS}.
 *
 * Input keys are relative to esbuild's working directory (this package) and are
 * real paths, so a pnpm dependency appears as
 * `../../node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js` and a workspace
 * dependency as `../protocol/dist/index.js`. Each rule is therefore matched two
 * ways: its pattern against the POSIX spelling of both the relative and the
 * absolute path, and its directory list against the resolved absolute path.
 *
 * @param {import("esbuild").Metafile} metafile
 * @param {{ packageRoot?: string, repoRoot?: string }} [options]
 * @returns {InputViolation[]} sorted by rule then path, so the report is stable
 */
export function auditInputs(metafile, { packageRoot = PACKAGE_ROOT, repoRoot = REPO_ROOT } = {}) {
  const entry = Object.values(metafile.outputs).find(
    (output) => output.entryPoint !== undefined,
  )?.entryPoint;

  /** @type {InputViolation[]} */
  const violations = [];

  for (const input of Object.keys(metafile.inputs)) {
    const absolute = path.resolve(packageRoot, input);
    const relativePosix = toPosix(input);
    const absolutePosix = toPosix(absolute);

    for (const rule of FORBIDDEN_INPUTS) {
      const matchesPattern =
        rule.pattern !== undefined &&
        (rule.pattern.test(relativePosix) || rule.pattern.test(absolutePosix));
      const matchesDirectory = rule.directories.some((directory) =>
        isInside(path.resolve(repoRoot, directory), absolute),
      );

      if (matchesPattern || matchesDirectory) {
        violations.push({
          ruleId: rule.id,
          reason: rule.reason,
          input,
          displayPath: display(repoRoot, absolute),
          chain: findImportChain(metafile, input, entry),
        });
        // One violation per input: the first matching rule is the reason.
        break;
      }
    }
  }

  violations.sort((left, right) =>
    left.ruleId === right.ruleId
      ? left.input.localeCompare(right.input)
      : left.ruleId.localeCompare(right.ruleId),
  );

  return violations;
}

/**
 * How many offending modules each rule reports with a full import chain. One
 * forbidden package drags in its whole file list — a single `import { z } from
 * "zod"` matched 95 inputs while this was being validated — and a report that
 * long buries the one line that matters. The first few chains identify the
 * import to delete; the rest are the same story told again, so they are
 * counted rather than printed.
 */
const MAX_REPORTED_PER_RULE = 5;

/**
 * Wrap prose to `width` columns with a fixed indent, so a rule's reason reads as
 * a paragraph in a CI log instead of one line that scrolls off the right.
 *
 * @param {string} text
 * @param {string} indent prefix for every produced line
 * @param {number} [width] total line width including the indent
 * @returns {string[]}
 */
function wrapText(text, indent, width = TERMINAL_WIDTH) {
  /** @type {string[]} */
  const lines = [];
  let current = '';

  for (const word of text.split(/\s+/).filter((part) => part !== '')) {
    if (current === '') {
      current = word;
    } else if (`${indent}${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(`${indent}${current}`);
      current = word;
    }
  }

  if (current !== '') lines.push(`${indent}${current}`);
  return lines;
}

/**
 * Shorten one chain step for display: a dependency inside any `node_modules`
 * (pnpm's virtual store spells it
 * `../../node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js`) is rendered
 * from its package name onwards, while first-party files keep their
 * repository-relative path. Chains read as `src/browser/agent.ts ->
 * src/browser/dom-target.ts -> zod/index.js`, which is the information without
 * the store noise.
 *
 * @param {string} step metafile input key
 * @param {{ packageRoot: string, repoRoot: string }} roots
 * @returns {string}
 */
function shortenChainStep(step, { packageRoot, repoRoot }) {
  const absolute = toPosix(path.resolve(packageRoot, step));
  const marker = '/node_modules/';
  const index = absolute.lastIndexOf(marker);
  if (index !== -1) return absolute.slice(index + marker.length);
  return display(repoRoot, path.resolve(packageRoot, step));
}

/**
 * Render the audit failure. Violations are grouped by rule, each with its
 * reason and up to {@link MAX_REPORTED_PER_RULE} import chains, because the
 * chain is what turns "zod is in the bundle" into "this import is why".
 *
 * @param {readonly InputViolation[]} violations
 * @param {{ packageRoot?: string, repoRoot?: string }} [options]
 * @returns {string}
 */
export function describeViolations(
  violations,
  { packageRoot = PACKAGE_ROOT, repoRoot = REPO_ROOT } = {},
) {
  /** @type {Map<string, InputViolation[]>} */
  const grouped = new Map();
  for (const violation of violations) {
    const bucket = grouped.get(violation.ruleId);
    if (bucket === undefined) grouped.set(violation.ruleId, [violation]);
    else bucket.push(violation);
  }

  const lines = [
    `esbuild.agent: the agent bundle reached ${violations.length} forbidden ` +
      `${violations.length === 1 ? 'input' : 'inputs'} across ${grouped.size} ` +
      `${grouped.size === 1 ? 'rule' : 'rules'}`,
    '',
    `Nothing was written: the rejected bundle never reached ${OUTFILE_REL}, which`,
    'still holds the previous build (or nothing at all). Fix the imports listed',
    'below and re-run this script.',
  ];

  for (const [ruleId, bucket] of grouped) {
    lines.push(
      '',
      `${ruleId} — ${bucket.length} ${bucket.length === 1 ? 'input' : 'inputs'}`,
      ...wrapText(bucket[0]?.reason ?? '', '  '),
    );

    for (const violation of bucket.slice(0, MAX_REPORTED_PER_RULE)) {
      const chain = violation.chain.map((step) =>
        shortenChainStep(step, { packageRoot, repoRoot }),
      );
      lines.push('', `  ${violation.displayPath}`, `    imported via ${chain.join(' -> ')}`);
    }

    const hidden = bucket.length - MAX_REPORTED_PER_RULE;
    if (hidden > 0) {
      lines.push(
        '',
        `  ... and ${hidden} further ${hidden === 1 ? 'input' : 'inputs'} ` +
          'matched by this rule',
      );
    }
  }

  return lines.join('\n');
}

/**
 * The esbuild options for the agent bundle. Every value is a decision, so they
 * are listed once here and shared by the one-shot and watch paths — a watch
 * rebuild must produce the same bytes a `pnpm build` would.
 *
 * `write: false` is the one option that is about process rather than output: the
 * bundle is held in memory until {@link auditInputs} has cleared it, so a build
 * that violates the import boundary can never leave an artifact behind for
 * `scripts/copy-agent.mjs` to install into Chrome. The bytes written afterwards
 * are exactly the bytes esbuild produced.
 *
 * @param {{ dev?: boolean, packageRoot?: string }} [options] `dev` opts into an
 *   unminified build with an inline source map; it is never the default
 * @returns {import("esbuild").BuildOptions}
 */
export function createBuildOptions({ dev = false, packageRoot = PACKAGE_ROOT } = {}) {
  return {
    // Anchored to this package so metafile paths, the tsconfig lookup and the
    // outfile are all independent of the caller's working directory.
    absWorkingDir: packageRoot,
    entryPoints: [ENTRY_REL],
    // outfile, never outdir: the file name is a contract with
    // scripts/copy-agent.mjs and the Chrome extension manifest.
    outfile: OUTFILE_REL,
    bundle: true,
    // One self-executing script. The agent is side-effect-only — it installs
    // bippy's React DevTools hook and globalThis.__DEBUGGEN__ itself — so there
    // is deliberately no globalName to hang exports off.
    format: 'iife',
    platform: 'browser',
    // Chrome 111 is the floor for a static manifest entry with world: "MAIN";
    // the suites run Chromium 153. ES2017+ output is also why the plan rejected
    // @opentelemetry/context-zone, whose Zone context manager cannot work here.
    target: ['chrome111'],
    charset: 'utf8',
    legalComments: 'none',
    // Safe to minify: nothing depends on the agent's function names. (The Node
    // preload built by esbuild.node.mjs deliberately keeps them, because its
    // stack traces are read by the developer.)
    minify: !dev,
    // No source map by default: copy-agent.mjs moves exactly one file, so an
    // external map would never reach the extension, and an inline map would
    // bloat a script injected into every localhost page.
    sourcemap: dev ? 'inline' : false,
    splitting: false,
    treeShaking: true,
    // Comments and `extends` are fine here; esbuild reads tsconfig.json as JSONC
    // and follows the chain up to tsconfig.base.json, which is where
    // verbatimModuleSyntax comes from — the setting that keeps a type-only
    // import from surviving as a runtime one.
    tsconfig: './tsconfig.json',
    metafile: true,
    // The page has no module loader: everything the agent needs is inlined.
    external: [],
    banner: { js: BANNER },
    // Exactly one define. Dependencies that branch on the environment (bippy
    // among them) collapse at build time and no `process` reference survives
    // into the page. The agent's own configuration arrives at runtime in the
    // agent.config message, never from a build-time constant.
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    write: false,
    // This script owns every line of output, so esbuild prints nothing itself;
    // logLimit 0 means no diagnostic is dropped from the report.
    logLevel: 'silent',
    logLimit: 0,
    plugins: [createNodeBuiltinGuard({ packageRoot })],
  };
}

/**
 * Fail when the entry point is missing: nothing can be built, so this is a
 * precondition failure and reports {@link EXIT_USAGE} rather than a build
 * failure. Checked before the build so the message names the file and the likely
 * cause, rather than leaving esbuild to report an unresolvable entry path.
 * `esbuild.node.mjs` classifies its own missing entry point the same way, in
 * `preflight`.
 *
 * @param {{ packageRoot?: string }} [options]
 * @returns {Promise<void>}
 * @throws {AgentBuildError} exit code 2 — nothing was built — when the entry is
 *   absent or not a regular file
 */
export async function assertEntryExists({ packageRoot = PACKAGE_ROOT } = {}) {
  const entry = path.join(packageRoot, ENTRY_REL);

  /** @type {import("node:fs").Stats} */
  let stats;
  try {
    stats = await stat(entry);
  } catch {
    throw new AgentBuildError(`the agent entry point is missing: ${ENTRY_REL}`, {
      exitCode: EXIT_USAGE,
      hint: [
        `Expected ${display(REPO_ROOT, entry)}.`,
        '',
        'That module is the browser agent itself: at document_start it installs',
        "bippy's React DevTools hook and globalThis.__DEBUGGEN__, then stays",
        'dormant until an agent.config message arms its hooks. Nothing else in',
        'this package can stand in for it, so the build stops here rather than',
        'emitting an empty bundle that would load in Chrome and capture nothing.',
      ].join('\n'),
    });
  }

  if (!stats.isFile()) {
    throw new AgentBuildError(`the agent entry point is not a regular file: ${ENTRY_REL}`, {
      exitCode: EXIT_USAGE,
      hint: `Remove whatever occupies ${display(REPO_ROOT, entry)} and rebuild.`,
    });
  }
}

/**
 * Create the output directory. This package's `build` runs `tsup` first and tsup
 * cleans `dist/`, so the directory is frequently absent when this script starts.
 *
 * @param {{ packageRoot?: string }} [options]
 * @returns {Promise<string>} absolute path of the output directory
 */
export async function ensureOutputDirectory({ packageRoot = PACKAGE_ROOT } = {}) {
  const directory = path.join(packageRoot, OUTPUT_DIR_REL);
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * Render esbuild diagnostics exactly as esbuild's own CLI would, minus colour so
 * the text is readable in a CI log.
 *
 * @param {readonly import("esbuild").Message[]} messages
 * @param {"error" | "warning"} kind
 * @returns {Promise<string>} formatted text, or `''` when there is nothing to say
 */
async function formatDiagnostics(messages, kind) {
  if (messages.length === 0) return '';
  const formatted = await esbuild.formatMessages(messages, {
    kind,
    color: false,
    terminalWidth: TERMINAL_WIDTH,
  });
  return formatted.join('').trimEnd();
}

/**
 * The success line: what was written, how big it is, and how many modules went
 * into it. The input count and byte size are reported, never enforced — an
 * arbitrary size ceiling would fail CI on an unrelated day — but they are printed
 * on every build so a reviewer watching the log sees the bundle grow.
 *
 * @param {{ bytes: number, inputCount: number, dev: boolean }} summary
 * @returns {string}
 */
export function describeSuccess({ bytes, inputCount, dev }) {
  const flavour = dev ? ' [--dev: unminified, inline source map]' : '';
  return (
    `esbuild.agent: ${OUTFILE_REL} ${formatBytes(bytes)} from ${inputCount} ` +
    `${inputCount === 1 ? 'input' : 'inputs'}${flavour}`
  );
}

/**
 * @typedef {object} AgentBuildReport
 * @property {number} code exit code this outcome corresponds to
 * @property {number} bytes size of the artifact, 0 when nothing was written
 * @property {number} inputCount modules that went into the bundle
 * @property {readonly InputViolation[]} violations import-boundary failures
 */

/**
 * Turn one esbuild result into the artifact on disk plus everything printed
 * about it. Shared by the one-shot and watch paths so both apply the same audit
 * and produce the same text; only the disposition differs — one exits, the other
 * keeps watching.
 *
 * Order matters: warnings first (they are context for whatever follows), then
 * errors, then the import-boundary audit, and only then the write. Nothing
 * reaches `dist/` until the bundle has passed.
 *
 * @param {import("esbuild").BuildResult} result
 * @param {{ dev?: boolean, quiet?: boolean, packageRoot?: string }} [options]
 * @returns {Promise<AgentBuildReport>}
 */
export async function reportResult(
  result,
  { dev = false, quiet = false, packageRoot = PACKAGE_ROOT } = {},
) {
  const warnings = await formatDiagnostics(result.warnings ?? [], 'warning');
  if (warnings !== '') writeLine(process.stderr, warnings);

  const errors = result.errors ?? [];
  if (errors.length > 0) {
    const text = await formatDiagnostics(errors, 'error');
    if (text !== '') writeLine(process.stderr, text);
    writeLine(
      process.stderr,
      `esbuild.agent: build failed with ${errors.length} ` +
        `${errors.length === 1 ? 'error' : 'errors'}; ${OUTFILE_REL} was not written`,
    );
    return { code: EXIT_FAILURE, bytes: 0, inputCount: 0, violations: [] };
  }

  const metafile = result.metafile;
  if (metafile === undefined) {
    // Unreachable through createBuildOptions (metafile is always on); guarded so
    // a future caller that forgets it gets a diagnosis instead of a TypeError.
    writeLine(
      process.stderr,
      'esbuild.agent: the build produced no metafile, so the import-boundary ' +
        'audit could not run; nothing was written',
    );
    return { code: EXIT_FAILURE, bytes: 0, inputCount: 0, violations: [] };
  }

  const inputCount = Object.keys(metafile.inputs).length;
  const violations = auditInputs(metafile, { packageRoot });
  if (violations.length > 0) {
    writeLine(process.stderr, describeViolations(violations, { packageRoot }));
    return { code: EXIT_FAILURE, bytes: 0, inputCount, violations };
  }

  const outputFile = (result.outputFiles ?? [])[0];
  if (outputFile === undefined) {
    writeLine(
      process.stderr,
      `esbuild.agent: the build produced no output file for ${OUTFILE_REL}`,
    );
    return { code: EXIT_FAILURE, bytes: 0, inputCount, violations: [] };
  }

  try {
    // The directory is created here as well as before the build, because a watch
    // session outlives a `tsup` run that cleans dist/ underneath it.
    await mkdir(path.dirname(outputFile.path), { recursive: true });
    await writeFile(outputFile.path, outputFile.contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeLine(
      process.stderr,
      `esbuild.agent: the bundle passed the audit but could not be written to ` +
        `${OUTFILE_REL}: ${detail}`,
    );
    return { code: EXIT_FAILURE, bytes: 0, inputCount, violations: [] };
  }

  const bytes = outputFile.contents.byteLength;
  if (!quiet) writeLine(process.stdout, describeSuccess({ bytes, inputCount, dev }));
  if (dev) {
    writeLine(
      process.stderr,
      'esbuild.agent: this is a --dev build. Re-run without --dev before ' +
        'copying it into the extension, committing, or comparing hashes.',
    );
  }

  return { code: EXIT_OK, bytes, inputCount, violations: [] };
}

/**
 * Build the agent once.
 *
 * @param {{ dev?: boolean, quiet?: boolean, packageRoot?: string }} [options]
 * @returns {Promise<number>} exit code: 0 when the artifact was written and
 *   passed the audit, 1 when esbuild reported errors or the audit rejected it
 * @throws {AgentBuildError} exit code 2 — nothing was built — when the entry
 *   point is missing or not a regular file
 */
export async function buildAgent({ dev = false, quiet = false, packageRoot = PACKAGE_ROOT } = {}) {
  await assertEntryExists({ packageRoot });
  await ensureOutputDirectory({ packageRoot });

  try {
    const result = await esbuild.build(createBuildOptions({ dev, packageRoot }));
    const report = await reportResult(result, { dev, quiet, packageRoot });
    return report.code;
  } catch (error) {
    return await reportBuildException(error);
  }
}

/**
 * Build the agent and keep rebuilding on change, re-running the import-boundary
 * audit after every rebuild. Resolves when the process is interrupted.
 *
 * The audit lives in an `onEnd` callback rather than around `ctx.rebuild()`, so
 * it covers the initial build and every file-change rebuild through one path.
 * A failure prints and the watcher stays up: the next save is the fix.
 *
 * @param {{ dev?: boolean, quiet?: boolean, packageRoot?: string }} [options]
 * @returns {Promise<number>} exit code of the last completed rebuild: because a
 *   failure does not end the session, the code reported on stop is the last
 *   state before Ctrl-C — 0 when the final rebuild built and passed the audit, 1
 *   when it did not. That is what keeps `--watch` honest for anyone who scripts
 *   it, and it matches `esbuild.node.mjs`.
 * @throws {AgentBuildError} exit code 2 — nothing was built — when the entry
 *   point is missing or not a regular file, which is checked before the watcher
 *   starts
 */
export async function watchAgent({ dev = false, quiet = false, packageRoot = PACKAGE_ROOT } = {}) {
  await assertEntryExists({ packageRoot });
  await ensureOutputDirectory({ packageRoot });

  // Overwritten by every rebuild, so it carries the outcome of the most recent
  // one rather than the worst or the first. Declared out here because the plugin
  // below writes it and the value is read after the context is disposed.
  let lastExitCode = EXIT_OK;

  const options = createBuildOptions({ dev, packageRoot });
  /** @type {import("esbuild").Plugin} */
  const auditOnEnd = {
    name: 'debuggen-agent-audit',
    setup(build) {
      build.onEnd(async (result) => {
        const report = await reportResult(result, { dev, quiet, packageRoot });
        lastExitCode = report.code;
      });
    },
  };

  const context = await esbuild.context({
    ...options,
    plugins: [...(options.plugins ?? []), auditOnEnd],
  });

  try {
    await context.watch();
    writeLine(
      process.stderr,
      `esbuild.agent: watching ${ENTRY_REL} and its imports; Ctrl-C to stop`,
    );

    await new Promise((resolve) => {
      const stop = () => {
        resolve(undefined);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    await context.dispose();
  }

  // Read after dispose(), which drains an in-flight rebuild's onEnd: a Ctrl-C
  // landing mid-rebuild must still report that rebuild's outcome.
  return lastExitCode;
}

/**
 * Report a thrown build failure. esbuild rejects with an error carrying
 * `errors`/`warnings` arrays; anything else is a genuine defect in this script
 * or a broken esbuild install, and is printed with its stack.
 *
 * @param {unknown} error
 * @returns {Promise<number>} exit code
 */
async function reportBuildException(error) {
  const failure =
    /** @type {{ errors?: import("esbuild").Message[], warnings?: import("esbuild").Message[] }} */ (
      error
    );

  if (Array.isArray(failure.errors)) {
    const warnings = await formatDiagnostics(failure.warnings ?? [], 'warning');
    if (warnings !== '') writeLine(process.stderr, warnings);

    const text = await formatDiagnostics(failure.errors, 'error');
    if (text !== '') writeLine(process.stderr, text);
    writeLine(
      process.stderr,
      `esbuild.agent: build failed with ${failure.errors.length} ` +
        `${failure.errors.length === 1 ? 'error' : 'errors'}; ${OUTFILE_REL} was not written`,
    );
    return EXIT_FAILURE;
  }

  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeLine(process.stderr, `esbuild.agent: unexpected failure\n${detail}`);
  return EXIT_FAILURE;
}

/**
 * Report an {@link AgentBuildError} (or anything else that escaped), returning
 * the exit code the CLI should use.
 *
 * @param {unknown} error
 * @returns {number}
 */
function reportFailure(error) {
  if (error instanceof AgentBuildError) {
    writeLine(process.stderr, `esbuild.agent: ${error.message}`);
    if (error.hint !== undefined) writeLine(process.stderr, `\n${error.hint}`);
    if (error.showUsage) writeLine(process.stderr, `\n${usage()}`);
    return error.exitCode;
  }

  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeLine(process.stderr, `esbuild.agent: unexpected failure\n${detail}`);
  return EXIT_FAILURE;
}

/**
 * CLI entry point.
 *
 * @param {readonly string[]} [argv] arguments after the script path
 * @returns {Promise<number>} exit code, on the convention this script shares
 *   with `esbuild.node.mjs`: 0 success (the artifact was written and the audit
 *   passed) or `--help`; 1 the build ran and its result was rejected (esbuild
 *   errors, a rejected audit, or an unexpected failure); 2 nothing was built
 *   (the argument list was not understood, or the entry point is missing or not
 *   a regular file)
 */
export async function main(argv = process.argv.slice(2)) {
  /** @type {AgentBuildOptions} */
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
    return options.watch
      ? await watchAgent({ dev: options.dev, quiet: options.quiet })
      : await buildAgent({ dev: options.dev, quiet: options.quiet });
  } catch (error) {
    return reportFailure(error);
  }
}

/**
 * Resolve the process entry path, following symlinks where possible so it can be
 * compared with `import.meta.url` (which Node reports as a real path).
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
 * Whether this module is the process entry point, so importing it — from a test
 * or from another build script — never runs the CLI.
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return pathToFileURL(resolveEntryPath(entry)).href === import.meta.url;
}

if (isEntryPoint()) {
  process.exitCode = await main();
}
