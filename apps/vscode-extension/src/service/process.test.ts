/**
 * Tests for `./process.ts`: the embedded-service manager's log records carry
 * closed vocabularies and numbers only, and the environment it starts the
 * service with carries no model-SDK setting the service does not document.
 *
 * `buildServiceEnvironment` is exercised directly, on Linux and on Windows
 * (where names compare case-insensitively): every inherited `ANTHROPIC_*`
 * variable except `ANTHROPIC_API_KEY` is dropped — an inherited
 * `ANTHROPIC_BASE_URL` would redirect the credential and the prompts
 * (CWE-200/918), and `ANTHROPIC_LOG=debug` would print the model client's
 * request and response diagnostics into the service output channel (CWE-532)
 * — while the platform's variables pass through, the service's own settings
 * are applied, and the parent environment object is left untouched.
 *
 * The provider and model a spawned service runs behind come from the
 * settings: the manifest's own defaults (`debuggen.provider` =
 * `deterministic`, `debuggen.model` empty) start a service that needs no
 * credential and no model id, a configured `debuggen.model` reaches the child
 * as `DEBUGGEN_MODEL` (replacing an inherited copy, while an empty setting
 * keeps it), a value with a control character is refused before anything is
 * spawned without echoing it, and a changed `debuggen.model` flags the running
 * child for the restart that applies it.
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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DebuggenError, createConsoleLogger, err, isErr, isOk, ok } from '@debuggen/shared';
import type { LogRecord } from '@debuggen/shared';

import {
  SERVICE_FAILURE_REASONS,
  buildServiceEnvironment,
  createServiceProcess,
  resolveModelSetting,
} from './process';
import type {
  ChildProcessLike,
  ConfigurationChangeLike,
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

  /**
   * @param pid The process id the manager records.
   * @param env The environment the manager spawned this child with.
   */
  constructor(
    readonly pid: number,
    readonly env: Readonly<Record<string, string>> = {},
  ) {
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
    spawn: (_command, _args, spawnOptions) => {
      nextPid += 1;
      const child = new FakeChild(nextPid, spawnOptions.env);
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
// The environment the service child is started with
// ---------------------------------------------------------------------------

describe('buildServiceEnvironment and the model vendor kit variables', () => {
  /** The service's model credential, assembled so no key shape is a tracked literal. */
  const MODEL_CREDENTIAL = ['ut', 'model', 'credential', 'sentinel', '3d8f'].join('_');

  /** The editor's `server-agent` credential copy, which the service never holds. */
  const INHERITED_AGENT_TOKEN = ['agent', 'credential', 'sentinel', '9a41'].join('_');

  /** What a hostile inherited `ANTHROPIC_BASE_URL` names. */
  const HOSTILE_BASE_URL = 'http://attacker.test';

  /** The state directory, address and prompt tree the manager resolved. */
  const DEBUGGEN_HOME = path.join('/tmp', 'debuggen-process-test');
  const ADDRESS = Object.freeze({ host: '127.0.0.1', port: 43117 });
  const PROMPTS_DIR = PATHS.servicePromptsDir;

  it('keeps the platform variables and the credential, applies the service settings and drops every other ANTHROPIC_ variable (linux)', () => {
    const base: Readonly<Record<string, string | undefined>> = Object.freeze({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/sentinel-dev',
      DEBUGGEN_MODEL: 'model-under-test',
      ANTHROPIC_API_KEY: MODEL_CREDENTIAL,
      ANTHROPIC_BASE_URL: HOSTILE_BASE_URL,
      ANTHROPIC_LOG: 'debug',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Relay: attacker.test',
      ANTHROPIC_AUTH_TOKEN: ['auth', 'token', 'sentinel', '51c0'].join('_'),
      ANTHROPIC_PROFILE: 'sentinel-profile',
      DEBUGGEN_TOKEN: INHERITED_AGENT_TOKEN,
      DEBUGGEN_HOME: path.join('/home', 'sentinel-dev', '.debuggen'),
      UNSET_VARIABLE: undefined,
    });
    const snapshot = { ...base };

    const env = buildServiceEnvironment({
      base,
      debuggenHome: DEBUGGEN_HOME,
      address: ADDRESS,
      promptsDir: PROMPTS_DIR,
      provider: 'deterministic',
      runAsNode: false,
      platform: 'linux',
    });

    expect(env).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/sentinel-dev',
      DEBUGGEN_MODEL: 'model-under-test',
      ANTHROPIC_API_KEY: MODEL_CREDENTIAL,
      DEBUGGEN_HOME,
      DEBUGGEN_HOST: '127.0.0.1',
      DEBUGGEN_PORT: '43117',
      DEBUGGEN_PROMPTS_DIR: PROMPTS_DIR,
      DEBUGGEN_PROVIDER: 'deterministic',
    });
    for (const dropped of [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_LOG',
      'ANTHROPIC_CUSTOM_HEADERS',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_PROFILE',
      'DEBUGGEN_TOKEN',
      'UNSET_VARIABLE',
    ]) {
      expect(Object.keys(env), dropped).not.toContain(dropped);
    }
    expect(Object.values(env)).not.toContain(HOSTILE_BASE_URL);
    expect(Object.values(env)).not.toContain(INHERITED_AGENT_TOKEN);
    // The parent's object is copied, never edited.
    expect(base).toEqual(snapshot);
  });

  it('compares names case-insensitively on Windows: a mixed-case base URL and log level are dropped, a mixed-case credential kept', () => {
    const mixedCaseCredential = 'anthropic_api_key';
    const base: Readonly<Record<string, string | undefined>> = Object.freeze({
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      [mixedCaseCredential]: MODEL_CREDENTIAL,
      Anthropic_Base_Url: HOSTILE_BASE_URL,
      anthropic_log: 'debug',
      Anthropic_Custom_Headers: 'X-Relay: attacker.test',
      debuggen_token: INHERITED_AGENT_TOKEN,
      electron_run_as_node: '0',
    });
    const snapshot = { ...base };

    const env = buildServiceEnvironment({
      base,
      debuggenHome: DEBUGGEN_HOME,
      address: ADDRESS,
      runAsNode: true,
      platform: 'win32',
    });

    expect(env).toEqual({
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      [mixedCaseCredential]: MODEL_CREDENTIAL,
      DEBUGGEN_HOME,
      DEBUGGEN_HOST: '127.0.0.1',
      DEBUGGEN_PORT: '43117',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(Object.values(env)).not.toContain(HOSTILE_BASE_URL);
    expect(Object.values(env)).not.toContain('debug');
    expect(base).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// The provider and model the service child is started with
// ---------------------------------------------------------------------------

/** The shape of the part of `apps/vscode-extension/package.json` these cases read. */
interface ManifestSettingsShape {
  readonly contributes?: {
    readonly configuration?: {
      readonly properties?: Readonly<Record<string, { readonly default?: unknown }>>;
    };
  };
}

/** The extension manifest, resolved from this file rather than from the working directory. */
const MANIFEST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'package.json',
);

/** The manifest default of the contributed setting `key`, as VS Code reads it. */
function manifestDefault(key: string): unknown {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ManifestSettingsShape;
  const properties = manifest.contributes?.configuration?.properties;
  expect(properties, 'contributes.configuration.properties').toBeDefined();
  expect(Object.keys(properties ?? {}), `the manifest contributes ${key}`).toContain(key);
  return properties?.[key]?.default;
}

describe('the provider and model a spawned service runs behind', () => {
  /** A configured model id: a neutral stand-in, never a real model's id. */
  const CONFIGURED_MODEL = 'configured-model-under-test';

  /** A model id inherited from the editor's environment. */
  const INHERITED_MODEL = 'inherited-model-under-test';

  /** A stem planted in refused values; no failure or record may repeat it. */
  const MODEL_SENTINEL = ['model', 'sentinel', '5c2e'].join('-');

  /** The state directory and address the manager resolved. */
  const DEBUGGEN_HOME = path.join('/tmp', 'debuggen-process-test');
  const ADDRESS = Object.freeze({ host: '127.0.0.1', port: 43117 });

  /** Fails the case when any record, at any level, names a model id. */
  function expectNoModelId(records: readonly LogRecord[]): void {
    for (const record of records) {
      const rendered = renderRecord(record);
      for (const value of [CONFIGURED_MODEL, INHERITED_MODEL, MODEL_SENTINEL]) {
        expect(rendered, `${record.level} record "${record.message}"`).not.toContain(value);
      }
    }
  }

  describe('the manifest defaults', () => {
    it('select the deterministic provider and supply no model id', () => {
      expect(manifestDefault('debuggen.provider')).toBe('deterministic');
      expect(manifestDefault('debuggen.model')).toBe('');
    });

    it('start a service with DEBUGGEN_PROVIDER=deterministic and no DEBUGGEN_MODEL when the editor environment sets neither', async () => {
      const providerDefault = manifestDefault('debuggen.provider');
      const modelDefault = manifestDefault('debuggen.model');
      const harness = createHarness({
        settings: {
          providerExplicit: undefined,
          providerDefault,
          model: typeof modelDefault === 'string' ? modelDefault : undefined,
        },
      });

      const child = await startHealthy(harness);

      expect(child.env.DEBUGGEN_PROVIDER).toBe('deterministic');
      expect(Object.keys(child.env)).not.toContain('DEBUGGEN_MODEL');
      expect(Object.keys(child.env)).not.toContain('ANTHROPIC_API_KEY');
    });
  });

  describe('resolveModelSetting', () => {
    it('forwards a configured model id, trimmed', () => {
      expect(resolveModelSetting({ model: CONFIGURED_MODEL })).toEqual(ok(CONFIGURED_MODEL));
      expect(resolveModelSetting({ model: `  ${CONFIGURED_MODEL} ` })).toEqual(
        ok(CONFIGURED_MODEL),
      );
    });

    it.each([
      ['unset', {}],
      ['undefined', { model: undefined }],
      ['empty', { model: '' }],
      ['whitespace-only', { model: ' \t\n ' }],
    ] as const)('yields nothing to apply when the setting is %s', (_label, settings) => {
      expect(resolveModelSetting(settings)).toEqual(ok(undefined));
    });

    it.each([
      ['NUL', '\u0000'],
      ['line feed', '\n'],
      ['carriage return', '\r'],
      ['tab', '\t'],
      ['DEL', '\u007f'],
      ['C1 next-line', '\u0085'],
      ['line separator', '\u2028'],
      ['paragraph separator', '\u2029'],
    ])(
      'refuses a value holding a %s, naming the setting and never the value',
      (_label, character) => {
        const result = resolveModelSetting({
          model: `${MODEL_SENTINEL}${character}${MODEL_SENTINEL}`,
        });

        expect(isErr(result)).toBe(true);
        if (!isErr(result)) {
          return;
        }
        expect(result.error.code).toBe('CONFIG_INVALID');
        expect(result.error.details).toEqual({ reason: 'model' });
        expect(result.error.message).toContain('debuggen.model');
        expect(result.error.hint).toContain('debuggen.model');
        expect(JSON.stringify(result.error.toPayload())).not.toContain(MODEL_SENTINEL);
      },
    );

    it("reports its refusal under a reason in the module's closed vocabulary", () => {
      expect(SERVICE_FAILURE_REASONS).toContain('model');
    });
  });

  describe('buildServiceEnvironment and DEBUGGEN_MODEL', () => {
    it('applies the model, replacing an inherited copy (linux)', () => {
      const env = buildServiceEnvironment({
        base: { PATH: '/usr/bin', DEBUGGEN_MODEL: INHERITED_MODEL },
        debuggenHome: DEBUGGEN_HOME,
        address: ADDRESS,
        provider: 'anthropic',
        model: CONFIGURED_MODEL,
        runAsNode: false,
        platform: 'linux',
      });

      expect(env).toEqual({
        PATH: '/usr/bin',
        DEBUGGEN_HOME,
        DEBUGGEN_HOST: '127.0.0.1',
        DEBUGGEN_PORT: '43117',
        DEBUGGEN_PROVIDER: 'anthropic',
        DEBUGGEN_MODEL: CONFIGURED_MODEL,
      });
    });

    it('replaces an inherited copy spelled in any case on Windows', () => {
      const env = buildServiceEnvironment({
        base: { Path: 'C:\\Windows\\System32', debuggen_model: INHERITED_MODEL },
        debuggenHome: DEBUGGEN_HOME,
        address: ADDRESS,
        model: CONFIGURED_MODEL,
        runAsNode: false,
        platform: 'win32',
      });

      expect(env).toEqual({
        Path: 'C:\\Windows\\System32',
        DEBUGGEN_HOME,
        DEBUGGEN_HOST: '127.0.0.1',
        DEBUGGEN_PORT: '43117',
        DEBUGGEN_MODEL: CONFIGURED_MODEL,
      });
      expect(Object.values(env)).not.toContain(INHERITED_MODEL);
    });

    it('keeps an inherited copy when no model is given', () => {
      const env = buildServiceEnvironment({
        base: { DEBUGGEN_MODEL: INHERITED_MODEL },
        debuggenHome: DEBUGGEN_HOME,
        address: ADDRESS,
        runAsNode: false,
        platform: 'linux',
      });

      expect(env.DEBUGGEN_MODEL).toBe(INHERITED_MODEL);
    });
  });

  describe('a spawned child', () => {
    it('receives debuggen.model as DEBUGGEN_MODEL, over a copy the editor inherited', async () => {
      const harness = createHarness({
        settings: { providerExplicit: 'anthropic', model: CONFIGURED_MODEL },
        deps: { env: { PATH: '/usr/bin', DEBUGGEN_MODEL: INHERITED_MODEL } },
      });

      const child = await startHealthy(harness);

      expect(child.env.DEBUGGEN_PROVIDER).toBe('anthropic');
      expect(child.env.DEBUGGEN_MODEL).toBe(CONFIGURED_MODEL);
      expectNoModelId(harness.records);
    });

    it('keeps an inherited DEBUGGEN_MODEL when debuggen.model is empty', async () => {
      const harness = createHarness({
        settings: { model: undefined },
        deps: { env: { PATH: '/usr/bin', DEBUGGEN_MODEL: INHERITED_MODEL } },
      });

      const child = await startHealthy(harness);

      expect(child.env.DEBUGGEN_MODEL).toBe(INHERITED_MODEL);
      expectNoModelId(harness.records);
    });

    it('is never spawned for a model id holding a control character, and nothing logs the value', async () => {
      const harness = createHarness({
        settings: { model: `${MODEL_SENTINEL}\n${MODEL_SENTINEL}` },
      });

      const result = await harness.manager.ensureRunning();

      expect(isErr(result) ? result.error.code : undefined).toBe('CONFIG_INVALID');
      expect(isErr(result) ? result.error.details?.reason : undefined).toBe('model');
      expect(isErr(result) ? JSON.stringify(result.error.toPayload()) : '').not.toContain(
        MODEL_SENTINEL,
      );
      expect(harness.world.children).toHaveLength(0);
      expect(harness.manager.status.state).toBe('failed');
      expectNoModelId(harness.records);
    });
  });

  describe('a changed debuggen.model', () => {
    it('flags settingsChanged on a running child without signalling it, and a restart applies the new model', async () => {
      let notify: ((event: ConfigurationChangeLike) => void) | undefined;
      const harness = createHarness({
        settings: { model: CONFIGURED_MODEL },
        deps: {
          onDidChangeConfiguration: (listener) => {
            notify = listener;
            return { dispose: () => undefined };
          },
        },
      });
      const child = await startHealthy(harness);
      expect(harness.manager.status.settingsChanged).toBe(false);
      expect(notify).toBeDefined();

      const changedModel = 'changed-model-under-test';
      harness.world.settings = { ...harness.world.settings, model: changedModel };
      notify?.({
        affectsConfiguration: (section) => section === 'debuggen' || section === 'debuggen.model',
      });

      expect(harness.manager.status.settingsChanged).toBe(true);
      expect(harness.manager.status.state).toBe('running');
      expect(child.signals).toEqual([]);
      expect(harness.world.children).toHaveLength(1);
      const record = recordOf(
        harness.records,
        'a setting the running service was started with changed; restart it to apply',
      );
      expect(record.fields).toEqual({ ...BOUND, settings: ['debuggen.model'] });
      for (const logged of harness.records) {
        expect(renderRecord(logged)).not.toContain(changedModel);
      }
      expectNoModelId(harness.records);

      // restart() is how the developer applies it: the new child carries the
      // new model, and the flag clears.
      harness.world.answering = false;
      const restarted = await harness.manager.restart();

      expect(isOk(restarted) ? restarted.value.state : undefined).toBe('running');
      expect(harness.manager.status.settingsChanged).toBe(false);
      expect(harness.world.children).toHaveLength(2);
      expect(latestChild(harness.world).env.DEBUGGEN_MODEL).toBe(changedModel);
    });

    it('lifts a latched model refusal, so the next automatic start uses the corrected value', async () => {
      let notify: ((event: ConfigurationChangeLike) => void) | undefined;
      const harness = createHarness({
        settings: { model: `${MODEL_SENTINEL}\u0000` },
        deps: {
          onDidChangeConfiguration: (listener) => {
            notify = listener;
            return { dispose: () => undefined };
          },
        },
      });
      const refused = await harness.manager.ensureRunning();
      expect(isErr(refused) ? refused.error.details?.reason : undefined).toBe('model');

      // Latched: an automatic retry with the value unchanged spawns nothing.
      const repeated = await harness.manager.ensureRunning();
      expect(isErr(repeated) ? repeated.error.details?.reason : undefined).toBe('model');
      expect(harness.world.children).toHaveLength(0);

      harness.world.settings = { ...harness.world.settings, model: CONFIGURED_MODEL };
      notify?.({
        affectsConfiguration: (section) => section === 'debuggen' || section === 'debuggen.model',
      });
      const child = await startHealthy(harness);

      expect(child.env.DEBUGGEN_MODEL).toBe(CONFIGURED_MODEL);
      expect(harness.manager.status.settingsChanged).toBe(false);
      expectNoModelId(harness.records);
    });
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
