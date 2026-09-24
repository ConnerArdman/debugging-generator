/**
 * The isolated-world content-script bridge: the only path between the
 * MAIN-world page agent and the extension's Manifest V3 service worker.
 *
 * ## Where it runs
 *
 * `manifest.config.ts` declares this file as content-script entry **#2** —
 * `world: "ISOLATED"`, `run_at: "document_start"`, `all_frames: false`,
 * matched to the local app origins. Entry #1 is the prebuilt page agent
 * (`public/agent.iife.js`, `world: "MAIN"`), and Chrome injects the two in
 * declaration order, so the agent has already installed the React DevTools hook
 * and opened its inbound channel when this script is evaluated. At
 * `document_start` there is no `document.body`; nothing here touches the DOM
 * tree, creates an element or adds a style.
 *
 * ## The two channels it joins
 *
 * ```text
 * page agent (MAIN) --window.postMessage({source:'debuggen-agent', version, type, payload}, '/')--> bridge
 * page agent (MAIN) <--window.postMessage({source:'debuggen-bridge', version, type, token, payload}, '/')-- bridge
 * bridge --chrome.runtime.connect({ name: PORT_CONTENT_BRIDGE })--> service worker
 *        upstream:   agent.ready · telemetry.batch · target.described · agent.error
 *        downstream: agent.config · agent.snapshot · target.request
 * ```
 *
 * Both hops carry **raw** payloads. The bridge forwards each payload by
 * reference and never reshapes, counts, redacts or schema-validates telemetry:
 * the service worker adds `tabId` from the port's `sender` and wraps event
 * batches into `@debuggen/protocol` envelopes (AAP §0.4.2), and the service
 * validates and redacts at ingest (AAP §0.5.2). The frame shapes, tags, the
 * channel version and the size cap are all imported from `../shared/messages`,
 * which mirrors `packages/telemetry/src/browser/transport.ts` — the owner of the
 * page channel — so nothing about the channel is restated here.
 *
 * ## The handshake
 *
 * Page channel version 2 requires every bridge → page frame to carry the
 * document's handshake token, which the agent mints and discloses over a
 * `CustomEvent`. This bridge performs its half exactly once per document:
 * register a {@link PAGE_HANDSHAKE_OFFER_EVENT} listener, then dispatch one
 * {@link PAGE_HANDSHAKE_REQUEST_EVENT}; the agent answers synchronously inside
 * that dispatch. The token lives only in this module's closure. Until one is
 * held, downstream frames cannot be delivered (the agent would drop them), so
 * they are counted and discarded instead of being posted where any page script
 * could read them.
 *
 * ## Recovery, without a buffer
 *
 * The page agent owns the only buffer (5 000 events, drop-oldest) and decides
 * whether to post or to hold from two signals this bridge sends it:
 * `bridge.ready` whenever the port becomes usable and `bridge.gone` whenever it
 * dies. A Manifest V3 worker suspends after roughly 30 s of idleness, which
 * disconnects this port; the bridge then reconnects with a short, bounded,
 * jittered backoff — connecting is what wakes the worker — and on every new
 * port re-announces the last `agent.ready` it relayed, so
 * `background/agent-control.ts` can re-send `agent.config` and the same
 * `captureId` continues. No heartbeat is ever sent over a live port: keeping
 * the worker alive is `background/ws-bridge.ts`'s job (`chrome.alarms`, AAP
 * §0.5.5), and a content-script heartbeat would defeat worker suspension on
 * every localhost tab. When the extension is reloaded or updated,
 * `chrome.runtime.id` disappears; the bridge then stops for good rather than
 * retrying into "Extension context invalidated" errors on every tab.
 *
 * ## What the page-side checks are, and are not
 *
 * `event.source === window`, the document's own origin, the agent's source tag
 * and the exact channel version reject accidental cross-talk (iframes, other
 * windows, unrelated `postMessage` traffic, a stale agent left in a cached
 * page). They are **not** a security boundary against a hostile page: any page
 * script can post a frame tagged as the agent's. The real boundaries are the
 * worker's authenticated socket and the service's schema validation and
 * redaction at ingest (AAP §0.5.2, §0.5.6). Rejections are silent — no page
 * data is ever logged or echoed — and are visible only as counters in
 * {@link BridgeStats}.
 *
 * ## Testability
 *
 * Importing this module has no side effect except one environment-guarded
 * call at the very end ({@link bootstrapContentBridge}), which does nothing
 * outside a real content-script realm. `apps/chrome-extension/test/bridge.test.ts`
 * drives {@link shouldAcceptPageMessage} directly and {@link createContentBridge}
 * through injected `chrome.runtime`, `window`, timer, `random` and clock fakes.
 *
 * @module apps/chrome-extension/src/content/bridge
 */

import {
  AGENT_OUTBOUND_TYPES,
  AGENT_SOURCE_TAG,
  BRIDGE_SOURCE_TAG,
  EXTENSION_CHANNEL,
  MAX_PAGE_MESSAGE_BYTES,
  PAGE_CHANNEL_VERSION,
  PAGE_HANDSHAKE_OFFER_EVENT,
  PAGE_HANDSHAKE_REQUEST_EVENT,
  PAGE_MESSAGE_TARGET_ORIGIN,
  PORT_CONTENT_BRIDGE,
  PORT_PROTOCOL_VERSION,
  approximatePageMessageBytes,
  isAgentChannelMessage,
  isBridgeChannelMessage,
  isBridgeDownstreamMessage,
  isPageHandshakeToken,
} from '../shared/messages';
import type {
  AgentChannelMessage,
  AgentOutboundType,
  BridgeChannelMessage,
  BridgeDownstreamMessage,
  BridgeUpstreamMessage,
  PageAgentReadyPayload,
} from '../shared/messages';

/*
 * ===========================================================================
 * Structural surfaces
 *
 * The narrow slices of `chrome.runtime`, `chrome.runtime.Port` and `window`
 * this module touches. They are local on purpose — not a cross-process
 * contract — and are written so the real globals satisfy them structurally
 * (`createContentBridge({ chrome: chrome.runtime, window })` type-checks in
 * the bootstrap) while a test can pass plain fakes.
 * ===========================================================================
 */

/**
 * The listener-registration half of a `chrome.events.Event`.
 *
 * @typeParam Listener The callback signature the event dispatches to.
 */
export interface PortEventLike<Listener> {
  /** Register `listener`. */
  addListener(listener: Listener): void;
  /** Unregister a listener previously passed to {@link addListener}. */
  removeListener(listener: Listener): void;
}

/** The members of a `chrome.runtime.Port` the bridge uses. */
export interface PortLike {
  /** The port name given to `connect` — {@link PORT_CONTENT_BRIDGE} here. */
  readonly name?: string | undefined;
  /** Send one message to the worker; throws when the port is already dead. */
  postMessage(message: unknown): void;
  /** Close the port; the worker's `onDisconnect` fires, this side's does not. */
  disconnect(): void;
  /** Messages the worker posts on this port. */
  readonly onMessage: PortEventLike<(message: unknown) => void>;
  /** Fired once, when the other end closes the port or the worker goes away. */
  readonly onDisconnect: PortEventLike<(port: unknown) => void>;
}

/** The members of `chrome.runtime` the bridge uses. */
export interface ChromeRuntimeLike {
  /**
   * The extension id. A string while the extension context is alive, and
   * `undefined` once the extension has been reloaded, updated or removed —
   * the signal that this content script is orphaned.
   */
  readonly id?: string | undefined;
  /** Set while an `onDisconnect` listener runs if the port closed on an error. */
  readonly lastError?: { readonly message?: string | undefined } | undefined;
  /** Open a long-lived port to the extension's service worker. */
  connect(connectInfo: { name: string }): PortLike;
}

/** The members of the page `window` the bridge uses. */
export interface WindowLike {
  /** The document's location; only `origin` is read. */
  readonly location: { readonly origin: string };
  /**
   * Register an event listener. The listener receives whatever the window
   * dispatches and narrows it structurally, which is why its parameter is
   * `unknown` rather than `Event`.
   */
  addEventListener(type: string, listener: (event: unknown) => void): void;
  /** Unregister a listener registered with {@link addEventListener}. */
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  /** Post a message to this window; the bridge always targets its own origin. */
  postMessage(message: unknown, targetOrigin: string): void;
  /** Dispatch a DOM event on the window — used once, for the handshake request. */
  dispatchEvent(event: Event): boolean;
}

/*
 * ===========================================================================
 * The page → bridge filter (pure)
 * ===========================================================================
 */

/**
 * Every reason the bridge drops a page `message` event, in the order the checks
 * run — cheapest first, each one short-circuiting the rest.
 *
 * `malformed-payload` extends the eight reasons of the original brief: the
 * shared contract's {@link isAgentChannelMessage} checks each frame type's
 * payload fields, and the worker applies the same check again on the port, so a
 * frame that fails it is dropped here rather than relayed only to be dropped
 * there. Tests should iterate this tuple rather than a copied list.
 */
export const BRIDGE_DROP_REASONS = [
  'not-window-source',
  'origin-mismatch',
  'not-object',
  'wrong-tag',
  'version-mismatch',
  'unknown-type',
  'malformed-payload',
  'unserializable',
  'oversize',
] as const;

/** One of {@link BRIDGE_DROP_REASONS}. */
export type BridgeDropReason = (typeof BRIDGE_DROP_REASONS)[number];

/** The three `MessageEvent` fields the filter reads. */
export interface PageMessageEventLike {
  /** The window that posted the message. */
  readonly source: unknown;
  /** The poster's origin, as the browser reports it. */
  readonly origin: string;
  /** The posted value, already structured-cloned into this world. */
  readonly data: unknown;
}

/** What the filter compares an event against. */
export interface PageMessageContext {
  /** The window the bridge serves: the only acceptable `event.source`. */
  readonly window: WindowLike;
  /**
   * The size cap, in the agent's own unit (JSON code-unit length). Defaults to
   * {@link MAX_PAGE_MESSAGE_BYTES}; exposed so a test can exercise the cap
   * without building a half-megabyte frame.
   */
  readonly maxBytes?: number | undefined;
}

/** The filter's verdict: the accepted agent frame, or why it was dropped. */
export type PageMessageDecision =
  | { readonly accepted: true; readonly message: AgentChannelMessage }
  | { readonly accepted: false; readonly reason: BridgeDropReason };

/** A plain object: not `null`, not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Membership in the agent's closed outbound vocabulary. */
function isAgentOutboundType(value: unknown): value is AgentOutboundType {
  return typeof value === 'string' && AGENT_OUTBOUND_TYPES.some((type) => type === value);
}

/** A rejection verdict. */
function reject(reason: BridgeDropReason): PageMessageDecision {
  return { accepted: false, reason };
}

/**
 * Decide whether a page `message` event is a frame from the page agent that
 * the bridge should relay. Pure: no side effects, no logging, no `chrome`
 * access, and no exception for any input a `message` event can carry.
 *
 * The checks run cheapest first and stop at the first failure:
 *
 * 1. `event.source` is the bridge's own window — rejects iframes, openers and
 *    other windows (`not-window-source`);
 * 2. `event.origin` is the document's own origin, read from the window rather
 *    than written here (`origin-mismatch`);
 * 3. the data is a non-null, non-array object (`not-object`);
 * 4. its `source` is {@link AGENT_SOURCE_TAG} — the bridge's own
 *    {@link BRIDGE_SOURCE_TAG} frames, which this window also receives, are
 *    rejected here and never loop back (`wrong-tag`);
 * 5. its `version` is exactly {@link PAGE_CHANNEL_VERSION}, so a stale agent
 *    left in a cached page is ignored rather than misread (`version-mismatch`);
 * 6. its `type` is one of {@link AGENT_OUTBOUND_TYPES} (`unknown-type`);
 * 7. its payload has that type's fields, per the shared
 *    {@link isAgentChannelMessage} (`malformed-payload`);
 * 8. it can be rendered as JSON at all (`unserializable`);
 * 9. its rendering is within the cap, measured with the agent's own
 *    {@link approximatePageMessageBytes} so a frame the agent was willing to
 *    post is never refused here (`oversize`). An oversize frame is an anomaly
 *    — batch sizing is the agent's — and is dropped, never split.
 *
 * @param event The `message` event's `source`, `origin` and `data`.
 * @param context The bridge's window and, optionally, a smaller size cap.
 * @returns The accepted frame (the same object, by reference), or the reason
 * it was dropped.
 */
export function shouldAcceptPageMessage(
  event: PageMessageEventLike,
  context: PageMessageContext,
): PageMessageDecision {
  if (event.source !== context.window) {
    return reject('not-window-source');
  }
  if (event.origin !== context.window.location.origin) {
    return reject('origin-mismatch');
  }

  const data = event.data;
  if (!isRecord(data)) {
    return reject('not-object');
  }
  if (data.source !== AGENT_SOURCE_TAG) {
    return reject('wrong-tag');
  }
  if (data.version !== PAGE_CHANNEL_VERSION) {
    return reject('version-mismatch');
  }
  if (!isAgentOutboundType(data.type)) {
    return reject('unknown-type');
  }
  if (!isAgentChannelMessage(data)) {
    return reject('malformed-payload');
  }

  const size = approximatePageMessageBytes(data);
  if (!Number.isFinite(size)) {
    return reject('unserializable');
  }
  if (size > (context.maxBytes ?? MAX_PAGE_MESSAGE_BYTES)) {
    return reject('oversize');
  }

  return { accepted: true, message: data };
}

/*
 * ===========================================================================
 * Reconnect policy
 * ===========================================================================
 */

/**
 * The first reconnect delay after the port dies, in milliseconds.
 *
 * Short on purpose: reconnecting only has to wake the worker, and a capture in
 * progress is buffering in the page until it does.
 */
export const BRIDGE_RECONNECT_BASE_MS = 250;

/** The longest reconnect delay, in milliseconds; the backoff never exceeds it. */
export const BRIDGE_RECONNECT_MAX_MS = 5_000;

/**
 * The fraction of each delay that jitter may remove: a delay lies in
 * `[ceiling × (1 − jitter), ceiling]`, so reconnects from many tabs spread out
 * after a worker restart and the cap is never exceeded.
 */
export const BRIDGE_RECONNECT_JITTER = 0.2;

/**
 * How long a port must stay open, in milliseconds, before its loss resets the
 * backoff.
 *
 * `chrome.runtime.connect` returns a port even when nothing is listening on
 * the worker side; that port is closed again within milliseconds. Resetting
 * the backoff on `connect()` alone would therefore retry every
 * {@link BRIDGE_RECONNECT_BASE_MS} forever. A port that lived this long, or
 * that delivered a worker message, proved the worker was reachable, and only
 * such a port resets the attempt counter.
 */
export const BRIDGE_PORT_STABLE_MS = 1_000;

/** Caps the exponent so `2 ** attempt` can never overflow into `Infinity`. */
const MAX_BACKOFF_EXPONENT = 16;

/**
 * The delay before reconnect attempt `attempt` (0-based): exponential from
 * {@link BRIDGE_RECONNECT_BASE_MS}, capped at {@link BRIDGE_RECONNECT_MAX_MS},
 * minus up to {@link BRIDGE_RECONNECT_JITTER} of itself. Pure.
 *
 * @param attempt Consecutive failed attempts before this one; non-finite or
 * negative values count as 0.
 * @param random A source of values in `[0, 1)`; out-of-range draws are clamped.
 * @returns A whole number of milliseconds in
 * `[BRIDGE_RECONNECT_BASE_MS × (1 − BRIDGE_RECONNECT_JITTER), BRIDGE_RECONNECT_MAX_MS]`.
 */
export function computeReconnectDelay(
  attempt: number,
  random: () => number = () => Math.random(),
): number {
  const exponent =
    Number.isFinite(attempt) && attempt > 0
      ? Math.min(Math.floor(attempt), MAX_BACKOFF_EXPONENT)
      : 0;
  const ceiling = Math.min(BRIDGE_RECONNECT_MAX_MS, BRIDGE_RECONNECT_BASE_MS * 2 ** exponent);
  const draw = random();
  const unit = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 0;
  return Math.round(ceiling * (1 - BRIDGE_RECONNECT_JITTER * unit));
}

/*
 * ===========================================================================
 * The bridge's public surface
 * ===========================================================================
 */

/** Everything the bridge needs from its environment, injectable for tests. */
export interface ContentBridgeDeps {
  /** `chrome.runtime`, or a fake with the same members. */
  readonly chrome: ChromeRuntimeLike;
  /** The page `window`, or a fake with the same members. */
  readonly window: WindowLike;
  /**
   * Schedules the reconnect timer. Defaults to `globalThis.setTimeout`, looked
   * up at call time so test fake timers apply.
   */
  readonly setTimeout?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  /** Cancels a handle returned by {@link setTimeout}. Defaults to `globalThis.clearTimeout`. */
  readonly clearTimeout?: ((handle: unknown) => void) | undefined;
  /** Jitter source in `[0, 1)`. Defaults to `Math.random`. */
  readonly random?: (() => number) | undefined;
  /** Clock in milliseconds, for port-stability decisions. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}

/** A snapshot of the bridge's counters and state; no page data appears in it. */
export interface BridgeStats {
  /** Whether a port to the worker is currently open. */
  readonly connected: boolean;
  /** Whether this document's handshake token is held. */
  readonly handshakeComplete: boolean;
  /** Whether the bridge stopped for good because the extension context was invalidated. */
  readonly terminated: boolean;
  /** Agent frames posted on the port (re-announced `agent.ready` frames included). */
  readonly forwardedUp: number;
  /** Worker frames posted to the page. */
  readonly forwardedDown: number;
  /** Ports opened after the first one. */
  readonly reconnects: number;
  /** Page `message` events rejected by {@link shouldAcceptPageMessage}, per reason. */
  readonly dropped: Readonly<Record<BridgeDropReason, number>>;
  /** Accepted agent frames discarded because no port was open (the agent buffers instead). */
  readonly droppedWhileDisconnected: number;
  /** Port messages that were not well-formed worker → bridge frames. */
  readonly droppedDownUnrecognised: number;
  /** Worker frames discarded because no handshake token was held to sign them with. */
  readonly droppedDownNoHandshake: number;
  /** The bridge's own page frames seen again by its `message` listener (not drops). */
  readonly echoesIgnored: number;
  /** Port closures that carried a `chrome.runtime.lastError`. */
  readonly disconnectErrors: number;
  /** Unexpected exceptions caught so that none reaches the page or its console. */
  readonly faults: number;
}

/** The handle {@link createContentBridge} returns. */
export interface ContentBridge {
  /**
   * Attach the page listeners, perform the handshake (once per document) and
   * open the port. Idempotent; a no-op after {@link stop} has been followed by
   * termination.
   */
  start(): void;
  /**
   * Remove every listener, cancel any pending reconnect, disconnect the port
   * and tell the page `bridge.gone`. Idempotent. The handshake token is kept,
   * because the agent answers only one request per document.
   */
  stop(): void;
  /** Whether a port to the worker is currently open. */
  isConnected(): boolean;
  /** A snapshot of the counters; see {@link BridgeStats}. */
  getStats(): BridgeStats;
}

/*
 * ===========================================================================
 * Private helpers
 * ===========================================================================
 */

/** The mutable counters behind {@link BridgeStats}. */
type MutableStats = { -readonly [Key in keyof Omit<BridgeStats, 'dropped'>]: BridgeStats[Key] } & {
  dropped: Record<BridgeDropReason, number>;
};

/** A zeroed counter set. Written out so adding a reason without a slot fails to compile. */
function emptyStats(): MutableStats {
  return {
    connected: false,
    handshakeComplete: false,
    terminated: false,
    forwardedUp: 0,
    forwardedDown: 0,
    reconnects: 0,
    dropped: {
      'not-window-source': 0,
      'origin-mismatch': 0,
      'not-object': 0,
      'wrong-tag': 0,
      'version-mismatch': 0,
      'unknown-type': 0,
      'malformed-payload': 0,
      unserializable: 0,
      oversize: 0,
    },
    droppedWhileDisconnected: 0,
    droppedDownUnrecognised: 0,
    droppedDownNoHandshake: 0,
    echoesIgnored: 0,
    disconnectErrors: 0,
    faults: 0,
  };
}

/** The default timer, resolved at call time so fake timers installed later apply. */
function defaultSetTimeout(callback: () => void, delayMs: number): unknown {
  return globalThis.setTimeout(callback, delayMs);
}

/**
 * The default cancellation. Browser timer handles are numbers; any other handle
 * is left to fire, which is harmless because a stale timer callback is ignored
 * (see `scheduleReconnect`).
 */
function defaultClearTimeout(handle: unknown): void {
  if (typeof handle === 'number') {
    globalThis.clearTimeout(handle);
  }
}

/** Read a `message` event's three fields structurally; absent fields read as nothing. */
function readPageMessageEvent(event: unknown): PageMessageEventLike {
  if (typeof event !== 'object' || event === null) {
    return { source: undefined, origin: '', data: undefined };
  }
  return {
    source: 'source' in event ? event.source : undefined,
    origin: 'origin' in event && typeof event.origin === 'string' ? event.origin : '',
    data: 'data' in event ? event.data : undefined,
  };
}

/** A `CustomEvent`'s `detail`, read structurally. */
function readEventDetail(event: unknown): unknown {
  return typeof event === 'object' && event !== null && 'detail' in event
    ? event.detail
    : undefined;
}

/** Whether a `pageshow` event reports a restore from the back/forward cache. */
function isPersistedPageShow(event: unknown): boolean {
  return (
    typeof event === 'object' && event !== null && 'persisted' in event && event.persisted === true
  );
}

/** The framing fields of every upstream port frame. */
const UPSTREAM_FRAMING = {
  channel: EXTENSION_CHANNEL,
  version: PORT_PROTOCOL_VERSION,
  direction: 'upstream',
} as const;

/**
 * Wrap an accepted agent frame for the port: same `type`, same payload object.
 * One case per type so each payload keeps its exact type without a cast.
 */
function toUpstreamFrame(message: AgentChannelMessage): BridgeUpstreamMessage {
  switch (message.type) {
    case 'agent.ready':
      return { ...UPSTREAM_FRAMING, type: message.type, payload: message.payload };
    case 'telemetry.batch':
      return { ...UPSTREAM_FRAMING, type: message.type, payload: message.payload };
    case 'target.described':
      return { ...UPSTREAM_FRAMING, type: message.type, payload: message.payload };
    case 'agent.error':
      return { ...UPSTREAM_FRAMING, type: message.type, payload: message.payload };
  }
}

/** The upstream frame that re-announces a cached `agent.ready` payload. */
function readyFrame(payload: PageAgentReadyPayload): BridgeUpstreamMessage {
  return { ...UPSTREAM_FRAMING, type: 'agent.ready', payload };
}

/** The framing fields of every bridge → page frame. */
const PAGE_FRAMING = {
  source: BRIDGE_SOURCE_TAG,
  version: PAGE_CHANNEL_VERSION,
} as const;

/**
 * Build the page frame for a worker frame: the bridge's tag, the channel
 * version, the document's token, and the worker's payload object unchanged.
 */
function toPageFrame(message: BridgeDownstreamMessage, token: string): BridgeChannelMessage {
  switch (message.type) {
    case 'agent.config':
      return { ...PAGE_FRAMING, type: message.type, token, payload: message.payload };
    case 'agent.snapshot':
      return { ...PAGE_FRAMING, type: message.type, token, payload: message.payload };
    case 'target.request':
      return { ...PAGE_FRAMING, type: message.type, token, payload: message.payload };
  }
}

/** A `bridge.ready` or `bridge.gone` signal frame; the payload is always `{}`. */
function signalFrame(type: 'bridge.ready' | 'bridge.gone', token: string): BridgeChannelMessage {
  return type === 'bridge.ready'
    ? { ...PAGE_FRAMING, type: 'bridge.ready', token, payload: {} }
    : { ...PAGE_FRAMING, type: 'bridge.gone', token, payload: {} };
}

/*
 * ===========================================================================
 * The bridge
 * ===========================================================================
 */

/**
 * An open port together with the listeners registered on it. Each port gets
 * its own listener closures, so an event from a port the bridge has already
 * replaced is recognised as stale and ignored.
 */
interface Connection {
  readonly port: PortLike;
  readonly openedAt: number;
  readonly onMessage: (message: unknown) => void;
  readonly onDisconnect: (port: unknown) => void;
}

/** A scheduled reconnect. Its identity is what marks a timer callback as current. */
interface PendingReconnect {
  handle: unknown;
}

/** What the page agent was last told about the port. */
type PageSignal = 'none' | 'ready' | 'gone';

/**
 * Create the relay between the page agent and the service worker. Constructing
 * it touches nothing: no listener, no port, no timer until {@link ContentBridge.start}.
 *
 * Lifecycle of one document:
 *
 * - `start()` attaches the page `message` and `pageshow` listeners, performs
 *   the handshake (offer listener first, then one request — the agent answers
 *   synchronously), opens the port, posts `bridge.ready` to the page and, if an
 *   `agent.ready` was already relayed, re-announces it upstream.
 * - An accepted agent frame is posted on the port as the matching upstream
 *   frame, payload by reference. With no port open it is counted and discarded
 *   — never queued — the page is told `bridge.gone` if it has not been, and a
 *   reconnect is requested.
 * - A well-formed worker frame is posted to the page with the bridge's tag,
 *   {@link PAGE_CHANNEL_VERSION}, the document's token and the worker's
 *   payload, targeted at {@link PAGE_MESSAGE_TARGET_ORIGIN}.
 * - When the port closes (the worker suspended, crashed or refused the
 *   connection) or a post on it throws, `chrome.runtime.lastError` is read and
 *   discarded, the page is told `bridge.gone`, and a reconnect is scheduled
 *   with {@link computeReconnectDelay}. The attempt counter resets only for a
 *   port that stayed open {@link BRIDGE_PORT_STABLE_MS} or delivered a worker
 *   frame.
 * - A `pageshow` restore from the back/forward cache opens a fresh port, since
 *   Chrome closes extension ports when it freezes a document.
 * - Once `chrome.runtime.id` is gone the extension context is invalidated: the
 *   bridge tells the page `bridge.gone`, removes every listener and never
 *   reconnects.
 *
 * `pagehide` is deliberately not handled: the agent flushes its tail on
 * `pagehide`, and a port closed at that moment would discard exactly those
 * frames. Chrome closes the port itself when the document goes away.
 *
 * A test harness's fake window must answer the handshake the way the agent
 * does: when `dispatchEvent` receives an event of type
 * {@link PAGE_HANDSHAKE_REQUEST_EVENT}, call the listener registered for
 * {@link PAGE_HANDSHAKE_OFFER_EVENT} with `{ detail: token }`, where `token` is
 * 64 lowercase hexadecimal characters. Until a token is held, nothing is posted
 * to the page.
 *
 * @param deps The runtime, window, timers, jitter source and clock to use.
 * @returns The bridge's control surface.
 */
export function createContentBridge(deps: ContentBridgeDeps): ContentBridge {
  const runtime = deps.chrome;
  const page = deps.window;
  const setTimer = deps.setTimeout ?? defaultSetTimeout;
  const clearTimer = deps.clearTimeout ?? defaultClearTimeout;
  const random = deps.random ?? ((): number => Math.random());
  const now = deps.now ?? ((): number => Date.now());

  const stats = emptyStats();

  let started = false;
  let terminated = false;
  let connection: Connection | undefined;
  let everConnected = false;
  let pendingReconnect: PendingReconnect | undefined;
  let attempt = 0;
  let pageSignal: PageSignal = 'none';

  // The handshake token: this document's secret for bridge → page frames. Held
  // only here, never logged, never sent upstream, kept across stop()/start().
  let token: string | undefined;
  let handshakeRequested = false;
  let offerListenerAttached = false;

  // The last relayed `agent.ready` payload — the only page data this module
  // retains, and only so a new port can re-announce the document.
  let lastReady: PageAgentReadyPayload | undefined;

  /** Whether the extension context is still alive (not reloaded, updated or removed). */
  function isContextAlive(): boolean {
    try {
      const id = runtime.id;
      return typeof id === 'string' && id.length > 0;
    } catch {
      return false;
    }
  }

  /* ----------------------------- page side ------------------------------ */

  /** Post one frame to the page; `false` if the window refused it. */
  function postToPage(frame: BridgeChannelMessage): boolean {
    try {
      page.postMessage(frame, PAGE_MESSAGE_TARGET_ORIGIN);
      return true;
    } catch {
      stats.faults += 1;
      return false;
    }
  }

  /** Tell the agent the port is usable, so it flushes and re-announces. */
  function signalReady(): void {
    if (token === undefined || connection === undefined) {
      return;
    }
    if (postToPage(signalFrame('bridge.ready', token))) {
      pageSignal = 'ready';
    }
  }

  /**
   * Tell the agent the port is gone, so it buffers. Sent once per absence;
   * without a token nothing can be sent, and the agent is buffering already.
   */
  function signalGone(): void {
    if (pageSignal === 'gone') {
      return;
    }
    pageSignal = 'gone';
    if (token !== undefined) {
      postToPage(signalFrame('bridge.gone', token));
    }
  }

  /** Keep the first well-formed token the agent offers; ignore every later offer. */
  function onHandshakeOffer(event: unknown): void {
    try {
      const detail = readEventDetail(event);
      if (token !== undefined || !isPageHandshakeToken(detail)) {
        return;
      }
      token = detail;
      stats.handshakeComplete = true;
      detachOfferListener();
      // An agent evaluated after this bridge discloses its token unsolicited;
      // if the port is already open, the agent learns about it now.
      signalReady();
    } catch {
      stats.faults += 1;
    }
  }

  function attachOfferListener(): void {
    if (offerListenerAttached || token !== undefined) {
      return;
    }
    page.addEventListener(PAGE_HANDSHAKE_OFFER_EVENT, onHandshakeOffer);
    offerListenerAttached = true;
  }

  function detachOfferListener(): void {
    if (!offerListenerAttached) {
      return;
    }
    offerListenerAttached = false;
    page.removeEventListener(PAGE_HANDSHAKE_OFFER_EVENT, onHandshakeOffer);
  }

  /**
   * The bridge's half of the handshake. The offer listener must exist before
   * the request is dispatched, because the agent answers inside the dispatch.
   * The request is made once per document: the agent answers only the first.
   */
  function requestHandshake(): void {
    attachOfferListener();
    if (handshakeRequested || token !== undefined) {
      return;
    }
    handshakeRequested = true;
    if (typeof CustomEvent !== 'function') {
      return;
    }
    page.dispatchEvent(new CustomEvent(PAGE_HANDSHAKE_REQUEST_EVENT));
  }

  /** Whether a rejected event is one of this bridge's own frames seen again. */
  function isOwnEcho(data: unknown): boolean {
    return token !== undefined && isBridgeChannelMessage(data) && data.token === token;
  }

  /** The page `message` listener: filter, then relay or count. */
  function onPageMessage(event: unknown): void {
    try {
      const pageEvent = readPageMessageEvent(event);
      const decision = shouldAcceptPageMessage(pageEvent, { window: page });
      if (decision.accepted) {
        relayUp(decision.message);
        return;
      }
      // A window receives what it posts, so every frame this bridge sends the
      // agent comes back here. That is not a drop, and is not counted as one.
      if (decision.reason === 'wrong-tag' && isOwnEcho(pageEvent.data)) {
        stats.echoesIgnored += 1;
        return;
      }
      stats.dropped[decision.reason] += 1;
    } catch {
      stats.faults += 1;
    }
  }

  /** The `pageshow` listener: a back/forward-cache restore needs a fresh port. */
  function onPageShow(event: unknown): void {
    try {
      if (!started || terminated || !isPersistedPageShow(event)) {
        return;
      }
      const frozen = connection;
      if (frozen !== undefined) {
        releaseConnection(frozen, true);
      }
      attempt = 0;
      cancelReconnect();
      openPort();
    } catch {
      stats.faults += 1;
    }
  }

  function attachPageListeners(): void {
    page.addEventListener('message', onPageMessage);
    page.addEventListener('pageshow', onPageShow);
  }

  function detachPageListeners(): void {
    try {
      page.removeEventListener('message', onPageMessage);
      page.removeEventListener('pageshow', onPageShow);
      detachOfferListener();
    } catch {
      stats.faults += 1;
    }
  }

  /* ---------------------------- worker side ----------------------------- */

  /** Relay an accepted agent frame upstream, remembering the latest `agent.ready`. */
  function relayUp(message: AgentChannelMessage): void {
    if (message.type === 'agent.ready') {
      lastReady = message.payload;
    }
    postUp(toUpstreamFrame(message));
  }

  /** Post one frame on the port, or count it as lost if there is no usable port. */
  function postUp(frame: BridgeUpstreamMessage): void {
    const current = connection;
    if (current === undefined) {
      stats.droppedWhileDisconnected += 1;
      signalGone();
      if (pendingReconnect === undefined) {
        openPort();
      }
      return;
    }
    try {
      current.port.postMessage(frame);
      stats.forwardedUp += 1;
    } catch {
      // "Attempting to use a disconnected port object": the same as a
      // disconnect that has not been reported yet.
      stats.droppedWhileDisconnected += 1;
      loseConnection(current, true);
    }
  }

  /** Deliver a worker frame to the page, if it is one and the page can verify it. */
  function handlePortMessage(source: Connection, message: unknown): void {
    try {
      if (connection !== source) {
        return;
      }
      if (!isBridgeDownstreamMessage(message)) {
        stats.droppedDownUnrecognised += 1;
        return;
      }
      // The worker answered, so it is reachable: the backoff starts over.
      attempt = 0;
      if (token === undefined) {
        stats.droppedDownNoHandshake += 1;
        return;
      }
      if (postToPage(toPageFrame(message, token))) {
        stats.forwardedDown += 1;
      }
    } catch {
      stats.faults += 1;
    }
  }

  /**
   * The port's `onDisconnect`. Reading `lastError` inside the callback is what
   * keeps Chrome from printing an "Unchecked runtime.lastError" warning into
   * the developer's console; the message itself is not kept.
   */
  function handleDisconnect(lost: Connection): void {
    try {
      if (runtime.lastError !== undefined) {
        stats.disconnectErrors += 1;
      }
    } catch {
      stats.faults += 1;
    }
    loseConnection(lost, false);
  }

  /** Forget a connection: remove its listeners and, if asked, close the port. */
  function releaseConnection(released: Connection, closePort: boolean): void {
    if (connection === released) {
      connection = undefined;
      stats.connected = false;
    }
    try {
      released.port.onMessage.removeListener(released.onMessage);
      released.port.onDisconnect.removeListener(released.onDisconnect);
    } catch {
      stats.faults += 1;
    }
    if (closePort) {
      try {
        released.port.disconnect();
      } catch {
        // Disconnecting a port that is already closed, or whose extension
        // context is gone, has nothing left to undo.
      }
    }
  }

  /** The current port died: tell the page, then reconnect or terminate. */
  function loseConnection(lost: Connection, closePort: boolean): void {
    if (connection !== lost) {
      return;
    }
    releaseConnection(lost, closePort);
    if (!isContextAlive()) {
      terminate();
      return;
    }
    signalGone();
    if (now() - lost.openedAt >= BRIDGE_PORT_STABLE_MS) {
      attempt = 0;
    }
    scheduleReconnect();
  }

  /** Open a port if the bridge is running and has none; wakes a suspended worker. */
  function openPort(): void {
    if (!started || terminated || connection !== undefined) {
      return;
    }
    cancelReconnect();
    if (!isContextAlive()) {
      terminate();
      return;
    }

    let port: PortLike;
    try {
      port = runtime.connect({ name: PORT_CONTENT_BRIDGE });
    } catch {
      // "Extension context invalidated" throws here; anything else is retried.
      if (isContextAlive()) {
        scheduleReconnect();
      } else {
        terminate();
      }
      return;
    }

    const opened: Connection = {
      port,
      openedAt: now(),
      onMessage: (message: unknown): void => {
        handlePortMessage(opened, message);
      },
      onDisconnect: (): void => {
        handleDisconnect(opened);
      },
    };

    try {
      port.onMessage.addListener(opened.onMessage);
      port.onDisconnect.addListener(opened.onDisconnect);
    } catch {
      stats.faults += 1;
      releaseConnection(opened, true);
      scheduleReconnect();
      return;
    }

    connection = opened;
    stats.connected = true;
    if (everConnected) {
      stats.reconnects += 1;
    }
    everConnected = true;

    signalReady();
    // Re-announce the document on the new port, so the worker can re-send the
    // live `agent.config` and the same capture continues (AAP §0.5.5). The
    // worker deduplicates by `documentId` and `producerId`.
    if (lastReady !== undefined) {
      postUp(readyFrame(lastReady));
    }
  }

  /** Schedule one reconnect with backoff, unless one is pending or pointless. */
  function scheduleReconnect(): void {
    if (!started || terminated || connection !== undefined || pendingReconnect !== undefined) {
      return;
    }
    const delay = computeReconnectDelay(attempt, random);
    attempt = Math.min(attempt + 1, MAX_BACKOFF_EXPONENT);

    const pending: PendingReconnect = { handle: undefined };
    pendingReconnect = pending;
    try {
      pending.handle = setTimer(() => {
        // A cancelled or superseded timer that fires anyway does nothing.
        if (pendingReconnect !== pending) {
          return;
        }
        pendingReconnect = undefined;
        openPort();
      }, delay);
    } catch {
      if (pendingReconnect === pending) {
        pendingReconnect = undefined;
      }
      stats.faults += 1;
    }
  }

  function cancelReconnect(): void {
    const pending = pendingReconnect;
    if (pending === undefined) {
      return;
    }
    pendingReconnect = undefined;
    try {
      clearTimer(pending.handle);
    } catch {
      stats.faults += 1;
    }
  }

  /** Stop for good: the extension context is gone and can never come back. */
  function terminate(): void {
    if (terminated) {
      return;
    }
    terminated = true;
    stats.terminated = true;
    cancelReconnect();
    const current = connection;
    if (current !== undefined) {
      releaseConnection(current, true);
    }
    signalGone();
    detachPageListeners();
    started = false;
  }

  /* ---------------------------- control surface ------------------------- */

  function start(): void {
    if (started || terminated) {
      return;
    }
    if (!isContextAlive()) {
      terminate();
      return;
    }
    started = true;
    attempt = 0;
    try {
      attachPageListeners();
      requestHandshake();
    } catch {
      stats.faults += 1;
    }
    openPort();
  }

  function stop(): void {
    if (!started) {
      return;
    }
    started = false;
    cancelReconnect();
    const current = connection;
    if (current !== undefined) {
      releaseConnection(current, true);
    }
    signalGone();
    detachPageListeners();
  }

  return {
    start,
    stop,
    isConnected: (): boolean => connection !== undefined,
    getStats: (): BridgeStats => ({ ...stats, dropped: { ...stats.dropped } }),
  };
}

/*
 * ===========================================================================
 * Bootstrap
 * ===========================================================================
 */

/** The bridge this realm's bootstrap started, so a second call cannot start another. */
let bootstrapped: ContentBridge | undefined;

/**
 * Whether this realm is an extension content script: a `window`, and a live
 * `chrome.runtime` with an extension id and `connect`. False under Vitest, in
 * a plain page, and in an orphaned content script.
 */
export function isContentScriptEnvironment(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof chrome !== 'undefined' &&
      typeof chrome.runtime === 'object' &&
      typeof chrome.runtime.id === 'string' &&
      chrome.runtime.id.length > 0 &&
      typeof chrome.runtime.connect === 'function'
    );
  } catch {
    return false;
  }
}

/**
 * Start the bridge from the real globals, once per realm.
 *
 * @returns The running bridge — the one a previous call started, if any — or
 * `undefined` outside a content-script realm, where nothing is touched.
 */
export function bootstrapContentBridge(): ContentBridge | undefined {
  if (bootstrapped !== undefined) {
    return bootstrapped;
  }
  if (!isContentScriptEnvironment()) {
    return undefined;
  }
  const bridge = createContentBridge({ chrome: chrome.runtime, window });
  bootstrapped = bridge;
  bridge.start();
  return bridge;
}

// The module's only import-time effect, guarded so that importing it under
// Vitest (no extension `chrome`) is inert. Keep the guard: tests drive
// createContentBridge() with fakes instead.
bootstrapContentBridge();
