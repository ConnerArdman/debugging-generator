/**
 * The WebSocket surface of the local service: the upgrade gate, the
 * `client.hello` handshake and the router every inbound frame passes through
 * (AAP §0.4.2 — the transport column of the message table; §0.5.6 — the hello
 * handshake, the origin policy and role binding; §0.5.5 — the Chrome-disconnect
 * and page-reload rows; §0.2.3 — the envelope contract and tab/session binding).
 *
 * The VS Code extension host, the Chrome MV3 service worker (which also relays
 * the MAIN-world page agent's frames) and the dev server's Node preload each
 * hold one socket to this service. Every frame they send lands here first, and
 * every push the service makes leaves through `./clients.ts`, which this module
 * registers sockets with and never bypasses.
 *
 * ## One server, two protocols
 *
 * `main.ts` owns the single `node:http` server. This module never listens on a
 * port of its own: the `ws` server is constructed with `noServer: true` and the
 * HTTP server's `upgrade` event is routed to {@link WsServer.handleUpgrade}
 * (directly, or through {@link WsServer.attach}). Gating the upgrade here is
 * what lets the origin check run **before a WebSocket exists**. `ws` is
 * imported by this file and by no other file of the workspace.
 *
 * ## The contract a client is built against
 *
 * The client halves — `packages/protocol/src/client/ws-client.ts`, the Chrome
 * `background/ws-bridge.ts` and the VS Code service client — rely on exactly the
 * behaviour below, so it is stated once, here.
 *
 * **Upgrade.** Only a request for protocol's `WS_PATH` is upgraded (a query
 * string is ignored). The upgrade is refused with a bare HTTP response and the
 * TCP socket destroyed — no WebSocket is ever created — when:
 *
 * | Condition | HTTP status |
 * | --- | --- |
 * | the path is not `WS_PATH` | 404 |
 * | the `Origin` header is refused by `./auth.ts`'s `isAllowedOrigin` (every `http:`/`https:` web origin, `file:`, `data:`, `null`, anything unparseable) | 403 |
 * | the server is closing | 503 |
 *
 * **Handshake.** The first frame on a new socket must be a `client.hello`
 * carrying the credential, and it must arrive within protocol's
 * `CLIENT_HELLO_TIMEOUT_MS`. The hello is authenticated by
 * `AuthService.authorizeHello` (shape, protocol version, origin, credential,
 * and the claims the hello makes against the credential's role and scope). The
 * first frame always ends the handshake: it either authenticates the
 * connection or closes it. No `error` frame is ever sent before a connection is
 * authenticated, and nothing is acknowledged on success — the connection simply
 * stays open and starts receiving the frames its principal is entitled to.
 *
 * | Close code | Reason (constant text, never client data) | Client should |
 * | --- | --- | --- |
 * | `WS_CLOSE_UNAUTHORIZED` | no hello in time; a first frame that is not a valid hello; an unsupported protocol version (the reason names the version this service speaks); a refused origin; a refused credential; hello claims that contradict the credential | treat as terminal: pair again, rotate, or update the extension — never retry blindly |
 * | 1011 (internal error) | the credential could not be checked (for example a store failure) | retry with backoff |
 * | `WS_CLOSE_TRY_AGAIN_LATER` (1013) | too many open connections, or too many unprocessed frames on this connection | retry with backoff |
 * | `WS_CLOSE_GOING_AWAY` (1001) | the service is shutting down | retry with backoff |
 *
 * **After the handshake.** Frames are processed strictly in arrival order per
 * connection. A frame that cannot be decoded, names an unknown or HTTP-only
 * type, fails validation (including a `telemetry.event` batch above protocol's
 * per-batch bound, which the batch schema enforces), is not permitted for the
 * connection's principal, or fails in its handler is answered with protocol's
 * `error` message — `{ code, message, ref? }`, where `ref` is the offending
 * frame's `id` whenever one could be read — **and the connection stays open**.
 * One bad frame never closes a socket and never takes the process down. The
 * single exception is an inbound `error` frame, which is logged and dropped
 * rather than answered, so that two peers that each answer errors with errors
 * cannot loop.
 *
 * **Liveness.** The service pings every authenticated connection on an
 * interval (15 s by default — well inside the 30 s heartbeat staleness window
 * the preload-bound readiness adapters apply, and far from the MV3 service
 * worker's own `chrome.alarms` keepalive). Every pong and every frame refreshes
 * the connection's `lastSeenAt` in the registry, which is the server agent's
 * heartbeat for readiness; a connection that misses a whole interval is
 * terminated.
 *
 * **Disconnects are routine.** A closed socket's registration is marked
 * offline in the client registry — frames addressed to it are dropped, its
 * sessions and bindings are kept — and it is unregistered once it has stayed
 * offline for the registry's offline grace period (`DEFAULT_OFFLINE_GRACE_MS`
 * by default). Nothing else changes: the session, its tab binding (which
 * belongs to the credential, not to the socket) and any open capture survive,
 * because the MV3 service worker suspends after about 30 s of idleness and
 * reconnects with backoff (AAP §0.5.5). A reconnect presenting the same
 * credential registers a new, online connection that carries the binding's
 * traffic again without a re-bind. Ordinary disconnects are logged at debug.
 *
 * ## Authority comes from the principal, never from the frame
 *
 * After the hello, a connection's identity is the `Principal` `./auth.ts`
 * resolved from the stored credential. The hello's `client`, `projectRoot` and
 * `tabId` are kept only as facts about the connection. The rules of AAP §0.5.6
 * are applied through `./auth.ts`'s `requireRole` and `requireBoundSession`,
 * never re-derived:
 *
 * | Inbound message | Who may send it | Routed to |
 * | --- | --- | --- |
 * | `client.hello` | the first frame of every connection; a second one is refused | `AuthService.authorizeHello` |
 * | `session.bind`, `tab.navigated`, `session.unbind` | `devtools` | `./routes/binding.ts`, which owns the binding rules |
 * | `telemetry.event` | `devtools` (the service worker relaying the page agent) | `./routes/telemetry.ts`, which owns the relayed-tab rule |
 * | `agent.ready` | `devtools`, for a tab no other credential has bound | the injected {@link AgentReadinessPort} |
 * | `target.selected` | `devtools`, for the session bound to its tab | the injected {@link TargetSelectionPort} |
 * | `source.open` | `devtools` for the session bound to its tab; `vscode` within its announced workspace | the injected {@link SourceOpenPort}, which contains the path and forwards it to the session's editors |
 * | every service push (`session.updated`, `agent.config`, `server-agent.config`, `panel.generated`, …) | nobody — a client cannot spoof a service push | refused with `error` |
 *
 * A `server-agent` connection sends nothing after its hello: it posts telemetry
 * over HTTP and only receives `server-agent.config`, so every frame it sends is
 * refused by the role guards above. The page agent owns no socket; its
 * `agent.ready` and telemetry batches arrive on the tab's `devtools` connection
 * and are attributed to that connection's principal.
 *
 * ## Protocol discipline and privacy
 *
 * Nothing protocol defines is restated here: the path, the close code, the
 * hello window, the client kinds and the message vocabulary are imported, frames
 * are decoded with `decodeMessage` and replies built with `createEnvelope`, and
 * the inbound switch runs over the parsed union so the compiler proves every
 * message type handled. The HTTP-only operation names (`session.create`,
 * `capture.start`, …) are not WebSocket message types, so a frame carrying one
 * fails decoding and is refused like any unknown type.
 *
 * The hello's credential never reaches a log record, an `error` payload or a
 * close reason, and no plaintext credential is held once the hello has been
 * resolved — the registry keeps the principal, which carries only a digest.
 * Close reasons and refusal messages are constant sentences; log records carry
 * connection ids, client kinds, message types, close codes and error codes.
 *
 * ## Lifetime
 *
 * {@link WsServer.close} stops accepting upgrades, detaches from every HTTP
 * server it was attached to, stops the heartbeat, closes every socket (both
 * authenticated ones and ones still awaiting their hello), terminates any that
 * do not finish the closing handshake within a short grace period, waits for
 * in-flight frame handlers to settle, and unregisters every connection still
 * retained offline — so `startService(...).close()` leaves no open socket, no
 * live timer and no registration of this server's between integration suites.
 * Every timer this module starts is `unref()`ed as well.
 *
 * @example Wiring in `main.ts`
 * ```ts
 * const clients = createClientRegistry({ logger });
 * const auth = unwrap(createAuthService({ store, config, logger, revoker: clients }));
 * const binding = createBindingRoutes({ clients, sessions, manager, reopener, arming, logger });
 * const telemetry = createTelemetryRoutes({ ingest, bindings: clients, logger });
 * const ws = unwrap(
 *   createWsServer({ auth, clients, binding, telemetry, readiness, targets, sourceOpen, logger }),
 * );
 * unwrap(ws.attach(httpServer));
 * // on shutdown:
 * await ws.close();
 * ```
 *
 * @module
 */

import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import {
  CLIENT_HELLO_TIMEOUT_MS,
  PROTOCOL_VERSION,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
  createEnvelope,
  decodeMessage,
  errorPayloadSchema,
  isMessageOfType,
  isPlainRecord,
  toErrorPayload,
} from '@debuggen/protocol';
import type {
  AgentReadyPayload,
  ClientKind,
  ErrorPayload,
  MessageByType,
  MessageType,
  ProtocolMessage,
  SelectedTarget,
} from '@debuggen/protocol';
import { DebuggenError, assertNever, err, isErr, noopLogger, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result, SessionId } from '@debuggen/shared';

import { LOG_BINDING_KEYS, LOG_ERROR_FIELD_KEY, subsystemLogger } from '../logging.js';
import { authFailureReasonOf, isAllowedOrigin, requireBoundSession, requireRole } from './auth.js';
import type {
  AuthFailureReason,
  AuthService,
  Principal,
  PrincipalRole,
  WorkspaceAnnouncement,
} from './auth.js';
import {
  DEFAULT_OFFLINE_GRACE_MS,
  MAX_CLOSE_REASON_BYTES,
  WS_CLOSE_GOING_AWAY,
  WS_CLOSE_TRY_AGAIN_LATER,
} from './clients.js';
import type { ClientRegistry, RegisteredClient, TabBindingView } from './clients.js';
import type { BindingRoutes } from './routes/binding.js';
import {
  MAX_TELEMETRY_INGEST_REQUEST_BODY_BYTES,
  TELEMETRY_FRAME_ROLES,
} from './routes/telemetry.js';
import type { TelemetryRoutes } from './routes/telemetry.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * How often an authenticated connection is pinged, in milliseconds.
 *
 * Every pong refreshes the connection's `lastSeenAt` in the client registry,
 * which is the heartbeat the preload-bound readiness adapters measure against a
 * 30 s staleness window; 15 s keeps an idle but healthy dev server fresh with a
 * whole interval to spare. A connection that has not answered the previous ping
 * when the next one is due is terminated.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * The most frames one connection may have waiting to be processed.
 *
 * Frames are handled strictly in order per connection, so a peer that sends
 * faster than its frames can be handled builds a queue. Past this bound the
 * connection is closed with `WS_CLOSE_TRY_AGAIN_LATER` rather than having
 * frames dropped, because a dropped frame would break the ordering guarantee;
 * the reconnecting client re-binds and is replayed from stored data.
 */
export const DEFAULT_MAX_PENDING_FRAMES = 256;

/**
 * How long a closing socket is given to finish the closing handshake before it
 * is terminated, in milliseconds. Also the bound {@link WsServer.close} waits
 * for in-flight frame handlers.
 */
export const CLOSE_HANDSHAKE_GRACE_MS = 1_000;

/**
 * RFC 6455 close code 1011, "Internal Error": the credential could not be
 * checked for a reason that is not a refusal (a store failure, for instance).
 * Distinct from `WS_CLOSE_UNAUTHORIZED` on purpose — a client treats that one
 * as terminal, whereas this one is worth retrying.
 */
export const WS_CLOSE_INTERNAL_ERROR = 1011;

/**
 * The largest WebSocket message accepted, in bytes: the same bound the HTTP
 * ingest door applies to a request body, since a relayed `telemetry.event`
 * batch and an ingest body carry the same protocol-bounded batch. `ws` closes a
 * connection that sends more (RFC 6455 code 1009) before buffering it.
 */
export const MAX_WS_MESSAGE_BYTES = MAX_TELEMETRY_INGEST_REQUEST_BODY_BYTES;

/** The `subsystem` binding of this module's log records. */
const LOG_SUBSYSTEM = 'server.ws';

/*
 * The two message types this module names outside its exhaustive switch, and
 * the two roles it names. `satisfies` checks each literal against protocol's
 * closed vocabulary (`MessageType`, derived from `MESSAGE_TYPES`) and against
 * `./auth.ts`'s role vocabulary, so a rename upstream is a compile error here
 * rather than a silent mismatch on the wire; the `const` keeps each literal
 * type, which is what lets `isMessageOfType` and `createEnvelope` narrow.
 */
const HELLO_TYPE = 'client.hello' satisfies MessageType;
const ERROR_REPLY_TYPE = 'error' satisfies MessageType;
const DEVTOOLS_ROLE = 'devtools' satisfies PrincipalRole;
const EDITOR_ROLE = 'vscode' satisfies PrincipalRole;

/** The roles that may send the three binding messages: only the DevTools connection binds a tab. */
const BINDING_ROLES: readonly PrincipalRole[] = Object.freeze([DEVTOOLS_ROLE]);

/** The roles that may relay the page agent's `agent.ready`. */
const AGENT_RELAY_ROLES: readonly PrincipalRole[] = Object.freeze([DEVTOOLS_ROLE]);

/** The roles that may ask for a source location to be opened in the editor. */
const SOURCE_OPEN_ROLES: readonly PrincipalRole[] = Object.freeze([EDITOR_ROLE, DEVTOOLS_ROLE]);

/** A close code and the constant reason sent with it. */
interface CloseDirective {
  readonly code: number;
  readonly reason: string;
}

/**
 * Every way this module closes a connection. The reasons are constant
 * sentences naming a category only: none interpolates a credential, a payload
 * or anything else the client sent.
 */
const CLOSE_DIRECTIVES = Object.freeze({
  helloTimeout: {
    code: WS_CLOSE_UNAUTHORIZED,
    reason: 'No hello frame arrived within the handshake window',
  },
  helloMalformed: {
    code: WS_CLOSE_UNAUTHORIZED,
    reason: 'The first frame must be a valid hello',
  },
  protocolVersion: {
    code: WS_CLOSE_UNAUTHORIZED,
    reason: `Unsupported protocol version; this service speaks ${PROTOCOL_VERSION}`,
  },
  originRefused: {
    code: WS_CLOSE_UNAUTHORIZED,
    reason: 'Origin refused for this credential',
  },
  credentialRefused: {
    code: WS_CLOSE_UNAUTHORIZED,
    reason: 'Credential refused',
  },
  claimsRefused: {
    code: WS_CLOSE_UNAUTHORIZED,
    reason: 'Hello claims do not match the credential',
  },
  authUnavailable: {
    code: WS_CLOSE_INTERNAL_ERROR,
    reason: 'The credential could not be checked; retry shortly',
  },
  capacity: {
    code: WS_CLOSE_TRY_AGAIN_LATER,
    reason: 'Too many open connections; retry later',
  },
  backlog: {
    code: WS_CLOSE_TRY_AGAIN_LATER,
    reason: 'Too many unprocessed frames on this connection',
  },
  shutdown: {
    code: WS_CLOSE_GOING_AWAY,
    reason: 'Debug Generator service is shutting down',
  },
} as const satisfies Readonly<Record<string, CloseDirective>>);

/** One entry of {@link CLOSE_DIRECTIVES}. */
type CloseDirectiveName = keyof typeof CLOSE_DIRECTIVES;

/**
 * How each access-boundary refusal of a hello closes the connection.
 *
 * Keyed by every entry of `./auth.ts`'s `AUTH_FAILURE_REASONS`, so a reason
 * added there without a decision here fails to compile. Reasons the hello path
 * cannot produce today (the pairing reasons, the session and project scope
 * reasons) are still mapped, to the nearest category, so the table stays total.
 */
const HELLO_REFUSAL_DIRECTIVES = Object.freeze({
  'forbidden-origin': 'originRefused',
  'origin-not-permitted-for-role': 'originRefused',
  'missing-credential': 'credentialRefused',
  'malformed-credential': 'credentialRefused',
  'unknown-credential': 'credentialRefused',
  'expired-credential': 'credentialRefused',
  'corrupt-credential': 'credentialRefused',
  'role-not-permitted': 'credentialRefused',
  'hello-invalid': 'helloMalformed',
  'protocol-incompatible': 'protocolVersion',
  'client-kind-mismatch': 'claimsRefused',
  'hello-claim-mismatch': 'claimsRefused',
  'project-out-of-scope': 'claimsRefused',
  'session-not-bound': 'claimsRefused',
  'pairing-origin-required': 'credentialRefused',
  'pairing-invalid': 'credentialRefused',
  'pairing-used': 'credentialRefused',
  'pairing-expired': 'credentialRefused',
  'pairing-locked': 'credentialRefused',
} as const satisfies Readonly<Record<AuthFailureReason, CloseDirectiveName>>);

/*
 * The constant messages of the refusals this module raises itself. Each is a
 * sentence about the rule that was applied; none echoes a value from a frame.
 */
const SECOND_HELLO_MESSAGE =
  'This connection is already authenticated; a second hello frame is not a re-authentication.';
const SERVICE_PUSH_MESSAGE =
  'This message is sent by the Debug Generator service only; a client may not send it.';
const BINARY_FRAME_MESSAGE =
  'Binary WebSocket frames are not part of the Debug Generator protocol; send JSON text frames.';
const AGENT_SESSION_TAB_MESSAGE =
  'The session this frame names is bound to a different tab than the one the page agent reported.';
const MISSING_BINDING_MESSAGE =
  'This DevTools client may act only on the session its inspected tab is bound to.';
const SOURCE_OPEN_ROLE_MESSAGE =
  'Only a VS Code or DevTools connection may ask for a source location to be opened.';
const NO_EDITOR_MESSAGE =
  'No VS Code window is connected for this project, so the location could not be opened there; use the editor link fallback or open the project in VS Code.';
const HANDLER_FAILURE_MESSAGE =
  'The Debug Generator local service failed unexpectedly while handling this frame. Its log holds the reason.';
const UNREPORTABLE_FAILURE_MESSAGE =
  'The Debug Generator local service could not describe this failure. Its log holds the reason.';
const SERVER_CLOSED_MESSAGE = 'The WebSocket server is closed.';
const ALREADY_ATTACHED_MESSAGE = 'The WebSocket server is already attached to this HTTP server.';

/* -------------------------------------------------------------------------------------------------
 * Injected ports
 *
 * Declared here, where they are consumed, and satisfied structurally by the
 * subsystems `main.ts` injects — the same consumer-declared-port style
 * `sessions/manager.ts` uses for its broadcaster. That keeps this module
 * compiling and testable without those folders, and keeps every edge one-way.
 * ---------------------------------------------------------------------------------------------- */

/** A value, or a promise of one: every port may answer synchronously or not. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The facts about an authenticated connection a port may read: its
 * process-local id and kind, for diagnostics, and the principal `./auth.ts`
 * resolved from its credential — the only authority. A `RegisteredClient`
 * snapshot satisfies it as it stands.
 */
export type WsConnectionFacts = Pick<RegisteredClient, 'id' | 'kind' | 'principal'>;

/**
 * Where a relayed `agent.ready` goes: the browser-agent ledger the readiness
 * gate reads (`src/instrumentation/readiness.ts` consumes the recorded reports
 * through its `BrowserAgentRegistry` port).
 *
 * Called only after the relaying connection has been authorized for the tab
 * the report names. Must not throw; a refusal or failure is an `Err`, answered
 * to the relaying connection with protocol's `error` message.
 */
export interface AgentReadinessPort {
  agentReady(
    payload: AgentReadyPayload,
    client: WsConnectionFacts,
  ): MaybePromise<Result<unknown, DebuggenError>>;
}

/**
 * Where a `target.selected` goes: the sessions/pipeline subsystem, which
 * records the descriptor as the session's current target (the first pipeline
 * stage reads it).
 *
 * Called only after the sending DevTools connection has been proved to hold
 * the session's tab binding. Must not throw; a failure is an `Err`.
 */
export interface TargetSelectionPort {
  selected(
    sessionId: SessionId,
    target: SelectedTarget,
  ): MaybePromise<Result<unknown, DebuggenError>>;
}

/**
 * Who is asking for a location to be opened, composed from the connection's
 * resolved principal and — for a DevTools connection — the live binding its own
 * credential made. Never taken from the frame.
 *
 * Structurally the `SourceOpenPrincipal` of `src/source/open.ts`.
 */
export interface SourceOpenCaller {
  /** The client kind the connection authenticated as. */
  readonly client: ClientKind;
  /** The workspace folders an editor connection announced in its hello. */
  readonly projectRoots?: readonly string[] | undefined;
  /** The tab a DevTools connection's credential bound to the frame's session. */
  readonly tabId?: number | undefined;
  /** The session that binding names. */
  readonly sessionId?: string | undefined;
}

/**
 * The outcome of a `source.open` as this module needs to see it: whether an
 * editor received the location. `false` means the location passed every check
 * but no VS Code window was connected, which is answered to the sender so it
 * can fall back to the editor's URI handler.
 */
export interface SourceOpenDelivery {
  readonly delivered: boolean;
}

/**
 * Where a `source.open` goes: `src/source/open.ts`'s handler, which re-validates
 * the frame, looks up the session's project root, authorizes the caller,
 * contains the path lexically and on the filesystem, and forwards the location
 * to the session's editor clients through the client registry.
 *
 * Satisfied structurally by `createSourceOpenHandler(...)`. Must not throw.
 */
export interface SourceOpenPort {
  handle(
    message: MessageByType<'source.open'>,
    caller: SourceOpenCaller,
  ): MaybePromise<Result<SourceOpenDelivery, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/** The listener shape of a `node:http` server's `upgrade` event. */
export type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * The part of an HTTP server {@link WsServer.attach} uses: subscribing to and
 * unsubscribing from its `upgrade` event. `node:http`'s `Server` — and the
 * `ServerType` `@hono/node-server`'s `serve` returns — satisfy it.
 */
export interface UpgradeSource {
  on(event: 'upgrade', listener: UpgradeListener): unknown;
  off(event: 'upgrade', listener: UpgradeListener): unknown;
}

/** Everything {@link createWsServer} is built from; every collaborator is injected. */
export interface WsServerDeps {
  /** The access boundary: hello authentication and editor workspace announcements. */
  readonly auth: Pick<AuthService, 'authorizeHello' | 'announceWorkspace'>;
  /**
   * The client registry: registration, liveness, the live binding view the
   * guards read, and the single-recipient reply path. This module registers
   * and deregisters sockets; it never iterates them to deliver a frame.
   */
  readonly clients: Pick<
    ClientRegistry,
    | 'register'
    | 'unregister'
    | 'get'
    | 'markOffline'
    | 'touch'
    | 'bindingForSession'
    | 'bindingForTab'
    | 'sendToClient'
  >;
  /** The binding route, owner of `session.bind`, `tab.navigated` and `session.unbind`. */
  readonly binding: BindingRoutes;
  /** The telemetry route, owner of the relayed `telemetry.event` batch path. */
  readonly telemetry: Pick<TelemetryRoutes, 'handleTelemetryEventFrame'>;
  /** Receives relayed `agent.ready` reports. */
  readonly readiness: AgentReadinessPort;
  /** Receives `target.selected` descriptors. */
  readonly targets: TargetSelectionPort;
  /** Handles `source.open` requests. */
  readonly sourceOpen: SourceOpenPort;
  /** The service logger; this module binds `subsystem: "server.ws"`. Defaults to silence. */
  readonly logger?: Logger | undefined;
  /**
   * The ping interval, in milliseconds; `0` disables the heartbeat. Defaults to
   * {@link DEFAULT_HEARTBEAT_INTERVAL_MS}.
   */
  readonly heartbeatIntervalMs?: number | undefined;
  /**
   * How long a new socket may take to send its hello, in milliseconds. Defaults
   * to protocol's `CLIENT_HELLO_TIMEOUT_MS`, which is also its ceiling: the
   * window may be shortened (a test does) but never extended past the
   * protocol's.
   */
  readonly helloTimeoutMs?: number | undefined;
  /** See {@link DEFAULT_MAX_PENDING_FRAMES}. */
  readonly maxPendingFrames?: number | undefined;
  /**
   * How long a closed connection's registration is kept, marked offline,
   * before it is unregistered, in milliseconds; `0` unregisters at once.
   * Defaults to the registry's `DEFAULT_OFFLINE_GRACE_MS`, so the two agree on
   * how long a suspended service worker may stay away.
   */
  readonly offlineGraceMs?: number | undefined;
}

/** Counters for diagnostics and for the shutdown audit of the integration suites. */
export interface WsServerStats {
  /** Sockets currently open (in any phase). */
  readonly open: number;
  /** Sockets still waiting for their hello. */
  readonly awaitingHello: number;
  /** Sockets whose hello was authenticated. */
  readonly authenticated: number;
  /** Frames waiting to be processed, across every connection. */
  readonly pendingFrames: number;
  /** Closed connections still registered (offline) within their grace period. */
  readonly offlineRetained: number;
  /** HTTP servers the upgrade listener is attached to. */
  readonly attached: number;
  /** Whether a live heartbeat timer exists. */
  readonly heartbeatActive: boolean;
  /** Whether {@link WsServer.close} has been called. */
  readonly closed: boolean;
}

/** The WebSocket surface {@link createWsServer} returns. */
export interface WsServer {
  /**
   * Routes an HTTP server's `upgrade` event to {@link handleUpgrade}. The
   * listener owns every upgrade on that server: a request for any other path is
   * answered 404.
   * @returns `ok`; `TRANSPORT_DISCONNECTED` after {@link close}; `INTERNAL`
   * when already attached to the same server.
   */
  attach(server: UpgradeSource): Result<void, DebuggenError>;
  /**
   * The upgrade gate, for a caller that wires the `upgrade` event itself:
   * path, then origin, then the `ws` handshake. Never throws; a refused upgrade
   * is answered with an HTTP status and the TCP socket destroyed.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Current counters. */
  stats(): WsServerStats;
  /**
   * Stops accepting upgrades, detaches from every server, stops the heartbeat,
   * closes every socket (terminating any that linger past
   * {@link CLOSE_HANDSHAKE_GRACE_MS}), waits for in-flight frame handlers
   * within the same bound, and unregisters the connections still retained
   * offline. Idempotent; every call returns the same promise.
   */
  close(): Promise<void>;
}

/* -------------------------------------------------------------------------------------------------
 * Connection state
 * ---------------------------------------------------------------------------------------------- */

/**
 * Where a socket is in its life.
 * - `awaiting-hello` — upgraded; its first frame has not arrived.
 * - `authenticated` — the hello was authorized and the connection registered.
 * - `closing` — this module started the closing handshake; frames are ignored.
 * - `closed` — the socket emitted `close`; everything it held is released.
 */
type ConnectionPhase = 'awaiting-hello' | 'authenticated' | 'closing' | 'closed';

/** A timer handle, as Node's timer functions return it. */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Everything this module keeps about one socket. No field holds the credential:
 * the hello's token lives only in the local variables of the handshake.
 */
interface ConnectionState {
  readonly socket: WebSocket;
  /** The upgrade request's raw `Origin` header, for the hello's origin check. Never logged. */
  readonly origin: string | undefined;
  phase: ConnectionPhase;
  /** The hello deadline, while awaiting the hello. */
  helloTimer: TimerHandle | undefined;
  /** The terminate fallback of a closing handshake this module started. */
  closeTimer: TimerHandle | undefined;
  /** The registry's id for the connection, once registered. */
  clientId: string | undefined;
  /** The registered kind, for log records. */
  kind: ClientKind | undefined;
  /** An editor connection's workspace announcement, released on close. */
  announcement: WorkspaceAnnouncement | undefined;
  /** The tail of this connection's frame queue. */
  tail: Promise<void>;
  /** Frames queued or running on {@link tail}. */
  pending: number;
  /** Whether a ping is outstanding. */
  awaitingPong: boolean;
  /** Settles when the socket has emitted `close`. */
  readonly closed: Promise<void>;
  /** Settles {@link closed}. */
  readonly settleClosed: () => void;
}

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

/** A refusal raised by this module, as the `Err` its handlers return. */
function refusal(code: DebuggenErrorCode, message: string): Result<never, DebuggenError> {
  return err(new DebuggenError(code, message));
}

/** Collapses a handler's outcome to success or its error; success values are the handler's business. */
function settled(outcome: Result<unknown, DebuggenError>): Result<void, DebuggenError> {
  return isErr(outcome) ? outcome : ok(undefined);
}

/**
 * The path of a request target, without its query string or fragment. The
 * upgrade gate compares it with protocol's `WS_PATH` exactly.
 */
function requestPathOf(url: string | undefined): string {
  if (url === undefined) {
    return '';
  }
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * Converts a text frame's payload to a string. `ws` delivers a `Buffer` for
 * the default binary type; the other two shapes of `RawData` are handled so a
 * change of binary type cannot turn into a crash.
 */
function rawDataToText(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

/**
 * Bounds a close reason to the 123 bytes RFC 6455 allows (`ws` throws past
 * it). Every reason this module sends is a short constant, so this is a guard
 * against a future edit rather than a truncation that happens in practice.
 */
function clampCloseReason(reason: string): string {
  let clamped = reason;
  while (Buffer.byteLength(clamped, 'utf8') > MAX_CLOSE_REASON_BYTES) {
    clamped = clamped.slice(0, -1);
  }
  return clamped;
}

/** A decoded frame, and the reference an `error` reply to it should carry. */
interface DecodedFrame {
  readonly result: Result<ProtocolMessage, DebuggenError>;
  /** The frame's own `id`, whenever one could be read — even from a frame that failed validation. */
  readonly ref: string | undefined;
}

/**
 * Decodes one text frame with protocol's `decodeMessage`, keeping the frame's
 * `id` for the reply's `ref` even when the frame fails validation.
 *
 * The JSON is parsed once here and the parsed value handed to `decodeMessage`,
 * which validates it; only text that is not JSON at all is handed to
 * `decodeMessage` as text, so the rejection is protocol's own "not JSON" error
 * — whose message, unlike `JSON.parse`'s, never quotes the input.
 */
function decodeFrame(text: string): DecodedFrame {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { result: decodeMessage(text), ref: undefined };
  }
  const result = decodeMessage(value);
  if (result.ok) {
    return { result, ref: result.value.id };
  }
  const candidate = isPlainRecord(value) ? value['id'] : undefined;
  return { result, ref: typeof candidate === 'string' ? candidate : undefined };
}

/**
 * The payload of an `error` reply: protocol's `toErrorPayload` (the code, the
 * message and, when given, the reference), verified against the `error`
 * payload schema before it is sent. A reference the schema refuses (a client
 * `id` out of bounds) is dropped rather than the reply; a message the schema
 * refuses is replaced by a constant, so a reply is always well-formed.
 */
function errorReplyPayload(error: DebuggenError, ref: string | undefined): ErrorPayload {
  const withRef = toErrorPayload(error, ref);
  if (errorPayloadSchema.safeParse(withRef).success) {
    return withRef;
  }
  const withoutRef = toErrorPayload(error);
  if (errorPayloadSchema.safeParse(withoutRef).success) {
    return withoutRef;
  }
  return toErrorPayload(new DebuggenError('INTERNAL', UNREPORTABLE_FAILURE_MESSAGE));
}

/**
 * How a hello refused by the access boundary closes the connection: the
 * category of `HELLO_REFUSAL_DIRECTIVES` for a refusal, and the retryable
 * internal-error close for anything that is not one (a store failure).
 */
function directiveForHelloFailure(error: DebuggenError): CloseDirective {
  const reason = authFailureReasonOf(error);
  return reason === undefined
    ? CLOSE_DIRECTIVES.authUnavailable
    : CLOSE_DIRECTIVES[HELLO_REFUSAL_DIRECTIVES[reason]];
}

/**
 * How a registration refused by the client registry closes the connection,
 * from the registry's documented error codes.
 */
function directiveForRegistrationFailure(error: DebuggenError): CloseDirective {
  switch (error.code) {
    case 'RATE_LIMITED':
      return CLOSE_DIRECTIVES.capacity;
    case 'TRANSPORT_DISCONNECTED':
      return CLOSE_DIRECTIVES.shutdown;
    case 'UNAUTHORIZED':
    case 'PROTOCOL_INVALID_MESSAGE':
      return CLOSE_DIRECTIVES.claimsRefused;
    default:
      return CLOSE_DIRECTIVES.authUnavailable;
  }
}

/**
 * Validates one optional numeric option: an integer within `[min, max]`.
 * @returns the value, the default when absent, or `CONFIG_INVALID`.
 */
function integerOption(
  name: string,
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): Result<number, DebuggenError> {
  if (value === undefined) {
    return ok(fallback);
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    return err(
      new DebuggenError(
        'CONFIG_INVALID',
        `The WebSocket server option ${name} must be an integer from ${String(min)} to ${String(max)}.`,
      ),
    );
  }
  return ok(value);
}

/**
 * Resolves once `promise` settles or `ms` elapse, whichever is first. Never
 * rejects; the timer is `unref()`ed and cleared as soon as the promise settles.
 */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    void promise.then(finish, finish);
  });
}

/* -------------------------------------------------------------------------------------------------
 * The server
 * ---------------------------------------------------------------------------------------------- */

/** The largest delay a Node timer accepts, in milliseconds. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Builds the WebSocket surface over its injected collaborators.
 *
 * Nothing listens until {@link WsServer.attach} is called (or the `upgrade`
 * event is routed to {@link WsServer.handleUpgrade}); the only resource created
 * here is the heartbeat timer, which is `unref()`ed and cleared by
 * {@link WsServer.close}.
 *
 * @param deps The collaborators and the optional tuning of
 * {@link WsServerDeps}.
 * @returns The server; `CONFIG_INVALID` when a tuning option is out of range.
 */
export function createWsServer(deps: WsServerDeps): Result<WsServer, DebuggenError> {
  const heartbeatOption = integerOption(
    'heartbeatIntervalMs',
    deps.heartbeatIntervalMs,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    0,
    MAX_TIMER_DELAY_MS,
  );
  if (isErr(heartbeatOption)) {
    return heartbeatOption;
  }
  const helloOption = integerOption(
    'helloTimeoutMs',
    deps.helloTimeoutMs,
    CLIENT_HELLO_TIMEOUT_MS,
    1,
    CLIENT_HELLO_TIMEOUT_MS,
  );
  if (isErr(helloOption)) {
    return helloOption;
  }
  const backlogOption = integerOption(
    'maxPendingFrames',
    deps.maxPendingFrames,
    DEFAULT_MAX_PENDING_FRAMES,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (isErr(backlogOption)) {
    return backlogOption;
  }
  const graceOption = integerOption(
    'offlineGraceMs',
    deps.offlineGraceMs,
    DEFAULT_OFFLINE_GRACE_MS,
    0,
    MAX_TIMER_DELAY_MS,
  );
  if (isErr(graceOption)) {
    return graceOption;
  }
  const heartbeatIntervalMs = heartbeatOption.value;
  const helloTimeoutMs = helloOption.value;
  const maxPendingFrames = backlogOption.value;
  const offlineGraceMs = graceOption.value;

  const { auth, clients, binding, telemetry, readiness, targets, sourceOpen } = deps;
  const log = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM);

  // `clientTracking: false` because this module tracks its own sockets (with
  // their handshake state); `ws` keeping a second set would only be a second
  // thing to empty on shutdown.
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: MAX_WS_MESSAGE_BYTES,
  });
  wss.on('error', (cause) => {
    log.error('the WebSocket server reported an error', { [LOG_ERROR_FIELD_KEY]: cause });
  });

  const connections = new Map<WebSocket, ConnectionState>();
  /** Closed connections kept registered (offline) until their grace period ends, by client id. */
  const retained = new Map<string, TimerHandle>();
  const attached = new Set<UpgradeSource>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  /* ---- logging ---- */

  /** The log fields that identify a connection: its id and kind once registered, nothing before. */
  function fieldsOf(state: ConnectionState): LogFields {
    const fields: LogFields = {};
    if (state.clientId !== undefined) {
      fields['clientId'] = state.clientId;
    }
    if (state.kind !== undefined) {
      fields[LOG_BINDING_KEYS.client] = state.kind;
    }
    return fields;
  }

  /**
   * Runs a socket or timer callback so that nothing it throws escapes into
   * `ws` or the event loop: an unexpected failure is logged, and a connection
   * still in its handshake is closed rather than left without a deadline.
   */
  function guarded(
    description: string,
    state: ConnectionState | undefined,
    action: () => void,
  ): void {
    try {
      action();
    } catch (cause) {
      log.error(description, {
        ...(state === undefined ? {} : fieldsOf(state)),
        [LOG_ERROR_FIELD_KEY]: cause,
      });
      if (state?.phase === 'awaiting-hello') {
        closeConnection(state, CLOSE_DIRECTIVES.authUnavailable);
      }
    }
  }

  /* ---- the upgrade gate ---- */

  /** Answers a refused upgrade with a bare HTTP status and destroys the TCP socket. */
  function rejectUpgrade(socket: Duplex, status: number): void {
    socket.on('error', (cause) => {
      log.debug('a refused upgrade socket failed while closing', { [LOG_ERROR_FIELD_KEY]: cause });
    });
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    socket.once('finish', () => {
      socket.destroy();
    });
    socket.end(
      `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      if (closed) {
        rejectUpgrade(socket, 503);
        return;
      }
      // Neither the path nor the origin is logged: a request target can carry
      // a query string, and an origin is the requesting page's identity.
      if (requestPathOf(request.url) !== WS_PATH) {
        log.debug('refused a WebSocket upgrade for a path other than the protocol endpoint');
        rejectUpgrade(socket, 404);
        return;
      }
      const origin = request.headers.origin;
      if (!isAllowedOrigin(origin)) {
        log.debug('refused a WebSocket upgrade from a refused origin');
        rejectUpgrade(socket, 403);
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        guarded('accepting a WebSocket connection failed unexpectedly', undefined, () => {
          accept(ws, origin);
        });
      });
    } catch (cause) {
      log.warn('a WebSocket upgrade failed unexpectedly', { [LOG_ERROR_FIELD_KEY]: cause });
      socket.destroy();
    }
  }

  /* ---- connection lifecycle ---- */

  /** Starts tracking a freshly upgraded socket and arms its hello deadline. */
  function accept(socket: WebSocket, origin: string | undefined): void {
    let settleClosed: () => void = () => undefined;
    const closedSignal = new Promise<void>((resolve) => {
      settleClosed = resolve;
    });
    const state: ConnectionState = {
      socket,
      origin,
      phase: 'awaiting-hello',
      helloTimer: undefined,
      closeTimer: undefined,
      clientId: undefined,
      kind: undefined,
      announcement: undefined,
      tail: Promise.resolve(),
      pending: 0,
      awaitingPong: false,
      closed: closedSignal,
      settleClosed,
    };
    connections.set(socket, state);

    socket.on('message', (data: RawData, isBinary: boolean) => {
      guarded('handling a WebSocket frame failed unexpectedly', state, () => {
        onMessage(state, data, isBinary);
      });
    });
    socket.on('pong', () => {
      guarded('handling a heartbeat pong failed unexpectedly', state, () => {
        onPong(state);
      });
    });
    socket.on('error', (cause: Error) => {
      guarded('handling a WebSocket error failed unexpectedly', state, () => {
        onSocketError(state, cause);
      });
    });
    socket.once('close', (code: number) => {
      guarded('handling a WebSocket close failed unexpectedly', state, () => {
        onClose(state, code);
      });
    });

    if (closed) {
      closeConnection(state, CLOSE_DIRECTIVES.shutdown);
      return;
    }
    const timer = setTimeout(() => {
      guarded('the hello deadline failed unexpectedly', state, () => {
        onHelloTimeout(state);
      });
    }, helloTimeoutMs);
    timer.unref();
    state.helloTimer = timer;
  }

  function clearHelloTimer(state: ConnectionState): void {
    if (state.helloTimer !== undefined) {
      clearTimeout(state.helloTimer);
      state.helloTimer = undefined;
    }
  }

  function clearCloseTimer(state: ConnectionState): void {
    if (state.closeTimer !== undefined) {
      clearTimeout(state.closeTimer);
      state.closeTimer = undefined;
    }
  }

  /**
   * Starts the closing handshake with a constant code and reason, and arms the
   * terminate fallback. Idempotent: a connection already closing is left alone.
   */
  function closeConnection(state: ConnectionState, directive: CloseDirective): void {
    if (state.phase === 'closing' || state.phase === 'closed') {
      return;
    }
    state.phase = 'closing';
    clearHelloTimer(state);
    try {
      state.socket.close(directive.code, clampCloseReason(directive.reason));
    } catch (cause) {
      log.debug('a socket refused to close; terminating it', {
        ...fieldsOf(state),
        [LOG_ERROR_FIELD_KEY]: cause,
      });
      state.socket.terminate();
      return;
    }
    const timer = setTimeout(() => {
      state.closeTimer = undefined;
      state.socket.terminate();
    }, CLOSE_HANDSHAKE_GRACE_MS);
    timer.unref();
    state.closeTimer = timer;
  }

  function onHelloTimeout(state: ConnectionState): void {
    state.helloTimer = undefined;
    if (state.phase !== 'awaiting-hello') {
      return;
    }
    log.debug('closed a connection that sent no hello within the handshake window');
    closeConnection(state, CLOSE_DIRECTIVES.helloTimeout);
  }

  function onPong(state: ConnectionState): void {
    state.awaitingPong = false;
    if (state.clientId !== undefined) {
      clients.touch(state.clientId);
    }
  }

  /**
   * `ws` emits `error` for a protocol violation or a transport failure, always
   * followed by `close`. The connection is marked offline at once, so the
   * registry stops writing to it before the close arrives.
   */
  function onSocketError(state: ConnectionState, cause: Error): void {
    log.debug('a WebSocket connection failed', {
      ...fieldsOf(state),
      [LOG_ERROR_FIELD_KEY]: cause,
    });
    if (state.clientId !== undefined) {
      clients.markOffline(state.clientId);
    }
  }

  /**
   * Releases everything a socket held. The session, its tab binding and any
   * open capture are deliberately untouched (AAP §0.5.5): the binding belongs
   * to the credential, and a reconnect with the same credential carries it.
   */
  function onClose(state: ConnectionState, code: number): void {
    if (state.phase === 'closed') {
      return;
    }
    state.phase = 'closed';
    clearHelloTimer(state);
    clearCloseTimer(state);
    connections.delete(state.socket);
    const announcement = state.announcement;
    state.announcement = undefined;
    announcement?.release();
    if (state.clientId !== undefined) {
      retire(state.clientId);
    }
    log.debug('a WebSocket connection closed', { ...fieldsOf(state), code });
    state.settleClosed();
  }

  /**
   * Marks a closed connection's registration offline and unregisters it once
   * the offline grace period has passed — at once when the grace period is
   * zero or the server is closing. `unregister` keeps every binding, so the
   * only thing the grace period decides is how long the offline registration
   * stays visible; a registry sweep that removed it first is harmless.
   */
  function retire(clientId: string): void {
    clients.markOffline(clientId);
    if (closed || offlineGraceMs === 0) {
      clients.unregister(clientId);
      return;
    }
    const timer = setTimeout(() => {
      guarded('retiring an offline connection failed unexpectedly', undefined, () => {
        retained.delete(clientId);
        clients.unregister(clientId);
      });
    }, offlineGraceMs);
    timer.unref();
    retained.set(clientId, timer);
  }

  /** Pings every authenticated connection, terminating those that missed the previous ping. */
  function beat(): void {
    for (const state of connections.values()) {
      if (state.phase !== 'authenticated') {
        continue;
      }
      if (state.awaitingPong) {
        log.debug('terminated a connection that missed a heartbeat', fieldsOf(state));
        state.socket.terminate();
        continue;
      }
      state.awaitingPong = true;
      try {
        state.socket.ping();
      } catch (cause) {
        log.debug('a heartbeat ping could not be sent', {
          ...fieldsOf(state),
          [LOG_ERROR_FIELD_KEY]: cause,
        });
      }
    }
  }

  /* ---- the handshake ---- */

  /** Routes one inbound frame by the connection's phase. */
  function onMessage(state: ConnectionState, data: RawData, isBinary: boolean): void {
    switch (state.phase) {
      case 'awaiting-hello':
        handleFirstFrame(state, isBinary ? undefined : rawDataToText(data));
        return;
      case 'authenticated':
        enqueueFrame(state, isBinary ? undefined : rawDataToText(data));
        return;
      case 'closing':
      case 'closed':
        return;
      default:
        assertNever(state.phase, 'Unhandled WebSocket connection phase');
    }
  }

  /**
   * The first frame always ends the handshake: it authenticates the connection
   * or closes it with `WS_CLOSE_UNAUTHORIZED`. The hello's credential exists
   * only in this function's locals — it is handed to the access boundary and
   * then dropped, never stored on the connection, logged or echoed.
   *
   * @param text The frame's text, or `undefined` for a binary frame.
   */
  function handleFirstFrame(state: ConnectionState, text: string | undefined): void {
    clearHelloTimer(state);
    if (text === undefined) {
      log.debug('closed a connection whose first frame was binary');
      closeConnection(state, CLOSE_DIRECTIVES.helloMalformed);
      return;
    }
    const decoded = decodeMessage(text);
    if (isErr(decoded)) {
      log.debug('closed a connection whose first frame was not a valid frame', {
        code: decoded.error.code,
      });
      closeConnection(state, CLOSE_DIRECTIVES.helloMalformed);
      return;
    }
    const hello = decoded.value;
    if (!isMessageOfType(hello, HELLO_TYPE)) {
      log.debug('closed a connection whose first frame was not a hello', { type: hello.type });
      closeConnection(state, CLOSE_DIRECTIVES.helloMalformed);
      return;
    }

    // The access boundary logs its own decision (role on success, the refusal
    // reason otherwise), so nothing about the credential is logged here.
    const decision = auth.authorizeHello({ payload: hello.payload, origin: state.origin });
    if (isErr(decision)) {
      closeConnection(state, directiveForHelloFailure(decision.error));
      return;
    }
    const principal = decision.value;

    // An editor's announced workspace is what lets its HTTP requests act on a
    // project; the announcement lives exactly as long as this connection.
    let announcement: WorkspaceAnnouncement | undefined;
    if (principal.role === EDITOR_ROLE) {
      const announced = auth.announceWorkspace(principal);
      if (isErr(announced)) {
        log.warn('could not record an editor connection’s workspace', {
          code: announced.error.code,
        });
        closeConnection(state, directiveForHelloFailure(announced.error));
        return;
      }
      announcement = announced.value;
    }

    // The kind registered is the credential's role — which the access
    // boundary has already proved equal to the hello's claimed kind — and the
    // hello's project root and tab are passed as facts, not authority.
    const registered = clients.register({
      kind: principal.role,
      principal,
      socket: state.socket,
      projectRoot: hello.payload.projectRoot,
      tabId: hello.payload.tabId,
    });
    if (isErr(registered)) {
      announcement?.release();
      log.debug('the client registry refused an authenticated connection', {
        [LOG_BINDING_KEYS.client]: principal.role,
        code: registered.error.code,
      });
      closeConnection(state, directiveForRegistrationFailure(registered.error));
      return;
    }

    state.phase = 'authenticated';
    state.clientId = registered.value.id;
    state.kind = registered.value.kind;
    state.announcement = announcement;
    log.debug('authenticated a WebSocket connection', fieldsOf(state));
  }

  /* ---- the frame pipeline ---- */

  /**
   * Queues one frame of an authenticated connection behind the ones before it,
   * so a connection's frames are handled strictly in arrival order even though
   * their handlers are asynchronous.
   */
  function enqueueFrame(state: ConnectionState, text: string | undefined): void {
    if (state.clientId === undefined) {
      return;
    }
    clients.touch(state.clientId);
    if (state.pending >= maxPendingFrames) {
      log.warn('closed a connection whose frame backlog overflowed', {
        ...fieldsOf(state),
        maxPendingFrames,
      });
      closeConnection(state, CLOSE_DIRECTIVES.backlog);
      return;
    }
    state.pending += 1;
    state.tail = state.tail
      .then(() => processFrame(state, text))
      .catch((cause: unknown) => {
        log.error('a WebSocket frame could not be processed', {
          ...fieldsOf(state),
          [LOG_ERROR_FIELD_KEY]: cause,
        });
      })
      .finally(() => {
        state.pending -= 1;
      });
  }

  /**
   * Decodes, authorizes and routes one frame, answering every failure with
   * protocol's `error` message on the same connection, which stays open.
   * Never rejects.
   */
  async function processFrame(state: ConnectionState, text: string | undefined): Promise<void> {
    if (state.phase !== 'authenticated' || state.clientId === undefined) {
      return;
    }
    // The registry's snapshot is the authority for the connection's principal;
    // a connection it no longer knows (revoked on rotation, swept) is not
    // answered.
    const client = clients.get(state.clientId);
    if (client === undefined) {
      return;
    }
    if (text === undefined) {
      replyError(
        state,
        new DebuggenError('PROTOCOL_INVALID_MESSAGE', BINARY_FRAME_MESSAGE),
        undefined,
      );
      return;
    }

    const { result, ref } = decodeFrame(text);
    if (isErr(result)) {
      log.debug('refused a frame that failed validation', {
        ...fieldsOf(state),
        code: result.error.code,
      });
      replyError(state, result.error, ref);
      return;
    }
    const message = result.value;

    let outcome: Result<void, DebuggenError>;
    try {
      outcome = await route(client, message);
    } catch (cause) {
      log.error('a WebSocket frame handler failed unexpectedly', {
        ...fieldsOf(state),
        type: message.type,
        [LOG_ERROR_FIELD_KEY]: cause,
      });
      outcome = refusal('INTERNAL', HANDLER_FAILURE_MESSAGE);
    }
    if (isErr(outcome)) {
      log.debug('refused a frame', {
        ...fieldsOf(state),
        type: message.type,
        code: outcome.error.code,
      });
      replyError(state, outcome.error, message.id);
    }
  }

  /**
   * Sends protocol's `error` message to the connection that sent the frame,
   * through the registry's single-recipient path. The frame is session-less,
   * so the registry's principal filter always lets it through to its sender.
   */
  function replyError(state: ConnectionState, error: DebuggenError, ref: string | undefined): void {
    if (state.clientId === undefined) {
      return;
    }
    const frame = createEnvelope(ERROR_REPLY_TYPE, errorReplyPayload(error, ref));
    const receipt = clients.sendToClient(state.clientId, frame);
    if (isErr(receipt)) {
      log.debug('an error reply could not be delivered', {
        ...fieldsOf(state),
        code: receipt.error.code,
      });
    }
  }

  /* ---- routing ---- */

  /**
   * The exhaustive inbound dispatch. The switch runs over the parsed union's
   * discriminant, so each branch receives its own `MessageByType` and a message
   * type added to protocol without a branch here reaches `assertNever` with a
   * real type and fails `tsc -b` rather than being dropped at run time.
   */
  async function route(
    client: RegisteredClient,
    message: ProtocolMessage,
  ): Promise<Result<void, DebuggenError>> {
    const { principal } = client;
    switch (message.type) {
      case 'client.hello':
        return refusal('PROTOCOL_INVALID_MESSAGE', SECOND_HELLO_MESSAGE);

      case 'agent.ready':
        return routeAgentReady(client, message);

      case 'session.bind': {
        const allowed = requireRole(principal, ...BINDING_ROLES);
        if (isErr(allowed)) {
          return allowed;
        }
        return settled(
          await binding.handleSessionBind(message.payload, { principal, clientId: client.id }),
        );
      }

      case 'tab.navigated': {
        const allowed = requireRole(principal, ...BINDING_ROLES);
        if (isErr(allowed)) {
          return allowed;
        }
        return settled(
          await binding.handleTabNavigated(message.payload, { principal, clientId: client.id }),
        );
      }

      case 'session.unbind': {
        const allowed = requireRole(principal, ...BINDING_ROLES);
        if (isErr(allowed)) {
          return allowed;
        }
        return settled(
          await binding.handleSessionUnbind(message.payload, { principal, clientId: client.id }),
        );
      }

      case 'telemetry.event': {
        const allowed = requireRole(principal, ...TELEMETRY_FRAME_ROLES);
        if (isErr(allowed)) {
          return allowed;
        }
        return settled(await telemetry.handleTelemetryEventFrame({ message, client }));
      }

      case 'source.open':
        return routeSourceOpen(client, message);

      case 'target.selected':
        return routeTargetSelected(client, message);

      case 'error':
        // Logged and dropped rather than answered: two peers that each answer
        // an `error` with an `error` would loop forever.
        log.debug('ignored an error frame sent by a client', {
          clientId: client.id,
          [LOG_BINDING_KEYS.client]: client.kind,
          code: message.payload.code,
        });
        return ok(undefined);

      case 'agent.config':
      case 'server-agent.config':
      case 'session.bound':
      case 'session.created':
      case 'session.updated':
      case 'session.progress':
      case 'analysis.completed':
      case 'capture.started':
      case 'capture.stopped':
      case 'instrumentation.plan':
      case 'instrumentation.ready':
      case 'instrumentation.failed':
      case 'telemetry.tail':
      case 'panel.generated':
      case 'target.request':
      case 'cleanup.completed':
        return refusal('PROTOCOL_INVALID_MESSAGE', SERVICE_PUSH_MESSAGE);

      default:
        return assertNever(message, 'Unhandled protocol message type');
    }
  }

  /**
   * The live binding of `sessionId`, provided the principal's own credential
   * made it (`requireBoundSession`): the gate every DevTools action on a
   * session passes through.
   */
  function boundBindingFor(
    principal: Principal,
    sessionId: SessionId,
  ): Result<TabBindingView, DebuggenError> {
    const view = clients.bindingForSession(sessionId);
    const bound = requireBoundSession(principal, sessionId, view);
    if (isErr(bound)) {
      return bound;
    }
    return view === undefined ? refusal('TAB_NOT_BOUND', MISSING_BINDING_MESSAGE) : ok(view);
  }

  /**
   * `agent.ready`, relayed by the service worker for a page agent. The report
   * is accepted for a tab this connection's credential bound or one nobody has
   * bound yet (the page may load before its panel binds it), never for a tab
   * another credential holds; when the envelope names a session, that session
   * must be bound by this credential to the very tab the report names.
   */
  async function routeAgentReady(
    client: RegisteredClient,
    message: MessageByType<'agent.ready'>,
  ): Promise<Result<void, DebuggenError>> {
    const { principal } = client;
    const allowed = requireRole(principal, ...AGENT_RELAY_ROLES);
    if (isErr(allowed)) {
      return allowed;
    }
    const { payload } = message;
    const tabBinding = clients.bindingForTab(payload.tabId);
    if (tabBinding !== undefined) {
      const own = requireBoundSession(principal, tabBinding.sessionId, tabBinding);
      if (isErr(own)) {
        return own;
      }
    }
    if (message.sessionId !== undefined) {
      const bound = boundBindingFor(principal, message.sessionId);
      if (isErr(bound)) {
        return bound;
      }
      if (bound.value.tabId !== payload.tabId) {
        return refusal('TAB_NOT_BOUND', AGENT_SESSION_TAB_MESSAGE);
      }
    }
    return settled(await readiness.agentReady(payload, client));
  }

  /** `target.selected`: only for the session bound to the sender's tab. */
  async function routeTargetSelected(
    client: RegisteredClient,
    message: MessageByType<'target.selected'>,
  ): Promise<Result<void, DebuggenError>> {
    const { sessionId, target } = message.payload;
    const bound = boundBindingFor(client.principal, sessionId);
    if (isErr(bound)) {
      return bound;
    }
    return settled(await targets.selected(sessionId, target));
  }

  /**
   * `source.open`: a DevTools connection only for the session bound to its tab,
   * an editor connection within the workspace folders it announced (which the
   * handler checks against the session's stored project root). The caller
   * handed to the handler is composed from the principal and the live binding,
   * never from the frame. A location that passed every check but reached no
   * editor is answered `TRANSPORT_DISCONNECTED`, the sender's cue for the
   * editor-link fallback.
   */
  async function routeSourceOpen(
    client: RegisteredClient,
    message: MessageByType<'source.open'>,
  ): Promise<Result<void, DebuggenError>> {
    const { principal } = client;
    const allowed = requireRole(principal, ...SOURCE_OPEN_ROLES);
    if (isErr(allowed)) {
      return allowed;
    }

    let caller: SourceOpenCaller;
    if (principal.role === DEVTOOLS_ROLE) {
      const bound = boundBindingFor(principal, message.payload.sessionId);
      if (isErr(bound)) {
        return bound;
      }
      caller = { client: client.kind, tabId: bound.value.tabId, sessionId: bound.value.sessionId };
    } else if (principal.role === EDITOR_ROLE) {
      caller = { client: client.kind, projectRoots: principal.scope.workspaceFolders };
    } else {
      return refusal('UNAUTHORIZED', SOURCE_OPEN_ROLE_MESSAGE);
    }

    const outcome = await sourceOpen.handle(message, caller);
    if (isErr(outcome)) {
      return outcome;
    }
    return outcome.value.delivered
      ? ok(undefined)
      : refusal('TRANSPORT_DISCONNECTED', NO_EDITOR_MESSAGE);
  }

  /* ---- the public surface ---- */

  function attach(server: UpgradeSource): Result<void, DebuggenError> {
    if (closed) {
      return refusal('TRANSPORT_DISCONNECTED', SERVER_CLOSED_MESSAGE);
    }
    if (attached.has(server)) {
      return refusal('INTERNAL', ALREADY_ATTACHED_MESSAGE);
    }
    server.on('upgrade', handleUpgrade);
    attached.add(server);
    return ok(undefined);
  }

  function stats(): WsServerStats {
    let awaitingHello = 0;
    let authenticated = 0;
    let pendingFrames = 0;
    for (const state of connections.values()) {
      if (state.phase === 'awaiting-hello') {
        awaitingHello += 1;
      } else if (state.phase === 'authenticated') {
        authenticated += 1;
      }
      pendingFrames += state.pending;
    }
    return Object.freeze({
      open: connections.size,
      awaitingHello,
      authenticated,
      pendingFrames,
      offlineRetained: retained.size,
      attached: attached.size,
      heartbeatActive: heartbeat !== undefined,
      closed,
    });
  }

  async function shutdown(): Promise<void> {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    for (const server of attached) {
      server.off('upgrade', handleUpgrade);
    }
    attached.clear();

    // `ws` refuses any handshake still in flight once its server is closing.
    const serverClosed = new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });

    const states = [...connections.values()];
    for (const state of states) {
      closeConnection(state, CLOSE_DIRECTIVES.shutdown);
    }
    // Each socket settles on its own `close` event, which the terminate
    // fallback of `closeConnection` guarantees within the grace period.
    await Promise.all(states.map((state) => state.closed));
    await settleWithin(Promise.all(states.map((state) => state.tail)), CLOSE_HANDSHAKE_GRACE_MS);

    // Connections that closed earlier and are still within their grace period
    // are unregistered now, so no retirement timer outlives the server.
    for (const [clientId, timer] of retained) {
      clearTimeout(timer);
      clients.unregister(clientId);
    }
    retained.clear();
    await serverClosed;
    log.debug('the WebSocket server closed', { connections: states.length });
  }

  function close(): Promise<void> {
    if (closePromise === undefined) {
      closed = true;
      closePromise = shutdown();
    }
    return closePromise;
  }

  if (heartbeatIntervalMs > 0) {
    heartbeat = setInterval(() => {
      guarded('the heartbeat failed unexpectedly', undefined, beat);
    }, heartbeatIntervalMs);
    heartbeat.unref();
  }

  return ok(Object.freeze({ attach, handleUpgrade, stats, close }));
}
