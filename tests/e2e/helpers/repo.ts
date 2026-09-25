/**
 * The repository-and-process utility layer of the Playwright `e2e` project.
 *
 * ## What this module owns
 *
 * - **Where the repository is** — {@link repoRoot} / {@link repoPath}, resolved from this
 *   module's own location and validated against the root manifest, never probed from a
 *   `.git` directory and never taken from `process.cwd()`.
 * - **What a child process may inherit** — {@link sanitizedEnv}, an allowlist of variable
 *   names followed by a second, name- and value-shape-based strip.
 * - **How a long command runs** — {@link runCommand} / {@link runPnpm}: `shell: false`,
 *   streamed line by line, bounded in memory, with an unconditional heartbeat, a hard
 *   timeout (SIGTERM, then SIGKILL) and a diagnosable failure message; plus the timeout
 *   budgets every sibling passes instead of inventing its own.
 * - **How git is asked about the tree** — {@link runGit}, the single git entry point of
 *   `tests/e2e/helpers`, and {@link listTrackedFiles}, the tracked-path enumerator the
 *   demo and fixture snapshots hash.
 * - **How a working tree is materialised elsewhere** — {@link copyTrackedTree}, the
 *   `.git`-free copy `clean-clone.spec.ts` builds its two independent clones from.
 *
 * It is the foundation of this folder: it imports no sibling helper, no `@debuggen/*`
 * package and no Playwright fixture, and it has no import-time side effect, so
 * `clean-clone.spec.ts` — which touches no session, browser, service or database — pays
 * for nothing else by importing it.
 *
 * ## Three prohibitions
 *
 * 1. **Nothing under `.git/` is ever read, copied, archived or logged** (AAP 0.2.1): the
 *    repository's `origin` URL embeds a live access token. Running git as a *command* whose
 *    output is paths only (`git ls-files -z`, `git status --porcelain`) is the sanctioned
 *    mechanism; {@link runGit} additionally refuses the subcommands that print remotes or
 *    configuration (`remote`, `config`, `ls-remote`, `credential`, ...).
 * 2. **Nothing is written into either project tree** (AAP 0.5.1 — helpers read, the product
 *    writes): this module never creates, modifies, truncates or deletes a path under
 *    `apps/demo-app` or `tests/fixtures/sample-next-app`, or anywhere else in the checkout.
 *    {@link copyTrackedTree} writes only into a caller-supplied destination that it proves
 *    (by real path) lies outside {@link repoRoot}. The caller owns that destination and its
 *    cleanup; it belongs under `os.tmpdir()` (for example `fs.mkdtemp(path.join(os.tmpdir(),
 *    'debuggen-clean-clone-'))`).
 * 3. **No credential reaches output** (AAP 0.3.4, `pnpm check:secrets`): no environment
 *    *value* is ever logged, attached or returned by a diagnostic path — sanitisation and its
 *    reports work on variable *names* and on value *shapes* only — and this file contains no
 *    token, key or credential-bearing connection string.
 *
 * ## Relationship to `tests/browser/fixtures.ts`
 *
 * That module is the idiom reference (named `*_TIMEOUT_MS` budgets, a 5 s SIGTERM→SIGKILL
 * grace, process-group termination of what it spawned, the repository root from
 * `import.meta.url`), and this one mirrors its naming and semantics. It deliberately does
 * **not** import it: the two Playwright projects have different app-start contracts — the
 * browser suite may start the fixture app without the telemetry preload, while the e2e suite
 * must go through the product's own launcher — and importing it would also evaluate its
 * fixture graph and the `@debuggen/*` packages behind it. Deliberate divergences:
 *
 * - the child environment is an **allowlist** here, where `childEnvironment()` there copies
 *   `process.env` and strips a few names: a clean-clone build must inherit nothing it did not
 *   ask for, and the e2e run itself carries the service's `DEBUGGEN_*` settings;
 * - commands **stream** with a heartbeat here, where `runToCompletion()` there buffers
 *   silently: an install or a monorepo build here runs for minutes, and silence, not
 *   slowness, is what gets a long run killed;
 * - pnpm is resolved from the documented `DEBUGGEN_E2E_PNPM` override, else `pnpm` on
 *   `PATH`, rather than from `npm_execpath` — the clean-clone spec must exercise the same
 *   pnpm a developer's shell (or CI's `pnpm/action-setup`) provides.
 *
 * This file declares no `test(...)`, `describe(...)`, hook or fixture; it is plain
 * TypeScript usable outside a Playwright worker, and its name keeps it outside the `e2e`
 * project's `**\/*.spec.ts` `testMatch`.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { constants as fsConstants, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  stat,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Timing and size budgets — callers pass these; no sibling invents its own.
// ---------------------------------------------------------------------------

/**
 * Cadence of the "still running" line {@link runCommand} prints for every command, output or
 * not. CI watchdogs and Playwright's reporter both treat a long silence as a hang; thirty
 * seconds stays well inside every silence allowance this suite runs under.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * `pnpm install --frozen-lockfile` into a fresh copy of the monorepo. A warm content-addressable
 * store links in well under a minute; a cold store downloads the whole graph (Next.js, Prisma
 * engines, Playwright, the VS Code tooling) on a shared CI runner, which is what this budgets.
 */
export const INSTALL_TIMEOUT_MS = 15 * 60_000;

/**
 * `pnpm build`: `prisma generate`, then every workspace in topological order — eight tsup
 * packages, the esbuild browser agent and preload, both Vite extension builds, the service
 * bundle and `next build` of the demo storefront. The longest single command of the suite.
 */
export const BUILD_TIMEOUT_MS = 20 * 60_000;

/**
 * `pnpm typecheck`: `prisma generate`, then `tsc -b` over the root solution file — every
 * referenced project compiled from source on a clone with no `.tsbuild/` stamps yet.
 */
export const TYPECHECK_TIMEOUT_MS = 10 * 60_000;

/**
 * `pnpm demo:migrate`: applying the demo's migration history to an empty or current
 * PostgreSQL database. Quick in itself; the budget absorbs a container still warming up.
 */
export const MIGRATE_TIMEOUT_MS = 5 * 60_000;

/**
 * `pnpm demo:seed`: ≈400 products, six warehouses and ≈200 000 inventory movements in batched
 * inserts (AAP 0.8.2) — about twenty seconds on an idle host, minutes on a contended one.
 */
export const SEED_TIMEOUT_MS = 15 * 60_000;

/** A short command that should answer at once (`node --version`, a guard-script probe). */
export const SHORT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * A single git plumbing call (`git ls-files -z`, `git status --porcelain`) over this
 * repository: local, no network, milliseconds normally; the budget covers a cold disk cache.
 */
export const GIT_COMMAND_TIMEOUT_MS = 30_000;

/** Grace between SIGTERM and SIGKILL, the same five seconds `tests/browser/fixtures.ts` uses. */
export const TERMINATION_GRACE_MS = 5_000;

/**
 * Default ceiling on the output one command may keep in memory (stdout, stderr and the
 * interleaved stream together). A cold `pnpm install` is verbose; past this, the head and the
 * tail are kept and the middle is replaced by a single explicit truncation marker.
 */
export const DEFAULT_MAX_CAPTURED_BYTES = 2 * 1024 * 1024;

/** How many trailing output lines a {@link CommandFailedError} message carries. */
export const FAILURE_TAIL_LINES = 60;

/** Largest delay `setTimeout` honours; a longer budget would silently fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A partial line longer than this is emitted as a line of its own (output without newlines). */
const MAX_PENDING_LINE_CHARS = 64 * 1024;

/** Upper bound on the output of `git ls-files -z`; a larger listing is an error, not a truncation. */
const MAX_TRACKED_LISTING_BYTES = 256 * 1024 * 1024;

/** Parallel file copies in {@link copyTrackedTree}. */
const COPY_CONCURRENCY = 16;

// ---------------------------------------------------------------------------
// Repository root
// ---------------------------------------------------------------------------

/**
 * Root scripts the e2e suite invokes by name (`clean-clone.spec.ts` runs `build` and
 * `typecheck`; `demo-app.ts` runs the three `demo:*` scripts). Their presence is what
 * identifies the directory three levels above this module as this repository's root.
 */
const REQUIRED_ROOT_SCRIPTS = Object.freeze([
  'build',
  'typecheck',
  'demo:generate',
  'demo:migrate',
  'demo:seed',
]);

let cachedRepoRoot: string | undefined;

/**
 * The absolute, platform-native, symlink-resolved path of the repository root.
 *
 * This module lives at `tests/e2e/helpers/repo.ts`, so the root is three directories up from
 * `import.meta.url`. The result is validated rather than assumed — `pnpm-workspace.yaml` and a
 * private root `package.json` carrying a `packageManager` field and the scripts the suite
 * invokes must be present — and memoised. There is deliberately no fallback to a `.git` probe.
 *
 * @throws When the resolved directory is not the repository root, naming the path, the
 *   missing marker and the likely cause (this module was moved).
 */
export function repoRoot(): string {
  if (cachedRepoRoot !== undefined) {
    return cachedRepoRoot;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, '..', '..', '..');
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch (error) {
    throw rootError(candidate, 'the directory', `cannot be resolved (${describeError(error)})`);
  }
  validateRepoRoot(resolved);
  cachedRepoRoot = resolved;
  return resolved;
}

/**
 * Join path segments onto {@link repoRoot}, so no helper hand-builds
 * `join(repoRoot(), 'apps', 'demo-app')` twice. Segments may be POSIX-style
 * (`'apps/demo-app'`); the result is platform-native.
 *
 * @throws When the joined path escapes the repository (an absolute segment or `..`).
 */
export function repoPath(...segments: string[]): string {
  const root = repoRoot();
  for (const segment of segments) {
    if (path.isAbsolute(segment) || path.posix.isAbsolute(segment)) {
      throw new Error(
        `repoPath(): segment ${JSON.stringify(segment)} is absolute; pass repository-relative segments.`,
      );
    }
  }
  const joined = path.join(root, ...segments.flatMap((segment) => segment.split('/')));
  if (!isPathInside(joined, root)) {
    throw new Error(
      `repoPath(): ${JSON.stringify(segments.join('/'))} resolves to ${joined}, outside the repository root ${root}.`,
    );
  }
  return joined;
}

/** Throws unless `root` carries the markers of this repository's root. */
function validateRepoRoot(root: string): void {
  const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
  if (!isFileSync(workspaceFile)) {
    throw rootError(root, 'pnpm-workspace.yaml', 'is missing');
  }
  const manifestFile = path.join(root, 'package.json');
  if (!isFileSync(manifestFile)) {
    throw rootError(root, 'package.json', 'is missing');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    throw rootError(root, 'package.json', `does not parse as JSON (${describeError(error)})`);
  }
  if (!isRecord(manifest)) {
    throw rootError(root, 'package.json', 'is not a JSON object');
  }
  if (manifest.private !== true) {
    throw rootError(root, 'package.json', 'is not the private workspace root (`"private": true`)');
  }
  if (typeof manifest.packageManager !== 'string' || !manifest.packageManager.startsWith('pnpm@')) {
    throw rootError(root, 'package.json', 'declares no `packageManager: "pnpm@…"` field');
  }
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
  const missing = REQUIRED_ROOT_SCRIPTS.filter((name) => typeof scripts[name] !== 'string');
  if (missing.length > 0) {
    throw rootError(root, 'package.json', `lacks the root script(s) ${missing.join(', ')}`);
  }
}

function rootError(resolved: string, marker: string, problem: string): Error {
  return new Error(
    `repoRoot(): ${resolved} is not the Debug Generator repository root — ${marker} ${problem}. ` +
      `The root is resolved as three directories above tests/e2e/helpers/repo.ts; if this module ` +
      `was moved, update the relative hop in repoRoot() (it never falls back to probing for .git).`,
  );
}

function isFileSync(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    // Absent or unreadable: either way the marker is not there.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Environment sanitisation
// ---------------------------------------------------------------------------

/**
 * The only variables a child inherits from this process. Everything a build, an install or a
 * git call needs to find its tools, its home, its locale and its temporary directory — and
 * nothing that configures the product (`DEBUGGEN_*`), the Node runtime (`NODE_OPTIONS`), a
 * model provider or a database.
 *
 * Beyond the POSIX basics and their Windows equivalents (listed so the module stays portable
 * although CI is Linux), three groups are admitted deliberately:
 *
 * - `LC_CTYPE` — the locale category terminals commonly set instead of `LANG`/`LC_ALL`;
 * - `XDG_*_HOME`, `COREPACK_HOME`, `PNPM_HOME` — where pnpm reads its global config (the
 *   shared `store-dir`) and corepack its cached pnpm; without them a clean-clone install would
 *   silently use a different store and re-download the whole graph;
 * - `HTTP(S)_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` — registry access on a proxied network.
 *   A proxy URL carrying `user:password@` is still withheld by the value-shape pass below.
 *
 * On Windows `process.env` is case-insensitive, so reading each name here finds `Path` too.
 */
const INHERITED_ENV_NAMES: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'CI',
  'TERM',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'COREPACK_HOME',
  'PNPM_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
  'USERPROFILE',
]);

/**
 * Names never passed to a child, inherited or requested (compared case-insensitively).
 * `NODE_OPTIONS` first: a leaked `--import` of the telemetry preload would silently instrument
 * a clean-clone build; `npm_config_node_options` is the same setting spelled for pnpm, which
 * exports it to every script it runs.
 */
const BLOCKED_ENV_NAMES: ReadonlySet<string> = new Set([
  'NODE_OPTIONS',
  'NPM_CONFIG_NODE_OPTIONS',
  'ANTHROPIC_API_KEY',
]);

/** Name prefixes never passed to a child: the product's own configuration (AAP 0.3.4). */
const BLOCKED_ENV_PREFIXES: readonly string[] = Object.freeze(['DEBUGGEN_']);

/** A variable whose NAME says it carries a credential, whatever its value looks like. */
const SENSITIVE_NAME_PATTERN =
  /(TOKEN|SECRET|PASSWORD|CREDENTIAL|APIKEY|API_KEY|_KEY|COOKIE|SESSION|AUTH)/i;

/**
 * Value shapes that are credentials whatever the variable is called: provider key prefixes,
 * AWS access key ids, a JOSE compact token, a PEM private-key header and a bearer header.
 * Written as character classes so this tracked file itself carries no credential-shaped run.
 */
const CREDENTIAL_VALUE_SHAPES: readonly RegExp[] = Object.freeze([
  /(?<![A-Za-z0-9_-])(?:sk-|gh[pousr]_|github_pat_|xox[abpr]-)[A-Za-z0-9_-]{16,}/,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{30,}/,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-{5}BEGIN [A-Z ]*PRIVATE KEY/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
]);

/** A URL carrying `user:password@` — a connection string or proxy URL with a credential. */
const URL_WITH_PASSWORD_SHAPE = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

/** Where a withheld variable came from. */
export type EnvOrigin = 'inherited' | 'requested';

/** Why a variable was withheld. Reported with the NAME only — never the value. */
export type EnvWithholdReason = 'blocked-name' | 'sensitive-name' | 'credential-value';

/** One withheld variable, by name. */
export interface WithheldEnvVar {
  readonly name: string;
  readonly origin: EnvOrigin;
  readonly reason: EnvWithholdReason;
}

/** The child environment and an account, by name only, of what was kept out of it. */
export interface SanitizedEnvironment {
  readonly env: Record<string, string>;
  readonly withheld: readonly WithheldEnvVar[];
}

/**
 * The environment every child of this module runs with. See {@link sanitizeEnvironment}.
 *
 * @param extra Deliberate values for this child (for example `clean-clone.spec.ts`'s
 *   credential-free `DATABASE_URL` placeholder, or `CI`), added after the inherited set is
 *   stripped and therefore able to override it.
 */
export function sanitizedEnv(extra?: Readonly<Record<string, string>>): Record<string, string> {
  return sanitizeEnvironment(extra).env;
}

/**
 * Build a child environment in three steps:
 *
 * 1. copy only the {@link INHERITED_ENV_NAMES allowlisted} names from `process.env`;
 * 2. strip, as a defence-in-depth second pass over both that result and `extra`: blocked names
 *    (`NODE_OPTIONS`, every `DEBUGGEN_*`, `ANTHROPIC_API_KEY`), any name matching
 *    `/(TOKEN|SECRET|PASSWORD|CREDENTIAL|APIKEY|API_KEY|_KEY|COOKIE|SESSION|AUTH)/i`, and any
 *    value shaped like a credential (provider key prefixes, JWT, PEM private key, bearer);
 * 3. set `FORCE_COLOR=0` / `NO_COLOR=1` so captured output is ANSI-free and assertable, then
 *    add the surviving `extra` entries — the only channel for deliberate values.
 *
 * One asymmetry is deliberate: an *inherited* value that is a URL with `user:password@` is
 * withheld, while a *requested* one is kept. `extra` is where a caller states intent, and the
 * demo's migrate and seed can only be told where PostgreSQL is through such a URL — the
 * development placeholder of AAP 0.3.4, which `demo-app.ts` reads from its own environment and
 * forwards here rather than writing it down. Blocked names, sensitive names and every other
 * credential shape are refused on both paths.
 *
 * Pure: nothing is logged here. {@link runCommand} prints the withheld NAMES when it echoes.
 */
export function sanitizeEnvironment(
  extra?: Readonly<Record<string, string>>,
): SanitizedEnvironment {
  const env: Record<string, string> = {};
  const withheld: WithheldEnvVar[] = [];
  for (const name of INHERITED_ENV_NAMES) {
    const value = process.env[name];
    if (value === undefined) {
      continue;
    }
    const reason = withholdReason(name, value, 'inherited');
    if (reason === undefined) {
      env[name] = value;
    } else {
      withheld.push({ name, origin: 'inherited', reason });
    }
  }
  env.FORCE_COLOR = '0';
  env.NO_COLOR = '1';
  for (const [name, value] of Object.entries(extra ?? {})) {
    const reason = withholdReason(name, value, 'requested');
    if (reason === undefined) {
      env[name] = value;
    } else {
      withheld.push({ name, origin: 'requested', reason });
    }
  }
  return { env, withheld };
}

/** Why `name=value` must not reach a child, or `undefined` when it may. */
function withholdReason(
  name: string,
  value: string,
  origin: EnvOrigin,
): EnvWithholdReason | undefined {
  const upper = name.toUpperCase();
  if (
    BLOCKED_ENV_NAMES.has(upper) ||
    BLOCKED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  ) {
    return 'blocked-name';
  }
  if (SENSITIVE_NAME_PATTERN.test(name)) {
    return 'sensitive-name';
  }
  if (CREDENTIAL_VALUE_SHAPES.some((shape) => shape.test(value))) {
    return 'credential-value';
  }
  if (origin === 'inherited' && URL_WITH_PASSWORD_SHAPE.test(value)) {
    return 'credential-value';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// runCommand — the streamed, bounded, heartbeating runner
// ---------------------------------------------------------------------------

/** Which pipe a line arrived on. */
export type OutputStream = 'stdout' | 'stderr';

/** Options of {@link runCommand}. */
export interface RunCommandOptions {
  /** Absolute working directory of the child. Required: nothing here defaults to `process.cwd()`. */
  cwd: string;
  /** Hard budget; pass one of the exported `*_TIMEOUT_MS` constants. */
  timeoutMs: number;
  /** Deliberate environment values, merged by {@link sanitizedEnv} after its strips. */
  env?: Readonly<Record<string, string>> | undefined;
  /** Prefix of every echoed line and heartbeat; defaults to the command's base name. */
  label?: string | undefined;
  /** Receives every complete output line (without its terminator) as it arrives. */
  onLine?: ((line: string, stream: OutputStream) => void) | undefined;
  /** Echo lines to `process.stdout`, prefixed with the label. Defaults to `true`. */
  echo?: boolean | undefined;
  /** Output kept in memory across stdout, stderr and the interleaved stream; see {@link DEFAULT_MAX_CAPTURED_BYTES}. */
  maxCapturedBytes?: number | undefined;
  /** Reject with a {@link CommandFailedError} unless the command exits 0 within its budget. */
  expectSuccess?: boolean | undefined;
  /** Heartbeat cadence; defaults to {@link HEARTBEAT_INTERVAL_MS}. */
  heartbeatIntervalMs?: number | undefined;
}

/** What a finished (or abandoned) command left behind. */
export interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Exit code, or `null` when the child was ended by a signal or never started. */
  readonly code: number | null;
  /** The signal that ended the child, if any. */
  readonly signal: NodeJS.Signals | null;
  /** The exact stdout text (head and tail kept, the middle marked, beyond the budget). */
  readonly stdout: string;
  /** The exact stderr text, bounded like `stdout`. */
  readonly stderr: string;
  /** Both streams line by line in arrival order, plus this runner's own notes (timeout, spawn failure). */
  readonly combined: string;
  /** True when any of the three texts dropped output to stay inside the budget. */
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** `code === 0 && !timedOut`. */
  readonly ok: boolean;
  /** Why the child could not be started (`spawn pnpm ENOENT`), or `null` when it started. */
  readonly spawnError: string | null;
  /** Names of the variables {@link sanitizedEnv} kept from this child — names only. */
  readonly envWithheld: readonly string[];
}

/**
 * The error {@link runCommand} rejects with under `expectSuccess`. Its message names the
 * command, arguments, working directory, outcome, elapsed time and the last
 * {@link FAILURE_TAIL_LINES} output lines, so a CI failure is diagnosable from the message
 * alone; it never includes the environment. The full {@link CommandResult} rides along.
 */
export class CommandFailedError extends Error {
  /**
   * The full result. Non-enumerable, so a reporter or `util.inspect` that prints an error's own
   * properties shows the bounded message rather than megabytes of captured output.
   */
  declare readonly result: CommandResult;

  constructor(result: CommandResult) {
    super(describeFailure(result));
    this.name = 'CommandFailedError';
    Object.defineProperty(this, 'result', { value: result, enumerable: false, writable: false });
  }
}

/**
 * Run `command` with `args` — never through a shell — and resolve with everything it printed.
 *
 * - `shell: false` always, `stdin` ignored, both pipes decoded incrementally and split into
 *   lines for `onLine` and the label-prefixed echo; a trailing partial line is flushed at close.
 * - Memory is bounded by `maxCapturedBytes`: past it, head and tail are kept and a single
 *   `… output truncated …` marker replaces the middle.
 * - A heartbeat line `[label] still running — <s>s, <n> lines` is printed every
 *   `HEARTBEAT_INTERVAL_MS`, whether the child is chatty or silent.
 * - After `timeoutMs` the child's process group gets SIGTERM, then SIGKILL after
 *   {@link TERMINATION_GRACE_MS}; the result reports `timedOut: true`.
 * - On POSIX the child leads its own process group, so termination reaches the processes it
 *   started (pnpm's scripts, tsc, next build); descendants still holding the pipes after the
 *   child itself exited are ended too, and every live child is killed if this process exits.
 *   No timer, output listener or child outlives the returned promise.
 *
 * @throws Synchronously-invalid options (relative `cwd`, a non-positive budget) and, under
 *   `expectSuccess`, a {@link CommandFailedError}. A throwing `onLine` rejects the promise
 *   once the child has finished.
 */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const settings = await validateRunOptions(command, args, options);
  const { env, withheld } = sanitizeEnvironment(options.env);
  const envWithheld = withheld.map((entry) => entry.name);
  const argv = [...args];
  const { label, echo } = settings;

  const stdoutText = new BoundedText(settings.maxCapturedBytes / 4);
  const stderrText = new BoundedText(settings.maxCapturedBytes / 4);
  const combinedText = new BoundedText(settings.maxCapturedBytes / 2);
  let lineCount = 0;
  let callbackError: unknown;

  const print = (line: string): void => {
    process.stdout.write(`[${label}] ${line}\n`);
  };
  const note = (line: string): void => {
    combinedText.append(`[runCommand] ${line}\n`);
    if (echo) {
      print(line);
    }
  };
  const emitLine = (line: string, stream: OutputStream): void => {
    lineCount += 1;
    combinedText.append(`${line}\n`);
    if (echo) {
      print(line);
    }
    if (options.onLine !== undefined && callbackError === undefined) {
      try {
        options.onLine(line, stream);
      } catch (error) {
        // Remembered and re-raised once the child has finished; later lines skip the callback.
        callbackError = error;
      }
    }
  };

  if (echo) {
    print(`$ ${formatCommandLine(command, argv)}  (cwd: ${settings.cwd})`);
    if (envWithheld.length > 0) {
      print(`environment: withheld ${envWithheld.join(', ')} (sanitizedEnv policy; names only)`);
    }
  }

  const started = performance.now();
  const result = await new Promise<Omit<CommandResult, 'ok' | 'truncated'>>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, argv, {
        cwd: settings.cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: USE_PROCESS_GROUPS,
        windowsHide: true,
      });
    } catch (error) {
      const spawnError = describeError(error);
      note(`could not start: ${spawnError}`);
      resolve({
        command,
        args: argv,
        cwd: settings.cwd,
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        combined: combinedText.toString(),
        durationMs: performance.now() - started,
        timedOut: false,
        spawnError,
        envWithheld,
      });
      return;
    }
    trackChild(child);

    const splitters: Record<OutputStream, LineSplitter> = {
      stdout: new LineSplitter(),
      stderr: new LineSplitter(),
    };
    const decoders: Record<OutputStream, StringDecoder> = {
      stdout: new StringDecoder('utf8'),
      stderr: new StringDecoder('utf8'),
    };
    const raw: Record<OutputStream, BoundedText> = { stdout: stdoutText, stderr: stderrText };
    const consume = (stream: OutputStream, text: string, final: boolean): void => {
      raw[stream].append(text);
      const lines = final ? splitters[stream].end(text) : splitters[stream].push(text);
      for (const line of lines) {
        emitLine(line, stream);
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      consume('stdout', decoders.stdout.write(chunk), false);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      consume('stderr', decoders.stderr.write(chunk), false);
    });

    let settled = false;
    let timedOut = false;
    let spawnError: string | null = null;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (delayMs: number, action: () => void): void => {
      if (settled) {
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        action();
      }, delayMs);
      timers.add(timer);
    };
    const heartbeat = setInterval(() => {
      const seconds = Math.round((performance.now() - started) / 1000);
      print(`still running — ${String(seconds)}s, ${String(lineCount)} lines`);
    }, settings.heartbeatIntervalMs);

    const signal = (name: NodeJS.Signals): void => {
      const failure = signalChildTree(child, name);
      if (failure !== null) {
        note(`could not send ${name}: ${failure}`);
      }
    };

    const settle = (code: number | null, signalName: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        consume('stdout', decoders.stdout.end(), true);
        consume('stderr', decoders.stderr.end(), true);
      } finally {
        clearInterval(heartbeat);
        for (const timer of timers) {
          clearTimeout(timer);
        }
        timers.clear();
        // 'exit' and 'close' are done with; the guarded 'error' listener stays attached so a
        // late failure to signal the child can never surface as an unhandled 'error' event.
        child.removeAllListeners('exit');
        child.removeAllListeners('close');
        child.stdout?.removeAllListeners('data');
        child.stderr?.removeAllListeners('data');
        child.stdout?.destroy();
        child.stderr?.destroy();
        untrackChild(child);
      }
      const durationMs = performance.now() - started;
      if (echo) {
        print(
          `${describeOutcome(code, signalName, timedOut, spawnError)} after ${formatSeconds(durationMs)}`,
        );
      }
      resolve({
        command,
        args: argv,
        cwd: settings.cwd,
        code,
        signal: signalName,
        stdout: stdoutText.toString(),
        stderr: stderrText.toString(),
        combined: combinedText.toString(),
        durationMs,
        timedOut,
        spawnError,
        envWithheld,
      });
    };

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      if (child.pid === undefined) {
        // The child never started (ENOENT, EACCES): no 'close' is guaranteed to follow.
        spawnError = describeError(error);
        note(`could not start: ${spawnError}${spawnHint(command, error)}`);
        settle(null, null);
      } else {
        note(`child process error: ${describeError(error)}`);
      }
    });
    child.on('exit', (code, signalName) => {
      exitCode = code;
      exitSignal = signalName;
      // 'close' follows once both pipes are drained. A descendant that outlived the child and
      // still holds a pipe would keep it open forever; after the grace it is ended instead.
      later(TERMINATION_GRACE_MS, () => {
        note('output pipes stayed open after the command exited; ending leftover descendants');
        signal('SIGKILL');
        settle(exitCode, exitSignal);
      });
    });
    child.on('close', (code, signalName) => {
      settle(code ?? exitCode, signalName ?? exitSignal);
    });

    later(settings.timeoutMs, () => {
      timedOut = true;
      note(`timed out after ${formatSeconds(settings.timeoutMs)}; sending SIGTERM`);
      signal('SIGTERM');
      later(TERMINATION_GRACE_MS, () => {
        note(`still alive ${formatSeconds(TERMINATION_GRACE_MS)} after SIGTERM; sending SIGKILL`);
        signal('SIGKILL');
        later(TERMINATION_GRACE_MS, () => {
          note('no exit reported after SIGKILL; abandoning the child');
          settle(exitCode, exitSignal);
        });
      });
    });
  });

  const truncated = stdoutText.truncated || stderrText.truncated || combinedText.truncated;
  const finished: CommandResult = {
    ...result,
    truncated,
    ok: result.code === 0 && !result.timedOut,
  };
  if (callbackError !== undefined) {
    throw new Error(
      `runCommand(): the onLine callback for ${formatCommandLine(command, argv)} threw: ${describeError(callbackError)}`,
      { cause: callbackError },
    );
  }
  if (settings.expectSuccess && !finished.ok) {
    throw new CommandFailedError(finished);
  }
  return finished;
}

// ---------------------------------------------------------------------------
// pnpm
// ---------------------------------------------------------------------------

/**
 * The pnpm executable the suite runs: `DEBUGGEN_E2E_PNPM` when set (an empty value counts as
 * unset), else `pnpm` from `PATH` — the corepack shim locally, `pnpm/action-setup`'s binary in
 * CI. Set the override where no shim is on `PATH`, or on Windows, where Node refuses to spawn
 * the `pnpm.cmd` wrapper without a shell: point it at a native executable or at pnpm's
 * JavaScript entry (`pnpm.cjs`), which {@link runPnpm} then runs with the current Node.
 */
export function pnpmBin(): string {
  const override = process.env.DEBUGGEN_E2E_PNPM?.trim();
  return override === undefined || override === '' ? 'pnpm' : override;
}

/**
 * Run pnpm with `args` through {@link runCommand}. This is how `demo-app.ts` invokes the ROOT
 * scripts `demo:migrate` / `demo:seed` by name instead of re-implementing Prisma commands, and
 * how `clean-clone.spec.ts` runs `install`, `build` and `typecheck`.
 */
export function runPnpm(
  args: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const bin = pnpmBin();
  const label = options.label ?? ['pnpm', ...args.slice(0, 1)].join(' ');
  if (/\.[cm]?js$/i.test(bin)) {
    return runCommand(process.execPath, [bin, ...args], { ...options, label });
  }
  return runCommand(bin, args, { ...options, label });
}

// ---------------------------------------------------------------------------
// git — the single entry point of tests/e2e/helpers
// ---------------------------------------------------------------------------

/**
 * Git subcommands {@link runGit} refuses because their output (or effect) can carry the
 * `origin` URL, which embeds a live access token, or reaches the network: none of them is
 * needed to enumerate or inspect a working tree.
 */
const REFUSED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'remote',
  'config',
  'ls-remote',
  'credential',
  'credential-cache',
  'credential-store',
  'fetch',
  'pull',
  'push',
  'clone',
  'submodule',
  'bundle',
]);

/** Global git options that consume the following argument. */
const GIT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
]);

/** Options of {@link runGit}. */
export interface RunGitOptions {
  /** Defaults to {@link repoRoot}. */
  cwd?: string | undefined;
  /** Defaults to {@link GIT_COMMAND_TIMEOUT_MS}. */
  timeoutMs?: number | undefined;
  /** Output budget; raise it for listings (see {@link listTrackedFiles}). */
  maxCapturedBytes?: number | undefined;
  /** Reject unless git exits 0. Defaults to `false`, like {@link runCommand}. */
  expectSuccess?: boolean | undefined;
}

/**
 * Run `git` with `args`: a thin {@link runCommand} wrapper defaulting `cwd` to
 * {@link repoRoot} and `timeoutMs` to {@link GIT_COMMAND_TIMEOUT_MS}, with `echo: false` (git
 * output is paths, and a spec decides what of it to report). `demo-app.ts` and `sample-app.ts`
 * call this rather than forking their own git runner.
 *
 * The child runs with `GIT_TERMINAL_PROMPT=0` (nothing may block on a credential prompt) and
 * `GIT_OPTIONAL_LOCKS=0` (a `git status` must not write an index refresh while the product may
 * be touching the same tree). Git reads `.git/` itself, as it must; this module never does.
 *
 * @throws When `args` name a subcommand that can print the remote configuration.
 */
export function runGit(args: readonly string[], options?: RunGitOptions): Promise<CommandResult> {
  const subcommand = gitSubcommand(args);
  if (subcommand !== undefined && REFUSED_GIT_SUBCOMMANDS.has(subcommand)) {
    return Promise.reject(
      new Error(
        `runGit(): \`git ${subcommand}\` is refused — its output can carry the origin URL, which embeds an access token (AAP 0.2.1). Enumerate the tree with \`git ls-files -z\` instead.`,
      ),
    );
  }
  return runCommand('git', args, {
    cwd: options?.cwd ?? repoRoot(),
    timeoutMs: options?.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    label: 'git',
    echo: false,
    maxCapturedBytes: options?.maxCapturedBytes,
    expectSuccess: options?.expectSuccess,
  });
}

/** The first non-option argument of a git invocation, skipping global options and their values. */
function gitSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      return undefined;
    }
    if (GIT_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith('-')) {
      return arg;
    }
  }
  return undefined;
}

/**
 * The repository's tracked paths — POSIX, repository-relative, de-duplicated and sorted —
 * optionally limited to `relDir`. Runs `git ls-files -z -- [relDir]` from {@link repoRoot};
 * this is the enumerator `demo-app.ts` and `sample-app.ts` hash for their restoration
 * snapshots.
 *
 * Tracked paths only: `node_modules/`, `dist/`, `.next/`, `.tsbuild/`, the generated Prisma
 * client and every untracked `.env` are excluded structurally, without a filter list to keep in
 * sync with `.gitignore`. It asks git; it never reads `.git/`.
 *
 * @param relDir A repository-relative directory (POSIX or native separators), e.g. `'apps/demo-app'`.
 * @throws When git fails, when its listing exceeds the budget, or when it returns a path that
 *   is absolute, names `.git`, or escapes the repository — none of which a sound checkout yields.
 */
export async function listTrackedFiles(relDir?: string): Promise<string[]> {
  const scope = relDir === undefined ? undefined : normalizeRelativeDir(relDir);
  const result = await runGit(['ls-files', '-z', '--', ...(scope === undefined ? [] : [scope])], {
    maxCapturedBytes: MAX_TRACKED_LISTING_BYTES,
    expectSuccess: true,
  });
  if (result.truncated) {
    throw new Error(
      `listTrackedFiles(): \`git ls-files\` printed more than ${String(MAX_TRACKED_LISTING_BYTES)} bytes; refusing to work from a truncated listing.`,
    );
  }
  const unique = new Set<string>();
  for (const entry of result.stdout.split('\0')) {
    if (entry === '') {
      continue;
    }
    unique.add(assertSafeTrackedPath(entry));
  }
  return [...unique].sort(compareCodeUnits);
}

/** Normalise and validate the `relDir` argument of {@link listTrackedFiles}. */
function normalizeRelativeDir(relDir: string): string | undefined {
  const posix = relDir.split(path.sep).join('/').trim();
  if (posix === '' || posix === '.' || posix === './') {
    return undefined;
  }
  if (path.posix.isAbsolute(posix) || path.isAbsolute(relDir)) {
    throw new Error(`listTrackedFiles(): ${JSON.stringify(relDir)} must be repository-relative.`);
  }
  const normalized = path.posix.normalize(posix).replace(/\/+$/, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`listTrackedFiles(): ${JSON.stringify(relDir)} escapes the repository.`);
  }
  if (hasGitSegment(normalized)) {
    throw new Error(
      `listTrackedFiles(): ${JSON.stringify(relDir)} names .git, which is never listed.`,
    );
  }
  return normalized;
}

/** A tracked path as git printed it, proven relative, inside the repository and `.git`-free. */
function assertSafeTrackedPath(entry: string): string {
  const posix = entry.split('\\').join('/');
  const normalized = path.posix.normalize(posix);
  const reject = (why: string): never => {
    throw new Error(
      `listTrackedFiles(): git returned ${JSON.stringify(entry)}, which ${why}; refusing to use the listing.`,
    );
  };
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    return reject('is absolute');
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.') {
    return reject('escapes the repository');
  }
  if (hasGitSegment(normalized)) {
    return reject('lies under .git');
  }
  return normalized;
}

function hasGitSegment(posixPath: string): boolean {
  return posixPath.split('/').some((segment) => segment.toLowerCase() === '.git');
}

// ---------------------------------------------------------------------------
// copyTrackedTree — a .git-free copy of the working tree
// ---------------------------------------------------------------------------

/** Options of {@link copyTrackedTree}. */
export interface CopyTrackedTreeOptions {
  /** Keep only the tracked paths (POSIX, repository-relative) this returns `true` for. */
  include?: ((relPath: string) => boolean) | undefined;
  /** Prefix of the one summary line printed; defaults to `copy`. */
  label?: string | undefined;
}

/** What {@link copyTrackedTree} copied. */
export interface CopyTrackedTreeResult {
  /** The absolute destination. */
  readonly dest: string;
  /** Copied paths, POSIX and repository-relative, sorted. */
  readonly files: string[];
  /** Total bytes copied. */
  readonly bytes: number;
  /** Tracked paths absent from the working tree (a staged deletion), skipped and counted. */
  readonly missing: readonly string[];
}

/**
 * Copy the working-tree content of every tracked file into `dest` — the state a fresh checkout
 * would start from, minus the repository metadata.
 *
 * **No `.git` is ever created in `dest` and nothing under `.git/` is ever copied.** That is the
 * whole point of enumerating with `git ls-files` instead of copying the directory: the
 * repository's `origin` URL in `.git/config` embeds a live access token (AAP 0.2.1), and a copy
 * that carried it could leak it into build logs, caches or artifacts. The copy is verified
 * `.git`-free before this resolves.
 *
 * Guarantees:
 * - `dest` must be absolute, must lie outside {@link repoRoot} (compared by real path, so a
 *   symlink cannot smuggle it inside), and must be empty or absent; it is created if absent.
 *   Nothing is ever written anywhere else — in particular not into the checkout.
 * - Bytes are copied verbatim (no text or line-ending transformation); the destination mode is
 *   `0o755` when the source has any execute bit and `0o644` otherwise. A tracked symbolic link
 *   is recreated as a link with the same target.
 * - Every destination path is proven to stay under `dest`, lexically and by the real path of
 *   its parent directory, before it is written.
 * - A tracked path missing from the working tree is skipped and reported in `missing`.
 *
 * The caller owns `dest` and its removal; create it under `os.tmpdir()`.
 */
export async function copyTrackedTree(
  dest: string,
  options?: CopyTrackedTreeOptions,
): Promise<CopyTrackedTreeResult> {
  const label = options?.label ?? 'copy';
  const root = repoRoot();
  if (!path.isAbsolute(dest)) {
    throw new Error(
      `copyTrackedTree(): the destination ${JSON.stringify(dest)} must be an absolute path (create it with fs.mkdtemp under os.tmpdir()).`,
    );
  }
  const target = path.resolve(dest);
  await assertOutsideRepository(target, root);
  await prepareEmptyDirectory(target);
  const realTarget = await realpath(target);
  // Re-checked on the created directory: the pre-creation check resolved missing components
  // lexically, and this is the path every write below is compared against.
  await assertOutsideRepository(realTarget, root);

  const tracked = await listTrackedFiles();
  const selected = options?.include === undefined ? tracked : tracked.filter(options.include);
  const copied: string[] = [];
  const missing: string[] = [];
  let bytes = 0;
  const verifiedDirectories = new Map<string, Promise<void>>();
  const ensureDirectory = (directory: string): Promise<void> => {
    let pending = verifiedDirectories.get(directory);
    if (pending === undefined) {
      pending = (async () => {
        await mkdir(directory, { recursive: true });
        const real = await realpath(directory);
        if (!isPathInside(real, realTarget)) {
          throw new Error(
            `copyTrackedTree(): ${directory} resolves to ${real}, outside the destination ${realTarget}; refusing to write through it.`,
          );
        }
      })();
      verifiedDirectories.set(directory, pending);
    }
    return pending;
  };

  await forEachWithConcurrency(selected, COPY_CONCURRENCY, async (relPath) => {
    const segments = relPath.split('/');
    const source = path.join(root, ...segments);
    const destination = path.resolve(target, ...segments);
    if (destination === target || !isPathInside(destination, target)) {
      throw new Error(
        `copyTrackedTree(): ${JSON.stringify(relPath)} would be written to ${destination}, outside ${target}.`,
      );
    }
    let info: Stats;
    try {
      info = await lstat(source);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
        missing.push(relPath);
        return;
      }
      throw error;
    }
    await ensureDirectory(path.dirname(destination));
    if (info.isSymbolicLink()) {
      const linkTarget = await readlink(source);
      const resolvedLink = path.resolve(path.dirname(destination), linkTarget);
      if (path.isAbsolute(linkTarget) || !isPathInside(resolvedLink, target)) {
        throw new Error(
          `copyTrackedTree(): tracked symbolic link ${JSON.stringify(relPath)} points outside the copied tree; a build following it could write into the checkout, so it is refused.`,
        );
      }
      await symlink(linkTarget, destination);
    } else if (info.isFile()) {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      await chmod(destination, (info.mode & 0o111) !== 0 ? 0o755 : 0o644);
      bytes += info.size;
    } else {
      // A gitlink (submodule) is listed as a path but is a directory holding its own `.git`
      // pointer; copying it would carry repository metadata, so it is refused outright.
      throw new Error(
        `copyTrackedTree(): tracked path ${JSON.stringify(relPath)} is neither a file nor a symbolic link (a submodule?); refusing to copy it.`,
      );
    }
    copied.push(relPath);
  });

  if (await pathExists(path.join(target, '.git'))) {
    throw new Error(
      `copyTrackedTree(): ${path.join(target, '.git')} exists after the copy; the destination must never carry repository metadata.`,
    );
  }
  copied.sort(compareCodeUnits);
  missing.sort(compareCodeUnits);
  process.stdout.write(
    `[${label}] copied ${String(copied.length)} tracked files (${formatBytes(bytes)}) into ${target}` +
      (missing.length === 0
        ? '\n'
        : `; skipped ${String(missing.length)} tracked path(s) missing from the working tree\n`),
  );
  return { dest: target, files: copied, bytes, missing };
}

/** Throw unless `candidate` (resolved through its nearest existing ancestor) is outside `root`. */
async function assertOutsideRepository(candidate: string, root: string): Promise<void> {
  const real = await realPathAllowingMissing(candidate);
  if (isPathInside(real, root)) {
    throw new Error(
      `copyTrackedTree(): the destination ${candidate} (real path ${real}) is inside the repository ${root}; copy into a directory under os.tmpdir() instead, so the working tree is never written.`,
    );
  }
  if (isPathInside(root, real)) {
    throw new Error(
      `copyTrackedTree(): the destination ${candidate} (real path ${real}) contains the repository ${root}; use a fresh directory under os.tmpdir().`,
    );
  }
}

/** Create `directory` when absent; otherwise require an empty, real (non-symlink) directory. */
async function prepareEmptyDirectory(directory: string): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
    await mkdir(directory, { recursive: true });
    return;
  }
  if (!info.isDirectory()) {
    throw new Error(
      `copyTrackedTree(): the destination ${directory} exists and is not a directory${info.isSymbolicLink() ? ' (it is a symbolic link)' : ''}; pass a fresh directory from fs.mkdtemp.`,
    );
  }
  const entries = await readdir(directory);
  if (entries.length > 0) {
    throw new Error(
      `copyTrackedTree(): the destination ${directory} is not empty (${String(entries.length)} entries); pass a fresh directory from fs.mkdtemp so no earlier copy can leak into this one.`,
    );
  }
}

/**
 * The real path of `target`, resolving its nearest existing ancestor and appending the
 * components that do not exist yet — so containment can be checked before anything is created.
 */
async function realPathAllowingMissing(target: string): Promise<string> {
  const pendingComponents: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = await realpath(current);
      return path.join(real, ...pendingComponents.reverse());
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'ENOTDIR')) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      pendingComponents.push(path.basename(current));
      current = parent;
    }
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Every started task is awaited before
 * the first failure is re-thrown, so no copy is still writing when the caller sees the error.
 */
async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        try {
          await worker(item);
        } catch (error) {
          // Stop every lane from taking new work; the error itself is re-thrown below.
          failed = true;
          throw error;
        }
      }
    }
  });
  const outcomes = await Promise.allSettled(lanes);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      throw outcome.reason;
    }
  }
}

// ---------------------------------------------------------------------------
// Child-process bookkeeping
// ---------------------------------------------------------------------------

/**
 * On POSIX every child leads its own process group (`detached: true`), so a signal reaches
 * the processes it started as well — pnpm runs scripts, scripts run tsc and next — exactly as
 * `tests/browser/fixtures.ts` terminates what it spawns. The group is this module's own: its
 * id is the child's pid, and nothing outside the child's descendants is ever in it. Windows has
 * no such groups; there the child is signalled directly.
 */
const USE_PROCESS_GROUPS = process.platform !== 'win32';

/** Children started by {@link runCommand} that have not settled yet. */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/**
 * Track a child until it settles. The first call installs one `exit` hook that SIGKILLs every
 * live child's group, so a worker that ends mid-command (a Playwright timeout, Ctrl-C) leaves
 * no detached install or build running behind it. Installed lazily: importing this module has
 * no side effect.
 */
function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const live of liveChildren) {
        signalChildTree(live, 'SIGKILL');
      }
      liveChildren.clear();
    });
  }
}

function untrackChild(child: ChildProcess): void {
  liveChildren.delete(child);
}

/**
 * Send `signal` to the child's process group (POSIX) or the child itself (Windows).
 *
 * @returns `null` when the signal was delivered or nothing was left to receive it (`ESRCH`),
 *   otherwise a description of why it could not be sent.
 */
function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): string | null {
  const pid = child.pid;
  if (pid === undefined) {
    return null;
  }
  if (USE_PROCESS_GROUPS) {
    try {
      process.kill(-pid, signal);
      return null;
    } catch (error) {
      if (!hasErrorCode(error, 'ESRCH')) {
        return describeError(error);
      }
      // The group is gone; the leader may still be a zombie awaiting reaping — fall through.
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return null;
  }
  try {
    child.kill(signal);
    return null;
  } catch (error) {
    return hasErrorCode(error, 'ESRCH') ? null : describeError(error);
  }
}

/** Validated, defaulted settings of one {@link runCommand} call. */
interface RunSettings {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly label: string;
  readonly echo: boolean;
  readonly maxCapturedBytes: number;
  readonly expectSuccess: boolean;
  readonly heartbeatIntervalMs: number;
}

async function validateRunOptions(
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<RunSettings> {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('runCommand(): the command must be a non-empty string.');
  }
  const badArg = args.findIndex((arg) => typeof arg !== 'string' || arg.includes('\0'));
  if (badArg >= 0) {
    throw new Error(
      `runCommand(): argument ${String(badArg)} of ${command} is not a string without NUL bytes.`,
    );
  }
  if (!path.isAbsolute(options.cwd)) {
    throw new Error(
      `runCommand(): cwd ${JSON.stringify(options.cwd)} must be absolute (use repoRoot()/repoPath()).`,
    );
  }
  const cwdInfo = await stat(options.cwd).catch((error: unknown) => {
    throw new Error(
      `runCommand(): cwd ${options.cwd} does not exist or cannot be read (${describeError(error)}).`,
      { cause: error },
    );
  });
  if (!cwdInfo.isDirectory()) {
    throw new Error(`runCommand(): cwd ${options.cwd} is not a directory.`);
  }
  const timeoutMs = requirePositive('timeoutMs', options.timeoutMs);
  const heartbeatIntervalMs = requirePositive(
    'heartbeatIntervalMs',
    options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
  );
  const maxCapturedBytes = options.maxCapturedBytes ?? DEFAULT_MAX_CAPTURED_BYTES;
  if (!Number.isSafeInteger(maxCapturedBytes) || maxCapturedBytes < 1024) {
    throw new Error(
      `runCommand(): maxCapturedBytes must be an integer of at least 1024 (got ${String(maxCapturedBytes)}).`,
    );
  }
  return {
    cwd: path.resolve(options.cwd),
    timeoutMs,
    label: options.label ?? path.basename(command),
    echo: options.echo !== false,
    maxCapturedBytes,
    expectSuccess: options.expectSuccess === true,
    heartbeatIntervalMs,
  };
}

function requirePositive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `runCommand(): ${name} must be a positive number of milliseconds no larger than ${String(MAX_TIMER_DELAY_MS)} (got ${String(value)}).`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

/**
 * Text kept within a byte budget: the first half of the budget as the head, the most recent
 * half as the tail, and one explicit marker in place of whatever was dropped between them.
 */
class BoundedText {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = '';
  private headBytes = 0;
  private headSealed = false;
  private readonly tail: string[] = [];
  private tailBytes = 0;
  private omittedBytes = 0;

  constructor(budgetBytes: number) {
    this.headLimit = Math.floor(budgetBytes / 2);
    this.tailLimit = Math.floor(budgetBytes / 2);
  }

  get truncated(): boolean {
    return this.omittedBytes > 0;
  }

  append(text: string): void {
    if (text === '') {
      return;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (!this.headSealed && this.headBytes + bytes <= this.headLimit) {
      this.head += text;
      this.headBytes += bytes;
      return;
    }
    this.headSealed = true;
    this.tail.push(text);
    this.tailBytes += bytes;
    while (this.tailBytes > this.tailLimit) {
      const first = this.tail[0];
      if (first === undefined) {
        break;
      }
      const firstBytes = Buffer.byteLength(first, 'utf8');
      const excess = this.tailBytes - this.tailLimit;
      if (firstBytes <= excess) {
        this.tail.shift();
        this.tailBytes -= firstBytes;
        this.omittedBytes += firstBytes;
      } else {
        // Drop the oldest `excess` bytes of the first chunk; a character split at this cut is
        // replaced by U+FFFD, which sits right after the truncation marker.
        const kept = Buffer.from(first, 'utf8').subarray(excess).toString('utf8');
        this.tail[0] = kept;
        this.tailBytes -= excess;
        this.omittedBytes += excess;
      }
    }
  }

  toString(): string {
    if (this.omittedBytes === 0) {
      return this.head + this.tail.join('');
    }
    const separator = this.head === '' || this.head.endsWith('\n') ? '' : '\n';
    return `${this.head}${separator}… output truncated: ${formatBytes(this.omittedBytes)} omitted …\n${this.tail.join('')}`;
  }
}

/** Incremental `\n` line splitting over decoded text; `\r\n` terminators are accepted too. */
class LineSplitter {
  private pending = '';

  push(text: string): string[] {
    this.pending += text;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    const lines = parts.map(stripCarriageReturn);
    if (this.pending.length > MAX_PENDING_LINE_CHARS) {
      // Output that never ends a line (a progress bar, NUL-separated data) is still surfaced.
      lines.push(this.pending);
      this.pending = '';
    }
    return lines;
  }

  end(text: string): string[] {
    const lines = this.push(text);
    if (this.pending !== '') {
      lines.push(stripCarriageReturn(this.pending));
      this.pending = '';
    }
    return lines;
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

// ---------------------------------------------------------------------------
// Formatting and small utilities
// ---------------------------------------------------------------------------

/** `pnpm install --frozen-lockfile`, quoting arguments that need it for readability. */
function formatCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((part) => (part === '' || /[\s"'\\$`]/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function describeOutcome(
  code: number | null,
  signal: NodeJS.Signals | null,
  timedOut: boolean,
  spawnError: string | null,
): string {
  if (spawnError !== null) {
    return `could not start (${spawnError})`;
  }
  const ending =
    code !== null
      ? `exited with code ${String(code)}`
      : signal !== null
        ? `ended by ${signal}`
        : 'ended without reporting an exit status';
  return timedOut ? `timed out (${ending})` : ending;
}

/** A hint appended to a spawn failure when the executable could not be found. */
function spawnHint(command: string, error: unknown): string {
  if (!hasErrorCode(error, 'ENOENT')) {
    return '';
  }
  const pnpmAdvice =
    path.basename(command).replace(/\.(exe|cmd)$/i, '') === 'pnpm'
      ? ' Enable corepack (`corepack enable`) or set DEBUGGEN_E2E_PNPM to the pnpm executable.'
      : '';
  return ` — is ${JSON.stringify(command)} installed and on PATH?${pnpmAdvice}`;
}

/** The message of a {@link CommandFailedError}: everything needed to diagnose it, no environment. */
function describeFailure(result: CommandResult): string {
  const lines = result.combined.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const tail = lines.slice(-FAILURE_TAIL_LINES);
  const header = [
    `Command failed: ${formatCommandLine(result.command, result.args)}`,
    `  cwd:     ${result.cwd}`,
    `  outcome: ${describeOutcome(result.code, result.signal, result.timedOut, result.spawnError)}`,
    `  elapsed: ${formatSeconds(result.durationMs)}`,
  ];
  if (result.envWithheld.length > 0) {
    header.push(`  environment withheld (names only): ${result.envWithheld.join(', ')}`);
  }
  const outputHeading =
    tail.length === 0
      ? '  output:  (none)'
      : `  output:  last ${String(tail.length)} of ${String(lines.length)} captured lines${result.truncated ? ' (capture was truncated)' : ''}:`;
  return [...header, outputHeading, ...tail.map((line) => `    | ${line}`)].join('\n');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : (JSON.stringify(error) ?? String(error));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `candidate` is `parent` or lies below it. Both are resolved first; on Windows the
 * comparison ignores case, as the file system does.
 */
function isPathInside(candidate: string, parent: string): boolean {
  const fold = (value: string): string =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(fold(parent), fold(candidate));
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Locale-independent ordering, so a sorted path list is identical on every machine. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
