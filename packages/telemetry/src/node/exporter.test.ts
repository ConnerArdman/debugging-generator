// @vitest-environment node
/**
 * Colocated tests for `./exporter.ts` — the batch, buffer, attempt and drain
 * bounds of the dev-server preload's only outbound path, each one exercised at
 * the value itself, one short of it and one over.
 *
 * **What this suite owns.** `../node/control.test.ts` owns the capture gate and
 * the teardown, and it drives this processor only to prove the two drop rules.
 * What it does not reach is every number that decides when a batch travels, how
 * much evidence is held, how hard a failed batch is tried and when a drain
 * stops:
 *
 * - {@link BATCH_MAX_EVENTS} (256) — the size of one POST and the threshold
 *   that triggers a drain. Asserted at 255 (the flush window is armed and
 *   nothing posts), at 256 (one batch of exactly the bound) and at 257 (256
 *   then 1).
 * - {@link MAX_BUFFERED_EVENTS} (5 000) — the cap at which the **oldest**
 *   events make room for the newest, asserted at 4 999, 5 000 and 5 001 with
 *   the drop counted and the discarded event identified from the wire.
 * - {@link MAX_DRAIN_BATCHES} — what makes a drain terminate on a server
 *   producing spans as fast as they are posted. Asserted with a `fetch` that
 *   feeds the processor while it drains: without the cap that drain never
 *   returns and `forceFlush()` never settles.
 * - {@link MAX_POST_ATTEMPTS} (3) — the attempt budget of one batch, with the
 *   permanent answers (a refused credential, a refused batch) taking exactly
 *   one attempt and a `503` taking another.
 * - {@link SHUTDOWN_FLUSH_DEADLINE_MS} — the bound on the final flush, after
 *   which anything still queued is counted rather than held.
 *
 * ## Techniques, and why each one is the way it is
 *
 * **Nothing external is real.** The processor takes its gate, its
 * configuration, its logger and its `fetch` from its caller precisely so a
 * suite needs none of the originals: no socket is opened, no hostname resolved,
 * no file written and `process.env` is never touched — the launch
 * configuration is built by passing a synthesised environment record to the
 * real {@link loadPreloadConfig}, so a change to the configuration contract
 * reaches these cases through the door the preload uses.
 *
 * **The fixtures are this file's own.** `makeSpan`, the environment record and
 * the recording logger are equivalents of the ones in
 * `../node/control.test.ts`, deliberately not imported from it: a suite that
 * borrowed another suite's harness would fail for reasons belonging to the
 * other suite's subject. One `as unknown as ReadableSpan` cast, inside the span
 * builder, is the only assertion of a shape in the file; everything else is
 * checked against the real interfaces.
 *
 * **Feeding is synchronous, which is what makes the cap cases exact.** `onEnd`
 * never awaits, and a drain is queued on a promise chain, so a loop that feeds
 * five thousand spans cannot have a drain run inside it: the buffer depth after
 * the loop is the depth the enqueue path produced, with nothing subtracted by a
 * post that happened to interleave.
 *
 * **A drain is awaited through the promise `#requestDrain` returns.**
 * `forceFlush()` resolves exactly when *its own* drain finishes, so every
 * assertion about what was posted is made after an `await` rather than after a
 * timer, and the suite has no wall-clock waits at all: the two cases that need
 * the backoff or the shutdown deadline to elapse use Vitest's fake timers and
 * advance them explicitly.
 *
 * **Bounds are imported, never spelled**, and the exact/one-over cases are
 * derived from them (`BATCH_MAX_EVENTS - 1`), so retuning a constant in
 * `./config.ts` moves these cases with it instead of leaving them asserting a
 * stale number.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import type { SpanContext } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import type { HrTime, LogFields, Logger, LogLevel, LogLevelSetting } from '@debuggen/shared';

import {
  BATCH_FLUSH_INTERVAL_MS,
  BATCH_MAX_EVENTS,
  loadPreloadConfig,
  MAX_BUFFERED_EVENTS,
  PRELOAD_ENV_KEYS,
  RECONNECT_MIN_MS,
} from './config.js';
import type { PreloadConfig } from './config.js';
import { NEXT_SPAN_TYPE_ATTRIBUTE, NEXT_SPAN_TYPES } from './convert.js';
import {
  DebuggenSpanProcessor,
  MAX_DRAIN_BATCHES,
  MAX_POST_ATTEMPTS,
  SHUTDOWN_FLUSH_DEADLINE_MS,
} from './exporter.js';
import type { CaptureGate } from './exporter.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 *
 * Neutral vocabulary: no value below names a component, service function or
 * route of any particular project (AAP §0.5.4), and the credential is assembled
 * at runtime from short fragments because this file is tracked and
 * `scripts/check-secrets.mjs` measures the density of long literals bound to
 * key-like names.
 * ---------------------------------------------------------------------------
 */

/** Host and port of the imaginary local service every fixture points at. */
const SERVICE_AUTHORITY = '127.0.0.1:43117';

/** The complete ingest endpoint, as the launcher exports it. */
const INGEST_URL = `http://${SERVICE_AUTHORITY}/telemetry/ingest`;

/** An absolute project root that belongs to no particular project. */
const PROJECT_ROOT = '/tmp/debuggen-fixture/sample-project';

/** The server-agent credential the processor is expected to send, never log. */
const AGENT_TOKEN = ['dbg', 'fixture', 'credential', 'q'.repeat(28)].join('-');

/** The capture every case runs under; it scopes the sequence counter. */
const CAPTURE_ID = `cap_${'a'.repeat(16)}`;

/** The trace every fixture span belongs to: 32 lowercase hex characters. */
const TRACE_ID = 'c'.repeat(32);

/** Characters in a span id. */
const SPAN_ID_WIDTH = 16;

/** A route template that belongs to no particular project. */
const REQUEST_ROUTE = '/api/example';

/** The method every fixture request span reports. */
const REQUEST_METHOD = 'GET';

/** A present-day start time, as the SDK hands one over. */
const SPAN_START: HrTime = [1_700_000_000, 123_456_789];

/** {@link SPAN_START} plus 10 ms. */
const SPAN_END: HrTime = [1_700_000_000, 133_456_789];

/** The relative duration the SDK also records for the same 10 ms. */
const SPAN_DURATION: HrTime = [0, 10_000_000];

/** `204 No Content`: the honest shape of an ingest acknowledgement. */
const ACCEPTED_STATUS = 204;

/** `401 Unauthorized`: a credential the service refused. */
const UNAUTHORIZED_STATUS = 401;

/** `400 Bad Request`: a batch the service read and refused. */
const REFUSED_STATUS = 400;

/** `503 Service Unavailable`: a moment rather than an answer. */
const UNAVAILABLE_STATUS = 503;

/*
 * ---------------------------------------------------------------------------
 * Span fixtures
 *
 * One builder, one cast. The member set is `@opentelemetry/sdk-trace-base`
 * 2.11.0's `ReadableSpan`, including the 2.x spellings `parentSpanContext` and
 * `instrumentationScope`, and the classification is driven through the constant
 * table `./convert.ts` exports rather than through a hand-written attribute
 * name.
 * ---------------------------------------------------------------------------
 */

/**
 * A 16-hex span id that encodes its feed index.
 *
 * Offset by one because the all-zero span id is invalid and `./convert.ts`
 * rejects a span carrying it — which would make the first span of every case
 * silently unconvertible.
 *
 * @param index The feed index.
 * @returns The span id.
 */
function spanIdFor(index: number): string {
  return (index + 1).toString(16).padStart(SPAN_ID_WIDTH, '0');
}

/**
 * The single cast boundary of this suite.
 *
 * A `ReadableSpan` is an interface, so a structurally complete object is one;
 * confining the assertion to this function keeps every other line type-checked
 * against the real interface. The span is the framework's incoming-request
 * span, which `./convert.ts` classifies as `http.server` — a kind the fake gate
 * below enables, so every fed span becomes exactly one event.
 *
 * @param index The feed index, carried in the span id so a delivered event can
 * be traced back to the span that produced it.
 * @returns A finished span.
 */
function makeSpan(index: number): ReadableSpan {
  const spanContext: SpanContext = {
    traceId: TRACE_ID,
    spanId: spanIdFor(index),
    traceFlags: TraceFlags.SAMPLED,
  };

  const span: Record<string, unknown> = {
    name: `${REQUEST_METHOD} ${REQUEST_ROUTE}`,
    kind: SpanKind.SERVER,
    spanContext: (): SpanContext => spanContext,
    startTime: SPAN_START,
    endTime: SPAN_END,
    duration: SPAN_DURATION,
    status: { code: SpanStatusCode.UNSET },
    attributes: {
      [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.request,
      'http.request.method': REQUEST_METHOD,
      'http.route': REQUEST_ROUTE,
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

/*
 * ---------------------------------------------------------------------------
 * Doubles
 *
 * Each implements the narrow structural interface `./exporter.ts` declares for
 * it, so none of them needs a cast — which is the property those interfaces
 * exist for.
 * ---------------------------------------------------------------------------
 */

/**
 * The environment the launcher exports into an instrumented dev server.
 *
 * A fresh record per call, and never `process.env`: `./config.ts` takes the
 * environment as a parameter for exactly this reason.
 *
 * @returns An environment record.
 */
function preloadEnv(): NodeJS.ProcessEnv {
  return {
    [PRELOAD_ENV_KEYS.ingestUrl]: INGEST_URL,
    [PRELOAD_ENV_KEYS.token]: AGENT_TOKEN,
    [PRELOAD_ENV_KEYS.projectRoot]: PROJECT_ROOT,
  };
}

/**
 * The validated launch configuration every harness is built on.
 *
 * Produced by the real loader rather than hand-written, so the endpoint, the
 * credential and the project root the cases assert on are the values the
 * preload would actually hold.
 *
 * @returns The active configuration.
 */
function activeConfig(): PreloadConfig {
  const result = loadPreloadConfig(preloadEnv());
  if (result.mode !== 'active') {
    throw new Error(`the fixture environment did not produce an active config: ${result.reason}`);
  }
  return result.config;
}

/**
 * A capture gate that wants everything.
 *
 * Two members, which is the whole interface: the drop rules it can express are
 * `../node/control.test.ts`'s subject, and a gate that dropped anything here
 * would only make the bounds under test unreachable.
 */
const OPEN_GATE: CaptureGate = {
  captureId: CAPTURE_ID,
  isKindEnabled: (): boolean => true,
};

/** One line a diagnostic produced, as the recording logger keeps it. */
interface LogEntry {
  /** The severity the call site chose. */
  readonly level: LogLevel;
  /** The message, after the module's credential scrub. */
  readonly message: string;
  /** The structured fields, where the call site passed any. */
  readonly fields?: LogFields | undefined;
}

/**
 * A logger that keeps every record instead of printing it.
 *
 * Two reasons, both load-bearing: the processor's overflow and failure paths
 * write real diagnostics, which would otherwise scribble over the test
 * reporter's output; and the buffer-cap case asserts that the loss is
 * *reported* — one warning per flush window carrying the count — which needs
 * the records rather than the absence of them.
 */
class RecordingLogger implements Logger {
  /** Records everything; the threshold is not what this suite is testing. */
  readonly level: LogLevelSetting = 'trace';

  /** Every record written through this logger or any child of it. */
  readonly entries: LogEntry[];

  /**
   * @param entries The store to append to; a child receives its parent's.
   */
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

  /** Records of one severity, in the order they were written. */
  entriesAt(level: LogLevel): LogEntry[] {
    return this.entries.filter((entry) => entry.level === level);
  }

  /**
   * Append one record.
   *
   * @param level The severity.
   * @param message The message.
   * @param fields The structured detail, where there was any.
   */
  #record(level: LogLevel, message: string, fields?: LogFields): void {
    this.entries.push(fields === undefined ? { level, message } : { level, message, fields });
  }
}

/** One call the processor made to its injected `fetch`. */
interface FetchCall {
  /** The first argument: the endpoint, verbatim. */
  readonly input: RequestInfo | URL;
  /** The second argument: method, headers, body and signal. */
  readonly init?: RequestInit | undefined;
}

/** How a case wants its `fetch` double to answer. */
interface FetchPlan {
  /**
   * The statuses to answer with, one per call, the last one repeating.
   *
   * A list rather than a single value so a case can describe a partial run —
   * the first batch refused, the second accepted — without writing its own
   * implementation.
   */
  readonly statuses?: readonly number[] | undefined;

  /** When true, every call rejects, as an unreachable service does. */
  readonly rejectEverything?: boolean | undefined;

  /** When true, every call returns a promise that never settles. */
  readonly hangForever?: boolean | undefined;

  /** Called before each answer, so a case can feed the processor mid-drain. */
  readonly beforeAnswer?: ((call: number) => void) | undefined;
}

/** An injected `fetch` plus the record of what it was asked to send. */
interface FetchRig {
  /** The implementation to inject as `fetchImpl`. */
  readonly impl: typeof fetch;
  /** Every call, in order. */
  readonly calls: FetchCall[];
}

/**
 * Create a `fetch` that records every request and reaches nothing.
 *
 * @param plan How it should answer.
 * @returns The rig.
 */
function createFetchRig(plan: FetchPlan = {}): FetchRig {
  const calls: FetchCall[] = [];
  const statuses = plan.statuses ?? [ACCEPTED_STATUS];

  const impl: typeof fetch = (input, init) => {
    calls.push(init === undefined ? { input } : { input, init });
    plan.beforeAnswer?.(calls.length);

    if (plan.hangForever === true) {
      return new Promise<Response>(() => {
        // Deliberately never settles: this is how a case reaches the shutdown
        // deadline without a real service and without a real wait.
      });
    }
    if (plan.rejectEverything === true) {
      return Promise.reject(new Error('the ingest endpoint could not be reached'));
    }

    const index = Math.min(calls.length - 1, statuses.length - 1);
    const status = statuses[index] ?? ACCEPTED_STATUS;
    return Promise.resolve(new Response(null, { status }));
  };

  return { impl, calls };
}

/*
 * ---------------------------------------------------------------------------
 * The harness
 * ---------------------------------------------------------------------------
 */

/** A processor with everything a case asserts against. */
interface Harness {
  /** The processor under test. */
  readonly processor: DebuggenSpanProcessor;
  /** The launch configuration it was built with. */
  readonly config: PreloadConfig;
  /** The `fetch` double and its record. */
  readonly fetch: FetchRig;
  /** The diagnostics it wrote. */
  readonly logger: RecordingLogger;
}

/** Every harness built by the current case, for teardown. */
const harnesses: Harness[] = [];

/**
 * Build a processor wired exactly as `register.ts` wires it, with doubles.
 *
 * @param plan How the injected `fetch` should answer.
 * @returns The harness, registered for teardown.
 */
function createHarness(plan: FetchPlan = {}): Harness {
  const config = activeConfig();
  const fetchRig = createFetchRig(plan);
  const logger = new RecordingLogger();
  const processor = new DebuggenSpanProcessor({
    gate: OPEN_GATE,
    config,
    logger,
    fetchImpl: fetchRig.impl,
  });

  const harness: Harness = { processor, config, fetch: fetchRig, logger };
  harnesses.push(harness);
  return harness;
}

/**
 * The contiguous run of numbers `[start, start + count)`.
 *
 * @param start First value.
 * @param count How many values.
 * @returns The run.
 */
function numberRange(start: number, count: number): number[] {
  const values: number[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    values.push(start + offset);
  }
  return values;
}

/**
 * Feed a run of finished spans, synchronously.
 *
 * @param processor The processor to feed.
 * @param count How many spans.
 * @param startIndex The first feed index.
 */
function feedSpans(processor: DebuggenSpanProcessor, count: number, startIndex = 0): void {
  for (let offset = 0; offset < count; offset += 1) {
    processor.onEnd(makeSpan(startIndex + offset));
  }
}

afterEach(async () => {
  // Real timers first: a harness that is still holding a flush window must be
  // able to settle its shutdown, and two of the cases below leave fake ones
  // installed.
  vi.useRealTimers();

  for (const harness of harnesses) {
    if (!harness.processor.isShutDown) {
      // Stops the flush window, so no timer from a finished case can fire into
      // the next one. `shutdown()` is single-attempt and never rejects.
      await harness.processor.shutdown();
    }
  }
  harnesses.length = 0;
});

/*
 * ---------------------------------------------------------------------------
 * Reading what travelled
 *
 * An ingest body arrives as JSON text, so every reader below narrows from
 * `unknown` rather than asserting a shape: a malformed body is something these
 * cases are entitled to assert *about*, which it could not be if the reader
 * assumed it away.
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

/** The endpoint one call was aimed at, whichever form the argument took. */
function requestUrlOf(call: FetchCall): string {
  const { input } = call;
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

/** The headers one call carried, as the record the module builds. */
function headersOf(call: FetchCall): Readonly<Record<string, unknown>> {
  return asRecord(call.init?.headers, 'the request headers');
}

/** The decoded ingest body of one call. */
function bodyOf(call: FetchCall): Readonly<Record<string, unknown>> {
  const body = call.init?.body;
  if (typeof body !== 'string') {
    throw new Error('the exporter posted a body that was not serialised JSON text');
  }
  return asRecord(JSON.parse(body), 'the ingest body');
}

/** The events of one call's body, each as a record. */
function eventsOf(call: FetchCall): readonly Readonly<Record<string, unknown>>[] {
  const events = asList(bodyOf(call).events, "the ingest body's events");
  return events.map((event, index) => asRecord(event, `event ${String(index)} of a batch`));
}

/** The events of every call, in the order they were posted. */
function postedEventsOf(rig: FetchRig): readonly Readonly<Record<string, unknown>>[] {
  return rig.calls.flatMap((call) => eventsOf(call));
}

/** How many events each call carried, in order. */
function batchSizesOf(rig: FetchRig): number[] {
  return rig.calls.map((call) => eventsOf(call).length);
}

/**
 * The `seq` of one posted event.
 *
 * The sequence is `./convert.ts`'s per-`(producerId, captureId)` counter, drawn
 * in feed order, so it is how a case says "the oldest event" without reaching
 * into the buffer.
 *
 * @param event The posted event.
 * @returns The sequence number.
 */
function seqOf(event: Readonly<Record<string, unknown>>): number {
  const seq = event.seq;
  if (typeof seq !== 'number') {
    throw new Error('a posted event carried no numeric seq');
  }
  return seq;
}

/*
 * ---------------------------------------------------------------------------
 * The batch threshold
 * ---------------------------------------------------------------------------
 */

describe('BATCH_MAX_EVENTS', () => {
  it('holds a burst one event short of the threshold, and posts it on the window', async () => {
    vi.useFakeTimers();
    const { processor, fetch: rig } = createHarness();

    feedSpans(processor, BATCH_MAX_EVENTS - 1);

    expect(processor.bufferedCount).toBe(BATCH_MAX_EVENTS - 1);
    expect(rig.calls).toHaveLength(0);
    expect(processor.stats()).toMatchObject({
      endedCount: BATCH_MAX_EVENTS - 1,
      convertedCount: BATCH_MAX_EVENTS - 1,
      droppedNoCapture: 0,
      droppedUnconvertible: 0,
      postedBatches: 0,
    });

    // One event short of the threshold nothing has triggered a drain, so the
    // batch is still waiting a whole flush window later minus a millisecond.
    await vi.advanceTimersByTimeAsync(BATCH_FLUSH_INTERVAL_MS - 1);
    expect(rig.calls).toHaveLength(0);

    // The window is what posts a partial batch, and it posts all of it.
    await vi.advanceTimersByTimeAsync(1);
    expect(batchSizesOf(rig)).toEqual([BATCH_MAX_EVENTS - 1]);
    expect(processor.bufferedCount).toBe(0);
  });

  it('posts one batch of exactly the threshold, with the ingest contract of AAP 0.4.2', async () => {
    const { processor, config, fetch: rig } = createHarness();

    feedSpans(processor, BATCH_MAX_EVENTS);

    // The drain is queued on the chain, not run on the application's stack.
    expect(rig.calls).toHaveLength(0);
    expect(processor.bufferedCount).toBe(BATCH_MAX_EVENTS);

    await processor.forceFlush();

    expect(batchSizesOf(rig)).toEqual([BATCH_MAX_EVENTS]);
    expect(processor.bufferedCount).toBe(0);
    expect(processor.stats()).toMatchObject({
      postedBatches: 1,
      postedEvents: BATCH_MAX_EVENTS,
      failedBatches: 0,
      droppedOverflow: 0,
      internalErrors: 0,
    });

    const call = at(rig.calls, 0, 'the ingest calls');
    expect(requestUrlOf(call)).toBe(config.ingestUrl);
    expect(call.init?.method).toBe('POST');
    // Exactly two headers, and no `Origin`: the service refuses a request that
    // carries a web origin and accepts an absent one from a Node client
    // (AAP §0.5.6).
    const headers = headersOf(call);
    expect(Object.keys(headers).sort()).toEqual(['Authorization', 'Content-Type']);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${config.token}`);

    const body = bodyOf(call);
    expect(Object.keys(body).sort()).toEqual(['events', 'projectRoot']);
    expect(body.projectRoot).toBe(config.projectRoot);
  });

  it('posts the threshold batch and the remainder, in feed order, one event over', async () => {
    const total = BATCH_MAX_EVENTS + 1;
    const { processor, fetch: rig } = createHarness();

    feedSpans(processor, total);

    expect(rig.calls).toHaveLength(0);

    await processor.forceFlush();

    expect(batchSizesOf(rig)).toEqual([BATCH_MAX_EVENTS, 1]);
    expect(postedEventsOf(rig).map((event) => seqOf(event))).toEqual(numberRange(0, total));
    expect(processor.stats()).toMatchObject({ postedBatches: 2, postedEvents: total });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The buffer cap
 * ---------------------------------------------------------------------------
 */

describe('MAX_BUFFERED_EVENTS', () => {
  it('buffers a burst one event short of the cap without dropping anything', () => {
    const { processor } = createHarness();

    feedSpans(processor, MAX_BUFFERED_EVENTS - 1);

    expect(processor.bufferedCount).toBe(MAX_BUFFERED_EVENTS - 1);
    expect(processor.stats()).toMatchObject({
      droppedOverflow: 0,
      convertedCount: MAX_BUFFERED_EVENTS - 1,
    });
  });

  it('buffers exactly the cap without dropping anything', () => {
    const { processor } = createHarness();

    feedSpans(processor, MAX_BUFFERED_EVENTS);

    expect(processor.bufferedCount).toBe(MAX_BUFFERED_EVENTS);
    expect(processor.stats()).toMatchObject({ droppedOverflow: 0 });
  });

  it('discards the oldest event for the one that goes over the cap, and reports it', async () => {
    const { processor, fetch: rig, logger } = createHarness();

    feedSpans(processor, MAX_BUFFERED_EVENTS + 1);

    expect(processor.bufferedCount).toBe(MAX_BUFFERED_EVENTS);
    expect(processor.stats()).toMatchObject({
      droppedOverflow: 1,
      convertedCount: MAX_BUFFERED_EVENTS + 1,
    });

    await processor.forceFlush();

    // The discarded event is the one that arrived first: during a reproduction
    // the newest evidence is the relevant evidence.
    const posted = postedEventsOf(rig);
    expect(posted).toHaveLength(MAX_BUFFERED_EVENTS);
    expect(seqOf(at(posted, 0, 'the posted events'))).toBe(1);
    expect(at(posted, 0, 'the posted events').spanId).toBe(spanIdFor(1));
    expect(seqOf(at(posted, posted.length - 1, 'the posted events'))).toBe(MAX_BUFFERED_EVENTS);

    // One warning per flush window, carrying the count — never one per event.
    const warnings = logger.entriesAt('warn');
    expect(warnings).toHaveLength(1);
    expect(at(warnings, 0, 'the warnings').fields).toMatchObject({
      events: 1,
      bufferLimit: MAX_BUFFERED_EVENTS,
      droppedTotal: 1,
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The drain bound
 * ---------------------------------------------------------------------------
 */

describe('MAX_DRAIN_BATCHES', () => {
  it('stops one drain at the bound instead of following the spans still arriving', async () => {
    // Below the threshold, so nothing is queued until `forceFlush` asks: the
    // drain this case measures is one drain, and it is the one awaited.
    const perRefill = BATCH_MAX_EVENTS - 1;
    let refilling = true;
    let fed = 0;

    const harness = createHarness({
      beforeAnswer: () => {
        if (!refilling) {
          return;
        }
        // A dev server producing spans as fast as they are posted: without the
        // cap, the drain loop below would never find an empty buffer.
        feedSpans(harness.processor, perRefill, fed);
        fed += perRefill;
      },
    });

    feedSpans(harness.processor, perRefill, fed);
    fed += perRefill;

    await harness.processor.forceFlush();
    refilling = false;

    expect(harness.processor.stats().postedBatches).toBe(MAX_DRAIN_BATCHES);
    expect(harness.fetch.calls).toHaveLength(MAX_DRAIN_BATCHES);
    // The drain terminated with evidence still queued, which is the whole
    // point: what arrived after the bound belongs to the next flush window.
    expect(harness.processor.bufferedCount).toBe(perRefill);
    expect(batchSizesOf(harness.fetch).every((size) => size === perRefill)).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Failing and partial sends
 * ---------------------------------------------------------------------------
 */

describe('failing and partial sends', () => {
  it('spends exactly MAX_POST_ATTEMPTS on a batch nothing will accept', async () => {
    vi.useFakeTimers();
    const { processor, fetch: rig } = createHarness({ rejectEverything: true });

    feedSpans(processor, 1);
    const flushing = processor.forceFlush();
    // The backoff doubles from RECONNECT_MIN_MS; advancing well past the sum of
    // every wait in the budget keeps this case correct if the envelope changes.
    await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS * 2 ** MAX_POST_ATTEMPTS);
    await flushing;

    expect(rig.calls).toHaveLength(MAX_POST_ATTEMPTS);
    expect(processor.stats()).toMatchObject({
      postedBatches: 0,
      failedBatches: 1,
      droppedFailedBatch: 1,
      droppedUnserializable: 0,
      internalErrors: 0,
    });
    expect(processor.bufferedCount).toBe(0);
  });

  it('does not retry a refused credential', async () => {
    const { processor, fetch: rig } = createHarness({ statuses: [UNAUTHORIZED_STATUS] });

    feedSpans(processor, 1);
    await processor.forceFlush();

    // One attempt: an endpoint that has said no to this credential will say no
    // to the same credential, and a loop would only fill the developer's
    // terminal.
    expect(rig.calls).toHaveLength(1);
    expect(processor.stats()).toMatchObject({ failedBatches: 1, droppedFailedBatch: 1 });
  });

  it('retries a 503 and keeps the batch when the retry is accepted', async () => {
    vi.useFakeTimers();
    const { processor, fetch: rig } = createHarness({
      statuses: [UNAVAILABLE_STATUS, ACCEPTED_STATUS],
    });

    feedSpans(processor, 1);
    const flushing = processor.forceFlush();
    await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS * 2);
    await flushing;

    expect(rig.calls).toHaveLength(2);
    expect(processor.stats()).toMatchObject({
      postedBatches: 1,
      postedEvents: 1,
      failedBatches: 0,
      droppedFailedBatch: 0,
    });
  });

  it('keeps the batches around a failed one', async () => {
    const { processor, fetch: rig } = createHarness({
      statuses: [REFUSED_STATUS, ACCEPTED_STATUS],
    });

    feedSpans(processor, BATCH_MAX_EVENTS * 2);
    await processor.forceFlush();

    // A refused batch is dropped rather than re-queued: re-queuing would let
    // one unsendable batch starve every piece of evidence behind it.
    expect(rig.calls).toHaveLength(2);
    expect(processor.stats()).toMatchObject({
      postedBatches: 1,
      postedEvents: BATCH_MAX_EVENTS,
      failedBatches: 1,
      droppedFailedBatch: BATCH_MAX_EVENTS,
    });
    expect(processor.bufferedCount).toBe(0);
  });

  it('makes a single-attempt final flush at shutdown and resolves', async () => {
    const { processor, fetch: rig } = createHarness({ rejectEverything: true });

    feedSpans(processor, 1);
    await processor.shutdown();

    // No backoff and no second attempt: the host is on its way out of the
    // process, so the remaining evidence is worth one best-effort try.
    expect(rig.calls).toHaveLength(1);
    expect(processor.isShutDown).toBe(true);
    expect(processor.stats()).toMatchObject({
      failedBatches: 1,
      droppedFailedBatch: 1,
      droppedAtShutdown: 0,
    });
  });

  it('counts what the shutdown deadline left queued', async () => {
    vi.useFakeTimers();
    const remainder = 44;
    const total = BATCH_MAX_EVENTS + remainder;
    const { processor, fetch: rig } = createHarness({ hangForever: true });

    feedSpans(processor, total);

    const shuttingDown = processor.shutdown();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_DEADLINE_MS);
    await shuttingDown;

    // The in-flight batch is gone with the request that never answered; what
    // was still queued behind it is abandoned and counted rather than held.
    expect(rig.calls).toHaveLength(1);
    expect(processor.isShutDown).toBe(true);
    expect(processor.bufferedCount).toBe(0);
    expect(processor.stats()).toMatchObject({ droppedAtShutdown: remainder });
  });

  it('counts a span that arrives after shutdown and converts nothing', async () => {
    const { processor, fetch: rig } = createHarness();

    feedSpans(processor, 1);
    await processor.shutdown();
    const postedBefore = rig.calls.length;

    feedSpans(processor, 1, 1);

    expect(rig.calls).toHaveLength(postedBefore);
    expect(processor.bufferedCount).toBe(0);
    expect(processor.stats()).toMatchObject({ droppedAfterShutdown: 1, internalErrors: 0 });
  });
});
