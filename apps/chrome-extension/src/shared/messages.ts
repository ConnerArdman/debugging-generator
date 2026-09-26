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
 * and devtools ↔ worker frames, the page ↔ bridge frames of the private
 * per-document page channel, the connection-status vocabulary the panel's
 * status pill renders, the binding state it renders beside it, the single
 * default service base URL, and the one bounded parser both `$0` readers
 * apply to the descriptor the inspected page answers (Section J). It is a pure
 * declaration module — types, constants, type guards and a few pure helpers —
 * so it is importable by `apps/chrome-extension/test/**` under Vitest with no
 * browser and no extension environment.
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
 *    `AnalysisResult`, `PanelSpec`, `PanelDataRequest` (which embeds
 *    `@debuggen/panel-schema`'s `DataQuery`), `DataResult`,
 *    `SelectedTarget`, `AgentHookConfig`, `TelemetryEventIngress`,
 *    `CaptureSummary`, `BindingReason` and the error shape are imported from
 *    `@debuggen/protocol` and `@debuggen/shared` and
 *    used by reference; a variant is derived (`Omit`, `MessagePayload<…>`,
 *    indexed access), never retyped (AAP §0.2.5: "Any second definition of
 *    these shapes in an app is a defect").
 * 2. **Imports stay inside the workspace's runtime dependencies.** No
 *    `@debuggen/telemetry` (a devDependency kept only for build ordering), no
 *    `@debuggen/instrumentation`, no `@debuggen/shared/node`, no `zod`, no
 *    `ws`, no `node:*` builtin and nothing from `apps/demo-app`. Deep
 *    validation calls the **exported schemas** of `@debuggen/protocol` and
 *    `@debuggen/panel-schema` (see "Every panel-bound frame is parsed"
 *    below); this file never builds a schema of its own.
 * 3. **No side effect at import and no `chrome.*` access.** Every top-level
 *    statement is a declaration; the surfaces own their own extension APIs.
 * 4. **No secret material.** `token` appears only as a field name — the
 *    devtools credential lives at run time in `chrome.storage.local`
 *    (AAP §0.5.6). The page channel carries no secret at all: its privacy
 *    comes from the agent's detached channel node, which no page script can
 *    reach and which the bridge holds only in its own closure.
 * 5. **No demo knowledge and no route paths.** HTTP paths come from
 *    `@debuggen/protocol`'s `buildPath`/`HTTP_ROUTES`, the socket path from its
 *    `WS_PATH`/`resolveWsUrl`.
 *
 * ## Every panel-bound frame is parsed, not narrowed
 *
 * The panel's port is a trust boundary in the direction that matters most:
 * whatever the worker posts becomes session state, a rendered panel, or a
 * resolved request the developer acts on. A worker built against another copy
 * of this module, a worker bug, or a frame that was never validated upstream
 * (the worker builds some envelopes itself) must therefore be refused before
 * it reaches a reducer, not discovered inside one. So the panel does not trust
 * framing alone (CWE-20):
 *
 * - a relayed protocol frame is parsed with the protocol's own discriminated
 *   union (`parseMessage`) and must also be a relayed type — see
 *   {@link parsePortPush};
 * - every response is parsed with its kind's own schema — the protocol's
 *   wire schemas for wire bodies (`DataResult`, the capture responses, the
 *   session record, the analysis, the panel specification, the error payload)
 *   and an exact structural check for the few extension-internal answers —
 *   see {@link parsePortResponse};
 * - a frame that is recognisably a response or a push but fails its parse is
 *   classified as malformed by {@link classifyPanelPortFrame}, so the panel
 *   rejects the request it answers (instead of waiting for a timeout) or
 *   reports the push, and never forwards it.
 *
 * The parsers return the **parsed** value, never the input, so what the panel
 * keeps is exactly what the schema admitted. They are separate functions from
 * the page-channel guards, so the content-script bridge — which imports only
 * those — does not bundle the schemas.
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
 * | Mirror here                    | Owner in transport.ts             | Value                                   |
 * | ------------------------------ | --------------------------------- | --------------------------------------- |
 * | `AGENT_SOURCE_TAG`             | `AGENT_SOURCE_TAG`                | `'debuggen-agent'`                      |
 * | `BRIDGE_SOURCE_TAG`            | `BRIDGE_SOURCE_TAG`               | `'debuggen-bridge'`                     |
 * | `PAGE_CHANNEL_VERSION`         | `CHANNEL_VERSION`                 | `3`                                     |
 * | `PAGE_HANDSHAKE_REQUEST_EVENT` | `HANDSHAKE_REQUEST_EVENT`         | `'debuggen-bridge-handshake'`           |
 * | `PAGE_HANDSHAKE_OFFER_EVENT`   | `HANDSHAKE_OFFER_EVENT`           | `'debuggen-agent-handshake'`            |
 * | `PAGE_AGENT_FRAME_EVENT`       | `AGENT_FRAME_EVENT`               | `'debuggen-agent-frame'`                |
 * | `PAGE_BRIDGE_FRAME_EVENT`      | `BRIDGE_FRAME_EVENT`              | `'debuggen-bridge-frame'`               |
 * | `MAX_PAGE_FRAME_LENGTH`        | `MAX_MESSAGE_BYTES`               | `524_288` (512 Ki code units)           |
 * | `pageFrameLength`              | the agent's frame measure         | `detail.length` of the JSON string      |
 * | `AGENT_OUTBOUND_TYPES`         | `AgentOutboundType`               | four frame types                        |
 * | `BRIDGE_OUTBOUND_TYPES`        | `BridgeInboundType`               | five frame types                        |
 * | `AgentChannelPayloads`         | `postControl`/`buildBatchPayload` | payload field sets                      |
 * | `BridgeChannelPayloads`        | `agent.ts` inbound readers        | payload field sets                      |
 *
 * transport.ts is authoritative wherever an older description of the channel
 * differs, and this file follows it. At **version 3** the channel no longer
 * uses `window.postMessage` at all, because anything posted on the page's
 * window — a secret token included — is readable and replayable by every
 * script on the page:
 *
 * 1. **Handshake, once per document, at `document_start`.** The bridge adds a
 *    {@link PAGE_HANDSHAKE_OFFER_EVENT} listener on `window`, dispatches one
 *    {@link PAGE_HANDSHAKE_REQUEST_EVENT}, and removes the listener again. The
 *    agent answers synchronously inside that dispatch with a `MouseEvent`
 *    whose `relatedTarget` is a **detached** node it created — a reference
 *    that crosses the isolated-world boundary and that no page script can
 *    find in the document.
 * 2. **Frames travel only on that node**, as cancelable `CustomEvent`s whose
 *    `detail` is the JSON rendering of `{ source, version, type, payload }` —
 *    {@link PAGE_AGENT_FRAME_EVENT} upward, {@link PAGE_BRIDGE_FRAME_EVENT}
 *    downward. No frame carries a token, and nothing is posted on `window`.
 * 3. **Custody is acknowledged.** The bridge calls `preventDefault()` on an
 *    agent frame — so the agent's `dispatchEvent` returns `false` — only once
 *    the frame is posted on the worker port or refused for good; an
 *    unacknowledged frame stays in the agent's buffer and is sent again after
 *    the next `bridge.ready`.
 *
 * The size cap is **512 Ki code units**, measured as the `detail` string's
 * length — the agent's own measure, so a frame the agent sent can never be
 * refused here (a UTF-8 byte count would be larger for non-ASCII text and
 * would drop valid batches); `telemetry.batch` carries `producerId`,
 * `documentId`, `batchSeq` and `droppedCount` beside `events`;
 * `target.described` answers `target: null` when nothing is describable; and
 * `agent.error` is recognised only by the closed vocabulary of Section G′.
 * ---------------------------------------------------------------------------
 *
 * @module apps/chrome-extension/src/shared/messages
 */

import type {
  AgentConfigPayload,
  AgentReadyPayload,
  AnalysisResult,
  BindingReason,
  CaptureStartConflictResponse,
  CaptureStartResponse,
  CaptureStopResponse,
  ConnectionState,
  DataResult,
  ErrorPayload,
  MessagePayload,
  MessageType,
  PairCompleteRequest,
  PanelDataRequest,
  PanelSpec,
  ProtocolMessage,
  ProtocolMessageMap,
  SelectedTarget,
  SessionBindPayload,
  SessionRecord,
} from '@debuggen/protocol';
import {
  analysisResultSchema,
  BINDING_REASONS,
  CAPTURE_CONFLICT_ERROR_CODE,
  captureStartConflictResponseSchema,
  captureStartResponseSchema,
  captureStopResponseSchema,
  dataResultSchema,
  errorPayloadSchema,
  MESSAGE_TYPE,
  parseMessage,
  sessionRecordSchema,
} from '@debuggen/protocol';
import { panelSpecSchema } from '@debuggen/panel-schema';
import type { CaptureId, MessageId, ProducerId, SessionId } from '@debuggen/shared';
import { ID_PREFIXES, newMessageId } from '@debuggen/shared';

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
 * Whether a record's own keys are exactly `keys` — every one present and no
 * other. The strictness of the protocol's `z.strictObject` schemas, for the
 * few extension-internal answers that have no schema of their own: a key this
 * copy of the contract does not know is a version or code mistake worth
 * refusing, never data to carry along.
 */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * The `safeParse` member of a Zod schema, structurally — so this module can
 * call the protocol's and the panel schema's exported schemas without
 * importing `zod` itself (invariant 2).
 */
interface SafeParser<Output> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: Output } | { readonly success: false };
}

/**
 * Parse `value` with one of the imported schemas: the parsed output, or
 * `undefined` when the schema refuses it. Total; never throws.
 */
function parseWithSchema<Output>(schema: SafeParser<Output>, value: unknown): Output | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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

/**
 * Why reloading the inspected page would let the agent observe it — the two
 * causes the service's readiness gate reports as its `reload-page` remediation
 * (AAP §0.7.1 Group 2), as the worker observes them:
 *
 * - `agent-missing` — no page agent runs in the tab's current document: the
 *   page was loaded before the extension was enabled, and Chrome injects the
 *   manifest's `document_start` content scripts only into documents that load
 *   afterwards (AAP §0.7.1 Group 4, "a page loaded before the extension was
 *   installed"). The worker knows it by the absence of both an `agent.ready`
 *   and a content-script bridge for the tab.
 * - `hook-after-react` — the agent runs, but its `agent.ready` reported
 *   `installedBeforeReact: false`: React initialised before the hook existed,
 *   so this document's renders cannot be observed.
 */
export const PANEL_RELOAD_REASONS = ['agent-missing', 'hook-after-react'] as const;

/** One of {@link PANEL_RELOAD_REASONS}. */
export type PanelReloadReason = (typeof PANEL_RELOAD_REASONS)[number];

/**
 * Whether the panel offers the one-click reload of its inspected tab, as the
 * worker — which performs the reload and holds the agent's readiness — decides
 * it and pushes it:
 *
 * - `not-needed` — the tab is not bound, or its current document's agent is
 *   in place before React (or is still loading with its bridge attached);
 * - `offered` — a reload would help, for `reason`; the panel shows the
 *   {@link PAGE_RELOAD_ACTION_LABEL} action;
 * - `reloading` — the developer consented and the worker is waiting for the
 *   new document's `agent.ready`.
 *
 * The sentence asking the developer to reload is the service's readiness
 * progress row; this state only says whether the action that performs it is
 * available. Exhaustively narrowable on `kind`.
 */
export type PanelReloadState =
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'offered'; readonly reason: PanelReloadReason }
  | { readonly kind: 'reloading' };

/** The `not-needed` reload state, frozen: the state of every unbound tab. */
export const PANEL_RELOAD_NOT_NEEDED: PanelReloadState = Object.freeze({ kind: 'not-needed' });

/**
 * The accessible name and visible label of the panel's one-click reload
 * action. Declared here, beside the other panel vocabulary, because the
 * browser suite drives the developer's consent through the real control and
 * must find it by the same name the panel renders.
 */
export const PAGE_RELOAD_ACTION_LABEL = 'Reload page';

/**
 * Whether a value is a well-formed {@link PanelReloadState}.
 *
 * @param value A `reload` push's `state`, a snapshot's `reload`, or anything else.
 */
export function isPanelReloadState(value: unknown): value is PanelReloadState {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.kind) {
    case 'not-needed':
    case 'reloading':
      return hasExactKeys(value, ['kind']);
    case 'offered':
      return (
        hasExactKeys(value, ['kind', 'reason']) && isMember(PANEL_RELOAD_REASONS, value.reason)
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
 * - `panelData.query` — resolve a node's `DataQuery` for a session, as the
 *   protocol's `PanelDataRequest` body: the query plus, for a node of a
 *   rendered panel, that panel's `panelId`; the worker proxies the protocol's
 *   panel-data route and answers with the wire `DataResult`, paging echo
 *   included. `../panel/data-provider.ts` adapts it for
 *   `@debuggen/panel-renderer`.
 * - `source.open` — a `SourceLink` click, forwarded as the protocol's
 *   `source.open` frame and answered by the service's correlated
 *   `source.result`: `forwarded: true` when the editor opened the location,
 *   `forwarded: false` when no VS Code window is connected (the panel then
 *   falls back to the editor-open URI); a refusal, an editor failure and the
 *   worker's deadline are `ok: false` answers.
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
 *   must be able to rebuild its whole view from one answer. `inspectedTabId`
 *   is the panel document's own `chrome.devtools.inspectedWindow.tabId`, sent
 *   whenever the panel runs inside DevTools: the same trusted,
 *   extension-page-originated source as the DevTools page's `devtools.hello`
 *   (the worker accepts `PORT_PANEL` only from this extension's own pages), so
 *   the worker associates the port with exactly that tab. `sessionId` — the
 *   panel's memory of its last binding — is informational only and never
 *   chooses or assigns a tab.
 * - `page.reload` — the developer's one-click consent to reload the inspected
 *   page when its agent cannot observe it (AAP §0.7.1 Group 2: readiness "asks
 *   for a one-click reload, which the SW performs via `chrome.tabs.reload` on
 *   consent and waits for the next `agent.ready`"). The request **is** the
 *   consent, so only the panel's reload action sends it, and only while the
 *   worker's {@link PanelReloadState} says a reload is `offered`. The consent
 *   names the tab it was given for — the panel's own inspected tab, read from
 *   `chrome.devtools.inspectedWindow.tabId` — and the worker fails closed
 *   unless that tab is the requesting connection's associated tab **and** is
 *   bound to the named session at the moment of the reload, so a consent can
 *   never reload any other tab (a stale panel, a reconnect, a session rebound
 *   elsewhere). It answers once the new document's agent has reported, with
 *   that report's readiness ({@link PageReloadResult}). A refusal (no reload
 *   is offered, or the tab is out of scope), a tab that is gone and a new
 *   document that never reported within the worker's bounded wait are
 *   `ok: false` answers in the shared error vocabulary.
 */
export interface PortRpcContract {
  readonly 'panelData.query': {
    readonly request: { readonly sessionId: SessionId; readonly query: PanelDataRequest };
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
    readonly request: {
      readonly sessionId?: SessionId | undefined;
      /** The panel's `chrome.devtools.inspectedWindow.tabId`; absent outside DevTools. */
      readonly inspectedTabId?: TabId | undefined;
    };
    readonly response: PanelSessionSnapshot;
  };
  readonly 'page.reload': {
    readonly request: { readonly sessionId: SessionId; readonly tabId: TabId };
    readonly response: PageReloadResult;
  };
}

/**
 * The success answer to `page.reload`: the readiness the reloaded document's
 * agent reported in its `agent.ready`, picked from the page-channel payload
 * rather than restated. `installedBeforeReact: true` is what the service's
 * readiness gate needed; the session's own progress and status move on through
 * the relayed frames, so the panel reads this only to confirm the outcome.
 */
export type PageReloadResult = Readonly<
  Pick<PageAgentReadyPayload, 'documentId' | 'installedBeforeReact' | 'reactDetected'>
>;

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
  /**
   * Whether the one-click reload is offered for the inspected tab. Absent is
   * read as {@link PANEL_RELOAD_NOT_NEEDED}.
   */
  readonly reload?: PanelReloadState | undefined;
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
  'page.reload',
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
 * The error a failed answer carries: the protocol's `ErrorPayload`, or — for
 * the one failure whose detail the panel must act on — the protocol's
 * capture-conflict body, which is that payload **extended** with the
 * `owningSessionId` of the session that already holds the project's capture
 * (AAP §0.4.2: `capture.start` "answers `409 { owningSessionId }`").
 *
 * Both members are the protocol's own types, used by reference; nothing here
 * widens the error shape. The conflict member is the only detail that ever
 * crosses the port: the worker's `portErr` whitelists exactly that field, for
 * exactly the `CAPTURE_ALREADY_ACTIVE` code, and {@link parsePortResponse}
 * admits it only on a `capture.start` answer. Every other `details`, `cause`
 * and stack stays in the worker (AAP §0.5.2).
 */
export type PortErrorPayload = ErrorPayload | CaptureStartConflictResponse;

/**
 * The session a failed answer names as the holder of the project's capture,
 * or `undefined` when the failure is not a capture-ownership conflict.
 *
 * @param error A failure response's `error`.
 */
export function portErrorOwningSessionId(error: PortErrorPayload): SessionId | undefined {
  return 'owningSessionId' in error ? error.owningSessionId : undefined;
}

/**
 * A failed answer to a request of a given kind.
 *
 * `error` is the protocol's `ErrorPayload`, so every failure speaks the closed
 * `DEBUGGEN_ERROR_CODES` vocabulary the rest of the product does — a refused
 * pairing code, a capture already held by another session, a service that did
 * not answer — plus, for a capture conflict, the owning session
 * ({@link PortErrorPayload}).
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
  readonly error: PortErrorPayload;
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
  MESSAGE_TYPE.SESSION_CREATED,
  MESSAGE_TYPE.SESSION_UPDATED,
  MESSAGE_TYPE.SESSION_PROGRESS,
  MESSAGE_TYPE.SESSION_BOUND,
  MESSAGE_TYPE.CAPTURE_STARTED,
  MESSAGE_TYPE.CAPTURE_STOPPED,
  MESSAGE_TYPE.INSTRUMENTATION_PLAN,
  MESSAGE_TYPE.INSTRUMENTATION_READY,
  MESSAGE_TYPE.INSTRUMENTATION_FAILED,
  MESSAGE_TYPE.TELEMETRY_TAIL,
  MESSAGE_TYPE.ANALYSIS_COMPLETED,
  MESSAGE_TYPE.PANEL_GENERATED,
  MESSAGE_TYPE.CLEANUP_COMPLETED,
  MESSAGE_TYPE.TARGET_REQUEST,
  MESSAGE_TYPE.ERROR,
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
 * the protocol's `isMessageOfType`. Most relayed frames reached the worker
 * through `ReconnectingWsClient`, which validated them, but the worker also
 * builds some itself; the panel therefore parses every one again with the
 * protocol's union ({@link parsePortPush}) before it touches the store.
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

/** Whether the one-click reload is offered for the panel's inspected tab changed. */
export interface PortReloadPush extends PortFrameBase<'push'> {
  /** A reload-offer change. */
  readonly kind: 'reload';
  /** The new state. */
  readonly state: PanelReloadState;
}

/** An unsolicited worker → panel frame, discriminated on `kind`. */
export type PortPush = PortProtocolPush | PortConnectionPush | PortBindingPush | PortReloadPush;

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
      return (
        isOptionalId(payload.sessionId) &&
        (payload.inspectedTabId === undefined || isTabId(payload.inspectedTabId))
      );
    case 'page.reload':
      return (
        hasExactKeys(payload, ['sessionId', 'tabId']) &&
        isNonEmptyString(payload.sessionId) &&
        isTabId(payload.tabId)
      );
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

/*
 * ---------------------------------------------------------------------------
 * The worker → panel parsers
 *
 * Every function below answers the *parsed* value — rebuilt from the fields
 * its check admitted, or the output of an imported schema — or `undefined`.
 * None throws, none casts, and none hands back the untrusted input object.
 * ---------------------------------------------------------------------------
 */

/**
 * A failure's error: the protocol's capture-conflict body on a `capture.start`
 * answer whose code is the conflict code, otherwise the protocol's strict
 * `ErrorPayload` — so a conflict detail can never ride on any other answer.
 */
function parsePortErrorPayload(
  kind: PortRequestKind,
  value: unknown,
): PortErrorPayload | undefined {
  if (kind === 'capture.start') {
    const conflict = parseWithSchema(captureStartConflictResponseSchema, value);
    if (conflict !== undefined && conflict.code === CAPTURE_CONFLICT_ERROR_CODE) {
      return conflict;
    }
  }
  return parseWithSchema(errorPayloadSchema, value);
}

/** A {@link PanelConnectionState}, rebuilt from exactly its declared fields. */
function parsePanelConnectionState(value: unknown): PanelConnectionState | undefined {
  if (!isPanelConnectionState(value)) {
    return undefined;
  }
  return {
    status: value.status,
    ...(value.retryInMs === undefined ? {} : { retryInMs: value.retryInMs }),
    ...(value.serviceUrl === undefined ? {} : { serviceUrl: value.serviceUrl }),
  };
}

/** A {@link PanelBindingState}, rebuilt from exactly its kind's declared fields. */
function parsePanelBindingState(value: unknown): PanelBindingState | undefined {
  if (!isPanelBindingState(value)) {
    return undefined;
  }
  switch (value.kind) {
    case 'unbound':
      return { kind: 'unbound' };
    case 'bound':
      return { kind: 'bound', sessionId: value.sessionId, tabId: value.tabId, url: value.url };
    case 'tab-left':
      return {
        kind: 'tab-left',
        origin: value.origin,
        ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
        ...(value.reason === undefined ? {} : { reason: value.reason }),
      };
  }
}

/** A {@link PanelReloadState}, rebuilt from exactly its kind's declared fields. */
function parsePanelReloadState(value: unknown): PanelReloadState | undefined {
  if (!isPanelReloadState(value)) {
    return undefined;
  }
  return value.kind === 'offered'
    ? { kind: 'offered', reason: value.reason }
    : { kind: value.kind };
}

/** One of the three one-flag answers — `{ forwarded }`, `{ active }`, `{ accepted }` — read exactly. */
function readFlagAnswer(
  value: unknown,
  key: 'forwarded' | 'active' | 'accepted',
): boolean | undefined {
  if (!isRecord(value) || !hasExactKeys(value, [key])) {
    return undefined;
  }
  const flag = value[key];
  return typeof flag === 'boolean' ? flag : undefined;
}

/** The `page.reload` success answer, exactly. */
function parsePageReloadResult(value: unknown): PageReloadResult | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['documentId', 'installedBeforeReact', 'reactDetected'])
  ) {
    return undefined;
  }
  const { documentId, installedBeforeReact, reactDetected } = value;
  return isNonEmptyString(documentId) &&
    typeof installedBeforeReact === 'boolean' &&
    typeof reactDetected === 'boolean'
    ? { documentId, installedBeforeReact, reactDetected }
    : undefined;
}

/** The keys a {@link PanelSessionSnapshot} may carry; any other key is refused. */
const PANEL_SESSION_SNAPSHOT_KEYS = [
  'session',
  'panel',
  'analysis',
  'connection',
  'binding',
  'reload',
] as const satisfies readonly (keyof PanelSessionSnapshot)[];

/**
 * The `session.snapshot` answer: the pill and binding states rebuilt, and each
 * wire part — the session record, the panel specification, the analysis —
 * parsed with its single-definition schema. One refused part refuses the whole
 * answer, because a snapshot is applied as one consistent view.
 */
function parsePanelSessionSnapshot(value: unknown): PanelSessionSnapshot | undefined {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) => isMember(PANEL_SESSION_SNAPSHOT_KEYS, key))
  ) {
    return undefined;
  }
  const connection = parsePanelConnectionState(value.connection);
  const binding = parsePanelBindingState(value.binding);
  if (connection === undefined || binding === undefined) {
    return undefined;
  }
  const session =
    value.session === undefined ? undefined : parseWithSchema(sessionRecordSchema, value.session);
  const panel =
    value.panel === undefined ? undefined : parseWithSchema(panelSpecSchema, value.panel);
  const analysis =
    value.analysis === undefined
      ? undefined
      : parseWithSchema(analysisResultSchema, value.analysis);
  const reload = value.reload === undefined ? undefined : parsePanelReloadState(value.reload);
  if (
    (value.session !== undefined && session === undefined) ||
    (value.panel !== undefined && panel === undefined) ||
    (value.analysis !== undefined && analysis === undefined) ||
    (value.reload !== undefined && reload === undefined)
  ) {
    return undefined;
  }
  return {
    connection,
    binding,
    ...(session === undefined ? {} : { session }),
    ...(panel === undefined ? {} : { panel }),
    ...(analysis === undefined ? {} : { analysis }),
    ...(reload === undefined ? {} : { reload }),
  };
}

/** A success frame of one kind, built from a parsed payload. */
function successFrame<Kind extends PortRequestKind>(
  kind: Kind,
  requestId: PortRequestId,
  payload: PortResponsePayloads[Kind],
): PortSuccessResponse<Kind> {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'response',
    requestId,
    kind,
    ok: true,
    payload,
  };
}

/** A failure frame of one kind, built from a parsed error. */
function failureFrame<Kind extends PortRequestKind>(
  kind: Kind,
  requestId: PortRequestId,
  error: PortErrorPayload,
): PortFailureResponse<Kind> {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'response',
    requestId,
    kind,
    ok: false,
    error,
  };
}

/**
 * A success answer's payload parsed with its kind's own check: a protocol
 * wire schema where the payload is a wire body, the exact structural check
 * where it is an extension-internal answer.
 */
function parseSuccessResponse(
  kind: PortRequestKind,
  requestId: PortRequestId,
  payload: unknown,
): PortResponse | undefined {
  switch (kind) {
    case 'panelData.query': {
      const parsed = parseWithSchema(dataResultSchema, payload);
      return parsed === undefined ? undefined : successFrame(kind, requestId, parsed);
    }
    case 'source.open': {
      const forwarded = readFlagAnswer(payload, 'forwarded');
      return forwarded === undefined ? undefined : successFrame(kind, requestId, { forwarded });
    }
    case 'capture.start': {
      const parsed = parseWithSchema(captureStartResponseSchema, payload);
      return parsed === undefined ? undefined : successFrame(kind, requestId, parsed);
    }
    case 'capture.stop': {
      const parsed = parseWithSchema(captureStopResponseSchema, payload);
      return parsed === undefined ? undefined : successFrame(kind, requestId, parsed);
    }
    case 'target.pick': {
      const active = readFlagAnswer(payload, 'active');
      return active === undefined ? undefined : successFrame(kind, requestId, { active });
    }
    case 'target.selected': {
      const accepted = readFlagAnswer(payload, 'accepted');
      return accepted === undefined ? undefined : successFrame(kind, requestId, { accepted });
    }
    case 'pair.complete':
      // Exactly `{ paired: true }`: an empty or partial object is never read as
      // a completed pairing.
      return isRecord(payload) && hasExactKeys(payload, ['paired']) && payload.paired === true
        ? successFrame(kind, requestId, { paired: true })
        : undefined;
    case 'session.snapshot': {
      const parsed = parsePanelSessionSnapshot(payload);
      return parsed === undefined ? undefined : successFrame(kind, requestId, parsed);
    }
    case 'page.reload': {
      const parsed = parsePageReloadResult(payload);
      return parsed === undefined ? undefined : successFrame(kind, requestId, parsed);
    }
  }
}

/** The correlation of a worker → panel answer: which request it claims to answer. */
export interface PortResponseCorrelation {
  /** The echoed request id. */
  readonly requestId: PortRequestId;
  /** The echoed request kind. */
  readonly kind: PortRequestKind;
}

/**
 * The correlation of a response-direction frame on this channel — its echoed
 * `requestId` and a known `kind` — whether or not its payload is valid, so a
 * malformed answer can still settle the request it names. `undefined` for any
 * frame that is not a correlatable response.
 *
 * @param value A message received on {@link PORT_PANEL}.
 */
export function readPortResponseCorrelation(value: unknown): PortResponseCorrelation | undefined {
  if (!isPortFrame(value, 'response')) {
    return undefined;
  }
  const { requestId, kind } = value;
  return isNonEmptyString(requestId) && isMember(PORT_REQUEST_KINDS, kind)
    ? { requestId, kind }
    : undefined;
}

/**
 * Parse a worker → panel response: the framing, the echoed `requestId` and
 * `kind`, and then either the kind's success payload (`ok: true`, parsed by
 * its own schema) or its error (`ok: false`, the protocol's `ErrorPayload`, or
 * the capture-conflict body on a `capture.start` answer).
 *
 * @param value A message received on {@link PORT_PANEL}.
 * @returns The response rebuilt from what the checks admitted, or `undefined`
 * when any part is malformed.
 */
export function parsePortResponse(value: unknown): PortResponse | undefined {
  const correlation = readPortResponseCorrelation(value);
  if (correlation === undefined || !isRecord(value)) {
    return undefined;
  }
  const { requestId, kind } = correlation;
  if (value.ok === true) {
    return hasExactKeys(value, [
      'channel',
      'version',
      'direction',
      'requestId',
      'kind',
      'ok',
      'payload',
    ])
      ? parseSuccessResponse(kind, requestId, value.payload)
      : undefined;
  }
  if (
    value.ok !== false ||
    !hasExactKeys(value, ['channel', 'version', 'direction', 'requestId', 'kind', 'ok', 'error'])
  ) {
    return undefined;
  }
  const error = parsePortErrorPayload(kind, value.error);
  return error === undefined ? undefined : failureFrame(kind, requestId, error);
}

/**
 * Whether a value is a well-formed worker → panel response — the type-guard
 * form of {@link parsePortResponse}. A consumer that keeps the frame should
 * call the parser and keep its result instead.
 *
 * @param value A message received on {@link PORT_PANEL}.
 */
export function isPortResponse(value: unknown): value is PortResponse {
  return parsePortResponse(value) !== undefined;
}

/**
 * Whether a validated protocol frame is one of the relayed types, narrowing
 * the protocol union to {@link RelayedProtocolMessage} on its discriminant.
 */
function isRelayedProtocolMessage(message: ProtocolMessage): message is RelayedProtocolMessage {
  return isRelayedMessageType(message.type);
}

/**
 * A relayed protocol frame, parsed with the protocol's own discriminated union
 * (`parseMessage`: the envelope, and the payload schema its `type` selects)
 * and then required to be one of {@link RELAYED_MESSAGE_TYPES}.
 *
 * @param value A `protocol` push's `message`, or anything else.
 * @returns The parsed envelope, or `undefined`.
 */
export function parseRelayedMessage(value: unknown): RelayedProtocolMessage | undefined {
  const parsed = parseMessage(value);
  return parsed.ok && isRelayedProtocolMessage(parsed.value) ? parsed.value : undefined;
}

/** Every push kind of {@link PortPush}, iterable. */
export const PORT_PUSH_KINDS = [
  'protocol',
  'connection',
  'binding',
  'reload',
] as const satisfies readonly PortPush['kind'][];

/** One of {@link PORT_PUSH_KINDS}. */
export type PortPushKind = TupleCovering<typeof PORT_PUSH_KINDS, PortPush['kind']>;

/**
 * Parse a worker → panel push: the framing, a known push kind, exactly that
 * kind's keys, and its content — a relayed envelope through
 * {@link parseRelayedMessage}, a state through its rebuilder.
 *
 * @param value A message received on {@link PORT_PANEL}.
 * @returns The push rebuilt from what the checks admitted, or `undefined`.
 */
export function parsePortPush(value: unknown): PortPush | undefined {
  if (!isPortFrame(value, 'push')) {
    return undefined;
  }
  const base = {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'push',
  } as const;
  const kind = value.kind;
  if (kind === 'protocol') {
    const message = hasExactKeys(value, ['channel', 'version', 'direction', 'kind', 'message'])
      ? parseRelayedMessage(value.message)
      : undefined;
    return message === undefined ? undefined : { ...base, kind, message };
  }
  if (!hasExactKeys(value, ['channel', 'version', 'direction', 'kind', 'state'])) {
    return undefined;
  }
  switch (kind) {
    case 'connection': {
      const state = parsePanelConnectionState(value.state);
      return state === undefined ? undefined : { ...base, kind, state };
    }
    case 'binding': {
      const state = parsePanelBindingState(value.state);
      return state === undefined ? undefined : { ...base, kind, state };
    }
    case 'reload': {
      const state = parsePanelReloadState(value.state);
      return state === undefined ? undefined : { ...base, kind, state };
    }
    default:
      return undefined;
  }
}

/**
 * Whether a value is a well-formed worker → panel push — the type-guard form of
 * {@link parsePortPush}. A consumer that keeps the frame should call the
 * parser and keep its result instead.
 *
 * @param value A message received on {@link PORT_PANEL}.
 */
export function isPortPush(value: unknown): value is PortPush {
  return parsePortPush(value) !== undefined;
}

/**
 * What one frame arriving at the panel is, decided in one place:
 *
 * - `response` / `push` — well-formed, carrying the **parsed** frame to use;
 * - `malformed-response` — a response-direction frame on this channel whose
 *   content failed its parse; `correlation` names the request it claims to
 *   answer when that much is readable, so the panel can fail that request at
 *   once instead of waiting for its timeout;
 * - `malformed-push` — a push-direction frame on this channel that failed its
 *   parse; `pushKind` is its kind when it is a known one;
 * - `unrecognised` — anything else (another channel, another version, a
 *   request echoed back): not addressed to the panel, and dropped.
 */
export type PanelPortInbound =
  | { readonly kind: 'response'; readonly response: PortResponse }
  | { readonly kind: 'push'; readonly push: PortPush }
  | {
      readonly kind: 'malformed-response';
      readonly correlation: PortResponseCorrelation | undefined;
    }
  | { readonly kind: 'malformed-push'; readonly pushKind: PortPushKind | undefined }
  | { readonly kind: 'unrecognised' };

/**
 * Classify one frame received on {@link PORT_PANEL} — the panel's single
 * admission point: a frame reaches a reducer or settles a request only as the
 * parsed `response` or `push` this answers.
 *
 * @param value A message received on {@link PORT_PANEL}.
 */
export function classifyPanelPortFrame(value: unknown): PanelPortInbound {
  if (isPortFrame(value, 'response')) {
    const response = parsePortResponse(value);
    return response === undefined
      ? { kind: 'malformed-response', correlation: readPortResponseCorrelation(value) }
      : { kind: 'response', response };
  }
  if (isPortFrame(value, 'push')) {
    const push = parsePortPush(value);
    if (push !== undefined) {
      return { kind: 'push', push };
    }
    const pushKind = value.kind;
    return {
      kind: 'malformed-push',
      pushKind: isMember(PORT_PUSH_KINDS, pushKind) ? pushKind : undefined,
    };
  }
  return { kind: 'unrecognised' };
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
 * Section G — the page ↔ bridge channel: private, per document (MIRROR)
 *
 * Every literal in this section mirrors `packages/telemetry/src/browser/
 * transport.ts` — see the MIRROR CONTRACT in the module header. The frames are
 * raw: no protocol envelope crosses the page boundary.
 *
 * **Why the channel is a node, not the window.** The agent runs in the page's
 * own realm, so anything it or the bridge put on `window` — a `postMessage`,
 * an event, a token inside either — is visible to, and replayable by, every
 * script on the page. Version 3 therefore moves every frame onto a detached
 * node the agent creates at `document_start` and hands to the bridge exactly
 * once, inside the handshake dispatch, before any page script has run. The
 * node is never inserted into the document, so no page script can obtain a
 * reference to it, listen on it or dispatch on it.
 *
 * **What that does and does not prove.** A frame arriving on the node was
 * dispatched by code holding the node: the agent, or code that ran in the
 * page's realm *before* the agent and subverted it (another extension's
 * MAIN-world script, for example). It does not make the agent's *measurements*
 * trustworthy — the page shapes what the agent observes — which is why the
 * guards below still refuse anything outside the product's own vocabularies,
 * the bridge pins the document's identity from its first `agent.ready`, and
 * the worker and the service validate, bound and redact every payload again.
 *
 * The guards are structural and total — they never throw. Parsing a frame's
 * JSON `detail` and checking provenance are the bridge's
 * (`../content/bridge.ts` `shouldAcceptAgentFrame`); these guards judge the
 * parsed value.
 * ===========================================================================
 */

/** The `source` tag on every frame the page agent sends. */
export const AGENT_SOURCE_TAG = 'debuggen-agent';

/** The `source` tag on every frame the bridge sends to the page agent. */
export const BRIDGE_SOURCE_TAG = 'debuggen-bridge';

/**
 * The page channel's version, carried on every frame in both directions and
 * compared exactly by both sides. Version 3 replaced `window.postMessage` and
 * its handshake token with the private channel node described above; a
 * mismatched pair ignores each other until the page reloads.
 */
export const PAGE_CHANNEL_VERSION = 3;

/**
 * The `CustomEvent` the bridge dispatches on `window`, once per document and
 * with no `detail`, to ask the agent for its channel node. The bridge adds its
 * {@link PAGE_HANDSHAKE_OFFER_EVENT} listener immediately before the dispatch
 * and removes it immediately after: the agent answers synchronously inside
 * the request, and only the first request of a document is ever answered.
 */
export const PAGE_HANDSHAKE_REQUEST_EVENT = 'debuggen-bridge-handshake';

/**
 * The `MouseEvent` the agent dispatches on `window`, inside the bridge's
 * {@link PAGE_HANDSHAKE_REQUEST_EVENT}, whose `relatedTarget` is the channel
 * node. `relatedTarget` is used because a DOM node is one of the few values
 * that crosses from the MAIN world into the isolated world as a usable
 * reference (a `CustomEvent`'s object `detail` does not). The bridge keeps the
 * first node that is an event target and is not connected to the document,
 * for the life of the document.
 */
export const PAGE_HANDSHAKE_OFFER_EVENT = 'debuggen-agent-handshake';

/**
 * The cancelable `CustomEvent` the agent dispatches **on the channel node** for
 * every agent → bridge frame. Its `detail` is the JSON rendering of an
 * {@link AgentChannelMessage}. The bridge acknowledges custody by calling
 * `preventDefault()` — the agent's `dispatchEvent` then returns `false` — when
 * it has posted the frame on the worker port or refused it permanently; an
 * unacknowledged frame is still the agent's to keep and send again.
 */
export const PAGE_AGENT_FRAME_EVENT = 'debuggen-agent-frame';

/**
 * The cancelable `CustomEvent` the bridge dispatches **on the channel node**
 * for every bridge → agent frame. Its `detail` is the JSON rendering of a
 * {@link BridgeChannelMessage}; no frame carries a token.
 */
export const PAGE_BRIDGE_FRAME_EVENT = 'debuggen-bridge-frame';

/**
 * The longest page-channel frame, in the agent's own unit: the length of the
 * frame's JSON `detail` string in UTF-16 code units — 512 Ki, the agent's
 * `MAX_MESSAGE_BYTES`. Equal to the agent's cap and measured the same way, so
 * the bridge never refuses a frame the agent was willing to send.
 *
 * Batch *length* is not bounded here: the page agent sizes its own batches, and
 * the protocol's `telemetry.event` schema bounds the element count when the
 * worker validates the batch it wraps.
 */
export const MAX_PAGE_FRAME_LENGTH = 512 * 1024;

/**
 * Measure a page-channel frame the way the agent does: the code-unit length of
 * its `detail` string. Pure; never throws.
 *
 * @param detail A frame event's `detail`, exactly as dispatched.
 * @returns The string's length, or `Number.POSITIVE_INFINITY` for anything that
 * is not a string — a frame that is not a JSON string is never within the cap.
 */
export function pageFrameLength(detail: unknown): number {
  return typeof detail === 'string' ? detail.length : Number.POSITIVE_INFINITY;
}

/**
 * Whether a frame `detail` is over the cap or is not a string at all.
 *
 * @param detail A frame event's `detail`.
 * @param maxLength The cap; {@link MAX_PAGE_FRAME_LENGTH} unless a caller
 * (a test) needs a smaller one.
 */
export function exceedsPageFrameCap(
  detail: unknown,
  maxLength: number = MAX_PAGE_FRAME_LENGTH,
): boolean {
  return pageFrameLength(detail) > maxLength;
}

/**
 * Render a page-channel frame as the `detail` string it travels as.
 *
 * @example
 * ```ts
 * const detail = renderPageFrame({ source: BRIDGE_SOURCE_TAG, version: PAGE_CHANNEL_VERSION,
 *   type: 'bridge.ready', payload: {} });
 * if (detail !== undefined) node.dispatchEvent(new CustomEvent(PAGE_BRIDGE_FRAME_EVENT,
 *   { detail, cancelable: true }));
 * ```
 *
 * @param frame The whole frame (`source`, `version`, `type` and `payload`).
 * @param maxLength The cap; {@link MAX_PAGE_FRAME_LENGTH} by default.
 * @returns The JSON string, or `undefined` when the frame cannot be rendered
 * (a cycle, a `BigInt`) or its rendering is over the cap. Never throws.
 */
export function renderPageFrame(
  frame: PageChannelMessage,
  maxLength: number = MAX_PAGE_FRAME_LENGTH,
): string | undefined {
  try {
    const rendered: string | undefined = JSON.stringify(frame);
    return typeof rendered === 'string' && rendered.length <= maxLength ? rendered : undefined;
  } catch {
    return undefined;
  }
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
 * provably the array the worker puts into that envelope. A page-originated
 * session or capture must never attribute its own events (the service
 * attributes by the tab's binding), so the worker forwards only the events
 * plus two pieces of refusal-only delivery context: `captureId` as the
 * payload's `armedCaptureId`, which lets the service refuse a late batch of an
 * earlier capture but never choose one, and a positive `droppedCount`. The
 * other fields are the agent's delivery bookkeeping.
 */
export interface PageTelemetryBatchPayload {
  /**
   * The completed events, as the protocol's ingress batch. Empty only in a
   * loss-only report — posted by the agent's terminal flush or by the content
   * bridge when no later batch will carry a loss — whose `droppedCount` is
   * then above zero.
   */
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
 * The page agent's `agent.error` payload: a diagnostic record recognised by a
 * closed vocabulary.
 *
 * The agent posts several shapes under this type — a producer failure
 * (`code`, `message`, `source`, `stage`, …), an unavailable or unreleased hook
 * family (`code`, `message`, …), a refused control frame (`reason`, `frame`,
 * `limitBytes`) and an unpostable event (`reason`, `eventId`, `kind`,
 * `limitBytes`). A frame is accepted only when its `code` is one of
 * {@link PAGE_AGENT_ERROR_CODES} or, without a code, its `reason` is one of
 * {@link PAGE_AGENT_LOSS_REASONS} ({@link pageAgentErrorKind}); the other
 * fields are relayed as they came but are page-shaped, so no surface logs or
 * shows them — the developer reads {@link PAGE_AGENT_ERROR_PUBLIC_MESSAGES}.
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
 * The frame types the bridge sends the page agent (bridge → page), each as a
 * {@link PAGE_BRIDGE_FRAME_EVENT} on the channel node.
 *
 * `bridge.ready` is sent whenever a worker port opens — at `document_start`
 * and after every reconnect; `bridge.gone` when the port's disconnect is
 * reported, when the bridge stops and when the extension context is gone.
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
 * A frame the page agent sends, as the parsed `detail` of a
 * {@link PAGE_AGENT_FRAME_EVENT}. Without a type argument, the union of every
 * type's frame, discriminated on `type`.
 */
export type AgentChannelMessage<Type extends AgentOutboundType = AgentOutboundType> =
  Type extends AgentOutboundType
    ? PageChannelEnvelope<typeof AGENT_SOURCE_TAG, Type, AgentChannelPayloads[Type]>
    : never;

/**
 * A frame the bridge sends the page agent, as the parsed `detail` of a
 * {@link PAGE_BRIDGE_FRAME_EVENT}. It carries no token: the private channel
 * node is what keeps page scripts from reading or forging it. Without a type
 * argument, the union of every type's frame.
 */
export type BridgeChannelMessage<Type extends BridgeOutboundType = BridgeOutboundType> =
  Type extends BridgeOutboundType
    ? PageChannelEnvelope<typeof BRIDGE_SOURCE_TAG, Type, BridgeChannelPayloads[Type]>
    : never;

/** Any frame on the page channel, in either direction. */
export type PageChannelMessage = AgentChannelMessage | BridgeChannelMessage;

/** Tag and exact version: the framing both directions share. */
function isPageFrame(value: unknown, source: string): value is Record<string, unknown> {
  return isRecord(value) && value.source === source && value.version === PAGE_CHANNEL_VERSION;
}

/**
 * The per-type payload check for an agent frame — shared by the bridge's page
 * guard ({@link isAgentChannelMessage}) and the worker's bridge-port guard
 * ({@link isBridgeUpstreamMessage}), so both hops accept exactly the same
 * payloads.
 *
 * Every identifier must have the exact opaque-id shape of Section G′
 * ({@link isPageDocumentId}, {@link isPageProducerId}, {@link isPageCaptureId},
 * {@link isPageSessionId}), and an `agent.error` must be one the agent actually
 * emits ({@link pageAgentErrorKind}). A page script can shape any field it can
 * reach, so a value outside those vocabularies is not something the product
 * minted: the frame is refused here rather than relayed into a log line, a
 * readiness record or the panel (CWE-532, CWE-345).
 */
function hasAgentChannelPayload(
  type: AgentOutboundType,
  payload: Record<string, unknown>,
): boolean {
  switch (type) {
    case 'agent.ready':
      return (
        isPageDocumentId(payload.documentId) &&
        isPageProducerId(payload.producerId) &&
        isNonEmptyString(payload.url) &&
        typeof payload.installedBeforeReact === 'boolean' &&
        typeof payload.reactDetected === 'boolean'
      );
    case 'telemetry.batch': {
      const events = payload.events;
      return (
        Array.isArray(events) &&
        events.every(isRecord) &&
        isPageProducerId(payload.producerId) &&
        isPageDocumentId(payload.documentId) &&
        isCount(payload.batchSeq) &&
        isCount(payload.droppedCount) &&
        (payload.captureId === undefined || isPageCaptureId(payload.captureId)) &&
        (payload.sessionId === undefined || isPageSessionId(payload.sessionId))
      );
    }
    case 'target.described':
      return isNullableSelectedTargetShape(payload.target) && isOptionalId(payload.requestId);
    case 'agent.error':
      return (
        pageAgentErrorKind(payload) !== undefined &&
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
 * the exact channel version, a known type and that type's payload fields,
 * including the canonical identifier shapes and the closed `agent.error`
 * vocabulary of Section G′. Element-level event validation is the protocol's,
 * applied by the worker.
 *
 * @param value The parsed `detail` of a {@link PAGE_AGENT_FRAME_EVENT}.
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
 * exact channel version, a known type and that type's payload fields. Tests use
 * it to check what the bridge sends the agent.
 *
 * @param value The parsed `detail` of a {@link PAGE_BRIDGE_FRAME_EVENT}, or a
 * frame the bridge built.
 */
export function isBridgeChannelMessage(value: unknown): value is BridgeChannelMessage {
  if (!isPageFrame(value, BRIDGE_SOURCE_TAG)) {
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
 * @param value A parsed frame `detail`.
 */
export function isPageChannelMessage(value: unknown): value is PageChannelMessage {
  return isAgentChannelMessage(value) || isBridgeChannelMessage(value);
}

/**
 * Whether a value is a well-formed agent frame of one type.
 *
 * @param value The parsed `detail` of a {@link PAGE_AGENT_FRAME_EVENT}.
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
 * @param value The parsed `detail` of a {@link PAGE_BRIDGE_FRAME_EVENT}, or a
 * frame the bridge built.
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
 * Section G′ — what the extension may believe, log and show about page frames
 *
 * Everything the page agent sends is produced in the page's own realm, so a
 * page script can shape any of it. Three consequences are encoded here, once,
 * for every surface that handles an agent frame (CWE-532, AAP §0.5.2):
 *
 * 1. **Identifiers have one shape.** The agent mints its producer and document
 *    ids, and the service mints capture and session ids, as the repository's
 *    opaque id: a three-letter kind prefix, `_`, and sixteen characters of
 *    `[0-9a-z]` (`packages/shared/src/ids.ts`, `packages/telemetry/src/browser/
 *    ids.ts`). A value of any other shape was not minted by the product and is
 *    refused, not relayed.
 * 2. **Identifiers are fingerprinted before they are logged.** Even a
 *    well-formed page id is page-supplied, so a log line carries
 *    {@link fingerprintPageId}'s short digest — enough to tell two documents
 *    apart in one log, and nothing a page could use to write into it.
 * 3. **Diagnostics are a closed vocabulary with fixed copy.** An `agent.error`
 *    is recognised by its `code` or its loss `reason`, each from a closed list
 *    that mirrors what the agent actually emits; the words a developer reads
 *    come from {@link PAGE_AGENT_ERROR_PUBLIC_MESSAGES}, never from the frame.
 * ===========================================================================
 */

/** The random part of every opaque id: sixteen digits or lowercase letters. */
const OPAQUE_ID_BODY = '[0-9a-z]{16}';

/**
 * The kind prefix of the agent's per-document id. It has no counterpart in
 * `@debuggen/shared`'s `ID_PREFIXES` because a document id never becomes a
 * store key; it mirrors `DOCUMENT_ID_PREFIX` in
 * `packages/telemetry/src/browser/ids.ts`.
 */
const PAGE_DOCUMENT_ID_PREFIX = 'doc';

/** A well-formed page-agent document id (`doc_…`). */
export const PAGE_DOCUMENT_ID_PATTERN = new RegExp(
  `^${PAGE_DOCUMENT_ID_PREFIX}_${OPAQUE_ID_BODY}$`,
);

/** A well-formed page-agent producer id (`prd_…`). */
export const PAGE_PRODUCER_ID_PATTERN = new RegExp(`^${ID_PREFIXES.producer}_${OPAQUE_ID_BODY}$`);

/** A well-formed capture id (`cap_…`), as the service mints it. */
export const PAGE_CAPTURE_ID_PATTERN = new RegExp(`^${ID_PREFIXES.capture}_${OPAQUE_ID_BODY}$`);

/** A well-formed session id (`ses_…`), as the service mints it. */
export const PAGE_SESSION_ID_PATTERN = new RegExp(`^${ID_PREFIXES.session}_${OPAQUE_ID_BODY}$`);

/**
 * Whether a value has the exact shape of the agent's per-document id.
 *
 * @param value A payload's `documentId`.
 */
export function isPageDocumentId(value: unknown): value is PageAgentReadyPayload['documentId'] {
  return typeof value === 'string' && PAGE_DOCUMENT_ID_PATTERN.test(value);
}

/**
 * Whether a value has the exact shape of a producer id.
 *
 * @param value A payload's or an event's `producerId`.
 */
export function isPageProducerId(value: unknown): value is ProducerId {
  return typeof value === 'string' && PAGE_PRODUCER_ID_PATTERN.test(value);
}

/**
 * Whether a value has the exact shape of a capture id.
 *
 * @param value A payload's `captureId`.
 */
export function isPageCaptureId(value: unknown): value is CaptureId {
  return typeof value === 'string' && PAGE_CAPTURE_ID_PATTERN.test(value);
}

/**
 * Whether a value has the exact shape of a session id.
 *
 * @param value A payload's `sessionId`.
 */
export function isPageSessionId(value: unknown): value is SessionId {
  return typeof value === 'string' && PAGE_SESSION_ID_PATTERN.test(value);
}

/** What {@link fingerprintPageId} returns for a value that is not a string. */
export const PAGE_ID_FINGERPRINT_NONE = 'fp_none';

/** The FNV-1a 32-bit offset basis. */
const FNV1A_OFFSET_BASIS = 0x811c9dc5;

/** The FNV-1a 32-bit prime. */
const FNV1A_PRIME = 0x01000193;

/**
 * A short, log-safe digest of a page-supplied identifier: `fp_` and eight
 * lowercase hex digits of the value's FNV-1a 32-bit hash over its UTF-16 code
 * units, or {@link PAGE_ID_FINGERPRINT_NONE} for a non-string.
 *
 * This is a correlation aid, not a secret: it lets a developer see that two
 * log lines concern the same document without the log ever containing the
 * page's own bytes, and its fixed length means no page can grow a log line
 * through it. Pure, total and synchronous, so it can be called from any log
 * site in any surface.
 *
 * @example
 * ```ts
 * log.debug('agent.ready relayed.', { tabId, document: fingerprintPageId(payload.documentId) });
 * ```
 *
 * @param value A page-supplied identifier.
 */
export function fingerprintPageId(value: unknown): string {
  if (typeof value !== 'string') {
    return PAGE_ID_FINGERPRINT_NONE;
  }
  let hash = FNV1A_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }
  return `fp_${hash.toString(16).padStart(8, '0')}`;
}

/**
 * The `code` of every `agent.error` the page agent emits, mirroring its emit
 * sites: `hooks-unavailable` and `agent-family-unavailable` (a capture signal
 * or a support family that could not be armed), `hooks-not-released` (a hook
 * that could not be detached on disarm) and `producer-failure` (a producer
 * that threw; `packages/telemetry/src/browser/transport.ts`
 * `reportProducerFailure`).
 */
export const PAGE_AGENT_ERROR_CODES = [
  'hooks-unavailable',
  'agent-family-unavailable',
  'hooks-not-released',
  'producer-failure',
] as const;

/** One of {@link PAGE_AGENT_ERROR_CODES}. */
export type PageAgentErrorCode = (typeof PAGE_AGENT_ERROR_CODES)[number];

/**
 * The `reason` of every code-less `agent.error` — a frame or an event the
 * agent could not post — mirroring the agent transport's `CONTROL_LOSS_REASONS`
 * and its per-event loss reasons.
 */
export const PAGE_AGENT_LOSS_REASONS = [
  'event-unserializable',
  'event-too-large',
  'control-frame-too-large',
  'control-frame-unserializable',
  'control-frame-refused',
] as const;

/** One of {@link PAGE_AGENT_LOSS_REASONS}. */
export type PageAgentLossReason = (typeof PAGE_AGENT_LOSS_REASONS)[number];

/** A recognised `agent.error`: its code, or for a code-less frame its loss reason. */
export type PageAgentErrorKind = PageAgentErrorCode | PageAgentLossReason;

/**
 * Whether a value is one of {@link PAGE_AGENT_ERROR_CODES}.
 *
 * @param value A payload's `code`.
 */
export function isPageAgentErrorCode(value: unknown): value is PageAgentErrorCode {
  return isMember(PAGE_AGENT_ERROR_CODES, value);
}

/**
 * Whether a value is one of {@link PAGE_AGENT_LOSS_REASONS}.
 *
 * @param value A payload's `reason`.
 */
export function isPageAgentLossReason(value: unknown): value is PageAgentLossReason {
  return isMember(PAGE_AGENT_LOSS_REASONS, value);
}

/**
 * Classify an `agent.error` payload against the closed vocabulary.
 *
 * A frame with a `code` is recognised only by that code; a frame without one
 * only by its loss `reason`. Anything else — an unknown code, a code beside a
 * loss reason it does not own, a non-record — is `undefined`, which every
 * caller treats as "not something the agent emits": it is neither logged by
 * value nor shown.
 *
 * @param payload An `agent.error` payload, as relayed.
 * @returns The recognised kind, or `undefined`.
 */
export function pageAgentErrorKind(payload: unknown): PageAgentErrorKind | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  if (payload.code !== undefined) {
    return isPageAgentErrorCode(payload.code) ? payload.code : undefined;
  }
  return isPageAgentLossReason(payload.reason) ? payload.reason : undefined;
}

/**
 * The fixed, developer-facing sentence for each recognised `agent.error`.
 *
 * The only words about a page-agent failure that reach the panel: the frame's
 * own `message` is page-controlled and is never shown or logged. Each sentence
 * says what happened and what continues, without naming anything from the
 * page.
 */
export const PAGE_AGENT_ERROR_PUBLIC_MESSAGES: Readonly<Record<PageAgentErrorKind, string>> = {
  'hooks-unavailable':
    'The page agent could not enable one or more capture signals on this page; the capture continues with the signals it could enable.',
  'agent-family-unavailable':
    'The page agent could not arm one of its support hooks; the capture continues, and its trace may be less complete.',
  'hooks-not-released':
    'The page agent could not fully release its hooks; reload the page to return it to a clean state.',
  'producer-failure':
    "One of the page agent's signal producers failed; that signal may be incomplete for this capture.",
  'event-unserializable': 'The page agent dropped an event it could not serialize.',
  'event-too-large': 'The page agent dropped an event larger than the page channel allows.',
  'control-frame-too-large':
    "The page agent could not send a control frame larger than the page channel's limit.",
  'control-frame-unserializable':
    'The page agent could not send a control frame it could not serialize.',
  'control-frame-refused': 'The page channel refused a control frame from the page agent.',
};

/*
 * ===========================================================================
 * Section H — the bridge ↔ worker port (`PORT_CONTENT_BRIDGE`)
 *
 * The bridge is a validating pass-through: an agent frame whose `detail` is
 * within {@link MAX_PAGE_FRAME_LENGTH}, parses, passes
 * {@link isAgentChannelMessage} and matches the document's pinned provenance
 * travels upstream with the same `type` and the same (parsed) payload, and a
 * downstream frame's payload is sent to the agent on the channel node as it
 * came, re-framed with the bridge's tag and the channel version. The worker
 * identifies the tab from the port's `sender` and applies
 * {@link isBridgeUpstreamMessage} again, because the data is page-originated.
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

/*
 * ===========================================================================
 * Section J — the `$0` target descriptor parser
 *
 * Two surfaces read the Elements panel's selection with
 * `chrome.devtools.inspectedWindow.eval`: the devtools page (on
 * `panels.elements.onSelectionChanged` and on `devtools.describeRequest`) and
 * the panel's "Use selected element". Both ask the MAIN-world agent's
 * `window.__DEBUGGEN__.describeTarget($0)`, and the inspected page controls
 * that global — any script on it can replace the helper and answer whatever it
 * likes. So both surfaces parse the answer here, with one set of bounds, before
 * a descriptor is shown, relayed or sent.
 *
 * The bounds mirror the authoritative `selectedTargetSchema` in
 * `packages/instrumentation/src/schema/target.ts`, which the service applies to
 * every `target.selected`. Enforcing the same ceilings in the extension means a
 * hostile page cannot inflate a frame or a panel row, while nothing the service
 * would accept is refused on the way. That package is not a dependency of this
 * workspace, so the values are mirrored rather than imported; a change there
 * must be made here in the same commit.
 * ===========================================================================
 */

/** Longest `selector`, in UTF-16 code units. */
export const SELECTION_MAX_SELECTOR_LENGTH = 1_024;

/** Longest `tagName`. */
export const SELECTION_MAX_TAG_NAME_LENGTH = 64;

/** Longest `text`; a longer or multi-line value is dropped (the field is optional). */
export const SELECTION_MAX_TEXT_LENGTH = 256;

/** Most `componentChain` entries kept, nearest-first. */
export const SELECTION_MAX_COMPONENT_CHAIN = 16;

/** Longest component name; a longer entry is dropped from the chain. */
export const SELECTION_MAX_COMPONENT_NAME_LENGTH = 128;

/** Longest `url`. */
export const SELECTION_MAX_URL_LENGTH = 2_048;

/**
 * Most `componentChain` entries examined. A page can answer an array of any
 * length; entries past this window are never read, so parsing costs the same
 * however large the answer is. Four times the kept maximum leaves room for
 * dropped entries between the nearest valid ones.
 */
export const SELECTION_MAX_COMPONENT_CHAIN_SCAN = SELECTION_MAX_COMPONENT_CHAIN * 4;

/** The highest code point of the C0 control block, `NUL` included. */
const DESCRIPTOR_C0_CONTROL_MAX = 0x1f;

/** The lowest code point of the `DEL`/C1 control block. */
const DESCRIPTOR_C1_CONTROL_MIN = 0x7f;

/** The highest code point of the C1 control block. */
const DESCRIPTOR_C1_CONTROL_MAX = 0x9f;

/**
 * Whether `value` contains a C0 control, `DEL` or a C1 control character — a
 * line break, a tab, `NUL`, an `ESC` that would start a terminal sequence in a
 * log line. A character-code scan rather than a regular expression, so no
 * control range is written literally.
 */
function hasDescriptorControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= DESCRIPTOR_C0_CONTROL_MAX ||
      (code >= DESCRIPTOR_C1_CONTROL_MIN && code <= DESCRIPTOR_C1_CONTROL_MAX)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `value` is a single line of display text within `maxLength` UTF-16
 * code units: a string, at least one non-whitespace character, no control
 * character. The service's single-line rule, with its bound.
 *
 * Also the devtools page's check for the inspected document's URL and origin
 * it announces, so both surfaces agree on what a bounded line is.
 *
 * @param value A field read off an answer the inspected page produced.
 * @param maxLength The field's bound.
 */
export function isBoundedSingleLine(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    value.trim().length > 0 &&
    !hasDescriptorControlCharacter(value)
  );
}

/**
 * Whether `value` is a descriptor `url`: a bounded single line with no
 * surrounding whitespace that parses as an absolute `http:`/`https:` URL with
 * a host. The WHATWG parser decides, and the original string is kept — the
 * parser's own normalisation (trimming, stripping tabs and line breaks) would
 * otherwise turn a rejection into a silent rewrite, which is why the
 * single-line check runs first.
 */
function isDescriptorUrl(value: unknown): value is string {
  if (!isBoundedSingleLine(value, SELECTION_MAX_URL_LENGTH) || value.trim() !== value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * The component chain's valid entries, nearest-first, at most
 * {@link SELECTION_MAX_COMPONENT_CHAIN} of them, reading no more than
 * {@link SELECTION_MAX_COMPONENT_CHAIN_SCAN} entries of `entries`.
 */
function boundedComponentChain(entries: readonly unknown[]): string[] {
  const chain: string[] = [];
  const scanned = Math.min(entries.length, SELECTION_MAX_COMPONENT_CHAIN_SCAN);
  for (let index = 0; index < scanned && chain.length < SELECTION_MAX_COMPONENT_CHAIN; index += 1) {
    const entry = entries[index];
    if (isBoundedSingleLine(entry, SELECTION_MAX_COMPONENT_NAME_LENGTH)) {
      chain.push(entry);
    }
  }
  return chain;
}

/**
 * Parse a `SelectedTarget` descriptor that crossed from the inspected page,
 * and rebuild it from its five known fields so no unrecognised key rides
 * along.
 *
 * - `selector` and `tagName` must be bounded single lines, and `url` an
 *   absolute `http:`/`https:` URL with a host; otherwise the whole descriptor
 *   is refused — there is nothing trustworthy to show or send.
 * - `componentChain` must be an array. Entries that are not bounded single
 *   lines are dropped in place, and the nearest
 *   {@link SELECTION_MAX_COMPONENT_CHAIN} valid ones are kept, so the order the
 *   schema defines survives; an empty chain is a valid answer.
 * - `text` is optional: a value that is not a bounded single line is dropped
 *   rather than truncated, so nothing the page did not write is produced.
 *
 * The descriptor is otherwise kept byte-for-byte: the service validates it
 * authoritatively, needs the unredacted `url` to map it onto a route, and
 * redacts before it stores or sends anything (AAP §0.5.2). What a surface
 * *displays* is that surface's own concern.
 *
 * Total: never throws, whatever the page answered.
 *
 * @param raw Whatever the evaluation answered for the descriptor.
 * @returns The rebuilt descriptor, or `undefined` when it is refused.
 *
 * @example
 * ```ts
 * const target = parseSelectedTargetDescriptor(evaluationResult);
 * if (target === undefined) {
 *   // Report "could not be described"; show and send nothing.
 * }
 * ```
 */
export function parseSelectedTargetDescriptor(raw: unknown): SelectedTarget | undefined {
  try {
    if (!isRecord(raw)) {
      return undefined;
    }
    const { selector, tagName, text, componentChain, url } = raw;
    if (
      !isBoundedSingleLine(selector, SELECTION_MAX_SELECTOR_LENGTH) ||
      !isBoundedSingleLine(tagName, SELECTION_MAX_TAG_NAME_LENGTH) ||
      !isDescriptorUrl(url) ||
      !Array.isArray(componentChain)
    ) {
      return undefined;
    }
    const entries: readonly unknown[] = componentChain;
    const chain = boundedComponentChain(entries);
    return isBoundedSingleLine(text, SELECTION_MAX_TEXT_LENGTH)
      ? { selector, tagName, text, componentChain: chain, url }
      : { selector, tagName, componentChain: chain, url };
  } catch {
    // A getter on a hostile object can throw; that is a refused answer too.
    return undefined;
  }
}
