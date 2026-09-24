/**
 * The Chrome extension's internal message contract — the one module every
 * surface of the "Debug Generator" DevTools extension speaks to every other.
 *
 * ## What this module is
 *
 * The extension has four runtime surfaces, and none of them may import another:
 *
 * - `../panel/**` — the DevTools panel document, which renders `PanelHost` and
 *   reaches the service only through the service worker;
 * - `../background/**` — the module service worker, which owns the
 *   authenticated WebSocket, the tab ↔ session registry, agent arming and every
 *   port;
 * - `../content/bridge.ts` — the isolated-world content script that relays the
 *   MAIN-world telemetry agent's frames over a runtime port;
 * - `../devtools/**` — the devtools page, which knows the inspected tab id and
 *   observes the Elements panel's `$0` selection.
 *
 * What they say to each other is defined here, once: the three runtime port
 * names, the panel ↔ worker request/response/push frames, the bridge ↔ worker
 * and devtools ↔ worker frames, the page ↔ bridge `window.postMessage` frames,
 * the connection-status vocabulary the panel's status pill renders, the binding
 * state it renders beside it, and the single default service base URL. It is a
 * pure declaration module — types, constants, type guards and a few pure
 * helpers — so it is importable by `apps/chrome-extension/test/**` under
 * Vitest with no browser and no extension environment.
 *
 * Governed by AAP §0.2.5 (the chrome-extension file list), §0.7.1 Group 4
 * ("extension-internal message types"), §0.4.2 (the cross-component message
 * contract), §0.2.3 (tab/session binding and the single-definition rule),
 * §0.5.5 (graceful-failure states), §0.5.6 (the access boundary and the Chrome
 * pairing flow) and §0.7.3 (the panel UI and its connection-pill wording).
 *
 * ## Invariants
 *
 * 1. **No wire type is redefined.** Envelopes, payloads, `SessionRecord`,
 *    `AnalysisResult`, `PanelSpec`, `DataQuery`, `DataResult`,
 *    `SelectedTarget`, `AgentHookConfig`, `TelemetryEventIngress`,
 *    `CaptureSummary`, `BindingReason` and the error shape are imported from
 *    `@debuggen/protocol`, `@debuggen/panel-schema` and `@debuggen/shared` and
 *    used by reference; a variant is derived (`Omit`, `MessagePayload<…>`,
 *    indexed access), never retyped (AAP §0.2.5: "Any second definition of
 *    these shapes in an app is a defect").
 * 2. **Imports stay inside the workspace's runtime dependencies.** No
 *    `@debuggen/telemetry` (a devDependency kept only for build ordering), no
 *    `@debuggen/instrumentation`, no `@debuggen/shared/node`, no `zod`, no
 *    `ws`, no `node:*` builtin and nothing from `apps/demo-app`.
 * 3. **No side effect at import and no `chrome.*` access.** Every top-level
 *    statement is a declaration; the surfaces own their own extension APIs.
 * 4. **No secret material.** `token` appears only as a field name — the
 *    devtools credential lives at run time in `chrome.storage.local`
 *    (AAP §0.5.6) and the page handshake token in the bridge's closure.
 * 5. **No demo knowledge and no route paths.** HTTP paths come from
 *    `@debuggen/protocol`'s `buildPath`/`HTTP_ROUTES`, the socket path from its
 *    `WS_PATH`/`resolveWsUrl`.
 *
 * ## Why the page ↔ bridge hop carries no protocol envelope
 *
 * AAP §0.4.2 makes the **service worker** the component that wraps the agent's
 * raw event batches into `@debuggen/protocol` envelopes: "agent → SW (raw
 * `{ events: TelemetryEventIngress[] }` over the bridge) → service (wrapped in
 * the envelope by the SW)". The agent bundle never imports the protocol, and
 * the bridge is a validating pass-through, so both the page channel and the
 * bridge port carry raw payloads. Only the worker ↔ service socket, and the
 * worker → panel relay of what arrived on it, carry envelopes.
 *
 * ## MIRROR CONTRACT — `packages/telemetry/src/browser/transport.ts`
 *
 * ---------------------------------------------------------------------------
 * The page ↔ bridge channel is owned by `packages/telemetry/src/browser/
 * transport.ts`, and the constants below MIRROR its published literals. The
 * agent ships as a prebuilt IIFE copied verbatim into `public/agent.iife.js`,
 * and `@debuggen/telemetry` is not a runtime dependency of this workspace, so
 * the bridge cannot import them — it is compiled against this copy instead.
 * Anyone changing one side MUST change the other in the same commit, and
 * `apps/chrome-extension/test/bridge.test.ts` asserts the literals.
 *
 * | Mirror here                          | Owner in transport.ts              | Value                         |
 * | ------------------------------------ | ---------------------------------- | ----------------------------- |
 * | `AGENT_SOURCE_TAG`                   | `AGENT_SOURCE_TAG`                 | `'debuggen-agent'`            |
 * | `BRIDGE_SOURCE_TAG`                  | `BRIDGE_SOURCE_TAG`                | `'debuggen-bridge'`           |
 * | `PAGE_CHANNEL_VERSION`               | `CHANNEL_VERSION`                  | `2`                           |
 * | `PAGE_MESSAGE_TARGET_ORIGIN`         | `SAME_ORIGIN_TARGET` (private)     | `'/'`                         |
 * | `PAGE_HANDSHAKE_REQUEST_EVENT`       | `HANDSHAKE_REQUEST_EVENT`          | `'debuggen-bridge-handshake'` |
 * | `PAGE_HANDSHAKE_OFFER_EVENT`         | `HANDSHAKE_OFFER_EVENT`            | `'debuggen-agent-handshake'`  |
 * | `PAGE_HANDSHAKE_TOKEN_LENGTH`        | `HANDSHAKE_TOKEN_CHARS` (private)  | `64` lowercase hex characters |
 * | `MAX_PAGE_MESSAGE_BYTES`             | `MAX_MESSAGE_BYTES`                | `524_288` (512 KiB)           |
 * | `approximatePageMessageBytes`        | `measureFrame` (private)           | `JSON.stringify(frame).length`|
 * | `AGENT_OUTBOUND_TYPES`               | `AgentOutboundType`                | four frame types              |
 * | `BRIDGE_OUTBOUND_TYPES`              | `BridgeInboundType`                | five frame types              |
 * | `AgentChannelPayloads`               | `postControl`/`buildBatchPayload`  | payload field sets            |
 * | `BridgeChannelPayloads`              | `agent.ts` inbound readers         | payload field sets            |
 *
 * transport.ts is authoritative wherever an older description of the channel
 * differs, and this file follows it: the channel is at **version 2** (not 1);
 * every bridge → page frame carries the document's handshake `token`
 * (see {@link PAGE_HANDSHAKE_REQUEST_EVENT}); the size cap is **512 KiB**
 * measured as the JSON rendering's **code-unit length** — the agent's own
 * measure, so a frame the agent accepted can never be refused here (a UTF-8
 * byte count would be larger for non-ASCII text and would drop valid batches);
 * `telemetry.batch` carries `producerId`, `documentId`, `batchSeq` and
 * `droppedCount` beside `events`; `target.described` answers `target: null`
 * when nothing is describable; and `agent.error` is an open diagnostic record,
 * not a fixed `{ message, stack }` pair.
 * ---------------------------------------------------------------------------
 *
 * @module apps/chrome-extension/src/shared/messages
 */

import type {
  AgentConfigPayload,
  AgentReadyPayload,
  AnalysisResult,
  BindingReason,
  CaptureStartResponse,
  CaptureStopResponse,
  ConnectionState,
  DataResult,
  ErrorPayload,
  MessagePayload,
  MessageType,
  PairCompleteRequest,
  PanelSpec,
  ProtocolMessageMap,
  SelectedTarget,
  SessionBindPayload,
  SessionRecord,
} from '@debuggen/protocol';
import { BINDING_REASONS } from '@debuggen/protocol';
import type { DataQuery } from '@debuggen/panel-schema';
import type { CaptureId, MessageId, ProducerId, SessionId } from '@debuggen/shared';
import { newMessageId } from '@debuggen/shared';

/*
 * ===========================================================================
 * Section A — private building blocks
 *
 * Predicates the guards below are composed from. Every one narrows through
 * `typeof`, `Array.isArray` and plain property reads on a
 * `Record<string, unknown>`, so no guard in this module needs a cast or a
 * non-null assertion, and every one returns `false` rather than throwing.
 * ===========================================================================
 */

/**
 * Compile-time completeness check for a vocabulary tuple.
 *
 * Resolves to the tuple's element union, and is a compile error (TS2344) when
 * `Keys` names a member the tuple lacks — so a payload map that gains a key
 * without its tuple gaining the same name fails `tsc -b` at the declaration
 * that pairs them. The `satisfies` clause on each tuple is the other half: it
 * rejects a tuple element the map does not know.
 */
type TupleCovering<Tuple extends readonly string[], Keys extends Tuple[number]> = [Keys] extends [
  Tuple[number],
]
  ? Tuple[number]
  : never;

/** A Chrome tab id, exactly as the protocol's binding payloads type it. */
type TabId = SessionBindPayload['tabId'];

/** A plain object — not `null`, not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An object with no own enumerable keys: the `{}` payload of a signal frame. */
function isEmptyRecord(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

/** A string with at least one character: every identifier on these frames. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Absent, or a string. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/** Absent, or a non-empty string. */
function isOptionalId(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

/** A whole number that is zero or more: counters and sequence numbers. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Absent, or a whole number of one or more: an optional bound. */
function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  );
}

/**
 * A Chrome tab id: a non-negative safe integer. `-1` is
 * `chrome.tabs.TAB_ID_NONE`, never a tab, which is also the protocol's rule.
 */
function isTabId(value: unknown): value is TabId {
  return isCount(value);
}

/** An array whose every element is a string. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((element) => typeof element === 'string');
}

/** A record whose every own value is a boolean: the shape of `AgentHookConfig`. */
function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every((flag) => typeof flag === 'boolean');
}

/**
 * Membership in a closed string vocabulary, narrowing to it without a cast.
 *
 * @param vocabulary The tuple to test against.
 * @param value The value to test, typically read off an untrusted frame.
 */
function isMember<Member extends string>(
  vocabulary: readonly Member[],
  value: unknown,
): value is Member {
  return typeof value === 'string' && vocabulary.some((member) => member === value);
}

/**
 * The structural shape of a `SelectedTarget` descriptor.
 *
 * Deliberately structural rather than authoritative: the descriptor's single
 * definition — bounds, single-line rules, strictness — is
 * `@debuggen/instrumentation`'s `selectedTargetSchema`, embedded by the
 * protocol's `target.selected` payload, and the service applies it when the
 * worker forwards the value. This check only guarantees that a relay reading
 * `target.selector` or `target.componentChain` reads the declared types.
 */
function isSelectedTargetShape(value: unknown): value is SelectedTarget {
  return (
    isRecord(value) &&
    isNonEmptyString(value.selector) &&
    isNonEmptyString(value.tagName) &&
    isOptionalString(value.text) &&
    isStringArray(value.componentChain) &&
    isNonEmptyString(value.url)
  );
}

/** `null` (nothing describable), or a descriptor shape. */
function isNullableSelectedTargetShape(value: unknown): value is SelectedTarget | null {
  return value === null || isSelectedTargetShape(value);
}

/*
 * ===========================================================================
 * Section B — the service's default base URL
 * ===========================================================================
 */

/**
 * The local service's default base URL: loopback, the product's default port
 * (AAP §0.5.6 — the service binds `127.0.0.1` only).
 *
 * The one statement of this value in the extension; no other file writes it.
 * `@debuggen/protocol` exports the path builders and the socket path but no
 * base-URL constant, which is why the literal lives here. Derive everything
 * else from it through the protocol, never by concatenation — which also keeps
 * every route path out of this workspace's source for `check:no-hardcoding`:
 *
 * ```ts
 * const socketUrl = resolveWsUrl(DEFAULT_SERVICE_BASE_URL); // Result<string>, WS_PATH appended
 * const http = new HttpClient({ baseUrl: DEFAULT_SERVICE_BASE_URL, token: readToken });
 * const path = buildPath('panel.data', { id: sessionId }); // derived from HTTP_ROUTES
 * ```
 *
 * No separate host or port constant exists, and no environment variable is
 * read: an extension has no `process`, and a developer who runs the service
 * elsewhere changes the stored service URL, not this default.
 */
export const DEFAULT_SERVICE_BASE_URL = 'http://127.0.0.1:43117';

/*
 * ===========================================================================
 * Section C — runtime port names
 * ===========================================================================
 */

/**
 * The DevTools panel document ↔ service worker port.
 *
 * Carries {@link PanelPortMessage}: the panel's requests, the worker's
 * responses, and the worker's pushes of relayed protocol frames, connection
 * state and binding state.
 */
export const PORT_PANEL = 'debuggen.panel';

/**
 * The isolated-world content-script bridge ↔ service worker port.
 *
 * Carries {@link BridgeUpstreamMessage} (agent frames the bridge accepted) and
 * {@link BridgeDownstreamMessage} (agent configuration and requests). The
 * worker learns the tab and document from the port's `sender`, never from a
 * payload.
 */
export const PORT_CONTENT_BRIDGE = 'debuggen.bridge';

/**
 * The devtools page ↔ service worker port.
 *
 * A port of its own, rather than a message on the panel's, for two reasons.
 * The devtools page is the context that holds
 * `chrome.devtools.inspectedWindow.tabId` and observes
 * `panels.elements.onSelectionChanged` / `$0` (AAP §0.7.1 Group 4), and it
 * exists whether or not the Debug Generator panel was ever opened. And a
 * long-lived port's `onDisconnect` is the only reliable signal that DevTools
 * closed, which AAP §0.2.3 requires to produce `session.unbind`.
 */
export const PORT_DEVTOOLS = 'debuggen.devtools';

/**
 * Every port name this extension opens, in one tuple.
 *
 * The worker's `chrome.runtime.onConnect` routes on these; no surface writes a
 * port name inline — each imports the constant.
 */
export const EXTENSION_PORT_NAMES = [PORT_PANEL, PORT_CONTENT_BRIDGE, PORT_DEVTOOLS] as const;

/** One of {@link EXTENSION_PORT_NAMES}. */
export type ExtensionPortName = (typeof EXTENSION_PORT_NAMES)[number];

/**
 * Whether a connecting port's `name` is one of this extension's.
 *
 * @param value A `chrome.runtime.Port`'s `name`, or anything else.
 * @returns `true` only for a member of {@link EXTENSION_PORT_NAMES}.
 */
export function isExtensionPortName(value: unknown): value is ExtensionPortName {
  return isMember(EXTENSION_PORT_NAMES, value);
}

/*
 * ===========================================================================
 * Section D — port framing
 *
 * Every frame on every port carries the same three framing fields, so one
 * validation shape serves all three ports: a `channel` discriminator, a
 * `version`, and a `direction`. A frame from a surface that was built against
 * an older copy of this module — a panel left open across an extension reload,
 * say — fails the version check and is dropped rather than half-understood.
 * ===========================================================================
 */

/** The `channel` value on every port frame. */
export const EXTENSION_CHANNEL = 'debuggen';

/** The `version` on every port frame; bumped on any incompatible frame change. */
export const PORT_PROTOCOL_VERSION = 1;

/**
 * The correlation id a port request carries and its response echoes.
 *
 * An alias over the shared id vocabulary: a request id is minted exactly as a
 * protocol frame id is, and is as opaque.
 */
export type PortRequestId = MessageId;

/**
 * Mint a fresh {@link PortRequestId}.
 *
 * A call-time function — never evaluated at module scope — delegating to
 * `@debuggen/shared`'s `newMessageId`.
 */
export function newPortRequestId(): PortRequestId {
  return newMessageId();
}

/** The framing fields every port frame starts with. */
export interface PortFrameBase<Direction extends string> {
  /** Always {@link EXTENSION_CHANNEL}. */
  readonly channel: typeof EXTENSION_CHANNEL;
  /** Always {@link PORT_PROTOCOL_VERSION}. */
  readonly version: typeof PORT_PROTOCOL_VERSION;
  /** Which way, and in what role, the frame travels. */
  readonly direction: Direction;
}

/**
 * The frame-level check every port guard starts with: a record on this
 * channel, at this version, travelling in the expected direction.
 */
function isPortFrame(value: unknown, direction: string): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.channel === EXTENSION_CHANNEL &&
    value.version === PORT_PROTOCOL_VERSION &&
    value.direction === direction
  );
}

/*
 * ===========================================================================
 * Section E — connection status and binding state (what the panel renders)
 * ===========================================================================
 */

/**
 * The four states of the panel's `ConnectionStatus` pill (AAP §0.7.3).
 *
 * A **display** vocabulary, and not a redefinition of the transport's
 * `ConnectionState` (`connecting | open | reconnecting | closed`, owned by
 * `@debuggen/protocol`'s `client/ws-client.ts`): the pill is a function of the
 * transport state, of whether a devtools credential exists, and of whether the
 * service answers at all — see {@link panelConnectionStatus}.
 */
export const PANEL_CONNECTION_STATUSES = [
  'connected',
  'reconnecting',
  'not-paired',
  'service-not-running',
] as const;

/** One of {@link PANEL_CONNECTION_STATUSES}. */
export type PanelConnectionStatus = (typeof PANEL_CONNECTION_STATUSES)[number];

/**
 * The pill's text for each status, verbatim from AAP §0.7.3 and §0.5.5.
 *
 * `'Reconnecting…'` ends in a single U+2026 HORIZONTAL ELLIPSIS, not three
 * full stops. What accompanies each state — the session name beside
 * "Connected", the pairing dialog behind "Not paired", the start command
 * beside "Service not running" — is the panel's to render.
 */
export const PANEL_CONNECTION_LABELS: Readonly<Record<PanelConnectionStatus, string>> =
  Object.freeze({
    connected: 'Connected',
    reconnecting: 'Reconnecting\u2026',
    'not-paired': 'Not paired',
    'service-not-running': 'Service not running',
  });

/**
 * The connection state the worker pushes to the panel, so the panel renders a
 * state rather than inferring one from missing frames.
 */
export interface PanelConnectionState {
  /** The pill's state. */
  readonly status: PanelConnectionStatus;
  /** On `'reconnecting'`: how long until the next attempt, in milliseconds. */
  readonly retryInMs?: number | undefined;
  /** The service base URL the worker is trying, for the panel's hint text. */
  readonly serviceUrl?: string | undefined;
}

/** What {@link panelConnectionStatus} decides from. */
export interface PanelConnectionInput {
  /** The WebSocket client's state, in the protocol's transport vocabulary. */
  readonly transport: ConnectionState;
  /** Whether a devtools credential from pairing is stored. */
  readonly paired: boolean;
  /** Whether the service's unauthenticated health route answered. */
  readonly serviceReachable: boolean;
}

/**
 * Map the transport's state, credential presence and service reachability onto
 * the pill's four states. Pure and deterministic; the precedence is:
 *
 * 1. no credential → `'not-paired'`: the service refuses every socket without
 *    one (AAP §0.5.6), so no transport state means anything until pairing;
 * 2. transport `'open'` → `'connected'`;
 * 3. service unreachable → `'service-not-running'`: retrying cannot succeed
 *    until the developer starts it;
 * 4. otherwise → `'reconnecting'` — `connecting`, `reconnecting` and a
 *    `closed` socket to a service that answers are all a retry in progress.
 *
 * @param input The three facts the worker holds.
 * @returns The status to push to the panel.
 */
export function panelConnectionStatus(input: PanelConnectionInput): PanelConnectionStatus {
  if (!input.paired) {
    return 'not-paired';
  }
  if (input.transport === 'open') {
    return 'connected';
  }
  if (!input.serviceReachable) {
    return 'service-not-running';
  }
  return 'reconnecting';
}

/**
 * Whether a value is a well-formed {@link PanelConnectionState}.
 *
 * @param value A push's `state`, or anything else.
 */
export function isPanelConnectionState(value: unknown): value is PanelConnectionState {
  return (
    isRecord(value) &&
    isMember(PANEL_CONNECTION_STATUSES, value.status) &&
    (value.retryInMs === undefined || isCount(value.retryInMs)) &&
    isOptionalString(value.serviceUrl)
  );
}

/**
 * The inspected tab's relationship to a session, as the panel renders it.
 *
 * - `unbound` — no session holds this tab (none started, DevTools reopened
 *   before binding, or the session ended);
 * - `bound` — the service answered `session.bound` for this tab;
 * - `tab-left` — the tab navigated to a different origin and the binding was
 *   dropped (AAP §0.2.3, §0.5.5); the panel shows
 *   {@link formatTabLeftMessage}. `reason` is the protocol's own
 *   `BindingReason` when the drop was announced by the service.
 *
 * Exhaustively narrowable on `kind`.
 */
export type PanelBindingState =
  | { readonly kind: 'unbound' }
  | {
      readonly kind: 'bound';
      readonly sessionId: SessionId;
      readonly tabId: TabId;
      readonly url: string;
    }
  | {
      readonly kind: 'tab-left';
      readonly origin: string;
      readonly sessionId?: SessionId | undefined;
      readonly reason?: BindingReason | undefined;
    };

/** The fixed prefix of {@link formatTabLeftMessage}'s text. */
export const TAB_LEFT_MESSAGE_PREFIX = 'Tab left ';

/**
 * The panel's notice when the bound tab navigated to another origin: AAP
 * §0.2.3's "Tab left ‹origin›", where the guillemets mark interpolation and are
 * not part of the rendered text.
 *
 * @param origin The serialized origin the notice names.
 * @returns For example `Tab left http://127.0.0.1:3000`.
 */
export function formatTabLeftMessage(origin: string): string {
  return `${TAB_LEFT_MESSAGE_PREFIX}${origin}`;
}

/**
 * Whether a value is a well-formed {@link PanelBindingState}.
 *
 * @param value A push's `state`, a snapshot's `binding`, or anything else.
 */
export function isPanelBindingState(value: unknown): value is PanelBindingState {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.kind) {
    case 'unbound':
      return true;
    case 'bound':
      return (
        isNonEmptyString(value.sessionId) && isTabId(value.tabId) && isNonEmptyString(value.url)
      );
    case 'tab-left':
      return (
        typeof value.origin === 'string' &&
        isOptionalId(value.sessionId) &&
        (value.reason === undefined || isMember(BINDING_REASONS, value.reason))
      );
    default:
      return false;
  }
}

/*
 * ===========================================================================
 * Section F — the panel ↔ worker port (`PORT_PANEL`)
 *
 * The panel never holds a socket (AAP §0.1.2: UI components are not coupled to
 * WebSocket details). It sends requests over its port and receives responses
 * and pushes; the worker performs the HTTP call or the socket send and answers.
 * ===========================================================================
 */

/**
 * The panel's request kinds, each paired with its request and response payload
 * in one entry — so a request kind can never exist without its response, or
 * the other way round.
 *
 * Every payload is a wire type imported from the protocol or the panel schema,
 * or is built only from their identifiers; nothing here restates a wire shape.
 *
 * - `panelData.query` — resolve a node's `DataQuery` for a session; the worker
 *   proxies the protocol's panel-data route and answers with the wire
 *   `DataResult`, paging echo included. `../panel/data-provider.ts` adapts it
 *   for `@debuggen/panel-renderer`.
 * - `source.open` — a `SourceLink` click, forwarded as the protocol's
 *   `source.open` frame; `forwarded` says whether the socket took it.
 * - `capture.start` / `capture.stop` — the panel's capture controls; the worker
 *   calls the protocol's two capture routes and answers with their bodies.
 * - `target.pick` — the panel entering (`enabled: true`) or leaving element
 *   picker mode.
 * - `target.selected` — the element the developer picked, forwarded as the
 *   protocol's `target.selected` frame.
 * - `pair.complete` — the one-time code typed into `PairDialog`. The worker
 *   redeems it and keeps the returned credential in `chrome.storage.local`;
 *   the credential never travels back to the panel, so success is only
 *   `{ paired: true }` and failure is the `ok: false` branch.
 * - `session.snapshot` — what a freshly (re)opened panel asks for. A Manifest
 *   V3 worker suspends after about 30 seconds idle (AAP §0.1.1), so the panel
 *   must be able to rebuild its whole view from one answer.
 */
export interface PortRpcContract {
  readonly 'panelData.query': {
    readonly request: { readonly sessionId: SessionId; readonly query: DataQuery };
    readonly response: DataResult;
  };
  readonly 'source.open': {
    readonly request: MessagePayload<'source.open'>;
    readonly response: { readonly forwarded: boolean };
  };
  readonly 'capture.start': {
    readonly request: { readonly sessionId: SessionId };
    readonly response: CaptureStartResponse;
  };
  readonly 'capture.stop': {
    readonly request: { readonly sessionId: SessionId };
    readonly response: CaptureStopResponse;
  };
  readonly 'target.pick': {
    readonly request: { readonly sessionId: SessionId; readonly enabled: boolean };
    readonly response: { readonly active: boolean };
  };
  readonly 'target.selected': {
    readonly request: MessagePayload<'target.selected'>;
    readonly response: { readonly accepted: boolean };
  };
  readonly 'pair.complete': {
    readonly request: PairCompleteRequest;
    readonly response: { readonly paired: true };
  };
  readonly 'session.snapshot': {
    readonly request: { readonly sessionId?: SessionId | undefined };
    readonly response: PanelSessionSnapshot;
  };
}

/**
 * Everything the panel needs to render from nothing: the answer to
 * `session.snapshot`.
 *
 * `session`, `panel` and `analysis` are absent when the tab is not bound, or
 * the bound session has not produced them yet; `connection` and `binding` are
 * always present, because the pill and the binding line always render.
 */
export interface PanelSessionSnapshot {
  /** The bound session's record, as the service last broadcast it. */
  readonly session?: SessionRecord | undefined;
  /** The session's current panel specification. */
  readonly panel?: PanelSpec | undefined;
  /** The session's latest validated analysis. */
  readonly analysis?: AnalysisResult | undefined;
  /** The connection pill's state. */
  readonly connection: PanelConnectionState;
  /** The inspected tab's binding. */
  readonly binding: PanelBindingState;
}

/**
 * Every request kind of {@link PortRpcContract}, iterable.
 *
 * `satisfies` rejects a name the contract does not define, and
 * {@link PortRequestKind}'s declaration fails to compile if the contract gains
 * a kind this tuple lacks.
 */
export const PORT_REQUEST_KINDS = [
  'panelData.query',
  'source.open',
  'capture.start',
  'capture.stop',
  'target.pick',
  'target.selected',
  'pair.complete',
  'session.snapshot',
] as const satisfies readonly (keyof PortRpcContract)[];

/** One of {@link PORT_REQUEST_KINDS}. */
export type PortRequestKind = TupleCovering<typeof PORT_REQUEST_KINDS, keyof PortRpcContract>;

/** The request payload of each kind, derived from {@link PortRpcContract}. */
export type PortRequestPayloads = {
  readonly [Kind in PortRequestKind]: PortRpcContract[Kind]['request'];
};

/** The success payload of each kind, derived from {@link PortRpcContract}. */
export type PortResponsePayloads = {
  readonly [Kind in PortRequestKind]: PortRpcContract[Kind]['response'];
};

/** One request frame of a given kind. */
export interface PortRequestFrame<Kind extends PortRequestKind> extends PortFrameBase<'request'> {
  /** Minted by {@link newPortRequestId}; echoed by the response. */
  readonly requestId: PortRequestId;
  /** What is being asked. */
  readonly kind: Kind;
  /** The kind's request payload. */
  readonly payload: PortRequestPayloads[Kind];
}

/**
 * A panel → worker request. Without a type argument, the union of every kind's
 * frame — discriminated on `kind`, so a `switch` narrows `payload`.
 */
export type PortRequest<Kind extends PortRequestKind = PortRequestKind> =
  Kind extends PortRequestKind ? PortRequestFrame<Kind> : never;

/** A successful answer to a request of a given kind. */
export interface PortSuccessResponse<
  Kind extends PortRequestKind,
> extends PortFrameBase<'response'> {
  /** The request's id. */
  readonly requestId: PortRequestId;
  /** The request's kind. */
  readonly kind: Kind;
  /** Success. */
  readonly ok: true;
  /** The kind's response payload. */
  readonly payload: PortResponsePayloads[Kind];
}

/**
 * A failed answer to a request of a given kind.
 *
 * `error` is the protocol's `ErrorPayload`, so every failure speaks the closed
 * `DEBUGGEN_ERROR_CODES` vocabulary the rest of the product does — a refused
 * pairing code, a capture already held by another session, a service that did
 * not answer.
 */
export interface PortFailureResponse<
  Kind extends PortRequestKind,
> extends PortFrameBase<'response'> {
  /** The request's id. */
  readonly requestId: PortRequestId;
  /** The request's kind. */
  readonly kind: Kind;
  /** Failure. */
  readonly ok: false;
  /** What went wrong, as the protocol's error payload. */
  readonly error: ErrorPayload;
}

/**
 * A worker → panel answer. Without a type argument, the union of every kind's
 * success and failure frames — discriminated on `kind` and then on `ok`.
 */
export type PortResponse<Kind extends PortRequestKind = PortRequestKind> =
  Kind extends PortRequestKind ? PortSuccessResponse<Kind> | PortFailureResponse<Kind> : never;

/**
 * The protocol frames the worker relays from the service socket to the panel.
 *
 * `satisfies readonly MessageType[]` is deliberate: a name that is not a real
 * protocol message type is a compile error here rather than a push that never
 * arrives. The set is what the panel renders — the session lifecycle and
 * progress, its binding, the capture window, the plan and its outcome, the
 * live tail, the analysis, the generated panel, cleanup, picker requests and
 * failures (AAP §0.4.2, §0.7.3).
 */
export const RELAYED_MESSAGE_TYPES = [
  'session.created',
  'session.updated',
  'session.progress',
  'session.bound',
  'capture.started',
  'capture.stopped',
  'instrumentation.plan',
  'instrumentation.ready',
  'instrumentation.failed',
  'telemetry.tail',
  'analysis.completed',
  'panel.generated',
  'cleanup.completed',
  'target.request',
  'error',
] as const satisfies readonly MessageType[];

/** One of {@link RELAYED_MESSAGE_TYPES}. */
export type RelayedMessageType = (typeof RELAYED_MESSAGE_TYPES)[number];

/**
 * Any relayed protocol envelope, as a union discriminated on `type`.
 *
 * Indexed out of the protocol's `ProtocolMessageMap` rather than written as
 * `MessageByType<RelayedMessageType>`, which would pair the union of types with
 * the union of payloads and lose the discrimination. Each member is assignable
 * to `ProtocolMessage`, so the panel narrows with the protocol's own
 * `isMessageOfType`.
 */
export type RelayedProtocolMessage = ProtocolMessageMap[RelayedMessageType];

/**
 * Whether a value is one of {@link RELAYED_MESSAGE_TYPES}.
 *
 * @param value A frame's `type`, or anything else.
 */
export function isRelayedMessageType(value: unknown): value is RelayedMessageType {
  return isMember(RELAYED_MESSAGE_TYPES, value);
}

/**
 * A relayed protocol frame.
 *
 * The **whole** envelope travels, not only its payload, so the panel can use
 * the protocol's `isMessageOfType`. The worker received it through
 * `ReconnectingWsClient`, which validated it with the protocol's schemas, so
 * the panel narrows rather than re-validates.
 */
export interface PortProtocolPush extends PortFrameBase<'push'> {
  /** A relayed protocol frame. */
  readonly kind: 'protocol';
  /** The validated envelope. */
  readonly message: RelayedProtocolMessage;
}

/** The connection pill changed. */
export interface PortConnectionPush extends PortFrameBase<'push'> {
  /** A connection-state change. */
  readonly kind: 'connection';
  /** The new state. */
  readonly state: PanelConnectionState;
}

/** The inspected tab's binding changed. */
export interface PortBindingPush extends PortFrameBase<'push'> {
  /** A binding-state change. */
  readonly kind: 'binding';
  /** The new state. */
  readonly state: PanelBindingState;
}

/** An unsolicited worker → panel frame, discriminated on `kind`. */
export type PortPush = PortProtocolPush | PortConnectionPush | PortBindingPush;

/** Every frame on {@link PORT_PANEL}, discriminated on `direction`. */
export type PanelPortMessage = PortRequest | PortResponse | PortPush;

/** The per-kind payload check behind {@link isPortRequest}. */
function hasPortRequestPayload(kind: PortRequestKind, payload: Record<string, unknown>): boolean {
  switch (kind) {
    case 'panelData.query': {
      const query = payload.query;
      return (
        isNonEmptyString(payload.sessionId) && isRecord(query) && typeof query.source === 'string'
      );
    }
    case 'source.open': {
      const location = payload.location;
      return (
        isNonEmptyString(payload.sessionId) && isRecord(location) && isNonEmptyString(location.file)
      );
    }
    case 'capture.start':
    case 'capture.stop':
      return isNonEmptyString(payload.sessionId);
    case 'target.pick':
      return isNonEmptyString(payload.sessionId) && typeof payload.enabled === 'boolean';
    case 'target.selected':
      return isNonEmptyString(payload.sessionId) && isSelectedTargetShape(payload.target);
    case 'pair.complete':
      return isNonEmptyString(payload.code);
    case 'session.snapshot':
      return isOptionalId(payload.sessionId);
  }
}

/**
 * Whether a value is a well-formed panel → worker request.
 *
 * Checks the framing, a non-empty `requestId`, a known `kind` and the kind's
 * identifying payload fields. The deep shapes inside — a `DataQuery`, a
 * `SourceLocation`, a `SelectedTarget` — are validated by the service when the
 * worker forwards them, against their single definitions.
 *
 * @param value A message received on {@link PORT_PANEL}.
 */
export function isPortRequest(value: unknown): value is PortRequest {
  if (!isPortFrame(value, 'request')) {
    return false;
  }
  const kind = value.kind;
  const payload = value.payload;
  return (
    isNonEmptyString(value.requestId) &&
    isMember(PORT_REQUEST_KINDS, kind) &&
    isRecord(payload) &&
    hasPortRequestPayload(kind, payload)
  );
}

/** Whether a value is a well-formed protocol `ErrorPayload` shape. */
function isErrorPayloadShape(value: unknown): value is ErrorPayload {
  return (
    isRecord(value) &&
    isNonEmptyString(value.code) &&
    isNonEmptyString(value.message) &&
    isOptionalId(value.ref)
  );
}

/**
 * Whether a value is a well-formed worker → panel response.
 *
 * Checks the framing, the echoed `requestId` and `kind`, and either an object
 * `payload` (`ok: true`) or an error payload (`ok: false`). The success
 * payloads were produced by the worker from service bodies the protocol's
 * `HttpClient` already validated.
 *
 * @param value A message received on {@link PORT_PANEL}.
 */
export function isPortResponse(value: unknown): value is PortResponse {
  if (!isPortFrame(value, 'response')) {
    return false;
  }
  if (!isNonEmptyString(value.requestId) || !isMember(PORT_REQUEST_KINDS, value.kind)) {
    return false;
  }
  if (value.ok === true) {
    return isRecord(value.payload);
  }
  return value.ok === false && isErrorPayloadShape(value.error);
}

/** Whether a value is shaped like a validated relayed protocol envelope. */
function isRelayedEnvelopeShape(value: unknown): value is RelayedProtocolMessage {
  return (
    isRecord(value) &&
    isRelayedMessageType(value.type) &&
    isNonEmptyString(value.id) &&
    typeof value.ts === 'number' &&
    Number.isFinite(value.ts) &&
    isOptionalId(value.sessionId) &&
    isRecord(value.payload)
  );
}

/**
 * Whether a value is a well-formed worker → panel push.
 *
 * @param value A message received on {@link PORT_PANEL}.
 */
export function isPortPush(value: unknown): value is PortPush {
  if (!isPortFrame(value, 'push')) {
    return false;
  }
  switch (value.kind) {
    case 'protocol':
      return isRelayedEnvelopeShape(value.message);
    case 'connection':
      return isPanelConnectionState(value.state);
    case 'binding':
      return isPanelBindingState(value.state);
    default:
      return false;
  }
}

/**
 * Whether a value is any well-formed frame of {@link PORT_PANEL}.
 *
 * @param value A message received on {@link PORT_PANEL}.
 */
export function isPanelPortMessage(value: unknown): value is PanelPortMessage {
  return isPortRequest(value) || isPortResponse(value) || isPortPush(value);
}

/**
 * Narrow a validated panel-port frame to a request of one kind.
 *
 * @param message A frame that passed {@link isPanelPortMessage}.
 * @param kind The request kind to test for.
 */
export function isPortRequestOfKind<Kind extends PortRequestKind>(
  message: PanelPortMessage,
  kind: Kind,
): message is Extract<PortRequest, { readonly kind: Kind }> {
  return message.direction === 'request' && message.kind === kind;
}

/**
 * Narrow a validated panel-port frame to a response (success or failure) of
 * one kind — how the panel matches an answer to the request it sent.
 *
 * @param message A frame that passed {@link isPanelPortMessage}.
 * @param kind The request kind to test for.
 */
export function isPortResponseOfKind<Kind extends PortRequestKind>(
  message: PanelPortMessage,
  kind: Kind,
): message is Extract<PortResponse, { readonly kind: Kind }> {
  return message.direction === 'response' && message.kind === kind;
}

/*
 * ===========================================================================
 * Section G — the page ↔ bridge `window.postMessage` channel (MIRROR)
 *
 * Every literal in this section mirrors `packages/telemetry/src/browser/
 * transport.ts` — see the MIRROR CONTRACT in the module header. The frames are
 * raw: no protocol envelope crosses the page boundary.
 *
 * The guards below are what the bridge uses to validate and **drop anything
 * unrecognised**. They are structural and total — they never throw — but they
 * are only half of the bridge's check: the bridge must additionally require
 * `event.source === window` and the document's own origin on every `message`
 * event, which are runtime facts about the event rather than about the data,
 * and therefore the bridge's to test, not this module's. The page → bridge
 * direction is unauthenticated by design (any page script can post a frame
 * tagged as the agent's), which is why the worker validates every relayed
 * payload again against the protocol's schemas before it leaves the extension.
 * ===========================================================================
 */

/** The `source` tag on every frame the page agent posts. */
export const AGENT_SOURCE_TAG = 'debuggen-agent';

/** The `source` tag on every frame the bridge posts to the page. */
export const BRIDGE_SOURCE_TAG = 'debuggen-bridge';

/**
 * The page channel's version, carried on every frame in both directions and
 * compared exactly by both sides. Version 2 added the handshake `token` to
 * every bridge → page frame; a mismatched pair ignores each other until the
 * page reloads.
 */
export const PAGE_CHANNEL_VERSION = 2;

/**
 * The `targetOrigin` for every `window.postMessage` on the page channel: `'/'`,
 * meaning "this window's own origin" — correct even for an opaque origin, and
 * never `'*'`, which would broadcast telemetry to any listener a page installed.
 */
export const PAGE_MESSAGE_TARGET_ORIGIN = '/';

/**
 * The `CustomEvent` the bridge dispatches on `window`, once per document and
 * with no `detail`, to ask the agent for the document's handshake token. The
 * bridge must register its {@link PAGE_HANDSHAKE_OFFER_EVENT} listener first:
 * the answer is dispatched synchronously inside the request.
 */
export const PAGE_HANDSHAKE_REQUEST_EVENT = 'debuggen-bridge-handshake';

/**
 * The `CustomEvent` the agent dispatches on `window` to disclose the handshake
 * token, whose `detail` is the token as a bare string (see
 * {@link isPageHandshakeToken}). The bridge keeps it in its own closure for the
 * life of the document and puts it on the `token` field of every frame it
 * posts; only the first request is ever answered.
 */
export const PAGE_HANDSHAKE_OFFER_EVENT = 'debuggen-agent-handshake';

/** The length of a well-formed handshake token: 32 CSPRNG bytes as lowercase hex. */
export const PAGE_HANDSHAKE_TOKEN_LENGTH = 64;

/** Lowercase hexadecimal digits, and nothing else. */
const LOWERCASE_HEX_PATTERN = /^[0-9a-f]+$/;

/**
 * Whether a value has the shape of the agent's handshake token — how the bridge
 * vets an offer's `detail` before keeping it. Shape only: whether it is *the*
 * token is decided by the agent, which drops every frame that does not carry
 * the one it issued.
 *
 * @param value A `CustomEvent`'s `detail`, or a frame's `token`.
 */
export function isPageHandshakeToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === PAGE_HANDSHAKE_TOKEN_LENGTH &&
    LOWERCASE_HEX_PATTERN.test(value)
  );
}

/**
 * The largest page-channel frame, in the agent's own unit: the length of the
 * frame's JSON rendering in UTF-16 code units — 512 KiB, the agent's
 * `MAX_MESSAGE_BYTES`. Equal to the agent's cap and measured the same way, so
 * the bridge never refuses a frame the agent was willing to post.
 *
 * Batch *length* is not bounded here: the page agent sizes its own batches, and
 * the protocol's `telemetry.event` schema bounds the element count when the
 * worker validates the batch it wraps.
 */
export const MAX_PAGE_MESSAGE_BYTES = 512 * 1024;

/**
 * Measure a page-channel frame the way the agent does: the code-unit length of
 * its JSON rendering. Pure; never throws.
 *
 * "Bytes" follows the agent's own naming for the same measure — an estimate of
 * the transported size, not a UTF-8 byte count.
 *
 * @param value The whole frame (`source`, `version` and `type` included).
 * @returns The rendered length, or `Number.POSITIVE_INFINITY` when the value
 * cannot be rendered as JSON at all (a cycle, a `BigInt`, `undefined`).
 */
export function approximatePageMessageBytes(value: unknown): number {
  try {
    const rendered: string | undefined = JSON.stringify(value);
    return typeof rendered === 'string' ? rendered.length : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * The bridge's pre-relay size check: `true` when a frame measures over
 * {@link MAX_PAGE_MESSAGE_BYTES} or cannot be measured, in which case the bridge
 * drops it instead of relaying it.
 *
 * @param value The whole frame the bridge received.
 */
export function exceedsPageMessageByteCap(value: unknown): boolean {
  return approximatePageMessageBytes(value) > MAX_PAGE_MESSAGE_BYTES;
}

/**
 * The page agent's `agent.ready` payload.
 *
 * Derived from the protocol's `AgentReadyPayload` rather than written out: the
 * page cannot know its own tab, so the service worker adds `tabId` — from the
 * bridge port's `sender` — before sending the protocol frame.
 */
export type PageAgentReadyPayload = Omit<AgentReadyPayload, 'tabId'>;

/**
 * The page agent's `telemetry.batch` payload.
 *
 * `events` is typed through the protocol's `telemetry.event` payload, so it is
 * provably the array the worker puts into that envelope — the worker wraps
 * `{ events }` and nothing else, because a page-originated session or capture
 * must never attribute its own events (the service attributes by the tab's
 * binding). The other fields are the agent's delivery bookkeeping.
 */
export interface PageTelemetryBatchPayload {
  /** The completed events, as the protocol's ingress batch. */
  readonly events: MessagePayload<'telemetry.event'>['events'];
  /** The document's producer id, which every event also carries. */
  readonly producerId: ProducerId;
  /** The agent's per-document id, as in `agent.ready`. */
  readonly documentId: PageAgentReadyPayload['documentId'];
  /** The batch's sequence number within the capture, from 0. */
  readonly batchSeq: number;
  /** Events lost since the previous batch that reported a loss. */
  readonly droppedCount: number;
  /** The capture the agent was armed for, as context only. */
  readonly captureId?: CaptureId | undefined;
  /** The session the agent was armed for, as context only. */
  readonly sessionId?: SessionId | undefined;
}

/**
 * The page agent's `target.described` payload: the descriptor for an element
 * a relayed `target.request` asked about, or `null` when nothing describable
 * was focused. `requestId` echoes the request's.
 */
export interface PageTargetDescribedPayload {
  /** The descriptor — the protocol's `SelectedTarget` — or `null`. */
  readonly target: SelectedTarget | null;
  /** The request this answers, when the request carried an id. */
  readonly requestId?: PortRequestId | undefined;
}

/**
 * The page agent's `agent.error` payload: an open diagnostic record.
 *
 * The agent posts several shapes under this type — a producer failure
 * (`code`, `message`, `source`, `stage`, …), an unavailable or unreleased hook
 * family (`code`, `message`, …), a refused control frame (`reason`, `frame`,
 * `limitBytes`) and an unpostable event (`reason`, `eventId`, `kind`,
 * `limitBytes`). None carries captured application data. The three
 * common keys are typed; everything else is relayed as it came.
 */
export interface PageAgentErrorPayload {
  /** The agent's diagnostic code, when the frame has one. */
  readonly code?: string | undefined;
  /** The loss reason, on a refused frame or an unpostable event. */
  readonly reason?: string | undefined;
  /** A one-sentence description, when the frame has one. */
  readonly message?: string | undefined;
  /** Any further diagnostic fields, relayed unchanged. */
  readonly [field: string]: unknown;
}

/** Every agent → bridge frame type, mapped to its payload. */
export interface AgentChannelPayloads {
  readonly 'agent.ready': PageAgentReadyPayload;
  readonly 'telemetry.batch': PageTelemetryBatchPayload;
  readonly 'target.described': PageTargetDescribedPayload;
  readonly 'agent.error': PageAgentErrorPayload;
}

/** The frame types the page agent posts (page → bridge). */
export const AGENT_OUTBOUND_TYPES = [
  'agent.ready',
  'telemetry.batch',
  'target.described',
  'agent.error',
] as const satisfies readonly (keyof AgentChannelPayloads)[];

/** One of {@link AGENT_OUTBOUND_TYPES}. */
export type AgentOutboundType = TupleCovering<
  typeof AGENT_OUTBOUND_TYPES,
  keyof AgentChannelPayloads
>;

/** The empty payload of the bridge's `bridge.ready` and `bridge.gone` signals. */
export type PageSignalPayload = Readonly<Record<string, never>>;

/**
 * The bridge's `agent.snapshot` payload: a request for the component-tree
 * snapshot, with optional bounds the agent honours. Whether a snapshot is
 * taken at all is decided by the armed configuration's `componentTree` flag.
 */
export interface PageSnapshotRequestPayload {
  /** Correlates the snapshot request, when the worker assigned one. */
  readonly requestId?: PortRequestId | undefined;
  /** The most tree nodes to include. */
  readonly maxNodes?: number | undefined;
  /** The deepest tree level to walk. */
  readonly maxDepth?: number | undefined;
}

/**
 * The bridge's `target.request` payload: describe the focused element. The
 * agent echoes `requestId` on its `target.described` answer.
 */
export interface PageTargetRequestPayload {
  /** Correlates the answer with this request. */
  readonly requestId?: PortRequestId | undefined;
}

/** Every bridge → page frame type, mapped to its payload. */
export interface BridgeChannelPayloads {
  readonly 'bridge.ready': PageSignalPayload;
  readonly 'bridge.gone': PageSignalPayload;
  /**
   * The protocol's `agent.config` payload, unchanged. The all-false hook set
   * is the dormancy instruction (AAP §0.5.1).
   */
  readonly 'agent.config': AgentConfigPayload;
  readonly 'agent.snapshot': PageSnapshotRequestPayload;
  readonly 'target.request': PageTargetRequestPayload;
}

/**
 * The frame types the bridge posts to the page (bridge → page).
 *
 * `bridge.ready` is posted at `document_start` and again after every worker
 * reconnect; `bridge.gone` when the bridge's runtime port disconnects.
 */
export const BRIDGE_OUTBOUND_TYPES = [
  'bridge.ready',
  'bridge.gone',
  'agent.config',
  'agent.snapshot',
  'target.request',
] as const satisfies readonly (keyof BridgeChannelPayloads)[];

/** One of {@link BRIDGE_OUTBOUND_TYPES}. */
export type BridgeOutboundType = TupleCovering<
  typeof BRIDGE_OUTBOUND_TYPES,
  keyof BridgeChannelPayloads
>;

/** The four fields every page-channel frame carries. */
export interface PageChannelEnvelope<Source extends string, Type extends string, Payload> {
  /** {@link AGENT_SOURCE_TAG} or {@link BRIDGE_SOURCE_TAG}. */
  readonly source: Source;
  /** Always {@link PAGE_CHANNEL_VERSION}. */
  readonly version: typeof PAGE_CHANNEL_VERSION;
  /** Which frame this is. */
  readonly type: Type;
  /** The frame's body. */
  readonly payload: Payload;
}

/**
 * A frame the page agent posts. Without a type argument, the union of every
 * type's frame, discriminated on `type`.
 */
export type AgentChannelMessage<Type extends AgentOutboundType = AgentOutboundType> =
  Type extends AgentOutboundType
    ? PageChannelEnvelope<typeof AGENT_SOURCE_TAG, Type, AgentChannelPayloads[Type]>
    : never;

/**
 * A frame the bridge posts to the page. Every one carries the document's
 * handshake `token`, which the agent verifies before it acts on the frame.
 * Without a type argument, the union of every type's frame.
 */
export type BridgeChannelMessage<Type extends BridgeOutboundType = BridgeOutboundType> =
  Type extends BridgeOutboundType
    ? PageChannelEnvelope<typeof BRIDGE_SOURCE_TAG, Type, BridgeChannelPayloads[Type]> & {
        /** The document's handshake token, from {@link PAGE_HANDSHAKE_OFFER_EVENT}. */
        readonly token: string;
      }
    : never;

/** Any frame on the page channel, in either direction. */
export type PageChannelMessage = AgentChannelMessage | BridgeChannelMessage;

/** Tag and exact version: the framing both directions share. */
function isPageFrame(value: unknown, source: string): value is Record<string, unknown> {
  return isRecord(value) && value.source === source && value.version === PAGE_CHANNEL_VERSION;
}

/**
 * The per-type payload check for an agent frame — shared by the bridge's page
 * guard and the worker's bridge-port guard, so both hops accept exactly the
 * same payloads.
 */
function hasAgentChannelPayload(
  type: AgentOutboundType,
  payload: Record<string, unknown>,
): boolean {
  switch (type) {
    case 'agent.ready':
      return (
        isNonEmptyString(payload.documentId) &&
        isNonEmptyString(payload.producerId) &&
        isNonEmptyString(payload.url) &&
        typeof payload.installedBeforeReact === 'boolean' &&
        typeof payload.reactDetected === 'boolean'
      );
    case 'telemetry.batch': {
      const events = payload.events;
      return (
        Array.isArray(events) &&
        events.every(isRecord) &&
        isNonEmptyString(payload.producerId) &&
        isNonEmptyString(payload.documentId) &&
        isCount(payload.batchSeq) &&
        isCount(payload.droppedCount) &&
        isOptionalId(payload.captureId) &&
        isOptionalId(payload.sessionId)
      );
    }
    case 'target.described':
      return isNullableSelectedTargetShape(payload.target) && isOptionalId(payload.requestId);
    case 'agent.error':
      return (
        isOptionalString(payload.code) &&
        isOptionalString(payload.reason) &&
        isOptionalString(payload.message)
      );
  }
}

/** The structural check for the protocol's `agent.config` payload. */
function hasAgentConfigPayload(payload: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(payload.sessionId) &&
    isNonEmptyString(payload.captureId) &&
    isBooleanRecord(payload.hooks)
  );
}

/** The structural check for an `agent.snapshot` payload. */
function hasSnapshotRequestPayload(payload: Record<string, unknown>): boolean {
  return (
    isOptionalId(payload.requestId) &&
    isOptionalPositiveInteger(payload.maxNodes) &&
    isOptionalPositiveInteger(payload.maxDepth)
  );
}

/** The per-type payload check for a bridge → page frame. */
function hasBridgeChannelPayload(
  type: BridgeOutboundType,
  payload: Record<string, unknown>,
): boolean {
  switch (type) {
    case 'bridge.ready':
    case 'bridge.gone':
      return isEmptyRecord(payload);
    case 'agent.config':
      return hasAgentConfigPayload(payload);
    case 'agent.snapshot':
      return hasSnapshotRequestPayload(payload);
    case 'target.request':
      return isOptionalId(payload.requestId);
  }
}

/**
 * Whether a value is a well-formed frame from the page agent: the agent's tag,
 * the exact channel version, a known type and that type's payload fields.
 * Element-level event validation is the protocol's, applied by the worker.
 *
 * @param value A `MessageEvent`'s `data`.
 */
export function isAgentChannelMessage(value: unknown): value is AgentChannelMessage {
  if (!isPageFrame(value, AGENT_SOURCE_TAG)) {
    return false;
  }
  const type = value.type;
  const payload = value.payload;
  return (
    isMember(AGENT_OUTBOUND_TYPES, type) &&
    isRecord(payload) &&
    hasAgentChannelPayload(type, payload)
  );
}

/**
 * Whether a value is a well-formed frame from the bridge: the bridge's tag, the
 * exact channel version, a well-formed handshake token, a known type and that
 * type's payload fields. The bridge uses it to recognise — and ignore — its own
 * frames echoed back to its `message` listener; tests use it to check what the
 * bridge builds.
 *
 * @param value A `MessageEvent`'s `data`, or a frame the bridge built.
 */
export function isBridgeChannelMessage(value: unknown): value is BridgeChannelMessage {
  if (!isPageFrame(value, BRIDGE_SOURCE_TAG) || !isPageHandshakeToken(value.token)) {
    return false;
  }
  const type = value.type;
  const payload = value.payload;
  return (
    isMember(BRIDGE_OUTBOUND_TYPES, type) &&
    isRecord(payload) &&
    hasBridgeChannelPayload(type, payload)
  );
}

/**
 * Whether a value is a well-formed page-channel frame in either direction.
 *
 * @param value A `MessageEvent`'s `data`.
 */
export function isPageChannelMessage(value: unknown): value is PageChannelMessage {
  return isAgentChannelMessage(value) || isBridgeChannelMessage(value);
}

/**
 * Whether a value is a well-formed agent frame of one type.
 *
 * @param value A `MessageEvent`'s `data`.
 * @param type The frame type to test for.
 */
export function isAgentChannelMessageOfType<Type extends AgentOutboundType>(
  value: unknown,
  type: Type,
): value is AgentChannelMessage<Type> {
  return isAgentChannelMessage(value) && value.type === type;
}

/**
 * Whether a value is a well-formed bridge frame of one type.
 *
 * @param value A `MessageEvent`'s `data`, or a frame the bridge built.
 * @param type The frame type to test for.
 */
export function isBridgeChannelMessageOfType<Type extends BridgeOutboundType>(
  value: unknown,
  type: Type,
): value is BridgeChannelMessage<Type> {
  return isBridgeChannelMessage(value) && value.type === type;
}

/*
 * ===========================================================================
 * Section H — the bridge ↔ worker port (`PORT_CONTENT_BRIDGE`)
 *
 * The bridge is a validating pass-through: an agent frame that passed
 * {@link isAgentChannelMessage} and {@link exceedsPageMessageByteCap} travels
 * upstream with the same `type` and the same payload, and a downstream frame's
 * payload is posted to the page as it came, with the token added. The worker
 * identifies the tab and document from the port's `sender`.
 * ===========================================================================
 */

/** The upstream (bridge → worker) payloads: the agent's, unchanged. */
export type BridgeUpstreamPayloads = AgentChannelPayloads;

/** The upstream frame types: the agent's page-channel types, verbatim. */
export const BRIDGE_UPSTREAM_MESSAGE_TYPES = AGENT_OUTBOUND_TYPES;

/** One bridge → worker frame of a given type. */
export interface BridgeUpstreamFrame<
  Type extends AgentOutboundType,
> extends PortFrameBase<'upstream'> {
  /** The agent frame's type. */
  readonly type: Type;
  /** The agent frame's payload. */
  readonly payload: BridgeUpstreamPayloads[Type];
}

/**
 * A bridge → worker frame. Without a type argument, the union of every type's
 * frame, discriminated on `type`.
 */
export type BridgeUpstreamMessage<Type extends AgentOutboundType = AgentOutboundType> =
  Type extends AgentOutboundType ? BridgeUpstreamFrame<Type> : never;

/**
 * The downstream (worker → bridge) payloads.
 *
 * Declared as an extension of the page channel's payloads so that the compiler
 * proves each one can be posted to the page unchanged. `target.request` narrows
 * its `requestId` to required: the worker always correlates its requests.
 */
export interface BridgeDownstreamPayloads extends Pick<
  BridgeChannelPayloads,
  'agent.config' | 'agent.snapshot' | 'target.request'
> {
  readonly 'target.request': { readonly requestId: PortRequestId };
}

/** The frame types the worker sends the bridge. */
export const BRIDGE_DOWNSTREAM_MESSAGE_TYPES = [
  'agent.config',
  'agent.snapshot',
  'target.request',
] as const satisfies readonly (keyof BridgeDownstreamPayloads)[];

/** One of {@link BRIDGE_DOWNSTREAM_MESSAGE_TYPES}. */
export type BridgeDownstreamType = TupleCovering<
  typeof BRIDGE_DOWNSTREAM_MESSAGE_TYPES,
  keyof BridgeDownstreamPayloads
>;

/** One worker → bridge frame of a given type. */
export interface BridgeDownstreamFrame<
  Type extends BridgeDownstreamType,
> extends PortFrameBase<'downstream'> {
  /** The page-channel type the bridge posts it as. */
  readonly type: Type;
  /** The payload the bridge posts to the page. */
  readonly payload: BridgeDownstreamPayloads[Type];
}

/**
 * A worker → bridge frame. Without a type argument, the union of every type's
 * frame, discriminated on `type`.
 */
export type BridgeDownstreamMessage<Type extends BridgeDownstreamType = BridgeDownstreamType> =
  Type extends BridgeDownstreamType ? BridgeDownstreamFrame<Type> : never;

/** Every frame on {@link PORT_CONTENT_BRIDGE}. */
export type BridgePortMessage = BridgeUpstreamMessage | BridgeDownstreamMessage;

/**
 * Whether a value is a well-formed bridge → worker frame. Applies the same
 * per-type payload check as {@link isAgentChannelMessage}, because the data is
 * page-originated.
 *
 * @param value A message received on {@link PORT_CONTENT_BRIDGE}.
 */
export function isBridgeUpstreamMessage(value: unknown): value is BridgeUpstreamMessage {
  if (!isPortFrame(value, 'upstream')) {
    return false;
  }
  const type = value.type;
  const payload = value.payload;
  return (
    isMember(BRIDGE_UPSTREAM_MESSAGE_TYPES, type) &&
    isRecord(payload) &&
    hasAgentChannelPayload(type, payload)
  );
}

/** The per-type payload check for a worker → bridge frame. */
function hasBridgeDownstreamPayload(
  type: BridgeDownstreamType,
  payload: Record<string, unknown>,
): boolean {
  switch (type) {
    case 'agent.config':
      return hasAgentConfigPayload(payload);
    case 'agent.snapshot':
      return hasSnapshotRequestPayload(payload);
    case 'target.request':
      return isNonEmptyString(payload.requestId);
  }
}

/**
 * Whether a value is a well-formed worker → bridge frame.
 *
 * @param value A message received on {@link PORT_CONTENT_BRIDGE}.
 */
export function isBridgeDownstreamMessage(value: unknown): value is BridgeDownstreamMessage {
  if (!isPortFrame(value, 'downstream')) {
    return false;
  }
  const type = value.type;
  const payload = value.payload;
  return (
    isMember(BRIDGE_DOWNSTREAM_MESSAGE_TYPES, type) &&
    isRecord(payload) &&
    hasBridgeDownstreamPayload(type, payload)
  );
}

/*
 * ===========================================================================
 * Section I — the devtools page ↔ worker port (`PORT_DEVTOOLS`)
 * ===========================================================================
 */

/** The upstream (devtools page → worker) payloads. */
export interface DevtoolsUpstreamPayloads {
  /**
   * Sent when the port opens: the inspected tab, from
   * `chrome.devtools.inspectedWindow.tabId`, and its document URL and origin
   * when an `inspectedWindow.eval` has read them. The port's later
   * `onDisconnect` is the "DevTools closed" signal behind `session.unbind`.
   */
  readonly 'devtools.hello': {
    readonly tabId: TabId;
    readonly url?: string | undefined;
    readonly origin?: string | undefined;
  };
  /**
   * The Elements panel's `$0` selection, described through the agent's
   * `describeTarget` via `inspectedWindow.eval` — sent on
   * `panels.elements.onSelectionChanged` and in answer to
   * `devtools.describeRequest` (echoing its `requestId`). `target` is `null`
   * when the selection could not be described.
   */
  readonly 'devtools.element': {
    readonly tabId: TabId;
    readonly target: SelectedTarget | null;
    readonly requestId?: PortRequestId | undefined;
  };
}

/** The frame types the devtools page sends the worker. */
export const DEVTOOLS_UPSTREAM_MESSAGE_TYPES = [
  'devtools.hello',
  'devtools.element',
] as const satisfies readonly (keyof DevtoolsUpstreamPayloads)[];

/** One of {@link DEVTOOLS_UPSTREAM_MESSAGE_TYPES}. */
export type DevtoolsUpstreamType = TupleCovering<
  typeof DEVTOOLS_UPSTREAM_MESSAGE_TYPES,
  keyof DevtoolsUpstreamPayloads
>;

/** The downstream (worker → devtools page) payloads. */
export interface DevtoolsDownstreamPayloads {
  /** Ask the devtools page to describe the current `$0` selection now. */
  readonly 'devtools.describeRequest': { readonly requestId: PortRequestId };
  /** The protocol's `target.request`, relayed: the service wants a target picked. */
  readonly 'target.request': MessagePayload<'target.request'>;
}

/** The frame types the worker sends the devtools page. */
export const DEVTOOLS_DOWNSTREAM_MESSAGE_TYPES = [
  'devtools.describeRequest',
  'target.request',
] as const satisfies readonly (keyof DevtoolsDownstreamPayloads)[];

/** One of {@link DEVTOOLS_DOWNSTREAM_MESSAGE_TYPES}. */
export type DevtoolsDownstreamType = TupleCovering<
  typeof DEVTOOLS_DOWNSTREAM_MESSAGE_TYPES,
  keyof DevtoolsDownstreamPayloads
>;

/** One devtools page → worker frame of a given type. */
export interface DevtoolsUpstreamFrame<
  Type extends DevtoolsUpstreamType,
> extends PortFrameBase<'upstream'> {
  /** Which frame this is. */
  readonly type: Type;
  /** The type's payload. */
  readonly payload: DevtoolsUpstreamPayloads[Type];
}

/** One worker → devtools page frame of a given type. */
export interface DevtoolsDownstreamFrame<
  Type extends DevtoolsDownstreamType,
> extends PortFrameBase<'downstream'> {
  /** Which frame this is. */
  readonly type: Type;
  /** The type's payload. */
  readonly payload: DevtoolsDownstreamPayloads[Type];
}

/**
 * A devtools page → worker frame. Without a type argument, the union of every
 * type's frame, discriminated on `type`.
 */
export type DevtoolsUpstreamMessage<Type extends DevtoolsUpstreamType = DevtoolsUpstreamType> =
  Type extends DevtoolsUpstreamType ? DevtoolsUpstreamFrame<Type> : never;

/**
 * A worker → devtools page frame. Without a type argument, the union of every
 * type's frame, discriminated on `type`.
 */
export type DevtoolsDownstreamMessage<
  Type extends DevtoolsDownstreamType = DevtoolsDownstreamType,
> = Type extends DevtoolsDownstreamType ? DevtoolsDownstreamFrame<Type> : never;

/** Every frame on {@link PORT_DEVTOOLS}. */
export type DevtoolsPortMessage = DevtoolsUpstreamMessage | DevtoolsDownstreamMessage;

/** The per-type payload check for a devtools page → worker frame. */
function hasDevtoolsUpstreamPayload(
  type: DevtoolsUpstreamType,
  payload: Record<string, unknown>,
): boolean {
  switch (type) {
    case 'devtools.hello':
      return (
        isTabId(payload.tabId) && isOptionalString(payload.url) && isOptionalString(payload.origin)
      );
    case 'devtools.element':
      return (
        isTabId(payload.tabId) &&
        isNullableSelectedTargetShape(payload.target) &&
        isOptionalId(payload.requestId)
      );
  }
}

/**
 * Whether a value is a well-formed devtools page → worker frame.
 *
 * @param value A message received on {@link PORT_DEVTOOLS}.
 */
export function isDevtoolsUpstreamMessage(value: unknown): value is DevtoolsUpstreamMessage {
  if (!isPortFrame(value, 'upstream')) {
    return false;
  }
  const type = value.type;
  const payload = value.payload;
  return (
    isMember(DEVTOOLS_UPSTREAM_MESSAGE_TYPES, type) &&
    isRecord(payload) &&
    hasDevtoolsUpstreamPayload(type, payload)
  );
}

/** The per-type payload check for a worker → devtools page frame. */
function hasDevtoolsDownstreamPayload(
  type: DevtoolsDownstreamType,
  payload: Record<string, unknown>,
): boolean {
  switch (type) {
    case 'devtools.describeRequest':
      return isNonEmptyString(payload.requestId);
    case 'target.request':
      return isNonEmptyString(payload.sessionId);
  }
}

/**
 * Whether a value is a well-formed worker → devtools page frame.
 *
 * @param value A message received on {@link PORT_DEVTOOLS}.
 */
export function isDevtoolsDownstreamMessage(value: unknown): value is DevtoolsDownstreamMessage {
  if (!isPortFrame(value, 'downstream')) {
    return false;
  }
  const type = value.type;
  const payload = value.payload;
  return (
    isMember(DEVTOOLS_DOWNSTREAM_MESSAGE_TYPES, type) &&
    isRecord(payload) &&
    hasDevtoolsDownstreamPayload(type, payload)
  );
}
