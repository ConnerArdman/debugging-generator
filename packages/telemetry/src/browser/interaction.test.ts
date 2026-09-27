// @vitest-environment happy-dom
/**
 * Colocated tests for the close boundary of `./interaction.ts` — the
 * {@link INTERACTION_TAIL_MS} tail that decides whether a request scheduled
 * from a microtask inherits the developer's click or starts a trace of its
 * own.
 *
 * **What this suite owns.** One number, from three sides, on both of the paths
 * that compute it. AAP §0.4.2 specifies the window as closing "after the
 * event's `processingEnd` plus a bounded 50 ms tail for microtask-scheduled
 * requests", and `./interaction.ts` states the same requirement as its own
 * generation intent: `isInteractionWindowOpen()` is true synchronously inside
 * the handler and for at least the tail after the synchronous end, and false
 * afterwards. Everything downstream rests on that instant — `./fetch.ts`
 * injects `traceparent` only while {@link isTracedContext} holds, and
 * `../correlation/correlator.ts` asserts the whole `interaction ⊃ fetch ⊃
 * http.server ⊃ route.handler ⊃ function ⊃ db.query` chain — so the boundary
 * is pinned here at tail−1, tail and tail+1 rather than described.
 *
 * Each of the two ways the deadline is computed gets all three points:
 *
 * 1. **The synchronous fallback.** The `setTimeout(…, 0)` probe measures the
 *    end of the dispatch and the window closes one tail later. This is the
 *    primary signal and the only one available for a fast interaction, because
 *    the Event Timing specification clamps `durationThreshold` to
 *    {@link PERF_EVENT_DURATION_THRESHOLD_MS} and reports nothing below it.
 * 2. **The `PerformanceEventTiming` extension.** An entry whose
 *    `processingEnd` is later than the probe's reading moves the deadline to
 *    `processingEnd` plus the same tail — and, because the window is a
 *    guarantee to the producers reading `resolveEventContext()` and never a
 *    moving target, a later entry reporting an *earlier* `processingEnd` must
 *    leave it exactly where it was.
 *
 * What is asserted at each point is the **inheritance**, not merely the
 * boolean: at tail−1 a resolving request adopts the interaction's own
 * `traceId` with its root `spanId` as `parentSpanId`; at the tail the window is
 * closed, exactly one `interaction` event has been emitted as a trace root
 * (**no `parentSpanId`**), and the same read either falls back to a fresh
 * synthetic root or — the case the hand-off test covers — is taken over by the
 * continuation window of a request that settled during the gesture, which is
 * the precedence `resolveEventContext()` owns. At tail+1 nothing more happens:
 * no second emission and no re-opening, not even when a late entry arrives for
 * the interaction that has already been emitted.
 *
 * **Why fake timers here, when `./continuation.test.ts` refuses them.** The
 * two modules time themselves differently and the harnesses follow. Expiry in
 * `./continuation.ts` is prune-on-read: it owns no timer, its documentation
 * makes that a contract, and its suite therefore injects timestamps and stays
 * a pure function of its call sequence. This module genuinely schedules real
 * timers — a `setTimeout(…, 0)` probe and one close timer — so the only way to
 * observe the deadline is to control the clock those timers run on.
 * `vi.useFakeTimers()` drives `setTimeout`, `Date` **and** `performance.now()`
 * from one clock in this environment, which is what makes "at exactly the
 * tail" a reproducible instant instead of a race against the host: the close
 * timer has fired when the clock reaches the deadline, never before.
 *
 * Two consequences of that choice are load-bearing and deliberate. The gesture
 * is dispatched at {@link GESTURE_PERF_MS} rather than at zero, because
 * `Event.timeStamp` is taken from the same faked clock and the module rejects a
 * non-positive timestamp (falling back to its own clock read) — a click at
 * zero would silently test a different path. And the fake clock does not
 * advance during the dispatch, so the probe's synchronous end equals the
 * gesture's start: the emitted duration of an un-refined interaction is
 * therefore exactly zero, which is a property of the harness rather than of a
 * real gesture.
 *
 * **Why the observer must be a double.** happy-dom supplies a
 * `PerformanceObserver` whose `supportedEntryTypes` does not include `event`:
 * measured here, `observe({ type: 'event' })` neither throws nor ever reports,
 * so the extension path is unreachable on this host. The unstubbed tests are
 * consequently the genuine "no entry ever arrives" fallback, and the extension
 * tests install {@link EventTimingObserverDouble} **before**
 * `attachInteractions()` — the module constructs its observer there and once —
 * then invoke the captured callback with an entry list of their own. The
 * double also proves it is really in the module's path: the `observe` init it
 * recorded is asserted to be the `event` subscription with the specified
 * duration threshold.
 *
 * **Harness.** The root `vitest.config.ts` collects this file into the
 * `telemetry` project, which runs under happy-dom; the pragma on line 1 states
 * the requirement per file, because these cases dispatch into a real document.
 * Emissions are observed by spying on `./transport.ts`'s `emit` — the single
 * function this module hands its one draft to — which is synchronous and
 * sidesteps the transport's 250 ms batch timer entirely, while the transport is
 * still configured with a capture so the module under test runs against the
 * state it sees in production. Teardown detaches the interaction hooks, resets
 * the continuation maps, empties the document, restores the clock, the global
 * and the spy, and resets the transport, so no case can inherit another's
 * window, timer, stub or counter.
 *
 * One gate sits beside the boundary, in the last `describe`: while
 * `./dom-target.ts` has an element pick in flight, the gesture that picks is
 * not an interaction, so it opens no window and emits nothing — in both
 * listener registration orders.
 *
 * The bound itself is always read from the exported
 * {@link INTERACTION_TAIL_MS} and never from the literal 50: the constant is
 * the contract, and a suite that restated the number would keep passing while
 * the product changed underneath it.
 *
 * Attribute keys are spelled literally rather than resolved from
 * `../schema/attributes.ts`. Only two are read here, both to prove an entry was
 * folded in at all; the vocabulary itself is pinned by `../schema/event.test.ts`
 * and repeating that here would couple this boundary suite to a file it has
 * nothing to say about.
 *
 * No `node:` builtin is imported and no fixture is read: this folder is bundled
 * into the page-injected agent IIFE, and `eslint.config.js` forbids a Node
 * builtin anywhere under `src/browser/**`, tests included (AAP §0.2.2, §0.7.1
 * Group 1).
 *
 * @see ./interaction.ts for the module under test.
 * @see ./continuation.test.ts for lineage after this window closes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerPendingContinuation,
  resetContinuations,
  settleContinuation,
} from './continuation.js';
import {
  attachDomTarget,
  cancelElementPick,
  detachDomTarget,
  startElementPick,
  type ElementPickOutcome,
} from './dom-target.js';
import {
  INTERACTION_TAIL_MS,
  PERF_EVENT_DURATION_THRESHOLD_MS,
  attachInteractions,
  detachInteractions,
  getActiveInteraction,
  isInteractionWindowOpen,
  isTracedContext,
  resolveEventContext,
} from './interaction.js';
import type { ActiveInteraction, EventContext } from './interaction.js';
import * as transport from './transport.js';
import type { EventDraft } from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * The time base
 *
 * Every instant below is a reading of the faked monotonic clock, in
 * milliseconds since `vi.useFakeTimers()` installed it — the same basis
 * `./interaction.ts` measures its window on. Offsets from the tail are always
 * expressed against the exported constant so the cases keep their meaning if
 * the bound ever changes.
 * ---------------------------------------------------------------------------
 */

/**
 * When the gesture is dispatched, on the faked monotonic clock.
 *
 * Positive on purpose: happy-dom stamps a constructed `Event` from
 * `performance.now()`, and `./interaction.ts` rejects a non-positive
 * `timeStamp` as unusable and reads its own clock instead. Dispatching at a
 * non-zero instant is therefore what keeps these cases on the
 * `Event.timeStamp` path a real browser takes.
 */
const GESTURE_PERF_MS = 1000;

/**
 * The close deadline of an interaction that no performance entry refined.
 *
 * The probe runs in the same faked instant as the dispatch, so its synchronous
 * end is {@link GESTURE_PERF_MS} and the window closes one tail later.
 */
const SYNC_DEADLINE_PERF_MS = GESTURE_PERF_MS + INTERACTION_TAIL_MS;

/** `processingStart` of the entry the extension cases deliver. */
const ENTRY_PROCESSING_START_PERF_MS = GESTURE_PERF_MS + 5;

/**
 * `processingEnd` of that entry: later than the probe's synchronous end, which
 * is the only way an entry can move the deadline outwards.
 */
const ENTRY_PROCESSING_END_PERF_MS = GESTURE_PERF_MS + 25;

/**
 * When the host reports the entry — after the gesture, before the synchronous
 * deadline it is about to replace.
 *
 * An entry delivered after the close would refine the diagnostic record only,
 * since the event is already emitted and immutable; that case is asserted
 * separately as "cannot re-open".
 */
const ENTRY_DELIVERY_PERF_MS = GESTURE_PERF_MS + 30;

/** The deadline the delivered entry establishes: `processingEnd` plus the tail. */
const ENTRY_DEADLINE_PERF_MS = ENTRY_PROCESSING_END_PERF_MS + INTERACTION_TAIL_MS;

/** `processingStart` of the second, later-arriving entry: earlier than the first. */
const LATE_ENTRY_PROCESSING_START_PERF_MS = GESTURE_PERF_MS + 2;

/** `processingEnd` of that second entry: earlier than the first's, so it must not shorten. */
const LATE_ENTRY_PROCESSING_END_PERF_MS = GESTURE_PERF_MS + 10;

/**
 * When the second entry is delivered: later than the deadline its own
 * `processingEnd` would imply, and still inside the deadline the first entry
 * established.
 *
 * Both halves matter. A module that recomputed the deadline from the newest
 * entry would find it already in the past and close the window on the spot,
 * which is precisely what the case has to be able to detect.
 */
const LATE_ENTRY_DELIVERY_PERF_MS = GESTURE_PERF_MS + 65;

/** `processingEnd` of the entry delivered after the window has closed. */
const POST_CLOSE_ENTRY_PROCESSING_END_PERF_MS = GESTURE_PERF_MS + 500;

/** `PerformanceEventTiming.interactionId` as the host would report it. */
const HOST_INTERACTION_ID = 7;

/*
 * ---------------------------------------------------------------------------
 * Fixed identifiers
 * ---------------------------------------------------------------------------
 */

/** The session the transport is configured with. */
const SESSION_ID = 'sess-interaction-tail';

/** The capture the transport is configured with, so `emit` accepts drafts. */
const CAPTURE_ID = 'cap-interaction-tail';

/**
 * The span id of the request that settles during the gesture, in the real wire
 * shape (16 lowercase hex characters, AAP §0.2.3).
 *
 * Its trace is the interaction's own, because that is what `./fetch.ts`
 * registers for a request started inside an interaction window — which is why
 * the hand-off below keeps one `traceId` across the boundary and changes only
 * the parent.
 */
const REQUEST_SPAN_ID = 'a1b2c3d4e5f60789';

/** The redacted label that request carries. */
const REQUEST_NAME = 'GET /api/inventory/summary';

/*
 * ---------------------------------------------------------------------------
 * The performance-entry double
 *
 * happy-dom's own `PerformanceObserver` never reports an `event` entry (see
 * the module docblock), so the extension path is reached by standing in for
 * the host: the class below captures the callback `./interaction.ts` hands to
 * its constructor and records the `observe` init, and a case then delivers
 * entries through that callback exactly as a host would.
 * ---------------------------------------------------------------------------
 */

/**
 * The `PerformanceEventTiming` fields `./interaction.ts` reads, as a plain
 * object.
 *
 * Structural on purpose: the module narrows an entry with its own field checks
 * rather than with `instanceof PerformanceEventTiming` — a constructor
 * happy-dom does not have — so a literal carrying these fields is exactly what
 * it accepts.
 */
interface EventTimingEntryDouble {
  /** Always `event`; any other value is skipped by the module. */
  readonly entryType: 'event';
  /** The event type, which must be one the interaction coalesced. */
  readonly name: string;
  /** When the input happened, on the monotonic clock. */
  readonly startTime: number;
  /** The user-perceived length of the interaction, up to the next paint. */
  readonly duration: number;
  /** When event dispatch began. */
  readonly processingStart: number;
  /** When the last handler finished — the field that moves the deadline. */
  readonly processingEnd: number;
  /** The host's own grouping of the events of one gesture. */
  readonly interactionId?: number | undefined;
}

/** The one method `./interaction.ts` calls on an observed entry list. */
interface ObservedEntryList {
  /** The batch of entries being reported. */
  getEntries: () => readonly EventTimingEntryDouble[];
}

/** The callback shape the module passes to the `PerformanceObserver` constructor. */
type ObserverCallback = (list: ObservedEntryList) => void;

/**
 * A `PerformanceObserver` stand-in that reports what the test tells it to.
 *
 * Installed with `vi.stubGlobal` **before** `attachInteractions()`, because the
 * module constructs its observer there and exactly once. The statics are class
 * state rather than instance state so a case can reach the callback without
 * holding the instance the module owns; {@link EventTimingObserverDouble.reset}
 * clears them between cases.
 */
class EventTimingObserverDouble {
  /** Every callback constructed since the last reset. The module makes one. */
  static readonly callbacks: ObserverCallback[] = [];

  /** Every `observe` init the module passed, in order. */
  static readonly inits: unknown[] = [];

  /** How many times the module disconnected an observer, for teardown hygiene. */
  static disconnects = 0;

  /** Forget every recorded callback, init and disconnect. */
  static reset(): void {
    EventTimingObserverDouble.callbacks.length = 0;
    EventTimingObserverDouble.inits.length = 0;
    EventTimingObserverDouble.disconnects = 0;
  }

  constructor(callback: ObserverCallback) {
    EventTimingObserverDouble.callbacks.push(callback);
  }

  /** Record the subscription. Nothing is observed: the cases deliver entries. */
  observe(init: unknown): void {
    EventTimingObserverDouble.inits.push(init);
  }

  /** Count the release. There is nothing held, so nothing has to be freed. */
  disconnect(): void {
    EventTimingObserverDouble.disconnects += 1;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Recording
 * ---------------------------------------------------------------------------
 */

/** Every draft the module emitted during the current test, in order. */
const captured: EventDraft[] = [];

/** The recorded `interaction` drafts. */
function emittedInteractions(): EventDraft[] {
  return captured.filter((draft) => draft.kind === 'interaction');
}

/**
 * The single `interaction` draft this gesture produced, or a failure naming
 * how many there were instead.
 *
 * "Exactly one" is half of what the tail boundary means — the close path is
 * idempotent across the timer, the read-path safety valve and a second close
 * attempt — so the count is asserted here rather than in each caller.
 */
function theOneInteraction(): EventDraft {
  const drafts = emittedInteractions();
  expect(drafts).toHaveLength(1);

  const draft = drafts[0];
  if (draft === undefined) {
    throw new Error('interaction.test.ts: no interaction draft was emitted');
  }
  return draft;
}

/*
 * ---------------------------------------------------------------------------
 * Clock and gesture helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Advance the faked clock to an absolute instant, running every timer due at
 * or before it.
 *
 * Absolute rather than relative because every assertion below is written
 * against a deadline, and a chain of relative advances is where an off-by-one
 * in a boundary test hides. Moving backwards is rejected rather than ignored:
 * it would mean the case's own arithmetic is wrong.
 */
function advanceTo(instantPerfMs: number): void {
  const delta = instantPerfMs - performance.now();
  expect(delta).toBeGreaterThanOrEqual(0);
  vi.advanceTimersByTime(delta);
}

/** A fresh `<button>` in the document, as the gesture's target. */
function appendButton(): HTMLButtonElement {
  const button = document.createElement('button');
  document.body.appendChild(button);
  return button;
}

/**
 * The interaction whose window is open, or a failure saying there was none.
 *
 * `getActiveInteraction()` returns `undefined` for a closed window, and
 * `noUncheckedIndexedAccess`-grade narrowing is worth more here than an
 * assertion per call site.
 */
function activeInteractionOrFail(): ActiveInteraction {
  const active = getActiveInteraction();
  if (active === undefined) {
    throw new Error('interaction.test.ts: expected an open interaction window');
  }
  return active;
}

/**
 * Dispatch the gesture at {@link GESTURE_PERF_MS} and let the dispatch probe
 * report, leaving the window open with its synchronous deadline armed.
 *
 * The zero-millisecond advance is the probe: `./interaction.ts` measures the
 * end of the synchronous dispatch with `setTimeout(…, 0)`, so the callback has
 * to be run — and running it does not move the clock, which is why the
 * synchronous end is the gesture's own instant.
 *
 * @returns The open interaction, whose `traceId` and `spanId` are what every
 * event emitted inside the window must inherit.
 */
function openInteraction(): ActiveInteraction {
  advanceTo(GESTURE_PERF_MS);
  appendButton().dispatchEvent(new Event('click', { bubbles: true }));
  vi.advanceTimersByTime(0);
  return activeInteractionOrFail();
}

/**
 * Report one entry to the module through the double's captured callback.
 *
 * Fails loudly when no callback was captured: that means the double was
 * installed after `attachInteractions()`, and the case would otherwise pass by
 * testing nothing.
 */
function deliverEntry(entry: EventTimingEntryDouble): void {
  const callback = EventTimingObserverDouble.callbacks[0];
  if (callback === undefined) {
    throw new Error(
      'interaction.test.ts: no PerformanceObserver callback was captured — stub the global before attachInteractions()',
    );
  }
  callback({ getEntries: () => [entry] });
}

/** The entry that extends the deadline to `processingEnd` plus the tail. */
function extendingEntry(): EventTimingEntryDouble {
  return {
    entryType: 'event',
    name: 'click',
    startTime: GESTURE_PERF_MS,
    // Zero, so `startTime + duration` cannot reach past `processingEnd` and
    // the deadline under test is the one the tail is measured from.
    duration: 0,
    processingStart: ENTRY_PROCESSING_START_PERF_MS,
    processingEnd: ENTRY_PROCESSING_END_PERF_MS,
    interactionId: HOST_INTERACTION_ID,
  };
}

/**
 * Install the double, attach, dispatch the gesture and deliver
 * {@link extendingEntry}, leaving the window open on the entry's deadline.
 *
 * @returns The open interaction, for the inheritance assertions.
 */
function openInteractionWithEntry(): ActiveInteraction {
  vi.stubGlobal('PerformanceObserver', EventTimingObserverDouble);
  attachInteractions();

  const active = openInteraction();
  advanceTo(ENTRY_DELIVERY_PERF_MS);
  deliverEntry(extendingEntry());
  return active;
}

/*
 * ---------------------------------------------------------------------------
 * Lifecycle
 *
 * The module owns process-wide state — one listener set, one observer, two
 * timers and one record — so a case that left any of it behind would decide
 * the next case's answer. Teardown therefore detaches before it restores the
 * clock (a pending timer must be cleared on the clock it was armed on) and
 * empties the document last.
 * ---------------------------------------------------------------------------
 */

beforeEach(() => {
  captured.length = 0;
  EventTimingObserverDouble.reset();
  vi.useFakeTimers();
  transport.resetTransport();
  transport.configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_ID, enabled: true });
  vi.spyOn(transport, 'emit').mockImplementation((draft) => {
    captured.push(draft);
  });
});

afterEach(() => {
  detachInteractions();
  resetContinuations();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  transport.resetTransport();
  document.body.replaceChildren();
  captured.length = 0;
});

/*
 * ---------------------------------------------------------------------------
 * The synchronous fallback window (AAP 0.4.2)
 *
 * The path every fast interaction takes, because the Event Timing threshold
 * means no entry is reported for it at all.
 * ---------------------------------------------------------------------------
 */

describe('the synchronous interaction window', () => {
  it("is open inside the page's own handler, which is what a request issued there inherits", () => {
    attachInteractions();
    advanceTo(GESTURE_PERF_MS);

    const button = appendButton();
    let openInsideHandler = false;
    let contextInsideHandler: EventContext | undefined;
    button.addEventListener('click', () => {
      openInsideHandler = isInteractionWindowOpen();
      contextInsideHandler = resolveEventContext();
    });

    button.dispatchEvent(new Event('click', { bubbles: true }));
    vi.advanceTimersByTime(0);

    // The capture-phase listener on `window` runs ahead of this bubble-phase
    // one, so the trace already exists while the application's handler is
    // still running — the whole reason the listener is registered in capture.
    const active = activeInteractionOrFail();
    expect(openInsideHandler).toBe(true);
    expect(contextInsideHandler?.origin).toBe('interaction');
    expect(contextInsideHandler?.traceId).toBe(active.traceId);
    expect(contextInsideHandler?.parentSpanId).toBe(active.spanId);

    // Nothing is emitted while the window is open: the event carries the
    // interaction's final duration, so it cannot be built before the close.
    expect(emittedInteractions()).toHaveLength(0);
  });

  it('still inherits the interaction trace one millisecond before the tail', () => {
    attachInteractions();
    const active = openInteraction();

    advanceTo(SYNC_DEADLINE_PERF_MS - 1);

    const context = resolveEventContext();
    expect(isInteractionWindowOpen()).toBe(true);
    expect(context.origin).toBe('interaction');
    expect(context.traceId).toBe(active.traceId);
    expect(context.parentSpanId).toBe(active.spanId);
    expect(isTracedContext(context)).toBe(true);
    expect(emittedInteractions()).toHaveLength(0);
  });

  it('has closed at exactly the tail, emitting one trace root, and no longer inherits', () => {
    attachInteractions();
    const active = openInteraction();

    advanceTo(SYNC_DEADLINE_PERF_MS);

    expect(isInteractionWindowOpen()).toBe(false);
    expect(getActiveInteraction()).toBeUndefined();

    const draft = theOneInteraction();
    expect(draft.traceId).toBe(active.traceId);
    expect(draft.spanId).toBe(active.spanId);
    // The root of the tree the panels render: a parent here would orphan it.
    expect('parentSpanId' in draft).toBe(false);
    expect(draft.name).toBe('click button');
    expect(draft.status).toBe('ok');
    // Zero because the faked clock does not advance during the dispatch, so
    // the probe's synchronous end is the gesture's own instant.
    expect(draft.duration).toBe(0);

    // A request resolving at this instant is no longer part of the gesture.
    const context = resolveEventContext();
    expect(context.origin).toBe('synthetic');
    expect(context.traceId).not.toBe(active.traceId);
    expect(context.parentSpanId).toBeUndefined();
    expect(isTracedContext(context)).toBe(false);
  });

  it('stays closed one millisecond past the tail, with no second emission', () => {
    attachInteractions();
    const active = openInteraction();

    advanceTo(SYNC_DEADLINE_PERF_MS + 1);

    expect(isInteractionWindowOpen()).toBe(false);
    expect(resolveEventContext().traceId).not.toBe(active.traceId);
    // Still exactly one: the close path is idempotent, and a second read of a
    // closed window must not re-emit or re-open it.
    expect(theOneInteraction().traceId).toBe(active.traceId);
    expect(emittedInteractions()).toHaveLength(1);
  });

  it('hands lineage to the request settled during the gesture exactly at the tail', () => {
    attachInteractions();
    const active = openInteraction();

    // What `./fetch.ts` does for a request started inside the window: the
    // request belongs to the interaction's trace and carries its own span.
    registerPendingContinuation({
      traceId: active.traceId,
      spanId: REQUEST_SPAN_ID,
      name: REQUEST_NAME,
    });
    advanceTo(GESTURE_PERF_MS + 10);
    settleContinuation(REQUEST_SPAN_ID);

    // Precedence: an open interaction window outranks an open continuation
    // window, so until the tail the parent is still the interaction's root.
    advanceTo(SYNC_DEADLINE_PERF_MS - 1);
    const insideWindow = resolveEventContext();
    expect(insideWindow.origin).toBe('interaction');
    expect(insideWindow.parentSpanId).toBe(active.spanId);
    expect(insideWindow.attributes).toBeUndefined();

    // At the tail the interaction's window is gone and the settled request's
    // continuation takes over — same trace, new parent, lineage annotated.
    advanceTo(SYNC_DEADLINE_PERF_MS);
    const afterWindow = resolveEventContext();
    expect(isInteractionWindowOpen()).toBe(false);
    expect(afterWindow.origin).toBe('continuation');
    expect(afterWindow.traceId).toBe(active.traceId);
    expect(afterWindow.parentSpanId).toBe(REQUEST_SPAN_ID);
    expect(isTracedContext(afterWindow)).toBe(true);
    // The lineage vocabulary belongs to `./continuation.ts` and is pinned by
    // its own suite; what matters here is that the caller is given something
    // to merge, because dropping it costs the panel its dashed edge.
    expect(Object.keys(afterWindow.attributes ?? {}).length).toBeGreaterThan(0);

    expect(theOneInteraction().traceId).toBe(active.traceId);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The PerformanceEventTiming extension (AAP 0.4.2)
 *
 * The same three points, on the deadline an entry establishes:
 * `processingEnd` plus the same tail.
 * ---------------------------------------------------------------------------
 */

describe('the performance-entry extended interaction window', () => {
  it('subscribes to the event entry type with the specified duration threshold', () => {
    vi.stubGlobal('PerformanceObserver', EventTimingObserverDouble);
    attachInteractions();

    // One observer, constructed once, subscribed to the entry type this
    // module refines from — which is what makes the double a stand-in for the
    // host rather than a parallel implementation.
    expect(EventTimingObserverDouble.callbacks).toHaveLength(1);
    expect(EventTimingObserverDouble.inits).toHaveLength(1);
    expect(EventTimingObserverDouble.inits[0]).toMatchObject({
      type: 'event',
      buffered: true,
      durationThreshold: PERF_EVENT_DURATION_THRESHOLD_MS,
    });

    // Still connected: an observer released while attached would make every
    // entry the extension cases deliver one the module could never receive.
    expect(EventTimingObserverDouble.disconnects).toBe(0);
  });

  it('moves the deadline out to processingEnd plus the tail and still inherits one millisecond before it', () => {
    const active = openInteractionWithEntry();

    // The premise of the case: the entry's deadline is genuinely later than
    // the synchronous one, so passing the latter proves the extension applied.
    expect(ENTRY_DEADLINE_PERF_MS).toBeGreaterThan(SYNC_DEADLINE_PERF_MS);
    advanceTo(SYNC_DEADLINE_PERF_MS);
    expect(isInteractionWindowOpen()).toBe(true);
    expect(emittedInteractions()).toHaveLength(0);

    advanceTo(ENTRY_DEADLINE_PERF_MS - 1);

    const context = resolveEventContext();
    expect(isInteractionWindowOpen()).toBe(true);
    expect(context.origin).toBe('interaction');
    expect(context.traceId).toBe(active.traceId);
    expect(context.parentSpanId).toBe(active.spanId);
    expect(isTracedContext(context)).toBe(true);
    expect(emittedInteractions()).toHaveLength(0);
  });

  it('has closed at exactly processingEnd plus the tail, emitting the entry measurements once', () => {
    const active = openInteractionWithEntry();

    advanceTo(ENTRY_DEADLINE_PERF_MS);

    expect(isInteractionWindowOpen()).toBe(false);

    const draft = theOneInteraction();
    expect(draft.traceId).toBe(active.traceId);
    expect(draft.spanId).toBe(active.spanId);
    expect('parentSpanId' in draft).toBe(false);
    // The entry's own account of the interaction, which is what extended the
    // window: measured from the input event's timestamp to its `processingEnd`.
    expect(draft.duration).toBe(ENTRY_PROCESSING_END_PERF_MS - GESTURE_PERF_MS);
    expect(draft.attributes['interactionId']).toBe(HOST_INTERACTION_ID);
    expect(draft.attributes['inputDelay']).toBe(ENTRY_PROCESSING_START_PERF_MS - GESTURE_PERF_MS);

    const context = resolveEventContext();
    expect(context.origin).toBe('synthetic');
    expect(context.traceId).not.toBe(active.traceId);
    expect(isTracedContext(context)).toBe(false);
  });

  it('stays closed one millisecond past processingEnd plus the tail, and a late entry cannot re-open it', () => {
    const active = openInteractionWithEntry();

    advanceTo(ENTRY_DEADLINE_PERF_MS + 1);
    expect(isInteractionWindowOpen()).toBe(false);
    expect(emittedInteractions()).toHaveLength(1);

    // An entry reported after the close still matches the retired record —
    // that is why the record is kept — but it may not resurrect the window or
    // revise an event that has already been emitted.
    deliverEntry({
      entryType: 'event',
      name: 'click',
      startTime: GESTURE_PERF_MS,
      duration: 0,
      processingStart: ENTRY_PROCESSING_START_PERF_MS,
      processingEnd: POST_CLOSE_ENTRY_PROCESSING_END_PERF_MS,
    });

    expect(isInteractionWindowOpen()).toBe(false);
    expect(getActiveInteraction()).toBeUndefined();
    expect(emittedInteractions()).toHaveLength(1);

    // Past the deadline that entry would have established, had it been able to.
    advanceTo(POST_CLOSE_ENTRY_PROCESSING_END_PERF_MS + INTERACTION_TAIL_MS + 1);
    expect(isInteractionWindowOpen()).toBe(false);
    expect(theOneInteraction().traceId).toBe(active.traceId);
    expect(resolveEventContext().origin).toBe('synthetic');
  });

  it('never shortens the deadline when a later entry reports an earlier processingEnd', () => {
    openInteractionWithEntry();

    // The premise of the case: this entry's own deadline is already in the
    // past when it is delivered, and the deadline in force is later still.
    expect(LATE_ENTRY_PROCESSING_END_PERF_MS + INTERACTION_TAIL_MS).toBeLessThan(
      LATE_ENTRY_DELIVERY_PERF_MS,
    );
    expect(LATE_ENTRY_DELIVERY_PERF_MS).toBeLessThan(ENTRY_DEADLINE_PERF_MS);

    advanceTo(LATE_ENTRY_DELIVERY_PERF_MS);
    expect(isInteractionWindowOpen()).toBe(true);

    deliverEntry({
      entryType: 'event',
      name: 'click',
      startTime: GESTURE_PERF_MS,
      duration: 0,
      processingStart: LATE_ENTRY_PROCESSING_START_PERF_MS,
      processingEnd: LATE_ENTRY_PROCESSING_END_PERF_MS,
    });
    expect(isInteractionWindowOpen()).toBe(true);
    expect(emittedInteractions()).toHaveLength(0);

    // The deadline is exactly where the first entry put it: tail−1 open,
    // tail closed.
    advanceTo(ENTRY_DEADLINE_PERF_MS - 1);
    expect(isInteractionWindowOpen()).toBe(true);
    advanceTo(ENTRY_DEADLINE_PERF_MS);
    expect(isInteractionWindowOpen()).toBe(false);

    const draft = theOneInteraction();

    // The late entry was genuinely folded in rather than ignored — which is
    // what makes the unmoved deadline meaningful: the earliest
    // `processingStart` of a coalesced gesture is the one that measures its
    // input delay, and it came from this second entry.
    expect(draft.attributes['inputDelay']).toBe(
      LATE_ENTRY_PROCESSING_START_PERF_MS - GESTURE_PERF_MS,
    );

    // The same "latest wins" rule the deadline follows governs the
    // measurement it is derived from: the emitted duration still runs to the
    // first entry's `processingEnd`, not back to the second's.
    expect(draft.duration).toBe(ENTRY_PROCESSING_END_PERF_MS - GESTURE_PERF_MS);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The picking gesture is not an interaction
 *
 * While "Pick element" has a pick in flight, the click the developer makes
 * chooses an element; `./dom-target.ts` consumes it so the application never
 * sees it. Recording it here would open an interaction window — and a
 * continuation window after it — for a click that caused nothing, so the
 * producer records nothing while a pick is active, whichever of the two
 * listeners was registered first.
 * ---------------------------------------------------------------------------
 */

/**
 * Mark an event as generated by the browser: happy-dom constructs every event
 * without an `isTrusted` property, and the picker acts on trusted events only.
 */
function asTrusted<T extends Event>(event: T): T {
  Object.defineProperty(event, 'isTrusted', { value: true });
  return event;
}

describe('the element picker gesture', () => {
  /** What the pick under test reported. */
  let outcomes: ElementPickOutcome[] = [];
  const record = (outcome: ElementPickOutcome): void => {
    outcomes.push(outcome);
  };

  beforeEach(() => {
    outcomes = [];
    attachDomTarget();
  });

  afterEach(() => {
    cancelElementPick();
    detachDomTarget();
  });

  it('opens no window for the click that picks, although this listener runs first', () => {
    // A capture already running when the developer presses "Pick element":
    // this module's capture-phase listener is on `window` before the
    // picker's, so it sees the picking click before the picker consumes it.
    attachInteractions();
    expect(startElementPick(record)).toBe(true);
    advanceTo(GESTURE_PERF_MS);

    const button = appendButton();
    button.dispatchEvent(
      asTrusted(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })),
    );
    button.dispatchEvent(
      asTrusted(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })),
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe('picked');
    expect(getActiveInteraction()).toBeUndefined();
    expect(isInteractionWindowOpen()).toBe(false);

    advanceTo(SYNC_DEADLINE_PERF_MS + INTERACTION_TAIL_MS);
    expect(emittedInteractions()).toHaveLength(0);
    expect(resolveEventContext().origin).toBe('synthetic');

    // The pick has ended, so the next click is the application's again.
    button.dispatchEvent(new Event('click', { bubbles: true }));
    expect(getActiveInteraction()).toBeDefined();
  });

  it('records no key the picker passes through to the page while a pick is active', () => {
    // The opposite registration order: the pick began before the capture, so
    // the picker's listener runs first — and lets every key but Escape
    // through, which is exactly the event that would reach this module.
    expect(startElementPick(record)).toBe(true);
    attachInteractions();
    advanceTo(GESTURE_PERF_MS);

    const button = appendButton();
    const key = asTrusted(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    button.dispatchEvent(key);

    expect(key.defaultPrevented).toBe(false);
    expect(getActiveInteraction()).toBeUndefined();

    cancelElementPick();
    advanceTo(SYNC_DEADLINE_PERF_MS + INTERACTION_TAIL_MS);
    expect(emittedInteractions()).toHaveLength(0);
    expect(outcomes).toEqual([{ kind: 'cancelled', reason: 'request' }]);
  });
});
