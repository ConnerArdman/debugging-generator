/**
 * The service worker's runtime-port registry and router.
 *
 * ## What this module is
 *
 * Three kinds of `chrome.runtime.Port` connect to the Manifest V3 service
 * worker, one per channel named in `../shared/messages`:
 *
 * - `PORT_PANEL` — a DevTools panel document. It speaks request/response RPC
 *   (`PortRequest` → `PortResponse`, one kind per capability the panel has)
 *   and receives `PortPush` frames. The panel never holds a socket and never
 *   calls `fetch` (AAP §0.4.2, §0.1.2), so this port is its **only**
 *   transport: `panelData.query` is how `../panel/data-provider.ts` reaches
 *   `POST /sessions/:id/panel-data`, `source.open` is how a `SourceLink` click
 *   reaches the editor, and so on (AAP §0.7.1 Group 4).
 * - `PORT_CONTENT_BRIDGE` — the isolated-world content script of one local app
 *   tab. Upstream it carries the page agent's frames (`agent.ready`,
 *   `telemetry.batch`, `target.described`, `agent.error`); downstream it
 *   carries `agent.config`, `agent.snapshot` and `target.request`.
 * - `PORT_DEVTOOLS` — the devtools page of one DevTools window. It announces
 *   the inspected tab (`devtools.hello`) and the Elements panel's selection
 *   (`devtools.element`); its disconnect is the "DevTools closed" signal.
 *
 * {@link createPortHub} classifies each connecting port, validates its sender,
 * keeps a registry of live connections with per-tab indexes, dispatches
 * inbound frames to injected handler maps, correlates request/response
 * traffic in both directions (panel → worker RPCs, worker → bridge round
 * trips), fans pushes out per tab, and cleans up on disconnect.
 *
 * ## What it deliberately does not do
 *
 * - **No I/O of its own.** No `fetch`, no `WebSocket`, no `chrome.alarms`, no
 *   `chrome.tabs`, no storage. Every capability behind a port request is an
 *   injected handler; `service-worker.ts` is the only module that knows which
 *   implementation (`ws-bridge.ts`, `tab-registry.ts`, `agent-control.ts`,
 *   `auth.ts`) stands behind which handler.
 * - **No sibling imports.** This module imports `./messages` and
 *   `../shared/messages` only, never `./ws-bridge`, `./tab-registry`,
 *   `./agent-control` or `./service-worker` — the wiring direction is
 *   downward, which is what keeps the background folder acyclic.
 * - **No interpretation of traffic.** Telemetry batches are forwarded as they
 *   came (the envelope wrap and the `MAX_EVENTS_PER_BATCH` chunking are
 *   `ws-bridge.ts`'s), readiness is `agent-control.ts`'s decision, and whether
 *   a panel disconnect warrants `session.unbind` is `tab-registry.ts`'s. This
 *   module attaches attribution (tab, connection, document) and routes.
 * - **No import-time side effect.** The factory registers nothing:
 *   `service-worker.ts` calls `chrome.runtime.onConnect.addListener(
 *   hub.handleConnect)`. All state lives inside the factory closure, so two
 *   hubs in one test share nothing.
 *
 * ## Worker suspension
 *
 * A Manifest V3 worker is evicted after roughly thirty seconds idle, and every
 * port dies with it. Everything held here is therefore **ephemeral by design**:
 * a revived worker starts with an empty registry, and each surface reconnects
 * its own port (the panel and devtools page with backoff, the bridge on its
 * next frame). Nothing here is persisted; state that must survive a
 * suspension — the tab ↔ session binding — lives in `chrome.storage.session`,
 * owned by `tab-registry.ts`. Every pending correlation (panel RPC, bridge
 * round trip) is bounded by an injected timer and settled on disconnect, so no
 * promise and no panel spinner outlives the port it depended on (AAP §0.5.5).
 *
 * ## Privacy
 *
 * No log line written here contains a credential, a pairing code, a request
 * or response payload, raw telemetry or a page URL. Logs carry identifiers
 * (connection id, tab id, request kind, request id), counts and error codes
 * only. The `pair.complete` request is routed like any other and its payload
 * (the one-time code) is never read by this module (AAP §0.5.6).
 *
 * Governed by AAP §0.7.1 Group 4 ("port routing between panel, bridge and
 * service"; the panel's `DataProvider` "over a runtime port to the SW, which
 * proxies `POST /sessions/:id/panel-data`"), §0.4.2 (process boundaries),
 * §0.5.5 (observable recovery states) and §0.2.3 (one definition per
 * cross-process type — every frame type below is imported, never restated).
 *
 * @example
 * ```ts
 * const hub = createPortHub({
 *   runtime: chrome.runtime,
 *   timers: { setTimeout: (handler, ms) => setTimeout(handler, ms), clearTimeout },
 *   logger,
 *   handlers,       // one async handler per panel request kind
 *   bridgeHandlers, // one handler per upstream bridge frame type
 *   events: { onPanelDisconnected: ({ connection }) => … },
 * });
 * chrome.runtime.onConnect.addListener(hub.handleConnect);
 * ```
 *
 * @module apps/chrome-extension/src/background/ports
 */

import type { SessionBindPayload } from '@debuggen/protocol';
import { toErrorPayload } from '@debuggen/protocol';
import type { DebuggenErrorCode, Logger, Result, SessionId } from '@debuggen/shared';
import { assertNever, DebuggenError, noopLogger, nowEpochMs } from '@debuggen/shared';

import type {
  AgentOutboundType,
  BridgeDownstreamMessage,
  BridgeDownstreamType,
  BridgeUpstreamMessage,
  BridgeUpstreamPayloads,
  DevtoolsDownstreamMessage,
  DevtoolsUpstreamPayloads,
  DevtoolsUpstreamType,
  ExtensionPortName,
  PageTargetDescribedPayload,
  PanelConnectionState,
  PortConnectionPush,
  PortFailureResponse,
  PortProtocolPush,
  PortPush,
  PortRequest,
  PortRequestFrame,
  PortRequestId,
  PortRequestKind,
  PortRequestPayloads,
  PortResponsePayloads,
  PortSuccessResponse,
  RelayedProtocolMessage,
} from '../shared/messages';
import {
  AGENT_OUTBOUND_TYPES,
  DEVTOOLS_UPSTREAM_MESSAGE_TYPES,
  EXTENSION_CHANNEL,
  isBridgeUpstreamMessage,
  isDevtoolsUpstreamMessage,
  isExtensionPortName,
  isPortRequest,
  newPortRequestId,
  PORT_CONTENT_BRIDGE,
  PORT_DEVTOOLS,
  PORT_PANEL,
  PORT_PROTOCOL_VERSION,
  PORT_REQUEST_KINDS,
} from '../shared/messages';

import type {
  BridgeConnection,
  BridgeSend,
  DevtoolsConnection,
  DevtoolsSend,
  PanelConnection,
  PortPushSink,
  RelayPush,
  WorkerConnection,
  WorkerConnectionId,
  WorkerStatusSink,
  WorkerStatusSnapshot,
  WorkerTimerApi,
} from './messages';
import {
  isBridgeMessageOfKind,
  isPortRequestOfMethod,
  portErr,
  portOk,
  workerError,
} from './messages';

/*
 * ===========================================================================
 * Section A — derived primitives and constants
 * ===========================================================================
 */

/** A Chrome tab id, exactly as the protocol's binding payloads type it. */
type TabId = SessionBindPayload['tabId'];

/** A wall-clock instant in Unix epoch milliseconds, as `nowEpochMs` returns it. */
type EpochMs = ReturnType<typeof nowEpochMs>;

/**
 * How long a panel request may take before the panel is answered with a typed
 * timeout failure, in milliseconds.
 *
 * Every panel request is served by a handler that proxies a loopback HTTP call
 * or a socket send to the local service, so twenty seconds is generous for a
 * healthy service and short enough that a hung handler becomes an
 * `ErrorState` with a retry action instead of an indefinite spinner
 * (AAP §0.5.5: every state must be observable). Overridable per hub through
 * {@link PortHubDeps.requestTimeoutMs}.
 */
export const PORT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * How long a worker → bridge round trip ({@link PortHub.requestFromBridge})
 * waits for the page agent's correlated answer, in milliseconds.
 *
 * The agent answers a `target.request` synchronously inside its `message`
 * dispatch, so five seconds only elapses when the page is frozen, navigating
 * or has no agent — all of which the caller treats as "agent not ready".
 * Overridable per hub through {@link PortHubDeps.bridgeRequestTimeoutMs}.
 */
export const BRIDGE_REQUEST_TIMEOUT_MS = 5_000;

/**
 * The hostnames a content-script bridge may connect from: the two spellings of
 * the loopback dev server that the manifest's `host_permissions`
 * (`http://localhost/*`, `http://127.0.0.1/*`) grant. Kept in lockstep with
 * `LOCAL_APP_ORIGINS` in `manifest.config.ts`, which this module cannot
 * import (it is a Node-side build config). Any port is accepted, as the
 * manifest's match patterns accept any port.
 */
const LOCAL_APP_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1'];

/** The only URL scheme the manifest's host permissions cover. */
const LOCAL_APP_PROTOCOL = 'http:';

/** The URL scheme of this extension's own pages. */
const EXTENSION_PAGE_PROTOCOL = 'chrome-extension:';

/** The short prefix of each role's connection ids, for readable logs. */
const CONNECTION_ID_PREFIXES: Readonly<Record<ExtensionPortName, string>> = Object.freeze({
  [PORT_PANEL]: 'panel',
  [PORT_CONTENT_BRIDGE]: 'bridge',
  [PORT_DEVTOOLS]: 'devtools',
});

/**
 * Fails to compile unless its argument is exactly `true` — the drift-assertion
 * helper `./messages` and `@debuggen/protocol` declare for the same purpose.
 */
type AssertTrue<Assertion extends true> = Assertion;

/*
 * ===========================================================================
 * Section B — the injection surface
 * ===========================================================================
 */

/**
 * The slice of `chrome.runtime` the hub reads: the extension's own id (to
 * recognise its own pages and content scripts) and `lastError` (read inside
 * `onDisconnect` so an error-caused disconnect never surfaces as an
 * "Unchecked runtime.lastError" warning).
 *
 * `chrome.runtime` itself satisfies it — {@link ChromeRuntimeSatisfiesPortHubRuntime}
 * proves that at compile time — and a test passes `{ id: 'test-extension' }`.
 * `onConnect` is deliberately not part of it: the hub registers no listener.
 */
export interface PortHubRuntime {
  /** This extension's id, as `MessageSender.id` reports it. */
  readonly id: string;
  /** Set by the platform while an error-caused callback runs. */
  readonly lastError?: { readonly message?: string | undefined } | undefined;
}

/**
 * Compile-time proof that the real `chrome.runtime` namespace is assignable to
 * {@link PortHubRuntime}: if `@types/chrome` changes `id` or `lastError`
 * incompatibly, the argument becomes `false` and `tsc -b` fails here rather
 * than at the wiring in `service-worker.ts`. Type-level only.
 */
export type ChromeRuntimeSatisfiesPortHubRuntime = AssertTrue<
  typeof chrome.runtime extends PortHubRuntime ? true : false
>;

/**
 * What a panel request handler is told besides the payload.
 *
 * - `connectionId` — the panel connection that asked. A panel port does not
 *   know its inspected tab at connect time (its `sender` never names the
 *   inspected tab — a DevTools panel has no tab at all, and a panel page
 *   opened directly in a tab names only its own — and no panel request
 *   payload carries one), so a handler that learns the tab —
 *   for example the `session.snapshot` handler, from the tab bound to the
 *   named session — calls {@link PortHub.bindPanelTab} with this id.
 * - `tabId` — the tab this panel is bound to, when it is.
 * - `signal` — aborted when the request times out or the panel disconnects,
 *   with the typed `DebuggenError` as its `reason`; pass it to any
 *   cancellable work (an `HttpClient` call) so abandoned work stops.
 */
export interface PortRequestContext {
  /** The panel connection that sent the request. */
  readonly connectionId: WorkerConnectionId;
  /** The panel's inspected tab, once bound. */
  readonly tabId: TabId | undefined;
  /** Aborted on timeout or panel disconnect. */
  readonly signal: AbortSignal;
}

/**
 * The handler for one panel request kind: an async function from that kind's
 * request payload to a `Result` of its response payload.
 *
 * An expected failure (the service refused, the tab is not bound, the capture
 * is held by another session) is an `err(DebuggenError)`, never a throw. A
 * throw or rejection is still answered — as an `INTERNAL` failure — because
 * the panel must receive exactly one response per request.
 */
export type PortRequestHandler<Kind extends PortRequestKind> = (
  payload: PortRequestPayloads[Kind],
  context: PortRequestContext,
) => Promise<Result<PortResponsePayloads[Kind], DebuggenError>>;

/**
 * Exactly one handler per panel request kind, derived mechanically from the
 * imported `PortRequestKind` vocabulary — so a kind added to
 * `../shared/messages` is a compile error at every handler map (a missing
 * property) and in {@link createPortHub}'s dispatch (an unhandled `never`),
 * never a request that silently goes unanswered.
 */
export type PortRequestHandlers = {
  readonly [Kind in PortRequestKind]: PortRequestHandler<Kind>;
};

/**
 * What a bridge frame handler is told besides the payload. Attribution comes
 * from the bridge port's `sender`, never from the page-originated payload.
 */
export interface BridgeMessageContext {
  /** The bridge connection the frame arrived on. */
  readonly connectionId: WorkerConnectionId;
  /** The tab the bridge runs in, from the port's `sender.tab.id`. */
  readonly tabId: TabId;
  /** The page agent's per-document id, once its `agent.ready` has arrived. */
  readonly documentId: BridgeConnection['documentId'];
}

/**
 * The handler for one upstream bridge frame type. It may be synchronous or
 * asynchronous; a throw or rejection is caught and logged by code only.
 */
export type BridgeMessageHandler<Type extends AgentOutboundType> = (
  payload: BridgeUpstreamPayloads[Type],
  context: BridgeMessageContext,
) => void | Promise<void>;

/**
 * Exactly one handler per upstream bridge frame type, derived mechanically
 * from the imported `AgentOutboundType` vocabulary.
 *
 * A `target.described` that answers a {@link PortHub.requestFromBridge} round
 * trip settles that round trip and is **not** also dispatched here; every
 * other `target.described` (an answer to a fire-and-forget `target.request`)
 * is.
 */
export type BridgeMessageHandlers = {
  readonly [Type in AgentOutboundType]: BridgeMessageHandler<Type>;
};

/**
 * What a devtools-page frame handler is told besides the payload.
 */
export interface DevtoolsMessageContext {
  /** The devtools connection the frame arrived on. */
  readonly connectionId: WorkerConnectionId;
  /** The inspected tab this devtools page announced. */
  readonly tabId: TabId;
}

/**
 * The handler for one upstream devtools-page frame type. It may be synchronous
 * or asynchronous; a throw or rejection is caught and logged by code only.
 */
export type DevtoolsMessageHandler<Type extends DevtoolsUpstreamType> = (
  payload: DevtoolsUpstreamPayloads[Type],
  context: DevtoolsMessageContext,
) => void | Promise<void>;

/**
 * Exactly one handler per upstream devtools-page frame type, derived
 * mechanically from the imported `DevtoolsUpstreamType` vocabulary.
 *
 * The hub records the announced tab itself (so {@link PortHub.sendToDevtools}
 * can address the page) before the handler runs.
 */
export type DevtoolsMessageHandlers = {
  readonly [Type in DevtoolsUpstreamType]: DevtoolsMessageHandler<Type>;
};

/**
 * Why a connection left the registry.
 *
 * - `remote-disconnect` — the other end went away: the panel or devtools page
 *   closed (or reloaded), the page navigated, or the extension was reloaded.
 *   For a devtools or panel port this is the "DevTools closed" candidate that
 *   `tab-registry.ts` weighs for `session.unbind` (AAP §0.2.3).
 * - `send-failed` — posting to the port threw, which means its page is gone;
 *   the hub treats it exactly like a disconnect.
 * - `disposed` — the worker itself tore the connection down through
 *   {@link PortHub.disposeAll} (tests, credential rotation). Never a signal
 *   that DevTools closed.
 */
export const PORT_CLOSE_REASONS = ['remote-disconnect', 'send-failed', 'disposed'] as const;

/** One of {@link PORT_CLOSE_REASONS}. */
export type PortCloseReason = (typeof PORT_CLOSE_REASONS)[number];

/** A connection that left the registry, reported through {@link PortHubEvents}. */
export interface PortClosedEvent<Connection extends WorkerConnection = WorkerConnection> {
  /** The connection's last descriptor (its bound tab included). */
  readonly connection: Connection;
  /** Why it left. */
  readonly reason: PortCloseReason;
  /** Whether `chrome.runtime.lastError` was set when the disconnect fired. */
  readonly lastErrorReported: boolean;
}

/** A lifecycle callback; a throw or rejection is caught and logged by code only. */
type HubCallback<Argument> = (argument: Argument) => void | Promise<void>;

/**
 * Lifecycle notifications, each optional. The hub only **reports**: deciding
 * that a panel disconnect is a DevTools close that warrants `session.unbind`
 * belongs to `tab-registry.ts`, and refreshing a panel's status after it
 * connects belongs to `service-worker.ts`.
 */
export interface PortHubEvents {
  /** A port passed classification and sender validation and was registered. */
  readonly onConnected?: HubCallback<WorkerConnection> | undefined;
  /** A panel connection left the registry. */
  readonly onPanelDisconnected?: HubCallback<PortClosedEvent<PanelConnection>> | undefined;
  /** A devtools-page connection left the registry. */
  readonly onDevtoolsDisconnected?: HubCallback<PortClosedEvent<DevtoolsConnection>> | undefined;
  /** A content-script bridge connection left the registry. */
  readonly onBridgeDisconnected?: HubCallback<PortClosedEvent<BridgeConnection>> | undefined;
}

/**
 * Resolve the tab bound to a session, for routing a relayed protocol frame
 * that names a session but was handed over without a tab
 * (see {@link PortHub.relayPush}). Supplied by `service-worker.ts` over
 * `tab-registry.ts`; synchronous or asynchronous; `undefined` means "not
 * bound", and the frame is then withheld rather than broadcast.
 */
export type SessionTabResolver = (
  sessionId: SessionId,
) => TabId | undefined | Promise<TabId | undefined>;

/** Everything {@link createPortHub} is handed. */
export interface PortHubDeps {
  /** `chrome.runtime`, or a test fake with the extension's id. */
  readonly runtime: PortHubRuntime;
  /** One-shot timers for the bounded waits (the protocol's `TimerApi`). */
  readonly timers: WorkerTimerApi;
  /** One async handler per panel request kind. */
  readonly handlers: PortRequestHandlers;
  /** One handler per upstream bridge frame type. */
  readonly bridgeHandlers: BridgeMessageHandlers;
  /**
   * One handler per upstream devtools-page frame type. Optional: without it
   * the hub still records each devtools page's announced tab, so
   * {@link PortHub.sendToDevtools} works, and drops the frames otherwise.
   */
  readonly devtoolsHandlers?: DevtoolsMessageHandlers | undefined;
  /** Lifecycle notifications. */
  readonly events?: PortHubEvents | undefined;
  /** The session → tab lookup behind {@link PortHub.relayPush}. */
  readonly resolveTabForSession?: SessionTabResolver | undefined;
  /** Where diagnostics go; defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;
  /** The epoch-millisecond clock stamping `connectedAt`; defaults to `nowEpochMs`. */
  readonly now?: (() => EpochMs) | undefined;
  /** Panel request timeout; defaults to {@link PORT_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number | undefined;
  /** Bridge round-trip timeout; defaults to {@link BRIDGE_REQUEST_TIMEOUT_MS}. */
  readonly bridgeRequestTimeoutMs?: number | undefined;
}

/**
 * The worker → bridge frame types whose answer the page agent correlates by
 * `requestId`: only `target.request`, answered by `target.described`.
 *
 * `agent.snapshot` is deliberately absent: the agent answers it by emitting a
 * component-tree snapshot through its ordinary telemetry flow, not with a
 * correlated reply, so it is sent with {@link PortHub.sendToBridge}.
 */
export type BridgeRoundTripType = Extract<BridgeDownstreamType, 'target.request'>;

/** Per-call options of {@link PortHub.requestFromBridge}. */
export interface BridgeRequestOptions {
  /** Overrides the hub's bridge round-trip timeout, in milliseconds. */
  readonly timeoutMs?: number | undefined;
}

/**
 * The hub. Every member is a function-valued property rather than a method,
 * so each can be handed to another module unbound — `hub.handleConnect` to
 * `chrome.runtime.onConnect.addListener`, `hub.pushToPanels` as a
 * `PortPushSink`, `hub.sendToBridge` as a `BridgeSend`.
 */
export interface PortHub {
  /**
   * The `chrome.runtime.onConnect` listener: classify the port by name,
   * validate its sender, register it and install its listeners. A port that
   * fails either check is disconnected immediately.
   */
  readonly handleConnect: (port: chrome.runtime.Port) => void;

  /**
   * Late-bind a panel connection to its inspected tab, so it starts receiving
   * that tab's pushes. Rebinding to another tab moves it.
   *
   * @returns `false` when no panel connection has that id (it is gone, or is
   * not a panel) or the tab id is not a tab.
   */
  readonly bindPanelTab: (connectionId: WorkerConnectionId, tabId: TabId) => boolean;

  /**
   * Deliver a push to every panel bound to one tab — a `PortPushSink`.
   *
   * @returns How many panels took it; `0` (no panel attached) is normal.
   */
  readonly pushToPanels: (tabId: TabId, push: PortPush) => number;

  /**
   * Deliver a push to every connected panel, bound or not — for worker-wide
   * state such as the connection pill ("Reconnecting…", "Not paired",
   * "Service not running").
   *
   * Also accepts a `WorkerStatusSnapshot`, so this member is itself a
   * `WorkerStatusSink`: the snapshot's connection fields become one
   * `connection` push ({@link connectionPushFromStatus}). Its tab-scoped
   * fields — the binding, the session — are never broadcast.
   *
   * @returns How many panels took it.
   */
  readonly broadcastToPanels: (value: PortPush | WorkerStatusSnapshot) => number;

  /**
   * Forward one relayed protocol frame to panels — a `RelayPush`.
   *
   * With a `tabId`, that tab's panels receive it. Without one, the frame's
   * session (its envelope `sessionId`, else its payload's `sessionId` or
   * `session.id`) is resolved to its bound tab through
   * {@link PortHubDeps.resolveTabForSession}; a frame whose session resolves
   * to no tab is withheld — session data never reaches panels of unrelated
   * tabs. Only a frame that names no session at all (a connection-level
   * `error`) is delivered to every panel. Delivery order equals call order.
   */
  readonly relayPush: RelayPush;

  /**
   * Send one frame to the content-script bridge of one tab — a `BridgeSend`.
   *
   * @returns `false` when no bridge is attached for that tab (page not loaded,
   * mid-navigation, or not a local app origin) or its port turned out dead —
   * a recoverable state `agent-control.ts` resolves on the next `agent.ready`.
   */
  readonly sendToBridge: (tabId: TabId, message: BridgeDownstreamMessage) => boolean;

  /**
   * A worker-initiated round trip to one tab's page agent: send
   * `target.request` with a fresh correlation id and resolve with the
   * matching `target.described` payload.
   *
   * Rejects with a typed `DebuggenError` — `AGENT_NOT_READY` when no bridge is
   * attached or the agent does not answer in time, `TRANSPORT_DISCONNECTED`
   * when the bridge disconnects first — so no promise outlives its port.
   */
  readonly requestFromBridge: (
    tabId: TabId,
    type: BridgeRoundTripType,
    options?: BridgeRequestOptions,
  ) => Promise<PageTargetDescribedPayload>;

  /**
   * Send one frame to the devtools page inspecting one tab — a `DevtoolsSend`.
   *
   * @returns `false` when no devtools page has announced that tab.
   */
  readonly sendToDevtools: (tabId: TabId, message: DevtoolsDownstreamMessage) => boolean;

  /** Whether a content-script bridge is attached for a tab. */
  readonly hasBridge: (tabId: TabId) => boolean;

  /** The current descriptor of one connection, when it is still registered. */
  readonly getConnection: (connectionId: WorkerConnectionId) => WorkerConnection | undefined;

  /** Every registered connection's current descriptor. */
  readonly listConnections: () => readonly WorkerConnection[];

  /**
   * Disconnect every port, settle every pending correlation with a typed
   * error, and clear the registry. Reported with reason `disposed`.
   */
  readonly disposeAll: () => void;
}

/**
 * Compile-time proof that the hub's members satisfy the worker-internal
 * contracts of `./messages` they are handed out as, so `service-worker.ts`
 * can pass them with no adapter. Type-level only.
 */
export type PortHubSatisfiesWorkerContracts = [
  AssertTrue<PortHub['pushToPanels'] extends PortPushSink ? true : false>,
  AssertTrue<PortHub['broadcastToPanels'] extends WorkerStatusSink ? true : false>,
  AssertTrue<PortHub['broadcastToPanels'] extends (push: PortPush) => void ? true : false>,
  AssertTrue<PortHub['relayPush'] extends RelayPush ? true : false>,
  AssertTrue<PortHub['sendToBridge'] extends BridgeSend ? true : false>,
  AssertTrue<PortHub['sendToDevtools'] extends DevtoolsSend ? true : false>,
];

/*
 * ===========================================================================
 * Section C — pure helpers
 * ===========================================================================
 */

/**
 * The `connection` push that carries a worker status snapshot's connection
 * fields — `status`, and `retryInMs` / `serviceUrl` when set — and nothing
 * else. The snapshot's `hasCredential`, `hint`, binding and session fields
 * stay in the worker: a broadcast reaches panels of every tab, and the panel
 * obtains the rest through its `session.snapshot` request.
 *
 * @param snapshot The worker's current status.
 * @returns A push that passes `isPortPush`.
 */
export function connectionPushFromStatus(snapshot: WorkerStatusSnapshot): PortConnectionPush {
  const state: PanelConnectionState = {
    status: snapshot.status,
    ...(snapshot.retryInMs === undefined ? {} : { retryInMs: snapshot.retryInMs }),
    ...(snapshot.serviceUrl === undefined ? {} : { serviceUrl: snapshot.serviceUrl }),
  };
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'push',
    kind: 'connection',
    state,
  };
}

/** A plain object — not `null`, not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string with at least one character. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** A Chrome tab id: a non-negative safe integer (`-1` is `TAB_ID_NONE`). */
function isTabId(value: unknown): value is TabId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Parse a URL without throwing. */
function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Whether a serialized origin is a local app origin the manifest's host
 * permissions cover: `http:` on `localhost` or `127.0.0.1`, any port.
 */
function isLocalAppOrigin(origin: string): boolean {
  const parsed = parseUrl(origin);
  return (
    parsed !== undefined &&
    parsed.protocol === LOCAL_APP_PROTOCOL &&
    LOCAL_APP_HOSTNAMES.includes(parsed.hostname)
  );
}

/**
 * The shape of a `Result`, checked at run time: a handler typed to return one
 * can still return anything if it was written in plain JavaScript or cast.
 */
function isResultShape(value: unknown): value is Result<unknown, unknown> {
  return isRecord(value) && (value.ok === true ? 'value' in value : value.ok === false);
}

/**
 * Validate a configured timeout, or take the default.
 *
 * @throws DebuggenError `CONFIG_INVALID` for a non-positive or non-finite
 * value — a wiring defect that must fail loudly at construction.
 */
function resolveTimeout(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new DebuggenError('CONFIG_INVALID', `${name} must be a positive number of milliseconds.`);
  }
  return value;
}

/**
 * Throw `CONFIG_INVALID` when a handler map lacks a function for any member of
 * its vocabulary — the run-time counterpart of the mapped types, for a map
 * assembled in plain JavaScript or through a cast.
 */
function assertCompleteHandlers(
  name: string,
  vocabulary: readonly string[],
  handlers: Readonly<Record<string, unknown>>,
): void {
  const missing = vocabulary.filter((member) => typeof handlers[member] !== 'function');
  if (missing.length > 0) {
    throw new DebuggenError('CONFIG_INVALID', `${name} is missing handlers.`, {
      details: { missing },
    });
  }
}

/** Why a connecting port's sender was refused, for the debug log. */
type SenderRefusal =
  | 'no-sender'
  | 'foreign-extension'
  | 'extension-page-in-tab'
  | 'not-extension-page'
  | 'no-tab'
  | 'sub-frame'
  | 'no-origin'
  | 'not-local-origin';

/** The outcome of validating a bridge port's sender. */
type BridgeSenderVerdict =
  | { readonly accepted: true; readonly tabId: TabId }
  | { readonly accepted: false; readonly reason: SenderRefusal };

/** Where a relayed protocol frame goes. */
type RelayTarget =
  | { readonly kind: 'tab'; readonly tabId: TabId }
  | { readonly kind: 'broadcast' }
  | { readonly kind: 'withheld'; readonly reason: string };

/** The broadcast relay target, shared. */
const BROADCAST_TARGET: RelayTarget = Object.freeze({ kind: 'broadcast' });

/**
 * The session a relayed frame concerns: its envelope `sessionId`, else a
 * `sessionId` on its payload, else the `id` of a `session` record on its
 * payload (`session.created` / `session.updated`).
 *
 * Read for routing only — to keep session data away from panels of unrelated
 * tabs — never to interpret the frame.
 */
function relaySessionId(message: RelayedProtocolMessage): SessionId | undefined {
  if (isNonEmptyString(message.sessionId)) {
    return message.sessionId;
  }
  const payload: unknown = message.payload;
  if (!isRecord(payload)) {
    return undefined;
  }
  if (isNonEmptyString(payload.sessionId)) {
    return payload.sessionId;
  }
  const session = payload.session;
  return isRecord(session) && isNonEmptyString(session.id) ? session.id : undefined;
}

/**
 * The request id and kind of a frame that is framed as a panel request of the
 * current version but failed `isPortRequest` (a malformed payload) — enough
 * to answer it with a typed failure instead of leaving the panel waiting.
 */
function addressableRequest(
  value: unknown,
): { readonly requestId: PortRequestId; readonly kind: PortRequestKind } | undefined {
  if (
    !isRecord(value) ||
    value.channel !== EXTENSION_CHANNEL ||
    value.version !== PORT_PROTOCOL_VERSION ||
    value.direction !== 'request' ||
    !isNonEmptyString(value.requestId)
  ) {
    return undefined;
  }
  const requestId = value.requestId;
  const kind = PORT_REQUEST_KINDS.find((candidate) => candidate === value.kind);
  return kind === undefined ? undefined : { requestId, kind };
}

/** Disconnect a port without letting a dead port's throw escape. */
function safeDisconnect(port: chrome.runtime.Port): void {
  try {
    port.disconnect();
  } catch {
    // Already disconnected: `disconnect()` on a dead port has nothing to undo.
  }
}

/** The code of whatever a callback threw or rejected with, for the log. */
function failureCode(cause: unknown): DebuggenErrorCode {
  return DebuggenError.from(cause).code;
}

/*
 * ===========================================================================
 * Section D — the factory
 * ===========================================================================
 */

/** A panel request the hub is serving: what cancels it. */
interface PendingPanelRequest {
  /** Settle the request without answering, aborting its handler's signal. */
  readonly cancel: (reason: DebuggenError) => void;
}

/** A worker → bridge round trip awaiting its correlated answer. */
interface PendingBridgeRequest {
  /** The bridge connection the request was sent on; only it may answer. */
  readonly connectionId: WorkerConnectionId;
  /** Settle with the agent's answer. */
  readonly resolve: (payload: PageTargetDescribedPayload) => void;
  /** Settle with a typed failure. */
  readonly reject: (error: DebuggenError) => void;
}

/**
 * Create the worker's port hub.
 *
 * Registers nothing and touches no `chrome.*` API: the caller attaches
 * {@link PortHub.handleConnect} to `chrome.runtime.onConnect`. Every piece of
 * state — the registry, the per-tab indexes, the pending correlations — lives
 * in this closure.
 *
 * @param deps The injected runtime slice, timers, handler maps and options.
 * @returns The hub.
 * @throws DebuggenError `CONFIG_INVALID` when a handler map is incomplete or a
 * timeout is not a positive number — wiring defects, reported at construction.
 */
export function createPortHub(deps: PortHubDeps): PortHub {
  const { runtime, timers, handlers, bridgeHandlers, devtoolsHandlers, events } = deps;
  const resolveTabForSession = deps.resolveTabForSession;
  const now = deps.now ?? nowEpochMs;
  const log = (deps.logger ?? noopLogger).child({ module: 'background/ports' });
  const requestTimeoutMs = resolveTimeout(
    deps.requestTimeoutMs,
    PORT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs',
  );
  const bridgeRequestTimeoutMs = resolveTimeout(
    deps.bridgeRequestTimeoutMs,
    BRIDGE_REQUEST_TIMEOUT_MS,
    'bridgeRequestTimeoutMs',
  );

  assertCompleteHandlers('handlers', PORT_REQUEST_KINDS, handlers);
  assertCompleteHandlers('bridgeHandlers', AGENT_OUTBOUND_TYPES, bridgeHandlers);
  if (devtoolsHandlers !== undefined) {
    assertCompleteHandlers('devtoolsHandlers', DEVTOOLS_UPSTREAM_MESSAGE_TYPES, devtoolsHandlers);
  }

  /** Every live connection, by id. The descriptor is replaced, never mutated. */
  const connections = new Map<WorkerConnectionId, WorkerConnection>();
  /** Tab → the panel connections bound to it. */
  const panelsByTab = new Map<TabId, Set<WorkerConnectionId>>();
  /** Tab → its current content-script bridge. */
  const bridgeByTab = new Map<TabId, WorkerConnectionId>();
  /** Tab → the devtools page that announced it. */
  const devtoolsByTab = new Map<TabId, WorkerConnectionId>();
  /** Connection → the function that removes its port listeners. */
  const detachers = new Map<WorkerConnectionId, () => void>();
  /** Panel connection → its in-flight requests, by request id. */
  const panelRequests = new Map<WorkerConnectionId, Map<PortRequestId, PendingPanelRequest>>();
  /** Worker → bridge round trips awaiting an answer, by request id. */
  const bridgeRequests = new Map<PortRequestId, PendingBridgeRequest>();

  /** The last connection sequence number minted by this hub. */
  let connectionSequence = 0;
  /** Relayed frames queued behind an asynchronous session lookup. */
  let relaysInFlight = 0;
  /** The tail of the relay queue: resolves when every queued relay is delivered. */
  let relayTail: Promise<void> = Promise.resolve();

  // -------------------------------------------------------------------------
  // Registry primitives
  // -------------------------------------------------------------------------

  /** Mint a connection id: monotonic within this hub, opaque to everyone else. */
  function mintConnectionId(role: ExtensionPortName): WorkerConnectionId {
    connectionSequence += 1;
    return `${CONNECTION_ID_PREFIXES[role]}-${String(connectionSequence)}`;
  }

  /** Add a connection to the per-tab index of its role, when it has a tab. */
  function indexConnection(connection: WorkerConnection): void {
    switch (connection.role) {
      case PORT_PANEL: {
        if (connection.tabId === undefined) {
          return;
        }
        const panels = panelsByTab.get(connection.tabId) ?? new Set<WorkerConnectionId>();
        panels.add(connection.connectionId);
        panelsByTab.set(connection.tabId, panels);
        return;
      }
      case PORT_CONTENT_BRIDGE:
        bridgeByTab.set(connection.tabId, connection.connectionId);
        return;
      case PORT_DEVTOOLS:
        if (connection.tabId !== undefined) {
          devtoolsByTab.set(connection.tabId, connection.connectionId);
        }
        return;
      default:
        assertNever(connection);
    }
  }

  /**
   * Remove a connection from its per-tab index. An index entry is removed only
   * when it still points at this connection — a newer bridge or devtools page
   * for the same tab keeps its entry — so no entry outlives its port and no
   * late disconnect evicts a live successor.
   */
  function unindexConnection(connection: WorkerConnection): void {
    switch (connection.role) {
      case PORT_PANEL: {
        if (connection.tabId === undefined) {
          return;
        }
        const panels = panelsByTab.get(connection.tabId);
        if (panels === undefined) {
          return;
        }
        panels.delete(connection.connectionId);
        if (panels.size === 0) {
          panelsByTab.delete(connection.tabId);
        }
        return;
      }
      case PORT_CONTENT_BRIDGE:
        if (bridgeByTab.get(connection.tabId) === connection.connectionId) {
          bridgeByTab.delete(connection.tabId);
        }
        return;
      case PORT_DEVTOOLS:
        if (
          connection.tabId !== undefined &&
          devtoolsByTab.get(connection.tabId) === connection.connectionId
        ) {
          devtoolsByTab.delete(connection.tabId);
        }
        return;
      default:
        assertNever(connection);
    }
  }

  /** Replace a registered connection's descriptor, re-indexing it. */
  function replaceConnection(previous: WorkerConnection, next: WorkerConnection): void {
    unindexConnection(previous);
    connections.set(next.connectionId, next);
    indexConnection(next);
  }

  /**
   * Run an injected callback so that neither a synchronous throw nor an
   * asynchronous rejection escapes into the port's event dispatch or becomes
   * an unhandled rejection. Only the failure's code is logged.
   */
  function invokeSafely<Argument, Context>(
    label: string,
    callback: (argument: Argument, context: Context) => void | Promise<void>,
    argument: Argument,
    context: Context,
  ): void {
    const report = (cause: unknown): void => {
      log.error('port hub callback failed', { callback: label, code: failureCode(cause) });
    };
    try {
      const outcome = callback(argument, context);
      if (outcome instanceof Promise) {
        outcome.catch(report);
      }
    } catch (cause) {
      report(cause);
    }
  }

  /** Run an optional lifecycle callback through {@link invokeSafely}. */
  function emit<Argument>(
    label: string,
    callback: HubCallback<Argument> | undefined,
    argument: Argument,
  ): void {
    if (callback !== undefined) {
      invokeSafely(label, (value: Argument) => callback(value), argument, undefined);
    }
  }

  /**
   * Post a frame to a registered connection. A port whose page has gone
   * throws on `postMessage`; that is treated exactly as a disconnect, so the
   * registry never keeps a connection nothing can be delivered to.
   *
   * @returns `true` when the port took the frame.
   */
  function postFrame(connectionId: WorkerConnectionId, frame: object): boolean {
    const connection = connections.get(connectionId);
    if (connection === undefined) {
      return false;
    }
    try {
      connection.port.postMessage(frame);
      return true;
    } catch {
      log.debug('post to a dead port; closing it', {
        role: connection.role,
        connectionId,
      });
      closeConnection(connectionId, 'send-failed', false);
      return false;
    }
  }

  /**
   * Remove a connection from the registry and every index, settle everything
   * pending on it with a typed error, detach its listeners, and report it.
   * Idempotent: a second call for the same id does nothing.
   */
  function closeConnection(
    connectionId: WorkerConnectionId,
    reason: PortCloseReason,
    lastErrorReported: boolean,
  ): void {
    const connection = connections.get(connectionId);
    if (connection === undefined) {
      return;
    }
    connections.delete(connectionId);
    unindexConnection(connection);
    detachers.get(connectionId)?.();
    detachers.delete(connectionId);

    const pendingPanel = panelRequests.get(connectionId);
    panelRequests.delete(connectionId);
    if (pendingPanel !== undefined) {
      const abandoned = workerError(
        'TRANSPORT_DISCONNECTED',
        'The panel disconnected before its request completed.',
      );
      for (const pending of [...pendingPanel.values()]) {
        pending.cancel(abandoned);
      }
    }

    for (const [requestId, pending] of [...bridgeRequests]) {
      if (pending.connectionId === connectionId) {
        bridgeRequests.delete(requestId);
        pending.reject(
          workerError(
            'TRANSPORT_DISCONNECTED',
            'The page bridge disconnected before the page agent answered.',
          ),
        );
      }
    }

    if (reason !== 'remote-disconnect') {
      safeDisconnect(connection.port);
    }

    log.debug('port closed', {
      role: connection.role,
      connectionId,
      tabId: connection.tabId,
      reason,
      lastErrorReported,
    });

    const closed = { reason, lastErrorReported };
    switch (connection.role) {
      case PORT_PANEL:
        emit('onPanelDisconnected', events?.onPanelDisconnected, { connection, ...closed });
        return;
      case PORT_CONTENT_BRIDGE:
        emit('onBridgeDisconnected', events?.onBridgeDisconnected, { connection, ...closed });
        return;
      case PORT_DEVTOOLS:
        emit('onDevtoolsDisconnected', events?.onDevtoolsDisconnected, { connection, ...closed });
        return;
      default:
        assertNever(connection);
    }
  }

  /**
   * Whether `chrome.runtime.lastError` is set. Reading it inside the
   * `onDisconnect` listener is what marks an error-caused disconnect as
   * checked; its text is never logged (it can name a page).
   */
  function readLastError(): boolean {
    try {
      return runtime.lastError !== undefined;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Sender validation
  //
  // The service worker is the extension's only network boundary: whatever a
  // port delivers can end up in a service request made with the paired
  // devtools credential. It must therefore never relay traffic it cannot
  // attribute — an extension page must be one of this extension's own pages,
  // and a bridge must be this extension's content script in the top frame of
  // a local app tab, exactly the scope the manifest's host permissions grant.
  // -------------------------------------------------------------------------

  /**
   * Why an extension-page port (panel or devtools page) is refused, if it is.
   *
   * What makes a sender one of this extension's own pages is its URL: only a
   * document served from `chrome-extension://<this id>/` carries one, and
   * Chrome — not the sender — fills `sender.url`. A content script, by
   * contrast, always reports the URL of the web page it runs in. So:
   *
   * - a sender with a URL is accepted exactly when that URL is one of this
   *   extension's pages, whether or not it is hosted in a tab. A DevTools
   *   page or panel has no tab; the same panel document opened directly as an
   *   extension page in a tab — how `tests/browser/**` exercises the built
   *   panel (AAP §0.8.3) — has one, and is still this extension's own code;
   * - a sender with no URL is accepted only when it is not hosted in a tab,
   *   because a tab-hosted sender whose document cannot be named could be a
   *   content script, which must use `PORT_CONTENT_BRIDGE` instead.
   */
  function extensionPageRefusal(
    sender: chrome.runtime.MessageSender | undefined,
  ): SenderRefusal | undefined {
    if (sender === undefined) {
      return 'no-sender';
    }
    if (sender.id !== runtime.id) {
      return 'foreign-extension';
    }
    if (sender.url === undefined) {
      // A tab-hosted sender that names no document cannot be told apart from
      // a content script — not an extension page.
      return sender.tab === undefined ? undefined : 'extension-page-in-tab';
    }
    const url = parseUrl(sender.url);
    if (
      url === undefined ||
      url.protocol !== EXTENSION_PAGE_PROTOCOL ||
      url.hostname !== runtime.id
    ) {
      return 'not-extension-page';
    }
    return undefined;
  }

  /** Validate a bridge port's sender and attribute it to its tab. */
  function bridgeSenderVerdict(
    sender: chrome.runtime.MessageSender | undefined,
  ): BridgeSenderVerdict {
    if (sender === undefined) {
      return { accepted: false, reason: 'no-sender' };
    }
    if (sender.id !== runtime.id) {
      return { accepted: false, reason: 'foreign-extension' };
    }
    const tabId = sender.tab?.id;
    if (!isTabId(tabId)) {
      return { accepted: false, reason: 'no-tab' };
    }
    if (sender.frameId !== undefined && sender.frameId !== 0) {
      // The bridge is declared with `all_frames: false`; a sub-frame is not it.
      return { accepted: false, reason: 'sub-frame' };
    }
    const origin =
      isNonEmptyString(sender.origin) && sender.origin !== 'null'
        ? sender.origin
        : sender.url === undefined
          ? undefined
          : parseUrl(sender.url)?.origin;
    if (origin === undefined) {
      return { accepted: false, reason: 'no-origin' };
    }
    if (!isLocalAppOrigin(origin)) {
      return { accepted: false, reason: 'not-local-origin' };
    }
    return { accepted: true, tabId };
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  /** Register a validated connection and install its listeners. */
  function register(connection: WorkerConnection): void {
    const { connectionId, port } = connection;
    connections.set(connectionId, connection);
    indexConnection(connection);

    const onMessage = (message: unknown): void => {
      receive(connectionId, message);
    };
    const onDisconnect = (): void => {
      closeConnection(connectionId, 'remote-disconnect', readLastError());
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    detachers.set(connectionId, () => {
      try {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
      } catch {
        // A port torn down by the platform may refuse listener removal; it
        // dispatches nothing further either way.
      }
    });

    log.debug('port connected', { role: connection.role, connectionId, tabId: connection.tabId });
    emit('onConnected', events?.onConnected, connection);
  }

  const handleConnect = (port: chrome.runtime.Port): void => {
    const name = port.name;
    if (!isExtensionPortName(name)) {
      log.debug('refused a port with an unknown name');
      safeDisconnect(port);
      return;
    }
    const connectedAt = now();

    switch (name) {
      case PORT_PANEL:
      case PORT_DEVTOOLS: {
        const refusal = extensionPageRefusal(port.sender);
        if (refusal !== undefined) {
          log.debug('refused an extension-page port', { role: name, reason: refusal });
          safeDisconnect(port);
          return;
        }
        const connectionId = mintConnectionId(name);
        register(
          name === PORT_PANEL
            ? { role: PORT_PANEL, port, connectionId, connectedAt, tabId: undefined }
            : { role: PORT_DEVTOOLS, port, connectionId, connectedAt, tabId: undefined },
        );
        return;
      }
      case PORT_CONTENT_BRIDGE: {
        const verdict = bridgeSenderVerdict(port.sender);
        if (!verdict.accepted) {
          log.debug('refused a bridge port', { reason: verdict.reason });
          safeDisconnect(port);
          return;
        }
        const previous = bridgeByTab.get(verdict.tabId);
        if (previous !== undefined) {
          log.debug('a new bridge supersedes the previous one for its tab', {
            tabId: verdict.tabId,
            previous,
          });
        }
        register({
          role: PORT_CONTENT_BRIDGE,
          port,
          connectionId: mintConnectionId(name),
          connectedAt,
          tabId: verdict.tabId,
          documentId: undefined,
          url: undefined,
        });
        return;
      }
      default:
        assertNever(name);
    }
  };

  /** Route one inbound frame by the role of the connection it arrived on. */
  function receive(connectionId: WorkerConnectionId, message: unknown): void {
    const connection = connections.get(connectionId);
    if (connection === undefined) {
      // A frame dispatched after the connection was closed; nothing to route.
      return;
    }
    switch (connection.role) {
      case PORT_PANEL:
        receivePanelFrame(connection, message);
        return;
      case PORT_CONTENT_BRIDGE:
        receiveBridgeFrame(connection, message);
        return;
      case PORT_DEVTOOLS:
        receiveDevtoolsFrame(connection, message);
        return;
      default:
        assertNever(connection);
    }
  }

  // -------------------------------------------------------------------------
  // Panel RPC
  // -------------------------------------------------------------------------

  /**
   * Handle one frame from a panel. A well-formed request is served; a frame
   * framed as a current-version request whose payload is malformed is
   * answered with `PROTOCOL_INVALID_MESSAGE`, so the panel is never left
   * waiting for a request the worker could address; anything else is dropped.
   */
  function receivePanelFrame(connection: PanelConnection, message: unknown): void {
    if (isPortRequest(message)) {
      servePanelRequest(connection, message);
      return;
    }
    const addressable = addressableRequest(message);
    if (addressable === undefined) {
      log.debug('dropped an unrecognised panel frame', {
        connectionId: connection.connectionId,
      });
      return;
    }
    const failure: PortFailureResponse<PortRequestKind> = {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'response',
      requestId: addressable.requestId,
      kind: addressable.kind,
      ok: false,
      error: toErrorPayload(
        workerError('PROTOCOL_INVALID_MESSAGE', 'The panel request was malformed.'),
      ),
    };
    log.debug('answered a malformed panel request', {
      connectionId: connection.connectionId,
      kind: addressable.kind,
      requestId: addressable.requestId,
    });
    postFrame(connection.connectionId, failure);
  }

  /**
   * Dispatch a validated panel request to the handler for its kind.
   *
   * Each kind is narrowed with `isPortRequestOfMethod`, so the handler and the
   * request payload are typed together; after the last kind the request is
   * `never`, which is what turns a kind added upstream into a compile error
   * here.
   */
  function servePanelRequest(connection: PanelConnection, request: PortRequest): void {
    if (isPortRequestOfMethod(request, 'panelData.query')) {
      // The hot path. The `DataQuery` travels verbatim: paging defaults and
      // bounds (`DATA_QUERY_DEFAULT_LIMIT`, `DATA_QUERY_MAX_LIMIT`) are the
      // service's, and the `DataResult` is answered as the service sent it.
      serve(connection, request, handlers['panelData.query']);
      return;
    }
    if (isPortRequestOfMethod(request, 'source.open')) {
      serve(connection, request, handlers['source.open']);
      return;
    }
    if (isPortRequestOfMethod(request, 'capture.start')) {
      serve(connection, request, handlers['capture.start']);
      return;
    }
    if (isPortRequestOfMethod(request, 'capture.stop')) {
      serve(connection, request, handlers['capture.stop']);
      return;
    }
    if (isPortRequestOfMethod(request, 'target.pick')) {
      serve(connection, request, handlers['target.pick']);
      return;
    }
    if (isPortRequestOfMethod(request, 'target.selected')) {
      serve(connection, request, handlers['target.selected']);
      return;
    }
    if (isPortRequestOfMethod(request, 'pair.complete')) {
      // Carries the one-time pairing code. Routed like any other kind: this
      // module never reads the payload, never logs it, and the handler's
      // answer (`{ paired: true }`) carries no credential (AAP §0.5.6).
      serve(connection, request, handlers['pair.complete']);
      return;
    }
    if (isPortRequestOfMethod(request, 'session.snapshot')) {
      serve(connection, request, handlers['session.snapshot']);
      return;
    }
    assertNever(request, 'An unhandled panel request kind reached the port hub.');
  }

  /**
   * Serve one panel request: run its handler under a bounded timeout and
   * answer exactly once, on the port the request arrived on, echoing its
   * `requestId`.
   *
   * The single answer is guaranteed by a settle-once latch shared by the
   * handler's outcome, the timeout and the panel's disconnect: whichever comes
   * first wins, and the others find the request settled. A handler that
   * throws, rejects or returns something that is not a `Result` is answered
   * with a typed failure rather than silence; a non-`DebuggenError` cause is
   * replaced by a generic `INTERNAL` message, so no thrown text reaches the
   * panel.
   */
  function serve<Kind extends PortRequestKind>(
    connection: PanelConnection,
    request: PortRequestFrame<Kind>,
    handler: PortRequestHandler<Kind>,
  ): void {
    const { connectionId } = connection;
    const { requestId, kind } = request;

    const pendingForPort =
      panelRequests.get(connectionId) ?? new Map<PortRequestId, PendingPanelRequest>();
    panelRequests.set(connectionId, pendingForPort);

    if (pendingForPort.has(requestId)) {
      // Two in-flight requests with one id cannot both be answered
      // unambiguously; the duplicate is refused on its own.
      log.debug('refused a duplicate panel request id', { connectionId, kind, requestId });
      postFrame(
        connectionId,
        portErr(
          request,
          workerError(
            'PROTOCOL_INVALID_MESSAGE',
            'A request with this id is already in flight on this port.',
          ),
        ),
      );
      return;
    }

    const controller = new AbortController();
    // One mutable record rather than two `let`s: the timer handle is written
    // after the closures below are created, and a timer API that fires
    // synchronously must still find a readable (if absent) handle.
    const latch: { settled: boolean; timer: number | undefined } = {
      settled: false,
      timer: undefined,
    };

    /** Close the latch; `false` when something else already settled it. */
    const settle = (): boolean => {
      if (latch.settled) {
        return false;
      }
      latch.settled = true;
      if (latch.timer !== undefined) {
        timers.clearTimeout(latch.timer);
      }
      const pending = panelRequests.get(connectionId);
      if (pending !== undefined) {
        pending.delete(requestId);
        if (pending.size === 0) {
          panelRequests.delete(connectionId);
        }
      }
      return true;
    };

    /** Answer the request, once. */
    const respond = (response: PortSuccessResponse<Kind> | PortFailureResponse<Kind>): void => {
      if (settle()) {
        postFrame(connectionId, response);
      }
    };

    /** Settle without answering: the panel is gone. */
    const cancel = (reason: DebuggenError): void => {
      if (settle()) {
        controller.abort(reason);
        log.debug('abandoned a panel request', {
          connectionId,
          kind,
          requestId,
          code: reason.code,
        });
      }
    };

    pendingForPort.set(requestId, { cancel });

    const timerHandle = timers.setTimeout(() => {
      const timeout = workerError(
        'TRANSPORT_DISCONNECTED',
        `The worker could not complete the ${kind} request within ${String(requestTimeoutMs)} ms.`,
        {
          hint: 'Retry the action. If it keeps timing out, check that the local service is running.',
          details: { kind, timeoutMs: requestTimeoutMs },
        },
      );
      controller.abort(timeout);
      log.warn('a panel request timed out', {
        connectionId,
        kind,
        requestId,
        timeoutMs: requestTimeoutMs,
      });
      respond(portErr(request, timeout));
    }, requestTimeoutMs);
    if (latch.settled) {
      timers.clearTimeout(timerHandle);
    } else {
      latch.timer = timerHandle;
    }

    const onFulfilled = (result: Result<PortResponsePayloads[Kind], DebuggenError>): void => {
      if (!isResultShape(result)) {
        log.error('a panel request handler returned no Result', { kind });
        respond(
          portErr(request, workerError('INTERNAL', `The ${kind} handler returned no result.`)),
        );
        return;
      }
      if (result.ok) {
        respond(portOk(request, result.value));
        return;
      }
      const error = DebuggenError.from(result.error);
      log.debug('a panel request failed', { connectionId, kind, requestId, code: error.code });
      respond(portErr(request, error));
    };

    const onRejected = (cause: unknown): void => {
      const error = DebuggenError.is(cause)
        ? cause
        : workerError('INTERNAL', `The worker failed while handling the ${kind} request.`, {
            cause,
          });
      log.error('a panel request handler threw', { kind, code: error.code });
      respond(portErr(request, error));
    };

    const context: PortRequestContext = {
      connectionId,
      tabId: connection.tabId,
      signal: controller.signal,
    };
    try {
      void Promise.resolve(handler(request.payload, context)).then(onFulfilled, onRejected);
    } catch (cause) {
      onRejected(cause);
    }
  }

  // -------------------------------------------------------------------------
  // Bridge traffic
  // -------------------------------------------------------------------------

  /** The attribution handed to a bridge handler, read off the current descriptor. */
  function bridgeContext(connection: BridgeConnection): BridgeMessageContext {
    return {
      connectionId: connection.connectionId,
      tabId: connection.tabId,
      documentId: connection.documentId,
    };
  }

  /**
   * Handle one frame from a content-script bridge: validate it with the shared
   * guard (the data is page-originated), narrow it per type, and delegate. The
   * payload is forwarded exactly as it came — no batching, no concatenation,
   * no re-capping — so `ws-bridge.ts` applies the protocol's bounds to what
   * the agent actually sent, promptly.
   */
  function receiveBridgeFrame(connection: BridgeConnection, message: unknown): void {
    if (!isBridgeUpstreamMessage(message)) {
      log.debug('dropped a malformed bridge frame', {
        connectionId: connection.connectionId,
        tabId: connection.tabId,
      });
      return;
    }
    dispatchBridgeFrame(connection, message);
  }

  /** Delegate a validated bridge frame to the handler for its type. */
  function dispatchBridgeFrame(connection: BridgeConnection, message: BridgeUpstreamMessage): void {
    if (isBridgeMessageOfKind(message, 'agent.ready')) {
      // Record the document the bridge now serves, so later frames and the
      // readiness decision are attributed to the current document. The URL
      // is held in memory only (query-redacted by the agent) and never logged.
      const updated: BridgeConnection = {
        ...connection,
        documentId: message.payload.documentId,
        url: message.payload.url,
      };
      replaceConnection(connection, updated);
      invokeSafely(
        'agent.ready',
        bridgeHandlers['agent.ready'],
        message.payload,
        bridgeContext(updated),
      );
      return;
    }
    if (isBridgeMessageOfKind(message, 'telemetry.batch')) {
      invokeSafely(
        'telemetry.batch',
        bridgeHandlers['telemetry.batch'],
        message.payload,
        bridgeContext(connection),
      );
      return;
    }
    if (isBridgeMessageOfKind(message, 'target.described')) {
      if (settleBridgeRequest(connection, message.payload)) {
        return;
      }
      invokeSafely(
        'target.described',
        bridgeHandlers['target.described'],
        message.payload,
        bridgeContext(connection),
      );
      return;
    }
    if (isBridgeMessageOfKind(message, 'agent.error')) {
      invokeSafely(
        'agent.error',
        bridgeHandlers['agent.error'],
        message.payload,
        bridgeContext(connection),
      );
      return;
    }
    assertNever(message, 'An unhandled bridge frame type reached the port hub.');
  }

  /**
   * Settle the round trip a `target.described` answers, when it answers one
   * this hub started on the same bridge connection.
   *
   * @returns `true` when the frame was consumed by a pending round trip.
   */
  function settleBridgeRequest(
    connection: BridgeConnection,
    payload: PageTargetDescribedPayload,
  ): boolean {
    const requestId = payload.requestId;
    if (requestId === undefined) {
      return false;
    }
    const pending = bridgeRequests.get(requestId);
    if (pending === undefined || pending.connectionId !== connection.connectionId) {
      return false;
    }
    bridgeRequests.delete(requestId);
    pending.resolve(payload);
    return true;
  }

  const sendToBridge = (tabId: TabId, message: BridgeDownstreamMessage): boolean => {
    const connectionId = bridgeByTab.get(tabId);
    if (connectionId === undefined) {
      return false;
    }
    return postFrame(connectionId, message);
  };

  const requestFromBridge = (
    tabId: TabId,
    type: BridgeRoundTripType,
    options?: BridgeRequestOptions,
  ): Promise<PageTargetDescribedPayload> =>
    new Promise<PageTargetDescribedPayload>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? bridgeRequestTimeoutMs;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        reject(
          new DebuggenError(
            'CONFIG_INVALID',
            'The bridge request timeout must be a positive number of milliseconds.',
          ),
        );
        return;
      }
      const connectionId = bridgeByTab.get(tabId);
      if (connectionId === undefined) {
        reject(workerError('AGENT_NOT_READY', 'No page agent bridge is attached to this tab.'));
        return;
      }

      const requestId = newPortRequestId();
      const timer = timers.setTimeout(() => {
        const pending = bridgeRequests.get(requestId);
        if (pending !== undefined) {
          bridgeRequests.delete(requestId);
          log.debug('a bridge round trip timed out', { tabId, type, requestId, timeoutMs });
          pending.reject(
            workerError(
              'AGENT_NOT_READY',
              `The page agent did not answer within ${String(timeoutMs)} ms.`,
              { hint: 'Reload the page so the agent can start, then try again.' },
            ),
          );
        }
      }, timeoutMs);

      bridgeRequests.set(requestId, {
        connectionId,
        resolve: (payload) => {
          timers.clearTimeout(timer);
          resolve(payload);
        },
        reject: (error) => {
          timers.clearTimeout(timer);
          reject(error);
        },
      });

      const frame: BridgeDownstreamMessage<typeof type> = {
        channel: EXTENSION_CHANNEL,
        version: PORT_PROTOCOL_VERSION,
        direction: 'downstream',
        type,
        payload: { requestId },
      };
      if (!postFrame(connectionId, frame)) {
        // A dead port was closed by `postFrame`, which settled this entry
        // already; this settles it only if the post failed some other way.
        const pending = bridgeRequests.get(requestId);
        if (pending !== undefined) {
          bridgeRequests.delete(requestId);
          pending.reject(
            workerError('TRANSPORT_DISCONNECTED', 'The page bridge could not take the request.'),
          );
        }
      }
    });

  const hasBridge = (tabId: TabId): boolean => bridgeByTab.has(tabId);

  // -------------------------------------------------------------------------
  // Devtools-page traffic
  // -------------------------------------------------------------------------

  /**
   * Record the tab a devtools page inspects, so it can be addressed by tab.
   * A second announcement for another tab moves it.
   */
  function announceDevtoolsTab(connection: DevtoolsConnection, tabId: TabId): DevtoolsConnection {
    if (connection.tabId === tabId && devtoolsByTab.get(tabId) === connection.connectionId) {
      return connection;
    }
    const updated: DevtoolsConnection = { ...connection, tabId };
    replaceConnection(connection, updated);
    return updated;
  }

  /**
   * Handle one frame from a devtools page: validate it, record the announced
   * tab, and delegate. A selection frame naming a different tab than the one
   * this page announced cannot be attributed and is dropped.
   */
  function receiveDevtoolsFrame(connection: DevtoolsConnection, message: unknown): void {
    if (!isDevtoolsUpstreamMessage(message)) {
      log.debug('dropped a malformed devtools frame', { connectionId: connection.connectionId });
      return;
    }
    switch (message.type) {
      case 'devtools.hello': {
        const updated = announceDevtoolsTab(connection, message.payload.tabId);
        if (devtoolsHandlers === undefined) {
          return;
        }
        invokeSafely('devtools.hello', devtoolsHandlers['devtools.hello'], message.payload, {
          connectionId: updated.connectionId,
          tabId: message.payload.tabId,
        });
        return;
      }
      case 'devtools.element': {
        if (connection.tabId !== undefined && connection.tabId !== message.payload.tabId) {
          log.debug('dropped a devtools selection for another tab', {
            connectionId: connection.connectionId,
            tabId: connection.tabId,
          });
          return;
        }
        const updated = announceDevtoolsTab(connection, message.payload.tabId);
        if (devtoolsHandlers === undefined) {
          log.debug('dropped a devtools selection: no devtools handlers', {
            connectionId: updated.connectionId,
          });
          return;
        }
        invokeSafely('devtools.element', devtoolsHandlers['devtools.element'], message.payload, {
          connectionId: updated.connectionId,
          tabId: message.payload.tabId,
        });
        return;
      }
      default:
        assertNever(message, 'An unhandled devtools frame type reached the port hub.');
    }
  }

  const sendToDevtools = (tabId: TabId, message: DevtoolsDownstreamMessage): boolean => {
    const connectionId = devtoolsByTab.get(tabId);
    if (connectionId === undefined) {
      return false;
    }
    return postFrame(connectionId, message);
  };

  // -------------------------------------------------------------------------
  // Panels: binding, pushes and relays
  // -------------------------------------------------------------------------

  const bindPanelTab = (connectionId: WorkerConnectionId, tabId: TabId): boolean => {
    if (!isTabId(tabId)) {
      return false;
    }
    const connection = connections.get(connectionId);
    if (connection === undefined || connection.role !== PORT_PANEL) {
      return false;
    }
    if (connection.tabId !== tabId) {
      const updated: PanelConnection = { ...connection, tabId };
      replaceConnection(connection, updated);
      log.debug('panel bound to its inspected tab', { connectionId, tabId });
    }
    return true;
  };

  /** Deliver a push to a set of connections, counting the ones that took it. */
  function deliverToAll(connectionIds: Iterable<WorkerConnectionId>, push: PortPush): number {
    let delivered = 0;
    // A snapshot: a dead port found mid-loop is closed, which edits the index.
    for (const connectionId of [...connectionIds]) {
      if (postFrame(connectionId, push)) {
        delivered += 1;
      }
    }
    return delivered;
  }

  /** The ids of every connected panel, bound or not. */
  function allPanelIds(): WorkerConnectionId[] {
    const ids: WorkerConnectionId[] = [];
    for (const connection of connections.values()) {
      if (connection.role === PORT_PANEL) {
        ids.push(connection.connectionId);
      }
    }
    return ids;
  }

  const pushToPanels = (tabId: TabId, push: PortPush): number => {
    const panels = panelsByTab.get(tabId);
    return panels === undefined ? 0 : deliverToAll(panels, push);
  };

  const broadcastToPanels = (value: PortPush | WorkerStatusSnapshot): number =>
    deliverToAll(allPanelIds(), 'channel' in value ? value : connectionPushFromStatus(value));

  /** Map a resolved tab onto a relay target. */
  function tabTarget(tabId: TabId | undefined): RelayTarget {
    return isTabId(tabId)
      ? { kind: 'tab', tabId }
      : { kind: 'withheld', reason: 'session-not-bound' };
  }

  /**
   * Where a relayed frame handed over without a tab goes: its session's tab,
   * a broadcast when it names no session, or nowhere when its session is not
   * bound (or cannot be resolved). Never rejects: a failed lookup withholds.
   */
  function resolveRelayTarget(message: RelayedProtocolMessage): RelayTarget | Promise<RelayTarget> {
    const sessionId = relaySessionId(message);
    if (sessionId === undefined) {
      return BROADCAST_TARGET;
    }
    if (resolveTabForSession === undefined) {
      return { kind: 'withheld', reason: 'no-session-resolver' };
    }
    const failed: RelayTarget = { kind: 'withheld', reason: 'session-lookup-failed' };
    try {
      const resolved = resolveTabForSession(sessionId);
      return resolved instanceof Promise
        ? resolved.then(tabTarget, (cause: unknown) => {
            log.debug('session lookup for a relay failed', { code: failureCode(cause) });
            return failed;
          })
        : tabTarget(resolved);
    } catch (cause) {
      log.debug('session lookup for a relay failed', { code: failureCode(cause) });
      return failed;
    }
  }

  /** Deliver one relayed frame to its resolved target. */
  function deliverRelay(push: PortProtocolPush, target: RelayTarget): void {
    switch (target.kind) {
      case 'tab':
        pushToPanels(target.tabId, push);
        return;
      case 'broadcast':
        deliverToAll(allPanelIds(), push);
        return;
      case 'withheld':
        log.debug('withheld a relayed frame', { type: push.message.type, reason: target.reason });
        return;
      default:
        assertNever(target);
    }
  }

  const relayPush: RelayPush = (message, tabId) => {
    const push: PortProtocolPush = {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'push',
      kind: 'protocol',
      message,
    };
    const target = tabId === undefined ? resolveRelayTarget(message) : tabTarget(tabId);

    // Deliver synchronously when nothing is queued ahead; otherwise queue
    // behind the in-flight lookups, so panels see frames in call order even
    // when one frame's session lookup is slower than the next frame's.
    if (!(target instanceof Promise) && relaysInFlight === 0) {
      deliverRelay(push, target);
      return;
    }
    relaysInFlight += 1;
    relayTail = relayTail
      .then(() => target)
      .then(
        (resolved) => {
          relaysInFlight -= 1;
          deliverRelay(push, resolved);
        },
        (cause: unknown) => {
          relaysInFlight -= 1;
          log.debug('a queued relay failed', { code: failureCode(cause) });
        },
      );
  };

  // -------------------------------------------------------------------------
  // Introspection and teardown
  // -------------------------------------------------------------------------

  const getConnection = (connectionId: WorkerConnectionId): WorkerConnection | undefined =>
    connections.get(connectionId);

  const listConnections = (): readonly WorkerConnection[] => [...connections.values()];

  const disposeAll = (): void => {
    for (const connectionId of [...connections.keys()]) {
      closeConnection(connectionId, 'disposed', false);
    }
    // Every entry was settled by `closeConnection`; clearing is belt and braces
    // for an entry whose connection vanished some other way.
    const disposed = workerError('TRANSPORT_DISCONNECTED', 'The port hub was disposed.');
    for (const pending of [...bridgeRequests.values()]) {
      pending.reject(disposed);
    }
    for (const pendingForPort of [...panelRequests.values()]) {
      for (const pending of [...pendingForPort.values()]) {
        pending.cancel(disposed);
      }
    }
    bridgeRequests.clear();
    panelRequests.clear();
    panelsByTab.clear();
    bridgeByTab.clear();
    devtoolsByTab.clear();
    detachers.clear();
    connections.clear();
  };

  return {
    handleConnect,
    bindPanelTab,
    pushToPanels,
    broadcastToPanels,
    relayPush,
    sendToBridge,
    requestFromBridge,
    sendToDevtools,
    hasBridge,
    getConnection,
    listConnections,
    disposeAll,
  };
}
