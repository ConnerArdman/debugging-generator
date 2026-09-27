/**
 * Transport: the page agent's only way out, and the single place a telemetry
 * event is stamped.
 *
 * Every other module in this folder observes one thing — an interaction, a
 * React commit, a request, a performance entry, an error, a state
 * transition — builds an {@link EventDraft} for it and hands that draft to
 * {@link emit}. Nothing else in the agent touches the page channel, an event
 * id, the producer id, the `tier` field, the per-producer sequence number or
 * the clock offset. That concentration is the point: a producer cannot get the
 * stamping contract wrong if it never performs it, and a sibling module that
 * assigns `producerId`, `seq`, `tier`, `clockOffsetMs` or an id of its own is
 * a bug to be removed rather than a style choice.
 *
 * ## The page↔bridge channel (this module defines it)
 *
 * The agent runs in the page's **MAIN world** with no extension APIs. Its only
 * neighbour is the isolated-world bridge
 * (`apps/chrome-extension/src/content/bridge.ts`), which shares the page's DOM
 * but not its JavaScript realm and holds the `chrome.runtime` port to the
 * service worker. Both sides of the channel are defined here: the bridge and
 * `apps/chrome-extension/src/shared/messages.ts` mirror every literal below.
 * `docs/ARCHITECTURE.md` §4.7 has the sequence diagram, the reason each
 * platform primitive is captured and the no-shared-secret decision.
 *
 * - **Node.** The channel is one `div` per document, created with the
 *   `Document.prototype.createElement` captured at evaluation and never
 *   inserted into the document, stored on a global or published on
 *   `__DEBUGGEN__`. A node with no parent has no propagation path: an event
 *   dispatched on it reaches that node's own listeners and nothing else, so
 *   observing or injecting a frame requires holding the node.
 * - **Handshake.** The bridge dispatches one {@link HANDSHAKE_REQUEST_EVENT}
 *   (a `CustomEvent` with no `detail`) on `window`, with its
 *   {@link HANDSHAKE_OFFER_EVENT} listener already registered. The first
 *   request, and only that one, is answered synchronously inside its dispatch
 *   by a `MouseEvent` on `window` whose `relatedTarget` is the node — the
 *   standard event field that carries a node, and a node is the one value both
 *   worlds see as the same object. The request listener is removed before the
 *   answer is dispatched. No offer is ever unsolicited: the manifest declares
 *   this agent and then the bridge, both at `document_start`, so the listener
 *   exists when the bridge asks.
 * - **Frames.** {@link AGENT_FRAME_EVENT} (agent → bridge) and
 *   {@link BRIDGE_FRAME_EVENT} (bridge → agent) are `CustomEvent`s dispatched
 *   on the node with `bubbles: false` and `cancelable: true`, whose `detail`
 *   is the **string** JSON of `{ source, version, type, payload }`, because a
 *   primitive crosses the world boundary unchanged. This module renders it
 *   with {@link serializeFrameJson}: the text `JSON.stringify` would produce,
 *   without consulting any `toJSON` or running any getter (see "Frame
 *   serialization").
 * - **Size.** `detail.length`, in code units of the string dispatched, is at
 *   most {@link MAX_MESSAGE_BYTES} in both directions.
 * - **Acknowledgement.** A receiver that accepts a frame calls
 *   `preventDefault()` on it, so the sender's `dispatchEvent` returns `false`:
 *   "claimed". Dispatch is synchronous, so the answer exists before
 *   `dispatchEvent` returns (see **Custody**).
 *
 * Outbound types ({@link AgentOutboundType}):
 *
 * - `agent.ready` — `{ documentId, producerId, url, installedBeforeReact,
 *   reactDetected }`, sent when the agent initialises. The service worker adds
 *   `tabId` and relays it, so the service can tell a fresh document from a
 *   reconnecting one.
 * - `telemetry.batch` — `{ events, producerId, documentId, captureId?,
 *   sessionId?, batchSeq, droppedCount }`, where `events` is a raw
 *   `TelemetryEventIngress[]`. The service worker wraps the events into the
 *   protocol's `telemetry.event` envelope, which is why this bundle names no
 *   protocol type.
 * - `target.described` — a descriptor for an element the panel asked about.
 * - `agent.error` — something the agent could not do, stated without any
 *   captured data.
 *
 * Inbound types ({@link BridgeInboundType}):
 *
 * - `bridge.ready` — the bridge holds the node, listens on it and has a live
 *   runtime port. Sent when the bridge first has both and again after every
 *   service-worker reconnect; until it arrives this module buffers. It is also
 *   `./agent.ts`'s cue to re-send `agent.ready`: control frames are never
 *   queued, so a dormant agent holds nothing.
 * - `bridge.gone` — the runtime port disconnected; buffering resumes.
 * - `bridge.pause` — the service worker's lane for this tab has backed up:
 *   hold telemetry back until `bridge.resume` (see **Flow control**). `{}`.
 * - `bridge.resume` — the lane has drained: deliver again. `{}`.
 * - `agent.config` — the service's hook configuration for this tab, which
 *   `./agent.ts` reads and applies through {@link configureTransport}.
 * - `agent.snapshot` — a request for an on-demand component-tree snapshot.
 * - `target.request` — the panel entered element-picker mode.
 *
 * The two flow-control frames are this module's own: they are acknowledged
 * like every accepted frame and are not delivered to {@link subscribe}
 * handlers, because nothing outside the transport acts on them.
 *
 * **Inbound acceptance.** The node's listener accepts a frame only when its
 * `detail`, read through the captured `CustomEvent.prototype.detail` getter,
 * is a string no longer than {@link MAX_MESSAGE_BYTES} that the captured
 * `JSON.parse` turns into a plain object carrying exactly
 * {@link BRIDGE_SOURCE_TAG}, exactly {@link CHANNEL_VERSION} and a member of
 * the inbound vocabulary. An accepted frame is acknowledged with the captured
 * `preventDefault`; anything else is dropped silently and left
 * unacknowledged, because a log would itself be a channel. The parse revives
 * into null-prototype objects, so a field the bridge did not send reads as
 * absent even where the page has added that name to `Object.prototype`, and
 * no field of an accepted frame is ever called, evaluated or trusted as a
 * function.
 *
 * ### What the channel protects against, and what it does not
 *
 * Chrome injects both `document_start` content scripts declared in
 * `apps/chrome-extension/manifest.config.ts` before the page's first
 * statement, so every script the document loads runs after both. Such a
 * script:
 *
 * - **observes no frame.** None is dispatched where it can listen; the one
 *   event this module dispatches on `window`, the handshake answer, precedes
 *   it.
 * - **injects no frame.** It holds no reference to the node, and nothing
 *   dispatched on `window` — a `message`, a forged {@link BRIDGE_FRAME_EVENT},
 *   anything — reaches the node's listener.
 * - **cannot obtain the node.** The one request ever answered is the bridge's,
 *   and neither a transport reset nor a re-subscribe re-opens the handshake.
 * - **cannot subvert the machinery.** The event methods (on
 *   `EventTarget.prototype` and as `window` resolves them), the event
 *   constructors, the `detail` getter, `preventDefault`, `JSON.parse`,
 *   `createElement` and the reviver's object helpers are captured before it
 *   runs and called through the captured `Reflect.apply`. Event init
 *   dictionaries are null-prototype records, so a getter on `Object.prototype`
 *   for a dictionary member is never consulted and never sees a frame.
 * - **cannot reach a handler that applies a configuration, nor change what a
 *   delivered one asks for.** The control path — frame receipt, subscriber
 *   delivery, configuration parsing and the arm/disarm decisions in
 *   `./agent.ts` — runs only on language intrinsics captured at evaluation,
 *   null-prototype storage and operators (see "Core intrinsics and page-proof
 *   primitives"). No built-in the page can replace is handed the subscriber
 *   registry, a handler, the parsed frame or its payload, or decides whether
 *   the agent arms, which capture it stamps or which hooks it attaches.
 *   Nothing on `globalThis.__DEBUGGEN__` (`span`, `version`, `describeTarget`
 *   and a diagnostic copy of the configuration that nothing reads back) leads
 *   to a handler, and the IIFE bundle exposes no module export on any global.
 * - **cannot read or rewrite an outbound frame as the agent builds it.**
 *   Frames and events are composed by defining own properties
 *   ({@link defineOwnValue}, {@link appendValue}), so no setter or index
 *   accessor on `Object.prototype` or `Array.prototype` is handed a value, and
 *   rendered by {@link serializeFrameJson}: the bytes the bridge receives are
 *   the bytes this module composed.
 *
 * It does **not** protect against, and no in-page design can:
 *
 * - **code that ran before this agent** — another extension's MAIN-world
 *   `document_start` script, an automation tool's init script, a modified
 *   browser. Such code is as privileged in the page as this agent: it can
 *   replace the primitives before they are captured, or listen on `window`
 *   for the handshake answer and take the node.
 * - **a page with no bridge.** If the bridge never asks, a page script can ask
 *   first and hold the node. It then drives an agent with no bridge behind
 *   it: no session, no capture, no service and no network egress of the
 *   agent's own in any configuration.
 * - **the page's own behaviour.** A page script can call `__DEBUGGEN__.span`
 *   and cause real clicks, renders, requests and errors, each recorded
 *   faithfully. MAIN-world telemetry is **evidence about what the page did,
 *   never a tamper-proof measurement**, and the service treats every field of
 *   it as untrusted input (ingest validation, bounds and redaction). An object
 *   a page hands `__DEBUGGEN__.span` as attributes is read once, own getters
 *   included, as the page's own data.
 * - **the signal producers' in-page hooks.** `./interaction.ts`, `./react.ts`,
 *   `./fetch.ts`, `./perf.ts`, `./errors.ts`, `./state.ts` and the helpers
 *   they arm (`./continuation.ts`, `./dom-target.ts`) attach, reset and build
 *   their drafts through the page's own built-ins, so a page that rewrites
 *   those can keep a signal from attaching, or stop or distort what it
 *   records. That costs the signal, never the decision: a producer failure is
 *   contained and reported with its type name reduced to a closed
 *   vocabulary, and the capture stays armed or disarmed as the extension
 *   asked.
 * - **the page's clock and scheduler.** Timestamps come from the page's
 *   `performance.now()` and `performance.timeOrigin` (`Date.now()` as the
 *   fallback) through `Math.round`, so a page can skew them. The coalescing
 *   timer, the drain task and the drain microtask use the page's
 *   `setTimeout`, `clearTimeout`, `MessageChannel` and `queueMicrotask`, so a
 *   page can delay, hasten or suppress a scheduled delivery; the callback it
 *   is handed only drains the queue onto the node. The terminal drains —
 *   `pagehide`, capture stop and capture change — are synchronous and
 *   scheduled by nothing.
 *
 * **The channel carries no secret.** Authority is possession of the node,
 * which only the agent and the bridge hold. A secret carried on
 * `window`-dispatched frames would reach every page listener, and a replayed
 * all-false `agent.config` — which disarms a live capture — would be
 * indistinguishable from the bridge's.
 *
 * ### Custody
 *
 * A telemetry batch taken out of the queue for dispatch is **returned to the
 * front of the queue, in order, unless the bridge claims it**. The bridge
 * claims a batch once its runtime port has taken it, or once it refuses the
 * batch for good, so a port that died between `bridge.ready` and the batch
 * costs a retry, not the events: the batch is requeued, the bridge is marked
 * away, and the next `bridge.ready` delivers it with the `batchSeq` it would
 * have carried and no duplicate. {@link postFrame} defines the five outcomes
 * and {@link deliver} what each one does. Before the handshake is answered no
 * bridge can exist, so nothing is dispatched and nothing is counted as lost:
 * the `agent.ready` that `./agent.ts` announces at `document_start` is
 * re-announced on the bridge's `bridge.ready`.
 *
 * Every step is re-entrant: the bridge's listener runs synchronously inside
 * this module's dispatch, and this module's `bridge.ready` handling — a drain
 * and `./agent.ts`'s re-announcement — runs synchronously inside the bridge's.
 * One drain runs at a time (a nested request is left to the running drain,
 * which reschedules what remains), and a batch whose capture ended or whose
 * transport was reset while the bridge held it is never requeued into the
 * next capture: a capture change settles it into the cumulative totals, and a
 * reset, which has just zeroed them, into nothing.
 *
 * ### Flow control
 *
 * Custody ends where the bridge's runtime port takes a batch, so the port's
 * speed is not the service's: a page that produces faster than the local
 * service stores would otherwise fill the service worker's per-tab lane
 * until it overflows there. The worker therefore relays `bridge.pause` once
 * its lane for this tab backs up and `bridge.resume` once it has drained, and
 * between the two this module:
 *
 * - **posts no `telemetry.batch` of its own accord.** The batch threshold, the
 *   {@link FLUSH_INTERVAL_MS} timer and the bridge's return schedule nothing,
 *   and a bounded drain already running stops before its next batch.
 * - **keeps buffering, within the same bound.** Events accumulate in the ring
 *   of {@link MAX_BUFFERED_EVENTS}; past it the oldest is evicted and counted,
 *   exactly as while the bridge is away, so the loss rides out as
 *   `droppedCount` on the first batch after the resume.
 * - **still carries every control frame**, and still performs the terminal
 *   drains — {@link flush} (`pagehide`, a hidden document, capture stop, and
 *   the flush `./agent.ts` runs on `bridge.ready`) and the capture change in
 *   {@link configureTransport}. The signals are a hint about throughput, never
 *   custody: a moment with no later turn delivers what it holds, and the
 *   worker's own lane bound and loss reporting stay in force whatever the page
 *   does.
 *
 * `bridge.resume` drains at once with the bounded drain the bridge's return
 * uses ({@link MAX_BATCHES_PER_DRAIN} batches, the rest on later turns), and
 * announces nothing: `./agent.ts` never sees either signal, so a resume is not
 * a `bridge.ready` and re-sends no `agent.ready`.
 *
 * The pause belongs to the bridge's current runtime port — the worker records
 * it per bridge connection — so it is cleared by that port's end and by a new
 * one: `bridge.gone`, and every `bridge.ready`, which a reconnected bridge
 * sends first. It is deliberately **not** cleared by a capture change or by
 * {@link resetTransport}, which end a capture rather than a connection: the
 * worker still holds this bridge paused, and its `bridge.resume` is what lets
 * the next capture's telemetry go. {@link getFlowControlStats} reports it.
 *
 * ## Invariants
 *
 * **1. No side effects at import time.** Module evaluation only *reads* the
 * platform intrinsics the channel and the control path use
 * ({@link CHANNEL_INTRINSICS}, {@link CORE_INTRINSICS}, {@link NODE_TEST}) and
 * builds frozen lookup tables and pre-made errors from them: no listener, no
 * timer, no node and no `dispatchEvent`. The first {@link subscribe} creates
 * the node and installs its listener and the handshake request listener; the
 * last unsubscribe removes both listeners. The flush timer starts on the
 * first enqueue, the queue allocates with the first event and the drain
 * channel is created by the first scheduled drain. `./agent.ts` is the one
 * module in this folder allowed to act when it is evaluated.
 *
 * **2. Nothing throws into the page.** The agent runs inside the developer's
 * click handlers and React commits, where an escaping exception would break
 * the application it observes, so every exported function wraps its body; a
 * failure is counted in {@link TransportStats} and swallowed.
 *
 * **3. Nothing leaves that JSON cannot render faithfully.** A function,
 * symbol, bigint, DOM node, `Proxy` or cycle in an attribute bag would either
 * throw (costing the whole batch) or silently change shape, so attributes are
 * rebuilt through a bounded sanitizer before an event is buffered (see
 * {@link emit}). {@link serializeFrameJson} renders the result exactly as
 * `JSON.stringify` would, never calls a `toJSON` or a getter, and refuses a
 * cycle, a bigint or excessive nesting with a throw that {@link postFrame}
 * counts as an unserializable frame.
 *
 * **4. Only the producer fields are stamped.** `sessionId`, `captureId` and
 * `ingestSeq` are assigned by the service, and the strict ingress schema
 * rejects them from a producer; `redacted` is set by the service's redactor
 * at ingest. Events are built field by field, never by spreading a draft, so
 * none of the four reaches the wire even from a mistaken caller.
 *
 * **5. Nothing costs the page more than a bounded amount of work per turn.**
 * The agent observes latency, so it must not create any:
 *
 * - **The queue is a ring** ({@link enqueue}): an event costs one slot write
 *   at any depth up to {@link MAX_BUFFERED_EVENTS}, and evicting the oldest
 *   event at the cap advances a head index rather than copying.
 * - **Delivery never runs on a producer's stack.** Reaching
 *   {@link MAX_EVENTS_PER_BATCH} schedules one drain on its own
 *   `MessageChannel` task instead of serialising a frame inside the click
 *   handler or React commit that produced the last event.
 * - **Every scheduled drain dispatches at most {@link MAX_BATCHES_PER_DRAIN}
 *   batches** and reschedules the remainder. That holds for all four
 *   non-terminal routes — the batch threshold, the {@link FLUSH_INTERVAL_MS}
 *   timer, the bridge returning after an absence and a `bridge.resume` —
 *   because each can find a full queue.
 * - **Unbounded, synchronous draining is reserved for the terminal moments**
 *   with no later turn to rely on: {@link flush} (`pagehide` and capture stop)
 *   and the capture change in {@link configureTransport}, where the
 *   alternative is no delivery at all: the document is going away, or the
 *   queued events are about to stop being attributable to their capture.
 *
 * **6. Every frame is measured before it is dispatched.** {@link postFrame},
 * the only function that dispatches a frame, enforces
 * {@link MAX_MESSAGE_BYTES} on the very string it dispatches, so control
 * frames (an `agent.ready` carrying a page-controlled URL, a
 * `target.described` descriptor) are bounded exactly as batches are. A batch
 * over the cap is split; a control frame over it is refused and replaced by
 * one fixed-size diagnostic that cannot itself be oversize or trigger
 * another.
 *
 * ## The clock offset
 *
 * No clock alignment is applied to event times beyond a recorded per-producer
 * `clockOffsetMs` (server `Date` header versus local clock, informational; see
 * `docs/ARCHITECTURE.md` §5.2). This document is the producer, so this module
 * holds its one estimator ({@link clockOffset}) and is the only place the
 * value is written onto an event:
 *
 * - **Measured** by `./fetch.ts`, which hands {@link observeServerClock} the
 *   `Date` header of each same-origin response its hook observes — the dev
 *   server's clock — with the request's start and settle instants read from
 *   {@link nowEpochMs}, the clock every `startTime` in this folder comes from.
 * - **Stamped once**, in {@link completeDraft}, when the event is created and
 *   only once an estimate exists. A queued or re-delivered event is never
 *   restamped: the store compares a replay with the event it already holds,
 *   so a replay whose offset had moved would read as an id conflict.
 * - **Never applied.** `startTime` and `duration` are exactly what they would
 *   be with no sample at all; the offset is a statement *about* them.
 * - **Document-scoped**, like the producer id and the channel node: it
 *   describes this document's clock, not a capture, so neither a capture
 *   change nor {@link resetTransport} discards it. {@link getClockOffsetStats}
 *   reports it for diagnostics without widening {@link TransportStats}.
 *
 * ## Imports
 *
 * `packages/telemetry/esbuild.agent.mjs` bundles this folder into a static
 * content script and fails on any input resolving to a Node builtin,
 * `@debuggen/protocol`, `@debuggen/shared/node` or `zod`. This module
 * therefore value-imports only modules that import nothing (`./ids.js`,
 * `../redaction/rules.js` for {@link TRUNCATION_SUFFIX},
 * `../schema/clock-offset.js`, whose estimator the Node preload shares) or
 * nothing but `../schema/kinds.js` (`../schema/attributes.js`), and takes
 * {@link TelemetryEventIngress} from `../schema/event.js` by `import type`
 * alone, which is erased before esbuild sees it. `@debuggen/shared`'s barrel
 * is not imported even for a type, so a dropped `type` keyword cannot pull
 * its value imports into the bundle.
 *
 * @module packages/telemetry/src/browser/transport
 */

import { TRUNCATION_SUFFIX } from '../redaction/rules.js';
import { MAX_TRACKED_KEYS, type AttributeValueType } from '../schema/attributes.js';
import { ClockOffsetEstimator, type ClockOffsetSnapshot } from '../schema/clock-offset.js';
import type { TelemetryEventIngress } from '../schema/event.js';
import type { TelemetryTier } from '../schema/kinds.js';
import { getDocumentId, getProducerId, newEventId } from './ids.js';

/*
 * ---------------------------------------------------------------------------
 * Wire constants
 *
 * The bridge and the service worker are written against these values, so each
 * one is a published part of the channel rather than a tuning knob.
 * ---------------------------------------------------------------------------
 */

/**
 * The `source` tag inside every frame the page agent dispatches.
 *
 * The bridge filters on it, and so does this module's own inbound guard in the
 * opposite direction: the two directions travel on distinct event types
 * already, and the tag inside the JSON is what keeps a frame that reached the
 * wrong listener — a stale bridge from an earlier build, a mistaken dispatch —
 * from being read as the other side's.
 */
export const AGENT_SOURCE_TAG = 'debuggen-agent';

/**
 * The `source` tag the isolated-world bridge must put inside every frame it
 * dispatches to the agent.
 *
 * Deliberately different from {@link AGENT_SOURCE_TAG}: one shared tag would
 * make the two directions indistinguishable to a reader of the JSON alone.
 */
export const BRIDGE_SOURCE_TAG = 'debuggen-bridge';

/**
 * The DOM event the isolated-world bridge dispatches on `window` to ask this
 * module for the document's channel node.
 *
 * A `CustomEvent` with no `detail` — the request *is* the message. Exactly one
 * is ever answered, the first, with a {@link HANDSHAKE_OFFER_EVENT}
 * (see {@link subscribe} and the module overview). Published like the source
 * tags: the bridge dispatches this name literally, so it is part of the
 * channel rather than an implementation detail.
 */
export const HANDSHAKE_REQUEST_EVENT = 'debuggen-bridge-handshake';

/**
 * The DOM event this module dispatches on `window`, exactly once per document,
 * to hand the channel node to the bridge.
 *
 * A **`MouseEvent` whose `relatedTarget` is the node**, carrying no `detail`
 * and nothing else. `relatedTarget` is the standard event field that holds a
 * node, and a DOM node is the one value Chrome's isolated and main worlds see
 * as the same object — so the bridge receives the node itself, not a copy. The
 * bridge must have its listener registered before it asks, because the answer
 * is dispatched synchronously inside the request.
 *
 * Never dispatched unsolicited: the agent is declared (and so injected) before
 * the bridge, so the bridge's request always finds the listener, and an offer
 * nobody asked for would only be one more chance for a listener that should
 * not have it to catch the node.
 */
export const HANDSHAKE_OFFER_EVENT = 'debuggen-agent-handshake';

/**
 * The DOM event every agent → bridge frame is dispatched as, **on the channel
 * node** and never on `window`.
 *
 * A `CustomEvent` with `bubbles: false`, `cancelable: true` and a `detail` that
 * is the frame's JSON string. The bridge acknowledges a frame it has taken
 * custody of by calling `preventDefault()`, which this module reads as
 * `dispatchEvent` returning `false` (see {@link postFrame}).
 */
export const AGENT_FRAME_EVENT = 'debuggen-agent-frame';

/**
 * The DOM event every bridge → agent frame must be dispatched as, on the
 * channel node.
 *
 * The same shape as {@link AGENT_FRAME_EVENT} in the other direction: a
 * cancelable, non-bubbling `CustomEvent` whose `detail` is the frame's JSON
 * string. This module calls `preventDefault()` on every frame it accepts, so
 * the bridge can tell a frame the agent took from one nobody was listening
 * for.
 */
export const BRIDGE_FRAME_EVENT = 'debuggen-bridge-frame';

/**
 * The channel version, carried inside every frame in both directions and
 * checked exactly.
 *
 * The agent is a static content script copied out of this package's build and
 * the bridge is compiled into the extension, so the two can be shipped at
 * different moments (a reloaded extension against a page that was not
 * reloaded). An exact match is what makes that mismatch silent and harmless
 * instead of a stream of half-understood frames: a change to any payload shape
 * or to the transport itself is a version bump, and both sides then simply
 * ignore each other until the page reloads.
 *
 * Version 4 is the channel the module overview describes: the private
 * channel node handed over by the handshake, frames as JSON strings,
 * acknowledgement by `preventDefault()` (all three since version 3), and the
 * `bridge.pause` / `bridge.resume` flow control added in version 4. A version
 * 3 bridge would never hold the agent back, and a version 3 agent would read
 * the new frames as none of its own, so the two refuse each other outright.
 */
export const CHANNEL_VERSION = 4;

/**
 * The most completed events held in memory while the bridge is away.
 *
 * Fixed at 5 000 by AAP 0.5.5 ("the agent buffers up to 5 000 events in memory
 * until the bridge returns"). A capture is an interaction or two, not a
 * session-long recording, so this is generous for the intended use and still
 * a hard bound on what a runaway render loop — exactly the bug this product
 * exists to find — can cost the page it is observing.
 */
export const MAX_BUFFERED_EVENTS = 5000;

/**
 * The most events in one posted `telemetry.batch`.
 *
 * Also the drain trigger: reaching it schedules a drain on the next task
 * instead of waiting out the timer, so a burst travels while it is happening
 * rather than in one large frame at the end. 200 keeps a batch well inside
 * {@link MAX_MESSAGE_BYTES} for ordinary events and keeps each JSON rendering
 * short enough not to show up as a long task of its own.
 *
 * Reaching it deliberately does **not** post inline. The event that fills a
 * batch arrives on a stack the agent is measuring — a click handler, a React
 * commit, a `fetch` call — and serialising two hundred events there would add
 * the transport's own cost to the latency under investigation. The drain goes
 * to its own task instead (see {@link enqueue} and
 * {@link MAX_BATCHES_PER_DRAIN}).
 */
export const MAX_EVENTS_PER_BATCH = 200;

/**
 * Batches one *scheduled* drain posts before it yields the task back to the
 * page.
 *
 * A full queue is twenty-five batches' worth, and posting all of them in one
 * task would be the long task this module exists not to cause. Eight batches
 * is 1 600 events — more than any single interaction produces, so the ordinary
 * case still travels in one turn — and a queue deeper than that is emptied
 * across consecutive tasks, each one short, because a drain that stops with
 * events left reschedules itself.
 *
 * The bound applies only to drains that were scheduled. {@link flush}, a
 * capture change and the bridge's arrival drain everything synchronously: each
 * is a moment with no later turn to rely on (the document is going away, the
 * events are about to become unattributable, or the channel has just reopened
 * holding everything buffered while it was shut).
 */
export const MAX_BATCHES_PER_DRAIN = 8;

/**
 * The largest frame the channel carries, in either direction, as measured by
 * the `length` of the frame's `detail` — the JSON string that is dispatched.
 *
 * The measure is taken on the very string that travels: {@link postFrame}
 * renders a frame once, compares that string's length with this cap and
 * dispatches that same string, and the inbound guard applies the same cap to
 * the `detail` it reads before parsing anything. A code-unit count is an
 * estimate of a byte count, not a byte count — one non-ASCII character is one
 * unit and several bytes — and it is deliberately the cheap measure: it is
 * taken on the page's own thread for every batch, and the number it feeds is a
 * safety valve rather than a quota. A multi-megabyte frame is a long task in
 * the page and a memory spike in the extension, so a batch over this size is
 * split instead (see {@link deliver}).
 */
export const MAX_MESSAGE_BYTES = 512 * 1024;

/**
 * The most code units any single string in a **control** frame may carry.
 *
 * Control frames describe the agent rather than the application, and three of
 * their fields are page-controlled text: the document's URL in `agent.ready`,
 * and a selector and text preview in `target.described`. A URL has no length
 * limit a page has to respect — Chrome accepts megabytes of one — so without a
 * bound the smallest frame on the channel is the one whose size the page gets
 * to choose.
 *
 * 2 048 is several times the longest URL any server accepts in practice, so an
 * ordinary URL, selector or symbol crosses untouched and the field the service
 * reads is the field the page reported (AAP 0.5.2 needs the raw URL to resolve
 * a route and to redact its query values). Past it, the value is truncated
 * exactly as the repository's one code-point-safe `truncate` would truncate it
 * (see {@link boundControlText}), which marks what it removed with a single
 * ellipsis.
 *
 * This is a bound on a *field*, not the frame's guarantee: a sanitized payload
 * may still hold up to {@link MAX_TRACKED_KEYS} keys of bounded strings, so
 * {@link postFrame}'s measurement against {@link MAX_MESSAGE_BYTES} is what
 * actually refuses an oversize control frame.
 */
export const MAX_CONTROL_TEXT_LENGTH = 2048;

/**
 * How long a partly filled buffer waits before it is posted.
 *
 * One timer is armed on the first enqueue and re-armed only after it fires, so
 * a thousand events cost one timer and not a thousand. 250 ms is short enough
 * that the panel's live tail reads as live and long enough to coalesce the
 * render storm of a single interaction into a handful of frames.
 */
export const FLUSH_INTERVAL_MS = 250;

/**
 * The most `agent.error` frames one producer may post about its own internal
 * failures in one capture: **one**.
 *
 * A producer callback that throws usually throws for every occurrence of the
 * thing that provoked it — a fiber shape the diff cannot read, a page that has
 * replaced `removeEventListener` — and the only fact the service and the
 * developer act on is *that* the producer failed and the capture's evidence is
 * therefore incomplete. Nothing downstream behaves differently for two
 * failures than for twenty: the plan and the analysis mark the signal as
 * missing either way (AAP 0.5.5), and a count of repeats is not a second
 * statement but the same statement again. One frame carries the source, the
 * stage and the error category; every later failure of the same source in the
 * same capture is counted in {@link getProducerFailureStats}'s `suppressed`,
 * where a reader can see that the signal should be treated as absent rather
 * than merely thinned.
 *
 * One is also what the rest of the agent already does: `./agent.ts` posts its
 * `hooks-unavailable` frame once per capture per hook, and a failing hook is
 * the same kind of fact as a failing callback. Matching it keeps the reporting
 * channel a statement of coverage rather than a second event stream, and makes
 * it structurally impossible for a render storm that fails on every commit to
 * turn this channel into the flood the buffer bound exists to prevent.
 *
 * The bound is per source and per capture (see {@link reportProducerFailure}),
 * so a second capture reports afresh and one broken producer never silences
 * another.
 */
export const MAX_PRODUCER_FAILURE_REPORTS = 1;

/**
 * The maximum length of the `stage` field a failure report carries.
 *
 * `stage` is an agent-authored short identifier (`'listener-remove'`,
 * `'commit-traversal'`) chosen at the call site, so the bound is a structural
 * guarantee about the frame's size rather than a limit anything is expected to
 * reach — and a guarantee that holds even if a future caller passes a computed
 * string. The report's `error` field needs no such bound: it is selected from
 * {@link REPORTABLE_ERROR_NAMES} and cannot exceed the longest entry there.
 */
const MAX_FAILURE_FIELD_CHARS = 64;

/**
 * The complete vocabulary of error categories a failure report may name.
 *
 * This list exists because **an error's `name` is writable**. A page — or the
 * developer's own code — can do `const e = new Error(); e.name = '‹anything›'`
 * and throw it through a producer callback, and a probe that did exactly that
 * produced an `agent.error` frame whose `payload.error` carried that string
 * verbatim. `redaction/redactor.ts` runs at ingest over telemetry *events*
 * (AAP 0.5.2), so a control frame is the one thing on this channel that no
 * redactor ever inspects: a value it copies out of the page leaves the machine
 * unexamined. The same argument rules out `constructor.name`, which is just as
 * assignable and is read nowhere in this module.
 *
 * So {@link failureTypeName} does not sanitize a page string — it never emits
 * one. It performs a membership test against this set and returns the entry
 * that matched, which is a literal written here. (A string primitive is its
 * contents and nothing else, so an entry selected by `has` is exactly the
 * character sequence in this list; there is no identity left over from the
 * page.) Anything unrecognised collapses to `'Error'`, `'object'`, a `typeof`
 * result or `'unknown'`.
 *
 * The members are the names standardised by the platform, which is what makes
 * the list closed and finite: the ECMAScript error constructors, and the
 * `DOMException` names that a page API failure actually reports — a structured
 * clone that refused a value (`DataCloneError`, which a producer handing page
 * values to a platform API can meet), a cross-origin or policy refusal
 * (`SecurityError`, `NotAllowedError`), an observer or an object used out of
 * order (`InvalidStateError`, `NotSupportedError`), storage and IndexedDB
 * conditions, and the DOM tree errors a descriptor walk can provoke. Together
 * they are enough to tell a broken page API from a bad fiber shape, which is
 * the whole diagnostic purpose of the field; `errors.ts` carries real page
 * errors down the path that *is* redacted.
 *
 * Typed `ReadonlySet` so the compiler rejects a mutation, frozen so no
 * property can be added, and module-private so nothing outside this file — and
 * in particular nothing in the page — can reach it at all.
 */
const REPORTABLE_ERROR_NAMES: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    // ECMAScript error constructors.
    'Error',
    'TypeError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'EvalError',
    'URIError',
    'AggregateError',
    // Standard DOMException names (WebIDL's error-names table).
    'DataCloneError',
    'SecurityError',
    'InvalidStateError',
    'InvalidAccessError',
    'NotSupportedError',
    'NotFoundError',
    'NotAllowedError',
    'NetworkError',
    'AbortError',
    'TimeoutError',
    'QuotaExceededError',
    'OperationError',
    'EncodingError',
    'HierarchyRequestError',
    'NoModificationAllowedError',
    'WrongDocumentError',
    'InvalidCharacterError',
    'InvalidModificationError',
    'NamespaceError',
    'TypeMismatchError',
    'DataError',
    'ConstraintError',
    'ReadOnlyError',
    'TransactionInactiveError',
    'VersionError',
    'UnknownError',
    'InvalidNodeTypeError',
    'IndexSizeError',
    'InUseAttributeError',
    'URLMismatchError',
    'NotReadableError',
  ]),
);

/**
 * {@link REPORTABLE_ERROR_NAMES} as a null-prototype membership record, which
 * is what {@link reportableErrorName} consults.
 *
 * Derived here, while the module is evaluated and the set's iterator is still
 * the platform's. Asking the set later would call `Set.prototype.has`, which a
 * page can replace to admit any `name` it chose. `name in` this record is an
 * operator over own keys, so it cannot be answered that way, and a `name` of
 * `__proto__` or `constructor` is simply not a member.
 */
const REPORTABLE_ERROR_NAME_MEMBERSHIP: Readonly<Record<string, true>> = ((): Readonly<
  Record<string, true>
> => {
  const membership = createNullRecord<Record<string, true>>();
  for (const name of REPORTABLE_ERROR_NAMES) {
    membership[name] = true;
  }
  return Object.freeze(membership);
})();

/*
 * ---------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------
 */

/**
 * What a producer builds: a telemetry event minus the five fields this module
 * stamps.
 *
 * `id` stays available as an optional override for the one producer that needs
 * to know an event's id before it emits it — a fetch wrapper that has to
 * reference the request span it is about to report. Omitting it is the norm.
 *
 * `producerId`, `seq`, `tier` and `clockOffsetMs` are absent on purpose and
 * cannot be supplied: a document has exactly one producer id, one sequence,
 * one tier and one clock, and all four are this module's to assign (see
 * {@link emit} and {@link clockOffset}).
 *
 * The optional members are declared to accept an explicit `undefined` as well
 * as absence, because the repository compiles with
 * `exactOptionalPropertyTypes` and a producer that computes a field
 * conditionally would otherwise have to build its draft with a conditional
 * spread.
 */
export type EventDraft = Omit<
  TelemetryEventIngress,
  'id' | 'producerId' | 'seq' | 'tier' | 'clockOffsetMs'
> & {
  /** Pre-minted event id; omit it and {@link emit} mints one. */
  id?: string | undefined;
};

/**
 * What the service's `agent.config` boils down to for this module: which
 * session and capture the events belong to, and whether to accept any.
 */
export interface TransportConfig {
  /** The session the bound tab is serving, for the batch payload. */
  sessionId?: string | undefined;
  /**
   * The active capture window. Its absence means there is no capture, so
   * {@link emit} drops everything; a change of value restarts the sequence
   * counter.
   */
  captureId?: string | undefined;
  /** Whether events may be accepted at all. */
  enabled: boolean;
}

/**
 * A cheap, honest picture of the transport, for `./agent.ts`'s diagnostics and
 * for tests.
 *
 * Every number is cumulative for the life of the document except `buffered`
 * (the current queue depth) and `seq` (which restarts with each capture), so a
 * reader can tell "5 000 held because the bridge is away" from "1 000 events
 * lost and never coming back".
 */
export interface TransportStats {
  /** Completed events waiting in the queue right now. */
  buffered: number;
  /**
   * Events discarded and never delivered, cumulative: queue overflow, a
   * capture change the bridge was not present for, a frame the channel refused
   * to carry, and events too large to dispatch at all. A batch the bridge did
   * not claim is **not** counted here — it goes back to the front of the queue
   * (see {@link deliver}).
   */
  dropped: number;
  /** Events the bridge claimed, cumulative: only a claimed batch counts. */
  sent: number;
  /**
   * `telemetry.batch` frames the bridge claimed, cumulative — including the
   * event-less loss reports a terminal flush posts (see
   * {@link deliverLossReport}), which are `telemetry.batch` frames too.
   */
  batches: number;
  /**
   * The sequence number the next stamped event will carry — equivalently, how
   * many events have been stamped in the current capture.
   */
  seq: number;
  /** Whether the bridge has announced itself and not gone away since. */
  bridgeReady: boolean;
  /**
   * Events that could not be rendered or dispatched at all, cumulative: a value
   * JSON refused, or a single event larger than {@link MAX_MESSAGE_BYTES}.
   * Also counted in {@link dropped}; this field says *why*.
   */
  serializationFailures: number;

  /**
   * Control frames the channel did not deliver, cumulative: an `agent.ready`,
   * `target.described` or `agent.error` whose sanitized and bounded payload
   * still measured over {@link MAX_MESSAGE_BYTES}, that could not be rendered
   * or dispatched, or that the bridge did not claim. A control frame is never
   * retried, so an unclaimed one is lost and counted here — and only here: it
   * is not reported on the channel that just failed to carry it. Frames never
   * dispatched because no handshake had been answered yet are not counted,
   * since no bridge existed to lose them.
   *
   * Kept apart from {@link dropped} and {@link serializationFailures}, which
   * count *events*: a control frame carries no telemetry, so folding it into
   * either would overstate how much of the capture was lost. A non-zero value
   * here means the channel dropped a statement the agent made about itself —
   * most plausibly a page with an extraordinary URL — and `./agent.ts` reports
   * it alongside the event counters.
   */
  controlFramesDropped: number;
}

/**
 * The producers that can report an internal failure through
 * {@link reportProducerFailure}.
 *
 * One value per sibling module in this directory that observes the page, plus
 * `'transport'` for this module's own teardown. Closed on purpose: the service
 * groups reports by source, and a free-form string would let a typo become a
 * source nobody is looking at.
 */
export type ProducerFailureSource =
  'interaction' | 'react' | 'state' | 'perf' | 'errors' | 'fetch' | 'transport';

/** How much the reporter has said, and how much it declined to repeat. */
export interface ProducerFailureStats {
  /** Failure frames actually posted, cumulative for the document. */
  reported: number;
  /**
   * Failures that hit {@link MAX_PRODUCER_FAILURE_REPORTS} for their source and
   * were counted instead of posted, cumulative for the document.
   */
  suppressed: number;
}

/** The closed set of frame types the page agent dispatches. */
export type AgentOutboundType =
  'agent.ready' | 'telemetry.batch' | 'target.described' | 'agent.error';

/** The closed set of frame types the isolated-world bridge dispatches. */
export type BridgeInboundType =
  | 'bridge.ready'
  | 'bridge.gone'
  | 'bridge.pause'
  | 'bridge.resume'
  | 'agent.config'
  | 'agent.snapshot'
  | 'target.request';

/**
 * Where the channel's flow control stands, from {@link getFlowControlStats}.
 *
 * Its own record rather than members of {@link TransportStats}, whose numbers
 * describe the queue and the capture and are zeroed by {@link resetTransport}:
 * these describe the bridge's connection, which a capture ending does not
 * change (see "Flow control" in the module notes).
 */
export interface FlowControlStats {
  /** Whether a `bridge.pause` holds telemetry back right now. */
  paused: boolean;
  /** `bridge.pause` frames accepted, cumulative for the document. */
  pauses: number;
  /** `bridge.resume` frames accepted, cumulative for the document. */
  resumes: number;
}

/**
 * A frame as the page agent builds it; its JSON rendering, by
 * {@link serializeFrameJson}, is the `detail` of the {@link AGENT_FRAME_EVENT}
 * that carries it.
 */
export interface AgentOutboundMessage {
  /** Always {@link AGENT_SOURCE_TAG}. */
  source: typeof AGENT_SOURCE_TAG;
  /** Always {@link CHANNEL_VERSION}. */
  version: typeof CHANNEL_VERSION;
  /** Which frame this is. */
  type: AgentOutboundType;
  /** The frame's body, already sanitized so JSON renders it faithfully. */
  payload: Record<string, unknown>;
}

/**
 * A frame from the bridge, after this module's guard has parsed and accepted
 * the `detail` of a {@link BRIDGE_FRAME_EVENT}.
 *
 * `version` is typed as a plain `number` because the field arrives from
 * outside; the guard admits only {@link CHANNEL_VERSION}, so a handler reading
 * an accepted message is reading that value.
 *
 * `payload` is a tree of **null-prototype** objects (arrays stay arrays): the
 * guard revives the parsed JSON that way so a key the bridge did not send
 * reads as absent — `in` included — even on a page that has added that name
 * to `Object.prototype`. Handlers read it with `typeof`, `in` and index
 * access, never through an inherited method.
 */
export interface BridgeInboundMessage {
  /** Always {@link BRIDGE_SOURCE_TAG} on an accepted frame. */
  source: typeof BRIDGE_SOURCE_TAG;
  /** Always {@link CHANNEL_VERSION} on an accepted frame. */
  version: number;
  /** Which frame this is. */
  type: BridgeInboundType;
  /** The frame's body, normalised to an object (never `undefined`). */
  payload: Record<string, unknown>;
}

/*
 * ---------------------------------------------------------------------------
 * Module state
 *
 * Module scope is per JavaScript context, and the agent bundle is evaluated
 * once per page document — so this state is exactly one document's transport,
 * which is the same scope `./ids.js` memoizes its producer id in. A reload
 * gives a new document, a new producer id and a fresh queue, which is what the
 * ordering rules in `../schema/event.ts` assume.
 *
 * Declaring an empty array and a few zeroes is not a side effect: nothing
 * observable happens until a function is called.
 * ---------------------------------------------------------------------------
 */

/*
 * The queue: a ring buffer, and why not an array.
 *
 * The contract is FIFO with oldest-first eviction at {@link MAX_BUFFERED_EVENTS}
 * (AAP 0.5.5), and the obvious implementation of it — `push` at the end,
 * `splice(0, n)` at the front — makes eviction cost the length of the queue.
 * At the cap that is the *usual* case rather than the exceptional one: a render
 * loop with the bridge away evicts on every single event, and each eviction
 * moves the remaining 4 999 elements. The work is quadratic in the burst and it
 * lands on the page's own thread, which is the one thing this module must not
 * spend.
 *
 * A ring costs one slot write per event and one index increment per eviction,
 * whatever the depth, and it keeps every property the array had: order is the
 * order events were stamped in, the oldest leaves first, and the sequence
 * numbers are untouched (a gap is how a reader learns events were lost — see
 * {@link nextSeq}).
 *
 * `ring.length` is the capacity and grows on demand from
 * {@link INITIAL_BUFFER_CAPACITY} to the cap, so a dormant agent holds no
 * slots at all and a capture that never queues more than a batch never
 * allocates the other 4 744.
 */

/**
 * Slots the queue allocates the first time it holds an event.
 *
 * {@link MAX_EVENTS_PER_BATCH} plus the headroom that keeps the common case —
 * a burst that drains in one or two batches — from growing the ring at all.
 * Preallocating the full cap instead would cost a 5 000-element array in every
 * page the extension touches, which is exactly the "a dormant agent holds
 * nothing" rule this module is written to.
 */
const INITIAL_BUFFER_CAPACITY = 256;

/**
 * The ring's slots. `undefined` marks a free slot, which is also how a taken
 * event's reference is released so the page can collect it.
 */
let ring: (TelemetryEventIngress | undefined)[] = [];

/** Index of the oldest queued event; meaningless while {@link ringCount} is 0. */
let ringHead = 0;

/** How many slots from {@link ringHead} hold events. Never above the cap. */
let ringCount = 0;

/*
 * The subscriber registry: a linked list of null-prototype links, and why not
 * a `Set`.
 *
 * The registry holds the one function in this bundle that applies an
 * `agent.config` — `./agent.ts`'s frame handler — and it is walked on every
 * accepted frame, long after the page's own scripts have run. A `Set` is
 * driven through `Set.prototype.add`/`delete`/`clear` and walked through its
 * iterator or `Array.from`, every one of which a page can replace; a
 * replacement is handed the set (and with it the handler) or the handler
 * itself, and can then call it with a forged all-false configuration. The
 * links below are created by {@link createNullRecord}, which is a literal and
 * calls nothing, have no prototype to intercept a write, and are walked with a
 * plain `for` over `next` — so neither registering, unregistering nor
 * delivering a frame reaches any function the page can reach.
 */

/** One registered subscriber: its handler and the link after it. */
interface SubscriberLink {
  /** The handler {@link subscribe} was given. */
  handler: (message: BridgeInboundMessage) => void;
  /** The next link, in registration order, or `undefined` at the tail. */
  next: SubscriberLink | undefined;
}

/** The oldest registered subscriber, or `undefined` when there is none. */
let subscriberHead: SubscriberLink | undefined;

/** The newest registered subscriber, where the next registration is linked. */
let subscriberTail: SubscriberLink | undefined;

/** How many subscribers are registered; kept as a number, never measured. */
let subscriberCount = 0;

/** The session id to stamp on batch payloads, when the service named one. */
let currentSessionId: string | undefined;

/** The active capture, or `undefined` when there is none. */
let currentCaptureId: string | undefined;

/** Whether {@link emit} accepts events at all. */
let acceptingEvents = false;

/** The next `seq` to hand out; restarts at 0 on every capture change. */
let seqCounter = 0;

/** The next `batchSeq` to hand out; restarts at 0 on every capture change. */
let batchSeqCounter = 0;

/** Events dropped since the last claimed batch reported a count. */
let pendingDropped = 0;

/** Every event this document has dropped, for {@link TransportStats}. */
let droppedTotal = 0;

/** Every event the bridge has claimed, for {@link TransportStats}. */
let sentTotal = 0;

/** Every batch the bridge has claimed, for {@link TransportStats}. */
let batchesTotal = 0;

/** Events lost to a serialization or clone failure, for {@link TransportStats}. */
let serializationFailureTotal = 0;

/** Control frames the channel refused, for {@link TransportStats}. */
let controlFramesDroppedTotal = 0;

/**
 * How many failure frames each producer has posted in the current capture.
 *
 * Scoped to the capture, like `seq`: cleared on every capture change and on
 * {@link resetTransport}, so the bound in {@link MAX_PRODUCER_FAILURE_REPORTS}
 * is spent per capture rather than once per document.
 *
 * A null-prototype record, replaced rather than cleared: a capture change runs
 * inside {@link configureTransport}, on the path an `agent.config` takes, and a
 * `Map` cleared through the page-replaceable `Map.prototype.clear` would let a
 * page that made it throw keep every configuration from being applied.
 */
let producerFailureCounts: Partial<Record<ProducerFailureSource, number>> = createNullRecord();

/** Failure frames posted, cumulative, for {@link getProducerFailureStats}. */
let producerFailuresReported = 0;

/** Failures counted instead of posted, cumulative, for the same. */
let producerFailuresSuppressed = 0;

/** Whether the bridge has announced itself and not gone away since. */
let bridgeAvailable = false;

/**
 * Whether the bridge has asked the agent to hold its telemetry back: set by
 * `bridge.pause`, cleared by `bridge.resume`, `bridge.ready` and
 * `bridge.gone`. While it is set only the terminal drains post batches.
 *
 * Connection-scoped, like the worker's record of it, and so — unlike
 * {@link bridgeAvailable} — left as it is by {@link resetTransport}; see
 * "Flow control" in the module notes.
 */
let flowPaused = false;

/** `bridge.pause` frames accepted, cumulative, for {@link getFlowControlStats}. */
let flowPausesTotal = 0;

/** `bridge.resume` frames accepted, cumulative, for the same. */
let flowResumesTotal = 0;

/** The armed flush timer, or `undefined` when none is pending. */
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Whether a drain has been handed to a task source and has not run yet.
 *
 * At most one is ever outstanding: the flag is the whole of the "one bounded
 * drain" rule, and it is what keeps a thousand events in one commit from
 * queueing a thousand tasks.
 */
let drainScheduled = false;

/**
 * The channel whose `message` task carries a scheduled drain, created on first
 * use and closed by {@link resetTransport}.
 *
 * One channel for the document rather than one per drain: a `MessageChannel`
 * is cheap but not free, and this is the allocation a burst would repeat.
 */
let drainChannel: MessageChannel | undefined;

/**
 * Whether a control-frame loss is being reported right now.
 *
 * The diagnostic for a refused control frame is itself a control frame, so
 * without this flag a channel refusing everything would recurse. See
 * {@link noteControlFrameLoss}.
 */
let reportingControlLoss = false;

/**
 * Whether a drain — or a terminal loss report ({@link deliverLossReport}) — is
 * dispatching batches right now.
 *
 * The one-drain-at-a-time latch, and the reason this module is re-entrant.
 * The bridge's listener runs synchronously inside every dispatch, and anything
 * it dispatches back — a `bridge.gone`, a `bridge.ready` — is handled inside
 * that same stack, where `./agent.ts` answers `bridge.ready` with a flush. A
 * second drain started there would take the batches queued *behind* the one
 * still in the bridge's hands and dispatch them first, under the same
 * `batchSeq`. So a nested drain request returns at once, and the running drain
 * reschedules whatever is left when it finishes (see {@link drainBatches}).
 */
let delivering = false;

/**
 * Incremented on every capture change and every {@link resetTransport}.
 *
 * A batch reads it before it is dispatched and again afterwards. A different
 * value means the capture the batch belongs to ended — or the whole transport
 * was reset — while the bridge was handling the frame, and whatever the
 * outcome, the events are accounted to that ended capture: never requeued into
 * the next one, and never allowed to move its `batchSeq` or `droppedCount`.
 */
let captureEpoch = 0;

/**
 * Incremented on every {@link resetTransport}.
 *
 * Read around a dispatch alongside {@link captureEpoch}, to tell the two ways a
 * capture can end under a batch apart. After a capture change the cumulative
 * totals carry on, so the batch is settled into them; after a reset they have
 * just been zeroed — the transport is back to the state it had before anything
 * was configured — and a batch from before the reset is settled into nothing,
 * or a freshly reset transport would report traffic it never carried.
 */
let resetGeneration = 0;

/**
 * Incremented on every accepted `bridge.ready`.
 *
 * Read around a dispatch for the same reason as {@link captureEpoch}: a
 * `bridge.ready` handled while a batch was in the bridge's hands means the
 * bridge came back during that very dispatch, so the batch it did not claim
 * was refused by the bridge's *previous* port. That batch is requeued as usual
 * but the bridge is not marked away — marking it away would wait for a second
 * `bridge.ready` that is never coming — and the running drain reschedules the
 * retry for the next task.
 */
let bridgeReadyGeneration = 0;

/**
 * The channel node: a detached element created by the first {@link subscribe}
 * and handed to the bridge by the one handshake answer.
 *
 * **Document-scoped, and deliberately untouched by {@link resetTransport}.**
 * `./agent.ts`'s `disarm()` calls `resetTransport()` at the end of *every*
 * capture and immediately re-subscribes; a node replaced there would leave the
 * bridge holding one this module no longer listens on, with no second
 * handshake coming, and the document could never be armed again. The node is
 * a property of the document, like the producer id in `./ids.js`, not of a
 * capture. It is held only in this module-private binding: never inserted into
 * the document, never assigned to a global, never exposed on `__DEBUGGEN__`.
 */
let channelNode: EventTarget | undefined;

/**
 * Whether the one answerable {@link HANDSHAKE_REQUEST_EVENT} has been answered.
 *
 * The latch that bounds disclosure of the node. Set — and the request listener
 * removed — before the answer is dispatched, so a listener that synchronously
 * dispatches a second request from inside the answer finds the exchange
 * already closed. Never cleared: not by {@link resetTransport}, not by a
 * re-subscribe, not by anything, because "the first asker" is a fact about the
 * document. It is also the channel's "open" flag: until it is set no bridge
 * can hold the node, so nothing is dispatched on it (see {@link postControl}).
 */
let handshakeAnswered = false;

/**
 * The installed {@link HANDSHAKE_REQUEST_EVENT} listener on `window`, or
 * `undefined`.
 *
 * Installed by the first {@link subscribe} while the handshake is still
 * unanswered, removed by the last unsubscribe and by {@link resetTransport},
 * and removed the moment the request is answered, since a latched exchange has
 * nothing left to listen for — so an agent past its handshake keeps no
 * listener on the page's window at all.
 */
let handshakeRequestListener: EventListener | undefined;

/**
 * The installed {@link BRIDGE_FRAME_EVENT} listener on the channel node, or
 * `undefined`.
 *
 * Follows the subscriber lifecycle: installed by the first {@link subscribe},
 * removed by the last unsubscribe and by {@link resetTransport}, re-installed
 * by the next subscribe — on the same node, so the bridge's reference stays
 * good across every disarm and re-arm.
 */
let bridgeFrameListener: EventListener | undefined;

/*
 * ---------------------------------------------------------------------------
 * Channel intrinsics
 *
 * Every platform function the channel calls, read once while this module is
 * evaluated — which, in the bundle, is at `document_start`, before any script
 * the page loads — and called only through the captured `Reflect.apply`.
 *
 * A page script that later replaces `EventTarget.prototype.dispatchEvent`,
 * wraps `addEventListener`, shadows `CustomEvent`, redefines the `detail`
 * accessor or swaps `JSON.parse` is the attack this closes: each of those is
 * a way to watch frames go by, or to put words into one, without holding the
 * node. Reading them now and never again makes the channel's behaviour a fact
 * about the document as it was at `document_start`.
 *
 * The node's listener and dispatch methods are read off
 * `EventTarget.prototype`; the three the handshake calls on `window` are read
 * off `window` itself, the way `window` resolves them at that moment. In a
 * browser those are the very same functions — nothing has run before the
 * agent to make them differ — so the two reads carry one guarantee. Reading
 * them from the receiver they are applied to is what keeps the handshake
 * working in a host whose global object is not itself an `EventTarget` and
 * forwards these methods to one, as the DOM emulation this package's suites
 * run on does; the prototype's methods refuse such a receiver.
 *
 * Reading a global is not a side effect in the sense of invariant 1 — nothing
 * is listened to, dispatched, allocated on the page or changed — and every
 * read is `typeof`-guarded, so a host with no DOM (the Node program that also
 * type-checks this file, a worker) captures nothing and the channel simply
 * never opens.
 * ---------------------------------------------------------------------------
 */

/** `EventTarget.prototype.addEventListener` / `removeEventListener`. */
type ListenerMethod = (this: EventTarget, type: string, listener: EventListener) => void;

/** `EventTarget.prototype.dispatchEvent`. */
type DispatchMethod = (this: EventTarget, event: Event) => boolean;

/** The `CustomEvent.prototype.detail` getter. */
type EventAccessor = (this: Event) => unknown;

/** `Event.prototype.preventDefault`. */
type EventMethod = (this: Event) => void;

/** `Document.prototype.createElement`, for the one tag this module creates. */
type CreateElementMethod = (this: Document, tagName: string) => Element;

/** `JSON.stringify`, in the one-argument form this module uses. */
type StringifyFunction = (this: unknown, value: unknown) => string | undefined;

/** A `JSON.parse` reviver. */
type JsonReviver = (this: unknown, key: string, value: unknown) => unknown;

/** `JSON.parse`, always called with {@link reviveNullPrototype}'s reviver. */
type ParseFunction = (this: unknown, text: string, reviver: JsonReviver) => unknown;

/** `Object.create`, only ever called with `null`. */
type CreateObjectFunction = (this: unknown, prototype: null) => Record<string, unknown>;

/** `Object.keys`. */
type KeysFunction = (this: unknown, value: object) => string[];

/** `Array.isArray`. */
type IsArrayFunction = (this: unknown, value: unknown) => boolean;

/** The captured platform functions the channel runs on. */
interface ChannelIntrinsics {
  /** `Reflect.apply`: the only way anything below is ever called. */
  readonly apply: typeof Reflect.apply;
  /** `EventTarget.prototype.addEventListener`. */
  readonly addEventListener: ListenerMethod;
  /** `EventTarget.prototype.removeEventListener`. */
  readonly removeEventListener: ListenerMethod;
  /** `EventTarget.prototype.dispatchEvent`. */
  readonly dispatchEvent: DispatchMethod;
  /** `window.addEventListener`, as `window` resolved it: the request listener. */
  readonly windowAddEventListener: ListenerMethod;
  /** `window.removeEventListener`, as `window` resolved it. */
  readonly windowRemoveEventListener: ListenerMethod;
  /** `window.dispatchEvent`, as `window` resolved it: the handshake answer. */
  readonly windowDispatchEvent: DispatchMethod;
  /** The `CustomEvent` constructor, for frames. */
  readonly CustomEvent: typeof CustomEvent;
  /** The `MouseEvent` constructor, for the handshake answer. */
  readonly MouseEvent: typeof MouseEvent;
  /** The `CustomEvent.prototype.detail` getter. */
  readonly readDetail: EventAccessor;
  /** `Event.prototype.preventDefault`: the acknowledgement. */
  readonly preventDefault: EventMethod;
  /** `JSON.parse`: reads an inbound frame. */
  readonly parse: ParseFunction;
  /** `Document.prototype.createElement`: makes the channel node. */
  readonly createElement: CreateElementMethod;
  /** `Object.create`: the null-prototype records inbound frames revive into. */
  readonly createObject: CreateObjectFunction;
  /** `Object.keys`: copies a parsed record's own keys. */
  readonly ownKeys: KeysFunction;
  /** `Array.isArray`: tells a parsed array from a parsed record. */
  readonly isArray: IsArrayFunction;
}

/**
 * How far up a prototype chain {@link accessorOf} looks for an accessor.
 *
 * `detail` is an own accessor of `CustomEvent.prototype` in every engine this
 * product supports; the walk exists for a DOM implementation that defines it
 * one level up, and the bound keeps a hostile or cyclic-looking chain from
 * costing more than a few reads.
 */
const MAX_PROTOTYPE_WALK = 4;

/**
 * Read a function-valued property, or `undefined` when it is not a function.
 *
 * Read through `Reflect.get` rather than as `owner.key`, which would bind
 * nothing and is exactly what the type-aware lint's `unbound-method` rule
 * warns about: these are deliberately unbound, to be called later with an
 * explicit receiver through `Reflect.apply`.
 *
 * @param owner The object that holds the function.
 * @param key The property name.
 * @returns The function, typed as the caller's signature, or `undefined`.
 */
function functionOf<T>(owner: object, key: string): T | undefined {
  const value: unknown = Reflect.get(owner, key);
  return typeof value === 'function' ? (value as T) : undefined;
}

/**
 * Find the getter of an accessor property on a prototype or its ancestors.
 *
 * @param prototype The prototype to start from.
 * @param key The accessor's name.
 * @returns The getter, or `undefined` when there is no such accessor.
 */
function accessorOf(prototype: object, key: string): EventAccessor | undefined {
  let owner: object | null = prototype;
  for (let depth = 0; depth < MAX_PROTOTYPE_WALK && owner !== null; depth += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(owner, key);
    if (descriptor !== undefined) {
      const getter: unknown = descriptor.get;
      return typeof getter === 'function' ? (getter as EventAccessor) : undefined;
    }
    owner = Reflect.getPrototypeOf(owner);
  }
  return undefined;
}

/**
 * Capture the channel's intrinsics, or report that this host cannot have a
 * channel at all.
 *
 * All or nothing: a channel missing one of these could not be both private
 * and acknowledged, so a host lacking any of them gets `undefined` and the
 * agent stays deaf and silent rather than half-working.
 *
 * @returns The captured intrinsics, frozen, or `undefined`.
 */
function captureChannelIntrinsics(): ChannelIntrinsics | undefined {
  try {
    if (
      typeof Reflect === 'undefined' ||
      typeof JSON === 'undefined' ||
      typeof EventTarget === 'undefined' ||
      typeof Event === 'undefined' ||
      typeof CustomEvent !== 'function' ||
      typeof MouseEvent !== 'function' ||
      typeof Document === 'undefined' ||
      typeof window === 'undefined'
    ) {
      return undefined;
    }

    const apply = functionOf<typeof Reflect.apply>(Reflect, 'apply');
    const addEventListener = functionOf<ListenerMethod>(EventTarget.prototype, 'addEventListener');
    const removeEventListener = functionOf<ListenerMethod>(
      EventTarget.prototype,
      'removeEventListener',
    );
    const dispatchEvent = functionOf<DispatchMethod>(EventTarget.prototype, 'dispatchEvent');
    const windowAddEventListener = functionOf<ListenerMethod>(window, 'addEventListener');
    const windowRemoveEventListener = functionOf<ListenerMethod>(window, 'removeEventListener');
    const windowDispatchEvent = functionOf<DispatchMethod>(window, 'dispatchEvent');
    const readDetail = accessorOf(CustomEvent.prototype, 'detail');
    const preventDefault = functionOf<EventMethod>(Event.prototype, 'preventDefault');
    const parse = functionOf<ParseFunction>(JSON, 'parse');
    const createElement = functionOf<CreateElementMethod>(Document.prototype, 'createElement');
    const createObject = functionOf<CreateObjectFunction>(Object, 'create');
    const ownKeys = functionOf<KeysFunction>(Object, 'keys');
    const isArray = functionOf<IsArrayFunction>(Array, 'isArray');

    if (
      apply === undefined ||
      addEventListener === undefined ||
      removeEventListener === undefined ||
      dispatchEvent === undefined ||
      windowAddEventListener === undefined ||
      windowRemoveEventListener === undefined ||
      windowDispatchEvent === undefined ||
      readDetail === undefined ||
      preventDefault === undefined ||
      parse === undefined ||
      createElement === undefined ||
      createObject === undefined ||
      ownKeys === undefined ||
      isArray === undefined
    ) {
      return undefined;
    }

    return Object.freeze({
      apply,
      addEventListener,
      removeEventListener,
      dispatchEvent,
      windowAddEventListener,
      windowRemoveEventListener,
      windowDispatchEvent,
      CustomEvent,
      MouseEvent,
      readDetail,
      preventDefault,
      parse,
      createElement,
      createObject,
      ownKeys,
      isArray,
    });
  } catch {
    // A host whose globals throw on read has no channel; the agent stays
    // dormant and deaf rather than throwing out of its own evaluation.
    return undefined;
  }
}

/**
 * The channel's intrinsics, captured once, at module evaluation.
 *
 * Declared after every constant and helper {@link captureChannelIntrinsics}
 * reads, because a module-scope `const` read before its declaration has run
 * throws — and that throw would be swallowed into a silently absent channel.
 */
const CHANNEL_INTRINSICS: ChannelIntrinsics | undefined = captureChannelIntrinsics();

/*
 * ---------------------------------------------------------------------------
 * Core intrinsics and page-proof primitives
 *
 * The channel above is private, which settles who can put a frame on it. What
 * it does not settle is what the agent's *own code* hands to the page while it
 * handles one. This bundle shares the page's realm, so every built-in it calls
 * after `document_start` — `Array.from`, `Set.prototype.add`, an array's
 * iterator, `Array.prototype.some`, `Function.prototype.call`, `Array.isArray`,
 * `Object.keys`, `JSON.stringify` — is whatever the page has since put there,
 * and a replacement receives the arguments. Handed a subscriber registry it
 * obtains the handler that applies an `agent.config` and can call it with a
 * forged one; asked whether a hook was requested it can answer "no" to every
 * genuine configuration; asked to serialise a frame it can substitute the
 * text through an inherited `toJSON`. Writes are no safer: assigning a key a
 * fresh object does not already own walks its prototype chain, so a setter a
 * page defined on `Object.prototype` (or an index accessor on
 * `Array.prototype`) is handed the value and decides whether it lands.
 *
 * So the control path — frame receipt, subscriber delivery, configuration
 * parsing and the arm/disarm decisions in `./agent.ts` — and the composition
 * and rendering of every outbound frame run on three things only:
 *
 * 1. **Language intrinsics captured here, at evaluation** (`document_start`,
 *    before any page script), always called through the captured
 *    `Reflect.apply`. Captured separately from {@link CHANNEL_INTRINSICS}
 *    because none of them needs a DOM: `./agent.ts` parses a configuration with
 *    them whichever way the call arrived.
 * 2. **Null-prototype storage** made by {@link createNullRecord}, a literal
 *    that calls nothing: a read of a missing key is absent and a write
 *    creates an own property, whatever the page added to `Object.prototype`.
 *    Arrays this module builds are filled through {@link appendValue}, which
 *    defines the element instead of assigning it.
 * 3. **Operators and indexed loops** — `typeof`, `===`, `in` on a
 *    null-prototype record, `for (let i = 0; i < list.length; i += 1)` over an
 *    array whose elements are its own — which no page can redefine.
 *
 * What these three cannot settle is the *values* the page is the source of,
 * and the module header names each one: a clock reading and its rounding
 * through `Math.round` (a number, which can skew a timestamp), the type name
 * of a thrown value (read with `instanceof` and reduced to a closed
 * vocabulary), a producer's draft and a page-supplied attribute object (data,
 * read once as own properties), and the page's scheduler, which is handed a
 * drain callback and nothing else. Each decides what a field says or when a
 * batch leaves; none is handed a control function, the configuration or a
 * frame, and none decides whether the agent arms, which capture it stamps or
 * which bytes the bridge receives for the data it was given. Tables derived
 * while this bundle evaluates (before any page script) may use ordinary
 * built-ins: they are frozen, and read afterwards by index or `in` only.
 *
 * Exported for `./agent.ts`, which must not import anything the bundle
 * forbids and has no other module in this folder to take them from.
 * ---------------------------------------------------------------------------
 */

/** `Reflect.getOwnPropertyDescriptor`. */
type OwnDescriptorFunction = (
  this: unknown,
  target: object,
  key: PropertyKey,
) => PropertyDescriptor | undefined;

/** `Reflect.defineProperty`. */
type DefineOwnFunction = (
  this: unknown,
  target: object,
  key: PropertyKey,
  attributes: PropertyDescriptor,
) => boolean;

/** `Object.hasOwn`. */
type HasOwnFunction = (this: unknown, target: object, key: PropertyKey) => boolean;

/** `Reflect.getPrototypeOf`. */
type PrototypeOfFunction = (this: unknown, target: object) => object | null;

/** The captured language intrinsics the page-proof primitives run on. */
interface CoreIntrinsics {
  /** `Reflect.apply`: the only way anything below is ever called. */
  readonly apply: typeof Reflect.apply;
  /** `Object.keys`: own enumerable string keys, in property order. */
  readonly ownKeys: KeysFunction;
  /** `Array.isArray`. */
  readonly isArray: IsArrayFunction;
  /** `Reflect.getOwnPropertyDescriptor`: reads a value without running a getter. */
  readonly ownDescriptor: OwnDescriptorFunction;
  /** `Reflect.defineProperty`: writes a value without running a setter. */
  readonly defineOwn: DefineOwnFunction;
  /** `Object.hasOwn`: tells a data descriptor from an accessor one. */
  readonly hasOwn: HasOwnFunction;
  /** `Reflect.getPrototypeOf`. */
  readonly prototypeOf: PrototypeOfFunction;
  /**
   * `JSON.stringify`, only ever applied to a string or a number: for a
   * primitive the algorithm consults no `toJSON` and calls nothing, so the
   * captured function quotes and formats exactly as the specification says.
   */
  readonly stringify: StringifyFunction;
  /** `Object.prototype` as it was at evaluation, for the plain-object test. */
  readonly objectPrototype: object;
}

/**
 * Capture the core intrinsics, or report that this host lacks one of them.
 *
 * All or nothing, like {@link captureChannelIntrinsics}. Every one of them is
 * standard in any engine that can parse this bundle's syntax (the build
 * targets Chrome 111), so `undefined` describes a host whose globals were
 * removed before the agent ran — code this module does not claim to defend
 * against. There the primitives below throw, every caller contains the throw,
 * and the agent neither arms, disarms nor dispatches anything.
 *
 * @returns The captured intrinsics, frozen, or `undefined`.
 */
function captureCoreIntrinsics(): CoreIntrinsics | undefined {
  try {
    if (typeof Reflect === 'undefined' || typeof JSON === 'undefined') {
      return undefined;
    }

    const apply = functionOf<typeof Reflect.apply>(Reflect, 'apply');
    const ownKeys = functionOf<KeysFunction>(Object, 'keys');
    const isArray = functionOf<IsArrayFunction>(Array, 'isArray');
    const ownDescriptor = functionOf<OwnDescriptorFunction>(Reflect, 'getOwnPropertyDescriptor');
    const defineOwn = functionOf<DefineOwnFunction>(Reflect, 'defineProperty');
    const hasOwn = functionOf<HasOwnFunction>(Object, 'hasOwn');
    const prototypeOf = functionOf<PrototypeOfFunction>(Reflect, 'getPrototypeOf');
    const stringify = functionOf<StringifyFunction>(JSON, 'stringify');
    const objectPrototype: unknown = Reflect.get(Object, 'prototype');

    if (
      apply === undefined ||
      ownKeys === undefined ||
      isArray === undefined ||
      ownDescriptor === undefined ||
      defineOwn === undefined ||
      hasOwn === undefined ||
      prototypeOf === undefined ||
      stringify === undefined ||
      typeof objectPrototype !== 'object' ||
      objectPrototype === null
    ) {
      return undefined;
    }

    return Object.freeze({
      apply,
      ownKeys,
      isArray,
      ownDescriptor,
      defineOwn,
      hasOwn,
      prototypeOf,
      stringify,
      objectPrototype,
    });
  } catch {
    return undefined;
  }
}

/**
 * The core intrinsics, captured once, at module evaluation — after
 * {@link functionOf}'s declaration has run, for the reason given at
 * {@link CHANNEL_INTRINSICS}.
 */
const CORE_INTRINSICS: CoreIntrinsics | undefined = captureCoreIntrinsics();

/*
 * The failures the primitives below can report, built while the module is
 * evaluated. Throwing one constructs nothing, so a page that has replaced the
 * `TypeError` or `RangeError` globals runs no code of its own when the agent
 * refuses a value. Callers never inspect them beyond "it threw": every call
 * site maps a throw to its own documented outcome.
 */

/** A core intrinsic is missing (see {@link captureCoreIntrinsics}). */
const CORE_UNAVAILABLE = new TypeError('the page agent could not capture its core intrinsics');

/** {@link appendValue} or {@link defineOwnValue} met a target that refused the value. */
const DEFINE_REFUSED = new TypeError('the page agent could not define a value it built');

/** {@link serializeFrameJson} met a value that contains itself. */
const JSON_CYCLE = new TypeError('the value contains itself and has no JSON rendering');

/** {@link serializeFrameJson} met containers nested deeper than {@link MAX_SERIALIZED_DEPTH}. */
const JSON_TOO_DEEP = new RangeError('the value nests deeper than a frame may');

/** {@link serializeFrameJson} met a bigint, which JSON cannot spell. */
const JSON_BIGINT = new TypeError('a bigint has no JSON rendering');

/** {@link serializeFrameJson} was given a value with no rendering at all. */
const JSON_NO_RENDERING = new TypeError('the value has no JSON rendering');

/**
 * What {@link readOwnData} answers for a key with no own data property: absent,
 * or an accessor whose getter this module will not run.
 *
 * A symbol, so no value a holder can store is mistaken for it.
 */
const NOT_OWN_DATA = Symbol('debuggen.not-own-data');

/**
 * The core intrinsics, or the {@link CORE_UNAVAILABLE} throw.
 *
 * @returns The captured intrinsics.
 */
function coreIntrinsics(): CoreIntrinsics {
  const core = CORE_INTRINSICS;
  if (core === undefined) {
    throw CORE_UNAVAILABLE;
  }
  return core;
}

/**
 * A fresh, empty object with no prototype, typed as the caller's record.
 *
 * `{ __proto__: null }` is object-literal syntax, not an assignment: the
 * literal is created with a null prototype and calls nothing, so there is no
 * `Object.create` a page could have replaced and no `__proto__` setter to
 * intercept. On the result a missing key reads as absent, `in` sees only own
 * keys, and an assignment creates an own property — which is what makes it
 * the storage for everything the control path keeps and every record an
 * outbound frame is built from.
 *
 * The cast is the one place a record is typed before its members exist; each
 * caller assigns them immediately.
 *
 * @example
 * const hooks = createNullRecord<Record<HookFlag, boolean>>();
 * hooks.fetch = true; // an own property, whatever `Object.prototype` defines
 *
 * @returns An empty null-prototype object.
 */
export function createNullRecord<T extends object = Record<string, unknown>>(): T {
  const record: object = { __proto__: null };
  return record as T;
}

/**
 * `Array.isArray` as it was at evaluation.
 *
 * @param value Anything.
 * @returns Whether the value is an array (a `Proxy` of one included).
 * @throws {TypeError} Only in a host with no core intrinsics.
 */
export function isArrayValue(value: unknown): value is readonly unknown[] {
  const core = coreIntrinsics();
  return core.apply(core.isArray, undefined, [value]);
}

/**
 * A null-prototype data descriptor for `value`: writable, enumerable and
 * configurable, exactly like the property an assignment would create.
 *
 * Null-prototype because `Reflect.defineProperty` reads a descriptor's six
 * fields through the prototype chain: an ordinary object here would let a page
 * that defined `Object.prototype.get` turn the definition into an accessor.
 */
function dataDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = createNullRecord<PropertyDescriptor>();
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  return descriptor;
}

/**
 * Give `target` an own data property `key`, without an assignment.
 *
 * For the fields of an ordinary object this module (or `./agent.ts`) builds
 * with a literal and then extends conditionally — an optional `parentSpanId`,
 * a `captureId` present only inside a capture. The result is what the
 * assignment would have produced when nothing intercepts it, and what it
 * produces here whatever the page defined along the prototype chain.
 *
 * @param target The object to extend.
 * @param key The property to define.
 * @param value Its value.
 * @throws {TypeError} When the target refuses the definition (a frozen
 * object), or in a host with no core intrinsics.
 */
export function defineOwnValue<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K],
): void {
  const core = coreIntrinsics();
  if (!core.apply(core.defineOwn, undefined, [target, key, dataDescriptor(value)])) {
    throw DEFINE_REFUSED;
  }
}

/**
 * Append `value` to `list`, as `push` would, without calling `push`.
 *
 * `Array.prototype.push` is the page's once its scripts have run, and even the
 * original assigns the new element — so an index accessor a page put on
 * `Array.prototype` would receive it. Defining the element at `list.length`
 * creates it as an own property and advances `length`, which is the whole of
 * what `push` does for an ordinary array.
 *
 * @example
 * const released: HookName[] = [];
 * appendValue(released, 'fetch');
 *
 * @param list An array this module or `./agent.ts` created.
 * @param value The element to append.
 * @throws {TypeError} When the array refuses the element (a frozen array), or
 * in a host with no core intrinsics.
 */
export function appendValue<T>(list: T[], value: T): void {
  const core = coreIntrinsics();
  if (!core.apply(core.defineOwn, undefined, [list, list.length, dataDescriptor(value)])) {
    throw DEFINE_REFUSED;
  }
}

/**
 * Read an own data property without running anything.
 *
 * The captured `Reflect.getOwnPropertyDescriptor` reports the property without
 * invoking a getter, and the captured `Object.hasOwn` on the returned
 * descriptor is what tells a data property from an accessor: the descriptor
 * is an ordinary object, so reading `descriptor.value` of an *accessor* would
 * fall through to whatever a page defined as `Object.prototype.value`.
 *
 * @param core The captured intrinsics.
 * @param holder The object to read.
 * @param key The property.
 * @returns The value, or {@link NOT_OWN_DATA} for an absent key or an accessor.
 */
function readOwnData(core: CoreIntrinsics, holder: object, key: PropertyKey): unknown {
  const descriptor = core.apply(core.ownDescriptor, undefined, [holder, key]);
  if (descriptor === undefined || !core.apply(core.hasOwn, undefined, [descriptor, 'value'])) {
    return NOT_OWN_DATA;
  }
  const value: unknown = descriptor.value;
  return value;
}

/*
 * ---------------------------------------------------------------------------
 * Frame serialization
 *
 * Every frame's `detail` is JSON text, and the native `JSON.stringify` — even
 * the one captured at evaluation — looks up `toJSON` on every object it
 * visits, inherited ones included, and reads every property through its
 * getter. A late `Object.prototype.toJSON` would therefore be called with the
 * frame itself, could read every identifier on it, and would decide what text
 * the agent dispatches on its own private node. {@link serializeFrameJson}
 * renders JSON-shaped data to exactly the text `JSON.stringify` produces for
 * it, without consulting `toJSON` (own or inherited) and without running any
 * getter.
 * ---------------------------------------------------------------------------
 */

/**
 * The deepest container nesting {@link serializeFrameJson} renders.
 *
 * Every frame this module builds nests at most eight containers (frame,
 * payload, events, event, attributes and the three levels the sanitizer
 * keeps); the bound exists for the one field that is carried as given — an
 * event's `source` — and makes a pathologically deep value a refused frame
 * rather than a stack overflow in the page.
 */
const MAX_SERIALIZED_DEPTH = 64;

/** One container on the path from the root to the value being rendered. */
interface AncestorLink {
  /** The container. */
  value: object;
  /** The container that holds it, or `undefined` at the root. */
  parent: AncestorLink | undefined;
}

/**
 * Render a value to the JSON text `JSON.stringify(value)` produces for it,
 * without ever calling `toJSON` or a getter.
 *
 * The rules, and where each one matches the native algorithm:
 *
 * - **Strings and numbers** go through the captured `JSON.stringify` applied to
 *   the primitive itself — the one input for which it consults nothing — so
 *   quoting (quotes, backslashes, control characters, lone surrogates) and
 *   number formatting (`-0` as `0`, `1e21` as `1e+21`, `NaN` and both
 *   infinities as `null`) are the platform's own.
 * - **Booleans and `null`** render as their literals.
 * - **`undefined`, functions and symbols** have no rendering: a property
 *   holding one is omitted, an array element holding one renders `null`, and
 *   at the top level the call throws (native `JSON.stringify` returns
 *   `undefined`, which the caller would have to treat as a failure anyway).
 * - **Arrays** (by the captured `Array.isArray`) render `length` elements in
 *   order, each read as an own data property; a hole — which natively reads
 *   `undefined` — renders `null`.
 * - **Other objects** render their own enumerable string keys in property
 *   order (the captured `Object.keys`, the order `JSON.stringify` uses),
 *   each value read as an own data property.
 * - **Never consulted:** `toJSON` in any form, getters (an accessor property
 *   is omitted from an object and renders `null` in an array), `valueOf` and
 *   `toString` (a boxed primitive or a `Date` is rendered as the object it is,
 *   by its own enumerable data properties). None of these reach a frame this
 *   module builds; the rule is what keeps a page from making them.
 * - **Refused**, with a throw: a bigint, a value that contains itself, and
 *   nesting deeper than {@link MAX_SERIALIZED_DEPTH}. The native function
 *   throws for the first two as well.
 *
 * Exported for `./agent.ts`, whose component-tree snapshot travels as JSON
 * text inside an attribute and must be rendered by the same rules.
 *
 * @example
 * serializeFrameJson({ a: 'x"y', b: [undefined, -0], c: undefined });
 * // '{"a":"x\\"y","b":[null,0]}' — the same text JSON.stringify produces
 *
 * @param value The value to render.
 * @returns The JSON text.
 * @throws {TypeError | RangeError} For a value with no faithful rendering, as
 * listed above, or in a host with no core intrinsics.
 */
export function serializeFrameJson(value: unknown): string {
  const core = coreIntrinsics();
  const rendered = renderJsonValue(core, value, undefined, 0);
  if (rendered === undefined) {
    throw JSON_NO_RENDERING;
  }
  return rendered;
}

/**
 * Quote a string or format a number through the captured `JSON.stringify`.
 *
 * @param core The captured intrinsics.
 * @param value The primitive.
 * @returns Its JSON text.
 */
function renderJsonPrimitive(core: CoreIntrinsics, value: string | number): string {
  const rendered = core.apply(core.stringify, undefined, [value]);
  if (typeof rendered !== 'string') {
    throw JSON_NO_RENDERING;
  }
  return rendered;
}

/**
 * Render one value; see {@link serializeFrameJson} for the rules.
 *
 * @param core The captured intrinsics.
 * @param value The value.
 * @param ancestors The containers above it, innermost first.
 * @param depth How many containers enclose it.
 * @returns The JSON text, or `undefined` for a value with no rendering.
 */
function renderJsonValue(
  core: CoreIntrinsics,
  value: unknown,
  ancestors: AncestorLink | undefined,
  depth: number,
): string | undefined {
  switch (typeof value) {
    case 'string':
    case 'number':
      return renderJsonPrimitive(core, value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw JSON_BIGINT;
    case 'object':
      break;
    default:
      // `undefined`, a function or a symbol.
      return undefined;
  }

  if (value === null) {
    return 'null';
  }

  const container: object = value;
  for (let link = ancestors; link !== undefined; link = link.parent) {
    if (link.value === container) {
      throw JSON_CYCLE;
    }
  }
  if (depth >= MAX_SERIALIZED_DEPTH) {
    throw JSON_TOO_DEEP;
  }

  // The path is a linked list of null-prototype links, not an array: nothing
  // about rendering a frame may call a method a page can replace.
  const path = createNullRecord<AncestorLink>();
  path.value = container;
  path.parent = ancestors;

  return core.apply(core.isArray, undefined, [container])
    ? renderJsonArray(core, container, path, depth + 1)
    : renderJsonRecord(core, container, path, depth + 1);
}

/**
 * Render an array's elements, in order.
 *
 * @param core The captured intrinsics.
 * @param array The array.
 * @param path The containers down to and including this one.
 * @param depth The nesting of its elements.
 * @returns The JSON text.
 */
function renderJsonArray(
  core: CoreIntrinsics,
  array: object,
  path: AncestorLink,
  depth: number,
): string {
  const length = readOwnData(core, array, 'length');
  const count = typeof length === 'number' ? length : 0;

  let rendered = '[';
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      rendered += ',';
    }
    const element = readOwnData(core, array, index);
    const text = element === NOT_OWN_DATA ? undefined : renderJsonValue(core, element, path, depth);
    rendered += text ?? 'null';
  }
  return `${rendered}]`;
}

/**
 * Render a record's own enumerable string-keyed data properties, in order.
 *
 * @param core The captured intrinsics.
 * @param record The record.
 * @param path The containers down to and including this one.
 * @param depth The nesting of its values.
 * @returns The JSON text.
 */
function renderJsonRecord(
  core: CoreIntrinsics,
  record: object,
  path: AncestorLink,
  depth: number,
): string {
  const keys = core.apply(core.ownKeys, undefined, [record]);

  let rendered = '{';
  let members = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      continue;
    }
    const member = readOwnData(core, record, key);
    if (member === NOT_OWN_DATA) {
      continue;
    }
    const text = renderJsonValue(core, member, path, depth);
    if (text === undefined) {
      continue;
    }
    rendered += `${members === 0 ? '' : ','}${renderJsonPrimitive(core, key)}:${text}`;
    members += 1;
  }
  return `${rendered}}`;
}

/**
 * This document's clock-offset estimate: the dev server's clock minus this
 * document's event clock, from the `Date` headers `./fetch.ts` feeds through
 * {@link observeServerClock} (the estimator is defined in
 * `../schema/clock-offset.ts`).
 *
 * **Document-scoped, and deliberately untouched by {@link configureTransport}
 * and {@link resetTransport}**, for the reason the producer id and
 * {@link channelNode} are: it describes this document's clock, and that
 * clock does not change when a capture does. `./agent.ts`'s `disarm()` resets
 * the transport at the end of every capture, so an estimate cleared there would
 * leave every capture after the first starting blind, with no sample until the
 * page next made a same-origin request — and the samples already taken remain
 * exactly as valid a statement about the clock as they were.
 *
 * `const`, and constructed at evaluation: the instance holds four numbers and
 * three counters, reads no clock and touches nothing on the page, so creating
 * it is no more a side effect than the zeroes above.
 */
const clockOffset = new ClockOffsetEstimator();

/*
 * ---------------------------------------------------------------------------
 * Local time base
 *
 * `@debuggen/shared` already owns this conversion in `performanceToEpochMs`
 * and `nowEpochMsPrecise`, and this module still restates it. Two reasons,
 * both structural rather than stylistic:
 *
 * 1. **The import is banned here.** `@debuggen/shared`'s entry value-imports
 *    `zod` (its `SourceLocation` schema), and `packages/telemetry/esbuild.agent.mjs`
 *    hard-fails the agent build on any input resolving to `zod`. There is no
 *    deep entry for the time helpers to reach past the barrel.
 * 2. **There is nowhere else in the bundle to put it.** AAP 0.7.1 fixes this
 *    folder's module list, and a `time.ts` is not on it — so the definition
 *    belongs in the module every sibling already imports.
 *
 * The two exports below are therefore the single definition *inside the
 * bundle*: `./interaction.ts`, `./react.ts`, `./fetch.ts`, `./perf.ts` and
 * `./state.ts` convert through them and never re-derive the arithmetic, and
 * the clock-offset samples `./fetch.ts` takes are read from the same
 * {@link nowEpochMs}, so the offset describes the clock event times are
 * stamped with rather than a second one. The
 * semantics are the shared package's, deliberately: prefer
 * `performance.timeOrigin`, fall back to `Date.now() - performance.now()` when
 * a host exposes the clock but not the origin, and fall back to `Date.now()`
 * when there is no usable clock at all.
 * ---------------------------------------------------------------------------
 */

/** Decimal places kept on an epoch-millisecond value: microsecond resolution. */
const TIME_DECIMALS = 3;

/** The rounding multiplier, derived so the two constants cannot disagree. */
const TIME_ROUNDING_FACTOR = 10 ** TIME_DECIMALS;

/**
 * `Number.isFinite`, spelled with operators.
 *
 * `value - value` is `0` for every finite number and `NaN` for `NaN` and both
 * infinities, so the answer is exactly the built-in's. The built-in is the
 * page's to replace, and here it decides whether an event is stamped and
 * whether a number reaches the wire: one that answered `false` would make the
 * transport drop every event it is given.
 *
 * @param value Anything.
 * @returns Whether the value is a finite number.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && value - value === 0;
}

/**
 * A reading of the host's high-resolution clock, or `undefined` when there
 * is none to read.
 */
interface ClockReading {
  /** `performance.now()`, milliseconds since the document's origin. */
  relativeMs: number;
  /** `performance.timeOrigin`, when the host reports a finite one. */
  timeOrigin: number | undefined;
}

/**
 * Read `performance` defensively.
 *
 * Guarded with `typeof` because this module is also compiled and type-checked
 * for hosts without a DOM, and read through `unknown` because a page can
 * replace `performance` or its members with anything at all — this code runs
 * in the page's own realm, after the page's own scripts.
 */
function probeClock(): ClockReading | undefined {
  if (typeof performance === 'undefined') {
    return undefined;
  }

  const clock: { now?: unknown; timeOrigin?: unknown } = performance;
  const core = CORE_INTRINSICS;
  if (typeof clock.now !== 'function' || core === undefined) {
    return undefined;
  }

  // Called through the captured `Reflect.apply`, not `.call`: the page's
  // `Function.prototype.call` would run on every timestamp the agent takes.
  // The clock itself is the page's, which is the residual stated in the
  // module header: a page can skew the times it is measured with.
  const relativeMs: unknown = core.apply(clock.now as () => unknown, performance, []);
  if (!isFiniteNumber(relativeMs)) {
    return undefined;
  }

  const origin = clock.timeOrigin;
  return {
    relativeMs,
    timeOrigin: isFiniteNumber(origin) ? origin : undefined,
  };
}

/**
 * Round an epoch-millisecond value to {@link TIME_DECIMALS} places, keeping
 * the fraction.
 *
 * Sub-millisecond precision is load-bearing — two events in one interaction
 * routinely start inside the same millisecond, and `../correlation/correlator.ts`
 * orders by `startTime` first — so this rounds rather than truncates, exactly
 * as `@debuggen/shared`'s `roundMs(value, 3)` does for the server producer.
 * Multiply-and-divide is used instead of that function's decimal-exponent
 * shift because it allocates nothing on the page's click path, and because
 * every timestamp the event schema admits (below the year 2100) stays inside
 * the range where `value * 1000` is an exactly representable integer, which is
 * the condition under which the two approaches agree.
 */
function round3(value: number): number {
  return Math.round(value * TIME_ROUNDING_FACTOR) / TIME_ROUNDING_FACTOR;
}

/**
 * {@link round3} for a value that is meant to be an instant: a non-finite
 * input degrades to the current wall clock rather than to `NaN`, because an
 * event with no start time is not an event.
 */
function roundEpochMs(value: number): number {
  if (!isFiniteNumber(value)) {
    return Date.now();
  }
  return round3(value);
}

/**
 * The instant this document's clock calls now, in epoch milliseconds with
 * sub-millisecond precision where the host can supply it.
 *
 * `performance.timeOrigin + performance.now()` reads a monotonic counter
 * against the document's origin, so it is both finer than a millisecond and
 * immune to a wall-clock adjustment in the middle of a capture. Without a
 * usable clock it degrades to `Date.now()`, which costs resolution and never
 * correctness: ordering falls through to `(producerId, seq)` and then to the
 * store's ingest sequence, both always distinct.
 *
 * @returns Epoch milliseconds, fractional when the host clock allows it.
 */
export function nowEpochMs(): number {
  try {
    const reading = probeClock();
    if (reading === undefined) {
      return Date.now();
    }
    if (reading.timeOrigin !== undefined) {
      return roundEpochMs(reading.timeOrigin + reading.relativeMs);
    }
    return Date.now();
  } catch {
    // A page that replaced `performance` with a throwing accessor still gets a
    // usable timestamp; a thrown clock read must not abort an event.
    return Date.now();
  }
}

/**
 * Convert a document-relative millisecond reading to epoch milliseconds.
 *
 * This is the conversion every borrowed timestamp in this folder goes
 * through — `PerformanceEntry.startTime`, `PerformanceEventTiming`'s
 * processing marks, `Event.timeStamp`, a React fiber's `actualStartTime` — all
 * of which are measured from `performance.timeOrigin` and none of which mean
 * anything to the service until they are on the one epoch-millisecond base the
 * event contract defines (AAP 0.2.3).
 *
 * @param relativeMs Milliseconds since this document's time origin.
 * @returns Epoch milliseconds, or the current instant when no origin can be
 * resolved or the input is not finite.
 */
export function toEpochMs(relativeMs: number): number {
  try {
    if (!isFiniteNumber(relativeMs)) {
      return nowEpochMs();
    }

    const reading = probeClock();
    if (reading === undefined) {
      return Date.now();
    }
    if (reading.timeOrigin !== undefined) {
      return roundEpochMs(reading.timeOrigin + relativeMs);
    }
    // The host exposes the clock but not its origin: derive the origin from the
    // two readings that are available, as `@debuggen/shared` does.
    return roundEpochMs(Date.now() - reading.relativeMs + relativeMs);
  } catch {
    // Same reasoning as `nowEpochMs`: a hostile or shimmed clock costs
    // precision, never an event.
    return Date.now();
  }
}

/*
 * ---------------------------------------------------------------------------
 * Attribute sanitizing
 *
 * The last line of defence, not the first. Producers are expected to hand over
 * values that are already summarised — `./fiber-diff.ts` turns a prop or a
 * hook value into a `{ type, preview, truncated }` summary and never lets an
 * application value near this module, and `./dom-target.ts` returns a
 * descriptor of strings. What is left for this layer is the mistake those two
 * cannot prevent: a producer that puts a live callback, a DOM node, an `Error`
 * or a cyclic object straight onto an attribute bag. A cycle or a bigint makes
 * the frame's serialization throw and would cost the whole batch, a function
 * or a DOM node would silently change shape on the way — and the ingress schema
 * refuses functions and symbols as well — so every bag is rebuilt here out of
 * values that are certain to survive a JSON round trip unchanged.
 *
 * Rebuilding rather than checking has a second effect worth stating: the
 * object that leaves is a fresh plain object with no getters and no `Proxy`
 * traps, so nothing the page defined on the value itself runs while the frame
 * is being rendered.
 *
 * The walk follows the rules of "Core intrinsics and page-proof primitives":
 * keys come from the captured `Object.keys`, arrays and plain objects are
 * recognised with the captured `Array.isArray` and `Reflect.getPrototypeOf`,
 * a DOM node with the captured `instanceof` algorithm, and the rebuilt bag is
 * filled with {@link defineOwnValue} and {@link appendValue}. So no built-in
 * a page replaced, and no accessor it put on a prototype, is handed a bag a
 * producer built or the bag being rebuilt. An own getter on a value the *page*
 * supplied still runs here, once, as it always has: that getter belongs to the
 * object it is defined on, and its result is what gets copied.
 * ---------------------------------------------------------------------------
 */

/**
 * The deepest container level kept below a top-level attribute value.
 *
 * Level 0 is the attribute's own value, and 2 is what the widest shape this
 * product actually emits needs: `../schema/attributes.ts`'s `changedProps`
 * carries `ChangedPropEntry[]` — an array (0) of entries (1) whose `previous`
 * and `next` are value summaries (2) of primitives. A container found deeper
 * than this is replaced by its type tag, which is also what makes a cyclic
 * value terminate here rather than at a cycle detector.
 */
const MAX_ATTRIBUTE_DEPTH = 2;

/**
 * The most values one attribute bag may contribute to a sanitized result.
 *
 * The key bound and the depth bound multiply — thirty-two keys of thirty-two
 * entries of thirty-two fields is a million visits — and this runs inside the
 * developer's own click handler, so the walk needs a flat ceiling as well as a
 * shape. 1 024 is several times the largest bag this product emits (a
 * thirty-two-entry `propChanges` list is roughly three hundred values), so the
 * ceiling is reached only by a bag that should not exist, and reaching it
 * costs type tags rather than a dropped event.
 */
const MAX_SANITIZED_NODES = 1024;

/**
 * Returned in place of a value that must not appear at all: a non-finite
 * number (JSON has no spelling for `NaN` or `Infinity`) or an `undefined`.
 *
 * A symbol cannot be produced by sanitizing any input — symbols become type
 * tags — so it is unambiguous as a sentinel, and it never escapes: every call
 * site converts it to an omitted key or to `null`.
 */
const OMITTED = Symbol('debuggen.omitted');

/** The remaining node budget for one bag, threaded through the walk. */
interface SanitizeBudget {
  remaining: number;
}

/**
 * Render a value's category as a short, fixed string: `[function]`, `[dom]`,
 * `[bigint]`, `[object]`.
 *
 * The categories are `../schema/attributes.ts`'s `AttributeValueType`
 * vocabulary, so a tag this module writes reads the same as the `type` field
 * of a summary `./fiber-diff.ts` writes, and a panel needs one way to
 * understand both.
 */
function typeTag(type: AttributeValueType): string {
  return `[${type}]`;
}

/** `Function.prototype[Symbol.hasInstance]`: the ordinary `instanceof` algorithm. */
type HasInstanceFunction = (this: unknown, value: unknown) => boolean;

/** `value instanceof Node`, as the platform answered it at evaluation. */
interface NodeTest {
  /** The ordinary `instanceof` algorithm, called with {@link node} as `this`. */
  readonly hasInstance: HasInstanceFunction;
  /** The `Node` interface object. */
  readonly node: object;
}

/**
 * Capture what `value instanceof Node` needs, or report that this host has no
 * DOM.
 *
 * `instanceof Node` written out looks up the global `Node` binding and then
 * its `Symbol.hasInstance` when it runs. A page can replace either one, and
 * the replacement receives the value being tested, which here is a container
 * a producer built. The interface object and the ordinary algorithm on
 * `Function.prototype` are captured instead, and called through the captured
 * `Reflect.apply`. The algorithm reads `Node.prototype`, which WebIDL makes
 * non-writable and non-configurable, and walks the value's prototype chain.
 *
 * @returns The captured pair, frozen, or `undefined` where there is no `Node`.
 */
function captureNodeTest(): NodeTest | undefined {
  try {
    if (typeof Node === 'undefined' || typeof Symbol === 'undefined') {
      return undefined;
    }
    const node: unknown = Node;
    const hasInstance: unknown = Reflect.get(Function.prototype, Symbol.hasInstance);
    if (typeof node !== 'function' || typeof hasInstance !== 'function') {
      return undefined;
    }
    return Object.freeze({ node, hasInstance: hasInstance as HasInstanceFunction });
  } catch {
    return undefined;
  }
}

/** The `instanceof Node` test, captured once, at module evaluation. */
const NODE_TEST: NodeTest | undefined = captureNodeTest();

/**
 * Whether a value is, or convincingly claims to be, a DOM node.
 *
 * A node from another realm (an iframe's document) fails `instanceof`, and a
 * node is exactly the value that must not be serialised, so a duck test
 * follows. For an array or a plain object it reads only *own data*
 * properties. Such a container is one a producer built, or page data copied
 * into a literal, and reading a key it lacks would walk to `Object.prototype`,
 * where a page accessor would receive the container. Any other object is the
 * page's own, a class instance or a node from another realm, and is asked as
 * it always was.
 *
 * @param core The captured intrinsics.
 * @param value The object to test.
 * @param container Whether `value` is an array or a plain object.
 */
function isDomNode(core: CoreIntrinsics, value: object, container: boolean): boolean {
  const test = NODE_TEST;
  if (test !== undefined && core.apply(test.hasInstance, test.node, [value])) {
    return true;
  }
  if (container) {
    return (
      typeof readOwnData(core, value, 'nodeType') === 'number' &&
      typeof readOwnData(core, value, 'nodeName') === 'string'
    );
  }
  const candidate = value as { nodeType?: unknown; nodeName?: unknown };
  return typeof candidate.nodeType === 'number' && typeof candidate.nodeName === 'string';
}

/**
 * Whether a value is a plain object — an object literal or a null-prototype
 * bag — as opposed to a class instance, a `Map`, a `Date` or an `Error`.
 *
 * Only plain objects are walked. Everything else is tagged, because its
 * meaning lives in its prototype and a JSON rendering of it would be either
 * empty (`Error`, `Map`) or a lie. Asked with the captured
 * `Reflect.getPrototypeOf` against `Object.prototype` as it was at
 * evaluation, so a page's `Object.getPrototypeOf` never receives the value.
 *
 * @param core The captured intrinsics.
 * @param value The object to test.
 */
function isPlainObject(core: CoreIntrinsics, value: object): boolean {
  const prototype = core.apply(core.prototypeOf, undefined, [value]);
  return prototype === core.objectPrototype || prototype === null;
}

/**
 * Sanitize one value, recursing into plain arrays and objects within the
 * depth and node budgets.
 *
 * @param core The captured intrinsics.
 * @param value The value as the producer left it.
 * @param depth Container level of this value; 0 for a top-level attribute.
 * @param budget Shared node allowance for the whole bag.
 * @returns A JSON-safe value, or {@link OMITTED}.
 */
function sanitizeValue(
  core: CoreIntrinsics,
  value: unknown,
  depth: number,
  budget: SanitizeBudget,
): unknown {
  budget.remaining -= 1;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      // `NaN` and `Infinity` are numbers to the schema but become `null` in
      // JSON, and the event schema bounds the numeric fields that matter, so
      // the honest rendering of a non-finite number is its absence.
      return isFiniteNumber(value) ? value : OMITTED;
    case 'undefined':
      return OMITTED;
    case 'bigint':
      // The frame's serialization throws on a bigint, which would cost the batch.
      return typeTag('bigint');
    case 'symbol':
      return typeTag('symbol');
    case 'function':
      return typeTag('function');
    default:
      break;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'object') {
    // Unreachable against today's `typeof` results — every one of them is
    // handled above — and the total fallback the vocabulary's `unknown` member
    // exists for, so a future host type is described rather than transported.
    return typeTag('unknown');
  }

  const container: object = value;
  // Classified once, with the captured intrinsics, before anything is read
  // from the container: the DOM test below needs to know whether it may ask
  // an arbitrary object or only a container's own data.
  const array = core.apply(core.isArray, undefined, [container]);
  const plain = !array && isPlainObject(core, container);

  if (isDomNode(core, container, array || plain)) {
    return typeTag('dom');
  }

  if (array) {
    if (depth > MAX_ATTRIBUTE_DEPTH || budget.remaining <= 0) {
      return typeTag('array');
    }
    return sanitizeArray(core, container as readonly unknown[], depth + 1, budget);
  }

  if (!plain) {
    return typeTag('object');
  }

  if (depth > MAX_ATTRIBUTE_DEPTH || budget.remaining <= 0) {
    return typeTag('object');
  }

  return sanitizeRecord(core, container as Record<string, unknown>, depth + 1, budget);
}

/**
 * Sanitize an array's first {@link MAX_TRACKED_KEYS} entries.
 *
 * An entry that must not appear becomes `null` rather than vanishing: an array
 * is positional, and dropping an element would silently renumber the rest.
 *
 * A hole reads as the `undefined` it is, and so becomes `null`, as before. It
 * is tested with the captured `Object.hasOwn` rather than read, because
 * reading an index the array does not own walks to `Array.prototype`, where a
 * page's index accessor would receive the array.
 */
function sanitizeArray(
  core: CoreIntrinsics,
  value: readonly unknown[],
  depth: number,
  budget: SanitizeBudget,
): unknown[] {
  const length = value.length;
  const limit = length < MAX_TRACKED_KEYS ? length : MAX_TRACKED_KEYS;
  const out: unknown[] = [];
  for (let index = 0; index < limit; index += 1) {
    let sanitized: unknown;
    try {
      const element: unknown = core.apply(core.hasOwn, undefined, [value, index])
        ? value[index]
        : undefined;
      sanitized = sanitizeValue(core, element, depth, budget);
    } catch {
      // An exotic array with a throwing index getter costs one element.
      sanitized = typeTag('unknown');
    }
    appendValue(out, sanitized === OMITTED ? null : sanitized);
  }
  return out;
}

/**
 * Sanitize an object's first {@link MAX_TRACKED_KEYS} own enumerable string
 * keys.
 *
 * A key whose value must not appear is left out entirely, which is what
 * `JSON.stringify` does with an `undefined` property anyway and what
 * `../schema/attributes.ts`'s optional summary fields are declared for: under
 * `exactOptionalPropertyTypes` an absent `previous` and a `previous` set to
 * `undefined` are different things, and only the first survives transport.
 *
 * Symbol-keyed properties are not visited at all: `Object.keys` does not
 * report them, the event schema's attribute bag is keyed by strings, and
 * JSON drops a symbol key without a trace.
 *
 * Keys come from the captured `Object.keys`, so each one is the value's own and
 * reading it never reaches a prototype. Each member of the result is defined
 * rather than assigned, so a setter a page put on `Object.prototype` is never
 * handed the bag being built. A key named `__proto__` is skipped. Assigning it
 * never produced an own key either: it replaced the result's prototype, and the
 * frame never carried it.
 */
function sanitizeRecord(
  core: CoreIntrinsics,
  value: Record<string, unknown>,
  depth: number,
  budget: SanitizeBudget,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  let keys: string[];
  try {
    keys = core.apply(core.ownKeys, undefined, [value]);
  } catch {
    // A `Proxy` with a throwing `ownKeys` trap yields an empty bag, not a
    // thrown event.
    return out;
  }

  let kept = 0;
  for (let index = 0; index < keys.length; index += 1) {
    if (kept >= MAX_TRACKED_KEYS) {
      break;
    }

    const key = keys[index];
    if (key === undefined || key === '__proto__') {
      continue;
    }

    let sanitized: unknown;
    try {
      sanitized = sanitizeValue(core, value[key], depth, budget);
    } catch {
      // A throwing getter costs one key.
      sanitized = typeTag('unknown');
    }

    if (sanitized === OMITTED) {
      continue;
    }

    defineOwnValue(out, key, sanitized);
    kept += 1;
  }

  return out;
}

/**
 * Turn a producer's attribute bag into one that is certain to survive a JSON
 * round trip unchanged.
 *
 * A bag that is not an object at all — `undefined` from a producer that forgot
 * the field, or an array — becomes `{}`, because the schema requires an object
 * and an empty bag is a well-formed event while a malformed one is not.
 *
 * @param value The bag as the producer left it.
 * @returns A fresh plain object of JSON-safe values.
 * @throws {TypeError} Only in a host with no core intrinsics; every caller
 * contains it.
 */
function sanitizeAttributes(value: unknown): Record<string, unknown> {
  const core = coreIntrinsics();
  if (typeof value !== 'object' || value === null || core.apply(core.isArray, undefined, [value])) {
    return {};
  }
  return sanitizeRecord(core, value as Record<string, unknown>, 0, {
    remaining: MAX_SANITIZED_NODES,
  });
}

/**
 * Bound one string destined for a control frame.
 *
 * Exported because the fields that need it are assembled by their producers,
 * not here: `./agent.ts` reads the document's URL and `./dom-target.ts` builds
 * a selector, and a field bounded where it is read is a field that cannot
 * arrive unbounded. {@link postControl} applies the same bound to every string
 * in a payload anyway, so calling this is belt and braces — deliberately, since
 * the second guarantee is the one a reviewer can see at the field.
 *
 * The text is exactly what `../redaction/rules.ts`'s
 * `truncate(value, MAX_CONTROL_TEXT_LENGTH)` returns: the value itself when it
 * has at most that many code points, otherwise its first
 * `MAX_CONTROL_TEXT_LENGTH - 1` code points and {@link TRUNCATION_SUFFIX}. A
 * code point is a surrogate pair or any other single code unit, as the string
 * iterator counts them. It is computed here with indexed reads of the
 * primitive and string comparisons rather than by calling `truncate`, which
 * runs `Number.isFinite`, `Math.floor`, `Array.from`, `slice` and `join`. All
 * of those are the page's to replace, and a page that made `Number.isFinite`
 * answer `false` would switch the bound off for every control frame, the
 * `agent.ready` announcement included.
 *
 * @param value The text as its producer read it.
 * @returns The text, at most {@link MAX_CONTROL_TEXT_LENGTH} code points, with
 * an ellipsis in place of whatever was removed.
 */
export function boundControlText(value: string): string {
  try {
    const limit = MAX_CONTROL_TEXT_LENGTH;
    if (value.length <= limit) {
      return value;
    }

    // Units covered by the first `limit - 1` code points: what is kept when
    // the text turns out to be longer than `limit` code points.
    let kept = 0;
    let points = 0;
    let index = 0;
    while (index < value.length) {
      index += isSurrogatePairAt(value, index) ? 2 : 1;
      points += 1;
      if (points === limit - 1) {
        kept = index;
      }
      if (points > limit) {
        let text = '';
        for (let unit = 0; unit < kept; unit += 1) {
          text += value[unit] ?? '';
        }
        return text + TRUNCATION_SUFFIX;
      }
    }
    return value;
  } catch {
    // Indexed reads of a primitive cannot throw; the guard is here because this
    // is called from a page stack and the module's second invariant admits no
    // exceptions.
    return '';
  }
}

/**
 * Whether a high surrogate at `index` is followed by a low surrogate, so the
 * two code units are one code point.
 *
 * String comparison of one-unit strings compares their code units, which is
 * what makes this operator-only.
 *
 * @param value The text.
 * @param index A code-unit index into it.
 */
function isSurrogatePairAt(value: string, index: number): boolean {
  const high = value[index];
  const low = value[index + 1];
  return (
    high !== undefined &&
    low !== undefined &&
    high >= '\uD800' &&
    high <= '\uDBFF' &&
    low >= '\uDC00' &&
    low <= '\uDFFF'
  );
}

/**
 * Apply {@link boundControlText} to every string in an already-sanitized
 * control payload.
 *
 * The input has been through {@link sanitizeAttributes}, so it is a tree of
 * plain objects, arrays and primitives at most {@link MAX_ATTRIBUTE_DEPTH}
 * containers deep with at most {@link MAX_TRACKED_KEYS} members per container
 * and {@link MAX_SANITIZED_NODES} nodes overall: the walk below is therefore
 * bounded by construction, has no getters to trigger and no cycles to find.
 * It is the sanitizer's own output, so it is walked the same way: captured
 * `Array.isArray` and `Object.keys`, indexed loops, and every member of the
 * copy defined rather than assigned.
 *
 * @param core The captured intrinsics.
 * @param value A sanitized value.
 * @returns The same shape with its strings bounded.
 */
function boundControlValue(core: CoreIntrinsics, value: unknown): unknown {
  if (typeof value === 'string') {
    return boundControlText(value);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  if (core.apply(core.isArray, undefined, [value])) {
    const list = value as readonly unknown[];
    const out: unknown[] = [];
    for (let index = 0; index < list.length; index += 1) {
      appendValue(out, boundControlValue(core, list[index]));
    }
    return out;
  }

  return boundControlRecord(core, value as Record<string, unknown>);
}

/**
 * The record case of {@link boundControlValue}.
 *
 * @param core The captured intrinsics.
 * @param record A sanitized record.
 * @returns A copy with every string bounded.
 */
function boundControlRecord(
  core: CoreIntrinsics,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = core.apply(core.ownKeys, undefined, [record]);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== undefined) {
      defineOwnValue(out, key, boundControlValue(core, record[key]));
    }
  }
  return out;
}

/**
 * {@link boundControlValue} for a whole payload record.
 *
 * @param payload A sanitized control payload.
 * @returns The payload with every string bounded.
 * @throws {TypeError} Only in a host with no core intrinsics; the caller
 * contains it.
 */
function boundControlPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return boundControlRecord(coreIntrinsics(), payload);
}

/*
 * ---------------------------------------------------------------------------
 * Stamping
 *
 * The four fields a producer does not supply, and the reason this module is
 * the only place they are assigned.
 * ---------------------------------------------------------------------------
 */

/**
 * The tier every event from this producer carries.
 *
 * Written against `../schema/kinds.ts`'s vocabulary with `satisfies` rather
 * than as a bare string, so a rename of the tier vocabulary is a compile error
 * here instead of a per-tier duration that silently does not add up (the
 * kind/tier agreement check in `../schema/event.ts` explains the consequence).
 */
const BROWSER_TIER = 'browser' satisfies TelemetryTier;

/**
 * Hand out the next sequence number for the current capture.
 *
 * `seq` is a per-producer monotonic counter scoped to
 * `(producerId, captureId)` (AAP 0.2.3). One document has exactly one producer
 * id — `./ids.ts` memoizes it and deliberately offers no reset — so the scope
 * reduces to the capture, and {@link configureTransport} restarts the counter
 * whenever the capture changes.
 *
 * Three properties matter, and `../node/convert.ts` implements the identical
 * allocator for the server producer so that both tiers order the same way:
 *
 * 1. **Strictly increasing within a capture.** `../correlation/correlator.ts`
 *    orders a trace by `startTime` and then by `(producerId, seq)`, so a
 *    counter that ever went backwards would reorder a trace tree.
 * 2. **Restarted on a capture change**, which is what keeps the numbers small
 *    and a capture's sequence self-contained.
 * 3. **Unaffected by dropped events.** A number is consumed when an event is
 *    stamped, not when it is delivered, so a queue overflow leaves a gap. The
 *    gap is information — it says events were lost — and never a reason to
 *    renumber.
 */
function nextSeq(): number {
  const value = seqCounter;
  seqCounter += 1;
  return value;
}

/**
 * Complete a draft into a full `TelemetryEventIngress`.
 *
 * Built field by field rather than by spreading the draft, which is what makes
 * two guarantees mechanical instead of conventional:
 *
 * - **No service-assigned field can escape.** `sessionId`, `captureId` and
 *   `ingestSeq` are the service's (`telemetryEventIngressSchema` is strict and
 *   rejects them), and `redacted` is the ingest redactor's provenance marker.
 *   None of the four is copied here, so a mistaken caller cannot smuggle one
 *   onto the wire and have its whole batch rejected downstream.
 * - **No unknown key can escape either**, for the same reason: strictness at
 *   the service means one stray property costs the event.
 *
 * The three optional members — `id`, `parentSpanId`, `source` — are read as
 * the draft's *own data* only. A producer that leaves one out builds a literal
 * without that key, and reading a missing key walks to `Object.prototype`,
 * where a page's accessor would be handed the draft and could rewrite it
 * before the rest is copied. The required members are always the literal's
 * own. The three optional members that are written onto the event —
 * `parentSpanId`, `source` and `clockOffsetMs` — are defined rather than
 * assigned, for the same reason in the other direction: the event is the
 * object the batch is serialised from.
 *
 * It is also where `clockOffsetMs` is stamped, and the only place: the
 * document's current estimate ({@link clockOffset}), read once as the event is
 * created and carried by the event object from then on. Every later path —
 * the queue, a batch split, a delivery after the bridge returns — posts that
 * same object, so an event is never restamped, and its `startTime` and
 * `duration` are computed without reference to the offset at all.
 *
 * @returns The completed event, or `undefined` when the draft cannot become
 * one — which today means only a non-finite `startTime` or `duration`, since
 * JSON has no spelling for those and the event would be rejected at ingest.
 * @throws {TypeError} Only in a host with no core intrinsics; the caller
 * contains it.
 */
function completeDraft(draft: EventDraft): TelemetryEventIngress | undefined {
  const core = coreIntrinsics();
  if (!isFiniteNumber(draft.startTime) || !isFiniteNumber(draft.duration)) {
    return undefined;
  }

  const draftId = readOptionalMember(core, draft, 'id') as EventDraft['id'] | null;
  const parentSpanId = readOptionalMember(
    core,
    draft,
    'parentSpanId',
  ) as EventDraft['parentSpanId'];
  const source = readOptionalMember(core, draft, 'source') as EventDraft['source'];

  const event: TelemetryEventIngress = {
    id: draftId ?? newEventId(),
    traceId: draft.traceId,
    spanId: draft.spanId,
    kind: draft.kind,
    name: draft.name,
    // Rounded to microsecond resolution so a stored timestamp renders
    // identically every time it is serialised; the fraction is kept, because
    // events inside one interaction share milliseconds routinely.
    startTime: roundEpochMs(draft.startTime),
    duration: round3(draft.duration),
    tier: BROWSER_TIER,
    attributes: sanitizeAttributes(draft.attributes),
    status: draft.status,
    producerId: getProducerId(),
    seq: nextSeq(),
  };

  // Both optional: defined only when the producer resolved one, because under
  // `exactOptionalPropertyTypes` an absent field and a field set to
  // `undefined` are different things, and JSON keeps only the first.
  if (parentSpanId !== undefined) {
    defineOwnValue(event, 'parentSpanId', parentSpanId);
  }
  if (source !== undefined) {
    defineOwnValue(event, 'source', source);
  }
  // Absent until the document's first usable sample, for the same
  // `exactOptionalPropertyTypes` reason: "no estimate yet" is an absent field,
  // never an explicit `undefined`.
  const clockOffsetMs = clockOffset.estimate();
  if (clockOffsetMs !== undefined) {
    defineOwnValue(event, 'clockOffsetMs', clockOffsetMs);
  }

  return event;
}

/**
 * An optional member of a producer-built object, read as its own data.
 *
 * @param core The captured intrinsics.
 * @param holder The object.
 * @param key The member.
 * @returns The value, or `undefined` when the object has no own data property
 * by that name. Neither case reaches the prototype chain.
 */
function readOptionalMember(core: CoreIntrinsics, holder: object, key: string): unknown {
  const value = readOwnData(core, holder, key);
  return value === NOT_OWN_DATA ? undefined : value;
}

/**
 * Stamp one draft and queue it, containing any failure to that one draft.
 *
 * Shared by {@link emit} and {@link emitMany}: a React commit can produce
 * dozens of render drafts at once, and one malformed draft among them must
 * cost that draft and not the rest of the commit.
 */
function acceptDraft(draft: EventDraft): void {
  try {
    const event = completeDraft(draft);
    if (event === undefined) {
      recordUnpostable(1);
      return;
    }
    enqueue(event);
  } catch {
    // A draft whose own property access throws (an exotic object from the
    // page) is counted and abandoned.
    recordUnpostable(1);
  }
}

/*
 * ---------------------------------------------------------------------------
 * Queue and delivery
 * ---------------------------------------------------------------------------
 */

/**
 * Count events that were dropped before or instead of delivery.
 *
 * The count is reported on the next claimed batch's `droppedCount` — and, when
 * no batch follows, by the event-less loss report a terminal flush posts (see
 * {@link deliverLossReport}), so a loss on a capture's last batch still reaches
 * the service.
 */
function recordDropped(count: number): void {
  droppedTotal += count;
  pendingDropped += count;
}

/** Count events that could not be rendered or posted at all. */
function recordUnpostable(count: number): void {
  serializationFailureTotal += count;
  recordDropped(count);
}

/** How many events the queue holds right now. */
function bufferedCount(): number {
  return ringCount;
}

/**
 * Grow the ring, preserving order, up to {@link MAX_BUFFERED_EVENTS}.
 *
 * Doubling, so a capture that queues `n` events pays for at most `2n` slots
 * and `log2(n)` copies rather than one copy per event. The copy walks the ring
 * in logical order into a fresh array and resets the head to zero, which is
 * also the only moment the two index spaces have to agree.
 *
 * @returns Whether the ring grew; `false` means it is already at the cap.
 */
function growBuffer(): boolean {
  const capacity = ring.length;
  if (capacity >= MAX_BUFFERED_EVENTS) {
    return false;
  }

  const doubled = capacity === 0 ? INITIAL_BUFFER_CAPACITY : capacity * 2;
  const nextCapacity = doubled < MAX_BUFFERED_EVENTS ? doubled : MAX_BUFFERED_EVENTS;

  // Every slot is defined, the free ones as `undefined`, so the ring has no
  // holes: each later write lands on an own element instead of walking to
  // `Array.prototype`, where a page's index accessor would receive the event.
  // For the same reason the ring is a literal filled by `appendValue()`,
  // never `new Array(n)`: `Array` is a page global like any other.
  const grown: (TelemetryEventIngress | undefined)[] = [];
  for (let index = 0; index < nextCapacity; index += 1) {
    const slot = ringHead + index;
    appendValue(
      grown,
      index < ringCount ? ring[slot >= capacity ? slot - capacity : slot] : undefined,
    );
  }

  ring = grown;
  ringHead = 0;
  return true;
}

/**
 * Queue one completed event, evicting the oldest when the queue is full.
 *
 * **Oldest-first eviction is the deliberate choice.** The events at the head
 * of a full queue are the ones the developer produced first and has already
 * moved on from; the ones arriving now describe what they are looking at. A
 * newest-first policy would answer the question "what just happened?" with the
 * beginning of a render storm and nothing else. The loss is reported rather
 * than hidden: the count rides out on the next batch's `droppedCount` (or, when
 * no batch follows, on the terminal flush's loss-only report — see
 * {@link deliverLossReport}) and shows up in {@link TransportStats}, so the
 * panel can say events were lost instead of presenting a truncated capture as
 * a whole one.
 *
 * Both operations are constant time. An eviction advances {@link ringHead} and
 * releases one slot; it never moves a neighbour, which is what keeps a capture
 * that overflows from costing the page more per event the longer it runs.
 */
function pushBuffered(event: TelemetryEventIngress): void {
  if (ringCount === ring.length && !growBuffer()) {
    // At the cap: the oldest event leaves so the newest can be kept. Exactly
    // one event is displaced, because the ring cannot hold more than the cap.
    ring[ringHead] = undefined;
    ringHead = ringHead + 1 >= ring.length ? 0 : ringHead + 1;
    ringCount -= 1;
    recordDropped(1);
  }

  const capacity = ring.length;
  const tail = ringHead + ringCount;
  ring[tail >= capacity ? tail - capacity : tail] = event;
  ringCount += 1;
}

/**
 * Remove and return the oldest `limit` events, in order.
 *
 * Each slot is cleared as it is read, so a posted batch holds the only
 * remaining reference to its events and the queue never keeps a capture alive
 * in memory after it has travelled.
 *
 * @param limit The most events to take; the queue may hold fewer.
 * @returns The events, oldest first.
 */
function takeBatch(limit: number): TelemetryEventIngress[] {
  const take = limit < ringCount ? limit : ringCount;
  if (take <= 0) {
    return [];
  }

  const capacity = ring.length;
  const batch: TelemetryEventIngress[] = [];
  for (let taken = 0; taken < take; taken += 1) {
    const cursor = ringHead + taken;
    const slot = cursor >= capacity ? cursor - capacity : cursor;
    const event = ring[slot];
    ring[slot] = undefined;
    if (event !== undefined) {
      // Defined, not pushed: `Array.prototype.push` would be handed the event.
      appendValue(batch, event);
    }
  }

  const head = ringHead + take;
  ringHead = head >= capacity ? head - capacity : head;
  ringCount -= take;
  return batch;
}

/**
 * Put events the bridge did not claim back at the front of the queue, in the
 * order given.
 *
 * The inverse of {@link takeBatch}, and the whole of the custody rule: a batch
 * leaves the queue to be dispatched and comes straight back unless the bridge
 * took it. Everything requeued here was taken from the head, so it is older
 * than everything still queued, and prepending it restores the stamping order
 * exactly — which is what lets the next drain deliver it with the `batchSeq`
 * it would have carried, before anything recorded after it.
 *
 * The queue's bound still holds. Events requeued into a queue that filled
 * while they were out are subject to the same oldest-first eviction as
 * {@link pushBuffered}: the oldest of them — the oldest events there are — are
 * the ones dropped, counted in {@link recordDropped} and reported on the next
 * batch's `droppedCount` (or the terminal flush's loss-only report), and the
 * rest keep their place.
 *
 * @param events The unclaimed events, oldest first.
 */
function requeueFront(events: readonly TelemetryEventIngress[]): void {
  const room = MAX_BUFFERED_EVENTS - ringCount;
  const excess = events.length - room;
  const first = excess > 0 ? excess : 0;
  if (first > 0) {
    recordDropped(first);
  }

  const keep = events.length - first;
  if (keep <= 0) {
    return;
  }

  while (ring.length - ringCount < keep) {
    if (!growBuffer()) {
      // Unreachable while `room` is honoured above — the ring grows to the cap
      // and `keep` never exceeds the room below it — and a stop rather than a
      // spin if that arithmetic is ever broken.
      return;
    }
  }

  // Written backwards from the event just ahead of the head, so the first
  // event given ends up at the new head.
  for (let index = events.length - 1; index >= first; index -= 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }
    ringHead = ringHead === 0 ? ring.length - 1 : ringHead - 1;
    ring[ringHead] = event;
    ringCount += 1;
  }
}

/** Discard every queued event, keeping the ring's slots for reuse. */
function clearBuffered(): void {
  const capacity = ring.length;
  for (let index = 0; index < ringCount; index += 1) {
    const cursor = ringHead + index;
    ring[cursor >= capacity ? cursor - capacity : cursor] = undefined;
  }
  ringHead = 0;
  ringCount = 0;
}

/**
 * Discard every queued event *and* the ring itself.
 *
 * {@link resetTransport}'s form of {@link clearBuffered}: a detached agent
 * holds no slots either, and the next capture allocates them again.
 */
function releaseBuffer(): void {
  ring = [];
  ringHead = 0;
  ringCount = 0;
}

/**
 * Queue one completed event and decide when it travels.
 *
 * Reaching {@link MAX_EVENTS_PER_BATCH} schedules a drain rather than
 * performing one: this function runs on the stack that produced the event —
 * the developer's click handler, a React commit, their own `fetch` call — and
 * rendering a full batch to JSON there would add the transport's cost to the
 * latency the capture exists to measure. The drain runs on the next task
 * instead, which is still "immediately" as far as the panel's live tail is
 * concerned and no longer inside the measurement.
 */
function enqueue(event: TelemetryEventIngress): void {
  pushBuffered(event);

  if (ringCount >= MAX_EVENTS_PER_BATCH) {
    // A full batch travels on its own turn: waiting for the timer would only
    // make the frame larger, and posting here would charge the page for it.
    scheduleDrain();
    return;
  }

  scheduleFlush();
}

/** Cancel a pending flush, if one is armed. */
function clearFlushTimer(): void {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
}

/**
 * Arm the coalescing flush timer, at most one at a time.
 *
 * Nothing is armed while the bridge is away: a timer that can only find the
 * channel closed would fire every {@link FLUSH_INTERVAL_MS} for as long as the
 * page lived. The buffer accumulates instead, and the arrival of
 * `bridge.ready` starts draining it at once — bounded like every other
 * non-terminal route, so a queue that waited out a long absence leaves over
 * consecutive turns rather than in one of them. Nothing is armed while the
 * bridge holds the agent back either ({@link flowPaused}): its
 * `bridge.resume` starts the drain.
 */
function scheduleFlush(): void {
  if (flushTimer !== undefined || !bridgeAvailable || flowPaused || ringCount === 0) {
    return;
  }

  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    try {
      // Bounded, like every other non-terminal drain: the timer fires on a
      // queue of any depth — a burst emitted faster than the scheduled drains
      // could empty it, or a host with no task source to schedule them on —
      // and one timer callback must not become the long task the threshold
      // path was changed to avoid.
      drainBatches(MAX_BATCHES_PER_DRAIN);
    } catch {
      // A timer callback is the one place a throw has no caller to catch it,
      // so it is caught here and the queue is left for the next flush.
    }
  }, FLUSH_INTERVAL_MS);
}

/**
 * Run a scheduled drain: clear the flag first, then post a bounded number of
 * batches.
 *
 * The flag is cleared before the work so that a drain which stops at
 * {@link MAX_BATCHES_PER_DRAIN} can schedule its own continuation, and so that
 * an event arriving during the drain can schedule the next one.
 */
function runScheduledDrain(): void {
  drainScheduled = false;
  try {
    drainBatches(MAX_BATCHES_PER_DRAIN);
  } catch {
    // Same reasoning as the flush timer: a task callback has no caller. The
    // queue survives and the next enqueue or timer retries.
  }
}

/**
 * The port a scheduled drain is posted to, created on first use.
 *
 * A `MessageChannel` message is the cheapest genuine task a page can post to
 * itself: it does not go through the timer queue (so it is not subject to the
 * 4 ms clamp nested timeouts acquire), it is not observable to the page's own
 * `message` listeners — the frames on this port never touch `window` — and it
 * yields between the producer's stack and the serialisation, which is the
 * whole point.
 *
 * @returns The sending port, or `undefined` when the host has no
 * `MessageChannel` or refused to construct one.
 */
function drainPort(): MessagePort | undefined {
  if (drainChannel !== undefined) {
    return drainChannel.port2;
  }
  if (typeof MessageChannel === 'undefined') {
    return undefined;
  }

  try {
    const channel = new MessageChannel();
    // Assigning `onmessage` implicitly starts the receiving port, so no
    // `start()` call is needed and none is made.
    channel.port1.onmessage = (): void => {
      runScheduledDrain();
    };
    drainChannel = channel;
    return channel.port2;
  } catch {
    // A page that has replaced `MessageChannel` with something that throws
    // falls back to the routes below; it never loses events over it.
    return undefined;
  }
}

/** Close and forget the drain channel, if one was created. */
function closeDrainChannel(): void {
  const channel = drainChannel;
  drainChannel = undefined;
  drainScheduled = false;

  if (channel === undefined) {
    return;
  }

  try {
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.close();
  } catch {
    // An already-closed or replaced port needs nothing; the references are
    // dropped above either way.
  }
}

/**
 * Hand a drain to a task source, without running it here.
 *
 * Three routes in descending order of fidelity to "a later turn, soon": a
 * channel message (a task, so the page gets its stack back first), a microtask
 * (off the producer's stack, still inside its task) and — from
 * {@link scheduleDrain} — the {@link FLUSH_INTERVAL_MS} timer, which is always
 * available. Each is tried only if the one before it is missing or throws.
 *
 * @returns Whether a task source accepted the drain.
 */
function postDrainTask(): boolean {
  const port = drainPort();
  if (port !== undefined) {
    try {
      port.postMessage(0);
      return true;
    } catch {
      // Fall through: a closed or hostile port must not cost the events.
    }
  }

  if (typeof queueMicrotask === 'function') {
    try {
      queueMicrotask(runScheduledDrain);
      return true;
    } catch {
      // Fall through to the caller's timer.
    }
  }

  return false;
}

/**
 * Schedule the one outstanding drain, if there is anything to drain and
 * anywhere to send it.
 *
 * Idempotent while a drain is outstanding, which is what makes a burst cost
 * one task rather than one per event. Nothing is scheduled while the bridge is
 * away — the queue accumulates and `bridge.ready` drains it — and a host that
 * accepts neither a channel message nor a microtask degrades to the coalescing
 * timer rather than to inline delivery. Nor is anything scheduled while the
 * bridge holds the agent back ({@link flowPaused}); its `bridge.resume` drains.
 */
function scheduleDrain(): void {
  if (drainScheduled || !bridgeAvailable || flowPaused || ringCount === 0) {
    return;
  }

  drainScheduled = true;
  if (postDrainTask()) {
    return;
  }

  drainScheduled = false;
  scheduleFlush();
}

/**
 * Dispatch queued events in batches of at most {@link MAX_EVENTS_PER_BATCH},
 * if the bridge is there to receive them.
 *
 * The drain stops at the first batch the bridge does not claim: that batch —
 * and, for a batch that had to be halved, every half after the unclaimed one —
 * goes back to the front of the queue in order (see {@link deliver} and
 * {@link requeueFront}), and dispatching the batches behind it would only
 * deliver them out of order or not at all.
 *
 * **One drain at a time.** A drain requested while another is dispatching —
 * which happens only from inside the bridge's listener, when it hands back a
 * `bridge.ready` and `./agent.ts` answers with a flush — returns at once. The
 * running drain owns the queue's head until it finishes, and then reschedules
 * whatever is still queued if the bridge is still there, so the nested request
 * is honoured on the next task rather than lost.
 *
 * **Held back by a pause, unless terminal.** While the bridge holds the agent
 * back ({@link flowPaused}) a bounded drain posts nothing, and one that is
 * running when a `bridge.pause` is handed back from inside its dispatch stops
 * before its next batch; the rest waits for `bridge.resume`. The terminal
 * drain of {@link flushNow} is never held back: it has no later turn to wait
 * for (see "Flow control" in the module notes).
 *
 * @param maxBatches How many batches this turn may dispatch.
 * `Number.POSITIVE_INFINITY` empties the queue, which is what the synchronous
 * callers want; a finite bound leaves the remainder to a rescheduled drain.
 * @param terminal Whether this is the terminal drain of {@link flushNow}, which
 * a pause does not hold back; every other route leaves it `false`.
 */
function drainBatches(maxBatches: number, terminal = false): void {
  clearFlushTimer();

  if (!bridgeAvailable || delivering) {
    return;
  }

  delivering = true;
  try {
    let batches = 0;
    // The pause is read before every batch, so a `bridge.pause` handed back
    // from inside a dispatch holds the next one back as surely as one that
    // arrived before the drain began.
    while (ringCount > 0 && batches < maxBatches && bridgeAvailable && (terminal || !flowPaused)) {
      const unclaimed = deliver(takeBatch(MAX_EVENTS_PER_BATCH));
      batches += 1;
      if (unclaimed.length > 0) {
        requeueFront(unclaimed);
        break;
      }
    }
  } finally {
    delivering = false;
  }

  if (ringCount > 0) {
    // The bound was reached with events still queued, a nested request was
    // deferred to this drain, or a batch was refused by a port the bridge has
    // since replaced: the rest travels on the next turn instead of extending
    // this one. `scheduleDrain` does nothing while the bridge is away or holds
    // the agent back.
    scheduleDrain();
  }
}

/**
 * Post everything queued, here and now.
 *
 * The synchronous, unbounded drain, and deliberately reachable from two call
 * sites only — both terminal, in the sense that there is no later turn for the
 * events to travel on:
 *
 * - {@link flush}, which `./agent.ts` calls on `pagehide` (the document is
 *   about to stop existing) and when a capture stops (the analysis runs on
 *   what arrived);
 * - the capture change in {@link configureTransport}, which discards whatever
 *   is still queued — so anything not posted here is not posted later, it is
 *   counted as lost.
 *
 * Every other route — the batch threshold, the flush timer, the bridge's
 * return, a `bridge.resume` — goes through {@link drainBatches} with
 * {@link MAX_BATCHES_PER_DRAIN}, because each of those has a next turn and
 * none of them is worth a long task on someone else's page. For the same
 * reason only this drain posts while the bridge holds the agent back: the
 * moments it serves have no later turn to wait for.
 *
 * **Terminal means the loss travels too.** Loss otherwise rides out on the
 * next batch's `droppedCount`, and at a terminal moment there may be no next
 * batch: the capture's last event was too large to post, or a loss was
 * recorded while the bridge held the last frame. So once the queue is empty
 * the pending count is posted on its own, as one event-less batch (see
 * {@link deliverLossReport}); a capture with nothing lost posts nothing extra.
 * `./agent.ts` also calls {@link flush} when the document is hidden and on
 * every `bridge.ready`, which is where a report the bridge did not claim is
 * retried. The bounded routes never post one — each has a next turn, and a
 * later batch or this flush will carry the count.
 */
function flushNow(): void {
  drainBatches(Number.POSITIVE_INFINITY, true);
  deliverLossReport();
}

/**
 * Build a `telemetry.batch` payload around a batch of events.
 *
 * The shape is the wire contract of this module's header, and it is assembled
 * structurally rather than against a protocol type: the service worker is what
 * wraps `events` into the protocol envelope and adds the tab id, and keeping
 * `@debuggen/protocol` out of the page bundle is what lets the agent ship as a
 * byte-for-byte copy of this package's build artifact.
 *
 * `droppedCount` carries the loss accumulated since the last batch reported
 * one; {@link deliver} clears what a batch reported only once the bridge has
 * claimed that batch, so the count is reported exactly once and never lost to
 * a frame nobody took. With an empty `events` list the payload is a loss-only
 * report ({@link deliverLossReport}), which is built only while that count is
 * positive: an empty batch with nothing lost is never posted.
 */
function buildBatchPayload(events: readonly TelemetryEventIngress[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    events,
    producerId: getProducerId(),
    documentId: getDocumentId(),
    batchSeq: batchSeqCounter,
    droppedCount: pendingDropped,
  };

  // Both omitted rather than sent as `undefined` when the service has not
  // named them: the frame is JSON-shaped, where an absent key is the only way
  // to say "no value". Defined rather than assigned: the literal does not own
  // either key yet, so an assignment would walk to `Object.prototype`, where a
  // page's setter would be handed the payload and could replace its events.
  if (currentCaptureId !== undefined) {
    defineOwnValue(payload, 'captureId', currentCaptureId);
  }
  if (currentSessionId !== undefined) {
    defineOwnValue(payload, 'sessionId', currentSessionId);
  }

  return payload;
}

/**
 * What became of one attempt to dispatch a frame.
 *
 * Five outcomes rather than a boolean, because each failure calls for a
 * different answer:
 *
 * - `sent` — the bridge claimed the frame: `dispatchEvent` returned `false`
 *   because its listener called `preventDefault()`. The only outcome after
 *   which a batch's events are counted as delivered and leave custody.
 * - `unclaimed` — the frame was dispatched and nobody claimed it:
 *   `dispatchEvent` returned `true`. The bridge's runtime port was gone or
 *   its listener was not installed; the bridge claims every frame it refuses
 *   for good, so a refusal never lands here. A batch is requeued in order and
 *   delivered after the next `bridge.ready`; a control frame, which is never
 *   retried, is counted as lost.
 * - `oversize` — the rendered frame is longer than {@link MAX_MESSAGE_BYTES}.
 *   A batch is split into halves that fit.
 * - `unserializable` — {@link serializeFrameJson} threw: the frame held a
 *   cycle, a bigint or nesting deeper than a frame may. A batch has a single
 *   bad event in it to isolate, so it is split too.
 * - `refused` — the frame was rendered but the event could not be constructed
 *   or dispatched at all. Splitting it would fail the same way, so a batch is
 *   dropped and counted.
 */
type FrameOutcome = 'sent' | 'unclaimed' | 'oversize' | 'unserializable' | 'refused';

/**
 * Render a frame to the exact string that will travel as its `detail`.
 *
 * The whole frame is rendered, not just its payload: `source`, `version` and
 * `type` are what the bridge filters on and they travel with every one. The
 * string is produced once and both measured and dispatched, so the size the
 * cap was checked against is the size that crossed.
 *
 * Rendered by {@link serializeFrameJson}, never by `JSON.stringify`: the text
 * is the one `JSON.stringify` would produce for the frame, but no `toJSON` a
 * page installed afterwards — on `Object.prototype`, `Array.prototype` or
 * anywhere else — is ever called with the frame or any part of it, and no
 * getter runs, so the page can neither read the frame while it is rendered nor
 * choose the text the agent dispatches.
 *
 * @param frame The frame to render.
 * @returns The JSON string, or `undefined` when the frame cannot be rendered
 * at all — which after sanitizing should be impossible, and is reported rather
 * than thrown.
 */
function renderFrame(frame: AgentOutboundMessage): string | undefined {
  try {
    return serializeFrameJson(frame);
  } catch {
    return undefined;
  }
}

/**
 * Render one frame, measure it and, if it fits, dispatch it on the channel
 * node for the bridge to claim.
 *
 * **The size cap lives here**, in the one function that dispatches a frame,
 * rather than in the telemetry path that used to own it. That is what makes it
 * apply to control frames too: an `agent.ready` carries the document's URL and
 * a `target.described` carries a selector and a text preview, all of them page
 * data of a length no page has to justify, and a frame nobody measured is a
 * frame whose size the page chooses (AAP 0.5.5's availability rule — the agent
 * must not be the reason the extension or the page falls over).
 *
 * The event is a {@link AGENT_FRAME_EVENT} `CustomEvent` built with the
 * captured constructor — `bubbles: false`, `cancelable: true`, the rendered
 * string as `detail` — and dispatched on the node through the captured
 * `dispatchEvent`. The bridge's listener runs synchronously inside that call,
 * which is why its `preventDefault()` is already reflected in the return value
 * when this function reads it.
 *
 * Never throws: the agent runs inside the page's own call stack, where an
 * exception would surface as an error in the developer's application.
 *
 * @param type The frame type, from the closed outbound vocabulary.
 * @param payload The frame's body, already sanitized by the caller.
 * @returns What became of the attempt. `unclaimed` when the channel is not
 * open, since no bridge can hold the node before the handshake; callers that
 * must not count such a frame check {@link isChannelOpen} first.
 */
function postFrame(type: AgentOutboundType, payload: Record<string, unknown>): FrameOutcome {
  const intrinsics = CHANNEL_INTRINSICS;
  const node = channelNode;
  if (intrinsics === undefined || node === undefined || !handshakeAnswered) {
    return 'unclaimed';
  }

  const frame: AgentOutboundMessage = {
    source: AGENT_SOURCE_TAG,
    version: CHANNEL_VERSION,
    type,
    payload,
  };

  const detail = renderFrame(frame);
  if (detail === undefined) {
    return 'unserializable';
  }
  if (detail.length > MAX_MESSAGE_BYTES) {
    return 'oversize';
  }

  let uncancelled: boolean;
  try {
    // The init dictionary is a null-prototype record. The constructor reads
    // every member the dictionary type declares, `composed` among them, and on
    // an ordinary object a member it lacks is looked up on `Object.prototype`.
    // A getter a page put there would run with the dictionary as `this` and
    // could read `detail`, the frame's whole text.
    const init = createNullRecord<CustomEventInit<string>>();
    init.detail = detail;
    init.bubbles = false;
    init.cancelable = true;
    const event = new intrinsics.CustomEvent<string>(AGENT_FRAME_EVENT, init);
    uncancelled = intrinsics.apply(intrinsics.dispatchEvent, node, [event]);
  } catch {
    return 'refused';
  }

  return uncancelled ? 'unclaimed' : 'sent';
}

/**
 * Report an event that cannot be delivered at all, and say so on the channel.
 *
 * The `agent.error` frame names the event's `kind` and `id` and nothing
 * else — never its attributes, which are the very thing that made it too
 * large — so the panel can tell the developer that an event was lost and
 * which one, without the report becoming a second copy of the data.
 */
function dropUnpostableEvent(event: TelemetryEventIngress, reason: string): void {
  recordUnpostable(1);
  postControl('agent.error', {
    reason,
    eventId: event.id,
    kind: event.kind,
    limitBytes: MAX_MESSAGE_BYTES,
  });
}

/**
 * The reason each refusal is reported under, as a closed vocabulary.
 *
 * Fixed strings, so the diagnostic frame's size is known in advance and cannot
 * be influenced by whatever made the original frame too large. `unclaimed` has
 * no entry because it is never reported: see {@link noteControlFrameLoss}.
 */
const CONTROL_LOSS_REASONS = {
  oversize: 'control-frame-too-large',
  unserializable: 'control-frame-unserializable',
  refused: 'control-frame-refused',
} as const satisfies Record<Exclude<FrameOutcome, 'sent' | 'unclaimed'>, string>;

/**
 * Account for a control frame the channel did not deliver, and say so where it
 * can be said cheaply.
 *
 * The diagnostic is deliberately minimal: a reason from
 * {@link CONTROL_LOSS_REASONS}, the type of the frame that was refused, and
 * the limit it exceeded. Nothing from the refused payload is quoted — the
 * payload is the very thing that was too large, and a diagnostic that carried
 * a piece of it would be a second, smaller copy of the problem.
 *
 * Two properties make this safe to call from the dispatch path itself:
 *
 * - **Non-recursive.** {@link reportingControlLoss} is set while the
 *   diagnostic is being dispatched, so a diagnostic that is itself refused
 *   reports nothing further; it is counted and that is all.
 * - **Reported only when reporting can work.** A frame refused for its *size*
 *   or its *rendering* leaves a working channel, and a small frame will cross
 *   it. A frame the channel `refused` means the platform rejected a rendered
 *   frame, and one nobody claimed (`unclaimed`) means there is no bridge on the
 *   other end right now: a second frame would meet the same fate, so none is
 *   attempted.
 *
 * @param type The frame that could not be delivered.
 * @param outcome Why it could not.
 */
function noteControlFrameLoss(
  type: AgentOutboundType,
  outcome: Exclude<FrameOutcome, 'sent'>,
): void {
  controlFramesDroppedTotal += 1;

  if (reportingControlLoss || outcome === 'refused' || outcome === 'unclaimed') {
    return;
  }

  reportingControlLoss = true;
  try {
    const reported = postFrame('agent.error', {
      reason: CONTROL_LOSS_REASONS[outcome],
      frame: type,
      limitBytes: MAX_MESSAGE_BYTES,
    });
    if (reported !== 'sent') {
      // The diagnostic is a control frame too, and one the channel dropped:
      // counted, so the number means "frames the channel did not deliver"
      // exactly. Nothing further is dispatched — the flag above is still set,
      // and this is the recursion it exists to stop.
      controlFramesDroppedTotal += 1;
    }
  } finally {
    reportingControlLoss = false;
  }
}

/** The empty result of a {@link deliver} that left nothing to requeue. */
const NOTHING_UNCLAIMED: readonly TelemetryEventIngress[] = Object.freeze([]);

/**
 * A fresh array of `prefix` followed by `source[start]` up to (excluding)
 * `source[end]`.
 *
 * What `[...prefix, ...source.slice(start, end)]` would build, by index and
 * with every element defined: the events of a batch are never handed to the
 * page's `slice`, to an array iterator, or to an index accessor on
 * `Array.prototype`.
 *
 * @param source The events to copy from; this module's own dense array.
 * @param start The first index copied.
 * @param end One past the last index copied.
 * @param prefix Events placed before the copied ones; also this module's own.
 * @returns The new array.
 */
function copyEvents(
  source: readonly TelemetryEventIngress[],
  start: number,
  end: number,
  prefix: readonly TelemetryEventIngress[],
): TelemetryEventIngress[] {
  const copy: TelemetryEventIngress[] = [];
  for (let index = 0; index < prefix.length; index += 1) {
    const event = prefix[index];
    if (event !== undefined) {
      appendValue(copy, event);
    }
  }
  for (let index = start; index < end; index += 1) {
    const event = source[index];
    if (event !== undefined) {
      appendValue(copy, event);
    }
  }
  return copy;
}

/**
 * Settle a batch whose capture ended while the bridge was handling it.
 *
 * The events belong to a capture that is over, so none of the current
 * capture's counters may move — not its `batchSeq`, not its `droppedCount` —
 * and nothing is requeued into it. A claimed batch was delivered, under the
 * identity it was built with, and is counted as sent; any other outcome loses
 * the events for good, which the cumulative totals record. Not called when the
 * transport was *reset* under the batch (see {@link resetGeneration}): those
 * totals have just been zeroed, and the batch predates them.
 *
 * @param count How many events the batch held.
 * @param outcome What became of it.
 */
function settleAcrossCaptureChange(count: number, outcome: FrameOutcome): void {
  if (outcome === 'sent') {
    sentTotal += count;
    batchesTotal += 1;
    return;
  }
  if (outcome === 'refused' || outcome === 'unserializable') {
    serializationFailureTotal += count;
  }
  droppedTotal += count;
}

/**
 * Account for a batch the bridge did not claim.
 *
 * The bridge is marked away and the flush timer cleared, so nothing more is
 * dispatched into a channel with nobody at the other end until the next
 * `bridge.ready` — **unless** that `bridge.ready` already arrived during this
 * very dispatch (see {@link bridgeReadyGeneration}), in which case the refusal
 * came from the port the bridge has since replaced and the bridge stays marked
 * present for the retry.
 *
 * @param generation {@link bridgeReadyGeneration} as it was when the frame was
 * dispatched.
 */
function noteUnclaimedBatch(generation: number): void {
  if (bridgeReadyGeneration !== generation) {
    return;
  }
  bridgeAvailable = false;
  clearFlushTimer();
}

/**
 * Dispatch one batch, splitting it when it is too large to travel, and hand
 * back whatever the bridge did not take.
 *
 * **Custody.** The events are counted as sent — and `batchSeq` advances, and
 * the reported part of `droppedCount` is cleared — only when the bridge claims
 * the frame. An `unclaimed` frame changes none of those: its events are
 * returned to the caller, which puts them back at the front of the queue, so
 * the next delivery carries the same `batchSeq`, the same drop count and no
 * duplicate. Halving keeps that order: when one half is unclaimed, it is
 * returned together with every half after it, earlier events first.
 *
 * Halving is also what keeps one pathological event from costing its
 * neighbours: a batch over {@link MAX_MESSAGE_BYTES} is split and each half
 * retried, down to a single event, and only that event is dropped. Recursion
 * depth is bounded by `log2(MAX_EVENTS_PER_BATCH)`, eight levels.
 *
 * A frame the platform `refused` is different in kind: it was rendered, and
 * splitting cannot help. That batch is dropped and counted.
 *
 * Re-entrant: the bridge's listener runs inside the dispatch and may hand back
 * frames of its own. A capture change or reset in that window is detected by
 * {@link captureEpoch}: a capture change is settled by
 * {@link settleAcrossCaptureChange}, a reset (see {@link resetGeneration}) into
 * nothing. A `bridge.gone` there stops the remaining halves from being
 * dispatched into a channel that has just closed, and an unclaimed frame marks
 * the bridge away whichever capture it belonged to.
 *
 * @param events The batch, oldest first.
 * @returns The events to requeue, oldest first; empty when every event was
 * delivered or accounted for.
 */
function deliver(events: readonly TelemetryEventIngress[]): readonly TelemetryEventIngress[] {
  if (events.length === 0) {
    return NOTHING_UNCLAIMED;
  }

  const epoch = captureEpoch;
  const resets = resetGeneration;
  const generation = bridgeReadyGeneration;
  const reportedDropped = pendingDropped;
  const outcome = postFrame('telemetry.batch', buildBatchPayload(events));

  if (captureEpoch !== epoch) {
    if (resetGeneration === resets) {
      settleAcrossCaptureChange(events.length, outcome);
    }
    if (outcome === 'unclaimed') {
      // The events are accounted to their ended capture, but the fact the
      // refusal states — nobody is taking frames — is about the channel.
      noteUnclaimedBatch(generation);
    }
    return NOTHING_UNCLAIMED;
  }

  if (outcome === 'sent') {
    batchSeqCounter += 1;
    sentTotal += events.length;
    batchesTotal += 1;
    // Only what this batch reported is cleared: a loss recorded while the
    // bridge held the frame rides out on the next batch instead of vanishing.
    pendingDropped = pendingDropped > reportedDropped ? pendingDropped - reportedDropped : 0;
    return NOTHING_UNCLAIMED;
  }

  if (outcome === 'unclaimed') {
    noteUnclaimedBatch(generation);
    return events;
  }

  if (outcome === 'refused') {
    // The frame was rendered and the platform still refused to carry it.
    // Halving would produce two frames that fail the same way.
    recordUnpostable(events.length);
    return NOTHING_UNCLAIMED;
  }

  const only = events.length === 1 ? events[0] : undefined;
  if (only !== undefined) {
    dropUnpostableEvent(
      only,
      outcome === 'unserializable' ? 'event-unserializable' : 'event-too-large',
    );
    return NOTHING_UNCLAIMED;
  }

  // `Math.ceil`, `slice` and spread are the page's: each would be handed the
  // batch, or decide how it is split. The halves are copied by index instead,
  // and `middle` is `ceil(length / 2)` for the integer length.
  const middle = (events.length + (events.length % 2)) / 2;
  const later = copyEvents(events, middle, events.length, NOTHING_UNCLAIMED);
  const unclaimed = deliver(copyEvents(events, 0, middle, NOTHING_UNCLAIMED));
  if (unclaimed.length > 0) {
    // The earlier half was not taken, so the later one is not attempted: both
    // go back, earlier first, and the next delivery starts where this stopped.
    return copyEvents(later, 0, later.length, unclaimed);
  }
  if (captureEpoch !== epoch) {
    // The capture ended while the earlier half was in the bridge's hands; the
    // later half belongs to it and can no longer be labelled correctly. It is
    // counted as lost unless the transport was reset, which zeroed the totals.
    if (resetGeneration === resets) {
      droppedTotal += later.length;
    }
    return NOTHING_UNCLAIMED;
  }
  if (!bridgeAvailable) {
    // The bridge said it was gone while it held the earlier half.
    return later;
  }
  return deliver(later);
}

/**
 * Post the pending loss on its own, as one `telemetry.batch` with no events.
 *
 * The terminal half of loss reporting. {@link recordDropped}'s count normally
 * rides out on the next batch's `droppedCount`, and at a terminal moment —
 * `pagehide`, a hidden document, a capture that stops or changes — there may be
 * no next batch: the capture's last event was too large to post or could not
 * be stamped, the platform refused the last frame, or a loss was recorded while
 * the bridge held it. Without this report that loss would be zeroed with the
 * capture, and the service would record the capture as complete.
 *
 * Called by {@link flushNow} only, after its unbounded drain. It posts only
 * when all of these hold, and otherwise does nothing:
 *
 * - the queue is empty, so no batch is left that could carry the count;
 * - the count is positive, so an empty batch never says "nothing lost" — the
 *   protocol accepts an empty `events` list only beside a positive
 *   `droppedCount`;
 * - the bridge is present and no dispatch is running — a report posted from
 *   inside the bridge's listener would overtake the frame still in its hands;
 * - a capture is set, since the count describes one.
 *
 * **Custody is {@link deliver}'s.** The payload is {@link buildBatchPayload}'s
 * with `events: []`: the capture's next `batchSeq`, the pending count, and the
 * capture and session ids. Then, by outcome:
 *
 * - `sent`, capture unchanged — `batchSeq` advances (the bridge requires it to
 *   increase strictly within a capture, so a claimed report takes a position)
 *   and the reported part of the count is cleared, so a loss recorded while
 *   the bridge held the frame stays pending. The frame counts in
 *   {@link TransportStats}'s `batches` — it is a claimed `telemetry.batch` —
 *   and adds nothing to `sent`, which counts events.
 * - `unclaimed` — the bridge is marked away ({@link noteUnclaimedBatch}) and
 *   the count kept, so the flush `./agent.ts` runs on the next `bridge.ready`
 *   re-sends it under the same `batchSeq`, once.
 * - `oversize`, `unserializable`, `refused` — the count is kept for the next
 *   batch or terminal flush. There are no events to split or drop, and the
 *   loss is already in the cumulative `dropped`.
 * - The capture changed, or the transport was reset, during the dispatch —
 *   none of the new capture's counters move. A claimed report still counts in
 *   `batches` unless a reset zeroed it, and an unclaimed one still marks the
 *   bridge away, because that fact is about the channel.
 *
 * Holds {@link delivering} for the dispatch, as a drain does: a `bridge.ready`
 * and flush handed back from inside the bridge's listener would otherwise post
 * a second report under the same `batchSeq` with the same count. Anything
 * queued in that window is rescheduled afterwards, as {@link drainBatches}
 * reschedules its remainder.
 *
 * Page-proof like every dispatch: the payload is composed by
 * {@link buildBatchPayload} from own properties and rendered and dispatched by
 * {@link postFrame}, which never throws.
 *
 * @example
 * // The capture's last event is too large to post: `flush()` drops it, then
 * // posts `{ events: [], batchSeq: n, droppedCount: 1, captureId, ... }`.
 */
function deliverLossReport(): void {
  if (
    ringCount !== 0 ||
    pendingDropped <= 0 ||
    !bridgeAvailable ||
    delivering ||
    currentCaptureId === undefined
  ) {
    return;
  }

  const epoch = captureEpoch;
  const resets = resetGeneration;
  const generation = bridgeReadyGeneration;
  const reportedDropped = pendingDropped;

  let outcome: FrameOutcome;
  delivering = true;
  try {
    // A fresh literal rather than a shared constant, so the payload owns the
    // array it carries; an empty literal calls nothing a page can replace.
    outcome = postFrame('telemetry.batch', buildBatchPayload([]));
  } finally {
    delivering = false;
  }

  if (captureEpoch !== epoch) {
    // The report belongs to the capture that ended while the bridge held it.
    if (outcome === 'sent' && resetGeneration === resets) {
      batchesTotal += 1;
    }
    if (outcome === 'unclaimed') {
      noteUnclaimedBatch(generation);
    }
  } else if (outcome === 'sent') {
    batchSeqCounter += 1;
    batchesTotal += 1;
    pendingDropped = pendingDropped > reportedDropped ? pendingDropped - reportedDropped : 0;
  } else if (outcome === 'unclaimed') {
    noteUnclaimedBatch(generation);
  }

  if (ringCount > 0) {
    // Events queued from inside the dispatch, while the latch turned their
    // drain away: they travel on the next turn, as a drain's remainder does.
    scheduleDrain();
  }
}

/*
 * ---------------------------------------------------------------------------
 * Inbound frames
 * ---------------------------------------------------------------------------
 */

/**
 * The closed inbound vocabulary, as a runtime list.
 *
 * Kept beside {@link BridgeInboundType} rather than derived from it, because a
 * type does not exist at runtime and the guard below needs a value to check
 * against. The two are checked against each other by the compiler: the array
 * is typed as a list of the union's members, so a member added to the type and
 * forgotten here is caught the moment a handler switches exhaustively on it.
 */
const BRIDGE_INBOUND_TYPES: readonly BridgeInboundType[] = [
  'bridge.ready',
  'bridge.gone',
  'bridge.pause',
  'bridge.resume',
  'agent.config',
  'agent.snapshot',
  'target.request',
];

/**
 * Whether a value is one of the seven frame types the bridge may send.
 *
 * An indexed loop of strict comparisons rather than `Array.prototype.includes`:
 * the guard runs long after the page's scripts have, and a page that replaced
 * `includes` could otherwise widen the vocabulary this module admits.
 */
function isBridgeInboundType(value: unknown): value is BridgeInboundType {
  if (typeof value !== 'string') {
    return false;
  }
  for (let index = 0; index < BRIDGE_INBOUND_TYPES.length; index += 1) {
    if (BRIDGE_INBOUND_TYPES[index] === value) {
      return true;
    }
  }
  return false;
}

/**
 * A fresh record with no prototype at all.
 *
 * @param intrinsics The captured intrinsics.
 * @returns An empty null-prototype record.
 */
function nullPrototypeRecord(intrinsics: ChannelIntrinsics): Record<string, unknown> {
  return intrinsics.apply(intrinsics.createObject, undefined, [null]);
}

/**
 * Whether a parsed JSON value is a record — an object that is not an array.
 *
 * `JSON.parse` produces only plain objects, arrays and primitives, so a
 * non-null, non-array object here is a plain record by construction.
 *
 * @param intrinsics The captured intrinsics.
 * @param value The parsed value.
 */
function isParsedRecord(intrinsics: ChannelIntrinsics, value: unknown): value is object {
  return (
    typeof value === 'object' &&
    value !== null &&
    !intrinsics.apply(intrinsics.isArray, undefined, [value])
  );
}

/**
 * Rebuild one parsed record as a null-prototype record with the same own keys.
 *
 * The `JSON.parse` reviver of the inbound guard, so it runs bottom-up over
 * every object in a frame: nested records are rebuilt before their holder
 * copies them. The point is what a *missing* key reads as. A plain object
 * inherits from `Object.prototype`, which a page can extend after
 * `document_start`; `'captureId' in payload` or `payload.hooks.fetch` would
 * then read the page's value wherever the bridge sent none. On a
 * null-prototype record a missing key is simply absent. Arrays and primitives
 * are returned as they are.
 *
 * Keys are copied with an indexed loop over the captured `Object.keys`, never
 * with an iterator or `for…in`, both of which a page can influence. A key
 * named `__proto__` in the JSON becomes an ordinary own key here, because a
 * null-prototype record has no `__proto__` setter to invoke.
 *
 * @param intrinsics The captured intrinsics.
 * @param value The value `JSON.parse` has just produced.
 * @returns The value, with a record rebuilt on a null prototype.
 */
function reviveNullPrototype(intrinsics: ChannelIntrinsics, value: unknown): unknown {
  if (!isParsedRecord(intrinsics, value)) {
    return value;
  }

  const source = value as Record<string, unknown>;
  const revived = nullPrototypeRecord(intrinsics);
  const keys = intrinsics.apply(intrinsics.ownKeys, undefined, [source]);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== undefined) {
      revived[key] = source[key];
    }
  }
  return revived;
}

/**
 * Decide whether a {@link BRIDGE_FRAME_EVENT} carries a frame from the bridge,
 * and normalise it if it does.
 *
 * Reached only through the listener on the channel node, which only the bridge
 * can dispatch on — possession of the node is the authentication, and the
 * checks below are about *well-formedness*: a bridge from another build, a
 * frame from the wrong direction, a truncated or hostile string. So a frame is
 * accepted only when its `detail`, read through the captured getter, is a
 * string of at most {@link MAX_MESSAGE_BYTES} code units that the captured
 * `JSON.parse` turns into a record carrying exactly {@link BRIDGE_SOURCE_TAG},
 * exactly {@link CHANNEL_VERSION} and a member of the closed inbound
 * vocabulary. The size is checked before anything is parsed, so an oversize
 * string costs one comparison.
 *
 * The result is built field by field: nothing but `source`, `version`, `type`
 * and `payload` is carried, and a payload that is not a record becomes an
 * empty null-prototype record, so a handler reading `payload.something` can
 * neither throw on `undefined` nor read an inherited value. Nothing in an
 * accepted frame is ever called or evaluated.
 *
 * @param intrinsics The captured intrinsics.
 * @param event The dispatched event, whatever its constructor.
 * @returns The accepted frame, or `undefined` to drop it in silence.
 */
function acceptFrame(
  intrinsics: ChannelIntrinsics,
  event: Event,
): BridgeInboundMessage | undefined {
  // The captured getter throws for an event that is not a `CustomEvent`, and
  // the caller treats a throw as a drop.
  const detail: unknown = intrinsics.apply(intrinsics.readDetail, event, []);
  if (typeof detail !== 'string' || detail.length > MAX_MESSAGE_BYTES) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = intrinsics.apply(intrinsics.parse, undefined, [
      detail,
      (_key: string, value: unknown): unknown => reviveNullPrototype(intrinsics, value),
    ]);
  } catch {
    return undefined;
  }
  if (!isParsedRecord(intrinsics, parsed)) {
    return undefined;
  }

  const frame = parsed as Record<string, unknown>;
  if (frame['source'] !== BRIDGE_SOURCE_TAG || frame['version'] !== CHANNEL_VERSION) {
    return undefined;
  }

  const type = frame['type'];
  if (!isBridgeInboundType(type)) {
    return undefined;
  }

  const payload = frame['payload'];
  return {
    source: BRIDGE_SOURCE_TAG,
    version: CHANNEL_VERSION,
    type,
    payload: isParsedRecord(intrinsics, payload)
      ? (payload as Record<string, unknown>)
      : nullPrototypeRecord(intrinsics),
  };
}

/**
 * Handle one accepted frame: update bridge presence, then dispatch.
 *
 * The order is deliberate. Presence and the drain it triggers come first, so
 * that events buffered under the outgoing configuration leave before a handler
 * can reconfigure the transport — an `agent.config` for a new capture would
 * otherwise renumber the sequence out from under events still queued from the
 * previous one.
 *
 * Runs synchronously inside the bridge's own `dispatchEvent`, so the drain it
 * starts dispatches batches back to the bridge from inside the bridge's
 * dispatch; and when this frame itself arrived from inside one of *this*
 * module's dispatches, the drain is deferred to the one already running (see
 * {@link drainBatches}). Every accepted `bridge.ready` advances
 * {@link bridgeReadyGeneration}, including one that finds the bridge already
 * marked present — a reconnect the agent never saw a `bridge.gone` for.
 *
 * **Flow control** (see the module notes). `bridge.pause` sets
 * {@link flowPaused} and clears the flush timer; `bridge.resume` clears it and
 * drains at once, bounded like the bridge's return; `bridge.ready` and
 * `bridge.gone` clear it, being a new port and the end of one. Like every
 * frame but `bridge.gone`, either signal is also evidence that the bridge is
 * there. Both are consumed here: acknowledged, and delivered to no subscriber,
 * so `./agent.ts` never mistakes a resume for a reconnect.
 *
 * Subscribers are dispatched from a snapshot, so a handler that unsubscribes
 * (or subscribes) while being called does not disturb the iteration, and each
 * one is called inside its own guard: a subscriber that throws costs itself
 * and not the frame. The snapshot is a linked list of null-prototype links
 * (see {@link snapshotSubscribers}) and each handler is called directly — no
 * `Array.from`, no iterator, no `Function.prototype.call` — so nothing the page
 * can replace is ever handed a subscriber, which is what keeps the handler
 * that applies an `agent.config` out of a page script's reach.
 *
 * @param message The accepted frame.
 */
function handleInbound(message: BridgeInboundMessage): void {
  const type = message.type;
  if (type === 'bridge.gone') {
    bridgeAvailable = false;
    // The pause was the departed port's; the next port starts unpaused.
    flowPaused = false;
    clearFlushTimer();
  } else {
    if (type === 'bridge.ready') {
      bridgeReadyGeneration += 1;
      // A new runtime port, for which the worker holds no pause.
      flowPaused = false;
    } else if (type === 'bridge.pause') {
      flowPausesTotal += 1;
      flowPaused = true;
      // An armed timer could only find the agent held back.
      clearFlushTimer();
    } else if (type === 'bridge.resume') {
      flowResumesTotal += 1;
      flowPaused = false;
    }
    const returning = !bridgeAvailable;
    bridgeAvailable = true;
    if (returning || type === 'bridge.resume') {
      try {
        // Bounded, and for the same reason the threshold path is: a queue that
        // waited out a service-worker suspension, or a backed-up lane, holds
        // up to {@link MAX_BUFFERED_EVENTS} events, and dispatching all
        // twenty-five batches of them inside the bridge's one dispatch would
        // be a long task on the page's main thread. The first batches still
        // travel here — recovery stays immediate — and the remainder is
        // rescheduled turn by turn. A `bridge.pause` that finds the bridge
        // away marks it present and drains nothing.
        drainBatches(MAX_BATCHES_PER_DRAIN);
      } catch {
        // The queue survives a failed drain and the next one retries.
      }
    }
  }

  if (type === 'bridge.pause' || type === 'bridge.resume') {
    // The transport's own frames: nothing outside this module acts on them.
    return;
  }

  for (let link = snapshotSubscribers(); link !== undefined; link = link.next) {
    // Read into a local and called as a plain function: `link.handler(…)`
    // would run the handler with the snapshot link as `this`.
    const handler = link.handler;
    try {
      handler(message);
    } catch {
      // A subscriber's failure is its own; the remaining subscribers still see
      // the frame.
    }
  }
}

/**
 * The link holding `handler`, with the link before it.
 *
 * A linear walk: the registry holds `./agent.ts`'s one handler in production
 * and a handful in the suites, and identity is the membership test a `Set`
 * applied, so registering one handler twice is still one registration.
 *
 * @param handler The handler to find.
 * @returns The link and its predecessor, or `undefined` when not registered.
 */
function findSubscriber(
  handler: (message: BridgeInboundMessage) => void,
): { link: SubscriberLink; previous: SubscriberLink | undefined } | undefined {
  let previous: SubscriberLink | undefined;
  for (let link = subscriberHead; link !== undefined; link = link.next) {
    if (link.handler === handler) {
      return { link, previous };
    }
    previous = link;
  }
  return undefined;
}

/**
 * Register a handler at the tail, unless it is already registered.
 *
 * @param handler The handler.
 */
function addSubscriber(handler: (message: BridgeInboundMessage) => void): void {
  if (findSubscriber(handler) !== undefined) {
    return;
  }

  const link = createNullRecord<SubscriberLink>();
  link.handler = handler;
  link.next = undefined;

  if (subscriberTail === undefined) {
    subscriberHead = link;
  } else {
    subscriberTail.next = link;
  }
  subscriberTail = link;
  subscriberCount += 1;
}

/**
 * Unregister a handler, if it is registered.
 *
 * The unlinked link keeps its own `next`, so a fan-out walking a snapshot is
 * unaffected — it never walks the registry's links in the first place.
 *
 * @param handler The handler.
 */
function removeSubscriber(handler: (message: BridgeInboundMessage) => void): void {
  const found = findSubscriber(handler);
  if (found === undefined) {
    return;
  }

  const { link, previous } = found;
  if (previous === undefined) {
    subscriberHead = link.next;
  } else {
    previous.next = link.next;
  }
  if (subscriberTail === link) {
    subscriberTail = previous;
  }
  subscriberCount -= 1;
}

/** Unregister every handler. */
function clearSubscribers(): void {
  subscriberHead = undefined;
  subscriberTail = undefined;
  subscriberCount = 0;
}

/**
 * Copy the registry into a fresh chain of null-prototype links.
 *
 * The same snapshot semantics `Array.from(set)` gave the fan-out: a handler
 * registered while a frame is being delivered first hears the next frame, and
 * one unregistered during delivery still hears this one. The copy is taken
 * with a `for` over `next` and one literal per link — no array, no iterator
 * and no call the page could have replaced.
 *
 * @returns The first link of the copy, or `undefined` when nothing is registered.
 */
function snapshotSubscribers(): SubscriberLink | undefined {
  let head: SubscriberLink | undefined;
  let tail: SubscriberLink | undefined;
  for (let link = subscriberHead; link !== undefined; link = link.next) {
    const copy = createNullRecord<SubscriberLink>();
    copy.handler = link.handler;
    copy.next = undefined;
    if (tail === undefined) {
      head = copy;
    } else {
      tail.next = copy;
    }
    tail = copy;
  }
  return head;
}

/**
 * The channel node's {@link BRIDGE_FRAME_EVENT} listener: accept, acknowledge,
 * handle.
 *
 * The acknowledgement — the captured `preventDefault()` — is given as soon as
 * the frame is accepted and before it is handled, because it means "the agent
 * took this frame", not "every subscriber succeeded"; a frame that fails the
 * guard is left unacknowledged, so the bridge can tell it was not taken.
 * Nothing here can throw into the bridge's dispatch.
 *
 * @param event The dispatched event.
 */
function receiveBridgeFrame(event: Event): void {
  const intrinsics = CHANNEL_INTRINSICS;
  if (intrinsics === undefined) {
    return;
  }

  let message: BridgeInboundMessage | undefined;
  try {
    message = acceptFrame(intrinsics, event);
  } catch {
    // An event that is not a `CustomEvent`, or a reviver that met something
    // it could not copy, is a frame that was never sent.
    return;
  }
  if (message === undefined) {
    return;
  }

  try {
    intrinsics.apply(intrinsics.preventDefault, event, []);
  } catch {
    // An event that cannot be cancelled is still a frame the agent accepted.
  }

  try {
    handleInbound(message);
  } catch {
    // `handleInbound` guards its own steps; this is the structural backstop
    // for "nothing throws into the bridge's dispatch".
  }
}

/*
 * ---------------------------------------------------------------------------
 * The channel node and the handshake
 *
 * Everything below implements the exchange documented in the module
 * overview, which is where a bridge author reads it. Three properties are what
 * make it worth having, and each one is a decision taken here rather than a
 * consequence of the mechanism:
 *
 * 1. The node is **document-scoped and private**: created once, never
 *    inserted, never published, surviving every reset.
 * 2. It is disclosed **at most once**, in answer to the first request, with
 *    the latch set and the request listener removed before the answer is
 *    dispatched.
 * 3. Every listener is installed and removed with the **captured** methods,
 *    so a page wrapper sees none of them and cannot refuse their removal.
 * ---------------------------------------------------------------------------
 */

/**
 * The tag of the channel node.
 *
 * An ordinary `div`: creating one runs no page code (unlike a custom-element
 * name the page may have defined), it has no behaviour of its own, and a
 * detached one is never rendered, observed by a `MutationObserver` or reached
 * by a selector.
 */
const CHANNEL_NODE_TAG = 'div';

/**
 * Whether the channel is open: a node exists and the handshake has handed it
 * to the bridge.
 *
 * Until it is, no bridge can hold the node, so a frame dispatched on it could
 * reach nobody — which is why {@link postControl} dispatches nothing and
 * counts nothing before this is true.
 */
function isChannelOpen(): boolean {
  return CHANNEL_INTRINSICS !== undefined && channelNode !== undefined && handshakeAnswered;
}

/**
 * The document's channel node, created on first use with the captured
 * `createElement`.
 *
 * @param intrinsics The captured intrinsics.
 * @returns The node, or `undefined` in a host with no document.
 */
function ensureChannelNode(intrinsics: ChannelIntrinsics): EventTarget | undefined {
  if (channelNode !== undefined) {
    return channelNode;
  }
  if (typeof document === 'undefined') {
    return undefined;
  }

  const node: EventTarget = intrinsics.apply(intrinsics.createElement, document, [
    CHANNEL_NODE_TAG,
  ]);
  channelNode = node;
  return node;
}

/**
 * Answer the first — and only the first — handshake request.
 *
 * The order of the three statements is the security property: the latch is
 * set and the listener removed *before* the answer is dispatched, so a handler
 * that dispatches a second request from inside the first answer finds the
 * exchange already closed. Doing it afterwards would make the bound "one
 * request per synchronous turn" instead of "one request per document".
 *
 * The answer is a `MouseEvent` built with the captured constructor, whose
 * `relatedTarget` is the node, dispatched on `window` with the captured
 * `dispatchEvent`. It is neither bubbling nor cancelable and carries nothing
 * else.
 */
function answerHandshakeRequest(): void {
  const intrinsics = CHANNEL_INTRINSICS;
  const node = channelNode;
  if (
    handshakeAnswered ||
    intrinsics === undefined ||
    node === undefined ||
    typeof window === 'undefined'
  ) {
    return;
  }

  handshakeAnswered = true;
  try {
    removeHandshakeRequestListener();
  } catch {
    // The latch is already set, so a listener that somehow survived answers
    // nothing: `answerHandshakeRequest` returns at its first check.
  }

  try {
    // A null-prototype init dictionary, for the reason given in
    // {@link postFrame}: the constructor reads members the record lacks, and
    // on an ordinary object those reads reach `Object.prototype`, where a
    // getter would be handed the dictionary and with it the node.
    const init = createNullRecord<MouseEventInit>();
    init.relatedTarget = node;
    init.bubbles = false;
    init.cancelable = false;
    const answer = new intrinsics.MouseEvent(HANDSHAKE_OFFER_EVENT, init);
    intrinsics.apply(intrinsics.windowDispatchEvent, window, [answer]);
  } catch {
    // A refused dispatch leaves this document without a bridge until it
    // reloads; it must never surface in the developer's application.
  }
}

/**
 * Install the request listener, if this document still has an answer to give.
 *
 * Nothing is installed once the exchange is latched: a listener that could
 * only ignore what it hears is a listener on the developer's `window` for no
 * reason, and this module's contract is that it leaves none it does not need.
 *
 * @param intrinsics The captured intrinsics.
 */
function installHandshakeRequestListener(intrinsics: ChannelIntrinsics): void {
  if (
    handshakeRequestListener !== undefined ||
    handshakeAnswered ||
    channelNode === undefined ||
    typeof window === 'undefined'
  ) {
    return;
  }

  const listener: EventListener = (): void => {
    answerHandshakeRequest();
  };
  intrinsics.apply(intrinsics.windowAddEventListener, window, [HANDSHAKE_REQUEST_EVENT, listener]);
  handshakeRequestListener = listener;
}

/**
 * Remove the request listener, if one is installed.
 *
 * The reference is cleared only after the removal returns, so a removal that
 * failed is still known and the next call tries again.
 */
function removeHandshakeRequestListener(): void {
  const listener = handshakeRequestListener;
  const intrinsics = CHANNEL_INTRINSICS;
  if (listener === undefined) {
    return;
  }

  if (intrinsics !== undefined && typeof window !== 'undefined') {
    intrinsics.apply(intrinsics.windowRemoveEventListener, window, [
      HANDSHAKE_REQUEST_EVENT,
      listener,
    ]);
  }
  handshakeRequestListener = undefined;
}

/**
 * Open the channel for the current subscribers: create the node on first use,
 * listen on it for bridge frames, and — while the handshake is unanswered —
 * listen on `window` for the one request that will be answered.
 *
 * Called by every {@link subscribe} and idempotent past the first: the node
 * and the latch are document-scoped, so the re-subscribe `./agent.ts` performs
 * after every disarm re-installs the frame listener on the same node and never
 * re-opens the handshake.
 */
function installChannelListeners(): void {
  const intrinsics = CHANNEL_INTRINSICS;
  if (intrinsics === undefined) {
    return;
  }

  const node = ensureChannelNode(intrinsics);
  if (node === undefined) {
    return;
  }

  if (bridgeFrameListener === undefined) {
    const listener: EventListener = (event: Event): void => {
      receiveBridgeFrame(event);
    };
    intrinsics.apply(intrinsics.addEventListener, node, [BRIDGE_FRAME_EVENT, listener]);
    bridgeFrameListener = listener;
  }

  installHandshakeRequestListener(intrinsics);
}

/**
 * Remove the node's frame listener, if one is installed.
 *
 * The node itself is kept (see {@link channelNode}); without a listener on it
 * a bridge frame is simply unacknowledged, which is how the bridge learns that
 * nothing on this side is subscribed.
 */
function removeBridgeFrameListener(): void {
  const listener = bridgeFrameListener;
  const intrinsics = CHANNEL_INTRINSICS;
  const node = channelNode;
  if (listener === undefined) {
    return;
  }

  if (intrinsics !== undefined && node !== undefined) {
    intrinsics.apply(intrinsics.removeEventListener, node, [BRIDGE_FRAME_EVENT, listener]);
  }
  bridgeFrameListener = undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Producer failure reporting
 *
 * A producer callback runs inside the page's own call stack, so it contains
 * everything it can go wrong with and returns quietly. That containment is
 * what keeps the agent from breaking the application it observes, and on its
 * own it also means a capture can lose a whole signal — every React commit,
 * every interaction — while both UIs show a capture that succeeded.
 *
 * AAP 0.5.5 does not allow that: a signal the agent could not deliver is
 * reported, so the analysis is drawn from evidence somebody said was
 * incomplete. This section is the one place that reporting happens, and it is
 * here rather than in `./agent.ts` because the producers cannot import
 * `./agent.js` (a cycle) and AAP 0.7.1 fixes the file list of this directory,
 * so there is no third module to put it in. This one already owns the channel,
 * the `agent.error` frame type and the capture identity a report has to carry.
 * ---------------------------------------------------------------------------
 */

/**
 * Bound one free-text field of a failure report.
 *
 * Trimmed, truncated and stripped of control characters, because the value
 * ends up in a frame the panel renders as text.
 *
 * Built from indexed reads of the primitive and string comparisons only, so
 * the page's string iterator, `codePointAt` and `trim` are never asked what
 * the field says. The text is the one the iterator-and-`trim` formulation
 * produced: code points are walked in order (a surrogate pair is one), each
 * control character (U+0000–U+001F, U+007F) becomes a space, the walk stops
 * once {@link MAX_FAILURE_FIELD_CHARS} code units are written, and leading and
 * trailing white space is removed exactly as `String.prototype.trim` removes
 * it (see {@link isTrimmedSpace}).
 */
function boundFailureField(value: string): string {
  let cleaned = '';

  // Code-point iteration rather than a regular expression: the characters to
  // remove are the control range, and a control-character class is exactly
  // what `no-control-regex` exists to reject. Stopping at the bound also means
  // an absurdly long input is never scanned in full.
  let index = 0;
  while (index < value.length) {
    const width = isSurrogatePairAt(value, index) ? 2 : 1;
    const unit = value[index] ?? '';
    // A one-unit string below U+0020 is a C0 control. A pair starts with a
    // high surrogate, which is never below it and never U+007F.
    if (width === 1 && (unit < ' ' || unit === '\u007f')) {
      cleaned += ' ';
    } else {
      cleaned += width === 2 ? unit + (value[index + 1] ?? '') : unit;
    }
    index += width;
    if (cleaned.length >= MAX_FAILURE_FIELD_CHARS) {
      break;
    }
  }

  let first = 0;
  while (first < cleaned.length && isTrimmedSpace(cleaned[first] ?? '')) {
    first += 1;
  }
  let last = cleaned.length;
  while (last > first && isTrimmedSpace(cleaned[last - 1] ?? '')) {
    last -= 1;
  }

  let trimmed = '';
  for (let unit = first; unit < last; unit += 1) {
    trimmed += cleaned[unit] ?? '';
  }
  return trimmed;
}

/**
 * Whether one code unit is white space `String.prototype.trim` removes, once
 * the control characters are spaces.
 *
 * `trim` removes the ECMAScript WhiteSpace and LineTerminator code points.
 * The C0 ones among them (TAB, LF, VT, FF, CR) cannot survive
 * {@link boundFailureField}'s first pass, so what remains is U+0020, U+00A0,
 * U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF:
 * the space separators of the Unicode `Zs` category, the two line and
 * paragraph separators, and the byte-order mark. Every one is a single code
 * unit, so a surrogate is never removed.
 *
 * @param unit One code unit, as a one-unit string.
 */
function isTrimmedSpace(unit: string): boolean {
  return (
    unit === ' ' ||
    unit === '\u00a0' ||
    unit === '\u1680' ||
    (unit >= '\u2000' && unit <= '\u200a') ||
    unit === '\u2028' ||
    unit === '\u2029' ||
    unit === '\u202f' ||
    unit === '\u205f' ||
    unit === '\u3000' ||
    unit === '\ufeff'
  );
}

/**
 * Categorise a thrown value using this module's own closed vocabulary.
 *
 * Every value this returns is a literal from {@link REPORTABLE_ERROR_NAMES},
 * a literal from the fixed set `typeof` can produce, `'object'` or
 * `'unknown'`. **No string is ever copied out of the page.** That is a
 * stronger property than sanitizing one would be, and it is the property the
 * frame needs: a control frame passes no redaction boundary on its way to the
 * service (AAP 0.5.2 puts the redactor at telemetry *ingest*), so the only
 * safe rule is that the page contributes a *choice* between our strings and
 * never a string. A probe that assigned `e.name = 'SENSITIVE_SENTINEL'` to an
 * ordinary `Error` and threw it through a producer callback is what motivated
 * this: the old implementation returned `error.name` for anything
 * `instanceof Error`, so the sentinel reached `payload.error` unaltered.
 *
 * How a value is read, in order:
 *
 * - `null` / `undefined`, or any property read that throws (a `Proxy` with a
 *   hostile `get` trap): `'unknown'`.
 * - An `Error` or a `DOMException` — checked separately, because `DOMException`
 *   inherits from `Error` in current engines but a page is free to break either
 *   prototype chain — whose `name` is a member of
 *   {@link REPORTABLE_ERROR_NAMES}: that member. This is what distinguishes a
 *   structured clone the page refused (`DataCloneError`) from a fiber shape the
 *   diff could not read (`TypeError`), which is the field's diagnostic job.
 * - Any other `Error`, including one carrying an application-authored `name`:
 *   `'Error'`. The category is preserved; the string is discarded.
 * - Any other object: `'object'`. `constructor.name` is deliberately not read —
 *   it is as assignable as `name` and would reopen exactly this hole.
 * - A primitive (or a function): its `typeof`, which is itself a closed
 *   vocabulary the page cannot influence. Never its value.
 *
 * `message`, `stack`, `cause` and every other property are not read at all,
 * here or anywhere else in this reporter: those are where an exception carries
 * the application's own data — a rejected value, a URL, a row — and `errors.ts`
 * already carries real page errors down the path that is redacted.
 *
 * @param error The caught value, which may be anything a page can throw.
 * @returns One member of the vocabulary described above; `'unknown'` when
 * there is nothing readable.
 */
function failureTypeName(error: unknown): string {
  try {
    if (error === null || error === undefined) {
      return 'unknown';
    }

    if (error instanceof Error) {
      return reportableErrorName(error.name);
    }

    // A second, independent test: WebIDL makes `DOMException` an `Error`
    // subclass and current engines implement it that way, so the branch above
    // normally catches one — but this guard costs nothing and keeps a page that
    // has reassigned `DOMException.prototype.__proto__` (or an engine that
    // never linked the two) from demoting a real platform error to `'object'`.
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
      return reportableErrorName(error.name);
    }

    if (typeof error === 'object') {
      return 'object';
    }

    // A thrown primitive is described by its type, never by its value.
    return typeof error;
  } catch {
    // A proxy that throws on property access is still just an unknown failure.
    return 'unknown';
  }
}

/**
 * Turn an error's `name` into one of {@link REPORTABLE_ERROR_NAMES}.
 *
 * The membership test that makes {@link failureTypeName}'s guarantee true: a
 * recognised platform name is reported as itself, and anything else — an
 * application-assigned `name`, an empty string, a `name` that is not a string
 * at all because the property was overwritten — is reported as the generic
 * `'Error'` category.
 *
 * {@link boundFailureField} is deliberately **not** applied to the result: the
 * value is one of this file's own literals, so it is already ASCII, already
 * free of control characters and already far shorter than
 * {@link MAX_FAILURE_FIELD_CHARS}. Bounding it would imply to a reader that the
 * value might need bounding — that is, that it might have come from the page —
 * which is precisely the misreading this function exists to prevent.
 *
 * @param name The value of the error's `name` property, typed `unknown`
 * because the property is writable and a page may have put anything there.
 * @returns The matching vocabulary member, or `'Error'`.
 */
function reportableErrorName(name: unknown): string {
  // `in` over the null-prototype membership record, never `Set.prototype.has`:
  // the page's replacement could admit any string it chose.
  return typeof name === 'string' && name in REPORTABLE_ERROR_NAME_MEMBERSHIP ? name : 'Error';
}

/**
 * Run one teardown step under its own guard.
 *
 * {@link resetTransport} takes several independent actions, and this is what
 * makes the word "independent" true: a page that has replaced `clearTimeout`
 * or `removeEventListener` must not be able to stop the queue from being
 * emptied or the capture identity from being cleared, which together are what
 * "the transport accepts nothing until it is configured again" means.
 *
 * @param stage The step's identifier, for the failure report.
 * @param step The step. Whatever it throws is reported and contained.
 */
function teardownStep(stage: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    reportProducerFailure('transport', stage, error);
  }
}

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/**
 * Report that a producer's own code failed, as an `agent.error` frame.
 *
 * Called from the guards that contain a producer's failures — a commit
 * traversal that threw, a listener the page refused to remove, a prototype
 * slot that could not be restored. The call replaces nothing: the caller still
 * swallows the exception and still counts it in its own statistics. What this
 * adds is the statement to the service, so a capture that lost a signal is a
 * capture known to have lost it (AAP 0.5.5).
 *
 * Three properties make it safe to call from anywhere, including from inside a
 * commit callback and from teardown:
 *
 * 1. **It never throws.** The whole body is guarded, and the frame itself
 *    travels through {@link postControl}, which is guarded too.
 * 2. **It is bounded.** {@link MAX_PRODUCER_FAILURE_REPORTS} — one — frame per
 *    source per capture; every later failure of that source in that capture is
 *    counted in {@link getProducerFailureStats}'s `suppressed` instead. A
 *    producer failing on every one of a render storm's commits costs a single
 *    frame, not one per commit.
 * 3. **It carries no application data.** The source, the stage and a category
 *    for the thrown value chosen from this module's own closed vocabulary by a
 *    membership test — never a string copied out of the page. See
 *    {@link failureTypeName}: `name` is assignable, so even an error's type
 *    name is page-controlled until it has been matched against that list, and
 *    the message, the stack and the cause are never read at all.
 *
 * @param source Which producer failed. Reports are bounded per source, so a
 * broken producer never silences a working one.
 * @param stage A short, stable identifier for the step that failed
 * (`'listener-remove'`, `'commit-traversal'`), used to group reports.
 * @param error The caught value, if there is one. Only its type is read.
 * @param detail Extra fields for the frame — counts, signal names, identifiers
 * the developer needs. Sanitized by {@link postControl} like any payload, and
 * unable to shadow the frame's own keys.
 */
export function reportProducerFailure(
  source: ProducerFailureSource,
  stage: string,
  error?: unknown,
  detail?: Record<string, unknown>,
): void {
  try {
    const alreadyReported = producerFailureCounts[source] ?? 0;
    if (alreadyReported >= MAX_PRODUCER_FAILURE_REPORTS) {
      producerFailuresSuppressed += 1;
      return;
    }

    const occurrence = alreadyReported + 1;
    producerFailureCounts[source] = occurrence;
    producerFailuresReported += 1;

    const boundedStage = boundFailureField(stage);
    postControl('agent.error', {
      // Spread first: the frame's own vocabulary is not shadowable by a caller.
      ...(detail ?? {}),
      code: 'producer-failure',
      message: `the page agent's ${source} producer failed at ${boundedStage}`,
      sessionId: currentSessionId ?? null,
      captureId: currentCaptureId ?? null,
      source,
      stage: boundedStage,
      error: failureTypeName(error),
      occurrence,
      // The last frame this source gets in this capture; further failures of
      // the same source are counted and not posted. With a bound of one this is
      // true on the only frame a source posts, which is what the field is for:
      // a reader never has to wait to learn that the statement is complete.
      final: occurrence === MAX_PRODUCER_FAILURE_REPORTS,
    });
  } catch {
    // Reporting a failure must not become one. The counters above are the
    // fallback record, and `getProducerFailureStats()` still shows the attempt.
  }
}

/**
 * Stamp a draft and queue it for the bridge.
 *
 * The one entry point for every signal this folder produces. It completes the
 * draft into a `TelemetryEventIngress` — `id` (the draft's own, or a fresh
 * `evt_…`), `producerId` (this document's), `tier` (`browser`), `seq` (the
 * next in this capture) and, once the document has an estimate,
 * `clockOffsetMs` — sanitizes its attributes so the batch is certain to clone,
 * and queues it.
 *
 * **Outside a capture, nothing is kept.** With `enabled` false or no
 * `captureId`, this returns immediately without buffering, so a dormant agent
 * on a page the developer is merely browsing grows no memory and holds no
 * observation of their application. That is the same rule the Node preload
 * follows for spans outside a capture (AAP 0.5.1), and it is why
 * {@link postControl} — which must work before any capture exists — is a
 * separate function rather than a kind of event.
 *
 * Never throws: the agent runs inside the developer's own event handlers and
 * React commits, so a failure is counted in {@link TransportStats} and
 * swallowed.
 */
export function emit(draft: EventDraft): void {
  try {
    if (!acceptingEvents || currentCaptureId === undefined) {
      return;
    }
    acceptDraft(draft);
  } catch {
    // Unreachable in practice — `acceptDraft` guards its own body — and still
    // present, because "never throws into the page" is a guarantee this module
    // makes structurally rather than by inspection.
    recordUnpostable(1);
  }
}

/**
 * Stamp and queue a run of drafts, in order.
 *
 * What a React commit produces: one traversal yields a render draft per
 * component that rendered, and they belong to one moment. Emitting them
 * together consumes consecutive sequence numbers, which is what lets the
 * correlator order two renders that share a millisecond, and it takes the
 * capture gate once instead of once per draft.
 *
 * Each draft is still completed inside its own guard, so one bad draft costs
 * itself and not the commit.
 */
export function emitMany(drafts: readonly EventDraft[]): void {
  try {
    if (!acceptingEvents || currentCaptureId === undefined) {
      return;
    }
    // By index, never through the array iterator: the page's would be handed
    // the producer's drafts, and could rewrite them before they are stamped.
    // A hole is tested with the captured `Object.hasOwn` rather than read, so
    // no index accessor on `Array.prototype` is handed the array either; like
    // an `undefined` entry, it is a draft that cannot be stamped.
    const core = coreIntrinsics();
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = core.apply(core.hasOwn, undefined, [drafts, index]) ? drafts[index] : undefined;
      if (draft === undefined) {
        recordUnpostable(1);
        continue;
      }
      acceptDraft(draft);
    }
  } catch {
    // An exotic array from the page cannot break the commit it came from.
    recordUnpostable(1);
  }
}

/**
 * Dispatch a control frame to the bridge immediately, capture or no capture.
 *
 * Control frames are how the agent says things about itself rather than about
 * the application: `agent.ready` when it initialises (and again whenever the
 * bridge announces itself), `target.described` with an element descriptor the
 * panel asked for, and `agent.error` when something could not be done.
 *
 * **Nothing is dispatched before the handshake.** Until the bridge has asked
 * for the node no bridge can hold it, so a frame could reach nobody; it is
 * neither dispatched nor counted as lost. That is the fate of the
 * `agent.ready` `./agent.ts` announces at `document_start`, and it is by
 * design: the bridge's `bridge.ready` is the cue to re-announce, and that
 * announcement finds the channel open.
 *
 * The payload is sanitized on the way out, exactly as an event's attributes
 * are: a control frame is rendered to JSON like any other, and a descriptor
 * assembled from page data must not be the thing that fails to render. It is
 * then **bounded** — every string to {@link MAX_CONTROL_TEXT_LENGTH}, every
 * frame to {@link MAX_MESSAGE_BYTES} — because a control frame's fields are
 * page data (a URL, a selector, an element's text) whose length no page has to
 * justify. A frame the cap refuses is replaced by one fixed-size diagnostic
 * (see {@link noteControlFrameLoss}), never dispatched unmeasured and never
 * silently dropped; a frame the bridge does not claim is counted in
 * {@link TransportStats}'s `controlFramesDropped`.
 *
 * Nothing is queued and nothing is retried. A control frame is a statement
 * about a moment, and the bridge's own `bridge.ready` is the cue to restate
 * the one that matters.
 */
export function postControl(type: AgentOutboundType, payload: Record<string, unknown>): void {
  try {
    if (!isChannelOpen()) {
      return;
    }
    const bounded = boundControlPayload(sanitizeAttributes(payload));
    const outcome = postFrame(type, bounded);
    if (outcome !== 'sent') {
      noteControlFrameLoss(type, outcome);
    }
  } catch {
    // A control frame is never worth an exception in the page; the bridge will
    // learn the agent's state from the next `agent.ready`.
  }
}

/**
 * Subscribe to frames from the bridge.
 *
 * The first call opens the channel: it creates the document's detached
 * channel node, listens on it for {@link BRIDGE_FRAME_EVENT} and — while the
 * handshake is still unanswered — listens on `window` for the one
 * {@link HANDSHAKE_REQUEST_EVENT} that will be answered. The last unsubscribe
 * removes both listeners, so a fully detached agent leaves no listener on the
 * page's window and none on the node; a later subscribe re-installs the node
 * listener and never answers another request. The returned function is
 * idempotent and safe to call after {@link resetTransport}.
 *
 * The node itself is **not** a subscription: it belongs to the document and
 * survives every reset, so the bridge's reference stays valid across the
 * disarm and re-arm of a second capture (see {@link channelNode}).
 *
 * @param handler Called with each accepted frame. It must not throw — one that
 * does is contained, but it forfeits its own notification.
 * @returns The unsubscribe function.
 */
export function subscribe(handler: (message: BridgeInboundMessage) => void): () => void {
  try {
    addSubscriber(handler);
    installChannelListeners();
  } catch {
    // A host that refuses the node or the listener leaves the agent deaf
    // rather than broken; `getTransportStats().bridgeReady` stays false and
    // `./agent.ts` reports it.
  }

  return function unsubscribe(): void {
    try {
      removeSubscriber(handler);
      if (subscriberCount === 0) {
        removeBridgeFrameListener();
        removeHandshakeRequestListener();
      }
    } catch {
      // Nothing left to do: the handler is already unreachable.
    }
  };
}

/**
 * Apply the service's configuration for this tab.
 *
 * Called by `./agent.ts` with what it read out of an `agent.config` frame, and
 * again with `enabled: false` when the capture stops. Three things happen, in
 * this order, and the order is the contract:
 *
 * 1. **What is queued leaves under the identity it was recorded with.** A
 *    capture change, or a transition to disabled, flushes first — so a batch
 *    is never labelled with the capture that replaced the one it belongs to.
 * 2. **Events the bridge never took at a capture change are discarded**, not
 *    relabelled — including a batch the flush dispatched and the bridge did
 *    not claim, which custody has just put back in the queue. They are counted
 *    in {@link TransportStats}'s cumulative `dropped`, while the per-capture
 *    `droppedCount` restarts with the new capture, because that number
 *    describes a capture. A batch still in the bridge's hands when this runs —
 *    a configuration relayed from inside one of this module's own dispatches —
 *    is settled against the capture it was built for (see
 *    {@link captureEpoch}).
 * 3. **The sequence restarts.** `seq` and `batchSeq` are scoped to the
 *    capture (see {@link nextSeq}), so a new `captureId` restarts both at
 *    zero. An identical `captureId` — the same configuration re-sent after a
 *    reconnect, which the bridge is expected to do — changes nothing, which is
 *    what makes re-configuration idempotent.
 *
 * This is the last step of an arm or a disarm, so it runs on the control
 * path's rules (see "Core intrinsics and page-proof primitives"): the three
 * fields are read as **own data properties** — a field the caller left out
 * reads as absent even when a page has defined an accessor of that name on
 * `Object.prototype` — and nothing here calls a method the page can replace.
 * A `captureId` that is not a string is no capture, and `enabled` is on only
 * when it is exactly `true`.
 *
 * The clock-offset estimate is not touched on any of these paths: it belongs to
 * the document, not to the capture (see {@link clockOffset}).
 */
export function configureTransport(config: TransportConfig): void {
  try {
    const core = coreIntrinsics();
    const requestedCaptureId = readOwnData(core, config, 'captureId');
    const requestedSessionId = readOwnData(core, config, 'sessionId');
    const nextCaptureId = typeof requestedCaptureId === 'string' ? requestedCaptureId : undefined;
    const nextSessionId = typeof requestedSessionId === 'string' ? requestedSessionId : undefined;
    const nextEnabled = readOwnData(core, config, 'enabled') === true;
    const captureChanged = nextCaptureId !== currentCaptureId;

    if (captureChanged || (acceptingEvents && !nextEnabled)) {
      flushNow();
    }

    if (captureChanged) {
      const abandoned = bufferedCount();
      if (abandoned > 0) {
        // Undeliverable, and no longer attributable: counted, not relabelled.
        droppedTotal += abandoned;
        clearBuffered();
      }
      seqCounter = 0;
      batchSeqCounter = 0;
      pendingDropped = 0;
      captureEpoch += 1;
      // Failure reports are bounded per capture for the same reason the
      // sequence is scoped to one: a new capture is a new statement about what
      // could and could not be collected (see MAX_PRODUCER_FAILURE_REPORTS).
      producerFailureCounts = createNullRecord();
    }

    currentSessionId = nextSessionId;
    currentCaptureId = nextCaptureId;
    acceptingEvents = nextEnabled;

    if (ringCount === 0) {
      clearFlushTimer();
    } else {
      scheduleFlush();
    }
  } catch {
    // Configuration is re-sent by the bridge after every reconnect, so a
    // failure here self-corrects rather than needing to be reported.
  }
}

/**
 * Dispatch everything queued right now, without waiting for the flush timer.
 *
 * `./agent.ts` calls this on `pagehide` — the last moment a document can hand
 * anything to the bridge — and when a capture stops, so the analysis runs on
 * the whole capture and not on the whole capture minus its final 250 ms. Loss
 * that no batch is left to carry is posted after the queue, as one event-less
 * loss report (see {@link flushNow}).
 *
 * A no-op while the bridge is away: the queue is kept and the arrival of
 * `bridge.ready` starts draining it. A flush that meets a batch the bridge
 * does not claim stops there, with that batch back at the front of the queue.
 * A `bridge.pause` does not hold it back: every caller is a moment with no
 * later turn to wait for (see "Flow control" in the module notes).
 */
export function flush(): void {
  try {
    flushNow();
  } catch {
    // The queue survives; a later flush retries.
  }
}

/**
 * Return the transport to the state it had before anything was configured.
 *
 * Called by `./agent.ts` on full detach, which is what an `agent.config` with
 * every hook false amounts to (AAP 0.5.1: "agent.config with all hooks false
 * returns the browser agent to dormant"). Afterwards the module holds no
 * events, no subscribers, no timer and no listener — none on the page's window
 * and none on the channel node — and {@link emit} accepts nothing until it is
 * configured again.
 *
 * The producer and document ids are **not** reset, and `./ids.ts` offers no
 * way to reset them: they identify the document, not the capture, and a second
 * producer id inside one document would split one sequence into two
 * incomparable halves.
 *
 * Neither is the channel node, nor the latch that records that the one
 * handshake request was answered — and for a sharper reason, because this
 * function runs at the end of *every* capture (`./agent.ts`'s `disarm()` calls
 * it and then immediately re-subscribes). Replacing the node here would leave
 * the bridge holding one this module no longer listens on, with no second
 * handshake coming, so the next `agent.config` would never arrive and the
 * document would be finished after one capture. See {@link channelNode}. What
 * *is* released are the listeners: the next {@link subscribe} re-installs the
 * node's, and the request listener only while the handshake is unanswered.
 *
 * Nor is the clock-offset estimate, for the producer id's reason: it describes
 * this document's clock, which a capture ending does not change, and the
 * samples behind it stay valid for the next capture. Clearing it would only
 * leave that capture's first events without an offset until the page made
 * another same-origin request. See {@link clockOffset}.
 *
 * Nor is a `bridge.pause` ({@link flowPaused}) or its counts: the pause
 * belongs to the bridge's runtime port, which a capture ending does not
 * replace, and the worker that sent it still holds this bridge paused — only
 * its `bridge.resume`, or the port's end or replacement, lets the next
 * capture's telemetry go. Clearing it here would let a new capture post into
 * a lane that is still backed up, and the worker would not ask again until
 * that lane had drained. See "Flow control" in the module notes.
 *
 * Every step stands in its own guard (see {@link teardownStep}). The listener
 * removals go through the captured methods, so a page cannot refuse them the
 * way it can refuse its own; `clearTimeout` still belongs to the page. Without
 * the per-step guard a single hostile or broken page API would leave
 * `acceptingEvents` true and `currentCaptureId` set — a "dormant" agent still
 * accepting events into a capture that has ended, which is precisely what AAP
 * 0.5.1's "disabled, not merely idled" forbids.
 *
 * What a failed step leaves behind is retained rather than forgotten:
 * {@link removeBridgeFrameListener} and {@link removeHandshakeRequestListener}
 * clear their references only after the removal returns, so a listener that
 * could not be removed is still known and the next call tries again. The
 * failure itself is reported as an `agent.error` frame with
 * `source: 'transport'`.
 */
export function resetTransport(): void {
  // Deliberately not wrapped as a whole: a failure in any one of these must
  // not skip the others. The page-owned steps come first so that a failure
  // there is reported while the capture identity is still on the frame.
  teardownStep('flush-timer-clear', () => {
    clearFlushTimer();
    // A scheduled drain is not cancellable, so the channel it would arrive on
    // is closed and the flag cleared: the task, if it still runs, finds an
    // empty queue and an absent bridge and does nothing.
    closeDrainChannel();
  });
  teardownStep('channel-listener-remove', () => {
    removeBridgeFrameListener();
  });
  // Its own step rather than a second statement in the one above: the two
  // removals are independent, and one that fails must not leave the other
  // listener installed.
  teardownStep('handshake-listener-remove', () => {
    removeHandshakeRequestListener();
  });
  teardownStep('subscribers-clear', () => {
    clearSubscribers();
  });
  teardownStep('buffer-clear', () => {
    releaseBuffer();
  });

  teardownStep('capture-state-reset', () => {
    currentSessionId = undefined;
    currentCaptureId = undefined;
    acceptingEvents = false;
    bridgeAvailable = false;
    reportingControlLoss = false;
    // A batch still in the bridge's hands — a reset reached from inside one of
    // this module's own dispatches — belongs to the capture this ends, and is
    // settled into none of the counters the next step zeroes.
    captureEpoch += 1;
    resetGeneration += 1;
  });

  teardownStep('counter-reset', () => {
    seqCounter = 0;
    batchSeqCounter = 0;
    pendingDropped = 0;
    droppedTotal = 0;
    sentTotal = 0;
    batchesTotal = 0;
    serializationFailureTotal = 0;
    controlFramesDroppedTotal = 0;
  });

  // Last, and only the per-capture allowance: the next capture reports afresh.
  // The cumulative totals in `getProducerFailureStats()` are deliberately kept
  // — the likeliest moment for a producer failure to be recorded is this very
  // teardown, and a reset that erased the reports it had just provoked would
  // leave a document that failed to detach looking like one that never tried.
  teardownStep('failure-allowance-reset', () => {
    producerFailureCounts = createNullRecord();
  });
}

/**
 * Fold one server response's `Date` header into this document's clock-offset
 * estimate: the server's `Date` header versus this document's local clock.
 *
 * `./fetch.ts` calls it where a same-origin request settles with a response the
 * dev server produced just then — a response carrying `Age` came from a cache
 * and states the clock of its original generation, so it is not offered. The
 * header is the server's clock at some instant between this document's two
 * readings, which is exactly what the estimator needs: an interval that
 * contains the offset (`../schema/clock-offset.ts`).
 *
 * Both instants must be readings of {@link nowEpochMs}, the clock this module's
 * events are stamped with. Reading `sentAt` earlier than the send, or
 * `receivedAt` later than the arrival, only widens the interval; it never makes
 * it exclude the true offset.
 *
 * Nothing is posted and no event is created or changed. The estimate only
 * decides what {@link completeDraft} stamps on events created from now on, and
 * it is taken with or without a capture, because the clock is the document's.
 *
 * Never throws into the page.
 *
 * @param dateHeader The response's raw `Date` value, or `null`/`undefined` when
 *   it carried none — which is no sample, and changes nothing. A value that is
 *   present but not a canonical IMF-fixdate is counted as a rejected sample.
 * @param sentAt This document's clock immediately before the request was sent.
 * @param receivedAt This document's clock when the response arrived.
 */
export function observeServerClock(
  dateHeader: string | null | undefined,
  sentAt: number,
  receivedAt: number,
): void {
  try {
    clockOffset.observeHttpDate(dateHeader, sentAt, receivedAt);
  } catch (error: unknown) {
    // The estimator performs no I/O and throws for no input, so this is not
    // expected to run. It is guarded anyway because this runs inside the
    // application's own promise chain and XHR listeners, where an escaping
    // exception would be the page's; the lost sample costs only precision and
    // is reported like every contained producer failure.
    reportProducerFailure('transport', 'clock-sample', error);
  }
}

/**
 * A snapshot of the transport's counters.
 *
 * Cheap enough to call on every render of a diagnostics view: it reads
 * module-scope numbers and allocates one small object, with no copy of the
 * queue and no traversal of anything.
 */
export function getTransportStats(): TransportStats {
  return {
    buffered: bufferedCount(),
    dropped: droppedTotal,
    sent: sentTotal,
    batches: batchesTotal,
    seq: seqCounter,
    bridgeReady: bridgeAvailable,
    serializationFailures: serializationFailureTotal,
    controlFramesDropped: controlFramesDroppedTotal,
  };
}

/**
 * A snapshot of the channel's flow control: whether the bridge holds the
 * agent's telemetry back right now, and how many `bridge.pause` and
 * `bridge.resume` frames this document has accepted.
 *
 * Its own function rather than members of {@link TransportStats}, whose
 * numbers {@link resetTransport} zeroes with the capture: these describe the
 * bridge's connection and survive a reset (see "Flow control" in the module
 * notes). Events evicted while the agent was held back are in
 * {@link TransportStats}'s `dropped`, like every other eviction.
 *
 * @returns A fresh snapshot.
 */
export function getFlowControlStats(): FlowControlStats {
  return {
    paused: flowPaused,
    pauses: flowPausesTotal,
    resumes: flowResumesTotal,
  };
}

/**
 * A snapshot of what {@link reportProducerFailure} has said.
 *
 * Both numbers are cumulative for the document and survive
 * {@link resetTransport}: they are the record that a producer failed, and
 * teardown is one of the moments that record gets written. `suppressed`
 * standing above zero means a producer failed repeatedly and the channel
 * declined to repeat it — the signal named in the posted frames should be
 * treated as absent from the capture rather than merely thinned.
 */
export function getProducerFailureStats(): ProducerFailureStats {
  return {
    reported: producerFailuresReported,
    suppressed: producerFailuresSuppressed,
  };
}

/**
 * A snapshot of this document's clock-offset estimate: the value the next
 * event will be stamped with (`offsetMs`), the interval it is the midpoint of,
 * and how many samples were accepted, restarted the estimate or were rejected.
 *
 * Its own function rather than members of {@link TransportStats}, whose numbers
 * describe the queue and the channel: this one describes the document's clock,
 * survives {@link resetTransport} and a capture change alike, and is shaped by
 * `../schema/clock-offset.ts` so both producers report it identically.
 *
 * @returns A fresh, frozen snapshot.
 */
export function getClockOffsetStats(): ClockOffsetSnapshot {
  return clockOffset.snapshot();
}
