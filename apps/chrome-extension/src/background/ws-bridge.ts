/**
 * The service worker's one connection to the local service: the only module in
 * the Chrome extension that opens a socket or performs HTTP.
 *
 * ## What this module is
 *
 * The DevTools panel, the isolated-world content bridge and the devtools page
 * never hold a transport (AAP §0.1.2, §0.4.2). They reach the local service
 * through runtime ports, `ports.ts` routes those ports, and every frame and
 * request that has to leave the browser ends here, in {@link createWsBridge}:
 *
 * - **one** `ReconnectingWsClient` from `@debuggen/protocol`, announcing itself
 *   as the `devtools` client with the paired credential in its `client.hello`
 *   first frame — and no tab, because the connection speaks for every
 *   inspected tab — reconnecting on the AAP §0.5.5 curve (0.5 s → 10 s), and
 *   never retrying a credential the service refused with
 *   `WS_CLOSE_UNAUTHORIZED`;
 * - the worker-lifetime half of recovery, which the platform-neutral client
 *   deliberately leaves to this module: while the socket is open, a heartbeat
 *   every {@link SOCKET_HEARTBEAT_INTERVAL_MS} re-creates the `chrome.alarms`
 *   keepalive — an extension API call, which refreshes the worker's idle timer
 *   while it is active — and sends `client.ping` on the socket itself, retiring
 *   the socket onto the backoff curve when no `service.pong` answers it within
 *   `SERVICE_PONG_TIMEOUT_MS` (or, for a ping still queued behind the socket's
 *   own draining outbound backlog, within {@link HEARTBEAT_MAX_PONG_WINDOWS}
 *   such windows) and the auth-exempt health route does not answer either — a
 *   service that answers is alive and reading this socket under backpressure,
 *   so the socket is kept for up to
 *   {@link HEARTBEAT_MAX_UNANSWERED_WHILE_ALIVE} such ticks in a row without
 *   proof that it is still read (a backlog that keeps draining, or a late
 *   answer to one of its earlier pings, is that proof). The
 *   alarm does not prevent Manifest V3
 *   suspension: once the worker is suspended it fires within one period, and
 *   its tick revives the worker and reconnects
 *   ({@link WsBridge.handleKeepaliveAlarm});
 * - the envelope wrap of the page agent's **raw** event batches: the MAIN-world
 *   agent has no socket and never imports the protocol, so the worker turns its
 *   `{ events }` into `telemetry.event` frames, chunked to the protocol's bound
 *   and in the order they were produced, each scoped to its tab and that tab's
 *   session — a batch whose session is unknown is refused, never sent
 *   unscoped — each carrying the capture the agent was armed for and the
 *   first carrying its reported loss ({@link TelemetryBatchContext}); an
 *   event-less batch that reports loss becomes one loss-only frame, so a
 *   capture's final loss reaches the service when no later batch will carry
 *   it;
 * - the **service-confirmed route** of each tab: which tab ↔ session pairs the
 *   service has answered with `session.bound` on the *current* connection.
 *   Telemetry is written only along a confirmed route and only to an open
 *   socket — never handed to the socket client's volatile queue, which is
 *   flushed right after the next hello and therefore *before* the re-announced
 *   `session.bind`, where a restarted service (whose binding table starts
 *   empty) would refuse every queued batch. {@link WsBridge.awaitTabRoute} is
 *   how the worker's telemetry lane waits for that confirmation;
 * - the **flow control** of that telemetry: a bounded window of events
 *   written and not yet acknowledged, acknowledged by barrier `client.ping`s
 *   the service answers in frame order, so no burst the page produces can
 *   queue more work at the service than it stores in about a second — the
 *   work every later frame of the connection, the heartbeat's ping included,
 *   waits behind. {@link WsBridge.awaitTelemetryCapacity} is how the lane
 *   waits for room (see "Telemetry flow control" in {@link createWsBridge});
 * - the relay of `agent.ready` under this connection, with the `tabId` the page
 *   cannot know filled in and named as the frame's acting tab;
 * - the re-announcement of every persisted tab binding after a reconnect, since
 *   the service records bindings against a connection and a new socket starts
 *   with none (AAP §0.5.6);
 * - the fan-out of inbound frames — relayed ones to the panels of the tab they
 *   concern, every one to the typed subscribers `service-worker.ts` registers;
 * - the typed, `Result`-returning HTTP operations the panel's controls and its
 *   `DataProvider` reach "via SW" (AAP §0.4.2, §0.7.1 Group 4).
 *
 * ## Every recovery state is something the panel is told
 *
 * AAP §0.5.5 enumerates what happens when Chrome and the service lose each
 * other. Each of those conditions is a {@link WorkerStatusSnapshot} pushed
 * through the injected sink, with its label owned by `../shared/messages`
 * (`panelConnectionStatus`, `PANEL_CONNECTION_LABELS`), never authored here:
 *
 * | Condition | How it is detected | Pill |
 * | --- | --- | --- |
 * | socket open and authenticated | client state `open` | "Connected" |
 * | socket dropped, service answering | client state `reconnecting`, `GET /health` ok | "Reconnecting…" + `retryInMs` |
 * | service not answering | `GET /health` fails | "Service not running" + start-command `hint` |
 * | service URL refused by the loopback policy, or by the extension's own rule | `resolveWsUrl` / {@link WsBridge.setServiceBaseUrl} / `configurationError` | "Service not running" + configuration `hint` |
 * | no credential, or credential refused (4401) | credential probe, `onUnauthorized` | "Not paired" |
 * | outbound queue overflowed | `onQueueDrop` | `droppedFrameCount` on every snapshot |
 *
 * Telemetry the socket client took and then discarded — a queued
 * `telemetry.event` frame dropped from the head of the full queue, or still
 * queued when the credential was removed — is also reported, twice over: by
 * tab and event count through {@link WsBridgeDeps.onTelemetryDropped}, which
 * `service-worker.ts` shows on the tab's panels as undelivered telemetry, and
 * — every such frame, a loss-only one included — with its session, armed
 * capture, event count and carried `droppedCount` through
 * {@link WsBridgeDeps.onTelemetryFrameDiscarded}, which the worker holds as
 * loss the service's producer-loss ledger has not yet been told of. The
 * accounting that names such a frame is the queue mirror documented in
 * {@link createWsBridge}.
 *
 * Both protocol clients return a `Result` and never throw for an expected
 * condition, and this module keeps that discipline: no exported function
 * throws, no returned promise rejects, and every failure is either a `Result`
 * or a rendered state.
 *
 * ## Invariants
 *
 * - **No import-time side effect, no module-level mutable state.** Every
 *   top-level statement is a declaration; all state lives in the factory's
 *   closure, and the factory itself neither connects nor schedules anything.
 *   `service-worker.ts` calls {@link WsBridge.connect}, registers
 *   `chrome.alarms.onAlarm` and forwards to {@link WsBridge.handleKeepaliveAlarm}.
 *   `apps/chrome-extension/test/ws-bridge.test.ts` therefore drives this
 *   module with a fake `WebSocket` constructor, a fake `HttpClient`, a fake
 *   alarms API and controllable timers.
 * - **One socket, and every tab-scoped frame and request names its tab.** One
 *   connection and one paired credential serve every inspected tab, so no tab
 *   is "the connection's": `client.hello` announces none, and the credential
 *   alone cannot tell the service which tab's session it may touch
 *   (AAP §0.5.6). Per-tab attribution therefore travels as the **acting tab**
 *   on everything sent for a tab — the envelope's `tabId` on a frame
 *   (`telemetry.event`, `agent.ready`, the re-announced `session.bind`, and
 *   what `service-worker.ts` sends through {@link WsBridge.send}), and the
 *   `x-debuggen-tab` header (`ACTING_TAB_HEADER`) on every session-scoped HTTP
 *   request, whose options type ({@link TabScopedCallOptions}) makes the tab
 *   required. The service verifies the claim against its live tab ↔ session
 *   binding; the tab comes from Chrome's port metadata, never from a page. No
 *   second socket is ever opened for a second tab, and no raw `WebSocket` is
 *   constructed here: the injected constructor builds every socket, and the
 *   bridge only observes the one it built last (see {@link observeSockets}).
 * - **No sibling behaviour imports.** Only `./messages` (contracts) and
 *   `./auth` (types) are imported from this folder; `./tab-registry`,
 *   `./agent-control`, `./ports` and `./service-worker` are reached through
 *   injected functions or not at all, which keeps the folder acyclic.
 * - **Nothing secret reaches a log, an error or a snapshot.** No credential,
 *   pairing code, `Authorization` value, URL query string, event attribute or
 *   response body is written anywhere: logs carry message types, counts, tab
 *   ids, session ids, error codes and state names only. A page-supplied id —
 *   `agent.ready`'s `documentId` — is logged only as its `fingerprintPageId`
 *   digest and whether it has the canonical shape, never by value. The
 *   credential is handed by reference to the two protocol clients and never
 *   read here.
 * - **No redaction and no re-timing here.** Redaction is the agent's and the
 *   service's (AAP §0.5.2); `seq`, `producerId`, `startTime` and `duration` are
 *   the correlator's inputs and are forwarded untouched, and `sessionId`,
 *   `captureId` and `ingestSeq` are assigned by the service at ingest.
 *
 * Governed by AAP §0.4.2 (the message table: `client.hello`, `telemetry.event`,
 * `agent.ready`, `POST /sessions/:id/panel-data` "via SW"), §0.5.5 ("Chrome
 * disconnects"), §0.5.6 (bearer credential, hello within
 * `CLIENT_HELLO_TIMEOUT_MS` or close 4401, devtools role scoped to the bound
 * tab), §0.7.1 Group 4 and §0.8.1 slices 4 and 6.
 *
 * @example
 * ```ts
 * // service-worker.ts — the only wiring point.
 * const httpClient = new HttpClient({ baseUrl, token: () => store.getToken() });
 * const bridge = createWsBridge({
 *   webSocketConstructor: WebSocket,
 *   httpClient,
 *   tokenProvider: store.getToken,
 *   readProofProvider: store.getReadProof,
 *   onUnauthorized: store.handleUnauthorized,
 *   hasCredential: store.hasToken,
 *   alarms: chrome.alarms,
 *   timers: {
 *     setTimeout: (run, ms) => self.setTimeout(run, ms),
 *     clearTimeout: (handle) => self.clearTimeout(handle),
 *   },
 *   relayPush: (message, tabId) => hub.relayProtocolMessage(message, tabId),
 *   pushStatus: (snapshot) => hub.broadcastStatus(snapshot),
 *   listBindings: () => registry.list(),
 *   serviceBaseUrl: baseUrl,
 *   logger,
 * });
 * store.onStateChange(bridge.handlePairingState);
 * chrome.alarms.onAlarm.addListener((alarm) => void bridge.handleKeepaliveAlarm(alarm));
 * bridge.subscribe(MESSAGE_TYPE.AGENT_CONFIG, (message) => {
 *   void agents.applyConfig(message.payload);
 * });
 * void bridge.connect();
 *
 * // The telemetry lane: wait for the service to confirm the tab's route and
 * // for room in the window, then send — with nothing awaited in between.
 * const route = await bridge.awaitTabRoute(tabId, sessionId, { signal: deadline });
 * const room = route.ok
 *   ? await bridge.awaitTelemetryCapacity(tabId, events.length, { signal: deadline })
 *   : route;
 * if (room.ok) bridge.sendTelemetryBatch(tabId, events, sessionId);
 * ```
 *
 * @module apps/chrome-extension/src/background/ws-bridge
 */

import type {
  AgentReadyPayload,
  BindingReason,
  CaptureStartResponse,
  CaptureStopResponse,
  ClientKind,
  ConnectionState,
  CreateEnvelopeOptions,
  DataResult,
  HealthResponse,
  HttpCallOptions,
  HttpClient,
  HttpOperation,
  MessagePayload,
  MessageType,
  ModificationsResponse,
  PanelByIdResponse,
  PanelDataRequest,
  PanelResponse,
  ProtocolMessage,
  SendOutcome,
  SessionBindPayload,
  SessionBoundPayload,
  SessionRecord,
  TelemetryEventIngress,
  TokenProvider,
  WebSocketConstructorLike,
  WebSocketLike,
  WsClientIdentity,
  WsEventMapLike,
  WsQueueDropDetail,
  WsStateChangeDetail,
  WsUnauthorizedDetail,
} from '@debuggen/protocol';
import {
  CAPTURE_CONFLICT_ERROR_CODE,
  CLIENT_HELLO_TIMEOUT_MS,
  CLIENT_KINDS,
  DEFAULT_WS_BACKOFF,
  isPlainRecord,
  MESSAGE_TYPE,
  parseServiceOrigin,
  ReconnectingWsClient,
  resolveWsUrl,
  SERVICE_PONG_TIMEOUT_MS,
  telemetryEventPayloadSchema,
  WS_CLOSE_UNAUTHORIZED,
} from '@debuggen/protocol';
import type {
  CaptureId,
  DebuggenErrorCode,
  LogFields,
  Logger,
  MessageId,
  Result,
  SessionId,
} from '@debuggen/shared';
import {
  assertNever,
  DebuggenError,
  err,
  isErr,
  newMessageId,
  noopLogger,
  ok,
} from '@debuggen/shared';

import type {
  PageAgentReadyPayload,
  PanelConnectionStatus,
  RelayedProtocolMessage,
} from '../shared/messages';
import {
  DEFAULT_SERVICE_BASE_URL,
  fingerprintPageId,
  isPageDocumentId,
  panelConnectionStatus,
} from '../shared/messages';
import type {
  DevtoolsCredentialStore,
  PairingState,
  UnauthorizedEvidence,
  UnauthorizedHandling,
} from './auth';
import type {
  ProtocolSend,
  ProtocolSubscribe,
  RelayPush,
  TabBindingRecord,
  WorkerAlarmsApi,
  WorkerStatusSink,
  WorkerStatusSnapshot,
  WorkerTimerApi,
} from './messages';
import {
  isRelayedMessage,
  KEEPALIVE_ALARM_NAME,
  KEEPALIVE_PERIOD_MINUTES,
  workerError,
} from './messages';

/*
 * ===========================================================================
 * Section A — derived primitives and constants
 *
 * Every value here is either derived from its owner's declaration or is a
 * sentence this module writes for a developer. No transport number (the close
 * code, the hello window, the backoff curve, the batch bound) is spelled as a
 * literal: each is imported, or read off the schema that enforces it.
 * ===========================================================================
 */

/** A Chrome tab id, exactly as the protocol's binding payloads type it. */
type TabId = SessionBindPayload['tabId'];

/**
 * The one client kind this connection may announce, typed as the `devtools`
 * member of the protocol's `ClientKind` union.
 */
type DevtoolsClientKind = Extract<ClientKind, 'devtools'>;

/**
 * The `devtools` member of the imported `CLIENT_KINDS` tuple.
 *
 * Read by index from the protocol's own vocabulary rather than written as a
 * string, and pinned by the annotation: if the tuple is ever reordered the
 * element at this index stops being assignable to {@link DevtoolsClientKind}
 * and `tsc -b` fails here, instead of this worker announcing itself as some
 * other kind of client.
 */
const DEVTOOLS_CLIENT_KIND: DevtoolsClientKind = CLIENT_KINDS[1];

/**
 * The close code a client sends when it ends a connection itself: `1000`,
 * WebSocket "normal closure" — the value `ReconnectingWsClient.close` applies
 * when none is given, named here so the one deliberate close in this module
 * reads as what it is.
 */
const NORMAL_CLOSURE_CODE = 1000;

/**
 * The close reason sent when the stored credential disappears while a socket
 * is open. It reaches only the service's log, and names no value.
 */
const CREDENTIAL_REMOVED_REASON = 'the devtools credential was removed';

/**
 * The close reason sent by {@link WsBridge.close}. Constant; names no value.
 */
const BRIDGE_CLOSED_REASON = 'the service worker bridge was disposed';

/**
 * How often the heartbeat runs while the socket is open: every twenty seconds.
 *
 * Below the roughly thirty-second idle window after which Chrome suspends a
 * Manifest V3 service worker (AAP §0.1.1, §0.5.5), with room to spare for the
 * `SERVICE_PONG_TIMEOUT_MS` answer each tick waits on. Each tick is a
 * `chrome.alarms` call — an extension API call, which resets the worker's idle
 * timer — so an open connection keeps its worker alive without depending on
 * the platform's socket-activity heuristics, and the tick's `client.ping` is
 * what notices a connection whose peer vanished without a close frame.
 *
 * The ping travels on the socket it tests. The service's own WebSocket pings
 * are control frames a worker's script never sees, and `GET /health` proves
 * only that the service's HTTP listener answers, not that this socket still
 * carries frames; `client.ping` is authenticated, touches no session, and is
 * answered by exactly one `service.pong` to this connection, whose `ref` is
 * the ping's id. One unanswered ping, confirmed by a health route that does
 * not answer either, retires the socket, so a dead peer is detected at most
 * one interval plus one pong window and one health probe of at most
 * {@link HEARTBEAT_HEALTH_TIMEOUT_MS} — about thirty-five seconds for a frozen
 * service, sooner for a closed port — after the last answered ping. Two
 * exceptions keep a live
 * connection: a ping still queued behind this socket's own outbound backlog
 * while that backlog drains is granted further windows up to
 * {@link HEARTBEAT_MAX_PONG_WINDOWS}, and an unanswered ping while the health
 * route answers keeps the socket for up to
 * {@link HEARTBEAT_MAX_UNANSWERED_WHILE_ALIVE} ticks in a row without proof
 * that the service still reads it.
 */
export const SOCKET_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * The most pong windows — `SERVICE_PONG_TIMEOUT_MS` each — one heartbeat ping
 * may wait before its socket is retired: four, twenty seconds in all, as long
 * as a heartbeat interval.
 *
 * A window is extended only while the ping is still queued behind bytes this
 * bridge wrote to the socket before it, and only when that outbound buffer
 * drained during the window that just elapsed (a platform socket's
 * `bufferedAmount`, net of what the bridge wrote meanwhile): the service is
 * reading this socket, and the ping simply has not reached it yet — the case
 * of a worker flushing the telemetry it held while the service was stalled.
 * Retiring that socket would only leave a second one queued behind the same
 * backlog, and its close frame behind the first's. A ping written to an empty
 * buffer, one behind a buffer that stopped draining, and one on a socket that
 * reports no `bufferedAmount` still retire after one window, exactly as
 * before; this bound caps the wait of a peer that consumes too slowly to be
 * useful.
 */
export const HEARTBEAT_MAX_PONG_WINDOWS = 4;

/**
 * How many heartbeat ticks in a row may end with an unanswered ping while the
 * service's auth-exempt `GET /health` still answers, before the socket is
 * retired anyway: two.
 *
 * An unanswered `client.ping` alone does not tell a vanished peer from a busy
 * one. A service applying read backpressure to this connection (it pauses
 * reading a socket whose frame backlog is deep, so the ping waits in the
 * kernel buffers until the backlog drains) looks exactly like a stopped one
 * from inside the socket. So before a tick retires its socket it asks the
 * health route: a service that does not answer is gone and the socket is
 * retired at once, exactly as before; a service that answers is alive, and
 * retiring its socket would only abandon a connection that is still being
 * read — leaving its buffered telemetry and its close frame queued behind
 * each other — and open a second one behind the same load. The socket is
 * kept and the next tick pings again. This bound is what keeps a socket the
 * service has somehow stopped reading for good from being kept forever: the
 * third unanswered tick in a row without proof of reading retires it whatever
 * the health route says.
 *
 * Two observations prove the service is still reading this socket, and start
 * the count again just as an answered ping does:
 *
 * - **Its backlog keeps draining.** The socket's outbound buffer held bytes
 *   when the span began (the previous kept tick, or the ping's write), still
 *   holds bytes now, and less than was written meanwhile
 *   ({@link sendBufferReadProgress}). A buffer that stays non-empty means the
 *   network is taking bytes only as fast as the service reads them, so the
 *   drain is the service's reading, not kernel slack: the service is working
 *   through this connection's backlog and simply has not reached the ping. A
 *   worker whose capture outpaces the service's ingest lives here for as long
 *   as the overload lasts; retiring its socket would only leave the old one
 *   draining beside a new one queued behind the same load.
 * - **A late answer.** A `service.pong` (or the refusal of a service that
 *   predates the liveness pair) naming one of the last
 *   {@link HEARTBEAT_LATE_ANSWER_MEMORY} pings this connection kept
 *   unanswered: the service read the socket at least that far.
 *
 * A socket whose buffer is empty, unreadable or stalled gets no such credit,
 * so a vanished or wedged peer is still retired within this bound.
 */
export const HEARTBEAT_MAX_UNANSWERED_WHILE_ALIVE = 2;

/**
 * How many of the latest pings a connection kept unanswered the heartbeat
 * remembers, so a late answer to any of them is recognised as proof that the
 * socket is read ({@link HEARTBEAT_MAX_UNANSWERED_WHILE_ALIVE}): eight — more
 * than two minutes of ticks. Older ids are forgotten; their answers are then
 * ignored like any other pong naming no ping of this connection.
 */
export const HEARTBEAT_LATE_ANSWER_MEMORY = 8;

/**
 * How long the heartbeat waits for `GET /health` when it asks whether an
 * unanswered ping means the service is gone: ten seconds, the backoff cap.
 *
 * The pill's own probe gives up after `CLIENT_HELLO_TIMEOUT_MS` (three
 * seconds), which is right for "can a socket authenticate now?", but this
 * question is "is the service still there at all?" — and a service busy
 * enough to leave a ping unread (its event loop held for a second at a time
 * by a deep ingest backlog) can take longer than three seconds to answer its
 * cheapest route. Mistaking that for a stopped service retires a socket it is
 * reading and opens a second one behind the same load. A stopped or frozen
 * service answers neither within this bound, and a closed port refuses at
 * once, so a vanished peer is still retired — the wait costs a frozen one at
 * most these ten seconds more.
 */
export const HEARTBEAT_HEALTH_TIMEOUT_MS = 10_000;

/**
 * The reason a socket retired by the heartbeat is closed with, and reported
 * under on the `reconnecting` transition that follows. Constant; names no
 * value.
 */
const SERVICE_STOPPED_ANSWERING_REASON = 'the local service stopped answering';

/**
 * What the developer can do when the service does not answer: start it.
 *
 * Both documented ways of starting the local service — the VS Code command
 * `debuggen.startService` (its palette title) and the service package's own
 * `start` script — and nothing project-specific: this worker cannot know which
 * application is being debugged, and must not pretend to.
 */
const SERVICE_NOT_RUNNING_HINT =
  'Start the Debug Generator local service: run "Debug Generator: Start Local Service" from the VS Code command palette, or run `pnpm --filter @debuggen/local-service start` from the Debug Generator repository.';

/**
 * What the developer can do when the configured service URL was refused by the
 * loopback-only service-origin policy, used when the refusal carries no hint of
 * its own. It names the default address, never the refused value, and the
 * place the address is entered: the pairing dialog, whose change applies at
 * once through {@link WsBridge.setServiceBaseUrl} — no reload is needed.
 */
const SERVICE_MISCONFIGURED_HINT = `Enter the local service's loopback address in the Debug Generator panel: in the pairing dialog, or with "Change service address…" once paired (the default is ${DEFAULT_SERVICE_BASE_URL}).`;

/**
 * What the developer can do when the service address could not be
 * established at all (the gate of {@link WsBridgeDeps.serviceEndpointSettled}
 * rejected): reopening DevTools starts the extension's read again.
 */
const SERVICE_ADDRESS_UNKNOWN_HINT =
  'Close and reopen DevTools so the extension reads its service address again; it contacts no service until then.';

/**
 * The close reason sent when the configured service address is replaced by
 * one that was refused. Constant; names no value.
 */
const SERVICE_ENDPOINT_REFUSED_REASON = 'the configured service address was refused';

/**
 * Why a telemetry batch was refused when no session is known for its tab.
 * Constant: it names no tab, session or event, so it is safe in any log.
 */
const TELEMETRY_TAB_NOT_BOUND_MESSAGE =
  'A telemetry batch was not sent: its tab is not bound to a session.';

/**
 * What restores telemetry for a tab that is not bound: the DevTools panel
 * binding it to a session.
 */
const TELEMETRY_TAB_NOT_BOUND_HINT =
  'Open the Debug Generator panel in DevTools on the application tab so the tab is bound to its session.';

/**
 * Why a telemetry batch was refused while the socket cannot take a write: it
 * is connecting, reconnecting, closed or closing. Constant, like every
 * telemetry refusal: it names no tab, session or event.
 */
const TELEMETRY_NOT_CONNECTED_MESSAGE =
  'A telemetry batch was not sent: the connection to the local service is not open.';

/**
 * Why a telemetry batch was refused on an open socket: the service has not
 * confirmed, on this connection, that the batch's tab is bound to the batch's
 * session.
 */
const TELEMETRY_ROUTE_UNCONFIRMED_MESSAGE =
  "A telemetry batch was not sent: the local service has not confirmed its tab's binding on this connection.";

/**
 * Why a telemetry batch stopped part-way: the socket client took a frame into
 * its reconnect queue instead of writing it, because the socket stopped
 * accepting writes between the bridge's check and the write.
 */
const TELEMETRY_WRITE_INTERRUPTED_MESSAGE =
  'A telemetry batch was interrupted: the connection to the local service stopped accepting writes.';

/**
 * How long {@link WsBridge.awaitTabRoute} waits, by default, for the service
 * to confirm a tab's route before it gives up with `TRANSPORT_DISCONNECTED`.
 *
 * Thirty seconds covers the longest ordinary recovery: a dropped socket waits
 * at most `DEFAULT_WS_BACKOFF.maxMs` (10 s) before its next attempt, the new
 * socket authenticates inside `CLIENT_HELLO_TIMEOUT_MS`, and the persisted
 * bindings are then re-announced and answered in one round trip — with room
 * for a second backoff step while a restarting service is still coming up.
 * It is also short enough that a batch whose tab can no longer be routed is
 * reported as lost promptly instead of being held for an outage of unknown
 * length. The service worker's telemetry lane uses the same bound as each
 * batch's overall deadline, measured from the batch's arrival.
 */
export const TELEMETRY_ROUTE_WAIT_MS = 30_000;

/**
 * The WHATWG `WebSocket.OPEN` `readyState`: the one state in which a write
 * reaches the wire. A platform constant rather than a tunable — the protocol
 * client compares against the same value, and keeps its own copy private.
 */
const WEBSOCKET_OPEN_READY_STATE = 1;

/**
 * The most telemetry events the bridge keeps written to the socket and not
 * yet acknowledged by the service — the in-flight window of
 * {@link WsBridge.awaitTelemetryCapacity} (see "Telemetry flow control" in
 * {@link createWsBridge}).
 *
 * The service handles one connection's frames strictly in order, so a
 * `client.ping` written behind the window is answered only once the window
 * has been stored. At the measured service cost of about a millisecond per
 * stored event, a thousand events is about a second of work: the heartbeat's
 * ping — and every other frame — waits at most that long behind telemetry,
 * far inside `SERVICE_PONG_TIMEOUT_MS`, however fast the page produces. Five
 * of the page agent's 200-event batches.
 */
export const MAX_UNACKNOWLEDGED_TELEMETRY_EVENTS = 1_000;

/**
 * The most `telemetry.event` frames in the in-flight window, whatever their
 * size: bounds a stream of small or loss-only frames the event bound would
 * let through, and stays an eighth of the service's per-connection backlog
 * cap, so a full window never comes near it.
 */
export const MAX_UNACKNOWLEDGED_TELEMETRY_FRAMES = 32;

/**
 * How many telemetry events are written between two barrier pings: a
 * quarter of {@link MAX_UNACKNOWLEDGED_TELEMETRY_EVENTS}, so a steady stream
 * is acknowledged four times per window and never waits a whole window for
 * room.
 */
export const TELEMETRY_BARRIER_EVENTS = 250;

/** How many telemetry frames are written between two barrier pings; see {@link TELEMETRY_BARRIER_EVENTS}. */
export const TELEMETRY_BARRIER_FRAMES = 8;

/**
 * The most barrier pings outstanding at once while the service has not yet
 * answered one to this bridge ({@link TelemetryFlowStatus.paced} false).
 *
 * Barriers are written on the same cadence before the first answer as after
 * it, because every answer renews the heartbeat ping's deadline. The first
 * burst a bridge writes — the page agent's whole buffer after the worker woke
 * — goes out before any barrier can have been answered, so the window cannot
 * hold it back; without barriers inside it, a heartbeat ping written behind it
 * would wait for all of it with nothing vouching that the service is still
 * storing. The bound keeps a peer that answers no ping at all (a test double;
 * a real service that stops answering is retired by the heartbeat) to a fixed
 * number of them per connection. Sixty-four barriers cover 16 000 events, more
 * than a tab's lane and its page's buffer hold together.
 */
export const MAX_UNPACED_TELEMETRY_BARRIERS = 64;

/** A capacity wait was asked for a value that is not a Chrome tab id. */
const CAPACITY_INVALID_TAB_MESSAGE =
  'Telemetry capacity was requested for a value that is not a Chrome tab id.';

/** A capacity wait was asked for a count that is not a whole number of events. */
const CAPACITY_INVALID_COUNT_MESSAGE =
  'Telemetry capacity was requested for a count that is not a whole number of events.';

/** The capacity wait ended because its bound expired first. */
const CAPACITY_TIMED_OUT_MESSAGE =
  'The local service did not acknowledge the telemetry in flight before the wait expired.';

/** The capacity wait ended because its caller cancelled it. */
const CAPACITY_ABORTED_MESSAGE = 'The wait for room in the telemetry window was cancelled.';

/** The capacity wait ended because the bridge was disposed. */
const CAPACITY_DISPOSED_MESSAGE =
  'The service bridge was disposed while telemetry waited for room to be sent.';

/**
 * Why a tab route cannot be awaited for the arguments given. Constant; names
 * neither value.
 */
const ROUTE_INVALID_TAB_MESSAGE =
  'A tab route was requested for a value that is not a Chrome tab id.';

/** Why a tab route cannot be awaited for an empty session id. */
const ROUTE_INVALID_SESSION_MESSAGE = 'A tab route was requested with an empty session id.';

/** The route wait ended because the bounded wait expired first. */
const ROUTE_TIMED_OUT_MESSAGE =
  "The local service did not confirm the tab's binding before the wait expired.";

/** The route wait ended because its caller cancelled it. */
const ROUTE_ABORTED_MESSAGE =
  "The wait for the service to confirm the tab's binding was cancelled.";

/**
 * The route wait ended because the service confirmed the tab for another
 * session, confirmed the session for another tab, or ended the binding.
 */
const ROUTE_ENDED_MESSAGE =
  "The tab's binding ended or moved to another session before the service confirmed it.";

/** The route wait ended because the service refused the devtools credential. */
const ROUTE_UNAUTHORIZED_MESSAGE =
  'The local service refused the devtools credential, so no tab route can be confirmed.';

/** The route wait ended because the devtools credential was removed. */
const ROUTE_NO_CREDENTIAL_MESSAGE =
  'The devtools credential was removed, so no tab route can be confirmed.';

/** The route wait ended because the bridge was disposed. */
const ROUTE_DISPOSED_MESSAGE =
  'The service bridge was disposed before the tab route was confirmed.';

/** What restores a tab route the credential lost: pairing again. */
const ROUTE_PAIRING_HINT =
  'Pair the Debug Generator panel with the local service again, then reopen DevTools on the application tab.';

/**
 * The refusal codes that end a re-announced binding: the service answered a
 * `session.bind` naming a session with the statement that the session is over
 * (`SESSION_INVALID_STATE` — ended or failed, `details.reason:
 * 'session-ended'`) or no longer exists (`SESSION_NOT_FOUND`). Either is final
 * for that pair: no later connection can revive it. Every other refusal
 * (`RATE_LIMITED`, `STORE_ERROR`, `TAB_NOT_BOUND` for an origin that no longer
 * matches, …) may clear on its own, so the pair is kept and the next open
 * re-announces it.
 */
export type BindingRefusalCode = Extract<
  DebuggenErrorCode,
  'SESSION_INVALID_STATE' | 'SESSION_NOT_FOUND'
>;

/** The members of {@link BindingRefusalCode}, as the set {@link isBindingRefusalCode} reads. */
const BINDING_REFUSAL_CODES: ReadonlySet<string> = new Set<BindingRefusalCode>([
  'SESSION_INVALID_STATE',
  'SESSION_NOT_FOUND',
]);

/** Whether an `error` frame's code refuses a re-announced binding for good. */
function isBindingRefusalCode(code: string): code is BindingRefusalCode {
  return BINDING_REFUSAL_CODES.has(code);
}

/**
 * The most re-announced binds one connection remembers while it awaits their
 * answers. One open re-announces every persisted binding once, and the tab
 * registry persists at most 256, so this bound is never reached by a
 * well-formed store; it only keeps a malformed one from growing the map
 * without limit. Stated here rather than imported: this module never imports
 * its sibling `./tab-registry` (the composition root is the only module that
 * sees both), and a bound that merely matches the registry's is all it needs.
 */
const MAX_REANNOUNCED_BINDS = 256;

/**
 * The frame bound used when the protocol's schema declares none: an unbounded
 * array is accepted whole, so one frame carries the whole batch.
 */
const UNBOUNDED_FRAME_EVENTS = Number.POSITIVE_INFINITY;

/**
 * The `check` name Zod gives an array's maximum-length check — the one piece
 * of the schema's structure {@link readTelemetryFrameEventLimit} reads.
 */
const MAX_LENGTH_CHECK = 'max_length';

/** Fails to compile unless its argument is exactly `true`. */
type AssertTrue<Assertion extends true> = Assertion;

/*
 * ===========================================================================
 * Section B — the injection surface
 * ===========================================================================
 */

/**
 * Everything {@link createWsBridge} needs, injected — so the bridge runs
 * against the real `chrome.*` namespaces and platform `WebSocket` in
 * `service-worker.ts`, and against recording fakes in
 * `apps/chrome-extension/test/ws-bridge.test.ts`.
 */
export interface WsBridgeDeps {
  /**
   * The socket implementation handed to `ReconnectingWsClient`: the platform
   * `WebSocket` global in the worker, a fake in a test. This module never
   * constructs a socket itself.
   */
  readonly webSocketConstructor: WebSocketConstructorLike;

  /**
   * The worker's one {@link HttpClient}, shared with `auth.ts` so that the
   * `setToken` a pairing performs affects every request either module makes.
   *
   * The instance itself, or a thunk returning it for a composition root that
   * resolves the mutual reference (the client's `token` delegates to the
   * credential store, and the store redeems pairing codes through the client)
   * lazily. Either form is dereferenced only when a request is made, never by
   * the factory.
   */
  readonly httpClient: HttpClient | (() => HttpClient);

  /**
   * The lazy credential getter — the credential store's `getToken`. Handed to
   * `ReconnectingWsClient`, which resolves it once per connection attempt and
   * places it in the `client.hello` frame. ⚠️ Never called for its value by
   * this module except through {@link WsBridgeDeps.hasCredential}'s default.
   */
  readonly tokenProvider: TokenProvider;

  /**
   * The read proof issued with the credential at pairing — the credential
   * store's `getReadProof`. Asked once per DevTools read (`session.get`,
   * `panel.get`, `panel.getById`, `modifications.list`), whose `HttpClient`
   * call sends it as `READ_PROOF_HEADER`: the service refuses every DevTools
   * read without it, `Origin` or not, because Chrome sends no `Origin` on
   * these `GET`s and an `Origin` alone is only a claim. Omitted, or answering
   * `undefined`, a read is sent without one, and the service's `UNAUTHORIZED`
   * reaches {@link WsBridgeDeps.onUnauthorized} like any refused credential,
   * so the developer pairs again. ⚠️ As secret as the credential: never
   * logged, and never placed in the `client.hello`.
   */
  readonly readProofProvider?: (() => Promise<string | undefined>) | undefined;

  /**
   * How a refused credential is reported — the credential store's
   * `handleUnauthorized`. Called with the socket client's 4401 detail, or with
   * an HTTP failure carrying the `UNAUTHORIZED` code. When it answers
   * `'superseded'` (a newer credential from a pairing has not been presented
   * yet) the bridge reconnects with that credential; any other answer leaves
   * the bridge in the not-paired state until the next pairing.
   */
  readonly onUnauthorized: (evidence: UnauthorizedEvidence) => unknown;

  /**
   * Whether a credential is stored — the credential store's `hasToken`. The
   * snapshot's `hasCredential` and the "connect only when paired" rule read it.
   * Defaults to asking {@link WsBridgeDeps.tokenProvider} whether it answers a
   * non-empty value, and dropping that value immediately.
   */
  readonly hasCredential?: (() => Promise<boolean>) | undefined;

  /**
   * The `chrome.alarms` operations the keepalive needs — `chrome.alarms`
   * itself in the worker.
   */
  readonly alarms: WorkerAlarmsApi;

  /**
   * The one-shot timers the socket client's backoff, opening deadline and
   * credential deadline run on, the bridge's own open-socket heartbeat
   * ({@link SOCKET_HEARTBEAT_INTERVAL_MS}) and the `SERVICE_PONG_TIMEOUT_MS`
   * wait for each of its answers, and the bound of every
   * {@link WsBridge.awaitTabRoute} wait. When given, this module never calls
   * a global timer. Omitted, the client uses the platform timers and so do
   * the heartbeat and the route waits, each resolving the global at call time
   * rather than at import or construction.
   */
  readonly timers?: WorkerTimerApi | undefined;

  /**
   * The randomness the backoff jitter draws on. Omitted, `Math.random`. A test
   * passes `() => 1` to make the delays exactly `DEFAULT_WS_BACKOFF`'s nominal
   * 500, 1 000, 2 000 … 10 000 ms sequence.
   */
  readonly random?: (() => number) | undefined;

  /**
   * How a relayed inbound frame reaches the panels: the tab whose panels
   * receive it, or no tab when this module cannot resolve one — in which case
   * the implementation resolves the recipient from the frame's session binding
   * and never broadcasts session data to unrelated tabs.
   */
  readonly relayPush: RelayPush;

  /** Where every {@link WorkerStatusSnapshot} this module computes is published. */
  readonly pushStatus: WorkerStatusSink;

  /**
   * The persisted tab bindings — supplied by `service-worker.ts` over
   * `tab-registry.ts`, which this module never imports. Read on every
   * transition to open, to re-announce each binding on the new connection.
   */
  readonly listBindings: () => Promise<readonly TabBindingRecord[]>;

  /**
   * The local service's base URL when the bridge is built. Defaults to
   * `DEFAULT_SERVICE_BASE_URL`; {@link WsBridge.setServiceBaseUrl} replaces it
   * at run time. Validated by the protocol's loopback-only policy; a refused
   * value is the "Service not running" state with a configuration hint, never
   * a throw.
   */
  readonly serviceBaseUrl?: string | undefined;

  /**
   * Settles once the service address in force has been established from its
   * source — for the worker, the first read of the stored setting. Until then
   * the bridge opens no socket and issues no HTTP call, so neither the
   * credential (sent in `client.hello` and as every request's bearer token)
   * nor a pairing code can reach an address the developer did not choose;
   * afterwards the address in force — or its refusal, which a failed read puts
   * in force — decides. A rejection keeps the bridge closed, as an unreadable
   * setting must. Absent, {@link serviceBaseUrl} is in force at once.
   */
  readonly serviceEndpointSettled?: (() => PromiseLike<void>) | undefined;

  /**
   * Told of telemetry the socket client accepted into its outbound queue and
   * then discarded, so the developer learns the capture is incomplete:
   *
   * - a queued `telemetry.event` frame dropped from the head of the full queue
   *   while the socket was down — reported inside the `send` that overflowed
   *   it, oldest frame first;
   * - every `telemetry.event` frame still queued when the credential was
   *   removed (`handlePairingState('not-paired')`), whose close clears the
   *   queue.
   *
   * Called once per discarded frame that carried events, with the tab the
   * batch came from and how many events the frame carried — never the events
   * themselves. `service-worker.ts` shows them as undelivered telemetry.
   *
   * Not called for a frame that was flushed to a socket, for a frame
   * {@link WsBridge.sendTelemetryBatch} could not hand over at all (its `Err`
   * reports that), for a loss-only frame (it names no undelivered event, and
   * its loss was shown when the page reported it; its drop is logged), for
   * non-telemetry frames, or when {@link WsBridge.close} disposes of the
   * bridge. A callback that throws is logged by code and contained, since it
   * runs inside the socket client's `send`. What the discarded frame meant for
   * the service's ledger is {@link WsBridgeDeps.onTelemetryFrameDiscarded}'s.
   *
   * @example
   * ```ts
   * onTelemetryDropped: (tabId, events) => recordTelemetryLoss(tabId, 'undelivered', events),
   * ```
   */
  readonly onTelemetryDropped?: ((tabId: TabId, events: number) => void) | undefined;

  /**
   * Told of every `telemetry.event` frame the socket client accepted into its
   * outbound queue and then discarded — on the same two occasions as
   * {@link WsBridgeDeps.onTelemetryDropped}, oldest frame first — **loss-only
   * frames included**, so the capture loss the frame stood for can still reach
   * the service's producer-loss ledger: its events, and the `droppedCount` it
   * carried (a batch's first frame, or a loss-only report).
   *
   * Called once per discarded frame, before `onTelemetryDropped` for the same
   * frame, with the frame's labels as they were sent — the routing session and
   * the armed capture — so the receiver can hold the loss under exactly that
   * context and never relabel it. Counts and ids only, never an event. Not
   * called for a flushed frame, a refused send, a non-telemetry frame or on
   * {@link WsBridge.close}. A callback that throws is logged by code and
   * contained.
   *
   * @example
   * ```ts
   * onTelemetryFrameDiscarded: (frame) =>
   *   holdPendingLoss(frame.tabId, { sessionId: frame.sessionId, captureId: frame.armedCaptureId },
   *     frame.events + frame.droppedCount),
   * ```
   */
  readonly onTelemetryFrameDiscarded?: ((frame: DiscardedTelemetryFrame) => void) | undefined;

  /**
   * Told when the service refused, for good, a binding this bridge
   * re-announced after a reconnect — the persisted pair names a session that
   * ended, failed or vanished while the socket was down (a stall, a service
   * restart, an evicted worker), so the `session.updated` and
   * `cleanup.completed` frames that would have ended it never reached this
   * connection.
   *
   * By the time it is called the bridge has already forgotten the pair's
   * routing memo and confirmed route and failed the pair's route waits; the
   * receiver owns the persisted binding and the page agent, and must end both
   * (`service-worker.ts` ends the tab's binding as `session-ended`, which
   * returns its page agent to the dormant configuration — AAP §0.5.1: hooks
   * disabled, not merely idled). The service cannot tell this connection
   * itself: a devtools connection receives session-scoped frames only for the
   * sessions it binds, and it binds none of an ended session's.
   *
   * Called once per refused `session.bind`, only for a refusal carrying a
   * {@link BindingRefusalCode} whose `ref` names a bind re-announced on the
   * current connection. Ids and the code only. A callback that throws is
   * logged by code and contained, since it runs inside inbound dispatch.
   *
   * @example
   * ```ts
   * onBindingRefused: ({ sessionId }) => void registry.handleSessionEnded(sessionId),
   * ```
   */
  readonly onBindingRefused?: ((refusal: BindingRefusal) => void) | undefined;

  /**
   * Where lifecycle records go. Defaults to `noopLogger`. Records carry message
   * types, counts, tab and session ids, error codes and state names only.
   */
  readonly logger?: Logger | undefined;
}

/*
 * ===========================================================================
 * Section C — the public contract
 * ===========================================================================
 */

/**
 * The per-call options of every session-scoped HTTP proxy: the protocol's
 * {@link HttpCallOptions} with the acting tab made **required**.
 *
 * The worker presents one paired DevTools credential for every inspected tab,
 * so the service holds a session-scoped request to "only the session bound to
 * that tab" (AAP §0.5.6) by the tab the request names — `HttpClient` sends it
 * as the `x-debuggen-tab` header — and refuses a DevTools request that names
 * none. Required here, rather than optional as in the protocol's generic
 * options, so a call site that forgot its tab fails `tsc -b` instead of
 * reaching the service unscoped. The value is the tab Chrome's port metadata
 * attributes the request to (`service-worker.ts` resolves it), never one a
 * page or panel payload supplied. `HttpClient` refuses a value that is not a
 * Chrome tab id locally, before any credential is read.
 *
 * @example
 * ```ts
 * await bridge.startCapture(sessionId, { tabId, signal: context.signal });
 * ```
 */
export type TabScopedCallOptions = HttpCallOptions & {
  /** The inspected tab this request acts for. */
  readonly tabId: TabId;
};

/**
 * The per-call options of the auth-exempt health probe: {@link HttpCallOptions}
 * without the acting tab. An unauthenticated request has no principal for a
 * tab to narrow, and `HttpClient` would refuse one locally — a refusal the
 * probe would misread as "the service is not running" — so the type rules it
 * out.
 */
export type TablessCallOptions = Omit<HttpCallOptions, 'tabId'>;

/**
 * The bridge's own view of its connection, for diagnostics and for tests.
 *
 * A superset of what the panel is told — the panel reads the derived
 * {@link WorkerStatusSnapshot} — and, like it, free of any secret: whether a
 * credential exists is a boolean, and a configuration refusal is reported by
 * its code, never by the refused value.
 */
export type WsBridgeStatus = {
  /** The socket client's state, in the protocol's transport vocabulary. */
  readonly transport: ConnectionState;
  /** The pill state `panelConnectionStatus` derives from the facts below. */
  readonly panelStatus: PanelConnectionStatus;
  /** Whether a devtools credential is stored, as last observed. */
  readonly hasCredential: boolean;
  /**
   * Whether the service refused the current credential (a 4401, or an HTTP
   * `UNAUTHORIZED`). While set, no reconnect is attempted with it; the next
   * pairing — or an explicit {@link WsBridge.connect} — clears it.
   */
  readonly credentialRefused: boolean;
  /** Whether the service's health route answered on the last probe. */
  readonly serviceReachable: boolean;
  /** The code the configured service URL was refused with, if it was. */
  readonly configurationErrorCode: DebuggenErrorCode | undefined;
  /** Outbound frames the socket client's queue has dropped since creation. */
  readonly droppedFrameCount: number;
  /** Outbound frames currently waiting for a socket. */
  readonly queuedFrameCount: number;
  /** Whether this bridge created the keepalive alarm and still holds it. */
  readonly keepaliveArmed: boolean;
  /**
   * Whether the open-socket heartbeat is running: a tick scheduled or in
   * flight. True only while the transport is `open`.
   */
  readonly heartbeatActive: boolean;
  /** Whether {@link WsBridge.close} has run. */
  readonly disposed: boolean;
};

/**
 * What {@link WsBridge.sendTelemetryBatch} did with one raw batch.
 *
 * Counts only — never an event, so the value is safe to log. Telemetry is
 * never queued for a later connection, so on success every frame was written
 * to the open socket and `sent` equals `frames`. A loss-only report is one
 * frame without events, `{ events: 0, frames: 1, sent: 1 }`; an empty batch
 * with no loss to report is `{ events: 0, frames: 0, sent: 0 }`.
 */
export interface TelemetryBatchOutcome {
  /** How many events the batch held and were written to the socket. */
  readonly events: number;
  /** How many `telemetry.event` frames they were wrapped into. */
  readonly frames: number;
  /** How many of those frames were written to the open socket. */
  readonly sent: number;
}

/**
 * One `telemetry.event` frame the socket client queued and then discarded, as
 * {@link WsBridgeDeps.onTelemetryFrameDiscarded} reports it: the labels it was
 * sent under and the loss it stood for. Counts and ids only — never an event —
 * so it is safe to hold and to log by count.
 */
export interface DiscardedTelemetryFrame {
  /** The tab whose page agent produced the batch — the frame's acting tab. */
  readonly tabId: TabId;
  /** The session the frame was scoped to: the tab's confirmed route. */
  readonly sessionId: SessionId;
  /** The capture the agent was armed for, when the batch named one. */
  readonly armedCaptureId?: CaptureId | undefined;
  /** How many events the frame carried; zero for a loss-only report. */
  readonly events: number;
  /** The loss the frame reported — its batch's first frame, or a loss-only report; else zero. */
  readonly droppedCount: number;
}

/**
 * A re-announced binding the service refused for good, as
 * {@link WsBridgeDeps.onBindingRefused} reports it. Ids and the code only.
 */
export interface BindingRefusal {
  /** The tab the persisted binding held. */
  readonly tabId: TabId;
  /** The session it named, which the service reports ended, failed or gone. */
  readonly sessionId: SessionId;
  /** Why the service refused it. */
  readonly code: BindingRefusalCode;
}

/**
 * The options of one {@link WsBridge.awaitTabRoute} wait.
 *
 * @example
 * ```ts
 * const route = await bridge.awaitTabRoute(tabId, sessionId, { signal: deadline.signal });
 * ```
 */
export interface TabRouteWaitOptions {
  /**
   * Ends the wait with `TRANSPORT_DISCONNECTED` (`details.cancelled:
   * 'aborted'`) when it fires; an already-fired signal ends it at once.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * The longest the wait may last, in milliseconds. A value that is not a
   * positive finite number is replaced by {@link TELEMETRY_ROUTE_WAIT_MS}.
   */
  readonly timeoutMs?: number | undefined;
}

/**
 * The delivery context of one raw agent batch, copied by `service-worker.ts`
 * from the page agent's `telemetry.batch` bridge frame into the optional
 * fields of the protocol's `telemetry.event` payload.
 *
 * Neither field attributes anything: the service resolves the session and the
 * open capture window from the tab's binding, as it does for a batch without
 * them. An absent field is omitted from the frame, never sent as `undefined`.
 *
 * @example
 * ```ts
 * bridge.sendTelemetryBatch(tabId, payload.events, {
 *   armedCaptureId: payload.captureId,
 *   droppedCount: payload.droppedCount,
 * });
 * ```
 */
export interface TelemetryBatchContext {
  /**
   * The capture the agent was armed for when it recorded the batch. It is
   * refusal-only at the service: a batch naming a capture other than the tab's
   * open one is refused as stale rather than relabelled into the newer window.
   * Carried on every frame of the batch, because each frame is attributed on
   * its own. A value the protocol would not accept as an identifier refuses
   * the whole batch — see {@link WsBridge.sendTelemetryBatch}.
   */
  readonly armedCaptureId?: CaptureId | undefined;
  /**
   * How many events the agent discarded since the batch that last reported a
   * loss (its buffer is bounded at 5 000 events while the bridge is away,
   * AAP §0.5.5). Carried on the first frame only, and only when above zero, so
   * a batch split into several frames reports its loss exactly once. A value
   * that is not a whole number from zero is not forwarded. Beside an empty
   * batch, a count above zero is the whole frame: the loss-only report
   * `{ events: [], armedCaptureId?, droppedCount }`.
   */
  readonly droppedCount?: number | undefined;
}

/**
 * The options of one {@link WsBridge.awaitTelemetryCapacity} wait: the same
 * cancellation and bound as a route wait.
 *
 * @example
 * ```ts
 * const room = await bridge.awaitTelemetryCapacity(tabId, events.length, {
 *   signal: deadline.signal,
 * });
 * ```
 */
export type TelemetryCapacityWaitOptions = TabRouteWaitOptions;

/**
 * The bridge's telemetry flow control, as {@link WsBridge.getTelemetryFlow}
 * reports it. Counts only.
 */
export interface TelemetryFlowStatus {
  /**
   * Whether the service has acknowledged a barrier to this bridge, which is
   * what makes the in-flight window binding (see "Telemetry flow control" in
   * {@link createWsBridge}).
   */
  readonly paced: boolean;
  /** Telemetry events written on the current connection and not yet acknowledged, reservations included. */
  readonly inFlightEvents: number;
  /** Telemetry frames written on the current connection and not yet acknowledged, reservations included. */
  readonly inFlightFrames: number;
  /** Barrier pings written on the current connection and not yet answered. */
  readonly outstandingBarriers: number;
  /** Capacity waits pending now. */
  readonly waiting: number;
  /** Capacity waits that had to wait, since the bridge was created. */
  readonly waits: number;
}

/**
 * The `chrome.alarms.onAlarm` argument, as far as the keepalive reads it.
 */
export interface KeepaliveAlarmLike {
  /** The alarm's name. */
  readonly name: string;
}

/**
 * The bridge. Every member is a function-valued property that never uses
 * `this`, so each can be handed on as a bare reference —
 * `send: bridge.send`, `store.onStateChange(bridge.handlePairingState)` — as
 * `service-worker.ts` does. No member throws and no returned promise rejects.
 */
export interface WsBridge {
  /**
   * Connect to the service, or resume after a refusal once a new credential
   * exists.
   *
   * Reads whether a credential is stored first: with none, the bridge stays in
   * the not-paired state and no socket is opened. With one, it arms the
   * keepalive and asks the socket client to connect — idempotent while
   * connecting or open, and an immediate attempt while reconnecting. A service
   * URL the loopback policy refused opens nothing and reports the
   * "Service not running" state with a configuration hint.
   */
  readonly connect: () => Promise<void>;

  /**
   * Dispose of the bridge: close the socket, clear the keepalive alarm, drop the
   * routing memo. Terminal and idempotent — a disposed bridge leaves nothing
   * behind, and a later {@link WsBridge.connect} does nothing.
   */
  readonly close: () => Promise<void>;

  /**
   * React to a change of the credential store's pairing state: `'paired'`
   * connects immediately; `'not-paired'` closes an open socket and reports the
   * not-paired state; `'pairing'` changes nothing.
   */
  readonly handlePairingState: (state: PairingState) => void;

  /**
   * Point the bridge at another service address — the one the developer
   * configured — or at the refusal of the configured one.
   *
   * - A **string** is validated by the protocol's loopback-only policy. The
   *   same canonical address as now, while none is refused, changes nothing.
   *   A different one is shown on the pill, clears the routing memo (bindings
   *   belong to a connection with one service), and moves the socket client
   *   (`ReconnectingWsClient.setUrl`): a socket that is wanted is retired and
   *   reopened against the new address at once; a closed one is connected when
   *   a credential is stored. A value the policy refuses is the
   *   "Service not running" state with the policy's hint, and opens nothing.
   * - A **`DebuggenError`** is a refusal the caller's own, stricter policy
   *   produced (`parseServiceEndpoint` in `./auth` — the manifest's host
   *   permissions). The socket is closed, HTTP is refused, and the pill shows
   *   "Service not running" with that error's hint, until a usable address is
   *   set. Never a silent fallback to the default.
   *
   * The HTTP side is the caller's: the shared `HttpClient` is immutable, so
   * `service-worker.ts` rebuilds it for the new address, and this bridge — which
   * dereferences {@link WsBridgeDeps.httpClient} per request — uses the new one
   * from the next call.
   */
  readonly setServiceBaseUrl: (url: string | DebuggenError) => void;

  /**
   * The keepalive tick. `service-worker.ts` calls it from
   * `chrome.alarms.onAlarm`; an alarm of any other name is ignored.
   */
  readonly handleKeepaliveAlarm: (alarm?: KeepaliveAlarmLike) => Promise<void>;

  /**
   * Send one protocol frame on the connection — `ReconnectingWsClient.send`
   * exactly: `ok('sent')`, `ok('queued')` while reconnecting, or an `Err` when
   * the connection is closed.
   */
  readonly send: ProtocolSend;

  /**
   * Subscribe to one inbound message type. Every validated inbound frame of
   * that type reaches the handler — relayed types included, so `tab-registry`
   * sees `session.bound` and the capture lifecycle while the panels see them
   * too. Returns the unsubscribe function; calling it twice is harmless.
   */
  readonly subscribe: ProtocolSubscribe;

  /**
   * Wrap one raw agent batch into `telemetry.event` frames and write them to
   * the open socket, chunked to the protocol's per-frame bound and in order,
   * every frame scoped to its tab (the envelope's acting `tabId`) and to that
   * tab's session (the envelope's `sessionId`).
   *
   * The session is `sessionId` when the caller supplies it — the binding
   * `tab-registry.ts` holds, which survives a worker eviction — else the
   * session the service confirmed for the tab on this connection. Telemetry is
   * **never** queued for a later connection, so the batch is refused and
   * **nothing** is sent when:
   *
   * - the socket cannot take a write now (connecting, reconnecting, closed or
   *   closing) — `TRANSPORT_DISCONNECTED`;
   * - the service has not confirmed, on the current connection, that the tab
   *   is bound to that session — `TAB_NOT_BOUND`. An unscoped or unconfirmed
   *   batch could be refused by a restarted service, or attributed to another
   *   tab's capture.
   *
   * A caller that is refused waits for {@link WsBridge.awaitTabRoute} and
   * tries again; the service worker's telemetry lane does exactly that.
   *
   * With a {@link TelemetryBatchContext}, every frame carries its
   * `armedCaptureId` and the first frame its `droppedCount` above zero;
   * without one, each frame's payload is exactly `{ events }`.
   *
   * An empty batch whose context reports a loss above zero is a **loss-only
   * report** — what the page agent's terminal flush and the content bridge post
   * when no later batch will carry a loss — and is sent as exactly one frame,
   * `{ events: [], armedCaptureId?, droppedCount }`, held to every refusal
   * above and to the `armedCaptureId` check below; it answers
   * `{ events: 0, frames: 1, sent: 1 }`. An empty batch without such a loss
   * (none, zero or a malformed count) sends nothing and answers zeros: the
   * protocol refuses an event-less frame that reports no loss.
   *
   * @param tabId The tab the batch came from (the bridge port's sender).
   * @param rawEvents The agent's `events` array, exactly as it arrived.
   * @param sessionId The session bound to `tabId`, as the registry recorded it.
   * @param context The batch's delivery context, from the bridge frame.
   * @returns The counts, or the refusal, or the first send failure. An
   * `armedCaptureId` the protocol would not accept refuses the batch before
   * any frame is sent.
   */
  readonly sendTelemetryBatch: (
    tabId: TabId,
    rawEvents: unknown,
    sessionId?: SessionId,
    context?: TelemetryBatchContext,
  ) => Result<TelemetryBatchOutcome, DebuggenError>;

  /**
   * Wait until the service has confirmed, on the current connection, that
   * `tabId` is bound to `sessionId` — the route along which
   * {@link WsBridge.sendTelemetryBatch} writes that tab's telemetry.
   *
   * A route is confirmed only by an inbound `session.bound` with an
   * establishing reason (`bound`, `navigated`, or none) for that tab and
   * session, received on the open socket — never by the worker's own
   * re-announcement, which the service may still refuse. Every transport
   * transition starts a new connection generation with no confirmed route, so
   * after a reconnect or a service restart the wait lasts until the
   * re-announced `session.bind` has been answered. On a warm, confirmed
   * connection the answer is immediate.
   *
   * Resolves — never rejects — with:
   *
   * - `ok` once the socket is open and the pair is confirmed;
   * - `TAB_NOT_BOUND` when a confirmation for the tab names another session,
   *   a confirmation names the session for another tab, or the binding ends;
   * - `UNAUTHORIZED` when the service refused the credential, or it was
   *   removed;
   * - `TRANSPORT_DISCONNECTED` when the bounded wait expires
   *   (`details.cancelled: 'timeout'`), `options.signal` fires
   *   (`'aborted'`), or the bridge is disposed;
   * - `PROTOCOL_INVALID_MESSAGE` for a value that is not a tab id or an empty
   *   session id.
   *
   * The wait runs on the injected timers; its timer and abort listener are
   * released however it settles.
   *
   * @param tabId The tab whose route is awaited.
   * @param sessionId The session the tab's telemetry is for.
   * @param options The caller's cancellation signal and the wait's bound.
   * @returns `ok` when the route is confirmed, or why it cannot be.
   */
  readonly awaitTabRoute: (
    tabId: TabId,
    sessionId: SessionId,
    options?: TabRouteWaitOptions,
  ) => Promise<Result<void, DebuggenError>>;

  /**
   * Wait until the in-flight telemetry window has room for a batch of
   * `events` from `tabId`, and reserve that room for the tab's next
   * {@link WsBridge.sendTelemetryBatch} — the call to make immediately before
   * it, with nothing awaited in between (see "Telemetry flow control" in
   * {@link createWsBridge}).
   *
   * Answers at once while the window has room, while nothing is in flight (a
   * batch larger than the window is then admitted whole), and while the
   * service has not yet acknowledged a barrier to this bridge. Otherwise the
   * wait lasts until enough of the telemetry in flight is acknowledged, a
   * transport transition empties the window, the bound expires or the signal
   * fires. Waits are granted in the order they began.
   *
   * Resolves — never rejects — with `ok` once the room is reserved, or with
   * `TRANSPORT_DISCONNECTED` (`details.cancelled: 'timeout'` or `'aborted'`,
   * or disposed), or `PROTOCOL_INVALID_MESSAGE` for a value that is not a tab
   * id or a count that is not a whole number. A grant is not a delivery: the
   * send that follows reports its own outcome.
   *
   * @param tabId The tab whose batch is about to be sent.
   * @param events How many events the batch holds; zero for a loss-only report.
   * @param options The caller's cancellation signal and the wait's bound.
   * @returns `ok` once the room is reserved, or why it was not.
   */
  readonly awaitTelemetryCapacity: (
    tabId: TabId,
    events: number,
    options?: TelemetryCapacityWaitOptions,
  ) => Promise<Result<void, DebuggenError>>;

  /** The telemetry flow control's counts, as they stand now. */
  readonly getTelemetryFlow: () => TelemetryFlowStatus;

  /**
   * Relay the page agent's `agent.ready` report to the service with the
   * `tabId` the page cannot know filled in — in the payload and as the frame's
   * acting tab; every other field is forwarded intact.
   */
  readonly relayAgentReady: (
    tabId: TabId,
    report: PageAgentReadyPayload,
  ) => Result<SendOutcome, DebuggenError>;

  /*
   * The session-scoped HTTP operations below each take the acting tab in a
   * required `options.tabId` ({@link TabScopedCallOptions}), sent as the
   * `x-debuggen-tab` header; the service refuses a DevTools request that names
   * no tab, or a tab whose live binding is another session's (AAP §0.5.6).
   */

  /**
   * `POST /sessions/:id/panel-data`: resolve one panel node's `DataQuery`.
   *
   * `request` is the protocol's `PanelDataRequest` body and is sent verbatim —
   * the node's query and, for a node of a rendered panel, its `panelId`, which
   * is what makes the service answer from that panel's capture rather than the
   * live one. The protocol client validates it against the route's schema
   * before sending, so a malformed body is an `Err` here, never a request. The
   * `DataResult` is forwarded verbatim too — paging echo included; the service
   * owns the default and maximum limits.
   */
  readonly queryPanelData: (
    sessionId: SessionId,
    request: PanelDataRequest,
    options: TabScopedCallOptions,
  ) => Promise<Result<DataResult, DebuggenError>>;

  /**
   * `POST /sessions/:id/capture/start`. A capture already held by another
   * session is the `Err` whose code is `CAPTURE_ALREADY_ACTIVE` and whose
   * details name the owning session — read it with {@link captureConflictOwner}.
   */
  readonly startCapture: (
    sessionId: SessionId,
    options: TabScopedCallOptions,
  ) => Promise<Result<CaptureStartResponse, DebuggenError>>;

  /** `POST /sessions/:id/capture/stop`: close the window, answer its summary. */
  readonly stopCapture: (
    sessionId: SessionId,
    options: TabScopedCallOptions,
  ) => Promise<Result<CaptureStopResponse, DebuggenError>>;

  /** `GET /sessions/:id`: the session record. */
  readonly getSession: (
    sessionId: SessionId,
    options: TabScopedCallOptions,
  ) => Promise<Result<SessionRecord, DebuggenError>>;

  /** `GET /sessions/:id/panel`: the session's current panel, or `null`. */
  readonly getCurrentPanel: (
    sessionId: SessionId,
    options: TabScopedCallOptions,
  ) => Promise<Result<PanelResponse, DebuggenError>>;

  /** `GET /sessions/:id/panels/:panelId`: one specific panel version. */
  readonly getPanel: (
    sessionId: SessionId,
    panelId: string,
    options: TabScopedCallOptions,
  ) => Promise<Result<PanelByIdResponse, DebuggenError>>;

  /** `GET /sessions/:id/modifications`: the session's modification journal. */
  readonly getModifications: (
    sessionId: SessionId,
    options: TabScopedCallOptions,
  ) => Promise<Result<ModificationsResponse, DebuggenError>>;

  /**
   * `GET /health`, auth-exempt: whether the service is running. The outcome
   * also updates the bridge's reachability, and therefore the pill. Tab-less:
   * an unauthenticated probe has no principal to act for a tab, so its options
   * ({@link TablessCallOptions}) cannot carry one.
   */
  readonly probeService: (
    options?: TablessCallOptions,
  ) => Promise<Result<HealthResponse, DebuggenError>>;

  /** The bridge's own view of its connection. */
  readonly getStatus: () => WsBridgeStatus;

  /**
   * The status snapshot the panel renders, as it stands now — what a freshly
   * opened panel is answered with before the next push.
   */
  readonly snapshot: () => WorkerStatusSnapshot;
}

/**
 * The session that holds the capture, when a `startCapture` failure is the
 * documented capture-ownership conflict (`409` with `owningSessionId`).
 *
 * The failure itself is passed through unchanged so its code survives to the
 * panel; this reads the one machine-readable field the conflict adds, so a
 * caller can say *which* session holds the capture.
 *
 * @param error A failure returned by {@link WsBridge.startCapture}.
 * @returns The owning session's id, or `undefined` for any other failure.
 */
export function captureConflictOwner(error: DebuggenError): SessionId | undefined {
  if (error.code !== CAPTURE_CONFLICT_ERROR_CODE) {
    return undefined;
  }
  const owner = error.details?.owningSessionId;
  return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
}

/*
 * Compile-time proofs that the credential store's members can be handed to
 * the bridge as bare references, exactly as `service-worker.ts` does. Each
 * fails `tsc -b` (TS2344) here if either side drifts. Type-level only; exported
 * so `noUnusedLocals` accepts them, the convention `./messages` and `./auth`
 * follow.
 */

/** `store.handleUnauthorized` fits {@link WsBridgeDeps.onUnauthorized}. */
export type StoreHandleUnauthorizedFitsBridge = AssertTrue<
  DevtoolsCredentialStore['handleUnauthorized'] extends WsBridgeDeps['onUnauthorized']
    ? true
    : false
>;

/** `store.hasToken` fits {@link WsBridgeDeps.hasCredential}. */
export type StoreHasTokenFitsBridge = AssertTrue<
  DevtoolsCredentialStore['hasToken'] extends NonNullable<WsBridgeDeps['hasCredential']>
    ? true
    : false
>;

/** `store.getToken` fits {@link WsBridgeDeps.tokenProvider}. */
export type StoreGetTokenFitsBridge = AssertTrue<
  DevtoolsCredentialStore['getToken'] extends WsBridgeDeps['tokenProvider'] ? true : false
>;

/** `store.getReadProof` fits {@link WsBridgeDeps.readProofProvider}. */
export type StoreGetReadProofFitsBridge = AssertTrue<
  DevtoolsCredentialStore['getReadProof'] extends NonNullable<WsBridgeDeps['readProofProvider']>
    ? true
    : false
>;

/*
 * ===========================================================================
 * Section D — pure helpers
 *
 * Total functions: each returns a value for every input and never throws.
 * None builds a string from a payload, a URL or a credential.
 * ===========================================================================
 */

/**
 * A Chrome tab id: a non-negative safe integer. `-1` is
 * `chrome.tabs.TAB_ID_NONE`, never a tab — the protocol's own rule.
 */
function isTabId(value: unknown): value is TabId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A string with at least one character. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** A positive whole number: a usable frame bound. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Whether a value is an array, narrowing it to the protocol's ingress batch.
 *
 * Only the container is checked. Each element's contract is the protocol's
 * strict ingress schema, which the service applies on receipt of every frame;
 * validating the elements here as well would double the cost of the hottest
 * path of a capture — the protocol's own reasoning for not validating on send
 * (`createEnvelope`). The agent built them and nothing here reads them.
 */
function isRawEventArray(value: unknown): value is readonly TelemetryEventIngress[] {
  return Array.isArray(value);
}

/** Whether a value is an array, as `unknown` elements. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Whether a value is a capture identifier the `telemetry.event` schema accepts
 * as `armedCaptureId`.
 *
 * Read off the schema the service validates every frame with, like
 * {@link readTelemetryFrameEventLimit}, so the rule has one source: a value
 * that passes here is never the reason the service refuses a frame.
 */
function isArmedCaptureId(value: unknown): value is CaptureId {
  return (
    value !== undefined && telemetryEventPayloadSchema.shape.armedCaptureId.safeParse(value).success
  );
}

/**
 * Whether a value is a loss count the `telemetry.event` schema accepts as
 * `droppedCount`: a whole number from zero within the safe-integer range. Read
 * off the schema for the reason {@link isArmedCaptureId} is.
 */
function isDroppedCount(value: unknown): value is number {
  return (
    value !== undefined && telemetryEventPayloadSchema.shape.droppedCount.safeParse(value).success
  );
}

/**
 * The most events one `telemetry.event` frame may carry, read off the schema
 * the service validates the frame with.
 *
 * The protocol declares the bound (5 000 events, the agent's own buffer
 * ceiling) as a module-local constant of `messages/telemetry.ts` and exports
 * only the schema that enforces it — `telemetryEventPayloadSchema`, whose
 * `events` array carries a Zod `max_length` check. Reading the bound from that
 * check makes the schema the single source: the frames this module builds are
 * exactly as large as the receiver accepts, and a change to the bound there is
 * a change here with no edit. The read is structural and total; should the
 * schema ever declare no maximum, any length is valid by its own rule, and the
 * whole batch travels in one frame ({@link UNBOUNDED_FRAME_EVENTS}).
 *
 * @returns The per-frame event bound.
 */
function readTelemetryFrameEventLimit(): number {
  const eventsSchema: unknown = telemetryEventPayloadSchema.shape.events;
  if (!isPlainRecord(eventsSchema)) {
    return UNBOUNDED_FRAME_EVENTS;
  }
  const definition = eventsSchema.def;
  if (!isPlainRecord(definition)) {
    return UNBOUNDED_FRAME_EVENTS;
  }
  const checks = definition.checks;
  if (!isUnknownArray(checks)) {
    return UNBOUNDED_FRAME_EVENTS;
  }
  let limit = UNBOUNDED_FRAME_EVENTS;
  for (const check of checks) {
    if (!isPlainRecord(check)) {
      continue;
    }
    const internals = check._zod;
    if (!isPlainRecord(internals)) {
      continue;
    }
    const checkDefinition = internals.def;
    if (!isPlainRecord(checkDefinition) || checkDefinition.check !== MAX_LENGTH_CHECK) {
      continue;
    }
    const maximum = checkDefinition.maximum;
    if (isPositiveInteger(maximum) && maximum < limit) {
      limit = maximum;
    }
  }
  return limit;
}

/**
 * A backoff delay as the panel's `retryInMs`: a whole, non-negative number of
 * milliseconds. The jittered delay is fractional, and the panel's
 * `isPanelConnectionState` accepts only a whole count, so it is rounded up —
 * the pill never promises a retry sooner than it will happen.
 */
function toRetryMs(delayMs: number | undefined): number | undefined {
  if (delayMs === undefined || !Number.isFinite(delayMs)) {
    return undefined;
  }
  return Math.max(0, Math.ceil(delayMs));
}

/**
 * The session a relayed frame is about: the envelope's routing key, else the
 * payload's own `sessionId`, else a session record's `id`
 * (`session.created` / `session.updated`). `undefined` for a session-less
 * frame. Structural, like the protocol's own `sessionIdFromPayload`, so it is
 * correct for every relayed type without a per-type table.
 */
function sessionIdOf(message: RelayedProtocolMessage): SessionId | undefined {
  if (isNonEmptyString(message.sessionId)) {
    return message.sessionId;
  }
  const payload: unknown = message.payload;
  if (!isPlainRecord(payload)) {
    return undefined;
  }
  if (isNonEmptyString(payload.sessionId)) {
    return payload.sessionId;
  }
  const session = payload.session;
  if (isPlainRecord(session) && isNonEmptyString(session.id)) {
    return session.id;
  }
  return undefined;
}

/**
 * Whether a `session.bound` announcement ends the tab's binding rather than
 * establishing or keeping it — the same classification `tab-registry.ts`
 * applies: an absent reason is an establishment, `bound` and `navigated` keep
 * the binding, and `replaced`, `origin-changed` and `unbound` drop it.
 */
function bindingEnds(reason: BindingReason | undefined): boolean {
  switch (reason) {
    case undefined:
    case 'bound':
    case 'navigated':
      return false;
    case 'replaced':
    case 'origin-changed':
    case 'unbound':
      return true;
    default:
      return assertNever(reason);
  }
}

/**
 * The fields of a failure that are safe to log: its code, and — for a frame
 * the protocol refused — the issue count and the issue paths and codes that
 * `protocolParseError` rendered, or the policy rule a refused URL broke, or the
 * message type a send concerned. Never the message text of an arbitrary error
 * (a thrown value can quote anything), never a payload.
 */
function describeFailure(error: DebuggenError): LogFields {
  const fields: LogFields = { code: error.code };
  const details = error.details;
  if (details === undefined) {
    return fields;
  }
  if (typeof details.issueCount === 'number') {
    fields.issueCount = details.issueCount;
  }
  if (isUnknownArray(details.issues)) {
    fields.issues = details.issues;
  }
  if (typeof details.rule === 'string') {
    fields.rule = details.rule;
  }
  if (typeof details.type === 'string') {
    fields.type = details.type;
  }
  return fields;
}

/**
 * Run a collaborator that may answer a value or a promise — or throw — and
 * settle it into a `Result`, so an injected fake or a platform API that
 * misbehaves can never reject a promise this module returns.
 *
 * @param run The call to make.
 * @param code The code a throw or a rejection is reported with.
 */
async function settle<T>(
  run: () => T | Promise<T>,
  code: DebuggenErrorCode,
): Promise<Result<T, DebuggenError>> {
  try {
    return ok(await run());
  } catch (thrown) {
    return err(DebuggenError.from(thrown, code));
  }
}

/**
 * The canonical, credential-free origin of a configured base URL, for the
 * pill — or `undefined` when the protocol's policy refuses it, because a
 * refused value may carry a pasted credential and is never displayed.
 */
function displayOriginOf(baseUrl: string): string | undefined {
  const origin = parseServiceOrigin(baseUrl);
  return isErr(origin) ? undefined : origin.value;
}

/**
 * The platform's one-shot timers as a {@link WorkerTimerApi}, for a bridge
 * built without injected ones.
 *
 * `self` — the worker's global scope in the extension, the window in a
 * document — is read on every call rather than captured, so building a bridge
 * reads no global, and its `setTimeout` is the DOM one whose handle is the
 * numeric one `WorkerTimerApi` requires (the same resolution
 * `service-worker.ts` applies to the timers it injects).
 */
function createPlatformTimers(): WorkerTimerApi {
  return {
    setTimeout: (handler, ms) => self.setTimeout(handler, ms),
    clearTimeout: (handle) => {
      self.clearTimeout(handle);
    },
  };
}

/**
 * Wrap a socket constructor so the bridge can see the `readyState` of the
 * socket the client is using.
 *
 * `ReconnectingWsClient.send` takes a frame into its reconnect queue whenever
 * the socket cannot take a write — including the window between a server's
 * close frame (`readyState` CLOSING) and the close event, while the client
 * still reports `open`. Telemetry must never enter that queue (it is flushed
 * after the next hello, before the re-announced bindings), and the client does
 * not expose its socket, so the bridge observes it here instead: every socket
 * is still built by `base`, with the arguments the client passed, and each
 * member is a pure delegation. `onConstructed` receives the socket `base`
 * built, which is the client's current socket for as long as it reports
 * `open`.
 *
 * Every frame the client writes is also counted, in the UTF-8 bytes a
 * platform socket adds to its `bufferedAmount` for it, through `onWritten` —
 * after the write, and only when the write did not throw. With that count the
 * heartbeat can tell how much of the socket's outbound buffer drained over a
 * pong window even while telemetry keeps being written to it
 * ({@link sendBufferDrained}).
 *
 * @param base The injected socket constructor.
 * @param onConstructed Told of every socket `base` constructs, in order.
 * @param onWritten Told of every frame written to a socket `base` built: the
 *   socket, and the frame's size in UTF-8 bytes.
 * @returns A constructor the socket client can use in `base`'s place.
 */
function observeSockets(
  base: WebSocketConstructorLike,
  onConstructed: (socket: WebSocketLike) => void,
  onWritten: (socket: WebSocketLike, bytes: number) => void,
): WebSocketConstructorLike {
  return class ObservedWebSocket implements WebSocketLike {
    /** The socket `base` built; every member delegates to it. */
    private readonly socket: WebSocketLike;

    constructor(...args: ConstructorParameters<WebSocketConstructorLike>) {
      this.socket = new base(...args);
      onConstructed(this.socket);
    }

    get readyState(): number {
      return this.socket.readyState;
    }

    addEventListener<K extends keyof WsEventMapLike>(
      type: K,
      listener: (event: WsEventMapLike[K]) => void,
    ): void {
      this.socket.addEventListener(type, listener);
    }

    removeEventListener<K extends keyof WsEventMapLike>(
      type: K,
      listener: (event: WsEventMapLike[K]) => void,
    ): void {
      this.socket.removeEventListener(type, listener);
    }

    send(data: string): void {
      this.socket.send(data);
      onWritten(this.socket, utf8ByteLength(data));
    }

    close(...args: Parameters<WebSocketLike['close']>): void {
      this.socket.close(...args);
    }
  };
}

/**
 * The number of bytes `text` occupies as UTF-8 — what the WebSocket API adds
 * to a socket's `bufferedAmount` when `text` is sent — counted without
 * encoding it. A lone surrogate counts as the three bytes of the U+FFFD it is
 * encoded as.
 *
 * @example
 * ```ts
 * utf8ByteLength('ping');   // 4
 * utf8ByteLength('é');      // 2
 * utf8ByteLength('…');      // 3
 * utf8ByteLength('😀');     // 4 (one surrogate pair)
 * ```
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * One reading of the observed socket's outbound buffer, taken by the
 * heartbeat.
 */
interface SendBufferSample {
  /** The socket read: samples of different sockets are never compared. */
  readonly socket: WebSocketLike;
  /** Its `bufferedAmount`: bytes written and not yet handed to the network. */
  readonly buffered: number;
  /** The UTF-8 bytes the bridge had written to it by then, in all. */
  readonly written: number;
}

/**
 * The bytes that left a socket's outbound buffer between two samples of it:
 * what it held at `start`, plus what was written since, minus what it holds
 * at `end`. Writes made between the samples are accounted, so a buffer that
 * drains while telemetry keeps arriving still shows the drain.
 *
 * @example
 * ```ts
 * // 40 000 bytes buffered, 10 000 written meanwhile, 30 000 left: 20 000 drained.
 * sendBufferDrained(
 *   { socket, buffered: 40_000, written: 5_000 },
 *   { socket, buffered: 30_000, written: 15_000 },
 * ); // 20_000
 * ```
 */
function sendBufferDrained(start: SendBufferSample, end: SendBufferSample): number {
  return start.buffered + (end.written - start.written) - end.buffered;
}

/**
 * The bytes the service demonstrably read from a socket between two samples,
 * or zero when the samples prove nothing: both must be of the same socket,
 * both must find its outbound buffer non-empty, and the buffer must have
 * drained between them ({@link sendBufferDrained}).
 *
 * The non-empty buffer at both ends is what makes the drain the service's
 * doing. Bytes leave the buffer as fast as the network takes them; while the
 * kernel still has room they leave at once, whether or not the service reads,
 * and the buffer empties. A buffer that stays non-empty across the span is one
 * the network could not keep up with — the kernel buffers were full — so each
 * byte that left it did so because the service read one. An empty buffer at
 * either end (an idle socket, or a backlog that went entirely to the kernel)
 * therefore earns no credit.
 *
 * @example
 * ```ts
 * // Backlogged at both ends, 60 000 drained net of 5 000 written: read.
 * sendBufferReadProgress(
 *   { socket, buffered: 300_000, written: 10_000 },
 *   { socket, buffered: 245_000, written: 15_000 },
 * ); // 60_000
 * // The buffer emptied: nothing proves the service read it.
 * sendBufferReadProgress(
 *   { socket, buffered: 300_000, written: 10_000 },
 *   { socket, buffered: 0, written: 15_000 },
 * ); // 0
 * ```
 */
function sendBufferReadProgress(
  start: SendBufferSample | undefined,
  end: SendBufferSample | undefined,
): number {
  if (
    start === undefined ||
    end === undefined ||
    start.socket !== end.socket ||
    start.buffered <= 0 ||
    end.buffered <= 0
  ) {
    return 0;
  }
  return Math.max(0, sendBufferDrained(start, end));
}

/**
 * Why a heartbeat ping whose pong window elapsed was given no further window:
 *
 * - `window-limit` — it has waited {@link HEARTBEAT_MAX_PONG_WINDOWS} windows;
 * - `buffer-unknown` — the socket reports no usable `bufferedAmount`, or the
 *   samples are of different sockets, so its progress cannot be judged;
 * - `nothing-ahead` — nothing written before the ping was still waiting in the
 *   socket's buffer when the window began: the ping had reached the network
 *   (or never waited behind anything), so the silence is the service's;
 * - `no-progress` — the buffer did not drain at all during the window.
 */
type PongWaitStop = 'window-limit' | 'buffer-unknown' | 'nothing-ahead' | 'no-progress';

/** What {@link decidePongWindow} concluded about one elapsed pong window. */
type PongWindowDecision =
  | {
      readonly extend: true;
      /** Bytes that left the buffer during the window. */
      readonly drainedBytes: number;
      /** Bytes written before the ping still buffered ahead of it now. */
      readonly aheadBytes: number;
      /** The buffer's `bufferedAmount` now. */
      readonly bufferedBytes: number;
    }
  | { readonly extend: false; readonly stop: PongWaitStop };

/**
 * Decide whether a heartbeat ping whose pong window has just elapsed is given
 * another window rather than retiring its socket.
 *
 * Another window is granted only while all of this holds: fewer than
 * {@link HEARTBEAT_MAX_PONG_WINDOWS} windows have elapsed; every sample is of
 * the same socket and reports its `bufferedAmount`; bytes written *before*
 * the ping were still buffered ahead of it when the window began — the ping
 * was waiting behind this socket's own backlog, not on the service; and the
 * buffer drained during the window — the service is consuming the backlog.
 * The window after the one in which the backlog ahead fully drained is thus
 * the last one granted: it is the ping's own window to reach the service and
 * be answered.
 *
 * @param windowsElapsed The pong windows elapsed so far, this one included.
 * @param beforePing The socket's buffer just before the ping was written.
 * @param windowStart The buffer when the elapsed window began.
 * @param now The buffer now, at the window's end.
 */
function decidePongWindow(
  windowsElapsed: number,
  beforePing: SendBufferSample | undefined,
  windowStart: SendBufferSample | undefined,
  now: SendBufferSample | undefined,
): PongWindowDecision {
  if (windowsElapsed >= HEARTBEAT_MAX_PONG_WINDOWS) {
    return { extend: false, stop: 'window-limit' };
  }
  if (
    beforePing === undefined ||
    windowStart === undefined ||
    now === undefined ||
    windowStart.socket !== beforePing.socket ||
    now.socket !== beforePing.socket
  ) {
    return { extend: false, stop: 'buffer-unknown' };
  }
  const aheadAtWindowStart = beforePing.buffered - sendBufferDrained(beforePing, windowStart);
  if (aheadAtWindowStart <= 0) {
    return { extend: false, stop: 'nothing-ahead' };
  }
  const drainedBytes = sendBufferDrained(windowStart, now);
  if (drainedBytes <= 0) {
    return { extend: false, stop: 'no-progress' };
  }
  return {
    extend: true,
    drainedBytes,
    aheadBytes: Math.max(0, beforePing.buffered - sendBufferDrained(beforePing, now)),
    bufferedBytes: now.buffered,
  };
}

/*
 * ===========================================================================
 * Section E — the bridge
 * ===========================================================================
 */

/**
 * The credential store's answer meaning "a newer credential is held and has not
 * been presented yet" — typed by the store's own vocabulary, so a rename there
 * fails to compile here.
 */
const SUPERSEDED: UnauthorizedHandling = 'superseded';

/** Why a wait was cancelled, in the protocol HTTP client's `details.cancelled` vocabulary. */
type RouteCancellation = 'timeout' | 'aborted';

/**
 * One pending {@link WsBridge.awaitTabRoute} wait: the pair it waits for, and
 * how to settle it. `settle` is idempotent — the first call wins, removes the
 * wait from the pending set and releases its timer and abort listener.
 */
interface RouteWaiter {
  /** The tab whose route is awaited. */
  readonly tabId: TabId;
  /** The session the route must name. */
  readonly sessionId: SessionId;
  /** Settle the wait once; later calls do nothing. */
  readonly settle: (result: Result<void, DebuggenError>) => void;
}

/**
 * A route-wait failure: a constant message, the tab id (and, for a
 * cancellation, its source) as the only details — never a session, URL or
 * credential.
 */
function routeFailure(
  code: DebuggenErrorCode,
  message: string,
  tabId: TabId,
  extra: { readonly hint?: string; readonly cancelled?: RouteCancellation } = {},
): DebuggenError {
  const { hint, cancelled } = extra;
  return workerError(code, message, {
    ...(hint === undefined ? {} : { hint }),
    details: cancelled === undefined ? { tabId } : { tabId, cancelled },
  });
}

/** The wait bound actually applied: the caller's when usable, else the default. */
function resolveRouteTimeout(timeoutMs: number | undefined): number {
  return timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : TELEMETRY_ROUTE_WAIT_MS;
}

/**
 * Where one `telemetry.event` frame came from: what a later drop of it
 * reports through {@link WsBridgeDeps.onTelemetryDropped} and
 * {@link WsBridgeDeps.onTelemetryFrameDiscarded}. Numbers and ids only; the
 * armed capture id is page-supplied and is never logged.
 */
interface TelemetryFrameOrigin {
  /** The tab whose page agent produced the batch. */
  readonly tabId: TabId;
  /** The session the frame was scoped to. */
  readonly sessionId: SessionId;
  /** The capture the frame names, when it names one. */
  readonly armedCaptureId?: CaptureId | undefined;
  /** How many events the frame carries; zero for a loss-only report. */
  readonly events: number;
  /** The loss the frame reports, when it reports one: a batch's first frame, or a loss-only report. */
  readonly droppedCount?: number | undefined;
}

/**
 * One frame the socket client queued, as {@link createWsBridge}'s queue
 * mirror records it: its type, which the client's drop report names too, and
 * for a telemetry frame its origin.
 */
interface QueuedFrameRecord {
  /** The frame's message type. */
  readonly type: MessageType;
  /** Present exactly for a `telemetry.event` frame sent by `sendTelemetryBatch`. */
  readonly telemetry?: TelemetryFrameOrigin;
}

/**
 * How the wait for one heartbeat `client.ping`'s answer ended:
 *
 * - `answered` — a `service.pong` whose `ref` is the ping's id arrived, or an
 *   `error` whose `ref` is: a service that predates the liveness pair refuses
 *   the unknown type under the ping's id, and that refusal proves the socket
 *   carries frames both ways just as well;
 * - `timed-out` — nothing naming the ping arrived within
 *   `SERVICE_PONG_TIMEOUT_MS`, or — for a ping queued behind the socket's own
 *   draining outbound backlog — within the further windows it was granted
 *   ({@link decidePongWindow});
 * - `cancelled` — the heartbeat stopped while the ping waited (the transport
 *   left `open`, the credential was removed, or the bridge was disposed).
 */
type HeartbeatPingOutcome = 'answered' | 'timed-out' | 'cancelled';

/** How one heartbeat ping's wait ended, and how long it lasted. */
interface HeartbeatPingResult {
  readonly outcome: HeartbeatPingOutcome;
  /** The ping's envelope id, which a late answer would name as its `ref`. */
  readonly id: MessageId;
  /** The socket's outbound buffer just before the ping was written; `undefined` when unreadable. */
  readonly beforePing: SendBufferSample | undefined;
  /** The pong windows the wait began: one, plus one per extension. */
  readonly pongWindows: number;
  /** For `timed-out`: why no further window was granted. */
  readonly stop?: PongWaitStop;
}

/**
 * The heartbeat's one outstanding `client.ping`: the id its answer must name,
 * the handle of the current `SERVICE_PONG_TIMEOUT_MS` deadline, the socket's
 * outbound buffer before the ping and at the current window's start, and the
 * resolver of the tick's wait. At most one exists, because the next tick is
 * scheduled only once this one's wait has ended.
 */
interface OutstandingPing {
  /** The ping's envelope id, which the answering `service.pong` or `error` names as its `ref`. */
  readonly id: MessageId;
  /**
   * The current window's deadline timer on the bridge's timers; replaced by each
   * extension, and when an acknowledged barrier renews the wait.
   */
  deadline: number;
  /** The pong windows begun: one at the write, one more per extension. */
  windows: number;
  /** The socket's outbound buffer just before the ping was written; `undefined` when unreadable. */
  readonly beforePing: SendBufferSample | undefined;
  /** The buffer when the current window began; `undefined` when unreadable. */
  windowStart: SendBufferSample | undefined;
  /** Why the last window was not extended, once it was not. */
  stop: PongWaitStop | undefined;
  /** Ends the tick's wait with the given outcome. */
  readonly finish: (outcome: HeartbeatPingOutcome) => void;
}

/**
 * One barrier: a `client.ping` written on the current connection, and how
 * much telemetry had been written before it. The service answers frames in
 * order, so its answer acknowledges every telemetry frame written before the
 * ping as processed.
 */
interface TelemetryBarrier {
  /** The ping's envelope id, which its answer names as its `ref`. */
  readonly id: MessageId;
  /** Telemetry events written on the connection before the ping. */
  readonly eventsThrough: number;
  /** Telemetry frames written on the connection before the ping. */
  readonly framesThrough: number;
}

/**
 * One pending {@link WsBridge.awaitTelemetryCapacity} wait. `grant` and
 * `settle` are idempotent — the first call wins, removes the wait from the
 * queue and releases its timer and abort listener.
 */
interface CapacityWaiter {
  /** The tab whose batch waits. */
  readonly tabId: TabId;
  /** The batch's events. */
  readonly events: number;
  /** The frames the batch will be written as. */
  readonly frames: number;
  /** Settle the wait once; later calls do nothing. */
  readonly settle: (result: Result<void, DebuggenError>) => void;
}

/** The room one tab's granted batch holds in the window until its send. */
interface TelemetryReservation {
  readonly events: number;
  readonly frames: number;
}

/**
 * Build the bridge. Pure construction: the socket client is created but not
 * connected, no alarm is created, nothing is read from storage and nothing is
 * published until a member is called — `service-worker.ts` calls
 * {@link WsBridge.connect}.
 *
 * ## Telemetry flow control
 *
 * The service handles a connection's frames strictly in order and answers a
 * `client.ping` when its turn comes, so a ping written after telemetry frame
 * *n* is answered only once frames up to *n* have been processed. The bridge
 * uses that as an acknowledgement, within the existing protocol:
 *
 * - every telemetry write is counted against the current connection, and
 *   after each {@link TELEMETRY_BARRIER_EVENTS} events or
 *   {@link TELEMETRY_BARRIER_FRAMES} frames a **barrier** `client.ping` is
 *   written behind them; the heartbeat's ping is a barrier too. Its
 *   `service.pong` — or an `error` naming it, from a service that predates
 *   the pair — acknowledges everything written before it, and every barrier
 *   older than it;
 * - the telemetry written and not acknowledged is held to
 *   {@link MAX_UNACKNOWLEDGED_TELEMETRY_EVENTS} and
 *   {@link MAX_UNACKNOWLEDGED_TELEMETRY_FRAMES}: the worker's lanes ask
 *   {@link WsBridge.awaitTelemetryCapacity} before each send, and wait while
 *   the window is full. A wait that cannot be granted makes sure a barrier
 *   covers everything in flight, so an acknowledgement is always on its way.
 *   A grant reserves the batch's room until its tab's next send, so waits
 *   granted together never overfill the window; a batch larger than the
 *   window is admitted whole once nothing else is in flight;
 * - any acknowledgement renews the outstanding heartbeat ping's
 *   `SERVICE_PONG_TIMEOUT_MS` deadline: a service that is still answering is
 *   alive, however much it has queued, so the heartbeat's timeout keeps
 *   meaning "the service stopped answering", never "the service is busy". A
 *   service that stops answering altogether still times out one window
 *   after its last answer;
 * - every transport transition empties the window — what one socket carried
 *   says nothing about the next — and lets the waits proceed, so the send
 *   reports the transition the way it always did. Until the service has
 *   answered a first barrier to this bridge the window is not enforced, but
 *   barriers still go out on the same cadence — at most
 *   {@link MAX_UNPACED_TELEMETRY_BARRIERS} at once — so a heartbeat ping
 *   behind that first burst is renewed as the service works through it; from
 *   then on the window binds on every later connection too, the burst after
 *   a reconnect included.
 *
 * With the window bounded, what the service holds for this connection — and
 * so how long any frame of it waits — is bounded too, whatever the page
 * produces; the loss that remains is the lanes' and the page's, bounded and
 * reported where it happens.
 *
 * @param deps The injected transport, credential, alarm, relay and status
 * collaborators.
 * @returns The bridge.
 */
export function createWsBridge(deps: WsBridgeDeps): WsBridge {
  const log = (deps.logger ?? noopLogger).child({ component: 'ws-bridge' });
  const { alarms, relayPush, pushStatus, listBindings, tokenProvider } = deps;
  /**
   * The timers of the heartbeat and the route waits: the injected pair, or —
   * only when none was injected — the platform's, wrapped here so each global
   * is read when a timer is set, never at import.
   */
  const bridgeTimers: WorkerTimerApi = deps.timers ?? createPlatformTimers();
  /** The base URL the bridge is built with; {@link setServiceBaseUrl} replaces it. */
  const initialServiceBaseUrl = deps.serviceBaseUrl ?? DEFAULT_SERVICE_BASE_URL;

  /** The per-frame event bound, read once from the protocol's schema. */
  const frameEventLimit = readTelemetryFrameEventLimit();

  /**
   * The socket URL, validated by the protocol's loopback-only policy. A refusal
   * is the misconfigured state, never a throw: the client below records the
   * same refusal and opens nothing. Replaced by {@link setServiceBaseUrl}.
   */
  let endpoint: Result<string, DebuggenError> = resolveWsUrl(initialServiceBaseUrl);

  /**
   * The service origin the pill may display — the canonical, credential-free
   * form the policy produced, or nothing when the configured value was
   * refused (a refused value may carry a pasted credential and is never shown).
   */
  let serviceUrl: string | undefined = displayOriginOf(initialServiceBaseUrl);

  // -------------------------------------------------------------------------
  // Closure state — one bridge's, never shared
  // -------------------------------------------------------------------------

  /** Whether a devtools credential is stored, as last observed. */
  let hasCredential = false;
  /** Whether the service refused the current credential. */
  let credentialRefused = false;
  /** Whether the service's health route answered on the last probe. */
  let serviceReachable = true;
  /** On `reconnecting`: the whole milliseconds until the next attempt. */
  let retryInMs: number | undefined;
  /** Frames the socket client's queue dropped. */
  let droppedFrameCount = 0;
  /** Whether this bridge holds the keepalive alarm. */
  let keepaliveArmed = false;
  /** Whether {@link WsBridge.close} has run. */
  let disposed = false;
  /**
   * Incremented on every transition to open, so a re-announcement whose
   * binding read resolves after a newer connection opened is abandoned rather
   * than sent twice.
   */
  let openGeneration = 0;
  /** The background health probe in flight, shared by concurrent callers. */
  let probeInFlight: Promise<Result<HealthResponse, DebuggenError>> | undefined;
  /**
   * The heartbeat's pending one-shot timer, while the socket is open and the
   * next tick is waiting to run.
   */
  let heartbeatHandle: number | undefined;
  /**
   * The open generation whose tick is running right now (its alarm call or
   * its ping's answer awaited), or `undefined` between ticks and once the
   * heartbeat is stopped — so a tick in flight counts as a running heartbeat,
   * and a tick orphaned by {@link stopHeartbeat} can tell that it was.
   */
  let heartbeatTickGeneration: number | undefined;
  /**
   * The `client.ping` the running tick is waiting on, from just before it is
   * written until its answer, its deadline or {@link stopHeartbeat} ends the
   * wait.
   */
  let outstandingPing: OutstandingPing | undefined;
  /**
   * How many ticks of the current connection in a row ended with an
   * unanswered ping while the health route still answered, and without proof
   * that the service still reads the socket; reset by every answered ping, by
   * every such proof (a draining backlog, a late answer) and by every new
   * connection's heartbeat. Bounded by
   * {@link HEARTBEAT_MAX_UNANSWERED_WHILE_ALIVE}.
   */
  let unansweredWhileAlive = 0;
  /**
   * The socket's outbound buffer when the current connection's latest kept
   * tick settled: where the next unanswered tick's read-progress span starts
   * ({@link sendBufferReadProgress}). `undefined` before the first kept tick,
   * and again after every answered ping, late answer and new connection — the
   * span then starts at the ping's own write.
   */
  let keptSince: SendBufferSample | undefined;
  /**
   * The ids of the latest pings the current connection kept unanswered, oldest
   * first, at most {@link HEARTBEAT_LATE_ANSWER_MEMORY}: an answer naming one
   * of them arrives late, and proves the socket is read. Cleared by every
   * answered ping, late answer and new connection, but kept across a tick
   * whose draining backlog proved the socket read.
   */
  let keptPingIds: MessageId[] = [];
  /** The last snapshot published, serialized, so an identical one is not re-sent. */
  let lastPublishedKey: string | undefined;

  /**
   * The routing memo: which session each tab is bound to, as the service last
   * announced it on this connection (and as seeded from the persisted bindings
   * on every open). It resolves the panel a relayed frame belongs to,
   * synchronously and in arrival order. It is a hint, never an authority: it
   * is empty in a freshly revived worker until the first open, it is seeded
   * before the service has answered, and `tab-registry.ts` remains the one
   * persisted record — so telemetry is routed by {@link confirmedRoutes}
   * instead.
   */
  const sessionByTab = new Map<TabId, SessionId>();

  /**
   * The service-confirmed routes: the session the service answered each tab
   * with (`session.bound`, establishing reason) on the **current** connection.
   *
   * Deliberately separate from {@link sessionByTab}, which
   * `reannounceBindings` seeds before the service has answered: an entry here
   * is the service's own statement that its live binding table holds the pair,
   * which is what makes telemetry written along it acceptable to a service
   * that has just restarted. Emptied on every transport transition — each open
   * is a new connection generation — and on dispose.
   */
  const confirmedRoutes = new Map<TabId, SessionId>();

  /**
   * The re-announced binds awaiting the service's answer on the **current**
   * connection, keyed by the id each `session.bind` was sent with — the id the
   * service's refusal names as its `ref` (it answers a success with a
   * `session.bound`, which names the pair instead).
   *
   * This is what lets {@link handleInbound} recognise the refusal of a pair
   * whose session ended while the socket was down, and act on it
   * ({@link answerReannouncedBind}): nothing else on the connection says so.
   * An entry leaves when an `error` answers it or a `session.bound`
   * establishes its pair; the map is emptied on every transport transition —
   * an answer only ever arrives on the socket the bind was written to — and
   * on dispose. Bounded by {@link MAX_REANNOUNCED_BINDS}, the most bindings
   * one open can re-announce; the oldest entry gives way beyond it.
   */
  const reannouncedBinds = new Map<
    string,
    { readonly tabId: TabId; readonly sessionId: SessionId }
  >();

  /** The pending {@link WsBridge.awaitTabRoute} waits; each leaves the set when it settles. */
  const routeWaiters = new Set<RouteWaiter>();

  /*
   * Telemetry flow control (see the section of that name on createWsBridge).
   * The counts and barriers are the current connection's, emptied on every
   * transport transition; `peerPaced` and `capacityWaitCount` are the
   * bridge's.
   */
  /** Telemetry events and frames written on the current connection. */
  let telemetryWritten = { events: 0, frames: 0 };
  /** How much of {@link telemetryWritten} the service has acknowledged. */
  let telemetryAcknowledged = { events: 0, frames: 0 };
  /** The barrier pings written on the current connection and not yet answered, oldest first. */
  const telemetryBarriers: TelemetryBarrier[] = [];
  /** The room each granted batch holds until its tab's next send. */
  const telemetryReservations = new Map<TabId, TelemetryReservation>();
  /** The pending capacity waits, in the order they began. */
  const capacityWaiters: CapacityWaiter[] = [];
  /**
   * Whether the service has answered a barrier to this bridge. Until it has,
   * the window is not enforced — a service that answers no ping would
   * otherwise stop every tab's telemetry — and at most
   * {@link MAX_UNPACED_TELEMETRY_BARRIERS} barriers are outstanding. Once it
   * has, it is known to answer them, and the window
   * binds on every later connection of this bridge too, the burst after a
   * reconnect above all.
   */
  let peerPaced = false;
  /** Capacity waits that had to wait, since the bridge was created. */
  let capacityWaitCount = 0;

  /**
   * The socket the injected constructor built last — the client's socket for
   * as long as the client reports `open` — observed for its `readyState` and,
   * by the heartbeat, its `bufferedAmount`.
   */
  let currentSocket: WebSocketLike | undefined;

  /**
   * The UTF-8 bytes written to {@link currentSocket} since it was built: the
   * other half of a {@link SendBufferSample}, so the heartbeat can tell a
   * buffer that drained from one that merely stopped growing.
   */
  let bytesWrittenToCurrentSocket = 0;

  /**
   * The queue mirror: this module's record of the frames the socket client
   * holds in its outbound queue, oldest first, so that a frame the client
   * discards can be named — a `telemetry.event` frame by its tab, session,
   * armed capture, event count and carried loss, which
   * {@link WsBridgeDeps.onTelemetryFrameDiscarded} and
   * {@link WsBridgeDeps.onTelemetryDropped} report.
   *
   * The invariant it relies on: the client's queue is FIFO, and a frame
   * leaves it in exactly three ways —
   *
   * 1. **flushed** from the head, oldest first, right after the socket opens;
   * 2. **dropped** from the head, synchronously inside the `client.send` that
   *    took the queue over its bound, before that call returns `ok('queued')`;
   * 3. **cleared** by `client.close()`, which only {@link close} and the
   *    `not-paired` branch of {@link handlePairingState} call. A 4401 close
   *    keeps the queue.
   *
   * Every `client.send` in this module goes through {@link sendTracked}, and
   * a frame it reports `queued` is appended here, so the mirror is always the
   * tail of the queue — its entries are the last `queueMirror.length` frames
   * queued. Three rules keep it so, one per way out:
   *
   * 1. {@link settleQueueMirror}, before every tracked send and on every state
   *    change, forgets head entries while the mirror is longer than
   *    `client.queuedCount`: those frames were flushed, and are not reported;
   * 2. {@link handleQueueDrop} removes the mirror's head, which is the frame
   *    the client dropped;
   * 3. our own `client.close()` calls are preceded by reporting the mirror
   *    (credential removed — its frames are discarded) or forgetting it
   *    (dispose).
   *
   * A `client.send` added outside {@link sendTracked} would break the
   * invariant. The drop handler detects that as a type mismatch, logs it and
   * resynchronises by forgetting every entry it can no longer attribute;
   * frames queued before that point are then left unnamed (a drop of one is
   * still counted in `droppedFrameCount`), never misattributed.
   */
  const queueMirror: QueuedFrameRecord[] = [];

  // -------------------------------------------------------------------------
  // The socket client — exactly one
  // -------------------------------------------------------------------------

  /**
   * Who this connection announces itself as: the `devtools` client, and
   * deliberately **no** `tabId`. The service reads a hello's tab as "this
   * connection speaks for exactly this tab" and refuses a frame acting for any
   * other, while this one connection multiplexes every inspected tab — so no
   * tab is announced here, and each frame names the tab it acts for instead
   * (the "One socket" invariant in the module notes).
   */
  const identity: WsClientIdentity = { client: DEVTOOLS_CLIENT_KIND };

  const client = new ReconnectingWsClient({
    url: isErr(endpoint) ? initialServiceBaseUrl : endpoint.value,
    webSocketConstructor: observeSockets(
      deps.webSocketConstructor,
      (socket) => {
        currentSocket = socket;
        bytesWrittenToCurrentSocket = 0;
      },
      (socket, bytes) => {
        if (socket === currentSocket) {
          bytesWrittenToCurrentSocket += bytes;
        }
      },
    ),
    identity,
    token: tokenProvider,
    backoff: DEFAULT_WS_BACKOFF,
    timers: deps.timers,
    random: deps.random,
    logger: log,
    onStateChange: handleStateChange,
    onMessage: handleInbound,
    onProtocolError: handleProtocolError,
    onUnauthorized: handleSocketUnauthorized,
    onQueueDrop: handleQueueDrop,
  });

  /**
   * Why the configured service URL was refused, when it was — by the
   * protocol's policy, or by the caller's through {@link setServiceBaseUrl}.
   */
  let configurationError: DebuggenError | undefined = isErr(endpoint)
    ? endpoint.error
    : client.configurationError;
  if (configurationError !== undefined) {
    serviceReachable = false;
  }

  // -------------------------------------------------------------------------
  // Small accessors
  // -------------------------------------------------------------------------

  /** The shared HTTP client, dereferenced per request. */
  function resolveHttp(): HttpClient {
    const source = deps.httpClient;
    return typeof source === 'function' ? source() : source;
  }

  /**
   * Wait until the service address in force is established
   * ({@link WsBridgeDeps.serviceEndpointSettled}). Immediate when no gate was
   * supplied.
   *
   * @returns Whether it was established; `false` when the gate rejected, which
   *   leaves the bridge closed rather than falling back to any address.
   */
  async function serviceEndpointEstablished(): Promise<boolean> {
    const settled = deps.serviceEndpointSettled;
    if (settled === undefined) {
      return true;
    }
    try {
      await settled();
      return true;
    } catch (cause) {
      log.error('the service address could not be established', {
        error: cause instanceof Error ? cause.name : typeof cause,
      });
      return false;
    }
  }

  /**
   * Whether a credential is stored. Every failure reads as "no" — a store that
   * cannot answer is not a store the socket can authenticate from.
   */
  async function readCredentialPresence(): Promise<boolean> {
    const probe = deps.hasCredential;
    const outcome = await settle(
      async () => (probe === undefined ? isNonEmptyString(await tokenProvider()) : probe()),
      'UNAUTHORIZED',
    );
    if (isErr(outcome)) {
      log.warn('could not read whether a devtools credential is stored', {
        code: outcome.error.code,
      });
      return false;
    }
    return outcome.value;
  }

  /** The tabs the routing memo holds for one session. */
  function tabsBoundTo(sessionId: SessionId): TabId[] {
    const tabs: TabId[] = [];
    for (const [tabId, bound] of sessionByTab) {
      if (bound === sessionId) {
        tabs.push(tabId);
      }
    }
    return tabs;
  }

  // -------------------------------------------------------------------------
  // Status: every state is something the panel is told
  // -------------------------------------------------------------------------

  /** The pill's hint for the "Service not running" state. */
  function serviceHint(): string {
    if (configurationError !== undefined) {
      return configurationError.hint ?? SERVICE_MISCONFIGURED_HINT;
    }
    return SERVICE_NOT_RUNNING_HINT;
  }

  /** The pill's state, from the three facts `panelConnectionStatus` decides on. */
  function currentPanelStatus(): PanelConnectionStatus {
    return panelConnectionStatus({
      transport: client.state,
      paired: hasCredential && !credentialRefused,
      serviceReachable,
    });
  }

  /** The snapshot the panel renders, as things stand. */
  function buildSnapshot(): WorkerStatusSnapshot {
    const status = currentPanelStatus();
    return {
      status,
      hasCredential,
      droppedFrameCount,
      ...(serviceUrl === undefined ? {} : { serviceUrl }),
      ...(status === 'reconnecting' && retryInMs !== undefined ? { retryInMs } : {}),
      ...(status === 'service-not-running' ? { hint: serviceHint() } : {}),
    };
  }

  /**
   * Publish the current snapshot, unless it is identical to the last one
   * published. A sink that throws is logged and does not disturb the socket.
   */
  function publish(): void {
    if (disposed) {
      return;
    }
    const snapshot = buildSnapshot();
    const key = JSON.stringify(snapshot);
    if (key === lastPublishedKey) {
      return;
    }
    lastPublishedKey = key;
    try {
      pushStatus(snapshot);
    } catch (thrown) {
      log.warn('the status sink threw', { code: DebuggenError.from(thrown).code });
    }
  }

  // -------------------------------------------------------------------------
  // The socket client's hooks
  // -------------------------------------------------------------------------

  /**
   * Map every transport transition onto the panel's status, and start the
   * work each one calls for: re-announce the bindings and start the heartbeat
   * on open, probe the service on a drop, recognise a refused credential on a
   * 4401 close. Every transition away from open stops the heartbeat.
   *
   * Every transition — to `open` included, which begins a new connection
   * generation — first forgets the confirmed routes: what the service
   * confirmed on one socket proves nothing about the next (a restarted
   * service's binding table starts empty). Pending route waits keep waiting
   * for the confirmations the new connection brings. The telemetry window is
   * emptied for the same reason ({@link resetTelemetryFlow}).
   */
  function handleStateChange(state: ConnectionState, detail?: WsStateChangeDetail): void {
    confirmedRoutes.clear();
    resetTelemetryFlow();
    // A bind's answer arrives on the socket it was written to, or never.
    reannouncedBinds.clear();
    // Frames flushed since the last tracked send left the queue delivered.
    settleQueueMirror();
    if (state !== 'open') {
      stopHeartbeat();
    }
    switch (state) {
      case 'open': {
        serviceReachable = true;
        retryInMs = undefined;
        openGeneration += 1;
        log.info('connected to the local service', { client: DEVTOOLS_CLIENT_KIND });
        publish();
        startHeartbeat(openGeneration);
        void reannounceBindings(openGeneration);
        return;
      }
      case 'reconnecting': {
        retryInMs = toRetryMs(detail?.delayMs);
        log.debug('service connection dropped; reconnecting', {
          attempt: detail?.attempt,
          delayMs: retryInMs,
          code: detail?.code,
        });
        publish();
        // A drop and a stopped service look alike from the socket; the
        // auth-exempt health route tells them apart for the pill.
        void probeInBackground();
        return;
      }
      case 'connecting': {
        retryInMs = undefined;
        log.debug('connecting to the local service');
        publish();
        return;
      }
      case 'closed': {
        retryInMs = undefined;
        if (detail?.code === WS_CLOSE_UNAUTHORIZED) {
          // Recognised here, before `onUnauthorized` runs, so the pill moves
          // straight to "Not paired" rather than through "Reconnecting…".
          credentialRefused = true;
        }
        log.debug('service connection closed', { code: detail?.code });
        publish();
        return;
      }
      default:
        assertNever(state);
    }
  }

  /**
   * Every validated inbound frame, before typed dispatch: end the heartbeat's
   * wait when the frame answers its ping, keep the routing memo current, then
   * relay the frames the panel renders. Subscribers registered through
   * {@link WsBridge.subscribe} receive the frame from the client's own typed
   * dispatch, right after this.
   *
   * An `error` naming the outstanding ping is that ping's answer — the refusal
   * of a service that predates the liveness pair — and is not relayed: it is
   * about this connection's heartbeat, which no panel shows. A `service.pong`
   * is never relayed either way. One naming a ping this connection kept
   * unanswered is a late answer ({@link acceptLateAnswer}), as is an `error`
   * naming one; a pong naming neither — the answer to a ping the client queued
   * and later flushed onto a new connection — is ignored.
   *
   * Either answer is first offered to the telemetry flow control
   * ({@link acknowledgeBarrier}): the heartbeat's ping is a barrier too, and a
   * barrier's own answer is consumed there, never relayed.
   *
   * An `error` naming a re-announced bind is that bind's answer
   * ({@link answerReannouncedBind}), and is still relayed like any other
   * refusal.
   */
  function handleInbound(message: ProtocolMessage): void {
    if (message.type === MESSAGE_TYPE.SERVICE_PONG) {
      acknowledgeBarrier(message.payload.ref);
      if (!answerOutstandingPing(message.payload.ref)) {
        acceptLateAnswer(message.payload.ref);
      }
      return;
    }
    if (message.type === MESSAGE_TYPE.ERROR && message.payload.ref !== undefined) {
      const barrier = acknowledgeBarrier(message.payload.ref);
      if (answerOutstandingPing(message.payload.ref)) {
        log.debug('the local service refused the heartbeat ping; the socket answered', {
          code: message.payload.code,
        });
        return;
      }
      // A kept heartbeat ping is a barrier too: its late refusal is both.
      const late = acceptLateAnswer(message.payload.ref);
      if (barrier) {
        log.debug('the local service refused a telemetry barrier ping; the socket answered', {
          code: message.payload.code,
        });
      }
      if (barrier || late) {
        return;
      }
      answerReannouncedBind(message.payload.ref, message.payload.code);
    }
    if (message.type === MESSAGE_TYPE.SESSION_BOUND) {
      rememberBinding(message.payload);
      confirmRoute(message.payload);
      settleReannouncedBinds(message.payload);
    }
    if (isRelayedMessage(message)) {
      relay(message);
    }
  }

  /**
   * Apply the service's refusal of one re-announced `session.bind`, named by
   * the refusal's `ref`; a `ref` naming anything else is left alone.
   *
   * A {@link BindingRefusalCode} says the persisted pair names a session that
   * is over — it ended, failed or vanished while the socket was down, so its
   * `session.updated` and `cleanup.completed` never reached this connection,
   * and none of its frames ever will. The pair is forgotten here (the routing
   * memo and the confirmed route, each only while it still names that
   * session, so a newer binding of the tab is never undone), its route waits
   * fail as ended, and {@link WsBridgeDeps.onBindingRefused} is told so the
   * worker ends the persisted binding and disarms the page agent. Without
   * this the tab stayed bound to the ended session and its agent armed,
   * producing telemetry the service drops, across reloads and restarts.
   *
   * Any other code is an answer too — the entry leaves — but a transient one:
   * the pair is kept, and the next open re-announces it.
   */
  function answerReannouncedBind(ref: string, code: string): void {
    const bind = reannouncedBinds.get(ref);
    if (bind === undefined) {
      return;
    }
    reannouncedBinds.delete(ref);
    const { tabId, sessionId } = bind;
    if (!isBindingRefusalCode(code)) {
      log.debug('the local service could not re-bind a tab for now; the binding is kept', {
        tabId,
        sessionId,
        code,
      });
      return;
    }
    if (sessionByTab.get(tabId) === sessionId) {
      sessionByTab.delete(tabId);
    }
    if (confirmedRoutes.get(tabId) === sessionId) {
      confirmedRoutes.delete(tabId);
    }
    settleRouteWaiters((waiter) =>
      waiter.tabId === tabId && waiter.sessionId === sessionId
        ? err(routeFailure('TAB_NOT_BOUND', ROUTE_ENDED_MESSAGE, waiter.tabId))
        : undefined,
    );
    log.info('the local service refused a re-announced binding: its session is over', {
      tabId,
      sessionId,
      code,
    });
    const report = deps.onBindingRefused;
    if (report === undefined) {
      return;
    }
    try {
      report({ tabId, sessionId, code });
    } catch (thrown) {
      log.warn('the binding refusal sink threw', {
        tabId,
        sessionId,
        code: DebuggenError.from(thrown).code,
      });
    }
  }

  /**
   * Forget the re-announced binds a `session.bound` answered: an establishing
   * reason for a pair is the service accepting the bind that named it. An
   * ending reason answers nothing — the service sends one for its own reasons,
   * never in reply to a bind.
   */
  function settleReannouncedBinds(bound: SessionBoundPayload): void {
    if (bindingEnds(bound.reason)) {
      return;
    }
    for (const [ref, bind] of reannouncedBinds) {
      if (bind.tabId === bound.tabId && bind.sessionId === bound.sessionId) {
        reannouncedBinds.delete(ref);
      }
    }
  }

  /**
   * Apply one `session.bound` received on the open socket to the confirmed
   * routes, and settle the waits it decides.
   *
   * An establishing reason confirms the (tab, session) pair — and, since a
   * session holds one tab at a time, withdraws that session's route from any
   * other tab. An ending reason withdraws the pair if it is the one confirmed.
   * A wait for the confirmed pair succeeds; a wait for the same tab under
   * another session, for the same session under another tab, or for the pair
   * that ended fails with `TAB_NOT_BOUND`. Frames reach this only from the
   * client's current socket, so every confirmation belongs to the current
   * connection generation.
   */
  function confirmRoute(bound: SessionBoundPayload): void {
    const { tabId, sessionId } = bound;
    if (bindingEnds(bound.reason)) {
      if (confirmedRoutes.get(tabId) === sessionId) {
        confirmedRoutes.delete(tabId);
      }
      settleRouteWaiters((waiter) =>
        waiter.tabId === tabId && waiter.sessionId === sessionId
          ? err(routeFailure('TAB_NOT_BOUND', ROUTE_ENDED_MESSAGE, waiter.tabId))
          : undefined,
      );
      log.debug('the service withdrew a tab route', { tabId, sessionId, reason: bound.reason });
      return;
    }
    for (const [otherTab, otherSession] of confirmedRoutes) {
      if (otherSession === sessionId && otherTab !== tabId) {
        confirmedRoutes.delete(otherTab);
      }
    }
    confirmedRoutes.set(tabId, sessionId);
    settleRouteWaiters((waiter) => {
      if (waiter.tabId === tabId) {
        return waiter.sessionId === sessionId
          ? ok(undefined)
          : err(routeFailure('TAB_NOT_BOUND', ROUTE_ENDED_MESSAGE, waiter.tabId));
      }
      return waiter.sessionId === sessionId
        ? err(routeFailure('TAB_NOT_BOUND', ROUTE_ENDED_MESSAGE, waiter.tabId))
        : undefined;
    });
    log.debug('the service confirmed a tab route', { tabId, sessionId, reason: bound.reason });
  }

  /**
   * Settle every pending route wait `decide` has a verdict for, leaving the
   * others pending. Iterates a snapshot, because settling removes a wait.
   */
  function settleRouteWaiters(
    decide: (waiter: RouteWaiter) => Result<void, DebuggenError> | undefined,
  ): void {
    for (const waiter of [...routeWaiters]) {
      const verdict = decide(waiter);
      if (verdict !== undefined) {
        waiter.settle(verdict);
      }
    }
  }

  /** Fail every pending route wait with the failure built for its tab. */
  function failRouteWaiters(failure: (tabId: TabId) => DebuggenError): void {
    settleRouteWaiters((waiter) => err(failure(waiter.tabId)));
  }

  /**
   * Apply one `session.bound` announcement to the routing memo, with the
   * classification `tab-registry.ts` uses: an establishment records the tab
   * (and, since a session holds one tab at a time, forgets any other tab of
   * that session); a drop forgets the tab only if the memo still names the same
   * session, so a late frame about an older binding never undoes a newer one.
   */
  function rememberBinding(bound: SessionBoundPayload): void {
    if (bindingEnds(bound.reason)) {
      if (sessionByTab.get(bound.tabId) === bound.sessionId) {
        sessionByTab.delete(bound.tabId);
      }
      return;
    }
    for (const [tabId, sessionId] of sessionByTab) {
      if (sessionId === bound.sessionId && tabId !== bound.tabId) {
        sessionByTab.delete(tabId);
      }
    }
    sessionByTab.set(bound.tabId, bound.sessionId);
  }

  /**
   * Deliver one relayed frame to the panels of the tab it concerns.
   *
   * A binding announcement names its tab. Any other frame goes to the tab bound
   * to the session it is about; when the memo knows none — a frame that
   * arrives before the first binding of a worker generation is re-read — it is
   * handed on without a tab, and `relayPush`'s contract resolves the recipient
   * from the frame's session binding, never by broadcasting. Synchronous, so
   * frames reach the panel in the order the service sent them.
   */
  function relay(message: RelayedProtocolMessage): void {
    if (message.type === MESSAGE_TYPE.SESSION_BOUND) {
      pushRelayed(message, message.payload.tabId);
      return;
    }
    const sessionId = sessionIdOf(message);
    const tabs = sessionId === undefined ? [] : tabsBoundTo(sessionId);
    if (tabs.length === 0) {
      pushRelayed(message, undefined);
      return;
    }
    for (const tabId of tabs) {
      pushRelayed(message, tabId);
    }
  }

  /** Hand one frame to the relay sink, containing a sink that throws. */
  function pushRelayed(message: RelayedProtocolMessage, tabId: TabId | undefined): void {
    try {
      relayPush(message, tabId);
    } catch (thrown) {
      log.warn('the relay sink threw', {
        type: message.type,
        tabId,
        code: DebuggenError.from(thrown).code,
      });
    }
  }

  /**
   * A frame the client refused, a transport failure, or a subscriber that
   * threw: logged by code and issue paths only, and never a reason to
   * disconnect — one malformed frame is not a reason to lose a session.
   */
  function handleProtocolError(error: DebuggenError): void {
    if (error.code === 'CONFIG_INVALID') {
      serviceReachable = false;
      publish();
    }
    log.warn('the service connection reported a failure', describeFailure(error));
  }

  /** The service refused the credential (4401), or none could be resolved. */
  function handleSocketUnauthorized(detail: WsUnauthorizedDetail): void {
    log.warn('the local service refused the devtools credential', { code: detail.code });
    void refuseCredential(detail);
  }

  /**
   * Treat the current credential as refused: stop using it, tell the store,
   * and settle the panel's state on what the store did.
   *
   * The socket client has already stopped retrying (a 4401 is terminal for a
   * credential), and the keepalive will not reconnect while the refusal
   * stands. The store answering `'superseded'` — a newer credential from a
   * pairing is held and has not been presented — is the one case that
   * reconnects at once, with that credential.
   */
  async function refuseCredential(evidence: UnauthorizedEvidence): Promise<void> {
    if (disposed) {
      return;
    }
    credentialRefused = true;
    publish();
    const handled = await settle(() => deps.onUnauthorized(evidence), 'UNAUTHORIZED');
    if (disposed) {
      return;
    }
    if (isErr(handled)) {
      log.warn('the credential store failed to handle a refusal', { code: handled.error.code });
    } else if (handled.value === SUPERSEDED) {
      log.info('a newer devtools credential replaced the refused one; reconnecting');
      await connect();
      return;
    }
    // No credential the service accepts remains, so no route can be confirmed
    // until the next pairing: every pending wait learns that now rather than
    // at its deadline.
    failRouteWaiters((tabId) =>
      routeFailure('UNAUTHORIZED', ROUTE_UNAUTHORIZED_MESSAGE, tabId, { hint: ROUTE_PAIRING_HINT }),
    );
    hasCredential = await readCredentialPresence();
    publish();
  }

  /**
   * The outbound queue overflowed while the socket was down: count it and put
   * the count on the snapshot, and — when the dropped frame carried telemetry
   * — report it ({@link reportTelemetryDiscarded}): its labels and loss for the
   * service's ledger, and its events to the developer, who is shown that the
   * capture is incomplete.
   */
  function handleQueueDrop(detail: WsQueueDropDetail): void {
    droppedFrameCount += 1;
    log.warn('an outbound frame was dropped: the queue is full', {
      type: detail.type,
      queued: detail.queued,
      droppedFrameCount,
    });
    const dropped = takeDroppedRecord(detail);
    const origin = dropped?.telemetry;
    if (origin !== undefined) {
      const lostLoss =
        origin.droppedCount === undefined ? {} : { droppedCount: origin.droppedCount };
      if (origin.events === 0) {
        // A loss-only report: no event is lost with it, only the count's way
        // to the service's ledger — which the discard sink is told of, so the
        // worker can carry it again. The panels were told of that loss when
        // the page reported it, so the drop sink is not told again.
        log.warn('a queued telemetry loss report was dropped before it reached the service', {
          tabId: origin.tabId,
          ...lostLoss,
        });
      } else {
        log.warn('a queued telemetry frame was dropped before it reached the service', {
          tabId: origin.tabId,
          events: origin.events,
          ...lostLoss,
        });
      }
      reportTelemetryDiscarded(origin);
    }
    publish();
  }

  /**
   * The queue mirror's record of the frame the client just dropped, removed
   * from the mirror — or `undefined` when the mirror holds none for it.
   *
   * This runs inside `client.send`, after the client appended the frame being
   * sent and shifted its head, and before that send returns — so the mirror
   * was settled by the {@link sendTracked} that called it, and does not yet
   * hold the frame being sent. It is deliberately not settled again here: its
   * head is the queue's head as it stood before the append, which is the
   * frame that was dropped. `detail.queued` — the frames left after the drop
   * — is therefore the length the queue had before the append: a mirror
   * shorter than that does not reach the head (a resynchronisation forgot the
   * oldest entries), and the dropped frame is one it cannot name.
   *
   * An empty mirror at a drop of an empty queue is the client refusing the
   * frame being sent outright (queueing disabled); that send's `Err` reports it.
   */
  function takeDroppedRecord(detail: WsQueueDropDetail): QueuedFrameRecord | undefined {
    if (queueMirror.length < detail.queued) {
      return undefined;
    }
    const head = queueMirror.shift();
    if (head === undefined) {
      return undefined;
    }
    if (head.type !== detail.type) {
      log.warn('the outbound queue accounting lost sync; queued frames can no longer be named', {
        expected: head.type,
        type: detail.type,
        forgotten: queueMirror.length,
      });
      queueMirror.length = 0;
      return undefined;
    }
    return head;
  }

  /**
   * Hand one discarded telemetry frame's origin to both sinks, in order:
   *
   * 1. {@link WsBridgeDeps.onTelemetryFrameDiscarded} — every frame, a
   *    loss-only one included, with its labels, events and carried loss: what
   *    the service's producer-loss ledger was not told of;
   * 2. {@link WsBridgeDeps.onTelemetryDropped} — only a frame that carried
   *    events: a loss-only frame names no event the developer could be told
   *    is undelivered, and the loss it reported was shown when the page
   *    reported it.
   *
   * Each callback that throws is logged by code and contained on its own, so
   * one failing sink never keeps the other uninformed: this runs inside the
   * socket client's `send` or ahead of this module's own `close`, neither of
   * which it may unwind.
   */
  function reportTelemetryDiscarded(origin: TelemetryFrameOrigin): void {
    const discarded = deps.onTelemetryFrameDiscarded;
    if (discarded !== undefined) {
      try {
        discarded({
          tabId: origin.tabId,
          sessionId: origin.sessionId,
          ...(origin.armedCaptureId === undefined ? {} : { armedCaptureId: origin.armedCaptureId }),
          events: origin.events,
          droppedCount: origin.droppedCount ?? 0,
        });
      } catch (thrown) {
        log.warn('the telemetry discard sink threw', {
          tabId: origin.tabId,
          code: DebuggenError.from(thrown).code,
        });
      }
    }
    const report = deps.onTelemetryDropped;
    if (report === undefined || origin.events === 0) {
      return;
    }
    try {
      report(origin.tabId, origin.events);
    } catch (thrown) {
      log.warn('the telemetry drop sink threw', {
        tabId: origin.tabId,
        code: DebuggenError.from(thrown).code,
      });
    }
  }

  /**
   * Forget the queue mirror's head entries for frames the client no longer
   * holds. Drops and clears are accounted where they happen, so the only
   * other way out is the head-first flush: while the mirror is longer than
   * the queue, its oldest entries are frames the client wrote to a socket —
   * delivered, and never reported.
   */
  function settleQueueMirror(): void {
    const flushed = queueMirror.length - client.queuedCount;
    if (flushed > 0) {
      queueMirror.splice(0, flushed);
    }
  }

  /**
   * The credential was removed and the queue is about to be cleared with the
   * socket: report every telemetry frame still queued as discarded
   * ({@link reportTelemetryDiscarded}), loss-only frames included, then forget
   * the mirror. Frames flushed before now are settled away first, so only what
   * the clear really discards is reported.
   */
  function discardQueuedTelemetry(): void {
    settleQueueMirror();
    const discarded = queueMirror.splice(0);
    let frames = 0;
    let events = 0;
    let dropped = 0;
    for (const record of discarded) {
      if (record.telemetry === undefined) {
        continue;
      }
      frames += 1;
      events += record.telemetry.events;
      dropped += record.telemetry.droppedCount ?? 0;
      reportTelemetryDiscarded(record.telemetry);
    }
    if (frames > 0) {
      log.warn('queued telemetry was discarded: the devtools credential was removed', {
        frames,
        events,
        ...(dropped > 0 ? { droppedCount: dropped } : {}),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Re-announcement after a reconnect
  // -------------------------------------------------------------------------

  /**
   * Re-send `session.bind` for every persisted binding on the connection that
   * just opened.
   *
   * The service records a devtools binding against the connection, so a new
   * socket starts with none; re-announcing them is what makes a reconnect
   * invisible to the developer. Idempotent per connection: a read that
   * resolves after a newer connection opened is abandoned (that connection
   * announces for itself), and each tab is announced once. The service's
   * `session.bound` answers flow back through the normal inbound path.
   *
   * Each bind is sent with an id of its own, remembered in
   * {@link reannouncedBinds} for this connection, so a refusal — which names
   * the bind only by that id — can be tied back to the pair it refused.
   */
  async function reannounceBindings(generation: number): Promise<void> {
    const listed = await settle(listBindings, 'STORE_ERROR');
    if (isErr(listed)) {
      log.warn('could not read the persisted bindings to re-announce', {
        code: listed.error.code,
      });
      return;
    }
    if (disposed || generation !== openGeneration || client.state !== 'open') {
      return;
    }
    const announced = new Set<TabId>();
    let failed = 0;
    for (const record of listed.value) {
      if (
        !isTabId(record.tabId) ||
        announced.has(record.tabId) ||
        !isNonEmptyString(record.sessionId) ||
        !isNonEmptyString(record.url) ||
        !isNonEmptyString(record.origin)
      ) {
        continue;
      }
      announced.add(record.tabId);
      sessionByTab.set(record.tabId, record.sessionId);
      const payload: SessionBindPayload = {
        tabId: record.tabId,
        url: record.url,
        origin: record.origin,
        sessionId: record.sessionId,
      };
      const id = newMessageId();
      rememberReannouncedBind(id, record.tabId, record.sessionId);
      // Sent acting for the tab it binds, like every frame sent for a tab.
      const outcome = sendTracked(MESSAGE_TYPE.SESSION_BIND, payload, { id, tabId: record.tabId });
      if (isErr(outcome)) {
        reannouncedBinds.delete(id);
        failed += 1;
        log.warn('a binding could not be re-announced', {
          tabId: record.tabId,
          sessionId: record.sessionId,
          code: outcome.error.code,
        });
      }
    }
    log.info('re-announced the persisted tab bindings', { count: announced.size, failed });
  }

  /**
   * Remember one re-announced bind under the id it is sent with, until the
   * service answers it. Beyond {@link MAX_REANNOUNCED_BINDS} entries the
   * oldest gives way — a bind that old on one connection was answered long
   * ago, and a refusal of it that arrives anyway only goes unacted on until
   * the next open re-announces the pair.
   */
  function rememberReannouncedBind(id: string, tabId: TabId, sessionId: SessionId): void {
    while (reannouncedBinds.size >= MAX_REANNOUNCED_BINDS) {
      const oldest = reannouncedBinds.keys().next();
      if (oldest.done === true) {
        break;
      }
      reannouncedBinds.delete(oldest.value);
    }
    reannouncedBinds.set(id, { tabId, sessionId });
  }

  // -------------------------------------------------------------------------
  // Service reachability
  // -------------------------------------------------------------------------

  /**
   * Record what a health probe said about the service, and publish it. A
   * socket that is open is proof enough that the service is running, whatever
   * a late probe answers.
   */
  function applyReachability(result: Result<HealthResponse, DebuggenError>): void {
    if (disposed) {
      return;
    }
    if (isErr(result)) {
      log.info('the local service did not answer its health probe', { code: result.error.code });
    }
    serviceReachable = configurationError === undefined && (result.ok || client.state === 'open');
    publish();
  }

  /** The background probe: at most one in flight, shared by every caller. */
  function probeInBackground(): Promise<Result<HealthResponse, DebuggenError>> {
    if (probeInFlight !== undefined) {
      return probeInFlight;
    }
    const inFlight = probeService().finally(() => {
      if (probeInFlight === inFlight) {
        probeInFlight = undefined;
      }
    });
    probeInFlight = inFlight;
    return inFlight;
  }

  // -------------------------------------------------------------------------
  // Keepalive — this module's job, not the socket client's
  // -------------------------------------------------------------------------

  /**
   * Create the keepalive alarm on {@link WsBridge.connect}. Chrome's floor for
   * a packed extension is thirty seconds, `KEEPALIVE_PERIOD_MINUTES`. The only
   * other place the alarm is created is the open socket's heartbeat, which
   * re-creates it under the same name and period on every tick
   * ({@link runHeartbeatTick}); `alarms.create` replaces an alarm of that name.
   */
  function armKeepalive(): void {
    if (keepaliveArmed || disposed) {
      return;
    }
    keepaliveArmed = true;
    void settle(
      () => alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES }),
      'INTERNAL',
    ).then((created) => {
      if (isErr(created)) {
        keepaliveArmed = false;
        log.warn('the keepalive alarm could not be created', { code: created.error.code });
      }
    });
  }

  /** Clear the keepalive alarm, whoever created it. */
  async function disarmKeepalive(): Promise<void> {
    keepaliveArmed = false;
    const cleared = await settle(() => alarms.clear(KEEPALIVE_ALARM_NAME), 'INTERNAL');
    if (isErr(cleared)) {
      log.warn('the keepalive alarm could not be cleared', { code: cleared.error.code });
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat — the open socket's liveness, below the worker's idle window
  // -------------------------------------------------------------------------

  /**
   * Start the heartbeat for the connection that just opened, as `generation`.
   *
   * One one-shot timer of {@link SOCKET_HEARTBEAT_INTERVAL_MS} on the injected
   * timers, re-armed by each tick, so at most one tick is ever scheduled or
   * running and a stopped heartbeat leaves nothing behind. A heartbeat already
   * running (for an earlier connection) is stopped first.
   */
  function startHeartbeat(generation: number): void {
    stopHeartbeat();
    resetUnansweredCount();
    if (disposed) {
      return;
    }
    scheduleHeartbeatTick(generation);
  }

  /**
   * Start the count of unanswered ticks again: the socket answered, proved it
   * is read, or is a new connection. Forgets the kept pings and the span
   * start with it, so neither outlives the evidence it was kept for.
   */
  function resetUnansweredCount(): void {
    unansweredWhileAlive = 0;
    keptSince = undefined;
    keptPingIds = [];
  }

  /**
   * Remember a ping the current connection kept unanswered, so a late answer
   * naming it is recognised; only the latest
   * {@link HEARTBEAT_LATE_ANSWER_MEMORY} are kept.
   */
  function rememberKeptPing(id: MessageId): void {
    keptPingIds = [...keptPingIds, id].slice(-HEARTBEAT_LATE_ANSWER_MEMORY);
  }

  /**
   * Treat an inbound reply naming `ref` as a late answer to a ping the current
   * connection kept unanswered: proof the service read the socket at least
   * that far, which starts the unanswered count again. Logged at debug, with
   * counts only.
   *
   * @returns Whether `ref` named such a ping — the reply was the heartbeat's,
   * and has been consumed.
   */
  function acceptLateAnswer(ref: string): boolean {
    const index = keptPingIds.findIndex((id) => id === ref);
    if (index < 0) {
      return false;
    }
    log.debug('the local service answered an earlier heartbeat ping of this socket; it is read', {
      pingsBehind: keptPingIds.length - index,
      unansweredWhileAlive,
    });
    resetUnansweredCount();
    return true;
  }

  /** Schedule the next tick of the heartbeat of connection `generation`. */
  function scheduleHeartbeatTick(generation: number): void {
    heartbeatHandle = bridgeTimers.setTimeout(() => {
      heartbeatHandle = undefined;
      void runHeartbeatTick(generation);
    }, SOCKET_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop the heartbeat: cancel the scheduled tick, end the wait of an
   * outstanding ping (its deadline timer is cleared, so it neither fires nor
   * restarts anything), and orphan a tick in flight (it notices after its
   * await and neither re-arms nor restarts anything). Idempotent.
   */
  function stopHeartbeat(): void {
    if (heartbeatHandle !== undefined) {
      bridgeTimers.clearTimeout(heartbeatHandle);
      heartbeatHandle = undefined;
    }
    heartbeatTickGeneration = undefined;
    finishOutstandingPing('cancelled');
  }

  /**
   * Read the observed socket's outbound buffer: its `bufferedAmount` and the
   * bytes this bridge has written to it. `undefined` when there is no socket,
   * or it reports no finite, non-negative `bufferedAmount` — which the
   * heartbeat treats as "unknown", never as "empty".
   */
  function sampleSendBuffer(): SendBufferSample | undefined {
    const socket = currentSocket;
    const buffered = socket?.bufferedAmount;
    if (
      socket === undefined ||
      buffered === undefined ||
      !Number.isFinite(buffered) ||
      buffered < 0
    ) {
      return undefined;
    }
    return { socket, buffered, written: bytesWrittenToCurrentSocket };
  }

  /**
   * Register the tick's `client.ping` under `id` and wait for its answer: one
   * {@link SERVICE_PONG_TIMEOUT_MS} window on the bridge's timers, extended
   * window by window while the ping is still queued behind this socket's own
   * draining backlog ({@link handlePongWindowElapsed}). Registered before the
   * ping is written, so no answer can arrive unregistered, however the
   * transport schedules its events. Never rejects.
   *
   * @param beforePing The socket's outbound buffer just before the ping is
   *   written: what the ping will wait behind.
   */
  function awaitPingAnswer(
    id: MessageId,
    beforePing: SendBufferSample | undefined,
  ): Promise<HeartbeatPingResult> {
    return new Promise<HeartbeatPingResult>((resolve) => {
      const pending: OutstandingPing = {
        id,
        deadline: armPongWindow(id),
        windows: 1,
        beforePing,
        windowStart: beforePing,
        stop: undefined,
        finish: (outcome) => {
          resolve({
            outcome,
            id,
            beforePing,
            pongWindows: pending.windows,
            ...(pending.stop === undefined ? {} : { stop: pending.stop }),
          });
        },
      };
      outstandingPing = pending;
    });
  }

  /** Arm one pong window's deadline for the ping `id`. */
  function armPongWindow(id: MessageId): number {
    return bridgeTimers.setTimeout(() => {
      handlePongWindowElapsed(id);
    }, SERVICE_PONG_TIMEOUT_MS);
  }

  /**
   * A pong window of the outstanding ping `id` elapsed without an answer.
   * Grant another window when {@link decidePongWindow} finds the ping still
   * queued behind a backlog that drained over the window — logged at debug,
   * with counts only — and otherwise end the wait as `timed-out`, recording
   * why.
   */
  function handlePongWindowElapsed(id: MessageId): void {
    const pending = outstandingPing;
    if (pending?.id !== id) {
      return;
    }
    const now = sampleSendBuffer();
    const decision = decidePongWindow(
      pending.windows,
      pending.beforePing,
      pending.windowStart,
      now,
    );
    if (!decision.extend) {
      pending.stop = decision.stop;
      finishOutstandingPing('timed-out');
      return;
    }
    pending.windows += 1;
    pending.windowStart = now;
    pending.deadline = armPongWindow(id);
    log.debug(
      'the heartbeat ping is still queued behind this socket’s draining backlog; waiting another pong window',
      {
        pongWindow: pending.windows,
        maxPongWindows: HEARTBEAT_MAX_PONG_WINDOWS,
        drainedBytes: decision.drainedBytes,
        aheadBytes: decision.aheadBytes,
        bufferedBytes: decision.bufferedBytes,
      },
    );
  }

  /**
   * Give the outstanding heartbeat ping a fresh {@link SERVICE_PONG_TIMEOUT_MS}
   * window from now: the service just answered an earlier ping on this socket,
   * so it is alive, and the heartbeat's ping is merely queued behind telemetry
   * it is still storing. A service that stops answering altogether answers no
   * barrier either, and times out one window after its last answer — or after
   * the windows {@link handlePongWindowElapsed} grants a draining backlog. The
   * renewal is proof of life, not a backlog extension, so it does not count
   * toward {@link HEARTBEAT_MAX_PONG_WINDOWS}; the new window's drain is
   * measured from now.
   */
  function renewOutstandingPing(): void {
    const pending = outstandingPing;
    if (pending === undefined) {
      return;
    }
    bridgeTimers.clearTimeout(pending.deadline);
    pending.windowStart = sampleSendBuffer();
    pending.deadline = armPongWindow(pending.id);
  }

  /**
   * End the outstanding ping's wait with `outcome`, if a ping is outstanding.
   * Its current deadline timer is cleared unless it is the deadline that
   * fired.
   */
  function finishOutstandingPing(outcome: HeartbeatPingOutcome): void {
    const pending = outstandingPing;
    if (pending === undefined) {
      return;
    }
    outstandingPing = undefined;
    if (outcome !== 'timed-out') {
      bridgeTimers.clearTimeout(pending.deadline);
    }
    pending.finish(outcome);
  }

  /**
   * Treat an inbound reply that names `ref` as the outstanding ping's answer.
   *
   * @returns Whether `ref` was the outstanding ping's id — the reply was the
   * heartbeat's, and has been consumed.
   */
  function answerOutstandingPing(ref: string): boolean {
    if (outstandingPing?.id !== ref) {
      return false;
    }
    finishOutstandingPing('answered');
    return true;
  }

  /** Whether the heartbeat is running: a tick scheduled, or one in flight for the open connection. */
  function isHeartbeatActive(): boolean {
    return heartbeatHandle !== undefined || heartbeatTickGeneration === openGeneration;
  }

  /**
   * Whether a tick of connection `generation` still speaks for the socket:
   * the bridge is live, that connection is the latest one to have opened, and
   * the transport is still open.
   */
  function isHeartbeatCurrent(generation: number): boolean {
    return !disposed && generation === openGeneration && client.state === 'open';
  }

  /**
   * One heartbeat tick for connection `generation`.
   *
   * 1. Re-create the keepalive alarm. The `chrome.alarms` call is an extension
   *    API call, which resets the worker's idle timer, and re-creating the
   *    alarm pushes its next firing a full period out — so while the heartbeat
   *    runs the alarm never needs to fire, and once an evicted worker stops
   *    running the heartbeat, the alarm fires within one period and its tick
   *    revives the worker and reconnects (a dead-man switch).
   * 2. Send `client.ping` on the socket — through {@link sendTracked}, like
   *    every frame — under a freshly minted id, and wait up to
   *    `SERVICE_PONG_TIMEOUT_MS` for the `service.pong` naming it (or an
   *    `error` naming it, which {@link handleInbound} counts as the same
   *    answer). A peer that vanished without a close frame (a killed process,
   *    a suspended laptop) leaves the socket looking open; the unanswered ping
   *    is what notices. An answer schedules the next tick. No answer, a socket
   *    that cannot take the write now, a send the client refused, or a ping
   *    the client queued instead of writing retires the socket at once onto
   *    the client's jittered backoff curve through `client.restart`; the
   *    transition to `reconnecting` stops this heartbeat, probes the service
   *    for the pill, and the next open starts another heartbeat.
   *    The one wait that outlasts a window is a ping written behind this
   *    socket's own outbound backlog while the service is draining it: the
   *    socket's buffer is sampled just before the write, and each elapsed
   *    window is extended by another while {@link decidePongWindow} finds the
   *    ping still behind bytes that drained — up to
   *    {@link HEARTBEAT_MAX_PONG_WINDOWS} windows — so a busy but live service
   *    does not have its connection retired and replaced by one queued behind
   *    the same backlog.
   * 3. A ping still unanswered when its windows end is settled by
   *    {@link settleUnansweredPing}: the socket is retired only when the
   *    health route does not answer either (the service is gone or frozen),
   *    or after {@link HEARTBEAT_MAX_UNANSWERED_WHILE_ALIVE} such ticks in a
   *    row without proof that the socket is read; a service that answers is
   *    alive and reading this connection under backpressure, so the socket is
   *    kept and the next tick pings again.
   *
   * A tick orphaned by {@link stopHeartbeat} or overtaken by a newer
   * connection while it awaited does nothing further.
   */
  async function runHeartbeatTick(generation: number): Promise<void> {
    if (!isHeartbeatCurrent(generation)) {
      return;
    }
    heartbeatTickGeneration = generation;
    const rearmed = await settle(
      () => alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES }),
      'INTERNAL',
    );
    if (heartbeatTickGeneration !== generation) {
      return;
    }
    if (isErr(rearmed)) {
      log.warn('the heartbeat could not re-create the keepalive alarm', {
        code: rearmed.error.code,
      });
    } else {
      keepaliveArmed = true;
    }
    if (!isHeartbeatCurrent(generation)) {
      heartbeatTickGeneration = undefined;
      return;
    }
    if (!socketWritable()) {
      heartbeatTickGeneration = undefined;
      retireSilentSocket('the open socket cannot take the heartbeat ping; reconnecting', {
        transport: client.state,
      });
      return;
    }
    const pingId = newMessageId();
    // Sampled before the write: what is buffered now is what the ping will
    // wait behind.
    const answer = awaitPingAnswer(pingId, sampleSendBuffer());
    // Written behind whatever telemetry went before it, the ping is a barrier:
    // its answer acknowledges that telemetry too. Registered before the write,
    // like the wait; a write that fails retires the socket, and the transition
    // empties the window with the barrier in it.
    recordBarrier(pingId);
    const sent = sendTracked(MESSAGE_TYPE.CLIENT_PING, {}, { id: pingId });
    if (heartbeatTickGeneration !== generation) {
      // The write itself moved the transport off `open`, which stopped the
      // heartbeat and ended the wait.
      return;
    }
    if (isErr(sent) || sent.value === 'queued') {
      finishOutstandingPing('cancelled');
      heartbeatTickGeneration = undefined;
      retireSilentSocket(
        'the heartbeat ping was not written to the open socket; reconnecting',
        isErr(sent) ? { code: sent.error.code } : { outcome: sent.value },
      );
      return;
    }
    const result = await answer;
    if (heartbeatTickGeneration !== generation) {
      return;
    }
    heartbeatTickGeneration = undefined;
    if (!isHeartbeatCurrent(generation)) {
      return;
    }
    const { outcome } = result;
    switch (outcome) {
      case 'answered':
        resetUnansweredCount();
        scheduleHeartbeatTick(generation);
        return;
      case 'timed-out':
        await settleUnansweredPing(generation, result);
        return;
      case 'cancelled':
        return;
      default:
        assertNever(outcome);
    }
  }

  /**
   * Decide what an unanswered ping of connection `generation` means.
   *
   * 1. Measure whether the service demonstrably read this socket since the
   *    span began — the previous kept tick, or this ping's write
   *    ({@link sendBufferReadProgress}).
   * 2. Without that proof, and with
   *    {@link HEARTBEAT_MAX_UNANSWERED_WHILE_ALIVE} consecutive unanswered
   *    ticks already counted, retire the socket at once onto the backoff
   *    curve.
   * 3. Otherwise ask the auth-exempt health route whether the service answers
   *    at all. A service that does not answer retires the socket at once; one
   *    that answers keeps it — it is alive and applying backpressure to this
   *    connection, so its ping is waiting to be read — and the next tick
   *    pings again. A tick with read progress is logged as such and starts
   *    the count again; one without it is counted.
   *
   * The probe is the heartbeat's own, bounded by
   * {@link HEARTBEAT_HEALTH_TIMEOUT_MS} rather than the pill's three seconds,
   * and it refreshes the pill's reachability like every probe. A tick
   * orphaned while the probe ran (the connection ended, or the heartbeat was
   * stopped) does nothing.
   */
  async function settleUnansweredPing(
    generation: number,
    result: HeartbeatPingResult,
  ): Promise<void> {
    const fields: LogFields = {
      timeoutMs: SERVICE_PONG_TIMEOUT_MS,
      pongWindows: result.pongWindows,
      ...(result.stop === undefined ? {} : { stop: result.stop }),
    };
    const now = sampleSendBuffer();
    const readBytes = sendBufferReadProgress(keptSince ?? result.beforePing, now);
    if (readBytes === 0 && unansweredWhileAlive >= HEARTBEAT_MAX_UNANSWERED_WHILE_ALIVE) {
      resetUnansweredCount();
      retireSilentSocket('the local service did not answer the heartbeat ping; reconnecting', {
        ...fields,
        unansweredWhileAlive: HEARTBEAT_MAX_UNANSWERED_WHILE_ALIVE + 1,
      });
      return;
    }
    heartbeatTickGeneration = generation;
    // Its own probe, not the pill's shared one: this question may wait longer
    // for an answer (HEARTBEAT_HEALTH_TIMEOUT_MS). It refreshes reachability
    // all the same.
    const health = await probeService({ timeoutMs: HEARTBEAT_HEALTH_TIMEOUT_MS });
    if (heartbeatTickGeneration !== generation) {
      return;
    }
    heartbeatTickGeneration = undefined;
    if (!isHeartbeatCurrent(generation)) {
      return;
    }
    if (isErr(health)) {
      resetUnansweredCount();
      retireSilentSocket('the local service did not answer the heartbeat ping; reconnecting', {
        ...fields,
        health: health.error.code,
      });
      return;
    }
    if (readBytes > 0) {
      // Proof of reading starts the count again. The pings kept so far stay
      // remembered with this one: a late answer to any of them is still proof.
      unansweredWhileAlive = 0;
      keptSince = now;
      rememberKeptPing(result.id);
      log.info(
        'the local service is reading this socket’s backlog and has not reached its heartbeat ping yet; keeping the socket',
        {
          ...fields,
          readBytes,
          bufferedBytes: now?.buffered ?? 0,
        },
      );
      scheduleHeartbeatTick(generation);
      return;
    }
    keptSince = now;
    rememberKeptPing(result.id);
    unansweredWhileAlive += 1;
    log.info(
      'the local service answers but has not read this socket’s heartbeat ping yet; keeping the socket',
      {
        ...fields,
        unansweredWhileAlive,
        maxUnansweredWhileAlive: HEARTBEAT_MAX_UNANSWERED_WHILE_ALIVE,
      },
    );
    scheduleHeartbeatTick(generation);
  }

  /**
   * Retire the open socket onto the client's jittered backoff curve: its peer
   * left the heartbeat ping unanswered, or the socket could not carry the ping
   * at all. The record names state names, outcomes, codes and bounds only.
   */
  function retireSilentSocket(why: string, fields: LogFields): void {
    log.warn(why, fields);
    client.restart(SERVICE_STOPPED_ANSWERING_REASON);
  }

  /**
   * One keepalive tick.
   *
   * Recent Chrome versions extend a Manifest V3 worker's lifetime while a
   * WebSocket is active, and every alarm firing is itself an extension event
   * that resets the idle timer. The alarm is the belt to that brace: this tick
   * does the recovery work either way, so the design holds whether or not the
   * platform extension applies — and after an eviction the revived worker's
   * first tick is what reconnects.
   *
   * - `open`: the heartbeat owns the open socket's liveness — every transition
   *   to `open` starts it, and it re-creates this alarm every
   *   {@link SOCKET_HEARTBEAT_INTERVAL_MS}, pushing this tick a full period
   *   out — so a tick here is rare and only re-publishes the status (it is not
   *   re-sent when unchanged).
   * - `connecting`: an attempt is under way, and bounded: the socket client's
   *   opening deadline (`DEFAULT_WS_OPEN_TIMEOUT_MS`) retires an upgrade that
   *   stalls and puts it on the backoff curve, so there is nothing to do.
   * - `reconnecting`: the client's backoff timer owns the next attempt, and
   *   calling `connect()` would cancel it — so the tick only refreshes the
   *   service's reachability for the pill.
   * - `closed`: nothing is running. Reconnect — unless the credential was
   *   refused (the next pairing does that) or the service URL was refused
   *   (no attempt can succeed); `connect()` re-checks that a credential exists.
   */
  async function handleKeepaliveAlarm(alarm?: KeepaliveAlarmLike): Promise<void> {
    if (disposed || (alarm !== undefined && alarm.name !== KEEPALIVE_ALARM_NAME)) {
      return;
    }
    const state = client.state;
    switch (state) {
      case 'open':
        publish();
        return;
      case 'connecting':
        return;
      case 'reconnecting':
        await probeInBackground();
        return;
      case 'closed':
        if (credentialRefused) {
          hasCredential = await readCredentialPresence();
          publish();
          return;
        }
        if (configurationError !== undefined) {
          publish();
          return;
        }
        log.debug('keepalive found the service connection closed; reconnecting');
        await connect();
        return;
      default:
        assertNever(state);
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async function connect(): Promise<void> {
    if (disposed) {
      return;
    }
    // Nothing leaves before the address it would go to is known — not even
    // a credential-presence read that could publish "connecting" for it.
    if (!(await serviceEndpointEstablished()) || disposed) {
      return;
    }
    const present = await readCredentialPresence();
    if (disposed) {
      return;
    }
    hasCredential = present;
    if (!present) {
      log.debug('not connecting: no devtools credential is stored');
      publish();
      return;
    }
    if (configurationError !== undefined) {
      serviceReachable = false;
      log.warn(
        'not connecting: the configured service URL was refused',
        describeFailure(configurationError),
      );
      publish();
      return;
    }
    credentialRefused = false;
    armKeepalive();
    publish();
    client.connect();
  }

  async function close(): Promise<void> {
    if (disposed) {
      return;
    }
    disposed = true;
    stopHeartbeat();
    // Before the close below, whose transition would otherwise let them proceed.
    failCapacityWaiters(CAPACITY_DISPOSED_MESSAGE);
    // Disposal is the worker going away, not a loss to show: whatever is still
    // queued is forgotten unreported, and nothing is left to report it to.
    queueMirror.length = 0;
    client.close(NORMAL_CLOSURE_CODE, BRIDGE_CLOSED_REASON);
    sessionByTab.clear();
    confirmedRoutes.clear();
    reannouncedBinds.clear();
    currentSocket = undefined;
    failRouteWaiters((tabId) =>
      routeFailure('TRANSPORT_DISCONNECTED', ROUTE_DISPOSED_MESSAGE, tabId),
    );
    probeInFlight = undefined;
    await disarmKeepalive();
    log.info('the service bridge was disposed');
  }

  function handlePairingState(state: PairingState): void {
    if (disposed) {
      return;
    }
    switch (state) {
      case 'paired':
        void connect();
        return;
      case 'pairing':
        return;
      case 'not-paired':
        hasCredential = false;
        stopHeartbeat();
        if (client.state !== 'closed') {
          // `close()` clears the queue: what it discards is reported first. A
          // client already `closed` (a 4401) keeps its queue for the next pairing.
          discardQueuedTelemetry();
          client.close(NORMAL_CLOSURE_CODE, CREDENTIAL_REMOVED_REASON);
        }
        // Without a credential no route can be confirmed until the next pairing.
        failRouteWaiters((tabId) =>
          routeFailure('UNAUTHORIZED', ROUTE_NO_CREDENTIAL_MESSAGE, tabId, {
            hint: ROUTE_PAIRING_HINT,
          }),
        );
        void disarmKeepalive();
        publish();
        return;
      default:
        assertNever(state);
    }
  }

  /** See {@link WsBridge.setServiceBaseUrl}. */
  function setServiceBaseUrl(next: string | DebuggenError): void {
    if (disposed) {
      return;
    }
    if (typeof next !== 'string') {
      if (configurationError !== next) {
        refuseServiceEndpoint(next);
      }
      return;
    }
    const nextEndpoint = resolveWsUrl(next);
    if (
      configurationError === undefined &&
      !isErr(endpoint) &&
      !isErr(nextEndpoint) &&
      nextEndpoint.value === endpoint.value
    ) {
      return;
    }
    endpoint = nextEndpoint;
    serviceUrl = isErr(nextEndpoint) ? undefined : displayOriginOf(next);
    // Set before the client moves, so every transition it reports while
    // moving already renders the new configuration.
    configurationError = isErr(nextEndpoint) ? nextEndpoint.error : undefined;
    serviceReachable = configurationError === undefined;
    retryInMs = undefined;
    sessionByTab.clear();
    const moved = client.setUrl(isErr(nextEndpoint) ? next : nextEndpoint.value);
    if (isErr(moved) && configurationError === undefined) {
      configurationError = moved.error;
      serviceReachable = false;
    }
    if (configurationError === undefined) {
      log.info('the service address changed', { transport: client.state });
    } else {
      log.warn('the configured service address was refused', describeFailure(configurationError));
    }
    publish();
    if (configurationError === undefined && client.state === 'closed') {
      void connect();
    }
  }

  /**
   * Enter the misconfigured state for a refusal the caller's own policy
   * produced: close the socket (the client keeps its last address, and nothing
   * reconnects while {@link configurationError} stands — {@link connect}, the
   * keepalive and every HTTP call check it), forget the routing memo, and
   * publish "Service not running" with the refusal's hint.
   */
  function refuseServiceEndpoint(refusal: DebuggenError): void {
    endpoint = err(refusal);
    serviceUrl = undefined;
    configurationError = refusal;
    serviceReachable = false;
    retryInMs = undefined;
    sessionByTab.clear();
    if (client.state !== 'closed') {
      client.close(NORMAL_CLOSURE_CODE, SERVICE_ENDPOINT_REFUSED_REASON);
    }
    log.warn('the configured service address was refused', describeFailure(refusal));
    publish();
  }

  // -------------------------------------------------------------------------
  // Outbound frames
  // -------------------------------------------------------------------------

  /**
   * Hand one frame to the socket client — the one `client.send` call in this
   * module — keeping the queue mirror in step: settled before the send, and
   * extended by the frame when the client queued it. The outcome is the
   * client's, unchanged.
   *
   * @param telemetry For a `telemetry.event` frame: the labels, event count
   * and loss a later drop of it reports. Omitted for every other frame.
   */
  function sendTracked<K extends MessageType>(
    type: K,
    payload: MessagePayload<K>,
    options?: CreateEnvelopeOptions,
    telemetry?: TelemetryFrameOrigin,
  ): Result<SendOutcome, DebuggenError> {
    settleQueueMirror();
    const outcome = client.send(type, payload, options);
    if (!isErr(outcome) && outcome.value === 'queued') {
      queueMirror.push(telemetry === undefined ? { type } : { type, telemetry });
    }
    return outcome;
  }

  const send: ProtocolSend = (type, payload, options) => sendTracked(type, payload, options);

  const subscribe: ProtocolSubscribe = (type, handler) => client.on(type, handler);

  /**
   * The envelope wrap of AAP §0.4.2: the agent's raw `{ events }` become
   * `telemetry.event` frames, at most {@link frameEventLimit} events each, sent
   * in the order the agent produced them.
   *
   * Nothing about an event is changed — not reordered, deduplicated, re-timed,
   * redacted or attributed — and nothing about one is logged: counts, the tab
   * id and the session id only.
   *
   * Every frame is scoped: the envelope's acting `tabId` is the batch's tab and
   * its `sessionId` is that tab's session — the caller's registry-verified
   * `sessionId` when given (it survives a worker eviction), else the route the
   * service confirmed. The service checks the pair against its live binding, so
   * a batch from one of several bound tabs lands only in its own tab's capture.
   *
   * Written only along a confirmed route and only to a socket that takes the
   * write now — never handed to the socket client's reconnect queue, whose
   * flush precedes the re-announced bindings on the next connection. So the
   * batch is refused before a single frame is built when the socket is not
   * writable (`TRANSPORT_DISCONNECTED`), when no session is known or the
   * service has not confirmed the pair on this connection (`TAB_NOT_BOUND`).
   * The writability check is repeated before every chunk; should the client
   * still take one into its queue (a platform socket whose write threw), the
   * batch stops there and is reported as interrupted, the counts naming how
   * far it got — `framesWritten` and `eventsWritten` on the socket,
   * `framesQueued` and `eventsQueued` in the client's queue, which reports a
   * later discard of them itself. A resend of the whole batch is then safe:
   * the service stores events idempotently by id.
   *
   * The batch's {@link TelemetryBatchContext} rides in the payload beside
   * `events`, checked against the receiver's own schema first because that
   * schema is strict: one malformed field would refuse the whole frame, events
   * included. The two fields fail differently, by what the service does with
   * them. An `armedCaptureId` it cannot parse names no open capture, so the
   * batch is refused here — forwarding it without the field would let the
   * service file it under whichever capture is open now, the relabelling the
   * field exists to prevent. A malformed `droppedCount` is only a diagnostic,
   * so it is left out and the events still travel. A refused value is never
   * logged; the records name the tab and counts only.
   *
   * An empty batch is decided before anything else about its context: with a
   * loss above zero it is a loss-only report, and the chunk loop below — a
   * `do … while`, so it runs once for zero events — sends it as one frame
   * through the same checks, the queue mirror recording it with no events;
   * without one there is nothing the protocol would accept, and nothing is
   * sent.
   *
   * The tab's capacity reservation ({@link WsBridge.awaitTelemetryCapacity}),
   * when it holds one, is spent by the call whatever it does: what it writes
   * is counted in the window instead, frame by frame, and the waits behind it
   * are re-examined once it returns.
   */
  function sendTelemetryBatch(
    tabId: TabId,
    rawEvents: unknown,
    sessionId?: SessionId,
    context?: TelemetryBatchContext,
  ): Result<TelemetryBatchOutcome, DebuggenError> {
    const reserved = telemetryReservations.delete(tabId);
    const outcome = writeTelemetryBatch(tabId, rawEvents, sessionId, context);
    if (reserved) {
      grantCapacityWaiters();
    }
    return outcome;
  }

  /** {@link sendTelemetryBatch} without the reservation's bookkeeping. */
  function writeTelemetryBatch(
    tabId: TabId,
    rawEvents: unknown,
    sessionId?: SessionId,
    context?: TelemetryBatchContext,
  ): Result<TelemetryBatchOutcome, DebuggenError> {
    if (!isTabId(tabId)) {
      return err(
        workerError(
          'PROTOCOL_INVALID_MESSAGE',
          'A telemetry batch was refused: its tab id is not a Chrome tab id.',
        ),
      );
    }
    if (!isRawEventArray(rawEvents)) {
      return err(
        workerError(
          'PROTOCOL_INVALID_MESSAGE',
          'A telemetry batch was refused: its events are not an array.',
          { details: { tabId } },
        ),
      );
    }
    if (sessionId !== undefined && !isNonEmptyString(sessionId)) {
      return err(
        workerError(
          'PROTOCOL_INVALID_MESSAGE',
          'A telemetry batch was refused: its session id is empty.',
          { details: { tabId } },
        ),
      );
    }
    const total = rawEvents.length;
    const reportedDrop = context?.droppedCount;
    const droppedValid = reportedDrop === undefined || isDroppedCount(reportedDrop);
    // Absent means no loss was reported, so a zero is omitted rather than sent.
    const droppedCount =
      droppedValid && reportedDrop !== undefined && reportedDrop > 0 ? reportedDrop : undefined;
    if (total === 0 && droppedCount === undefined) {
      // An event-less frame can only report a loss, and the protocol refuses
      // one that reports none: there is nothing to send.
      if (!droppedValid) {
        log.warn(
          'a telemetry loss report was not sent: its count is not a whole number of events',
          {
            tabId,
          },
        );
      }
      return ok({ events: 0, frames: 0, sent: 0 });
    }
    const armedCaptureId = context?.armedCaptureId;
    if (armedCaptureId !== undefined && !isArmedCaptureId(armedCaptureId)) {
      log.warn('a telemetry batch was refused: its armed capture id is not a protocol identifier', {
        tabId,
        events: total,
      });
      return err(
        workerError(
          'PROTOCOL_INVALID_MESSAGE',
          'A telemetry batch was refused: the capture it was recorded for is not a protocol identifier.',
          { details: { tabId } },
        ),
      );
    }
    if (!droppedValid) {
      log.warn(
        'a telemetry batch loss count is not a whole number of events; it was not forwarded',
        {
          tabId,
          events: total,
        },
      );
    }
    if (!socketWritable()) {
      log.debug('a telemetry batch was not sent: the socket is not open', {
        tabId,
        events: total,
        transport: client.state,
      });
      return err(
        workerError('TRANSPORT_DISCONNECTED', TELEMETRY_NOT_CONNECTED_MESSAGE, {
          details: { tabId },
        }),
      );
    }
    const confirmed = confirmedRoutes.get(tabId);
    const routingSession = sessionId ?? confirmed;
    if (routingSession === undefined || routingSession !== confirmed) {
      log.debug('a telemetry batch was not sent: its tab route is not confirmed', {
        tabId,
        sessionId: routingSession,
        confirmedSessionId: confirmed,
        events: total,
      });
      return err(
        workerError(
          'TAB_NOT_BOUND',
          routingSession === undefined
            ? TELEMETRY_TAB_NOT_BOUND_MESSAGE
            : TELEMETRY_ROUTE_UNCONFIRMED_MESSAGE,
          { hint: TELEMETRY_TAB_NOT_BOUND_HINT, details: { tabId } },
        ),
      );
    }
    const options = { sessionId: routingSession, tabId };
    let events = 0;
    let frames = 0;
    /**
     * Stop the batch where the socket stopped taking writes, and say how far
     * it got: on the socket, and in the client's queue (`eventsQueued`, the
     * events of the one frame the client took instead of writing).
     */
    const interrupted = (
      framesQueued: number,
      eventsQueued: number,
    ): Result<TelemetryBatchOutcome, DebuggenError> => {
      log.warn('a telemetry batch was interrupted: the socket stopped accepting writes', {
        tabId,
        sessionId: routingSession,
        frames,
        events,
        framesQueued,
        remaining: total - events,
      });
      return err(
        workerError('TRANSPORT_DISCONNECTED', TELEMETRY_WRITE_INTERRUPTED_MESSAGE, {
          details: {
            tabId,
            framesWritten: frames,
            eventsWritten: events,
            framesQueued,
            eventsQueued,
          },
        }),
      );
    };
    // `do … while` rather than `for`: a loss-only report has no events and is
    // still one frame. A non-empty batch runs exactly the chunks it did before.
    let start = 0;
    do {
      // Re-checked per chunk: a frame is handed to the client only when the
      // client will write it rather than queue it.
      if (!socketWritable()) {
        return interrupted(0, 0);
      }
      const chunk = rawEvents.slice(start, start + frameEventLimit);
      // Each frame is attributed on its own, so each names the armed capture;
      // the loss belongs to the batch, so only its first frame reports it.
      const reportsLoss = start === 0 && droppedCount !== undefined;
      const payload = {
        events: chunk,
        ...(armedCaptureId === undefined ? {} : { armedCaptureId }),
        ...(reportsLoss ? { droppedCount } : {}),
      };
      // The frame's labels travel with its queue record, so a later discard
      // of it is reported under exactly the context it was sent under.
      const outcome = sendTracked(MESSAGE_TYPE.TELEMETRY_EVENT, payload, options, {
        tabId,
        sessionId: routingSession,
        ...(armedCaptureId === undefined ? {} : { armedCaptureId }),
        events: chunk.length,
        ...(reportsLoss ? { droppedCount } : {}),
      });
      if (isErr(outcome)) {
        log.warn('a telemetry frame was not sent', {
          tabId,
          sessionId: routingSession,
          frames,
          events,
          remaining: total - events,
          // The loss report travels on the first frame; failing it loses the count too.
          ...(reportsLoss ? { droppedCount } : {}),
          code: outcome.error.code,
        });
        return outcome;
      }
      if (outcome.value !== 'sent') {
        // The write itself threw on an open socket and the client queued the
        // frame; nothing more of this batch is handed over.
        return interrupted(1, chunk.length);
      }
      frames += 1;
      events += chunk.length;
      start += frameEventLimit;
      // Counted per frame, so a barrier can fall between the chunks of a
      // large batch as readily as between batches.
      noteTelemetryWritten(chunk.length, 1);
    } while (start < total);
    log.debug('forwarded a telemetry batch', {
      tabId,
      sessionId: routingSession,
      events,
      frames,
      droppedCount: droppedCount ?? 0,
    });
    return ok({ events, frames, sent: frames });
  }

  /**
   * Whether a frame handed to the client now is written rather than queued:
   * the client reports `open` and the socket it is using is OPEN. The client
   * also queues while it drains its queue after a hello, which happens inside
   * one synchronous call this module never interleaves with.
   */
  function socketWritable(): boolean {
    return (
      !disposed &&
      client.state === 'open' &&
      currentSocket?.readyState === WEBSOCKET_OPEN_READY_STATE
    );
  }

  // -------------------------------------------------------------------------
  // Telemetry flow control (see the section of that name on createWsBridge)
  // -------------------------------------------------------------------------

  /** The frames a batch of `events` is written as: at least one, a loss-only report's included. */
  function framesFor(events: number): number {
    return Math.max(1, Math.ceil(events / frameEventLimit));
  }

  /** The telemetry in the window: written and not acknowledged, plus every reservation. */
  function inFlight(): { readonly events: number; readonly frames: number } {
    let events = telemetryWritten.events - telemetryAcknowledged.events;
    let frames = telemetryWritten.frames - telemetryAcknowledged.frames;
    for (const reservation of telemetryReservations.values()) {
      events += reservation.events;
      frames += reservation.frames;
    }
    return { events, frames };
  }

  /**
   * Whether a batch of `events` written as `frames` may take the window now:
   * always while the service has not been seen to answer a barrier and while
   * nothing is in flight (a batch larger than the window is admitted whole
   * then), otherwise only within both bounds.
   */
  function windowAdmits(events: number, frames: number): boolean {
    if (!peerPaced) {
      return true;
    }
    const current = inFlight();
    if (current.events === 0 && current.frames === 0) {
      return true;
    }
    return (
      current.events + events <= MAX_UNACKNOWLEDGED_TELEMETRY_EVENTS &&
      current.frames + frames <= MAX_UNACKNOWLEDGED_TELEMETRY_FRAMES
    );
  }

  /** How much of the connection's telemetry the newest outstanding barrier covers, or the acknowledged part when none is outstanding. */
  function barrierCoverage(): { readonly events: number; readonly frames: number } {
    const newest = telemetryBarriers.at(-1);
    return newest === undefined
      ? telemetryAcknowledged
      : { events: newest.eventsThrough, frames: newest.framesThrough };
  }

  /**
   * Record the ping `id` as a barrier covering every telemetry frame written
   * on the connection so far. Called just before the ping is written, so no
   * answer can arrive unrecorded.
   */
  function recordBarrier(id: MessageId): void {
    telemetryBarriers.push({
      id,
      eventsThrough: telemetryWritten.events,
      framesThrough: telemetryWritten.frames,
    });
  }

  /**
   * Write a barrier `client.ping` behind the telemetry written so far — only
   * to a socket that takes the write now, like telemetry itself: a ping the
   * socket client queued would be answered on another connection, and
   * acknowledges nothing on this one, so it is forgotten as a barrier.
   */
  function writeBarrier(): void {
    if (!socketWritable()) {
      return;
    }
    const id = newMessageId();
    recordBarrier(id);
    const sent = sendTracked(MESSAGE_TYPE.CLIENT_PING, {}, { id });
    if (isErr(sent) || sent.value !== 'sent') {
      const index = telemetryBarriers.findIndex((barrier) => barrier.id === id);
      if (index >= 0) {
        telemetryBarriers.splice(index, 1);
      }
      log.debug('a telemetry barrier ping was not written to the open socket', {
        ...(isErr(sent) ? { code: sent.error.code } : { outcome: sent.value }),
      });
    }
  }

  /**
   * Count `events` in `frames` just written to the socket, and write a
   * barrier behind them once {@link TELEMETRY_BARRIER_EVENTS} events or
   * {@link TELEMETRY_BARRIER_FRAMES} frames have gone out since the newest
   * one — on that cadence whether or not the service is yet known to answer
   * barriers, so the answers that renew the heartbeat keep coming behind a
   * connection's first burst too; before the first answer, at most
   * {@link MAX_UNPACED_TELEMETRY_BARRIERS} are outstanding.
   */
  function noteTelemetryWritten(events: number, frames: number): void {
    telemetryWritten = {
      events: telemetryWritten.events + events,
      frames: telemetryWritten.frames + frames,
    };
    const covered = barrierCoverage();
    const due =
      telemetryWritten.events - covered.events >= TELEMETRY_BARRIER_EVENTS ||
      telemetryWritten.frames - covered.frames >= TELEMETRY_BARRIER_FRAMES;
    if (due && (peerPaced || telemetryBarriers.length < MAX_UNPACED_TELEMETRY_BARRIERS)) {
      writeBarrier();
    }
  }

  /**
   * Make sure an acknowledgement is on its way while a wait cannot be
   * granted: with telemetry in flight and no barrier outstanding to answer
   * for it, write one now. An outstanding barrier's answer re-examines the
   * waits, and covers the rest then if it must.
   */
  function coverTelemetryInFlight(): void {
    if (telemetryBarriers.length > 0) {
      return;
    }
    if (
      telemetryWritten.events > telemetryAcknowledged.events ||
      telemetryWritten.frames > telemetryAcknowledged.frames
    ) {
      writeBarrier();
    }
  }

  /**
   * Treat an inbound answer naming `ref` as the acknowledgement of that
   * barrier — and, since the service answers in order, of every older one:
   * the telemetry they cover leaves the window, the outstanding heartbeat
   * ping (when it is another ping) gets a fresh deadline, and the waits are
   * re-examined.
   *
   * @returns Whether `ref` named an outstanding barrier.
   */
  function acknowledgeBarrier(ref: string): boolean {
    const index = telemetryBarriers.findIndex((barrier) => barrier.id === ref);
    const barrier = telemetryBarriers[index];
    if (index < 0 || barrier === undefined) {
      return false;
    }
    telemetryBarriers.splice(0, index + 1);
    telemetryAcknowledged = { events: barrier.eventsThrough, frames: barrier.framesThrough };
    if (!peerPaced) {
      peerPaced = true;
      log.debug('the local service answers telemetry barriers; telemetry is paced by them', {
        maxEvents: MAX_UNACKNOWLEDGED_TELEMETRY_EVENTS,
        maxFrames: MAX_UNACKNOWLEDGED_TELEMETRY_FRAMES,
      });
    }
    if (outstandingPing !== undefined && outstandingPing.id !== ref) {
      renewOutstandingPing();
    }
    grantCapacityWaiters();
    return true;
  }

  /**
   * Grant the waits the window admits, oldest first, each reserving its room
   * before the next is examined; the first that does not fit stops the
   * examination — later waits never overtake it — and makes sure an
   * acknowledgement is coming.
   */
  function grantCapacityWaiters(): void {
    for (;;) {
      const next = capacityWaiters[0];
      if (next === undefined) {
        return;
      }
      if (!windowAdmits(next.events, next.frames)) {
        coverTelemetryInFlight();
        return;
      }
      telemetryReservations.set(next.tabId, { events: next.events, frames: next.frames });
      next.settle(ok(undefined));
    }
  }

  /** Fail every pending capacity wait with `message`. */
  function failCapacityWaiters(message: string): void {
    for (const waiter of [...capacityWaiters]) {
      waiter.settle(err(routeFailure('TRANSPORT_DISCONNECTED', message, waiter.tabId)));
    }
  }

  /**
   * Empty the window on a transport transition: what the last socket carried
   * and acknowledged says nothing about the next, and its barriers' answers,
   * should any still arrive, name nothing on it. The waits are then examined
   * against the empty window, so each proceeds to its send — which reports the
   * transition as it always did, and the lane waits for the route again.
   */
  function resetTelemetryFlow(): void {
    telemetryWritten = { events: 0, frames: 0 };
    telemetryAcknowledged = { events: 0, frames: 0 };
    telemetryBarriers.length = 0;
    telemetryReservations.clear();
    grantCapacityWaiters();
  }

  /** See {@link WsBridge.awaitTelemetryCapacity}. */
  function awaitTelemetryCapacity(
    tabId: TabId,
    events: number,
    options: TelemetryCapacityWaitOptions = {},
  ): Promise<Result<void, DebuggenError>> {
    if (!isTabId(tabId)) {
      return Promise.resolve(
        err(workerError('PROTOCOL_INVALID_MESSAGE', CAPACITY_INVALID_TAB_MESSAGE)),
      );
    }
    if (!Number.isSafeInteger(events) || events < 0) {
      return Promise.resolve(
        err(routeFailure('PROTOCOL_INVALID_MESSAGE', CAPACITY_INVALID_COUNT_MESSAGE, tabId)),
      );
    }
    if (disposed) {
      return Promise.resolve(
        err(routeFailure('TRANSPORT_DISCONNECTED', CAPACITY_DISPOSED_MESSAGE, tabId)),
      );
    }
    const { signal } = options;
    if (signal?.aborted === true) {
      return Promise.resolve(
        err(
          routeFailure('TRANSPORT_DISCONNECTED', CAPACITY_ABORTED_MESSAGE, tabId, {
            cancelled: 'aborted',
          }),
        ),
      );
    }
    // A lane forwards one batch at a time, so a new request replaces the
    // tab's unspent reservation rather than adding to it.
    telemetryReservations.delete(tabId);
    const frames = framesFor(events);
    if (capacityWaiters.length === 0 && windowAdmits(events, frames)) {
      telemetryReservations.set(tabId, { events, frames });
      return Promise.resolve(ok(undefined));
    }

    capacityWaitCount += 1;
    const current = inFlight();
    log.debug('telemetry waits for the local service to acknowledge what is in flight', {
      tabId,
      events,
      inFlightEvents: current.events,
      inFlightFrames: current.frames,
      waiting: capacityWaiters.length + 1,
    });
    const timeoutMs = resolveRouteTimeout(options.timeoutMs);
    return new Promise<Result<void, DebuggenError>>((resolve) => {
      let handle: number | undefined;
      const fail = (message: string, cancelled: RouteCancellation): void => {
        waiter.settle(err(routeFailure('TRANSPORT_DISCONNECTED', message, tabId, { cancelled })));
        // The wait that left may have been what held the ones behind it.
        grantCapacityWaiters();
      };
      const onAbort = (): void => {
        fail(CAPACITY_ABORTED_MESSAGE, 'aborted');
      };
      const waiter: CapacityWaiter = {
        tabId,
        events,
        frames,
        settle: (result) => {
          const index = capacityWaiters.indexOf(waiter);
          if (index < 0) {
            return;
          }
          capacityWaiters.splice(index, 1);
          if (handle !== undefined) {
            bridgeTimers.clearTimeout(handle);
            handle = undefined;
          }
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        },
      };
      capacityWaiters.push(waiter);
      handle = bridgeTimers.setTimeout(() => {
        handle = undefined;
        log.debug('telemetry waited for room in the window until its bound', {
          tabId,
          events,
          timeoutMs,
        });
        fail(CAPACITY_TIMED_OUT_MESSAGE, 'timeout');
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      coverTelemetryInFlight();
    });
  }

  /** See {@link WsBridge.getTelemetryFlow}. */
  function getTelemetryFlow(): TelemetryFlowStatus {
    const current = inFlight();
    return Object.freeze({
      paced: peerPaced,
      inFlightEvents: current.events,
      inFlightFrames: current.frames,
      outstandingBarriers: telemetryBarriers.length,
      waiting: capacityWaiters.length,
      waits: capacityWaitCount,
    });
  }

  /**
   * Wait until the service has confirmed `tabId` → `sessionId` on the current
   * connection (the contract is {@link WsBridge.awaitTabRoute}). Answers at
   * once when warm; otherwise registers one waiter that settles exactly once —
   * on a `session.bound` that decides it, the injected-timer bound, the
   * caller's signal, a refused credential or dispose — and releases its timer
   * and abort listener as it does.
   */
  function awaitTabRoute(
    tabId: TabId,
    sessionId: SessionId,
    options: TabRouteWaitOptions = {},
  ): Promise<Result<void, DebuggenError>> {
    if (!isTabId(tabId)) {
      return Promise.resolve(
        err(workerError('PROTOCOL_INVALID_MESSAGE', ROUTE_INVALID_TAB_MESSAGE)),
      );
    }
    if (!isNonEmptyString(sessionId)) {
      return Promise.resolve(
        err(routeFailure('PROTOCOL_INVALID_MESSAGE', ROUTE_INVALID_SESSION_MESSAGE, tabId)),
      );
    }
    if (disposed) {
      return Promise.resolve(
        err(routeFailure('TRANSPORT_DISCONNECTED', ROUTE_DISPOSED_MESSAGE, tabId)),
      );
    }
    const { signal } = options;
    if (signal?.aborted === true) {
      return Promise.resolve(
        err(
          routeFailure('TRANSPORT_DISCONNECTED', ROUTE_ABORTED_MESSAGE, tabId, {
            cancelled: 'aborted',
          }),
        ),
      );
    }
    if (credentialRefused) {
      return Promise.resolve(
        err(
          routeFailure('UNAUTHORIZED', ROUTE_UNAUTHORIZED_MESSAGE, tabId, {
            hint: ROUTE_PAIRING_HINT,
          }),
        ),
      );
    }
    // The warm case: the route is already confirmed on this connection.
    const confirmed = client.state === 'open' ? confirmedRoutes.get(tabId) : undefined;
    if (confirmed === sessionId) {
      return Promise.resolve(ok(undefined));
    }
    if (confirmed !== undefined) {
      return Promise.resolve(err(routeFailure('TAB_NOT_BOUND', ROUTE_ENDED_MESSAGE, tabId)));
    }

    const timeoutMs = resolveRouteTimeout(options.timeoutMs);
    return new Promise<Result<void, DebuggenError>>((resolve) => {
      let handle: number | undefined;
      const onAbort = (): void => {
        waiter.settle(
          err(
            routeFailure('TRANSPORT_DISCONNECTED', ROUTE_ABORTED_MESSAGE, tabId, {
              cancelled: 'aborted',
            }),
          ),
        );
      };
      const waiter: RouteWaiter = {
        tabId,
        sessionId,
        settle: (result) => {
          if (!routeWaiters.delete(waiter)) {
            return;
          }
          if (handle !== undefined) {
            bridgeTimers.clearTimeout(handle);
            handle = undefined;
          }
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        },
      };
      routeWaiters.add(waiter);
      handle = bridgeTimers.setTimeout(() => {
        handle = undefined;
        log.debug('a tab route was not confirmed in time', { tabId, sessionId, timeoutMs });
        waiter.settle(
          err(
            routeFailure('TRANSPORT_DISCONNECTED', ROUTE_TIMED_OUT_MESSAGE, tabId, {
              cancelled: 'timeout',
            }),
          ),
        );
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Relay `agent.ready` under this connection. The page agent cannot know its
   * tab, so the tab comes from the bridge port's sender — and is named twice,
   * in the payload and as the envelope's acting tab, which the protocol holds
   * equal; every other field — `documentId` and `installedBeforeReact` above
   * all, which the service's readiness gate reads — is forwarded as the agent
   * reported it. The payload is rebuilt field by field, so a key the page added
   * cannot ride along into the strict protocol schema. Its log lines name the document by
   * `fingerprintPageId` only (CWE-532): every field of the report is
   * page-supplied, and a forged `documentId` must not write into a log.
   */
  function relayAgentReady(
    tabId: TabId,
    report: PageAgentReadyPayload,
  ): Result<SendOutcome, DebuggenError> {
    if (!isTabId(tabId)) {
      return err(
        workerError(
          'PROTOCOL_INVALID_MESSAGE',
          'agent.ready was not relayed: its tab id is not a Chrome tab id.',
        ),
      );
    }
    const received: unknown = report;
    if (!isPlainRecord(received)) {
      return err(
        workerError('PROTOCOL_INVALID_MESSAGE', 'agent.ready was not relayed: it has no payload.', {
          details: { tabId },
        }),
      );
    }
    const payload: AgentReadyPayload = {
      tabId,
      documentId: report.documentId,
      producerId: report.producerId,
      url: report.url,
      installedBeforeReact: report.installedBeforeReact,
      reactDetected: report.reactDetected,
    };
    const outcome = sendTracked(MESSAGE_TYPE.AGENT_READY, payload, { tabId });
    // The document id is page-supplied, so a log line carries only its
    // fingerprint and whether it has the agent's canonical shape; the relayed
    // payload keeps the id itself, which the service's readiness gate needs.
    const documentFields = {
      document: fingerprintPageId(report.documentId),
      documentIdCanonical: isPageDocumentId(report.documentId),
    };
    if (isErr(outcome)) {
      log.warn('agent.ready was not relayed', {
        tabId,
        ...documentFields,
        code: outcome.error.code,
      });
    } else {
      log.debug('relayed agent.ready', { tabId, ...documentFields, outcome: outcome.value });
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // HTTP operations the panel consumes
  // -------------------------------------------------------------------------

  /**
   * Issue one HTTP operation through the shared client and observe its outcome.
   *
   * The client's `Result` is returned unchanged, so codes — and the capture
   * conflict's `owningSessionId` — survive to the panel. Two outcomes are also
   * observed: an `UNAUTHORIZED` failure is a refused credential, handled like
   * a 4401; and any success proves the service is running. A client (or thunk)
   * that throws is contained as `INTERNAL`, so no proxy ever rejects.
   *
   * While the service address is refused, nothing is issued: the refusal
   * itself is the answer. The shared client would refuse a base URL the
   * protocol's policy rejects on its own, but not a refusal the caller's
   * stricter rule produced ({@link WsBridge.setServiceBaseUrl}), for which the
   * client in hand is still the one for the previous address.
   */
  async function callHttp<T>(
    operation: HttpOperation,
    run: (http: HttpClient) => Promise<Result<T, DebuggenError>>,
  ): Promise<Result<T, DebuggenError>> {
    if (!(await serviceEndpointEstablished())) {
      return err(
        workerError('CONFIG_INVALID', `The ${operation} request was not issued.`, {
          hint: SERVICE_ADDRESS_UNKNOWN_HINT,
        }),
      );
    }
    if (configurationError !== undefined) {
      log.debug('a service request was not issued: the service address is refused', {
        operation,
        code: configurationError.code,
      });
      return err(configurationError);
    }
    const outcome = await settle(() => run(resolveHttp()), 'INTERNAL');
    const result: Result<T, DebuggenError> = isErr(outcome)
      ? err(
          workerError('INTERNAL', `The ${operation} request could not be issued.`, {
            cause: outcome.error,
          }),
        )
      : outcome.value;
    if (isErr(result)) {
      log.debug('a service request failed', { operation, code: result.error.code });
      if (result.error.code === 'UNAUTHORIZED') {
        void refuseCredential(result.error);
      }
      return result;
    }
    if (!serviceReachable && configurationError === undefined) {
      serviceReachable = true;
      publish();
    }
    return result;
  }

  async function probeService(
    options?: TablessCallOptions,
  ): Promise<Result<HealthResponse, DebuggenError>> {
    // Bounded by the same window the service gives a client to introduce
    // itself: a service that cannot answer its cheapest route within it is
    // not one the socket could authenticate with either.
    const result = await callHttp('health', (http) =>
      http.health({ timeoutMs: CLIENT_HELLO_TIMEOUT_MS, ...options }),
    );
    applyReachability(result);
    return result;
  }

  // Each session-scoped proxy spreads its `TabScopedCallOptions` into the
  // client's call, so the required acting tab reaches `HttpClient`, which sends
  // it as the `x-debuggen-tab` header (and refuses a value that is not a tab
  // id locally, before the credential is read).

  const queryPanelData: WsBridge['queryPanelData'] = (sessionId, request, options) =>
    callHttp('panel.data', (http) =>
      http.request('panel.data', { params: { id: sessionId }, body: request, ...options }),
    );

  const startCapture: WsBridge['startCapture'] = (sessionId, options) =>
    callHttp('capture.start', (http) => http.startCapture(sessionId, options));

  const stopCapture: WsBridge['stopCapture'] = (sessionId, options) =>
    callHttp('capture.stop', (http) =>
      http.request('capture.stop', { params: { id: sessionId }, body: {}, ...options }),
    );

  // The four reads also carry the read proof pairing issued with the
  // credential, asked for at the moment of each read — after a new pairing,
  // the proof issued with the new credential. It is read inside `callHttp`'s
  // containment, so a provider that throws is an `INTERNAL` failure, never a
  // rejection, and the value goes only to `HttpClient`.
  const currentReadProof = (): Promise<string | undefined> =>
    deps.readProofProvider === undefined ? Promise.resolve(undefined) : deps.readProofProvider();

  const getSession: WsBridge['getSession'] = (sessionId, options) =>
    callHttp('session.get', async (http) =>
      http.request('session.get', {
        params: { id: sessionId },
        ...options,
        readProof: await currentReadProof(),
      }),
    );

  const getCurrentPanel: WsBridge['getCurrentPanel'] = (sessionId, options) =>
    callHttp('panel.get', async (http) =>
      http.request('panel.get', {
        params: { id: sessionId },
        ...options,
        readProof: await currentReadProof(),
      }),
    );

  const getPanel: WsBridge['getPanel'] = (sessionId, panelId, options) =>
    callHttp('panel.getById', async (http) =>
      http.request('panel.getById', {
        params: { id: sessionId, panelId },
        ...options,
        readProof: await currentReadProof(),
      }),
    );

  const getModifications: WsBridge['getModifications'] = (sessionId, options) =>
    callHttp('modifications.list', async (http) =>
      http.request('modifications.list', {
        params: { id: sessionId },
        ...options,
        readProof: await currentReadProof(),
      }),
    );

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  function getStatus(): WsBridgeStatus {
    return {
      transport: client.state,
      panelStatus: currentPanelStatus(),
      hasCredential,
      credentialRefused,
      serviceReachable,
      configurationErrorCode: configurationError?.code,
      droppedFrameCount,
      queuedFrameCount: client.queuedCount,
      keepaliveArmed,
      heartbeatActive: isHeartbeatActive(),
      disposed,
    };
  }

  return Object.freeze({
    connect,
    close,
    handlePairingState,
    setServiceBaseUrl,
    handleKeepaliveAlarm,
    send,
    subscribe,
    sendTelemetryBatch,
    awaitTabRoute,
    awaitTelemetryCapacity,
    getTelemetryFlow,
    relayAgentReady,
    queryPanelData,
    startCapture,
    stopCapture,
    getSession,
    getCurrentPanel,
    getPanel,
    getModifications,
    probeService,
    getStatus,
    snapshot: buildSnapshot,
  });
}
