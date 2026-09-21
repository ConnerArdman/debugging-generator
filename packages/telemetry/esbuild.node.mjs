#!/usr/bin/env node
/**
 * esbuild.node — bundle the Node dev-server preload of `@debuggen/telemetry`
 * into `dist/node/register.mjs`.
 *
 * WHAT THE ARTEFACT IS: one ESM module that is loaded into the *developer's own*
 * dev-server process with `NODE_OPTIONS=--import <file:// URL>` before the
 * framework starts. Inside that process it registers a tracer provider — which
 * is what makes Next.js's own spans (`BaseServer.handleRequest`,
 * `executing api route (app)`, `fetch`) reach us without a single edit to the
 * target project's source — registers the Prisma and pg instrumentations,
 * installs the `globalThis.__DEBUGGEN__` span helper that patched functions
 * call, and posts batches to `DEBUGGEN_INGEST_URL`. None of that behaviour is
 * decided here: `src/node/**` owns it, and this file only decides how it is
 * bundled.
 *
 * WHY THE OUTPUT PATH IS A CONTRACT, NOT A PREFERENCE: three consumers name it.
 *   - `scripts/dev-instrumented.mjs` resolves
 *     `packages/telemetry/dist/node/register.mjs` (its `PRELOAD_REL`) and passes
 *     that file's `file://` URL to `--import`.
 *   - `apps/local-service/src/dev-server/launcher.ts` attaches the same module
 *     through this package's `./node/register` export condition when it spawns
 *     the target project.
 *   - `package.json` maps `"./node/register"` to `./dist/node/register.mjs` and
 *     names exactly that file under `sideEffects`.
 * The `.mjs` extension is equally load-bearing: the preload is loaded from
 * inside somebody else's project, so the nearest `package.json` is theirs, and
 * only the extension guarantees Node parses the file as ESM. Both halves of that
 * contract are re-checked on every build by `verifyPackageContract` below, so a
 * manifest edit and this file can never drift apart silently.
 *
 * THE EXTERNALISATION POLICY — the part that makes or breaks instrumentation.
 * Three groups, each enforced in code rather than in a comment:
 *
 *   1. The target application's own modules (`pg`, `@prisma/client`, `next`,
 *      `react`, …) are never bundled. `@opentelemetry/instrumentation-pg` and
 *      `@prisma/instrumentation` work by patching the module instances the
 *      developer's app actually loaded; a copy bundled in here would be a
 *      second, unused module graph and not one database span would ever appear.
 *   2. The module-hooking machinery (`import-in-the-middle`,
 *      `require-in-the-middle`, `shimmer`) and the OpenTelemetry SDK stay
 *      external. The hooking libraries register Node loader hooks and patch
 *      `Module._load`, which requires them to exist as real, resolvable
 *      on-disk modules; bundling them breaks ESM hooking silently. Keeping the
 *      SDK external guarantees exactly one copy of it owns the global registry
 *      in the process.
 *   3. This package's own `src/node/**` graph and `@debuggen/shared` (with its
 *      `nanoid` transitive) ARE inlined, so the preload keeps working when it is
 *      attached from outside the workspace and no pnpm symlink is in reach.
 *
 * Group 1 and 2 are not a size optimisation; they are the only configuration in
 * which the instrumentations can reach the developer's modules. The external
 * list is therefore derived from `package.json` `dependencies` rather than
 * hand-written (a new dependency cannot be forgotten), and the metafile is
 * audited after every build so a regression fails here instead of showing up as
 * "the trace has no server spans" three layers away.
 *
 * ON CARRYING OUR OWN `@opentelemetry/api`: the preload resolves the API package
 * from this workspace while Next.js loads the copy bundled inside itself. That
 * is fine and deliberate — the OTel JS global registry lives on `globalThis` and
 * is shared across copies of the same major version, which is exactly what lets
 * Next.js's default spans reach the provider this preload registers. It is also
 * why the target project needs no OpenTelemetry dependency of its own (and why
 * `apps/demo-app` declares none): Node resolves the bare specifiers left in this
 * bundle from the artefact's location upward — `packages/telemetry/node_modules`
 * first, then the repository root.
 *
 * DELIBERATELY NOT THIS FILE'S JOB:
 *   - the library bundle (`dist/index.js`) — `tsup.config.ts`;
 *   - the page-injected browser agent (`dist/browser-agent.iife.js`) —
 *     `esbuild.agent.mjs`;
 *   - the self-contained copy of the preload inside the packaged VSIX
 *     (`dist/telemetry/node/register.mjs`) — `apps/vscode-extension/esbuild.mjs`,
 *     a different build with different externals that must not change the path
 *     produced here;
 *   - starting a dev server, minting credentials or reading `.env`
 *     (`scripts/dev-instrumented.mjs` and the local service's launcher).
 *
 * Usage: `node esbuild.node.mjs [--watch]`, `pnpm --filter @debuggen/telemetry
 * build`, or `--help`.
 *
 * EXIT CODES, one convention shared with `esbuild.agent.mjs` — the other bundler
 * this package's one `build` script runs, so a wrapper or a CI step reads both
 * the same way:
 *   - 0 success (the artefact was written and the audit passed), or `--help`;
 *   - 1 the build ran and its result was rejected: esbuild reported errors, or
 *     the audit rejected the bundle — also the code an unexpected failure ends
 *     on;
 *   - 2 nothing was built: the argument list was not understood, or a
 *     precondition of the build does not hold (a required input missing,
 *     unusable or inconsistent).
 *
 * @module packages/telemetry/esbuild.node
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

/**
 * Absolute path of this package, derived from this module's own location rather
 * than from `process.cwd()`: the script runs from the package root under
 * `pnpm --filter`, from the repository root under `pnpm -r build`, and from a
 * developer's shell in either place. Every path below is resolved from here, so
 * all three produce byte-identical output.
 *
 * @type {string}
 */
export const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path of the repository root. Used to phrase messages in
 * repository-relative terms and to decide whether an audited bundle input came
 * from inside the checkout.
 *
 * @type {string}
 */
export const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');

/** The preload entry, package-relative. Owned by `src/node/register.ts`. */
export const ENTRY_REL = 'src/node/register.ts';

/**
 * The one artefact this script produces, package-relative. Changing it is a
 * change to the `exports` map, to `scripts/dev-instrumented.mjs` and to the
 * local service's launcher — never a change to this constant alone.
 */
export const OUTFILE_REL = 'dist/node/register.mjs';

/** The workspace's own compiler configuration, read by esbuild for the TS transform. */
export const TSCONFIG_REL = 'tsconfig.json';

/** The `exports` key that must resolve to {@link OUTFILE_REL}. */
export const EXPORT_CONDITION = './node/register';

/**
 * esbuild target. The runtime is pinned to Node 24.21.0 by the root
 * `package.json` `engines`, `.nvmrc` and `.node-version`, so nothing is
 * downlevelled and the emitted module stays close to the authored source — which
 * matters because these frames appear in the developer's own server logs.
 */
export const NODE_TARGET = 'node24';

/**
 * Workspace dependencies that are bundled INTO the preload instead of being left
 * as bare imports.
 *
 * `@debuggen/shared` is inlined so the artefact survives being attached from a
 * directory where the `@debuggen/*` symlinks are not resolvable (a packaged
 * extension, a project elsewhere on disk). Its own `nanoid` transitive comes
 * along for the same reason: `@debuggen/shared`'s bundle keeps `nanoid` external,
 * so it is resolved and inlined here, at the last build that can still see it.
 *
 * Every OTHER `workspace:` dependency is rejected by
 * {@link computeExternalPolicy} rather than silently externalised, because an
 * unresolvable `@debuggen/*` import inside a developer's dev server is a crash
 * at their startup, not a failure of ours.
 *
 * @type {readonly string[]}
 */
export const INLINED_WORKSPACE_DEPENDENCIES = Object.freeze(['@debuggen/shared']);

/**
 * Packages kept external ON TOP of everything in `dependencies`.
 *
 * None of these is a dependency of this package: they are the modules the
 * *target project* owns (`pg` and its two internal packages, Prisma, Next.js,
 * React) plus the module-hooking libraries that `@opentelemetry/instrumentation`
 * loads (`import-in-the-middle`, `require-in-the-middle`, `shimmer`). Listing
 * them costs nothing when `src/node/**` does not import them and prevents the
 * one regression that would disable instrumentation wholesale if it ever did:
 * a bundled second copy that the developer's app never loads.
 *
 * `react` / `react-dom` are external here AND forbidden as imports by
 * {@link FORBIDDEN_IMPORT_PACKAGES}: the first rule makes accidental bundling
 * impossible, the second makes accidental *use* visible.
 *
 * @type {readonly string[]}
 */
export const EXTRA_EXTERNALS = Object.freeze([
  // The target application's database, ORM and framework modules.
  'pg',
  'pg-pool',
  'pg-protocol',
  '@prisma/client',
  'prisma',
  'next',
  'react',
  'react-dom',
  // Module-hooking machinery: must be real on-disk modules at runtime.
  'import-in-the-middle',
  'require-in-the-middle',
  'shimmer',
]);

/**
 * Packages whose presence as a bundle INPUT fails the build.
 *
 * This is the regression the externalisation policy exists to prevent, stated as
 * an assertion: if any of these ends up inside `register.mjs`, instrumentation
 * is patching a private copy nobody uses and every server or database span goes
 * missing — a failure that is invisible in the build log and expensive to
 * diagnose from a panel with a one-span trace.
 *
 * @type {readonly string[]}
 */
export const FORBIDDEN_INLINE_PACKAGES = Object.freeze([
  'pg',
  '@prisma/client',
  'next',
  'import-in-the-middle',
  'require-in-the-middle',
]);

/**
 * Packages the preload must not import at all, external or otherwise. These
 * belong to the page-injected browser agent (`src/browser/**`), which is a
 * different runtime and a different bundle; an import of one of them here means
 * a module boundary was crossed by accident.
 *
 * @type {readonly string[]}
 */
export const FORBIDDEN_IMPORT_PACKAGES = Object.freeze(['bippy', 'react', 'react-dom']);

/**
 * Package-relative directories that must never contribute a bundle input. The
 * browser agent runs in the developer's page at `document_start`; pulling any of
 * it into a module that runs inside their server process would ship DOM code to
 * Node and couple the two runtimes that `tsconfig.json` keeps apart.
 *
 * @type {readonly string[]}
 */
export const FORBIDDEN_INPUT_DIRECTORIES = Object.freeze(['src/browser']);

/**
 * Repository-relative directories that must never contribute a bundle input. The
 * packages sit below the apps in the acyclic workspace graph (AAP 0.2.2), so an
 * input under `apps/` is a layering violation regardless of which app it is.
 *
 * @type {readonly string[]}
 */
export const FORBIDDEN_INPUT_REPO_DIRECTORIES = Object.freeze(['apps']);

/** The build (and its audit) succeeded, or `--help` printed. */
const EXIT_OK = 0;

/**
 * The build ran and its result was rejected: esbuild reported errors, or the
 * audit rejected the bundle. An unexpected failure ends here too. Nothing
 * shipped.
 */
const EXIT_FAILURE = 1;

/**
 * Nothing was built: the argument list was not understood (an unknown flag, or a
 * flag given a value it does not take), or a precondition of the build does not
 * hold — a required input missing, unusable or inconsistent.
 */
const EXIT_USAGE = 2;

/**
 * Failure carrying the exit code the CLI should use and, where one exists, a
 * multi-line hint stating exactly how to recover. Mirrors the shape used by
 * `scripts/dev-instrumented.mjs` so both scripts fail the same way.
 *
 * `exitCode` defaults to {@link EXIT_FAILURE}, which is the code for a rejected
 * build result and for an unexpected failure. Every precondition failure passes
 * {@link EXIT_USAGE} explicitly — an unrecognised argument, and everything
 * {@link preflight} establishes before esbuild is asked to do anything — which
 * is the same classification `esbuild.agent.mjs` applies to the same class of
 * condition.
 */
export class PreloadBuildError extends Error {
  /**
   * @param {string} message single-line description of what went wrong
   * @param {{ hint?: string, showUsage?: boolean, exitCode?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'PreloadBuildError';
    /** @type {number} process exit code that corresponds to this failure */
    this.exitCode = options.exitCode ?? EXIT_FAILURE;
    /** @type {string | undefined} multi-line recovery instructions */
    this.hint = options.hint;
    /** @type {boolean} whether the CLI should print full usage as well */
    this.showUsage = options.showUsage === true;
  }
}

/**
 * Write one line to a stream. Used instead of `console`, which the lint baseline
 * declares no global for in `.mjs` files, and which would also blur the split
 * this script keeps deliberate: the build report on stdout, every diagnostic on
 * stderr.
 *
 * @param {import('node:stream').Writable} stream
 * @param {string} text
 * @returns {void}
 */
function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

/**
 * Normalise a path for comparison and display so the audit and the report read
 * the same on every platform. esbuild already reports POSIX-ish paths in the
 * metafile; `path.relative` on Windows would not.
 *
 * @param {string} value
 * @returns {string}
 */
function toPosix(value) {
  return value.split(path.sep).join('/').split('\\').join('/');
}

/**
 * Human-readable byte count, decimal units to match what editors and bundler
 * reports show. Deterministic for a given input, so it is safe in a log a
 * reviewer compares across builds.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1000) return `${bytes} B`;
  const kilobytes = bytes / 1000;
  if (kilobytes < 1000) return `${kilobytes.toFixed(1)} kB`;
  return `${(kilobytes / 1000).toFixed(2)} MB`;
}

/**
 * Render an absolute path relative to the repository root when it is inside it,
 * and absolute when it is not.
 *
 * @param {string} absolute
 * @returns {string}
 */
function displayPath(absolute) {
  const relative = path.relative(REPO_ROOT, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return toPosix(absolute);
  }
  return toPosix(relative);
}

/**
 * Whether an error is a Node filesystem error with the given code.
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
 * One-line description of an unknown thrown value, for messages that quote a
 * cause without dumping a stack.
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeCause(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Full `--help` text. It documents the artefact, the two flags, the exit codes
 * and — because this is where a reviewer looks first — the externalisation
 * policy that the audit enforces.
 *
 * @returns {string}
 */
export function usage() {
  return `esbuild.node — build the Node dev-server preload of @debuggen/telemetry

Usage
  node esbuild.node.mjs [--watch]
  node esbuild.node.mjs --help

  pnpm --filter @debuggen/telemetry build    runs tsup, esbuild.agent.mjs and this

What it produces
  ${OUTFILE_REL}
      the module a dev server loads with NODE_OPTIONS=--import <file:// URL>
  ${OUTFILE_REL}.map
      external source map with the sources embedded, beside the artefact

  Built from ${ENTRY_REL}, as ESM, for ${NODE_TARGET}, unminified and with
  names kept: this code runs inside the developer's server process, so its
  frames show up in their logs and in our own span names.

Externalisation policy (audited after every build)
  external   every entry of package.json "dependencies" except
             ${INLINED_WORKSPACE_DEPENDENCIES.join(', ')}, plus the target
             project's own modules and the module-hooking libraries:
             ${EXTRA_EXTERNALS.join(', ')}
  inlined    ${ENTRY_REL}'s own graph under src/node/**, plus
             ${INLINED_WORKSPACE_DEPENDENCIES.join(', ')} and its transitives
  audit      fails the build if ${FORBIDDEN_INLINE_PACKAGES.join(', ')} is
             bundled, if an input comes from ${FORBIDDEN_INPUT_DIRECTORIES.join(', ')}/
             or ${FORBIDDEN_INPUT_REPO_DIRECTORIES.join(', ')}/, if the preload
             imports ${FORBIDDEN_IMPORT_PACKAGES.join(', ')}, or if a bundled
             CommonJS module needs a require() shim

  The instrumentations patch the module instances the developer's app loaded. A
  bundled copy of pg or Prisma is a second module graph nobody uses, and every
  server and database span silently disappears — which is why that regression
  fails here rather than in a panel.

Options
  --watch       rebuild on change (esbuild watch), re-running the same audit
                after each rebuild; Ctrl-C stops
  --help, -h    print this text

Configuration
  None. The build reads no environment variable and bakes in no value, so its
  output depends only on the sources. The preload reads DEBUGGEN_INGEST_URL,
  DEBUGGEN_TOKEN, DEBUGGEN_PROJECT_ROOT and the optional NEXT_OTEL_VERBOSE at
  runtime, in the dev-server process, never at build time.

Exit codes (the same three esbuild.agent.mjs uses, so the pair this package's
build script runs reads consistently)
  ${EXIT_OK}   success: ${OUTFILE_REL} was written and passed the audit, or --help
  ${EXIT_FAILURE}   the build ran and its result was rejected: esbuild reported errors, or the
      audit rejected the bundle — also the code an unexpected failure ends on
  ${EXIT_USAGE}   nothing was built: the argument list was not understood, or a precondition
      of the build does not hold — ${ENTRY_REL} or ${TSCONFIG_REL} missing,
      package.json disagreeing with the artefact this script writes, or an
      inlined workspace dependency that has to be built first`;
}

/**
 * @typedef {object} PreloadBuildArgs
 * @property {boolean} help print usage and exit
 * @property {boolean} watch stay resident and rebuild on change
 */

/**
 * Parse argv (already stripped of `node` and the script path).
 *
 * Unknown flags are a usage error rather than something forwarded to esbuild:
 * this script owns every option of the build on purpose, so that the artefact a
 * developer produces locally is the artefact CI produces.
 *
 * @param {readonly string[]} argv
 * @returns {PreloadBuildArgs}
 * @throws {PreloadBuildError} exit 2 on an unknown or malformed flag
 */
export function parseArgs(argv) {
  /** @type {PreloadBuildArgs} */
  const args = { help: false, watch: false };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--watch' || arg === '-w') {
      args.watch = true;
      continue;
    }
    throw new PreloadBuildError(`unrecognised argument: ${arg}`, {
      showUsage: true,
      exitCode: EXIT_USAGE,
    });
  }

  return args;
}

/**
 * Read and parse a `package.json`.
 *
 * @param {string} file absolute path
 * @param {string} label how to name the file in a failure message
 * @returns {Record<string, unknown>}
 * @throws {PreloadBuildError} when the file is missing or not valid JSON
 */
function readManifest(file, label) {
  /** @type {string} */
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      throw new PreloadBuildError(`${label} is missing: ${displayPath(file)}`, {
        exitCode: EXIT_USAGE,
        hint: 'Run `pnpm install` from the repository root and try again.',
      });
    }
    throw new PreloadBuildError(
      `could not read ${label} (${displayPath(file)}): ${describeCause(error)}`,
      { exitCode: EXIT_USAGE },
    );
  }

  try {
    return /** @type {Record<string, unknown>} */ (JSON.parse(text));
  } catch (error) {
    throw new PreloadBuildError(
      `${label} is not valid JSON (${displayPath(file)}): ${describeCause(error)}`,
      { exitCode: EXIT_USAGE },
    );
  }
}

/**
 * Resolve one `exports` value down to a single path, accepting the plain-string
 * form this package uses for `./node/register` and the conditional-object form
 * used elsewhere. `import` is preferred over `default` because both consumers of
 * a `@debuggen/*` package load it as ESM.
 *
 * @param {unknown} value an `exports` entry
 * @returns {string | undefined} the path it resolves to, if any
 */
export function resolveExportsPath(value) {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const conditions = /** @type {Record<string, unknown>} */ (value);
  for (const condition of ['node', 'import', 'module', 'default']) {
    const candidate = conditions[condition];
    if (typeof candidate === 'string') return candidate;
    if (typeof candidate === 'object' && candidate !== null) {
      const nested = resolveExportsPath(candidate);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/**
 * Fail the build when this package's manifest no longer agrees with the artefact
 * this script writes.
 *
 * Two clauses matter, and both fail invisibly at runtime rather than at build
 * time if they drift:
 *   - `exports["./node/register"]` is how the local service's launcher names the
 *     preload. Pointing it elsewhere would leave the launcher attaching a file
 *     this script never writes.
 *   - `sideEffects` must list the artefact. The preload's whole purpose is its
 *     side effects (registering a provider, installing the span helper), and a
 *     bundler that is told the package is side-effect-free is entitled to drop
 *     the module wholesale — which is exactly what the VS Code extension's own
 *     esbuild step would do when it bundles its copy into the VSIX.
 *
 * @param {Record<string, unknown>} manifest this package's parsed manifest
 * @returns {void}
 * @throws {PreloadBuildError} on any disagreement
 */
export function verifyPackageContract(manifest) {
  const expected = `./${OUTFILE_REL}`;
  const exportsMap = manifest.exports;
  const declared =
    typeof exportsMap === 'object' && exportsMap !== null
      ? resolveExportsPath(/** @type {Record<string, unknown>} */ (exportsMap)[EXPORT_CONDITION])
      : undefined;

  if (declared === undefined) {
    throw new PreloadBuildError(
      `package.json does not export "${EXPORT_CONDITION}", which the local service uses to attach the preload`,
      {
        exitCode: EXIT_USAGE,
        hint: `Add:\n\n  "exports": { "${EXPORT_CONDITION}": "${expected}" }`,
      },
    );
  }
  if (declared !== expected) {
    throw new PreloadBuildError(
      `package.json exports "${EXPORT_CONDITION}" as ${declared}, but this script writes ${expected}`,
      {
        exitCode: EXIT_USAGE,
        hint: [
          'The preload path is a contract shared with scripts/dev-instrumented.mjs',
          '(PRELOAD_REL) and apps/local-service/src/dev-server/launcher.ts. Change all',
          'three together, or restore the manifest entry.',
        ].join('\n'),
      },
    );
  }

  const sideEffects = manifest.sideEffects;
  if (Array.isArray(sideEffects) && !sideEffects.includes(expected)) {
    throw new PreloadBuildError(
      `package.json "sideEffects" does not list ${expected}, so a bundler may tree-shake the preload away`,
      { exitCode: EXIT_USAGE, hint: `Add ${expected} to the "sideEffects" array.` },
    );
  }
}

/**
 * @typedef {object} ExternalPolicy
 * @property {string[]} packages bare package names kept external, sorted
 * @property {string[]} patterns the esbuild `external` array
 * @property {string[]} inlined workspace dependencies deliberately bundled in
 */

/**
 * Derive the external list from the manifest so the two cannot drift.
 *
 * Every `dependencies` entry is external except the workspace packages named in
 * {@link INLINED_WORKSPACE_DEPENDENCIES}; {@link EXTRA_EXTERNALS} is added on
 * top. Each package contributes two esbuild patterns — `name` and `name/*` —
 * because a bare `name` external does NOT cover a subpath import, and the
 * OpenTelemetry instrumentation loader reaches for exactly those
 * (`@opentelemetry/instrumentation/hook.mjs`).
 *
 * A `workspace:` dependency that is neither inlined nor explicitly external is
 * rejected: leaving one as a bare import would make the preload depend on a
 * pnpm symlink being resolvable from the developer's project, which is a crash
 * at their dev-server startup.
 *
 * @param {Record<string, unknown>} manifest this package's parsed manifest
 * @returns {ExternalPolicy}
 * @throws {PreloadBuildError} when a workspace dependency is unaccounted for
 */
export function computeExternalPolicy(manifest) {
  const dependencies =
    typeof manifest.dependencies === 'object' && manifest.dependencies !== null
      ? /** @type {Record<string, unknown>} */ (manifest.dependencies)
      : {};
  const names = Object.keys(dependencies);

  /** @type {Set<string>} */
  const external = new Set(EXTRA_EXTERNALS);
  /** @type {string[]} */
  const inlined = [];

  for (const name of names) {
    if (INLINED_WORKSPACE_DEPENDENCIES.includes(name)) {
      inlined.push(name);
      continue;
    }
    const range = dependencies[name];
    if (typeof range === 'string' && range.startsWith('workspace:') && !external.has(name)) {
      throw new PreloadBuildError(
        `workspace dependency ${name} is neither inlined nor explicitly external`,
        {
          exitCode: EXIT_USAGE,
          hint: [
            'The preload is attached to a process outside this workspace, where',
            `a bare "${name}" import may not resolve. Decide explicitly in`,
            'esbuild.node.mjs: add it to INLINED_WORKSPACE_DEPENDENCIES to bundle',
            'it in, or to EXTRA_EXTERNALS if it is genuinely resolvable at runtime.',
          ].join('\n'),
        },
      );
    }
    external.add(name);
  }

  for (const name of INLINED_WORKSPACE_DEPENDENCIES) {
    if (!names.includes(name)) {
      throw new PreloadBuildError(
        `${name} is configured to be bundled into the preload but is not a dependency of this package`,
        {
          exitCode: EXIT_USAGE,
          hint: [
            `Either add ${name} to package.json "dependencies", or remove it from`,
            'INLINED_WORKSPACE_DEPENDENCIES in esbuild.node.mjs.',
          ].join('\n'),
        },
      );
    }
  }

  const packages = [...external].sort();
  return {
    packages,
    patterns: packages.flatMap((name) => [name, `${name}/*`]),
    inlined: inlined.sort(),
  };
}

/**
 * Confirm that a workspace dependency which is bundled in has actually been
 * built, and point at the one command that fixes it when it has not.
 *
 * `pnpm -r build` runs workspaces in topological order, so this only trips when
 * a single package is built in isolation — which is common enough while
 * developing that a resolution error from esbuild ("Could not resolve
 * '@debuggen/shared'") is worth translating.
 *
 * Returns where the package really lives (following the pnpm symlink), because
 * that is how the build report tells an inlined workspace package apart from
 * this package's own sources: after resolution both are plain paths inside the
 * checkout.
 *
 * @param {string} name package name, e.g. `@debuggen/shared`
 * @returns {{ name: string, dir: string, entryFile: string }}
 * @throws {PreloadBuildError} when the package or its built entry is missing
 */
export function verifyInlinedDependencyBuilt(name) {
  const dependencyDir = path.join(PACKAGE_DIR, 'node_modules', ...name.split('/'));
  const buildHint = [
    `${name} is bundled into the preload, so it has to be built first:`,
    '',
    `  pnpm --filter ${name} build`,
    '',
    'or `pnpm -r build` from the repository root, which builds the workspaces in',
    'dependency order.',
  ].join('\n');

  if (!fs.existsSync(dependencyDir)) {
    throw new PreloadBuildError(`${name} is not installed under ${displayPath(dependencyDir)}`, {
      exitCode: EXIT_USAGE,
      hint: 'Run `pnpm install` from the repository root and try again.',
    });
  }

  const manifest = readManifest(path.join(dependencyDir, 'package.json'), `${name}'s package.json`);
  const entry =
    resolveExportsPath(
      typeof manifest.exports === 'object' && manifest.exports !== null
        ? /** @type {Record<string, unknown>} */ (manifest.exports)['.']
        : undefined,
    ) ?? (typeof manifest.main === 'string' ? manifest.main : undefined);

  if (entry === undefined) {
    throw new PreloadBuildError(`${name} declares no importable entry point`, {
      exitCode: EXIT_USAGE,
      hint: buildHint,
    });
  }

  const entryFile = path.resolve(dependencyDir, entry);
  if (!fs.existsSync(entryFile)) {
    throw new PreloadBuildError(
      `${name} has not been built: ${displayPath(entryFile)} is missing`,
      {
        exitCode: EXIT_USAGE,
        hint: buildHint,
      },
    );
  }

  /** @type {string} */
  let resolvedDir;
  try {
    resolvedDir = fs.realpathSync(dependencyDir);
  } catch {
    resolvedDir = dependencyDir;
  }
  return { name, dir: resolvedDir, entryFile };
}

/**
 * The package name a bundle input belongs to, or `undefined` for first-party
 * sources.
 *
 * Inputs are reported relative to `absWorkingDir`, and under pnpm they take the
 * store form `../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/index.js`,
 * so the name is whatever follows the LAST `node_modules` segment — one segment,
 * or two when the package is scoped.
 *
 * @param {string} input metafile input key
 * @returns {string | undefined}
 */
export function packageNameFromInput(input) {
  const segments = toPosix(input).split('/');
  const marker = segments.lastIndexOf('node_modules');
  if (marker === -1) return undefined;

  const first = segments[marker + 1];
  if (first === undefined || first === '') return undefined;
  if (!first.startsWith('@')) return first;

  const second = segments[marker + 2];
  return second === undefined || second === '' ? undefined : `${first}/${second}`;
}

/**
 * The package a bare import specifier resolves to, or `undefined` for a Node
 * builtin, a relative path or an absolute path.
 *
 * @param {string} specifier an import path from the metafile
 * @returns {string | undefined}
 */
export function packageNameFromSpecifier(specifier) {
  if (specifier === '' || specifier.startsWith('node:') || specifier.startsWith('.')) {
    return undefined;
  }
  if (path.isAbsolute(specifier) || specifier.startsWith('/')) return undefined;

  const segments = toPosix(specifier).split('/');
  const first = segments[0];
  if (first === undefined || first === '') return undefined;
  if (!first.startsWith('@')) return first;

  const second = segments[1];
  return second === undefined || second === '' ? undefined : `${first}/${second}`;
}

/**
 * Audit a build's metafile against the externalisation policy.
 *
 * Pure and dependency-free on purpose: it takes a metafile object and returns
 * findings, so the policy can be exercised against synthetic metafiles without
 * running a build. Every finding is a complete sentence naming the offending
 * path, because it is read by whoever broke the build months from now.
 *
 * @param {{ inputs?: Record<string, unknown>, outputs?: Record<string, { bytes?: number, imports?: { path: string, kind?: string, external?: boolean }[] }> }} metafile
 * @param {{ packageDir?: string, repoRoot?: string, outfileKey?: string }} [options]
 * @returns {string[]} one finding per violation; empty when the bundle is sound
 */
export function auditMetafile(metafile, options = {}) {
  const packageDir = options.packageDir ?? PACKAGE_DIR;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const outfileKey = options.outfileKey ?? OUTFILE_REL;

  /** @type {string[]} */
  const findings = [];
  const inputs = Object.keys(metafile.inputs ?? {});

  for (const input of inputs) {
    const packageName = packageNameFromInput(input);
    if (packageName !== undefined) {
      if (FORBIDDEN_INLINE_PACKAGES.includes(packageName)) {
        findings.push(
          `${input} was bundled, but ${packageName} must stay external: the instrumentations have to patch the module instance the developer's app loads, and a bundled copy silently produces no spans.`,
        );
      }
      // Anything else under node_modules is either deliberately inlined
      // (@debuggen/shared and its transitives) or first-party; the two
      // directory rules below are what police the rest.
      continue;
    }

    const absolute = path.resolve(packageDir, input);
    const fromPackage = toPosix(path.relative(packageDir, absolute));
    const offendingPackageDir = FORBIDDEN_INPUT_DIRECTORIES.find(
      (directory) => fromPackage === directory || fromPackage.startsWith(`${directory}/`),
    );
    if (offendingPackageDir !== undefined) {
      findings.push(
        `${input} was bundled from ${offendingPackageDir}/, which belongs to the page-injected browser agent: the preload runs in the developer's server process and must not carry DOM code.`,
      );
      continue;
    }

    const fromRepo = toPosix(path.relative(repoRoot, absolute));
    if (fromRepo.startsWith('..') || path.isAbsolute(fromRepo)) continue;
    const offendingRepoDir = FORBIDDEN_INPUT_REPO_DIRECTORIES.find(
      (directory) => fromRepo === directory || fromRepo.startsWith(`${directory}/`),
    );
    if (offendingRepoDir !== undefined) {
      findings.push(
        `${input} was bundled from ${offendingRepoDir}/, which sits above this package in the workspace graph: the preload may only depend on packages/**.`,
      );
    }
  }

  const outputs = Object.entries(metafile.outputs ?? {});
  if (outputs.length > 0 && !outputs.some(([file]) => toPosix(file) === toPosix(outfileKey))) {
    findings.push(
      `the build produced ${outputs.map(([file]) => file).join(', ')} but not ${outfileKey}, which is the path the package's exports map and the dev-server launcher name.`,
    );
  }

  for (const [file, output] of outputs) {
    if (toPosix(file).endsWith('.map')) continue;
    for (const imported of output.imports ?? []) {
      if (imported.external !== true) {
        findings.push(
          `${file} imports ${imported.path} from another chunk: the preload has to be a single self-contained module, so splitting must stay off.`,
        );
        continue;
      }
      const packageName = packageNameFromSpecifier(imported.path);
      if (packageName !== undefined && FORBIDDEN_IMPORT_PACKAGES.includes(packageName)) {
        findings.push(
          `${file} imports ${imported.path}, which belongs to the browser agent's runtime: the preload must not reach for it, externally or otherwise.`,
        );
      }
    }
  }

  return findings;
}

/**
 * Audit the emitted bundle text for a CommonJS dependency that needs `require`
 * at runtime.
 *
 * esbuild answers a dynamic `require()` inside a bundled CJS module by emitting
 * a shim that throws "Dynamic require of … is not supported" when it is called.
 * In a module loaded into somebody else's dev server that is a crash at an
 * arbitrary later moment, so it fails the build instead, with the two fixes
 * spelled out: externalise the dependency (almost always right for this
 * artefact) or add the standard `createRequire` banner.
 *
 * @param {string} text contents of the emitted bundle
 * @returns {string[]} one finding when a require shim is present
 */
export function auditBundleText(text) {
  if (!text.includes('Dynamic require of')) return [];
  return [
    "the bundle contains an esbuild require() shim, so a bundled CommonJS module needs `require` at runtime and would throw inside the developer's dev server. Externalise that dependency (add it to EXTRA_EXTERNALS), or give the build the standard interop banner:\n      banner: { js: 'import { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);' }",
  ];
}

/**
 * @typedef {object} BuildContext
 * @property {Record<string, unknown>} manifest this package's parsed manifest
 * @property {ExternalPolicy} policy the resolved externalisation policy
 * @property {string} entry absolute path of the entry point
 * @property {string} outfile absolute path of the artefact
 * @property {string} outfileKey the artefact's metafile key (package-relative)
 * @property {string} tsconfig absolute path of the compiler configuration
 * @property {{ name: string, dir: string }[]} inlinedRoots resolved directories
 *   of the workspace dependencies that are bundled in, for the build report
 */

/**
 * Everything that must hold before esbuild is asked to do anything: the
 * manifest agrees with this script, the external policy is derivable, the entry
 * point exists, every inlined workspace dependency has been built, and the
 * output directory exists.
 *
 * Deliberately synchronous. The whole point is that a prerequisite failure is
 * reported before a partial `dist/node/` can exist, and the ordering of a
 * handful of `stat` calls is not worth the indirection of promises.
 *
 * @returns {BuildContext}
 * @throws {PreloadBuildError} exit 2 with a recovery hint. Everything checked
 *   here is a precondition of the build — nothing has been built when one of
 *   them fails — so every throw below passes `exitCode: EXIT_USAGE`, and a check
 *   added to this function later follows that rule. The one exception is the
 *   `mkdir` at the end, which acts rather than checks; see the comment there.
 */
export function preflight() {
  const manifest = readManifest(
    path.join(PACKAGE_DIR, 'package.json'),
    "this package's package.json",
  );
  verifyPackageContract(manifest);
  const policy = computeExternalPolicy(manifest);

  const entry = path.join(PACKAGE_DIR, ...ENTRY_REL.split('/'));
  if (!fs.existsSync(entry)) {
    throw new PreloadBuildError(`the preload entry point is missing: ${ENTRY_REL}`, {
      exitCode: EXIT_USAGE,
      hint: [
        'This script bundles that module; it does not create it. src/node/register.ts',
        'is the preload itself (tracer provider, pg and Prisma instrumentations, the',
        'globalThis.__DEBUGGEN__ span helper and the ingest exporter) and has to exist',
        'before there is anything to bundle.',
      ].join('\n'),
    });
  }

  const tsconfig = path.join(PACKAGE_DIR, TSCONFIG_REL);
  if (!fs.existsSync(tsconfig)) {
    throw new PreloadBuildError(`${TSCONFIG_REL} is missing from ${displayPath(PACKAGE_DIR)}`, {
      exitCode: EXIT_USAGE,
      hint: 'esbuild reads the workspace tsconfig for the TypeScript transform; restore it before building.',
    });
  }

  /** @type {{ name: string, dir: string }[]} */
  const inlinedRoots = [];
  for (const name of policy.inlined) {
    const resolved = verifyInlinedDependencyBuilt(name);
    inlinedRoots.push({ name: resolved.name, dir: resolved.dir });
  }

  const outfile = path.join(PACKAGE_DIR, ...OUTFILE_REL.split('/'));
  try {
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
  } catch (error) {
    // Deliberately left at EXIT_FAILURE while every check above reports
    // EXIT_USAGE: this is the only step of preflight that acts rather than
    // checks, and the identical I/O failure in esbuild.agent.mjs's
    // ensureOutputDirectory escapes as a raw fs error that its generic handler
    // reports as exit 1. Reclassifying it here would make the pair disagree on a
    // failing mkdir immediately after being aligned on every missing input.
    throw new PreloadBuildError(
      `could not create ${path.posix.dirname(OUTFILE_REL)}/: ${describeCause(error)}`,
    );
  }

  return { manifest, policy, entry, outfile, outfileKey: OUTFILE_REL, tsconfig, inlinedRoots };
}

/**
 * The complete esbuild configuration. Stated option by option rather than left
 * to defaults, because a default that changes between esbuild releases would
 * change an artefact three other components load.
 *
 * Determinism is a property of this object: no `define`, no `banner`, no value
 * read from the environment and nothing derived from the clock, so two builds of
 * the same sources are byte-identical. Configuration reaches the preload at
 * runtime through `DEBUGGEN_INGEST_URL`, `DEBUGGEN_TOKEN` and
 * `DEBUGGEN_PROJECT_ROOT` — never through a build-time substitution.
 *
 * @param {BuildContext} context
 * @param {import('esbuild').Plugin[]} [plugins]
 * @returns {import('esbuild').BuildOptions}
 */
export function createBuildOptions(context, plugins = []) {
  return {
    // Anchors every relative path esbuild reports (metafile keys, messages) to
    // this package, independent of where the command was run from.
    absWorkingDir: PACKAGE_DIR,
    entryPoints: [context.entry],
    // `outfile`, not `outdir`: the ".mjs" extension is what makes Node treat the
    // artefact as ESM when it is loaded from inside a project whose own
    // package.json says nothing about it.
    outfile: context.outfile,
    bundle: true,
    format: 'esm',
    // Also what makes the `node:*` builtins external and selects the "node"
    // export condition of every inlined dependency.
    platform: 'node',
    target: [NODE_TARGET],
    external: [...context.policy.patterns],
    // External `.map` beside the artefact, with the sources embedded, so a
    // developer stepping into our frames inside their own process lands on the
    // TypeScript. `dist/` is git-ignored, so the map costs nothing in review.
    sourcemap: true,
    sourcesContent: true,
    // Readable output is worth the bytes here: these frames appear in the
    // developer's server logs and in our own span names, and `keepNames` keeps
    // function names intact for the `__DEBUGGEN__.span` wrappers.
    minify: false,
    keepNames: true,
    treeShaking: true,
    // One self-contained file. See the audit: a chunk import would break both
    // the `exports` map and the `--import` contract.
    splitting: false,
    tsconfig: context.tsconfig,
    metafile: true,
    // This script formats and prints every message itself, so esbuild stays
    // quiet; `logLimit: 0` means it reports all of them rather than the first
    // few.
    logLevel: 'silent',
    logLimit: 0,
    plugins,
  };
}

/**
 * Format esbuild messages the way esbuild would have printed them.
 *
 * @param {import('esbuild').Message[]} messages
 * @param {'error' | 'warning'} kind
 * @returns {Promise<string>} formatted text, empty when there are no messages
 */
async function formatMessages(messages, kind) {
  if (messages.length === 0) return '';
  // `color: false` keeps the output identical in a terminal, in a CI log and in
  // a captured build artefact.
  const formatted = await esbuild.formatMessages(messages, {
    kind,
    color: false,
    terminalWidth: 100,
  });
  return formatted.join('').trimEnd();
}

/**
 * Turn a thrown esbuild failure into this script's error type, preserving the
 * compiler's own diagnostics.
 *
 * @param {unknown} error
 * @returns {Promise<PreloadBuildError>}
 */
async function toBuildFailure(error) {
  const messages =
    typeof error === 'object' &&
    error !== null &&
    Array.isArray(/** @type {{ errors?: unknown }} */ (error).errors)
      ? /** @type {{ errors: import('esbuild').Message[] }} */ (error).errors
      : [];
  if (messages.length === 0) {
    return new PreloadBuildError(`the preload bundle failed to build: ${describeCause(error)}`);
  }
  return new PreloadBuildError('the preload bundle failed to build', {
    hint: await formatMessages(messages, 'error'),
  });
}

/**
 * Render the findings of a failed audit as a numbered list.
 *
 * @param {readonly string[]} findings
 * @returns {string}
 */
function renderFindings(findings) {
  return findings.map((finding, index) => `  ${index + 1}. ${finding}`).join('\n\n');
}

/**
 * The build report. Written for the reviewer who has to answer "did anything
 * get bundled that should not have been?" without reading the bundle: the size,
 * the number of inlined modules, the policy that was applied and — the part that
 * actually proves it — the bare imports the artefact kept.
 *
 * @param {BuildContext} context
 * @param {import('esbuild').Metafile} metafile
 * @returns {string}
 */
export function describeBuild(context, metafile) {
  const outputs = Object.entries(metafile.outputs ?? {});
  const bundle = outputs.find(([file]) => toPosix(file) === toPosix(context.outfileKey));
  const map = outputs.find(([file]) => toPosix(file) === `${toPosix(context.outfileKey)}.map`);

  const inputs = Object.keys(metafile.inputs ?? {});
  // An inlined workspace package resolves through its symlink to a real path
  // inside the checkout (`../shared/dist/index.js`), which no longer looks
  // different from this package's own sources — so it is matched by the
  // directory recorded at preflight, and only reported when it truly
  // contributed an input. Everything from a node_modules tree is named by its
  // package instead.
  const absoluteInputs = inputs.map((input) => path.resolve(PACKAGE_DIR, input));
  const workspaceInlined = context.inlinedRoots
    .filter(({ dir }) =>
      absoluteInputs.some((input) => input === dir || input.startsWith(`${dir}${path.sep}`)),
    )
    .map(({ name }) => name);
  const vendored = [
    ...new Set(
      inputs
        .map((input) => packageNameFromInput(input))
        .filter((name) => name !== undefined)
        .map((name) => /** @type {string} */ (name)),
    ),
  ].sort();
  const inlinedNames = [...workspaceInlined, ...vendored];

  /** @type {string[]} */
  const kept = [];
  for (const [file, output] of outputs) {
    if (toPosix(file).endsWith('.map')) continue;
    for (const imported of output.imports ?? []) {
      if (imported.external === true && !kept.includes(imported.path)) kept.push(imported.path);
    }
  }
  kept.sort();

  const lines = [
    `telemetry preload  ${context.outfileKey}  ${formatBytes(bundle?.[1].bytes ?? 0)}` +
      (map === undefined ? '' : `  (+ source map ${formatBytes(map[1].bytes ?? 0)})`),
    `  entry      ${ENTRY_REL} → ESM, ${NODE_TARGET}, unminified, names kept`,
    `  bundled    ${inputs.length} module(s) inlined: ${path.posix.dirname(ENTRY_REL)}/**` +
      (inlinedNames.length === 0 ? '' : ` + ${inlinedNames.join(', ')}`),
    `  external   ${context.policy.packages.length} package(s) kept resolvable at runtime:`,
  ];
  for (const name of context.policy.packages) {
    lines.push(`               ${name}`);
  }
  lines.push(
    `  imports    ${kept.length === 0 ? '(none)' : kept.join(', ')}`,
    '  audit      no forbidden input, no chunk import, no require() shim',
  );
  return lines.join('\n');
}

/**
 * Audit a completed build and print its report.
 *
 * @param {BuildContext} context
 * @param {import('esbuild').BuildResult} result
 * @returns {Promise<string[]>} findings; empty when the build is acceptable
 */
async function reviewBuild(context, result) {
  const warnings = await formatMessages(result.warnings ?? [], 'warning');
  if (warnings !== '') writeLine(process.stderr, warnings);

  const metafile = result.metafile;
  if (metafile === undefined) {
    return ['esbuild returned no metafile, so the externalisation policy could not be audited.'];
  }

  /** @type {string[]} */
  const findings = [
    ...auditMetafile(metafile, {
      packageDir: PACKAGE_DIR,
      repoRoot: REPO_ROOT,
      outfileKey: context.outfileKey,
    }),
  ];

  try {
    findings.push(...auditBundleText(fs.readFileSync(context.outfile, 'utf8')));
  } catch (error) {
    findings.push(
      `${context.outfileKey} could not be read back for auditing: ${describeCause(error)}`,
    );
  }

  if (findings.length === 0) writeLine(process.stdout, describeBuild(context, metafile));
  return findings;
}

/**
 * Build once.
 *
 * Reached only after {@link preflight} has passed, so every failure from here on
 * is a rejected build result rather than a precondition: this function never
 * reports {@link EXIT_USAGE}.
 *
 * @param {BuildContext} context
 * @returns {Promise<number>} process exit code: 0 when the artefact was written
 *   and passed the audit, 1 when esbuild reported errors or the audit rejected
 *   the bundle
 */
async function runOnce(context) {
  /** @type {import('esbuild').BuildResult} */
  let result;
  try {
    result = await esbuild.build(createBuildOptions(context));
  } catch (error) {
    throw await toBuildFailure(error);
  }

  const findings = await reviewBuild(context, result);
  if (findings.length > 0) {
    throw new PreloadBuildError(
      `the preload bundle violates the externalisation policy (${findings.length} finding${findings.length === 1 ? '' : 's'})`,
      { hint: renderFindings(findings) },
    );
  }
  return EXIT_OK;
}

/**
 * @typedef {object} StopSignal
 * @property {Promise<string>} promise resolves with the signal that arrived
 * @property {() => void} release detach the handlers
 */

/**
 * Listen for Ctrl-C (`SIGINT`) and `SIGTERM` from the moment watch mode starts.
 *
 * Installed *before* the first build rather than after it, which is the whole
 * point of pulling this out: a signal that arrives while the handlers are not
 * yet attached takes Node's default disposition and kills the process outright,
 * so a Ctrl-C during a slow first build would skip the clean shutdown below.
 * Under load that window is seconds wide, and it was observed.
 *
 * @returns {StopSignal}
 */
function listenForStop() {
  /** @type {(signal: string) => void} */
  let settle = () => undefined;
  /** @type {((signal: string) => void) | undefined} */
  let handler;

  const promise = new Promise((resolve) => {
    settle = resolve;
  });

  handler = (signal) => {
    settle(signal);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);

  return {
    promise,
    release: () => {
      if (handler === undefined) return;
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
      handler = undefined;
    },
  };
}

/**
 * Build and stay resident, rebuilding on change and re-running the same audit
 * every time.
 *
 * A failure does not end the session: a developer fixing an import wants the
 * next save to be re-checked, so findings are printed and watching continues.
 * The exit code therefore reflects the last state before Ctrl-C, which keeps
 * `--watch` honest for anyone who scripts it.
 *
 * @param {BuildContext} context
 * @returns {Promise<number>} process exit code of the last completed rebuild — 0
 *   when the final rebuild built and passed the audit, 1 when it did not — which
 *   is what `esbuild.agent.mjs`'s `watchAgent` reports for the same situation
 */
async function runWatch(context) {
  let lastExitCode = EXIT_OK;
  const stop = listenForStop();

  /** @type {import('esbuild').Plugin} */
  const auditPlugin = {
    name: 'debuggen-preload-audit',
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors.length > 0) {
          writeLine(process.stderr, await formatMessages(result.errors, 'error'));
          lastExitCode = EXIT_FAILURE;
          return;
        }
        const findings = await reviewBuild(context, result);
        if (findings.length > 0) {
          writeLine(
            process.stderr,
            `esbuild.node: the preload bundle violates the externalisation policy\n\n${renderFindings(findings)}`,
          );
          lastExitCode = EXIT_FAILURE;
          return;
        }
        lastExitCode = EXIT_OK;
      });
    },
  };

  /** @type {import('esbuild').BuildContext} */
  let buildContext;
  try {
    buildContext = await esbuild.context(createBuildOptions(context, [auditPlugin]));
  } catch (error) {
    stop.release();
    throw await toBuildFailure(error);
  }

  try {
    await buildContext.watch();
    writeLine(process.stdout, `  watching   ${ENTRY_REL} and its imports; Ctrl-C to stop`);

    const signal = await stop.promise;
    writeLine(process.stdout, `  stopping   ${signal} received`);
  } finally {
    // Release the handlers only once the esbuild context is gone, so a second
    // Ctrl-C during shutdown still reaches this process rather than the default
    // disposition, and never leaves the watcher's child process behind.
    await buildContext.dispose();
    stop.release();
  }

  return lastExitCode;
}

/**
 * Print a failure and return the exit code it maps to.
 *
 * @param {unknown} error
 * @returns {number}
 */
function reportFailure(error) {
  if (error instanceof PreloadBuildError) {
    writeLine(process.stderr, `esbuild.node: ${error.message}`);
    if (error.hint !== undefined) writeLine(process.stderr, `\n${error.hint}`);
    if (error.showUsage) writeLine(process.stderr, `\n${usage()}`);
    return error.exitCode;
  }

  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeLine(process.stderr, `esbuild.node: unexpected failure\n${detail}`);
  return EXIT_FAILURE;
}

/**
 * CLI entry point.
 *
 * @param {readonly string[]} [argv] arguments after the script path
 * @returns {Promise<number>} process exit code, on the convention this script
 *   shares with `esbuild.agent.mjs`: 0 success (the artefact was written and the
 *   audit passed) or `--help`; 1 the build ran and its result was rejected
 *   (esbuild errors, a rejected audit, or an unexpected failure); 2 nothing was
 *   built (the argument list was not understood, or a precondition {@link
 *   preflight} checks does not hold)
 */
export async function main(argv = process.argv.slice(2)) {
  /** @type {PreloadBuildArgs} */
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return reportFailure(error);
  }

  if (args.help) {
    writeLine(process.stdout, usage());
    return EXIT_OK;
  }

  try {
    const context = preflight();
    return args.watch ? await runWatch(context) : await runOnce(context);
  } catch (error) {
    return reportFailure(error);
  }
}

/**
 * Whether this module is the process entry point, so importing it (from a test
 * or another build script) never starts a build.
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return false;
  /** @type {string} */
  let resolved;
  try {
    resolved = fs.realpathSync(entry);
  } catch {
    resolved = path.resolve(entry);
  }
  return path.resolve(fileURLToPath(import.meta.url)) === resolved;
}

if (isEntryPoint()) {
  // `process.exitCode` rather than `process.exit()` so buffered stdout is
  // flushed before the process ends.
  process.exitCode = await main(process.argv.slice(2));
}
