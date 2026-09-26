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
 *   assignments, and `NODE_OPTIONS`, `DEBUGGEN_INGEST_URL`, `DEBUGGEN_TOKEN`
 *   and `DEBUGGEN_PROJECT_ROOT` — nothing else. The key set is computed from
 *   the module's own `PRELOAD_ENV_KEYS` and `isForwardedToDevServer`, so the
 *   suite cannot drift from the contract it checks, and a service environment
 *   holding the model-provider key and other service-only credentials proves
 *   none of them reaches the child.
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
 *
 * Five habits in here are deliberate.
 *
 * 1. **No real dev server, and no child process outside one suite.** Every
 *    launch drives the injected `SpawnLike` port with a `FakeChild`;
 *    detection, probing, listener ownership and the credential issuer are
 *    injected doubles. No launch dials a socket or execs a binary, and no
 *    `signalProcessGroup` is injected, so a fake pid is never signalled for
 *    real. The one exception is the Linux `createListenerOwnership` suite,
 *    which spawns `process.execPath` listeners bound to `127.0.0.1:0`, kills
 *    each one it spawned in `afterEach`, and gives every one a self-exit
 *    deadline besides.
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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
  DEFAULT_CLI_CREDENTIAL_TTL_MS,
  DEFAULT_LISTENER_LOOKUP_TIMEOUT_MS,
  DEFAULT_MANAGED_CREDENTIAL_LEASE_MS,
  DEFAULT_READY_PROBE_TIMEOUT_MS,
  DEV_SERVER_CREDENTIAL_METHOD,
  DEV_SERVER_CREDENTIAL_PATH,
  DEV_SERVER_ENV_ALLOWLIST,
  DEV_SERVER_OUTPUT_DIAGNOSTICS,
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
  createDevServerLauncher,
  createListenerOwnership,
  devServerCredentialInputSchema,
  devServerCredentialResponseSchema,
  diagnoseOutputLine,
  isForwardedToDevServer,
  preloadPathCandidates,
  resolveIngestUrl,
  resolvePreloadPath,
  resolveWindowsComSpec,
  serverAgentCredentialIssuer,
  toDevServerLaunchResponse,
} from './launcher.js';
import type {
  ChildProcessLike,
  DevServerLaunchInput,
  DevServerLauncher,
  DevServerLauncherDeps,
  DevServerOutputDiagnostic,
  LaunchedDevServer,
  ListenerOwnership,
  ListenerOwnershipCommandOptions,
  ListenerOwnershipCommandOutcome,
  ListenerOwnershipFs,
  ListenerOwnershipRunCommand,
  ManagedDevServerLaunch,
  ParentEnvironment,
  ServerAgentCredential,
  ServerAgentCredentialIssueInput,
  ServerAgentConnectionView,
  ServerAgentCredentialIssuer,
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
    const launchEnv = { FEATURE_FLAG: '1', APP_MODE: 'local' };

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
    expect(env['FEATURE_FLAG']).toBe('1');
    expect(env['APP_MODE']).toBe('local');
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

  it('forwards an explicit assignment whatever its name, replacing the inherited value', () => {
    const env = buildDevServerEnv(
      envInput({
        parentEnv: SERVICE_ENV,
        launchEnv: { FEATURE_FLAG: '1', PORT: '4174', DEBUGGEN_MODEL: 'assigned-model' },
      }),
    );

    expect(env['FEATURE_FLAG']).toBe('1');
    expect(env['PORT']).toBe('4174');
    // The developer's explicit assignment is the approved target-app environment.
    expect(env['DEBUGGEN_MODEL']).toBe('assigned-model');
  });

  it('lets an assigned NODE_OPTIONS replace the inherited one and still appends the preload', () => {
    const env = buildDevServerEnv(
      envInput({ launchEnv: { [PRELOAD_ENV_KEYS.nodeOptions]: '--trace-warnings' } }),
    );

    expect(env[PRELOAD_ENV_KEYS.nodeOptions]).toBe(
      `--trace-warnings ${buildPreloadImportFlag(preloadPath)}`,
    );
  });

  it('overwrites a DEBUGGEN_* wiring key even when the launch command assigns it', () => {
    const stale = fixtureCredential(98);

    const env = buildDevServerEnv(
      envInput({
        launchEnv: {
          [PRELOAD_ENV_KEYS.token]: stale,
          [PRELOAD_ENV_KEYS.ingestUrl]: 'http://127.0.0.1:1/elsewhere',
          [PRELOAD_ENV_KEYS.projectRoot]: '/somewhere/else',
        },
      }),
    );

    expect(env[PRELOAD_ENV_KEYS.token]).toBe(fixtureCredential(1));
    expect(env[PRELOAD_ENV_KEYS.ingestUrl]).toBe(ingestUrl);
    expect(env[PRELOAD_ENV_KEYS.projectRoot]).toBe(projectRoot);
    expect(JSON.stringify(env)).not.toContain(stale);
  });

  it('never mutates the parent environment or the launch assignments', () => {
    const parentEnv: Record<string, string | undefined> = { ...SERVICE_ENV };
    const launchEnv: Record<string, string> = { FEATURE_FLAG: '1', NODE_OPTIONS: '--inspect' };
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
        parentEnv: { Path: 'C:\\Windows', Node_Options: '--inspect' },
        launchEnv: { PATH: 'C:\\tools', node_options: '--trace-warnings' },
        platform: 'win32',
      }),
    );

    const pathKeys = Object.keys(env).filter((name) => name.toUpperCase() === 'PATH');
    expect(pathKeys).toEqual(['PATH']);
    expect(env['PATH']).toBe('C:\\tools');
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
        expiresAt: FIXED_NOW + DEFAULT_CLI_CREDENTIAL_TTL_MS,
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
  it('delegates to the issuer with exactly the requested project scope and a bounded expiry', async () => {
    const harness = createHarness();

    const issued = expectOk(
      await harness.launcher.issueCredential({ projectRoot: harness.projectRoot }),
    );

    const expiresAt = FIXED_NOW + DEFAULT_CLI_CREDENTIAL_TTL_MS;
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

  it('honours a configured credential lifetime', async () => {
    const harness = createHarness({ deps: { cliCredentialTtlMs: 90_000 } });

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

    await launchReady(harness, { command: 'FEATURE_FLAG=1 node ./bin/serve.mjs' });

    const { options } = harness.spawner.call(0);
    for (const name of SERVICE_ONLY_NAMES) {
      expect(Object.keys(options.env)).not.toContain(name);
    }
    for (const name of FORWARDED_NAMES) {
      expect(options.env[name]).toBe(SERVICE_ENV[name]);
    }
    expect(options.env['FEATURE_FLAG']).toBe('1');
    expect(JSON.stringify(options.env)).not.toContain(fixtureSecret('provider'));
    expect(options.env).toStrictEqual(
      buildDevServerEnv({
        parentEnv: SERVICE_ENV,
        launchEnv: { FEATURE_FLAG: '1' },
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

    await launchReady(harness, { command: 'node ./bin/serve.mjs --label "two words" --port 4173' });

    const call = harness.spawner.call(0);
    expect(call.command).toBe('node');
    expect(call.args).toEqual(['./bin/serve.mjs', '--label', 'two words', '--port', '4173']);
    expect(call.options.shell).toBe(false);
    expect(call.options.windowsVerbatimArguments).toBe(false);
    const record = harness.launcher.list()[0];
    expect(record?.command).toBe('node');
    expect(record).not.toHaveProperty('script');
  });

  it('applies leading NAME=value assignments to the child, appending to an assigned NODE_OPTIONS', async () => {
    const harness = createHarness();

    await launchReady(harness, {
      command: 'NODE_OPTIONS=--trace-warnings APP_MODE=local node ./bin/serve.mjs',
    });

    const { command, args, options } = harness.spawner.call(0);
    expect(command).toBe('node');
    expect(args).toEqual(['./bin/serve.mjs']);
    expect(options.env['APP_MODE']).toBe('local');
    expect(options.env[PRELOAD_ENV_KEYS.nodeOptions]).toBe(
      `--trace-warnings ${buildPreloadImportFlag(harness.preloadPath)}`,
    );
  });

  it('refuses an unquoted shell operator before minting a credential or spawning', async () => {
    const harness = createHarness();

    const result = await harness.launcher.launch({
      projectRoot: harness.projectRoot,
      command: 'node ./bin/serve.mjs && echo done',
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

    await launchReady(harness, { command: 'node ./bin/serve.mjs --label "two words"' });

    const call = harness.spawner.call(0);
    expect(call.command).toBe(WINDOWS_COMSPEC);
    expect(call.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""node" "./bin/serve.mjs" "--label" "two words""',
    ]);
    expect(call.options.shell).toBe(false);
    expect(call.options.windowsVerbatimArguments).toBe(true);
    expect(call.options.detached).toBe(false);
    expect(argvFromCmdInvocation(call.args)).toEqual([
      'node',
      './bin/serve.mjs',
      '--label',
      'two words',
    ]);
    // The registry names the developer's executable, not cmd.exe.
    expect(harness.launcher.list()[0]?.command).toBe('node');
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

  it('round-trips spaces, parentheses and trailing backslashes literally', async () => {
    const harness = windowsHarness();

    await launchReady(harness, {
      command:
        "'C:\\Program Files (x86)\\nodejs\\node.exe' 'C:\\work dir\\app\\' --root='D:\\data\\\\' plain",
    });

    const call = harness.spawner.call(0);
    expect(argvFromCmdInvocation(call.args)).toEqual([
      'C:\\Program Files (x86)\\nodejs\\node.exe',
      'C:\\work dir\\app\\',
      '--root=D:\\data\\\\',
      'plain',
    ]);
    expect(harness.launcher.list()[0]?.command).toBe('node.exe');
  });

  it('takes cmd.exe from the service environment, never from an assignment in the request', async () => {
    const harness = windowsHarness();

    await launchReady(harness, {
      command: "COMSPEC='C:\\elsewhere\\cmd.exe' node ./bin/serve.mjs",
    });

    const call = harness.spawner.call(0);
    expect(call.command).toBe(WINDOWS_COMSPEC);
    expect(argvFromCmdInvocation(call.args)).toEqual(['node', './bin/serve.mjs']);
  });

  it.each([
    { label: 'a %VAR% reference to the minted credential', word: `%${PRELOAD_ENV_KEYS.token}%` },
    { label: 'a delayed !VAR! expansion', word: '!PATH!' },
    { label: 'a double quote', word: 'a"b' },
    { label: 'a caret escape', word: 'x^y' },
    { label: 'an ampersand', word: 'a&b' },
    { label: 'a pipe', word: 'a|b' },
    { label: 'an input redirection', word: 'in<put' },
    { label: 'an output redirection', word: 'out>put' },
    { label: 'a carriage return', word: 'line\rbreak' },
    { label: 'a line feed', word: 'line\nbreak' },
  ])(
    'refuses $label before minting a credential or spawning, never echoing the word',
    async ({ word }) => {
      const harness = windowsHarness();

      const result = await harness.launcher.launch({
        projectRoot: harness.projectRoot,
        command: `node ./bin/serve.mjs '${word}'`,
      });

      const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'windows-shell-metacharacter');
      expect(error.message).toContain('argument 2');
      expect(error.hint).toContain('%VAR%');
      expect(error.hint).toContain('package.json script');
      expect(error.details).toStrictEqual({
        reason: 'windows-shell-metacharacter',
        position: 'argument',
        argument: 2,
      });
      expect(harness.issuer.issue).not.toHaveBeenCalled();
      expect(harness.spawner.spawn).not.toHaveBeenCalled();
      for (const surface of [
        error.message,
        error.hint ?? '',
        JSON.stringify(error.details),
        serializedRecords(harness.records),
      ]) {
        expect(containsWord(surface, word)).toBe(false);
      }
    },
  );

  it('refuses a metacharacter in the executable, naming only "the executable"', async () => {
    const harness = windowsHarness();

    const result = await harness.launcher.launch({
      projectRoot: harness.projectRoot,
      command: 'tool%PATH%.exe --serve',
    });

    const error = expectErr(result, 'DEV_SERVER_LAUNCH_FAILED', 'windows-shell-metacharacter');
    expect(error.message).toContain('the executable');
    expect(error.details).toStrictEqual({
      reason: 'windows-shell-metacharacter',
      position: 'executable',
    });
    expect(errorSurfaces(error)).not.toContain('tool%PATH%');
    expect(harness.issuer.issue).not.toHaveBeenCalled();
    expect(harness.spawner.spawn).not.toHaveBeenCalled();
  });

  it('leaves POSIX a direct spawn: the same characters are literal arguments there', async () => {
    const harness = createHarness();

    await launchReady(harness, { command: "node ./bin/serve.mjs '--label=100%' '!PATH!'" });

    const call = harness.spawner.call(0);
    expect(call.command).toBe('node');
    expect(call.args).toEqual(['./bin/serve.mjs', '--label=100%', '!PATH!']);
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

// ---------------------------------------------------------------------------
// Readiness verification: candidates → probe → ownership (INT-F30, INF-F16)
// ---------------------------------------------------------------------------

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
    { label: 'an explicit command', command: 'node ./bin/serve.mjs --port 4173' },
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
      { projectRoot: makeProject('second'), command: 'node ./bin/serve.mjs --port 4174' },
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

// ---------------------------------------------------------------------------
// createListenerOwnership: the operating system's answer (INT-F30, INF-F16)
// ---------------------------------------------------------------------------

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
