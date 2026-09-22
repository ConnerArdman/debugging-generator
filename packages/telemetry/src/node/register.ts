/**
 * The `--import` entry of the Node **dev-server preload**: one module whose
 * evaluation installs the server tier's telemetry, and whose absence of a
 * credential installs nothing at all.
 *
 * `packages/telemetry/esbuild.node.mjs` bundles this file — with the whole
 * `src/node` graph and `@debuggen/shared` inlined — into
 * `dist/node/register.mjs`, which `package.json` publishes as the
 * `./node/register` condition. `apps/local-service/src/dev-server/launcher.ts`
 * and `scripts/dev-instrumented.mjs` attach that artefact to the developer's own
 * `next dev` process:
 *
 * ```text
 * NODE_OPTIONS="… --import file:///…/dist/node/register.mjs"
 * DEBUGGEN_INGEST_URL=http://127.0.0.1:43117/telemetry/ingest
 * DEBUGGEN_TOKEN=<server-agent credential, scoped to one project, per launch>
 * DEBUGGEN_PROJECT_ROOT=/abs/path/of/the/launched/project
 * ```
 *
 * ## Why a preload and not Next.js's `instrumentation.ts`
 *
 * Next.js already emits `BaseServer.handleRequest`, `executing api route (app)`
 * and outgoing `fetch` spans — but only through a **globally registered tracer
 * provider**, and only for requests it can extract a context from. Registering
 * that provider, the W3C propagator and the `AsyncLocalStorage` context manager
 * from a `--import` module happens *before the application's modules load*, so
 * Next's own spans start flowing and the `traceparent` header the page agent
 * injects is extracted and joined. That is the whole trick: correlation across
 * the browser/server seam with **zero edits to the developer's project**. Next's
 * documented `instrumentation.ts` hook would work too and is deliberately not
 * used — it is a file inside the target project, and this product never writes
 * one (AAP §0.5.1 keeps server spans a runtime hook, never a patch).
 *
 * ## Inert when the variables are absent
 *
 * The artefact stays on `NODE_OPTIONS` until the developer restarts their
 * server, and `scripts/dev-instrumented.mjs --spawn-local` deliberately runs
 * without a credential. With any of the three variables missing,
 * {@link loadPreloadConfig} reports `inert` and this module installs **nothing**
 * — no provider, no instrumentation, no span helper, no socket, no timer — and
 * says so at `debug` level, because that is a normal state rather than a
 * failure.
 *
 * ## Never throw into the host process
 *
 * An exception raised out of a `--import` module aborts the developer's dev
 * server before it starts. So the whole sequence sits inside one `try/catch`
 * that degrades to "untraced but working" and logs a single `warn`, nothing
 * rethrows, nothing calls `process.exit`, and no `uncaughtException` handler is
 * installed. The two signal handlers that *are* installed re-raise the signal
 * they handled when nothing else is listening, so Ctrl-C keeps its meaning.
 *
 * ## Installation order, which is not arbitrary
 *
 * 1. **Resource** — {@link resourceFromAttributes}; `new Resource(...)` no
 *    longer exists in `@opentelemetry/resources` 2.x.
 * 2. **Control** ({@link ServerAgentControl}) — before the processor and the
 *    sampler, because both take it as their {@link CaptureGate}.
 * 3. **Processor** ({@link DebuggenSpanProcessor}) — one long-lived instance,
 *    reused by every capture of the process.
 * 4. **Sampler** ({@link DebuggenCaptureSampler}) — the layer that makes "no
 *    capture" mean "no span was ever constructed".
 * 5. **Provider** — built by a *factory*, because SDK 2.0 removed
 *    `addSpanProcessor()`/`getActiveSpanProcessor()` and offers no way back from
 *    `shutdown()`: `control.ts` needs the factory to build a fresh provider for
 *    a capture that follows a teardown.
 * 6. **`register({ propagator })`** — explicitly W3C trace context, since 2.0
 *    dropped environment-variable propagator configuration. `register()`
 *    installs the Node `AsyncLocalStorage` context manager itself, which is why
 *    this package needs no `@opentelemetry/context-async-hooks` dependency.
 * 7. **Instrumentations** — `registerInstrumentations` **after** the provider is
 *    registered (so they bind to it) and **before** the application loads (so
 *    `pg` and Prisma are patched before the app requires them). That ordering is
 *    the classic OpenTelemetry mistake; a `--import` preload gives the second
 *    half of it for free.
 * 8. **Span helper** — `globalThis.__DEBUGGEN__`, installed during preload
 *    because an AST-patched application function calls it on its first
 *    invocation, including a function patched later in the session and picked up
 *    by HMR.
 * 9. **Control socket** — last, so a `server-agent.config` frame can never
 *    arrive before the machinery it configures exists. It is started, never
 *    awaited: the dev server must not wait on the local service.
 *
 * ## Instrumentations deliberately NOT installed
 *
 * - `@opentelemetry/instrumentation-http` and `@opentelemetry/instrumentation-undici`:
 *   Next.js already emits request and outgoing-fetch spans through the provider
 *   registered above, and adding these would duplicate every one of them
 *   (AAP §0.3.2).
 * - `@vercel/otel`: it owns the exporter path, and this product needs the custom
 *   {@link DebuggenSpanProcessor} that posts to the local service rather than an
 *   OTLP collector (AAP §0.3.2).
 *
 * Please do not "helpfully" add any of the three.
 *
 * ## Privacy
 *
 * The credential reaches this module and goes no further than the exporter's
 * `Authorization` header and the control socket's `client.hello`. It is never
 * logged, printed, interpolated into a message or attached to an error: every
 * diagnostic here passes through a scrub, and the endpoint URLs are safe to name
 * because `./config.ts` refuses one that embeds credentials.
 *
 * @example What the launcher effectively does
 * ```ts
 * // NODE_OPTIONS="--import file:///…/register.mjs" next dev
 * // …and, on the way out:
 * import { shutdownPreload } from '@debuggen/telemetry/node/register';
 * await shutdownPreload();
 * ```
 */

import { nowEpochMs } from '@debuggen/shared';
import type { Logger } from '@debuggen/shared';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import type { Context, DiagLogger } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { PrismaInstrumentation } from '@prisma/instrumentation';

import { createPreloadLogger, loadPreloadConfig, TRACER_VERSION } from './config.js';
import type { PreloadConfig } from './config.js';
import { CONTROL_CLIENT_KIND, DebuggenCaptureSampler, ServerAgentControl } from './control.js';
import type {
  ControlSocketConstructor,
  ToggleableInstrumentation,
  TracerProviderFactory,
} from './control.js';
import { DebuggenSpanProcessor, SHUTDOWN_FLUSH_DEADLINE_MS } from './exporter.js';
import { installSpanHelper } from './span-helper.js';

/*
 * ---------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------
 */

/**
 * Key of the slot this module parks its installation on, so a second
 * evaluation of the preload can find the first.
 *
 * `Symbol.for` rather than a private symbol on purpose: two evaluations mean two
 * module scopes — `--import` given twice, or the artefact imported once by path
 * and once through the `exports` condition — and only the global symbol registry
 * is shared between them. Registering two providers would double every span in
 * the developer's server, and two control sockets would fight over one capture.
 */
const PRELOAD_SLOT_KEY = Symbol.for('debuggen.telemetry.node.preload');

/** What a scrubbed credential is replaced with; the spelling the siblings use. */
const REDACTED_PLACEHOLDER = '[redacted]';

/**
 * Resource attribute naming this process's role, matching the `client` value the
 * control socket announces.
 *
 * Read from {@link CONTROL_CLIENT_KIND} rather than written twice: a developer
 * inspecting a provider in their own process should see the same word the
 * service sees on the wire.
 */
const RESOURCE_ROLE_KEY = 'debuggen.role';

/** Resource attribute naming the launched project, for a host running several. */
const RESOURCE_PROJECT_ROOT_KEY = 'debuggen.project_root';

/**
 * Upper bound on how long a signal or `beforeExit` handler waits for teardown.
 *
 * Derived from the exporter's own final-flush deadline plus a margin for the
 * steps around it (the instrumentation `disable()` calls and
 * `provider.shutdown()`), so a normal teardown always completes inside it and
 * the bound only ever cuts short something that has hung. Expressed against
 * {@link SHUTDOWN_FLUSH_DEADLINE_MS} rather than as a second literal, so the two
 * cannot drift into a deadline shorter than the flush it is waiting for.
 */
export const SHUTDOWN_DEADLINE_MS = SHUTDOWN_FLUSH_DEADLINE_MS + 2_000;

/**
 * The signals whose default disposition ends a dev server, and on which the
 * preload therefore flushes what it has captured.
 *
 * `SIGINT` is the developer's Ctrl-C and `SIGTERM` is what the launcher sends
 * when a session ends. Deliberately not `SIGKILL` (uncatchable) or `SIGHUP`
 * (whose disposition a terminal-detached dev server may legitimately own).
 */
const TERMINATION_SIGNALS: readonly NodeJS.Signals[] = Object.freeze<NodeJS.Signals[]>([
  'SIGINT',
  'SIGTERM',
]);

/*
 * ---------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------
 */

/**
 * Everything {@link installPreload} takes; every member is optional, and the
 * defaults are what the preload uses in a developer's dev server.
 *
 * The injection points exist so a test can drive the whole sequence — including
 * the active path — without a local service, a database or a network socket.
 */
export interface PreloadInstallOptions {
  /**
   * Where the three launch variables are read from; defaults to `process.env`.
   */
  readonly env?: NodeJS.ProcessEnv | undefined;

  /**
   * Where every diagnostic goes; defaults to `createPreloadLogger()`, which is
   * quiet (`warn`) unless the developer sets `DEBUGGEN_LOG_LEVEL`.
   */
  readonly logger?: Logger | undefined;

  /**
   * The control socket's constructor; defaults to the host's global
   * `WebSocket`, which Node 24 provides.
   */
  readonly webSocketImpl?: ControlSocketConstructor | undefined;

  /** The exporter's `fetch`; defaults to the host's global. */
  readonly fetchImpl?: typeof fetch | undefined;

  /**
   * Whether to open the control socket; defaults to `true`.
   *
   * `false` installs everything else and leaves the channel closed, which is
   * what a test wants when there is no service to talk to — the machinery is
   * still assertable, and no reconnect timer is armed.
   */
  readonly connect?: boolean | undefined;
}

/**
 * A preload that installed: the collaborators it built, and the way back out.
 *
 * Exposed as a whole rather than piecemeal because the pieces are only
 * meaningful together — `control.test.ts`-style wiring assertions need the gate
 * and the processor that consult each other — and because a caller holding this
 * object can tear the preload down without going through the global slot.
 */
export interface InstalledPreload {
  /** Discriminant: this preload is installed and armed but gated. */
  readonly status: 'installed';

  /** The validated launch configuration the installation was built from. */
  readonly config: PreloadConfig;

  /** The OpenTelemetry resource every span of this process carries. */
  readonly resource: Resource;

  /** The capture gate, the control socket and the teardown. */
  readonly control: ServerAgentControl;

  /** The long-lived processor that converts and posts ended spans. */
  readonly processor: DebuggenSpanProcessor;

  /** The sampler that keeps an armed-but-idle dev server silent. */
  readonly sampler: DebuggenCaptureSampler;

  /** The provider registered globally at preload. */
  readonly provider: NodeTracerProvider;

  /** Builds a fresh provider for a capture that follows a teardown. */
  readonly createProvider: TracerProviderFactory;

  /**
   * The Prisma and `pg` instrumentation instances, in the order they were
   * registered — the same objects `control.ts` calls `enable()`/`disable()` on.
   */
  readonly instrumentations: readonly ToggleableInstrumentation[];

  /**
   * Tear this installation down: dispose the control object, shut the processor
   * down and undo any diagnostics wiring. Idempotent, and it never rejects.
   *
   * Declared as a property holding a function rather than as a method, because
   * that is what it is: a closure over one installation, safe to pass around
   * detached from this object — which a method signature would make
   * `@typescript-eslint/unbound-method` reject at every hand-off.
   */
  readonly shutdown: () => Promise<void>;
}

/**
 * A preload that installed nothing, and why.
 *
 * `shutdown` is present and resolves immediately, so every caller of
 * {@link installPreload} can treat the result uniformly instead of branching on
 * the status before it can clean up.
 */
export interface InactivePreload {
  /**
   * Why nothing was installed:
   *
   * - `inert` — a launch variable is absent or unusable. The normal state of a
   *   dev server with no session attached.
   * - `duplicate` — this process already has a preload installed.
   * - `failed` — a step threw. The dev server runs untraced; see `reason`.
   */
  readonly status: 'inert' | 'duplicate' | 'failed';

  /** A value-free explanation: it names variables and steps, never values. */
  readonly reason: string;

  /** Resolves immediately; there is nothing to tear down. */
  readonly shutdown: () => Promise<void>;
}

/** The outcome of {@link installPreload}. */
export type PreloadInstallation = InstalledPreload | InactivePreload;

/**
 * What is parked on the global slot: enough to recognise an existing
 * installation and to tear it down from a module scope that did not create it.
 */
interface PreloadSlot {
  /** Epoch milliseconds at which the installation completed. */
  readonly installedAt: number;

  /** The installing build's version, so a mismatch is visible in a log line. */
  readonly version: string;

  /** {@link InstalledPreload.shutdown} of the installation that claimed it. */
  readonly shutdown: () => Promise<void>;
}

/*
 * ---------------------------------------------------------------------------
 * Diagnostics
 * ---------------------------------------------------------------------------
 */

/**
 * The two levels this module emits at, with the credential removed from every
 * message and every string field.
 *
 * A local interface rather than the {@link Logger} itself because every call
 * site here has to be scrubbed, and a raw logger in scope is an invitation to
 * bypass that. `./control.ts` and `./exporter.ts` each keep an equivalent
 * private helper; duplicating a dozen lines is cheaper than widening a sibling's
 * public surface for it.
 */
interface PreloadLog {
  /** Detail a developer only sees with `DEBUGGEN_LOG_LEVEL=debug` or finer. */
  debug(message: string, fields?: Record<string, unknown>): void;

  /** A degraded but handled condition; the only level this module raises. */
  warn(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Wrap a {@link Logger} so nothing this module emits can carry the credential.
 *
 * @param logger The underlying sink.
 * @param token The server-agent credential, or `''` when there is none yet.
 * @returns A scrubbed, never-throwing logging facade.
 */
function createPreloadLog(logger: Logger, token: string): PreloadLog {
  const scrub = (text: string): string => {
    if (token.length === 0 || !text.includes(token)) {
      return text;
    }
    return text.split(token).join(REDACTED_PLACEHOLDER);
  };

  const emit = (
    level: 'debug' | 'warn',
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    try {
      const safeMessage = scrub(message);
      if (fields === undefined) {
        logger[level](safeMessage);
        return;
      }
      const safeFields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        safeFields[key] = typeof value === 'string' ? scrub(value) : value;
      }
      logger[level](safeMessage, safeFields);
    } catch {
      // A logger that throws must not become an application failure, and a
      // failed diagnostic has nowhere left to be reported.
    }
  };

  return {
    debug(message, fields): void {
      emit('debug', message, fields);
    },
    warn(message, fields): void {
      emit('warn', message, fields);
    },
  };
}

/**
 * Describe a thrown value in one short line that quotes no data.
 *
 * An `Error`'s name and message are the useful part, and the endpoints they may
 * quote carry no credentials (`./config.ts` refuses one that does). Anything
 * else is described by its type only: a thrown object may be anything at all,
 * and stringifying it could both fail and quote the host's own data.
 *
 * @param error The caught value.
 * @returns A single-line description.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.length > 0 ? error.message : error.name;
    return `${error.name}: ${message}`;
  }
  return `non-error value of type ${typeof error}`;
}

/**
 * Route OpenTelemetry's internal diagnostics into our logger — but only when the
 * developer has asked for the finest level.
 *
 * `diag` is global and noisy: the SDK reports every instrumentation it patches,
 * every module it declines to patch and every dropped span through it. That is
 * exactly what a developer investigating "why are there no database spans"
 * wants, and exactly what nobody else does. So it is gated behind
 * `DEBUGGEN_LOG_LEVEL=trace` (the variable `.env.example` already documents),
 * and {@link runShutdown} calls `diag.disable()` on the way out so the host is
 * left with whatever diagnostics configuration it had.
 *
 * @param logger The resolved logger, whose level is the gate.
 * @param log Where the forwarded records go.
 * @returns Whether a diag logger was installed, so teardown can undo it.
 */
function wireDiagnostics(logger: Logger, log: PreloadLog): boolean {
  if (logger.level !== 'trace') {
    return false;
  }

  const forward =
    (level: 'debug' | 'warn') =>
    (message: string, ...args: unknown[]): void => {
      // Only the count of the extra arguments is reported: the SDK passes
      // arbitrary objects there, and this module does not serialise values it
      // did not produce.
      log[level](message, args.length > 0 ? { diagArgs: args.length } : undefined);
    };

  try {
    const sink: DiagLogger = {
      error: forward('warn'),
      warn: forward('warn'),
      info: forward('debug'),
      debug: forward('debug'),
      verbose: forward('debug'),
    };
    diag.setLogger(sink, DiagLogLevel.DEBUG);
    return true;
  } catch (error) {
    log.warn('could not install the OpenTelemetry diagnostic logger', {
      error: describeError(error),
    });
    return false;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Small runtime helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Drop a timer's claim on the event loop, where the runtime has such a notion.
 *
 * Node's handles carry `unref`; another host's may be a bare number. The
 * preload must never be the reason a dev server refuses to exit, and
 * `./control.ts` and `./exporter.ts` keep an identical private helper for the
 * same reason.
 *
 * @param timer A handle from `setTimeout`.
 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  try {
    const view: { unref?: () => void } = timer;
    if (typeof view.unref === 'function') {
      view.unref();
    }
  } catch {
    // A host whose handle refuses the call keeps its reference; the process may
    // then linger for the remainder of the deadline, which is not worth a throw.
  }
}

/**
 * Await `work`, but never for longer than `ms`.
 *
 * Used only by the exit handlers. `work` is {@link shutdownPreload}, which does
 * not reject, so the race has one purpose: a teardown that hangs — an ingest
 * POST to a service that accepted the connection and never answered — must not
 * turn "the developer pressed Ctrl-C" into "the dev server will not die".
 *
 * @param work The teardown to wait for.
 * @param ms The deadline in milliseconds.
 */
async function withDeadline(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      resolve();
    }, ms);
    unrefTimer(timer);
  });

  try {
    await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** The `shutdown` of a preload that installed nothing: immediate, and a no-op. */
const noopShutdown = (): Promise<void> => Promise.resolve();

/**
 * Build the result for a preload that installed nothing.
 *
 * @param status Why nothing was installed.
 * @param reason A value-free explanation.
 * @returns The inactive installation.
 */
function inactive(status: InactivePreload['status'], reason: string): InactivePreload {
  return { status, reason, shutdown: noopShutdown };
}

/**
 * The OpenTelemetry resource every span of this process carries.
 *
 * `resourceFromAttributes` is the factory `@opentelemetry/resources` 2.x offers;
 * the 1.x `new Resource(...)` constructor no longer exists. The SDK's
 * `defaultResource()` is deliberately **not** merged in: nothing in this
 * product reads `telemetry.sdk.*` — there is no OTLP exporter, and `./convert.ts`
 * classifies a span by its instrumentation scope, never by its resource — so the
 * merge would only add attributes no reader consults.
 *
 * @param config The validated launch configuration.
 * @returns A resource naming this project, this build and this producer.
 */
function buildResource(config: PreloadConfig): Resource {
  return resourceFromAttributes({
    // The project directory's final component, so a developer running several
    // dev servers can tell whose span they are looking at.
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: TRACER_VERSION,
    // The producer id every event of this process carries, which is what ties a
    // raw span back to a row in the service's store.
    [ATTR_SERVICE_INSTANCE_ID]: config.producerId,
    [RESOURCE_ROLE_KEY]: CONTROL_CLIENT_KIND,
    [RESOURCE_PROJECT_ROOT_KEY]: config.projectRoot,
  });
}

/**
 * A span processor bound to **one provider's lifetime**, forwarding to the
 * long-lived one that outlives it.
 *
 * The SDK makes this necessary. `BasicTracerProvider.shutdown()` is exactly
 * `this._activeSpanProcessor.shutdown()`, and that `MultiSpanProcessor` calls
 * `shutdown()` on every processor it was constructed with —
 * {@link DebuggenSpanProcessor.shutdown} is terminal, so a capture that ends
 * (`control.ts` awaits `provider.shutdown()` on its disable path) would leave the
 * process with a dead exporter and the *next* capture of the session would post
 * nothing. `control.ts` states the intent plainly: "the processor itself lives on
 * and is reused by the next capture", and AAP §0.4.2's follow-up flow makes a
 * second capture an ordinary event rather than an edge case.
 *
 * So the provider is handed this facade instead. A provider shutdown becomes a
 * flush — evidence already captured still reaches the service — and the real
 * processor is shut down exactly once, by {@link runShutdown}, when the process
 * itself is going away.
 *
 * It also settles a second SDK subtlety: `registerInstrumentations` resolves a
 * *concrete* tracer through the global proxy provider (whose delegate is already
 * set by the time it runs), so the Prisma and `pg` instrumentations keep the
 * first provider's tracer for the life of the process. Because that provider is
 * only ever flushed rather than dismantled, the tracer they hold keeps
 * forwarding to this facade, to the live processor behind it and to the shared
 * gating sampler — which is what makes a second capture produce database spans
 * at all.
 *
 * Stateless, so one instance serves every provider the factory builds.
 */
class ProviderScopedSpanProcessor implements SpanProcessor {
  /** The long-lived processor; never shut down through this facade. */
  readonly #inner: SpanProcessor;

  /**
   * @param inner The processor that outlives every provider.
   */
  constructor(inner: SpanProcessor) {
    this.#inner = inner;
  }

  /**
   * @param span The span that just started.
   * @param parentContext The context it was started in.
   */
  onStart(span: Span, parentContext: Context): void {
    this.#inner.onStart(span, parentContext);
  }

  /**
   * Forwarded because the SDK calls it when present; the current processor does
   * not implement it, and a future one that does must still see the callback.
   *
   * @param span The span that is ending.
   */
  onEnding(span: Span): void {
    this.#inner.onEnding?.(span);
  }

  /**
   * @param span The span that just ended.
   */
  onEnd(span: ReadableSpan): void {
    this.#inner.onEnd(span);
  }

  /** @returns The inner processor's flush. */
  forceFlush(): Promise<void> {
    return this.#inner.forceFlush();
  }

  /**
   * Flush, and leave the inner processor alive — see this class's overview.
   *
   * Never rejects: `MultiSpanProcessor.shutdown()` propagates a rejection to
   * `provider.shutdown()`, which `control.ts` awaits on its teardown path.
   */
  async shutdown(): Promise<void> {
    await this.#inner.forceFlush();
  }
}

/*
 * ---------------------------------------------------------------------------
 * Installation
 * ---------------------------------------------------------------------------
 */

/**
 * Patch Prisma and `pg`, and return the two instances.
 *
 * **Ordering.** This must run *after* the provider is registered — the SDK
 * resolves each instrumentation's tracer from the global provider at this moment
 * — and *before* the application's modules load, because an instrumentation
 * patches a package through a loader hook installed when it is enabled: a `pg`
 * already required is a `pg` already unwrapped. A `--import` preload is what
 * gives the second half for free, and getting this pair the wrong way round is
 * the classic OpenTelemetry mistake.
 *
 * **Nothing else is registered here.** `@opentelemetry/instrumentation-http` and
 * `@opentelemetry/instrumentation-undici` would duplicate the request and
 * outgoing-fetch spans Next.js already emits through the provider above, and
 * `@vercel/otel` owns an exporter path this product does not use (AAP §0.3.2).
 *
 * The unload function `registerInstrumentations` returns is deliberately
 * dropped: `control.ts` owns enable/disable, and it acts on the very instances
 * returned here. A second disposer over the same instances would be a second
 * owner of one piece of state.
 *
 * @returns The Prisma and `pg` instrumentations, enabled, in registration order.
 */
function registerServerInstrumentations(): readonly ToggleableInstrumentation[] {
  const prisma = new PrismaInstrumentation();
  const pg = new PgInstrumentation();

  registerInstrumentations({ instrumentations: [prisma, pg] });

  return Object.freeze<ToggleableInstrumentation[]>([prisma, pg]);
}

/**
 * Run the shutdown sequence once, however many callers ask for it.
 *
 * @param control The control object, whose `dispose` is the teardown.
 * @param processor The long-lived processor, shut down only here.
 * @param diagWired Whether {@link wireDiagnostics} installed a diag logger.
 * @param log Where the sequence reports.
 * @returns An idempotent shutdown function that never rejects.
 */
function createShutdownSequence(
  control: ServerAgentControl,
  processor: DebuggenSpanProcessor,
  diagWired: boolean,
  log: PreloadLog,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return (): Promise<void> => {
    pending ??= runShutdown(control, processor, diagWired, log);
    return pending;
  };
}

/**
 * Close the control channel, make a last bounded attempt at the buffered
 * evidence, and undo the diagnostics wiring.
 *
 * Every step is independently guarded, so a failure in one still leaves the
 * others to run, and the whole sequence resolves rather than rejecting: it is
 * awaited from a signal handler in the developer's own process.
 *
 * @param control Disposed first: it closes the socket, flushes, unwraps `pg`,
 * clears Prisma's hook and removes the global provider and propagator.
 * @param processor Shut down second, since `control.dispose()` flushes through
 * it and this is the call that makes it terminal.
 * @param diagWired Whether to call `diag.disable()`.
 * @param log Where the sequence reports.
 */
async function runShutdown(
  control: ServerAgentControl,
  processor: DebuggenSpanProcessor,
  diagWired: boolean,
  log: PreloadLog,
): Promise<void> {
  try {
    await control.dispose();
  } catch (error) {
    log.warn('the control channel did not shut down cleanly', { error: describeError(error) });
  }

  try {
    await processor.shutdown();
  } catch (error) {
    log.warn('the telemetry exporter did not shut down cleanly', {
      error: describeError(error),
    });
  }

  if (diagWired) {
    try {
      diag.disable();
    } catch {
      // Leaving a diag logger installed is harmless; failing the teardown for
      // it would not be.
    }
  }

  log.debug('preload shut down');
}

/**
 * Install the server tier's telemetry into this process, or explain why not.
 *
 * The whole sequence — every step of the order documented at the top of this
 * file — sits inside one `try/catch`. On failure whatever was built is torn down
 * again, one `warn` is emitted, and the developer keeps a working, untraced dev
 * server. **Nothing escapes this function.**
 *
 * Calling it more than once in a process registers a second provider and a
 * second control socket; the module's own bootstrap guards against that through
 * a slot on `globalThis`, and a caller invoking this directly owns the same
 * question (a test usually wants `connect: false` and its own `shutdown()`).
 *
 * @param options See {@link PreloadInstallOptions}; the defaults are what a real
 * dev server uses.
 * @returns The installation, or an inactive result carrying the reason.
 */
export function installPreload(options: PreloadInstallOptions = {}): PreloadInstallation {
  const env = options.env ?? process.env;
  const logger = options.logger ?? createPreloadLogger(undefined, env);

  const outcome = loadPreloadConfig(env);
  if (outcome.mode === 'inert') {
    // `debug`, not `warn`: the artefact stays on NODE_OPTIONS until the
    // developer restarts their server, so running without a credential is the
    // ordinary state of the machine rather than a fault to report.
    createPreloadLog(logger, '').debug('preload inert; nothing installed', {
      reason: outcome.reason,
    });
    return inactive('inert', outcome.reason);
  }

  const config = outcome.config;
  const log = createPreloadLog(logger, config.token);

  let control: ServerAgentControl | undefined;
  let diagWired = false;

  try {
    diagWired = wireDiagnostics(logger, log);

    // 1. The resource: what every span of this process says it came from.
    const resource = buildResource(config);

    // 2. The control object, before its two consumers: the processor and the
    //    sampler both read it as their capture gate, so it has to exist first.
    //    It needs no provider at construction time and receives the rest of its
    //    collaborators through `attach` below.
    control = new ServerAgentControl({
      config,
      logger,
      webSocketImpl: options.webSocketImpl,
    });

    // 3. One long-lived processor for the whole process: it owns the ingest
    //    buffer, the `seq` allocator and the transport, and it survives every
    //    capture cycle (see ProviderScopedSpanProcessor).
    const processor = new DebuggenSpanProcessor({
      gate: control,
      config,
      logger,
      fetchImpl: options.fetchImpl,
    });

    // 4. The gating sampler: outside a capture it answers NOT_RECORD, so an
    //    armed-but-idle dev server never even constructs a span.
    const sampler = new DebuggenCaptureSampler(control);

    // 5. A provider *factory*, not just a provider. SDK 2.0 removed
    //    `addSpanProcessor()`/`getActiveSpanProcessor()` and offers no way back
    //    from `shutdown()`, so the processor and the sampler must be in place at
    //    construction and a capture that follows a teardown needs a fresh
    //    provider built from the same parts.
    const providerScopedProcessor = new ProviderScopedSpanProcessor(processor);
    const createProvider = (): NodeTracerProvider =>
      new NodeTracerProvider({ resource, sampler, spanProcessors: [providerScopedProcessor] });

    const provider = createProvider();

    // 6. Registering is what makes Next.js's own spans appear and what lets its
    //    request tracer extract the `traceparent` the page agent injects. The
    //    propagator is passed explicitly because 2.0 dropped environment-variable
    //    propagator configuration; `register()` installs the Node
    //    `AsyncLocalStorage` context manager itself, so this package needs no
    //    `@opentelemetry/context-async-hooks` dependency.
    provider.register({ propagator: new W3CTraceContextPropagator() });

    // 7. Instrumentations: after the provider, before the application's modules.
    const instrumentations = registerServerInstrumentations();

    control.attach({ processor, instrumentations, createProvider, provider });

    // 8. `globalThis.__DEBUGGEN__`, so a function the session patches later —
    //    including one HMR reloads mid-capture — finds the helper already there
    //    on its first invocation.
    installSpanHelper({ logger });

    // 9. The control socket, last: a `server-agent.config` frame can now only
    //    arrive at machinery that is already complete. `connect()` returns
    //    immediately and retries on its own schedule, because the dev server
    //    must never wait on the local service.
    const shouldConnect = options.connect !== false;
    if (shouldConnect) {
      control.connect();
    }

    const shutdown = createShutdownSequence(control, processor, diagWired, log);

    log.debug('preload installed', {
      service: config.serviceName,
      producerId: config.producerId,
      ingest: config.ingestUrl,
      control: config.controlUrl,
      connecting: shouldConnect,
      diagnostics: diagWired,
    });

    return {
      status: 'installed',
      config,
      resource,
      control,
      processor,
      sampler,
      provider,
      createProvider,
      instrumentations,
      shutdown,
    };
  } catch (error) {
    const reason = describeError(error);
    log.warn(
      'the Debug Generator preload could not install; this dev server will run without server telemetry',
      { error: reason },
    );

    // Best effort: give back whatever was taken, so the process is left as it
    // was found. `dispose()` never rejects and is a no-op for the collaborators
    // that were never attached, and it is not awaited because module evaluation
    // must not block on it.
    if (control !== undefined) {
      void control.dispose();
    }
    if (diagWired) {
      try {
        diag.disable();
      } catch {
        // Nothing left to report it to.
      }
    }

    return inactive('failed', reason);
  }
}

/*
 * ---------------------------------------------------------------------------
 * The global slot
 * ---------------------------------------------------------------------------
 */

/**
 * `globalThis`, viewed as the symbol-keyed record this module parks its slot on.
 *
 * One narrow view in one place, and every read of it is validated structurally
 * below: the slot is shared with anything else in the process that can reach the
 * global symbol registry, so what comes back is treated as unknown input.
 *
 * @returns The host object.
 */
function slotHost(): Record<symbol, unknown> {
  return globalThis;
}

/**
 * The installation already present in this process, if there is one.
 *
 * @returns The slot, or `undefined` when it is absent or unrecognisable.
 */
function readPreloadSlot(): PreloadSlot | undefined {
  try {
    const value = slotHost()[PRELOAD_SLOT_KEY];
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    const candidate = value as { shutdown?: unknown };
    return typeof candidate.shutdown === 'function' ? (value as PreloadSlot) : undefined;
  } catch {
    // A frozen or exotic global is not worth a throw; the caller treats an
    // unreadable slot as an absent one and installs.
    return undefined;
  }
}

/**
 * Claim the slot for this installation.
 *
 * Non-enumerable, so nothing that walks `globalThis` — a test's snapshot, a
 * serialiser in the developer's own application — trips over it, and
 * configurable so a later build can replace it.
 *
 * @param slot The record to park.
 */
function claimPreloadSlot(slot: PreloadSlot): void {
  Object.defineProperty(globalThis, PRELOAD_SLOT_KEY, {
    value: slot,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

/**
 * Tear down the preload installed in this process, if any.
 *
 * Delegates to the installation's own shutdown — `control.dispose()`, then the
 * exporter's final flush — and resolves immediately when nothing is installed.
 * Idempotent: the sequence runs once and every later call awaits that same
 * result. It never rejects.
 *
 * Reached through the global slot rather than a module-local reference, so it
 * works from a second evaluation of this module (two `--import` flags, or an
 * import by a different specifier) and from a host that only has the
 * `./node/register` entry to hand.
 *
 * @returns A promise that resolves when teardown has finished.
 */
export async function shutdownPreload(): Promise<void> {
  const slot = readPreloadSlot();
  if (slot === undefined) {
    return;
  }
  await slot.shutdown();
}

/*
 * ---------------------------------------------------------------------------
 * Process exit
 * ---------------------------------------------------------------------------
 */

/** Set once the handlers below are attached, so they are never stacked. */
let terminationHandlersAttached = false;

/**
 * Flush on the way out, without taking over the host's exit behaviour.
 *
 * `process.once` for every handler: a developer holding Ctrl-C must not queue a
 * second teardown, and a signal that arrives during one must not restart it.
 * Nothing here calls `process.exit`, and nothing installs an
 * `uncaughtException` or `unhandledRejection` handler — the host's own error
 * behaviour is not ours to change.
 *
 * @param log Where the handlers report.
 */
function attachTerminationHandlers(log: PreloadLog): void {
  if (terminationHandlersAttached) {
    return;
  }
  terminationHandlersAttached = true;

  for (const signal of TERMINATION_SIGNALS) {
    // The signal is taken from the loop rather than from the listener's
    // argument, so the handler knows which signal it is re-raising even on a
    // host that calls the listener with nothing.
    process.once(signal, () => {
      void handleTerminationSignal(signal, log);
    });
  }

  // `beforeExit` covers the process that ends because its work is done. It does
  // not fire for `process.exit()` or for a signal, which is what the handlers
  // above are for.
  process.once('beforeExit', () => {
    void withDeadline(shutdownPreload(), SHUTDOWN_DEADLINE_MS);
  });
}

/**
 * Flush, then let the signal mean exactly what it meant before we listened.
 *
 * Attaching a listener to `SIGINT` or `SIGTERM` *replaces* Node's default
 * disposition for it, so a preload that merely handled the signal would turn
 * Ctrl-C into "nothing happens" for any dev server without a handler of its own.
 * `process.once` has already removed this listener by the time the body runs, so
 * a listener count of zero means the host was relying on that default — and
 * re-raising the signal is what restores it. A host with its own handler sees a
 * non-zero count and keeps its behaviour untouched.
 *
 * @param signal The signal that arrived.
 * @param log Where the handler reports.
 */
async function handleTerminationSignal(signal: NodeJS.Signals, log: PreloadLog): Promise<void> {
  try {
    await withDeadline(shutdownPreload(), SHUTDOWN_DEADLINE_MS);
  } catch (error) {
    log.warn('teardown on signal did not complete', { signal, error: describeError(error) });
  }

  if (process.listenerCount(signal) === 0) {
    try {
      process.kill(process.pid, signal);
    } catch (error) {
      log.warn('could not re-raise the signal after teardown', {
        signal,
        error: describeError(error),
      });
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * Bootstrap — the side effect that makes this module a preload
 * ---------------------------------------------------------------------------
 */

/**
 * Install once per process, claim the slot, and arm the exit handlers.
 *
 * The duplicate guard is the reason this is separate from
 * {@link installPreload}: two evaluations of this module mean two module scopes
 * — `--import` given twice, or the artefact reached by two specifiers — and only
 * the global symbol registry is shared between them. The second pass finds the
 * slot claimed and installs nothing, because two providers would double every
 * span and two control sockets would fight over one capture.
 *
 * The slot is claimed **only** on the active path. An inert preload has built
 * nothing to find and nothing to tear down, so a later evaluation is free to try
 * again — which is what lets a developer's second dev server, launched with a
 * credential, install in a process that already loaded this module without one.
 *
 * @returns What the evaluation did.
 */
function bootstrap(): PreloadInstallation {
  try {
    const existing = readPreloadSlot();
    if (existing !== undefined) {
      createPreloadLog(createPreloadLogger(), '').debug(
        'preload already installed in this process; this evaluation installs nothing',
        { installedAt: existing.installedAt, version: existing.version },
      );
      return inactive(
        'duplicate',
        'another evaluation of this module already installed the preload in this process',
      );
    }

    const installation = installPreload();
    if (installation.status !== 'installed') {
      return installation;
    }

    claimPreloadSlot({
      installedAt: nowEpochMs(),
      version: TRACER_VERSION,
      shutdown: installation.shutdown,
    });

    attachTerminationHandlers(createPreloadLog(createPreloadLogger(), installation.config.token));

    return installation;
  } catch (error) {
    // `installPreload` does not throw, and neither do the steps around it — but
    // this module runs inside `--import`, where an escaping error takes the
    // developer's dev server down before it starts. So the last word is a catch
    // that cannot be reached and still refuses to rethrow.
    const reason = describeError(error);
    try {
      createPreloadLogger().warn(
        'the Debug Generator preload could not start; this dev server will run without server telemetry',
        { error: reason },
      );
    } catch {
      // Nothing left to report it to.
    }
    return inactive('failed', reason);
  }
}

/**
 * What loading this module did, for a host or a test that wants to look.
 *
 * Reading it is how the launcher or an end-to-end helper distinguishes "the
 * preload is watching this process" from "the credential never arrived", without
 * having to infer either from the absence of spans.
 */
export const preloadInstallation: PreloadInstallation = bootstrap();
