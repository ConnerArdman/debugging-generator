/**
 * esbuild.node.test.mjs
 *
 * The proof that `packages/telemetry/esbuild.node.mjs` - the bundler of the Node dev-server
 * preload - refuses to build on a broken precondition, and reports which kind of failure it was.
 *
 * WHAT THIS SUITE OWNS. One three-valued contract, shared verbatim with `esbuild.agent.mjs` and
 * read by `package.json`'s `build` script and by CI:
 *
 *   0  `dist/node/register.mjs` was written and passed the externalisation audit, or `--help`;
 *   1  the build ran and its result was rejected - esbuild reported errors, or the audit rejected
 *      the bundle - and also the code of the one step of `preflight` that acts rather than checks,
 *      the `mkdir` that creates `dist/node/`;
 *   2  nothing was built: the argument list was not understood, or a precondition does not hold -
 *      the manifest missing, unreadable, or disagreeing with the artefact this script writes; the
 *      external policy not derivable; `src/node/register.ts` or `tsconfig.json` absent; an inlined
 *      workspace dependency not built.
 *
 * The 1-versus-2 split is the whole point of these tests. Every check in `preflight` fires before
 * esbuild is asked to do anything, so nothing has been built when one of them fails, which is exit
 * 2; the trailing `mkdir` is the single exception, deliberately left at exit 1 so this script and
 * `esbuild.agent.mjs` agree on a failing I/O operation. None of those branches is on the path of a
 * successful build, so a green CI run is no evidence about any of them - and the exit codes are
 * asserted here as the literal numbers 0/1/2 rather than against imported constants (the module
 * keeps `EXIT_OK`/`EXIT_FAILURE`/`EXIT_USAGE` private), so a change to them fails this suite
 * instead of silently agreeing with it.
 *
 * WHY EVERY FIXTURE IS A THROWAWAY TREE. `preflight`, `verifyInlinedDependencyBuilt` and `main`
 * take a `packageDir` that defaults to the real package, so they can be pointed at a fixture. Each
 * test below builds a miniature package - a manifest with the exact `exports["./node/register"]`,
 * a `sideEffects` array naming the artefact and a `dependencies` map; a pnpm-shaped
 * `node_modules/@debuggen/shared` symlink to a built stand-in; `tsconfig.json`; and
 * `src/node/register.ts` - under `fs.mkdtempSync(os.tmpdir())`, never inside this checkout, whose
 * `git status` must stay clean and whose `packages/telemetry/dist/` must not be conjured into
 * existence by a test run. `afterEach` removes every root the test created, including the ones a
 * failing assertion left behind. `main` is therefore exercised with a fixture for every
 * filesystem-touching case and with the real package only for `--help` and an unrecognised flag,
 * which read and write nothing. Those two cases assert that this checkout's output tree is
 * UNCHANGED, never that it is absent: the root `verify` chain runs `pnpm build` before `pnpm test`,
 * so by then `dist/` and `dist/node/` legitimately hold artefacts, and an absence assertion would
 * fail on them rather than on anything the tested command did.
 *
 * WHY THREE OF THE BUILDS ARE REAL. Exit 0 and the audit's exit 1 are produced by esbuild's result
 * plus the metafile audit plus reading the artefact back, so they are driven end to end through
 * `main([], { packageDir })`: one sound fixture, and one whose entry imports a module under
 * `src/browser/`, which the audit forbids because the preload runs in the developer's server
 * process. The fixture entry modules are three lines each, so each build costs milliseconds. The
 * rule-matching logic itself is exercised separately against synthetic metafiles, which is how the
 * pnpm virtual-store spellings and the chunk-import case are covered without provoking them.
 *
 * HARNESS. The root `vitest.config.ts` collects this file into the `tooling` project
 * (`environment: 'node'`, `globals: false`), which `pnpm test` runs as part of the blocking gate of
 * AAP 0.8.5 and 0.7.1 Group 0. `describe`/`it`/`expect` are imported explicitly because that
 * project sets no globals. Diagnostics are captured by spying on `process.stderr.write` /
 * `process.stdout.write`, so a passing run is quiet and the message text is asserted rather than
 * printed - `no-console` is allowed only under `scripts/**`, and this file writes no console output
 * at all.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ENTRY_REL,
  EXPORT_CONDITION,
  EXTRA_EXTERNALS,
  FORBIDDEN_IMPORT_PACKAGES,
  FORBIDDEN_INLINE_PACKAGES,
  FORBIDDEN_INPUT_DIRECTORIES,
  FORBIDDEN_INPUT_REPO_DIRECTORIES,
  INLINED_WORKSPACE_DEPENDENCIES,
  NODE_TARGET,
  OUTFILE_REL,
  PACKAGE_DIR,
  PreloadBuildError,
  REPO_ROOT,
  TSCONFIG_REL,
  auditBundleText,
  auditMetafile,
  computeExternalPolicy,
  createBuildOptions,
  describeBuild,
  main,
  packageNameFromInput,
  packageNameFromSpecifier,
  parseArgs,
  preflight,
  resolveExportsPath,
  usage,
  verifyInlinedDependencyBuilt,
  verifyPackageContract,
} from './esbuild.node.mjs';

/** The artefact as the manifest has to spell it: `./dist/node/register.mjs`. */
const ARTEFACT = `./${OUTFILE_REL}`;

/** The one workspace dependency that is bundled into the preload. */
const INLINED = INLINED_WORKSPACE_DEPENDENCIES[0] ?? '@debuggen/shared';

/**
 * A minimal preload entry: it imports the inlined workspace dependency (which must therefore be
 * resolvable and built) and one package the policy keeps external (which must therefore survive as
 * a bare import in the output).
 */
const PRELOAD_ENTRY = [
  `import { sharedMarker } from '${INLINED}';`,
  "import { trace } from '@opentelemetry/api';",
  '',
  'export const marker = `${sharedMarker}:${typeof trace}`;',
  '',
].join('\n');

/**
 * A self-contained compiler configuration for the fixture. It deliberately `extends` nothing:
 * esbuild follows the `extends` chain, and a fixture that reached for `tsconfig.base.json` would
 * couple every build here to a file outside the temporary root.
 */
const FIXTURE_TSCONFIG = `${JSON.stringify(
  { compilerOptions: { target: 'es2022', module: 'esnext', verbatimModuleSyntax: true } },
  null,
  2,
)}\n`;

/**
 * The manifest a sound fixture carries: the `exports` condition the local service's launcher
 * resolves, the `sideEffects` entry that keeps a bundler from tree-shaking the preload away, and a
 * `dependencies` map holding the inlined workspace package plus one ordinary dependency.
 *
 * Returned fresh each call so a test may mutate its copy.
 *
 * @returns {Record<string, unknown>}
 */
function baseManifest() {
  return {
    name: '@debuggen/telemetry-fixture',
    version: '0.1.0',
    type: 'module',
    sideEffects: [ARTEFACT],
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      [EXPORT_CONDITION]: ARTEFACT,
    },
    dependencies: { [INLINED]: 'workspace:*', '@opentelemetry/api': '1.9.1' },
  };
}

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
 * Install the inlined workspace dependency the way pnpm does: the real package in a sibling
 * directory, reached through a relative symbolic link inside `node_modules/@scope/`. The shape
 * matters - `verifyInlinedDependencyBuilt` follows the link with `realpathSync` so the build report
 * can tell an inlined workspace package apart from the package's own sources.
 *
 * @param {string} root fixture root
 * @param {'built' | 'unbuilt' | 'no-entry' | 'no-manifest'} state what is wrong with it, if
 *   anything: `built` is complete, `unbuilt` declares an entry file that does not exist,
 *   `no-entry` declares neither `exports["."]` nor `main`, `no-manifest` has no package.json at all
 * @returns {string} absolute path of the real (link-target) package directory
 */
function installInlinedDependency(root, state) {
  const real = path.join(root, 'vendor', 'shared');
  fs.mkdirSync(real, { recursive: true });

  if (state !== 'no-manifest') {
    /** @type {Record<string, unknown>} */
    const manifest = { name: INLINED, version: '0.1.0', type: 'module' };
    if (state !== 'no-entry') {
      manifest.exports = { '.': { import: './dist/index.js', default: './dist/index.js' } };
    }
    fs.writeFileSync(
      path.join(real, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
  }

  if (state === 'built') {
    fs.mkdirSync(path.join(real, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(real, 'dist', 'index.js'),
      "export const sharedMarker = 'shared-stand-in';\n",
      'utf8',
    );
  }

  const scope = path.join(root, 'node_modules', ...INLINED.split('/').slice(0, -1));
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(
    path.relative(scope, real),
    path.join(root, 'node_modules', ...INLINED.split('/')),
  );

  return real;
}

/**
 * Build a throwaway package root and register it for cleanup.
 *
 * Every knob exists to reach exactly one branch of `preflight`. `null` rather than `undefined` for
 * the "leave it out" value, because a defaulted destructuring parameter treats `undefined` as "not
 * passed" and would quietly write the sound version instead.
 *
 * @param {{
 *   manifest?: Record<string, unknown> | string | null,
 *   entry?: string | null,
 *   tsconfig?: string | null,
 *   dependency?: 'built' | 'unbuilt' | 'no-entry' | 'no-manifest' | null,
 *   browserModule?: string | null,
 * }} [options] `manifest` accepts an object, raw text (for the invalid-JSON case) or `null`;
 *   `dependency` selects the state of the inlined workspace dependency, `null` leaving it
 *   uninstalled; `browserModule` writes `src/browser/marker.ts`, which the audit forbids as an
 *   input
 * @returns {string} absolute path of the fixture root
 */
function makeFixture({
  manifest = baseManifest(),
  entry = PRELOAD_ENTRY,
  tsconfig = FIXTURE_TSCONFIG,
  dependency = 'built',
  browserModule = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esbuild-node-test-'));
  roots.push(root);

  if (manifest !== null) {
    const text = typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path.join(root, 'package.json'), text, 'utf8');
  }
  if (tsconfig !== null) fs.writeFileSync(path.join(root, TSCONFIG_REL), tsconfig, 'utf8');
  if (dependency !== null) installInlinedDependency(root, dependency);

  fs.mkdirSync(path.join(root, path.dirname(ENTRY_REL)), { recursive: true });
  if (entry !== null) fs.writeFileSync(path.join(root, ENTRY_REL), entry, 'utf8');

  if (browserModule !== null) {
    fs.mkdirSync(path.join(root, 'src', 'browser'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'browser', 'marker.ts'), browserModule, 'utf8');
  }

  return root;
}

/**
 * Capture everything the script writes to a stream for the duration of one test, so a passing run
 * prints nothing and the diagnostics themselves can be asserted.
 *
 * @param {'stdout' | 'stderr'} stream
 * @returns {{ text: () => string, restore: () => void }}
 */
function capture(stream) {
  /** @type {string[]} */
  const chunks = [];
  const spy = vi.spyOn(process[stream], 'write').mockImplementation((chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  return {
    text: () => chunks.join(''),
    restore: () => {
      spy.mockRestore();
    },
  };
}

/**
 * Run `operation`, require it to throw a {@link PreloadBuildError} carrying `exitCode`, and hand
 * the error back for message assertions.
 *
 * @param {() => unknown} operation
 * @param {number} exitCode the literal code, never a constant imported from the module
 * @returns {PreloadBuildError}
 */
function expectFailure(operation, exitCode) {
  /** @type {unknown} */
  let caught;
  try {
    operation();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(PreloadBuildError);
  const error = /** @type {PreloadBuildError} */ (caught);
  expect(error.exitCode).toBe(exitCode);
  return error;
}

/**
 * This checkout's own output tree, as far as this suite can observe it: the sorted entries of
 * `dist/` and of the artefact's directory `dist/node/`, or `null` for one that does not exist.
 *
 * Used only by the two `main` cases that run against the real {@link PACKAGE_DIR}. What has to
 * hold for `--help` and for an unrecognised argument is that they write NOTHING - not that
 * `dist/` is absent. The root `verify` chain runs `pnpm build` before `pnpm test` and this
 * package's build writes `dist/index.js`, `dist/browser-agent.iife.js` and
 * `dist/node/register.mjs`, so an absence assertion would fail on a legitimate artefact rather
 * than on anything the tested command did. Invariance holds in either order, and it is the
 * stronger claim: it also fails if `main` ever created the output directory before parsing its
 * arguments.
 *
 * @returns {{ dist: string[] | null, node: string[] | null }}
 */
function snapshotPackageOutput() {
  /**
   * @param {string} directory
   * @returns {string[] | null}
   */
  const list = (directory) => {
    try {
      return fs.readdirSync(directory).sort();
    } catch {
      return null;
    }
  };

  return {
    dist: list(path.join(PACKAGE_DIR, 'dist')),
    node: list(path.join(PACKAGE_DIR, ...path.posix.dirname(OUTFILE_REL).split('/'))),
  };
}

/**
 * Run `main` against a fixture with both streams captured, so the exit code and the text can be
 * asserted together without the suite printing a build report.
 *
 * @param {readonly string[]} argv
 * @param {{ packageDir?: string }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function runMain(argv, options = {}) {
  const stdout = capture('stdout');
  const stderr = capture('stderr');
  try {
    const code = await main(argv, options);
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    stderr.restore();
    stdout.restore();
  }
}

/**
 * A synthetic metafile in the shape esbuild produces, for the audit tests.
 *
 * @param {{
 *   inputs?: readonly string[],
 *   outputs?: Record<string, { bytes?: number, imports?: { path: string, kind?: string, external?: boolean }[] }>,
 * }} [shape]
 * @returns {{ inputs: Record<string, unknown>, outputs: Record<string, { bytes?: number, imports?: { path: string, kind?: string, external?: boolean }[] }> }}
 */
function metafileFor({ inputs = [], outputs } = {}) {
  return {
    inputs: Object.fromEntries(inputs.map((input) => [input, { bytes: 64, imports: [] }])),
    outputs: outputs ?? { [OUTFILE_REL]: { bytes: 2048, imports: [] } },
  };
}

describe('resolveExportsPath', () => {
  it('accepts the plain-string form this package uses', () => {
    expect(resolveExportsPath(ARTEFACT)).toBe(ARTEFACT);
  });

  it('prefers node over import, module and default in a conditional object', () => {
    expect(
      resolveExportsPath({ default: './d.js', module: './m.js', import: './i.js', node: './n.js' }),
    ).toBe('./n.js');
    expect(resolveExportsPath({ default: './d.js', import: './i.js' })).toBe('./i.js');
    expect(resolveExportsPath({ default: './d.js' })).toBe('./d.js');
  });

  it('descends into a nested condition object', () => {
    expect(resolveExportsPath({ node: { import: './dist/node/register.mjs' } })).toBe(
      './dist/node/register.mjs',
    );
    expect(resolveExportsPath({ import: { node: { default: './deep.js' } } })).toBe('./deep.js');
  });

  it('returns undefined when no condition names a path', () => {
    expect(resolveExportsPath(undefined)).toBeUndefined();
    expect(resolveExportsPath(null)).toBeUndefined();
    expect(resolveExportsPath(42)).toBeUndefined();
    // `types` is not a runtime condition, so an entry that only declares it resolves to nothing.
    expect(resolveExportsPath({ types: './x.d.ts' })).toBeUndefined();
    expect(resolveExportsPath({ node: { types: './x.d.ts' } })).toBeUndefined();
  });
});

describe('verifyPackageContract: the manifest must agree with the artefact', () => {
  it('accepts the sound manifest', () => {
    expect(() => verifyPackageContract(baseManifest())).not.toThrow();
  });

  it('accepts the conditional-object form of the export, and a non-array sideEffects', () => {
    const manifest = baseManifest();
    manifest.exports = { [EXPORT_CONDITION]: { node: { import: ARTEFACT } } };
    // `sideEffects: false` is wrong for this package but is not this check's business: the clause
    // only fires for an array that omits the artefact, so a boolean must pass through untouched.
    manifest.sideEffects = false;

    expect(() => verifyPackageContract(manifest)).not.toThrow();
  });

  it('reports exit 2 when the export condition is absent', () => {
    const missingKey = baseManifest();
    missingKey.exports = { '.': './dist/index.js' };

    const error = expectFailure(() => verifyPackageContract(missingKey), 2);
    expect(error.message).toContain(`does not export "${EXPORT_CONDITION}"`);
    expect(error.hint).toContain(`"${EXPORT_CONDITION}": "${ARTEFACT}"`);

    const noExports = baseManifest();
    delete noExports.exports;
    expect(expectFailure(() => verifyPackageContract(noExports), 2).message).toContain(
      `does not export "${EXPORT_CONDITION}"`,
    );
  });

  it('reports exit 2 when the export points anywhere other than the artefact', () => {
    const manifest = baseManifest();
    manifest.exports = { [EXPORT_CONDITION]: './dist/node/preload.mjs' };

    const error = expectFailure(() => verifyPackageContract(manifest), 2);

    expect(error.message).toContain(`exports "${EXPORT_CONDITION}" as ./dist/node/preload.mjs`);
    expect(error.message).toContain(`this script writes ${ARTEFACT}`);
    expect(error.hint).toContain('scripts/dev-instrumented.mjs');
    expect(error.hint).toContain('launcher.ts');
  });

  it('reports exit 2 when sideEffects lists everything but the artefact', () => {
    const manifest = baseManifest();
    manifest.sideEffects = ['./dist/index.js'];

    const error = expectFailure(() => verifyPackageContract(manifest), 2);

    expect(error.message).toContain('"sideEffects" does not list');
    expect(error.message).toContain('tree-shake the preload away');
    expect(error.hint).toContain(ARTEFACT);
  });
});

describe('computeExternalPolicy: the external list is derived, never hand-written', () => {
  it('externalises every dependency but the inlined one, and every extra external', () => {
    const policy = computeExternalPolicy(baseManifest());

    expect(policy.inlined).toEqual([INLINED]);
    expect(policy.packages).not.toContain(INLINED);
    expect(policy.packages).toContain('@opentelemetry/api');
    for (const name of EXTRA_EXTERNALS) {
      expect(policy.packages).toContain(name);
    }
    // Sorted, so the build report and the esbuild option are stable between runs.
    expect(policy.packages).toEqual([...policy.packages].sort());
  });

  it('contributes both a bare and a subpath pattern for every external package', () => {
    const policy = computeExternalPolicy(baseManifest());

    expect(policy.patterns).toHaveLength(policy.packages.length * 2);
    // A bare `name` external does not cover a subpath import, and the OpenTelemetry
    // instrumentation loader reaches for exactly those.
    expect(policy.patterns).toContain('@opentelemetry/api');
    expect(policy.patterns).toContain('@opentelemetry/api/*');
    expect(policy.patterns).toContain('pg');
    expect(policy.patterns).toContain('pg/*');
  });

  it('reports exit 2 for a workspace dependency that is neither inlined nor explicitly external', () => {
    const manifest = baseManifest();
    manifest.dependencies = { [INLINED]: 'workspace:*', '@debuggen/protocol': 'workspace:*' };

    const error = expectFailure(() => computeExternalPolicy(manifest), 2);

    expect(error.message).toBe(
      'workspace dependency @debuggen/protocol is neither inlined nor explicitly external',
    );
    expect(error.hint).toContain('INLINED_WORKSPACE_DEPENDENCIES');
    expect(error.hint).toContain('EXTRA_EXTERNALS');
  });

  it('accepts a workspace dependency that is explicitly external', () => {
    const manifest = baseManifest();
    const explicit = EXTRA_EXTERNALS[0] ?? 'pg';
    manifest.dependencies = { [INLINED]: 'workspace:*', [explicit]: 'workspace:*' };

    const policy = computeExternalPolicy(manifest);

    expect(policy.packages).toContain(explicit);
    expect(policy.inlined).toEqual([INLINED]);
  });

  it('reports exit 2 when an inlined dependency is not declared in dependencies at all', () => {
    const manifest = baseManifest();
    manifest.dependencies = { '@opentelemetry/api': '1.9.1' };

    const error = expectFailure(() => computeExternalPolicy(manifest), 2);
    expect(error.message).toBe(
      `${INLINED} is configured to be bundled into the preload but is not a dependency of this package`,
    );

    // Same failure when the manifest declares no dependencies at all, which is the branch that
    // falls back to an empty map rather than throwing a TypeError.
    const none = baseManifest();
    delete none.dependencies;
    expect(expectFailure(() => computeExternalPolicy(none), 2).message).toContain(
      'is not a dependency of this package',
    );
  });
});

describe('verifyInlinedDependencyBuilt: an inlined workspace package has to be built first', () => {
  it('resolves the package through its symlink and returns its real directory', () => {
    const root = makeFixture();

    const resolved = verifyInlinedDependencyBuilt(INLINED, { packageDir: root });

    expect(resolved.name).toBe(INLINED);
    // The link target, so the build report can recognise the inputs it contributed.
    expect(resolved.dir).toBe(fs.realpathSync(path.join(root, 'vendor', 'shared')));
    expect(resolved.entryFile).toBe(
      path.join(root, 'node_modules', ...INLINED.split('/'), 'dist', 'index.js'),
    );
    expect(fs.existsSync(resolved.entryFile)).toBe(true);
  });

  it('reports exit 2 when the package is not installed', () => {
    const root = makeFixture({ dependency: null });

    const error = expectFailure(
      () => verifyInlinedDependencyBuilt(INLINED, { packageDir: root }),
      2,
    );

    expect(error.message).toContain(`${INLINED} is not installed under`);
    expect(error.hint).toContain('pnpm install');
  });

  it('reports exit 2 when the installed package has no manifest', () => {
    const root = makeFixture({ dependency: 'no-manifest' });

    const error = expectFailure(
      () => verifyInlinedDependencyBuilt(INLINED, { packageDir: root }),
      2,
    );

    expect(error.message).toContain(`${INLINED}'s package.json is missing`);
  });

  it('reports exit 2 when the manifest declares no importable entry point', () => {
    const root = makeFixture({ dependency: 'no-entry' });

    const error = expectFailure(
      () => verifyInlinedDependencyBuilt(INLINED, { packageDir: root }),
      2,
    );

    expect(error.message).toBe(`${INLINED} declares no importable entry point`);
    expect(error.hint).toContain(`pnpm --filter ${INLINED} build`);
  });

  it('reports exit 2 when the declared entry file has not been built', () => {
    const root = makeFixture({ dependency: 'unbuilt' });

    const error = expectFailure(
      () => verifyInlinedDependencyBuilt(INLINED, { packageDir: root }),
      2,
    );

    expect(error.message).toContain(`${INLINED} has not been built`);
    expect(error.message).toContain('dist/index.js is missing');
    expect(error.hint).toContain('pnpm -r build');
  });

  it('defaults to this package, so the CLI passes no argument', () => {
    expect(path.isAbsolute(PACKAGE_DIR)).toBe(true);
    expect(fs.existsSync(path.join(PACKAGE_DIR, 'esbuild.node.mjs'))).toBe(true);
    expect(REPO_ROOT).toBe(path.resolve(PACKAGE_DIR, '..', '..'));
  });
});

describe('preflight: every precondition reports exit 2', () => {
  it('rejects a missing manifest', () => {
    const root = makeFixture({ manifest: null });

    const error = expectFailure(() => preflight({ packageDir: root }), 2);

    expect(error.message).toContain("this package's package.json is missing");
    expect(error.hint).toContain('pnpm install');
    // Nothing was created: the failure is reported before a partial dist/node/ can exist.
    expect(fs.existsSync(path.join(root, 'dist'))).toBe(false);
  });

  it('rejects a manifest that is not valid JSON', () => {
    const root = makeFixture({ manifest: '{ "name": "broken", }\n' });

    const error = expectFailure(() => preflight({ packageDir: root }), 2);

    expect(error.message).toContain("this package's package.json is not valid JSON");
    expect(fs.existsSync(path.join(root, 'dist'))).toBe(false);
  });

  it('rejects a manifest that disagrees with the artefact', () => {
    const manifest = baseManifest();
    manifest.exports = { '.': './dist/index.js' };
    const root = makeFixture({ manifest });

    const error = expectFailure(() => preflight({ packageDir: root }), 2);

    expect(error.message).toContain(`does not export "${EXPORT_CONDITION}"`);
    expect(fs.existsSync(path.join(root, 'dist'))).toBe(false);
  });

  it('rejects a missing preload entry point', () => {
    const root = makeFixture({ entry: null });

    const error = expectFailure(() => preflight({ packageDir: root }), 2);

    expect(error.message).toBe(`the preload entry point is missing: ${ENTRY_REL}`);
    expect(error.hint).toContain('This script bundles that module; it does not create it.');
    expect(fs.existsSync(path.join(root, 'dist'))).toBe(false);
  });

  it('rejects a missing compiler configuration', () => {
    const root = makeFixture({ tsconfig: null });

    const error = expectFailure(() => preflight({ packageDir: root }), 2);

    expect(error.message).toContain(`${TSCONFIG_REL} is missing from`);
    expect(error.message).toContain(root);
    expect(error.hint).toContain('esbuild reads the workspace tsconfig');
  });

  it('rejects an inlined workspace dependency that has not been built', () => {
    const root = makeFixture({ dependency: 'unbuilt' });

    const error = expectFailure(() => preflight({ packageDir: root }), 2);

    expect(error.message).toContain(`${INLINED} has not been built`);
    expect(fs.existsSync(path.join(root, 'dist'))).toBe(false);
  });
});

describe('preflight: the one step that acts rather than checks reports exit 1', () => {
  it('reports the failing mkdir as a build failure, not a precondition failure', () => {
    const root = makeFixture();
    // A regular file where dist/ has to be a directory: the same I/O failure
    // esbuild.agent.mjs's ensureOutputDirectory lets escape as exit 1, so the pair agrees.
    fs.writeFileSync(path.join(root, 'dist'), 'NOT-A-DIRECTORY\n', 'utf8');

    const error = expectFailure(() => preflight({ packageDir: root }), 1);

    expect(error.message).toContain(`could not create ${path.posix.dirname(OUTFILE_REL)}/`);
    expect(error.message).toContain('ENOTDIR');
    expect(error.hint).toBeUndefined();
    expect(fs.readFileSync(path.join(root, 'dist'), 'utf8')).toBe('NOT-A-DIRECTORY\n');
  });
});

describe('preflight: the context a sound package produces', () => {
  it('resolves every path against the given package root and creates the output directory', () => {
    const root = makeFixture();

    const context = preflight({ packageDir: root });

    expect(context.packageDir).toBe(root);
    expect(context.manifest.name).toBe('@debuggen/telemetry-fixture');
    expect(context.entry).toBe(path.join(root, ...ENTRY_REL.split('/')));
    expect(context.outfile).toBe(path.join(root, ...OUTFILE_REL.split('/')));
    expect(context.outfileKey).toBe(OUTFILE_REL);
    expect(context.tsconfig).toBe(path.join(root, TSCONFIG_REL));
    expect(context.policy.inlined).toEqual([INLINED]);
    expect(context.inlinedRoots).toEqual([
      { name: INLINED, dir: fs.realpathSync(path.join(root, 'vendor', 'shared')) },
    ]);
    expect(fs.statSync(path.dirname(context.outfile)).isDirectory()).toBe(true);
  });
});

describe('createBuildOptions: the configuration the artefact depends on', () => {
  it('anchors the build to the context package root and states every option', () => {
    const root = makeFixture();
    const context = preflight({ packageDir: root });

    const options = createBuildOptions(context);

    expect(options.absWorkingDir).toBe(root);
    expect(options.entryPoints).toEqual([context.entry]);
    expect(options.outfile).toBe(context.outfile);
    expect(options.format).toBe('esm');
    expect(options.platform).toBe('node');
    expect(options.target).toEqual([NODE_TARGET]);
    expect(options.external).toEqual(context.policy.patterns);
    expect(options.sourcemap).toBe(true);
    expect(options.sourcesContent).toBe(true);
    // Read by the developer in their own server logs, so neither minified nor renamed.
    expect(options.minify).toBe(false);
    expect(options.keepNames).toBe(true);
    expect(options.splitting).toBe(false);
    expect(options.tsconfig).toBe(context.tsconfig);
    expect(options.metafile).toBe(true);
    expect(options.plugins).toEqual([]);
    // No define, no banner: two builds of the same sources are byte-identical.
    expect(options.define).toBeUndefined();
    expect(options.banner).toBeUndefined();
  });

  it('falls back to this package when a context carries no packageDir', () => {
    const options = createBuildOptions({
      entry: 'entry.ts',
      outfile: 'out.mjs',
      outfileKey: OUTFILE_REL,
      tsconfig: 'tsconfig.json',
      policy: { packages: [], patterns: [], inlined: [] },
      inlinedRoots: [],
      manifest: {},
    });

    expect(options.absWorkingDir).toBe(PACKAGE_DIR);
  });
});

describe('auditMetafile: the externalisation policy, stated as findings', () => {
  it('returns nothing for a sound bundle', () => {
    const metafile = metafileFor({
      inputs: ['src/node/register.ts', 'src/node/exporter.ts', 'vendor/shared/dist/index.js'],
      outputs: {
        [OUTFILE_REL]: { bytes: 4096, imports: [{ path: '@opentelemetry/api', external: true }] },
        [`${OUTFILE_REL}.map`]: { bytes: 8192 },
      },
    });

    expect(auditMetafile(metafile, { packageDir: '/fixture', repoRoot: '/repo' })).toEqual([]);
  });

  it('reports a forbidden package that was bundled instead of left external', () => {
    const input = '../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/index.js';

    const findings = auditMetafile(metafileFor({ inputs: ['src/node/register.ts', input] }), {
      packageDir: '/fixture',
      repoRoot: '/repo',
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(input);
    expect(findings[0]).toContain('pg must stay external');
    expect(findings[0]).toContain('silently produces no spans');
  });

  it('reports an input from the browser agent subtree', () => {
    const findings = auditMetafile(
      metafileFor({ inputs: ['src/node/register.ts', 'src/browser/dom-target.ts'] }),
      { packageDir: '/fixture', repoRoot: '/repo' },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('src/browser/dom-target.ts was bundled from src/browser/');
    expect(findings[0]).toContain('must not carry DOM code');
  });

  it('reports an input from an application, which sits above every package', () => {
    // Resolved against the real package and repository roots, which is the spelling esbuild
    // reports for a cross-workspace input: `../../apps/...`.
    const findings = auditMetafile(
      metafileFor({ inputs: ['../../apps/demo-app/src/lib/types.ts'] }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('was bundled from apps/');
    expect(findings[0]).toContain('may only depend on packages/**');
  });

  it('reports an output set that does not contain the artefact', () => {
    const findings = auditMetafile(
      metafileFor({
        inputs: ['src/node/register.ts'],
        outputs: { 'dist/node/preload.mjs': { bytes: 512, imports: [] } },
      }),
      { packageDir: '/fixture', repoRoot: '/repo' },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('but not dist/node/register.mjs');
    expect(findings[0]).toContain("the package's exports map");
  });

  it('reports a chunk import, which would break the --import contract', () => {
    const findings = auditMetafile(
      metafileFor({
        inputs: ['src/node/register.ts'],
        outputs: {
          [OUTFILE_REL]: {
            bytes: 4096,
            imports: [{ path: './chunk-QK7A.mjs', kind: 'import-statement' }],
          },
        },
      }),
      { packageDir: '/fixture', repoRoot: '/repo' },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('imports ./chunk-QK7A.mjs from another chunk');
    expect(findings[0]).toContain('splitting must stay off');
  });

  it("reports an external import of the browser agent's runtime", () => {
    const findings = auditMetafile(
      metafileFor({
        inputs: ['src/node/register.ts'],
        outputs: {
          [OUTFILE_REL]: {
            bytes: 4096,
            imports: [
              { path: '@opentelemetry/api', external: true },
              { path: 'react-dom/client', external: true },
            ],
          },
          // A `.map` output is skipped, so a source map's own imports never produce a finding.
          [`${OUTFILE_REL}.map`]: {
            bytes: 8192,
            imports: [{ path: 'bippy', external: true }],
          },
        },
      }),
      { packageDir: '/fixture', repoRoot: '/repo' },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('imports react-dom/client');
    expect(findings[0]).toContain("belongs to the browser agent's runtime");
  });

  it('reports every violation of a bundle that broke several rules at once', () => {
    const findings = auditMetafile(
      metafileFor({
        inputs: [
          'src/node/register.ts',
          '../../node_modules/next/dist/server/next.js',
          'src/browser/agent.ts',
        ],
        outputs: {
          [OUTFILE_REL]: {
            bytes: 4096,
            imports: [{ path: './chunk-A.mjs', kind: 'import-statement' }],
          },
        },
      }),
      { packageDir: '/fixture', repoRoot: '/repo' },
    );

    expect(findings).toHaveLength(3);
  });
});

describe('the policy vocabularies the audit is written against', () => {
  it('names the target project modules that must never be inlined', () => {
    // Without this, dropping a name from the list would silently pass every test above: each
    // finding is produced by membership, so the membership itself is what has to be pinned.
    expect([...FORBIDDEN_INLINE_PACKAGES]).toEqual([
      'pg',
      '@prisma/client',
      'next',
      'import-in-the-middle',
      'require-in-the-middle',
    ]);
    expect(Object.isFrozen(FORBIDDEN_INLINE_PACKAGES)).toBe(true);
  });

  it("names the browser agent's packages and directories as off limits to the preload", () => {
    expect([...FORBIDDEN_IMPORT_PACKAGES]).toEqual(['bippy', 'react', 'react-dom']);
    expect([...FORBIDDEN_INPUT_DIRECTORIES]).toEqual(['src/browser']);
    expect([...FORBIDDEN_INPUT_REPO_DIRECTORIES]).toEqual(['apps']);
    expect(Object.isFrozen(FORBIDDEN_IMPORT_PACKAGES)).toBe(true);
  });

  it('keeps the module-hooking libraries and the target project modules external', () => {
    // These three register Node loader hooks and patch `Module._load`, so they have to exist as
    // real on-disk modules; bundling one breaks ESM hooking silently.
    for (const name of ['import-in-the-middle', 'require-in-the-middle', 'shimmer']) {
      expect(EXTRA_EXTERNALS).toContain(name);
    }
    for (const name of ['pg', '@prisma/client', 'prisma', 'next', 'react', 'react-dom']) {
      expect(EXTRA_EXTERNALS).toContain(name);
    }
    expect(Object.isFrozen(EXTRA_EXTERNALS)).toBe(true);
    expect([...INLINED_WORKSPACE_DEPENDENCIES]).toEqual(['@debuggen/shared']);
  });
});

describe('auditBundleText', () => {
  it('reports the esbuild require shim, with both ways out', () => {
    const findings = auditBundleText(
      'var __require = (x) => { throw Error(`Dynamic require of "${x}" is not supported`); };\n',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('require() shim');
    expect(findings[0]).toContain('EXTRA_EXTERNALS');
    expect(findings[0]).toContain('createRequire');
  });

  it('returns nothing for a bundle that needs no require at runtime', () => {
    expect(auditBundleText("import { trace } from '@opentelemetry/api';\n")).toEqual([]);
  });
});

describe('packageNameFromInput', () => {
  it('names the package after the last node_modules segment, pnpm store included', () => {
    expect(
      packageNameFromInput('../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/index.js'),
    ).toBe('pg');
    expect(
      packageNameFromInput(
        '../../node_modules/.pnpm/@opentelemetry+api@1.9.1/node_modules/@opentelemetry/api/build/src/index.js',
      ),
    ).toBe('@opentelemetry/api');
    expect(packageNameFromInput('node_modules/nanoid/index.js')).toBe('nanoid');
  });

  it('returns undefined for first-party sources and for a truncated path', () => {
    expect(packageNameFromInput('src/node/register.ts')).toBeUndefined();
    expect(packageNameFromInput('../shared/dist/index.js')).toBeUndefined();
    expect(packageNameFromInput('../../node_modules/')).toBeUndefined();
    expect(packageNameFromInput('../../node_modules/@debuggen')).toBeUndefined();
  });
});

describe('packageNameFromSpecifier', () => {
  it('names the package a bare import resolves to', () => {
    expect(packageNameFromSpecifier('pg')).toBe('pg');
    expect(packageNameFromSpecifier('pg/lib/index.js')).toBe('pg');
    expect(packageNameFromSpecifier('@opentelemetry/instrumentation/hook.mjs')).toBe(
      '@opentelemetry/instrumentation',
    );
  });

  it('returns undefined for a builtin, a relative path and an absolute path', () => {
    expect(packageNameFromSpecifier('node:async_hooks')).toBeUndefined();
    expect(packageNameFromSpecifier('./exporter.js')).toBeUndefined();
    expect(packageNameFromSpecifier('../convert.js')).toBeUndefined();
    expect(packageNameFromSpecifier('/abs/register.mjs')).toBeUndefined();
    expect(packageNameFromSpecifier('')).toBeUndefined();
    expect(packageNameFromSpecifier('@debuggen')).toBeUndefined();
  });
});

describe('describeBuild', () => {
  it('reports the artefact, what was inlined, the policy and the imports it kept', () => {
    const root = makeFixture();
    const context = preflight({ packageDir: root });
    const metafile = /** @type {import('esbuild').Metafile} */ (
      /** @type {unknown} */ ({
        inputs: {
          'src/node/register.ts': { bytes: 256, imports: [] },
          'vendor/shared/dist/index.js': { bytes: 64, imports: [] },
        },
        outputs: {
          [OUTFILE_REL]: {
            bytes: 4096,
            imports: [{ path: '@opentelemetry/api', external: true }],
          },
          [`${OUTFILE_REL}.map`]: { bytes: 8192, imports: [] },
        },
      })
    );

    const report = describeBuild(context, metafile);

    expect(report).toContain(`telemetry preload  ${OUTFILE_REL}  4.1 kB`);
    expect(report).toContain('(+ source map 8.2 kB)');
    expect(report).toContain(`entry      ${ENTRY_REL} → ESM, ${NODE_TARGET}`);
    // The inlined workspace package is recognised by the directory recorded at preflight, which
    // is how it is told apart from this package's own sources after symlink resolution.
    expect(report).toContain(`bundled    2 module(s) inlined: src/node/** + ${INLINED}`);
    expect(report).toContain('imports    @opentelemetry/api');
    expect(report).toContain('audit      no forbidden input, no chunk import, no require() shim');
  });
});

describe('the command-line surface', () => {
  it('parses the documented flags', () => {
    expect(parseArgs([])).toEqual({ help: false, watch: false });
    expect(parseArgs(['--watch'])).toEqual({ help: false, watch: true });
    expect(parseArgs(['-w', '-h'])).toEqual({ help: true, watch: true });
    expect(parseArgs(['--help'])).toEqual({ help: true, watch: false });
  });

  it('treats an unrecognised argument as a usage error rather than forwarding it', () => {
    const error = expectFailure(() => parseArgs(['--minify']), 2);

    expect(error.message).toBe('unrecognised argument: --minify');
    expect(error.showUsage).toBe(true);
  });

  it('documents the artefact, the externalisation policy and all three exit codes', () => {
    const text = usage();

    expect(text).toContain(OUTFILE_REL);
    expect(text).toContain(ENTRY_REL);
    expect(text).toContain('Externalisation policy (audited after every build)');
    expect(text).toContain('0   success');
    expect(text).toContain('1   the build ran and its result was rejected');
    expect(text).toContain('2   nothing was built');
  });

  it('prints usage for --help and returns 0 without touching the filesystem', async () => {
    const outputBefore = snapshotPackageOutput();

    const { code, stdout } = await runMain(['--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('Externalisation policy (audited after every build)');
    // `--help` and an unrecognised flag are the only arguments safe to run against the real
    // package: neither reaches preflight, so this checkout's output tree must be byte-for-byte
    // the same set of entries afterwards - whether or not `pnpm build` has already filled it.
    expect(snapshotPackageOutput()).toEqual(outputBefore);
  });

  it('returns 2 for an unrecognised flag and prints the usage text with it', async () => {
    const outputBefore = snapshotPackageOutput();

    const { code, stderr } = await runMain(['--bogus']);

    expect(code).toBe(2);
    expect(stderr).toContain('esbuild.node: unrecognised argument: --bogus');
    expect(stderr).toContain('Usage');
    // Unchanged rather than absent, for the reason given in the --help case above: parseArgs
    // rejects the argument before preflight's mkdir, so nothing here may move either way.
    expect(snapshotPackageOutput()).toEqual(outputBefore);
  });
});

describe('main: the exit code the build script and CI read', () => {
  it('returns 2 when a precondition does not hold, building nothing', async () => {
    const root = makeFixture({ entry: null });

    const { code, stdout, stderr } = await runMain([], { packageDir: root });

    expect(code).toBe(2);
    expect(stderr).toContain(`esbuild.node: the preload entry point is missing: ${ENTRY_REL}`);
    expect(stdout).toBe('');
    expect(fs.existsSync(path.join(root, 'dist'))).toBe(false);
  });

  it('returns 1 when the build ran and the audit rejected its result', async () => {
    const root = makeFixture({
      entry: "export { browserMarker } from '../browser/marker.ts';\n",
      browserModule: "export const browserMarker = 'agent';\n",
    });

    const { code, stdout, stderr } = await runMain([], { packageDir: root });

    // The build itself succeeded - esbuild wrote a bundle - and the audit rejected it, which is
    // exit 1 rather than exit 2: something WAS built.
    expect(code).toBe(1);
    expect(stderr).toContain('violates the externalisation policy (1 finding)');
    expect(stderr).toContain('src/browser/marker.ts was bundled from src/browser/');
    // The report is printed only for an accepted bundle.
    expect(stdout).toBe('');
  });

  it('returns 1 when esbuild cannot build the entry at all', async () => {
    const root = makeFixture({ entry: 'export const broken = ;\n' });

    const { code, stderr } = await runMain([], { packageDir: root });

    expect(code).toBe(1);
    expect(stderr).toContain('esbuild.node: the preload bundle failed to build');
    expect(stderr).toContain('Unexpected ";"');
  });

  it('returns 0 for a sound package, writing the artefact and its source map', async () => {
    const root = makeFixture();

    const { code, stdout, stderr } = await runMain([], { packageDir: root });

    expect(code).toBe(0);
    expect(stderr).toBe('');

    const artefact = path.join(root, ...OUTFILE_REL.split('/'));
    expect(fs.existsSync(artefact)).toBe(true);
    expect(fs.existsSync(`${artefact}.map`)).toBe(true);

    const bundle = fs.readFileSync(artefact, 'utf8');
    // The inlined dependency's source is in the bundle; the external one is still a bare import
    // Node resolves at runtime, which is what lets the instrumentations patch the developer's own
    // module instances.
    expect(bundle).toContain('shared-stand-in');
    expect(bundle).toContain('from "@opentelemetry/api"');
    expect(bundle).not.toContain('Dynamic require of');

    expect(stdout).toContain(`telemetry preload  ${OUTFILE_REL}`);
    expect(stdout).toContain(`+ ${INLINED}`);
    expect(stdout).toContain('imports    @opentelemetry/api');
    expect(stdout).toContain('audit      no forbidden input, no chunk import, no require() shim');
  });
});
