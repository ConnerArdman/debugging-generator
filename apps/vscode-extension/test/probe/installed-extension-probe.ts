/**
 * The companion ("probe") extension of the packaged-VSIX smoke test: it runs
 * beside the INSTALLED Debug Generator in a second, isolated VS Code window
 * (step 7 of `test/suite/packaged-vsix.test.ts`, AAP 0.7.1 Group 3).
 *
 * WHY A SECOND WINDOW. The suite's own extension host loads the extension from
 * its development directory (`extensionDevelopmentPath` in `.vscode-test.mjs`)
 * with every other extension disabled, so nothing that host can do exercises
 * the copy VS Code installed from the `.vsix`. The suite therefore launches
 * the editor binary again on the throwaway profile the VSIX was installed into
 * (`--user-data-dir`, `--extensions-dir`) WITHOUT `--disable-extensions`: VS
 * Code then loads the installed copy the way a user's editor does — from the
 * extensions directory, in Production mode — and this probe as the one
 * development extension beside it (`--extensionDevelopmentPath`).
 *
 * WHAT IT DOES, once, on `onStartupFinished`:
 *   1. reads {@link PROBE_CONFIG_FILE} from its own directory;
 *   2. resolves the target extension, refuses a copy outside the throwaway
 *      extensions directory or of another version (so a wrong copy is never
 *      activated), and records where it was loaded from and whether it was
 *      already active;
 *   3. activates it through the public API and records the outcome;
 *   4. polls the auth-exempt health route on the configured loopback port until
 *      it answers 200 with `pairingAvailable: true`. Nothing else listens on a
 *      port the suite has just found free, so the answer comes from the service
 *      the extension spawned; pairing being available means the extension's
 *      own editor client connected with the credential it read from
 *      `$DEBUGGEN_HOME/auth.json`;
 *   5. finds the service process and records its argument vector, its parent
 *      and the environment the extension started it with;
 *   6. writes a {@link ProbeResult} atomically to the configured file; and
 *   7. ALWAYS quits the window (`workbench.action.quit`). A real shutdown makes
 *      VS Code call the installed extension's `deactivate()`, which stops its
 *      service child, and lets the editor exit 0 — the suite asserts both.
 *
 * The probe decides nothing the suite must take on trust: every fact is
 * recorded and the suite asserts it. The probe's own checks only stop it early
 * with a named failure. Every wait is bounded and every failure is caught into
 * the result (`ok: false` plus `failure`), because a probe that threw would
 * leave the window open until the suite's budget ran out, with nothing to say
 * why.
 *
 * MODULE RULES. `esbuild.mjs --tests` bundles this file on its own to
 * `dist/test/probe/installed-extension-probe.js` (CommonJS, only `vscode`
 * external), and the suite copies that bundle out of the workspace into its
 * scratch directory, where no `node_modules` exists. So this module imports
 * only `vscode`, which the extension host provides, and `node:` built-ins —
 * never `@debuggen/*` and never `../helpers`, which imports
 * `@vscode/test-electron`. The suite imports the shared types,
 * {@link PROBE_CONFIG_FILE} and {@link parseProbeResult} from here, so the
 * module does nothing when it is loaded. HTTP goes through `node:http` rather
 * than the extension host's `fetch` (see `httpGetText` in `test/helpers.ts`
 * for why) and never carries an `Origin` header, which the service refuses.
 *
 * @module apps/vscode-extension/test/probe/installed-extension-probe
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// The contract with test/suite/packaged-vsix.test.ts
// ---------------------------------------------------------------------------

/** The configuration file the suite writes into the probe's directory. */
export const PROBE_CONFIG_FILE = 'probe-config.json';

/**
 * The environment variables of the service process the probe records: the
 * four `src/service/process.ts` sets from the install and the window's
 * settings, the provider, and the Electron-as-Node switch that runtime needs.
 */
export const SERVICE_ENV_NAMES = Object.freeze([
  'DEBUGGEN_PROMPTS_DIR',
  'DEBUGGEN_HOME',
  'DEBUGGEN_PORT',
  'DEBUGGEN_HOST',
  'DEBUGGEN_PROVIDER',
  'ELECTRON_RUN_AS_NODE',
] as const);

/** One of {@link SERVICE_ENV_NAMES}. */
export type ServiceEnvName = (typeof SERVICE_ENV_NAMES)[number];

/** What the suite tells the probe, as {@link PROBE_CONFIG_FILE}. */
export interface ProbeConfig {
  /** `<publisher>.<name>` of the installed extension under test. */
  readonly targetExtensionId: string;
  /** The version the workspace packaged; any other installed version is refused. */
  readonly expectedVersion: string;
  /** Absolute path of the throwaway extensions directory the VSIX was installed into. */
  readonly installedExtensionsDir: string;
  /** The loopback port `debuggen.serviceUrl` names in this window's user settings. */
  readonly servicePort: number;
  /** The service's health route (`healthPath()` of `@debuggen/protocol`). */
  readonly healthPath: string;
  /** Absolute path the probe writes its {@link ProbeResult} to. */
  readonly resultFile: string;
  /** How long the health route may take to answer 200 with pairing available. */
  readonly healthTimeoutMs: number;
}

/** The step the probe was on when it finished, successfully or not. */
export type ProbeStep = 'config' | 'lookup' | 'activate' | 'health' | 'process' | 'complete';

/** What the probe observed about the target extension. */
export interface ProbeExtensionFacts {
  /** The id it was looked up by. */
  readonly id: string;
  /** Real path of `extension.extensionUri.fsPath`: where VS Code loaded it from. */
  readonly realPath: string;
  /** `packageJSON.version` of the loaded copy, `null` when it is not a string. */
  readonly version: string | null;
  /** `isActive` before the probe activated it. */
  readonly activeBefore: boolean;
  /** `isActive` after `activate()` settled, `null` when that step was not reached. */
  readonly activeAfter: boolean | null;
}

/** The health polling, as observed. */
export interface ProbeHealthFacts {
  /** The URL that was polled. */
  readonly url: string;
  /** Requests sent. */
  readonly attempts: number;
  /** Status of the last answer, `null` when none arrived. */
  readonly status: number | null;
  /** Body of the last answer parsed as JSON (its text when not JSON), `null` when none. */
  readonly body: unknown;
  /** Why the last attempt did not count, `null` once an answer counted. */
  readonly lastError: string | null;
}

/** One process whose argument vector names the installed service entry. */
export interface ProbeServiceProcess {
  readonly pid: number;
  /** Parent pid, `null` when it could not be read. */
  readonly ppid: number | null;
  /** The service entry the matching argument resolves to (real path). */
  readonly entry: string;
  /**
   * The argument vector. On Linux, `/proc/<pid>/cmdline` split at NUL; on
   * macOS, `ps` prints one command-line string, which is the only element.
   */
  readonly argv: readonly string[];
  /** Each of {@link SERVICE_ENV_NAMES}, `null` when unset or unreadable. */
  readonly env: Readonly<Record<ServiceEnvName, string | null>>;
}

/** What the probe writes to {@link ProbeConfig.resultFile}. */
export interface ProbeResult {
  /** `true` only when every step completed. */
  readonly ok: boolean;
  /** Why it did not, naming the step; `null` when `ok`. */
  readonly failure: string | null;
  /** The step reached: `complete` when `ok`, else the one that failed. */
  readonly step: ProbeStep;
  /** `vscode.version` of the isolated window. */
  readonly vscodeVersion: string;
  /** `process.pid` of this extension host, the service's expected parent. */
  readonly hostPid: number;
  /** `process.platform` of the window. */
  readonly platform: string;
  /** Milliseconds from activation of the probe to the result. */
  readonly elapsedMs: number;
  /** `null` when the lookup step was not reached. */
  readonly extension: ProbeExtensionFacts | null;
  /** `null` when the health step was not reached. */
  readonly health: ProbeHealthFacts | null;
  /** Every match, `null` when the process step was not reached. */
  readonly serviceProcesses: readonly ProbeServiceProcess[] | null;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** How long the target's `activate()` may take to settle. */
const ACTIVATION_TIMEOUT_MS = 60_000;

/** Delay between two health requests. */
const HEALTH_POLL_INTERVAL_MS = 250;

/** Budget of one health request. */
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;

/** Upper bound on a health body; the real one is a few dozen bytes. */
const MAX_HEALTH_BODY_CHARS = 64 * 1024;

/** Budget of one `ps` call (macOS). */
const PS_TIMEOUT_MS = 15_000;

/** Upper bound on `ps` output (macOS). */
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** Upper bound on one recorded error or body text. */
const MAX_RECORDED_TEXT_CHARS = 2_000;

/** The workbench command that closes every window and shuts the editor down. */
const QUIT_COMMAND = 'workbench.action.quit';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `code` of a Node system error, if it has one. */
function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** `text`, cut to {@link MAX_RECORDED_TEXT_CHARS} with a marker. */
function bounded(text: string): string {
  return text.length > MAX_RECORDED_TEXT_CHARS
    ? `${text.slice(0, MAX_RECORDED_TEXT_CHARS)}… (${text.length - MAX_RECORDED_TEXT_CHARS} more characters)`
    : text;
}

/** One line describing anything thrown, including one level of `cause`. */
function describeError(error: unknown): string {
  const render = (value: unknown): string => {
    if (value instanceof Error) {
      return value.message;
    }
    if (typeof value === 'string') {
      return value;
    }
    try {
      // `undefined` for a function or a symbol; a throw for a bigint or a cycle.
      const json: string | undefined = JSON.stringify(value);
      return json ?? typeof value;
    } catch {
      return typeof value;
    }
  };
  if (error instanceof Error) {
    const cause = error.cause === undefined ? '' : ` (cause: ${render(error.cause)})`;
    return bounded(`${error.name}: ${error.message}${cause}`);
  }
  return bounded(render(error));
}

/** The real path of `target`, or `undefined` when it does not exist. */
function realPathOrUndefined(target: string): string | undefined {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'ELOOP') {
      return undefined;
    }
    throw error;
  }
}

/** Whether `candidate` is `root` or lies beneath it (both absolute). */
function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * `work`, or a rejection naming `what` once `ms` have passed. The timer is
 * always cleared, so a settled race leaves nothing pending.
 */
async function withinBudget<T>(work: Thenable<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not settle within ${ms} ms.`));
    }, ms);
  });
  try {
    return await Promise.race([Promise.resolve(work), expired]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The configuration
// ---------------------------------------------------------------------------

/**
 * Reads and validates {@link PROBE_CONFIG_FILE} from `directory`; throws an
 * `Error` naming the first unusable field.
 */
function readProbeConfig(directory: string): ProbeConfig {
  const file = path.join(directory, PROBE_CONFIG_FILE);
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${file} does not hold a JSON object.`);
  }
  const fail = (field: string, requirement: string): Error =>
    new Error(
      `${file}: "${field}" must be ${requirement} (found ${JSON.stringify(parsed[field])}).`,
    );
  const text = (field: string): string => {
    const value = parsed[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw fail(field, 'a non-empty string');
    }
    return value;
  };
  const absolute = (field: string): string => {
    const value = text(field);
    if (!path.isAbsolute(value)) {
      throw fail(field, 'an absolute path');
    }
    return value;
  };
  const integer = (field: string, min: number, max: number): number => {
    const value = parsed[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      throw fail(field, `an integer from ${min} to ${max}`);
    }
    return value;
  };

  const targetExtensionId = text('targetExtensionId');
  if (!/^[A-Za-z0-9][\w-]*\.[A-Za-z0-9][\w.-]*$/.test(targetExtensionId)) {
    throw fail('targetExtensionId', 'an extension id of the form <publisher>.<name>');
  }
  const healthPath = text('healthPath');
  if (!healthPath.startsWith('/') || healthPath.startsWith('//')) {
    throw fail('healthPath', 'an absolute URL path such as "/health"');
  }
  return Object.freeze({
    targetExtensionId,
    expectedVersion: text('expectedVersion'),
    installedExtensionsDir: absolute('installedExtensionsDir'),
    servicePort: integer('servicePort', 1, 65_535),
    healthPath,
    resultFile: absolute('resultFile'),
    healthTimeoutMs: integer('healthTimeoutMs', 1, 30 * 60_000),
  });
}

// ---------------------------------------------------------------------------
// The health route
// ---------------------------------------------------------------------------

/**
 * One origin-less `GET` over `node:http` with a hard deadline, returning the
 * status and the body (parsed as JSON when it is JSON, else its text).
 */
function getOnce(url: URL, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: 'GET', headers: { accept: 'application/json' }, agent: false },
      (response) => {
        response.setEncoding('utf8');
        let text = '';
        response.on('data', (chunk: string) => {
          text += chunk;
          if (text.length > MAX_HEALTH_BODY_CHARS) {
            request.destroy(
              new Error(`GET ${url.href}: the body exceeds ${MAX_HEALTH_BODY_CHARS} characters.`),
            );
          }
        });
        response.on('end', () => {
          clearTimeout(timer);
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = bounded(text);
          }
          resolve({ status: response.statusCode ?? 0, body });
        });
        response.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new Error(`GET ${url.href} did not answer within ${timeoutMs} ms.`));
    }, timeoutMs);
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

/** {@link ProbeHealthFacts}, while it is being gathered. */
interface HealthProgress {
  url: string;
  attempts: number;
  status: number | null;
  body: unknown;
  lastError: string | null;
}

/**
 * Polls `progress.url` until it answers 200 with `pairingAvailable: true`,
 * updating `progress` after every attempt; throws once `timeoutMs` have passed
 * or `signal` aborts. A connection failure, another status, or a body without
 * pairing available (the editor client has not connected yet) all count as
 * "not yet".
 */
async function awaitServiceWithEditorClient(
  progress: HealthProgress,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const url = new URL(progress.url);
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    progress.attempts += 1;
    try {
      const remaining = Math.max(1, Math.round(deadline - performance.now()));
      const answer = await getOnce(url, Math.min(HEALTH_REQUEST_TIMEOUT_MS, remaining));
      progress.status = answer.status;
      progress.body = answer.body;
      if (
        answer.status === 200 &&
        isRecord(answer.body) &&
        answer.body['pairingAvailable'] === true
      ) {
        progress.lastError = null;
        return;
      }
      progress.lastError =
        answer.status === 200
          ? 'answered 200 without pairingAvailable: true (no editor client connected yet)'
          : `answered ${answer.status}`;
    } catch (error) {
      progress.lastError = describeError(error);
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error(
        `GET ${url.href} did not answer 200 with pairingAvailable: true within ${timeoutMs} ms ` +
          `(${progress.attempts} attempts; last: ${progress.lastError ?? 'none'}).`,
      );
    }
    await sleep(Math.min(HEALTH_POLL_INTERVAL_MS, remaining), undefined, { signal });
  }
}

// ---------------------------------------------------------------------------
// The service process
// ---------------------------------------------------------------------------

/** The recorded variables out of `NAME=value` entries; the first entry of a name wins. */
function pickServiceEnv(entries: readonly string[]): Record<ServiceEnvName, string | null> {
  const env: Record<ServiceEnvName, string | null> = {
    DEBUGGEN_PROMPTS_DIR: null,
    DEBUGGEN_HOME: null,
    DEBUGGEN_PORT: null,
    DEBUGGEN_HOST: null,
    DEBUGGEN_PROVIDER: null,
    ELECTRON_RUN_AS_NODE: null,
  };
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = entry.slice(0, separator);
    const known = SERVICE_ENV_NAMES.find((candidate) => candidate === name);
    if (known !== undefined && env[known] === null) {
      env[known] = entry.slice(separator + 1);
    }
  }
  return env;
}

/**
 * The NUL-separated entries of a `/proc/<pid>/` file (`cmdline`, `environ`),
 * or `undefined` when the process vanished or its file is not readable.
 */
function readProcList(file: string): string[] | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES' || code === 'EPERM') {
      return undefined;
    }
    throw error;
  }
  const entries = raw.split('\0');
  if (entries[entries.length - 1] === '') {
    entries.pop();
  }
  return entries;
}

/** The parent pid of a Linux process from `/proc/<pid>/stat`, or `null`. */
function readLinuxParentPid(pid: number): number | null {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ESRCH') {
      return null;
    }
    throw error;
  }
  // "pid (comm) state ppid …" — comm may contain spaces and parentheses.
  const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  return Number.isSafeInteger(ppid) ? ppid : null;
}

/**
 * Every Linux process one of whose arguments resolves to `entry` (a real
 * path), from `/proc`. A process that exits mid-scan is simply not listed.
 */
function findServiceProcessesLinux(entry: string): ProbeServiceProcess[] {
  const found: ProbeServiceProcess[] = [];
  const entryName = path.basename(entry);
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const argv = readProcList(`/proc/${name}/cmdline`);
    const matches = argv?.some(
      (argument) =>
        path.isAbsolute(argument) &&
        path.basename(argument) === entryName &&
        realPathOrUndefined(argument) === entry,
    );
    if (argv === undefined || matches !== true) {
      continue;
    }
    const pid = Number(name);
    found.push({
      pid,
      ppid: readLinuxParentPid(pid),
      entry,
      argv,
      env: pickServiceEnv(readProcList(`/proc/${name}/environ`) ?? []),
    });
  }
  return found;
}

/** `ps` with `args`, its stdout; rejects on a non-zero exit or a timeout. */
function runPs(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      [...args],
      { encoding: 'utf8', timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER_BYTES },
      (error, stdout) => {
        if (error === null) {
          resolve(stdout);
        } else {
          reject(new Error(`ps ${args.join(' ')} failed: ${error.message}`, { cause: error }));
        }
      },
    );
  });
}

/**
 * Every macOS process whose command line names `entry` or `lexical` (the path
 * as the extension spelled it) as a whole argument, from `ps`. `ps -E` appends
 * the environment as space-separated `NAME=value` words, so a value containing
 * a space is recorded up to that space.
 */
async function findServiceProcessesDarwin(
  entry: string,
  lexical: string,
): Promise<ProbeServiceProcess[]> {
  const spellings = [...new Set([entry, lexical])];
  const found: ProbeServiceProcess[] = [];
  const listing = await runPs(['-A', '-ww', '-o', 'pid=,ppid=,command=']);
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    const command = match?.[3]?.trimEnd();
    if (match === null || command === undefined) {
      continue;
    }
    const padded = ` ${command} `;
    if (!spellings.some((spelling) => padded.includes(` ${spelling} `))) {
      continue;
    }
    const pid = Number(match[1]);
    const withEnvironment = (
      await runPs(['-E', '-ww', '-o', 'command=', '-p', String(pid)])
    ).trim();
    const environment = withEnvironment.startsWith(command)
      ? withEnvironment.slice(command.length)
      : withEnvironment;
    found.push({
      pid,
      ppid: Number(match[2]),
      entry,
      argv: [command],
      env: pickServiceEnv(environment.trim().split(/\s+/)),
    });
  }
  return found;
}

/** Every process running the service entry of the extension at `extensionRoot`. */
async function findServiceProcesses(extensionRoot: string): Promise<ProbeServiceProcess[]> {
  const lexical = path.join(extensionRoot, 'dist', 'service', 'main.js');
  const entry = realPathOrUndefined(lexical);
  if (entry === undefined) {
    throw new Error(`The installed extension has no service entry at ${lexical}.`);
  }
  if (process.platform === 'linux') {
    return findServiceProcessesLinux(entry);
  }
  if (process.platform === 'darwin') {
    return findServiceProcessesDarwin(entry, lexical);
  }
  throw new Error(
    `Finding the service process is supported on Linux (/proc) and macOS (ps) only, ` +
      `the platforms the packaged-VSIX suite runs on; this window runs on ${process.platform}.`,
  );
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Aborts the run's waits when VS Code deactivates the probe first. */
let runController: AbortController | undefined;

/** Writes `result` to `file` through a temporary sibling and a rename. */
function writeResultAtomically(file: string, result: ProbeResult): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Steps 1–7 of the module overview. Never throws. */
async function run(context: vscode.ExtensionContext, signal: AbortSignal): Promise<void> {
  const startedAt = performance.now();
  let step: ProbeStep = 'config';
  let config: ProbeConfig | undefined;
  let extension: ProbeExtensionFacts | null = null;
  let health: HealthProgress | null = null;
  let serviceProcesses: readonly ProbeServiceProcess[] | null = null;
  let failure: string | null = null;

  try {
    config = readProbeConfig(context.extensionPath);

    step = 'lookup';
    const target = vscode.extensions.getExtension<unknown>(config.targetExtensionId);
    if (target === undefined) {
      const loaded = vscode.extensions.all
        .map((candidate) => candidate.id)
        .filter((id) => !id.startsWith('vscode.'))
        .sort();
      throw new Error(
        `${config.targetExtensionId} is not loaded in this window (non-built-in extensions: ${loaded.join(', ') || 'none'}).`,
      );
    }
    const realPath = fs.realpathSync(target.extensionUri.fsPath);
    const manifest: unknown = target.packageJSON;
    const version =
      isRecord(manifest) && typeof manifest['version'] === 'string' ? manifest['version'] : null;
    extension = {
      id: config.targetExtensionId,
      realPath,
      version,
      activeBefore: target.isActive,
      activeAfter: null,
    };
    const extensionsRoot = fs.realpathSync(config.installedExtensionsDir);
    if (!isWithin(realPath, extensionsRoot) || realPath === extensionsRoot) {
      throw new Error(
        `${config.targetExtensionId} was loaded from ${realPath}, not from the throwaway extensions directory ${extensionsRoot}.`,
      );
    }
    if (version !== config.expectedVersion) {
      throw new Error(
        `The loaded ${config.targetExtensionId} is version ${JSON.stringify(version)}, not the packaged ${config.expectedVersion}.`,
      );
    }

    step = 'activate';
    await withinBudget(
      target.activate(),
      ACTIVATION_TIMEOUT_MS,
      `Activating ${config.targetExtensionId}`,
    );
    extension = { ...extension, activeAfter: target.isActive };
    if (!target.isActive) {
      throw new Error(`activate() of ${config.targetExtensionId} resolved but it is not active.`);
    }

    step = 'health';
    health = {
      url: `http://127.0.0.1:${config.servicePort}${config.healthPath}`,
      attempts: 0,
      status: null,
      body: null,
      lastError: null,
    };
    await awaitServiceWithEditorClient(health, config.healthTimeoutMs, signal);

    step = 'process';
    serviceProcesses = await findServiceProcesses(realPath);

    step = 'complete';
  } catch (error) {
    failure = `step "${step}" failed: ${describeError(error)}`;
  } finally {
    const result: ProbeResult = {
      ok: failure === null,
      failure,
      step,
      vscodeVersion: vscode.version,
      hostPid: process.pid,
      platform: process.platform,
      elapsedMs: Math.round(performance.now() - startedAt),
      extension,
      health: health === null ? null : { ...health },
      serviceProcesses,
    };
    if (config === undefined) {
      console.error(
        `[packaged-vsix probe] ${failure ?? 'no configuration'}; no result file can be named.`,
      );
    } else {
      try {
        writeResultAtomically(config.resultFile, result);
      } catch (error) {
        console.error(
          `[packaged-vsix probe] could not write ${config.resultFile}: ${describeError(error)}`,
        );
      }
    }
    try {
      await vscode.commands.executeCommand(QUIT_COMMAND);
    } catch (error) {
      console.error(`[packaged-vsix probe] ${QUIT_COMMAND} failed: ${describeError(error)}`);
    }
  }
}

/**
 * Starts the run and returns at once, so VS Code records the probe as
 * activated (and therefore deactivates it on shutdown) while the run waits on
 * the target. The run's own `finally` quits the window.
 */
export function activate(context: vscode.ExtensionContext): void {
  runController?.abort();
  const controller = new AbortController();
  runController = controller;
  void run(context, controller.signal);
}

/**
 * Aborts a run that is still waiting — a shutdown that did not come from the
 * run itself — so no timer or request outlives the extension host. Not
 * awaited: the run's pending `quit` settles only once shutdown is under way.
 */
export function deactivate(): void {
  runController?.abort();
  runController = undefined;
}

// ---------------------------------------------------------------------------
// Reading a result back (used by the suite)
// ---------------------------------------------------------------------------

const PROBE_STEPS: readonly ProbeStep[] = Object.freeze([
  'config',
  'lookup',
  'activate',
  'health',
  'process',
  'complete',
]);

/**
 * Validates a parsed result file as a {@link ProbeResult}, building a fresh
 * object from the validated members only; throws an `Error` naming `source`
 * and the first unusable member.
 */
export function parseProbeResult(value: unknown, source: string): ProbeResult {
  const fail = (at: string, requirement: string, found: unknown): Error =>
    new Error(
      `Probe result ${source} is invalid: ${at} must be ${requirement} (found ${bounded(JSON.stringify(found) ?? String(found))}).`,
    );
  const record = (candidate: unknown, at: string): Readonly<Record<string, unknown>> => {
    if (!isRecord(candidate)) {
      throw fail(at, 'an object', candidate);
    }
    return candidate;
  };
  const text = (candidate: unknown, at: string): string => {
    if (typeof candidate !== 'string') {
      throw fail(at, 'a string', candidate);
    }
    return candidate;
  };
  const nullableText = (candidate: unknown, at: string): string | null =>
    candidate === null ? null : text(candidate, at);
  const flag = (candidate: unknown, at: string): boolean => {
    if (typeof candidate !== 'boolean') {
      throw fail(at, 'a boolean', candidate);
    }
    return candidate;
  };
  const integer = (candidate: unknown, at: string): number => {
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate)) {
      throw fail(at, 'an integer', candidate);
    }
    return candidate;
  };
  const nullableInteger = (candidate: unknown, at: string): number | null =>
    candidate === null ? null : integer(candidate, at);

  const root = record(value, 'the result');
  const step = root['step'];
  const knownStep = PROBE_STEPS.find((candidate) => candidate === step);
  if (knownStep === undefined) {
    throw fail('step', `one of ${PROBE_STEPS.join(', ')}`, step);
  }

  const extensionValue = root['extension'];
  let extension: ProbeExtensionFacts | null = null;
  if (extensionValue !== null) {
    const facts = record(extensionValue, 'extension');
    const activeAfter = facts['activeAfter'];
    extension = {
      id: text(facts['id'], 'extension.id'),
      realPath: text(facts['realPath'], 'extension.realPath'),
      version: nullableText(facts['version'], 'extension.version'),
      activeBefore: flag(facts['activeBefore'], 'extension.activeBefore'),
      activeAfter: activeAfter === null ? null : flag(activeAfter, 'extension.activeAfter'),
    };
  }

  const healthValue = root['health'];
  let health: ProbeHealthFacts | null = null;
  if (healthValue !== null) {
    const facts = record(healthValue, 'health');
    health = {
      url: text(facts['url'], 'health.url'),
      attempts: integer(facts['attempts'], 'health.attempts'),
      status: nullableInteger(facts['status'], 'health.status'),
      body: facts['body'] ?? null,
      lastError: nullableText(facts['lastError'], 'health.lastError'),
    };
  }

  const processesValue = root['serviceProcesses'];
  let serviceProcesses: ProbeServiceProcess[] | null = null;
  if (processesValue !== null) {
    if (!Array.isArray(processesValue)) {
      throw fail('serviceProcesses', 'an array or null', processesValue);
    }
    const entries: readonly unknown[] = processesValue;
    serviceProcesses = entries.map((entryValue, index) => {
      const at = `serviceProcesses[${index}]`;
      const entry = record(entryValue, at);
      const argvValue = entry['argv'];
      if (!Array.isArray(argvValue)) {
        throw fail(`${at}.argv`, 'an array', argvValue);
      }
      const argvEntries: readonly unknown[] = argvValue;
      const envRecord = record(entry['env'], `${at}.env`);
      const env = pickServiceEnv([]);
      for (const name of SERVICE_ENV_NAMES) {
        env[name] = nullableText(envRecord[name] ?? null, `${at}.env.${name}`);
      }
      return {
        pid: integer(entry['pid'], `${at}.pid`),
        ppid: nullableInteger(entry['ppid'], `${at}.ppid`),
        entry: text(entry['entry'], `${at}.entry`),
        argv: argvEntries.map((argument, position) => text(argument, `${at}.argv[${position}]`)),
        env,
      };
    });
  }

  return {
    ok: flag(root['ok'], 'ok'),
    failure: nullableText(root['failure'], 'failure'),
    step: knownStep,
    vscodeVersion: text(root['vscodeVersion'], 'vscodeVersion'),
    hostPid: integer(root['hostPid'], 'hostPid'),
    platform: text(root['platform'], 'platform'),
    elapsedMs: integer(root['elapsedMs'], 'elapsedMs'),
    extension,
    health,
    serviceProcesses,
  };
}
