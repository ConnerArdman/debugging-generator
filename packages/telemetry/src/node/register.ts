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
 *    this package needs no `@opentelemetry/context-async-hooks` dependency —
 *    and that context manager is the one process-global effect of these steps
 *    that outlives teardown (see "The one global effect that stays" below).
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
 * ## Nothing acquired is ever left unowned
 *
 * Six of those steps take something with a **process-global** effect that this
 * module gives back — the `diag` logger, the control object, the long-lived
 * processor, the registered provider and propagator, the `pg`/Prisma patches
 * and `globalThis.__DEBUGGEN__` — so each one is pushed onto a rollback ledger
 * the moment it exists, and for the instrumentations *before* the first
 * instance is constructed, because `InstrumentationBase` enables one in its
 * constructor. The failure path gives every one of the six back in reverse
 * order, and the shutdown sequence gives back the same six. AAP §0.5.1 requires
 * that what remains loaded is an inert module with "no active patches, no
 * provider and no file changes", and that has to hold for an installation that
 * *failed part-way* exactly as it does for one that was torn down.
 *
 * Because {@link installPreload} returns synchronously, the ledger separates
 * what has to be *revoked* from what merely has to be *closed*: the global
 * effects it gives back (`diag`, the provider and propagator, the `pg`/Prisma
 * patches, the span helper) are undone before the `failed` result exists, and
 * the closable ones (the control socket, the exporter, the provider's
 * processors) are drained by the promise that result's `shutdown()` hands back,
 * which a caller may await. {@link RollbackStep} documents the split.
 *
 * Ownership of a *successful* installation is reserved on the global slot
 * **before** the first step runs ({@link bootstrap}), because the alternative —
 * installing first and claiming afterwards — has a window in which an active
 * preload exists that {@link shutdownPreload} cannot reach.
 *
 * ## The one global effect that stays
 *
 * `register()` has one more process-global effect, and nothing here gives it
 * back: when no context manager is registered yet, the SDK's default
 * `AsyncLocalStorageContextManager` becomes `@opentelemetry/api`'s global
 * context manager. When one already is, the API refuses the duplicate and the
 * existing manager stays; the same refusal keeps the first manager in place
 * through every later capture's `register()`.
 *
 * It is left **deliberately**. Neither the failure path, nor
 * {@link shutdownPreload}, nor `control.ts`'s disable path calls
 * `context.disable()`, because that call disables and unregisters *whichever*
 * manager is global at that moment, not specifically the one this module
 * installed. That may be a manager the host registered first, and even when it
 * is ours, the host's own tracing — Next.js's tracer, or the application's own
 * OpenTelemetry calls — works through it too, so disabling it would disable
 * another actor's context manager.
 *
 * It is inert after teardown. With the global provider and propagator back at
 * the API's no-op defaults, a tracer resolved through the API records nothing
 * and no `traceparent` is extracted or injected. A tracer Next.js cached before
 * the teardown still consults {@link DebuggenCaptureSampler}, which answers
 * `NOT_RECORD` with the capture gate closed, so no span is recorded. The manager
 * does no work of its own: it only carries the context values callers set
 * through `context.with()`, and once the span helper and the instrumentations
 * are gone this module sets none. It is neither a patch nor a provider nor a
 * file change, so AAP §0.5.1's "no active patches, no provider and no file
 * changes" still describes the process. It goes away when the dev server is
 * restarted without the preload.
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
import { diag, DiagLogLevel, propagation, trace } from '@opentelemetry/api';
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
import { installSpanHelper, uninstallSpanHelper } from './span-helper.js';

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
   * Tear this installation down: remove the `globalThis.__DEBUGGEN__` span
   * helper, dispose the control object, shut the processor down and undo any
   * diagnostics wiring. Idempotent, and it never rejects.
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
 * `shutdown` is always present, so every caller of {@link installPreload} can
 * treat the result uniformly instead of branching on the status before it can
 * clean up.
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

  /**
   * For `inert` and `duplicate`: resolves immediately, because nothing was
   * taken.
   *
   * For `failed`: the best-effort close of whatever the abandoned attempt had
   * already opened — the control socket, the exporter, the provider's
   * processors — which begins the instant the failure is caught, so awaiting it
   * waits for that work to finish rather than starting it. Every *process-global*
   * effect the attempt ledgered is already undone before the `failed` result
   * exists and is deliberately not part of this promise (see
   * {@link RollbackStep}): awaiting is how a caller learns the process is quiet,
   * never how it becomes clean. The one global effect never undone — the
   * `AsyncLocalStorage` context manager `register()` may have installed — is
   * left on purpose and is inert; see "The one global effect that stays" in this
   * module's overview.
   *
   * Idempotent and it never rejects, whatever the status.
   */
  readonly shutdown: () => Promise<void>;
}

/** The outcome of {@link installPreload}. */
export type PreloadInstallation = InstalledPreload | InactivePreload;

/**
 * What is parked on the global slot: enough to recognise an existing
 * installation and to tear it down from a module scope that did not create it.
 */
interface PreloadSlot {
  /**
   * Epoch milliseconds at which the owning evaluation reserved the slot, which
   * is a moment *before* its installation completed: ownership is claimed first
   * (see {@link bootstrap}) and this record is never replaced afterwards.
   */
  readonly installedAt: number;

  /** The installing build's version, so a mismatch is visible in a log line. */
  readonly version: string;

  /**
   * The way to tear down the installation this record owns.
   *
   * It delegates rather than holding a teardown directly, because the slot is
   * claimed *before* the installation is attempted — so that an active preload
   * can never exist without an owner — and this is the one record the slot ever
   * holds for that evaluation. While there is nothing to tear down yet it
   * resolves immediately; from the moment there is, every caller reaching the
   * slot reaches that work, including the rollback of an installation that
   * failed.
   */
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
 * Replace every occurrence of the credential in a string.
 *
 * The one scrub this module applies, shared by {@link createPreloadLog} — every
 * diagnostic line — and by the `failed` result of {@link installPreload}, whose
 * `reason` is a string a host reads and may print. An error thrown by a
 * collaborator that was handed the configuration can quote the credential in
 * its message, and {@link describeError} reproduces that message verbatim.
 *
 * @param text The text to clean.
 * @param token The server-agent credential, or `''` when there is none yet.
 * @returns `text` with the credential replaced by {@link REDACTED_PLACEHOLDER}.
 */
function scrubCredential(text: string, token: string): string {
  if (token.length === 0 || !text.includes(token)) {
    return text;
  }
  return text.split(token).join(REDACTED_PLACEHOLDER);
}

/**
 * Wrap a {@link Logger} so nothing this module emits can carry the credential.
 *
 * @param logger The underlying sink.
 * @param token The server-agent credential, or `''` when there is none yet.
 * @returns A scrubbed, never-throwing logging facade.
 */
function createPreloadLog(logger: Logger, token: string): PreloadLog {
  const scrub = (text: string): string => scrubCredential(text, token);

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
 * @param shutdown What the caller gets to await; defaults to
 * {@link noopShutdown}, which is right for every status but `failed` — a failed
 * attempt hands back the rollback of what it had already acquired, so the one
 * caller who wants to know the process is quiet again can wait for it.
 * @returns The inactive installation.
 */
function inactive(
  status: InactivePreload['status'],
  reason: string,
  shutdown: () => Promise<void> = noopShutdown,
): InactivePreload {
  return { status, reason, shutdown };
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
 * Crash-safe rollback
 * ---------------------------------------------------------------------------
 */

/**
 * One thing {@link installPreload} took from the process, and the way to give it
 * back.
 *
 * The installation acquires six resources with process-global effects that it
 * gives back, and a throw between any two of them would otherwise leave the
 * earlier ones live in the developer's server owned by nobody — a registered
 * provider still collecting Next.js's spans, a `pg` still wrapped, a buffer
 * still holding evidence — while the function reports `failed`. So an entry is
 * pushed here the moment each resource exists — and, where the acquisition
 * itself takes effect in steps that can fail part-way (registering the
 * provider, constructing and configuring the instrumentations, installing the
 * span helper), *before* it begins — and the failure path runs the ledger in
 * reverse.
 *
 * ## Two kinds of undo, because the function that runs them cannot await
 *
 * {@link installPreload} is called at module scope under `--import`, so it
 * returns synchronously and may *start* teardown work but never wait for it.
 * That is fine for a resource which merely has to be closed, and not fine at all
 * for one whose effect is **process-global**: a registered provider keeps
 * collecting Next.js's spans, a shimmer-wrapped `pg` keeps calling into an
 * abandoned tracer and `globalThis.__DEBUGGEN__` keeps answering patched
 * functions for as long as nobody undoes them — and the normal caller of a
 * `failed` result is a module evaluation that awaits nothing. So the word
 * `failed` has to be true of the process the moment it is returned, which splits
 * every ledger entry's undo in two:
 *
 * - `revoke` — **synchronous**, and the failure path runs every one of them to
 *   completion, newest first, *before* {@link installPreload} returns:
 *   `diag.disable()`, `trace.disable()` + `propagation.disable()`, `disable()`
 *   on each instrumentation instance that came into existence, and
 *   `uninstallSpanHelper()`. After a `failed` result exists, no global provider,
 *   no global propagator, no `pg`/Prisma patch and no `__DEBUGGEN__` remain.
 *   No entry revokes the `AsyncLocalStorage` context manager `register()` may
 *   have installed; it is the one global effect that stays, deliberately and
 *   inertly (see this module's overview).
 * - `drain` — **asynchronous**, for what needs closing rather than revoking:
 *   `control.dispose()`, `processor.shutdown()` and `provider.shutdown()`. These
 *   are gathered into the one memoized, never-rejecting promise the `failed`
 *   result's `shutdown()` hands back, so a caller that wants to know the socket
 *   is closed and the buffered evidence has had its last chance awaits exactly
 *   that work rather than starting a second copy of it.
 *
 * A step may carry either or both: the provider registration is revoked
 * globally *and* drained.
 *
 * A plain array rather than a disposer stack class: it is read exactly once, on
 * one code path, in one function.
 */
interface RollbackStep {
  /** What this step gives back, for one `warn` line. A name, never a value. */
  readonly label: string;

  /**
   * Undo this step's process-global effect, synchronously.
   *
   * Absent on a step that has no such effect. Must not block: it runs inside
   * {@link installPreload}, before it returns.
   */
  readonly revoke?: (() => void) | undefined;

  /**
   * Close what this step opened, asynchronously.
   *
   * Absent on a step with nothing to close. Awaited only from the `failed`
   * result's `shutdown()`, never from {@link installPreload} itself.
   */
  readonly drain?: (() => Promise<void>) | undefined;
}

/**
 * Undo every process-global effect this attempt ledgered, newest first,
 * synchronously and without raising.
 *
 * Reversed for the same reason the drain is: the steps are ordered by
 * acquisition, and a global installed over an earlier one has to come off first.
 * Each step is independently guarded, so one that refuses still leaves the rest
 * to run, and each refusal is a single scrubbed `warn` naming the step. Total by
 * construction: the caller is a `catch` in a function that must not throw.
 *
 * @param steps The ledger, in acquisition order.
 * @param log Where a step that could not be revoked is reported.
 */
function revokeGlobalEffects(steps: readonly RollbackStep[], log: PreloadLog): void {
  let revoked = 0;

  for (const step of [...steps].reverse()) {
    const revoke = step.revoke;
    if (revoke === undefined) {
      continue;
    }
    try {
      revoke();
      revoked += 1;
    } catch (error) {
      log.warn('a failed preload installation could not revoke one process-global effect', {
        step: step.label,
        error: describeError(error),
      });
    }
  }

  log.debug('the process-global effects of a failed preload installation were revoked', {
    steps: revoked,
  });
}

/**
 * Close every resource this attempt opened, newest first, and resolve either
 * way.
 *
 * Sequential and reversed on purpose: closing them concurrently — or in
 * acquisition order — would shut the long-lived processor down while the
 * provider layered above it is still flushing through it. Each step is
 * independently guarded, so one that fails still leaves the rest to run, and
 * each failure is a single scrubbed `warn` naming the step. The returned promise
 * never rejects: it is started from a `--import` module scope and handed back as
 * an {@link InactivePreload.shutdown}, and neither may see a rejection.
 *
 * @param steps The ledger, in acquisition order.
 * @param log Where a step that could not be closed is reported.
 */
async function drainAcquisitions(steps: readonly RollbackStep[], log: PreloadLog): Promise<void> {
  let drained = 0;

  for (const step of [...steps].reverse()) {
    const drain = step.drain;
    if (drain === undefined) {
      continue;
    }
    try {
      await drain();
      drained += 1;
    } catch (error) {
      log.warn('a failed preload installation could not close one resource', {
        step: step.label,
        error: describeError(error),
      });
    }
  }

  log.debug('failed preload installation drained', { steps: drained });
}

/**
 * Return the global tracer provider and the global propagator to the API's
 * no-op defaults: the same two calls, in the same order, that `control.ts`'s
 * disable path makes.
 *
 * Synchronous, and that is the point — these two are the part of the
 * registration's process-global footprint this module gives back, so they are
 * the `revoke` half of the provider's ledger entry and are gone before a
 * `failed` result exists. What is left of the registration to undo is
 * `provider.shutdown()`, which drains the provider's processors (for this
 * provider, {@link ProviderScopedSpanProcessor} — a flush, and deliberately not
 * a terminal shutdown of the long-lived processor, whose own ledger step owns
 * that) and is therefore the entry's `drain`.
 *
 * Both calls are guarded on their own so a host that refuses the first still
 * gets the second. `context.disable()` is deliberately **not** called, and
 * `control.ts` does not call it either, so the third global `register()` takes
 * — the SDK's default `AsyncLocalStorage` context manager, installed only when
 * no context manager was registered before — is still installed after this
 * runs. `context.disable()` disables and unregisters whichever manager is
 * global, so it would reach past our own installation into the host's: a
 * manager the host registered first, or ours while the host's own tracing still
 * runs through it. With no provider and no propagator left, that manager is
 * inert; see "The one global effect that stays" in this module's overview.
 *
 * @param log Where a call that failed is reported.
 */
function revokeGlobalTracing(log: PreloadLog): void {
  try {
    trace.disable();
  } catch (error) {
    log.warn('could not remove the global tracer provider', { error: describeError(error) });
  }

  try {
    propagation.disable();
  } catch (error) {
    log.warn('could not remove the global propagator', { error: describeError(error) });
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
 * **Why the caller passes a list in.** `InstrumentationBase` **enables an
 * instrumentation in its constructor**, and `registerInstrumentations`
 * configures the list it is given one entry at a time — so this function reaches
 * the process in three steps, not one, and a throw at the second or the third
 * leaves the first one's patches live. Reporting the instances only through the
 * return value would therefore hand the caller nothing to undo on exactly the
 * paths that need undoing. Each instance is appended to `acquired` the moment it
 * exists instead, so the rollback entry the caller establishes *before* calling
 * this function already covers a partial acquisition.
 *
 * @param acquired Mutable list the caller owns the contents of; every
 * instrumentation instance this function constructs is appended to it
 * immediately, whether or not registration then succeeds.
 * @returns The Prisma and `pg` instrumentations, enabled, in registration order,
 * frozen — the pair `control.attach` holds for the life of the process.
 */
function registerServerInstrumentations(
  acquired: ToggleableInstrumentation[],
): readonly ToggleableInstrumentation[] {
  const prisma = new PrismaInstrumentation();
  acquired.push(prisma);

  const pg = new PgInstrumentation();
  acquired.push(pg);

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
 * Remove the span helper global, close the control channel, make a last
 * bounded attempt at the buffered evidence, and undo the diagnostics wiring.
 *
 * Every step is independently guarded, so a failure in one still leaves the
 * others to run, and the whole sequence resolves rather than rejecting: it is
 * awaited from a signal handler in the developer's own process.
 *
 * After it, the process holds none of the six process-global effects this
 * module gives back — the same state the failure path of
 * {@link installPreload} leaves, which is what AAP §0.5.1's "no active
 * patches, no provider" requires of a preload that has been torn down.
 *
 * One global effect of the installation does remain: the `AsyncLocalStorage`
 * context manager `register()` installed, if no context manager was registered
 * before it. It is left deliberately, because `context.disable()` disables
 * whichever manager is global, and that can be another actor's context manager.
 * It is also inert: with no provider and no propagator, a tracer resolved
 * through the API is a no-op and a tracer cached earlier gets `NOT_RECORD` from
 * {@link DebuggenCaptureSampler} now that the capture gate is closed, so no span
 * is recorded, and the manager only carries the context values callers set —
 * none of them from this module. See "The one global effect that stays" in this
 * module's overview.
 *
 * `globalThis.__DEBUGGEN__` goes first, synchronously, before the first
 * `await`: `control.dispose()` does not own it, and revoking it before
 * anything asynchronous begins mirrors the failure path, which revokes every
 * ledgered global effect before it drains anything. A patched function called
 * from then on runs its original body directly, because the patch template
 * branches on the helper's availability.
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
    // Identity-tracked and total: a helper another copy of the preload
    // installed, or a global replaced since, is left exactly where it is.
    uninstallSpanHelper();
  } catch (error) {
    log.warn('the span helper global could not be removed', { error: describeError(error) });
  }

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
 * file — sits inside one `try/catch`. Every resource with a process-global
 * effect this module gives back is registered with a {@link RollbackStep} the
 * moment it is acquired — and the instrumentations before the first of them is
 * constructed, since constructing one enables it — so a throw at any point
 * gives back everything ledgered up to it, newest first: one `warn` is emitted,
 * every ledgered global effect is revoked before this function returns, the
 * close of what remains open starts immediately and is what the `failed`
 * result's `shutdown()` hands back, and the developer keeps a working, untraced
 * dev server whose process holds no provider, no propagator, no patches and no
 * span helper. The `AsyncLocalStorage` context manager `register()` may have
 * installed is the one global effect left, deliberately and inertly (see "The
 * one global effect that stays" in this module's overview). **Nothing escapes
 * this function.**
 *
 * Synchronous by contract: `--import` evaluates this module, and
 * {@link bootstrap} calls this at module scope, so nothing here may block on
 * teardown — which is exactly why the rollback revokes the global half inline
 * and merely *starts* the asynchronous half (see {@link RollbackStep}).
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

  // What this attempt has taken from the process, in acquisition order. Pushed
  // to as each resource appears and read only on the failure path below, which
  // is what makes "whatever was acquired is owned" true at every line of the
  // sequence rather than only at its end.
  const rollback: RollbackStep[] = [];

  try {
    const diagWired = wireDiagnostics(logger, log);
    if (diagWired) {
      rollback.push({
        label: 'OpenTelemetry diagnostic logger',
        revoke: (): void => {
          diag.disable();
        },
      });
    }

    // 1. The resource: what every span of this process says it came from. A
    //    plain value with no process-global effect, so it needs no rollback.
    const resource = buildResource(config);

    // 2. The control object, before its two consumers: the processor and the
    //    sampler both read it as their capture gate, so it has to exist first.
    //    It needs no provider at construction time and receives the rest of its
    //    collaborators through `attach` below.
    const control = new ServerAgentControl({
      config,
      logger,
      webSocketImpl: options.webSocketImpl,
    });
    // A drain rather than a revoke: `dispose()` closes a socket and flushes,
    // which is asynchronous by nature. Everything global it would also undo —
    // the provider, the propagator and the instrumentation patches — has its own
    // synchronous `revoke` below, so the failure path does not depend on this
    // one having finished. The cleanup report `dispose()` resolves with is for
    // a capture's `disable` handshake; on this path there is no capture to
    // report to, so it is awaited and dropped.
    rollback.push({
      label: 'control channel',
      drain: async (): Promise<void> => {
        await control.dispose();
      },
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
    // `control.dispose()` deliberately never shuts the processor down — that is
    // what lets one capture follow another — so a failed install is the one
    // place that has to make it terminal itself.
    rollback.push({
      label: 'telemetry exporter',
      drain: (): Promise<void> => processor.shutdown(),
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

    // Registered with the ledger *before* `register()` is called, not after:
    // registration is the step that puts the provider, the propagator and the
    // context manager into the process, and a throw part-way through it must be
    // covered too. Undoing an unregistered provider is harmless — the two
    // `disable()` calls are no-ops against the API's defaults and
    // `shutdown()` on a provider nobody registered simply flushes.
    //
    // Both halves, because registration is both: the two `disable()` calls undo
    // the global effect this entry gives back — the provider and the propagator
    // — and are revoked synchronously, while draining the provider's processors
    // is asynchronous and belongs to the awaited half. The context manager
    // registration may also install is deliberately not revoked (see
    // `revokeGlobalTracing`).
    rollback.push({
      label: 'tracer provider registration',
      revoke: (): void => {
        revokeGlobalTracing(log);
      },
      drain: (): Promise<void> => provider.shutdown(),
    });

    // 6. Registering is what makes Next.js's own spans appear and what lets its
    //    request tracer extract the `traceparent` the page agent injects. The
    //    propagator is passed explicitly because 2.0 dropped environment-variable
    //    propagator configuration; `register()` installs the Node
    //    `AsyncLocalStorage` context manager itself, so this package needs no
    //    `@opentelemetry/context-async-hooks` dependency. That manager stays
    //    installed after any teardown, by design (see the overview).
    provider.register({ propagator: new W3CTraceContextPropagator() });

    // 7. Instrumentations: after the provider, before the application's modules.
    //
    // The ledger entry is established *before the first instance is
    // constructed*, over a list the acquisition appends to as each one comes
    // into existence: `InstrumentationBase` enables an instrumentation in its
    // constructor and `registerInstrumentations` configures the list
    // sequentially, so "one instrumentation exists and is patched, the other
    // does not" is a reachable state — a throw while constructing `pg`, or
    // part-way through registration — and it has to be owned like any other.
    // `disable()` is what unwraps the `pg` methods shimmer wrapped and clears
    // Prisma's global hook (AAP §0.5.1). Each instance is guarded on its own, so
    // one that refuses does not strand the other one's patches.
    const acquiredInstrumentations: ToggleableInstrumentation[] = [];
    rollback.push({
      label: 'pg and Prisma instrumentation',
      revoke: (): void => {
        for (const instrumentation of acquiredInstrumentations) {
          try {
            instrumentation.disable();
          } catch (error) {
            log.warn('could not remove an instrumentation patch', {
              error: describeError(error),
            });
          }
        }
      },
    });
    const instrumentations = registerServerInstrumentations(acquiredInstrumentations);

    control.attach({ processor, instrumentations, createProvider, provider });

    // 8. `globalThis.__DEBUGGEN__`, so a function the session patches later —
    //    including one HMR reloads mid-capture — finds the helper already there
    //    on its first invocation.
    //
    // Ledgered before the install, for the same reason as the provider and the
    // instrumentations: the entry has to exist from the first moment the effect
    // can. `uninstallSpanHelper()` is identity-tracked and reports rather than
    // raises, so an entry whose install never happened, or whose global belongs
    // to another copy of the preload, is a no-op rather than a hazard.
    rollback.push({
      label: 'span helper global',
      revoke: (): void => {
        uninstallSpanHelper();
      },
    });
    installSpanHelper({ logger });

    // 9. The control socket, last: a `server-agent.config` frame can now only
    //    arrive at machinery that is already complete. `connect()` returns
    //    immediately and retries on its own schedule, because the dev server
    //    must never wait on the local service.
    const shouldConnect = options.connect !== false;
    if (shouldConnect) {
      control.connect();
    }

    // Ownership transfers here: from this line the ledger is abandoned unrun and
    // everything it described belongs to this closure, which is what the global
    // slot and `shutdownPreload()` reach.
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
    // Scrubbed here rather than only on the way into the log: the reason is
    // also handed back as `InactivePreload.reason`, which a host reads and may
    // print, and that field is documented as value-free.
    const reason = scrubCredential(describeError(error), config.token);
    log.warn(
      'the Debug Generator preload could not install; this dev server will run without server telemetry',
      { error: reason },
    );

    // Give back everything this attempt ledgered, newest first: no registered
    // provider, no wrapped `pg`, no Prisma hook, no span helper, no live
    // exporter, no open socket (AAP §0.5.1). The one thing not given back is
    // the `AsyncLocalStorage` context manager, if `register()` got as far as
    // installing it — left on purpose and inert (see the overview).
    //
    // The global half first, and *to completion*: this function returns
    // synchronously — module scope under `--import` — so a caller reading
    // `failed` may never await anything, and "failed" has to already be true of
    // the process rather than true once somebody waits. No provider, no
    // propagator, no `pg`/Prisma patch and no `__DEBUGGEN__` survive this line.
    revokeGlobalEffects(rollback, log);

    // Then the closable half, started here rather than queued — the developer's
    // process must not keep an open socket or a live exporter a moment longer
    // than it has to — and *not* awaited, for the same reason as above. The one
    // promise is handed back as the result's `shutdown`, so a caller that needs
    // to know the process is quiet again awaits exactly this work instead of
    // starting a second copy of it. It never rejects.
    const drained = drainAcquisitions(rollback, log);

    return inactive('failed', reason, (): Promise<void> => drained);
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
 * Whatever sits at the slot symbol right now, read without raising.
 *
 * Raw and unvalidated on purpose: {@link readPreloadSlot} builds the structural
 * check on top of it, and {@link bootstrap} needs the value *itself* to compare
 * against the record it parked there — an equivalent-looking object is not the
 * same owner, and only identity distinguishes "our reservation is still the
 * slot" from "something replaced it with a record of its own".
 *
 * A read can throw: the slot may be an accessor another actor defined, on an
 * exotic or proxied global. An unreadable slot is reported as `undefined`, which
 * every caller already treats as "not ours".
 *
 * @returns The current value, or `undefined` when it is absent or unreadable.
 */
function readRawSlotValue(): unknown {
  try {
    return slotHost()[PRELOAD_SLOT_KEY];
  } catch {
    // A frozen, proxied or exotic global is not worth a throw; the caller treats
    // an unreadable slot as one that is not ours.
    return undefined;
  }
}

/**
 * The installation already present in this process, if there is one.
 *
 * @returns The slot, or `undefined` when it is absent or unrecognisable.
 */
function readPreloadSlot(): PreloadSlot | undefined {
  const value = readRawSlotValue();
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as { shutdown?: unknown };
  return typeof candidate.shutdown === 'function' ? (value as PreloadSlot) : undefined;
}

/**
 * Claim the slot for this installation, reporting a refusal rather than raising
 * it.
 *
 * Non-enumerable, so nothing that walks `globalThis` — a test's snapshot, a
 * serialiser in the developer's own application — trips over it, and
 * configurable so a later build can replace it.
 *
 * `Object.defineProperty` is the one call here that can throw at a host's
 * discretion: a frozen `globalThis`, a sealed one, or a non-configurable
 * property already sitting at this symbol. That is a refusal to answer, never a
 * reason to take a dev server down, so it is returned as `false` — and
 * {@link bootstrap} makes the refusal mean "install nothing" while there is
 * still nothing to lose.
 *
 * Called **once** per evaluation, for the reservation {@link bootstrap} makes
 * before it installs anything. There is deliberately no second claim afterwards:
 * the reservation already carries this build's version and this evaluation's
 * timestamp and already delegates to the installation, so replacing it would buy
 * nothing and would open a window in which the slot's value can change under an
 * installation that is complete.
 *
 * @param slot The record to park.
 * @param log Where a refusal is reported.
 * @returns Whether the slot now holds `slot`.
 */
function claimPreloadSlot(slot: PreloadSlot, log: PreloadLog): boolean {
  try {
    Object.defineProperty(globalThis, PRELOAD_SLOT_KEY, {
      value: slot,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    return true;
  } catch (error) {
    log.warn('could not claim the preload slot on globalThis', {
      error: describeError(error),
    });
    return false;
  }
}

/**
 * Give the slot up again, so a later evaluation of this module is free to
 * install.
 *
 * The counterpart of {@link claimPreloadSlot} for the two paths that reserved
 * ownership and then had nothing to own: an inert or failed installation, and
 * bootstrap's last-resort catch. Deletion first — the slot should leave no trace
 * — with an overwrite as the fallback, because a property another actor made
 * non-configurable refuses `delete` (silently in a sloppy-mode host, by throwing
 * in a strict one) while still accepting a write. `undefined` is a value
 * {@link readPreloadSlot} reads as an absent slot, which is what makes the
 * fallback equivalent.
 *
 * Never throws: it runs on failure paths that have nowhere to report to.
 *
 * @param log Where an unreleasable slot is reported.
 */
function releasePreloadSlot(log: PreloadLog): void {
  try {
    if (Reflect.deleteProperty(globalThis, PRELOAD_SLOT_KEY)) {
      return;
    }
    log.debug('the preload slot refused deletion; overwriting it instead');
  } catch (error) {
    log.debug('the preload slot refused deletion; overwriting it instead', {
      error: describeError(error),
    });
  }

  try {
    slotHost()[PRELOAD_SLOT_KEY] = undefined;
  } catch (error) {
    log.warn(
      'could not release the preload slot; a later evaluation of this module will report a duplicate and install nothing',
      { error: describeError(error) },
    );
  }
}

/**
 * Keep the slot until `teardown` has settled, then give it up — but only if it
 * is still this evaluation's to give.
 *
 * The failure paths of {@link bootstrap} have two obligations that pull against
 * each other: a rollback that is still running must stay **reachable** — it is
 * an active installation until it finishes, and `shutdownPreload()` only reaches
 * what the slot leads to — while a later evaluation of this module, the dev
 * server relaunched with a credential, must eventually be free to install. So
 * the reservation stays in place for exactly as long as the teardown runs, and
 * the slot is released the moment it is over.
 *
 * The identity check before the release is the same one bootstrap makes after a
 * successful install, for the same reason: releasing a value another actor has
 * since parked there would strand *its* owner.
 *
 * Started rather than awaited by its callers, because module evaluation must not
 * block; the returned promise therefore never rejects, and nothing is left for a
 * caller to handle.
 *
 * @param reservation The record this evaluation claimed, compared by identity.
 * @param teardown The rollback already in flight; it never rejects, and the
 * guard here is for the case where a future one does.
 * @param log Where a teardown that ended badly, or an unreleasable slot, is
 * reported.
 */
async function releasePreloadSlotAfter(
  reservation: PreloadSlot,
  teardown: Promise<void>,
  log: PreloadLog,
): Promise<void> {
  try {
    await teardown;
  } catch (error) {
    log.warn('the rollback of a failed preload installation did not complete cleanly', {
      error: describeError(error),
    });
  }

  if (readRawSlotValue() !== reservation) {
    log.debug('the preload slot is no longer held by this evaluation; leaving it to its owner');
    return;
  }

  releasePreloadSlot(log);
}

/**
 * Tear down the preload installed in this process, if any.
 *
 * Delegates to the installation's own shutdown — the span helper's removal,
 * `control.dispose()`, then the exporter's final flush — and resolves
 * immediately when nothing is installed.
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
 * **Total by construction.** Every registration is guarded, because this runs
 * after {@link bootstrap} already owns a live installation: a `process` that
 * refuses a listener (one whose `once` a test framework or a sandbox replaced,
 * or one at its listener limit) costs the flush on the way out, which is a
 * degradation, while a throw from here would cost the installation itself, which
 * is not acceptable. What is lost is buffered evidence at exit, never the
 * teardown — `shutdownPreload()` still reaches the installation through the slot.
 *
 * @param log Where the handlers, and a refused registration, report.
 */
function attachTerminationHandlers(log: PreloadLog): void {
  if (terminationHandlersAttached) {
    return;
  }
  terminationHandlersAttached = true;

  for (const signal of TERMINATION_SIGNALS) {
    try {
      // The signal is taken from the loop rather than from the listener's
      // argument, so the handler knows which signal it is re-raising even on a
      // host that calls the listener with nothing.
      process.once(signal, () => {
        void handleTerminationSignal(signal, log);
      });
    } catch (error) {
      log.warn('could not install the flush-on-signal handler', {
        signal,
        error: describeError(error),
      });
    }
  }

  try {
    // `beforeExit` covers the process that ends because its work is done. It
    // does not fire for `process.exit()` or for a signal, which is what the
    // handlers above are for.
    process.once('beforeExit', () => {
      void withDeadline(shutdownPreload(), SHUTDOWN_DEADLINE_MS);
    });
  } catch (error) {
    log.warn('could not install the flush-on-exit handler', {
      error: describeError(error),
    });
  }
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
 * Reserve ownership, install once per process, and arm the exit handlers.
 *
 * The duplicate guard is the reason this is separate from
 * {@link installPreload}: two evaluations of this module mean two module scopes
 * — `--import` given twice, or the artefact reached by two specifiers — and only
 * the global symbol registry is shared between them. The second pass finds the
 * slot claimed and installs nothing, because two providers would double every
 * span and two control sockets would fight over one capture.
 *
 * ## The invariant: an active preload is never unowned
 *
 * {@link shutdownPreload} resolves the installation *through the slot*, so an
 * installation the slot does not lead to cannot be torn down at all — not by the
 * launcher, not by the signal handlers, not by a second evaluation. Claiming the
 * slot after installing would therefore leave a window in which a refused claim
 * (a frozen `globalThis`, or a non-configurable property already at that symbol)
 * abandons a fully active preload: provider registered, `pg` patched, socket
 * connected, and nothing left holding its teardown.
 *
 * So ownership is reserved **first**, with a record whose `shutdown` delegates
 * to a binding this function fills in the moment there is something to delegate
 * to. That one record is the slot's *permanent* entry: it already carries this
 * build's version and this evaluation's timestamp, and it already leads to the
 * installation, so there is nothing a second claim could add — and a second
 * claim is itself a window, since the slot's value can change between the
 * `defineProperty` that would replace the reservation and the installation that
 * depends on being reachable. There is therefore exactly one claim per
 * evaluation, and after the install this function *verifies* instead: the slot
 * must still hold the reservation object itself.
 *
 * That makes every ending safe:
 *
 * - a refused reservation happens before anything is acquired, so "install
 *   nothing" is a complete answer;
 * - a successful install is reachable the instant it exists, through a record
 *   that was already on the slot;
 * - a slot that no longer holds the reservation means ownership was taken away
 *   and cannot be re-established — another actor's value may be non-configurable,
 *   and overwriting it would strand *its* owner — so the installation is torn
 *   down and reported `failed` rather than left active and unreachable;
 * - a *failed* install keeps the reservation until its rollback has settled, so
 *   the work is reachable while it runs, and releases the slot afterwards so a
 *   later evaluation can retry;
 * - `inert` and `duplicate` acquired nothing, so they release immediately (a
 *   duplicate never reserved anything in the first place).
 *
 * An inert preload has built nothing, so a later evaluation is free to try again
 * — which is what lets a developer's second dev server, launched with a
 * credential, install in a process that already loaded this module without one.
 *
 * Nothing here blocks: every teardown this function begins is started and never
 * awaited, because a `--import` module that waits delays the developer's dev
 * server from starting.
 *
 * @returns What the evaluation did.
 */
function bootstrap(): PreloadInstallation {
  // The teardown of whatever this evaluation owns, once it owns something: a
  // completed installation's shutdown, or the still-running rollback of one that
  // failed. The reservation below closes over this *binding* rather than over a
  // value, which is what lets the slot be claimed before the installation
  // exists.
  let owned: (() => Promise<void>) | undefined;
  // The record this evaluation parked on the slot, kept because ownership is
  // verified by identity against it and released only while it is still there.
  // `undefined` until the claim succeeds.
  let reservation: PreloadSlot | undefined;
  // Built inside the try, so a logger that cannot be constructed still cannot
  // throw out of module evaluation; the catch falls back to building its own.
  let log: PreloadLog | undefined;

  try {
    log = createPreloadLog(createPreloadLogger(), '');

    const existing = readPreloadSlot();
    if (existing !== undefined) {
      log.debug('preload already installed in this process; this evaluation installs nothing', {
        installedAt: existing.installedAt,
        version: existing.version,
      });
      return inactive(
        'duplicate',
        'another evaluation of this module already installed the preload in this process',
      );
    }

    // The permanent slot record, claimed once and never replaced: it carries
    // this build's version and this evaluation's timestamp, and its `shutdown`
    // delegates to whatever this evaluation comes to own.
    const claimed: PreloadSlot = {
      installedAt: nowEpochMs(),
      version: TRACER_VERSION,
      // Resolves immediately while `owned` is unset: a caller who reaches the
      // slot during the reservation window is asking to tear down something
      // that does not exist yet, and there is nothing for them to wait for.
      shutdown: async (): Promise<void> => {
        await owned?.();
      },
    };

    if (!claimPreloadSlot(claimed, log)) {
      // Nothing has been acquired, so nothing can be left unowned — which is
      // precisely why the reservation comes first.
      return inactive(
        'failed',
        `the ${String(PRELOAD_SLOT_KEY.description)} slot on globalThis could not be claimed; nothing was installed`,
      );
    }
    reservation = claimed;

    const installation = installPreload();
    if (installation.status !== 'installed') {
      if (installation.status === 'failed') {
        // A failed attempt has already revoked every process-global effect it
        // ledgered, but the close of what it opened is still in flight — and
        // until that settles this evaluation owns live work, which
        // `shutdownPreload()` has to be able to reach. So the reservation stays,
        // now delegating to that rollback, and the slot is given up only once it
        // is over, which is what still lets a later evaluation retry.
        owned = installation.shutdown;
        void releasePreloadSlotAfter(claimed, installation.shutdown(), log);
      } else {
        // An inert evaluation acquired nothing, so it must leave the slot
        // exactly as it found it and the next evaluation of this module — the
        // dev server relaunched with a credential — is free to install.
        releasePreloadSlot(log);
        reservation = undefined;
      }
      return installation;
    }

    // Ownership becomes real here, before any other statement can run: from
    // this assignment the record already on the slot leads to this
    // installation's teardown.
    owned = installation.shutdown;

    // …and it is only ownership while the slot still holds that very record.
    // Compared by identity against the raw value, because an equivalent-looking
    // record is a *different* owner: anything that replaced the reservation —
    // another actor's own slot value, a non-configurable property defined over
    // it, a getter that now answers something else — has taken this
    // installation's only route to `shutdownPreload()` away, and an active
    // preload nobody can reach is the single outcome this ordering exists to
    // prevent. Ownership cannot be re-established either: overwriting whatever
    // is there now would strand its owner in exactly the same way. So the
    // installation is handed back to the process and the evaluation reports
    // `failed`, with the teardown as the result's `shutdown`.
    if (readRawSlotValue() !== claimed) {
      log.warn(
        'the preload slot on globalThis was taken over while the preload was installing; this installation is being torn down and this dev server will run without server telemetry',
      );
      const teardown = installation.shutdown();
      return inactive(
        'failed',
        `the ${String(PRELOAD_SLOT_KEY.description)} slot on globalThis no longer holds this evaluation's reservation; the installation was torn down`,
        (): Promise<void> => teardown,
      );
    }

    attachTerminationHandlers(createPreloadLog(createPreloadLogger(), installation.config.token));

    return installation;
  } catch (error) {
    // `installPreload` does not throw, the slot helpers report refusals instead
    // of raising them and `attachTerminationHandlers` is total — but this module
    // runs inside `--import`, where an escaping error takes the developer's dev
    // server down before it starts. So the last word is a catch that cannot be
    // reached and still refuses to rethrow, and it keeps this function's
    // invariant on the one path nobody can plan for: whatever this evaluation
    // owns is torn down (its `shutdown` never rejects, and it is started rather
    // than awaited because module evaluation must not block) while the
    // reservation still leads to that work, the slot is released once the work
    // has settled, and a reservation with nothing behind it is released at once.
    const reason = describeError(error);

    if (owned !== undefined) {
      const teardown = owned();
      // `owned` is only ever set after both the logger and the reservation
      // exist, so the release below is always reached on this branch; the guards
      // are what keep that true for a future edit rather than assumed.
      if (reservation !== undefined && log !== undefined) {
        void releasePreloadSlotAfter(reservation, teardown, log);
      }
    } else if (reservation !== undefined && log !== undefined) {
      releasePreloadSlot(log);
    }

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
