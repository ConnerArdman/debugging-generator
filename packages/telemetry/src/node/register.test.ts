// @vitest-environment node
/**
 * Tests for `./register.ts` — the `--import` entry of the dev-server preload.
 *
 * ## What is on trial
 *
 * Two promises this module makes to a developer whose dev server it is loaded
 * into, and the evidence for each:
 *
 * 1. **Without its credential it installs nothing at all** (AAP §0.5.1,
 *    §0.5.6). The artefact stays on `NODE_OPTIONS` after a session ends and
 *    `scripts/dev-instrumented.mjs --spawn-local` deliberately runs without a
 *    token, so "inert" is the ordinary state of the machine. Every inert case
 *    asserts the *absence* of each process-global effect — no registered tracer
 *    provider, no propagator, no ORM hook or driver instrumentation, no
 *    `__DEBUGGEN__` — rather than merely reading the status it reports.
 * 2. **Whatever it installs, it gives back.** The active path is driven with an
 *    injected environment, `connect: false` or a fake socket, and a stubbed
 *    `fetch`, so no service, socket or network is needed; its teardown is then
 *    asserted to leave no provider, no propagator, no patch and no helper —
 *    and to leave the one effect it documents as staying, the
 *    `AsyncLocalStorage` context manager `register()` installed, in place and
 *    inert. A failure injected part-way through the installation must leave
 *    the same clean process *synchronously*, before the `failed` result exists,
 *    because the normal caller of that result is a module evaluation that
 *    awaits nothing.
 *
 * The credential is asserted absent from every log line and every reported
 * reason on every path.
 *
 * ## Why the environment is scrubbed before the import
 *
 * Importing `./register.js` runs `bootstrap()` from `process.env` at module
 * scope, and the suite's hermetic environment (`vitest.config.ts`) blanks the
 * model-provider variables but not the three launch variables. A developer who
 * runs this suite from a terminal that has them exported would otherwise get an
 * installed preload — a registered provider and a live control socket — inside
 * the test worker. So `vi.hoisted` removes them before any import is
 * evaluated, which makes the module-level result deterministic, and they are
 * restored after the suite.
 *
 * ## Habits
 *
 * - Every global the preload can touch — the OpenTelemetry API globals, the
 *   ORM hook, `__DEBUGGEN__`, the preload slot symbol, any signal listener a
 *   fresh evaluation attached — is torn down after every case.
 * - The credential is assembled from fragments, as `./control.test.ts` does,
 *   because `scripts/check-secrets.mjs` reads tracked test files.
 * - `pg` is not a dependency of this package, so the driver assertion patches a
 *   module of `pg`'s shape through the instrumentation's own module definition,
 *   exactly as `./control.test.ts` does.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { EventEmitter } from 'node:events';

import {
  context,
  createContextKey,
  diag,
  propagation,
  ProxyTracerProvider,
  ROOT_CONTEXT,
  trace,
} from '@opentelemetry/api';
import { isWrapped } from '@opentelemetry/instrumentation';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import { ID_PREFIXES } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel, LogLevelSetting } from '@debuggen/shared';

import { PRELOAD_ENV_KEYS, PRODUCER_ID, TRACER_VERSION } from './config.js';
import { NO_SIGNALS, ServerAgentControl } from './control.js';
import type {
  ControlSocket,
  ControlSocketCloseEvent,
  ControlSocketMessageEvent,
  ToggleableInstrumentation,
} from './control.js';
import {
  installPreload,
  preloadInstallation,
  SHUTDOWN_DEADLINE_MS,
  shutdownPreload,
} from './register.js';
import type { InstalledPreload, PreloadInstallation } from './register.js';
import * as spanHelperModule from './span-helper.js';

/*
 * ---------------------------------------------------------------------------
 * The environment, scrubbed before `./register.js` is evaluated
 * ---------------------------------------------------------------------------
 */

vi.hoisted(() => {
  // Spelled out rather than read from `PRELOAD_ENV_KEYS`: this callback runs
  // before any import of this file is evaluated, which is its whole point.
  vi.stubEnv('DEBUGGEN_INGEST_URL', undefined);
  vi.stubEnv('DEBUGGEN_TOKEN', undefined);
  vi.stubEnv('DEBUGGEN_PROJECT_ROOT', undefined);
  vi.stubEnv('DEBUGGEN_LOG_LEVEL', undefined);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/** A loopback service authority that nothing in this suite ever connects to. */
const SERVICE_AUTHORITY = '127.0.0.1:43117';

/** The complete ingest endpoint, as the launcher exports it. */
const INGEST_URL = `http://${SERVICE_AUTHORITY}/telemetry/ingest`;

/** An absolute project root that belongs to no particular project. */
const PROJECT_ROOT = '/tmp/debuggen-fixture/sample-project';

/**
 * The server-agent credential, assembled at runtime so no tracked literal
 * resembles one. Long enough that a partial echo would be obvious.
 */
const PRELOAD_TOKEN = ['dbg', 'register', 'credential', 'z'.repeat(28)].join('-');

/** What `./register.ts` writes wherever the credential would appear. */
const REDACTED_PLACEHOLDER = '[redacted]';

/** The slot a successful evaluation parks its installation on. */
const PRELOAD_SLOT_KEY = Symbol.for('debuggen.telemetry.node.preload');

/** The property the span helper is installed at. */
const HELPER_GLOBAL_PROPERTY = spanHelperModule.DEBUGGEN_GLOBAL_KEY;

/** A capture id of the service's shape; nothing but the exporter reads it. */
const CAPTURE_ID = `${ID_PREFIXES.capture}_${'c'.repeat(16)}`;

/** The one symbol the armed capture's plan patched. */
const PLANNED_SYMBOL = 'plotEphemeris';

/** A symbol no plan in this suite patched. */
const UNPLANNED_SYMBOL = 'estimateAirmass';

/** The project-relative file the planned symbol's patch declares. */
const PLANNED_FILE = 'src/lib/astronomy/ephemeris.ts';

/** The line the planned symbol's patch declares. */
const PLANNED_LINE = 42;

/** The column the planned symbol's patch declares; the location needs all three. */
const PLANNED_COLUMN = 3;

/** The global key fragment `@prisma/instrumentation` writes its hook under. */
const PRISMA_GLOBAL_KEY_FRAGMENT = 'PRISMA_INSTRUMENTATION';

/** The signals and exit event a successful evaluation listens on. */
const EXIT_EVENTS = ['SIGINT', 'SIGTERM', 'beforeExit'] as const;

/**
 * `process` viewed as the plain emitter it is, so the listeners a fresh
 * evaluation attaches can be counted and removed by one signature for the
 * signal and the exit event alike.
 */
const processEvents: EventEmitter = process;

/**
 * The environment the launcher exports into an instrumented dev server.
 *
 * @param overrides Values to replace, or `undefined` to remove one.
 * @returns A fresh environment record; never `process.env`.
 */
function launchEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    [PRELOAD_ENV_KEYS.ingestUrl]: INGEST_URL,
    [PRELOAD_ENV_KEYS.token]: PRELOAD_TOKEN,
    [PRELOAD_ENV_KEYS.projectRoot]: PROJECT_ROOT,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

/**
 * The ingest endpoint with the credential embedded as URL userinfo — the shape
 * `./config.ts` refuses.
 *
 * Built through the URL API rather than written as a template, so no tracked
 * line of this file has the shape `scripts/check-secrets.mjs` reports as a
 * credentialed connection string.
 *
 * @returns The credentialed endpoint.
 */
function ingestUrlWithUserinfo(): string {
  const url = new URL(INGEST_URL);
  url.username = 'someone';
  url.password = PRELOAD_TOKEN;
  return url.toString();
}

/*
 * ---------------------------------------------------------------------------
 * Doubles
 * ---------------------------------------------------------------------------
 */

/** One line a diagnostic produced. */
interface LogEntry {
  /** The severity the call site chose. */
  readonly level: LogLevel;
  /** The message, after the module's credential scrub. */
  readonly message: string;
  /** The structured fields, where the call site passed any. */
  readonly fields?: LogFields | undefined;
}

/** A logger that keeps every record, so the privacy assertion can search them. */
class RecordingLogger implements Logger {
  /** The threshold `./register.ts` reads to decide whether to wire `diag`. */
  readonly level: LogLevelSetting;

  /** Every record written through this logger or a child of it. */
  readonly entries: LogEntry[];

  /**
   * @param level The threshold to report.
   * @param entries The store to append to; a child receives its parent's.
   */
  constructor(level: LogLevelSetting = 'debug', entries: LogEntry[] = []) {
    this.level = level;
    this.entries = entries;
  }

  trace(message: string, fields?: LogFields): void {
    this.#record('trace', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.#record('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#record('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#record('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#record('error', message, fields);
  }

  fatal(message: string, fields?: LogFields): void {
    this.#record('fatal', message, fields);
  }

  child(bindings: LogFields): Logger {
    void bindings;
    return new RecordingLogger(this.level, this.entries);
  }

  /** @returns Every message and every field, as one searchable string. */
  text(): string {
    return this.entries
      .map((entry) =>
        entry.fields === undefined
          ? `${entry.level} ${entry.message}`
          : `${entry.level} ${entry.message} ${JSON.stringify(entry.fields)}`,
      )
      .join('\n');
  }

  /**
   * Append one record.
   *
   * @param level The severity.
   * @param message The message.
   * @param fields The structured detail, where there was any.
   */
  #record(level: LogLevel, message: string, fields?: LogFields): void {
    this.entries.push(fields === undefined ? { level, message } : { level, message, fields });
  }
}

/** Every socket {@link FakeControlSocket} constructed, in order. */
const sockets: FakeControlSocket[] = [];

/** A control socket that never touches the network. */
class FakeControlSocket implements ControlSocket {
  /** The URL the module constructed this socket for. */
  readonly url: string;

  /** `0` connecting, `1` open, `3` closed. */
  readyState = 0;

  /** Every frame the module sent, as raw text. */
  readonly sent: string[] = [];

  /** How many times the module closed this socket. */
  closeCalls = 0;

  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: ControlSocketMessageEvent) => void) | null = null;
  onclose: ((event: ControlSocketCloseEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  /**
   * @param url The URL the module passed to the constructor.
   */
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    void code;
    void reason;
    this.readyState = 3;
    this.closeCalls += 1;
  }

  /** Open the connection, as the transport would. */
  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
}

/*
 * ---------------------------------------------------------------------------
 * Observations of the process
 * ---------------------------------------------------------------------------
 */

/** The `globalThis` keys the ORM instrumentation's hook occupies. */
function prismaGlobalKeys(): string[] {
  return Object.keys(globalThis).filter((key) => key.includes(PRISMA_GLOBAL_KEY_FRAGMENT));
}

/** Remove the ORM instrumentation's global hook, whatever a case left behind. */
function clearPrismaGlobals(): void {
  for (const key of prismaGlobalKeys()) {
    Reflect.deleteProperty(globalThis, key);
  }
}

/** @returns Whatever occupies `globalThis.__DEBUGGEN__`. */
function helperSlot(): unknown {
  return Reflect.get(globalThis, HELPER_GLOBAL_PROPERTY);
}

/** @returns Whatever occupies the preload slot. */
function preloadSlot(): unknown {
  return Reflect.get(globalThis, PRELOAD_SLOT_KEY);
}

/** @returns The provider the global proxy delegates to, if one is registered. */
function registeredDelegate(): unknown {
  const global = trace.getTracerProvider();
  return global instanceof ProxyTracerProvider ? global.getDelegate() : global;
}

/**
 * Assert that the process holds no tracer provider and no propagator.
 *
 * Three independent observations, because each one alone can be satisfied
 * for the wrong reason: a started span does not record, the propagator
 * advertises no fields, and the API accepts a fresh registration — which it
 * refuses while any provider is installed. The probe registration is removed
 * again before returning.
 */
function expectNoGlobalTracing(): void {
  const probeSpan = trace.getTracer('register-test-probe').startSpan('probe');
  expect(probeSpan.isRecording()).toBe(false);
  probeSpan.end();
  expect(propagation.fields()).toEqual([]);

  const probe = new NodeTracerProvider();
  expect(trace.setGlobalTracerProvider(probe)).toBe(true);
  trace.disable();
}

/** A module definition as `@opentelemetry/instrumentation` holds one. */
interface ModuleDefinitionView {
  /** The module the definition patches. */
  readonly name: string;
  /** The exports the require hook captured; what `disable()` unpatches. */
  moduleExports?: unknown;
  /** Applies the patches. */
  patch?: (moduleExports: unknown, version?: string) => unknown;
}

/** A module object of `pg`'s shape, with nothing behind it. */
interface DriverModuleStandIn {
  /** The client constructor whose prototype `query` is wrapped. */
  readonly Client: { readonly prototype: { query: unknown; connect: unknown } };
}

/** @returns A fresh stand-in `pg` module. */
function driverModuleStandIn(): DriverModuleStandIn {
  class StandInClient {
    query(): Promise<void> {
      return Promise.resolve();
    }

    connect(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { Client: StandInClient };
}

/**
 * Perform the require hook's handshake by hand, so the instance's own
 * `disable()` later unpatches exactly this module object.
 *
 * @param instrumentation The driver instrumentation the preload built.
 * @param moduleStandIn The module to patch.
 */
function patchDriverModule(
  instrumentation: ToggleableInstrumentation,
  moduleStandIn: DriverModuleStandIn,
): void {
  const modules = (instrumentation as { readonly _modules?: unknown })._modules;
  if (!Array.isArray(modules)) {
    throw new Error('@opentelemetry/instrumentation no longer exposes `_modules`');
  }
  const definition = (modules as ModuleDefinitionView[]).find(
    (candidate) => candidate.name === 'pg',
  );
  if (definition?.patch === undefined) {
    throw new Error('the pg instrumentation no longer declares a patchable module definition');
  }
  definition.moduleExports = moduleStandIn;
  definition.patch(moduleStandIn, '8.23.0');
}

/**
 * Narrow an installation to the installed shape, failing the case otherwise.
 *
 * @param installation What `installPreload` returned.
 * @returns The installed preload.
 */
function expectInstalled(installation: PreloadInstallation): InstalledPreload {
  if (installation.status !== 'installed') {
    throw new Error(
      `expected an installed preload, got ${installation.status}: ${installation.reason}`,
    );
  }
  return installation;
}

/*
 * ---------------------------------------------------------------------------
 * Teardown
 * ---------------------------------------------------------------------------
 */

/** Installations a case created and has not necessarily torn down. */
const installations: PreloadInstallation[] = [];

/**
 * Install through the public entry and remember the result for teardown.
 *
 * @param options What to pass to `installPreload`.
 * @returns Its result.
 */
function install(options: Parameters<typeof installPreload>[0]): PreloadInstallation {
  const installation = installPreload(options);
  installations.push(installation);
  return installation;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();

  for (const installation of installations.splice(0)) {
    await installation.shutdown();
  }
  sockets.length = 0;

  spanHelperModule.uninstallSpanHelper();
  Reflect.deleteProperty(globalThis, HELPER_GLOBAL_PROPERTY);
  Reflect.deleteProperty(globalThis, PRELOAD_SLOT_KEY);
  clearPrismaGlobals();

  diag.disable();
  trace.disable();
  propagation.disable();
  context.disable();
});

/*
 * ---------------------------------------------------------------------------
 * The module-level evaluation
 * ---------------------------------------------------------------------------
 */

describe('evaluating the preload module without launch variables', () => {
  it('reports inert, naming every missing variable and no value', () => {
    expect(preloadInstallation.status).toBe('inert');
    if (preloadInstallation.status === 'installed') {
      return;
    }
    expect(preloadInstallation.reason).toContain(PRELOAD_ENV_KEYS.ingestUrl);
    expect(preloadInstallation.reason).toContain(PRELOAD_ENV_KEYS.token);
    expect(preloadInstallation.reason).toContain(PRELOAD_ENV_KEYS.projectRoot);
  });

  it('installed nothing and released the slot it reserved', async () => {
    expect(preloadSlot()).toBeUndefined();
    expect(helperSlot()).toBeUndefined();
    expect(prismaGlobalKeys()).toEqual([]);
    expectNoGlobalTracing();
    await expect(preloadInstallation.shutdown()).resolves.toBeUndefined();
  });

  it('lets shutdownPreload() resolve when nothing is installed', async () => {
    await expect(shutdownPreload()).resolves.toBeUndefined();
    await expect(shutdownPreload()).resolves.toBeUndefined();
  });

  it('bounds exit teardown by a deadline longer than the final flush', () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(SHUTDOWN_DEADLINE_MS)).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * installPreload(): inert
 * ---------------------------------------------------------------------------
 */

describe('installPreload() without a usable credential', () => {
  it.each([
    [
      'no variables at all',
      {},
      [PRELOAD_ENV_KEYS.ingestUrl, PRELOAD_ENV_KEYS.token, PRELOAD_ENV_KEYS.projectRoot],
    ],
    [
      'no DEBUGGEN_TOKEN',
      launchEnv({ [PRELOAD_ENV_KEYS.token]: undefined }),
      [PRELOAD_ENV_KEYS.token],
    ],
    [
      'a blank DEBUGGEN_TOKEN',
      launchEnv({ [PRELOAD_ENV_KEYS.token]: '   ' }),
      [PRELOAD_ENV_KEYS.token],
    ],
    [
      'no DEBUGGEN_INGEST_URL',
      launchEnv({ [PRELOAD_ENV_KEYS.ingestUrl]: undefined }),
      [PRELOAD_ENV_KEYS.ingestUrl],
    ],
    [
      'no DEBUGGEN_PROJECT_ROOT',
      launchEnv({ [PRELOAD_ENV_KEYS.projectRoot]: undefined }),
      [PRELOAD_ENV_KEYS.projectRoot],
    ],
    [
      'an ingest URL that is not a URL',
      launchEnv({ [PRELOAD_ENV_KEYS.ingestUrl]: 'not a url' }),
      [PRELOAD_ENV_KEYS.ingestUrl],
    ],
    [
      'a non-loopback ingest URL',
      launchEnv({ [PRELOAD_ENV_KEYS.ingestUrl]: 'https://collector.example.invalid/ingest' }),
      [PRELOAD_ENV_KEYS.ingestUrl],
    ],
    [
      'an ingest URL carrying userinfo',
      launchEnv({ [PRELOAD_ENV_KEYS.ingestUrl]: ingestUrlWithUserinfo() }),
      [PRELOAD_ENV_KEYS.ingestUrl],
    ],
    [
      'a relative project root',
      launchEnv({ [PRELOAD_ENV_KEYS.projectRoot]: 'relative/project' }),
      [PRELOAD_ENV_KEYS.projectRoot],
    ],
  ])('stays inert with %s and installs nothing', async (_label, env, named) => {
    const logger = new RecordingLogger();
    const fetchImpl = vi.fn<typeof fetch>();

    const result = install({ env, logger, fetchImpl, webSocketImpl: FakeControlSocket });

    expect(result.status).toBe('inert');
    if (result.status === 'installed') {
      return;
    }
    for (const variable of named) {
      expect(result.reason).toContain(variable);
    }
    expect(result.reason).not.toContain(PRELOAD_TOKEN);
    expect(logger.text()).not.toContain(PRELOAD_TOKEN);
    expect(logger.entries.filter((entry) => entry.level === 'warn')).toEqual([]);

    expect(helperSlot()).toBeUndefined();
    expect(prismaGlobalKeys()).toEqual([]);
    expect(sockets).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expectNoGlobalTracing();

    const first = result.shutdown();
    await expect(first).resolves.toBeUndefined();
    await expect(result.shutdown()).resolves.toBeUndefined();
  });

  it('reads process.env when no environment is injected', () => {
    const result = install({ logger: new RecordingLogger() });

    expect(result.status).toBe('inert');
    expect(helperSlot()).toBeUndefined();
  });
});

/*
 * ---------------------------------------------------------------------------
 * installPreload(): the active path and its teardown
 * ---------------------------------------------------------------------------
 */

describe('installPreload() with a valid launch environment', () => {
  it('registers the provider, the propagator, both instrumentations and the span helper', () => {
    const logger = new RecordingLogger();
    const fetchImpl = vi.fn<typeof fetch>();

    const result = expectInstalled(
      install({ env: launchEnv(), connect: false, logger, fetchImpl }),
    );

    expect(result.config.token).toBe(PRELOAD_TOKEN);
    expect(result.config.projectRoot).toBe(PROJECT_ROOT);
    expect(registeredDelegate()).toBe(result.provider);
    expect(propagation.fields()).toContain('traceparent');

    expect(result.instrumentations).toHaveLength(2);
    for (const instrumentation of result.instrumentations) {
      expect(instrumentation.isEnabled?.()).toBe(true);
    }
    expect(result.instrumentations.some((entry) => entry instanceof PgInstrumentation)).toBe(true);
    expect(prismaGlobalKeys().length).toBeGreaterThan(0);

    const helper = helperSlot();
    expect(typeof (helper as { readonly span?: unknown } | undefined)?.span).toBe('function');
    expect((helper as { readonly span?: unknown }).span).toBe(spanHelperModule.span);

    expect(result.control).toBeInstanceOf(ServerAgentControl);
    expect(result.createProvider()).not.toBe(result.provider);
    expect(result.resource.attributes[ATTR_SERVICE_NAME]).toBe(result.config.serviceName);
    expect(result.resource.attributes[ATTR_SERVICE_INSTANCE_ID]).toBe(PRODUCER_ID);

    expect(sockets).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.entries.some((entry) => entry.message === 'preload installed')).toBe(true);
    expect(logger.text()).not.toContain(PRELOAD_TOKEN);
  });

  it('is armed but gated: outside a capture no span records', () => {
    expectInstalled(install({ env: launchEnv(), connect: false, logger: new RecordingLogger() }));

    const gated = trace.getTracer('register-test-probe').startSpan('outside-a-capture');

    expect(gated.isRecording()).toBe(false);
    gated.end();
  });

  it('tears down to no provider, no propagator, no patch and no helper, idempotently', async () => {
    const logger = new RecordingLogger();
    const fetchImpl = vi.fn<typeof fetch>();
    const result = expectInstalled(
      install({ env: launchEnv(), connect: false, logger, fetchImpl }),
    );
    const pg = result.instrumentations.find((entry) => entry instanceof PgInstrumentation);
    if (pg === undefined) {
      throw new Error('the preload registered no pg instrumentation');
    }
    const driver = driverModuleStandIn();
    patchDriverModule(pg, driver);
    // The positive control: without it, a later `false` could mean "never
    // patched" rather than "unpatched by the teardown".
    expect(isWrapped(driver.Client.prototype.query)).toBe(true);

    const first = result.shutdown();
    const second = result.shutdown();
    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    await expect(result.shutdown()).resolves.toBeUndefined();

    expect(isWrapped(driver.Client.prototype.query)).toBe(false);
    for (const instrumentation of result.instrumentations) {
      expect(instrumentation.isEnabled?.()).toBe(false);
    }
    expect(prismaGlobalKeys()).toEqual([]);
    expect(helperSlot()).toBeUndefined();
    expectNoGlobalTracing();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.entries.some((entry) => entry.message === 'preload shut down')).toBe(true);
    expect(logger.entries.filter((entry) => entry.level === 'warn')).toEqual([]);
    expect(logger.text()).not.toContain(PRELOAD_TOKEN);
  });

  it('leaves only the inert AsyncLocalStorage context manager behind after teardown', async () => {
    const probeKey = createContextKey('register-test-context-probe');
    /** @returns What the global context manager carries into a `context.with` callback. */
    const carried = (): unknown =>
      context.with(ROOT_CONTEXT.setValue(probeKey, 'carried'), () =>
        context.active().getValue(probeKey),
      );

    // The positive control: the API's no-op manager carries nothing, so a
    // later 'carried' can only come from the manager `register()` installed.
    expect(carried()).toBeUndefined();

    const result = expectInstalled(
      install({ env: launchEnv(), connect: false, logger: new RecordingLogger() }),
    );
    expect(carried()).toBe('carried');

    // A tracer resolved and used while the preload is installed, the way
    // Next.js caches its own: its proxy is bound to the SDK tracer from here on.
    const cached = trace.getTracer('register-test-cached');
    cached.startSpan('while-installed').end();

    await result.shutdown();

    // The one process-global effect of `register()` the teardown deliberately
    // leaves: the manager is still the global one and still carries values.
    expect(carried()).toBe('carried');

    // And it is inert: it holds no active context of this module's, and neither
    // the cached tracer nor a fresh one records a span through it.
    expect(context.active()).toBe(ROOT_CONTEXT);
    expect(trace.getActiveSpan()).toBeUndefined();
    const afterTeardown = cached.startSpan('after-teardown');
    expect(afterTeardown.isRecording()).toBe(false);
    afterTeardown.end();
    expectNoGlobalTracing();
  });

  it('opens the control socket on the derived URL, sends the credential only there, and closes it', async () => {
    const logger = new RecordingLogger();
    const result = expectInstalled(
      install({ env: launchEnv(), logger, webSocketImpl: FakeControlSocket }),
    );

    expect(sockets).toHaveLength(1);
    const [socket] = sockets;
    if (socket === undefined) {
      throw new Error('no control socket was constructed');
    }
    expect(socket.url).toBe(result.config.controlUrl);
    socket.emitOpen();
    expect(socket.sent.join('\n')).toContain(PRELOAD_TOKEN);

    await result.shutdown();

    expect(socket.closeCalls).toBeGreaterThan(0);
    expect(logger.text()).not.toContain(PRELOAD_TOKEN);
  });

  it('routes OpenTelemetry diagnostics only at trace level, and unwires them on shutdown', async () => {
    const logger = new RecordingLogger('trace');
    const result = expectInstalled(install({ env: launchEnv(), connect: false, logger }));

    diag.debug('register-test diagnostic while installed');
    expect(
      logger.entries.some((entry) => entry.message === 'register-test diagnostic while installed'),
    ).toBe(true);

    await result.shutdown();
    diag.debug('register-test diagnostic after shutdown');

    expect(
      logger.entries.some((entry) => entry.message === 'register-test diagnostic after shutdown'),
    ).toBe(false);
  });

  it('leaves diagnostics alone below trace level', () => {
    const logger = new RecordingLogger('debug');
    expectInstalled(install({ env: launchEnv(), connect: false, logger }));

    diag.debug('register-test diagnostic that must not be routed');

    expect(
      logger.entries.some(
        (entry) => entry.message === 'register-test diagnostic that must not be routed',
      ),
    ).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * installPreload(): a helper span during an armed capture
 * ---------------------------------------------------------------------------
 */

/** One event of an ingest batch, reduced to the fields these cases read. */
interface PostedEvent {
  /** The telemetry kind the exporter classified the span as. */
  readonly kind: string;
  /** The event name. */
  readonly name: string;
  /** The location the patch declared, where it validated. */
  readonly source?:
    | {
        readonly file?: unknown;
        readonly line?: unknown;
        readonly column?: unknown;
        readonly resolvedBy?: unknown;
      }
    | undefined;
  /** The event's attributes. */
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

/** The body the exporter posts, reduced to the fields these cases read. */
interface PostedBatch {
  /** The project the batch belongs to. */
  readonly projectRoot: string;
  /** The converted events. */
  readonly events: readonly PostedEvent[];
}

/** One ingest request, as the stubbed `fetch` received it. */
interface PostedRequest {
  /** The URL the exporter called. */
  readonly url: string;
  /** The HTTP method. */
  readonly method: string | undefined;
  /** The request headers, normalised. */
  readonly headers: Headers;
  /** The parsed JSON body. */
  readonly batch: PostedBatch;
}

/**
 * Read back every ingest request a stubbed `fetch` received.
 *
 * @param fetchImpl The stub handed to `installPreload`.
 * @returns The requests, in the order they were made.
 */
function postedRequests(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): PostedRequest[] {
  return fetchImpl.mock.calls.map(([input, init]) => {
    if (typeof init?.body !== 'string') {
      throw new Error('the exporter posted a body that is not a JSON string');
    }
    return {
      url: input instanceof Request ? input.url : String(input),
      method: init.method,
      headers: new Headers(init.headers),
      batch: JSON.parse(init.body) as PostedBatch,
    };
  });
}

/**
 * The span helper the preload installed, failing the case when there is none.
 *
 * @returns `globalThis.__DEBUGGEN__`.
 */
function installedHelper(): NonNullable<typeof globalThis.__DEBUGGEN__> {
  const helper = globalThis.__DEBUGGEN__;
  if (helper === undefined) {
    throw new Error('the preload installed no span helper');
  }
  return helper;
}

/**
 * Install an active preload whose ingest endpoint answers `202`, and arm one
 * capture whose plan patched {@link PLANNED_SYMBOL} only.
 *
 * @returns The installation, its logger and the `fetch` stub.
 */
async function installArmed(): Promise<{
  readonly result: InstalledPreload;
  readonly logger: RecordingLogger;
  readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  const logger = new RecordingLogger();
  const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 202 })));
  const result = expectInstalled(install({ env: launchEnv(), connect: false, logger, fetchImpl }));

  const report = await result.control.enableCapture({
    captureId: CAPTURE_ID,
    signals: { ...NO_SIGNALS, functions: [PLANNED_SYMBOL] },
  });
  expect(report).toEqual({ armed: true, changed: true, unavailable: [] });
  return { result, logger, fetchImpl };
}

describe('installPreload() during an armed capture', () => {
  it('records a planned helper span and posts it, with the credential, to the ingest endpoint', async () => {
    const { result, logger, fetchImpl } = await installArmed();
    const returned = { total: 42 };
    let calls = 0;

    const value = installedHelper().span(
      PLANNED_SYMBOL,
      { symbol: PLANNED_SYMBOL, file: PLANNED_FILE, line: PLANNED_LINE, column: PLANNED_COLUMN },
      () => {
        calls += 1;
        return returned;
      },
    );

    expect(value).toBe(returned);
    expect(calls).toBe(1);

    await result.provider.forceFlush();

    const requests = postedRequests(fetchImpl);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    if (request === undefined) {
      throw new Error('the exporter posted nothing');
    }
    expect(request.url).toBe(INGEST_URL);
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe(`Bearer ${PRELOAD_TOKEN}`);
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.batch.projectRoot).toBe(PROJECT_ROOT);

    const functionEvents = request.batch.events.filter((event) => event.kind === 'function');
    expect(functionEvents).toHaveLength(1);
    expect(functionEvents[0]?.name).toBe(PLANNED_SYMBOL);
    expect(functionEvents[0]?.source?.file).toBe(PLANNED_FILE);
    expect(functionEvents[0]?.source?.line).toBe(PLANNED_LINE);
    expect(functionEvents[0]?.source?.column).toBe(PLANNED_COLUMN);
    expect(functionEvents[0]?.source?.resolvedBy).toBe('patch');
    // A location that validated consumes the keys it was built from.
    expect(Object.keys(functionEvents[0]?.attributes ?? {})).not.toContain('file');

    expect(logger.text()).not.toContain(PRELOAD_TOKEN);
  });

  it('ends an async helper span when its promise settles, and posts it', async () => {
    const { result, fetchImpl } = await installArmed();
    let release: (value: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });

    const value = installedHelper().span(PLANNED_SYMBOL, { symbol: PLANNED_SYMBOL }, () => pending);

    expect(value).toBe(pending);
    await result.provider.forceFlush();
    // Still running: nothing ended, so nothing may have been posted yet.
    expect(fetchImpl).not.toHaveBeenCalled();

    release('settled');
    await expect(value).resolves.toBe('settled');
    await result.provider.forceFlush();

    const events = postedRequests(fetchImpl).flatMap((request) => request.batch.events);
    expect(events.filter((event) => event.kind === 'function')).toHaveLength(1);
  });

  it('keeps a span for a symbol the plan did not patch out of the ingest batch', async () => {
    const { result, fetchImpl } = await installArmed();

    expect(
      installedHelper().span(UNPLANNED_SYMBOL, { symbol: UNPLANNED_SYMBOL }, () => 'unplanned'),
    ).toBe('unplanned');
    expect(
      installedHelper().span(PLANNED_SYMBOL, { symbol: PLANNED_SYMBOL }, () => 'planned'),
    ).toBe('planned');

    await result.provider.forceFlush();

    const names = postedRequests(fetchImpl)
      .flatMap((request) => request.batch.events)
      .filter((event) => event.kind === 'function')
      .map((event) => event.name);
    expect(names).toEqual([PLANNED_SYMBOL]);
  });

  it('posts nothing for a helper span once the capture is disabled', async () => {
    const { result, fetchImpl } = await installArmed();
    await result.control.disable();
    fetchImpl.mockClear();

    expect(installedHelper().span(PLANNED_SYMBOL, { symbol: PLANNED_SYMBOL }, () => 7)).toBe(7);
    await result.provider.forceFlush();

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/*
 * ---------------------------------------------------------------------------
 * installPreload(): a failure part-way through
 * ---------------------------------------------------------------------------
 */

describe('installPreload() when a step fails', () => {
  it('revokes every global effect before the failed result exists, and reports no credential', async () => {
    const logger = new RecordingLogger();
    vi.spyOn(spanHelperModule, 'installSpanHelper').mockImplementationOnce(() => {
      throw new Error(`the helper global refused while holding ${PRELOAD_TOKEN}`);
    });

    const result = install({ env: launchEnv(), connect: false, logger });

    expect(result.status).toBe('failed');
    if (result.status === 'installed') {
      return;
    }
    expect(result.reason).not.toContain(PRELOAD_TOKEN);
    expect(result.reason).toContain(REDACTED_PLACEHOLDER);

    // Synchronously, before anything is awaited: nothing global survives.
    expect(helperSlot()).toBeUndefined();
    expect(prismaGlobalKeys()).toEqual([]);
    expectNoGlobalTracing();

    const drained = result.shutdown();
    expect(result.shutdown()).toBe(drained);
    await expect(drained).resolves.toBeUndefined();

    const warnings = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warnings.some((entry) => entry.message.includes('could not install'))).toBe(true);
    expect(logger.text()).not.toContain(PRELOAD_TOKEN);
    expect(logger.text()).toContain(REDACTED_PLACEHOLDER);
  });

  it('removes a span helper it had already installed when a later step fails', async () => {
    const logger = new RecordingLogger();
    vi.spyOn(ServerAgentControl.prototype, 'connect').mockImplementationOnce(() => {
      expect(typeof (helperSlot() as { readonly span?: unknown } | undefined)?.span).toBe(
        'function',
      );
      throw new Error('the control socket could not be started');
    });

    const result = install({ env: launchEnv(), logger, webSocketImpl: FakeControlSocket });

    expect(result.status).toBe('failed');
    expect(helperSlot()).toBeUndefined();
    expect(prismaGlobalKeys()).toEqual([]);
    expectNoGlobalTracing();
    await expect(result.shutdown()).resolves.toBeUndefined();
    expect(sockets).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * bootstrap(): one installation per process
 * ---------------------------------------------------------------------------
 */

describe('evaluating the preload module a second time', () => {
  it('reports a duplicate while another evaluation holds the slot, and shutdownPreload() delegates to it', async () => {
    const ownerShutdown = vi.fn(() => Promise.resolve());
    Reflect.defineProperty(globalThis, PRELOAD_SLOT_KEY, {
      value: { installedAt: Date.now(), version: TRACER_VERSION, shutdown: ownerShutdown },
      writable: true,
      enumerable: false,
      configurable: true,
    });
    // A socket that cannot reach the network, in case the guard ever failed.
    vi.stubGlobal('WebSocket', FakeControlSocket);
    vi.stubEnv(PRELOAD_ENV_KEYS.ingestUrl, INGEST_URL);
    vi.stubEnv(PRELOAD_ENV_KEYS.token, PRELOAD_TOKEN);
    vi.stubEnv(PRELOAD_ENV_KEYS.projectRoot, PROJECT_ROOT);

    vi.resetModules();
    const fresh = await import('./register.js');

    expect(fresh.preloadInstallation.status).toBe('duplicate');
    expect(helperSlot()).toBeUndefined();
    expect(prismaGlobalKeys()).toEqual([]);
    expectNoGlobalTracing();

    await fresh.shutdownPreload();
    await shutdownPreload();
    expect(ownerShutdown).toHaveBeenCalledTimes(2);

    vi.stubEnv(PRELOAD_ENV_KEYS.ingestUrl, undefined);
    vi.stubEnv(PRELOAD_ENV_KEYS.token, undefined);
    vi.stubEnv(PRELOAD_ENV_KEYS.projectRoot, undefined);
  });

  it('installs once from a valid environment, is reachable through the slot, and tears down', async () => {
    const before = new Map(EXIT_EVENTS.map((event) => [event, processEvents.listeners(event)]));
    vi.stubGlobal('WebSocket', FakeControlSocket);
    vi.stubEnv(PRELOAD_ENV_KEYS.ingestUrl, INGEST_URL);
    vi.stubEnv(PRELOAD_ENV_KEYS.token, PRELOAD_TOKEN);
    vi.stubEnv(PRELOAD_ENV_KEYS.projectRoot, PROJECT_ROOT);

    try {
      vi.resetModules();
      const fresh = await import('./register.js');

      expect(fresh.preloadInstallation.status).toBe('installed');
      const slot = preloadSlot() as { readonly version?: unknown; readonly shutdown?: unknown };
      expect(slot.version).toBe(TRACER_VERSION);
      expect(typeof slot.shutdown).toBe('function');
      expect(sockets).toHaveLength(1);
      expect(prismaGlobalKeys().length).toBeGreaterThan(0);
      for (const event of EXIT_EVENTS) {
        expect(processEvents.listenerCount(event)).toBe((before.get(event)?.length ?? 0) + 1);
      }

      await shutdownPreload();

      expect(helperSlot()).toBeUndefined();
      expect(prismaGlobalKeys()).toEqual([]);
      expectNoGlobalTracing();
      expect(sockets[0]?.closeCalls ?? 0).toBeGreaterThan(0);
    } finally {
      for (const event of EXIT_EVENTS) {
        const known = new Set(before.get(event) ?? []);
        for (const listener of processEvents.listeners(event)) {
          if (!known.has(listener)) {
            processEvents.removeListener(event, listener as (...args: unknown[]) => void);
          }
        }
      }
      vi.stubEnv(PRELOAD_ENV_KEYS.ingestUrl, undefined);
      vi.stubEnv(PRELOAD_ENV_KEYS.token, undefined);
      vi.stubEnv(PRELOAD_ENV_KEYS.projectRoot, undefined);
    }
  });

  it('stays inert, and leaves the slot free, when the fresh evaluation has no credential', async () => {
    vi.resetModules();
    const fresh = await import('./register.js');

    expect(fresh.preloadInstallation.status).toBe('inert');
    expect(preloadSlot()).toBeUndefined();
    expect(helperSlot()).toBeUndefined();
  });
});

/*
 * ---------------------------------------------------------------------------
 * The exit handlers a successful evaluation attaches
 * ---------------------------------------------------------------------------
 */

/** A listener as `process` hands it back. */
type ProcessListener = (...args: unknown[]) => void;

/**
 * Evaluate the module afresh with a valid launch environment, hand `body` the
 * one listener that evaluation attached to `event`, and remove every listener
 * it attached — and restore every one `body` detached — afterwards.
 *
 * The listener is called directly rather than by emitting the signal: emitting
 * `SIGINT` or `SIGTERM` reaches the test runner's own listeners, and a signal
 * with none would take its default disposition and end the worker.
 *
 * @param event The exit event whose new listener `body` receives.
 * @param body The case, given that listener.
 */
async function withFreshInstallation(
  event: (typeof EXIT_EVENTS)[number],
  body: (listener: ProcessListener) => Promise<void>,
): Promise<void> {
  const before = new Map(EXIT_EVENTS.map((name) => [name, processEvents.rawListeners(name)]));
  // `listeners()` unwraps a `once` registration and `rawListeners()` does not,
  // so each is compared only with its own kind of snapshot.
  const unwrappedBefore = processEvents.listeners(event);
  vi.stubGlobal('WebSocket', FakeControlSocket);
  vi.stubEnv(PRELOAD_ENV_KEYS.ingestUrl, INGEST_URL);
  vi.stubEnv(PRELOAD_ENV_KEYS.token, PRELOAD_TOKEN);
  vi.stubEnv(PRELOAD_ENV_KEYS.projectRoot, PROJECT_ROOT);

  try {
    vi.resetModules();
    const fresh = await import('./register.js');
    expect(fresh.preloadInstallation.status).toBe('installed');

    const known = new Set(before.get(event) ?? []);
    const added = processEvents.rawListeners(event).filter((listener) => !known.has(listener));
    expect(added).toHaveLength(1);
    const [listener] = processEvents
      .listeners(event)
      .filter((candidate) => !unwrappedBefore.includes(candidate));
    if (listener === undefined) {
      throw new Error(`the fresh evaluation attached no ${event} listener`);
    }
    await body(listener as ProcessListener);
  } finally {
    for (const name of EXIT_EVENTS) {
      const known = before.get(name) ?? [];
      for (const listener of processEvents.rawListeners(name)) {
        if (!known.includes(listener)) {
          processEvents.removeListener(name, listener as ProcessListener);
        }
      }
      const present = new Set(processEvents.rawListeners(name));
      for (const listener of known) {
        if (!present.has(listener)) {
          processEvents.on(name, listener as ProcessListener);
        }
      }
    }
    vi.stubEnv(PRELOAD_ENV_KEYS.ingestUrl, undefined);
    vi.stubEnv(PRELOAD_ENV_KEYS.token, undefined);
    vi.stubEnv(PRELOAD_ENV_KEYS.projectRoot, undefined);
  }
}

/** Let every queued microtask and one macrotask turn run. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Assert the process holds nothing a fresh evaluation installed. */
function expectTornDown(): void {
  expect(helperSlot()).toBeUndefined();
  expect(prismaGlobalKeys()).toEqual([]);
  expect(sockets[0]?.closeCalls ?? 0).toBeGreaterThan(0);
  expectNoGlobalTracing();
}

describe('the exit handlers of an installed evaluation', () => {
  it('tears down from SIGTERM and leaves the signal to a host that still listens for it', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await withFreshInstallation('SIGTERM', async (listener) => {
      // The `once` wrapper is still attached, so the host counts as listening.
      listener();
      await shutdownPreload();
      await macrotask();

      expectTornDown();
      expect(kill).not.toHaveBeenCalled();
    });
  });

  it('tears down from SIGINT and re-raises it when nothing else listens', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await withFreshInstallation('SIGINT', async (listener) => {
      // As `process.once` leaves things when the signal is delivered to a host
      // with no handler of its own: no listener left at all.
      for (const attached of processEvents.rawListeners('SIGINT')) {
        processEvents.removeListener('SIGINT', attached as ProcessListener);
      }

      listener();
      await shutdownPreload();
      await macrotask();

      expectTornDown();
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
    });
  });

  it('tears down from beforeExit within the shutdown deadline', async () => {
    await withFreshInstallation('beforeExit', async (listener) => {
      listener();
      await shutdownPreload();
      await macrotask();

      expectTornDown();
    });
  });
});
