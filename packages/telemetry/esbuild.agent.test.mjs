/**
 * esbuild.agent.test.mjs
 *
 * The proof that `packages/telemetry/esbuild.agent.mjs` - the bundler of the page-injected browser
 * agent - reports the exit code its own documentation promises, and that the import boundary it
 * advertises is enforced rather than described.
 *
 * WHAT THIS SUITE OWNS. One three-valued contract, shared verbatim with `esbuild.node.mjs` and
 * read by `package.json`'s `build` script and by CI:
 *
 *   0  the artifact was written and passed the import-boundary audit, or `--help` printed;
 *   1  the build ran and its result was rejected - esbuild reported errors, or the audit rejected
 *      the bundle - and `dist/browser-agent.iife.js` was NOT written;
 *   2  nothing was built, because the argument list was not understood or a precondition does not
 *      hold: the entry point missing, or occupied by something that is not a regular file.
 *
 * The 1-versus-2 split is the part that needed covering. A missing or non-regular entry point is
 * exit 2 because no bundle was ever produced, while a bundle that esbuild or the audit rejects is
 * exit 1 because the build did run and its output was thrown away. Both codes sit on paths a
 * successful CI build never takes, so nothing but a test can hold them in place - and both are
 * asserted here as the literal numbers 0/1/2, so a change to the exported {@link EXIT_OK} /
 * {@link EXIT_FAILURE} / {@link EXIT_USAGE} constants fails this suite rather than silently
 * agreeing with it.
 *
 * WHY EVERY FIXTURE IS A THROWAWAY TREE. Every seam of the module under test takes
 * `{ packageRoot }`, defaulting to the real package, precisely so it can be pointed at a fixture.
 * Each test below builds a miniature package - `src/browser/agent.ts` plus a self-contained
 * `tsconfig.json`, and a `node_modules/` entry where a forbidden input is the point - under
 * `fs.mkdtempSync(os.tmpdir())`, never inside this checkout, whose `git status` must stay clean and
 * whose `packages/telemetry/dist/` must not be conjured into existence by a test run. `afterEach`
 * removes every root the test created, including the ones a failing assertion left behind. That is
 * also why `main` is exercised only with `--help` and with an unrecognised flag: it resolves its
 * paths from the real {@link PACKAGE_ROOT}, and those two arguments are the ones that read and
 * write nothing at all. Those two cases assert that this checkout's `dist/` is UNCHANGED, never
 * that it is absent - the root `verify` chain runs `pnpm build` before `pnpm test`, so by then the
 * directory legitimately holds `browser-agent.iife.js`, and an absence assertion would fail on
 * that artifact rather than on anything the tested command did.
 *
 * WHY SOME OF THE BUILDS ARE REAL. Four of them run esbuild against a fixture on disk, because the
 * codes being pinned are produced by the interaction between esbuild's result, the `node:*`
 * resolve guard and the metafile audit - and `write: false` in `createBuildOptions` means "nothing
 * was written" is only observable end to end. The fixture entries are two or three lines each, so
 * each build costs milliseconds. The rule-matching logic of the audit itself is exercised
 * separately against synthetic metafiles, which is what makes the pnpm virtual-store and
 * workspace spellings of a forbidden dependency testable without installing one.
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
  AgentBuildError,
  BANNER,
  ENTRY_REL,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  FORBIDDEN_INPUTS,
  NODE_BUILTIN_MODULES,
  OUTFILE_REL,
  OUTPUT_DIR_REL,
  PACKAGE_ROOT,
  REPO_ROOT,
  assertEntryExists,
  auditInputs,
  buildAgent,
  createBuildOptions,
  describeSuccess,
  describeViolations,
  ensureOutputDirectory,
  findImportChain,
  isNodeBuiltinSpecifier,
  main,
  parseArgs,
  usage,
  watchAgent,
} from './esbuild.agent.mjs';

/**
 * A minimal, valid browser agent: side-effect only, no imports, nothing a Node runtime is needed
 * for. Two lines is enough to make the build genuine while keeping it instantaneous.
 */
const CLEAN_ENTRY = "globalThis.name = 'debuggen-agent-fixture';\nexport {};\n";

/**
 * A self-contained compiler configuration for the fixture. It deliberately `extends` nothing:
 * esbuild follows the `extends` chain, and a fixture that reached for `tsconfig.base.json` would
 * couple every build here to a file outside the temporary root.
 */
const FIXTURE_TSCONFIG = `${JSON.stringify(
  { compilerOptions: { target: 'es2017', module: 'esnext', verbatimModuleSyntax: true } },
  null,
  2,
)}\n`;

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
 * Build a throwaway package root and register it for cleanup.
 *
 * @param {{ entry?: string | null }} [options] `entry` is the contents of
 *   `src/browser/agent.ts`; `null` leaves the file absent, which is the precondition failure the
 *   exit-2 tests need. `null` rather than `undefined`, because a defaulted destructuring parameter
 *   treats `undefined` as "not passed" and would quietly write the clean entry instead.
 * @returns {string} absolute path of the fixture root
 */
function makeRoot({ entry = CLEAN_ENTRY } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esbuild-agent-test-'));
  roots.push(root);

  fs.mkdirSync(path.join(root, path.dirname(ENTRY_REL)), { recursive: true });
  if (entry !== null) fs.writeFileSync(path.join(root, ENTRY_REL), entry, 'utf8');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');

  return root;
}

/**
 * Install a stand-in package inside a fixture's `node_modules`, so a real build can import a name
 * the audit forbids without the fixture depending on the module being installed anywhere.
 *
 * @param {string} root fixture root
 * @param {string} name package name, `@scope/name` included
 * @param {string} source contents of its entry module
 * @returns {string} absolute path of the entry module
 */
function installStandIn(root, name, source) {
  const directory = path.join(root, 'node_modules', ...name.split('/'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name, version: '0.0.0', type: 'module', main: './index.js' }, null, 2)}\n`,
    'utf8',
  );
  const entry = path.join(directory, 'index.js');
  fs.writeFileSync(entry, source, 'utf8');
  return entry;
}

/** Absolute path of the artifact inside a fixture root. @param {string} root @returns {string} */
function artifact(root) {
  return path.join(root, OUTFILE_REL);
}

/**
 * Entries of the fixture's output directory, sorted, or `undefined` when it does not exist. A
 * rejected build must leave either nothing or an empty `dist/` - never a bundle.
 *
 * @param {string} root
 * @returns {string[] | undefined}
 */
function listOutputDirectory(root) {
  try {
    return fs.readdirSync(path.join(root, OUTPUT_DIR_REL)).sort();
  } catch {
    return undefined;
  }
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
 * Await `operation`, require it to reject with an {@link AgentBuildError} carrying `exitCode`, and
 * hand the error back for message assertions.
 *
 * @param {() => Promise<unknown>} operation
 * @param {number} exitCode the literal code, never the imported constant
 * @returns {Promise<AgentBuildError>}
 */
async function expectRejection(operation, exitCode) {
  /** @type {unknown} */
  let caught;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(AgentBuildError);
  const error = /** @type {AgentBuildError} */ (caught);
  expect(error.exitCode).toBe(exitCode);
  return error;
}

/**
 * A synthetic metafile in the shape esbuild produces: one entry-point output plus a chain of
 * inputs. `chain` is walked in order, each input importing the next, which is what
 * {@link findImportChain} reconstructs.
 *
 * @param {readonly string[]} chain metafile input keys, entry point first
 * @param {readonly string[]} [extra] further inputs with no import edges
 * @returns {import("esbuild").Metafile}
 */
function metafileFor(chain, extra = []) {
  /** @type {Record<string, { bytes: number, imports: { path: string, kind: string }[], format?: string }>} */
  const inputs = {};
  for (const [index, input] of chain.entries()) {
    const next = chain[index + 1];
    inputs[input] = {
      bytes: 128,
      imports: next === undefined ? [] : [{ path: next, kind: 'import-statement' }],
    };
  }
  for (const input of extra) {
    inputs[input] = { bytes: 64, imports: [] };
  }

  return /** @type {import("esbuild").Metafile} */ ({
    inputs,
    outputs: {
      [OUTFILE_REL]: {
        imports: [],
        exports: [],
        entryPoint: chain[0],
        inputs: Object.fromEntries(
          Object.keys(inputs).map((input) => [input, { bytesInOutput: 8 }]),
        ),
        bytes: 1024,
      },
    },
  });
}

describe('the exit-code convention', () => {
  it('pins the three codes to the numbers esbuild.node.mjs reports for the same conditions', () => {
    // Asserted as literals on purpose: the two build scripts of this package agree on 0/1/2 by
    // convention rather than by a shared import, so the numbers are what has to be held.
    expect(EXIT_OK).toBe(0);
    expect(EXIT_FAILURE).toBe(1);
    expect(EXIT_USAGE).toBe(2);
  });

  it('defaults AgentBuildError to the build-failure code and carries what the CLI prints', () => {
    const plain = new AgentBuildError('rejected');
    expect(plain.exitCode).toBe(1);
    expect(plain.name).toBe('AgentBuildError');
    expect(plain.hint).toBeUndefined();
    expect(plain.showUsage).toBe(false);

    const precondition = new AgentBuildError('nothing built', {
      exitCode: 2,
      hint: 'do this',
      showUsage: true,
    });
    expect(precondition.exitCode).toBe(2);
    expect(precondition.hint).toBe('do this');
    expect(precondition.showUsage).toBe(true);
  });
});

describe('assertEntryExists: the precondition that reports exit 2', () => {
  it('rejects an absent entry point with the recovery hint and touches nothing', async () => {
    const root = makeRoot({ entry: null });

    const error = await expectRejection(() => assertEntryExists({ packageRoot: root }), 2);

    expect(error.message).toBe(`the agent entry point is missing: ${ENTRY_REL}`);
    expect(error.hint).toContain(ENTRY_REL);
    expect(error.hint).toContain('document_start');
    // The check runs before the output directory is created, so a precondition failure cannot
    // leave a dist/ behind for scripts/copy-agent.mjs to find.
    expect(listOutputDirectory(root)).toBeUndefined();
  });

  it('rejects an entry point occupied by a directory, with its own message', async () => {
    const root = makeRoot({ entry: null });
    fs.mkdirSync(path.join(root, ENTRY_REL), { recursive: true });

    const error = await expectRejection(() => assertEntryExists({ packageRoot: root }), 2);

    expect(error.message).toBe(`the agent entry point is not a regular file: ${ENTRY_REL}`);
    expect(error.message).not.toContain('is missing');
    expect(error.hint).toContain('Remove whatever occupies');
  });

  it('resolves for a regular file', async () => {
    const root = makeRoot();

    await expect(assertEntryExists({ packageRoot: root })).resolves.toBeUndefined();
  });

  it('is checked before a watch session starts, so --watch fails the same way', async () => {
    const root = makeRoot({ entry: null });

    // No watcher and no esbuild context are created: the precondition is asserted first, which is
    // what keeps `--watch` from sitting resident over a package that cannot be built at all.
    const error = await expectRejection(() => watchAgent({ packageRoot: root, quiet: true }), 2);

    expect(error.message).toBe(`the agent entry point is missing: ${ENTRY_REL}`);
    expect(listOutputDirectory(root)).toBeUndefined();
  });
});

describe('ensureOutputDirectory', () => {
  it('creates the output directory and is idempotent', async () => {
    const root = makeRoot();

    const directory = await ensureOutputDirectory({ packageRoot: root });

    expect(directory).toBe(path.join(root, OUTPUT_DIR_REL));
    expect(fs.statSync(directory).isDirectory()).toBe(true);
    // tsup cleans dist/ before this script runs, and a watch session outlives that, so a second
    // call must not throw.
    await expect(ensureOutputDirectory({ packageRoot: root })).resolves.toBe(directory);
  });
});

describe('buildAgent: exit 0 for a bundle that passes the audit', () => {
  it('writes the artifact with the fixed banner and reports the success line', async () => {
    const root = makeRoot();
    const stdout = capture('stdout');

    /** @type {number} */
    let code;
    try {
      code = await buildAgent({ packageRoot: root });
    } finally {
      stdout.restore();
    }

    expect(code).toBe(0);

    const written = fs.readFileSync(artifact(root), 'utf8');
    expect(written.startsWith(BANNER)).toBe(true);
    expect(written).toContain('debuggen-agent-fixture');
    expect(listOutputDirectory(root)).toEqual([path.basename(OUTFILE_REL)]);

    // The success line is the only thing on stdout, and it names the artifact and its size.
    expect(stdout.text()).toContain(OUTFILE_REL);
    expect(stdout.text()).toContain('input');
    expect(stdout.text().trimEnd().split('\n')).toHaveLength(1);
  });

  it('suppresses the success line under --quiet while still writing the artifact', async () => {
    const root = makeRoot();
    const stdout = capture('stdout');

    /** @type {number} */
    let code;
    try {
      code = await buildAgent({ packageRoot: root, quiet: true });
    } finally {
      stdout.restore();
    }

    expect(code).toBe(0);
    expect(stdout.text()).toBe('');
    expect(fs.existsSync(artifact(root))).toBe(true);
  });
});

describe('buildAgent: exit 1 for a build whose result is rejected', () => {
  it('reports esbuild errors and writes nothing for an entry it cannot parse', async () => {
    const root = makeRoot({ entry: 'export const broken = ;\n' });
    const stderr = capture('stderr');

    /** @type {number} */
    let code;
    try {
      code = await buildAgent({ packageRoot: root, quiet: true });
    } finally {
      stderr.restore();
    }

    expect(code).toBe(1);
    expect(stderr.text()).toContain('Unexpected ";"');
    expect(stderr.text()).toContain(`${OUTFILE_REL} was not written`);
    // `write: false` is what makes this observable: the bundle never reaches disk, so dist/ is
    // created but stays empty.
    expect(fs.existsSync(artifact(root))).toBe(false);
    expect(listOutputDirectory(root)).toEqual([]);
  });

  it('refuses a Node builtin by naming the rule and the importing file', async () => {
    const root = makeRoot({
      entry: "import { createHash } from 'node:crypto';\nglobalThis.name = typeof createHash;\n",
    });
    const stderr = capture('stderr');

    /** @type {number} */
    let code;
    try {
      code = await buildAgent({ packageRoot: root, quiet: true });
    } finally {
      stderr.restore();
    }

    expect(code).toBe(1);
    expect(stderr.text()).toContain('must not import the Node builtin "node:crypto"');
    expect(stderr.text()).toContain(`imported by ${ENTRY_REL}`);
    expect(stderr.text()).toContain('Never add a builtin polyfill');
    expect(fs.existsSync(artifact(root))).toBe(false);
    expect(listOutputDirectory(root)).toEqual([]);
  });

  it('rejects a bundle that reached a forbidden input, with the rule reason and the chain', async () => {
    const root = makeRoot({
      entry: "import { z } from 'zod';\nglobalThis.name = String(z);\nexport {};\n",
    });
    installStandIn(root, 'zod', "export const z = 'stand-in-validator';\n");
    const stderr = capture('stderr');

    /** @type {number} */
    let code;
    try {
      code = await buildAgent({ packageRoot: root, quiet: true });
    } finally {
      stderr.restore();
    }

    // The build itself succeeded - esbuild produced a bundle - and the audit threw it away, which
    // is exit 1 rather than exit 2: something WAS built.
    expect(code).toBe(1);
    expect(stderr.text()).toContain('reached 1 forbidden input across 1 rule');
    expect(stderr.text()).toContain('zod — 1 input');
    expect(stderr.text()).toContain('Validation happens once, at ingest in the local service');
    expect(stderr.text()).toContain('imported via');
    expect(stderr.text()).toContain('zod/index.js');
    expect(fs.existsSync(artifact(root))).toBe(false);
    expect(listOutputDirectory(root)).toEqual([]);
  });
});

describe('createBuildOptions: the decisions the audit depends on', () => {
  it('anchors the build to the given package root and inlines everything', () => {
    const options = createBuildOptions({ packageRoot: '/fixture/telemetry' });

    expect(options.absWorkingDir).toBe('/fixture/telemetry');
    expect(options.entryPoints).toEqual([ENTRY_REL]);
    expect(options.outfile).toBe(OUTFILE_REL);
    expect(options.external).toEqual([]);
    expect(options.format).toBe('iife');
    expect(options.platform).toBe('browser');
    expect(options.splitting).toBe(false);
    expect(options.metafile).toBe(true);
    // Held in memory until the audit clears it: this is why a rejected bundle cannot leave an
    // artifact behind.
    expect(options.write).toBe(false);
    expect(options.banner).toEqual({ js: BANNER });
    expect(options.minify).toBe(true);
    expect(options.sourcemap).toBe(false);
    // logLimit 0 keeps the builtin guard from truncating its list at esbuild's default ten.
    expect(options.logLimit).toBe(0);
  });

  it('opts a --dev build out of minification and into an inline source map', () => {
    const options = createBuildOptions({ dev: true, packageRoot: '/fixture/telemetry' });

    expect(options.minify).toBe(false);
    expect(options.sourcemap).toBe('inline');
    expect(options.banner).toEqual({ js: BANNER });
  });

  it('defaults the package root to this package, so the CLI needs no argument', () => {
    expect(createBuildOptions().absWorkingDir).toBe(PACKAGE_ROOT);
    expect(path.isAbsolute(PACKAGE_ROOT)).toBe(true);
    expect(fs.existsSync(path.join(PACKAGE_ROOT, 'esbuild.agent.mjs'))).toBe(true);
    expect(REPO_ROOT).toBe(path.resolve(PACKAGE_ROOT, '..', '..'));
  });
});

describe('isNodeBuiltinSpecifier: what the resolve guard treats as a builtin', () => {
  it('matches the prefixed form, bare names and subpaths', () => {
    expect(isNodeBuiltinSpecifier('node:fs')).toBe(true);
    expect(isNodeBuiltinSpecifier('node:sqlite')).toBe(true);
    expect(isNodeBuiltinSpecifier('fs')).toBe(true);
    expect(isNodeBuiltinSpecifier('fs/promises')).toBe(true);
    expect(isNodeBuiltinSpecifier('worker_threads')).toBe(true);
    // Reachable only through the prefix in `builtinModules`, listed explicitly by the guard, so
    // the bare-name spelling is caught as well.
    expect(isNodeBuiltinSpecifier('sqlite')).toBe(true);
    expect(NODE_BUILTIN_MODULES.has('sqlite')).toBe(true);
    expect(NODE_BUILTIN_MODULES.has('fs')).toBe(true);
    expect(NODE_BUILTIN_MODULES.has('worker_threads')).toBe(true);
  });

  it('leaves relative, absolute and scoped specifiers to esbuild', () => {
    expect(isNodeBuiltinSpecifier('./dom-target.js')).toBe(false);
    expect(isNodeBuiltinSpecifier('/abs/path.js')).toBe(false);
    expect(isNodeBuiltinSpecifier('@debuggen/shared')).toBe(false);
    expect(isNodeBuiltinSpecifier('bippy')).toBe(false);
    expect(isNodeBuiltinSpecifier('')).toBe(false);
  });
});

describe('auditInputs: every forbidden-input rule, in the spellings esbuild reports', () => {
  it('matches a pnpm virtual-store path against the zod rule', () => {
    const zod = '../../node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js';
    const violations = auditInputs(metafileFor([ENTRY_REL, 'src/browser/state.ts', zod]));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.ruleId).toBe('zod');
    expect(violations[0]?.input).toBe(zod);
    expect(violations[0]?.reason).toContain('AAP 0.5.2');
    // The shortest route from the entry point, so the report names the import to delete.
    expect(violations[0]?.chain).toEqual([ENTRY_REL, 'src/browser/state.ts', zod]);
  });

  it('matches the workspace form of @debuggen/protocol through its directory rule', () => {
    const protocol = '../protocol/dist/index.js';
    const violations = auditInputs(metafileFor([ENTRY_REL, protocol]));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.ruleId).toBe('@debuggen/protocol');
    expect(violations[0]?.displayPath).toBe('packages/protocol/dist/index.js');
  });

  it("matches @debuggen/shared's Node entry while leaving its browser-safe root entry alone", () => {
    const nodeEntry = '../../node_modules/@debuggen/shared/dist/node/index.js';
    const rootEntry = '../../node_modules/@debuggen/shared/dist/index.js';

    const violations = auditInputs(metafileFor([ENTRY_REL, rootEntry, nodeEntry]));

    expect(violations.map((violation) => violation.input)).toEqual([nodeEntry]);
    expect(violations[0]?.ruleId).toBe('@debuggen/shared/node');
  });

  it('matches any @opentelemetry package and anything under apps/', () => {
    const otel =
      '../../node_modules/.pnpm/@opentelemetry+api@1.9.1/node_modules/@opentelemetry/api/build/src/index.js';
    const app = '../../apps/demo-app/src/lib/types.ts';

    const violations = auditInputs(metafileFor([ENTRY_REL, otel, app]));

    expect(violations.map((violation) => violation.ruleId)).toEqual(['@opentelemetry/*', 'apps/*']);
    expect(violations.map((violation) => violation.displayPath)).toContain(
      'apps/demo-app/src/lib/types.ts',
    );
  });

  it('returns nothing for a bundle of first-party browser sources', () => {
    const metafile = metafileFor([
      ENTRY_REL,
      'src/browser/interaction.ts',
      '../../node_modules/.pnpm/bippy@0.7.3/node_modules/bippy/dist/index.js',
    ]);

    expect(auditInputs(metafile)).toEqual([]);
  });

  it('sorts by rule then path, and reports one rule per input', () => {
    const zodA = '../../node_modules/zod/index.js';
    const zodB = '../../node_modules/zod/locales/en.js';
    const otel = '../../node_modules/@opentelemetry/api/index.js';

    const violations = auditInputs(metafileFor([ENTRY_REL], [zodB, zodA, otel]));

    expect(violations.map((violation) => [violation.ruleId, violation.input])).toEqual([
      ['@opentelemetry/*', otel],
      ['zod', zodA],
      ['zod', zodB],
    ]);
  });

  it('states a rule for every entry of FORBIDDEN_INPUTS', () => {
    // The list is the layering guarantee itself, so a rule added without a reason - or a rule
    // expressed neither as a pattern nor as a directory, which could never match - is a defect.
    expect(FORBIDDEN_INPUTS.length).toBeGreaterThan(0);
    for (const rule of FORBIDDEN_INPUTS) {
      expect(rule.id).not.toBe('');
      expect(rule.reason.length).toBeGreaterThan(40);
      expect(rule.pattern !== undefined || rule.directories.length > 0).toBe(true);
    }
  });
});

describe('findImportChain', () => {
  it('returns the target alone when it is the entry point or no entry is known', () => {
    const metafile = metafileFor([ENTRY_REL, 'src/browser/fetch.ts']);

    expect(findImportChain(metafile, ENTRY_REL, ENTRY_REL)).toEqual([ENTRY_REL]);
    expect(findImportChain(metafile, 'src/browser/fetch.ts', undefined)).toEqual([
      'src/browser/fetch.ts',
    ]);
  });

  it('returns the target alone when no import edge reaches it', () => {
    const metafile = metafileFor([ENTRY_REL], ['src/browser/orphan.ts']);

    expect(findImportChain(metafile, 'src/browser/orphan.ts', ENTRY_REL)).toEqual([
      'src/browser/orphan.ts',
    ]);
  });

  it('prefers the shortest route and never follows an external edge', () => {
    const metafile = /** @type {import("esbuild").Metafile} */ ({
      inputs: {
        [ENTRY_REL]: {
          bytes: 128,
          imports: [
            { path: 'src/browser/direct.ts', kind: 'import-statement' },
            { path: 'src/browser/long-a.ts', kind: 'import-statement' },
            { path: 'chrome://extension', kind: 'import-statement', external: true },
          ],
        },
        'src/browser/long-a.ts': {
          bytes: 64,
          imports: [{ path: 'src/browser/long-b.ts', kind: 'import-statement' }],
        },
        'src/browser/long-b.ts': {
          bytes: 64,
          imports: [{ path: 'src/browser/direct.ts', kind: 'import-statement' }],
        },
        'src/browser/direct.ts': { bytes: 64, imports: [] },
      },
      outputs: {},
    });

    expect(findImportChain(metafile, 'src/browser/direct.ts', ENTRY_REL)).toEqual([
      ENTRY_REL,
      'src/browser/direct.ts',
    ]);
    expect(findImportChain(metafile, 'chrome://extension', ENTRY_REL)).toEqual([
      'chrome://extension',
    ]);
  });
});

describe('describeViolations: the report a rejected bundle prints', () => {
  it('groups by rule, states that nothing was written, and shortens the chain', () => {
    const zod = '../../node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js';
    const violations = auditInputs(metafileFor([ENTRY_REL, 'src/browser/state.ts', zod]));

    const text = describeViolations(violations);

    expect(text).toContain('reached 1 forbidden input across 1 rule');
    expect(text).toContain(`Nothing was written: the rejected bundle never reached ${OUTFILE_REL}`);
    expect(text).toContain('zod — 1 input');
    // Chain steps inside a node_modules tree are rendered from the package name onwards, so the
    // pnpm store path does not bury the two first-party steps, which keep their
    // repository-relative path.
    const fromRepo = path.relative(REPO_ROOT, PACKAGE_ROOT).split(path.sep).join('/');
    expect(text).toContain(
      `imported via ${fromRepo}/${ENTRY_REL} -> ${fromRepo}/src/browser/state.ts -> zod/index.js`,
    );
  });

  it('counts the inputs it does not print, so one bad import is not buried', () => {
    const inputs = Array.from(
      { length: 7 },
      (_unused, index) => `../../node_modules/zod/part-${index}.js`,
    );

    const text = describeViolations(auditInputs(metafileFor([ENTRY_REL], inputs)));

    expect(text).toContain('reached 7 forbidden inputs across 1 rule');
    expect(text).toContain('... and 2 further inputs matched by this rule');
    expect(text).toContain('zod/part-0.js');
    expect(text).not.toContain('zod/part-6.js');
  });
});

describe('describeSuccess', () => {
  it('reports the artifact, its size and its input count, and flags a --dev build', () => {
    expect(describeSuccess({ bytes: 512, inputCount: 1, dev: false })).toBe(
      `esbuild.agent: ${OUTFILE_REL} 512 bytes from 1 input`,
    );

    const large = describeSuccess({ bytes: 2048, inputCount: 12, dev: true });
    expect(large).toContain('2048 bytes (2.0 KiB) from 12 inputs');
    expect(large).toContain('[--dev: unminified, inline source map]');
  });
});

describe('the command-line surface', () => {
  it('parses the documented flags', () => {
    expect(parseArgs([])).toEqual({ watch: false, dev: false, quiet: false, help: false });
    expect(parseArgs(['--watch', '--dev', '--quiet', '--help'])).toEqual({
      watch: true,
      dev: true,
      quiet: true,
      help: true,
    });
    expect(parseArgs(['-w', '-q', '-h'])).toEqual({
      watch: true,
      dev: false,
      quiet: true,
      help: true,
    });
  });

  it('treats an unrecognised argument as a usage error rather than ignoring it', () => {
    /** @type {unknown} */
    let caught;
    try {
      parseArgs(['--wathc']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentBuildError);
    const error = /** @type {AgentBuildError} */ (caught);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('--wathc');
    expect(error.showUsage).toBe(true);
  });

  it('documents the artifact contract, the import boundary and all three exit codes', () => {
    const text = usage();

    expect(text).toContain(ENTRY_REL);
    expect(text).toContain(OUTFILE_REL);
    expect(text).toContain('Import boundary (enforced, not advisory)');
    expect(text).toContain('Determinism');
    expect(text).toContain('0  success');
    expect(text).toContain('1  the build ran and its result was rejected');
    expect(text).toContain('2  nothing was built');
  });

  it('prints usage for --help and returns 0 without touching the filesystem', async () => {
    const outputBefore = listOutputDirectory(PACKAGE_ROOT);
    const stdout = capture('stdout');

    /** @type {number} */
    let code;
    try {
      code = await main(['--help']);
    } finally {
      stdout.restore();
    }

    expect(code).toBe(0);
    expect(stdout.text()).toContain('Import boundary (enforced, not advisory)');
    // `main` resolves its paths from the real PACKAGE_ROOT, so --help and an unrecognised flag are
    // the only arguments safe to exercise here; every filesystem behaviour above goes through
    // buildAgent({ packageRoot }) against a throwaway tree.
    //
    // The claim is that this checkout's output directory is UNCHANGED, not that it is absent: the
    // root `verify` chain runs `pnpm build` before `pnpm test`, and this package's build writes
    // `dist/browser-agent.iife.js`, so an absence assertion would fail on a legitimate artifact
    // rather than on anything `--help` did. Invariance holds in either order and is the stronger
    // claim - it also fails if `main` were ever to create the directory eagerly.
    expect(listOutputDirectory(PACKAGE_ROOT)).toEqual(outputBefore);
  });

  it('returns 2 for an unrecognised flag and prints the usage text with it', async () => {
    const outputBefore = listOutputDirectory(PACKAGE_ROOT);
    const stderr = capture('stderr');

    /** @type {number} */
    let code;
    try {
      code = await main(['--bogus']);
    } finally {
      stderr.restore();
    }

    expect(code).toBe(2);
    expect(stderr.text()).toContain('esbuild.agent: unrecognised argument: --bogus');
    expect(stderr.text()).toContain('Usage');
    // Unchanged rather than absent, for the reason stated in the --help case above: an
    // unrecognised argument is rejected by parseArgs before assertEntryExists or
    // ensureOutputDirectory run, so nothing in this checkout may move either way.
    expect(listOutputDirectory(PACKAGE_ROOT)).toEqual(outputBefore);
  });
});
