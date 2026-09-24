/**
 * Unit spec for `../src/content/bridge.ts` — the isolated-world content script
 * that is the only path between the MAIN-world page agent and the Manifest V3
 * service worker.
 *
 * The bridge is two boundaries at once, and this spec proves both:
 *
 * - **A filter.** It receives `window.postMessage` traffic from a page the
 *   developer's application controls, so everything that is not a well-formed
 *   frame from this document's agent — another window, another origin, another
 *   tag (its own included), another channel version, an unknown type, a
 *   malformed payload, an unserialisable value, an oversize frame — is dropped
 *   silently, counted in `BridgeStats`, and never reaches the port.
 * - **A relay that survives worker suspension.** It forwards accepted frames
 *   upstream with their payloads unchanged (port framing only — the service
 *   worker, not the bridge, builds `@debuggen/protocol` envelopes), delivers
 *   worker frames downstream tagged, versioned, signed with the document's
 *   handshake token and targeted at the page's own origin, buffers nothing, and
 *   drives the page agent's buffering through the `bridge.ready` /
 *   `bridge.gone` handshake while it reconnects with a bounded backoff.
 *
 * The real exports are the authority here. Where they refine the original
 * brief, the spec follows them: the drop vocabulary is the exported
 * `BRIDGE_DROP_REASONS` tuple (the brief's eight reasons plus
 * `malformed-payload`), every bridge → page frame carries the handshake
 * `token` (page channel version 2), and upstream frames carry the port's
 * `channel` / `version` / `direction` framing around the untouched payload.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). Every fake — the `chrome.runtime`
 * surface, its ports, the page window and the reconnect scheduler — is local to
 * this file and injected through `createContentBridge(deps)`; the only global
 * stub is the `chrome` object the bootstrap test needs. Vitest's fake timers
 * drive every reconnect, so no case waits on a wall clock, and an `afterEach`
 * stops every bridge a case created and asserts that nothing — no window
 * listener, no port listener, no pending timer — is left attached. Every
 * fixture is built from the constants `../src/shared/messages.ts` exports;
 * only the mirror-contract case pins literal values, because that module's
 * header names this spec as the check that its copies still match the page
 * agent's transport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  BRIDGE_DROP_REASONS,
  BRIDGE_PORT_STABLE_MS,
  BRIDGE_RECONNECT_BASE_MS,
  BRIDGE_RECONNECT_JITTER,
  BRIDGE_RECONNECT_MAX_MS,
  computeReconnectDelay,
  createContentBridge,
  shouldAcceptPageMessage,
} from '../src/content/bridge';
import type {
  BridgeDropReason,
  BridgeStats,
  ChromeRuntimeLike,
  ContentBridge,
  PageMessageEventLike,
  PortEventLike,
  PortLike,
  WindowLike,
} from '../src/content/bridge';
import {
  AGENT_OUTBOUND_TYPES,
  AGENT_SOURCE_TAG,
  BRIDGE_DOWNSTREAM_MESSAGE_TYPES,
  BRIDGE_SOURCE_TAG,
  EXTENSION_CHANNEL,
  MAX_PAGE_MESSAGE_BYTES,
  PAGE_CHANNEL_VERSION,
  PAGE_HANDSHAKE_OFFER_EVENT,
  PAGE_HANDSHAKE_REQUEST_EVENT,
  PAGE_HANDSHAKE_TOKEN_LENGTH,
  PAGE_MESSAGE_TARGET_ORIGIN,
  PORT_CONTENT_BRIDGE,
  PORT_PROTOCOL_VERSION,
  approximatePageMessageBytes,
  isBridgeChannelMessage,
  isBridgeUpstreamMessage,
  isPageHandshakeToken,
} from '../src/shared/messages';
import type {
  AgentChannelMessage,
  AgentOutboundType,
  BridgeChannelMessage,
  BridgeDownstreamMessage,
  BridgeDownstreamPayloads,
  BridgeDownstreamType,
  BridgeUpstreamMessage,
  PageAgentErrorPayload,
  PageAgentReadyPayload,
  PageChannelEnvelope,
  PageTargetDescribedPayload,
  PageTelemetryBatchPayload,
} from '../src/shared/messages';

/*
 * ===========================================================================
 * Fixture values — neutral, and obviously synthetic
 * ===========================================================================
 */

/** The origin of the page the bridge serves: a generic local dev server. */
const PAGE_ORIGIN = 'http://localhost:4100';

/** A different origin — what an embedded frame or an opener would report. */
const FOREIGN_ORIGIN = 'https://elsewhere.example';

/** A fake extension id; a non-empty string is all the bridge reads. */
const EXTENSION_ID = 'test-extension-id';

/** A well-formed but obviously fake handshake token (64 lowercase hex characters). */
const HANDSHAKE_TOKEN = 'f00d'.repeat(PAGE_HANDSHAKE_TOKEN_LENGTH / 'f00d'.length);

/** A second well-formed token: what a forged or foreign bridge frame would carry. */
const OTHER_HANDSHAKE_TOKEN = 'beef'.repeat(PAGE_HANDSHAKE_TOKEN_LENGTH / 'beef'.length);

/** The producer and document ids every agent fixture shares. */
const PRODUCER_ID = 'producer-0001';
const DOCUMENT_ID = 'document-0001';

/** One telemetry event, exactly as the agent ships it inside a batch. */
type PageTelemetryEvent = PageTelemetryBatchPayload['events'][number];

function interactionEvent(): PageTelemetryEvent {
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
    producerId: PRODUCER_ID,
    seq: 0,
  };
}

function fetchEvent(): PageTelemetryEvent {
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
    producerId: PRODUCER_ID,
    seq: 1,
  };
}

function readyPayload(): PageAgentReadyPayload {
  return {
    documentId: DOCUMENT_ID,
    producerId: PRODUCER_ID,
    url: `${PAGE_ORIGIN}/workspace`,
    installedBeforeReact: true,
    reactDetected: true,
  };
}

function batchPayload(): PageTelemetryBatchPayload {
  return {
    events: [interactionEvent(), fetchEvent()],
    producerId: PRODUCER_ID,
    documentId: DOCUMENT_ID,
    batchSeq: 0,
    droppedCount: 0,
    captureId: 'capture-0001',
    sessionId: 'session-0001',
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

function errorPayload(): PageAgentErrorPayload {
  return {
    code: 'hook-unavailable',
    message: 'The fiber hook could not be attached.',
    family: 'react',
  };
}

/** One well-formed agent → bridge frame per agent frame type. */
type AgentFrameFixtures = { readonly [Type in AgentOutboundType]: AgentChannelMessage<Type> };

function agentFrames(): AgentFrameFixtures {
  return {
    'agent.ready': {
      source: AGENT_SOURCE_TAG,
      version: PAGE_CHANNEL_VERSION,
      type: 'agent.ready',
      payload: readyPayload(),
    },
    'telemetry.batch': {
      source: AGENT_SOURCE_TAG,
      version: PAGE_CHANNEL_VERSION,
      type: 'telemetry.batch',
      payload: batchPayload(),
    },
    'target.described': {
      source: AGENT_SOURCE_TAG,
      version: PAGE_CHANNEL_VERSION,
      type: 'target.described',
      payload: describedPayload(),
    },
    'agent.error': {
      source: AGENT_SOURCE_TAG,
      version: PAGE_CHANNEL_VERSION,
      type: 'agent.error',
      payload: errorPayload(),
    },
  };
}

function configPayload(): BridgeDownstreamPayloads['agent.config'] {
  return {
    sessionId: 'session-0001',
    captureId: 'capture-0001',
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
 * inputs (`PageMessageEventLike.data`, a port message), never cast to a valid
 * frame type.
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

/** A telemetry batch frame whose single event carries `attributes`. */
function batchFrameWithAttributes(attributes: Record<string, unknown>): unknown {
  const frame = agentFrames()['telemetry.batch'];
  return withFields(frame, {
    payload: withFields(frame.payload, { events: [{ ...interactionEvent(), attributes }] }),
  });
}

/** A telemetry batch frame containing a reference cycle — valid shape, no JSON rendering. */
function cyclicBatchFrame(): unknown {
  const attributes: Record<string, unknown> = { note: 'self-referencing attribute' };
  attributes.self = attributes;
  return batchFrameWithAttributes(attributes);
}

/**
 * An `agent.error` frame whose JSON rendering is exactly `targetSize` long,
 * measured with the agent's own {@link approximatePageMessageBytes}. Each
 * padding character adds exactly one code unit, so the size is exact.
 */
function paddedErrorFrame(targetSize: number): AgentChannelMessage<'agent.error'> {
  const base: AgentChannelMessage<'agent.error'> = {
    source: AGENT_SOURCE_TAG,
    version: PAGE_CHANNEL_VERSION,
    type: 'agent.error',
    payload: { code: 'oversize-probe', message: '' },
  };
  const padding = targetSize - approximatePageMessageBytes(base);
  return { ...base, payload: { ...base.payload, message: 'x'.repeat(padding) } };
}

/** A frame posted by a bridge that is not this one: the bridge's tag, a foreign token. */
function forgedBridgeFrame(): BridgeChannelMessage<'bridge.ready'> {
  return {
    source: BRIDGE_SOURCE_TAG,
    version: PAGE_CHANNEL_VERSION,
    type: 'bridge.ready',
    token: OTHER_HANDSHAKE_TOKEN,
    payload: {},
  };
}

/** An otherwise valid batch frame carrying another sender's tag. */
function foreignTaggedFrame(
  source: string,
): PageChannelEnvelope<string, 'telemetry.batch', PageTelemetryBatchPayload> {
  return { ...agentFrames()['telemetry.batch'], source };
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
  /** Records every frame the bridge posts on this port. */
  readonly post: Mock<(message: unknown) => void>;
  /** Records the bridge closing this port from its side. */
  readonly close: Mock<() => void>;
  /** Deliver a message from the worker. */
  emitMessage(message: unknown): void;
  /** Close the worker's end — what an MV3 worker suspension looks like here. */
  emitDisconnect(): void;
  /** Make every later post throw, as a port that died unreported does. */
  failPosts(): void;
}

function createFakePort(name: string): FakePort {
  const onMessage = createPortEvent<(message: unknown) => void>();
  const onDisconnect = createPortEvent<(port: unknown) => void>();
  let dead = false;
  const post = vi.fn<(message: unknown) => void>(() => {
    if (dead) {
      throw new Error('Attempting to use a disconnected port object');
    }
  });
  const close = vi.fn<() => void>();
  const port: FakePort = {
    name,
    onMessage,
    onDisconnect,
    post,
    close,
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
      dead = true;
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
}

interface FakeRuntimeOptions {
  /** `false` builds a runtime whose extension context is already invalidated (no id). */
  readonly contextAlive?: boolean;
}

function createFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const id = options.contextAlive === false ? undefined : EXTENSION_ID;
  const ports: FakePort[] = [];
  let failNext = false;
  const connectSpy = vi.fn((connectInfo: { name: string }): PortLike => {
    if (failNext) {
      failNext = false;
      throw new Error('Could not establish connection. Receiving end does not exist.');
    }
    const port = createFakePort(connectInfo.name);
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
  };
}

/** A `(event: unknown) => void` window listener, as `WindowLike` types it. */
type WindowListener = (event: unknown) => void;

/** One `window.postMessage` call. */
interface PagePost {
  readonly message: unknown;
  readonly targetOrigin: string;
}

/** The page `window` slice, with its listeners, posts and dispatches observable. */
interface FakeWindow extends WindowLike {
  /** Every `postMessage` call, in order. */
  readonly posts: readonly PagePost[];
  /** The `type` of every event passed to `dispatchEvent`, in order. */
  readonly dispatchedTypes: readonly string[];
  readonly addSpy: Mock<(type: string, listener: WindowListener) => void>;
  readonly removeSpy: Mock<(type: string, listener: WindowListener) => void>;
  readonly postSpy: Mock<(message: unknown, targetOrigin: string) => void>;
  readonly dispatchSpy: Mock<(event: Event) => boolean>;
  /** Listeners currently registered for `type`, or for every type. */
  listenerCount(type?: string): number;
  /** Invoke every listener currently registered for `type`. */
  emit(type: string, event: unknown): void;
  /** What the page agent does, unsolicited or when asked: disclose a token. */
  offerToken(detail: unknown): void;
}

interface FakeWindowOptions {
  /**
   * Answer the bridge's handshake request the way the page agent does:
   * synchronously, inside the dispatch, with {@link HANDSHAKE_TOKEN}.
   */
  readonly answerHandshake?: boolean;
}

function createFakeWindow(options: FakeWindowOptions = {}): FakeWindow {
  const answerHandshake = options.answerHandshake ?? true;
  const listeners = new Map<string, Set<WindowListener>>();
  const posts: PagePost[] = [];
  const dispatchedTypes: string[] = [];

  function emit(type: string, event: unknown): void {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  const addSpy = vi.fn((type: string, listener: WindowListener): void => {
    const registered = listeners.get(type) ?? new Set<WindowListener>();
    registered.add(listener);
    listeners.set(type, registered);
  });
  const removeSpy = vi.fn((type: string, listener: WindowListener): void => {
    listeners.get(type)?.delete(listener);
  });
  const postSpy = vi.fn((message: unknown, targetOrigin: string): void => {
    posts.push({ message, targetOrigin });
  });
  const dispatchSpy = vi.fn((event: Event): boolean => {
    dispatchedTypes.push(event.type);
    if (answerHandshake && event.type === PAGE_HANDSHAKE_REQUEST_EVENT) {
      emit(PAGE_HANDSHAKE_OFFER_EVENT, { detail: HANDSHAKE_TOKEN });
    }
    return true;
  });

  return {
    location: { origin: PAGE_ORIGIN },
    addEventListener: addSpy,
    removeEventListener: removeSpy,
    postMessage: postSpy,
    dispatchEvent: dispatchSpy,
    posts,
    dispatchedTypes,
    addSpy,
    removeSpy,
    postSpy,
    dispatchSpy,
    listenerCount: (type?: string): number =>
      type === undefined
        ? [...listeners.values()].reduce((total, registered) => total + registered.size, 0)
        : (listeners.get(type)?.size ?? 0),
    emit,
    offerToken: (detail: unknown): void => {
      emit(PAGE_HANDSHAKE_OFFER_EVENT, { detail });
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

/** A page `message` event as the bridge sees it: posted by `win`, from its origin. */
function pageMessage(
  win: WindowLike,
  data: unknown,
  overrides: Partial<Pick<PageMessageEventLike, 'source' | 'origin'>> = {},
): PageMessageEventLike {
  return {
    source: 'source' in overrides ? overrides.source : win,
    origin: overrides.origin ?? win.location.origin,
    data,
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

function expectUpstreamFrame(value: unknown): BridgeUpstreamMessage {
  if (!isBridgeUpstreamMessage(value)) {
    throw new Error('expected a well-formed bridge → worker frame');
  }
  return value;
}

function expectPageFrame(value: unknown): BridgeChannelMessage {
  if (!isBridgeChannelMessage(value)) {
    throw new Error('expected a well-formed bridge → page frame');
  }
  return value;
}

/** Every frame the bridge posted on `port`, narrowed. */
function upstreamFrames(port: FakePort): BridgeUpstreamMessage[] {
  return port.post.mock.calls.map(([message]) => expectUpstreamFrame(message));
}

/** The one frame the bridge posted on `port`. */
function soleUpstreamFrame(port: FakePort): BridgeUpstreamMessage {
  const frames = upstreamFrames(port);
  expect(frames).toHaveLength(1);
  const [frame] = frames;
  if (frame === undefined) {
    throw new Error('expected exactly one bridge → worker frame');
  }
  return frame;
}

/** Every frame the bridge posted to the page, narrowed. */
function pageFrames(page: FakeWindow): BridgeChannelMessage[] {
  return page.posts.map(({ message }) => expectPageFrame(message));
}

/** The `type` of every frame the bridge posted to the page. */
function pageFrameTypes(page: FakeWindow): string[] {
  return pageFrames(page).map((frame) => frame.type);
}

/** The most recent `window.postMessage` call. */
function lastPagePost(page: FakeWindow): PagePost {
  const post = page.posts.at(-1);
  if (post === undefined) {
    throw new Error('the bridge has not posted to the page');
  }
  return post;
}

/** A drop counter set with every reason at zero, derived from the exported tuple. */
function zeroDrops(): Record<string, number> {
  return Object.fromEntries(BRIDGE_DROP_REASONS.map((reason) => [reason, 0]));
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
  readonly timers: FakeScheduler;
}

interface HarnessOptions extends FakeWindowOptions, FakeRuntimeOptions {
  /** The jitter source; `() => 0` (no jitter) unless a case says otherwise. */
  readonly random?: () => number;
}

/** Every harness a case created, stopped and checked for leaks in `afterEach`. */
const liveHarnesses: Harness[] = [];

function createHarness(options: HarnessOptions = {}): Harness {
  const runtime = createFakeRuntime(options);
  const page = createFakeWindow(options);
  const timers = createScheduler();
  const bridge = createContentBridge({
    chrome: runtime,
    window: page,
    setTimeout: timers.schedule,
    clearTimeout: timers.cancel,
    random: options.random ?? ((): number => 0),
    now: (): number => Date.now(),
  });
  const harness: Harness = { bridge, runtime, page, timers };
  liveHarnesses.push(harness);
  return harness;
}

/** A harness whose bridge has been started (listeners attached, port open, token held). */
function startedHarness(options: HarnessOptions = {}): Harness {
  const harness = createHarness(options);
  harness.bridge.start();
  return harness;
}

/** Deliver a frame from the page agent through the bridge's `message` listener. */
function postFromAgent(page: FakeWindow, data: unknown): void {
  page.emit('message', pageMessage(page, data));
}

/*
 * ===========================================================================
 * The drop matrix — one or more page events per drop reason
 *
 * Keyed by `BridgeDropReason`, so a reason added to the exported tuple without
 * a case here fails `tsc -b`, and the completeness case below fails `vitest`.
 * Every variant fails exactly the named check: all earlier checks pass.
 * Oversize variants use the real cap, so each variant also drives the bridge,
 * which filters with the default `MAX_PAGE_MESSAGE_BYTES`.
 * ===========================================================================
 */

interface DropVariant {
  readonly label: string;
  /** Build the event against the window the bridge serves. */
  readonly build: (win: WindowLike) => PageMessageEventLike;
}

const DROP_CASES: { readonly [Reason in BridgeDropReason]: readonly DropVariant[] } = {
  'not-window-source': [
    {
      label: 'posted by another window (an embedded frame or an opener)',
      build: (win) =>
        pageMessage(win, agentFrames()['telemetry.batch'], { source: createFakeWindow() }),
    },
    {
      label: 'with no source window at all',
      build: (win) => pageMessage(win, agentFrames()['telemetry.batch'], { source: null }),
    },
  ],
  'origin-mismatch': [
    {
      label: 'from a foreign origin',
      build: (win) =>
        pageMessage(win, agentFrames()['telemetry.batch'], { origin: FOREIGN_ORIGIN }),
    },
    {
      label: 'from an opaque origin',
      build: (win) => pageMessage(win, agentFrames()['telemetry.batch'], { origin: 'null' }),
    },
    {
      label: 'with an empty origin',
      build: (win) => pageMessage(win, agentFrames()['telemetry.batch'], { origin: '' }),
    },
  ],
  'not-object': [
    {
      label: 'a JSON string of a valid frame',
      build: (win) => pageMessage(win, JSON.stringify(agentFrames()['telemetry.batch'])),
    },
    { label: 'null', build: (win) => pageMessage(win, null) },
    {
      label: 'an array wrapping a valid frame',
      build: (win) => pageMessage(win, [agentFrames()['telemetry.batch']]),
    },
    { label: 'a number', build: (win) => pageMessage(win, 42) },
  ],
  'wrong-tag': [
    {
      label: 'untagged',
      build: (win) => pageMessage(win, withoutField(agentFrames()['telemetry.batch'], 'source')),
    },
    {
      label: 'tagged by another sender',
      build: (win) => pageMessage(win, foreignTaggedFrame('another-extension')),
    },
    {
      label: 'tagged with a differently cased agent tag',
      build: (win) => pageMessage(win, foreignTaggedFrame(AGENT_SOURCE_TAG.toUpperCase())),
    },
    {
      label: "tagged with the bridge's own downward tag and a foreign token",
      build: (win) => pageMessage(win, forgedBridgeFrame()),
    },
  ],
  'version-mismatch': [
    {
      label: 'from an older channel version',
      build: (win) =>
        pageMessage(
          win,
          withFields(agentFrames()['telemetry.batch'], { version: PAGE_CHANNEL_VERSION - 1 }),
        ),
    },
    {
      label: 'from a newer channel version',
      build: (win) =>
        pageMessage(
          win,
          withFields(agentFrames()['telemetry.batch'], { version: PAGE_CHANNEL_VERSION + 1 }),
        ),
    },
    {
      label: 'with the version as a string',
      build: (win) =>
        pageMessage(
          win,
          withFields(agentFrames()['telemetry.batch'], { version: String(PAGE_CHANNEL_VERSION) }),
        ),
    },
    {
      label: 'without a version',
      build: (win) => pageMessage(win, withoutField(agentFrames()['telemetry.batch'], 'version')),
    },
  ],
  'unknown-type': [
    {
      label: 'a downstream frame type claimed by the page',
      build: (win) =>
        pageMessage(
          win,
          withFields(agentFrames()['agent.error'], {
            type: 'agent.config' satisfies BridgeDownstreamType,
          }),
        ),
    },
    {
      label: 'an invented frame type',
      build: (win) =>
        pageMessage(win, withFields(agentFrames()['agent.error'], { type: 'telemetry.flush' })),
    },
    {
      label: 'without a type',
      build: (win) => pageMessage(win, withoutField(agentFrames()['agent.error'], 'type')),
    },
  ],
  'malformed-payload': [
    {
      label: 'a batch whose events are not an array',
      build: (win) => {
        const frame = agentFrames()['telemetry.batch'];
        return pageMessage(
          win,
          withFields(frame, { payload: withFields(frame.payload, { events: 'not-an-array' }) }),
        );
      },
    },
    {
      label: 'a batch containing a non-object event',
      build: (win) => {
        const frame = agentFrames()['telemetry.batch'];
        return pageMessage(
          win,
          withFields(frame, { payload: withFields(frame.payload, { events: ['not-an-event'] }) }),
        );
      },
    },
    {
      label: 'a batch with a negative sequence number',
      build: (win) => {
        const frame = agentFrames()['telemetry.batch'];
        return pageMessage(
          win,
          withFields(frame, { payload: withFields(frame.payload, { batchSeq: -1 }) }),
        );
      },
    },
    {
      label: 'an agent.ready without its document id',
      build: (win) => {
        const frame = agentFrames()['agent.ready'];
        return pageMessage(
          win,
          withFields(frame, { payload: withoutField(frame.payload, 'documentId') }),
        );
      },
    },
    {
      label: 'a target.described whose target has no selector',
      build: (win) =>
        pageMessage(
          win,
          withFields(agentFrames()['target.described'], { payload: { target: { tagName: 'a' } } }),
        ),
    },
    {
      label: 'a null payload',
      build: (win) => pageMessage(win, withFields(agentFrames()['agent.error'], { payload: null })),
    },
  ],
  unserializable: [
    {
      label: 'a batch containing a reference cycle',
      build: (win) => pageMessage(win, cyclicBatchFrame()),
    },
    {
      label: 'a batch containing a BigInt',
      build: (win) => pageMessage(win, batchFrameWithAttributes({ transferred: 10n })),
    },
  ],
  oversize: [
    {
      label: 'one code unit over the cap',
      build: (win) => pageMessage(win, paddedErrorFrame(MAX_PAGE_MESSAGE_BYTES + 1)),
    },
    {
      label: 'a batch whose event carries a cap-sized attribute',
      build: (win) =>
        pageMessage(win, batchFrameWithAttributes({ blob: 'y'.repeat(MAX_PAGE_MESSAGE_BYTES) })),
    },
  ],
};

/** The matrix flattened into `it.each` rows. */
const DROP_ROWS = BRIDGE_DROP_REASONS.flatMap((reason) =>
  DROP_CASES[reason].map((variant) => ({ reason, label: variant.label, variant })),
);

/** The page → bridge checks in the order they run, each row failing its own check and later ones. */
interface PrecedenceRow {
  readonly expected: BridgeDropReason;
  readonly build: (win: WindowLike) => PageMessageEventLike;
  readonly maxBytes?: number;
}

const PRECEDENCE_ROWS: readonly PrecedenceRow[] = [
  {
    expected: 'not-window-source',
    build: (win) => pageMessage(win, null, { source: createFakeWindow(), origin: FOREIGN_ORIGIN }),
  },
  {
    expected: 'origin-mismatch',
    build: (win) => pageMessage(win, null, { origin: FOREIGN_ORIGIN }),
  },
  { expected: 'not-object', build: (win) => pageMessage(win, 'not-a-frame') },
  {
    expected: 'wrong-tag',
    build: (win) =>
      pageMessage(win, { source: 'elsewhere', version: -1, type: 'nothing', payload: null }),
  },
  {
    expected: 'version-mismatch',
    build: (win) =>
      pageMessage(win, { source: AGENT_SOURCE_TAG, version: -1, type: 'nothing', payload: null }),
  },
  {
    expected: 'unknown-type',
    build: (win) =>
      pageMessage(win, {
        source: AGENT_SOURCE_TAG,
        version: PAGE_CHANNEL_VERSION,
        type: 'nothing',
        payload: null,
      }),
  },
  {
    expected: 'malformed-payload',
    build: (win) => {
      const loop: Record<string, unknown> = {};
      loop.self = loop;
      return pageMessage(win, {
        source: AGENT_SOURCE_TAG,
        version: PAGE_CHANNEL_VERSION,
        type: 'telemetry.batch',
        payload: { events: 'not-an-array', loop },
      });
    },
    maxBytes: 1,
  },
  { expected: 'unserializable', build: (win) => pageMessage(win, cyclicBatchFrame()), maxBytes: 1 },
  {
    expected: 'oversize',
    build: (win) => pageMessage(win, agentFrames()['telemetry.batch']),
    maxBytes: 1,
  },
];

/*
 * ===========================================================================
 * Suites
 * ===========================================================================
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('page-channel mirror contract', () => {
  it('keeps the literals the page agent transport publishes', () => {
    // `../src/shared/messages.ts` mirrors `packages/telemetry/src/browser/transport.ts`
    // and names this spec as the check that the copy still matches the owner.
    expect(AGENT_SOURCE_TAG).toBe('debuggen-agent');
    expect(BRIDGE_SOURCE_TAG).toBe('debuggen-bridge');
    expect(PAGE_CHANNEL_VERSION).toBe(2);
    expect(PAGE_MESSAGE_TARGET_ORIGIN).toBe('/');
    expect(PAGE_HANDSHAKE_REQUEST_EVENT).toBe('debuggen-bridge-handshake');
    expect(PAGE_HANDSHAKE_OFFER_EVENT).toBe('debuggen-agent-handshake');
    expect(PAGE_HANDSHAKE_TOKEN_LENGTH).toBe(64);
    expect(MAX_PAGE_MESSAGE_BYTES).toBe(512 * 1024);
    expect(AGENT_OUTBOUND_TYPES).toEqual([
      'agent.ready',
      'telemetry.batch',
      'target.described',
      'agent.error',
    ]);
    expect(PORT_CONTENT_BRIDGE).toBe('debuggen.bridge');
  });

  it('never targets the wildcard origin and keeps the two tags apart', () => {
    expect(PAGE_MESSAGE_TARGET_ORIGIN).not.toBe('*');
    expect(AGENT_SOURCE_TAG).not.toBe(BRIDGE_SOURCE_TAG);
  });

  it('uses fixture tokens the contract accepts', () => {
    expect(isPageHandshakeToken(HANDSHAKE_TOKEN)).toBe(true);
    expect(isPageHandshakeToken(OTHER_HANDSHAKE_TOKEN)).toBe(true);
    expect(HANDSHAKE_TOKEN).not.toBe(OTHER_HANDSHAKE_TOKEN);
  });
});

describe('shouldAcceptPageMessage — the pure page → bridge filter', () => {
  it('covers every exported drop reason, including the eight of the original brief', () => {
    expect(Object.keys(DROP_CASES).sort()).toEqual([...BRIDGE_DROP_REASONS].sort());
    for (const reason of BRIDGE_DROP_REASONS) {
      expect(DROP_CASES[reason].length).toBeGreaterThan(0);
    }
    expect(BRIDGE_DROP_REASONS).toEqual(
      expect.arrayContaining([
        'not-window-source',
        'origin-mismatch',
        'not-object',
        'wrong-tag',
        'version-mismatch',
        'unknown-type',
        'oversize',
        'unserializable',
      ]),
    );
  });

  it.each(AGENT_OUTBOUND_TYPES)('accepts a well-formed %s frame, by reference', (type) => {
    const win = createFakeWindow();
    const frame = agentFrames()[type];
    const decision = shouldAcceptPageMessage(pageMessage(win, frame), { window: win });
    expect(decision.accepted).toBe(true);
    if (!decision.accepted) {
      throw new Error(`rejected as ${decision.reason}`);
    }
    expect(decision.message).toBe(frame);
  });

  it.each(DROP_ROWS)('drops $reason: $label', ({ reason, variant }) => {
    const win = createFakeWindow();
    const decision = shouldAcceptPageMessage(variant.build(win), { window: win });
    expect(decision).toEqual({ accepted: false, reason });
  });

  it('reports the first failing check, in the order the exported tuple lists them', () => {
    expect(PRECEDENCE_ROWS.map((row) => row.expected)).toEqual([...BRIDGE_DROP_REASONS]);
    for (const row of PRECEDENCE_ROWS) {
      const win = createFakeWindow();
      const decision = shouldAcceptPageMessage(row.build(win), {
        window: win,
        maxBytes: row.maxBytes,
      });
      expect(decision).toEqual({ accepted: false, reason: row.expected });
    }
  });

  it("measures the cap in the agent's own unit and accepts a frame exactly at it", () => {
    const atCap = paddedErrorFrame(MAX_PAGE_MESSAGE_BYTES);
    const overCap = paddedErrorFrame(MAX_PAGE_MESSAGE_BYTES + 1);
    expect(approximatePageMessageBytes(atCap)).toBe(MAX_PAGE_MESSAGE_BYTES);
    expect(approximatePageMessageBytes(overCap)).toBe(MAX_PAGE_MESSAGE_BYTES + 1);

    const win = createFakeWindow();
    expect(shouldAcceptPageMessage(pageMessage(win, atCap), { window: win })).toEqual({
      accepted: true,
      message: atCap,
    });
    expect(shouldAcceptPageMessage(pageMessage(win, overCap), { window: win })).toEqual({
      accepted: false,
      reason: 'oversize',
    });
  });

  it('honours a smaller injected cap at its exact boundary', () => {
    const win = createFakeWindow();
    const frame = agentFrames()['agent.ready'];
    const size = approximatePageMessageBytes(frame);
    const event = pageMessage(win, frame);
    expect(shouldAcceptPageMessage(event, { window: win, maxBytes: size }).accepted).toBe(true);
    expect(shouldAcceptPageMessage(event, { window: win, maxBytes: size - 1 })).toEqual({
      accepted: false,
      reason: 'oversize',
    });
  });

  it('is pure: it touches no window member and never mutates the frame', () => {
    const win = createFakeWindow();
    const frame = agentFrames()['telemetry.batch'];
    const before = structuredClone(frame);
    for (const { variant } of DROP_ROWS) {
      shouldAcceptPageMessage(variant.build(win), { window: win });
    }
    shouldAcceptPageMessage(pageMessage(win, frame), { window: win });
    expect(frame).toEqual(before);
    expect(win.addSpy).not.toHaveBeenCalled();
    expect(win.removeSpy).not.toHaveBeenCalled();
    expect(win.postSpy).not.toHaveBeenCalled();
    expect(win.dispatchSpy).not.toHaveBeenCalled();
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

    vi.resetModules();
    const fresh = await import('../src/content/bridge');

    // The module's one guarded import-time call started the bridge.
    expect(fresh.isContentScriptEnvironment()).toBe(true);
    expect(runtime.connectSpy).toHaveBeenCalledTimes(1);
    expect(runtime.connectSpy).toHaveBeenCalledWith({ name: PORT_CONTENT_BRIDGE });
    expect(addSpy.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(['message', 'pageshow', PAGE_HANDSHAKE_OFFER_EVENT]),
    );

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
    for (const { bridge, page, runtime, timers } of liveHarnesses.splice(0)) {
      bridge.stop();
      expect(bridge.isConnected()).toBe(false);
      expect(page.listenerCount()).toBe(0);
      expect(timers.pending()).toBe(0);
      for (const port of runtime.ports) {
        expect(port.onMessage.listeners.size).toBe(0);
        expect(port.onDisconnect.listeners.size).toBe(0);
      }
    }
  });

  describe('dormancy until start()', () => {
    it('constructing the bridge attaches, dispatches, connects and schedules nothing', () => {
      const { bridge, runtime, page, timers } = createHarness();

      expect(page.addSpy).not.toHaveBeenCalled();
      expect(page.dispatchSpy).not.toHaveBeenCalled();
      expect(page.postSpy).not.toHaveBeenCalled();
      expect(runtime.connectSpy).not.toHaveBeenCalled();
      expect(timers.schedule).not.toHaveBeenCalled();
      expect(bridge.isConnected()).toBe(false);

      // Typed against `BridgeStats`, so a counter added to the shape must be added here.
      const { dropped, ...counters } = bridge.getStats();
      const expectedCounters: Omit<BridgeStats, 'dropped'> = {
        connected: false,
        handshakeComplete: false,
        terminated: false,
        forwardedUp: 0,
        forwardedDown: 0,
        reconnects: 0,
        droppedWhileDisconnected: 0,
        droppedDownUnrecognised: 0,
        droppedDownNoHandshake: 0,
        echoesIgnored: 0,
        disconnectErrors: 0,
        faults: 0,
      };
      expect(counters).toEqual(expectedCounters);
      expect(dropped).toEqual(zeroDrops());
    });

    it('page traffic before start() is never observed', () => {
      const { bridge, runtime, page } = createHarness();
      postFromAgent(page, agentFrames()['telemetry.batch']);
      expect(page.listenerCount()).toBe(0);
      expect(runtime.connectSpy).not.toHaveBeenCalled();
      expect(bridge.getStats().dropped).toEqual(zeroDrops());
      expect(bridge.getStats().forwardedUp).toBe(0);
    });
  });

  describe('start() and the page handshake', () => {
    it('attaches its listeners, completes the handshake, connects and tells the page bridge.ready', () => {
      const { bridge, runtime, page } = startedHarness();

      expect(page.listenerCount('message')).toBe(1);
      expect(page.listenerCount('pageshow')).toBe(1);
      // The offer listener is removed as soon as the token is held.
      expect(page.listenerCount(PAGE_HANDSHAKE_OFFER_EVENT)).toBe(0);
      expect(page.dispatchedTypes).toEqual([PAGE_HANDSHAKE_REQUEST_EVENT]);

      // The offer listener must exist before the request: the agent answers inside it.
      const offerIndex = page.addSpy.mock.calls.findIndex(
        ([type]) => type === PAGE_HANDSHAKE_OFFER_EVENT,
      );
      const offerOrder = page.addSpy.mock.invocationCallOrder[offerIndex];
      const requestOrder = page.dispatchSpy.mock.invocationCallOrder[0];
      expect(offerOrder).toBeDefined();
      expect(requestOrder).toBeDefined();
      expect(offerOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(requestOrder ?? 0);

      expect(runtime.connectSpy).toHaveBeenCalledTimes(1);
      expect(runtime.connectSpy).toHaveBeenCalledWith({ name: PORT_CONTENT_BRIDGE });
      expect(runtime.latestPort().name).toBe(PORT_CONTENT_BRIDGE);
      expect(bridge.isConnected()).toBe(true);
      expect(bridge.getStats()).toMatchObject({ connected: true, handshakeComplete: true });

      expect(page.posts).toEqual([
        {
          message: {
            source: BRIDGE_SOURCE_TAG,
            version: PAGE_CHANNEL_VERSION,
            type: 'bridge.ready',
            token: HANDSHAKE_TOKEN,
            payload: {},
          },
          targetOrigin: PAGE_MESSAGE_TARGET_ORIGIN,
        },
      ]);
      // Nothing goes upstream until the agent says something.
      expect(runtime.latestPort().post).not.toHaveBeenCalled();
    });

    it('is idempotent', () => {
      const { bridge, runtime, page } = startedHarness();
      bridge.start();
      expect(runtime.connectSpy).toHaveBeenCalledTimes(1);
      expect(page.listenerCount('message')).toBe(1);
      expect(page.dispatchedTypes).toHaveLength(1);
      expect(pageFrameTypes(page)).toEqual(['bridge.ready']);
    });

    it('posts nothing to the page without a handshake token', () => {
      const { bridge, runtime, page } = startedHarness({ answerHandshake: false });

      expect(bridge.isConnected()).toBe(true);
      expect(bridge.getStats().handshakeComplete).toBe(false);
      expect(page.listenerCount(PAGE_HANDSHAKE_OFFER_EVENT)).toBe(1);
      expect(page.posts).toEqual([]);

      runtime.latestPort().emitMessage(downstreamFrames()['agent.config']);
      expect(page.posts).toEqual([]);
      expect(bridge.getStats()).toMatchObject({ droppedDownNoHandshake: 1, forwardedDown: 0 });
    });

    it('completes the handshake from a late, unsolicited offer and keeps only the first valid token', () => {
      const { bridge, runtime, page } = startedHarness({ answerHandshake: false });

      for (const malformed of ['not-a-token', HANDSHAKE_TOKEN.toUpperCase(), 42, undefined]) {
        page.offerToken(malformed);
      }
      expect(bridge.getStats().handshakeComplete).toBe(false);
      expect(page.posts).toEqual([]);

      page.offerToken(HANDSHAKE_TOKEN);
      expect(bridge.getStats().handshakeComplete).toBe(true);
      expect(page.listenerCount(PAGE_HANDSHAKE_OFFER_EVENT)).toBe(0);
      expect(pageFrames(page)).toEqual([
        {
          source: BRIDGE_SOURCE_TAG,
          version: PAGE_CHANNEL_VERSION,
          type: 'bridge.ready',
          token: HANDSHAKE_TOKEN,
          payload: {},
        },
      ]);

      // A later offer finds no listener; every frame keeps the first token.
      page.offerToken(OTHER_HANDSHAKE_TOKEN);
      runtime.latestPort().emitMessage(downstreamFrames()['target.request']);
      expect(pageFrames(page).map((frame) => frame.token)).toEqual([
        HANDSHAKE_TOKEN,
        HANDSHAKE_TOKEN,
      ]);
    });

    it('never attaches or connects when the extension context is already invalidated', () => {
      const { bridge, runtime, page, timers } = createHarness({ contextAlive: false });
      bridge.start();
      bridge.start();

      expect(runtime.connectSpy).not.toHaveBeenCalled();
      expect(page.addSpy).not.toHaveBeenCalled();
      expect(page.posts).toEqual([]);
      expect(timers.schedule).not.toHaveBeenCalled();
      expect(bridge.getStats().terminated).toBe(true);
      expect(bridge.isConnected()).toBe(false);
    });
  });

  describe('page → worker relay (upstream)', () => {
    it('forwards a telemetry batch raw and unchanged — port framing only, no protocol envelope', () => {
      const { bridge, runtime, page } = startedHarness();
      const frame = agentFrames()['telemetry.batch'];
      const snapshot = structuredClone(frame.payload);

      postFromAgent(page, frame);

      const sent = soleUpstreamFrame(runtime.latestPort());
      expect(sent).toEqual({
        channel: EXTENSION_CHANNEL,
        version: PORT_PROTOCOL_VERSION,
        direction: 'upstream',
        type: 'telemetry.batch',
        payload: snapshot,
      });
      // The payload object itself travels: nothing is copied, reshaped or wrapped.
      expect(sent.payload).toBe(frame.payload);
      expect(frame.payload).toEqual(snapshot);
      if (sent.type !== 'telemetry.batch') {
        throw new Error(`expected a telemetry.batch frame, got ${sent.type}`);
      }
      expect(sent.payload.events).toEqual(snapshot.events);
      expect(Object.keys(sent).sort()).toEqual(UPSTREAM_FRAME_KEYS);
      for (const envelopeField of ['id', 'ts', 'sessionId', 'payload.tabId']) {
        const path = envelopeField.split('.');
        expect(sent).not.toHaveProperty(path);
      }

      expect(bridge.getStats()).toMatchObject({ forwardedUp: 1, dropped: zeroDrops() });
      // Nothing is echoed back down to the page.
      expect(pageFrameTypes(page)).toEqual(['bridge.ready']);
    });

    it('forwards agent.ready unchanged, without a tab id — only the worker knows the tab', () => {
      const { runtime, page } = startedHarness();
      const frame = agentFrames()['agent.ready'];

      postFromAgent(page, frame);

      const sent = soleUpstreamFrame(runtime.latestPort());
      expect(sent.type).toBe('agent.ready');
      expect(sent.payload).toBe(frame.payload);
      expect(sent.payload).toEqual(readyPayload());
      expect(sent.payload).not.toHaveProperty('tabId');
    });

    it.each(AGENT_OUTBOUND_TYPES)('relays %s generically, same type and payload', (type) => {
      const { bridge, runtime, page } = startedHarness();
      const frame = agentFrames()[type];

      postFromAgent(page, frame);

      const sent = soleUpstreamFrame(runtime.latestPort());
      expect(sent.type).toBe(type);
      expect(sent.payload).toBe(frame.payload);
      expect(sent).toMatchObject({
        channel: EXTENSION_CHANNEL,
        version: PORT_PROTOCOL_VERSION,
        direction: 'upstream',
      });
      expect(Object.keys(sent).sort()).toEqual(UPSTREAM_FRAME_KEYS);
      expect(bridge.getStats().forwardedUp).toBe(1);
    });

    it('relays frames in the order the page posted them', () => {
      const { runtime, page } = startedHarness();
      const frames = agentFrames();
      const order: readonly AgentOutboundType[] = [
        'agent.ready',
        'telemetry.batch',
        'target.described',
        'agent.error',
        'telemetry.batch',
      ];
      for (const type of order) {
        postFromAgent(page, frames[type]);
      }
      expect(upstreamFrames(runtime.latestPort()).map((frame) => frame.type)).toEqual(order);
    });

    it.each(DROP_ROWS)(
      'drops $reason without posting on the port: $label',
      ({ reason, variant }) => {
        const { bridge, runtime, page } = startedHarness();

        page.emit('message', variant.build(page));

        expect(runtime.latestPort().post).not.toHaveBeenCalled();
        const stats = bridge.getStats();
        expect(stats.dropped).toEqual({ ...zeroDrops(), [reason]: 1 });
        expect(stats).toMatchObject({
          forwardedUp: 0,
          echoesIgnored: 0,
          droppedWhileDisconnected: 0,
          faults: 0,
        });
        // A rejection is silent toward the page, too.
        expect(pageFrameTypes(page)).toEqual(['bridge.ready']);
      },
    );

    it('recognises its own frames echoed back to the window and does not loop them', () => {
      const { bridge, runtime, page } = startedHarness();
      const ownFrame = lastPagePost(page).message;

      postFromAgent(page, ownFrame);

      expect(runtime.latestPort().post).not.toHaveBeenCalled();
      expect(bridge.getStats()).toMatchObject({ echoesIgnored: 1, dropped: zeroDrops() });
      expect(page.posts).toHaveLength(1);
    });

    it('treats a bridge-tagged frame carrying a foreign token as a wrong-tag drop, not an echo', () => {
      const { bridge, runtime, page } = startedHarness();

      postFromAgent(page, forgedBridgeFrame());

      expect(runtime.latestPort().post).not.toHaveBeenCalled();
      expect(bridge.getStats()).toMatchObject({
        echoesIgnored: 0,
        dropped: { ...zeroDrops(), 'wrong-tag': 1 },
      });
      expect(page.posts).toHaveLength(1);
    });

    it('buffers nothing: a frame accepted while no port is open is discarded, never replayed', () => {
      const { bridge, runtime, page } = startedHarness();
      const first = runtime.latestPort();
      first.emitDisconnect();

      postFromAgent(page, agentFrames()['telemetry.batch']);

      expect(first.post).not.toHaveBeenCalled();
      expect(bridge.getStats().droppedWhileDisconnected).toBe(1);
      // The page was told once, and it is the agent that buffers.
      expect(pageFrameTypes(page)).toEqual(['bridge.ready', 'bridge.gone']);

      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);
      const second = runtime.latestPort();
      expect(second).not.toBe(first);
      expect(upstreamFrames(second)).toEqual([]);
      expect(pageFrameTypes(page)).toEqual(['bridge.ready', 'bridge.gone', 'bridge.ready']);
    });

    it('treats a post that throws as a lost port: closes it, signals gone, schedules a reconnect', () => {
      const { bridge, runtime, page, timers } = startedHarness();
      const port = runtime.latestPort();
      port.failPosts();

      postFromAgent(page, agentFrames()['telemetry.batch']);

      expect(bridge.isConnected()).toBe(false);
      expect(port.close).toHaveBeenCalledTimes(1);
      expect(bridge.getStats()).toMatchObject({ droppedWhileDisconnected: 1, forwardedUp: 0 });
      expect(pageFrameTypes(page)).toEqual(['bridge.ready', 'bridge.gone']);
      expect(timers.delays()).toEqual([BRIDGE_RECONNECT_BASE_MS]);
    });

    it('never sends the handshake token upstream and keeps page data out of its stats', () => {
      const { bridge, runtime, page } = startedHarness();
      for (const type of AGENT_OUTBOUND_TYPES) {
        postFromAgent(page, agentFrames()[type]);
      }

      const upstream = JSON.stringify(runtime.latestPort().post.mock.calls);
      expect(upstream).not.toContain(HANDSHAKE_TOKEN);

      const stats = JSON.stringify(bridge.getStats());
      for (const pageValue of [HANDSHAKE_TOKEN, PRODUCER_ID, DOCUMENT_ID, PAGE_ORIGIN]) {
        expect(stats).not.toContain(pageValue);
      }
    });
  });

  describe('worker → page relay (downstream)', () => {
    it("delivers agent.config tagged, versioned, signed and targeted at the page's own origin", () => {
      const { bridge, runtime, page } = startedHarness();
      const frame = downstreamFrames()['agent.config'];

      runtime.latestPort().emitMessage(frame);

      const delivered = lastPagePost(page);
      expect(delivered).toEqual({
        message: {
          source: BRIDGE_SOURCE_TAG,
          version: PAGE_CHANNEL_VERSION,
          type: 'agent.config',
          token: HANDSHAKE_TOKEN,
          payload: configPayload(),
        },
        targetOrigin: PAGE_MESSAGE_TARGET_ORIGIN,
      });
      // A wildcard target would broadcast extension state to any listener on the page.
      expect(delivered.targetOrigin).not.toBe('*');
      const message = expectPageFrame(delivered.message);
      expect(message.payload).toBe(frame.payload);

      expect(bridge.getStats().forwardedDown).toBe(1);
      // Nothing loops back up to the worker.
      expect(runtime.latestPort().post).not.toHaveBeenCalled();
    });

    it.each(BRIDGE_DOWNSTREAM_MESSAGE_TYPES)(
      'delivers %s with the same type and payload',
      (type) => {
        const { bridge, runtime, page } = startedHarness();
        const frame = downstreamFrames()[type];

        runtime.latestPort().emitMessage(frame);

        const delivered = lastPagePost(page);
        expect(delivered.targetOrigin).toBe(PAGE_MESSAGE_TARGET_ORIGIN);
        const message = expectPageFrame(delivered.message);
        expect(message).toMatchObject({
          source: BRIDGE_SOURCE_TAG,
          version: PAGE_CHANNEL_VERSION,
          type,
          token: HANDSHAKE_TOKEN,
        });
        expect(message.payload).toBe(frame.payload);
        expect(bridge.getStats().forwardedDown).toBe(1);
      },
    );

    it('drops every port message that is not a well-formed worker frame', () => {
      const { bridge, runtime, page } = startedHarness();
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
      expect(pageFrameTypes(page)).toEqual(['bridge.ready']);
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
      const { bridge, runtime, page, timers } = startedHarness();
      const first = runtime.latestPort();

      first.emitDisconnect();

      expect(bridge.isConnected()).toBe(false);
      expect(bridge.getStats().connected).toBe(false);
      expect(first.onMessage.listeners.size).toBe(0);
      expect(first.onDisconnect.listeners.size).toBe(0);
      // The worker's end closed; there is nothing for this side to close.
      expect(first.close).not.toHaveBeenCalled();
      expect(pageFrameTypes(page)).toEqual(['bridge.ready', 'bridge.gone']);
      expect(lastPagePost(page).targetOrigin).toBe(PAGE_MESSAGE_TARGET_ORIGIN);
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
      expect(second.name).toBe(PORT_CONTENT_BRIDGE);
      expect(bridge.isConnected()).toBe(true);
      expect(bridge.getStats()).toMatchObject({ connected: true, reconnects: 1 });
      expect(pageFrameTypes(page)).toEqual(['bridge.ready', 'bridge.gone', 'bridge.ready']);
      expect(pageFrames(page).map((frame) => frame.token)).toEqual([
        HANDSHAKE_TOKEN,
        HANDSHAKE_TOKEN,
        HANDSHAKE_TOKEN,
      ]);

      // The new port relays as the first did.
      postFromAgent(page, agentFrames()['telemetry.batch']);
      expect(soleUpstreamFrame(second).type).toBe('telemetry.batch');
    });

    it('re-announces the last agent.ready on every new port so the capture continues', () => {
      const { bridge, runtime, page } = startedHarness();
      const frame = agentFrames()['agent.ready'];
      postFromAgent(page, frame);

      runtime.latestPort().emitDisconnect();
      vi.advanceTimersByTime(BRIDGE_RECONNECT_BASE_MS);

      const reannounced = soleUpstreamFrame(runtime.latestPort());
      expect(reannounced.type).toBe('agent.ready');
      expect(reannounced.payload).toBe(frame.payload);
      expect(bridge.getStats().forwardedUp).toBe(2);
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
      expect(Math.max(...delays)).toBe(BRIDGE_RECONNECT_MAX_MS);
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
      const { bridge, runtime, page, timers } = startedHarness();
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
      expect(pageFrameTypes(page)).toEqual(['bridge.ready', 'bridge.gone', 'bridge.ready']);
    });

    it('reads and counts chrome.runtime.lastError on a failed port, and still reconnects', () => {
      const { bridge, runtime, timers } = startedHarness();
      runtime.lastError = { message: 'Could not establish connection.' };

      runtime.latestPort().emitDisconnect();

      expect(bridge.getStats().disconnectErrors).toBe(1);
      expect(timers.delays()).toEqual([BRIDGE_RECONNECT_BASE_MS]);
    });

    it('stops for good once the extension context is invalidated', () => {
      const { bridge, runtime, page, timers } = startedHarness();
      runtime.id = undefined;

      runtime.latestPort().emitDisconnect();

      expect(bridge.getStats()).toMatchObject({ terminated: true, connected: false });
      expect(pageFrameTypes(page)).toEqual(['bridge.ready', 'bridge.gone']);
      expect(page.listenerCount()).toBe(0);
      expect(timers.schedule).not.toHaveBeenCalled();

      vi.advanceTimersByTime(BRIDGE_RECONNECT_MAX_MS * 4);
      bridge.start();
      expect(runtime.connectSpy).toHaveBeenCalledTimes(1);
      expect(page.listenerCount()).toBe(0);
    });

    it('opens a fresh port at once when the page is restored from the back/forward cache', () => {
      const { bridge, runtime, page, timers } = startedHarness();
      const frozen = runtime.latestPort();

      page.emit('pageshow', { persisted: false });
      expect(runtime.connectSpy).toHaveBeenCalledTimes(1);

      page.emit('pageshow', { persisted: true });

      expect(frozen.close).toHaveBeenCalledTimes(1);
      expect(runtime.connectSpy).toHaveBeenCalledTimes(2);
      expect(runtime.latestPort()).not.toBe(frozen);
      expect(bridge.isConnected()).toBe(true);
      expect(timers.schedule).not.toHaveBeenCalled();
      expect(pageFrameTypes(page)).toEqual(['bridge.ready', 'bridge.ready']);
    });
  });

  describe('stop()', () => {
    it('removes every listener, disconnects the port and tells the page bridge.gone', () => {
      const { bridge, runtime, page } = startedHarness();
      const port = runtime.latestPort();

      bridge.stop();

      expect(page.listenerCount()).toBe(0);
      for (const [type, listener] of page.addSpy.mock.calls) {
        expect(page.removeSpy).toHaveBeenCalledWith(type, listener);
      }
      expect(port.close).toHaveBeenCalledTimes(1);
      expect(port.onMessage.listeners.size).toBe(0);
      expect(port.onDisconnect.listeners.size).toBe(0);
      expect(bridge.isConnected()).toBe(false);
      expect(pageFrameTypes(page)).toEqual(['bridge.ready', 'bridge.gone']);

      // Nothing is listening any more.
      postFromAgent(page, agentFrames()['telemetry.batch']);
      expect(port.post).not.toHaveBeenCalled();
      expect(bridge.getStats().dropped).toEqual(zeroDrops());
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

    it('is idempotent, and a restart reuses the token without a second handshake', () => {
      const { bridge, runtime, page } = startedHarness();

      bridge.stop();
      bridge.stop();
      expect(pageFrameTypes(page)).toEqual(['bridge.ready', 'bridge.gone']);

      bridge.start();

      expect(page.dispatchedTypes).toEqual([PAGE_HANDSHAKE_REQUEST_EVENT]);
      expect(runtime.connectSpy).toHaveBeenCalledTimes(2);
      expect(page.listenerCount('message')).toBe(1);
      expect(bridge.isConnected()).toBe(true);
      expect(pageFrameTypes(page)).toEqual(['bridge.ready', 'bridge.gone', 'bridge.ready']);
      expect(pageFrames(page).at(-1)?.token).toBe(HANDSHAKE_TOKEN);
    });
  });
});
