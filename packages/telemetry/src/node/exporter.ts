/**
 * The preload's only outbound path: {@link DebuggenSpanProcessor}, an
 * OpenTelemetry `SpanProcessor` that turns finished spans into
 * {@link TelemetryEventIngress} records and posts them to the local service's
 * ingest endpoint over plain HTTP.
 *
 * **No OTLP, and no collector.** The service is not an OpenTelemetry backend:
 * it owns sessions, captures, redaction and correlation, and it accepts exactly
 * one request shape (AAP §0.4.2). That is why the plan rejected a
 * batteries-included exporter package and why nothing here speaks a wire
 * protocol other than `POST` + JSON — the span model is borrowed from
 * OpenTelemetry, the transport is ours.
 *
 * ## The ingest contract, exactly
 *
 * | Part | Value |
 * | --- | --- |
 * | Method | `POST` |
 * | URL | {@link PreloadConfig.ingestUrl} **verbatim** |
 * | Headers | `Content-Type: application/json`, `Authorization: Bearer <token>` — and no others |
 * | Body | `{ projectRoot, events }`, `events` being {@link TelemetryEventIngress}[] |
 * | Timeout | {@link INGEST_TIMEOUT_MS}, enforced with an abort signal |
 * | Redirects | refused (`redirect: 'error'`) |
 *
 * Three of those rows are traps worth naming:
 *
 * 1. ⚠️ **The URL is already complete.** `DEBUGGEN_INGEST_URL` is the endpoint,
 *    `{serviceBase}/telemetry/ingest`, and `./config.ts` hands it over
 *    canonicalised. Appending a path to it produces a URL that 404s on every
 *    batch, and the only symptom is a capture with no server or database
 *    evidence in it.
 * 2. ⚠️ **No `Origin` header.** The service refuses any request whose `Origin`
 *    is an `http:`/`https:` web origin and accepts an *absent* `Origin` from
 *    Node clients (AAP §0.5.6). Setting one — even to the service's own
 *    address — gets every batch rejected. `fetch` in Node adds none on its own,
 *    so the rule here is simply never to add one.
 * 3. ⚠️ **`projectRoot` travels unmodified.** The server-agent credential is
 *    scoped to one project root and ingest is accepted only for that project,
 *    so the value from the config is copied, never normalised or re-resolved.
 *
 * `sessionId`, `captureId` and `ingestSeq` are **service-assigned** and the
 * ingress schema is strict, so a single extra key fails a whole batch. This
 * module therefore posts exactly the objects `./convert.ts` produced and adds
 * nothing to them.
 *
 * ## Three drop rules, in this order
 *
 * The capture gate ({@link CaptureGate}, implemented by `./control.ts`) owns
 * capture state; this processor is what enforces it, on every span, before any
 * conversion work happens:
 *
 * 1. **Outside an active capture, every span is dropped.** `captureId === null`
 *    means no session has armed this process, and the guarantee is that "an
 *    unrelated plan collects no backend or database telemetry" (AAP §0.7.1
 *    Group 1). A span is not merely left unsent — it is never converted.
 * 2. **A span belonging to a capture that has been replaced is dropped.**
 *    `onStart` stamps every span with the capture and generation in force when
 *    it started, and `onEnd` rejects a stamp that is no longer current. This
 *    rule exists because an ingest event carries **no capture id**: the service
 *    assigns `sessionId`, `captureId` and `ingestSeq` on arrival, so a span
 *    from capture A exported after capture B was armed would be *stored under
 *    B*. Attribution cannot be corrected downstream, which is why it is
 *    enforced here, and why `./control.ts` flushes the outgoing capture before
 *    it arms the next one — that is what gets A's finished spans out while A is
 *    still the capture the service has open.
 * 3. **A signal the capture did not ask for is dropped.** The span is
 *    classified with {@link classifySpan} and offered to the gate, which
 *    answers on three axes, because one kind is not one signal: the kind
 *    itself, the *instrumentation source* of a `db.query` span (`prisma` and
 *    `pg` are independent switches over that single kind), and the *symbol* of
 *    a `function` span (`functions` is the list of names the plan patched, not
 *    a switch). Each refusal lands on its own counter.
 *
 * Only a span that survives all three is converted, and a conversion that
 * returns `null` is counted and skipped. The order is deliberate: the cheapest
 * check runs first, and the counters it increments are what
 * `./control.test.ts` asserts on.
 *
 * ## Batching and backpressure
 *
 * Events accumulate in one buffer. It is flushed when it reaches
 * {@link BATCH_MAX_EVENTS}, or {@link BATCH_FLUSH_INTERVAL_MS} after the first
 * event landed in an empty buffer — whichever comes first — because the
 * DevTools panel tails a capture live and latency is visible to the developer.
 * The timer is a single one-shot handle, re-armed per window rather than a
 * standing interval, and it is always `unref`'d: a pending flush must never be
 * the reason a developer's `next dev` refuses to exit.
 *
 * The buffer is capped at {@link MAX_BUFFERED_EVENTS}. At the cap the
 * **oldest** events are dropped — during a reproduction the newest evidence is
 * the relevant evidence — and the loss is counted so a capture can be reported
 * as thinned rather than silently wrong. One warning is written per flush
 * window, never one per event: a flood of lines in someone else's terminal is
 * itself a defect.
 *
 * Drains are serialised on a promise chain, so one batch is in flight at a
 * time and a batch is never posted twice. A batch is taken out of the buffer
 * before it is posted and **is not re-queued on failure**: it is retried in
 * place, bounded by {@link MAX_POST_ATTEMPTS} attempts over a backoff that
 * starts at {@link RECONNECT_MIN_MS}, doubles under a
 * {@link RECONNECT_MAX_MS} ceiling and carries ±25 % jitter
 * ({@link computeIngestBackoffMs}) so several attached dev servers do not
 * retry in lockstep after the service restarts, and then dropped
 * and counted. Re-queuing would let one unsendable batch cycle forever and
 * starve the evidence behind it; losing dev-time telemetry is acceptable,
 * degrading the developer's dev server never is.
 *
 * ## Never throw into the host process
 *
 * `onStart` and `onEnd` are called synchronously by the host's span pipeline,
 * on a stack the developer's application owns. Every method here — including
 * `forceFlush` and `shutdown`, which the provider's own shutdown path awaits —
 * catches everything and resolves rather than rejects. A surprise becomes a
 * counter and at most a log line.
 *
 * ## Privacy
 *
 * The bearer credential is used here and **never logged, printed, interpolated
 * into a message or attached to an error**: `scripts/check-secrets.mjs` is a
 * blocking gate, and a token in a dev-server terminal outlives the process it
 * belonged to by as long as the scrollback does. Diagnostics name the endpoint
 * (which `./config.ts` has already guaranteed carries no credentials), the
 * status code and counts — and every message is passed through a scrub that
 * removes the token should a foreign error text ever quote it.
 *
 * Where the credential may travel is checked as well as how it is written. The
 * constructor re-applies `./config.ts`'s trust boundary
 * ({@link isTrustedServiceEndpoint}) to the endpoint it was handed: a
 * non-loopback endpoint disables the transport outright, so no batch and no
 * `Authorization` header is ever sent to it, and redirects are refused rather
 * than followed so an answer cannot move a credentialed request somewhere the
 * check did not cover.
 *
 * @example Wiring it into the provider
 * ```ts
 * const processor = new DebuggenSpanProcessor({ gate: control, config, logger });
 * const provider = new NodeTracerProvider({ resource, spanProcessors: [processor] });
 * provider.register();
 * ```
 */

import type { Logger } from '@debuggen/shared';
import type { Context, Span } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

import type { TelemetryEventIngress } from '../schema/event.js';
import { QUERY_KINDS } from '../schema/kinds.js';
import type { TelemetryKind } from '../schema/kinds.js';
import {
  BATCH_FLUSH_INTERVAL_MS,
  BATCH_MAX_EVENTS,
  createPreloadLogger,
  INGEST_TIMEOUT_MS,
  isTrustedServiceEndpoint,
  MAX_BUFFERED_EVENTS,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
} from './config.js';
import type { PreloadConfig } from './config.js';
import {
  classifyDatabaseSource,
  classifySpan,
  createSeqAllocator,
  spanToIngressEvent,
} from './convert.js';
import type { ConvertContext, DatabaseSpanSource, SeqAllocator } from './convert.js';

/*
 * ---------------------------------------------------------------------------
 * Derived tunables
 *
 * `./config.ts` owns the vocabulary — batch size, flush interval, buffer cap,
 * ingest timeout, backoff envelope. The three constants below are *derived*
 * from it rather than invented, so a change to the envelope moves them too and
 * no number in this file stands on its own.
 * ---------------------------------------------------------------------------
 */

/**
 * Attempts one batch gets before it is dropped.
 *
 * Derived, not chosen: a batch may hold the drain for about the backoff
 * ceiling's worth of attempts and no longer, so the budget is
 * {@link RECONNECT_MAX_MS} measured in {@link INGEST_TIMEOUT_MS} units, plus
 * the first attempt. With the pinned 10 s ceiling and 5 s timeout that is three
 * attempts, whose backoff waits ({@link RECONNECT_MIN_MS} then twice it) add up
 * to one and a half seconds — enough to ride out the service restarting under
 * the developer's hands.
 *
 * Deliberately not the full 0.5 s → 10 s envelope: a service that has been away
 * longer than this is the control socket's problem to notice, and newer
 * evidence should not sit behind older evidence that cannot be delivered.
 */
export const MAX_POST_ATTEMPTS = Math.ceil(RECONNECT_MAX_MS / INGEST_TIMEOUT_MS) + 1;

/**
 * Batches one drain will post before it returns, even if events keep arriving.
 *
 * A full buffer's worth plus one. Without a cap, a drain on a busy server could
 * keep finding new events and never return, which would make `forceFlush()` a
 * promise that does not settle. With it, a drain always terminates and anything
 * that arrived meanwhile is picked up by the next flush window.
 */
export const MAX_DRAIN_BATCHES = Math.ceil(MAX_BUFFERED_EVENTS / BATCH_MAX_EVENTS) + 1;

/**
 * Milliseconds the final flush in {@link DebuggenSpanProcessor.shutdown} may
 * take in total.
 *
 * One ingest timeout for the whole shutdown, not per batch: the host is tearing
 * its tracer provider down and may be on its way out of the process, so the
 * remaining evidence is worth one best-effort attempt and no more. Anything
 * still buffered when the deadline passes is abandoned and counted.
 */
export const SHUTDOWN_FLUSH_DEADLINE_MS = INGEST_TIMEOUT_MS;

/**
 * HTTP statuses that are worth another attempt even though they are `4xx`.
 *
 * `408 Request Timeout` and `429 Too Many Requests` describe a moment, not the
 * batch; every other client error says the batch or the credential will not
 * become acceptable by being sent again.
 */
const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 429]);

/**
 * Statuses that mean the credential was refused.
 *
 * Separated from the rest of the `4xx` family because they earn a developer a
 * specific hint — the one thing they can act on — and because they must never
 * be retried in a loop against an endpoint that has already said no.
 */
const AUTH_REJECTED_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/*
 * ---------------------------------------------------------------------------
 * Contracts
 * ---------------------------------------------------------------------------
 */

/**
 * The capture state this processor enforces, as the narrowest interface that
 * expresses it.
 *
 * `./control.ts` owns capture state and implements this; the processor receives
 * it through the constructor and never imports it. The direction is structural,
 * not stylistic: `control.ts` → `exporter.ts` and never the reverse, so the
 * `src/node` import graph stays acyclic and a test can supply a two-line fake.
 */
export interface CaptureGate {
  /**
   * The active capture window's id, or `null` when no session has armed this
   * process.
   *
   * Read on every `onEnd`, so it must be a cheap property access — the gate's
   * job is to keep it current, not to compute it on demand. `null` is the drop
   * rule: no capture, no telemetry.
   */
  readonly captureId: string | null;

  /**
   * A counter the gate advances every time it opens a capture window.
   *
   * The reason it exists: an ingest event carries **no capture id** — the
   * service assigns `sessionId`, `captureId` and `ingestSeq` when it receives
   * the batch (module documentation, AAP §0.2.3) — so an event posted after
   * the service has moved on to capture B is *stored under B*, whatever
   * capture the work belonged to. Comparing {@link captureId} at `onEnd` does
   * not catch it either: a span that started inside capture A and ends after B
   * was armed reads B's id, because that is the only id there is by then.
   *
   * So the processor stamps the generation on every span it sees start and
   * rejects a span whose stamp is not the generation in force when it ends
   * ({@link DebuggenSpanProcessorStats.droppedStaleCapture}). The value is
   * meaningful only by inequality; its absolute magnitude says nothing.
   *
   * Optional so a two-line fake gate stays a two-line fake gate: a gate that
   * does not track generations gets no stale detection, which is the honest
   * degradation for something that never transitions between captures. The
   * real gate — `./control.ts` — always supplies it.
   */
  readonly captureGeneration?: number | undefined;

  /**
   * Whether the capture wants events of this kind.
   *
   * Asked once per span, after the capture check and before any conversion. A
   * plan that plans no database tracing answers `false` for `db.query`, and the
   * span is dropped rather than converted, stored or posted.
   *
   * The kind is the coarse axis, and a gate that implements
   * {@link admitSpan} refines it: this method is the fallback the processor
   * uses when the gate does not.
   *
   * @param kind The kind `./convert.ts` classified the span as.
   */
  isKindEnabled(kind: TelemetryKind): boolean;

  /**
   * Whether the capture wants *this span*, with the reason when it does not.
   *
   * The kind alone cannot answer the question for two of the signals
   * `server-agent.config` carries. `prisma` and `pg` are independent switches
   * over one kind (`db.query`), and `functions` is a list of the exact symbols
   * the plan patched rather than a switch at all (AAP §0.4.2), so admitting a
   * span by kind would collect the driver's queries for a plan that asked only
   * for the ORM's, and every `function` span in the process for a plan that
   * named one symbol. This method is where those two axes are enforced, and
   * the verdict says which one refused so the drop is countable rather than
   * silent.
   *
   * Optional for the same reason as {@link captureGeneration}: a gate that
   * implements only {@link isKindEnabled} keeps the kind-level behaviour.
   *
   * @param candidate The classified kind plus the span facts the finer rules
   * need.
   * @returns `'admitted'`, or the rule that refused the span.
   */
  admitSpan?(candidate: SpanAdmissionCandidate): SpanAdmission;
}

/**
 * The facts {@link CaptureGate.admitSpan} judges a span on.
 *
 * Deliberately not the span itself: the gate lives in `./control.ts`, which
 * owns capture *policy* and has no business reading a `ReadableSpan`'s getters
 * (any of which may throw on a foreign span). The processor reads them once,
 * inside its own guard, and passes values.
 */
export interface SpanAdmissionCandidate {
  /** The kind `./convert.ts` classified the span as. */
  readonly kind: TelemetryKind;

  /**
   * The span's display name, or `''` when it has none.
   *
   * For a `function` span this is the patched symbol's name, which is what the
   * plan's `functions` list holds.
   */
  readonly name: string;

  /**
   * Which instrumentation produced a database span, or `null` for every other
   * kind and for a database span whose producer cannot be told.
   */
  readonly source: DatabaseSpanSource | null;

  /**
   * The span's attributes, guarded to a plain object.
   *
   * Carried so the gate can read a patch's own identity — the `symbol`
   * attribute `../schema/attributes.ts` declares for the `function` kind —
   * without this module deciding which key means what.
   */
  readonly attributes: Readonly<Record<string, unknown>>;
}

/**
 * The verdict of {@link CaptureGate.admitSpan}.
 *
 * One member per drop rule, so each refusal lands on its own counter in
 * {@link DebuggenSpanProcessorStats} and a test can tell "the capture did not
 * want this kind" from "the capture wanted the other database library".
 */
export type SpanAdmission =
  /** The capture wants the span. */
  | 'admitted'
  /** No capture is armed; the gate closed between the two reads. */
  | 'no-capture'
  /** The capture's plan asked for no signal that admits this kind. */
  | 'kind-disabled'
  /** A database span from the library this capture did not ask for. */
  | 'source-disabled'
  /** A `function` span whose symbol is not one this plan patched. */
  | 'unplanned-function';

/** Everything {@link DebuggenSpanProcessor} takes; only two members are required. */
export interface DebuggenSpanProcessorOptions {
  /** The capture gate whose state the processor enforces. */
  readonly gate: CaptureGate;

  /**
   * The validated launch configuration from `./config.ts`: the ingest endpoint,
   * the credential, the project root and this process's producer id.
   */
  readonly config: PreloadConfig;

  /**
   * Where this module's diagnostics go.
   *
   * Defaults to `createPreloadLogger()`, which is quiet (`warn`) unless the
   * developer sets `DEBUGGEN_LOG_LEVEL`; `register.ts` passes its own so every
   * preload line shares one prefix and one threshold.
   */
  readonly logger?: Logger | undefined;

  /**
   * The `fetch` implementation to post with, defaulting to the global one.
   *
   * Injectable so `./control.test.ts` can assert the request shape — URL,
   * headers, body — and the failure paths without a network or a service. It is
   * captured once, in the constructor, so a suite that replaces the global
   * afterwards does not change this instance's behaviour.
   */
  readonly fetchImpl?: typeof fetch | undefined;

  /**
   * The `[0, 1)` source {@link computeIngestBackoffMs} draws its jitter from,
   * defaulting to `Math.random`.
   *
   * Injectable for the same reason the `fetch` is: a suite asserting the retry
   * path should not have to wait on a randomised delay, and one asserting the
   * envelope should be able to pin it to either extreme.
   */
  readonly random?: (() => number) | undefined;
}

/**
 * A snapshot of everything the processor counts.
 *
 * The names are a contract with `./control.test.ts`, which asserts the drop
 * rules through them, so they are stable: add a counter rather than rename one.
 * Every number is cumulative over the processor's life — it is constructed once
 * by `register.ts` and survives every enable/disable cycle — except
 * {@link buffered}, which is the current queue depth.
 */
export interface DebuggenSpanProcessorStats {
  /**
   * Spans seen by `onStart`.
   *
   * The cheap observability the disable path is judged by: after a capture is
   * disabled and the provider un-registered, no span is *created*, so this
   * number stops moving (AAP §0.5.1).
   */
  readonly onStartCount: number;

  /** Spans seen by `onEnd`, whatever became of them. */
  readonly endedCount: number;

  /** Spans converted into events and enqueued. */
  readonly convertedCount: number;

  /** Spans dropped by the first rule: no capture was active. */
  readonly droppedNoCapture: number;

  /** Spans dropped by the second rule: the capture disabled that kind. */
  readonly droppedByKind: number;

  /**
   * Spans dropped because they belong to a capture that has since been
   * replaced.
   *
   * A span that started inside capture A and ended after capture B was armed.
   * Its work is A's, an ingest event carries no capture id, and the service
   * attributes what it receives to the capture that is active when it arrives —
   * so exporting it would file A's evidence under B. `./control.ts` flushes A
   * before it arms B, which is what gets A's *finished* spans out in time;
   * this counter is the ones that were still running.
   */
  readonly droppedStaleCapture: number;

  /**
   * Database spans dropped because the capture asked for the other library.
   *
   * `prisma` and `pg` are independent switches over one kind, so a plan that
   * asked for ORM tracing collects no driver spans even though both
   * instrumentations may be installed.
   */
  readonly droppedBySource: number;

  /**
   * `function` spans dropped because their symbol is not one this plan
   * patched.
   *
   * Non-zero means a patched function from outside the active plan is still
   * running in the process — an earlier session's patch that was never
   * reverted, or a plan version that has since been narrowed.
   */
  readonly droppedUnplannedFunction: number;

  /**
   * Spans the conversion declined to emit.
   *
   * Either unclassifiable (`classifySpan` returned `null`) or rejected during
   * conversion — an unusable trace id, an implausible timestamp, a foreign span
   * whose own getters threw.
   */
  readonly droppedUnconvertible: number;

  /** Events discarded from the front of the buffer because it was at its cap. */
  readonly droppedOverflow: number;

  /**
   * Events lost because their batch could not be serialised to JSON.
   *
   * Should be zero: `./convert.ts` produces JSON-safe objects. Counted rather
   * than assumed, because the alternative to noticing is a batch that silently
   * never arrives.
   */
  readonly droppedUnserializable: number;

  /** Events lost with a batch that exhausted {@link MAX_POST_ATTEMPTS}. */
  readonly droppedFailedBatch: number;

  /** Spans that reached `onEnd` after `shutdown()` completed. */
  readonly droppedAfterShutdown: number;

  /** Events still buffered when the shutdown flush ran out of its deadline. */
  readonly droppedAtShutdown: number;

  /** Batches the service accepted with a `2xx`. */
  readonly postedBatches: number;

  /** Events inside those batches. */
  readonly postedEvents: number;

  /** Batches abandoned after every permitted attempt failed. */
  readonly failedBatches: number;

  /**
   * Unexpected failures caught inside the processor — a gate that threw, a
   * logger that threw, a drain that broke.
   *
   * Non-zero means a bug in this module or in something it was handed, not a
   * transport problem. It never reaches the host process as an exception.
   */
  readonly internalErrors: number;

  /** Events currently queued, waiting for a flush. */
  readonly buffered: number;
}

/*
 * ---------------------------------------------------------------------------
 * Module-private helpers
 *
 * Each is total: it answers for any input and throws for none. They run on
 * stacks belonging to the developer's application or to a timer callback,
 * where a throw has nobody to catch it.
 * ---------------------------------------------------------------------------
 */

/**
 * Drop a timer's claim on the event loop, where the runtime has such a notion.
 *
 * Node's timer handles carry `unref`; a browser's (and a test double's) may be
 * a bare number. The capability check is what lets one code path serve both,
 * which this package's tsconfig requires of every cross-runtime module — and
 * it is why a fake-timer suite cannot crash the flush path.
 *
 * @param timer A handle from `setTimeout`.
 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  try {
    const view: { unref?: () => void } = timer;
    if (typeof view.unref === 'function') {
      view.unref();
    }
  } catch {
    // A host whose handle refuses the call keeps its reference; the process may
    // then wait up to one flush interval longer, which is not worth a throw.
  }
}

/**
 * Wait `ms` milliseconds on an `unref`'d timer.
 *
 * Used between post attempts. `unref` matters as much here as it does for the
 * flush timer: a backoff in progress must not be the reason a dev server that
 * has finished its work stays alive.
 *
 * @param ms Delay in milliseconds.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    unrefTimer(timer);
  });
}

/**
 * The delay before attempt `attempt` (1-based), doubling from
 * {@link RECONNECT_MIN_MS}, jittered by ±25 %, and clamped into
 * `[RECONNECT_MIN_MS, RECONNECT_MAX_MS]`.
 *
 * The jitter is the point of the function. A developer restarting the local
 * service has every attached dev server fail its next batch at once, and a
 * deterministic envelope then has all of them retry in lockstep — the same
 * thundering herd on the service's first breath that `control.ts`'s
 * `computeReconnectDelayMs` spreads, with the same ±25 % window, so the two
 * outbound paths of one process do not synchronise with each other either.
 *
 * Exported with an injectable source of randomness so a suite can assert the
 * envelope at both extremes rather than sampling it; the processor passes the
 * source from its own options.
 *
 * @param attempt The attempt that just failed, 1-based.
 * @param random A `[0, 1)` source; defaults to `Math.random`.
 * @returns A delay in whole milliseconds, within the envelope.
 */
export function computeIngestBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 1 ? Math.floor(attempt) : 1;
  // Capping the exponent keeps the arithmetic finite; 2 ** 31 is already far
  // beyond the ceiling the result is clamped to.
  const exponent = Math.min(safeAttempt - 1, 31);
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** exponent);

  const sample = random();
  const factor = Number.isFinite(sample) ? 0.75 + Math.min(Math.max(sample, 0), 1) * 0.5 : 1;
  const jittered = Math.round(base * factor);

  return Math.min(Math.max(jittered, RECONNECT_MIN_MS), RECONNECT_MAX_MS);
}

/**
 * The host of an endpoint, for a diagnostic, with no credential in it.
 *
 * `URL.host` is host and port only — never userinfo — so this is safe to print
 * even for an endpoint that failed {@link isTrustedServiceEndpoint} and
 * therefore carries none of `./config.ts`'s guarantees. A value that will not
 * parse is described rather than echoed, because an unparseable endpoint is
 * arbitrary text this module has no business putting in a terminal.
 *
 * @param value The endpoint as configured.
 * @returns The host, or a fixed placeholder.
 */
function endpointHostForDiagnostics(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return '(unparseable)';
  }
}

/**
 * Describe a thrown value in one short, value-free-ish line.
 *
 * An `Error`'s name and message are the useful part and the endpoint they may
 * quote carries no credentials (`./config.ts` refuses one that does). Anything
 * else is described by its type only: a thrown object may be anything at all,
 * and stringifying it could both fail and quote the host's data.
 *
 * @param error The caught value.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.length > 0 ? error.message : error.name;
    return `${error.name}: ${message}`;
  }
  return `non-error value of type ${typeof error}`;
}

/**
 * The span's display name, or `''` when it has none.
 *
 * Guarded because the span may be foreign — a span from an instrumentation
 * this build has never seen, or a test double — and a getter that throws or a
 * name that is not a string must become a value the gate can compare, never an
 * exception on the host's span pipeline.
 *
 * @param span The span being judged.
 */
function readSpanDisplayName(span: ReadableSpan): string {
  const name: unknown = span.name;
  return typeof name === 'string' ? name : '';
}

/**
 * The span's attribute bag, guarded to a plain object.
 *
 * An array or a primitive under `attributes` becomes an empty bag rather than
 * something the gate has to defend itself against.
 *
 * @param span The span being judged.
 */
function readSpanAttributes(span: ReadableSpan): Readonly<Record<string, unknown>> {
  const attributes: unknown = span.attributes;
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
    return EMPTY_ATTRIBUTES;
  }
  return attributes as Readonly<Record<string, unknown>>;
}

/** The bag {@link readSpanAttributes} answers with when a span has none. */
const EMPTY_ATTRIBUTES: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * Release a response body so the underlying socket can be reused.
 *
 * This module never reads a response: the status is the whole answer, and an
 * error body from the service could quote a path or a message this module has
 * no business logging. An unconsumed body, however, keeps its connection
 * checked out until the garbage collector notices, so it is cancelled
 * explicitly.
 *
 * @param response The settled response.
 */
async function releaseResponseBody(response: Response): Promise<void> {
  try {
    const body: ReadableStream<Uint8Array> | null = response.body;
    if (body !== null && !body.locked) {
      await body.cancel();
    }
  } catch {
    // Already consumed, already cancelled, or a response double with no stream.
  }
}

/**
 * How hard a drain tries.
 *
 * `normal` is the everyday path: a batch gets {@link MAX_POST_ATTEMPTS}
 * attempts over the backoff envelope. `final` belongs to `shutdown()`: one
 * attempt per batch and no waiting, because the whole flush is bounded by
 * {@link SHUTDOWN_FLUSH_DEADLINE_MS} and the host is on its way out.
 */
type DrainMode = 'normal' | 'final';

/**
 * What one post attempt concluded.
 *
 * Three outcomes rather than a boolean, because "failed" splits into two
 * different decisions: `retry` is a moment worth repeating, `permanent` is an
 * answer that will not change by being asked again — a refused credential, a
 * batch the service will not accept — and repeating it would only spend the
 * developer's time and fill their terminal.
 */
type PostOutcome = 'sent' | 'retry' | 'permanent';

/**
 * What became of one batch, as the drain needs to account for it.
 *
 * Three outcomes so the counters stay disjoint: a batch that could not be
 * serialised loses its events to {@link DebuggenSpanProcessorStats.droppedUnserializable},
 * one the service never accepted loses them to
 * {@link DebuggenSpanProcessorStats.droppedFailedBatch}, and a summed total
 * would hide which of the two happened — the first is a defect in this
 * repository, the second is the developer's service being away.
 */
type BatchOutcome = 'sent' | 'failed' | 'unserializable';

/**
 * What `onStart` records about the capture a span was started in.
 *
 * Both members are needed. The generation is what detects a replacement, since
 * it changes on every arming; the capture id is what detects a span started
 * while the gate was shut (`null`) and is the id the event's sequence is
 * scoped to, so the number a span is given belongs to the capture it ran in.
 */
interface SpanCaptureStamp {
  /** The capture armed when the span started, or `null` if none was. */
  readonly captureId: string | null;
  /** The gate's generation at that moment, or `undefined` if it tracks none. */
  readonly generation: number | undefined;
}

/**
 * Stand-in written wherever a diagnostic might otherwise have quoted the
 * credential.
 *
 * Nothing in this module interpolates the token into a message, so this is the
 * second line of defence: a foreign error text that happened to contain it is
 * scrubbed before it reaches a sink.
 */
const REDACTED_PLACEHOLDER = '[redacted]';

/*
 * ---------------------------------------------------------------------------
 * The processor
 * ---------------------------------------------------------------------------
 */

/**
 * The span processor the preload installs: gate enforcement, conversion,
 * batching and the ingest POST, in one object.
 *
 * Constructed **once**, by `register.ts`, and handed to the tracer provider —
 * OpenTelemetry's SDK 2.x takes span processors at construction, so this
 * instance outlives every capture the session runs. Its buffer, its sequence
 * allocator and its counters are therefore written to tolerate any number of
 * enable/disable transitions: nothing here is reset between captures, and the
 * `(producerId, captureId)`-scoped sequence restarts itself when the gate's
 * capture id changes.
 *
 * Thread-safety is not a concern (one event loop), but *re-entrancy* is: a
 * flush is asynchronous while `onEnd` is synchronous, so a span can arrive
 * mid-post. That is why the buffer and the in-flight batch are separate arrays
 * and why drains are serialised on a promise chain.
 *
 * @example Driving it from a test
 * ```ts
 * const gate = { captureId: 'cap_1', isKindEnabled: () => true };
 * const processor = new DebuggenSpanProcessor({ gate, config, fetchImpl: fake });
 * processor.onEnd(span);
 * expect(processor.bufferedCount).toBe(1);
 * await processor.forceFlush();
 * expect(processor.stats().postedBatches).toBe(1);
 * ```
 */
export class DebuggenSpanProcessor implements SpanProcessor {
  /** The capture gate whose state every `onEnd` consults. */
  readonly #gate: CaptureGate;

  /** The launch configuration: endpoint, credential, project root, producer id. */
  readonly #config: PreloadConfig;

  /** Where diagnostics go; every write goes through {@link DebuggenSpanProcessor.#log}. */
  readonly #logger: Logger;

  /** The `fetch` captured at construction, global or injected. */
  readonly #fetchImpl: typeof fetch;

  /**
   * Whether this processor may post at all: a callable `fetch` **and** an
   * endpoint the credential is allowed to reach.
   */
  readonly #transportAvailable: boolean;

  /** The jitter source {@link computeIngestBackoffMs} is called with. */
  readonly #random: () => number;

  /**
   * This processor's `(producerId, captureId)`-scoped sequence.
   *
   * Owned rather than borrowed from `./convert.ts`'s module default, because
   * this instance also supplies the producer id: `convert.ts` documents that a
   * caller overriding one must override the other, since a sequence belongs to
   * the pair and not to the module. Owning it also keeps two processors in one
   * test from numbering each other's events.
   */
  readonly #seq: SeqAllocator;

  /**
   * The capture each span was started in, keyed on the span object itself.
   *
   * The SDK hands the same object to `onStart` and to `onEnd` — it is one
   * `Span` implementing `ReadableSpan` — so the key is available at both ends
   * without touching the span's own state. A `WeakMap` because the entry must
   * not outlive the span: this processor lives for the whole dev-server
   * process, and a `Map` here would be an unbounded leak keyed on every span
   * the developer's application ever created.
   */
  readonly #stamps = new WeakMap<object, SpanCaptureStamp>();

  /** Converted events waiting for a flush; the oldest is at index 0. */
  readonly #buffer: TelemetryEventIngress[] = [];

  /** The armed flush timer, or `undefined` when none is pending. */
  #flushTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * The drain chain: every requested drain runs after the previous one.
   *
   * It never rejects, because `#drain` catches everything, so nothing needs to
   * attach a handler to it to keep the process quiet.
   */
  #chain: Promise<void> = Promise.resolve();

  /** Set the moment `shutdown()` starts, so nothing arms a new timer after it. */
  #shuttingDown = false;

  /** Set when `shutdown()` has finished; later spans are counted and dropped. */
  #shutdownComplete = false;

  /** Overflow drops not yet mentioned in a warning — one warning per flush window. */
  #overflowSinceWarning = 0;

  /** Whether the credential hint has been written for the current failure streak. */
  #authHintLogged = false;

  /** {@link DebuggenSpanProcessorStats.onStartCount} */
  #onStartCount = 0;

  /** {@link DebuggenSpanProcessorStats.endedCount} */
  #endedCount = 0;

  /** {@link DebuggenSpanProcessorStats.convertedCount} */
  #convertedCount = 0;

  /** {@link DebuggenSpanProcessorStats.droppedNoCapture} */
  #droppedNoCapture = 0;

  /** {@link DebuggenSpanProcessorStats.droppedByKind} */
  #droppedByKind = 0;

  /** {@link DebuggenSpanProcessorStats.droppedStaleCapture} */
  #droppedStaleCapture = 0;

  /** {@link DebuggenSpanProcessorStats.droppedBySource} */
  #droppedBySource = 0;

  /** {@link DebuggenSpanProcessorStats.droppedUnplannedFunction} */
  #droppedUnplannedFunction = 0;

  /** {@link DebuggenSpanProcessorStats.droppedUnconvertible} */
  #droppedUnconvertible = 0;

  /** {@link DebuggenSpanProcessorStats.droppedOverflow} */
  #droppedOverflow = 0;

  /** {@link DebuggenSpanProcessorStats.droppedUnserializable} */
  #droppedUnserializable = 0;

  /** {@link DebuggenSpanProcessorStats.droppedFailedBatch} */
  #droppedFailedBatch = 0;

  /** {@link DebuggenSpanProcessorStats.droppedAfterShutdown} */
  #droppedAfterShutdown = 0;

  /** {@link DebuggenSpanProcessorStats.droppedAtShutdown} */
  #droppedAtShutdown = 0;

  /** {@link DebuggenSpanProcessorStats.postedBatches} */
  #postedBatches = 0;

  /** {@link DebuggenSpanProcessorStats.postedEvents} */
  #postedEvents = 0;

  /** {@link DebuggenSpanProcessorStats.failedBatches} */
  #failedBatches = 0;

  /** {@link DebuggenSpanProcessorStats.internalErrors} */
  #internalErrors = 0;

  /**
   * @param options The capture gate and launch configuration, plus an optional
   * logger and `fetch` implementation.
   */
  constructor(options: DebuggenSpanProcessorOptions) {
    this.#gate = options.gate;
    this.#config = options.config;
    this.#logger = options.logger ?? createPreloadLogger();
    this.#seq = createSeqAllocator();
    this.#random = options.random ?? Math.random;

    const resolvedFetch: typeof fetch = options.fetchImpl ?? globalThis.fetch;
    this.#fetchImpl = resolvedFetch;
    // A host without `fetch` is not a shape Node 24 has, but a bundled preload
    // can be loaded anywhere. Establishing it once means a missing transport
    // costs one warning rather than the full backoff envelope per batch.
    const fetchAvailable = typeof resolvedFetch === 'function';

    // The trust boundary, re-checked here rather than assumed. `./config.ts`
    // refuses a non-loopback endpoint, so a configuration that came from
    // `loadPreloadConfig` always passes — but this constructor takes a
    // `PreloadConfig` the caller supplies, and the credential on it is the
    // process-scoped server-agent bearer (AAP §0.5.6). One check here means no
    // path through this class can post that credential, or the developer's
    // telemetry, to an origin off this machine.
    const endpointTrusted = isTrustedServiceEndpoint(options.config.ingestUrl);

    this.#transportAvailable = fetchAvailable && endpointTrusted;
    if (!fetchAvailable) {
      this.#log('warn', 'no fetch implementation is available; server telemetry will be dropped');
    } else if (!endpointTrusted) {
      // The host, never the URL: an endpoint that failed the check carries none
      // of `./config.ts`'s guarantees, including the one about userinfo.
      this.#log(
        'warn',
        'the telemetry ingest endpoint is not a loopback address; no telemetry and no credential will be sent',
        { host: endpointHostForDiagnostics(options.config.ingestUrl) },
      );
    }
  }

  /**
   * Spans seen by `onStart` — the counter the disable path is judged by.
   *
   * A getter as well as a member of {@link stats}, because "did anything even
   * start recording?" is the single most common assertion about this processor
   * and it should not need a snapshot.
   */
  get onStartCount(): number {
    return this.#onStartCount;
  }

  /**
   * Events currently queued.
   *
   * Exposed so a test can assert that a dropped span enqueued *nothing*,
   * without flushing and therefore without needing a transport at all.
   */
  get bufferedCount(): number {
    return this.#buffer.length;
  }

  /** Whether `shutdown()` has completed. */
  get isShutDown(): boolean {
    return this.#shutdownComplete;
  }

  /**
   * A frozen snapshot of every counter.
   *
   * Frozen and copied, so a caller holding one is holding the numbers as they
   * were — a live view would make an assertion about "before the flush"
   * impossible to write.
   */
  stats(): DebuggenSpanProcessorStats {
    return Object.freeze({
      onStartCount: this.#onStartCount,
      endedCount: this.#endedCount,
      convertedCount: this.#convertedCount,
      droppedNoCapture: this.#droppedNoCapture,
      droppedByKind: this.#droppedByKind,
      droppedStaleCapture: this.#droppedStaleCapture,
      droppedBySource: this.#droppedBySource,
      droppedUnplannedFunction: this.#droppedUnplannedFunction,
      droppedUnconvertible: this.#droppedUnconvertible,
      droppedOverflow: this.#droppedOverflow,
      droppedUnserializable: this.#droppedUnserializable,
      droppedFailedBatch: this.#droppedFailedBatch,
      droppedAfterShutdown: this.#droppedAfterShutdown,
      droppedAtShutdown: this.#droppedAtShutdown,
      postedBatches: this.#postedBatches,
      postedEvents: this.#postedEvents,
      failedBatches: this.#failedBatches,
      internalErrors: this.#internalErrors,
      buffered: this.#buffer.length,
    });
  }

  /**
   * Count a started span and return.
   *
   * This hook runs inside the developer's own request path, on a span that is
   * not evidence yet — a span carries no duration, status or attributes until
   * it ends — so counting is the whole of the work. It is also the cheapest
   * possible observation of "is this process recording at all", which is
   * exactly what the disable path has to be able to prove (AAP §0.5.1).
   *
   * @param span The span that just started.
   * @param parentContext The context it was started in.
   */
  onStart(span: Span, parentContext: Context): void {
    this.#onStartCount += 1;

    // Which capture the span belongs to is decided *here*, not when it ends.
    // A span outlives the moment it started — a slow query, a route handler
    // awaiting an external call — and by the time it ends the gate may hold a
    // different capture, at which point nothing about the span says which one
    // it ran in. Recording the answer costs one `WeakMap` write on a path that
    // is already inside the developer's request, and it is the only thing that
    // keeps capture A's work out of capture B's evidence.
    try {
      this.#stamps.set(span, {
        captureId: this.#gate.captureId,
        generation: this.#gate.captureGeneration,
      });
    } catch (error) {
      // A gate getter that threw, or a span object a `WeakMap` refuses as a
      // key. The span simply goes unstamped and is judged by the gate's
      // current state at `onEnd`, exactly as one started before this processor
      // existed is.
      this.#internalErrors += 1;
      this.#log('debug', 'a started span could not be stamped with its capture', {
        error: describeError(error),
      });
    }

    // The interface's signature, and the parent context is not needed to stamp.
    // Referenced explicitly so the signature can stay exact under a lint gate
    // that reports unused parameters; the statement compiles away.
    void parentContext;
  }

  /**
   * Apply the two drop rules, convert what survives, and enqueue it.
   *
   * Called synchronously by the host's span pipeline. It never throws, never
   * awaits and never posts: the most it does inline is push onto an array and,
   * when the array is full, hand a drain to the microtask queue.
   *
   * @param span The span that just ended.
   */
  onEnd(span: ReadableSpan): void {
    try {
      this.#endedCount += 1;

      if (this.#shutdownComplete) {
        this.#droppedAfterShutdown += 1;
        return;
      }

      // Rule 1 - no capture, no telemetry. First because it is one property
      // read and it is the rule that makes an unarmed dev server silent.
      const captureId = this.#gate.captureId;
      if (captureId === null) {
        this.#droppedNoCapture += 1;
        return;
      }

      // Rule 2 - the span must belong to the capture that is current. Ahead of
      // classification because it is two comparisons and because it is the
      // rule that keeps one capture's evidence out of another's: the event
      // carries no capture id of its own, so whatever is exported now is
      // filed under whatever the service has armed now.
      const stamp = this.#stamps.get(span);
      if (stamp !== undefined && this.#isStaleStamp(stamp, captureId)) {
        this.#droppedStaleCapture += 1;
        return;
      }

      // Rule 3 - the capture decides which signals it wants. Classification is
      // cheap (attributes, name, scope) and strictly less work than a full
      // conversion, so a disabled kind never pays for one.
      const classification = classifySpan(span);
      if (classification === null) {
        this.#droppedUnconvertible += 1;
        return;
      }
      if (!this.#admit(span, classification.kind)) {
        return;
      }

      const context: ConvertContext = {
        // The capture the span *ran in*, which the stale check has just proved
        // is the current one — stated through the stamp where there is one so
        // the sequence a span is numbered in cannot belong to another capture.
        captureId: stamp?.captureId ?? captureId,
        producerId: this.#config.producerId,
        seq: this.#seq,
      };
      const event = spanToIngressEvent(span, context);
      if (event === null) {
        this.#droppedUnconvertible += 1;
        return;
      }

      this.#convertedCount += 1;
      this.#enqueue(event);
    } catch (error) {
      // A gate whose getter threw, or an array that refused a push. Counted,
      // logged at debug, and absolutely not raised into the application.
      this.#internalErrors += 1;
      this.#log('debug', 'span was dropped by an internal failure', {
        error: describeError(error),
      });
    }
  }

  /**
   * Whether a span's stamp names a capture other than the one in force.
   *
   * Two independent comparisons, because they catch different things. The
   * capture id catches the ordinary replacement — a span that started in A and
   * ends once B is armed, or one that started while the gate was shut and ends
   * inside a capture. The generation catches a capture arming *twice* under the
   * same id, which the id alone cannot distinguish: a disable and a re-arm in
   * between mean the earlier span's work belongs to a window the service has
   * already closed.
   *
   * A gate that tracks no generation ({@link CaptureGate.captureGeneration} is
   * optional) is judged by the capture id alone.
   *
   * @param stamp What `onStart` recorded for this span.
   * @param captureId The capture armed now, already known to be non-`null`.
   */
  #isStaleStamp(stamp: SpanCaptureStamp, captureId: string): boolean {
    if (stamp.captureId !== captureId) {
      return true;
    }
    const generation = this.#gate.captureGeneration;
    return (
      stamp.generation !== undefined && generation !== undefined && stamp.generation !== generation
    );
  }

  /**
   * Ask the gate for this span, count the refusal, and answer whether to
   * convert it.
   *
   * The kind is one axis and it is not sufficient on its own: `prisma` and
   * `pg` are independent switches over the single `db.query` kind, and
   * `functions` names exact symbols rather than switching a kind on, so the
   * gate is offered the span's facts and returns which rule applies. A gate
   * that implements only {@link CaptureGate.isKindEnabled} keeps the
   * kind-level behaviour, which is what a minimal fake gets.
   *
   * The facts are read here rather than in the gate: reading them is what can
   * throw on a foreign span, and this method runs inside `onEnd`'s guard.
   *
   * @param span The span that ended.
   * @param kind The kind `./convert.ts` classified it as.
   * @returns `true` to convert and enqueue it.
   */
  #admit(span: ReadableSpan, kind: TelemetryKind): boolean {
    const gate = this.#gate;
    if (typeof gate.admitSpan !== 'function') {
      if (gate.isKindEnabled(kind)) {
        return true;
      }
      this.#droppedByKind += 1;
      return false;
    }

    const candidate: SpanAdmissionCandidate = {
      kind,
      name: readSpanDisplayName(span),
      // Only a database span has a source to tell, and telling it costs a
      // scope read and two string comparisons, so it is not paid for the
      // request and render spans that make up most of a capture.
      source: QUERY_KINDS.includes(kind) ? classifyDatabaseSource(span) : null,
      attributes: readSpanAttributes(span),
    };

    switch (gate.admitSpan(candidate)) {
      case 'admitted':
        return true;
      case 'source-disabled':
        this.#droppedBySource += 1;
        return false;
      case 'unplanned-function':
        this.#droppedUnplannedFunction += 1;
        return false;
      case 'no-capture':
        // The gate closed between the capture read at the top of `onEnd` and
        // this call. Counted as what it is rather than as a kind refusal.
        this.#droppedNoCapture += 1;
        return false;
      default:
        // `'kind-disabled'`, and any verdict a newer gate invents: a span the
        // capture did not ask for is dropped, never admitted by default.
        this.#droppedByKind += 1;
        return false;
    }
  }

  /**
   * Post everything currently buffered and resolve when it has settled.
   *
   * Chained behind any drain already in progress, so it reflects the buffer as
   * it stands when its turn comes — which is what a caller flushing before an
   * assertion, or the provider flushing before shutdown, means by "flush".
   * Resolves even when every batch failed: the promise reports completion, and
   * {@link stats} reports the outcome.
   */
  async forceFlush(): Promise<void> {
    try {
      await this.#requestDrain(this.#shuttingDown ? 'final' : 'normal');
    } catch (error) {
      // `#drain` catches its own failures, so this is unreachable in practice
      // and still handled: a rejected `forceFlush()` inside the provider's
      // flush path would surface as an unhandled rejection in the host.
      this.#internalErrors += 1;
      this.#log('debug', 'flush failed', { error: describeError(error) });
    }
  }

  /**
   * Stop the timer, make one bounded attempt at the remaining evidence, and
   * resolve.
   *
   * Called by the provider's own shutdown, which the host may be awaiting on
   * its way out of the process, so it is deliberately impatient: single-attempt
   * posts, no backoff, and the whole flush bounded by
   * {@link SHUTDOWN_FLUSH_DEADLINE_MS}. Anything still queued afterwards is
   * abandoned and counted rather than held. Idempotent, and it never rejects.
   */
  async shutdown(): Promise<void> {
    if (this.#shutdownComplete) {
      return;
    }
    this.#shuttingDown = true;
    this.#clearFlushTimer();

    try {
      await this.#withDeadline(this.#requestDrain('final'), SHUTDOWN_FLUSH_DEADLINE_MS);
    } catch (error) {
      this.#internalErrors += 1;
      this.#log('debug', 'shutdown flush failed', { error: describeError(error) });
    }

    this.#shutdownComplete = true;

    const abandoned = this.#buffer.length;
    if (abandoned > 0) {
      this.#buffer.length = 0;
      this.#droppedAtShutdown += abandoned;
      this.#log('debug', 'buffered events were abandoned at shutdown', { events: abandoned });
    }
  }

  /**
   * Make this processor usable again, after a tracer provider shut it down.
   *
   * This exists because of a mismatch between two lifetimes. OpenTelemetry's
   * SDK treats a span processor as owned by the provider it was constructed
   * with, and `TracerProvider.shutdown()` shuts its processors down — but this
   * processor is deliberately **shared across providers**: `register.ts`
   * constructs exactly one and hands it to every provider the capture
   * lifecycle builds, so its buffer, its transport and its sequence survive
   * each enable/disable cycle. Without this method the provider shutdown that
   * ends the first capture would close the processor for good, and every span
   * of the *second* capture would be counted as
   * {@link DebuggenSpanProcessorStats.droppedAfterShutdown} — a session whose
   * second reproduction silently produced no server telemetry at all.
   *
   * Idempotent, and it deliberately does **not** undo the abandonment
   * `shutdown()` performed: whatever was still buffered then is already lost
   * and counted, and resurrecting it would post the previous capture's
   * evidence into the next one.
   *
   * Only the lifecycle owner (`./control.ts`, when it installs a replacement
   * provider) calls this. Nothing calls it on the process-exit path, where the
   * shutdown is final.
   */
  reopen(): void {
    if (!this.#shuttingDown && !this.#shutdownComplete) {
      return;
    }
    this.#shuttingDown = false;
    this.#shutdownComplete = false;
    // Anything that arrived between the shutdown and now was dropped, so the
    // buffer is either empty or holds spans enqueued since; either way the
    // window is re-armed rather than assumed.
    this.#armFlushTimer();
    this.#log('debug', 'the span processor was reopened for a new tracer provider');
  }

  /*
   * -------------------------------------------------------------------------
   * Queue
   * -------------------------------------------------------------------------
   */

  /**
   * Add one event to the buffer, enforce the cap, and decide when it travels.
   *
   * At the cap the **oldest** events make room for the newest: a developer
   * reproducing an issue cares about what just happened, and the alternative —
   * refusing the new event — would leave a capture describing the moment
   * before the one under investigation. Every discarded event is counted, and
   * the warning is deferred to the next flush window so a burst produces one
   * line rather than thousands.
   *
   * @param event A converted, ingest-ready event.
   */
  #enqueue(event: TelemetryEventIngress): void {
    if (this.#buffer.length >= MAX_BUFFERED_EVENTS) {
      const overflow = this.#buffer.length - MAX_BUFFERED_EVENTS + 1;
      this.#buffer.splice(0, overflow);
      this.#droppedOverflow += overflow;
      this.#overflowSinceWarning += overflow;
    }

    this.#buffer.push(event);

    if (this.#buffer.length >= BATCH_MAX_EVENTS) {
      // A full batch travels now; waiting would only make it larger than the
      // size `./config.ts` chose for one POST.
      this.#clearFlushTimer();
      void this.#requestDrain('normal');
      return;
    }

    this.#armFlushTimer();
  }

  /**
   * Arm the one-shot flush timer, at most one at a time.
   *
   * A window rather than a standing interval: the timer exists only while
   * something is waiting, so a quiet dev server has no timer at all and a
   * partial batch never waits longer than {@link BATCH_FLUSH_INTERVAL_MS} from
   * the moment it started waiting. It is always `unref`'d — a pending flush
   * must never hold a process open — and never armed once shutdown has begun.
   */
  #armFlushTimer(): void {
    if (this.#flushTimer !== undefined || this.#shuttingDown || this.#buffer.length === 0) {
      return;
    }

    const timer = setTimeout(() => {
      this.#flushTimer = undefined;
      try {
        void this.#requestDrain('normal');
      } catch (error) {
        // A timer callback has no caller to catch anything it throws.
        this.#internalErrors += 1;
        this.#log('debug', 'scheduled flush could not start', { error: describeError(error) });
      }
    }, BATCH_FLUSH_INTERVAL_MS);

    unrefTimer(timer);
    this.#flushTimer = timer;
  }

  /** Cancel a pending flush window, if one is armed. */
  #clearFlushTimer(): void {
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
  }

  /*
   * -------------------------------------------------------------------------
   * Draining
   * -------------------------------------------------------------------------
   */

  /**
   * Queue a drain behind whatever is already draining, and return its promise.
   *
   * The chain is what guarantees a single in-flight post: `onEnd` is
   * synchronous and a post is not, so without serialisation two drains could
   * both splice the buffer and race the same events onto the wire. Because
   * {@link #drain} absorbs its own failures, the chain can never reject and no
   * caller has to attach a handler to keep the process quiet.
   *
   * @param mode How hard the batches in this drain should be tried.
   */
  #requestDrain(mode: DrainMode): Promise<void> {
    const chained = this.#chain.then(() => this.#drain(mode));
    this.#chain = chained;
    return chained;
  }

  /**
   * Post the buffer, one batch at a time, up to {@link MAX_DRAIN_BATCHES}.
   *
   * The cap is what makes this terminate on a server that is producing spans as
   * fast as they are being posted: whatever arrives after it is reached belongs
   * to the next window. Batches are taken out of the buffer before they are
   * posted, so an event is never sent twice, and a batch that could not be
   * delivered is dropped rather than re-queued (module overview).
   *
   * Never throws, whatever a batch does.
   *
   * @param mode `normal` for the full attempt budget, `final` for one attempt.
   */
  async #drain(mode: DrainMode): Promise<void> {
    this.#reportOverflow();

    try {
      const attempts = mode === 'final' ? 1 : MAX_POST_ATTEMPTS;

      for (let batches = 0; batches < MAX_DRAIN_BATCHES && this.#buffer.length > 0; batches += 1) {
        const batch = this.#buffer.splice(0, BATCH_MAX_EVENTS);
        const outcome = await this.#postBatch(batch, attempts);

        if (outcome === 'sent') {
          this.#postedBatches += 1;
          this.#postedEvents += batch.length;
          continue;
        }

        this.#failedBatches += 1;
        if (outcome === 'unserializable') {
          this.#droppedUnserializable += batch.length;
        } else {
          this.#droppedFailedBatch += batch.length;
        }
      }
    } catch (error) {
      this.#internalErrors += 1;
      this.#log('debug', 'drain failed', { error: describeError(error) });
    }

    // Events that arrived while this drain was in flight get their own window.
    // Normally the enqueue path has already armed it; this is what covers the
    // case where it could not, because the drain held the only timer slot.
    this.#armFlushTimer();
  }

  /**
   * Write the deferred overflow warning, if anything was dropped since the last
   * one, and reset the window.
   *
   * One line per flush window, carrying the count — which is strictly more
   * useful than the thousands of lines a per-event warning would put in
   * someone else's terminal.
   */
  #reportOverflow(): void {
    const dropped = this.#overflowSinceWarning;
    if (dropped === 0) {
      return;
    }
    this.#overflowSinceWarning = 0;
    this.#log('warn', 'telemetry buffer was full; oldest events were dropped', {
      events: dropped,
      bufferLimit: MAX_BUFFERED_EVENTS,
      droppedTotal: this.#droppedOverflow,
    });
  }

  /*
   * -------------------------------------------------------------------------
   * Transport
   * -------------------------------------------------------------------------
   */

  /**
   * Serialise one batch and post it, retrying within the attempt budget.
   *
   * The body is built once and reused across attempts: it cannot change between
   * them, and re-serialising would be the most expensive part of a retry.
   *
   * @param events The batch, already removed from the buffer.
   * @param maxAttempts Attempts permitted, at least one.
   * @returns What became of the batch.
   */
  async #postBatch(
    events: readonly TelemetryEventIngress[],
    maxAttempts: number,
  ): Promise<BatchOutcome> {
    if (events.length === 0) {
      return 'sent';
    }
    if (!this.#transportAvailable) {
      return 'failed';
    }

    let body: string;
    try {
      // The ingest body of AAP 0.4.2, exactly: the credential's project root
      // and the events `./convert.ts` produced, with nothing added to either.
      body = JSON.stringify({ projectRoot: this.#config.projectRoot, events });
    } catch (error) {
      this.#log('debug', 'a telemetry batch could not be serialised', {
        events: events.length,
        error: describeError(error),
      });
      return 'unserializable';
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await this.#attemptPost(body, events.length);

      if (outcome === 'sent') {
        return 'sent';
      }
      if (outcome === 'permanent') {
        return 'failed';
      }
      if (attempt < maxAttempts) {
        await sleep(computeIngestBackoffMs(attempt, this.#random));
      }
    }

    this.#log('debug', 'a telemetry batch was dropped after every attempt failed', {
      events: events.length,
      attempts: maxAttempts,
    });
    return 'failed';
  }

  /**
   * One `POST` of a prepared body.
   *
   * The whole ingest contract lives in this method: the endpoint verbatim, two
   * headers and no third, the abort signal, and no interpretation of the
   * response beyond its status.
   *
   * @param body The serialised `{ projectRoot, events }` payload.
   * @param eventCount How many events it carries, for diagnostics only.
   */
  async #attemptPost(body: string, eventCount: number): Promise<PostOutcome> {
    try {
      const response = await this.#fetchImpl(this.#config.ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The server-agent credential. Sent, never logged.
          Authorization: `Bearer ${this.#config.token}`,
        },
        body,
        // Refused, not followed. The endpoint was accepted as loopback before
        // this request existed, and a redirect would move the request — with
        // the server-agent credential on it — to an origin nothing checked. The
        // local service answers ingest directly, so a 3xx here is a
        // misconfiguration or a hostile listener, and either way the batch is
        // better retried than redirected. `fetch` rejects, which the catch
        // below treats as a transport failure.
        redirect: 'error',
        // Bounded, so a wedged service cannot leave a request pending and stall
        // the drain chain behind it.
        signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
      });

      // Nothing here reads a response body, so the stream is released rather
      // than left to the garbage collector holding a connection.
      await releaseResponseBody(response);

      if (response.ok) {
        this.#authHintLogged = false;
        this.#log('debug', 'telemetry batch accepted', {
          events: eventCount,
          status: response.status,
        });
        return 'sent';
      }

      return this.#classifyRejection(response.status, eventCount);
    } catch (error) {
      // A refused connection, a DNS failure, an abort at the timeout, or a
      // `fetch` implementation that threw. All of them are moments rather than
      // answers, so the caller may try again.
      this.#log('debug', 'telemetry batch could not be delivered', {
        url: this.#config.ingestUrl,
        events: eventCount,
        error: describeError(error),
      });
      return 'retry';
    }
  }

  /**
   * Decide what a non-`2xx` status means for the batch, and tell the developer
   * once when there is something they can do about it.
   *
   * @param status The response status.
   * @param eventCount Events in the rejected batch, for diagnostics only.
   */
  #classifyRejection(status: number, eventCount: number): PostOutcome {
    if (AUTH_REJECTED_STATUSES.has(status)) {
      if (!this.#authHintLogged) {
        this.#authHintLogged = true;
        // The one hint that leads somewhere: a server-agent credential is
        // scoped to one project and expires with the process it was minted
        // for, so a rejected one means this dev server is no longer the one the
        // session launched. The credential itself is never part of the message.
        this.#log(
          'warn',
          'the local service rejected this process\u2019s telemetry credential; server-side telemetry stops until the dev server is relaunched from the Debug Generator session',
          { status, url: this.#config.ingestUrl },
        );
      }
      return 'permanent';
    }

    if (status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.has(status)) {
      // The service read the batch and refused it. Sending the same bytes again
      // would get the same answer, so the batch is abandoned and the developer
      // is told once per occurrence rather than once per attempt.
      this.#log('warn', 'the local service refused a telemetry batch', {
        status,
        events: eventCount,
      });
      return 'permanent';
    }

    this.#log('debug', 'the local service could not accept a telemetry batch', {
      status,
      events: eventCount,
    });
    return 'retry';
  }

  /*
   * -------------------------------------------------------------------------
   * Diagnostics and bounds
   * -------------------------------------------------------------------------
   */

  /**
   * Await `work`, or give up on it after `ms` and resolve anyway.
   *
   * Used by `shutdown()` only. `work` is not cancelled — it stays on the drain
   * chain and may still succeed — but nothing waits for it past the deadline,
   * which is what keeps a provider shutdown from hanging on an unreachable
   * service. The deadline timer is `unref`'d and always cleared.
   *
   * @param work The drain to bound.
   * @param ms The deadline in milliseconds.
   */
  async #withDeadline(work: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      unrefTimer(timer);
    });

    try {
      await Promise.race([work, deadline]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Write one diagnostic, scrubbed, swallowing anything the sink does.
   *
   * Two levels only. `debug` is the default for everything routine, because
   * this output lands in the developer's own dev-server terminal next to their
   * application's logs; `warn` is reserved for a degraded capture they can act
   * on — a full buffer, a refused credential, a refused batch — which is
   * exactly the threshold `./config.ts` documents.
   *
   * @param level `debug` for routine detail, `warn` for a degraded capture.
   * @param message Human-readable and value-free.
   * @param fields Optional structured context; never a credential.
   */
  #log(level: 'debug' | 'warn', message: string, fields?: Record<string, unknown>): void {
    try {
      const safeMessage = this.#scrub(message);

      if (fields === undefined) {
        if (level === 'warn') {
          this.#logger.warn(safeMessage);
        } else {
          this.#logger.debug(safeMessage);
        }
        return;
      }

      const safeFields = this.#scrubFields(fields);
      if (level === 'warn') {
        this.#logger.warn(safeMessage, safeFields);
      } else {
        this.#logger.debug(safeMessage, safeFields);
      }
    } catch {
      // A logger that throws must not become an application failure, and a
      // failed diagnostic has nowhere left to be reported.
    }
  }

  /**
   * Replace the credential with {@link REDACTED_PLACEHOLDER} wherever it
   * appears in a string.
   *
   * Substring replacement rather than a pattern, so nothing has to be escaped
   * and no credential shape has to be guessed at: the exact secret this process
   * holds is the only thing removed.
   *
   * @param text A diagnostic string.
   */
  #scrub(text: string): string {
    const token = this.#config.token;
    if (token.length === 0 || !text.includes(token)) {
      return text;
    }
    return text.split(token).join(REDACTED_PLACEHOLDER);
  }

  /**
   * Scrub the string values of a field bag, leaving everything else as it is.
   *
   * Every field this module writes is a count, a status, a URL or a described
   * error, so a shallow pass covers all of them; a deep walk would invite the
   * unbounded traversal of a foreign object that the privacy model forbids
   * anyway.
   *
   * @param fields The structured context handed to {@link #log}.
   */
  #scrubFields(fields: Record<string, unknown>): Record<string, unknown> {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      scrubbed[key] = typeof value === 'string' ? this.#scrub(value) : value;
    }
    return scrubbed;
  }
}
