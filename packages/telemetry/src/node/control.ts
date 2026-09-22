/**
 * Capture lifecycle of the Node **dev-server preload**: the control socket, the
 * capture gate, and the teardown that makes the preload genuinely inert.
 *
 * `register.ts` installs the tracer provider, the span processor, the two
 * instrumentations and the span helper once, when the developer's `next dev`
 * process starts. None of that means the process is *capturing*: a dev server
 * can sit armed for hours with no session attached. This module owns the
 * difference. It holds the WebSocket to the local service, applies the
 * `server-agent.config` frames that arrive on it, and answers the one question
 * every span is measured against — is there an active capture, and does it want
 * this signal?
 *
 * ## The promise this file keeps
 *
 * AAP §0.5.1 makes cleanup the product's strongest guarantee: when a session
 * ends, *"what remains is the inert preload module with no active patches, no
 * provider and no file changes, and the application keeps serving."* Both
 * halves matter. `tests/e2e/cleanup.spec.ts` asserts the demo still answers
 * requests afterwards, and `./control.test.ts` asserts that a spy processor's
 * `onStart` count stays at **zero** — proving no span is even *created*, not
 * merely that none is exported.
 *
 * ## Three gating layers, and why each one is needed
 *
 * The OpenTelemetry JS SDK 2.x shapes this. Span processors and the sampler are
 * **constructor-only** on a provider (2.0 removed `addSpanProcessor()` and
 * `getActiveSpanProcessor()`), so nothing can be detached from a live provider.
 * Hence three layers rather than one:
 *
 * **Layer A — {@link DebuggenCaptureSampler}.** A sampling decision of
 * `NOT_RECORD` makes the SDK's tracer return a non-recording span *without
 * constructing the internal span object*, so `SpanProcessor.onStart` is never
 * invoked. That is the mechanism behind the zero-`onStart` assertion, and it is
 * the only layer that still holds when a consumer — Next.js, for one — cached a
 * tracer reference at module load. `trace.disable()` cannot reach such a cached
 * tracer; a sampler the tracer already owns can.
 *
 * **Layer B — the global teardown.** On disable this module calls
 * `trace.disable()` and `propagation.disable()` from `@opentelemetry/api` and
 * awaits `provider.shutdown()`. AAP §0.5.1 requires it explicitly: removing the
 * global provider *"so Next.js's own spans become no-ops"*. Shutting the
 * provider down also stops a cached tracer from processing anything it managed
 * to start.
 *
 * **Layer C — kind filtering.** `./exporter.ts` asks {@link CaptureGate} for
 * every ended span, which is what gives a plan per-signal granularity *inside*
 * an active capture: a plan that asked for no database tracing collects no
 * `db.query` events even though the driver is patched.
 *
 * ## The disable sequence, in order
 *
 * 1. clear the gate, so no further span can be enqueued while teardown runs;
 * 2. `processor.forceFlush()`, so evidence already captured still reaches the
 *    service (the processor itself lives on and is reused by the next capture);
 * 3. `disable()` on the `pg` instrumentation and on the Prisma instrumentation —
 *    the first unwraps the patched `pg` methods, the second clears Prisma's
 *    global instrumentation hook;
 * 4. `trace.disable()` and `propagation.disable()`;
 * 5. `await provider.shutdown()`, then drop the reference.
 *
 * Every step is independently guarded: a failure in one is logged at `warn` and
 * the rest still run. The path is idempotent, and it never unloads the module,
 * never exits the process and never touches a file in the developer's project.
 *
 * `globalThis.__DEBUGGEN__` is deliberately **left installed**. With no
 * provider the span helper degrades to a bare callback invocation, so it costs
 * nothing, and removing it would open a window in which a patched file reloaded
 * by HMR finds no helper at all — which `packages/instrumentation`'s wrapper
 * template treats as "run the original body", but only by luck of ordering.
 * Keeping it makes that ordering irrelevant.
 *
 * ## Re-enabling is a re-registration
 *
 * After a disable the globals are gone and the provider is shut down, so the
 * next capture cannot reuse them: {@link ServerAgentControl} calls the provider
 * **factory** `register.ts` handed it, then `register({ propagator: new
 * W3CTraceContextPropagator() })`. Re-registering that propagator is what
 * restores extraction of the incoming `traceparent` headers the page agent
 * injects. Forget it and the browser↔server correlation seam breaks *silently*
 * on the second capture of a session — every tier still produces spans, they
 * simply stop sharing a trace.
 *
 * ## Privacy
 *
 * The credential is sent and never anything else: never logged, never echoed
 * into an error, never persisted. Every diagnostic from this module passes
 * through a scrub that replaces the token wherever it appears, on the principle
 * that a token in a dev-server terminal outlives the process it belonged to.
 *
 * @example The lifecycle `register.ts` drives
 * ```ts
 * const control = new ServerAgentControl({ config, logger });
 * const processor = new DebuggenSpanProcessor({ gate: control, config });
 * const sampler = new DebuggenCaptureSampler(control);
 * const createProvider = () =>
 *   new NodeTracerProvider({ resource, sampler, spanProcessors: [processor] });
 * const provider = createProvider();
 * provider.register({ propagator: new W3CTraceContextPropagator() });
 * control.attach({ createProvider, provider, processor, instrumentations });
 * control.connect();
 * ```
 */

import { newMessageId, nowEpochMs } from '@debuggen/shared';
import type { Logger } from '@debuggen/shared';
import { propagation, trace } from '@opentelemetry/api';
import type { Attributes, Context, Link, SpanKind, TextMapPropagator } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  AlwaysOnSampler,
  ParentBasedSampler,
  SamplingDecision,
} from '@opentelemetry/sdk-trace-base';
import type { Sampler, SamplingResult } from '@opentelemetry/sdk-trace-base';

import { QUERY_KINDS } from '../schema/kinds.js';
import type { TelemetryKind } from '../schema/kinds.js';
import {
  HELLO_TIMEOUT_MS,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  TRACER_VERSION,
  createPreloadLogger,
} from './config.js';
import type { PreloadConfig } from './config.js';
import type { CaptureGate } from './exporter.js';

/*
 * ---------------------------------------------------------------------------
 * Protocol frames, mirrored by hand
 *
 * The shapes below mirror `packages/protocol/src/envelope.ts` and
 * `packages/protocol/src/messages/agent.ts`. Importing `@debuggen/protocol` is
 * deliberately FORBIDDEN here and enforced by `eslint.config.js`
 * (`no-restricted-imports`): protocol sits ABOVE telemetry and its
 * `telemetry.event` payloads embed this package's `TelemetryEventIngress`, so an
 * import in this direction would close a cycle (AAP §0.2.2). The duplication is
 * the price of the layering, and it is bounded — one envelope, one outbound
 * payload, two inbound payloads.
 *
 * ⚠️ A change to any of those protocol shapes MUST be mirrored here. Nothing
 * mechanical couples the two, so the failure mode is a preload that talks past
 * the service: the socket connects, the frames are ignored, and the session
 * simply never reaches "Ready to capture".
 * ---------------------------------------------------------------------------
 */

/**
 * The `client` discriminator this process announces in `client.hello`.
 *
 * The service authorises by role: a `server-agent` credential may post ingest
 * and receive `server-agent.config` for the one project root it is scoped to,
 * and nothing else (AAP §0.5.6).
 */
export const CONTROL_CLIENT_KIND = 'server-agent';

/**
 * Every message `type` this module sends or understands.
 *
 * Held as a frozen record rather than as loose literals so the outbound
 * construction and the inbound dispatch cannot disagree about a spelling, and
 * so `./control.test.ts` can assert against the same values the implementation
 * uses.
 */
export const CONTROL_MESSAGE_TYPES = Object.freeze({
  /** Outbound, first frame after the upgrade. */
  hello: 'client.hello',
  /** Inbound, the capture instruction this module exists to apply. */
  config: 'server-agent.config',
  /** Inbound, a service-side failure report. Logged, never thrown. */
  error: 'error',
} as const);

/**
 * WebSocket close code the service uses when a credential is missing, late or
 * refused (AAP §0.5.6).
 *
 * Terminal for this process rather than retryable: the server-agent credential
 * is minted per dev-server launch and expires with the process, so a rejected
 * one will never start being accepted. Reconnecting against it in a loop would
 * produce nothing but noise in the developer's terminal.
 */
export const CONTROL_CLOSE_UNAUTHORIZED = 4401;

/**
 * `WebSocket.OPEN`, spelled as a number.
 *
 * {@link ControlSocket} is a structural type with no statics — that is what
 * lets a three-line fake stand in for the real socket in a test — so the
 * readiness constant is named here instead of being read off a constructor.
 */
const SOCKET_OPEN = 1;

/** Normal-closure code, for a socket this module closes on purpose. */
const SOCKET_CLOSE_NORMAL = 1000;

/**
 * Replacement written wherever a diagnostic would otherwise have carried the
 * credential. Matches the placeholder `./exporter.ts` uses.
 */
const REDACTED_PLACEHOLDER = '[redacted]';

/**
 * The envelope every WebSocket frame travels in: `{ id, type, sessionId?, ts,
 * payload }` (AAP §0.2.3).
 *
 * `ts` is epoch milliseconds, the same time base every telemetry event uses, so
 * a frame and the events around it can be read on one timeline.
 */
export interface ControlEnvelope<TPayload> {
  /** A fresh message id, from `newMessageId()`. */
  readonly id: string;
  /** One of {@link CONTROL_MESSAGE_TYPES}. */
  readonly type: string;
  /** Epoch milliseconds, from `nowEpochMs()`. */
  readonly ts: number;
  /** The session this frame belongs to, where it belongs to one. */
  readonly sessionId?: string;
  /** The type-specific body. */
  readonly payload: TPayload;
}

/**
 * Payload of the outbound `client.hello`.
 *
 * Sent as the very first frame after the upgrade and inside
 * {@link HELLO_TIMEOUT_MS}; the service closes a connection that has not
 * announced itself within three seconds with
 * {@link CONTROL_CLOSE_UNAUTHORIZED}.
 */
export interface ClientHelloPayload {
  /** Always {@link CONTROL_CLIENT_KIND}. */
  readonly client: typeof CONTROL_CLIENT_KIND;
  /** The project this dev server serves; the scope of the credential. */
  readonly projectRoot: string;
  /** This package's version, as advisory metadata. */
  readonly version: string;
  /** The server-agent bearer credential. Never logged. */
  readonly token: string;
}

/**
 * The signal switches a capture arrives with.
 *
 * One flag per runtime signal the preload can supply, plus the named symbols
 * the plan patched. `functions` is a list rather than a flag because the plan
 * selects function timing per symbol (AAP §0.2.3).
 */
export interface ServerAgentSignals {
  /** Incoming request spans. */
  readonly http: boolean;
  /** App Router route-handler spans. */
  readonly routeHandlers: boolean;
  /** Outgoing server-side request spans. */
  readonly fetch: boolean;
  /** Prisma query spans. */
  readonly prisma: boolean;
  /** `pg` driver query spans. */
  readonly pg: boolean;
  /** Names of the symbols the plan patched with function timing. */
  readonly functions: readonly string[];
}

/** One key of {@link ServerAgentSignals}. */
export type ServerAgentSignalName = keyof ServerAgentSignals;

/**
 * Payload of the inbound `server-agent.config`.
 *
 * `captureId` is the switch: **absent means disable** (AAP §0.7.1, *"when
 * `captureId` is absent the preload disables its instrumentations"*), present
 * means arm this capture with these signals.
 */
export interface ServerAgentConfigPayload {
  /** The session that owns the capture, where the service names one. */
  readonly sessionId?: string;
  /** The active capture window, or absent to disable. */
  readonly captureId?: string;
  /** Which signals the capture wants. */
  readonly signals: ServerAgentSignals;
}

/** Payload of the inbound `error` frame: `{ code, message, ref? }`. */
export interface ControlErrorPayload {
  /** Stable machine-readable code. */
  readonly code: string;
  /** Human-readable description. */
  readonly message: string;
  /** Optional correlation reference into the service's own logs. */
  readonly ref?: string;
}

/** A frame that survived {@link parseControlFrame}. */
export interface ParsedControlFrame {
  /** The message name; dispatch is on this. */
  readonly type: string;
  /** The envelope's session id, where it carried one. */
  readonly sessionId?: string;
  /** The body, still unvalidated — each handler narrows its own. */
  readonly payload: unknown;
}

/*
 * ---------------------------------------------------------------------------
 * Signals
 * ---------------------------------------------------------------------------
 */

/**
 * The one mapping from a plan's signal switches to the event kinds they admit.
 *
 * Exported as a table rather than buried in a `switch` so `./control.test.ts`
 * can iterate it — every entry asserted, none forgotten — and so a reader can
 * see the whole policy at once:
 *
 * | Signal | Kind |
 * | --- | --- |
 * | `http` | `http.server` |
 * | `routeHandlers` | `route.handler` |
 * | `fetch` | `http.client` |
 * | `prisma` | `db.query` |
 * | `pg` | `db.query` |
 * | `functions` | `function` |
 *
 * `prisma` and `pg` share `db.query` because the kind describes the operation,
 * not which library reported it: a query is database work whether the ORM's
 * instrumentation or the driver's saw it, and `../schema/kinds.ts` has one kind
 * for it. Either flag therefore admits the kind, which is also the honest
 * reading of a plan that asked for "database tracing" against a project using
 * both.
 *
 * `functions` is a **presence-based** policy: a non-empty list enables the
 * `function` kind wholesale rather than filtering by symbol name. The list is
 * kept on the gate so a future refinement can narrow it, but filtering by name
 * here would be the wrong place to do it — a function span's name comes from
 * the patch the plan itself applied, so an unplanned function span cannot exist
 * in the first place, and a name mismatch would silently discard the one signal
 * the developer paid a file modification for.
 */
export const SIGNAL_KINDS: Readonly<Record<ServerAgentSignalName, readonly TelemetryKind[]>> =
  Object.freeze({
    http: Object.freeze<TelemetryKind[]>(['http.server']),
    routeHandlers: Object.freeze<TelemetryKind[]>(['route.handler']),
    fetch: Object.freeze<TelemetryKind[]>(['http.client']),
    // `../schema/kinds.ts` already owns the database kind list; naming it twice
    // is how the two drift.
    prisma: QUERY_KINDS,
    pg: QUERY_KINDS,
    functions: Object.freeze<TelemetryKind[]>(['function']),
  });

/**
 * Kinds admitted whenever the capture wants **any** server signal at all.
 *
 * `server.error` — a failure raised while handling a server-side request — is
 * the one kind `./convert.ts` can classify that no signal flag names. Dropping
 * it would present a failed request as a clean one, and the `error_count`
 * metric and the event log's error filter would both be wrong about a capture
 * that contained an exception. It is admitted alongside any other server
 * signal, and never on its own: a plan that asked for nothing on this tier
 * still collects nothing, which is the guarantee AAP §0.7.1 makes about an
 * unrelated plan.
 */
export const ANY_SIGNAL_KINDS: readonly TelemetryKind[] = Object.freeze<TelemetryKind[]>([
  'server.error',
]);

/** Signals with everything off — the gate's state outside a capture. */
export const NO_SIGNALS: ServerAgentSignals = Object.freeze({
  http: false,
  routeHandlers: false,
  fetch: false,
  prisma: false,
  pg: false,
  functions: Object.freeze<string[]>([]),
});

/** The five boolean members of {@link ServerAgentSignals}, for iteration. */
const BOOLEAN_SIGNAL_NAMES: readonly Exclude<ServerAgentSignalName, 'functions'>[] = Object.freeze<
  Exclude<ServerAgentSignalName, 'functions'>[]
>(['http', 'routeHandlers', 'fetch', 'prisma', 'pg']);

/**
 * Resolve a signal set into the exact kinds the gate will admit.
 *
 * Computed once per config frame and held as a set, because `isKindEnabled` is
 * asked for every ended span and a set lookup is the cheapest honest answer.
 *
 * @param signals The capture's signal switches.
 * @returns The admitted kinds; empty when no signal is on.
 */
export function resolveEnabledKinds(signals: ServerAgentSignals): ReadonlySet<TelemetryKind> {
  const kinds = new Set<TelemetryKind>();

  for (const name of BOOLEAN_SIGNAL_NAMES) {
    if (signals[name]) {
      for (const kind of SIGNAL_KINDS[name]) {
        kinds.add(kind);
      }
    }
  }

  if (signals.functions.length > 0) {
    for (const kind of SIGNAL_KINDS.functions) {
      kinds.add(kind);
    }
  }

  if (kinds.size > 0) {
    for (const kind of ANY_SIGNAL_KINDS) {
      kinds.add(kind);
    }
  }

  return kinds;
}

/*
 * ---------------------------------------------------------------------------
 * Parsing
 *
 * Hand-written guards rather than Zod. `zod` is a dependency of this package
 * and permitted in this subtree, but `esbuild.node.mjs` inlines whatever this
 * module imports into the artefact that is loaded into every instrumented dev
 * server, and a schema library earns its weight where shapes are numerous and
 * shared. Here there are three, none of them shared, and each is a dozen lines
 * of checks that read as the specification they enforce.
 *
 * Everything below answers rather than throws. A malformed frame is a bug in
 * the service or a version skew, and neither is worth taking a developer's dev
 * server down for.
 * ---------------------------------------------------------------------------
 */

/** Whether a value is a plain object that can be indexed by string key. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a member as a non-empty string, treating `undefined` and `null` alike as
 * absent.
 *
 * JSON has no `undefined`, so a service that means "no session" may spell it
 * either way; both must resolve to the same absence rather than to the string
 * `"null"`.
 *
 * @param source The record to read from.
 * @param key The member name.
 * @returns The trimmed value, `undefined` when absent, `null` when present but
 * not a usable string.
 */
function readOptionalString(
  source: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const value = source[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate the `signals` member of a `server-agent.config` payload.
 *
 * Strict where drift would be silent and tolerant where it cannot be: a member
 * that is absent is `false` (a service that stops sending a flag means "off"),
 * but a member that is *present with the wrong type* rejects the whole frame,
 * because that is a protocol change this build has not been taught and guessing
 * at it would arm the wrong signals.
 *
 * @param value The raw `signals` member.
 * @returns The validated signals, or `null` when the member is unusable.
 */
export function normalizeSignals(value: unknown): ServerAgentSignals | null {
  if (!isRecord(value)) {
    return null;
  }

  const flags: Record<string, boolean> = {};
  for (const name of BOOLEAN_SIGNAL_NAMES) {
    const flag = value[name];
    if (flag === undefined || flag === null) {
      flags[name] = false;
      continue;
    }
    if (typeof flag !== 'boolean') {
      return null;
    }
    flags[name] = flag;
  }

  const rawFunctions = value.functions;
  let functions: readonly string[] = NO_SIGNALS.functions;
  if (rawFunctions !== undefined && rawFunctions !== null) {
    if (!Array.isArray(rawFunctions)) {
      return null;
    }
    const names: string[] = [];
    for (const entry of rawFunctions) {
      if (typeof entry !== 'string') {
        return null;
      }
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        names.push(trimmed);
      }
    }
    functions = Object.freeze(names);
  }

  return Object.freeze({
    http: flags.http ?? false,
    routeHandlers: flags.routeHandlers ?? false,
    fetch: flags.fetch ?? false,
    prisma: flags.prisma ?? false,
    pg: flags.pg ?? false,
    functions,
  });
}

/**
 * Validate a `server-agent.config` payload.
 *
 * The asymmetry is deliberate. A payload with **no** `captureId` is the disable
 * instruction, and disabling must never be refused on a technicality, so
 * `signals` may be missing there. A payload **with** a `captureId` that carries
 * no usable `signals` is rejected outright: arming a capture that admits
 * nothing would leave the gate half-open — the sampler recording, the processor
 * dropping — and produce a session that looks armed and captures nothing.
 *
 * @param payload The envelope's payload.
 * @returns The validated payload, or `null` when it is unusable.
 */
export function parseServerAgentConfig(payload: unknown): ServerAgentConfigPayload | null {
  if (!isRecord(payload)) {
    return null;
  }

  const sessionId = readOptionalString(payload, 'sessionId');
  if (sessionId === null) {
    return null;
  }
  const captureId = readOptionalString(payload, 'captureId');
  if (captureId === null) {
    return null;
  }

  const rawSignals = payload.signals;
  if (rawSignals === undefined || rawSignals === null) {
    if (captureId === undefined) {
      return Object.freeze({ signals: NO_SIGNALS });
    }
    return null;
  }

  const signals = normalizeSignals(rawSignals);
  if (signals === null) {
    return null;
  }

  // Built member by member because `exactOptionalPropertyTypes` forbids
  // assigning `undefined` to an optional property: an absent id must be an
  // absent key, not a present key holding nothing.
  if (captureId === undefined) {
    return sessionId === undefined
      ? Object.freeze({ signals })
      : Object.freeze({ sessionId, signals });
  }
  return sessionId === undefined
    ? Object.freeze({ captureId, signals })
    : Object.freeze({ sessionId, captureId, signals });
}

/**
 * Validate an `error` payload.
 *
 * @param payload The envelope's payload.
 * @returns The validated payload, or `null` when it is unusable.
 */
export function parseControlError(payload: unknown): ControlErrorPayload | null {
  if (!isRecord(payload)) {
    return null;
  }
  const code = readOptionalString(payload, 'code');
  const message = readOptionalString(payload, 'message');
  if (code === null || code === undefined || message === null || message === undefined) {
    return null;
  }
  const ref = readOptionalString(payload, 'ref');
  if (ref === null) {
    return Object.freeze({ code, message });
  }
  return ref === undefined
    ? Object.freeze({ code, message })
    : Object.freeze({ code, message, ref });
}

/**
 * Parse one inbound frame into an envelope shape, or `null`.
 *
 * Binary frames are ignored rather than decoded: the control channel is JSON
 * text in both directions, so a binary frame is not a frame this build
 * understands.
 *
 * @param data The `data` member of a message event.
 * @returns The parsed frame, or `null` when it is not one.
 */
export function parseControlFrame(data: unknown): ParsedControlFrame | null {
  if (typeof data !== 'string') {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch {
    return null;
  }

  if (!isRecord(decoded)) {
    return null;
  }

  const type = readOptionalString(decoded, 'type');
  if (type === null || type === undefined) {
    return null;
  }

  const sessionId = readOptionalString(decoded, 'sessionId');
  const payload = decoded.payload;

  return sessionId === undefined || sessionId === null
    ? Object.freeze({ type, payload })
    : Object.freeze({ type, sessionId, payload });
}

/*
 * ---------------------------------------------------------------------------
 * Utilities
 * ---------------------------------------------------------------------------
 */

/**
 * Describe a thrown value for a diagnostic, without carrying a stack into the
 * developer's terminal.
 *
 * Mirrors the helper `./exporter.ts` keeps privately, for the same reason: this
 * module logs failures from five independent teardown steps and a socket, and
 * every one of those messages has to be safe to print.
 *
 * @param error The caught value, of any type.
 * @returns A short single-line description.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.length > 0 ? error.message : error.name;
    return `${error.name}: ${message}`;
  }
  return `non-error value of type ${typeof error}`;
}

/**
 * Drop a timer's claim on the event loop, where the runtime has such a notion.
 *
 * Node's handles carry `unref`; a test double's may be a bare number. This
 * matters more here than anywhere else in the subtree: a reconnect pending
 * against a service that is not running must never be the reason a dev server
 * refuses to exit.
 *
 * `./exporter.ts` keeps an identical private helper. Neither is exported —
 * duplicating six lines of capability check is cheaper than widening a sibling's
 * public surface for it.
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
    // A host whose handle refuses the call keeps its reference. The process may
    // then linger up to one backoff interval, which is not worth a throw.
  }
}

/**
 * The delay before reconnect attempt `attempt`, jittered and clamped.
 *
 * Doubling from {@link RECONNECT_MIN_MS} and capped at
 * {@link RECONNECT_MAX_MS} — the 0.5 s → 10 s envelope AAP §0.5.5 gives every
 * socket in the product. The jitter (±25 %) exists because a developer
 * restarting the local service reconnects every attached dev server at once,
 * and a fleet retrying in lockstep is how a loopback service gets a thundering
 * herd on its first breath.
 *
 * Exported with an injectable source of randomness so `./control.test.ts` can
 * assert the envelope at both extremes rather than sampling it.
 *
 * @param attempt 1 for the first retry, 2 for the second, and so on.
 * @param random A `[0, 1)` source; defaults to `Math.random`.
 * @returns A delay in whole milliseconds, within
 * `[RECONNECT_MIN_MS, RECONNECT_MAX_MS]`.
 */
export function computeReconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 1 ? Math.floor(attempt) : 1;
  // 2 ** 31 is already far beyond the ceiling; capping the exponent keeps the
  // arithmetic finite for a process that has been retrying for weeks.
  const exponent = Math.min(safeAttempt - 1, 31);
  const base = Math.min(RECONNECT_MIN_MS * 2 ** exponent, RECONNECT_MAX_MS);

  const sample = random();
  const factor = Number.isFinite(sample) ? 0.75 + Math.min(Math.max(sample, 0), 1) * 0.5 : 1;
  const jittered = Math.round(base * factor);

  return Math.min(Math.max(jittered, RECONNECT_MIN_MS), RECONNECT_MAX_MS);
}

/*
 * ---------------------------------------------------------------------------
 * Layer A - the gating sampler
 * ---------------------------------------------------------------------------
 */

/**
 * The single `NOT_RECORD` result, shared rather than rebuilt.
 *
 * `shouldSample` runs on every span of every request; a frozen literal keeps
 * the inactive path allocation-free, and the interface documents its results as
 * safely cacheable.
 */
const NOT_RECORDING: SamplingResult = Object.freeze({ decision: SamplingDecision.NOT_RECORD });

/**
 * The sampler that makes "no capture" mean "no span was ever created".
 *
 * A `NOT_RECORD` decision makes the SDK's tracer return a non-recording span
 * *before* it constructs the internal span object, so the span processor's
 * `onStart` is never called, no attributes are collected and nothing is
 * enqueued. Outside a capture this sampler returns exactly that for every span
 * the host process would otherwise create, which is why an armed-but-idle dev
 * server costs its owner nothing and why `./control.test.ts` can assert a spy
 * processor's `onStart` count stays at zero after a disable.
 *
 * It is also the only layer that survives a consumer holding a **cached
 * tracer**. `trace.disable()` removes the global provider, but a module that
 * called `trace.getTracer(…)` at load time — Next.js does — keeps the tracer it
 * already has, and that tracer keeps the sampler it was constructed with. This
 * one. Which is why the gate is consulted here rather than only at the global.
 *
 * Inside a capture the decision is delegated, by default to
 * `ParentBasedSampler({ root: new AlwaysOnSampler() })`, so a request that
 * arrives with a sampled `traceparent` from the page agent stays sampled, its
 * children stay in the same trace, and a parent that was explicitly not sampled
 * is respected rather than overridden.
 *
 * Stateless apart from the gate it reads, and safe to construct before any
 * provider exists — `register.ts` must pass it to the provider's constructor,
 * since SDK 2.x has no way to set a sampler afterwards.
 */
export class DebuggenCaptureSampler implements Sampler {
  /** The capture state; read on every sampling decision. */
  readonly #gate: CaptureGate;

  /** The sampler consulted while a capture is active. */
  readonly #delegate: Sampler;

  /**
   * @param gate The capture gate — normally the {@link ServerAgentControl}
   * instance, and in a test anything with a `captureId`.
   * @param options.delegate The sampler to consult inside a capture; defaults
   * to `ParentBasedSampler({ root: new AlwaysOnSampler() })`.
   */
  constructor(gate: CaptureGate, options: { readonly delegate?: Sampler } = {}) {
    this.#gate = gate;
    this.#delegate = options.delegate ?? new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }

  /**
   * Decide whether a span is worth constructing.
   *
   * Runs inside the developer's own request path for every span the host
   * creates, so the inactive case is one property read and a frozen literal.
   *
   * Never throws: a gate whose getter fails is treated as closed, because the
   * alternative is an exception raised from inside the host's tracer.
   *
   * @param context The parent context.
   * @param traceId The trace the span would belong to.
   * @param spanName The span's name.
   * @param spanKind The span's kind.
   * @param attributes The span's initial attributes.
   * @param links The span's links.
   * @returns The sampling decision.
   */
  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    try {
      if (this.#gate.captureId === null) {
        return NOT_RECORDING;
      }
      return this.#delegate.shouldSample(context, traceId, spanName, spanKind, attributes, links);
    } catch {
      return NOT_RECORDING;
    }
  }

  /** The description the SDK prints when it reports its configuration. */
  toString(): string {
    return `DebuggenCaptureSampler{${this.#delegate.toString()}}`;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Injected collaborators
 *
 * Every dependency is a structural interface, narrow enough that a test can
 * implement it in a few lines and wide enough that the real object satisfies it
 * without a cast. That is what lets `./control.test.ts` assert the disable path
 * — including the unwrapping of `pg` and the zero `onStart` count — with no
 * live service and no database.
 * ---------------------------------------------------------------------------
 */

/**
 * An OpenTelemetry instrumentation, as this module uses one.
 *
 * `@opentelemetry/instrumentation`'s own `Instrumentation` interface carries
 * eight more members this module never touches. Depending on the two it does
 * means the real `PgInstrumentation` and `PrismaInstrumentation` satisfy it and
 * so does a counting fake.
 *
 * Both calls are internally idempotent in the SDK (`enable()` returns early
 * when already enabled, and `disable()` likewise), which is a safety net rather
 * than a licence: this module tracks the state itself so that a second
 * `disable()` is observably a no-op.
 */
export interface ToggleableInstrumentation {
  /** Re-apply the patches. */
  enable(): void;
  /** Remove the patches — for `pg`, unwrap the wrapped methods. */
  disable(): void;
}

/**
 * A tracer provider, as this module uses one.
 *
 * `register` is called on a provider this module built from the factory;
 * `shutdown` is awaited on the way to inert. `NodeTracerProvider` satisfies
 * this structurally, and nothing here needs the rest of its surface.
 */
export interface ControlTracerProvider {
  /**
   * Install this provider, the propagator and the context manager globally.
   *
   * @param config Registration options; this module always passes an explicit
   * `propagator`.
   */
  register(config?: { readonly propagator?: TextMapPropagator | null }): void;

  /** Flush and stop the provider; resolves when it is finished. */
  shutdown(): Promise<void>;
}

/**
 * Builds a **fresh** provider, already configured with the resource, the
 * gating sampler and the long-lived span processor.
 *
 * A factory rather than an instance because SDK 2.x offers no way back from
 * `shutdown()`: once the disable path has run, the next capture needs a new
 * provider object. `register.ts` owns what goes into one, so it owns the
 * factory.
 */
export type TracerProviderFactory = () => ControlTracerProvider;

/**
 * The span processor, as this module uses one: something to flush before
 * teardown.
 *
 * `DebuggenSpanProcessor` satisfies it. The instance is deliberately **not**
 * shut down by the disable path — it survives every enable/disable cycle so
 * that nothing buffered is lost and the next capture reuses its transport.
 */
export interface ControlFlushTarget {
  /** Post everything currently buffered; resolves when it has settled. */
  forceFlush(): Promise<void>;
}

/** The `data` member is all this module reads from an inbound message event. */
export interface ControlSocketMessageEvent {
  /** The frame body; a string for the text frames this channel uses. */
  readonly data: unknown;
}

/** The close code is what decides whether a reconnect is worth attempting. */
export interface ControlSocketCloseEvent {
  /** The WebSocket close code; {@link CONTROL_CLOSE_UNAUTHORIZED} is terminal. */
  readonly code: number;
  /** The peer's reason, where it gave one. */
  readonly reason?: string;
}

/**
 * The WebSocket surface this module uses.
 *
 * Handler properties rather than `addEventListener`, because they are the
 * smaller contract and both Node's global `WebSocket` and a test fake provide
 * them. The real socket is adopted through one documented cast (see
 * {@link resolveGlobalWebSocket}); a fake implements this interface directly.
 */
export interface ControlSocket {
  /** `0` connecting, `1` open, `2` closing, `3` closed. */
  readonly readyState: number;
  /** Send one text frame. */
  send(data: string): void;
  /** Begin the closing handshake. */
  close(code?: number, reason?: string): void;
  /** Set when the connection opens. */
  onopen: ((event: unknown) => void) | null;
  /** Set for every inbound frame. */
  onmessage: ((event: ControlSocketMessageEvent) => void) | null;
  /** Set when the connection closes, for any reason. */
  onclose: ((event: ControlSocketCloseEvent) => void) | null;
  /** Set on a transport error; `onclose` always follows. */
  onerror: ((event: unknown) => void) | null;
}

/** Constructs a {@link ControlSocket} for a `ws:`/`wss:` URL. */
export type ControlSocketConstructor = new (url: string) => ControlSocket;

/**
 * The host's own `WebSocket`, or `undefined` where there is none.
 *
 * Node 24 has a global `WebSocket`, which is why this package adds no `ws`
 * dependency for a channel it opens once per process — and why the preload's
 * bundle stays free of a transport library the host already ships.
 *
 * The cast is from `unknown` after a `typeof` check, never from `any`: the
 * global's handler properties are typed against DOM event classes that a
 * structural interface cannot restate without `strictFunctionTypes` rejecting
 * the variance. The runtime shape is verified — a text frame's `data` is a
 * string, a close event carries `code` — and it is checked in exactly this one
 * place.
 *
 * @returns The global constructor, or `undefined` in a host without one.
 */
export function resolveGlobalWebSocket(): ControlSocketConstructor | undefined {
  const candidate: unknown = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof candidate !== 'function') {
    return undefined;
  }
  return candidate as ControlSocketConstructor;
}

/**
 * The collaborators `register.ts` hands over once it has built them.
 *
 * Separate from construction because the wiring is circular by nature: the
 * processor and the sampler both need the control object as their gate, so the
 * control object has to exist first and receive them afterwards.
 */
export interface ControlAttachment {
  /** The long-lived span processor to flush before teardown. */
  readonly processor?: ControlFlushTarget | undefined;

  /**
   * The `pg` and Prisma instrumentation instances — the same objects
   * `registerInstrumentations` was given, since `disable()` has to act on the
   * instances that hold the patches.
   *
   * Assumed **enabled** on arrival, because `registerInstrumentations()` enables
   * what it registers. That is what makes a session ending without ever having
   * captured still leave the developer's `pg` unwrapped.
   */
  readonly instrumentations?: readonly ToggleableInstrumentation[] | undefined;

  /** Builds a fresh provider for the capture after a disable. */
  readonly createProvider?: TracerProviderFactory | undefined;

  /**
   * The provider that is **already registered** globally.
   *
   * Passing it is how the first capture avoids registering a second provider
   * over the one `register.ts` installed at preload; omitting it tells this
   * module that nothing is registered yet and the factory must run before the
   * first span can be recorded.
   */
  readonly provider?: ControlTracerProvider | undefined;
}

/** Everything {@link ServerAgentControl} takes; only `config` is required. */
export interface ServerAgentControlOptions extends ControlAttachment {
  /** The validated launch configuration from `./config.ts`. */
  readonly config: PreloadConfig;

  /**
   * Where diagnostics go; defaults to `createPreloadLogger()`, which is quiet
   * unless the developer sets `DEBUGGEN_LOG_LEVEL`.
   */
  readonly logger?: Logger | undefined;

  /**
   * The socket constructor; defaults to the host's global `WebSocket`.
   *
   * Injectable so a test drives the whole handshake, including the 4401 path,
   * without a service.
   */
  readonly webSocketImpl?: ControlSocketConstructor | undefined;

  /** A `[0, 1)` source for reconnect jitter; defaults to `Math.random`. */
  readonly random?: (() => number) | undefined;
}

/** What one capture needs to be armed. */
export interface CaptureRequest {
  /** The capture window's id; also the scope of the exporter's `seq` counter. */
  readonly captureId: string;
  /** The session that owns it, where one is known. */
  readonly sessionId?: string | undefined;
  /** Which signals to admit. */
  readonly signals: ServerAgentSignals;
}

/** How {@link ServerAgentControl.applyConfig} resolved a frame. */
export type ApplyConfigOutcome =
  /** A capture was armed, or re-armed with a different id or signal set. */
  | 'enabled'
  /** The capture was torn down and the preload is inert. */
  | 'disabled'
  /** The frame restated the state the gate was already in. */
  | 'unchanged'
  /** The payload did not validate; the previous state was kept. */
  | 'invalid'
  /** The control object has been disposed and no longer applies frames. */
  | 'disposed';

/**
 * A snapshot of the control object's state.
 *
 * The names are a contract with `./control.test.ts`: add a member rather than
 * rename one.
 */
export interface ServerAgentControlStats {
  /** The session that owns the active capture, or `null`. */
  readonly sessionId: string | null;
  /** The active capture, or `null` when the preload is gated shut. */
  readonly captureId: string | null;
  /** The kinds the gate currently admits, in declaration order. */
  readonly enabledKinds: readonly TelemetryKind[];
  /** The symbols the active plan patched. */
  readonly functions: readonly string[];
  /** Whether a socket is currently open. */
  readonly connected: boolean;
  /** How many times a socket has been constructed. */
  readonly connectAttempts: number;
  /** How many `client.hello` frames have been sent. */
  readonly helloSent: number;
  /** Frames received, including the ones ignored. */
  readonly framesReceived: number;
  /** Frames of a `type` this build does not handle. */
  readonly framesIgnored: number;
  /** Frames that did not parse, or payloads that did not validate. */
  readonly invalidFrames: number;
  /** `server-agent.config` frames that changed the state. */
  readonly configsApplied: number;
  /** Captures armed. */
  readonly enableCount: number;
  /** Teardowns that did real work. */
  readonly disableCount: number;
  /** Whether the instrumentations are currently patched in. */
  readonly instrumentationsEnabled: boolean;
  /** Whether a provider is registered globally. */
  readonly providerRegistered: boolean;
  /** Whether the service refused the credential with 4401. */
  readonly credentialRejected: boolean;
  /** Whether {@link ServerAgentControl.dispose} has run. */
  readonly disposed: boolean;
  /** Whether a reconnect timer is pending. */
  readonly reconnectPending: boolean;
  /** The delay of the pending reconnect, in milliseconds. */
  readonly reconnectDelayMs: number;
  /** Teardown or wiring steps that failed and were logged. */
  readonly failures: number;
}

/*
 * ---------------------------------------------------------------------------
 * The control object
 * ---------------------------------------------------------------------------
 */

/**
 * Owns the capture state, the control socket and the teardown.
 *
 * Implements {@link CaptureGate}, so `./exporter.ts` consults this object for
 * every ended span, and {@link DebuggenCaptureSampler} consults it for every
 * span the host process would create. It is the only thing in the preload that
 * knows whether a session is watching.
 *
 * **One capture at a time.** AAP §0.4.2 makes the service the arbiter: at most
 * one session may hold a capture on a project, and `capture.start` for a
 * project already captured by another session is answered `409` with the owning
 * session's id. So `server-agent.config` always names the single owner, and this
 * object keeps one capture id rather than a set. A frame naming a different
 * capture is a clean transition, not a second tenant — and the transition needs
 * no extra bookkeeping, because `./convert.ts`'s `seq` allocator is keyed on
 * `(producerId, captureId)` and restarts itself the moment the id changes.
 *
 * **Ordered application.** Config frames arrive on a socket while a teardown
 * may still be awaiting a flush, so every state change runs through one
 * promise chain and applies in arrival order. The gate itself is closed
 * *synchronously* when a disable arrives, ahead of the queue, because the one
 * thing that must not wait is the instruction to stop recording.
 *
 * Nothing here throws at its caller. A failure in a teardown step, a socket
 * handler or a logger is counted and logged at `warn`, and the remaining steps
 * still run: this code executes inside someone else's dev server, where an
 * exception is a broken product rather than a diagnostic.
 */
export class ServerAgentControl implements CaptureGate {
  /** The validated launch configuration. */
  readonly #config: PreloadConfig;

  /** Where diagnostics go. */
  readonly #logger: Logger;

  /** The socket constructor, resolved once at construction. */
  readonly #webSocketImpl: ControlSocketConstructor | undefined;

  /** The jitter source for {@link computeReconnectDelayMs}. */
  readonly #random: () => number;

  /** The span processor to flush before teardown; never shut down here. */
  #processor: ControlFlushTarget | undefined;

  /** The instrumentation instances whose patches the teardown removes. */
  #instrumentations: readonly ToggleableInstrumentation[] = [];

  /** Builds a fresh provider when a capture follows a disable. */
  #createProvider: TracerProviderFactory | undefined;

  /** The registered provider, or `null` when none is installed. */
  #provider: ControlTracerProvider | null = null;

  /** Whether a provider is installed globally. */
  #providerRegistered = false;

  /** Whether the instrumentations are currently patched in. */
  #instrumentationsEnabled = false;

  /**
   * Whether the preload is torn down: no provider, no patches, no spans.
   *
   * Starts `false` because `register.ts` installs a provider and enables the
   * instrumentations before this object ever sees a frame — the preload begins
   * *armed but gated*, which is why the sampler and not this flag is what keeps
   * an idle dev server silent.
   */
  #inert = false;

  /** The session that owns the active capture. */
  #sessionId: string | null = null;

  /** The active capture, or `null`: the gate's whole answer. */
  #captureId: string | null = null;

  /** The active capture's signals. */
  #signals: ServerAgentSignals = NO_SIGNALS;

  /** The kinds those signals admit, resolved once per config frame. */
  #enabledKinds: ReadonlySet<TelemetryKind> = new Set<TelemetryKind>();

  /** The live socket, or `null` while disconnected. */
  #socket: ControlSocket | null = null;

  /** Pending reconnect, always `unref`'d. */
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  /** Pending handshake deadline, always `unref`'d. */
  #helloTimer: ReturnType<typeof setTimeout> | undefined;

  /** Consecutive failed connections, the exponent of the backoff. */
  #reconnectAttempts = 0;

  /** The pending reconnect's delay, for {@link stats}. */
  #reconnectDelayMs = 0;

  /** Set when the service answers 4401: terminal for this process. */
  #credentialRejected = false;

  /** Set by {@link dispose}: no reconnects, no further frames applied. */
  #disposed = false;

  /** Serialises every state change into arrival order. */
  #tail: Promise<void> = Promise.resolve();

  /** Counters behind {@link stats}. */
  #connectAttempts = 0;
  #helloSent = 0;
  #framesReceived = 0;
  #framesIgnored = 0;
  #invalidFrames = 0;
  #configsApplied = 0;
  #enableCount = 0;
  #disableCount = 0;
  #failures = 0;

  /**
   * @param options The launch configuration, and optionally the collaborators
   * and the two injection points a test needs. Anything omitted here can still
   * arrive through {@link attach}.
   */
  constructor(options: ServerAgentControlOptions) {
    this.#config = options.config;
    this.#logger = options.logger ?? createPreloadLogger();
    this.#webSocketImpl = options.webSocketImpl ?? resolveGlobalWebSocket();
    this.#random = options.random ?? Math.random;
    this.attach(options);
  }

  /*
   * -------------------------------------------------------------------------
   * CaptureGate
   * -------------------------------------------------------------------------
   */

  /**
   * The active capture window's id, or `null` when nothing is armed.
   *
   * Read on every sampling decision and on every ended span, so it is a plain
   * field read behind a getter and never a computation.
   */
  get captureId(): string | null {
    return this.#captureId;
  }

  /** The session that owns the active capture, or `null`. */
  get sessionId(): string | null {
    return this.#sessionId;
  }

  /**
   * Whether the active capture wants events of this kind.
   *
   * Two questions in one answer: is a capture armed at all, and did its plan
   * ask for this signal. A closed gate answers `false` for every kind, so a
   * span that slipped past the sampler — one started while a capture was active
   * and ended after the teardown — is still dropped rather than attributed to a
   * capture that has ended.
   *
   * @param kind The kind `./convert.ts` classified the span as.
   */
  isKindEnabled(kind: TelemetryKind): boolean {
    if (this.#captureId === null) {
      return false;
    }
    return this.#enabledKinds.has(kind);
  }

  /** A snapshot of everything this object tracks. */
  stats(): ServerAgentControlStats {
    return {
      sessionId: this.#sessionId,
      captureId: this.#captureId,
      enabledKinds: [...this.#enabledKinds],
      functions: this.#signals.functions,
      connected: this.#socket !== null && this.#socket.readyState === SOCKET_OPEN,
      connectAttempts: this.#connectAttempts,
      helloSent: this.#helloSent,
      framesReceived: this.#framesReceived,
      framesIgnored: this.#framesIgnored,
      invalidFrames: this.#invalidFrames,
      configsApplied: this.#configsApplied,
      enableCount: this.#enableCount,
      disableCount: this.#disableCount,
      instrumentationsEnabled: this.#instrumentationsEnabled,
      providerRegistered: this.#providerRegistered,
      credentialRejected: this.#credentialRejected,
      disposed: this.#disposed,
      reconnectPending: this.#reconnectTimer !== undefined,
      reconnectDelayMs: this.#reconnectDelayMs,
      failures: this.#failures,
    };
  }

  /*
   * -------------------------------------------------------------------------
   * Wiring
   * -------------------------------------------------------------------------
   */

  /**
   * Receive the collaborators `register.ts` built after this object existed.
   *
   * Each member replaces the previous value when present and leaves it alone
   * when absent, so a caller can attach in stages. Instrumentations arrive
   * **enabled** — `registerInstrumentations()` enables what it registers — and
   * a provider passed here is one that is **already registered globally**;
   * passing a factory alone means nothing is installed yet and the first
   * capture must build one.
   *
   * @param attachment The collaborators to adopt.
   */
  attach(attachment: ControlAttachment): void {
    if (attachment.processor !== undefined) {
      this.#processor = attachment.processor;
    }
    if (attachment.instrumentations !== undefined) {
      this.#instrumentations = attachment.instrumentations;
      this.#instrumentationsEnabled = attachment.instrumentations.length > 0;
    }
    if (attachment.createProvider !== undefined) {
      this.#createProvider = attachment.createProvider;
    }
    if (attachment.provider !== undefined) {
      this.#provider = attachment.provider;
      this.#providerRegistered = true;
    }
  }

  /*
   * -------------------------------------------------------------------------
   * Capture lifecycle
   * -------------------------------------------------------------------------
   */

  /**
   * Apply a `server-agent.config` payload — the code path an inbound frame
   * takes, callable directly with no socket in sight.
   *
   * `captureId` is the switch. **Absent disables**: AAP §0.7.1, *"when
   * `captureId` is absent the preload disables its instrumentations"*. Present
   * arms the capture with the frame's signals.
   *
   * A payload that does not validate is logged at `warn` and **changes
   * nothing**. Guessing at a frame this build does not understand is how a gate
   * ends up half-open — recording spans nobody asked for, or arming a capture
   * that admits no kind at all.
   *
   * @param payload The envelope's payload, unvalidated.
   * @returns How the frame resolved; never rejects.
   */
  applyConfig(payload: unknown): Promise<ApplyConfigOutcome> {
    if (this.#disposed) {
      return Promise.resolve<ApplyConfigOutcome>('disposed');
    }

    const parsed = parseServerAgentConfig(payload);
    if (parsed === null) {
      this.#invalidFrames += 1;
      this.#log('warn', 'ignored a server-agent.config frame that did not validate');
      return Promise.resolve<ApplyConfigOutcome>('invalid');
    }

    if (parsed.captureId === undefined) {
      // Closed ahead of the queue: a teardown may be waiting on a flush, and
      // the instruction to stop recording is the one that must not wait.
      this.#clearGate();
      return this.#serialize(async (): Promise<ApplyConfigOutcome> => {
        const changed = await this.#runDisable();
        if (changed) {
          this.#configsApplied += 1;
        }
        return changed ? 'disabled' : 'unchanged';
      }, 'unchanged');
    }

    const request: CaptureRequest = {
      captureId: parsed.captureId,
      sessionId: parsed.sessionId,
      signals: parsed.signals,
    };
    return this.#serialize((): ApplyConfigOutcome => {
      const changed = this.#runEnable(request);
      if (changed) {
        this.#configsApplied += 1;
      }
      return changed ? 'enabled' : 'unchanged';
    }, 'unchanged');
  }

  /**
   * Arm a capture directly, bypassing the frame parsing.
   *
   * The same code path {@link applyConfig} takes for a payload that carries a
   * `captureId`, exposed so a test — and `register.ts`, if it ever needs to —
   * can arm a capture without constructing a frame.
   *
   * Idempotent: re-arming the same capture with the same signals does nothing.
   *
   * @param request The capture and the signals to admit.
   * @returns Whether anything changed; never rejects.
   */
  enableCapture(request: CaptureRequest): Promise<boolean> {
    if (this.#disposed) {
      return Promise.resolve(false);
    }
    return this.#serialize((): boolean => this.#runEnable(request), false);
  }

  /**
   * Tear the preload down to inert: no active patches, no provider, no spans
   * created — while the application keeps serving.
   *
   * The gate closes synchronously, before this method returns its promise, so
   * no span can be enqueued while the rest of the sequence runs. Everything
   * after that is queued behind any state change already in flight.
   *
   * Idempotent. Calling it twice, or with nothing enabled, resolves without
   * doing anything a second time.
   *
   * @returns A promise that resolves when the sequence has finished; never
   * rejects.
   */
  disable(): Promise<void> {
    this.#clearGate();
    return this.#serialize(async (): Promise<void> => {
      await this.#runDisable();
    }, undefined);
  }

  /**
   * Close the control channel and run the disable path.
   *
   * `register.ts` calls this from its `SIGINT`, `SIGTERM` and `beforeExit`
   * handlers. After it, this object applies no further frames and schedules no
   * further reconnects, which is what lets a dev server exit promptly instead of
   * waiting out a backoff.
   *
   * @returns A promise that resolves when teardown has finished; never rejects.
   */
  async dispose(): Promise<void> {
    this.#clearGate();
    this.#disposed = true;
    this.#clearTimers();
    this.#closeSocket(SOCKET_CLOSE_NORMAL, 'preload shutting down');
    await this.#serialize(async (): Promise<void> => {
      await this.#runDisable();
    }, undefined);
  }

  /**
   * Alias of {@link dispose}, for a caller that thinks of this object as a
   * connection.
   *
   * @returns A promise that resolves when teardown has finished.
   */
  close(): Promise<void> {
    return this.dispose();
  }

  /*
   * -------------------------------------------------------------------------
   * Enable and disable, without the queueing
   * -------------------------------------------------------------------------
   */

  /**
   * Arm the gate and make sure the machinery behind it is installed.
   *
   * The first capture of a process finds the provider already registered by
   * `register.ts` and the instrumentations already enabled, so it is a state
   * assignment and nothing more. A capture that follows a disable finds neither
   * — the globals were removed and the provider shut down — and has to
   * re-register both, propagator included.
   *
   * @param request The capture and the signals to admit.
   * @returns Whether anything changed.
   */
  #runEnable(request: CaptureRequest): boolean {
    if (this.#disposed) {
      return false;
    }

    const kinds = resolveEnabledKinds(request.signals);
    const sessionId = request.sessionId ?? null;

    if (
      !this.#inert &&
      this.#captureId === request.captureId &&
      this.#sessionId === sessionId &&
      sameKinds(this.#enabledKinds, kinds)
    ) {
      return false;
    }

    this.#sessionId = sessionId;
    this.#captureId = request.captureId;
    this.#signals = request.signals;
    this.#enabledKinds = kinds;

    this.#ensureProvider();
    this.#enableInstrumentations();
    this.#inert = false;
    this.#enableCount += 1;

    this.#log('debug', 'capture armed', {
      captureId: request.captureId,
      kinds: [...kinds].join(','),
      functions: request.signals.functions.length,
    });

    if (kinds.size === 0) {
      // Reachable only through `enableCapture`, since a frame carrying a
      // capture id and no usable signals is rejected by the parser. Worth a
      // line either way: a capture that admits nothing looks identical to a
      // broken one from the developer's side.
      this.#log(
        'warn',
        'capture was armed with no server signals; no server telemetry will be sent',
      );
    }

    return true;
  }

  /**
   * The disable sequence of AAP §0.5.1, in order, with every step guarded.
   *
   * 1. the gate is already closed by the caller, and closed again here so a
   *    direct call is as safe as a queued one;
   * 2. flush, so evidence already captured still reaches the service;
   * 3. `disable()` on each instrumentation — this is what unwraps `pg`'s
   *    patched methods and clears Prisma's global instrumentation hook;
   * 4. `trace.disable()` and `propagation.disable()`, removing the global
   *    provider so the host framework's own spans become no-ops;
   * 5. `provider.shutdown()`, so a tracer cached from it stops processing.
   *
   * The span processor is **not** shut down: it outlives every cycle, and the
   * next capture reuses its buffer and its transport. `globalThis.__DEBUGGEN__`
   * is **not** uninstalled either — see this module's overview.
   *
   * @returns Whether this call did the work, `false` when already inert.
   */
  async #runDisable(): Promise<boolean> {
    this.#clearGate();

    if (this.#inert) {
      return false;
    }
    this.#inert = true;
    this.#disableCount += 1;

    const processor = this.#processor;
    if (processor !== undefined) {
      try {
        await processor.forceFlush();
      } catch (error) {
        this.#fail('could not flush captured telemetry before teardown', error);
      }
    }

    this.#disableInstrumentations();

    try {
      trace.disable();
    } catch (error) {
      this.#fail('could not remove the global tracer provider', error);
    }
    try {
      propagation.disable();
    } catch (error) {
      this.#fail('could not remove the global propagator', error);
    }

    const provider = this.#provider;
    this.#provider = null;
    this.#providerRegistered = false;
    if (provider !== null) {
      try {
        await provider.shutdown();
      } catch (error) {
        this.#fail('could not shut the tracer provider down', error);
      }
    }

    this.#log('debug', 'instrumentation removed; the preload is inert');
    return true;
  }

  /**
   * Install a provider if none is registered.
   *
   * Re-registering the W3C propagator is the part that is easy to lose and
   * expensive to lose: it is what extracts the incoming `traceparent` the page
   * agent injects, so without it the second capture of a session still produces
   * browser spans and server spans that share no trace. The break is silent —
   * every tier looks healthy on its own — which is why the propagator is passed
   * explicitly here rather than left to `register()`'s defaults.
   *
   * `register()` supplies the Node `AsyncLocalStorage` context manager itself,
   * which is why this package needs no direct dependency on
   * `@opentelemetry/context-async-hooks`.
   */
  #ensureProvider(): void {
    if (this.#providerRegistered) {
      return;
    }

    const factory = this.#createProvider;
    if (factory === undefined) {
      this.#fail(
        'no tracer provider factory is attached; server spans cannot be re-enabled for this capture',
        undefined,
      );
      return;
    }

    try {
      const provider = factory();
      provider.register({ propagator: new W3CTraceContextPropagator() });
      this.#provider = provider;
      this.#providerRegistered = true;
      this.#log('debug', 'tracer provider and W3C propagator registered');
    } catch (error) {
      this.#fail('could not register a tracer provider for this capture', error);
    }
  }

  /** Re-apply the instrumentation patches, if they are not already applied. */
  #enableInstrumentations(): void {
    if (this.#instrumentationsEnabled || this.#instrumentations.length === 0) {
      return;
    }
    for (const instrumentation of this.#instrumentations) {
      try {
        instrumentation.enable();
      } catch (error) {
        this.#fail('could not enable an instrumentation', error);
      }
    }
    this.#instrumentationsEnabled = true;
  }

  /**
   * Remove the instrumentation patches.
   *
   * Guarded by the local flag so a second teardown is observably a no-op, even
   * though the SDK's own `disable()` is idempotent. The flag starts `true` when
   * instrumentations are attached, so a session that ends without ever having
   * captured anything still leaves the developer's `pg` unwrapped — which is
   * exactly what `./control.test.ts` asserts through shimmer's `isWrapped`.
   */
  #disableInstrumentations(): void {
    if (!this.#instrumentationsEnabled) {
      return;
    }
    for (const instrumentation of this.#instrumentations) {
      try {
        instrumentation.disable();
      } catch (error) {
        this.#fail('could not disable an instrumentation', error);
      }
    }
    this.#instrumentationsEnabled = false;
  }

  /** Close the gate: no capture, no signals, no admitted kinds. */
  #clearGate(): void {
    this.#sessionId = null;
    this.#captureId = null;
    this.#signals = NO_SIGNALS;
    if (this.#enabledKinds.size > 0) {
      this.#enabledKinds = new Set<TelemetryKind>();
    }
  }

  /**
   * Run `work` after everything already queued, and never let it reject.
   *
   * State changes arrive from two directions — the socket and a direct call —
   * and two of them interleaving would let a teardown's flush finish after the
   * next capture had already been armed. One chain removes the question.
   *
   * The returned promise never rejects: an unexpected throw is counted, logged
   * and answered with `fallback`. That is what makes "never throws at its
   * caller" a property of the structure rather than a promise about every
   * branch inside it.
   *
   * @param work The state change to apply.
   * @param fallback The result to report if `work` fails.
   * @returns Its result, or `fallback`.
   */
  #serialize<T>(work: () => T | Promise<T>, fallback: T): Promise<T> {
    const run = this.#tail.then(work).catch((error: unknown): T => {
      this.#fail('a capture state change failed', error);
      return fallback;
    });
    this.#tail = run.then(() => undefined);
    return run;
  }

  /*
   * -------------------------------------------------------------------------
   * Control socket
   * -------------------------------------------------------------------------
   */

  /**
   * Open the control channel, and keep it open.
   *
   * `register.ts` calls this last, once the provider, processor, sampler and
   * span helper are all in place, so a config frame can never arrive before the
   * machinery it configures. It returns immediately — the dev server must never
   * wait on the local service — and the connection retries on its own schedule.
   *
   * A second call while a socket exists does nothing. A call after the
   * credential was refused does nothing either: see
   * {@link CONTROL_CLOSE_UNAUTHORIZED}.
   */
  connect(): void {
    if (this.#disposed || this.#credentialRejected || this.#socket !== null) {
      return;
    }

    const Socket = this.#webSocketImpl;
    if (Socket === undefined) {
      this.#fail(
        'no WebSocket implementation is available; this dev server will send telemetry but receive no capture instructions',
        undefined,
      );
      return;
    }

    this.#connectAttempts += 1;

    let socket: ControlSocket;
    try {
      // No `Origin` header: the service refuses an `http:`/`https:` web origin
      // and accepts its absence from a Node client (AAP §0.5.6). Node's global
      // WebSocket sends none, and nothing here adds one.
      socket = new Socket(this.#config.controlUrl);
    } catch (error) {
      this.#fail('could not open the control socket', error);
      this.#scheduleReconnect();
      return;
    }

    this.#socket = socket;
    this.#startHelloDeadline(socket);

    socket.onopen = (): void => {
      this.#handleOpen(socket);
    };
    socket.onmessage = (event: ControlSocketMessageEvent): void => {
      this.#handleMessage(event);
    };
    socket.onclose = (event: ControlSocketCloseEvent): void => {
      this.#handleClose(socket, event);
    };
    socket.onerror = (): void => {
      // `onclose` always follows, and it is the event that decides what to do;
      // this one only exists so a transport error is visible at debug level.
      this.#log('debug', 'control socket reported a transport error');
    };
  }

  /**
   * Announce this client, immediately, as the first frame on the wire.
   *
   * @param socket The socket that just opened.
   */
  #handleOpen(socket: ControlSocket): void {
    try {
      if (socket !== this.#socket) {
        return;
      }

      const frame: ControlEnvelope<ClientHelloPayload> = {
        id: newMessageId(),
        type: CONTROL_MESSAGE_TYPES.hello,
        ts: nowEpochMs(),
        payload: {
          client: CONTROL_CLIENT_KIND,
          projectRoot: this.#config.projectRoot,
          version: TRACER_VERSION,
          token: this.#config.token,
        },
      };

      if (!this.#send(socket, frame)) {
        return;
      }

      this.#helloSent += 1;
      this.#clearHelloDeadline();
      // The connection is established; the next failure starts the backoff over
      // rather than resuming where the last outage left off.
      this.#reconnectAttempts = 0;
      this.#reconnectDelayMs = 0;
      this.#log('debug', 'control socket connected', { url: this.#config.controlUrl });
    } catch (error) {
      this.#fail('could not complete the control handshake', error);
    }
  }

  /**
   * Dispatch one inbound frame.
   *
   * Unknown `type` values are ignored silently — the service may speak a
   * younger protocol than this build, and a frame we have no handler for is not
   * an error. A malformed one is counted and logged at debug.
   *
   * @param event The message event.
   */
  #handleMessage(event: ControlSocketMessageEvent): void {
    try {
      this.#framesReceived += 1;

      const frame = parseControlFrame(event.data);
      if (frame === null) {
        this.#invalidFrames += 1;
        this.#log('debug', 'ignored an unparseable control frame');
        return;
      }

      if (frame.type === CONTROL_MESSAGE_TYPES.config) {
        // `applyConfig` never rejects, and the `catch` is here anyway: an
        // unhandled rejection inside a socket handler is reported against the
        // developer's dev server, not against us.
        this.applyConfig(frame.payload).catch((error: unknown) => {
          this.#fail('could not apply a server-agent.config frame', error);
        });
        return;
      }

      if (frame.type === CONTROL_MESSAGE_TYPES.error) {
        const parsed = parseControlError(frame.payload);
        if (parsed === null) {
          this.#invalidFrames += 1;
          return;
        }
        this.#log('warn', `the local service reported an error: ${parsed.code}`, {
          detail: parsed.message,
          ...(parsed.ref === undefined ? {} : { ref: parsed.ref }),
        });
        return;
      }

      this.#framesIgnored += 1;
    } catch (error) {
      this.#fail('could not handle a control frame', error);
    }
  }

  /**
   * Decide what a closed socket means.
   *
   * The gate is deliberately left alone. A capture in progress keeps capturing
   * across a brief outage — the exporter buffers and retries over HTTP
   * independently — because a developer who has just reproduced an issue must
   * not lose it to a service restart.
   *
   * @param socket The socket that closed.
   * @param event The close event.
   */
  #handleClose(socket: ControlSocket, event: ControlSocketCloseEvent): void {
    try {
      if (socket !== this.#socket) {
        // A socket this module already abandoned; its close is not news.
        return;
      }
      this.#socket = null;
      this.#clearHelloDeadline();

      if (this.#disposed) {
        return;
      }

      if (event.code === CONTROL_CLOSE_UNAUTHORIZED) {
        this.#credentialRejected = true;
        this.#log(
          'warn',
          "the local service refused this dev server's credential (close 4401); no capture instructions will arrive. Relaunch the dev server from the Debug Generator view to mint a fresh one.",
        );
        return;
      }

      this.#log('debug', 'control socket closed', { code: event.code });
      this.#scheduleReconnect();
    } catch (error) {
      this.#fail('could not handle the control socket closing', error);
    }
  }

  /**
   * Retry the connection on the 0.5 s → 10 s jittered envelope of AAP §0.5.5.
   *
   * The timer is always `unref`'d: a dev server that has finished its work must
   * never be held open by a pending reconnect to a service that is not running.
   */
  #scheduleReconnect(): void {
    if (this.#disposed || this.#credentialRejected || this.#reconnectTimer !== undefined) {
      return;
    }

    this.#reconnectAttempts += 1;
    const delay = computeReconnectDelayMs(this.#reconnectAttempts, this.#random);
    this.#reconnectDelayMs = delay;

    const timer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      try {
        this.connect();
      } catch (error) {
        this.#fail('could not reconnect the control socket', error);
      }
    }, delay);
    unrefTimer(timer);
    this.#reconnectTimer = timer;
  }

  /**
   * Fail the connection if the handshake has not completed in time.
   *
   * {@link HELLO_TIMEOUT_MS} sits just under the service's three-second
   * deadline, so this module notices its own stalled handshake and retries on
   * its own schedule instead of being closed by the peer and having to infer
   * why.
   *
   * @param socket The socket the deadline belongs to.
   */
  #startHelloDeadline(socket: ControlSocket): void {
    this.#clearHelloDeadline();
    const timer = setTimeout(() => {
      this.#helloTimer = undefined;
      if (socket !== this.#socket) {
        return;
      }
      this.#log('debug', 'the control handshake did not complete in time; retrying');
      this.#socket = null;
      this.#closeSocketInstance(socket, SOCKET_CLOSE_NORMAL, 'handshake timeout');
      this.#scheduleReconnect();
    }, HELLO_TIMEOUT_MS);
    unrefTimer(timer);
    this.#helloTimer = timer;
  }

  /** Drop the handshake deadline, if one is pending. */
  #clearHelloDeadline(): void {
    if (this.#helloTimer !== undefined) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = undefined;
    }
  }

  /** Drop both timers, if either is pending. */
  #clearTimers(): void {
    this.#clearHelloDeadline();
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#reconnectDelayMs = 0;
  }

  /**
   * Close the current socket, if there is one, and forget it.
   *
   * @param code The close code to send.
   * @param reason The close reason to send.
   */
  #closeSocket(code: number, reason: string): void {
    const socket = this.#socket;
    if (socket === null) {
      return;
    }
    this.#socket = null;
    this.#closeSocketInstance(socket, code, reason);
  }

  /**
   * Close one socket instance, whatever state it is in.
   *
   * @param socket The socket to close.
   * @param code The close code to send.
   * @param reason The close reason to send.
   */
  #closeSocketInstance(socket: ControlSocket, code: number, reason: string): void {
    try {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close(code, reason);
    } catch (error) {
      this.#log('debug', 'closing the control socket failed', { error: describeError(error) });
    }
  }

  /**
   * Send one frame, if the socket is open.
   *
   * @param socket The socket to send on.
   * @param frame The frame to serialise.
   * @returns Whether it was sent.
   */
  #send<TPayload>(socket: ControlSocket, frame: ControlEnvelope<TPayload>): boolean {
    if (socket.readyState !== SOCKET_OPEN) {
      this.#log('debug', 'a control frame was not sent because the socket is not open', {
        type: frame.type,
      });
      return false;
    }
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.#fail('could not send a control frame', error);
      return false;
    }
  }

  /*
   * -------------------------------------------------------------------------
   * Diagnostics
   * -------------------------------------------------------------------------
   */

  /**
   * Count a failure and report it once, at `warn`.
   *
   * Every teardown and wiring step routes its failures here so that a partial
   * teardown is visible to the developer and countable by a test, and so that
   * no step's failure can abort the ones after it.
   *
   * @param message What could not be done, in the developer's terms.
   * @param error The caught value, where there was one.
   */
  #fail(message: string, error: unknown): void {
    this.#failures += 1;
    if (error === undefined) {
      this.#log('warn', message);
      return;
    }
    this.#log('warn', message, { error: describeError(error) });
  }

  /**
   * Log one line, with the credential scrubbed out of it.
   *
   * The scrub is belt and braces — nothing here deliberately logs the token —
   * but a credential printed into a dev-server terminal survives in scrollback
   * long after the process it belonged to, so the cheap guarantee is worth
   * having at the one place every line passes through.
   *
   * @param level `debug` for the ordinary course of events, `warn` for a
   * degraded condition.
   * @param message The message.
   * @param fields Structured detail.
   */
  #log(level: 'debug' | 'warn', message: string, fields?: Record<string, unknown>): void {
    try {
      const safeMessage = this.#scrub(message);
      if (fields === undefined) {
        if (level === 'warn') {
          this.#logger.warn(safeMessage);
        } else {
          this.#logger.debug(safeMessage);
        }
        return;
      }

      const safeFields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        safeFields[key] = typeof value === 'string' ? this.#scrub(value) : value;
      }
      if (level === 'warn') {
        this.#logger.warn(safeMessage, safeFields);
      } else {
        this.#logger.debug(safeMessage, safeFields);
      }
    } catch {
      // A logger that throws must not become an application failure, and a
      // failed diagnostic has nowhere left to be reported.
    }
  }

  /**
   * Replace the credential wherever it appears in a string.
   *
   * @param text The text about to be logged.
   * @returns The text, with any occurrence of the token replaced.
   */
  #scrub(text: string): string {
    const token = this.#config.token;
    if (token.length === 0 || !text.includes(token)) {
      return text;
    }
    return text.split(token).join(REDACTED_PLACEHOLDER);
  }
}

/**
 * Whether two kind sets admit exactly the same kinds.
 *
 * Used for the enable path's idempotence check: a service that re-sends the
 * capture it already sent — on a reconnect, for instance — must not cause a
 * provider to be rebuilt or a counter to move.
 *
 * @param left One set.
 * @param right The other.
 * @returns Whether they are equal.
 */
function sameKinds(left: ReadonlySet<TelemetryKind>, right: ReadonlySet<TelemetryKind>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const kind of left) {
    if (!right.has(kind)) {
      return false;
    }
  }
  return true;
}
