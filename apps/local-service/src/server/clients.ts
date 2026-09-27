/**
 * The connected-client registry and the broadcast fabric of the local service
 * (AAP §0.7.1 Group 2: "`clients.ts` tracks connected clients by
 * kind/project/tab and broadcasts by session").
 *
 * Every push the service makes — every row of the AAP §0.4.2 message table
 * whose sender is the service — leaves the process through this module. Each
 * one either fans out to the clients of a session or resolves to exactly one
 * deterministic recipient, and this is the only place that decision is made:
 * `ws.ts` registers and deregisters sockets but never iterates them, and the
 * subsystems (`sessions/**`, `instrumentation/**`, `source/**`, the route
 * modules) hand a built envelope to one of the delivery methods below.
 *
 * ## What the module is, and what it is not
 *
 * Pure bookkeeping. It imports no transport (`ws` stays in `ws.ts`, which
 * passes each `WebSocket` in through the structural {@link ClientSocket}
 * port), no store (the durable `bindings` table belongs to
 * `store/sessions-repo.ts`, written by `routes/binding.ts` before it calls
 * {@link ClientRegistry.bindTab}), no HTTP and no pipeline. That is what lets
 * `sessions/**` depend on it through the two-method `SessionBroadcaster` port
 * without learning anything about sockets, and what lets it be unit-tested with
 * a fake socket.
 *
 * ## Who receives what
 *
 * Every routing decision is taken from the connection's resolved
 * {@link Principal} (from `./auth.ts`), never from what a client said about
 * itself in `client.hello`:
 *
 * | Client kind | Receives a session's fan-out when | Direct deliveries |
 * | --- | --- | --- |
 * | `vscode` | the session's project root lies under a workspace folder its principal announced; while the project is not yet known, when the client explicitly attached to the session | editor-bound pushes for a project its scope covers ({@link ClientRegistry.sendToEditors}) |
 * | `devtools` | it is the connection carrying the tab bound to the session by **its own** credential ({@link ClientRegistry.bindTab}); for `session.created` alone, also the connection carrying a tab its credential announced that awaits a session for the new session's dev-server origin ({@link ClientRegistry.awaitSession}) | frames with no session, or for a session its credential has bound |
 * | `agent` | never directly: the MAIN-world page agent owns no socket and no credential, so its frames travel "under the tab's connection" (AAP §0.4.2) — a fan-out or delivery addressed to the `agent` kind is carried by the bound tab's DevTools connection, and relayed `agent.ready` / telemetry batches arrive on that same connection | — |
 * | `server-agent` | never: a dev-server preload is not a session client | only its own project's `server-agent.config` ({@link ClientRegistry.sendToServerAgent}), and the `error` or `service.pong` reply to a frame it sent |
 *
 * The filter lives inside the registry, so no caller can bypass it by
 * accident: a caller names a session, a project or a connection, and the
 * registry decides which sockets that reaches.
 *
 * ## Bindings: live view, not durable record
 *
 * AAP §0.2.3: one tab binds to at most one session, one session accepts one
 * bound tab at a time, and a second bind replaces the first and is announced.
 * The registry holds the **live** view used for routing, keyed by tab and by
 * session; the durable row lives in `store/sessions-repo.ts`. A binding is
 * recorded against the credential that made it (`boundBy`, the principal's
 * `tokenHash`, the same field `./auth.ts`'s `requireBoundSession` checks) and
 * not against a socket: the Chrome MV3 service worker suspends after roughly
 * 30 s of idleness and reconnects with backoff (AAP §0.5.5), and because its
 * new connection presents the same credential, the binding's traffic follows
 * it without any re-bind. One service-worker connection may carry several tabs.
 *
 * `boundBy` is therefore a credential, not a tab: every tab one paired
 * extension inspects presents the same digest. Routing on it is sound — the
 * connection carrying the credential is the one that can reach the tab — but
 * *authorizing* on it alone is not, so every DevTools action names its acting
 * tab and `./auth.ts`'s `requireBoundSession` also requires the binding's
 * `tabId` to be that tab.
 *
 * When a bind displaces another binding, or a tab is unbound, the released
 * binding's connection stays eligible for **binding announcements** about that
 * session for a short window ({@link RELEASED_BINDING_NOTICE_WINDOW_MS}), so
 * `routes/binding.ts` can tell the displaced panel it lost the binding with an
 * ordinary `broadcastToKinds` — and for nothing else.
 *
 * ## Tabs awaiting a session
 *
 * A DevTools panel is normally opened — and its tab announced with
 * `session.bind` — before the developer asks the question that creates the
 * session, and a panel stays open across a session's end while the next
 * question is asked. The service is the binding authority (AAP §0.2.3), so it
 * remembers such a tab: `routes/binding.ts` records it with
 * {@link ClientRegistry.awaitSession} when an origin bind finds no session, when
 * the tab's session ended and the worker unbound it, and when the tab left its
 * session's origin for another. The record holds the tab, the serialized
 * HTTP(S) origin of its document and the announcing credential — never a URL.
 *
 * When a session is created, its `session.created` also reaches the connection
 * carrying every tab awaiting that session's dev-server origin (and nothing
 * else of the session), which is the worker's cue to announce the tab again:
 * the service then binds it exactly as it binds a freshly opened panel. A
 * session created while the tab was still bound to the one that ended cannot
 * reach it that way, so when the tab starts awaiting, the binding route offers
 * the newest open session already serving its origin to that one connection
 * ({@link ClientRegistry.offerSessionToAwaitingTab}).
 * Nothing more is disclosed than the bind itself would answer — the tab's
 * credential announced that very origin — and no other frame follows until
 * the tab is bound. A record ends when its tab is bound, when its DevTools
 * closes (`session.unbind` of the unbound tab, {@link ClientRegistry.forgetAwaitingTab}),
 * when no connection of its credential remains registered, and on revocation;
 * at most {@link MAX_AWAITING_TABS} are held, the oldest evicted first.
 *
 * ## Delivery semantics
 *
 * - **Serialize once.** A message is encoded with protocol's `encodeMessage`
 *   once per call, and the same string is sent to every recipient.
 * - **Failure isolation.** A `send` that throws (the socket closed between the
 *   lookup and the write) marks that client offline and the fan-out continues;
 *   the delivered count is returned.
 * - **Ordering.** Sends are synchronous and in call order. Nothing here awaits
 *   between frames, so the fixed replay order `sessions/reopen.ts` emits
 *   (`session.updated`, the progress rows, `analysis.completed`,
 *   `panel.generated`) reaches each recipient in that order.
 * - **Backpressure.** A socket whose `bufferedAmount` exceeds the configured
 *   bound is closed with RFC 6455 code 1013 rather than silently skipped: a
 *   skipped frame would break the ordering guarantee, whereas a reconnecting
 *   client re-binds and is replayed from stored data.
 * - **Offline clients.** A client marked offline keeps its registration, its
 *   sessions and its bindings. Frames addressed to it are **dropped and
 *   counted**, not queued — the DevTools panel and the VS Code view re-render
 *   from stored data on reconnect (`sessions/reopen.ts`), so a queue would only
 *   replay stale frames ahead of fresh ones. Drops are logged at debug, one
 *   record per delivery naming the frame's session and each client that
 *   missed it by id, kind and reason. {@link ClientRegistry.sweep} removes a
 *   client that has stayed offline past the grace period and closes any
 *   connection whose credential has expired. An offline registration whose
 *   socket has closed holds no slot under the connection bound: when a new
 *   connection would pass it, {@link ClientRegistry.register} releases the
 *   longest-offline such registrations (their bindings stay with the
 *   credential), so reconnect churn inside the grace period is never refused
 *   on their account.
 *
 * ## Privacy
 *
 * A registered client holds its principal (which carries a SHA-256 digest of
 * the credential, never the credential) and nothing more. Log records name a
 * client by id, kind, role, project root and tab only; a principal object is
 * never logged wholesale and the digest is never logged at all.
 *
 * ## Lifetime
 *
 * {@link ClientRegistry.closeAll} closes every socket, clears every index and
 * stops the optional sweep timer, so `startService(...).close()` leaves no open
 * handle between integration suites. {@link ClientRegistry.revokeAll} is the
 * `ConnectionRevoker` port `./auth.ts` calls on credential rotation.
 *
 * @example Wiring in `main.ts`
 * ```ts
 * const clients = createClientRegistry({ logger: serverLogger });
 * const auth = unwrap(createAuthService({ store, config, logger, revoker: clients }));
 * const sessions = createSessionManager({ sessions: repo, broadcaster: clients, progress });
 * ```
 */

import {
  CLIENT_KINDS,
  MESSAGE_PAYLOAD_SCHEMAS,
  MESSAGE_TYPES,
  WS_CLOSE_UNAUTHORIZED,
  encodeMessage,
  errorPayloadSchema,
  serverAgentConfigPayloadSchema,
  servicePongPayloadSchema,
  sessionBoundPayloadSchema,
  sessionCreatedPayloadSchema,
} from '@debuggen/protocol';
import type { BindingReason, ClientKind, MessageType, ProtocolMessage } from '@debuggen/protocol';
import {
  DebuggenError,
  assertDefined,
  err,
  isAbsolutePosix,
  isWindowsAbsolute,
  isWithin,
  newId,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';

import { LOG_BINDING_KEYS, LOG_ERROR_FIELD_KEY, subsystemLogger } from '../logging.js';
import type { ConnectionRevoker, Principal, TabBinding } from './auth.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The prefix of a connection id.
 *
 * Connection ids are process-local and never persisted, so they have no entry
 * in `@debuggen/shared`'s `ID_PREFIXES` (whose members are store keys); the id
 * body still comes from the shared CSPRNG-backed generator, so ids never repeat
 * across restarts the way a counter would.
 */
export const CLIENT_ID_PREFIX = 'cli';

/**
 * The WHATWG `WebSocket.OPEN` ready state, which `ws` shares. A socket reporting
 * any other state cannot take a frame.
 */
export const SOCKET_READY_STATE_OPEN = 1;

/** RFC 6455 §7.4.1 "going away": the close code of an orderly shutdown. */
export const WS_CLOSE_GOING_AWAY = 1001;

/**
 * IANA-registered WebSocket close code 1013, "try again later": the code a
 * connection that cannot keep up with its frames is closed with. The client
 * reconnects with backoff and is replayed from stored data.
 */
export const WS_CLOSE_TRY_AGAIN_LATER = 1013;

/**
 * RFC 6455 §5.5 limits a close frame's body to 125 bytes, two of which carry
 * the code; a longer reason makes `ws` throw.
 */
export const MAX_CLOSE_REASON_BYTES = 123;

/**
 * How long a client may stay offline before {@link ClientRegistry.sweep}
 * removes it: comfortably longer than the MV3 service worker's reconnect
 * backoff ceiling of 10 s (AAP §0.5.5), so a suspended worker is never swept
 * between two reconnect attempts.
 *
 * Retention is not occupancy: an offline registration whose socket has closed
 * holds no slot under {@link DEFAULT_MAX_CLIENTS}, so the grace period never
 * refuses a reconnect (see {@link ClientRegistry.register}).
 */
export const DEFAULT_OFFLINE_GRACE_MS = 60_000;

/**
 * The most live connections one registry accepts. A local developer tool has a
 * handful (an editor window or two, one Chrome service worker, one or two
 * dev-server processes); the bound exists so a runaway reconnect loop cannot
 * exhaust memory.
 *
 * Live means online, or offline over a socket that is still open. A closed
 * connection `ws.ts` retains offline for {@link DEFAULT_OFFLINE_GRACE_MS} does
 * not hold a slot: {@link ClientRegistry.register} releases the longest-offline
 * of them to make room, and refuses with `RATE_LIMITED` only when live
 * connections alone fill the bound.
 */
export const DEFAULT_MAX_CLIENTS = 256;

/**
 * The most bytes a socket may have buffered before it is treated as unable to
 * keep up and closed with {@link WS_CLOSE_TRY_AGAIN_LATER}.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/**
 * How long a displaced or unbound binding's connection stays eligible for
 * binding announcements about the session it lost. The announcement is sent in
 * the same tick as the change; the window only absorbs a caller that awaits a
 * store write in between.
 */
export const RELEASED_BINDING_NOTICE_WINDOW_MS = 5_000;

/**
 * The most tabs held as awaiting a session ({@link ClientRegistry.awaitSession})
 * at once — the same bound the Chrome worker keeps on its own tab bindings. A
 * record past it evicts the oldest, whose tab then binds when its panel next
 * announces it.
 */
export const MAX_AWAITING_TABS = 256;

/** The most released-binding notices kept per session. */
const MAX_RELEASED_NOTICES_PER_SESSION = 8;

/** The longest id a routing key may have, matching protocol's id bound. */
const MAX_ROUTING_ID_LENGTH = 64;

/** The close reason of {@link ClientRegistry.closeAll}'s default. */
const SHUTDOWN_CLOSE_REASON = 'Debug Generator service is shutting down';

/** The close reason of {@link ClientRegistry.revokeAll}'s default. */
const REVOKED_CLOSE_REASON = 'Credentials were revoked; pair or reconnect again';

/** The close reason of a client removed by the offline sweep. */
const SWEPT_CLOSE_REASON = 'Connection was offline for too long';

/** The close reason of a connection whose credential expired. */
const EXPIRED_CLOSE_REASON = 'Credential expired';

/** The close reason of a connection closed for backpressure. */
const BACKPRESSURE_CLOSE_REASON = 'Client is not keeping up with messages';

/** The subsystem binding of this module's log records, following `./auth.ts`'s file-name convention. */
const LOG_SUBSYSTEM = 'clients';

/*
 * The client kinds and binding reasons this module branches on. Each constant
 * is checked against protocol's closed vocabulary (`ClientKind`, derived from
 * `CLIENT_KINDS`; `BindingReason`, derived from `BINDING_REASONS`) by
 * `satisfies`, so a renamed member is a compile error here rather than a
 * silent mismatch on the wire. The `const` initialiser keeps each literal type,
 * which is what lets a comparison narrow a principal's role.
 */
const KIND_VSCODE = 'vscode' satisfies ClientKind;
const KIND_DEVTOOLS = 'devtools' satisfies ClientKind;
const KIND_AGENT = 'agent' satisfies ClientKind;
const KIND_SERVER_AGENT = 'server-agent' satisfies ClientKind;

const REASON_BOUND = 'bound' satisfies BindingReason;
const REASON_REPLACED = 'replaced' satisfies BindingReason;
const REASON_NAVIGATED = 'navigated' satisfies BindingReason;
const REASON_ORIGIN_CHANGED = 'origin-changed' satisfies BindingReason;
const REASON_UNBOUND = 'unbound' satisfies BindingReason;

/** The reasons a binding may be dropped for: every member of the vocabulary that ends one. */
const DROP_REASONS: ReadonlySet<BindingReason> = new Set<BindingReason>([
  REASON_ORIGIN_CHANGED,
  REASON_UNBOUND,
]);

/**
 * Resolves the message type whose payload schema is `schema`, by object
 * identity in protocol's registry.
 *
 * This is how the module names the four message types its policy depends on
 * without spelling a message name: protocol registers each domain's schema
 * objects in `MESSAGE_PAYLOAD_SCHEMAS`, so the schema is the key and the name
 * is looked up rather than restated.
 *
 * @throws DebuggenError `INTERNAL` at module load when the schema is not
 * registered — an impossible state for a schema protocol exports.
 */
function messageTypeForSchema(schema: unknown, description: string): MessageType {
  const type = MESSAGE_TYPES.find((candidate) => MESSAGE_PAYLOAD_SCHEMAS[candidate] === schema);
  assertDefined(
    type,
    `The ${description} payload schema is not registered in protocol's message registry.`,
  );
  return type;
}

/** The dev-server arming message: the only frame a server-agent connection is pushed. */
const SERVER_AGENT_CONFIG_TYPE = messageTypeForSchema(
  serverAgentConfigPayloadSchema,
  'server-agent config',
);

/** The binding announcement: the only frame a released binding's connection may still receive. */
const BINDING_ANNOUNCEMENT_TYPE = messageTypeForSchema(
  sessionBoundPayloadSchema,
  'binding announcement',
);

/** The generic failure reply, which any connection may receive in answer to its own frame. */
const ERROR_REPLY_TYPE = messageTypeForSchema(errorPayloadSchema, 'error');

/**
 * The session-creation announcement: the one frame of a session a DevTools
 * connection whose tab awaits that session's origin receives before binding.
 */
const SESSION_CREATED_TYPE = messageTypeForSchema(sessionCreatedPayloadSchema, 'session creation');

/**
 * The liveness answer, which any connection may receive in answer to its own
 * `client.ping`: session-less, carrying only the ping's id, and sent by
 * `ws.ts` to the pinging connection alone.
 */
const LIVENESS_REPLY_TYPE = messageTypeForSchema(servicePongPayloadSchema, 'liveness reply');

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/**
 * The smallest socket surface the registry needs: what `ws.ts` passes a `ws`
 * `WebSocket` in as. String-payload based, because every protocol frame is
 * JSON text.
 *
 * `readyState` and `bufferedAmount` are optional so a test fake may omit them;
 * a real `WebSocket` provides both, and the registry then refuses to write to a
 * socket that is not open and closes one that is not draining.
 */
export interface ClientSocket {
  /** Writes one text frame. May throw when the socket is no longer open. */
  send(data: string): void;
  /** Starts the closing handshake. */
  close(code?: number, reason?: string): void;
  /** The WHATWG ready state; {@link SOCKET_READY_STATE_OPEN} when writable. */
  readonly readyState?: number;
  /** Bytes queued but not yet written to the network. */
  readonly bufferedAmount?: number;
}

/**
 * What `ws.ts` registers once `client.hello` has been authenticated.
 *
 * `principal` is the identity `./auth.ts` resolved from the stored credential
 * and is the only authority the registry routes on. `projectRoot` and `tabId`
 * are the hello's announcements, kept as facts about the connection: an
 * editor's announced root is informational (its principal's workspace folders
 * decide), a server agent's must agree with its credential's project, and a
 * DevTools connection's tab id marks it a single-tab connection — `ws.ts` and
 * the telemetry route then refuse any frame from it that acts for another tab —
 * while tab traffic still follows the bindings its credential makes. The MV3
 * service worker announces no tab: it multiplexes every tab and names the
 * acting tab on each frame instead.
 */
export interface ClientRegistration {
  readonly kind: ClientKind;
  readonly principal: Principal;
  readonly socket: ClientSocket;
  readonly projectRoot?: string | undefined;
  readonly tabId?: number | undefined;
}

/**
 * A snapshot of one registered connection.
 *
 * Returned by value: mutating it changes nothing, and a later call returns a
 * fresh snapshot. `socket` is exposed for identity checks (`ws.ts` matches a
 * closing socket to its registration); frames must be sent through the
 * registry's delivery methods, never through it, or the principal filter is
 * bypassed.
 */
export interface RegisteredClient {
  /** The process-local connection id. */
  readonly id: string;
  readonly kind: ClientKind;
  /** The resolved identity; carries a credential digest, never a credential. */
  readonly principal: Principal;
  readonly socket: ClientSocket;
  /**
   * The connection's project: a server agent's credential scope, or the root an
   * editor announced. Absent for DevTools connections, which carry no project
   * scope (AAP §0.5.6).
   */
  readonly projectRoot?: string;
  /** The tab a DevTools connection announced in its hello, if it announced one. */
  readonly tabId?: number;
  /**
   * The sessions this connection follows: an editor's explicit attachments, or
   * the sessions whose tab bindings a DevTools connection's credential made.
   */
  readonly sessionIds: ReadonlySet<string>;
  readonly connectedAt: number;
  readonly lastSeenAt: number;
  readonly online: boolean;
  /** When the connection was last marked offline, while it is offline. */
  readonly offlineSince?: number;
  /** Frames written to this connection. */
  readonly delivered: number;
  /** Frames addressed to this connection that were dropped (offline, closed or failed). */
  readonly dropped: number;
}

/**
 * Narrows {@link ClientRegistry.list} and {@link ClientRegistry.closeWhere}.
 * Every given criterion must hold.
 */
export interface ClientFilter {
  /** One kind, or any of several. */
  readonly kind?: ClientKind | readonly ClientKind[] | undefined;
  /**
   * Clients scoped to this project: a server agent for exactly this root, or an
   * editor whose announced workspace covers it. DevTools connections carry no
   * project scope and never match.
   */
  readonly projectRoot?: string | undefined;
  /** Clients that announced this tab, or that carry its binding. */
  readonly tabId?: number | undefined;
  /** Clients a fan-out for this session would reach. */
  readonly sessionId?: string | undefined;
  readonly online?: boolean | undefined;
}

/**
 * A live tab-to-session binding as the router sees it.
 *
 * Structurally a superset of `./auth.ts`'s `TabBinding`, so a route can pass
 * {@link ClientRegistry.bindingForSession}'s answer straight to
 * `requireBoundSession` (see {@link TabBindingViewIsAuthTabBinding}).
 */
export interface TabBindingView {
  readonly tabId: number;
  readonly sessionId: string;
  /** The bound document's URL. */
  readonly url: string;
  /** The `tokenHash` of the DevTools credential that made the binding. */
  readonly boundBy: string;
  readonly boundAt: number;
  /** The connection currently carrying the tab, when one is registered. */
  readonly recipientId?: string;
  /** Whether that connection is online, i.e. whether tab traffic can be delivered now. */
  readonly online: boolean;
}

/** What {@link ClientRegistry.bindTab} is given. */
export interface BindTabInput {
  readonly tabId: number;
  readonly sessionId: string;
  readonly url: string;
  /** The binding connection's principal; must be a DevTools one. */
  readonly principal: Principal;
  /** The connection that sent `session.bind`, preferred as the tab's recipient. */
  readonly clientId?: string | undefined;
  /** When the binding was made; defaults to the registry clock. */
  readonly boundAt?: number | undefined;
}

/** One binding and why it changed. */
export interface BindingChange {
  readonly binding: TabBindingView;
  /** A member of protocol's `BINDING_REASONS`, ready for a `session.bound` announcement. */
  readonly reason: BindingReason;
}

/** What {@link ClientRegistry.bindTab} reports. */
export interface BindTabOutcome extends BindingChange {
  /**
   * Bindings the new one displaced — the tab's previous session, the session's
   * previous tab, or both — each with the reason to announce it under.
   */
  readonly displaced: readonly BindingChange[];
}

/** What {@link ClientRegistry.updateTabUrl} is given. */
export interface UpdateTabUrlInput {
  readonly tabId: number;
  readonly url: string;
  /** When given and a DevTools principal, it must be the credential that made the binding. */
  readonly principal?: Principal | undefined;
}

/** What {@link ClientRegistry.unbindTab} is given besides the tab id. */
export interface UnbindTabOptions {
  /** Why the binding ends; a drop reason from `BINDING_REASONS`. Defaults to the plain unbind. */
  readonly reason?: BindingReason | undefined;
  /** When given and a DevTools principal, it must be the credential that made the binding. */
  readonly principal?: Principal | undefined;
}

/** What {@link ClientRegistry.awaitSession} is given. */
export interface AwaitSessionInput {
  /** The announced tab. */
  readonly tabId: number;
  /**
   * The serialized HTTP(S) origin of the tab's document (`new URL(url).origin`)
   * — the value a new session's dev-server origin is compared with. Never a URL.
   */
  readonly origin: string;
  /** The announcing connection's principal; must be a DevTools one. */
  readonly principal: Principal;
  /** The connection that announced the tab, preferred as the recipient. */
  readonly clientId?: string | undefined;
}

/** What {@link ClientRegistry.forgetSession} released. */
export interface ForgetSessionOutcome {
  /** The session's binding, when it had one. */
  readonly binding?: BindingChange;
  /** How many editor attachments were removed. */
  readonly detached: number;
}

/** The result of one delivery. */
export interface DeliveryReceipt {
  /** Frames written. */
  readonly delivered: number;
  /** Recipients that were addressed but could not take the frame. */
  readonly dropped: number;
  /** The ids of the connections the frame was written to, in send order. */
  readonly recipients: readonly string[];
}

/** Counters for diagnostics and the health view. */
export interface ClientRegistryStats {
  readonly clients: number;
  readonly online: number;
  readonly byKind: Readonly<Record<ClientKind, number>>;
  readonly bindings: number;
  readonly trackedSessions: number;
  /** Frames written since the registry was created. */
  readonly delivered: number;
  /** Frames dropped since the registry was created. */
  readonly dropped: number;
}

/**
 * The connected-client registry.
 *
 * Satisfies `sessions/manager.ts`'s `SessionBroadcaster` port (`broadcast`,
 * `broadcastToKinds`) and `./auth.ts`'s `ConnectionRevoker` port (`revokeAll`)
 * structurally; see the `satisfies` clause in {@link createClientRegistry}.
 * Every method is synchronous and none throws for an expected condition.
 */
export interface ClientRegistry {
  /* ---- registration ---- */

  /**
   * Registers an authenticated connection.
   *
   * @returns The new client's snapshot; `UNAUTHORIZED` when the kind does not
   * match the principal's role (the page agent, which owns no socket, is always
   * refused) or a server agent announces a project other than its credential's;
   * `PROTOCOL_INVALID_MESSAGE` for a socket registered twice or a malformed
   * announcement; `RATE_LIMITED` when live connections — online, or offline
   * over a socket that is still open — fill the connection bound
   * ({@link DEFAULT_MAX_CLIENTS}); `TRANSPORT_DISCONNECTED` after
   * {@link closeAll}.
   *
   * At the bound, registrations retained offline over a closed socket are
   * released first, the longest-offline first and only as many as the new
   * connection needs, through the same path as {@link unregister}: their
   * bindings stay with the credential, and a later `unregister` of a released
   * id (`ws.ts`'s offline-grace timer) returns `undefined` and changes nothing.
   */
  register(registration: ClientRegistration): Result<RegisteredClient, DebuggenError>;

  /**
   * Removes a connection from every index — what `ws.ts` calls when a socket
   * closes. Does **not** close the socket, end a session, or drop a binding:
   * the binding belongs to the credential, and a reconnect with the same
   * credential carries it again.
   *
   * @returns The removed client's final snapshot, or `undefined` if unknown.
   */
  unregister(clientId: string): RegisteredClient | undefined;

  /** The client's snapshot, or `undefined`. */
  get(clientId: string): RegisteredClient | undefined;

  /** The registration of `socket`, or `undefined` — for `ws.ts`'s close handler. */
  findBySocket(socket: ClientSocket): RegisteredClient | undefined;

  /** Every client matching `filter`, in registration order. */
  list(filter?: ClientFilter): readonly RegisteredClient[];

  /* ---- session association ---- */

  /**
   * Makes an editor connection follow a session (a `vscode` client may follow
   * several). A DevTools connection follows exactly the sessions its
   * credential's bindings name, so attaching one succeeds only for such a
   * session and changes nothing.
   *
   * @returns `ok`; `PATH_OUTSIDE_PROJECT` for an editor whose workspace does not
   * cover the session's known project; `TAB_NOT_BOUND` for a DevTools connection
   * without that binding; `UNAUTHORIZED` for a server agent;
   * `TRANSPORT_DISCONNECTED` for an unknown connection.
   */
  attachSession(clientId: string, sessionId: string): Result<void, DebuggenError>;

  /** Stops an editor connection following a session. @returns Whether an attachment was removed. */
  detachSession(clientId: string, sessionId: string): boolean;

  /**
   * Records a session's project root, which is what editor fan-out is scoped
   * by. Learned automatically from any delivered frame whose payload carries a
   * session record (`session.created`, `session.updated`), so the manager's
   * first broadcast already reaches the right editors; call this for a session
   * reopened before any such frame.
   *
   * @returns `ok`; `SESSION_INVALID_STATE` when the session is already tracked
   * under another root; `PROJECT_NOT_FOUND` for a root that is not absolute.
   */
  trackSession(sessionId: string, projectRoot: string): Result<void, DebuggenError>;

  /** The tracked project root of a session, or `undefined`. */
  projectForSession(sessionId: string): string | undefined;

  /**
   * Releases everything the registry holds for a session: its binding (as a
   * released notice, reason `unbound`), editor attachments and project root.
   * Call it after the session's final announcements have been sent.
   */
  forgetSession(sessionId: string): ForgetSessionOutcome;

  /* ---- session fan-out (the SessionBroadcaster port) ---- */

  /**
   * Delivers `message` to every client of the session: its editors and the
   * connection carrying its bound tab.
   *
   * @returns How many connections received the frame. A frame whose envelope
   * or embedded session record names a different session is refused (0).
   */
  broadcast(sessionId: string, message: ProtocolMessage): number;

  /**
   * {@link broadcast}, restricted to `kinds`. `agent` is carried by the bound
   * tab's DevTools connection; `server-agent` never receives session fan-out.
   *
   * @returns How many connections received the frame. The count is the
   * delivery receipt `../telemetry/live-tail.ts` relies on (its
   * `TailBroadcaster` narrows the session port to this `number`): 0 — when the
   * session's bound tab has no online DevTools connection, no tab is bound, the
   * frame is refused, or the registry is closed — keeps a `telemetry.tail`
   * frame queued for a retry, so it must never be reported as delivered.
   */
  broadcastToKinds(
    sessionId: string,
    kinds: readonly ClientKind[],
    message: ProtocolMessage,
  ): number;

  /* ---- deterministic single recipients ---- */

  /**
   * Delivers to one connection — the reply path for a frame that connection
   * sent. The principal filter still applies.
   *
   * @returns The receipt; `UNAUTHORIZED` when the connection may not see a
   * frame for that session; `TRANSPORT_DISCONNECTED` when it is unknown,
   * offline or the write failed.
   */
  sendToClient(clientId: string, message: ProtocolMessage): Result<DeliveryReceipt, DebuggenError>;

  /**
   * The connection that carries a session's bound tab — the relay for the page
   * agent and the recipient of `agent.config`, `target.request` and
   * `telemetry.tail`.
   *
   * @returns The client; `TAB_NOT_BOUND` when no tab is bound;
   * `TRANSPORT_DISCONNECTED` when the binding's DevTools connection is offline.
   */
  agentClientForSession(sessionId: string): Result<RegisteredClient, DebuggenError>;

  /**
   * Delivers to the session's bound tab (see {@link agentClientForSession}).
   *
   * @returns The receipt, or the error naming the missing recipient.
   */
  sendToBoundTab(
    sessionId: string,
    message: ProtocolMessage,
  ): Result<DeliveryReceipt, DebuggenError>;

  /**
   * The most recently connected online server agent of a project.
   *
   * @returns The client; `SERVER_AGENT_NOT_READY` when none is connected.
   */
  serverAgentForProject(projectRoot: string): Result<RegisteredClient, DebuggenError>;

  /** Every online server-agent connection of a project, in registration order. */
  serverAgentsForProject(projectRoot: string): readonly RegisteredClient[];

  /**
   * Delivers a `server-agent.config` frame to every online server-agent
   * connection of the project. A dev server may run the preload in more than
   * one process (a supervisor and the server child both inherit
   * `NODE_OPTIONS`), and each must apply the same configuration; the content —
   * the single capture owner — is decided by the caller.
   *
   * @returns The receipt; `PROTOCOL_INVALID_MESSAGE` for any other message
   * type; `UNAUTHORIZED` when the frame names a session of another project;
   * `SERVER_AGENT_NOT_READY` when no server agent is connected.
   */
  sendToServerAgent(
    projectRoot: string,
    message: ProtocolMessage,
  ): Result<DeliveryReceipt, DebuggenError>;

  /** Every online editor connection whose workspace covers the project, in registration order. */
  editorClientsForProject(projectRoot: string): readonly RegisteredClient[];

  /**
   * Delivers an editor-bound push (for example a forwarded `source.open`) to
   * every online editor connection whose workspace covers the project.
   *
   * @returns The receipt; `TRANSPORT_DISCONNECTED` when no editor is connected
   * (the caller's cue for the `vscode://` fallback); `UNAUTHORIZED` when the
   * frame names a session of another project.
   */
  sendToEditors(
    projectRoot: string,
    message: ProtocolMessage,
  ): Result<DeliveryReceipt, DebuggenError>;

  /* ---- bindings (live view) ---- */

  /**
   * Binds a tab to a session for the binding principal, enforcing AAP §0.2.3's
   * cardinality: a previous binding of the tab and a previous tab of the
   * session are displaced and returned, each with the reason to announce.
   * Re-binding the same tab to the same session with the same credential (a
   * service-worker reconnect re-announcing its bindings) is idempotent and
   * displaces nothing.
   *
   * @returns The outcome; `UNAUTHORIZED` for a non-DevTools principal or a
   * `clientId` that is not a connection of that credential;
   * `PROTOCOL_INVALID_MESSAGE` for a malformed tab id, session id or URL.
   */
  bindTab(input: BindTabInput): Result<BindTabOutcome, DebuggenError>;

  /**
   * Keeps a binding across a same-origin navigation and records the new URL.
   * Origin comparison belongs to `routes/binding.ts`.
   *
   * @returns The binding with reason `navigated`; `TAB_NOT_BOUND` when the tab
   * is not bound (or, for a DevTools principal, not bound by it).
   */
  updateTabUrl(input: UpdateTabUrlInput): Result<BindingChange, DebuggenError>;

  /**
   * Drops a tab's binding. Idempotent: an unbound tab yields `ok(undefined)`.
   *
   * @returns The dropped binding with its reason; `PROTOCOL_INVALID_MESSAGE`
   * for a reason that does not end a binding; `TAB_NOT_BOUND` when a DevTools
   * principal is given that did not make the binding.
   */
  unbindTab(
    tabId: number,
    options?: UnbindTabOptions,
  ): Result<BindingChange | undefined, DebuggenError>;

  /** The live binding of a tab, or `undefined`. */
  bindingForTab(tabId: number): TabBindingView | undefined;

  /** The live binding of a session, or `undefined`. */
  bindingForSession(sessionId: string): TabBindingView | undefined;

  /* ---- tabs awaiting a session ---- */

  /**
   * Records that a tab a DevTools credential announced awaits a session for
   * `origin`, so the next session created for that dev-server origin reaches
   * the connection carrying the tab with its `session.created` (see "Tabs
   * awaiting a session" in the module overview). Replaces the tab's previous
   * record; the oldest record is evicted past {@link MAX_AWAITING_TABS}.
   *
   * @returns `UNAUTHORIZED` for a non-DevTools principal or a `clientId` that
   * is not a connection of that credential; `PROTOCOL_INVALID_MESSAGE` for a
   * malformed tab id or a value that is not a serialized HTTP(S) origin.
   */
  awaitSession(input: AwaitSessionInput): Result<void, DebuggenError>;

  /**
   * Ends a tab's awaiting record — its DevTools closed. With a DevTools
   * `principal`, only a record that credential made is ended.
   *
   * @returns Whether a record was ended.
   */
  forgetAwaitingTab(tabId: number, principal?: Principal): boolean;

  /** The origin a tab awaits a session for, or `undefined` when it awaits none. */
  awaitedOriginForTab(tabId: number): string | undefined;

  /**
   * Offers a session that already serves the origin a tab awaits — one created
   * while the tab was still bound to the session that just ended, so its
   * `session.created` fan-out could not reach the tab — by delivering that
   * session's `session.created` to the one connection carrying the tab, and to
   * nothing else. The worker then announces the tab with `session.bind`, as
   * for a session created afterwards.
   *
   * @returns The delivery receipt; `PROTOCOL_INVALID_MESSAGE` for any frame
   * other than a `session.created` whose session serves the awaited origin;
   * `TAB_NOT_BOUND` when the tab awaits no session; `TRANSPORT_DISCONNECTED`
   * when the registry is closed or no connection of the announcing credential
   * is online.
   */
  offerSessionToAwaitingTab(
    tabId: number,
    message: ProtocolMessage,
  ): Result<DeliveryReceipt, DebuggenError>;

  /* ---- liveness ---- */

  /**
   * Marks a connection offline: frames addressed to it are dropped and
   * counted, while its registration, sessions and bindings are kept.
   *
   * @returns Whether the connection is known.
   */
  markOffline(clientId: string, now?: number): boolean;

  /** Marks a connection online again. @returns Whether the connection is known. */
  markOnline(clientId: string, now?: number): boolean;

  /**
   * Records inbound activity. A frame from a connection proves it alive, so an
   * offline connection whose socket is open is marked online.
   *
   * @returns Whether the connection is known.
   */
  touch(clientId: string, now?: number): boolean;

  /**
   * Housekeeping: closes and removes connections offline past the grace period
   * and connections whose credential expired, and expires released-binding
   * notices. Bindings are never dropped here.
   *
   * @returns How many connections were removed.
   */
  sweep(now?: number): number;

  /** Current counters. */
  stats(): ClientRegistryStats;

  /* ---- shutdown and revocation ---- */

  /**
   * Closes and removes every connection matching `filter` — for example a
   * project's server agents once their credentials are revoked.
   *
   * @returns How many sockets were closed.
   */
  closeWhere(filter: ClientFilter, code: number, reason?: string): number;

  /**
   * Closes every socket, clears every index and binding, stops the sweep timer
   * and refuses further registrations. Idempotent.
   *
   * @returns How many sockets were closed.
   */
  closeAll(code?: number, reason?: string): number;

  /**
   * The `ConnectionRevoker` port: closes every socket with `code` (protocol's
   * `WS_CLOSE_UNAUTHORIZED` on rotation) and drops every live binding, since
   * every credential that made one has been revoked. The registry stays open
   * for the re-paired clients.
   *
   * @returns How many sockets were closed.
   */
  revokeAll(code: number, reason?: string): number;
}

/** What {@link createClientRegistry} is built from. Every field is optional. */
export interface ClientRegistryDeps {
  /** The service logger; this module binds its own subsystem. Defaults to silence. */
  readonly logger?: Logger | undefined;
  /** The clock, in epoch milliseconds. */
  readonly now?: (() => number) | undefined;
  /** The connection-id factory. Defaults to the shared id generator with {@link CLIENT_ID_PREFIX}. */
  readonly newClientId?: (() => string) | undefined;
  /** See {@link DEFAULT_OFFLINE_GRACE_MS}. */
  readonly offlineGraceMs?: number | undefined;
  /**
   * When set, {@link ClientRegistry.sweep} runs on this interval. The timer is
   * `unref()`ed and cleared by {@link ClientRegistry.closeAll}. Unset by
   * default: no timer exists unless asked for.
   */
  readonly sweepIntervalMs?: number | undefined;
  /** See {@link DEFAULT_MAX_CLIENTS}. */
  readonly maxClients?: number | undefined;
  /** See {@link DEFAULT_MAX_BUFFERED_BYTES}. */
  readonly maxBufferedBytes?: number | undefined;
  /** See {@link RELEASED_BINDING_NOTICE_WINDOW_MS}. */
  readonly releasedNoticeWindowMs?: number | undefined;
}

/** Accepts only `true`, so an assertion that evaluates to `false` fails to compile. */
type AssertTrue<T extends true> = T;

/**
 * Compile-time proof that a {@link TabBindingView} can be handed to
 * `./auth.ts`'s `requireBoundSession` as its `TabBinding`: if either shape
 * drifts, this alias stops compiling.
 */
export type TabBindingViewIsAuthTabBinding = AssertTrue<
  TabBindingView extends TabBinding ? true : false
>;

/**
 * The shape `sessions/manager.ts` declares as its `SessionBroadcaster` port
 * (AAP §0.7.1). Restated here only as the target of the conformance check in
 * {@link createClientRegistry}: the port's declaring module sits above this
 * one, and importing it would invert the layering.
 *
 * The `void` results are the manager's port verbatim. The registry's own
 * {@link ClientRegistry} signatures answer a `number`, which is what also makes
 * it `../telemetry/live-tail.ts`'s `TailBroadcaster` (the same port with the
 * count as a delivery receipt); `../main.ts` hands the registry to both, and the
 * compiler checks each hand-off there.
 */
interface SessionBroadcastPort {
  broadcast(sessionId: string, message: ProtocolMessage): void;
  broadcastToKinds(sessionId: string, kinds: readonly ClientKind[], message: ProtocolMessage): void;
}

/* -------------------------------------------------------------------------------------------------
 * Internal state
 * ---------------------------------------------------------------------------------------------- */

/** One connection's mutable bookkeeping. Never leaves the module; callers see {@link RegisteredClient}. */
interface ClientEntry {
  readonly id: string;
  readonly kind: ClientKind;
  readonly principal: Principal;
  readonly socket: ClientSocket;
  readonly projectRoot: string | undefined;
  readonly tabId: number | undefined;
  /** An editor's explicit session attachments. */
  readonly attached: Set<string>;
  readonly connectedAt: number;
  lastSeenAt: number;
  online: boolean;
  offlineSince: number | undefined;
  delivered: number;
  dropped: number;
}

/** One live binding. */
interface BindingEntry {
  readonly tabId: number;
  readonly sessionId: string;
  url: string;
  /** The binding credential's `tokenHash`. */
  readonly boundBy: string;
  readonly boundAt: number;
  /** The connection last known to carry the tab; re-resolved on every delivery. */
  recipientId: string | undefined;
}

/** A released binding whose connection may still receive binding announcements for the session. */
interface ReleasedNotice {
  readonly boundBy: string;
  readonly recipientId: string | undefined;
  readonly until: number;
}

/** One tab awaiting a session for its document's origin (see "Tabs awaiting a session"). */
interface AwaitingTab {
  readonly tabId: number;
  /** The serialized HTTP(S) origin of the tab's document. */
  readonly origin: string;
  /** The announcing credential's `tokenHash`. */
  readonly awaitedBy: string;
  /** The connection last known to carry the tab; re-resolved on every delivery. */
  recipientId: string | undefined;
}

/** Which single recipient a failed delivery was missing, carried in the error's `details`. */
type MissingRecipient = 'bound-tab' | 'server-agent' | 'editor' | 'client' | 'registry';

/**
 * Why one recipient of a delivery could not take the frame, as the drop log
 * names it: its registration was already removed (`unregistered`), it is
 * marked offline (`offline`), its credential expired and it was closed
 * (`expired`), its socket no longer reports itself open (`closed`), it was
 * closed for not draining its buffer (`backpressure`), or the write threw
 * (`send-failed`).
 */
type DropReason =
  'unregistered' | 'offline' | 'expired' | 'closed' | 'backpressure' | 'send-failed';

/** One recipient a delivery dropped the frame for, and why. */
interface DroppedRecipient {
  readonly entry: ClientEntry;
  readonly reason: DropReason;
}

/** The longest URL a binding records; longer ones are refused rather than truncated. */
const MAX_BINDING_URL_LENGTH = 8_192;

/** The most sessions whose project roots are remembered; the oldest unbound one is evicted first. */
const MAX_TRACKED_SESSIONS = 4_096;

/** A shared, never-mutated empty id set for index misses. */
const NO_IDS: ReadonlySet<string> = new Set<string>();

/** The receipt of a delivery with no recipient. */
const EMPTY_RECEIPT: DeliveryReceipt = Object.freeze({
  delivered: 0,
  dropped: 0,
  recipients: Object.freeze([]),
});

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Normalises an absolute project root to the product's POSIX form, the same
 * way `./auth.ts` normalises the roots it scopes credentials to.
 *
 * @returns The normalised root, or `undefined` for an empty, relative,
 * NUL-bearing or network-share path.
 */
function normalizeRoot(path: string): string | undefined {
  if (path.length === 0 || path.includes('\u0000')) {
    return undefined;
  }
  const posix = toPosix(path);
  if (posix.startsWith('//')) {
    return undefined;
  }
  if (!isAbsolutePosix(posix) && !isWindowsAbsolute(posix)) {
    return undefined;
  }
  const normalized = normalizePosix(posix);
  return isAbsolutePosix(normalized) || isWindowsAbsolute(normalized) ? normalized : undefined;
}

/** Whether two normalised roots name the same directory, by the shared containment predicate. */
function sameRoot(left: string, right: string): boolean {
  return isWithin(left, right) && isWithin(right, left);
}

/** A Chrome tab id: a non-negative safe integer (`chrome.tabs.TAB_ID_NONE` is -1). */
function isValidTabId(tabId: number): boolean {
  return Number.isSafeInteger(tabId) && tabId >= 0;
}

/** A usable routing key: non-empty and within protocol's id bound. */
function isValidRoutingId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_ROUTING_ID_LENGTH;
}

/** Clips a close reason to the bytes a close frame can carry, on a character boundary. */
function boundCloseReason(reason: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(reason).length <= MAX_CLOSE_REASON_BYTES) {
    return reason;
  }
  let clipped = '';
  let bytes = 0;
  for (const character of reason) {
    const width = encoder.encode(character).length;
    if (bytes + width > MAX_CLOSE_REASON_BYTES) {
      break;
    }
    clipped += character;
    bytes += width;
  }
  return clipped;
}

/** Builds a typed failure without echoing any caller-supplied value into its message. */
function failure(
  code: DebuggenErrorCode,
  message: string,
  recipient: MissingRecipient,
  hint?: string,
  details?: LogFields,
): Result<never, DebuggenError> {
  const merged: Readonly<Record<string, unknown>> = { recipient, ...details };
  return err(
    new DebuggenError(
      code,
      message,
      hint === undefined ? { details: merged } : { hint, details: merged },
    ),
  );
}

/**
 * The session a frame's payload embeds as a whole record (`session.created`,
 * `session.updated`), found by shape so no message name is spelled here.
 */
function embeddedSessionRecord(
  message: ProtocolMessage,
):
  { readonly id: string; readonly projectRoot: string; readonly devServerUrl: string } | undefined {
  const payload = message.payload;
  if (!('session' in payload)) {
    return undefined;
  }
  return {
    id: payload.session.id,
    projectRoot: payload.session.projectRoot,
    devServerUrl: payload.session.devServerUrl,
  };
}

/**
 * The serialized HTTP(S) origin of a URL, or `undefined` for one that does not
 * parse or whose origin is opaque — the comparison `routes/binding.ts` matches
 * a tab to a session's dev server with, so a different port, scheme or host
 * never matches.
 */
function httpOriginOf(url: string): string | undefined {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return undefined;
  }
  return parsed.origin;
}

/**
 * The session a frame belongs to, for its log records: the envelope's routing
 * key, else a string `sessionId` its payload carries, else the id of a session
 * record it embeds; `undefined` for a session-less frame.
 */
function frameSessionId(message: ProtocolMessage): string | undefined {
  if (message.sessionId !== undefined) {
    return message.sessionId;
  }
  const payload: unknown = message.payload;
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'sessionId' in payload &&
    typeof payload.sessionId === 'string'
  ) {
    return payload.sessionId;
  }
  return embeddedSessionRecord(message)?.id;
}

/** Adds `id` to the set under `key`, creating the set on first use. */
function addToIndex<K>(index: Map<K, Set<string>>, key: K, id: string): void {
  const ids = index.get(key);
  if (ids === undefined) {
    index.set(key, new Set([id]));
  } else {
    ids.add(id);
  }
}

/** Removes `id` from the set under `key`, deleting the set once empty so no index dangles. */
function removeFromIndex<K>(index: Map<K, Set<string>>, key: K, id: string): void {
  const ids = index.get(key);
  if (ids === undefined) {
    return;
  }
  ids.delete(id);
  if (ids.size === 0) {
    index.delete(key);
  }
}

/** Validates a numeric option, falling back to its default when unset. */
function numericOption(
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero: boolean,
): number {
  if (value === undefined) {
    return fallback;
  }
  const valid = Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
  if (!valid) {
    throw new DebuggenError(
      'CONFIG_INVALID',
      `The client registry option ${name} must be a ${allowZero ? 'non-negative' : 'positive'} finite number.`,
    );
  }
  return value;
}

/* -------------------------------------------------------------------------------------------------
 * The factory
 * ---------------------------------------------------------------------------------------------- */

/**
 * Creates an empty client registry.
 *
 * @param deps Injected clock, id factory, logger and bounds; all optional.
 * @returns The registry, which satisfies `SessionBroadcaster` and
 * `ConnectionRevoker` structurally.
 * @throws DebuggenError `CONFIG_INVALID` when a numeric bound is not a
 * positive finite number (`sweepIntervalMs` and `releasedNoticeWindowMs` may
 * be zero). These are wiring constants, not runtime input.
 */
export function createClientRegistry(deps: ClientRegistryDeps = {}): ClientRegistry {
  const log = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM);
  const clock = deps.now ?? nowEpochMs;
  const mintClientId = deps.newClientId ?? ((): string => newId(CLIENT_ID_PREFIX));
  const offlineGraceMs = numericOption(
    deps.offlineGraceMs,
    DEFAULT_OFFLINE_GRACE_MS,
    'offlineGraceMs',
    false,
  );
  const maxClients = numericOption(deps.maxClients, DEFAULT_MAX_CLIENTS, 'maxClients', false);
  const maxBufferedBytes = numericOption(
    deps.maxBufferedBytes,
    DEFAULT_MAX_BUFFERED_BYTES,
    'maxBufferedBytes',
    false,
  );
  const releasedNoticeWindowMs = numericOption(
    deps.releasedNoticeWindowMs,
    RELEASED_BINDING_NOTICE_WINDOW_MS,
    'releasedNoticeWindowMs',
    true,
  );
  const sweepIntervalMs = numericOption(deps.sweepIntervalMs, 0, 'sweepIntervalMs', true);

  /* ---- indices: every edit goes through indexClient / unindexClient / setBinding / releaseBinding ---- */

  const clients = new Map<string, ClientEntry>();
  const bySocket = new Map<ClientSocket, string>();
  const byKind = new Map<ClientKind, Set<string>>(
    CLIENT_KINDS.map((kind): [ClientKind, Set<string>] => [kind, new Set<string>()]),
  );
  const byProject = new Map<string, Set<string>>();
  const byTab = new Map<number, Set<string>>();
  const bySession = new Map<string, Set<string>>();
  const byCredential = new Map<string, Set<string>>();
  const bindingsByTab = new Map<number, BindingEntry>();
  const tabBySession = new Map<string, number>();
  const sessionProjects = new Map<string, string>();
  const released = new Map<string, ReleasedNotice[]>();
  /** Tabs awaiting a session, oldest record first (insertion order). */
  const awaitingByTab = new Map<number, AwaitingTab>();

  let closed = false;
  let totalDelivered = 0;
  let totalDropped = 0;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  /** The log fields that identify a connection: never the principal, never its digest. */
  function clientFields(entry: ClientEntry): LogFields {
    const fields: LogFields = {
      clientId: entry.id,
      [LOG_BINDING_KEYS.client]: entry.kind,
      role: entry.principal.role,
    };
    if (entry.projectRoot !== undefined) {
      fields['projectRoot'] = entry.projectRoot;
    }
    if (entry.tabId !== undefined) {
      fields['tabId'] = entry.tabId;
    }
    return fields;
  }

  function idsOfKind(kind: ClientKind): ReadonlySet<string> {
    return byKind.get(kind) ?? NO_IDS;
  }

  function indexClient(entry: ClientEntry): void {
    clients.set(entry.id, entry);
    bySocket.set(entry.socket, entry.id);
    addToIndex(byKind, entry.kind, entry.id);
    addToIndex(byCredential, entry.principal.tokenHash, entry.id);
    if (entry.projectRoot !== undefined) {
      addToIndex(byProject, entry.projectRoot, entry.id);
    }
    if (entry.tabId !== undefined) {
      addToIndex(byTab, entry.tabId, entry.id);
    }
  }

  /** Removes a connection from every index. Bindings stay: they belong to the credential. */
  function unindexClient(entry: ClientEntry): void {
    clients.delete(entry.id);
    if (bySocket.get(entry.socket) === entry.id) {
      bySocket.delete(entry.socket);
    }
    removeFromIndex(byKind, entry.kind, entry.id);
    removeFromIndex(byCredential, entry.principal.tokenHash, entry.id);
    if (entry.projectRoot !== undefined) {
      removeFromIndex(byProject, entry.projectRoot, entry.id);
    }
    if (entry.tabId !== undefined) {
      removeFromIndex(byTab, entry.tabId, entry.id);
    }
    for (const sessionId of entry.attached) {
      removeFromIndex(bySession, sessionId, entry.id);
    }
    entry.attached.clear();
    for (const binding of bindingsByTab.values()) {
      if (binding.recipientId === entry.id) {
        binding.recipientId = undefined;
      }
    }
    // A credential with no registered connection left can announce nothing
    // any more: its awaiting tabs end with it. A reconnecting worker registers
    // its new connection before the old one is swept, and re-announces its
    // tabs on connect either way.
    const credentialLive = byCredential.has(entry.principal.tokenHash);
    for (const [tabId, awaiting] of [...awaitingByTab]) {
      if (awaiting.awaitedBy !== entry.principal.tokenHash) {
        continue;
      }
      if (!credentialLive) {
        awaitingByTab.delete(tabId);
      } else if (awaiting.recipientId === entry.id) {
        awaiting.recipientId = undefined;
      }
    }
  }

  /* ---- bindings ---- */

  function bindingOfSession(sessionId: string): BindingEntry | undefined {
    const tabId = tabBySession.get(sessionId);
    return tabId === undefined ? undefined : bindingsByTab.get(tabId);
  }

  /**
   * The online DevTools connection holding credential `boundBy`: the preferred
   * connection when it qualifies, otherwise the most recently connected one —
   * which, after an MV3 service-worker reconnect, is the new socket.
   */
  function relayForCredential(
    boundBy: string,
    preferredId: string | undefined,
  ): ClientEntry | undefined {
    if (preferredId !== undefined) {
      const preferred = clients.get(preferredId);
      if (
        preferred !== undefined &&
        preferred.online &&
        preferred.kind === KIND_DEVTOOLS &&
        preferred.principal.tokenHash === boundBy
      ) {
        return preferred;
      }
    }
    let best: ClientEntry | undefined;
    for (const id of byCredential.get(boundBy) ?? NO_IDS) {
      const candidate = clients.get(id);
      if (candidate === undefined || !candidate.online || candidate.kind !== KIND_DEVTOOLS) {
        continue;
      }
      if (best === undefined || candidate.connectedAt >= best.connectedAt) {
        best = candidate;
      }
    }
    return best;
  }

  /** The connection carrying a binding's tab now, re-attaching the binding to it. */
  function relayOf(binding: BindingEntry): ClientEntry | undefined {
    const relay = relayForCredential(binding.boundBy, binding.recipientId);
    if (relay !== undefined) {
      binding.recipientId = relay.id;
    }
    return relay;
  }

  function bindingView(binding: BindingEntry): TabBindingView {
    const relay = relayOf(binding);
    const recipientId =
      relay?.id ??
      (binding.recipientId !== undefined && clients.has(binding.recipientId)
        ? binding.recipientId
        : undefined);
    const base = {
      tabId: binding.tabId,
      sessionId: binding.sessionId,
      url: binding.url,
      boundBy: binding.boundBy,
      boundAt: binding.boundAt,
      online: relay !== undefined,
    };
    return Object.freeze(recipientId === undefined ? base : { ...base, recipientId });
  }

  function setBinding(binding: BindingEntry): void {
    bindingsByTab.set(binding.tabId, binding);
    tabBySession.set(binding.sessionId, binding.tabId);
  }

  /**
   * Removes a binding from both binding indices and leaves a released notice,
   * so the binding's connection can still be told about the change.
   */
  function releaseBinding(binding: BindingEntry, now: number): void {
    if (bindingsByTab.get(binding.tabId) === binding) {
      bindingsByTab.delete(binding.tabId);
    }
    if (tabBySession.get(binding.sessionId) === binding.tabId) {
      tabBySession.delete(binding.sessionId);
    }
    if (releasedNoticeWindowMs === 0) {
      return;
    }
    pruneReleased(now);
    const notices = (released.get(binding.sessionId) ?? []).filter((notice) => notice.until > now);
    notices.push({
      boundBy: binding.boundBy,
      recipientId: relayOf(binding)?.id ?? binding.recipientId,
      until: now + releasedNoticeWindowMs,
    });
    released.set(binding.sessionId, notices.slice(-MAX_RELEASED_NOTICES_PER_SESSION));
  }

  /** Drops every expired released notice, so notices of sessions never addressed again cannot accumulate. */
  function pruneReleased(now: number): void {
    for (const sessionId of [...released.keys()]) {
      liveNotices(sessionId, now);
    }
  }

  /** The unexpired released notices of a session, pruning the rest. */
  function liveNotices(sessionId: string, now: number): readonly ReleasedNotice[] {
    const notices = released.get(sessionId);
    if (notices === undefined) {
      return [];
    }
    const live = notices.filter((notice) => notice.until > now);
    if (live.length === 0) {
      released.delete(sessionId);
    } else if (live.length !== notices.length) {
      released.set(sessionId, live);
    }
    return live;
  }

  function credentialBindsSession(tokenHash: string, sessionId: string): boolean {
    return bindingOfSession(sessionId)?.boundBy === tokenHash;
  }

  function credentialReleasedSession(tokenHash: string, sessionId: string, now: number): boolean {
    return liveNotices(sessionId, now).some((notice) => notice.boundBy === tokenHash);
  }

  /* ---- session knowledge ---- */

  function rememberSessionProject(sessionId: string, root: string): void {
    if (!sessionProjects.has(sessionId) && sessionProjects.size >= MAX_TRACKED_SESSIONS) {
      for (const candidate of sessionProjects.keys()) {
        if (!tabBySession.has(candidate) && !bySession.has(candidate)) {
          sessionProjects.delete(candidate);
          break;
        }
      }
    }
    sessionProjects.set(sessionId, root);
  }

  /** Whether an editor's announced workspace covers a project root. */
  function editorCovers(entry: ClientEntry, root: string): boolean {
    const principal = entry.principal;
    if (principal.role !== KIND_VSCODE) {
      return false;
    }
    return principal.scope.workspaceFolders.some((folder) => isWithin(folder, root));
  }

  /**
   * Whether an editor receives a session's fan-out: by workspace scope once the
   * session's project is known, by explicit attachment until then.
   */
  function editorFollows(entry: ClientEntry, sessionId: string): boolean {
    if (entry.principal.role !== KIND_VSCODE) {
      return false;
    }
    const root = sessionProjects.get(sessionId);
    return root === undefined ? entry.attached.has(sessionId) : editorCovers(entry, root);
  }

  /** Whether a frame's session, when it names a tracked one, belongs to `root`. */
  function frameSessionWithin(message: ProtocolMessage, root: string): boolean {
    const sessionId = message.sessionId;
    if (sessionId === undefined) {
      return true;
    }
    const tracked = sessionProjects.get(sessionId);
    return tracked === undefined || sameRoot(tracked, root);
  }

  /**
   * The admission check of every session-scoped delivery: the routing key is
   * usable, the envelope and any embedded session record agree with it, and an
   * embedded record's project is learned (or checked against the tracked one).
   */
  function admitSessionFrame(sessionId: string, message: ProtocolMessage): boolean {
    if (!isValidRoutingId(sessionId)) {
      log.warn('Refused a frame with an unusable session routing key', { type: message.type });
      return false;
    }
    if (message.sessionId !== undefined && message.sessionId !== sessionId) {
      log.warn('Refused a frame whose envelope routes to another session', {
        [LOG_BINDING_KEYS.sessionId]: sessionId,
        type: message.type,
      });
      return false;
    }
    return learnFromFrame(message, sessionId);
  }

  /**
   * Learns (or checks) the project of a frame's embedded session record.
   *
   * @returns `false` when the record contradicts the routing key or the
   * session's tracked project — a frame no client should receive.
   */
  function learnFromFrame(message: ProtocolMessage, sessionId: string | undefined): boolean {
    const record = embeddedSessionRecord(message);
    if (record === undefined) {
      return true;
    }
    if (sessionId !== undefined && record.id !== sessionId) {
      log.warn('Refused a frame whose session record names another session', {
        [LOG_BINDING_KEYS.sessionId]: sessionId,
        type: message.type,
      });
      return false;
    }
    const root = normalizeRoot(record.projectRoot);
    if (root === undefined) {
      return true;
    }
    const tracked = sessionProjects.get(record.id);
    if (tracked === undefined) {
      rememberSessionProject(record.id, root);
      return true;
    }
    if (!sameRoot(tracked, root)) {
      log.warn('Refused a frame whose session record moved to another project', {
        [LOG_BINDING_KEYS.sessionId]: record.id,
        type: message.type,
      });
      return false;
    }
    return true;
  }

  /* ---- snapshots ---- */

  /** The sessions a connection follows: attachments for an editor, its credential's bindings for DevTools. */
  function followedSessions(entry: ClientEntry): ReadonlySet<string> {
    if (entry.kind === KIND_VSCODE) {
      return new Set(entry.attached);
    }
    if (entry.kind !== KIND_DEVTOOLS) {
      return NO_IDS;
    }
    const sessions = new Set<string>();
    for (const binding of bindingsByTab.values()) {
      if (binding.boundBy === entry.principal.tokenHash) {
        sessions.add(binding.sessionId);
      }
    }
    return sessions;
  }

  function snapshot(entry: ClientEntry): RegisteredClient {
    const view: {
      -readonly [K in keyof RegisteredClient]: RegisteredClient[K];
    } = {
      id: entry.id,
      kind: entry.kind,
      principal: entry.principal,
      socket: entry.socket,
      sessionIds: followedSessions(entry),
      connectedAt: entry.connectedAt,
      lastSeenAt: entry.lastSeenAt,
      online: entry.online,
      delivered: entry.delivered,
      dropped: entry.dropped,
    };
    if (entry.projectRoot !== undefined) {
      view.projectRoot = entry.projectRoot;
    }
    if (entry.tabId !== undefined) {
      view.tabId = entry.tabId;
    }
    if (entry.offlineSince !== undefined) {
      view.offlineSince = entry.offlineSince;
    }
    return Object.freeze(view);
  }

  /* ---- liveness and closing ---- */

  function setOffline(entry: ClientEntry, now: number): void {
    if (entry.online) {
      entry.online = false;
      entry.offlineSince = now;
      log.debug('Client marked offline; its sessions and bindings are kept', clientFields(entry));
    }
  }

  function setOnline(entry: ClientEntry, now: number): void {
    entry.lastSeenAt = now;
    if (!entry.online) {
      entry.online = true;
      entry.offlineSince = undefined;
      log.debug('Client back online', clientFields(entry));
    }
  }

  function socketIsOpen(socket: ClientSocket): boolean {
    return socket.readyState === undefined || socket.readyState === SOCKET_READY_STATE_OPEN;
  }

  function credentialExpired(entry: ClientEntry, now: number): boolean {
    const expiresAt = entry.principal.expiresAt;
    return expiresAt !== undefined && now >= expiresAt;
  }

  /**
   * Starts the closing handshake and removes the connection from every index.
   *
   * @returns Whether `close` returned without throwing.
   */
  function closeAndRemove(entry: ClientEntry, code: number, reason: string): boolean {
    let closedCleanly = true;
    try {
      entry.socket.close(code, boundCloseReason(reason));
    } catch (cause) {
      closedCleanly = false;
      log.debug('A socket refused to close; it is removed regardless', {
        ...clientFields(entry),
        [LOG_ERROR_FIELD_KEY]: cause,
      });
    }
    unindexClient(entry);
    return closedCleanly;
  }

  function recordDrop(entry: ClientEntry | undefined): void {
    totalDropped += 1;
    if (entry !== undefined) {
      entry.dropped += 1;
    }
  }

  /* ---- the delivery engine ---- */

  /**
   * The fields of a delivery's one drop record: the frame's type and session,
   * the delivered and dropped counts, and who missed the frame and why. One
   * dropped recipient is named directly (`clientId`, `client`, `reason`);
   * several are named by parallel arrays in delivery order (`clientIds`,
   * `clients`, `reasons`). Identity only, per this module's privacy rule: never
   * a principal, never its digest.
   */
  function dropFields(
    message: ProtocolMessage,
    delivered: number,
    missed: readonly DroppedRecipient[],
  ): LogFields {
    const fields: LogFields = { type: message.type, dropped: missed.length, delivered };
    const sessionId = frameSessionId(message);
    if (sessionId !== undefined) {
      fields[LOG_BINDING_KEYS.sessionId] = sessionId;
    }
    const [only] = missed;
    if (missed.length === 1 && only !== undefined) {
      fields['clientId'] = only.entry.id;
      fields[LOG_BINDING_KEYS.client] = only.entry.kind;
      fields['reason'] = only.reason;
    } else {
      fields['clientIds'] = missed.map((drop) => drop.entry.id);
      fields['clients'] = missed.map((drop) => drop.entry.kind);
      fields['reasons'] = missed.map((drop) => drop.reason);
    }
    return fields;
  }

  /**
   * Writes one frame to each recipient, in order, encoding it once.
   *
   * Synchronous and failure-isolated: a recipient that cannot take the frame is
   * counted as dropped (and, where the socket is at fault, marked offline or
   * closed) and the loop continues. A delivery that dropped the frame for
   * anyone writes one debug record naming each such recipient and its reason
   * (see {@link dropFields}).
   */
  function deliver(recipients: readonly ClientEntry[], message: ProtocolMessage): DeliveryReceipt {
    if (recipients.length === 0) {
      return EMPTY_RECEIPT;
    }
    let frame: string;
    try {
      frame = encodeMessage(message);
    } catch (cause) {
      for (const entry of recipients) {
        recordDrop(entry);
      }
      log.warn('A frame could not be serialised and was sent to no one', {
        type: message.type,
        [LOG_ERROR_FIELD_KEY]: cause,
      });
      return Object.freeze({ delivered: 0, dropped: recipients.length, recipients: [] });
    }

    const now = clock();
    const sent: string[] = [];
    const missed: DroppedRecipient[] = [];
    const drop = (entry: ClientEntry, reason: DropReason): void => {
      recordDrop(entry);
      missed.push({ entry, reason });
    };
    for (const entry of recipients) {
      if (clients.get(entry.id) !== entry || !entry.online) {
        drop(entry, clients.get(entry.id) === entry ? 'offline' : 'unregistered');
        continue;
      }
      if (credentialExpired(entry, now)) {
        log.info('Closed a connection whose credential expired', clientFields(entry));
        closeAndRemove(entry, WS_CLOSE_UNAUTHORIZED, EXPIRED_CLOSE_REASON);
        drop(entry, 'expired');
        continue;
      }
      if (!socketIsOpen(entry.socket)) {
        setOffline(entry, now);
        drop(entry, 'closed');
        continue;
      }
      const buffered = entry.socket.bufferedAmount;
      if (buffered !== undefined && buffered > maxBufferedBytes) {
        log.warn('Closed a connection that is not draining its frames', {
          ...clientFields(entry),
          bufferedAmount: buffered,
        });
        closeAndRemove(entry, WS_CLOSE_TRY_AGAIN_LATER, BACKPRESSURE_CLOSE_REASON);
        drop(entry, 'backpressure');
        continue;
      }
      try {
        entry.socket.send(frame);
        entry.delivered += 1;
        totalDelivered += 1;
        sent.push(entry.id);
      } catch (cause) {
        setOffline(entry, now);
        drop(entry, 'send-failed');
        log.debug('A send failed; the client is marked offline', {
          ...clientFields(entry),
          type: message.type,
          [LOG_ERROR_FIELD_KEY]: cause,
        });
      }
    }
    if (missed.length > 0) {
      log.debug(
        'Frames dropped for clients that could not take them',
        dropFields(message, sent.length, missed),
      );
    }
    return Object.freeze({
      delivered: sent.length,
      dropped: missed.length,
      recipients: Object.freeze(sent),
    });
  }

  /** Delivers to a resolved recipient list and turns "nobody took it" into a named failure. */
  function deliverOrFail(
    recipients: readonly ClientEntry[],
    message: ProtocolMessage,
    recipient: MissingRecipient,
  ): Result<DeliveryReceipt, DebuggenError> {
    const receipt = deliver(recipients, message);
    if (receipt.delivered === 0) {
      return failure(
        'TRANSPORT_DISCONNECTED',
        'The connection could not take the frame.',
        recipient,
        'The client reconnects automatically; the frame is replayed from stored data when it does.',
      );
    }
    return ok(receipt);
  }

  /**
   * The principal filter of a direct delivery: which frames one connection may
   * be sent regardless of fan-out.
   *
   * A server-agent connection is pushed its own project's configuration and
   * nothing else, except the two session-less replies to a frame it sent: the
   * `error` refusing it and the `service.pong` answering its `client.ping`.
   * Both carry only the sender's own frame id, so admitting them discloses
   * nothing about any session. Every other connection receives a session-less
   * frame unconditionally below.
   */
  function mayReceiveDirect(entry: ClientEntry, message: ProtocolMessage, now: number): boolean {
    const principal = entry.principal;
    if (principal.role === KIND_SERVER_AGENT) {
      if (message.type === ERROR_REPLY_TYPE || message.type === LIVENESS_REPLY_TYPE) {
        return true;
      }
      return (
        message.type === SERVER_AGENT_CONFIG_TYPE &&
        frameSessionWithin(message, principal.scope.projectRoot)
      );
    }
    const sessionId = message.sessionId;
    if (sessionId === undefined) {
      return true;
    }
    if (principal.role === KIND_DEVTOOLS) {
      return (
        credentialBindsSession(principal.tokenHash, sessionId) ||
        (message.type === BINDING_ANNOUNCEMENT_TYPE &&
          credentialReleasedSession(principal.tokenHash, sessionId, now))
      );
    }
    return editorFollows(entry, sessionId);
  }

  /** The online server-agent connections scoped to exactly `root`. */
  function serverAgentEntries(root: string): ClientEntry[] {
    const found: ClientEntry[] = [];
    for (const id of byProject.get(root) ?? NO_IDS) {
      const entry = clients.get(id);
      if (
        entry !== undefined &&
        entry.online &&
        entry.principal.role === KIND_SERVER_AGENT &&
        sameRoot(entry.principal.scope.projectRoot, root)
      ) {
        found.push(entry);
      }
    }
    return found;
  }

  /** The online editor connections whose workspace covers `root`. */
  function editorEntries(root: string): ClientEntry[] {
    const found: ClientEntry[] = [];
    for (const id of idsOfKind(KIND_VSCODE)) {
      const entry = clients.get(id);
      if (entry !== undefined && entry.online && editorCovers(entry, root)) {
        found.push(entry);
      }
    }
    return found;
  }

  /**
   * Resolves a session's fan-out for `kinds`: its editors, the connection
   * carrying its bound tab (which also relays for the page agent), and — for a
   * binding announcement only — the connections whose binding it just released.
   */
  function sessionRecipients(
    sessionId: string,
    kinds: ReadonlySet<ClientKind>,
    message: ProtocolMessage,
  ): ClientEntry[] {
    const recipients: ClientEntry[] = [];
    const seen = new Set<string>();
    const add = (entry: ClientEntry): void => {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        recipients.push(entry);
      }
    };

    if (kinds.has(KIND_VSCODE)) {
      for (const id of idsOfKind(KIND_VSCODE)) {
        const entry = clients.get(id);
        if (entry !== undefined && editorFollows(entry, sessionId)) {
          add(entry);
        }
      }
    }
    if (kinds.has(KIND_DEVTOOLS) || kinds.has(KIND_AGENT)) {
      const binding = bindingOfSession(sessionId);
      if (binding !== undefined) {
        const relay = relayOf(binding);
        if (relay === undefined) {
          recordDrop(undefined);
          log.debug('The bound tab of a session has no online DevTools connection', {
            [LOG_BINDING_KEYS.sessionId]: sessionId,
            tabId: binding.tabId,
            type: message.type,
          });
        } else {
          add(relay);
        }
      }
    }
    if (kinds.has(KIND_DEVTOOLS) && message.type === BINDING_ANNOUNCEMENT_TYPE) {
      for (const notice of liveNotices(sessionId, clock())) {
        const relay = relayForCredential(notice.boundBy, notice.recipientId);
        if (relay !== undefined) {
          add(relay);
        }
      }
    }
    if (kinds.has(KIND_DEVTOOLS) && message.type === SESSION_CREATED_TYPE) {
      for (const relay of awaitingRelays(message)) {
        add(relay);
      }
    }
    return recipients;
  }

  /**
   * The connections carrying a tab that awaits the dev-server origin of the
   * session a `session.created` embeds — each announcing credential's
   * connection once, preferring the one that announced the tab.
   */
  function awaitingRelays(message: ProtocolMessage): ClientEntry[] {
    const record = embeddedSessionRecord(message);
    if (record === undefined || awaitingByTab.size === 0) {
      return [];
    }
    const origin = httpOriginOf(record.devServerUrl);
    if (origin === undefined) {
      return [];
    }
    const relays: ClientEntry[] = [];
    let tabs = 0;
    for (const awaiting of awaitingByTab.values()) {
      if (awaiting.origin !== origin) {
        continue;
      }
      tabs += 1;
      const relay = relayForCredential(awaiting.awaitedBy, awaiting.recipientId);
      if (relay === undefined) {
        recordDrop(undefined);
        continue;
      }
      awaiting.recipientId = relay.id;
      if (!relays.includes(relay)) {
        relays.push(relay);
      }
    }
    if (tabs > 0) {
      log.debug('A new session reaches the DevTools connections of tabs awaiting its origin', {
        [LOG_BINDING_KEYS.sessionId]: record.id,
        tabs,
        connections: relays.length,
      });
    }
    return relays;
  }

  function fanOut(
    sessionId: string,
    kinds: readonly ClientKind[],
    message: ProtocolMessage,
  ): number {
    if (closed || !admitSessionFrame(sessionId, message)) {
      return 0;
    }
    const recipients = sessionRecipients(sessionId, new Set(kinds), message);
    if (recipients.length === 0) {
      log.debug('No connected client follows the session; frame not sent', {
        [LOG_BINDING_KEYS.sessionId]: sessionId,
        type: message.type,
      });
      return 0;
    }
    return deliver(recipients, message).delivered;
  }

  /* ---- filtering ---- */

  function matchesFilter(entry: ClientEntry, filter: ClientFilter): boolean {
    const { kind, projectRoot, tabId, sessionId, online } = filter;
    if (kind !== undefined) {
      const kinds: readonly ClientKind[] = typeof kind === 'string' ? [kind] : kind;
      if (!kinds.includes(entry.kind)) {
        return false;
      }
    }
    if (online !== undefined && entry.online !== online) {
      return false;
    }
    if (projectRoot !== undefined) {
      const root = normalizeRoot(projectRoot);
      if (root === undefined) {
        return false;
      }
      const principal = entry.principal;
      const scoped =
        principal.role === KIND_SERVER_AGENT
          ? sameRoot(principal.scope.projectRoot, root)
          : editorCovers(entry, root);
      if (!scoped) {
        return false;
      }
    }
    if (tabId !== undefined) {
      const binding = bindingsByTab.get(tabId);
      const carries = binding !== undefined && relayOf(binding)?.id === entry.id;
      if (entry.tabId !== tabId && !carries) {
        return false;
      }
    }
    if (sessionId !== undefined) {
      const binding = bindingOfSession(sessionId);
      const carries = binding !== undefined && relayOf(binding)?.id === entry.id;
      if (!carries && !editorFollows(entry, sessionId)) {
        return false;
      }
    }
    return true;
  }

  function entriesMatching(filter: ClientFilter | undefined): ClientEntry[] {
    const all = [...clients.values()];
    return filter === undefined ? all : all.filter((entry) => matchesFilter(entry, filter));
  }

  /* ---- registration ---- */

  /**
   * Whether a registration is retained offline over a socket that can never
   * carry a frame again. `ws.ts` keeps a closed connection's registration for
   * the offline grace period so its identity stays visible, but such a
   * registration is not a live connection and holds no slot under the
   * connection bound. An offline registration whose socket still reports
   * itself open can come back online (a frame on it `touch`es it) and keeps
   * its slot.
   */
  function holdsNoSlot(entry: ClientEntry): boolean {
    return !entry.online && !socketIsOpen(entry.socket);
  }

  /**
   * Makes room under the connection bound by releasing up to `needed`
   * registrations retained offline over a closed socket, the longest-offline
   * first (registration order among equals, as the sort is stable).
   *
   * Released through {@link unindexClient}, the same path `unregister` takes:
   * nothing is closed (the socket already is), and every binding stays with
   * the credential that made it, so the credential's next connection carries
   * it. `ws.ts`'s offline-grace timer later unregisters the released id, which
   * finds nothing and returns `undefined`.
   *
   * @returns How many registrations were released.
   */
  function releaseClosedSlots(needed: number): number {
    if (needed <= 0) {
      return 0;
    }
    const candidates = [...clients.values()].filter(holdsNoSlot);
    if (candidates.length === 0) {
      return 0;
    }
    const offlineAt = (entry: ClientEntry): number => entry.offlineSince ?? entry.lastSeenAt;
    candidates.sort((left, right) => offlineAt(left) - offlineAt(right));
    const now = clock();
    const releasing = candidates.slice(0, needed);
    for (const entry of releasing) {
      unindexClient(entry);
      log.debug('Released the connection slot of a closed connection retained offline', {
        ...clientFields(entry),
        offlineForMs: Math.max(0, now - offlineAt(entry)),
      });
    }
    return releasing.length;
  }

  function register(registration: ClientRegistration): Result<RegisteredClient, DebuggenError> {
    if (closed) {
      return failure(
        'TRANSPORT_DISCONNECTED',
        'The client registry is closed; the service is shutting down.',
        'registry',
      );
    }
    const { kind, principal, socket } = registration;
    if (!CLIENT_KINDS.includes(kind)) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'The connection announced an unknown client kind.',
        'client',
      );
    }
    if (kind === KIND_AGENT) {
      return failure(
        'UNAUTHORIZED',
        'The page agent has no connection of its own; its frames travel on the tab’s DevTools connection.',
        'client',
      );
    }
    if (principal.role !== kind) {
      return failure(
        'UNAUTHORIZED',
        'The connection’s client kind does not match its credential’s role.',
        'client',
      );
    }
    if (bySocket.has(socket)) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'This connection is already registered.',
        'client',
      );
    }
    // Only live connections count against the bound: a closed connection
    // retained offline gives up its slot the moment a new one needs it.
    if (clients.size >= maxClients) {
      releaseClosedSlots(clients.size - maxClients + 1);
    }
    if (clients.size >= maxClients) {
      log.warn('Refused a connection past the connection bound', { maxClients });
      return failure(
        'RATE_LIMITED',
        'Too many connections are open to the Debug Generator service.',
        'client',
        'Close unused VS Code windows or reload the Chrome extension, then reconnect.',
      );
    }

    let projectRoot: string | undefined;
    let tabId: number | undefined;
    if (principal.role === KIND_SERVER_AGENT) {
      if (registration.tabId !== undefined) {
        return failure('UNAUTHORIZED', 'A dev-server connection has no tab.', 'client');
      }
      projectRoot = normalizeRoot(principal.scope.projectRoot);
      if (projectRoot === undefined) {
        return failure(
          'UNAUTHORIZED',
          'The dev-server credential is not scoped to an absolute project root.',
          'client',
        );
      }
      if (registration.projectRoot !== undefined) {
        const announced = normalizeRoot(registration.projectRoot);
        if (announced === undefined || !sameRoot(announced, projectRoot)) {
          return failure(
            'UNAUTHORIZED',
            'A dev-server connection announced a project other than its credential’s.',
            'client',
          );
        }
      }
    } else if (principal.role === KIND_VSCODE) {
      if (registration.tabId !== undefined) {
        return failure('UNAUTHORIZED', 'An editor connection has no tab.', 'client');
      }
      if (registration.projectRoot !== undefined) {
        projectRoot = normalizeRoot(registration.projectRoot);
        if (projectRoot === undefined) {
          return failure(
            'PROTOCOL_INVALID_MESSAGE',
            'An editor connection must announce its workspace folder as an absolute path.',
            'client',
          );
        }
      }
    } else {
      if (registration.projectRoot !== undefined) {
        return failure(
          'UNAUTHORIZED',
          'A DevTools connection has no project root; its session reaches it through the tab binding.',
          'client',
        );
      }
      if (registration.tabId !== undefined) {
        if (!isValidTabId(registration.tabId)) {
          return failure(
            'PROTOCOL_INVALID_MESSAGE',
            'The announced tab id is not a Chrome tab id.',
            'client',
          );
        }
        tabId = registration.tabId;
      }
    }

    const now = clock();
    const expiresAt = principal.expiresAt;
    if (expiresAt !== undefined && now >= expiresAt) {
      return failure(
        'UNAUTHORIZED',
        'The connection’s credential has expired.',
        'client',
        'Reconnect with a current credential.',
      );
    }
    const id = mintClientId();
    if (clients.has(id)) {
      return failure('INTERNAL', 'A connection id was minted twice.', 'client');
    }
    const entry: ClientEntry = {
      id,
      kind,
      principal,
      socket,
      projectRoot,
      tabId,
      attached: new Set<string>(),
      connectedAt: now,
      lastSeenAt: now,
      online: true,
      offlineSince: undefined,
      delivered: 0,
      dropped: 0,
    };
    indexClient(entry);
    // Debug rather than info: the MV3 service worker reconnects after every
    // idle suspension (AAP §0.5.5), and each reconnect is an ordinary event.
    log.debug('Client connected', clientFields(entry));
    return ok(snapshot(entry));
  }

  function unregister(clientId: string): RegisteredClient | undefined {
    const entry = clients.get(clientId);
    if (entry === undefined) {
      return undefined;
    }
    const final = snapshot(entry);
    unindexClient(entry);
    log.debug('Client disconnected; its sessions and bindings are kept', clientFields(entry));
    return final;
  }

  /* ---- session association ---- */

  function attachSession(clientId: string, sessionId: string): Result<void, DebuggenError> {
    const entry = clients.get(clientId);
    if (entry === undefined) {
      return failure(
        'TRANSPORT_DISCONNECTED',
        'That connection is no longer registered.',
        'client',
      );
    }
    if (!isValidRoutingId(sessionId)) {
      return failure('PROTOCOL_INVALID_MESSAGE', 'A session id must be a non-empty id.', 'client');
    }
    const principal = entry.principal;
    if (principal.role === KIND_VSCODE) {
      const root = sessionProjects.get(sessionId);
      if (root !== undefined && !editorCovers(entry, root)) {
        return failure(
          'PATH_OUTSIDE_PROJECT',
          'The session belongs to a project outside this editor’s workspace.',
          'editor',
        );
      }
      entry.attached.add(sessionId);
      addToIndex(bySession, sessionId, entry.id);
      return ok(undefined);
    }
    if (principal.role === KIND_DEVTOOLS) {
      return credentialBindsSession(principal.tokenHash, sessionId)
        ? ok(undefined)
        : failure(
            'TAB_NOT_BOUND',
            'A DevTools connection follows only the session its tab is bound to.',
            'bound-tab',
          );
    }
    return failure('UNAUTHORIZED', 'A dev-server connection does not follow sessions.', 'client');
  }

  function detachSession(clientId: string, sessionId: string): boolean {
    const entry = clients.get(clientId);
    if (entry === undefined || !entry.attached.delete(sessionId)) {
      return false;
    }
    removeFromIndex(bySession, sessionId, entry.id);
    return true;
  }

  function trackSession(sessionId: string, projectRoot: string): Result<void, DebuggenError> {
    if (!isValidRoutingId(sessionId)) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'A session id must be a non-empty id.',
        'registry',
      );
    }
    const root = normalizeRoot(projectRoot);
    if (root === undefined) {
      return failure('PROJECT_NOT_FOUND', 'A project root must be an absolute path.', 'registry');
    }
    const tracked = sessionProjects.get(sessionId);
    if (tracked !== undefined && !sameRoot(tracked, root)) {
      return failure(
        'SESSION_INVALID_STATE',
        'The session is already tracked under a different project.',
        'registry',
      );
    }
    rememberSessionProject(sessionId, root);
    return ok(undefined);
  }

  function forgetSession(sessionId: string): ForgetSessionOutcome {
    let change: BindingChange | undefined;
    const binding = bindingOfSession(sessionId);
    if (binding !== undefined) {
      change = Object.freeze({ binding: bindingView(binding), reason: REASON_UNBOUND });
      releaseBinding(binding, clock());
    }
    let detached = 0;
    for (const id of bySession.get(sessionId) ?? NO_IDS) {
      const entry = clients.get(id);
      if (entry?.attached.delete(sessionId) === true) {
        detached += 1;
      }
    }
    bySession.delete(sessionId);
    sessionProjects.delete(sessionId);
    return Object.freeze(change === undefined ? { detached } : { binding: change, detached });
  }

  /* ---- single recipients ---- */

  function boundRelay(sessionId: string): Result<ClientEntry, DebuggenError> {
    const binding = bindingOfSession(sessionId);
    if (binding === undefined) {
      return failure(
        'TAB_NOT_BOUND',
        'No Chrome tab is bound to this session.',
        'bound-tab',
        'Open Chrome DevTools on the application’s tab and select the Debug Generator panel.',
        { [LOG_BINDING_KEYS.sessionId]: sessionId },
      );
    }
    const relay = relayOf(binding);
    if (relay === undefined) {
      return failure(
        'TRANSPORT_DISCONNECTED',
        'The DevTools connection of the bound tab is offline.',
        'bound-tab',
        'Keep DevTools open on the tab; the Chrome extension reconnects automatically.',
        { [LOG_BINDING_KEYS.sessionId]: sessionId, tabId: binding.tabId },
      );
    }
    return ok(relay);
  }

  function sendToClient(
    clientId: string,
    message: ProtocolMessage,
  ): Result<DeliveryReceipt, DebuggenError> {
    const entry = clients.get(clientId);
    if (entry === undefined) {
      return failure(
        'TRANSPORT_DISCONNECTED',
        'That connection is no longer registered.',
        'client',
      );
    }
    if (!learnFromFrame(message, message.sessionId)) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'The frame contradicts its own routing key.',
        'client',
      );
    }
    if (!mayReceiveDirect(entry, message, clock())) {
      log.warn('Refused a direct frame the connection may not receive', {
        ...clientFields(entry),
        type: message.type,
      });
      return failure('UNAUTHORIZED', 'This connection may not receive that frame.', 'client');
    }
    return deliverOrFail([entry], message, 'client');
  }

  function sendToBoundTab(
    sessionId: string,
    message: ProtocolMessage,
  ): Result<DeliveryReceipt, DebuggenError> {
    if (!admitSessionFrame(sessionId, message)) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'The frame does not route to this session.',
        'bound-tab',
      );
    }
    const relay = boundRelay(sessionId);
    if (!relay.ok) {
      return relay;
    }
    return deliverOrFail([relay.value], message, 'bound-tab');
  }

  function sendToServerAgent(
    projectRoot: string,
    message: ProtocolMessage,
  ): Result<DeliveryReceipt, DebuggenError> {
    if (message.type !== SERVER_AGENT_CONFIG_TYPE) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'Only a server-agent configuration frame may be sent to a dev-server agent.',
        'server-agent',
      );
    }
    const root = normalizeRoot(projectRoot);
    if (root === undefined) {
      return failure(
        'PROJECT_NOT_FOUND',
        'A project root must be an absolute path.',
        'server-agent',
      );
    }
    if (!frameSessionWithin(message, root)) {
      return failure(
        'UNAUTHORIZED',
        'The configuration names a session of another project.',
        'server-agent',
      );
    }
    const recipients = serverAgentEntries(root);
    if (recipients.length === 0) {
      return failure(
        'SERVER_AGENT_NOT_READY',
        'No dev-server agent is connected for this project.',
        'server-agent',
        'Launch the dev server from Debug Generator so its Node preload can connect, then try again.',
      );
    }
    return deliverOrFail(recipients, message, 'server-agent');
  }

  function sendToEditors(
    projectRoot: string,
    message: ProtocolMessage,
  ): Result<DeliveryReceipt, DebuggenError> {
    const root = normalizeRoot(projectRoot);
    if (root === undefined) {
      return failure('PROJECT_NOT_FOUND', 'A project root must be an absolute path.', 'editor');
    }
    if (!learnFromFrame(message, message.sessionId) || !frameSessionWithin(message, root)) {
      return failure('UNAUTHORIZED', 'The frame names a session of another project.', 'editor');
    }
    const recipients = editorEntries(root);
    if (recipients.length === 0) {
      return failure(
        'TRANSPORT_DISCONNECTED',
        'No VS Code window with this project is connected.',
        'editor',
        'Open the project in VS Code with the Debug Generator extension enabled.',
      );
    }
    return deliverOrFail(recipients, message, 'editor');
  }

  /* ---- bindings ---- */

  function bindTab(input: BindTabInput): Result<BindTabOutcome, DebuggenError> {
    if (closed) {
      return failure('TRANSPORT_DISCONNECTED', 'The client registry is closed.', 'registry');
    }
    const { tabId, sessionId, url, principal } = input;
    if (!isValidTabId(tabId)) {
      return failure('PROTOCOL_INVALID_MESSAGE', 'The tab id is not a Chrome tab id.', 'bound-tab');
    }
    if (!isValidRoutingId(sessionId)) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'A session id must be a non-empty id.',
        'bound-tab',
      );
    }
    if (url.length === 0 || url.length > MAX_BINDING_URL_LENGTH) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'The bound document URL is empty or too long.',
        'bound-tab',
      );
    }
    if (principal.role !== KIND_DEVTOOLS) {
      return failure('UNAUTHORIZED', 'Only a DevTools credential binds a tab.', 'bound-tab');
    }
    let preferredId: string | undefined;
    if (input.clientId !== undefined) {
      const sender = clients.get(input.clientId);
      if (
        sender === undefined ||
        sender.kind !== KIND_DEVTOOLS ||
        sender.principal.tokenHash !== principal.tokenHash
      ) {
        return failure(
          'UNAUTHORIZED',
          'The binding connection does not hold the binding credential.',
          'bound-tab',
        );
      }
      preferredId = sender.id;
    }
    const now = input.boundAt ?? clock();
    // A bound tab awaits nothing: its session reached it.
    awaitingByTab.delete(tabId);

    const current = bindingsByTab.get(tabId);
    if (
      current !== undefined &&
      current.sessionId === sessionId &&
      current.boundBy === principal.tokenHash
    ) {
      // A re-announcement (for example after a service-worker reconnect): keep
      // the binding, refresh its URL and carrier, displace nothing.
      current.url = url;
      if (preferredId !== undefined) {
        current.recipientId = preferredId;
      }
      return ok(
        Object.freeze({ binding: bindingView(current), reason: REASON_BOUND, displaced: [] }),
      );
    }

    const displaced: BindingChange[] = [];
    if (current !== undefined) {
      displaced.push(Object.freeze({ binding: bindingView(current), reason: REASON_REPLACED }));
      releaseBinding(current, now);
    }
    const previousOfSession = bindingOfSession(sessionId);
    if (previousOfSession !== undefined) {
      displaced.push(
        Object.freeze({ binding: bindingView(previousOfSession), reason: REASON_REPLACED }),
      );
      releaseBinding(previousOfSession, now);
    }

    const binding: BindingEntry = {
      tabId,
      sessionId,
      url,
      boundBy: principal.tokenHash,
      boundAt: now,
      recipientId: preferredId,
    };
    setBinding(binding);
    log.info('Tab bound to session', {
      [LOG_BINDING_KEYS.sessionId]: sessionId,
      tabId,
      displaced: displaced.length,
    });
    return ok(
      Object.freeze({
        binding: bindingView(binding),
        reason: REASON_BOUND,
        displaced: Object.freeze(displaced),
      }),
    );
  }

  /** Whether `principal` may change a binding: any non-DevTools caller, or the DevTools credential that made it. */
  function mayChangeBinding(binding: BindingEntry, principal: Principal | undefined): boolean {
    return (
      principal === undefined ||
      principal.role !== KIND_DEVTOOLS ||
      principal.tokenHash === binding.boundBy
    );
  }

  function updateTabUrl(input: UpdateTabUrlInput): Result<BindingChange, DebuggenError> {
    const binding = bindingsByTab.get(input.tabId);
    if (binding === undefined || !mayChangeBinding(binding, input.principal)) {
      return failure('TAB_NOT_BOUND', 'The tab is not bound to a session.', 'bound-tab');
    }
    if (input.url.length === 0 || input.url.length > MAX_BINDING_URL_LENGTH) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'The navigated URL is empty or too long.',
        'bound-tab',
      );
    }
    binding.url = input.url;
    log.debug('Bound tab navigated within its origin; binding kept', {
      [LOG_BINDING_KEYS.sessionId]: binding.sessionId,
      tabId: binding.tabId,
    });
    return ok(Object.freeze({ binding: bindingView(binding), reason: REASON_NAVIGATED }));
  }

  function unbindTab(
    tabId: number,
    options: UnbindTabOptions = {},
  ): Result<BindingChange | undefined, DebuggenError> {
    const reason = options.reason ?? REASON_UNBOUND;
    if (!DROP_REASONS.has(reason)) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'That binding reason does not end a binding.',
        'bound-tab',
      );
    }
    const binding = bindingsByTab.get(tabId);
    if (binding === undefined) {
      return ok(undefined);
    }
    if (!mayChangeBinding(binding, options.principal)) {
      return failure('TAB_NOT_BOUND', 'The tab is not bound by this credential.', 'bound-tab');
    }
    const change: BindingChange = Object.freeze({ binding: bindingView(binding), reason });
    releaseBinding(binding, clock());
    log.info('Tab unbound from session', {
      [LOG_BINDING_KEYS.sessionId]: binding.sessionId,
      tabId,
      reason,
    });
    return ok(change);
  }

  /* ---- tabs awaiting a session ---- */

  function awaitSession(input: AwaitSessionInput): Result<void, DebuggenError> {
    if (closed) {
      return failure('TRANSPORT_DISCONNECTED', 'The client registry is closed.', 'registry');
    }
    const { tabId, origin, principal } = input;
    if (!isValidTabId(tabId)) {
      return failure('PROTOCOL_INVALID_MESSAGE', 'The tab id is not a Chrome tab id.', 'client');
    }
    if (httpOriginOf(origin) !== origin) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'An awaited origin must be a serialized HTTP(S) origin.',
        'client',
      );
    }
    if (principal.role !== KIND_DEVTOOLS) {
      return failure('UNAUTHORIZED', 'Only a DevTools credential announces a tab.', 'client');
    }
    let recipientId: string | undefined;
    if (input.clientId !== undefined) {
      const sender = clients.get(input.clientId);
      if (
        sender === undefined ||
        sender.kind !== KIND_DEVTOOLS ||
        sender.principal.tokenHash !== principal.tokenHash
      ) {
        return failure(
          'UNAUTHORIZED',
          'The announcing connection does not hold the announcing credential.',
          'client',
        );
      }
      recipientId = sender.id;
    }
    // Re-inserted, so the map's insertion order stays oldest-record-first.
    awaitingByTab.delete(tabId);
    while (awaitingByTab.size >= MAX_AWAITING_TABS) {
      const oldest = awaitingByTab.keys().next();
      if (oldest.done === true) {
        break;
      }
      awaitingByTab.delete(oldest.value);
      log.debug('Evicted the oldest tab awaiting a session to stay within the bound', {
        tabId: oldest.value,
        limit: MAX_AWAITING_TABS,
      });
    }
    awaitingByTab.set(tabId, {
      tabId,
      origin,
      awaitedBy: principal.tokenHash,
      recipientId,
    });
    log.debug('Tab awaits a session for its origin', { tabId, awaiting: awaitingByTab.size });
    return ok(undefined);
  }

  function forgetAwaitingTab(tabId: number, principal?: Principal): boolean {
    const awaiting = awaitingByTab.get(tabId);
    if (
      awaiting === undefined ||
      (principal !== undefined &&
        principal.role === KIND_DEVTOOLS &&
        principal.tokenHash !== awaiting.awaitedBy)
    ) {
      return false;
    }
    awaitingByTab.delete(tabId);
    log.debug('Tab no longer awaits a session', { tabId });
    return true;
  }

  function offerSessionToAwaitingTab(
    tabId: number,
    message: ProtocolMessage,
  ): Result<DeliveryReceipt, DebuggenError> {
    if (closed) {
      return failure('TRANSPORT_DISCONNECTED', 'The client registry is closed.', 'registry');
    }
    if (message.type !== SESSION_CREATED_TYPE) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'Only a session creation may be offered to a tab awaiting a session.',
        'client',
      );
    }
    const awaiting = awaitingByTab.get(tabId);
    if (awaiting === undefined) {
      return failure('TAB_NOT_BOUND', 'The tab awaits no session.', 'client');
    }
    const record = embeddedSessionRecord(message);
    if (record === undefined || httpOriginOf(record.devServerUrl) !== awaiting.origin) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'The offered session does not serve the origin the tab awaits.',
        'client',
      );
    }
    if (!learnFromFrame(message, message.sessionId)) {
      return failure(
        'PROTOCOL_INVALID_MESSAGE',
        'The frame contradicts its own routing key.',
        'client',
      );
    }
    const relay = relayForCredential(awaiting.awaitedBy, awaiting.recipientId);
    if (relay === undefined) {
      recordDrop(undefined);
      return failure(
        'TRANSPORT_DISCONNECTED',
        'No connection of the credential that announced the tab is online.',
        'client',
        'The worker announces the tab again when its socket reopens.',
      );
    }
    awaiting.recipientId = relay.id;
    log.debug('An open session was offered to a tab awaiting its origin', {
      [LOG_BINDING_KEYS.sessionId]: record.id,
      tabId,
    });
    return deliverOrFail([relay], message, 'client');
  }

  /* ---- liveness ---- */

  function markOffline(clientId: string, now: number = clock()): boolean {
    const entry = clients.get(clientId);
    if (entry === undefined) {
      return false;
    }
    setOffline(entry, now);
    return true;
  }

  function markOnline(clientId: string, now: number = clock()): boolean {
    const entry = clients.get(clientId);
    if (entry === undefined) {
      return false;
    }
    setOnline(entry, now);
    return true;
  }

  function touch(clientId: string, now: number = clock()): boolean {
    const entry = clients.get(clientId);
    if (entry === undefined) {
      return false;
    }
    if (entry.online || socketIsOpen(entry.socket)) {
      setOnline(entry, now);
    } else {
      entry.lastSeenAt = now;
    }
    return true;
  }

  function sweep(now: number = clock()): number {
    pruneReleased(now);
    let removed = 0;
    for (const entry of [...clients.values()]) {
      if (credentialExpired(entry, now)) {
        log.info('Closed a connection whose credential expired', clientFields(entry));
        closeAndRemove(entry, WS_CLOSE_UNAUTHORIZED, EXPIRED_CLOSE_REASON);
        removed += 1;
      } else if (
        !entry.online &&
        entry.offlineSince !== undefined &&
        now - entry.offlineSince >= offlineGraceMs
      ) {
        log.debug(
          'Removed a connection that stayed offline past the grace period',
          clientFields(entry),
        );
        closeAndRemove(entry, WS_CLOSE_GOING_AWAY, SWEPT_CLOSE_REASON);
        removed += 1;
      }
    }
    return removed;
  }

  function stats(): ClientRegistryStats {
    const byKindCounts = Object.fromEntries(
      CLIENT_KINDS.map((kind) => [kind, idsOfKind(kind).size]),
    ) as Record<ClientKind, number>;
    let online = 0;
    for (const entry of clients.values()) {
      if (entry.online) {
        online += 1;
      }
    }
    return Object.freeze({
      clients: clients.size,
      online,
      byKind: Object.freeze(byKindCounts),
      bindings: bindingsByTab.size,
      trackedSessions: sessionProjects.size,
      delivered: totalDelivered,
      dropped: totalDropped,
    });
  }

  /* ---- shutdown and revocation ---- */

  function closeEntries(entries: readonly ClientEntry[], code: number, reason: string): number {
    let count = 0;
    for (const entry of entries) {
      if (closeAndRemove(entry, code, reason)) {
        count += 1;
      }
    }
    return count;
  }

  function closeWhere(filter: ClientFilter, code: number, reason = SHUTDOWN_CLOSE_REASON): number {
    const count = closeEntries(entriesMatching(filter), code, reason);
    if (count > 0) {
      log.info('Closed connections by filter', { closed: count, code });
    }
    return count;
  }

  function stopSweeper(): void {
    if (sweepTimer !== undefined) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
  }

  function closeAll(code: number = WS_CLOSE_GOING_AWAY, reason = SHUTDOWN_CLOSE_REASON): number {
    stopSweeper();
    const count = closeEntries([...clients.values()], code, reason);
    closed = true;
    clients.clear();
    bySocket.clear();
    for (const ids of byKind.values()) {
      ids.clear();
    }
    byProject.clear();
    byTab.clear();
    bySession.clear();
    byCredential.clear();
    bindingsByTab.clear();
    tabBySession.clear();
    sessionProjects.clear();
    released.clear();
    awaitingByTab.clear();
    if (count > 0) {
      log.info('Closed every client connection', { closed: count, code });
    }
    return count;
  }

  function revokeAll(code: number, reason = REVOKED_CLOSE_REASON): number {
    const count = closeEntries([...clients.values()], code, reason);
    // Every credential that made a binding has just been revoked, so no binding
    // can route again; the re-paired extension re-binds with its new credential.
    bindingsByTab.clear();
    tabBySession.clear();
    released.clear();
    awaitingByTab.clear();
    log.info('Revoked every client connection', { closed: count, code });
    return count;
  }

  if (sweepIntervalMs > 0) {
    sweepTimer = setInterval(() => {
      sweep();
    }, sweepIntervalMs);
    sweepTimer.unref();
  }

  return {
    register,
    unregister,
    get: (clientId) => {
      const entry = clients.get(clientId);
      return entry === undefined ? undefined : snapshot(entry);
    },
    findBySocket: (socket) => {
      const id = bySocket.get(socket);
      const entry = id === undefined ? undefined : clients.get(id);
      return entry === undefined ? undefined : snapshot(entry);
    },
    list: (filter) => entriesMatching(filter).map(snapshot),
    attachSession,
    detachSession,
    trackSession,
    projectForSession: (sessionId) => sessionProjects.get(sessionId),
    forgetSession,
    broadcast: (sessionId, message) => fanOut(sessionId, CLIENT_KINDS, message),
    broadcastToKinds: (sessionId, kinds, message) => fanOut(sessionId, kinds, message),
    sendToClient,
    agentClientForSession: (sessionId) => {
      const relay = boundRelay(sessionId);
      return relay.ok ? ok(snapshot(relay.value)) : relay;
    },
    sendToBoundTab,
    serverAgentForProject: (projectRoot) => {
      const root = normalizeRoot(projectRoot);
      const agents = root === undefined ? [] : serverAgentEntries(root);
      const latest = agents.reduce<ClientEntry | undefined>(
        (best, entry) =>
          best === undefined || entry.connectedAt >= best.connectedAt ? entry : best,
        undefined,
      );
      return latest === undefined
        ? failure(
            'SERVER_AGENT_NOT_READY',
            'No dev-server agent is connected for this project.',
            'server-agent',
            'Launch the dev server from Debug Generator so its Node preload can connect, then try again.',
          )
        : ok(snapshot(latest));
    },
    serverAgentsForProject: (projectRoot) => {
      const root = normalizeRoot(projectRoot);
      return root === undefined ? [] : serverAgentEntries(root).map(snapshot);
    },
    sendToServerAgent,
    editorClientsForProject: (projectRoot) => {
      const root = normalizeRoot(projectRoot);
      return root === undefined ? [] : editorEntries(root).map(snapshot);
    },
    sendToEditors,
    bindTab,
    updateTabUrl,
    unbindTab,
    bindingForTab: (tabId) => {
      const binding = bindingsByTab.get(tabId);
      return binding === undefined ? undefined : bindingView(binding);
    },
    bindingForSession: (sessionId) => {
      const binding = bindingOfSession(sessionId);
      return binding === undefined ? undefined : bindingView(binding);
    },
    awaitSession,
    forgetAwaitingTab,
    awaitedOriginForTab: (tabId) => awaitingByTab.get(tabId)?.origin,
    offerSessionToAwaitingTab,
    markOffline,
    markOnline,
    touch,
    sweep,
    stats,
    closeWhere,
    closeAll,
    revokeAll,
  } satisfies ClientRegistry & SessionBroadcastPort & ConnectionRevoker;
}
