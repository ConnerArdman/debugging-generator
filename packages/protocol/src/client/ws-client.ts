/**
 * The WebSocket half of this package's transport SDK: one reconnecting client
 * that speaks the envelope of `../envelope.ts` over the service's `/ws`
 * endpoint, authenticates with a `client.hello` first frame, and hands every
 * validated frame to typed subscribers.
 *
 * AAP §0.7.1 (Group 1) specifies exactly this — "`ReconnectingWsClient` taking a
 * `WebSocket` constructor (works in Node via `ws`, in the SW via the global)
 * with backoff, the `client.hello` token handshake and a typed
 * `on(type, handler)`" — and those four features are the whole surface. Three
 * processes hold a socket to the local service: the service's own tests and
 * tooling, the VS Code extension host (`apps/vscode-extension/src/service/`) and
 * the Chrome MV3 service worker (`apps/chrome-extension/src/background/`), which
 * also relays the DevTools panel's frames and the page agent's event batches.
 * Written three times, the handshake ordering, the backoff curve and the
 * refusal rules would drift three ways; written here, a change to any of them is
 * one edit every client inherits.
 *
 * ## Why the `WebSocket` constructor is injected rather than imported
 *
 * This package declares **no `ws` and no `@types/node`** on purpose
 * (`package.json`, `tsconfig.json`), and `tsup.config.ts` builds it with
 * `platform: 'neutral'` so that a `node:*` or `ws` specifier fails the build
 * instead of being externalised into three browser bundles. One class therefore
 * has to serve very different hosts: the service and the extension host each
 * declare `ws` themselves and pass its constructor, while the MV3 service worker
 * passes the platform global. Both satisfy {@link WebSocketConstructorLike},
 * this file's own minimal structural description of a socket — asserted for the
 * platform constructor by {@link GlobalWebSocketIsWebSocketConstructorLike} —
 * and a test satisfies it with a fake that records what was sent.
 *
 * Every other environment-dependent capability is injected for the same reason
 * and resolved lazily where it is not: {@link TimerApi} makes the backoff curve
 * assertable without a clock, `random` makes its jitter deterministic, and the
 * platform `setTimeout`/`clearTimeout` are read at call time rather than at
 * import time, so importing this module still does nothing at all
 * (`package.json` declares `sideEffects: false`).
 *
 * ## The credential is the one value that never appears anywhere
 *
 * The hello frame carries a bearer credential, and AAP §0.5.2 puts it outside
 * every diagnostic path: it is never logged, never echoed, never part of a
 * message, a hint or a `details` field. That rule needs no discipline at the
 * call sites below, because the paths that could leak it do not accept it — a
 * schema rejection is rendered by `../version.ts`'s `protocolParseError` from
 * issue paths and codes alone, no log record here takes a payload, and the
 * unauthorized hook reports a close code and a constant reason rather than what
 * was presented. `resolveWsUrl` refuses a URL with embedded credentials for the
 * same reason: a `ws://user:pass@host` would put a secret on a value both user
 * interfaces display.
 *
 * ## Reconnection is the normal case
 *
 * The MV3 service worker suspends after roughly thirty seconds of idleness
 * (AAP §0.1.1), and the service marks a client offline while keeping its session
 * alive (AAP §0.5.5), so a socket closing is routine rather than exceptional.
 * Reconnects are consequently cheap and side-effect-free: no module-scope state,
 * no listener that outlives its socket, and a queue bounded at
 * {@link DEFAULT_MAX_QUEUED_MESSAGES} small control frames. The one close that
 * is *not* retried is `WS_CLOSE_UNAUTHORIZED` — a refused credential is a
 * pairing or rotation problem (AAP §0.5.6), and retrying it would be a loop that
 * never succeeds and a lockout that punishes the developer.
 *
 * What this file deliberately does not do is keep a suspended worker awake.
 * The `chrome.alarms` keepalive of AAP §0.5.5 belongs to
 * `apps/chrome-extension/src/background/ws-bridge.ts`, which is the only
 * consumer that has an alarms API; nothing here starts a repeating timer, and
 * the only timer it starts at all is the one-shot reconnect delay.
 *
 * ## Consumed through the barrel, and coupled to nothing
 *
 * `../index.ts` is this package's single entry (`tsup.config.ts`), so a symbol
 * it does not re-export does not exist for a consumer. Nothing inside `src/**`
 * imports this module — not `../envelope.ts`, not `../http.ts`, not any
 * `../messages/*.ts`, each of which states the same rule from its own end — and
 * this module imports neither its sibling `./http-client.ts` (the two SDKs are
 * siblings, not layers) nor anything outside the four `@debuggen` packages this
 * package is allowed to know about (`eslint.config.js`).
 *
 * The state a user interface renders reaches it as {@link ConnectionState}
 * through {@link ReconnectingWsClientOptions.onStateChange}, never as a socket:
 * AAP §0.1.2 asks that no view be coupled to WebSocket implementation details,
 * so the socket is private, the panel's "Reconnecting…" pill is a state name,
 * and a panel component gets its data from `PanelHost` rather than from here.
 *
 * Every export is named; there is no default export.
 */

import { DebuggenError, err, isErr, noopLogger, ok, tryCatch } from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';

import { createEnvelope, encodeMessage, decodeMessage, isMessageOfType } from '../envelope.js';
import type { CreateEnvelopeOptions, MessagePayload, ProtocolMessage } from '../envelope.js';
import { WS_PATH } from '../http.js';
import {
  CLIENT_HELLO_TIMEOUT_MS,
  WS_CLOSE_UNAUTHORIZED,
  clientHelloPayloadSchema,
} from '../messages/index.js';
import type { ClientKind, MessageType } from '../messages/index.js';
import { PROTOCOL_VERSION, protocolParseError } from '../version.js';

// ---------------------------------------------------------------------------
// Section A — transport constants and the constant failure texts
//
// The two numbers that govern the handshake are *not* here: the close code a
// refused connection receives and the window the service allows for a hello are
// `WS_CLOSE_UNAUTHORIZED` and `CLIENT_HELLO_TIMEOUT_MS`, imported above from the
// module that owns the frame they govern. Writing either as a literal in this
// file would be the second definition AAP §0.9.1 forbids.
// ---------------------------------------------------------------------------

/**
 * `WebSocket.OPEN`, the one `readyState` value at which a frame may be written.
 *
 * Spelled as a constant rather than read from the injected constructor for two
 * reasons. It is fixed by the WebSocket API itself — `CONNECTING` 0, `OPEN` 1,
 * `CLOSING` 2, `CLOSED` 3 — so both the platform class and `ws` report the same
 * number; and {@link WebSocketLike} describes an *instance*, so a static read
 * would force every consumer and every test fake to carry the four statics
 * merely to be accepted.
 */
const WEBSOCKET_OPEN_READY_STATE = 1;

/**
 * The close code this client sends when it closes a socket itself.
 *
 * `1000` is the protocol's "normal closure". A client never closes with
 * {@link WS_CLOSE_UNAUTHORIZED}: that code is the *service's* statement that a
 * credential was refused, and echoing it outward would make a local decision
 * indistinguishable from a remote refusal in the service's own logs.
 */
const NORMAL_CLOSURE_CODE = 1000;

/**
 * The reason reported to {@link ReconnectingWsClientOptions.onUnauthorized} when
 * no credential could be resolved at all.
 *
 * A constant sentence, never a function of what was resolved: this string
 * reaches a user interface, and the value it describes is a secret (AAP §0.5.2).
 * It is what makes the DevTools panel show "Not paired" and open its
 * `PairDialog` instead of reporting a transport failure the developer cannot
 * act on.
 */
const NO_CREDENTIAL_REASON = 'no credential is available for this client';

/**
 * The reason reported when a credential provider did not answer within
 * {@link CLIENT_HELLO_TIMEOUT_MS}.
 *
 * Treated as "no credential" rather than as a transport fault, because that is
 * what it is from the service's point of view — the connection would be closed
 * with {@link WS_CLOSE_UNAUTHORIZED} on the same deadline — and because the
 * actionable next step is the same one: pair, or rotate.
 */
const CREDENTIAL_TIMEOUT_REASON = 'the credential provider did not answer in time';

/**
 * The reason reported when the service itself closed the connection with
 * {@link WS_CLOSE_UNAUTHORIZED} and gave no reason of its own.
 *
 * The service sends a reason in most cases; this stands in for the ones where it
 * does not, so a user interface always has a sentence to show.
 */
const REFUSED_CREDENTIAL_REASON = 'the service refused this credential';

/** The reason a socket that could not even be created reports. */
const SOCKET_OPEN_FAILED_REASON = 'the socket could not be opened';

/** The reason a socket that died before its hello frame reports. */
const HELLO_WRITE_FAILED_REASON = 'the connection closed before the handshake was sent';

/** The reason a client with an unusable identity reports as it closes. */
const INVALID_HELLO_REASON = 'this client could not assemble a valid handshake';

/** The prefix of the one schema rejection this client can raise on its own. */
const INVALID_HELLO_PREFIX = 'Invalid client.hello payload';

/**
 * The hint for that rejection.
 *
 * A malformed hello is a misconfigured client — a client kind that is not one of
 * `CLIENT_KINDS`, a negative tab id, a project root of four kilobytes — so the
 * hint names the option to correct rather than suggesting a retry.
 */
const INVALID_HELLO_HINT =
  'Check the identity and credential this client was constructed with: the client kind, the project root and the tab id must match what the service accepts.';

/** The failure returned by {@link ReconnectingWsClient.send} after `close()`. */
const SEND_AFTER_CLOSE_MESSAGE = 'Cannot send a frame: this client is closed';

/** Its hint: a closed client is resumed explicitly, never implicitly. */
const SEND_AFTER_CLOSE_HINT = 'Call connect() to reopen the connection before sending.';

/** The message for a frame dropped because the outbound queue is full. */
const QUEUE_OVERFLOW_MESSAGE = 'Dropped the oldest queued frame: the outbound queue is full';

/** The failure for a frame handed over while queueing is disabled. */
const QUEUE_DISABLED_MESSAGE =
  'Dropped the frame: the socket is not open and outbound queueing is disabled';

/** Its hint: the bound is the consumer's own option. */
const QUEUE_DISABLED_HINT =
  'Raise maxQueuedMessages, or send once the client reports the open state.';

/** The failure for an inbound frame that is neither text nor decodable bytes. */
const UNSUPPORTED_FRAME_MESSAGE = 'Dropped an inbound frame: its payload is not text';

/** Its hint: this protocol is JSON text on the wire, in both directions. */
const UNSUPPORTED_FRAME_HINT =
  'Every frame of this protocol is JSON text; a producer must send text frames, or UTF-8 bytes of the same JSON.';

/** The failure for decodable bytes in a runtime with no `TextDecoder`. */
const NO_DECODER_MESSAGE =
  'Dropped an inbound binary frame: this runtime provides no TextDecoder to read it with';

// ---------------------------------------------------------------------------
// Section B — the injected transport, typed structurally
//
// These declarations are the reason no `@types/ws` and no DOM `WebSocket` type
// appears in this package's surface. They describe only what this client uses,
// which is what lets Node's `ws`, the platform `WebSocket` and a small test
// fake all satisfy them.
// ---------------------------------------------------------------------------

/**
 * The `open` event, as this client reads it.
 *
 * It reads nothing from the event — the fact that it fired is the whole signal —
 * but the member is required rather than an empty object type: `{}` accepts
 * every non-nullish value, which would let a typo in a fake's event map pass
 * unnoticed, and both the platform's `Event` and `ws`'s carry `type`.
 */
export interface WsOpenEventLike {
  /** The event's name, `'open'`. Read by nothing here. */
  readonly type: string;
}

/**
 * The `message` event, as this client reads it.
 *
 * `data` is `unknown` deliberately. A text frame arrives as a string in every
 * runtime, but `ws` delivers a **binary** frame as a `Buffer`, an `ArrayBuffer`
 * or an array of buffers depending on its configuration, and this package cannot
 * name a `Buffer` type at all (`types: []`). Typing the field `unknown` is what
 * forces the defensive coercion in {@link coerceFrameText} instead of a
 * `String(…)` that would turn `[object Object]` into a parse failure nobody can
 * explain.
 */
export interface WsMessageEventLike {
  /** The frame's payload: a string for text, something else for binary. */
  readonly data: unknown;
}

/**
 * The `close` event, as this client reads it.
 *
 * Both fields are required because both are load-bearing: `code` is what
 * separates a refused credential ({@link WS_CLOSE_UNAUTHORIZED}) from a
 * reconnectable drop, and `reason` is what the unauthorized hook forwards to the
 * user interface. The platform's `CloseEvent` and `ws`'s both supply them.
 */
export interface WsCloseEventLike {
  /**
   * The close code. {@link WS_CLOSE_UNAUTHORIZED} is terminal for the credential
   * just presented; every other code is retried on the curve.
   */
  readonly code: number;
  /** The service's reason, empty when it gave none. */
  readonly reason: string;
}

/**
 * The `error` event, as this client reads it.
 *
 * `message` is optional because the two runtimes disagree: `ws` raises an
 * `ErrorEvent` carrying a message, while the platform raises a bare `Event` that
 * has none — deliberately, so that a page cannot learn why a connection failed.
 * Nothing here reads it in either case (see
 * {@link ReconnectingWsClient} on the `error` event); the member exists so a
 * consumer's own fake can carry one without widening this type.
 */
export interface WsErrorEventLike {
  /** The transport's own description, where the runtime provides one. */
  readonly message?: string;
}

/**
 * The four events this client subscribes to, mapped to their payloads.
 *
 * The key set is exactly the platform's `WebSocketEventMap`, which is what lets
 * the platform constructor satisfy {@link WebSocketLike}'s generic
 * `addEventListener` without a cast.
 */
export interface WsEventMapLike {
  /** The socket is open; the hello frame is written next. */
  open: WsOpenEventLike;
  /** A frame arrived. */
  message: WsMessageEventLike;
  /** The socket closed, for any reason. */
  close: WsCloseEventLike;
  /** The transport failed; a `close` event follows it. */
  error: WsErrorEventLike;
}

/**
 * A socket, as this client uses it: four events, a state, a text write and a
 * close.
 *
 * Narrower than either real implementation on purpose — no `binaryType`, no
 * `bufferedAmount`, no `ping`, no `on`/`once` — because a member absent here is
 * a member this client never touches, which is a reviewable statement rather
 * than a comment. `send` accepts a string alone for the same reason: every frame
 * this protocol carries is JSON text (`../envelope.ts`).
 */
export interface WebSocketLike {
  /**
   * The socket's state, compared against {@link WEBSOCKET_OPEN_READY_STATE}
   * before a write.
   */
  readonly readyState: number;

  /**
   * Subscribes to one event.
   *
   * Generic over the event name so the listener's parameter is resolved from
   * {@link WsEventMapLike} — the shape both real implementations already have,
   * and the reason no per-event overload is needed here.
   */
  addEventListener<K extends keyof WsEventMapLike>(
    type: K,
    listener: (event: WsEventMapLike[K]) => void,
  ): void;

  /** Removes a listener added by {@link WebSocketLike.addEventListener}. */
  removeEventListener<K extends keyof WsEventMapLike>(
    type: K,
    listener: (event: WsEventMapLike[K]) => void,
  ): void;

  /** Writes one text frame. Throws when the socket is not open. */
  send(data: string): void;

  /** Starts the closing handshake. */
  close(code?: number, reason?: string): void;
}

/**
 * The injected transport: anything `new`-able into a {@link WebSocketLike}.
 *
 * Satisfied by `ws`'s `WebSocket` class, by the platform `WebSocket` (asserted
 * below) and by a test fake. The second parameter is the subprotocol list, which
 * the service does not require and which is forwarded only when a consumer
 * passes {@link ReconnectingWsClientOptions.protocols}.
 */
export type WebSocketConstructorLike = new (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

/** Constrains {@link AssignableTo} to a proof rather than a boolean. */
type AssertTrue<TAssertion extends true> = TAssertion;

/** Whether `TSource` is assignable to `TTarget`, as a literal `true`/`false`. */
type AssignableTo<TSource, TTarget> = [TSource] extends [TTarget] ? true : false;

/**
 * Compile-time proof that the platform `WebSocket` satisfies
 * {@link WebSocketConstructorLike}.
 *
 * The structural types above exist so that no ambient DOM or Node type enters
 * this package's surface, and nothing would otherwise notice if they drifted
 * from a real implementation — until the Chrome service worker passed
 * `globalThis.WebSocket` and the compiler refused it in *that* build. This alias
 * moves the failure here, into this package's own `tsc -b`.
 *
 * `ws`'s class cannot be asserted the same way, because this package must not
 * import `ws` or `@types/ws`; that direction is covered by the consumers that do
 * declare it, and it was verified against `ws` 8.21.3's published typings while
 * this file was written.
 *
 * Exported for the mechanical reason the sibling's drift guards are exported:
 * this repository compiles with `noUnusedLocals` and lints with
 * `@typescript-eslint/no-unused-vars`, under which an unreferenced local type
 * alias is itself an error. It is a type, so nothing is emitted.
 */
export type GlobalWebSocketIsWebSocketConstructorLike = AssertTrue<
  AssignableTo<typeof WebSocket, WebSocketConstructorLike>
>;

/**
 * The two timer functions this client uses, injectable as a pair.
 *
 * Injected so the backoff curve is assertable without a clock: a test passes an
 * implementation that records each `(handler, ms)` and fires them on demand, and
 * the delay sequence of {@link ReconnectingWsClientOptions.backoff} becomes an
 * equality assertion rather than a wait. When the option is omitted the platform
 * functions are used, resolved at call time.
 *
 * The handle is a `number` because that is what the signature in scope here
 * returns: `tsconfig.json` declares `types: []` with `lib: ["ES2023", "DOM"]`,
 * so `setTimeout` is the web platform's. It is treated as opaque — minted by
 * `setTimeout`, compared against nothing, and handed back to `clearTimeout`
 * unchanged — so Node's object handle survives the round trip at runtime even
 * though Node's own declaration is not nameable in this package. A Node consumer
 * that wants to inject its own timers narrows them to this shape; nothing here
 * requires that, because the default path needs no injection.
 *
 * There is deliberately no `setInterval`: the MV3 keepalive of AAP §0.5.5 is the
 * Chrome extension's `chrome.alarms` job, and a repeating timer here would
 * duplicate it in a package that cannot see whether it is running in a worker.
 */
export interface TimerApi {
  /** Schedules `handler` after `ms` milliseconds; answers an opaque handle. */
  setTimeout(handler: () => void, ms: number): number;
  /** Cancels a handle from {@link TimerApi.setTimeout}. */
  clearTimeout(handle: number): void;
}

// ---------------------------------------------------------------------------
// Section C — the connection state a user interface renders
// ---------------------------------------------------------------------------

/**
 * The four states a connection can be in, as a closed readonly tuple.
 *
 * Exactly four, and each one is something a user interface says out loud: the
 * DevTools panel's `ConnectionStatus` pill and the editor's `StatusBar` render
 * them directly (AAP §0.5.5 names the "Reconnecting…" pill), so a fifth literal
 * would be a fifth thing every surface has to have an opinion about.
 *
 * - `connecting` — a socket is opening after an explicit
 *   {@link ReconnectingWsClient.connect}, and the handshake has not completed.
 * - `open` — the hello frame was accepted by the transport and queued frames are
 *   flowing. This is the only state in which {@link ReconnectingWsClient.send}
 *   writes directly to the socket.
 * - `reconnecting` — the socket dropped and a replacement is scheduled or
 *   opening. Frames handed over meanwhile are queued, not lost.
 * - `closed` — nothing is running: the client has never connected, was closed by
 *   its owner, or had its credential refused.
 *
 * A never-connected client and a deliberately stopped one are both `closed`
 * because they behave identically — nothing is running, and only `connect()`
 * changes that. What separates them is reported rather than enumerated:
 * {@link ReconnectingWsClient.lastCloseCode} is `undefined` for the first and
 * carries the close code for the second, and
 * {@link ReconnectingWsClientOptions.onStateChange} receives a
 * {@link WsStateChangeDetail} naming the code and reason.
 */
export const CONNECTION_STATES = ['connecting', 'open', 'reconnecting', 'closed'] as const;

/**
 * One member of the closed {@link CONNECTION_STATES} vocabulary.
 *
 * Derived from the tuple rather than declared beside it, so the values and the
 * type cannot drift and an exhaustive `switch` in a consumer's view keeps
 * compiling only while it covers every state.
 */
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * What accompanies a state change, where there is anything to say.
 *
 * Every field is optional because each answers a question only some transitions
 * raise, and a consumer that renders a state name alone can ignore the whole
 * argument. Nothing here is ever a credential (AAP §0.5.2): a `reason` is either
 * the service's own close reason or one of this module's constant sentences.
 */
export interface WsStateChangeDetail {
  /** The close code, on a transition caused by a close event or by `close()`. */
  readonly code?: number | undefined;
  /** Why, in words a user interface can show. */
  readonly reason?: string | undefined;
  /** Which reconnect attempt this is, 1-based, on a move to `reconnecting`. */
  readonly attempt?: number | undefined;
  /** How long until that attempt opens a socket, in milliseconds. */
  readonly delayMs?: number | undefined;
}

/** What {@link ReconnectingWsClientOptions.onUnauthorized} receives. */
export interface WsUnauthorizedDetail {
  /**
   * The close code. Always {@link WS_CLOSE_UNAUTHORIZED}, including when the
   * refusal was decided locally because no credential could be resolved — the
   * situation is the same one from the developer's point of view, and a panel
   * that shows "Not paired" should not have to know which end noticed.
   */
  readonly code: number;
  /** The service's close reason, or one of this module's constant sentences. */
  readonly reason: string;
}

/** What {@link ReconnectingWsClientOptions.onQueueDrop} receives. */
export interface WsQueueDropDetail {
  /** The message type of the frame that was dropped, never its payload. */
  readonly type: MessageType;
  /** How many frames remain queued after the drop. */
  readonly queued: number;
}

// ---------------------------------------------------------------------------
// Section D — identity, credentials, backoff and the construction options
// ---------------------------------------------------------------------------

/**
 * The non-secret half of the `client.hello` payload: who this client is.
 *
 * The three fields are the ones `../messages/agent.ts` declares alongside the
 * version and the credential, and neither optional field is a permission: the
 * service pairs what a client announces with the scope of the credential it
 * presented and acts on the intersection (AAP §0.5.6).
 */
export interface WsClientIdentity {
  /** Which process is speaking: `vscode`, `devtools`, `agent`, `server-agent`. */
  readonly client: ClientKind;
  /**
   * The absolute path of the project this client acts for, where it has one —
   * the editor's workspace folder, or a launched dev server's project root.
   */
  readonly projectRoot?: string | undefined;
  /**
   * The Chrome tab this connection is attached to, where it has one:
   * `chrome.devtools.inspectedWindow.tabId` for a DevTools connection.
   */
  readonly tabId?: number | undefined;
}

/**
 * A credential resolved per connection attempt, synchronously or not.
 *
 * The lazy form is what the Chrome service worker needs: its DevTools credential
 * lives in `chrome.storage.local`, whose read is asynchronous, and the worker is
 * suspended and revived between attempts, so a credential captured once at
 * construction would be read from a dead closure. It is equally what lets
 * `debuggen.rotateServiceToken` take effect without rebuilding the client — the
 * next attempt simply resolves the new value.
 *
 * Answering `undefined` or an empty string means "no credential is available",
 * which refuses the connection locally rather than sending an unauthenticated
 * frame the service would close on.
 *
 * Declared here without being exported: the sibling `./http-client.ts` already
 * exports this exact one-line contract for the HTTP half, and a second exported
 * spelling of it would make `../index.ts`'s re-export of the two clients
 * ambiguous (TS2308) for a name that means the same thing in both. A consumer
 * that wants to name the type imports it from the package's barrel once; a
 * consumer that merely passes a function needs no name at all.
 */
type TokenProvider = () => string | undefined | Promise<string | undefined>;

/**
 * The backoff curve, fully specified.
 *
 * `delay(n) = min(initialMs * factor^(n-1), maxMs)` for a 1-based attempt
 * number, with {@link WsBackoff.jitter} applied on top. See
 * {@link DEFAULT_WS_BACKOFF} for the values AAP §0.5.5 prescribes.
 */
export interface WsBackoff {
  /** The delay before the first reconnect attempt, in milliseconds. */
  readonly initialMs: number;
  /** The ceiling every later delay is clamped to, in milliseconds. */
  readonly maxMs: number;
  /** The multiplier applied per attempt. */
  readonly factor: number;
  /**
   * How much of each delay is randomised, from `0` (none) to `1` (the whole
   * delay). Applied as *equal jitter*: see
   * {@link ReconnectingWsClientOptions.random}.
   */
  readonly jitter: number;
}

/**
 * A partial {@link WsBackoff}: every field a consumer omits comes from
 * {@link DEFAULT_WS_BACKOFF}.
 *
 * Derived from {@link WsBackoff} by a mapped type rather than restated, so the
 * two cannot disagree about which fields exist. Each member accepts an explicit
 * `undefined` as well as absence, so a consumer assembling options from its own
 * configuration does not need a conditional spread per field.
 */
export type WsBackoffOptions = { readonly [K in keyof WsBackoff]?: WsBackoff[K] | undefined };

/**
 * The backoff AAP §0.5.5 prescribes: exponential from half a second to ten
 * seconds.
 *
 * With `factor: 2` the nominal sequence is 500, 1 000, 2 000, 4 000, 8 000,
 * 10 000, 10 000 … milliseconds, and `jitter: 0.5` spreads each delay over the
 * upper half of that value — enough that several clients waking from an MV3
 * suspension at once do not retry in lockstep, and little enough that the curve
 * remains the documented one.
 *
 * Frozen because it is module-level shared state: a consumer that mutated it
 * would change the curve for every client in its process.
 */
export const DEFAULT_WS_BACKOFF: WsBackoff = Object.freeze({
  initialMs: 500,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.5,
});

/**
 * How many outbound frames are held while the socket is down: two hundred.
 *
 * This queue exists for **small control frames across an MV3 suspension** — a
 * `session.bind`, a `target.selected`, a `source.open` — and not for telemetry.
 * The browser agent already buffers up to five thousand of its own events while
 * the bridge is away (AAP §0.5.5), which is the right place for volume: those
 * events are batched into one `telemetry.event` frame only once a socket exists,
 * so a large queue here would duplicate a buffer that already lives closer to
 * the producer, and would hold megabytes of page data in a service worker that
 * can be discarded at any moment.
 *
 * Two hundred is generous for that purpose: a developer cannot produce two
 * hundred control frames during a thirty-second suspension. Overflow drops the
 * **oldest** frame and reports it through
 * {@link ReconnectingWsClientOptions.onQueueDrop}.
 */
export const DEFAULT_MAX_QUEUED_MESSAGES = 200;

/**
 * What {@link ReconnectingWsClient.send} did with a frame.
 *
 * `'sent'` means it was written to an open socket; `'queued'` means it is held
 * in FIFO order and will be written after the next successful handshake. Both
 * are successes — a frame handed over while a service worker is waking up is not
 * an error (AAP §0.5.5) — and the distinction is reported so a caller that needs
 * an immediate answer, rather than delivery, can tell.
 */
export type SendOutcome = 'sent' | 'queued';

/**
 * A typed subscription's handler.
 *
 * The parameter is the one member of {@link ProtocolMessage} whose discriminant
 * is `K`, so a handler for `'panel.generated'` reads `message.payload.panel` as
 * a `PanelSpec` with no narrowing, no cast and no optional chaining.
 *
 * It is spelled `Extract<ProtocolMessage, { type: K }>` rather than
 * `MessageByType<K>` for the reason `../envelope.ts` gives where
 * `isMessageOfType` declares the same shape: the two are *the same type* for
 * every concrete `K` — `Extract` selects the union member that `MessageByType`
 * built — but TypeScript cannot relate an unresolved `MessageByType<K>` to the
 * union it belongs to, so only the filtered form lets
 * {@link ReconnectingWsClient.on} hand a narrowed frame to a handler without a
 * cast. A consumer may still annotate its own handler with `MessageByType<K>`:
 * for a concrete type name the compiler resolves both spellings to one type.
 *
 * @typeParam K The message type subscribed to.
 */
export type MessageHandler<K extends MessageType> = (
  message: Extract<ProtocolMessage, { type: K }>,
) => void;

/**
 * The function {@link ReconnectingWsClient.on} returns: call it to unsubscribe.
 *
 * Named because both extension surfaces collect these into a disposal list — the
 * VS Code extension's `context.subscriptions` and the panel's effect cleanup —
 * and an anonymous `() => void` in that position says nothing about what calling
 * it does.
 */
export type Unsubscribe = () => void;

/**
 * How one {@link ReconnectingWsClient} is configured.
 *
 * Four fields are required — the socket URL, the constructor to open it with,
 * who this client is and the credential it presents — and each of the rest has a
 * defined default that is the one a consumer would otherwise write itself. Every
 * optional field declares `| undefined` explicitly, which is what
 * `tsconfig.base.json` prescribes for a hand-written optional that can
 * legitimately hold `undefined`: with `exactOptionalPropertyTypes` on, a
 * consumer forwarding its own `Logger | undefined` would otherwise need a
 * conditional spread per field.
 *
 * The five hooks replace an event emitter on purpose. A client has exactly one
 * owner in each process — the service's client registry, the extension's service
 * client, the service worker's bridge — and that owner is the layer that maps
 * these callbacks onto whatever its host renders (AAP §0.1.2 asks that no view be
 * coupled to WebSocket details). None of them may throw usefully: a hook that
 * does is caught, and reported through {@link onProtocolError} where that hook
 * is not itself the one that failed.
 */
export interface ReconnectingWsClientOptions {
  /**
   * The socket URL, for example `ws://127.0.0.1:43117/ws`.
   *
   * Absolute and complete: build it with {@link resolveWsUrl} from the same base
   * URL the HTTP client uses, so the path and the scheme mapping are decided in
   * one place (AAP §0.3.4 puts the host and port in the environment, which is
   * what lets a second service instance run on another port).
   */
  readonly url: string;

  /**
   * The socket implementation: `ws`'s `WebSocket` in Node, the platform
   * `WebSocket` in the MV3 service worker, a fake in a test.
   */
  readonly webSocketConstructor: WebSocketConstructorLike;

  /** Who this client announces itself as in the hello frame. */
  readonly identity: WsClientIdentity;

  /**
   * The bearer credential, or a provider that resolves one per attempt.
   *
   * ⚠️ Secret. It is read once per connection attempt, placed in the hello
   * frame, and never logged, echoed or attached to an error (AAP §0.5.2).
   */
  readonly token: string | TokenProvider;

  /**
   * The WebSocket subprotocols to request, when the consumer has a reason to.
   *
   * The service negotiates none, so this is forwarded to the constructor only
   * when present and exists for a consumer behind a proxy that requires one.
   */
  readonly protocols?: string | string[] | undefined;

  /** Overrides for the reconnect curve. Defaults to {@link DEFAULT_WS_BACKOFF}. */
  readonly backoff?: WsBackoffOptions | undefined;

  /**
   * How many frames may wait for a socket. Defaults to
   * {@link DEFAULT_MAX_QUEUED_MESSAGES}; `0` disables queueing, so every frame
   * handed over while the socket is down is dropped and reported.
   */
  readonly maxQueuedMessages?: number | undefined;

  /**
   * Where this client's few `debug` records go. Defaults to `noopLogger`, so a
   * library consumer that wants no output configures nothing.
   *
   * No record here carries a payload, a URL or a credential — a message name, a
   * close code, an attempt number and a delay are the whole vocabulary.
   */
  readonly logger?: Logger | undefined;

  /** The timer pair. Defaults to the platform functions, resolved at call time. */
  readonly timers?: TimerApi | undefined;

  /**
   * The randomness the jitter draws on. Defaults to `Math.random`.
   *
   * Equal jitter is applied as
   * `delay = nominal * (1 - jitter + jitter * random())`, so an injected
   * `() => 1` reproduces the nominal sequence exactly — which is what makes the
   * documented 500 → 10 000 ms curve an equality assertion in a test — and
   * `() => 0` halves it at the default `jitter` of `0.5`.
   */
  readonly random?: (() => number) | undefined;

  /**
   * Called on every state transition, with detail where there is any.
   *
   * This is the hook a user interface renders. It is invoked after the state has
   * changed, so a handler reading {@link ReconnectingWsClient.state} sees the new
   * value.
   */
  readonly onStateChange?:
    ((state: ConnectionState, detail?: WsStateChangeDetail) => void) | undefined;

  /**
   * Called for every validated inbound frame, before typed dispatch.
   *
   * The catch-all a relay needs: the Chrome service worker forwards frames to
   * the DevTools panel over a runtime port without interpreting them, and the
   * service's registry logs and fans out by session. It never receives an
   * unvalidated value — a frame that fails {@link decodeMessage} reaches
   * {@link onProtocolError} instead and is dropped.
   */
  readonly onMessage?: ((message: ProtocolMessage) => void) | undefined;

  /**
   * Called for a frame that could not be decoded, for a transport failure, and
   * for an exception thrown by a subscriber.
   *
   * Always a {@link DebuggenError} with a code from the closed vocabulary of
   * `@debuggen/shared`: `PROTOCOL_INVALID_MESSAGE` for a frame this client
   * refused, `TRANSPORT_DISCONNECTED` for a socket that could not be opened or
   * written, `INTERNAL` for a handler that threw. None of them carries the
   * rejected frame, a payload or a credential.
   */
  readonly onProtocolError?: ((error: DebuggenError) => void) | undefined;

  /**
   * Called when the credential was refused, or when none could be resolved.
   *
   * Terminal in both cases: no reconnect is scheduled, because retrying a
   * refused credential is a loop that cannot succeed and, against the service's
   * pairing rate limit, a lockout (AAP §0.5.6). The DevTools panel answers it by
   * showing "Not paired" and opening its `PairDialog`; the editor offers
   * `debuggen.rotateServiceToken`. Calling {@link ReconnectingWsClient.connect}
   * again clears the terminal state and re-resolves the credential through the
   * provider, which is the resume path after either remedy.
   */
  readonly onUnauthorized?: ((detail: WsUnauthorizedDetail) => void) | undefined;

  /**
   * Called when a queued frame was dropped to stay inside
   * {@link ReconnectingWsClientOptions.maxQueuedMessages}.
   *
   * Carries the dropped frame's message type and the remaining depth, never its
   * payload. A consumer that must not lose a frame — the service worker relaying
   * a `source.open` the developer just clicked — surfaces this rather than
   * discovering the loss as silence.
   */
  readonly onQueueDrop?: ((detail: WsQueueDropDetail) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Section E — the socket URL, derived once for all three consumers
// ---------------------------------------------------------------------------

/**
 * The scheme map {@link resolveWsUrl} applies, as a frozen record.
 *
 * A table rather than a chain of conditionals so the accepted set is readable in
 * one line, and `Record<string, string | undefined>` rather than a mapped type
 * over four literals because the key is `URL.protocol`, which is any string.
 */
const WS_SCHEME_BY_BASE_SCHEME: Readonly<Record<string, string | undefined>> = Object.freeze({
  'http:': 'ws:',
  'https:': 'wss:',
  'ws:': 'ws:',
  'wss:': 'wss:',
});

/**
 * Turns the service's base URL into the socket URL this client opens.
 *
 * `http:` becomes `ws:`, `https:` becomes `wss:`, an already-WebSocket scheme is
 * kept, and {@link WS_PATH} — the path `../http.ts` owns — is appended to the
 * authority. Any path, query or fragment in the base URL is dropped, exactly as
 * the HTTP client reduces its own base URL to an origin, so one configured value
 * (`debuggen.serviceUrl`, or `DEBUGGEN_HOST` and `DEBUGGEN_PORT`) can drive both
 * transports without either re-deriving the other's rules.
 *
 * It exists so that the three consumers — `apps/local-service/src/server/`,
 * `apps/vscode-extension/src/service/client.ts` and
 * `apps/chrome-extension/src/background/ws-bridge.ts` — do not each write the
 * scheme map and the path, which is precisely the kind of triplication this
 * package exists to prevent.
 *
 * **A failure is returned, not thrown.** A misconfigured service URL is a
 * developer-facing state the editor renders (AAP §0.5.5), not an exception an
 * extension activation has to guard, so every rejection is an `Err` carrying
 * `CONFIG_INVALID`. None of those messages quotes the URL: a base URL is
 * configuration, but it can carry embedded credentials, and AAP §0.5.2 keeps a
 * basic-auth URL out of logs and user interfaces. Credentials in the URL are
 * refused outright for the same reason — this service authenticates with a
 * bearer credential in the hello frame, so there is nothing for them to do
 * except leak.
 *
 * @param baseUrl The service's base URL, for example `http://127.0.0.1:43117`.
 * @returns `ok(url)` with the socket URL, or `err(error)` with
 * `CONFIG_INVALID`.
 *
 * @example
 * ```ts
 * const resolved = resolveWsUrl(config.serviceUrl);
 * if (!resolved.ok) {
 *   return view.showConfigurationError(resolved.error);
 * }
 * const client = new ReconnectingWsClient({ url: resolved.value, … });
 * ```
 */
export function resolveWsUrl(baseUrl: string): Result<string, DebuggenError> {
  const trimmed = baseUrl.trim();

  if (trimmed.length === 0) {
    return err(
      new DebuggenError('CONFIG_INVALID', 'The service base URL is empty', {
        hint: 'Set the service URL to the host and port the local service listens on, for example http://127.0.0.1:43117.',
      }),
    );
  }

  // `new URL` throws a `TypeError` whose message quotes the input, which is the
  // one thing that must not be forwarded — hence `tryCatch` and a constant
  // sentence rather than the caught error's own text.
  const parsed = tryCatch(() => new URL(trimmed), 'CONFIG_INVALID');

  if (isErr(parsed)) {
    return err(
      new DebuggenError('CONFIG_INVALID', 'The service base URL is not a valid absolute URL', {
        hint: 'Write the URL with a scheme, host and port, for example http://127.0.0.1:43117.',
      }),
    );
  }

  const url = parsed.value;
  const scheme = WS_SCHEME_BY_BASE_SCHEME[url.protocol];

  if (scheme === undefined) {
    return err(
      new DebuggenError('CONFIG_INVALID', 'The service base URL has an unsupported scheme', {
        hint: 'Use http, https, ws or wss; the local service listens over plain HTTP on a loopback address.',
      }),
    );
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return err(
      new DebuggenError('CONFIG_INVALID', 'The service base URL carries embedded credentials', {
        hint: 'Remove the user information from the URL: this client authenticates with a bearer credential in its first frame.',
      }),
    );
  }

  if (url.host.length === 0) {
    return err(
      new DebuggenError('CONFIG_INVALID', 'The service base URL names no host', {
        hint: 'Include the host and port, for example http://127.0.0.1:43117.',
      }),
    );
  }

  return ok(`${scheme}//${url.host}${WS_PATH}`);
}

// ---------------------------------------------------------------------------
// Section F — the client's own plumbing types, private to this module
// ---------------------------------------------------------------------------

/**
 * One frame waiting for a socket.
 *
 * The frame is stored **encoded**, and that is a semantic decision rather than
 * an optimisation: `createEnvelope` stamps the `id` and the `ts` at the moment
 * the event actually happened, which is the ordering the service's store and
 * every correlation step rely on (`../envelope.ts`). Encoding at enqueue time
 * freezes both; encoding at flush time would re-stamp a click that happened
 * thirty seconds before a suspended worker came back.
 *
 * The message type is retained beside it because the frame is opaque text by
 * then, and it is what {@link WsQueueDropDetail} reports — the one thing a
 * consumer needs to know about a frame that was dropped, and the only thing that
 * can be said about it without quoting a payload.
 */
interface QueuedFrame {
  /** The frame's message type, for reporting only. */
  readonly type: MessageType;
  /** The encoded frame, ready to write unchanged. */
  readonly frame: string;
}

/**
 * The four listeners attached to one socket, kept so every one can be removed.
 *
 * Held as a record rather than re-created at detach time because
 * `removeEventListener` matches on function identity: a fresh arrow would remove
 * nothing and leave a dead socket's listeners alive — which, in a service worker
 * that reconnects every thirty seconds, is a leak that compounds all day.
 */
interface SocketListeners {
  /** The `open` listener, which starts the handshake. */
  readonly open: () => void;
  /** The `message` listener, which decodes and dispatches. */
  readonly message: (event: WsMessageEventLike) => void;
  /** The `close` listener, which decides between terminal and reconnect. */
  readonly close: (event: WsCloseEventLike) => void;
  /** The `error` listener, which logs and waits for the close that follows. */
  readonly error: () => void;
}

/** The two states {@link ReconnectingWsClient} opens a socket in. */
type OpeningState = Extract<ConnectionState, 'connecting' | 'reconnecting'>;

/**
 * What resolving a credential produced.
 *
 * Three outcomes rather than `string | undefined`, because the two failures lead
 * to different words in the same user-interface state: a provider that answered
 * nothing is "not paired", and a provider that did not answer within
 * {@link CLIENT_HELLO_TIMEOUT_MS} is a slow credential store. Neither carries
 * what was resolved, or why the provider rejected — a rejection reason from a
 * credential store is exactly the kind of value AAP §0.5.2 keeps out of a
 * message.
 */
type TokenOutcome =
  | { readonly kind: 'resolved'; readonly token: string | undefined }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed' };

// ---------------------------------------------------------------------------
// Section G — the client
// ---------------------------------------------------------------------------

/**
 * A WebSocket client for the local service that authenticates itself, keeps
 * itself connected, and dispatches validated frames to typed subscribers.
 *
 * ```ts
 * const resolved = resolveWsUrl('http://127.0.0.1:43117');
 * if (!resolved.ok) return report(resolved.error);
 *
 * const client = new ReconnectingWsClient({
 *   url: resolved.value,
 *   webSocketConstructor: WebSocket,
 *   identity: { client: 'devtools', tabId },
 *   token: () => readPairedCredential(),
 *   onStateChange: (state) => pill.render(state),
 * });
 *
 * const stop = client.on('panel.generated', (message) => host.render(message.payload.panel));
 * client.connect();
 * client.send('session.bind', { tabId, url, origin });
 * ```
 *
 * ## The handshake, in the order it has to happen
 *
 * On every `open` event — the first one and every reconnect's — the credential
 * is resolved, a `client.hello` frame is built with {@link PROTOCOL_VERSION} and
 * validated against `clientHelloPayloadSchema`, and that frame is written
 * **before anything else**. Only once it is written does the client call itself
 * open, reset its backoff and flush whatever accumulated while it was away, in
 * the order it was handed over. A hello frame is never queued and never
 * replayed: each connection mints its own, so the `id`, the `ts` and the
 * credential are the current ones (AAP §0.5.6).
 *
 * The credential is resolved without a microtask when it is a string or a
 * synchronous provider, which is what makes "the hello frame is the first frame
 * sent" observable in the same turn as the `open` event. A provider that answers
 * a promise — the Chrome service worker reading `chrome.storage.local` — is
 * awaited under a deadline of {@link CLIENT_HELLO_TIMEOUT_MS}, so a stalled
 * credential store aborts the attempt locally instead of leaving the service to
 * close the socket on its own timer.
 *
 * ## What is terminal and what is not
 *
 * A close is retried with the backoff curve of {@link WsBackoff} unless it is
 * one of three things: a {@link WS_CLOSE_UNAUTHORIZED} refusal, a
 * {@link ReconnectingWsClient.close} from the owner, or a credential or identity
 * that could not be assembled at all. Each of those leaves the client `closed`
 * with nothing running, and {@link ReconnectingWsClient.connect} is the single
 * resume path — it clears the terminal state and re-resolves the credential
 * through the provider, which is how pairing again or rotating a token takes
 * effect without rebuilding the client.
 *
 * The outbound queue is kept across a {@link WS_CLOSE_UNAUTHORIZED} refusal and
 * cleared by an explicit `close()`. That asymmetry is deliberate: a refused credential is a problem the
 * developer is about to fix — pair, rotate, `connect()` — and the frames their
 * actions already produced are worth delivering afterwards, while `close()` is
 * the teardown path (the editor's `deactivate()`, the panel being disposed) and
 * leaving nothing behind is the whole point of it.
 *
 * ## Thread and re-entrancy safety
 *
 * Every runtime that loads this class is single-threaded, so there is no lock to
 * take; what does need care is re-entrancy, and three things provide it. A
 * generation counter bumped per attempt makes a stale socket's events and a
 * stale asynchronous handshake no-ops. A pending-reconnect handle makes the
 * `error`-then-`close` pair schedule one attempt rather than two. And while the
 * queue is draining, {@link ReconnectingWsClient.send} appends instead of
 * writing, so a consumer that sends from its own `onStateChange('open')` handler
 * cannot overtake frames that were waiting before it.
 *
 * No hook can break the client either: each is invoked inside a `try`, a
 * subscriber that throws is reported through
 * {@link ReconnectingWsClientOptions.onProtocolError} and the remaining
 * subscribers still run, and a reporter that throws in turn is logged and
 * dropped rather than allowed to unwind the transport.
 */
export class ReconnectingWsClient {
  /**
   * The socket URL this client opens, exactly as it was configured.
   *
   * Public because both user interfaces show which service they are talking to,
   * and neither should re-derive it. It is used verbatim: {@link resolveWsUrl} is
   * where a base URL becomes this value, so nothing is normalised here and a
   * consumer that passes an unusable URL learns it from the first attempt's
   * transport failure rather than from a constructor that threw.
   */
  readonly url: string;

  /** The injected socket implementation. */
  private readonly webSocketConstructor: WebSocketConstructorLike;

  /** Who this client announces itself as. */
  private readonly identity: WsClientIdentity;

  /** The credential, or the provider that resolves one per attempt. */
  private readonly tokenSource: string | TokenProvider;

  /** The subprotocols to request, forwarded only when configured. */
  private readonly protocols: string | string[] | undefined;

  /** The resolved reconnect curve. */
  private readonly backoff: WsBackoff;

  /** The outbound queue's bound, sanitised to a non-negative integer. */
  private readonly maxQueuedMessages: number;

  /** Where this client's `debug` records go. */
  private readonly logger: Logger;

  /** The timer pair: injected, or the platform functions wrapped per call. */
  private readonly timers: TimerApi;

  /** The randomness the jitter draws on. */
  private readonly random: () => number;

  /** See {@link ReconnectingWsClientOptions.onStateChange}. */
  private readonly onStateChange:
    ((state: ConnectionState, detail?: WsStateChangeDetail) => void) | undefined;

  /** See {@link ReconnectingWsClientOptions.onMessage}. */
  private readonly onMessage: ((message: ProtocolMessage) => void) | undefined;

  /** See {@link ReconnectingWsClientOptions.onProtocolError}. */
  private readonly onProtocolError: ((error: DebuggenError) => void) | undefined;

  /** See {@link ReconnectingWsClientOptions.onUnauthorized}. */
  private readonly onUnauthorized: ((detail: WsUnauthorizedDetail) => void) | undefined;

  /** See {@link ReconnectingWsClientOptions.onQueueDrop}. */
  private readonly onQueueDrop: ((detail: WsQueueDropDetail) => void) | undefined;

  /**
   * The subscriber sets, keyed by message type.
   *
   * A `Set` per type, so the same handler registered twice runs twice and
   * unsubscribing one leaves the other; a `Map` keyed by type, so dispatch is a
   * single lookup on the hot inbound path rather than a scan.
   */
  private readonly handlers = new Map<MessageType, Set<(message: ProtocolMessage) => void>>();

  /** The bounded FIFO queue of frames waiting for a socket. */
  private readonly queue: QueuedFrame[] = [];

  /** The state every getter, hook and decision below reads. */
  private connectionState: ConnectionState = 'closed';

  /** The live socket, or `undefined` when none is open. */
  private socket: WebSocketLike | undefined;

  /** The listeners attached to {@link ReconnectingWsClient.socket}. */
  private socketListeners: SocketListeners | undefined;

  /**
   * The attempt counter that makes a stale socket's work a no-op.
   *
   * Incremented before every socket is created and by `close()`. Every listener
   * and every asynchronous handshake step captures the value it was created
   * under and returns early if it no longer matches — which is what keeps a
   * socket that closed while its credential was being read from sending a hello
   * frame, and a replaced socket's `close` event from scheduling a second
   * reconnect.
   */
  private generation = 0;

  /** Reconnect attempts since the last hello frame was written. */
  private attempt = 0;

  /** The pending reconnect timer: also the "one attempt in flight" flag. */
  private reconnectHandle: number | undefined;

  /** Whether the next close must not be retried. */
  private terminal = false;

  /** Whether the queue is being flushed, during which `send` appends. */
  private draining = false;

  /** The last close code observed, or sent by `close()`. */
  private closeCode: number | undefined;

  /**
   * @param options The socket URL, the socket implementation, this client's
   * identity and its credential, plus the optional curve, bounds, logger,
   * injected timers, randomness and hooks.
   */
  constructor(options: ReconnectingWsClientOptions) {
    this.url = options.url;
    this.webSocketConstructor = options.webSocketConstructor;
    this.identity = options.identity;
    this.tokenSource = options.token;
    this.protocols = options.protocols;
    this.backoff = resolveBackoff(options.backoff);
    this.maxQueuedMessages = resolveQueueBound(options.maxQueuedMessages);
    this.logger = options.logger ?? noopLogger;
    // Resolved here rather than at module scope, and each member still reads its
    // global at call time, so importing this module performs no environment
    // lookup (`package.json` declares `sideEffects: false`).
    this.timers = options.timers ?? createPlatformTimers();
    this.random = options.random ?? Math.random;
    this.onStateChange = options.onStateChange;
    this.onMessage = options.onMessage;
    this.onProtocolError = options.onProtocolError;
    this.onUnauthorized = options.onUnauthorized;
    this.onQueueDrop = options.onQueueDrop;
  }

  /** The current connection state, as a user interface renders it. */
  get state(): ConnectionState {
    return this.connectionState;
  }

  /** How many frames are waiting for a socket. */
  get queuedCount(): number {
    return this.queue.length;
  }

  /**
   * The last close code seen on this client, or `undefined` if it has never
   * closed a connection.
   *
   * This is what separates the two `closed` clients of {@link CONNECTION_STATES}:
   * `undefined` for one that never connected, {@link WS_CLOSE_UNAUTHORIZED} for a
   * refused credential, and whatever was passed to
   * {@link ReconnectingWsClient.close} for a deliberate teardown.
   */
  get lastCloseCode(): number | undefined {
    return this.closeCode;
  }

  /**
   * Opens a connection, or resumes one this client stopped retrying.
   *
   * Idempotent while `connecting` or `open`: calling it from several places —
   * an extension activating, a view becoming visible, a command — costs nothing
   * and never opens a second socket. Called while `reconnecting`, it cancels the
   * pending delay and attempts immediately, which is what a developer pressing
   * "Reconnect" means.
   *
   * It also clears the terminal state a refusal left behind and re-resolves the
   * credential through the configured provider, so it is the resume path after
   * pairing again or rotating the service token (AAP §0.5.6).
   */
  connect(): void {
    if (this.connectionState === 'connecting' || this.connectionState === 'open') {
      return;
    }

    this.terminal = false;
    this.clearReconnectTimer();
    this.openSocket('connecting');
  }

  /**
   * Closes the connection and leaves nothing running.
   *
   * Removes every listener, cancels any pending reconnect, clears the outbound
   * queue, closes the socket and moves to `closed`; later
   * {@link ReconnectingWsClient.send} calls fail until
   * {@link ReconnectingWsClient.connect} is called again. Idempotent, so the
   * paths that have to be safe to run twice — the editor's `deactivate()`, a
   * panel teardown, a disposal list that also holds a subscription — can call it
   * without checking.
   *
   * @param code The close code to send. Defaults to `1000`, normal closure.
   * @param reason The close reason to send, where the caller has one worth
   * stating. It reaches the service's log, so it carries no credential and no
   * payload.
   */
  close(code?: number, reason?: string): void {
    const socket = this.socket;
    const wasIdle =
      this.connectionState === 'closed' &&
      socket === undefined &&
      this.reconnectHandle === undefined &&
      this.queue.length === 0;

    this.terminal = true;
    this.draining = false;
    this.clearReconnectTimer();
    this.queue.length = 0;
    // Invalidate anything still in flight — a pending asynchronous handshake in
    // particular — before the socket goes away.
    this.generation += 1;
    this.detachListeners();
    this.socket = undefined;

    if (socket !== undefined) {
      const closed = tryCatch(() => {
        socket.close(code ?? NORMAL_CLOSURE_CODE, reason);
      }, 'TRANSPORT_DISCONNECTED');

      if (isErr(closed)) {
        // A socket that refuses to close is already unusable; there is nothing
        // to recover and nothing about it worth reporting to a user interface.
        this.logger.debug('websocket close failed');
      }

      this.closeCode = code ?? NORMAL_CLOSURE_CODE;
    }

    if (wasIdle) {
      return;
    }

    this.setState('closed', buildCloseDetail(code ?? NORMAL_CLOSURE_CODE, reason));
  }

  /**
   * Sends one frame, writing it now or queueing it for the next connection.
   *
   * The payload type is resolved from the message type through the registry
   * `../envelope.ts` builds, so the wrong payload for a message is a compile
   * error rather than a frame the service rejects. Nothing is validated at run
   * time on this path: validation is the receiver's job, and paying for it here
   * would double the cost of the `telemetry.event` batches a capture produces.
   *
   * @typeParam K The message type, which fixes the payload type.
   * @param type The message to send.
   * @param payload That message's payload, as its domain module defines it.
   * @param options Optional overrides for the routing `sessionId`, the frame
   * `id` and the timestamp — the same options `createEnvelope` accepts.
   * @returns `ok('sent')` when the frame went to an open socket, `ok('queued')`
   * when it is held for the next one, or `err(error)` when this client is closed
   * or queueing is disabled and there is nowhere to put it.
   */
  send<K extends MessageType>(
    type: K,
    payload: MessagePayload<K>,
    options?: CreateEnvelopeOptions,
  ): Result<SendOutcome, DebuggenError> {
    if (this.connectionState === 'closed') {
      return err(
        new DebuggenError('TRANSPORT_DISCONNECTED', SEND_AFTER_CLOSE_MESSAGE, {
          hint: SEND_AFTER_CLOSE_HINT,
          details: { type },
        }),
      );
    }

    // Encoding is fallible in one narrow case: a payload is typed rather than
    // validated here, and a cyclic value inside a loosely-shaped attribute
    // record would make `JSON.stringify` throw on a method whose contract is
    // that it answers a `Result`.
    const encoded = tryCatch(
      () => encodeMessage(toProtocolFrame(type, payload, options)),
      'PROTOCOL_INVALID_MESSAGE',
    );

    if (isErr(encoded)) {
      return err(encoded.error);
    }

    const socket = this.socket;

    if (
      !this.draining &&
      this.connectionState === 'open' &&
      socket !== undefined &&
      socket.readyState === WEBSOCKET_OPEN_READY_STATE
    ) {
      const written = this.writeFrame(socket, encoded.value);

      if (!isErr(written)) {
        return ok('sent');
      }

      // The socket died between the state check and the write. Report it and
      // fall through to the queue: the close event that follows will reconnect,
      // and the frame is then flushed in order.
      this.reportProtocolError(written.error);
    }

    return this.enqueue({ type, frame: encoded.value })
      ? ok('queued')
      : err(
          new DebuggenError('TRANSPORT_DISCONNECTED', QUEUE_DISABLED_MESSAGE, {
            hint: QUEUE_DISABLED_HINT,
            details: { type },
          }),
        );
  }

  /**
   * Subscribes to one message type.
   *
   * The handler receives the frame already validated and already narrowed, so
   * `message.payload` is that message's payload with no cast — see
   * {@link MessageHandler}. Several handlers may subscribe to one type and each
   * runs on its own: dispatch iterates a snapshot of the set, so a handler that
   * unsubscribes (or subscribes) while it runs cannot disturb the others, and a
   * handler that throws is reported through
   * {@link ReconnectingWsClientOptions.onProtocolError} while the rest still
   * run.
   *
   * @typeParam K The message type to subscribe to.
   * @param type The message type.
   * @param handler What to do with each frame of that type.
   * @returns A function that removes this subscription. Calling it twice is
   * harmless.
   *
   * @example
   * ```ts
   * const stop = client.on('session.progress', ({ payload }) => {
   *   view.appendProgress(payload.stage, payload.message);
   * });
   * context.subscriptions.push({ dispose: stop });
   * ```
   */
  on<K extends MessageType>(type: K, handler: MessageHandler<K>): Unsubscribe {
    // The guard is what makes the narrowing sound without a cast: it is the
    // predicate `../envelope.ts` exports for exactly this dispatch, and it
    // resolves the frame to the union member whose discriminant is `type`.
    const dispatch = (message: ProtocolMessage): void => {
      if (isMessageOfType(message, type)) {
        handler(message);
      }
    };

    const registered = this.handlers.get(type) ?? new Set<(message: ProtocolMessage) => void>();
    registered.add(dispatch);
    this.handlers.set(type, registered);

    return () => {
      const current = this.handlers.get(type);

      if (current === undefined) {
        return;
      }

      current.delete(dispatch);

      if (current.size === 0) {
        this.handlers.delete(type);
      }
    };
  }

  // -------------------------------------------------------------------------
  // The socket's life cycle
  // -------------------------------------------------------------------------

  /**
   * Creates a socket and attaches this attempt's listeners to it.
   *
   * A constructor that throws — an unusable URL, a runtime that refuses the
   * scheme — is an attempt that failed rather than an exception a consumer has
   * to catch, so it is reported and retried on the curve like any other failure.
   *
   * @param nextState `'connecting'` for an explicit connect, `'reconnecting'`
   * for an attempt on the curve. Notifying is left to {@link setState}, which
   * stays silent when the state has not actually changed.
   */
  private openSocket(nextState: OpeningState): void {
    this.generation += 1;
    const generation = this.generation;

    this.setState(nextState);

    const created = tryCatch(
      () =>
        this.protocols === undefined
          ? new this.webSocketConstructor(this.url)
          : new this.webSocketConstructor(this.url, this.protocols),
      'TRANSPORT_DISCONNECTED',
    );

    if (isErr(created)) {
      this.reportProtocolError(created.error);
      this.scheduleReconnect(undefined, SOCKET_OPEN_FAILED_REASON);
      return;
    }

    const socket = created.value;
    this.socket = socket;
    this.attachListeners(socket, generation);
  }

  /**
   * Attaches the four listeners this client uses, keeping their identities so
   * {@link detachListeners} can remove exactly them.
   *
   * Each listener captures the generation it was created under and does nothing
   * once that value is stale, which is what makes a replaced socket's late
   * events harmless.
   */
  private attachListeners(socket: WebSocketLike, generation: number): void {
    const listeners: SocketListeners = {
      open: () => {
        this.handleOpen(socket, generation);
      },
      message: (event) => {
        this.handleMessage(event, generation);
      },
      close: (event) => {
        this.handleClose(event, generation);
      },
      error: () => {
        this.handleTransportError(generation);
      },
    };

    socket.addEventListener('open', listeners.open);
    socket.addEventListener('message', listeners.message);
    socket.addEventListener('close', listeners.close);
    socket.addEventListener('error', listeners.error);

    this.socketListeners = listeners;
  }

  /** Removes every listener attached by {@link attachListeners}. */
  private detachListeners(): void {
    const socket = this.socket;
    const listeners = this.socketListeners;

    this.socketListeners = undefined;

    if (socket === undefined || listeners === undefined) {
      return;
    }

    // A `removeEventListener` that throws must not prevent the other three:
    // whatever the state of this socket, the client is done with it.
    const removed = tryCatch(() => {
      socket.removeEventListener('open', listeners.open);
      socket.removeEventListener('message', listeners.message);
      socket.removeEventListener('close', listeners.close);
      socket.removeEventListener('error', listeners.error);
    }, 'TRANSPORT_DISCONNECTED');

    if (isErr(removed)) {
      this.logger.debug('websocket listener removal failed');
    }
  }

  // -------------------------------------------------------------------------
  // The `client.hello` handshake
  // -------------------------------------------------------------------------

  /**
   * Starts the handshake: resolves the credential, then writes the hello frame.
   *
   * A string credential and a synchronous provider are handled without a
   * microtask, so the hello frame is written in the same turn as the `open`
   * event. Only a provider that answers a promise defers, and then under the
   * deadline of {@link CLIENT_HELLO_TIMEOUT_MS}.
   */
  private handleOpen(socket: WebSocketLike, generation: number): void {
    if (generation !== this.generation) {
      return;
    }

    const source = this.tokenSource;

    if (typeof source === 'string') {
      this.completeHandshake(socket, generation, source);
      return;
    }

    const produced = tryCatch(() => source(), 'UNAUTHORIZED');

    if (isErr(produced)) {
      // A provider that throws is a credential that cannot be read. Its own
      // message may name a storage key or quote a value, so it is logged at
      // debug by the reporter and never forwarded to the refusal.
      this.reportProtocolError(produced.error);
      this.refuseUnauthorized(socket, NO_CREDENTIAL_REASON);
      return;
    }

    const value = produced.value;

    if (typeof value === 'string' || value === undefined) {
      this.completeHandshake(socket, generation, value);
      return;
    }

    void this.completeHandshakeWhenResolved(socket, generation, value);
  }

  /**
   * Awaits an asynchronous credential under the handshake deadline and then
   * completes — or abandons — the attempt.
   *
   * Bounding the wait locally matters because the alternative is being closed by
   * the service's own {@link CLIENT_HELLO_TIMEOUT_MS} deadline with
   * {@link WS_CLOSE_UNAUTHORIZED}, which this client treats as terminal: a slow
   * credential store would then look exactly like a refused credential and stop
   * the client from ever retrying.
   */
  private async completeHandshakeWhenResolved(
    socket: WebSocketLike,
    generation: number,
    pending: Promise<string | undefined>,
  ): Promise<void> {
    const outcome = await this.resolveTokenWithDeadline(pending);

    if (generation !== this.generation) {
      // The socket was replaced or the client was closed while the credential
      // was being read. Nothing to send, and nothing to report.
      return;
    }

    if (outcome.kind === 'resolved') {
      this.completeHandshake(socket, generation, outcome.token);
      return;
    }

    this.refuseUnauthorized(
      socket,
      outcome.kind === 'timeout' ? CREDENTIAL_TIMEOUT_REASON : NO_CREDENTIAL_REASON,
    );
  }

  /**
   * Races a credential promise against the handshake deadline.
   *
   * The timer comes from the injected {@link TimerApi}, so a test controls this
   * deadline exactly as it controls the backoff curve, and it is cleared on
   * every path so a resolved attempt leaves no timer behind.
   */
  private async resolveTokenWithDeadline(
    pending: Promise<string | undefined>,
  ): Promise<TokenOutcome> {
    let handle: number | undefined;

    const deadline = new Promise<TokenOutcome>((resolve) => {
      handle = this.timers.setTimeout(() => {
        resolve({ kind: 'timeout' });
      }, CLIENT_HELLO_TIMEOUT_MS);
    });

    const settled = pending.then(
      (token): TokenOutcome => ({ kind: 'resolved', token }),
      (): TokenOutcome => ({ kind: 'failed' }),
    );

    const outcome = await Promise.race([settled, deadline]);

    if (handle !== undefined) {
      this.timers.clearTimeout(handle);
    }

    return outcome;
  }

  /**
   * Builds, validates and writes the hello frame, then opens the client.
   *
   * The order is the mandated one and every step is a gate on the next: no
   * credential means no frame is written at all; a payload that fails its own
   * schema means the same; and the client calls itself `open` only after the
   * frame is on the wire, which is what stops a consumer sending from its
   * `onStateChange('open')` handler before the service knows who it is talking
   * to.
   */
  private completeHandshake(
    socket: WebSocketLike,
    generation: number,
    token: string | undefined,
  ): void {
    if (generation !== this.generation) {
      return;
    }

    if (token === undefined || token.length === 0) {
      this.refuseUnauthorized(socket, NO_CREDENTIAL_REASON);
      return;
    }

    // Assembled as a mutable local: under `exactOptionalPropertyTypes` an absent
    // project root or tab id has to be an absent *key*, never a key holding
    // `undefined`, and the hello schema is strict.
    const payload: {
      client: ClientKind;
      projectRoot?: string;
      tabId?: number;
      version: string;
      token: string;
    } = {
      client: this.identity.client,
      version: PROTOCOL_VERSION,
      token,
    };

    if (this.identity.projectRoot !== undefined) {
      payload.projectRoot = this.identity.projectRoot;
    }

    if (this.identity.tabId !== undefined) {
      payload.tabId = this.identity.tabId;
    }

    const parsed = clientHelloPayloadSchema.safeParse(payload);

    if (!parsed.success) {
      // Built by `protocolParseError`, whose message and details come from issue
      // paths and codes alone — which is what makes it impossible for the
      // credential in the rejected payload to reach a log or a user interface
      // (AAP §0.5.2).
      this.reportProtocolError(
        protocolParseError(
          'PROTOCOL_INVALID_MESSAGE',
          INVALID_HELLO_PREFIX,
          parsed.error.issues,
          INVALID_HELLO_HINT,
        ),
      );
      this.terminate(socket, INVALID_HELLO_REASON);
      return;
    }

    const encoded = tryCatch(
      () => encodeMessage(toProtocolFrame('client.hello', parsed.data)),
      'PROTOCOL_INVALID_MESSAGE',
    );

    if (isErr(encoded)) {
      this.reportProtocolError(encoded.error);
      this.terminate(socket, INVALID_HELLO_REASON);
      return;
    }

    const written = this.writeFrame(socket, encoded.value);

    if (isErr(written)) {
      // The socket died before its first frame: a failed attempt, not a refusal.
      this.reportProtocolError(written.error);
      this.detachListeners();
      this.socket = undefined;
      this.scheduleReconnect(undefined, HELLO_WRITE_FAILED_REASON);
      return;
    }

    this.attempt = 0;
    this.logger.debug('websocket handshake sent', { client: this.identity.client });

    // `draining` is raised before the state hook runs, so a consumer that sends
    // from `onStateChange('open')` appends to the queue instead of overtaking
    // frames that were already waiting. `flushQueue` lowers it again.
    this.draining = true;
    this.setState('open');
    this.flushQueue(socket);
  }

  // -------------------------------------------------------------------------
  // Inbound frames
  // -------------------------------------------------------------------------

  /**
   * Decodes one inbound frame and dispatches it.
   *
   * A frame that cannot be decoded — binary data, text that is not JSON, JSON
   * that is not a valid envelope — is reported and dropped. It never reaches a
   * typed handler, never throws, and never closes the socket: a producer that
   * sent one malformed frame is not a reason to lose a session (AAP §0.5.5).
   */
  private handleMessage(event: WsMessageEventLike, generation: number): void {
    if (generation !== this.generation) {
      return;
    }

    const text = coerceFrameText(event.data);

    if (isErr(text)) {
      this.reportProtocolError(text.error);
      return;
    }

    const decoded = decodeMessage(text.value);

    if (isErr(decoded)) {
      this.reportProtocolError(decoded.error);
      return;
    }

    const message = decoded.value;

    this.safeInvoke(() => {
      this.onMessage?.(message);
    });

    const registered = this.handlers.get(message.type);

    if (registered === undefined) {
      return;
    }

    // A snapshot, so a handler that subscribes or unsubscribes while it runs
    // cannot disturb this iteration.
    for (const handler of [...registered]) {
      try {
        handler(message);
      } catch (thrown) {
        this.reportProtocolError(DebuggenError.from(thrown, 'INTERNAL'));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Closing, failing and reconnecting
  // -------------------------------------------------------------------------

  /**
   * Handles a close event: terminal for a refused credential, retried otherwise.
   */
  private handleClose(event: WsCloseEventLike, generation: number): void {
    if (generation !== this.generation) {
      return;
    }

    this.closeCode = event.code;
    this.detachListeners();
    this.socket = undefined;
    this.draining = false;

    this.logger.debug('websocket closed', { code: event.code });

    if (event.code === WS_CLOSE_UNAUTHORIZED) {
      // Terminal for this credential. The queue is kept: the developer is about
      // to pair or rotate, and `connect()` then delivers what they already did.
      this.terminal = true;
      const reason = event.reason.length > 0 ? event.reason : REFUSED_CREDENTIAL_REASON;
      this.setState('closed', buildCloseDetail(event.code, reason));
      this.notifyUnauthorized({ code: event.code, reason });
      return;
    }

    if (this.terminal) {
      this.setState('closed', buildCloseDetail(event.code, event.reason));
      return;
    }

    this.scheduleReconnect(event.code, event.reason);
  }

  /**
   * Handles a transport error.
   *
   * Logged at `debug` with nothing but the fact of it — no payload, no URL, no
   * credential — and deliberately not acted upon: every implementation this
   * client supports follows an `error` with a `close`, and that is where the one
   * reconnect is scheduled. The pending-reconnect handle guards the case anyway.
   */
  private handleTransportError(generation: number): void {
    if (generation !== this.generation) {
      return;
    }

    this.logger.debug('websocket transport error');
  }

  /**
   * Refuses the connection locally: closes the socket, reports the refusal and
   * schedules nothing.
   *
   * Reached when no credential could be resolved or the provider stalled. The
   * code reported is {@link WS_CLOSE_UNAUTHORIZED} even though the service never
   * saw the attempt, because the situation and the remedy are the same ones
   * (AAP §0.5.6), while the socket itself is closed with a normal-closure code.
   */
  private refuseUnauthorized(socket: WebSocketLike, reason: string): void {
    this.terminate(socket, reason);
    this.notifyUnauthorized({ code: WS_CLOSE_UNAUTHORIZED, reason });
  }

  /**
   * Ends the attempt without scheduling another: the socket is closed, the
   * client is `closed`, and only {@link connect} revives it.
   */
  private terminate(socket: WebSocketLike, reason: string): void {
    this.terminal = true;
    this.draining = false;
    this.clearReconnectTimer();
    this.detachListeners();
    this.socket = undefined;

    const closed = tryCatch(() => {
      socket.close(NORMAL_CLOSURE_CODE, reason);
    }, 'TRANSPORT_DISCONNECTED');

    if (isErr(closed)) {
      this.logger.debug('websocket close failed');
    }

    this.setState('closed', buildCloseDetail(NORMAL_CLOSURE_CODE, reason));
  }

  /**
   * Schedules the next attempt on the curve, unless one is already pending.
   *
   * The handle doubles as the "one attempt in flight" flag, which is what keeps
   * an `error`-then-`close` pair — or a close that arrives while a delay is
   * running — from scheduling two sockets for one failure.
   */
  private scheduleReconnect(code: number | undefined, reason: string): void {
    if (this.reconnectHandle !== undefined) {
      return;
    }

    this.attempt += 1;
    const attempt = this.attempt;
    const delayMs = computeBackoffDelay(this.backoff, attempt, this.random);

    this.logger.debug('websocket reconnect scheduled', { attempt, delayMs });

    this.reconnectHandle = this.timers.setTimeout(() => {
      this.reconnectHandle = undefined;

      if (this.terminal) {
        return;
      }

      this.openSocket('reconnecting');
    }, delayMs);

    this.setState(
      'reconnecting',
      code === undefined ? { attempt, delayMs, reason } : { attempt, delayMs, code, reason },
    );
  }

  /** Cancels a pending reconnect, if there is one. */
  private clearReconnectTimer(): void {
    const handle = this.reconnectHandle;

    if (handle === undefined) {
      return;
    }

    this.reconnectHandle = undefined;
    this.timers.clearTimeout(handle);
  }

  // -------------------------------------------------------------------------
  // The outbound queue
  // -------------------------------------------------------------------------

  /**
   * Writes queued frames, oldest first, until the queue is empty or the socket
   * stops accepting them.
   *
   * A frame that could not be written stays at the head of the queue, so the
   * close event that follows reconnects and the flush resumes in the same order.
   */
  private flushQueue(socket: WebSocketLike): void {
    try {
      while (this.queue.length > 0) {
        if (socket !== this.socket || socket.readyState !== WEBSOCKET_OPEN_READY_STATE) {
          return;
        }

        const next = this.queue[0];

        if (next === undefined) {
          return;
        }

        const written = this.writeFrame(socket, next.frame);

        if (isErr(written)) {
          this.reportProtocolError(written.error);
          return;
        }

        this.queue.shift();
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Appends a frame to the bounded queue, dropping the oldest to stay inside the
   * bound.
   *
   * @returns `true` when the frame is held, `false` when queueing is disabled
   * (`maxQueuedMessages: 0`) and it was dropped immediately.
   */
  private enqueue(entry: QueuedFrame): boolean {
    if (this.maxQueuedMessages === 0) {
      this.notifyQueueDrop({ type: entry.type, queued: 0 });
      return false;
    }

    this.queue.push(entry);

    while (this.queue.length > this.maxQueuedMessages) {
      const dropped = this.queue.shift();

      if (dropped === undefined) {
        return true;
      }

      this.logger.debug(QUEUE_OVERFLOW_MESSAGE, {
        type: dropped.type,
        queued: this.queue.length,
      });
      this.notifyQueueDrop({ type: dropped.type, queued: this.queue.length });
    }

    return true;
  }

  /** Writes one already-encoded frame, turning a throw into a `Result`. */
  private writeFrame(socket: WebSocketLike, frame: string): Result<undefined, DebuggenError> {
    const written = tryCatch(() => {
      socket.send(frame);
    }, 'TRANSPORT_DISCONNECTED');

    return isErr(written) ? err(written.error) : ok(undefined);
  }

  // -------------------------------------------------------------------------
  // State and hooks
  // -------------------------------------------------------------------------

  /**
   * Moves to a state and notifies the consumer.
   *
   * The hook fires when the state actually changed, and also when a detail is
   * supplied for a state the client is already in — which is what lets a second
   * and third reconnect attempt report their own attempt number and delay
   * without inventing a state for each.
   */
  private setState(next: ConnectionState, detail?: WsStateChangeDetail): void {
    const changed = this.connectionState !== next;
    this.connectionState = next;

    if (!changed && detail === undefined) {
      return;
    }

    this.safeInvoke(() => {
      if (detail === undefined) {
        this.onStateChange?.(next);
        return;
      }

      this.onStateChange?.(next, detail);
    });
  }

  /** Reports a failure to the consumer, and to the log if it has nowhere else. */
  private reportProtocolError(error: DebuggenError): void {
    this.logger.debug('websocket client error', { code: error.code });

    this.safeInvoke(() => {
      this.onProtocolError?.(error);
    });
  }

  /** Reports a refused or missing credential. */
  private notifyUnauthorized(detail: WsUnauthorizedDetail): void {
    this.safeInvoke(() => {
      this.onUnauthorized?.(detail);
    });
  }

  /** Reports a dropped frame. */
  private notifyQueueDrop(detail: WsQueueDropDetail): void {
    this.safeInvoke(() => {
      this.onQueueDrop?.(detail);
    });
  }

  /**
   * Runs a consumer hook without letting it unwind the transport.
   *
   * A hook that throws is a bug in the consumer, and the socket is not the place
   * to pay for it: in the MV3 service worker an unhandled exception on an event
   * listener takes the worker down and the panel's connection with it. The
   * failure is logged with its code alone — routing it to
   * {@link ReconnectingWsClientOptions.onProtocolError} would risk the same
   * throw a second time, since that hook is itself invoked through here.
   */
  private safeInvoke(hook: () => void): void {
    const invoked = tryCatch(hook, 'INTERNAL');

    if (isErr(invoked)) {
      this.logger.debug('websocket client hook failed', { code: invoked.error.code });
    }
  }
}

// ---------------------------------------------------------------------------
// Section H — module-private helpers
// ---------------------------------------------------------------------------

/**
 * Builds a frame and widens it to {@link ProtocolMessage}.
 *
 * The one type assertion in this file, and it is isolated here so that it can be
 * explained once. `createEnvelope` answers `MessageByType<K>`, which for every
 * *concrete* message type is precisely one member of the `ProtocolMessage`
 * union — it is the type that union was built from (`../envelope.ts`). What the
 * compiler cannot do is see that for an **unresolved** `K`: relating
 * `Envelope<K, MessagePayload<K>>` to the union would require distributing `K`
 * first, which is the same limitation `isMessageOfType` works around by
 * declaring its predicate as `Extract<ProtocolMessage, { type: K }>`. There is
 * no cast-free spelling on this side, because the value flows *into* a
 * union-typed parameter rather than out of a narrowing.
 *
 * It is sound by construction, not by inspection: the payload type is resolved
 * from the registry for the `type` given, so the only frames that reach here are
 * ones a concrete instantiation would have produced. `encodeMessage` — the sole
 * consumer — then reads nothing but the object's own fields.
 *
 * @typeParam K The message type.
 * @param type The message being sent.
 * @param payload That message's payload.
 * @param options Optional routing, id and timestamp overrides.
 * @returns The frame, typed as a member of the union.
 */
function toProtocolFrame<K extends MessageType>(
  type: K,
  payload: MessagePayload<K>,
  options?: CreateEnvelopeOptions,
): ProtocolMessage {
  return createEnvelope(type, payload, options) as ProtocolMessage;
}

/**
 * Coerces a transport's `data` to the text {@link decodeMessage} expects.
 *
 * Three cases, and the third is the one that matters. A **string** is the normal
 * shape and is used unchanged. An **`ArrayBuffer` or a view over one** — which is
 * how `ws` delivers a binary frame, and a `Buffer` is such a view — is decoded
 * as UTF-8 where the runtime provides `TextDecoder`, so a producer that wrote
 * its JSON as bytes is understood rather than rejected. **Anything else** is
 * reported and dropped: passing it to `String(…)` would turn an object into
 * `[object Object]` and a parse failure nobody can explain, and this protocol
 * carries no binary message that could legitimately arrive some other way
 * (`../envelope.ts`).
 *
 * The failure never quotes the data. A frame that arrived in an unexpected shape
 * is unvalidated input from another process, and it routinely carries exactly
 * what the privacy model protects (AAP §0.5.2).
 *
 * @param data The transport's `data` field.
 * @returns `ok(text)`, or `err(error)` with `PROTOCOL_INVALID_MESSAGE`.
 */
function coerceFrameText(data: unknown): Result<string, DebuggenError> {
  if (typeof data === 'string') {
    return ok(data);
  }

  const isBinary = data instanceof ArrayBuffer || ArrayBuffer.isView(data);

  if (!isBinary) {
    return err(
      new DebuggenError('PROTOCOL_INVALID_MESSAGE', UNSUPPORTED_FRAME_MESSAGE, {
        hint: UNSUPPORTED_FRAME_HINT,
      }),
    );
  }

  if (typeof TextDecoder === 'undefined') {
    return err(
      new DebuggenError('PROTOCOL_INVALID_MESSAGE', NO_DECODER_MESSAGE, {
        hint: UNSUPPORTED_FRAME_HINT,
      }),
    );
  }

  // `fatal: true` so invalid UTF-8 is a reported failure rather than a string of
  // replacement characters that fails JSON parsing for an unrelated-looking
  // reason. The decoder is created per frame: binary frames are not part of this
  // protocol, so this path is an exception rather than a hot one.
  return tryCatch(
    () => new TextDecoder('utf-8', { fatal: true }).decode(data),
    'PROTOCOL_INVALID_MESSAGE',
  );
}

/**
 * Resolves the backoff curve from a consumer's overrides, sanitising each field.
 *
 * Sanitising rather than trusting, because these numbers drive a timer: a
 * negative or non-finite delay would either fire immediately in a loop or never
 * fire at all, and both look like the client is broken rather than like the
 * configuration is. Each field falls back to {@link DEFAULT_WS_BACKOFF} when it
 * is absent or unusable, `maxMs` is never below `initialMs`, `factor` is never
 * below `1` (which would shrink the delay with each attempt) and `jitter` is
 * clamped to the unit interval.
 */
function resolveBackoff(overrides: WsBackoffOptions | undefined): WsBackoff {
  const initialMs = finiteOrDefault(overrides?.initialMs, DEFAULT_WS_BACKOFF.initialMs, 0);
  const maxMs = Math.max(initialMs, finiteOrDefault(overrides?.maxMs, DEFAULT_WS_BACKOFF.maxMs, 0));
  const factor = Math.max(1, finiteOrDefault(overrides?.factor, DEFAULT_WS_BACKOFF.factor, 1));
  const jitter = clampToUnitInterval(
    finiteOrDefault(overrides?.jitter, DEFAULT_WS_BACKOFF.jitter, 0),
  );

  return { initialMs, maxMs, factor, jitter };
}

/**
 * Resolves the queue bound: a non-negative integer, defaulting to
 * {@link DEFAULT_MAX_QUEUED_MESSAGES}.
 *
 * `0` is a meaningful value — "never queue, tell me instead" — so it is kept
 * rather than treated as unset, which is why the default applies only to an
 * absent or unusable value.
 */
function resolveQueueBound(configured: number | undefined): number {
  if (configured === undefined || !Number.isFinite(configured)) {
    return DEFAULT_MAX_QUEUED_MESSAGES;
  }

  return Math.max(0, Math.floor(configured));
}

/**
 * The delay before reconnect attempt `attempt`, in milliseconds.
 *
 * `min(initialMs * factor^(attempt - 1), maxMs)` gives the nominal curve — with
 * the defaults, 500, 1 000, 2 000, 4 000, 8 000, 10 000, 10 000 … — and **equal
 * jitter** is applied on top: `nominal * (1 - jitter + jitter * random())`. At
 * the default `jitter` of `0.5` a delay is therefore drawn from the upper half of
 * its nominal value, an injected `random: () => 1` reproduces the nominal
 * sequence exactly, and `() => 0` halves it.
 *
 * Pure, and defensive about the randomness it is given: a source that answers
 * `NaN`, a negative number or something above `1` is treated as `1`, which
 * degrades to the nominal curve rather than to an immediate retry loop.
 *
 * @param backoff The resolved curve.
 * @param attempt The 1-based attempt number.
 * @param random The randomness source.
 * @returns A non-negative integer delay in milliseconds.
 */
function computeBackoffDelay(backoff: WsBackoff, attempt: number, random: () => number): number {
  const exponent = Math.max(0, attempt - 1);
  const nominal = Math.min(backoff.initialMs * backoff.factor ** exponent, backoff.maxMs);
  const sampled = tryCatch(() => random(), 'INTERNAL');
  const sample = isErr(sampled) ? 1 : clampToUnitInterval(finiteOrDefault(sampled.value, 1, 0));
  const jittered = nominal * (1 - backoff.jitter + backoff.jitter * sample);

  return Math.max(0, Math.round(jittered));
}

/**
 * Builds the {@link WsStateChangeDetail} of a close, omitting an absent reason.
 *
 * An absent key rather than a key holding `undefined`, because
 * `exactOptionalPropertyTypes` makes the distinction real and a consumer that
 * checks `'reason' in detail` should get the honest answer.
 */
function buildCloseDetail(code: number, reason: string | undefined): WsStateChangeDetail {
  return reason === undefined || reason.length === 0 ? { code } : { code, reason };
}

/**
 * The platform timer pair, wrapped so each global is read at call time.
 *
 * Reading at call time rather than at construction keeps importing this module
 * free of any environment lookup, and lets a runtime that replaces its timers —
 * a test harness with fake timers installed after construction — still be
 * observed.
 */
function createPlatformTimers(): TimerApi {
  return {
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle);
    },
  };
}

/** A finite number, or `fallback` when the value is absent or unusable. */
function finiteOrDefault(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value) || value < minimum) {
    return fallback;
  }

  return value;
}

/** Clamps a number into `[0, 1]`. */
function clampToUnitInterval(value: number): number {
  return Math.min(1, Math.max(0, value));
}
