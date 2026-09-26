/**
 * Unit spec for `../src/content/bridge.ts` — the isolated-world content script
 * that is the only path between the MAIN-world page agent and the Manifest V3
 * service worker, at page channel **version 3**.
 *
 * The bridge is three boundaries at once, and this spec proves each:
 *
 * - **A private channel.** After one handshake on `window` at
 *   `document_start`, every frame travels as a cancelable `CustomEvent` on the
 *   agent's detached node. Page scripts — modelled here as listeners and
 *   dispatches on the window registered *after* `start()`, which is when a
 *   real page script first runs — never see a bridge frame or the node, and
 *   nothing they post with `window.postMessage` or dispatch on `window` is
 *   ever relayed. No frame carries a token.
 * - **A filter with provenance.** `shouldAcceptAgentFrame` bounds, parses and
 *   shape-checks every frame, requires canonical opaque ids and the closed
 *   `agent.error` vocabulary, pins the document from its first `agent.ready`,
 *   and refuses a batch from another document or producer, or one whose
 *   `batchSeq` does not strictly increase within a capture.
 * - **A custodian.** It acknowledges (`preventDefault`) a frame only after the
 *   port took it, or when it refused it for good; with no port, or a port whose
 *   post throws, the frame stays with the agent, the port is treated as lost
 *   without a re-entrant `bridge.gone`, and after the reconnect the agent's
 *   re-sent frame is relayed exactly once. The one exception is the agent's
 *   own loss-only batch, whose count the bridge takes and reports itself, at
 *   once on the next port, because the agent's capture reset would zero it.
 * - **A meter.** A per-document token bucket over telemetry events relays a
 *   burst up to its capacity, refuses — and acknowledges — a batch beyond it
 *   as `rate-limited` only after every structural and provenance check, refills
 *   over an injected monotonic clock, spends nothing for a batch the port did
 *   not take, and reports the refused events exactly once and only under
 *   their own capture: in the `droppedCount` of the next batch of that capture
 *   actually posted or, when none carries them within
 *   `BRIDGE_LOSS_REPORT_DELAY_MS`, the browser (never a page script) fires
 *   `pagehide` or a new port opens, in an event-less batch of its own that the
 *   worker's guard accepts and that moves neither the sequence nor the budget.
 *   A failed report never merges one capture's count into another's; beyond
 *   `BRIDGE_MAX_HELD_LOSS_CAPTURES` the oldest count is abandoned and counted.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom), whose real `EventTarget`,
 * `CustomEvent` and `MouseEvent` carry the handshake and the frames. The
 * `chrome.runtime` surface, its ports, the reconnect scheduler and a fake
 * MAIN-world agent — which performs the agent's half of the handshake, holds
 * the node, sends frames, keeps unclaimed ones in its own custody and records
 * every bridge frame and acknowledgement — are local to this file and
 * injected through `createContentBridge(deps)`. Vitest's fake timers drive
 * every reconnect and loss report, and an `afterEach` stops every bridge a
 * case created and asserts that nothing — no window or node listener, no port
 * listener, no pending timer — is left attached. happy-dom does not model
 * `isTrusted`, so a browser-dispatched `pagehide`/`pageshow` is an event with
 * `isTrusted: true` defined on it. Only the mirror-contract case and the
 * budget-policy case pin literal values: the first because
 * `../src/shared/messages.ts` names this spec as the check that its copies
 * still match the page agent's transport, the second because the budget's
 * numbers are a documented policy derived from the agent's own bounds.
 *
 * **The worker end of the bridge port.** The last blocks drive
 * `createPortHub` from `../src/background/ports.ts`, where the bridge's frames
 * become readiness and capture input: a second bridge for a tab retires the
 * first, every frame must come from the tab's current bridge and belong to the
 * document that connection's first `agent.ready` pinned (nothing but that
 * `agent.ready` is dispatched before the pin), and a panel's inspected tab,
 * once set, never moves. The composed worker (`createWorker`) is then driven
 * against in-memory fakes: a panel is associated with the inspected tab it
 * names, or — naming none — only with the one DevTools tab awaiting a panel,
 * never by its session claim; its session requests are held to its own tab;
 * and a bridge frame that waited (for the cold start, for a registry read) is
 * checked again and dropped once its bridge was superseded. Their ports are
 * structurally complete `chrome.runtime.Port` fakes local to this file; no
 * `chrome` global is read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DebuggenError, createConsoleLogger, err, noopLogger } from '@debuggen/shared';
import type { LogRecord, Logger, Result } from '@debuggen/shared';

import { isPortRequestOfMethod, portOk, workerError } from '../src/background/messages';
import type {
  BridgeConnection,
  PanelConnection,
  TabBindingRecord,
  WorkerConnectionId,
  WorkerTimerApi,
} from '../src/background/messages';
import { createPortHub } from '../src/background/ports';
import type {
  BridgeMessageContext,
  BridgeMessageHandler,
  PortClosedEvent,
  PortHub,
  PortRequestHandlers,
} from '../src/background/ports';
import { createWorker } from '../src/background/service-worker';
import type {
  DebugGeneratorWorker,
  WorkerEnvironment,
  WorkerEvent,
} from '../src/background/service-worker';
import { BINDING_STORAGE_KEY } from '../src/background/tab-registry';
import { startPanelConnection } from '../src/panel/state/connection';
import type { PanelConnectionHandle } from '../src/panel/state/connection';
import {
  getPanelSnapshot,
  resetPanelStore,
  setBindingState,
} from '../src/panel/state/session-store';
import {
  BRIDGE_EVENT_BUDGET_CAPACITY,
  BRIDGE_EVENT_BUDGET_REFILL_PER_SECOND,
  BRIDGE_LOSS_REPORT_DELAY_MS,
  BRIDGE_MAX_HELD_LOSS_CAPTURES,
  BRIDGE_PORT_STABLE_MS,
  BRIDGE_RECONNECT_BASE_MS,
  BRIDGE_RECONNECT_JITTER,
  BRIDGE_RECONNECT_MAX_MS,
  BRIDGE_REFUSAL_REASONS,
  computeReconnectDelay,
  consumeEventBudget,
  createContentBridge,
  fullEventBudget,
  isChannelNodeCandidate,
  refillEventBudget,
  shouldAcceptAgentFrame,
} from '../src/content/bridge';
import type {
  AgentFrameContext,
  AgentProvenance,
  BridgeRefusalReason,
  BridgeStats,
  ChromeRuntimeLike,
  ContentBridge,
  EventBudget,
  PortEventLike,
  PortLike,
  WindowLike,
} from '../src/content/bridge';
import {
  AGENT_OUTBOUND_TYPES,
  AGENT_SOURCE_TAG,
  BRIDGE_DOWNSTREAM_MESSAGE_TYPES,
  BRIDGE_OUTBOUND_TYPES,
  BRIDGE_SOURCE_TAG,
  EXTENSION_CHANNEL,
  MAX_PAGE_FRAME_LENGTH,
  PAGE_AGENT_ERROR_CODES,
  PAGE_AGENT_FRAME_EVENT,
  PAGE_AGENT_LOSS_REASONS,
  PAGE_BRIDGE_FRAME_EVENT,
  PAGE_CHANNEL_VERSION,
  PAGE_HANDSHAKE_OFFER_EVENT,
  PAGE_HANDSHAKE_REQUEST_EVENT,
  PORT_CONTENT_BRIDGE,
  PORT_DEVTOOLS,
  PORT_PANEL,
  PORT_PROTOCOL_VERSION,
  exceedsPageFrameCap,
  isBridgeChannelMessage,
  isBridgeDownstreamMessage,
  isBridgeUpstreamMessage,
  isDevtoolsDownstreamMessage,
  isPortPush,
  isPortRequest,
  isPortResponse,
  newPortRequestId,
  pageFrameLength,
  renderPageFrame,
} from '../src/shared/messages';
import type {
  AgentChannelMessage,
  AgentOutboundType,
  BridgeChannelMessage,
  BridgeDownstreamMessage,
  BridgeDownstreamPayloads,
  BridgeDownstreamType,
  BridgeUpstreamFrame,
  BridgeUpstreamMessage,
  BridgeUpstreamPayloads,
  PageAgentErrorPayload,
  PageAgentReadyPayload,
  PageTargetDescribedPayload,
  PageTelemetryBatchPayload,
  PanelBindingState,
  PortPush,
  PortRequestFrame,
  PortRequestKind,
  PortRequestPayloads,
  PortResponse,
} from '../src/shared/messages';

/*
 * ===========================================================================
 * Fixture values — neutral, and obviously synthetic
 * ===========================================================================
 */

/** The origin of the page the bridge serves: a generic local dev server. */
const PAGE_ORIGIN = 'http://localhost:4100';

/** A fake extension id; a non-empty string is all the bridge reads. */
const EXTENSION_ID = 'test-extension-id';

/** The document and producer every genuine agent fixture names (canonical opaque ids). */
const DOCUMENT_ID = 'doc_0123456789abcdef';
const PRODUCER_ID = 'prd_0123456789abcdef';

/** Well-formed ids of *another* document and producer: what a forged frame names. */
const FORGED_DOCUMENT_ID = 'doc_zzzzzzzzzzzzzzzz';
const FORGED_PRODUCER_ID = 'prd_zzzzzzzzzzzzzzzz';

/** Service-minted capture and session ids (canonical opaque ids). */
const CAPTURE_ID = 'cap_0123456789abcdef';
const OTHER_CAPTURE_ID = 'cap_fedcba9876543210';
const SESSION_ID = 'ses_0123456789abcdef';

/** Page-chosen content that must never be relayed, counted by value or logged. */
const PRIVATE_SENTINEL = 'PRIVATE-SENTINEL-7c2e user@example.test?token=abc.def.ghi';

/** The identity a genuine `agent.ready` pins. */
const PINNED: AgentProvenance = { documentId: DOCUMENT_ID, producerId: PRODUCER_ID };

/** One telemetry event, exactly as the agent ships it inside a batch. */
type PageTelemetryEvent = PageTelemetryBatchPayload['events'][number];

function interactionEvent(producerId = PRODUCER_ID): PageTelemetryEvent {
  return {
    id: 'event-0001',
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    kind: 'interaction',
    name: 'click',
    startTime: 1_767_225_600_000.5,
    duration: 12.25,
    tier: 'browser',
    attributes: { 'event.type': 'click', 'target.tag': 'button' },
    status: 'ok',
    producerId,
    seq: 0,
  };
}

function fetchEvent(producerId = PRODUCER_ID): PageTelemetryEvent {
  return {
    id: 'event-0002',
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: '00f067aa0ba902b7',
    parentSpanId: 'b7ad6b7169203331',
    kind: 'fetch',
    name: 'GET /items',
    startTime: 1_767_225_600_004.75,
    duration: 48.5,
    tier: 'browser',
    attributes: { 'http.method': 'GET', url: '/items?page=?', 'http.status_code': 200 },
    status: 'ok',
    producerId,
    seq: 1,
  };
}

function readyPayload(overrides: Partial<PageAgentReadyPayload> = {}): PageAgentReadyPayload {
  return {
    documentId: DOCUMENT_ID,
    producerId: PRODUCER_ID,
    url: `${PAGE_ORIGIN}/workspace`,
    installedBeforeReact: true,
    reactDetected: true,
    ...overrides,
  };
}

function batchPayload(
  overrides: Partial<PageTelemetryBatchPayload> = {},
): PageTelemetryBatchPayload {
  return {
    events: [interactionEvent(), fetchEvent()],
    producerId: PRODUCER_ID,
    documentId: DOCUMENT_ID,
    batchSeq: 0,
    droppedCount: 0,
    captureId: CAPTURE_ID,
    sessionId: SESSION_ID,
    ...overrides,
  };
}

function describedPayload(): PageTargetDescribedPayload {
  return {
    target: {
      selector: 'main > form > button.primary',
      tagName: 'button',
      text: 'Save changes',
      componentChain: ['SettingsPage', 'PreferencesForm', 'SubmitAction'],
      url: `${PAGE_ORIGIN}/settings`,
    },
    requestId: 'request-0001',
  };
}

/** A diagnostic the agent really emits: a known code, its own fields. */
function errorPayload(): PageAgentErrorPayload {
  return { code: 'producer-failure', source: 'react', stage: 'commit' };
}

function readyFrame(payload = readyPayload()): AgentChannelMessage<'agent.ready'> {
  return { source: AGENT_SOURCE_TAG, version: PAGE_CHANNEL_VERSION, type: 'agent.ready', payload };
}

function batchFrame(payload = batchPayload()): AgentChannelMessage<'telemetry.batch'> {
  return {
    source: AGENT_SOURCE_TAG,
    version: PAGE_CHANNEL_VERSION,
    type: 'telemetry.batch',
    payload,
  };
}

function describedFrame(): AgentChannelMessage<'target.described'> {
  return {
    source: AGENT_SOURCE_TAG,
    version: PAGE_CHANNEL_VERSION,
    type: 'target.described',
    payload: describedPayload(),
  };
}

function errorFrame(
  payload: PageAgentErrorPayload = errorPayload(),
): AgentChannelMessage<'agent.error'> {
  return { source: AGENT_SOURCE_TAG, version: PAGE_CHANNEL_VERSION, type: 'agent.error', payload };
}

/** One well-formed agent → bridge frame per agent frame type. */
type AgentFrameFixtures = { readonly [Type in AgentOutboundType]: AgentChannelMessage<Type> };

function agentFrames(): AgentFrameFixtures {
  return {
    'agent.ready': readyFrame(),
    'telemetry.batch': batchFrame(),
    'target.described': describedFrame(),
    'agent.error': errorFrame(),
  };
}

function configPayload(): BridgeDownstreamPayloads['agent.config'] {
  return {
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    hooks: {
      interactions: true,
      react: true,
      state: true,
      fetch: true,
      perf: true,
      errors: true,
      componentTree: false,
    },
  };
}

/** One well-formed worker → bridge frame per downstream frame type. */
type DownstreamFrameFixtures = {
  readonly [Type in BridgeDownstreamType]: BridgeDownstreamMessage<Type>;
};

function downstreamFrames(): DownstreamFrameFixtures {
  return {
    'agent.config': {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'downstream',
      type: 'agent.config',
      payload: configPayload(),
    },
    'agent.snapshot': {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'downstream',
      type: 'agent.snapshot',
      payload: { requestId: 'request-0002', maxNodes: 500, maxDepth: 40 },
    },
    'target.request': {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'downstream',
      type: 'target.request',
      payload: { requestId: 'request-0003' },
    },
  };
}

/*
 * ===========================================================================
 * Deliberately malformed values
 *
 * Built as untyped records and handed to the module through its own `unknown`
 * inputs (a frame `detail`, a port message), never cast to a valid frame type.
 * ===========================================================================
 */

/** A copy of `value` with `fields` overwritten or added. */
function withFields(value: object, fields: Readonly<Record<string, unknown>>): unknown {
  return { ...value, ...fields };
}

/** A copy of `value` without `field`. */
function withoutField(value: object, field: string): unknown {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

/** A frame rendered exactly as the agent dispatches it: its JSON text. */
function detailOf(frame: unknown): string {
  return JSON.stringify(frame);
}

/**
 * An `agent.error` detail exactly `targetLength` code units long, padded with
 * `pad` inside a relayed diagnostic field. Each padding character adds exactly
 * one code unit to the JSON text, so the length is exact.
 */
function paddedErrorDetail(targetLength: number, pad = 'x'): string {
  const base = detailOf(errorFrame({ code: 'producer-failure', note: '' }));
  return detailOf(
    errorFrame({ code: 'producer-failure', note: pad.repeat(targetLength - base.length) }),
  );
}

/** A batch frame outside any capture: `captureId` absent, as the agent omits it. */
function uncapturedBatchFrame(batchSeq: number): unknown {
  return withFields(batchFrame(), {
    payload: withoutField(batchPayload({ batchSeq }), 'captureId'),
  });
}

/**
 * The most events the agent puts in one batch (`MAX_EVENTS_PER_BATCH` in
 * `packages/telemetry/src/browser/transport.ts`): the realistic batch size
 * the budget cases send.
 */
const AGENT_BATCH_EVENTS = 200;

/** `count` distinct events of the pinned producer, oldest first. */
function eventsOf(count: number): PageTelemetryEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    ...interactionEvent(),
    id: `event-${String(index).padStart(5, '0')}`,
    seq: index,
  }));
}

/** A genuine batch of `count` events at `batchSeq`, carrying the agent's own `droppedCount`. */
function sizedBatchFrame(
  count: number,
  batchSeq: number,
  droppedCount = 0,
): AgentChannelMessage<'telemetry.batch'> {
  return batchFrame(batchPayload({ events: eventsOf(count), batchSeq, droppedCount }));
}

/** The milliseconds the budget needs to earn `events` events at the exported refill rate. */
function msToEarn(events: number): number {
  return (events * 1_000) / BRIDGE_EVENT_BUDGET_REFILL_PER_SECOND;
}

/*
 * ===========================================================================
 * Local fakes: chrome.runtime, its ports, the page window, the scheduler
 * ===========================================================================
 */

/** A `chrome.events.Event` whose listeners the test can inspect and fire. */
interface FakePortEvent<Listener> extends PortEventLike<Listener> {
  readonly listeners: ReadonlySet<Listener>;
}

function createPortEvent<Listener>(): FakePortEvent<Listener> {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: (listener: Listener): void => {
      listeners.add(listener);
    },
    removeListener: (listener: Listener): void => {
      listeners.delete(listener);
    },
  };
}

/** A `chrome.runtime.Port` the test drives from the worker's side. */
interface FakePort extends PortLike {
  readonly name: string;
  readonly onMessage: FakePortEvent<(message: unknown) => void>;
  readonly onDisconnect: FakePortEvent<(port: unknown) => void>;
  /** Records every frame the bridge posts on this port, the throwing attempts included. */
  readonly post: Mock<(message: unknown) => void>;
  /** Records the bridge closing this port from its side. */
  readonly close: Mock<() => void>;
  /** The frames this port actually accepted (posts that did not throw). */
  readonly accepted: readonly unknown[];
  /** Deliver a message from the worker. */
  emitMessage(message: unknown): void;
  /** Close the worker's end — what an MV3 worker suspension looks like here. */
  emitDisconnect(): void;
  /** Make every later post throw, as a port that died unreported does. */
  failPosts(): void;
}

/**
 * A fake port that accepts `acceptedBeforeFailure` posts and throws on every
 * later one — by default it never fails, as the panel-side suites need.
 */
function createFakePort(
  name: string,
  acceptedBeforeFailure: number = Number.POSITIVE_INFINITY,
): FakePort {
  const onMessage = createPortEvent<(message: unknown) => void>();
  const onDisconnect = createPortEvent<(port: unknown) => void>();
  const accepted: unknown[] = [];
  let remaining = acceptedBeforeFailure;
  const post = vi.fn<(message: unknown) => void>((message: unknown) => {
    if (remaining <= 0) {
      throw new Error('Attempting to use a disconnected port object');
    }
    remaining -= 1;
    accepted.push(message);
  });
  const close = vi.fn<() => void>();
  const port: FakePort = {
    name,
    onMessage,
    onDisconnect,
    post,
    close,
    accepted,
    postMessage: post,
    disconnect: close,
    emitMessage: (message: unknown): void => {
      for (const listener of [...onMessage.listeners]) {
        listener(message);
      }
    },
    emitDisconnect: (): void => {
      for (const listener of [...onDisconnect.listeners]) {
        listener(port);
      }
    },
    failPosts: (): void => {
      remaining = 0;
    },
  };
  return port;
}

/** The `chrome.runtime` slice, with every opened port kept for inspection. */
interface FakeRuntime extends ChromeRuntimeLike {
  id: string | undefined;
  lastError: { readonly message?: string | undefined } | undefined;
  readonly connectSpy: Mock<(connectInfo: { name: string }) => PortLike>;
  readonly ports: readonly FakePort[];
  /** The most recently opened port. */
  latestPort(): FakePort;
  /** Make the next `connect()` throw, as a runtime without a listener can. */
  failNextConnect(): void;
  /** Make the next port accept `count` posts and throw on every later one. */
  nextPortFailsAfter(count: number): void;
}

interface FakeRuntimeOptions {
  /** `false` builds a runtime whose extension context is already invalidated (no id). */
  readonly contextAlive?: boolean;
}

function createFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const id = options.contextAlive === false ? undefined : EXTENSION_ID;
  const ports: FakePort[] = [];
  let failNext = false;
  let nextBudget = Number.POSITIVE_INFINITY;
  const connectSpy = vi.fn((connectInfo: { name: string }): PortLike => {
    if (failNext) {
      failNext = false;
      throw new Error('Could not establish connection. Receiving end does not exist.');
    }
    const port = createFakePort(connectInfo.name, nextBudget);
    nextBudget = Number.POSITIVE_INFINITY;
    ports.push(port);
    return port;
  });
  return {
    id,
    lastError: undefined,
    connect: connectSpy,
    connectSpy,
    ports,
    latestPort: (): FakePort => {
      const port = ports.at(-1);
      if (port === undefined) {
        throw new Error('the bridge has not opened a port');
      }
      return port;
    },
    failNextConnect: (): void => {
      failNext = true;
    },
    nextPortFailsAfter: (count: number): void => {
      nextBudget = count;
    },
  };
}

/** A `(event: unknown) => void` listener, as the bridge's surfaces type it. */
type WindowListener = (event: unknown) => void;

/**
 * The page `window` the bridge is given: a real `EventTarget` behind a wrapper
 * that records what the **bridge** registers and dispatches. The fake agent
 * and the page scripts use {@link FakeWindow.target} directly, the way code in
 * the MAIN world shares one window with the isolated world's view of it.
 */
interface FakeWindow extends WindowLike {
  /** The real event target: where the agent and page scripts listen and dispatch. */
  readonly target: EventTarget;
  /** The `type` of every event the bridge dispatched on the window, in order. */
  readonly dispatchedTypes: readonly string[];
  readonly addSpy: Mock<(type: string, listener: WindowListener) => void>;
  readonly removeSpy: Mock<(type: string, listener: WindowListener) => void>;
  readonly dispatchSpy: Mock<(event: Event) => boolean>;
  /** Bridge listeners currently registered for `type`, or for every type. */
  listenerCount(type?: string): number;
  /** What a page script's `window.postMessage(data, '/')` delivers: a `message` event. */
  postMessage(data: unknown): void;
}

function createFakeWindow(): FakeWindow {
  const target = new EventTarget();
  const registered = new Map<string, Set<WindowListener>>();
  const dispatchedTypes: string[] = [];

  const addSpy = vi.fn((type: string, listener: WindowListener): void => {
    const listeners = registered.get(type) ?? new Set<WindowListener>();
    listeners.add(listener);
    registered.set(type, listeners);
    target.addEventListener(type, listener);
  });
  const removeSpy = vi.fn((type: string, listener: WindowListener): void => {
    registered.get(type)?.delete(listener);
    target.removeEventListener(type, listener);
  });
  const dispatchSpy = vi.fn((event: Event): boolean => {
    dispatchedTypes.push(event.type);
    return target.dispatchEvent(event);
  });

  return {
    target,
    dispatchedTypes,
    addSpy,
    removeSpy,
    dispatchSpy,
    addEventListener: addSpy,
    removeEventListener: removeSpy,
    dispatchEvent: dispatchSpy,
    listenerCount: (type?: string): number =>
      type === undefined
        ? [...registered.values()].reduce((total, listeners) => total + listeners.size, 0)
        : (registered.get(type)?.size ?? 0),
    postMessage: (data: unknown): void => {
      target.dispatchEvent(new MessageEvent('message', { data, origin: PAGE_ORIGIN }));
    },
  };
}

/** One agent frame the fake agent dispatched, and whether the bridge claimed it. */
interface AgentSend {
  readonly type: string;
  readonly claimed: boolean;
}

/**
 * A fake MAIN-world agent: the agent's half of the handshake and of the
 * channel, with the transport's custody model (a frame the bridge does not
 * claim stays pending and is sent again after the next `bridge.ready`).
 */
interface FakeAgent {
  /** The agent's detached channel node. */
  readonly node: HTMLElement;
  /** Every bridge frame received on the node, parsed, in order. */
  readonly received: readonly BridgeChannelMessage[];
  /** The raw `detail` of every bridge-frame event on the node. */
  readonly rawReceived: readonly unknown[];
  /** Every agent frame dispatched, with the bridge's answer. */
  readonly sent: readonly AgentSend[];
  /** Frames still in the agent's custody. */
  readonly pending: readonly unknown[];
  /** Whether the agent answered a handshake request. */
  answered(): boolean;
  /** The types of every bridge frame received. */
  receivedTypes(): string[];
  /** Dispatch one frame on the node now; `true` when the bridge claimed it. */
  send(frame: unknown): boolean;
  /** Dispatch an arbitrary `detail` on the node now; `true` when claimed. */
  sendDetail(detail: unknown, cancelable?: boolean): boolean;
  /** Take a frame into custody and deliver what the bridge will take. */
  deliver(frame: unknown): void;
  /** Bridge listeners currently registered on the node. */
  bridgeListenerCount(): number;
  /**
   * Exceptions thrown inside the agent's own listeners. Vitest runs happy-dom
   * with error capturing disabled, so such a throw escapes the bridge's
   * `dispatchEvent`, where the bridge's defensive catch would absorb it.
   */
  readonly listenerErrors: readonly unknown[];
}

interface FakeAgentOptions {
  /** Answer the bridge's handshake request (default `true`). */
  readonly answerHandshake?: boolean;
  /** Offer this as the `relatedTarget` instead of the node. */
  readonly offerRelatedTarget?: unknown;
  /** Claim bridge frames the agent accepts, as the real agent does (default `true`). */
  readonly claimBridgeFrames?: boolean;
  /** Re-announce this `agent.ready` inside every `bridge.ready`, after draining. */
  readonly announceOnReady?: PageAgentReadyPayload;
  /** Called when a `bridge.ready` arrives, before the agent drains. */
  readonly onBridgeReady?: () => void;
  /**
   * Called when an `agent.config` arrives, inside its dispatch — where the
   * real agent's terminal flush posts the capture's tail.
   */
  readonly onAgentConfig?: () => void;
}

/** The `type` of a frame-shaped value, for the send log. */
function frameType(frame: unknown): string {
  return typeof frame === 'object' &&
    frame !== null &&
    'type' in frame &&
    typeof frame.type === 'string'
    ? frame.type
    : '(none)';
}

function installFakeAgent(win: FakeWindow, options: FakeAgentOptions = {}): FakeAgent {
  const node = document.createElement('div');
  const received: BridgeChannelMessage[] = [];
  const rawReceived: unknown[] = [];
  const sent: AgentSend[] = [];
  const pending: unknown[] = [];
  const listenerErrors: unknown[] = [];
  const claimBridgeFrames = options.claimBridgeFrames ?? true;
  let answered = false;
  let bridgeAvailable = false;
  let draining = false;

  function sendDetail(detail: unknown, cancelable = true): boolean {
    return !node.dispatchEvent(new CustomEvent(PAGE_AGENT_FRAME_EVENT, { detail, cancelable }));
  }

  function send(frame: unknown): boolean {
    const claimed = sendDetail(detailOf(frame));
    sent.push({ type: frameType(frame), claimed });
    return claimed;
  }

  function drain(): void {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (bridgeAvailable && pending.length > 0) {
        if (send(pending[0])) {
          pending.shift();
        } else {
          // Unclaimed: the frame stays first in line and the bridge is away.
          bridgeAvailable = false;
        }
      }
    } finally {
      draining = false;
    }
  }

  /** Run a listener body, recording (not propagating) anything it throws. */
  function guarded(body: () => void): void {
    try {
      body();
    } catch (error) {
      listenerErrors.push(error);
    }
  }

  function onBridgeFrame(event: Event): void {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
    rawReceived.push(detail);
    const parsed: unknown = typeof detail === 'string' ? JSON.parse(detail) : undefined;
    if (!isBridgeChannelMessage(parsed)) {
      return;
    }
    received.push(parsed);
    if (claimBridgeFrames) {
      event.preventDefault();
    }
    if (parsed.type === 'bridge.ready') {
      options.onBridgeReady?.();
      bridgeAvailable = true;
      drain();
      if (options.announceOnReady !== undefined) {
        send(readyFrame(options.announceOnReady));
      }
    } else if (parsed.type === 'bridge.gone') {
      bridgeAvailable = false;
    } else if (parsed.type === 'agent.config') {
      options.onAgentConfig?.();
    }
  }

  node.addEventListener(PAGE_BRIDGE_FRAME_EVENT, (event: Event) => {
    guarded(() => {
      onBridgeFrame(event);
    });
  });

  // Counted from here on, so only the bridge's registrations are seen.
  const nodeAdd = vi.spyOn(node, 'addEventListener');
  const nodeRemove = vi.spyOn(node, 'removeEventListener');

  function onRequest(): void {
    if (answered) {
      return;
    }
    answered = true;
    win.target.removeEventListener(PAGE_HANDSHAKE_REQUEST_EVENT, onRequest);
    guarded(() => {
      const offer = new MouseEvent(PAGE_HANDSHAKE_OFFER_EVENT, { relatedTarget: node });
      if ('offerRelatedTarget' in options) {
        Object.defineProperty(offer, 'relatedTarget', { value: options.offerRelatedTarget });
      }
      win.target.dispatchEvent(offer);
    });
  }

  if (options.answerHandshake ?? true) {
    win.target.addEventListener(PAGE_HANDSHAKE_REQUEST_EVENT, onRequest);
  }

  const countFor = (calls: readonly (readonly unknown[])[]): number =>
    calls.filter(([type]) => type === PAGE_AGENT_FRAME_EVENT).length;

  return {
    node,
    received,
    rawReceived,
    sent,
    pending,
    answered: (): boolean => answered,
    receivedTypes: (): string[] => received.map((frame) => frame.type),
    send,
    sendDetail,
    deliver: (frame: unknown): void => {
      pending.push(frame);
      drain();
    },
    bridgeListenerCount: (): number =>
      countFor(nodeAdd.mock.calls) - countFor(nodeRemove.mock.calls),
    listenerErrors,
  };
}

/**
 * A page script, which in a real page first runs after `document_start` — so
 * after the bridge's `start()` here. It listens on the window for everything
 * the channel could conceivably put there, and can dispatch or post forgeries.
 */
interface PageScript {
  /** Every event the script observed on the window, by type. */
  readonly seen: readonly string[];
  /** Every `relatedTarget` the script observed on any event. */
  readonly relatedTargets: readonly unknown[];
  /** Remove the script's listeners. */
  dispose(): void;
}

const PAGE_SCRIPT_WATCHED_TYPES: readonly string[] = [
  PAGE_AGENT_FRAME_EVENT,
  PAGE_BRIDGE_FRAME_EVENT,
  PAGE_HANDSHAKE_OFFER_EVENT,
  PAGE_HANDSHAKE_REQUEST_EVENT,
  'message',
];

function runPageScript(win: FakeWindow): PageScript {
  const seen: string[] = [];
  const relatedTargets: unknown[] = [];
  const listener = (event: Event): void => {
    seen.push(event.type);
    if (event instanceof MouseEvent) {
      relatedTargets.push(event.relatedTarget);
    }
  };
  for (const type of PAGE_SCRIPT_WATCHED_TYPES) {
    win.target.addEventListener(type, listener, { capture: true });
  }
  return {
    seen,
    relatedTargets,
    dispose: (): void => {
      for (const type of PAGE_SCRIPT_WATCHED_TYPES) {
        win.target.removeEventListener(type, listener, { capture: true });
      }
    },
  };
}

/**
 * The reconnect scheduler the bridge is given: every call recorded with its
 * delay, backed by the global timers (faked by Vitest in every bridge case),
 * and cancellable through the opaque numeric handle it returns.
 */
interface FakeScheduler {
  readonly schedule: Mock<(callback: () => void, delayMs: number) => unknown>;
  readonly cancel: Mock<(handle: unknown) => void>;
  /** The delay of every reconnect the bridge scheduled, in order. */
  delays(): number[];
  /** Timers scheduled and neither fired nor cancelled. */
  pending(): number;
}

function createScheduler(): FakeScheduler {
  const live = new Map<number, ReturnType<typeof setTimeout>>();
  let lastHandle = 0;
  const schedule = vi.fn((callback: () => void, delayMs: number): unknown => {
    lastHandle += 1;
    const handle = lastHandle;
    live.set(
      handle,
      setTimeout(() => {
        live.delete(handle);
        callback();
      }, delayMs),
    );
    return handle;
  });
  const cancel = vi.fn((handle: unknown): void => {
    if (typeof handle !== 'number') {
      return;
    }
    const timer = live.get(handle);
    if (timer !== undefined) {
      clearTimeout(timer);
      live.delete(handle);
    }
  });
  return {
    schedule,
    cancel,
    delays: (): number[] => schedule.mock.calls.map(([, delayMs]) => delayMs),
    pending: (): number => live.size,
  };
}

/*
 * ===========================================================================
 * Frame readers — narrow what the fakes recorded through the contract's guards
 * ===========================================================================
 */

/**
 * The complete key set of a bridge → worker frame, sorted: the port's framing
 * around the agent's `type` and `payload`, and no protocol envelope field
 * (`id`, `ts`, `sessionId`) — wrapping is the service worker's job.
 */
const UPSTREAM_FRAME_KEYS: readonly string[] = [
  'channel',
  'direction',
  'payload',
  'type',
  'version',
];

/** The complete key set of a bridge → agent frame, sorted: no `token`. */
const BRIDGE_FRAME_KEYS: readonly string[] = ['payload', 'source', 'type', 'version'];

function expectUpstreamFrame(value: unknown): BridgeUpstreamMessage {
  if (!isBridgeUpstreamMessage(value)) {
    throw new Error('expected a well-formed bridge → worker frame');
  }
  return value;
}

/** Every frame `port` accepted, narrowed. */
function upstreamFrames(port: FakePort): BridgeUpstreamMessage[] {
  return port.accepted.map((message) => expectUpstreamFrame(message));
}

/** The types of every frame `port` accepted. */
function upstreamTypes(port: FakePort): string[] {
  return upstreamFrames(port).map((frame) => frame.type);
}

/** The one frame `port` accepted. */
function soleUpstreamFrame(port: FakePort): BridgeUpstreamMessage {
  const frames = upstreamFrames(port);
  expect(frames).toHaveLength(1);
  const [frame] = frames;
  if (frame === undefined) {
    throw new Error('expected exactly one bridge → worker frame');
  }
  return frame;
}

/** The payload of every `telemetry.batch` frame `port` accepted, in order. */
function relayedBatches(port: FakePort): PageTelemetryBatchPayload[] {
  return upstreamFrames(port).flatMap((frame) =>
    frame.type === 'telemetry.batch' ? [frame.payload] : [],
  );
}

/** The last bridge frame the agent received. */
function lastReceived(agent: FakeAgent): BridgeChannelMessage {
  const frame = agent.received.at(-1);
  if (frame === undefined) {
    throw new Error('the agent has received no bridge frame');
  }
  return frame;
}

/** A refusal counter set with every reason at zero, derived from the exported tuple. */
function zeroRefusals(): Record<string, number> {
  return Object.fromEntries(BRIDGE_REFUSAL_REASONS.map((reason) => [reason, 0]));
}

/*
 * ===========================================================================
 * Bridge harness
 * ===========================================================================
 */

interface Harness {
  readonly bridge: ContentBridge;
  readonly runtime: FakeRuntime;
  readonly page: FakeWindow;
  readonly agent: FakeAgent;
  readonly timers: FakeScheduler;
}

interface HarnessOptions extends FakeRuntimeOptions, FakeAgentOptions {
  /** The jitter source; `() => 0` (no jitter) unless a case says otherwise. */
  readonly random?: () => number;
  /**
   * The event-rate budget's clock; the faked `Date.now` unless a case holds
   * its own, so the budget can stand still while reconnect timers run.
   */
  readonly monotonicNow?: () => number;
}

/** Every harness a case created, stopped and checked for leaks in `afterEach`. */
const liveHarnesses: Harness[] = [];

function createHarness(options: HarnessOptions = {}): Harness {
  const runtime = createFakeRuntime(options);
  const page = createFakeWindow();
  // Declaration order: the MAIN-world agent is evaluated before the bridge.
  const agent = installFakeAgent(page, options);
  const timers = createScheduler();
  const bridge = createContentBridge({
    chrome: runtime,
    window: page,
    setTimeout: timers.schedule,
    clearTimeout: timers.cancel,
    random: options.random ?? ((): number => 0),
    now: (): number => Date.now(),
    monotonicNow: options.monotonicNow ?? ((): number => Date.now()),
  });
  const harness: Harness = { bridge, runtime, page, agent, timers };
  liveHarnesses.push(harness);
  return harness;
}

/** A harness whose bridge has been started (node held, listeners attached, port open). */
function startedHarness(options: HarnessOptions = {}): Harness {
  const harness = createHarness(options);
  harness.bridge.start();
  return harness;
}

/*
 * ===========================================================================
 * The refusal matrix — one or more details per refusal reason
 *
 * Keyed by `BridgeRefusalReason`, so a reason added to the exported tuple
 * without a case here fails `tsc -b`, and the completeness case below fails
 * `vitest`. Every variant fails exactly the named check: all earlier checks
 * pass. The context each variant is judged in defaults to a pinned document.
 * ===========================================================================
 */

/** The counts a `rate-limited` verdict carries beside its reason, and the loss's capture. */
interface RateLimitedLoss {
  readonly events: number;
  readonly droppedCount: number;
  readonly captureId: string | undefined;
}

interface RefusalVariant {
  readonly label: string;
  readonly detail: () => unknown;
  readonly context?: AgentFrameContext;
  /** For `rate-limited` only: the loss the verdict must report. */
  readonly loss?: RateLimitedLoss;
}

/** A pinned document with `availableEvents` left in its budget. */
function budgetContext(availableEvents: number): AgentFrameContext {
  return { provenance: PINNED, budget: { availableEvents } };
}

/** A context whose last relayed batch was number 3 of {@link CAPTURE_ID}. */
const AFTER_BATCH_3: AgentFrameContext = {
  provenance: PINNED,
  sequence: { captureId: CAPTURE_ID, batchSeq: 3 },
};

const REFUSAL_CASES: { readonly [Reason in BridgeRefusalReason]: readonly RefusalVariant[] } = {
  'not-string': [
    {
      label: 'a structured frame object (what window.postMessage carried)',
      detail: () => batchFrame(),
    },
    { label: 'no detail at all', detail: () => undefined },
    { label: 'a number', detail: () => 42 },
  ],
  oversize: [
    {
      label: 'one code unit over the cap',
      detail: () => paddedErrorDetail(MAX_PAGE_FRAME_LENGTH + 1),
    },
    {
      label: 'an over-cap string that is not even JSON',
      detail: () => '{'.repeat(MAX_PAGE_FRAME_LENGTH + 1),
    },
  ],
  unparseable: [
    { label: 'truncated JSON', detail: () => detailOf(batchFrame()).slice(0, -1) },
    { label: 'plain text', detail: () => 'agent.ready' },
  ],
  'not-object': [
    { label: 'null', detail: () => 'null' },
    { label: 'an array', detail: () => detailOf([batchFrame()]) },
    { label: 'a string', detail: () => detailOf('telemetry.batch') },
  ],
  'wrong-tag': [
    {
      label: "the bridge's own tag",
      detail: () => detailOf(withFields(batchFrame(), { source: BRIDGE_SOURCE_TAG })),
    },
    {
      label: 'a foreign tag',
      detail: () => detailOf(withFields(batchFrame(), { source: 'another-tool' })),
    },
    { label: 'no tag', detail: () => detailOf(withoutField(batchFrame(), 'source')) },
  ],
  'version-mismatch': [
    {
      label: 'the token-era version 2',
      detail: () => detailOf(withFields(batchFrame(), { version: 2 })),
    },
    {
      label: 'the version as a string',
      detail: () => detailOf(withFields(batchFrame(), { version: '3' })),
    },
    { label: 'no version', detail: () => detailOf(withoutField(batchFrame(), 'version')) },
  ],
  'unknown-type': [
    {
      label: 'a bridge frame type sent upward',
      detail: () => detailOf(withFields(batchFrame(), { type: 'agent.config' })),
    },
    {
      label: 'a protocol envelope type',
      detail: () => detailOf(withFields(batchFrame(), { type: 'telemetry.event' })),
    },
    { label: 'no type', detail: () => detailOf(withoutField(batchFrame(), 'type')) },
  ],
  'malformed-payload': [
    {
      label: 'agent.ready with a non-canonical documentId',
      detail: () => detailOf(readyFrame(readyPayload({ documentId: PRIVATE_SENTINEL }))),
    },
    {
      label: 'agent.ready with a non-canonical producerId',
      detail: () => detailOf(readyFrame(readyPayload({ producerId: 'producer-0001' }))),
    },
    {
      label: 'telemetry.batch with a non-canonical producerId',
      detail: () => detailOf(batchFrame(batchPayload({ producerId: PRIVATE_SENTINEL }))),
    },
    {
      label: 'telemetry.batch with a non-canonical captureId',
      detail: () => detailOf(batchFrame(batchPayload({ captureId: 'capture-0001' }))),
    },
    {
      label: 'telemetry.batch with a non-canonical sessionId',
      detail: () => detailOf(batchFrame(batchPayload({ sessionId: PRIVATE_SENTINEL }))),
    },
    {
      label: 'agent.error with a private code and message',
      detail: () => detailOf(errorFrame({ code: PRIVATE_SENTINEL, message: PRIVATE_SENTINEL })),
    },
    {
      label: 'a code-less agent.error with an unknown loss reason',
      detail: () => detailOf(errorFrame({ reason: PRIVATE_SENTINEL })),
    },
    {
      label: 'an agent.error with neither code nor reason',
      detail: () => detailOf(errorFrame({ message: PRIVATE_SENTINEL })),
    },
    {
      label: 'a known code with a non-string message',
      detail: () =>
        detailOf(withFields(errorFrame(), { payload: { code: 'producer-failure', message: 7 } })),
    },
    {
      label: 'a payload that is an array',
      detail: () => detailOf(withFields(batchFrame(), { payload: [] })),
    },
  ],
  'provenance-unknown': [
    {
      label: 'a batch before any agent.ready pinned the document',
      detail: () => detailOf(batchFrame()),
      context: {},
    },
  ],
  'provenance-mismatch': [
    {
      label: 'an agent.ready naming another document',
      detail: () => detailOf(readyFrame(readyPayload({ documentId: FORGED_DOCUMENT_ID }))),
    },
    {
      label: 'an agent.ready naming another producer',
      detail: () => detailOf(readyFrame(readyPayload({ producerId: FORGED_PRODUCER_ID }))),
    },
    {
      label: 'a batch naming another document',
      detail: () => detailOf(batchFrame(batchPayload({ documentId: FORGED_DOCUMENT_ID }))),
    },
    {
      label: 'a batch naming another producer',
      detail: () =>
        detailOf(
          batchFrame(
            batchPayload({
              producerId: FORGED_PRODUCER_ID,
              events: [interactionEvent(FORGED_PRODUCER_ID)],
            }),
          ),
        ),
    },
    {
      label: "a batch whose event carries another producer's id",
      detail: () =>
        detailOf(
          batchFrame(
            batchPayload({ events: [interactionEvent(), fetchEvent(FORGED_PRODUCER_ID)] }),
          ),
        ),
    },
  ],
  'sequence-regression': [
    {
      label: 'the last relayed batchSeq again',
      detail: () => detailOf(batchFrame(batchPayload({ batchSeq: 3 }))),
      context: AFTER_BATCH_3,
    },
    {
      label: 'an earlier batchSeq of the same capture',
      detail: () => detailOf(batchFrame(batchPayload({ batchSeq: 1 }))),
      context: AFTER_BATCH_3,
    },
    {
      label: 'a repeated batchSeq with no capture on either batch',
      detail: () => detailOf(uncapturedBatchFrame(0)),
      context: { provenance: PINNED, sequence: { captureId: undefined, batchSeq: 0 } },
    },
  ],
  'rate-limited': [
    {
      label: 'a two-event batch with one event of budget left',
      detail: () => detailOf(batchFrame()),
      context: budgetContext(1.999),
      loss: { events: 2, droppedCount: 0, captureId: CAPTURE_ID },
    },
    {
      label: "a batch against an empty budget, carrying the agent's own loss",
      detail: () => detailOf(batchFrame(batchPayload({ droppedCount: 7 }))),
      context: budgetContext(0),
      loss: { events: 2, droppedCount: 7, captureId: CAPTURE_ID },
    },
    {
      label:
        'a batch of another capture than the last relayed one, which its loss is labelled with',
      detail: () => detailOf(batchFrame(batchPayload({ captureId: OTHER_CAPTURE_ID }))),
      context: { ...AFTER_BATCH_3, budget: { availableEvents: 0 } },
      loss: { events: 2, droppedCount: 0, captureId: OTHER_CAPTURE_ID },
    },
    {
      // Element-level validation is the worker's, so minimal event records
      // pass the bridge's shape check: one frame within the size cap can carry
      // more events than the whole capacity, and never fits a full budget.
      label: 'one in-cap frame of minimal events larger than the whole capacity',
      detail: () =>
        detailOf(
          withFields(batchFrame(), {
            payload: withFields(batchPayload(), {
              events: Array.from({ length: BRIDGE_EVENT_BUDGET_CAPACITY + 1 }, () => ({
                producerId: PRODUCER_ID,
              })),
            }),
          }),
        ),
      context: budgetContext(BRIDGE_EVENT_BUDGET_CAPACITY),
      loss: { events: BRIDGE_EVENT_BUDGET_CAPACITY + 1, droppedCount: 0, captureId: CAPTURE_ID },
    },
    {
      label: 'a batch against a non-finite budget level, which refuses rather than admits',
      detail: () => detailOf(batchFrame()),
      context: budgetContext(Number.NaN),
      loss: { events: 2, droppedCount: 0, captureId: CAPTURE_ID },
    },
  ],
};

const REFUSAL_ROWS = BRIDGE_REFUSAL_REASONS.flatMap((reason) =>
  REFUSAL_CASES[reason].map((variant) => ({ reason, label: variant.label, variant })),
);

/** The reasons a bridge with no pinned document can be driven into by the agent alone. */
const STATELESS_REASONS: readonly BridgeRefusalReason[] = [
  'not-string',
  'oversize',
  'unparseable',
  'not-object',
  'wrong-tag',
  'version-mismatch',
  'unknown-type',
  'malformed-payload',
];

interface PrecedenceRow {
  readonly expected: BridgeRefusalReason;
  readonly detail: unknown;
  readonly context: AgentFrameContext;
  /** For `rate-limited` only: the loss the verdict must report. */
  readonly loss?: RateLimitedLoss;
}

/**
 * An exhausted budget. Every precedence row is judged against it, so each row
 * also fails the rate check, which runs last: a malformed, forged or
 * regressed batch is reported for what it is, never as `rate-limited`.
 */
const EMPTY_BUDGET: AgentFrameContext['budget'] = { availableEvents: 0 };

/**
 * One detail per reason that fails that check **and** later ones, proving the
 * checks run in the exported order and stop at the first failure.
 */
const PRECEDENCE_ROWS: readonly PrecedenceRow[] = [
  { expected: 'not-string', detail: batchFrame(), context: { budget: EMPTY_BUDGET } },
  // Over a tiny injected cap *and* not JSON.
  { expected: 'oversize', detail: '{{{{{', context: { maxLength: 4, budget: EMPTY_BUDGET } },
  // Not JSON, and not an object either.
  { expected: 'unparseable', detail: '[', context: { budget: EMPTY_BUDGET } },
  // Not an object, and carries no tag.
  { expected: 'not-object', detail: '[1]', context: { budget: EMPTY_BUDGET } },
  // Wrong tag, wrong version and unknown type.
  {
    expected: 'wrong-tag',
    detail: detailOf({ source: 'x', version: 99, type: 'nope' }),
    context: { budget: EMPTY_BUDGET },
  },
  // Wrong version and unknown type.
  {
    expected: 'version-mismatch',
    detail: detailOf({ source: AGENT_SOURCE_TAG, version: 99, type: 'nope' }),
    context: { budget: EMPTY_BUDGET },
  },
  // Unknown type and a malformed payload.
  {
    expected: 'unknown-type',
    detail: detailOf({
      source: AGENT_SOURCE_TAG,
      version: PAGE_CHANNEL_VERSION,
      type: 'nope',
      payload: 'x',
    }),
    context: { budget: EMPTY_BUDGET },
  },
  // Malformed, no document is pinned either, and over budget.
  {
    expected: 'malformed-payload',
    detail: detailOf(batchFrame(batchPayload({ producerId: 'x' }))),
    context: { budget: EMPTY_BUDGET },
  },
  // Nothing pinned, its batchSeq would also regress, and over budget.
  {
    expected: 'provenance-unknown',
    detail: detailOf(batchFrame(batchPayload({ batchSeq: 0 }))),
    context: { sequence: { captureId: CAPTURE_ID, batchSeq: 3 }, budget: EMPTY_BUDGET },
  },
  // Another document, its batchSeq would also regress, and over budget.
  {
    expected: 'provenance-mismatch',
    detail: detailOf(batchFrame(batchPayload({ documentId: FORGED_DOCUMENT_ID, batchSeq: 0 }))),
    context: { ...AFTER_BATCH_3, budget: EMPTY_BUDGET },
  },
  // A regressed batchSeq, and over budget.
  {
    expected: 'sequence-regression',
    detail: detailOf(batchFrame(batchPayload({ batchSeq: 2 }))),
    context: { ...AFTER_BATCH_3, budget: EMPTY_BUDGET },
  },
  // Well-formed, the pinned document, a later batchSeq — only over budget.
  {
    expected: 'rate-limited',
    detail: detailOf(batchFrame(batchPayload({ batchSeq: 4 }))),
    context: { ...AFTER_BATCH_3, budget: EMPTY_BUDGET },
    loss: { events: 2, droppedCount: 0, captureId: CAPTURE_ID },
  },
];

/*
 * ===========================================================================
 * The spec
 * ===========================================================================
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('page-channel mirror contract', () => {
  it('keeps the literals the page agent transport publishes (version 3)', () => {
    // `../src/shared/messages.ts` mirrors `packages/telemetry/src/browser/transport.ts`
    // and names this spec as the check that the copy still matches the owner.
    expect(AGENT_SOURCE_TAG).toBe('debuggen-agent');
    expect(BRIDGE_SOURCE_TAG).toBe('debuggen-bridge');
    expect(PAGE_CHANNEL_VERSION).toBe(3);
    expect(PAGE_HANDSHAKE_REQUEST_EVENT).toBe('debuggen-bridge-handshake');
    expect(PAGE_HANDSHAKE_OFFER_EVENT).toBe('debuggen-agent-handshake');
    expect(PAGE_AGENT_FRAME_EVENT).toBe('debuggen-agent-frame');
    expect(PAGE_BRIDGE_FRAME_EVENT).toBe('debuggen-bridge-frame');
    expect(MAX_PAGE_FRAME_LENGTH).toBe(524_288);
    expect(AGENT_OUTBOUND_TYPES).toEqual([
      'agent.ready',
      'telemetry.batch',
      'target.described',
      'agent.error',
    ]);
    expect(BRIDGE_OUTBOUND_TYPES).toEqual([
      'bridge.ready',
      'bridge.gone',
      'agent.config',
      'agent.snapshot',
      'target.request',
    ]);
    expect(PORT_CONTENT_BRIDGE).toBe('debuggen.bridge');
  });

  it('keeps the two tags and the four event names apart', () => {
    expect(AGENT_SOURCE_TAG).not.toBe(BRIDGE_SOURCE_TAG);
    const events = [
      PAGE_HANDSHAKE_REQUEST_EVENT,
      PAGE_HANDSHAKE_OFFER_EVENT,
      PAGE_AGENT_FRAME_EVENT,
      PAGE_BRIDGE_FRAME_EVENT,
    ];
    expect(new Set(events).size).toBe(events.length);
  });

  it('publishes no token and no window.postMessage target any more', async () => {
    const contract: Record<string, unknown> = { ...(await import('../src/shared/messages')) };
    for (const removed of [
      'PAGE_MESSAGE_TARGET_ORIGIN',
      'PAGE_HANDSHAKE_TOKEN_LENGTH',
      'isPageHandshakeToken',
      'approximatePageMessageBytes',
      'exceedsPageMessageByteCap',
      'MAX_PAGE_MESSAGE_BYTES',
    ]) {
      expect(contract, removed).not.toHaveProperty(removed);
    }
    // The frame type itself has no `token` field: a complete bridge frame is these four keys.
    const frame: BridgeChannelMessage<'bridge.ready'> = {
      source: BRIDGE_SOURCE_TAG,
      version: PAGE_CHANNEL_VERSION,
      type: 'bridge.ready',
      payload: {},
    };
    expect(Object.keys(frame).sort()).toEqual(BRIDGE_FRAME_KEYS);
  });

  it("measures a frame in the agent's unit: the detail string's code units", () => {
    const detail = detailOf(readyFrame());
    expect(pageFrameLength(detail)).toBe(detail.length);
    expect(pageFrameLength(readyFrame())).toBe(Number.POSITIVE_INFINITY);
    expect(pageFrameLength(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(exceedsPageFrameCap('x'.repeat(MAX_PAGE_FRAME_LENGTH))).toBe(false);
    expect(exceedsPageFrameCap('x'.repeat(MAX_PAGE_FRAME_LENGTH + 1))).toBe(true);
    expect(exceedsPageFrameCap(detail, detail.length)).toBe(false);
    expect(exceedsPageFrameCap(detail, detail.length - 1)).toBe(true);
    expect(exceedsPageFrameCap(42)).toBe(true);
  });

  it('renders a frame as its JSON text, and refuses what cannot travel', () => {
    const frame: BridgeChannelMessage = {
      source: BRIDGE_SOURCE_TAG,
      version: PAGE_CHANNEL_VERSION,
      type: 'agent.config',
      payload: configPayload(),
    };
    const rendered = renderPageFrame(frame);
    expect(rendered).toBe(JSON.stringify(frame));
    expect(renderPageFrame(frame, (rendered ?? '').length)).toBe(rendered);
    expect(renderPageFrame(frame, (rendered ?? '').length - 1)).toBeUndefined();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const unrenderable: BridgeChannelMessage = {
      source: BRIDGE_SOURCE_TAG,
      version: PAGE_CHANNEL_VERSION,
      type: 'agent.snapshot',
      payload: { ...cyclic },
    };
    expect(renderPageFrame(unrenderable)).toBeUndefined();
  });
});

describe('isChannelNodeCandidate — what the handshake may hand over', () => {
  it('accepts a detached element and a plain event target', () => {
    expect(isChannelNodeCandidate(document.createElement('div'))).toBe(true);
    expect(isChannelNodeCandidate(new EventTarget())).toBe(true);
  });

  it('refuses a node connected to the document, which any page script can query', () => {
    const connected = document.createElement('div');
    document.body.append(connected);
    try {
      expect(connected.isConnected).toBe(true);
      expect(isChannelNodeCandidate(connected)).toBe(false);
      expect(isChannelNodeCandidate(document)).toBe(false);
    } finally {
      connected.remove();
    }
  });

  it('refuses anything that is not an event target', () => {
    for (const value of [
      undefined,
      null,
      'node',
      42,
      {},
      { addEventListener: 1 },
      [document.createElement('div')],
    ]) {
      expect(isChannelNodeCandidate(value)).toBe(false);
    }
  });
});

describe('shouldAcceptAgentFrame — the pure agent → bridge filter', () => {
  it('covers every exported refusal reason, provenance and rate included', () => {
    expect(Object.keys(REFUSAL_CASES).sort()).toEqual([...BRIDGE_REFUSAL_REASONS].sort());
    for (const reason of BRIDGE_REFUSAL_REASONS) {
      expect(REFUSAL_CASES[reason].length).toBeGreaterThan(0);
    }
    expect(BRIDGE_REFUSAL_REASONS).toEqual(
      expect.arrayContaining(['provenance-unknown', 'provenance-mismatch', 'sequence-regression']),
    );
    // The rate check runs after every structural and provenance check.
    expect(BRIDGE_REFUSAL_REASONS.at(-1)).toBe('rate-limited');
  });

  it.each(AGENT_OUTBOUND_TYPES)('accepts a well-formed %s frame as a fresh parsed copy', (type) => {
    const frame = agentFrames()[type];
    const decision = shouldAcceptAgentFrame(detailOf(frame), { provenance: PINNED });
    expect(decision.accepted).toBe(true);
    if (!decision.accepted) {
      throw new Error(`refused as ${decision.reason}`);
    }
    expect(decision.message).toEqual(frame);
    expect(decision.message).not.toBe(frame);
  });

  it('accepts the first agent.ready with nothing pinned — that is what pins the document', () => {
    expect(shouldAcceptAgentFrame(detailOf(readyFrame()))).toEqual({
      accepted: true,
      message: readyFrame(),
    });
  });

  it.each(PAGE_AGENT_ERROR_CODES)('accepts an agent.error with the known code %s', (code) => {
    expect(shouldAcceptAgentFrame(detailOf(errorFrame({ code }))).accepted).toBe(true);
  });

  it.each(PAGE_AGENT_LOSS_REASONS)(
    'accepts a code-less agent.error with the loss reason %s',
    (reason) => {
      expect(shouldAcceptAgentFrame(detailOf(errorFrame({ reason, limitBytes: 1 }))).accepted).toBe(
        true,
      );
    },
  );

  it.each([
    [
      'hooks-unavailable',
      {
        code: 'hooks-unavailable',
        message: 'the page agent could not enable: perf',
        sessionId: SESSION_ID,
        captureId: CAPTURE_ID,
        unavailable: [{ signal: 'perf', reason: 'unsupported' }],
        enabled: ['interactions', 'fetch'],
      },
    ],
    [
      'producer-failure outside a capture',
      {
        code: 'producer-failure',
        message: "the page agent's react producer failed at commit",
        sessionId: null,
        captureId: null,
        source: 'react',
        stage: 'commit',
        error: 'TypeError',
        occurrence: 1,
      },
    ],
    [
      'event-too-large',
      {
        reason: 'event-too-large',
        eventId: 'event-0001',
        kind: 'fetch',
        limitBytes: MAX_PAGE_FRAME_LENGTH,
      },
    ],
  ])("accepts the agent's own %s diagnostic shape", (_label, payload) => {
    expect(
      shouldAcceptAgentFrame(detailOf(withFields(errorFrame(), { payload })), {
        provenance: PINNED,
      }).accepted,
    ).toBe(true);
  });

  it.each(REFUSAL_ROWS)('refuses $reason: $label', ({ reason, variant }) => {
    // Exact: a plain refusal carries its reason alone, a rate-limited one its loss too.
    expect(reason === 'rate-limited').toBe(variant.loss !== undefined);
    expect(
      shouldAcceptAgentFrame(variant.detail(), variant.context ?? { provenance: PINNED }),
    ).toEqual({
      accepted: false,
      reason,
      ...variant.loss,
    });
  });

  it('reports the first failing check, in the order the exported tuple lists them', () => {
    expect(PRECEDENCE_ROWS.map((row) => row.expected)).toEqual([...BRIDGE_REFUSAL_REASONS]);
    for (const row of PRECEDENCE_ROWS) {
      expect(shouldAcceptAgentFrame(row.detail, row.context)).toEqual({
        accepted: false,
        reason: row.expected,
        ...row.loss,
      });
    }
  });

  it('meters only telemetry batches, by their events, and admits one that exactly fits', () => {
    // Control traffic passes an empty budget: only batches carry page-driven volume.
    for (const type of AGENT_OUTBOUND_TYPES.filter((each) => each !== 'telemetry.batch')) {
      expect(shouldAcceptAgentFrame(detailOf(agentFrames()[type]), budgetContext(0)).accepted).toBe(
        true,
      );
    }
    // The fixture batch carries two events.
    expect(shouldAcceptAgentFrame(detailOf(batchFrame()), budgetContext(2)).accepted).toBe(true);
    expect(shouldAcceptAgentFrame(detailOf(batchFrame()), budgetContext(1.999)).accepted).toBe(
      false,
    );
    // An empty batch fits even an empty budget.
    expect(shouldAcceptAgentFrame(detailOf(sizedBatchFrame(0, 0)), budgetContext(0)).accepted).toBe(
      true,
    );
    // Without a budget in the context, nothing is metered.
    expect(
      shouldAcceptAgentFrame(detailOf(sizedBatchFrame(AGENT_BATCH_EVENTS, 0)), {
        provenance: PINNED,
      }).accepted,
    ).toBe(true);
  });

  it('starts the sequence afresh whenever the capture changes', () => {
    const next = (payload: PageTelemetryBatchPayload): boolean =>
      shouldAcceptAgentFrame(detailOf(batchFrame(payload)), AFTER_BATCH_3).accepted;
    // A strictly later batch of the same capture.
    expect(next(batchPayload({ batchSeq: 4 }))).toBe(true);
    // The agent restarts batchSeq at 0 for a new capture.
    expect(next(batchPayload({ captureId: OTHER_CAPTURE_ID, batchSeq: 0 }))).toBe(true);
    // A batch outside any capture is a different sequence too.
    expect(shouldAcceptAgentFrame(detailOf(uncapturedBatchFrame(0)), AFTER_BATCH_3).accepted).toBe(
      true,
    );
  });

  it("measures the cap in the agent's own unit and accepts a frame exactly at it", () => {
    const atCap = paddedErrorDetail(MAX_PAGE_FRAME_LENGTH);
    const overCap = paddedErrorDetail(MAX_PAGE_FRAME_LENGTH + 1);
    expect(atCap).toHaveLength(MAX_PAGE_FRAME_LENGTH);
    expect(overCap).toHaveLength(MAX_PAGE_FRAME_LENGTH + 1);
    expect(shouldAcceptAgentFrame(atCap).accepted).toBe(true);
    expect(shouldAcceptAgentFrame(overCap)).toEqual({ accepted: false, reason: 'oversize' });
  });

  it('counts code units, not UTF-8 bytes, so non-ASCII text at the cap is not refused', () => {
    const atCap = paddedErrorDetail(MAX_PAGE_FRAME_LENGTH, '€');
    expect(atCap).toHaveLength(MAX_PAGE_FRAME_LENGTH);
    expect(new TextEncoder().encode(atCap).length).toBeGreaterThan(MAX_PAGE_FRAME_LENGTH);
    expect(shouldAcceptAgentFrame(atCap).accepted).toBe(true);
  });

  it('honours a smaller injected cap at its exact boundary', () => {
    const detail = detailOf(readyFrame());
    expect(shouldAcceptAgentFrame(detail, { maxLength: detail.length }).accepted).toBe(true);
    expect(shouldAcceptAgentFrame(detail, { maxLength: detail.length - 1 })).toEqual({
      accepted: false,
      reason: 'oversize',
    });
  });

  it('is pure: it never mutates its context and never touches the DOM', () => {
    const context: AgentFrameContext = Object.freeze({
      provenance: Object.freeze({ ...PINNED }),
      sequence: Object.freeze({ captureId: CAPTURE_ID, batchSeq: 3 }),
      budget: Object.freeze({ availableEvents: 1 }),
    });
    const dispatch = vi.spyOn(EventTarget.prototype, 'dispatchEvent');
    const listen = vi.spyOn(EventTarget.prototype, 'addEventListener');
    for (const { variant } of REFUSAL_ROWS) {
      shouldAcceptAgentFrame(variant.detail(), context);
    }
    shouldAcceptAgentFrame(detailOf(batchFrame(batchPayload({ batchSeq: 4 }))), context);
    shouldAcceptAgentFrame(detailOf(sizedBatchFrame(1, 4)), context);
    expect(context).toEqual({
      provenance: PINNED,
      sequence: { captureId: CAPTURE_ID, batchSeq: 3 },
      budget: { availableEvents: 1 },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
});

describe('the event-rate budget — pure token-bucket arithmetic', () => {
  it('pins the documented policy: two agent buffers of burst, ten times the demo rate', () => {
    // Two full agent buffers (MAX_BUFFERED_EVENTS = 5 000 in the transport).
    expect(BRIDGE_EVENT_BUDGET_CAPACITY).toBe(10_000);
    // Ten times the demo's ~200 render events per second.
    expect(BRIDGE_EVENT_BUDGET_REFILL_PER_SECOND).toBe(2_000);
    expect(BRIDGE_EVENT_BUDGET_CAPACITY % AGENT_BATCH_EVENTS).toBe(0);
  });

  it('starts full and unanchored', () => {
    expect(fullEventBudget()).toEqual({
      availableEvents: BRIDGE_EVENT_BUDGET_CAPACITY,
      measuredAt: undefined,
    });
  });

  it('anchors on the first reading without earning, then earns at the refill rate', () => {
    const anchored = refillEventBudget({ availableEvents: 0, measuredAt: undefined }, 5_000);
    expect(anchored).toEqual({ availableEvents: 0, measuredAt: 5_000 });
    expect(refillEventBudget(anchored, 5_000 + msToEarn(AGENT_BATCH_EVENTS))).toEqual({
      availableEvents: AGENT_BATCH_EVENTS,
      measuredAt: 5_000 + msToEarn(AGENT_BATCH_EVENTS),
    });
    // A quarter of a millisecond earns half an event: the level is fractional.
    expect(refillEventBudget(anchored, 5_000.25).availableEvents).toBeCloseTo(0.5, 10);
  });

  it('never refills beyond the capacity', () => {
    const half: EventBudget = { availableEvents: BRIDGE_EVENT_BUDGET_CAPACITY / 2, measuredAt: 0 };
    expect(refillEventBudget(half, 3_600_000).availableEvents).toBe(BRIDGE_EVENT_BUDGET_CAPACITY);
  });

  it('earns nothing for a backward step and re-anchors there, so the refill resumes', () => {
    const budget: EventBudget = { availableEvents: 100, measuredAt: 10_000 };
    const stepped = refillEventBudget(budget, 2_000);
    expect(stepped).toEqual({ availableEvents: 100, measuredAt: 2_000 });
    expect(refillEventBudget(stepped, 2_000 + msToEarn(50)).availableEvents).toBe(150);
  });

  it('earns nothing and keeps the anchor for a non-finite reading', () => {
    const budget: EventBudget = { availableEvents: 100, measuredAt: 10_000 };
    for (const reading of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(refillEventBudget(budget, reading)).toEqual(budget);
    }
  });

  it('spends whole batches, never below zero, and ignores a degenerate count', () => {
    const budget: EventBudget = { availableEvents: 250, measuredAt: 7 };
    expect(consumeEventBudget(budget, AGENT_BATCH_EVENTS)).toEqual({
      availableEvents: 50,
      measuredAt: 7,
    });
    expect(consumeEventBudget(budget, 1_000).availableEvents).toBe(0);
    for (const count of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(consumeEventBudget(budget, count)).toEqual(budget);
    }
  });

  it('treats a corrupt level as empty and never mutates its input', () => {
    expect(
      refillEventBudget({ availableEvents: Number.NaN, measuredAt: 0 }, 0).availableEvents,
    ).toBe(0);
    expect(
      consumeEventBudget({ availableEvents: Number.NaN, measuredAt: 0 }, 0).availableEvents,
    ).toBe(0);
    const frozen: EventBudget = Object.freeze({ availableEvents: 10, measuredAt: 0 });
    refillEventBudget(frozen, 1_000);
    consumeEventBudget(frozen, 5);
    expect(frozen).toEqual({ availableEvents: 10, measuredAt: 0 });
  });
});

describe('computeReconnectDelay — the pure backoff policy', () => {
  /** The un-jittered ceiling for `attempt`, from the exported constants alone. */
  function ceilingFor(attempt: number): number {
    return Math.min(BRIDGE_RECONNECT_MAX_MS, BRIDGE_RECONNECT_BASE_MS * 2 ** attempt);
  }

  it('starts at the base, doubles, and clamps at the maximum', () => {
    const delays = Array.from({ length: 24 }, (_, attempt) =>
      computeReconnectDelay(attempt, () => 0),
    );
    expect(delays[0]).toBe(BRIDGE_RECONNECT_BASE_MS);
    expect(delays).toEqual(delays.map((_, attempt) => ceilingFor(attempt)));
    expect(delays.at(-1)).toBe(BRIDGE_RECONNECT_MAX_MS);
    for (const [index, delay] of delays.entries()) {
      expect(delay).toBeLessThanOrEqual(BRIDGE_RECONNECT_MAX_MS);
      expect(delay).toBeGreaterThanOrEqual(delays[index - 1] ?? 0);
    }
  });

  it('removes at most the jitter fraction and never exceeds the maximum', () => {
    for (const draw of [0, 0.25, 0.5, 0.999_999, 1]) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const ceiling = ceilingFor(attempt);
        const delay = computeReconnectDelay(attempt, () => draw);
        expect(delay).toBeLessThanOrEqual(ceiling);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(ceiling * (1 - BRIDGE_RECONNECT_JITTER)));
        expect(Number.isInteger(delay)).toBe(true);
      }
    }
  });

  it('treats degenerate attempts as the first and clamps out-of-range draws', () => {
    for (const attempt of [Number.NaN, -3, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(computeReconnectDelay(attempt, () => 0)).toBe(BRIDGE_RECONNECT_BASE_MS);
    }
    expect(computeReconnectDelay(0, () => Number.NaN)).toBe(BRIDGE_RECONNECT_BASE_MS);
    expect(computeReconnectDelay(0, () => -2)).toBe(BRIDGE_RECONNECT_BASE_MS);
    expect(computeReconnectDelay(0, () => 7)).toBe(
      Math.round(BRIDGE_RECONNECT_BASE_MS * (1 - BRIDGE_RECONNECT_JITTER)),
    );
    expect(computeReconnectDelay(1_000, () => 0)).toBe(BRIDGE_RECONNECT_MAX_MS);
  });
});

describe('dormancy — importing the module', () => {
  it('attaches no listener, dispatches nothing and opens no port outside an extension', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const postSpy = vi.spyOn(window, 'postMessage');

    vi.resetModules();
    const fresh = await import('../src/content/bridge');

    expect(fresh.isContentScriptEnvironment()).toBe(false);
    expect(fresh.bootstrapContentBridge()).toBeUndefined();
    expect(addSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('bootstraps exactly one bridge, and only when a live extension runtime exists', async () => {
    const runtime = createFakeRuntime();
    vi.stubGlobal('chrome', { runtime });
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const postSpy = vi.spyOn(window, 'postMessage');

    vi.resetModules();
    const fresh = await import('../src/content/bridge');

    // The module's one guarded import-time call started the bridge.
    expect(fresh.isContentScriptEnvironment()).toBe(true);
    expect(runtime.connectSpy).toHaveBeenCalledTimes(1);
    expect(runtime.connectSpy).toHaveBeenCalledWith({ name: PORT_CONTENT_BRIDGE });
    const types = addSpy.mock.calls.map(([type]) => type);
    expect(types).toEqual(expect.arrayContaining(['pageshow', PAGE_HANDSHAKE_OFFER_EVENT]));
    // Version 3 never listens for, or posts, window messages.
    expect(types).not.toContain('message');
    expect(postSpy).not.toHaveBeenCalled();

    // A second call returns the same bridge rather than starting another.
    const bridge = fresh.bootstrapContentBridge();
    expect(bridge).toBeDefined();
    expect(fresh.bootstrapContentBridge()).toBe(bridge);
    expect(runtime.connectSpy).toHaveBeenCalledTimes(1);
    expect(bridge?.isConnected()).toBe(true);

    bridge?.stop();
    expect(bridge?.isConnected()).toBe(false);
    expect(runtime.latestPort().close).toHaveBeenCalledTimes(1);
    for (const [type, listener] of addSpy.mock.calls) {
      expect(removeSpy).toHaveBeenCalledWith(type, listener);
    }
  });
});

describe('createContentBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    // Every bridge a case created must stop cleanly and leave nothing behind.
    for (const { bridge, page, agent, runtime, timers } of liveHarnesses.splice(0)) {
      // A throw inside the fake agent's listeners would otherwise be absorbed
      // by the bridge's defensive dispatch catch and pass unnoticed.
      expect(agent.listenerErrors).toEqual([]);
      bridge.stop();
      expect(bridge.isConnected()).toBe(false);
      expect(page.listenerCount()).toBe(0);
      expect(agent.bridgeListenerCount()).toBe(0);
      expect(timers.pending()).toBe(0);
      for (const port of runtime.ports) {
        expect(port.onMessage.listeners.size).toBe(0);
        expect(port.onDisconnect.listeners.size).toBe(0);
      }
    }
  });

  describe('dormancy until start()', () => {
    it('constructing the bridge attaches, dispatches, connects and schedules nothing', () => {
      const { bridge, runtime, page, agent, timers } = createHarness();

      expect(page.addSpy).not.toHaveBeenCalled();
      expect(page.dispatchSpy).not.toHaveBeenCalled();
      expect(agent.answered()).toBe(false);
      expect(agent.bridgeListenerCount()).toBe(0);
      expect(runtime.connectSpy).not.toHaveBeenCalled();
      expect(timers.schedule).not.toHaveBeenCalled();
      expect(bridge.isConnected()).toBe(false);

      // Typed against `BridgeStats`, so a counter added to the shape must be added here.
      const { refused, ...counters } = bridge.getStats();
      const expectedCounters: Omit<BridgeStats, 'refused'> = {
        connected: false,
        handshakeComplete: false,
        terminated: false,
        relayed: 0,
        reannounced: 0,
        unclaimed: 0,
        forwardedDown: 0,
        acknowledgedDown: 0,
        reconnects: 0,
        offersRejected: 0,
        droppedDownUnrecognised: 0,
        droppedDownNoChannel: 0,
        droppedDownUnrenderable: 0,
        disconnectErrors: 0,
        faults: 0,
        rateLimitedEvents: 0,
        pendingDroppedCount: 0,
        lossReports: 0,
        agentLossReportsHeld: 0,
        abandonedLossEvents: 0,
        budgetAvailableEvents: BRIDGE_EVENT_BUDGET_CAPACITY,
      };
      expect(counters).toEqual(expectedCounters);
      expect(refused).toEqual(zeroRefusals());
    });

    it('agent frames before start() reach no listener and are not claimed', () => {
      const { bridge, runtime, agent } = createHarness();
      expect(agent.send(readyFrame())).toBe(false);
      expect(runtime.connectSpy).not.toHaveBeenCalled();
      expect(bridge.getStats()).toMatchObject({ relayed: 0, unclaimed: 0 });
    });
  });

  describe('start() and the handshake', () => {
    it('asks once, keeps the node, listens only on it, connects and sends bridge.ready there', () => {
      const { bridge, runtime, page, agent } = startedHarness();

      expect(agent.answered()).toBe(true);
      expect(page.dispatchedTypes).toEqual([PAGE_HANDSHAKE_REQUEST_EVENT]);
      // The offer listener existed only around the request dispatch.
      const offerAdd = page.addSpy.mock.calls.findIndex(
        ([type]) => type === PAGE_HANDSHAKE_OFFER_EVENT,
      );
      const offerRemove = page.removeSpy.mock.calls.findIndex(
        ([type]) => type === PAGE_HANDSHAKE_OFFER_EVENT,
      );
      const addOrder = page.addSpy.mock.invocationCallOrder[offerAdd] ?? Number.POSITIVE_INFINITY;
      const requestOrder = page.dispatchSpy.mock.invocationCallOrder[0] ?? 0;
      const removeOrder = page.removeSpy.mock.invocationCallOrder[offerRemove] ?? 0;
      expect(addOrder).toBeLessThan(requestOrder);
      expect(requestOrder).toBeLessThan(removeOrder);
      expect(page.listenerCount(PAGE_HANDSHAKE_OFFER_EVENT)).toBe(0);

      // On the window, only the lifecycle pair remains; never a `message` listener.
      expect(page.listenerCount()).toBe(2);
      expect(page.listenerCount('pageshow')).toBe(1);
      expect(page.listenerCount('pagehide')).toBe(1);
      expect(page.addSpy.mock.calls.map(([type]) => type)).not.toContain('message');
      expect(agent.bridgeListenerCount()).toBe(1);

      expect(runtime.connectSpy).toHaveBeenCalledTimes(1);
      expect(runtime.connectSpy).toHaveBeenCalledWith({ name: PORT_CONTENT_BRIDGE });
      expect(runtime.latestPort().name).toBe(PORT_CONTENT_BRIDGE);
      expect(bridge.getStats()).toMatchObject({ connected: true, handshakeComplete: true });

      expect(agent.received).toEqual([
        {
          source: BRIDGE_SOURCE_TAG,
          version: PAGE_CHANNEL_VERSION,
          type: 'bridge.ready',
          payload: {},
        },
      ]);
      // Nothing goes upstream until the agent says something.
      expect(runtime.latestPort().post).not.toHaveBeenCalled();
    });

    it('is idempotent', () => {
      const { bridge, runtime, page, agent } = startedHarness();
      bridge.start();
      expect(runtime.connectSpy).toHaveBeenCalledTimes(1);
      expect(page.dispatchedTypes).toHaveLength(1);
      expect(agent.bridgeListenerCount()).toBe(1);
      expect(agent.receivedTypes()).toEqual(['bridge.ready']);
    });

    it('sends nothing anywhere when no agent answers', () => {
      const { bridge, runtime, page, agent } = startedHarness({ answerHandshake: false });

      expect(bridge.isConnected()).toBe(true);
      expect(bridge.getStats().handshakeComplete).toBe(false);
      expect(page.listenerCount(PAGE_HANDSHAKE_OFFER_EVENT)).toBe(0);
      expect(page.dispatchedTypes).toEqual([PAGE_HANDSHAKE_REQUEST_EVENT]);
      expect(agent.rawReceived).toEqual([]);

      runtime.latestPort().emitMessage(downstreamFrames()['agent.config']);
      expect(agent.rawReceived).toEqual([]);
      expect(bridge.getStats()).toMatchObject({ droppedDownNoChannel: 1, forwardedDown: 0 });
    });

    it('ignores an offer that arrives after the handshake — a late agent or a page script', () => {
      const { bridge, runtime, page, agent } = startedHarness();
      const lateNode = document.createElement('div');
      const lateHeard: unknown[] = [];
      lateNode.addEventListener(PAGE_BRIDGE_FRAME_EVENT, (event) => {
        lateHeard.push(event.type);
      });

      page.target.dispatchEvent(
        new MouseEvent(PAGE_HANDSHAKE_OFFER_EVENT, { relatedTarget: lateNode }),
      );
      runtime.latestPort().emitMessage(downstreamFrames()['target.request']);
      lateNode.dispatchEvent(
        new CustomEvent(PAGE_AGENT_FRAME_EVENT, {
          detail: detailOf(readyFrame()),
          cancelable: true,
        }),
      );

      // Not even heard: the offer listener no longer exists, so nothing is counted.
      expect(bridge.getStats().offersRejected).toBe(0);
      expect(lateHeard).toEqual([]);
      expect(agent.receivedTypes()).toEqual(['bridge.ready', 'target.request']);
      expect(runtime.latestPort().post).not.toHaveBeenCalled();
    });

    it('keeps the first node when a second offer answers the same request', () => {
      const { bridge, page, agent } = createHarness();
      // Code that answers after the agent, inside the same dispatch.
      const second = document.createElement('div');
      page.target.addEventListener(PAGE_HANDSHAKE_REQUEST_EVENT, () => {
        page.target.dispatchEvent(
          new MouseEvent(PAGE_HANDSHAKE_OFFER_EVENT, { relatedTarget: second }),
        );
      });
      const secondHeard: string[] = [];
      second.addEventListener(PAGE_BRIDGE_FRAME_EVENT, (event) => {
        secondHeard.push(event.type);
      });

      bridge.start();

      expect(bridge.getStats()).toMatchObject({ handshakeComplete: true, offersRejected: 1 });
      expect(agent.receivedTypes()).toEqual(['bridge.ready']);
      expect(secondHeard).toEqual([]);
    });

    it.each([
      ['a node connected to the document', (): unknown => document.body],
      ['something that is not an event target', (): unknown => ({ dispatchEvent: 'no' })],
      ['no node at all', (): unknown => null],
    ])('refuses an offer of %s and holds no channel', (_label, offered) => {
      const { bridge, runtime, agent } = startedHarness({ offerRelatedTarget: offered() });

      expect(bridge.getStats()).toMatchObject({ handshakeComplete: false, offersRejected: 1 });
      runtime.latestPort().emitMessage(downstreamFrames()['agent.config']);
      expect(agent.rawReceived).toEqual([]);
      expect(bridge.getStats().droppedDownNoChannel).toBe(1);
    });

    it('refuses the window itself as the channel', () => {
      const runtime = createFakeRuntime();
      const target = new EventTarget();
      target.addEventListener(PAGE_HANDSHAKE_REQUEST_EVENT, () => {
        target.dispatchEvent(new MouseEvent(PAGE_HANDSHAKE_OFFER_EVENT, { relatedTarget: target }));
      });
      const bridge = createContentBridge({
        chrome: runtime,
        window: target,
        setTimeout: vi.fn(),
        clearTimeout: vi.fn(),
      });

      bridge.start();

      expect(bridge.getStats()).toMatchObject({ handshakeComplete: false, offersRejected: 1 });
      bridge.stop();
    });

    it('never attaches or connects when the extension context is already invalidated', () => {
      const { bridge, runtime, page, agent, timers } = createHarness({ contextAlive: false });
      bridge.start();
      bridge.start();

      expect(runtime.connectSpy).not.toHaveBeenCalled();
      expect(page.addSpy).not.toHaveBeenCalled();
      expect(agent.answered()).toBe(false);
      expect(agent.rawReceived).toEqual([]);
      expect(timers.schedule).not.toHaveBeenCalled();
      expect(bridge.getStats().terminated).toBe(true);
      expect(bridge.isConnected()).toBe(false);
    });
  });

  describe('the private channel — what a page script can and cannot do', () => {
    it('never relays a forged agent frame posted with window.postMessage', () => {
      const { bridge, runtime, page } = startedHarness();

      for (const data of [
        // The version-2 wire, exactly as a page could copy it.
        withFields(batchFrame(), { version: 2 }),
        // The version-3 frame object and its JSON text.
        batchFrame(),
        detailOf(batchFrame()),
        readyFrame(readyPayload({ documentId: FORGED_DOCUMENT_ID })),
        errorFrame({ code: PRIVATE_SENTINEL, message: PRIVATE_SENTINEL }),
      ]) {
        page.postMessage(data);
      }

      expect(runtime.latestPort().post).not.toHaveBeenCalled();
      expect(bridge.getStats()).toMatchObject({
        relayed: 0,
        unclaimed: 0,
        refused: zeroRefusals(),
      });
    });

    it('never relays a forged frame dispatched as a window event or on a node of its own', () => {
      const { bridge, runtime, page } = startedHarness();
      const forged = detailOf(batchFrame());

      const onWindow = page.target.dispatchEvent(
        new CustomEvent(PAGE_AGENT_FRAME_EVENT, {
          detail: forged,
          cancelable: true,
          bubbles: true,
        }),
      );
      const ownNode = document.createElement('div');
      const onOwnNode = ownNode.dispatchEvent(
        new CustomEvent(PAGE_AGENT_FRAME_EVENT, { detail: forged, cancelable: true }),
      );
      // A node inserted into the document is not the channel either.
      const inDocument = document.createElement('div');
      document.body.append(inDocument);
      const onDocumentNode = inDocument.dispatchEvent(
        new CustomEvent(PAGE_AGENT_FRAME_EVENT, {
          detail: forged,
          cancelable: true,
          bubbles: true,
        }),
      );
      inDocument.remove();

      // `true`: nobody claimed any of them.
      expect([onWindow, onOwnNode, onDocumentNode]).toEqual([true, true, true]);
      expect(runtime.latestPort().post).not.toHaveBeenCalled();
      expect(bridge.getStats()).toMatchObject({ relayed: 0, refused: zeroRefusals() });
    });

    it('lets a page listener on the window see no bridge frame and no node', () => {
      const { bridge, runtime, agent, page } = startedHarness();
      const script = runPageScript(page);

      // Everything the channel does after document_start, in both directions.
      agent.send(readyFrame());
      runtime.latestPort().emitMessage(downstreamFrames()['agent.config']);
      agent.send(batchFrame());
      runtime.latestPort().emitMessage(downstreamFrames()['target.request']);
      agent.send(describedFrame());
      runtime.latestPort().emitDisconnect();
      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);
      runtime.latestPort().emitMessage(downstreamFrames()['agent.snapshot']);
      bridge.stop();
      script.dispose();

      expect(script.seen).toEqual([]);
      expect(script.relatedTargets).toEqual([]);
      // The agent received every one of them, on its node.
      expect(agent.receivedTypes()).toEqual([
        'bridge.ready',
        'agent.config',
        'target.request',
        'bridge.gone',
        'bridge.ready',
        'agent.snapshot',
        'bridge.gone',
      ]);
    });

    it('sends every bridge → agent frame on the node only, as JSON text without a token', () => {
      const { runtime, agent, page } = startedHarness();
      for (const type of BRIDGE_DOWNSTREAM_MESSAGE_TYPES) {
        runtime.latestPort().emitMessage(downstreamFrames()[type]);
      }
      runtime.latestPort().emitDisconnect();

      expect(page.dispatchedTypes).toEqual([PAGE_HANDSHAKE_REQUEST_EVENT]);
      expect(agent.rawReceived).toHaveLength(5);
      for (const detail of agent.rawReceived) {
        expect(typeof detail).toBe('string');
        const parsed: unknown = JSON.parse(String(detail));
        if (!isBridgeChannelMessage(parsed)) {
          throw new Error('expected a well-formed bridge → agent frame');
        }
        expect(Object.keys(parsed).sort()).toEqual(BRIDGE_FRAME_KEYS);
        expect(String(detail)).not.toMatch(/token/i);
      }
    });
  });

  describe('agent → worker relay (upstream)', () => {
    it('relays a telemetry batch raw — port framing only, no protocol envelope — and claims it', () => {
      const { bridge, runtime, agent } = startedHarness();
      agent.send(readyFrame());
      const frame = batchFrame();

      expect(agent.send(frame)).toBe(true);

      const relayed = upstreamFrames(runtime.latestPort()).at(-1);
      expect(Object.keys(relayed ?? {}).sort()).toEqual(UPSTREAM_FRAME_KEYS);
      expect(relayed).toEqual({
        channel: EXTENSION_CHANNEL,
        version: PORT_PROTOCOL_VERSION,
        direction: 'upstream',
        type: 'telemetry.batch',
        payload: frame.payload,
      });
      expect(bridge.getStats()).toMatchObject({ relayed: 2, unclaimed: 0 });
    });

    it('relays agent.ready unchanged, without a tab id — only the worker knows the tab', () => {
      const { runtime, agent } = startedHarness();
      const frame = readyFrame();

      expect(agent.send(frame)).toBe(true);

      const relayed = soleUpstreamFrame(runtime.latestPort());
      expect(relayed).toMatchObject({ type: 'agent.ready', payload: frame.payload });
      expect(relayed.payload).not.toHaveProperty('tabId');
    });

    it.each(AGENT_OUTBOUND_TYPES)('relays %s with the same type and payload', (type) => {
      const { runtime, agent } = startedHarness();
      agent.send(readyFrame());
      const frame = agentFrames()[type];

      expect(agent.send(frame)).toBe(true);

      const relayed = upstreamFrames(runtime.latestPort()).at(-1);
      expect(relayed?.type).toBe(type);
      expect(relayed?.payload).toEqual(frame.payload);
    });

    it('relays frames in the order the agent sent them', () => {
      const { runtime, agent } = startedHarness();
      const sequence = [
        readyFrame(),
        batchFrame(batchPayload({ batchSeq: 0 })),
        describedFrame(),
        batchFrame(batchPayload({ batchSeq: 1 })),
        errorFrame(),
      ];
      for (const frame of sequence) {
        agent.send(frame);
      }
      expect(upstreamTypes(runtime.latestPort())).toEqual(sequence.map((frame) => frame.type));
      expect(agent.sent.every((send) => send.claimed)).toBe(true);
    });

    it.each(STATELESS_REASONS)(
      'refuses %s, claims the frame (it would fail again) and relays nothing',
      (reason) => {
        for (const variant of REFUSAL_CASES[reason]) {
          const { bridge, runtime, agent } = startedHarness();
          expect(agent.sendDetail(variant.detail()), variant.label).toBe(true);
          expect(runtime.latestPort().post).not.toHaveBeenCalled();
          expect(bridge.getStats().refused).toEqual({ ...zeroRefusals(), [reason]: 1 });
          expect(bridge.getStats().relayed).toBe(0);
        }
      },
    );

    it('refuses a forged agent.error carrying private text, and relays one with a known code', () => {
      const { bridge, runtime, agent } = startedHarness();
      const log = [
        vi.spyOn(console, 'log'),
        vi.spyOn(console, 'info'),
        vi.spyOn(console, 'warn'),
        vi.spyOn(console, 'error'),
        vi.spyOn(console, 'debug'),
      ];

      expect(agent.send(errorFrame({ code: PRIVATE_SENTINEL, message: PRIVATE_SENTINEL }))).toBe(
        true,
      );
      expect(agent.send(errorFrame({ reason: PRIVATE_SENTINEL }))).toBe(true);
      expect(runtime.latestPort().post).not.toHaveBeenCalled();
      expect(bridge.getStats().refused['malformed-payload']).toBe(2);

      const known = errorFrame({ code: 'hooks-unavailable', family: 'react' });
      expect(agent.send(known)).toBe(true);
      expect(soleUpstreamFrame(runtime.latestPort())).toMatchObject({
        type: 'agent.error',
        payload: known.payload,
      });

      // Nothing page-shaped reaches the stats or the console.
      expect(JSON.stringify(bridge.getStats())).not.toContain('PRIVATE-SENTINEL');
      for (const spy of log) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  });

  describe('provenance', () => {
    it('pins the document from its first agent.ready and refuses frames naming another', () => {
      const { bridge, runtime, agent } = startedHarness();
      expect(agent.send(readyFrame())).toBe(true);

      const forgeries = [
        readyFrame(readyPayload({ documentId: FORGED_DOCUMENT_ID })),
        readyFrame(readyPayload({ producerId: FORGED_PRODUCER_ID })),
        batchFrame(batchPayload({ documentId: FORGED_DOCUMENT_ID })),
        batchFrame(
          batchPayload({
            producerId: FORGED_PRODUCER_ID,
            events: [interactionEvent(FORGED_PRODUCER_ID)],
          }),
        ),
        batchFrame(batchPayload({ events: [interactionEvent(), fetchEvent(FORGED_PRODUCER_ID)] })),
      ];
      for (const forged of forgeries) {
        // Claimed: a refused frame is settled, never retried.
        expect(agent.send(forged)).toBe(true);
      }

      expect(upstreamTypes(runtime.latestPort())).toEqual(['agent.ready']);
      expect(bridge.getStats().refused).toEqual({
        ...zeroRefusals(),
        'provenance-mismatch': forgeries.length,
      });

      // The genuine document still relays.
      expect(agent.send(batchFrame())).toBe(true);
      expect(upstreamTypes(runtime.latestPort())).toEqual(['agent.ready', 'telemetry.batch']);
    });

    it('refuses a batch before any agent.ready as provenance-unknown', () => {
      const { bridge, runtime, agent } = startedHarness();
      expect(agent.send(batchFrame())).toBe(true);
      expect(runtime.latestPort().post).not.toHaveBeenCalled();
      expect(bridge.getStats().refused['provenance-unknown']).toBe(1);
    });

    it('relays a repeated agent.ready of the same document, and re-announces the latest one', () => {
      const { runtime, agent } = startedHarness();
      agent.send(readyFrame());
      const navigated = readyPayload({ url: `${PAGE_ORIGIN}/workspace/next` });
      expect(agent.send(readyFrame(navigated))).toBe(true);

      runtime.latestPort().emitDisconnect();
      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);

      expect(soleUpstreamFrame(runtime.latestPort()).payload).toEqual(navigated);
    });

    it('requires batchSeq to increase strictly within a capture and restarts it on a new one', () => {
      const { bridge, runtime, agent } = startedHarness();
      agent.send(readyFrame());

      const results = [
        agent.send(batchFrame(batchPayload({ batchSeq: 0 }))),
        agent.send(batchFrame(batchPayload({ batchSeq: 1 }))),
        // Replays of relayed batches.
        agent.send(batchFrame(batchPayload({ batchSeq: 1 }))),
        agent.send(batchFrame(batchPayload({ batchSeq: 0 }))),
        agent.send(batchFrame(batchPayload({ batchSeq: 2 }))),
        // A new capture restarts at 0; returning to the first restarts again.
        agent.send(batchFrame(batchPayload({ captureId: OTHER_CAPTURE_ID, batchSeq: 0 }))),
        agent.send(batchFrame(batchPayload({ captureId: OTHER_CAPTURE_ID, batchSeq: 0 }))),
        agent.send(batchFrame(batchPayload({ batchSeq: 0 }))),
      ];

      expect(results.every(Boolean)).toBe(true);
      const relayed = upstreamFrames(runtime.latestPort())
        .filter((frame) => frame.type === 'telemetry.batch')
        .map((frame) =>
          frame.type === 'telemetry.batch' ? [frame.payload.captureId, frame.payload.batchSeq] : [],
        );
      expect(relayed).toEqual([
        [CAPTURE_ID, 0],
        [CAPTURE_ID, 1],
        [CAPTURE_ID, 2],
        [OTHER_CAPTURE_ID, 0],
        [CAPTURE_ID, 0],
      ]);
      expect(bridge.getStats().refused['sequence-regression']).toBe(3);
    });

    it('keeps the pin across a reconnect and a stop/start', () => {
      const { bridge, runtime, agent } = startedHarness();
      agent.send(readyFrame());

      runtime.latestPort().emitDisconnect();
      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);
      bridge.stop();
      bridge.start();

      expect(agent.send(readyFrame(readyPayload({ documentId: FORGED_DOCUMENT_ID })))).toBe(true);
      expect(upstreamTypes(runtime.latestPort())).toEqual(['agent.ready']);
      expect(bridge.getStats().refused['provenance-mismatch']).toBe(1);
    });
  });

  describe('custody', () => {
    it('does not claim an accepted frame while no port is open, and opens none inline', () => {
      const { bridge, runtime, agent, timers } = startedHarness();
      agent.send(readyFrame());
      runtime.latestPort().emitDisconnect();

      expect(agent.send(batchFrame())).toBe(false);

      expect(bridge.getStats()).toMatchObject({ relayed: 1, unclaimed: 1 });
      expect(runtime.connectSpy).toHaveBeenCalledTimes(1);
      expect(timers.pending()).toBe(1);
    });

    it('does not claim a frame whose post throws, and treats the port as lost without a re-entrant bridge.gone', () => {
      const { bridge, runtime, agent, timers } = startedHarness();
      agent.send(readyFrame());
      const port = runtime.latestPort();
      port.failPosts();

      expect(agent.send(batchFrame())).toBe(false);

      expect(bridge.isConnected()).toBe(false);
      expect(bridge.getStats()).toMatchObject({ relayed: 1, unclaimed: 1, connected: false });
      expect(port.close).toHaveBeenCalledTimes(1);
      expect(port.onMessage.listeners.size).toBe(0);
      expect(port.onDisconnect.listeners.size).toBe(0);
      expect(timers.delays()).toEqual([BRIDGE_RECONNECT_BASE_MS]);
      // The unclaimed frame is the agent's signal; nothing was dispatched back into its dispatch.
      expect(agent.receivedTypes()).toEqual(['bridge.ready']);
    });

    it('after the reconnect sends bridge.ready, and the batch the agent kept is relayed exactly once', () => {
      const { runtime, agent } = startedHarness();
      agent.send(readyFrame());
      const first = runtime.latestPort();
      first.failPosts();
      const kept = batchFrame(batchPayload({ batchSeq: 0 }));

      agent.deliver(kept);
      expect(agent.pending).toEqual([kept]);

      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);

      const second = runtime.latestPort();
      expect(second).not.toBe(first);
      expect(agent.receivedTypes()).toEqual(['bridge.ready', 'bridge.ready']);
      expect(agent.pending).toEqual([]);
      // The bridge re-announces the document first, then the agent drains inside bridge.ready.
      expect(upstreamTypes(second)).toEqual(['agent.ready', 'telemetry.batch']);
      const batches = [...upstreamFrames(first), ...upstreamFrames(second)].filter(
        (frame) => frame.type === 'telemetry.batch',
      );
      expect(batches).toHaveLength(1);
      expect(batches[0]?.payload).toEqual(kept.payload);
      // The first port accepted the ready and saw the batch's one failed attempt.
      expect(first.accepted).toHaveLength(1);
      expect(first.post).toHaveBeenCalledTimes(2);
    });

    it('stays consistent when the agent drains and re-announces inside bridge.ready', () => {
      const { bridge, runtime, agent } = startedHarness({ announceOnReady: readyPayload() });
      expect(agent.send(readyFrame())).toBe(true);
      runtime.latestPort().emitDisconnect();
      agent.deliver(batchFrame(batchPayload({ batchSeq: 0 })));
      agent.deliver(batchFrame(batchPayload({ batchSeq: 1 })));
      expect(agent.pending).toHaveLength(2);

      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);

      expect(agent.pending).toEqual([]);
      expect(upstreamTypes(runtime.latestPort())).toEqual([
        'agent.ready',
        'telemetry.batch',
        'telemetry.batch',
        'agent.ready',
      ]);
      expect(bridge.getStats()).toMatchObject({ reannounced: 1, unclaimed: 0 });
    });

    it('keeps the rest in custody when the port dies in the middle of a drain', () => {
      const { runtime, agent, timers } = startedHarness();
      agent.send(readyFrame());
      runtime.latestPort().emitDisconnect();
      const batch0 = batchFrame(batchPayload({ batchSeq: 0 }));
      const batch1 = batchFrame(batchPayload({ batchSeq: 1 }));
      agent.deliver(batch0);
      agent.deliver(batch1);

      // The next port takes the re-announcement and one batch, then dies.
      runtime.nextPortFailsAfter(2);
      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);
      const dying = runtime.latestPort();

      expect(upstreamTypes(dying)).toEqual(['agent.ready', 'telemetry.batch']);
      expect(agent.pending).toEqual([batch1]);
      expect(dying.close).toHaveBeenCalledTimes(1);
      // bridge.ready, bridge.gone (the first port's disconnect), bridge.ready — and no gone from the throw.
      expect(agent.receivedTypes()).toEqual(['bridge.ready', 'bridge.gone', 'bridge.ready']);
      expect(timers.pending()).toBe(1);

      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS * 2);

      const all = runtime.ports.flatMap((port) => upstreamFrames(port));
      const batches = all
        .filter((frame) => frame.type === 'telemetry.batch')
        .map((frame) => frame.payload);
      expect(batches).toEqual([batch0.payload, batch1.payload]);
      expect(agent.pending).toEqual([]);
    });

    it('does not claim frames after stop(), when nothing relays them', () => {
      const { bridge, agent } = startedHarness();
      bridge.stop();
      expect(agent.send(readyFrame())).toBe(false);
      expect(bridge.getStats().relayed).toBe(0);
    });
  });

  describe('the event-rate budget', () => {
    /** A budget clock the case moves by hand; reconnect timers never move it. */
    interface ManualClock {
      ms: number;
      readonly read: () => number;
    }

    function manualClock(): ManualClock {
      const clock: ManualClock = { ms: 0, read: () => clock.ms };
      return clock;
    }

    /** A started harness on a held budget clock, its document pinned by `agent.ready`. */
    function meteredHarness(
      options: HarnessOptions = {},
    ): Harness & { readonly clock: ManualClock } {
      const clock = manualClock();
      const harness = startedHarness({ ...options, monotonicNow: clock.read });
      expect(harness.agent.send(readyFrame())).toBe(true);
      return { ...harness, clock };
    }

    /** Relay `count` full agent batches from `batchSeq` 0; returns the next `batchSeq`. */
    function relayFullBatches(agent: FakeAgent, count: number): number {
      for (let batchSeq = 0; batchSeq < count; batchSeq += 1) {
        expect(agent.send(sizedBatchFrame(AGENT_BATCH_EVENTS, batchSeq))).toBe(true);
      }
      return count;
    }

    /** Spend the whole burst in full agent batches; returns the next `batchSeq`. */
    function spendWholeBudget(agent: FakeAgent): number {
      return relayFullBatches(agent, BRIDGE_EVENT_BUDGET_CAPACITY / AGENT_BATCH_EVENTS);
    }

    it('relays a burst up to the capacity, then refuses and acknowledges the next batch, logging nothing', () => {
      const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined),
      );
      const { bridge, runtime, agent } = meteredHarness();
      const port = runtime.latestPort();

      const next = spendWholeBudget(agent);

      expect(relayedBatches(port)).toHaveLength(next);
      expect(bridge.getStats()).toMatchObject({ relayed: 1 + next, budgetAvailableEvents: 0 });

      const posted = port.accepted.length;
      // Acknowledged, so the agent moves on instead of parking until the next bridge.ready.
      expect(agent.send(sizedBatchFrame(1, next))).toBe(true);

      expect(port.accepted).toHaveLength(posted);
      const stats = bridge.getStats();
      expect(stats.refused).toEqual({ ...zeroRefusals(), 'rate-limited': 1 });
      expect(stats).toMatchObject({
        relayed: 1 + next,
        unclaimed: 0,
        rateLimitedEvents: 1,
        pendingDroppedCount: 1,
        budgetAvailableEvents: 0,
      });
      expect(agent.receivedTypes()).toEqual(['bridge.ready']);
      for (const spy of consoleSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it('lets batches through again as injected time refills the budget, up to the capacity', () => {
      const { bridge, runtime, agent, clock } = meteredHarness();
      const port = runtime.latestPort();
      let batchSeq = spendWholeBudget(agent);

      // Exactly one full batch earned: it travels.
      clock.ms += msToEarn(AGENT_BATCH_EVENTS);
      expect(agent.send(sizedBatchFrame(AGENT_BATCH_EVENTS, batchSeq))).toBe(true);
      batchSeq += 1;
      expect(bridge.getStats().refused['rate-limited']).toBe(0);

      // One event short of the next batch: refused, and acknowledged.
      clock.ms += msToEarn(AGENT_BATCH_EVENTS - 1);
      expect(agent.send(sizedBatchFrame(AGENT_BATCH_EVENTS, batchSeq))).toBe(true);
      batchSeq += 1;
      expect(bridge.getStats().refused['rate-limited']).toBe(1);

      // The last event earned, the next batch travels — the refused one's refill was kept.
      clock.ms += msToEarn(1);
      expect(agent.send(sizedBatchFrame(AGENT_BATCH_EVENTS, batchSeq))).toBe(true);
      expect(relayedBatches(port)).toHaveLength(
        BRIDGE_EVENT_BUDGET_CAPACITY / AGENT_BATCH_EVENTS + 2,
      );
      expect(bridge.getStats()).toMatchObject({ budgetAvailableEvents: 0 });

      // An hour of quiet refills to the capacity and no further; any judged frame measures it.
      clock.ms += 3_600_000;
      expect(agent.send(errorFrame())).toBe(true);
      expect(bridge.getStats().budgetAvailableEvents).toBe(BRIDGE_EVENT_BUDGET_CAPACITY);
    });

    it("adds the refused events, and the agent's own loss they carried, to the next relayed batch exactly once", () => {
      const { bridge, runtime, agent, clock } = meteredHarness();
      const port = runtime.latestPort();
      let batchSeq = spendWholeBudget(agent);

      // Two batches refused: 150 events carrying the agent's own loss of 7, then 50 more.
      expect(agent.send(sizedBatchFrame(150, batchSeq, 7))).toBe(true);
      batchSeq += 1;
      expect(agent.send(sizedBatchFrame(50, batchSeq))).toBe(true);
      batchSeq += 1;
      expect(bridge.getStats()).toMatchObject({ rateLimitedEvents: 200, pendingDroppedCount: 207 });

      clock.ms += 1_000;
      // The agent's next batch reports a new loss of its own; the bridge adds what it refused.
      const reporting = sizedBatchFrame(10, batchSeq, 3);
      expect(agent.send(reporting)).toBe(true);
      batchSeq += 1;
      expect(agent.send(sizedBatchFrame(10, batchSeq))).toBe(true);

      const [reported, after] = relayedBatches(port).slice(-2);
      // Only droppedCount changes; every other field travels as the agent sent it.
      expect(reported).toEqual({ ...reporting.payload, droppedCount: 3 + 207 });
      expect(after?.droppedCount).toBe(0);
      expect(bridge.getStats()).toMatchObject({ rateLimitedEvents: 200, pendingDroppedCount: 0 });
      const totalReported = relayedBatches(port).reduce(
        (sum, batch) => sum + batch.droppedCount,
        0,
      );
      expect(totalReported).toBe(150 + 7 + 50 + 3);
    });

    it('spends no budget and clears no loss for a batch left in the agent custody', () => {
      const { bridge, runtime, agent, clock } = meteredHarness();
      // Leave exactly one full batch of budget, then have one event more refused.
      let batchSeq = relayFullBatches(agent, BRIDGE_EVENT_BUDGET_CAPACITY / AGENT_BATCH_EVENTS - 1);
      expect(agent.send(sizedBatchFrame(AGENT_BATCH_EVENTS + 1, batchSeq))).toBe(true);
      batchSeq += 1;
      const held = { budgetAvailableEvents: AGENT_BATCH_EVENTS, pendingDroppedCount: 201 };
      expect(bridge.getStats()).toMatchObject(held);

      // No port: the batch stays with the agent however often it is offered.
      runtime.latestPort().emitDisconnect();
      const kept = sizedBatchFrame(AGENT_BATCH_EVENTS, batchSeq);
      expect(agent.send(kept)).toBe(false);
      expect(agent.send(kept)).toBe(false);
      agent.deliver(kept);
      expect(agent.pending).toEqual([kept]);
      expect(bridge.getStats()).toMatchObject({ ...held, unclaimed: 2 });

      // A port whose post throws: the drained batch stays with the agent too.
      runtime.nextPortFailsAfter(1);
      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);
      expect(upstreamTypes(runtime.latestPort())).toEqual(['agent.ready']);
      expect(agent.pending).toEqual([kept]);
      expect(bridge.getStats()).toMatchObject({ ...held, unclaimed: 3 });

      // The next port takes it: only now does it spend, and it carries the held loss.
      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS * 2);
      expect(agent.pending).toEqual([]);
      expect(relayedBatches(runtime.latestPort())).toEqual([
        { ...kept.payload, droppedCount: 201 },
      ]);
      expect(bridge.getStats()).toMatchObject({ budgetAvailableEvents: 0, pendingDroppedCount: 0 });
      // The reconnect timers moved the port clock only, never the budget's.
      expect(clock.ms).toBe(0);
    });

    it('reports a malformed, forged or regressed batch over budget for what it is, never as rate-limited', () => {
      const { bridge, runtime, agent } = meteredHarness();
      const next = spendWholeBudget(agent);
      const posted = runtime.latestPort().accepted.length;

      expect(
        agent.send(batchFrame(batchPayload({ producerId: PRIVATE_SENTINEL, batchSeq: next }))),
      ).toBe(true);
      expect(
        agent.send(batchFrame(batchPayload({ documentId: FORGED_DOCUMENT_ID, batchSeq: next }))),
      ).toBe(true);
      expect(agent.send(sizedBatchFrame(1, next - 1))).toBe(true);
      expect(agent.sendDetail(detailOf(batchFrame()).slice(0, -1))).toBe(true);

      expect(runtime.latestPort().accepted).toHaveLength(posted);
      const stats = bridge.getStats();
      expect(stats.refused).toEqual({
        ...zeroRefusals(),
        unparseable: 1,
        'malformed-payload': 1,
        'provenance-mismatch': 1,
        'sequence-regression': 1,
      });
      expect(stats).toMatchObject({
        rateLimitedEvents: 0,
        pendingDroppedCount: 0,
        budgetAvailableEvents: 0,
      });
    });

    it('never meters control traffic: an empty budget still relays agent.ready, target.described and agent.error', () => {
      const { bridge, runtime, agent } = meteredHarness();
      spendWholeBudget(agent);
      const port = runtime.latestPort();
      const posted = port.accepted.length;

      expect(agent.send(readyFrame())).toBe(true);
      expect(agent.send(describedFrame())).toBe(true);
      expect(agent.send(errorFrame())).toBe(true);

      expect(upstreamTypes(port).slice(posted)).toEqual([
        'agent.ready',
        'target.described',
        'agent.error',
      ]);
      expect(bridge.getStats().refused['rate-limited']).toBe(0);
    });

    it('clamps the reported loss to the bound the worker guard enforces', () => {
      const { bridge, runtime, agent, clock } = meteredHarness();
      let batchSeq = spendWholeBudget(agent);
      expect(agent.send(sizedBatchFrame(5, batchSeq, Number.MAX_SAFE_INTEGER - 1))).toBe(true);
      batchSeq += 1;
      expect(bridge.getStats().pendingDroppedCount).toBe(Number.MAX_SAFE_INTEGER);

      clock.ms += 1_000;
      expect(agent.send(sizedBatchFrame(1, batchSeq, 10))).toBe(true);

      // relayedBatches narrows through isBridgeUpstreamMessage, the worker's own guard.
      expect(relayedBatches(runtime.latestPort()).at(-1)?.droppedCount).toBe(
        Number.MAX_SAFE_INTEGER,
      );
      expect(bridge.getStats().pendingDroppedCount).toBe(0);
    });

    it('keeps one budget per document across stop() and start()', () => {
      const { bridge, agent } = meteredHarness();
      const next = spendWholeBudget(agent);
      bridge.stop();
      bridge.start();
      expect(agent.send(sizedBatchFrame(1, next))).toBe(true);
      expect(bridge.getStats()).toMatchObject({ rateLimitedEvents: 1, budgetAvailableEvents: 0 });
    });

    it('still judges every frame when the budget clock throws, counting a fault and earning nothing', () => {
      const { bridge, runtime, agent } = startedHarness({
        monotonicNow: (): number => {
          throw new Error('clock unavailable');
        },
      });
      expect(agent.send(readyFrame())).toBe(true);
      expect(agent.send(batchFrame())).toBe(true);

      expect(upstreamTypes(runtime.latestPort())).toEqual(['agent.ready', 'telemetry.batch']);
      expect(bridge.getStats()).toMatchObject({
        faults: 2,
        budgetAvailableEvents: BRIDGE_EVENT_BUDGET_CAPACITY - batchPayload().events.length,
      });
    });

    it('refills from performance.now by default, read at call time', () => {
      const runtime = createFakeRuntime();
      const page = createFakeWindow();
      const agent = installFakeAgent(page);
      const timers = createScheduler();
      const bridge = createContentBridge({
        chrome: runtime,
        window: page,
        setTimeout: timers.schedule,
        clearTimeout: timers.cancel,
        random: (): number => 0,
      });
      liveHarnesses.push({ bridge, runtime, page, agent, timers });
      // Installed after construction: the default clock is looked up per reading.
      let reading = 1_000;
      vi.spyOn(performance, 'now').mockImplementation(() => reading);

      bridge.start();
      expect(agent.send(readyFrame())).toBe(true);
      const next = spendWholeBudget(agent);
      expect(agent.send(sizedBatchFrame(1, next))).toBe(true);
      expect(bridge.getStats().refused['rate-limited']).toBe(1);

      // Only performance.now moved — the faked Date did not — and the budget refilled.
      reading += msToEarn(1);
      expect(agent.send(sizedBatchFrame(1, next + 1))).toBe(true);
      expect(bridge.getStats()).toMatchObject({ rateLimitedEvents: 1, pendingDroppedCount: 0 });
      expect(relayedBatches(runtime.latestPort()).at(-1)?.droppedCount).toBe(1);
    });

    describe('held loss that no later batch carries', () => {
      /**
       * A `pagehide` or `pageshow` as the browser itself dispatches it, with
       * `isTrusted` `true`. happy-dom does not model `isTrusted` at all, so the
       * browser's own dispatch is modelled by defining it on the instance — the
       * one thing a page script can never do to an event the isolated world sees.
       */
      function browserLifecycleEvent(type: 'pagehide' | 'pageshow', persisted = false): Event {
        const event = new Event(type);
        Object.defineProperty(event, 'persisted', { value: persisted });
        Object.defineProperty(event, 'isTrusted', { value: true });
        return event;
      }

      /** What a page script can dispatch on `window`: never `isTrusted: true`. */
      const SYNTHETIC_PAGEHIDES: readonly {
        readonly label: string;
        readonly build: () => Event;
      }[] = [
        { label: 'without isTrusted', build: () => new Event('pagehide') },
        {
          label: 'with isTrusted false',
          build: () => Object.defineProperty(new Event('pagehide'), 'isTrusted', { value: false }),
        },
        {
          label: 'with a truthy isTrusted that is not true',
          build: () => Object.defineProperty(new Event('pagehide'), 'isTrusted', { value: 'true' }),
        },
      ];

      /**
       * The payload of the bridge's own loss-only report: no events, the
       * pinned ids, the last relayed position — `captureId` only when that
       * position had one — and no `sessionId`.
       */
      function lossOnlyPayload(
        droppedCount: number,
        batchSeq: number,
        position: { readonly captureId?: string } = { captureId: CAPTURE_ID },
      ): Record<string, unknown> {
        return {
          events: [],
          producerId: PRODUCER_ID,
          documentId: DOCUMENT_ID,
          batchSeq,
          droppedCount,
          ...(position.captureId === undefined ? {} : { captureId: position.captureId }),
        };
      }

      /** The event-less batches `port` accepted: the bridge's loss reports. */
      function lossOnlyBatches(port: FakePort): PageTelemetryBatchPayload[] {
        return relayedBatches(port).filter((batch) => batch.events.length === 0);
      }

      it('reports a final rate-limited batch on its own after the delay: once, event-less, exact, pinned', () => {
        const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
          vi.spyOn(console, method).mockImplementation(() => undefined),
        );
        const { bridge, runtime, agent, timers } = meteredHarness();
        const port = runtime.latestPort();
        const next = spendWholeBudget(agent);
        const posted = port.accepted.length;

        // The burst's last batch is refused, carrying the agent's own loss of 7.
        expect(agent.send(sizedBatchFrame(150, next, 7))).toBe(true);
        expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 157, lossReports: 0 });
        expect(timers.delays()).toEqual([BRIDGE_LOSS_REPORT_DELAY_MS]);

        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS - 1);
        expect(port.accepted).toHaveLength(posted);

        vi.advanceTimersByTime(1);
        expect(port.accepted).toHaveLength(posted + 1);
        const report = port.accepted.at(-1);
        // The worker's own guard for bridge-port frames accepts it.
        expect(isBridgeUpstreamMessage(report)).toBe(true);
        expect(report).toStrictEqual({
          channel: EXTENSION_CHANNEL,
          version: PORT_PROTOCOL_VERSION,
          direction: 'upstream',
          type: 'telemetry.batch',
          payload: lossOnlyPayload(157, next - 1),
        });
        expect(bridge.getStats()).toMatchObject({
          relayed: 1 + next,
          pendingDroppedCount: 0,
          lossReports: 1,
          budgetAvailableEvents: 0,
        });
        expect(timers.pending()).toBe(0);

        // Exactly one report, however long the page then stays quiet.
        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS * 10);
        expect(lossOnlyBatches(port)).toHaveLength(1);
        // Nothing reaches the agent, and nothing is logged.
        expect(agent.receivedTypes()).toEqual(['bridge.ready']);
        for (const spy of consoleSpies) {
          expect(spy).not.toHaveBeenCalled();
        }
      });

      it('arms one report for the held loss: a later refusal neither re-arms nor postpones it', () => {
        const { runtime, agent, timers } = meteredHarness();
        const port = runtime.latestPort();
        const next = spendWholeBudget(agent);

        expect(agent.send(sizedBatchFrame(20, next))).toBe(true);
        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS / 2);
        expect(agent.send(sizedBatchFrame(30, next + 1))).toBe(true);
        expect(timers.delays()).toEqual([BRIDGE_LOSS_REPORT_DELAY_MS]);

        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS / 2);
        expect(lossOnlyBatches(port)).toStrictEqual([lossOnlyPayload(50, next - 1)]);
      });

      it('lets a later batch carry the loss and disarms the report, so nothing is reported twice', () => {
        const { bridge, runtime, agent, clock, timers } = meteredHarness();
        const port = runtime.latestPort();
        let batchSeq = spendWholeBudget(agent);
        expect(agent.send(sizedBatchFrame(50, batchSeq))).toBe(true);
        batchSeq += 1;
        expect(timers.pending()).toBe(1);
        const armed: unknown = timers.schedule.mock.results.at(-1)?.value;

        clock.ms += 1_000;
        expect(agent.send(sizedBatchFrame(10, batchSeq))).toBe(true);

        expect(relayedBatches(port).at(-1)?.droppedCount).toBe(50);
        expect(timers.cancel).toHaveBeenCalledWith(armed);
        expect(timers.pending()).toBe(0);
        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS * 2);
        expect(lossOnlyBatches(port)).toEqual([]);
        const totalReported = relayedBatches(port).reduce(
          (sum, batch) => sum + batch.droppedCount,
          0,
        );
        expect(totalReported).toBe(50);
        expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 0 });
      });

      it('reports held loss at once on a trusted pagehide, and keeps the port for the tail', () => {
        const { bridge, runtime, page, agent, clock, timers } = meteredHarness();
        const port = runtime.latestPort();
        const next = spendWholeBudget(agent);
        expect(agent.send(sizedBatchFrame(30, next))).toBe(true);
        const posted = port.accepted.length;

        page.target.dispatchEvent(browserLifecycleEvent('pagehide'));

        expect(port.accepted).toHaveLength(posted + 1);
        expect(lossOnlyBatches(port)).toStrictEqual([lossOnlyPayload(30, next - 1)]);
        expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 1 });
        expect(timers.pending()).toBe(0);
        // The port stays open: frames the agent sends after this listener still travel.
        expect(bridge.isConnected()).toBe(true);
        expect(port.close).not.toHaveBeenCalled();
        clock.ms += 1_000;
        expect(agent.send(sizedBatchFrame(10, next + 1))).toBe(true);
        expect(runtime.latestPort()).toBe(port);
        expect(relayedBatches(port).at(-1)?.events).toHaveLength(10);
        expect(agent.receivedTypes()).toEqual(['bridge.ready']);
      });

      it.each(SYNTHETIC_PAGEHIDES)(
        'ignores a synthetic pagehide $label: the loss waits for its timer',
        ({ build }) => {
          const { bridge, runtime, page, agent, timers } = meteredHarness();
          const port = runtime.latestPort();
          const next = spendWholeBudget(agent);
          expect(agent.send(sizedBatchFrame(30, next))).toBe(true);
          const posted = port.accepted.length;

          page.target.dispatchEvent(build());

          expect(port.accepted).toHaveLength(posted);
          expect(timers.pending()).toBe(1);
          // Not hiding either: a later refusal is held, not reported at once.
          expect(agent.send(sizedBatchFrame(5, next + 1))).toBe(true);
          expect(port.accepted).toHaveLength(posted);
          expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 35, lossReports: 0 });

          vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS);
          expect(lossOnlyBatches(port)).toStrictEqual([lossOnlyPayload(35, next - 1)]);
        },
      );

      it('reports every refusal at once while the document is hiding, until a trusted pageshow', () => {
        const { bridge, runtime, page, agent, timers } = meteredHarness();
        const port = runtime.latestPort();
        let batchSeq = spendWholeBudget(agent);
        const last = batchSeq - 1;

        // Nothing is held yet: a trusted pagehide posts nothing.
        page.target.dispatchEvent(browserLifecycleEvent('pagehide'));
        expect(lossOnlyBatches(port)).toEqual([]);

        // The agent's tail, refused after the bridge's pagehide listener ran.
        expect(agent.send(sizedBatchFrame(20, batchSeq))).toBe(true);
        batchSeq += 1;
        expect(lossOnlyBatches(port)).toStrictEqual([lossOnlyPayload(20, last)]);
        expect(agent.send(sizedBatchFrame(5, batchSeq))).toBe(true);
        batchSeq += 1;
        expect(lossOnlyBatches(port)).toStrictEqual([
          lossOnlyPayload(20, last),
          lossOnlyPayload(5, last),
        ]);
        expect(timers.pending()).toBe(0);
        expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 2 });

        // A page script's pageshow does not end the hiding state.
        page.target.dispatchEvent(new Event('pageshow'));
        expect(agent.send(sizedBatchFrame(4, batchSeq))).toBe(true);
        batchSeq += 1;
        expect(lossOnlyBatches(port)).toHaveLength(3);

        // The browser's pageshow does; not persisted, so the port is kept.
        page.target.dispatchEvent(browserLifecycleEvent('pageshow'));
        expect(runtime.connectSpy).toHaveBeenCalledTimes(1);
        expect(agent.send(sizedBatchFrame(6, batchSeq))).toBe(true);
        expect(lossOnlyBatches(port)).toHaveLength(3);
        expect(timers.delays()).toEqual([BRIDGE_LOSS_REPORT_DELAY_MS]);
        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS);
        expect(lossOnlyBatches(port).at(-1)).toStrictEqual(lossOnlyPayload(6, last));
        expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 4 });
      });

      it('keeps the loss held while no port is open, and reports it at once on the next port, after bridge.ready', () => {
        const { bridge, runtime, agent, timers } = meteredHarness();
        const first = runtime.latestPort();
        const next = spendWholeBudget(agent);
        expect(agent.send(sizedBatchFrame(40, next))).toBe(true);

        // The port closes just before the report is due.
        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS - 1);
        first.emitDisconnect();
        const acceptedByFirst = first.accepted.length;
        vi.advanceTimersByTime(1);

        expect(first.accepted).toHaveLength(acceptedByFirst);
        expect(bridge.getStats()).toMatchObject({
          connected: false,
          pendingDroppedCount: 40,
          lossReports: 0,
        });
        // Only the reconnect is pending now.
        expect(timers.pending()).toBe(1);

        const reportTimersBefore = timers
          .delays()
          .filter((delay) => delay === BRIDGE_LOSS_REPORT_DELAY_MS).length;
        vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);
        const second = runtime.latestPort();
        expect(second).not.toBe(first);
        // Reported as soon as the new port had sent bridge.ready: no timer
        // waits for it, and none is armed.
        expect(agent.receivedTypes().at(-1)).toBe('bridge.ready');
        expect(upstreamTypes(second)).toEqual(['agent.ready', 'telemetry.batch']);
        expect(lossOnlyBatches(second)).toStrictEqual([lossOnlyPayload(40, next - 1)]);
        expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 1 });
        expect(
          timers.delays().filter((delay) => delay === BRIDGE_LOSS_REPORT_DELAY_MS),
        ).toHaveLength(reportTimersBefore);
        expect(timers.pending()).toBe(0);
      });

      it('keeps the loss held when the report post throws, and reports it on the next port', () => {
        const { bridge, runtime, agent, timers } = meteredHarness();
        const first = runtime.latestPort();
        const next = spendWholeBudget(agent);
        expect(agent.send(sizedBatchFrame(40, next))).toBe(true);
        first.failPosts();

        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS);

        // The throwing port is lost exactly as a disconnect would be.
        expect(first.close).toHaveBeenCalledTimes(1);
        expect(lossOnlyBatches(first)).toEqual([]);
        expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 40, lossReports: 0 });
        expect(timers.delays().at(-1)).toBe(BRIDGE_RECONNECT_BASE_MS);

        vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS + BRIDGE_LOSS_REPORT_DELAY_MS);
        expect(lossOnlyBatches(runtime.latestPort())).toStrictEqual([
          lossOnlyPayload(40, next - 1),
        ]);
        expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 1 });
      });

      it('stop() disarms the report and keeps the loss, which a restart reports at once', () => {
        const { bridge, runtime, agent, timers } = meteredHarness();
        const port = runtime.latestPort();
        const next = spendWholeBudget(agent);
        expect(agent.send(sizedBatchFrame(40, next))).toBe(true);
        const armed: unknown = timers.schedule.mock.results.at(-1)?.value;

        bridge.stop();

        expect(timers.cancel).toHaveBeenCalledWith(armed);
        expect(timers.pending()).toBe(0);
        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS * 2);
        expect(lossOnlyBatches(port)).toEqual([]);
        expect(bridge.getStats().pendingDroppedCount).toBe(40);

        bridge.start();
        expect(lossOnlyBatches(runtime.latestPort())).toStrictEqual([
          lossOnlyPayload(40, next - 1),
        ]);
        expect(timers.pending()).toBe(0);
      });

      it('termination disarms the report: nothing is posted once the context is invalidated', () => {
        const { bridge, runtime, agent, timers } = meteredHarness();
        const port = runtime.latestPort();
        const next = spendWholeBudget(agent);
        expect(agent.send(sizedBatchFrame(40, next))).toBe(true);
        const armed: unknown = timers.schedule.mock.results.at(-1)?.value;
        runtime.id = undefined;

        port.emitDisconnect();

        expect(bridge.getStats().terminated).toBe(true);
        expect(timers.cancel).toHaveBeenCalledWith(armed);
        expect(timers.pending()).toBe(0);
        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS * 2);
        expect(port.post.mock.calls.length).toBe(port.accepted.length);
        expect(lossOnlyBatches(port)).toEqual([]);
      });

      it('never advances the sequence or spends budget: the agent batch n + 1 still travels whole', () => {
        const { bridge, runtime, agent } = meteredHarness();
        const port = runtime.latestPort();
        // Leave exactly one full batch of budget, then have one event more refused.
        const next = relayFullBatches(agent, BRIDGE_EVENT_BUDGET_CAPACITY / AGENT_BATCH_EVENTS - 1);
        expect(agent.send(sizedBatchFrame(AGENT_BATCH_EVENTS + 1, next))).toBe(true);

        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS);
        expect(lossOnlyBatches(port)).toStrictEqual([
          lossOnlyPayload(AGENT_BATCH_EVENTS + 1, next - 1),
        ]);
        expect(bridge.getStats().budgetAvailableEvents).toBe(AGENT_BATCH_EVENTS);

        // Batch n + 1 after the last relayed n: in sequence, and it fits the budget exactly.
        const successor = sizedBatchFrame(AGENT_BATCH_EVENTS, next);
        expect(agent.send(successor)).toBe(true);
        expect(relayedBatches(port).at(-1)).toStrictEqual(successor.payload);
        // The one refusal is the over-budget batch; the successor is no regression.
        expect(bridge.getStats().refused).toEqual({ ...zeroRefusals(), 'rate-limited': 1 });
        expect(bridge.getStats()).toMatchObject({ budgetAvailableEvents: 0, lossReports: 1 });
      });

      it('omits captureId when the last relayed batch had none', () => {
        const { runtime, agent } = meteredHarness();
        const port = runtime.latestPort();
        relayFullBatches(agent, BRIDGE_EVENT_BUDGET_CAPACITY / AGENT_BATCH_EVENTS - 1);
        const uncaptured = (count: number, batchSeq: number): unknown =>
          withFields(batchFrame(), {
            payload: withoutField(batchPayload({ events: eventsOf(count), batchSeq }), 'captureId'),
          });
        expect(agent.send(uncaptured(AGENT_BATCH_EVENTS, 0))).toBe(true);
        expect(agent.send(uncaptured(1, 1))).toBe(true);

        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS);

        const [report] = lossOnlyBatches(port);
        expect(report).toStrictEqual(lossOnlyPayload(1, 0, {}));
        expect(report).not.toHaveProperty('captureId');
      });

      it('reports held loss at once after an agent.config, whose dispatch flushed the capture’s tail', () => {
        // What the fake agent does inside the configuration's dispatch; set
        // once the harness — and so the agent — exists.
        const inDispatch: { flushTail: () => void } = { flushTail: () => undefined };
        const { bridge, runtime, agent, timers } = meteredHarness({
          onAgentConfig: () => {
            inDispatch.flushTail();
          },
        });
        const port = runtime.latestPort();
        const next = spendWholeBudget(agent);
        const tailClaimed: boolean[] = [];
        inDispatch.flushTail = () => {
          tailClaimed.push(agent.send(sizedBatchFrame(30, next)));
        };

        // The worker ends the capture: inside the dispatch the agent flushes
        // its tail, and the spent budget refuses it.
        port.emitMessage(downstreamFrames()['agent.config']);

        expect(tailClaimed).toEqual([true]);
        expect(agent.listenerErrors).toEqual([]);
        // Reported at once — no timer left — under the tail's capture, at the
        // capture's last relayed position.
        expect(lossOnlyBatches(port)).toStrictEqual([lossOnlyPayload(30, next - 1)]);
        expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 1 });
        expect(timers.pending()).toBe(0);
        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS * 2);
        expect(lossOnlyBatches(port)).toHaveLength(1);
      });

      it('posts nothing extra after an agent.config when no loss is held', () => {
        const { bridge, runtime, agent } = meteredHarness();
        const port = runtime.latestPort();
        relayFullBatches(agent, 2);
        const posted = port.accepted.length;

        port.emitMessage(downstreamFrames()['agent.config']);

        expect(port.accepted).toHaveLength(posted);
        expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 0 });
      });

      it("reports one capture's held loss on its own before a batch of the next capture, which carries none of it", () => {
        const { bridge, runtime, agent, clock, timers } = meteredHarness();
        const port = runtime.latestPort();
        const next = spendWholeBudget(agent);
        expect(agent.send(sizedBatchFrame(30, next))).toBe(true);
        clock.ms += 1_000;
        const firstOfNext = batchFrame(
          batchPayload({ events: eventsOf(10), batchSeq: 0, captureId: OTHER_CAPTURE_ID }),
        );

        expect(agent.send(firstOfNext)).toBe(true);

        // The earlier capture's report first, labelled with its own capture;
        // then the new capture's batch exactly as the agent sent it.
        expect(relayedBatches(port).slice(-2)).toStrictEqual([
          lossOnlyPayload(30, next - 1),
          firstOfNext.payload,
        ]);
        expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 1 });
        expect(timers.pending()).toBe(0);
        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS * 2);
        expect(lossOnlyBatches(port)).toHaveLength(1);
      });

      it("holds a refused batch's loss under its own capture: the next batch of that capture carries it", () => {
        const { bridge, runtime, agent, clock } = meteredHarness();
        const port = runtime.latestPort();
        spendWholeBudget(agent);
        // The next capture's first batch finds the budget spent; the last
        // relayed batch is still the earlier capture's.
        expect(
          agent.send(
            batchFrame(
              batchPayload({ events: eventsOf(20), batchSeq: 0, captureId: OTHER_CAPTURE_ID }),
            ),
          ),
        ).toBe(true);
        expect(bridge.getStats().pendingDroppedCount).toBe(20);
        clock.ms += 1_000;
        const second = batchFrame(
          batchPayload({ events: eventsOf(5), batchSeq: 1, captureId: OTHER_CAPTURE_ID }),
        );

        expect(agent.send(second)).toBe(true);

        expect(lossOnlyBatches(port)).toEqual([]);
        expect(relayedBatches(port).at(-1)).toStrictEqual({ ...second.payload, droppedCount: 20 });
        expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 0 });
      });

      it('names the loss’s own capture, at position 0, when no batch of that capture was relayed', () => {
        const { runtime, agent } = meteredHarness();
        const port = runtime.latestPort();
        spendWholeBudget(agent);
        expect(
          agent.send(
            batchFrame(
              batchPayload({ events: eventsOf(20), batchSeq: 0, captureId: OTHER_CAPTURE_ID }),
            ),
          ),
        ).toBe(true);

        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS);

        expect(lossOnlyBatches(port)).toStrictEqual([
          lossOnlyPayload(20, 0, { captureId: OTHER_CAPTURE_ID }),
        ]);
      });

      it("reports held loss of one capture at once when a refusal of another capture's batch arrives", () => {
        const { bridge, runtime, agent } = meteredHarness();
        const port = runtime.latestPort();
        const next = spendWholeBudget(agent);
        expect(agent.send(sizedBatchFrame(30, next))).toBe(true);

        expect(
          agent.send(
            batchFrame(
              batchPayload({ events: eventsOf(20), batchSeq: 0, captureId: OTHER_CAPTURE_ID }),
            ),
          ),
        ).toBe(true);

        // Never summed: the earlier capture's loss went out under its label …
        expect(lossOnlyBatches(port)).toStrictEqual([lossOnlyPayload(30, next - 1)]);
        expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 20, lossReports: 1 });
        // … and the new capture's is reported under its own when the timer fires.
        vi.advanceTimersByTime(BRIDGE_LOSS_REPORT_DELAY_MS);
        expect(lossOnlyBatches(port)).toStrictEqual([
          lossOnlyPayload(30, next - 1),
          lossOnlyPayload(20, 0, { captureId: OTHER_CAPTURE_ID }),
        ]);
      });

      /** A genuine batch of `count` events of `captureId`, carrying the agent's own `droppedCount`. */
      function captureBatch(
        captureId: string,
        count: number,
        batchSeq: number,
        droppedCount = 0,
      ): AgentChannelMessage<'telemetry.batch'> {
        return batchFrame(
          batchPayload({ events: eventsOf(count), batchSeq, droppedCount, captureId }),
        );
      }

      /** The two ways a port refuses a frame: it is gone, or its post throws. */
      const PORT_OUTAGES: readonly {
        readonly label: string;
        readonly takeDown: (port: FakePort) => void;
      }[] = [
        {
          label: 'the port disconnected',
          takeDown: (port) => {
            port.emitDisconnect();
          },
        },
        {
          label: 'the post throws',
          takeDown: (port) => {
            port.failPosts();
          },
        },
      ];

      describe('one bucket per capture: a count never takes another capture’s label', () => {
        /** A canonical capture id, distinct for every `index`. */
        function captureIdAt(index: number): string {
          return `cap_${String(index).padStart(16, '0')}`;
        }

        it.each(PORT_OUTAGES)(
          'reports capture A and capture B separately once a port returns, when A’s report failed because $label',
          ({ takeDown }) => {
            const { bridge, runtime, agent, timers } = meteredHarness();
            const first = runtime.latestPort();
            const next = spendWholeBudget(agent);
            // Capture A's tail is refused: 30 events held under A.
            expect(agent.send(sizedBatchFrame(30, next))).toBe(true);
            takeDown(first);

            // Capture B's first batch is refused too, with the agent's own loss
            // of 4. A's report is attempted first and finds no usable port.
            expect(agent.send(captureBatch(OTHER_CAPTURE_ID, 20, 0, 4))).toBe(true);

            expect(lossOnlyBatches(first)).toEqual([]);
            expect(bridge.getStats()).toMatchObject({
              connected: false,
              pendingDroppedCount: 30 + 24,
              lossReports: 0,
              abandonedLossEvents: 0,
            });

            vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);

            const second = runtime.latestPort();
            expect(second).not.toBe(first);
            // Oldest first, one frame per capture, each with its own count and
            // position — never A + B under B.
            expect(lossOnlyBatches(second)).toStrictEqual([
              lossOnlyPayload(30, next - 1),
              lossOnlyPayload(24, 0, { captureId: OTHER_CAPTURE_ID }),
            ]);
            expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 2 });
            expect(timers.pending()).toBe(0);
          },
        );

        it('lets a batch of capture B carry only B’s bucket, after A’s was reported alone', () => {
          const { bridge, runtime, agent, clock, timers } = meteredHarness();
          const first = runtime.latestPort();
          const next = spendWholeBudget(agent);
          expect(agent.send(sizedBatchFrame(30, next))).toBe(true);
          first.emitDisconnect();
          expect(agent.send(captureBatch(OTHER_CAPTURE_ID, 20, 0))).toBe(true);
          expect(bridge.getStats().pendingDroppedCount).toBe(50);

          // B's next batch fits the refilled budget, but the agent keeps it
          // while the bridge is away.
          clock.ms += 1_000;
          const carrier = captureBatch(OTHER_CAPTURE_ID, 10, 1, 2);
          agent.deliver(carrier);
          expect(agent.pending).toEqual([carrier]);

          vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);

          // The agent drains inside bridge.ready: A's bucket goes out on its own
          // first, then B's batch with B's bucket — and nothing of A's — added.
          const second = runtime.latestPort();
          expect(agent.pending).toEqual([]);
          expect(relayedBatches(second)).toStrictEqual([
            lossOnlyPayload(30, next - 1),
            { ...carrier.payload, droppedCount: 2 + 20 },
          ]);
          expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 1 });
          expect(timers.pending()).toBe(0);
        });

        it('abandons the oldest bucket beyond the bound into abandonedLossEvents, never relabelling it', () => {
          const { bridge, runtime, agent, timers } = meteredHarness();
          spendWholeBudget(agent);
          runtime.latestPort().emitDisconnect();
          /** Capture `index` has a refused batch of `10 + index` events. */
          const heldFor = (index: number): number => 10 + index;
          const withinBound = Array.from({ length: BRIDGE_MAX_HELD_LOSS_CAPTURES }, (_, index) =>
            captureIdAt(index),
          );

          for (const [index, captureId] of withinBound.entries()) {
            expect(agent.send(captureBatch(captureId, heldFor(index), 0))).toBe(true);
          }
          // Exactly the bound is held: nothing is abandoned.
          const heldWithinBound = withinBound.reduce((sum, _, index) => sum + heldFor(index), 0);
          expect(bridge.getStats()).toMatchObject({
            pendingDroppedCount: heldWithinBound,
            abandonedLossEvents: 0,
          });

          // One capture more: the oldest bucket (capture 0) is given up.
          const newest = captureIdAt(BRIDGE_MAX_HELD_LOSS_CAPTURES);
          expect(agent.send(captureBatch(newest, heldFor(BRIDGE_MAX_HELD_LOSS_CAPTURES), 0))).toBe(
            true,
          );
          // More loss of a capture that already has a bucket abandons nothing further.
          expect(agent.send(captureBatch(newest, 5, 1))).toBe(true);
          const held = heldWithinBound - heldFor(0) + heldFor(BRIDGE_MAX_HELD_LOSS_CAPTURES) + 5;
          expect(bridge.getStats()).toMatchObject({
            pendingDroppedCount: held,
            abandonedLossEvents: heldFor(0),
          });

          vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);

          // Every surviving capture is reported under its own id with its own
          // count, oldest first; capture 0's count appears nowhere.
          const kept = [...withinBound.slice(1), newest];
          expect(lossOnlyBatches(runtime.latestPort())).toStrictEqual(
            kept.map((captureId, offset) =>
              lossOnlyPayload(heldFor(offset + 1) + (captureId === newest ? 5 : 0), 0, {
                captureId,
              }),
            ),
          );
          expect(bridge.getStats()).toMatchObject({
            pendingDroppedCount: 0,
            lossReports: kept.length,
            abandonedLossEvents: heldFor(0),
          });
          expect(timers.pending()).toBe(0);
        });
      });

      describe('the agent’s own loss-only batch that no port can take (custody case 3)', () => {
        /** The agent's terminal loss-only report: no events, its pending count, its capture. */
        function agentLossReport(
          batchSeq: number,
          droppedCount: number,
          captureId = CAPTURE_ID,
        ): AgentChannelMessage<'telemetry.batch'> {
          return captureBatch(captureId, 0, batchSeq, droppedCount);
        }

        /**
         * A metered harness whose agent records, at every `bridge.ready`, how
         * many frames the newest port had accepted — so a case can tell what
         * the bridge posted after the signal from what it posted before.
         */
        function readyProbedHarness(): ReturnType<typeof meteredHarness> & {
          readonly acceptedAtReady: readonly number[];
        } {
          const acceptedAtReady: number[] = [];
          const probe: { runtime: FakeRuntime | undefined } = { runtime: undefined };
          const harness = meteredHarness({
            onBridgeReady: () => {
              const port = probe.runtime?.ports.at(-1);
              if (port !== undefined) {
                acceptedAtReady.push(port.accepted.length);
              }
            },
          });
          probe.runtime = harness.runtime;
          return { ...harness, acceptedAtReady };
        }

        it.each(PORT_OUTAGES)(
          'acknowledges it when $label, holds it under its own capture, and reports it at once after the next bridge.ready',
          ({ takeDown }) => {
            const { bridge, runtime, agent, timers, acceptedAtReady } = readyProbedHarness();
            const first = runtime.latestPort();
            const next = relayFullBatches(agent, 3);
            takeDown(first);

            // Claimed: the agent's transport clears its count and its capture
            // reset can no longer zero it.
            expect(agent.send(agentLossReport(next, 7))).toBe(true);

            expect(lossOnlyBatches(first)).toEqual([]);
            expect(bridge.getStats()).toMatchObject({
              connected: false,
              relayed: 1 + next,
              unclaimed: 0,
              agentLossReportsHeld: 1,
              pendingDroppedCount: 7,
              lossReports: 0,
            });

            vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);

            // The new port had taken only the re-announcement at bridge.ready;
            // the report followed at once, under the batch's own capture at its
            // last relayed position — no loss-report timer was waited for.
            const second = runtime.latestPort();
            expect(second).not.toBe(first);
            expect(acceptedAtReady).toEqual([1]);
            expect(upstreamTypes(second)).toEqual(['agent.ready', 'telemetry.batch']);
            expect(lossOnlyBatches(second)).toStrictEqual([lossOnlyPayload(7, next - 1)]);
            expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 1 });
            expect(timers.pending()).toBe(0);
          },
        );

        it.each(PORT_OUTAGES)(
          'still reports it under its own capture when $label and the agent has moved to the next capture',
          ({ takeDown }) => {
            const { bridge, runtime, agent, timers } = meteredHarness();
            const next = relayFullBatches(agent, 3);
            takeDown(runtime.latestPort());
            expect(agent.send(agentLossReport(next, 7))).toBe(true);

            // The agent's disarm and the next capture's arm: its count is gone
            // on its side, and the new capture's first batch waits in its
            // custody for the bridge to return.
            const firstOfNext = captureBatch(OTHER_CAPTURE_ID, 10, 0);
            agent.deliver(firstOfNext);
            expect(agent.pending).toEqual([firstOfNext]);
            expect(bridge.getStats().pendingDroppedCount).toBe(7);

            vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);

            // The ended capture's count goes out under its own label before the
            // new capture's batch, which carries none of it.
            expect(agent.pending).toEqual([]);
            expect(relayedBatches(runtime.latestPort())).toStrictEqual([
              lossOnlyPayload(7, next - 1),
              firstOfNext.payload,
            ]);
            expect(bridge.getStats()).toMatchObject({ pendingDroppedCount: 0, lossReports: 1 });
            expect(timers.pending()).toBe(0);
          },
        );

        it('leaves every other batch with no usable port unacknowledged, holding nothing', () => {
          const { bridge, runtime, agent } = meteredHarness();
          const next = relayFullBatches(agent, 3);
          runtime.latestPort().emitDisconnect();

          // An event batch — even one reporting the agent's own loss — stays
          // with the agent, which re-sends it whole after bridge.ready …
          expect(agent.send(captureBatch(CAPTURE_ID, 10, next, 5))).toBe(false);
          // … and so does an empty batch that reports no loss: nothing to hold.
          expect(agent.send(agentLossReport(next, 0))).toBe(false);

          expect(bridge.getStats()).toMatchObject({
            unclaimed: 2,
            agentLossReportsHeld: 0,
            pendingDroppedCount: 0,
          });
        });

        it('relays it like any batch while the port takes it, carrying its own capture’s bucket', () => {
          const { bridge, runtime, agent } = meteredHarness();
          const port = runtime.latestPort();
          const next = spendWholeBudget(agent);
          expect(agent.send(sizedBatchFrame(30, next))).toBe(true);
          const report = agentLossReport(next + 1, 7);

          expect(agent.send(report)).toBe(true);

          // An event-less batch spends nothing, so the spent budget passes it.
          expect(relayedBatches(port).at(-1)).toStrictEqual({
            ...report.payload,
            droppedCount: 7 + 30,
          });
          expect(bridge.getStats()).toMatchObject({
            agentLossReportsHeld: 0,
            pendingDroppedCount: 0,
            lossReports: 0,
          });
        });

        it('leaves it with the agent once a throwing post shows the extension context is gone', () => {
          const { bridge, runtime, agent, timers } = meteredHarness();
          const next = relayFullBatches(agent, 3);
          runtime.id = undefined;
          runtime.latestPort().failPosts();

          // The bridge terminates inside the post and could never report the count.
          expect(agent.send(agentLossReport(next, 7))).toBe(false);

          expect(bridge.getStats()).toMatchObject({
            terminated: true,
            unclaimed: 1,
            agentLossReportsHeld: 0,
            pendingDroppedCount: 0,
          });
          expect(timers.pending()).toBe(0);
        });
      });
    });
  });

  describe('worker → agent relay (downstream)', () => {
    it('delivers agent.config on the node, tagged and versioned, and counts the agent claiming it', () => {
      const { bridge, runtime, agent } = startedHarness();
      const frame = downstreamFrames()['agent.config'];

      runtime.latestPort().emitMessage(frame);

      expect(lastReceived(agent)).toEqual({
        source: BRIDGE_SOURCE_TAG,
        version: PAGE_CHANNEL_VERSION,
        type: 'agent.config',
        payload: configPayload(),
      });
      expect(bridge.getStats()).toMatchObject({ forwardedDown: 1, acknowledgedDown: 1 });
      // Nothing loops back up to the worker.
      expect(runtime.latestPort().post).not.toHaveBeenCalled();
    });

    it.each(BRIDGE_DOWNSTREAM_MESSAGE_TYPES)(
      'delivers %s with the same type and payload',
      (type) => {
        const { bridge, runtime, agent } = startedHarness();
        const frame = downstreamFrames()[type];

        runtime.latestPort().emitMessage(frame);

        expect(lastReceived(agent)).toEqual({
          source: BRIDGE_SOURCE_TAG,
          version: PAGE_CHANNEL_VERSION,
          type,
          payload: frame.payload,
        });
        expect(bridge.getStats().forwardedDown).toBe(1);
      },
    );

    it('counts a frame the agent did not claim as delivered but not acknowledged', () => {
      const { bridge, runtime } = startedHarness({ claimBridgeFrames: false });
      runtime.latestPort().emitMessage(downstreamFrames()['target.request']);
      expect(bridge.getStats()).toMatchObject({ forwardedDown: 1, acknowledgedDown: 0 });
    });

    it('drops every port message that is not a well-formed worker frame', () => {
      const { bridge, runtime, agent } = startedHarness();
      const config = downstreamFrames()['agent.config'];
      const unrecognised: readonly unknown[] = [
        null,
        'agent.config',
        withFields(config, { direction: 'upstream' }),
        withFields(config, { channel: 'another-channel' }),
        withFields(config, { version: PORT_PROTOCOL_VERSION + 1 }),
        withFields(config, { type: 'bridge.ready', payload: {} }),
        withFields(config, { payload: withoutField(config.payload, 'hooks') }),
        withFields(downstreamFrames()['target.request'], { payload: {} }),
        // A protocol-style envelope is not a port frame.
        { id: 'message-0001', type: 'agent.config', ts: 1, payload: config.payload },
      ];

      for (const message of unrecognised) {
        runtime.latestPort().emitMessage(message);
      }

      expect(bridge.getStats()).toMatchObject({
        droppedDownUnrecognised: unrecognised.length,
        forwardedDown: 0,
      });
      expect(agent.receivedTypes()).toEqual(['bridge.ready']);
    });

    it('drops a worker frame that cannot be rendered as JSON', () => {
      const { bridge, runtime, agent } = startedHarness();
      const cyclic: Record<string, unknown> = { ...configPayload() };
      cyclic.self = cyclic;

      runtime
        .latestPort()
        .emitMessage(withFields(downstreamFrames()['agent.config'], { payload: cyclic }));

      expect(bridge.getStats()).toMatchObject({ droppedDownUnrenderable: 1, forwardedDown: 0 });
      expect(agent.receivedTypes()).toEqual(['bridge.ready']);
    });
  });

  describe('port re-establishment after worker suspension', () => {
    /**
     * Enough consecutive failures to pass the doubling phase and sit at the
     * clamp for several attempts, derived from the exported constants alone.
     */
    const CLAMPING_FAILURES =
      Math.ceil(Math.log2(BRIDGE_RECONNECT_MAX_MS / BRIDGE_RECONNECT_BASE_MS)) + 3;

    /** Kill the current port instantly and let its reconnect fire, `count` times. */
    function failFast(harness: Harness, count: number): void {
      for (let failure = 0; failure < count; failure += 1) {
        harness.runtime.latestPort().emitDisconnect();
        const delay = harness.timers.delays().at(-1);
        if (delay === undefined) {
          throw new Error('expected a reconnect to be scheduled');
        }
        vi.advanceTimersByTime(delay);
      }
    }

    it('signals bridge.gone, schedules a reconnect, then reconnects and signals bridge.ready', () => {
      const { bridge, runtime, agent, timers } = startedHarness();
      const first = runtime.latestPort();

      first.emitDisconnect();

      expect(bridge.isConnected()).toBe(false);
      expect(bridge.getStats().connected).toBe(false);
      expect(first.onMessage.listeners.size).toBe(0);
      expect(first.onDisconnect.listeners.size).toBe(0);
      // The worker's end closed; there is nothing for this side to close.
      expect(first.close).not.toHaveBeenCalled();
      expect(agent.receivedTypes()).toEqual(['bridge.ready', 'bridge.gone']);
      expect(timers.delays()).toEqual([BRIDGE_RECONNECT_BASE_MS]);
      expect(runtime.connectSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS - 1);
      expect(runtime.connectSpy).toHaveBeenCalledTimes(1);
      expect(bridge.isConnected()).toBe(false);

      vi.advanceTimersByTime(1);
      expect(runtime.connectSpy).toHaveBeenCalledTimes(2);
      expect(runtime.connectSpy).toHaveBeenLastCalledWith({ name: PORT_CONTENT_BRIDGE });
      const second = runtime.latestPort();
      expect(second).not.toBe(first);
      expect(bridge.getStats()).toMatchObject({ connected: true, reconnects: 1 });
      expect(agent.receivedTypes()).toEqual(['bridge.ready', 'bridge.gone', 'bridge.ready']);

      // The new port relays as the first did.
      agent.send(readyFrame());
      expect(soleUpstreamFrame(second).type).toBe('agent.ready');
    });

    it('re-announces the last agent.ready on every new port before bridge.ready', () => {
      // What the new port had accepted at the moment each bridge.ready reached the agent.
      const acceptedAtReady: number[] = [];
      const harness = createHarness({
        onBridgeReady: (): void => {
          acceptedAtReady.push(harness.runtime.latestPort().accepted.length);
        },
      });
      const { bridge, runtime, agent } = harness;
      bridge.start();
      const frame = readyFrame();
      agent.send(frame);

      runtime.latestPort().emitDisconnect();
      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);

      const reannounced = soleUpstreamFrame(runtime.latestPort());
      expect(reannounced).toMatchObject({ type: 'agent.ready', payload: frame.payload });
      expect(bridge.getStats()).toMatchObject({ relayed: 1, reannounced: 1 });
      // First port: nothing yet. Second port: the re-announcement was already posted.
      expect(acceptedAtReady).toEqual([0, 1]);
    });

    it('grows the delay from the exported base and clamps it at the exported maximum', () => {
      const harness = startedHarness();

      failFast(harness, CLAMPING_FAILURES);

      const delays = harness.timers.delays();
      expect(delays).toEqual(
        Array.from({ length: CLAMPING_FAILURES }, (_, attempt) =>
          Math.min(BRIDGE_RECONNECT_MAX_MS, BRIDGE_RECONNECT_BASE_MS * 2 ** attempt),
        ),
      );
      expect(delays[0]).toBe(BRIDGE_RECONNECT_BASE_MS);
      expect(delays.at(-1)).toBe(BRIDGE_RECONNECT_MAX_MS);
      expect(harness.runtime.connectSpy).toHaveBeenCalledTimes(CLAMPING_FAILURES + 1);
      expect(harness.bridge.getStats().reconnects).toBe(CLAMPING_FAILURES);
    });

    it('keeps jittered delays inside the bounded band', () => {
      const harness = startedHarness({ random: () => 0.999_999 });

      failFast(harness, CLAMPING_FAILURES);

      expect(harness.timers.delays()).toHaveLength(CLAMPING_FAILURES);
      for (const [attempt, delay] of harness.timers.delays().entries()) {
        const ceiling = Math.min(BRIDGE_RECONNECT_MAX_MS, BRIDGE_RECONNECT_BASE_MS * 2 ** attempt);
        // A near-1 draw removes almost the whole jitter fraction, never more.
        expect(delay).toBeLessThan(ceiling);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(ceiling * (1 - BRIDGE_RECONNECT_JITTER)));
      }
    });

    it('resets the backoff after a port that stayed open for the stability window', () => {
      const harness = startedHarness();
      failFast(harness, 3);
      expect(harness.timers.delays()).toEqual([
        BRIDGE_RECONNECT_BASE_MS,
        BRIDGE_RECONNECT_BASE_MS * 2,
        BRIDGE_RECONNECT_BASE_MS * 4,
      ]);

      vi.advanceTimersByTime(BRIDGE_PORT_STABLE_MS);
      harness.runtime.latestPort().emitDisconnect();

      expect(harness.timers.delays().at(-1)).toBe(BRIDGE_RECONNECT_BASE_MS);
    });

    it('resets the backoff once the worker has answered on the port', () => {
      const harness = startedHarness();
      failFast(harness, 3);

      const port = harness.runtime.latestPort();
      port.emitMessage(downstreamFrames()['agent.snapshot']);
      port.emitDisconnect();

      expect(harness.timers.delays().at(-1)).toBe(BRIDGE_RECONNECT_BASE_MS);
    });

    it('retries with backoff when connect() itself throws', () => {
      const { bridge, runtime, agent, timers } = startedHarness();
      runtime.latestPort().emitDisconnect();
      runtime.failNextConnect();

      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);

      expect(runtime.connectSpy).toHaveBeenCalledTimes(2);
      expect(runtime.ports).toHaveLength(1);
      expect(bridge.isConnected()).toBe(false);
      expect(timers.delays()).toEqual([BRIDGE_RECONNECT_BASE_MS, BRIDGE_RECONNECT_BASE_MS * 2]);

      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS * 2);

      expect(runtime.ports).toHaveLength(2);
      expect(bridge.isConnected()).toBe(true);
      expect(agent.receivedTypes()).toEqual(['bridge.ready', 'bridge.gone', 'bridge.ready']);
    });

    it('reads and counts chrome.runtime.lastError on a failed port, and still reconnects', () => {
      const { bridge, runtime, timers } = startedHarness();
      runtime.lastError = { message: 'Could not establish connection.' };

      runtime.latestPort().emitDisconnect();

      expect(bridge.getStats().disconnectErrors).toBe(1);
      expect(timers.delays()).toEqual([BRIDGE_RECONNECT_BASE_MS]);
    });

    it('stops for good once the extension context is invalidated', () => {
      const { bridge, runtime, page, agent, timers } = startedHarness();
      runtime.id = undefined;

      runtime.latestPort().emitDisconnect();

      expect(bridge.getStats()).toMatchObject({ terminated: true, connected: false });
      expect(agent.receivedTypes()).toEqual(['bridge.ready', 'bridge.gone']);
      expect(page.listenerCount()).toBe(0);
      expect(agent.bridgeListenerCount()).toBe(0);
      expect(timers.schedule).not.toHaveBeenCalled();

      vi.advanceTimersByTime(BRIDGE_RECONNECT_MAX_MS * 4);
      bridge.start();
      expect(runtime.connectSpy).toHaveBeenCalledTimes(1);
      expect(page.listenerCount()).toBe(0);
    });

    it('terminates without a re-entrant bridge.gone when a post throws in an invalidated context', () => {
      const { bridge, runtime, agent, timers } = startedHarness();
      runtime.latestPort().failPosts();
      runtime.id = undefined;

      expect(agent.send(readyFrame())).toBe(false);

      expect(bridge.getStats()).toMatchObject({ terminated: true, connected: false });
      expect(agent.receivedTypes()).toEqual(['bridge.ready']);
      expect(agent.bridgeListenerCount()).toBe(0);
      expect(timers.schedule).not.toHaveBeenCalled();
    });

    it('opens a fresh port at once when the page is restored from the back/forward cache', () => {
      const { bridge, runtime, page, agent, timers } = startedHarness();
      const frozen = runtime.latestPort();

      page.target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
      expect(runtime.connectSpy).toHaveBeenCalledTimes(1);

      page.target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));

      expect(frozen.close).toHaveBeenCalledTimes(1);
      expect(runtime.connectSpy).toHaveBeenCalledTimes(2);
      expect(runtime.latestPort()).not.toBe(frozen);
      expect(bridge.isConnected()).toBe(true);
      expect(timers.schedule).not.toHaveBeenCalled();
      expect(agent.receivedTypes()).toEqual(['bridge.ready', 'bridge.ready']);
    });
  });

  describe('stop()', () => {
    it('removes every listener, disconnects the port and tells the agent bridge.gone', () => {
      const { bridge, runtime, page, agent } = startedHarness();
      const port = runtime.latestPort();

      bridge.stop();

      expect(page.listenerCount()).toBe(0);
      expect(agent.bridgeListenerCount()).toBe(0);
      for (const [type, listener] of page.addSpy.mock.calls) {
        expect(page.removeSpy).toHaveBeenCalledWith(type, listener);
      }
      expect(port.close).toHaveBeenCalledTimes(1);
      expect(port.onMessage.listeners.size).toBe(0);
      expect(port.onDisconnect.listeners.size).toBe(0);
      expect(bridge.isConnected()).toBe(false);
      expect(agent.receivedTypes()).toEqual(['bridge.ready', 'bridge.gone']);

      // Nothing is listening any more.
      expect(agent.send(batchFrame())).toBe(false);
      expect(port.post).not.toHaveBeenCalled();
      expect(bridge.getStats().refused).toEqual(zeroRefusals());
    });

    it('cancels a pending reconnect', () => {
      const { bridge, runtime, timers } = startedHarness();
      runtime.latestPort().emitDisconnect();
      const handle: unknown = timers.schedule.mock.results[0]?.value;
      expect(timers.pending()).toBe(1);

      bridge.stop();

      expect(timers.cancel).toHaveBeenCalledWith(handle);
      expect(timers.pending()).toBe(0);
      vi.advanceTimersByTime(BRIDGE_RECONNECT_MAX_MS * 4);
      expect(runtime.connectSpy).toHaveBeenCalledTimes(1);
    });

    it('is idempotent, and a restart reuses the node without a second handshake', () => {
      const { bridge, runtime, page, agent } = startedHarness();

      bridge.stop();
      bridge.stop();
      expect(agent.receivedTypes()).toEqual(['bridge.ready', 'bridge.gone']);

      bridge.start();

      expect(page.dispatchedTypes).toEqual([PAGE_HANDSHAKE_REQUEST_EVENT]);
      expect(runtime.connectSpy).toHaveBeenCalledTimes(2);
      expect(agent.bridgeListenerCount()).toBe(1);
      expect(bridge.isConnected()).toBe(true);
      expect(agent.receivedTypes()).toEqual(['bridge.ready', 'bridge.gone', 'bridge.ready']);
      expect(agent.send(readyFrame())).toBe(true);
    });
  });
});

/*
 * ===========================================================================
 * The worker end of the bridge port — `createPortHub`
 *
 * Every fake below is a structurally complete `chrome.runtime.Port`, so the
 * hub is driven through the exact type `chrome.runtime.onConnect` hands it.
 * Timers are a manual registry: nothing fires unless a case fires it.
 * ===========================================================================
 */

/** The tab every hub case's bridge runs in. */
const HUB_TAB_ID = 7;

/** A second tab, to show what is scoped per tab. */
const OTHER_TAB_ID = 8;

/** A port's `onMessage` listener, as the hub installs it. */
type HubMessageListener = (message: unknown, port: chrome.runtime.Port) => void;

/** A port's `onDisconnect` listener, as the hub installs it. */
type HubDisconnectListener = (port: chrome.runtime.Port) => void;

/** Either listener a port event carries. */
type HubPortListener = HubMessageListener | HubDisconnectListener;

/** A `chrome.events.Event` whose listeners a case can inspect and fire. */
interface HubFakeEvent<Listener extends HubPortListener> extends chrome.events.Event<Listener> {
  readonly listeners: ReadonlySet<Listener>;
}

function createHubEvent<Listener extends HubPortListener>(): HubFakeEvent<Listener> {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener(callback: Listener): void {
      listeners.add(callback);
    },
    removeListener(callback: Listener): void {
      listeners.delete(callback);
    },
    hasListener(callback: Listener): boolean {
      return listeners.has(callback);
    },
    hasListeners(): boolean {
      return listeners.size > 0;
    },
    getRules(
      first: string[] | ((rules: chrome.events.Rule[]) => void),
      second?: (rules: chrome.events.Rule[]) => void,
    ): void {
      (typeof first === 'function' ? first : second)?.([]);
    },
    addRules(rules: chrome.events.Rule[], callback?: (rules: chrome.events.Rule[]) => void): void {
      callback?.([...rules]);
    },
    removeRules(first?: string[] | (() => void), second?: () => void): void {
      (typeof first === 'function' ? first : second)?.();
    },
  };
}

/** A `chrome.runtime.Port` as the worker receives it, driven from the far end. */
interface HubFakePort extends chrome.runtime.Port {
  onMessage: HubFakeEvent<HubMessageListener>;
  onDisconnect: HubFakeEvent<HubDisconnectListener>;
  /** Every frame the hub posted on this port. */
  readonly posted: unknown[];
  /** Records the hub closing this port from its side. */
  readonly disconnectSpy: Mock<() => void>;
  /** Deliver a frame from the far end to every listener still attached. */
  deliver(message: unknown): void;
}

function createHubPort(name: string, sender: chrome.runtime.MessageSender): HubFakePort {
  const onMessage = createHubEvent<HubMessageListener>();
  const onDisconnect = createHubEvent<HubDisconnectListener>();
  const posted: unknown[] = [];
  const disconnectSpy = vi.fn<() => void>();
  const port: HubFakePort = {
    name,
    sender,
    onMessage,
    onDisconnect,
    posted,
    disconnectSpy,
    postMessage: (message: unknown): void => {
      posted.push(message);
    },
    disconnect: disconnectSpy,
    deliver: (message: unknown): void => {
      for (const listener of [...onMessage.listeners]) {
        listener(message, port);
      }
    },
  };
  return port;
}

/** The `chrome.tabs.Tab` a bridge port's sender names. */
function hubTab(tabId: number): chrome.tabs.Tab {
  return {
    id: tabId,
    index: 0,
    url: `${PAGE_ORIGIN}/workspace`,
    pinned: false,
    highlighted: true,
    windowId: 1,
    active: true,
    frozen: false,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    lastAccessed: 0,
  };
}

/** This extension's content script in the top frame of a local app tab. */
function bridgeSender(tabId: number): chrome.runtime.MessageSender {
  return {
    id: EXTENSION_ID,
    tab: hubTab(tabId),
    frameId: 0,
    origin: PAGE_ORIGIN,
    url: `${PAGE_ORIGIN}/workspace`,
  };
}

/** One of this extension's own pages (the panel or the devtools page). */
function extensionPageSender(path: string): chrome.runtime.MessageSender {
  return { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/${path}` };
}

/** One bridge → worker frame, framed exactly as the content script posts it. */
function upstreamFrame<Type extends AgentOutboundType>(
  type: Type,
  payload: BridgeUpstreamPayloads[Type],
): BridgeUpstreamFrame<Type> {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type,
    payload,
  };
}

/**
 * The second document's ids: what a stale or replaced document would carry.
 * Canonical page-agent ids (`doc_` / `prd_` and sixteen `[0-9a-z]`), because
 * the port hub refuses a bridge frame whose ids the agent could not have
 * minted before it ever compares them with the pinned document.
 */
const OTHER_DOCUMENT_ID = 'doc_0000000000000002';
const OTHER_PRODUCER_ID = 'prd_0000000000000002';

/** One-shot timers that fire only when a case says so. */
interface ManualTimers extends WorkerTimerApi {
  /** How many timers are armed. */
  pending(): number;
}

function createManualTimers(): ManualTimers {
  const armed = new Map<number, () => void>();
  let sequence = 0;
  return {
    setTimeout: (handler: () => void): number => {
      sequence += 1;
      armed.set(sequence, handler);
      return sequence;
    },
    clearTimeout: (handle: number): void => {
      armed.delete(handle);
    },
    pending: (): number => armed.size,
  };
}

/** A panel request handler this spec never exercises: a typed refusal. */
function unexercisedRequest(): Promise<Result<never, DebuggenError>> {
  return Promise.resolve(err(workerError('INTERNAL', 'Not exercised by this spec.')));
}

/** Every upstream bridge frame type, mapped to its recording handler. */
type RecordingBridgeHandlers = {
  readonly [Type in AgentOutboundType]: Mock<BridgeMessageHandler<Type>>;
};

interface HubHarness {
  readonly hub: PortHub;
  readonly timers: ManualTimers;
  readonly bridgeHandlers: RecordingBridgeHandlers;
  readonly bridgeClosed: Mock<(event: PortClosedEvent<BridgeConnection>) => void>;
  /** Connect a bridge port for `tabId` and answer its connection id. */
  connectBridge(tabId?: number): { readonly port: HubFakePort; readonly id: WorkerConnectionId };
  /** Connect a panel port and answer its connection id. */
  connectPanel(): { readonly port: HubFakePort; readonly id: WorkerConnectionId };
}

function createHubHarness(): HubHarness {
  const timers = createManualTimers();
  const bridgeHandlers: RecordingBridgeHandlers = {
    'agent.ready': vi.fn<BridgeMessageHandler<'agent.ready'>>(),
    'telemetry.batch': vi.fn<BridgeMessageHandler<'telemetry.batch'>>(),
    'target.described': vi.fn<BridgeMessageHandler<'target.described'>>(),
    'agent.error': vi.fn<BridgeMessageHandler<'agent.error'>>(),
  };
  const handlers: PortRequestHandlers = {
    'panelData.query': unexercisedRequest,
    'source.open': unexercisedRequest,
    'capture.start': unexercisedRequest,
    'capture.stop': unexercisedRequest,
    'target.pick': unexercisedRequest,
    'target.selected': unexercisedRequest,
    'pair.complete': unexercisedRequest,
    'session.snapshot': unexercisedRequest,
    'page.reload': unexercisedRequest,
  };
  const bridgeClosed = vi.fn<(event: PortClosedEvent<BridgeConnection>) => void>();
  const hub = createPortHub({
    runtime: { id: EXTENSION_ID },
    timers,
    handlers,
    bridgeHandlers,
    events: { onBridgeDisconnected: bridgeClosed },
  });

  /** Connect `port` and answer the id of the connection it registered. */
  const connect = (port: HubFakePort): WorkerConnectionId => {
    const before = new Set(hub.listConnections().map((connection) => connection.connectionId));
    hub.handleConnect(port);
    const added = hub.listConnections().find((connection) => !before.has(connection.connectionId));
    if (added === undefined) {
      throw new Error(`the hub refused a ${port.name} port`);
    }
    return added.connectionId;
  };

  return {
    hub,
    timers,
    bridgeHandlers,
    bridgeClosed,
    connectBridge: (tabId = HUB_TAB_ID) => {
      const port = createHubPort(PORT_CONTENT_BRIDGE, bridgeSender(tabId));
      return { port, id: connect(port) };
    },
    connectPanel: () => {
      const port = createHubPort(PORT_PANEL, extensionPageSender('src/panel/index.html'));
      return { port, id: connect(port) };
    },
  };
}

/** The registered descriptor of a bridge connection, or `undefined` once it left. */
function bridgeConnection(hub: PortHub, id: WorkerConnectionId): BridgeConnection | undefined {
  const connection = hub.getConnection(id);
  return connection?.role === PORT_CONTENT_BRIDGE ? connection : undefined;
}

/** The registered descriptor of a panel connection, or `undefined`. */
function panelConnection(hub: PortHub, id: WorkerConnectionId): PanelConnection | undefined {
  const connection = hub.getConnection(id);
  return connection?.role === PORT_PANEL ? connection : undefined;
}

/** A `target.request` the worker would send down a bridge. */
function targetRequestFrame(): BridgeDownstreamMessage<'target.request'> {
  return downstreamFrames()['target.request'];
}

/** The correlation id of the last `target.request` the hub posted on `port`. */
function lastTargetRequestId(port: HubFakePort): string {
  const sent = port.posted.at(-1);
  if (!isBridgeDownstreamMessage(sent) || sent.type !== 'target.request') {
    throw new Error('the hub posted no target.request on this port');
  }
  return sent.payload.requestId;
}

/** A worker-wide `connection` push: the simplest probe of which panels a tab reaches. */
function connectionProbe(): PortPush {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'push',
    kind: 'connection',
    state: { status: 'connected' },
  };
}

/** A telemetry batch whose events are stamped by `producerId`. */
function batchFrom(
  producerId: string,
  overrides: Partial<Pick<PageTelemetryBatchPayload, 'documentId' | 'producerId'>> = {},
): PageTelemetryBatchPayload {
  const base = batchPayload();
  return {
    ...base,
    events: base.events.map((event) => ({ ...event, producerId })),
    producerId,
    ...overrides,
  };
}

describe('createPortHub — a superseded page bridge is retired', () => {
  it('disconnects the previous bridge, rejects its pending round trip and reports it superseded', async () => {
    const harness = createHubHarness();
    const first = harness.connectBridge();
    first.port.deliver(upstreamFrame('agent.ready', readyPayload()));
    const pending = harness.hub.requestFromBridge(HUB_TAB_ID, 'target.request').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(first.port.posted).toHaveLength(1);

    const second = harness.connectBridge();

    const failure = await pending;
    expect(DebuggenError.is(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: 'TRANSPORT_DISCONNECTED',
      details: { reason: 'superseded' },
    });
    expect(first.port.disconnectSpy).toHaveBeenCalledTimes(1);
    expect(first.port.onMessage.listeners.size).toBe(0);
    expect(first.port.onDisconnect.listeners.size).toBe(0);
    expect(bridgeConnection(harness.hub, first.id)).toBeUndefined();
    expect(bridgeConnection(harness.hub, second.id)?.tabId).toBe(HUB_TAB_ID);
    expect(harness.bridgeClosed).toHaveBeenCalledTimes(1);
    expect(harness.bridgeClosed.mock.calls[0]?.[0]).toMatchObject({
      reason: 'superseded',
      connection: { connectionId: first.id, tabId: HUB_TAB_ID },
    });
    expect(harness.timers.pending()).toBe(0);
  });

  it('dispatches nothing that arrives on the retired bridge, and its late disconnect keeps the successor', () => {
    const harness = createHubHarness();
    const first = harness.connectBridge();
    // Listeners Chrome may already have queued a frame for, captured before the
    // hub detaches them.
    const queuedMessage = [...first.port.onMessage.listeners];
    const queuedDisconnect = [...first.port.onDisconnect.listeners];
    const second = harness.connectBridge();

    for (const listener of queuedMessage) {
      listener(upstreamFrame('agent.ready', readyPayload()), first.port);
      listener(upstreamFrame('telemetry.batch', batchPayload()), first.port);
      listener(upstreamFrame('target.described', describedPayload()), first.port);
      listener(upstreamFrame('agent.error', errorPayload()), first.port);
    }
    first.port.deliver(upstreamFrame('agent.ready', readyPayload()));
    for (const listener of queuedDisconnect) {
      listener(first.port);
    }

    for (const handler of Object.values(harness.bridgeHandlers)) {
      expect(handler).not.toHaveBeenCalled();
    }
    expect(harness.bridgeClosed).toHaveBeenCalledTimes(1);
    expect(harness.hub.hasBridge(HUB_TAB_ID)).toBe(true);
    expect(bridgeConnection(harness.hub, second.id)).toBeDefined();

    second.port.deliver(upstreamFrame('agent.ready', readyPayload()));
    expect(harness.bridgeHandlers['agent.ready']).toHaveBeenCalledTimes(1);
    expect(harness.bridgeHandlers['agent.ready'].mock.calls[0]?.[1]).toEqual<BridgeMessageContext>({
      connectionId: second.id,
      tabId: HUB_TAB_ID,
      documentId: DOCUMENT_ID,
    });
  });

  it('addresses sends and round trips to the new bridge only', async () => {
    const harness = createHubHarness();
    const first = harness.connectBridge();
    const queuedMessage = [...first.port.onMessage.listeners];
    const second = harness.connectBridge();

    expect(harness.hub.sendToBridge(HUB_TAB_ID, targetRequestFrame())).toBe(true);
    expect(second.port.posted).toEqual([targetRequestFrame()]);
    expect(first.port.posted).toEqual([]);

    const answer = harness.hub.requestFromBridge(HUB_TAB_ID, 'target.request');
    const requestId = lastTargetRequestId(second.port);
    expect(first.port.posted).toEqual([]);

    // The retired document answering the same correlation id settles nothing.
    const described = { ...describedPayload(), requestId };
    for (const listener of queuedMessage) {
      listener(upstreamFrame('target.described', described), first.port);
    }
    expect(harness.timers.pending()).toBe(1);

    // Nor does the new bridge before its document is pinned; after the pin
    // its answer settles the round trip.
    second.port.deliver(upstreamFrame('target.described', described));
    expect(harness.timers.pending()).toBe(1);
    second.port.deliver(upstreamFrame('agent.ready', readyPayload()));
    second.port.deliver(upstreamFrame('target.described', described));
    await expect(answer).resolves.toEqual(described);
    expect(harness.bridgeHandlers['target.described']).not.toHaveBeenCalled();
    expect(harness.timers.pending()).toBe(0);
  });

  it('keeps the bridges of different tabs side by side', () => {
    const harness = createHubHarness();
    const here = harness.connectBridge(HUB_TAB_ID);
    const there = harness.connectBridge(OTHER_TAB_ID);

    expect(here.port.disconnectSpy).not.toHaveBeenCalled();
    expect(harness.bridgeClosed).not.toHaveBeenCalled();
    expect(harness.hub.hasBridge(HUB_TAB_ID)).toBe(true);
    expect(harness.hub.hasBridge(OTHER_TAB_ID)).toBe(true);
    expect(bridgeConnection(harness.hub, there.id)?.tabId).toBe(OTHER_TAB_ID);
  });
});

describe('createPortHub — every bridge frame belongs to the pinned document', () => {
  it('refuses an agent.ready that changes the documentId or producerId, and passes an identical re-announce', () => {
    const harness = createHubHarness();
    const { port, id } = harness.connectBridge();
    const ready = harness.bridgeHandlers['agent.ready'];

    port.deliver(upstreamFrame('agent.ready', { ...readyPayload(), reactDetected: false }));
    expect(ready).toHaveBeenCalledTimes(1);
    expect(bridgeConnection(harness.hub, id)?.documentId).toBe(DOCUMENT_ID);

    port.deliver(
      upstreamFrame('agent.ready', {
        ...readyPayload(),
        documentId: OTHER_DOCUMENT_ID,
        url: `${PAGE_ORIGIN}/elsewhere`,
      }),
    );
    port.deliver(
      upstreamFrame('agent.ready', { ...readyPayload(), producerId: OTHER_PRODUCER_ID }),
    );
    expect(ready).toHaveBeenCalledTimes(1);
    expect(bridgeConnection(harness.hub, id)).toMatchObject({
      documentId: DOCUMENT_ID,
      url: `${PAGE_ORIGIN}/workspace`,
    });

    // The same document restating itself after a same-document navigation,
    // now that React has appeared.
    const restated = {
      ...readyPayload(),
      url: `${PAGE_ORIGIN}/workspace/next`,
      reactDetected: true,
    };
    port.deliver(upstreamFrame('agent.ready', restated));
    expect(ready).toHaveBeenCalledTimes(2);
    expect(ready.mock.calls[1]?.[0]).toEqual(restated);
    expect(bridgeConnection(harness.hub, id)?.url).toBe(restated.url);
  });

  it('withholds a telemetry.batch sent before agent.ready', () => {
    const harness = createHubHarness();
    const { port } = harness.connectBridge();

    port.deliver(upstreamFrame('telemetry.batch', batchPayload()));
    expect(harness.bridgeHandlers['telemetry.batch']).not.toHaveBeenCalled();

    port.deliver(upstreamFrame('agent.ready', readyPayload()));
    port.deliver(upstreamFrame('telemetry.batch', batchPayload()));
    expect(harness.bridgeHandlers['telemetry.batch']).toHaveBeenCalledTimes(1);
    expect(harness.bridgeHandlers['telemetry.batch'].mock.calls[0]?.[1].documentId).toBe(
      DOCUMENT_ID,
    );
  });

  it('withholds a batch naming a foreign producer or document, or carrying one foreign event', () => {
    const harness = createHubHarness();
    const { port } = harness.connectBridge();
    port.deliver(upstreamFrame('agent.ready', readyPayload()));

    const foreignProducer = batchFrom(OTHER_PRODUCER_ID);
    const foreignDocument = batchFrom(PRODUCER_ID, { documentId: OTHER_DOCUMENT_ID });
    const valid = batchPayload();
    const oneForeignEvent: PageTelemetryBatchPayload = {
      ...valid,
      events: [
        valid.events[0] ?? interactionEvent(),
        { ...fetchEvent(), producerId: OTHER_PRODUCER_ID },
      ],
    };
    const eventsOnlyForeign = batchFrom(OTHER_PRODUCER_ID, { producerId: PRODUCER_ID });

    for (const payload of [foreignProducer, foreignDocument, oneForeignEvent, eventsOnlyForeign]) {
      port.deliver(upstreamFrame('telemetry.batch', payload));
    }
    expect(harness.bridgeHandlers['telemetry.batch']).not.toHaveBeenCalled();

    port.deliver(upstreamFrame('telemetry.batch', valid));
    expect(harness.bridgeHandlers['telemetry.batch']).toHaveBeenCalledTimes(1);
    expect(harness.bridgeHandlers['telemetry.batch'].mock.calls[0]?.[0]).toEqual(valid);
  });

  it('pins each connection separately: a new bridge starts unpinned', () => {
    const harness = createHubHarness();
    const first = harness.connectBridge();
    first.port.deliver(upstreamFrame('agent.ready', readyPayload()));
    const second = harness.connectBridge();

    // The successor serves another document; its own first agent.ready pins it.
    second.port.deliver(upstreamFrame('telemetry.batch', batchFrom(OTHER_PRODUCER_ID)));
    expect(harness.bridgeHandlers['telemetry.batch']).not.toHaveBeenCalled();
    second.port.deliver(
      upstreamFrame('agent.ready', {
        ...readyPayload(),
        documentId: OTHER_DOCUMENT_ID,
        producerId: OTHER_PRODUCER_ID,
      }),
    );
    second.port.deliver(
      upstreamFrame(
        'telemetry.batch',
        batchFrom(OTHER_PRODUCER_ID, { documentId: OTHER_DOCUMENT_ID }),
      ),
    );
    expect(harness.bridgeHandlers['agent.ready']).toHaveBeenCalledTimes(2);
    expect(harness.bridgeHandlers['telemetry.batch']).toHaveBeenCalledTimes(1);
    expect(bridgeConnection(harness.hub, second.id)?.documentId).toBe(OTHER_DOCUMENT_ID);
  });

  it('withholds target.described and agent.error sent before agent.ready, round-trip answers included', () => {
    const harness = createHubHarness();
    const { port } = harness.connectBridge();
    void harness.hub.requestFromBridge(HUB_TAB_ID, 'target.request').catch(() => undefined);
    const requestId = lastTargetRequestId(port);

    port.deliver(upstreamFrame('target.described', { ...describedPayload(), requestId }));
    port.deliver(upstreamFrame('target.described', describedPayload()));
    port.deliver(upstreamFrame('agent.error', errorPayload()));
    expect(harness.bridgeHandlers['target.described']).not.toHaveBeenCalled();
    expect(harness.bridgeHandlers['agent.error']).not.toHaveBeenCalled();
    // The round trip is still waiting for an attributable answer.
    expect(harness.timers.pending()).toBe(1);

    port.deliver(upstreamFrame('agent.ready', readyPayload()));
    port.deliver(upstreamFrame('target.described', describedPayload()));
    port.deliver(upstreamFrame('agent.error', errorPayload()));
    expect(harness.bridgeHandlers['target.described']).toHaveBeenCalledTimes(1);
    expect(harness.bridgeHandlers['agent.error']).toHaveBeenCalledTimes(1);
    expect(harness.bridgeHandlers['agent.error'].mock.calls[0]?.[1].documentId).toBe(DOCUMENT_ID);
  });

  it("answers isCurrentBridge only for the tab's current bridge and its pinned document", () => {
    const harness = createHubHarness();
    const first = harness.connectBridge();
    const unpinned: BridgeMessageContext = {
      connectionId: first.id,
      tabId: HUB_TAB_ID,
      documentId: undefined,
    };
    expect(harness.hub.isCurrentBridge(unpinned)).toBe(false);

    first.port.deliver(upstreamFrame('agent.ready', readyPayload()));
    const pinned = harness.bridgeHandlers['agent.ready'].mock.calls[0]?.[1];
    if (pinned === undefined) {
      throw new Error('agent.ready was not dispatched');
    }
    expect(harness.hub.isCurrentBridge(pinned)).toBe(true);
    expect(harness.hub.isCurrentBridge({ ...pinned, documentId: OTHER_DOCUMENT_ID })).toBe(false);
    expect(harness.hub.isCurrentBridge({ ...pinned, tabId: OTHER_TAB_ID })).toBe(false);
    expect(harness.hub.isCurrentBridge({ ...pinned, connectionId: 'bridge-unknown' })).toBe(false);

    // Superseded: the context captured before the retirement no longer holds.
    const second = harness.connectBridge();
    expect(harness.hub.isCurrentBridge(pinned)).toBe(false);
    second.port.deliver(upstreamFrame('agent.ready', readyPayload()));
    const successor = harness.bridgeHandlers['agent.ready'].mock.calls[1]?.[1];
    expect(successor?.connectionId).toBe(second.id);
    expect(successor !== undefined && harness.hub.isCurrentBridge(successor)).toBe(true);

    // Closed: its page went away.
    for (const listener of [...second.port.onDisconnect.listeners]) {
      listener(second.port);
    }
    expect(successor !== undefined && harness.hub.isCurrentBridge(successor)).toBe(false);
  });
});

describe("createPortHub — a panel's inspected tab is fixed once set", () => {
  it('binds an unassociated panel, accepts the same tab again and refuses any other tab', () => {
    const harness = createHubHarness();
    const { port, id } = harness.connectPanel();
    expect(panelConnection(harness.hub, id)?.tabId).toBeUndefined();
    expect(harness.hub.pushToPanels(HUB_TAB_ID, connectionProbe())).toBe(0);

    expect(harness.hub.bindPanelTab(id, HUB_TAB_ID)).toBe(true);
    expect(panelConnection(harness.hub, id)?.tabId).toBe(HUB_TAB_ID);
    expect(harness.hub.bindPanelTab(id, HUB_TAB_ID)).toBe(true);

    expect(harness.hub.bindPanelTab(id, OTHER_TAB_ID)).toBe(false);
    expect(panelConnection(harness.hub, id)?.tabId).toBe(HUB_TAB_ID);
    expect(harness.hub.pushToPanels(OTHER_TAB_ID, connectionProbe())).toBe(0);
    expect(harness.hub.pushToPanels(HUB_TAB_ID, connectionProbe())).toBe(1);
    expect(port.posted).toHaveLength(1);
  });

  it('refuses a tab id that is not a tab, and a connection that is not a panel', () => {
    const harness = createHubHarness();
    const panel = harness.connectPanel();
    const bridge = harness.connectBridge();
    const devtools = createHubPort(PORT_DEVTOOLS, extensionPageSender('src/devtools/index.html'));
    harness.hub.handleConnect(devtools);

    expect(harness.hub.bindPanelTab(panel.id, -1)).toBe(false);
    expect(harness.hub.bindPanelTab(bridge.id, HUB_TAB_ID)).toBe(false);
    expect(harness.hub.bindPanelTab('panel-unknown', HUB_TAB_ID)).toBe(false);
    expect(panelConnection(harness.hub, panel.id)?.tabId).toBeUndefined();
  });
});

/*
 * ===========================================================================
 * The panel's inspected tab across the worker — `createWorker`
 *
 * The composed worker against in-memory fakes: storage areas seeded with the
 * registry's own snapshot format, events that record their listeners, and no
 * devtools credential — so no socket opens and no HTTP call is made. Ports are
 * handed to the worker's hub exactly as `chrome.runtime.onConnect` would.
 * ===========================================================================
 */

/** The tab bound to {@link SESSION_A} in the seeded registry. */
const SESSION_A_TAB_ID = 11;

/** The tab a panel inspects in the stale-claim cases. */
const INSPECTED_TAB_ID = 12;

/** A tab with no binding. */
const UNBOUND_TAB_ID = 13;

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

/** A `WorkerEvent` that records its listeners. */
interface RecordingEvent<Listener> extends WorkerEvent<Listener> {
  readonly listeners: ReadonlySet<Listener>;
}

function recordingEvent<Listener>(): RecordingEvent<Listener> {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener(listener: Listener): void {
      listeners.add(listener);
    },
    removeListener(listener: Listener): void {
      listeners.delete(listener);
    },
  };
}

/** A `chrome.storage` area held in memory. */
interface MemoryArea {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Readonly<Record<string, unknown>>): Promise<void>;
  remove(keys: string): Promise<void>;
}

function memoryArea(initial: Readonly<Record<string, unknown>> = {}): MemoryArea {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (keys: string): Promise<Record<string, unknown>> =>
      Promise.resolve(data.has(keys) ? { [keys]: data.get(keys) } : {}),
    set: (items: Readonly<Record<string, unknown>>): Promise<void> => {
      for (const [key, value] of Object.entries(items)) {
        data.set(key, value);
      }
      return Promise.resolve();
    },
    remove: (keys: string): Promise<void> => {
      data.delete(keys);
      return Promise.resolve();
    },
  };
}

/** A binding as the registry writes it to `chrome.storage.session`. */
function storedBinding(tabId: number, sessionId: string): TabBindingRecord {
  return {
    tabId,
    sessionId,
    url: `${PAGE_ORIGIN}/workspace`,
    origin: PAGE_ORIGIN,
    boundAt: Date.now(),
  };
}

/** Every worker a case created, disposed in `afterEach`. */
const liveWorkers: DebugGeneratorWorker[] = [];

/** What a composed worker is given besides its seeded bindings. */
interface WorkerOptions {
  /** Where the worker logs; defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;
  /**
   * Holds every `chrome.storage.session` read until it settles — the
   * registry's hydration, and so the worker's whole cold start, included.
   */
  readonly sessionGate?: Promise<void> | undefined;
}

/** A `chrome.storage` area whose every read waits for `gate` first. */
function gatedArea(area: MemoryArea, gate: Promise<void>): MemoryArea {
  return {
    get: async (keys: string): Promise<Record<string, unknown>> => {
      await gate;
      return area.get(keys);
    },
    set: (items: Readonly<Record<string, unknown>>): Promise<void> => area.set(items),
    remove: (keys: string): Promise<void> => area.remove(keys),
  };
}

/** Compose a worker whose registry starts with `bindings`, and wait for its cold start. */
async function startedWorker(
  bindings: readonly TabBindingRecord[],
  options: WorkerOptions = {},
): Promise<DebugGeneratorWorker> {
  const worker = composeWorker(bindings, options);
  await worker.ready;
  return worker;
}

/** Compose a worker whose registry starts with `bindings`, without waiting for its cold start. */
function composeWorker(
  bindings: readonly TabBindingRecord[],
  options: WorkerOptions = {},
): DebugGeneratorWorker {
  const snapshot = Object.fromEntries(bindings.map((binding) => [String(binding.tabId), binding]));
  const session = memoryArea({ [BINDING_STORAGE_KEY]: snapshot });
  const environment: WorkerEnvironment = {
    runtime: {
      id: EXTENSION_ID,
      onConnect: recordingEvent(),
      onInstalled: recordingEvent(),
      onStartup: recordingEvent(),
    },
    tabs: {
      reload: (): Promise<void> => Promise.resolve(),
      get: (): Promise<{ readonly url?: string }> => Promise.resolve({}),
      onUpdated: recordingEvent(),
      onRemoved: recordingEvent(),
    },
    alarms: {
      create: (): Promise<void> => Promise.resolve(),
      clear: (): Promise<boolean> => Promise.resolve(false),
      onAlarm: recordingEvent(),
    },
    storage: {
      local: memoryArea(),
      session:
        options.sessionGate === undefined ? session : gatedArea(session, options.sessionGate),
    },
    webSocketConstructor: WebSocket,
    timers: createManualTimers(),
    logger: options.logger ?? noopLogger,
  };
  const worker = createWorker(environment);
  liveWorkers.push(worker);
  return worker;
}

/** Play a DevTools page announcing `tabId`, and answer its port. */
function announceDevtools(worker: DebugGeneratorWorker, tabId: number): HubFakePort {
  const port = createHubPort(PORT_DEVTOOLS, extensionPageSender('src/devtools/index.html'));
  worker.hub.handleConnect(port);
  port.deliver({
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type: 'devtools.hello',
    payload: { tabId },
  });
  return port;
}

/** Open a panel port on the worker, and answer the port and its connection id. */
function openWorkerPanel(worker: DebugGeneratorWorker): {
  readonly port: HubFakePort;
  readonly id: WorkerConnectionId;
} {
  const port = createHubPort(PORT_PANEL, extensionPageSender('src/panel/index.html'));
  worker.hub.handleConnect(port);
  const connection = worker.hub
    .listConnections()
    .filter((candidate) => candidate.role === PORT_PANEL)
    .at(-1);
  if (connection === undefined) {
    throw new Error('the worker refused the panel port');
  }
  return { port, id: connection.connectionId };
}

/** Send one panel request on `port` and wait for the worker's answer to it. */
async function askWorker<Kind extends PortRequestKind>(
  port: HubFakePort,
  kind: Kind,
  payload: PortRequestPayloads[Kind],
): Promise<PortResponse> {
  const frame: PortRequestFrame<Kind> = {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'request',
    requestId: newPortRequestId(),
    kind,
    payload,
  };
  const answerOf = (): PortResponse | undefined =>
    port.posted.find(
      (posted): posted is PortResponse =>
        isPortResponse(posted) && posted.requestId === frame.requestId,
    );
  port.deliver(frame);
  await vi.waitFor(() => {
    expect(answerOf()).toBeDefined();
  });
  const answer = answerOf();
  if (answer === undefined) {
    throw new Error(`the worker did not answer ${kind}`);
  }
  return answer;
}

/** The binding a `session.snapshot` answer carries. */
function snapshotBinding(answer: PortResponse): PanelBindingState {
  if (answer.kind !== 'session.snapshot' || !answer.ok) {
    throw new Error('expected a successful session.snapshot answer');
  }
  return answer.payload.binding;
}

/** The inspected tab the worker's hub holds for a panel connection. */
function workerPanelTab(worker: DebugGeneratorWorker, id: WorkerConnectionId): number | undefined {
  return panelConnection(worker.hub, id)?.tabId;
}

describe("createWorker — a session claim never moves a panel's inspected tab", () => {
  afterEach(() => {
    for (const worker of liveWorkers.splice(0)) {
      worker.dispose();
    }
    vi.useRealTimers();
  });

  it('keeps an associated panel on its tab when it names a session bound to another tab', async () => {
    const worker = await startedWorker([storedBinding(SESSION_A_TAB_ID, SESSION_A)]);
    announceDevtools(worker, INSPECTED_TAB_ID);
    const panel = openWorkerPanel(worker);

    const first = await askWorker(panel.port, 'session.snapshot', {});
    expect(snapshotBinding(first)).toEqual({ kind: 'unbound' });
    expect(workerPanelTab(worker, panel.id)).toBe(INSPECTED_TAB_ID);

    // The stale claim: session A was bound to tab 11 while this port was down.
    const claimed = await askWorker(panel.port, 'session.snapshot', { sessionId: SESSION_A });
    expect(snapshotBinding(claimed)).toEqual({ kind: 'unbound' });
    expect(workerPanelTab(worker, panel.id)).toBe(INSPECTED_TAB_ID);
    expect(worker.hub.pushToPanels(SESSION_A_TAB_ID, connectionProbe())).toBe(0);
  });

  it('leaves an unassociated panel unassociated when its claim names a tab no DevTools page announced', async () => {
    const worker = await startedWorker([storedBinding(SESSION_A_TAB_ID, SESSION_A)]);
    const panel = openWorkerPanel(worker);

    const claimed = await askWorker(panel.port, 'session.snapshot', { sessionId: SESSION_A });
    expect(snapshotBinding(claimed)).toEqual({ kind: 'unbound' });
    expect(workerPanelTab(worker, panel.id)).toBeUndefined();

    // Its own DevTools page announcing itself is what associates it.
    announceDevtools(worker, INSPECTED_TAB_ID);
    expect(workerPanelTab(worker, panel.id)).toBe(INSPECTED_TAB_ID);
  });

  it('never lets a claim choose among DevTools pages awaiting a panel', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const worker = await startedWorker([storedBinding(SESSION_A_TAB_ID, SESSION_A)]);
    announceDevtools(worker, SESSION_A_TAB_ID);
    vi.setSystemTime(Date.now() + 1_000);
    announceDevtools(worker, INSPECTED_TAB_ID);

    // Session A was re-bound to tab 11 during the revival burst; this panel
    // names no tab of its own, so nothing trustworthy says which window it is.
    const claiming = openWorkerPanel(worker);
    const answer = await askWorker(claiming.port, 'session.snapshot', { sessionId: SESSION_A });
    expect(snapshotBinding(answer)).toEqual({ kind: 'unbound' });
    expect(workerPanelTab(worker, claiming.id)).toBeUndefined();

    // Nor does announcement order: a panel naming nothing is not given the newest.
    const plain = openWorkerPanel(worker);
    await askWorker(plain.port, 'session.snapshot', {});
    expect(workerPanelTab(worker, plain.id)).toBeUndefined();
    expect(worker.hub.pushToPanels(SESSION_A_TAB_ID, connectionProbe())).toBe(0);
    expect(worker.hub.pushToPanels(INSPECTED_TAB_ID, connectionProbe())).toBe(0);
  });
});

/** The error code of a failed answer, or `undefined` for a success. */
function refusalCode(answer: PortResponse): string | undefined {
  return answer.ok ? undefined : answer.error.code;
}

/** A panel-data query any node could make; its content is never reached here. */
const SPANS_QUERY = { source: 'spans' } as const;

describe('createWorker — a panel is associated with the inspected tab it names, or with none', () => {
  afterEach(() => {
    for (const worker of liveWorkers.splice(0)) {
      worker.dispose();
    }
  });

  it("binds a panel naming tab B to B although its stale claim names A's session and both tabs await", async () => {
    const worker = await startedWorker([storedBinding(SESSION_A_TAB_ID, SESSION_A)]);
    announceDevtools(worker, SESSION_A_TAB_ID);
    announceDevtools(worker, INSPECTED_TAB_ID);

    const panel = openWorkerPanel(worker);
    const answer = await askWorker(panel.port, 'session.snapshot', {
      inspectedTabId: INSPECTED_TAB_ID,
      sessionId: SESSION_A,
    });
    expect(snapshotBinding(answer)).toEqual({ kind: 'unbound' });
    expect(workerPanelTab(worker, panel.id)).toBe(INSPECTED_TAB_ID);
    expect(worker.hub.pushToPanels(SESSION_A_TAB_ID, connectionProbe())).toBe(0);

    const query = await askWorker(panel.port, 'panelData.query', {
      sessionId: SESSION_A,
      query: SPANS_QUERY,
    });
    const capture = await askWorker(panel.port, 'capture.start', { sessionId: SESSION_A });
    const pick = await askWorker(panel.port, 'target.pick', {
      sessionId: SESSION_A,
      enabled: true,
    });
    expect(refusalCode(query)).toBe('TAB_NOT_BOUND');
    expect(refusalCode(capture)).toBe('TAB_NOT_BOUND');
    expect(refusalCode(pick)).toBe('TAB_NOT_BOUND');
    // The refusals changed nothing: the port still inspects B.
    expect(workerPanelTab(worker, panel.id)).toBe(INSPECTED_TAB_ID);

    // The panel of A's own window names A and is hydrated with A's binding.
    const own = openWorkerPanel(worker);
    const ownAnswer = await askWorker(own.port, 'session.snapshot', {
      inspectedTabId: SESSION_A_TAB_ID,
      sessionId: SESSION_A,
    });
    expect(snapshotBinding(ownAnswer)).toMatchObject({
      kind: 'bound',
      sessionId: SESSION_A,
      tabId: SESSION_A_TAB_ID,
    });
    expect(workerPanelTab(worker, own.id)).toBe(SESSION_A_TAB_ID);
  });

  it('refuses a named tab that contradicts the association the port already has', async () => {
    const worker = await startedWorker([storedBinding(SESSION_A_TAB_ID, SESSION_A)]);
    announceDevtools(worker, SESSION_A_TAB_ID);
    const panel = openWorkerPanel(worker);
    await askWorker(panel.port, 'session.snapshot', {});
    expect(workerPanelTab(worker, panel.id)).toBe(SESSION_A_TAB_ID);

    const contradicting = await askWorker(panel.port, 'session.snapshot', {
      inspectedTabId: INSPECTED_TAB_ID,
    });
    expect(snapshotBinding(contradicting)).toEqual({ kind: 'unbound' });
    expect(workerPanelTab(worker, panel.id)).toBe(SESSION_A_TAB_ID);
    expect(worker.hub.pushToPanels(INSPECTED_TAB_ID, connectionProbe())).toBe(0);
  });

  it('leaves a panel naming no tab unassociated while two DevTools tabs await, and refuses its session requests', async () => {
    const worker = await startedWorker([
      storedBinding(SESSION_A_TAB_ID, SESSION_A),
      storedBinding(INSPECTED_TAB_ID, SESSION_B),
    ]);
    announceDevtools(worker, SESSION_A_TAB_ID);
    announceDevtools(worker, INSPECTED_TAB_ID);

    const panel = openWorkerPanel(worker);
    const answer = await askWorker(panel.port, 'session.snapshot', {});
    expect(snapshotBinding(answer)).toEqual({ kind: 'unbound' });
    expect(workerPanelTab(worker, panel.id)).toBeUndefined();

    for (const sessionId of [SESSION_A, SESSION_B]) {
      const query = await askWorker(panel.port, 'panelData.query', {
        sessionId,
        query: SPANS_QUERY,
      });
      const capture = await askWorker(panel.port, 'capture.start', { sessionId });
      const pick = await askWorker(panel.port, 'target.pick', { sessionId, enabled: true });
      expect(refusalCode(query)).toBe('TAB_NOT_BOUND');
      expect(refusalCode(capture)).toBe('TAB_NOT_BOUND');
      expect(refusalCode(pick)).toBe('TAB_NOT_BOUND');
    }

    // A DevTools page re-announcing itself does not break the tie either.
    announceDevtools(worker, INSPECTED_TAB_ID);
    expect(workerPanelTab(worker, panel.id)).toBeUndefined();
  });

  it('associates a panel naming no tab when exactly one DevTools tab awaits a panel', async () => {
    const worker = await startedWorker([storedBinding(SESSION_A_TAB_ID, SESSION_A)]);
    announceDevtools(worker, SESSION_A_TAB_ID);

    const panel = openWorkerPanel(worker);
    const answer = await askWorker(panel.port, 'session.snapshot', {});
    expect(snapshotBinding(answer)).toMatchObject({
      kind: 'bound',
      sessionId: SESSION_A,
      tabId: SESSION_A_TAB_ID,
    });
    expect(workerPanelTab(worker, panel.id)).toBe(SESSION_A_TAB_ID);
  });

  it('adopts only a panel that already asked without naming a tab, and only one to one', async () => {
    const worker = await startedWorker([storedBinding(INSPECTED_TAB_ID, SESSION_B)]);

    // Connected, but no snapshot request yet: it may still name its own tab.
    const silent = openWorkerPanel(worker);
    announceDevtools(worker, INSPECTED_TAB_ID);
    expect(workerPanelTab(worker, silent.id)).toBeUndefined();
    const named = await askWorker(silent.port, 'session.snapshot', {
      inspectedTabId: UNBOUND_TAB_ID,
    });
    expect(snapshotBinding(named)).toEqual({ kind: 'unbound' });
    expect(workerPanelTab(worker, silent.id)).toBe(UNBOUND_TAB_ID);

    // Two panels that asked without a tab while none awaited: a hello matches
    // neither, because it cannot tell them apart.
    const revived = await startedWorker([storedBinding(INSPECTED_TAB_ID, SESSION_B)]);
    const first = openWorkerPanel(revived);
    const other = openWorkerPanel(revived);
    await askWorker(first.port, 'session.snapshot', {});
    await askWorker(other.port, 'session.snapshot', {});
    announceDevtools(revived, INSPECTED_TAB_ID);
    expect(workerPanelTab(revived, first.id)).toBeUndefined();
    expect(workerPanelTab(revived, other.id)).toBeUndefined();

    // Once only one waits, the next announcement adopts it and hydrates it.
    for (const listener of [...other.port.onDisconnect.listeners]) {
      listener(other.port);
    }
    announceDevtools(revived, INSPECTED_TAB_ID);
    expect(workerPanelTab(revived, first.id)).toBe(INSPECTED_TAB_ID);
    await vi.waitFor(() => {
      const bindingPush = first.port.posted.find(
        (frame): frame is Extract<PortPush, { readonly kind: 'binding' }> =>
          isPortPush(frame) && frame.kind === 'binding',
      );
      expect(bindingPush?.state).toMatchObject({ kind: 'bound', tabId: INSPECTED_TAB_ID });
    });
  });
});

describe('createWorker — panel requests are held to the session bound to the panel tab', () => {
  afterEach(() => {
    for (const worker of liveWorkers.splice(0)) {
      worker.dispose();
    }
  });

  /** The error code of a failed answer, or `undefined` for a success. */
  function failureCode(answer: PortResponse): string | undefined {
    return answer.ok ? undefined : answer.error.code;
  }

  it('refuses an unassociated panel', async () => {
    const worker = await startedWorker([storedBinding(SESSION_A_TAB_ID, SESSION_A)]);
    const panel = openWorkerPanel(worker);

    const capture = await askWorker(panel.port, 'capture.start', { sessionId: SESSION_A });
    const pick = await askWorker(panel.port, 'target.pick', {
      sessionId: SESSION_A,
      enabled: true,
    });

    expect(failureCode(capture)).toBe('TAB_NOT_BOUND');
    expect(failureCode(pick)).toBe('TAB_NOT_BOUND');
  });

  it('refuses a session bound to another tab, or to no tab, and a panel tab bound to none', async () => {
    const worker = await startedWorker([
      storedBinding(SESSION_A_TAB_ID, SESSION_A),
      storedBinding(INSPECTED_TAB_ID, SESSION_B),
    ]);
    announceDevtools(worker, INSPECTED_TAB_ID);
    const panel = openWorkerPanel(worker);
    await askWorker(panel.port, 'session.snapshot', {});
    expect(workerPanelTab(worker, panel.id)).toBe(INSPECTED_TAB_ID);

    const otherTab = await askWorker(panel.port, 'capture.stop', { sessionId: SESSION_A });
    const pickOther = await askWorker(panel.port, 'target.pick', {
      sessionId: SESSION_A,
      enabled: true,
    });
    const noTab = await askWorker(panel.port, 'capture.start', { sessionId: 'session-ended' });
    expect(failureCode(otherTab)).toBe('TAB_NOT_BOUND');
    expect(failureCode(pickOther)).toBe('TAB_NOT_BOUND');
    expect(failureCode(noTab)).toBe('TAB_NOT_BOUND');

    announceDevtools(worker, UNBOUND_TAB_ID);
    const unboundPanel = openWorkerPanel(worker);
    await askWorker(unboundPanel.port, 'session.snapshot', {});
    expect(workerPanelTab(worker, unboundPanel.id)).toBe(UNBOUND_TAB_ID);
    const unboundTab = await askWorker(unboundPanel.port, 'capture.start', {
      sessionId: SESSION_B,
    });
    expect(failureCode(unboundTab)).toBe('TAB_NOT_BOUND');
  });

  it("serves the panel's own session on its own tab", async () => {
    const worker = await startedWorker([storedBinding(INSPECTED_TAB_ID, SESSION_B)]);
    const devtools = announceDevtools(worker, INSPECTED_TAB_ID);
    const panel = openWorkerPanel(worker);
    await askWorker(panel.port, 'session.snapshot', {});
    // Picker mode is the page agent's alone, so the tab's own agent is attached.
    const bridge = connectWorkerBridge(worker, INSPECTED_TAB_ID);
    bridge.deliver(upstreamFrame('agent.ready', readyPayload()));

    const pick = await askWorker(panel.port, 'target.pick', {
      sessionId: SESSION_B,
      enabled: true,
    });

    expect(pick).toMatchObject({ ok: true, payload: { active: true } });
    // The page agent of the panel's own tab is armed; the DevTools page of the
    // same tab is never asked for its `$0` selection.
    expect(
      bridge.posted.some(
        (frame) => isBridgeDownstreamMessage(frame) && frame.type === 'target.request',
      ),
    ).toBe(true);
    expect(
      devtools.posted.some(
        (frame) => isDevtoolsDownstreamMessage(frame) && frame.type === 'devtools.describeRequest',
      ),
    ).toBe(false);
  });
});

/** Connect a content-script bridge for `tabId` to the worker's hub, and answer its port. */
function connectWorkerBridge(worker: DebugGeneratorWorker, tabId: number): HubFakePort {
  const port = createHubPort(PORT_CONTENT_BRIDGE, bridgeSender(tabId));
  worker.hub.handleConnect(port);
  return port;
}

/** The ready payload of the document that replaces {@link readyPayload}'s. */
function successorReadyPayload(): PageAgentReadyPayload {
  return { ...readyPayload(), documentId: OTHER_DOCUMENT_ID, producerId: OTHER_PRODUCER_ID };
}

/** A logger collecting every record at every level, for the cases that assert on drops. */
function recordingLogger(): { readonly logger: Logger; readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });
  return { logger, records };
}

/** The message a worker logs when a bridge handler drops a superseded frame. */
const STALE_BRIDGE_FRAME_LOG = 'A frame from a superseded page bridge was dropped.';

/**
 * The verdict lines a worker logs for a selection it handed towards the
 * service — one per forwarded selection, whatever the service made of it.
 */
const AGENT_SELECTION_VERDICT_LOGS: readonly string[] = [
  'The service accepted a selected element.',
  'The service refused a selected element.',
  'The service did not confirm a selected element.',
  'A selected element could not be sent to the service.',
];

/** Whether `records` hold a stale-frame drop for one bridge frame type. */
function droppedStale(records: readonly LogRecord[], type: AgentOutboundType): boolean {
  return records.some(
    (record) => record.message === STALE_BRIDGE_FRAME_LOG && record.fields.type === type,
  );
}

/** The protocol `error` pushes a panel port received. */
function errorPushes(port: HubFakePort): PortPush[] {
  return port.posted.filter(
    (frame): frame is PortPush =>
      isPortPush(frame) && frame.kind === 'protocol' && frame.message.type === 'error',
  );
}

describe('createWorker — a bridge frame that waited is checked again before it acts', () => {
  afterEach(() => {
    for (const worker of liveWorkers.splice(0)) {
      worker.dispose();
    }
  });

  it("drops an agent.ready that waited out the worker's cold start after a new bridge pinned its document", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = composeWorker([], { sessionGate: gate });
    const handleAgentReady = vi.spyOn(worker.agent, 'handleAgentReady');

    // The page loads, which wakes the worker: its report waits for `ready`.
    const old = connectWorkerBridge(worker, SESSION_A_TAB_ID);
    old.deliver(upstreamFrame('agent.ready', readyPayload()));
    // The tab navigates before start-up finishes; the new document pins itself.
    const current = connectWorkerBridge(worker, SESSION_A_TAB_ID);
    current.deliver(upstreamFrame('agent.ready', successorReadyPayload()));
    expect(old.disconnectSpy).toHaveBeenCalledTimes(1);
    expect(handleAgentReady).not.toHaveBeenCalled();

    release();
    await worker.ready;
    await vi.waitFor(() => {
      expect(worker.agent.getReadiness(SESSION_A_TAB_ID)?.documentId).toBe(OTHER_DOCUMENT_ID);
    });
    expect(handleAgentReady.mock.calls).toEqual([[SESSION_A_TAB_ID, successorReadyPayload()]]);
  });

  it('does not forward an element described by a document superseded while the registry was read', async () => {
    const { logger, records } = recordingLogger();
    const worker = await startedWorker([storedBinding(SESSION_A_TAB_ID, SESSION_A)], { logger });
    const old = connectWorkerBridge(worker, SESSION_A_TAB_ID);
    old.deliver(upstreamFrame('agent.ready', readyPayload()));

    old.deliver(upstreamFrame('target.described', describedPayload()));
    const current = connectWorkerBridge(worker, SESSION_A_TAB_ID);
    await vi.waitFor(() => {
      expect(droppedStale(records, 'target.described')).toBe(true);
    });
    // An agent pick that passed every document check is handed to the service
    // and logged with its verdict; this worker has no socket, so it is unsent.
    const forwarded = (): number =>
      records
        .filter((record) => AGENT_SELECTION_VERDICT_LOGS.includes(record.message))
        .filter((record) => record.fields.source === 'agent').length;
    expect(forwarded()).toBe(0);

    // The current document's own selection is forwarded.
    current.deliver(upstreamFrame('agent.ready', successorReadyPayload()));
    current.deliver(upstreamFrame('target.described', describedPayload()));
    await vi.waitFor(() => {
      expect(forwarded()).toBe(1);
    });
  });

  it("does not push an agent.error of a document superseded while the registry was read to the tab's panels", async () => {
    const { logger, records } = recordingLogger();
    const worker = await startedWorker([storedBinding(SESSION_A_TAB_ID, SESSION_A)], { logger });
    const panel = openWorkerPanel(worker);
    await askWorker(panel.port, 'session.snapshot', { inspectedTabId: SESSION_A_TAB_ID });
    const old = connectWorkerBridge(worker, SESSION_A_TAB_ID);
    old.deliver(upstreamFrame('agent.ready', readyPayload()));

    old.deliver(upstreamFrame('agent.error', errorPayload()));
    const current = connectWorkerBridge(worker, SESSION_A_TAB_ID);
    await vi.waitFor(() => {
      expect(droppedStale(records, 'agent.error')).toBe(true);
    });
    expect(errorPushes(panel.port)).toEqual([]);

    current.deliver(upstreamFrame('agent.ready', successorReadyPayload()));
    current.deliver(upstreamFrame('agent.error', errorPayload()));
    await vi.waitFor(() => {
      expect(errorPushes(panel.port)).toHaveLength(1);
    });
  });
});

/*
 * ===========================================================================
 * The panel's side of the claim — `startPanelConnection`
 * ===========================================================================
 */

describe("startPanelConnection — the panel claims and presents only its inspected tab's binding", () => {
  /** Every panel connection a case started, stopped in `afterEach`. */
  const handles: PanelConnectionHandle[] = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      handle.stop();
    }
    // The last stop tears down at the end of the current microtask checkpoint.
    await Promise.resolve();
    await Promise.resolve();
    resetPanelStore({ includeConnection: true });
  });

  /** Start the panel inside DevTools on `inspectedTabId`, and answer its first port. */
  function startInDevtools(inspectedTabId: number): FakePort {
    const ports: FakePort[] = [];
    const handle = startPanelConnection({
      runtime: {
        connect: (connectInfo: { name: string }): FakePort => {
          const port = createFakePort(connectInfo.name);
          ports.push(port);
          return port;
        },
      },
      readDevtools: () => ({ inspectedWindow: { tabId: inspectedTabId } }),
      setTimeout: (): unknown => undefined,
      clearTimeout: (): void => {},
      random: (): number => 0,
      logger: noopLogger,
    });
    handles.push(handle);
    const port = ports[0];
    if (port === undefined) {
      throw new Error('the panel opened no port');
    }
    return port;
  }

  /** The `session.snapshot` request the panel posted first on `port`. */
  function handshakeOn(port: FakePort): PortRequestFrame<'session.snapshot'> {
    for (const [frame] of port.post.mock.calls) {
      if (isPortRequest(frame) && isPortRequestOfMethod(frame, 'session.snapshot')) {
        return frame;
      }
    }
    throw new Error('the panel posted no session.snapshot request');
  }

  function bound(tabId: number, sessionId: string): PanelBindingState {
    return { kind: 'bound', sessionId, tabId, url: `${PAGE_ORIGIN}/workspace` };
  }

  it('always names its inspected tab, and its stored session only when that binding is of that tab', async () => {
    setBindingState(bound(SESSION_A_TAB_ID, SESSION_A));
    const foreign = startInDevtools(INSPECTED_TAB_ID);
    expect(handshakeOn(foreign).payload).toEqual({ inspectedTabId: INSPECTED_TAB_ID });
    expect(isPortRequest(handshakeOn(foreign))).toBe(true);

    for (const handle of handles.splice(0)) {
      handle.stop();
    }
    await Promise.resolve();
    await Promise.resolve();

    setBindingState(bound(INSPECTED_TAB_ID, SESSION_A));
    const own = startInDevtools(INSPECTED_TAB_ID);
    expect(handshakeOn(own).payload).toEqual({
      inspectedTabId: INSPECTED_TAB_ID,
      sessionId: SESSION_A,
    });
  });

  it('names neither a tab nor a session outside DevTools', () => {
    setBindingState(bound(INSPECTED_TAB_ID, SESSION_A));
    const ports: FakePort[] = [];
    handles.push(
      startPanelConnection({
        runtime: {
          connect: (connectInfo: { name: string }): FakePort => {
            const port = createFakePort(connectInfo.name);
            ports.push(port);
            return port;
          },
        },
        readDevtools: () => undefined,
        setTimeout: (): unknown => undefined,
        clearTimeout: (): void => {},
        random: (): number => 0,
        logger: noopLogger,
      }),
    );
    const port = ports[0];
    if (port === undefined) {
      throw new Error('the panel opened no port');
    }
    expect(handshakeOn(port).payload).toEqual({});
  });

  it('refuses, in the shared guard, a snapshot request naming something that is not a tab', () => {
    const request = (payload: Readonly<Record<string, unknown>>): unknown => ({
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'request',
      requestId: newPortRequestId(),
      kind: 'session.snapshot',
      payload,
    });
    expect(isPortRequest(request({ inspectedTabId: INSPECTED_TAB_ID }))).toBe(true);
    expect(isPortRequest(request({ inspectedTabId: 0, sessionId: SESSION_A }))).toBe(true);
    for (const inspectedTabId of [-1, 1.5, '12', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isPortRequest(request({ inspectedTabId }))).toBe(false);
    }
  });

  it("records unbound for a snapshot answer or binding push naming another tab's session", async () => {
    const port = startInDevtools(INSPECTED_TAB_ID);
    const request = handshakeOn(port);

    port.emitMessage(
      portOk(request, {
        connection: { status: 'connected' },
        binding: bound(SESSION_A_TAB_ID, SESSION_A),
      }),
    );
    await vi.waitFor(() => {
      expect(getPanelSnapshot().connection.status).toBe('connected');
    });
    expect(getPanelSnapshot().connection.binding).toEqual({ kind: 'unbound' });

    const bindingPush = (state: PanelBindingState): PortPush => ({
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'push',
      kind: 'binding',
      state,
    });
    port.emitMessage(bindingPush(bound(SESSION_A_TAB_ID, SESSION_A)));
    expect(getPanelSnapshot().connection.binding).toEqual({ kind: 'unbound' });

    port.emitMessage(bindingPush(bound(INSPECTED_TAB_ID, SESSION_B)));
    expect(getPanelSnapshot().connection.binding).toEqual(bound(INSPECTED_TAB_ID, SESSION_B));
  });
});
