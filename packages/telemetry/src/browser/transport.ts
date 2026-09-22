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
 * starts on the first enqueue. `./agent.ts` is the one module in this folder
 * allowed to act when it is evaluated.
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
 * ## Imports: three modules, and why not a fourth
 *
 * `packages/telemetry/esbuild.agent.mjs` bundles this folder into the static
 * content script the Chrome extension copies verbatim, and it hard-fails on
 * any input resolving to a Node builtin, `@debuggen/protocol`,
 * `@debuggen/shared/node` or `zod`. So: `./ids.js` (import-free by
 * construction), `../schema/attributes.js` (imports only `../schema/kinds.js`,
 * both vocabulary-only), and `../schema/event.js` **for a type alone** — that
 * module value-imports `zod` and `@debuggen/shared`, and `import type` is
 * erased before esbuild ever sees the file, which is what lets the one
 * definition of {@link TelemetryEventIngress} be reused here instead of
 * restated. `@debuggen/shared`'s barrel is not imported in any form, not even
 * for a type, because its value imports would come with it if the `type`
 * keyword were ever dropped in a refactor.
 *
 * @module packages/telemetry/src/browser/transport
 */

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
 * Also the flush trigger: reaching it posts immediately instead of waiting for
 * the timer, so a burst travels while it is happening rather than in one large
 * frame at the end. 200 keeps a batch well inside
 * {@link MAX_MESSAGE_BYTES} for ordinary events and keeps each structured
 * clone short enough not to show up as a long task of its own.
 */
export const MAX_EVENTS_PER_BATCH = 200;

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
 * How long a partly filled buffer waits before it is posted.
 *
 * One timer is armed on the first enqueue and re-armed only after it fires, so
 * a thousand events cost one timer and not a thousand. 250 ms is short enough
 * that the panel's live tail reads as live and long enough to coalesce the
 * render storm of a single interaction into a handful of frames.
 */
export const FLUSH_INTERVAL_MS = 250;

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

/** FIFO queue of completed, sanitized events waiting for the bridge. */
const buffer: TelemetryEventIngress[] = [];

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

/** Whether the bridge has announced itself and not gone away since. */
let bridgeAvailable = false;

/** The armed flush timer, or `undefined` when none is pending. */
let flushTimer: ReturnType<typeof setTimeout> | undefined;

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

/**
 * Queue one completed event, evicting the oldest when the buffer is full.
 *
 * **Oldest-first eviction is the deliberate choice.** The events at the head
 * of a full queue are the ones the developer produced first and has already
 * moved on from; the ones arriving now describe what they are looking at. A
 * newest-first policy would answer the question "what just happened?" with the
 * beginning of a render storm and nothing else. The loss is reported rather
 * than hidden: the count rides out on the next batch's `droppedCount` and
 * shows up in {@link TransportStats}, so the panel can say events were lost
 * instead of presenting a truncated capture as a whole one.
 */
function enqueue(event: TelemetryEventIngress): void {
  if (buffer.length >= MAX_BUFFERED_EVENTS) {
    const overflow = buffer.length - MAX_BUFFERED_EVENTS + 1;
    buffer.splice(0, overflow);
    recordDropped(overflow);
  }

  buffer.push(event);

  if (buffer.length >= MAX_EVENTS_PER_BATCH) {
    // A full batch travels now: waiting would only make the frame larger.
    flushNow();
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
 * `bridge.ready` flushes it immediately.
 */
function scheduleFlush(): void {
  if (flushTimer !== undefined || !bridgeAvailable || buffer.length === 0) {
    return;
  }

  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    try {
      flushNow();
    } catch {
      // A timer callback is the one place a throw has no caller to catch it,
      // so it is caught here and the queue is left for the next flush.
    }
  }, FLUSH_INTERVAL_MS);
}

/**
 * Post everything queued, in batches of at most
 * {@link MAX_EVENTS_PER_BATCH}, if the bridge is there to receive it.
 */
function flushNow(): void {
  clearFlushTimer();

  if (!bridgeAvailable) {
    return;
  }

  while (buffer.length > 0) {
    deliver(buffer.splice(0, MAX_EVENTS_PER_BATCH));
  }
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
 * Estimate a payload's transported size as the length of its JSON rendering.
 *
 * @returns The length in code units, or `undefined` when the payload cannot be
 * rendered at all — which after sanitizing should be impossible, and is
 * treated as an oversize frame rather than as a reason to throw.
 */
function measurePayload(payload: Record<string, unknown>): number | undefined {
  try {
    const rendered: string | undefined = JSON.stringify(payload);
    return typeof rendered === 'string' ? rendered.length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Post one frame to the bridge.
 *
 * @returns Whether the frame was handed to `postMessage` without it throwing.
 * A `DataCloneError` is reported as `false` and never propagated: the agent
 * runs inside the page's own call stack, where a throw would surface as an
 * error in the developer's application.
 */
function postFrame(type: AgentOutboundType, payload: Record<string, unknown>): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const frame: AgentOutboundMessage = {
    source: AGENT_SOURCE_TAG,
    version: CHANNEL_VERSION,
    type,
    payload,
  };

  try {
    window.postMessage(frame, SAME_ORIGIN_TARGET);
    return true;
  } catch {
    return false;
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

  const payload = buildBatchPayload(events);
  const size = measurePayload(payload);

  if (size === undefined || size > MAX_MESSAGE_BYTES) {
    const only = events.length === 1 ? events[0] : undefined;
    if (only !== undefined) {
      dropUnpostableEvent(only, size === undefined ? 'event-unserializable' : 'event-too-large');
      return;
    }

    const middle = Math.ceil(events.length / 2);
    deliver(events.slice(0, middle));
    deliver(events.slice(middle));
    return;
  }

  if (!postFrame('telemetry.batch', payload)) {
    recordUnpostable(events.length);
    return;
  }

  batchSeqCounter += 1;
  sentTotal += events.length;
  batchesTotal += 1;
  // Reported: the next batch starts a fresh count.
  pendingDropped = 0;
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
      flushNow();
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
 * Public API
 * ---------------------------------------------------------------------------
 */

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
 *
 * Nothing is queued and nothing is retried. A control frame is a statement
 * about a moment, and the bridge's own `bridge.ready` is the cue to restate
 * the one that matters.
 */
export function postControl(type: AgentOutboundType, payload: Record<string, unknown>): void {
  try {
    postFrame(type, sanitizeAttributes(payload));
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
      if (buffer.length > 0) {
        // Undeliverable, and no longer attributable: counted, not relabelled.
        droppedTotal += buffer.length;
        buffer.length = 0;
      }
      seqCounter = 0;
      batchSeqCounter = 0;
      pendingDropped = 0;
    }

    currentSessionId = config.sessionId;
    currentCaptureId = nextCaptureId;
    acceptingEvents = nextEnabled;

    if (buffer.length === 0) {
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
 * `bridge.ready` flushes it.
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
 */
export function resetTransport(): void {
  try {
    clearFlushTimer();
    removeMessageListener();
    subscribers.clear();
    buffer.length = 0;

    currentSessionId = undefined;
    currentCaptureId = undefined;
    acceptingEvents = false;
    bridgeAvailable = false;

    seqCounter = 0;
    batchSeqCounter = 0;
    pendingDropped = 0;
    droppedTotal = 0;
    sentTotal = 0;
    batchesTotal = 0;
    serializationFailureTotal = 0;
  } catch {
    // Best effort by construction: every step above is independent, so a
    // failure in one leaves the others done.
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
    buffered: buffer.length,
    dropped: droppedTotal,
    sent: sentTotal,
    batches: batchesTotal,
    seq: seqCounter,
    bridgeReady: bridgeAvailable,
    serializationFailures: serializationFailureTotal,
  };
}
