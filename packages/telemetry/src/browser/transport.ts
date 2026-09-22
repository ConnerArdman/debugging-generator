/**
 * Transport: the page agent's only way out, and the single place a telemetry
 * event is stamped.
 *
 * Every other module in this folder observes one thing — an interaction, a
 * React commit, a request, a performance entry, an error, a state
 * transition — builds an {@link EventDraft} for it and hands that draft to
 * {@link emit}. Nothing else in the agent touches `window.postMessage`, an
 * event id, the producer id, the `tier` field or the per-producer sequence
 * number. That concentration is the point: a producer cannot get the stamping
 * contract wrong if it never performs it, and a sibling module that assigns
 * `producerId`, `seq`, `tier` or an id of its own is a bug to be removed
 * rather than a style choice.
 *
 * ## The page↔bridge channel (this module defines it)
 *
 * The agent runs in the **MAIN world** of the inspected page and has no
 * extension APIs at all: no `chrome.runtime`, no socket, no storage. Its only
 * neighbour is the isolated-world content script
 * (`apps/chrome-extension/src/content/bridge.ts`), which shares the page's
 * `window` and therefore its `message` event loop, and which does hold a
 * `chrome.runtime` port to the service worker. Both sides of that channel are
 * defined here, in one frame shape and two closed type vocabularies, because
 * the bridge and the service worker are written against this file.
 *
 * ```text
 * page agent  --window.postMessage({source:'debuggen-agent',version:1,...},'/')-->  bridge
 * page agent  <--window.postMessage({source:'debuggen-bridge',version:1,...},'/')-- bridge
 *                                                                                     |
 *                                             chrome.runtime port (the bridge's job)  v
 *                                                                          service worker
 *                                                          (wraps batches into protocol
 *                                                           envelopes and adds tabId)
 * ```
 *
 * **Outbound**, the agent posts `{ source, version, type, payload }` — where
 * `source` is {@link AGENT_SOURCE_TAG} and `version` is
 * {@link CHANNEL_VERSION} — with a `targetOrigin` of `'/'`, meaning "this
 * window's own origin", which is correct even for an opaque origin, where
 * `location.origin` reads `"null"` and would not match. `'*'` is never used:
 * it would broadcast the developer's telemetry to any listener a page chose to
 * install.
 *
 * The four outbound types ({@link AgentOutboundType}):
 *
 * - `agent.ready` — the agent initialised. Payload:
 *   `{ documentId, producerId, url, installedBeforeReact, reactDetected }`.
 *   The bridge adds nothing; the service worker adds `tabId` and relays it, so
 *   the service can tell a fresh document from a reconnecting one (AAP 0.4.2).
 * - `telemetry.batch` — a batch of completed events. Payload:
 *   `{ events, producerId, documentId, captureId?, sessionId?, batchSeq,
 *   droppedCount }`, where `events` is a raw `TelemetryEventIngress[]`. The
 *   service worker is what turns that array into the protocol's
 *   `telemetry.event` message (AAP 0.4.2: "agent → SW (raw
 *   `{ events: TelemetryEventIngress[] }` over the bridge) → service (wrapped
 *   in the envelope by the SW)"), which is why no protocol type is named
 *   anywhere in this bundle.
 * - `target.described` — a descriptor for an element the panel asked about.
 * - `agent.error` — the agent could not do something, stated without any
 *   captured data in it.
 *
 * The five inbound types ({@link BridgeInboundType}):
 *
 * - `bridge.ready` — the bridge's listener is installed and its port is live.
 *   The bridge author sends this at `document_start` **and again after every
 *   service-worker reconnect**: a Manifest V3 worker suspends after roughly
 *   30 seconds of idleness, and until the bridge says it is back this module
 *   buffers rather than posts. It is also the cue for `./agent.ts` to re-post
 *   `agent.ready`, because a control message posted before the bridge's
 *   listener existed is simply lost — this module deliberately does not queue
 *   control messages, so that a dormant agent holds nothing.
 * - `bridge.gone` — the bridge's runtime port disconnected. Buffering resumes.
 * - `agent.config` — the service's hook configuration for this tab, relayed.
 *   `./agent.ts` reads it and calls {@link configureTransport}.
 * - `agent.snapshot` — a request for an on-demand snapshot (the component
 *   tree).
 * - `target.request` — the panel entered element-picker mode.
 *
 * **Inbound is a security boundary.** Any script the page loads can post a
 * message to `window`, so {@link subscribe}'s listener accepts a frame only
 * when *all* of `event.source === window`, the origin is this document's own
 * (or the empty/`"null"` origin an opaque-origin document reports),
 * `event.data` is a non-null object, `data.source` is exactly
 * {@link BRIDGE_SOURCE_TAG}, `data.version` is exactly
 * {@link CHANNEL_VERSION} and `data.type` is a member of the closed inbound
 * vocabulary. Everything else is dropped in silence — no logging, which would
 * itself be a channel — and no field of an accepted frame is ever called,
 * evaluated or trusted as a function.
 *
 * ## Invariants
 *
 * **1. No side effects at import time.** No listener, no timer, no
 * `postMessage` at module scope. The `message` listener is installed by the
 * first {@link subscribe} and removed by the last unsubscribe; the flush timer
 * starts on the first enqueue, the queue allocates its first slots with the
 * first event and the drain channel is created with the first scheduled drain.
 * `./agent.ts` is the one module in this folder allowed to act when it is
 * evaluated.
 *
 * **2. Nothing throws into the page.** Every exported function wraps its body:
 * the agent runs inside the developer's own click handlers and React commits,
 * where an exception escaping would break the application it is observing. A
 * failure is counted in {@link TransportStats} and swallowed.
 *
 * **3. Nothing leaves that cannot be structure-cloned.** `postMessage`
 * structure-clones its payload, so one function, symbol, DOM node, `Proxy` or
 * cyclic object in an attribute bag throws `DataCloneError` and would cost the
 * whole batch. Attributes are therefore rebuilt through a bounded sanitizer
 * before an event is buffered (see {@link emit}).
 *
 * **4. Only the producer fields are stamped.** `sessionId`, `captureId` and
 * `ingestSeq` are assigned by the service and rejected by the strict ingress
 * schema if a producer sends them; `redacted` is set by the service's redactor
 * at ingest. This module builds an event field by field rather than by
 * spreading a draft, so none of the four can reach the wire even from a
 * mistaken caller.
 *
 * **5. Nothing costs the page more than a bounded amount of work per turn.**
 * The agent observes latency, so it must not create any. Three bounds together
 * make that structural rather than aspirational:
 *
 * - **The queue is a ring** ({@link enqueue}), so an event costs one slot
 *   write whether the queue holds one event or the full
 *   {@link MAX_BUFFERED_EVENTS}. Evicting the oldest event at the cap advances
 *   a head index; nothing is copied or shifted.
 * - **Delivery never runs on a producer's stack.** Reaching
 *   {@link MAX_EVENTS_PER_BATCH} schedules one drain on its own task (a
 *   `MessageChannel` message, the cheapest true task source a page has)
 *   instead of serialising a frame inside the click handler or React commit
 *   that produced the last event.
 * - **Every drain posts at most {@link MAX_BATCHES_PER_DRAIN} batches** and
 *   reschedules the remainder, so emptying a full queue is several short tasks
 *   rather than one long one. That applies to all three non-terminal
 *   routes — the batch threshold, the {@link FLUSH_INTERVAL_MS} timer and the
 *   bridge announcing itself after an absence — because each of them can find
 *   a queue of any depth, and a full one is twenty-five batches.
 * - **Unbounded, synchronous draining is kept for the terminal moments only**,
 *   the ones with no later turn to rely on: {@link flush} (`pagehide` and
 *   capture stop) and the capture change in {@link configureTransport}, where
 *   the alternative is not a slower delivery but no delivery at all — the
 *   document is going away, or the queued events are about to stop being
 *   attributable to the capture they were recorded under.
 *
 * **6. Every frame is measured before it is posted.** {@link MAX_MESSAGE_BYTES}
 * is enforced in {@link postFrame}, which is the only function that calls
 * `postMessage` — so it bounds control frames (an `agent.ready` carrying a
 * page-controlled URL, a `target.described` descriptor) exactly as it bounds a
 * telemetry batch. A batch over the cap is split; a control frame over it is
 * refused and replaced by one fixed-size diagnostic that cannot itself be
 * oversize and cannot trigger another.
 *
 * ## Imports: four modules, and why not a fifth
 *
 * `packages/telemetry/esbuild.agent.mjs` bundles this folder into the static
 * content script the Chrome extension copies verbatim, and it hard-fails on
 * any input resolving to a Node builtin, `@debuggen/protocol`,
 * `@debuggen/shared/node` or `zod`. So: `./ids.js` (import-free by
 * construction), `../schema/attributes.js` (imports only `../schema/kinds.js`,
 * both vocabulary-only), `../redaction/rules.js` (import-free by contract, for
 * the one code-point-safe {@link truncate} every bound in this repository goes
 * through — `./fiber-diff.ts` takes its previews from the same function, so a
 * value bounded here reads the same as one bounded there), and
 * `../schema/event.js` **for a type alone** — that
 * module value-imports `zod` and `@debuggen/shared`, and `import type` is
 * erased before esbuild ever sees the file, which is what lets the one
 * definition of {@link TelemetryEventIngress} be reused here instead of
 * restated. `@debuggen/shared`'s barrel is not imported in any form, not even
 * for a type, because its value imports would come with it if the `type`
 * keyword were ever dropped in a refactor.
 *
 * @module packages/telemetry/src/browser/transport
 */

import { truncate } from '../redaction/rules.js';
import { MAX_TRACKED_KEYS, type AttributeValueType } from '../schema/attributes.js';
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
 * The `source` tag on every frame the page agent posts.
 *
 * The bridge filters on it, and so does this module's own inbound guard in the
 * opposite direction: without a tag, the agent would read its own outbound
 * frames back (a window receives what it posts to itself) and a page's
 * unrelated `postMessage` traffic would reach the agent's subscribers.
 */
export const AGENT_SOURCE_TAG = 'debuggen-agent';

/**
 * The `source` tag the isolated-world bridge must put on every frame it posts
 * to the page.
 *
 * Deliberately different from {@link AGENT_SOURCE_TAG}: one shared tag would
 * make the two directions indistinguishable on a channel where both sides
 * receive everything.
 */
export const BRIDGE_SOURCE_TAG = 'debuggen-bridge';

/**
 * The channel version, carried on every frame in both directions and checked
 * exactly.
 *
 * The agent is a static content script copied out of this package's build and
 * the bridge is compiled into the extension, so the two can be shipped at
 * different moments (a reloaded extension against a page that was not
 * reloaded). An exact match is what makes that mismatch silent and harmless
 * instead of a stream of half-understood frames: a change to any payload shape
 * in this file is a version bump, and both sides then simply ignore each
 * other until the page reloads.
 */
export const CHANNEL_VERSION = 1;

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
 * {@link MAX_MESSAGE_BYTES} for ordinary events and keeps each structured
 * clone short enough not to show up as a long task of its own.
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
 * The largest frame this module will post, as measured by the length of its
 * JSON rendering.
 *
 * A code-unit count is an estimate of a byte count, not a byte count — one
 * non-ASCII character is one unit and several bytes — and it is deliberately
 * the cheap measure: it is taken on the page's own thread for every batch, and
 * the number it feeds is a safety valve rather than a quota. Chrome imposes no
 * documented `postMessage` size limit, but a multi-megabyte structured clone
 * is a long task in the page and a memory spike in the extension, so a batch
 * over this size is split instead (see {@link flush}).
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
 * a route and to redact its query values). Past it, the value is truncated by
 * the repository's one code-point-safe {@link truncate}, which marks what it
 * removed with a single ellipsis.
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
 * clone that refused a value (`DataCloneError`, the failure mode
 * {@link postFrame} exists to survive), a cross-origin or policy refusal
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

/*
 * ---------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------
 */

/**
 * What a producer builds: a telemetry event minus the four fields this module
 * stamps.
 *
 * `id` stays available as an optional override for the one producer that needs
 * to know an event's id before it emits it — a fetch wrapper that has to
 * reference the request span it is about to report. Omitting it is the norm.
 *
 * `producerId`, `seq` and `tier` are absent on purpose and cannot be supplied:
 * a document has exactly one producer id, one sequence and one tier, and all
 * three are this module's to assign (see {@link emit}).
 *
 * The optional members are declared to accept an explicit `undefined` as well
 * as absence, because the repository compiles with
 * `exactOptionalPropertyTypes` and a producer that computes a field
 * conditionally would otherwise have to build its draft with a conditional
 * spread.
 */
export type EventDraft = Omit<TelemetryEventIngress, 'id' | 'producerId' | 'seq' | 'tier'> & {
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
   * capture change the bridge was not present for, a frame the page refused to
   * clone, and events too large to post at all.
   */
  dropped: number;
  /** Events successfully posted, cumulative. */
  sent: number;
  /** `telemetry.batch` frames successfully posted, cumulative. */
  batches: number;
  /**
   * The sequence number the next stamped event will carry — equivalently, how
   * many events have been stamped in the current capture.
   */
  seq: number;
  /** Whether the bridge has announced itself and not gone away since. */
  bridgeReady: boolean;
  /**
   * Events that could not be rendered or posted at all, cumulative: a value
   * JSON refused, or a single event larger than {@link MAX_MESSAGE_BYTES}.
   * Also counted in {@link dropped}; this field says *why*.
   */
  serializationFailures: number;

  /**
   * Control frames refused before they were posted, cumulative: an
   * `agent.ready`, `target.described` or `agent.error` whose sanitized and
   * bounded payload still measured over {@link MAX_MESSAGE_BYTES}, or that the
   * page refused to clone.
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

/** The closed set of frame types the page agent posts. */
export type AgentOutboundType =
  'agent.ready' | 'telemetry.batch' | 'target.described' | 'agent.error';

/** The closed set of frame types the isolated-world bridge posts. */
export type BridgeInboundType =
  'bridge.ready' | 'bridge.gone' | 'agent.config' | 'agent.snapshot' | 'target.request';

/** A frame as the page agent posts it. */
export interface AgentOutboundMessage {
  /** Always {@link AGENT_SOURCE_TAG}. */
  source: typeof AGENT_SOURCE_TAG;
  /** Always {@link CHANNEL_VERSION}. */
  version: typeof CHANNEL_VERSION;
  /** Which frame this is. */
  type: AgentOutboundType;
  /** The frame's body, already sanitized for structured cloning. */
  payload: Record<string, unknown>;
}

/**
 * A frame as the bridge posts it, after this module's guard has accepted it.
 *
 * `version` is typed as a plain `number` because the field arrives from
 * outside; the guard admits only {@link CHANNEL_VERSION}, so a handler reading
 * an accepted message is reading that value.
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

/** Subscribers registered through {@link subscribe}. */
const subscribers = new Set<(message: BridgeInboundMessage) => void>();

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

/** Events dropped since the last successfully posted batch reported a count. */
let pendingDropped = 0;

/** Every event this document has dropped, for {@link TransportStats}. */
let droppedTotal = 0;

/** Every event this document has posted, for {@link TransportStats}. */
let sentTotal = 0;

/** Every batch this document has posted, for {@link TransportStats}. */
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
 */
const producerFailureCounts = new Map<ProducerFailureSource, number>();

/** Failure frames posted, cumulative, for {@link getProducerFailureStats}. */
let producerFailuresReported = 0;

/** Failures counted instead of posted, cumulative, for the same. */
let producerFailuresSuppressed = 0;

/** Whether the bridge has announced itself and not gone away since. */
let bridgeAvailable = false;

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

/** The single installed `message` listener, or `undefined` when none is. */
let messageListener: ((event: MessageEvent<unknown>) => void) | undefined;

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
 * `./state.ts` convert through them and never re-derive the arithmetic. The
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
  if (typeof clock.now !== 'function') {
    return undefined;
  }

  const relativeMs: unknown = (clock.now as () => unknown).call(performance);
  if (typeof relativeMs !== 'number' || !Number.isFinite(relativeMs)) {
    return undefined;
  }

  const origin = clock.timeOrigin;
  return {
    relativeMs,
    timeOrigin: typeof origin === 'number' && Number.isFinite(origin) ? origin : undefined,
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
  if (!Number.isFinite(value)) {
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
    if (!Number.isFinite(relativeMs)) {
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
 * or a cyclic object straight onto an attribute bag. That single value would
 * make `postMessage` throw `DataCloneError` and cost the whole batch — and the
 * ingress schema refuses functions and symbols as well — so every bag is
 * rebuilt here out of values that are certain to clone and certain to survive
 * a JSON round trip.
 *
 * Rebuilding rather than checking has a second effect worth stating: the
 * object that leaves is a fresh plain object with no getters, no prototype
 * chain and no `Proxy` traps, so nothing the page can define runs while the
 * frame is being cloned.
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

/** Whether a value is, or convincingly claims to be, a DOM node. */
function isDomNode(value: object): boolean {
  if (typeof Node !== 'undefined' && value instanceof Node) {
    return true;
  }
  // A node from another realm (an iframe's document) fails `instanceof`, and
  // a node is exactly the value that must not be serialised, so the duck test
  // is worth having.
  const candidate = value as { nodeType?: unknown; nodeName?: unknown };
  return typeof candidate.nodeType === 'number' && typeof candidate.nodeName === 'string';
}

/**
 * Whether a value is a plain object — an object literal or a null-prototype
 * bag — as opposed to a class instance, a `Map`, a `Date` or an `Error`.
 *
 * Only plain objects are walked. Everything else is tagged, because its
 * meaning lives in its prototype and a JSON rendering of it would be either
 * empty (`Error`, `Map`) or a lie.
 */
function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Sanitize one value, recursing into plain arrays and objects within the
 * depth and node budgets.
 *
 * @param value The value as the producer left it.
 * @param depth Container level of this value; 0 for a top-level attribute.
 * @param budget Shared node allowance for the whole bag.
 * @returns A clone-safe value, or {@link OMITTED}.
 */
function sanitizeValue(value: unknown, depth: number, budget: SanitizeBudget): unknown {
  budget.remaining -= 1;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      // `NaN` and `Infinity` survive a structured clone but become `null` in
      // JSON, and the event schema bounds the numeric fields that matter, so
      // the honest rendering of a non-finite number is its absence.
      return Number.isFinite(value) ? value : OMITTED;
    case 'undefined':
      return OMITTED;
    case 'bigint':
      // `JSON.stringify` throws on a bigint, which would cost the batch.
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
  if (isDomNode(container)) {
    return typeTag('dom');
  }

  if (Array.isArray(value)) {
    if (depth > MAX_ATTRIBUTE_DEPTH || budget.remaining <= 0) {
      return typeTag('array');
    }
    return sanitizeArray(value, depth + 1, budget);
  }

  if (!isPlainObject(container)) {
    return typeTag('object');
  }

  if (depth > MAX_ATTRIBUTE_DEPTH || budget.remaining <= 0) {
    return typeTag('object');
  }

  return sanitizeRecord(container as Record<string, unknown>, depth + 1, budget);
}

/**
 * Sanitize an array's first {@link MAX_TRACKED_KEYS} entries.
 *
 * An entry that must not appear becomes `null` rather than vanishing: an array
 * is positional, and dropping an element would silently renumber the rest.
 */
function sanitizeArray(
  value: readonly unknown[],
  depth: number,
  budget: SanitizeBudget,
): unknown[] {
  const limit = Math.min(value.length, MAX_TRACKED_KEYS);
  const out: unknown[] = [];
  for (let index = 0; index < limit; index += 1) {
    let sanitized: unknown;
    try {
      sanitized = sanitizeValue(value[index], depth, budget);
    } catch {
      // An exotic array with a throwing index getter costs one element.
      sanitized = typeTag('unknown');
    }
    out.push(sanitized === OMITTED ? null : sanitized);
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
 * report them, the event schema's attribute bag is keyed by strings, and a
 * symbol key cannot be cloned.
 */
function sanitizeRecord(
  value: Record<string, unknown>,
  depth: number,
  budget: SanitizeBudget,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    // A `Proxy` with a throwing `ownKeys` trap yields an empty bag, not a
    // thrown event.
    return out;
  }

  let kept = 0;
  for (const key of keys) {
    if (kept >= MAX_TRACKED_KEYS) {
      break;
    }

    let sanitized: unknown;
    try {
      sanitized = sanitizeValue(value[key], depth, budget);
    } catch {
      // A throwing getter costs one key.
      sanitized = typeTag('unknown');
    }

    if (sanitized === OMITTED) {
      continue;
    }

    out[key] = sanitized;
    kept += 1;
  }

  return out;
}

/**
 * Turn a producer's attribute bag into one that is certain to clone and
 * certain to survive JSON.
 *
 * A bag that is not an object at all — `undefined` from a producer that forgot
 * the field, or an array — becomes `{}`, because the schema requires an object
 * and an empty bag is a well-formed event while a malformed one is not.
 *
 * @param value The bag as the producer left it.
 * @returns A fresh plain object of clone-safe values.
 */
function sanitizeAttributes(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return sanitizeRecord(value as Record<string, unknown>, 0, {
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
 * @param value The text as its producer read it.
 * @returns The text, at most {@link MAX_CONTROL_TEXT_LENGTH} code points, with
 * an ellipsis in place of whatever was removed.
 */
export function boundControlText(value: string): string {
  try {
    return truncate(value, MAX_CONTROL_TEXT_LENGTH);
  } catch {
    // `truncate` is a pure function over a primitive and cannot throw; the
    // guard is here because this is called from a page stack and the module's
    // second invariant admits no exceptions.
    return '';
  }
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
 *
 * @param value A sanitized value.
 * @returns The same shape with its strings bounded.
 */
function boundControlValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return boundControlText(value);
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) {
      out.push(boundControlValue(entry));
    }
    return out;
  }

  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      out[key] = boundControlValue(record[key]);
    }
    return out;
  }

  return value;
}

/**
 * {@link boundControlValue} for a whole payload record.
 *
 * @param payload A sanitized control payload.
 * @returns The payload with every string bounded.
 */
function boundControlPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) {
    out[key] = boundControlValue(payload[key]);
  }
  return out;
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
 * The `targetOrigin` every outbound frame uses: this window's own origin.
 *
 * `'/'` is the literal the specification defines for "the same origin as the
 * calling window", and it is correct where `location.origin` is not — a
 * sandboxed iframe or a `data:` document has an opaque origin whose
 * `location.origin` reads `"null"`, which matches nothing and would silently
 * discard every frame.
 */
const SAME_ORIGIN_TARGET = '/';

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
 * @returns The completed event, or `undefined` when the draft cannot become
 * one — which today means only a non-finite `startTime` or `duration`, since
 * JSON has no spelling for those and the event would be rejected at ingest.
 */
function completeDraft(draft: EventDraft): TelemetryEventIngress | undefined {
  if (!Number.isFinite(draft.startTime) || !Number.isFinite(draft.duration)) {
    return undefined;
  }

  const event: TelemetryEventIngress = {
    id: draft.id ?? newEventId(),
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

  // Both optional: assigned only when the producer resolved one, because under
  // `exactOptionalPropertyTypes` an absent field and a field set to
  // `undefined` are different things, and JSON keeps only the first.
  if (draft.parentSpanId !== undefined) {
    event.parentSpanId = draft.parentSpanId;
  }
  if (draft.source !== undefined) {
    event.source = draft.source;
  }

  return event;
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

/** Count events that were dropped before or instead of delivery. */
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

  const nextCapacity = Math.min(
    MAX_BUFFERED_EVENTS,
    capacity === 0 ? INITIAL_BUFFER_CAPACITY : capacity * 2,
  );
  const grown: (TelemetryEventIngress | undefined)[] = new Array<TelemetryEventIngress | undefined>(
    nextCapacity,
  );
  for (let index = 0; index < ringCount; index += 1) {
    const slot = ringHead + index;
    grown[index] = ring[slot >= capacity ? slot - capacity : slot];
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
 * than hidden: the count rides out on the next batch's `droppedCount` and
 * shows up in {@link TransportStats}, so the panel can say events were lost
 * instead of presenting a truncated capture as a whole one.
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
  const take = Math.min(limit, ringCount);
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
      batch.push(event);
    }
  }

  const head = ringHead + take;
  ringHead = head >= capacity ? head - capacity : head;
  ringCount -= take;
  return batch;
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
 * consecutive turns rather than in one of them.
 */
function scheduleFlush(): void {
  if (flushTimer !== undefined || !bridgeAvailable || ringCount === 0) {
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
 * timer rather than to inline delivery.
 */
function scheduleDrain(): void {
  if (drainScheduled || !bridgeAvailable || ringCount === 0) {
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
 * Post queued events in batches of at most {@link MAX_EVENTS_PER_BATCH}, if
 * the bridge is there to receive them.
 *
 * @param maxBatches How many batches this turn may post.
 * `Number.POSITIVE_INFINITY` empties the queue, which is what the three
 * synchronous callers want; a finite bound leaves the remainder to a
 * rescheduled drain.
 */
function drainBatches(maxBatches: number): void {
  clearFlushTimer();

  if (!bridgeAvailable) {
    return;
  }

  let batches = 0;
  while (ringCount > 0 && batches < maxBatches) {
    deliver(takeBatch(MAX_EVENTS_PER_BATCH));
    batches += 1;
  }

  if (ringCount > 0) {
    // The bound was reached with events still queued: the rest travels on the
    // next turn instead of extending this one.
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
 * return — goes through {@link drainBatches} with
 * {@link MAX_BATCHES_PER_DRAIN}, because each of those has a next turn and
 * none of them is worth a long task on someone else's page.
 */
function flushNow(): void {
  drainBatches(Number.POSITIVE_INFINITY);
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
 * one; {@link deliver} zeroes it only after a post succeeds, so the count is
 * reported exactly once and never lost to a failed frame.
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
  // to say "no value".
  if (currentCaptureId !== undefined) {
    payload.captureId = currentCaptureId;
  }
  if (currentSessionId !== undefined) {
    payload.sessionId = currentSessionId;
  }

  return payload;
}

/**
 * What became of one attempt to post a frame.
 *
 * Four outcomes rather than a boolean, because the three failures call for
 * three different answers: an `oversize` batch can be split into halves that
 * fit, an `unserializable` one has a single bad event in it to isolate, and a
 * `refused` frame was rendered and then rejected by the page's own
 * `postMessage` — splitting it would fail the same way, so it is dropped.
 */
type FrameOutcome = 'sent' | 'oversize' | 'unserializable' | 'refused';

/**
 * Estimate a frame's transported size as the length of its JSON rendering.
 *
 * The whole frame is measured, not just its payload: `source`, `version` and
 * `type` are what the bridge filters on and they travel with every one.
 *
 * @returns The length in code units, or `undefined` when the frame cannot be
 * rendered at all — which after sanitizing should be impossible, and is
 * reported rather than thrown.
 */
function measureFrame(frame: AgentOutboundMessage): number | undefined {
  try {
    const rendered: string | undefined = JSON.stringify(frame);
    return typeof rendered === 'string' ? rendered.length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Measure one frame and, if it fits, post it to the bridge.
 *
 * **The size cap lives here**, in the one function that calls `postMessage`,
 * rather than in the telemetry path that used to own it. That is what makes it
 * apply to control frames too: an `agent.ready` carries the document's URL and
 * a `target.described` carries a selector and a text preview, all of them page
 * data of a length no page has to justify, and a frame nobody measured is a
 * frame whose size the page chooses (AAP 0.5.5's availability rule — the agent
 * must not be the reason the extension or the page falls over).
 *
 * Never throws. A `DataCloneError` is reported as `refused` and swallowed: the
 * agent runs inside the page's own call stack, where an exception would surface
 * as an error in the developer's application.
 *
 * @param type The frame type, from the closed outbound vocabulary.
 * @param payload The frame's body, already sanitized by the caller.
 * @returns What became of the attempt.
 */
function postFrame(type: AgentOutboundType, payload: Record<string, unknown>): FrameOutcome {
  if (typeof window === 'undefined') {
    return 'refused';
  }

  const frame: AgentOutboundMessage = {
    source: AGENT_SOURCE_TAG,
    version: CHANNEL_VERSION,
    type,
    payload,
  };

  const size = measureFrame(frame);
  if (size === undefined) {
    return 'unserializable';
  }
  if (size > MAX_MESSAGE_BYTES) {
    return 'oversize';
  }

  try {
    window.postMessage(frame, SAME_ORIGIN_TARGET);
    return 'sent';
  } catch {
    return 'refused';
  }
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
 * be influenced by whatever made the original frame too large.
 */
const CONTROL_LOSS_REASONS = {
  oversize: 'control-frame-too-large',
  unserializable: 'control-frame-unserializable',
  refused: 'control-frame-refused',
} as const satisfies Record<Exclude<FrameOutcome, 'sent'>, string>;

/**
 * Account for a control frame the channel would not take, and say so where it
 * can be said cheaply.
 *
 * The diagnostic is deliberately minimal: a reason from
 * {@link CONTROL_LOSS_REASONS}, the type of the frame that was refused, and
 * the limit it exceeded. Nothing from the refused payload is quoted — the
 * payload is the very thing that was too large, and a diagnostic that carried
 * a piece of it would be a second, smaller copy of the problem.
 *
 * Two properties make this safe to call from the post path itself:
 *
 * - **Non-recursive.** {@link reportingControlLoss} is set while the
 *   diagnostic is being posted, so a diagnostic that is itself refused reports
 *   nothing further; it is counted and that is all.
 * - **Reported only when reporting can work.** A frame refused for its *size*
 *   leaves a working channel, and a small frame will cross it. A frame the page
 *   refused to clone means the channel itself rejected a rendered frame, so a
 *   second frame would be rejected the same way and none is attempted.
 *
 * @param type The frame that could not be posted.
 * @param outcome Why it could not.
 */
function noteControlFrameLoss(
  type: AgentOutboundType,
  outcome: Exclude<FrameOutcome, 'sent'>,
): void {
  controlFramesDroppedTotal += 1;

  if (reportingControlLoss || outcome === 'refused') {
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
      // counted, so the number means "frames the channel would not take"
      // exactly. Nothing further is posted — the flag above is still set, and
      // this is the recursion it exists to stop.
      controlFramesDroppedTotal += 1;
    }
  } finally {
    reportingControlLoss = false;
  }
}

/**
 * Post one batch, splitting it when it is too large to travel.
 *
 * Halving is what keeps one pathological event from costing its neighbours: a
 * batch over {@link MAX_MESSAGE_BYTES} is split and each half retried, down to
 * a single event, and only that event is dropped. Recursion depth is bounded
 * by `log2(MAX_EVENTS_PER_BATCH)`, eight levels.
 *
 * A `postMessage` that throws is different in kind: the frame was rendered, so
 * the page refused to clone it, and splitting cannot help. That batch is
 * dropped and counted.
 */
function deliver(events: readonly TelemetryEventIngress[]): void {
  if (events.length === 0) {
    return;
  }

  const outcome = postFrame('telemetry.batch', buildBatchPayload(events));

  if (outcome === 'sent') {
    batchSeqCounter += 1;
    sentTotal += events.length;
    batchesTotal += 1;
    // Reported: the next batch starts a fresh count.
    pendingDropped = 0;
    return;
  }

  if (outcome === 'refused') {
    // The frame was rendered and the page still refused to clone it. Halving
    // would produce two frames that fail the same way.
    recordUnpostable(events.length);
    return;
  }

  const only = events.length === 1 ? events[0] : undefined;
  if (only !== undefined) {
    dropUnpostableEvent(
      only,
      outcome === 'unserializable' ? 'event-unserializable' : 'event-too-large',
    );
    return;
  }

  const middle = Math.ceil(events.length / 2);
  deliver(events.slice(0, middle));
  deliver(events.slice(middle));
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
  'agent.config',
  'agent.snapshot',
  'target.request',
];

/** Whether a value is one of the five frame types the bridge may send. */
function isBridgeInboundType(value: unknown): value is BridgeInboundType {
  return typeof value === 'string' && (BRIDGE_INBOUND_TYPES as readonly string[]).includes(value);
}

/**
 * Whether an incoming frame's origin is this document's own.
 *
 * The bridge shares the page's window, so a legitimate frame always carries
 * this document's origin — or the empty string, or the literal `"null"`, which
 * is what a document with an opaque origin (a sandboxed iframe, a `data:` or
 * `blob:` document) reports for a message it posted to itself.
 */
function isOwnOrigin(origin: string): boolean {
  if (origin === '' || origin === 'null') {
    return true;
  }
  if (typeof location === 'undefined') {
    return false;
  }
  return origin === location.origin;
}

/**
 * Decide whether a `message` event is a frame from the bridge, and normalise
 * it if it is.
 *
 * This is the agent's security boundary, and every condition earns its place.
 * Any script the page loads — including one an attacker got onto the page —
 * can post a message to `window`, and a subscriber acts on what it is handed:
 * `agent.config` arms hooks, `target.request` starts describing elements. So a
 * frame is accepted only when it came from this window, on this window's
 * origin, tagged as the bridge's and at exactly this channel version, and
 * carrying a known frame type. A frame that fails any condition is dropped in
 * silence — reporting it would hand a probing page a signal to iterate
 * against.
 *
 * Nothing in an accepted frame is ever called or evaluated. `payload` is
 * passed through as data, and a non-object payload becomes `{}` so that a
 * handler reading `payload.something` cannot throw on `undefined`.
 */
function acceptFrame(event: MessageEvent<unknown>): BridgeInboundMessage | undefined {
  if (typeof window === 'undefined' || event.source !== window) {
    return undefined;
  }

  if (!isOwnOrigin(event.origin)) {
    return undefined;
  }

  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }

  const frame = data as { source?: unknown; version?: unknown; type?: unknown; payload?: unknown };
  if (frame.source !== BRIDGE_SOURCE_TAG || frame.version !== CHANNEL_VERSION) {
    return undefined;
  }

  const { type } = frame;
  if (!isBridgeInboundType(type)) {
    return undefined;
  }

  const payload: unknown = frame.payload;
  const normalisedPayload =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  return {
    source: BRIDGE_SOURCE_TAG,
    version: CHANNEL_VERSION,
    type,
    payload: normalisedPayload,
  };
}

/**
 * Handle one accepted frame: update bridge presence, then dispatch.
 *
 * The order is deliberate. Presence and the flush it triggers come first, so
 * that events buffered under the outgoing configuration leave before a handler
 * can reconfigure the transport — an `agent.config` for a new capture would
 * otherwise renumber the sequence out from under events still queued from the
 * previous one.
 *
 * Subscribers are dispatched from a snapshot, so a handler that unsubscribes
 * (or subscribes) while being called does not disturb the iteration, and each
 * one is called inside its own guard: a subscriber that throws costs itself
 * and not the frame.
 */
function handleInbound(event: MessageEvent<unknown>): void {
  let message: BridgeInboundMessage | undefined;
  try {
    message = acceptFrame(event);
  } catch {
    // A page that replaced `MessageEvent`'s accessors cannot make this throw
    // into its own `message` dispatch.
    return;
  }

  if (message === undefined) {
    return;
  }

  if (message.type === 'bridge.gone') {
    bridgeAvailable = false;
    clearFlushTimer();
  } else if (!bridgeAvailable) {
    bridgeAvailable = true;
    try {
      // Bounded, and for the same reason the threshold path is: a queue that
      // waited out a service-worker suspension holds up to
      // {@link MAX_BUFFERED_EVENTS} events, and posting all twenty-five
      // batches of them in this one `message` handler would be a long task on
      // the page's main thread. The first batches still travel here — recovery
      // stays immediate — and the remainder is rescheduled turn by turn.
      drainBatches(MAX_BATCHES_PER_DRAIN);
    } catch {
      // The queue survives a failed flush and the next one retries.
    }
  }

  for (const handler of Array.from(subscribers)) {
    try {
      handler(message);
    } catch {
      // A subscriber's failure is its own; the remaining subscribers still see
      // the frame.
    }
  }
}

/** Install the one `message` listener, if it is not installed already. */
function installMessageListener(): void {
  if (messageListener !== undefined || typeof window === 'undefined') {
    return;
  }

  const listener = (event: MessageEvent<unknown>): void => {
    handleInbound(event);
  };
  window.addEventListener('message', listener);
  messageListener = listener;
}

/** Remove the `message` listener, if one is installed. */
function removeMessageListener(): void {
  if (messageListener === undefined) {
    return;
  }

  if (typeof window !== 'undefined') {
    window.removeEventListener('message', messageListener);
  }
  messageListener = undefined;
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
 */
function boundFailureField(value: string): string {
  let cleaned = '';

  // Code-point iteration rather than a regular expression: the characters to
  // remove are the control range, and a control-character class is exactly
  // what `no-control-regex` exists to reject. Stopping at the bound also means
  // an absurdly long input is never scanned in full.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || code === 0x7f ? ' ' : character;
    if (cleaned.length >= MAX_FAILURE_FIELD_CHARS) {
      break;
    }
  }

  return cleaned.trim();
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
  return typeof name === 'string' && REPORTABLE_ERROR_NAMES.has(name) ? name : 'Error';
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
    const alreadyReported = producerFailureCounts.get(source) ?? 0;
    if (alreadyReported >= MAX_PRODUCER_FAILURE_REPORTS) {
      producerFailuresSuppressed += 1;
      return;
    }

    const occurrence = alreadyReported + 1;
    producerFailureCounts.set(source, occurrence);
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
 * `evt_…`), `producerId` (this document's), `tier` (`browser`) and `seq` (the
 * next in this capture) — sanitizes its attributes so the batch is certain to
 * clone, and queues it.
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
    for (const draft of drafts) {
      acceptDraft(draft);
    }
  } catch {
    // An exotic iterable from the page cannot break the commit it came from.
    recordUnpostable(1);
  }
}

/**
 * Post a control frame to the bridge immediately, capture or no capture.
 *
 * Control frames are how the agent says things about itself rather than about
 * the application: `agent.ready` when it initialises (and again whenever the
 * bridge announces itself, since a frame posted before the bridge's listener
 * existed is lost), `target.described` with an element descriptor the panel
 * asked for, and `agent.error` when something could not be done.
 *
 * The payload is sanitized on the way out, exactly as an event's attributes
 * are: a control frame is structure-cloned like any other, and a descriptor
 * assembled from page data must not be the thing that throws `DataCloneError`.
 * It is then **bounded** — every string to {@link MAX_CONTROL_TEXT_LENGTH},
 * every frame to {@link MAX_MESSAGE_BYTES} — because a control frame's fields
 * are page data (a URL, a selector, an element's text) whose length no page has
 * to justify. A frame the cap refuses is replaced by one fixed-size diagnostic
 * (see {@link noteControlFrameLoss}), never posted unmeasured and never
 * silently dropped.
 *
 * Nothing is queued and nothing is retried. A control frame is a statement
 * about a moment, and the bridge's own `bridge.ready` is the cue to restate
 * the one that matters.
 */
export function postControl(type: AgentOutboundType, payload: Record<string, unknown>): void {
  try {
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
 * The first call installs the module's single `message` listener; the last
 * unsubscribe removes it, so a fully detached agent leaves no listener on the
 * page's window. The returned function is idempotent and safe to call after
 * {@link resetTransport}.
 *
 * @param handler Called with each accepted frame. It must not throw — one that
 * does is contained, but it forfeits its own notification.
 * @returns The unsubscribe function.
 */
export function subscribe(handler: (message: BridgeInboundMessage) => void): () => void {
  try {
    subscribers.add(handler);
    installMessageListener();
  } catch {
    // A page that has broken `addEventListener` leaves the agent deaf rather
    // than broken; `getTransportStats().bridgeReady` stays false and
    // `./agent.ts` reports it.
  }

  return function unsubscribe(): void {
    try {
      subscribers.delete(handler);
      if (subscribers.size === 0) {
        removeMessageListener();
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
 *    relabelled. They are counted in {@link TransportStats}'s cumulative
 *    `dropped`, while the per-capture `droppedCount` restarts with the new
 *    capture, because that number describes a capture.
 * 3. **The sequence restarts.** `seq` and `batchSeq` are scoped to the
 *    capture (see {@link nextSeq}), so a new `captureId` restarts both at
 *    zero. An identical `captureId` — the same configuration re-sent after a
 *    reconnect, which the bridge is expected to do — changes nothing, which is
 *    what makes re-configuration idempotent.
 */
export function configureTransport(config: TransportConfig): void {
  try {
    const nextCaptureId = config.captureId;
    const nextEnabled = config.enabled;
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
      // Failure reports are bounded per capture for the same reason the
      // sequence is scoped to one: a new capture is a new statement about what
      // could and could not be collected (see MAX_PRODUCER_FAILURE_REPORTS).
      producerFailureCounts.clear();
    }

    currentSessionId = config.sessionId;
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
 * Post everything queued right now, without waiting for the flush timer.
 *
 * `./agent.ts` calls this on `pagehide` — the last moment a document can hand
 * anything to the bridge — and when a capture stops, so the analysis runs on
 * the whole capture and not on the whole capture minus its final 250 ms.
 *
 * A no-op while the bridge is away: the queue is kept and the arrival of
 * `bridge.ready` starts draining it.
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
 * events, no subscribers, no timer and no listener on the page's window, and
 * {@link emit} accepts nothing until it is configured again.
 *
 * The producer and document ids are **not** reset, and `./ids.ts` offers no
 * way to reset them: they identify the document, not the capture, and a second
 * producer id inside one document would split one sequence into two
 * incomparable halves.
 *
 * Every step stands in its own guard (see {@link teardownStep}). The three
 * that touch the page — clearing the timer and removing the listener — are the
 * ones that can fail, because `clearTimeout` and `removeEventListener` belong
 * to the document and a page is free to replace them; the rest cannot, and are
 * guarded anyway so that the ordering carries no assumption. Without the
 * per-step guard a single hostile or broken page API would leave
 * `acceptingEvents` true and `currentCaptureId` set — a "dormant" agent still
 * accepting events into a capture that has ended, which is precisely what AAP
 * 0.5.1's "disabled, not merely idled" forbids.
 *
 * What a failed step leaves behind is retained rather than forgotten:
 * {@link removeMessageListener} clears its reference only after the removal
 * returns, so a listener that could not be removed is still known and the next
 * call tries again. The failure itself is reported as an `agent.error` frame
 * with `source: 'transport'`.
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
  teardownStep('message-listener-remove', () => {
    removeMessageListener();
  });
  teardownStep('subscribers-clear', () => {
    subscribers.clear();
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
    producerFailureCounts.clear();
  });
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
