/**
 * Tests for `./control.ts` — the capture gate, the control socket and the
 * teardown that makes the dev-server preload genuinely inert.
 *
 * ## What is on trial
 *
 * AAP §0.5.1 makes cleanup this product's strongest promise: when a session
 * ends, *"what remains is the inert preload module with no active patches, no
 * provider and no file changes, and the application keeps serving"*. The AAP
 * states the evidence for it twice (§0.5.1 and §0.7.1 Group 1) and names four
 * assertions. They are the reason this file exists, and everything else in it
 * is support for them:
 *
 * 1. **A spy processor's `onStart` count stays where it was.** Not "nothing was
 *    exported" and not "nothing was buffered" — *no span was created*. The
 *    mechanism is {@link DebuggenCaptureSampler}: a `NOT_RECORD` decision makes
 *    the SDK's tracer hand back a non-recording span *before* it constructs the
 *    internal span object, so `SpanProcessor.onStart` is never invoked. That is
 *    asserted through two different tracers — one obtained after the teardown,
 *    which exercises `trace.disable()`, and one **captured before** it, which
 *    exercises the sampler and is the shape a framework that cached a tracer at
 *    module load actually has. Asserting only the first would let a real
 *    regression through, because a cached tracer is beyond the global's reach.
 * 2. **`pg.Client.prototype.query` is no longer wrapped**, judged by shimmer's
 *    own `isWrapped` marker, with a positive control first so that a `false`
 *    means "unwrapped" rather than "never patched".
 * 3. **The ORM's global instrumentation hook is cleared** — the global key
 *    `@prisma/instrumentation` writes, gone from `globalThis`.
 * 4. **Spans are dropped outside a capture and by disabled signal kind**, so a
 *    plan that asked for no database tracing collects no `db.query` event even
 *    though the driver is still patched (AAP §0.7.1: *"an unrelated plan
 *    collects no backend or database telemetry"*).
 *
 * The end-to-end backstop for the same promise is `tests/e2e/cleanup.spec.ts`,
 * which asserts the demo keeps answering requests after `session.end` with the
 * inert preload still attached, and `scripts/check-no-residual-instrumentation.mjs`,
 * which asserts the developer's tracked source is untouched. This suite is the
 * fast, unit-level guard for it: it runs in milliseconds, with no service, no
 * database and no network, so a regression in the teardown fails here long
 * before it reaches a browser.
 *
 * ## Habits in here, each deliberate
 *
 * - **Everything external is injected, and nothing global is mutated
 *   permanently.** `./control.ts` takes its socket constructor, its jitter
 *   source, its logger, its provider factory, its flush target and its
 *   instrumentations from its caller precisely so this suite needs none of the
 *   real ones. `./exporter.ts` takes its `fetch` for the same reason. No test
 *   here opens a socket, resolves a hostname or writes a file, and none touches
 *   `process.env`: the launch configuration is built by passing a synthesised
 *   environment record to `loadPreloadConfig`.
 * - **The OpenTelemetry API globals are process-wide, so they are torn down
 *   after every test.** `trace.disable()`, `propagation.disable()` and
 *   `context.disable()` run in `afterEach` together with a `dispose()` of every
 *   control object the test built. Without that, a provider leaked by one test
 *   would let the next one pass for the wrong reason — which is the single most
 *   likely way a suite about removing globals could lie.
 * - **Providers are built through the constructor, never mutated.** SDK 2.0
 *   removed `addSpanProcessor()` and `getActiveSpanProcessor()` and made the
 *   provider's resource private, so every provider here is assembled with
 *   `{ resource, sampler, spanProcessors }` and observed through the spy
 *   processor's counters rather than by reading its internals.
 * - **Vocabularies and bounds are imported, never re-typed.** The signal→kind
 *   policy is asserted by iterating the implementation's own `SIGNAL_KINDS`
 *   table against the whole of `TELEMETRY_KINDS`, and the backoff envelope
 *   against `RECONNECT_MIN_MS`/`RECONNECT_MAX_MS`. A signal added to the
 *   implementation, or a kind added to the vocabulary, produces a failure here
 *   rather than an untested branch.
 * - **No literal in this file resembles a credential, and none names an
 *   application.** The control credential is assembled at runtime from short
 *   fragments — this file is tracked, and `scripts/check-secrets.mjs` binds its
 *   entropy rule to key-like names — and every symbol, route and statement below
 *   is neutral vocabulary, because a demo identifier here would misrepresent
 *   what the product knows about any particular project (AAP §0.5.4).
 * - **`pg` is deliberately not a dependency of this package.** The
 *   instrumentations attach to the *host application's* copies, and
 *   `esbuild.node.mjs` keeps them external, so the driver assertion is made
 *   against a module object of the host's shape handed to the real
 *   `PgInstrumentation` through the same `patch` entry point the require hook
 *   uses. A host `pg` that happens to be resolvable is asserted against as
 *   well, in a block that skips with its reason in the test name when it is not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRequire } from 'node:module';

import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
} from '@opentelemetry/api';
import type { Context, SpanContext } from '@opentelemetry/api';
import { isWrapped } from '@opentelemetry/instrumentation';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { PrismaInstrumentation } from '@prisma/instrumentation';

import { ID_PREFIXES, newSpanId, newTraceId } from '@debuggen/shared';
import type { HrTime, LogFields, Logger, LogLevel, LogLevelSetting } from '@debuggen/shared';

import { TELEMETRY_KINDS } from '../schema/kinds.js';
import type { TelemetryKind } from '../schema/kinds.js';
import {
  CONTROL_PATH,
  loadPreloadConfig,
  PRELOAD_ENV_KEYS,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  TRACER_NAME,
  TRACER_VERSION,
} from './config.js';
import type { PreloadConfig } from './config.js';
import {
  ANY_SIGNAL_KINDS,
  computeReconnectDelayMs,
  CONTROL_CLIENT_KIND,
  CONTROL_CLOSE_UNAUTHORIZED,
  CONTROL_MESSAGE_TYPES,
  DebuggenCaptureSampler,
  NO_SIGNALS,
  ServerAgentControl,
  SIGNAL_KINDS,
} from './control.js';
import type {
  ControlFlushTarget,
  ControlSocket,
  ControlSocketCloseEvent,
  ControlSocketConstructor,
  ControlSocketMessageEvent,
  ServerAgentSignalName,
  ServerAgentSignals,
  ToggleableInstrumentation,
  TracerProviderFactory,
} from './control.js';
import {
  classifySpan,
  DB_INSTRUMENTATION_SCOPES,
  DB_SPAN_NAME_PREFIXES,
  NEXT_SPAN_TYPE_ATTRIBUTE,
  NEXT_SPAN_TYPES,
} from './convert.js';
import { DebuggenSpanProcessor } from './exporter.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 *
 * Neutral by construction: no value below names a component, service function
 * or route of any particular project, and the credential is assembled rather
 * than written.
 * ---------------------------------------------------------------------------
 */

/** Host and port of the imaginary local service every fixture points at. */
const SERVICE_AUTHORITY = '127.0.0.1:43117';

/** The complete ingest endpoint, as the launcher exports it. */
const INGEST_URL = `http://${SERVICE_AUTHORITY}/telemetry/ingest`;

/** The control URL `./config.ts` derives from {@link INGEST_URL}'s origin. */
const CONTROL_URL = `ws://${SERVICE_AUTHORITY}${CONTROL_PATH}`;

/** An absolute project root that belongs to no particular project. */
const PROJECT_ROOT = '/tmp/debuggen-fixture/sample-project';

/**
 * The server-agent credential this suite drives the control object with.
 *
 * Assembled at runtime from short fragments, on purpose: this file is tracked
 * and `scripts/check-secrets.mjs` measures the entropy of long dense literals
 * bound to key-like names. It is long enough that a partial echo in a log line
 * would still be obvious, and it is asserted *absent* from every diagnostic the
 * failure paths produce (see the privacy test).
 */
const CONTROL_TOKEN = ['dbg', 'fixture', 'credential', 'q'.repeat(28)].join('-');

/** The placeholder `./control.ts` writes wherever the credential would appear. */
const REDACTED_PLACEHOLDER = '[redacted]';

/** A capture id: the sequence scope every case that does not vary it uses. */
const CAPTURE_A = `${ID_PREFIXES.capture}_${'a'.repeat(16)}`;

/** A second capture id, for the transition and re-enable cases. */
const CAPTURE_B = `${ID_PREFIXES.capture}_${'b'.repeat(16)}`;

/** A session id, for the cases that assert it reaches the gate. */
const SESSION_ID = `${ID_PREFIXES.session}_${'c'.repeat(16)}`;

/** The shape `newMessageId()` produces, which the hello frame must carry. */
const MESSAGE_ID_PATTERN = new RegExp(`^${ID_PREFIXES.message}_[0-9a-z]{16}$`, 'u');

/** A W3C `traceparent`: version, 32-hex trace id, 16-hex span id, flags. */
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u;

/** The name every span this suite starts through a tracer is given. */
const SPAN_NAME = 'sampleOperation';

/** The patched symbol a `function` span reports, and the plan's function list. */
const FUNCTION_SYMBOL = 'sampleOperation';

/** A route template that belongs to no particular project. */
const REQUEST_ROUTE = '/api/example';

/** Request vocabulary for the server-tier span fixtures. */
const REQUEST_METHOD = 'GET';

/** A parameterized statement: placeholders only, never an inline literal. */
const DB_STATEMENT = 'SELECT id, label FROM widgets WHERE owner_id = $1 LIMIT $2';

/** An absolute target for the outgoing-request span fixture. */
const OUTGOING_URL = 'https://example.invalid/v1/resource';

/** The npm package name of the database driver the instrumentation patches. */
const DRIVER_MODULE_NAME = 'pg';

/** A version in the driver instrumentation's supported range. */
const DRIVER_MODULE_VERSION = '8.23.0';

/**
 * The global key `@prisma/instrumentation` writes its tracing helper to.
 *
 * Observed in the installed `@prisma/instrumentation@7.10.0`
 * (`dist/index.mjs`): `enable()` writes **both** `PRISMA_INSTRUMENTATION` and
 * the major-versioned `V7_PRISMA_INSTRUMENTATION`, and `disable()` deletes
 * both. The assertions below match on this substring rather than on either
 * exact spelling, so an upgrade that changes the version prefix keeps working
 * and an upgrade that renames the key altogether fails the *positive control*
 * — which is the legible failure, because it says the hook was never installed
 * rather than that it was never removed.
 */
const PRISMA_GLOBAL_KEY_FRAGMENT = 'PRISMA_INSTRUMENTATION';

/** An ordinary abnormal close: the code a dropped connection reports. */
const SOCKET_CLOSE_ABNORMAL = 1006;

/** `WebSocket.CONNECTING`, `OPEN` and `CLOSED`, spelled as numbers. */
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

/** Every signal name, restated so a signal added to the implementation fails. */
const SIGNAL_NAMES: readonly ServerAgentSignalName[] = Object.freeze([
  'http',
  'routeHandlers',
  'fetch',
  'prisma',
  'pg',
  'functions',
]);

/** Every signal on, including one patched symbol. */
const ALL_SIGNALS: ServerAgentSignals = Object.freeze({
  http: true,
  routeHandlers: true,
  fetch: true,
  prisma: true,
  pg: true,
  functions: Object.freeze([FUNCTION_SYMBOL]),
});

/**
 * Incoming request spans only — the AAP's "unrelated plan" on this tier, and
 * the signal set the kind-filter assertions are written against.
 */
const HTTP_ONLY_SIGNALS: ServerAgentSignals = Object.freeze({
  ...NO_SIGNALS,
  http: true,
});

/**
 * A signal set with exactly one signal on.
 *
 * Built member by member rather than with a computed-key spread so the result
 * is typed as {@link ServerAgentSignals} instead of widening to a record of
 * booleans.
 *
 * @param name The signal to enable.
 * @returns The signal set.
 */
function onlySignal(name: ServerAgentSignalName): ServerAgentSignals {
  const flags: Record<Exclude<ServerAgentSignalName, 'functions'>, boolean> = {
    http: false,
    routeHandlers: false,
    fetch: false,
    prisma: false,
    pg: false,
  };
  if (name !== 'functions') {
    flags[name] = true;
  }
  return Object.freeze({
    ...flags,
    functions: name === 'functions' ? Object.freeze([FUNCTION_SYMBOL]) : NO_SIGNALS.functions,
  });
}

/**
 * The environment the launcher exports into an instrumented dev server.
 *
 * A fresh record per call, and never `process.env`: `./config.ts` takes the
 * environment as a parameter for exactly this reason, so no test here has to
 * mutate — or restore — the real one.
 *
 * @param overrides Values to replace or remove.
 * @returns An environment record.
 */
function preloadEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  return {
    [PRELOAD_ENV_KEYS.ingestUrl]: INGEST_URL,
    [PRELOAD_ENV_KEYS.token]: CONTROL_TOKEN,
    [PRELOAD_ENV_KEYS.projectRoot]: PROJECT_ROOT,
    ...overrides,
  };
}

/**
 * The validated launch configuration every harness is built on.
 *
 * Produced by the real loader rather than hand-written, so a change to the
 * configuration contract reaches this suite through the same door the preload
 * uses.
 *
 * @returns The active configuration.
 */
function activeConfig(): PreloadConfig {
  const result = loadPreloadConfig(preloadEnv());
  if (result.mode !== 'active') {
    throw new Error(`the fixture environment did not produce an active config: ${result.reason}`);
  }
  return result.config;
}

/*
 * ---------------------------------------------------------------------------
 * Doubles
 *
 * Each one implements the narrow structural interface `./control.ts` or
 * `./exporter.ts` declares for it, so none of them needs a cast — which is the
 * property those interfaces exist for.
 * ---------------------------------------------------------------------------
 */

/** One line a diagnostic produced, as the recording logger keeps it. */
interface LogEntry {
  /** The severity the call site chose. */
  readonly level: LogLevel;
  /** The message, after the module's credential scrub. */
  readonly message: string;
  /** The structured fields, where the call site passed any. */
  readonly fields?: LogFields | undefined;
}

/**
 * A logger that keeps every record instead of printing it.
 *
 * Its whole purpose is the privacy assertion: the credential must not reach a
 * diagnostic on any path, and the only way to establish that is to hold every
 * line the module wrote and search all of them. Children share the parent's
 * store, because a record written through a child is just as public.
 */
class RecordingLogger implements Logger {
  /** Records everything; the threshold is not what this suite is testing. */
  readonly level: LogLevelSetting = 'trace';

  /** Every record written through this logger or any child of it. */
  readonly entries: LogEntry[];

  /**
   * @param entries The store to append to; a child receives its parent's.
   */
  constructor(entries: LogEntry[] = []) {
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
    return new RecordingLogger(this.entries);
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

/**
 * Everything a logger recorded, as one searchable string.
 *
 * Field values are serialised too, because a credential that leaked into a
 * field rather than into a message would be just as visible in a developer's
 * terminal.
 *
 * @param logger The recording logger.
 * @returns Every message and every field, concatenated.
 */
function logText(logger: RecordingLogger): string {
  return logger.entries
    .map((entry) =>
      entry.fields === undefined
        ? `${entry.level} ${entry.message}`
        : `${entry.level} ${entry.message} ${JSON.stringify(entry.fields)}`,
    )
    .join('\n');
}

/**
 * A span processor that counts the four hooks and does nothing else.
 *
 * `onStart` is the counter the whole teardown is judged by, and counting is
 * deliberately all it does: the assertion is about whether the SDK *called*
 * it, so any behaviour beyond a `+= 1` would only add ways for the measurement
 * to be wrong.
 */
class SpySpanProcessor implements SpanProcessor {
  /** Spans the SDK constructed and started. */
  onStartCount = 0;

  /** Spans the SDK finished. */
  onEndCount = 0;

  /** Flushes requested, by the provider or by a caller. */
  forceFlushCount = 0;

  /** Shutdowns requested — the provider's `shutdown()` forwards one. */
  shutdownCount = 0;

  onStart(span: Span, parentContext: Context): void {
    // The signature is the interface's; neither argument is needed to count,
    // and both are referenced so the file stays clean under `noUnusedParameters`.
    void span;
    void parentContext;
    this.onStartCount += 1;
  }

  onEnd(span: ReadableSpan): void {
    void span;
    this.onEndCount += 1;
  }

  forceFlush(): Promise<void> {
    this.forceFlushCount += 1;
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.shutdownCount += 1;
    return Promise.resolve();
  }
}

/** Options of {@link RecordingFlushTarget}. */
interface RecordingFlushTargetOptions {
  /** A failure to raise from `forceFlush`, for the resilience cases. */
  readonly failOnFlush?: Error | undefined;
}

/**
 * The span processor as `./control.ts` sees it: something to flush before the
 * teardown.
 *
 * It carries a `shutdown` counter the control object has no way to reach —
 * {@link ControlFlushTarget} declares only `forceFlush` — so that
 * `shutdownCount === 0` records the documented division of responsibility: the
 * processor outlives every enable/disable cycle, and `control.ts` flushes it
 * rather than shutting it down.
 */
class RecordingFlushTarget implements ControlFlushTarget {
  /** Flushes requested by the teardown. */
  forceFlushCount = 0;

  /** Shutdowns requested; must stay at zero. */
  shutdownCount = 0;

  readonly #options: RecordingFlushTargetOptions;

  /**
   * @param options An optional flush failure.
   */
  constructor(options: RecordingFlushTargetOptions = {}) {
    this.#options = options;
  }

  forceFlush(): Promise<void> {
    this.forceFlushCount += 1;
    const failure = this.#options.failOnFlush;
    return failure === undefined ? Promise.resolve() : Promise.reject(failure);
  }

  shutdown(): Promise<void> {
    this.shutdownCount += 1;
    return Promise.resolve();
  }
}

/** Options of {@link RecordingInstrumentation}. */
interface RecordingInstrumentationOptions {
  /** A failure to raise from `enable()`. */
  readonly failOnEnable?: Error | undefined;
  /** A failure to raise from `disable()`, for the resilience case. */
  readonly failOnDisable?: Error | undefined;
}

/**
 * An instrumentation that records its toggles, and optionally refuses one.
 *
 * Stands in for `PgInstrumentation` and `PrismaInstrumentation` wherever the
 * assertion is about the *order and completeness* of the teardown rather than
 * about what those two did to the process. The real instances are used where
 * that distinction matters, in the two cases immediately concerned with
 * unwrapping the driver and clearing the ORM's global hook.
 */
class RecordingInstrumentation implements ToggleableInstrumentation {
  /** How many times the patches were re-applied. */
  enableCount = 0;

  /** How many times the patches were removed. */
  disableCount = 0;

  readonly #options: RecordingInstrumentationOptions;

  /**
   * @param options Optional failures to raise.
   */
  constructor(options: RecordingInstrumentationOptions = {}) {
    this.#options = options;
  }

  enable(): void {
    this.enableCount += 1;
    const failure = this.#options.failOnEnable;
    if (failure !== undefined) {
      throw failure;
    }
  }

  disable(): void {
    this.disableCount += 1;
    const failure = this.#options.failOnDisable;
    if (failure !== undefined) {
      throw failure;
    }
  }
}

/**
 * A control socket that goes nowhere.
 *
 * It records what was sent and exposes the three events the module reacts to,
 * so the whole handshake — including the terminal 4401 path and the reconnect
 * envelope — is driven without a service, a port or a timer that waits on one.
 */
class FakeControlSocket implements ControlSocket {
  /** The URL the module constructed this socket for. */
  readonly url: string;

  /** `0` connecting, `1` open, `3` closed. */
  readyState = SOCKET_CONNECTING;

  /** Every frame the module sent, in order, as the raw text. */
  readonly sent: string[] = [];

  /** Every close the module initiated, with the code and reason it chose. */
  readonly closes: { readonly code?: number | undefined; readonly reason?: string | undefined }[] =
    [];

  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: ControlSocketMessageEvent) => void) | null = null;
  onclose: ((event: ControlSocketCloseEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  /**
   * @param url The URL the module passed to the constructor.
   */
  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = SOCKET_CLOSED;
    this.closes.push({ code, reason });
  }

  /** Open the connection, as the transport would. */
  emitOpen(): void {
    this.readyState = SOCKET_OPEN;
    this.onopen?.({});
  }

  /**
   * Deliver one inbound frame.
   *
   * @param data The frame body; a string for the text frames this channel uses.
   */
  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  /**
   * Close the connection from the peer's side.
   *
   * @param code The close code.
   * @param reason The peer's reason, where it gave one.
   */
  emitClose(code: number, reason?: string): void {
    this.readyState = SOCKET_CLOSED;
    this.onclose?.(reason === undefined ? { code } : { code, reason });
  }

  /** Report a transport error, which a close always follows. */
  emitError(): void {
    this.onerror?.({});
  }

  /** The frames sent so far, parsed. */
  frames(): ParsedFrame[] {
    return this.sent.map((frame) => parseFrame(frame));
  }
}

/** One construction of a control socket. */
interface SocketConstruction {
  /** Every argument the module passed, so an extra one cannot go unnoticed. */
  readonly args: readonly unknown[];
}

/** A socket constructor plus the record of what it built. */
interface SocketRig {
  /** The constructor to inject as `webSocketImpl`. */
  readonly Socket: ControlSocketConstructor;
  /** Every socket built, in order. */
  readonly sockets: FakeControlSocket[];
  /** Every construction, with its arguments. */
  readonly constructions: SocketConstruction[];
}

/**
 * Create a socket constructor bound to a fresh record.
 *
 * The record is captured in a closure rather than held statically, so two
 * harnesses in one test cannot see each other's sockets.
 *
 * @returns The rig.
 */
function createSocketRig(): SocketRig {
  const sockets: FakeControlSocket[] = [];
  const constructions: SocketConstruction[] = [];

  const Socket = class RecordedControlSocket extends FakeControlSocket {
    constructor(...args: readonly unknown[]) {
      const [url] = args;
      super(typeof url === 'string' ? url : '');
      constructions.push(Object.freeze({ args: Object.freeze([...args]) }));
      sockets.push(this);
    }
  };

  return { Socket, sockets, constructions };
}

/** One call the exporter made to its injected `fetch`. */
interface FetchCall {
  /** The first argument: the endpoint, verbatim. */
  readonly input: RequestInfo | URL;
  /** The second argument: method, headers, body and signal. */
  readonly init?: RequestInit | undefined;
}

/** An injected `fetch` plus the record of what it was asked to send. */
interface FetchRig {
  /** The implementation to inject as `fetchImpl`. */
  readonly impl: typeof fetch;
  /** Every call, in order. */
  readonly calls: FetchCall[];
}

/**
 * Create a `fetch` that accepts everything and reaches nothing.
 *
 * `204 No Content` rather than `200`: the exporter reads only the status and
 * releases the body, and an empty response is the honest shape of an ingest
 * acknowledgement.
 *
 * @returns The rig.
 */
function createFetchRig(): FetchRig {
  const calls: FetchCall[] = [];
  const impl: typeof fetch = (input, init) => {
    calls.push(init === undefined ? { input } : { input, init });
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  return { impl, calls };
}

/*
 * ---------------------------------------------------------------------------
 * Reading what travelled
 *
 * Frames and ingest bodies arrive as JSON text, so every reader below narrows
 * from `unknown` rather than asserting a shape: a malformed frame is something
 * these tests are entitled to assert *about*, which it could not be if the
 * reader assumed it away.
 * ---------------------------------------------------------------------------
 */

/** One outbound frame, decoded. */
interface ParsedFrame {
  /** The envelope's own keys, sorted, so an extra one is visible. */
  readonly keys: readonly string[];
  /** The message name. */
  readonly type: unknown;
  /** The message id. */
  readonly id: unknown;
  /** The timestamp, in epoch milliseconds. */
  readonly ts: unknown;
  /** The body, as a record; an empty one when the frame carried none. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Decode one frame the module sent.
 *
 * @param raw The frame text.
 * @returns The decoded frame.
 */
function parseFrame(raw: string): ParsedFrame {
  const decoded: unknown = JSON.parse(raw);
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('a control frame was not a JSON object');
  }
  const record = decoded as Readonly<Record<string, unknown>>;
  const payload = record.payload;
  return {
    keys: Object.keys(record).sort(),
    type: record.type,
    id: record.id,
    ts: record.ts,
    payload:
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Readonly<Record<string, unknown>>)
        : {},
  };
}

/** The ingest body of AAP §0.4.2, as much of it as these tests read. */
interface IngestBody {
  /** The credential's project root. */
  readonly projectRoot?: unknown;
  /** The events the conversion produced. */
  readonly events?: readonly Readonly<Record<string, unknown>>[];
}

/**
 * Decode the body of one ingest POST.
 *
 * @param call The recorded `fetch` call.
 * @returns The decoded body.
 */
function ingestBodyOf(call: FetchCall): IngestBody {
  const body = call.init?.body;
  if (typeof body !== 'string') {
    throw new Error('the exporter posted a body that was not serialised JSON text');
  }
  const decoded: unknown = JSON.parse(body);
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('the exporter posted a body that was not a JSON object');
  }
  // No assertion needed: every member of `IngestBody` is optional and
  // `unknown`-typed, so the narrowed object satisfies it, and each reader below
  // still has to narrow the member it wants.
  return decoded;
}

/**
 * The `seq` of every event in one ingest POST, in the order it was sent.
 *
 * The sequence is the only externally visible consequence of a capture
 * transition — `./convert.ts`'s allocator is keyed on `(producerId, captureId)`
 * and restarts when the id changes — so reading it off the wire is how this
 * suite asserts the transition without reaching into private state.
 *
 * @param call The recorded `fetch` call.
 * @returns The sequence numbers.
 */
function sequenceNumbersOf(call: FetchCall): unknown[] {
  return (ingestBodyOf(call).events ?? []).map((event) => event.seq);
}

/**
 * The endpoint one `fetch` call was aimed at, whichever form it took.
 *
 * @param call The recorded call.
 * @returns The URL as a string.
 */
function requestUrlOf(call: FetchCall): string {
  const { input } = call;
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

/**
 * The `Authorization` header one `fetch` call carried, if any.
 *
 * @param call The recorded call.
 * @returns The header value, or `undefined`.
 */
function authorizationOf(call: FetchCall): string | undefined {
  const headers = call.init?.headers;
  if (headers === undefined) {
    return undefined;
  }
  return new Headers(headers).get('authorization') ?? undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Span fixtures
 *
 * One builder, one cast. The member set is `@opentelemetry/sdk-trace-base`
 * 2.11.0's `ReadableSpan`, including the 2.x spellings `parentSpanContext` and
 * `instrumentationScope`, and every kind-specific builder is expressed through
 * the constant tables `./convert.ts` exports, so a framework or driver whose
 * span shape the implementation stops recognising fails the classification
 * case below rather than silently changing what these drop counts mean.
 * ---------------------------------------------------------------------------
 */

/** A present-day start time, as the SDK hands one over. */
const SPAN_START: HrTime = [1_700_000_000, 123_456_789];

/** {@link SPAN_START} plus 10 ms. */
const SPAN_END: HrTime = [1_700_000_000, 133_456_789];

/** The relative duration the SDK also records for the same 10 ms. */
const SPAN_DURATION: HrTime = [0, 10_000_000];

/** What a case says about a span; everything else is defaulted. */
interface SpanFixture {
  /** The span's display name. */
  readonly name?: string;
  /** The span's kind. */
  readonly kind?: SpanKind;
  /** The span's attributes. */
  readonly attributes?: Readonly<Record<string, unknown>>;
  /** The instrumentation scope that created it. */
  readonly scope?: string;
  /** The status code. */
  readonly status?: SpanStatusCode;
}

/**
 * The single cast boundary of this suite.
 *
 * A `ReadableSpan` is an interface, so a structurally complete object is one;
 * confining the assertion to this function keeps every other line type-checked
 * against the real interface.
 *
 * @param fixture What this span should say.
 * @returns A finished span.
 */
function makeSpan(fixture: SpanFixture = {}): ReadableSpan {
  const spanContext: SpanContext = {
    traceId: newTraceId(),
    spanId: newSpanId(),
    traceFlags: TraceFlags.SAMPLED,
  };

  const span: Record<string, unknown> = {
    name: fixture.name ?? SPAN_NAME,
    kind: fixture.kind ?? SpanKind.INTERNAL,
    spanContext: (): SpanContext => spanContext,
    startTime: SPAN_START,
    endTime: SPAN_END,
    duration: SPAN_DURATION,
    status: { code: fixture.status ?? SpanStatusCode.UNSET },
    attributes: fixture.attributes ?? {},
    links: [],
    events: [],
    ended: true,
    resource: { attributes: {} },
    instrumentationScope: {
      name: fixture.scope ?? 'third-party-instrumentation',
      version: '1.0.0',
    },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };

  return span as unknown as ReadableSpan;
}

/** The framework's incoming-request span → `http.server`. */
function serverRequestSpan(): ReadableSpan {
  return makeSpan({
    name: `${REQUEST_METHOD} ${REQUEST_ROUTE}`,
    kind: SpanKind.SERVER,
    attributes: {
      [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.request,
      'http.request.method': REQUEST_METHOD,
      'http.route': REQUEST_ROUTE,
    },
  });
}

/** The framework's App Router route-handler span → `route.handler`. */
function routeHandlerSpan(): ReadableSpan {
  return makeSpan({
    name: `executing api route (app) ${REQUEST_ROUTE}`,
    attributes: { [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.appRouteHandler },
  });
}

/** An outgoing server-side request → `http.client`. */
function outgoingRequestSpan(): ReadableSpan {
  return makeSpan({
    name: `fetch ${REQUEST_METHOD} ${OUTGOING_URL}`,
    kind: SpanKind.CLIENT,
    attributes: {
      [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.serverFetch,
      'url.full': OUTGOING_URL,
    },
  });
}

/** The driver instrumentation's query span → `db.query`. */
function databaseQuerySpan(): ReadableSpan {
  return makeSpan({
    name: `${DB_SPAN_NAME_PREFIXES.driver}:SELECT`,
    kind: SpanKind.CLIENT,
    scope: DB_INSTRUMENTATION_SCOPES.driver,
    attributes: { 'db.statement': DB_STATEMENT, 'db.system': 'postgresql' },
  });
}

/** A span the product's own helper created for a patched symbol → `function`. */
function patchedFunctionSpan(): ReadableSpan {
  return makeSpan({ name: FUNCTION_SYMBOL, scope: TRACER_NAME });
}

/*
 * ---------------------------------------------------------------------------
 * The harness
 *
 * `./control.ts` documents the wiring `register.ts` performs: construct the
 * control object, build the processor and the sampler around it as their gate,
 * hand over a provider *factory*, and only then connect. The harness performs
 * exactly that sequence — a test that wired it differently would be asserting
 * against a configuration the product never runs.
 * ---------------------------------------------------------------------------
 */

/** What a test varies about a harness. */
interface HarnessOptions {
  /**
   * The instrumentations to adopt, assumed **enabled** on arrival exactly as
   * `registerInstrumentations()` leaves them. Defaults to two recording fakes.
   */
  readonly instrumentations?: readonly ToggleableInstrumentation[];
  /** The flush target; defaults to a fresh {@link RecordingFlushTarget}. */
  readonly flushTarget?: RecordingFlushTarget;
  /** The jitter source for the reconnect envelope; defaults to the midpoint. */
  readonly random?: () => number;
}

/** One wired control object and everything it was wired to. */
interface Harness {
  /** The validated launch configuration. */
  readonly config: PreloadConfig;
  /** The object under test. */
  readonly control: ServerAgentControl;
  /** Every diagnostic it wrote. */
  readonly log: RecordingLogger;
  /** The span processor every provider this harness builds is given. */
  readonly spans: SpySpanProcessor;
  /** The flush target the teardown flushes. */
  readonly flush: RecordingFlushTarget;
  /** The instrumentations it was given. */
  readonly instrumentations: readonly ToggleableInstrumentation[];
  /** The socket constructor and the record of what it built. */
  readonly sockets: SocketRig;
  /** How many providers the factory has been asked for. */
  providerBuilds(): number;
  /**
   * Arm a capture the way a `server-agent.config` frame with a capture id does.
   *
   * @param captureId The capture window.
   * @param signals The signals to admit.
   * @returns Whether anything changed.
   */
  arm(captureId: string, signals: ServerAgentSignals): Promise<boolean>;
}

/** Every harness a test built, disposed of in `afterEach`. */
const harnesses: Harness[] = [];

/**
 * Wire a control object with doubles for everything external.
 *
 * @param options What to vary.
 * @returns The harness, already registered for teardown.
 */
function createHarness(options: HarnessOptions = {}): Harness {
  const config = activeConfig();
  const log = new RecordingLogger();
  const spans = new SpySpanProcessor();
  const flush = options.flushTarget ?? new RecordingFlushTarget();
  const instrumentations = options.instrumentations ?? [
    new RecordingInstrumentation(),
    new RecordingInstrumentation(),
  ];
  const sockets = createSocketRig();
  let builds = 0;

  const control = new ServerAgentControl({
    config,
    logger: log,
    webSocketImpl: sockets.Socket,
    // The midpoint of the jitter band by default, so a delay assertion reads as
    // the backoff base rather than as a sample.
    random: options.random ?? ((): number => 0.5),
  });

  // The circularity the module documents: the sampler's gate is the control
  // object, so the factory can only be built once that object exists.
  const createProvider: TracerProviderFactory = () => {
    builds += 1;
    return new NodeTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName }),
      sampler: new DebuggenCaptureSampler(control),
      spanProcessors: [spans],
    });
  };

  control.attach({ processor: flush, instrumentations, createProvider });

  const harness: Harness = {
    config,
    control,
    log,
    spans,
    flush,
    instrumentations,
    sockets,
    providerBuilds: (): number => builds,
    arm: (captureId: string, signals: ServerAgentSignals): Promise<boolean> =>
      control.enableCapture({ captureId, signals }),
  };

  harnesses.push(harness);
  return harness;
}

/** Every processor a test built, shut down in `afterEach`. */
const processors: DebuggenSpanProcessor[] = [];

/** A real span processor and the record of what it tried to post. */
interface ProcessorRig {
  /** The processor under the harness's gate. */
  readonly processor: DebuggenSpanProcessor;
  /** Every ingest POST it attempted. */
  readonly fetches: FetchCall[];
}

/**
 * A real span processor sharing a harness's control object as its gate.
 *
 * The drop rules live in `./exporter.ts` and the state they consult lives in
 * `./control.ts`, so the only honest way to assert the gate's effect is to put
 * the two together and drive `onEnd`.
 *
 * @param harness The harness whose control object gates the processor.
 * @returns The processor and the record of what it tried to post.
 */
function createProcessorRig(harness: Harness): ProcessorRig {
  const fetchRig = createFetchRig();
  const processor = new DebuggenSpanProcessor({
    gate: harness.control,
    config: harness.config,
    logger: harness.log,
    fetchImpl: fetchRig.impl,
  });
  processors.push(processor);
  return { processor, fetches: fetchRig.calls };
}

/**
 * One socket a harness's control object constructed.
 *
 * @param harness The harness.
 * @param index Which construction to read; the first by default.
 * @returns The socket.
 */
function socketOf(harness: Harness, index = 0): FakeControlSocket {
  const socket = harness.sockets.sockets[index];
  if (socket === undefined) {
    throw new Error(`the control object constructed no socket at index ${String(index)}`);
  }
  return socket;
}

/**
 * Let the module's internal promise chain settle.
 *
 * `./control.ts` serialises every state change through one chain, and a config
 * frame that arrives on the socket is applied from inside a handler that
 * cannot be awaited. Draining microtasks is enough — every step in the chain
 * is resolved by a double here, so nothing waits on a timer — and it keeps
 * these assertions independent of whether a test installed fake timers.
 *
 * @param ticks How many microtask turns to yield; generous by default.
 */
async function settle(ticks = 50): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    await Promise.resolve();
  }
}

/*
 * ---------------------------------------------------------------------------
 * The two real instrumentations
 *
 * These helpers exist because the assertions about `pg` and the ORM are about
 * what those instrumentation instances did to the *process*, which a fake
 * cannot stand in for.
 * ---------------------------------------------------------------------------
 */

/** A module definition as `@opentelemetry/instrumentation` holds one. */
interface ModuleDefinitionView {
  /** The module the definition patches. */
  readonly name: string;
  /** The exports the require hook captured, set by the hook and read by `disable()`. */
  moduleExports?: unknown;
  /** Applies the patches. */
  patch?: (moduleExports: unknown, version?: string) => unknown;
  /** Removes them; this is what `disable()` calls. */
  unpatch?: (moduleExports: unknown, version?: string) => unknown;
}

/**
 * The module definitions an instrumentation built in its constructor.
 *
 * The one cast in this section, and a deliberate one: `InstrumentationBase`
 * keeps its definitions in the protected `_modules`, `disable()` acts on *those*
 * objects, and `init()` would hand back fresh ones that the teardown would
 * never touch. Reaching for the real list is therefore what makes the
 * assertion about the real teardown; guarding the shape here means an
 * upgrade that renames the member fails with this sentence rather than with an
 * unreadable type error.
 *
 * @param instrumentation The instrumentation instance.
 * @returns Its module definitions.
 */
function moduleDefinitionsOf(instrumentation: object): ModuleDefinitionView[] {
  const view = instrumentation as { readonly _modules?: unknown };
  const modules = view._modules;
  if (!Array.isArray(modules)) {
    throw new Error(
      '@opentelemetry/instrumentation no longer exposes its module definitions as `_modules`',
    );
  }
  return modules as ModuleDefinitionView[];
}

/** The members of `pg` the driver instrumentation wraps. */
interface DriverClientStandIn {
  /** `Client.prototype`, whose `query` is the method under assertion. */
  readonly prototype: {
    query: unknown;
    connect: unknown;
  };
}

/** A module object of `pg`'s shape, for an instrumentation to patch. */
interface DriverModuleStandIn {
  /** The client constructor. */
  readonly Client: DriverClientStandIn;
}

/**
 * A module object shaped like `pg`, with nothing behind it.
 *
 * `pg` is not a dependency of this package — the instrumentations attach to the
 * host application's copies and `esbuild.node.mjs` keeps them external — so the
 * driver assertion is made against this, handed to the real instrumentation
 * through the same `patch` entry point the require hook uses. Nothing here
 * connects to anything: the methods exist only to be wrapped and unwrapped.
 *
 * @returns A fresh stand-in module.
 */
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
 * Perform the require hook's handshake by hand: record the module exports on
 * the definition, then patch them.
 *
 * Recording `moduleExports` is the part that matters for the teardown —
 * `InstrumentationBase.disable()` unpatches exactly the module objects its
 * definitions remember — so a patch applied without it would look wrapped and
 * never be unwrapped, and the assertion would fail for the wrong reason.
 *
 * @param instrumentation The driver instrumentation.
 * @param moduleStandIn The module object to patch.
 */
function patchDriverModule(
  instrumentation: PgInstrumentation,
  moduleStandIn: DriverModuleStandIn,
): void {
  const definition = moduleDefinitionsOf(instrumentation).find(
    (candidate) => candidate.name === DRIVER_MODULE_NAME,
  );
  if (definition?.patch === undefined) {
    throw new Error(
      `@opentelemetry/instrumentation-pg no longer declares a patchable "${DRIVER_MODULE_NAME}" module definition`,
    );
  }
  definition.moduleExports = moduleStandIn;
  definition.patch(moduleStandIn, DRIVER_MODULE_VERSION);
}

/**
 * Whether a value carries shimmer's own wrap marker.
 *
 * `isWrapped` from `@opentelemetry/instrumentation` is the published predicate
 * and is what the assertions use. It reads `__wrapped === true`, the property
 * shimmer defines on a wrapper — the separate `shimmer` package is no longer a
 * dependency of the instrumentation library (0.222.0 vendors it), so there is
 * nothing else to import. This helper asserts the marker directly alongside
 * it, so a future change to the predicate cannot quietly make "unwrapped" mean
 * "unmeasurable".
 *
 * @param candidate The method to inspect.
 * @returns Whether it is a shimmer wrapper.
 */
function hasShimmerMarker(candidate: unknown): boolean {
  return (
    typeof candidate === 'function' && (candidate as { __wrapped?: unknown }).__wrapped === true
  );
}

/** The `globalThis` keys the ORM instrumentation's hook occupies. */
function prismaGlobalKeys(): string[] {
  return Object.keys(globalThis).filter((key) => key.includes(PRISMA_GLOBAL_KEY_FRAGMENT));
}

/** Remove the ORM instrumentation's global hook, whatever a test left behind. */
function clearPrismaGlobals(): void {
  const view = globalThis as unknown as Record<string, unknown>;
  for (const key of prismaGlobalKeys()) {
    delete view[key];
  }
}

/** Resolves modules the way a module inside this package would. */
const requireFromSuite = createRequire(import.meta.url);

/**
 * The host application's own `pg`, if one happens to be resolvable here.
 *
 * Normally `null`: `pg` is deliberately absent from this package's
 * dependencies (AAP §0.3.2), which is the whole reason the driver assertion is
 * made against a stand-in module and the end-to-end guarantee is covered by
 * `tests/e2e/cleanup.spec.ts` against a real dev server. Where a workspace
 * hoist does make it resolvable, the extra case below asserts against the real
 * prototype as well.
 *
 * @returns The module, or `null` when it cannot be resolved or loaded.
 */
function resolveHostDriverModule(): DriverModuleStandIn | null {
  try {
    const loaded: unknown = requireFromSuite(DRIVER_MODULE_NAME);
    if (typeof loaded !== 'object' || loaded === null) {
      return null;
    }
    const client = (loaded as { readonly Client?: unknown }).Client;
    if (typeof client !== 'function') {
      return null;
    }
    return loaded as DriverModuleStandIn;
  } catch {
    // Not resolvable from this package, which is the expected state.
    return null;
  }
}

/** Resolved once: the skip decision must be the same for every case. */
const HOST_DRIVER_MODULE = resolveHostDriverModule();

/*
 * ---------------------------------------------------------------------------
 * Teardown
 *
 * The OpenTelemetry API globals are process-wide and this suite registers
 * providers on purpose, so every test hands the process back as it found it.
 * Without this, a provider leaked by one test would let a later one pass for
 * the wrong reason.
 * ---------------------------------------------------------------------------
 */

afterEach(async () => {
  vi.useRealTimers();

  for (const harness of [...harnesses].reverse()) {
    await harness.control.dispose();
  }
  harnesses.length = 0;

  for (const processor of processors) {
    await processor.shutdown();
  }
  processors.length = 0;

  // `dispose()` removes the tracer provider and the propagator itself; these
  // calls cover a test that registered one without a control object, and the
  // context manager, which `register()` installs and the product's teardown
  // deliberately leaves alone (it produces no spans).
  trace.disable();
  propagation.disable();
  context.disable();

  clearPrismaGlobals();
});

/*
 * ---------------------------------------------------------------------------
 * The launch configuration these tests run on
 * ---------------------------------------------------------------------------
 */

describe('the launch configuration the control object is driven with', () => {
  it('comes from an injected environment record and never from process.env', () => {
    const config = activeConfig();

    expect(config.ingestUrl).toBe(INGEST_URL);
    expect(config.controlUrl).toBe(CONTROL_URL);
    expect(config.projectRoot).toBe(PROJECT_ROOT);
    expect(config.token).toBe(CONTROL_TOKEN);

    // The credential exists only inside this suite: nothing here exported it,
    // and nothing here may depend on the real process having one.
    expect(process.env[PRELOAD_ENV_KEYS.token]).not.toBe(CONTROL_TOKEN);
  });

  it('names every signal the implementation maps to a kind', () => {
    expect([...SIGNAL_NAMES].sort()).toEqual(Object.keys(SIGNAL_KINDS).sort());
  });

  it('builds span fixtures of the kinds the conversion classifies them as', () => {
    expect(classifySpan(serverRequestSpan())).toEqual({ kind: 'http.server', tier: 'server' });
    expect(classifySpan(routeHandlerSpan())).toEqual({ kind: 'route.handler', tier: 'server' });
    expect(classifySpan(outgoingRequestSpan())).toEqual({ kind: 'http.client', tier: 'server' });
    expect(classifySpan(databaseQuerySpan())).toEqual({ kind: 'db.query', tier: 'db' });
    expect(classifySpan(patchedFunctionSpan())).toEqual({ kind: 'function', tier: 'server' });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The headline: after the teardown, no span is created at all
 * ---------------------------------------------------------------------------
 */

describe('the teardown leaves the process unable to create a span', () => {
  it('counts a started span while a capture is armed and none after the teardown', async () => {
    const harness = createHarness();

    await expect(harness.arm(CAPTURE_A, ALL_SIGNALS)).resolves.toBe(true);
    expect(harness.providerBuilds()).toBe(1);
    expect(harness.control.stats().providerRegistered).toBe(true);

    // Taken now and kept for the rest of the test: the shape a framework that
    // called `trace.getTracer(…)` at module load has, and the case
    // `trace.disable()` alone cannot cover.
    const cachedTracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);

    const armedSpan = cachedTracer.startSpan(SPAN_NAME);
    expect(armedSpan.isRecording()).toBe(true);

    const armedCarrier: Record<string, string> = {};
    propagation.inject(trace.setSpan(context.active(), armedSpan), armedCarrier);
    expect(armedCarrier.traceparent).toMatch(TRACEPARENT_PATTERN);

    armedSpan.end();
    expect(harness.spans.onStartCount).toBe(1);
    expect(harness.spans.onEndCount).toBe(1);

    const providerWhileArmed = trace.getTracerProvider();

    await harness.control.disable();

    expect(harness.control.captureId).toBeNull();
    expect(harness.control.stats().providerRegistered).toBe(false);
    expect(harness.control.stats().instrumentationsEnabled).toBe(false);
    // The global registration is gone: the API hands back a different provider
    // object than the one it was answering with while a provider was installed.
    expect(trace.getTracerProvider()).not.toBe(providerWhileArmed);

    const freshSpan = trace.getTracer(TRACER_NAME, TRACER_VERSION).startSpan(SPAN_NAME);
    freshSpan.end();
    const cachedSpan = cachedTracer.startSpan(SPAN_NAME);
    cachedSpan.end();

    expect(freshSpan.isRecording()).toBe(false);
    expect(cachedSpan.isRecording()).toBe(false);

    // The assertion this file exists for: not "nothing was exported" but
    // nothing was even constructed, through either tracer.
    expect(harness.spans.onStartCount).toBe(1);
    expect(harness.spans.onEndCount).toBe(1);

    const carrierAfter: Record<string, string> = {};
    propagation.inject(trace.setSpan(context.active(), cachedSpan), carrierAfter);
    expect(carrierAfter).toEqual({});
    expect(propagation.fields()).toEqual([]);
  });

  it('stops a cached tracer at the sampler, before the queued teardown has run', async () => {
    const harness = createHarness();
    await harness.arm(CAPTURE_A, ALL_SIGNALS);

    const cachedTracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
    cachedTracer.startSpan(SPAN_NAME).end();
    expect(harness.spans.onStartCount).toBe(1);

    // A disable instruction closes the gate *synchronously*, ahead of the
    // queue, so everything between this line and the first `await` observes a
    // process whose provider is still registered and whose instrumentations are
    // still patched in. Anything that stops recording here is the sampler.
    const pending = harness.control.applyConfig({ signals: NO_SIGNALS });

    expect(harness.control.captureId).toBeNull();
    expect(harness.control.stats().providerRegistered).toBe(true);
    expect(harness.control.stats().instrumentationsEnabled).toBe(true);

    const gatedSpan = cachedTracer.startSpan(SPAN_NAME);
    expect(gatedSpan.isRecording()).toBe(false);
    gatedSpan.end();
    expect(harness.spans.onStartCount).toBe(1);

    await expect(pending).resolves.toBe('disabled');
    expect(harness.control.stats().providerRegistered).toBe(false);
  });

  it('flushes what was captured before it removes anything', async () => {
    const harness = createHarness();
    await harness.arm(CAPTURE_A, ALL_SIGNALS);

    await harness.control.disable();

    // Evidence already captured still reaches the service; the processor itself
    // survives the cycle, and `ControlFlushTarget` gives the control object no
    // way to shut it down (the provider's own `shutdown()` is what ends a
    // processor's life, in `register.ts`'s wiring rather than here).
    expect(harness.flush.forceFlushCount).toBe(1);
    expect(harness.flush.shutdownCount).toBe(0);
    expect(harness.control.stats().failures).toBe(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The patches the instrumentations installed are removed
 * ---------------------------------------------------------------------------
 */

describe('the teardown removes the instrumentation patches', () => {
  it('unwraps the driver query method it wrapped', async () => {
    const instrumentation = new PgInstrumentation();
    const moduleStandIn = driverModuleStandIn();
    patchDriverModule(instrumentation, moduleStandIn);

    // The positive control: without it, a later `false` could mean the method
    // was never patched rather than that the teardown unwrapped it.
    expect(isWrapped(moduleStandIn.Client.prototype.query)).toBe(true);
    expect(hasShimmerMarker(moduleStandIn.Client.prototype.query)).toBe(true);
    expect(instrumentation.isEnabled()).toBe(true);

    const harness = createHarness({ instrumentations: [instrumentation] });
    await harness.arm(CAPTURE_A, ALL_SIGNALS);
    expect(isWrapped(moduleStandIn.Client.prototype.query)).toBe(true);

    await harness.control.disable();

    expect(isWrapped(moduleStandIn.Client.prototype.query)).toBe(false);
    expect(hasShimmerMarker(moduleStandIn.Client.prototype.query)).toBe(false);
    expect(instrumentation.isEnabled()).toBe(false);
  });

  it('unwraps the driver even when the session never captured anything', async () => {
    const instrumentation = new PgInstrumentation();
    const moduleStandIn = driverModuleStandIn();
    patchDriverModule(instrumentation, moduleStandIn);

    // No capture is ever armed: `registerInstrumentations()` patched the driver
    // at preload, so a session that ends without reproducing anything must
    // still leave the developer's process unwrapped.
    const harness = createHarness({ instrumentations: [instrumentation] });
    expect(harness.control.captureId).toBeNull();

    await harness.control.disable();

    expect(isWrapped(moduleStandIn.Client.prototype.query)).toBe(false);
    expect(instrumentation.isEnabled()).toBe(false);
  });

  it.skipIf(HOST_DRIVER_MODULE === null)(
    "unwraps a real `pg` module too, where one is resolvable from this package (skipped when it is not: `pg` is deliberately absent from this package's dependencies, and tests/e2e/cleanup.spec.ts is the end-to-end backstop against a real dev server)",
    async () => {
      const hostModule = HOST_DRIVER_MODULE;
      expect(hostModule).not.toBeNull();
      if (hostModule === null) {
        return;
      }

      const instrumentation = new PgInstrumentation();
      patchDriverModule(instrumentation, hostModule);
      expect(isWrapped(hostModule.Client.prototype.query)).toBe(true);

      const harness = createHarness({ instrumentations: [instrumentation] });
      await harness.arm(CAPTURE_A, ALL_SIGNALS);
      await harness.control.disable();

      expect(isWrapped(hostModule.Client.prototype.query)).toBe(false);
      expect(hasShimmerMarker(hostModule.Client.prototype.query)).toBe(false);
    },
  );

  it("clears the ORM instrumentation's global hook", async () => {
    expect(prismaGlobalKeys()).toEqual([]);

    const instrumentation = new PrismaInstrumentation();

    // Observed in @prisma/instrumentation 7.10.0: `enable()` writes
    // `globalThis.PRISMA_INSTRUMENTATION` and `globalThis.V7_PRISMA_INSTRUMENTATION`.
    // A rename in a future release fails this positive control first, which is
    // the legible failure.
    expect(prismaGlobalKeys().length).toBeGreaterThan(0);
    expect(prismaGlobalKeys()).toContain(PRISMA_GLOBAL_KEY_FRAGMENT);
    expect(instrumentation.isEnabled()).toBe(true);

    const harness = createHarness({ instrumentations: [instrumentation] });
    await harness.arm(CAPTURE_A, ALL_SIGNALS);
    expect(instrumentation.isEnabled()).toBe(true);

    await harness.control.disable();

    expect(prismaGlobalKeys()).toEqual([]);
    expect(instrumentation.isEnabled()).toBe(false);
  });

  it('is idempotent: a second teardown does nothing a second time', async () => {
    const driver = new RecordingInstrumentation();
    const orm = new RecordingInstrumentation();
    const harness = createHarness({ instrumentations: [driver, orm] });

    await harness.arm(CAPTURE_A, ALL_SIGNALS);
    await harness.control.disable();
    const afterFirst = harness.control.stats();

    await harness.control.disable();

    expect(harness.control.stats()).toEqual(afterFirst);
    expect(afterFirst.disableCount).toBe(1);
    expect(driver.disableCount).toBe(1);
    expect(orm.disableCount).toBe(1);
    expect(harness.flush.forceFlushCount).toBe(1);
  });

  it('disables the second instrumentation even when the first one throws', async () => {
    const failure = new Error(`the driver refused to unwrap while holding ${CONTROL_TOKEN}`);
    const failing = new RecordingInstrumentation({ failOnDisable: failure });
    const healthy = new RecordingInstrumentation();
    const harness = createHarness({ instrumentations: [failing, healthy] });

    await harness.arm(CAPTURE_A, ALL_SIGNALS);
    const cachedTracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);

    await expect(harness.control.disable()).resolves.toBeUndefined();

    // Every step after the failure still ran: AAP §0.5.1 requires cleanup to be
    // reliable, so one broken step must not abort the ones behind it.
    expect(failing.disableCount).toBe(1);
    expect(healthy.disableCount).toBe(1);
    expect(harness.control.stats().failures).toBe(1);
    expect(harness.control.stats().providerRegistered).toBe(false);
    expect(harness.control.stats().instrumentationsEnabled).toBe(false);
    expect(cachedTracer.startSpan(SPAN_NAME).isRecording()).toBe(false);
    expect(propagation.fields()).toEqual([]);
    expect(logText(harness.log)).not.toContain(CONTROL_TOKEN);
  });

  it('completes the teardown when the pre-teardown flush fails', async () => {
    const driver = new RecordingInstrumentation();
    const harness = createHarness({
      instrumentations: [driver],
      flushTarget: new RecordingFlushTarget({
        failOnFlush: new Error('the local service refused the final batch'),
      }),
    });

    await harness.arm(CAPTURE_A, ALL_SIGNALS);
    await expect(harness.control.disable()).resolves.toBeUndefined();

    expect(harness.flush.forceFlushCount).toBe(1);
    expect(driver.disableCount).toBe(1);
    expect(harness.control.stats().providerRegistered).toBe(false);
    expect(harness.control.stats().failures).toBe(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The gate: nothing outside a capture, and only what the plan asked for
 * ---------------------------------------------------------------------------
 */

describe('the capture gate outside a capture', () => {
  it('reports no capture and refuses every kind in the vocabulary', () => {
    const harness = createHarness();

    expect(harness.control.captureId).toBeNull();
    expect(harness.control.sessionId).toBeNull();
    expect(harness.control.stats().enabledKinds).toEqual([]);
    expect(harness.control.stats().functions).toEqual([]);

    // The whole closed vocabulary, not a sample of it: a kind added to
    // `../schema/kinds.ts` must be refused by a closed gate by default.
    for (const kind of TELEMETRY_KINDS) {
      expect(harness.control.isKindEnabled(kind), `kind ${kind} outside a capture`).toBe(false);
    }
  });

  it('drops an ended span before it is converted, buffered or posted', async () => {
    const harness = createHarness();
    const rig = createProcessorRig(harness);

    rig.processor.onEnd(serverRequestSpan());

    const stats = rig.processor.stats();
    expect(stats.endedCount).toBe(1);
    expect(stats.droppedNoCapture).toBe(1);
    expect(stats.droppedByKind).toBe(0);
    expect(stats.convertedCount).toBe(0);
    expect(stats.buffered).toBe(0);
    expect(rig.processor.bufferedCount).toBe(0);
    expect(rig.fetches).toHaveLength(0);

    // Not even a flush can produce a request: nothing was queued to send.
    await rig.processor.forceFlush();
    expect(rig.fetches).toHaveLength(0);
    expect(rig.processor.stats().postedBatches).toBe(0);
  });

  it('drops a span that ends after the teardown, though it started inside a capture', async () => {
    const harness = createHarness();
    const rig = createProcessorRig(harness);
    await harness.arm(CAPTURE_A, ALL_SIGNALS);

    const span = serverRequestSpan();
    await harness.control.disable();
    rig.processor.onEnd(span);

    expect(rig.processor.stats().droppedNoCapture).toBe(1);
    expect(rig.processor.stats().convertedCount).toBe(0);
    expect(rig.fetches).toHaveLength(0);
  });
});

describe('the capture gate inside a capture', () => {
  it('admits the planned signal and drops every other kind', async () => {
    const harness = createHarness();
    const rig = createProcessorRig(harness);

    await harness.arm(CAPTURE_A, HTTP_ONLY_SIGNALS);

    expect(harness.control.captureId).toBe(CAPTURE_A);
    expect(harness.control.isKindEnabled('http.server')).toBe(true);
    for (const kind of ['route.handler', 'http.client', 'db.query', 'function'] as const) {
      expect(harness.control.isKindEnabled(kind), `kind ${kind} under an http-only plan`).toBe(
        false,
      );
    }

    rig.processor.onEnd(serverRequestSpan());
    rig.processor.onEnd(routeHandlerSpan());
    rig.processor.onEnd(outgoingRequestSpan());
    rig.processor.onEnd(databaseQuerySpan());
    rig.processor.onEnd(patchedFunctionSpan());

    const stats = rig.processor.stats();
    expect(stats.endedCount).toBe(5);
    expect(stats.convertedCount).toBe(1);
    expect(stats.buffered).toBe(1);
    // AAP §0.7.1: an unrelated plan collects no backend or database telemetry,
    // even though the driver and the framework are still producing spans.
    expect(stats.droppedByKind).toBe(4);
    expect(stats.droppedNoCapture).toBe(0);
    expect(stats.droppedUnconvertible).toBe(0);
  });

  it('posts what it admitted to the ingest endpoint, with the credential', async () => {
    const harness = createHarness();
    const rig = createProcessorRig(harness);
    await harness.arm(CAPTURE_A, HTTP_ONLY_SIGNALS);

    rig.processor.onEnd(serverRequestSpan());
    await rig.processor.forceFlush();

    expect(rig.fetches).toHaveLength(1);
    const call = rig.fetches[0];
    expect(call).toBeDefined();
    if (call === undefined) {
      return;
    }

    expect(requestUrlOf(call)).toBe(harness.config.ingestUrl);
    expect(call.init?.method).toBe('POST');
    expect(authorizationOf(call)).toBe(`Bearer ${CONTROL_TOKEN}`);

    const body = ingestBodyOf(call);
    expect(body.projectRoot).toBe(PROJECT_ROOT);
    expect(body.events).toHaveLength(1);
    expect(body.events?.[0]?.kind).toBe('http.server');
    // Attribution is the service's: an ingress event names no session and no
    // capture, whatever the gate knows.
    expect(body.events?.[0]).not.toHaveProperty('captureId');
    expect(body.events?.[0]).not.toHaveProperty('sessionId');
  });

  it('enables exactly the kinds each signal maps to, and nothing else', async () => {
    for (const name of SIGNAL_NAMES) {
      const harness = createHarness();
      await expect(harness.arm(CAPTURE_A, onlySignal(name))).resolves.toBe(true);

      const expected = new Set<TelemetryKind>([...SIGNAL_KINDS[name], ...ANY_SIGNAL_KINDS]);
      for (const kind of TELEMETRY_KINDS) {
        expect(harness.control.isKindEnabled(kind), `signal ${name} -> kind ${kind}`).toBe(
          expected.has(kind),
        );
      }
      expect([...harness.control.stats().enabledKinds].sort()).toEqual([...expected].sort());
    }
  });

  it('admits the union of the signals a full plan asked for, and no browser kind', async () => {
    const harness = createHarness();
    await harness.arm(CAPTURE_A, ALL_SIGNALS);

    const expected = new Set<TelemetryKind>([
      ...SIGNAL_NAMES.flatMap((name) => [...SIGNAL_KINDS[name]]),
      ...ANY_SIGNAL_KINDS,
    ]);
    for (const kind of TELEMETRY_KINDS) {
      expect(harness.control.isKindEnabled(kind), `kind ${kind} under a full plan`).toBe(
        expected.has(kind),
      );
    }

    // The preload produces no browser-tier event whatever the plan says: those
    // come from the page agent, on its own transport.
    for (const kind of ['interaction', 'render', 'commit', 'fetch', 'xhr', 'state'] as const) {
      expect(harness.control.isKindEnabled(kind), `browser kind ${kind}`).toBe(false);
    }
  });

  it('treats an empty function list as no function tracing and a named one as function tracing', async () => {
    const withoutFunctions = createHarness();
    await withoutFunctions.arm(CAPTURE_A, HTTP_ONLY_SIGNALS);
    expect(withoutFunctions.control.isKindEnabled('function')).toBe(false);
    expect(withoutFunctions.control.stats().functions).toEqual([]);

    const withFunctions = createHarness();
    await withFunctions.arm(CAPTURE_B, {
      ...NO_SIGNALS,
      functions: Object.freeze([FUNCTION_SYMBOL]),
    });
    expect(withFunctions.control.isKindEnabled('function')).toBe(true);
    expect(withFunctions.control.stats().functions).toEqual([FUNCTION_SYMBOL]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Applying a `server-agent.config` frame
 * ---------------------------------------------------------------------------
 */

/**
 * Payloads a build of the service could send but this build cannot act on.
 *
 * Each one must be refused *and* leave the previous state exactly as it was:
 * guessing at a frame this build does not understand is how a gate ends up
 * half-open — recording spans nobody asked for, or armed and admitting nothing.
 */
interface InvalidConfigCase {
  /** What is wrong with the payload, used as the assertion's message. */
  readonly description: string;
  /** The payload itself, exactly as a frame would carry it. */
  readonly payload: unknown;
}

const INVALID_CONFIG_PAYLOADS: readonly InvalidConfigCase[] = Object.freeze([
  Object.freeze({ description: 'a payload that is not an object', payload: 'server-agent.config' }),
  Object.freeze({ description: 'a null payload', payload: null }),
  Object.freeze({ description: 'an array payload', payload: [] }),
  Object.freeze({
    description: 'a capture id with no signals at all',
    payload: { captureId: CAPTURE_B },
  }),
  Object.freeze({
    description: 'a flag of the wrong type',
    payload: { captureId: CAPTURE_B, signals: { ...NO_SIGNALS, http: 'yes' } },
  }),
  Object.freeze({
    description: 'a function list that is not a list',
    payload: { captureId: CAPTURE_B, signals: { ...NO_SIGNALS, functions: FUNCTION_SYMBOL } },
  }),
  Object.freeze({
    description: 'a function list holding something that is not a name',
    payload: { captureId: CAPTURE_B, signals: { ...NO_SIGNALS, functions: [7] } },
  }),
  Object.freeze({
    description: 'a capture id of the wrong type',
    payload: { captureId: 7, signals: HTTP_ONLY_SIGNALS },
  }),
  Object.freeze({
    description: 'a session id of the wrong type',
    payload: { captureId: CAPTURE_B, sessionId: 7, signals: HTTP_ONLY_SIGNALS },
  }),
  Object.freeze({
    description: 'a signals member that is not an object',
    payload: { captureId: CAPTURE_B, signals: true },
  }),
]);

describe('applying a server-agent.config payload', () => {
  it('arms the capture the payload names, with its session', async () => {
    const harness = createHarness();

    await expect(
      harness.control.applyConfig({
        sessionId: SESSION_ID,
        captureId: CAPTURE_A,
        signals: HTTP_ONLY_SIGNALS,
      }),
    ).resolves.toBe('enabled');

    expect(harness.control.captureId).toBe(CAPTURE_A);
    expect(harness.control.sessionId).toBe(SESSION_ID);
    expect(harness.control.stats().configsApplied).toBe(1);
    expect(harness.control.stats().enableCount).toBe(1);
  });

  it('restates an armed capture without rebuilding anything', async () => {
    const harness = createHarness();

    await expect(harness.arm(CAPTURE_A, HTTP_ONLY_SIGNALS)).resolves.toBe(true);
    await expect(harness.arm(CAPTURE_A, HTTP_ONLY_SIGNALS)).resolves.toBe(false);

    expect(harness.providerBuilds()).toBe(1);
    expect(harness.control.stats().enableCount).toBe(1);
  });

  it('disables everything when the payload carries no capture id', async () => {
    const driver = new RecordingInstrumentation();
    const harness = createHarness({ instrumentations: [driver] });
    await harness.arm(CAPTURE_A, ALL_SIGNALS);

    await expect(harness.control.applyConfig({ signals: NO_SIGNALS })).resolves.toBe('disabled');

    expect(harness.control.captureId).toBeNull();
    expect(harness.control.sessionId).toBeNull();
    expect(harness.control.stats().enabledKinds).toEqual([]);
    expect(harness.control.stats().providerRegistered).toBe(false);
    expect(driver.disableCount).toBe(1);
    expect(harness.flush.forceFlushCount).toBe(1);

    // A payload with no `signals` at all is the same instruction, and is
    // accepted rather than refused on a technicality - disabling must never be.
    await expect(harness.control.applyConfig({})).resolves.toBe('unchanged');
    expect(driver.disableCount).toBe(1);
  });

  it('transitions to a new capture and restarts the event sequence', async () => {
    const harness = createHarness();
    const rig = createProcessorRig(harness);

    await expect(
      harness.control.applyConfig({ captureId: CAPTURE_A, signals: HTTP_ONLY_SIGNALS }),
    ).resolves.toBe('enabled');

    rig.processor.onEnd(serverRequestSpan());
    rig.processor.onEnd(serverRequestSpan());
    await rig.processor.forceFlush();

    const firstCall = rig.fetches[0];
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) {
      return;
    }
    expect(sequenceNumbersOf(firstCall)).toEqual([0, 1]);

    await expect(
      harness.control.applyConfig({
        sessionId: SESSION_ID,
        captureId: CAPTURE_B,
        signals: HTTP_ONLY_SIGNALS,
      }),
    ).resolves.toBe('enabled');

    expect(harness.control.captureId).toBe(CAPTURE_B);
    expect(harness.control.sessionId).toBe(SESSION_ID);
    // One capture at a time (AAP §0.4.2): a frame naming a different capture is
    // a clean transition, and `./convert.ts`'s allocator is keyed on
    // `(producerId, captureId)`, so the sequence restarts on its own.
    expect(harness.providerBuilds()).toBe(1);

    rig.processor.onEnd(serverRequestSpan());
    await rig.processor.forceFlush();

    const secondCall = rig.fetches[1];
    expect(secondCall).toBeDefined();
    if (secondCall === undefined) {
      return;
    }
    expect(sequenceNumbersOf(secondCall)).toEqual([0]);
  });

  it('refuses a payload it cannot validate and keeps the state it had', async () => {
    for (const { description, payload } of INVALID_CONFIG_PAYLOADS) {
      const harness = createHarness();
      await harness.arm(CAPTURE_A, HTTP_ONLY_SIGNALS);
      const before = harness.control.stats();

      await expect(harness.control.applyConfig(payload), description).resolves.toBe('invalid');

      // Everything except the invalid-frame counter is untouched: not merely
      // "nothing threw" but "nothing changed".
      expect(harness.control.stats(), description).toEqual({
        ...before,
        invalidFrames: before.invalidFrames + 1,
      });
      expect(harness.control.isKindEnabled('http.server'), description).toBe(true);
    }
  });

  it('applies nothing once the control object has been disposed', async () => {
    const driver = new RecordingInstrumentation();
    const harness = createHarness({ instrumentations: [driver] });
    await harness.arm(CAPTURE_A, ALL_SIGNALS);

    await harness.control.dispose();

    expect(harness.control.stats().disposed).toBe(true);
    expect(driver.disableCount).toBe(1);
    await expect(
      harness.control.applyConfig({ captureId: CAPTURE_B, signals: ALL_SIGNALS }),
    ).resolves.toBe('disposed');
    await expect(harness.arm(CAPTURE_B, ALL_SIGNALS)).resolves.toBe(false);
    expect(harness.control.captureId).toBeNull();
    expect(harness.providerBuilds()).toBe(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The control socket
 * ---------------------------------------------------------------------------
 */

describe('the control socket handshake', () => {
  it('opens the derived control URL with no second argument', () => {
    const harness = createHarness();

    harness.control.connect();

    expect(harness.sockets.constructions).toHaveLength(1);
    // Exactly one argument, which is the assertion: no options bag, and
    // therefore no `Origin` header. The service refuses an `http:`/`https:` web
    // origin and accepts its absence from a Node client (AAP §0.5.6).
    expect(harness.sockets.constructions[0]?.args).toEqual([CONTROL_URL]);
    expect(socketOf(harness).url).toBe(harness.config.controlUrl);
    expect(harness.control.stats().connectAttempts).toBe(1);
    expect(harness.control.stats().connected).toBe(false);
  });

  it('announces this client with client.hello as the first frame on the wire', () => {
    const harness = createHarness();
    harness.control.connect();
    const socket = socketOf(harness);

    // Nothing is sent before the transport is open: a frame written into a
    // connecting socket would be lost rather than queued.
    expect(socket.sent).toHaveLength(0);

    socket.emitOpen();

    expect(socket.sent).toHaveLength(1);
    const [hello] = socket.frames();
    expect(hello).toBeDefined();
    if (hello === undefined) {
      return;
    }

    expect(hello.keys).toEqual(['id', 'payload', 'ts', 'type']);
    expect(hello.type).toBe('client.hello');
    expect(hello.type).toBe(CONTROL_MESSAGE_TYPES.hello);
    expect(hello.id).toMatch(MESSAGE_ID_PATTERN);
    expect(typeof hello.ts).toBe('number');
    expect(hello.ts).toBeGreaterThan(0);

    expect(hello.payload).toEqual({
      client: 'server-agent',
      projectRoot: PROJECT_ROOT,
      version: TRACER_VERSION,
      token: CONTROL_TOKEN,
    });
    expect(hello.payload.client).toBe(CONTROL_CLIENT_KIND);
    expect(hello.payload.projectRoot).toBe(harness.config.projectRoot);

    expect(harness.control.stats().helloSent).toBe(1);
    expect(harness.control.stats().connected).toBe(true);
  });

  it('opens no second socket while one is live', () => {
    const harness = createHarness();

    harness.control.connect();
    harness.control.connect();

    expect(harness.sockets.constructions).toHaveLength(1);
  });

  it('applies a config frame that arrives on the socket', async () => {
    const harness = createHarness();
    harness.control.connect();
    const socket = socketOf(harness);
    socket.emitOpen();

    socket.emitMessage(
      JSON.stringify({
        id: `${ID_PREFIXES.message}_${'d'.repeat(16)}`,
        type: CONTROL_MESSAGE_TYPES.config,
        ts: Date.now(),
        payload: { sessionId: SESSION_ID, captureId: CAPTURE_A, signals: HTTP_ONLY_SIGNALS },
      }),
    );
    await settle();

    expect(harness.control.captureId).toBe(CAPTURE_A);
    expect(harness.control.sessionId).toBe(SESSION_ID);
    expect(harness.control.isKindEnabled('http.server')).toBe(true);
    expect(harness.control.stats().framesReceived).toBe(1);
    expect(harness.control.stats().invalidFrames).toBe(0);
    expect(harness.control.stats().framesIgnored).toBe(0);
  });

  it('ignores a frame it cannot parse and a type it does not handle, and keeps its state', async () => {
    const harness = createHarness();
    await harness.arm(CAPTURE_A, HTTP_ONLY_SIGNALS);
    harness.control.connect();
    const socket = socketOf(harness);
    socket.emitOpen();
    const before = harness.control.stats();

    socket.emitMessage('this is not JSON');
    socket.emitMessage(JSON.stringify({ type: '' }));
    socket.emitMessage(JSON.stringify([1, 2, 3]));
    socket.emitMessage(new Uint8Array([1, 2, 3]));
    socket.emitMessage(JSON.stringify({ type: 'session.updated', payload: {} }));
    socket.emitMessage(JSON.stringify({ type: CONTROL_MESSAGE_TYPES.error, payload: {} }));
    socket.emitMessage(
      JSON.stringify({
        type: CONTROL_MESSAGE_TYPES.error,
        payload: { code: 'CAPTURE_REJECTED', message: 'the capture could not be started' },
      }),
    );
    socket.emitError();
    await settle();

    const after = harness.control.stats();
    expect(after.framesReceived).toBe(before.framesReceived + 7);
    // Four unparseable frames plus one `error` payload that did not validate.
    expect(after.invalidFrames).toBe(before.invalidFrames + 5);
    expect(after.framesIgnored).toBe(before.framesIgnored + 1);

    // The capture is exactly as it was: an unknown frame is not an instruction.
    expect(after.captureId).toBe(CAPTURE_A);
    expect(after.enabledKinds).toEqual(before.enabledKinds);
    expect(after.configsApplied).toBe(before.configsApplied);
    expect(after.enableCount).toBe(before.enableCount);
    expect(after.disableCount).toBe(before.disableCount);
    expect(after.providerRegistered).toBe(true);
    expect(after.failures).toBe(before.failures);
  });

  it('keeps the capture running across an ordinary disconnect and reconnects with backoff', () => {
    vi.useFakeTimers();
    const harness = createHarness({ random: (): number => 1 });
    harness.control.connect();
    const socket = socketOf(harness);
    socket.emitOpen();

    socket.emitClose(SOCKET_CLOSE_ABNORMAL, 'the service went away');

    const pending = harness.control.stats();
    expect(pending.credentialRejected).toBe(false);
    expect(pending.connected).toBe(false);
    expect(pending.reconnectPending).toBe(true);
    expect(pending.reconnectDelayMs).toBeGreaterThanOrEqual(RECONNECT_MIN_MS);
    expect(pending.reconnectDelayMs).toBeLessThanOrEqual(RECONNECT_MAX_MS);

    vi.advanceTimersByTime(pending.reconnectDelayMs);

    expect(harness.sockets.constructions).toHaveLength(2);
    expect(harness.sockets.constructions[1]?.args).toEqual([CONTROL_URL]);
    expect(harness.control.stats().reconnectPending).toBe(false);
  });

  it('treats a 4401 close as terminal and never retries the credential', () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.control.connect();
    const socket = socketOf(harness);
    socket.emitOpen();

    socket.emitClose(CONTROL_CLOSE_UNAUTHORIZED, `credential ${CONTROL_TOKEN} refused`);

    expect(harness.control.stats().credentialRejected).toBe(true);
    expect(harness.control.stats().reconnectPending).toBe(false);

    // The credential is minted per dev-server launch and expires with the
    // process, so a refused one will never start being accepted: waiting out
    // the whole envelope must produce no second attempt.
    vi.advanceTimersByTime(RECONNECT_MAX_MS * 4);
    expect(harness.sockets.constructions).toHaveLength(1);

    // Nor does an explicit reconnect attempt revive it.
    harness.control.connect();
    expect(harness.sockets.constructions).toHaveLength(1);

    const diagnostics = logText(harness.log);
    expect(diagnostics).toContain(String(CONTROL_CLOSE_UNAUTHORIZED));
    expect(diagnostics).not.toContain(CONTROL_TOKEN);
  });

  it('keeps every backoff delay inside the configured envelope', () => {
    for (const random of [(): number => 0, (): number => 0.5, (): number => 1]) {
      let previous = 0;
      for (let attempt = 1; attempt <= 40; attempt += 1) {
        const delay = computeReconnectDelayMs(attempt, random);
        expect(delay).toBeGreaterThanOrEqual(RECONNECT_MIN_MS);
        expect(delay).toBeLessThanOrEqual(RECONNECT_MAX_MS);
        expect(delay).toBeGreaterThanOrEqual(previous);
        previous = delay;
      }
    }

    // The floor holds even at the bottom of the jitter band, and the ceiling is
    // reached rather than merely approached.
    expect(computeReconnectDelayMs(1, (): number => 0)).toBe(RECONNECT_MIN_MS);
    expect(computeReconnectDelayMs(40, (): number => 0.5)).toBe(RECONNECT_MAX_MS);
    // A nonsense attempt number is the first attempt, not an infinite delay.
    expect(computeReconnectDelayMs(Number.NaN, (): number => 0.5)).toBe(RECONNECT_MIN_MS);
  });

  it('closes the socket and stops reconnecting when it is disposed', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.control.connect();
    const socket = socketOf(harness);
    socket.emitOpen();

    await harness.control.dispose();

    expect(socket.closes).toHaveLength(1);
    expect(socket.onmessage).toBeNull();
    expect(harness.control.stats().disposed).toBe(true);
    expect(harness.control.stats().reconnectPending).toBe(false);

    harness.control.connect();
    vi.advanceTimersByTime(RECONNECT_MAX_MS * 4);
    expect(harness.sockets.constructions).toHaveLength(1);
  });

  it('never writes the credential into a diagnostic, on any failure path', async () => {
    const failing = new RecordingInstrumentation({
      failOnDisable: new Error(`the driver refused to unwrap for ${CONTROL_TOKEN}`),
    });
    const harness = createHarness({
      instrumentations: [failing],
      flushTarget: new RecordingFlushTarget({
        failOnFlush: new Error(`the ingest endpoint rejected ${CONTROL_TOKEN}`),
      }),
    });

    await harness.arm(CAPTURE_A, ALL_SIGNALS);
    harness.control.connect();
    const socket = socketOf(harness);
    socket.emitOpen();
    socket.emitMessage('not a frame');
    socket.emitMessage(
      JSON.stringify({
        type: CONTROL_MESSAGE_TYPES.config,
        payload: { captureId: CAPTURE_B, signals: { ...NO_SIGNALS, http: 'yes' } },
      }),
    );
    socket.emitMessage(
      JSON.stringify({
        type: CONTROL_MESSAGE_TYPES.error,
        payload: { code: 'INGEST_REJECTED', message: `token ${CONTROL_TOKEN} is not accepted` },
      }),
    );
    socket.emitError();
    socket.emitClose(CONTROL_CLOSE_UNAUTHORIZED, 'credential refused');
    await settle();
    await harness.control.disable();

    // Both halves matter: the module wrote *something* on every one of those
    // paths, and none of it carried the credential. A credential printed into a
    // dev-server terminal outlives the process it belonged to.
    const diagnostics = logText(harness.log);
    expect(harness.log.entries.length).toBeGreaterThan(0);
    expect(harness.control.stats().failures).toBeGreaterThan(0);
    expect(diagnostics).not.toContain(CONTROL_TOKEN);
    expect(diagnostics).toContain(REDACTED_PLACEHOLDER);

    // The credential does travel where it is meant to: the hello frame.
    const [hello] = socket.frames();
    expect(hello?.payload.token).toBe(CONTROL_TOKEN);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A second capture after a teardown
 * ---------------------------------------------------------------------------
 */

describe('a capture that follows a teardown', () => {
  it('rebuilds the provider, re-registers the propagator and re-enables the instrumentations', async () => {
    const driver = new RecordingInstrumentation();
    const orm = new RecordingInstrumentation();
    const harness = createHarness({ instrumentations: [driver, orm] });

    await harness.arm(CAPTURE_A, ALL_SIGNALS);
    expect(harness.providerBuilds()).toBe(1);
    // Adopted already enabled, exactly as `registerInstrumentations()` leaves
    // them, so arming the first capture toggles nothing.
    expect(driver.enableCount).toBe(0);
    expect(orm.enableCount).toBe(0);

    trace.getTracer(TRACER_NAME, TRACER_VERSION).startSpan(SPAN_NAME).end();
    expect(harness.spans.onStartCount).toBe(1);

    await harness.control.disable();
    expect(driver.disableCount).toBe(1);
    expect(orm.disableCount).toBe(1);
    expect(harness.spans.shutdownCount).toBe(1);

    await expect(harness.arm(CAPTURE_B, ALL_SIGNALS)).resolves.toBe(true);

    // SDK 2.x offers no way back from `shutdown()`, so the second capture must
    // build a fresh provider rather than revive the old one.
    expect(harness.providerBuilds()).toBe(2);
    expect(harness.control.stats().providerRegistered).toBe(true);
    expect(harness.control.stats().enableCount).toBe(2);
    expect(driver.enableCount).toBe(1);
    expect(orm.enableCount).toBe(1);

    const secondSpan = trace.getTracer(TRACER_NAME, TRACER_VERSION).startSpan(SPAN_NAME);
    expect(secondSpan.isRecording()).toBe(true);

    // The regression this assertion exists for is silent: without the
    // propagator, every tier keeps producing spans and they simply stop sharing
    // a trace, so browser↔server correlation breaks on the second capture of a
    // session with nothing in the logs to say so.
    const carrier: Record<string, string> = {};
    propagation.inject(trace.setSpan(context.active(), secondSpan), carrier);
    expect(carrier.traceparent).toMatch(TRACEPARENT_PATTERN);
    expect(propagation.fields()).toContain('traceparent');

    secondSpan.end();
    expect(harness.spans.onStartCount).toBe(2);

    // One flush per teardown, and the processor itself was never shut down by
    // the control object: it outlives every cycle (AAP §0.5.1).
    expect(harness.flush.forceFlushCount).toBe(1);
    expect(harness.flush.shutdownCount).toBe(0);
  });

  it('keeps recording through a capture replacement, with no teardown in between', async () => {
    const harness = createHarness();

    await harness.arm(CAPTURE_A, ALL_SIGNALS);
    await expect(harness.arm(CAPTURE_B, ALL_SIGNALS)).resolves.toBe(true);

    expect(harness.providerBuilds()).toBe(1);
    expect(harness.control.captureId).toBe(CAPTURE_B);

    trace.getTracer(TRACER_NAME, TRACER_VERSION).startSpan(SPAN_NAME).end();
    expect(harness.spans.onStartCount).toBe(1);
    expect(harness.flush.forceFlushCount).toBe(0);
  });

  it('reports a capture it cannot install machinery for, instead of pretending to record', async () => {
    const config = activeConfig();
    const log = new RecordingLogger();
    // No factory and no provider: the state `register.ts` leaves behind when the
    // host process could not be given a tracer provider at all.
    const control = new ServerAgentControl({ config, logger: log });

    await expect(
      control.enableCapture({ captureId: CAPTURE_A, signals: ALL_SIGNALS }),
    ).resolves.toBe(true);

    expect(control.stats().providerRegistered).toBe(false);
    expect(control.stats().failures).toBe(1);
    expect(logText(log)).toContain('no tracer provider factory is attached');
    expect(logText(log)).not.toContain(CONTROL_TOKEN);

    await control.dispose();
  });
});
