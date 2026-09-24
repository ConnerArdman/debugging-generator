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
 * - **Exactly four variables (the named requirement).** A launched child's
 *   environment differs from the service's in `NODE_OPTIONS`,
 *   `DEBUGGEN_INGEST_URL`, `DEBUGGEN_TOKEN` and `DEBUGGEN_PROJECT_ROOT` and in
 *   nothing else. The delta is computed, and the expected key set is sourced
 *   from the module's own `PRELOAD_ENV_KEYS`, so the suite cannot drift from the
 *   contract it checks.
 * - **The token is a capability (invariant 2).** A `server-agent` credential
 *   (AAP §0.5.6) lives in the child's `DEBUGGEN_TOKEN` and nowhere else: not in
 *   `NODE_OPTIONS`, a log record, an error's message, hint or details, a
 *   registry record or a launch result. Child output that echoes it is
 *   scrubbed before it is logged or quoted in a hint.
 * - **Reversible by construction (AAP §0.5.1).** This path instruments through
 *   the environment only; the fixture project's directory is snapshotted
 *   before and after a full launch/stop cycle and must be byte-identical.
 * - **Graceful failure (AAP §0.5.5).** A missing preload, an un-preloaded
 *   server already on the port, a missing binary, an early exit and a
 *   readiness timeout each become a distinct typed `Err` with an actionable
 *   hint, and none leaves a live child or an unrevoked credential behind.
 *
 * Five habits in here are deliberate.
 *
 * 1. **No real dev server, no network, no child process.** Every launch drives
 *    the injected `SpawnLike` port with a `FakeChild`; detection, probing and
 *    the credential issuer are injected doubles. Nothing dials a socket or
 *    execs a binary, and no `signalProcessGroup` is injected, so a fake pid is
 *    never signalled for real.
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  HTTP_OPERATIONS,
  HTTP_ROUTES,
  buildPath,
  devServerLaunchResponseSchema,
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

import {
  buildRelaunchHint,
  detectDevServer,
  formatRelaunchCommand,
  packageManagerRunArgs,
} from './detect.js';
import type {
  DevScriptSelection,
  DevServerDetection,
  DevServerProbeResult,
  FetchLike,
  KnownPackageManagerId,
  ServerAgentPresence,
} from './detect.js';
import {
  DEFAULT_CLI_CREDENTIAL_TTL_MS,
  DEV_SERVER_CREDENTIAL_METHOD,
  DEV_SERVER_CREDENTIAL_PATH,
  PRELOAD_BUILD_COMMAND,
  PRELOAD_BUNDLED_RELATIVE_URL,
  PRELOAD_ENV_KEYS,
  PRELOAD_PACKAGE_SPECIFIER,
  PRELOAD_WORKSPACE_RELATIVE_PATH,
  appendNodeOptions,
  buildDevServerEnv,
  buildPreloadImportFlag,
  createDevServerLauncher,
  devServerCredentialRequestSchema,
  devServerCredentialResponseSchema,
  findCredentialRouteCollision,
  preloadPathCandidates,
  resolveIngestUrl,
  resolvePreloadPath,
  toDevServerLaunchResponse,
} from './launcher.js';
import type {
  ChildProcessLike,
  DevServerLaunchInput,
  DevServerLauncher,
  DevServerLauncherDeps,
  LaunchedDevServer,
  ManagedDevServerLaunch,
  ParentEnvironment,
  ServerAgentCredential,
  ServerAgentCredentialIssueInput,
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
  #exited = false;

  constructor(pid: number | undefined, plan: ChildPlan) {
    super();
    this.pid = pid;
    this.#exitsOn = new Set(plan.exitsOn ?? ['SIGTERM', 'SIGKILL']);
    this.#killThrows = plan.killThrows === true;
  }

  /** Whether the child has reported its exit. */
  get exited(): boolean {
    return this.#exited;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.#killThrows) {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }
    if (this.#exitsOn.has(signal)) {
      this.finish(null, signal);
    }
    return true;
  }

  /** Write `text` to one of the child's output streams, as bytes. */
  print(text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
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
type RevokeFn = ServerAgentCredentialIssuer['revoke'];
type DetectFn = NonNullable<DevServerLauncherDeps['detect']>;
type ProbeFn = NonNullable<DevServerLauncherDeps['probe']>;

/** A credential issuer double: planted tokens out, every call recorded. */
interface FakeIssuer {
  readonly credentials: ServerAgentCredentialIssuer;
  readonly issue: Mock<IssueFn>;
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
  const revoke = vi.fn<RevokeFn>(() => undefined);
  return { credentials: { issue, revoke }, issue, revoke, tokens };
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

/** A probe result for `url`: reachable (any HTTP status) or refused. */
function probeAnswer(url: string, reachable: boolean): Result<DevServerProbeResult, DebuggenError> {
  return ok(
    reachable
      ? { url, reachable: true, status: 200, durationMs: 3 }
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

// ---------------------------------------------------------------------------
// The launcher harness
// ---------------------------------------------------------------------------

/** Options of {@link createHarness}; every member optional. */
interface HarnessOptions {
  /** The facts the injected detection reports. Ignored when `detect` is given. */
  readonly detection?: DetectionFacts;
  /** A detection implementation to inject instead of the fact-driven double. */
  readonly detect?: DetectFn;
  /** The readiness probe. Default: every URL refuses — nothing ever dials a socket. */
  readonly probe?: ProbeFn;
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
    options.probe ?? ((url) => Promise.resolve(probeAnswer(url, false))),
  );
  const launcher = createDevServerLauncher({
    config: SERVICE_CONFIG,
    logger,
    credentials: issuer.credentials,
    parentEnv,
    spawnImpl: spawner.spawn,
    detect,
    probe,
    preloadPath,
    platform: POSIX,
    now: () => FIXED_NOW,
    readyTimeoutMs: 5_000,
    readyPollIntervalMs: 100,
    stopGraceMs: 1_000,
    ...options.deps,
  });
  launchers.push(launcher);
  return { launcher, projectRoot, preloadPath, spawner, issuer, detect, probe, records, parentEnv };
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
  child.print(`  ready - serving the app at ${origin}\n`);
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

  it('differs from the parent environment in exactly the four PRELOAD_ENV_KEYS', () => {
    const env = buildDevServerEnv(envInput());

    expect(INJECTED_KEYS).toHaveLength(4);
    expect(changedKeys(PARENT_ENV, env)).toEqual([...INJECTED_KEYS].sort());
    expect([...INJECTED_KEYS].sort()).toEqual([
      'DEBUGGEN_INGEST_URL',
      'DEBUGGEN_PROJECT_ROOT',
      'DEBUGGEN_TOKEN',
      'NODE_OPTIONS',
    ]);
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

  it('passes every other parent variable through untouched and drops undefined ones', () => {
    const env = buildDevServerEnv(envInput());

    expect(env['PATH']).toBe(PARENT_ENV['PATH']);
    expect(env['HOME']).toBe(PARENT_ENV['HOME']);
    expect(env['LANG']).toBe(PARENT_ENV['LANG']);
    expect(env['NODE_ENV']).toBe('development');
    expect(env['NEXT_OTEL_VERBOSE']).toBe('1');
    expect(Object.keys(env)).not.toContain('UNSET_BY_SHELL');
    expect(Object.values(env).every((value) => typeof value === 'string')).toBe(true);
  });

  it('never mutates the parent environment', () => {
    const parentEnv: Record<string, string | undefined> = { ...PARENT_ENV };
    const before = structuredClone(parentEnv);

    buildDevServerEnv(envInput({ parentEnv }));
    buildDevServerEnv(envInput({ parentEnv: Object.freeze({ ...PARENT_ENV }) }));

    expect(parentEnv).toStrictEqual(before);
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

// ---------------------------------------------------------------------------
// The locally owned credential route: POST /dev-server/credential
// ---------------------------------------------------------------------------

describe('the dev-server credential route contract', () => {
  it('owns the stable path POST /dev-server/credential', () => {
    expect(DEV_SERVER_CREDENTIAL_PATH).toBe('/dev-server/credential');
    expect(DEV_SERVER_CREDENTIAL_METHOD).toBe('POST');
  });

  // Ownership guard. `@debuggen/protocol`'s HTTP_ROUTES is the table of the
  // seventeen declared endpoints; the credential route is deliberately not one
  // of them — the folder brief makes this module its single owner, and
  // `../server/routes/dev-server.ts` registers it beside the two table-driven
  // dev-server operations. If the protocol table ever grows a route whose
  // pattern would also match this path, ownership becomes ambiguous; this
  // guard is what notices.
  it('is claimed by no protocol route', () => {
    expect(HTTP_OPERATIONS).toHaveLength(17);
    for (const operation of HTTP_OPERATIONS) {
      expect(HTTP_ROUTES[operation].pattern).not.toBe(DEV_SERVER_CREDENTIAL_PATH);
    }
    expect(findCredentialRouteCollision()).toBeUndefined();
  });

  it('detects a colliding route, including one matched through a :param segment', () => {
    expect(
      findCredentialRouteCollision([
        { operation: 'other.route', method: 'GET', pattern: '/dev-server/launch/:id' },
        { operation: 'devServer.any', method: 'GET', pattern: '/dev-server/:action' },
      ]),
    ).toBe('devServer.any');
    expect(
      findCredentialRouteCollision([
        { operation: 'devServer.launch', method: 'POST', pattern: '/dev-server/launch' },
      ]),
    ).toBeUndefined();
  });

  describe('devServerCredentialRequestSchema', () => {
    it('accepts an absolute project root', () => {
      expect(
        devServerCredentialRequestSchema.safeParse({ projectRoot: '/home/dev/atlas-console' })
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
      const parsed = devServerCredentialRequestSchema.safeParse(body);

      expect(parsed.success).toBe(false);
      const issues = JSON.stringify(parsed.error?.issues ?? []);
      expect(issues).not.toContain('relative-marker');
      expect(issues).not.toContain('4173');
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

  it('mints a credential scoped to exactly this project, with no expiry of its own', async () => {
    const harness = createHarness();

    await launchReady(harness);

    // AAP §0.5.6: scoped to one projectRoot; it expires when the child exits.
    expect(harness.issuer.issue.mock.calls).toStrictEqual([[{ projectRoot: harness.projectRoot }]]);
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

  it('uses a shell, and quotes arguments for it, only on Windows', async () => {
    const harness = createHarness({ deps: { platform: 'win32' } });

    await launchReady(harness, { command: 'node ./bin/serve.mjs --label "two words"' });

    const call = harness.spawner.call(0);
    expect(call.options.shell).toBe(true);
    expect(call.options.detached).toBe(false);
    expect(call.command).toBe('node');
    expect(call.args).toEqual(['./bin/serve.mjs', '--label', '"two words"']);
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

describe('DevServerLauncher.launch: readiness', () => {
  it('is ready at the first loopback address the child prints, skipping the service’s own port', async () => {
    const harness = createHarness();
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);

    // The ingest endpoint is a loopback URL too; it must never be taken for the dev server.
    child.print(`preload: reporting to ${resolveIngestUrl(SERVICE_CONFIG)}\n`);
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
    expect(harness.probe).not.toHaveBeenCalled();
    expect(harness.launcher.list()).toMatchObject([
      { status: 'ready', devServerUrl: 'http://localhost:4173/' },
    ]);
  });

  it('falls back to polling the requested URL when the child prints no address', async () => {
    vi.useFakeTimers();
    let probes = 0;
    const harness = createHarness({
      probe: (url) => {
        probes += 1;
        return Promise.resolve(probeAnswer(url, probes >= 3));
      },
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
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports an early exit with the scrubbed output tail, and revokes the credential', async () => {
    const harness = createHarness();
    const pending = harness.launcher.launch({ projectRoot: harness.projectRoot });
    const child = await spawnedChild(harness, pending);
    const token = harness.issuer.tokens[0] ?? '';

    child.print(`worker echoed credential ${token} before failing\n`, 'stderr');
    child.print('Error: listen EADDRINUSE: address already in use\n', 'stderr');
    child.finish(1, null);
    const error = expectErr(await pending, 'DEV_SERVER_LAUNCH_FAILED', 'exited-before-ready');

    const scrubbedLine = 'worker echoed credential [redacted] before failing';
    expect(error.message).toContain('code 1');
    expect(error.hint).toContain('Last output:');
    expect(error.hint).toContain(scrubbedLine);
    expect(error.hint).toContain('EADDRINUSE');
    expect(error.details?.['outputTail']).toEqual([
      scrubbedLine,
      'Error: listen EADDRINUSE: address already in use',
    ]);
    expect(errorSurfaces(error)).not.toContain(token);

    const outputLines = harness.records
      .filter((record) => record.message === 'dev-server output')
      .map((record) => record.fields['line']);
    expect(outputLines).toContain(scrubbedLine);
    expect(serializedRecords(harness.records)).not.toContain(token);

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
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve({ status: 200 }));
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
});

describe('DevServerLauncher.stopAll and dispose', () => {
  it('stopAll stops every child, is idempotent, and never throws', async () => {
    const harness = createHarness();
    await launchReady(harness);
    await launchReady(harness, { projectRoot: makeProject('second') }, 1, 'http://127.0.0.1:4174');

    await expect(harness.launcher.stopAll()).resolves.toBeUndefined();
    await expect(harness.launcher.stopAll()).resolves.toBeUndefined();

    expect(harness.spawner.children.map((child) => child.signals)).toEqual([
      ['SIGTERM'],
      ['SIGTERM'],
    ]);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(2);
    expect(harness.launcher.list()).toEqual([]);
  });

  it('stopAll settles even when a child has already vanished and kill throws', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ children: [{ killThrows: true }], deps: { stopGraceMs: 100 } });
    const { child } = await launchReady(harness);

    const stopping = harness.launcher.stopAll();
    // The grace period, then the bounded wait for an exit that never comes after SIGKILL.
    await vi.advanceTimersByTimeAsync(100 + 2_000);

    await expect(stopping).resolves.toBeUndefined();
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(harness.issuer.revoke).toHaveBeenCalledTimes(1);
    expect(harness.launcher.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    const stoppedRecord = harness.records.find(
      (record) => record.message === 'Stopped a launched dev server',
    );
    expect(stoppedRecord?.level).toBe('warn');
    expect(stoppedRecord?.fields).toMatchObject({ escalated: true, exitObserved: false });
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
    await expect(harness.launcher.stopAll()).resolves.toBeUndefined();
    await expect(harness.launcher.dispose()).resolves.toBeUndefined();
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
