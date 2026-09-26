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
 * | Timeout | {@link INGEST_TIMEOUT_MS}, enforced with an abort signal that also bounds reading the answer |
 * | Redirects | refused (`redirect: 'error'`) |
 * | Answer | the status decides; only a `2xx` body — `{ accepted, rejected? }` — is read, at most {@link MAX_ACKNOWLEDGEMENT_BYTES} of it |
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
 * module therefore posts the objects `./convert.ts` produced with exactly one
 * addition, the schema's optional `clockOffsetMs` (next section), and nothing
 * else.
 *
 * ## The clock offset
 *
 * No clock alignment is applied to event times beyond a recorded per-producer
 * `clockOffsetMs` (server `Date` header versus local clock, informational; see
 * `docs/ARCHITECTURE.md` §5.2). This process is the producer, and this
 * processor — which lives as long as the process — holds its one
 * `ClockOffsetEstimator` from `../schema/clock-offset.ts`:
 *
 * - **Measured** against the local service's own `Date` header on the answer
 *   to every ingest `POST`, whatever its status (a `401` or a `503` is still
 *   the service's clock), with the two readings taken immediately around the
 *   `fetch` from {@link DebuggenSpanProcessorOptions.now} — the wall clock
 *   OpenTelemetry stamps a span's start with. A request that never got an
 *   answer yields no sample.
 * - **Stamped once**, in `onEnd`, on the event `./convert.ts` has just built
 *   and only once an estimate exists. A batch is serialised once and that body
 *   is what every retry sends, so an event is never restamped — which is what
 *   keeps a re-delivered event identical to the one the store already holds.
 *   The first batch of a process therefore carries no offset: nothing has
 *   answered yet.
 * - **Never applied.** `startTime` and `duration` are `./convert.ts`'s,
 *   untouched; the offset is a statement about them.
 * - **Process-scoped.** A capture change does not reset it; the process's
 *   clock is the same clock. {@link DebuggenSpanProcessor.clockOffset} reports
 *   it without widening {@link DebuggenSpanProcessorStats}.
 *
 * The request is unchanged by any of this: the same two headers, the same
 * body shape, and the response body is still never read.
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
 * A `2xx` ends a batch's attempts whatever its body says. It is the service's
 * decision about those bytes, and sending them again gets the same decision —
 * so a batch the service received and stored nothing of is counted as refused
 * rather than retried, and never as delivered (next section).
 *
 * ## What is read of an answer
 *
 * The service answers an ingest it processed with `202 { accepted, rejected? }`:
 * `accepted` is how many of the batch's events it now holds, `rejected` every
 * other element, omitted when zero. `202 { accepted: 0, rejected: N }` is a
 * batch it received and refused outright — no capture open for it when it
 * arrived, a gate the capture's plan applies, or no element it could store
 * safely. The status cannot tell that from a batch that was stored, so the
 * body of a `2xx` is read, and only that body:
 *
 * - **Bounded.** A declared `Content-Length` over
 *   {@link MAX_ACKNOWLEDGEMENT_BYTES} is refused without a byte being read, and
 *   the streamed read cancels the stream the moment it passes the same cap, so
 *   a broken or hostile listener on the loopback port cannot make the preload
 *   buffer an unbounded answer. The read shares the request's abort signal,
 *   so {@link INGEST_TIMEOUT_MS} bounds it in time as well.
 * - **Structural.** UTF-8 JSON, then two fields checked by hand — `accepted` a
 *   non-negative safe integer, `rejected` absent or one — because this package
 *   sits below `@debuggen/protocol` and may not import its schema. Other keys
 *   are ignored, so a service that learns to say more does not make every
 *   answer unreadable. The counts are clamped to the batch that was posted —
 *   `accepted` to at most its size, `rejected` always the remainder — so no
 *   answer can make this process count more events than it sent.
 * - **Accounted, never retried.** Accepted events land on
 *   {@link DebuggenSpanProcessorStats.postedEvents}, refused ones on
 *   {@link DebuggenSpanProcessorStats.droppedRejectedByService}, and a batch of
 *   which nothing was stored on {@link DebuggenSpanProcessorStats.refusedBatches}
 *   instead of {@link DebuggenSpanProcessorStats.postedBatches}.
 * - **Tolerant of silence.** A `2xx` whose body is absent, empty, oversized,
 *   unreadable or not an acknowledgement is an answer that says nothing about
 *   counts. The batch is counted as posted in full, as every `2xx` once was,
 *   and also on {@link DebuggenSpanProcessorStats.unacknowledgedBatches}, so the
 *   assumption is visible rather than silent.
 * - **Never repeated.** The body is not logged, echoed or attached to an
 *   error. Diagnostics carry the clamped counts and a fixed reason word.
 *
 * The body of a non-`2xx` answer is still never read. Its status is the whole
 * decision — retry, give up, or stop the transport — and an error body can
 * quote a path or a message this module has no business holding, so it is
 * cancelled unread to free the connection.
 *
 * Refusals are a degraded capture the developer can act on, and also a
 * condition that repeats on every batch for as long as its cause lasts, so
 * they are summarised rather than narrated: the counts accumulate, and one
 * warning carrying them is written at most once per drain and no more often
 * than {@link REFUSAL_WARNING_INTERVAL_MS}. Nothing is lost to the interval —
 * a suppressed window's counts travel in the next warning — and the final
 * drain of `shutdown()` writes whatever is still unreported. Each batch's own
 * answer is recorded at `debug`.
 *
 * ## A refused credential stops the transport, for good
 *
 * A `401` or a `403` from the ingest endpoint is not a failed batch, it is the
 * end of server-side telemetry in this process: the server-agent credential is
 * minted per dev-server launch and scoped to one project root (AAP §0.5.6), so
 * an endpoint that has refused it will refuse it for as long as the process
 * lives. The first such answer latches
 * {@link DebuggenSpanProcessorStats.credentialRejected} and, from that instant,
 * `onEnd` converts nothing, the buffer is released, no flush window is armed
 * and no request is built — the developer is told once, and the message's own
 * promise ("server-side telemetry stops until the dev server is relaunched") is
 * what the code then does. The latch survives `reopen()` and every subsequent
 * capture; only relaunching the dev server, which mints a new credential,
 * clears it. Every span and event the condition costs is counted on
 * {@link DebuggenSpanProcessorStats.droppedCredentialRejected}, and
 * `./control.ts` republishes the latch as
 * `ServerAgentControlStats.ingestCredentialRejected` so the condition is
 * reportable rather than merely logged.
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
 * status code and counts — never the body of an answer — and every message is
 * passed through a scrub that removes the token should a foreign error text
 * ever quote it.
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

import { nowEpochMs } from '@debuggen/shared';
import type { Logger } from '@debuggen/shared';
import type { Context, Span } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { ClockOffsetEstimator } from '../schema/clock-offset.js';
import type { ClockOffsetSnapshot } from '../schema/clock-offset.js';
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
 * ingest timeout, backoff envelope. The four constants below are *derived*
 * from it rather than invented, so a change to the envelope moves them too and
 * no tunable in this file stands on its own. What follows them — the two
 * status tables and the acknowledgement's byte bound — describes the ingest
 * contract rather than the envelope, and says so where it is declared.
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
 * Milliseconds that must pass between two warnings about events the service
 * received and did not store.
 *
 * The backoff ceiling, {@link RECONNECT_MAX_MS}: the longest this transport
 * ever waits before repeating an attempt is also the shortest interval at
 * which it repeats a summary. A refusal is a condition that lasts — a service
 * with no capture open for this process refuses every batch until one opens —
 * and with a one-second flush window a per-drain warning would still be a line
 * a second in the developer's terminal.
 *
 * The interval suppresses lines, never counts: what a suppressed drain refused
 * is carried into the next warning, and the final drain of
 * {@link DebuggenSpanProcessor.shutdown} writes the remainder regardless.
 */
export const REFUSAL_WARNING_INTERVAL_MS = RECONNECT_MAX_MS;

/**
 * HTTP statuses that are worth another attempt even though they are `4xx`.
 *
 * `408 Request Timeout` and `429 Too Many Requests` describe a moment, not the
 * batch; every other client error says the batch or the credential will not
 * become acceptable by being sent again.
 *
 * Exported for the same reason the bounds above are: `./exporter.test.ts`
 * asserts that every member here leaves the transport running, and a copy of
 * the table in the suite would stop covering a status added to this one.
 */
export const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 429]);

/**
 * Statuses that mean the credential was refused.
 *
 * Separated from the rest of the `4xx` family because they earn a developer a
 * specific hint — the one thing they can act on — and because they must never
 * be retried in a loop against an endpoint that has already said no: every
 * member latches {@link DebuggenSpanProcessorStats.credentialRejected} and
 * stops the transport for the life of the process.
 *
 * Exported so the suite drives the real table rather than a copy of it, which
 * is what makes a status added here covered by the existing cases.
 */
export const AUTH_REJECTED_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * Bytes of a `2xx` answer's body this module will read as an acknowledgement.
 *
 * The acknowledgement is `{ accepted, rejected? }` — two small integers, a few
 * dozen bytes — so 4 KiB is two orders of magnitude of headroom and still a
 * bound nothing listening on the loopback port can talk past. A declared
 * `Content-Length` above it is refused unread, and a streamed body is cancelled
 * the moment it passes it. Either way the batch falls back to being counted as
 * posted and unacknowledged, never to an exception or a retry.
 *
 * Exported so the suite drives the real bound rather than a copy of it.
 */
export const MAX_ACKNOWLEDGEMENT_BYTES = 4 * 1024;

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

  /**
   * The process clock the clock-offset samples are read from, in epoch
   * milliseconds; defaults to `@debuggen/shared`'s `nowEpochMs` (`Date.now()`).
   *
   * It must be the clock event times come from, or the offset would describe a
   * different clock than the one it is recorded next to: OpenTelemetry stamps a
   * span's start from `Date.now()`, and `./convert.ts` converts that `hrTime`
   * without adjustment. Injectable so a suite can place the two readings
   * around a post exactly and assert the resulting estimate to the
   * millisecond. Optional, and `register.ts` does not pass it.
   *
   * @example Pinning the clock in a test
   * ```ts
   * let now = 1_700_000_000_000;
   * new DebuggenSpanProcessor({ gate, config, fetchImpl, now: () => now });
   * ```
   */
  readonly now?: (() => number) | undefined;
}

/**
 * A snapshot of everything the processor counts.
 *
 * The names are a contract with `./control.test.ts`, which asserts the drop
 * rules through them, so they are stable: add a counter rather than rename one.
 * Every number is cumulative over the processor's life — it is constructed once
 * by `register.ts` and survives every enable/disable cycle — except
 * {@link buffered}, which is the current queue depth, and
 * {@link credentialRejected}, which is a terminal state rather than a count.
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

  /**
   * Spans and events discarded because the ingest endpoint refused this
   * process's credential.
   *
   * The sibling of {@link droppedAfterShutdown}, and read the same way: both
   * count evidence this processor declined to handle because it is in a state
   * it cannot leave. It covers the spans `onEnd` refuses once
   * {@link credentialRejected} is set *and* whatever was still buffered when
   * the refusal arrived, since none of it can be delivered to an endpoint that
   * has said no.
   */
  readonly droppedCredentialRejected: number;

  /** Events still buffered when the shutdown flush ran out of its deadline. */
  readonly droppedAtShutdown: number;

  /**
   * Batches the service answered with a `2xx` and stored at least one event
   * of.
   *
   * A batch whose acknowledgement said `accepted: 0` is not here but on
   * {@link refusedBatches}. A `2xx` without a readable acknowledgement is here,
   * taken as stored in full, and also on {@link unacknowledgedBatches}.
   */
  readonly postedBatches: number;

  /**
   * Events the service acknowledged storing: each acknowledgement's
   * `accepted`, clamped to its batch, or the whole batch where the answer
   * carried no readable acknowledgement.
   */
  readonly postedEvents: number;

  /**
   * Events the service answered a `2xx` for and did not store: each
   * acknowledgement's `rejected`, clamped to its batch.
   *
   * The service received them and dropped them — no capture was open for this
   * process when they arrived, a gate of the capture's plan refused them, or
   * they could not be stored safely. A `2xx` is the service's decision about
   * those bytes, so none of them is retried. Disjoint from
   * {@link droppedFailedBatch}, which counts events that never got an answer
   * the service stood behind.
   */
  readonly droppedRejectedByService: number;

  /**
   * Batches the service answered with a `2xx` and stored nothing of
   * (`accepted: 0` with `rejected` above zero).
   *
   * Disjoint from {@link postedBatches} and from {@link failedBatches}: the
   * batch was delivered and refused, which is neither a success nor a
   * transport failure. Its events are on {@link droppedRejectedByService}.
   */
  readonly refusedBatches: number;

  /**
   * Batches answered with a `2xx` whose body was absent, empty, larger than
   * {@link MAX_ACKNOWLEDGEMENT_BYTES}, unreadable, or not an acknowledgement.
   *
   * Each is also on {@link postedBatches} with all of its events on
   * {@link postedEvents}: an answer that says nothing about counts is read as
   * "stored", which is what every `2xx` was taken to mean before the
   * acknowledgement was read. Non-zero means the delivered figures include
   * that assumption and are an upper bound.
   */
  readonly unacknowledgedBatches: number;

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

  /**
   * Whether the ingest endpoint refused this process's credential, which stops
   * server-side telemetry for the life of the process.
   *
   * Latched by a `401` or a `403` from `POST /telemetry/ingest` and never
   * cleared — not by `reopen()`, not by a later capture. The server-agent
   * credential is minted per dev-server launch and scoped to one project root
   * (AAP §0.5.6), so one the service has refused never starts being accepted,
   * and the only remedy is the one the diagnostic names: relaunch the dev
   * server from the Debug Generator session.
   *
   * `true` is therefore the machine-readable form of "relaunch required", and
   * it is what lets `./control.ts` report the condition instead of leaving a
   * developer with a session that looks armed and collects nothing. Distinct
   * from `ServerAgentControlStats.credentialRejected`, which is the *control
   * socket's* 4401 latch: this one is the HTTP ingest endpoint's answer, and
   * either can happen without the other.
   */
  readonly credentialRejected: boolean;

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
 * Release a non-`2xx` response's body, unread, so the underlying socket can be
 * reused.
 *
 * The only body this module reads is a `2xx` acknowledgement, through
 * {@link readIngestAcknowledgement}; the `Date` header of every answer is read
 * only as a clock sample. Any other answer is decided by its status alone, and
 * its body — an error payload from the service, or whatever a foreign listener
 * sent — could quote a path or a message this module has no business holding,
 * let alone logging. An unconsumed body, however, keeps its connection checked
 * out until the garbage collector notices, so it is cancelled explicitly.
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
 * What the service's `2xx` answer said about one batch, clamped to that batch.
 *
 * `accepted + rejected` is always the batch size. `accepted` is the service's
 * count capped at the events posted, and `rejected` is the remainder: the
 * service's own `rejected` is validated but never preferred over that
 * arithmetic, because the two disagree only when one of them is wrong, and
 * `accepted` — "the store now holds these" — is the count the service takes
 * from what it actually wrote. Every event not stored is, from this process's
 * side, an event not delivered.
 */
interface IngestAcknowledgement {
  /** Events of the batch the service now holds. */
  readonly accepted: number;
  /** Events of the batch the service received and did not store. */
  readonly rejected: number;
  /** Whether the declared counts had to be corrected to fit the batch. */
  readonly clamped: boolean;
}

/**
 * Why a `2xx` answer yielded no acknowledgement.
 *
 * A closed vocabulary, so a diagnostic can say which case applied without
 * quoting a byte of what the answer contained.
 */
type UnacknowledgedReason =
  /** No body at all: a `204`, or a service that answers with a status only. */
  | 'no-body'
  /** A body of zero bytes. */
  | 'empty'
  /** A declared or streamed length above {@link MAX_ACKNOWLEDGEMENT_BYTES}. */
  | 'oversized'
  /**
   * A stream that errored, was already locked, yielded something other than
   * bytes, or was still arriving when the request's deadline passed.
   */
  | 'unreadable'
  /** Bytes that are not UTF-8 JSON. */
  | 'malformed'
  /** JSON that is not `{ accepted, rejected? }` with non-negative safe integers. */
  | 'unrecognised';

/** A `2xx` answer that carried no usable acknowledgement, and which case applied. */
interface Unacknowledged {
  readonly kind: 'unacknowledged';
  readonly reason: UnacknowledgedReason;
}

/** What reading a `2xx` answer's body concluded. */
type AcknowledgementReading =
  | { readonly kind: 'acknowledged'; readonly acknowledgement: IngestAcknowledgement }
  | Unacknowledged;

/** The body of a `2xx` answer as text, or why there is none worth parsing. */
type AcknowledgementText = { readonly kind: 'text'; readonly text: string } | Unacknowledged;

/**
 * The reading for an answer that carried no usable acknowledgement.
 *
 * @param reason Which case applied.
 */
function unacknowledged(reason: UnacknowledgedReason): Unacknowledged {
  return { kind: 'unacknowledged', reason };
}

/**
 * Whether a parsed JSON value is a count: a non-negative safe integer.
 *
 * `Number.isSafeInteger` refuses `NaN`, the infinities (which is what JSON's
 * `1e400` parses to), fractions and anything past 2^53, so a count that passes
 * can be added to a counter without losing precision.
 *
 * @param value The value to judge.
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The response's declared `Content-Length`, when it declares a usable one.
 *
 * A value that is not a plain run of digits — absent, a list, a sign, a
 * fraction — is treated as undeclared, which leaves the streamed cap in
 * {@link readAcknowledgementText} as the bound. A run of digits too long to be a
 * safe integer is certainly over the cap and is answered as infinity.
 *
 * @param headers The response's headers.
 * @returns The declared length in bytes, or `undefined`.
 */
function declaredContentLength(headers: Headers): number | undefined {
  const declared = headers.get('content-length');
  if (declared === null) {
    return undefined;
  }
  const digits = declared.trim();
  if (!/^\d+$/.test(digits)) {
    return undefined;
  }
  const length = Number(digits);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

/**
 * Cancel a reader's stream without waiting on it and without throwing.
 *
 * Not awaited on purpose: cancelling is how this module lets go of an answer
 * it has stopped reading, and a stream whose cancellation never settled would
 * otherwise hold the drain chain — and every batch behind it — hostage.
 *
 * @param reader The reader, or `undefined` when none was acquired.
 */
function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array> | undefined): void {
  if (reader === undefined) {
    return;
  }
  try {
    reader.cancel().catch(() => {
      // Already closed or errored: there is nothing left to release.
    });
  } catch {
    // A reader double whose `cancel` throws synchronously holds nothing either.
  }
}

/**
 * Read a `2xx` answer's body as text, bounded in bytes and in time.
 *
 * The byte bound is {@link MAX_ACKNOWLEDGEMENT_BYTES}, enforced twice: a
 * declared `Content-Length` above it is refused before the stream is touched,
 * and the streamed total is checked after every chunk, so a body that lies
 * about its length or declares none still cannot be read past the cap. The
 * time bound is the request's own abort signal: when it fires the reader is
 * cancelled, which settles a pending read, and whatever had arrived is
 * discarded as a prefix rather than parsed as an answer. Every early exit
 * cancels the stream so the connection is released.
 *
 * @param response A settled response whose status is `2xx`.
 * @param signal The request's abort signal.
 * @returns The body's text, or why there is none.
 */
async function readAcknowledgementText(
  response: Response,
  signal: AbortSignal,
): Promise<AcknowledgementText> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelOnAbort = (): void => {
    cancelReader(reader);
  };

  try {
    const body: ReadableStream<Uint8Array> | null = response.body;
    if (body === null) {
      return unacknowledged('no-body');
    }
    if (body.locked) {
      return unacknowledged('unreadable');
    }

    const declared = declaredContentLength(response.headers);
    if (declared !== undefined && declared > MAX_ACKNOWLEDGEMENT_BYTES) {
      body.cancel().catch(() => {
        // Nothing was read and nothing will be; a failed cancel holds nothing.
      });
      return unacknowledged('oversized');
    }

    reader = body.getReader();
    signal.addEventListener('abort', cancelOnAbort, { once: true });

    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      if (signal.aborted) {
        cancelReader(reader);
        return unacknowledged('unreadable');
      }
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        cancelReader(reader);
        return unacknowledged('unreadable');
      }
      received += value.byteLength;
      if (received > MAX_ACKNOWLEDGEMENT_BYTES) {
        cancelReader(reader);
        return unacknowledged('oversized');
      }
      chunks.push(value);
    }

    // A deadline that fired mid-read cancelled the stream, and a cancelled
    // stream ends a read exactly as a complete one does. What arrived is then
    // a prefix of the answer, not the answer.
    if (signal.aborted) {
      return unacknowledged('unreadable');
    }
    if (received === 0) {
      return unacknowledged('empty');
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return unacknowledged('malformed');
    }
  } catch {
    // A stream that errored mid-read, a `getReader` that refused, or a
    // response double whose getters threw. The answer is unreadable, never an
    // exception on the drain.
    cancelReader(reader);
    return unacknowledged('unreadable');
  } finally {
    try {
      signal.removeEventListener('abort', cancelOnAbort);
    } catch {
      // A signal double without listener support registered nothing to remove.
    }
  }
}

/**
 * Validate a parsed acknowledgement by structure and clamp it to its batch.
 *
 * By hand, because this package sits below `@debuggen/protocol` in the
 * package graph and may not import its schema. Structural and deliberately
 * tolerant: the two fields this module reads must be well-formed counts, and
 * any other key is ignored, so a service that learns to say more does not make
 * every answer unreadable. Own properties only, so nothing inherited can stand
 * in for a count the answer did not carry.
 *
 * @param value The parsed JSON.
 * @param eventCount Events in the batch the answer is about.
 * @returns The clamped acknowledgement, or `undefined` for anything else.
 */
function toIngestAcknowledgement(
  value: unknown,
  eventCount: number,
): IngestAcknowledgement | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;

  const declaredAccepted: unknown = Object.hasOwn(record, 'accepted') ? record.accepted : undefined;
  if (!isCount(declaredAccepted)) {
    return undefined;
  }
  const declaredRejected: unknown = Object.hasOwn(record, 'rejected') ? record.rejected : undefined;
  if (declaredRejected !== undefined && !isCount(declaredRejected)) {
    return undefined;
  }

  const size = isCount(eventCount) ? eventCount : 0;
  // `Math.max` with `0` first also turns a JSON `-0` into `+0`, so no counter
  // ever holds a negative zero.
  const accepted = Math.max(0, Math.min(declaredAccepted, size));
  const rejected = size - accepted;

  return {
    accepted,
    rejected,
    clamped: declaredAccepted !== accepted || (declaredRejected ?? 0) !== rejected,
  };
}

/**
 * Read the acknowledgement of a `2xx` answer, and never throw.
 *
 * The one place this module reads a response body (module overview, *What is
 * read of an answer*). The text goes no further than `JSON.parse` and
 * {@link toIngestAcknowledgement}; only the clamped counts and a
 * {@link UnacknowledgedReason} leave this function, so no diagnostic can
 * quote the body.
 *
 * @param response A settled response whose status is `2xx`.
 * @param eventCount Events in the batch it answers; the counts are clamped to it.
 * @param signal The request's abort signal; its deadline bounds the read too.
 * @returns The acknowledgement, or why there was none.
 */
async function readIngestAcknowledgement(
  response: Response,
  eventCount: number,
  signal: AbortSignal,
): Promise<AcknowledgementReading> {
  const text = await readAcknowledgementText(response, signal);
  if (text.kind === 'unacknowledged') {
    return text;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    return unacknowledged('malformed');
  }

  const acknowledgement = toIngestAcknowledgement(parsed, eventCount);
  return acknowledgement === undefined
    ? unacknowledged('unrecognised')
    : { kind: 'acknowledged', acknowledgement };
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
 *
 * `sent` means the service answered `2xx`, and it carries what the answer's
 * acknowledgement said: a `2xx` is final for the batch, and whether any of it
 * was stored is the drain's to account for, not a reason to try again.
 */
type PostOutcome =
  | { readonly kind: 'sent'; readonly reading: AcknowledgementReading }
  | { readonly kind: 'retry' }
  | { readonly kind: 'permanent' };

/**
 * What became of one batch, as the drain needs to account for it.
 *
 * Three outcomes so the counters stay disjoint: a batch that could not be
 * serialised loses its events to {@link DebuggenSpanProcessorStats.droppedUnserializable},
 * one the service never accepted loses them to
 * {@link DebuggenSpanProcessorStats.droppedFailedBatch}, and a summed total
 * would hide which of the two happened — the first is a defect in this
 * repository, the second is the developer's service being away. A `sent`
 * batch carries its acknowledgement, which splits it between the posted and
 * the refused counters.
 */
type BatchOutcome =
  | { readonly kind: 'sent'; readonly reading: AcknowledgementReading }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unserializable' };

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

  /** The process clock clock-offset samples are read from; see the option. */
  readonly #now: () => number;

  /**
   * This process's clock-offset estimate against the local service's `Date`
   * header (module overview, "The clock offset").
   *
   * Owned by the processor because the processor lives as long as the process
   * and is the one component that talks to the service over HTTP. Never reset:
   * not on a capture change, not by `reopen()` — the clock it describes is the
   * process's, and the samples behind it stay true across captures.
   */
  readonly #clock = new ClockOffsetEstimator();

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

  /**
   * Events the service refused that no warning has mentioned yet; written out
   * by {@link #reportRefusals}.
   */
  #refusedEventsSinceWarning = 0;

  /** Batches the service stored nothing of that no warning has mentioned yet. */
  #refusedBatchesSinceWarning = 0;

  /**
   * `Date.now()` when the last refusal warning was written, or `undefined`
   * before the first one; spaces them {@link REFUSAL_WARNING_INTERVAL_MS} apart.
   */
  #lastRefusalWarningAt: number | undefined;

  /**
   * Set when the ingest endpoint refused the credential: terminal for this
   * process, and the gate every outbound path consults.
   *
   * One flag rather than two, because "the hint has been logged" and "the
   * transport has stopped" are the same fact. It used to be only the former,
   * which made the hint's own promise — *server-side telemetry stops until the
   * dev server is relaunched* — a claim nothing enforced: the drain kept
   * posting to the endpoint that had just refused it.
   *
   * @see {@link DebuggenSpanProcessorStats.credentialRejected}
   */
  #credentialRejected = false;

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

  /** {@link DebuggenSpanProcessorStats.droppedCredentialRejected} */
  #droppedCredentialRejected = 0;

  /** {@link DebuggenSpanProcessorStats.droppedAtShutdown} */
  #droppedAtShutdown = 0;

  /** {@link DebuggenSpanProcessorStats.postedBatches} */
  #postedBatches = 0;

  /** {@link DebuggenSpanProcessorStats.postedEvents} */
  #postedEvents = 0;

  /** {@link DebuggenSpanProcessorStats.droppedRejectedByService} */
  #droppedRejectedByService = 0;

  /** {@link DebuggenSpanProcessorStats.refusedBatches} */
  #refusedBatches = 0;

  /** {@link DebuggenSpanProcessorStats.unacknowledgedBatches} */
  #unacknowledgedBatches = 0;

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
    this.#now = options.now ?? nowEpochMs;

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
      droppedCredentialRejected: this.#droppedCredentialRejected,
      droppedAtShutdown: this.#droppedAtShutdown,
      postedBatches: this.#postedBatches,
      postedEvents: this.#postedEvents,
      droppedRejectedByService: this.#droppedRejectedByService,
      refusedBatches: this.#refusedBatches,
      unacknowledgedBatches: this.#unacknowledgedBatches,
      failedBatches: this.#failedBatches,
      internalErrors: this.#internalErrors,
      credentialRejected: this.#credentialRejected,
      buffered: this.#buffer.length,
    });
  }

  /**
   * Whether the ingest endpoint has refused this process's credential.
   *
   * A getter as well as a member of {@link stats}, for the same reason
   * {@link isShutDown} is one: `./control.ts` reads it on every
   * `ServerAgentControlStats` snapshot through the narrow
   * `ControlFlushTarget` interface, which declares a property rather than a
   * method so the read costs nothing and cannot fail.
   */
  get credentialRejected(): boolean {
    return this.#credentialRejected;
  }

  /**
   * A snapshot of this process's clock-offset estimate: the value the next
   * converted span will be stamped with (`offsetMs`), the interval it is the
   * midpoint of, and how many samples were accepted, restarted the estimate or
   * were rejected.
   *
   * A method of its own rather than members of {@link stats}, whose field names
   * are a contract with `./control.test.ts` and whose numbers describe the
   * transport: this one describes the process's clock, is shaped by
   * `../schema/clock-offset.ts` so both producers report it identically, and
   * is never reset.
   *
   * @returns A fresh, frozen snapshot.
   */
  clockOffset(): ClockOffsetSnapshot {
    return this.#clock.snapshot();
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

      // The credential this process holds was refused, so there is nowhere for
      // this span to go: converting and buffering it would only fill memory
      // with evidence that can never be posted, and the hint the developer was
      // given says server-side telemetry has stopped. Counted, like a span that
      // arrives after shutdown, and dropped before any work is done on it.
      if (this.#credentialRejected) {
        this.#droppedCredentialRejected += 1;
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

      // The one field this module adds (module overview, "The clock offset"):
      // stamped here, as the event is created, and never again — the batch
      // body is serialised once and reused by every retry. Absent until the
      // service has answered a post, never an explicit `undefined`.
      const clockOffsetMs = this.#clock.estimate();

      this.#convertedCount += 1;
      this.#enqueue(clockOffsetMs === undefined ? event : { ...event, clockOffsetMs });
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
   * It also deliberately does **not** clear
   * {@link DebuggenSpanProcessorStats.credentialRejected}. That latch belongs
   * to the *process*, not to the provider lifetime this method repairs: the
   * server-agent credential is minted per dev-server launch and scoped to one
   * project root, so an endpoint that refused it never starts accepting it and
   * AAP §0.5.6 requires the dev server to be relaunched. This method runs on
   * every capture re-arm, and clearing the latch here would have the second
   * capture buffer and post to an endpoint that has already said no — the
   * precise behaviour the latch exists to stop.
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
   * must never hold a process open — and never armed once shutdown has begun
   * or the credential has been refused, since neither state has a window in
   * which anything could travel.
   */
  #armFlushTimer(): void {
    if (
      this.#flushTimer !== undefined ||
      this.#shuttingDown ||
      this.#credentialRejected ||
      this.#buffer.length === 0
    ) {
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
   * A delivered batch is accounted by what its acknowledgement said
   * ({@link #recordAcknowledgement}), and whatever the service refused during
   * the drain is summarised once at its end ({@link #reportRefusals}).
   *
   * Never throws, whatever a batch does.
   *
   * @param mode `normal` for the full attempt budget, `final` for one attempt.
   */
  async #drain(mode: DrainMode): Promise<void> {
    this.#reportOverflow();

    // A refused credential ends the outbound path: nothing is posted, and
    // whatever is still queued is released rather than held for a flush that
    // can never succeed. Checked before the loop so `forceFlush()` and the
    // shutdown flush both resolve without touching the endpoint.
    if (this.#credentialRejected) {
      this.#discardAfterCredentialRejection();
      this.#reportRefusals(mode);
      return;
    }

    try {
      const attempts = mode === 'final' ? 1 : MAX_POST_ATTEMPTS;

      for (let batches = 0; batches < MAX_DRAIN_BATCHES && this.#buffer.length > 0; batches += 1) {
        const batch = this.#buffer.splice(0, BATCH_MAX_EVENTS);
        const outcome = await this.#postBatch(batch, attempts);

        if (outcome.kind === 'sent') {
          this.#recordAcknowledgement(batch.length, outcome.reading);
          continue;
        }

        this.#failedBatches += 1;
        if (outcome.kind === 'unserializable') {
          this.#droppedUnserializable += batch.length;
        } else {
          this.#droppedFailedBatch += batch.length;
        }

        // The batch that was just refused is what latched the credential, and
        // it keeps the counters it has already been given. Everything behind it
        // stops here: this is the case the drop rule exists for, because
        // without it the remaining batches of this very drain would each be
        // posted to an endpoint that has already answered `401`.
        if (this.#credentialRejected) {
          this.#discardAfterCredentialRejection();
          this.#reportRefusals(mode);
          return;
        }
      }
    } catch (error) {
      this.#internalErrors += 1;
      this.#log('debug', 'drain failed', { error: describeError(error) });
    }

    this.#reportRefusals(mode);

    // Events that arrived while this drain was in flight get their own window.
    // Normally the enqueue path has already armed it; this is what covers the
    // case where it could not, because the drain held the only timer slot.
    this.#armFlushTimer();
  }

  /**
   * Account for one batch the service answered with a `2xx`.
   *
   * The counters stay disjoint and add up to the batch: accepted events are
   * posted, refused ones are dropped by the service, and a batch is posted when
   * the service stored at least one of its events or *refused* when it stored
   * none. An answer without a readable acknowledgement keeps the meaning every
   * `2xx` had before acknowledgements were read — the whole batch posted — and
   * is marked as such on {@link DebuggenSpanProcessorStats.unacknowledgedBatches}.
   *
   * @param eventCount Events in the batch that was posted.
   * @param reading What the answer's acknowledgement said, or why it said nothing.
   */
  #recordAcknowledgement(eventCount: number, reading: AcknowledgementReading): void {
    if (reading.kind === 'unacknowledged') {
      this.#postedBatches += 1;
      this.#postedEvents += eventCount;
      this.#unacknowledgedBatches += 1;
      return;
    }

    const { accepted, rejected } = reading.acknowledgement;
    if (accepted > 0) {
      this.#postedBatches += 1;
      this.#postedEvents += accepted;
    }
    if (rejected > 0) {
      this.#droppedRejectedByService += rejected;
      this.#refusedEventsSinceWarning += rejected;
      if (accepted === 0) {
        this.#refusedBatches += 1;
        this.#refusedBatchesSinceWarning += 1;
      }
    }
  }

  /**
   * Write the coalesced refusal warning, if the service refused anything no
   * warning has mentioned yet and the interval allows it.
   *
   * Called once at the end of every drain, so a drain that posts many refused
   * batches writes at most one line. A `normal` drain also waits out
   * {@link REFUSAL_WARNING_INTERVAL_MS} since the last line, and what it holds
   * back stays in the pending counts for the next one; the `final` drain of
   * `shutdown()` writes regardless, so a capture's end always accounts for
   * every refusal. A clock that has moved backwards counts as the interval
   * having passed, so a wall-clock correction cannot silence the warning.
   *
   * The line carries counts only — never an event, a byte of the answer, or a
   * cause the service did not state.
   *
   * @param mode The mode of the drain that just finished.
   */
  #reportRefusals(mode: DrainMode): void {
    const events = this.#refusedEventsSinceWarning;
    if (events === 0) {
      return;
    }

    const now = Date.now();
    const last = this.#lastRefusalWarningAt;
    if (
      mode !== 'final' &&
      last !== undefined &&
      now >= last &&
      now - last < REFUSAL_WARNING_INTERVAL_MS
    ) {
      return;
    }

    const fullyRefusedBatches = this.#refusedBatchesSinceWarning;
    this.#refusedEventsSinceWarning = 0;
    this.#refusedBatchesSinceWarning = 0;
    this.#lastRefusalWarningAt = now;

    this.#log(
      'warn',
      'the local service received telemetry and did not store it; the capture may have closed, or the events were not ones it accepts',
      {
        events,
        fullyRefusedBatches,
        droppedTotal: this.#droppedRejectedByService,
      },
    );
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

  /**
   * Release everything still buffered, once the credential has been refused.
   *
   * Held evidence would be held for the life of the process: the endpoint will
   * not accept this credential again (AAP §0.5.6), `onEnd` admits nothing more,
   * and no flush window is armed, so the buffer has no future reader. Releasing
   * it is also what keeps `shutdown()` honest — the abandonment it reports is
   * for evidence a *reachable* service did not take in time, and counting these
   * events there would describe the wrong failure.
   *
   * The count lands on {@link DebuggenSpanProcessorStats.droppedCredentialRejected},
   * the same counter as the spans `onEnd` refuses, so one number accounts for
   * every piece of evidence this condition cost. Diagnostics stay at `debug`:
   * the one line a developer can act on was already written at `warn`, once.
   */
  #discardAfterCredentialRejection(): void {
    const discarded = this.#buffer.length;
    if (discarded === 0) {
      return;
    }
    this.#buffer.length = 0;
    this.#droppedCredentialRejected += discarded;
    this.#log('debug', 'buffered events were discarded after the credential was refused', {
      events: discarded,
      droppedTotal: this.#droppedCredentialRejected,
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
      // Nothing to send and nothing to count: an acknowledgement of zero events
      // lands on no counter.
      return {
        kind: 'sent',
        reading: {
          kind: 'acknowledged',
          acknowledgement: { accepted: 0, rejected: 0, clamped: false },
        },
      };
    }
    if (!this.#transportAvailable) {
      return { kind: 'failed' };
    }
    // Defence in depth. `#drain` already stops before it gets here, and this is
    // the single method that builds the credentialed request — so the guarantee
    // "no post after the endpoint refused this credential" is enforced at the
    // one place no future caller can go around.
    if (this.#credentialRejected) {
      return { kind: 'failed' };
    }

    let body: string;
    try {
      // The ingest body of AAP 0.4.2, exactly: the credential's project root
      // and the events `./convert.ts` produced, carrying nothing but the
      // `clockOffsetMs` `onEnd` stamped when each was created. Serialised once:
      // every retry below sends these bytes, so no event is ever restamped.
      body = JSON.stringify({ projectRoot: this.#config.projectRoot, events });
    } catch (error) {
      this.#log('debug', 'a telemetry batch could not be serialised', {
        events: events.length,
        error: describeError(error),
      });
      return { kind: 'unserializable' };
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await this.#attemptPost(body, events.length);

      if (outcome.kind === 'sent') {
        // A `2xx` ends the attempts whatever its acknowledgement says: it is the
        // service's decision about these bytes, and resending them would get
        // the same decision.
        return outcome;
      }
      if (outcome.kind === 'permanent') {
        return { kind: 'failed' };
      }
      if (attempt < maxAttempts) {
        await sleep(computeIngestBackoffMs(attempt, this.#random));
      }
    }

    this.#log('debug', 'a telemetry batch was dropped after every attempt failed', {
      events: events.length,
      attempts: maxAttempts,
    });
    return { kind: 'failed' };
  }

  /**
   * One `POST` of a prepared body.
   *
   * The whole ingest contract lives in this method: the endpoint verbatim, two
   * headers and no third, the abort signal, and what is read of the answer —
   * the status of every response, and the acknowledgement body of a `2xx`
   * only (module overview, *What is read of an answer*) — plus its `Date`
   * header, which is offered to the clock-offset estimate and decides nothing
   * about the batch.
   *
   * The clock is read immediately before the request and immediately after its
   * response arrives, because the service wrote its `Date` somewhere between
   * the two. Every answer is sampled, whatever its status; a request that
   * rejected — refused, timed out, redirected — had no answer and gives none.
   *
   * @param body The serialised `{ projectRoot, events }` payload.
   * @param eventCount How many events it carries: what the acknowledgement's
   * counts are clamped to, and a diagnostic field.
   */
  async #attemptPost(body: string, eventCount: number): Promise<PostOutcome> {
    try {
      // One deadline for the whole exchange: the request, and the read of the
      // acknowledgement that answers it.
      const signal = AbortSignal.timeout(INGEST_TIMEOUT_MS);
      const sentAt = this.#readClock();
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
        signal,
      });
      // Before the body is released, so the reading is as close to the
      // response's arrival as this code can observe it.
      const receivedAt = this.#readClock();
      this.#observeServiceClock(response, sentAt, receivedAt);

      if (response.ok) {
        // The service took the request and decided about the batch. The
        // answer's headers are readable here whatever becomes of the body; the
        // body is read last, because reading it consumes the stream.
        const reading = await readIngestAcknowledgement(response, eventCount, signal);
        this.#logAcknowledgement(response.status, eventCount, reading);
        return { kind: 'sent', reading };
      }

      // A non-`2xx` body is never read: the status is the whole decision, and
      // the stream is released rather than left to the garbage collector
      // holding a connection.
      await releaseResponseBody(response);
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
      return { kind: 'retry' };
    }
  }

  /**
   * Record one `2xx` answer at `debug`: counts, the status, and a fixed reason
   * word when there was no acknowledgement — never a byte of the body.
   *
   * Per batch and therefore never at `warn`; the developer-facing summary of
   * refusals is {@link #reportRefusals}, written once per drain at most.
   *
   * @param status The `2xx` status.
   * @param eventCount Events in the batch.
   * @param reading What its acknowledgement said, or why it said nothing.
   */
  #logAcknowledgement(status: number, eventCount: number, reading: AcknowledgementReading): void {
    if (reading.kind === 'unacknowledged') {
      this.#log('debug', 'telemetry batch accepted without a readable acknowledgement', {
        events: eventCount,
        status,
        reason: reading.reason,
      });
      return;
    }

    const { accepted, rejected, clamped } = reading.acknowledgement;
    this.#log('debug', 'telemetry batch acknowledged', {
      events: eventCount,
      status,
      accepted,
      rejected,
      clamped,
    });
  }

  /**
   * Decide what a non-`2xx` status means for the batch, and tell the developer
   * once when there is something they can do about it.
   *
   * Every member of {@link AUTH_REJECTED_STATUSES} — `401` and `403` alike —
   * stops the transport rather than merely abandoning the batch it arrived on.
   * `'permanent'` describes *this batch*; the latch describes the process, and
   * without it the warning below would promise something no code kept: the
   * drain would arm its next window and post the next batch to the endpoint
   * that had just refused the credential, for as long as the dev server ran.
   *
   * @param status The response status.
   * @param eventCount Events in the rejected batch, for diagnostics only.
   */
  #classifyRejection(status: number, eventCount: number): PostOutcome {
    if (AUTH_REJECTED_STATUSES.has(status)) {
      if (!this.#credentialRejected) {
        this.#credentialRejected = true;
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
      return { kind: 'permanent' };
    }

    if (status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.has(status)) {
      // The service read the batch and refused it. Sending the same bytes again
      // would get the same answer, so the batch is abandoned and the developer
      // is told once per occurrence rather than once per attempt.
      this.#log('warn', 'the local service refused a telemetry batch', {
        status,
        events: eventCount,
      });
      return { kind: 'permanent' };
    }

    this.#log('debug', 'the local service could not accept a telemetry batch', {
      status,
      events: eventCount,
    });
    return { kind: 'retry' };
  }

  /*
   * -------------------------------------------------------------------------
   * Clock offset
   * -------------------------------------------------------------------------
   */

  /**
   * Read the process clock for a clock sample, never throwing.
   *
   * Runs on the post path, so a clock that throws — only an injected one can —
   * must cost the sample and never the batch: the reading becomes `NaN`, which
   * the estimator counts as a rejected sample, and the failure is counted as
   * an internal error because it is a defect in something this processor was
   * handed.
   *
   * @returns Epoch milliseconds, or `NaN` when the clock gave no number.
   */
  #readClock(): number {
    try {
      const value: unknown = this.#now();
      return typeof value === 'number' ? value : Number.NaN;
    } catch (error) {
      this.#internalErrors += 1;
      this.#log('debug', 'the process clock could not be read for a clock sample', {
        error: describeError(error),
      });
      return Number.NaN;
    }
  }

  /**
   * Offer one ingest answer's `Date` header to the clock-offset estimate.
   *
   * Every status counts: the service writes a `Date` on a `401` and a `503`
   * exactly as on a `204`, and it is the service's clock either way. A
   * response with no `Date` is no sample; one whose value is not a canonical
   * IMF-fixdate is a rejected one. A response double with no `headers` at all
   * — `fetchImpl` is injectable — is treated as carrying none.
   *
   * The first estimate and every restart are written at `debug`, with the
   * numbers only: the offset, its interval and the sample count. Nothing here
   * can reach the credential, and nothing here throws.
   *
   * @param response The settled answer, before its body is released.
   * @param sentAt The process clock immediately before the request.
   * @param receivedAt The process clock immediately after the answer arrived.
   */
  #observeServiceClock(response: Response, sentAt: number, receivedAt: number): void {
    try {
      const headers = (response as Partial<Response>).headers;
      if (typeof headers?.get !== 'function') {
        return;
      }

      const hadEstimate = this.#clock.estimate() !== undefined;
      const outcome = this.#clock.observeHttpDate(headers.get('date'), sentAt, receivedAt);
      const firstEstimate = outcome === 'accepted' && !hadEstimate;
      if (outcome !== 'reset' && !firstEstimate) {
        return;
      }

      const snapshot = this.#clock.snapshot();
      this.#log(
        'debug',
        outcome === 'reset'
          ? "the local service's clock moved against this process's; the clock offset estimate restarted"
          : "this process's clock offset against the local service was estimated",
        {
          offsetMs: snapshot.offsetMs,
          lowerBoundMs: snapshot.lowerBoundMs,
          upperBoundMs: snapshot.upperBoundMs,
          samples: snapshot.samples,
        },
      );
    } catch (error) {
      // A response whose header bag threw. The batch's outcome is decided by
      // its status on the next line of the caller, not by this.
      this.#internalErrors += 1;
      this.#log('debug', 'the local service clock could not be sampled', {
        error: describeError(error),
      });
    }
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
   * on — a full buffer, a refused credential, a refused batch, events the
   * service received and did not store — which is exactly the threshold
   * `./config.ts` documents.
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
