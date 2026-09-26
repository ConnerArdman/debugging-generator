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
 * TCP socket destroyed — no WebSocket is ever created — when (checked in this
 * order):
 *
 * | Condition | HTTP status |
 * | --- | --- |
 * | the server is closing | 503 |
 * | the path is not `WS_PATH` | 404 |
 * | the `Origin` header is refused by `./auth.ts`'s `isAllowedOrigin` (every `http:`/`https:` web origin, `file:`, `data:`, `null`, anything unparseable) | 403 |
 * | this peer already holds its share of unauthenticated sockets (`maxPendingHandshakesPerPeer`) | 429, with `Retry-After` |
 * | every peer together already holds the unauthenticated share (`maxPendingHandshakes`) | 429, with `Retry-After` |
 * | the service already holds its most sockets in any phase (`maxOpenConnections`) | 503, with `Retry-After` |
 *
 * Every refusal carries `Connection: close`, `Content-Length: 0`,
 * `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, and nothing
 * the client sent. A client answered 429 or 503 with `Retry-After` retries no
 * sooner than that many seconds, with its usual backoff.
 *
 * **Admission.** An upgrade that passes the path and origin checks reserves a
 * slot *before* `ws` allocates anything for it: one of the service's open
 * sockets, and one pending handshake counted both globally and against its
 * peer (the TCP remote address, IPv4-mapped IPv6 folded to IPv4; a socket with
 * no readable address shares one bucket). The pending share is given back the
 * moment the hello authenticates the connection; the whole slot is given back
 * when the TCP socket closes — whatever phase it closed in, including a
 * handshake `ws` aborted without ever creating a WebSocket. A pending share
 * therefore lasts at most the hello window plus the closing grace period,
 * which is the `Retry-After` of both refusals. The defaults
 * ({@link DEFAULT_MAX_PENDING_HANDSHAKES},
 * {@link DEFAULT_MAX_PENDING_HANDSHAKES_PER_PEER},
 * {@link DEFAULT_MAX_OPEN_CONNECTIONS}) are far above what a few editors, a
 * service worker and a few dev servers hold, and bound what an unauthenticated
 * local process can make the service keep for it. The authenticated
 * population is bounded separately, after the hello, by the client registry.
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
 * `error` message — `{ code, message, ref }` — **and the connection stays open**.
 * Every such reply carries a `ref`: the offending frame's `id` when it can be
 * read and is spelled exactly as this product mints message ids — `msg_`
 * followed by sixteen characters of `[0-9a-z]`, `@debuggen/shared`'s
 * `newMessageId` contract, which is how every product client builds its
 * envelopes — and otherwise (a binary frame, text that is not JSON, a missing
 * `id`, or any `id` of another spelling) an id the service minted. Either way
 * it is the very ref the service's log records of that failure carry, so a
 * client — or a developer holding its reply — can find the diagnostic, and two
 * concurrent failures of the same code stay apart. The grammar is what keeps
 * a peer-chosen string out of the log: a conforming id can hold nothing but
 * sixteen lower-case alphanumerics, never a URL, a query, a statement or a
 * path, so a client that spells its ids otherwise matches its replies by the
 * minted ref rather than by its own id.
 * One bad frame never closes a socket and never takes the process down.
 *
 * `error` travels from the service to clients only (AAP §0.4.2), so an inbound
 * `error` frame is refused exactly like a spoofed service push: it is answered
 * with one `error` whose `ref` names it by the rule above, and the connection
 * stays open. The reply cannot start a loop between product peers, because
 * none of them ever sends an `error` frame — protocol's reconnecting client,
 * the Chrome service worker, the VS Code service client and the Node preload's
 * control channel only consume them. A peer that answered errors with errors
 * would itself be breaking the protocol, and each reply's `ref` names the frame
 * that provoked it.
 *
 * **Source navigation is answered.** A `source.open` the handler refuses is
 * answered with `error`, like any other refused frame. One it accepts is
 * answered exactly once with protocol's `source.result`, sent to the sender
 * alone with `ref` set to the sender's own frame `id`: `no-editor` at once when
 * no VS Code window of the project is connected (the sender's cue for the
 * `vscode://` URI fallback), otherwise `opened` or `failed` once an editor has
 * answered the forwarded frame or the protocol's editor deadline has passed.
 * The wait never blocks the sender's frame queue: the answer is relayed when it
 * settles, while later frames on the connection are processed as usual.
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
 * traffic again without a re-bind. An editor connection's announced workspace
 * is likewise kept for the same grace period, as a lease bounded by
 * `./auth.ts`'s `MAX_WORKSPACE_ANNOUNCEMENT_LEASE_MS`, so the editor's HTTP
 * requests — VS Code's `deactivate()` ending its sessions, a request racing a
 * reconnect — are not refused for a project it announced moments earlier; a
 * zero grace period or a closing server withdraws it at once. Ordinary
 * disconnects are logged at debug.
 *
 * ## Authority comes from the principal, never from the frame
 *
 * After the hello, a connection's identity is the `Principal` `./auth.ts`
 * resolved from the stored credential. The hello's `client`, `projectRoot` and
 * `tabId` are kept only as facts about the connection. The rules of AAP §0.5.6
 * are applied through `./auth.ts`'s `requireRole` and `requireBoundSession`,
 * never re-derived.
 *
 * A DevTools credential is shared by every tab the paired extension inspects,
 * and the MV3 service worker multiplexes all of them over one connection, so a
 * DevTools frame acting on a session states its **acting tab**: the envelope's
 * `tabId`, or — on a single-tab connection that announced a `tabId` in its
 * hello — that tab (a frame naming a different one is refused). The acting tab
 * must be the session's live bound tab, bound by this credential; a frame that
 * names no tab is refused rather than attributed to one. A frame about the one
 * tab its payload names acts for that tab, and a single-tab connection speaks
 * for its hello's tab only, so a payload naming another tab is refused
 * (`TAB_NOT_BOUND`) before its handler runs. The rows above the last name
 * nine message types, which are the whole inbound vocabulary; the last row
 * covers every other type:
 *
 * | Inbound message | Who may send it | Routed to |
 * | --- | --- | --- |
 * | `client.hello` | the first frame of every connection; a second one is refused | `AuthService.authorizeHello` |
 * | `session.bind`, `tab.navigated`, `session.unbind` | `devtools`, each for the tab its payload names — on a single-tab connection only its hello's tab | `./routes/binding.ts`, which owns the binding rules |
 * | `telemetry.event` | `devtools` (the service worker relaying the page agent), for its acting tab's live binding | `./routes/telemetry.ts`, which owns the relayed-tab rule |
 * | `agent.ready` | `devtools`, for the tab its payload names — on a single-tab connection only its hello's tab — when no other credential has bound it | the injected {@link AgentReadinessPort} |
 * | `target.selected` | `devtools`, for the session bound to its acting tab, and only for an element of the document that tab currently shows | the injected {@link TargetSelectionPort} |
 * | `source.open` | `devtools` for the session bound to its acting tab; `vscode` within its announced workspace | the injected {@link SourceOpenPort}, which contains the path and forwards it to the session's editors; the sender is answered with `source.result` |
 * | `source.result` | `vscode`, answering a `source.open` the service forwarded to it, within its announced workspace | {@link SourceOpenPort.acceptEditorResult}, which settles the forward; the outcome is relayed to the original sender as `source.result` |
 * | every service push (`session.updated`, `agent.config`, `server-agent.config`, `panel.generated`, `target.request`, …) and the reply-only `error` | nobody — a client cannot spoof a service push or send an `error` | refused with `error` |
 *
 * `target.request` is one of those pushes, and this module never emits it.
 * The service sends it in answer to the editor's
 * `POST /sessions/:id/target/request` (`./routes/sessions.ts`), through the
 * registry's `sendToBoundTab`, to the connection of that session's bound tab
 * alone; a `target.request` a client sends — to put some other panel into
 * picker mode — is refused here like every other service push.
 *
 * A `target.selected` descriptor is assembled in the page, a document that
 * may have interfered with it, so being sent by the bound tab's credential is
 * not enough: its `url` must name the document the binding says the tab shows
 * now (protocol's `compareSelectionDocument`: same origin, same path), compared
 * in the redacted form the binding stores it in. A
 * selection left over from a document the tab has since navigated away from,
 * or one forged to name another origin, is refused with `TAB_NOT_BOUND` — the
 * `error` whose `ref` is the refused frame's id, which is how the sending panel
 * retracts the selection it showed as pending — and never reaches the session.
 *
 * A `server-agent` connection sends nothing after its hello: it posts telemetry
 * over HTTP and only receives `server-agent.config`, so every frame it sends is
 * refused by the role guards above. The page agent owns no socket; its
 * `agent.ready` and telemetry batches arrive on the tab's `devtools` connection
 * and are attributed to that connection's principal.
 *
 * **Replay on connect.** A producer connection — `server-agent`, or the
 * `devtools` connection that relays the page agent — is announced to the
 * injected {@link ProducerConnectionPort} as soon as it registers, with the
 * registry's own facts about it (the credential-scoped project, the
 * credential-bound sessions). Its first frames may therefore be the
 * `server-agent.config` or `agent.config` its producer is owed: the armed
 * configuration of an open capture, or a dormant one that could not be
 * delivered while it was away.
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
 * connection ids, client kinds, message types, close codes, error codes and
 * refs. A caught exception is logged one way only (`exceptionFields`): a ref,
 * `../logging.ts`'s closed `describeException` classification, and the value
 * itself solely under `LOG_ERROR_FIELD_KEY`, whose serializer decides what of
 * its message or stack a record may hold — never its `name`, `message` or
 * string form in a field of its own. That serializer adds the redacted
 * message and stack only to a record written at `debug` or `trace`, so every
 * `warn`/`error` record of an exception is followed by a `debug` twin carrying
 * the same fields and the same ref under the constant
 * `EXCEPTION_DIAGNOSTIC_MESSAGE`: the operating levels hold the closed
 * classification, and a developer who opts into `debug` finds the redacted
 * detail under the ref the client's reply named.
 *
 * ## Lifetime
 *
 * {@link WsServer.close} stops accepting upgrades, detaches from every HTTP
 * server it was attached to, stops the heartbeat, closes every socket (both
 * authenticated ones and ones still awaiting their hello), terminates any that
 * do not finish the closing handshake within a short grace period, waits for
 * in-flight frame handlers to settle, destroys any socket still inside the
 * `ws` handshake, and unregisters every connection still retained offline — so
 * `startService(...).close()` leaves no open socket, no live timer, no
 * admission reservation and no registration of this server's between
 * integration suites.
 * Before any socket is closed it closes the {@link SourceOpenPort}, which
 * settles every forward still awaiting an editor, and gives those answers the
 * same grace period to reach their senders, so no editor deadline outlives the
 * server. Every timer this module starts is `unref()`ed as well.
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
import { isIPv4 } from 'node:net';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import {
  CLIENT_HELLO_TIMEOUT_MS,
  MESSAGE_TYPE,
  PROTOCOL_VERSION,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
  compareSelectionDocument,
  createEnvelope,
  decodeMessage,
  errorPayloadSchema,
  isMessageOfType,
  isPlainRecord,
  parseMessage,
  parseSourceResultPayload,
  toErrorPayload,
} from '@debuggen/protocol';
import type {
  AgentReadyPayload,
  ClientKind,
  ErrorPayload,
  MessageByType,
  ProtocolMessage,
  SelectedTarget,
  SelectionDocumentVerdict,
  SourceResultPayload,
} from '@debuggen/protocol';
import {
  DebuggenError,
  ID_PREFIXES,
  assertNever,
  err,
  isErr,
  newMessageId,
  noopLogger,
  ok,
} from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result, SessionId } from '@debuggen/shared';

import {
  LOG_BINDING_KEYS,
  LOG_ERROR_FIELD_KEY,
  describeException,
  guardLogger,
  subsystemLogger,
} from '../logging.js';
import { authFailureReasonOf, isAllowedOrigin, requireBoundSession, requireRole } from './auth.js';
import type {
  AuthFailureReason,
  AuthService,
  Principal,
  PrincipalRole,
  WorkspaceAnnouncement,
} from './auth.js';
import {
  DEFAULT_MAX_CLIENTS,
  DEFAULT_OFFLINE_GRACE_MS,
  MAX_CLOSE_REASON_BYTES,
  WS_CLOSE_GOING_AWAY,
  WS_CLOSE_TRY_AGAIN_LATER,
} from './clients.js';
import type { ClientRegistry, RegisteredClient, TabBindingView } from './clients.js';
import { redactBoundUrl, serializedOriginOf } from './routes/binding.js';
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
 * The most sockets admitted but not yet authenticated at once, across every
 * peer: upgrades inside the `ws` handshake, sockets awaiting their hello, and
 * refused ones still finishing their closing handshake.
 *
 * Every legitimate client authenticates in its first frame, within protocol's
 * `CLIENT_HELLO_TIMEOUT_MS`, so this population is a handful at a time even
 * when every editor window, the MV3 service worker and several dev servers
 * reconnect together after a service restart. 64 leaves an order of magnitude
 * of headroom for that burst while bounding what an unauthenticated local
 * process can hold open to 64 sockets (and their timers) for one hello window.
 * Past it an upgrade is answered 429.
 */
export const DEFAULT_MAX_PENDING_HANDSHAKES = 64;

/**
 * The most admitted-but-unauthenticated sockets one peer — one TCP remote
 * address — may hold at once. Past it that peer's upgrade is answered 429
 * while other peers are still admitted.
 *
 * On the loopback interface the service binds, the peers are the IPv4 and IPv6
 * loopback addresses, so half of {@link DEFAULT_MAX_PENDING_HANDSHAKES} keeps
 * one address family from starving the other.
 */
export const DEFAULT_MAX_PENDING_HANDSHAKES_PER_PEER = 32;

/**
 * The most WebSocket sockets the service keeps open at once, in any phase:
 * every connection the client registry may hold after its hello
 * (`DEFAULT_MAX_CLIENTS`) plus the unauthenticated share
 * ({@link DEFAULT_MAX_PENDING_HANDSHAKES}), 320 in all. Past it an upgrade is
 * answered 503.
 *
 * It is also the ceiling of the `maxOpenConnections` option — the value may be
 * lowered but never raised — so the composition root can size the HTTP
 * server's own connection limit above it and keep sockets free for HTTP
 * requests however many WebSockets are open.
 */
export const DEFAULT_MAX_OPEN_CONNECTIONS = DEFAULT_MAX_CLIENTS + DEFAULT_MAX_PENDING_HANDSHAKES;

/**
 * The shortest interval between two `warn` records of refused upgrades, in
 * milliseconds. A refusal inside the interval is filed at `debug` and counted,
 * and the next `warn` carries that count, so a flood of upgrades cannot turn
 * into a flood of log records at the operating levels.
 */
const ADMISSION_WARN_INTERVAL_MS = 60_000;

/**
 * The admission bucket of a socket whose remote address cannot be read (it
 * closed before the gate ran, or the transport has none): every such socket
 * shares it, so an unreadable address never escapes the per-peer quota.
 */
const UNKNOWN_PEER = 'unknown';

/** The prefix of an IPv4 address written as an IPv4-mapped IPv6 address. */
const IPV4_MAPPED_PREFIX = '::ffff:';

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
 * The three message types this module names outside its exhaustive switch
 * (the hello, the `error` reply and the `source.result` answer), and the three
 * roles it names. The message types are protocol's own `MESSAGE_TYPE`
 * constants — the one place each wire name is spelled, and the same constants
 * the switch in `route` is labelled with — which keep their literal types, so
 * `isMessageOfType` and `createEnvelope` still narrow. The roles are literals
 * checked by `satisfies` against `./auth.ts`'s role vocabulary. Either way a
 * rename upstream is a compile error here rather than a silent mismatch on the
 * wire.
 */
const HELLO_TYPE = MESSAGE_TYPE.CLIENT_HELLO;
const ERROR_REPLY_TYPE = MESSAGE_TYPE.ERROR;
const SOURCE_RESULT_TYPE = MESSAGE_TYPE.SOURCE_RESULT;
const DEVTOOLS_ROLE = 'devtools' satisfies PrincipalRole;
const EDITOR_ROLE = 'vscode' satisfies PrincipalRole;
const SERVER_AGENT_ROLE = 'server-agent' satisfies PrincipalRole;

/**
 * The roles whose connections carry a telemetry producer — the Node preload,
 * and the service worker that relays the page agent — and are therefore told
 * to the {@link ProducerConnectionPort} when they register.
 */
const PRODUCER_ROLES: readonly PrincipalRole[] = Object.freeze([DEVTOOLS_ROLE, SERVER_AGENT_ROLE]);

/**
 * The one answer of protocol's `compareSelectionDocument` under which a
 * `target.selected` descriptor is recorded: the element is of the document
 * the bound tab currently shows. Checked against protocol's closed verdict
 * vocabulary, so a renamed verdict is a compile error here.
 */
const SAME_DOCUMENT_VERDICT = 'same-document' satisfies SelectionDocumentVerdict;

/** The roles that may send the three binding messages: only the DevTools connection binds a tab. */
const BINDING_ROLES: readonly PrincipalRole[] = Object.freeze([DEVTOOLS_ROLE]);

/** The roles that may relay the page agent's `agent.ready`. */
const AGENT_RELAY_ROLES: readonly PrincipalRole[] = Object.freeze([DEVTOOLS_ROLE]);

/** The roles that may ask for a source location to be opened in the editor. */
const SOURCE_OPEN_ROLES: readonly PrincipalRole[] = Object.freeze([EDITOR_ROLE, DEVTOOLS_ROLE]);

/** The roles that may answer a forwarded `source.open`: only the editor it was forwarded to. */
const SOURCE_RESULT_ROLES: readonly PrincipalRole[] = Object.freeze([EDITOR_ROLE]);

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
  'acting-tab-required': 'claimsRefused',
  'acting-tab-invalid': 'claimsRefused',
  'acting-tab-not-permitted': 'claimsRefused',
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
const CLIENT_ERROR_FRAME_MESSAGE =
  'Error frames travel from the Debug Generator service to its clients only; a client may not send one.';
const BINARY_FRAME_MESSAGE =
  'Binary WebSocket frames are not part of the Debug Generator protocol; send JSON text frames.';
const MISSING_BINDING_MESSAGE =
  'This DevTools client may act only on the session its inspected tab is bound to.';
const SELECTION_DOCUMENT_MESSAGE =
  'The selected element is not from the document the bound tab currently shows; select it again in that page.';
const ACTING_TAB_CONFLICT_MESSAGE =
  'This connection announced one inspected tab in its hello and may act only for that tab; the frame named another.';
const SOURCE_OPEN_ROLE_MESSAGE =
  'Only a VS Code or DevTools connection may ask for a source location to be opened.';
const SOURCE_RESULT_ROLE_MESSAGE =
  'Only the VS Code connection a source location was forwarded to may answer it.';
const SOURCE_OPEN_REFUSED_MESSAGE =
  'The Debug Generator local service refused to open this source location. Its log holds the reason.';
const SOURCE_OPEN_UNANSWERABLE_MESSAGE =
  'The source.open frame id is longer than its source.result answer can reference, so the location was not opened. Send the request under a protocol message id.';
const HANDLER_FAILURE_MESSAGE =
  'The Debug Generator local service failed unexpectedly while handling this frame. Its log holds the reason under this ref.';
const UNREPORTABLE_FAILURE_MESSAGE =
  'The Debug Generator local service could not describe this failure. Its log holds the reason under this ref.';
const SERVER_CLOSED_MESSAGE = 'The WebSocket server is closed.';
const ALREADY_ATTACHED_MESSAGE = 'The WebSocket server is already attached to this HTTP server.';

/**
 * The record message of an upgrade refused by the admission quotas. Constant,
 * like every record message of this module; the record's fields are counts,
 * limits and the closed refusal category, never the peer's address.
 */
const ADMISSION_REFUSED_LOG = 'refused a WebSocket upgrade past its admission quota';

/**
 * The record message of each socket or timer callback {@link createWsServer}
 * runs through its `guarded` wrapper, by the callback it names.
 *
 * A record's message is free text that no serializer governs, so the wrapper
 * takes a *key* of this table rather than a string: a caller cannot hand it an
 * interpolated sentence carrying a frame, a path or an exception's words, and
 * a new callback needs its constant sentence here before it compiles.
 */
const GUARDED_ACTION_MESSAGES = Object.freeze({
  accept: 'accepting a WebSocket connection failed unexpectedly',
  frame: 'handling a WebSocket frame failed unexpectedly',
  pong: 'handling a heartbeat pong failed unexpectedly',
  socketError: 'handling a WebSocket error failed unexpectedly',
  close: 'handling a WebSocket close failed unexpectedly',
  helloDeadline: 'the hello deadline failed unexpectedly',
  retire: 'retiring an offline connection failed unexpectedly',
  heartbeat: 'the heartbeat failed unexpectedly',
  sourceResult: 'relaying a source.result answer failed unexpectedly',
  sourceClose: 'closing source navigation failed unexpectedly',
} as const satisfies Readonly<Record<string, string>>);

/** One callback of {@link GUARDED_ACTION_MESSAGES}. */
type GuardedAction = keyof typeof GUARDED_ACTION_MESSAGES;

/**
 * The message of the `debug` twin that follows every `warn` or `error` record
 * of a caught exception (see `logException` in {@link createWsServer}).
 *
 * Constant like every record message of this module: the twin is found by its
 * `ref`, which is the ref of the record it follows and of the `error` reply
 * that answered the failure, and what it adds — the exception's message and
 * stack after `../logging.ts`'s diagnostic redaction — sits under
 * `LOG_ERROR_FIELD_KEY`, never in the message.
 */
const EXCEPTION_DIAGNOSTIC_MESSAGE = 'diagnostic detail of the failure filed under this ref';

/** The levels a caught exception is filed at before its `debug` twin. */
type ExceptionLevel = 'warn' | 'error';

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
 * the session's tab binding, and the descriptor proved to be of the document
 * that tab currently shows. Must not throw; a failure is an `Err`.
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
  /**
   * The registry's id for the connection. Not an authority: the handler uses it
   * only to count one editor's repeated answers once.
   */
  readonly connectionId?: string | undefined;
}

/** Each member of a `source.result` payload union, without its per-hop `sessionId` and `ref`. */
type WithoutCorrelation<T> = T extends unknown ? Omit<T, 'sessionId' | 'ref'> : never;

/**
 * How the editors answered a delivered `source.open`: `opened`, or `failed`
 * with its `{ code, message, hint? }`. Derived from protocol's
 * `SourceResultPayload` — the `no-editor` member excluded, since this module
 * answers that one itself — so the relayed frame is the protocol's shape by
 * construction once the sender's `sessionId` and `ref` are added back.
 */
export type SourceOpenEditorOutcome = WithoutCorrelation<
  Exclude<SourceResultPayload, { readonly status: 'no-editor' }>
>;

/**
 * The outcome of a `source.open` as this module needs to see it.
 *
 * - `delivered: false` — the location passed every check but no VS Code window
 *   was connected; the sender is answered `source.result` `no-editor` at once,
 *   its cue for the editor's URI-handler fallback.
 * - `delivered: true` — an editor received the forwarded frame; `editorResult`
 *   settles, and never rejects, with what the editors answered (or `failed`
 *   when none answered in time), which is relayed to the sender.
 */
export type SourceOpenDelivery =
  | { readonly delivered: false }
  | {
      readonly delivered: true;
      readonly editorResult: Promise<SourceOpenEditorOutcome>;
    };

/**
 * Where source navigation goes: `src/source/open.ts`'s handler. `handle`
 * re-validates a `source.open`, looks up the session's project root, authorizes
 * the caller, contains the path lexically and on the filesystem, and forwards
 * the location to the session's editor clients through the client registry;
 * `acceptEditorResult` settles a forward with an editor's `source.result`; and
 * `close` settles every forward still waiting when this server shuts down.
 *
 * Satisfied structurally by `createSourceOpenHandler(...)`. Must not throw.
 */
export interface SourceOpenPort {
  handle(
    message: MessageByType<'source.open'>,
    caller: SourceOpenCaller,
  ): MaybePromise<Result<SourceOpenDelivery, DebuggenError>>;
  acceptEditorResult(
    message: MessageByType<'source.result'>,
    caller: SourceOpenCaller,
  ): MaybePromise<Result<unknown, DebuggenError>>;
  close(): void;
}

/** What {@link ProducerConnectionPort.producerConnected} is told about a registered producer connection. */
export interface ProducerConnectionFacts {
  /** The connection's kind: the credential's role, `server-agent` or `devtools`. */
  readonly kind: ClientKind;
  /** A `server-agent` connection's project root: its credential's scope, as the registry recorded it. */
  readonly projectRoot?: string | undefined;
  /** The sessions whose tab bindings a `devtools` connection's credential carries. */
  readonly sessionIds?: readonly string[] | undefined;
  /**
   * When the connection's credential was issued, from the resolved principal:
   * a producer whose credential predates the service may hold what an earlier
   * process configured.
   */
  readonly credentialIssuedAt?: number | undefined;
}

/**
 * Told about every producer connection — the Node preload's `server-agent`
 * connection and the Chrome service worker's `devtools` connection, which
 * relays the page agent — right after it registers, so the configuration its
 * producer is owed is replayed to it: the armed configuration of an open
 * capture, or the dormant one a disarm could not deliver while the producer
 * was away (a suspended MV3 service worker, a restarting service). AAP §0.4.2
 * has no frame a producer could ask for it with, so the service offers it.
 *
 * Satisfied structurally by the instrumentation service's
 * `ProducerReconciler.producerConnected`. Called after the connection is
 * authenticated and registered, so a frame it sends reaches the new
 * connection. Must not throw; what it replays, and whether it was delivered,
 * it logs itself.
 */
export interface ProducerConnectionPort {
  producerConnected(connection: ProducerConnectionFacts): unknown;
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
  /** Handles `source.open` requests and the editors' `source.result` answers. */
  readonly sourceOpen: SourceOpenPort;
  /**
   * Told about each producer connection as it registers, so what its producer
   * is owed is replayed. Omitted, nothing is replayed on connect.
   */
  readonly producers?: ProducerConnectionPort | undefined;
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
  /**
   * The most sockets open at once in any phase; the next upgrade is answered
   * 503. An integer from 1 to {@link DEFAULT_MAX_OPEN_CONNECTIONS}, which is
   * also the default: it may be lowered (a test does) but never raised.
   */
  readonly maxOpenConnections?: number | undefined;
  /**
   * The most sockets admitted but not yet authenticated at once, across every
   * peer; the next upgrade is answered 429. An integer from 1 to
   * `maxOpenConnections`; defaults to {@link DEFAULT_MAX_PENDING_HANDSHAKES},
   * or `maxOpenConnections` when that is smaller.
   */
  readonly maxPendingHandshakes?: number | undefined;
  /**
   * The most sockets one peer (TCP remote address) may hold admitted but not
   * yet authenticated at once; that peer's next upgrade is answered 429. An
   * integer from 1 to `maxPendingHandshakes`; defaults to
   * {@link DEFAULT_MAX_PENDING_HANDSHAKES_PER_PEER}, or `maxPendingHandshakes`
   * when that is smaller.
   */
  readonly maxPendingHandshakesPerPeer?: number | undefined;
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
  /**
   * Sockets holding an admission slot: every upgrade the gate admitted whose
   * TCP socket has not closed yet, whether it is inside the `ws` handshake,
   * awaiting its hello, authenticated or closing. Bounded by
   * `maxOpenConnections`.
   */
  readonly admitted: number;
  /**
   * Admitted sockets that have not authenticated: inside the `ws` handshake,
   * awaiting their hello, or closing after a refused one. Bounded by
   * `maxPendingHandshakes`.
   */
  readonly pendingHandshakes: number;
  /** Distinct peers holding at least one of {@link pendingHandshakes}. */
  readonly pendingPeers: number;
  /** Upgrades refused by the admission quotas (429 or 503) since the server was created. */
  readonly refusedUpgrades: number;
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
   * path, then origin, then admission (the per-peer and global pending-handshake
   * quotas and the open-socket cap), then the `ws` handshake. Never throws; a
   * refused upgrade is answered with an HTTP status and the TCP socket
   * destroyed.
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
 * Why the upgrade gate refused to admit a socket, in the order the gate checks:
 * the peer's pending share, the global pending share, the open-socket cap.
 */
type AdmissionRefusal = 'peer-quota' | 'pending-quota' | 'capacity';

/**
 * The HTTP status each admission refusal is answered with: 429 when the
 * unauthenticated share is exhausted — the caller, or the crowd of callers that
 * have not authenticated, is asking too often — and 503 when the service is at
 * its socket capacity whoever is asking.
 */
const ADMISSION_REFUSAL_STATUS = Object.freeze({
  'peer-quota': 429,
  'pending-quota': 429,
  capacity: 503,
} as const satisfies Readonly<Record<AdmissionRefusal, number>>);

/** The validated admission bounds of one server. */
interface AdmissionLimits {
  readonly maxOpenConnections: number;
  readonly maxPendingHandshakes: number;
  readonly maxPendingHandshakesPerPeer: number;
}

/**
 * One admitted socket's reservation. Each method gives back its share at most
 * once however often, and in whatever order, it is called, so every path that
 * can end a handshake or a socket may call it without coordinating.
 */
interface AdmissionTicket {
  /** Gives back the pending-handshake share: the hello authenticated the connection. */
  authenticated(): void;
  /** Gives back everything the ticket still holds: the socket closed. */
  release(): void;
}

/** The gate's answer to one upgrade. */
type AdmissionDecision =
  | { readonly admitted: true; readonly ticket: AdmissionTicket }
  | {
      readonly admitted: false;
      readonly refusal: AdmissionRefusal;
      /** The refused peer's pending handshakes at the time — a count, never the address. */
      readonly peerPending: number;
    };

/** The ledger's counters, as {@link WsServerStats} reports them. */
interface AdmissionSnapshot {
  readonly admitted: number;
  readonly pendingHandshakes: number;
  readonly pendingPeers: number;
}

/** The admission counters of one server; see {@link createAdmissionLedger}. */
interface AdmissionLedger {
  /** Reserves a slot for `peer`, or says which bound refuses it. */
  admit(peer: string): AdmissionDecision;
  /** The current counters. */
  snapshot(): AdmissionSnapshot;
}

/**
 * Everything this module keeps about one socket. No field holds the credential:
 * the hello's token lives only in the local variables of the handshake.
 */
interface ConnectionState {
  readonly socket: WebSocket;
  /** The upgrade request's raw `Origin` header, for the hello's origin check. Never logged. */
  readonly origin: string | undefined;
  /** The admission slot the upgrade gate reserved for this socket. */
  readonly admission: AdmissionTicket;
  phase: ConnectionPhase;
  /** The hello deadline, while awaiting the hello. */
  helloTimer: TimerHandle | undefined;
  /** The terminate fallback of a closing handshake this module started. */
  closeTimer: TimerHandle | undefined;
  /** The registry's id for the connection, once registered. */
  clientId: string | undefined;
  /** The registered kind, for log records. */
  kind: ClientKind | undefined;
  /** An editor connection's workspace announcement, released (or leased for the offline grace) on close. */
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
 * The inspected tab a DevTools frame acts for — the tab
 * `./auth.ts`'s `requireBoundSession` checks against the session's live
 * binding, because the connection's credential is shared by every tab the
 * paired extension inspects and so cannot say which one is acting.
 *
 * - The envelope's `tabId` is the frame's own statement of its tab: the MV3
 *   service worker multiplexes every tab over one connection and names the
 *   tab on each frame, from Chrome's port metadata.
 * - A connection that announced a `tabId` in its `client.hello` is a
 *   single-tab connection and acts only for that tab: a frame naming another
 *   tab is refused (`TAB_NOT_BOUND`), never re-attributed to either.
 * - Otherwise the envelope's tab, else the hello's; `undefined` when neither
 *   names one, which the guard refuses for any action on a session.
 *
 * A frame whose payload names its own tab is held to the same single-tab rule
 * by {@link requireAnnouncedTab}.
 *
 * @param client The connection the frame arrived on.
 * @param message The parsed frame.
 * @returns The acting tab, `undefined` when none is named, or the refusal.
 */
function actingTabOf(
  client: Pick<RegisteredClient, 'tabId'>,
  message: Pick<ProtocolMessage, 'tabId'>,
): Result<number | undefined, DebuggenError> {
  const named = message.tabId;
  const announced = client.tabId;
  if (named !== undefined && announced !== undefined && named !== announced) {
    return refusal('TAB_NOT_BOUND', ACTING_TAB_CONFLICT_MESSAGE);
  }
  return ok(named ?? announced);
}

/**
 * The single-tab rule for a frame about the one tab its payload names —
 * `session.bind`, `tab.navigated`, `session.unbind` and `agent.ready` — whose
 * handlers take that payload tab as the acting tab.
 *
 * - A connection that announced a `tabId` in its `client.hello` is a
 *   single-tab connection and speaks for that tab only, so a payload naming
 *   any other tab is refused (`TAB_NOT_BOUND`) before a handler runs. Without
 *   this, the DevTools credential — shared by every tab the paired extension
 *   inspects — would let a connection for tab A bind, navigate or unbind tab
 *   B, or report tab B's page agent ready.
 * - A connection whose hello named no tab (the MV3 service worker, which
 *   multiplexes every inspected tab) is unaffected: protocol already refuses a
 *   frame whose envelope `tabId` contradicts its payload's, so the payload's
 *   tab is that frame's acting tab.
 *
 * The same rule {@link actingTabOf} applies to an envelope `tabId`, with the
 * same constant refusal.
 *
 * @param client The connection the frame arrived on.
 * @param payloadTab The tab the frame's payload names.
 * @returns `ok`, or the `TAB_NOT_BOUND` refusal.
 */
function requireAnnouncedTab(
  client: Pick<RegisteredClient, 'tabId'>,
  payloadTab: number,
): Result<void, DebuggenError> {
  const announced = client.tabId;
  if (announced !== undefined && payloadTab !== announced) {
    return refusal('TAB_NOT_BOUND', ACTING_TAB_CONFLICT_MESSAGE);
  }
  return ok(undefined);
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
 * The admission bucket of an upgrade: its TCP remote address, lower-cased, with
 * an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`, what a dual-stack listener
 * reports for an IPv4 peer) folded to the IPv4 address it maps, so one peer is
 * one bucket whichever way the listener was bound. An absent or empty address
 * is {@link UNKNOWN_PEER}, one bucket every such socket shares.
 *
 * The key is used for counting only: it is never logged or sent anywhere.
 *
 * @example
 * ```ts
 * peerKeyOf('::ffff:127.0.0.1'); // → '127.0.0.1'
 * peerKeyOf('::1');              // → '::1'
 * peerKeyOf(undefined);          // → 'unknown'
 * ```
 */
function peerKeyOf(address: string | undefined): string {
  if (address === undefined || address.length === 0) {
    return UNKNOWN_PEER;
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith(IPV4_MAPPED_PREFIX)) {
    const mapped = normalized.slice(IPV4_MAPPED_PREFIX.length);
    if (isIPv4(mapped)) {
      return mapped;
    }
  }
  return normalized;
}

/**
 * The admission counters of one server: how many sockets hold a slot, how many
 * of those have not authenticated, and how many of those each peer holds.
 *
 * {@link AdmissionLedger.admit} checks the three bounds in the order the
 * contract table states — the peer's pending share, the global pending share,
 * then the open-socket cap — so a refusal that a hello window will clear is
 * reported as the 429 whose `Retry-After` is exact, and only a service full of
 * authenticated sockets as the 503. An admitted socket's counts are held by its
 * {@link AdmissionTicket}, whose methods are idempotent. A peer's entry exists
 * only while it holds a pending share, so the map never outgrows
 * `maxPendingHandshakes` entries.
 *
 * Node runs every caller on one thread, so the counters need no locking; each
 * `admit` checks and reserves in one synchronous step.
 */
function createAdmissionLedger(limits: AdmissionLimits): AdmissionLedger {
  let admitted = 0;
  let pending = 0;
  const pendingByPeer = new Map<string, number>();

  function admit(peer: string): AdmissionDecision {
    const peerPending = pendingByPeer.get(peer) ?? 0;
    if (peerPending >= limits.maxPendingHandshakesPerPeer) {
      return { admitted: false, refusal: 'peer-quota', peerPending };
    }
    if (pending >= limits.maxPendingHandshakes) {
      return { admitted: false, refusal: 'pending-quota', peerPending };
    }
    if (admitted >= limits.maxOpenConnections) {
      return { admitted: false, refusal: 'capacity', peerPending };
    }
    admitted += 1;
    pending += 1;
    pendingByPeer.set(peer, peerPending + 1);

    let holdsPending = true;
    let holdsSlot = true;
    const releasePending = (): void => {
      if (!holdsPending) {
        return;
      }
      holdsPending = false;
      pending -= 1;
      const left = (pendingByPeer.get(peer) ?? 0) - 1;
      if (left > 0) {
        pendingByPeer.set(peer, left);
      } else {
        pendingByPeer.delete(peer);
      }
    };
    const ticket: AdmissionTicket = Object.freeze({
      authenticated: releasePending,
      release: (): void => {
        releasePending();
        if (holdsSlot) {
          holdsSlot = false;
          admitted -= 1;
        }
      },
    });
    return { admitted: true, ticket };
  }

  function snapshot(): AdmissionSnapshot {
    return { admitted, pendingHandshakes: pending, pendingPeers: pendingByPeer.size };
  }

  return Object.freeze({ admit, snapshot });
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

/**
 * The fields every record of a caught exception carries in this module.
 *
 * - `ref` — the record's correlation reference: a failed frame's reply ref,
 *   so the `error` its sender received names this very record, or a fresh
 *   message id for a socket- or server-level failure that answers no frame.
 * - `errorClass` / `errorCode` — `../logging.ts`'s closed
 *   {@link describeException} classification, safe at every level: a label
 *   from a fixed taxonomy and a closed-vocabulary code, never the value's own
 *   `name`, `message` or string form (a transport error's message can quote a
 *   peer address; a handler's can quote a path or a statement).
 * - `LOG_ERROR_FIELD_KEY` — the value itself, and nowhere else, so the
 *   service serializer alone decides what of its message or stack a record
 *   may hold.
 *
 * A `debug` record spreads these fields directly; a `warn` or `error` one goes
 * through `logException` inside {@link createWsServer}, which adds the `debug`
 * twin that alone can carry the redacted message and stack.
 *
 * Total: {@link describeException} never throws, whatever it is handed.
 *
 * @param cause Whatever was thrown, rejected or emitted as `error`.
 * @param ref The reference the record is filed under.
 * @returns A fresh field bag, to spread after the connection's own fields.
 *
 * @example
 * ```ts
 * log.debug('a heartbeat ping could not be sent', {
 *   ...fieldsOf(state),
 *   ...exceptionFields(cause, newMessageId()),
 * });
 * ```
 */
function exceptionFields(cause: unknown, ref: string): LogFields {
  return { ref, ...describeException(cause), [LOG_ERROR_FIELD_KEY]: cause };
}

/** A decoded frame, and the client id its failure reference is resolved from. */
interface DecodedFrame {
  readonly result: Result<ProtocolMessage, DebuggenError>;
  /**
   * The frame's own `id`, whenever one could be read — even from a frame that
   * failed validation. Peer-chosen text, and a *candidate* for the reply's
   * `ref` only: {@link failureRefFor} decides whether it is usable as one, and
   * nothing logs it before that decision.
   */
  readonly frameId: string | undefined;
}

/**
 * Decodes one text frame with protocol's `decodeMessage`, keeping the frame's
 * `id` as the candidate for the reply's `ref` even when the frame fails
 * validation.
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
    return { result: decodeMessage(text), frameId: undefined };
  }
  const result = decodeMessage(value);
  if (result.ok) {
    return { result, frameId: result.value.id };
  }
  const candidate = isPlainRecord(value) ? value['id'] : undefined;
  return { result, frameId: typeof candidate === 'string' ? candidate : undefined };
}

/**
 * Protocol's own rule for an `error` payload's `ref` (non-empty, bounded):
 * the same field schema the reply is verified against, so the decision of
 * which ref a failure is filed under can never disagree with what the reply
 * may carry.
 */
const ERROR_REF_SCHEMA = errorPayloadSchema.shape.ref;

/**
 * How many characters of `[0-9a-z]` follow the prefix and underscore of every
 * id this product mints. `packages/shared/src/ids.ts` keeps its `ID_ALPHABET`
 * and `ID_RANDOM_LENGTH` module-private, so the number is restated here from
 * the contract that module documents for `newId`: every id is 3 + 1 + 16 = 20
 * characters and matches `/^[a-z]{3}_[0-9a-z]{16}$/`. A change to that
 * contract is a change to this constant.
 */
const MINTED_ID_SUFFIX_LENGTH = 16;

/**
 * The exact spelling of a message id `newMessageId` mints: `ID_PREFIXES.message`
 * (`msg`), one underscore, then {@link MINTED_ID_SUFFIX_LENGTH} characters of
 * `[0-9a-z]`, anchored at both ends. The prefix is read from
 * `@debuggen/shared` rather than written out, so it cannot drift from the
 * generator.
 *
 * Only a client `id` of this spelling is reused as a failure reference. It is
 * the whole of what a conforming id can say: lower-case letters and digits,
 * twenty characters in all — no `/`, `?`, `=`, quote, space or dot, so no URL,
 * query value, SQL literal or path a peer chose can reach a log record through
 * the `ref` field, which the logger treats as an ordinary field and scrubs for
 * credential shapes only.
 */
const MINTED_MESSAGE_ID_PATTERN = new RegExp(
  `^${ID_PREFIXES.message}_[0-9a-z]{${String(MINTED_ID_SUFFIX_LENGTH)}}$`,
  'u',
);

/**
 * The one reference a failed frame is reported under — in every log record
 * about it and in the `error` reply its sender receives alike — so a developer
 * holding the reply finds the record, and two concurrent failures of the same
 * code are never confused.
 *
 * - The client's own frame `id`, when it matches
 *   {@link MINTED_MESSAGE_ID_PATTERN} — the product's own message-id grammar,
 *   which every product client satisfies because it builds envelopes with
 *   `createEnvelope`/`newMessageId` — and protocol's `error` payload accepts
 *   it as `ref`: the sender can then match the reply to the frame it sent.
 * - Otherwise a service-minted message id, used as is on the log records and
 *   the reply alike. That covers a binary frame, text that is not JSON, an
 *   `id` that is absent or not a string, and every `id` the envelope accepts
 *   but the grammar does not — an upper-case, over-long or foreign-prefix id,
 *   a URL, a statement — so no peer-chosen text is ever filed as a ref.
 *
 * @param frameId The frame's readable `id`, if any.
 * @returns A reference `errorPayloadSchema` accepts as `ref`.
 *
 * @example
 * ```ts
 * failureRefFor('msg_0123456789abcdef'); // → 'msg_0123456789abcdef' (echoed)
 * failureRefFor("SELECT 'x'");           // → a fresh 'msg_…' id
 * failureRefFor('msg_0123456789ABCDEF'); // → a fresh 'msg_…' id
 * ```
 */
function failureRefFor(frameId: string | undefined): string {
  return frameId !== undefined &&
    MINTED_MESSAGE_ID_PATTERN.test(frameId) &&
    ERROR_REF_SCHEMA.safeParse(frameId).success
    ? frameId
    : newMessageId();
}

/**
 * The failure reference of one queued frame, resolved at most once.
 *
 * Created empty by `enqueueFrame` for every frame and filled by the first
 * failure `processFrame` reports, so every later record about the same frame —
 * the refusal after a handler threw, the queue's last-resort sink — carries the
 * ref its reply already carried, instead of each minting its own.
 */
interface FrameFailure {
  ref: string | undefined;
}

/**
 * The reference `failure` is reported under: the one already resolved for the
 * frame, or — the first time — {@link failureRefFor}'s choice, recorded so
 * every later record about the frame reuses it.
 */
function resolveFailureRef(failure: FrameFailure, frameId: string | undefined): string {
  const ref = failure.ref ?? failureRefFor(frameId);
  failure.ref = ref;
  return ref;
}

/**
 * The payload of an `error` reply: protocol's `toErrorPayload` (the code, the
 * message and the reference), verified against the `error` payload schema
 * before it is sent.
 *
 * The reference is always kept. It comes from {@link failureRefFor}, so the
 * schema accepts it by construction, and it is the ref the failure was logged
 * under — dropping it would sever the reply from its record. A message the
 * schema refuses (empty or over-long) is replaced by a constant under the
 * same ref, so a reply is always well-formed and always correlated.
 *
 * @param error The failure to report.
 * @param ref The frame's failure reference, from {@link resolveFailureRef}.
 * @returns A payload `errorPayloadSchema` accepts, carrying `ref`.
 */
function errorReplyPayload(error: DebuggenError, ref: string): ErrorPayload {
  const payload = toErrorPayload(error, ref);
  if (errorPayloadSchema.safeParse(payload).success) {
    return payload;
  }
  return toErrorPayload(new DebuggenError('INTERNAL', UNREPORTABLE_FAILURE_MESSAGE), ref);
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
  // The three admission bounds nest — per peer ≤ global pending ≤ open — so
  // each is validated against the one above it, and a default larger than an
  // injected smaller bound follows that bound down.
  const openOption = integerOption(
    'maxOpenConnections',
    deps.maxOpenConnections,
    DEFAULT_MAX_OPEN_CONNECTIONS,
    1,
    DEFAULT_MAX_OPEN_CONNECTIONS,
  );
  if (isErr(openOption)) {
    return openOption;
  }
  const pendingOption = integerOption(
    'maxPendingHandshakes',
    deps.maxPendingHandshakes,
    Math.min(DEFAULT_MAX_PENDING_HANDSHAKES, openOption.value),
    1,
    openOption.value,
  );
  if (isErr(pendingOption)) {
    return pendingOption;
  }
  const peerOption = integerOption(
    'maxPendingHandshakesPerPeer',
    deps.maxPendingHandshakesPerPeer,
    Math.min(DEFAULT_MAX_PENDING_HANDSHAKES_PER_PEER, pendingOption.value),
    1,
    pendingOption.value,
  );
  if (isErr(peerOption)) {
    return peerOption;
  }
  const heartbeatIntervalMs = heartbeatOption.value;
  const helloTimeoutMs = helloOption.value;
  const maxPendingFrames = backlogOption.value;
  const offlineGraceMs = graceOption.value;
  const limits: AdmissionLimits = Object.freeze({
    maxOpenConnections: openOption.value,
    maxPendingHandshakes: pendingOption.value,
    maxPendingHandshakesPerPeer: peerOption.value,
  });
  /**
   * The `Retry-After` of an admission refusal, in whole seconds: the longest a
   * pending share can be held — the hello window, then the closing grace
   * period after which a refused socket is terminated — rounded up. A 429 is
   * therefore always clearable by the time it names; a 503 is a hint, since
   * authenticated sockets close when their clients choose.
   */
  const admissionRetryAfterSeconds = Math.max(
    1,
    Math.ceil((helloTimeoutMs + CLOSE_HANDSHAKE_GRACE_MS) / 1_000),
  );

  const { auth, clients, binding, telemetry, readiness, targets, sourceOpen } = deps;
  // Guarded before the child is derived, so no record this module writes —
  // the `debug` twin of a failure included — can throw into the catch block
  // that is answering the failure (`guardLogger` is idempotent, so the
  // service's already-guarded root passes through unchanged).
  const log = subsystemLogger(guardLogger(deps.logger ?? noopLogger), LOG_SUBSYSTEM);

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
    logException('error', 'the WebSocket server reported an error', {}, cause, newMessageId());
  });

  const connections = new Map<WebSocket, ConnectionState>();
  /** Closed connections kept registered (offline) until their grace period ends, by client id. */
  const retained = new Map<string, TimerHandle>();
  const attached = new Set<UpgradeSource>();
  /**
   * The relays of delivered `source.open` answers still waiting for the
   * editors: each settles when its `source.result` has been handed to the
   * sender (or could not be). {@link WsServer.close} waits for them, within the
   * closing grace period, after closing the {@link SourceOpenPort}.
   */
  const sourceRelays = new Set<Promise<void>>();
  /** The admission counters the upgrade gate reserves against. */
  const admissions = createAdmissionLedger(limits);
  /**
   * Every TCP socket holding an admission slot, until it emits `close`, with a
   * promise that settles then. {@link WsServer.close} destroys the ones no
   * connection state owns — a handshake `ws` has not finished or has aborted —
   * and waits for them, so no reservation outlives the server.
   */
  const admittedSockets = new Map<Duplex, Promise<void>>();
  /** Upgrades refused by the admission quotas since the server was created. */
  let refusedUpgrades = 0;
  /** When the last `warn` record of a refused upgrade was written (`performance.now()`). */
  let lastRefusalWarnAt: number | undefined;
  /** Refused upgrades filed at `debug` since that record, reported by the next one. */
  let refusalsSinceWarn = 0;
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
   * Files a caught exception at `level` under `ref`, then writes its `debug`
   * twin: the same fields, the same ref and the same value under
   * `LOG_ERROR_FIELD_KEY`, with the constant
   * {@link EXCEPTION_DIAGNOSTIC_MESSAGE}.
   *
   * The two records split what may be said at each level. At `warn`/`error`
   * the service serializer reduces the value to its closed shape — class,
   * closed-vocabulary code, cause chain — because a record at those levels is
   * written by default; only at `debug`/`trace` does it add the message and
   * stack, after its URL, SQL and source-excerpt redaction. The twin is
   * therefore where a developer who opted into `debug` reads why the failure
   * happened, found by the ref the primary record and the client's reply
   * carry. Below the `debug` threshold the twin costs one level comparison.
   *
   * @param level The level the failure itself is filed at.
   * @param message The primary record's constant message.
   * @param fields The context fields both records carry (connection, type).
   * @param cause Whatever was thrown, rejected or emitted as `error`.
   * @param ref The reference both records are filed under.
   *
   * @example
   * ```ts
   * logException('error', 'a WebSocket frame handler failed unexpectedly',
   *   { ...fieldsOf(state), type: message.type }, cause, ref);
   * // error: {"ref":"msg_…","errorClass":"Error","err":{"type":"Error"}, …}
   * // debug: {"ref":"msg_…","errorClass":"Error","err":{"type":"Error","message":"…","stack":"…"}, …}
   * ```
   */
  function logException(
    level: ExceptionLevel,
    message: string,
    fields: LogFields,
    cause: unknown,
    ref: string,
  ): void {
    log[level](message, { ...fields, ...exceptionFields(cause, ref) });
    log.debug(EXCEPTION_DIAGNOSTIC_MESSAGE, { ...fields, ...exceptionFields(cause, ref) });
  }

  /**
   * Runs a socket or timer callback so that nothing it throws escapes into
   * `ws` or the event loop: an unexpected failure is logged under the
   * callback's constant sentence from {@link GUARDED_ACTION_MESSAGES}, and a
   * connection still in its handshake is closed rather than left without a
   * deadline.
   */
  function guarded(
    name: GuardedAction,
    state: ConnectionState | undefined,
    action: () => void,
  ): void {
    try {
      action();
    } catch (cause) {
      logException(
        'error',
        GUARDED_ACTION_MESSAGES[name],
        state === undefined ? {} : fieldsOf(state),
        cause,
        newMessageId(),
      );
      if (state?.phase === 'awaiting-hello') {
        closeConnection(state, CLOSE_DIRECTIVES.authUnavailable);
      }
    }
  }

  /* ---- the upgrade gate ---- */

  /**
   * Answers a refused upgrade with a bare HTTP status and destroys the TCP
   * socket. The response holds nothing the client sent: the status line,
   * `Connection: close`, an empty body, `Cache-Control: no-store` and
   * `X-Content-Type-Options: nosniff` on every status, and — for an admission
   * refusal — the `Retry-After` the client is to wait, in seconds.
   */
  function rejectUpgrade(socket: Duplex, status: number, retryAfterSeconds?: number): void {
    socket.on('error', (cause) => {
      log.debug(
        'a refused upgrade socket failed while closing',
        exceptionFields(cause, newMessageId()),
      );
    });
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    socket.once('finish', () => {
      socket.destroy();
    });
    const head = [
      `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}`,
      'Connection: close',
      'Content-Length: 0',
      'Cache-Control: no-store',
      'X-Content-Type-Options: nosniff',
      ...(retryAfterSeconds === undefined ? [] : [`Retry-After: ${String(retryAfterSeconds)}`]),
    ];
    socket.end(`${head.join('\r\n')}\r\n\r\n`);
  }

  /**
   * Answers an upgrade the admission quotas refused — 429 or 503, with
   * `Retry-After` — and files it with counts and limits only: never the
   * peer's address, the origin or the request target. The first refusal of
   * each {@link ADMISSION_WARN_INTERVAL_MS} is filed at `warn` with the number
   * of refusals filed at `debug` since the one before it; the others at
   * `debug`.
   */
  function refuseAdmission(
    socket: Duplex,
    decision: Extract<AdmissionDecision, { readonly admitted: false }>,
  ): void {
    refusedUpgrades += 1;
    const status = ADMISSION_REFUSAL_STATUS[decision.refusal];
    const counts = admissions.snapshot();
    const fields: LogFields = {
      status,
      refusal: decision.refusal,
      admitted: counts.admitted,
      pendingHandshakes: counts.pendingHandshakes,
      peerPendingHandshakes: decision.peerPending,
      maxOpenConnections: limits.maxOpenConnections,
      maxPendingHandshakes: limits.maxPendingHandshakes,
      maxPendingHandshakesPerPeer: limits.maxPendingHandshakesPerPeer,
    };
    const now = performance.now();
    if (lastRefusalWarnAt === undefined || now - lastRefusalWarnAt >= ADMISSION_WARN_INTERVAL_MS) {
      log.warn(ADMISSION_REFUSED_LOG, { ...fields, suppressed: refusalsSinceWarn });
      lastRefusalWarnAt = now;
      refusalsSinceWarn = 0;
    } else {
      refusalsSinceWarn += 1;
      log.debug(ADMISSION_REFUSED_LOG, fields);
    }
    rejectUpgrade(socket, status, admissionRetryAfterSeconds);
  }

  /**
   * Ties an admitted socket's reservation to its TCP socket: the ticket is
   * released when the socket emits `close`, whichever phase it closed in —
   * including a handshake `ws` refused or never finished, which leaves no
   * connection state behind to release it. Registered before `ws` sees the
   * socket, so this listener runs before `ws`'s own and the slot is free by
   * the time the connection's `close` is handled.
   */
  function holdAdmission(socket: Duplex, ticket: AdmissionTicket): void {
    const released = new Promise<void>((resolve) => {
      socket.once('close', () => {
        ticket.release();
        admittedSockets.delete(socket);
        resolve();
      });
    });
    admittedSockets.set(socket, released);
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
      // A socket already gone has nobody to answer, and it may already have
      // emitted the `close` that would give a reservation back.
      if (socket.destroyed) {
        return;
      }
      // The slot is reserved before `ws` allocates anything for the socket.
      const decision = admissions.admit(peerKeyOf(request.socket.remoteAddress));
      if (!decision.admitted) {
        refuseAdmission(socket, decision);
        return;
      }
      const ticket = decision.ticket;
      holdAdmission(socket, ticket);
      wss.handleUpgrade(request, socket, head, (ws) => {
        guarded('accept', undefined, () => {
          try {
            accept(ws, origin, ticket);
          } catch (cause) {
            // Without its state and hello deadline the socket would keep its
            // slot for as long as the peer kept it open.
            ws.terminate();
            throw cause;
          }
        });
      });
    } catch (cause) {
      logException('warn', 'a WebSocket upgrade failed unexpectedly', {}, cause, newMessageId());
      socket.destroy();
    }
  }

  /* ---- connection lifecycle ---- */

  /**
   * Starts tracking a freshly upgraded socket and arms its hello deadline.
   *
   * @param admission The slot the upgrade gate reserved for the socket, given
   * back in part when the hello authenticates and in full when it closes.
   */
  function accept(socket: WebSocket, origin: string | undefined, admission: AdmissionTicket): void {
    let settleClosed: () => void = () => undefined;
    const closedSignal = new Promise<void>((resolve) => {
      settleClosed = resolve;
    });
    const state: ConnectionState = {
      socket,
      origin,
      admission,
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
      guarded('frame', state, () => {
        onMessage(state, data, isBinary);
      });
    });
    socket.on('pong', () => {
      guarded('pong', state, () => {
        onPong(state);
      });
    });
    socket.on('error', (cause: Error) => {
      guarded('socketError', state, () => {
        onSocketError(state, cause);
      });
    });
    socket.once('close', (code: number) => {
      guarded('close', state, () => {
        onClose(state, code);
      });
    });

    if (closed) {
      closeConnection(state, CLOSE_DIRECTIVES.shutdown);
      return;
    }
    const timer = setTimeout(() => {
      guarded('helloDeadline', state, () => {
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
        ...exceptionFields(cause, newMessageId()),
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
      ...exceptionFields(cause, newMessageId()),
    });
    if (state.clientId !== undefined) {
      clients.markOffline(state.clientId);
    }
  }

  /**
   * Releases everything a socket held. The session, its tab binding and any
   * open capture are deliberately untouched (AAP §0.5.5): the binding belongs
   * to the credential, and a reconnect with the same credential carries it.
   *
   * An editor's workspace announcement is released on the same terms as its
   * registration is retired: kept for the offline grace period as a bounded
   * lease — so the editor's HTTP requests still act on its project while the
   * socket is away (VS Code's `deactivate()` ends its sessions over HTTP after
   * the socket has gone, and a reconnect takes a moment) — and withdrawn at
   * once when the grace period is zero or the server is closing. A rotation
   * that closed the socket has already cleared every announcement, and a lease
   * on a cleared announcement is a no-op.
   *
   * The admission slot is released here too, whatever phase the socket closed
   * in. The TCP socket's own `close` normally released it a moment earlier;
   * the ticket gives its share back once, whichever of the two comes first.
   */
  function onClose(state: ConnectionState, code: number): void {
    if (state.phase === 'closed') {
      return;
    }
    state.phase = 'closed';
    clearHelloTimer(state);
    clearCloseTimer(state);
    state.admission.release();
    connections.delete(state.socket);
    const announcement = state.announcement;
    state.announcement = undefined;
    if (announcement !== undefined) {
      if (closed || offlineGraceMs === 0) {
        announcement.release();
      } else {
        announcement.releaseAfter(offlineGraceMs);
      }
    }
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
      guarded('retire', undefined, () => {
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
          ...exceptionFields(cause, newMessageId()),
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
    // project; the announcement lives as long as this connection, plus the
    // offline-grace lease `onClose` grants when the connection drops.
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
    // Authenticated, the connection no longer counts against the
    // unauthenticated share; it keeps its slot among the open sockets, and
    // the client registry bounds the authenticated population from here on.
    state.admission.authenticated();
    log.debug('authenticated a WebSocket connection', fieldsOf(state));

    if (PRODUCER_ROLES.includes(principal.role)) {
      replayToProducer(state, registered.value);
    }
  }

  /**
   * Tells the producer port about a producer connection that has just
   * registered, from the registry's own record of it: a server agent's
   * credential-scoped project, a DevTools connection's credential-bound
   * sessions. Contained: a port that throws is logged and the connection stays
   * open, since nothing it would have replayed is the connection's fault.
   */
  function replayToProducer(state: ConnectionState, registered: RegisteredClient): void {
    const producers = deps.producers;
    if (producers === undefined) {
      return;
    }
    try {
      producers.producerConnected({
        kind: registered.kind,
        ...(registered.projectRoot === undefined ? {} : { projectRoot: registered.projectRoot }),
        sessionIds: [...registered.sessionIds],
        credentialIssuedAt: registered.principal.issuedAt,
      });
    } catch (cause) {
      log.error('replaying the configuration owed to a producer connection threw', {
        ...fieldsOf(state),
        [LOG_ERROR_FIELD_KEY]: cause,
      });
    }
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
    const failure: FrameFailure = { ref: undefined };
    state.tail = state.tail
      .then(() => processFrame(state, text, failure))
      .catch((cause: unknown) => {
        // The last-resort sink: `processFrame` never rejects by design, so a
        // rejection here is a defect. It is filed under the ref the frame's
        // reply already carried when one was resolved, and under a fresh one
        // when the failure came before any.
        logException(
          'error',
          'a WebSocket frame could not be processed',
          fieldsOf(state),
          cause,
          failure.ref ?? newMessageId(),
        );
      })
      .finally(() => {
        state.pending -= 1;
      });
  }

  /**
   * Decodes, authorizes and routes one frame, answering every failure with
   * protocol's `error` message on the same connection, which stays open.
   * Never rejects.
   *
   * Every failure resolves **one** reference first, through
   * {@link resolveFailureRef} — the frame's own `id` where it is spelled as
   * this product mints message ids ({@link MINTED_MESSAGE_ID_PATTERN}), a
   * service-minted id otherwise — and files every record about the failure
   * under it before sending the reply that carries it, so the ref a client
   * receives always names the service's record of it and no record carries a
   * peer-chosen string.
   *
   * @param failure The frame's failure reference holder, shared with the
   * queue's last-resort sink in {@link enqueueFrame}.
   */
  async function processFrame(
    state: ConnectionState,
    text: string | undefined,
    failure: FrameFailure,
  ): Promise<void> {
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
      // A binary frame's bytes are never decoded, so it has no readable id.
      const refused = new DebuggenError('PROTOCOL_INVALID_MESSAGE', BINARY_FRAME_MESSAGE);
      const ref = resolveFailureRef(failure, undefined);
      log.debug('refused a binary frame', { ...fieldsOf(state), code: refused.code, ref });
      replyError(state, refused, ref);
      return;
    }

    const { result, frameId } = decodeFrame(text);
    if (isErr(result)) {
      const ref = resolveFailureRef(failure, frameId);
      log.debug('refused a frame that failed validation', {
        ...fieldsOf(state),
        code: result.error.code,
        ref,
      });
      replyError(state, result.error, ref);
      return;
    }
    const message = result.value;

    let outcome: Result<void, DebuggenError>;
    try {
      outcome = await route(client, message);
    } catch (cause) {
      // Filed at `error` in the closed shape, then — for a developer at
      // `debug` — with the redacted message and stack under the same ref the
      // `INTERNAL` reply below carries.
      logException(
        'error',
        'a WebSocket frame handler failed unexpectedly',
        { ...fieldsOf(state), type: message.type },
        cause,
        resolveFailureRef(failure, message.id),
      );
      outcome = refusal('INTERNAL', HANDLER_FAILURE_MESSAGE);
    }
    if (isErr(outcome)) {
      const ref = resolveFailureRef(failure, message.id);
      log.debug('refused a frame', {
        ...fieldsOf(state),
        type: message.type,
        code: outcome.error.code,
        ref,
      });
      replyError(state, outcome.error, ref);
    }
  }

  /**
   * Sends protocol's `error` message to the connection that sent the frame,
   * through the registry's single-recipient path. The frame is session-less,
   * so the registry's principal filter always lets it through to its sender.
   *
   * @param ref The frame's failure reference, from {@link resolveFailureRef}:
   * the reply carries exactly the ref the failure was logged under.
   */
  function replyError(state: ConnectionState, error: DebuggenError, ref: string): void {
    if (state.clientId === undefined) {
      return;
    }
    const frame = createEnvelope(ERROR_REPLY_TYPE, errorReplyPayload(error, ref));
    const receipt = clients.sendToClient(state.clientId, frame);
    if (isErr(receipt)) {
      log.debug('an error reply could not be delivered', {
        ...fieldsOf(state),
        code: receipt.error.code,
        ref,
      });
    }
  }

  /* ---- routing ---- */

  /**
   * The exhaustive inbound dispatch. The switch runs over the parsed union's
   * discriminant, so each branch receives its own `MessageByType` and a message
   * type added to protocol without a branch here reaches `assertNever` with a
   * real type and fails `tsc -b` rather than being dropped at run time. Every
   * label is protocol's `MESSAGE_TYPE` constant rather than a restated wire
   * name; each keeps its literal type, so the narrowing is unchanged.
   */
  async function route(
    client: RegisteredClient,
    message: ProtocolMessage,
  ): Promise<Result<void, DebuggenError>> {
    const { principal } = client;
    switch (message.type) {
      case MESSAGE_TYPE.CLIENT_HELLO:
        return refusal('PROTOCOL_INVALID_MESSAGE', SECOND_HELLO_MESSAGE);

      case MESSAGE_TYPE.AGENT_READY:
        return routeAgentReady(client, message);

      case MESSAGE_TYPE.SESSION_BIND: {
        const allowed = requireRole(principal, ...BINDING_ROLES);
        if (isErr(allowed)) {
          return allowed;
        }
        const ownTab = requireAnnouncedTab(client, message.payload.tabId);
        if (isErr(ownTab)) {
          return ownTab;
        }
        return settled(
          await binding.handleSessionBind(message.payload, { principal, clientId: client.id }),
        );
      }

      case MESSAGE_TYPE.TAB_NAVIGATED: {
        const allowed = requireRole(principal, ...BINDING_ROLES);
        if (isErr(allowed)) {
          return allowed;
        }
        const ownTab = requireAnnouncedTab(client, message.payload.tabId);
        if (isErr(ownTab)) {
          return ownTab;
        }
        return settled(
          await binding.handleTabNavigated(message.payload, { principal, clientId: client.id }),
        );
      }

      case MESSAGE_TYPE.SESSION_UNBIND: {
        const allowed = requireRole(principal, ...BINDING_ROLES);
        if (isErr(allowed)) {
          return allowed;
        }
        const ownTab = requireAnnouncedTab(client, message.payload.tabId);
        if (isErr(ownTab)) {
          return ownTab;
        }
        return settled(
          await binding.handleSessionUnbind(message.payload, { principal, clientId: client.id }),
        );
      }

      case MESSAGE_TYPE.TELEMETRY_EVENT: {
        const allowed = requireRole(principal, ...TELEMETRY_FRAME_ROLES);
        if (isErr(allowed)) {
          return allowed;
        }
        return settled(await telemetry.handleTelemetryEventFrame({ message, client }));
      }

      case MESSAGE_TYPE.SOURCE_OPEN:
        return routeSourceOpen(client, message);

      case MESSAGE_TYPE.SOURCE_RESULT:
        return routeSourceResult(client, message);

      case MESSAGE_TYPE.TARGET_SELECTED:
        return routeTargetSelected(client, message);

      case MESSAGE_TYPE.ERROR:
        // Service → client only (AAP §0.4.2): refused like a spoofed push, and
        // answered through `processFrame`'s reply with `ref` naming this frame.
        // No product client ever sends one, so the reply cannot loop.
        return refusal('PROTOCOL_INVALID_MESSAGE', CLIENT_ERROR_FRAME_MESSAGE);

      case MESSAGE_TYPE.AGENT_CONFIG:
      case MESSAGE_TYPE.SERVER_AGENT_CONFIG:
      case MESSAGE_TYPE.SESSION_BOUND:
      case MESSAGE_TYPE.SESSION_CREATED:
      case MESSAGE_TYPE.SESSION_UPDATED:
      case MESSAGE_TYPE.SESSION_PROGRESS:
      case MESSAGE_TYPE.ANALYSIS_COMPLETED:
      case MESSAGE_TYPE.CAPTURE_STARTED:
      case MESSAGE_TYPE.CAPTURE_STOPPED:
      case MESSAGE_TYPE.INSTRUMENTATION_PLAN:
      case MESSAGE_TYPE.INSTRUMENTATION_READY:
      case MESSAGE_TYPE.INSTRUMENTATION_FAILED:
      case MESSAGE_TYPE.TELEMETRY_TAIL:
      case MESSAGE_TYPE.PANEL_GENERATED:
      case MESSAGE_TYPE.TARGET_REQUEST:
      case MESSAGE_TYPE.CLEANUP_COMPLETED:
        return refusal('PROTOCOL_INVALID_MESSAGE', SERVICE_PUSH_MESSAGE);

      default:
        return assertNever(message, 'Unhandled protocol message type');
    }
  }

  /**
   * The live binding of `sessionId`, provided it binds the acting tab and the
   * principal's own credential made it (`requireBoundSession`): the gate every
   * DevTools action on a session passes through.
   *
   * @param principal The connection's principal.
   * @param sessionId The session the frame acts on.
   * @param actingTab The tab the frame acts for ({@link actingTabOf}, or a
   * payload's own `tabId`); `undefined` is refused.
   */
  function boundBindingFor(
    principal: Principal,
    sessionId: SessionId,
    actingTab: number | undefined,
  ): Result<TabBindingView, DebuggenError> {
    const view = clients.bindingForSession(sessionId);
    const bound = requireBoundSession(principal, sessionId, view, actingTab);
    if (isErr(bound)) {
      return bound;
    }
    return view === undefined ? refusal('TAB_NOT_BOUND', MISSING_BINDING_MESSAGE) : ok(view);
  }

  /**
   * The live binding of the session a DevTools frame names, for the tab the
   * frame acts for ({@link actingTabOf}).
   */
  function boundBindingOfFrame(
    client: RegisteredClient,
    message: ProtocolMessage,
    sessionId: SessionId,
  ): Result<TabBindingView, DebuggenError> {
    const actingTab = actingTabOf(client, message);
    if (isErr(actingTab)) {
      return actingTab;
    }
    return boundBindingFor(client.principal, sessionId, actingTab.value);
  }

  /**
   * `agent.ready`, relayed by the service worker for a page agent. The report
   * is about the tab its payload names, so that tab is the acting tab of every
   * check: a single-tab connection may report only the tab its hello announced
   * ({@link requireAnnouncedTab}); the report is accepted for a tab this
   * connection's credential bound or one nobody has bound yet (the page may
   * load before its panel binds it), never for a tab another credential holds;
   * when the envelope names a session, that session's live binding must be
   * this credential's binding of the very tab the report names.
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
    const ownTab = requireAnnouncedTab(client, payload.tabId);
    if (isErr(ownTab)) {
      return ownTab;
    }
    const tabBinding = clients.bindingForTab(payload.tabId);
    if (tabBinding !== undefined) {
      const own = requireBoundSession(principal, tabBinding.sessionId, tabBinding, payload.tabId);
      if (isErr(own)) {
        return own;
      }
    }
    if (message.sessionId !== undefined) {
      const bound = boundBindingFor(principal, message.sessionId, payload.tabId);
      if (isErr(bound)) {
        return bound;
      }
    }
    return settled(await readiness.agentReady(payload, client));
  }

  /**
   * `target.selected`: only for the session bound to the frame's acting tab,
   * and only for an element of the document that tab currently shows.
   *
   * The descriptor was assembled in the page, so its `url` is compared with
   * the live binding's — refreshed on every committed navigation — through
   * protocol's `compareSelectionDocument`, the same judgement the panel reads
   * the verdict with. Anything but the same origin and path (a stale selection
   * from a document the tab has left, a forged other origin, an unreadable
   * URL) is refused `TAB_NOT_BOUND` before the session is touched; the query
   * and the fragment are deliberately not compared.
   *
   * The binding holds its URL only in the form `./routes/binding.ts`'s
   * `redactBoundUrl` gives it — query values masked, and the path
   * pattern-scrubbed, so a secret-shaped path segment (a JWT, a key) is stored
   * as `[redacted]`. The descriptor's URL is therefore put through the same
   * redaction before the comparison: comparing the page's raw path with the
   * stored, scrubbed one would refuse every selection of such a document as
   * another document. Redaction is deterministic, so two raw URLs of one
   * document still compare equal, and it keeps the origin, so another origin
   * is still refused. Two paths that differ only in a scrubbed segment are one
   * document here, as they are in every record the service keeps: the raw
   * segment is never held. The log names the verdict, never a URL.
   */
  async function routeTargetSelected(
    client: RegisteredClient,
    message: MessageByType<'target.selected'>,
  ): Promise<Result<void, DebuggenError>> {
    const { sessionId, target } = message.payload;
    const bound = boundBindingOfFrame(client, message, sessionId);
    if (isErr(bound)) {
      return bound;
    }
    const verdict = compareSelectionDocument(
      redactBoundUrl(target.url, serializedOriginOf(target.url)),
      bound.value.url,
    );
    if (verdict !== SAME_DOCUMENT_VERDICT) {
      log.info('refused a target selection that is not of the bound tab’s current document', {
        clientId: client.id,
        [LOG_BINDING_KEYS.client]: client.kind,
        [LOG_BINDING_KEYS.sessionId]: sessionId,
        tabId: bound.value.tabId,
        verdict,
      });
      return refusal('TAB_NOT_BOUND', SELECTION_DOCUMENT_MESSAGE);
    }
    return settled(await targets.selected(sessionId, target));
  }

  /**
   * `source.open`: a DevTools connection only for the session bound to the
   * frame's acting tab, an editor connection within the workspace folders it
   * announced (which the handler checks against the session's stored project
   * root). The caller handed to the handler is composed from the principal and
   * the live binding, never from the frame.
   *
   * A frame refused before the handler runs — the sender's role, its tab's
   * binding, or an `id` too long for a `source.result` `ref` (refused before
   * anything is forwarded, so no location is ever opened without an answer) —
   * is answered with `error`, whose sentence quotes nothing from the request.
   * Every other request is answered with `source.result`, `ref` = this frame's
   * `id`: `failed` when the handler refused it (see
   * {@link answerRefusedSourceOpen}), `no-editor` at once when the
   * location passed every check but reached no editor — the sender's cue for the
   * editor-link fallback, and not an error — and otherwise the editors' answer
   * once it settles. That wait is not awaited here: frames are processed
   * strictly in order per connection, so blocking on an editor would stall
   * every later frame of the sender, its telemetry included.
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
    // Every accepted request is answered by a `source.result` whose `ref` is
    // this frame's id. An envelope id may be longer than a `ref` may be, and
    // such a request could be opened but never answered — so it is refused
    // before anything is forwarded, rather than left to its sender's deadline.
    const answerable = parseSourceResultPayload({
      sessionId: message.payload.sessionId,
      ref: message.id,
      status: 'no-editor',
    });
    if (isErr(answerable)) {
      return refusal('PROTOCOL_INVALID_MESSAGE', SOURCE_OPEN_UNANSWERABLE_MESSAGE);
    }

    let caller: SourceOpenCaller;
    if (principal.role === DEVTOOLS_ROLE) {
      const bound = boundBindingOfFrame(client, message, message.payload.sessionId);
      if (isErr(bound)) {
        return bound;
      }
      caller = {
        client: client.kind,
        tabId: bound.value.tabId,
        sessionId: bound.value.sessionId,
        connectionId: client.id,
      };
    } else if (principal.role === EDITOR_ROLE) {
      caller = {
        client: client.kind,
        projectRoots: principal.scope.workspaceFolders,
        connectionId: client.id,
      };
    } else {
      return refusal('UNAUTHORIZED', SOURCE_OPEN_ROLE_MESSAGE);
    }

    const outcome = await sourceOpen.handle(message, caller);
    if (isErr(outcome)) {
      return answerRefusedSourceOpen(client.id, message, outcome.error);
    }
    const delivery = outcome.value;
    if (delivery.delivered) {
      relayEditorResult(client.id, message, delivery.editorResult);
    } else {
      answerSourceOpen(client.id, {
        sessionId: message.payload.sessionId,
        ref: message.id,
        status: 'no-editor',
      });
    }
    return ok(undefined);
  }

  /**
   * `source.result`: an editor's answer to a `source.open` the service forwarded
   * to it. Only an editor may send one; the handler then checks that the answer
   * names the forward's session and that this editor's announced workspace
   * covers that session's project root. An answer for a forward that is no
   * longer pending — a late one, after the deadline — is accepted and ignored,
   * not refused, so the editor surfaces no notice for it.
   */
  async function routeSourceResult(
    client: RegisteredClient,
    message: MessageByType<'source.result'>,
  ): Promise<Result<void, DebuggenError>> {
    const { principal } = client;
    const allowed = requireRole(principal, ...SOURCE_RESULT_ROLES);
    if (isErr(allowed)) {
      return allowed;
    }
    if (principal.role !== EDITOR_ROLE) {
      return refusal('UNAUTHORIZED', SOURCE_RESULT_ROLE_MESSAGE);
    }
    const caller: SourceOpenCaller = {
      client: client.kind,
      projectRoots: principal.scope.workspaceFolders,
      connectionId: client.id,
    };
    return settled(await sourceOpen.acceptEditorResult(message, caller));
  }

  /**
   * Sends one `source.result` to the connection whose `source.open` it answers,
   * through the registry's single-recipient path, whose principal filter admits
   * it for a DevTools connection whose own credential bound the session and for
   * an editor whose workspace covers it — exactly the senders `source.open`
   * accepts. The frame is validated before it leaves, so a sender whose frame id
   * is too long to be a `ref` is left to its own deadline rather than sent a
   * frame it would refuse. Never throws; a frame that could not be built or
   * delivered (the sender went offline meanwhile) is logged at debug.
   *
   * @returns Whether the answer was handed to the sender's connection.
   */
  function answerSourceOpen(clientId: string, payload: SourceResultPayload): boolean {
    const fields: LogFields = { clientId, type: SOURCE_RESULT_TYPE, status: payload.status };
    let frame: ProtocolMessage;
    try {
      frame = createEnvelope(SOURCE_RESULT_TYPE, payload);
    } catch (cause) {
      log.debug('a source.result answer could not be built', {
        ...fields,
        [LOG_ERROR_FIELD_KEY]: cause,
      });
      return false;
    }
    const verified = parseMessage(frame);
    if (isErr(verified)) {
      log.debug('a source.result answer did not validate, so it was not sent', {
        ...fields,
        code: verified.error.code,
      });
      return false;
    }
    const receipt = clients.sendToClient(clientId, frame);
    if (isErr(receipt)) {
      log.debug('a source.result answer could not be delivered', {
        ...fields,
        code: receipt.error.code,
      });
      return false;
    }
    return true;
  }

  /**
   * A `source.open` the handler refused — containment, a missing file, the
   * session's store, the editor's workspace — answered as a `failed`
   * `source.result` under the sender's own `ref`, never as an `error` frame.
   *
   * The handler's sentence may quote the project-relative file the sender asked
   * for. An `error` reply is session-less, and a Chrome service worker relays
   * session-less frames to every panel it serves, so a refusal sent that way
   * could surface one tab's location in another tab's panel. A `source.result`
   * is relayed to no panel: only the request waiting on its `ref` reads it, and
   * the panel shows fixed copy for its code. When the answer cannot be built or
   * delivered, the refusal falls back to an `error` reply that keeps the code
   * under a fixed sentence quoting nothing from the request.
   */
  function answerRefusedSourceOpen(
    clientId: string,
    message: MessageByType<'source.open'>,
    error: DebuggenError,
  ): Result<void, DebuggenError> {
    const answered = answerSourceOpen(clientId, {
      sessionId: message.payload.sessionId,
      ref: message.id,
      status: 'failed',
      error: error.toPayload(),
    });
    log.debug('refused a source.open', {
      clientId,
      type: message.type,
      code: error.code,
      answeredBy: answered ? SOURCE_RESULT_TYPE : ERROR_REPLY_TYPE,
    });
    return answered ? ok(undefined) : refusal(error.code, SOURCE_OPEN_REFUSED_MESSAGE);
  }

  /**
   * Relays a delivered `source.open`'s editor result to its sender once it
   * settles, as `source.result` with the sender's own `sessionId` and `ref`.
   * The relay is tracked until it has run, so {@link WsServer.close} can let the
   * shutdown answers reach their senders before the sockets close.
   */
  function relayEditorResult(
    clientId: string,
    message: MessageByType<'source.open'>,
    editorResult: Promise<SourceOpenEditorOutcome>,
  ): void {
    const sessionId = message.payload.sessionId;
    const ref = message.id;
    const relay = Promise.resolve(editorResult).then(
      (outcome) => {
        guarded('sourceResult', undefined, () => {
          answerSourceOpen(clientId, { ...outcome, sessionId, ref });
        });
      },
      (cause: unknown) => {
        log.error('a source.open editor result rejected, which its port promises never to do', {
          clientId,
          [LOG_ERROR_FIELD_KEY]: cause,
        });
      },
    );
    sourceRelays.add(relay);
    void relay.finally(() => {
      sourceRelays.delete(relay);
    });
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
    const admission = admissions.snapshot();
    return Object.freeze({
      open: connections.size,
      awaitingHello,
      authenticated,
      pendingFrames,
      offlineRetained: retained.size,
      admitted: admission.admitted,
      pendingHandshakes: admission.pendingHandshakes,
      pendingPeers: admission.pendingPeers,
      refusedUpgrades,
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

    // Every forward still awaiting an editor is settled before any socket
    // closes, so each sender is told the service is shutting down rather than
    // left to its own deadline, and no editor deadline outlives the server.
    guarded('sourceClose', undefined, () => {
      sourceOpen.close();
    });
    await settleWithin(Promise.all([...sourceRelays]), CLOSE_HANDSHAKE_GRACE_MS);

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
    // What still holds an admission slot now has no connection state: a
    // handshake `ws` has not finished, or one it aborted whose TCP `close` is
    // still to come. Destroying it (a no-op for a socket already destroyed)
    // gives the slot back, so the counters read zero once this resolves.
    const handshaking = [...admittedSockets];
    for (const [socket] of handshaking) {
      socket.destroy();
    }
    await settleWithin(
      Promise.all(handshaking.map(([, released]) => released)),
      CLOSE_HANDSHAKE_GRACE_MS,
    );
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
      guarded('heartbeat', undefined, beat);
    }, heartbeatIntervalMs);
    heartbeat.unref();
  }

  return ok(Object.freeze({ attach, handleUpgrade, stats, close }));
}
