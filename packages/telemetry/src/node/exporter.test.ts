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
 * - {@link MAX_LOSS_LEDGER_CAPTURES} — the captures whose unreported loss is
 *   held at once, asserted one over: the oldest capture's loss is abandoned
 *   and never reported. Around it, the capture contract of every post: one
 *   capture per post, named as `armedCaptureId` on every attempt, and the
 *   loss the buffer cap or a failed batch cost carried as `droppedCount` — on
 *   the capture's next batch, or on a loss-only report when none is left —
 *   once, never as zero, never in a drain whose batch just failed, and never
 *   on a timer of its own. Every count travels as a report with a stable
 *   `lossReportId`, present exactly when `droppedCount` is: every attempt and
 *   every resend of a report carries the same id and count, loss recorded
 *   behind an outstanding report travels under a new id only once that report
 *   is delivered, and every lost event is on exactly one of reported, pending
 *   and abandoned — including while its report is on the wire.
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
  MAX_LOSS_LEDGER_CAPTURES,
  MAX_POST_ATTEMPTS,
  REFUSAL_WARNING_INTERVAL_MS,
  RETRYABLE_CLIENT_STATUSES,
  SHUTDOWN_FLUSH_DEADLINE_MS,
} from './exporter.js';
import type { CaptureGate, DebuggenSpanProcessorStats } from './exporter.js';

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

/**
 * A gate a case can re-arm, clear and re-open, as `./control.ts` does between
 * captures.
 *
 * Mutable where {@link CaptureGate} is read-only, which is structurally
 * assignable to it; the generation advances on every arming exactly as the
 * real gate's does, so the processor's stale-stamp rule sees what it would see
 * in a dev server.
 */
interface SwitchableGate {
  /** The armed capture, or `null` while the gate is shut. */
  captureId: string | null;
  /** Advanced by {@link armGate} on every arming. */
  captureGeneration: number;
  /** Every kind is wanted, as with {@link OPEN_GATE}. */
  readonly isKindEnabled: () => boolean;
}

/**
 * A switchable gate armed for `captureId` at generation 1.
 *
 * @param captureId The first capture.
 * @returns The gate.
 */
function switchableGate(captureId: string): SwitchableGate {
  return { captureId, captureGeneration: 1, isKindEnabled: (): boolean => true };
}

/**
 * Arm the gate for a capture, advancing the generation as `./control.ts` does.
 *
 * @param gate The gate.
 * @param captureId The capture to arm.
 */
function armGate(gate: SwitchableGate, captureId: string): void {
  gate.captureGeneration += 1;
  gate.captureId = captureId;
}

/** The capture a case moves to after {@link CAPTURE_ID}. */
const NEXT_CAPTURE_ID = `cap_${'b'.repeat(16)}`;

/**
 * A capture id that encodes its index, for the cases that need more captures
 * than the loss ledger holds.
 *
 * @param index The capture's position.
 * @returns A 20-character capture id.
 */
function captureIdFor(index: number): string {
  return `cap_${index.toString(16).padStart(16, '0')}`;
}

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

  /**
   * The 1-based call from which every call returns a promise that never
   * settles, the calls before it being answered from {@link statuses}.
   *
   * What lets a case leave one particular post on the wire — a loss report
   * after the failed batch that created its loss — while the shutdown
   * deadline passes over it.
   */
  readonly hangFromCall?: number | undefined;

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

    if (
      plan.hangForever === true ||
      (plan.hangFromCall !== undefined && calls.length >= plan.hangFromCall)
    ) {
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
 * @param gate The capture gate; {@link OPEN_GATE} unless a case moves between
 * captures.
 * @returns The harness, registered for teardown.
 */
function createHarness(plan: FetchPlan = {}, gate: CaptureGate = OPEN_GATE): Harness {
  const config = activeConfig();
  const fetchRig = createFetchRig(plan);
  const logger = new RecordingLogger();
  const processor = new DebuggenSpanProcessor({
    gate,
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

/** The capture one call's body named. */
function armedCaptureIdOf(call: FetchCall): string {
  const armedCaptureId = bodyOf(call).armedCaptureId;
  if (typeof armedCaptureId !== 'string') {
    throw new Error('the ingest body named no capture');
  }
  return armedCaptureId;
}

/** The capture each call named, in order. */
function armedCaptureIdsOf(rig: FetchRig): string[] {
  return rig.calls.map((call) => armedCaptureIdOf(call));
}

/**
 * The loss one call's body reported, or `undefined` when it carried no
 * `droppedCount` key at all.
 *
 * A key that is present must be a positive integer: the contract admits no
 * zero and no fraction, so this reader fails rather than normalising one.
 *
 * @param call The call.
 * @returns The count, or `undefined`.
 */
function droppedCountOf(call: FetchCall): number | undefined {
  const body = bodyOf(call);
  if (!Object.hasOwn(body, 'droppedCount')) {
    return undefined;
  }
  const droppedCount = body.droppedCount;
  if (typeof droppedCount !== 'number' || !Number.isSafeInteger(droppedCount) || droppedCount < 1) {
    throw new Error('the ingest body carried a droppedCount that is not a positive integer');
  }
  return droppedCount;
}

/** The loss each call reported, in order; `undefined` where it carried none. */
function droppedCountsOf(rig: FetchRig): (number | undefined)[] {
  return rig.calls.map((call) => droppedCountOf(call));
}

/**
 * The longest `lossReportId` the ingest contract admits.
 *
 * Spelled rather than imported: the grammar belongs to `@debuggen/protocol`,
 * which this package sits below and may not import.
 */
const LOSS_REPORT_ID_MAX_LENGTH = 64;

/**
 * The loss report identity one call's body carried, or `undefined` when it
 * carried no `lossReportId` key at all.
 *
 * The key must travel exactly when `droppedCount` does — an id without a
 * count, or a count without an id, is a body the service refuses — and inside
 * the contract's identifier grammar: 1 to {@link LOSS_REPORT_ID_MAX_LENGTH}
 * characters with no surrounding whitespace. This reader fails on anything
 * else rather than normalising it.
 *
 * @param call The call.
 * @returns The id, or `undefined`.
 */
function lossReportIdOf(call: FetchCall): string | undefined {
  const body = bodyOf(call);
  const carriesId = Object.hasOwn(body, 'lossReportId');
  if (carriesId !== Object.hasOwn(body, 'droppedCount')) {
    throw new Error('the ingest body carried lossReportId and droppedCount apart');
  }
  if (!carriesId) {
    return undefined;
  }
  const lossReportId = body.lossReportId;
  if (
    typeof lossReportId !== 'string' ||
    lossReportId.length < 1 ||
    lossReportId.length > LOSS_REPORT_ID_MAX_LENGTH ||
    lossReportId.trim() !== lossReportId
  ) {
    throw new Error('the ingest body carried a lossReportId outside the identifier grammar');
  }
  return lossReportId;
}

/** The report identity each call carried, in order; `undefined` where none. */
function lossReportIdsOf(rig: FetchRig): (string | undefined)[] {
  return rig.calls.map((call) => lossReportIdOf(call));
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

    // The events, the project root, and the capture the events were recorded
    // in. Nothing was lost, so no `droppedCount` travels.
    const body = bodyOf(call);
    expect(Object.keys(body).sort()).toEqual(['armedCaptureId', 'events', 'projectRoot']);
    expect(body.projectRoot).toBe(config.projectRoot);
    expect(body.armedCaptureId).toBe(CAPTURE_ID);
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

/*
 * ---------------------------------------------------------------------------
 * One capture per post, and the loss it reports
 *
 * Every post names the capture its events were recorded in, so the service
 * can refuse a batch that outlived its capture instead of storing it under
 * the next one; and every event this processor loses is reported to that
 * capture as `droppedCount`, so the service's capture ledger sees server-tier
 * loss. The cases drive a switchable gate the way `./control.ts` drives the
 * real one — arm, re-arm, clear — and read the capture and the count off the
 * wire.
 * ---------------------------------------------------------------------------
 */

/**
 * Assert that every event credited to the loss ledger is on exactly one of
 * its three outcomes: reported, pending or abandoned.
 *
 * @param processor The processor.
 */
function expectLossAccounted(processor: DebuggenSpanProcessor): void {
  const stats = processor.stats();
  expect(stats.reportedLossEvents + stats.pendingLossEvents + stats.abandonedLossEvents).toBe(
    stats.droppedOverflow + stats.droppedFailedBatch + stats.droppedUnserializable,
  );
}

describe('one capture per post, and the loss it reports', () => {
  it('names the capture its events were recorded in on every post, and reports no loss it did not have', async () => {
    const { processor, fetch: rig } = createHarness();

    feedSpans(processor, BATCH_MAX_EVENTS + 1);
    await processor.forceFlush();

    expect(armedCaptureIdsOf(rig)).toEqual([CAPTURE_ID, CAPTURE_ID]);
    // Nothing was lost, so no post carries either key at all — never a zero,
    // and never a report identity without a count.
    expect(droppedCountsOf(rig)).toEqual([undefined, undefined]);
    expect(lossReportIdsOf(rig)).toEqual([undefined, undefined]);
    expect(processor.stats()).toMatchObject({
      postedBatches: 2,
      postedEvents: BATCH_MAX_EVENTS + 1,
      lossReportBatches: 0,
      reportedLossEvents: 0,
      pendingLossEvents: 0,
      abandonedLossEvents: 0,
    });
  });

  it('posts a buffer holding two captures as separate posts, the older capture first', async () => {
    const olderEvents = BATCH_MAX_EVENTS + 44;
    const newerEvents = 10;
    const gate = switchableGate(CAPTURE_ID);
    const { processor, fetch: rig } = createHarness({}, gate);

    // Re-armed before any drain has run: the threshold drain is queued, not
    // run, while the feed is synchronous, so it finds both captures buffered.
    feedSpans(processor, olderEvents);
    armGate(gate, NEXT_CAPTURE_ID);
    feedSpans(processor, newerEvents, olderEvents);
    await processor.forceFlush();

    expect(armedCaptureIdsOf(rig)).toEqual([CAPTURE_ID, CAPTURE_ID, NEXT_CAPTURE_ID]);
    // The older capture's run is split at the batch size and never topped up
    // with the newer capture's events.
    expect(batchSizesOf(rig)).toEqual([
      BATCH_MAX_EVENTS,
      olderEvents - BATCH_MAX_EVENTS,
      newerEvents,
    ]);

    // Each capture's events are its own, in feed order, numbered in its own
    // sequence.
    const newer = eventsOf(at(rig.calls, 2, 'the ingest calls'));
    expect(newer.map((event) => event.spanId)).toEqual(
      numberRange(olderEvents, newerEvents).map((index) => spanIdFor(index)),
    );
    expect(newer.map((event) => seqOf(event))).toEqual(numberRange(0, newerEvents));
    expect(
      rig.calls
        .slice(0, 2)
        .flatMap((call) => eventsOf(call))
        .map((event) => seqOf(event)),
    ).toEqual(numberRange(0, olderEvents));
    expect(processor.stats()).toMatchObject({
      postedBatches: 3,
      postedEvents: olderEvents + newerEvents,
    });
  });

  it('still names the recorded capture, byte for byte, when a batch is retried across a re-arm', async () => {
    vi.useFakeTimers();
    const gate = switchableGate(CAPTURE_ID);
    const harness = createHarness(
      {
        statuses: [UNAVAILABLE_STATUS, ACCEPTED_STATUS],
        beforeAnswer: (call) => {
          if (call !== 1) {
            return;
          }
          // The capture stops and the next one is armed while the first
          // attempt is on the wire, and the next capture's first span ends.
          armGate(gate, NEXT_CAPTURE_ID);
          feedSpans(harness.processor, 1, 1);
        },
      },
      gate,
    );

    feedSpans(harness.processor, 1);
    const flushing = harness.processor.forceFlush();
    await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS * 2 ** MAX_POST_ATTEMPTS);
    await flushing;

    const { calls } = harness.fetch;
    expect(armedCaptureIdsOf(harness.fetch)).toEqual([CAPTURE_ID, CAPTURE_ID, NEXT_CAPTURE_ID]);
    // The retry resends the first attempt's bytes: the batch is never renamed
    // after the capture the gate holds now.
    expect(at(calls, 1, 'the ingest calls').init?.body).toBe(
      at(calls, 0, 'the ingest calls').init?.body,
    );
    const moved = eventsOf(at(calls, 2, 'the ingest calls'));
    expect(moved.map((event) => event.spanId)).toEqual([spanIdFor(1)]);
    expect(moved.map((event) => seqOf(event))).toEqual([0]);
    expect(harness.processor.stats()).toMatchObject({ postedBatches: 2, failedBatches: 0 });
  });

  it('reports overflow loss as droppedCount on the next post for its capture, exactly once', async () => {
    const { processor, fetch: rig } = createHarness();

    feedSpans(processor, MAX_BUFFERED_EVENTS + 1);
    expect(processor.stats()).toMatchObject({ droppedOverflow: 1, pendingLossEvents: 1 });

    await processor.forceFlush();

    const counts = droppedCountsOf(rig);
    expect(counts[0]).toBe(1);
    expect(counts.slice(1).every((count) => count === undefined)).toBe(true);
    // Carried by an event batch, so no loss-only report was needed, and the
    // count is loss, never delivered events.
    expect(rig.calls).toHaveLength(Math.ceil(MAX_BUFFERED_EVENTS / BATCH_MAX_EVENTS));
    expect(processor.stats()).toMatchObject({
      postedEvents: MAX_BUFFERED_EVENTS,
      lossReportBatches: 0,
      reportedLossEvents: 1,
      pendingLossEvents: 0,
      abandonedLossEvents: 0,
    });

    await processor.forceFlush();
    expect(rig.calls).toHaveLength(Math.ceil(MAX_BUFFERED_EVENTS / BATCH_MAX_EVENTS));
    expectLossAccounted(processor);
  });

  it("credits a failed batch's events to its capture and reports them on the next delivered post", async () => {
    const { processor, fetch: rig } = createHarness({
      statuses: [REFUSED_STATUS, ACCEPTED_STATUS],
    });

    feedSpans(processor, 3);
    await processor.forceFlush();

    expect(rig.calls).toHaveLength(1);
    expect(processor.stats()).toMatchObject({
      failedBatches: 1,
      droppedFailedBatch: 3,
      pendingLossEvents: 3,
    });

    feedSpans(processor, 2, 3);
    await processor.forceFlush();
    feedSpans(processor, 1, 5);
    await processor.forceFlush();

    // Reported on the next post, and only there.
    expect(droppedCountsOf(rig)).toEqual([undefined, 3, undefined]);
    expect(batchSizesOf(rig)).toEqual([3, 2, 1]);
    expect(processor.stats()).toMatchObject({
      postedEvents: 3,
      reportedLossEvents: 3,
      pendingLossEvents: 0,
      lossReportBatches: 0,
    });
    expectLossAccounted(processor);
  });

  it('keeps the report a refused post carried, and sends what was lost behind it under a new id only after it is delivered', async () => {
    const { processor, fetch: rig } = createHarness({
      statuses: [REFUSED_STATUS, REFUSED_STATUS, ACCEPTED_STATUS],
    });

    feedSpans(processor, 3);
    await processor.forceFlush();
    feedSpans(processor, 2, 3);
    await processor.forceFlush();

    // The refused post carried a report of the first batch's three events.
    // It stays outstanding as it was, and the second batch's own two events
    // wait beside it rather than being folded into a count already sent.
    expect(droppedCountsOf(rig)).toEqual([undefined, 3]);
    expect(processor.stats()).toMatchObject({ pendingLossEvents: 5, reportedLossEvents: 0 });
    expectLossAccounted(processor);

    feedSpans(processor, 1, 5);
    await processor.forceFlush();

    // The next post resends the same report, and only once it is delivered
    // does the loss behind it travel, as a loss-only report under a new id.
    expect(droppedCountsOf(rig)).toEqual([undefined, 3, 3, 2]);
    expect(batchSizesOf(rig)).toEqual([3, 2, 1, 0]);
    const [none, refused, resent, followUp] = lossReportIdsOf(rig);
    expect(none).toBeUndefined();
    expect(refused).toBeDefined();
    expect(resent).toBe(refused);
    expect(followUp).toBeDefined();
    expect(followUp).not.toBe(refused);
    expect(processor.stats()).toMatchObject({
      droppedFailedBatch: 5,
      lossReportBatches: 1,
      reportedLossEvents: 5,
      pendingLossEvents: 0,
    });
    expectLossAccounted(processor);
  });

  it('sends the identical lossReportId and droppedCount on every attempt of a retried post', async () => {
    vi.useFakeTimers();
    const retries = Array.from({ length: MAX_POST_ATTEMPTS - 1 }, () => UNAVAILABLE_STATUS);
    const pendingWhileOnTheWire: number[] = [];
    const harness = createHarness({
      statuses: [REFUSED_STATUS, ...retries, ACCEPTED_STATUS],
      beforeAnswer: (call) => {
        if (call === 1) {
          return;
        }
        // The report on the wire is pending exactly once, not once for the
        // post and once more for the capture it was reserved from.
        pendingWhileOnTheWire.push(harness.processor.stats().pendingLossEvents);
        expectLossAccounted(harness.processor);
      },
    });
    const { processor, fetch: rig } = harness;

    feedSpans(processor, 2);
    await processor.forceFlush();
    feedSpans(processor, 1, 2);
    const flushing = processor.forceFlush();
    await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS * 2 ** MAX_POST_ATTEMPTS);
    await flushing;

    const attempts = rig.calls.slice(1);
    expect(attempts).toHaveLength(MAX_POST_ATTEMPTS);
    // Byte for byte: one serialisation, every attempt.
    const first = at(attempts, 0, 'the attempts').init?.body;
    for (const attempt of attempts) {
      expect(attempt.init?.body).toBe(first);
    }
    expect(droppedCountsOf(rig).slice(1)).toEqual(attempts.map(() => 2));
    const ids = lossReportIdsOf(rig).slice(1);
    expect(new Set(ids).size).toBe(1);
    expect(at(ids, 0, 'the report ids')).toBeDefined();
    expect(pendingWhileOnTheWire).toEqual(attempts.map(() => 2));

    // Delivered once, on the attempt that was answered with a `2xx`.
    expect(processor.stats()).toMatchObject({
      postedBatches: 1,
      reportedLossEvents: 2,
      pendingLossEvents: 0,
      lossReportBatches: 0,
    });
    expectLossAccounted(processor);
  });

  it('resends the same report in the next drain after its post exhausted every attempt', async () => {
    vi.useFakeTimers();
    const exhausted = Array.from({ length: MAX_POST_ATTEMPTS }, () => SERVER_ERROR_STATUS);
    const gate = switchableGate(CAPTURE_ID);
    const { processor, fetch: rig } = createHarness(
      { statuses: [REFUSED_STATUS, ...exhausted, ACKNOWLEDGED_STATUS] },
      gate,
    );

    feedSpans(processor, 1);
    await processor.forceFlush();
    gate.captureId = null;

    // A `5xx` may come from a service that recorded the report before it
    // failed, which is exactly why the next drain must not rename it.
    const failing = processor.forceFlush();
    await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS * 2 ** MAX_POST_ATTEMPTS);
    await failing;
    expect(rig.calls).toHaveLength(1 + MAX_POST_ATTEMPTS);
    expect(processor.stats()).toMatchObject({
      pendingLossEvents: 1,
      reportedLossEvents: 0,
      lossReportBatches: 0,
    });
    expectLossAccounted(processor);

    await processor.forceFlush();

    const reports = rig.calls.slice(1);
    expect(reports).toHaveLength(MAX_POST_ATTEMPTS + 1);
    expect(batchSizesOf(rig).slice(1)).toEqual(reports.map(() => 0));
    expect(droppedCountsOf(rig).slice(1)).toEqual(reports.map(() => 1));
    expect(new Set(lossReportIdsOf(rig).slice(1)).size).toBe(1);
    const failedBody = at(reports, 0, 'the loss reports').init?.body;
    expect(at(reports, MAX_POST_ATTEMPTS, 'the loss reports').init?.body).toBe(failedBody);
    expect(processor.stats()).toMatchObject({
      pendingLossEvents: 0,
      reportedLossEvents: 1,
      lossReportBatches: 1,
    });

    // Delivered, so nothing is left to resend.
    await processor.forceFlush();
    expect(rig.calls).toHaveLength(MAX_POST_ATTEMPTS + 2);
    expectLossAccounted(processor);
  });

  it('sends a loss-only report once no event is left to carry the loss, counted apart from batches', async () => {
    const gate = switchableGate(CAPTURE_ID);
    const {
      processor,
      config,
      fetch: rig,
    } = createHarness({ statuses: [REFUSED_STATUS, ACCEPTED_STATUS] }, gate);

    feedSpans(processor, 2);
    await processor.forceFlush();
    expect(rig.calls).toHaveLength(1);

    // `./control.ts` clears the gate before its disable-path flush, so the
    // report must name the capture the loss belongs to, not the gate's.
    gate.captureId = null;
    await processor.forceFlush();

    expect(rig.calls).toHaveLength(2);
    const report = at(rig.calls, 1, 'the ingest calls');
    const body = bodyOf(report);
    expect(Object.keys(body).sort()).toEqual([
      'armedCaptureId',
      'droppedCount',
      'events',
      'lossReportId',
      'projectRoot',
    ]);
    // A loss-only report is a report like any other: it carries its identity.
    const lossReportId = lossReportIdOf(report);
    expect(lossReportId).toBeDefined();
    expect(body).toEqual({
      projectRoot: config.projectRoot,
      events: [],
      armedCaptureId: CAPTURE_ID,
      droppedCount: 2,
      lossReportId,
    });
    expect(headersOf(report).Authorization).toBe(`Bearer ${config.token}`);
    expect(processor.stats()).toMatchObject({
      lossReportBatches: 1,
      reportedLossEvents: 2,
      pendingLossEvents: 0,
      postedBatches: 0,
      postedEvents: 0,
      refusedBatches: 0,
      unacknowledgedBatches: 0,
      failedBatches: 1,
    });

    // Delivered once: a further flush has nothing to say.
    await processor.forceFlush();
    expect(rig.calls).toHaveLength(2);
    expectLossAccounted(processor);
  });

  it('holds every loss-only report in a drain where a batch failed, and sends them oldest first later', async () => {
    const gate = switchableGate(CAPTURE_ID);
    const { processor, fetch: rig } = createHarness(
      { statuses: [REFUSED_STATUS, REFUSED_STATUS, ACCEPTED_STATUS] },
      gate,
    );

    feedSpans(processor, 1);
    await processor.forceFlush();
    armGate(gate, NEXT_CAPTURE_ID);
    feedSpans(processor, 1, 1);
    await processor.forceFlush();

    // The second drain's batch failed, so the first capture's pending loss
    // was not reported in it.
    expect(armedCaptureIdsOf(rig)).toEqual([CAPTURE_ID, NEXT_CAPTURE_ID]);
    expect(processor.stats().pendingLossEvents).toBe(2);

    await processor.forceFlush();

    expect(armedCaptureIdsOf(rig)).toEqual([
      CAPTURE_ID,
      NEXT_CAPTURE_ID,
      CAPTURE_ID,
      NEXT_CAPTURE_ID,
    ]);
    expect(batchSizesOf(rig)).toEqual([1, 1, 0, 0]);
    expect(droppedCountsOf(rig)).toEqual([undefined, undefined, 1, 1]);
    // Each capture's report is its own: two captures, two identities.
    const [, , olderReport, newerReport] = lossReportIdsOf(rig);
    expect(olderReport).toBeDefined();
    expect(newerReport).toBeDefined();
    expect(newerReport).not.toBe(olderReport);
    expect(processor.stats()).toMatchObject({ lossReportBatches: 2, pendingLossEvents: 0 });
    expectLossAccounted(processor);
  });

  it('arms no flush window for loss alone, so an absent service is not polled', async () => {
    vi.useFakeTimers();
    const { processor, fetch: rig } = createHarness({ rejectEverything: true });

    feedSpans(processor, 1);
    const flushing = processor.forceFlush();
    await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS * 2 ** MAX_POST_ATTEMPTS);
    await flushing;
    expect(rig.calls).toHaveLength(MAX_POST_ATTEMPTS);

    // Many flush windows later, nothing has tried again: the loss waits for
    // the next event, an explicit flush or the shutdown drain.
    await vi.advanceTimersByTimeAsync(BATCH_FLUSH_INTERVAL_MS * 10);
    expect(rig.calls).toHaveLength(MAX_POST_ATTEMPTS);
    expect(processor.stats()).toMatchObject({ pendingLossEvents: 1, lossReportBatches: 0 });
  });

  it('abandons the oldest capture once more than MAX_LOSS_LEDGER_CAPTURES hold loss', async () => {
    const captures = MAX_LOSS_LEDGER_CAPTURES + 1;
    const gate = switchableGate(captureIdFor(0));
    const { processor, fetch: rig } = createHarness(
      { statuses: [...Array.from({ length: captures }, () => REFUSED_STATUS), ACCEPTED_STATUS] },
      gate,
    );

    for (let index = 0; index < captures; index += 1) {
      if (index > 0) {
        armGate(gate, captureIdFor(index));
      }
      feedSpans(processor, 1, index);
      await processor.forceFlush();
    }

    expect(rig.calls).toHaveLength(captures);
    expect(processor.stats()).toMatchObject({
      pendingLossEvents: MAX_LOSS_LEDGER_CAPTURES,
      abandonedLossEvents: 1,
    });

    gate.captureId = null;
    await processor.forceFlush();

    // One report per capture still held, in arming order; the evicted capture
    // is never reported.
    const reported = armedCaptureIdsOf(rig).slice(captures);
    expect(reported).toEqual(
      numberRange(1, MAX_LOSS_LEDGER_CAPTURES).map((index) => captureIdFor(index)),
    );
    expect(reported).not.toContain(captureIdFor(0));
    expect(processor.stats()).toMatchObject({
      lossReportBatches: MAX_LOSS_LEDGER_CAPTURES,
      reportedLossEvents: MAX_LOSS_LEDGER_CAPTURES,
      pendingLossEvents: 0,
      abandonedLossEvents: 1,
    });

    // Every report has an identity of its own, inside the grammar the reader
    // enforces, and none is derived from the credential, the project root or
    // the capture it reports on.
    const ids = lossReportIdsOf(rig).slice(captures);
    expect(ids).toHaveLength(MAX_LOSS_LEDGER_CAPTURES);
    expect(new Set(ids).size).toBe(MAX_LOSS_LEDGER_CAPTURES);
    const { token, projectRoot } = activeConfig();
    for (const [index, id] of ids.entries()) {
      if (id === undefined) {
        throw new Error(`loss report ${String(index)} carried no lossReportId`);
      }
      expect(token).not.toContain(id);
      expect(projectRoot).not.toContain(id);
      expect(id).not.toBe(at(reported, index, 'the reported captures'));
    }
    expectLossAccounted(processor);
  });

  it('abandons the pending loss when the credential is refused, and posts nothing more', async () => {
    const { processor, fetch: rig } = createHarness({
      statuses: [REFUSED_STATUS, UNAUTHORIZED_STATUS],
    });

    feedSpans(processor, 2);
    await processor.forceFlush();
    feedSpans(processor, 1, 2);
    await processor.forceFlush();

    // The refused post carried the loss; the refusal latched the credential.
    expect(droppedCountsOf(rig)).toEqual([undefined, 2]);
    expect(lossReportIdsOf(rig)[0]).toBeUndefined();
    expect(lossReportIdsOf(rig)[1]).toBeDefined();
    expect(processor.stats()).toMatchObject({
      credentialRejected: true,
      droppedFailedBatch: 3,
      reportedLossEvents: 0,
      pendingLossEvents: 0,
      abandonedLossEvents: 3,
    });

    await processor.forceFlush();
    await processor.shutdown();

    expect(rig.calls).toHaveLength(2);
    expect(processor.stats()).toMatchObject({ pendingLossEvents: 0, abandonedLossEvents: 3 });
    expectLossAccounted(processor);
  });

  it('sends pending loss once in the shutdown drain', async () => {
    const { processor, fetch: rig } = createHarness({
      statuses: [REFUSED_STATUS, ACCEPTED_STATUS],
    });

    feedSpans(processor, 1);
    await processor.forceFlush();
    await processor.shutdown();

    expect(rig.calls).toHaveLength(2);
    expect(batchSizesOf(rig)).toEqual([1, 0]);
    expect(droppedCountsOf(rig)).toEqual([undefined, 1]);
    expect(processor.stats()).toMatchObject({
      lossReportBatches: 1,
      reportedLossEvents: 1,
      pendingLossEvents: 0,
      abandonedLossEvents: 0,
    });

    // The next capture's provider reopens the processor; the report is not
    // sent a second time.
    processor.reopen();
    await processor.forceFlush();
    expect(rig.calls).toHaveLength(2);
    expectLossAccounted(processor);
  });

  it('abandons at shutdown the loss its single attempt could not deliver', async () => {
    const { processor, fetch: rig } = createHarness({ rejectEverything: true });

    feedSpans(processor, 1);
    await processor.shutdown();

    // One attempt for the batch, and no report in the drain it failed in.
    expect(rig.calls).toHaveLength(1);
    expect(processor.stats()).toMatchObject({
      droppedFailedBatch: 1,
      pendingLossEvents: 0,
      abandonedLossEvents: 1,
    });

    processor.reopen();
    await processor.forceFlush();
    expect(rig.calls).toHaveLength(1);
    expectLossAccounted(processor);
  });

  it('leaves a report still on the wire out of the shutdown abandonment, and counts it once', async () => {
    vi.useFakeTimers();
    const gate = switchableGate(CAPTURE_ID);
    const { processor, fetch: rig } = createHarness(
      { statuses: [REFUSED_STATUS, REFUSED_STATUS], hangFromCall: 3 },
      gate,
    );

    feedSpans(processor, 2);
    await processor.forceFlush();
    armGate(gate, NEXT_CAPTURE_ID);
    feedSpans(processor, 1, 2);
    await processor.forceFlush();

    // The shutdown drain's first loss report never gets an answer before the
    // deadline passes over it.
    const shuttingDown = processor.shutdown();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_DEADLINE_MS);
    await shuttingDown;

    expect(processor.isShutDown).toBe(true);
    expect(armedCaptureIdsOf(rig)).toEqual([CAPTURE_ID, NEXT_CAPTURE_ID, CAPTURE_ID]);
    expect(droppedCountsOf(rig)).toEqual([undefined, undefined, 2]);
    // The report on the wire is still the post's to settle, so it stays
    // pending, counted once; the other capture's loss had no carrier left.
    expect(processor.stats()).toMatchObject({
      droppedFailedBatch: 3,
      reportedLossEvents: 0,
      pendingLossEvents: 2,
      abandonedLossEvents: 1,
    });
    expectLossAccounted(processor);
  });

  it('lets a report on the wire outlive the eviction of its capture, and counts it once', async () => {
    const overflowCapture = captureIdFor(MAX_LOSS_LEDGER_CAPTURES);
    const gate = switchableGate(captureIdFor(0));
    const onTheWire: DebuggenSpanProcessorStats[] = [];
    const harness = createHarness(
      {
        statuses: [
          ...Array.from({ length: MAX_LOSS_LEDGER_CAPTURES }, () => REFUSED_STATUS),
          ACCEPTED_STATUS,
        ],
        beforeAnswer: (call) => {
          if (call !== MAX_LOSS_LEDGER_CAPTURES + 1) {
            return;
          }
          // While the oldest capture's report is on the wire, a new capture
          // overflows the buffer: its loss makes it the ledger's ninth
          // capture, which evicts the oldest — the one being reported.
          armGate(gate, overflowCapture);
          feedSpans(harness.processor, MAX_BUFFERED_EVENTS + 1, MAX_LOSS_LEDGER_CAPTURES);
          onTheWire.push(harness.processor.stats());
          expectLossAccounted(harness.processor);
        },
      },
      gate,
    );
    const { processor, fetch: rig } = harness;

    for (let index = 0; index < MAX_LOSS_LEDGER_CAPTURES; index += 1) {
      if (index > 0) {
        armGate(gate, captureIdFor(index));
      }
      feedSpans(processor, 1, index);
      await processor.forceFlush();
    }
    gate.captureId = null;
    await processor.forceFlush();
    // The overflow queued drains of its own; this one runs behind them all.
    await processor.forceFlush();

    // The evicted capture's report was the post's to settle, so eviction
    // abandoned nothing and the report counted as pending exactly once.
    expect(onTheWire).toHaveLength(1);
    expect(at(onTheWire, 0, 'the snapshots on the wire')).toMatchObject({
      droppedOverflow: 1,
      pendingLossEvents: MAX_LOSS_LEDGER_CAPTURES + 1,
      abandonedLossEvents: 0,
    });

    // Delivered once, and never resent under its own id or any other.
    const evictedReport = at(rig.calls, MAX_LOSS_LEDGER_CAPTURES, 'the ingest calls');
    expect(armedCaptureIdOf(evictedReport)).toBe(captureIdFor(0));
    const evictedId = lossReportIdOf(evictedReport);
    expect(evictedId).toBeDefined();
    expect(lossReportIdsOf(rig).filter((id) => id === evictedId)).toHaveLength(1);
    expect(
      armedCaptureIdsOf(rig).filter((captureId) => captureId === captureIdFor(0)),
    ).toHaveLength(2);
    expect(processor.stats()).toMatchObject({
      droppedFailedBatch: MAX_LOSS_LEDGER_CAPTURES,
      droppedOverflow: 1,
      postedEvents: MAX_BUFFERED_EVENTS,
      lossReportBatches: MAX_LOSS_LEDGER_CAPTURES,
      reportedLossEvents: MAX_LOSS_LEDGER_CAPTURES + 1,
      pendingLossEvents: 0,
      abandonedLossEvents: 0,
    });
    expectLossAccounted(processor);
  });

  it('keeps the loss pending, and posts the batch without it, when no report identity can be minted', async () => {
    const {
      processor,
      fetch: rig,
      logger,
    } = createHarness({
      statuses: [REFUSED_STATUS, ACCEPTED_STATUS],
    });

    feedSpans(processor, 1);
    await processor.forceFlush();
    feedSpans(processor, 1, 1);

    // No Web Crypto global: `@debuggen/shared` cannot draw a random identity,
    // and a report is never sent under anything else.
    vi.stubGlobal('crypto', undefined);
    try {
      await processor.forceFlush();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(droppedCountsOf(rig)).toEqual([undefined, undefined]);
    expect(lossReportIdsOf(rig)).toEqual([undefined, undefined]);
    // Once for the batch, and once for the loss-only report the drain then
    // tried: neither could carry the loss, and neither threw.
    expect(processor.stats()).toMatchObject({
      postedBatches: 1,
      internalErrors: 2,
      reportedLossEvents: 0,
      pendingLossEvents: 1,
      lossReportBatches: 0,
    });
    expect(logText(logger)).not.toContain(AGENT_TOKEN);
    expectLossAccounted(processor);

    await processor.forceFlush();

    expect(droppedCountsOf(rig)).toEqual([undefined, undefined, 1]);
    expect(lossReportIdsOf(rig)[2]).toBeDefined();
    expect(processor.stats()).toMatchObject({
      reportedLossEvents: 1,
      pendingLossEvents: 0,
      lossReportBatches: 1,
    });
    expectLossAccounted(processor);
  });
});
