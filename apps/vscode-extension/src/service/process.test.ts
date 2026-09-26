/**
 * Tests for `./process.ts`: the embedded-service manager's log records carry
 * closed vocabularies and numbers only.
 *
 * The manager's logger is the one `src/extension.ts` prints, unredacted, into
 * the "Debug Generator" output, so three kinds of content must never reach a
 * record (CWE-532; AAP §0.5.2):
 *
 * - **A thrown value's text.** An ensure attempt that throws is returned as a
 *   failure with a fixed message naming a correlation reference, and logged
 *   under that reference by code, closed class and a known system or Node
 *   error code; an invented `code` in an errno-like shape is dropped.
 * - **A failure's message.** An early exit's failure is the child's own stderr
 *   report; it is logged by code, `details.reason` (from the module's closed
 *   `SERVICE_FAILURE_REASONS`), exit code and signal only.
 * - **The configured `debuggen.serviceUrl`.** It is logged as its validated
 *   loopback origin, or as `serviceUrlAccepted: false`, because a pasted URL
 *   can carry userinfo, a query credential or a private path.
 *
 * Every case drives the manager through its injected seams — probe, spawn,
 * settings reader, filesystem classification, credential port and output
 * channel — with a fake child built on a real `EventEmitter` and real
 * `PassThrough` pipes, and asserts that no sentinel appears in any record at
 * any level, rendered as JSON (what the output channel prints) and through
 * `util.inspect`.
 *
 * ## The `vscode` substitute
 *
 * The editor supplies the `vscode` module at runtime and no installable
 * package provides it, so `vi.mock` registers a factory for the bare
 * specifier. Every seam that would reach it is injected, so the substitute
 * only has to exist.
 *
 * The sentinels are assembled from fragments, so this tracked file carries no
 * contiguous credential shape for `pnpm check:secrets` to report.
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DebuggenError, createConsoleLogger, err, isErr, isOk, ok } from '@debuggen/shared';
import type { LogRecord } from '@debuggen/shared';

import { SERVICE_FAILURE_REASONS, createServiceProcess } from './process';
import type {
  ChildProcessLike,
  PathKind,
  ServiceCredentialPort,
  ServiceProcess,
  ServiceProcessDeps,
  ServiceProcessSettings,
} from './process';

vi.mock('vscode', () => ({
  window: { createOutputChannel: () => undefined },
  workspace: {
    getConfiguration: () => ({ get: () => undefined, inspect: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  },
}));

// ---------------------------------------------------------------------------
// Sentinels
// ---------------------------------------------------------------------------

/** A developer path, as a service start-up report or a thrown error quotes one. */
const SENTINEL_PATH = ['', 'home', 'sentinel-dev', 'private-project', '.debuggen', 'store'].join(
  '/',
);

/** A query credential pasted into the service URL. */
const SENTINEL_QUERY = ['token', ['sentinel', 'query', '7f3a9c'].join('-')].join('=');

/** A custom error name: free text the thrower chose. */
const SENTINEL_NAME = 'SentinelLeakyError';

/** The editor credential the fake store hands out. */
const EDITOR_TOKEN = ['editor', 'credential', 'sentinel', '5b1e'].join('_');

/** A service URL carrying userinfo and a query credential: refused, never logged. */
const USERINFO_URL = [
  'http://',
  ['sentinel-user', 'sentinel-pass'].join(':'),
  '@127.0.0.1:43117/?',
  SENTINEL_QUERY,
].join('');

/** A loopback service URL with a private path, a query credential and a fragment. */
const QUERY_URL = [
  'http://127.0.0.1:43117/sentinel-private/path?',
  SENTINEL_QUERY,
  '#sentinel',
].join('');

/** {@link QUERY_URL} on another port: what a changed setting names. */
const MOVED_QUERY_URL = QUERY_URL.replace(':43117', ':43118');

/** Every value a record must not contain; the last entry is their common stem. */
const SENTINELS: readonly string[] = [
  SENTINEL_PATH,
  SENTINEL_QUERY,
  SENTINEL_NAME,
  EDITOR_TOKEN,
  'sentinel-user',
  'sentinel-pass',
  'sentinel',
];

/** The fields the manager binds on every record it emits. */
const BOUND = Object.freeze({ subsystem: 'service-process' });

/** The text every planted message carries. */
function sentinelText(): string {
  return `could not open ${SENTINEL_PATH} for ${QUERY_URL}`;
}

/** An `Error` with a sentinel message, a custom (unlisted) name and a sentinel stack. */
function leakyError(): Error {
  const error = new Error(sentinelText());
  error.name = SENTINEL_NAME;
  error.stack = `${SENTINEL_NAME}: ${sentinelText()}\n    at sentinelFrame (${SENTINEL_PATH}:3:9)`;
  return error;
}

/** `error` with a `code` property, as Node attaches an errno. */
function withCode<E extends Error>(error: E, code: string): E & { readonly code: string } {
  return Object.assign(error, { code });
}

/** Throws `value` as it is. */
function throwValue(value: unknown): never {
  throw value;
}

// ---------------------------------------------------------------------------
// The capturing logger
// ---------------------------------------------------------------------------

/** One record, rendered every way a sink could print it, lower-cased. */
function renderRecord(record: LogRecord): string {
  return [
    record.message,
    JSON.stringify(record.fields),
    inspect(record.fields, { depth: 8, showHidden: true }),
  ]
    .join('\n')
    .toLowerCase();
}

/** Fails the case when any record, at any level, carries any sentinel. */
function expectNoLeak(records: readonly LogRecord[]): void {
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    const rendered = renderRecord(record);
    for (const sentinel of SENTINELS) {
      expect(rendered, `${record.level} record "${record.message}"`).not.toContain(
        sentinel.toLowerCase(),
      );
    }
  }
}

/** The one record with `message`; fails the case unless exactly one was emitted. */
function recordOf(records: readonly LogRecord[], message: string): LogRecord {
  const matching = records.filter((record) => record.message === message);
  expect(matching, `records named "${message}"`).toHaveLength(1);
  const [record] = matching;
  if (record === undefined) {
    throw new Error(`expected a record named "${message}"`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// The fake child
// ---------------------------------------------------------------------------

/**
 * A child process a case ends by hand. Built on a real `EventEmitter` with
 * real `PassThrough` pipes, so the manager's listeners, line splitting and
 * drain detection run exactly as against `node:child_process`.
 */
class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  /** Every signal the manager sent, in order. */
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];

  constructor(readonly pid: number) {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    setImmediate(() => {
      this.finish(null, typeof signal === 'string' ? signal : 'SIGTERM');
    });
    return true;
  }

  /** Writes `stderrLines`, ends both pipes and exits with `code` or `signal`. Once only. */
  finish(
    code: number | null,
    signal: NodeJS.Signals | null,
    stderrLines: readonly string[] = [],
  ): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    for (const line of stderrLines) {
      this.stderr.write(`${line}\n`);
    }
    this.stdout.end();
    this.stderr.end();
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/** The embedded bundle's layout, as the manager checks it. */
const PATHS = Object.freeze({
  serviceMain: path.join('/opt', 'debuggen-ext', 'dist', 'service', 'main.js'),
  servicePromptsDir: path.join('/opt', 'debuggen-ext', 'dist', 'service', 'prompts'),
});

/** A complete bundle: the entry and its package manifest are files, the prompts a directory. */
function bundleKind(target: string): PathKind {
  if (target === PATHS.serviceMain) {
    return 'file';
  }
  if (target === path.join(path.dirname(PATHS.serviceMain), 'package.json')) {
    return 'file';
  }
  return target === PATHS.servicePromptsDir ? 'directory' : 'missing';
}

/** A credential port holding {@link EDITOR_TOKEN}, with overridable members. */
function fakeCredential(overrides: Partial<ServiceCredentialPort> = {}): ServiceCredentialPort {
  return {
    paths: () =>
      ok({
        debuggenHome: path.join('/tmp', 'debuggen-process-test'),
        authFilePath: path.join('/tmp', 'debuggen-process-test', 'auth.json'),
      }),
    ensure: () => Promise.resolve(ok(EDITOR_TOKEN)),
    waitForCredential: () => Promise.resolve(ok(EDITOR_TOKEN)),
    ...overrides,
  };
}

/** What a case controls and observes around one manager. */
interface World {
  /** Whether the fake health probe answers. */
  answering: boolean;
  /** The settings the reader answers, mutable per case. */
  settings: ServiceProcessSettings;
  /** Every child spawned, in order. */
  readonly children: FakeChild[];
  /** Runs for every spawned child, right after it was created. */
  onSpawn: (child: FakeChild) => void;
}

/** One manager under test, its log and its world. */
interface Harness {
  readonly manager: ServiceProcess;
  readonly records: LogRecord[];
  readonly world: World;
}

/** Every manager a case built, disposed after it. */
const created: ServiceProcess[] = [];

afterEach(async () => {
  for (const manager of created.splice(0)) {
    manager.dispose();
  }
  await settle();
});

/** Options of {@link createHarness}. */
interface HarnessOptions {
  /** Settings replacing the defaults (auto-start on, a plain loopback URL). */
  readonly settings?: Partial<ServiceProcessSettings>;
  /** Runs for every spawned child. */
  readonly onSpawn?: (child: FakeChild, world: World) => void;
  /** Seams replacing the harness's own. */
  readonly deps?: Partial<ServiceProcessDeps>;
}

/** A manager whose every seam is a fake; nothing touches the editor or the machine. */
function createHarness(options: HarnessOptions = {}): Harness {
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push({ ...record, fields: { ...record.fields } });
    },
  });
  const world: World = {
    answering: false,
    settings: {
      autoStartService: true,
      serviceUrl: 'http://127.0.0.1:43117',
      providerExplicit: undefined,
      providerDefault: undefined,
      ...options.settings,
    },
    children: [],
    onSpawn: (child) => {
      options.onSpawn?.(child, world);
    },
  };
  let nextPid = 4100;
  const manager = createServiceProcess({
    paths: PATHS,
    probe: {
      health: () =>
        Promise.resolve(
          world.answering
            ? ok({ status: 'ok' })
            : err(new DebuggenError('TRANSPORT_DISCONNECTED', 'nothing answers')),
        ),
    },
    credential: fakeCredential(),
    logger,
    env: {},
    spawn: () => {
      nextPid += 1;
      const child = new FakeChild(nextPid);
      world.children.push(child);
      world.onSpawn(child);
      return child;
    },
    readSettings: () => ({ ...world.settings }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    createOutputChannel: () => ({
      append: () => undefined,
      appendLine: () => undefined,
      clear: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
    pathKind: bundleKind,
    isExecutable: () => true,
    execPath: path.join('/usr', 'bin', 'node'),
    versions: { node: '24.13.0' },
    platform: 'linux',
    restartPolicy: {
      initialDelayMs: 1,
      maxDelayMs: 1,
      factor: 1,
      maxAttempts: 3,
      stableAfterMs: 60_000,
    },
    startupTimeoutMs: 5_000,
    healthPollIntervalMs: 2,
    slowStartPollIntervalMs: 2,
    healthProbeTimeoutMs: 1_000,
    stopGraceMs: 1_000,
    quiesceTimeoutMs: 1_000,
    ...options.deps,
  });
  created.push(manager);
  return { manager, records, world };
}

/** Lets pending promise continuations and immediates run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** The child the manager spawned last; fails the case when there is none. */
function latestChild(world: World): FakeChild {
  const child = world.children.at(-1);
  if (child === undefined) {
    throw new Error('expected the manager to have spawned a child');
  }
  return child;
}

/** Brings a healthy embedded child up: the probe answers as soon as it is spawned. */
async function startHealthy(harness: Harness, userInitiated = false): Promise<FakeChild> {
  harness.world.onSpawn = () => {
    harness.world.answering = true;
  };
  const started = await harness.manager.ensureRunning({ userInitiated });
  expect(isOk(started) ? started.value.state : started.error.code).toBe('running');
  return latestChild(harness.world);
}

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

describe('SERVICE_FAILURE_REASONS', () => {
  it('is a closed list of kebab-case reasons with no duplicate', () => {
    expect(new Set(SERVICE_FAILURE_REASONS).size).toBe(SERVICE_FAILURE_REASONS.length);
    for (const reason of SERVICE_FAILURE_REASONS) {
      expect(reason).toMatch(/^[a-z]+(?:-[a-z]+)*$/u);
    }
    expect(SERVICE_FAILURE_REASONS).toContain('unexpected');
  });
});

// ---------------------------------------------------------------------------
// An unexpected throw inside an ensure attempt
// ---------------------------------------------------------------------------

describe('an ensure attempt that throws', () => {
  it('returns a fixed message naming a reference that its log record carries, never the thrown text', async () => {
    const harness = createHarness({
      deps: { pathKind: () => throwValue(withCode(leakyError(), 'EACCES')) },
    });

    const result = await harness.manager.ensureRunning();

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) {
      return;
    }
    const record = recordOf(harness.records, 'ensuring the service failed unexpectedly');
    expect(record.level).toBe('error');
    const ref = record.fields.ref;
    expect(ref).toMatch(/^msg_/u);
    expect(record.fields).toEqual({
      ...BOUND,
      ref,
      errorCode: 'INTERNAL',
      errorClass: 'unlisted',
      errno: 'EACCES',
    });

    const error = result.error;
    expect(error.code).toBe('INTERNAL');
    expect(error.details).toEqual({ reason: 'unexpected', ref });
    expect(error.message).toBe(
      `Checking or starting the Debug Generator service failed unexpectedly (reference ${String(ref)}).`,
    );
    expect(error.hint).toContain(String(ref));
    expect(error.hint).toContain('"Debug Generator" output');
    const surfaced = JSON.stringify(error.toPayload()).toLowerCase();
    expect(surfaced).not.toContain('sentinel');
    expectNoLeak(harness.records);
  });

  it('keeps a thrown DebuggenError code and drops its message and a non-errno code', async () => {
    const harness = createHarness({
      deps: {
        credential: fakeCredential({
          paths: () =>
            throwValue(
              new DebuggenError('STORE_ERROR', sentinelText(), {
                hint: sentinelText(),
                details: { path: SENTINEL_PATH },
                cause: leakyError(),
              }),
            ),
        }),
      },
    });

    const result = await harness.manager.ensureRunning();

    const record = recordOf(harness.records, 'ensuring the service failed unexpectedly');
    expect(record.fields).toEqual({
      ...BOUND,
      ref: record.fields.ref,
      errorCode: 'STORE_ERROR',
      errorClass: 'DebuggenError',
    });
    expect(isErr(result) ? result.error.code : undefined).toBe('STORE_ERROR');
    expect(isErr(result) ? result.error.details?.ref : undefined).toBe(record.fields.ref);
    expect(isErr(result) ? JSON.stringify(result.error.toPayload()) : '').not.toContain('sentinel');
    expectNoLeak(harness.records);
  });
});

// ---------------------------------------------------------------------------
// The configured service URL
// ---------------------------------------------------------------------------

describe('the configured debuggen.serviceUrl in log records', () => {
  it('is logged as refused, without any part of it, when it carries userinfo (external service)', async () => {
    const harness = createHarness({ settings: { serviceUrl: USERINFO_URL } });
    harness.world.answering = true;

    const result = await harness.manager.ensureRunning();

    expect(isOk(result) ? result.value.state : undefined).toBe('external');
    const record = recordOf(harness.records, 'a service is already answering; nothing was spawned');
    expect(record.level).toBe('info');
    expect(record.fields).toEqual({ ...BOUND, serviceUrlAccepted: false });
    expectNoLeak(harness.records);
  });

  it('is logged as its origin only when it carries a path, a query and a fragment (external service)', async () => {
    const harness = createHarness({ settings: { serviceUrl: QUERY_URL } });
    harness.world.answering = true;

    await harness.manager.ensureRunning();

    const record = recordOf(harness.records, 'a service is already answering; nothing was spawned');
    expect(record.fields).toEqual({
      ...BOUND,
      serviceOrigin: 'http://127.0.0.1:43117',
      serviceUrlAccepted: true,
    });
    expectNoLeak(harness.records);
  });

  it('is logged as refused when auto-start is disabled, and the returned failure names no part of it', async () => {
    const harness = createHarness({
      settings: { serviceUrl: USERINFO_URL, autoStartService: false },
    });

    const result = await harness.manager.ensureRunning();

    const record = recordOf(
      harness.records,
      'the service is not running and auto-start is disabled',
    );
    expect(record.level).toBe('info');
    expect(record.fields).toEqual({ ...BOUND, serviceUrlAccepted: false });
    expect(isErr(result) ? result.error.details?.reason : undefined).toBe('auto-start-disabled');
    expect(isErr(result) ? result.error.message.toLowerCase() : '').not.toContain('sentinel');
    expect(harness.world.children).toHaveLength(0);
    expectNoLeak(harness.records);
  });

  it('is logged as its origin when another service answered after the spawned one exited', async () => {
    const harness = createHarness({
      settings: { serviceUrl: QUERY_URL },
      onSpawn: (child, world) => {
        setImmediate(() => {
          world.answering = true;
          child.finish(1, null);
        });
      },
    });

    const result = await harness.manager.ensureRunning();

    expect(isOk(result) ? result.value.state : undefined).toBe('external');
    const record = recordOf(
      harness.records,
      'another service answered after the spawned one exited; using it',
    );
    expect(record.fields).toEqual({
      ...BOUND,
      serviceOrigin: 'http://127.0.0.1:43117',
      serviceUrlAccepted: true,
    });
    expectNoLeak(harness.records);
  });

  it('is logged as the new origin when the setting moved; the child is kept until restart() moves it', async () => {
    const harness = createHarness({ settings: { serviceUrl: QUERY_URL } });
    const child = await startHealthy(harness);
    harness.world.answering = false;
    harness.world.settings = { ...harness.world.settings, serviceUrl: MOVED_QUERY_URL };

    const moved = await harness.manager.ensureRunning();

    // A live child is never stopped or replaced because the setting moved: it
    // may be the only process that can still end a session and restore its
    // files, so the move is reported and the child keeps running.
    expect(isErr(moved) ? moved.error.details?.reason : undefined).toBe('service-url-changed');
    expect(harness.manager.status.state).toBe('running');
    expect(harness.world.children).toHaveLength(1);
    expect(child.signals).toEqual([]);
    const record = recordOf(
      harness.records,
      'the service URL changed; nothing answers there, and the service this window started is kept running until it is restarted',
    );
    expect(record.level).toBe('warn');
    expect(record.fields).toEqual({
      ...BOUND,
      childOrigin: 'http://127.0.0.1:43117',
      configuredOrigin: 'http://127.0.0.1:43118',
      pid: child.pid,
    });
    expect(isErr(moved) ? JSON.stringify(moved.error.toPayload()).toLowerCase() : '').not.toContain(
      'sentinel',
    );

    // restart() is the one way the child moves to the new address.
    const restarted = await harness.manager.restart();

    expect(isOk(restarted) ? restarted.value.state : undefined).toBe('running');
    expect(harness.world.children).toHaveLength(2);
    expectNoLeak(harness.records);
  });

  it('is logged as its origin when a service answered before a scheduled restart', async () => {
    const harness = createHarness({ settings: { serviceUrl: QUERY_URL } });
    const child = await startHealthy(harness);
    harness.world.answering = false;

    child.finish(1, null);
    // The restart is scheduled; something else answers before it runs.
    harness.world.answering = true;

    await vi.waitFor(() => {
      recordOf(harness.records, 'a service answered before the restart; using it');
    });
    const record = recordOf(harness.records, 'a service answered before the restart; using it');
    expect(record.fields).toEqual({
      ...BOUND,
      serviceOrigin: 'http://127.0.0.1:43117',
      serviceUrlAccepted: true,
    });
    expectNoLeak(harness.records);
  });
});

// ---------------------------------------------------------------------------
// Failures this module built
// ---------------------------------------------------------------------------

describe('a failure this module built, in a log record', () => {
  it("logs an early exit by code, reason and exit code, never the child's stderr report", async () => {
    const report = `The session store at ${SENTINEL_PATH} could not be opened (sentinel)`;
    const harness = createHarness({
      onSpawn: (child) => {
        setImmediate(() => {
          child.finish(1, null, [
            'debuggen: starting',
            `debuggen: CONFIG_INVALID: ${report}`,
            `debuggen: hint: Remove ${SENTINEL_PATH} and start again.`,
          ]);
        });
      },
    });

    const result = await harness.manager.ensureRunning();

    expect(isErr(result) ? result.error.code : undefined).toBe('CONFIG_INVALID');
    const record = recordOf(harness.records, 'the service exited before it answered');
    expect(record.level).toBe('warn');
    expect(record.fields).toEqual({
      ...BOUND,
      pid: latestChild(harness.world).pid,
      errorCode: 'CONFIG_INVALID',
      reason: 'exited',
      exitCode: 1,
    });
    expectNoLeak(harness.records);
  });

  it('logs a spawn that throws by code, reason and errno', async () => {
    const harness = createHarness({
      deps: { spawn: () => throwValue(withCode(leakyError(), 'ENOENT')) },
    });

    const result = await harness.manager.ensureRunning();

    expect(isErr(result) ? result.error.details?.reason : undefined).toBe('spawn-failed');
    const record = recordOf(harness.records, 'the service process could not be spawned');
    expect(record.level).toBe('error');
    expect(record.fields).toEqual({
      ...BOUND,
      errorCode: 'CONFIG_INVALID',
      reason: 'spawn-failed',
      errno: 'ENOENT',
    });
    expectNoLeak(harness.records);
  });

  it('logs a crash that will be restarted by code, reason and exit code', async () => {
    const harness = createHarness();
    const child = await startHealthy(harness);
    harness.world.answering = false;
    harness.world.onSpawn = () => {
      harness.world.answering = true;
    };

    child.finish(3, null);

    const record = recordOf(harness.records, 'restarting the service');
    expect(record.level).toBe('warn');
    expect(record.fields).toEqual({
      ...BOUND,
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1,
      errorCode: 'TRANSPORT_DISCONNECTED',
      reason: 'crashed',
      exitCode: 3,
    });
    await vi.waitFor(() => {
      expect(harness.manager.status.state).toBe('running');
    });
    expectNoLeak(harness.records);
  });

  it('logs a crash with auto-start disabled by code, reason and exit code', async () => {
    const harness = createHarness({ settings: { autoStartService: false } });
    const child = await startHealthy(harness, true);
    harness.world.answering = false;

    child.finish(1, null);

    const record = recordOf(
      harness.records,
      'the service stopped and auto-start is disabled; not restarting',
    );
    expect(record.level).toBe('warn');
    expect(record.fields).toEqual({
      ...BOUND,
      errorCode: 'TRANSPORT_DISCONNECTED',
      reason: 'crashed',
      exitCode: 1,
    });
    expectNoLeak(harness.records);
  });

  it('logs an exhausted restart series by code, reason and signal', async () => {
    const harness = createHarness({
      deps: {
        restartPolicy: {
          initialDelayMs: 1,
          maxDelayMs: 1,
          factor: 1,
          maxAttempts: 0,
          stableAfterMs: 60_000,
        },
      },
    });
    const child = await startHealthy(harness);
    harness.world.answering = false;

    child.finish(null, 'SIGKILL');

    const record = recordOf(harness.records, 'the service kept stopping; giving up');
    expect(record.level).toBe('error');
    expect(record.fields).toEqual({
      ...BOUND,
      attempts: 0,
      errorCode: 'TRANSPORT_DISCONNECTED',
      reason: 'crashed',
      signal: 'SIGKILL',
    });
    expectNoLeak(harness.records);
  });
});

// ---------------------------------------------------------------------------
// Invented error codes
// ---------------------------------------------------------------------------

/**
 * Codes a thrower invented in the shapes a pattern such as `E…`/`ERR_…` would
 * have admitted — each could be a credential. None is a system or Node error
 * code, so none may reach a record, a failure's details or its message.
 */
const INVENTED_CODES: readonly string[] = [
  ['E', 'PRIVATECREDENTIAL', '123'].join(''),
  ['ERR', 'PRIVATE', 'TOKEN', '7F3A'].join('_'),
];

describe('a code property that is not a known system or Node error code', () => {
  /** Fails the case when any record names an invented code. */
  function expectNoInventedCode(records: readonly LogRecord[]): void {
    for (const record of records) {
      const rendered = renderRecord(record);
      for (const code of INVENTED_CODES) {
        expect(rendered, `${record.level} record "${record.message}"`).not.toContain(
          code.toLowerCase(),
        );
      }
    }
  }

  it.each(INVENTED_CODES)('is dropped from an ensure attempt that throws with %#', async (code) => {
    const harness = createHarness({
      deps: { pathKind: () => throwValue(withCode(leakyError(), code)) },
    });

    const result = await harness.manager.ensureRunning();

    const record = recordOf(harness.records, 'ensuring the service failed unexpectedly');
    expect(record.level).toBe('error');
    expect(record.fields).toEqual({
      ...BOUND,
      ref: record.fields.ref,
      errorCode: 'INTERNAL',
      errorClass: 'unlisted',
    });
    expect(isErr(result) ? JSON.stringify(result.error.toPayload()) : '').not.toContain(code);
    expectNoInventedCode(harness.records);
    expectNoLeak(harness.records);
  });

  it.each(INVENTED_CODES)('is dropped from a spawn that throws with %#', async (code) => {
    const harness = createHarness({
      deps: { spawn: () => throwValue(withCode(leakyError(), code)) },
    });

    const result = await harness.manager.ensureRunning();

    const record = recordOf(harness.records, 'the service process could not be spawned');
    expect(record.level).toBe('error');
    expect(record.fields).toEqual({
      ...BOUND,
      errorCode: 'CONFIG_INVALID',
      reason: 'spawn-failed',
    });
    expect(isErr(result) ? result.error.details?.errno : undefined).toBe('unknown');
    expect(isErr(result) ? JSON.stringify(result.error.toPayload()) : '').not.toContain(code);
    expectNoInventedCode(harness.records);
    expectNoLeak(harness.records);
  });
});
