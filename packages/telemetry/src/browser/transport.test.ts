// @vitest-environment happy-dom
/**
 * Colocated tests for `./transport.ts` — the bounds the page agent promises the
 * developer's page, each one exercised at the value itself, one short of it and
 * one over; the private page channel those bounds travel on; and the custody
 * rule that decides when an event has actually left the page.
 *
 * **What this suite owns.** Every number that decides when telemetry travels,
 * how much of it is held and what happens when there is too much:
 *
 * - {@link MAX_EVENTS_PER_BATCH} (200) — the size of a dispatched batch *and*
 *   the drain trigger. The event that reaches it must not pay for the batch:
 *   the drain goes to a later turn, which the cases below assert by observing
 *   that nothing has been dispatched when the emitting loop returns.
 * - {@link MAX_BUFFERED_EVENTS} (5 000) — AAP §0.5.5's "the agent buffers up to
 *   5 000 events in memory until the bridge returns". At the cap exactly one
 *   oldest event is evicted per new event, order survives the ring's
 *   wrap-around, `seq` is **not** renumbered (the gap is how a reader learns
 *   events were lost) and the loss rides out on the next claimed batch's
 *   `droppedCount`, once.
 * - {@link MAX_BATCHES_PER_DRAIN} (8) — what one drain dispatches before it
 *   yields the task back to the page, with the remainder rescheduled. Asserted
 *   on both non-terminal routes that can meet a deep queue: the scheduled drain
 *   the batch threshold starts, and the recovery drain the bridge's return
 *   starts after an absence. {@link flush} is the deliberate exception — a
 *   terminal moment with no later turn — and is asserted to be unbounded.
 * - {@link MAX_MESSAGE_BYTES} (512 KiB) — the length of every frame's `detail`,
 *   in both directions. An oversize batch is halved until it fits, a single
 *   event that cannot fit is dropped alone with a diagnostic naming only its id
 *   and kind, a control frame over the cap is refused and replaced by one
 *   fixed-size diagnostic that cannot trigger another, and an inbound frame one
 *   code unit over the cap is dropped while one exactly at it is accepted.
 * - {@link MAX_CONTROL_TEXT_LENGTH} (2 048) — the per-field bound on the
 *   page-controlled text a control frame carries.
 * - **Flow control** — between a `bridge.pause` and its `bridge.resume` the
 *   batch threshold, the {@link FLUSH_INTERVAL_MS} timer and the bridge's
 *   return post nothing, a bounded drain the pause is handed back into stops
 *   before its next batch, and the ring keeps its bound and its loss
 *   reporting; control frames and the terminal drains still travel; the
 *   resume drains at once with the same per-turn bound; `bridge.ready` and
 *   `bridge.gone` end a pause while a capture change and a reset do not; and
 *   neither signal reaches a subscriber.
 *
 * **The channel, version 4.** Frames travel as `CustomEvent`s on a detached
 * node the agent hands to the bridge exactly once, never on `window`, and a
 * frame counts as delivered only when the receiver acknowledges it with
 * `preventDefault()`. The cases assert the properties that design exists for:
 *
 * - *what a page script can see* — nothing: a listener on `window` or
 *   `document`, for `message` or for the frame events, observes no frame, and
 *   `window.postMessage` is never called;
 * - *what a page script can send* — nothing the agent accepts: a v2-style frame
 *   posted to the window, token or not, and a {@link BRIDGE_FRAME_EVENT}
 *   dispatched anywhere but the node are ignored, unacknowledged;
 * - *how the node is disclosed* — once, to the first request, never
 *   unsolicited, never again (not from inside the answer, not after a reset);
 * - *what an accepted frame is* — a `detail` string within the cap that parses
 *   to a record with the bridge's tag, version 4 and an inbound type; anything
 *   else is dropped unacknowledged, and the payload a subscriber receives is a
 *   null-prototype record a polluted `Object.prototype` cannot reach into;
 * - *custody* — a claimed batch leaves the queue and advances `batchSeq`; an
 *   unclaimed one goes back to the front, in order, marks the bridge away and
 *   is delivered after the next `bridge.ready` with the same `batchSeq`, the
 *   same `droppedCount` and no duplicate — halves included;
 * - *terminal loss* — a flush that leaves loss no batch can carry posts it as
 *   one event-less batch under the capture's next `batchSeq`, under the same
 *   custody rules, and a capture that lost nothing never sees an empty batch;
 * - *re-entrancy* — a `bridge.gone`, a `bridge.ready`, a flush, a capture change
 *   or a reset handed back from inside the agent's own dispatch;
 * - *the captured primitives* — replacing `dispatchEvent`, `addEventListener`,
 *   the `detail` getter, `preventDefault`, `JSON` or `CustomEvent` after the
 *   module loaded neither breaks the channel nor lets the page watch it.
 *
 * No other suite in the repository reaches any of them: the sibling browser
 * suites drive producers (`./continuation.test.ts`, `./dom-target.test.ts`,
 * `./react.test.tsx`) and `../node/control.test.ts` drives the capture gate, so
 * a regression in the backpressure rules — a queue that shifts its whole array
 * per event, an inline drain on a click handler, a frame dispatched unmeasured,
 * a batch forgotten when the bridge's port died — or in the channel would
 * otherwise reach a developer's page before it reached a test.
 *
 * ## Techniques, and why each one is the way it is
 *
 * **Both directions go through a fake bridge that does exactly what the real
 * one does** (`./__tests__/page-channel.ts`). This file connects it once, at
 * module scope: it dispatches the one {@link HANDSHAKE_REQUEST_EVENT} this
 * module instance will ever answer, holds the node the answer carries, records
 * every {@link AGENT_FRAME_EVENT} dispatched on it and acknowledges each one its
 * claim policy says to take. So "the bridge's runtime port was gone" is a claim
 * policy of `false`, "the bridge handed back a `bridge.gone` from inside the
 * dispatch" is a policy that sends one, and every assertion reads the frames
 * off the wire rather than out of the module's internals. The node and the
 * handshake latch are document-scoped and survive the {@link resetTransport}
 * each case runs, which is the same lifetime a second capture on one document
 * depends on.
 *
 * **Cases that need an unspent handshake take a fresh module instance**
 * (`vi.resetModules()` and a dynamic `import()`, which this module supports
 * because it has no import-time side effects). The file's own instance has
 * already answered its request and listens for no other, so a request
 * dispatched in such a case reaches exactly the fresh one. Every fresh
 * instance is reset in a `finally`, which removes its request listener too, so
 * no case leaves an answerable listener behind for the next.
 *
 * **A `refused` dispatch is produced where the product meets it**: by a
 * `CustomEvent` constructor that throws. The stub is installed only while a
 * fresh instance is evaluated — which is when the module captures its
 * constructors — and removed straight after, so it is that one instance's
 * constructor and nobody else's. It subclasses the real one, so the captured
 * `detail` getter is still found on its prototype chain. The fake bridge
 * dispatches with the constructor it captured at its own evaluation and is
 * unaffected.
 *
 * **The scheduled drain is waited for, never assumed.** The module hands a
 * scheduled drain to a `MessageChannel` message, and in this host that is
 * Node's `MessagePort`, whose delivery is not ordered against the timer queue —
 * the first drain in a fresh worker takes more than one macrotask. So
 * {@link drainToCompletion} yields macrotasks until the queue is empty, bounded
 * by {@link MAX_WAITED_TURNS} so a drain that never arrives fails the case
 * instead of hanging it. The assertion that matters — that nothing travelled on
 * the producer's stack — is made *before* the first yield, where it is exact.
 *
 * **One case needs the boundary of a single drain turn**, which no amount of
 * waiting can observe: {@link MAX_BATCHES_PER_DRAIN} is about what one turn
 * does *not* do. That case stubs `MessageChannel` away, which sends the drain
 * down the module's documented microtask fallback — the same
 * `runScheduledDrain` body — and queues its own probe microtask immediately
 * after the emitting loop. Microtasks run in order, so the probe runs after the
 * drain and before the continuation the drain rescheduled, and reads the exact
 * state at the end of one turn.
 *
 * **State is module-global**, being one document's transport, so
 * {@link resetTransport} runs before and after every case, the fake bridge's
 * record is cleared with it, and no case depends on another's counters.
 *
 * **Deterministic by construction.** No fake timers, no wall-clock sleep beyond
 * a zero-delay yield, no network, and no Node built-in anywhere: `eslint.config.js`
 * forbids one under `src/browser/**`, tests included, because this folder is
 * bundled into the page-injected agent (AAP §0.2.2, §0.7.1 Group 1). Every
 * bound is imported from the module under test and the exact/one-over cases are
 * derived from it (`MAX_EVENTS_PER_BATCH - 1`), so a retuned constant moves
 * these cases with it rather than leaving them asserting a stale number.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_TRACKED_KEYS } from '../schema/attributes.js';
import {
  bridgeFrameDetail,
  connectFakeBridge,
  requestChannelNode,
} from './__tests__/page-channel.js';
import type { FakeBridge, HandshakeResult, RecordedAgentFrame } from './__tests__/page-channel.js';
import { getProducerId } from './ids.js';
import {
  AGENT_FRAME_EVENT,
  AGENT_SOURCE_TAG,
  boundControlText,
  BRIDGE_FRAME_EVENT,
  BRIDGE_SOURCE_TAG,
  CHANNEL_VERSION,
  configureTransport,
  emit,
  emitMany,
  flush,
  FLUSH_INTERVAL_MS,
  getFlowControlStats,
  getTransportStats,
  HANDSHAKE_OFFER_EVENT,
  HANDSHAKE_REQUEST_EVENT,
  MAX_BATCHES_PER_DRAIN,
  MAX_BUFFERED_EVENTS,
  MAX_CONTROL_TEXT_LENGTH,
  MAX_EVENTS_PER_BATCH,
  MAX_MESSAGE_BYTES,
  postControl,
  resetTransport,
  subscribe,
} from './transport.js';
import type { BridgeInboundMessage, EventDraft } from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 *
 * Neutral vocabulary throughout: nothing below names a component, route or
 * symbol of any particular project (AAP §0.5.4), and every identifier is
 * assembled from a repeated character so a failure diff differs in the digits
 * that carry meaning.
 * ---------------------------------------------------------------------------
 */

/** The session the fixtures' capture belongs to. */
const SESSION_ID = `ses_${'1'.repeat(16)}`;

/** The capture every case runs under. */
const CAPTURE_A = `cap_${'a'.repeat(16)}`;

/** A second capture, for the transition cases. */
const CAPTURE_B = `cap_${'b'.repeat(16)}`;

/** The trace every emitted draft belongs to: 32 lowercase hex characters. */
const TRACE_ID = 'c'.repeat(32);

/** Characters in a span id. */
const SPAN_ID_WIDTH = 16;

/** The kind every draft carries; a browser-tier kind, as this producer's are. */
const EVENT_KIND = 'render';

/** The attribute the emission index is carried in, so order is readable. */
const ORDER_ATTRIBUTE = 'debuggen.order';

/** The attribute oversize fixtures put their filler text in. */
const FILLER_ATTRIBUTE = 'debuggen.filler';

/** A small, round epoch-millisecond base; the module only ever rounds it. */
const T0 = 1_700_000_000_000;

/** A page URL for control frames; `.invalid` is reserved and resolves nowhere. */
const PAGE_URL = 'https://example.invalid/page';

/**
 * A property name a case adds to `Object.prototype`, the way a page script can,
 * and removes again before it returns.
 */
const POLLUTED_KEY = 'debuggenPolluted';

/**
 * Macrotask yields {@link drainToCompletion} will spend before it gives up.
 *
 * Generous, because it bounds a failure rather than a success: a scheduled
 * drain arrives on the first or second turn in this host, and a bound of
 * twenty turns is the difference between a case that fails with an assertion
 * and one that hangs the suite.
 */
const MAX_WAITED_TURNS = 20;

/**
 * Keys per container in the oversize control payload.
 *
 * Kept at or below {@link MAX_TRACKED_KEYS} so the sanitizer keeps every one of
 * them: the point of that fixture is a frame refused by the *frame* cap while
 * every individual field is inside its own bound, which a payload the sanitizer
 * had trimmed would not demonstrate.
 */
const CONTROL_FANOUT = Math.min(20, MAX_TRACKED_KEYS);

/** Events in the oversize-batch fixture; a power of two, so halving is exact. */
const OVERSIZE_BATCH_EVENTS = 8;

/**
 * What one event of the oversize-batch fixture carries.
 *
 * Sized so the whole batch measures just over {@link MAX_MESSAGE_BYTES} — the
 * filler alone reaches the cap exactly and the events' own fields carry it
 * past — while either half is comfortably inside it. That is the split the
 * cases assert: one halving, no more.
 */
const OVERSIZE_BATCH_FILLER = MAX_MESSAGE_BYTES / OVERSIZE_BATCH_EVENTS;

/*
 * ---------------------------------------------------------------------------
 * Drafts
 * ---------------------------------------------------------------------------
 */

/**
 * A 16-hex span id that encodes the emission index.
 *
 * Real in shape (AAP §0.2.3) and legible in a diff: an out-of-order delivery
 * shows up as an id whose trailing digits are wrong, rather than as two random
 * strings.
 *
 * @param index The emission index.
 * @returns The span id.
 */
function spanIdFor(index: number): string {
  return index.toString(16).padStart(SPAN_ID_WIDTH, '0');
}

/** What a case varies about a draft. */
interface DraftOptions {
  /** Extra attributes, merged after the order attribute. */
  readonly attributes?: Record<string, unknown> | undefined;
}

/**
 * One render draft, carrying its emission index where the readers can find it.
 *
 * @param index The emission index, stamped into the span id, the name and the
 * order attribute.
 * @param options Per-case additions.
 * @returns The draft, as a producer in this folder would build it.
 */
function renderDraft(index: number, options: DraftOptions = {}): EventDraft {
  return {
    traceId: TRACE_ID,
    spanId: spanIdFor(index),
    kind: EVENT_KIND,
    name: `render ${String(index)}`,
    startTime: T0 + index,
    duration: 1,
    status: 'unset',
    attributes: { [ORDER_ATTRIBUTE]: index, ...(options.attributes ?? {}) },
  };
}

/**
 * Emit a contiguous run of drafts through the public entry point.
 *
 * Synchronous and unbroken on purpose: it is the shape of the burst the bounds
 * exist for — a render storm inside one commit — and it is what makes "nothing
 * was dispatched while the producer was on the stack" an assertion about the
 * module rather than about the scheduler.
 *
 * @param count How many drafts to emit.
 * @param startIndex The first emission index.
 */
function emitRange(count: number, startIndex = 0): void {
  for (let offset = 0; offset < count; offset += 1) {
    emit(renderDraft(startIndex + offset));
  }
}

/**
 * Emit the oversize-batch fixture: {@link OVERSIZE_BATCH_EVENTS} drafts whose
 * filler takes the batch just over {@link MAX_MESSAGE_BYTES}.
 *
 * @param emitDraft The module instance's `emit`.
 * @param startIndex The first emission index.
 */
function emitOversizeRun(emitDraft: (draft: EventDraft) => void, startIndex = 0): void {
  const filler = 'x'.repeat(OVERSIZE_BATCH_FILLER);
  for (let offset = 0; offset < OVERSIZE_BATCH_EVENTS; offset += 1) {
    emitDraft(renderDraft(startIndex + offset, { attributes: { [FILLER_ATTRIBUTE]: filler } }));
  }
}

/**
 * The contiguous run of indices `[start, start + count)`.
 *
 * @param start First value.
 * @param count How many values.
 * @returns The run.
 */
function indexRange(start: number, count: number): number[] {
  const values: number[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    values.push(start + offset);
  }
  return values;
}

/*
 * ---------------------------------------------------------------------------
 * The bridge
 *
 * Connected once, here, before any case runs: this module instance answers one
 * handshake request in its life, and this is it. See the file overview.
 * ---------------------------------------------------------------------------
 */

/** The fake bridge, holding this module instance's channel node. */
const bridge: FakeBridge = connectFakeBridge({ subscribe });

/*
 * ---------------------------------------------------------------------------
 * Reading what travelled
 *
 * A frame's payload is `Record<string, unknown>`, so every reader below narrows
 * from `unknown` and throws a named failure when the shape is wrong. A malformed
 * frame is something these cases are entitled to assert *about*, which it could
 * not be if a reader assumed it away.
 * ---------------------------------------------------------------------------
 */

/**
 * Narrow an unknown value to a record.
 *
 * @param value The value to narrow.
 * @param what What it was supposed to be, for the failure message.
 * @returns The value as a record.
 */
function asRecord(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} was not an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Narrow an unknown value to a list of unknowns.
 *
 * The cast is what keeps `Array.isArray`'s `any[]` from escaping into the rest
 * of the file; every element is still narrowed by its own reader.
 *
 * @param value The value to narrow.
 * @param what What it was supposed to be, for the failure message.
 * @returns The value as a list.
 */
function asList(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${what} was not an array`);
  }
  return value as readonly unknown[];
}

/**
 * Read one element of a list, failing rather than returning `undefined`.
 *
 * `noUncheckedIndexedAccess` is on, and an assertion that silently compared
 * `undefined` with `undefined` would be the one way these cases could pass
 * empty-handed.
 *
 * @param list The list.
 * @param index The position.
 * @param what What the list holds, for the failure message.
 * @returns The element.
 */
function at<T>(list: readonly T[], index: number, what: string): T {
  const value = list[index];
  if (value === undefined) {
    throw new Error(`${what} had no element at index ${String(index)}`);
  }
  return value;
}

/** One batch payload, with the members these cases read. */
interface BatchView {
  /** Whether the bridge claimed the frame that carried it. */
  readonly claimed: boolean;
  /** The payload's own keys, sorted, so an extra one is visible. */
  readonly keys: readonly string[];
  /** The events, each as a record. */
  readonly events: readonly Readonly<Record<string, unknown>>[];
  /** The count of events lost since the last claimed batch reported one. */
  readonly droppedCount: unknown;
  /** The batch's own sequence number. */
  readonly batchSeq: unknown;
  /** The producer that stamped the events. */
  readonly producerId: unknown;
  /** The document the producer belongs to. */
  readonly documentId: unknown;
  /** The capture, where the service named one. */
  readonly captureId: unknown;
  /** The session, where the service named one. */
  readonly sessionId: unknown;
}

/**
 * Decode one `telemetry.batch` frame.
 *
 * @param frame The recorded frame.
 * @returns The payload, narrowed to what the cases read.
 */
function batchView(frame: RecordedAgentFrame): BatchView {
  const payload = asRecord(frame.payload, 'a telemetry.batch payload');
  const events = asList(payload.events, "a telemetry.batch payload's events");
  return {
    claimed: frame.claimed,
    keys: Object.keys(payload).sort(),
    events: events.map((event, index) => asRecord(event, `event ${String(index)} of a batch`)),
    droppedCount: payload.droppedCount,
    batchSeq: payload.batchSeq,
    producerId: payload.producerId,
    documentId: payload.documentId,
    captureId: payload.captureId,
    sessionId: payload.sessionId,
  };
}

/**
 * Every **claimed** batch's view, in dispatch order: what was delivered.
 *
 * @param source The fake bridge to read; this file's own by default.
 * @returns The views.
 */
function batchViews(source: FakeBridge = bridge): BatchView[] {
  return source.claimedOfType('telemetry.batch').map((frame) => batchView(frame));
}

/**
 * Every **dispatched** batch's view, claimed or not, in dispatch order: what
 * was attempted.
 *
 * @param source The fake bridge to read; this file's own by default.
 * @returns The views.
 */
function dispatchedBatchViews(source: FakeBridge = bridge): BatchView[] {
  return source.framesOfType('telemetry.batch').map((frame) => batchView(frame));
}

/** Every delivered event, across every claimed batch, in dispatch order. */
function deliveredEvents(source: FakeBridge = bridge): Readonly<Record<string, unknown>>[] {
  return batchViews(source).flatMap((batch) => [...batch.events]);
}

/**
 * The emission index of one delivered event.
 *
 * Read out of the attribute bag the draft carried it in, so the value proves
 * the event survived stamping and sanitizing rather than being reconstructed
 * from its position.
 *
 * @param event The delivered event.
 * @returns The emission index.
 */
function orderOf(event: Readonly<Record<string, unknown>>): number {
  const attributes = asRecord(event.attributes, "a delivered event's attributes");
  const order = attributes[ORDER_ATTRIBUTE];
  if (typeof order !== 'number') {
    throw new Error('a delivered event carried no numeric order attribute');
  }
  return order;
}

/** The emission indices of one batch's events, in order. */
function batchOrder(batch: BatchView): number[] {
  return batch.events.map((event) => orderOf(event));
}

/** The emission indices of every delivered event, in delivery order. */
function deliveredOrder(source: FakeBridge = bridge): number[] {
  return deliveredEvents(source).map((event) => orderOf(event));
}

/**
 * The `seq` of one delivered event.
 *
 * @param event The delivered event.
 * @returns The sequence number.
 */
function seqOf(event: Readonly<Record<string, unknown>>): number {
  const seq = event.seq;
  if (typeof seq !== 'number') {
    throw new Error('a delivered event carried no numeric seq');
  }
  return seq;
}

/** The sequence numbers of every delivered event, in delivery order. */
function deliveredSeqs(source: FakeBridge = bridge): number[] {
  return deliveredEvents(source).map((event) => seqOf(event));
}

/** The shape of a run of numbers, as the ordering cases assert on it. */
interface RunShape {
  /** The first value, or `undefined` for an empty run. */
  readonly first: number | undefined;
  /** The last value, or `undefined` for an empty run. */
  readonly last: number | undefined;
  /** How many values the run carries. */
  readonly count: number;
  /** Whether every value is greater than the one before it. */
  readonly increasing: boolean;
  /** The values missing from the inclusive range between the ends. */
  readonly gaps: readonly number[];
}

/**
 * Describe a run of numbers, so an ordering failure reads as four fields rather
 * than as a diff of five thousand elements.
 *
 * `gaps` is what makes the sequence cases legible: the module deliberately does
 * not renumber `seq` when the ring evicts an event, so the numbers that are
 * *absent* are the assertion, and naming them beats asserting a literal list.
 * `increasing` is what makes the custody cases legible: a requeued batch that
 * was delivered twice, or behind the events queued after it, is a run that
 * stops increasing.
 *
 * @param values The run, in delivery order.
 * @returns Its shape.
 */
function runShapeOf(values: readonly number[]): RunShape {
  const gaps: number[] = [];
  let increasing = true;

  for (let position = 1; position < values.length; position += 1) {
    const previous = at(values, position - 1, 'a delivered run');
    const current = at(values, position, 'a delivered run');
    if (current <= previous) {
      increasing = false;
      continue;
    }
    for (let missing = previous + 1; missing < current; missing += 1) {
      gaps.push(missing);
    }
  }

  return {
    first: values.length > 0 ? at(values, 0, 'a delivered run') : undefined,
    last: values.length > 0 ? at(values, values.length - 1, 'a delivered run') : undefined,
    count: values.length,
    increasing,
    gaps,
  };
}

/** The shape a contiguous, strictly increasing run of `count` values has. */
function contiguousRun(first: number, count: number): RunShape {
  return {
    first,
    last: first + count - 1,
    count,
    increasing: true,
    gaps: [],
  };
}

/**
 * The top-level keys of a dispatched frame's `detail`, sorted.
 *
 * @param frame The recorded frame.
 * @returns The keys the JSON carried.
 */
function detailKeys(frame: RecordedAgentFrame): string[] {
  const parsed: unknown = JSON.parse(frame.detail);
  return Object.keys(asRecord(parsed, 'a dispatched detail')).sort();
}

/*
 * ---------------------------------------------------------------------------
 * Turns
 * ---------------------------------------------------------------------------
 */

/** Yield one macrotask, the turn a scheduled drain runs on. */
async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Yield macrotasks until the queue is empty, or until the patience runs out.
 *
 * A scheduled drain is handed to a `MessageChannel`, which in this host is
 * Node's `MessagePort`: its delivery is not ordered against the timer queue, so
 * "one turn" is not a number a case may assume. The bound is what keeps a drain
 * that never arrives a failed assertion rather than a hung suite.
 *
 * @param stats The module instance's stats reader.
 * @returns How many turns were spent.
 */
async function drainToCompletion(
  stats: () => { readonly buffered: number } = getTransportStats,
): Promise<number> {
  for (let turn = 1; turn <= MAX_WAITED_TURNS; turn += 1) {
    await nextTurn();
    if (stats().buffered === 0) {
      return turn;
    }
  }
  return MAX_WAITED_TURNS;
}

/**
 * Yield macrotasks until a page listener has seen `expected` messages, or the
 * patience runs out.
 *
 * `window.postMessage` delivers on a later task, so a case asserting that a
 * posted forgery was *ignored* first has to know it *arrived*; otherwise the
 * assertion would pass on a message that was still in flight.
 *
 * @param seen How many messages the page listener has seen so far.
 * @param expected How many the case posted.
 * @returns How many had arrived when the wait ended.
 */
async function waitForPageMessages(seen: () => number, expected: number): Promise<number> {
  for (let turn = 0; turn < MAX_WAITED_TURNS && seen() < expected; turn += 1) {
    await nextTurn();
  }
  return seen();
}

/*
 * ---------------------------------------------------------------------------
 * Fresh module instances
 * ---------------------------------------------------------------------------
 */

/** A module namespace of the transport, from whichever evaluation. */
type TransportModule = typeof import('./transport.js');

/**
 * A fresh evaluation of the module under test, with an unspent handshake.
 *
 * The node and the answered-a-request latch are document-scoped and cleared by
 * nothing — that is the lifetime a second capture on one document depends
 * on — so a case that needs an *unspent* handshake cannot get one by
 * resetting. A fresh instance is the only way, and this module supports it
 * because it has no import-time side effects: the new evaluation installs
 * nothing until it is subscribed to. The caller resets it in a `finally`.
 *
 * @returns The fresh module namespace.
 */
async function freshTransport(): Promise<TransportModule> {
  vi.resetModules();
  return import('./transport.js');
}

/** A fresh module instance whose frame constructor the page broke. */
interface RefusingChannel {
  /** The instance. */
  readonly transport: TransportModule;
  /** A fake bridge connected to it. */
  readonly bridge: FakeBridge;
  /** How many agent frames it tried to construct. */
  readonly attempts: () => number;
}

/**
 * A fresh module instance evaluated while `CustomEvent` refused to construct an
 * agent frame, connected to a fake bridge of its own.
 *
 * The product's `refused` outcome: the frame was rendered and measured, and
 * the platform would still not carry it. The stub is global only for the
 * instant the fresh instance captures its constructors, and a subclass of the
 * real constructor so the captured `detail` getter is still found; every other
 * event type, and every event after the import, is built as usual.
 *
 * @returns The instance, its bridge and its attempt count.
 */
async function refusingChannel(): Promise<RefusingChannel> {
  const NativeCustomEvent = CustomEvent;
  let attempts = 0;

  class RefusingCustomEvent<T> extends NativeCustomEvent<T> {
    constructor(type: string, init?: CustomEventInit<T>) {
      if (type === AGENT_FRAME_EVENT) {
        attempts += 1;
        throw new Error('the page refused to construct the frame');
      }
      super(type, init);
    }
  }

  vi.stubGlobal('CustomEvent', RefusingCustomEvent);
  let transport: TransportModule;
  try {
    transport = await freshTransport();
  } finally {
    vi.unstubAllGlobals();
  }

  return {
    transport,
    bridge: connectFakeBridge(transport),
    attempts: () => attempts,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------
 */

/** The current case's subscription, held so teardown can remove the listener. */
let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  resetTransport();
  bridge.clear();
  // The node's frame listener exists only while something is subscribed, and
  // every case sends at least the bridge's own frames through it.
  unsubscribe = subscribe(() => undefined);
  configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_A, enabled: true });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTransport();
  bridge.clear();
});

/*
 * ---------------------------------------------------------------------------
 * The batch threshold
 * ---------------------------------------------------------------------------
 */

describe('MAX_EVENTS_PER_BATCH', () => {
  beforeEach(() => {
    bridge.send('bridge.ready');
  });

  it('holds a burst one event short of the threshold', () => {
    emitRange(MAX_EVENTS_PER_BATCH - 1);

    expect(bridge.frames).toHaveLength(0);
    expect(getTransportStats()).toMatchObject({
      buffered: MAX_EVENTS_PER_BATCH - 1,
      sent: 0,
      batches: 0,
      dropped: 0,
      bridgeReady: true,
    });
  });

  it('schedules the batch that reaches the threshold instead of dispatching it inline', async () => {
    emitRange(MAX_EVENTS_PER_BATCH);

    // The producer's stack is the thing being protected: the event that filled
    // the batch must not have paid for serialising it.
    expect(bridge.frames).toHaveLength(0);
    expect(getTransportStats().buffered).toBe(MAX_EVENTS_PER_BATCH);

    await drainToCompletion();

    const batches = batchViews();
    expect(batches).toHaveLength(1);
    expect(at(batches, 0, 'the claimed batches').events).toHaveLength(MAX_EVENTS_PER_BATCH);
    expect(bridge.frames).toHaveLength(1);
    expect(deliveredOrder()).toEqual(indexRange(0, MAX_EVENTS_PER_BATCH));
    expect(getTransportStats()).toMatchObject({
      buffered: 0,
      sent: MAX_EVENTS_PER_BATCH,
      batches: 1,
      dropped: 0,
    });
  });

  it('dispatches one full batch and the remainder, in emission order, one event over', async () => {
    const total = MAX_EVENTS_PER_BATCH + 1;
    emitRange(total);

    expect(bridge.frames).toHaveLength(0);
    expect(getTransportStats().buffered).toBe(total);

    await drainToCompletion();

    const sizes = batchViews().map((batch) => batch.events.length);
    expect(sizes).toEqual([MAX_EVENTS_PER_BATCH, 1]);
    expect(deliveredOrder()).toEqual(indexRange(0, total));
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: total, batches: 2 });
  });

  it('numbers consecutive batches from zero and repeats none of their events', async () => {
    emitRange(MAX_EVENTS_PER_BATCH * 3);

    await drainToCompletion();

    const batches = batchViews();
    expect(batches.map((batch) => batch.batchSeq)).toEqual([0, 1, 2]);
    expect(runShapeOf(deliveredSeqs())).toEqual(contiguousRun(0, MAX_EVENTS_PER_BATCH * 3));
  });
});

/*
 * ---------------------------------------------------------------------------
 * The buffer cap
 *
 * Every case here runs with the bridge away, which is the state AAP §0.5.5
 * describes: nothing is dispatched, nothing is scheduled, and the ring is the
 * only thing between a render storm and the page's memory.
 * ---------------------------------------------------------------------------
 */

describe('MAX_BUFFERED_EVENTS with the bridge away', () => {
  it('buffers a burst one event short of the cap without dropping anything', () => {
    emitRange(MAX_BUFFERED_EVENTS - 1);

    expect(getTransportStats()).toMatchObject({
      buffered: MAX_BUFFERED_EVENTS - 1,
      dropped: 0,
      sent: 0,
      bridgeReady: false,
    });
    expect(bridge.frames).toHaveLength(0);
  });

  it('buffers exactly the cap without dropping anything', () => {
    emitRange(MAX_BUFFERED_EVENTS);

    expect(getTransportStats()).toMatchObject({
      buffered: MAX_BUFFERED_EVENTS,
      dropped: 0,
      sent: 0,
    });
    expect(bridge.frames).toHaveLength(0);
  });

  it('evicts exactly the oldest event for the one that goes over the cap', async () => {
    emitRange(MAX_BUFFERED_EVENTS + 1);

    expect(getTransportStats()).toMatchObject({ buffered: MAX_BUFFERED_EVENTS, dropped: 1 });

    expect(bridge.send('bridge.ready')).toBe(true);

    // Recovery starts in the handler and is bounded there like every other
    // non-terminal drain: a full queue is twenty-five batches, and dispatching
    // all of them inside the bridge's one dispatch would be the long task the
    // scheduled drain exists to avoid. The rest arrives on the turns that
    // follow.
    expect(batchViews()).toHaveLength(MAX_BATCHES_PER_DRAIN);
    expect(getTransportStats().buffered).toBe(
      MAX_BUFFERED_EVENTS - MAX_BATCHES_PER_DRAIN * MAX_EVENTS_PER_BATCH,
    );

    await drainToCompletion();

    expect(getTransportStats().buffered).toBe(0);
    expect(runShapeOf(deliveredOrder())).toEqual(contiguousRun(1, MAX_BUFFERED_EVENTS));
    expect(getTransportStats()).toMatchObject({
      dropped: 1,
      sent: MAX_BUFFERED_EVENTS,
      serializationFailures: 0,
    });
  });

  it('keeps order across the ring wrap-around when the overflow is deep', async () => {
    const overflow = 137;
    emitRange(MAX_BUFFERED_EVENTS + overflow);

    expect(getTransportStats()).toMatchObject({
      buffered: MAX_BUFFERED_EVENTS,
      dropped: overflow,
    });

    bridge.send('bridge.ready');
    await drainToCompletion();

    expect(runShapeOf(deliveredOrder())).toEqual(contiguousRun(overflow, MAX_BUFFERED_EVENTS));
    expect(batchViews()).toHaveLength(MAX_BUFFERED_EVENTS / MAX_EVENTS_PER_BATCH);
  });

  it('reports the accumulated loss on exactly one batch and then starts a fresh count', async () => {
    const overflow = 137;
    emitRange(MAX_BUFFERED_EVENTS + overflow);
    bridge.send('bridge.ready');
    await drainToCompletion();

    const reported = batchViews().map((batch) => batch.droppedCount);
    // The length matters as much as the values: "every other batch reported
    // nothing" is only an assertion if there were other batches.
    expect(reported).toHaveLength(MAX_BUFFERED_EVENTS / MAX_EVENTS_PER_BATCH);
    expect(at(reported, 0, 'the reported drop counts')).toBe(overflow);
    expect(reported.slice(1).every((count) => count === 0)).toBe(true);

    // Cumulative in the stats, reported once on the wire: the next batch says
    // nothing was lost, because nothing was lost since the last one.
    expect(getTransportStats().dropped).toBe(overflow);

    bridge.clear();
    emitRange(1, MAX_BUFFERED_EVENTS + overflow);
    flush();

    const followUp = batchViews();
    expect(followUp).toHaveLength(1);
    expect(at(followUp, 0, 'the follow-up batches').droppedCount).toBe(0);
    expect(getTransportStats().dropped).toBe(overflow);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Stamping and order
 * ---------------------------------------------------------------------------
 */

describe('stable order and stamping', () => {
  it('leaves a gap in seq exactly where the ring dropped events', async () => {
    bridge.send('bridge.ready');
    emitRange(MAX_EVENTS_PER_BATCH);
    flush();

    // The bridge goes away with the sequence part-used, so the events the ring
    // evicts are in the middle of the run rather than at its start.
    bridge.send('bridge.gone');
    emitRange(MAX_BUFFERED_EVENTS + 1, MAX_EVENTS_PER_BATCH);
    expect(getTransportStats().dropped).toBe(1);

    bridge.send('bridge.ready');
    await drainToCompletion();

    const seqs = deliveredSeqs();
    expect(runShapeOf(seqs)).toEqual({
      first: 0,
      last: MAX_EVENTS_PER_BATCH + MAX_BUFFERED_EVENTS,
      count: MAX_EVENTS_PER_BATCH + MAX_BUFFERED_EVENTS,
      increasing: true,
      // One value missing, and it is the `seq` of the one event evicted: the
      // ring reports the loss, it never renumbers around it.
      gaps: [MAX_EVENTS_PER_BATCH],
    });
    expect(deliveredOrder()).toEqual(seqs);
  });

  it('stamps every event with the browser tier and this document\u2019s producer id', async () => {
    bridge.send('bridge.ready');
    emitRange(MAX_EVENTS_PER_BATCH + 1);
    await drainToCompletion();

    const events = deliveredEvents();
    expect(events).toHaveLength(MAX_EVENTS_PER_BATCH + 1);
    expect(new Set(events.map((event) => event.tier))).toEqual(new Set(['browser']));
    expect(new Set(events.map((event) => event.producerId))).toEqual(new Set([getProducerId()]));
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);

    for (const batch of batchViews()) {
      expect(batch.keys).toEqual([
        'batchSeq',
        'captureId',
        'documentId',
        'droppedCount',
        'events',
        'producerId',
        'sessionId',
      ]);
      expect(batch.producerId).toBe(getProducerId());
      expect(batch.captureId).toBe(CAPTURE_A);
      expect(batch.sessionId).toBe(SESSION_ID);
    }
  });

  it('keeps a whole commit\u2019s drafts together and in order', () => {
    bridge.send('bridge.ready');
    emitMany(indexRange(0, MAX_EVENTS_PER_BATCH).map((index) => renderDraft(index)));
    flush();

    expect(deliveredOrder()).toEqual(indexRange(0, MAX_EVENTS_PER_BATCH));
    expect(runShapeOf(deliveredSeqs())).toEqual(contiguousRun(0, MAX_EVENTS_PER_BATCH));
  });
});

/*
 * ---------------------------------------------------------------------------
 * The drain bound
 * ---------------------------------------------------------------------------
 */

describe('MAX_BATCHES_PER_DRAIN', () => {
  it('dispatches at most the bound in one scheduled turn and reschedules the rest', async () => {
    // The microtask fallback runs the same drain body as the channel route and
    // is the only route whose turn boundary a probe can sit on. `beforeEach`
    // has already closed any cached channel, so stubbing it away here is enough
    // to take that route for the whole case.
    vi.stubGlobal('MessageChannel', undefined);
    bridge.send('bridge.ready');

    const extraBatches = 2;
    const total = MAX_EVENTS_PER_BATCH * (MAX_BATCHES_PER_DRAIN + extraBatches);
    emitRange(total);

    let batchesAfterOneTurn = -1;
    let bufferedAfterOneTurn = -1;
    // Queued after the drain the emitting loop scheduled and before the
    // continuation that drain will schedule for itself, because microtasks run
    // in the order they were queued.
    queueMicrotask(() => {
      batchesAfterOneTurn = batchViews().length;
      bufferedAfterOneTurn = getTransportStats().buffered;
    });

    expect(bridge.frames).toHaveLength(0);

    await nextTurn();

    expect(batchesAfterOneTurn).toBe(MAX_BATCHES_PER_DRAIN);
    expect(bufferedAfterOneTurn).toBe(MAX_EVENTS_PER_BATCH * extraBatches);

    await drainToCompletion();

    expect(batchViews()).toHaveLength(MAX_BATCHES_PER_DRAIN + extraBatches);
    expect(deliveredOrder()).toEqual(indexRange(0, total));
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: total });
  });

  it('bounds the drain that recovers a queue the bridge was away for', async () => {
    // The Manifest V3 case: the service worker suspended, the bridge said it
    // was gone, and the queue filled while it was. Recovery is not a terminal
    // moment — the page is still there and there will be more turns — so it
    // gets the same per-turn bound as the threshold path, and the assertion
    // below needs no probe: the bound is observable at the synchronous return
    // of the bridge's dispatch of `bridge.ready`.
    const extraBatches = 3;
    const total = MAX_EVENTS_PER_BATCH * (MAX_BATCHES_PER_DRAIN + extraBatches);
    emitRange(total);
    expect(getTransportStats()).toMatchObject({ buffered: total, bridgeReady: false });
    expect(bridge.frames).toHaveLength(0);

    bridge.send('bridge.ready');

    expect(batchViews()).toHaveLength(MAX_BATCHES_PER_DRAIN);
    expect(getTransportStats().buffered).toBe(MAX_EVENTS_PER_BATCH * extraBatches);

    await drainToCompletion();

    expect(batchViews()).toHaveLength(MAX_BATCHES_PER_DRAIN + extraBatches);
    expect(deliveredOrder()).toEqual(indexRange(0, total));
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: total, dropped: 0 });
  });

  it('empties a queue deeper than the bound in one synchronous flush', () => {
    bridge.send('bridge.ready');

    const total = MAX_EVENTS_PER_BATCH * (MAX_BATCHES_PER_DRAIN + 2);
    emitRange(total);
    expect(bridge.frames).toHaveLength(0);

    flush();

    // `pagehide` has no later turn to rely on, so `flush` is unbounded by
    // design: everything is in the bridge's custody when it returns.
    expect(batchViews()).toHaveLength(MAX_BATCHES_PER_DRAIN + 2);
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: total });
    expect(deliveredOrder()).toEqual(indexRange(0, total));
  });
});

/*
 * ---------------------------------------------------------------------------
 * Failing and partial sends
 * ---------------------------------------------------------------------------
 */

describe('failing and partial sends', () => {
  it('drops a refused batch whole, counts it, and does not split it', async () => {
    const refusing = await refusingChannel();
    const { transport } = refusing;
    const stop = transport.subscribe(() => undefined);

    try {
      transport.configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_A, enabled: true });
      expect(refusing.bridge.send('bridge.ready')).toBe(true);
      for (let index = 0; index < MAX_EVENTS_PER_BATCH; index += 1) {
        transport.emit(renderDraft(index));
      }

      transport.flush();

      // One attempt at the batch, not nine: a frame the platform refused to
      // construct would fail the same way in halves, so halving it would only
      // multiply the cost. And it is dropped, not requeued: a refusal is not a
      // bridge that might come back. The one attempt after it is the flush's
      // loss-only report of the batch it just lost — no batch is left to carry
      // that count — which this platform refuses too, so the count stays
      // pending and nothing further is tried.
      expect(refusing.attempts()).toBe(2);
      expect(refusing.bridge.frames).toHaveLength(0);
      expect(transport.getTransportStats()).toMatchObject({
        buffered: 0,
        sent: 0,
        batches: 0,
        dropped: MAX_EVENTS_PER_BATCH,
        serializationFailures: MAX_EVENTS_PER_BATCH,
        bridgeReady: true,
      });
    } finally {
      stop();
      transport.resetTransport();
    }
  });

  it('halves an oversize batch until it fits', () => {
    bridge.send('bridge.ready');
    emitOversizeRun(emit);

    flush();

    const sizes = batchViews().map((batch) => batch.events.length);
    expect(sizes).toEqual([OVERSIZE_BATCH_EVENTS / 2, OVERSIZE_BATCH_EVENTS / 2]);
    expect(deliveredOrder()).toEqual(indexRange(0, OVERSIZE_BATCH_EVENTS));
    // Only the halves were dispatched: the whole batch was measured and never
    // left the page.
    expect(bridge.frames).toHaveLength(2);
    for (const frame of bridge.frames) {
      expect(frame.detail.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    }
    expect(getTransportStats()).toMatchObject({
      sent: OVERSIZE_BATCH_EVENTS,
      dropped: 0,
      serializationFailures: 0,
    });
  });

  it('drops a single unpostable event alone and still delivers its neighbours', () => {
    bridge.send('bridge.ready');

    const tooLarge = 'x'.repeat(MAX_MESSAGE_BYTES + 1);
    emit(renderDraft(0));
    emit(renderDraft(1, { attributes: { [FILLER_ATTRIBUTE]: tooLarge } }));
    emit(renderDraft(2));

    flush();

    expect(deliveredOrder()).toEqual([0, 2]);
    expect(getTransportStats()).toMatchObject({
      sent: 2,
      dropped: 1,
      serializationFailures: 1,
      buffered: 0,
    });

    const diagnostics = bridge.framesOfType('agent.error');
    expect(diagnostics).toHaveLength(1);
    const diagnostic = at(diagnostics, 0, 'the dispatched diagnostics').payload;
    // The event's identity and nothing of its content: the attributes are what
    // made it too large, so quoting any of them would be a second copy of the
    // problem.
    expect(Object.keys(diagnostic).sort()).toEqual(['eventId', 'kind', 'limitBytes', 'reason']);
    expect(diagnostic.reason).toBe('event-too-large');
    expect(diagnostic.kind).toBe(EVENT_KIND);
    expect(diagnostic.limitBytes).toBe(MAX_MESSAGE_BYTES);
    expect(typeof diagnostic.eventId).toBe('string');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The wire
 * ---------------------------------------------------------------------------
 */

describe('the frames the agent dispatches', () => {
  it('dispatches every frame on the node as a cancelable, non-bubbling JSON string', () => {
    bridge.send('bridge.ready');
    emitRange(2);
    flush();
    postControl('agent.ready', { url: PAGE_URL });

    const types = bridge.frames.map((frame) => frame.type);
    expect(types).toEqual(['telemetry.batch', 'agent.ready']);
    for (const frame of bridge.frames) {
      expect(frame.cancelable).toBe(true);
      expect(frame.bubbles).toBe(false);
      expect(frame.source).toBe(AGENT_SOURCE_TAG);
      expect(frame.version).toBe(CHANNEL_VERSION);
      // Exactly the four fields: no token, no origin, nothing a v2 frame had.
      expect(detailKeys(frame)).toEqual(['payload', 'source', 'type', 'version']);
      expect(frame.detail.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Control frames
 * ---------------------------------------------------------------------------
 */

/**
 * A control payload whose every field is inside {@link MAX_CONTROL_TEXT_LENGTH}
 * and whose frame is still over {@link MAX_MESSAGE_BYTES}.
 *
 * That combination is the point: a per-field bound cannot bound a frame, which
 * is why the frame is measured as well.
 *
 * @returns The payload.
 */
function oversizeControlPayload(): Record<string, unknown> {
  const filler = 'x'.repeat(MAX_CONTROL_TEXT_LENGTH);
  const payload: Record<string, unknown> = {};
  for (let outer = 0; outer < CONTROL_FANOUT; outer += 1) {
    const group: Record<string, unknown> = {};
    for (let inner = 0; inner < CONTROL_FANOUT; inner += 1) {
      group[`field${String(inner)}`] = filler;
    }
    payload[`group${String(outer)}`] = group;
  }
  return payload;
}

describe('control frames', () => {
  it('refuses an oversize control frame and reports it with one fixed-size frame', () => {
    const payload = oversizeControlPayload();
    // A self-checking fixture: the case is meaningless if the payload is not
    // actually over the cap.
    expect(JSON.stringify(payload).length).toBeGreaterThan(MAX_MESSAGE_BYTES);

    postControl('agent.ready', payload);

    expect(bridge.frames).toHaveLength(1);
    const frame = at(bridge.frames, 0, 'the dispatched frames');
    expect(frame.type).toBe('agent.error');
    expect(frame.source).toBe(AGENT_SOURCE_TAG);
    expect(frame.claimed).toBe(true);
    expect(frame.detail.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(frame.payload).toEqual({
      reason: 'control-frame-too-large',
      frame: 'agent.ready',
      limitBytes: MAX_MESSAGE_BYTES,
    });
    expect(getTransportStats()).toMatchObject({
      controlFramesDropped: 1,
      dropped: 0,
      serializationFailures: 0,
    });
  });

  it('counts an unclaimed control frame and reports nothing about it', () => {
    bridge.claim = false;

    postControl('agent.ready', { url: PAGE_URL });

    // Dispatched once and not taken — the bridge's port was gone. A control
    // frame is a statement about a moment and is never retried; reporting its
    // loss on the channel that just failed to carry it would only lose a
    // second frame.
    expect(bridge.frames.map((frame) => [frame.type, frame.claimed])).toEqual([
      ['agent.ready', false],
    ]);
    expect(bridge.framesOfType('agent.error')).toHaveLength(0);
    expect(getTransportStats()).toMatchObject({ controlFramesDropped: 1, dropped: 0 });
  });

  it('counts an oversize control frame whose diagnostic nobody claims, and stops there', () => {
    bridge.claim = false;

    postControl('agent.ready', oversizeControlPayload());

    // The oversize frame is never dispatched; the diagnostic is, once, and its
    // loss is counted rather than reported again.
    expect(bridge.frames.map((frame) => [frame.type, frame.claimed])).toEqual([
      ['agent.error', false],
    ]);
    expect(getTransportStats().controlFramesDropped).toBe(2);
  });

  it('does not recurse when the channel refuses the diagnostic as well', async () => {
    const refusing = await refusingChannel();
    const { transport } = refusing;

    try {
      transport.postControl('agent.ready', oversizeControlPayload());

      // Exactly one attempt: the oversize frame was measured and rejected
      // before construction, and the diagnostic that replaced it is not
      // reported again when it fails — it is only counted. Two frames the
      // channel would not take, one attempt, no recursion.
      expect(refusing.attempts()).toBe(1);
      expect(refusing.bridge.frames).toHaveLength(0);
      expect(transport.getTransportStats().controlFramesDropped).toBe(2);
    } finally {
      transport.resetTransport();
    }
  });

  it('reports a refused control frame once and attempts nothing further', async () => {
    const refusing = await refusingChannel();
    const { transport } = refusing;

    try {
      transport.postControl('agent.ready', { url: PAGE_URL });

      expect(refusing.attempts()).toBe(1);
      expect(refusing.bridge.frames).toHaveLength(0);
      expect(transport.getTransportStats().controlFramesDropped).toBe(1);
    } finally {
      transport.resetTransport();
    }
  });

  it('bounds control text at the limit and truncates one character over it', () => {
    const atLimit = 'u'.repeat(MAX_CONTROL_TEXT_LENGTH);
    const overLimit = 'u'.repeat(MAX_CONTROL_TEXT_LENGTH + 1);

    expect(boundControlText(atLimit)).toBe(atLimit);
    expect(boundControlText(overLimit)).toHaveLength(MAX_CONTROL_TEXT_LENGTH);

    postControl('agent.ready', { url: overLimit });

    const url = at(bridge.frames, 0, 'the dispatched frames').payload.url;
    if (typeof url !== 'string') {
      throw new Error('the control frame carried no url string');
    }
    expect(url).toHaveLength(MAX_CONTROL_TEXT_LENGTH);
    expect(getTransportStats().controlFramesDropped).toBe(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Custody
 *
 * A batch leaves the page only when the bridge claims it. Every case below
 * varies one thing — whether, and which, frame the bridge takes — and asserts
 * the four quantities custody keeps honest: what is still queued, what was
 * counted as sent, the `batchSeq` the next claimed batch carries, and the
 * `droppedCount` it reports.
 * ---------------------------------------------------------------------------
 */

describe('custody of a batch', () => {
  it('lets a claimed batch leave the queue and advances the batch sequence', () => {
    bridge.send('bridge.ready');
    emitRange(3);
    flush();
    emitRange(2, 3);
    flush();

    expect(dispatchedBatchViews().map((batch) => [batch.batchSeq, batch.claimed])).toEqual([
      [0, true],
      [1, true],
    ]);
    expect(deliveredOrder()).toEqual(indexRange(0, 5));
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: 5, batches: 2, dropped: 0 });
  });

  it('requeues an unclaimed batch in order, marks the bridge away and moves no counter', () => {
    bridge.send('bridge.ready');
    emitRange(5);
    bridge.claim = false;

    flush();

    const attempted = dispatchedBatchViews();
    expect(attempted).toHaveLength(1);
    const unclaimed = at(attempted, 0, 'the dispatched batches');
    expect(unclaimed).toMatchObject({ claimed: false, batchSeq: 0, droppedCount: 0 });
    expect(batchOrder(unclaimed)).toEqual(indexRange(0, 5));
    expect(getTransportStats()).toMatchObject({
      buffered: 5,
      sent: 0,
      batches: 0,
      dropped: 0,
      bridgeReady: false,
    });

    // The bridge is away now, so nothing more is dispatched into a channel
    // with nobody at the other end: a flush keeps the queue.
    emitRange(2, 5);
    flush();
    expect(bridge.frames).toHaveLength(1);
    expect(getTransportStats().buffered).toBe(7);
  });

  it('delivers a requeued batch after the next bridge.ready, once, under the same batchSeq', () => {
    bridge.send('bridge.ready');
    emitRange(5);
    bridge.claim = false;
    flush();
    emitRange(2, 5);

    bridge.claim = true;
    expect(bridge.send('bridge.ready')).toBe(true);

    // The retry is the batch the bridge missed plus what was queued behind it,
    // under the `batchSeq` the missed one carried: the service sees no gap in
    // the batch sequence and no event twice.
    const delivered = batchViews();
    expect(delivered).toHaveLength(1);
    expect(at(delivered, 0, 'the claimed batches')).toMatchObject({
      batchSeq: 0,
      droppedCount: 0,
    });
    expect(deliveredOrder()).toEqual(indexRange(0, 7));
    expect(runShapeOf(deliveredSeqs())).toEqual(contiguousRun(0, 7));
    expect(new Set(deliveredEvents().map((event) => event.id)).size).toBe(7);
    expect(getTransportStats()).toMatchObject({
      buffered: 0,
      sent: 7,
      batches: 1,
      dropped: 0,
      bridgeReady: true,
    });
  });

  it('carries a pending drop count until a batch reporting it is claimed', async () => {
    const overflow = 3;
    emitRange(MAX_BUFFERED_EVENTS + overflow);
    bridge.claim = false;

    bridge.send('bridge.ready');

    // The recovery drain's first batch reported the loss and nobody took it,
    // so the loss is still pending: it is not cleared by a frame the bridge
    // never held.
    const missed = dispatchedBatchViews();
    expect(missed).toHaveLength(1);
    expect(at(missed, 0, 'the dispatched batches')).toMatchObject({
      claimed: false,
      droppedCount: overflow,
      batchSeq: 0,
    });
    expect(getTransportStats()).toMatchObject({
      buffered: MAX_BUFFERED_EVENTS,
      dropped: overflow,
      bridgeReady: false,
    });

    bridge.claim = true;
    bridge.send('bridge.ready');
    await drainToCompletion();

    const delivered = batchViews();
    expect(delivered).toHaveLength(MAX_BUFFERED_EVENTS / MAX_EVENTS_PER_BATCH);
    expect(delivered.map((batch) => batch.batchSeq)).toEqual(
      indexRange(0, MAX_BUFFERED_EVENTS / MAX_EVENTS_PER_BATCH),
    );
    expect(at(delivered, 0, 'the claimed batches').droppedCount).toBe(overflow);
    expect(delivered.slice(1).every((batch) => batch.droppedCount === 0)).toBe(true);
    expect(runShapeOf(deliveredOrder())).toEqual(contiguousRun(overflow, MAX_BUFFERED_EVENTS));
    expect(getTransportStats()).toMatchObject({ dropped: overflow, sent: MAX_BUFFERED_EVENTS });
  });

  it('keeps the queue bound when a requeue meets a queue that filled meanwhile', async () => {
    bridge.send('bridge.ready');
    emitRange(MAX_EVENTS_PER_BATCH);

    // While the bridge holds the first batch, the page keeps producing — enough
    // to leave room for only part of that batch when it comes back unclaimed.
    const room = 50;
    const produced = MAX_BUFFERED_EVENTS - room;
    bridge.claim = (frame) => {
      if (frame.type === 'telemetry.batch' && bridge.framesOfType('telemetry.batch').length === 1) {
        emitRange(produced, MAX_EVENTS_PER_BATCH);
      }
      return false;
    };

    flush();

    // The oldest events there are — the head of the requeued batch — are the
    // ones evicted, counted, and reported on the next claimed batch; the rest
    // keep their place at the front.
    const evicted = MAX_EVENTS_PER_BATCH - room;
    expect(getTransportStats()).toMatchObject({
      buffered: MAX_BUFFERED_EVENTS,
      dropped: evicted,
      sent: 0,
      bridgeReady: false,
    });

    bridge.claim = true;
    bridge.send('bridge.ready');
    await drainToCompletion();

    expect(runShapeOf(deliveredOrder())).toEqual(contiguousRun(evicted, MAX_BUFFERED_EVENTS));
    const delivered = batchViews();
    expect(at(delivered, 0, 'the claimed batches')).toMatchObject({
      batchSeq: 0,
      droppedCount: evicted,
    });
  });

  it('requeues an unclaimed first half together with the half it never dispatched', () => {
    bridge.send('bridge.ready');
    emitOversizeRun(emit);
    bridge.claim = false;

    flush();

    // Halving meets the unclaimed first half and stops: the second half is not
    // dispatched into a channel that just refused one, and both go back.
    const attempted = dispatchedBatchViews();
    expect(attempted.map((batch) => batchOrder(batch))).toEqual([
      indexRange(0, OVERSIZE_BATCH_EVENTS / 2),
    ]);
    expect(getTransportStats()).toMatchObject({
      buffered: OVERSIZE_BATCH_EVENTS,
      sent: 0,
      bridgeReady: false,
    });

    bridge.claim = true;
    bridge.send('bridge.ready');

    expect(batchViews().map((batch) => [batch.batchSeq, batchOrder(batch)])).toEqual([
      [0, indexRange(0, OVERSIZE_BATCH_EVENTS / 2)],
      [1, indexRange(OVERSIZE_BATCH_EVENTS / 2, OVERSIZE_BATCH_EVENTS / 2)],
    ]);
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: OVERSIZE_BATCH_EVENTS });
  });

  it('stops a drain at an unclaimed half and puts every later half behind it', () => {
    bridge.send('bridge.ready');
    // An oversize run at the head of the queue, then enough small events to
    // make a second batch: the first batch is halved several times over, and
    // the queue holds a batch the drain must not reach.
    emitOversizeRun(emit);
    const total = MAX_EVENTS_PER_BATCH + OVERSIZE_BATCH_EVENTS;
    emitRange(total - OVERSIZE_BATCH_EVENTS, OVERSIZE_BATCH_EVENTS);

    // The bridge takes the first frame and its port dies on the second.
    bridge.claim = () => bridge.frames.length === 1;

    flush();

    const attempted = dispatchedBatchViews();
    expect(attempted.map((batch) => batch.claimed)).toEqual([true, false]);
    const first = batchOrder(at(attempted, 0, 'the dispatched batches'));
    const second = batchOrder(at(attempted, 1, 'the dispatched batches'));
    expect(first).toEqual(indexRange(0, first.length));
    expect(second).toEqual(indexRange(first.length, second.length));
    for (const frame of bridge.frames) {
      expect(frame.detail.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    }
    expect(getTransportStats()).toMatchObject({
      buffered: total - first.length,
      sent: first.length,
      batches: 1,
      bridgeReady: false,
    });

    bridge.claim = true;
    bridge.send('bridge.ready');

    // Everything after the claimed half arrives, in order, after it: the
    // unclaimed half first, then the halves it held back, then the batch the
    // drain never reached — and the sequence carries on from the claimed one.
    expect(runShapeOf(deliveredOrder())).toEqual(contiguousRun(0, total));
    const batchSeqs = batchViews().map((batch) => batch.batchSeq);
    expect(batchSeqs).toEqual(indexRange(0, batchSeqs.length));
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: total, dropped: 0 });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Re-entrancy
 *
 * The bridge's listener runs inside the agent's dispatch, and whatever it hands
 * back is handled inside that same stack. Each case hands back one thing from
 * inside the first batch's dispatch, through the fake bridge's claim policy.
 * ---------------------------------------------------------------------------
 */

describe('frames handed back from inside a dispatch', () => {
  /**
   * A claim policy that runs `inside` during the first `telemetry.batch`
   * dispatch and answers `claimFirst` for it, and claims every later frame.
   *
   * @param inside What the bridge does from inside its listener.
   * @param claimFirst Whether it takes that first batch.
   * @returns The policy.
   */
  function onFirstBatch(inside: () => void, claimFirst: boolean): FakeBridge['claim'] {
    let done = false;
    return (frame) => {
      if (done || frame.type !== 'telemetry.batch') {
        return true;
      }
      done = true;
      inside();
      return claimFirst;
    };
  }

  it('stops the drain at a bridge.gone and resumes it at the next bridge.ready', () => {
    bridge.send('bridge.ready');
    emitRange(MAX_EVENTS_PER_BATCH * 3);
    bridge.claim = onFirstBatch(() => {
      bridge.send('bridge.gone');
    }, true);

    flush();

    // The batch in the bridge's hands was taken; nothing after it was
    // dispatched into the channel the bridge just said was closed.
    expect(dispatchedBatchViews()).toHaveLength(1);
    expect(getTransportStats()).toMatchObject({
      sent: MAX_EVENTS_PER_BATCH,
      buffered: MAX_EVENTS_PER_BATCH * 2,
      bridgeReady: false,
    });

    bridge.send('bridge.ready');

    expect(batchViews().map((batch) => batch.batchSeq)).toEqual([0, 1, 2]);
    expect(deliveredOrder()).toEqual(indexRange(0, MAX_EVENTS_PER_BATCH * 3));
  });

  it('keeps the bridge present when bridge.ready arrives during an unclaimed dispatch', async () => {
    bridge.send('bridge.ready');
    emitRange(3);
    // The bridge's old port refused the batch and its new one announced itself
    // in the same listener call: a reconnect inside the dispatch.
    bridge.claim = onFirstBatch(() => {
      bridge.send('bridge.ready');
    }, false);

    flush();

    // Not marked away — that would wait for a second `bridge.ready` nobody is
    // going to send — and the batch is back at the front for the retry the
    // drain scheduled.
    expect(getTransportStats()).toMatchObject({ buffered: 3, sent: 0, bridgeReady: true });

    await drainToCompletion();

    expect(dispatchedBatchViews().map((batch) => [batch.batchSeq, batch.claimed])).toEqual([
      [0, false],
      [0, true],
    ]);
    expect(deliveredOrder()).toEqual([0, 1, 2]);
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: 3, batches: 1 });
  });

  it('leaves a flush requested inside a dispatch to the drain already running', () => {
    bridge.send('bridge.ready');
    emitRange(MAX_EVENTS_PER_BATCH * 2);
    // What `./agent.ts` does on `bridge.ready`: re-announce and flush. A second
    // drain started here would dispatch the batch queued behind the one still
    // in the bridge's hands, under the same `batchSeq`.
    bridge.claim = onFirstBatch(() => {
      bridge.send('bridge.ready');
      flush();
    }, true);

    flush();

    expect(batchViews().map((batch) => batch.batchSeq)).toEqual([0, 1]);
    expect(deliveredOrder()).toEqual(indexRange(0, MAX_EVENTS_PER_BATCH * 2));
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: MAX_EVENTS_PER_BATCH * 2 });
  });

  it('settles a claimed batch to its own capture when the capture changes under it', () => {
    bridge.send('bridge.ready');
    const behind = 5;
    emitRange(MAX_EVENTS_PER_BATCH + behind);
    bridge.claim = onFirstBatch(() => {
      configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_B, enabled: true });
    }, true);

    flush();

    // The batch was built for, and claimed under, the capture that ended; the
    // events queued behind it can no longer be labelled and are counted as
    // lost, never relabelled.
    const first = at(batchViews(), 0, 'the claimed batches');
    expect(first).toMatchObject({ captureId: CAPTURE_A, batchSeq: 0 });
    expect(getTransportStats()).toMatchObject({
      sent: MAX_EVENTS_PER_BATCH,
      batches: 1,
      dropped: behind,
      buffered: 0,
      seq: 0,
    });

    bridge.clear();
    emitRange(2);
    flush();

    const next = at(batchViews(), 0, 'the claimed batches');
    expect(next).toMatchObject({ captureId: CAPTURE_B, batchSeq: 0, droppedCount: 0 });
    expect(deliveredSeqs()).toEqual([0, 1]);
  });

  it('counts an unclaimed batch lost when the capture changes under it', () => {
    bridge.send('bridge.ready');
    emitRange(4);
    bridge.claim = onFirstBatch(() => {
      configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_B, enabled: true });
    }, false);

    flush();

    // Never requeued into the capture that replaced its own, and the channel
    // fact the refusal stated — nobody is taking frames — still holds.
    expect(getTransportStats()).toMatchObject({
      sent: 0,
      dropped: 4,
      buffered: 0,
      bridgeReady: false,
    });

    bridge.clear();
    emitRange(2);
    bridge.send('bridge.ready');

    const next = at(batchViews(), 0, 'the claimed batches');
    expect(next).toMatchObject({ captureId: CAPTURE_B, batchSeq: 0, droppedCount: 0 });
    expect(deliveredOrder()).toEqual([0, 1]);
  });

  it('settles a batch into nothing when the transport is reset under it', () => {
    bridge.send('bridge.ready');
    emitRange(3);
    bridge.claim = onFirstBatch(() => {
      resetTransport();
    }, true);

    flush();

    // A reset returns the transport to the state it had before anything was
    // configured; a batch that predates it must not reappear in the zeroed
    // counters.
    expect(bridge.frames).toHaveLength(1);
    expect(getTransportStats()).toEqual({
      buffered: 0,
      dropped: 0,
      sent: 0,
      batches: 0,
      seq: 0,
      bridgeReady: false,
      serializationFailures: 0,
      controlFramesDropped: 0,
    });

    // And the document's channel survives it: the same node carries the next
    // capture.
    unsubscribe = subscribe(() => undefined);
    configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_B, enabled: true });
    expect(bridge.send('bridge.ready')).toBe(true);
    emitRange(1);
    flush();
    expect(at(batchViews(), 1, 'the claimed batches').captureId).toBe(CAPTURE_B);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Capture transitions
 * ---------------------------------------------------------------------------
 */

describe('a capture change', () => {
  it('discards what the bridge never took, counts it, and restarts the sequence', () => {
    const abandoned = 5;
    emitRange(abandoned);
    expect(getTransportStats()).toMatchObject({
      buffered: abandoned,
      dropped: 0,
      bridgeReady: false,
    });

    configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_B, enabled: true });

    // Undeliverable and no longer attributable: counted in the cumulative
    // total, never relabelled onto the capture that replaced theirs.
    expect(getTransportStats()).toMatchObject({ buffered: 0, dropped: abandoned, seq: 0 });
    expect(bridge.frames).toHaveLength(0);

    bridge.send('bridge.ready');
    emitRange(2);
    flush();

    const batches = batchViews();
    expect(batches).toHaveLength(1);
    const batch = at(batches, 0, 'the claimed batches');
    expect(batch.captureId).toBe(CAPTURE_B);
    expect(batch.batchSeq).toBe(0);
    expect(batch.droppedCount).toBe(0);
    expect(deliveredSeqs()).toEqual([0, 1]);
    expect(getTransportStats().dropped).toBe(abandoned);
  });

  it('discards a batch its own flush dispatched and the bridge did not claim', () => {
    bridge.send('bridge.ready');
    const abandoned = 5;
    emitRange(abandoned);
    bridge.claim = false;

    configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_B, enabled: true });

    // The change flushed first, custody put the unclaimed batch back, and the
    // change then found it still queued: discarded like anything else the
    // bridge never took.
    expect(dispatchedBatchViews().map((view) => [view.captureId, view.claimed])).toEqual([
      [CAPTURE_A, false],
    ]);
    expect(getTransportStats()).toMatchObject({
      buffered: 0,
      dropped: abandoned,
      sent: 0,
      seq: 0,
      bridgeReady: false,
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Terminal loss reports
 *
 * Loss rides out on the next claimed batch's `droppedCount`, and a terminal
 * flush — `pagehide`, a hidden document, a capture that stops or changes — may
 * have no next batch. These cases pin the event-less report that closes that
 * gap: posted once, only with loss to report, under the custody rules a batch
 * of events follows.
 * ---------------------------------------------------------------------------
 */

describe('the terminal loss report', () => {
  /** Payload keys every batch carries under a capture with a session. */
  const BATCH_KEYS = [
    'batchSeq',
    'captureId',
    'documentId',
    'droppedCount',
    'events',
    'producerId',
    'sessionId',
  ];

  /**
   * Emit one draft no frame can carry, so delivery drops it alone.
   *
   * @param index The emission index.
   */
  function emitUnpostable(index: number): void {
    emit(
      renderDraft(index, { attributes: { [FILLER_ATTRIBUTE]: 'x'.repeat(MAX_MESSAGE_BYTES + 1) } }),
    );
  }

  /**
   * Whether a dispatched frame is a loss-only `telemetry.batch`.
   *
   * @param frame The frame, as the claim policy or the record sees it.
   * @returns Whether it carries no events.
   */
  function isLossReport(frame: Pick<RecordedAgentFrame, 'type' | 'payload'>): boolean {
    const events = frame.payload.events;
    return frame.type === 'telemetry.batch' && Array.isArray(events) && events.length === 0;
  }

  /** Every dispatched loss-only batch, claimed or not, in dispatch order. */
  function lossReports(): BatchView[] {
    return dispatchedBatchViews().filter((batch) => batch.events.length === 0);
  }

  /**
   * One dispatched batch as the four fields these cases compare.
   *
   * @param batch The batch.
   * @returns `[batchSeq, claimed, event count, droppedCount]`.
   */
  function positionOf(batch: BatchView): unknown[] {
    return [batch.batchSeq, batch.claimed, batch.events.length, batch.droppedCount];
  }

  /**
   * Subscribe the way `./agent.ts` does: flush on every `bridge.ready`.
   *
   * @returns The unsubscribe function.
   */
  function flushOnBridgeReady(): () => void {
    return subscribe((message) => {
      if (message.type === 'bridge.ready') {
        flush();
      }
    });
  }

  it('posts a flush\u2019s final loss as one event-less batch under the next batchSeq', () => {
    bridge.send('bridge.ready');
    emit(renderDraft(0));
    emitUnpostable(1);

    flush();

    // The dropped event was the last one queued, so no batch is left to carry
    // the loss: the flush posts it on its own, after the diagnostic naming the
    // event, and under the position the next batch would have taken.
    expect(bridge.frames.map((frame) => frame.type)).toEqual([
      'telemetry.batch',
      'agent.error',
      'telemetry.batch',
    ]);
    const batches = dispatchedBatchViews();
    expect(batches.map((batch) => positionOf(batch))).toEqual([
      [0, true, 1, 0],
      [1, true, 0, 1],
    ]);
    const report = at(batches, 1, 'the dispatched batches');
    expect(report.keys).toEqual(BATCH_KEYS);
    expect(report).toMatchObject({
      captureId: CAPTURE_A,
      sessionId: SESSION_ID,
      producerId: getProducerId(),
    });
    // A claimed `telemetry.batch`, so it counts in `batches`; it carried no
    // event, so `sent` does not move.
    expect(getTransportStats()).toMatchObject({
      buffered: 0,
      sent: 1,
      batches: 2,
      dropped: 1,
      serializationFailures: 1,
    });

    // Reported once: a second flush has nothing to say, and the next batch
    // continues the sequence with nothing lost.
    flush();
    expect(bridge.frames).toHaveLength(3);
    emit(renderDraft(2));
    flush();
    expect(
      dispatchedBatchViews()
        .slice(2)
        .map((batch) => positionOf(batch)),
    ).toEqual([[2, true, 1, 0]]);
  });

  it('never posts an empty batch for a capture that lost nothing', () => {
    bridge.send('bridge.ready');

    // An empty queue, a flush after a flush, a capture change and a stop: every
    // terminal route, and none of them has a loss to report.
    flush();
    expect(bridge.frames).toHaveLength(0);
    emitRange(3);
    flush();
    flush();
    configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_B, enabled: true });
    emitRange(2, 3);
    flush();
    configureTransport({ sessionId: undefined, captureId: undefined, enabled: false });
    flush();

    expect(dispatchedBatchViews().map((batch) => [batch.captureId, ...positionOf(batch)])).toEqual([
      [CAPTURE_A, 0, true, 3, 0],
      [CAPTURE_B, 0, true, 2, 0],
    ]);
    expect(lossReports()).toHaveLength(0);
    expect(getTransportStats()).toMatchObject({ batches: 2, dropped: 0 });
  });

  it('keeps an unclaimed report and re-sends it once, under the same batchSeq, on bridge.ready', () => {
    const stop = flushOnBridgeReady();
    try {
      bridge.send('bridge.ready');
      emit(renderDraft(0));
      emitUnpostable(1);
      // The bridge's port dies between the last batch and the report.
      bridge.claim = (frame) => !isLossReport(frame);

      flush();

      expect(dispatchedBatchViews().map((batch) => positionOf(batch))).toEqual([
        [0, true, 1, 0],
        [1, false, 0, 1],
      ]);
      // Custody: nothing moved but the bridge's presence.
      expect(getTransportStats()).toMatchObject({
        buffered: 0,
        sent: 1,
        batches: 1,
        dropped: 1,
        bridgeReady: false,
      });

      // With the bridge away a flush keeps the count and dispatches nothing.
      flush();
      expect(dispatchedBatchViews()).toHaveLength(2);

      bridge.claim = true;
      expect(bridge.send('bridge.ready')).toBe(true);

      expect(dispatchedBatchViews().map((batch) => positionOf(batch))).toEqual([
        [0, true, 1, 0],
        [1, false, 0, 1],
        [1, true, 0, 1],
      ]);
      expect(getTransportStats()).toMatchObject({ batches: 2, dropped: 1, bridgeReady: true });

      // Cleared once claimed: another `bridge.ready` repeats nothing, and the
      // next batch takes the position after the report.
      bridge.send('bridge.ready');
      emit(renderDraft(2));
      flush();
      expect(
        dispatchedBatchViews()
          .slice(3)
          .map((batch) => positionOf(batch)),
      ).toEqual([[2, true, 1, 0]]);
      expect(lossReports().filter((batch) => batch.claimed)).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('labels the report with the ending capture and starts the next capture clean', () => {
    bridge.send('bridge.ready');
    emit(renderDraft(0));
    emitUnpostable(1);

    // Nothing flushed yet: the capture change is the terminal moment, and its
    // flush is the last chance to say the ending capture lost an event.
    configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_B, enabled: true });

    expect(dispatchedBatchViews().map((batch) => [batch.captureId, ...positionOf(batch)])).toEqual([
      [CAPTURE_A, 0, true, 1, 0],
      [CAPTURE_A, 1, true, 0, 1],
    ]);
    expect(getTransportStats()).toMatchObject({ buffered: 0, seq: 0, dropped: 1 });

    emitRange(2, 2);
    flush();

    expect(
      dispatchedBatchViews()
        .slice(2)
        .map((batch) => [batch.captureId, ...positionOf(batch)]),
    ).toEqual([[CAPTURE_B, 0, true, 2, 0]]);
    expect(deliveredSeqs().slice(-2)).toEqual([0, 1]);
    expect(lossReports()).toHaveLength(1);
  });

  it('reports the loss of a capture that stops under that capture', () => {
    bridge.send('bridge.ready');
    emit(renderDraft(0));
    emitUnpostable(1);

    // `./agent.ts`'s disarm, reduced to the transport's part of it.
    configureTransport({ sessionId: undefined, captureId: undefined, enabled: false });

    const reports = lossReports();
    expect(reports.map((batch) => positionOf(batch))).toEqual([[1, true, 0, 1]]);
    expect(at(reports, 0, 'the loss reports')).toMatchObject({
      captureId: CAPTURE_A,
      sessionId: SESSION_ID,
    });
  });

  it('lets a later batch carry the loss instead of posting a separate report', () => {
    const stop = flushOnBridgeReady();
    try {
      const overflow = 3;
      emitRange(MAX_BUFFERED_EVENTS + overflow);
      expect(getTransportStats()).toMatchObject({ dropped: overflow, bridgeReady: false });

      bridge.send('bridge.ready');

      // The recovery drain and the flush `./agent.ts` runs on `bridge.ready`
      // empty the queue, and the first batch already carried the eviction: no
      // report follows, because nothing is left for one to say.
      const expectedBatches = MAX_BUFFERED_EVENTS / MAX_EVENTS_PER_BATCH;
      const batches = dispatchedBatchViews();
      expect(batches).toHaveLength(expectedBatches);
      expect(batches.every((batch) => batch.claimed && batch.events.length > 0)).toBe(true);
      expect(batches.map((batch) => batch.droppedCount)).toEqual([
        overflow,
        ...Array.from({ length: expectedBatches - 1 }, () => 0),
      ]);
      expect(batches.map((batch) => batch.batchSeq)).toEqual(indexRange(0, expectedBatches));
      expect(lossReports()).toHaveLength(0);
      expect(getTransportStats()).toMatchObject({
        buffered: 0,
        batches: expectedBatches,
        dropped: overflow,
      });

      flush();
      expect(dispatchedBatchViews()).toHaveLength(expectedBatches);
    } finally {
      stop();
    }
  });

  it('posts one report when a bridge.ready and a flush come back from inside it', () => {
    bridge.send('bridge.ready');
    emit(renderDraft(0));
    emitUnpostable(1);
    let handedBack = false;
    bridge.claim = (frame) => {
      if (!handedBack && isLossReport(frame)) {
        handedBack = true;
        // What `./agent.ts` does on `bridge.ready`, from inside the report's own
        // dispatch: a second report here would repeat the same batchSeq.
        bridge.send('bridge.ready');
        flush();
      }
      return true;
    };

    flush();

    expect(lossReports().map((batch) => positionOf(batch))).toEqual([[1, true, 0, 1]]);
    expect(getTransportStats()).toMatchObject({ batches: 2, bridgeReady: true });

    emit(renderDraft(2));
    flush();
    expect(dispatchedBatchViews().map((batch) => batch.batchSeq)).toEqual([0, 1, 2]);
  });

  it('settles a report to its own capture when the capture changes under it', () => {
    bridge.send('bridge.ready');
    emit(renderDraft(0));
    emitUnpostable(1);
    let changed = false;
    bridge.claim = (frame) => {
      if (!changed && isLossReport(frame)) {
        changed = true;
        configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_B, enabled: true });
      }
      return true;
    };

    flush();

    // Claimed under the capture it was built for; the capture that replaced it
    // keeps its own fresh position and count.
    expect(lossReports().map((batch) => [batch.captureId, ...positionOf(batch)])).toEqual([
      [CAPTURE_A, 1, true, 0, 1],
    ]);
    expect(getTransportStats()).toMatchObject({ batches: 2, dropped: 1, seq: 0 });

    emitRange(1, 2);
    flush();
    expect(
      dispatchedBatchViews()
        .slice(2)
        .map((batch) => [batch.captureId, ...positionOf(batch)]),
    ).toEqual([[CAPTURE_B, 0, true, 1, 0]]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The inbound guard
 *
 * Every case dispatches on the real channel node — the only place the agent
 * listens — so what separates an accepted frame from a dropped one is the
 * frame's own shape, and "dropped" means three observable things: the bridge's
 * dispatch was not acknowledged, no subscriber was called, and the bridge is
 * still considered absent with the queued event still queued.
 * ---------------------------------------------------------------------------
 */

/**
 * The `detail` of a well-formed `bridge.ready` padded to an exact length.
 *
 * @param length The length the detail must have.
 * @returns The detail.
 */
function paddedReadyDetail(length: number): string {
  const unpadded = bridgeFrameDetail('bridge.ready', { pad: '' });
  const padding = length - unpadded.length;
  if (padding < 0) {
    throw new Error(`a bridge.ready detail cannot be as short as ${String(length)}`);
  }
  return bridgeFrameDetail('bridge.ready', { pad: 'p'.repeat(padding) });
}

/** One malformed inbound frame and what makes it so. */
interface MalformedFrame {
  /** What is wrong with it, for the case name. */
  readonly label: string;
  /** The `detail` the bridge frame carries. */
  readonly detail: unknown;
}

/** Every shape of bridge frame the guard must drop. */
const MALFORMED_FRAMES: readonly MalformedFrame[] = [
  { label: 'a frame with no detail', detail: undefined },
  {
    label: 'a detail that is an object rather than a string',
    detail: { source: BRIDGE_SOURCE_TAG, version: CHANNEL_VERSION, type: 'bridge.ready' },
  },
  {
    label: 'a detail one code unit over the cap',
    detail: paddedReadyDetail(MAX_MESSAGE_BYTES + 1),
  },
  { label: 'a detail that is not JSON', detail: '{"source":"debuggen-bridge",' },
  { label: 'a JSON array', detail: JSON.stringify([BRIDGE_SOURCE_TAG, CHANNEL_VERSION]) },
  { label: 'a JSON string', detail: JSON.stringify('bridge.ready') },
  { label: 'JSON null', detail: 'null' },
  {
    label: 'the agent\u2019s own source tag',
    detail: JSON.stringify({
      source: AGENT_SOURCE_TAG,
      version: CHANNEL_VERSION,
      type: 'bridge.ready',
    }),
  },
  {
    label: 'no source tag',
    detail: JSON.stringify({ version: CHANNEL_VERSION, type: 'bridge.ready' }),
  },
  {
    label: 'the previous channel version',
    detail: JSON.stringify({
      source: BRIDGE_SOURCE_TAG,
      version: CHANNEL_VERSION - 1,
      type: 'bridge.ready',
    }),
  },
  {
    label: 'the version as a string',
    detail: JSON.stringify({
      source: BRIDGE_SOURCE_TAG,
      version: String(CHANNEL_VERSION),
      type: 'bridge.ready',
    }),
  },
  { label: 'an outbound frame type', detail: bridgeFrameDetail('telemetry.batch') },
  { label: 'an unknown frame type', detail: bridgeFrameDetail('bridge.unknown') },
];

describe('the inbound guard', () => {
  /** Frames the module accepted in the current case, in order. */
  let accepted: BridgeInboundMessage[] = [];

  /** The case's recording subscription. */
  let stopRecording: (() => void) | undefined;

  beforeEach(() => {
    accepted = [];
    stopRecording = subscribe((message) => {
      accepted.push(message);
    });
  });

  afterEach(() => {
    stopRecording?.();
    stopRecording = undefined;
  });

  it('accepts a well-formed frame, acknowledges it and drains what was queued', () => {
    emitRange(1);
    expect(getTransportStats()).toMatchObject({ buffered: 1, bridgeReady: false });

    expect(bridge.send('bridge.ready')).toBe(true);

    expect(accepted.map((message) => message.type)).toEqual(['bridge.ready']);
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: 1, bridgeReady: true });
    expect(deliveredOrder()).toEqual([0]);
  });

  it.each(MALFORMED_FRAMES)('drops $label, unacknowledged', ({ detail }) => {
    emitRange(1);

    expect(bridge.sendDetail(detail)).toBe(false);

    expect(accepted).toEqual([]);
    expect(bridge.frames).toEqual([]);
    expect(getTransportStats()).toMatchObject({ buffered: 1, sent: 0, bridgeReady: false });
  });

  it('accepts a detail exactly at the cap', () => {
    const detail = paddedReadyDetail(MAX_MESSAGE_BYTES);
    // Self-checking fixture: the boundary case is only one if it is on it.
    expect(detail).toHaveLength(MAX_MESSAGE_BYTES);

    expect(bridge.sendDetail(detail)).toBe(true);
    expect(accepted.map((message) => message.type)).toEqual(['bridge.ready']);
  });

  it('drops a plain Event of the frame type, unacknowledged', () => {
    const unclaimed = bridge.node.dispatchEvent(
      new Event(BRIDGE_FRAME_EVENT, { cancelable: true }),
    );

    expect(unclaimed).toBe(true);
    expect(accepted).toEqual([]);
    expect(getTransportStats().bridgeReady).toBe(false);
  });

  it('hands subscribers only the source, version, type and payload', () => {
    const detail = JSON.stringify({
      source: BRIDGE_SOURCE_TAG,
      version: CHANNEL_VERSION,
      type: 'bridge.ready',
      payload: {},
      token: 'f'.repeat(64),
      extra: true,
    });

    expect(bridge.sendDetail(detail)).toBe(true);

    const message = at(accepted, 0, 'the accepted frames');
    expect(Object.keys(message).sort()).toEqual(['payload', 'source', 'type', 'version']);
    expect(message).toMatchObject({ source: BRIDGE_SOURCE_TAG, version: CHANNEL_VERSION });
  });

  it('turns a payload that is not a record into an empty null-prototype record', () => {
    const payloads: readonly unknown[] = [[1, 2], 'text', 7, null];
    for (const payload of payloads) {
      expect(bridge.send('agent.snapshot', payload)).toBe(true);
    }

    expect(accepted).toHaveLength(payloads.length);
    for (const message of accepted) {
      expect(Object.getPrototypeOf(message.payload)).toBeNull();
      expect(Object.keys(message.payload)).toEqual([]);
    }
  });

  it('reads a key the bridge did not send as absent, even on a polluted Object.prototype', () => {
    Object.defineProperty(Object.prototype, POLLUTED_KEY, {
      value: 'page',
      configurable: true,
      writable: true,
      enumerable: false,
    });

    try {
      expect(bridge.send('agent.config', { hooks: { fetch: true } })).toBe(true);

      const payload = at(accepted, 0, 'the accepted frames').payload;
      const hooks = asRecord(payload.hooks, 'the accepted hooks');
      // Every record in the frame is rebuilt on a null prototype, nested ones
      // included, so the page's key is invisible to `in` and to a read.
      expect(Object.getPrototypeOf(payload)).toBeNull();
      expect(Object.getPrototypeOf(hooks)).toBeNull();
      expect(POLLUTED_KEY in payload).toBe(false);
      expect(POLLUTED_KEY in hooks).toBe(false);
      expect(payload[POLLUTED_KEY]).toBeUndefined();
      expect(hooks.fetch).toBe(true);
    } finally {
      Reflect.deleteProperty(Object.prototype, POLLUTED_KEY);
    }
  });

  it('keeps a __proto__ key an ordinary key and pollutes nothing', () => {
    const detail = `{"source":"${BRIDGE_SOURCE_TAG}","version":${String(CHANNEL_VERSION)},"type":"agent.config","payload":{"__proto__":{"${POLLUTED_KEY}":true}}}`;

    expect(bridge.sendDetail(detail)).toBe(true);

    const payload = at(accepted, 0, 'the accepted frames').payload;
    expect(Object.getPrototypeOf(payload)).toBeNull();
    expect(Object.keys(payload)).toEqual(['__proto__']);
    expect(POLLUTED_KEY in payload).toBe(false);
    expect(POLLUTED_KEY in {}).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * What a page script can see and send
 *
 * Every case plays a page script that runs after the agent: it can listen
 * anywhere on the page, post anything to its own window and dispatch any
 * event it likes — everywhere except on a node it cannot reach.
 * ---------------------------------------------------------------------------
 */

describe('what a page script can see and send', () => {
  /** Frames the module accepted in the current case, in order. */
  let accepted: BridgeInboundMessage[] = [];

  /** The case's recording subscription. */
  let stopRecording: (() => void) | undefined;

  beforeEach(() => {
    accepted = [];
    stopRecording = subscribe((message) => {
      accepted.push(message);
    });
  });

  afterEach(() => {
    stopRecording?.();
    stopRecording = undefined;
  });

  it('shows a page listener on window or document none of the frames', () => {
    const observed: string[] = [];
    const record = (event: Event): void => {
      observed.push(event.type);
    };
    const pageEvents = [
      'message',
      AGENT_FRAME_EVENT,
      BRIDGE_FRAME_EVENT,
      HANDSHAKE_OFFER_EVENT,
      HANDSHAKE_REQUEST_EVENT,
    ];
    for (const type of pageEvents) {
      window.addEventListener(type, record);
      window.addEventListener(type, record, true);
      document.addEventListener(type, record, true);
    }
    const posted = vi.spyOn(window, 'postMessage');

    try {
      bridge.send('bridge.ready');
      emitRange(3);
      flush();
      postControl('agent.ready', { url: PAGE_URL });
      bridge.send('agent.config', { captureId: CAPTURE_A });

      // Self-check: the channel was busy in both directions while the page
      // listened.
      expect(bridge.claimedOfType('telemetry.batch')).toHaveLength(1);
      expect(bridge.claimedOfType('agent.ready')).toHaveLength(1);
      expect(accepted.map((message) => message.type)).toEqual(['bridge.ready', 'agent.config']);

      expect(observed).toEqual([]);
      expect(posted).not.toHaveBeenCalled();
    } finally {
      for (const type of pageEvents) {
        window.removeEventListener(type, record);
        window.removeEventListener(type, record, true);
        document.removeEventListener(type, record, true);
      }
    }
  });

  it('ignores an all-false agent.config posted to the window, token or not', async () => {
    const disarm = {
      captureId: CAPTURE_B,
      hooks: { react: false, fetch: false, errors: false, interactions: false, state: false },
    };
    const forgeries: readonly unknown[] = [
      // Version 2's shape, with a token of the length it used.
      {
        source: BRIDGE_SOURCE_TAG,
        version: CHANNEL_VERSION - 1,
        type: 'agent.config',
        token: 'f'.repeat(64),
        payload: disarm,
      },
      // Version 3's fields, posted instead of dispatched on the node.
      {
        source: BRIDGE_SOURCE_TAG,
        version: CHANNEL_VERSION,
        type: 'agent.config',
        payload: disarm,
      },
      // A version 3 detail string, as the data of a message.
      bridgeFrameDetail('agent.config', disarm),
    ];

    let arrived = 0;
    const onMessage = (): void => {
      arrived += 1;
    };
    window.addEventListener('message', onMessage);

    try {
      emitRange(1);
      const before = getTransportStats();

      for (const forgery of forgeries) {
        window.postMessage(forgery, '*');
        // And delivered synchronously, with the `source` a v2 guard checked.
        window.dispatchEvent(
          new MessageEvent('message', {
            data: forgery,
            origin: window.location.origin,
            source: window,
          }),
        );
      }

      // Self-check: every forgery reached the page's window.
      expect(await waitForPageMessages(() => arrived, forgeries.length * 2)).toBe(
        forgeries.length * 2,
      );

      expect(accepted).toEqual([]);
      expect(getTransportStats()).toEqual(before);
      // Still armed for the capture it was configured with: the forged
      // configuration changed nothing, so an event is still stamped.
      emitRange(1, 1);
      expect(getTransportStats()).toMatchObject({ seq: before.seq + 1, buffered: 2 });
    } finally {
      window.removeEventListener('message', onMessage);
    }
  });

  it('ignores a bridge frame dispatched anywhere but the node, unacknowledged', () => {
    const pageDiv = document.createElement('div');
    const targets: readonly EventTarget[] = [window, document, document.documentElement, pageDiv];
    emitRange(1);

    for (const target of targets) {
      const unclaimed = target.dispatchEvent(
        new CustomEvent(BRIDGE_FRAME_EVENT, {
          detail: bridgeFrameDetail('agent.config', { captureId: CAPTURE_B }),
          cancelable: true,
        }),
      );
      expect(unclaimed).toBe(true);
    }

    expect(accepted).toEqual([]);
    expect(getTransportStats()).toMatchObject({ buffered: 1, bridgeReady: false });
  });

  it('keeps working, unobserved, after a page replaces the platform methods', () => {
    // Every primitive the channel runs on, replaced after the module loaded —
    // by spies, which call through, so the page's own events keep working and
    // every call is on the record.
    const dispatchSpy = vi.spyOn(EventTarget.prototype, 'dispatchEvent');
    const addSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const removeSpy = vi.spyOn(EventTarget.prototype, 'removeEventListener');
    const detailSpy = vi.spyOn(CustomEvent.prototype, 'detail', 'get');
    const preventSpy = vi.spyOn(Event.prototype, 'preventDefault');
    const parseSpy = vi.spyOn(JSON, 'parse');
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    // And a `CustomEvent` that refuses to build anything at all.
    vi.stubGlobal(
      'CustomEvent',
      class {
        constructor() {
          throw new Error('the page replaced CustomEvent');
        }
      },
    );

    // A re-subscribe, so the node's listener is removed and installed again
    // under the replaced methods.
    unsubscribe?.();
    unsubscribe = subscribe(() => undefined);

    expect(bridge.send('bridge.ready')).toBe(true);
    emitRange(2);
    flush();
    postControl('agent.ready', { url: PAGE_URL });

    // The channel still works in both directions.
    expect(accepted.map((message) => message.type)).toEqual(['bridge.ready']);
    expect(bridge.frames.map((frame) => [frame.type, frame.claimed])).toEqual([
      ['telemetry.batch', true],
      ['agent.ready', true],
    ]);

    const typeOf = (value: unknown): unknown => (value instanceof Event ? value.type : undefined);
    const isAgentFrameObject = (value: unknown): boolean =>
      typeof value === 'object' &&
      value !== null &&
      (value as Record<string, unknown>).source === AGENT_SOURCE_TAG;

    // Self-checks: the spies were live — the fake bridge, which uses the
    // page's methods like any other script, went through every one of them.
    expect(detailSpy.mock.contexts.map(typeOf)).toContain(AGENT_FRAME_EVENT);
    expect(preventSpy.mock.contexts.map(typeOf)).toContain(AGENT_FRAME_EVENT);
    expect(parseSpy).toHaveBeenCalled();

    // And the agent went through none of them.
    expect(dispatchSpy.mock.calls.map(([event]) => event.type)).not.toContain(AGENT_FRAME_EVENT);
    expect(addSpy.mock.calls.map(([type]) => type)).not.toContain(BRIDGE_FRAME_EVENT);
    expect(removeSpy.mock.calls.map(([type]) => type)).not.toContain(BRIDGE_FRAME_EVENT);
    expect(detailSpy.mock.contexts.map(typeOf)).not.toContain(BRIDGE_FRAME_EVENT);
    expect(preventSpy.mock.contexts.map(typeOf)).not.toContain(BRIDGE_FRAME_EVENT);
    expect(
      parseSpy.mock.calls.some(
        ([text]) => typeof text === 'string' && text.includes(`"source":"${BRIDGE_SOURCE_TAG}"`),
      ),
    ).toBe(false);
    expect(stringifySpy.mock.calls.some(([value]) => isAgentFrameObject(value))).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The handshake
 * ---------------------------------------------------------------------------
 */

describe('the handshake', () => {
  it('answers no request after the one it answered, not even after a reset', () => {
    expect(requestChannelNode().offers).toEqual([]);

    // The disarm path, exactly as `./agent.ts` runs it at the end of every
    // capture: configureTransport({enabled:false}), resetTransport(), then a
    // new subscription. The exchange stays closed through all of it.
    configureTransport({ enabled: false });
    resetTransport();
    unsubscribe = subscribe(() => undefined);

    expect(requestChannelNode().offers).toEqual([]);
  });

  it('keeps the same node through a reset and a fresh subscribe', () => {
    configureTransport({ enabled: false });
    resetTransport();

    const afterReset: BridgeInboundMessage[] = [];
    unsubscribe = subscribe((message) => {
      afterReset.push(message);
    });
    configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_B, enabled: true });

    // The node the bridge was handed at the start of the document still
    // carries the second capture: replacing it here would leave the bridge
    // holding one nobody listens on, with no second handshake coming.
    expect(bridge.send('bridge.ready')).toBe(true);
    expect(afterReset.map((message) => message.type)).toEqual(['bridge.ready']);

    emitRange(1);
    flush();

    expect(deliveredOrder()).toEqual([0]);
    expect(at(batchViews(), 0, 'the claimed batches').captureId).toBe(CAPTURE_B);
  });

  it('follows the subscriber lifecycle on the node', () => {
    // The last unsubscribe removes the node's listener: a bridge frame then
    // finds nobody, and the bridge can tell.
    unsubscribe?.();
    unsubscribe = undefined;

    expect(bridge.send('bridge.ready')).toBe(false);
    expect(getTransportStats().bridgeReady).toBe(false);

    // A later subscribe listens again, on the same node, with no new handshake.
    const seen: BridgeInboundMessage[] = [];
    unsubscribe = subscribe((message) => {
      seen.push(message);
    });

    expect(bridge.send('bridge.ready')).toBe(true);
    expect(seen.map((message) => message.type)).toEqual(['bridge.ready']);
    expect(requestChannelNode().offers).toEqual([]);
  });

  it('keeps the node detached from the document', () => {
    const node = bridge.node;
    if (!(node instanceof Node)) {
      throw new Error('the channel node is not a DOM node');
    }

    expect(node.isConnected).toBe(false);
    expect(node.parentNode).toBeNull();
    expect(Array.from(document.querySelectorAll('*'))).not.toContain(node);
  });

  it('offers nothing unsolicited and answers only the first request of a document', async () => {
    const fresh = await freshTransport();
    const unsolicited: EventTarget[] = [];
    const onOffer = (event: Event): void => {
      const related = (event as MouseEvent).relatedTarget;
      if (related !== null) {
        unsolicited.push(related);
      }
    };
    window.addEventListener(HANDSHAKE_OFFER_EVENT, onOffer);
    const stop = fresh.subscribe(() => undefined);

    try {
      // Subscribing opens the channel and dispatches nothing.
      expect(unsolicited).toEqual([]);

      // A second request dispatched from inside the answer — the tightest race
      // a page script could arrange — finds the exchange already closed.
      window.removeEventListener(HANDSHAKE_OFFER_EVENT, onOffer);
      const nested: HandshakeResult[] = [];
      const askAgain = (): void => {
        if (nested.length === 0) {
          nested.push(requestChannelNode());
        }
      };
      window.addEventListener(HANDSHAKE_OFFER_EVENT, askAgain);
      let first: HandshakeResult;
      try {
        first = requestChannelNode();
      } finally {
        window.removeEventListener(HANDSHAKE_OFFER_EVENT, askAgain);
      }

      expect(first.offers).toHaveLength(1);
      expect(first.node).toBeInstanceOf(Node);
      expect(nested.map((result) => result.offers)).toEqual([[]]);

      // Every later request goes unanswered for the life of the document,
      // resets included.
      expect(requestChannelNode().offers).toEqual([]);
      fresh.resetTransport();
      const again = fresh.subscribe(() => undefined);
      try {
        expect(requestChannelNode().offers).toEqual([]);
      } finally {
        again();
      }
    } finally {
      window.removeEventListener(HANDSHAKE_OFFER_EVENT, onOffer);
      stop();
      fresh.resetTransport();
    }
  });

  it('hands the node to whoever asks first, so a bridge that asks second gets none', async () => {
    const fresh = await freshTransport();
    const stop = fresh.subscribe(() => undefined);

    try {
      // The documented limit of any in-page channel: on a page with no bridge
      // — or before it — a page script can ask first. What it gains is an agent
      // with no bridge behind it, and the bridge learns it was pre-empted.
      expect(requestChannelNode().offers).toHaveLength(1);
      expect(() => connectFakeBridge(fresh)).toThrow(/answered 0 times/u);
    } finally {
      stop();
      fresh.resetTransport();
    }
  });

  it('dispatches nothing and counts nothing before the handshake', async () => {
    const fresh = await freshTransport();
    const stop = fresh.subscribe(() => undefined);

    try {
      fresh.configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_A, enabled: true });
      // What `./agent.ts` does at `document_start`, before any bridge exists.
      fresh.postControl('agent.ready', { url: PAGE_URL });
      fresh.emit(renderDraft(0));
      fresh.flush();

      // No bridge could hold the node, so nothing was lost: not counted as a
      // dropped control frame, and the event is still queued.
      expect(fresh.getTransportStats()).toMatchObject({
        controlFramesDropped: 0,
        buffered: 1,
        sent: 0,
        bridgeReady: false,
      });

      const late = connectFakeBridge(fresh);
      expect(late.frames).toEqual([]);

      // The bridge's `bridge.ready` is the cue: the queue drains, and the
      // re-announcement finds the channel open.
      expect(late.send('bridge.ready')).toBe(true);
      fresh.postControl('agent.ready', { url: PAGE_URL });

      expect(late.frames.map((frame) => [frame.type, frame.claimed])).toEqual([
        ['telemetry.batch', true],
        ['agent.ready', true],
      ]);
      expect(deliveredOrder(late)).toEqual([0]);
      expect(fresh.getTransportStats()).toMatchObject({ sent: 1, controlFramesDropped: 0 });
    } finally {
      stop();
      fresh.resetTransport();
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Flow control
 * ---------------------------------------------------------------------------
 */

describe('flow control: bridge.pause and bridge.resume', () => {
  /** The frames the case's own subscriber received, in order. */
  let delivered: BridgeInboundMessage[] = [];

  beforeEach(() => {
    delivered = [];
    unsubscribe?.();
    unsubscribe = subscribe((message) => {
      delivered.push(message);
    });
    expect(bridge.send('bridge.ready')).toBe(true);
    bridge.clear();
    delivered = [];
  });

  afterEach(() => {
    // The pause is connection-scoped and survives the reset every case ends
    // with, so a case never leaves the file's bridge holding the agent back.
    bridge.send('bridge.gone');
    expect(getFlowControlStats().paused).toBe(false);
  });

  /**
   * A claim policy that runs `inside` during the first `telemetry.batch`
   * dispatch, and claims every frame.
   *
   * @param inside What the bridge does from inside its listener.
   * @returns The policy.
   */
  function insideFirstBatch(inside: () => void): FakeBridge['claim'] {
    let done = false;
    return (frame) => {
      if (!done && frame.type === 'telemetry.batch') {
        done = true;
        inside();
      }
      return true;
    };
  }

  /** The flush-timer delays the page's `setTimeout` was asked for since `spy` was installed. */
  function flushTimersArmed(spy: { mock: { calls: unknown[][] } }): number {
    return spy.mock.calls.filter((call) => call[1] === FLUSH_INTERVAL_MS).length;
  }

  it('acknowledges both signals, counts them, and hands neither to a subscriber', () => {
    const before = getFlowControlStats();

    expect(bridge.send('bridge.pause')).toBe(true);
    expect(getFlowControlStats()).toEqual({
      paused: true,
      pauses: before.pauses + 1,
      resumes: before.resumes,
    });
    expect(bridge.send('bridge.resume')).toBe(true);
    expect(getFlowControlStats()).toEqual({
      paused: false,
      pauses: before.pauses + 1,
      resumes: before.resumes + 1,
    });

    // `./agent.ts` is the subscriber in production: it never sees a resume, so
    // a resume can never read as a reconnect and re-send `agent.ready`. The
    // frames it does act on still reach it.
    expect(bridge.send('agent.snapshot')).toBe(true);
    expect(delivered.map((message) => message.type)).toEqual(['agent.snapshot']);
    expect(bridge.frames).toEqual([]);
  });

  it('posts nothing on the batch threshold or the timer while paused, and keeps buffering', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    bridge.send('bridge.pause');

    emitRange(MAX_EVENTS_PER_BATCH * 3 + 1);
    for (let turn = 0; turn < 3; turn += 1) {
      await nextTurn();
    }

    expect(bridge.framesOfType('telemetry.batch')).toEqual([]);
    expect(flushTimersArmed(timers)).toBe(0);
    expect(getTransportStats()).toMatchObject({
      buffered: MAX_EVENTS_PER_BATCH * 3 + 1,
      dropped: 0,
      sent: 0,
      bridgeReady: true,
    });
  });

  it('hands no drain to a task source while paused, however many events arrive', () => {
    // The microtask fallback is the observable route: every drain this module
    // hands off goes through the page's `queueMicrotask` once the channel is
    // gone, and `beforeEach` has already closed any cached channel.
    vi.stubGlobal('MessageChannel', undefined);
    const microtasks = vi.spyOn(globalThis, 'queueMicrotask');
    bridge.send('bridge.pause');

    emitRange(MAX_EVENTS_PER_BATCH * 3);

    // A drain handed off per event past the threshold would cost the page a
    // task each, to find the agent held back every time.
    expect(microtasks).not.toHaveBeenCalled();
    expect(getTransportStats().buffered).toBe(MAX_EVENTS_PER_BATCH * 3);
  });

  it('clears a flush timer armed before the pause', () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const clears = vi.spyOn(globalThis, 'clearTimeout');
    emitRange(1);
    expect(flushTimersArmed(timers)).toBe(1);
    const armed: unknown = timers.mock.results.find(
      (_result, index) => timers.mock.calls[index]?.[1] === FLUSH_INTERVAL_MS,
    )?.value;
    expect(armed).toBeDefined();

    bridge.send('bridge.pause');

    expect(clears.mock.calls.map((call) => call[0])).toContain(armed);
    expect(bridge.frames).toEqual([]);
    expect(getTransportStats().buffered).toBe(1);
  });

  it('evicts the oldest past the cap while paused, and reports the loss once on the first batch after the resume', async () => {
    const overflow = 37;
    bridge.send('bridge.pause');

    emitRange(MAX_BUFFERED_EVENTS + overflow);

    expect(getTransportStats()).toMatchObject({
      buffered: MAX_BUFFERED_EVENTS,
      dropped: overflow,
      sent: 0,
    });
    expect(bridge.frames).toEqual([]);

    // The resume drains at once — bounded, like the bridge's return after an
    // absence — and the rest follows turn by turn.
    expect(bridge.send('bridge.resume')).toBe(true);
    expect(batchViews()).toHaveLength(MAX_BATCHES_PER_DRAIN);
    expect(getTransportStats().buffered).toBe(
      MAX_BUFFERED_EVENTS - MAX_BATCHES_PER_DRAIN * MAX_EVENTS_PER_BATCH,
    );

    await drainToCompletion();

    expect(runShapeOf(deliveredOrder())).toEqual(contiguousRun(overflow, MAX_BUFFERED_EVENTS));
    const reported = batchViews().map((batch) => batch.droppedCount);
    expect(reported).toHaveLength(MAX_BUFFERED_EVENTS / MAX_EVENTS_PER_BATCH);
    expect(at(reported, 0, 'the reported drop counts')).toBe(overflow);
    expect(reported.slice(1).every((count) => count === 0)).toBe(true);
    expect(getTransportStats()).toMatchObject({ dropped: overflow, sent: MAX_BUFFERED_EVENTS });
    expect(delivered).toEqual([]);
  });

  it('still carries control frames and performs the terminal flush while paused, and stays paused after it', () => {
    bridge.send('bridge.pause');
    emitRange(MAX_EVENTS_PER_BATCH * (MAX_BATCHES_PER_DRAIN + 1));

    postControl('agent.ready', { url: PAGE_URL });
    expect(bridge.frames.map((frame) => [frame.type, frame.claimed])).toEqual([
      ['agent.ready', true],
    ]);

    // `pagehide`, a hidden document, capture stop: no later turn to wait for,
    // so everything queued leaves now, unbounded.
    flush();
    expect(batchViews()).toHaveLength(MAX_BATCHES_PER_DRAIN + 1);
    expect(deliveredOrder()).toEqual(
      indexRange(0, MAX_EVENTS_PER_BATCH * (MAX_BATCHES_PER_DRAIN + 1)),
    );

    // The flush was not a resume: the next burst waits again.
    bridge.clear();
    emitRange(MAX_EVENTS_PER_BATCH, MAX_EVENTS_PER_BATCH * (MAX_BATCHES_PER_DRAIN + 1));
    expect(getFlowControlStats().paused).toBe(true);
    expect(getTransportStats().buffered).toBe(MAX_EVENTS_PER_BATCH);
    expect(bridge.frames).toEqual([]);
  });

  it('delivers what a capture change finds queued under the capture it was recorded in, while paused', () => {
    bridge.send('bridge.pause');
    emitRange(3);

    configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_B, enabled: true });

    expect(batchViews().map((batch) => [batch.captureId, batch.events.length])).toEqual([
      [CAPTURE_A, 3],
    ]);
    expect(getTransportStats()).toMatchObject({ buffered: 0, dropped: 0, sent: 3 });
    expect(getFlowControlStats().paused).toBe(true);
  });

  it('stops a bounded drain before its next batch when a pause is handed back from inside it', async () => {
    bridge.send('bridge.gone');
    emitRange(MAX_EVENTS_PER_BATCH * 3);
    bridge.claim = insideFirstBatch(() => {
      bridge.send('bridge.pause');
    });

    // The bridge's return starts a bounded drain; the pause arrives while the
    // bridge holds its first batch.
    bridge.send('bridge.ready');

    expect(batchViews()).toHaveLength(1);
    for (let turn = 0; turn < 3; turn += 1) {
      await nextTurn();
    }
    expect(batchViews()).toHaveLength(1);
    expect(getTransportStats().buffered).toBe(MAX_EVENTS_PER_BATCH * 2);

    bridge.send('bridge.resume');
    expect(deliveredOrder()).toEqual(indexRange(0, MAX_EVENTS_PER_BATCH * 3));
    expect(batchViews().map((batch) => batch.batchSeq)).toEqual([0, 1, 2]);
  });

  it('never holds back the terminal flush a pause is handed back into', () => {
    emitRange(MAX_EVENTS_PER_BATCH * 3);
    bridge.claim = insideFirstBatch(() => {
      bridge.send('bridge.pause');
    });

    flush();

    expect(deliveredOrder()).toEqual(indexRange(0, MAX_EVENTS_PER_BATCH * 3));
    expect(getFlowControlStats().paused).toBe(true);
  });

  it('ends a pause at bridge.ready, the next port, and at bridge.gone, the end of this one', async () => {
    bridge.send('bridge.pause');
    bridge.send('bridge.ready');
    expect(getFlowControlStats().paused).toBe(false);

    emitRange(MAX_EVENTS_PER_BATCH);
    await drainToCompletion();
    expect(deliveredOrder()).toEqual(indexRange(0, MAX_EVENTS_PER_BATCH));

    bridge.send('bridge.pause');
    bridge.send('bridge.gone');
    expect(getFlowControlStats().paused).toBe(false);
    emitRange(2, MAX_EVENTS_PER_BATCH);
    expect(bridge.send('bridge.ready')).toBe(true);
    expect(deliveredOrder()).toEqual(indexRange(0, MAX_EVENTS_PER_BATCH + 2));
    expect(delivered.map((message) => message.type)).toEqual([
      'bridge.ready',
      'bridge.gone',
      'bridge.ready',
    ]);
  });

  it('keeps a pause through a capture change and a reset, which end a capture rather than the connection', () => {
    bridge.send('bridge.pause');
    configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_B, enabled: true });
    expect(getFlowControlStats().paused).toBe(true);

    // The disarm path of `./agent.ts`, then the next capture's configuration
    // relayed by the same bridge.
    configureTransport({ enabled: false });
    resetTransport();
    expect(getFlowControlStats().paused).toBe(true);
    unsubscribe = subscribe(() => undefined);
    expect(bridge.send('agent.config')).toBe(true);
    configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_A, enabled: true });

    emitRange(MAX_EVENTS_PER_BATCH + 1);
    flush();
    bridge.clear();
    emitRange(MAX_EVENTS_PER_BATCH, MAX_EVENTS_PER_BATCH + 1);
    expect(getTransportStats()).toMatchObject({
      buffered: MAX_EVENTS_PER_BATCH,
      bridgeReady: true,
    });
    expect(bridge.frames).toEqual([]);

    // The worker's resume is what lets the new capture's telemetry go.
    bridge.send('bridge.resume');
    expect(batchViews().map((batch) => [batch.captureId, batch.events.length])).toEqual([
      [CAPTURE_A, MAX_EVENTS_PER_BATCH],
    ]);
  });

  it('marks an absent bridge present on a pause without draining, and drains on the resume', () => {
    bridge.send('bridge.gone');
    emitRange(MAX_EVENTS_PER_BATCH + 50);

    expect(bridge.send('bridge.pause')).toBe(true);
    expect(getTransportStats()).toMatchObject({
      bridgeReady: true,
      buffered: MAX_EVENTS_PER_BATCH + 50,
    });
    expect(bridge.frames).toEqual([]);

    expect(bridge.send('bridge.resume')).toBe(true);
    expect(batchViews().map((batch) => batch.events.length)).toEqual([MAX_EVENTS_PER_BATCH, 50]);
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: MAX_EVENTS_PER_BATCH + 50 });
  });
});
