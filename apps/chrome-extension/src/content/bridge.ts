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
 * and created its channel node when this script is evaluated — and no page
 * script has run yet. At `document_start` there is no `document.body`; nothing
 * here touches the DOM tree, creates an element or adds a style.
 *
 * ## The two channels it joins
 *
 * ```text
 * handshake (once, on window):
 *   bridge  --CustomEvent(PAGE_HANDSHAKE_REQUEST_EVENT)-->  agent
 *   bridge  <--MouseEvent(PAGE_HANDSHAKE_OFFER_EVENT, { relatedTarget: node })--  agent
 * frames (only on the agent's detached node, detail = JSON string, cancelable):
 *   agent   --CustomEvent(PAGE_AGENT_FRAME_EVENT)-->   bridge   (preventDefault = custody taken)
 *   agent   <--CustomEvent(PAGE_BRIDGE_FRAME_EVENT)--  bridge
 * bridge --chrome.runtime.connect({ name: PORT_CONTENT_BRIDGE })--> service worker
 *        upstream:   agent.ready · telemetry.batch · target.described · agent.error
 *        downstream: agent.config · agent.snapshot · target.request
 * ```
 *
 * Both hops carry **raw** payloads. The bridge parses each agent frame's JSON,
 * validates it and forwards the parsed payload without reshaping or redacting
 * telemetry — the one field it may raise is a batch's `droppedCount`, by the
 * events its own rate budget refused, and the one telemetry frame it composes
 * itself is an event-less batch reporting that loss when no agent batch will
 * (see below): the service worker adds `tabId` from the port's `sender` and
 * wraps event batches into `@debuggen/protocol` envelopes (AAP §0.4.2), and
 * the service validates and redacts at ingest (AAP §0.5.2). The frame shapes,
 * tags, event names, the channel version and the size cap are all imported
 * from `../shared/messages`, which mirrors
 * `packages/telemetry/src/browser/transport.ts` — the owner of the page
 * channel — so nothing about the channel is restated here.
 *
 * ## Why the page hop is a private node and not `window.postMessage`
 *
 * Anything posted on the page's `window` is readable by every script on the
 * page, so a token carried on window frames stops being a secret the moment
 * the first frame is posted, and anyone holding it can post an all-false
 * `agent.config` that disarms a capture. Page channel version 3 therefore
 * carries **no token and nothing on `window` after the handshake**: the agent
 * creates a node it never inserts into the document and hands it over once,
 * as the `relatedTarget` of its answer to this bridge's one request, while no
 * page script has yet run. The bridge keeps the first acceptable node — an
 * event target that is not connected to the document and is not the window —
 * and removes its offer listener as soon as the request's dispatch returns,
 * so a later offer is never even heard. Every frame in either direction is
 * then a `CustomEvent` dispatched on that node, which page scripts cannot
 * reach: they can neither observe the bridge's frames nor inject their own.
 *
 * ## What the node proves, and what it does not
 *
 * A frame on the node was dispatched by code that holds the node: the agent,
 * or code that ran in the page's realm before the agent and subverted it (for
 * example another extension's MAIN-world script). The node does not make the
 * agent's measurements trustworthy — the page shapes what the agent observes —
 * so the bridge still treats every frame as untrusted input:
 * {@link shouldAcceptAgentFrame} bounds and parses it, requires the product's
 * own vocabularies (canonical opaque ids, the closed `agent.error` codes),
 * pins the document's `documentId` and `producerId` from the first accepted
 * `agent.ready` and refuses any later frame that names another, and refuses a
 * `batchSeq` that does not strictly increase within one capture. The worker
 * re-applies the shape checks on the port and the service validates, bounds
 * and redacts at ingest (AAP §0.5.2, §0.5.6).
 *
 * ## A per-document event-rate budget
 *
 * Every event this bridge relays reaches the service under the tab's paired
 * credential, and the page decides how many there are: a page script calling
 * `globalThis.__DEBUGGEN__.span` in a tight loop while a capture is armed
 * produces genuine, well-formed batches as fast as the agent can build them.
 * The per-frame cap bounds one frame, not a stream, so the bridge also meters
 * `telemetry.batch` frames by the **events** they carry with a token bucket —
 * one per bridge, which is one per document ({@link BRIDGE_EVENT_BUDGET_CAPACITY},
 * {@link BRIDGE_EVENT_BUDGET_REFILL_PER_SECOND}, on an injectable monotonic
 * clock). A batch that does not fit the tokens available is refused as
 * `rate-limited` — after every structural and provenance check, so a malformed
 * or forged frame is still reported as what it is — and acknowledged, because
 * an unacknowledged batch parks the agent until the next `bridge.ready`.
 * Tokens are spent only by a batch that was accepted **and** posted on the
 * port; a refused frame, or one left in the agent's custody, spends none.
 *
 * The loss is reported, never hidden, and only ever under its own capture: a
 * count relabelled to another capture is counted against the wrong one, and
 * the service drops a count naming a capture it has closed. The refused
 * batch's events, and the agent's own `droppedCount` it carried (which the
 * agent clears on that acknowledgement), are held in the bucket of the refused
 * batch's capture: one bucket per capture, oldest first, at most
 * {@link BRIDGE_MAX_HELD_LOSS_CAPTURES}. A bucket is added to the
 * `droppedCount` of the next batch of its capture actually posted, and cleared
 * only once that post succeeded. Otherwise the bridge reports it on its own,
 * as a loss-only `telemetry.batch`: no events, the bucket's count as its
 * `droppedCount`, the pinned document and producer, the bucket's capture, and
 * that capture's last relayed `batchSeq` repeated rather than advanced (0 when
 * none was relayed), so it spends no budget and never puts the agent's next
 * batch out of sequence. Buckets are reported oldest first, one frame each; a
 * bucket is cleared only by its own successful post, and the first failed post
 * leaves it and every later bucket held for the next attempt. Reports go out
 * at once: for every other capture's bucket when a batch or a refusal of a
 * capture arrives; and for every bucket after a worker `agent.config` is
 * dispatched (the agent flushes the capture's tail inside it, and the service
 * closes the capture's window soon after), on every new port once
 * `bridge.ready` has let the agent drain (nothing else is left to carry the
 * loss, and the capture's window may be closing), and on a trusted `pagehide`
 * (`isTrusted` cannot be forged by a page script's synthetic event) and for
 * every refusal after it until a trusted `pageshow`. Otherwise they go out
 * {@link BRIDGE_LOSS_REPORT_DELAY_MS} after the first unreported refusal,
 * unless a batch carried the loss first.
 * The worker re-validates `droppedCount` as a safe non-negative integer, so
 * every sum is clamped to `Number.MAX_SAFE_INTEGER`.
 *
 * ## Custody, without a buffer
 *
 * The page agent owns the only buffer (5 000 events, drop-oldest). The bridge
 * tells it, per frame, whether custody passed: it calls `preventDefault()` on
 * an agent frame — making the agent's `dispatchEvent` return `false` — in
 * three cases:
 *
 * 1. it posted the frame on the port;
 * 2. it refused the frame for good (retrying a frame that fails validation can
 *    only fail again);
 * 3. the frame is the agent's own loss-only batch (no events, a positive
 *    `droppedCount`) and no port could take it. The agent posts one only at a
 *    terminal flush, and the capture change that follows a disarm zeroes an
 *    unclaimed count, so the bridge takes the count instead: it holds it in
 *    the bucket of the batch's capture and reports it like its own held loss,
 *    at once on the next port.
 *
 * With no open port, or when `port.postMessage` throws, it does **not**
 * acknowledge any other frame: the frame stays with the agent, which sends it
 * again after the next `bridge.ready`. A throwing post also marks the port
 * lost exactly as a disconnect would — except that `bridge.gone` is only ever
 * sent from the port's `onDisconnect`, `stop()` and termination, never
 * re-entrantly from inside the agent's own dispatch; the unacknowledged frame
 * is the agent's signal there.
 *
 * ## Recovery
 *
 * A Manifest V3 worker suspends after roughly 30 s of idleness, which
 * disconnects this port; the bridge then reconnects with a short, bounded,
 * jittered backoff — connecting is what wakes the worker. On every new port it
 * first re-announces the last accepted `agent.ready` upstream, so
 * `background/agent-control.ts` can re-send `agent.config` and the same
 * `captureId` continues, and then dispatches `bridge.ready` to the agent. The
 * connection state is complete before that dispatch, because the agent drains
 * its buffer and re-announces itself synchronously inside it and every frame
 * it sends re-enters this bridge. No heartbeat is ever sent over a live port:
 * the worker's lifetime is `background/ws-bridge.ts`'s concern (its
 * open-socket heartbeat, and the `chrome.alarms` tick that revives a suspended
 * worker, AAP §0.5.5), and a content-script heartbeat would defeat worker
 * suspension on every localhost tab. When the extension is reloaded or
 * updated, `chrome.runtime.id` disappears; the bridge then stops for good
 * rather than retrying into "Extension context invalidated" errors on every
 * tab.
 *
 * ## What is logged
 *
 * Nothing. The bridge writes no console output at all — no identifier, code,
 * message or URL a page could have shaped — and its only observable state is
 * the counters and closed reason names of {@link BridgeStats}.
 *
 * ## Testability
 *
 * Importing this module has no side effect except one environment-guarded
 * call at the very end ({@link bootstrapContentBridge}), which does nothing
 * outside a real content-script realm. `apps/chrome-extension/test/bridge.test.ts`
 * drives {@link shouldAcceptAgentFrame} and the pure budget arithmetic
 * ({@link refillEventBudget}, {@link consumeEventBudget}) directly, and
 * {@link createContentBridge} through injected `chrome.runtime`, `window`,
 * timer, `random` and clock fakes, with a fake MAIN-world agent performing the
 * agent's half of the handshake.
 *
 * @module apps/chrome-extension/src/content/bridge
 */

import {
  AGENT_OUTBOUND_TYPES,
  AGENT_SOURCE_TAG,
  BRIDGE_SOURCE_TAG,
  EXTENSION_CHANNEL,
  MAX_PAGE_FRAME_LENGTH,
  PAGE_AGENT_FRAME_EVENT,
  PAGE_BRIDGE_FRAME_EVENT,
  PAGE_CHANNEL_VERSION,
  PAGE_HANDSHAKE_OFFER_EVENT,
  PAGE_HANDSHAKE_REQUEST_EVENT,
  PORT_CONTENT_BRIDGE,
  PORT_PROTOCOL_VERSION,
  exceedsPageFrameCap,
  isAgentChannelMessage,
  isBridgeDownstreamMessage,
  renderPageFrame,
} from '../shared/messages';
import type {
  AgentChannelMessage,
  AgentOutboundType,
  BridgeChannelMessage,
  BridgeDownstreamMessage,
  BridgeUpstreamMessage,
  PageAgentReadyPayload,
  PageTelemetryBatchPayload,
} from '../shared/messages';

/*
 * ===========================================================================
 * Structural surfaces
 *
 * The narrow slices of `chrome.runtime`, `chrome.runtime.Port`, `window` and
 * the agent's channel node this module touches. They are local on purpose —
 * not a cross-process contract — and are written so the real globals satisfy
 * them structurally (`createContentBridge({ chrome: chrome.runtime, window })`
 * type-checks in the bootstrap) while a test can pass plain fakes.
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

/**
 * The event-target members the bridge uses on the page `window` and on the
 * agent's channel node. Listeners receive whatever is dispatched and narrow it
 * structurally, which is why their parameter is `unknown` rather than `Event`.
 */
export interface EventTargetLike {
  /** Register an event listener. */
  addEventListener(type: string, listener: (event: unknown) => void): void;
  /** Unregister a listener registered with {@link addEventListener}. */
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  /** Dispatch a DOM event; `false` when a listener called `preventDefault()`. */
  dispatchEvent(event: Event): boolean;
}

/**
 * The members of the page `window` the bridge uses: the one handshake request,
 * the offer listener around it, and the `pageshow` and `pagehide` listeners.
 * Nothing is ever posted on it.
 */
export type WindowLike = EventTargetLike;

/**
 * The agent's private channel node, as the bridge holds it: an event target,
 * never connected to the document.
 */
export interface ChannelNodeLike extends EventTargetLike {
  /** `false` for a detached DOM node; absent for a non-node event target. */
  readonly isConnected?: boolean | undefined;
}

/**
 * Whether a handshake offer's `relatedTarget` can serve as the channel node:
 * an event target with the three methods the bridge calls, and **not**
 * connected to the document — a connected node is one any page script can
 * find with a query, so frames on it would not be private. Pure; never throws
 * for a value an event can carry.
 *
 * @param value The offer's `relatedTarget`.
 */
export function isChannelNodeCandidate(value: unknown): value is ChannelNodeLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'addEventListener' in value &&
    typeof value.addEventListener === 'function' &&
    'removeEventListener' in value &&
    typeof value.removeEventListener === 'function' &&
    'dispatchEvent' in value &&
    typeof value.dispatchEvent === 'function' &&
    !('isConnected' in value && value.isConnected === true)
  );
}

/*
 * ===========================================================================
 * The event-rate budget (pure)
 *
 * A token bucket over telemetry events, one per bridge and so one per
 * document. The arithmetic is pure and takes the clock reading as an argument,
 * so a test exercises refill and spending without timers; the bridge owns the
 * single mutable level and the clock.
 * ===========================================================================
 */

/**
 * The most events one document may relay in a burst: the bucket's capacity,
 * and its level when the document's bridge is created.
 *
 * Two full agent buffers — the agent holds at most 5 000 events
 * (`MAX_BUFFERED_EVENTS` in `packages/telemetry/src/browser/transport.ts`).
 * The largest genuine burst is the agent draining a full buffer after the
 * worker was suspended while the page kept producing, followed by the next
 * buffer's worth before the bucket has refilled; both travel whole.
 */
export const BRIDGE_EVENT_BUDGET_CAPACITY = 10_000;

/**
 * The events one document may relay per second once its burst is spent: the
 * bucket's refill rate.
 *
 * The demo's worst genuine sustained rate is about 200 render events per
 * second — its 48 memoised product cards (the default catalog page) re-render
 * on every 250 ms dispatch tick — and even its largest page (96 cards) stays
 * under 400. 2 000 per second is ten times the default case, so a real
 * capture never meets the limit, while a page calling
 * `globalThis.__DEBUGGEN__.span` in a tight loop is held to a bounded rate
 * and its loss is reported.
 */
export const BRIDGE_EVENT_BUDGET_REFILL_PER_SECOND = 2_000;

/**
 * How long, in milliseconds, loss held from a `rate-limited` refusal waits for
 * a later batch to carry it before the bridge reports it on its own, as a
 * loss-only `telemetry.batch`.
 *
 * Riding on the next batch costs no extra frame, and an agent still producing
 * sends one every `FLUSH_INTERVAL_MS` (250 ms, in
 * `packages/telemetry/src/browser/transport.ts`), so four flush intervals give
 * it every chance to. A burst that ends with a refusal has no next batch; the
 * timer bounds how long its loss can stay unreported. It starts at the first
 * unreported refusal and later refusals do not push it back, so while a port
 * is open no refused event waits longer than this for its report, even in a
 * sustained over-budget stream. Neither the document's end, nor a capture's,
 * nor a worker outage waits for it: a trusted `pagehide`, a dispatched
 * `agent.config`, a new port (once the agent has drained) and a batch or
 * refusal of another capture each report at once. It reports every held
 * capture's bucket, each under its own capture.
 */
export const BRIDGE_LOSS_REPORT_DELAY_MS = 1_000;

/**
 * The most captures whose loss the bridge holds at once: the bound on its
 * per-capture held-loss buckets (the "no capture" bucket included).
 *
 * With a usable port a document holds at most two buckets — the ending
 * capture's and the next one's — and only until the next report. Buckets
 * accumulate only while no report can be posted, one per capture the agent
 * produced for in that time: a handful across one worker outage, since
 * captures are started by the developer. Eight leaves that ample room while a
 * subverted agent naming a fresh capture on every batch still holds a bounded
 * map. When a capture without a bucket would exceed the bound, the oldest
 * bucket's count is abandoned — counted in
 * {@link BridgeStats.abandonedLossEvents} — and never moved to another
 * capture, which would misattribute it.
 */
export const BRIDGE_MAX_HELD_LOSS_CAPTURES = 8;

/** The bucket's level at one instant. */
export interface EventBudget {
  /**
   * The events that may be relayed now: from 0 to
   * {@link BRIDGE_EVENT_BUDGET_CAPACITY}, fractional between whole refills.
   */
  readonly availableEvents: number;
  /**
   * The monotonic clock reading, in milliseconds, the level was measured at;
   * `undefined` until the first reading, which anchors the refill.
   */
  readonly measuredAt: number | undefined;
}

/** A level within `[0, capacity]`; anything non-finite counts as empty. */
function clampBudgetLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(Math.max(level, 0), BRIDGE_EVENT_BUDGET_CAPACITY) : 0;
}

/**
 * A full bucket not yet anchored to the clock: every document starts with its
 * whole burst.
 */
export function fullEventBudget(): EventBudget {
  return { availableEvents: BRIDGE_EVENT_BUDGET_CAPACITY, measuredAt: undefined };
}

/**
 * The bucket's level at clock reading `at`: the events earned since it was
 * last measured, at {@link BRIDGE_EVENT_BUDGET_REFILL_PER_SECOND}, capped at
 * {@link BRIDGE_EVENT_BUDGET_CAPACITY}. Pure.
 *
 * Only forward time earns events. The first reading anchors without earning;
 * a reading earlier than the anchor — the `Date.now` fallback stepping back —
 * earns nothing and re-anchors, so the refill resumes from the new reading
 * instead of waiting for the clock to catch up; a non-finite reading earns
 * nothing and keeps the anchor.
 *
 * @param budget The level as last measured.
 * @param at The monotonic clock reading, in milliseconds.
 * @returns The level at `at`.
 */
export function refillEventBudget(budget: EventBudget, at: number): EventBudget {
  const level = clampBudgetLevel(budget.availableEvents);
  if (!Number.isFinite(at)) {
    return { availableEvents: level, measuredAt: budget.measuredAt };
  }
  const elapsedMs = budget.measuredAt === undefined ? 0 : at - budget.measuredAt;
  const earned = elapsedMs > 0 ? (elapsedMs * BRIDGE_EVENT_BUDGET_REFILL_PER_SECOND) / 1_000 : 0;
  return { availableEvents: clampBudgetLevel(level + earned), measuredAt: at };
}

/**
 * The bucket's level after `events` events were relayed: that many fewer,
 * never below zero. Pure; a non-finite or negative count spends nothing.
 *
 * @param budget The level the batch was judged against.
 * @param events How many events the relayed batch carried.
 * @returns The level after spending.
 */
export function consumeEventBudget(budget: EventBudget, events: number): EventBudget {
  const spent = Number.isFinite(events) && events > 0 ? events : 0;
  return {
    availableEvents: clampBudgetLevel(clampBudgetLevel(budget.availableEvents) - spent),
    measuredAt: budget.measuredAt,
  };
}

/**
 * `a + b` for two event counts, clamped to `Number.MAX_SAFE_INTEGER` — the
 * bound the worker's `droppedCount` guard (`isCount` in `../shared/messages`)
 * enforces, so a sum the bridge sends upward is never refused there.
 */
function addEventCounts(a: number, b: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, a + b);
}

/*
 * ===========================================================================
 * The agent → bridge filter (pure)
 * ===========================================================================
 */

/**
 * Every reason the bridge refuses an agent frame, in the order the checks run —
 * cheapest first, each one short-circuiting the rest. A refused frame is
 * acknowledged to the agent (it would fail again), counted, and never relayed.
 * Tests should iterate this tuple rather than a copied list.
 */
export const BRIDGE_REFUSAL_REASONS = [
  'not-string',
  'oversize',
  'unparseable',
  'not-object',
  'wrong-tag',
  'version-mismatch',
  'unknown-type',
  'malformed-payload',
  'provenance-unknown',
  'provenance-mismatch',
  'sequence-regression',
  // Last: only a batch that passed every structural and provenance check is
  // metered, so a malformed or forged frame is reported as what it is.
  'rate-limited',
] as const;

/** One of {@link BRIDGE_REFUSAL_REASONS}. */
export type BridgeRefusalReason = (typeof BRIDGE_REFUSAL_REASONS)[number];

/** Every refusal reason whose verdict carries nothing but the reason. */
type PlainRefusalReason = Exclude<BridgeRefusalReason, 'rate-limited'>;

/** The document identity pinned from the first accepted `agent.ready`. */
export interface AgentProvenance {
  /** The agent's per-document id. */
  readonly documentId: PageAgentReadyPayload['documentId'];
  /** The agent's producer id, which every event of the document carries. */
  readonly producerId: PageAgentReadyPayload['producerId'];
}

/** The last relayed batch's position: its capture and its `batchSeq`. */
export interface BatchSequencePosition {
  /** The capture the batch was labelled with, or `undefined` for none. */
  readonly captureId: PageTelemetryBatchPayload['captureId'];
  /** The batch's sequence number within that capture. */
  readonly batchSeq: number;
}

/** What the filter judges a frame against: the bridge's provenance and budget state. */
export interface AgentFrameContext {
  /** The pinned document identity; `undefined` until an `agent.ready` was accepted. */
  readonly provenance?: AgentProvenance | undefined;
  /** The last relayed batch's position; `undefined` until one was relayed. */
  readonly sequence?: BatchSequencePosition | undefined;
  /**
   * The size cap, in the agent's own unit (code units of the `detail` string).
   * Defaults to {@link MAX_PAGE_FRAME_LENGTH}; exposed so a test can exercise
   * the cap without building a half-megabyte frame.
   */
  readonly maxLength?: number | undefined;
  /**
   * The event-rate budget available now, already refilled to the present. A
   * `telemetry.batch` carrying more events than `availableEvents` is refused
   * as `rate-limited`. `undefined` judges without a budget; the bridge always
   * passes one.
   */
  readonly budget?: Pick<EventBudget, 'availableEvents'> | undefined;
}

/**
 * The verdict on a batch refused for the event-rate budget: the loss the
 * refusal causes, as counts only, so the bridge can report it upward.
 */
export interface RateLimitedDecision {
  readonly accepted: false;
  readonly reason: 'rate-limited';
  /** The events the refused batch carried; none of them is relayed. */
  readonly events: number;
  /**
   * The agent's own `droppedCount` on the refused batch. The agent clears it
   * when the refusal is acknowledged, so the bridge must report it instead.
   */
  readonly droppedCount: number;
  /**
   * The capture the refused batch was labelled with, or `undefined` for none:
   * the capture its loss belongs to, and so the one the bridge's report of it
   * names.
   */
  readonly captureId: PageTelemetryBatchPayload['captureId'];
}

/** The filter's verdict: the parsed agent frame, or why it was refused. */
export type AgentFrameDecision =
  | { readonly accepted: true; readonly message: AgentChannelMessage }
  | { readonly accepted: false; readonly reason: PlainRefusalReason }
  | RateLimitedDecision;

/** A plain object: not `null`, not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Membership in the agent's closed outbound vocabulary. */
function isAgentOutboundType(value: unknown): value is AgentOutboundType {
  return typeof value === 'string' && AGENT_OUTBOUND_TYPES.some((type) => type === value);
}

/** A refusal verdict that carries only its reason. */
function refuse(reason: PlainRefusalReason): AgentFrameDecision {
  return { accepted: false, reason };
}

/** Whether a payload names exactly the pinned document and producer. */
function matchesProvenance(
  pinned: AgentProvenance,
  payload: { readonly documentId: unknown; readonly producerId: unknown },
): boolean {
  return payload.documentId === pinned.documentId && payload.producerId === pinned.producerId;
}

/**
 * The provenance and sequence checks for a frame that already passed the
 * shape checks, or `undefined` when it passes them too.
 *
 * - `agent.ready` pins the document when nothing is pinned yet; afterwards it
 *   must name the pinned document and producer (`provenance-mismatch`).
 * - `telemetry.batch` needs a pinned document (`provenance-unknown`); its
 *   `documentId`, its `producerId` and every event's `producerId` must match
 *   it (`provenance-mismatch`); and within one `captureId` its `batchSeq` must
 *   be strictly greater than the last relayed batch's (`sequence-regression`).
 *   A different `captureId` — the agent restarts `batchSeq` at 0 on every
 *   capture change — starts the sequence afresh.
 * - `target.described` and `agent.error` carry no identity; the node they
 *   arrived on is their provenance, and the shape checks their content.
 */
function provenanceRefusal(
  message: AgentChannelMessage,
  context: AgentFrameContext,
): PlainRefusalReason | undefined {
  const pinned = context.provenance;
  switch (message.type) {
    case 'agent.ready':
      return pinned === undefined || matchesProvenance(pinned, message.payload)
        ? undefined
        : 'provenance-mismatch';
    case 'telemetry.batch': {
      if (pinned === undefined) {
        return 'provenance-unknown';
      }
      const payload = message.payload;
      if (
        !matchesProvenance(pinned, payload) ||
        payload.events.some((event) => event.producerId !== pinned.producerId)
      ) {
        return 'provenance-mismatch';
      }
      const last = context.sequence;
      if (
        last !== undefined &&
        last.captureId === payload.captureId &&
        payload.batchSeq <= last.batchSeq
      ) {
        return 'sequence-regression';
      }
      return undefined;
    }
    case 'target.described':
    case 'agent.error':
      return undefined;
  }
}

/**
 * The event-rate check for a frame that passed every other check, or
 * `undefined` when it passes this one too.
 *
 * Only `telemetry.batch` is metered, by the events it carries: that is the
 * volume a page can drive. `agent.ready`, `target.described` and `agent.error`
 * are the agent's control traffic and pass unmetered. Without a budget in the
 * context nothing is metered.
 */
function budgetRefusal(
  message: AgentChannelMessage,
  context: AgentFrameContext,
): RateLimitedDecision | undefined {
  const budget = context.budget;
  if (budget === undefined || message.type !== 'telemetry.batch') {
    return undefined;
  }
  const events = message.payload.events.length;
  // Written as "fits" so that a non-finite level refuses rather than admits.
  if (events <= budget.availableEvents) {
    return undefined;
  }
  return {
    accepted: false,
    reason: 'rate-limited',
    events,
    droppedCount: message.payload.droppedCount,
    captureId: message.payload.captureId,
  };
}

/**
 * Decide whether an agent frame's `detail` is a frame the bridge should relay.
 * Pure: no side effects, no logging, no `chrome` or DOM access, and no
 * exception for any value an event can carry.
 *
 * The checks run cheapest first and stop at the first failure:
 *
 * 1. the `detail` is a string — every frame travels as JSON text
 *    (`not-string`);
 * 2. its length is within the cap, measured in the agent's own unit so a
 *    frame the agent was willing to send is never refused here, and checked
 *    before parsing so the cap also bounds the parse (`oversize`);
 * 3. it parses as JSON (`unparseable`);
 * 4. the value is a non-null, non-array object (`not-object`);
 * 5. its `source` is {@link AGENT_SOURCE_TAG} (`wrong-tag`);
 * 6. its `version` is exactly {@link PAGE_CHANNEL_VERSION}, so a stale agent
 *    left in a cached page is ignored rather than misread
 *    (`version-mismatch`);
 * 7. its `type` is one of {@link AGENT_OUTBOUND_TYPES} (`unknown-type`);
 * 8. its payload has that type's fields, canonical identifiers and, for
 *    `agent.error`, a recognised code or loss reason, per the shared
 *    {@link isAgentChannelMessage} (`malformed-payload`);
 * 9. it is consistent with the document's pinned provenance and batch
 *    sequence (`provenance-unknown`, `provenance-mismatch`,
 *    `sequence-regression`; see the context's fields);
 * 10. a `telemetry.batch` carries no more events than the context's budget
 *    holds (`rate-limited`, whose verdict also carries the batch's event
 *    count and `droppedCount` — the loss the refusal causes — and the capture
 *    that loss belongs to).
 *
 * @param detail The frame event's `detail`, exactly as dispatched.
 * @param context The pinned provenance, the last batch position, the
 * available event budget and, optionally, a smaller size cap.
 * @returns The parsed frame — a fresh object in this world, never a page
 * object — or the reason it was refused.
 */
export function shouldAcceptAgentFrame(
  detail: unknown,
  context: AgentFrameContext = {},
): AgentFrameDecision {
  if (typeof detail !== 'string') {
    return refuse('not-string');
  }
  if (exceedsPageFrameCap(detail, context.maxLength ?? MAX_PAGE_FRAME_LENGTH)) {
    return refuse('oversize');
  }

  let data: unknown;
  try {
    data = JSON.parse(detail);
  } catch {
    return refuse('unparseable');
  }

  if (!isRecord(data)) {
    return refuse('not-object');
  }
  if (data.source !== AGENT_SOURCE_TAG) {
    return refuse('wrong-tag');
  }
  if (data.version !== PAGE_CHANNEL_VERSION) {
    return refuse('version-mismatch');
  }
  if (!isAgentOutboundType(data.type)) {
    return refuse('unknown-type');
  }
  if (!isAgentChannelMessage(data)) {
    return refuse('malformed-payload');
  }

  const reason = provenanceRefusal(data, context);
  if (reason !== undefined) {
    return refuse(reason);
  }
  return budgetRefusal(data, context) ?? { accepted: true, message: data };
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
   * Schedules the reconnect timer and the loss-report timer. Defaults to
   * `globalThis.setTimeout`, looked up at call time so test fake timers apply.
   */
  readonly setTimeout?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  /** Cancels a handle returned by {@link setTimeout}. Defaults to `globalThis.clearTimeout`. */
  readonly clearTimeout?: ((handle: unknown) => void) | undefined;
  /** Jitter source in `[0, 1)`. Defaults to `Math.random`. */
  readonly random?: (() => number) | undefined;
  /** Clock in milliseconds, for port-stability decisions. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /**
   * Monotonic clock in milliseconds, for the event-rate budget's refill.
   * Defaults to `performance.now` where the realm has it, else `Date.now`,
   * looked up at call time. Kept apart from {@link now} so a test can hold the
   * budget's time still while reconnect timers run, and so the budget never
   * follows a wall clock that steps.
   */
  readonly monotonicNow?: (() => number) | undefined;
}

/**
 * A snapshot of the bridge's counters and state. Only numbers, booleans and
 * the closed reason names of {@link BRIDGE_REFUSAL_REASONS} appear in it —
 * never an identifier, code, message or URL from the page.
 */
export interface BridgeStats {
  /** Whether a port to the worker is currently open. */
  readonly connected: boolean;
  /** Whether this document's channel node is held. */
  readonly handshakeComplete: boolean;
  /** Whether the bridge stopped for good because the extension context was invalidated. */
  readonly terminated: boolean;
  /** Agent frames posted on the port and acknowledged to the agent. */
  readonly relayed: number;
  /** `agent.ready` re-announcements the bridge itself posted on a new port. */
  readonly reannounced: number;
  /** Agent frames refused by {@link shouldAcceptAgentFrame}, per reason (each acknowledged). */
  readonly refused: Readonly<Record<BridgeRefusalReason, number>>;
  /**
   * Accepted agent frames left in the agent's custody — not acknowledged —
   * because no port was usable; the agent sends them again after `bridge.ready`.
   */
  readonly unclaimed: number;
  /** Worker frames dispatched to the agent on the channel node. */
  readonly forwardedDown: number;
  /** Of {@link forwardedDown}, the frames the agent claimed with `preventDefault()`. */
  readonly acknowledgedDown: number;
  /** Ports opened after the first one. */
  readonly reconnects: number;
  /** Handshake offers not taken: a node that did not qualify, or any offer after the first. */
  readonly offersRejected: number;
  /** Port messages that were not well-formed worker → bridge frames. */
  readonly droppedDownUnrecognised: number;
  /** Worker frames discarded because no channel node was held to send them on. */
  readonly droppedDownNoChannel: number;
  /** Worker frames discarded because they could not be rendered within the cap. */
  readonly droppedDownUnrenderable: number;
  /** Port closures that carried a `chrome.runtime.lastError`. */
  readonly disconnectErrors: number;
  /** Unexpected exceptions caught so that none reaches the page or its console. */
  readonly faults: number;
  /**
   * Events in the batches refused as `rate-limited`, over the bridge's
   * lifetime ({@link refused} counts those batches).
   */
  readonly rateLimitedEvents: number;
  /**
   * Loss not yet reported upward, summed across every capture's bucket: the
   * events of `rate-limited` batches plus the agent's own `droppedCount` they
   * carried, and the count of every agent loss-only batch the bridge took
   * without a port. Each bucket is added to the `droppedCount` of the next
   * batch of its capture posted on the port — or posted as a loss-only batch
   * of that capture (see {@link BRIDGE_LOSS_REPORT_DELAY_MS} for when) — and
   * then leaves this sum.
   */
  readonly pendingDroppedCount: number;
  /**
   * Loss-only `telemetry.batch` frames the bridge itself posted to report held
   * loss that no agent batch carried: one per capture's bucket per report
   * (see {@link BRIDGE_LOSS_REPORT_DELAY_MS}).
   */
  readonly lossReports: number;
  /**
   * The agent's own loss-only batches that no port could take, acknowledged
   * so the agent's capture reset cannot zero them, whose counts the bridge
   * holds in their captures' buckets (custody case 3 in the module notes).
   */
  readonly agentLossReportsHeld: number;
  /**
   * Held loss given up because a new capture's bucket would have exceeded
   * {@link BRIDGE_MAX_HELD_LOSS_CAPTURES}: the oldest bucket's count, which is
   * never relabelled to another capture. Zero unless more captures than that
   * held loss while no report could be posted.
   */
  readonly abandonedLossEvents: number;
  /** Whole events the event-rate budget held when it was last measured or spent. */
  readonly budgetAvailableEvents: number;
}

/** The handle {@link createContentBridge} returns. */
export interface ContentBridge {
  /**
   * Attach the listeners, perform the handshake (once per document) and open
   * the port. Idempotent; a no-op after termination.
   */
  start(): void;
  /**
   * Remove every listener, cancel any pending reconnect and loss report,
   * disconnect the port and tell the agent `bridge.gone`. Idempotent. The
   * channel node is kept, because the agent answers only one handshake
   * request per document; so is any held loss, which the next port reports
   * at once, after its `bridge.ready`, on a restart.
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
type MutableStats = { -readonly [Key in keyof Omit<BridgeStats, 'refused'>]: BridgeStats[Key] } & {
  refused: Record<BridgeRefusalReason, number>;
};

/**
 * A fresh counter set: every counter zero, the budget full. Written out so
 * adding a reason without a slot fails to compile.
 */
function emptyStats(): MutableStats {
  return {
    connected: false,
    handshakeComplete: false,
    terminated: false,
    relayed: 0,
    reannounced: 0,
    refused: {
      'not-string': 0,
      oversize: 0,
      unparseable: 0,
      'not-object': 0,
      'wrong-tag': 0,
      'version-mismatch': 0,
      'unknown-type': 0,
      'malformed-payload': 0,
      'provenance-unknown': 0,
      'provenance-mismatch': 0,
      'sequence-regression': 0,
      'rate-limited': 0,
    },
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
}

/** The default timer, resolved at call time so fake timers installed later apply. */
function defaultSetTimeout(callback: () => void, delayMs: number): unknown {
  return globalThis.setTimeout(callback, delayMs);
}

/**
 * The default cancellation. Browser timer handles are numbers; any other handle
 * is left to fire, which is harmless because a stale timer callback is ignored
 * (see `scheduleReconnect` and `scheduleLossReport`).
 */
function defaultClearTimeout(handle: unknown): void {
  if (typeof handle === 'number') {
    globalThis.clearTimeout(handle);
  }
}

/**
 * The default budget clock: `performance.now()` — monotonic, unaffected by
 * wall-clock changes — resolved at call time, or `Date.now()` in a realm
 * without it. Either way the budget only ever measures differences.
 */
function defaultMonotonicNow(): number {
  if (typeof performance === 'object' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** A `CustomEvent`'s `detail`, read structurally. */
function readEventDetail(event: unknown): unknown {
  return typeof event === 'object' && event !== null && 'detail' in event
    ? event.detail
    : undefined;
}

/** A `MouseEvent`'s `relatedTarget`, read structurally. */
function readRelatedTarget(event: unknown): unknown {
  return typeof event === 'object' && event !== null && 'relatedTarget' in event
    ? event.relatedTarget
    : undefined;
}

/** The one member of a cancelable event the bridge calls. */
interface CancelableEventLike {
  preventDefault(): void;
}

/** Whether an event exposes `preventDefault`, read structurally. */
function isCancelableEvent(event: unknown): event is CancelableEventLike {
  return (
    typeof event === 'object' &&
    event !== null &&
    'preventDefault' in event &&
    typeof event.preventDefault === 'function'
  );
}

/**
 * Take custody of an agent frame: `preventDefault()` makes the agent's
 * `dispatchEvent` return `false`, which is its acknowledgement.
 */
function acknowledge(event: unknown): void {
  if (isCancelableEvent(event)) {
    event.preventDefault();
  }
}

/** Whether a `pageshow` event reports a restore from the back/forward cache. */
function isPersistedPageShow(event: unknown): boolean {
  return (
    typeof event === 'object' && event !== null && 'persisted' in event && event.persisted === true
  );
}

/**
 * Whether an event was dispatched by the browser itself rather than by a
 * script: `isTrusted` is exactly `true`. A page script can dispatch its own
 * `pagehide` or `pageshow` on `window`, but the event it builds always has
 * `isTrusted` `false` — the property is unforgeable, and anything a page
 * script sets on the event object stays in the MAIN world, invisible to this
 * isolated world. Read structurally and defensively: anything else, or a
 * read that throws, counts as untrusted.
 */
function isTrustedEvent(event: unknown): boolean {
  try {
    return (
      typeof event === 'object' &&
      event !== null &&
      'isTrusted' in event &&
      event.isTrusted === true
    );
  } catch {
    return false;
  }
}

/** The framing fields of every upstream port frame. */
const UPSTREAM_FRAMING = {
  channel: EXTENSION_CHANNEL,
  version: PORT_PROTOCOL_VERSION,
  direction: 'upstream',
} as const;

/**
 * Wrap an accepted agent frame for the port: same `type`, same (parsed)
 * payload object. One case per type so each payload keeps its exact type
 * without a cast.
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

/**
 * An accepted frame with `loss` more events in its `droppedCount`: how the
 * bridge reports what its rate budget refused, on the next batch that
 * travels. The sum is clamped to the bound the worker's guard enforces. Any
 * other frame, and a batch with no loss to add, is returned unchanged.
 */
function withReportedLoss(message: AgentChannelMessage, loss: number): AgentChannelMessage {
  if (message.type !== 'telemetry.batch' || loss <= 0) {
    return message;
  }
  return {
    ...message,
    payload: {
      ...message.payload,
      droppedCount: addEventCounts(message.payload.droppedCount, loss),
    },
  };
}

/** The upstream frame that re-announces a cached `agent.ready` payload. */
function readyFrame(payload: PageAgentReadyPayload): BridgeUpstreamMessage {
  return { ...UPSTREAM_FRAMING, type: 'agent.ready', payload };
}

/** The framing fields of every bridge → agent frame. No token: the node is the privacy. */
const PAGE_FRAMING = {
  source: BRIDGE_SOURCE_TAG,
  version: PAGE_CHANNEL_VERSION,
} as const;

/**
 * Build the bridge → agent frame for a worker frame: the bridge's tag, the
 * channel version and the worker's payload object unchanged.
 */
function toPageFrame(message: BridgeDownstreamMessage): BridgeChannelMessage {
  switch (message.type) {
    case 'agent.config':
      return { ...PAGE_FRAMING, type: message.type, payload: message.payload };
    case 'agent.snapshot':
      return { ...PAGE_FRAMING, type: message.type, payload: message.payload };
    case 'target.request':
      return { ...PAGE_FRAMING, type: message.type, payload: message.payload };
  }
}

/** A `bridge.ready` or `bridge.gone` signal frame; the payload is always `{}`. */
function signalFrame(type: 'bridge.ready' | 'bridge.gone'): BridgeChannelMessage {
  return type === 'bridge.ready'
    ? { ...PAGE_FRAMING, type: 'bridge.ready', payload: {} }
    : { ...PAGE_FRAMING, type: 'bridge.gone', payload: {} };
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

/**
 * A scheduled report of held loss. Its identity is what marks a timer
 * callback as current, as for {@link PendingReconnect}.
 */
interface PendingLossReport {
  handle: unknown;
}

/** The capture a held count belongs to; `undefined` is the "no capture" bucket. */
type HeldLossCapture = PageTelemetryBatchPayload['captureId'];

/**
 * Held loss, one bucket per capture: the capture → its positive unreported
 * count. A `Map`, so iteration is insertion order — oldest bucket first — and
 * `undefined` is a key distinct from every capture id. A bucket is created
 * when its capture first holds loss, deleted once reported, never merged with
 * another, and bounded in number by {@link BRIDGE_MAX_HELD_LOSS_CAPTURES}.
 */
type HeldLoss = Map<HeldLossCapture, number>;

/** What the page agent was last told about the port. */
type PageSignal = 'none' | 'ready' | 'gone';

/**
 * What became of one bridge → agent frame: `claimed` (the agent called
 * `preventDefault()`), `delivered` (dispatched, not claimed), or why it was
 * not dispatched at all.
 */
type DownstreamOutcome = 'claimed' | 'delivered' | 'no-channel' | 'unrenderable' | 'failed';

/** How a lost port is handled. */
interface LossOptions {
  /** Close the port from this side too (it has not reported its own closure). */
  readonly closePort: boolean;
  /**
   * Send `bridge.gone` now. `false` inside the agent's own frame dispatch,
   * where the unacknowledged frame already tells the agent and a re-entrant
   * dispatch back to it must not happen.
   */
  readonly tellAgent: boolean;
}

/**
 * Create the relay between the page agent and the service worker. Constructing
 * it touches nothing: no listener, no port, no timer until {@link ContentBridge.start}.
 *
 * Lifecycle of one document:
 *
 * - `start()` attaches the `pageshow` and `pagehide` listeners, performs the
 *   handshake (offer listener, one request — the agent answers synchronously
 *   — offer listener removed), attaches the agent-frame listener to the node
 *   it received, opens the port, re-announces the last accepted `agent.ready`
 *   upstream if there is one, dispatches `bridge.ready` to the agent and, if
 *   loss is still held once the agent has drained, reports it at once.
 * - An agent frame on the node is judged by {@link shouldAcceptAgentFrame},
 *   against the document's provenance and its event-rate budget refilled to
 *   the present. A refused frame is counted and acknowledged; a
 *   `rate-limited` batch's loss is also held in its capture's bucket, after
 *   every other capture's bucket was reported at once, and a loss-only report
 *   is armed for {@link BRIDGE_LOSS_REPORT_DELAY_MS} later (or posted at once
 *   while the document is hiding). An accepted batch first has every other
 *   capture's bucket reported on its own; then it, like any accepted frame, is
 *   posted on the port as the matching upstream frame — a batch with its own
 *   capture's bucket added to its `droppedCount` — and acknowledged, and only
 *   then does a batch spend budget and clear that bucket, which disarms the
 *   report once nothing is held. With no port open, or when the post throws,
 *   the frame is left unacknowledged in the agent's custody, spending nothing
 *   (the agent's own loss-only batch is acknowledged instead, and its count
 *   joins its capture's bucket: custody case 3); a throwing port is treated
 *   as lost, and a reconnect is scheduled — never opened inline,
 *   because opening dispatches `bridge.ready` and this runs inside the
 *   agent's own dispatch.
 * - The armed report, when it fires, posts every held bucket, oldest first, as
 *   an event-less `telemetry.batch` of the pinned document under the bucket's
 *   capture, leaving the relayed position, the budget and the agent's custody
 *   untouched. The first post that finds no usable port leaves that bucket
 *   and every later one held; the next port reports them at once.
 * - A well-formed worker frame is dispatched to the agent on the node with
 *   the bridge's tag, {@link PAGE_CHANNEL_VERSION} and the worker's payload.
 *   After an `agent.config`, whose dispatch runs the agent's terminal flush,
 *   held loss is reported at once.
 * - When the port closes (the worker suspended, crashed or refused the
 *   connection), `chrome.runtime.lastError` is read and discarded, the agent
 *   is told `bridge.gone`, and a reconnect is scheduled with
 *   {@link computeReconnectDelay}. The attempt counter resets only for a port
 *   that stayed open {@link BRIDGE_PORT_STABLE_MS} or delivered a worker frame.
 * - A trusted `pagehide` — one the browser dispatched, never a page script's
 *   synthetic event — marks the document as hiding and reports any held loss
 *   at once, because no timer may fire after it; from then on every
 *   `rate-limited` refusal is reported at once too. The agent's own
 *   `pagehide` listener, registered before this bridge existed, flushes its
 *   tail first, so what the budget refuses of that tail is in the report. The
 *   port is neither closed nor released: frames the agent sends after this
 *   listener ran must still travel, and Chrome closes the port itself when
 *   the document goes away.
 * - A trusted `pageshow` ends the hiding state. A `pageshow` restore from the
 *   back/forward cache also opens a fresh port, since Chrome closes extension
 *   ports when it freezes a document.
 * - Once `chrome.runtime.id` is gone the extension context is invalidated: the
 *   bridge tells the agent `bridge.gone` (unless it is inside the agent's own
 *   dispatch), removes every listener, cancels its timers and never
 *   reconnects.
 *
 * A test harness's fake agent must answer the handshake the way the agent
 * does: when the window dispatches {@link PAGE_HANDSHAKE_REQUEST_EVENT},
 * dispatch {@link PAGE_HANDSHAKE_OFFER_EVENT} on the window with a
 * `relatedTarget` that is a detached event target, then send and receive
 * frames only on that target. Until a node is held, nothing is sent to the
 * page.
 *
 * @param deps The runtime, window, timers, jitter source and clocks to use.
 * @returns The bridge's control surface.
 */
export function createContentBridge(deps: ContentBridgeDeps): ContentBridge {
  const runtime = deps.chrome;
  const page = deps.window;
  const setTimer = deps.setTimeout ?? defaultSetTimeout;
  const clearTimer = deps.clearTimeout ?? defaultClearTimeout;
  const random = deps.random ?? ((): number => Math.random());
  const now = deps.now ?? ((): number => Date.now());
  const monotonicNow = deps.monotonicNow ?? defaultMonotonicNow;

  const stats = emptyStats();

  // The document's event-rate budget and the loss that no posted batch has
  // reported yet, one bucket per capture (see HeldLoss). Per bridge, so per
  // document; kept across stop()/start() like the provenance pin.
  let budget: EventBudget = fullEventBudget();
  const heldLoss: HeldLoss = new Map();
  // The one armed loss-only report of the held buckets, if any.
  let pendingLossReport: PendingLossReport | undefined;
  // Set by a trusted `pagehide`, cleared by a trusted `pageshow`: while the
  // document is hiding no timer can be relied on, so held loss is reported at
  // once. Document state, so kept across stop()/start() — a stale `true` only
  // reports sooner, never loses a count.
  let pageHiding = false;

  let started = false;
  let terminated = false;
  let connection: Connection | undefined;
  let everConnected = false;
  let pendingReconnect: PendingReconnect | undefined;
  let attempt = 0;
  let pageSignal: PageSignal = 'none';

  // The private channel: the agent's detached node. Held only here, never
  // exposed, kept across stop()/start() because the agent answers one
  // handshake request per document.
  let channel: ChannelNodeLike | undefined;
  let handshakeRequested = false;
  let channelListenerAttached = false;

  // Provenance state: the document identity pinned from the first accepted
  // `agent.ready`, and the last relayed batch's position. Updated only after
  // a frame is accepted (the pin) or taken into custody (the sequence), so a
  // frame the agent must re-send is never refused as a replay of itself.
  let provenance: AgentProvenance | undefined;
  let sequence: BatchSequencePosition | undefined;

  // The last accepted `agent.ready` payload — the only page data this module
  // retains, in memory only, so a new port can re-announce the document.
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

  /* ----------------------------- rate budget ----------------------------- */

  /** The held loss summed across every capture's bucket, clamped like any count. */
  function heldLossTotal(): number {
    let total = 0;
    for (const count of heldLoss.values()) {
      total = addEventCounts(total, count);
    }
    return total;
  }

  /** Mirror the budget's level and the held loss into the counters. */
  function syncBudgetStats(): void {
    stats.budgetAvailableEvents = Math.floor(budget.availableEvents);
    stats.pendingDroppedCount = heldLossTotal();
  }

  /**
   * Bring the budget to the present before a frame is judged. Committed
   * whatever the frame's fate: refilling only moves the level to now, and
   * spending waits for a posted batch. A clock that throws is a fault and
   * earns nothing, so the frame is still judged — never left parked in the
   * agent's custody by a broken clock.
   */
  function refillBudget(): void {
    let at: number;
    try {
      at = monotonicNow();
    } catch {
      stats.faults += 1;
      at = Number.NaN;
    }
    budget = refillEventBudget(budget, at);
    syncBudgetStats();
  }

  /**
   * Add `count` events to the bucket of `captureId`, creating the bucket last
   * in the order when that capture holds nothing yet. A new bucket that would
   * exceed {@link BRIDGE_MAX_HELD_LOSS_CAPTURES} first abandons the oldest
   * buckets until it fits: their counts leave the held loss for
   * {@link BridgeStats.abandonedLossEvents}, and no other capture receives
   * them. A count that is not positive holds nothing.
   */
  function holdLoss(captureId: HeldLossCapture, count: number): void {
    if (!(count > 0)) {
      return;
    }
    const held = heldLoss.get(captureId);
    if (held === undefined) {
      // Oldest first; deleting the entry being visited is safe for a `Map`.
      for (const [oldest, abandoned] of heldLoss) {
        if (heldLoss.size < BRIDGE_MAX_HELD_LOSS_CAPTURES) {
          break;
        }
        heldLoss.delete(oldest);
        stats.abandonedLossEvents = addEventCounts(stats.abandonedLossEvents, abandoned);
      }
      heldLoss.set(captureId, count);
    } else {
      heldLoss.set(captureId, addEventCounts(held, count));
    }
    syncBudgetStats();
  }

  /**
   * Take `reported` events off the bucket of `captureId` once a post carried
   * them, deleting the bucket when nothing is left; once nothing is held at
   * all, the armed report is disarmed — no separate report is due.
   */
  function releaseHeldLoss(captureId: HeldLossCapture, reported: number): void {
    const held = heldLoss.get(captureId);
    if (held === undefined || reported <= 0) {
      return;
    }
    if (held > reported) {
      heldLoss.set(captureId, held - reported);
    } else {
      heldLoss.delete(captureId);
    }
    syncBudgetStats();
    if (heldLoss.size === 0) {
      cancelLossReport();
    }
  }

  /**
   * Hold a `rate-limited` batch's loss — its events plus the agent's own
   * `droppedCount` it carried — in the bucket of the batch's capture, until a
   * batch of that capture carries it or a loss-only report posts it.
   *
   * A refusal of one capture means the agent has moved past every other
   * capture, so their buckets are reported at once first
   * ({@link reportOtherCapturesLoss}). A report that finds no usable port
   * leaves its bucket held under its own capture: buckets are never merged,
   * and a count never takes another capture's label.
   */
  function holdRateLimitedLoss(decision: RateLimitedDecision): void {
    stats.rateLimitedEvents = addEventCounts(stats.rateLimitedEvents, decision.events);
    reportOtherCapturesLoss(decision.captureId);
    holdLoss(decision.captureId, addEventCounts(decision.events, decision.droppedCount));
  }

  /**
   * Post every held bucket on its own, oldest first, each as one loss-only
   * upstream `telemetry.batch`: no events, the bucket's count as its
   * `droppedCount`, the pinned `producerId` and `documentId`, the bucket's
   * capture (`captureId`, omitted for the "no capture" bucket), and that
   * capture's last relayed `batchSeq` — 0 unless the last relayed batch was of
   * that capture. No `sessionId`: the worker attributes by the tab's binding,
   * and the bridge invents no page context.
   *
   * These are the bridge's own reports, not agent batches: they leave
   * `sequence` where it is, so the agent's next batch (`batchSeq` n + 1) is
   * still in order, and carry no events, so they spend no budget. Nothing is
   * acknowledged or taken from the agent's custody.
   *
   * Posted by the armed report ({@link BRIDGE_LOSS_REPORT_DELAY_MS}), and at
   * once while the document is hiding, after a worker `agent.config` was
   * dispatched to the agent (whose terminal flush of the capture's tail runs
   * inside that dispatch), and on every new port once the agent has drained —
   * so each report reaches the service while its capture's window is still
   * open. {@link reportOtherCapturesLoss} is the same round for every bucket
   * but one capture's.
   *
   * Does nothing with no document pinned — which cannot hold loss, because a
   * batch is refused for provenance before it is ever metered or taken. Each
   * bucket is cleared only by its own successful post, counted in
   * {@link BridgeStats.lossReports}, and once nothing is held the armed report
   * is disarmed. The first post that finds no usable port, or throws, ends the
   * round: that bucket and every later one stay held under their own
   * captures, `postUp` has already arranged the reconnect, and the next port
   * reports them at once.
   */
  function reportHeldLoss(): void {
    postHeldLoss(() => true);
  }

  /**
   * {@link reportHeldLoss} for every bucket except that of `captureId`: what
   * a batch or a refusal of `captureId` reports first, because the agent has
   * moved past the other captures and a batch carries only its own capture's
   * bucket.
   */
  function reportOtherCapturesLoss(captureId: HeldLossCapture): void {
    postHeldLoss((held) => held !== captureId);
  }

  /**
   * The round behind {@link reportHeldLoss}: one loss-only report per held
   * bucket that `include` selects, oldest first, stopping at the first post
   * the port did not take.
   */
  function postHeldLoss(include: (captureId: HeldLossCapture) => boolean): void {
    const pinned = provenance;
    if (pinned === undefined || heldLoss.size === 0) {
      return;
    }
    // A snapshot of the order, because each successful post deletes its bucket.
    for (const [captureId, loss] of [...heldLoss]) {
      if (!include(captureId)) {
        continue;
      }
      const position = sequence;
      const payload: PageTelemetryBatchPayload = {
        events: [],
        producerId: pinned.producerId,
        documentId: pinned.documentId,
        batchSeq:
          position !== undefined && position.captureId === captureId ? position.batchSeq : 0,
        droppedCount: loss,
        ...(captureId === undefined ? {} : { captureId }),
      };
      if (!postUp({ ...UPSTREAM_FRAMING, type: 'telemetry.batch', payload })) {
        return;
      }
      stats.lossReports += 1;
      releaseHeldLoss(captureId, loss);
    }
  }

  /**
   * Arm the one loss-only report of the held buckets, to fire
   * {@link BRIDGE_LOSS_REPORT_DELAY_MS} from now — unless one is already
   * armed (a later refusal never postpones the report), nothing is held, or
   * the bridge is not running.
   */
  function scheduleLossReport(): void {
    if (!started || terminated || pendingLossReport !== undefined || heldLoss.size === 0) {
      return;
    }
    const pending: PendingLossReport = { handle: undefined };
    pendingLossReport = pending;
    try {
      pending.handle = setTimer(() => {
        // A cancelled or superseded timer that fires anyway does nothing.
        if (pendingLossReport !== pending) {
          return;
        }
        pendingLossReport = undefined;
        try {
          reportHeldLoss();
        } catch {
          stats.faults += 1;
        }
      }, BRIDGE_LOSS_REPORT_DELAY_MS);
    } catch {
      if (pendingLossReport === pending) {
        pendingLossReport = undefined;
      }
      stats.faults += 1;
    }
  }

  /** Disarm the armed loss-only report, if any. */
  function cancelLossReport(): void {
    const pending = pendingLossReport;
    if (pending === undefined) {
      return;
    }
    pendingLossReport = undefined;
    try {
      clearTimer(pending.handle);
    } catch {
      stats.faults += 1;
    }
  }

  /**
   * See that held loss gets reported: at once while the document is hiding,
   * when no timer can be relied on to fire; otherwise — or when that post
   * found no usable port — by the armed report, which a document restored
   * from the back/forward cache still fires.
   */
  function arrangeLossReport(): void {
    if (pageHiding) {
      reportHeldLoss();
    }
    scheduleLossReport();
  }

  /**
   * Report held loss now, whatever the document's state; should that post
   * find no usable port, the armed report stays responsible for it.
   */
  function reportHeldLossAtOnce(): void {
    reportHeldLoss();
    scheduleLossReport();
  }

  /* ------------------------------ agent side ----------------------------- */

  /** Dispatch one frame to the agent on the channel node. */
  function sendToAgent(frame: BridgeChannelMessage): DownstreamOutcome {
    const node = channel;
    if (node === undefined) {
      return 'no-channel';
    }
    const detail = renderPageFrame(frame);
    if (detail === undefined) {
      return 'unrenderable';
    }
    try {
      if (typeof CustomEvent !== 'function') {
        stats.faults += 1;
        return 'failed';
      }
      const unclaimed = node.dispatchEvent(
        new CustomEvent(PAGE_BRIDGE_FRAME_EVENT, { detail, cancelable: true }),
      );
      return unclaimed ? 'delivered' : 'claimed';
    } catch {
      stats.faults += 1;
      return 'failed';
    }
  }

  /**
   * Tell the agent the port is usable, so it drains and re-announces. The
   * signal state is written before the dispatch: the agent answers inside it,
   * and every frame it sends re-enters {@link onAgentFrame} against a
   * connection that is already complete.
   */
  function signalReady(): void {
    if (channel === undefined || connection === undefined) {
      return;
    }
    pageSignal = 'ready';
    sendToAgent(signalFrame('bridge.ready'));
  }

  /**
   * Tell the agent the port is gone, so it buffers. Sent once per absence;
   * without a node nothing can be sent, and the agent is buffering already.
   */
  function signalGone(): void {
    if (pageSignal === 'gone') {
      return;
    }
    pageSignal = 'gone';
    sendToAgent(signalFrame('bridge.gone'));
  }

  /**
   * The offer listener, alive only for the duration of the one request
   * dispatch. Keeps the first qualifying node; everything else is counted.
   */
  function onHandshakeOffer(event: unknown): void {
    try {
      const candidate = readRelatedTarget(event);
      if (channel !== undefined || candidate === page || !isChannelNodeCandidate(candidate)) {
        stats.offersRejected += 1;
        return;
      }
      channel = candidate;
      stats.handshakeComplete = true;
    } catch {
      stats.faults += 1;
    }
  }

  /**
   * The bridge's half of the handshake, once per document: the offer listener
   * exists only around the request dispatch, because the agent answers inside
   * it and nothing that arrives later may be believed.
   */
  function performHandshake(): void {
    if (handshakeRequested || channel !== undefined) {
      return;
    }
    handshakeRequested = true;
    if (typeof CustomEvent !== 'function') {
      return;
    }
    page.addEventListener(PAGE_HANDSHAKE_OFFER_EVENT, onHandshakeOffer);
    try {
      page.dispatchEvent(new CustomEvent(PAGE_HANDSHAKE_REQUEST_EVENT));
    } finally {
      page.removeEventListener(PAGE_HANDSHAKE_OFFER_EVENT, onHandshakeOffer);
    }
  }

  /**
   * Custody case 3 (see the module notes): the agent's own loss-only batch
   * found no usable port, so its count joins the bucket of its capture and
   * is reported like the bridge's own held loss — at once on the next port,
   * or by the armed report. The caller acknowledges the frame, which clears
   * the count on the agent's side; the agent's position (`batchSeq`) moves on
   * there, while `sequence` here stays at the last relayed batch.
   */
  function holdAgentLossReport(batch: PageTelemetryBatchPayload): void {
    stats.agentLossReportsHeld += 1;
    holdLoss(batch.captureId, batch.droppedCount);
    arrangeLossReport();
  }

  /**
   * Whether the bridge can still report what it holds: started and not
   * terminated. Read through a call because `postUp` may terminate the bridge
   * (an invalidated context) in the middle of {@link onAgentFrame}.
   */
  function isRunning(): boolean {
    return started && !terminated;
  }

  /**
   * The agent-frame listener on the channel node: judge, then relay and
   * acknowledge, refuse and acknowledge, take an unpostable loss-only
   * report's count and acknowledge, or leave in the agent's custody.
   * Re-entrant by design — it runs inside `bridge.ready` and every other
   * frame the bridge dispatches — so it reads the connection afresh each time
   * and commits provenance state only for frames it accepted, and budget
   * spending and loss reporting only for batches the port took.
   */
  function onAgentFrame(event: unknown): void {
    try {
      if (!started || terminated) {
        stats.unclaimed += 1;
        return;
      }
      refillBudget();
      const decision = shouldAcceptAgentFrame(readEventDetail(event), {
        provenance,
        sequence,
        budget,
      });
      if (!decision.accepted) {
        stats.refused[decision.reason] += 1;
        if (decision.reason === 'rate-limited') {
          // Acknowledged like every refusal: an unacknowledged batch would
          // park the agent until the next `bridge.ready`. Its loss is held for
          // the next batch, and reported on its own if none carries it.
          holdRateLimitedLoss(decision);
          arrangeLossReport();
        }
        acknowledge(event);
        return;
      }

      const message = decision.message;
      if (message.type === 'agent.ready') {
        provenance ??= {
          documentId: message.payload.documentId,
          producerId: message.payload.producerId,
        };
        lastReady = message.payload;
      }

      // A batch carries only its own capture's bucket, cleared only once the
      // port took it: a batch left with the agent reports nothing and loses
      // nothing. Every other capture's bucket is reported on its own first,
      // under its own capture, and never added to this batch.
      const batch = message.type === 'telemetry.batch' ? message.payload : undefined;
      if (batch !== undefined) {
        reportOtherCapturesLoss(batch.captureId);
      }
      const carriedLoss = batch === undefined ? 0 : (heldLoss.get(batch.captureId) ?? 0);
      if (!postUp(toUpstreamFrame(withReportedLoss(message, carriedLoss)))) {
        if (
          batch !== undefined &&
          batch.events.length === 0 &&
          batch.droppedCount > 0 &&
          isRunning()
        ) {
          // The agent posts a loss-only batch only at a terminal flush, and
          // the capture change right after a disarm zeroes an unclaimed count:
          // left with the agent it would be lost, so the bridge takes it.
          holdAgentLossReport(batch);
          acknowledge(event);
          return;
        }
        // Any other frame — every event batch, and a loss-only batch once the
        // bridge can no longer report — stays with the agent, which re-sends
        // it after the next `bridge.ready`.
        stats.unclaimed += 1;
        return;
      }
      if (batch !== undefined) {
        sequence = { captureId: batch.captureId, batchSeq: batch.batchSeq };
        budget = consumeEventBudget(budget, batch.events.length);
        syncBudgetStats();
        releaseHeldLoss(batch.captureId, carriedLoss);
      }
      stats.relayed += 1;
      acknowledge(event);
    } catch {
      stats.faults += 1;
    }
  }

  function attachChannelListener(): void {
    const node = channel;
    if (node === undefined || channelListenerAttached) {
      return;
    }
    node.addEventListener(PAGE_AGENT_FRAME_EVENT, onAgentFrame);
    channelListenerAttached = true;
  }

  function detachChannelListener(): void {
    const node = channel;
    if (node === undefined || !channelListenerAttached) {
      return;
    }
    channelListenerAttached = false;
    node.removeEventListener(PAGE_AGENT_FRAME_EVENT, onAgentFrame);
  }

  /**
   * The `pageshow` listener: a trusted one means the document is showing, so
   * held loss waits for its timer again; a back/forward-cache restore also
   * needs a fresh port.
   */
  function onPageShow(event: unknown): void {
    try {
      if (!started || terminated) {
        return;
      }
      if (isTrustedEvent(event)) {
        pageHiding = false;
      }
      if (!isPersistedPageShow(event)) {
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

  /**
   * The `pagehide` listener: the document is going away (or into the
   * back/forward cache), and no timer may fire after this, so held loss is
   * reported now and every later refusal at once. Only a trusted event
   * counts: a page script's synthetic `pagehide` could otherwise switch the
   * bridge into posting a frame per refusal. The port is left open — the
   * agent may still send frames after this listener ran.
   */
  function onPageHide(event: unknown): void {
    try {
      if (!started || terminated || !isTrustedEvent(event)) {
        return;
      }
      pageHiding = true;
      arrangeLossReport();
    } catch {
      stats.faults += 1;
    }
  }

  function detachListeners(): void {
    try {
      page.removeEventListener('pageshow', onPageShow);
      page.removeEventListener('pagehide', onPageHide);
      page.removeEventListener(PAGE_HANDSHAKE_OFFER_EVENT, onHandshakeOffer);
    } catch {
      stats.faults += 1;
    }
    try {
      detachChannelListener();
    } catch {
      stats.faults += 1;
    }
  }

  /* ----------------------------- worker side ----------------------------- */

  /**
   * Post one frame on the port. `false` — the frame is not in the bridge's
   * custody — when there is no port or the post throws; a throwing port is
   * lost from here on, without a re-entrant `bridge.gone`.
   */
  function postUp(frame: BridgeUpstreamMessage): boolean {
    const current = connection;
    if (current === undefined) {
      // A reconnect is already pending after any loss; this only re-arms one
      // if scheduling failed. Never opened inline (see onAgentFrame).
      scheduleReconnect();
      return false;
    }
    try {
      current.port.postMessage(frame);
      return true;
    } catch {
      // "Attempting to use a disconnected port object": the same as a
      // disconnect that has not been reported yet.
      loseConnection(current, { closePort: true, tellAgent: false });
      return false;
    }
  }

  /** Deliver a worker frame to the agent, if it is one and a channel node is held. */
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
      const outcome = sendToAgent(toPageFrame(message));
      if (message.type === 'agent.config') {
        // A configuration can end or change the capture, and the agent's
        // terminal flush of its tail runs inside that dispatch, so whatever
        // the budget refused of it is held now. The service closes the
        // capture's window shortly after, so the loss is reported at once
        // rather than when the armed report fires.
        reportHeldLossAtOnce();
      }
      switch (outcome) {
        case 'claimed':
          stats.forwardedDown += 1;
          stats.acknowledgedDown += 1;
          break;
        case 'delivered':
          stats.forwardedDown += 1;
          break;
        case 'no-channel':
          stats.droppedDownNoChannel += 1;
          break;
        case 'unrenderable':
          stats.droppedDownUnrenderable += 1;
          break;
        case 'failed':
          // Already counted as a fault where it happened.
          break;
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
    loseConnection(lost, { closePort: false, tellAgent: true });
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

  /** The current port died: tell the agent if allowed, then reconnect or terminate. */
  function loseConnection(lost: Connection, options: LossOptions): void {
    if (connection !== lost) {
      return;
    }
    releaseConnection(lost, options.closePort);
    if (!isContextAlive()) {
      terminate(options.tellAgent);
      return;
    }
    // The backoff decision precedes the signal: the agent may answer
    // `bridge.gone` with frames, and an unclaimed frame re-arms the reconnect
    // with whatever attempt count is current at that moment.
    if (now() - lost.openedAt >= BRIDGE_PORT_STABLE_MS) {
      attempt = 0;
    }
    if (options.tellAgent) {
      signalGone();
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
      terminate(true);
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
        terminate(true);
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

    // Re-announce the document on the new port before the agent drains, so
    // the worker knows the document ahead of its batches and can re-send the
    // live `agent.config`; the same capture continues (AAP §0.5.5). The
    // worker deduplicates by `documentId` and `producerId`, so the agent's own
    // re-announcement inside `bridge.ready` is harmless.
    const ready = lastReady;
    if (ready !== undefined) {
      if (!postUp(readyFrame(ready))) {
        // The port died at once; postUp marked it lost and a retry is scheduled.
        return;
      }
      stats.reannounced += 1;
    }
    signalReady();
    // The agent has drained inside `bridge.ready`, so every batch left to
    // carry a bucket has done so. What is still held — kept while no port was
    // usable — is reported at once: after an outage the capture's window may
    // be closing, and nothing more is going to carry it.
    reportHeldLossAtOnce();
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

  /**
   * Stop for good: the extension context is gone and can never come back.
   *
   * @param tellAgent Whether `bridge.gone` may be dispatched now — `false`
   * inside the agent's own frame dispatch.
   */
  function terminate(tellAgent: boolean): void {
    if (terminated) {
      return;
    }
    terminated = true;
    stats.terminated = true;
    cancelReconnect();
    cancelLossReport();
    const current = connection;
    if (current !== undefined) {
      releaseConnection(current, true);
    }
    if (tellAgent) {
      signalGone();
    }
    detachListeners();
    started = false;
  }

  /* ---------------------------- control surface -------------------------- */

  function start(): void {
    if (started || terminated) {
      return;
    }
    if (!isContextAlive()) {
      terminate(true);
      return;
    }
    started = true;
    attempt = 0;
    try {
      page.addEventListener('pageshow', onPageShow);
    } catch {
      stats.faults += 1;
    }
    try {
      page.addEventListener('pagehide', onPageHide);
    } catch {
      stats.faults += 1;
    }
    try {
      performHandshake();
    } catch {
      stats.faults += 1;
    }
    try {
      attachChannelListener();
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
    cancelLossReport();
    const current = connection;
    if (current !== undefined) {
      releaseConnection(current, true);
    }
    signalGone();
    detachListeners();
  }

  return {
    start,
    stop,
    isConnected: (): boolean => connection !== undefined,
    getStats: (): BridgeStats => ({ ...stats, refused: { ...stats.refused } }),
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
