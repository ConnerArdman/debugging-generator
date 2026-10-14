/**
 * Colocated tests for `./live-tail.ts`: the bounded, redacted stream of
 * `telemetry.tail` frames the DevTools panel shows during a capture.
 *
 * What is on trial is the delivery contract, because breaking it silently
 * costs a reconnecting panel the evidence it was about to show:
 *
 * 1. **A frame is delivered only on a receipt.** The broadcaster answers how
 *    many connections received the frame. A positive count is the only thing
 *    that dequeues events and counts them as sent; a count of zero — the bound
 *    tab has no online DevTools connection — and a broadcast that throws both
 *    leave the frame first in line, in order, and retried with backoff.
 * 2. **Retention is bounded.** An undelivered backlog is held for at most
 *    `maxBufferedEvents` events and at most `TAIL_UNDELIVERED_RETENTION_MS`
 *    from the outage's first undelivered attempt; past either bound it is
 *    truncated or released, counted, and logged apart from ordinary overflow.
 * 3. **Rejection and shutdown are final.** An invalid frame is discarded rather
 *    than retried, because it would fail again; a duplicate is skipped whether
 *    its original waits in the backlog or was recently sent; the provenance
 *    guard refuses anything that is not a persisted event of its session; and
 *    `close()` releases every timer, a pending retry included.
 *
 * ## Fixture conventions
 *
 * Hermetic, like the rest of the `local-service` project: no socket, no
 * database, no wall clock and no real timer. The scheduler is hand-driven —
 * {@link ManualScheduler.fireNext} advances the injected clock to the timer's
 * due time and runs it — and the broadcaster records every attempt and answers
 * whatever receipt the case scripts. Expectations are derived from the
 * exported constants (`TAIL_FLUSH_INTERVAL_MS`, `TAIL_RETRY_MAX_DELAY_MS`,
 * `TAIL_UNDELIVERED_RETENTION_MS`, `TAIL_CLIENT_KINDS`) rather than restated as
 * literals. Event names are invented and generic; nothing names a real
 * project's symbol or route.
 *
 * `parseTelemetryTailPayload` is wrapped so a case can make the next frame
 * fail validation: the provenance guard admits only schema-valid persisted
 * events of the session, so an invalid frame cannot otherwise be produced,
 * and the discard path would go untested.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_TAIL_CAPTURE_TALLIES, isMessageOfType } from '@debuggen/protocol';
import type { ClientKind, ProtocolMessage, TelemetryTailCaptureTally } from '@debuggen/protocol';
import {
  DebuggenError,
  createConsoleLogger,
  newCaptureId,
  newEventId,
  newProducerId,
  newSessionId,
  newSpanId,
  newTraceId,
} from '@debuggen/shared';
import type {
  CaptureId,
  LogLevel,
  LogRecord,
  ProducerId,
  Result,
  SessionId,
} from '@debuggen/shared';
import { allowedTiersFor } from '@debuggen/telemetry';
import type { TelemetryEvent, TelemetryKind } from '@debuggen/telemetry';

import {
  TAIL_CLIENT_KINDS,
  TAIL_FLUSH_INTERVAL_MS,
  TAIL_MAX_TRACKED_CAPTURES,
  TAIL_RETRY_MAX_DELAY_MS,
  TAIL_UNDELIVERED_RETENTION_MS,
  createLiveTail,
} from './live-tail.js';
import type {
  CaptureArrivals,
  LiveTail,
  LiveTailDeps,
  TailBroadcaster,
  TailScheduler,
  TailTimer,
} from './live-tail.js';

// ---------------------------------------------------------------------------
// The wrapped frame validator
// ---------------------------------------------------------------------------

/**
 * How many upcoming frame validations fail, and how. Reset before every case.
 * Hoisted because `vi.mock` factories run before the module's own bindings.
 */
const tailValidation = vi.hoisted(() => ({ refuseNext: 0, throwNext: 0 }));

/**
 * `@debuggen/protocol` with `parseTelemetryTailPayload` delegating to the real
 * validator unless a case has scripted a failure. A refusal is the real
 * validator's own answer to an empty payload, so the error is genuine.
 */
vi.mock('@debuggen/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@debuggen/protocol')>();
  return {
    ...actual,
    parseTelemetryTailPayload: (value: unknown) => {
      if (tailValidation.throwNext > 0) {
        tailValidation.throwNext -= 1;
        throw new Error('the frame validator failed');
      }
      if (tailValidation.refuseNext > 0) {
        tailValidation.refuseNext -= 1;
        return actual.parseTelemetryTailPayload({});
      }
      return actual.parseTelemetryTailPayload(value);
    },
  };
});

beforeEach(() => {
  tailValidation.refuseNext = 0;
  tailValidation.throwNext = 0;
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The epoch millisecond every clock and event time in this file starts from. */
const BASE_TIME = 1_768_000_000_000;

/** The session most cases tail. */
const SESSION: SessionId = newSessionId();

/** A second session, for provenance and multi-session cases. */
const OTHER_SESSION: SessionId = newSessionId();

/** The capture every fixture belongs to. */
const CAPTURE: CaptureId = newCaptureId();

/** The producer every fixture comes from. */
const PRODUCER: ProducerId = newProducerId();

/** The kind every fixture reports. */
const KIND: TelemetryKind = 'function';

/**
 * A name no log record may ever contain: the tail logs counts only, never an
 * event's name, id or attribute value.
 */
const SENTINEL_NAME = 'tail-privacy-sentinel-operation';

// ---------------------------------------------------------------------------
// Event fixtures
// ---------------------------------------------------------------------------

/** The store's arrival counter; one-based and never reset, like `ingest_seq`. */
let ingestOrdinal = 0;

/** The first tier the kind/tier table permits, so every fixture is schema-valid by construction. */
function tierFor(kind: TelemetryKind): TelemetryEvent['tier'] {
  const [tier] = allowedTiersFor(kind);
  if (tier === undefined) {
    throw new Error(`the kind/tier table lists no tier for kind "${kind}"`);
  }
  return tier;
}

/**
 * One persisted event: redacted, attributed to `sessionId` and stamped with a
 * store-assigned `ingestSeq`, exactly what `insertMany` returns.
 */
function makeEvent(sessionId: SessionId = SESSION): TelemetryEvent {
  ingestOrdinal += 1;
  return {
    id: newEventId(),
    traceId: newTraceId(),
    spanId: newSpanId(),
    kind: KIND,
    name: SENTINEL_NAME,
    startTime: BASE_TIME + ingestOrdinal + 0.25,
    duration: 1.5,
    tier: tierFor(KIND),
    attributes: {},
    status: 'ok',
    producerId: PRODUCER,
    seq: ingestOrdinal - 1,
    sessionId,
    captureId: CAPTURE,
    ingestSeq: ingestOrdinal,
  };
}

/** `count` fresh persisted events of one session, in arrival order. */
function makeEvents(count: number, sessionId: SessionId = SESSION): TelemetryEvent[] {
  return Array.from({ length: count }, () => makeEvent(sessionId));
}

/** The ids of a list of events, in order. */
function idsOf(events: readonly TelemetryEvent[]): string[] {
  return events.map((event) => event.id);
}

// ---------------------------------------------------------------------------
// The hand-driven clock and scheduler
// ---------------------------------------------------------------------------

/** The injected clock: it moves only when the scheduler fires a timer or a case advances it. */
interface ManualClock {
  readonly now: () => number;
  readonly advanceTo: (at: number) => void;
}

function createManualClock(): ManualClock {
  let current = BASE_TIME;
  return {
    now: () => current,
    advanceTo: (at) => {
      current = Math.max(current, at);
    },
  };
}

/** One `setTimer` call the scheduler recorded. */
interface ScheduledTimer {
  readonly handle: TailTimer;
  readonly fn: () => void;
  readonly ms: number;
  readonly dueAt: number;
  active: boolean;
}

/** A scheduler that runs nothing until a case fires a timer. */
interface ManualScheduler {
  readonly scheduler: TailScheduler;
  /** Every delay `setTimer` was asked for, in call order. */
  readonly delays: () => number[];
  /** The timers not yet fired or cleared. */
  readonly pending: () => ScheduledTimer[];
  /** How many `clearTimer` calls named a timer that was still pending. */
  readonly clearedPending: () => number;
  /**
   * Advances the clock to the oldest pending timer's due time and runs it.
   *
   * @returns The delay that timer was scheduled with.
   */
  readonly fireNext: () => number;
}

function createManualScheduler(clock: ManualClock): ManualScheduler {
  const timers: ScheduledTimer[] = [];
  let clearedPending = 0;

  const scheduler: TailScheduler = {
    setTimer(fn, ms) {
      const handle: TailTimer = {};
      timers.push({ handle, fn, ms, dueAt: clock.now() + ms, active: true });
      return handle;
    },
    clearTimer(handle) {
      const timer = timers.find((candidate) => candidate.handle === handle);
      if (timer?.active === true) {
        timer.active = false;
        clearedPending += 1;
      }
    },
  };

  return {
    scheduler,
    delays: () => timers.map((timer) => timer.ms),
    pending: () => timers.filter((timer) => timer.active),
    clearedPending: () => clearedPending,
    fireNext: () => {
      const timer = timers.find((candidate) => candidate.active);
      if (timer === undefined) {
        throw new Error('no live-tail timer is pending');
      }
      timer.active = false;
      clock.advanceTo(timer.dueAt);
      timer.fn();
      return timer.ms;
    },
  };
}

// ---------------------------------------------------------------------------
// The recording broadcaster
// ---------------------------------------------------------------------------

/** What the scripted broadcaster answers: a receipt of one, of zero, or a throw. */
type ReceiptMode = 'deliver' | 'nobody' | 'throw';

/** One `broadcastToKinds` call, whatever it answered. */
interface BroadcastAttempt {
  readonly sessionId: string;
  readonly kinds: readonly ClientKind[];
  readonly message: ProtocolMessage;
}

interface RecordingBroadcaster {
  readonly broadcaster: TailBroadcaster;
  /** Every attempt, delivered or not. */
  readonly attempts: BroadcastAttempt[];
  /** Every frame that a (simulated) connection received. */
  readonly delivered: ProtocolMessage[];
  /** Scripts the receipt of every later attempt. */
  readonly answer: (mode: ReceiptMode) => void;
  /** Runs `hook` inside the next attempt, before it answers — for re-entrancy cases. */
  readonly duringNextSend: (hook: () => void) => void;
}

function createRecordingBroadcaster(): RecordingBroadcaster {
  const attempts: BroadcastAttempt[] = [];
  const delivered: ProtocolMessage[] = [];
  let mode: ReceiptMode = 'deliver';
  let hook: (() => void) | undefined;

  const broadcaster: TailBroadcaster = {
    broadcast: () => {
      throw new Error('the live tail must deliver through broadcastToKinds only');
    },
    broadcastToKinds: (sessionId, kinds, message) => {
      attempts.push({ sessionId, kinds: [...kinds], message });
      const pendingHook = hook;
      hook = undefined;
      pendingHook?.();
      if (mode === 'throw') {
        throw new DebuggenError('TRANSPORT_DISCONNECTED', 'the socket went away mid-send');
      }
      if (mode === 'nobody') {
        return 0;
      }
      delivered.push(message);
      return 1;
    },
  };

  return {
    broadcaster,
    attempts,
    delivered,
    answer: (next) => {
      mode = next;
    },
    duringNextSend: (next) => {
      hook = next;
    },
  };
}

/** The events a list of frames carried, in order. */
function tailedEvents(messages: readonly ProtocolMessage[]): TelemetryEvent[] {
  return messages.flatMap((message) =>
    isMessageOfType(message, 'telemetry.tail') ? message.payload.events : [],
  );
}

/** The ids the frames of a list carried, in order. */
function tailedIds(messages: readonly ProtocolMessage[]): string[] {
  return idsOf(tailedEvents(messages));
}

/** The capture tallies each frame of a list carried, in order (`undefined` for a frame without). */
function tailedTallies(
  messages: readonly ProtocolMessage[],
): (readonly TelemetryTailCaptureTally[] | undefined)[] {
  return messages.flatMap((message) =>
    isMessageOfType(message, 'telemetry.tail') ? [message.payload.captures] : [],
  );
}

/**
 * A {@link CaptureArrivals} double: the store's committed count per capture,
 * set by the case, with every read recorded.
 */
interface ScriptedArrivals {
  readonly arrivals: CaptureArrivals;
  /** Sets what the store reports for a capture of {@link SESSION}. */
  readonly commit: (captureId: CaptureId, eventCount: number) => void;
  /** Makes every later read refuse (`'refuse'`), throw (`'throw'`) or answer (`'answer'`). */
  readonly mode: (next: 'answer' | 'refuse' | 'throw') => void;
  /** Every read, as `session/capture`. */
  readonly reads: string[];
}

function createScriptedArrivals(): ScriptedArrivals {
  const counts = new Map<string, number>();
  const reads: string[] = [];
  let mode: 'answer' | 'refuse' | 'throw' = 'answer';
  return {
    arrivals: {
      captureWatermark(sessionId, captureId) {
        reads.push(`${sessionId}/${captureId}`);
        if (mode === 'throw') {
          throw new Error('the store is unavailable');
        }
        if (mode === 'refuse') {
          return {
            ok: false,
            error: new DebuggenError('STORE_ERROR', 'the tracker could not be read'),
          };
        }
        return { ok: true, value: { eventCount: counts.get(`${sessionId}/${captureId}`) ?? 0 } };
      },
    },
    commit: (captureId, eventCount) => {
      counts.set(`${SESSION}/${captureId}`, eventCount);
    },
    mode: (next) => {
      mode = next;
    },
    reads,
  };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly tail: LiveTail;
  readonly clock: ManualClock;
  readonly timers: ManualScheduler;
  readonly transport: RecordingBroadcaster;
  readonly records: LogRecord[];
  /** The records written with `message`, optionally at one level. */
  readonly logged: (message: RegExp, level?: LogLevel) => LogRecord[];
}

type HarnessOptions = Pick<
  LiveTailDeps,
  'flushIntervalMs' | 'maxEventsPerFrame' | 'maxBufferedEvents' | 'arrivals'
>;

function createHarness(options: HarnessOptions = {}): Harness {
  const clock = createManualClock();
  const timers = createManualScheduler(clock);
  const transport = createRecordingBroadcaster();
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });
  const tail = createLiveTail({
    broadcaster: transport.broadcaster,
    logger,
    now: clock.now,
    scheduler: timers.scheduler,
    ...options,
  });
  return {
    tail,
    clock,
    timers,
    transport,
    records,
    logged: (message, level) =>
      records.filter(
        (record) => message.test(record.message) && (level === undefined || record.level === level),
      ),
  };
}

/** Asserts a `Result` is `ok` and returns its value. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** Asserts a `Result` is `err` and returns its error. */
function expectErr(result: Result<unknown, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error('expected err, got ok');
  }
  return result.error;
}

/** Asserts no log record carries an event's name or id (the tail logs counts only). */
function expectCountsOnly(records: readonly LogRecord[], events: readonly TelemetryEvent[]): void {
  const text = JSON.stringify(records);
  expect(text).not.toContain(SENTINEL_NAME);
  for (const event of events) {
    expect(text).not.toContain(event.id);
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('the counters', () => {
  it('start at zero and include every documented counter', () => {
    const { tail } = createHarness();

    expect(tail.stats()).toEqual({
      buffered: 0,
      sessions: 0,
      framesSent: 0,
      eventsSent: 0,
      eventsDropped: 0,
      eventsRejected: 0,
      duplicatesSkipped: 0,
      framesFailed: 0,
      eventsFailed: 0,
      framesUndelivered: 0,
      eventsExpired: 0,
      eventsTruncatedWhileUndelivered: 0,
    });
  });
});

describe('delivery on a receipt', () => {
  it('sends one frame per coalescing window, in arrival order, to the DevTools kind only', () => {
    const { tail, timers, transport } = createHarness();
    const events = makeEvents(3);

    expectOk(tail.push(SESSION, events));
    expect(transport.attempts, 'push never sends synchronously').toHaveLength(0);
    expect(timers.fireNext()).toBe(TAIL_FLUSH_INTERVAL_MS);

    expect(transport.attempts).toHaveLength(1);
    const [attempt] = transport.attempts;
    expect(attempt?.sessionId).toBe(SESSION);
    expect(attempt?.kinds).toEqual([...TAIL_CLIENT_KINDS]);
    expect(tailedIds(transport.delivered)).toEqual(idsOf(events));
    expect(tailedEvents(transport.delivered), 'frames carry the stored rows unchanged').toEqual(
      events,
    );
    expect(timers.pending(), 'an emptied buffer arms nothing').toHaveLength(0);
    expect(tail.stats()).toMatchObject({
      buffered: 0,
      framesSent: 1,
      eventsSent: 3,
      framesUndelivered: 0,
    });
  });

  it('keeps a zero-recipient frame first in line, retries it with exponential backoff, and delivers the backlog in order once a panel receives', () => {
    const { tail, timers, transport, logged } = createHarness({ maxEventsPerFrame: 2 });
    const events = makeEvents(5);
    transport.answer('nobody');

    expectOk(tail.push(SESSION, events));
    const failedAttempts = 5;
    for (let attempt = 0; attempt < failedAttempts; attempt += 1) {
      timers.fireNext();
    }

    // Not one event counted as sent, none dequeued, every attempt the same front frame.
    expect(tail.stats()).toMatchObject({
      buffered: 5,
      framesSent: 0,
      eventsSent: 0,
      framesUndelivered: failedAttempts,
      framesFailed: 0,
      eventsFailed: 0,
    });
    for (const attempt of transport.attempts) {
      expect(tailedIds([attempt.message])).toEqual(idsOf(events.slice(0, 2)));
    }

    // The coalescing window, then a backoff that starts there and doubles to its ceiling.
    const expectedDelays = [TAIL_FLUSH_INTERVAL_MS];
    let delay = TAIL_FLUSH_INTERVAL_MS;
    for (let attempt = 0; attempt < failedAttempts; attempt += 1) {
      expectedDelays.push(delay);
      delay = Math.min(delay * 2, TAIL_RETRY_MAX_DELAY_MS);
    }
    expect(timers.delays()).toEqual(expectedDelays);
    expect(timers.delays().at(-1)).toBe(TAIL_RETRY_MAX_DELAY_MS);

    // A panel appears: the retry delivers, the backoff resets, the backlog drains at the normal pace.
    transport.answer('deliver');
    timers.fireNext();
    expect(timers.pending().map((timer) => timer.ms)).toEqual([TAIL_FLUSH_INTERVAL_MS]);
    timers.fireNext();
    timers.fireNext();
    expect(timers.pending()).toHaveLength(0);

    expect(tailedIds(transport.delivered), 'every event once, in original order').toEqual(
      idsOf(events),
    );
    expect(tail.stats()).toMatchObject({
      buffered: 0,
      framesSent: 3,
      eventsSent: 5,
      framesUndelivered: failedAttempts,
      eventsExpired: 0,
    });
    const [recovered] = logged(/delivery resumed/, 'info');
    expect(recovered?.fields).toMatchObject({ count: failedAttempts });
  });

  it('keeps a frame whose broadcast throws and delivers it once the transport recovers', () => {
    const { tail, timers, transport, logged, records } = createHarness();
    const events = makeEvents(3);
    transport.answer('throw');

    expectOk(tail.push(SESSION, events));
    timers.fireNext();

    expect(tail.stats()).toMatchObject({
      buffered: 3,
      framesSent: 0,
      framesUndelivered: 1,
      framesFailed: 0,
      eventsFailed: 0,
    });
    const [threw] = logged(/broadcast threw/, 'error');
    expect(threw?.fields).toMatchObject({ count: 3, code: 'TRANSPORT_DISCONNECTED' });
    expect(timers.pending(), 'the retry is armed').toHaveLength(1);

    transport.answer('deliver');
    timers.fireNext();

    expect(tailedIds(transport.delivered)).toEqual(idsOf(events));
    expect(tail.stats()).toMatchObject({ buffered: 0, framesSent: 1, eventsSent: 3 });
    expectCountsOnly(records, events);
  });

  it('treats a receipt that is not a positive number as reaching nobody', () => {
    const receipts: unknown[] = [0, -1, Number.NaN, undefined, '1'];
    const events = makeEvents(1);

    for (const receipt of receipts) {
      const clock = createManualClock();
      const timers = createManualScheduler(clock);
      // A structural double written without the receipt type, as a plain
      // JavaScript broadcaster would be.
      const loose = {
        broadcast: () => undefined,
        broadcastToKinds: () => receipt,
      };
      const tail = createLiveTail({
        broadcaster: loose as unknown as TailBroadcaster,
        now: clock.now,
        scheduler: timers.scheduler,
      });

      expectOk(tail.push(SESSION, events));
      timers.fireNext();

      expect(tail.stats(), `receipt ${String(receipt)}`).toMatchObject({
        buffered: 1,
        framesSent: 0,
        eventsSent: 0,
        framesUndelivered: 1,
      });
      tail.close();
    }
  });
});

describe('bounded retention of an undelivered backlog', () => {
  it('releases the backlog once the outage outlives the retention window, then waits for the next push', () => {
    const { tail, clock, timers, transport, logged, records } = createHarness();
    const events = makeEvents(4);
    transport.answer('nobody');

    expectOk(tail.push(SESSION, events));
    timers.fireNext();
    const outageBegan = clock.now();

    let fired = 1;
    while (timers.pending().length > 0) {
      expect(fired, 'the retry loop must end').toBeLessThan(100);
      timers.fireNext();
      fired += 1;
    }

    // The last attempt was the first at or past the window; every earlier one was inside it.
    expect(clock.now() - outageBegan).toBeGreaterThanOrEqual(TAIL_UNDELIVERED_RETENTION_MS);
    expect(clock.now() - outageBegan).toBeLessThan(
      TAIL_UNDELIVERED_RETENTION_MS + TAIL_RETRY_MAX_DELAY_MS,
    );
    expect(tail.stats()).toMatchObject({
      buffered: 0,
      framesSent: 0,
      framesUndelivered: fired,
      eventsExpired: 4,
    });
    const [expired] = logged(/retention window/, 'warn');
    expect(expired?.fields).toMatchObject({
      count: 4,
      retentionMs: TAIL_UNDELIVERED_RETENTION_MS,
      attempts: fired,
    });

    // The next push re-arms at the coalescing pace; the released events are not replayed.
    const later = makeEvents(1);
    transport.answer('deliver');
    expectOk(tail.push(SESSION, later));
    expect(timers.pending().map((timer) => timer.ms)).toEqual([TAIL_FLUSH_INTERVAL_MS]);
    timers.fireNext();

    expect(tailedIds(transport.delivered)).toEqual(idsOf(later));
    expectCountsOnly(records, events);
  });

  it('reports overflow during an outage as tail truncation, apart from ordinary burst overflow', () => {
    const { tail, timers, transport, logged } = createHarness({
      maxBufferedEvents: 4,
      maxEventsPerFrame: 2,
    });

    // A healthy burst past the bound: ordinary overflow.
    const burst = makeEvents(6);
    expectOk(tail.push(SESSION, burst));
    expect(tail.stats()).toMatchObject({ eventsDropped: 2, eventsTruncatedWhileUndelivered: 0 });
    expect(logged(/buffer is full/, 'warn')).toHaveLength(1);
    timers.fireNext();
    timers.fireNext();
    expect(tailedIds(transport.delivered)).toEqual(idsOf(burst.slice(2)));

    // The panel goes away with a frame in line, and the backlog overflows.
    transport.answer('nobody');
    const waiting = makeEvents(2);
    expectOk(tail.push(SESSION, waiting));
    timers.fireNext();
    const arriving = makeEvents(4);
    expectOk(tail.push(SESSION, arriving));

    expect(tail.stats()).toMatchObject({
      buffered: 4,
      eventsDropped: 2,
      eventsTruncatedWhileUndelivered: 2,
    });
    const [truncated] = logged(/truncated the undelivered backlog/, 'warn');
    expect(truncated?.fields).toMatchObject({ count: 2, bound: 4 });

    // On reconnect the panel receives the newest bound's worth, in order.
    transport.answer('deliver');
    const before = transport.delivered.length;
    timers.fireNext();
    timers.fireNext();
    expect(tailedIds(transport.delivered.slice(before))).toEqual(idsOf(arriving));
  });
});

describe('invalid frames', () => {
  it('discards a frame that fails validation and keeps draining', async () => {
    const { tail, transport, logged } = createHarness({ maxEventsPerFrame: 2 });
    const events = makeEvents(4);
    tailValidation.refuseNext = 1;

    expectOk(tail.push(SESSION, events));
    const flushed = expectErr(await tail.flush(SESSION));

    expect(flushed.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(flushed.details).toEqual({ eventsSent: 2, eventsRemaining: 0, eventsExpired: 0 });
    expect(transport.attempts, 'an invalid frame never reaches the broadcaster').toHaveLength(1);
    expect(tailedIds(transport.delivered)).toEqual(idsOf(events.slice(2)));
    expect(tail.stats()).toMatchObject({
      buffered: 0,
      framesFailed: 1,
      eventsFailed: 2,
      framesUndelivered: 0,
      framesSent: 1,
    });
    expect(logged(/failed validation/, 'error')).toHaveLength(1);
  });

  it('discards a frame whose validator throws, without retrying it', () => {
    const { tail, timers, transport } = createHarness();
    const events = makeEvents(2);
    tailValidation.throwNext = 1;

    expectOk(tail.push(SESSION, events));
    timers.fireNext();

    expect(transport.attempts).toHaveLength(0);
    expect(timers.pending(), 'nothing is left to retry').toHaveLength(0);
    expect(tail.stats()).toMatchObject({ buffered: 0, framesFailed: 1, eventsFailed: 2 });
  });
});

describe('dedupe', () => {
  it('skips a replay of events that are still waiting for delivery, and delivers each once', async () => {
    const { tail, timers, transport } = createHarness();
    const events = makeEvents(3);
    transport.answer('nobody');

    expectOk(tail.push(SESSION, events));
    timers.fireNext();
    expectOk(tail.push(SESSION, events));
    const fresh = makeEvent();
    expectOk(tail.push(SESSION, [events[0]!, fresh]));

    expect(tail.stats()).toMatchObject({ buffered: 4, duplicatesSkipped: 4 });

    transport.answer('deliver');
    expect(expectOk(await tail.flush(SESSION))).toBe(4);
    expect(tailedIds(transport.delivered)).toEqual([...idsOf(events), fresh.id]);

    expectOk(tail.push(SESSION, events));
    expect(tail.stats().duplicatesSkipped, 'recently sent ids are skipped too').toBe(7);
    expect(tail.stats().buffered).toBe(0);
  });
});

describe('flush', () => {
  it('answers TRANSPORT_DISCONNECTED when nobody receives, leaving the backlog queued with the retry armed', async () => {
    const { tail, timers, transport } = createHarness();
    const events = makeEvents(3);
    transport.answer('nobody');

    expectOk(tail.push(SESSION, events));
    const failed = expectErr(await tail.flush(SESSION));

    expect(failed.code).toBe('TRANSPORT_DISCONNECTED');
    expect(failed.details).toEqual({ eventsSent: 0, eventsRemaining: 3, eventsExpired: 0 });
    expect(failed.hint).toMatch(/retried/);
    expect(tail.stats()).toMatchObject({ buffered: 3, framesSent: 0, framesUndelivered: 1 });
    expect(timers.clearedPending(), 'the pre-empted flush timer was cancelled').toBe(1);
    expect(
      timers.pending().map((timer) => timer.ms),
      'the retry, at the first backoff step',
    ).toEqual([TAIL_FLUSH_INTERVAL_MS]);

    transport.answer('deliver');
    expect(expectOk(await tail.flush())).toBe(3);
    expect(tailedIds(transport.delivered)).toEqual(idsOf(events));
    expect(timers.pending()).toHaveLength(0);
  });

  it('answers TRANSPORT_DISCONNECTED for a throwing broadcast across every session, counting the sessions that failed', async () => {
    const { tail, transport } = createHarness();
    transport.answer('throw');

    expectOk(tail.push(SESSION, makeEvents(2)));
    expectOk(tail.push(OTHER_SESSION, makeEvents(1, OTHER_SESSION)));
    const failed = expectErr(await tail.flush());

    expect(failed.code).toBe('TRANSPORT_DISCONNECTED');
    expect(failed.details).toEqual({
      eventsSent: 0,
      eventsRemaining: 3,
      eventsExpired: 0,
      sessionsFailed: 2,
    });
    expect(tail.stats()).toMatchObject({ buffered: 3, framesUndelivered: 2 });
  });

  it('answers ok(0) for an unknown session and for a closed tail', async () => {
    const { tail } = createHarness();

    expect(expectOk(await tail.flush(SESSION))).toBe(0);
    expectOk(tail.push(SESSION, makeEvents(1)));
    tail.close();
    expect(expectOk(await tail.flush())).toBe(0);
  });
});

describe('the provenance guard', () => {
  it('refuses values that are not persisted events of the session and tails the admissible remainder', async () => {
    const { tail, transport } = createHarness();
    const admissible = makeEvent();
    const otherSession = makeEvent(OTHER_SESSION);
    const notPersisted = Object.fromEntries(
      Object.entries(makeEvent()).filter(([key]) => key !== 'ingestSeq'),
    );
    const candidates: readonly unknown[] = [admissible, notPersisted, otherSession];

    const pushed = expectErr(tail.push(SESSION, candidates as readonly TelemetryEvent[]));

    expect(pushed.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(pushed.details).toEqual({ rejected: 2, accepted: 1, duplicates: 0 });
    expect(tail.stats()).toMatchObject({ buffered: 1, eventsRejected: 2 });

    expect(expectOk(await tail.flush(SESSION))).toBe(1);
    expect(tailedIds(transport.delivered)).toEqual([admissible.id]);
  });
});

describe('re-entrancy', () => {
  it('a broadcaster that re-enters flush cannot deliver the front frame twice', () => {
    const { tail, timers, transport } = createHarness();
    const events = makeEvents(2);
    let nested: Promise<unknown> | undefined;
    transport.duringNextSend(() => {
      nested = tail.flush(SESSION);
    });

    expectOk(tail.push(SESSION, events));
    timers.fireNext();

    expect(nested).toBeDefined();
    expect(transport.attempts).toHaveLength(1);
    expect(tailedIds(transport.delivered)).toEqual(idsOf(events));
    expect(tail.stats()).toMatchObject({ buffered: 0, framesSent: 1, eventsSent: 2 });
  });

  it('events pushed from inside a send stay queued behind the frame', () => {
    const { tail, timers, transport } = createHarness();
    const first = makeEvents(2);
    const pushedDuringSend = makeEvent();
    transport.duringNextSend(() => {
      expectOk(tail.push(SESSION, [pushedDuringSend]));
    });

    expectOk(tail.push(SESSION, first));
    timers.fireNext();
    expect(tail.stats().buffered).toBe(1);
    timers.fireNext();

    expect(tailedIds(transport.delivered)).toEqual([...idsOf(first), pushedDuringSend.id]);
  });

  it('removes only what survives of the frame when a push inside the send evicted part of it', () => {
    const { tail, timers, transport } = createHarness({
      maxBufferedEvents: 3,
      maxEventsPerFrame: 2,
    });
    const first = makeEvents(3);
    const overflow = makeEvents(2);
    transport.duringNextSend(() => {
      expectOk(tail.push(SESSION, overflow));
    });

    expectOk(tail.push(SESSION, first));
    timers.fireNext();

    // The frame [first0, first1] was delivered while the push evicted both from
    // the buffer; the remaining three must all still be queued.
    expect(tail.stats()).toMatchObject({ buffered: 3, eventsDropped: 2 });
    timers.fireNext();
    timers.fireNext();
    expect(tailedIds(transport.delivered)).toEqual([...idsOf(first), ...idsOf(overflow)]);
  });

  it('a scheduler that fires synchronously cannot spin on an unreachable panel', async () => {
    const transport = createRecordingBroadcaster();
    const synchronous: TailScheduler = {
      setTimer: (fn) => {
        fn();
        return {};
      },
      clearTimer: () => undefined,
    };
    const tail = createLiveTail({ broadcaster: transport.broadcaster, scheduler: synchronous });
    const events = makeEvents(3);
    transport.answer('nobody');

    expectOk(tail.push(SESSION, events));

    expect(transport.attempts, 'one attempt, no recursive retry').toHaveLength(1);
    expect(tail.stats().buffered).toBe(3);

    transport.answer('deliver');
    expect(expectOk(await tail.flush(SESSION))).toBe(3);
    expect(tailedIds(transport.delivered)).toEqual(idsOf(events));
  });
});

describe('lifecycle', () => {
  it('close() cancels every pending timer, including a retry, discards buffers and refuses later pushes', () => {
    const { tail, timers, transport } = createHarness();
    transport.answer('nobody');
    expectOk(tail.push(SESSION, makeEvents(2)));
    timers.fireNext();
    expectOk(tail.push(OTHER_SESSION, makeEvents(1, OTHER_SESSION)));
    expect(timers.pending(), 'a retry and a flush timer').toHaveLength(2);
    const [stale] = timers.pending();

    tail.close();

    expect(timers.pending()).toHaveLength(0);
    expect(timers.clearedPending()).toBe(2);
    expect(tail.stats()).toMatchObject({ buffered: 0, sessions: 0 });
    expect(expectErr(tail.push(SESSION, makeEvents(1))).code).toBe('TRANSPORT_DISCONNECTED');

    // A callback that fires after close anyway does nothing.
    const attemptsBefore = transport.attempts.length;
    stale?.fn();
    expect(transport.attempts).toHaveLength(attemptsBefore);

    tail.close();
    expect(tail.stats().sessions, 'close is idempotent').toBe(0);
  });

  it('forget() releases a session in an outage, cancelling its retry', () => {
    const { tail, timers, transport } = createHarness();
    transport.answer('nobody');
    expectOk(tail.push(SESSION, makeEvents(2)));
    timers.fireNext();

    tail.forget(SESSION);

    expect(timers.pending()).toHaveLength(0);
    expect(tail.stats()).toMatchObject({ buffered: 0, sessions: 0, eventsExpired: 0 });
  });
});

describe('what a frame counts: per-capture tallies', () => {
  /** A persisted event of {@link SESSION} attributed to another capture. */
  function eventOf(captureId: CaptureId): TelemetryEvent {
    return { ...makeEvent(), captureId };
  }

  /** Fires every pending timer, bounded, so a whole backlog drains. */
  function drainAll(timers: ManualScheduler): void {
    let fired = 0;
    while (timers.pending().length > 0) {
      expect(fired, 'the drain must end').toBeLessThan(200);
      timers.fireNext();
      fired += 1;
    }
  }

  it('reports the store’s committed count, not the number of events it streamed', () => {
    const store = createScriptedArrivals();
    const { tail, timers, transport } = createHarness({ arrivals: store.arrivals });
    const events = makeEvents(3);
    // The store has committed more than this tail was handed: the tally reads the store.
    store.commit(CAPTURE, 9_000);

    expectOk(tail.push(SESSION, events));
    timers.fireNext();

    expect(tailedTallies(transport.delivered)).toEqual([
      [{ captureId: CAPTURE, storedEvents: 9_000, skippedEvents: 0 }],
    ]);
    expect(store.reads).toEqual([`${SESSION}/${CAPTURE}`]);
  });

  it('counts every event the bounded buffer evicted, so streamed plus skipped equals stored', () => {
    const store = createScriptedArrivals();
    const { tail, timers, transport } = createHarness({
      arrivals: store.arrivals,
      maxBufferedEvents: 10,
      maxEventsPerFrame: 4,
    });
    const flood = makeEvents(25);
    store.commit(CAPTURE, flood.length);

    expectOk(tail.push(SESSION, flood));
    drainAll(timers);

    const streamed = tailedEvents(transport.delivered).length;
    const last = tailedTallies(transport.delivered).at(-1);
    expect(streamed).toBe(10);
    expect(last).toEqual([{ captureId: CAPTURE, storedEvents: 25, skippedEvents: 15 }]);
    expect(streamed + (last?.[0]?.skippedEvents ?? 0)).toBe(last?.[0]?.storedEvents);
    // Every frame of the drain already said so, not only the last one.
    for (const tallies of tailedTallies(transport.delivered)) {
      expect(tallies?.[0]).toMatchObject({ storedEvents: 25, skippedEvents: 15 });
    }
  });

  it('keeps failures through an overflow, evicting the oldest other events instead', () => {
    const store = createScriptedArrivals();
    const { tail, timers, transport } = createHarness({
      arrivals: store.arrivals,
      maxBufferedEvents: 4,
      maxEventsPerFrame: 4,
    });
    const failedOperation: TelemetryEvent = { ...makeEvent(), status: 'error' };
    const failure: TelemetryEvent = { ...makeEvent(), kind: 'error', tier: tierFor('error') };
    const burst = makeEvents(6);
    const pushed = [failedOperation, failure, ...burst];
    store.commit(CAPTURE, pushed.length);

    expectOk(tail.push(SESSION, pushed));
    drainAll(timers);

    // The two failures were the oldest, yet they are streamed; the burst's oldest four are not.
    expect(idsOf(tailedEvents(transport.delivered))).toEqual(
      idsOf([failedOperation, failure, ...burst.slice(4)]),
    );
    expect(tailedTallies(transport.delivered).at(-1)).toEqual([
      { captureId: CAPTURE, storedEvents: 8, skippedEvents: 4 },
    ]);
  });

  it('evicts failures too, oldest first, once they alone overflow the buffer', () => {
    const { tail, timers, transport } = createHarness({
      maxBufferedEvents: 2,
      maxEventsPerFrame: 4,
    });
    const failures = Array.from({ length: 3 }, (): TelemetryEvent => ({
      ...makeEvent(),
      status: 'error',
    }));
    const other = makeEvent();

    expectOk(tail.push(SESSION, [...failures, other]));
    drainAll(timers);

    expect(idsOf(tailedEvents(transport.delivered))).toEqual(idsOf(failures.slice(1)));
    expect(tailedTallies(transport.delivered).at(-1)).toEqual([
      { captureId: CAPTURE, storedEvents: 4, skippedEvents: 2 },
    ]);
  });

  it('never lowers a count once the store stops tracking a closed capture', () => {
    const store = createScriptedArrivals();
    const { tail, timers, transport } = createHarness({ arrivals: store.arrivals });
    store.commit(CAPTURE, 7);
    expectOk(tail.push(SESSION, makeEvents(7)));
    timers.fireNext();

    // The capture closed and its watermark was released: the store answers 0.
    store.commit(CAPTURE, 0);
    expectOk(tail.push(SESSION, makeEvents(1)));
    timers.fireNext();

    const counts = tailedTallies(transport.delivered).map((tallies) => tallies?.[0]?.storedEvents);
    expect(counts).toEqual([7, 8]);
  });

  it('without the port, counts the events it admitted, never a duplicate twice', () => {
    const { tail, timers, transport } = createHarness();
    const first = makeEvents(3);

    expectOk(tail.push(SESSION, first));
    timers.fireNext();
    // A replayed batch comes back from insertMany as the same stored rows.
    expectOk(tail.push(SESSION, [...first, ...makeEvents(2)]));
    timers.fireNext();

    expect(tailedTallies(transport.delivered).map((tallies) => tallies?.[0])).toEqual([
      { captureId: CAPTURE, storedEvents: 3, skippedEvents: 0 },
      { captureId: CAPTURE, storedEvents: 5, skippedEvents: 0 },
    ]);
  });

  it('falls back to its own count when the store read refuses or throws, logging the code only', () => {
    const store = createScriptedArrivals();
    const { tail, timers, transport, logged } = createHarness({ arrivals: store.arrivals });
    store.commit(CAPTURE, 40);

    store.mode('refuse');
    expectOk(tail.push(SESSION, makeEvents(2)));
    timers.fireNext();
    store.mode('throw');
    expectOk(tail.push(SESSION, makeEvents(1)));
    timers.fireNext();
    store.mode('answer');
    expectOk(tail.push(SESSION, makeEvents(1)));
    timers.fireNext();

    expect(tailedTallies(transport.delivered).map((tallies) => tallies?.[0]?.storedEvents)).toEqual(
      [2, 3, 40],
    );
    const failures = logged(/stored-event count/, 'debug');
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0]?.fields).toMatchObject({ code: 'STORE_ERROR' });
  });

  it('does not count as skipped the events of a frame a re-entrant push evicted, when that frame was delivered', () => {
    const { tail, timers, transport } = createHarness({
      maxBufferedEvents: 4,
      maxEventsPerFrame: 4,
    });
    const first = makeEvents(4);
    const second = makeEvents(3);
    expectOk(tail.push(SESSION, first));
    // The push overflows the bound while the first frame is inside the broadcaster.
    transport.duringNextSend(() => {
      expectOk(tail.push(SESSION, second));
    });
    drainAll(timers);

    expect(tailedIds(transport.delivered)).toEqual(idsOf([...first, ...second]));
    expect(tailedTallies(transport.delivered).at(-1)).toEqual([
      { captureId: CAPTURE, storedEvents: 7, skippedEvents: 0 },
    ]);
  });

  it('counts them as skipped when that frame reached nobody', () => {
    const { tail, timers, transport } = createHarness({
      maxBufferedEvents: 4,
      maxEventsPerFrame: 4,
    });
    const first = makeEvents(4);
    const second = makeEvents(3);
    expectOk(tail.push(SESSION, first));
    transport.answer('nobody');
    transport.duringNextSend(() => {
      expectOk(tail.push(SESSION, second));
    });
    timers.fireNext();
    transport.answer('deliver');
    drainAll(timers);

    const streamed = tailedEvents(transport.delivered).length;
    expect(streamed).toBe(4);
    expect(tailedTallies(transport.delivered).at(-1)).toEqual([
      { captureId: CAPTURE, storedEvents: 7, skippedEvents: 3 },
    ]);
  });

  it('counts an undelivered backlog released after its retention window as skipped', () => {
    const { tail, timers, transport } = createHarness();
    transport.answer('nobody');
    expectOk(tail.push(SESSION, makeEvents(4)));
    drainAll(timers);
    expect(tail.stats().eventsExpired).toBe(4);

    transport.answer('deliver');
    expectOk(tail.push(SESSION, makeEvents(1)));
    timers.fireNext();

    expect(tailedTallies(transport.delivered).at(-1)).toEqual([
      { captureId: CAPTURE, storedEvents: 5, skippedEvents: 4 },
    ]);
  });

  it('counts the events of a discarded invalid frame as skipped', async () => {
    const { tail, transport } = createHarness({ maxEventsPerFrame: 3 });
    tailValidation.refuseNext = 1;

    expectOk(tail.push(SESSION, makeEvents(5)));
    expectErr(await tail.flush(SESSION));

    expect(tailedTallies(transport.delivered)).toEqual([
      [{ captureId: CAPTURE, storedEvents: 5, skippedEvents: 3 }],
    ]);
  });

  it('keeps a capture’s tally across forget(), counting what was still buffered as skipped', () => {
    const { tail, timers, transport } = createHarness();
    expectOk(tail.push(SESSION, makeEvents(3)));

    tail.forget(SESSION);
    expectOk(tail.push(SESSION, makeEvents(2)));
    timers.fireNext();

    expect(tailedTallies(transport.delivered)).toEqual([
      [{ captureId: CAPTURE, storedEvents: 5, skippedEvents: 3 }],
    ]);
  });

  it('tallies every capture a frame spans, apart per session', () => {
    const { tail, timers, transport } = createHarness();
    const next = newCaptureId();

    expectOk(tail.push(SESSION, [makeEvent(), makeEvent(), eventOf(next)]));
    expectOk(tail.push(OTHER_SESSION, makeEvents(1, OTHER_SESSION)));
    timers.fireNext();
    timers.fireNext();

    const bySession = new Map(
      transport.delivered.map((message) => [
        isMessageOfType(message, 'telemetry.tail') ? message.payload.sessionId : '',
        isMessageOfType(message, 'telemetry.tail') ? message.payload.captures : undefined,
      ]),
    );
    expect(bySession.get(SESSION)).toEqual([
      { captureId: CAPTURE, storedEvents: 2, skippedEvents: 0 },
      { captureId: next, storedEvents: 1, skippedEvents: 0 },
    ]);
    expect(bySession.get(OTHER_SESSION)).toEqual([
      { captureId: CAPTURE, storedEvents: 1, skippedEvents: 0 },
    ]);
  });

  it('carries at most the protocol’s bound of tallies, the most recent captures, and still delivers the frame', () => {
    const { tail, timers, transport } = createHarness();
    const captures = Array.from({ length: MAX_TAIL_CAPTURE_TALLIES + 2 }, () => newCaptureId());
    const events = captures.map((captureId) => eventOf(captureId));

    expectOk(tail.push(SESSION, events));
    timers.fireNext();

    expect(tailedIds(transport.delivered)).toEqual(idsOf(events));
    const [tallies] = tailedTallies(transport.delivered);
    expect(tallies?.map((tally) => tally.captureId)).toEqual(
      captures.slice(-MAX_TAIL_CAPTURE_TALLIES),
    );
    expect(tail.stats().framesFailed).toBe(0);
  });

  it('holds at most TAIL_MAX_TRACKED_CAPTURES tallies, forgetting the least recently used', () => {
    const { tail, timers, transport } = createHarness();
    const first = newCaptureId();
    expectOk(tail.push(SESSION, [eventOf(first), eventOf(first)]));
    timers.fireNext();

    for (let index = 0; index < TAIL_MAX_TRACKED_CAPTURES; index += 1) {
      expectOk(tail.push(SESSION, [eventOf(newCaptureId())]));
    }
    drainAll(timers);
    expectOk(tail.push(SESSION, [eventOf(first)]));
    timers.fireNext();

    // The first capture's tally was evicted by the bound, so its count restarts.
    expect(tailedTallies(transport.delivered).at(-1)).toEqual([
      { captureId: first, storedEvents: 1, skippedEvents: 0 },
    ]);
  });
});
