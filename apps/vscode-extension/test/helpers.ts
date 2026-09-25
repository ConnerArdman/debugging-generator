/**
 * Shared test support for the extension-host suites under `test/suite/`.
 *
 * The five mocha suites (activation, commands, open-location, uri-handler and
 * packaged-vsix) run inside a real VS Code under `pnpm test:vscode`. This
 * module makes them hermetic, deterministic and honest, and asserts nothing
 * about product behaviour itself:
 *
 * - **Hermetic.** Every directory it creates lives under `os.tmpdir()`; every
 *   child it spawns gets {@link hermeticEnv} (no provider credential, the
 *   deterministic provider, the run's throwaway `DEBUGGEN_HOME`); every HTTP
 *   probe is loopback-only and refuses the product's default service port; the
 *   VS Code CLI only ever runs against a throwaway profile.
 * - **No residue.** Scratch directories, cleanup callbacks and child processes
 *   are registered as they are created and removed by one call,
 *   {@link cleanupScratch}, which every suite awaits in `after`. Nothing here
 *   writes inside the repository working tree, which is what keeps
 *   `git status --porcelain` empty after a run — the property
 *   `tests/e2e/cleanup.spec.ts` and `scripts/check-no-residual-instrumentation.mjs`
 *   rely on elsewhere in the repository.
 * - **Honest failure.** A timeout or a failed precondition throws an `Error`
 *   naming what was awaited, with the last observed value and any captured
 *   child output. Nothing here returns a sentinel a caller could mistake for
 *   success, and nothing offers a "skip if unavailable" path.
 *
 * Build and module notes. `esbuild.mjs --tests` inlines this file into each
 * `dist/test/suite/<name>.test.js` bundle (CommonJS; `vscode` and `mocha`
 * external; packages this workspace declares, such as `@vscode/test-electron`,
 * stay external and resolve from `node_modules` at run time). Its name has no
 * `.test.` segment, so the runner's glob never collects it. Because each suite
 * bundle carries its own copy, every registry below (scratch directories,
 * cleanups, child processes, the activation memo) is per suite: one suite's
 * `cleanupScratch()` never touches another suite's resources.
 *
 * The module uses no mocha global, so it needs no test-framework typings, and
 * it imports nothing from `src/**`: each suite imports the product module it
 * asserts against, and this file stays policy-free.
 *
 * @module apps/vscode-extension/test/helpers
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { inspect } from 'node:util';

import type { SourceLocation, SourceResolvedBy } from '@debuggen/shared';
import { resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Identity and constants
// ---------------------------------------------------------------------------

/**
 * `<publisher>.<name>` of the extension under test.
 *
 * This and the two view ids below deliberately restate values that
 * `apps/vscode-extension/package.json` and `src/views/*` own. The duplication
 * is a cross-check, not a second source of truth: `suite/commands.test.ts` and
 * `suite/activation.test.ts` assert each constant back against the manifest, so
 * a rename on either side fails the gate instead of passing silently.
 */
export const EXTENSION_ID = 'debuggen.debug-generator';

/** The contributed webview view id (cross-checked against the manifest). */
export const SESSION_VIEW_ID = 'debuggen.session';

/** The contributed Sessions tree view id (cross-checked against the manifest). */
export const SESSIONS_VIEW_ID = 'debuggen.sessions';

/**
 * Prefix of every scratch directory. `.vscode-test.mjs` uses the same prefix
 * for the run's own throwaway state, so "no `debuggen-vscode-test-*` directory
 * left in `os.tmpdir()`" is one check that covers both.
 */
export const SCRATCH_PREFIX = 'debuggen-vscode-test-';

/**
 * The POSIX suffix the opened workspace folder must end with: the generic
 * fixture workspace `.vscode-test.mjs` opens, never the repository root and
 * never another project.
 */
export const FIXTURE_WORKSPACE_SUFFIX = 'apps/vscode-extension/test/fixtures/workspace';

/** Default overall budget of {@link waitFor}. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

/** Default delay between two {@link waitFor} probes. */
export const DEFAULT_POLL_INTERVAL_MS = 100;

/** Default per-request timeout of {@link fetchJsonWithoutOrigin}. */
export const DEFAULT_HTTP_TIMEOUT_MS = 2_000;

/**
 * Default budget of {@link runToCompletion}: a production build or a
 * `vsce package` on a CPU shared with other builds takes minutes, and
 * `.vscode-test.mjs` gives each test ten.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;

/** How long a stopped child gets between `SIGTERM` and `SIGKILL`. */
export const PROCESS_STOP_GRACE_MS = 5_000;

/** How long a child gets to disappear after `SIGKILL` before stopping fails. */
const PROCESS_KILL_WAIT_MS = 5_000;

/** Poll interval while waiting for a signalled child to exit. */
const PROCESS_POLL_INTERVAL_MS = 50;

/** How long captured output may take to drain after a child has exited. */
const OUTPUT_DRAIN_TIMEOUT_MS = 2_000;

/**
 * The port the product's service listens on by default. A developer may be
 * running the real service there, so no helper ever returns or contacts it.
 */
const PRODUCT_DEFAULT_SERVICE_PORT = 43_117;

/** Upper bound on the output one child keeps in memory (the tail is kept). */
const MAX_CAPTURED_OUTPUT_CHARS = 2_000_000;

/** How much of a child's output a thrown error message carries. */
const MAX_OUTPUT_IN_MESSAGE_CHARS = 20_000;

/** How much of a rendered probe value a timeout message carries. */
const MAX_RENDERED_VALUE_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Small internal utilities
// ---------------------------------------------------------------------------

/** A parsed JSON object, before any of its members has been validated. */
type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `code` of a Node system error (`ENOENT`, `ESRCH`, …), if it has one. */
function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** One-line rendering of anything thrown, including one level of `cause`. */
function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const inner = error.errors.map((entry) => describeError(entry)).join('; ');
    return `${error.name}: ${error.message} [${inner}]`;
  }
  if (error instanceof Error) {
    const cause = error.cause === undefined ? '' : ` (cause: ${renderValue(error.cause)})`;
    return `${error.name}: ${error.message}${cause}`;
  }
  return renderValue(error);
}

/** Safe, bounded rendering of an arbitrary value for a failure message. */
function renderValue(value: unknown): string {
  const rendered =
    value instanceof Error
      ? `${value.name}: ${value.message}`
      : inspect(value, {
          depth: 3,
          breakLength: Number.POSITIVE_INFINITY,
          maxArrayLength: 20,
          maxStringLength: 500,
        });
  return rendered.length > MAX_RENDERED_VALUE_CHARS
    ? `${rendered.slice(0, MAX_RENDERED_VALUE_CHARS)}… (${rendered.length - MAX_RENDERED_VALUE_CHARS} more characters)`
    : rendered;
}

/** The last `limit` characters of `text`, marked when something was cut. */
function tail(text: string, limit: number): string {
  return text.length > limit
    ? `[… ${text.length - limit} earlier characters omitted …]\n${text.slice(-limit)}`
    : text;
}

/** A positive, finite duration, or a thrown `RangeError` naming the option. */
function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `${name} must be a positive, finite number of milliseconds (got ${value}).`,
    );
  }
  return value;
}

function isFile(target: string): boolean {
  return fs.statSync(target, { throwIfNoEntry: false })?.isFile() === true;
}

function isDirectory(target: string): boolean {
  return fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** `target` with forward slashes, for platform-independent comparisons. */
function toPosix(target: string): string {
  return target.replace(/\\/g, '/');
}

/** Whether `candidate` is `root` or lies beneath it (both absolute, resolved). */
function isWithinDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * The segments of a relative path that may not climb out of its base: not
 * absolute on any platform, no `..` segment, no NUL byte, not empty.
 */
function safeRelativeSegments(relativePath: string, caller: string): string[] {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    throw new Error(
      `${caller}: ${JSON.stringify(relativePath)} must be a non-empty relative path (no absolute path, no NUL byte).`,
    );
  }
  const segments = relativePath
    .split(/[\\/]/)
    .filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) {
    throw new Error(
      `${caller}: ${JSON.stringify(relativePath)} must name a path inside its base directory (no ".." segment).`,
    );
  }
  return segments;
}

// ---------------------------------------------------------------------------
// The extension manifest, narrowly typed
// ---------------------------------------------------------------------------

/** One `contributes.commands` entry. */
export interface ManifestCommand {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
}

/** One entry of a `contributes.views` container. */
export interface ManifestView {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
}

/** One entry of a `contributes.viewsContainers` location (`activitybar`, `panel`). */
export interface ManifestViewContainer {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
}

/** One entry of a `contributes.menus` menu (`commandPalette`, `view/title`, …). */
export interface ManifestMenuItem {
  readonly command?: string;
  readonly when?: string;
  readonly group?: string;
}

/** One `contributes.configuration.properties` entry. */
export interface ManifestConfigurationProperty {
  readonly type?: string | readonly string[];
  readonly default?: unknown;
  readonly enum?: readonly unknown[];
  readonly scope?: string;
  readonly description?: string;
  readonly markdownDescription?: string;
}

/** One `contributes.configuration` object; the manifest may also carry an array of them. */
export interface ManifestConfiguration {
  readonly title?: string;
  readonly properties: Readonly<Record<string, ManifestConfigurationProperty>>;
}

/** The `contributes` members the suites assert against. */
export interface ManifestContributions {
  readonly commands: readonly ManifestCommand[];
  readonly views: Readonly<Record<string, readonly ManifestView[]>>;
  readonly viewsContainers?: Readonly<Record<string, readonly ManifestViewContainer[]>>;
  readonly menus?: Readonly<Record<string, readonly ManifestMenuItem[]>>;
  readonly configuration?: ManifestConfiguration | readonly ManifestConfiguration[];
}

/**
 * The part of `package.json` the extension-host suites read, validated field by
 * field. Members the manifest carries beyond these are ignored rather than
 * passed through, so no untyped value ever leaves this module.
 */
export interface ExtensionManifest {
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  readonly main: string;
  readonly icon: string;
  readonly engines: { readonly vscode: string };
  readonly activationEvents: readonly string[];
  readonly contributes: ManifestContributions;
}

/** `root.key` for identifier keys, `root["key/with/slashes"]` otherwise. */
function memberPath(root: string, key: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) {
    return root === '' ? key : `${root}.${key}`;
  }
  return `${root}[${JSON.stringify(key)}]`;
}

/** "a string", "an array", "null", "absent" — for "… is not X (found Y)". */
function describeJsonType(value: unknown): string {
  if (value === undefined) {
    return 'nothing (absent)';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/**
 * Validates an unknown value as an {@link ExtensionManifest} with hand-written
 * type predicates, building a fresh object from the validated fields only.
 *
 * The first problem found throws an `Error` naming the source and the
 * offending path, for example
 * `contributes.commands[3].command is not a string (found a number)`.
 *
 * @param value  the parsed `package.json`, of unknown shape
 * @param source where it came from, for the error message
 */
export function parseExtensionManifest(value: unknown, source: string): ExtensionManifest {
  const fail = (at: string, problem: string): Error =>
    new Error(`Extension manifest ${source} is invalid: ${at} ${problem}.`);

  const record = (candidate: unknown, at: string): JsonRecord => {
    if (!isRecord(candidate)) {
      throw fail(at, `is not an object (found ${describeJsonType(candidate)})`);
    }
    return candidate;
  };
  const array = (candidate: unknown, at: string): readonly unknown[] => {
    if (!Array.isArray(candidate)) {
      throw fail(at, `is not an array (found ${describeJsonType(candidate)})`);
    }
    return candidate;
  };
  const string = (candidate: unknown, at: string): string => {
    if (typeof candidate !== 'string') {
      throw fail(at, `is not a string (found ${describeJsonType(candidate)})`);
    }
    if (candidate.length === 0) {
      throw fail(at, 'is an empty string');
    }
    return candidate;
  };
  const optionalString = (owner: JsonRecord, key: string, at: string): string | undefined =>
    owner[key] === undefined ? undefined : string(owner[key], memberPath(at, key));
  const recordOfArrays = <T>(
    candidate: unknown,
    at: string,
    readItem: (item: unknown, itemAt: string) => T,
  ): Readonly<Record<string, readonly T[]>> => {
    const result: Record<string, readonly T[]> = {};
    for (const [key, entries] of Object.entries(record(candidate, at))) {
      const entriesAt = memberPath(at, key);
      result[key] = array(entries, entriesAt).map((item, index) =>
        readItem(item, `${entriesAt}[${index}]`),
      );
    }
    return result;
  };

  const readCommand = (item: unknown, at: string): ManifestCommand => {
    const entry = record(item, at);
    const category = optionalString(entry, 'category', at);
    return {
      command: string(entry['command'], memberPath(at, 'command')),
      title: string(entry['title'], memberPath(at, 'title')),
      ...(category === undefined ? {} : { category }),
    };
  };
  const readView = (item: unknown, at: string): ManifestView => {
    const entry = record(item, at);
    const type = optionalString(entry, 'type', at);
    return {
      id: string(entry['id'], memberPath(at, 'id')),
      name: string(entry['name'], memberPath(at, 'name')),
      ...(type === undefined ? {} : { type }),
    };
  };
  const readViewContainer = (item: unknown, at: string): ManifestViewContainer => {
    const entry = record(item, at);
    return {
      id: string(entry['id'], memberPath(at, 'id')),
      title: string(entry['title'], memberPath(at, 'title')),
      icon: string(entry['icon'], memberPath(at, 'icon')),
    };
  };
  const readMenuItem = (item: unknown, at: string): ManifestMenuItem => {
    const entry = record(item, at);
    const command = optionalString(entry, 'command', at);
    const when = optionalString(entry, 'when', at);
    const group = optionalString(entry, 'group', at);
    return {
      ...(command === undefined ? {} : { command }),
      ...(when === undefined ? {} : { when }),
      ...(group === undefined ? {} : { group }),
    };
  };
  const readConfigurationProperty = (item: unknown, at: string): ManifestConfigurationProperty => {
    const entry = record(item, at);
    let type: string | readonly string[] | undefined;
    if (Array.isArray(entry['type'])) {
      const typeAt = memberPath(at, 'type');
      type = array(entry['type'], typeAt).map((name, index) => string(name, `${typeAt}[${index}]`));
    } else {
      type = optionalString(entry, 'type', at);
    }
    const scope = optionalString(entry, 'scope', at);
    const description = optionalString(entry, 'description', at);
    const markdownDescription = optionalString(entry, 'markdownDescription', at);
    const enumValues =
      entry['enum'] === undefined ? undefined : array(entry['enum'], memberPath(at, 'enum'));
    return {
      ...(type === undefined ? {} : { type }),
      ...('default' in entry ? { default: entry['default'] } : {}),
      ...(enumValues === undefined ? {} : { enum: enumValues }),
      ...(scope === undefined ? {} : { scope }),
      ...(description === undefined ? {} : { description }),
      ...(markdownDescription === undefined ? {} : { markdownDescription }),
    };
  };
  const readConfiguration = (item: unknown, at: string): ManifestConfiguration => {
    const entry = record(item, at);
    const title = optionalString(entry, 'title', at);
    const propertiesAt = memberPath(at, 'properties');
    const properties: Record<string, ManifestConfigurationProperty> = {};
    for (const [key, property] of Object.entries(record(entry['properties'], propertiesAt))) {
      properties[key] = readConfigurationProperty(property, memberPath(propertiesAt, key));
    }
    return { ...(title === undefined ? {} : { title }), properties };
  };

  // Validated in the order the members appear in the authored package.json,
  // so the first problem reported is the first one a reader of the file meets.
  const manifest = record(value, '(the manifest root)');
  const name = string(manifest['name'], 'name');
  const version = string(manifest['version'], 'version');
  const publisher = string(manifest['publisher'], 'publisher');
  const enginesRecord = record(manifest['engines'], 'engines');
  const engines = { vscode: string(enginesRecord['vscode'], 'engines.vscode') };
  const icon = string(manifest['icon'], 'icon');
  const main = string(manifest['main'], 'main');
  const activationEvents = array(manifest['activationEvents'], 'activationEvents').map(
    (event, index) => string(event, `activationEvents[${index}]`),
  );
  const contributes = record(manifest['contributes'], 'contributes');
  const viewsContainers =
    contributes['viewsContainers'] === undefined
      ? undefined
      : recordOfArrays(
          contributes['viewsContainers'],
          'contributes.viewsContainers',
          readViewContainer,
        );
  const views = recordOfArrays(contributes['views'], 'contributes.views', readView);
  const commands = array(contributes['commands'], 'contributes.commands').map((item, index) =>
    readCommand(item, `contributes.commands[${index}]`),
  );
  const menus =
    contributes['menus'] === undefined
      ? undefined
      : recordOfArrays(contributes['menus'], 'contributes.menus', readMenuItem);
  let configuration: ManifestConfiguration | readonly ManifestConfiguration[] | undefined;
  if (Array.isArray(contributes['configuration'])) {
    configuration = array(contributes['configuration'], 'contributes.configuration').map(
      (item, index) => readConfiguration(item, `contributes.configuration[${index}]`),
    );
  } else if (contributes['configuration'] !== undefined) {
    configuration = readConfiguration(contributes['configuration'], 'contributes.configuration');
  }

  return {
    name,
    publisher,
    version,
    main,
    icon,
    engines,
    activationEvents,
    contributes: {
      commands,
      views,
      ...(viewsContainers === undefined ? {} : { viewsContainers }),
      ...(menus === undefined ? {} : { menus }),
      ...(configuration === undefined ? {} : { configuration }),
    },
  };
}

/**
 * Every configuration property the manifest contributes, whichever of the two
 * shapes (`configuration` object or array of objects) it uses. A key declared
 * twice throws, because VS Code would silently keep only one of them.
 */
export function manifestConfigurationProperties(
  manifest: ExtensionManifest,
): Readonly<Record<string, ManifestConfigurationProperty>> {
  const declared = manifest.contributes.configuration;
  const sections: readonly ManifestConfiguration[] =
    declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
  const merged: Record<string, ManifestConfigurationProperty> = {};
  for (const section of sections) {
    for (const [key, property] of Object.entries(section.properties)) {
      if (key in merged) {
        throw new Error(
          `Extension manifest declares configuration property ${key} more than once.`,
        );
      }
      merged[key] = property;
    }
  }
  return merged;
}

/**
 * The manifest of the extension loaded in this extension host, validated with
 * {@link parseExtensionManifest}.
 *
 * Source: `Extension.packageJSON`, VS Code's in-memory description of the
 * development extension. Use {@link readManifestFromDisk} to validate the bytes
 * of a `package.json` file instead (for example inside an installed VSIX).
 */
export function readExtensionManifest(): ExtensionManifest {
  const extension = getExtensionOrFail();
  const raw: unknown = extension.packageJSON;
  return parseExtensionManifest(
    raw,
    `packageJSON of ${extension.id} (${extension.extensionUri.fsPath})`,
  );
}

/**
 * Reads and validates a `package.json` from disk with the same strictness as
 * {@link readExtensionManifest}.
 *
 * @param packageJsonPath path of the manifest file
 */
export function readManifestFromDisk(packageJsonPath: string): ExtensionManifest {
  const absolute = path.resolve(packageJsonPath);
  let text: string;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read extension manifest ${absolute}: ${describeError(cause)}`, {
      cause,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text);
  } catch (cause) {
    throw new Error(`Extension manifest ${absolute} is not valid JSON: ${describeError(cause)}`, {
      cause,
    });
  }
  return parseExtensionManifest(raw, absolute);
}

// ---------------------------------------------------------------------------
// The extension under test
// ---------------------------------------------------------------------------

/**
 * The extension under development, or a thrown `Error` naming the expected id
 * and the ids that are loaded — the diagnostic that turns a publisher or name
 * typo into a readable failure.
 */
export function getExtensionOrFail(): vscode.Extension<unknown> {
  const extension = vscode.extensions.getExtension<unknown>(EXTENSION_ID);
  if (extension !== undefined) {
    return extension;
  }
  const loaded = vscode.extensions.all.map((candidate) => candidate.id).sort();
  const nonBuiltIn = loaded.filter((id) => !id.startsWith('vscode.'));
  throw new Error(
    `Extension ${EXTENSION_ID} is not loaded in this extension host. ` +
      `Loaded: ${nonBuiltIn.length === 0 ? '(no non-built-in extension)' : nonBuiltIn.join(', ')}` +
      ` plus ${loaded.length - nonBuiltIn.length} built-in "vscode.*" extensions. ` +
      'Check "publisher" and "name" in apps/vscode-extension/package.json and ' +
      'extensionDevelopmentPath in apps/vscode-extension/.vscode-test.mjs.',
  );
}

/** Memoised activation for this suite bundle; cleared when activation fails. */
let activation: Promise<vscode.Extension<unknown>> | undefined;

async function activateOrFail(): Promise<vscode.Extension<unknown>> {
  const extension = getExtensionOrFail();
  try {
    await extension.activate();
  } catch (cause) {
    throw new Error(`Activating ${EXTENSION_ID} failed: ${describeError(cause)}`, { cause });
  }
  if (!extension.isActive) {
    throw new Error(`${EXTENSION_ID}: activate() resolved but the extension is not active.`);
  }
  return extension;
}

/**
 * The extension, after awaiting its activation. Idempotent: the promise is
 * memoised so repeated calls share one activation, and a failed activation is
 * forgotten so the next caller observes (and reports) its own attempt rather
 * than a stale rejection.
 */
export function activateExtensionOnce(): Promise<vscode.Extension<unknown>> {
  activation ??= activateOrFail().catch((error: unknown) => {
    activation = undefined;
    throw error;
  });
  return activation;
}

/**
 * Real path of the extension's development directory. Its basename must be
 * `vscode-extension`: a cheap guard that the host loaded the workspace sources
 * rather than an installed copy.
 */
export function extensionDevelopmentRoot(): string {
  const reported = getExtensionOrFail().extensionUri.fsPath;
  const root = fs.realpathSync(reported);
  if (path.basename(root) !== 'vscode-extension') {
    throw new Error(
      `${EXTENSION_ID} was loaded from ${root}, not from the apps/vscode-extension workspace directory.`,
    );
  }
  return root;
}

/** Real path of the repository root, two levels above the extension directory. */
export function repositoryRoot(): string {
  const root = fs.realpathSync(path.resolve(extensionDevelopmentRoot(), '..', '..'));
  if (!isFile(path.join(root, 'pnpm-workspace.yaml'))) {
    throw new Error(`${root} (two levels above the extension) contains no pnpm-workspace.yaml.`);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Throwaway filesystem
// ---------------------------------------------------------------------------

/** Real paths of the scratch directories this suite bundle created, in creation order. */
const scratchRoots: string[] = [];

/** Cleanup callbacks registered by the suite, run last-in first-out. */
const cleanups: (() => void | Promise<void>)[] = [];

/**
 * The scratch root that contains `target`, or a thrown `Error`: every write,
 * symlink and profile directory this module creates must be removable by
 * {@link cleanupScratch}, so it must lie inside a directory it registered.
 */
function scratchRootContaining(target: string, caller: string): string {
  const resolved = path.resolve(target);
  const root = scratchRoots.find((candidate) => isWithinDirectory(resolved, candidate));
  if (root === undefined) {
    throw new Error(
      `${caller}: ${resolved} is not inside a scratch directory created by createScratchDir() ` +
        `(registered: ${scratchRoots.length === 0 ? 'none' : scratchRoots.join(', ')}).`,
    );
  }
  return root;
}

/** Throws when the real path of an existing directory escapes its scratch root. */
function assertRealDirectoryWithin(directory: string, root: string, caller: string): void {
  const real = fs.realpathSync(directory);
  if (!isWithinDirectory(real, root)) {
    throw new Error(
      `${caller}: ${directory} resolves to ${real}, outside its scratch directory ${root} (a symlinked parent?).`,
    );
  }
}

/**
 * Creates a fresh directory under the real path of `os.tmpdir()` and registers
 * it for removal by {@link cleanupScratch}.
 *
 * The returned path is realpath-resolved. That matters: on macOS `os.tmpdir()`
 * is a symlink (`/var` → `/private/var`), and the containment logic under test
 * realpaths its inputs, so an unresolved scratch path would make a legitimate
 * location look like an escape.
 *
 * @param prefix directory-name prefix; {@link SCRATCH_PREFIX} is prepended when
 *   the prefix does not already start with it, so every scratch directory is
 *   covered by the "no `debuggen-vscode-test-*` residue" check
 */
export function createScratchDir(prefix: string = SCRATCH_PREFIX): string {
  if (/[\\/]/.test(prefix) || prefix.includes('\0')) {
    throw new Error(`createScratchDir: prefix ${JSON.stringify(prefix)} must be a plain name.`);
  }
  const name = prefix.startsWith(SCRATCH_PREFIX) ? prefix : `${SCRATCH_PREFIX}${prefix}`;
  const created = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), name));
  const real = fs.realpathSync(created);
  scratchRoots.push(real);
  installExitSweep();
  return real;
}

/**
 * Writes a UTF-8 file below a scratch directory, creating parent directories,
 * and returns its absolute path.
 *
 * `relativePath` must stay inside `dir` (no absolute path, no `..` segment),
 * `dir` must lie inside a directory from {@link createScratchDir}, and neither
 * a symlinked parent nor a symlink at the target may redirect the write
 * elsewhere — so this helper can never write outside the scratch area, and in
 * particular never into the repository working tree.
 */
export function writeFixtureFile(dir: string, relativePath: string, contents: string): string {
  const caller = 'writeFixtureFile';
  const segments = safeRelativeSegments(relativePath, caller);
  const base = path.resolve(dir);
  const root = scratchRootContaining(base, caller);
  const target = path.join(base, ...segments);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  assertRealDirectoryWithin(parent, root, caller);
  if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw new Error(`${caller}: ${target} is a symlink; refusing to write through it.`);
  }
  fs.writeFileSync(target, contents, 'utf8');
  return target;
}

/**
 * Creates a symlink at `linkPath` (inside a scratch directory, parent created
 * first) pointing at `targetPath`, which may lie anywhere — an escaping target
 * is exactly what containment tests need.
 *
 * The link type is `'dir'` when the target is an existing directory and
 * `'file'` otherwise; POSIX ignores it, Windows requires it to match. A failure
 * to create the link throws: a suite that depends on a symlink must fail
 * loudly where one cannot be made, never skip.
 */
export function plantSymlink(linkPath: string, targetPath: string): void {
  const caller = 'plantSymlink';
  const link = path.resolve(linkPath);
  const root = scratchRootContaining(link, caller);
  const parent = path.dirname(link);
  fs.mkdirSync(parent, { recursive: true });
  assertRealDirectoryWithin(parent, root, caller);
  const resolvedTarget = path.resolve(parent, targetPath);
  fs.symlinkSync(targetPath, link, isDirectory(resolvedTarget) ? 'dir' : 'file');
}

/**
 * Registers a callback for {@link cleanupScratch}. Callbacks run last-in
 * first-out, after tracked child processes are stopped and before scratch
 * directories are removed.
 */
export function registerCleanup(fn: () => void | Promise<void>): void {
  cleanups.push(fn);
  installExitSweep();
}

/** Removes one directory tree and proves it is gone. */
function removeTree(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (fs.lstatSync(root, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`Scratch directory ${root} still exists after removal.`);
  }
}

/**
 * The one teardown call every suite awaits in `after`: stops every tracked
 * child process ({@link stopTrackedProcesses}), runs every registered cleanup
 * (last-in first-out), then removes every scratch directory.
 *
 * Every step runs even when an earlier one fails; the failures are collected
 * and thrown together as one `AggregateError`, so nothing is swallowed and one
 * broken cleanup cannot leave the rest undone. Registries are emptied before
 * their entries run, so a second call is a no-op.
 */
export async function cleanupScratch(): Promise<void> {
  const failures: unknown[] = [];
  try {
    await stopTrackedProcesses();
  } catch (error) {
    failures.push(error);
  }
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const root of scratchRoots.splice(0).reverse()) {
    try {
      removeTree(root);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `cleanupScratch: ${failures.length} teardown step(s) failed:\n  - ${failures
        .map((failure) => describeError(failure))
        .join('\n  - ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Workspace and editor
// ---------------------------------------------------------------------------

/** The folders of the window the suites run in (`[]` when none is open). */
export function fixtureWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

/**
 * Real path of the opened fixture workspace: the first `file`-scheme folder,
 * which must end with {@link FIXTURE_WORKSPACE_SUFFIX}.
 *
 * This is the guard on the `.vscode-test.mjs` ↔ fixtures contract. If the
 * configuration drifts to the repository root or to any other project, every
 * suite that asks for the workspace fails here, naming the folder it found,
 * instead of passing against the wrong tree.
 */
export function fixtureWorkspaceRoot(): string {
  const folders = fixtureWorkspaceFolders();
  const folder = folders.find((candidate) => candidate.uri.scheme === 'file');
  const opened = folders.map((candidate) => candidate.uri.toString()).join(', ') || '(none)';
  if (folder === undefined) {
    throw new Error(
      `No file-scheme workspace folder is open (folders: ${opened}); ` +
        `.vscode-test.mjs must open ${FIXTURE_WORKSPACE_SUFFIX}.`,
    );
  }
  let root: string;
  try {
    root = fs.realpathSync(folder.uri.fsPath);
  } catch (cause) {
    throw new Error(
      `The workspace folder ${folder.uri.fsPath} cannot be resolved: ${describeError(cause)}`,
      { cause },
    );
  }
  if (!toPosix(root).endsWith(`/${FIXTURE_WORKSPACE_SUFFIX}`)) {
    throw new Error(
      `The opened workspace folder is ${root}, not the fixture workspace …/${FIXTURE_WORKSPACE_SUFFIX} ` +
        `(folders: ${opened}). Point workspaceFolder in apps/vscode-extension/.vscode-test.mjs back at it.`,
    );
  }
  return root;
}

/**
 * Absolute path of an existing file inside the fixture workspace.
 *
 * @param relativePath path below the workspace root (no absolute path, no `..`)
 */
export function fixtureFile(relativePath: string): string {
  const segments = safeRelativeSegments(relativePath, 'fixtureFile');
  const file = path.join(fixtureWorkspaceRoot(), ...segments);
  if (!isFile(file)) {
    throw new Error(`fixtureFile: ${file} does not exist or is not a file.`);
  }
  return file;
}

/**
 * Closes every editor and waits until no text editor is visible, so a reveal
 * assertion can never observe an editor a previous test left open.
 */
export async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => vscode.window.visibleTextEditors.length === 0, {
    message: 'every text editor to close after workbench.action.closeAllEditors',
  });
}

// ---------------------------------------------------------------------------
// Async primitives
// ---------------------------------------------------------------------------

/** Options of {@link waitFor} and {@link waitForHttpOk}. */
export interface WaitOptions {
  /** Overall budget; default {@link DEFAULT_WAIT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Delay between probes; default {@link DEFAULT_POLL_INTERVAL_MS}. */
  readonly intervalMs?: number;
  /** What is being awaited, phrased to follow "waiting for …". */
  readonly message?: string;
}

/** What one bounded probe attempt produced. */
type ProbeOutcome<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'pending' };

/**
 * Runs `probe` once, giving up (without cancelling it) after `budgetMs`. The
 * abandoned attempt can never reject unobserved: its outcome is captured, not
 * thrown.
 */
async function probeWithin<T>(
  probe: () => T | Promise<T>,
  budgetMs: number,
): Promise<ProbeOutcome<T>> {
  const attempt = (async (): Promise<ProbeOutcome<T>> => {
    try {
      return { kind: 'value', value: await probe() };
    } catch (error) {
      return { kind: 'error', error };
    }
  })();
  const controller = new AbortController();
  const deadline = sleep(budgetMs, undefined, { signal: controller.signal }).then(
    (): ProbeOutcome<T> => ({ kind: 'pending' }),
    (): ProbeOutcome<T> => ({ kind: 'pending' }),
  );
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    controller.abort();
  }
}

function isReady<T>(value: T): value is NonNullable<T> {
  return value !== undefined && value !== null && value !== false;
}

/**
 * Polls `probe` until it returns something other than `undefined`, `null` or
 * `false`, and resolves with that value.
 *
 * A probe that throws counts as "not ready yet"; a probe that does not settle
 * is abandoned at the deadline. On timeout the thrown `Error` names
 * `options.message`, the elapsed time and number of attempts, and renders the
 * last value and the last error the probe produced.
 *
 * @example
 * ```ts
 * const editor = await waitFor(() => vscode.window.activeTextEditor, {
 *   message: 'the revealed file to become the active editor',
 * });
 * ```
 */
export async function waitFor<T>(
  probe: () => T | Promise<T>,
  options: WaitOptions = {},
): Promise<NonNullable<T>> {
  const timeoutMs = positiveDuration(options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, 'timeoutMs');
  const intervalMs = positiveDuration(options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS, 'intervalMs');
  const started = performance.now();
  const deadline = started + timeoutMs;
  let attempts = 0;
  let last: ProbeOutcome<T> | undefined;
  let lastError: { readonly error: unknown } | undefined;

  for (;;) {
    attempts += 1;
    const outcome = await probeWithin(probe, Math.max(deadline - performance.now(), 1));
    if (outcome.kind === 'value' && isReady(outcome.value)) {
      return outcome.value;
    }
    last = outcome;
    if (outcome.kind === 'error') {
      lastError = { error: outcome.error };
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min(intervalMs, remaining));
  }

  const elapsed = Math.round(performance.now() - started);
  const lastSeen =
    last.kind === 'value'
      ? `last probe value: ${renderValue(last.value)}`
      : last.kind === 'error'
        ? 'last probe threw'
        : 'the last probe had not settled when the budget ran out';
  const errorNote =
    lastError === undefined ? '' : `; last probe error: ${describeError(lastError.error)}`;
  throw new Error(
    `Timed out after ${elapsed} ms (budget ${timeoutMs} ms, ${attempts} attempt(s)) waiting for ` +
      `${options.message ?? 'a condition to become ready'}; ${lastSeen}${errorNote}.`,
  );
}

/**
 * A port that was free on `127.0.0.1` a moment ago: bind port 0, read the
 * assigned port, close. Never a fixed port, and never the product's default
 * service port, which a developer's real service may be using.
 */
export async function findFreePort(): Promise<number> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const port = await bindEphemeralPort();
    if (port !== PRODUCT_DEFAULT_SERVICE_PORT) {
      return port;
    }
  }
  throw new Error(
    `findFreePort: the operating system assigned port ${PRODUCT_DEFAULT_SERVICE_PORT} five times in a row.`,
  );
}

function bindEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      server.close((closeError) => {
        if (closeError !== undefined) {
          reject(closeError);
        } else if (address === null || typeof address === 'string') {
          reject(new Error(`findFreePort: unexpected listen address ${renderValue(address)}.`));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

/** Loopback host names a probe may contact. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * `url` parsed, or a thrown `Error` unless it is plain `http:` to a loopback
 * host on an explicit port other than the product default — the only traffic
 * a suite may generate is to a process it started itself.
 */
function loopbackUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new Error(`${JSON.stringify(url)} is not a valid URL.`, { cause });
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.port === '') {
    throw new Error(
      `Refusing to contact ${parsed.href}: test traffic must be http: to 127.0.0.1, localhost or [::1] on an explicit port.`,
    );
  }
  if (Number(parsed.port) === PRODUCT_DEFAULT_SERVICE_PORT) {
    throw new Error(
      `Refusing to contact ${parsed.href}: port ${PRODUCT_DEFAULT_SERVICE_PORT} is the product's default service port, ` +
        'which a developer may be using. Start the service under test on findFreePort().',
    );
  }
  return parsed;
}

/** Upper bound on a probe response body; a health answer is a few hundred bytes. */
const MAX_PROBE_BODY_CHARS = 1_000_000;

/**
 * One `GET` over `node:http` with a hard deadline: status and body text.
 *
 * Why not the global `fetch`: inside the extension host, VS Code replaces
 * `globalThis.fetch` with its proxy-resolving implementation
 * (`@vscode/proxy-agent` over the editor's bundled undici). In VS Code 1.139
 * that implementation fails before sending anything ("Cannot find module
 * '../llhttp/llhttp-wasm.js'"), and in any version it routes a test probe
 * through the editor's proxy configuration. A plain `node:http` request with
 * `agent: false` is the direct, Origin-less loopback call the probe must be.
 * Redirects are not followed (a 3xx is returned as an answer).
 */
function httpGetText(target: URL, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      target,
      { method: 'GET', headers: { accept: 'application/json' }, agent: false },
      (response) => {
        response.setEncoding('utf8');
        let text = '';
        response.on('data', (chunk: string) => {
          text += chunk;
          if (text.length > MAX_PROBE_BODY_CHARS) {
            request.destroy(
              new Error(
                `GET ${target.href}: response body exceeds ${MAX_PROBE_BODY_CHARS} characters.`,
              ),
            );
          }
        });
        response.on('end', () => {
          clearTimeout(timer);
          resolve({ status: response.statusCode ?? 0, text });
        });
        response.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new Error(`GET ${target.href} did not answer within ${timeoutMs} ms.`));
    }, timeoutMs);
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

/**
 * `GET url` with **no `Origin` header** and a timeout, returning the status and
 * the body parsed as JSON (typed `unknown`; callers validate it).
 *
 * The local service authenticates by credential and rejects any `http:`/`https:`
 * web origin, and `GET /health` is one of its two unauthenticated operations —
 * so an Origin-less Node request is the correct probe shape. Only loopback
 * URLs are accepted, redirects are not followed, and a body that is not JSON
 * throws with the status and a snippet of the text. The request goes through
 * `node:http` rather than the extension host's replaced global `fetch` (see
 * {@link httpGetText}).
 */
export async function fetchJsonWithoutOrigin(
  url: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<{ status: number; body: unknown }> {
  const target = loopbackUrl(url);
  const timeoutMs = positiveDuration(options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS, 'timeoutMs');
  const { status, text } = await httpGetText(target, timeoutMs);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `GET ${target.href} answered ${status} with a body that is not JSON: ${renderValue(text.slice(0, 300))}`,
      { cause },
    );
  }
  return { status, body };
}

/**
 * Polls `GET url` ({@link fetchJsonWithoutOrigin}) until it answers 2xx and
 * resolves with that response. Connection failures and non-2xx answers count
 * as "not ready"; the last of them is reported when the budget runs out.
 */
export async function waitForHttpOk(
  url: string,
  options: WaitOptions = {},
): Promise<{ status: number; body: unknown }> {
  const target = loopbackUrl(url).href;
  return waitFor(
    async () => {
      const response = await fetchJsonWithoutOrigin(target);
      if (response.status < 200 || response.status > 299) {
        throw new Error(`GET ${target} answered ${response.status}: ${renderValue(response.body)}`);
      }
      return response;
    },
    { ...options, message: options.message ?? `GET ${target} to answer 2xx` },
  );
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

/**
 * The Node executable the suites spawn Node programs (the embedded service)
 * with: `DEBUGGEN_TEST_NODE` when set, else `node` from `PATH`.
 *
 * Never `process.execPath`: inside the extension host that is Electron, whose
 * bundled Node is older than the repository's pinned runtime
 * (`>=24.21.0 <25`), and the embedded service depends on the built-in
 * `node:sqlite` module — running it through `ELECTRON_RUN_AS_NODE` would fail
 * or behave differently from production. `.vscode-test.mjs` sets
 * `DEBUGGEN_TEST_NODE` to the Node that runs the test CLI.
 */
export function resolveNodeExecutable(): string {
  const configured = process.env['DEBUGGEN_TEST_NODE']?.trim();
  if (configured === undefined || configured === '') {
    return 'node';
  }
  if (path.isAbsolute(configured) && !isFile(configured)) {
    throw new Error(`DEBUGGEN_TEST_NODE=${configured} is not an existing executable.`);
  }
  return configured;
}

/** Provider credentials: `ANTHROPIC_API_KEY` (the one `.env.example` lists) and its `ANTHROPIC_*` siblings. */
const PROVIDER_CREDENTIAL = /^ANTHROPIC_/;

/** The only inherited `DEBUGGEN_*` variables a child keeps; every other one is removed. */
const INHERITED_DEBUGGEN_VARIABLES = new Set(['DEBUGGEN_HOME', 'DEBUGGEN_TEST_NODE']);

/**
 * Editor-internal variables of the extension-host process, removed the way
 * VS Code's own `sanitizeProcessEnvironment` removes them before it spawns a
 * terminal: `ELECTRON_*` and `VSCODE_*` except the portable-mode and
 * shell-environment ones. A child must behave as if started from a clean
 * shell, not as a fragment of the running editor (a VS Code CLI child that
 * inherited them could talk to this window instead of its throwaway profile).
 */
const EDITOR_INTERNAL_VARIABLE =
  /^(?:ELECTRON_.+|VSCODE_(?!(?:PORTABLE|SHELL_LOGIN|ENV_REPLACE|ENV_APPEND|ENV_PREPEND)$).+)$/;

/** The product's default session home, which no test may use. */
function defaultDebuggenHome(): string {
  return path.join(os.homedir(), '.debuggen');
}

/**
 * Throws unless `env` is hermetic: no provider credential, the deterministic
 * provider, and a `DEBUGGEN_HOME` that is absolute and is not the developer's
 * real `~/.debuggen`.
 */
function assertHermetic(env: NodeJS.ProcessEnv, caller: string): void {
  const leaked = Object.keys(env).filter(
    (name) => PROVIDER_CREDENTIAL.test(name) && env[name] !== undefined,
  );
  if (leaked.length > 0) {
    throw new Error(
      `${caller}: the child environment carries provider credentials (${leaked.join(', ')}).`,
    );
  }
  if (env['DEBUGGEN_PROVIDER'] !== 'deterministic') {
    throw new Error(
      `${caller}: DEBUGGEN_PROVIDER must be "deterministic" in a test child (got ${renderValue(env['DEBUGGEN_PROVIDER'])}).`,
    );
  }
  const home = env['DEBUGGEN_HOME'];
  if (home === undefined || home.trim() === '' || !path.isAbsolute(home)) {
    throw new Error(
      `${caller}: DEBUGGEN_HOME must be an absolute throwaway directory (got ${renderValue(home)}); ` +
        'the test configuration provides one — pass DEBUGGEN_HOME explicitly when running elsewhere.',
    );
  }
  if (path.resolve(home) === path.resolve(defaultDebuggenHome())) {
    throw new Error(`${caller}: DEBUGGEN_HOME is the developer's real ${defaultDebuggenHome()}.`);
  }
}

/**
 * The environment for every child this module spawns: `process.env` without
 * provider credentials (`ANTHROPIC_*`), without inherited `DEBUGGEN_*`
 * variables other than `DEBUGGEN_HOME` and `DEBUGGEN_TEST_NODE` (no ambient
 * token, ingest URL, host or port), without editor-internal `ELECTRON_*` /
 * `VSCODE_*` variables, with `DEBUGGEN_PROVIDER=deterministic`, then `extra`.
 *
 * `extra` may not reintroduce a provider credential or another provider, and
 * the result must carry a throwaway `DEBUGGEN_HOME` (inherited from the test
 * configuration or given in `extra`); otherwise this throws.
 */
export function hermeticEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  for (const [name, value] of Object.entries(extra)) {
    if (PROVIDER_CREDENTIAL.test(name)) {
      throw new Error(
        `hermeticEnv: ${name} is a provider credential and may not be passed to a test child.`,
      );
    }
    if (name === 'DEBUGGEN_PROVIDER' && value !== 'deterministic') {
      throw new Error(
        `hermeticEnv: DEBUGGEN_PROVIDER=${value} would let a test child contact a model provider.`,
      );
    }
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const removed =
      PROVIDER_CREDENTIAL.test(name) ||
      EDITOR_INTERNAL_VARIABLE.test(name) ||
      (name.startsWith('DEBUGGEN_') && !INHERITED_DEBUGGEN_VARIABLES.has(name));
    if (value !== undefined && !removed) {
      env[name] = value;
    }
  }
  env['DEBUGGEN_PROVIDER'] = 'deterministic';
  for (const [name, value] of Object.entries(extra)) {
    env[name] = value;
  }
  assertHermetic(env, 'hermeticEnv');
  return env;
}

/** How a child process ended. */
export interface ProcessExit {
  /** Exit code, or `null` when a signal ended it or it never started. */
  readonly code: number | null;
  /** The signal that ended it, if any. */
  readonly signal: NodeJS.Signals | null;
  /** Set when the process could not be started at all (for example `ENOENT`). */
  readonly error?: Error;
}

/** A child process started by {@link spawnTracked}, registered for teardown. */
export interface TrackedProcess {
  /** The underlying Node child process. */
  readonly child: ChildProcess;
  /** Its pid, `undefined` when it could not be started. */
  readonly pid: number | undefined;
  /** The command line, for messages. */
  readonly commandLine: string;
  /** Settles (never rejects) when the process exits or fails to start. */
  readonly exited: Promise<ProcessExit>;
  /** Everything it wrote to stdout and stderr so far, interleaved. */
  output(): string;
  /** Whether the process itself has not exited yet. */
  isRunning(): boolean;
  /**
   * Stops it and everything it started: `SIGTERM` to its process group, a
   * grace period of {@link PROCESS_STOP_GRACE_MS}, then `SIGKILL`. Resolves
   * with the exit code (`null` when a signal ended it) once nothing is left
   * alive, and throws when something survives. Safe to call after exit.
   */
  stop(): Promise<number | null>;
}

/** Every tracked child not yet confirmed stopped. */
const trackedProcesses = new Set<TrackedChild>();

/**
 * pids of live (non-zombie) members of process group `pgid`, from `/proc`.
 * Linux only; a process that vanishes mid-scan is simply no longer a member.
 */
function liveLinuxGroupMembers(pgid: number): number[] {
  const members: number[] = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'ENOENT' || code === 'ESRCH') {
        continue;
      }
      throw error;
    }
    // "pid (comm) state ppid pgrp …" — comm may contain spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const state = fields[0];
    if (fields[2] === String(pgid) && state !== 'Z' && state !== 'X') {
      members.push(Number(entry));
    }
  }
  return members;
}

/** Whether process group `pgid` still has a live member (POSIX). */
function groupHasLiveMembers(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      return true;
    }
    throw error;
  }
  // The group exists; on Linux, exclude zombies awaiting their reaper.
  return process.platform === 'linux' ? liveLinuxGroupMembers(pgid).length > 0 : true;
}

async function pollUntil(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    if (predicate()) {
      return true;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return false;
    }
    await sleep(Math.min(PROCESS_POLL_INTERVAL_MS, remaining));
  }
}

function quoteArgument(argument: string): string {
  return /^[\w@%+=:,./-]+$/.test(argument) ? argument : JSON.stringify(argument);
}

class TrackedChild implements TrackedProcess {
  readonly child: ChildProcess;
  readonly commandLine: string;
  readonly exited: Promise<ProcessExit>;
  /** Settles when stdout and stderr have closed. */
  readonly closed: Promise<void>;
  /** POSIX: spawned detached, so it leads its own process group. */
  readonly #groupLeader: boolean;
  #output = '';
  #dropped = 0;
  #exit: ProcessExit | undefined;

  constructor(child: ChildProcess, commandLine: string, groupLeader: boolean) {
    this.child = child;
    this.commandLine = commandLine;
    this.#groupLeader = groupLeader;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        this.#append(chunk);
      });
    }
    this.exited = new Promise<ProcessExit>((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
      child.on('error', (error) => {
        if (child.pid === undefined) {
          resolve({ code: null, signal: null, error });
        } else {
          this.#append(`\n[helpers] child process error: ${error.message}\n`);
        }
      });
    });
    void this.exited.then((exit) => {
      this.#exit = exit;
    });
    this.closed = new Promise<void>((resolve) => {
      child.once('close', () => {
        resolve();
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  #append(chunk: string): void {
    this.#output += chunk;
    const excess = this.#output.length - MAX_CAPTURED_OUTPUT_CHARS;
    if (excess > 0) {
      this.#output = this.#output.slice(excess);
      this.#dropped += excess;
    }
  }

  output(): string {
    return this.#dropped === 0
      ? this.#output
      : `[… ${this.#dropped} earlier characters dropped …]\n${this.#output}`;
  }

  isRunning(): boolean {
    return this.child.pid !== undefined && this.#exit === undefined;
  }

  /** `commandLine (pid N)` for messages. */
  describe(): string {
    return `${this.commandLine} (pid ${this.child.pid ?? 'none'})`;
  }

  /** The captured output as a message section. */
  outputSection(): string {
    const text = this.output();
    return text.trim() === ''
      ? '\n--- no output was captured ---'
      : `\n--- captured output ---\n${tail(text, MAX_OUTPUT_IN_MESSAGE_CHARS)}\n--- end of output ---`;
  }

  /** Exited, and (for a group leader) nothing it started is alive either. */
  #settled(): boolean {
    const pid = this.child.pid;
    if (pid === undefined) {
      return true;
    }
    return this.#exit !== undefined && !(this.#groupLeader && groupHasLiveMembers(pid));
  }

  #signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined || pid <= 1) {
      return;
    }
    if (!this.#groupLeader) {
      if (this.#exit === undefined) {
        this.child.kill(signal);
      }
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (errnoCode(error) !== 'ESRCH') {
        throw error;
      }
    }
  }

  /** Last-resort synchronous kill, for the process `exit` sweep. */
  killNow(): void {
    this.#signal('SIGKILL');
  }

  async stop(): Promise<number | null> {
    if (!this.#settled()) {
      this.#signal('SIGTERM');
      if (!(await pollUntil(() => this.#settled(), PROCESS_STOP_GRACE_MS))) {
        this.#signal('SIGKILL');
        if (!(await pollUntil(() => this.#settled(), PROCESS_KILL_WAIT_MS))) {
          const pid = this.child.pid;
          const members =
            pid !== undefined && this.#groupLeader && process.platform === 'linux'
              ? ` Live members of its process group: ${liveLinuxGroupMembers(pid).join(', ') || 'none'}.`
              : '';
          throw new Error(
            `${this.describe()} is still alive after SIGTERM, ${PROCESS_STOP_GRACE_MS} ms and SIGKILL ` +
              `(process ${this.#exit === undefined ? 'running' : 'exited'}).${members}${this.outputSection()}`,
          );
        }
      }
    }
    trackedProcesses.delete(this);
    const exit = await this.exited;
    return exit.code;
  }
}

/** Options of {@link spawnTracked}. */
export interface SpawnTrackedOptions {
  /** Working directory; must exist. */
  readonly cwd?: string;
  /** Child environment; default {@link hermeticEnv}(); a supplied one must be hermetic too. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Starts a child process and registers it for teardown by
 * {@link stopTrackedProcesses} / {@link cleanupScratch}.
 *
 * - `stdio` is `["ignore", "pipe", "pipe"]`: stdin is deliberately closed, so a
 *   tool that tries to prompt interactively fails fast instead of hanging the
 *   gate, and stdout/stderr are captured for failure messages.
 * - No shell: `command` and `args` are passed to the OS as they are.
 * - On POSIX the child is spawned detached, i.e. as the leader of its own
 *   process group, so stopping it also stops whatever it started (a package
 *   manager's script, a bundler's worker) and nothing is orphaned.
 * - The environment is {@link hermeticEnv}() unless one is supplied, and a
 *   supplied one is checked for the same guarantees.
 */
export function spawnTracked(
  command: string,
  args: readonly string[],
  options: SpawnTrackedOptions = {},
): TrackedProcess {
  return startTracked(command, args, options);
}

/** {@link spawnTracked}, returning the implementation type for internal callers. */
function startTracked(
  command: string,
  args: readonly string[],
  options: SpawnTrackedOptions,
): TrackedChild {
  const env = options.env ?? hermeticEnv();
  assertHermetic(env, 'spawnTracked');
  if (options.cwd !== undefined && !isDirectory(options.cwd)) {
    throw new Error(`spawnTracked: working directory ${options.cwd} does not exist.`);
  }
  const groupLeader = process.platform !== 'win32';
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: groupLeader,
    shell: false,
    windowsHide: true,
  });
  const tracked = new TrackedChild(
    child,
    [command, ...args].map(quoteArgument).join(' '),
    groupLeader,
  );
  trackedProcesses.add(tracked);
  installExitSweep();
  return tracked;
}

/** Options of {@link runToCompletion}. */
export interface RunOptions extends SpawnTrackedOptions {
  /** Budget for the whole run; default {@link DEFAULT_COMMAND_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** The exit code that counts as success; default `0`. */
  readonly expectedExitCode?: number;
}

/** The result of a {@link runToCompletion} that ended as expected. */
export interface RunResult {
  readonly code: number | null;
  readonly output: string;
}

/**
 * Runs a command to completion under a bounded timeout
 * ({@link spawnTracked} semantics: closed stdin, hermetic environment, process
 * group). Throws — with the command line and the captured output — when the
 * command cannot start, does not finish in time (it is stopped first), or
 * exits with anything other than `expectedExitCode`. Anything the command left
 * running is stopped before this resolves.
 */
export async function runToCompletion(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const timeoutMs = positiveDuration(options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, 'timeoutMs');
  const expectedExitCode = options.expectedExitCode ?? 0;
  const tracked = startTracked(command, args, options);

  // `undefined` means the budget ran out first; the timer is cancelled either way.
  const controller = new AbortController();
  const budget = sleep(timeoutMs, undefined, { signal: controller.signal }).then(
    () => undefined,
    () => undefined,
  );
  const exit = await Promise.race([tracked.exited, budget]);
  controller.abort();

  if (exit === undefined) {
    let stopNote = ' It was stopped.';
    try {
      await tracked.stop();
    } catch (error) {
      stopNote = ` Stopping it failed as well: ${describeError(error)}`;
    }
    throw new Error(
      `${tracked.describe()} did not finish within ${timeoutMs} ms.${stopNote}${tracked.outputSection()}`,
    );
  }

  // Reap anything it left behind, then let its pipes drain (bounded).
  await tracked.stop();
  await probeWithin(() => tracked.closed, OUTPUT_DRAIN_TIMEOUT_MS);

  if (exit.error !== undefined) {
    throw new Error(`Could not start ${tracked.commandLine}: ${describeError(exit.error)}`, {
      cause: exit.error,
    });
  }
  if (exit.code !== expectedExitCode) {
    const ending =
      exit.code === null
        ? `was ended by ${exit.signal ?? 'an unknown signal'}`
        : `exited with ${exit.code}`;
    throw new Error(
      `${tracked.describe()} ${ending}, expected exit code ${expectedExitCode}.${tracked.outputSection()}`,
    );
  }
  return { code: exit.code, output: tracked.output() };
}

/**
 * Tracked child processes not yet confirmed stopped — `[]` after a successful
 * {@link stopTrackedProcesses}, which is how a suite asserts that no child
 * survived its teardown.
 */
export function listTrackedProcesses(): readonly TrackedProcess[] {
  return [...trackedProcesses];
}

/**
 * Stops every tracked child process (see {@link TrackedProcess.stop}) and
 * removes it from the registry. Throws an `AggregateError` naming each process
 * that could not be stopped; such a process stays listed by
 * {@link listTrackedProcesses}, because a surviving child is exactly the
 * residue a test run must not leave.
 */
export async function stopTrackedProcesses(): Promise<void> {
  const entries = [...trackedProcesses];
  const results = await Promise.allSettled(entries.map((entry) => entry.stop()));
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      failures.push(result.reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `stopTrackedProcesses: ${failures.length} of ${entries.length} tracked process(es) could not be stopped:\n  - ${failures
        .map((failure) => describeError(failure))
        .join('\n  - ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The VS Code command-line interface
// ---------------------------------------------------------------------------

/**
 * The CLI invocation for the VS Code build the tests run in: the first element
 * is the executable, the rest are leading arguments (none on Linux or macOS).
 *
 * Resolved by `@vscode/test-electron` from `VSCODE_TEST_EXECUTABLE_PATH`
 * (set by `.vscode-test.mjs` when it knows the binary) or else
 * `process.execPath`, which inside the extension host is the editor binary.
 * `reuseMachineInstall` is set only to stop the library from appending its own
 * profile arguments (`.vscode-test/{extensions,user-data}` under the current
 * directory): callers must append {@link throwawayCliProfileArgs} — or use
 * {@link throwawayVsCodeCli}, which does both — so no invocation can ever touch
 * the developer's real extensions or profile.
 */
export function resolveVsCodeCliArgs(): readonly string[] {
  const configured = process.env['VSCODE_TEST_EXECUTABLE_PATH']?.trim();
  const executable = configured === undefined || configured === '' ? process.execPath : configured;
  const [cli, ...leading] = resolveCliArgsFromVSCodeExecutablePath(executable, {
    reuseMachineInstall: true,
  });
  if (cli === undefined || !isFile(cli)) {
    throw new Error(
      `The VS Code CLI resolved from ${executable} (${cli ?? 'nothing'}) does not exist; ` +
        'set VSCODE_TEST_EXECUTABLE_PATH to the editor binary the tests run in.',
    );
  }
  return Object.freeze([cli, ...leading]);
}

/**
 * `--extensions-dir <scratchDir>/extensions --user-data-dir <scratchDir>/user-data`,
 * with both directories created eagerly. `scratchDir` must lie inside a
 * directory from {@link createScratchDir}, so {@link cleanupScratch} removes
 * the profile with everything installed into it.
 */
export function throwawayCliProfileArgs(scratchDir: string): readonly string[] {
  const base = path.resolve(scratchDir);
  scratchRootContaining(base, 'throwawayCliProfileArgs');
  const extensions = path.join(base, 'extensions');
  const userData = path.join(base, 'user-data');
  fs.mkdirSync(extensions, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  return Object.freeze(['--extensions-dir', extensions, '--user-data-dir', userData]);
}

/**
 * {@link resolveVsCodeCliArgs} and {@link throwawayCliProfileArgs} combined:
 * the command and the leading arguments of a VS Code CLI call that can only
 * see the throwaway profile under `scratchDir`.
 *
 * @example
 * ```ts
 * const cli = throwawayVsCodeCli(scratch);
 * await runToCompletion(cli.command, [...cli.args, '--install-extension', vsix, '--force']);
 * ```
 */
export function throwawayVsCodeCli(scratchDir: string): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const [command, ...leading] = resolveVsCodeCliArgs();
  if (command === undefined) {
    throw new Error('resolveVsCodeCliArgs returned no executable.');
  }
  return { command, args: Object.freeze([...leading, ...throwawayCliProfileArgs(scratchDir)]) };
}

// ---------------------------------------------------------------------------
// Product-type fixtures
// ---------------------------------------------------------------------------

/**
 * Default confidence per resolution route, used when a fixture names none.
 * The values mirror `DEFAULT_RESOLUTION_CONFIDENCE` in `@debuggen/shared`
 * (this module imports only types from that package, so no schema code is
 * inlined into the suite bundles); a suite that depends on the product's
 * number compares against that export itself. Typed over `SourceResolvedBy`,
 * so a new route fails to compile here until it has a value.
 */
const FIXTURE_CONFIDENCE: Readonly<Record<SourceResolvedBy, number>> = Object.freeze({
  patch: 1,
  'route-map': 0.9,
  'code-graph': 0.85,
  'source-map': 0.75,
  'react-owner': 0.6,
});

/**
 * A `SourceLocation` fixture: `file`, `line` and `column` as given, `symbol`
 * and `endLine` when given, `resolvedBy` defaulting to `'code-graph'` and
 * `confidence` defaulting to that route's value.
 *
 * Values are passed through unchanged — not normalised and not validated —
 * so a suite can build a deliberately hostile location (a `..` traversal, an
 * absolute path). A valid fixture uses a project-relative POSIX `file` and
 * 1-based `line`/`column`; a suite that must prove validity parses the result
 * with `parseSourceLocation` from `@debuggen/shared`.
 */
export function makeSourceLocation(
  overrides: Partial<SourceLocation> & {
    readonly file: string;
    readonly line: number;
    readonly column: number;
  },
): SourceLocation {
  const resolvedBy = overrides.resolvedBy ?? 'code-graph';
  return {
    file: overrides.file,
    line: overrides.line,
    column: overrides.column,
    ...(overrides.symbol === undefined ? {} : { symbol: overrides.symbol }),
    ...(overrides.endLine === undefined ? {} : { endLine: overrides.endLine }),
    resolvedBy,
    confidence: overrides.confidence ?? FIXTURE_CONFIDENCE[resolvedBy],
  };
}

// ---------------------------------------------------------------------------
// Last-resort sweep
// ---------------------------------------------------------------------------

let exitSweepInstalled = false;

/**
 * Installs, once, a synchronous `exit` listener that kills any tracked child
 * and removes any scratch directory a suite failed to tear down, reporting
 * each on stderr. It is a safety net for a suite that crashed before its
 * `after` hook, never a substitute for {@link cleanupScratch}, which is what
 * fails a run that leaks.
 */
function installExitSweep(): void {
  if (exitSweepInstalled) {
    return;
  }
  exitSweepInstalled = true;
  process.once('exit', () => {
    for (const entry of trackedProcesses) {
      console.error(`[helpers] killing child left running at exit: ${entry.describe()}`);
      try {
        entry.killNow();
      } catch (error) {
        console.error(`[helpers] could not kill ${entry.describe()}: ${describeError(error)}`);
      }
    }
    for (const root of scratchRoots) {
      console.error(`[helpers] removing scratch directory left at exit: ${root}`);
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (error) {
        console.error(`[helpers] could not remove ${root}: ${describeError(error)}`);
      }
    }
  });
}
