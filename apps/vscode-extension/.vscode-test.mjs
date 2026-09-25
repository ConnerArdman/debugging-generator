/**
 * .vscode-test.mjs — the `@vscode/test-cli` 0.0.15 configuration behind
 * `pnpm test:vscode`, the extension-host gate of AAP 0.8.5 (CI runs it as
 * `xvfb-run -a pnpm test:vscode`).
 *
 * ONE configuration, labelled `extension-host`, runs the five mocha suites of
 * AAP 0.7.1 Group 3 inside a real VS Code: activation, commands,
 * open-location, uri-handler and packaged-vsix.
 *
 * THE PATH CONTRACT. `esbuild.mjs --tests` compiles every
 * `test/suite/**` `*.test.ts` to `dist/test/suite/<name>.test.js` (CommonJS,
 * `vscode` and `mocha` external), and this file globs exactly that output.
 * `pretest:vscode` produces it, so `pnpm run test:vscode` always runs against a
 * fresh build. A change to either side changes the other in the same commit.
 *
 * A RUN THAT EXECUTES NOTHING IS A FAILURE. The runner resolves happily on
 * zero files and zero tests, so three guards stand in the way of a vacuous
 * green: the preflight below refuses to load the configuration unless every
 * required suite exists as a source AND as a compiled bundle (and no compiled
 * bundle is left over from a deleted suite); mocha's `failZero` fails a run
 * that registered no test; and `forbidOnly` / `forbidPending` fail a run in
 * which a stray `.only` or a skipped test silently narrowed what executed.
 *
 * HERMETICITY (AAP 0.10 baseline, 0.5.2, 0.5.6). Nothing a run does may touch
 * the developer's machine state or leave the machine:
 *   - a throwaway directory `<os.tmpdir()>/debuggen-vscode-test-XXXXXX/` is
 *     created when this file is evaluated. It holds `home/` (the run's
 *     `DEBUGGEN_HOME`, so the editor credential `auth.json`, the session store
 *     and backups never come from or go to the real `~/.debuggen`),
 *     `user-data/` and `extensions/` (a fresh VS Code profile, so no global
 *     state, setting or installed extension carries over from a previous run
 *     or from the developer's editor). It is removed when the CLI exits; a
 *     removal failure fails the run, because residue is a defect;
 *   - every inherited `DEBUGGEN_*` and `ANTHROPIC_*` variable is removed from
 *     the editor's environment (no ambient credential, ingest URL, port or API
 *     key reaches a test), then `DEBUGGEN_PROVIDER=deterministic` is forced, so
 *     no model provider is ever contacted;
 *   - the workspace is the generic fixture `test/fixtures/workspace`, never the
 *     repository root and never the demo application (AAP 0.5.4). Its
 *     `.vscode/settings.json` points `debuggen.serviceUrl` at an unbindable
 *     loopback port and turns `debuggen.autoStartService` off, which is what
 *     keeps a run away from a developer's service on the default port 43117.
 *     VS Code reads a setting whose manifest `scope` is `machine` or
 *     `application` from user settings only and silently drops it from a
 *     workspace's settings — `debuggen.serviceUrl` is `machine`-scoped — so
 *     every such fixture entry is also written to the throwaway profile's
 *     `user-data/User/settings.json` (see {@link userOnlyFixtureSettings});
 *     the fixture file stays the one place those values are authored;
 *   - only the extension under development loads (`--disable-extensions`,
 *     extension dependencies skipped, nothing installed from a marketplace),
 *     and editor telemetry is off.
 *
 * ENVIRONMENT KNOBS, each optional, each validated:
 *   - `VSCODE_TEST_VERSION`  editor to download: `stable` (default),
 *     `insiders`, a commit, or `X.Y.Z`, which must satisfy
 *     `engines.vscode` in package.json. CI pins through this variable.
 *   - `VSCODE_TEST_PATH`     an already-installed editor executable to use
 *     instead of downloading one; wins over `VSCODE_TEST_VERSION`.
 *   - `DEBUGGEN_VSCODE_TEST_TIMEOUT_MS`  default mocha timeout per test and
 *     hook; `0` disables it (debugging). Default 600000.
 *   - `DEBUGGEN_VSCODE_TEST_KEEP_STATE=1`  keep the throwaway directory for
 *     inspection (logs live under `user-data/logs/`); its path is printed.
 *   - `DEBUGGEN_TEST_NODE`   Node executable the suites spawn the embedded
 *     service with; defaults to the Node running this CLI (the repository's
 *     pinned runtime when invoked through pnpm), never Electron.
 * These are read here and are not forwarded as-is: the editor receives only
 * the environment assembled in {@link extensionHostEnvironment}.
 *
 * Plain Node ESM: linted (`eslint.config.js`, JavaScript rules) and
 * format-checked, never compiled. Imports are limited to `node:` built-ins and
 * `defineConfig`, which `@vscode/test-cli` resolves for us.
 *
 * @module apps/vscode-extension/.vscode-test
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@vscode/test-cli';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * This workspace, from this module's own location: `vscode-test` may be run
 * from the workspace, from the repository root through `pnpm --filter`, or by
 * the editor's test explorer, and every path below must mean the same thing in
 * each case.
 */
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Where the suites are authored (`esbuild.mjs` LAYOUT.testSuiteSrc). */
const SUITE_SOURCE_DIR = path.join(EXTENSION_DIR, 'test', 'suite');

/** Where `esbuild.mjs --tests` writes them (LAYOUT.testSuiteOut). */
const SUITE_OUTPUT_DIR = path.join(EXTENSION_DIR, 'dist', 'test', 'suite');

/** The runner's glob, relative to this file; mirrors {@link SUITE_OUTPUT_DIR}. */
const COMPILED_SUITES_GLOB = 'dist/test/suite/**/*.test.js';

const SOURCE_SUFFIX = '.test.ts';
const COMPILED_SUFFIX = '.test.js';

/**
 * The generic fixture workspace every suite runs in. `test/helpers.ts`
 * (`fixtureWorkspaceRoot()`) asserts the opened folder is exactly this one.
 */
const WORKSPACE_FOLDER = path.join(EXTENSION_DIR, 'test', 'fixtures', 'workspace');

/**
 * The fixture workspace's settings: the single source of the `debuggen.*`
 * values every suite runs under. Strict JSON, so it is parsed as such here.
 */
const FIXTURE_SETTINGS_FILE = path.join(WORKSPACE_FOLDER, '.vscode', 'settings.json');

/**
 * Manifest `scope` values VS Code honours only from user settings, never from
 * a workspace's `.vscode/settings.json` (its workspace and folder settings
 * models admit `window`, `resource`, `language-overridable` and
 * `machine-overridable` only).
 */
const USER_ONLY_SCOPES = Object.freeze(['application', 'machine']);

/** The suites AAP 0.7.1 Group 3 requires; a run without any of them is refused. */
const REQUIRED_SUITES = Object.freeze([
  'activation',
  'commands',
  'open-location',
  'uri-handler',
  'packaged-vsix',
]);

/** The command that produces the compiled suites; named in every hint. */
const PREPARE_COMMAND = 'pnpm --filter debug-generator run pretest:vscode';

/**
 * Ten minutes. The slowest suite, packaged-vsix, runs a production build,
 * `vsce ls`, `vsce package`, an install into a throwaway profile and a service
 * start, on a machine whose CPUs may be shared with other builds; the other
 * suites finish in seconds and are unaffected by a generous ceiling.
 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Prefix of the throwaway directory; `test/helpers.ts` uses the same one. */
const SCRATCH_PREFIX = 'debuggen-vscode-test-';

/** Prefix of the one line this file prints, on stderr (stdout carries `--list-configuration` JSON). */
const LOG_PREFIX = '[vscode-test config]';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/**
 * A configuration problem, reported by `vscode-test` as
 * "Could not read config file …" followed by this message, and exit code 1.
 */
class TestConfigurationError extends Error {
  /**
   * @param {string} message what is wrong
   * @param {string} hint what to do about it
   */
  constructor(message, hint) {
    super(`${message}\n  hint: ${hint}`);
    this.name = 'TestConfigurationError';
  }
}

/**
 * An environment variable's value, trimmed; `undefined` when unset or blank,
 * so an exported-but-empty variable behaves exactly like an absent one.
 *
 * @param {string} name
 * @returns {string | undefined}
 */
function readEnv(name) {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * @param {string} target
 * @returns {boolean}
 */
function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} target
 * @returns {boolean}
 */
function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * The suite names under `root`: every file ending in `suffix`, at any depth,
 * as a POSIX path relative to `root` with the suffix removed
 * (`nested/foo.test.js` -> `nested/foo`). The same set the runner's `**` glob
 * collects. A missing directory yields none.
 *
 * @param {string} root
 * @param {string} suffix
 * @returns {Set<string>}
 */
function suiteNames(root, suffix) {
  if (!isDirectory(root)) {
    return new Set();
  }
  const names = fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/')
        .slice(0, -suffix.length),
    );
  return new Set(names);
}

/**
 * `X.Y.Z` as three numbers, or `undefined` for anything else (`stable`,
 * `insiders`, a commit hash).
 *
 * @param {string} value
 * @returns {[number, number, number] | undefined}
 */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {readonly number[]} left
 * @param {readonly number[]} right
 * @returns {number} negative, zero or positive, like a sort comparator
 */
function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The extension manifest, `package.json`, parsed. Every manifest fact this
 * file needs (the engine range, the configuration scopes) is read from it
 * rather than restated, so each fact has one owner.
 *
 * @returns {unknown}
 * @throws {TestConfigurationError}
 */
function readManifest() {
  const manifestPath = path.join(EXTENSION_DIR, 'package.json');
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (cause) {
    throw new TestConfigurationError(
      `Cannot read the extension manifest ${manifestPath}: ${String(cause)}`,
      'Restore apps/vscode-extension/package.json.',
    );
  }
}

// ---------------------------------------------------------------------------
// Resolution of the environment knobs
// ---------------------------------------------------------------------------

/**
 * The lower bound `package.json#engines.vscode` declares (`^1.125.0` ->
 * `{ minimum: [1, 125, 0], sameMajor: true }`). Read from the manifest rather
 * than restated, so the range has one owner.
 *
 * @returns {{ range: string, minimum: [number, number, number], sameMajor: boolean }}
 */
function engineRange() {
  const manifest = readManifest();
  const range =
    typeof manifest === 'object' &&
    manifest !== null &&
    'engines' in manifest &&
    typeof manifest.engines === 'object' &&
    manifest.engines !== null &&
    'vscode' in manifest.engines &&
    typeof manifest.engines.vscode === 'string'
      ? manifest.engines.vscode.trim()
      : undefined;
  const match = range === undefined ? null : /^(\^|>=)\s*(\d+\.\d+\.\d+)$/.exec(range);
  const minimum = match === null ? undefined : parseVersion(match[2] ?? '');
  if (range === undefined || match === null || minimum === undefined) {
    throw new TestConfigurationError(
      `package.json#engines.vscode is ${JSON.stringify(range)}, not a "^X.Y.Z" or ">=X.Y.Z" range.`,
      'Declare the minimum supported editor as "^X.Y.Z" in apps/vscode-extension/package.json.',
    );
  }
  return { range, minimum, sameMajor: match[1] === '^' };
}

/**
 * The editor to download: `VSCODE_TEST_VERSION`, else `stable`. A concrete
 * `X.Y.Z` must satisfy `engines.vscode`, or VS Code would refuse to load the
 * extension and every suite would fail on a missing extension instead of on
 * the real cause.
 *
 * @returns {string}
 */
function resolveVersion() {
  const requested = readEnv('VSCODE_TEST_VERSION') ?? 'stable';
  const concrete = parseVersion(requested);
  if (concrete !== undefined) {
    const { range, minimum, sameMajor } = engineRange();
    if (compareVersions(concrete, minimum) < 0 || (sameMajor && concrete[0] !== minimum[0])) {
      throw new TestConfigurationError(
        `VSCODE_TEST_VERSION=${requested} does not satisfy engines.vscode "${range}".`,
        `Choose a version within "${range}", or unset VSCODE_TEST_VERSION to test against stable.`,
      );
    }
  }
  return requested;
}

/**
 * An installed editor executable from `VSCODE_TEST_PATH`, absolute, or
 * `undefined` to let `@vscode/test-electron` download {@link resolveVersion}.
 * A path that is set but wrong fails here rather than silently falling back to
 * a download.
 *
 * @returns {string | undefined}
 */
function resolveInstallation() {
  const configured = readEnv('VSCODE_TEST_PATH');
  if (configured === undefined) {
    return undefined;
  }
  const executable = path.resolve(configured);
  if (!isFile(executable)) {
    throw new TestConfigurationError(
      `VSCODE_TEST_PATH=${configured} is not an existing VS Code executable.`,
      'Point VSCODE_TEST_PATH at the editor binary (for example …/vscode-linux-x64-<version>/code), or unset it to download one.',
    );
  }
  return executable;
}

/**
 * The default mocha timeout: `DEBUGGEN_VSCODE_TEST_TIMEOUT_MS` (a non-negative
 * integer; `0` disables timeouts, as in mocha) or {@link DEFAULT_TIMEOUT_MS}.
 *
 * @returns {number}
 */
function resolveTimeout() {
  const configured = readEnv('DEBUGGEN_VSCODE_TEST_TIMEOUT_MS');
  if (configured === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  const value = Number(configured);
  if (!/^\d+$/.test(configured) || !Number.isSafeInteger(value)) {
    throw new TestConfigurationError(
      `DEBUGGEN_VSCODE_TEST_TIMEOUT_MS=${configured} is not a whole number of milliseconds.`,
      `Set it to an integer such as ${DEFAULT_TIMEOUT_MS}, 0 to disable timeouts, or unset it.`,
    );
  }
  return value;
}

/**
 * Whether `DEBUGGEN_VSCODE_TEST_KEEP_STATE` asks to keep the throwaway
 * directory. Only `1` and `true` keep it; `0`, `false` or unset remove it.
 *
 * @returns {boolean}
 */
function resolveKeepState() {
  const configured = readEnv('DEBUGGEN_VSCODE_TEST_KEEP_STATE');
  if (configured === undefined || configured === '0' || configured === 'false') {
    return false;
  }
  if (configured === '1' || configured === 'true') {
    return true;
  }
  throw new TestConfigurationError(
    `DEBUGGEN_VSCODE_TEST_KEEP_STATE=${configured} is neither 1/true nor 0/false.`,
    'Set it to 1 to keep the throwaway directory after the run, or unset it.',
  );
}

// ---------------------------------------------------------------------------
// Preflight: refuse a run that could pass without testing what it claims to
// ---------------------------------------------------------------------------

/**
 * Check the inputs of the run before anything is created or launched:
 *   - every {@link REQUIRED_SUITES} entry exists under `test/suite/`;
 *   - every source suite has its compiled bundle under `dist/test/suite/`
 *     (a renamed, deleted or never-built bundle would otherwise just drop out
 *     of the glob and the run would still be green);
 *   - no compiled bundle lacks a source (leftover output from a removed or
 *     renamed suite would otherwise run stale code);
 *   - the fixture workspace exists.
 * Every problem is listed at once, so one rebuild fixes them all.
 *
 * @throws {TestConfigurationError}
 */
function assertRunInputs() {
  const sources = suiteNames(SUITE_SOURCE_DIR, SOURCE_SUFFIX);
  const compiled = suiteNames(SUITE_OUTPUT_DIR, COMPILED_SUFFIX);
  /** @type {string[]} */
  const problems = [];

  for (const name of REQUIRED_SUITES) {
    if (!sources.has(name)) {
      problems.push(`required suite test/suite/${name}${SOURCE_SUFFIX} does not exist`);
    }
  }
  const expected = [...new Set([...REQUIRED_SUITES, ...sources])].sort();
  for (const name of expected) {
    if (!compiled.has(name)) {
      problems.push(`compiled suite dist/test/suite/${name}${COMPILED_SUFFIX} is missing`);
    }
  }
  for (const name of [...compiled].sort()) {
    if (!sources.has(name)) {
      problems.push(
        `compiled suite dist/test/suite/${name}${COMPILED_SUFFIX} has no source test/suite/${name}${SOURCE_SUFFIX} (stale output)`,
      );
    }
  }
  if (!isDirectory(WORKSPACE_FOLDER)) {
    problems.push(
      `fixture workspace ${path.relative(EXTENSION_DIR, WORKSPACE_FOLDER)}/ does not exist`,
    );
  }

  if (problems.length > 0) {
    throw new TestConfigurationError(
      `The extension-host run cannot start:\n  - ${problems.join('\n  - ')}`,
      `Run "${PREPARE_COMMAND}" (or "pnpm --filter debug-generator run test:vscode", which runs it first); restore any required suite that was removed.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fixture settings VS Code reads from user settings only
// ---------------------------------------------------------------------------

/**
 * The configuration keys the manifest contributes with a user-only scope
 * ({@link USER_ONLY_SCOPES}). `contributes.configuration` may be one object or
 * an array of them; VS Code accepts both, so both are read.
 *
 * @param {unknown} manifest the parsed `package.json`
 * @returns {Set<string>}
 */
function userOnlyConfigurationKeys(manifest) {
  const contributes = isRecord(manifest) ? manifest.contributes : undefined;
  const configuration = isRecord(contributes) ? contributes.configuration : undefined;
  const sections = Array.isArray(configuration) ? configuration : [configuration];
  /** @type {Set<string>} */
  const keys = new Set();
  for (const section of sections) {
    const properties = isRecord(section) ? section.properties : undefined;
    if (!isRecord(properties)) {
      continue;
    }
    for (const [key, property] of Object.entries(properties)) {
      if (
        isRecord(property) &&
        typeof property.scope === 'string' &&
        USER_ONLY_SCOPES.includes(property.scope)
      ) {
        keys.add(key);
      }
    }
  }
  return keys;
}

/**
 * The entries of {@link FIXTURE_SETTINGS_FILE} that VS Code would drop from
 * the workspace because the manifest contributes their key with a user-only
 * scope. {@link createThrowawayState} writes them to the throwaway profile's
 * user settings, where VS Code does apply them. Without this step the
 * `machine`-scoped `debuggen.serviceUrl` would silently fall back to its
 * manifest default, the real service's port 43117, and a run could reach a
 * developer's live service. Values are copied, never restated, so the fixture
 * file remains their one author.
 *
 * @returns {Record<string, unknown>} possibly empty
 * @throws {TestConfigurationError} when the fixture settings are missing, are
 *   not strict JSON, or are not a JSON object
 */
function userOnlyFixtureSettings() {
  const relative = path.relative(EXTENSION_DIR, FIXTURE_SETTINGS_FILE);
  /** @type {unknown} */
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(FIXTURE_SETTINGS_FILE, 'utf8'));
  } catch (cause) {
    throw new TestConfigurationError(
      `Cannot read the fixture workspace settings ${relative} as strict JSON: ${String(cause)}`,
      `Restore ${relative} as one JSON object of debuggen.* settings, without comments or trailing commas.`,
    );
  }
  if (!isRecord(settings)) {
    throw new TestConfigurationError(
      `The fixture workspace settings ${relative} are not a JSON object.`,
      `Restore ${relative} as one JSON object of debuggen.* settings.`,
    );
  }
  const userOnlyKeys = userOnlyConfigurationKeys(readManifest());
  return Object.fromEntries(Object.entries(settings).filter(([key]) => userOnlyKeys.has(key)));
}

// ---------------------------------------------------------------------------
// Throwaway state
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ThrowawayState
 * @property {string} root       the directory removed at exit
 * @property {string} home       the run's `DEBUGGEN_HOME` (mode 0700, as the service requires)
 * @property {string} userData   VS Code `--user-data-dir`, whose `User/settings.json` holds the {@link userOnlyFixtureSettings}
 * @property {string} extensions VS Code `--extensions-dir`
 */

/**
 * Create the run's throwaway directory and arrange for its removal when this
 * CLI process exits. `os.tmpdir()` is realpath-resolved first (on macOS it is
 * a symlink), so every path handed to the editor is canonical and the
 * workspace-containment logic under test never sees a symlinked prefix.
 *
 * `mkdtemp` creates the root with mode 0700, so no other account can read the
 * credential the extension may write into `home/`.
 *
 * `userSettings` becomes the fresh profile's `User/settings.json` (skipped
 * when empty), which VS Code reads as the user settings of the run.
 *
 * @param {boolean} keep leave the directory in place and print its path
 * @param {Record<string, unknown>} userSettings from {@link userOnlyFixtureSettings}
 * @returns {ThrowawayState}
 */
function createThrowawayState(keep, userSettings) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), SCRATCH_PREFIX));
  process.once('exit', () => {
    removeThrowawayState(root, keep);
  });

  const home = path.join(root, 'home');
  const userData = path.join(root, 'user-data');
  const extensions = path.join(root, 'extensions');
  fs.mkdirSync(home, { mode: 0o700 });
  // mkdir honours the umask; the service's safe-fs checks require exactly 0700.
  fs.chmodSync(home, 0o700);
  fs.mkdirSync(userData);
  fs.mkdirSync(extensions);
  const userSettingKeys = Object.keys(userSettings);
  if (userSettingKeys.length > 0) {
    const userSettingsDir = path.join(userData, 'User');
    fs.mkdirSync(userSettingsDir);
    fs.writeFileSync(
      path.join(userSettingsDir, 'settings.json'),
      `${JSON.stringify(userSettings, null, 2)}\n`,
    );
  }

  const seeded =
    userSettingKeys.length > 0
      ? `; user settings from the fixture: ${userSettingKeys.join(', ')}`
      : '';
  console.error(
    `${LOG_PREFIX} throwaway state ${root} (DEBUGGEN_HOME=${home}${seeded}); ${keep ? 'kept after the run' : 'removed after the run'}`,
  );
  return { root, home, userData, extensions };
}

/**
 * The `exit` listener: remove the throwaway directory. It runs synchronously
 * after `vscode-test` has awaited the editor's exit, with retries for a helper
 * process that is still releasing a file. A directory that cannot be removed
 * turns the run red — setting `exitCode` inside an `exit` listener is honoured
 * by `process.exit()` — because residue is a defect, not a warning.
 *
 * @param {string} root
 * @param {boolean} keep
 */
function removeThrowawayState(root, keep) {
  if (keep) {
    console.error(`${LOG_PREFIX} kept throwaway state ${root}`);
    return;
  }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (cause) {
    console.error(`${LOG_PREFIX} could not remove throwaway state ${root}: ${String(cause)}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// The editor's environment
// ---------------------------------------------------------------------------

/**
 * The variables handed to the editor, layered by `@vscode/test-electron` over
 * this process's environment (a value of `undefined` removes the inherited
 * variable, the same mechanism `@vscode/test-cli` uses for
 * `ELECTRON_RUN_AS_NODE`):
 *   - every inherited `DEBUGGEN_*` (a developer's `DEBUGGEN_HOME`, port, host,
 *     token, ingest URL, prompts directory, model …) and `ANTHROPIC_*`
 *     variable is removed, `ANTHROPIC_API_KEY` explicitly;
 *   - `DEBUGGEN_HOME` is the throwaway `home/`;
 *   - `DEBUGGEN_PROVIDER=deterministic`: nothing leaves the machine and no API
 *     key is needed (AAP 0.5.3);
 *   - `DEBUGGEN_TEST_NODE` is the Node the suites spawn the embedded service
 *     with. Inside the extension host `process.execPath` is Electron, whose
 *     Node is not the repository's pinned runtime that built-in `node:sqlite`
 *     needs, so the absolute path of the Node running this CLI is passed on
 *     unless one is configured explicitly;
 *   - `VSCODE_TEST_EXECUTABLE_PATH` names the editor binary for the suites that
 *     drive its CLI (`--install-extension`), when that binary is known here.
 *
 * @param {ThrowawayState} state
 * @param {string | undefined} vscodeExecutable
 * @returns {Record<string, string | undefined>}
 */
function extensionHostEnvironment(state, vscodeExecutable) {
  /** @type {Record<string, string | undefined>} */
  const env = { ANTHROPIC_API_KEY: undefined };
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('DEBUGGEN_') || name.startsWith('ANTHROPIC_')) {
      env[name] = undefined;
    }
  }
  env.DEBUGGEN_HOME = state.home;
  env.DEBUGGEN_PROVIDER = 'deterministic';
  env.DEBUGGEN_TEST_NODE = readEnv('DEBUGGEN_TEST_NODE') ?? process.execPath;
  if (vscodeExecutable !== undefined) {
    env.VSCODE_TEST_EXECUTABLE_PATH = vscodeExecutable;
  }
  return env;
}

// ---------------------------------------------------------------------------
// The configuration
// ---------------------------------------------------------------------------

// Resolve and validate everything first, so a bad knob or a missing build
// fails before a directory is created.
const vscodeExecutable = resolveInstallation();
const version = resolveVersion();
const timeout = resolveTimeout();
const keepState = resolveKeepState();
assertRunInputs();
const userSettings = userOnlyFixtureSettings();
const state = createThrowawayState(keepState, userSettings);

export default defineConfig({
  label: 'extension-host',
  platform: 'desktop',
  files: COMPILED_SUITES_GLOB,
  extensionDevelopmentPath: EXTENSION_DIR,
  workspaceFolder: WORKSPACE_FOLDER,
  version,
  ...(vscodeExecutable === undefined ? {} : { useInstallation: { fromPath: vscodeExecutable } }),
  launchArgs: [
    // Load only the extension under development; `@vscode/test-cli` adds
    // `--extensionDevelopmentPath` for it, and that one still loads.
    '--disable-extensions',
    // Headless CI containers (under `xvfb-run -a`) have no GPU.
    '--disable-gpu',
    // Chromium refuses to start as root without it, and CI containers and
    // this repository's build host run as root. `@vscode/test-electron` 3.1.0
    // passes it as well; it is stated here so the requirement does not depend
    // on that implementation detail.
    '--no-sandbox',
    // Containers default `/dev/shm` to 64 MB, which Chromium's renderer
    // outgrows mid-run and then dies ("renderer process gone … code: 133"),
    // failing the suite at random. Shared memory then goes to the temp
    // directory instead, as it must for any Chromium inside a container.
    '--disable-dev-shm-usage',
    // No usage data leaves the machine during a test run.
    '--disable-telemetry',
    // A fresh profile per run, inside the throwaway directory, instead of the
    // `.vscode-test/{user-data,extensions}` that would otherwise persist
    // global state and installed extensions from one run to the next.
    `--user-data-dir=${state.userData}`,
    `--extensions-dir=${state.extensions}`,
  ],
  env: extensionHostEnvironment(state, vscodeExecutable),
  // The manifest declares no extension dependencies; skipping the lookup
  // guarantees none is ever fetched from a marketplace.
  skipExtensionDependencies: true,
  mocha: {
    ui: 'bdd',
    color: true,
    timeout,
    failZero: true,
    forbidOnly: true,
    forbidPending: true,
  },
});
