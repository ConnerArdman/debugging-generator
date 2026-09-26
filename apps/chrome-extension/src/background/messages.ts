/**
 * The service worker's own type layer — the foundation every other module in
 * `apps/chrome-extension/src/background/` stands on.
 *
 * ## What this module is
 *
 * The background folder is six collaborating modules — `service-worker.ts`
 * (the manifest entry and the only wiring point), `ws-bridge.ts` (the one
 * socket and every HTTP call), `tab-registry.ts` (the tab ↔ session memory in
 * `chrome.storage.session`), `agent-control.ts` (arming, re-arming and the
 * consented reload), `ports.ts` (the runtime-port registry and router) and
 * `auth.ts` (the devtools credential). Every one of them imports this module;
 * this module imports **none** of them. That one-way edge is what keeps the
 * folder acyclic: the four behavioural modules never import one another, they
 * receive each other's capabilities as the injected contracts declared here,
 * and only `service-worker.ts` knows which implementation stands behind which
 * contract.
 *
 * What lives here is exactly the *worker-internal* layer, and nothing else:
 *
 * - the descriptors of the three kinds of port connected to the worker
 *   (Section B);
 * - the structural contracts one worker module is handed by another — send a
 *   protocol frame, subscribe to one, push to a panel, send to a bridge, the
 *   timer and alarm facilities (Section C);
 * - the shapes the worker persists or snapshots — the tab binding row, the
 *   status the panel renders, the readiness memo per tab (Section D);
 * - a handful of pure guards and frame builders, and the two keepalive
 *   constants two modules share (Section E).
 *
 * ## What does not live here, and where it lives instead
 *
 * Three contracts are owned elsewhere and are only ever *referenced* from this
 * file — never restated (AAP §0.2.3: "Any second definition of these shapes in
 * an app is a defect"):
 *
 * 1. **Product wire types** — `@debuggen/protocol`: the envelope, every message
 *    payload of AAP §0.4.2, `MessageType`, `SendOutcome`, `TimerApi`,
 *    `ErrorPayload`, `DataResult`, `SessionRecord`.
 * 2. **The extension-internal channel contract** — `../shared/messages`: the
 *    three port names, the panel ↔ worker request/response/push frames, the
 *    bridge and devtools frames, the relayed-message list, the page-channel
 *    mirror and the panel's connection and binding vocabulary.
 * 3. **Shared primitives** — `@debuggen/shared`: `DebuggenError` and its closed
 *    code vocabulary, `Result`, the id aliases and the epoch-millisecond clock.
 *
 * ## Invariants
 *
 * - **No import-time side effect and no `chrome.*` call.** Every top-level
 *   statement is a declaration; `chrome.runtime.Port` and `chrome.alarms`
 *   appear only in type positions. The module therefore loads under Vitest
 *   with no extension environment, which is how
 *   `apps/chrome-extension/test/**` imports it.
 * - **Imports stay browser-safe.** `@debuggen/protocol`, `@debuggen/shared`'s
 *   root entry (never `@debuggen/shared/node`) and `../shared/messages`, with
 *   extensionless relative specifiers (`moduleResolution: bundler`). No
 *   `@debuggen/telemetry` runtime, no `@debuggen/panel-renderer`, no `ws`, no
 *   Node builtin module, no `process`/`Buffer`, nothing from `apps/demo-app`.
 * - **No secret material.** No shape here holds a credential, a pairing code, a
 *   request or response body or raw page data; {@link WorkerStatusSnapshot}
 *   reports only *whether* a credential exists, and {@link portErr} serializes
 *   an error's code, message and `ref` only — never its `cause` or stack, and
 *   of its `details` nothing but the schema-validated `owningSessionId` of a
 *   capture-ownership conflict.
 *
 * Governed by AAP §0.2.5 (the chrome-extension file list), §0.7.1 Group 4
 * ("extension-internal message types"), §0.2.3 (tab/session binding and the
 * single-definition rule), §0.4.2 (the message table this module references)
 * and §0.5.5 (the recovery states whose worker-side representation is here).
 *
 * @module apps/chrome-extension/src/background/messages
 */

import type {
  AgentReadyPayload,
  CreateEnvelopeOptions,
  ErrorPayload,
  MessageHandler,
  MessagePayload,
  MessageType,
  SendOutcome,
  SessionBindPayload,
  TimerApi,
  Unsubscribe,
} from '@debuggen/protocol';
import {
  CAPTURE_CONFLICT_ERROR_CODE,
  captureStartConflictResponseSchema,
  toErrorPayload,
} from '@debuggen/protocol';
import type {
  CaptureId,
  DebuggenErrorCode,
  DebuggenErrorOptions,
  nowEpochMs,
  Result,
  SessionId,
} from '@debuggen/shared';
import { DebuggenError } from '@debuggen/shared';

import type {
  AgentOutboundType,
  BridgeDownstreamMessage,
  BridgeUpstreamMessage,
  DevtoolsDownstreamMessage,
  ExtensionPortName,
  PanelBindingState,
  PanelConnectionState,
  PORT_CONTENT_BRIDGE,
  PORT_DEVTOOLS,
  PORT_PANEL,
  PortFailureResponse,
  PortPush,
  PortRequest,
  PortRequestFrame,
  PortRequestKind,
  PortResponsePayloads,
  PortSuccessResponse,
  RelayedProtocolMessage,
} from '../shared/messages';
import {
  EXTENSION_CHANNEL,
  isPortRequestOfKind,
  isRelayedMessageType,
  PORT_PROTOCOL_VERSION,
} from '../shared/messages';

/*
 * ===========================================================================
 * Section A — derived primitives
 *
 * Aliases derived from their owners' declarations, so this module names the
 * same types its owners do instead of re-spelling `number` and `string` with
 * a comment. Module-private: a consumer names the owner's type, or reads the
 * field type off the interface that carries it.
 * ===========================================================================
 */

/**
 * A Chrome tab id, exactly as the protocol's binding payloads type it — the
 * same derivation `../shared/messages` uses.
 */
type TabId = SessionBindPayload['tabId'];

/**
 * A wall-clock instant in Unix epoch milliseconds: the shared time base, as
 * {@link nowEpochMs} returns it. Every `…At` stamp below is on this base, so a
 * stamp taken by the worker compares directly with a protocol envelope's `ts`.
 */
type EpochMs = ReturnType<typeof nowEpochMs>;

/**
 * A plain object — not `null`, not an array. The one structural building
 * block {@link isRelayedMessage} needs.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string with at least one character: every identifier on an envelope. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/*
 * ===========================================================================
 * Section B — worker connection descriptors
 *
 * One descriptor per runtime port connected to the worker, built by `ports.ts`
 * in `chrome.runtime.onConnect` and held only in memory: a Manifest V3 worker
 * is evicted after about thirty seconds idle (AAP §0.1.1), every port dies with
 * it, and a revived worker starts with no descriptors at all. Anything that must
 * outlive a suspension is a {@link TabBindingRecord} in `chrome.storage.session`
 * instead.
 *
 * Descriptors are immutable values. A fact learned after connect — the panel's
 * inspected tab, the page's document id — is recorded by replacing the
 * descriptor with an updated copy, so a reference someone already holds never
 * changes underneath them.
 * ===========================================================================
 */

/**
 * The role of a connection: which of the extension's three port channels it
 * arrived on.
 *
 * Exactly the imported {@link ExtensionPortName} — the port name *is* the role
 * — so the three channel strings are spelled once, in `../shared/messages`,
 * and a fourth channel added there widens this union in the same edit.
 */
export type WorkerPortRole = ExtensionPortName;

/**
 * The worker-minted identifier of one connection.
 *
 * Monotonic within one worker generation (a counter or a sortable id minted by
 * `ports.ts`) and opaque to everyone else; it exists so a panel can be
 * addressed before it has reported its tab, and so an index entry can be
 * matched to the exact port that created it. Never sent to the service.
 */
export type WorkerConnectionId = string;

/** The fields every connection descriptor carries. */
interface WorkerConnectionBase<Role extends WorkerPortRole> {
  /** Which channel this port arrived on — the discriminant. */
  readonly role: Role;
  /** The live runtime port. Posting to it throws once its page has gone. */
  readonly port: chrome.runtime.Port;
  /** See {@link WorkerConnectionId}. */
  readonly connectionId: WorkerConnectionId;
  /** When the port connected, in epoch milliseconds. */
  readonly connectedAt: EpochMs;
}

/**
 * A DevTools panel document connected on `PORT_PANEL`.
 *
 * `tabId` is `undefined` until the panel (or the devtools page of the same
 * DevTools window) reports its inspected tab: a panel port comes from an
 * extension page, so its `sender` names no tab. Until then the panel is
 * reachable by {@link WorkerConnectionId} only, and receives no tab-scoped
 * pushes.
 */
export interface PanelConnection extends WorkerConnectionBase<typeof PORT_PANEL> {
  /** The inspected tab, once reported. */
  readonly tabId: TabId | undefined;
}

/**
 * The isolated-world content-script bridge of one page, connected on
 * `PORT_CONTENT_BRIDGE`.
 *
 * `tabId` is always known: it is read from the port's `sender.tab.id`, never
 * from a payload, and a bridge port without one is refused at connect.
 * `documentId` and `url` are known once the page agent's `agent.ready` has
 * travelled up this port (`url` is query-redacted by the agent before it
 * leaves the page, AAP §0.5.2), and are `undefined` before that.
 */
export interface BridgeConnection extends WorkerConnectionBase<typeof PORT_CONTENT_BRIDGE> {
  /** The tab the bridge runs in, from the port's sender. */
  readonly tabId: TabId;
  /** The page agent's per-document id, from its `agent.ready`. */
  readonly documentId: AgentReadyPayload['documentId'] | undefined;
  /** The document's redacted URL, from its `agent.ready`. */
  readonly url: AgentReadyPayload['url'] | undefined;
}

/**
 * The devtools page of one DevTools window, connected on `PORT_DEVTOOLS`.
 *
 * `tabId` is `undefined` until its `devtools.hello` frame names
 * `chrome.devtools.inspectedWindow.tabId`. This port's `onDisconnect` is the
 * "DevTools closed" signal behind `session.unbind` (AAP §0.2.3).
 */
export interface DevtoolsConnection extends WorkerConnectionBase<typeof PORT_DEVTOOLS> {
  /** The inspected tab, once reported. */
  readonly tabId: TabId | undefined;
}

/**
 * Any connection descriptor, discriminated on `role`, so a `switch` over
 * `connection.role` narrows exhaustively — ending in `assertNever` from
 * `@debuggen/shared` in the `default` arm.
 */
export type WorkerConnection = PanelConnection | BridgeConnection | DevtoolsConnection;

/**
 * The descriptor of one role: `WorkerConnectionOfRole<typeof PORT_PANEL>` is
 * {@link PanelConnection}. For registries and indexes keyed by role.
 */
export type WorkerConnectionOfRole<Role extends WorkerPortRole> = Extract<
  WorkerConnection,
  { readonly role: Role }
>;

/*
 * ===========================================================================
 * Section C — injected collaborator contracts (the anti-cycle layer)
 *
 * `ws-bridge.ts`, `tab-registry.ts`, `agent-control.ts` and `ports.ts` never
 * import one another. Each receives the capabilities it needs from the others
 * as one of these function or interface types, which `service-worker.ts`
 * satisfies with the real implementation and a unit test satisfies with a
 * recording fake. Every one is a type: nothing here performs work.
 *
 * Where the protocol package already names the shape — `SendOutcome`,
 * `MessageHandler`, `Unsubscribe`, `TimerApi` — the contract is composed from
 * that name, so the worker and `ReconnectingWsClient` cannot disagree about it.
 * ===========================================================================
 */

/**
 * Send one protocol frame to the local service.
 *
 * The exact signature of `ReconnectingWsClient.send`, so
 * `(type, payload, options) => client.send(type, payload, options)` satisfies
 * it with no adapter: the payload type is resolved from the message type, the
 * optional {@link CreateEnvelopeOptions} carry a routing `sessionId`, and the
 * outcome is the client's own `Result` — `ok('sent')`, `ok('queued')` (a frame
 * handed over while the socket reconnects is a success, AAP §0.5.5) or an
 * `err` when the client is closed. It never throws for an expected condition.
 *
 * @example
 * ```ts
 * const outcome = send('tab.navigated', { tabId, url });
 * if (!outcome.ok) logger.warn('tab.navigated not sent', { code: outcome.error.code });
 * ```
 */
export type ProtocolSend = <K extends MessageType>(
  type: K,
  payload: MessagePayload<K>,
  options?: CreateEnvelopeOptions,
) => Result<SendOutcome, DebuggenError>;

/**
 * Register a typed handler for one inbound protocol message type.
 *
 * Mirrors `ReconnectingWsClient.on`: the handler receives the validated frame
 * already narrowed to that type, and the returned {@link Unsubscribe} removes
 * the subscription (calling it twice is harmless). `service-worker.ts`
 * subscribes on behalf of the other modules — `agent.config` for
 * `agent-control.ts`, `session.bound` and the capture lifecycle for
 * `tab-registry.ts` — which is why the unsubscribe function matters.
 */
export type ProtocolSubscribe = <K extends MessageType>(
  type: K,
  handler: MessageHandler<K>,
) => Unsubscribe;

/**
 * Fan one relayed protocol frame out to DevTools panels.
 *
 * The frame is typed as the imported {@link RelayedProtocolMessage} — the
 * union of the relayed envelopes, discriminated on `type` — rather than as
 * `MessageByType<RelayedMessageType>`, which would pair the union of types with
 * the union of payloads and lose the discrimination (`../shared/messages`
 * records the same reasoning). Narrow an inbound frame to it with
 * {@link isRelayedMessage}.
 *
 * `tabId`, when given, is the tab whose panels receive the frame. When it is
 * absent the implementation resolves the recipient from the frame's session
 * binding; it must never broadcast session data to panels of unrelated tabs.
 */
export type RelayPush = (message: RelayedProtocolMessage, tabId?: TabId) => void;

/**
 * Push one extension-internal {@link PortPush} — a relayed frame, a connection
 * state or a binding state — to every panel bound to one tab.
 *
 * The narrower contract `tab-registry.ts` and `agent-control.ts` are handed:
 * they know the tab, and they have no business reaching panels of any other.
 * A tab with no panel attached is a normal condition, not an error, so the
 * contract returns nothing.
 */
export type PortPushSink = (tabId: TabId, push: PortPush) => void;

/**
 * Publish the worker's current {@link WorkerStatusSnapshot}.
 *
 * Handed to `ws-bridge.ts` (connection transitions, queue drops) and to
 * `agent-control.ts` (agent readiness); `service-worker.ts` turns the snapshot
 * into `connection` and `binding` pushes for the panels. Separate from
 * {@link PortPushSink} because worker status is not scoped to one tab: every
 * open panel renders the same connection pill.
 */
export type WorkerStatusSink = (snapshot: WorkerStatusSnapshot) => void;

/**
 * Send one worker → bridge frame to the content-script bridge of one tab.
 *
 * Returns `true` when a bridge port for that tab took the frame, and `false`
 * when no bridge is attached (the page has not loaded yet, is mid-navigation,
 * or is not a local app origin) or its port turned out to be dead. A `false`
 * is a recoverable state rather than an error — `agent-control.ts` keeps the
 * configuration pending and delivers it on the next `agent.ready` (AAP §0.5.5)
 * — which is why the outcome is a plain boolean and never a throw.
 */
export type BridgeSend = (tabId: TabId, message: BridgeDownstreamMessage) => boolean;

/**
 * Send one worker → devtools-page frame to the devtools page inspecting one
 * tab — a relayed `target.request`, or a request to describe the current `$0`
 * selection.
 *
 * Same outcome convention as {@link BridgeSend}: `false` means no devtools
 * page for that tab is connected, which the caller treats as "DevTools is not
 * open", not as a failure.
 */
export type DevtoolsSend = (tabId: TabId, message: DevtoolsDownstreamMessage) => boolean;

/**
 * The one-shot timer half of the worker's clock: `ReconnectingWsClient`'s own
 * {@link TimerApi}, aliased rather than restated, so the same fake timers
 * drive the socket's backoff and the worker's RPC and readiness timeouts in a
 * unit test.
 */
export type WorkerTimerApi = TimerApi;

/**
 * When a `chrome.alarms` alarm fires: a repeating period, with an optional
 * first delay, in minutes.
 *
 * Chrome clamps both to thirty seconds (`0.5`) in a packed extension — see
 * {@link KEEPALIVE_PERIOD_MINUTES}. Only the repeating form is modelled,
 * because the keepalive is the only alarm the worker creates.
 */
export interface WorkerAlarmSchedule {
  /** How often the alarm repeats, in minutes. */
  readonly periodInMinutes: number;
  /** How long until the first firing, in minutes; defaults to the period. */
  readonly delayInMinutes?: number | undefined;
}

/**
 * The `chrome.alarms` operations the keepalive needs, and nothing more.
 *
 * `chrome.alarms` itself satisfies it — {@link ChromeAlarmsSatisfiesWorkerAlarmsApi}
 * proves that at compile time — so `service-worker.ts` passes the real
 * namespace, and a test passes a two-method fake. Firing is not part of the
 * contract: `service-worker.ts` registers `chrome.alarms.onAlarm` and calls
 * the owning module's handler, so no injected dependency registers a listener.
 */
export interface WorkerAlarmsApi {
  /** Create, or replace, the alarm of that name. */
  create(name: string, schedule: WorkerAlarmSchedule): Promise<void>;
  /** Clear the alarm of that name; resolves `true` when one existed. */
  clear(name: string): Promise<boolean>;
}

/**
 * Fails to compile unless its argument is exactly `true` — the same private
 * helper `@debuggen/protocol` declares per module for its drift assertions.
 */
type AssertTrue<Assertion extends true> = Assertion;

/**
 * Compile-time proof that the real `chrome.alarms` namespace is assignable to
 * {@link WorkerAlarmsApi}: if `@types/chrome` ever changes `create` or `clear`
 * incompatibly, the argument below becomes `false` and `tsc -b` fails here
 * (TS2344) rather than at the wiring in `service-worker.ts`. Type-level only —
 * it emits nothing, and it is exported solely so `noUnusedLocals` accepts it.
 */
export type ChromeAlarmsSatisfiesWorkerAlarmsApi = AssertTrue<
  typeof chrome.alarms extends WorkerAlarmsApi ? true : false
>;

/**
 * Every time facility the worker uses, injectable as one value.
 *
 * `now` is the epoch-millisecond clock (production: `nowEpochMs` from
 * `@debuggen/shared`) that stamps `connectedAt`, `boundAt` and `receivedAt`;
 * `timers` schedules the bounded waits; `alarms` holds the keepalive, which
 * revives the worker after Manifest V3 suspends it rather than preventing the
 * suspension. A module that needs only one of the three takes only that member.
 */
export interface WorkerClock {
  /** The current time, in epoch milliseconds. */
  readonly now: () => EpochMs;
  /** One-shot timers. */
  readonly timers: WorkerTimerApi;
  /** The keepalive alarm operations. */
  readonly alarms: WorkerAlarmsApi;
}

/*
 * ===========================================================================
 * Section D — persisted and snapshot shapes
 * ===========================================================================
 */

/**
 * One tab ↔ session binding, as `tab-registry.ts` persists it in
 * `chrome.storage.session`.
 *
 * Written only after the service confirmed the binding with `session.bound`
 * (the service decides; the worker records, AAP §0.2.3). `url` and `origin`
 * are those of the bound document; `origin` is kept separately so a committed
 * navigation is classified as same-origin (keep and re-arm) or cross-origin
 * (unbind) without re-parsing on every read.
 *
 * `captureId` is present while a capture is in flight on this tab. It is what
 * lets a mid-capture reload continue the **same** capture: on a same-origin
 * `tab.navigated` the binding and its `captureId` survive, and the re-armed
 * agent resumes under that id (AAP §0.5.5, "the same `captureId` continues").
 */
export interface TabBindingRecord {
  /** The bound tab. */
  readonly tabId: TabId;
  /** The session the service bound it to. */
  readonly sessionId: SessionId;
  /** The bound document's URL, as the service announced it. */
  readonly url: string;
  /** That URL's serialized origin, e.g. `http://127.0.0.1:3000`. */
  readonly origin: string;
  /** When the binding was recorded, in epoch milliseconds. */
  readonly boundAt: EpochMs;
  /** The capture running on this tab, when one is. */
  readonly captureId?: CaptureId | undefined;
}

/**
 * Every binding, in the JSON form written to and read from
 * `chrome.storage.session`: a plain object keyed by the tab id rendered as a
 * decimal string, because storage values are JSON and JSON object keys are
 * strings.
 *
 * Two consequences for every consumer:
 *
 * - under `noUncheckedIndexedAccess` each lookup (`snapshot[String(tabId)]`)
 *   is `TabBindingRecord | undefined`, and the `undefined` is a real state —
 *   no binding, or an entry a previous worker generation never wrote — to be
 *   handled, never asserted away;
 * - what is read back is untrusted data from an earlier worker generation, so
 *   `tab-registry.ts` validates each entry before it relies on it; this type
 *   describes what is *written*, not a guarantee about what is read.
 */
export interface TabBindingSnapshot {
  readonly [tabId: string]: TabBindingRecord;
}

/**
 * Everything the panel needs to render the worker's state, as one serializable
 * value — so every recovery state of AAP §0.5.5 is something the panel is
 * *told*, never something it infers from missing frames.
 *
 * It extends the imported {@link PanelConnectionState}: `status` is the
 * connection pill's state, from the `PANEL_CONNECTION_STATUSES` vocabulary
 * that `../shared/messages` owns together with its labels ("Connected",
 * "Reconnecting…", "Not paired", "Service not running"), and `retryInMs` and
 * `serviceUrl` accompany it exactly as they do on a `connection` push. The
 * fields added here are what the worker alone knows.
 *
 * ⚠️ This object is serialized to panel documents. It must never contain a
 * credential or pairing code (`hasCredential` is a boolean for exactly that
 * reason), a page URL whose query string has not been redacted upstream, a
 * request or response body, or raw telemetry.
 */
export interface WorkerStatusSnapshot extends PanelConnectionState {
  /** Whether a devtools credential from pairing is stored — never the credential itself. */
  readonly hasCredential: boolean;
  /** The inspected tab's binding, when the snapshot is for one tab. */
  readonly binding?: PanelBindingState | undefined;
  /** The bound session, when known. */
  readonly sessionId?: SessionId | undefined;
  /** The capture in flight on the bound tab, when there is one. */
  readonly captureId?: CaptureId | undefined;
  /**
   * What the developer can do about the current state, when there is
   * something: for `'service-not-running'`, the documented command that
   * starts the local service.
   */
  readonly hint?: string | undefined;
  /**
   * How many outbound frames the socket client's queue has dropped since this
   * worker started — counted by message type only, never by content — so a
   * developer can see that data was lost while the service was away.
   */
  readonly droppedFrameCount?: number | undefined;
}

/**
 * The worker's memo of the last `agent.ready` received for one tab.
 *
 * Picked from the imported {@link AgentReadyPayload} rather than restated, so
 * the field types are the protocol's. `documentId` is what makes "ready for
 * the bound tab's **current** document" decidable: a ready from a previous
 * document of the same tab is recognisably stale. `installedBeforeReact` is
 * what `agent-control.ts` gates the consented reload on — a reload is offered
 * only when it is `false` — and `reactDetected` separates "no React on this
 * page" (no reload would help) from "React loaded before the hook" (a reload
 * would). The page URL is deliberately not kept: nothing in the worker needs
 * it after relaying the ready upward.
 */
export interface AgentReadinessState extends Readonly<
  Pick<
    AgentReadyPayload,
    'tabId' | 'documentId' | 'producerId' | 'installedBeforeReact' | 'reactDetected'
  >
> {
  /** When the worker received that `agent.ready`, in epoch milliseconds. */
  readonly receivedAt: EpochMs;
}

/*
 * ===========================================================================
 * Section E — pure guards, frame builders and shared constants
 *
 * Pure functions only: no `chrome.*`, no I/O, no state. Each is total — it
 * returns a value for every input and never throws.
 * ===========================================================================
 */

/**
 * Whether a value is a protocol envelope of one of the relayed message types —
 * the frames the worker forwards from the service socket to the panel.
 *
 * Membership is decided by the imported `isRelayedMessageType`, which tests
 * against `RELAYED_MESSAGE_TYPES` in `../shared/messages`; no message type is
 * named here. The envelope's framing fields are checked too (`id`, `ts`, an
 * optional `sessionId`, a `payload` object), so an arbitrary object carrying a
 * relayed `type` string is not narrowed to an envelope it is not. The payload
 * itself is not re-validated: frames reaching this guard come from
 * `ReconnectingWsClient`, which validated them against the protocol's schemas.
 *
 * @param message An inbound frame, or anything else.
 * @returns `true` when `message` is a relayed envelope, narrowing it to the
 * discriminated {@link RelayedProtocolMessage} union.
 */
export function isRelayedMessage(message: unknown): message is RelayedProtocolMessage {
  if (!isRecord(message)) {
    return false;
  }
  const sessionId = message.sessionId;
  return (
    isRelayedMessageType(message.type) &&
    isNonEmptyString(message.id) &&
    typeof message.ts === 'number' &&
    Number.isFinite(message.ts) &&
    (sessionId === undefined || isNonEmptyString(sessionId)) &&
    isRecord(message.payload)
  );
}

/**
 * Narrow a bridge → worker frame to one frame type, so a router dispatches on
 * the discriminant without a cast.
 *
 * The frame must already have passed `isBridgeUpstreamMessage` from
 * `../shared/messages`, which validated it; this guard only selects.
 *
 * @param message A validated frame received on the bridge port.
 * @param kind The frame type to test for: `agent.ready`, `telemetry.batch`,
 * `target.described` or `agent.error`.
 * @returns `true` when `message` is of that type, narrowing its `payload`.
 */
export function isBridgeMessageOfKind<Kind extends AgentOutboundType>(
  message: BridgeUpstreamMessage,
  kind: Kind,
): message is Extract<BridgeUpstreamMessage, { readonly type: Kind }> {
  return message.type === kind;
}

/**
 * Narrow a panel → worker request to one request kind ("method"), so
 * `ports.ts` looks up the matching handler without a cast.
 *
 * A request-only view of the imported `isPortRequestOfKind`, to which it
 * delegates: the parameter is typed {@link PortRequest}, so a response or a
 * push cannot be passed by mistake. The request must already have passed
 * `isPortRequest`.
 *
 * @param request A validated request received on the panel port.
 * @param method The request kind to test for, e.g. `'panelData.query'`.
 * @returns `true` when `request` is of that kind, narrowing its `payload`.
 */
export function isPortRequestOfMethod<Method extends PortRequestKind>(
  request: PortRequest,
  method: Method,
): request is Extract<PortRequest, { readonly kind: Method }> {
  return isPortRequestOfKind(request, method);
}

/**
 * Build the successful answer to a panel request: the framing fields, the
 * request's own `requestId` and `kind` echoed back, and the kind's typed
 * payload.
 *
 * Correlation is taken from the request object, never from a separate
 * argument, so an answer cannot be matched to the wrong request.
 *
 * @param request The request being answered, narrowed to its kind.
 * @param payload That kind's success payload, from {@link PortResponsePayloads}.
 * @returns A response frame that passes `isPortResponse`.
 */
export function portOk<Kind extends PortRequestKind>(
  request: PortRequestFrame<Kind>,
  payload: PortResponsePayloads[Kind],
): PortSuccessResponse<Kind> {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'response',
    requestId: request.requestId,
    kind: request.kind,
    ok: true,
    payload,
  };
}

/**
 * The owning session of a capture-ownership conflict, as the one detail a
 * port failure may carry: present only on a `capture.start` answer whose error
 * code is the protocol's `CAPTURE_CONFLICT_ERROR_CODE` and whose
 * `details.owningSessionId` passes the protocol's own `owningSessionId` schema
 * (the field of `captureStartConflictResponseSchema`, the `409` body the
 * protocol's `HttpClient` copies into `details` when it parses it).
 *
 * @param kind The kind of the request being answered.
 * @param error Why it failed.
 * @returns The validated owning session id, or `undefined`.
 */
export function captureConflictOwningSessionId(
  kind: PortRequestKind,
  error: DebuggenError,
): SessionId | undefined {
  if (kind !== 'capture.start' || error.code !== CAPTURE_CONFLICT_ERROR_CODE) {
    return undefined;
  }
  const parsed = captureStartConflictResponseSchema.shape.owningSessionId.safeParse(
    error.details?.owningSessionId,
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * Build the failed answer to a panel request, carrying the error as the
 * protocol's `ErrorPayload` — or, for a capture held by another session, as
 * the protocol's capture-conflict body.
 *
 * The error is serialized through the protocol's `toErrorPayload`, which
 * projects the class's own `toPayload()` onto the strict wire shape
 * `{ code, message, ref? }`: the `hint` is not part of that shape, and
 * `details`, `cause` and the stack never leave the worker — they can carry
 * paths and values (AAP §0.5.2). A developer-facing hint reaches the panel
 * through {@link WorkerStatusSnapshot.hint} instead.
 *
 * One detail is whitelisted, by name and by schema: the `owningSessionId` of a
 * `capture.start` refused with `CAPTURE_ALREADY_ACTIVE`
 * ({@link captureConflictOwningSessionId}). AAP §0.4.2 specifies that `409`
 * as `{ owningSessionId }` precisely so a client can name the session that
 * holds the project's capture, and the panel's `PortErrorPayload` admits it on
 * that answer only. Nothing else from `details` is ever copied.
 *
 * An error with an empty message would produce a frame the panel's
 * `parsePortResponse` refuses — leaving the panel waiting for an answer that
 * was dropped — so the error's code stands in for a missing message.
 *
 * @param request The request being answered, narrowed to its kind.
 * @param error Why it failed.
 * @returns A response frame that passes `parsePortResponse`.
 */
export function portErr<Kind extends PortRequestKind>(
  request: PortRequestFrame<Kind>,
  error: DebuggenError,
): PortFailureResponse<Kind> {
  const projected = toErrorPayload(error);
  const payload: ErrorPayload =
    projected.message.length > 0 ? projected : { code: projected.code, message: projected.code };
  const owningSessionId = captureConflictOwningSessionId(request.kind, error);
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'response',
    requestId: request.requestId,
    kind: request.kind,
    ok: false,
    error: owningSessionId === undefined ? payload : { ...payload, owningSessionId },
  };
}

/**
 * Build a {@link DebuggenError} for a worker-side failure, with its code
 * constrained to the closed `DEBUGGEN_ERROR_CODES` vocabulary of
 * `@debuggen/shared` — so every background module reports failures in the
 * vocabulary the panel, the service and the protocol's `error` schema all
 * understand, instead of inventing strings. No code is added here.
 *
 * @param code The most specific shared code that fits, e.g.
 * `'TRANSPORT_DISCONNECTED'`, `'TAB_NOT_BOUND'` or `'AGENT_NOT_READY'`.
 * @param message One sentence describing what failed. It may be shown to the
 * developer, so it must not contain a credential, a pairing code or page data.
 * @param options An optional developer hint, diagnostic `details` (logged in
 * the worker, never serialized to a panel by {@link portErr} — except the
 * whitelisted conflict owner of {@link captureConflictOwningSessionId}) and
 * `cause`.
 * @returns The error; nothing is thrown.
 *
 * @example
 * ```ts
 * return err(workerError('TAB_NOT_BOUND', 'This tab is not bound to a session.'));
 * ```
 */
export function workerError(
  code: DebuggenErrorCode,
  message: string,
  options?: DebuggenErrorOptions,
): DebuggenError {
  return new DebuggenError(code, message, options);
}

/**
 * The name of the worker's keepalive alarm.
 *
 * Read by `ws-bridge.ts`, which creates and clears the alarm, and by
 * `service-worker.ts`, whose `chrome.alarms.onAlarm` listener recognises it and
 * calls the bridge's handler — the two modules that must agree on it, which is
 * why it is declared once, here.
 */
export const KEEPALIVE_ALARM_NAME = 'debuggen.keepalive';

/**
 * How often the keepalive alarm fires, in minutes: `0.5`, i.e. every thirty
 * seconds.
 *
 * A Manifest V3 service worker is suspended after about thirty seconds without
 * an extension event (AAP §0.1.1, §0.5.5), and thirty seconds is also the
 * shortest period Chrome honours for an alarm in a packed extension, so this
 * is the one value that is both permitted and short enough: each firing is an
 * extension event that resets the idle timer, and gives `ws-bridge.ts` the
 * chance to reconnect a dropped socket.
 */
export const KEEPALIVE_PERIOD_MINUTES = 0.5;
