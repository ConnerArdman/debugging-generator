/**
 * The Manifest V3 module service worker of the "Debug Generator" extension —
 * the manifest's `background.service_worker` entry and the extension's
 * composition root.
 *
 * Every other module in this folder is a side-effect-free factory that cannot
 * see its siblings: `auth.ts` keeps the devtools credential, `ports.ts` routes
 * runtime ports, `tab-registry.ts` mirrors the tab ↔ session bindings,
 * `agent-control.ts` arms and disarms the page agent, and `ws-bridge.ts` owns
 * the authenticated socket and the HTTP calls. This file constructs each once,
 * wires them together through injected callbacks, attaches them to Chrome's
 * events, and makes the decisions no single module owns: which tab a panel
 * inspects, when DevTools closing means `session.unbind`, which navigation is
 * committed, and which service address is in force — the stored setting, else
 * the environment's or the default. Its first read gates every socket and
 * HTTP call, and a failed first read puts a refusal in force, so the
 * credential and a pairing code never reach an address no read established.
 *
 * The invariants everything else depends on:
 *
 * - **Every listener is registered synchronously.** Chrome suspends an idle
 *   worker and re-evaluates this module on the next event, which reaches only
 *   the listeners that exist by the end of that evaluation. {@link createWorker}
 *   registers every `chrome.*` listener synchronously and the module calls it
 *   synchronously; the synchronous section only constructs. Start-up work
 *   (bindings, credential, socket) starts after registration, and a handler
 *   that needs it awaits {@link DebugGeneratorWorker.ready} inside itself.
 *   Every handler is written for a cold start: it hydrates through the owning
 *   module, never from memory a revival emptied.
 * - **Recovery.** While the socket is open, `ws-bridge.ts`'s heartbeat
 *   refreshes the worker's idle time and probes the service. The
 *   `chrome.alarms` keepalive does not prevent suspension: it fires within one
 *   period after the worker is suspended, and its tick
 *   ({@link KEEPALIVE_ALARM_NAME}) revives the worker and reconnects. The
 *   socket client's backoff covers a service restart. Both end in a status
 *   snapshot pushed to every panel.
 * - **A panel's tab comes only from Chrome.** It is fixed for the life of the
 *   port and set from `chrome.devtools.inspectedWindow.tabId` as this
 *   extension's own pages report it ({@link associatePanel}), never from the
 *   session a panel remembers. The worker, not the panel, sends
 *   `session.bind`. Every session-scoped action names its acting tab — a
 *   panel's associated tab or a bridge or DevTools port's sender, never a
 *   page's or panel's claim — which the service checks against its bindings:
 *   panel requests through `checkPanelScope`, the modules' frames through
 *   `sendActingForPayloadTab`.
 * - **Telemetry travels only along a route the service confirmed.** One
 *   ordered, bounded lane per tab carries `agent.ready` and the tab's batches
 *   in arrival order across a cold start (`enqueueTelemetryBatch`, holding at
 *   most {@link COLD_START_HELD_EVENTS_PER_TAB} events until start-up
 *   settles). A batch is sent only for its tab's binding, once the service has
 *   confirmed that binding on the current connection; the session and capture
 *   the page stamped on it can only reject it, never be relabelled.
 * - **Loss is shown and forwarded, never silent.** Events the worker could
 *   not deliver and events the page dropped reach the tab's panels as a
 *   fixed-copy notice naming only a count ({@link telemetryLossNotice}). The
 *   service's producer-loss ledger learns both as `droppedCount`: the page's
 *   on its batch, or on a loss-only frame when no event travels with it; the
 *   worker's own — the cold-start hold, a full lane, an unconfirmed route, a
 *   failed send, a frame the socket client discarded — held per tab and
 *   capture context and carried by the next job of that context, or by a
 *   loss-only frame once the service confirms the tab's route. A count is
 *   never moved to another context ({@link MAX_PENDING_LOSS_CONTEXTS_PER_TAB}).
 * - **Privacy.** Logs carry ids, counts, kinds and error codes only — never a
 *   token, a pairing code, a URL's path or query, telemetry, a descriptor, a
 *   source location or a response body; a URL sent to the service is
 *   query-redacted ({@link redactNavigationUrl}), and page-forgeable text and
 *   ids are reduced to fixed copy ({@link agentErrorReport}) or fingerprints.
 *
 * @module apps/chrome-extension/src/background/service-worker
 */

import type {
  AnalysisResult,
  ErrorPayload,
  MessagePayload,
  PanelSpec,
  SelectedTarget,
  SendOutcome,
  SessionRecord,
  SourceResultPayload,
  Unsubscribe,
  WebSocketConstructorLike,
} from '@debuggen/protocol';
import {
  createEnvelope,
  DEFAULT_WS_BACKOFF,
  HttpClient,
  isPlainRecord,
  MESSAGE_TYPE,
  parseErrorPayload,
  parseSessionBindPayload,
  parseTabNavigatedPayload,
  sameSelectedTarget,
  SOURCE_OPEN_RESULT_TIMEOUT_MS,
  toErrorPayload,
} from '@debuggen/protocol';
import type { DebuggenErrorCode, LogFields, Logger, Result, SessionId } from '@debuggen/shared';
import {
  createConsoleLogger,
  DebuggenError,
  err,
  isErr,
  newMessageId,
  noopLogger,
  ok,
} from '@debuggen/shared';

import type {
  PageAgentErrorKind,
  PageReloadResult,
  PageTelemetryBatchPayload,
  PanelBindingState,
  PanelReloadState,
  PanelSessionSnapshot,
  PortPickerPush,
  PortPush,
  PortReloadPush,
  PortRequestId,
  PortRequestPayloads,
  PortResponsePayloads,
  RelayedProtocolMessage,
} from '../shared/messages';
import {
  DEFAULT_SERVICE_BASE_URL,
  EXTENSION_CHANNEL,
  fingerprintPageId,
  isPageCaptureId,
  newPortRequestId,
  PAGE_AGENT_ERROR_PUBLIC_MESSAGES,
  pageAgentErrorKind,
  PANEL_RELOAD_NOT_NEEDED,
  PORT_CONTENT_BRIDGE,
  PORT_DEVTOOLS,
  PORT_PANEL,
  PORT_PROTOCOL_VERSION,
} from '../shared/messages';

import type {
  AgentControl,
  AgentControlChange,
  AgentTabsApi,
  DisarmReason,
  ReloadOutcome,
} from './agent-control';
import { createAgentControl, PENDING_READY_TIMEOUT_MS } from './agent-control';
import type {
  CredentialStorageArea,
  CredentialStorageChangeEvent,
  CredentialStorageChangeListener,
  DevtoolsCredentialStore,
} from './auth';
import {
  createDevtoolsCredentialStore,
  parseServiceEndpoint,
  readServiceEndpoint,
  SERVICE_ENDPOINT_STORAGE_KEY,
} from './auth';
import type {
  BridgeConnection,
  DevtoolsConnection,
  PanelConnection,
  ProtocolSend,
  ProtocolSubscribe,
  RelayPush,
  TabBindingRecord,
  WorkerAlarmsApi,
  WorkerConnection,
  WorkerConnectionId,
  WorkerStatusSnapshot,
  WorkerTimerApi,
} from './messages';
import {
  captureConflictOwningSessionId,
  isRelayedMessage,
  KEEPALIVE_ALARM_NAME,
  workerError,
} from './messages';
import type {
  BridgeMessageContext,
  BridgeMessageHandlers,
  DevtoolsMessageHandlers,
  PortClosedEvent,
  PortHub,
  PortRequestContext,
  PortRequestHandlers,
} from './ports';
import {
  connectionPushFromStatus,
  createPortHub,
  isLocalAppOrigin,
  PORT_REQUEST_TIMEOUT_MS,
} from './ports';
import type { TabBindingChange, TabRegistry, TabRegistryStorageArea } from './tab-registry';
import { createTabRegistry } from './tab-registry';
import type { WsBridge, WsBridgeStatus } from './ws-bridge';
import { createWsBridge, TELEMETRY_ROUTE_WAIT_MS } from './ws-bridge';

/*
 * ===========================================================================
 * Section A — derived primitives
 * ===========================================================================
 */

/** A Chrome tab id, exactly as the registry's binding records type it. */
type TabId = TabBindingRecord['tabId'];

/** The binding state of a panel whose tab is not known, or not bound. */
const UNBOUND_STATE: PanelBindingState = Object.freeze({ kind: 'unbound' });

/** The origin schemes the worker binds; every other page is never bound. */
const BINDABLE_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/**
 * How long the worker waits at each step of settling one selection, in
 * milliseconds — the contract `@debuggen/protocol`'s `messages/target.ts`
 * documents: a `target.selected` frame is **pending** until the service
 * refuses it with an `error` whose `ref` is the frame's id or accepts it with
 * the `session.updated` that carries the descriptor, and a frame the transport
 * lost gets neither answer.
 *
 * - `verifyMs` — the bound on each `GET /sessions/:id` of a selection: the
 *   read before the send (is the descriptor already the recorded target?) and
 *   the read-back that decides a frame nothing answered. One loopback read.
 * - `queuedMs` — the delivery deadline. A selection is never handed to the
 *   socket client's outbound queue: while the socket is not open it is held
 *   here, still pending, for at most the backoff's ceiling
 *   (`DEFAULT_WS_BACKOFF.maxMs`, ten seconds) plus two seconds for the
 *   reconnect's handshake. A selection the deadline abandons was never sent,
 *   so no reconnect can flush it after its failure was reported.
 * - `sentMs` — the frame was written to an open socket: the service validates
 *   the binding and records the target in one turn, so three seconds is only
 *   exceeded when the frame was lost with the socket.
 *
 * The longest path — the read before the send, the whole hold, the sent wait
 * and the read-back, `2 × verifyMs + queuedMs + sentMs` (nineteen seconds) —
 * stays inside the port hub's `PORT_REQUEST_TIMEOUT_MS` (twenty seconds), so
 * the panel always receives this worker's verdict rather than a generic
 * request timeout. Exported, frozen, so a unit test can hold that inequality.
 */
export const SELECTION_VERDICT_TIMEOUTS = Object.freeze({
  sentMs: 3_000,
  queuedMs: DEFAULT_WS_BACKOFF.maxMs + 2_000,
  verifyMs: 2_000,
});

/**
 * The message of a selection the service never settled — lost with a closed
 * socket, or held until the delivery deadline for a socket that did not open.
 * Constant, so it names no descriptor, URL or selector (AAP §0.5.2).
 */
const SELECTION_UNCONFIRMED_MESSAGE =
  "The service did not confirm the selected element, so it is not the session's target.";

/** The recovery hint of {@link SELECTION_UNCONFIRMED_MESSAGE}. */
const SELECTION_UNCONFIRMED_HINT =
  'Check that the Debug Generator service is running and this tab is still bound, then select the element again.';

/**
 * The message of a selection that was not sent because the worker's socket is
 * closed — not reconnecting — so no wait could deliver it: the panel is not
 * paired, or the service refused its credential.
 */
const SELECTION_UNSENT_MESSAGE =
  'The Debug Generator panel is not connected to the service, so the selected element was not sent.';

/** The recovery hint of {@link SELECTION_UNSENT_MESSAGE}. */
const SELECTION_UNSENT_HINT =
  'Pair the panel with the service (or start the service), then select the element again.';

/**
 * Why "Pick element" could not enter picker mode — picker mode is the page
 * agent's picker, and no agent is connected for the inspected tab — with the
 * two routes that still lead to a target: a reload, which starts the agent, or
 * the explicit `$0` control. The recovery is part of the message itself
 * because a port failure frame carries `{ code, message }` only (`./messages`'s
 * `portErr`; see {@link SourceOpenForwardResult}), so a separate hint would
 * never reach the panel.
 */
const PICKER_UNAVAILABLE_MESSAGE =
  'The Debug Generator page agent is not running on the inspected page, so picker mode is unavailable. Reload the application page, or select the element in the Elements panel and press "Use selected element".';

/**
 * Why a picked element was dropped: the page agent described it in a document
 * the tab no longer shows (a reload or a navigation came first). Constant, so
 * it names no descriptor, URL or selector (AAP §0.5.2).
 */
const STALE_SELECTION_MESSAGE =
  'The page changed before the element was reported, so it was not selected. Pick it again.';

/**
 * The interactive pick this worker generation armed in one tab's page and the
 * page agent has not answered yet. The agent answers every armed pick exactly
 * once — the clicked element, or `null` for Escape, a hidden page, a cancel or
 * a newer pick — so the record lives from the arming `target.request` to that
 * one `target.described`, or until the document holding the pick goes away.
 *
 * The record is also the only authority for an answer's element: a non-null
 * `target.described` becomes a target only when it answers this record — its
 * `requestId`, on its `connectionId` — while the record stands uncancelled,
 * and only for its `sessionId` ({@link PagePickVerdict}). A pick never
 * outlives the bridge connection that armed it (the page agent ends its pick
 * when the bridge's worker port closes, and {@link releasePagePick} drops the
 * record with that connection), so an answer no record matches is never one
 * this worker should honour.
 */
interface ArmedPagePick {
  /** The arming `target.request`'s id; the agent echoes it on its answer. */
  readonly requestId: PortRequestId;
  /** The bridge connection the request went to: the document holding the pick. */
  readonly connectionId: WorkerConnectionId;
  /**
   * The session the pick was armed for — the `target.pick` request's, which
   * the panel scope check tied to the tab's binding at that moment. The
   * picked element may become that session's target and no other's: when
   * the tab is bound to another session by the time the answer is forwarded,
   * the element is dropped.
   */
  readonly sessionId: SessionId;
  /**
   * Whether the pick was since cancelled in the page: the panel left picker
   * mode or submitted "Use selected element", or the tab's binding to the
   * pick's session went away, or the tab's last panel closed. The panel then
   * already shows picker mode off — it asked for that and was answered
   * `active: false`, it turned picker mode off with the confirmed selection,
   * it reset its session state with the binding, or it is gone — so the
   * cancelled pick's answer ends nothing on screen and pushes nothing: a push
   * then could only arrive after the panel turned picker mode on again, and
   * would switch the new activation off. Nor does that answer select: an
   * element clicked after the pick was cancelled is not the developer's pick.
   */
  readonly cancelled: boolean;
}

/** What ended a page pick, for the log line of the `picker` push that says so. */
type PagePickEnd = 'answered' | 'bridge-gone';

/**
 * Why a page pick's non-null answer was not forwarded as the session's target
 * — the code it is logged by (never the descriptor):
 *
 * - `unarmed` — this worker generation holds no pick for the tab: none was
 *   armed, or the one armed was already answered or ended with its bridge.
 * - `superseded` — the answer names an older pick than the recorded one: a
 *   pick cancelled or replaced before the current one was armed.
 * - `cancelled` — it answers the recorded pick, which was cancelled first.
 * - `unidentified` — it names no `requestId`, so it cannot be matched to the
 *   pick that armed it.
 * - `other-connection` — it arrived on another bridge connection than the one
 *   the pick was armed on, so another document answered.
 * - `rebound` — it answers the live pick, but by the time it could be sent the
 *   tab was bound to another session than the one the pick was armed for.
 */
type PagePickDropReason =
  'unarmed' | 'superseded' | 'cancelled' | 'unidentified' | 'other-connection' | 'rebound';

/**
 * What one `target.described` answer may do with its element, decided
 * synchronously when it arrives from the tab's pick record
 * (`settlePagePick`): `select` for the one answer to the live pick, carrying
 * the session the pick was armed for, or `drop` with the reason.
 */
type PagePickVerdict =
  | { readonly kind: 'select'; readonly sessionId: SessionId }
  | { readonly kind: 'drop'; readonly reason: Exclude<PagePickDropReason, 'rebound'> };

/**
 * A page pick's answer on its way to the service: the attribution of the
 * agent's `target.described` frame, checked again once the binding is read,
 * and the session the pick was armed for, which that binding must still name.
 */
interface AnsweredPagePick {
  readonly bridge: BridgeMessageContext;
  readonly sessionId: SessionId;
}

/**
 * How much sooner than a panel request's own deadline an HTTP call to the
 * service gives up, in milliseconds: five seconds.
 */
const SERVICE_REQUEST_DEADLINE_MARGIN_MS = 5_000;

/**
 * The deadline of every HTTP call the worker makes to the local service that
 * names none of its own — the shared `HttpClient`'s `defaultTimeoutMs`:
 * `PORT_REQUEST_TIMEOUT_MS` (20 s) less {@link SERVICE_REQUEST_DEADLINE_MARGIN_MS},
 * so fifteen seconds.
 *
 * Without it, a service that accepts a connection and never answers leaves
 * the call — and the port request, `session.snapshot` hydration or pairing
 * redemption waiting on it — pending until the panel's port gives up with a
 * bare timeout. Shorter than that port deadline, the call settles first, with
 * the client's typed timeout failure and its hint, which the panel renders as
 * a retryable error state (AAP §0.5.5). A call that sets its own `timeoutMs`
 * (the health probe's `CLIENT_HELLO_TIMEOUT_MS`) keeps it.
 */
const SERVICE_REQUEST_TIMEOUT_MS = PORT_REQUEST_TIMEOUT_MS - SERVICE_REQUEST_DEADLINE_MARGIN_MS;

/**
 * What the developer can do when the stored service address could not be
 * read before any read succeeded — the state the worker fails closed into.
 * Opening the panel again re-reads it (its `session.snapshot` does), and so
 * does a pairing attempt.
 */
const SERVICE_ADDRESS_UNREAD_HINT =
  'Close and reopen DevTools to read the saved service address again; the extension contacts no service until it can.';

/**
 * When a failed background hydration of a tab's panels is tried again, in
 * milliseconds after each failure, in order: 5 s, 15 s, then 30 s, after
 * which the panel keeps its retryable error notice and recovers with the next
 * reconnect's replay or its own resync. Only transient failures are retried
 * ({@link RETRYABLE_HYDRATION_CODES}), only while the tab still has a panel,
 * and a detach or a newer hydration cancels the pending try.
 */
export const HYDRATION_RETRY_DELAYS_MS: readonly number[] = Object.freeze([5_000, 15_000, 30_000]);

/**
 * The failure codes of a hydration read worth trying again: a transport that
 * dropped or timed out, and a service whose own store failed. Everything else
 * — an unknown session, a refused credential, a refused address — answers the
 * same way on a second try.
 */
const RETRYABLE_HYDRATION_CODES: ReadonlySet<DebuggenErrorCode> = new Set<DebuggenErrorCode>([
  'TRANSPORT_DISCONNECTED',
  'STORE_ERROR',
]);

/**
 * How much longer than agent-control's bounded wait for a reloaded document's
 * `agent.ready` ({@link PENDING_READY_TIMEOUT_MS}) the port hub lets a panel
 * request run: five seconds.
 *
 * A `page.reload` answer is decided only when that wait settles, and the
 * wait starts after the handler has resolved the session's tab, so a hub
 * timeout equal to the wait would answer first — with a generic `TIMEOUT`
 * instead of the `AGENT_NOT_READY` that says the reloaded page never
 * reported. The margin covers the handler's own lookups and the wait's timer
 * firing late on a busy worker.
 */
const RELOAD_ANSWER_GRACE_MS = 5_000;

/**
 * The port hub's timeout for every panel request: the hub default
 * ({@link PORT_REQUEST_TIMEOUT_MS}), raised when needed to outlast a
 * consented reload's wait plus {@link RELOAD_ANSWER_GRACE_MS}. The hub's
 * timeout is uniform across request kinds, so the other kinds share the
 * raised bound; it stays below the panel's own request timeout
 * (`PANEL_PORT_REQUEST_TIMEOUT_MS`, thirty seconds, in
 * `../panel/state/connection.ts`), so the panel always hears the worker's
 * typed answer rather than giving up first.
 */
const WORKER_REQUEST_TIMEOUT_MS = Math.max(
  PORT_REQUEST_TIMEOUT_MS,
  PENDING_READY_TIMEOUT_MS + RELOAD_ANSWER_GRACE_MS,
);

/**
 * The most telemetry batches one tab may have waiting to be forwarded.
 *
 * A batch waits while the worker's cold start settles (the credential read,
 * the binding hydration, the socket start), while the service confirms the
 * tab's route after a (re)connect, and while the batches of the same tab
 * ahead of it are forwarded — each for at most `TELEMETRY_ROUTE_WAIT_MS` from
 * its arrival. The page agent (`@debuggen/telemetry`'s browser transport)
 * posts batches of at most 200 events, flushes a partial one after 250 ms,
 * and holds at most 5 000 events while the worker is away — so the backlog a
 * revival receives from one tab is at most 25 batches. 64 covers that backlog
 * plus the flushes made while the cold start settles, and bounds what one tab
 * can make the worker hold. A batch beyond the bound is dropped and reported
 * — counted, logged and held for the service's ledger — never silently lost.
 */
const MAX_PENDING_TELEMETRY_BATCHES_PER_TAB = 64;

/**
 * The most capture contexts one tab may hold undelivered loss for: the
 * worker's pending-loss accumulator (`holdPendingLoss` in {@link createWorker}).
 *
 * A context is the session and capture a lost batch was stamped with, or sent
 * under. A tab moves to a new one only when its capture or session changes, so
 * its loss normally waits under one or two contexts until the service next
 * confirms the tab's route; eight covers several captures of one outage and
 * bounds what one tab can make the worker keep. A context beyond the bound
 * abandons the oldest one's count with a counts-only warning — never merged
 * into another context, which would relabel loss into a capture it did not
 * happen in. The loss-only reports the worker schedules for held loss are
 * bounded by this too — at most this many on a tab's lane, one per context —
 * rather than by {@link MAX_PENDING_TELEMETRY_BATCHES_PER_TAB}, so a lane full
 * of the page's batches cannot hold them back.
 */
export const MAX_PENDING_LOSS_CONTEXTS_PER_TAB = 8;

/**
 * How many times the lane hands one batch to the bridge: the send, and one
 * more after the route was lost between its confirmation and the write (the
 * socket dropped, or a reconnect has not been confirmed yet) — both within the
 * batch's one overall deadline.
 */
const TELEMETRY_SEND_ATTEMPTS = 2;

/**
 * The send failures that mean "the route was lost before the write" and are
 * worth waiting for the route again: the socket could not take the write, or
 * the service's confirmation for the pair is not held on this connection.
 */
const TELEMETRY_ROUTE_LOSS_CODES: readonly DebuggenErrorCode[] = [
  'TRANSPORT_DISCONNECTED',
  'TAB_NOT_BOUND',
];

/*
 * ===========================================================================
 * Section B — the injected environment
 *
 * `createWorker` receives the Chrome surfaces it uses rather than reading the
 * `chrome` global, so a unit test can drive the whole composition against
 * recording fakes. `chrome.*` satisfies every interface here; the module's
 * bootstrap passes the real namespaces.
 * ===========================================================================
 */

/**
 * A Chrome event: the two members of `chrome.events.Event` the worker uses.
 * Method shorthand keeps listener parameters bivariant, so the richer
 * `chrome.*` listener types are accepted as they are.
 */
export interface WorkerEvent<Listener> {
  /** Start delivering the event to `listener`. */
  addListener(listener: Listener): void;
  /** Stop delivering the event to `listener`. */
  removeListener(listener: Listener): void;
}

/** The parts of `chrome.runtime` the worker uses. */
export interface WorkerRuntimeApi {
  /** This extension's id; the port hub validates senders against it. */
  readonly id: string;
  /** Set by the platform while an error-caused callback runs. */
  readonly lastError?: { readonly message?: string | undefined } | undefined;
  /** A panel, a devtools page or a content-script bridge opened a port. */
  readonly onConnect: WorkerEvent<(port: chrome.runtime.Port) => void>;
  /** The extension was installed, updated or Chrome was updated. */
  readonly onInstalled: WorkerEvent<(details: { readonly reason: string }) => void>;
  /** A browser profile started with the extension enabled. */
  readonly onStartup: WorkerEvent<() => void>;
  /** Best-effort notice before eviction; never relied on for correctness. */
  readonly onSuspend?: WorkerEvent<() => void> | undefined;
}

/** The fields of `chrome.tabs.onUpdated`'s change info the worker reads. */
export interface WorkerTabChange {
  /** The tab's new URL, present only when it changed. */
  readonly url?: string | undefined;
  /** `loading` or `complete`, present only when it changed. */
  readonly status?: string | undefined;
}

/**
 * The fields of a `chrome.tabs.Tab` the worker reads; `chrome.tabs.Tab` is
 * assignable to it as it is. Both URLs are present because the manifest holds
 * the `tabs` permission.
 */
export interface WorkerTab {
  /** The main frame's last **committed** URL (the old page's while a navigation is pending). */
  readonly url?: string | undefined;
  /**
   * The URL the tab is navigating to before that navigation commits (Chrome
   * 79+), absent when no navigation is pending. A `loading` entry whose
   * pending URL differs from {@link url} belongs to a load bound for another
   * URL, whose commit arrives later as a `url` change — see
   * {@link nextCommittedNavigation}.
   */
  readonly pendingUrl?: string | undefined;
}

/** The parts of `chrome.tabs` the worker uses. */
export interface WorkerTabsApi extends AgentTabsApi {
  /** Read one tab, for the URL of a DevTools page that did not report it. */
  get(tabId: TabId): Promise<WorkerTab>;
  /** A tab's properties changed; the committed-navigation signal. */
  readonly onUpdated: WorkerEvent<
    (tabId: TabId, changeInfo: WorkerTabChange, tab: WorkerTab) => void
  >;
  /** A tab closed. */
  readonly onRemoved: WorkerEvent<(tabId: TabId) => void>;
}

/** The parts of `chrome.alarms` the worker uses. */
export interface WorkerAlarmsEnvironment extends WorkerAlarmsApi {
  /** An alarm fired; only {@link KEEPALIVE_ALARM_NAME} is acted on. */
  readonly onAlarm: WorkerEvent<(alarm: { readonly name: string }) => void>;
}

/** The storage areas the worker uses. */
export interface WorkerStorageEnvironment {
  /** `chrome.storage.local`: the devtools credential, and its change event. */
  readonly local: CredentialStorageArea & {
    readonly onChanged?: CredentialStorageChangeEvent | undefined;
  };
  /** `chrome.storage.session`: the tab ↔ session bindings. */
  readonly session: TabRegistryStorageArea;
}

/** Everything {@link createWorker} needs, injected. */
export interface WorkerEnvironment {
  /** `chrome.runtime`. */
  readonly runtime: WorkerRuntimeApi;
  /** `chrome.tabs`. */
  readonly tabs: WorkerTabsApi;
  /** `chrome.alarms`. */
  readonly alarms: WorkerAlarmsEnvironment;
  /** `chrome.storage`. */
  readonly storage: WorkerStorageEnvironment;
  /** The platform `WebSocket` constructor. */
  readonly webSocketConstructor: WebSocketConstructorLike;
  /** One-shot timers with numeric handles. */
  readonly timers: WorkerTimerApi;
  /** The service's base URL; defaults to {@link DEFAULT_SERVICE_BASE_URL}. */
  readonly serviceBaseUrl?: string | undefined;
  /** Where diagnostics go; defaults to a console logger at `info`. */
  readonly logger?: Logger | undefined;
  /** The jitter source of the socket's backoff; defaults to `Math.random`. */
  readonly random?: (() => number) | undefined;
}

/**
 * The composed worker, returned so tests can drive and inspect it. The real
 * worker is created once, at module evaluation ({@link serviceWorker}).
 */
export interface DebugGeneratorWorker {
  /**
   * Settles once the cold-start work is done: bindings hydrated from
   * `chrome.storage.session`, the credential read and — when one is held —
   * the socket started. Never rejects.
   */
  readonly ready: Promise<void>;
  /**
   * The shared HTTP client in force — one instance at a time, so `setToken`
   * after pairing reaches every call. A getter: a changed service address
   * replaces the instance, with `defaultTimeoutMs` bounding every call that
   * names no deadline of its own. A composition handle for inspection: it is
   * not held back by the service-address gate the bridge applies, so the
   * worker's own requests go through {@link wsBridge}, never through it.
   */
  readonly httpClient: HttpClient;
  /** The devtools credential store. */
  readonly store: DevtoolsCredentialStore;
  /** The runtime-port hub. */
  readonly hub: PortHub;
  /** The tab ↔ session registry. */
  readonly registry: TabRegistry;
  /** The page-agent controller. */
  readonly agent: AgentControl;
  /** The socket and HTTP bridge to the local service. */
  readonly wsBridge: WsBridge;
  /** Remove every listener and subscription and release every resource. */
  readonly dispose: () => void;
}

/*
 * ===========================================================================
 * Section C — pure helpers
 * ===========================================================================
 */

/**
 * Query-redact a URL before the worker sends it to the service.
 *
 * The protocol requires `session.bind` and `tab.navigated` URLs to arrive
 * query-redacted by their producer (AAP §0.5.2); the page agent redacts the
 * URLs it reports, and this is the worker's equivalent for the URLs it reads
 * from `chrome.tabs` and the DevTools page. It follows the telemetry
 * convention: every query value becomes `?` with keys and order kept
 * (`a=1&b=2` → `a=?&b=?`), a bare flag stays bare, an empty value stays
 * empty, a non-empty fragment becomes `#?`, and userinfo is dropped. Scheme,
 * host, port and path are kept.
 *
 * A URL that is not HTTP(S) is never a page the worker binds; the service
 * needs only to see its origin change, and the path of a `data:` or `blob:`
 * URL can be page content, so only its scheme and host are kept.
 *
 * @param raw The URL as Chrome or the DevTools page reported it.
 * @returns The redacted absolute URL, or `undefined` when `raw` is not one.
 */
export function redactNavigationUrl(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (!BINDABLE_PROTOCOLS.includes(parsed.protocol)) {
    return parsed.host.length > 0 ? `${parsed.protocol}//${parsed.host}/` : parsed.protocol;
  }
  const query =
    parsed.search.length > 1
      ? `?${parsed.search.slice(1).split('&').map(maskQueryPair).join('&')}`
      : '';
  const fragment = parsed.hash.length > 1 ? '#?' : '';
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${query}${fragment}`;
}

/** One `key=value` query pair with its value masked; a bare flag stays bare. */
function maskQueryPair(pair: string): string {
  const separator = pair.indexOf('=');
  if (separator === -1) {
    return pair;
  }
  const key = pair.slice(0, separator);
  return separator === pair.length - 1 ? `${key}=` : `${key}=?`;
}

/**
 * The serialized origin of an HTTP(S) URL, or `undefined` for any other URL —
 * the only pages the worker ever asks the service to bind.
 */
function bindableOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return BINDABLE_PROTOCOLS.includes(parsed.protocol) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The shorter forms of a redacted URL to fall back to when the protocol's
 * binding schema refuses the full one (for its length): the path without the
 * query and fragment, then the origin's root. Derived rather than bounded by a
 * restated limit, so the schema remains the single statement of the bound.
 */
function urlFallbacks(redacted: string): readonly string[] {
  const candidates = [redacted];
  try {
    const parsed = new URL(redacted);
    if (parsed.host.length > 0) {
      candidates.push(`${parsed.protocol}//${parsed.host}${parsed.pathname}`);
      candidates.push(`${parsed.protocol}//${parsed.host}/`);
    }
  } catch {
    // `redacted` came from `redactNavigationUrl`, so it parses; nothing to add.
  }
  return candidates;
}

/**
 * The last URL and load status seen for one tab: what
 * {@link nextCommittedNavigation} de-duplicates a tab's navigation reports
 * against. Worker-generation memory, never persisted.
 */
export interface NavigationMemo {
  /** The tab's last committed URL, as far as its events have told. */
  readonly url: string | undefined;
  /** The last load `status` an event reported (`loading` or `complete`). */
  readonly status: string | undefined;
}

/** What one `chrome.tabs.onUpdated` event means for a tab's committed navigations. */
export interface NavigationStep {
  /** The memo to keep for the tab's next event. */
  readonly memo: NavigationMemo;
  /** The committed URL to report as `tab.navigated`, or `undefined` when the event reports none. */
  readonly url: string | undefined;
}

/**
 * Decide whether one `chrome.tabs.onUpdated` event reports a committed
 * navigation, so each committed load yields exactly one `tab.navigated` —
 * and, during a capture, exactly one "Page reloaded during capture" entry.
 *
 * `chrome.webNavigation` would name commits directly, but the manifest's
 * permission set is exactly `storage`, `alarms` and `tabs`, so the commit is
 * derived from `changeInfo` and the tab:
 *
 * - A changed `url` that differs from the remembered one is a commit — a
 *   cross-document one, or a same-document one through the history API — and
 *   is reported with that URL.
 * - A new `loading` cycle without a URL change is a reload, which commits a
 *   new document at the same URL, and is reported with the committed URL
 *   (`tab.url`, else the remembered one) — unless `tab.pendingUrl` names a
 *   different URL. Then the load is bound for another URL: nothing has
 *   committed yet, and its commit arrives as a `url` change.
 *
 * Chrome reports a URL-changing load in one of two orders, and each yields one
 * report: a single `{ status: 'loading', url }` event, reported by the `url`
 * rule; or `{ status: 'loading' }` when the load starts — `tab.url` still the
 * old committed URL, `tab.pendingUrl` the destination, so it reports nothing —
 * followed by `{ url }` at commit, reported with the committed URL. A pending
 * navigation that ends without a `url` change (stopped, a download, a `204`)
 * committed no document and reports nothing; so does one redirected back to
 * the committed URL, which `tabs.onUpdated` cannot tell apart from it.
 *
 * A repeated event of the same load is de-duplicated against the memo: a `url`
 * equal to the remembered one, or a second `loading` entry before the load
 * completes. A `loading` entry is never suppressed because a `url` event came
 * before it: a history-API change followed by a real reload is two
 * navigations, and both are reported.
 *
 * Pure: the caller keeps the returned memo for the tab's next event.
 *
 * @example
 * ```ts
 * // A link from /a to /b, reported in the split order — one navigation:
 * const loaded: NavigationMemo = { url: 'http://localhost:4400/a', status: 'complete' };
 * const started = nextCommittedNavigation(
 *   loaded,
 *   { status: 'loading' },
 *   { url: 'http://localhost:4400/a', pendingUrl: 'http://localhost:4400/b' },
 * ); // started.url === undefined: nothing has committed yet
 * const committed = nextCommittedNavigation(
 *   started.memo,
 *   { url: 'http://localhost:4400/b' },
 *   { url: 'http://localhost:4400/b' },
 * ); // committed.url === 'http://localhost:4400/b'
 * ```
 *
 * @param previous The memo the tab's previous event left, or `undefined` for its first.
 * @param changeInfo The event's change info.
 * @param tab The tab as the event reports it.
 * @returns The memo to keep and the committed URL to report, if any.
 */
export function nextCommittedNavigation(
  previous: NavigationMemo | undefined,
  changeInfo: WorkerTabChange,
  tab: WorkerTab,
): NavigationStep {
  const committedUrl = tab.url ?? previous?.url;
  const memo: NavigationMemo = {
    url: changeInfo.url ?? committedUrl,
    status: changeInfo.status ?? previous?.status,
  };
  if (changeInfo.url !== undefined) {
    return { memo, url: changeInfo.url === previous?.url ? undefined : changeInfo.url };
  }
  if (changeInfo.status !== 'loading' || previous?.status === 'loading') {
    return { memo, url: undefined };
  }
  const boundElsewhere = tab.pendingUrl !== undefined && tab.pendingUrl !== committedUrl;
  return { memo, url: boundElsewhere ? undefined : committedUrl };
}

/** The session's latest validated analysis: the last of `analyses`, oldest first. */
function latestAnalysis(record: SessionRecord): AnalysisResult | undefined {
  return record.analyses.length > 0 ? record.analyses[record.analyses.length - 1] : undefined;
}

/**
 * The tab a protocol payload names, when it names one that is a Chrome tab id
 * (a non-negative safe integer; `-1` is `chrome.tabs.TAB_ID_NONE`), or
 * `undefined` for a payload that names none.
 */
function payloadTabId(payload: unknown): TabId | undefined {
  if (!isPlainRecord(payload)) {
    return undefined;
  }
  const tabId = payload.tabId;
  return typeof tabId === 'number' && Number.isSafeInteger(tabId) && tabId >= 0 ? tabId : undefined;
}

/** Newest first: the ordering behind every "most recent connection" choice. */
function byNewest(left: WorkerConnection, right: WorkerConnection): number {
  return right.connectedAt - left.connectedAt;
}

/** The first error code of a `Result`, for a log line; `undefined` for `ok`. */
function errorCode(result: Result<unknown, DebuggenError>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

/** The name of a thrown value, for a log line that must not carry its message. */
function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause;
}

/** A promise and the function that fulfils it. */
interface Deferred<T> {
  /** Fulfils once, with the first value passed to {@link Deferred.resolve}. */
  readonly promise: Promise<T>;
  /** Fulfil the promise; every call after the first is ignored, as for any promise. */
  readonly resolve: (value: T) => void;
}

/**
 * A promise fulfilled from outside its executor — how a wait is settled by
 * whichever of several independent events (a frame, a timer, an abort) comes
 * first. The executor runs synchronously, so `resolve` is bound on return.
 */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((fulfil) => {
    resolve = fulfil;
  });
  return { promise, resolve };
}

/** Whether a connection is a DevTools panel document. */
function isPanelConnection(connection: WorkerConnection): connection is PanelConnection {
  return connection.role === PORT_PANEL;
}

/** Whether a connection is the devtools page of a DevTools window. */
function isDevtoolsConnection(connection: WorkerConnection): connection is DevtoolsConnection {
  return connection.role === PORT_DEVTOOLS;
}

/**
 * The page agent's reason to disarm a tab whose binding was removed, or
 * `undefined` when another path already returns it to dormant: a closed tab
 * has no agent left (`agent.clear` forgets it), and a cross-origin navigation
 * is handled by `agent.handleNavigationDecision`, which clears the
 * configuration rather than sending the old session's dormant one to a
 * document of another origin.
 */
function disarmReasonFor(change: TabBindingChange): DisarmReason | undefined {
  switch (change.cause) {
    case 'session-ended':
      return 'session-ended';
    case 'devtools-closed':
      return 'unbound';
    case 'tab-closed':
      return undefined;
    case undefined:
      if (change.reason === 'origin-changed') {
        return undefined;
      }
      return change.reason === 'replaced' ? 'displaced' : 'unbound';
  }
}

/**
 * Why a telemetry batch's context contradicts its tab's binding, or
 * `undefined` when it does not.
 *
 * The context only ever **rejects**: an absent field agrees with anything, a
 * capture is compared only when both sides name one, and nothing here chooses
 * or authorizes a session — the binding does that.
 *
 * @param context The session and capture the batch was produced for.
 * @param binding The tab's binding, as the registry holds it now.
 */
function telemetryContextConflict(
  context: TelemetryBatchContext,
  binding: TabBindingRecord,
): Exclude<TelemetryDropReason, 'unbound'> | undefined {
  if (context.sessionId !== undefined && context.sessionId !== binding.sessionId) {
    return 'session-mismatch';
  }
  if (
    context.captureId !== undefined &&
    binding.captureId !== undefined &&
    context.captureId !== binding.captureId
  ) {
    return 'capture-mismatch';
  }
  return undefined;
}

/** The protocol error codes a recognised `agent.error` is shown under. */
export type AgentErrorProtocolCode = Extract<
  ErrorPayload['code'],
  'CLEANUP_PARTIAL' | 'INSTRUMENTATION_UNAVAILABLE'
>;

/**
 * The protocol error code a recognised `agent.error` is shown under, in the
 * shared error vocabulary: the agent's kinds are its own, while the panel's
 * `error` state renders `DEBUGGEN_ERROR_CODES` members only.
 * `hooks-not-released` is a partial return to dormant; every other kind — an
 * unavailable signal or support family, a failed producer, an event or a
 * control frame the page channel could not carry — means a signal the capture
 * asked for is not being supplied in full.
 *
 * @param kind The frame's kind, as {@link pageAgentErrorKind} recognised it.
 */
function agentErrorCode(kind: PageAgentErrorKind): AgentErrorProtocolCode {
  return kind === 'hooks-not-released' ? 'CLEANUP_PARTIAL' : 'INSTRUMENTATION_UNAVAILABLE';
}

/** What the worker logs and shows for one recognised `agent.error`. */
export interface AgentErrorReport {
  /**
   * The frame's kind from the closed vocabulary — the only thing about the
   * frame a log line carries.
   */
  readonly kind: PageAgentErrorKind;
  /**
   * The protocol `error` payload the tab's panels are shown: the kind's
   * protocol code, its fixed public sentence and, only when the frame named a
   * canonical capture id, that id as `ref`.
   */
  readonly error: ErrorPayload;
}

/**
 * Classify a page agent's `agent.error` frame into what may be logged and
 * shown about it, or `undefined` when it is not something the agent emits.
 *
 * Every byte of the frame was produced in the page's realm, so a page script
 * can forge one with a URL, a token or any other private text in its `code`,
 * `reason` or `message` (CWE-532, AAP §0.5.2). Nothing the frame says is
 * therefore passed on as text: its kind is recognised against the closed
 * vocabulary of `../shared/messages` ({@link pageAgentErrorKind}), the panel
 * reads that kind's fixed sentence ({@link PAGE_AGENT_ERROR_PUBLIC_MESSAGES}),
 * and `captureId` becomes the correlation `ref` only when it has the exact
 * shape of a service-minted capture id ({@link isPageCaptureId}). The frame's
 * own `message` is never read.
 *
 * Pure and total for a recognised kind: the payload is validated against the
 * protocol's `error` schema, and should that schema ever refuse the `ref`, the
 * report is still made — without it.
 *
 * @example
 * ```ts
 * agentErrorReport({ code: 'hooks-not-released', message: 'anything', captureId: 'cap_0123456789abcdef' });
 * // → { kind: 'hooks-not-released',
 * //     error: { code: 'CLEANUP_PARTIAL', message: PAGE_AGENT_ERROR_PUBLIC_MESSAGES['hooks-not-released'],
 * //              ref: 'cap_0123456789abcdef' } }
 * agentErrorReport({ code: 'token=abc' }); // → undefined
 * ```
 *
 * @param payload The `agent.error` payload the bridge relayed.
 * @returns The kind and the panel's payload, or `undefined` for an
 * unrecognised frame, which is neither logged by value nor shown.
 */
export function agentErrorReport(
  payload: Readonly<Record<string, unknown>>,
): AgentErrorReport | undefined {
  const kind = pageAgentErrorKind(payload);
  if (kind === undefined) {
    return undefined;
  }
  const code = agentErrorCode(kind);
  const message = PAGE_AGENT_ERROR_PUBLIC_MESSAGES[kind];
  const captureId = payload.captureId;
  const withRef = isPageCaptureId(captureId)
    ? parseErrorPayload({ code, message, ref: captureId })
    : parseErrorPayload({ code, message });
  const error: ErrorPayload = withRef.ok ? withRef.value : { code, message };
  return { kind, error };
}

/**
 * The most telemetry events one tab may have waiting for the worker's cold
 * start ({@link DebugGeneratorWorker.ready}).
 *
 * The same bound as the page agent's own buffer (`MAX_BUFFERED_EVENTS` in
 * `packages/telemetry/src/browser/transport.ts`; AAP §0.5.5: "the agent
 * buffers up to 5 000 events in memory until the bridge returns"), so a
 * revival holds no more than the page would have held for it. It is restated
 * rather than imported because `@debuggen/telemetry` is a build-order
 * devDependency of this workspace, never a runtime one. The bound is per tab:
 * a page cannot use another tab's allowance, and one noisy page cannot starve
 * the rest.
 */
export const COLD_START_HELD_EVENTS_PER_TAB = 5000;

/**
 * The shortest interval between two telemetry-loss notices of one kind on
 * one tab's panels. Loss recorded inside the interval is accumulated and
 * shown when it ends, so a burst yields one notice, not one per batch.
 */
export const TELEMETRY_LOSS_NOTICE_INTERVAL_MS = 5000;

/**
 * Why telemetry a page produced is missing from the capture.
 *
 * - `undelivered` — the worker received the events and could not hand them
 *   to the service's socket: they arrived during a cold start beyond
 *   {@link COLD_START_HELD_EVENTS_PER_TAB}, or the socket client refused them
 *   after start-up (closed because the extension is not paired or its
 *   credential was refused, or a frame the protocol refused), or it queued
 *   them and then discarded them — dropped from its full outbound queue while
 *   the service was unreachable, or cleared with the queue when the
 *   credential was removed (`WsBridgeDeps.onTelemetryDropped`).
 * - `dropped-in-page` — the batch's `droppedCount` reports events lost before
 *   the batch left the page: the agent's buffer overflowed, or the content
 *   bridge's rate budget refused them. A loss-only report (no events) is such
 *   a batch too.
 */
export type TelemetryLossKind = 'undelivered' | 'dropped-in-page';

/** The protocol error codes a telemetry-loss notice is shown under. */
export type TelemetryLossProtocolCode = Extract<
  ErrorPayload['code'],
  'INSTRUMENTATION_UNAVAILABLE' | 'TRANSPORT_DISCONNECTED'
>;

/** The protocol code of each loss kind, in the shared error vocabulary. */
const TELEMETRY_LOSS_CODES: Readonly<Record<TelemetryLossKind, TelemetryLossProtocolCode>> =
  Object.freeze({
    undelivered: 'TRANSPORT_DISCONNECTED',
    'dropped-in-page': 'INSTRUMENTATION_UNAVAILABLE',
  });

/** "1 telemetry event" or "‹n› telemetry events". */
function telemetryEventCount(events: number): string {
  return events === 1 ? '1 telemetry event' : `${String(events)} telemetry events`;
}

/**
 * The protocol `error` payload that tells the developer telemetry is missing
 * from the capture: the kind's code and a fixed sentence whose only variable
 * is the number of events.
 *
 * Nothing the page sent is quoted. The number is the worker's own count, or —
 * for `dropped-in-page` — the batch's `droppedCount`, which the bridge port's
 * guard admits only as a safe non-negative integer. An `undelivered` count is
 * an upper bound, and says so: the socket client reports the first frame of
 * a batch it refused, not how many earlier frames of that batch it took.
 *
 * @example
 * ```ts
 * telemetryLossNotice('undelivered', 3);
 * // → { code: 'TRANSPORT_DISCONNECTED',
 * //     message: 'Telemetry from this page did not reach the local service (up to 3 telemetry events), so the capture is incomplete.' }
 * ```
 *
 * @param kind Why the events are missing.
 * @param events How many; a positive safe integer.
 * @returns A payload the protocol's strict `error` schema accepts.
 */
export function telemetryLossNotice(kind: TelemetryLossKind, events: number): ErrorPayload {
  const code = TELEMETRY_LOSS_CODES[kind];
  const count = telemetryEventCount(events);
  const message =
    kind === 'undelivered'
      ? `Telemetry from this page did not reach the local service (up to ${count}), so the capture is incomplete.`
      : `Telemetry was dropped inside the page before it was sent (${count}; its buffer or rate limit was exceeded), so the capture is incomplete.`;
  const parsed = parseErrorPayload({ code, message });
  return parsed.ok ? parsed.value : { code, message };
}

/**
 * The answer to a panel's `page.reload`, from the consented reload's outcome:
 * the reloaded document's readiness, or a failure in the shared error
 * vocabulary — `AGENT_NOT_READY` when no `agent.ready` arrived within the
 * bounded wait, `TAB_NOT_BOUND` when the tab could not be reloaded or was
 * forgotten mid-wait, `SESSION_INVALID_STATE` when no reload was offered.
 */
function pageReloadAnswer(outcome: ReloadOutcome): Result<PageReloadResult, DebuggenError> {
  switch (outcome.kind) {
    case 'ready': {
      const { documentId, installedBeforeReact, reactDetected } = outcome.readiness;
      return ok({ documentId, installedBeforeReact, reactDetected });
    }
    case 'timeout':
      return err(
        workerError(
          'AGENT_NOT_READY',
          `The reloaded page did not report its agent within ${String(outcome.timeoutMs)} ms.`,
          {
            hint: 'Wait for the page to finish loading, then reload it again from the panel.',
            details: { timeoutMs: outcome.timeoutMs },
          },
        ),
      );
    case 'no-tab':
      return err(
        workerError(
          'TAB_NOT_BOUND',
          outcome.reason === 'reload-failed'
            ? 'Chrome could not reload the inspected tab.'
            : 'The inspected tab closed or left the session while it reloaded.',
          {
            hint: 'Open DevTools on the application tab of this session.',
            details: { reason: outcome.reason },
          },
        ),
      );
    case 'not-consented':
      return err(
        workerError('SESSION_INVALID_STATE', 'The inspected page does not need a reload.', {
          hint: 'The page agent already observes this page.',
          details: { reason: outcome.reason },
        }),
      );
  }
}

/*
 * ===========================================================================
 * Section C2 — the `source.open` round trip
 *
 * A source click is answered by what the editor did, not by whether a socket
 * queued a frame: the service replies to every `source.open` with a
 * `source.result` correlated by `ref` (`opened`, `no-editor` or `failed`), or
 * refuses it with an `error` frame carrying the same `ref`. The worker waits
 * for the first of those, bounded by `SOURCE_OPEN_RESULT_TIMEOUT_MS` — which
 * `@debuggen/protocol` fixes above the service's own editor deadline and below
 * the port hub's twenty-second request ceiling, so the panel always receives a
 * source-open outcome rather than a generic port timeout.
 * ===========================================================================
 */

/** Everything {@link forwardSourceOpen} needs, injected so a unit suite can drive it with fakes. */
export interface SourceOpenForwardDeps {
  /** Sends the `source.open` frame: the socket bridge's `send`. */
  readonly send: ProtocolSend;
  /** Registers the `source.result` and `error` listeners: the socket bridge's `subscribe`. */
  readonly subscribe: ProtocolSubscribe;
  /** Arms and clears the answer deadline. */
  readonly timers: WorkerTimerApi;
  /**
   * Mints the id of the `source.open` envelope — the value its answer's `ref`
   * must equal. Defaults to `newMessageId`, whose ids fit the protocol's
   * 64-character `ref` bound; a replacement must keep to that bound.
   */
  readonly newId?: (() => string) | undefined;
  /**
   * How long to wait for the answer, in milliseconds. Defaults to
   * {@link SOURCE_OPEN_RESULT_TIMEOUT_MS}; a value that is not a positive
   * finite number is replaced by that default rather than arming a deadline
   * that fires at once or never.
   */
  readonly timeoutMs?: number | undefined;
  /** Where outcomes are logged — ids, statuses and codes only. Defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;
  /**
   * Reserves the id of every `source.open` this worker sends, **before** it is
   * sent, so the relay sink can withhold the service's correlated `error`
   * frame from the panels' general error state: that refusal is answered
   * through this request, whose failure the panel shows with fixed copy
   * (see {@link isAnsweredSourceOpenRefusal}). A full ledger refuses the
   * request before it is sent. Optional, so a unit suite can drive the round
   * trip without one.
   */
  readonly refs?: SourceOpenRefLedger | undefined;
  /**
   * The inspected tab the request acts for — the panel's associated tab —
   * sent as the frame's envelope `tabId`, which the service checks against its
   * live binding (AAP §0.5.6). Absent only in a unit suite that drives the
   * round trip without a tab.
   */
  readonly tabId?: TabId | undefined;
}

/** A positive safe-integer count the bridge put in a failure's `details`, else `0`. */
function detailCount(error: DebuggenError, key: string): number {
  const value = error.details?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * How many frames of an interrupted telemetry batch reached the socket — the
 * `framesWritten` plus `framesQueued` the bridge reports on the failure; `0`
 * for a failure that reports neither (the batch was refused before a frame).
 */
function framesHandedOver(error: DebuggenError): number {
  return detailCount(error, 'framesWritten') + detailCount(error, 'framesQueued');
}

/**
 * How many events of an interrupted telemetry batch the socket client took —
 * `eventsWritten` to the socket plus `eventsQueued` in its queue, whose later
 * discard the bridge reports itself (`WsBridgeDeps.onTelemetryFrameDiscarded`).
 * The batch is sent from its first event on every attempt, so this is the
 * length of the prefix one attempt handed over.
 */
function eventsHandedOver(error: DebuggenError): number {
  return detailCount(error, 'eventsWritten') + detailCount(error, 'eventsQueued');
}

/** `a + b`, capped at the largest safe integer, so a growing count stays a valid `droppedCount`. */
function addLossCounts(a: number, b: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, a + b);
}

/**
 * The pending-loss accumulator's key for a context: its session and capture,
 * an absent one included — so `{ ses, cap }`, `{ ses }` and `{}` are three
 * contexts, and a count is only ever carried under the one it was held under.
 */
function telemetryLossKey(context: TelemetryBatchContext): string {
  return JSON.stringify([context.sessionId ?? null, context.captureId ?? null]);
}

/**
 * Whether a lane job is a loss-only report: no events, only a count — the
 * page's `droppedCount` from the agent's terminal flush or the content bridge,
 * or (with a zero `droppedCount`) a report the worker scheduled for loss it
 * holds, whose count it takes from the accumulator when its turn comes. The
 * bridge sends it as one event-less `telemetry.event` frame. It names no
 * event, so nothing about it is ever shown as undelivered: the page's loss was
 * shown as `dropped-in-page` when it arrived, and the worker's when it
 * happened.
 */
function isLossReport(job: PendingTelemetryBatch): boolean {
  return job.events.length === 0;
}

/**
 * One tab's ordered lane of page agent frames — its `agent.ready` reports and
 * its telemetry batches: the promise its most recently queued frame settles
 * on, which the next frame of the tab chains after, and the counts the lane's
 * bounds are held to. It exists while frames of the tab are waiting and is
 * forgotten once none is. Mutable by design — it is the worker's private
 * bookkeeping, never shared or exposed.
 */
interface TelemetryLane {
  /** The last link of the tab's chain; the next frame runs after it. */
  tail: Promise<void>;
  /** Links enqueued and not yet finished, `agent.ready` included. */
  links: number;
  /** Batches queued or being forwarded; bounded by `MAX_PENDING_TELEMETRY_BATCHES_PER_TAB`. */
  pending: number;
  /**
   * Loss-only reports the worker scheduled for held loss, queued or being
   * forwarded; bounded by `MAX_PENDING_LOSS_CONTEXTS_PER_TAB`.
   */
  reports: number;
  /** Events of batches enqueued before start-up settled, not yet past it. */
  heldEvents: number;
  /**
   * Jobs queued or being forwarded — the page's batches and the worker's
   * loss-only reports alike — per {@link telemetryLossKey} of their pinned
   * context: a confirmed route schedules a loss-only report only for a
   * context no job on the lane will carry.
   */
  readonly queued: Map<string, number>;
}

/**
 * Where loss the service's ledger was not told of came from: the cold-start
 * hold, a full lane, a route not confirmed in time, a failed send, or a frame
 * the socket client queued and discarded. For the log line only.
 */
type PendingLossSource = 'cold-start-hold' | 'lane-full' | 'route' | 'send' | 'socket-queue';

/**
 * One tab's loss under one context that the service's producer-loss ledger
 * has not been told of, waiting to be carried as `droppedCount` — on the next
 * job of that context, or on a loss-only report once the service confirms
 * the tab's route. Mutable: the worker's private accumulator.
 */
interface PendingLoss {
  /** The session and capture the count belongs to, and the only ones it is sent under. */
  readonly context: TelemetryBatchContext;
  /** Events lost, capped at the largest safe integer. */
  count: number;
}

/** Why a lane dropped a batch it had accepted, before any send was attempted. */
type TelemetryDropReason = 'unbound' | 'session-mismatch' | 'capture-mismatch';

/** The page agent's `telemetry.batch` events, as the bridge port delivered them. */
type BridgeTelemetryEvents = PageTelemetryBatchPayload['events'];

/**
 * One tab's burst of one kind of telemetry loss, shown at most once per
 * {@link TELEMETRY_LOSS_NOTICE_INTERVAL_MS}. It ends when an interval passes
 * with no further loss and its last notice reached a panel; until one has,
 * it is kept, and shown again once a panel of the tab is connected.
 */
interface LossEpisode {
  /** Events lost since the burst began, capped at the largest safe integer. */
  total: number;
  /** The total the last notice showed. */
  shown: number;
  /** The timer that ends the current interval. */
  cooldown: number | undefined;
  /**
   * Whether the last notice reached at least one panel of the tab. `false`
   * until its push has resolved, and after a push that found no panel.
   */
  seen: boolean;
  /** How many notices of the burst were issued; orders their pushes' answers. */
  notices: number;
}

/**
 * The session and capture a telemetry batch belongs to, as far as they are
 * known: the page agent's own stamp on the batch (context only — it can
 * reject a batch, never route one), or what the lane verified before a send.
 */
interface TelemetryBatchContext {
  /** The session the batch was produced for, when known. */
  readonly sessionId: SessionId | undefined;
  /** The capture the batch was produced for, when known. */
  readonly captureId: PageTelemetryBatchPayload['captureId'];
}

/**
 * A batch's overall delivery deadline: a signal the injected timers abort
 * {@link TELEMETRY_ROUTE_WAIT_MS} after the batch arrived, and the release
 * that clears the timer once the batch has settled.
 */
interface TelemetryDeadline {
  /** Aborted when the deadline passes. */
  readonly signal: AbortSignal;
  /** Clear the deadline's timer; idempotent. */
  readonly release: () => void;
}

/**
 * One job waiting on its tab's lane — a page batch, or a loss-only report the
 * worker scheduled for loss it holds — with everything pinned when it was
 * **queued**: its events, its context and its deadline. Nothing here is
 * re-read from the page later.
 */
interface PendingTelemetryBatch {
  /** The tab the batch came from — the bridge port's sender. */
  readonly tabId: TabId;
  /** The raw events, forwarded untouched; empty for a loss-only report. */
  readonly events: PageTelemetryBatchPayload['events'];
  /**
   * Events the page lost since its previous loss report — zero in a report
   * the worker scheduled. Forwarded, with the held loss of the job's context
   * the job takes over at its send, as the first frame's `droppedCount`, or —
   * with no events — as the whole of a loss-only report ({@link isLossReport}).
   */
  readonly droppedCount: number;
  /**
   * The page agent's session and capture stamp, pinned at arrival; for a
   * report the worker scheduled, the context of the loss it carries.
   */
  readonly context: TelemetryBatchContext;
  /** The job's one overall deadline, started when it was queued. */
  readonly deadline: TelemetryDeadline;
}

/**
 * The ids of the `source.open` frames this worker sent whose answer can still
 * arrive, kept so the relay sink can recognise the service's refusal of one.
 *
 * The service answers a `source.open` its handler refuses with a `failed`
 * `source.result`, which is relayed to no panel. Only a frame refused before
 * the handler runs — payload validation, the sender's role, its tab's
 * binding — is answered with an `error` frame, whose sentence quotes nothing
 * from the request. That frame is session-less, and the port hub broadcasts a
 * session-less relayed frame to every panel, whose session store would record
 * it as its last failure — in another tab's panel too. The request itself
 * settles on that frame, so the relay sink withholds it instead, and it can
 * only do so while the id is here.
 *
 * So an id is **never evicted** while its answer can still arrive. It leaves
 * only when:
 *
 * - its answer arrived — a `source.result`, or the `error` the relay sink
 *   withholds;
 * - its frame was never sent (the socket client refused it); or
 * - the socket it was written to closed ({@link socketClosed}): the service
 *   answers a frame on the connection it arrived on, so nothing can answer it
 *   any more. A frame the client queued instead is written when the next
 *   socket opens ({@link socketOpened}), and only then does that rule apply.
 *
 * The ledger is bounded by refusing, not by forgetting: {@link reserve}
 * answers `false` once {@link SOURCE_OPEN_MAX_OUTSTANDING} ids await an
 * answer, and the caller must then refuse the request **before** anything is
 * sent (see {@link forwardSourceOpen}).
 */
export interface SourceOpenRefLedger {
  /**
   * Reserve an id for a `source.open` about to be sent, in the `queued` state
   * (on no socket yet). `false` when the ledger is full — nothing was
   * recorded, and the request must not be sent.
   */
  reserve(ref: string): boolean;
  /**
   * Record what the socket client did with the reserved frame: `'sent'` means
   * it was written to the open socket; `'queued'` means it waits for the next
   * one. An id not reserved is ignored.
   */
  sent(ref: string, outcome: SendOutcome): void;
  /** Whether `ref` is the id of a sent `source.open` whose answer can still arrive. */
  has(ref: string): boolean;
  /** The answer to `ref` arrived, or its frame was never sent: forget it. */
  forget(ref: string): void;
  /**
   * The socket client's queue is empty on an open socket: every queued frame
   * has been written to it, so every queued id is now on that socket.
   */
  socketOpened(): void;
  /**
   * The socket closed: forget every id whose frame was written to it. Queued
   * ids stay, since their frames go out on the next socket.
   */
  socketClosed(): void;
  /** How many ids await an answer. */
  readonly size: number;
}

/**
 * How many `source.open` requests may await an answer at once. Answered ids
 * leave at once, and ids on a closed socket with them, so the bound is reached
 * only by that many clicks the service has not answered yet — far beyond what
 * a developer clicks — and the request past it is refused before it is sent
 * rather than displacing an id whose refusal could still arrive.
 */
export const SOURCE_OPEN_MAX_OUTSTANDING = 256;

/**
 * The failure a `source.open` is refused with, before anything is sent, while
 * {@link SOURCE_OPEN_MAX_OUTSTANDING} requests await an answer.
 */
function sourceOpenSaturatedError(outstanding: number): DebuggenError {
  return workerError(
    'RATE_LIMITED',
    'Too many source-open requests are still waiting for the local service to answer.',
    {
      hint: 'Wait a few seconds for the pending source links to open, then click again.',
      details: { outstanding, limit: SOURCE_OPEN_MAX_OUTSTANDING },
    },
  );
}

/**
 * Build a {@link SourceOpenRefLedger} holding at most `capacity` ids that
 * await an answer. It never evicts one: past the bound, {@link
 * SourceOpenRefLedger.reserve} refuses.
 *
 * @param capacity The number of ids kept; a value that is not a positive
 * integer is replaced by {@link SOURCE_OPEN_MAX_OUTSTANDING}.
 */
export function createSourceOpenRefLedger(
  capacity: number = SOURCE_OPEN_MAX_OUTSTANDING,
): SourceOpenRefLedger {
  const limit = Number.isInteger(capacity) && capacity > 0 ? capacity : SOURCE_OPEN_MAX_OUTSTANDING;
  /** Each id with where its frame is: written to the open socket, or queued for the next. */
  const refs = new Map<string, 'written' | 'queued'>();
  return Object.freeze({
    reserve(ref: string): boolean {
      if (refs.has(ref)) {
        // Ids are unique random values; a repeat is still one request.
        return true;
      }
      if (refs.size >= limit) {
        return false;
      }
      refs.set(ref, 'queued');
      return true;
    },
    sent(ref: string, outcome: SendOutcome): void {
      if (refs.has(ref)) {
        refs.set(ref, outcome === 'sent' ? 'written' : 'queued');
      }
    },
    has(ref: string): boolean {
      return refs.has(ref);
    },
    forget(ref: string): void {
      refs.delete(ref);
    },
    socketOpened(): void {
      for (const ref of refs.keys()) {
        refs.set(ref, 'written');
      }
    },
    socketClosed(): void {
      for (const [ref, where] of [...refs]) {
        if (where === 'written') {
          refs.delete(ref);
        }
      }
    },
    get size(): number {
      return refs.size;
    },
  });
}

/** The two socket facts {@link createSourceOpenSocketTracker} reads. */
export type SourceOpenSocketStatus = Pick<WsBridgeStatus, 'transport' | 'queuedFrameCount'>;

/**
 * Keep a {@link SourceOpenRefLedger} in step with the socket. The returned
 * function is called at every status snapshot the socket bridge publishes —
 * the bridge publishes on every transport change.
 *
 * When the socket stops being open, the ids written to it are forgotten: the
 * service answers a frame on the connection it arrived on, so nothing can
 * answer them any more. When it opens, the ids whose frames were queued are
 * moved onto it once the socket client's queue has drained — checked at once
 * and again on the next task, since the client flushes its queue as the
 * socket opens. Until then they stay queued, which only keeps them longer.
 *
 * @param refs The worker's ledger of `source.open` ids awaiting an answer.
 * @param status The socket's current state and queue length, or `undefined`
 * before the bridge exists or after the worker was disposed.
 * @param timers Schedules the next-task check.
 * @param logger Where a close's forgotten count is logged — counts only.
 * @returns The observer to call at every published status snapshot.
 */
export function createSourceOpenSocketTracker(
  refs: SourceOpenRefLedger,
  status: () => SourceOpenSocketStatus | undefined,
  timers: WorkerTimerApi,
  logger: Logger = noopLogger,
): () => void {
  let wasOpen = false;

  /** Move the queued ids onto the open socket once its queue is empty. */
  const promoteQueued = (): void => {
    const current = status();
    if (current !== undefined && current.transport === 'open' && current.queuedFrameCount === 0) {
      refs.socketOpened();
    }
  };

  return () => {
    const current = status();
    if (current === undefined) {
      return;
    }
    const open = current.transport === 'open';
    if (open) {
      promoteQueued();
      if (!wasOpen) {
        timers.setTimeout(promoteQueued, 0);
      }
    } else if (wasOpen) {
      const before = refs.size;
      refs.socketClosed();
      logger.debug('Forgot the source-open ids written to a closed socket.', {
        forgotten: before - refs.size,
        outstanding: refs.size,
      });
    }
    wasOpen = open;
  };
}

/**
 * Whether a relayed frame is the service's `error` refusal of a `source.open`
 * this worker sent — one the relay sink withholds from the panels, because the
 * request it refuses already carries it to the panel (see
 * {@link SourceOpenRefLedger}). Every other frame, including an `error` with no
 * `ref` or with another request's, is relayed as before.
 *
 * @param message A frame the socket bridge is about to relay.
 * @param refs The worker's ledger of sent `source.open` ids.
 */
export function isAnsweredSourceOpenRefusal(
  message: RelayedProtocolMessage,
  refs: Pick<SourceOpenRefLedger, 'has'>,
): boolean {
  if (message.type !== 'error') {
    return false;
  }
  const { ref } = message.payload;
  return ref !== undefined && refs.has(ref);
}

/**
 * Wrap the socket bridge's relay sink so the service's `error` refusal of a
 * sent `source.open` never reaches the panels: it is withheld, and its id
 * forgotten, since that frame is the request's answer. Every other frame goes
 * to `relay` unchanged, in order.
 *
 * @param refs The worker's ledger of unanswered `source.open` ids.
 * @param relay The sink every other frame goes to (the port hub's `relayPush`).
 * @param logger Where a withheld frame is logged — its type and code only.
 * @returns A {@link RelayPush} for `createWsBridge`.
 */
export function createSourceOpenRelayFilter(
  refs: SourceOpenRefLedger,
  relay: RelayPush,
  logger: Logger = noopLogger,
): RelayPush {
  return (message, tabId) => {
    if (message.type === 'error' && isAnsweredSourceOpenRefusal(message, refs)) {
      const { ref, code } = message.payload;
      if (ref !== undefined) {
        refs.forget(ref);
      }
      logger.debug('Withheld a source-open refusal from the panels; its request answers it.', {
        type: message.type,
        errorCode: code,
      });
      return;
    }
    relay(message, tabId);
  };
}

/**
 * The `source.open` port answer: `ok({ forwarded })` or a typed failure.
 *
 * `forwarded: true` — the editor confirmed it opened the location.
 * `forwarded: false` — no VS Code window is connected; the panel hands the
 * location to the editor-open URI instead.
 *
 * A refusal, an editor failure and the deadline are typed failures carrying
 * the request's `ref` in `details`. `portErr` drops every `details` field but a
 * capture conflict's owning session, so the `ref` is logged here and never
 * reaches the panel, which mints its own reference for an unexpected failure.
 */
export type SourceOpenForwardResult = Result<PortResponsePayloads['source.open'], DebuggenError>;

/** The failure reason recorded (in `details.reason`) when no answer arrived in time. */
export const SOURCE_OPEN_TIMEOUT_REASON = 'source-open-timeout';

/** The failure reason recorded when the panel's request was cancelled first. */
export const SOURCE_OPEN_ABORTED_REASON = 'source-open-aborted';

/** The failure for a request whose deadline passed with no correlated answer. */
function sourceOpenTimeoutError(ref: string, timeoutMs: number): DebuggenError {
  return workerError(
    'TRANSPORT_DISCONNECTED',
    'The local Debug Generator service did not answer the source-open request in time.',
    {
      hint: 'Check that the local service is running and VS Code is connected to it, then click the source link again.',
      details: { reason: SOURCE_OPEN_TIMEOUT_REASON, ref, timeoutMs },
    },
  );
}

/**
 * The failure for a request the port hub cancelled — the panel disconnected, or
 * the hub's own request ceiling passed. The hub answers (or drops) the port
 * request itself in both cases, so this value only ends the wait.
 */
function sourceOpenAbortedError(ref: string, reason: unknown): DebuggenError {
  return workerError(
    'TRANSPORT_DISCONNECTED',
    'The source-open request was cancelled before the local service answered.',
    { details: { reason: SOURCE_OPEN_ABORTED_REASON, ref }, cause: reason },
  );
}

/**
 * The sentence a `failed` `source.result` reaches the panel with. The
 * service's own sentence and hint are not forwarded: a refusal's text can
 * quote the refused path, and the panel chooses what to show from the code
 * alone (`../panel/actions.ts`), so nothing past the code is needed there.
 */
export const SOURCE_OPEN_FAILED_MESSAGE =
  'The local Debug Generator service could not open the source location.';

/** The sentence a correlated `error` refusal reaches the panel with, for the same reason. */
export const SOURCE_OPEN_REFUSED_MESSAGE =
  'The local Debug Generator service refused the source-open request.';

/**
 * Map the service's `source.result` onto the port answer.
 *
 * A failure keeps the service's code from the closed vocabulary, with the
 * request's `ref` in `details`, and carries {@link SOURCE_OPEN_FAILED_MESSAGE}
 * in place of the service's sentence and hint (see there).
 */
function sourceResultOutcome(result: SourceResultPayload, log: Logger): SourceOpenForwardResult {
  const fields = { sessionId: result.sessionId, ref: result.ref, status: result.status };
  switch (result.status) {
    case 'opened':
      log.info('The editor opened a source location.', fields);
      return ok({ forwarded: true });
    case 'no-editor':
      log.info('No editor is connected; the panel falls back to the editor-open URI.', fields);
      return ok({ forwarded: false });
    case 'failed': {
      const { code } = result.error;
      log.warn('A source-open request failed.', { ...fields, errorCode: code });
      return err(workerError(code, SOURCE_OPEN_FAILED_MESSAGE, { details: { ref: result.ref } }));
    }
  }
}

/**
 * Forward a panel's `source.open` to the local service and wait for the answer
 * that belongs to it.
 *
 * The sequence, in the order that makes it race-free:
 *
 * 1. Mint the frame id. A request already cancelled is answered at once and
 *    nothing is sent. Reserve the id in `deps.refs` next: while
 *    {@link SOURCE_OPEN_MAX_OUTSTANDING} requests await an answer the ledger
 *    refuses, and the request is answered `RATE_LIMITED` **before** anything
 *    is sent — never by displacing an id whose refusal could still arrive.
 * 2. Subscribe to `source.result` and `error` **before** sending, so an answer
 *    cannot arrive between the send and the subscription. Only a frame whose
 *    `payload.ref` equals the id is considered; a `source.result` must also
 *    name the request's session, and one naming another is ignored (and
 *    logged) rather than settling someone else's click.
 * 3. Send `source.open` with that id, and record in `deps.refs` whether the
 *    socket client wrote it or queued it for the next socket. The
 *    payload is forwarded unmodified: the service validates the location
 *    against the session's project root, and VS Code validates it again (AAP
 *    §0.4.2). A send the socket client refuses — it is closed, or not yet
 *    connected — is answered with its own failure.
 * 4. Settle on the first of: the correlated `source.result`, the correlated
 *    `error` frame, the deadline, or `signal` aborting. A settle-once latch
 *    makes every later arrival a no-op, and every exit path removes both
 *    subscriptions, the abort listener and the timer. The id leaves
 *    `deps.refs` when a `source.result` answers it or the send failed; after
 *    a deadline or a cancellation it stays, because its answer may still
 *    arrive, and a correlated `error` is forgotten by the relay sink that
 *    withholds it. The worker forgets the ids written to a socket once that
 *    socket closes, since nothing can answer them any more
 *    ({@link SourceOpenRefLedger.socketClosed}).
 *
 * Never rejects: an unexpected throw from an injected dependency is answered
 * as an `INTERNAL` failure, after the same clean-up. Logs carry the session
 * id, the `ref`, the status and the error code — never the location.
 *
 * @example
 * ```ts
 * const answer = await forwardSourceOpen(
 *   { send: wsBridge.send, subscribe: wsBridge.subscribe, timers, logger: log },
 *   { sessionId, location },
 *   context.signal,
 * );
 * // ok({ forwarded: true }) — opened; ok({ forwarded: false }) — no editor.
 * ```
 *
 * @param deps The socket's send and subscribe, the timers, and optional id
 * source, deadline, logger and outstanding-id ledger.
 * @param payload The panel's `source.open` payload, forwarded as it is.
 * @param signal Aborts the wait when the port hub cancels the panel's request.
 * @returns The port answer; see {@link SourceOpenForwardResult}.
 */
export function forwardSourceOpen(
  deps: SourceOpenForwardDeps,
  payload: MessagePayload<'source.open'>,
  signal?: AbortSignal,
): Promise<SourceOpenForwardResult> {
  const log = deps.logger ?? noopLogger;
  const { sessionId } = payload;
  const timeoutMs =
    deps.timeoutMs !== undefined && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
      ? deps.timeoutMs
      : SOURCE_OPEN_RESULT_TIMEOUT_MS;
  const id = (deps.newId ?? newMessageId)();

  if (signal?.aborted === true) {
    log.debug('A source-open request was cancelled before it was sent.', { sessionId, ref: id });
    return Promise.resolve(err(sourceOpenAbortedError(id, signal.reason)));
  }

  // Reserved before the listeners and the send, so a refusal the transport
  // delivers synchronously is already recognised by the relay sink — and so a
  // full ledger refuses this request before anything reaches the service.
  if (deps.refs !== undefined && !deps.refs.reserve(id)) {
    const outstanding = deps.refs.size;
    log.warn('A source-open request was refused: too many await an answer.', {
      sessionId,
      ref: id,
      errorCode: 'RATE_LIMITED',
      outstanding,
    });
    return Promise.resolve(err(sourceOpenSaturatedError(outstanding)));
  }

  return new Promise<SourceOpenForwardResult>((resolve) => {
    // One mutable record rather than separate `let`s: the timer handle is
    // written after the closures below exist, and a timer API that fires
    // synchronously must still find the latch closed. `handedOver` records
    // whether `send` was reached, which decides whether the id may be
    // forgotten when something throws.
    const latch: { settled: boolean; timer: number | undefined; handedOver: boolean } = {
      settled: false,
      timer: undefined,
      handedOver: false,
    };
    const releases: (() => void)[] = [];

    /** Answer once, releasing every listener and the timer first. */
    const settle = (outcome: SourceOpenForwardResult): void => {
      if (latch.settled) {
        return;
      }
      latch.settled = true;
      if (latch.timer !== undefined) {
        deps.timers.clearTimeout(latch.timer);
        latch.timer = undefined;
      }
      for (const release of releases.splice(0)) {
        try {
          release();
        } catch (cause: unknown) {
          log.warn('Releasing a source-open listener failed.', {
            ref: id,
            error: errorName(cause),
          });
        }
      }
      resolve(outcome);
    };

    try {
      releases.push(
        deps.subscribe(MESSAGE_TYPE.SOURCE_RESULT, (message) => {
          const result = message.payload;
          if (result.ref !== id) {
            return;
          }
          if (result.sessionId !== sessionId) {
            log.warn('A source.result for this request named another session; it was ignored.', {
              sessionId,
              ref: id,
            });
            return;
          }
          // A `source.result` is relayed to no panel, so its id can go now.
          deps.refs?.forget(id);
          settle(sourceResultOutcome(result, log));
        }),
        deps.subscribe(MESSAGE_TYPE.ERROR, (message) => {
          const refusal = message.payload;
          if (refusal.ref !== id) {
            return;
          }
          log.warn('The local service refused a source-open request.', {
            sessionId,
            ref: id,
            errorCode: refusal.code,
          });
          settle(
            err(workerError(refusal.code, SOURCE_OPEN_REFUSED_MESSAGE, { details: { ref: id } })),
          );
        }),
      );

      if (signal !== undefined) {
        const onAbort = (): void => {
          log.debug('A source-open request was cancelled while waiting for its answer.', {
            sessionId,
            ref: id,
          });
          settle(err(sourceOpenAbortedError(id, signal.reason)));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        releases.push(() => {
          signal.removeEventListener('abort', onAbort);
        });
      }

      latch.handedOver = true;
      const sent: Result<SendOutcome, DebuggenError> = deps.send(
        MESSAGE_TYPE.SOURCE_OPEN,
        payload,
        deps.tabId === undefined ? { id } : { id, tabId: deps.tabId },
      );
      if (!sent.ok) {
        log.warn('A source.open request could not be forwarded.', {
          sessionId,
          ref: id,
          errorCode: sent.error.code,
        });
        // Never sent, so never answered.
        deps.refs?.forget(id);
        settle(err(sent.error));
        return;
      }
      // Written to the open socket, or queued for the next one: which decides
      // when a closed socket makes the id unanswerable.
      deps.refs?.sent(id, sent.value);
      if (latch.settled) {
        // Answered while the frame was being handed over.
        return;
      }
      log.debug('A source.open request was forwarded; waiting for its result.', {
        sessionId,
        ref: id,
        outcome: sent.value,
      });
      const handle = deps.timers.setTimeout(() => {
        log.warn('A source-open request received no answer in time.', {
          sessionId,
          ref: id,
          errorCode: 'TRANSPORT_DISCONNECTED',
          timeoutMs,
        });
        settle(err(sourceOpenTimeoutError(id, timeoutMs)));
      }, timeoutMs);
      if (latch.settled) {
        deps.timers.clearTimeout(handle);
      } else {
        latch.timer = handle;
      }
    } catch (cause: unknown) {
      log.error('Forwarding a source-open request failed unexpectedly.', {
        sessionId,
        ref: id,
        error: errorName(cause),
      });
      if (!latch.handedOver) {
        // Nothing was sent, so nothing can answer it. Once `send` was reached
        // the frame may have gone out, so the id stays until its socket closes.
        deps.refs?.forget(id);
      }
      settle(
        err(
          DebuggenError.is(cause)
            ? cause
            : workerError('INTERNAL', 'The worker could not forward the source-open request.', {
                details: { ref: id },
                cause,
              }),
        ),
      );
    }
  });
}

/*
 * ===========================================================================
 * Section D — the composition
 * ===========================================================================
 */

/** What the worker needs to ask the service to bind one tab. */
interface BindTarget {
  /** The tab's query-redacted URL. */
  readonly url: string;
  /** The tab's HTTP(S) origin. */
  readonly origin: string;
}

/** The parts of a bound session the panel renders from, as far as they exist. */
interface SessionDetails {
  readonly session?: SessionRecord;
  readonly panel?: PanelSpec;
  readonly analysis?: AnalysisResult;
}

/**
 * The {@link SessionDetails} one read produced, and the first failure among
 * its reads — kept apart so a snapshot answer spreads the details only.
 */
interface SessionDetailsRead {
  readonly details: SessionDetails;
  readonly failure: DebuggenError | undefined;
}

/** The protocol push that carries a relayed envelope. */
type ProtocolPush = Extract<PortPush, { readonly kind: 'protocol' }>;

/**
 * How one selection was settled.
 *
 * - `accepted` — the descriptor is the session's recorded target: it already
 *   was before anything was sent (`via: 'already-recorded'`, and no frame was
 *   sent), or the service recorded it — observed as the matching
 *   `session.updated` (`via: 'session.updated'`), or read back from the stored
 *   session after nothing answered (`via: 'verified'`).
 * - `refused` — the service answered with an `error` whose `ref` is the frame's
 *   id; `error` carries the service's code and message.
 * - `unconfirmed` — no verdict arrived and the stored session does not carry
 *   the descriptor: the frame was lost, the socket did not open before the
 *   delivery deadline (and the frame was never sent), or the request was
 *   abandoned.
 * - `unsent` — the socket is closed rather than reconnecting, or the socket
 *   client refused the frame outright.
 */
type SelectionVerdict =
  | {
      readonly kind: 'accepted';
      readonly via: 'already-recorded' | 'session.updated' | 'verified';
    }
  | { readonly kind: 'refused'; readonly error: DebuggenError }
  | { readonly kind: 'unconfirmed'; readonly error: DebuggenError }
  | { readonly kind: 'unsent'; readonly error: DebuggenError };

/** What ended the wait for a verdict frame: one of the two answers, or neither. */
type SelectionAnswer =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'refused'; readonly payload: ErrorPayload }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' };

/**
 * What ended a held selection's wait for an open socket: the socket opened,
 * it closed for good (no reconnect is coming), the delivery deadline passed,
 * or the panel that asked went away.
 */
type TransportWait = 'open' | 'closed' | 'timeout' | 'aborted';

/** A one-shot timer on the injected timers, observed as a promise. */
interface Countdown {
  /** Fulfils when the timer fires; never settles once {@link Countdown.cancel} ran first. */
  readonly elapsed: Promise<undefined>;
  /** Release the timer if it has not fired. Idempotent. */
  readonly cancel: () => void;
}

/**
 * Compose the worker: construct every background module once, wire them to
 * one another through injected callbacks, register every Chrome listener and
 * socket subscription **synchronously**, then start the cold-start work.
 *
 * Side-effect-free apart from what it is given: every listener is added to an
 * event of `env`, and {@link DebugGeneratorWorker.dispose} removes them all.
 *
 * @example
 * ```ts
 * // A unit test drives the composition against fakes:
 * const worker = createWorker({ runtime, tabs, alarms, storage, webSocketConstructor, timers });
 * await worker.ready;
 * ```
 *
 * @param env The Chrome surfaces, the socket constructor and the timers.
 * @returns The composed worker.
 */
export function createWorker(env: WorkerEnvironment): DebugGeneratorWorker {
  const rootLogger = env.logger ?? createConsoleLogger({ name: 'extension', level: 'info' });
  const log = rootLogger.child({ component: 'service-worker' });
  /**
   * The service address used when none is stored: the environment's, else
   * `DEFAULT_SERVICE_BASE_URL`. A stored setting (`SERVICE_ENDPOINT_STORAGE_KEY`,
   * written by the pairing dialog) takes precedence over both.
   */
  const serviceBaseUrl = env.serviceBaseUrl ?? DEFAULT_SERVICE_BASE_URL;
  const { runtime, tabs, alarms, storage, timers } = env;

  // Worker-generation memory. None of it is persisted, because all of it is
  // rebuilt by what follows a revival: a DevTools page re-sends its hello when
  // its port reconnects, Chrome keeps reporting tab events, and the bindings
  // themselves live in `chrome.storage.session` behind the registry.
  /** Tabs whose DevTools page announced itself, with what binding them needs. */
  const announcedTabs = new Map<TabId, BindTarget>();
  /** The last URL and load status seen per tab. */
  const navigationMemo = new Map<TabId, NavigationMemo>();
  /**
   * Panel connections that asked for a `session.snapshot` without naming an
   * inspected tab and are still unassociated: the only panels a DevTools page
   * announced later may adopt ({@link adoptWaitingPanel}). A panel that has
   * not asked yet is never among them — it may still name its own tab. An id
   * leaves the set when its panel is associated or disconnects.
   */
  const untabbedPanels = new Set<WorkerConnectionId>();
  /** Undo actions for every listener and subscription, run by `dispose`. */
  const teardown: (() => void)[] = [];
  /**
   * Each tab's ordered lane of page agent frames — see `inTabOrder` — present
   * only while it has a frame pending.
   */
  const telemetryLanes = new Map<TabId, TelemetryLane>();
  /**
   * Each tab's latest `agent.ready` still waiting in its lane, until it has
   * recorded the document's readiness. A `target.described` waits for it, so
   * a pick that follows its own document's report is compared with the memo
   * that report writes — not with the previous document's, which the lane
   * (queued behind that tab's earlier batches) may not have replaced yet.
   */
  const readinessInFlight = new Map<TabId, Promise<void>>();
  /** Per tab and loss kind: the burst being shown — see `recordTelemetryLoss`. */
  const lossEpisodes = new Map<TabId, Map<TelemetryLossKind, LossEpisode>>();
  /**
   * Per tab, per {@link telemetryLossKey}: loss the service's producer-loss
   * ledger has not been told of — see `holdPendingLoss`. Oldest context first
   * (insertion order), at most {@link MAX_PENDING_LOSS_CONTEXTS_PER_TAB} per
   * tab. Worker-generation memory like the lanes, so it is carried at the
   * first opportunity rather than kept.
   */
  const pendingLoss = new Map<TabId, Map<string, PendingLoss>>();
  /** Whether `ready` has settled; until then telemetry is held within a bound. */
  let coldStartSettled = false;
  /** Batches dropped since start because their tab's lane was full. */
  let telemetryOverflowCount = 0;
  /** Batches accepted onto a lane since start and then not delivered. */
  let telemetryLossCount = 0;
  /** Held loss abandoned since start: too many contexts, a closed tab, or no route for its context. */
  let abandonedLossCount = 0;
  /**
   * The checks of the selections held for an open socket, run on every status
   * the bridge publishes — the transport opening is always one of them.
   */
  const transportWatchers = new Set<() => void>();
  /** The pill status last published, to detect the transition to `connected`. */
  let lastPublishedStatus: WorkerStatusSnapshot['status'] | undefined;
  /** The `source.open` ids this generation sent whose answer can still arrive. */
  const sourceOpenRefs: SourceOpenRefLedger = createSourceOpenRefLedger();
  /**
   * The socket bridge, once constructed: read by the ledger's socket tracking,
   * which the bridge can call into while it is still being constructed.
   */
  const socketHolder: { bridge: WsBridge | undefined } = { bridge: undefined };
  let disposed = false;

  /**
   * Run a task without awaiting it. Every sibling method fulfils rather than
   * rejects; this still guarantees no rejection escapes a Chrome listener.
   */
  function background(task: Promise<unknown>, what: string): void {
    task.then(undefined, (cause: unknown) => {
      log.error('A background task failed.', { task: what, error: errorName(cause) });
    });
  }

  // -------------------------------------------------------------------------
  // The shared HTTP client and the credential store
  // -------------------------------------------------------------------------

  /**
   * One client for the whole worker at a time, for the service address in
   * force. Its token delegates to the credential store, and the store redeems
   * pairing codes through the client: a mutual reference, resolved with thunks
   * that are dereferenced only inside calls, by which time both exist. Every
   * consumer — the store, `ws-bridge.ts`, {@link DebugGeneratorWorker.httpClient}
   * — reads it through a thunk, so the store's post-pairing `setToken` reaches
   * every call, and a changed address ({@link applyServiceEndpoint}) replaces
   * the client for every caller at once. A rebuilt client authenticates the
   * same way: its token is the same delegation to the store.
   */
  function buildHttpClient(baseUrl: string): HttpClient {
    return new HttpClient({
      baseUrl,
      token: () => store.getToken(),
      logger: rootLogger.child({ component: 'http-client' }),
      defaultTimeoutMs: SERVICE_REQUEST_TIMEOUT_MS,
    });
  }

  let httpClient = buildHttpClient(serviceBaseUrl);

  /**
   * The service address in force: the configured one, or why it was refused.
   * Starts as the environment's (or the default) and follows the stored
   * setting from {@link start} on ({@link loadServiceEndpoint}).
   */
  let serviceEndpoint: Result<string, DebuggenError> = ok(serviceBaseUrl);
  /**
   * Bumped whenever a storage change is applied, so a storage read that
   * started before it and lands after it is discarded rather than applied over
   * the fresher value.
   */
  let serviceEndpointChanges = 0;
  /**
   * Whether the stored setting has been observed at least once — read
   * successfully (a value, a refused value, or none stored) or delivered by a
   * storage change. Until it has, the address in force is not trusted: a failed
   * read puts a refusal in force instead of the environment's or the default
   * address (AAP §0.5.6 — the credential and a pairing code go only to the
   * service the developer chose). Once it has, a later transient read failure
   * keeps the address the setting established.
   */
  let serviceEndpointVerified = false;
  /**
   * Opens {@link serviceEndpointSettled}; replaced by the promise's resolver
   * below, and called once, by {@link establishServiceEndpoint}.
   */
  let openServiceEndpointGate: () => void = () => undefined;
  /**
   * The bridge's gate (`WsBridgeDeps.serviceEndpointSettled`): settles
   * once the first read of the stored setting has been applied, whatever its
   * outcome. Until then no socket opens and no HTTP call — authenticated or
   * a pairing redemption — is issued at the provisional address.
   */
  const serviceEndpointSettled = new Promise<void>((resolve) => {
    openServiceEndpointGate = resolve;
  });
  /** The one run of {@link establishServiceEndpoint}, once it has started. */
  let serviceEndpointEstablishment: Promise<void> | undefined;

  const store = createDevtoolsCredentialStore({
    storage: storage.local,
    httpClient: () => httpClient,
    changes: storage.local.onChanged,
    logger: rootLogger,
  });

  // -------------------------------------------------------------------------
  // Panel requests
  // -------------------------------------------------------------------------

  /**
   * The inspected tab of the panel behind a request: the tab its connection
   * was associated with, read live, because an association made while the
   * request was in flight (its DevTools page announcing itself) counts. A
   * panel's tab never changes once set, so reading it late cannot move it.
   */
  function inspectedTabOf(context: PortRequestContext): TabId | undefined {
    if (context.tabId !== undefined) {
      return context.tabId;
    }
    const connection = hub.getConnection(context.connectionId);
    return connection !== undefined && isPanelConnection(connection) ? connection.tabId : undefined;
  }

  /**
   * The scope rule every session-naming panel request passes before the
   * worker acts for it with the devtools credential: a panel may act only for
   * the session bound to the tab it inspects — the rule the service applies
   * to the devtools role (AAP §0.5.6: capture, targets, panel data and
   * `source.open` "only for the session bound to that tab").
   *
   * Refused with `TAB_NOT_BOUND` when the panel is not associated with an
   * inspected tab yet, when that tab is bound to no session or to another
   * session, or when the named session is bound to another tab. A session
   * bound to no tab at all (ended, or its tab left) is refused as well: the
   * service would refuse the devtools credential for it, and refusing here
   * keeps a panel holding a stale session from acting on it.
   *
   * @returns The panel's inspected tab, to which the named session is bound.
   */
  async function checkPanelScope(
    sessionId: SessionId,
    context: PortRequestContext,
  ): Promise<Result<TabId, DebuggenError>> {
    const tabId = inspectedTabOf(context);
    if (tabId === undefined) {
      log.debug('A session request from a panel with no inspected tab was refused.', {
        sessionId,
      });
      return err(
        workerError('TAB_NOT_BOUND', 'This panel is not associated with an inspected tab yet.', {
          hint: 'Open the Debug Generator panel from DevTools on the application tab.',
        }),
      );
    }
    const [binding, sessionTab] = await Promise.all([
      registry.getBinding(tabId),
      registry.getTabForSession(sessionId),
    ]);
    if (binding?.sessionId === sessionId && sessionTab === tabId) {
      return ok(tabId);
    }
    log.debug('A session request outside the panel tab scope was refused.', {
      tabId,
      sessionId,
      boundSessionId: binding?.sessionId,
      sessionTabId: sessionTab,
    });
    const message =
      binding === undefined
        ? 'The inspected tab is not bound to a session.'
        : binding.sessionId !== sessionId
          ? 'The inspected tab is bound to a different session.'
          : 'The session is bound to another tab.';
    return err(
      workerError('TAB_NOT_BOUND', message, {
        hint: 'Reopen the Debug Generator panel so it picks up the current session.',
      }),
    );
  }

  /**
   * The tab a `target.pick` for a session reaches: the panel's inspected tab,
   * under exactly the scope rule of {@link checkPanelScope}.
   */
  function resolveSessionTab(
    sessionId: SessionId,
    context: PortRequestContext,
  ): Promise<Result<TabId, DebuggenError>> {
    return checkPanelScope(sessionId, context);
  }

  // -------------------------------------------------------------------------
  // Element selection: the verdict on `target.selected`, and arming the picker
  // -------------------------------------------------------------------------

  /** The failure a selection nothing settled is reported with. */
  function selectionUnconfirmed(): DebuggenError {
    return workerError('TRANSPORT_DISCONNECTED', SELECTION_UNCONFIRMED_MESSAGE, {
      hint: SELECTION_UNCONFIRMED_HINT,
    });
  }

  /** The failure a selection held for a closed (not reconnecting) socket is reported with. */
  function selectionUnsent(): DebuggenError {
    return workerError('TRANSPORT_DISCONNECTED', SELECTION_UNSENT_MESSAGE, {
      hint: SELECTION_UNSENT_HINT,
    });
  }

  /**
   * Start a one-shot timer on the injected timers. A cancelled countdown's
   * promise never settles, and is released with its last reference.
   */
  function countdown(ms: number): Countdown {
    const fired = deferred<undefined>();
    const handle = timers.setTimeout(() => {
      fired.resolve(undefined);
    }, ms);
    return {
      elapsed: fired.promise,
      cancel: () => {
        timers.clearTimeout(handle);
      },
    };
  }

  /**
   * The socket state a held selection acts on: `open` (send it now), `closed`
   * (no reconnect is coming, so give up), or `undefined` while it is still
   * connecting or reconnecting (keep holding).
   */
  function settledTransport(): 'open' | 'closed' | undefined {
    const { transport } = wsBridge.getStatus();
    return transport === 'open' || transport === 'closed' ? transport : undefined;
  }

  /**
   * Hold a selection in the worker until the socket is open, without handing
   * anything to the socket client — whose outbound queue would flush the frame
   * on the next open, however long after its failure was reported.
   *
   * Woken by {@link publishStatus}: the bridge publishes a fresh status on every
   * transport transition, the opening included, and it does so from the socket
   * client's state hook, before that client flushes its own queue. The waiter
   * resumes on a later microtask, so a frame sent on `open` is written directly
   * rather than queued behind the flush.
   *
   * @param deadline The selection's delivery deadline.
   * @param signal Aborted when the panel that asked is gone.
   * @returns What ended the hold; `open` at once when the socket already is.
   */
  async function waitForOpenTransport(
    deadline: Promise<undefined>,
    signal: AbortSignal | undefined,
  ): Promise<TransportWait> {
    const current = settledTransport();
    if (current !== undefined) {
      return current;
    }
    if (signal?.aborted === true) {
      return 'aborted';
    }
    const outcome = deferred<TransportWait>();
    const watch = (): void => {
      const state = settledTransport();
      if (state !== undefined) {
        outcome.resolve(state);
      }
    };
    const onAbort = (): void => {
      outcome.resolve('aborted');
    };
    transportWatchers.add(watch);
    signal?.addEventListener('abort', onAbort, { once: true });
    void deadline.then(() => {
      outcome.resolve('timeout');
    });
    try {
      return await outcome.promise;
    } finally {
      transportWatchers.delete(watch);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** The verdict one answer stands for; a timeout or an abort settles nothing. */
  function verdictOf(answer: SelectionAnswer): SelectionVerdict {
    switch (answer.kind) {
      case 'accepted':
        return { kind: 'accepted', via: 'session.updated' };
      case 'refused':
        // The service's own code and message, so the panel reports the reason
        // it was refused (`TAB_NOT_BOUND` for a foreign or stale selection).
        return {
          kind: 'refused',
          error: new DebuggenError(answer.payload.code, answer.payload.message),
        };
      case 'timeout':
      case 'aborted':
        return { kind: 'unconfirmed', error: selectionUnconfirmed() };
    }
  }

  /**
   * Decide a selection no verdict frame answered by reading the session back:
   * accepted when the stored target is the descriptor that was sent, otherwise
   * unconfirmed — the frame was lost, or the service could not be asked.
   */
  async function verifySelection(
    sessionId: SessionId,
    target: SelectedTarget,
    tabId: TabId,
    signal: AbortSignal | undefined,
  ): Promise<SelectionVerdict> {
    const stored = await wsBridge.getSession(sessionId, {
      signal,
      tabId,
      timeoutMs: SELECTION_VERDICT_TIMEOUTS.verifyMs,
    });
    if (stored.ok && sameSelectedTarget(stored.value.target, target)) {
      return { kind: 'accepted', via: 'verified' };
    }
    log.debug('An unanswered selection is not the stored target.', {
      sessionId,
      errorCode: errorCode(stored),
    });
    return { kind: 'unconfirmed', error: selectionUnconfirmed() };
  }

  /**
   * Settle one selection and resolve with the verdict — never on a send alone,
   * because a sent frame is pending until the service settles it
   * (`@debuggen/protocol`, `messages/target.ts`). Three steps, bounded as
   * {@link SELECTION_VERDICT_TIMEOUTS} documents:
   *
   * 1. **Is it already the target?** The session is read once. When its
   *    recorded target already satisfies `sameSelectedTarget` with the
   *    descriptor, nothing would change, and no later `session.updated` or
   *    read-back could tell a recorded frame from a lost one — so the answer is
   *    accepted (`via: 'already-recorded'`) and **nothing is sent**. Otherwise
   *    a later equal target is evidence of this change.
   * 2. **Hold until the socket is open.** A selection is never handed to the
   *    socket client's outbound queue, which would flush it on the next open —
   *    after this worker reported its failure and the panel withdrew the pick.
   *    While the socket reconnects the selection waits here, still pending,
   *    until it opens or the delivery deadline passes; at the deadline it is
   *    answered unconfirmed without ever having been sent. A closed socket
   *    (not paired, credential refused) has no reconnect coming and is
   *    answered unsent at once.
   * 3. **Send and wait for the verdict** — {@link sendAndAwaitVerdict}.
   *
   * Every subscription, timer and abort listener is released before this
   * resolves. Never rejects; nothing about the descriptor is logged.
   *
   * @param payload The selection, exactly as it is sent.
   * @param tabId The inspected tab the selection acts for: every read and the
   *   frame carry it (`x-debuggen-tab`, the envelope's `tabId`).
   * @param signal Aborted when the panel that asked is gone.
   * @returns The verdict.
   */
  async function sendSelectedTarget(
    payload: MessagePayload<'target.selected'>,
    tabId: TabId,
    signal?: AbortSignal,
  ): Promise<SelectionVerdict> {
    const { sessionId, target } = payload;

    const recorded = await wsBridge.getSession(sessionId, {
      signal,
      tabId,
      timeoutMs: SELECTION_VERDICT_TIMEOUTS.verifyMs,
    });
    if (recorded.ok && sameSelectedTarget(recorded.value.target, target)) {
      return { kind: 'accepted', via: 'already-recorded' };
    }
    if (!recorded.ok) {
      // Proceeding unread: acceptance then rests on the service's confirming
      // `session.updated` (or the read-back), which cannot distinguish a lost
      // frame from a recorded one if the target already equalled the
      // descriptor — the one case this read exists to rule out, and in which
      // the session's target is the descriptor either way.
      log.debug('The session could not be read before a selection was sent.', {
        sessionId,
        errorCode: recorded.error.code,
      });
    }
    if (signal?.aborted === true) {
      return { kind: 'unconfirmed', error: selectionUnconfirmed() };
    }

    const delivery = countdown(SELECTION_VERDICT_TIMEOUTS.queuedMs);
    try {
      const transport = await waitForOpenTransport(delivery.elapsed, signal);
      switch (transport) {
        case 'open':
          return await sendAndAwaitVerdict(payload, tabId, delivery.elapsed, signal);
        case 'closed':
          return { kind: 'unsent', error: selectionUnsent() };
        case 'timeout':
        case 'aborted':
          // Never handed to the transport, so no reconnect can deliver it later.
          return { kind: 'unconfirmed', error: selectionUnconfirmed() };
      }
    } finally {
      delivery.cancel();
    }
  }

  /**
   * Send one `target.selected` frame on the open socket and resolve with the
   * service's verdict on it.
   *
   * The frame's envelope id is minted here and both answers are subscribed to
   * **before** the send, so neither can arrive unobserved:
   *
   * 1. an `error` whose `ref` is that id — refused, with the service's code;
   * 2. a `session.updated` of this session whose target satisfies
   *    `sameSelectedTarget` with the descriptor sent — accepted. An update
   *    carrying another target is some other change (or a later selection) and
   *    settles nothing.
   *
   * When neither arrives within `sentMs` the frame went down with the socket,
   * and the session is read back once; a verdict frame arriving meanwhile
   * still wins.
   *
   * The socket was open when this was called, yet `send` can still answer
   * `queued`: the socket closed between that check and the write, and the
   * client queued the frame for its next connection. That narrow race is the
   * only path on which a selection is queued. The frame then keeps the rest of
   * the delivery deadline — at least `sentMs` — before the read-back decides
   * it, and a reconnect after that verdict could still flush it; nothing short
   * of an API to withdraw a queued frame closes that window.
   *
   * @param payload The selection, exactly as it is sent.
   * @param tabId The inspected tab the selection acts for.
   * @param deliveryDue The selection's delivery deadline.
   * @param signal Aborted when the panel that asked is gone.
   * @returns The verdict.
   */
  async function sendAndAwaitVerdict(
    payload: MessagePayload<'target.selected'>,
    tabId: TabId,
    deliveryDue: Promise<undefined>,
    signal: AbortSignal | undefined,
  ): Promise<SelectionVerdict> {
    const id = newMessageId();
    const { sessionId, target } = payload;
    // `first` settles the wait; `frame` only on a verdict frame, so one that
    // arrives during the read-back can still decide the outcome.
    const first = deferred<SelectionAnswer>();
    const frame = deferred<SelectionAnswer>();
    const answer = (value: SelectionAnswer): void => {
      first.resolve(value);
      frame.resolve(value);
    };
    const unsubscribes: Unsubscribe[] = [
      wsBridge.subscribe(MESSAGE_TYPE.ERROR, (message) => {
        if (message.payload.ref === id) {
          answer({ kind: 'refused', payload: message.payload });
        }
      }),
      wsBridge.subscribe(MESSAGE_TYPE.SESSION_UPDATED, (message) => {
        const { session } = message.payload;
        if (session.id === sessionId && sameSelectedTarget(session.target, target)) {
          answer({ kind: 'accepted' });
        }
      }),
    ];
    const onAbort = (): void => {
      first.resolve({ kind: 'aborted' });
    };
    const sentWait = countdown(SELECTION_VERDICT_TIMEOUTS.sentMs);
    try {
      const sent = wsBridge.send(MESSAGE_TYPE.TARGET_SELECTED, payload, { id, tabId });
      if (!sent.ok) {
        return { kind: 'unsent', error: sent.error };
      }
      if (signal?.aborted === true) {
        onAbort();
      } else {
        signal?.addEventListener('abort', onAbort, { once: true });
      }
      const due =
        sent.value === 'sent'
          ? sentWait.elapsed
          : Promise.all([sentWait.elapsed, deliveryDue]).then(() => undefined);
      void due.then(() => {
        first.resolve({ kind: 'timeout' });
      });
      const settled = await first.promise;
      if (settled.kind !== 'timeout') {
        return verdictOf(settled);
      }
      return await Promise.race([
        frame.promise.then(verdictOf),
        verifySelection(sessionId, target, tabId, signal),
      ]);
    } finally {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      sentWait.cancel();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Log a selection's verdict: its kind and error code, never the descriptor. */
  function logSelectionVerdict(verdict: SelectionVerdict, fields: LogFields): void {
    switch (verdict.kind) {
      case 'accepted':
        log.info('The service accepted a selected element.', { ...fields, via: verdict.via });
        return;
      case 'refused':
        log.info('The service refused a selected element.', {
          ...fields,
          errorCode: verdict.error.code,
        });
        return;
      case 'unconfirmed':
        log.warn('The service did not confirm a selected element.', {
          ...fields,
          errorCode: verdict.error.code,
        });
        return;
      case 'unsent':
        log.warn('A selected element could not be sent to the service.', {
          ...fields,
          errorCode: verdict.error.code,
        });
        return;
    }
  }

  /**
   * Per tab, the page pick this worker generation armed and the page agent has
   * not answered yet ({@link ArmedPagePick}). Worker-generation memory like the
   * lanes: a revived worker holds none, and an answer to a pick it does not
   * hold is read as that pick ending — never as a selection
   * ({@link settlePagePick}).
   */
  const pagePicks = new Map<TabId, ArmedPagePick>();

  /**
   * Put a tab's page into picker mode — the one implementation behind
   * `target.pick`, which the panel sends for its own "Pick element" and for
   * the service's relayed `target.request` alike (the panel is the only
   * arming authority, so a request is armed once).
   *
   * Picker mode is the page agent's picker and nothing else: the request goes
   * through the ISOLATED-world bridge and arms one interactive pick in the
   * page. The next element the developer clicks there is consumed by the
   * agent — the page never sees that click — and arrives as `target.described`
   * with this request's id, forwarded as `target.selected`; Escape in the page
   * (or the page being hidden) ends the pick without one. Either way the
   * answer ends picker mode in the panel ({@link settlePagePick}).
   * DevTools is never asked on this path — describing the Elements panel's
   * `$0` here would submit whatever happens to be selected there (often a
   * default element) before the developer picked anything; `$0` is "Use
   * selected element", the panel's explicit second control (AAP §0.7.3).
   * Synchronous: it only posts on a port that already exists, and records the
   * armed pick against the bridge connection it went to and the session it
   * was armed for ({@link pagePicks}) — the one session the picked element
   * may become the target of.
   *
   * @param tabId The bound tab.
   * @param sessionId The session the `target.pick` request named, which the
   *   panel scope check found bound to `tabId`.
   * @returns Whether the page agent's bridge took the request; `false` when no
   *   page agent is connected for the tab (an origin outside the host
   *   permissions, or a document that predates the extension).
   */
  function armElementPicker(tabId: TabId, sessionId: SessionId): boolean {
    const requestId = newPortRequestId();
    const sent = hub.sendToBridge(tabId, {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'downstream',
      type: 'target.request',
      payload: { requestId },
    });
    if (!sent) {
      return false;
    }
    // Read after the send, synchronously: the bridge the frame was posted to
    // is the tab's current one, and the hub holds exactly one per tab.
    const connectionId = currentBridgeConnectionId(tabId);
    if (connectionId === undefined) {
      // Unreachable while the send succeeded; without a record the pick's
      // answer is still read as its end (`settlePagePick`), so nothing sticks
      // — and, answering no record, it selects nothing.
      pagePicks.delete(tabId);
    } else {
      // A pick recorded before is superseded in the page, which answers it
      // with its own, older id — an answer `settlePagePick` then ignores.
      pagePicks.set(tabId, { requestId, connectionId, sessionId, cancelled: false });
    }
    log.debug('Picker mode armed in the page.', { tabId });
    return true;
  }

  /** The connection id of a tab's current content-script bridge, when one is attached. */
  function currentBridgeConnectionId(tabId: TabId): WorkerConnectionId | undefined {
    return hub
      .listConnections()
      .find((connection) => connection.role === PORT_CONTENT_BRIDGE && connection.tabId === tabId)
      ?.connectionId;
  }

  /**
   * Tell a tab's panels that its page pick is over, so their picker mode — the
   * pressed "Pick element" toggle and its "Picker on" badge — ends with it. No
   * panel attached is normal: a panel that opens later hydrates with picker
   * mode off.
   */
  function pushPickerEnded(tabId: TabId, cause: PagePickEnd): void {
    const push: PortPickerPush = {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'push',
      kind: 'picker',
      state: { active: false },
    };
    const panels = hub.pushToPanels(tabId, push);
    log.debug('Picker mode ended in the page.', { tabId, cause, panels });
  }

  /**
   * Settle a tab's pick bookkeeping for one `target.described` answer, end
   * picker mode in its panels when the answer ends the pick they may show on,
   * and decide whether the answer's element may be forwarded at all.
   *
   * Called synchronously when the answer arrives, while the hub's dispatch
   * still vouches for its bridge: every later event — a cancel, a re-arm, a
   * rebind — then applies to the record after this answer, never to it.
   *
   * Picker mode in the panel:
   *
   * - **An answer to an older pick** — its id is not the recorded pick's, so
   *   it answers one that was cancelled or superseded before the current pick
   *   was armed — ends nothing: the current pick is still armed in the page.
   * - **An answer to the recorded pick** (or one naming no id) ends it: the
   *   record is dropped, and picker mode is pushed off unless the panel had
   *   already left it and cancelled the pick ({@link ArmedPagePick.cancelled}).
   * - **An answer with no record** also pushes picker mode off. This worker
   *   generation armed nothing it still holds — the worker was revived, or the
   *   pick already ended — but the page just answered, so its pick has ended
   *   and "off" is the true state. A panel already off ignores it.
   *
   * The verdict on the element: `select` only for the answer to the recorded,
   * uncancelled pick — the answer's `requestId` is the record's, and it
   * arrived on the bridge connection the pick was armed on — carrying the
   * session the pick was armed for. Every other answer is dropped with its
   * {@link PagePickDropReason}: a pick this worker did not arm, or one already
   * cancelled or superseded, is not the developer's pick for any session, so
   * its element is never forwarded to whatever the tab is bound to now.
   *
   * @param context The attribution of the bridge frame carrying the answer.
   * @param requestId The id the answer echoes, when it carries one.
   * @returns Whether the answer's element may be forwarded, and for which session.
   */
  function settlePagePick(
    context: BridgeMessageContext,
    requestId: PortRequestId | undefined,
  ): PagePickVerdict {
    const { tabId } = context;
    const pick = pagePicks.get(tabId);
    if (pick === undefined) {
      pushPickerEnded(tabId, 'answered');
      return { kind: 'drop', reason: 'unarmed' };
    }
    if (requestId !== undefined && requestId !== pick.requestId) {
      log.debug('An answer to an earlier page pick was ignored.', { tabId });
      return { kind: 'drop', reason: 'superseded' };
    }
    pagePicks.delete(tabId);
    if (pick.cancelled) {
      return { kind: 'drop', reason: 'cancelled' };
    }
    pushPickerEnded(tabId, 'answered');
    if (requestId === undefined) {
      return { kind: 'drop', reason: 'unidentified' };
    }
    if (pick.connectionId !== context.connectionId) {
      return { kind: 'drop', reason: 'other-connection' };
    }
    return { kind: 'select', sessionId: pick.sessionId };
  }

  /**
   * A content-script bridge left: when it carried the tab's recorded pick, the
   * document holding that pick is gone (a navigation, a reload, a closed tab or
   * a bridge superseded by the next document), so the pick is dropped and —
   * unless the panel had already cancelled it, or the worker itself is being
   * torn down — picker mode is pushed off. Another connection's departure
   * leaves the record alone: it never held this pick.
   */
  function releasePagePick(event: PortClosedEvent<BridgeConnection>): void {
    const { tabId, connectionId } = event.connection;
    const pick = pagePicks.get(tabId);
    if (pick === undefined || pick.connectionId !== connectionId) {
      return;
    }
    pagePicks.delete(tabId);
    if (pick.cancelled || disposed || event.reason === 'disposed') {
      return;
    }
    pushPickerEnded(tabId, 'bridge-gone');
  }

  /**
   * Send a tab's page a `target.request { cancel: true }` and settle the
   * recorded pick's bookkeeping for it: a recorded pick is kept, marked
   * cancelled, until the agent's answer to it arrives ({@link settlePagePick})
   * — so that answer is told apart from one to a pick armed after it — or is
   * dropped when no bridge took the cancel, since no document is then left to
   * answer it.
   *
   * @param tabId The tab whose page pick is cancelled.
   * @returns Whether a bridge took the cancel, and whether a pick was recorded.
   */
  function sendPickCancel(tabId: TabId): { readonly sent: boolean; readonly recorded: boolean } {
    const sent = hub.sendToBridge(tabId, {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'downstream',
      type: 'target.request',
      payload: { requestId: newPortRequestId(), cancel: true },
    });
    const pick = pagePicks.get(tabId);
    if (pick !== undefined) {
      if (sent) {
        pagePicks.set(tabId, { ...pick, cancelled: true });
      } else {
        pagePicks.delete(tabId);
      }
    }
    return { sent, recorded: pick !== undefined };
  }

  /**
   * A tab lost its session's binding — the tab was unbound (a session end
   * included), left its session's origin, was closed, or is now bound to
   * another session. Any pick armed there belonged to the session that left,
   * and the page would otherwise keep consuming the developer's next click
   * for it, so it is cancelled in the page. Nothing is pushed: the panel
   * resets its session-scoped state, picker mode included, on that same
   * binding change, and the cancelled pick's answer ends nothing on screen
   * and selects nothing ({@link ArmedPagePick.cancelled}).
   *
   * The cancel is sent whether or not this worker generation holds a record
   * of a pick there: the record is worker-generation memory (a revived worker
   * remembers nothing), so its absence does not prove the page holds no pick.
   * With no pick active the page ignores the cancel, and with no bridge
   * attached nothing is sent.
   *
   * @param tabId The tab whose binding changed.
   */
  function cancelPickWithBinding(tabId: TabId): void {
    const { sent, recorded } = sendPickCancel(tabId);
    log.debug('The page pick was cancelled with its binding.', {
      tabId,
      cancelSent: sent,
      recorded,
    });
  }

  /**
   * Leave picker mode for the panel's session: cancel the page pick of the
   * session's tab with a `target.request { cancel: true }` ({@link sendPickCancel}).
   *
   * The cancel is sent whether or not this worker generation armed a pick
   * there: a revived worker remembers nothing, and the page may still hold the
   * pick an earlier generation armed. The agent ends only a pick it holds and
   * answers it with that pick's own id; with none active it posts nothing.
   *
   * Never rejects: leaving picker mode must always succeed in the panel, so a
   * session outside the panel's scope, a page with no bridge, or a failed
   * lookup only leaves nothing to cancel, and is logged by code.
   *
   * @param sessionId The session the panel names.
   * @param context The panel request's context, which scopes the tab.
   */
  async function cancelElementPick(
    sessionId: SessionId,
    context: PortRequestContext,
  ): Promise<void> {
    try {
      const tab = await resolveSessionTab(sessionId, context);
      if (!tab.ok) {
        log.debug('Picker mode left with no page pick to cancel.', {
          sessionId,
          errorCode: tab.error.code,
        });
        return;
      }
      const tabId = tab.value;
      const { sent, recorded } = sendPickCancel(tabId);
      log.debug('Picker mode left.', { tabId, sessionId, cancelSent: sent, recorded });
    } catch (cause: unknown) {
      log.warn('The page pick could not be cancelled.', {
        sessionId,
        error: errorName(cause),
      });
    }
  }

  const requestHandlers: PortRequestHandlers = {
    'panelData.query': async (payload, context) => {
      const scope = await checkPanelScope(payload.sessionId, context);
      if (!scope.ok) {
        return scope;
      }
      // The proxy that keeps the panel free of any socket or `fetch`: the
      // `DataResult` is answered verbatim, paging echo included.
      return wsBridge.queryPanelData(payload.sessionId, payload.query, {
        signal: context.signal,
        tabId: scope.value,
      });
    },

    'source.open': async (payload, context) => {
      // A click is often what wakes a suspended worker. Until
      // `wsBridge.connect()` has run, the socket client is `closed` and refuses
      // the frame outright, so the cold-start work is awaited first.
      await ready;
      const scope = await checkPanelScope(payload.sessionId, context);
      if (!scope.ok) {
        return scope;
      }
      // Forwarded unmodified, acting for the panel's tab, then answered by
      // what the editor did: see `forwardSourceOpen` for the round trip and
      // `SourceOpenForwardResult` for how the result maps onto `{ forwarded }`.
      return forwardSourceOpen(
        {
          send: wsBridge.send,
          subscribe: wsBridge.subscribe,
          timers,
          logger: log,
          refs: sourceOpenRefs,
          tabId: scope.value,
        },
        payload,
        context.signal,
      );
    },

    'capture.start': async (payload, context) => {
      const scope = await checkPanelScope(payload.sessionId, context);
      if (!scope.ok) {
        return scope;
      }
      const started = await wsBridge.startCapture(payload.sessionId, {
        signal: context.signal,
        tabId: scope.value,
      });
      if (!started.ok) {
        // The failure is answered unchanged: `portErr` carries its code —
        // `CAPTURE_ALREADY_ACTIVE` for the documented `409` — and, for that
        // conflict, the schema-validated owning session, so the panel can name
        // the session holding the capture. The log reads the same validated id.
        log.info('capture.start was refused.', {
          sessionId: payload.sessionId,
          errorCode: started.error.code,
          owningSessionId: captureConflictOwningSessionId('capture.start', started.error),
        });
      }
      return started;
    },

    'capture.stop': async (payload, context) => {
      const scope = await checkPanelScope(payload.sessionId, context);
      if (!scope.ok) {
        return scope;
      }
      const stopped = await wsBridge.stopCapture(payload.sessionId, {
        signal: context.signal,
        tabId: scope.value,
      });
      if (!stopped.ok) {
        log.info('capture.stop was refused.', {
          sessionId: payload.sessionId,
          errorCode: stopped.error.code,
        });
      }
      return stopped;
    },

    'target.pick': async (payload, context) => {
      if (!payload.enabled) {
        // The page's pick consumes the developer's next click until it is
        // answered, so leaving picker mode cancels it in the page — and is
        // answered inactive whatever the cancel found: leaving picker mode
        // never fails in the panel.
        await cancelElementPick(payload.sessionId, context);
        return ok({ active: false });
      }
      const tab = await resolveSessionTab(payload.sessionId, context);
      if (!tab.ok) {
        return tab;
      }
      if (armElementPicker(tab.value, payload.sessionId)) {
        return ok({ active: true });
      }
      log.info('Picker mode could not be armed.', {
        tabId: tab.value,
        sessionId: payload.sessionId,
        errorCode: 'AGENT_NOT_READY',
      });
      return err(workerError('AGENT_NOT_READY', PICKER_UNAVAILABLE_MESSAGE));
    },

    'target.selected': async (payload, context) => {
      const scope = await checkPanelScope(payload.sessionId, context);
      if (!scope.ok) {
        return scope;
      }
      // "Use selected element" confirms a target, and the panel leaves picker
      // mode with it; a page pick left armed would consume the developer's
      // next ordinary click and could replace the target just confirmed. So
      // the tab's page pick is cancelled first — posted synchronously, before
      // anything of the selection is sent — whether or not this worker
      // generation recorded one: a revived worker remembers nothing, and a
      // cancel with no active pick is a no-op in the page. The cancelled
      // pick's answer then selects nothing (`ArmedPagePick.cancelled`).
      const { sent: cancelSent, recorded } = sendPickCancel(scope.value);
      log.debug('The page pick was cancelled for a confirmed selection.', {
        tabId: scope.value,
        cancelSent,
        recorded,
      });
      // Answered on the service's verdict, never on the send: a refusal or a
      // lost frame is a failure, so the panel withdraws its optimistic target
      // and says why.
      const verdict = await sendSelectedTarget(payload, scope.value, context.signal);
      logSelectionVerdict(verdict, {
        tabId: context.tabId,
        sessionId: payload.sessionId,
        source: 'panel',
      });
      return verdict.kind === 'accepted' ? ok({ accepted: true }) : err(verdict.error);
    },

    'pair.complete': async (payload) => {
      // The dialog saves the service address just before it submits the code,
      // so the code is redeemed at that address: read it now instead of
      // relying on the storage change event having been delivered already.
      const endpoint = await loadServiceEndpoint();
      if (isErr(endpoint)) {
        log.info('Pairing did not start: the service address is unusable.', {
          errorCode: endpoint.error.code,
        });
        return err(endpoint.error);
      }
      const paired = await store.completePairing(payload.code);
      // `STORE_ERROR` means the exchange succeeded and the credential is held
      // for this worker generation, only not saved — so the socket starts in
      // both cases, and the failure is still answered so the panel can say so.
      if (paired.ok || paired.error.code === 'STORE_ERROR') {
        background(wsBridge.connect(), 'connect after pairing');
      }
      if (!paired.ok) {
        log.info('Pairing did not complete.', { errorCode: paired.error.code });
        return paired;
      }
      log.info('Paired with the local service.');
      return ok({ paired: true });
    },

    'session.snapshot': async (payload, context) => {
      // A cold start: the credential and the bindings must be read before the
      // answer, or a freshly revived worker would report a false "Not paired".
      await ready;
      // Opening the panel again is the documented retry of a service address
      // that could not be read: read it now if no read has established it.
      await reloadUnverifiedServiceEndpoint();
      // The answer describes the panel's own inspected tab and nothing else:
      // the tab the panel names is its identity, and the session it names is
      // information only (see `associatePanel`) — never a way to read another
      // tab's binding or session.
      const tabId = await associatePanel(payload, context);
      const state =
        tabId === undefined ? UNBOUND_STATE : await registry.getPanelBindingState(tabId);
      const binding = state.kind === 'bound' && state.tabId !== tabId ? UNBOUND_STATE : state;
      if (binding !== state) {
        log.error('A binding state for another tab was withheld from a panel snapshot.', {
          tabId,
        });
      }
      // Whether the one-click reload is offered for the panel's tab; a panel
      // whose tab is not known yet receives it as a `reload` push once it is.
      const reload = tabId === undefined ? undefined : await reloadStateFor(tabId);
      const status = wsBridge.snapshot();
      const snapshot: PanelSessionSnapshot = {
        connection: connectionPushFromStatus(status).state,
        binding,
        ...(reload === undefined ? {} : { reload }),
      };
      // Loss this panel's tab suffered while no panel saw it is shown to the
      // panel after this answer, whichever it is — the answer would otherwise
      // reset the notice the panel keeps.
      if (tabId !== undefined) {
        replayTelemetryLossAfterAnswer(tabId);
      }
      // `tabId` is re-tested only to narrow it: an unknown tab is `UNBOUND_STATE`.
      if (tabId === undefined || binding.kind !== 'bound' || !status.hasCredential) {
        return ok(snapshot);
      }
      const { details, failure } = await readSessionDetails(
        binding.sessionId,
        tabId,
        context.signal,
      );
      if (failure === undefined) {
        return ok({ ...snapshot, ...details });
      }
      // A read failed. A snapshot of only the parts that were read would
      // replace what the panel shows with nothing — "No session yet" for a
      // bound session. The failure is answered instead, which the panel keeps
      // as its retryable error notice without discarding its state; the
      // binding and the pill reach it as pushes, ahead of the answer, and the
      // reads are tried again on the hydration retry schedule.
      if (!context.signal.aborted) {
        hub.pushToPanels(tabId, bindingPushFor(binding));
        hub.pushToPanels(tabId, connectionPushFromStatus(status));
        scheduleHydrationRetry(tabId, 0, failure);
      }
      return err(failure);
    },

    'page.reload': async (payload, context) => {
      // The developer's click on the panel's one-click reload is the consent
      // (AAP §0.7.1 Group 2), given for one tab: the panel's inspected tab,
      // which the request names. Fail closed — this action reloads a page —
      // unless that tab is this connection's associated tab (a fresh port not
      // yet associated, or a panel associated elsewhere, is refused) and is
      // bound to the named session right now (a session rebound to another
      // tab since the offer was shown is refused). Nothing else is reloaded:
      // this handler is the only caller of `agent.requestConsentedReload` —
      // never a timer, a readiness report or a navigation. It answers once the
      // new document's `agent.ready` arrives, or with a typed failure when
      // that bounded wait expires, which the hub's request timeout outlasts
      // (`WORKER_REQUEST_TIMEOUT_MS`).
      const tabId = payload.tabId;
      if (context.tabId === undefined || context.tabId !== tabId) {
        log.info('A page reload was refused: the panel does not inspect the tab it named.', {
          tabId,
          sessionId: payload.sessionId,
          associated: context.tabId !== undefined,
        });
        return err(
          workerError(
            'TAB_NOT_BOUND',
            'The reload was not requested from the panel of the tab it names.',
            { hint: 'Wait for the Debug Generator panel to reconnect, then reload from it again.' },
          ),
        );
      }
      const binding = await registry.getBinding(tabId);
      if (binding === undefined || binding.sessionId !== payload.sessionId) {
        log.info('A page reload was refused: the tab is not bound to the named session.', {
          tabId,
          sessionId: payload.sessionId,
        });
        return err(
          workerError('TAB_NOT_BOUND', 'The inspected tab is not bound to this session.', {
            hint: 'Open DevTools on the application tab of this session.',
          }),
        );
      }
      // The offer the panel was shown, by the same rule `requestConsentedReload`
      // applies: only an offered reload is performed, and one already in
      // flight (`reloading`) is waited on, never started twice. Decided on the
      // binding just checked, with no await before the reload is requested.
      const offer = reloadOfferFor(binding);
      if (offer.kind === 'not-needed') {
        log.info('A page reload was refused: none is offered for the tab.', {
          tabId,
          sessionId: payload.sessionId,
        });
        return err(
          workerError('SESSION_INVALID_STATE', 'The inspected page does not need a reload.', {
            hint: 'The page agent already observes this page.',
          }),
        );
      }
      log.info('Reloading the inspected page with the developer’s consent.', {
        tabId,
        sessionId: payload.sessionId,
        offer: offer.kind,
        ...(offer.kind === 'offered' ? { reason: offer.reason } : {}),
      });
      const outcome = await agent.requestConsentedReload(tabId);
      log.info('The consented page reload settled.', {
        tabId,
        sessionId: payload.sessionId,
        outcome: outcome.kind,
        // The document id is page-supplied: logged by its fingerprint only.
        ...(outcome.kind === 'ready'
          ? { document: fingerprintPageId(outcome.readiness.documentId) }
          : {}),
      });
      return pageReloadAnswer(outcome);
    },
  };

  // -------------------------------------------------------------------------
  // Frames from the page (the content-script bridge)
  // -------------------------------------------------------------------------

  /**
   * Forward an element descriptor — from the page agent's picker or the
   * Elements panel's selection — as the protocol's `target.selected` for the
   * session bound to its tab, acting for that tab (the bridge or DevTools
   * port's sender), and wait for the service's verdict on it. The descriptor
   * was bounded and redacted by the agent; it is forwarded verbatim and never
   * logged.
   *
   * The panel shows no optimistic target for this route — its target is the
   * session record's, which only an accepted selection changes — so there is
   * nothing to retract, only a failure to make visible. A refusal already
   * reaches the panels as the service's own `error` frame, relayed like every
   * `error`; a selection the transport lost has no frame at all, so the panels
   * of the tab are told here. A frame the closed socket refused outright is
   * only logged: the connection pill already shows that state.
   *
   * A page pick's element is the target of the session the pick was armed for
   * and of no other: when the binding read here names another session — the
   * tab was rebound while the answer waited — the element is dropped and
   * logged by code, never sent for the session that now holds the tab.
   *
   * @param pick The page pick the agent's `target.described` answered: its
   *   frame's attribution, checked again after the registry read, and the
   *   session it was armed for, which the binding must still name. Absent for
   *   the Elements panel's selection, which arrives from the DevTools page
   *   rather than a bridge and is the bound session's by construction.
   */
  async function forwardSelectedTarget(
    tabId: TabId,
    target: SelectedTarget,
    source: 'agent' | 'devtools',
    pick?: AnsweredPagePick,
  ): Promise<void> {
    const binding = await registry.getBinding(tabId);
    // An agent's descriptor must still come from the tab's current document
    // once the registry has answered: the bridge may have been superseded
    // while it read.
    if (pick !== undefined && isStaleBridgeFrame('target.described', pick.bridge)) {
      return;
    }
    if (binding === undefined) {
      log.debug('A selected element on an unbound tab was not forwarded.', { tabId, source });
      return;
    }
    if (pick !== undefined && binding.sessionId !== pick.sessionId) {
      log.info('A picked element that answers no live pick was dropped.', {
        tabId,
        reason: 'rebound' satisfies PagePickDropReason,
      });
      return;
    }
    const { sessionId } = binding;
    const verdict = await sendSelectedTarget({ sessionId, target }, tabId);
    logSelectionVerdict(verdict, { tabId, sessionId, source });
    if (verdict.kind === 'unconfirmed') {
      pushProtocol(
        tabId,
        createEnvelope(MESSAGE_TYPE.ERROR, toErrorPayload(verdict.error), { sessionId }),
      );
    }
  }

  /**
   * Why a page-agent descriptor is not of the document the tab shows now, or
   * `undefined` when it is.
   *
   * The service can compare a descriptor's URL with the binding's only as far
   * as origin and path — the binding is stored query-redacted — so two loads of
   * one URL, or a query change, are invisible to it. This worker knows the
   * document itself: every bridge frame carries the page agent document of its
   * bridge connection (`context.documentId`, from that bridge's `agent.ready`),
   * and the agent controller holds the tab's current one. A descriptor from a
   * bridge whose agent never announced a document (`unannounced`), or from a
   * document the tab has since replaced (`superseded`), was described in a
   * page the developer no longer sees.
   */
  function staleDocumentReason(
    context: BridgeMessageContext,
  ): 'unannounced' | 'superseded' | undefined {
    if (context.documentId === undefined) {
      return 'unannounced';
    }
    return agent.getReadiness(context.tabId)?.documentId === context.documentId
      ? undefined
      : 'superseded';
  }

  /**
   * Drop a page-agent descriptor of a document the tab no longer shows, and —
   * when the tab is bound — tell its panels, as a lost selection is told
   * ({@link forwardSelectedTarget}): the developer picked an element and must
   * learn that it did not become the target. Logs the tab and codes only.
   */
  async function dropStaleSelection(
    tabId: TabId,
    reason: 'unannounced' | 'superseded',
  ): Promise<void> {
    const binding = await registry.getBinding(tabId);
    if (binding === undefined) {
      log.debug('A selected element on an unbound tab was not forwarded.', {
        tabId,
        source: 'agent',
      });
      return;
    }
    log.info('A selected element of a document the tab no longer shows was dropped.', {
      tabId,
      sessionId: binding.sessionId,
      errorCode: 'TAB_NOT_BOUND',
      reason,
    });
    pushProtocol(
      tabId,
      createEnvelope(
        MESSAGE_TYPE.ERROR,
        toErrorPayload(workerError('TAB_NOT_BOUND', STALE_SELECTION_MESSAGE)),
        { sessionId: binding.sessionId },
      ),
    );
  }

  /**
   * Surface a recognised `agent.error` on the tab's panels as a protocol
   * `error` push — the one failure state the panel renders — carrying the
   * kind's fixed public sentence ({@link agentErrorReport}).
   *
   * The frame is page-forgeable, so nothing it says as text reaches a log line
   * or the panel: a recognised frame is logged at `warn` with the tab and its
   * closed-vocabulary kind only; an unrecognised one is not shown, and is
   * logged at `debug` as a fixed line with the tab alone.
   *
   * The push is made only while the frame's bridge is still the tab's current
   * one (see {@link isStaleBridgeFrame}).
   */
  async function reportAgentError(
    context: BridgeMessageContext,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const { tabId } = context;
    const report = agentErrorReport(payload);
    if (report === undefined) {
      log.debug('An unrecognised page-agent error frame was not shown.', {
        tabId,
        agentError: 'unrecognised',
      });
      return;
    }
    log.warn('The page agent reported an error.', { tabId, agentError: report.kind });
    const binding = await registry.getBinding(tabId);
    if (isStaleBridgeFrame('agent.error', context)) {
      return;
    }
    pushProtocol(
      tabId,
      createEnvelope(
        MESSAGE_TYPE.ERROR,
        report.error,
        binding === undefined ? undefined : { sessionId: binding.sessionId },
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Telemetry custody: the per-tab chain, the cold-start hold, held loss,
  // loss notices
  // -------------------------------------------------------------------------

  /** A tab's lane, created when its first waiting frame arrives. */
  function laneFor(tabId: TabId): TelemetryLane {
    const existing = telemetryLanes.get(tabId);
    if (existing !== undefined) {
      return existing;
    }
    const created: TelemetryLane = {
      tail: Promise.resolve(),
      links: 0,
      pending: 0,
      reports: 0,
      heldEvents: 0,
      queued: new Map(),
    };
    telemetryLanes.set(tabId, created);
    return created;
  }

  /**
   * Run one page agent frame's work after every earlier frame of the same tab
   * has settled, and after start-up has settled.
   *
   * The port hub dispatches each frame without waiting for the previous
   * handler. Handlers that each awaited `ready` would be ordered only by the
   * promise-reaction queue, which one more `await` in any of them would
   * silently break; this chain makes arrival order the contract instead —
   * `agent.ready` reaches the socket client before the batches its document
   * sent after it, and batch n before batch n + 1, while different tabs never
   * wait on each other. The work runs even once the worker is disposed, so it
   * can release what it holds; it checks `disposed` itself. A link that throws
   * is logged by name and the chain continues; the returned promise never
   * rejects. The lane is forgotten once its last link has finished.
   *
   * @param tabId The tab the frame came from.
   * @param frame The frame type, for the log line of a failed link.
   * @param work The frame's hand-over; the next link waits for it to settle.
   */
  function inTabOrder(
    tabId: TabId,
    frame: string,
    work: (lane: TelemetryLane) => void | Promise<void>,
  ): Promise<void> {
    const lane = laneFor(tabId);
    lane.links += 1;
    const link = lane.tail
      .then(() => ready)
      .then(() => work(lane))
      .then(undefined, (cause: unknown) => {
        log.error('A page agent frame could not be handed over.', {
          tabId,
          frame,
          error: errorName(cause),
        });
      })
      .then(() => {
        lane.links -= 1;
        if (lane.links === 0 && telemetryLanes.get(tabId) === lane) {
          telemetryLanes.delete(tabId);
        }
      });
    lane.tail = link;
    return link;
  }

  /**
   * The events of a batch the worker takes custody of, and how many of them
   * wait for start-up. After start-up that is all of them, none waiting.
   * Before, the tab's waiting events stay within
   * {@link COLD_START_HELD_EVENTS_PER_TAB}: the oldest are kept — the order
   * they are delivered in — and those beyond the bound are refused, counted,
   * shown as undelivered and held for the service's ledger under the batch's
   * pinned context, rather than held in unbounded memory.
   */
  function admitBatch(
    lane: TelemetryLane,
    tabId: TabId,
    events: BridgeTelemetryEvents,
    context: TelemetryBatchContext,
  ): { readonly events: BridgeTelemetryEvents; readonly held: number } {
    if (coldStartSettled) {
      return { events, held: 0 };
    }
    const room = Math.max(0, COLD_START_HELD_EVENTS_PER_TAB - lane.heldEvents);
    const admitted = events.length > room ? events.slice(0, room) : events;
    const refused = events.length - admitted.length;
    lane.heldEvents += admitted.length;
    if (refused > 0) {
      log.warn('Telemetry beyond the cold-start hold was dropped.', {
        tabId,
        dropped: refused,
        held: lane.heldEvents,
        limit: COLD_START_HELD_EVENTS_PER_TAB,
      });
      recordTelemetryLoss(tabId, 'undelivered', refused);
      holdPendingLoss(tabId, context, refused, 'cold-start-hold');
    }
    return { events: admitted, held: admitted.length };
  }

  // -------------------------------------------------------------------------
  // Loss the service's producer-loss ledger was not told of
  // -------------------------------------------------------------------------

  /**
   * Hold loss the worker caused for accepted page telemetry until it can reach
   * the service's producer-loss ledger — the ledger that decides whether a
   * capture's coverage is complete, and which the panels' loss notices are
   * not. `source` names where it happened, for the log line only.
   *
   * The count is kept per tab under exactly `context` — the batch's pinned
   * stamp when the loss happened before the lane read the tab's binding (the
   * cold-start hold, a full lane), else the labels its frames were sent under
   * (the verified session, the stamped capture). It leaves as `droppedCount`
   * on the first job of that context the lane sends ({@link claimPendingLoss})
   * or on a loss-only report once the service confirms the tab's route
   * ({@link deliverPendingLoss}), and is never added to another context's: the
   * service accounts it against the capture the frame is attributed to, and
   * refuses a frame whose armed capture is not the tab's open one. A tab holds
   * at most {@link MAX_PENDING_LOSS_CONTEXTS_PER_TAB} contexts; a new one
   * beyond the bound abandons the oldest's count with a counts-only warning.
   * Logs carry the tab and counts only — never the page-supplied ids.
   */
  function holdPendingLoss(
    tabId: TabId,
    context: TelemetryBatchContext,
    count: number,
    source: PendingLossSource,
  ): void {
    if (disposed || count <= 0) {
      return;
    }
    let contexts = pendingLoss.get(tabId);
    if (contexts === undefined) {
      contexts = new Map();
      pendingLoss.set(tabId, contexts);
      // Loss can arrive for a tab that already closed — a job that waited out
      // its deadline, a frame the socket client discarded later — and would
      // wait for a route forever.
      background(forgetPendingLossOfClosedTab(tabId), 'pending telemetry loss of a closed tab');
    }
    const key = telemetryLossKey(context);
    let entry = contexts.get(key);
    if (entry === undefined) {
      if (contexts.size >= MAX_PENDING_LOSS_CONTEXTS_PER_TAB) {
        for (const [oldestKey, oldest] of contexts) {
          contexts.delete(oldestKey);
          abandonedLossCount += 1;
          log.warn(
            'Telemetry loss the service was not told of was abandoned: its tab holds loss for too many capture contexts.',
            {
              tabId,
              dropped: oldest.count,
              limit: MAX_PENDING_LOSS_CONTEXTS_PER_TAB,
              abandonedCount: abandonedLossCount,
            },
          );
          break;
        }
      }
      entry = { context, count: 0 };
      contexts.set(key, entry);
    }
    entry.count = addLossCounts(entry.count, count);
    log.debug('Telemetry loss is held until the service can be told.', {
      tabId,
      dropped: count,
      pending: entry.count,
      source,
    });
  }

  /**
   * Take over the loss held for `tabId` under any of `contexts` — removed from
   * the accumulator, so it is carried once. The caller is the job about to
   * send (its pinned and its verified context, which label its frames) or one
   * that abandons a context with no route.
   *
   * @returns The count taken over; `0` when none was held.
   */
  function claimPendingLoss(tabId: TabId, contexts: readonly TelemetryBatchContext[]): number {
    const held = pendingLoss.get(tabId);
    if (held === undefined) {
      return 0;
    }
    let claimed = 0;
    for (const key of new Set(contexts.map(telemetryLossKey))) {
      const entry = held.get(key);
      if (entry !== undefined) {
        held.delete(key);
        claimed = addLossCounts(claimed, entry.count);
      }
    }
    if (held.size === 0) {
      pendingLoss.delete(tabId);
    }
    return claimed;
  }

  /**
   * The service confirmed the tab's route on the current connection: queue
   * one loss-only report for each context whose loss is held and that no job
   * on the tab's lane will carry. Each report takes its context's count when
   * its turn comes, and one that cannot deliver it puts the count back — to
   * wait for the next job or confirmation, never retried in a loop. These
   * reports are bounded by {@link MAX_PENDING_LOSS_CONTEXTS_PER_TAB} per lane
   * (at most one per held context), not by the page's lane bound, so a lane
   * full of the page's batches cannot hold them back.
   */
  function deliverPendingLoss(tabId: TabId): void {
    const held = pendingLoss.get(tabId);
    if (disposed || held === undefined) {
      return;
    }
    for (const [key, entry] of held) {
      const lane = telemetryLanes.get(tabId);
      if ((lane?.reports ?? 0) >= MAX_PENDING_LOSS_CONTEXTS_PER_TAB) {
        // The rest waits for the next job of its context or confirmation.
        return;
      }
      if ((lane?.queued.get(key) ?? 0) > 0) {
        continue;
      }
      log.debug('Telemetry loss held for the service is sent on its own.', {
        tabId,
        dropped: entry.count,
      });
      queueTelemetryJob(
        laneFor(tabId),
        {
          tabId,
          events: [],
          droppedCount: 0,
          context: entry.context,
          deadline: startTelemetryDeadline(),
        },
        { held: 0, bounded: false },
      );
    }
  }

  /**
   * Forget the loss held for a tab — it closed, so no route will carry it —
   * with one counts-only warning when any was held.
   */
  function forgetPendingLoss(tabId: TabId): void {
    const held = pendingLoss.get(tabId);
    if (held === undefined) {
      return;
    }
    pendingLoss.delete(tabId);
    let dropped = 0;
    for (const entry of held.values()) {
      dropped = addLossCounts(dropped, entry.count);
    }
    abandonedLossCount += 1;
    log.warn('Telemetry loss the service was not told of was abandoned: its tab closed.', {
      tabId,
      dropped,
      contexts: held.size,
      abandonedCount: abandonedLossCount,
    });
  }

  /** Forget a tab's held loss when `tabs.get` cannot find the tab — it closed. */
  async function forgetPendingLossOfClosedTab(tabId: TabId): Promise<void> {
    const open = await Promise.resolve()
      .then(() => tabs.get(tabId))
      .then(
        () => true,
        () => false,
      );
    if (!open && !disposed) {
      forgetPendingLoss(tabId);
    }
  }

  /**
   * Account for telemetry the capture is missing, and show it on the tab's
   * panels without flooding them: the first loss of a burst is shown at once,
   * loss during the following {@link TELEMETRY_LOSS_NOTICE_INTERVAL_MS} is
   * accumulated, and the burst's running total is shown when the interval
   * ends — so the latest notice, the one the panel keeps, names everything
   * the burst lost. An interval with no further loss ends the burst, unless
   * its last notice reached no panel: then the burst is kept and shown again
   * once a panel of the tab is connected (see {@link endLossInterval} and
   * {@link replayTelemetryLoss}).
   */
  function recordTelemetryLoss(tabId: TabId, kind: TelemetryLossKind, events: number): void {
    if (disposed || events <= 0) {
      return;
    }
    let episodes = lossEpisodes.get(tabId);
    if (episodes === undefined) {
      episodes = new Map();
      lossEpisodes.set(tabId, episodes);
    }
    let episode = episodes.get(kind);
    if (episode === undefined) {
      episode = { total: 0, shown: 0, cooldown: undefined, seen: false, notices: 0 };
      episodes.set(kind, episode);
    }
    episode.total = Math.min(Number.MAX_SAFE_INTEGER, episode.total + events);
    if (episode.cooldown === undefined) {
      showTelemetryLoss(tabId, kind, episode);
    }
  }

  /** Whether a burst is still the tab's current one of its kind. */
  function isCurrentEpisode(tabId: TabId, kind: TelemetryLossKind, episode: LossEpisode): boolean {
    return lossEpisodes.get(tabId)?.get(kind) === episode;
  }

  /** Whether a panel of the tab is connected — one a notice pushed now would reach. */
  function tabHasPanel(tabId: TabId): boolean {
    return hub
      .listConnections()
      .filter(isPanelConnection)
      .some((connection) => connection.tabId === tabId);
  }

  /**
   * Show a burst's running total, and start the interval before the next
   * notice. Whether the notice reached a panel is known once its push
   * resolves, and is recorded only if the notice is still the latest of a
   * burst that is still the tab's current one — a late answer about an older
   * notice, or about a burst since forgotten, decides nothing.
   */
  function showTelemetryLoss(tabId: TabId, kind: TelemetryLossKind, episode: LossEpisode): void {
    episode.shown = episode.total;
    episode.seen = false;
    episode.notices += 1;
    const notice = episode.notices;
    episode.cooldown = timers.setTimeout(() => {
      endLossInterval(tabId, kind, episode);
    }, TELEMETRY_LOSS_NOTICE_INTERVAL_MS);
    background(
      pushTelemetryLoss(tabId, kind, episode.total).then((panels) => {
        if (episode.notices === notice && isCurrentEpisode(tabId, kind, episode)) {
          episode.seen = panels > 0;
        }
      }),
      'telemetry loss notice',
    );
  }

  /**
   * An interval ended. Show what it accumulated; else, when the last notice
   * reached no panel, show it again if a panel of the tab is connected now,
   * or keep the burst — with no timer — until one is ({@link replayTelemetryLoss})
   * or more loss arrives, which is then shown at once with the grown total;
   * else end the burst.
   */
  function endLossInterval(tabId: TabId, kind: TelemetryLossKind, episode: LossEpisode): void {
    episode.cooldown = undefined;
    if (disposed || !isCurrentEpisode(tabId, kind, episode)) {
      return;
    }
    if (episode.total > episode.shown) {
      showTelemetryLoss(tabId, kind, episode);
      return;
    }
    if (!episode.seen) {
      if (tabHasPanel(tabId)) {
        showTelemetryLoss(tabId, kind, episode);
      } else {
        background(forgetLossOfClosedTab(tabId), 'telemetry loss of a closed tab');
      }
      return;
    }
    const episodes = lossEpisodes.get(tabId);
    if (episodes !== undefined) {
      episodes.delete(kind);
      if (episodes.size === 0) {
        lossEpisodes.delete(tabId);
      }
    }
  }

  /**
   * A panel was just associated with the tab: show every burst of the tab
   * whose last notice reached no panel and whose interval is not running. A
   * burst whose interval is running is shown when that interval ends
   * ({@link endLossInterval}), so no panel gets two notices of one kind
   * within an interval. Once a replayed notice reaches the panel the burst is
   * seen, and a later association replays nothing.
   */
  function replayTelemetryLoss(tabId: TabId): void {
    if (disposed) {
      return;
    }
    const episodes = lossEpisodes.get(tabId);
    if (episodes === undefined) {
      return;
    }
    for (const [kind, episode] of episodes) {
      if (!episode.seen && episode.cooldown === undefined) {
        log.debug('A telemetry loss notice no panel saw is shown again.', {
          tabId,
          loss: kind,
          events: episode.total,
        });
        showTelemetryLoss(tabId, kind, episode);
      }
    }
  }

  /**
   * Replay the tab's unseen loss notices once the answer being prepared for
   * the panel has been posted: `ports.ts` posts a request's answer in the
   * promise continuations that follow its handler, so a zero-delay task runs
   * after it, and the answer cannot overwrite the notice the panel keeps.
   */
  function replayTelemetryLossAfterAnswer(tabId: TabId): void {
    if (!lossEpisodes.has(tabId)) {
      return;
    }
    timers.setTimeout(() => {
      replayTelemetryLoss(tabId);
    }, 0);
  }

  /**
   * Push one loss notice ({@link telemetryLossNotice}) to the tab's panels as
   * a protocol `error`, under the tab's bound session when there is one. The
   * log line records how many panels it reached, so a notice issued while no
   * panel of the tab was connected stays visible in the diagnostics.
   *
   * @returns How many panels the notice was posted to.
   */
  async function pushTelemetryLoss(
    tabId: TabId,
    kind: TelemetryLossKind,
    events: number,
  ): Promise<number> {
    const binding = await registry.getBinding(tabId);
    const panels = pushProtocol(
      tabId,
      createEnvelope(
        MESSAGE_TYPE.ERROR,
        telemetryLossNotice(kind, events),
        binding === undefined ? undefined : { sessionId: binding.sessionId },
      ),
    );
    log.info('A telemetry loss notice was pushed.', { tabId, loss: kind, events, panels });
    return panels;
  }

  /** Cancel and forget the tab's loss notices: its tab closed, or the worker is disposed. */
  function forgetTelemetryLoss(tabId: TabId): void {
    const episodes = lossEpisodes.get(tabId);
    if (episodes === undefined) {
      return;
    }
    for (const episode of episodes.values()) {
      if (episode.cooldown !== undefined) {
        timers.clearTimeout(episode.cooldown);
        episode.cooldown = undefined;
      }
    }
    lossEpisodes.delete(tabId);
  }

  /**
   * A burst kept for a panel waits only while its tab exists. `tabs.onRemoved`
   * forgets a closing tab's bursts, but loss can still be recorded for it
   * afterwards — its frames left in the socket client's queue are dropped
   * later, while the service is unreachable — and such a burst would wait for
   * a panel forever. A tab `tabs.get` cannot find is closed: its bursts are
   * forgotten.
   */
  async function forgetLossOfClosedTab(tabId: TabId): Promise<void> {
    const open = await Promise.resolve()
      .then(() => tabs.get(tabId))
      .then(
        () => true,
        () => false,
      );
    if (!open && !disposed && lossEpisodes.has(tabId)) {
      log.debug('Telemetry loss of a closed tab was forgotten.', { tabId });
      forgetTelemetryLoss(tabId);
    }
  }

  /**
   * Cancel every pending loss notice and forget the loss held for the
   * service; part of `dispose` — the worker going away, with no connection
   * left to carry it.
   */
  function releaseTelemetryCustody(): void {
    for (const tabId of [...lossEpisodes.keys()]) {
      forgetTelemetryLoss(tabId);
    }
    pendingLoss.clear();
  }

  /**
   * Whether a page-bridge frame can no longer act: since the hub dispatched
   * it, its connection was closed or superseded by a newer bridge for the
   * tab, or its document was replaced. Every bridge handler asks after each
   * wait and immediately before each side effect, so a frame that was current
   * when it arrived cannot overwrite the readiness, the capture or the panel
   * state of the document that replaced it. A stale frame is dropped with a
   * debug line of ids only.
   */
  function isStaleBridgeFrame(
    type: keyof BridgeMessageHandlers,
    context: BridgeMessageContext,
  ): boolean {
    if (hub.isCurrentBridge(context)) {
      return false;
    }
    log.debug('A frame from a superseded page bridge was dropped.', {
      type,
      tabId: context.tabId,
      connectionId: context.connectionId,
      // Page-supplied: logged by its fingerprint only.
      document: fingerprintPageId(context.documentId),
    });
    return true;
  }

  /**
   * Start one batch's overall delivery deadline: a signal the injected timers
   * abort {@link TELEMETRY_ROUTE_WAIT_MS} after the batch arrived, so a batch
   * waits at most that long however many batches of its tab are ahead of it,
   * and a backlog behind an outage expires in step instead of one bound after
   * another.
   */
  function startTelemetryDeadline(): TelemetryDeadline {
    const controller = new AbortController();
    let handle: number | undefined = timers.setTimeout(() => {
      handle = undefined;
      controller.abort();
    }, TELEMETRY_ROUTE_WAIT_MS);
    return {
      signal: controller.signal,
      release: () => {
        if (handle !== undefined) {
          timers.clearTimeout(handle);
          handle = undefined;
        }
      },
    };
  }

  /**
   * Drop an accepted batch before any send: its tab has no binding, or the
   * batch was produced for another session or capture than the tab's binding.
   * Counts, ids and the reason only — never an event. A loss-only report is
   * logged as one, with its count.
   *
   * Such a drop names no capture the service could account the loss to, so
   * it is not held for the ledger; the loss held under the job's own context
   * has no route either, and is abandoned with it — logged in `dropped`
   * together with what the job had taken over (`claimed`).
   */
  function dropTelemetryBatch(
    job: PendingTelemetryBatch,
    reason: TelemetryDropReason,
    claimed: number,
  ): void {
    const loss = addLossCounts(
      addLossCounts(job.droppedCount, claimed),
      claimPendingLoss(job.tabId, [job.context]),
    );
    const lossReport = isLossReport(job);
    if (lossReport && loss === 0) {
      // A report the worker scheduled whose count another job already carried.
      log.debug('A held telemetry loss report had nothing left to drop.', { tabId: job.tabId });
      return;
    }
    telemetryLossCount += 1;
    const fields = {
      tabId: job.tabId,
      ...(lossReport ? {} : { events: job.events.length }),
      ...(loss > 0 ? { dropped: loss } : {}),
      reason,
      lossCount: telemetryLossCount,
    };
    if (reason === 'unbound') {
      log.debug(
        lossReport
          ? 'A telemetry loss report from an unbound tab was dropped.'
          : 'A telemetry batch from an unbound tab was dropped.',
        fields,
      );
      return;
    }
    log.info(
      lossReport
        ? 'A telemetry loss report produced for another session or capture was dropped.'
        : 'A telemetry batch produced for another session or capture was dropped.',
      fields,
    );
  }

  /**
   * Report an accepted batch the service could not be reached for: its tab's
   * route was not confirmed in time or was lost, or the send failed.
   *
   * A loss-only report is logged with its count (`loss`, what it did not hand
   * over) and shown nowhere: it names no undelivered event, and the loss it
   * carried was shown on the tab's panels when it happened. The notice shows
   * a batch's events whatever became of them — an upper bound, as its copy
   * says; {@link holdUndeliveredLoss} holds the count for the ledger.
   */
  function reportTelemetryLoss(
    job: PendingTelemetryBatch,
    sessionId: SessionId,
    stage: 'route' | 'send',
    code: DebuggenErrorCode,
    loss: number,
  ): void {
    telemetryLossCount += 1;
    if (isLossReport(job)) {
      log.warn('A telemetry loss report could not be delivered to the local service.', {
        tabId: job.tabId,
        sessionId,
        dropped: loss,
        stage,
        errorCode: code,
        lossCount: telemetryLossCount,
      });
      return;
    }
    log.warn('A telemetry batch was dropped: it could not be delivered to the local service.', {
      tabId: job.tabId,
      sessionId,
      events: job.events.length,
      stage,
      errorCode: code,
      lossCount: telemetryLossCount,
    });
    recordTelemetryLoss(job.tabId, 'undelivered', job.events.length);
  }

  /**
   * Hold what a job whose route or send failed did not hand to the socket
   * client, for the service's ledger, under the labels its frames carry: the
   * batch's events beyond the longest prefix an attempt handed over (a frame
   * the client took and later discards is reported by the bridge itself), and
   * its loss unless a frame carrying it was handed over. A failure the
   * protocol would repeat on every retry (`PROTOCOL_INVALID_MESSAGE`) abandons
   * the count with a counts-only warning instead of holding it.
   *
   * The resend after a queued frame is the whole batch (the queued copy may
   * be refused when it is flushed ahead of the re-announced binding), so a
   * batch whose writes threw twice is in the client's queue twice; should
   * both copies be discarded, their events are counted twice — an upper
   * bound, like the undelivered notice's, never an undercount.
   */
  function holdUndeliveredLoss(
    job: PendingTelemetryBatch,
    context: TelemetryBatchContext,
    stage: 'route' | 'send',
    code: DebuggenErrorCode,
    undelivered: { readonly eventsHandedOver: number; readonly loss: number },
  ): void {
    const events = job.events.length - Math.min(job.events.length, undelivered.eventsHandedOver);
    const lost = addLossCounts(events, undelivered.loss);
    if (lost === 0) {
      return;
    }
    if (code === 'PROTOCOL_INVALID_MESSAGE') {
      abandonedLossCount += 1;
      log.warn(
        'Telemetry loss the service was not told of was abandoned: the protocol refuses its frame.',
        { tabId: job.tabId, dropped: lost, stage, abandonedCount: abandonedLossCount },
      );
      return;
    }
    holdPendingLoss(job.tabId, context, lost, stage);
  }

  /**
   * Forward one raw agent batch as `telemetry.event` frames for the session
   * bound to its tab, once the service has confirmed that binding — or drop
   * it, reporting why.
   *
   * 1. After the cold start (`ready`: the binding hydration, the credential
   *    read and `wsBridge.connect()`), read the tab's binding. No binding, or
   *    a binding that contradicts the session or capture the batch was
   *    produced for (pinned at arrival), drops the batch: the page's stamp
   *    only ever rejects, never routes.
   * 2. Wait for the service to confirm the binding on the current connection
   *    (`wsBridge.awaitTabRoute`), within the batch's deadline. After a
   *    service restart this is what holds the batch until the re-announced
   *    `session.bind` is answered, instead of letting it into a socket queue
   *    the restarted service would refuse. A route that cannot be confirmed
   *    drops the batch with a warning and the cumulative loss count.
   * 3. Re-read the binding and check it still names the verified session (and
   *    capture): a tab re-bound while the batch waited must not receive it —
   *    a batch produced under one session is never sent as another's.
   * 4. Take over the loss held for the batch's pinned context and for the
   *    labels its frames carry ({@link claimPendingLoss}), then send, scoped
   *    to the verified session, with the page's `droppedCount` and that held
   *    loss on the first frame. A route lost between the confirmation and the
   *    write is awaited once more within the same deadline; a second failure
   *    drops the batch and reports it.
   *
   * What a dropped batch leaves undelivered is capture loss the service must
   * still learn of: a failed route or send holds the events not handed over
   * and the loss not handed over under the frames' labels
   * ({@link holdUndeliveredLoss}). A drop for the binding (step 1 or 3) names
   * no capture the service could account it to, and holds nothing.
   *
   * A loss-only report takes the same four steps, so its count reaches the
   * service only along a confirmed route and after every batch of its tab
   * queued before it; one the worker scheduled carries only the held loss it
   * takes over, and sends nothing when an earlier job already carried it. Its
   * loss is handed over at most once: a retry after a frame reached the
   * socket client carries no `droppedCount`, which leaves a loss-only report
   * nothing to resend — a discard of that frame is reported by the bridge.
   *
   * @param job The batch and what was pinned when it was queued.
   */
  async function forwardTelemetryBatch(job: PendingTelemetryBatch): Promise<void> {
    await ready;
    if (disposed) {
      return;
    }
    const { tabId } = job;
    const binding = await registry.getBinding(tabId);
    if (binding === undefined) {
      dropTelemetryBatch(job, 'unbound', 0);
      return;
    }
    const conflict = telemetryContextConflict(job.context, binding);
    if (conflict !== undefined) {
      dropTelemetryBatch(job, conflict, 0);
      return;
    }
    // What the tab's binding must still say at the write: the session verified
    // now, and the capture the batch names (else the one the binding held).
    const verified: TelemetryBatchContext = {
      sessionId: binding.sessionId,
      captureId: job.context.captureId ?? binding.captureId,
    };
    // The labels every frame of the batch carries — the verified session and
    // the capture the batch names — under which what it cannot hand over is
    // held, exactly as the bridge reports a discarded frame of it.
    const sendContext: TelemetryBatchContext = {
      sessionId: binding.sessionId,
      captureId: job.context.captureId,
    };
    // The loss rides on the batch's first frame: the page's report and the
    // held loss this job took over. Once a failed attempt got a frame onto the
    // socket (written, or taken into the client's queue), a resend must not
    // report the same loss a second time.
    let lossHandedOver = false;
    let claimed = 0;
    // The longest prefix of the batch's events an attempt handed over.
    let eventsHanded = 0;
    const undelivered = (): { readonly eventsHandedOver: number; readonly loss: number } => ({
      eventsHandedOver: eventsHanded,
      loss: lossHandedOver ? 0 : addLossCounts(job.droppedCount, claimed),
    });
    for (let attempt = 1; attempt <= TELEMETRY_SEND_ATTEMPTS; attempt += 1) {
      const route = await wsBridge.awaitTabRoute(tabId, binding.sessionId, {
        signal: job.deadline.signal,
      });
      if (disposed) {
        return;
      }
      if (!route.ok) {
        const left = undelivered();
        if (isLossReport(job) && left.loss === 0) {
          // A report the worker scheduled has taken nothing over yet: the held
          // count stays in the accumulator for the next job or confirmation.
          log.debug('A held telemetry loss report found no route; its count stays held.', {
            tabId,
            errorCode: route.error.code,
          });
          return;
        }
        reportTelemetryLoss(job, binding.sessionId, 'route', route.error.code, left.loss);
        holdUndeliveredLoss(job, sendContext, 'route', route.error.code, left);
        return;
      }
      const current = await registry.getBinding(tabId);
      if (current === undefined) {
        dropTelemetryBatch(job, 'unbound', lossHandedOver ? 0 : claimed);
        return;
      }
      const changed = telemetryContextConflict(verified, current);
      if (changed !== undefined) {
        dropTelemetryBatch(job, changed, lossHandedOver ? 0 : claimed);
        return;
      }
      if (!lossHandedOver) {
        claimed = addLossCounts(claimed, claimPendingLoss(tabId, [job.context, sendContext]));
      }
      const loss = undelivered().loss;
      if (isLossReport(job) && loss === 0) {
        log.debug('A held telemetry loss report had nothing left to deliver.', { tabId });
        return;
      }
      // Where raw agent batches become protocol `telemetry.event` envelopes,
      // chunked to the protocol's per-frame bound by the bridge. The agent's
      // delivery context rides along: the capture it was armed for, which lets
      // the service refuse a late batch of an earlier capture instead of
      // filing it under the open one, and the events lost before it — in the
      // page, and by this worker — which the service adds to the capture
      // summary's coverage. Only defined values are passed, so an absent field
      // stays absent. A loss-only report (no events) is one event-less frame
      // carrying the count, so the loss reaches the service's ledger when no
      // later batch will carry it.
      const sent = wsBridge.sendTelemetryBatch(tabId, job.events, binding.sessionId, {
        ...(job.context.captureId === undefined ? {} : { armedCaptureId: job.context.captureId }),
        ...(loss > 0 ? { droppedCount: loss } : {}),
      });
      if (sent.ok) {
        if (loss > 0) {
          // The tab and the counts only: the capture id is page-supplied and
          // is never echoed into a log.
          log.info(forwardedLossMessage(job), {
            tabId,
            dropped: loss,
            ...(claimed > 0 ? { held: claimed } : {}),
          });
        }
        return;
      }
      eventsHanded = Math.max(eventsHanded, eventsHandedOver(sent.error));
      lossHandedOver ||= framesHandedOver(sent.error) > 0;
      if (lossHandedOver && isLossReport(job)) {
        // The report's one frame is in the socket client's hands already; a
        // resend would carry no loss and so be nothing at all.
        log.debug('A telemetry loss report was handed over before its write failed.', {
          tabId,
          dropped: loss,
          errorCode: sent.error.code,
        });
        return;
      }
      if (
        attempt < TELEMETRY_SEND_ATTEMPTS &&
        TELEMETRY_ROUTE_LOSS_CODES.includes(sent.error.code)
      ) {
        log.debug('A telemetry batch lost its route before the write; waiting for it again.', {
          tabId,
          events: job.events.length,
          errorCode: sent.error.code,
        });
        continue;
      }
      const left = undelivered();
      reportTelemetryLoss(job, binding.sessionId, 'send', sent.error.code, left.loss);
      holdUndeliveredLoss(job, sendContext, 'send', sent.error.code, left);
      return;
    }
  }

  /** The log line of a job whose first frame carried a loss to the service. */
  function forwardedLossMessage(job: PendingTelemetryBatch): string {
    if (job.droppedCount === 0) {
      return 'Telemetry loss the service was not told of was forwarded.';
    }
    return isLossReport(job)
      ? "The page's telemetry loss report was forwarded."
      : 'The page agent dropped events before this batch; the count was forwarded.';
  }

  /**
   * Queue one raw agent batch on its tab's ordered, bounded lane.
   *
   * Why a lane: the port hub invokes bridge handlers fire-and-forget, and a
   * batch arriving on a cold wake must wait for the start-up work before it
   * can be forwarded (see {@link forwardTelemetryBatch}) — the page has
   * already removed it from its buffer, so dropping it would lose it. Waiting
   * independently per batch would let a later batch overtake an earlier one
   * whose binding read is slower, breaking the per-producer `seq` order the
   * correlator relies on. Each tab's frames are therefore chained
   * ({@link inTabOrder}): one starts only after the previous one of the same
   * tab has settled, `agent.ready` included, while different tabs never wait
   * on each other.
   *
   * Two bounds hold what one tab can make the worker keep, and what either
   * refuses is counted, logged, shown to the tab's panels as undelivered
   * telemetry ({@link recordTelemetryLoss}) and held for the service's ledger
   * under the batch's pinned context ({@link holdPendingLoss}), never
   * silently lost:
   *
   * - {@link MAX_PENDING_TELEMETRY_BATCHES_PER_TAB} batches on the lane — a
   *   batch arriving at a full lane is dropped with a cumulative overflow
   *   count, its events and the page's `droppedCount` held; a loss-only
   *   report arriving there has its count held;
   * - while start-up is pending, {@link COLD_START_HELD_EVENTS_PER_TAB} events
   *   ({@link admitBatch}): the oldest are kept, those beyond are refused.
   *
   * What the batch says about itself is pinned **here**, at arrival: the
   * session and capture the page agent stamped on it, and its overall
   * delivery deadline. The lane job compares them with the tab's binding when
   * the batch's turn comes, so a batch produced under one binding is never
   * relabelled with a later one.
   *
   * The page's `droppedCount` travels on the lane even when no event does: a
   * loss-only report (no events, a positive count) is a job like any batch,
   * and so is the loss of a batch whose every event the cold-start hold
   * refused — the refused events are shown as undelivered and held, and the
   * page's own count still reaches the service, in order behind the batches
   * before it. An empty batch that reports no loss says nothing and is not
   * queued.
   *
   * @param tabId The tab the batch came from — the bridge port's sender.
   * @param batch The page agent's batch, as the port hub validated it.
   */
  function enqueueTelemetryBatch(tabId: TabId, batch: PageTelemetryBatchPayload): void {
    if (disposed) {
      return;
    }
    if (batch.events.length === 0 && batch.droppedCount === 0) {
      log.debug('An empty telemetry batch that reports no loss was ignored.', { tabId });
      return;
    }
    const context: TelemetryBatchContext = {
      sessionId: batch.sessionId,
      captureId: batch.captureId,
    };
    const waiting = telemetryLanes.get(tabId)?.pending ?? 0;
    if (waiting >= MAX_PENDING_TELEMETRY_BATCHES_PER_TAB) {
      telemetryOverflowCount += 1;
      if (batch.events.length === 0) {
        // Its loss was shown on arrival; the service's ledger still misses it.
        log.warn('A telemetry loss report found its tab’s lane full; its count is held.', {
          tabId,
          dropped: batch.droppedCount,
          pending: waiting,
          overflowCount: telemetryOverflowCount,
        });
      } else {
        log.warn('A telemetry batch was dropped: too many batches are waiting for its tab.', {
          tabId,
          events: batch.events.length,
          pending: waiting,
          overflowCount: telemetryOverflowCount,
        });
        recordTelemetryLoss(tabId, 'undelivered', batch.events.length);
      }
      holdPendingLoss(
        tabId,
        context,
        addLossCounts(batch.events.length, batch.droppedCount),
        'lane-full',
      );
      return;
    }
    const lane = laneFor(tabId);
    const { events, held } = admitBatch(lane, tabId, batch.events, context);
    if (events.length === 0 && batch.events.length > 0 && batch.droppedCount === 0) {
      // Every event was beyond the cold-start hold — refused, shown and held
      // already — and the page reported no loss to forward in their place.
      if (lane.links === 0 && telemetryLanes.get(tabId) === lane) {
        telemetryLanes.delete(tabId);
      }
      return;
    }
    queueTelemetryJob(
      lane,
      {
        tabId,
        events,
        droppedCount: batch.droppedCount,
        context,
        deadline: startTelemetryDeadline(),
      },
      { held, bounded: true },
    );
  }

  /**
   * Run one lane job ({@link forwardTelemetryBatch}) in its tab's order, and
   * keep the lane's bookkeeping: `held` events leave the cold-start hold once
   * start-up has settled, a `bounded` job (a page batch) counts against
   * {@link MAX_PENDING_TELEMETRY_BATCHES_PER_TAB} while it waits — a loss-only
   * report the worker scheduled counts against
   * {@link MAX_PENDING_LOSS_CONTEXTS_PER_TAB} instead — and every job is
   * counted under its pinned context in {@link TelemetryLane.queued}. The
   * job's deadline is released however it settles; a job that throws is
   * logged by name.
   */
  function queueTelemetryJob(
    lane: TelemetryLane,
    job: PendingTelemetryBatch,
    options: { readonly held: number; readonly bounded: boolean },
  ): void {
    const { held, bounded } = options;
    const key = telemetryLossKey(job.context);
    if (bounded) {
      lane.pending += 1;
    } else {
      lane.reports += 1;
    }
    lane.queued.set(key, (lane.queued.get(key) ?? 0) + 1);
    background(
      inTabOrder(job.tabId, 'telemetry.batch', async () => {
        // Past `ready`: the events no longer count against the cold-start hold.
        lane.heldEvents -= held;
        try {
          await forwardTelemetryBatch(job);
        } catch (cause) {
          log.error('A telemetry batch could not be forwarded.', {
            tabId: job.tabId,
            error: errorName(cause),
          });
        } finally {
          job.deadline.release();
          if (bounded) {
            lane.pending -= 1;
          } else {
            lane.reports -= 1;
          }
          const left = (lane.queued.get(key) ?? 1) - 1;
          if (left > 0) {
            lane.queued.set(key, left);
          } else {
            lane.queued.delete(key);
          }
        }
      }),
      'telemetry forwarding',
    );
  }

  const bridgeHandlers: BridgeMessageHandlers = {
    'agent.ready': (payload, context) => {
      const { tabId } = context;
      // A page load is what usually wakes a suspended worker, so this report
      // routinely arrives while `start()` is still reading the credential.
      // Until `wsBridge.connect()` has run, the socket client is `closed` and
      // refuses the frame outright; once it has, the frame is queued and
      // flushed after the hello. The tab's lane waits for `ready`, which
      // turns a dropped report into a delivered one and keeps it ahead of the
      // batches its document sends after it — and gives a newer bridge for the
      // tab time to supersede this one, which is why its attribution is
      // checked there.
      const recorded = inTabOrder(tabId, 'agent.ready', () => {
        if (disposed || isStaleBridgeFrame('agent.ready', context)) {
          return;
        }
        // agent-control relays `agent.ready` upward with the tab filled in,
        // memoizes readiness and re-delivers the tab's desired configuration.
        const outcome = agent.handleAgentReady(tabId, payload);
        log.debug('agent.ready handled.', { tabId, outcome: outcome.kind });
      });
      // `inTabOrder` never rejects, so neither does this bookkeeping link.
      readinessInFlight.set(tabId, recorded);
      void recorded.then(() => {
        if (readinessInFlight.get(tabId) === recorded) {
          readinessInFlight.delete(tabId);
        }
      });
      return recorded;
    },

    'telemetry.batch': (payload, context) => {
      // Checked on arrival, while the hub's dispatch is current: a batch from a
      // superseded bridge never enters its tab's lane.
      if (isStaleBridgeFrame('telemetry.batch', context)) {
        return;
      }
      const { tabId } = context;
      // Loss inside the page — the agent's buffer, the bridge's rate budget —
      // is already final: it is shown now, whatever becomes of the batch. A
      // loss-only report (no events) is shown here once, like any batch's.
      if (payload.droppedCount > 0) {
        log.info(
          payload.events.length === 0
            ? 'The page reported dropped events in a loss-only report.'
            : 'The page agent dropped events before this batch.',
          { tabId, dropped: payload.droppedCount },
        );
        recordTelemetryLoss(tabId, 'dropped-in-page', payload.droppedCount);
      }
      // Like `agent.ready`, a batch routinely arrives while a woken worker is
      // still starting; unlike it, batches must also keep their order. Both
      // are the lane's job — this handler only queues, synchronously.
      enqueueTelemetryBatch(tabId, payload);
    },

    /**
     * The page agent's answer to one armed pick: the element the developer
     * clicked, or `null` when the pick ended without one.
     *
     * Every armed pick is answered exactly once, and that answer is what ends
     * picker mode in the panel — so it is settled first, synchronously while
     * the hub's dispatch still vouches for this bridge, and before a `null`
     * answer returns ({@link settlePagePick}). The same synchronous step
     * decides whether the element may be forwarded at all: only the answer to
     * the tab's live, uncancelled pick, on the connection it was armed on, is
     * a selection, and only for the session that pick was armed for. Any other
     * element — a cancelled, superseded or unknown pick's — is dropped here and
     * logged by its reason code, never by the descriptor. A forwarded element
     * still passes the stale-document checks after the waits below, and
     * `forwardSelectedTarget` drops it when the tab has meanwhile been bound
     * to another session.
     */
    'target.described': async (payload, context) => {
      const verdict = settlePagePick(context, payload.requestId);
      if (payload.target === null) {
        log.debug('The page pick ended without an element.', { tabId: context.tabId });
        return;
      }
      if (verdict.kind === 'drop') {
        log.info('A picked element that answers no live pick was dropped.', {
          tabId: context.tabId,
          reason: verdict.reason,
        });
        return;
      }
      // The tab's readiness is recorded by the `agent.ready` handler, in the
      // tab's lane after `ready`; awaiting both keeps a pick that follows its
      // own document's report from being compared with a memo not yet
      // written.
      await ready;
      await readinessInFlight.get(context.tabId);
      // A newer bridge may have pinned the tab's next document while this
      // frame waited: the pick was made in a page the developer no longer
      // sees, so it is dropped — and, like any lost selection, told to the
      // tab's panels rather than silently discarded.
      if (isStaleBridgeFrame('target.described', context)) {
        await dropStaleSelection(context.tabId, 'superseded');
        return;
      }
      const stale = staleDocumentReason(context);
      if (stale !== undefined) {
        await dropStaleSelection(context.tabId, stale);
        return;
      }
      await forwardSelectedTarget(context.tabId, payload.target, 'agent', {
        bridge: context,
        sessionId: verdict.sessionId,
      });
    },

    'agent.error': (payload, context) => reportAgentError(context, payload),
  };

  // -------------------------------------------------------------------------
  // Frames from the DevTools page
  // -------------------------------------------------------------------------

  /**
   * What binding a tab needs: its HTTP(S) origin and query-redacted URL. The
   * URL comes from the DevTools page when it read one, otherwise from
   * `chrome.tabs.get` (the `tabs` permission exists for this). The origin is
   * always derived from that URL, so the two can never disagree.
   */
  async function resolveBindTarget(
    tabId: TabId,
    reportedUrl: string | undefined,
  ): Promise<BindTarget | undefined> {
    let raw = reportedUrl;
    if (raw === undefined) {
      const tab = await Promise.resolve()
        .then(() => tabs.get(tabId))
        .then(
          (value) => value,
          () => undefined,
        );
      raw = tab?.url;
    }
    if (raw === undefined) {
      return undefined;
    }
    const origin = bindableOrigin(raw);
    const url = redactNavigationUrl(raw);
    return origin === undefined || url === undefined ? undefined : { url, origin };
  }

  /**
   * Ask the service to bind a tab — the one origin of `session.bind` — unless
   * the registry already holds a binding for the same origin, which
   * `ws-bridge.ts` re-announces on every socket open. The first URL form the
   * protocol's schema accepts is sent (see {@link urlFallbacks}).
   */
  async function requestBindIfNeeded(tabId: TabId, target: BindTarget): Promise<void> {
    const existing = await registry.getBinding(tabId);
    if (existing?.origin === target.origin) {
      return;
    }
    const url = urlFallbacks(target.url).find(
      (candidate) => parseSessionBindPayload({ tabId, url: candidate, origin: target.origin }).ok,
    );
    if (url === undefined) {
      log.debug('The inspected tab has no URL the service accepts.', { tabId });
      return;
    }
    const sent = await registry.requestBind({ tabId, url, origin: target.origin });
    log.debug('session.bind requested.', {
      tabId,
      origin: target.origin,
      errorCode: errorCode(sent),
    });
  }

  /**
   * Re-request a binding for every announced DevTools tab that has none —
   * after the socket opens (a bind sent while it was closed was refused) and
   * after a session is created (a new session may match a tab's origin).
   */
  async function rebindAnnouncedTabs(trigger: string): Promise<void> {
    await ready;
    for (const [tabId, target] of announcedTabs) {
      if (!hasDevtools(tabId)) {
        announcedTabs.delete(tabId);
        continue;
      }
      await requestBindIfNeeded(tabId, target);
    }
    log.debug('Announced tabs re-checked for a binding.', { trigger, tabs: announcedTabs.size });
  }

  const devtoolsHandlers: DevtoolsMessageHandlers = {
    'devtools.hello': async (payload, context) => {
      // The DevTools window's inspected tab: adopt a panel that asked without
      // naming a tab before this page announced itself (only when the match is
      // one to one), then bind.
      adoptWaitingPanel(context.tabId);
      await ready;
      const target = await resolveBindTarget(context.tabId, payload.url);
      if (target === undefined) {
        announcedTabs.delete(context.tabId);
        log.debug('DevTools inspects a page the worker does not bind.', { tabId: context.tabId });
        return;
      }
      announcedTabs.set(context.tabId, target);
      await requestBindIfNeeded(context.tabId, target);
    },

    'devtools.element': async (payload, context) => {
      if (payload.target === null) {
        log.debug('The Elements selection could not be described.', { tabId: context.tabId });
        return;
      }
      // Selecting an element in DevTools is the developer choosing the
      // session's target (AAP §0.1.1 step "optionally selects an element").
      await forwardSelectedTarget(context.tabId, payload.target, 'devtools');
    },
  };

  // -------------------------------------------------------------------------
  // Which tab a panel inspects
  // -------------------------------------------------------------------------

  /** Whether a DevTools page currently announces this tab. */
  function hasDevtools(tabId: TabId): boolean {
    return hub
      .listConnections()
      .some((connection) => isDevtoolsConnection(connection) && connection.tabId === tabId);
  }

  /**
   * The announced DevTools tabs that have no panel yet — the DevTools windows
   * whose panel is being opened (or reconnecting after a worker revival) —
   * newest announcement first, each tab once. Empty when none waits. The
   * order carries no authority: association never chooses by it.
   *
   * @param connectionId A panel connection not to count as some tab's panel
   *   (the one being associated); omitted, every panel counts.
   */
  function devtoolsTabsAwaitingPanel(connectionId?: WorkerConnectionId): readonly TabId[] {
    const connections = hub.listConnections();
    const tabsWithPanels = new Set(
      connections
        .filter(isPanelConnection)
        .filter((connection) => connection.connectionId !== connectionId)
        .map((connection) => connection.tabId),
    );
    const waiting = connections
      .filter(isDevtoolsConnection)
      .sort(byNewest)
      .map((connection) => connection.tabId)
      .filter((tabId): tabId is TabId => tabId !== undefined && !tabsWithPanels.has(tabId));
    return [...new Set(waiting)];
  }

  /**
   * Associate a panel connection with its inspected tab from its
   * `session.snapshot` request, and answer the tab the snapshot may describe
   * (`undefined`: answer unbound).
   *
   * The tab is the connection's identity: set once (`PortHub.bindPanelTab`
   * never moves it) and only from a trusted source — the panel's own
   * `inspectedTabId` (its `chrome.devtools.inspectedWindow.tabId`) or, for a
   * panel that names none, the DevTools page that announced the one tab
   * awaiting a panel. Both are this extension's own pages, the only senders
   * `PORT_PANEL` and `PORT_DEVTOOLS` accept (a panel port's `sender` names no
   * tab). Nothing else chooses it: not the announcement order,
   * and not the session the panel remembers (`request.sessionId`), which can
   * have been bound to another tab while the port was down.
   *
   * - A named tab is associated as it is ({@link associateNamedPanel}).
   * - With no named tab, the panel is associated only when exactly one
   *   DevTools tab awaits a panel ({@link associateUnnamedPanel}); otherwise it
   *   stays unassociated, and a DevTools page announced later may adopt it
   *   ({@link adoptWaitingPanel}).
   * - The claim is checked against the outcome for the log only
   *   ({@link noteIgnoredClaim}).
   */
  async function associatePanel(
    request: PortRequestPayloads['session.snapshot'],
    context: PortRequestContext,
  ): Promise<TabId | undefined> {
    const current = inspectedTabOf(context);
    const tabId =
      request.inspectedTabId === undefined
        ? associateUnnamedPanel(context.connectionId, current)
        : associateNamedPanel(context.connectionId, request.inspectedTabId, current);
    await noteIgnoredClaim(request.sessionId, tabId, context.connectionId);
    return tabId;
  }

  /**
   * Associate a panel that named its inspected tab with exactly that tab.
   *
   * A panel already associated with another tab keeps that association — it
   * is immutable — and its snapshot is refused: the contradiction is logged
   * as an error and `undefined` answered, so neither tab is hydrated on its
   * word. The named tab needs no DevTools announcement: the panel document is
   * this extension's own page reading `chrome.devtools.inspectedWindow.tabId`,
   * exactly as the DevTools page does.
   */
  function associateNamedPanel(
    connectionId: WorkerConnectionId,
    named: TabId,
    current: TabId | undefined,
  ): TabId | undefined {
    untabbedPanels.delete(connectionId);
    if (current === named) {
      return named;
    }
    if (current !== undefined) {
      log.error('A panel named an inspected tab its port is not associated with; refused.', {
        connectionId,
        tabId: current,
        namedTabId: named,
      });
      return undefined;
    }
    if (!hub.bindPanelTab(connectionId, named)) {
      // Everything since `current` was read is synchronous, so the panel is
      // gone rather than bound elsewhere.
      log.debug('A panel left before it could be associated.', { connectionId, tabId: named });
      return undefined;
    }
    log.debug('Panel associated with the inspected tab it named.', { connectionId, tabId: named });
    return named;
  }

  /**
   * Associate a panel that named no inspected tab — its page was opened
   * outside DevTools — with the DevTools tab awaiting a panel, when exactly
   * one does. With none, or several, it stays unassociated (the choice would
   * be a guess) and is remembered as waiting, for {@link adoptWaitingPanel}.
   */
  function associateUnnamedPanel(
    connectionId: WorkerConnectionId,
    current: TabId | undefined,
  ): TabId | undefined {
    if (current !== undefined) {
      untabbedPanels.delete(connectionId);
      return current;
    }
    const awaiting = devtoolsTabsAwaitingPanel(connectionId);
    const only = awaiting.length === 1 ? awaiting[0] : undefined;
    if (only === undefined) {
      if (hub.getConnection(connectionId) !== undefined) {
        untabbedPanels.add(connectionId);
      }
      log.debug(
        awaiting.length === 0
          ? 'Panel not associated yet: no DevTools page awaits a panel.'
          : 'Panel left unassociated: it named no tab and several DevTools pages await a panel.',
        { connectionId, awaiting: awaiting.length },
      );
      return undefined;
    }
    untabbedPanels.delete(connectionId);
    if (!hub.bindPanelTab(connectionId, only)) {
      log.debug('A panel left before it could be associated.', { connectionId, tabId: only });
      return undefined;
    }
    log.debug('Panel associated with the only DevTools page awaiting one.', {
      connectionId,
      tabId: only,
    });
    return only;
  }

  /**
   * Log a panel's session claim that the association outcome contradicts: a
   * session bound to another tab, to no tab, or named by a panel left
   * unassociated. The claim has no other effect.
   */
  async function noteIgnoredClaim(
    claim: SessionId | undefined,
    tabId: TabId | undefined,
    connectionId: WorkerConnectionId,
  ): Promise<void> {
    if (claim === undefined) {
      return;
    }
    const sessionTabId = await registry.getTabForSession(claim);
    if (sessionTabId !== tabId || tabId === undefined) {
      log.info('A stale session claim from a panel was ignored.', {
        connectionId,
        tabId,
        sessionId: claim,
        sessionTabId,
      });
    }
  }

  /**
   * A DevTools page announced a tab after a panel that named no tab asked for
   * its snapshot (the order a worker revival, or a panel page opened outside
   * DevTools, can produce): associate that panel with the tab and push the
   * state its snapshot answer lacked — but only when the match is one to one:
   * exactly one such panel waits, and the announced tab is the only DevTools
   * tab awaiting a panel. A panel that has not asked yet is never adopted
   * (its request may still name its own tab), and a tab that already has a
   * panel adopts nothing.
   */
  function adoptWaitingPanel(tabId: TabId): void {
    const panels = hub.listConnections().filter(isPanelConnection);
    for (const connectionId of [...untabbedPanels]) {
      const panel = panels.find((connection) => connection.connectionId === connectionId);
      if (panel === undefined || panel.tabId !== undefined) {
        untabbedPanels.delete(connectionId);
      }
    }
    if (panels.some((connection) => connection.tabId === tabId)) {
      return;
    }
    const waiting = [...untabbedPanels];
    const awaiting = devtoolsTabsAwaitingPanel();
    const panelId = waiting.length === 1 ? waiting[0] : undefined;
    if (panelId === undefined || awaiting.length !== 1 || awaiting[0] !== tabId) {
      if (waiting.length > 0) {
        log.debug('No waiting panel adopted: the match is not one to one.', {
          tabId,
          waitingPanels: waiting.length,
          awaitingTabs: awaiting.length,
        });
      }
      return;
    }
    const adopted = hub.bindPanelTab(panelId, tabId);
    untabbedPanels.delete(panelId);
    if (!adopted) {
      return;
    }
    log.debug('Waiting panel associated with the announced DevTools page.', {
      connectionId: panelId,
      tabId,
    });
    // Loss no panel saw is shown after the hydration pushes, which could
    // otherwise reset the notice the panel keeps.
    background(
      pushTabStateToPanels(tabId).finally(() => {
        replayTelemetryLoss(tabId);
      }),
      'panel hydration',
    );
  }

  /**
   * Push one relayed-type envelope to a tab's panels.
   *
   * @returns How many panels it was posted to; `0` for an envelope that is
   * not a relayed type, or a tab with no panel connected.
   */
  function pushProtocol(tabId: TabId, envelope: unknown): number {
    if (!isRelayedMessage(envelope)) {
      return 0;
    }
    const push: ProtocolPush = {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'push',
      kind: 'protocol',
      message: envelope,
    };
    return hub.pushToPanels(tabId, push);
  }

  /**
   * The bound session's record, latest analysis and current panel, read over
   * HTTP acting for the tab bound to it, together with the first failure among
   * its two reads. A part the
   * service cannot supply is omitted from `details` (and its code logged);
   * the failure is what a `session.snapshot` answers and what a background
   * hydration surfaces, so a stalled or failing service reads as a retryable
   * error rather than as a session with nothing in it.
   *
   * Both reads are bounded: by `signal` when the caller holds one, and always
   * by the shared client's {@link SERVICE_REQUEST_TIMEOUT_MS} default.
   *
   * @param sessionId The session bound to `tabId`.
   * @param tabId The inspected tab the reads act for.
   * @param signal Aborts both reads, when the panel request that needs them ends.
   */
  async function readSessionDetails(
    sessionId: SessionId,
    tabId: TabId,
    signal?: AbortSignal,
  ): Promise<SessionDetailsRead> {
    const options = { tabId, signal };
    const [session, current] = await Promise.all([
      wsBridge.getSession(sessionId, options),
      wsBridge.getCurrentPanel(sessionId, options),
    ]);
    if (!session.ok || !current.ok) {
      log.debug('Part of the session could not be read.', {
        sessionId,
        sessionError: errorCode(session),
        panelError: errorCode(current),
      });
    }
    const analysis = session.ok ? latestAnalysis(session.value) : undefined;
    const panel = current.ok ? current.value.panel : null;
    const failure = !session.ok ? session.error : !current.ok ? current.error : undefined;
    return {
      details: {
        ...(session.ok ? { session: session.value } : {}),
        ...(analysis === undefined ? {} : { analysis }),
        ...(panel === null ? {} : { panel }),
      },
      failure,
    };
  }

  // -------------------------------------------------------------------------
  // Background hydration: bounded, cancelled when its panels detach
  // -------------------------------------------------------------------------

  /**
   * The hydration in flight per tab — the controller whose signal bounds its
   * HTTP reads. At most one per tab: a newer hydration of the same tab aborts
   * the older one, whose answer would only be overwritten.
   */
  const hydrations = new Map<TabId, AbortController>();

  /** Start a tab's hydration, aborting the one it supersedes. */
  function beginHydration(tabId: TabId): AbortController {
    hydrations.get(tabId)?.abort();
    const controller = new AbortController();
    hydrations.set(tabId, controller);
    return controller;
  }

  /** Forget a finished hydration, unless a newer one has replaced it. */
  function endHydration(tabId: TabId, controller: AbortController): void {
    if (hydrations.get(tabId) === controller) {
      hydrations.delete(tabId);
    }
  }

  /**
   * Abort a tab's hydration in flight: the panels it was reading for are
   * gone (the last one detached, or the tab closed), so its HTTP calls are
   * cancelled instead of left to run to their deadline.
   */
  function cancelHydration(tabId: TabId, reason: string): void {
    clearHydrationRetry(tabId);
    const controller = hydrations.get(tabId);
    if (controller === undefined) {
      return;
    }
    hydrations.delete(tabId);
    controller.abort();
    log.debug('A background hydration was cancelled.', { tabId, reason });
  }

  /**
   * The pending retry per tab: the timer handle, on the injected timers. At
   * most one per tab; a detach, a newer schedule or disposal clears it.
   */
  const hydrationRetries = new Map<TabId, number>();

  /** Clear a tab's pending hydration retry, if any. */
  function clearHydrationRetry(tabId: TabId): void {
    const handle = hydrationRetries.get(tabId);
    if (handle !== undefined) {
      hydrationRetries.delete(tabId);
      timers.clearTimeout(handle);
    }
  }

  /**
   * Try a failed hydration of `tabId` again after the next delay of
   * {@link HYDRATION_RETRY_DELAYS_MS}. Nothing is scheduled for a failure that
   * would repeat itself, once the schedule is spent, or when the tab has no
   * panel left to hydrate; the try itself re-checks that.
   *
   * @param attempt How many retries preceded this failure (0 for the first read).
   */
  function scheduleHydrationRetry(tabId: TabId, attempt: number, failure: DebuggenError): void {
    if (disposed || !RETRYABLE_HYDRATION_CODES.has(failure.code) || !hasPanels(tabId)) {
      return;
    }
    const delayMs = HYDRATION_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) {
      log.info('A background hydration kept failing; no retry is left.', {
        tabId,
        errorCode: failure.code,
      });
      return;
    }
    clearHydrationRetry(tabId);
    const handle = timers.setTimeout(() => {
      if (hydrationRetries.get(tabId) !== handle) {
        return;
      }
      hydrationRetries.delete(tabId);
      if (disposed || !hasPanels(tabId)) {
        return;
      }
      background(pushTabStateToPanels(tabId, attempt + 1), 'panel hydration retry');
    }, delayMs);
    hydrationRetries.set(tabId, handle);
    log.debug('A background hydration will be retried.', { tabId, attempt: attempt + 1, delayMs });
  }

  /** Whether any panel document is associated with `tabId`. */
  function hasPanels(tabId: TabId): boolean {
    return hub
      .listConnections()
      .some((connection) => isPanelConnection(connection) && connection.tabId === tabId);
  }

  /** The binding push a hydration opens with, carrying the tab's binding state. */
  function bindingPushFor(state: PanelBindingState): PortPush {
    return {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'push',
      kind: 'binding',
      state,
    };
  }

  /**
   * Surface a background hydration's failure on the tab's panels as a
   * protocol `error` push — the panel's non-blocking failure notice — so a
   * stalled or failing service reads as a retryable error rather than as a
   * session with nothing in it. The payload is validated against the
   * protocol's error schema first; the message is the client's own constant
   * sentence (a timeout names the operation and its deadline), never a
   * response body.
   */
  function reportHydrationFailure(
    tabId: TabId,
    sessionId: SessionId,
    failure: DebuggenError,
  ): void {
    const parsed = parseErrorPayload(toErrorPayload(failure));
    const errorPayload = parsed.ok
      ? parsed
      : parseErrorPayload({ code: failure.code, message: failure.code });
    if (!errorPayload.ok) {
      return;
    }
    log.info('A background hydration failed.', { tabId, sessionId, errorCode: failure.code });
    pushProtocol(tabId, createEnvelope(MESSAGE_TYPE.ERROR, errorPayload.value, { sessionId }));
  }

  /**
   * Bring a tab's newly associated panels up to date: its binding state and,
   * when bound, the session record, analysis and panel — what a
   * `session.snapshot` answer would have carried, as the pushes that carry
   * them after it. A transient failure is surfaced and tried again
   * ({@link scheduleHydrationRetry}).
   *
   * @param attempt How many retries preceded this run (0 for the first).
   */
  async function pushTabStateToPanels(tabId: TabId, attempt = 0): Promise<void> {
    await ready;
    const state = await registry.getPanelBindingState(tabId);
    // The recipients are re-checked after the awaits: a panel that detached
    // during them found no hydration to cancel, so none may start for it now.
    if (disposed || !hasPanels(tabId)) {
      return;
    }
    hub.pushToPanels(tabId, bindingPushFor(state));
    await pushReloadState(tabId);
    if (state.kind !== 'bound' || !wsBridge.snapshot().hasCredential) {
      return;
    }
    const { sessionId } = state;
    const controller = beginHydration(tabId);
    let read: SessionDetailsRead;
    try {
      read = await readSessionDetails(sessionId, tabId, controller.signal);
    } finally {
      endHydration(tabId, controller);
    }
    if (controller.signal.aborted) {
      // Superseded, or its panels detached: nothing is left to update.
      return;
    }
    const { details, failure } = read;
    if (failure !== undefined) {
      reportHydrationFailure(tabId, sessionId, failure);
      scheduleHydrationRetry(tabId, attempt, failure);
    }
    if (details.session !== undefined) {
      pushProtocol(
        tabId,
        createEnvelope(MESSAGE_TYPE.SESSION_UPDATED, { session: details.session }),
      );
    }
    if (details.analysis !== undefined) {
      pushProtocol(
        tabId,
        createEnvelope(MESSAGE_TYPE.ANALYSIS_COMPLETED, { sessionId, analysis: details.analysis }),
      );
    }
    const { panel } = details;
    if (panel !== undefined) {
      // The HTTP view types the layout read-only; the frame's payload type is
      // the schema's mutable inference, so the array is copied, not cast.
      pushProtocol(
        tabId,
        createEnvelope(MESSAGE_TYPE.PANEL_GENERATED, {
          sessionId,
          panelId: panel.id,
          panel: { ...panel, layout: [...panel.layout] },
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // The one-click reload offer
  // -------------------------------------------------------------------------

  /**
   * Whether a tab's panels are offered the one-click reload — the one answer
   * both the `reload` pushes and the `page.reload` handler use. Never for a
   * tab that holds no binding (a reload is offered only on the page a session
   * observes), never for a bound page outside the origins the manifest's
   * content scripts match (no reload can bring the agent there, so an
   * `agent-missing` offer would only time out), and otherwise exactly what
   * agent-control's consent rule says. The panels receive it as the `reload`
   * push and the snapshot's `reload` field, pushed again whenever the tab's
   * readiness, a reload, a content-script bridge or the tab's binding changes
   * ({@link refreshReloadOffer}).
   */
  async function reloadStateFor(tabId: TabId): Promise<PanelReloadState> {
    return reloadOfferFor(await registry.getBinding(tabId));
  }

  /**
   * {@link reloadStateFor}'s rule for a binding already read — synchronous, so
   * the `page.reload` handler decides on, and reloads, the very binding it
   * checked, with no await in between.
   */
  function reloadOfferFor(binding: TabBindingRecord | undefined): PanelReloadState {
    if (binding === undefined || !isLocalAppOrigin(binding.origin)) {
      return PANEL_RELOAD_NOT_NEEDED;
    }
    return agent.getReloadOffer(binding.tabId);
  }

  /**
   * Push a tab's current reload offer to its panels. The offer is read after
   * the binding lookup settles, so of several pushes in flight each carries
   * the latest state rather than the one current when it was scheduled.
   */
  async function pushReloadState(tabId: TabId): Promise<void> {
    await ready;
    const state = await reloadStateFor(tabId);
    const push: PortReloadPush = {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'push',
      kind: 'reload',
      state,
    };
    const panels = hub.pushToPanels(tabId, push);
    log.debug('Reload offer pushed.', { tabId, reload: state.kind, panels });
  }

  /**
   * Refresh a tab's reload offer from a listener: no rejection escapes it, and
   * nothing is scheduled once the worker is disposed.
   */
  function refreshReloadOffer(tabId: TabId, trigger: string): void {
    if (disposed) {
      return;
    }
    background(pushReloadState(tabId), `reload offer after ${trigger}`);
  }

  /**
   * agent-control's state changes that move the offer: a readiness report, a
   * consented reload starting or settling, and a tab's agent state cleared.
   * A configuration routed or disarmed leaves readiness — and so the offer —
   * as it was.
   */
  function handleAgentChange(change: AgentControlChange): void {
    switch (change.kind) {
      case 'agent-ready':
      case 'reload-started':
      case 'reload-settled':
      case 'cleared':
        refreshReloadOffer(change.tabId, change.kind);
        return;
      case 'config-routed':
      case 'disarmed':
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Port lifecycle: DevTools closing is the unbind trigger (AAP §0.2.3)
  // -------------------------------------------------------------------------

  /**
   * A DevTools page left: DevTools closed on that tab (or its page reloaded,
   * after which it announces itself again and the tab re-binds). A disconnect
   * caused by the worker's own teardown is never a close.
   */
  async function handleDevtoolsClosed(event: PortClosedEvent<DevtoolsConnection>): Promise<void> {
    const tabId = event.connection.tabId;
    if (event.reason === 'disposed' || tabId === undefined || hasDevtools(tabId)) {
      return;
    }
    announcedTabs.delete(tabId);
    await ready;
    const removed = await registry.unbind(tabId, 'devtools-closed');
    log.info('DevTools closed on a tab.', { tabId, unbound: removed !== undefined });
  }

  /**
   * A panel left. With the tab's last panel gone, the tab's page pick is
   * cancelled: a reopened or reloaded panel document starts with picker mode
   * off, so a pick left armed would consume the developer's next ordinary
   * click with no panel showing picker mode on. While the tab's DevTools page
   * (or another panel) remains, this is otherwise only the panel document
   * reloading, and changes nothing more; with neither left and a binding
   * recorded, DevTools closed without its page reporting it, so the tab is
   * unbound the same way.
   */
  async function handlePanelClosed(event: PortClosedEvent<PanelConnection>): Promise<void> {
    untabbedPanels.delete(event.connection.connectionId);
    const tabId = event.connection.tabId;
    if (event.reason === 'disposed' || tabId === undefined) {
      return;
    }
    const connections = hub.listConnections();
    // A hydration reads for the tab's panels; with the last one detached its
    // reads — and its pending retry — have no recipient, so they are
    // cancelled rather than left to run. So is the page pick, sent whether or
    // not this worker generation recorded one, before any unbind below: no
    // panel is left showing picker mode for it, and a cancel with no active
    // pick is a no-op in the page.
    if (!hasPanels(tabId)) {
      cancelHydration(tabId, 'panel-detached');
      const { sent, recorded } = sendPickCancel(tabId);
      log.debug('The page pick was cancelled with the last panel of its tab.', {
        tabId,
        cancelSent: sent,
        recorded,
      });
    }
    const stillInspected = connections.some(
      (connection) =>
        (isDevtoolsConnection(connection) || isPanelConnection(connection)) &&
        connection.tabId === tabId,
    );
    if (stillInspected) {
      return;
    }
    await ready;
    if ((await registry.getBinding(tabId)) === undefined) {
      return;
    }
    await registry.unbind(tabId, 'devtools-closed');
    log.info('The last panel of a bound tab closed.', { tabId });
  }

  // -------------------------------------------------------------------------
  // The modules, each constructed exactly once
  // -------------------------------------------------------------------------

  /**
   * The `send` handed to `tab-registry.ts` and `agent-control.ts`: a frame
   * either module built, sent acting for the tab its own payload names.
   *
   * Every frame those modules send — `session.bind`, `session.unbind`,
   * `tab.navigated`, `agent.ready` — is about exactly one tab, the tab it is
   * sent for, and names it in its payload (taken from Chrome's port metadata,
   * never from a page). Restating that tab as the envelope's acting tab makes
   * the claim the frame already makes, which the protocol requires to agree;
   * it puts these frames under the same per-tab check as every other frame
   * this worker sends (AAP §0.5.6). An acting tab the caller supplied itself is
   * kept unchanged, and a payload that names no tab is sent as it is.
   * `wsBridge` is dereferenced only when a frame is sent, by which time it
   * exists.
   */
  const sendActingForPayloadTab: ProtocolSend = (type, payload, options) => {
    const tabId = options?.tabId === undefined ? payloadTabId(payload) : undefined;
    return wsBridge.send(type, payload, tabId === undefined ? options : { ...options, tabId });
  };

  const hub: PortHub = createPortHub({
    runtime,
    timers,
    handlers: requestHandlers,
    bridgeHandlers,
    devtoolsHandlers,
    events: {
      onConnected: (connection) => {
        log.debug('Port connected.', { role: connection.role, tabId: connection.tabId });
        if (connection.role === PORT_CONTENT_BRIDGE) {
          // A page agent's bridge attached: an `agent-missing` offer no longer stands.
          refreshReloadOffer(connection.tabId, 'bridge connected');
        }
      },
      onPanelDisconnected: (event) => handlePanelClosed(event),
      onDevtoolsDisconnected: (event) => handleDevtoolsClosed(event),
      onBridgeDisconnected: (event) => {
        log.debug('Content bridge disconnected.', {
          tabId: event.connection.tabId,
          reason: event.reason,
        });
        // A pick armed in the document this bridge served can no longer be
        // answered, so picker mode ends with it.
        releasePagePick(event);
        refreshReloadOffer(event.connection.tabId, 'bridge disconnected');
      },
    },
    resolveTabForSession: (sessionId) => registry.getTabForSession(sessionId),
    // Raised above the consented reload's bounded wait, so a `page.reload`
    // is answered by its own outcome rather than the hub's generic timeout.
    requestTimeoutMs: WORKER_REQUEST_TIMEOUT_MS,
    logger: rootLogger,
  });

  const registry: TabRegistry = createTabRegistry({
    storage: storage.session,
    send: sendActingForPayloadTab,
    notify: hub.pushToPanels,
    logger: rootLogger,
  });

  const agent: AgentControl = createAgentControl({
    sendToBridge: hub.sendToBridge,
    send: sendActingForPayloadTab,
    resolveBinding: async (sessionId) => {
      const tabId = await registry.getTabForSession(sessionId);
      return tabId === undefined ? undefined : registry.getBinding(tabId);
    },
    tabs,
    timers,
    // Tells a tab whose agent has not reported yet from one with no agent.
    hasBridge: hub.hasBridge,
    pushStatus: hub.pushToPanels,
    onChange: handleAgentChange,
    logger: rootLogger,
  });

  /**
   * Every status snapshot the bridge publishes: fanned out to every panel
   * (the pill is global), handed to the selections held for an open socket
   * ({@link waitForOpenTransport}), and watched for the transition to
   * `connected`, after which binds refused while the socket was closed are
   * sent again and every pending unbind is re-sent.
   *
   * The pending unbinds are the registry's persisted tombstones: an unbind
   * decided while the socket was down (a tab that closed or left the app, a
   * DevTools window that closed, a session that ended) sat only in the socket
   * client's memory, and an eviction of this worker loses that queue — while
   * the service keeps the binding across a dropped socket (AAP §0.5.5) and
   * would go on routing the session's traffic to the tab. `ws-bridge.ts`
   * re-announces only the bindings that remain, so this flush is what delivers
   * the ones that ended. It cannot undo a newer binding: a tab never holds a
   * record and a tombstone at once, and a bind for a tab retires its tombstone
   * before `session.bind` leaves, both on the registry's own queue.
   */
  function publishStatus(snapshot: WorkerStatusSnapshot): void {
    hub.broadcastToPanels(snapshot);
    trackSourceOpenSocket();
    for (const watch of [...transportWatchers]) {
      watch();
    }
    const previous = lastPublishedStatus;
    lastPublishedStatus = snapshot.status;
    if (previous === snapshot.status) {
      return;
    }
    log.info('Connection status changed.', { status: snapshot.status, previous });
    if (snapshot.status === 'connected') {
      background(registry.flushPendingUnbinds(), 'flush pending unbinds after connect');
      background(rebindAnnouncedTabs('connected'), 'rebind after connect');
    }
  }

  /** Keeps the source-open ledger in step with the socket; see `createSourceOpenSocketTracker`. */
  const trackSourceOpenSocket = createSourceOpenSocketTracker(
    sourceOpenRefs,
    () => (disposed ? undefined : socketHolder.bridge?.getStatus()),
    timers,
    log,
  );

  /**
   * The socket bridge's relay sink: every relayed frame goes to the port hub,
   * except the service's `error` refusal of a `source.open` this worker sent.
   * That frame is session-less, so the hub would broadcast it to every panel,
   * whose session store records its raw sentence as the panel's last failure;
   * the request it refuses already settles on it and reaches the panel as a
   * typed failure shown with fixed copy (`../panel/actions.ts`).
   */
  const relayToPanels: RelayPush = createSourceOpenRelayFilter(
    sourceOpenRefs,
    (message, tabId) => {
      hub.relayPush(message, tabId);
    },
    log,
  );

  const wsBridge: WsBridge = createWsBridge({
    webSocketConstructor: env.webSocketConstructor,
    // A thunk, dereferenced per request, so a client rebuilt for a changed
    // service address serves the bridge's very next call.
    httpClient: () => httpClient,
    tokenProvider: store.getToken,
    // Every DevTools read carries the read proof pairing issued with the credential.
    readProofProvider: store.getReadProof,
    onUnauthorized: store.handleUnauthorized,
    hasCredential: store.hasToken,
    alarms,
    timers,
    random: env.random,
    relayPush: relayToPanels,
    pushStatus: publishStatus,
    listBindings: registry.listBindings,
    serviceBaseUrl,
    // Held until the stored setting has been read once: the address above is
    // provisional until then, and nothing may be sent to it.
    serviceEndpointSettled: () => serviceEndpointSettled,
    // Telemetry the socket client queued and then discarded — its queue
    // overflowed while the service was unreachable, or the credential was
    // removed — is undelivered telemetry like any other. Only called from a
    // bridge member, by which time every map `recordTelemetryLoss` uses exists.
    onTelemetryDropped: (tabId, events) => {
      recordTelemetryLoss(tabId, 'undelivered', events);
    },
    // The same discards — loss-only frames included — as capture loss the
    // service's ledger was not told of: the frame's events and the loss it
    // carried, held under exactly the labels it was sent with.
    onTelemetryFrameDiscarded: (frame) => {
      holdPendingLoss(
        frame.tabId,
        { sessionId: frame.sessionId, captureId: frame.armedCaptureId },
        addLossCounts(frame.events, frame.droppedCount),
        'socket-queue',
      );
    },
    logger: rootLogger,
  });
  socketHolder.bridge = wsBridge;

  // -------------------------------------------------------------------------
  // The service address: stored setting > environment > default
  // -------------------------------------------------------------------------

  /**
   * Put a service address in force on both paths: rebuild the shared
   * `HttpClient` for it (the client's base URL is immutable) and move the
   * socket with {@link WsBridge.setServiceBaseUrl}. A refusal is handed to the
   * bridge as it is, which closes the socket, refuses HTTP and shows
   * "Service not running" with the refusal's hint — a stored address that is
   * unusable is never silently replaced by the default.
   */
  function applyServiceEndpoint(next: Result<string, DebuggenError>): void {
    if (disposed) {
      return;
    }
    serviceEndpoint = next;
    if (isErr(next)) {
      log.warn('The configured service address is unusable.', {
        errorCode: next.error.code,
        rule: next.error.details?.rule,
      });
      wsBridge.setServiceBaseUrl(next.error);
      return;
    }
    if (httpClient.baseUrl !== next.value) {
      httpClient = buildHttpClient(next.value);
      log.info('The service address changed.', {
        accepted: httpClient.configurationError === undefined,
      });
    }
    wsBridge.setServiceBaseUrl(next.value);
  }

  /**
   * The refusal put in force when the stored setting could not be read and no
   * earlier read established an address: failing closed, because the
   * environment's or the default address may belong to another process, and
   * the socket would hand it the devtools credential.
   */
  function unreadEndpointRefusal(cause?: unknown): DebuggenError {
    return workerError(
      'STORE_ERROR',
      'The saved service address could not be read, so the extension is not connecting to any service.',
      { hint: SERVICE_ADDRESS_UNREAD_HINT, ...(cause === undefined ? {} : { cause }) },
    );
  }

  /**
   * The address a stored setting calls for: the stored one, the environment's
   * (or the default) when none is stored, the refusal when the stored value is
   * unusable. When storage could not be read: `undefined` — keep the address
   * in force — once an earlier observation of the setting established it, and
   * a refusal ({@link unreadEndpointRefusal}) before any did.
   */
  function endpointFromSetting(
    stored: Result<string | undefined, DebuggenError>,
  ): Result<string, DebuggenError> | undefined {
    if (isErr(stored)) {
      if (stored.error.code !== 'STORE_ERROR') {
        return err(stored.error);
      }
      return serviceEndpointVerified ? undefined : err(unreadEndpointRefusal(stored.error));
    }
    return ok(stored.value ?? serviceBaseUrl);
  }

  /**
   * Read the stored setting and put it in force. A read overtaken by a storage
   * change is discarded — the change was applied when it arrived, and is the
   * fresher value. A read that succeeded — whatever it found — verifies the
   * setting ({@link serviceEndpointVerified}); a failed one never does.
   *
   * @returns The address in force afterwards, or why it is refused.
   */
  async function loadServiceEndpoint(): Promise<Result<string, DebuggenError>> {
    const changesBefore = serviceEndpointChanges;
    const stored = await readServiceEndpoint(storage.local, log);
    if (changesBefore !== serviceEndpointChanges) {
      return serviceEndpoint;
    }
    const next = endpointFromSetting(stored);
    if (!isErr(stored) || stored.error.code !== 'STORE_ERROR') {
      serviceEndpointVerified = true;
    }
    if (next !== undefined) {
      applyServiceEndpoint(next);
    }
    return serviceEndpoint;
  }

  /**
   * The cold start's first read of the setting, which opens the bridge's gate
   * ({@link serviceEndpointSettled}) whatever it found. A read that fails, or
   * a fault in applying it, leaves a refusal in force when the gate opens —
   * never the provisional address. Runs once; later calls return that run.
   */
  function establishServiceEndpoint(): Promise<void> {
    serviceEndpointEstablishment ??= (async () => {
      try {
        await loadServiceEndpoint();
      } catch (cause) {
        log.error('Putting the stored service address in force failed.', {
          error: errorName(cause),
        });
        if (!serviceEndpointVerified) {
          applyServiceEndpoint(err(unreadEndpointRefusal()));
        }
      } finally {
        openServiceEndpointGate();
      }
    })();
    return serviceEndpointEstablishment;
  }

  /**
   * Read the setting again while no read has established it — the retry
   * behind a panel's snapshot, a pairing attempt and the install or startup
   * connect. A no-op once it is established; storage changes are followed as
   * they arrive.
   */
  async function reloadUnverifiedServiceEndpoint(): Promise<void> {
    if (!serviceEndpointVerified) {
      await loadServiceEndpoint();
    }
  }

  /**
   * Follow the setting as the pairing dialog (or any other extension context)
   * writes it, validated again here: storage is shared, and what it holds is
   * untrusted data.
   */
  const handleServiceEndpointChange: CredentialStorageChangeListener = (changes) => {
    const change = changes[SERVICE_ENDPOINT_STORAGE_KEY];
    if (change === undefined) {
      return;
    }
    serviceEndpointChanges += 1;
    // The change carries the setting's new value: an observation of it as
    // good as a successful read.
    serviceEndpointVerified = true;
    const stored = change.newValue;
    applyServiceEndpoint(stored === undefined ? ok(serviceBaseUrl) : parseServiceEndpoint(stored));
  };

  // -------------------------------------------------------------------------
  // Binding changes and committed navigations
  // -------------------------------------------------------------------------

  /**
   * Keep the page agent — its configuration and any pick armed there — in step
   * with the tab's binding.
   */
  function handleBindingChange(change: TabBindingChange): void {
    switch (change.kind) {
      case 'recorded':
        if (
          change.previous !== undefined &&
          change.previous.sessionId !== change.current?.sessionId
        ) {
          agent.disarm(change.tabId, 'displaced');
          // A pick armed for the displaced session must not select for the new one.
          cancelPickWithBinding(change.tabId);
        }
        // An `agent.ready` that reached the service before the binding existed
        // was attributed to no session; re-relay it so the readiness gate sees
        // the tab's current document.
        agent.reannounce(change.tabId);
        // A newly bound tab may need the one-click reload offered.
        refreshReloadOffer(change.tabId, 'binding recorded');
        return;
      case 'updated':
        return;
      case 'removed': {
        const reason = disarmReasonFor(change);
        if (reason !== undefined) {
          agent.disarm(change.tabId, reason);
        }
        // Disarming does not end a pick in the page; the pick is cancelled there.
        cancelPickWithBinding(change.tabId);
        // An unbound tab is never offered a reload; withdraw a standing offer.
        refreshReloadOffer(change.tabId, 'binding removed');
        return;
      }
    }
  }

  /**
   * The URL of a committed navigation this `tabs.onUpdated` event reports, or
   * `undefined` when it reports none — {@link nextCommittedNavigation} over the
   * tab's remembered URL and status, whose memo is kept for the tab's next
   * event. A load Chrome reports in two events (the `loading` entry naming a
   * `pendingUrl`, then the `url` at commit) therefore reports once.
   */
  function committedNavigationUrl(
    tabId: TabId,
    changeInfo: WorkerTabChange,
    tab: WorkerTab,
  ): string | undefined {
    const step = nextCommittedNavigation(navigationMemo.get(tabId), changeInfo, tab);
    navigationMemo.set(tabId, step.memo);
    return step.url;
  }

  /**
   * Report a bound tab's committed navigation: the registry sends
   * `tab.navigated` and keeps or drops the binding by origin, and the agent
   * controller re-arms the new document (same origin) or clears the
   * configuration (different origin). Unbound tabs are not reported, to keep
   * the service free of every other tab's browsing.
   *
   * A bound tab that commits a document with no URL form the service accepts
   * (`chrome://`, `about:blank`, `file:`, an extension page) has left the app
   * just as surely as one that moved to another web origin, so it is never
   * dropped silently: the registry ends the binding with a sanitized
   * `session.unbind { tabId }` alone — the URL never leaves the worker — and
   * shows the panel "Tab left ‹origin›", and the agent controller clears the
   * tab's configuration, exactly as for a reported cross-origin navigation.
   */
  async function handleTabUpdated(
    tabId: TabId,
    changeInfo: WorkerTabChange,
    tab: WorkerTab,
  ): Promise<void> {
    const url = committedNavigationUrl(tabId, changeInfo, tab);
    if (url === undefined) {
      return;
    }
    await ready;
    if ((await registry.getBinding(tabId)) === undefined) {
      return;
    }
    const redacted = redactNavigationUrl(url);
    const reported =
      redacted === undefined
        ? undefined
        : urlFallbacks(redacted).find(
            (candidate) => parseTabNavigatedPayload({ tabId, url: candidate }).ok,
          );
    const decision =
      reported === undefined
        ? await registry.handleUnreportableNavigation(tabId)
        : await registry.handleNavigated({ tabId, url: reported });
    const outcome = agent.handleNavigationDecision(decision);
    log.info('Committed navigation of a bound tab.', {
      tabId,
      reportable: reported !== undefined,
      decision: decision.kind,
      agent: outcome.kind,
    });
  }

  // -------------------------------------------------------------------------
  // Socket subscriptions. Every type in RELAYED_MESSAGE_TYPES is already fanned
  // out to the panels by `ws-bridge.ts`; these only apply each frame to the
  // worker's own state, so none is relayed a second time.
  // -------------------------------------------------------------------------

  teardown.push(
    wsBridge.subscribe(MESSAGE_TYPE.AGENT_CONFIG, (message) => {
      background(
        agent.applyConfig(message.payload).then((outcome) => {
          log.debug('agent.config applied.', {
            sessionId: message.payload.sessionId,
            outcome: outcome.kind,
          });
        }),
        MESSAGE_TYPE.AGENT_CONFIG,
      );
    }),
    wsBridge.subscribe(MESSAGE_TYPE.SESSION_BOUND, (message) => {
      // The authoritative binding write, the announced replacement included.
      // A binding it records or keeps is also the tab's route, confirmed on
      // this connection (the bridge applied the frame before this subscriber):
      // once the registry holds it, the loss held for the tab can reach the
      // service's ledger.
      background(
        registry.applyBound(message.payload).then((applied) => {
          log.debug('session.bound applied.', {
            sessionId: message.payload.sessionId,
            outcome: applied.ok ? applied.value.kind : undefined,
            errorCode: errorCode(applied),
          });
          if (
            applied.ok &&
            (applied.value.kind === 'recorded' || applied.value.kind === 'updated')
          ) {
            deliverPendingLoss(applied.value.record.tabId);
          }
        }),
        MESSAGE_TYPE.SESSION_BOUND,
      );
    }),
    wsBridge.subscribe(MESSAGE_TYPE.CAPTURE_STARTED, (message) => {
      // Stored on the bound tab, so a reload mid-capture continues the same capture.
      background(registry.handleCaptureStarted(message.payload), MESSAGE_TYPE.CAPTURE_STARTED);
    }),
    wsBridge.subscribe(MESSAGE_TYPE.CAPTURE_STOPPED, (message) => {
      background(registry.handleCaptureStopped(message.payload), MESSAGE_TYPE.CAPTURE_STOPPED);
    }),
    wsBridge.subscribe(MESSAGE_TYPE.SESSION_UPDATED, (message) => {
      // An ended session unbinds its tab; the binding change disarms the agent.
      background(registry.handleSessionUpdated(message.payload), MESSAGE_TYPE.SESSION_UPDATED);
    }),
    wsBridge.subscribe(MESSAGE_TYPE.CLEANUP_COMPLETED, (message) => {
      background(
        registry.handleSessionEnded(message.payload.sessionId),
        MESSAGE_TYPE.CLEANUP_COMPLETED,
      );
    }),
    wsBridge.subscribe(MESSAGE_TYPE.SESSION_CREATED, () => {
      background(rebindAnnouncedTabs('session-created'), 'rebind after session.created');
    }),
    wsBridge.subscribe(MESSAGE_TYPE.TARGET_REQUEST, (message) => {
      // The service asked the bound tab for a target (the editor's
      // `POST /sessions/:id/target/request`, AAP §0.4.2: it "asks the panel to
      // enter picker mode"). `ws-bridge.ts` relays the frame to the tab's
      // panels, and the panel is the one arming authority: it enters picker
      // mode and arms the page agent through `target.pick`, reporting a
      // failure and leaving picker mode when that fails. Arming here as well
      // would arm twice, and nothing is sent to the DevTools page, whose
      // Elements selection must not become the target unasked.
      log.debug('target.request relayed to the panels, which arm picker mode.', {
        sessionId: message.payload.sessionId,
      });
    }),
    wsBridge.subscribe(MESSAGE_TYPE.SOURCE_RESULT, (message) => {
      // An answer to a request whose port request already timed out still
      // retires its id, so the ledger holds only requests awaiting one.
      sourceOpenRefs.forget(message.payload.ref);
    }),
    registry.onChange(handleBindingChange),
    store.onStateChange((state) => {
      // `paired` connects, `not-paired` closes the socket and disarms the
      // keepalive; either way the bridge publishes a fresh status snapshot.
      wsBridge.handlePairingState(state);
    }),
  );

  // -------------------------------------------------------------------------
  // Chrome listeners — all registered synchronously, during this call, which
  // the module makes during its own first evaluation.
  // -------------------------------------------------------------------------

  /** Add a listener, and record how `dispose` removes it. */
  function listen<Listener>(event: WorkerEvent<Listener>, listener: Listener): void {
    event.addListener(listener);
    teardown.push(() => {
      event.removeListener(listener);
    });
  }

  /** Start (or keep) the socket once the cold-start work has settled. */
  function ensureConnected(trigger: string): void {
    background(
      ready.then(async () => {
        await reloadUnverifiedServiceEndpoint();
        await wsBridge.connect();
      }),
      `connect on ${trigger}`,
    );
  }

  // Installed, updated or a profile started: start the socket when a
  // credential exists. The keepalive alarm is created only by the bridge — by
  // `wsBridge.connect()`, and re-created by its heartbeat while a socket is
  // open — so only when there is a socket to keep alive, and `alarms.create`
  // replaces an alarm of the same name, so this is idempotent.
  listen(runtime.onInstalled, (details) => {
    log.info('Extension installed or updated.', { reason: details.reason });
    ensureConnected('installed');
  });
  listen(runtime.onStartup, () => {
    log.info('Browser profile started.');
    ensureConnected('startup');
  });

  // A panel, a DevTools page or a content bridge: the hub classifies and
  // validates the port; panels are associated with their tab on their first
  // `session.snapshot` request, DevTools pages by their `devtools.hello`.
  listen(runtime.onConnect, (port) => {
    hub.handleConnect(port);
  });

  listen(tabs.onUpdated, (tabId, changeInfo, tab) => {
    background(handleTabUpdated(tabId, changeInfo, tab), 'tab update');
  });

  listen(tabs.onRemoved, (tabId) => {
    navigationMemo.delete(tabId);
    announcedTabs.delete(tabId);
    cancelHydration(tabId, 'tab-closed');
    // Batches already queued still settle on their own lane (and find the tab
    // unbound once the unbind below lands; one waiting for the tab's route
    // ends when the service withdraws it, or at its deadline); the entry
    // itself is released now.
    telemetryLanes.delete(tabId);
    // A closed tab has no panel left to be told of its loss, and no route
    // left to carry the loss held for the service.
    forgetTelemetryLoss(tabId);
    forgetPendingLoss(tabId);
    agent.clear(tabId);
    background(
      registry.unbind(tabId, 'tab-closed').then((removed) => {
        if (removed !== undefined) {
          log.info('A bound tab closed.', { tabId, sessionId: removed.sessionId });
        }
      }),
      'tab removal',
    );
  });

  // The service address the pairing dialog saves takes effect at once, on the
  // socket and on every HTTP call; the credential store adds its own listener
  // to the same event for the credential's key.
  if (storage.local.onChanged !== undefined) {
    listen(storage.local.onChanged, handleServiceEndpointChange);
  }

  // The keepalive tick. The alarm does not keep the worker from being
  // suspended: firing after a suspension revives it, and the tick reconnects.
  // Every other alarm belongs to no module here.
  listen(alarms.onAlarm, (alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM_NAME) {
      return;
    }
    background(
      ready.then(() => wsBridge.handleKeepaliveAlarm(alarm)),
      'keepalive',
    );
  });

  // Best effort only: Manifest V3 does not guarantee this event, and nothing
  // here depends on it — every state that matters is in storage or is rebuilt
  // by the announcements that follow a revival.
  if (runtime.onSuspend !== undefined) {
    listen(runtime.onSuspend, () => {
      log.info('Worker suspending.', {
        connections: hub.listConnections().length,
        status: wsBridge.snapshot().status,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Cold start — after every listener exists
  // -------------------------------------------------------------------------

  /**
   * Hydrate the bindings, put the stored service address in force, read the
   * credential and, with one, open the socket — at that address.
   */
  async function start(): Promise<void> {
    try {
      const bindings = await registry.reload();
      await establishServiceEndpoint();
      await wsBridge.connect();
      log.info('Worker started.', {
        bindings: bindings.length,
        status: wsBridge.snapshot().status,
      });
    } finally {
      // A start-up that failed before the read still reads the setting and
      // opens the gate, so pairing and the next connect are not held forever
      // — with a refusal in force when the read fails. A no-op otherwise.
      await establishServiceEndpoint();
    }
  }

  // `coldStartSettled` flips inside the chain, so every continuation of
  // `ready` already sees start-up as settled.
  const ready: Promise<void> = start()
    .then(undefined, (cause: unknown) => {
      log.error('Worker start-up failed.', { error: errorName(cause) });
    })
    .then(() => {
      coldStartSettled = true;
    });

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const release of teardown.splice(0).reverse()) {
      try {
        release();
      } catch (cause) {
        log.warn('Releasing a listener failed.', { error: errorName(cause) });
      }
    }
    for (const tabId of new Set([...hydrations.keys(), ...hydrationRetries.keys()])) {
      cancelHydration(tabId, 'disposed');
    }
    releaseTelemetryCustody();
    agent.dispose();
    hub.disposeAll();
    store.dispose();
    // Queued batches settle without sending: `forwardTelemetryBatch` checks
    // `disposed` once the cold start has settled, a batch waiting for its
    // route is released by the bridge's close below, and each job clears its
    // own deadline timer as it settles.
    telemetryLanes.clear();
    background(wsBridge.close(), 'close');
    log.info('Worker disposed.');
  }

  return Object.freeze({
    ready,
    get httpClient(): HttpClient {
      return httpClient;
    },
    store,
    hub,
    registry,
    agent,
    wsBridge,
    dispose,
  });
}

/*
 * ===========================================================================
 * Section E — the bootstrap Chrome runs
 * ===========================================================================
 */

/**
 * The platform's one-shot timers with the numeric handles `WorkerTimerApi`
 * requires. `self` is resolved at call time, so importing this module where no
 * worker global exists (a unit test) is harmless.
 */
const platformTimers: WorkerTimerApi = {
  setTimeout: (handler, ms) => self.setTimeout(handler, ms),
  clearTimeout: (handle) => {
    self.clearTimeout(handle);
  },
};

/**
 * The real Chrome environment, or `undefined` when this module is evaluated
 * anywhere but an extension service worker — so importing it in a test
 * attaches no listener and opens no socket.
 */
function chromeEnvironment(): WorkerEnvironment | undefined {
  if (typeof chrome === 'undefined' || typeof WebSocket === 'undefined') {
    return undefined;
  }
  const namespace: Partial<typeof chrome> = chrome;
  const { runtime, tabs, alarms, storage } = namespace;
  if (
    runtime?.id === undefined ||
    tabs === undefined ||
    alarms === undefined ||
    storage?.local === undefined ||
    storage.session === undefined
  ) {
    return undefined;
  }
  return {
    runtime,
    tabs,
    alarms,
    storage,
    webSocketConstructor: WebSocket,
    timers: platformTimers,
  };
}

/** Create the worker when running as the extension's service worker. */
function bootstrap(): DebugGeneratorWorker | undefined {
  const environment = chromeEnvironment();
  return environment === undefined ? undefined : createWorker(environment);
}

/**
 * The extension's worker, composed synchronously while Chrome evaluates this
 * module — which is what puts every listener in place before the event that
 * woke the worker is dispatched. `undefined` outside an extension service
 * worker.
 */
export const serviceWorker: DebugGeneratorWorker | undefined = bootstrap();
