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
 *   first frame, reconnecting on the AAP §0.5.5 curve (0.5 s → 10 s), and never
 *   retrying a credential the service refused with `WS_CLOSE_UNAUTHORIZED`;
 * - the `chrome.alarms` keepalive that stops the Manifest V3 worker from being
 *   evicted while a session is live — the part of recovery the platform-neutral
 *   client deliberately leaves to this module;
 * - the envelope wrap of the page agent's **raw** event batches: the MAIN-world
 *   agent has no socket and never imports the protocol, so the worker turns its
 *   `{ events }` into `telemetry.event` frames, chunked to the protocol's bound
 *   and in the order they were produced (AAP §0.4.2);
 * - the relay of `agent.ready` under this connection, with the `tabId` the page
 *   cannot know filled in;
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
 * | service URL refused by the loopback policy | `resolveWsUrl` / `configurationError` | "Service not running" + configuration `hint` |
 * | no credential, or credential refused (4401) | credential probe, `onUnauthorized` | "Not paired" |
 * | outbound queue overflowed | `onQueueDrop` | `droppedFrameCount` on every snapshot |
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
 * - **One socket.** Per-tab attribution travels in payloads (`session.bind`,
 *   `tab.navigated`, `agent.ready` all carry `tabId`); no second socket is
 *   ever opened for a second tab, and no raw `WebSocket` is constructed here.
 * - **No sibling behaviour imports.** Only `./messages` (contracts) and
 *   `./auth` (types) are imported from this folder; `./tab-registry`,
 *   `./agent-control`, `./ports` and `./service-worker` are reached through
 *   injected functions or not at all, which keeps the folder acyclic.
 * - **Nothing secret reaches a log, an error or a snapshot.** No credential,
 *   pairing code, `Authorization` value, URL query string, event attribute or
 *   response body is written anywhere: logs carry message types, counts, tab
 *   ids, session ids, error codes and state names only. The credential is
 *   handed by reference to the two protocol clients and never read here.
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
 *   onUnauthorized: store.handleUnauthorized,
 *   hasCredential: store.hasToken,
 *   alarms: chrome.alarms,
 *   relayPush: (message, tabId) => hub.relayProtocolMessage(message, tabId),
 *   pushStatus: (snapshot) => hub.broadcastStatus(snapshot),
 *   listBindings: () => registry.list(),
 *   serviceBaseUrl: baseUrl,
 *   logger,
 * });
 * store.onStateChange(bridge.handlePairingState);
 * chrome.alarms.onAlarm.addListener((alarm) => void bridge.handleKeepaliveAlarm(alarm));
 * bridge.subscribe('agent.config', (message) => void agents.applyConfig(message.payload));
 * void bridge.connect();
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
  DataResult,
  HealthResponse,
  HttpCallOptions,
  HttpClient,
  HttpOperation,
  ModificationsResponse,
  PanelByIdResponse,
  PanelResponse,
  ProtocolMessage,
  SendOutcome,
  SessionBindPayload,
  SessionBoundPayload,
  SessionRecord,
  TelemetryEventIngress,
  TokenProvider,
  WebSocketConstructorLike,
  WsClientIdentity,
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
  parseServiceOrigin,
  ReconnectingWsClient,
  resolveWsUrl,
  telemetryEventPayloadSchema,
  WS_CLOSE_UNAUTHORIZED,
} from '@debuggen/protocol';
import type { DataQuery } from '@debuggen/panel-schema';
import type { DebuggenErrorCode, LogFields, Logger, Result, SessionId } from '@debuggen/shared';
import { assertNever, DebuggenError, err, isErr, noopLogger, ok } from '@debuggen/shared';

import type {
  PageAgentReadyPayload,
  PanelConnectionStatus,
  RelayedProtocolMessage,
} from '../shared/messages';
import { DEFAULT_SERVICE_BASE_URL, panelConnectionStatus } from '../shared/messages';
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
 * its own. It names the default address, never the refused value.
 */
const SERVICE_MISCONFIGURED_HINT = `Point Debug Generator at the local service's loopback address (the default is ${DEFAULT_SERVICE_BASE_URL}), then reload the extension.`;

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
   * The one-shot timers the socket client's backoff and credential deadline
   * run on. Omitted, the client uses the platform timers, resolved at call
   * time; this module never calls a global timer itself.
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
   * The local service's base URL. Defaults to `DEFAULT_SERVICE_BASE_URL`.
   * Validated by the protocol's loopback-only policy; a refused value is the
   * "Service not running" state with a configuration hint, never a throw.
   */
  readonly serviceBaseUrl?: string | undefined;

  /**
   * The currently primary inspected tab, when one is known — announced as the
   * optional `tabId` of each `client.hello`. Read at every handshake.
   */
  readonly primaryTabId?: (() => number | undefined) | undefined;

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
  /** Whether {@link WsBridge.close} has run. */
  readonly disposed: boolean;
};

/**
 * What {@link WsBridge.sendTelemetryBatch} did with one raw batch.
 *
 * Counts only — never an event, so the value is safe to log.
 */
export interface TelemetryBatchOutcome {
  /** How many events the batch held and were handed to the socket client. */
  readonly events: number;
  /** How many `telemetry.event` frames they were wrapped into. */
  readonly frames: number;
  /** How many of those frames were written to an open socket. */
  readonly sent: number;
  /** How many were queued for the next connection. */
  readonly queued: number;
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
   * Wrap one raw agent batch into `telemetry.event` frames and send them under
   * this connection, chunked to the protocol's per-frame bound and in order.
   *
   * @param tabId The tab the batch came from (the bridge port's sender).
   * @param rawEvents The agent's `events` array, exactly as it arrived.
   * @returns The counts, or the first send failure; earlier chunks of the
   * same batch have been sent or queued by then.
   */
  readonly sendTelemetryBatch: (
    tabId: TabId,
    rawEvents: unknown,
  ) => Result<TelemetryBatchOutcome, DebuggenError>;

  /**
   * Relay the page agent's `agent.ready` report to the service with the
   * `tabId` the page cannot know filled in; every other field is forwarded
   * intact.
   */
  readonly relayAgentReady: (
    tabId: TabId,
    report: PageAgentReadyPayload,
  ) => Result<SendOutcome, DebuggenError>;

  /**
   * `POST /sessions/:id/panel-data`: resolve one panel node's `DataQuery`. The
   * `DataResult` is forwarded verbatim — paging echo included; the service owns
   * the default and maximum limits.
   */
  readonly queryPanelData: (
    sessionId: SessionId,
    query: DataQuery,
    options?: HttpCallOptions,
  ) => Promise<Result<DataResult, DebuggenError>>;

  /**
   * `POST /sessions/:id/capture/start`. A capture already held by another
   * session is the `Err` whose code is `CAPTURE_ALREADY_ACTIVE` and whose
   * details name the owning session — read it with {@link captureConflictOwner}.
   */
  readonly startCapture: (
    sessionId: SessionId,
    options?: HttpCallOptions,
  ) => Promise<Result<CaptureStartResponse, DebuggenError>>;

  /** `POST /sessions/:id/capture/stop`: close the window, answer its summary. */
  readonly stopCapture: (
    sessionId: SessionId,
    options?: HttpCallOptions,
  ) => Promise<Result<CaptureStopResponse, DebuggenError>>;

  /** `GET /sessions/:id`: the session record. */
  readonly getSession: (
    sessionId: SessionId,
    options?: HttpCallOptions,
  ) => Promise<Result<SessionRecord, DebuggenError>>;

  /** `GET /sessions/:id/panel`: the session's current panel, or `null`. */
  readonly getCurrentPanel: (
    sessionId: SessionId,
    options?: HttpCallOptions,
  ) => Promise<Result<PanelResponse, DebuggenError>>;

  /** `GET /sessions/:id/panels/:panelId`: one specific panel version. */
  readonly getPanel: (
    sessionId: SessionId,
    panelId: string,
    options?: HttpCallOptions,
  ) => Promise<Result<PanelByIdResponse, DebuggenError>>;

  /** `GET /sessions/:id/modifications`: the session's modification journal. */
  readonly getModifications: (
    sessionId: SessionId,
    options?: HttpCallOptions,
  ) => Promise<Result<ModificationsResponse, DebuggenError>>;

  /**
   * `GET /health`, auth-exempt: whether the service is running. The outcome
   * also updates the bridge's reachability, and therefore the pill.
   */
  readonly probeService: (
    options?: HttpCallOptions,
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

/**
 * Build the bridge. Pure construction: the socket client is created but not
 * connected, no alarm is created, nothing is read from storage and nothing is
 * published until a member is called — `service-worker.ts` calls
 * {@link WsBridge.connect}.
 *
 * @param deps The injected transport, credential, alarm, relay and status
 * collaborators.
 * @returns The bridge.
 */
export function createWsBridge(deps: WsBridgeDeps): WsBridge {
  const log = (deps.logger ?? noopLogger).child({ component: 'ws-bridge' });
  const { alarms, relayPush, pushStatus, listBindings, tokenProvider } = deps;
  const serviceBaseUrl = deps.serviceBaseUrl ?? DEFAULT_SERVICE_BASE_URL;

  /** The per-frame event bound, read once from the protocol's schema. */
  const frameEventLimit = readTelemetryFrameEventLimit();

  /**
   * The socket URL, validated by the protocol's loopback-only policy. A refusal
   * is the misconfigured state, never a throw: the client below records the
   * same refusal and opens nothing.
   */
  const endpoint = resolveWsUrl(serviceBaseUrl);

  /**
   * The service origin the pill may display — the canonical, credential-free
   * form the policy produced, or nothing when the configured value was
   * refused (a refused value may carry a pasted credential and is never shown).
   */
  const displayOrigin = parseServiceOrigin(serviceBaseUrl);
  const serviceUrl: string | undefined = isErr(displayOrigin) ? undefined : displayOrigin.value;

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
  /** The last snapshot published, serialized, so an identical one is not re-sent. */
  let lastPublishedKey: string | undefined;

  /**
   * The routing memo: which session each tab is bound to, as the service last
   * announced it on this connection (and as seeded from the persisted bindings
   * on every open). It resolves the panel a relayed frame belongs to and the
   * routing key a tab's telemetry frames carry, synchronously and in arrival
   * order. It is a hint, never an authority — the service attributes by its
   * own binding — and `tab-registry.ts` remains the one persisted record.
   */
  const sessionByTab = new Map<TabId, SessionId>();

  // -------------------------------------------------------------------------
  // The socket client — exactly one
  // -------------------------------------------------------------------------

  /**
   * Who this connection announces itself as. `tabId` is a getter because the
   * client reads the identity at every handshake: each reconnect announces the
   * tab that is primary *then*, and omits the field while none is known.
   */
  const identity: WsClientIdentity = {
    client: DEVTOOLS_CLIENT_KIND,
    get tabId(): TabId | undefined {
      return currentPrimaryTabId();
    },
  };

  const client = new ReconnectingWsClient({
    url: isErr(endpoint) ? serviceBaseUrl : endpoint.value,
    webSocketConstructor: deps.webSocketConstructor,
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

  /** Why the configured service URL was refused, when it was. */
  const configurationError: DebuggenError | undefined = isErr(endpoint)
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

  /** The primary inspected tab, when the injected reader knows a valid one. */
  function currentPrimaryTabId(): TabId | undefined {
    const read = deps.primaryTabId;
    if (read === undefined) {
      return undefined;
    }
    try {
      const tabId = read();
      return isTabId(tabId) ? tabId : undefined;
    } catch {
      return undefined;
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
   * work each one calls for: re-announce the bindings on open, probe the
   * service on a drop, recognise a refused credential on a 4401 close.
   */
  function handleStateChange(state: ConnectionState, detail?: WsStateChangeDetail): void {
    switch (state) {
      case 'open': {
        serviceReachable = true;
        retryInMs = undefined;
        openGeneration += 1;
        log.info('connected to the local service', {
          client: DEVTOOLS_CLIENT_KIND,
          tabId: currentPrimaryTabId(),
        });
        publish();
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
   * Every validated inbound frame, before typed dispatch: keep the routing memo
   * current, then relay the frames the panel renders. Subscribers registered
   * through {@link WsBridge.subscribe} receive the frame from the client's own
   * typed dispatch, right after this.
   */
  function handleInbound(message: ProtocolMessage): void {
    if (message.type === 'session.bound') {
      rememberBinding(message.payload);
    }
    if (isRelayedMessage(message)) {
      relay(message);
    }
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
    if (message.type === 'session.bound') {
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
    hasCredential = await readCredentialPresence();
    publish();
  }

  /**
   * The outbound queue overflowed while the socket was down: count it and put
   * the count on the snapshot, so the developer can see that data was lost.
   */
  function handleQueueDrop(detail: WsQueueDropDetail): void {
    droppedFrameCount += 1;
    log.warn('an outbound frame was dropped: the queue is full', {
      type: detail.type,
      queued: detail.queued,
      droppedFrameCount,
    });
    publish();
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
      const outcome = client.send('session.bind', payload);
      if (isErr(outcome)) {
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
   * Create the keepalive alarm — the one place it is created. Chrome's floor
   * for a packed extension is thirty seconds, `KEEPALIVE_PERIOD_MINUTES`.
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
   * - `open`: the connection is healthy; only the status is re-published (it is
   *   not re-sent when unchanged).
   * - `connecting`: an attempt is under way; nothing to do.
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
    client.close(NORMAL_CLOSURE_CODE, BRIDGE_CLOSED_REASON);
    sessionByTab.clear();
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
        if (client.state !== 'closed') {
          client.close(NORMAL_CLOSURE_CODE, CREDENTIAL_REMOVED_REASON);
        }
        void disarmKeepalive();
        publish();
        return;
      default:
        assertNever(state);
    }
  }

  // -------------------------------------------------------------------------
  // Outbound frames
  // -------------------------------------------------------------------------

  const send: ProtocolSend = (type, payload, options) => client.send(type, payload, options);

  const subscribe: ProtocolSubscribe = (type, handler) => client.on(type, handler);

  /**
   * The envelope wrap of AAP §0.4.2: the agent's raw `{ events }` become
   * `telemetry.event` frames, at most {@link frameEventLimit} events each, sent
   * in the order the agent produced them.
   *
   * Nothing about an event is changed — not reordered, deduplicated, re-timed,
   * redacted or attributed — and nothing about one is logged: counts and the
   * tab id only. The frame carries the tab's bound session as its routing key
   * when the memo knows it, so the service can route a batch from one of
   * several bound tabs; attribution itself stays the service's.
   */
  function sendTelemetryBatch(
    tabId: TabId,
    rawEvents: unknown,
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
    const total = rawEvents.length;
    if (total === 0) {
      // The protocol refuses an empty batch as a no-op; there is nothing to send.
      return ok({ events: 0, frames: 0, sent: 0, queued: 0 });
    }
    const sessionId = sessionByTab.get(tabId);
    const options = sessionId === undefined ? undefined : { sessionId };
    let events = 0;
    let frames = 0;
    let sent = 0;
    let queued = 0;
    for (let start = 0; start < total; start += frameEventLimit) {
      const chunk = rawEvents.slice(start, start + frameEventLimit);
      const outcome = client.send('telemetry.event', { events: chunk }, options);
      if (isErr(outcome)) {
        log.warn('a telemetry frame was not sent', {
          tabId,
          frames,
          events,
          remaining: total - events,
          code: outcome.error.code,
        });
        return outcome;
      }
      frames += 1;
      events += chunk.length;
      if (outcome.value === 'sent') {
        sent += 1;
      } else {
        queued += 1;
      }
    }
    log.debug('forwarded a telemetry batch', { tabId, events, frames, sent, queued });
    return ok({ events, frames, sent, queued });
  }

  /**
   * Relay `agent.ready` under this connection. The page agent cannot know its
   * tab, so the tab comes from the bridge port's sender; every other field —
   * `documentId` and `installedBeforeReact` above all, which the service's
   * readiness gate reads — is forwarded as the agent reported it. The payload
   * is rebuilt field by field, so a key the page added cannot ride along into
   * the strict protocol schema.
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
    const outcome = client.send('agent.ready', payload);
    if (isErr(outcome)) {
      log.warn('agent.ready was not relayed', {
        tabId,
        documentId: report.documentId,
        code: outcome.error.code,
      });
    } else {
      log.debug('relayed agent.ready', {
        tabId,
        documentId: report.documentId,
        outcome: outcome.value,
      });
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
   */
  async function callHttp<T>(
    operation: HttpOperation,
    run: (http: HttpClient) => Promise<Result<T, DebuggenError>>,
  ): Promise<Result<T, DebuggenError>> {
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
    options?: HttpCallOptions,
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

  const queryPanelData: WsBridge['queryPanelData'] = (sessionId, query, options) =>
    callHttp('panel.data', (http) =>
      http.request('panel.data', { params: { id: sessionId }, body: query, ...options }),
    );

  const startCapture: WsBridge['startCapture'] = (sessionId, options) =>
    callHttp('capture.start', (http) => http.startCapture(sessionId, options));

  const stopCapture: WsBridge['stopCapture'] = (sessionId, options) =>
    callHttp('capture.stop', (http) =>
      http.request('capture.stop', { params: { id: sessionId }, body: {}, ...options }),
    );

  const getSession: WsBridge['getSession'] = (sessionId, options) =>
    callHttp('session.get', (http) =>
      http.request('session.get', { params: { id: sessionId }, ...options }),
    );

  const getCurrentPanel: WsBridge['getCurrentPanel'] = (sessionId, options) =>
    callHttp('panel.get', (http) =>
      http.request('panel.get', { params: { id: sessionId }, ...options }),
    );

  const getPanel: WsBridge['getPanel'] = (sessionId, panelId, options) =>
    callHttp('panel.getById', (http) =>
      http.request('panel.getById', { params: { id: sessionId, panelId }, ...options }),
    );

  const getModifications: WsBridge['getModifications'] = (sessionId, options) =>
    callHttp('modifications.list', (http) =>
      http.request('modifications.list', { params: { id: sessionId }, ...options }),
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
      disposed,
    };
  }

  return Object.freeze({
    connect,
    close,
    handlePairingState,
    handleKeepaliveAlarm,
    send,
    subscribe,
    sendTelemetryBatch,
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
