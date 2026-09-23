// @vitest-environment happy-dom
/**
 * Colocated tests for `./transport.ts` — the bounds the page agent promises the
 * developer's page, each one exercised at the value itself, one short of it and
 * one over.
 *
 * **What this suite owns.** Every number that decides when telemetry travels,
 * how much of it is held and what happens when there is too much:
 *
 * - {@link MAX_EVENTS_PER_BATCH} (200) — the size of a posted batch *and* the
 *   drain trigger. The event that reaches it must not pay for the batch: the
 *   drain goes to a later turn, which the cases below assert by observing that
 *   nothing has been posted when the emitting loop returns.
 * - {@link MAX_BUFFERED_EVENTS} (5 000) — AAP §0.5.5's "the agent buffers up to
 *   5 000 events in memory until the bridge returns". At the cap exactly one
 *   oldest event is evicted per new event, order survives the ring's
 *   wrap-around, `seq` is **not** renumbered (the gap is how a reader learns
 *   events were lost) and the loss rides out on the next batch's
 *   `droppedCount`, once.
 * - {@link MAX_BATCHES_PER_DRAIN} (8) — what one drain posts before it yields
 *   the task back to the page, with the remainder rescheduled. Asserted on
 *   both non-terminal routes that can meet a deep queue: the scheduled drain
 *   the batch threshold starts, and the recovery drain the bridge's return
 *   starts after an absence. {@link flush} is the deliberate exception — a
 *   terminal moment with no later turn — and is asserted to be unbounded.
 * - {@link MAX_MESSAGE_BYTES} (512 KiB) — measured on every frame. An oversize
 *   batch is halved until it fits, a single event that cannot fit is dropped
 *   alone with a diagnostic naming only its id and kind, and a control frame
 *   over the cap is refused and replaced by one fixed-size diagnostic that
 *   cannot trigger another.
 * - {@link MAX_CONTROL_TEXT_LENGTH} (2 048) — the per-field bound on the
 *   page-controlled text a control frame carries.
 *
 * **And the inbound channel's authentication**, which is the other thing this
 * module owns alone: the page↔bridge handshake. `describe('the bridge
 * handshake')` covers the five properties the guard rests on — a frame with no
 * `token` is not accepted, nor is one whose token is the right length and the
 * wrong value, nor one at the previous {@link CHANNEL_VERSION}; the token the
 * module discloses *is* accepted, and still is after a
 * {@link resetTransport} and a fresh {@link subscribe} (the disarm→re-arm path
 * of a second capture on one document); exactly one
 * {@link HANDSHAKE_REQUEST_EVENT} is ever answered; a module instance whose
 * disclosure nobody joined accepts nothing a caller can construct; and the
 * token never reaches a subscriber. Without those cases a page script could
 * arm, reconfigure or silently tear down a capture by posting a frame to its
 * own window, which is what the five structural checks alone allowed.
 *
 * No other suite in the repository reaches any of them: the sibling browser
 * suites drive producers (`./continuation.test.ts`, `./dom-target.test.ts`,
 * `./react.test.tsx`) and `../node/control.test.ts` drives the capture gate, so
 * a regression in the backpressure rules — a queue that shifts its whole array
 * per event, an inline drain on a click handler, a frame posted unmeasured — or
 * in the handshake would otherwise reach a developer's page before it reached a
 * test.
 *
 * ## Techniques, and why each one is the way it is
 *
 * **Outbound frames are observed by spying on `window.postMessage`.** The
 * module posts with a `targetOrigin` of `'/'` on purpose (it is the only
 * spelling that works in a document with an opaque origin), and happy-dom
 * refuses that value with a `SecurityError`. Un-spied, every frame this module
 * posts would therefore be *refused* rather than delivered, and the suite would
 * be asserting against a host limitation instead of against the product. The
 * spy records each frame and counts each attempt, so "did not split the batch"
 * is an attempt count rather than an inference.
 *
 * **Inbound frames are dispatched as constructed `MessageEvent`s.** The
 * module's guard requires `event.source === window`, which happy-dom's own
 * `window.postMessage` does not set. `bridge.ready` and `bridge.gone` are
 * therefore delivered by `window.dispatchEvent(new MessageEvent('message',
 * { …, source: window }))` — through the same listener the real bridge reaches,
 * with the same guard applied. The listener exists only while something is
 * subscribed, so every case subscribes first and unsubscribes in teardown.
 *
 * **The handshake token is captured once, at module scope.** Every inbound
 * frame now has to carry it (see {@link announceBridge}), and the module
 * discloses it at most twice per document: unsolicited, the instant the first
 * {@link subscribe} mints it, and once in answer to the first request. This
 * file takes the first of those, by registering a {@link HANDSHAKE_OFFER_EVENT}
 * listener at module scope — before any `subscribe()` runs, which is the
 * bridge-injected-first order — and latching what it hears. One capture serves
 * the whole file, because the token is document-scoped and survives the
 * {@link resetTransport} each case runs; the two cases that need a *fresh*
 * handshake take a fresh module instance instead (`vi.resetModules()` and a
 * dynamic `import()`, which this module supports because it has no import-time
 * side effects), so neither of them consumes the single request-answer the
 * rest of the file's token came from.
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
 * {@link resetTransport} runs before and after every case, and no case depends
 * on another's counters.
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
import { getProducerId } from './ids.js';
import {
  AGENT_SOURCE_TAG,
  boundControlText,
  BRIDGE_SOURCE_TAG,
  CHANNEL_VERSION,
  configureTransport,
  emit,
  emitMany,
  flush,
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
import type {
  AgentOutboundMessage,
  AgentOutboundType,
  BridgeInboundMessage,
  EventDraft,
} from './transport.js';

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

/** A second capture, for the transition case. */
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
 * past — while either half is comfortably inside it. That is the split the case
 * asserts: one halving, no more.
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
 * was posted while the producer was on the stack" an assertion about the
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
 * Outbound observation
 *
 * One spy, two behaviours: record a frame, or refuse to clone it. Nothing else
 * in this file calls `window.postMessage`.
 * ---------------------------------------------------------------------------
 */

/** Every frame the module posted in the current case, in order. */
let frames: AgentOutboundMessage[] = [];

/** How many times the module called `window.postMessage`, delivered or not. */
let postAttempts = 0;

/**
 * Record every frame the module posts.
 *
 * The recorded object is the frame itself rather than a clone, which is what a
 * real `postMessage` would deliver a structured copy of. That is deliberate:
 * these cases assert on the frame the module built, and a clone step here could
 * only lose information (and would throw on exactly the values the module's
 * sanitizer exists to prevent).
 */
function interceptFrames(): void {
  vi.spyOn(window, 'postMessage').mockImplementation((message: unknown): void => {
    postAttempts += 1;
    frames.push(message as AgentOutboundMessage);
  });
}

/**
 * Refuse every frame, as a page whose structured clone fails would.
 *
 * A thrown `postMessage` is the module's `refused` outcome: the frame was
 * rendered and measured, and the host still would not take it. A plain `Error`
 * is thrown rather than a `DOMException`, because the module catches whatever
 * comes out and the distinction would only pin this case to a host detail.
 */
function refuseFrames(): void {
  vi.spyOn(window, 'postMessage').mockImplementation((): void => {
    postAttempts += 1;
    throw new Error('the page refused to clone the frame');
  });
}

/*
 * ---------------------------------------------------------------------------
 * Inbound bridge frames
 * ---------------------------------------------------------------------------
 */

/**
 * The token the module disclosed for this document, or `undefined` before the
 * first {@link subscribe} has minted one.
 *
 * Latched rather than overwritten: two cases create a fresh module instance,
 * whose own offer must not replace the token the rest of the file posts with.
 */
let offeredToken: string | undefined;

/**
 * The token a {@link HANDSHAKE_OFFER_EVENT} carries, or `undefined` when the
 * event's `detail` is not the bare non-empty string the channel specifies.
 *
 * Read through `unknown` on purpose: `detail` is typed by whoever constructed
 * the event, and a case that asserted on it without narrowing could not tell a
 * missing disclosure from a malformed one.
 *
 * @param event The dispatched offer.
 * @returns The token, or `undefined`.
 */
function offerDetail(event: Event): string | undefined {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  return typeof detail === 'string' && detail.length > 0 ? detail : undefined;
}

/*
 * The one module-scope side effect in this file, and it is required rather than
 * convenient: the module's unsolicited offer is dispatched inside the first
 * `subscribe()`, which `beforeEach` performs, so a listener registered any
 * later would have missed it. Registering here is also the order the real
 * extension produces — the bridge's listener exists before it asks — which is
 * what makes this file's token the one a bridge would hold.
 */
window.addEventListener(HANDSHAKE_OFFER_EVENT, (event: Event) => {
  offeredToken ??= offerDetail(event);
});

/**
 * The token every inbound frame must carry, failing loudly when there is none.
 *
 * A missing token is not something a case should be able to pass around as
 * `undefined`: the frame would then be rejected for the very reason the case is
 * trying to assert about, and the failure would read as a guard bug rather than
 * as a handshake that never happened.
 *
 * @returns The disclosed token.
 */
function issuedToken(): string {
  if (offeredToken === undefined) {
    throw new Error('the transport disclosed no handshake token');
  }
  return offeredToken;
}

/**
 * A token of exactly the issued token's length and a different value.
 *
 * The first character is flipped between two hex digits, so the result is the
 * same width, the same alphabet and never equal — which is what makes the
 * rejection attributable to the comparison rather than to the length check
 * that precedes it.
 *
 * @param token The issued token.
 * @returns A wrong token of the same length.
 */
function alteredToken(token: string): string {
  return `${token.startsWith('0') ? '1' : '0'}${token.slice(1)}`;
}

/**
 * Deliver one constructed `message` event to the module's listener.
 *
 * `source: window` is the load-bearing part: the guard drops any frame that did
 * not come from this window, and happy-dom's `window.postMessage` does not set
 * the field at all, so a constructed event is the only way to reach the
 * listener in this host.
 *
 * The frame is passed as a whole record rather than assembled here, so the
 * handshake cases can deliver one with a wrong `token`, with none at all, or at
 * the wrong version — every shape a page script can post.
 *
 * @param data The frame, exactly as it will arrive.
 */
function deliverFrame(data: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data,
      origin: window.location.origin,
      source: window,
    }),
  );
}

/**
 * Deliver one well-formed frame from the bridge, through the module's own
 * guard.
 *
 * Carries the handshake token, because that is what the bridge does: a frame
 * without it is dropped, and the cases in this file that are about the queue
 * and the bounds are entitled to a channel that works.
 *
 * @param type The inbound frame type.
 */
function announceBridge(type: 'bridge.ready' | 'bridge.gone'): void {
  deliverFrame({
    source: BRIDGE_SOURCE_TAG,
    version: CHANNEL_VERSION,
    type,
    token: issuedToken(),
    payload: {},
  });
}

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

/** Frames of one outbound type, in the order they were posted. */
function framesOfType(type: AgentOutboundType): AgentOutboundMessage[] {
  return frames.filter((frame) => frame.type === type);
}

/** The `telemetry.batch` frames, in order. */
function batchFrames(): AgentOutboundMessage[] {
  return framesOfType('telemetry.batch');
}

/** One batch payload, with the members these cases read. */
interface BatchView {
  /** The payload's own keys, sorted, so an extra one is visible. */
  readonly keys: readonly string[];
  /** The events, each as a record. */
  readonly events: readonly Readonly<Record<string, unknown>>[];
  /** The count of events lost since the last batch reported one. */
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
function batchView(frame: AgentOutboundMessage): BatchView {
  const payload = asRecord(frame.payload, 'a telemetry.batch payload');
  const events = asList(payload.events, "a telemetry.batch payload's events");
  return {
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

/** Every batch's view, in posting order. */
function batchViews(): BatchView[] {
  return batchFrames().map((frame) => batchView(frame));
}

/** Every delivered event, across every batch, in posting order. */
function deliveredEvents(): Readonly<Record<string, unknown>>[] {
  return batchViews().flatMap((batch) => [...batch.events]);
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

/** The emission indices of every delivered event, in delivery order. */
function deliveredOrder(): number[] {
  return deliveredEvents().map((event) => orderOf(event));
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
function deliveredSeqs(): number[] {
  return deliveredEvents().map((event) => seqOf(event));
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

/** The length of a frame's JSON rendering, the measure the module's cap uses. */
function measuredLength(frame: AgentOutboundMessage): number {
  return JSON.stringify(frame).length;
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
 * @returns How many turns were spent.
 */
async function drainToCompletion(): Promise<number> {
  for (let turn = 1; turn <= MAX_WAITED_TURNS; turn += 1) {
    await nextTurn();
    if (getTransportStats().buffered === 0) {
      return turn;
    }
  }
  return MAX_WAITED_TURNS;
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
  frames = [];
  postAttempts = 0;
  // The `message` listener exists only while something is subscribed, and every
  // case delivers at least the bridge's own frames through it.
  unsubscribe = subscribe(() => undefined);
  configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_A, enabled: true });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTransport();
});

/*
 * ---------------------------------------------------------------------------
 * The batch threshold
 * ---------------------------------------------------------------------------
 */

describe('MAX_EVENTS_PER_BATCH', () => {
  beforeEach(() => {
    interceptFrames();
    announceBridge('bridge.ready');
  });

  it('holds a burst one event short of the threshold', () => {
    emitRange(MAX_EVENTS_PER_BATCH - 1);

    expect(frames).toHaveLength(0);
    expect(postAttempts).toBe(0);
    expect(getTransportStats()).toMatchObject({
      buffered: MAX_EVENTS_PER_BATCH - 1,
      sent: 0,
      batches: 0,
      dropped: 0,
      bridgeReady: true,
    });
  });

  it('schedules the batch that reaches the threshold instead of posting it inline', async () => {
    emitRange(MAX_EVENTS_PER_BATCH);

    // The producer's stack is the thing being protected: the event that filled
    // the batch must not have paid for serialising it.
    expect(frames).toHaveLength(0);
    expect(postAttempts).toBe(0);
    expect(getTransportStats().buffered).toBe(MAX_EVENTS_PER_BATCH);

    await drainToCompletion();

    const batches = batchViews();
    expect(batches).toHaveLength(1);
    expect(at(batches, 0, 'the posted batches').events).toHaveLength(MAX_EVENTS_PER_BATCH);
    expect(postAttempts).toBe(1);
    expect(deliveredOrder()).toEqual(indexRange(0, MAX_EVENTS_PER_BATCH));
    expect(getTransportStats()).toMatchObject({
      buffered: 0,
      sent: MAX_EVENTS_PER_BATCH,
      batches: 1,
      dropped: 0,
    });
  });

  it('posts one full batch and the remainder, in emission order, one event over', async () => {
    const total = MAX_EVENTS_PER_BATCH + 1;
    emitRange(total);

    expect(frames).toHaveLength(0);
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
 * describes: nothing is posted, nothing is scheduled, and the ring is the only
 * thing between a render storm and the page's memory.
 * ---------------------------------------------------------------------------
 */

describe('MAX_BUFFERED_EVENTS with the bridge away', () => {
  beforeEach(() => {
    interceptFrames();
  });

  it('buffers a burst one event short of the cap without dropping anything', () => {
    emitRange(MAX_BUFFERED_EVENTS - 1);

    expect(getTransportStats()).toMatchObject({
      buffered: MAX_BUFFERED_EVENTS - 1,
      dropped: 0,
      sent: 0,
      bridgeReady: false,
    });
    expect(frames).toHaveLength(0);
  });

  it('buffers exactly the cap without dropping anything', () => {
    emitRange(MAX_BUFFERED_EVENTS);

    expect(getTransportStats()).toMatchObject({
      buffered: MAX_BUFFERED_EVENTS,
      dropped: 0,
      sent: 0,
    });
    expect(frames).toHaveLength(0);
  });

  it('evicts exactly the oldest event for the one that goes over the cap', async () => {
    emitRange(MAX_BUFFERED_EVENTS + 1);

    expect(getTransportStats()).toMatchObject({ buffered: MAX_BUFFERED_EVENTS, dropped: 1 });

    announceBridge('bridge.ready');

    // Recovery starts in the handler and is bounded there like every other
    // non-terminal drain: a full queue is twenty-five batches, and posting all
    // of them in one `message` handler would be the long task the scheduled
    // drain exists to avoid. The rest arrives on the turns that follow.
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

    announceBridge('bridge.ready');
    await drainToCompletion();

    expect(runShapeOf(deliveredOrder())).toEqual(contiguousRun(overflow, MAX_BUFFERED_EVENTS));
    expect(batchViews()).toHaveLength(MAX_BUFFERED_EVENTS / MAX_EVENTS_PER_BATCH);
  });

  it('reports the accumulated loss on exactly one batch and then starts a fresh count', async () => {
    const overflow = 137;
    emitRange(MAX_BUFFERED_EVENTS + overflow);
    announceBridge('bridge.ready');
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

    frames = [];
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
  beforeEach(() => {
    interceptFrames();
  });

  it('leaves a gap in seq exactly where the ring dropped events', async () => {
    announceBridge('bridge.ready');
    emitRange(MAX_EVENTS_PER_BATCH);
    flush();

    // The bridge goes away with the sequence part-used, so the events the ring
    // evicts are in the middle of the run rather than at its start.
    announceBridge('bridge.gone');
    emitRange(MAX_BUFFERED_EVENTS + 1, MAX_EVENTS_PER_BATCH);
    expect(getTransportStats().dropped).toBe(1);

    announceBridge('bridge.ready');
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
    announceBridge('bridge.ready');
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
    announceBridge('bridge.ready');
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
  it('posts at most the bound in one scheduled turn and reschedules the rest', async () => {
    // The microtask fallback runs the same drain body as the channel route and
    // is the only route whose turn boundary a probe can sit on. `beforeEach`
    // has already closed any cached channel, so stubbing it away here is enough
    // to take that route for the whole case.
    vi.stubGlobal('MessageChannel', undefined);
    interceptFrames();
    announceBridge('bridge.ready');

    const extraBatches = 2;
    const total = MAX_EVENTS_PER_BATCH * (MAX_BATCHES_PER_DRAIN + extraBatches);
    emitRange(total);

    let batchesAfterOneTurn = -1;
    let bufferedAfterOneTurn = -1;
    // Queued after the drain the emitting loop scheduled and before the
    // continuation that drain will schedule for itself, because microtasks run
    // in the order they were queued.
    queueMicrotask(() => {
      batchesAfterOneTurn = batchFrames().length;
      bufferedAfterOneTurn = getTransportStats().buffered;
    });

    expect(frames).toHaveLength(0);

    await nextTurn();

    expect(batchesAfterOneTurn).toBe(MAX_BATCHES_PER_DRAIN);
    expect(bufferedAfterOneTurn).toBe(MAX_EVENTS_PER_BATCH * extraBatches);

    await drainToCompletion();

    expect(batchFrames()).toHaveLength(MAX_BATCHES_PER_DRAIN + extraBatches);
    expect(deliveredOrder()).toEqual(indexRange(0, total));
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: total });
  });

  it('bounds the drain that recovers a queue the bridge was away for', async () => {
    interceptFrames();

    // The Manifest V3 case: the service worker suspended, the bridge said it
    // was gone, and the queue filled while it was. Recovery is not a terminal
    // moment — the page is still there and there will be more turns — so it
    // gets the same per-turn bound as the threshold path, and the assertion
    // below needs no probe: the bound is observable at the synchronous return
    // of the `message` handler that delivered `bridge.ready`.
    const extraBatches = 3;
    const total = MAX_EVENTS_PER_BATCH * (MAX_BATCHES_PER_DRAIN + extraBatches);
    emitRange(total);
    expect(getTransportStats()).toMatchObject({ buffered: total, bridgeReady: false });
    expect(frames).toHaveLength(0);

    announceBridge('bridge.ready');

    expect(batchFrames()).toHaveLength(MAX_BATCHES_PER_DRAIN);
    expect(getTransportStats().buffered).toBe(MAX_EVENTS_PER_BATCH * extraBatches);

    await drainToCompletion();

    expect(batchFrames()).toHaveLength(MAX_BATCHES_PER_DRAIN + extraBatches);
    expect(deliveredOrder()).toEqual(indexRange(0, total));
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: total, dropped: 0 });
  });

  it('empties a queue deeper than the bound in one synchronous flush', () => {
    interceptFrames();
    announceBridge('bridge.ready');

    const total = MAX_EVENTS_PER_BATCH * (MAX_BATCHES_PER_DRAIN + 2);
    emitRange(total);
    expect(frames).toHaveLength(0);

    flush();

    // `pagehide` has no later turn to rely on, so `flush` is unbounded by
    // design: everything is on the wire when it returns.
    expect(batchFrames()).toHaveLength(MAX_BATCHES_PER_DRAIN + 2);
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
  it('drops a refused batch whole, counts it, and does not split it', () => {
    refuseFrames();
    announceBridge('bridge.ready');
    emitRange(MAX_EVENTS_PER_BATCH);

    flush();

    // One attempt, not nine: a frame the page refused to clone would fail the
    // same way in halves, so halving it would only multiply the cost.
    expect(postAttempts).toBe(1);
    expect(getTransportStats()).toMatchObject({
      buffered: 0,
      sent: 0,
      batches: 0,
      dropped: MAX_EVENTS_PER_BATCH,
      serializationFailures: MAX_EVENTS_PER_BATCH,
    });
  });

  it('halves an oversize batch until it fits', () => {
    interceptFrames();
    announceBridge('bridge.ready');

    const filler = 'x'.repeat(OVERSIZE_BATCH_FILLER);
    for (let index = 0; index < OVERSIZE_BATCH_EVENTS; index += 1) {
      emit(renderDraft(index, { attributes: { [FILLER_ATTRIBUTE]: filler } }));
    }

    flush();

    const sizes = batchViews().map((batch) => batch.events.length);
    expect(sizes).toEqual([OVERSIZE_BATCH_EVENTS / 2, OVERSIZE_BATCH_EVENTS / 2]);
    expect(deliveredOrder()).toEqual(indexRange(0, OVERSIZE_BATCH_EVENTS));
    for (const frame of frames) {
      expect(measuredLength(frame)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    }
    expect(getTransportStats()).toMatchObject({
      sent: OVERSIZE_BATCH_EVENTS,
      dropped: 0,
      serializationFailures: 0,
    });
  });

  it('drops a single unpostable event alone and still delivers its neighbours', () => {
    interceptFrames();
    announceBridge('bridge.ready');

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

    const diagnostics = framesOfType('agent.error');
    expect(diagnostics).toHaveLength(1);
    const diagnostic = asRecord(
      at(diagnostics, 0, 'the posted diagnostics').payload,
      'the diagnostic payload',
    );
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
    interceptFrames();
    const payload = oversizeControlPayload();
    // A self-checking fixture: the case is meaningless if the payload is not
    // actually over the cap.
    expect(JSON.stringify(payload).length).toBeGreaterThan(MAX_MESSAGE_BYTES);

    postControl('agent.ready', payload);

    expect(frames).toHaveLength(1);
    const frame = at(frames, 0, 'the posted frames');
    expect(frame.type).toBe('agent.error');
    expect(frame.source).toBe(AGENT_SOURCE_TAG);
    expect(measuredLength(frame)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(asRecord(frame.payload, 'the diagnostic payload')).toEqual({
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

  it('does not recurse when the channel refuses the diagnostic as well', () => {
    refuseFrames();

    postControl('agent.ready', oversizeControlPayload());

    // Exactly one attempt: the refused frame was never posted (it was measured
    // and rejected first), and the diagnostic that replaced it is not reported
    // again when it fails — it is only counted. Two frames the channel would
    // not take, one attempt, no recursion.
    expect(postAttempts).toBe(1);
    expect(getTransportStats().controlFramesDropped).toBe(2);
  });

  it('reports a refused control frame once and attempts nothing further', () => {
    refuseFrames();

    postControl('agent.ready', { url: 'https://example.invalid/page' });

    expect(postAttempts).toBe(1);
    expect(getTransportStats().controlFramesDropped).toBe(1);
  });

  it('bounds control text at the limit and truncates one character over it', () => {
    interceptFrames();
    const atLimit = 'u'.repeat(MAX_CONTROL_TEXT_LENGTH);
    const overLimit = 'u'.repeat(MAX_CONTROL_TEXT_LENGTH + 1);

    expect(boundControlText(atLimit)).toBe(atLimit);
    expect(boundControlText(overLimit)).toHaveLength(MAX_CONTROL_TEXT_LENGTH);

    postControl('agent.ready', { url: overLimit });

    const payload = asRecord(
      at(frames, 0, 'the posted frames').payload,
      'the control frame payload',
    );
    const url = payload.url;
    if (typeof url !== 'string') {
      throw new Error('the control frame carried no url string');
    }
    expect(url).toHaveLength(MAX_CONTROL_TEXT_LENGTH);
    expect(getTransportStats().controlFramesDropped).toBe(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Capture transitions
 * ---------------------------------------------------------------------------
 */

describe('a capture change', () => {
  it('discards what the bridge never took, counts it, and restarts the sequence', () => {
    interceptFrames();
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
    expect(frames).toHaveLength(0);

    announceBridge('bridge.ready');
    emitRange(2);
    flush();

    const batches = batchViews();
    expect(batches).toHaveLength(1);
    const batch = at(batches, 0, 'the posted batches');
    expect(batch.captureId).toBe(CAPTURE_B);
    expect(batch.batchSeq).toBe(0);
    expect(batch.droppedCount).toBe(0);
    expect(deliveredSeqs()).toEqual([0, 1]);
    expect(getTransportStats().dropped).toBe(abandoned);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The handshake
 *
 * The inbound channel's authentication. Every case below posts a frame the way
 * a page script would — to its own window, on its own origin, with the
 * published source tag and a known frame type — and the only thing that
 * separates an accepted frame from a dropped one is the token.
 * ---------------------------------------------------------------------------
 */

/** Every {@link HANDSHAKE_OFFER_EVENT} dispatched while a collector is live. */
interface OfferCollector {
  /** The tokens disclosed so far, in dispatch order. */
  readonly tokens: readonly string[];
  /** Stop collecting. Idempotent, and called from a `finally`. */
  readonly stop: () => void;
}

/**
 * Collect the offers dispatched from now until {@link OfferCollector.stop}.
 *
 * Separate from the module-scope latch, which keeps only the first offer: a
 * case that drives a fresh module instance needs that instance's disclosures,
 * and needs them counted rather than latched.
 *
 * @returns The collector.
 */
function collectOffers(): OfferCollector {
  const tokens: string[] = [];
  const listener = (event: Event): void => {
    const token = offerDetail(event);
    if (token !== undefined) {
      tokens.push(token);
    }
  };

  window.addEventListener(HANDSHAKE_OFFER_EVENT, listener);
  return {
    tokens,
    stop: (): void => {
      window.removeEventListener(HANDSHAKE_OFFER_EVENT, listener);
    },
  };
}

/**
 * A fresh evaluation of the module under test, with a handshake of its own.
 *
 * The token and the answered-a-request latch are document-scoped and cleared by
 * nothing — that is the lifetime a second capture on one document depends
 * on — so a case that needs an *unspent* handshake cannot get one by resetting.
 * A fresh instance is the only way, and this module supports it because it has
 * no import-time side effects: the new evaluation installs nothing until it is
 * subscribed to.
 *
 * @returns The fresh module namespace.
 */
async function freshTransport(): Promise<typeof import('./transport.js')> {
  vi.resetModules();
  return import('./transport.js');
}

describe('the bridge handshake', () => {
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

  it('drops a frame that carries no token', () => {
    interceptFrames();
    emitRange(1);

    deliverFrame({
      source: BRIDGE_SOURCE_TAG,
      version: CHANNEL_VERSION,
      type: 'bridge.ready',
      payload: {},
    });

    // Dropped in the same silence as any other malformed frame: no subscriber
    // notified, the bridge still considered absent, and the queued event still
    // queued — a page script cannot even make the agent flush.
    expect(accepted).toEqual([]);
    expect(frames).toEqual([]);
    expect(getTransportStats()).toMatchObject({ buffered: 1, sent: 0, bridgeReady: false });
  });

  it('drops a frame whose token is the right length and the wrong value', () => {
    interceptFrames();
    const wrong = alteredToken(issuedToken());
    // Self-checking fixture: a wrong token of a different length would be
    // rejected by the length check, which is not the comparison under test.
    expect(wrong).toHaveLength(issuedToken().length);
    expect(wrong).not.toBe(issuedToken());

    emitRange(1);
    deliverFrame({
      source: BRIDGE_SOURCE_TAG,
      version: CHANNEL_VERSION,
      type: 'bridge.ready',
      token: wrong,
      payload: {},
    });

    expect(accepted).toEqual([]);
    expect(getTransportStats()).toMatchObject({ buffered: 1, sent: 0, bridgeReady: false });
  });

  it('drops a frame at the previous channel version even with the right token', () => {
    interceptFrames();
    emitRange(1);

    deliverFrame({
      source: BRIDGE_SOURCE_TAG,
      version: CHANNEL_VERSION - 1,
      type: 'bridge.ready',
      token: issuedToken(),
      payload: {},
    });

    // The version bump is what makes an un-hardened bridge legible enough to
    // ignore: its frames are refused before the token is even considered.
    expect(accepted).toEqual([]);
    expect(getTransportStats()).toMatchObject({ buffered: 1, bridgeReady: false });
  });

  it('accepts a frame carrying the disclosed token and drains what was queued', () => {
    interceptFrames();
    emitRange(1);
    expect(getTransportStats()).toMatchObject({ buffered: 1, bridgeReady: false });

    announceBridge('bridge.ready');

    expect(accepted.map((message) => message.type)).toEqual(['bridge.ready']);
    expect(getTransportStats()).toMatchObject({ buffered: 0, sent: 1, bridgeReady: true });
    expect(deliveredOrder()).toEqual([0]);
  });

  it('hands subscribers a frame with no token on it', () => {
    interceptFrames();

    announceBridge('bridge.ready');

    const message = at(accepted, 0, 'the accepted frames');
    // The secret is verified and dropped: a subscriber that echoed its whole
    // frame into a diagnostic would otherwise publish it to the page.
    expect(Object.keys(message).sort()).toEqual(['payload', 'source', 'type', 'version']);
    expect(JSON.stringify(message)).not.toContain(issuedToken());
  });

  it('still accepts the same token after a reset and a fresh subscribe', () => {
    interceptFrames();

    // The disarm path, exactly as `./agent.ts` runs it at the end of every
    // capture: configureTransport({enabled:false}), resetTransport(), then a
    // new subscription. A token cleared there would leave the bridge holding a
    // stale value and this document unable to start a second capture.
    configureTransport({ enabled: false });
    resetTransport();

    const afterReset: BridgeInboundMessage[] = [];
    const stop = subscribe((message) => {
      afterReset.push(message);
    });

    try {
      configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_B, enabled: true });
      announceBridge('bridge.ready');

      expect(afterReset.map((message) => message.type)).toEqual(['bridge.ready']);
      expect(getTransportStats().bridgeReady).toBe(true);

      emitRange(1);
      flush();

      expect(deliveredOrder()).toEqual([0]);
      expect(at(batchViews(), 0, 'the posted batches').captureId).toBe(CAPTURE_B);
    } finally {
      stop();
    }
  });

  it('answers exactly one handshake request, whatever asks afterwards', async () => {
    // This file's own instance is detached first, so the requests dispatched
    // below reach exactly one listener. Its token is already captured and
    // survives the reset — every later case still posts with it — and leaving
    // it subscribed would only make the offer count ambiguous, because two
    // live instances answer one request twice.
    resetTransport();

    const offers = collectOffers();

    try {
      const fresh = await freshTransport();
      const seen: BridgeInboundMessage[] = [];
      const stop = fresh.subscribe((message) => {
        seen.push(message);
      });

      try {
        // One disclosure so far: the unsolicited offer the mint dispatches, for
        // a bridge that was evaluated before this agent.
        expect(offers.tokens).toHaveLength(1);

        window.dispatchEvent(new CustomEvent(HANDSHAKE_REQUEST_EVENT));

        expect(offers.tokens).toHaveLength(2);
        expect(at(offers.tokens, 1, 'the disclosed tokens')).toBe(
          at(offers.tokens, 0, 'the disclosed tokens'),
        );

        // Every later ask is unanswered for the life of the document — a bridge
        // that discarded the token must wait for a reload, and a page script
        // that spotted the exchange cannot replay it.
        window.dispatchEvent(new CustomEvent(HANDSHAKE_REQUEST_EVENT));
        window.dispatchEvent(new CustomEvent(HANDSHAKE_REQUEST_EVENT));

        expect(offers.tokens).toHaveLength(2);

        // And what the answer carried is what that instance accepts.
        deliverFrame({
          source: BRIDGE_SOURCE_TAG,
          version: CHANNEL_VERSION,
          type: 'bridge.ready',
          token: at(offers.tokens, 1, 'the disclosed tokens'),
          payload: {},
        });

        expect(seen.map((message) => message.type)).toEqual(['bridge.ready']);
      } finally {
        stop();
        fresh.resetTransport();
      }
    } finally {
      offers.stop();
    }
  });

  it('accepts nothing on an instance whose disclosure nobody joined', async () => {
    const fresh = await freshTransport();
    const seen: BridgeInboundMessage[] = [];
    const stop = fresh.subscribe((message) => {
      seen.push(message);
    });

    try {
      // Nothing here listened for that instance's offer and nothing asked it
      // for one, which is the position a page script is in when the bridge got
      // there first. An all-zero token is a value no instance can have issued:
      // the mint refuses one, precisely so that a `getRandomValues` stub which
      // fills nothing cannot pass for a secret.
      const unissued = '0'.repeat(issuedToken().length);

      deliverFrame({
        source: BRIDGE_SOURCE_TAG,
        version: CHANNEL_VERSION,
        type: 'bridge.ready',
        payload: {},
      });
      deliverFrame({
        source: BRIDGE_SOURCE_TAG,
        version: CHANNEL_VERSION,
        type: 'bridge.ready',
        token: unissued,
        payload: {},
      });
      deliverFrame({
        source: BRIDGE_SOURCE_TAG,
        version: CHANNEL_VERSION,
        type: 'agent.config',
        token: unissued,
        payload: { sessionId: SESSION_ID, captureId: CAPTURE_B },
      });

      expect(seen).toEqual([]);
      expect(fresh.getTransportStats().bridgeReady).toBe(false);
    } finally {
      stop();
      fresh.resetTransport();
    }
  });
});
