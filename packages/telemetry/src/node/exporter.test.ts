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
 * - {@link AUTH_REJECTED_STATUSES} — the statuses that stop the transport for
 *   the life of the process, driven from the module's own table so a status
 *   added to it is covered here: one refusal, one post, one warning, and no
 *   second request however many spans follow. Its negative control is
 *   {@link RETRYABLE_CLIENT_STATUSES} plus a `5xx`, which must leave the
 *   transport running so a service restart still recovers.
 * - {@link MAX_ACKNOWLEDGEMENT_BYTES} (4 KiB) — the most of a `2xx` body read
 *   as the service's `{ accepted, rejected? }` acknowledgement. Asserted at the
 *   bound (read), one over (refused), with a declared `Content-Length` over it
 *   (refused unread) and with a body that never ends (cancelled at the cap).
 *   What the acknowledgement says is asserted on every counter it moves: a
 *   batch the service stored nothing of is refused — never posted, never
 *   retried — a partial one is split, inconsistent counts are clamped to the
 *   batch, and a body that is absent or unusable falls back to "posted, and
 *   unacknowledged" without a throw and without a byte of it being logged.
 * - {@link REFUSAL_WARNING_INTERVAL_MS} — refusals are summarised in at most
 *   one warning per drain, no more often than this interval, with nothing lost
 *   to it and the remainder written by the shutdown flush.
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
 * advance them explicitly, and the refusal-interval case moves the faked
 * system clock rather than waiting on the real one.
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
  AUTH_REJECTED_STATUSES,
  DebuggenSpanProcessor,
  MAX_ACKNOWLEDGEMENT_BYTES,
  MAX_DRAIN_BATCHES,
  MAX_POST_ATTEMPTS,
  REFUSAL_WARNING_INTERVAL_MS,
  RETRYABLE_CLIENT_STATUSES,
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

/**
 * `204 No Content`: a `2xx` that says nothing about counts.
 *
 * The default answer of this suite's `fetch` double, and the shape of a
 * service that acknowledges with a status only. The exporter counts such a
 * batch as posted in full and as unacknowledged, which is why every case
 * written before the acknowledgement was read still holds unchanged.
 */
const ACCEPTED_STATUS = 204;

/**
 * `202 Accepted`: the status the local service answers an ingest with, its
 * body being the `{ accepted, rejected? }` acknowledgement.
 */
const ACKNOWLEDGED_STATUS = 202;

/**
 * A string no diagnostic may ever contain, planted in answer bodies to prove
 * that nothing the service says is echoed into the developer's terminal.
 * Assembled from fragments for the same reason the credential is.
 */
const BODY_MARKER = ['ack', 'body', 'marker', 'z'.repeat(12)].join('-');

/** `401 Unauthorized`: a credential the service refused. */
const UNAUTHORIZED_STATUS = 401;

/** `400 Bad Request`: a batch the service read and refused. */
const REFUSED_STATUS = 400;

/** `503 Service Unavailable`: a moment rather than an answer. */
const UNAVAILABLE_STATUS = 503;

/** `500 Internal Server Error`: the service is up and something went wrong. */
const SERVER_ERROR_STATUS = 500;

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

/**
 * Everything a logger recorded, as one searchable string.
 *
 * Field values are serialised too, because a credential that leaked into a
 * field rather than into a message would be just as visible in a developer's
 * terminal — and the credential-refusal hint is the one diagnostic in this
 * module whose fields describe the very request that carried the credential.
 *
 * @param logger The recording logger.
 * @returns Every message and every field, concatenated.
 */
function logText(logger: RecordingLogger): string {
  return logger.entries
    .map((entry) =>
      entry.fields === undefined
        ? `${entry.level} ${entry.message}`
        : `${entry.level} ${entry.message} ${JSON.stringify(entry.fields)}`,
    )
    .join('\n');
}

/** One call the processor made to its injected `fetch`. */
interface FetchCall {
  /** The first argument: the endpoint, verbatim. */
  readonly input: RequestInfo | URL;
  /** The second argument: method, headers, body and signal. */
  readonly init?: RequestInit | undefined;
}

/**
 * The body of one answer.
 *
 * `json` is serialised with a JSON content type, as the service serialises its
 * acknowledgement. `raw` is anything else — text, bytes or a stream — produced
 * by a factory, because a response body can be read once and a plan's last
 * entry answers every call after it, so each call needs a fresh one; `headers`
 * lets a case declare a `Content-Length` the body does not have.
 */
type AnswerBody =
  | { readonly json: unknown }
  | {
      readonly raw: () => BodyInit;
      readonly headers?: Readonly<Record<string, string>> | undefined;
    };

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

  /**
   * The bodies to answer with, one per call, the last one repeating.
   *
   * Absent — or a `null` entry — means no body at all, which is what every
   * case that does not assert on the acknowledgement answers with.
   */
  readonly bodies?: readonly (AnswerBody | null)[] | undefined;

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
 * Build one answer.
 *
 * @param status The status.
 * @param body The body, or `null` for none.
 * @returns A fresh response.
 */
function answerWith(status: number, body: AnswerBody | null): Response {
  if (body === null) {
    return new Response(null, { status });
  }
  if ('json' in body) {
    return new Response(JSON.stringify(body.json), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(body.raw(), { status, headers: { ...body.headers } });
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
  const bodies = plan.bodies ?? [];

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
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)] ?? null;
    return Promise.resolve(answerWith(status, body));
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

/*
 * ---------------------------------------------------------------------------
 * A refused credential
 *
 * The guarantee under test is the one the module's own diagnostic makes:
 * *server-side telemetry stops until the dev server is relaunched*. Stops means
 * no further request — not "this batch is abandoned" — because the server-agent
 * credential is minted per dev-server launch and scoped to one project root
 * (AAP §0.5.6), so an endpoint that refused it never begins accepting it.
 *
 * Every case here is driven from {@link AUTH_REJECTED_STATUSES} or its negative
 * control {@link RETRYABLE_CLIENT_STATUSES} rather than from a status spelled
 * in the assertion, so a table this module changes changes these cases with it.
 * ---------------------------------------------------------------------------
 */

describe('AUTH_REJECTED_STATUSES', () => {
  it('posts once and never again, for every status that refuses the credential', async () => {
    for (const status of AUTH_REJECTED_STATUSES) {
      const label = `status ${String(status)}`;
      const { processor, fetch: rig } = createHarness({ statuses: [status] });

      feedSpans(processor, 1);
      await processor.forceFlush();

      expect(rig.calls, `${label} is attempted exactly once`).toHaveLength(1);
      const refused = processor.stats();
      expect(refused.credentialRejected, `${label} latches the refusal`).toBe(true);
      expect(refused.convertedCount).toBe(1);

      // Fresh spans and an explicit flush, which is what the finding measured:
      // 12 further posts carrying 396 more events after exactly this point.
      feedSpans(processor, BATCH_MAX_EVENTS, 1);
      await processor.forceFlush();

      expect(rig.calls, `${label} produces no second post`).toHaveLength(1);
      const after = processor.stats();
      // Nothing was converted and nothing was buffered: the spans were refused
      // at admission, before any conversion work was done on them.
      expect(after.convertedCount, `${label} converts nothing more`).toBe(refused.convertedCount);
      expect(after.droppedCredentialRejected, `${label} accounts for every refused span`).toBe(
        BATCH_MAX_EVENTS,
      );
      expect(processor.bufferedCount, `${label} buffers nothing`).toBe(0);
      expect(after.postedBatches).toBe(0);
      expect(after.internalErrors).toBe(0);
    }
  });

  it('discards the evidence still buffered behind the batch that was refused', async () => {
    const remainder = 40;
    const { processor, fetch: rig, logger } = createHarness({ statuses: [UNAUTHORIZED_STATUS] });

    feedSpans(processor, BATCH_MAX_EVENTS + remainder);
    await processor.forceFlush();

    // One post, not two. Without the latch the second batch of this very drain
    // would go to the endpoint that had just refused the first.
    expect(rig.calls).toHaveLength(1);
    expect(processor.bufferedCount).toBe(0);
    expect(processor.stats()).toMatchObject({
      postedBatches: 0,
      postedEvents: 0,
      // The refused batch keeps the counters it had already earned; only what
      // was behind it lands on the credential counter.
      failedBatches: 1,
      droppedFailedBatch: BATCH_MAX_EVENTS,
      droppedCredentialRejected: remainder,
      droppedAtShutdown: 0,
      internalErrors: 0,
    });
    expect(logger.entriesAt('warn')).toHaveLength(1);
  });

  it('keeps forceFlush() and shutdown() resolving, with nothing left to abandon', async () => {
    const laterSpans = 3;
    const { processor, fetch: rig } = createHarness({ statuses: [UNAUTHORIZED_STATUS] });

    feedSpans(processor, 1);
    await processor.forceFlush();
    expect(processor.stats().credentialRejected).toBe(true);

    feedSpans(processor, laterSpans, 1);

    // Both must settle rather than reject or hang: the provider's own shutdown
    // path awaits them inside the developer's dev server.
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();

    expect(rig.calls).toHaveLength(1);
    expect(processor.isShutDown).toBe(true);
    expect(processor.stats()).toMatchObject({
      droppedCredentialRejected: laterSpans,
      // Not an abandonment: `droppedAtShutdown` is for evidence a *reachable*
      // service did not take in time, and counting these there would name the
      // wrong failure.
      droppedAtShutdown: 0,
      buffered: 0,
      internalErrors: 0,
    });
  });

  it('is not cleared by reopen(), which a capture re-arm calls', async () => {
    const laterSpans = 2;
    const { processor, fetch: rig } = createHarness({ statuses: [UNAUTHORIZED_STATUS] });

    feedSpans(processor, 1);
    await processor.forceFlush();
    await processor.shutdown();

    // What `./control.ts` does when the next capture installs a replacement
    // provider. The provider lifetime is repaired; the transport is not, and
    // must not be — a second capture posting here would post to an endpoint
    // that has already said no.
    processor.reopen();

    expect(processor.isShutDown).toBe(false);
    expect(processor.stats().credentialRejected).toBe(true);

    feedSpans(processor, laterSpans, 1);
    await processor.forceFlush();

    expect(rig.calls).toHaveLength(1);
    expect(processor.bufferedCount).toBe(0);
    expect(processor.stats()).toMatchObject({
      convertedCount: 1,
      droppedCredentialRejected: laterSpans,
      droppedAfterShutdown: 0,
      internalErrors: 0,
    });
  });

  it('writes the hint once, without the credential, however many spans follow', async () => {
    const { processor, config, logger } = createHarness({ statuses: [UNAUTHORIZED_STATUS] });

    feedSpans(processor, BATCH_MAX_EVENTS * 2);
    await processor.forceFlush();
    feedSpans(processor, BATCH_MAX_EVENTS, BATCH_MAX_EVENTS * 2);
    await processor.forceFlush();

    // One line in someone else's dev-server terminal, carrying the one thing
    // they can act on.
    const warnings = logger.entriesAt('warn');
    expect(warnings).toHaveLength(1);
    const hint = at(warnings, 0, 'the warnings');
    expect(hint.message).toContain('relaunched');
    expect(hint.fields).toMatchObject({ status: UNAUTHORIZED_STATUS, url: config.ingestUrl });
    // A credential printed into a terminal outlives the process it belonged to
    // by as long as the scrollback does.
    expect(logText(logger)).not.toContain(config.token);
  });

  it('does not latch on a failure that may pass, so a service restart still recovers', async () => {
    vi.useFakeTimers();

    // A `5xx` and every member of the retryable client table: each describes a
    // moment rather than the credential, so the transport must survive it.
    for (const status of [SERVER_ERROR_STATUS, ...RETRYABLE_CLIENT_STATUSES]) {
      const label = `status ${String(status)}`;
      const { processor, fetch: rig } = createHarness({ statuses: [status, ACCEPTED_STATUS] });

      feedSpans(processor, 1);
      const flushing = processor.forceFlush();
      await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS * 2 ** MAX_POST_ATTEMPTS);
      await flushing;

      expect(rig.calls, `${label} is retried in place`).toHaveLength(2);
      expect(processor.stats(), `${label} does not latch`).toMatchObject({
        credentialRejected: false,
        droppedCredentialRejected: 0,
        postedBatches: 1,
        postedEvents: 1,
      });

      // And the batch after it still travels, which is what "recovers" means.
      feedSpans(processor, 1, 1);
      await processor.forceFlush();

      expect(rig.calls, `${label} keeps posting afterwards`).toHaveLength(3);
      expect(processor.stats().postedBatches).toBe(2);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The ingest acknowledgement
 *
 * The local service answers an ingest it processed with
 * `202 { accepted, rejected? }`, and `202 { accepted: 0, rejected: N }` is a
 * batch it received and stored nothing of. Every case below answers through
 * the rig's `bodies` and asserts three things: the counters the answer moves,
 * the number of requests (a `2xx` is never retried), and what reached the
 * logger — counts and fixed reason words, never a byte of the answer.
 * ---------------------------------------------------------------------------
 */

/**
 * A JSON body padded with trailing whitespace to exactly `bytes` bytes.
 *
 * Trailing whitespace is valid JSON, so the padded body parses to the same
 * value and only its length moves — which is what lets a case sit exactly on
 * {@link MAX_ACKNOWLEDGEMENT_BYTES} and exactly one byte over it.
 *
 * @param value The acknowledgement.
 * @param bytes The body's length; ASCII, so characters are bytes.
 * @returns The padded text.
 */
function paddedJson(value: unknown, bytes: number): string {
  const text = JSON.stringify(value);
  if (text.length > bytes) {
    throw new Error('the padded body would be shorter than the JSON it pads');
  }
  return text.padEnd(bytes, ' ');
}

/**
 * The reason words the exporter recorded for `2xx` answers that carried no
 * usable acknowledgement, in order.
 *
 * @param logger The recording logger.
 * @returns One reason per such answer.
 */
function unacknowledgedReasonsOf(logger: RecordingLogger): unknown[] {
  return logger
    .entriesAt('debug')
    .flatMap((entry) =>
      entry.fields !== undefined && 'reason' in entry.fields ? [entry.fields.reason] : [],
    );
}

/**
 * The `clamped` flag of every acknowledged answer, in order.
 *
 * @param logger The recording logger.
 * @returns One flag per acknowledged answer.
 */
function clampedFlagsOf(logger: RecordingLogger): unknown[] {
  return logger
    .entriesAt('debug')
    .flatMap((entry) =>
      entry.fields !== undefined && 'clamped' in entry.fields ? [entry.fields.clamped] : [],
    );
}

/** A body stream that never ends, and the record of what it handed out. */
interface EndlessBody {
  /** A fresh endless stream, for one answer. */
  readonly open: () => ReadableStream<Uint8Array>;
  /** Bytes handed out so far, across every stream it opened. */
  readonly pulledBytes: () => number;
  /** Streams whose reader cancelled them. */
  readonly cancelled: () => number;
}

/**
 * Create a body that produces whitespace for as long as it is read.
 *
 * Whitespace so that no prefix of it is ever a complete answer: without the
 * streamed cap, reading it would never finish.
 *
 * @param chunkBytes Bytes per chunk.
 * @returns The body and its record.
 */
function createEndlessBody(chunkBytes: number): EndlessBody {
  let pulled = 0;
  let cancelled = 0;
  return {
    open: (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        pull(controller): void {
          pulled += chunkBytes;
          controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
        },
        cancel(): void {
          cancelled += 1;
        },
      }),
    pulledBytes: (): number => pulled,
    cancelled: (): number => cancelled,
  };
}

/**
 * A body that delivers the start of an acknowledgement and then errors, with
 * the marker in the error's message.
 *
 * @returns A fresh stream.
 */
function erroringBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(new TextEncoder().encode('{"accepted":'));
      controller.error(new Error(BODY_MARKER));
    },
  });
}

/**
 * A body whose chunk is a string rather than bytes, as a response double
 * could hand over.
 *
 * @returns A fresh stream.
 */
function textChunkBody(): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller): void {
      controller.enqueue(JSON.stringify({ accepted: 0, rejected: 1, note: BODY_MARKER }));
      controller.close();
    },
  });
}

describe('the ingest acknowledgement', () => {
  it('counts a batch the service stored nothing of as refused, never posted, and never retries it', async () => {
    const events = 3;
    // The second answer would read as a success, so a retry could not hide.
    const {
      processor,
      fetch: rig,
      logger,
    } = createHarness({
      statuses: [ACKNOWLEDGED_STATUS, ACCEPTED_STATUS],
      bodies: [{ json: { accepted: 0, rejected: events } }, null],
    });

    feedSpans(processor, events);
    await processor.forceFlush();

    expect(rig.calls).toHaveLength(1);
    expect(processor.stats()).toMatchObject({
      refusedBatches: 1,
      postedBatches: 0,
      postedEvents: 0,
      droppedRejectedByService: events,
      unacknowledgedBatches: 0,
      failedBatches: 0,
      droppedFailedBatch: 0,
      credentialRejected: false,
      internalErrors: 0,
      buffered: 0,
    });

    const warnings = logger.entriesAt('warn');
    expect(warnings).toHaveLength(1);
    expect(at(warnings, 0, 'the warnings').fields).toEqual({
      events,
      fullyRefusedBatches: 1,
      droppedTotal: events,
    });

    // A refusal is about those bytes, not about the transport: the next batch
    // still travels, and is counted by its own answer.
    feedSpans(processor, 1, events);
    await processor.forceFlush();

    expect(rig.calls).toHaveLength(2);
    expect(processor.stats()).toMatchObject({
      postedBatches: 1,
      postedEvents: 1,
      unacknowledgedBatches: 1,
      refusedBatches: 1,
    });
  });

  it('splits a partly stored batch between the posted and the refused counters', async () => {
    const refused = 6;
    const {
      processor,
      fetch: rig,
      logger,
    } = createHarness({
      statuses: [ACKNOWLEDGED_STATUS],
      bodies: [{ json: { accepted: BATCH_MAX_EVENTS - refused, rejected: refused } }],
    });

    feedSpans(processor, BATCH_MAX_EVENTS);
    await processor.forceFlush();

    expect(rig.calls).toHaveLength(1);
    expect(processor.stats()).toMatchObject({
      postedBatches: 1,
      postedEvents: BATCH_MAX_EVENTS - refused,
      droppedRejectedByService: refused,
      refusedBatches: 0,
      unacknowledgedBatches: 0,
      failedBatches: 0,
      internalErrors: 0,
    });

    const warnings = logger.entriesAt('warn');
    expect(warnings).toHaveLength(1);
    expect(at(warnings, 0, 'the warnings').fields).toEqual({
      events: refused,
      fullyRefusedBatches: 0,
      droppedTotal: refused,
    });
    expect(clampedFlagsOf(logger)).toEqual([false]);
  });

  it('posts a batch the service stored in full, and writes nothing at warn', async () => {
    const {
      processor,
      fetch: rig,
      logger,
    } = createHarness({
      statuses: [ACKNOWLEDGED_STATUS],
      bodies: [{ json: { accepted: BATCH_MAX_EVENTS } }],
    });

    feedSpans(processor, BATCH_MAX_EVENTS);
    await processor.forceFlush();

    expect(rig.calls).toHaveLength(1);
    expect(processor.stats()).toMatchObject({
      postedBatches: 1,
      postedEvents: BATCH_MAX_EVENTS,
      droppedRejectedByService: 0,
      refusedBatches: 0,
      unacknowledgedBatches: 0,
      internalErrors: 0,
    });
    expect(logger.entriesAt('warn')).toHaveLength(0);
    expect(clampedFlagsOf(logger)).toEqual([false]);
  });

  it('counts a 2xx with no body as posted in full and unacknowledged', async () => {
    for (const status of [ACCEPTED_STATUS, ACKNOWLEDGED_STATUS]) {
      const label = `status ${String(status)}`;
      const { processor, fetch: rig, logger } = createHarness({ statuses: [status] });

      feedSpans(processor, 2);
      await processor.forceFlush();

      expect(rig.calls, `${label} is posted once`).toHaveLength(1);
      expect(processor.stats(), `${label} falls back to "posted"`).toMatchObject({
        postedBatches: 1,
        postedEvents: 2,
        unacknowledgedBatches: 1,
        refusedBatches: 0,
        droppedRejectedByService: 0,
        internalErrors: 0,
      });
      expect(logger.entriesAt('warn'), `${label} is not a degraded capture`).toHaveLength(0);
      expect(unacknowledgedReasonsOf(logger)).toEqual(['no-body']);
    }
  });

  it('reads an acknowledgement of exactly MAX_ACKNOWLEDGEMENT_BYTES and refuses one byte over', async () => {
    const refusal = { accepted: 0, rejected: 1 };

    const atBound = createHarness({
      statuses: [ACKNOWLEDGED_STATUS],
      bodies: [{ raw: () => paddedJson(refusal, MAX_ACKNOWLEDGEMENT_BYTES) }],
    });
    feedSpans(atBound.processor, 1);
    await atBound.processor.forceFlush();

    expect(atBound.processor.stats()).toMatchObject({
      refusedBatches: 1,
      droppedRejectedByService: 1,
      postedBatches: 0,
      unacknowledgedBatches: 0,
    });

    // No declared length: `new Response(text)` sets none, so this is the
    // streamed cap refusing the body.
    const overBound = createHarness({
      statuses: [ACKNOWLEDGED_STATUS],
      bodies: [{ raw: () => paddedJson(refusal, MAX_ACKNOWLEDGEMENT_BYTES + 1) }],
    });
    feedSpans(overBound.processor, 1);
    await overBound.processor.forceFlush();

    expect(overBound.fetch.calls).toHaveLength(1);
    expect(overBound.processor.stats()).toMatchObject({
      refusedBatches: 0,
      droppedRejectedByService: 0,
      postedBatches: 1,
      postedEvents: 1,
      unacknowledgedBatches: 1,
      internalErrors: 0,
    });
    expect(unacknowledgedReasonsOf(overBound.logger)).toEqual(['oversized']);
  });

  it('refuses a declared Content-Length over the bound without reading the body', async () => {
    // The body itself is a small, valid refusal, so reading it would count the
    // batch as refused. Being counted as unacknowledged is the proof that the
    // declaration alone decided.
    const {
      processor,
      fetch: rig,
      logger,
    } = createHarness({
      statuses: [ACKNOWLEDGED_STATUS],
      bodies: [
        {
          raw: () => JSON.stringify({ accepted: 0, rejected: 1 }),
          headers: { 'Content-Length': String(MAX_ACKNOWLEDGEMENT_BYTES + 1) },
        },
      ],
    });

    feedSpans(processor, 1);
    await processor.forceFlush();

    expect(rig.calls).toHaveLength(1);
    expect(processor.stats()).toMatchObject({
      refusedBatches: 0,
      droppedRejectedByService: 0,
      postedBatches: 1,
      unacknowledgedBatches: 1,
      internalErrors: 0,
    });
    expect(unacknowledgedReasonsOf(logger)).toEqual(['oversized']);
  });

  it('cancels a body that never ends once it passes the bound, and resolves', async () => {
    const chunkBytes = 512;
    const endless = createEndlessBody(chunkBytes);
    const {
      processor,
      fetch: rig,
      logger,
    } = createHarness({
      statuses: [ACKNOWLEDGED_STATUS],
      bodies: [{ raw: endless.open }],
    });

    feedSpans(processor, 1);
    await expect(processor.forceFlush()).resolves.toBeUndefined();

    expect(rig.calls).toHaveLength(1);
    expect(endless.cancelled()).toBe(1);
    // The cap, the chunk that crossed it, and the one the stream's queue had
    // already pulled ahead of the reader — and not a byte more.
    expect(endless.pulledBytes()).toBeLessThanOrEqual(MAX_ACKNOWLEDGEMENT_BYTES + 2 * chunkBytes);
    expect(processor.stats()).toMatchObject({
      postedBatches: 1,
      unacknowledgedBatches: 1,
      internalErrors: 0,
    });
    expect(unacknowledgedReasonsOf(logger)).toEqual(['oversized']);
  });

  it('falls back to posted-and-unacknowledged for every body it cannot use, and never throws', async () => {
    const cases: readonly {
      readonly label: string;
      readonly body: AnswerBody;
      readonly reason: string;
    }[] = [
      { label: 'an empty body', body: { raw: () => '' }, reason: 'empty' },
      { label: 'text that is not JSON', body: { raw: () => BODY_MARKER }, reason: 'malformed' },
      { label: 'truncated JSON', body: { raw: () => '{"accepted":' }, reason: 'malformed' },
      {
        label: 'bytes that are not UTF-8',
        body: { raw: () => new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) },
        reason: 'malformed',
      },
      { label: 'a JSON array', body: { json: [1, 2] }, reason: 'unrecognised' },
      { label: 'JSON null', body: { json: null }, reason: 'unrecognised' },
      {
        label: 'a string count',
        body: { json: { accepted: BODY_MARKER } },
        reason: 'unrecognised',
      },
      { label: 'a negative count', body: { json: { accepted: -1 } }, reason: 'unrecognised' },
      { label: 'a fractional count', body: { json: { accepted: 1.5 } }, reason: 'unrecognised' },
      {
        label: 'a count past 2^53',
        body: { raw: () => '{"accepted":9007199254740993}' },
        reason: 'unrecognised',
      },
      {
        label: 'a count that overflows to infinity',
        body: { raw: () => '{"accepted":1e400}' },
        reason: 'unrecognised',
      },
      { label: 'no accepted count', body: { json: { rejected: 1 } }, reason: 'unrecognised' },
      {
        label: 'a negative rejected count',
        body: { json: { accepted: 1, rejected: -1 } },
        reason: 'unrecognised',
      },
      {
        label: 'a null rejected count',
        body: { json: { accepted: 1, rejected: null } },
        reason: 'unrecognised',
      },
      { label: 'a stream that errors mid-read', body: { raw: erroringBody }, reason: 'unreadable' },
      {
        label: 'a stream of strings rather than bytes',
        body: { raw: textChunkBody },
        reason: 'unreadable',
      },
    ];

    for (const { label, body, reason } of cases) {
      const {
        processor,
        fetch: rig,
        logger,
      } = createHarness({
        statuses: [ACKNOWLEDGED_STATUS],
        bodies: [body],
      });

      feedSpans(processor, 2);
      await expect(processor.forceFlush(), `${label} resolves`).resolves.toBeUndefined();

      expect(rig.calls, `${label} is posted once`).toHaveLength(1);
      expect(processor.stats(), `${label} falls back to "posted"`).toMatchObject({
        postedBatches: 1,
        postedEvents: 2,
        unacknowledgedBatches: 1,
        refusedBatches: 0,
        droppedRejectedByService: 0,
        failedBatches: 0,
        internalErrors: 0,
      });
      expect(unacknowledgedReasonsOf(logger), `${label} is recorded as ${reason}`).toEqual([
        reason,
      ]);
      expect(logger.entriesAt('warn'), `${label} writes nothing at warn`).toHaveLength(0);
      expect(logText(logger), `${label} is not echoed`).not.toContain(BODY_MARKER);
    }
  });

  it('clamps counts that do not fit the batch, so no event is counted twice or invented', async () => {
    const events = 3;
    const cases: readonly {
      readonly label: string;
      readonly json: Readonly<Record<string, number>>;
      readonly posted: number;
      readonly rejected: number;
    }[] = [
      { label: 'more accepted than were sent', json: { accepted: 10 }, posted: 3, rejected: 0 },
      { label: 'fewer accepted, rejected omitted', json: { accepted: 1 }, posted: 1, rejected: 2 },
      {
        label: 'a rejected count that overshoots',
        json: { accepted: 1, rejected: 99 },
        posted: 1,
        rejected: 2,
      },
      {
        label: 'counts that add up to more than the batch',
        json: { accepted: 3, rejected: 5 },
        posted: 3,
        rejected: 0,
      },
      {
        label: 'nothing accepted and too few rejected',
        json: { accepted: 0, rejected: 1 },
        posted: 0,
        rejected: 3,
      },
    ];

    for (const { label, json, posted, rejected } of cases) {
      const {
        processor,
        fetch: rig,
        logger,
      } = createHarness({
        statuses: [ACKNOWLEDGED_STATUS],
        bodies: [{ json }],
      });

      feedSpans(processor, events);
      await processor.forceFlush();

      expect(rig.calls, `${label} is posted once`).toHaveLength(1);
      expect(posted + rejected, `${label} accounts for the batch exactly`).toBe(events);
      expect(processor.stats(), `${label} is clamped to the batch`).toMatchObject({
        postedBatches: posted > 0 ? 1 : 0,
        postedEvents: posted,
        droppedRejectedByService: rejected,
        refusedBatches: posted === 0 ? 1 : 0,
        unacknowledgedBatches: 0,
        internalErrors: 0,
      });
      expect(clampedFlagsOf(logger), `${label} is recorded as clamped`).toEqual([true]);
    }
  });

  it('never writes a byte of an answer into a log record', async () => {
    const bodies: readonly AnswerBody[] = [
      // Read despite a key this module does not know: the reading is tolerant,
      // and the unknown value goes nowhere.
      { json: { accepted: 1, rejected: 1, note: BODY_MARKER } },
      { raw: () => BODY_MARKER },
      { json: { accepted: BODY_MARKER } },
      { raw: erroringBody },
      { raw: textChunkBody },
    ];
    const {
      processor,
      config,
      fetch: rig,
      logger,
    } = createHarness({
      statuses: [ACKNOWLEDGED_STATUS],
      bodies,
    });

    for (let index = 0; index < bodies.length; index += 1) {
      feedSpans(processor, 2, index * 2);
      await processor.forceFlush();
    }

    expect(rig.calls).toHaveLength(bodies.length);
    expect(processor.stats()).toMatchObject({
      postedBatches: bodies.length,
      postedEvents: 1 + 2 * (bodies.length - 1),
      droppedRejectedByService: 1,
      unacknowledgedBatches: bodies.length - 1,
      internalErrors: 0,
    });

    // Something was written — every answer is recorded at debug, the partial
    // refusal at warn — and none of it quotes the answers or the credential.
    expect(logger.entriesAt('debug').length).toBeGreaterThanOrEqual(bodies.length);
    expect(logger.entriesAt('warn')).toHaveLength(1);
    expect(logText(logger)).not.toContain(BODY_MARKER);
    expect(logText(logger)).not.toContain(config.token);
  });

  it('summarises every refusal of one drain in a single warning', async () => {
    const batches = 3;
    const {
      processor,
      fetch: rig,
      logger,
    } = createHarness({
      statuses: [ACKNOWLEDGED_STATUS],
      bodies: [{ json: { accepted: 0, rejected: BATCH_MAX_EVENTS } }],
    });

    feedSpans(processor, BATCH_MAX_EVENTS * batches);
    await processor.forceFlush();

    expect(rig.calls).toHaveLength(batches);
    expect(processor.stats()).toMatchObject({
      refusedBatches: batches,
      droppedRejectedByService: BATCH_MAX_EVENTS * batches,
      postedBatches: 0,
      postedEvents: 0,
    });

    const warnings = logger.entriesAt('warn');
    expect(warnings).toHaveLength(1);
    expect(at(warnings, 0, 'the warnings').fields).toEqual({
      events: BATCH_MAX_EVENTS * batches,
      fullyRefusedBatches: batches,
      droppedTotal: BATCH_MAX_EVENTS * batches,
    });
  });

  it('waits REFUSAL_WARNING_INTERVAL_MS between warnings, carrying what it held back, and writes the rest at shutdown', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { processor, logger } = createHarness({
      statuses: [ACKNOWLEDGED_STATUS],
      bodies: [{ json: { accepted: 0, rejected: 1 } }],
    });

    /** Feed one span, flush it into a refusal, and return the warnings so far. */
    const refuseOne = async (index: number): Promise<readonly LogEntry[]> => {
      feedSpans(processor, 1, index);
      await processor.forceFlush();
      return logger.entriesAt('warn');
    };

    // The first refusal is reported at once.
    expect(await refuseOne(0)).toHaveLength(1);

    // One millisecond short of the interval, the next is held back.
    vi.setSystemTime(start + REFUSAL_WARNING_INTERVAL_MS - 1);
    expect(await refuseOne(1)).toHaveLength(1);

    // At the interval, one warning carries both the held-back refusal and its own.
    vi.setSystemTime(start + REFUSAL_WARNING_INTERVAL_MS);
    const afterInterval = await refuseOne(2);
    expect(afterInterval).toHaveLength(2);
    expect(at(afterInterval, 1, 'the warnings').fields).toEqual({
      events: 2,
      fullyRefusedBatches: 2,
      droppedTotal: 3,
    });

    // Held back again, and then written by the shutdown flush regardless.
    expect(await refuseOne(3)).toHaveLength(2);
    await processor.shutdown();

    const warnings = logger.entriesAt('warn');
    expect(warnings).toHaveLength(3);
    expect(at(warnings, 2, 'the warnings').fields).toEqual({
      events: 1,
      fullyRefusedBatches: 1,
      droppedTotal: 4,
    });
    expect(processor.stats()).toMatchObject({ refusedBatches: 4, droppedRejectedByService: 4 });
  });

  it('treats a clock that moved backwards as the interval having passed', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { processor, logger } = createHarness({
      statuses: [ACKNOWLEDGED_STATUS],
      bodies: [{ json: { accepted: 0, rejected: 1 } }],
    });

    feedSpans(processor, 1);
    await processor.forceFlush();
    expect(logger.entriesAt('warn')).toHaveLength(1);

    // A wall-clock correction must not silence the summary for however long
    // the clock was wrong by.
    vi.setSystemTime(start - 1);
    feedSpans(processor, 1, 1);
    await processor.forceFlush();

    expect(logger.entriesAt('warn')).toHaveLength(2);
  });
});
