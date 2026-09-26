#!/usr/bin/env node
/**
 * esbuild — build the Debug Generator VS Code extension host AND embed
 * everything the installed extension runs into `dist/`, which is what makes the
 * packaged VSIX self-contained (AAP 0.7.1 Group 3).
 *
 * TARGETS, all written under `apps/vscode-extension/dist/`:
 *
 *   1. host      `src/extension.ts` -> `dist/extension.js`. CommonJS, because
 *                VS Code loads `package.json#main` with `require`, and because
 *                this workspace's manifest declares no `"type": "module"`.
 *                Target `node20`: the extension host runs the Node that is
 *                embedded in the editor, not the repository's pinned Node 24,
 *                and `engines.vscode ^1.125.0` admits editors older than the
 *                one the test suite downloads. `vscode` is the ONLY external:
 *                every `@debuggen/*` package is ESM-only, so it must be inlined
 *                or the bundle throws `ERR_REQUIRE_ESM` at activation.
 *   2. service   `../local-service/src/main.ts` -> `dist/service/main.js`. The
 *                whole coordination service bundled from SOURCE as ESM for
 *                `node24`, every npm dependency and workspace package inlined
 *                (that workspace's own tsup build leaves all of them external,
 *                so copying its `dist/main.js` would need its `node_modules`).
 *                The store DDL is INLINED, never shipped as a file:
 *                `apps/local-service/src/store/schema.sql` is substituted as
 *                one JSON string literal for the build-time identifier
 *                {@link EMBEDDED_SCHEMA_SQL_IDENTIFIER} (esbuild `define`),
 *                which that workspace's `src/store/db.ts` reads through
 *                `embeddedSchemaSql()` and its `main()` hands to
 *                `startService({ inlineSchemaSql })`, so the installed service
 *                migrates its store without reading a `.sql` file. The build
 *                proves it: the identifier must be gone from the bundle, the
 *                DDL's text must be in it, and no `*.sql` file may exist
 *                under `dist/service/`, which is removed and rebuilt as a
 *                whole on every run (it is wholly this script's output, so
 *                nothing stale survives `--no-clean` or `--watch`).
 *                Beside the bundle: `dist/service/package.json` =
 *                `{"type":"module"}` (the bundle relies on `import.meta.url`
 *                and this workspace is CommonJS) and the versioned prompt tree
 *                copied verbatim to `dist/service/prompts/` (the host passes
 *                that directory as `DEBUGGEN_PROMPTS_DIR`).
 *   3. preload   `packages/telemetry/dist/node/register.mjs` (+ its `.map`)
 *                copied byte for byte, SHA-256 verified, to
 *                `dist/telemetry/node/register.mjs` — the path the service's
 *                dev-server launcher probes first (`../telemetry/node/register.mjs`
 *                beside the service bundle). `packages/telemetry/esbuild.node.mjs`
 *                owns that artefact and deliberately keeps the OpenTelemetry
 *                SDK, the instrumentations and the module-hooking libraries
 *                EXTERNAL (hooking only works on real on-disk modules, and one
 *                SDK copy must own the global registry). A byte-for-byte copy
 *                therefore resolves nothing on its own inside an installed
 *                extension, so this script also vendors the preload's runtime
 *                dependency closure — dereferenced out of pnpm's store,
 *                nested exactly where Node's resolver needs a second version,
 *                TypeScript sources, declarations and source maps left out —
 *                into `dist/telemetry/node_modules/`, and in production proves
 *                in a child process that every module the preload loads
 *                resolves inside `dist/telemetry/`. `.vscodeignore` must keep
 *                that directory: `vsce --no-dependencies` skips only the
 *                top-level `node_modules/`, never one nested under `dist/`.
 *   4. tests     (`--tests`) every `test/suite/**` `*.test.ts` ->
 *                `dist/test/suite/<name>.test.js`, CommonJS for `node20`, one
 *                bundle per suite so `.vscode-test.mjs` can glob
 *                `dist/test/suite/**` `*.test.js`. Packages this workspace or
 *                the repository root declares stay external (the suite runs
 *                in place, beside `node_modules`); `@debuggen/*` and whatever
 *                they import are inlined, for the same ESM-only reason as the
 *                host; `vscode` and `mocha` come from the test runner.
 *                Beside them, `test/probe/installed-extension-probe.ts` ->
 *                `dist/test/probe/installed-extension-probe.js`: the companion
 *                extension the packaged-VSIX suite copies out of the workspace
 *                and loads beside the INSTALLED extension in an isolated
 *                window. It runs where no `node_modules` exists, so it is
 *                bundled like the host — CommonJS, `node20`, only `vscode`
 *                external, everything else inlined — and audited the same way.
 *                `.vscode-test.mjs` globs `dist/test/suite/` only, so the probe
 *                is never run as a suite.
 *
 * These directory names are a contract with `src/extension.ts` (which resolves
 * every embedded path from `context.extensionUri`), `src/service/process.ts`,
 * the service's dev-server launcher, `.vscodeignore` and `.vscode-test.mjs`;
 * change one only together with the others.
 *
 * `--package` stages what `vsce` needs before it collects files (package.json
 * runs `node esbuild.mjs --production --package` as `vscode:prepublish`): a
 * copy of the repository-root `LICENSE` at the extension root — vsce has no
 * non-interactive way past a missing license and prompts, which aborts off a
 * TTY — plus a check that `media/icon.png` is a real PNG, then the artefact
 * verification. The staged `LICENSE` is a generated copy; the root file stays
 * the single source of truth.
 *
 * ORDER WITH VITE: `build` is `node esbuild.mjs --production && vite build`.
 * This script removes `dist/` first (unless `--no-clean` or `--watch`), then
 * Vite writes `dist/webview/` with an `emptyOutDir` scoped to that directory,
 * so the webview is never verified here and never deleted by Vite's run.
 *
 * DETERMINISM AND HYGIENE: every path is resolved from this module's location,
 * never from the working directory; esbuild runs with `absWorkingDir` fixed to
 * this workspace, so the path comments and source-map `sources` it emits are
 * relative and identical on every machine; production maps omit
 * `sourcesContent`; nothing is timestamped, downloaded or read from the
 * environment beyond `process.execPath`. No credential is read, printed or
 * embedded: the service mints and reads `$DEBUGGEN_HOME/auth.json` at run time.
 *
 * Usage: `node esbuild.mjs [--production] [--watch] [--tests] [--package]
 * [--no-clean]`, or `--help`.
 *
 * EXIT CODES, the convention `packages/telemetry/esbuild.node.mjs` uses:
 *   - 0 success, or `--help`;
 *   - 1 a build ran and was rejected: esbuild errors, a production warning,
 *     an externals audit or an artefact verification failed, or an unexpected
 *     failure;
 *   - 2 nothing could be built: the arguments were not understood, or a
 *     required input (entry point, prompt tree, DDL, preload artefact, root
 *     `LICENSE`, icon) is missing or unusable.
 *
 * @module apps/vscode-extension/esbuild
 */

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import esbuild from 'esbuild';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Absolute path of this workspace, derived from this module's own location:
 * pnpm runs the script from the workspace under `pnpm --filter`, from the
 * repository root under `pnpm -r build`, and a developer may run it from
 * either, so a cwd-relative path would resolve differently per invocation.
 *
 * @type {string}
 */
export const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the repository root (two levels above this workspace). */
export const REPO_ROOT = path.resolve(EXTENSION_DIR, '..', '..');

/** The output directory this script owns, except `dist/webview/` (Vite's). */
export const DIST_DIR = path.join(EXTENSION_DIR, 'dist');

/** Extension-relative POSIX paths of every artefact, for messages and checks. */
export const LAYOUT = Object.freeze({
  hostEntry: 'src/extension.ts',
  hostOut: 'dist/extension.js',
  serviceOut: 'dist/service/main.js',
  serviceManifest: 'dist/service/package.json',
  servicePrompts: 'dist/service/prompts',
  preloadOut: 'dist/telemetry/node/register.mjs',
  preloadVendor: 'dist/telemetry/node_modules',
  testSuiteSrc: 'test/suite',
  testSuiteOut: 'dist/test/suite',
  testProbeSrc: 'test/probe/installed-extension-probe.ts',
  testProbeOut: 'dist/test/probe/installed-extension-probe.js',
  stagedLicense: 'LICENSE',
  icon: 'media/icon.png',
});

/** Repository-relative POSIX paths of the inputs owned by other workspaces. */
export const INPUTS = Object.freeze({
  serviceEntry: 'apps/local-service/src/main.ts',
  prompts: 'apps/local-service/prompts',
  schema: 'apps/local-service/src/store/schema.sql',
  preload: 'packages/telemetry/dist/node/register.mjs',
  license: 'LICENSE',
});

/**
 * The build-time identifier the service bundle's store DDL is substituted for
 * (esbuild `define`). A contract with `apps/local-service/src/store/db.ts`,
 * which declares it and reads it through `embeddedSchemaSql()`; rename it in
 * both files or not at all — {@link verifyEmbeddedSchema} fails the build when
 * it survives in the bundle.
 */
export const EMBEDDED_SCHEMA_SQL_IDENTIFIER = '__DEBUGGEN_EMBEDDED_SCHEMA_SQL__';

/**
 * The shortest DDL line {@link verifyEmbeddedSchema} looks for in the bundle:
 * long enough that finding it verbatim proves the literal is the DDL, rather
 * than a fragment such as `);` that any bundle contains.
 */
const MIN_VERIFIED_DDL_LINE_CHARS = 20;

/**
 * A DDL line esbuild prints unchanged whichever literal form it picks for the
 * DDL — a quoted string with `\n` escapes, or (as esbuild 0.28 does for this
 * multi-line text) a template literal with real line breaks: printable ASCII
 * only (esbuild escapes everything else) and none of the characters a form
 * may escape or quote with — `'`, `"`, `` ` ``, `\` and `$`. Such a line
 * appears verbatim in the bundle in either form.
 */
const VERBATIM_LITERAL_LINE = /^[\x20-\x7e]+$/;
const LITERAL_ESCAPED_CHARACTER = /['"`\\$]/;

/** The command that produces the preload artefact; named in its hint. */
const PRELOAD_BUILD_COMMAND = 'pnpm --filter @debuggen/telemetry build';

/** The command that rebuilds this workspace; named in verification hints. */
const EXTENSION_BUILD_COMMAND = 'pnpm --filter debug-generator build';

/**
 * The minimal manifest beside the service bundle. No name, no version, no
 * dependencies: its only job is to make Node parse `main.js` as ESM.
 */
const SERVICE_PACKAGE_JSON = '{"type":"module","private":true}\n';

/** The first four bytes of every PNG file: `\x89PNG`. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Marker the store DDL must contain to be the store schema at all. */
const SCHEMA_MARKER = /\bCREATE\s+TABLE\b/i;

/**
 * Bare specifiers a bundle may leave unresolved because the code that requires
 * them is wrapped in `try`/`catch` and works without them: `ws` probes the
 * optional native accelerators `bufferutil` and `utf-8-validate`, and the
 * TypeScript compiler inside `ts-morph` probes `source-map-support`. Any other
 * external bare specifier fails the build, because it would throw at run time
 * inside an installed extension that has no `node_modules` for it.
 */
const OPTIONAL_RUNTIME_REQUIRES = Object.freeze([
  'bufferutil',
  'utf-8-validate',
  'source-map-support',
]);

/** How long a production load check may take before it counts as a failure. */
const LOAD_CHECK_TIMEOUT_MS = 120_000;

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

// ---------------------------------------------------------------------------
// Errors and command line
// ---------------------------------------------------------------------------

/**
 * Failure carrying the exit code the CLI should use and, where one exists, a
 * hint that states exactly how to recover.
 */
export class ExtensionBuildError extends Error {
  /**
   * @param {string} message single-line description of what went wrong
   * @param {{ hint?: string, exitCode?: number, showUsage?: boolean, detail?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'ExtensionBuildError';
    /** @type {number} process exit code that corresponds to this failure */
    this.exitCode = options.exitCode ?? EXIT_FAILURE;
    /** @type {string | undefined} how to recover */
    this.hint = options.hint;
    /** @type {string | undefined} captured output that explains the failure */
    this.detail = options.detail;
    /** @type {boolean} whether the CLI should print the usage text as well */
    this.showUsage = options.showUsage === true;
  }
}

/**
 * A missing or unusable input: nothing could be built from it (exit 2).
 *
 * @param {string} message
 * @param {string} hint
 * @returns {ExtensionBuildError}
 */
function preconditionError(message, hint) {
  return new ExtensionBuildError(message, { hint, exitCode: EXIT_USAGE });
}

/** Every flag this script accepts, mapped to the option it sets. */
const FLAGS = Object.freeze({
  '--production': 'production',
  '--watch': 'watch',
  '--tests': 'tests',
  '--package': 'package',
  '--no-clean': 'noClean',
  '--help': 'help',
});

/** Full `--help` text. */
export const USAGE = `Usage: node esbuild.mjs [--production] [--watch] [--tests] [--package] [--no-clean]
       node esbuild.mjs --help

Builds the Debug Generator VS Code extension into dist/:
  host      ${LAYOUT.hostEntry} -> ${LAYOUT.hostOut}  (CommonJS, node20, only "vscode" external)
  service   ${INPUTS.serviceEntry} -> ${LAYOUT.serviceOut}  (ESM, node24, fully bundled)
            + ${LAYOUT.serviceManifest}, ${LAYOUT.servicePrompts}/; ${INPUTS.schema} inlined
              into the bundle as a string (${EMBEDDED_SCHEMA_SQL_IDENTIFIER}), no .sql file ships
  preload   ${INPUTS.preload} -> ${LAYOUT.preloadOut}  (byte-for-byte copy)
            + its runtime dependency closure in ${LAYOUT.preloadVendor}/
  tests     ${LAYOUT.testSuiteSrc}/**/*.test.ts -> ${LAYOUT.testSuiteOut}/**/*.test.js  (with --tests)
            + ${LAYOUT.testProbeSrc} -> ${LAYOUT.testProbeOut}  (CommonJS, node20, only "vscode" external)

Flags:
  --production  external sourcemaps without sources, NODE_ENV=production, warnings fail the
                build, load checks of the service and preload, strict artefact verification
  --watch       rebuild the host (and the tests with --tests) on change; the service (with its
                inlined DDL), prompts and preload are built once at start; never removes dist/
                (dist/service/ is always rebuilt whole)
  --tests       also build the extension-host test suites and the packaged-VSIX probe
  --package     also stage ${LAYOUT.stagedLicense} from the repository root, check ${LAYOUT.icon} and
                verify every artefact this script owns (vsce runs this as vscode:prepublish)
  --no-clean    keep the existing dist/ instead of removing it first
  --help        print this text

Exit codes: 0 success, 1 build or verification rejected, 2 bad usage or missing input.`;

/**
 * @typedef {object} CliOptions
 * @property {boolean} production
 * @property {boolean} watch
 * @property {boolean} tests
 * @property {boolean} package
 * @property {boolean} noClean
 * @property {boolean} help
 */

/**
 * Parse the argument list. Only the exact flags in {@link FLAGS} are accepted;
 * a repeated flag is harmless, anything else (including `--flag=value`) is a
 * usage error.
 *
 * @param {readonly string[]} argv arguments after the script name
 * @returns {CliOptions}
 * @throws {ExtensionBuildError} exit 2 on an unknown argument
 */
export function parseArgs(argv) {
  /** @type {CliOptions} */
  const options = {
    production: false,
    watch: false,
    tests: false,
    package: false,
    noClean: false,
    help: false,
  };
  for (const arg of argv) {
    if (!Object.hasOwn(FLAGS, arg)) {
      throw new ExtensionBuildError(`Unknown argument: ${JSON.stringify(arg)}.`, {
        exitCode: EXIT_USAGE,
        showUsage: true,
      });
    }
    options[FLAGS[/** @type {keyof typeof FLAGS} */ (arg)]] = true;
  }
  if (options.watch && options.package) {
    throw new ExtensionBuildError('--watch and --package cannot be combined.', {
      exitCode: EXIT_USAGE,
      showUsage: true,
      hint: 'Packaging needs a finished build: run "node esbuild.mjs --production --package".',
    });
  }
  return options;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * An absolute path inside this workspace from an extension-relative POSIX one.
 *
 * @param {string} relative
 * @returns {string}
 */
function fromExtension(relative) {
  return path.join(EXTENSION_DIR, ...relative.split('/'));
}

/**
 * An absolute path inside the repository from a repository-relative POSIX one.
 *
 * @param {string} relative
 * @returns {string}
 */
function fromRepo(relative) {
  return path.join(REPO_ROOT, ...relative.split('/'));
}

/**
 * A repository-relative POSIX rendering of an absolute path, for messages; a
 * path outside the checkout is returned unchanged.
 *
 * @param {string} absolute
 * @returns {string}
 */
function display(absolute) {
  const relative = path.relative(REPO_ROOT, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return absolute;
  }
  return relative.split(path.sep).join('/');
}

/**
 * @param {string} file
 * @returns {boolean} whether `file` exists and is a regular file (links followed)
 */
function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @returns {boolean} whether `dir` exists and is a directory (links followed)
 */
function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {Buffer | string} bytes
 * @returns {string} lowercase hex SHA-256 digest
 */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {number} bytes
 * @returns {string} a short human-readable size
 */
function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Parse a JSON file, or fail with a message naming it.
 *
 * @param {string} file absolute path
 * @returns {unknown}
 * @throws {ExtensionBuildError}
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new ExtensionBuildError(`Could not read ${display(file)} as JSON: ${messageOf(cause)}`, {
      exitCode: EXIT_USAGE,
    });
  }
}

/**
 * @param {unknown} cause
 * @returns {string} the message of an error-like value
 */
function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Print one concise status line for a finished target.
 *
 * @param {string} target
 * @param {string} summary
 */
function report(target, summary) {
  console.log(`esbuild.mjs: ${target.padEnd(8)} ${summary}`);
}

// ---------------------------------------------------------------------------
// esbuild configuration
// ---------------------------------------------------------------------------

/**
 * @typedef {object} BuildMode
 * @property {boolean} production
 */

/**
 * The service bundle's ESM interop prologue. Bundled CommonJS dependencies
 * (the TypeScript compiler inside ts-morph, pino, ws, …) call `require`,
 * `__filename` and `__dirname`, none of which exists in an ES module, and
 * esbuild's `__require` shim throws "Dynamic require … is not supported" when
 * `require` is undefined. The prologue derives all three from
 * `import.meta.url` under private names — the service's own sources import
 * `createRequire` too, so the usual `import { createRequire }` banner would
 * collide with them — and assigns each global only when it is undefined.
 */
const SERVICE_BANNER = [
  "import { createRequire as __debuggenCreateRequire } from 'node:module';",
  "import { dirname as __debuggenDirname } from 'node:path';",
  "import { fileURLToPath as __debuggenFileURLToPath } from 'node:url';",
  'const __debuggenFilename = __debuggenFileURLToPath(import.meta.url);',
  "if (typeof globalThis.require === 'undefined') globalThis.require = __debuggenCreateRequire(import.meta.url);",
  "if (typeof globalThis.__filename === 'undefined') globalThis.__filename = __debuggenFilename;",
  "if (typeof globalThis.__dirname === 'undefined') globalThis.__dirname = __debuggenDirname(__debuggenFilename);",
].join('\n');

/**
 * Options every target shares.
 *
 * @param {BuildMode} mode
 * @returns {import('esbuild').BuildOptions}
 */
function commonOptions(mode) {
  return {
    absWorkingDir: EXTENSION_DIR,
    bundle: true,
    platform: 'node',
    sourcemap: true,
    sourcesContent: !mode.production,
    logLevel: 'warning',
    metafile: true,
    define: mode.production ? { 'process.env.NODE_ENV': '"production"' } : {},
  };
}

/**
 * Target 1, the extension host.
 *
 * @param {BuildMode} mode
 * @returns {import('esbuild').BuildOptions}
 */
export function hostBuildOptions(mode) {
  return {
    ...commonOptions(mode),
    entryPoints: [fromExtension(LAYOUT.hostEntry)],
    outfile: fromExtension(LAYOUT.hostOut),
    format: 'cjs',
    target: 'node20',
    mainFields: ['module', 'main'],
    external: ['vscode'],
  };
}

/**
 * Target 2, the embedded coordination service, bundled from source, with the
 * store DDL substituted for {@link EMBEDDED_SCHEMA_SQL_IDENTIFIER} as one JSON
 * string literal.
 *
 * @param {BuildMode} mode
 * @param {string} schemaSql the text of `apps/local-service/src/store/schema.sql`
 * @returns {import('esbuild').BuildOptions}
 * @throws {ExtensionBuildError} when `schemaSql` is not a non-empty string
 */
export function serviceBuildOptions(mode, schemaSql) {
  if (typeof schemaSql !== 'string' || schemaSql.trim().length === 0) {
    throw new ExtensionBuildError(
      'serviceBuildOptions() needs the store DDL text to embed in the service bundle.',
    );
  }
  const common = commonOptions(mode);
  return {
    ...common,
    entryPoints: [fromRepo(INPUTS.serviceEntry)],
    outfile: fromExtension(LAYOUT.serviceOut),
    format: 'esm',
    target: 'node24',
    packages: 'bundle',
    banner: { js: SERVICE_BANNER },
    define: { ...common.define, [EMBEDDED_SCHEMA_SQL_IDENTIFIER]: JSON.stringify(schemaSql) },
  };
}

/**
 * The packages a compiled suite can `require` at run time: the ones this
 * workspace and the repository root declare, which Node finds by walking up
 * from `dist/test/suite/` through `apps/vscode-extension/node_modules` to the
 * root `node_modules` — plus `vscode` and `mocha`, which the test runner
 * provides. `@debuggen/*` is never in the set.
 *
 * @returns {Set<string>}
 */
function runtimeResolvableTestPackages() {
  const names = new Set(['vscode', 'mocha']);
  for (const manifestPath of [fromExtension('package.json'), fromRepo('package.json')]) {
    const manifest = readJson(manifestPath);
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const record =
        typeof manifest === 'object' && manifest !== null && key in manifest
          ? manifest[key]
          : undefined;
      for (const name of Object.keys(typeof record === 'object' && record !== null ? record : {})) {
        if (!name.startsWith('@debuggen/')) {
          names.add(name);
        }
      }
    }
  }
  return names;
}

/**
 * esbuild plugin for the test bundles: a bare specifier stays external only
 * when the suite can resolve it at run time ({@link runtimeResolvableTestPackages})
 * or it is a Node built-in; everything else is inlined. That inlines
 * `@debuggen/*` — ESM-only `exports` maps, so a `require()` of one from a
 * CommonJS suite would depend on the editor's Node supporting `require(esm)`,
 * exactly the dependency the host bundle avoids — and, with them, their own
 * dependencies (`zod`, `nanoid`, …), which pnpm installs for those packages
 * but not for this workspace, so they are not reachable from `dist/test/`.
 *
 * @returns {import('esbuild').Plugin}
 */
function externalizeRuntimeResolvablePackages() {
  const external = runtimeResolvableTestPackages();
  return {
    name: 'debuggen-externalize-runtime-resolvable',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.kind === 'entry-point' || path.isAbsolute(args.path)) {
          return undefined;
        }
        if (isBuiltin(args.path) || external.has(packageNameOf(args.path))) {
          return { path: args.path, external: true };
        }
        return undefined;
      });
    },
  };
}

/**
 * Target 4, the extension-host test suites, one bundle per suite.
 *
 * @param {BuildMode} mode
 * @param {readonly string[]} entryPoints absolute paths of the suites
 * @returns {import('esbuild').BuildOptions}
 */
export function testBuildOptions(mode, entryPoints) {
  return {
    ...commonOptions(mode),
    entryPoints: [...entryPoints],
    outbase: fromExtension(LAYOUT.testSuiteSrc),
    outdir: fromExtension(LAYOUT.testSuiteOut),
    format: 'cjs',
    target: 'node20',
    mainFields: ['module', 'main'],
    external: ['vscode', 'mocha'],
    plugins: [externalizeRuntimeResolvablePackages()],
  };
}

/**
 * Target 4, the packaged-VSIX probe: one self-contained CommonJS bundle. It is
 * copied out of the workspace and loaded as an extension of its own, where no
 * `node_modules` exists, so — unlike the suites — nothing but `vscode` stays
 * external, and {@link externalizeRuntimeResolvablePackages} does not apply.
 *
 * @param {BuildMode} mode
 * @returns {import('esbuild').BuildOptions}
 */
export function probeBuildOptions(mode) {
  return {
    ...commonOptions(mode),
    entryPoints: [fromExtension(LAYOUT.testProbeSrc)],
    outfile: fromExtension(LAYOUT.testProbeOut),
    format: 'cjs',
    target: 'node20',
    mainFields: ['module', 'main'],
    external: ['vscode'],
  };
}

/**
 * Run one esbuild build and hold its result to the production bar.
 *
 * esbuild prints its own diagnostics (`logLevel: 'warning'`), so the thrown
 * error only names the target. In production a warning fails the build too:
 * for a bundle that must run unattended inside an editor, esbuild's warnings
 * (`import.meta` in CommonJS output, an unresolvable import, a direct `eval`)
 * describe code that breaks at run time.
 *
 * @param {string} label target name for messages
 * @param {import('esbuild').BuildOptions} options
 * @param {BuildMode} mode
 * @returns {Promise<import('esbuild').BuildResult>}
 * @throws {ExtensionBuildError}
 */
async function runBuild(label, options, mode) {
  let result;
  try {
    result = await esbuild.build(options);
  } catch (cause) {
    const count = Array.isArray(cause?.errors) ? cause.errors.length : 0;
    throw new ExtensionBuildError(
      `The ${label} bundle failed: esbuild reported ${count === 0 ? 'an error' : `${count} error(s)`}.`,
      { detail: count === 0 ? messageOf(cause) : undefined },
    );
  }
  if (mode.production && result.warnings.length > 0) {
    throw new ExtensionBuildError(
      `The ${label} bundle produced ${result.warnings.length} esbuild warning(s), which fail a production build.`,
      { hint: 'Fix the code esbuild reported above; warnings are printed before this line.' },
    );
  }
  return result;
}

/**
 * Fail when a bundle leaves anything external that an installed extension
 * cannot provide. Node built-ins are always available; `allowed` names the
 * target's deliberate externals; {@link OPTIONAL_RUNTIME_REQUIRES} are probed
 * inside `try`/`catch` by the code that requires them.
 *
 * @param {string} label target name for messages
 * @param {import('esbuild').Metafile} metafile
 * @param {readonly string[]} allowed
 * @throws {ExtensionBuildError}
 */
function auditExternals(label, metafile, allowed) {
  const offenders = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const entry of output.imports) {
      const specifier = entry.path;
      if (
        !entry.external ||
        isBuiltin(specifier) ||
        allowed.includes(specifier) ||
        OPTIONAL_RUNTIME_REQUIRES.includes(specifier)
      ) {
        continue;
      }
      offenders.add(`${specifier} (${entry.kind})`);
    }
  }
  if (offenders.size > 0) {
    throw new ExtensionBuildError(
      `The ${label} bundle leaves ${offenders.size} import(s) external that the packaged extension cannot resolve: ${[...offenders].sort().join(', ')}.`,
      {
        hint: 'Bundle the package instead (it must not be listed as external), or, if its require() is wrapped in try/catch and optional, add it to OPTIONAL_RUNTIME_REQUIRES with the reason.',
      },
    );
  }
}

// ---------------------------------------------------------------------------
// File staging
// ---------------------------------------------------------------------------

/**
 * Copy one file byte for byte and prove it: the bytes land on a temporary file
 * in the destination directory that is then renamed over the target (so a
 * reader never sees a half-written file, and an existing symbolic link at the
 * target is replaced rather than followed), and the written file's SHA-256 is
 * compared with the source's.
 *
 * @param {string} source absolute path
 * @param {string} destination absolute path
 * @returns {string} the verified SHA-256 digest
 * @throws {ExtensionBuildError}
 */
function copyVerified(source, destination) {
  const bytes = fs.readFileSync(source);
  const expected = sha256(bytes);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.rmSync(temporary, { force: true });
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o644 });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  const written = sha256(fs.readFileSync(destination));
  if (written !== expected) {
    throw new ExtensionBuildError(
      `${display(destination)} does not match ${display(source)} after copying (SHA-256 ${written} != ${expected}).`,
    );
  }
  return expected;
}

/**
 * Every regular file below `root`, as sorted root-relative POSIX paths.
 *
 * @param {string} root absolute directory
 * @returns {string[]}
 */
function listFiles(root) {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .sort();
}

/**
 * The prompt files `manifest.json` names — the current and every available
 * version of every stage, as `<stage>/<version>.md` — after checking the
 * manifest has the shape the service's prompt loader reads.
 *
 * @param {string} manifestPath absolute path of `manifest.json`
 * @returns {{ stages: number, files: string[] }}
 * @throws {ExtensionBuildError} exit 2 when the manifest is unusable
 */
function promptFilesNamedBy(manifestPath) {
  const manifest = readJson(manifestPath);
  const hint = `Fix ${display(manifestPath)}: it must map every stage to { "current": "vNNN", "available": ["vNNN", …] }.`;
  const stages =
    typeof manifest === 'object' && manifest !== null && 'stages' in manifest
      ? manifest.stages
      : undefined;
  if (typeof stages !== 'object' || stages === null || Object.keys(stages).length === 0) {
    throw preconditionError(`${display(manifestPath)} declares no prompt stages.`, hint);
  }
  const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const files = new Set();
  for (const [stage, entry] of Object.entries(stages)) {
    const current = typeof entry === 'object' && entry !== null ? entry.current : undefined;
    const available = typeof entry === 'object' && entry !== null ? (entry.available ?? []) : [];
    if (typeof current !== 'string' || !Array.isArray(available)) {
      throw preconditionError(`${display(manifestPath)}: stage "${stage}" is malformed.`, hint);
    }
    for (const version of [current, ...available]) {
      if (!safeName.test(stage) || typeof version !== 'string' || !safeName.test(version)) {
        throw preconditionError(
          `${display(manifestPath)}: stage "${stage}" names an unusable version ${JSON.stringify(version)}.`,
          hint,
        );
      }
      files.add(`${stage}/${version}.md`);
    }
  }
  return { stages: Object.keys(stages).length, files: [...files].sort() };
}

/**
 * Check the prompt tree: `manifest.json` exists, has the loader's shape, and
 * every version it names is present.
 *
 * @returns {{ source: string, stages: number }}
 * @throws {ExtensionBuildError} exit 2 when the tree is unusable
 */
function checkPromptTree() {
  const source = fromRepo(INPUTS.prompts);
  const manifestPath = path.join(source, 'manifest.json');
  const hint = `Restore ${INPUTS.prompts}/ (manifest.json plus <stage>/vNNN.md files); the embedded service refuses to start without it.`;
  if (!isDirectory(source) || !isFile(manifestPath)) {
    throw preconditionError(`The prompt manifest ${display(manifestPath)} does not exist.`, hint);
  }
  const named = promptFilesNamedBy(manifestPath);
  const missing = named.files.filter((file) => !isFile(path.join(source, ...file.split('/'))));
  if (missing.length > 0) {
    throw preconditionError(
      `${display(manifestPath)} names prompt file(s) that do not exist: ${missing.join(', ')}.`,
      hint,
    );
  }
  return { source, stages: named.stages };
}

/**
 * Copy the versioned prompt tree verbatim to `dist/service/prompts/` and
 * verify every copied byte. The destination is replaced as a whole, so a
 * prompt version removed from the source cannot linger in the extension.
 *
 * @returns {void}
 * @throws {ExtensionBuildError}
 */
function stagePrompts() {
  const { source, stages } = checkPromptTree();
  const destination = fromExtension(LAYOUT.servicePrompts);
  fs.rmSync(destination, { recursive: true, force: true });
  const files = listFiles(source);
  for (const file of files) {
    copyVerified(path.join(source, ...file.split('/')), path.join(destination, ...file.split('/')));
  }
  report(
    'prompts',
    `${LAYOUT.servicePrompts}/ (${files.length} files, ${stages} stages, from ${INPUTS.prompts}/)`,
  );
}

/**
 * Check the session-store DDL exists and is the store schema. It is a
 * precondition of every run (see {@link preflight}) because its text is what
 * the service bundle embeds ({@link serviceBuildOptions}).
 *
 * @returns {{ source: string, text: string }}
 * @throws {ExtensionBuildError} exit 2 when it is missing or unusable
 */
function checkSchema() {
  const source = fromRepo(INPUTS.schema);
  const hint = `Restore ${INPUTS.schema}; the embedded service cannot create its session store without it.`;
  if (!isFile(source)) {
    throw preconditionError(`The session-store DDL ${display(source)} does not exist.`, hint);
  }
  const text = fs.readFileSync(source, 'utf8');
  if (text.trim().length === 0 || !SCHEMA_MARKER.test(text)) {
    throw preconditionError(
      `${display(source)} is empty or declares no table, so it is not the store schema.`,
      hint,
    );
  }
  return { source, text };
}

/**
 * Every `*.sql` file below `root`, root-relative; `[]` when `root` is absent.
 *
 * @param {string} root absolute directory
 * @returns {string[]}
 */
function sqlFilesUnder(root) {
  return isDirectory(root)
    ? listFiles(root).filter((file) => file.toLowerCase().endsWith('.sql'))
    : [];
}

/**
 * Fail when any `*.sql` file exists under `dist/service/`: the store DDL ships
 * inside the service bundle only, so a file beside it is a stray copy the
 * installed service must never come to depend on.
 *
 * @throws {ExtensionBuildError}
 */
function assertNoSqlBesideService() {
  const shipped = sqlFilesUnder(path.dirname(fromExtension(LAYOUT.serviceOut)));
  if (shipped.length > 0) {
    throw new ExtensionBuildError(
      `dist/service/ holds SQL file(s) the VSIX must not ship: ${shipped.join(', ')}.`,
      { hint: 'The store DDL is inlined into the service bundle; nothing may copy it beside it.' },
    );
  }
}

/**
 * Prove the service bundle carries the store DDL inline and nothing else does:
 * {@link EMBEDDED_SCHEMA_SQL_IDENTIFIER} no longer occurs in
 * `dist/service/main.js` (esbuild substituted every reference), every DDL line
 * of at least {@link MIN_VERIFIED_DDL_LINE_CHARS} characters that esbuild
 * prints unchanged inside a string literal ({@link VERBATIM_LITERAL_LINE})
 * occurs verbatim in it, and no `*.sql` file exists under `dist/service/`.
 *
 * @param {string} schemaSql the DDL text the bundle was built with
 * @returns {number} how many DDL lines were found verbatim
 * @throws {ExtensionBuildError}
 */
function verifyEmbeddedSchema(schemaSql) {
  const bundleFile = fromExtension(LAYOUT.serviceOut);
  const hint = `Check the "define" of serviceBuildOptions() and embeddedSchemaSql() in apps/local-service/src/store/db.ts, then rebuild with "${EXTENSION_BUILD_COMMAND}".`;
  const bundle = fs.readFileSync(bundleFile, 'utf8');
  if (bundle.includes(EMBEDDED_SCHEMA_SQL_IDENTIFIER)) {
    throw new ExtensionBuildError(
      `${LAYOUT.serviceOut} still references ${EMBEDDED_SCHEMA_SQL_IDENTIFIER}: the store DDL was not substituted, so the installed service would look for a schema.sql file that does not ship.`,
      { hint },
    );
  }
  const lines = [
    ...new Set(
      schemaSql
        .split(/\r?\n/)
        .filter(
          (line) =>
            line.length >= MIN_VERIFIED_DDL_LINE_CHARS &&
            VERBATIM_LITERAL_LINE.test(line) &&
            !LITERAL_ESCAPED_CHARACTER.test(line),
        ),
    ),
  ];
  if (lines.length === 0) {
    throw new ExtensionBuildError(
      `${INPUTS.schema} has no line of ${MIN_VERIFIED_DDL_LINE_CHARS}+ plain ASCII characters, so its presence in ${LAYOUT.serviceOut} cannot be verified.`,
      { hint: 'Keep at least one plain CREATE TABLE line in the store DDL.' },
    );
  }
  const absent = lines.filter((line) => !bundle.includes(line));
  if (absent.length > 0) {
    throw new ExtensionBuildError(
      `${LAYOUT.serviceOut} lacks ${absent.length} of the ${lines.length} verifiable lines of ${INPUTS.schema}: the store DDL is not embedded.`,
      { hint, detail: absent.slice(0, 5).join('\n') },
    );
  }
  assertNoSqlBesideService();
  return lines.length;
}

// ---------------------------------------------------------------------------
// Targets 1 and 2: host and service bundles
// ---------------------------------------------------------------------------

/**
 * @param {string} entry absolute path of an entry point
 * @param {string} what what the entry is, for the message
 * @param {string} hint how to recover
 * @throws {ExtensionBuildError} exit 2 when the entry does not exist
 */
function requireEntry(entry, what, hint) {
  if (!isFile(entry)) {
    throw preconditionError(`The ${what} entry point ${display(entry)} does not exist.`, hint);
  }
}

/** @throws {ExtensionBuildError} exit 2 when `src/extension.ts` is missing */
function checkHostEntry() {
  requireEntry(
    fromExtension(LAYOUT.hostEntry),
    'extension host',
    `Restore apps/vscode-extension/${LAYOUT.hostEntry}; package.json#main points at ${LAYOUT.hostOut}.`,
  );
}

/** @throws {ExtensionBuildError} exit 2 when the service entry is missing */
function checkServiceEntry() {
  requireEntry(
    fromRepo(INPUTS.serviceEntry),
    'local service',
    `Restore ${INPUTS.serviceEntry}; the extension embeds the service built from it.`,
  );
}

/**
 * Target 1: bundle the extension host and audit its externals.
 *
 * @param {BuildMode} mode
 * @returns {Promise<void>}
 */
async function buildHost(mode) {
  checkHostEntry();
  const result = await runBuild('host', hostBuildOptions(mode), mode);
  auditExternals('host', result.metafile, ['vscode']);
  const size = fs.statSync(fromExtension(LAYOUT.hostOut)).size;
  report('host', `${LAYOUT.hostOut} (${formatBytes(size)}, CommonJS, node20)`);
}

/**
 * Target 2: remove `dist/service/` as a whole (it is this script's output
 * alone, so no stale bundle, prompt or SQL file can survive `--no-clean` or
 * `--watch`), bundle the coordination service with every dependency and the
 * store DDL inlined, audit that nothing but Node built-ins stayed external,
 * prove the DDL is embedded ({@link verifyEmbeddedSchema}), and write the ESM
 * marker manifest beside it.
 *
 * @param {BuildMode} mode
 * @returns {Promise<void>}
 */
async function buildService(mode) {
  checkServiceEntry();
  const { text: schemaSql } = checkSchema();
  fs.rmSync(path.dirname(fromExtension(LAYOUT.serviceOut)), { recursive: true, force: true });
  const result = await runBuild('service', serviceBuildOptions(mode, schemaSql), mode);
  auditExternals('service', result.metafile, []);
  const verifiedLines = verifyEmbeddedSchema(schemaSql);
  const manifest = fromExtension(LAYOUT.serviceManifest);
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, SERVICE_PACKAGE_JSON, { mode: 0o644 });
  const size = fs.statSync(fromExtension(LAYOUT.serviceOut)).size;
  report(
    'service',
    `${LAYOUT.serviceOut} (${formatBytes(size)}, ESM, node24) + ${LAYOUT.serviceManifest}; ` +
      `${INPUTS.schema} inlined (${formatBytes(Buffer.byteLength(schemaSql))}, ${verifiedLines} lines verified, no .sql file)`,
  );
}

// ---------------------------------------------------------------------------
// Target 3: the telemetry preload and its runtime dependency closure
// ---------------------------------------------------------------------------

/**
 * Files inside a vendored package that Node never loads: TypeScript sources
 * and declarations (Node refuses to strip types under `node_modules`) and
 * source maps. Leaving them out roughly halves the vendored tree without
 * touching a byte of any module that runs.
 */
const RUNTIME_INERT_FILE = /\.(?:[cm]?ts|tsx|map)$/;

/**
 * @param {string} specifier a bare import specifier
 * @returns {string} its package name (`@scope/name` or `name`)
 */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/**
 * The `node_modules` directories Node searches for a bare specifier imported
 * from `fromDir`, nearest first — the same walk as Node's own resolver, which
 * never appends `node_modules` to a directory that already is one.
 *
 * @param {string} fromDir absolute directory
 * @returns {string[]}
 */
export function nodeModulesChain(fromDir) {
  const chain = [];
  let directory = path.resolve(fromDir);
  for (;;) {
    if (path.basename(directory) !== 'node_modules') {
      chain.push(path.join(directory, 'node_modules'));
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return chain;
    }
    directory = parent;
  }
}

/**
 * @param {string} candidate absolute path
 * @param {string} root absolute directory
 * @returns {boolean} whether `candidate` lies strictly inside `root`
 */
function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Where Node would find package `name` when it is imported from `fromDir`, as
 * the package's real directory (pnpm symlinks dereferenced), or `undefined`.
 * Resolving from a package's REAL directory is what makes pnpm's layout work:
 * its dependencies are the siblings of `.pnpm/<pkg>@<version>/node_modules/<pkg>`.
 *
 * @param {string} fromDir absolute directory
 * @param {string} name package name
 * @returns {string | undefined}
 */
function findInstalledPackage(fromDir, name) {
  for (const nodeModules of nodeModulesChain(fromDir)) {
    const candidate = path.join(nodeModules, ...name.split('/'));
    if (isFile(path.join(candidate, 'package.json'))) {
      return fs.realpathSync(candidate);
    }
  }
  return undefined;
}

/**
 * The runtime dependency edges of one package manifest, sorted by name.
 * `dependencies` must be installed; `optionalDependencies` and peers may be
 * absent (pnpm installs a required peer with `autoInstallPeers`, and a peer
 * that is absent in the repository is equally absent for the artefact there).
 * `@types/*` packages carry no runtime code and are skipped, as are bundled
 * dependencies, which travel inside their owner's directory.
 *
 * @param {Record<string, unknown>} manifest parsed package.json
 * @returns {{ name: string, optional: boolean }[]}
 */
export function dependencyEdges(manifest) {
  const record = (key) =>
    typeof manifest[key] === 'object' && manifest[key] !== null ? manifest[key] : {};
  const dependencies = record('dependencies');
  const optionalDependencies = record('optionalDependencies');
  const bundled = new Set(bundledDependencyNames(manifest));
  const names = new Set([
    ...Object.keys(dependencies),
    ...Object.keys(optionalDependencies),
    ...Object.keys(record('peerDependencies')),
  ]);
  return [...names]
    .filter((name) => !name.startsWith('@types/') && name !== manifest.name && !bundled.has(name))
    .sort()
    .map((name) => ({
      name,
      optional: !Object.hasOwn(dependencies, name) || Object.hasOwn(optionalDependencies, name),
    }));
}

/**
 * @param {Record<string, unknown>} manifest parsed package.json
 * @returns {string[]} the names under `bundleDependencies` / `bundledDependencies`
 */
function bundledDependencyNames(manifest) {
  const value = manifest.bundleDependencies ?? manifest.bundledDependencies;
  return Array.isArray(value) ? value.filter((name) => typeof name === 'string') : [];
}

/**
 * The bare packages the preload artefact imports, read from esbuild's own
 * analysis of the file (`packages: 'external'`, nothing written) rather than
 * from a pattern match over its text. The artefact must be one file: a
 * relative import would be a sibling chunk the byte-for-byte copy does not
 * carry.
 *
 * @param {string} preloadFile absolute path of `register.mjs`
 * @returns {Promise<string[]>} sorted package names, Node built-ins excluded
 * @throws {ExtensionBuildError}
 */
async function preloadRuntimePackages(preloadFile) {
  let result;
  try {
    result = await esbuild.build({
      absWorkingDir: EXTENSION_DIR,
      entryPoints: [preloadFile],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
    });
  } catch (cause) {
    throw new ExtensionBuildError(`Could not analyse ${display(preloadFile)}: ${messageOf(cause)}`);
  }
  const inputs = Object.entries(result.metafile.inputs);
  if (inputs.length !== 1) {
    throw new ExtensionBuildError(
      `${display(preloadFile)} imports ${inputs.length - 1} local module(s); the preload must be a single self-contained file.`,
      { hint: 'Check packages/telemetry/esbuild.node.mjs: it must emit exactly one file.' },
    );
  }
  const names = new Set();
  for (const [, input] of inputs) {
    for (const entry of input.imports) {
      if (entry.external && !isBuiltin(entry.path)) {
        names.add(packageNameOf(entry.path));
      }
    }
  }
  return [...names].sort();
}

/**
 * Vendor the runtime dependency closure of the preload into
 * `<vendorRoot>/node_modules`, reproducing — with real directories instead of
 * pnpm's symlinks — the resolution the artefact gets inside the repository.
 *
 * Every package is resolved from its requester's REAL directory (so pnpm picks
 * the version it locked for that requester), then placed in the vendored tree:
 * if the nearest occupant on the requester's lookup chain is that same package
 * it is reused; if it is a different version, the package is nested in the
 * requester's own `node_modules`, which shadows the other version for exactly
 * that requester; if nothing occupies the chain, it is hoisted to the top.
 * Breadth-first order means a requester's dependencies are all placed before
 * any of their own, so a later placement never shadows an earlier resolution.
 *
 * @param {string[]} rootPackages packages the preload imports
 * @param {string} preloadSourceDir directory of the artefact in the repository
 * @param {string} preloadInstallDir directory of the copied artefact
 * @param {string} vendorRoot directory whose `node_modules` receives the tree
 * @returns {number} how many package directories were vendored
 * @throws {ExtensionBuildError}
 */
function vendorDependencyClosure(rootPackages, preloadSourceDir, preloadInstallDir, vendorRoot) {
  const vendorNodeModules = path.join(vendorRoot, 'node_modules');
  fs.rmSync(vendorNodeModules, { recursive: true, force: true });

  /** @type {Map<string, string>} install directory -> real source directory */
  const placements = new Map();
  /** @type {string[]} install directories whose dependencies are still to place */
  const queue = [];

  const place = (requesterInstallDir, requesterSourceDir, name, optional) => {
    const source = findInstalledPackage(requesterSourceDir, name);
    if (source === undefined) {
      if (optional) {
        return;
      }
      throw preconditionError(
        `${name}, a runtime dependency required by ${display(requesterSourceDir)}, is not installed.`,
        'Run "pnpm install --frozen-lockfile" at the repository root, then rebuild.',
      );
    }
    const chain = nodeModulesChain(requesterInstallDir).filter((dir) => isInside(dir, vendorRoot));
    const nearest = chain[0];
    const top = chain[chain.length - 1];
    if (nearest === undefined || top === undefined) {
      throw new ExtensionBuildError(
        `${display(requesterInstallDir)} is outside the vendored tree.`,
      );
    }
    let slot;
    for (const directory of chain) {
      const occupant = placements.get(path.join(directory, ...name.split('/')));
      if (occupant === source) {
        return;
      }
      if (occupant !== undefined) {
        slot = path.join(nearest, ...name.split('/'));
        break;
      }
    }
    slot ??= path.join(top, ...name.split('/'));
    placements.set(slot, source);
    queue.push(slot);
  };

  for (const name of rootPackages) {
    place(preloadInstallDir, preloadSourceDir, name, false);
  }
  while (queue.length > 0) {
    const slot = /** @type {string} */ (queue.shift());
    const source = /** @type {string} */ (placements.get(slot));
    const manifest = /** @type {Record<string, unknown>} */ (
      readJson(path.join(source, 'package.json'))
    );
    for (const edge of dependencyEdges(manifest)) {
      place(slot, source, edge.name, edge.optional);
    }
  }

  // Parents first, so a nested package lands inside its already-copied owner.
  for (const slot of [...placements.keys()].sort()) {
    copyPackageDirectory(/** @type {string} */ (placements.get(slot)), slot);
  }
  return placements.size;
}

/**
 * Copy one installed package into the vendored tree: every file dereferenced,
 * the package's own `node_modules` left out (its dependencies are placed by
 * {@link vendorDependencyClosure}) except for bundled dependencies, which only
 * exist there, and {@link RUNTIME_INERT_FILE} files left out.
 *
 * @param {string} source real directory of the installed package
 * @param {string} destination directory inside the vendored tree
 */
function copyPackageDirectory(source, destination) {
  const manifest = /** @type {Record<string, unknown>} */ (
    readJson(path.join(source, 'package.json'))
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
    filter: (from) => {
      const relative = path.relative(source, from);
      return (
        relative.split(path.sep)[0] !== 'node_modules' &&
        !(RUNTIME_INERT_FILE.test(from) && isFile(from))
      );
    },
  });
  for (const name of bundledDependencyNames(manifest)) {
    const bundled = path.join(source, 'node_modules', ...name.split('/'));
    if (isDirectory(bundled)) {
      fs.cpSync(bundled, path.join(destination, 'node_modules', ...name.split('/')), {
        recursive: true,
        dereference: true,
        force: true,
      });
    }
  }
}

/**
 * Check the preload artefact exists. It is never written here as a
 * placeholder: it is what gives the developer's dev server its tracer
 * provider, so a missing artefact stops the build.
 *
 * @returns {string} absolute path of the artefact
 * @throws {ExtensionBuildError} exit 2 when it is missing or empty
 */
function checkPreload() {
  const source = fromRepo(INPUTS.preload);
  if (!isFile(source) || fs.statSync(source).size === 0) {
    throw preconditionError(
      `The telemetry preload ${display(source)} does not exist or is empty.`,
      `Build it with "${PRELOAD_BUILD_COMMAND}" ("pnpm build" builds it before this workspace), then run this build again.`,
    );
  }
  return source;
}

/**
 * Target 3: copy the preload byte for byte (plus its source map), then vendor
 * the packages it imports so the copy resolves them inside the extension.
 *
 * @returns {Promise<void>}
 * @throws {ExtensionBuildError}
 */
async function stagePreload() {
  const source = checkPreload();
  const destination = fromExtension(LAYOUT.preloadOut);
  const digest = copyVerified(source, destination);
  if (isFile(`${source}.map`)) {
    copyVerified(`${source}.map`, `${destination}.map`);
  } else {
    fs.rmSync(`${destination}.map`, { force: true });
  }

  const packages = await preloadRuntimePackages(source);
  const vendored = vendorDependencyClosure(
    packages,
    fs.realpathSync(path.dirname(source)),
    path.dirname(destination),
    path.dirname(fromExtension(LAYOUT.preloadVendor)),
  );
  report(
    'preload',
    `${LAYOUT.preloadOut} (sha256 ${digest.slice(0, 12)}, ${formatBytes(fs.statSync(destination).size)}) + ${vendored} packages in ${LAYOUT.preloadVendor}/`,
  );
}

// ---------------------------------------------------------------------------
// Production load checks
// ---------------------------------------------------------------------------

/**
 * The program a load check runs in a fresh Node process. It installs a
 * synchronous module hook (covering `import` and `require` alike) that
 * records every module resolved to a file outside the artefact's root, then
 * imports the artefact. Importing is enough: an ES module's static graph is
 * linked and evaluated before `import()` settles, so a module that cannot be
 * found fails here exactly as it would in the installed extension. The service
 * bundle starts nothing on import — it listens only when it is the process
 * entry — and the preload stays inert without its ingest URL and credential,
 * which the check's environment never carries. The optional probes of
 * {@link OPTIONAL_RUNTIME_REQUIRES} are allowed to resolve anywhere (or not
 * at all), because the code that requires them catches the failure.
 */
const LOAD_CHECK_SOURCE = [
  "import { registerHooks } from 'node:module';",
  'const { entry, root, optional } = JSON.parse(process.argv[1]);',
  'const allowed = new Set(optional);',
  'const escapes = [];',
  'registerHooks({',
  '  resolve(specifier, context, nextResolve) {',
  '    const resolved = nextResolve(specifier, context);',
  "    if (resolved.url.startsWith('file:') && !resolved.url.startsWith(root) && !allowed.has(specifier)) {",
  "      escapes.push(`${specifier} -> ${resolved.url} (imported by ${context.parentURL ?? 'the check'})`);",
  '    }',
  '    return resolved;',
  '  },',
  '});',
  'try {',
  '  await import(entry);',
  '} catch (error) {',
  '  console.error(`load failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);',
  '  process.exit(1);',
  '}',
  'if (escapes.length > 0) {',
  "  console.error(`resolved outside ${root}:\\n  ${escapes.join('\\n  ')}`);",
  '  process.exit(1);',
  '}',
  'process.exit(0);',
].join('\n');

/**
 * The environment of a load check: the build's own, minus everything that
 * would make the check see a different module graph, or do more than load,
 * than the installed extension does — `NODE_OPTIONS` (a developer's own
 * `--import`), `NODE_PATH` (which `pnpm exec` and `npm run` point into the
 * repository's store, so an optional `require.resolve` probe such as fdir's
 * for `picomatch` would succeed here and fail, harmlessly, when installed),
 * every `DEBUGGEN_*` setting (which would arm the preload) and provider
 * credentials.
 *
 * @returns {Record<string, string>}
 */
function loadCheckEnvironment() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      key === 'NODE_OPTIONS' ||
      key === 'NODE_PATH' ||
      key.startsWith('DEBUGGEN_') ||
      key.startsWith('ANTHROPIC_')
    ) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

/**
 * Prove in a child Node process that `entry` loads and that every module it
 * reaches resolves to a file inside `root` — i.e. that it will load inside an
 * installed extension, where no repository `node_modules` exists.
 *
 * @param {string} label artefact name for messages
 * @param {string} entry absolute path of the artefact
 * @param {string} root absolute directory everything must resolve inside
 * @throws {ExtensionBuildError}
 */
export function runLoadCheck(label, entry, root) {
  const config = JSON.stringify({
    entry: pathToFileURL(entry).href,
    root: `${pathToFileURL(root).href}/`,
    optional: OPTIONAL_RUNTIME_REQUIRES,
  });
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', LOAD_CHECK_SOURCE, config],
    {
      cwd: root,
      env: loadCheckEnvironment(),
      encoding: 'utf8',
      timeout: LOAD_CHECK_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) {
    throw new ExtensionBuildError(`The ${label} load check could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new ExtensionBuildError(
      `The ${label} load check failed: ${display(entry)} does not load self-contained from ${display(root)}/.`,
      {
        detail: (result.stderr ?? '').trim() || `exit ${result.status ?? result.signal}`,
        hint: `Rebuild with "${EXTENSION_BUILD_COMMAND}"; if it persists, the modules listed above are missing from the bundle or the vendored tree.`,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Target 4: extension-host test suites
// ---------------------------------------------------------------------------

/**
 * Every suite under `test/suite/`, sorted. An empty set is an error, never a
 * silent success: a green extension-host run that executed nothing is the
 * failure `.vscode-test.mjs` exists to prevent.
 *
 * @returns {string[]} absolute paths
 * @throws {ExtensionBuildError} exit 2 when there is no suite
 */
function checkTestSuites() {
  const root = fromExtension(LAYOUT.testSuiteSrc);
  const entries = isDirectory(root)
    ? listFiles(root)
        .filter((file) => file.endsWith('.test.ts'))
        .map((file) => path.join(root, ...file.split('/')))
    : [];
  if (entries.length === 0) {
    throw preconditionError(
      `No extension-host suite (*.test.ts) exists under apps/vscode-extension/${LAYOUT.testSuiteSrc}/.`,
      'Add the suites (activation, commands, open-location, uri-handler, packaged-vsix) or drop --tests.',
    );
  }
  return entries;
}

/** @throws {ExtensionBuildError} exit 2 when the packaged-VSIX probe source is missing */
function checkTestProbe() {
  requireEntry(
    fromExtension(LAYOUT.testProbeSrc),
    'packaged-VSIX probe',
    `Restore apps/vscode-extension/${LAYOUT.testProbeSrc}; test/suite/packaged-vsix.test.ts loads it beside the installed extension.`,
  );
}

/**
 * Target 4: bundle each suite to `dist/test/suite/<name>.test.js`, then the
 * packaged-VSIX probe to its own self-contained bundle, audited like the host.
 * Both output directories are replaced as a whole, so no stale bundle
 * survives a rename.
 *
 * @param {BuildMode} mode
 * @returns {Promise<void>}
 */
async function buildTests(mode) {
  const entries = checkTestSuites();
  checkTestProbe();
  fs.rmSync(fromExtension(LAYOUT.testSuiteOut), { recursive: true, force: true });
  await runBuild('test suite', testBuildOptions(mode, entries), mode);
  report('tests', `${LAYOUT.testSuiteOut}/ (${entries.length} suites, CommonJS, node20)`);

  fs.rmSync(path.dirname(fromExtension(LAYOUT.testProbeOut)), { recursive: true, force: true });
  const probe = await runBuild('test probe', probeBuildOptions(mode), mode);
  auditExternals('test probe', probe.metafile, ['vscode']);
  const size = fs.statSync(fromExtension(LAYOUT.testProbeOut)).size;
  report('probe', `${LAYOUT.testProbeOut} (${formatBytes(size)}, CommonJS, node20)`);
}

// ---------------------------------------------------------------------------
// --package staging
// ---------------------------------------------------------------------------

/**
 * Check the repository-root `LICENSE` exists, since `--package` stages it.
 *
 * @returns {string} absolute path of the root `LICENSE`
 * @throws {ExtensionBuildError} exit 2 when it is missing or empty
 */
function checkLicense() {
  const license = fromRepo(INPUTS.license);
  if (!isFile(license) || fs.statSync(license).size === 0) {
    throw preconditionError(
      `The repository license ${display(license)} does not exist or is empty.`,
      'Restore the root LICENSE; vsce prompts interactively (and aborts in CI) without one.',
    );
  }
  return license;
}

/**
 * Check the icon `package.json` declares exists and is a PNG: `vsce` refuses
 * to package with a missing or non-PNG icon.
 *
 * @returns {string | undefined} the extension-relative icon path, when declared
 * @throws {ExtensionBuildError} exit 2 when the declared icon is unusable
 */
function checkIcon() {
  const manifest = readJson(fromExtension('package.json'));
  const declared =
    typeof manifest === 'object' && manifest !== null && 'icon' in manifest
      ? manifest.icon
      : undefined;
  if (declared === undefined) {
    return undefined;
  }
  const icon = typeof declared === 'string' ? fromExtension(declared) : '';
  const hint = `Restore apps/vscode-extension/${String(declared)} as a PNG image (package.json#icon).`;
  if (icon.length === 0 || !isFile(icon)) {
    throw preconditionError(`The extension icon ${String(declared)} does not exist.`, hint);
  }
  const header = Buffer.alloc(PNG_MAGIC.length);
  const descriptor = fs.openSync(icon, 'r');
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (!header.equals(PNG_MAGIC)) {
    throw preconditionError(`The extension icon ${display(icon)} is not a PNG file.`, hint);
  }
  return String(declared);
}

/**
 * Stage what `vsce` collects from the extension root: a verified copy of the
 * repository-root `LICENSE`, and a checked icon.
 *
 * @returns {void}
 * @throws {ExtensionBuildError}
 */
function stagePackage() {
  const digest = copyVerified(checkLicense(), fromExtension(LAYOUT.stagedLicense));
  const icon = checkIcon();
  report(
    'package',
    `${LAYOUT.stagedLicense} staged from the repository root (sha256 ${digest.slice(0, 12)})${icon === undefined ? '' : `, ${icon} is a PNG`}`,
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * The artefacts this script owns, extension-relative. `dist/webview/**` is
 * deliberately absent: Vite writes it after this script has finished.
 *
 * @param {CliOptions} options
 * @returns {string[]}
 */
export function ownedArtifacts(options) {
  return [
    LAYOUT.hostOut,
    LAYOUT.serviceOut,
    LAYOUT.serviceManifest,
    `${LAYOUT.servicePrompts}/manifest.json`,
    LAYOUT.preloadOut,
    ...(options.tests ? [LAYOUT.testProbeOut] : []),
    ...(options.package ? [LAYOUT.stagedLicense] : []),
  ];
}

/**
 * Verify every owned artefact exists and is non-empty (the packaged-VSIX probe
 * among them under `--tests`), that nothing staged beside the service is a
 * `*.sql` file (the DDL ships inside the bundle only), that the service marker
 * says ESM, that suites were emitted under `--tests`, and — in production —
 * that the service bundle and the preload each load with every module resolved
 * inside their own directory.
 *
 * @param {CliOptions} options
 * @throws {ExtensionBuildError}
 */
function verifyArtifacts(options) {
  const hint = `Rebuild with "${EXTENSION_BUILD_COMMAND}".`;
  const missing = ownedArtifacts(options).filter((relative) => {
    const file = fromExtension(relative);
    return !isFile(file) || fs.statSync(file).size === 0;
  });
  if (missing.length > 0) {
    throw new ExtensionBuildError(
      `Artefact(s) missing or empty after the build: ${missing.join(', ')}.`,
      { hint },
    );
  }
  assertNoSqlBesideService();
  const marker = readJson(fromExtension(LAYOUT.serviceManifest));
  if (typeof marker !== 'object' || marker === null || marker.type !== 'module') {
    throw new ExtensionBuildError(`${LAYOUT.serviceManifest} does not declare "type": "module".`, {
      hint,
    });
  }
  let suites = 0;
  if (options.tests) {
    const out = fromExtension(LAYOUT.testSuiteOut);
    suites = isDirectory(out) ? listFiles(out).filter((f) => f.endsWith('.test.js')).length : 0;
    if (suites === 0) {
      const message = `No compiled suite (*.test.js) under ${LAYOUT.testSuiteOut}/.`;
      throw new ExtensionBuildError(message, { hint });
    }
  }
  if (options.production) {
    runLoadCheck(
      'service',
      fromExtension(LAYOUT.serviceOut),
      path.dirname(fromExtension(LAYOUT.serviceOut)),
    );
    runLoadCheck(
      'preload',
      fromExtension(LAYOUT.preloadOut),
      path.dirname(fromExtension(LAYOUT.preloadVendor)),
    );
  }
  report(
    'verify',
    `${ownedArtifacts(options).length} artefacts present${suites > 0 ? `, ${suites} compiled suites` : ''}${options.production ? '; service and preload load self-contained' : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Remove `dist/`. A symbolic link named `dist` is removed as a link, never
 * followed, so the removal cannot reach outside this workspace.
 */
function cleanDist() {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}

/**
 * Check every input the requested run needs before anything is removed or
 * written, so a missing prompt tree, DDL, preload, suite, probe, license or icon
 * stops the run with `dist/` untouched instead of half rebuilt.
 *
 * @param {CliOptions} options
 * @throws {ExtensionBuildError} exit 2 on the first unusable input
 */
function preflight(options) {
  checkHostEntry();
  checkServiceEntry();
  checkPromptTree();
  checkSchema();
  checkPreload();
  if (options.tests) {
    checkTestSuites();
    checkTestProbe();
  }
  if (options.package) {
    checkLicense();
    checkIcon();
  }
}

/**
 * Target 2 and 3 plus their assets: everything under `dist/service/` (the
 * bundle with its inlined DDL, its manifest, the prompts) and
 * `dist/telemetry/`. The service goes first because it replaces
 * `dist/service/` as a whole.
 *
 * @param {BuildMode} mode
 * @returns {Promise<void>}
 */
async function buildEmbedded(mode) {
  await buildService(mode);
  stagePrompts();
  await stagePreload();
}

/**
 * One complete, non-watch run. When the run removed `dist/` first and then
 * fails, `dist/` is removed again, so a failed build never leaves a partial
 * tree for `vite build`, `vsce` or the editor to pick up; under `--no-clean`
 * the existing tree is the caller's to keep.
 *
 * @param {CliOptions} options
 * @returns {Promise<void>}
 */
export async function build(options) {
  const mode = { production: options.production };
  preflight(options);
  const cleaned = !options.noClean;
  if (cleaned) {
    cleanDist();
  }
  try {
    await buildHost(mode);
    await buildEmbedded(mode);
    if (options.tests) {
      await buildTests(mode);
    }
    if (options.package) {
      stagePackage();
    }
    verifyArtifacts(options);
  } catch (error) {
    if (cleaned) {
      cleanDist();
    }
    throw error;
  }
}

/**
 * esbuild plugin that prints one status line per watch rebuild and audits the
 * externals of a bundle that may leave only `vscode` external (the host and
 * the packaged-VSIX probe) after every successful one.
 *
 * @param {string} label
 * @param {boolean} auditHost whether to audit the externals of this build against `['vscode']`
 * @returns {import('esbuild').Plugin}
 */
function watchStatus(label, auditHost) {
  return {
    name: 'debuggen-watch-status',
    setup(pluginBuild) {
      let startedAt = 0;
      let builds = 0;
      pluginBuild.onStart(() => {
        startedAt = performance.now();
      });
      pluginBuild.onEnd((result) => {
        const elapsed = Math.round(performance.now() - startedAt);
        const first = builds === 0;
        const verb = first ? 'built' : 'rebuilt';
        builds += 1;
        const warnings =
          result.warnings.length === 0 ? '' : `, ${result.warnings.length} warning(s)`;
        if (result.errors.length > 0) {
          const failed = first ? 'build failed' : 'rebuild failed';
          report(label, `${failed}: ${result.errors.length} error(s)${warnings}`);
          return;
        }
        if (auditHost && result.metafile !== undefined) {
          try {
            auditExternals(label, result.metafile, ['vscode']);
          } catch (error) {
            report(label, `${verb} in ${elapsed} ms but rejected: ${messageOf(error)}`);
            return;
          }
        }
        report(label, `${verb} in ${elapsed} ms${warnings}`);
      });
    },
  };
}

/**
 * `--watch`: build the embedded service (with its inlined DDL), prompts and
 * preload once (so an Extension Development Host can start the service from
 * `dist/`), then keep rebuilding the host — and the suites and the probe under
 * `--tests` — on every change until interrupted. `dist/` is never removed;
 * `dist/service/` is rebuilt whole at start, so a DDL edit takes effect on the
 * next start. Suites added while watching are picked up on the next start.
 *
 * @param {CliOptions} options
 * @returns {Promise<void>}
 */
async function watch(options) {
  const mode = { production: options.production };
  preflight(options);
  await buildEmbedded(mode);

  const contexts = [
    await esbuild.context({
      ...hostBuildOptions(mode),
      plugins: [watchStatus('host', true)],
    }),
  ];
  if (options.tests) {
    const suiteOptions = testBuildOptions(mode, checkTestSuites());
    contexts.push(
      await esbuild.context({
        ...suiteOptions,
        plugins: [...(suiteOptions.plugins ?? []), watchStatus('tests', false)],
      }),
    );
    // The probe keeps the host's externals contract (only `vscode`), so it is
    // audited after every rebuild exactly as the host is.
    contexts.push(
      await esbuild.context({
        ...probeBuildOptions(mode),
        plugins: [watchStatus('probe', true)],
      }),
    );
  }
  await Promise.all(contexts.map((context) => context.watch()));
  report(
    'watch',
    `watching ${options.tests ? 'host, test suites and probe' : 'host'}; press Ctrl+C to stop`,
  );

  const stop = () => {
    Promise.all(contexts.map((context) => context.dispose())).then(
      () => process.exit(EXIT_OK),
      () => process.exit(EXIT_FAILURE),
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

/**
 * Print a failure: the message, any captured detail, the hint and, for a
 * usage error, the usage text.
 *
 * @param {unknown} error
 */
function printFailure(error) {
  const failure = error instanceof ExtensionBuildError ? error : undefined;
  console.error(`esbuild.mjs: error: ${messageOf(error)}`);
  if (failure?.detail !== undefined && failure.detail.length > 0) {
    console.error(
      failure.detail
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );
  }
  if (failure?.hint !== undefined) {
    console.error(`  hint: ${failure.hint}`);
  }
  if (failure?.showUsage === true) {
    console.error(`\n${USAGE}`);
  }
  if (failure === undefined && error instanceof Error && error.stack !== undefined) {
    console.error(error.stack);
  }
}

/**
 * The command-line entry.
 *
 * @param {readonly string[]} argv arguments after the script name
 * @returns {Promise<number>} the exit code; `--watch` resolves once watching
 * has started and the process then stays alive on esbuild's watchers
 */
export async function main(argv) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(USAGE);
      return EXIT_OK;
    }
    if (options.watch) {
      await watch(options);
    } else {
      await build(options);
    }
    return EXIT_OK;
  } catch (error) {
    printFailure(error);
    return error instanceof ExtensionBuildError ? error.exitCode : EXIT_FAILURE;
  }
}

/**
 * Whether this module is the script Node was asked to run (and not a module a
 * test imported), compared through real paths so a symlinked checkout works.
 *
 * @returns {boolean}
 */
function isProcessEntry() {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) {
    return false;
  }
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isProcessEntry()) {
  process.exitCode = await main(process.argv.slice(2));
}
