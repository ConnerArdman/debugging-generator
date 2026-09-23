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
 * **Layer C — per-span admission.** `./exporter.ts` asks {@link CaptureGate}
 * about every ended span, which is what gives a plan per-signal granularity
 * *inside* an active capture, on three axes — because one event kind is not one
 * signal:
 *
 * - **kind**, so a plan that asked for no database tracing collects no
 *   `db.query` events even though the driver is patched;
 * - **instrumentation source**, so a plan that asked for the ORM's queries
 *   collects none of the driver's, which share that single kind;
 * - **patched identity**, so a `function` span is collected only for a symbol
 *   *this* plan patched — a patch left behind by an earlier session is not this
 *   capture's evidence.
 *
 * And **capture identity**: a span is evidence for the capture it started in,
 * not for whichever capture is armed when it ends. The service assigns
 * `captureId` when a batch arrives, so a span from a replaced capture cannot be
 * labelled correctly and is refused. This module's part of that is to flush the
 * outgoing capture before it arms the next one and to advance the capture
 * generation `./exporter.ts` stamps spans with.
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
 * Every step is independently guarded *and independently tracked*: a failure in
 * one is logged at `warn`, the rest still run, and the step that failed keeps
 * its handle and its recorded state so the teardown reports `partial` naming
 * that resource and the next attempt — a second `disable()`, or the next
 * capture's installation — retries exactly it. Reporting a failed step as done
 * is the one outcome AAP §0.5.1 rules out: the preload would claim to be inert
 * while `pg` was still wrapped or a provider still registered, and nothing
 * would ever try again. The path is idempotent, and it never unloads the
 * module, never exits the process and never touches a file in the developer's
 * project.
 *
 * What "tracked" has to mean is set by the SDK rather than chosen here.
 * `InstrumentationBase` (`@opentelemetry/instrumentation` 0.222.0) sets its own
 * enabled flag **before** it runs the patch or unpatch callbacks and returns
 * immediately when the flag already holds the target value. So a `disable()`
 * that throws leaves the flag reading "disabled" with the host's modules
 * possibly still wrapped, and a *second* `disable()` on that instrumentation
 * does nothing at all — its silence is not evidence of anything. An
 * instrumentation whose toggle threw is therefore recorded as
 * {@link INSTRUMENTATION_STATES.unknown} and keeps the report `partial`, with a
 * restart named as the remedy, rather than being upgraded to `clean` by a
 * no-op. Forcing an enable/unpatch cycle to recover was considered and
 * rejected: shimmer tracks one layer of original per method, so a double wrap
 * followed by a single unwrap can leave a live wrapper behind — worse than an
 * honest report.
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
 * Two more things belong to that re-registration. A teardown that did **not**
 * finish is completed first, because `trace.setGlobalTracerProvider` refuses to
 * replace an installed global: registering over a registration this object
 * could not remove would silently leave the capture running against the
 * provider that was shut down. And the shared span processor is **reopened**,
 * because `provider.shutdown()` shuts its processors down — the SDK owns them,
 * while this product shares one across every provider a session builds — so
 * without it the second capture would create spans and export none.
 *
 * A capture that cannot get a provider is **not armed**. The gate stays shut,
 * the outcome says `failed`, and the same frame retries; the alternative is a
 * session that every surface of the product shows as capturing while no span is
 * ever created (AAP §0.5.5).
 *
 * Whether it *got* one is asked of the global registry, not inferred from the
 * absence of a throw. `trace.setGlobalTracerProvider` answers `false` — keeping
 * the incumbent — when a global provider is already registered, and
 * `NodeTracerProvider.register()` returns `void`, so a second OpenTelemetry
 * setup in the same dev server (an `instrumentation.ts` `register()`,
 * `@vercel/otel`, a second preload) produces a refusal that nothing reports.
 * This module compares the global against the provider it holds — including the
 * one `register.ts` attaches at bootstrap, whose registration the caller could
 * not have observed either — and refuses the capture with that diagnosis when
 * they differ.
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

import { FUNCTION_ATTRIBUTE_KEYS, MAX_PREVIEW_LENGTH } from '../schema/attributes.js';
import { QUERY_KINDS } from '../schema/kinds.js';
import type { TelemetryKind } from '../schema/kinds.js';
import { truncate } from '../redaction/rules.js';
import {
  HELLO_TIMEOUT_MS,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  WIRE_PROTOCOL_VERSION,
  createPreloadLogger,
} from './config.js';
import type { PreloadConfig } from './config.js';
import { DB_CLIENT_VALUES, DB_INSTRUMENTATION_SCOPES } from './convert.js';
import type { DatabaseSpanSource } from './convert.js';
import type { CaptureGate, SpanAdmission, SpanAdmissionCandidate } from './exporter.js';

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
 * The W3C Trace Context header the propagator must carry.
 *
 * Checked after registration, because the propagator is what extracts the
 * `traceparent` the page agent injects: without it every tier still produces
 * spans and they simply stop sharing a trace (AAP §0.4.2). Spelled here rather
 * than imported from `@opentelemetry/semantic-conventions`, which does not
 * declare propagation fields.
 */
const TRACEPARENT_FIELD = 'traceparent';

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
  /**
   * The **protocol** version, {@link WIRE_PROTOCOL_VERSION} — never this
   * package's version.
   *
   * It is a compatibility signal rather than metadata: the service parses it
   * and compares its major component against its own before it will send
   * `server-agent.config`, so a package version here is a refused handshake
   * and a capture with no server-tier spans.
   */
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
 * **This table is the coarse axis, and it is not the whole policy.** Two of the
 * six signals cannot be expressed as a kind:
 *
 * - `prisma` and `pg` share `db.query` because the kind describes the
 *   operation, not which library reported it: a query is database work whether
 *   the ORM's instrumentation or the driver's saw it, and `../schema/kinds.ts`
 *   has one kind for it. But the two flags are *independent* in
 *   `server-agent.config` (AAP §0.4.2), so admitting the kind is not the same
 *   as admitting the span. {@link DB_SOURCE_SIGNALS} maps a span's
 *   instrumentation source back to the flag that admits it, and
 *   {@link ServerAgentControl.admitSpan} applies it.
 * - `functions` is a **list of symbols the plan patched**, not a switch. A
 *   non-empty list enables the `function` kind here, and
 *   {@link ServerAgentControl.admitSpan} then requires the span's own identity
 *   to be one of those symbols — the `symbol` attribute the patch wrote where
 *   there is one, and the span's name only where there is not, so a span named
 *   after a planned symbol while declaring a different one is refused. A
 *   patched function from outside the active plan does exist in
 *   practice: an earlier session whose patch was left in a conflict state, a
 *   plan version that has since been narrowed, a second project sharing the
 *   process. Admitting it would put a symbol nobody asked about into the
 *   capture, which is the opposite of the targeted instrumentation the plan
 *   paid a file modification for.
 *
 * Both refinements are enforced at `onEnd`, never at sampling time: a
 * `NOT_RECORD` decision propagates to a span's children, so filtering by
 * identity in the sampler would silently cut the subtree underneath a function
 * nobody planned — including the queries that *were* planned.
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

/**
 * The signal that admits each database instrumentation's spans.
 *
 * The second gating axis, and the reason it is a table rather than an `if`:
 * `SIGNAL_KINDS` maps both flags onto `db.query`, so without this the ORM flag
 * would admit the driver's spans and the driver's flag the ORM's. Keyed by the
 * source `./convert.ts` derives from a span's instrumentation scope, so the
 * names on both sides of the mapping come from one declaration.
 */
export const DB_SOURCE_SIGNALS: Readonly<Record<DatabaseSpanSource, ServerAgentSignalName>> =
  Object.freeze({
    [DB_CLIENT_VALUES.orm]: 'prisma',
    [DB_CLIENT_VALUES.driver]: 'pg',
  });

/**
 * The kinds whose admission needs the span's own identity, not just its kind.
 *
 * `function` spans are named after the symbol the plan patched, and that name
 * is what {@link resolveFunctionAllowList} is checked against. Derived from
 * {@link SIGNAL_KINDS} so the kind is named once.
 */
export const FUNCTION_KINDS: readonly TelemetryKind[] = SIGNAL_KINDS.functions;

/**
 * The `function` span attribute carrying the patched symbol's name.
 *
 * `packages/instrumentation`'s wrapper template passes `meta.symbol` to
 * `globalThis.__DEBUGGEN__.span`, and `./span-helper.ts` copies it onto the
 * span, so it is the patch's own record of what it wrapped — independent of
 * the span's display name, which a caller may override and which
 * `./span-helper.ts` truncates. Typed as a member of the `function` kind's
 * declared vocabulary so it cannot drift out of `../schema/attributes.ts`
 * without a compile error, exactly as `./span-helper.ts` types its own keys.
 */
const FUNCTION_SYMBOL_ATTRIBUTE: (typeof FUNCTION_ATTRIBUTE_KEYS)[number] = 'symbol';

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
 * Resolve a signal set into the kinds the gate will admit.
 *
 * Computed once per config frame and held as a set, because `isKindEnabled` is
 * asked for every ended span and a set lookup is the cheapest honest answer.
 *
 * **The coarse axis only.** A kind in this set is *necessary* for a span to be
 * admitted and not sufficient: a `db.query` span must also come from the
 * instrumentation the capture asked for ({@link resolveEnabledDbSources}) and
 * a `function` span must name a symbol the plan patched
 * ({@link resolveFunctionAllowList}). `functions` therefore enables the kind on
 * presence here — there is no other kind for a patched function to arrive as —
 * while the list itself is enforced per span by
 * {@link ServerAgentControl.admitSpan}.
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

/**
 * Resolve a signal set into the database instrumentations whose spans the
 * capture wants.
 *
 * The second axis of the `db.query` kind. A plan that asked for ORM tracing
 * alone resolves to `{'prisma'}`, and the driver's query spans — which the
 * driver instrumentation may still be producing for another reason, or which a
 * shared process may be producing at all — are refused at `onEnd`.
 *
 * @param signals The capture's signal switches.
 * @returns The admitted sources; empty when neither database flag is on.
 */
export function resolveEnabledDbSources(
  signals: ServerAgentSignals,
): ReadonlySet<DatabaseSpanSource> {
  const sources = new Set<DatabaseSpanSource>();
  for (const [source, signal] of Object.entries(DB_SOURCE_SIGNALS) as [
    DatabaseSpanSource,
    ServerAgentSignalName,
  ][]) {
    if (signals[signal] === true) {
      sources.add(source);
    }
  }
  return sources;
}

/**
 * Resolve a plan's `functions` list into the identities a `function` span may
 * present.
 *
 * Every name is admitted in two forms, because the span may carry either:
 *
 * - **as planned** — the name the plan patched, which is what
 *   `packages/instrumentation` writes as the span's `symbol` attribute and, by
 *   default, as the span's name; and
 * - **as truncated** — `./span-helper.ts` bounds a span name at
 *   `MAX_PREVIEW_LENGTH`, while a plan's symbol may be longer (the plan schema
 *   allows 200 characters), so a long symbol arrives shortened with an
 *   ellipsis. Without its truncated form the one signal the developer paid a
 *   file modification for would be discarded for being too long. A shortened
 *   spelling is admitted only where it still names **one** planned symbol: two
 *   symbols that agree on their first `MAX_PREVIEW_LENGTH - 1` characters
 *   shorten to the same string, and admitting it would admit whichever of them
 *   arrived — so in that case only their full spellings are accepted.
 *
 * Names are trimmed and empties dropped: a blank entry can never match a span,
 * and leaving it in would make an all-blank list look like a plan that patched
 * something.
 *
 * @param signals The capture's signal switches.
 * @returns The accepted identities; empty when the plan patched nothing.
 */
export function resolveFunctionAllowList(signals: ServerAgentSignals): ReadonlySet<string> {
  const allowed = new Set<string>();
  const shortened = new Map<string, number>();

  for (const name of signals.functions) {
    if (typeof name !== 'string') {
      continue;
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      continue;
    }
    allowed.add(trimmed);
    const short = truncate(trimmed, MAX_PREVIEW_LENGTH);
    if (short !== trimmed) {
      shortened.set(short, (shortened.get(short) ?? 0) + 1);
    }
  }

  for (const [short, count] of shortened) {
    // Only where the shortened spelling still names one symbol. Two planned
    // symbols agreeing on their first `MAX_PREVIEW_LENGTH - 1` characters
    // shorten to the same string, and admitting that string would admit either
    // of them — including one this plan did not patch. Both are still accepted
    // in full, so the only span refused is one that arrived shortened and
    // genuinely cannot be told apart.
    if (count === 1 && !allowed.has(short)) {
      allowed.add(short);
    }
  }

  return allowed;
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

  /**
   * Whether the SDK considers this instrumentation enabled, as
   * `InstrumentationBase.isEnabled()` reports it.
   *
   * Read during teardown, and it is the only residual-state evidence the SDK
   * offers. It matters because `InstrumentationBase.enable()` and `disable()`
   * flip their internal flag **before** running the patch and unpatch
   * callbacks and return early when the flag already holds the target value
   * (verified in `@opentelemetry/instrumentation` 0.222.0). So a `disable()`
   * that threw part-way leaves the flag `false` with patches possibly still
   * applied, and a second `disable()` would return without unpatching
   * anything — a no-op this module must not mistake for verified cleanup.
   *
   * Optional, because a counting fake need not model the SDK; when it is
   * absent a non-throwing toggle is taken at face value.
   */
  isEnabled?(): boolean;

  /**
   * The instrumentation's package name, as `InstrumentationBase` exposes it.
   *
   * Read — never written — to tell the ORM's instrumentation from the driver's,
   * because `server-agent.config` switches them independently and a plan that
   * asked for one must leave the other unpatched. The real instances supply it
   * (`@prisma/instrumentation` and `@opentelemetry/instrumentation-pg` name
   * themselves after their packages), so nothing in `register.ts` has to label
   * them; optional so a counting fake stays a counting fake, and one without a
   * name is treated as {@link INSTRUMENTATION_ROLES.unknown}.
   */
  readonly instrumentationName?: string | undefined;
}

/**
 * Which signal an attached instrumentation serves.
 *
 * `unknown` is not a failure: it is an instrumentation this build cannot
 * identify, which is handled by keeping it enabled for every capture rather
 * than by guessing at the flag that governs it.
 */
export const INSTRUMENTATION_ROLES = Object.freeze({
  /** The ORM's instrumentation, governed by the `prisma` flag. */
  orm: 'prisma',
  /** The driver's instrumentation, governed by the `pg` flag. */
  driver: 'pg',
  /** An instrumentation this build does not recognise. */
  unknown: 'unknown',
} as const);

/** One member of {@link INSTRUMENTATION_ROLES}. */
export type InstrumentationRole =
  (typeof INSTRUMENTATION_ROLES)[keyof typeof INSTRUMENTATION_ROLES];

/**
 * Which signal an instrumentation serves, from the name it reports.
 *
 * Matched against the same scope names `./convert.ts` classifies *spans* by, so
 * the instrumentation that gets enabled and the spans that get admitted are
 * decided from one declaration: `@prisma/instrumentation` matches the ORM's
 * package prefix (and the bare tracer name it creates spans with), and
 * `@opentelemetry/instrumentation-pg` is the driver's package name.
 *
 * @param instrumentation The attached instrumentation.
 * @returns Its role; {@link INSTRUMENTATION_ROLES.unknown} when the name is
 * absent or unrecognised.
 */
export function classifyInstrumentation(
  instrumentation: ToggleableInstrumentation,
): InstrumentationRole {
  const name =
    typeof instrumentation.instrumentationName === 'string'
      ? instrumentation.instrumentationName.trim()
      : '';
  if (
    name === DB_INSTRUMENTATION_SCOPES.orm ||
    name.startsWith(DB_INSTRUMENTATION_SCOPES.ormScopePrefix)
  ) {
    return INSTRUMENTATION_ROLES.orm;
  }
  if (name === DB_INSTRUMENTATION_SCOPES.driver) {
    return INSTRUMENTATION_ROLES.driver;
  }
  return INSTRUMENTATION_ROLES.unknown;
}

/**
 * Whether a capture's signals want an instrumentation of this role patched in.
 *
 * The ORM and the driver follow their own flags, which is what makes a
 * prisma-only plan leave `pg.Client.prototype.query` unwrapped in the
 * developer's process. An unrecognised instrumentation is kept enabled for
 * every capture: it arrived from `register.ts` enabled, this build cannot say
 * which signal it serves, and disabling it on a guess would remove a signal a
 * plan may depend on.
 *
 * @param role The instrumentation's role.
 * @param signals The capture's signal switches.
 */
export function wantsInstrumentation(
  role: InstrumentationRole,
  signals: ServerAgentSignals,
): boolean {
  if (role === INSTRUMENTATION_ROLES.orm) {
    return signals.prisma;
  }
  if (role === INSTRUMENTATION_ROLES.driver) {
    return signals.pg;
  }
  return true;
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
 * teardown, and to hand on to the next provider.
 *
 * `DebuggenSpanProcessor` satisfies it. The instance is deliberately **not**
 * shut down by the disable path — it survives every enable/disable cycle so
 * that nothing buffered is lost and the next capture reuses its transport.
 */
export interface ControlFlushTarget {
  /** Post everything currently buffered; resolves when it has settled. */
  forceFlush(): Promise<void>;

  /**
   * Make the processor usable again after a provider shut it down.
   *
   * The disable path does not shut the processor down, but
   * `provider.shutdown()` — which it must call, so a cached tracer stops
   * processing — does: OpenTelemetry's SDK treats processors as owned by the
   * provider they were constructed with, while this product shares one across
   * every provider a session builds. So the replacement provider adopts a
   * processor that has been closed, and this is how it is opened again.
   * Without it the second capture of a session would create spans and export
   * none of them.
   *
   * Optional, so a flush-only fake remains a flush-only fake.
   */
  reopen?(): void;

  /**
   * Whether the processor is closed and dropping everything it is given.
   *
   * Read *after* {@link ControlFlushTarget.reopen} to confirm the reopening
   * took, because a processor that is still closed exports nothing: arming a
   * capture over one would produce spans that are counted as arriving after a
   * shutdown and never sent. Optional for the same reason as `reopen`.
   */
  readonly isShutDown?: boolean;

  /**
   * Whether the **ingest endpoint** refused this process's credential, which
   * stops server-side telemetry until the dev server is relaunched.
   *
   * `DebuggenSpanProcessor` latches this on a `401`/`403` answer to
   * `POST /telemetry/ingest` and never clears it — not on `reopen()`, so not on
   * a capture re-arm either — because the server-agent credential is minted per
   * dev-server launch and scoped to one project root (AAP §0.5.6). Read here so
   * the condition is *reportable*: it is republished as
   * {@link ServerAgentControlStats.ingestCredentialRejected}, which is how a
   * session can say "relaunch required" instead of showing a capture that is
   * armed, recording and delivering nothing.
   *
   * Optional for the same reason as `reopen` and `isShutDown`: a flush-only
   * fake stays a flush-only fake, and one that does not implement it is
   * reported as `false` — the honest reading for a target that has no ingest
   * transport of its own to have had refused.
   */
  readonly credentialRejected?: boolean;
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

/**
 * The resources the capture lifecycle installs and removes, named so a report
 * says *what* could not be done rather than only that something could not.
 *
 * One entry per thing that can fail independently, which is also the unit the
 * teardown retries: a failed provider shutdown and a failed `pg` unwrap are
 * different problems with different consequences for the developer, and a
 * report that collapsed them would leave the second invisible.
 */
export const CAPTURE_RESOURCES = Object.freeze({
  /** The tracer provider: built, registered globally, later shut down. */
  provider: 'tracer-provider',
  /** The global tracer registration, removed with `trace.disable()`. */
  globalTracer: 'global-tracer',
  /** The global propagator, removed with `propagation.disable()`. */
  globalPropagator: 'global-propagator',
  /** The ORM's instrumentation patches. */
  ormInstrumentation: 'prisma-instrumentation',
  /** The driver's instrumentation patches. */
  driverInstrumentation: 'pg-instrumentation',
  /** An instrumentation this build could not identify. */
  instrumentation: 'instrumentation',
  /** The pre-teardown flush of evidence already captured. */
  flush: 'telemetry-flush',
  /**
   * The shared span processor, which a provider shutdown closes and a
   * replacement provider has to reopen.
   */
  processor: 'span-processor',
} as const);

/** One member of {@link CAPTURE_RESOURCES}. */
export type CaptureResource = (typeof CAPTURE_RESOURCES)[keyof typeof CAPTURE_RESOURCES];

/**
 * Reported when a capture is requested after {@link ServerAgentControl.dispose}.
 *
 * Not a failure of anything: the process is on its way out, and the honest
 * answer to "arm a capture" is that this preload will not be arming any more.
 */
const DISPOSED_FAILURE: CaptureResourceFailure = Object.freeze({
  resource: CAPTURE_RESOURCES.provider,
  signals: Object.freeze<ServerAgentSignalName[]>([]),
  reason: 'the preload has been disposed and will not arm another capture',
  hint: 'Restart the dev server to capture again.',
});

/**
 * Reported when a queued state change failed in a way its own guards did not
 * catch.
 *
 * {@link ServerAgentControl.#serialize} answers with a fallback rather than
 * rejecting, and for an enable the only safe fallback is "not armed": a caller
 * told otherwise would wait for telemetry from a gate that may never have
 * opened.
 */
const INTERNAL_FAILURE: CaptureResourceFailure = Object.freeze({
  resource: CAPTURE_RESOURCES.provider,
  signals: Object.freeze<ServerAgentSignalName[]>([]),
  reason: 'the capture state change failed unexpectedly',
  hint: 'Retry the capture; the dev-server log records the failure.',
});

/**
 * The cleanup report used when a queued teardown failed unexpectedly.
 *
 * `partial` rather than `clean`, for the same reason: a teardown whose outcome
 * is unknown must never be reported as having left nothing running.
 */
const INTERNAL_CLEANUP_REPORT: CleanupReport = Object.freeze({
  status: 'partial',
  changed: false,
  pending: Object.freeze<CaptureResource[]>([]),
  failures: Object.freeze<CaptureResourceFailure[]>([INTERNAL_FAILURE]),
});

/**
 * One resource that could not be installed or removed, and what it costs.
 *
 * The shape follows AAP §0.5.5's contract for an unavailable signal — *"Could
 * not enable ‹signal›: ‹reason›. Continuing with: ‹enabled list›"* — so the
 * service can render it without translating: `signals` names what the developer
 * loses, `reason` is the description, `hint` is the action.
 *
 * `reason` is always scrubbed of the credential before it is stored here.
 */
export interface CaptureResourceFailure {
  /** Which resource. */
  readonly resource: CaptureResource;
  /** The signals this failure costs the capture; empty when it costs none. */
  readonly signals: readonly ServerAgentSignalName[];
  /** What went wrong, in one line, with no credential in it. */
  readonly reason: string;
  /** What would fix it, where there is an action to name. */
  readonly hint?: string;
}

/** The resource name a failure report uses for each instrumentation role. */
const INSTRUMENTATION_RESOURCES: Readonly<Record<InstrumentationRole, CaptureResource>> =
  Object.freeze({
    [INSTRUMENTATION_ROLES.orm]: CAPTURE_RESOURCES.ormInstrumentation,
    [INSTRUMENTATION_ROLES.driver]: CAPTURE_RESOURCES.driverInstrumentation,
    [INSTRUMENTATION_ROLES.unknown]: CAPTURE_RESOURCES.instrumentation,
  });

/** The signals an instrumentation of each role supplies, for a failure report. */
const INSTRUMENTATION_SIGNALS: Readonly<
  Record<InstrumentationRole, readonly ServerAgentSignalName[]>
> = Object.freeze({
  [INSTRUMENTATION_ROLES.orm]: Object.freeze<ServerAgentSignalName[]>(['prisma']),
  [INSTRUMENTATION_ROLES.driver]: Object.freeze<ServerAgentSignalName[]>(['pg']),
  [INSTRUMENTATION_ROLES.unknown]: Object.freeze<ServerAgentSignalName[]>([]),
});

/**
 * What this module knows about one instrumentation's patches.
 *
 * Three states rather than a boolean, because a toggle that throws leaves the
 * truth *unknown* and a boolean would have to guess. `InstrumentationBase`
 * flips its internal flag before it runs the patch callbacks and returns early
 * when the flag already holds the target value, so a `disable()` that threw
 * part-way through unpatching leaves the SDK claiming "disabled" while a
 * module may still be wrapped — and the next `disable()` does nothing at all.
 * Recording that as `disabled` is precisely the false cleanup report AAP §0.5.1
 * forbids.
 */
export const INSTRUMENTATION_STATES = Object.freeze({
  /** Patches applied, as far as this module can tell. */
  enabled: 'enabled',
  /** Patches removed, verified by a toggle that did real work and returned. */
  disabled: 'disabled',
  /** A toggle threw: the patches may or may not be applied. */
  unknown: 'unknown',
} as const);

/** One member of {@link INSTRUMENTATION_STATES}. */
export type InstrumentationState =
  (typeof INSTRUMENTATION_STATES)[keyof typeof INSTRUMENTATION_STATES];

/**
 * One attached instrumentation, with the two things the lifecycle needs to know
 * about it beyond how to toggle it.
 *
 * `state` is this module's own record. It cannot be delegated to the SDK: the
 * SDK's flag describes its *intent* (it is set before the patching runs), not
 * whether the patching finished, and the difference is the whole of
 * {@link INSTRUMENTATION_STATES.unknown}.
 */
interface InstrumentationEntry {
  /** The instrumentation itself. */
  readonly instrumentation: ToggleableInstrumentation;
  /** Which signal it serves. */
  readonly role: InstrumentationRole;
  /** What this module knows about its patches. */
  state: InstrumentationState;
}

/**
 * The outcome of arming a capture.
 *
 * Structured rather than a boolean because "did anything change" and "is this
 * process recording" are different questions, and the second is the one that
 * must never be answered optimistically: a capture whose tracer provider could
 * not be installed is reported `armed: false` and the gate stays shut, so the
 * service sees a failure instead of a session that silently produces no server
 * telemetry (AAP §0.5.5).
 */
export interface EnableReport {
  /**
   * Whether the gate is now open for this capture.
   *
   * `false` means a mandatory resource could not be installed. The state is
   * unchanged-or-closed, nothing is recording, and the identical frame may be
   * applied again to retry.
   */
  readonly armed: boolean;

  /** Whether this call changed the state; `false` for a restatement. */
  readonly changed: boolean;

  /**
   * Resources that could not be installed.
   *
   * Non-empty with `armed: true` is the degraded case: the capture is
   * recording what it can, and the entries name the signals it cannot supply.
   */
  readonly unavailable: readonly CaptureResourceFailure[];
}

/**
 * The outcome of a teardown: how inert the preload actually is.
 *
 * AAP §0.5.1's guarantee is that a session leaves "no active patches, no
 * provider and no file changes", and the honest report of a teardown that
 * could not finish is `partial` with the resources still held — never silence.
 * `packages/instrumentation`'s cleanup status uses the same vocabulary for file
 * modifications.
 */
export interface CleanupReport {
  /** `clean` when nothing is left running; `partial` when something is. */
  readonly status: 'clean' | 'partial';
  /** Whether this call did any teardown work; `false` when already inert. */
  readonly changed: boolean;
  /** Resources still installed, and therefore still to be retried. */
  readonly pending: readonly CaptureResource[];
  /** Every step that failed, in the order it was attempted. */
  readonly failures: readonly CaptureResourceFailure[];
}

/** How {@link ServerAgentControl.applyConfig} resolved a frame. */
export type ApplyConfigOutcome =
  /** A capture was armed, or re-armed with a different id or signal set. */
  | 'enabled'
  /** The capture was torn down and the preload is inert. */
  | 'disabled'
  /**
   * The capture was torn down but something could not be removed: the gate is
   * shut and nothing is recording, and the preload is **not** inert.
   *
   * Distinct from `disabled` because `disabled` is a claim about the process —
   * no patches, no provider — that a partial teardown has not earned.
   * {@link ServerAgentControlStats.pendingCleanup} names what is left.
   */
  | 'partial'
  /** The frame restated the state the gate was already in. */
  | 'unchanged'
  /** The payload did not validate; the previous state was kept. */
  | 'invalid'
  /**
   * A mandatory resource could not be installed, so the capture was **not**
   * armed: the gate is shut, nothing is recording, and re-sending the frame
   * retries.
   */
  | 'failed'
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
  /**
   * How many captures this object has armed.
   *
   * The generation `./exporter.ts` stamps on a starting span and compares at
   * `onEnd`, so a span from a replaced capture is rejected instead of being
   * filed under its successor. Monotonic and never reset.
   */
  readonly captureGeneration: number;
  /** The kinds the gate currently admits, in declaration order. */
  readonly enabledKinds: readonly TelemetryKind[];
  /**
   * The database instrumentations whose spans the active capture admits.
   *
   * Independent of {@link enabledKinds}: both sources share the `db.query`
   * kind, and this is what separates them.
   */
  readonly enabledDbSources: readonly DatabaseSpanSource[];
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
  /**
   * Whether any attached instrumentation may still be patched in.
   *
   * `true` includes an instrumentation whose toggle threw and whose patches
   * therefore cannot be shown to be gone — the conservative reading, because
   * the alternative is reporting a developer's `pg` as unwrapped when it may
   * not be.
   */
  readonly instrumentationsEnabled: boolean;
  /** Whether a provider is registered globally and usable for a capture. */
  readonly providerRegistered: boolean;
  /**
   * How inert the preload is, as the last teardown left it.
   *
   * `active` before any teardown, or after a capture re-installed what a
   * teardown removed; `clean` when a teardown left nothing running; `partial`
   * when something is still installed — see {@link pendingCleanup}, which
   * names it. `partial` is the state AAP §0.5.1 requires be reported rather
   * than glossed over: pg may still be wrapped, or a provider may still be
   * registered.
   */
  readonly cleanupStatus: 'active' | 'clean' | 'partial';
  /**
   * The resources still installed, in teardown order.
   *
   * Read against {@link cleanupStatus}: while the status is `active` this is
   * what the preload currently holds — the provider, the globals and the
   * patched instrumentations a capture needs — and after a teardown it is what
   * that teardown could not remove. Empty whenever the status is `clean`.
   * Non-empty with `partial` means the handles are retained: the next
   * `disable()`, and the next capture's installation, both finish the work
   * rather than losing it.
   */
  readonly pendingCleanup: readonly CaptureResource[];
  /**
   * Whether the service refused the credential on the **control socket**, with
   * close code 4401.
   *
   * The socket half of a pair, and the two are independent readings of one
   * credential. This one means no capture instruction will ever arrive, because
   * the WebSocket handshake was refused; {@link ingestCredentialRejected} means
   * no telemetry will ever be accepted, because the HTTP ingest endpoint
   * refused a batch. Either can be `true` without the other — the socket is
   * authenticated once at `client.hello` while ingest is authenticated per
   * request — and both are terminal for the process (AAP §0.5.6: a rotated or
   * revoked credential requires the dev server to be relaunched).
   */
  readonly credentialRejected: boolean;
  /**
   * Whether the **ingest endpoint** refused the credential, as the attached
   * span processor reports it.
   *
   * `true` means the preload has stopped converting, buffering and posting
   * server-side telemetry for the life of this process: see
   * {@link ControlFlushTarget.credentialRejected}, which this member
   * republishes. `false` while nothing is attached, or while the attached
   * target does not implement the member — the flush-only fakes of
   * `./control.test.ts` among them.
   *
   * Reported separately from {@link credentialRejected} rather than folded into
   * it, because they answer different questions about a degraded session and
   * the remedy is only the same by coincidence: this one is why a capture that
   * looks armed yields no server evidence.
   */
  readonly ingestCredentialRejected: boolean;
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
 * capture is a transition, not a second tenant — and the transition is
 * *bookkept*, in two steps that exist because an ingest event carries no
 * capture id of its own (the service assigns `sessionId`, `captureId` and
 * `ingestSeq` on arrival, AAP §0.2.3):
 *
 * 1. the span processor is **flushed** before the new capture is armed, so
 *    everything already finished reaches the service while the capture it
 *    belongs to is still the open one; and
 * 2. {@link ServerAgentControl.captureGeneration} **advances**, so a span that
 *    started under the outgoing capture and ends under the incoming one is
 *    refused by `./exporter.ts` rather than filed under a capture it never ran
 *    in.
 *
 * `./convert.ts`'s `seq` allocator, keyed on `(producerId, captureId)`,
 * restarts itself when the id changes, which numbers the new capture's events
 * from zero but says nothing about which capture a span belonged to.
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

  /**
   * The attached instrumentations, each with its role and its own enabled
   * state.
   *
   * Per-entry rather than one list and one flag, for two reasons the findings
   * behind this design name directly: the ORM and the driver are switched
   * independently by a capture's signals, and a toggle that throws must leave
   * *that* entry's state unknown — so the teardown knows its patches may still
   * be applied and keeps saying so — without implying anything about the
   * others. Three states rather than two, because "the removal failed" is
   * neither "patched" nor "clean".
   */
  #instrumentations: InstrumentationEntry[] = [];

  /** Builds a fresh provider when a capture follows a disable. */
  #createProvider: TracerProviderFactory | undefined;

  /**
   * The provider this object owns, or `null` when it holds none.
   *
   * Retained after a failed `shutdown()` — see
   * {@link ServerAgentControl.#providerShutdownPending} — because dropping the
   * reference would make the retry impossible and leave a provider processing
   * spans with nothing able to stop it.
   */
  #provider: ControlTracerProvider | null = null;

  /**
   * Whether {@link ServerAgentControl.#provider} is installed globally *and*
   * usable for a capture.
   *
   * Set only by a successful registration, cleared by a successful
   * `trace.disable()` or by the start of a shutdown. It is deliberately not
   * the same fact as "a global tracer is installed", which
   * {@link ServerAgentControl.#globalTracerInstalled} tracks: a provider that
   * has been shut down but whose global registration could not be removed is
   * unusable *and* still installed, and both halves matter.
   */
  #providerRegistered = false;

  /** Whether a global tracer provider installed by this object is still there. */
  #globalTracerInstalled = false;

  /** Whether the global propagator installed with it is still there. */
  #globalPropagatorInstalled = false;

  /**
   * Whether a provider shutdown failed and must be retried.
   *
   * While this is set the provider handle is kept and no capture may use it;
   * the next teardown, and the next capture's installation, both retry it
   * first.
   */
  #providerShutdownPending = false;

  /** The session that owns the active capture. */
  #sessionId: string | null = null;

  /** The active capture, or `null`: the gate's whole answer. */
  #captureId: string | null = null;

  /**
   * How many captures this object has armed.
   *
   * Advanced when — and only when — the gate opens, so a span stamped with an
   * earlier value is a span from a capture that has since been replaced.
   * `./exporter.ts` reads it on every started and every ended span, which is
   * what keeps one capture's work out of another's evidence in a store that
   * attributes events by arrival.
   */
  #captureGeneration = 0;

  /** The active capture's signals. */
  #signals: ServerAgentSignals = NO_SIGNALS;

  /** The kinds those signals admit, resolved once per config frame. */
  #enabledKinds: ReadonlySet<TelemetryKind> = new Set<TelemetryKind>();

  /** The database instrumentations those signals admit spans from. */
  #enabledDbSources: ReadonlySet<DatabaseSpanSource> = new Set<DatabaseSpanSource>();

  /** The identities a `function` span may present, planned and truncated. */
  #functionAllowList: ReadonlySet<string> = new Set<string>();

  /** Whether the last teardown left something installed. */
  #cleanupStatus: 'active' | 'clean' | 'partial' = 'active';

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
   * How many captures this object has armed — the generation `./exporter.ts`
   * stamps spans with.
   *
   * Advanced only when the gate opens, so two spans carrying the same value
   * ran in the same capture window and a span carrying an older one did not.
   * Read on every started and every ended span, so it is a field read.
   */
  get captureGeneration(): number {
    return this.#captureGeneration;
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

  /**
   * Whether the active capture wants *this span*, and which rule refused it if
   * not.
   *
   * Three questions, in increasing specificity, because one kind is not one
   * signal (see {@link SIGNAL_KINDS}):
   *
   * 1. is a capture armed, and did its plan ask for this kind;
   * 2. for a `db.query` span, did it ask for *this* library — `prisma` and `pg`
   *    are independent switches over the one database kind, so a plan that
   *    asked for ORM tracing collects no driver spans;
   * 3. for a `function` span, is the symbol one this plan patched — `functions`
   *    is a list of names, and a patched function from an earlier plan version
   *    or an unreverted session is not this capture's evidence.
   *
   * A database span whose producing library cannot be told is **admitted**
   * rather than discarded: the kind was enabled by at least one database
   * signal, and dropping an unattributable query would lose the very evidence
   * the plan asked for. A `function` span, by contrast, always carries its own
   * identity — its name, or the `symbol` the patch wrote — so an unmatched one
   * is a span from outside the plan.
   *
   * Never throws; `./exporter.ts` calls it inside its own guard and counts the
   * verdict.
   *
   * @param candidate The classified kind and the span facts the finer rules
   * need.
   */
  admitSpan(candidate: SpanAdmissionCandidate): SpanAdmission {
    if (this.#captureId === null) {
      return 'no-capture';
    }
    if (!this.#enabledKinds.has(candidate.kind)) {
      return 'kind-disabled';
    }
    if (QUERY_KINDS.includes(candidate.kind)) {
      const source = candidate.source;
      if (source !== null && !this.#enabledDbSources.has(source)) {
        return 'source-disabled';
      }
      return 'admitted';
    }
    if (FUNCTION_KINDS.includes(candidate.kind) && !this.#isPlannedFunction(candidate)) {
      return 'unplanned-function';
    }
    return 'admitted';
  }

  /** A snapshot of everything this object tracks. */
  stats(): ServerAgentControlStats {
    return {
      sessionId: this.#sessionId,
      captureId: this.#captureId,
      captureGeneration: this.#captureGeneration,
      enabledKinds: [...this.#enabledKinds],
      enabledDbSources: [...this.#enabledDbSources],
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
      instrumentationsEnabled: this.#instrumentations.some(
        (entry) => entry.state !== INSTRUMENTATION_STATES.disabled,
      ),
      providerRegistered: this.#providerRegistered,
      cleanupStatus: this.#cleanupStatus,
      pendingCleanup: this.#pendingCleanup(),
      credentialRejected: this.#credentialRejected,
      // The processor's own latch, not this object's: `register.ts` attaches the
      // real `DebuggenSpanProcessor`, so the ingest endpoint's answer is
      // readable here. A target that does not implement the member — every
      // flush-only fake — reads `false`.
      ingestCredentialRejected: this.#processor?.credentialRejected === true,
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
   * a provider passed here is one the caller has **attempted** to register
   * globally: whether it became the global is checked here against the API's
   * registry, not taken from the attachment, because `register()` returns
   * `void` and the API answers a refusal with `false`. One that did not become
   * the global is held for the shutdown it is owed and is not treated as
   * installed. Passing a factory alone means nothing is installed yet and the
   * first capture must build one.
   *
   * @param attachment The collaborators to adopt.
   */
  attach(attachment: ControlAttachment): void {
    if (attachment.processor !== undefined) {
      this.#processor = attachment.processor;
    }
    if (attachment.instrumentations !== undefined) {
      // Each arrives enabled and is classified once, so a capture's signals can
      // toggle the ORM's and the driver's patches independently and a teardown
      // can report which of them is still applied.
      this.#instrumentations = attachment.instrumentations.map((instrumentation) => ({
        instrumentation,
        role: classifyInstrumentation(instrumentation),
        state: INSTRUMENTATION_STATES.enabled,
      }));
    }
    if (attachment.createProvider !== undefined) {
      this.#createProvider = attachment.createProvider;
    }
    if (attachment.provider !== undefined) {
      // A provider passed here is one `register.ts` has already *attempted* to
      // register globally, with the W3C propagator. Attempted, not necessarily
      // installed: `trace.setGlobalTracerProvider` answers `false` and keeps
      // the incumbent when another provider is already registered, and
      // `NodeTracerProvider.register()` returns `void`, so the caller cannot
      // pass on an outcome it never saw. The global is therefore *checked*
      // here rather than assumed, and a provider that did not become the
      // global is held only so the teardown can shut it down — the first
      // capture will build and register its own.
      this.#provider = attachment.provider;
      this.#globalPropagatorInstalled = true;
      if (this.#isProviderGlobal(attachment.provider)) {
        this.#providerRegistered = true;
        this.#providerShutdownPending = false;
        this.#globalTracerInstalled = true;
      } else {
        this.#providerRegistered = false;
        this.#providerShutdownPending = true;
        this.#log(
          'warn',
          'the tracer provider handed to this preload is not the global one; another provider is registered',
        );
      }
    }
    if (this.#instrumentations.length > 0 || this.#providerRegistered) {
      this.#cleanupStatus = 'active';
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
        const report = await this.#runDisable();
        if (report.changed) {
          this.#configsApplied += 1;
        }
        if (report.status === 'partial') {
          // Carried out to the caller rather than folded into `disabled`: the
          // capture is off either way, but "the preload is inert" is a
          // different statement and only one of them is true here.
          return 'partial';
        }
        return report.changed ? 'disabled' : 'unchanged';
      }, 'unchanged');
    }

    const request: CaptureRequest = {
      captureId: parsed.captureId,
      sessionId: parsed.sessionId,
      signals: parsed.signals,
    };
    return this.#serialize(async (): Promise<ApplyConfigOutcome> => {
      const report = await this.#runEnable(request);
      if (!report.armed) {
        // Nothing was applied: the gate is shut and the same frame may be
        // re-sent to retry. Reported as its own outcome rather than as
        // `enabled`, because a service told `enabled` would wait for telemetry
        // that is never coming (AAP §0.5.5).
        return 'failed';
      }
      if (report.changed) {
        this.#configsApplied += 1;
      }
      return report.changed ? 'enabled' : 'unchanged';
    }, 'unchanged');
  }

  /**
   * Arm a capture directly, bypassing the frame parsing.
   *
   * The same code path {@link applyConfig} takes for a payload that carries a
   * `captureId`, exposed so a test — and `register.ts`, if it ever needs to —
   * can arm a capture without constructing a frame.
   *
   * Idempotent: re-arming the same capture with the same signals, with every
   * resource it needs already installed, does nothing and reports
   * `changed: false`. A capture whose installation *failed* is not in that
   * state, so the identical request retries rather than being swallowed.
   *
   * @param request The capture and the signals to admit.
   * @returns What was armed and what could not be; never rejects.
   */
  enableCapture(request: CaptureRequest): Promise<EnableReport> {
    if (this.#disposed) {
      return Promise.resolve<EnableReport>({
        armed: false,
        changed: false,
        unavailable: [DISPOSED_FAILURE],
      });
    }
    return this.#serialize((): Promise<EnableReport> => this.#runEnable(request), {
      armed: false,
      changed: false,
      unavailable: [INTERNAL_FAILURE],
    });
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
   * doing anything a second time — but a teardown that could not finish is
   * *not* in that state: it reports `partial`, keeps the handles it could not
   * release, and the next call retries exactly those.
   *
   * @returns How inert the preload actually is; never rejects.
   */
  disable(): Promise<CleanupReport> {
    this.#clearGate();
    return this.#serialize(
      (): Promise<CleanupReport> => this.#runDisable(),
      INTERNAL_CLEANUP_REPORT,
    );
  }

  /**
   * Close the control channel and run the disable path.
   *
   * `register.ts` calls this from its `SIGINT`, `SIGTERM` and `beforeExit`
   * handlers. After it, this object applies no further frames and schedules no
   * further reconnects, which is what lets a dev server exit promptly instead of
   * waiting out a backoff.
   *
   * @returns How inert the preload actually is; never rejects.
   */
  async dispose(): Promise<CleanupReport> {
    this.#clearGate();
    this.#disposed = true;
    this.#clearTimers();
    this.#closeSocket(SOCKET_CLOSE_NORMAL, 'preload shutting down');
    return await this.#serialize(
      (): Promise<CleanupReport> => this.#runDisable(),
      INTERNAL_CLEANUP_REPORT,
    );
  }

  /**
   * Alias of {@link dispose}, for a caller that thinks of this object as a
   * connection.
   *
   * @returns How inert the preload actually is.
   */
  close(): Promise<CleanupReport> {
    return this.dispose();
  }

  /*
   * -------------------------------------------------------------------------
   * Enable and disable, without the queueing
   * -------------------------------------------------------------------------
   */

  /**
   * Arm the gate, and make sure the machinery behind it is installed **first**.
   *
   * The order is the whole point of this method. Installation happens with the
   * gate shut, and the gate opens only once the one mandatory resource — a
   * registered tracer provider — is in place, because a capture armed without
   * a provider records nothing at all while every UI in the product shows it as
   * capturing (AAP §0.5.5: a failure is never presented as a success).
   *
   * The sequence:
   *
   * 1. **Nothing to do?** A restatement of the capture already armed, with
   *    every resource it needs installed, changes nothing. A capture whose
   *    installation failed is deliberately *not* in that state, so re-sending
   *    the same frame retries instead of being swallowed.
   * 2. **A different capture?** Flush first, while the outgoing capture is
   *    still the one the service has open. An ingest event carries no capture
   *    id — the service assigns it on arrival — so evidence that leaves after
   *    the switch is filed under the new capture. Flushing here is what gets
   *    the finished spans out in time; the generation bump in step 5 is what
   *    rejects the ones that were still running.
   * 3. **Install the provider.** The first capture of a process finds one
   *    already registered by `register.ts`; a capture that follows a teardown
   *    finds none and builds one, and a capture that follows a teardown which
   *    *failed* finishes that teardown first. Mandatory: on failure the gate
   *    stays shut and the report says so.
   * 4. **Install the instrumentations this capture's signals ask for**, and
   *    remove the ones they do not. Optional: a database library whose
   *    instrumentation refuses to patch costs that signal and no more, which
   *    the report names so the service can say "continuing with …".
   * 5. **Open the gate**, advancing the capture generation as it opens.
   *
   * @param request The capture and the signals to admit.
   * @returns What was armed, and every resource that could not be installed.
   */
  async #runEnable(request: CaptureRequest): Promise<EnableReport> {
    if (this.#disposed) {
      return { armed: false, changed: false, unavailable: [DISPOSED_FAILURE] };
    }

    const kinds = resolveEnabledKinds(request.signals);
    const sources = resolveEnabledDbSources(request.signals);
    const functions = resolveFunctionAllowList(request.signals);
    const sessionId = request.sessionId ?? null;

    if (this.#isArmedFor(request, sessionId, kinds, sources, functions)) {
      return { armed: true, changed: false, unavailable: [] };
    }

    const unavailable: CaptureResourceFailure[] = [];

    if (this.#captureId !== null && this.#captureId !== request.captureId) {
      const flushFailure = await this.#flushCaptured('the outgoing capture');
      if (flushFailure !== null) {
        unavailable.push(flushFailure);
      }
    }

    // Shut while installing: a half-applied signal set must never be able to
    // admit a span, and the spans of the capture being replaced must stop
    // being admitted the moment its flush has been attempted.
    this.#clearGate();

    const providerFailure = await this.#ensureProvider();
    if (providerFailure !== null) {
      unavailable.push(providerFailure);
      this.#log('warn', 'the capture was not armed: this process can create no spans', {
        captureId: request.captureId,
        resource: providerFailure.resource,
      });
      return { armed: false, changed: false, unavailable };
    }

    unavailable.push(...this.#applyInstrumentationSignals(request.signals));

    this.#captureGeneration += 1;
    this.#sessionId = sessionId;
    this.#captureId = request.captureId;
    this.#signals = request.signals;
    this.#enabledKinds = kinds;
    this.#enabledDbSources = sources;
    this.#functionAllowList = functions;
    this.#cleanupStatus = 'active';
    this.#enableCount += 1;

    this.#log('debug', 'capture armed', {
      captureId: request.captureId,
      generation: this.#captureGeneration,
      kinds: [...kinds].join(','),
      sources: [...sources].join(','),
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

    for (const failure of unavailable) {
      if (failure.signals.length === 0) {
        // Already logged where it happened, and it costs the capture no signal
        // — a flush that failed loses evidence already recorded, which is a
        // different sentence from "this signal is unavailable".
        continue;
      }
      // AAP §0.5.5's wording, from this end of it: what could not be enabled,
      // why, and what is still being collected.
      this.#log('warn', `could not enable ${failure.signals.join(', ')}`, {
        reason: failure.reason,
        continuingWith: [...kinds].join(','),
      });
    }

    return { armed: true, changed: true, unavailable };
  }

  /**
   * Whether this exact capture is already armed with everything it needs.
   *
   * Every clause is load-bearing. The first five are the capture's identity and
   * its admission policy — all three axes of it, so a frame that narrows only
   * the patched-symbol list is still applied; the last three are the machinery,
   * and they are what makes a retry possible: after a failed installation the
   * state does not describe a working capture, so the identical request is not
   * a restatement of it.
   *
   * @param request The requested capture.
   * @param sessionId Its session, already normalised to `null` when absent.
   * @param kinds The kinds its signals resolve to.
   * @param sources The database sources its signals resolve to.
   * @param functions The function identities its signals resolve to.
   */
  #isArmedFor(
    request: CaptureRequest,
    sessionId: string | null,
    kinds: ReadonlySet<TelemetryKind>,
    sources: ReadonlySet<DatabaseSpanSource>,
    functions: ReadonlySet<string>,
  ): boolean {
    return (
      this.#captureId === request.captureId &&
      this.#sessionId === sessionId &&
      sameSet(this.#enabledKinds, kinds) &&
      sameSet(this.#enabledDbSources, sources) &&
      sameSet(this.#functionAllowList, functions) &&
      this.#providerRegistered &&
      !this.#providerShutdownPending &&
      this.#instrumentations.every(
        (entry) =>
          entry.state ===
          (wantsInstrumentation(entry.role, request.signals)
            ? INSTRUMENTATION_STATES.enabled
            : INSTRUMENTATION_STATES.disabled),
      )
    );
  }

  /**
   * Flush the span processor, so evidence already captured reaches the service
   * while the capture it belongs to is still the open one.
   *
   * The processor is never shut down here: it outlives every cycle and the next
   * capture reuses its buffer and its transport.
   *
   * @param subject What is being flushed, for the diagnostic.
   * @returns The failure, or `null` when there was nothing to flush or it
   * worked.
   */
  async #flushCaptured(subject: string): Promise<CaptureResourceFailure | null> {
    const processor = this.#processor;
    if (processor === undefined) {
      return null;
    }
    try {
      await processor.forceFlush();
      return null;
    } catch (error) {
      return this.#resourceFailure(
        CAPTURE_RESOURCES.flush,
        [],
        `could not flush captured telemetry for ${subject}`,
        error,
        'Some telemetry from this capture may not have reached the service.',
      );
    }
  }

  /**
   * Install a provider if this object does not hold a usable one, finishing an
   * unfinished teardown first.
   *
   * Finishing the teardown is not tidiness. `trace.setGlobalTracerProvider`
   * **refuses to replace** an already-installed global, so registering a new
   * provider while a previous registration is still in place silently does
   * nothing and the capture would run against a provider that has been shut
   * down — spans created, none processed. A teardown whose `trace.disable()` or
   * `provider.shutdown()` failed is therefore retried here, and a retry that
   * fails again refuses the capture rather than arming a broken one.
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
   *
   * Every path through this method ends in the same question, asked of the
   * global registry rather than of this object's own flags: is the provider
   * held here the one the host's tracers resolve through? A provider that was
   * installed and has since been displaced is as silent as one that was
   * refused, so the capture is refused in both cases.
   *
   * @returns The failure that leaves this process unable to record, or `null`.
   */
  async #ensureProvider(): Promise<CaptureResourceFailure | null> {
    if (this.#providerRegistered && !this.#providerShutdownPending) {
      const installed = this.#provider;
      if (installed !== null && this.#isProviderGlobal(installed)) {
        return null;
      }

      // The registration this object made is gone: something else removed it
      // and installed a provider of its own, so the provider held here
      // processes nothing the host creates. Recorded as lost rather than
      // retried — the global now belongs to that other actor and removing it
      // is not this object's to do — while the handle is kept for the shutdown
      // the teardown still owes it.
      this.#providerRegistered = false;
      this.#globalTracerInstalled = false;
      if (installed !== null) {
        this.#providerShutdownPending = true;
        return this.#resourceFailure(
          CAPTURE_RESOURCES.provider,
          [],
          'the tracer provider this process installed is no longer the global one, so no span would be recorded',
          undefined,
          'Restart the dev server; another OpenTelemetry setup replaced this process\u2019s tracer provider.',
        );
      }
    }

    const pending = await this.#finishTeardown();
    const blocking = pending[0];
    if (blocking !== undefined) {
      return {
        ...blocking,
        hint:
          blocking.hint ??
          'Restart the dev server to install a tracer provider; the previous one could not be released.',
      };
    }

    const factory = this.#createProvider;
    if (factory === undefined) {
      return this.#resourceFailure(
        CAPTURE_RESOURCES.provider,
        [],
        'no tracer provider factory is attached; server spans cannot be enabled for this capture',
        undefined,
        'Relaunch the dev server through Debug Generator so the preload can install a tracer provider.',
      );
    }

    let provider: ControlTracerProvider;
    try {
      provider = factory();
      provider.register({ propagator: new W3CTraceContextPropagator() });
    } catch (error) {
      return this.#resourceFailure(
        CAPTURE_RESOURCES.provider,
        [],
        'could not register a tracer provider for this capture',
        error,
        'Restart the dev server; the OpenTelemetry provider refused to install.',
      );
    }

    // The propagator was installed alongside the provider, whether or not the
    // provider itself took, so its removal is this object's to perform.
    this.#globalPropagatorInstalled = true;

    // `register()` returns `void` and swallows a refusal:
    // `trace.setGlobalTracerProvider` answers `false` — and leaves the
    // incumbent in place — when a global provider is already registered
    // (`@opentelemetry/api` 1.9.1). Nothing throws, so the only way to know
    // whether this provider is the one the host's tracers now resolve through
    // is to ask the global.
    if (!this.#isProviderGlobal(provider)) {
      // Held, not dropped: it is this object's provider and the teardown owes
      // it a shutdown, and the next attempt must retry that before building
      // another.
      this.#provider = provider;
      this.#providerRegistered = false;
      this.#providerShutdownPending = true;
      return this.#resourceFailure(
        CAPTURE_RESOURCES.provider,
        [],
        'another global tracer provider is already registered, so this one was refused and no span would be recorded',
        undefined,
        'Restart the dev server without the other OpenTelemetry setup (an instrumentation.ts register(), @vercel/otel or a second preload), then capture again.',
      );
    }

    this.#provider = provider;
    this.#providerRegistered = true;
    this.#providerShutdownPending = false;
    this.#globalTracerInstalled = true;

    // The replacement provider has adopted the shared span processor, which the
    // *previous* provider's shutdown closed — the SDK shuts its processors down
    // with it. Reopening is what makes this capture's spans exportable rather
    // than counted as arriving after a shutdown, so a reopening that did not
    // take refuses the capture instead of arming a silent one.
    const processorFailure = this.#reopenProcessor();
    if (processorFailure !== null) {
      return processorFailure;
    }

    this.#log('debug', 'tracer provider and W3C propagator registered');

    if (!propagation.fields().includes(TRACEPARENT_FIELD)) {
      // Not fatal — the tier still records — but the browser↔server seam
      // silently stops joining, which is the one regression AAP §0.4.2 calls
      // out by name, so it is reported rather than left to be noticed in a
      // panel with two unrelated traces.
      return this.#resourceFailure(
        CAPTURE_RESOURCES.globalPropagator,
        [],
        'the global propagator does not carry traceparent, so browser and server spans will not share a trace',
        undefined,
        'Another OpenTelemetry propagator is registered; restart the dev server without it.',
      );
    }

    return null;
  }

  /**
   * Whether a provider is the one the host's tracers resolve through.
   *
   * The API installs a `ProxyTracerProvider` as the global and points it at the
   * registered provider, so the question is whether that proxy's delegate is
   * this provider. Asked structurally rather than with `instanceof`: two copies
   * of `@opentelemetry/api` in one process would fail an identity check on the
   * class while the delegate comparison still answers correctly.
   *
   * @param provider The provider this object registered.
   */
  #isProviderGlobal(provider: ControlTracerProvider): boolean {
    try {
      const global: unknown = trace.getTracerProvider();
      if (global === provider) {
        return true;
      }
      if (typeof global !== 'object' || global === null) {
        return false;
      }
      const delegate = (global as { getDelegate?: () => unknown }).getDelegate;
      return typeof delegate === 'function' && delegate.call(global) === provider;
    } catch {
      // A global object that threw on inspection cannot be shown to be ours.
      return false;
    }
  }

  /**
   * Hand the shared span processor to the provider just installed, and confirm
   * it is open.
   *
   * A no-op for a processor that was never closed — the first capture of a
   * process, or a capture that follows a replacement rather than a teardown —
   * and for a flush target that does not implement it. When it *is* needed it
   * is mandatory: a processor left closed drops every span it is given, so the
   * failure is returned and the capture is refused rather than armed over a
   * transport that exports nothing.
   *
   * @returns The failure that would leave this capture silent, or `null`.
   */
  #reopenProcessor(): CaptureResourceFailure | null {
    const processor = this.#processor;
    if (processor === undefined || processor.reopen === undefined) {
      return null;
    }
    try {
      processor.reopen();
    } catch (error) {
      return this.#resourceFailure(
        CAPTURE_RESOURCES.processor,
        [],
        'could not reopen the span processor for this capture',
        error,
        'Restart the dev server; the telemetry processor is closed and would export nothing.',
      );
    }
    if (processor.isShutDown === true) {
      return this.#resourceFailure(
        CAPTURE_RESOURCES.processor,
        [],
        'the span processor is still closed after being reopened, so no span would be exported',
        undefined,
        'Restart the dev server; the telemetry processor is closed and would export nothing.',
      );
    }
    return null;
  }

  /**
   * Bring each instrumentation into the state this capture's signals ask for.
   *
   * Per instrumentation, and in both directions. A plan that asked for ORM
   * tracing and not the driver's leaves `pg.Client.prototype.query`
   * **unwrapped** in the developer's process — which is what makes the
   * targeting real rather than a filter applied after the fact — and a plan
   * that asks for it again re-applies the patch.
   *
   * A toggle that throws leaves that entry **unknown** rather than at either
   * end of the switch: the SDK changes its own enabled flag before it runs the
   * patch callbacks, so a failure part-way through has applied some of them and
   * not others. Unknown is what keeps the entry in the cleanup report and costs
   * only the signals that instrumentation serves — the capture itself proceeds,
   * degraded, as AAP §0.5.5 requires. It is deliberately not rolled back here:
   * a signal this capture asked for is admitted whether its patches are whole
   * or partial, and an immediate second toggle would add a failure mode without
   * making the state any more knowable. The teardown is where it is resolved.
   *
   * @param signals The capture's signal switches.
   * @returns One failure per instrumentation that refused to toggle.
   */
  #applyInstrumentationSignals(signals: ServerAgentSignals): CaptureResourceFailure[] {
    const failures: CaptureResourceFailure[] = [];

    for (const entry of this.#instrumentations) {
      const wanted = wantsInstrumentation(entry.role, signals);
      const target = wanted ? INSTRUMENTATION_STATES.enabled : INSTRUMENTATION_STATES.disabled;
      if (entry.state === target) {
        continue;
      }
      if (wanted) {
        this.#enableInstrumentation(entry, failures);
      } else {
        const failure = this.#disableInstrumentation(entry);
        if (failure !== null) {
          failures.push(failure);
        }
      }
    }

    return failures;
  }

  /**
   * Apply one instrumentation's patches, recording what is known afterwards.
   *
   * A throw leaves the state **unknown** rather than unchanged: the SDK sets
   * its own flag before it patches, so a callback that failed part-way may have
   * wrapped some modules and not others. Unknown keeps the entry in
   * {@link ServerAgentControl.#pendingCleanup}, so the teardown still tries to
   * remove it and the cleanup report still tells the truth about it.
   *
   * An entry that is *already* unknown is not re-applied, and there is nothing
   * to be gained by trying. If its flag reads "enabled" — a failed `enable()` —
   * a second `enable()` returns immediately and patches nothing, so treating it
   * as installed would promise a signal that may be half-wrapped. If its flag
   * reads "disabled" — a failed `disable()` — patching *would* run, over
   * modules that may still carry the previous wrapper: shimmer records one
   * original per method, so the double wrap it produces survives a later single
   * unwrap. Either way the honest answer is that this process cannot supply the
   * signal, with a restart named. A teardown that later removes the patches
   * *verifiably* returns the entry to `disabled`, and the capture after that
   * enables it cleanly.
   *
   * @param entry The instrumentation to enable.
   * @param failures Where to record a failure.
   */
  #enableInstrumentation(entry: InstrumentationEntry, failures: CaptureResourceFailure[]): void {
    if (entry.state === INSTRUMENTATION_STATES.unknown) {
      failures.push(
        this.#resourceFailure(
          INSTRUMENTATION_RESOURCES[entry.role],
          INSTRUMENTATION_SIGNALS[entry.role],
          'an instrumentation whose earlier toggle failed cannot be re-applied in this process without risking a doubled patch',
          undefined,
          'Restart the dev server to collect this signal.',
        ),
      );
      return;
    }

    try {
      entry.instrumentation.enable();
      entry.state = INSTRUMENTATION_STATES.enabled;
    } catch (error) {
      entry.state = INSTRUMENTATION_STATES.unknown;
      failures.push(
        this.#resourceFailure(
          INSTRUMENTATION_RESOURCES[entry.role],
          INSTRUMENTATION_SIGNALS[entry.role],
          'could not enable an instrumentation for this capture',
          error,
          'The signal is unavailable for this capture; the patches it may have applied are removed at cleanup.',
        ),
      );
    }
  }

  /**
   * Remove one instrumentation's patches, and only claim it when the removal
   * can be shown to have done the work.
   *
   * The SDK makes this subtle. `InstrumentationBase.disable()` sets its flag to
   * `false` **before** it unpatches and returns immediately when the flag is
   * already `false`, so:
   *
   * - a `disable()` that throws leaves the flag `false` with modules possibly
   *   still wrapped, and the state becomes `unknown`;
   * - a *second* `disable()` on such an instrumentation returns without
   *   unpatching anything. Its silence is not evidence, so an entry that is
   *   already `unknown` and whose SDK flag reports "not enabled" stays
   *   `unknown` and is reported with a restart hint. The only honest
   *   alternatives would be to inspect the host's modules for residual
   *   wrappers, which this package cannot do without importing them, or to
   *   force an enable/unpatch cycle, which can leave a doubled wrapper — worse
   *   than an honest report.
   *
   * An instrumentation that does not expose the accessor is taken at its word:
   * a non-throwing `disable()` is treated as done, which is the previous
   * behaviour and all a bare `{ enable, disable }` offers.
   *
   * @param entry The instrumentation to disable.
   * @returns The failure, or `null` when the patches are verifiably gone.
   */
  #disableInstrumentation(entry: InstrumentationEntry): CaptureResourceFailure | null {
    const reportsEnabled = this.#readInstrumentationFlag(entry);
    if (entry.state === INSTRUMENTATION_STATES.unknown && reportsEnabled === false) {
      return this.#resourceFailure(
        INSTRUMENTATION_RESOURCES[entry.role],
        INSTRUMENTATION_SIGNALS[entry.role],
        'an instrumentation whose removal failed reports itself already disabled, so its patches cannot be shown to be gone',
        undefined,
        'Restart the dev server to remove them; a further disable() would do nothing.',
      );
    }

    try {
      entry.instrumentation.disable();
    } catch (error) {
      entry.state = INSTRUMENTATION_STATES.unknown;
      return this.#resourceFailure(
        INSTRUMENTATION_RESOURCES[entry.role],
        INSTRUMENTATION_SIGNALS[entry.role],
        'could not remove an instrumentation',
        error,
        'The patches may still be applied; restart the dev server to remove them.',
      );
    }

    if (this.#readInstrumentationFlag(entry) === true) {
      // It returned without throwing and still reports itself enabled, so the
      // unpatching did not happen.
      entry.state = INSTRUMENTATION_STATES.unknown;
      return this.#resourceFailure(
        INSTRUMENTATION_RESOURCES[entry.role],
        INSTRUMENTATION_SIGNALS[entry.role],
        'an instrumentation still reports itself enabled after being disabled',
        undefined,
        'Restart the dev server to remove its patches.',
      );
    }

    entry.state = INSTRUMENTATION_STATES.disabled;
    return null;
  }

  /**
   * The SDK's own enabled flag for an instrumentation, or `undefined` when it
   * does not expose one.
   *
   * Guarded: this runs on the teardown path, where an accessor that throws must
   * not abort the rest of the sequence.
   *
   * @param entry The instrumentation to ask.
   */
  #readInstrumentationFlag(entry: InstrumentationEntry): boolean | undefined {
    const instrumentation = entry.instrumentation;
    if (typeof instrumentation.isEnabled !== 'function') {
      return undefined;
    }
    try {
      return instrumentation.isEnabled();
    } catch {
      return undefined;
    }
  }

  /**
   * The disable sequence of AAP §0.5.1, in order, with every resource tracked
   * on its own.
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
   * **A step that fails is not recorded as done.** Its flag stays set, its
   * handle is kept, the report comes back `partial` naming the resource, and
   * the next `disable()` — or the next capture's installation — retries exactly
   * that step. The alternative, which this method deliberately does not do, is
   * to clear the flags regardless: the preload would then report itself inert
   * while `pg` was still wrapped or a provider was still registered, and
   * nothing in the product would ever try again.
   *
   * The span processor is **not** shut down: it outlives every cycle, and the
   * next capture reuses its buffer and its transport. `globalThis.__DEBUGGEN__`
   * is **not** uninstalled either — see this module's overview.
   *
   * @returns How inert the preload actually is.
   */
  async #runDisable(): Promise<CleanupReport> {
    this.#clearGate();

    if (this.#isInert()) {
      // Nothing is installed, so nothing is running — whatever an earlier
      // teardown reported. A `partial` that has since been finished (by a
      // retry, or by the enable path completing it) is `clean` now, and saying
      // otherwise would leave a session reporting a conflict it no longer has.
      this.#cleanupStatus = 'clean';
      return { status: 'clean', changed: false, pending: [], failures: [] };
    }

    this.#disableCount += 1;
    const failures: CaptureResourceFailure[] = [];

    const flushFailure = await this.#flushCaptured('the teardown');
    if (flushFailure !== null) {
      failures.push(flushFailure);
    }

    failures.push(...this.#disableInstrumentations());
    failures.push(...(await this.#finishTeardown()));

    const pending = this.#pendingCleanup();
    const status = pending.length === 0 ? 'clean' : 'partial';
    this.#cleanupStatus = status;

    if (status === 'clean') {
      this.#log('debug', 'instrumentation removed; the preload is inert');
    } else {
      // Named, not summarised: "partial" without the list is not something a
      // developer or the service can act on.
      this.#log('warn', 'the preload could not be made fully inert', {
        pending: pending.join(','),
      });
    }

    return { status, changed: true, pending, failures };
  }

  /**
   * Remove the instrumentation patches, one instrumentation at a time.
   *
   * Every entry that is not already verifiably disabled is attempted, whatever
   * the previous one did, and an entry whose removal could not be shown to have
   * happened stays `unknown` — so it appears in
   * {@link ServerAgentControl.#pendingCleanup}, keeps the cleanup report
   * `partial`, and is attempted again next time. Entries start `enabled` when
   * instrumentations are attached, so a session that ends without ever having
   * captured anything still leaves the developer's `pg` unwrapped — which is
   * exactly what `./control.test.ts` asserts through shimmer's `isWrapped`.
   *
   * @returns One failure per instrumentation whose patches are not provably
   * gone.
   */
  #disableInstrumentations(): CaptureResourceFailure[] {
    const failures: CaptureResourceFailure[] = [];

    for (const entry of this.#instrumentations) {
      if (entry.state === INSTRUMENTATION_STATES.disabled) {
        continue;
      }
      const failure = this.#disableInstrumentation(entry);
      if (failure !== null) {
        failures.push(failure);
      }
    }

    return failures;
  }

  /**
   * Remove the globals this object installed: the tracer provider and the
   * propagator.
   *
   * Each is tracked separately and cleared only on success. A `trace.disable()`
   * that failed leaves a global registration in place, which the *next*
   * installation has to retry before it can register anything — see
   * {@link ServerAgentControl.#ensureProvider}.
   *
   * @returns One failure per global that could not be removed.
   */
  #removeGlobals(): CaptureResourceFailure[] {
    const failures: CaptureResourceFailure[] = [];

    if (this.#globalTracerInstalled) {
      try {
        trace.disable();
        this.#globalTracerInstalled = false;
        this.#providerRegistered = false;
      } catch (error) {
        failures.push(
          this.#resourceFailure(
            CAPTURE_RESOURCES.globalTracer,
            [],
            'could not remove the global tracer provider',
            error,
            'Restart the dev server; the framework may still be creating spans.',
          ),
        );
      }
    }

    if (this.#globalPropagatorInstalled) {
      try {
        propagation.disable();
        this.#globalPropagatorInstalled = false;
      } catch (error) {
        failures.push(
          this.#resourceFailure(
            CAPTURE_RESOURCES.globalPropagator,
            [],
            'could not remove the global propagator',
            error,
          ),
        );
      }
    }

    return failures;
  }

  /**
   * Shut the provider down, and keep the handle if that fails.
   *
   * The registration is dropped *before* the await: a provider whose shutdown
   * has begun must never serve the next capture, whatever the shutdown goes on
   * to do. The handle itself is released only on success — a retained handle is
   * the only thing that makes a retry possible, and a provider whose shutdown
   * failed may still be processing spans.
   *
   * @returns The failure, or `null` when there was nothing to shut down or it
   * worked.
   */
  async #shutdownProvider(): Promise<CaptureResourceFailure | null> {
    const provider = this.#provider;
    if (provider === null) {
      this.#providerShutdownPending = false;
      return null;
    }

    this.#providerRegistered = false;

    try {
      await provider.shutdown();
      this.#provider = null;
      this.#providerShutdownPending = false;
      return null;
    } catch (error) {
      this.#providerShutdownPending = true;
      return this.#resourceFailure(
        CAPTURE_RESOURCES.provider,
        [],
        'could not shut the tracer provider down',
        error,
        'Restart the dev server; a tracer cached from this provider may still be processing spans.',
      );
    }
  }

  /**
   * The part of the teardown both paths share: remove the globals, then shut
   * the provider down.
   *
   * Called by {@link ServerAgentControl.#runDisable} as steps 4 and 5, and by
   * {@link ServerAgentControl.#ensureProvider} as the retry of a teardown that
   * did not finish. Idempotent, because each step is guarded by its own flag.
   *
   * @returns One failure per step that could not be completed.
   */
  async #finishTeardown(): Promise<CaptureResourceFailure[]> {
    const failures = this.#removeGlobals();
    const shutdownFailure = await this.#shutdownProvider();
    if (shutdownFailure !== null) {
      failures.push(shutdownFailure);
    }
    return failures;
  }

  /**
   * The resources still installed, in teardown order.
   *
   * The list is what makes `partial` actionable, and it is computed from the
   * flags rather than remembered, so it cannot disagree with them.
   */
  #pendingCleanup(): CaptureResource[] {
    const pending: CaptureResource[] = [];
    for (const entry of this.#instrumentations) {
      // `unknown` counts: an instrumentation whose toggle threw may still be
      // patched into the host, and the point of the report is to say so.
      if (entry.state !== INSTRUMENTATION_STATES.disabled) {
        pending.push(INSTRUMENTATION_RESOURCES[entry.role]);
      }
    }
    if (this.#globalTracerInstalled) {
      pending.push(CAPTURE_RESOURCES.globalTracer);
    }
    if (this.#globalPropagatorInstalled) {
      pending.push(CAPTURE_RESOURCES.globalPropagator);
    }
    if (this.#providerShutdownPending || this.#provider !== null || this.#providerRegistered) {
      pending.push(CAPTURE_RESOURCES.provider);
    }
    return pending;
  }

  /**
   * Whether there is nothing left to tear down.
   *
   * Derived from the per-resource flags rather than held as a flag of its own,
   * which is the difference between "a teardown ran" and "the teardown
   * finished": the second is the only one worth asserting, and the first is
   * what a single `inert` boolean would have recorded.
   */
  #isInert(): boolean {
    return this.#pendingCleanup().length === 0;
  }

  /**
   * Count a failure, log it without the credential, and describe it for a
   * report.
   *
   * One place, so every failure this module reports is also counted in
   * {@link ServerAgentControlStats.failures} and logged once — and so the
   * `reason` carried in a report has been through the same scrub as the log
   * line.
   *
   * @param resource Which resource failed.
   * @param signals The signals the failure costs the capture.
   * @param message What was being attempted.
   * @param error The caught value, or `undefined` when the failure is a missing
   * collaborator rather than a throw.
   * @param hint What would fix it, where there is an action to name.
   */
  #resourceFailure(
    resource: CaptureResource,
    signals: readonly ServerAgentSignalName[],
    message: string,
    error: unknown,
    hint?: string,
  ): CaptureResourceFailure {
    this.#fail(message, error);
    const reason = error === undefined ? message : `${message}: ${describeError(error)}`;
    return {
      resource,
      signals,
      reason: this.#scrub(reason),
      ...(hint === undefined ? {} : { hint }),
    };
  }

  /**
   * Whether a `function` span names a symbol the active plan patched.
   *
   * One identity, in order of authority. The `symbol` attribute the patch wrote
   * is the plan's own record of what was wrapped, so where a span declares one
   * it is **the** identity and the display name is not consulted — a span named
   * after a planned symbol while declaring a different one is the one it
   * declares. Only a span with no declared symbol falls back to its display
   * name, which `./span-helper.ts` derives from the name the patch passed.
   *
   * Both spellings of a planned name are in the allow-list, the full one and
   * (where it is unambiguous) the shortened one
   * ({@link resolveFunctionAllowList}), because the helper bounds both the span
   * name and a string attribute at `MAX_PREVIEW_LENGTH`.
   *
   * @param candidate The span facts `./exporter.ts` read.
   */
  #isPlannedFunction(candidate: SpanAdmissionCandidate): boolean {
    if (this.#functionAllowList.size === 0) {
      return false;
    }

    const symbol = candidate.attributes[FUNCTION_SYMBOL_ATTRIBUTE];
    if (typeof symbol === 'string') {
      const declared = symbol.trim();
      if (declared.length > 0) {
        // The patch's own record of what it wrapped **outranks** the display
        // name, and replaces it rather than joining it: a span that happens to
        // be named after a planned symbol while declaring an unplanned one is
        // the unplanned one, and accepting either identity would admit it.
        return this.#functionAllowList.has(declared);
      }
    }

    return this.#functionAllowList.has(candidate.name.trim());
  }

  /**
   * Close the gate: no capture, no signals, no admitted kinds, no admitted
   * sources and no planned functions.
   *
   * Every axis of the admission policy is cleared, not only the kinds: a
   * closed gate answers `no-capture` before any of them is consulted, and
   * leaving one populated would make a stale answer possible the moment the
   * capture id came back.
   *
   * The capture generation is deliberately **not** advanced here. It counts
   * captures armed, so a span started and ended inside one capture carries the
   * same value at both ends, and a span outliving a closed gate is already
   * dropped by the capture id being `null`.
   */
  #clearGate(): void {
    this.#sessionId = null;
    this.#captureId = null;
    this.#signals = NO_SIGNALS;
    if (this.#enabledKinds.size > 0) {
      this.#enabledKinds = new Set<TelemetryKind>();
    }
    if (this.#enabledDbSources.size > 0) {
      this.#enabledDbSources = new Set<DatabaseSpanSource>();
    }
    if (this.#functionAllowList.size > 0) {
      this.#functionAllowList = new Set<string>();
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
          // The protocol's version, whose major the service compares before it
          // answers with configuration — not this package's version, which
          // belongs to OpenTelemetry scope metadata and would be read as an
          // incompatible major and close the socket.
          version: WIRE_PROTOCOL_VERSION,
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
 * Whether two sets hold exactly the same members.
 *
 * Used for the enable path's idempotence check, over each axis of the
 * admission policy — kinds, database sources, planned function identities — so
 * that a service re-sending the capture it already sent (on a reconnect, for
 * instance) causes no provider to be rebuilt and no counter to move, while a
 * frame that differs on any axis is applied.
 *
 * @param left One set.
 * @param right The other.
 * @returns Whether they are equal.
 */
function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const member of left) {
    if (!right.has(member)) {
      return false;
    }
  }
  return true;
}
