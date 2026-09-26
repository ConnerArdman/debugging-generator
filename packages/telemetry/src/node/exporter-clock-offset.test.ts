// @vitest-environment node
/**
 * Tests for the Node preload's per-process `clockOffsetMs` (AAP 0.2.3: "a
 * recorded per-producer `clockOffsetMs` (server `Date` header versus local
 * clock, informational)"), measured and stamped by `./exporter.ts`.
 *
 * ## What these cases pin
 *
 * - **Measurement.** Every answered ingest `POST` is a sample of the local
 *   service's `Date`, whatever its status — a `401` included — read against
 *   the injected process clock immediately around the request. A `fetch` that
 *   rejected, and an answer without a `Date`, are no sample; a malformed
 *   `Date` and a clock that throws are counted as rejected ones.
 * - **Stamping.** A span converted before the first answered post carries no
 *   offset; one converted afterwards carries the exact estimate in force when
 *   it was converted — not the one in force when its batch was posted.
 * - **Never restamped.** A retried batch resends the byte-identical body even
 *   when the failed attempt's answer moved the estimate.
 * - **Nothing else changes.** `startTime` and `duration` equal an unsampled
 *   event's; the request keeps exactly its two headers and its two body keys;
 *   the one new key is on the events.
 * - **Process scope.** The estimate survives a capture change and a
 *   `shutdown()`/`reopen()` cycle.
 *
 * ## Techniques
 *
 * The processor takes its `fetch`, its clock and its logger from its caller,
 * so nothing here opens a socket or reads the machine's clock except the one
 * case that asserts the default clock. The `fetch` double moves the injected
 * clock to the case's `receivedAt` before it answers, which is what places the
 * processor's two readings exactly. Fixtures are this file's own, deliberately
 * not borrowed from `./exporter.test.ts`, so this suite cannot fail for that
 * suite's reasons.
 *
 * Expected estimates follow from `../schema/clock-offset.ts`: a sample with
 * header value `D`, sent at `s` and received at `r`, bounds the offset to
 * `[D − r, D + 1000 − s]`, successive samples intersect, and the estimate is
 * the midpoint.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import type { SpanContext } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import type { HrTime, LogFields, Logger, LogLevel, LogLevelSetting } from '@debuggen/shared';

import { HTTP_DATE_RESOLUTION_MS } from '../schema/clock-offset.js';
import type { ClockOffsetSnapshot } from '../schema/clock-offset.js';
import { loadPreloadConfig, PRELOAD_ENV_KEYS, RECONNECT_MAX_MS } from './config.js';
import type { PreloadConfig } from './config.js';
import { NEXT_SPAN_TYPE_ATTRIBUTE, NEXT_SPAN_TYPES } from './convert.js';
import { DebuggenSpanProcessor } from './exporter.js';
import type { CaptureGate } from './exporter.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 *
 * Neutral vocabulary (AAP 0.5.4); the credential is assembled from fragments
 * because `scripts/check-secrets.mjs` measures long literals bound to key-like
 * names.
 * ---------------------------------------------------------------------------
 */

/** The complete ingest endpoint of an imaginary local service. */
const INGEST_URL = 'http://127.0.0.1:43117/telemetry/ingest';

/** An absolute project root that belongs to no particular project. */
const PROJECT_ROOT = '/tmp/debuggen-fixture/clock-offset-project';

/** The server-agent credential; sent, never logged. */
const AGENT_TOKEN = ['dbg', 'fixture', 'clock', 'r'.repeat(28)].join('-');

/** The capture the gate starts in. */
const CAPTURE_A = `cap_${'a'.repeat(16)}`;

/** The capture a capture-change case moves to. */
const CAPTURE_B = `cap_${'b'.repeat(16)}`;

/** The trace every fixture span belongs to. */
const TRACE_ID = 'e'.repeat(32);

/** A present-day span start, as the SDK hands one over. */
const SPAN_START: HrTime = [1_700_000_000, 123_456_789];

/** {@link SPAN_START} plus 10 ms. */
const SPAN_END: HrTime = [1_700_000_000, 133_456_789];

/** The relative duration the SDK records for the same 10 ms. */
const SPAN_DURATION: HrTime = [0, 10_000_000];

/** A whole-second service instant; a `Date` header can only name one. */
const SERVICE_DATE_MS = 1_700_000_000_000;

/**
 * The first answered post: the process clock reads 1.5 s behind the header
 * when the request leaves and 1.4 s behind it when the answer arrives, so the
 * offset lies in `[1 400, 2 500]` and is estimated at 1 950.
 */
const FIRST_SAMPLE = {
  dateMs: SERVICE_DATE_MS,
  sentAt: SERVICE_DATE_MS - 1_500,
  receivedAt: SERVICE_DATE_MS - 1_400,
} as const;

/** What {@link FIRST_SAMPLE} alone yields. */
const FIRST_ESTIMATE: ClockOffsetSnapshot = {
  offsetMs: 1_950,
  lowerBoundMs: 1_400,
  upperBoundMs: 2_500,
  samples: 1,
  accepted: 1,
  resets: 0,
  rejected: 0,
};

/**
 * A later answer after the process clock stepped forward: 5 s ahead of a
 * header 10 s on. Its interval `[−5 100, −4 000]` is disjoint from
 * {@link FIRST_SAMPLE}'s, so the estimate restarts at −4 550.
 */
const STEPPED_SAMPLE = {
  dateMs: SERVICE_DATE_MS + 10_000,
  sentAt: SERVICE_DATE_MS + 15_000,
  receivedAt: SERVICE_DATE_MS + 15_100,
} as const;

/** What an estimator that has seen nothing reports. */
const EMPTY_ESTIMATE: ClockOffsetSnapshot = {
  offsetMs: undefined,
  lowerBoundMs: undefined,
  upperBoundMs: undefined,
  samples: 0,
  accepted: 0,
  resets: 0,
  rejected: 0,
};

/** The key under test, spelled once. */
const CLOCK_OFFSET_KEY = 'clockOffsetMs';

/**
 * A `Date` header value for an instant.
 *
 * @param ms A whole-second instant.
 * @returns Its IMF-fixdate.
 */
function httpDate(ms: number): string {
  return new Date(ms).toUTCString();
}

/**
 * The framework's incoming-request span — classified `http.server` — as a
 * finished `ReadableSpan`; the one cast in this file.
 *
 * @param index Carried in the span id so a posted event names its span.
 * @returns A finished span.
 */
function makeSpan(index: number): ReadableSpan {
  const spanContext: SpanContext = {
    traceId: TRACE_ID,
    spanId: (index + 1).toString(16).padStart(16, '0'),
    traceFlags: TraceFlags.SAMPLED,
  };
  const span: Record<string, unknown> = {
    name: 'GET /api/example',
    kind: SpanKind.SERVER,
    spanContext: (): SpanContext => spanContext,
    startTime: SPAN_START,
    endTime: SPAN_END,
    duration: SPAN_DURATION,
    status: { code: SpanStatusCode.UNSET },
    attributes: {
      [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.request,
      'http.request.method': 'GET',
      'http.route': '/api/example',
    },
    links: [],
    events: [],
    ended: true,
    resource: { attributes: {} },
    instrumentationScope: { name: 'next.js', version: '16.3.5' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
  return span as unknown as ReadableSpan;
}

/**
 * The validated launch configuration, through the real loader.
 *
 * @returns The active configuration.
 */
function activeConfig(): PreloadConfig {
  const result = loadPreloadConfig({
    [PRELOAD_ENV_KEYS.ingestUrl]: INGEST_URL,
    [PRELOAD_ENV_KEYS.token]: AGENT_TOKEN,
    [PRELOAD_ENV_KEYS.projectRoot]: PROJECT_ROOT,
  });
  if (result.mode !== 'active') {
    throw new Error(`the fixture environment did not produce an active config: ${result.reason}`);
  }
  return result.config;
}

/** A gate that wants everything, with a capture a case can move. */
interface MutableGate extends CaptureGate {
  captureId: string | null;
  captureGeneration: number;
}

/**
 * A fresh open gate in {@link CAPTURE_A}.
 *
 * @returns The gate.
 */
function openGate(): MutableGate {
  return { captureId: CAPTURE_A, captureGeneration: 1, isKindEnabled: (): boolean => true };
}

/** One record a diagnostic produced. */
interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields?: LogFields | undefined;
}

/** A logger that keeps every record instead of printing it. */
class RecordingLogger implements Logger {
  readonly level: LogLevelSetting = 'trace';
  readonly entries: LogEntry[];

  /** @param entries The store to append to; a child receives its parent's. */
  constructor(entries: LogEntry[] = []) {
    this.entries = entries;
  }

  trace(message: string, fields?: LogFields): void {
    this.#record('trace', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.#record('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#record('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#record('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#record('error', message, fields);
  }

  fatal(message: string, fields?: LogFields): void {
    this.#record('fatal', message, fields);
  }

  child(bindings: LogFields): Logger {
    void bindings;
    return new RecordingLogger(this.entries);
  }

  /** Every record, messages and fields, as one searchable string. */
  text(): string {
    return this.entries
      .map((entry) => `${entry.message} ${JSON.stringify(entry.fields ?? {})}`)
      .join('\n');
  }

  #record(level: LogLevel, message: string, fields?: LogFields): void {
    this.entries.push(fields === undefined ? { level, message } : { level, message, fields });
  }
}

/*
 * ---------------------------------------------------------------------------
 * The `fetch` double and the clock
 * ---------------------------------------------------------------------------
 */

/** The injected process clock; a case sets it, the double advances it. */
interface TestClock {
  now: number;
}

/** How the double answers one call. */
type Answer =
  | {
      readonly kind: 'respond';
      readonly status: number;
      /** The `Date` header value, or none at all. */
      readonly date?: string | undefined;
      /** Where the clock stands when the answer arrives; unchanged if absent. */
      readonly receivedAt?: number | undefined;
    }
  | { readonly kind: 'reject' };

/** One call the processor made. */
interface FetchCall {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
}

/** The double and its record. */
interface FetchRig {
  readonly impl: typeof fetch;
  readonly calls: FetchCall[];
}

/**
 * A `fetch` that answers from a script, the last answer repeating.
 *
 * @param clock The clock to advance to each answer's `receivedAt`.
 * @param answers The script.
 * @returns The rig.
 */
function createRig(clock: TestClock, answers: readonly Answer[]): FetchRig {
  const calls: FetchCall[] = [];
  const impl: typeof fetch = (input, init) => {
    calls.push({ input, init });
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    if (answer === undefined || answer.kind === 'reject') {
      return Promise.reject(new Error('the ingest endpoint could not be reached'));
    }
    if (answer.receivedAt !== undefined) {
      clock.now = answer.receivedAt;
    }
    const headers: Record<string, string> = answer.date === undefined ? {} : { date: answer.date };
    return Promise.resolve(new Response(null, { status: answer.status, headers }));
  };
  return { impl, calls };
}

/** A processor and everything a case asserts against. */
interface Harness {
  readonly processor: DebuggenSpanProcessor;
  readonly gate: MutableGate;
  readonly clock: TestClock;
  readonly rig: FetchRig;
  readonly logger: RecordingLogger;
}

/** Every harness built by the current case, for teardown. */
const harnesses: Harness[] = [];

/**
 * A processor wired as `register.ts` wires it, plus the injected clock.
 *
 * @param answers How the `fetch` double answers.
 * @param startAt Where the clock stands before the first post.
 * @returns The harness.
 */
function createHarness(answers: readonly Answer[], startAt: number = FIRST_SAMPLE.sentAt): Harness {
  const clock: TestClock = { now: startAt };
  const rig = createRig(clock, answers);
  const gate = openGate();
  const logger = new RecordingLogger();
  const processor = new DebuggenSpanProcessor({
    gate,
    config: activeConfig(),
    logger,
    fetchImpl: rig.impl,
    random: (): number => 0.5,
    now: (): number => clock.now,
  });
  const harness: Harness = { processor, gate, clock, rig, logger };
  harnesses.push(harness);
  return harness;
}

/** The answer that produces {@link FIRST_SAMPLE}. */
const FIRST_ANSWER: Answer = {
  kind: 'respond',
  status: 204,
  date: httpDate(FIRST_SAMPLE.dateMs),
  receivedAt: FIRST_SAMPLE.receivedAt,
};

/**
 * Flush while fake timers are installed, advancing them past every backoff.
 *
 * @param processor The processor.
 */
async function flushThroughBackoff(processor: DebuggenSpanProcessor): Promise<void> {
  const flushing = processor.forceFlush();
  await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);
  await flushing;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const harness of harnesses) {
    if (!harness.processor.isShutDown) {
      await harness.processor.shutdown();
    }
  }
  harnesses.length = 0;
});

/*
 * ---------------------------------------------------------------------------
 * Reading what travelled
 * ---------------------------------------------------------------------------
 */

/**
 * Narrow an unknown value to a record.
 *
 * @param value The value.
 * @param what What it was supposed to be.
 * @returns The record.
 */
function asRecord(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} was not an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * One call of the rig, failing when it does not exist.
 *
 * @param rig The rig.
 * @param index The call's position.
 * @returns The call.
 */
function callAt(rig: FetchRig, index: number): FetchCall {
  const call = rig.calls[index];
  if (call === undefined) {
    throw new Error(`the processor made no call at index ${String(index)}`);
  }
  return call;
}

/**
 * The serialised body of one call.
 *
 * @param call The call.
 * @returns The body text.
 */
function bodyTextOf(call: FetchCall): string {
  const body = call.init?.body;
  if (typeof body !== 'string') {
    throw new Error('the processor posted a body that was not JSON text');
  }
  return body;
}

/**
 * The events of one call's body.
 *
 * @param call The call.
 * @returns Each event as a record.
 */
function eventsOf(call: FetchCall): readonly Readonly<Record<string, unknown>>[] {
  const events: unknown = asRecord(JSON.parse(bodyTextOf(call)), 'the ingest body').events;
  if (!Array.isArray(events)) {
    throw new Error("the ingest body's events were not an array");
  }
  return (events as readonly unknown[]).map((event) => asRecord(event, 'a posted event'));
}

/**
 * The single event of one call's body.
 *
 * @param rig The rig.
 * @param index The call's position.
 * @returns The event.
 */
function onlyEventOf(rig: FetchRig, index: number): Readonly<Record<string, unknown>> {
  const events = eventsOf(callAt(rig, index));
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event === undefined) {
    throw new Error(`call ${String(index)} carried no event`);
  }
  return event;
}

/*
 * ---------------------------------------------------------------------------
 * Cases
 * ---------------------------------------------------------------------------
 */

describe('the preload clock offset', () => {
  it('stamps no offset before the first answer, then the exact estimate at conversion', async () => {
    const { processor, rig } = createHarness([FIRST_ANSWER]);

    processor.onEnd(makeSpan(0));
    expect(processor.clockOffset()).toEqual(EMPTY_ESTIMATE);
    await processor.forceFlush();
    expect(processor.clockOffset()).toEqual(FIRST_ESTIMATE);

    processor.onEnd(makeSpan(1));
    await processor.forceFlush();

    const first = onlyEventOf(rig, 0);
    const second = onlyEventOf(rig, 1);
    expect(Object.hasOwn(first, CLOCK_OFFSET_KEY)).toBe(false);
    // Stamped with the estimate in force at conversion. The second post was a
    // second sample — sent and received at 1.4 s behind the same header, so
    // `[1 400, 2 400]` — and narrowed the estimate after the event was built.
    expect(second[CLOCK_OFFSET_KEY]).toBe(FIRST_ESTIMATE.offsetMs);
    expect(processor.clockOffset()).toEqual({
      offsetMs: 1_900,
      lowerBoundMs: 1_400,
      upperBoundMs: 2_400,
      samples: 2,
      accepted: 2,
      resets: 0,
      rejected: 0,
    });

    // Informational only: the times are the unsampled event's.
    expect(second.startTime).toBe(first.startTime);
    expect(second.duration).toBe(first.duration);
    expect(processor.stats()).toMatchObject({ postedBatches: 2, internalErrors: 0 });
  });

  it('resends a retried batch byte for byte, even when the failed attempt moved the estimate', async () => {
    vi.useFakeTimers();
    const { processor, clock, rig } = createHarness([
      FIRST_ANSWER,
      {
        kind: 'respond',
        status: 503,
        date: httpDate(STEPPED_SAMPLE.dateMs),
        receivedAt: STEPPED_SAMPLE.receivedAt,
      },
      { kind: 'respond', status: 204 },
    ]);

    processor.onEnd(makeSpan(0));
    await flushThroughBackoff(processor);

    processor.onEnd(makeSpan(1));
    clock.now = STEPPED_SAMPLE.sentAt;
    await flushThroughBackoff(processor);

    expect(rig.calls).toHaveLength(3);
    expect(bodyTextOf(callAt(rig, 2))).toBe(bodyTextOf(callAt(rig, 1)));
    expect(onlyEventOf(rig, 2)[CLOCK_OFFSET_KEY]).toBe(FIRST_ESTIMATE.offsetMs);
    expect(processor.clockOffset()).toEqual({
      offsetMs: -4_550,
      lowerBoundMs: -5_100,
      upperBoundMs: -4_000,
      samples: 2,
      accepted: 1,
      resets: 1,
      rejected: 0,
    });

    // The next span is converted under the restarted estimate.
    processor.onEnd(makeSpan(2));
    await flushThroughBackoff(processor);
    expect(onlyEventOf(rig, 3)[CLOCK_OFFSET_KEY]).toBe(-4_550);
  });

  it('samples a refused credential: a 401 still carries the service clock', async () => {
    const { processor, rig } = createHarness([{ ...FIRST_ANSWER, status: 401 }]);

    processor.onEnd(makeSpan(0));
    await processor.forceFlush();

    expect(rig.calls).toHaveLength(1);
    expect(processor.stats().credentialRejected).toBe(true);
    expect(processor.clockOffset()).toEqual(FIRST_ESTIMATE);
  });

  it('takes no sample from a rejected fetch or from an answer without a Date', async () => {
    vi.useFakeTimers();
    const { processor, rig } = createHarness([
      { kind: 'reject' },
      { kind: 'respond', status: 204, receivedAt: FIRST_SAMPLE.receivedAt },
    ]);

    processor.onEnd(makeSpan(0));
    await flushThroughBackoff(processor);
    processor.onEnd(makeSpan(1));
    await flushThroughBackoff(processor);

    expect(rig.calls).toHaveLength(3);
    expect(processor.clockOffset()).toEqual(EMPTY_ESTIMATE);
    expect(Object.hasOwn(onlyEventOf(rig, 2), CLOCK_OFFSET_KEY)).toBe(false);
    expect(processor.stats()).toMatchObject({ postedBatches: 2, internalErrors: 0 });
  });

  it('counts a malformed Date as a rejected sample and stamps nothing', async () => {
    const { processor, rig } = createHarness([
      { kind: 'respond', status: 204, date: 'Fri, 31 Feb 2023 10:00:00 GMT' },
    ]);

    processor.onEnd(makeSpan(0));
    await processor.forceFlush();
    processor.onEnd(makeSpan(1));
    await processor.forceFlush();

    expect(processor.clockOffset()).toEqual({ ...EMPTY_ESTIMATE, samples: 2, rejected: 2 });
    expect(Object.hasOwn(onlyEventOf(rig, 1), CLOCK_OFFSET_KEY)).toBe(false);
  });

  it('changes nothing about the request but the one key on each event', async () => {
    const { processor, rig } = createHarness([FIRST_ANSWER]);

    processor.onEnd(makeSpan(0));
    await processor.forceFlush();
    processor.onEnd(makeSpan(1));
    await processor.forceFlush();

    const unsampled = onlyEventOf(rig, 0);
    const sampled = onlyEventOf(rig, 1);
    expect(Object.keys(sampled).sort()).toEqual(
      [...Object.keys(unsampled), CLOCK_OFFSET_KEY].sort(),
    );

    const { ingestUrl } = activeConfig();
    for (const call of rig.calls) {
      expect(call.input).toBe(ingestUrl);
      expect(call.init?.method).toBe('POST');
      expect(Object.keys(asRecord(call.init?.headers, 'the headers')).sort()).toEqual([
        'Authorization',
        'Content-Type',
      ]);
      expect(Object.keys(asRecord(JSON.parse(bodyTextOf(call)), 'the body')).sort()).toEqual([
        'events',
        'projectRoot',
      ]);
    }
  });

  it('keeps the estimate across a capture change and a shutdown/reopen cycle', async () => {
    const { processor, gate, rig } = createHarness([FIRST_ANSWER]);

    processor.onEnd(makeSpan(0));
    await processor.forceFlush();

    gate.captureId = CAPTURE_B;
    gate.captureGeneration += 1;
    const beforeChange = processor.clockOffset();
    expect(beforeChange).toEqual(FIRST_ESTIMATE);
    processor.onEnd(makeSpan(1));
    await processor.forceFlush();
    expect(onlyEventOf(rig, 1)[CLOCK_OFFSET_KEY]).toBe(beforeChange.offsetMs);

    const beforeShutdown = processor.clockOffset();
    await processor.shutdown();
    processor.reopen();
    expect(processor.clockOffset()).toEqual(beforeShutdown);

    processor.onEnd(makeSpan(2));
    await processor.forceFlush();
    expect(onlyEventOf(rig, 2)[CLOCK_OFFSET_KEY]).toBe(beforeShutdown.offsetMs);
  });

  it('logs the first estimate and each restart with numbers only, never the credential', async () => {
    vi.useFakeTimers();
    const { processor, clock, logger } = createHarness([
      FIRST_ANSWER,
      {
        kind: 'respond',
        status: 204,
        date: httpDate(STEPPED_SAMPLE.dateMs),
        receivedAt: STEPPED_SAMPLE.receivedAt,
      },
    ]);

    processor.onEnd(makeSpan(0));
    await flushThroughBackoff(processor);
    processor.onEnd(makeSpan(1));
    clock.now = STEPPED_SAMPLE.sentAt;
    await flushThroughBackoff(processor);

    const clockLines = logger.entries.filter((entry) => entry.message.includes('clock offset'));
    expect(clockLines.map((entry) => [entry.level, entry.fields])).toEqual([
      ['debug', { offsetMs: 1_950, lowerBoundMs: 1_400, upperBoundMs: 2_500, samples: 1 }],
      ['debug', { offsetMs: -4_550, lowerBoundMs: -5_100, upperBoundMs: -4_000, samples: 2 }],
    ]);
    expect(logger.text()).not.toContain(AGENT_TOKEN);
  });

  it('costs only the sample when the clock throws or the answer has no header bag', async () => {
    const clockFailure = new DebuggenSpanProcessor({
      gate: openGate(),
      config: activeConfig(),
      logger: new RecordingLogger(),
      fetchImpl: createRig({ now: 0 }, [FIRST_ANSWER]).impl,
      now: (): never => {
        throw new Error('the injected clock is broken by design');
      },
    });
    clockFailure.onEnd(makeSpan(0));
    await clockFailure.forceFlush();
    // Both readings failed; the sample they formed was rejected; the batch
    // still travelled.
    expect(clockFailure.clockOffset()).toEqual({ ...EMPTY_ESTIMATE, samples: 1, rejected: 1 });
    expect(clockFailure.stats()).toMatchObject({ postedBatches: 1, internalErrors: 2 });
    await clockFailure.shutdown();

    const bareAnswer = { ok: true, status: 204, body: null } as unknown as Response;
    const headerless = new DebuggenSpanProcessor({
      gate: openGate(),
      config: activeConfig(),
      logger: new RecordingLogger(),
      fetchImpl: (): Promise<Response> => Promise.resolve(bareAnswer),
      now: (): number => FIRST_SAMPLE.sentAt,
    });
    headerless.onEnd(makeSpan(0));
    await headerless.forceFlush();
    expect(headerless.clockOffset()).toEqual(EMPTY_ESTIMATE);
    expect(headerless.stats()).toMatchObject({ postedBatches: 1, internalErrors: 0 });
    await headerless.shutdown();
  });

  it('reads the wall clock by default, the clock span start times come from', async () => {
    const before = Date.now();
    const dateMs = Math.floor(before / HTTP_DATE_RESOLUTION_MS) * HTTP_DATE_RESOLUTION_MS;
    const processor = new DebuggenSpanProcessor({
      gate: openGate(),
      config: activeConfig(),
      logger: new RecordingLogger(),
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(new Response(null, { status: 204, headers: { date: httpDate(dateMs) } })),
    });

    processor.onEnd(makeSpan(0));
    await processor.forceFlush();
    const after = Date.now();
    await processor.shutdown();

    const stats = processor.clockOffset();
    expect(stats).toMatchObject({ samples: 1, accepted: 1 });
    const { lowerBoundMs, upperBoundMs } = stats;
    if (lowerBoundMs === undefined || upperBoundMs === undefined) {
      throw new Error('an accepted sample left the estimate without an interval');
    }
    // lower = D − receivedAt and upper = D + 1000 − sentAt, both readings
    // taken by `Date.now()` between the two brackets.
    expect(lowerBoundMs).toBeGreaterThanOrEqual(dateMs - after);
    expect(lowerBoundMs).toBeLessThanOrEqual(dateMs - before);
    expect(upperBoundMs).toBeGreaterThanOrEqual(dateMs + HTTP_DATE_RESOLUTION_MS - after);
    expect(upperBoundMs).toBeLessThanOrEqual(dateMs + HTTP_DATE_RESOLUTION_MS - before);
  });
});
