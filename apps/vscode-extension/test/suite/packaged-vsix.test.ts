/**
 * The packaged-VSIX smoke test: the self-containment gate of AAP 0.7.1 Group 3
 * and the `vsce ls` manifest validation of the `pnpm test:vscode` gate
 * (AAP 0.8.5).
 *
 * It is the only place the whole packaging contract is exercised end to end:
 * the `dist/` layout `esbuild.mjs` and `vite.config.ts` write, the keep-set of
 * `.vscodeignore`, vsce's license and icon checks (evaluated against the
 * packaged file list, not the working directory), the VS Code CLI's install
 * path, and the INSTALLED extension running in an editor: its activation, the
 * paths it resolves from its own install, and the coordination service it
 * embeds. In order, one `it` per step:
 *
 * 1. build through the workspace's own `vscode:prepublish` script — the build
 *    vsce itself runs, including `esbuild.mjs --package`, which stages the
 *    repository-root `LICENSE` into the workspace;
 * 2. `vsce ls --no-dependencies` lists every runtime artefact, the staged
 *    license included, and nothing from `src/`, `test/` or the build tooling.
 *    The license needs an explicit assertion: vsce 4 meets a missing license
 *    with "Do you want to continue? [y/N]", but answers that prompt itself
 *    with "y" whenever its stdout is not a terminal — as under this runner and
 *    in CI — so an unlicensed VSIX would otherwise be packaged silently;
 * 3. `vsce package --no-dependencies` writes the `.vsix` into a scratch
 *    directory, never into the workspace;
 * 4. the VS Code CLI installs it into a throwaway profile and lists exactly
 *    `debuggen.debug-generator@<manifest version>` there;
 * 5. the installed tree holds the host, webview, service, preload, icon,
 *    license and changelog — and none of the sources or tooling;
 * 6. the embedded prompt directory resolves: all six pipeline stages, and
 *    every prompt file the manifest names;
 * 7. the installed extension, activated in a second, isolated VS Code window
 *    on that throwaway profile, starts its embedded service from its own
 *    install: the service answers `GET /health` with a body
 *    `healthResponseSchema` from `@debuggen/protocol` accepts, the extension's
 *    editor client has connected to it, it runs with the installed prompt
 *    directory, the window's `DEBUGGEN_HOME` and the configured port, it
 *    created its session store, and the extension's `deactivate()` stopped it
 *    when the window quit. The companion extension that drives the window is
 *    `test/probe/installed-extension-probe.ts`;
 * 8. teardown (`after`): every child is stopped and every scratch directory is
 *    removed, and both facts are asserted rather than assumed.
 *
 * DURATION. The slowest suite of the extension-host gate: two production
 * builds (step 1, and the `vscode:prepublish` that `vsce package` runs again
 * in step 3), vsce's secret scan of an 8.5 MB package of some 1 200 files, an
 * install, and a second editor window that starts, activates the extension,
 * waits for its service and shuts down (about five seconds on its own). On a
 * warm 12-CPU host shared with other builds the seven steps take tens of
 * seconds; a cold cache or a saturated CPU stretches every step by an order of
 * magnitude, so the budgets are minutes: each test and hook gets
 * {@link TEST_TIMEOUT_MS}, and every command or window inside a step has a
 * smaller budget of its own, so a slow or hung one fails with its captured
 * output instead of a bare mocha timeout.
 *
 * SIDE EFFECT ON THE WORKSPACE. Like every production build, steps 1 and 3
 * clean `apps/vscode-extension/dist/` — including the compiled suites and the
 * probe under `dist/test/`. Mocha has loaded every suite before the first test
 * runs, `before` copies the compiled probe into the scratch directory before
 * step 1, and `pretest:vscode` rebuilds both before every `test:vscode`, so
 * the run is unaffected; `dist/` and the staged `LICENSE` are git-ignored
 * build output.
 *
 * HERMETICITY. Every child runs through `test/helpers.ts` (`spawnTracked` /
 * `runToCompletion`): stdin is closed, so a tool that tries to prompt fails
 * fast instead of hanging; the environment is `hermeticEnv()`, so no provider
 * credential, no ambient `DEBUGGEN_*` value and no editor-internal `ELECTRON_*`
 * or `VSCODE_*` variable reaches it; and each child leads its own process
 * group, so stopping it stops everything it started. The VS Code CLI and the
 * isolated window only ever see the throwaway profile of
 * `throwawayCliProfileArgs`; the window's extension and its service get a
 * scratch `DEBUGGEN_HOME` and a free loopback port through that profile's user
 * settings; and the only network traffic is loopback to that service. Nothing
 * is skipped: a missing prerequisite (pnpm, vsce, the VS Code CLI or binary,
 * the compiled probe) is a failure with a message naming it.
 *
 * Mocha's `bdd` interface is supplied as globals by the `@vscode/test-cli`
 * runner, and this workspace declares no `@types/mocha` (see the
 * `compilerOptions.types` notes in `tsconfig.json`), so the four globals this
 * suite calls are declared below, in module scope, with the slice of Mocha's
 * context they use.
 *
 * @module apps/vscode-extension/test/suite/packaged-vsix
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

import { PROTOCOL_VERSION, healthPath, healthResponseSchema } from '@debuggen/protocol';
import * as vscode from 'vscode';

import {
  EXTENSION_ID,
  cleanupScratch,
  createScratchDir,
  extensionDevelopmentRoot,
  findFreePort,
  hermeticEnv,
  isProcessAlive,
  listTrackedProcesses,
  readManifestFromDisk,
  repositoryRoot,
  resolveVsCodeCliArgs,
  resolveVsCodeExecutable,
  runToCompletion,
  spawnTracked,
  stopTrackedProcesses,
  throwawayCliProfileArgs,
  writeFixtureFile,
} from '../helpers';
import type { ExtensionManifest, ProcessExit, TrackedProcess } from '../helpers';
import { PROBE_CONFIG_FILE, parseProbeResult } from '../probe/installed-extension-probe';
import type { ProbeConfig, ProbeResult } from '../probe/installed-extension-probe';

// ---------------------------------------------------------------------------
// Mocha's bdd globals, as provided by the @vscode/test-cli runner
// ---------------------------------------------------------------------------

/** The part of Mocha's test and hook context (`this`) this suite uses. */
interface MochaRunnableContext {
  timeout(ms: number): unknown;
  slow(ms: number): unknown;
}

/** The part of Mocha's suite context (`this` inside `describe`) this suite uses. */
interface MochaSuiteContext extends MochaRunnableContext {
  /** Stop running the suite's remaining tests after its first failure. */
  bail(bail: boolean): unknown;
}

/** A test or hook body: synchronous, or a promise mocha awaits. */
type MochaRunnable = (this: MochaRunnableContext) => void | Promise<void>;

declare function describe(title: string, body: (this: MochaSuiteContext) => void): void;
declare function it(title: string, body: MochaRunnable): void;
declare function before(body: MochaRunnable): void;
declare function after(body: MochaRunnable): void;

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * Mocha timeout of each test and hook: fifteen minutes, above the ten-minute
 * default of `.vscode-test.mjs` because step 3 runs a complete production build
 * (vsce's `vscode:prepublish`) plus the packaging itself.
 */
const TEST_TIMEOUT_MS = 15 * 60_000;

/** A step slower than this is reported as slow by the reporter. */
const SLOW_STEP_MS = 3 * 60_000;

/** Budget of one production build: `pnpm run vscode:prepublish`, or `vsce package` including it. */
const BUILD_TIMEOUT_MS = 12 * 60_000;

/** Budget of `vsce ls`, which only walks the workspace. */
const LIST_TIMEOUT_MS = 2 * 60_000;

/** Budget of one VS Code CLI call (`--install-extension`, `--list-extensions`). */
const CLI_TIMEOUT_MS = 3 * 60_000;

/**
 * How long the installed extension's embedded service gets, once the probe
 * has activated the extension, to answer `GET /health` with the extension's
 * editor client connected (step 7).
 */
const HEALTH_TIMEOUT_MS = 90_000;

/**
 * Budget of the isolated window of step 7, from launch to exit: editor
 * start-up, the probe's activation (`onStartupFinished`), the target's
 * activation, {@link HEALTH_TIMEOUT_MS}, and the shutdown in which VS Code
 * deactivates the extension. Measured at about five seconds on a warm host.
 */
const ISOLATED_WINDOW_TIMEOUT_MS = 5 * 60_000;

/**
 * How long the service may outlive the isolated window's exit. The extension's
 * `deactivate()` stops it during the shutdown itself, so it is normally gone
 * before the window exits; the margin covers the child's own graceful stop.
 */
const SERVICE_EXIT_TIMEOUT_MS = 15_000;

/** Delay between two liveness checks of the stopped service. */
const SERVICE_EXIT_POLL_MS = 100;

// ---------------------------------------------------------------------------
// The packaging contract
// ---------------------------------------------------------------------------

/**
 * The script that builds exactly what vsce packages: `node esbuild.mjs
 * --production --package && vite build`. vsce runs it again before `package`.
 */
const PREPUBLISH_SCRIPT = 'vscode:prepublish';

/**
 * Files the VSIX must carry and the installed extension must contain under
 * the same name, as extension-relative POSIX paths. The icon comes from
 * `package.json#icon`; the license and the changelog are in
 * {@link RENAMED_BY_VSCE}.
 */
const PACKAGED_FILES: readonly string[] = Object.freeze([
  'package.json',
  'dist/extension.js',
  'dist/webview/main.js',
  'dist/webview/main.css',
  'dist/service/main.js',
  'dist/service/package.json',
  'dist/service/prompts/manifest.json',
  'dist/telemetry/node/register.mjs',
]);

/**
 * Sources, tests and build tooling: never part of the VSIX, so never listed by
 * `vsce ls` (as the path itself or a path below it) and never present in the
 * installed extension. `dist/test` holds the compiled suites, which
 * `.vscodeignore` never re-includes.
 */
const FORBIDDEN_ENTRIES: readonly string[] = Object.freeze([
  'src',
  'test',
  'node_modules',
  'dist/test',
  '.tsbuild',
  'esbuild.mjs',
  'vite.config.ts',
  '.vscode-test.mjs',
  'tsconfig.json',
  'tsconfig.webview.json',
  '.vscodeignore',
]);

/**
 * A file name no VSIX entry may have. `esbuild.mjs` inlines the store DDL into
 * `dist/service/main.js` as a string (AAP 0.7.1 Group 3), so a `.sql` file in
 * the listing or in the installed tree means a copy slipped back in beside the
 * bundle — one the installed service must never depend on.
 */
const SQL_FILE = /\.sql$/i;

/** Where the staged license lives in the workspace (`esbuild.mjs --package`). */
const STAGED_LICENSE = 'LICENSE';

/** A workspace file vsce packs under a name of its own choosing. */
interface RenamedFile {
  /** The name in the workspace, which is also what `vsce ls` prints. */
  readonly workspace: string;
  /** The names it may carry once installed, the current vsce's choice first. */
  readonly installed: readonly string[];
}

/**
 * Files vsce renames when it writes the VSIX: vsce 4 appends `.txt` to an
 * extensionless license and lower-cases the changelog. Each must be installed
 * under exactly one of its names, byte-identical to the workspace file.
 */
const RENAMED_BY_VSCE: readonly RenamedFile[] = Object.freeze([
  { workspace: STAGED_LICENSE, installed: Object.freeze(['LICENSE.txt', STAGED_LICENSE]) },
  { workspace: 'CHANGELOG.md', installed: Object.freeze(['changelog.md', 'CHANGELOG.md']) },
]);

/** The six pipeline stages whose prompts the embedded service loads (AAP 0.4.2). */
const PIPELINE_STAGES: readonly string[] = Object.freeze([
  'understand',
  'investigate',
  'plan',
  'analyze',
  'generate-panel',
  'followup',
]);

/** A prompt version id as `prompts/manifest.json` names it (`v001`, …). */
const PROMPT_VERSION_PATTERN = /^v\d{3}$/;

/** A stage key that is safe to use as one path segment. */
const STAGE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** One installed-extension line of `--list-extensions --show-versions`. */
const EXTENSION_LISTING_LINE = /^[A-Za-z0-9][\w-]*\.[A-Za-z0-9][\w.-]*@\S+$/;

// ---------------------------------------------------------------------------
// Step 7: the isolated window and its probe
// ---------------------------------------------------------------------------

/**
 * The compiled probe, extension-relative: `esbuild.mjs --tests`
 * (`LAYOUT.testProbeOut`) writes it, from
 * `test/probe/installed-extension-probe.ts`.
 */
const PROBE_BUNDLE = 'dist/test/probe/installed-extension-probe.js';

/** The command that builds the suites and the probe; named in the hint. */
const PREPARE_TESTS_COMMAND = 'pnpm --filter debug-generator run pretest:vscode';

/**
 * The probe's manifest, less `engines`, which is copied from the workspace
 * manifest so the probe loads in every editor the extension admits. It is a
 * development extension (`--extensionDevelopmentPath`) that activates once
 * the window has started, beside the installed extension.
 */
const PROBE_MANIFEST = Object.freeze({
  name: 'packaged-vsix-probe',
  displayName: 'Packaged VSIX probe (test only)',
  publisher: 'debuggen-test',
  version: '0.0.0',
  private: true,
  main: `./${path.posix.basename(PROBE_BUNDLE)}`,
  activationEvents: ['onStartupFinished'],
});

/**
 * Flags of the isolated window beyond its profile, workspace and probe: the
 * container requirements `.vscode-test.mjs` documents for the test editor
 * (`--no-sandbox` as root, no GPU, no `/dev/shm`), no telemetry, and no
 * trust prompt, welcome page or release notes that could hold focus. There is
 * deliberately no `--disable-extensions` — it would disable the installed
 * extension this step exists to run — and no `--extensionTestsPath`: with it
 * VS Code exits 1 after a quit, which would make the exit code meaningless.
 */
const ISOLATED_WINDOW_FLAGS: readonly string[] = Object.freeze([
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-telemetry',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
]);

/**
 * The store's DDL in the repository: the installed service must have migrated
 * its database from exactly this text (`meta.ddl_sha256`, written by
 * `apps/local-service/src/store/migrations.ts`).
 */
const STORE_DDL_SOURCE = 'apps/local-service/src/store/schema.sql';

/** Upper bound on the characters one window-log file contributes to a failure message. */
const MAX_WINDOW_LOG_CHARS = 4_000;

// ---------------------------------------------------------------------------
// Small local utilities (assertion support only; processes, ports, polling and
// profiles come from ../helpers)
// ---------------------------------------------------------------------------

/** A value an earlier step produced, or a failure naming the step that did not. */
function fromEarlierStep<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} is unavailable: the step that produces it did not complete.`);
  }
  return value;
}

/** Non-empty, trimmed lines of a command's captured output. */
function outputLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Whether `entry` is `forbidden` itself or lies below it (POSIX, relative). */
function isForbiddenEntry(entry: string, forbidden: string): boolean {
  return entry === forbidden || entry.startsWith(`${forbidden}/`);
}

/** The value following `flag` in an argument vector, or a thrown `Error`. */
function argumentAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined) {
    throw new Error(`Expected ${flag} <value> in ${JSON.stringify(args)}.`);
  }
  return value;
}

/** Whether `candidate` is `root` or lies beneath it (both absolute). */
function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** The `code` of a Node system error, if it has one. */
function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** `lstat` of `target`, or `undefined` when nothing exists there. */
async function lstatOrUndefined(target: string): Promise<Stats | undefined> {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Asserts `file` is a regular, non-empty file; `label` names it in the message. */
async function assertNonEmptyFile(file: string, label: string): Promise<void> {
  const stats = await lstatOrUndefined(file);
  assert.ok(stats !== undefined, `${label}: ${file} does not exist.`);
  assert.ok(stats.isFile(), `${label}: ${file} is not a regular file.`);
  assert.ok(stats.size > 0, `${label}: ${file} is empty.`);
}

/** Parses a JSON file into `unknown`, naming the file on failure. */
async function readJsonFile(file: string): Promise<unknown> {
  const text = await fsp.readFile(file, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`${file} is not valid JSON: ${String(cause)}`, { cause });
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** "exited with 1", "was ended by SIGKILL", "could not start: …". */
function describeExit(exit: ProcessExit): string {
  if (exit.error !== undefined) {
    return `could not start: ${exit.error.message}`;
  }
  return exit.code === null
    ? `was ended by ${exit.signal ?? 'an unknown signal'}`
    : `exited with ${exit.code}`;
}

/**
 * An extension-relative POSIX path from a manifest field (`icon`, `main`),
 * normalised (`./dist/x.js` -> `dist/x.js`); a path that is absolute or climbs
 * out of the extension fails, since VS Code could not load it from the VSIX.
 */
function extensionRelative(value: string, field: string): string {
  const normalised = path.posix.normalize(value.replace(/\\/g, '/'));
  if (
    normalised === '.' ||
    normalised === '..' ||
    normalised.startsWith('../') ||
    path.posix.isAbsolute(normalised) ||
    path.win32.isAbsolute(value)
  ) {
    throw new Error(
      `package.json#${field} is ${JSON.stringify(value)}, which is not a path inside the extension.`,
    );
  }
  return normalised;
}

/** `relative` (POSIX) resolved below `root`. */
function below(root: string, relative: string): string {
  return path.join(root, ...relative.split('/'));
}

/** Names of the `.vsix` files directly inside `directory`, sorted. */
async function vsixFilesIn(directory: string): Promise<string[]> {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.name.toLowerCase().endsWith('.vsix'))
    .map((entry) => entry.name)
    .sort();
}

/** The first `length` bytes of `file`. */
async function readHead(file: string, length: number): Promise<Buffer> {
  const handle = await fsp.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Every local file header of a ZIP archive, and so of a VSIX, starts with these bytes. */
const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** A failure message listing every problem found, one per line. */
function problemReport(summary: string, problems: readonly string[]): string {
  return `${summary}:\n  - ${problems.join('\n  - ')}`;
}

/**
 * Upper bound on the command output one failure message quotes. The reporter
 * prints each failure through the extension host's console, which replaces a
 * line of more than about 100 000 characters with "Output omitted for a large
 * object", so an unbounded quote would hide the very failure it explains.
 */
const MAX_QUOTED_OUTPUT_CHARS = 8_000;

/** `text` as a delimited message section, keeping its last {@link MAX_QUOTED_OUTPUT_CHARS} characters. */
function quoted(title: string, text: string): string {
  const trimmed = text.trim();
  const body =
    trimmed.length > MAX_QUOTED_OUTPUT_CHARS
      ? `[… ${trimmed.length - MAX_QUOTED_OUTPUT_CHARS} earlier characters omitted …]\n` +
        trimmed.slice(-MAX_QUOTED_OUTPUT_CHARS)
      : trimmed;
  return `\n--- ${title} ---\n${body === '' ? '(no output)' : body}\n--- end of ${title} ---`;
}

/**
 * A `vsce ls` listing for a failure message: every path below a
 * `node_modules/` directory (the preload's vendored dependency closure, a
 * thousand files) collapses into one line with a count, so the message shows
 * the extension's own files.
 */
function summariseListing(lines: readonly string[]): string {
  const marker = '/node_modules/';
  const collapsed = new Map<string, number>();
  const shown: string[] = [];
  for (const line of lines) {
    const at = line.indexOf(marker);
    if (at === -1) {
      shown.push(line);
    } else {
      const prefix = line.slice(0, at + marker.length);
      collapsed.set(prefix, (collapsed.get(prefix) ?? 0) + 1);
    }
  }
  for (const [prefix, count] of collapsed) {
    shown.push(`${prefix}… (${count} files)`);
  }
  return shown.join('\n');
}

/** The message of anything thrown. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How `child` exited, or `undefined` when it was still running after `budgetMs`. */
async function exitWithin(
  child: TrackedProcess,
  budgetMs: number,
): Promise<ProcessExit | undefined> {
  const controller = new AbortController();
  const budget = sleep(budgetMs, undefined, { signal: controller.signal }).then(
    () => undefined,
    () => undefined,
  );
  try {
    return await Promise.race([child.exited, budget]);
  } finally {
    controller.abort();
  }
}

/** Whether process `pid` is gone within `budgetMs` (zombies count as gone). */
async function stoppedWithin(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return false;
    }
    await sleep(Math.min(SERVICE_EXIT_POLL_MS, remaining));
  }
}

/** The real path of `target`, or `target` itself when nothing exists there. */
async function realPathOrSelf(target: string): Promise<string> {
  try {
    return await fsp.realpath(target);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return path.resolve(target);
    }
    throw error;
  }
}

/**
 * The isolated window's extension-host log and every Debug Generator output
 * log under `<userDataDir>/logs/`, the tail of each, as one message section.
 * They are what explains a failed activation or a service that never started.
 */
async function windowLogs(userDataDir: string): Promise<string> {
  const root = path.join(userDataDir, 'logs');
  let entries: string[];
  try {
    entries = await fsp.readdir(root, { recursive: true });
  } catch (error) {
    return quoted('isolated window logs', `could not list ${root}: ${reasonOf(error)}`);
  }
  const wanted = entries
    .filter((entry) => {
      const name = path.basename(entry);
      return name === 'exthost.log' || (name.includes('Debug Generator') && name.endsWith('.log'));
    })
    .sort();
  if (wanted.length === 0) {
    return quoted('isolated window logs', `no exthost.log or Debug Generator log under ${root}`);
  }
  const sections: string[] = [];
  for (const entry of wanted) {
    let text: string;
    try {
      text = await fsp.readFile(path.join(root, entry), 'utf8');
    } catch (error) {
      text = `could not read it: ${reasonOf(error)}`;
    }
    const tailText =
      text.length > MAX_WINDOW_LOG_CHARS ? `…${text.slice(-MAX_WINDOW_LOG_CHARS)}` : text;
    sections.push(`[${entry}]\n${tailText.trim()}`);
  }
  return quoted('isolated window logs', sections.join('\n'));
}

/** What the installed service wrote into its session store, read without writing. */
interface StoreFacts {
  /** `meta.ddl_sha256`: the digest of the DDL the store was migrated from. */
  readonly ddlSha256: string | undefined;
  /** Every table name, sorted. */
  readonly tables: readonly string[];
}

/** Opens `file` read-only with the runtime's built-in `node:sqlite`. */
function readStoreFacts(file: string): StoreFacts {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const digest = db.prepare("SELECT value FROM meta WHERE key = 'ddl_sha256'").get();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row['name'])
      .filter((name): name is string => typeof name === 'string');
    const value = digest?.['value'];
    return { ddlSha256: typeof value === 'string' ? value : undefined, tables };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('packaged VSIX: a self-contained install with a working embedded service', function () {
  this.timeout(TEST_TIMEOUT_MS);
  this.slow(SLOW_STEP_MS);
  // Every step consumes what the previous one produced, so after the first
  // failure the remaining steps could only report consequences of it. The
  // `after` hook (step 8) still runs.
  this.bail(true);

  /** The workspace directory: the cwd of every pnpm and vsce call. */
  let extensionRoot: string | undefined;
  /** The workspace `package.json`, validated from disk. */
  let workspaceManifest: ExtensionManifest | undefined;
  /** `.vsix` files the workspace held before the run (a developer's own). */
  let preexistingWorkspaceVsix: readonly string[] = [];
  /** The scratch root; everything the suite creates lies below it. */
  let scratch: string | undefined;
  /** The packaged extension (step 3). */
  let vsixPath: string | undefined;
  /** The throwaway profile of the VS Code CLI (step 4). */
  let extensionsDir: string | undefined;
  let userDataDir: string | undefined;
  /** The installed extension's directory (step 5). */
  let installedRoot: string | undefined;
  /** The staged companion extension of the isolated window (`before`, step 7). */
  let probeDir: string | undefined;
  /** The isolated window's `DEBUGGEN_HOME`, workspace and process (step 7). */
  let isolatedHome: string | undefined;
  let isolatedWorkspace: string | undefined;
  let isolatedWindow: TrackedProcess | undefined;
  /** The pid of the service the installed extension started (step 7). */
  let servicePid: number | undefined;

  before(async function () {
    extensionRoot = extensionDevelopmentRoot();
    workspaceManifest = readManifestFromDisk(path.join(extensionRoot, 'package.json'));
    assert.equal(
      `${workspaceManifest.publisher}.${workspaceManifest.name}`,
      EXTENSION_ID,
      'package.json "publisher" and "name" must form the extension id the suites assert against.',
    );
    preexistingWorkspaceVsix = await vsixFilesIn(extensionRoot);
    scratch = createScratchDir('packaged-vsix-');

    // Stage the probe of step 7 now: the production builds of steps 1 and 3
    // delete dist/test/, and the compiled probe with it.
    const bundle = below(extensionRoot, PROBE_BUNDLE);
    const bundleStats = await lstatOrUndefined(bundle);
    if (bundleStats?.isFile() !== true || bundleStats.size === 0) {
      throw new Error(
        `The compiled probe ${bundle} does not exist or is empty. Build the suites and the probe ` +
          `with "${PREPARE_TESTS_COMMAND}" (pnpm test:vscode runs it first).`,
      );
    }
    probeDir = path.join(scratch, 'probe');
    await fsp.mkdir(probeDir);
    const bundleName = path.basename(bundle);
    await fsp.copyFile(bundle, path.join(probeDir, bundleName), fsp.constants.COPYFILE_EXCL);
    if ((await lstatOrUndefined(`${bundle}.map`))?.isFile() === true) {
      await fsp.copyFile(
        `${bundle}.map`,
        path.join(probeDir, `${bundleName}.map`),
        fsp.constants.COPYFILE_EXCL,
      );
    }
    writeFixtureFile(
      probeDir,
      'package.json',
      `${JSON.stringify(
        { ...PROBE_MANIFEST, engines: { vscode: workspaceManifest.engines.vscode } },
        null,
        2,
      )}\n`,
    );
  });

  it('1. builds the extension with its own vscode:prepublish script', async function () {
    const root = fromEarlierStep(extensionRoot, 'The extension workspace');
    const manifest = fromEarlierStep(workspaceManifest, 'The workspace manifest');

    // The script vsce runs before packaging: the production host, service and
    // preload bundles, the `--package` staging of the root LICENSE, then the
    // webview. runToCompletion throws with the captured output on any exit
    // code other than 0, on a timeout, and when pnpm cannot be started.
    const build = await runToCompletion('pnpm', ['run', PREPUBLISH_SCRIPT], {
      cwd: root,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    assert.equal(build.code, 0, `pnpm run ${PREPUBLISH_SCRIPT} exited with ${build.code}.`);

    const main = extensionRelative(manifest.main, 'main');
    const entry = await lstatOrUndefined(below(root, main));
    assert.ok(
      entry?.isFile() === true && entry.size > 0,
      `pnpm run ${PREPUBLISH_SCRIPT} exited 0 without writing package.json#main (${main}).` +
        quoted('build output', build.output),
    );
  });

  it('2. vsce ls lists every runtime artefact and no source, test or tooling file', async function () {
    const root = fromEarlierStep(extensionRoot, 'The extension workspace');
    const manifest = fromEarlierStep(workspaceManifest, 'The workspace manifest');

    // No prepublish runs here, so the listing is exactly what step 1 built.
    // stdin is closed, so no prompt can ever hold the step open.
    const ls = await runToCompletion('pnpm', ['exec', 'vsce', 'ls', '--no-dependencies'], {
      cwd: root,
      timeoutMs: LIST_TIMEOUT_MS,
    });
    const lines = outputLines(ls.output);
    const listed = new Set(lines);
    const lsSection = quoted('vsce ls output, dependency trees collapsed', summariseListing(lines));

    const expected = [
      ...PACKAGED_FILES,
      extensionRelative(manifest.icon, 'icon'),
      ...RENAMED_BY_VSCE.map((file) => file.workspace),
    ];
    const missing = expected.filter((file) => !listed.has(file));
    assert.deepEqual(
      missing,
      [],
      `vsce ls does not list ${missing.join(', ')}. The VSIX would lack them: check .vscodeignore's ` +
        `re-include rules, the dist/ layout of esbuild.mjs and vite.config.ts, and that ` +
        `"esbuild.mjs --package" (${PREPUBLISH_SCRIPT}) staged ${STAGED_LICENSE}.${lsSection}`,
    );

    const leaked = [...listed].filter((entry) =>
      FORBIDDEN_ENTRIES.some((forbidden) => isForbiddenEntry(entry, forbidden)),
    );
    assert.deepEqual(
      leaked,
      [],
      `vsce ls lists workspace files that must never ship: ${leaked.join(', ')}. ` +
        `.vscodeignore must exclude everything outside its keep-set.${lsSection}`,
    );

    const sqlFiles = [...listed].filter((entry) => SQL_FILE.test(entry));
    assert.deepEqual(
      sqlFiles,
      [],
      `vsce ls lists SQL file(s): ${sqlFiles.join(', ')}. The store DDL must ship only inlined in ` +
        `dist/service/main.js; esbuild.mjs must not write a .sql file under dist/.${lsSection}`,
    );

    // The staged license must be the repository-root LICENSE, byte for byte.
    const staged = await fsp.readFile(path.join(root, STAGED_LICENSE));
    const original = await fsp.readFile(path.join(repositoryRoot(), 'LICENSE'));
    assert.ok(
      staged.equals(original),
      `${path.join(root, STAGED_LICENSE)} differs from the repository-root LICENSE it is staged from.`,
    );
  });

  it('3. vsce package writes the .vsix into a scratch directory, never into the workspace', async function () {
    const root = fromEarlierStep(extensionRoot, 'The extension workspace');
    const manifest = fromEarlierStep(workspaceManifest, 'The workspace manifest');
    const scratchRoot = fromEarlierStep(scratch, 'The scratch directory');

    const outDir = path.join(scratchRoot, 'vsix');
    await fsp.mkdir(outDir);
    const target = path.join(outDir, `${manifest.name}-${manifest.version}.vsix`);

    // vsce runs vscode:prepublish again first, so the package is built from
    // the same scripts step 1 ran; step 5 inspects what it produced.
    await runToCompletion(
      'pnpm',
      ['exec', 'vsce', 'package', '--no-dependencies', '--out', target],
      { cwd: root, timeoutMs: BUILD_TIMEOUT_MS },
    );

    await assertNonEmptyFile(target, 'vsce package --out');
    const head = await readHead(target, ZIP_LOCAL_FILE_HEADER.length);
    assert.ok(
      head.equals(ZIP_LOCAL_FILE_HEADER),
      `${target} does not start with a ZIP local file header (got ${head.toString('hex')}).`,
    );

    const strays = (await vsixFilesIn(root)).filter(
      (name) => !preexistingWorkspaceVsix.includes(name),
    );
    assert.deepEqual(strays, [], `vsce package wrote ${strays.join(', ')} into ${root}.`);
    vsixPath = target;
  });

  it('4. installs into a throwaway VS Code profile and lists exactly debuggen.debug-generator@<version> there', async function () {
    const manifest = fromEarlierStep(workspaceManifest, 'The workspace manifest');
    const scratchRoot = fromEarlierStep(scratch, 'The scratch directory');
    const vsix = fromEarlierStep(vsixPath, 'The packaged .vsix');

    const [cli, ...leading] = resolveVsCodeCliArgs();
    if (cli === undefined) {
      throw new Error('resolveVsCodeCliArgs() returned no VS Code CLI executable.');
    }
    // Only ever the throwaway profile: the developer's real extensions and
    // user-data directories are never named, so they cannot be touched.
    const profile = throwawayCliProfileArgs(path.join(scratchRoot, 'profile'));
    extensionsDir = argumentAfter(profile, '--extensions-dir');
    userDataDir = argumentAfter(profile, '--user-data-dir');

    await runToCompletion(cli, [...leading, ...profile, '--install-extension', vsix, '--force'], {
      cwd: scratchRoot,
      timeoutMs: CLI_TIMEOUT_MS,
    });
    const listing = await runToCompletion(
      cli,
      [...leading, ...profile, '--list-extensions', '--show-versions'],
      { cwd: scratchRoot, timeoutMs: CLI_TIMEOUT_MS },
    );

    // The profile is fresh, so the extension under test is the only one in it.
    const installed = outputLines(listing.output).filter((line) =>
      EXTENSION_LISTING_LINE.test(line),
    );
    assert.deepEqual(
      installed,
      [`${EXTENSION_ID}@${manifest.version}`],
      `--list-extensions --show-versions on the throwaway profile does not list exactly ` +
        `${EXTENSION_ID}@${manifest.version}.${quoted('CLI output', listing.output)}`,
    );
  });

  it('5. the installed extension holds the runtime artefact and nothing else from the workspace', async function () {
    const root = fromEarlierStep(extensionRoot, 'The extension workspace');
    const manifest = fromEarlierStep(workspaceManifest, 'The workspace manifest');
    const scratchRoot = fromEarlierStep(scratch, 'The scratch directory');
    const extensions = fromEarlierStep(extensionsDir, 'The throwaway extensions directory');

    const candidates: { readonly dir: string; readonly manifest: ExtensionManifest }[] = [];
    const entries = await fsp.readdir(extensions, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(extensions, entry.name);
      if ((await lstatOrUndefined(path.join(dir, 'package.json'))) === undefined) {
        continue;
      }
      const candidate = readManifestFromDisk(path.join(dir, 'package.json'));
      if (`${candidate.publisher}.${candidate.name}` === EXTENSION_ID) {
        candidates.push({ dir, manifest: candidate });
      }
    }
    const [found, ...others] = candidates;
    assert.ok(
      found !== undefined && others.length === 0,
      `Expected exactly one installed ${EXTENSION_ID} under ${extensions}; found ` +
        `${candidates.length === 0 ? 'none' : candidates.map((candidate) => candidate.dir).join(', ')} ` +
        `(entries: ${entries.map((entry) => entry.name).join(', ') || 'none'}).`,
    );
    assert.equal(
      found.manifest.version,
      manifest.version,
      `The installed ${EXTENSION_ID} (${found.dir}) is not the version the workspace packaged.`,
    );
    installedRoot = found.dir;

    const problems: string[] = [];

    // Present: every runtime artefact, the icon package.json#icon names and
    // the entry point package.json#main names, as non-empty files.
    const icon = extensionRelative(found.manifest.icon, 'icon');
    const main = extensionRelative(found.manifest.main, 'main');
    for (const file of new Set([...PACKAGED_FILES, icon, main])) {
      const stats = await lstatOrUndefined(below(found.dir, file));
      if (stats === undefined) {
        problems.push(`${file} is missing`);
      } else if (!stats.isFile() || stats.size === 0) {
        problems.push(`${file} is not a non-empty regular file`);
      }
    }

    // The embedded service is ESM beside a CommonJS extension host.
    const serviceManifestFile = below(found.dir, 'dist/service/package.json');
    if ((await lstatOrUndefined(serviceManifestFile)) !== undefined) {
      const serviceManifest = await readJsonFile(serviceManifestFile);
      if (!isRecord(serviceManifest) || serviceManifest['type'] !== 'module') {
        problems.push(
          `dist/service/package.json does not declare "type": "module" (found ${JSON.stringify(serviceManifest)})`,
        );
      }
    }

    // The license (the staged copy of the repository-root LICENSE, step 2)
    // and the changelog, under the names vsce gave them. Matched against the
    // directory listing rather than probed, so a case-insensitive file system
    // cannot report one file under both spellings.
    const topLevel = new Set(await fsp.readdir(found.dir));
    for (const file of RENAMED_BY_VSCE) {
      const present = file.installed.filter((name) => topLevel.has(name));
      const [name, ...extra] = present;
      if (name === undefined || extra.length > 0) {
        problems.push(
          `${file.workspace}: expected exactly one of ${file.installed.join(', ')}; found ${present.join(', ') || 'none'}`,
        );
        continue;
      }
      const installedBytes = await fsp.readFile(path.join(found.dir, name));
      const workspaceBytes = await fsp.readFile(path.join(root, file.workspace));
      if (!installedBytes.equals(workspaceBytes)) {
        problems.push(`${name} differs from the workspace's ${file.workspace}`);
      }
    }

    // Absent: sources, tests, dependencies and build tooling.
    for (const entry of FORBIDDEN_ENTRIES) {
      if ((await lstatOrUndefined(below(found.dir, entry))) !== undefined) {
        problems.push(`${entry} is present (${below(found.dir, entry)}) but must never ship`);
      }
    }

    // Absent anywhere in the tree: a SQL file. The store DDL is inlined into
    // the service bundle, and step 7 proves the service migrates from it.
    const installedSql = (await fsp.readdir(found.dir, { recursive: true }))
      .filter((entry) => SQL_FILE.test(entry))
      .sort();
    if (installedSql.length > 0) {
      problems.push(
        `SQL file(s) are installed (${installedSql.join(', ')}) although the store DDL ships only ` +
          'inlined in dist/service/main.js',
      );
    }

    // The running editor loaded nothing from the throwaway profile: the
    // install went to that profile only.
    const loadedFromScratch = vscode.extensions.all
      .filter((extension) => isWithin(path.resolve(extension.extensionUri.fsPath), scratchRoot))
      .map((extension) => `${extension.id} (${extension.extensionUri.fsPath})`);
    if (loadedFromScratch.length > 0) {
      problems.push(
        `the running editor loaded extensions from the scratch profile: ${loadedFromScratch.join(', ')}`,
      );
    }

    assert.deepEqual(
      problems,
      [],
      problemReport(`The installed extension at ${found.dir} is not the expected tree`, problems),
    );
  });

  it('6. the embedded prompt directory resolves all six pipeline stages', async function () {
    const root = fromEarlierStep(installedRoot, 'The installed extension');
    const promptsDir = below(root, 'dist/service/prompts');
    const manifestFile = path.join(promptsDir, 'manifest.json');
    const promptManifest = await readJsonFile(manifestFile);
    const problems: string[] = [];

    const version = isRecord(promptManifest) ? promptManifest['version'] : undefined;
    const stages = isRecord(promptManifest) ? promptManifest['stages'] : undefined;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
      problems.push(`"version" is not a positive integer (found ${JSON.stringify(version)})`);
    }
    if (!isRecord(stages)) {
      problems.push(`"stages" is not an object (found ${JSON.stringify(stages)})`);
    } else {
      for (const stage of PIPELINE_STAGES) {
        if (!(stage in stages)) {
          problems.push(`stage "${stage}" is not listed`);
        }
      }
      for (const [stage, entry] of Object.entries(stages)) {
        if (!STAGE_NAME_PATTERN.test(stage)) {
          problems.push(`stage key ${JSON.stringify(stage)} is not a plain directory name`);
          continue;
        }
        const current = isRecord(entry) ? entry['current'] : undefined;
        if (typeof current !== 'string' || !PROMPT_VERSION_PATTERN.test(current)) {
          problems.push(
            `stages.${stage}.current is not a version id like "v001" (found ${JSON.stringify(current)})`,
          );
          continue;
        }
        const available = isRecord(entry) ? entry['available'] : undefined;
        const versions = new Set([current]);
        if (available !== undefined) {
          if (!Array.isArray(available)) {
            problems.push(`stages.${stage}.available is not an array`);
          } else {
            const listedVersions: readonly unknown[] = available;
            for (const candidate of listedVersions) {
              if (typeof candidate === 'string' && PROMPT_VERSION_PATTERN.test(candidate)) {
                versions.add(candidate);
              } else {
                problems.push(
                  `stages.${stage}.available holds ${JSON.stringify(candidate)}, not a version id`,
                );
              }
            }
            if (!listedVersions.includes(current)) {
              problems.push(`stages.${stage}.available does not include current ${current}`);
            }
          }
        }
        for (const promptVersion of versions) {
          const file = path.join(promptsDir, stage, `${promptVersion}.md`);
          const stats = await lstatOrUndefined(file);
          if (stats === undefined || !stats.isFile() || stats.size === 0) {
            problems.push(`${stage}/${promptVersion}.md is missing or empty (${file})`);
          }
        }
      }
    }

    assert.deepEqual(
      problems,
      [],
      problemReport(`The embedded prompt manifest ${manifestFile} does not resolve`, problems),
    );
  });

  it('7. the installed extension, activated in an isolated VS Code window, starts its embedded service, which answers GET /health', async function () {
    const manifest = fromEarlierStep(workspaceManifest, 'The workspace manifest');
    const scratchRoot = fromEarlierStep(scratch, 'The scratch directory');
    const root = fromEarlierStep(installedRoot, 'The installed extension');
    const extensions = fromEarlierStep(extensionsDir, 'The throwaway extensions directory');
    const userData = fromEarlierStep(userDataDir, 'The throwaway user-data directory');
    const probe = fromEarlierStep(probeDir, 'The staged probe');

    const port = await findFreePort();
    // Not created here: the extension's process manager creates it, 0700.
    const home = path.join(scratchRoot, 'installed-home');
    isolatedHome = home;
    // An empty folder, so the window opens a workspace that is nobody's project.
    const workspace = path.join(scratchRoot, 'installed-workspace');
    isolatedWorkspace = workspace;
    await fsp.mkdir(workspace);
    const resultFile = path.join(scratchRoot, 'probe-result.json');

    // User settings of the throwaway profile: debuggen.serviceUrl is
    // machine-scoped, so VS Code honours it from user settings only. Nothing
    // may reach a marketplace or an update server.
    writeFixtureFile(
      userData,
      'User/settings.json',
      `${JSON.stringify(
        {
          'debuggen.serviceUrl': `http://127.0.0.1:${port}`,
          'debuggen.autoStartService': true,
          'debuggen.provider': 'deterministic',
          'update.mode': 'none',
          'extensions.autoCheckUpdates': false,
          'extensions.autoUpdate': false,
        },
        null,
        2,
      )}\n`,
    );
    const config: ProbeConfig = {
      targetExtensionId: EXTENSION_ID,
      expectedVersion: manifest.version,
      installedExtensionsDir: extensions,
      servicePort: port,
      healthPath: healthPath(),
      resultFile,
      healthTimeoutMs: HEALTH_TIMEOUT_MS,
    };
    writeFixtureFile(probe, PROBE_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);

    // The editor binary itself, as a separate instance on the throwaway
    // profile: it loads the installed extension from --extensions-dir in
    // Production mode and the probe as its one development extension.
    // hermeticEnv() strips ELECTRON_* and VSCODE_*, so the binary starts as an
    // editor and cannot attach to the window running this suite; DEBUGGEN_HOME
    // reaches the extension, which hands it to its service.
    const window = spawnTracked(
      resolveVsCodeExecutable(),
      [
        ...ISOLATED_WINDOW_FLAGS,
        `--user-data-dir=${userData}`,
        `--extensions-dir=${extensions}`,
        `--extensionDevelopmentPath=${probe}`,
        workspace,
      ],
      { cwd: scratchRoot, env: hermeticEnv({ DEBUGGEN_HOME: home }) },
    );
    isolatedWindow = window;

    const exit = await exitWithin(window, ISOLATED_WINDOW_TIMEOUT_MS);
    if (exit === undefined) {
      let stopNote = 'It was stopped.';
      try {
        await window.stop();
      } catch (error) {
        stopNote = `Stopping it failed as well: ${reasonOf(error)}`;
      }
      assert.fail(
        `The isolated window (${window.commandLine}) did not exit within ${ISOLATED_WINDOW_TIMEOUT_MS} ms: ` +
          `the probe never quit it. ${stopNote}` +
          quoted('isolated window output', window.output()) +
          (await windowLogs(userData)),
      );
    }

    // The probe's record, validated, then every assertion quotes it together
    // with the window's own output and logs.
    const resultStats = await lstatOrUndefined(resultFile);
    if (resultStats === undefined) {
      assert.fail(
        `The probe wrote no result to ${resultFile}; the isolated window ${describeExit(exit)}.` +
          quoted('isolated window output', window.output()) +
          (await windowLogs(userData)),
      );
    }
    const result: ProbeResult = parseProbeResult(await readJsonFile(resultFile), resultFile);
    const evidence =
      quoted('probe result', JSON.stringify(result, null, 2)) +
      quoted('isolated window output', window.output()) +
      (await windowLogs(userData));

    assert.equal(exit.code, 0, `The isolated window ${describeExit(exit)}, not 0.${evidence}`);
    assert.ok(
      result.ok,
      `The probe in the isolated window failed: ${result.failure ?? 'no reason recorded'}.${evidence}`,
    );

    // The window ran the copy step 5 inspected, from the throwaway profile.
    const extension = result.extension;
    assert.ok(extension !== null, `The probe recorded no extension facts.${evidence}`);
    const installedReal = await fsp.realpath(root);
    assert.equal(
      extension.realPath,
      installedReal,
      `The isolated window loaded ${EXTENSION_ID} from ${extension.realPath}, not from the installed copy.${evidence}`,
    );
    assert.ok(
      isWithin(extension.realPath, await fsp.realpath(extensions)),
      `${extension.realPath} is outside the throwaway extensions directory ${extensions}.${evidence}`,
    );
    assert.equal(
      extension.version,
      manifest.version,
      `The isolated window loaded ${EXTENSION_ID}@${String(extension.version)}, not the packaged version.${evidence}`,
    );
    assert.equal(
      extension.activeAfter,
      true,
      `The installed ${EXTENSION_ID} is not active after activate().${evidence}`,
    );

    // Its embedded service answers, and the extension's own client is connected.
    const health = result.health;
    assert.ok(health !== null, `The probe recorded no health facts.${evidence}`);
    assert.equal(
      health.status,
      200,
      `GET ${health.url} answered ${String(health.status)}.${evidence}`,
    );
    const parsed = healthResponseSchema.safeParse(health.body);
    if (!parsed.success) {
      assert.fail(
        `GET ${health.url} answered a body healthResponseSchema rejects: ` +
          `${JSON.stringify(parsed.error.issues)}.${evidence}`,
      );
    }
    assert.equal(
      parsed.data.protocolVersion,
      PROTOCOL_VERSION,
      `The embedded service speaks a different wire version than the @debuggen/protocol it was built with.${evidence}`,
    );
    assert.equal(
      parsed.data.pairingAvailable,
      true,
      `The installed extension's editor client never connected to its service, so pairing is unavailable.${evidence}`,
    );

    // Exactly one service process, the extension host's child, running the
    // installed entry with the installed prompts, the window's state
    // directory and the configured port.
    const serviceEntry = await fsp.realpath(below(root, 'dist/service/main.js'));
    const processes = result.serviceProcesses ?? [];
    const service = processes[0];
    assert.ok(
      service !== undefined && processes.length === 1,
      `Expected exactly one process running ${serviceEntry}; found ${processes.length}: ` +
        `${JSON.stringify(processes)}.${evidence}`,
    );
    servicePid = service.pid;
    assert.equal(
      service.entry,
      serviceEntry,
      `The service process runs ${service.entry}, not the installed entry.${evidence}`,
    );
    assert.equal(
      service.ppid,
      result.hostPid,
      `The service process (pid ${service.pid}) is not a child of the isolated window's extension ` +
        `host (pid ${result.hostPid}): the installed extension did not start it.${evidence}`,
    );
    const promptsDir = service.env.DEBUGGEN_PROMPTS_DIR;
    assert.equal(
      promptsDir === null ? null : await realPathOrSelf(promptsDir),
      await fsp.realpath(below(root, 'dist/service/prompts')),
      `The service's DEBUGGEN_PROMPTS_DIR is ${JSON.stringify(promptsDir)}, not the installed prompt directory.${evidence}`,
    );
    const serviceHome = service.env.DEBUGGEN_HOME;
    assert.equal(
      serviceHome === null ? null : path.resolve(serviceHome),
      home,
      `The service's DEBUGGEN_HOME is ${JSON.stringify(serviceHome)}, not the window's ${home}.${evidence}`,
    );
    assert.equal(
      service.env.DEBUGGEN_PORT,
      String(port),
      `The service's DEBUGGEN_PORT is ${JSON.stringify(service.env.DEBUGGEN_PORT)}, not ${port}.${evidence}`,
    );

    // The window quit, so VS Code deactivated the extension, which stops its
    // service: nothing of it may outlive the editor.
    assert.ok(
      await stoppedWithin(service.pid, SERVICE_EXIT_TIMEOUT_MS),
      `The embedded service (pid ${service.pid}) is still alive ${SERVICE_EXIT_TIMEOUT_MS} ms after ` +
        `the isolated window exited: the installed extension's deactivate() did not stop it.${evidence}`,
    );

    // It kept its state in the window's DEBUGGEN_HOME, created owner-only.
    const homeStats = await lstatOrUndefined(home);
    assert.ok(
      homeStats?.isDirectory() === true,
      `The installed extension's service did not create DEBUGGEN_HOME ${home}.${evidence}`,
    );
    assert.equal(
      homeStats.mode & 0o777,
      0o700,
      `DEBUGGEN_HOME ${home} has mode ${(homeStats.mode & 0o777).toString(8)}, not 700.`,
    );
    for (const name of ['auth.json', 'sessions.sqlite']) {
      const stats = await lstatOrUndefined(path.join(home, name));
      assert.ok(
        stats?.isFile() === true,
        `The installed extension and its service did not write ${name} into ${home}.${evidence}`,
      );
    }

    // And it migrated its store from the repository's DDL, which the VSIX
    // carries only inside the service bundle.
    const ddl = await fsp.readFile(
      path.join(repositoryRoot(), ...STORE_DDL_SOURCE.split('/')),
      'utf8',
    );
    const expectedDigest = createHash('sha256').update(ddl, 'utf8').digest('hex');
    const store = readStoreFacts(path.join(home, 'sessions.sqlite'));
    assert.equal(
      store.ddlSha256,
      expectedDigest,
      `${path.join(home, 'sessions.sqlite')} records meta.ddl_sha256 ${JSON.stringify(store.ddlSha256)}, ` +
        `not the digest of ${STORE_DDL_SOURCE}.`,
    );
    assert.ok(
      store.tables.includes('sessions'),
      `${path.join(home, 'sessions.sqlite')} has no "sessions" table (tables: ${store.tables.join(', ') || 'none'}).`,
    );
  });

  // Step 8: teardown, then proof that it left nothing behind.
  after(async function () {
    const problems: string[] = [];

    try {
      await stopTrackedProcesses();
    } catch (error) {
      problems.push(`stopTrackedProcesses() failed: ${reasonOf(error)}`);
    }
    try {
      await cleanupScratch();
    } catch (error) {
      problems.push(`cleanupScratch() failed: ${reasonOf(error)}`);
    }

    const survivors = listTrackedProcesses().map(
      (entry) => `${entry.commandLine} (pid ${entry.pid ?? 'none'})`,
    );
    if (survivors.length > 0) {
      problems.push(`tracked child processes survived teardown: ${survivors.join(', ')}`);
    }
    if (isolatedWindow?.pid !== undefined && isolatedWindow.isRunning()) {
      problems.push(`the isolated window (pid ${isolatedWindow.pid}) is still running`);
    }
    if (servicePid !== undefined && isProcessAlive(servicePid)) {
      problems.push(
        `the installed extension's embedded service (pid ${servicePid}) is still alive`,
      );
    }

    const leftovers: readonly (readonly [string, string | undefined])[] = [
      ['the packaged .vsix', vsixPath],
      ['the throwaway extensions directory', extensionsDir],
      ['the throwaway user-data directory', userDataDir],
      ['the staged probe', probeDir],
      ["the isolated window's DEBUGGEN_HOME", isolatedHome],
      ["the isolated window's workspace", isolatedWorkspace],
      ['the scratch directory', scratch],
    ];
    for (const [label, target] of leftovers) {
      if (target !== undefined && (await lstatOrUndefined(target)) !== undefined) {
        problems.push(`${label} ${target} still exists`);
      }
    }
    if (extensionRoot !== undefined) {
      const strays = (await vsixFilesIn(extensionRoot)).filter(
        (name) => !preexistingWorkspaceVsix.includes(name),
      );
      if (strays.length > 0) {
        problems.push(`the workspace holds new .vsix files: ${strays.join(', ')}`);
      }
    }

    assert.deepEqual(problems, [], problemReport('Teardown left residue', problems));
  });
});
