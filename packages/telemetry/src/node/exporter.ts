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
 * | Body | `{ projectRoot, events, armedCaptureId, droppedCount?, lossReportId? }`: `events` is {@link TelemetryEventIngress}[] of one capture (empty only in a loss report), `armedCaptureId` that capture, `droppedCount` the count of the loss report the post carries, a positive integer and omitted when there is none, and `lossReportId` that report's stable identity, present exactly when `droppedCount` is |
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
 * else. The capture a batch was recorded in travels once, beside the events,
 * as the body's `armedCaptureId` — never on an event (*One capture per post,
 * and the loss it reports*).
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
 *    it started, and `onEnd` rejects a stamp that is no longer current. The
 *    service assigns `sessionId`, `captureId` and `ingestSeq` on arrival and
 *    reads a batch's `armedCaptureId` only to refuse a batch naming a capture
 *    other than the one it has open, so a span of capture A posted under A's
 *    name after capture B was armed would be refused there. This rule is the
 *    defence in depth in front of that refusal, and the only defence against
 *    what the service cannot see: a capture re-armed **under the same id**,
 *    where only the generation tells the earlier window's work from the new
 *    one's. The stamp also scopes the event's sequence, so the number a span
 *    is given belongs to the capture it ran in. Attribution cannot be corrected
 *    downstream, which is why `./control.ts` flushes the outgoing capture
 *    before it arms the next one — that is what gets A's finished spans out
 *    while A is still the capture the service has open.
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
 * the relevant evidence — and the loss is counted and reported to the service
 * (next section) so a capture is recorded as thinned rather than silently
 * wrong. One warning is written per flush window, never one per event: a flood
 * of lines in someone else's terminal is itself a defect.
 *
 * Drains are serialised on a promise chain, so one batch is in flight at a
 * time and a batch is never posted twice. A batch is taken out of the buffer
 * before it is posted and **is not re-queued on failure**: it is retried in
 * place, bounded by {@link MAX_POST_ATTEMPTS} attempts over a backoff that
 * starts at {@link RECONNECT_MIN_MS}, doubles under a
 * {@link RECONNECT_MAX_MS} ceiling and carries ±25 % jitter
 * ({@link computeIngestBackoffMs}) so several attached dev servers do not
 * retry in lockstep after the service restarts, and then dropped,
 * counted and reported as its capture's loss. Re-queuing would let one
 * unsendable batch cycle forever and starve the evidence behind it; losing
 * dev-time telemetry is acceptable, degrading the developer's dev server never
 * is.
 *
 * A `2xx` ends a batch's attempts whatever its body says. It is the service's
 * decision about those bytes, and sending them again gets the same decision —
 * so a batch the service received and stored nothing of is counted as refused
 * rather than retried, and never as delivered (*What is read of an answer*).
 *
 * ## One capture per post, and the loss it reports
 *
 * Every buffered event keeps the capture it was recorded in — the capture its
 * span was stamped with, which rule 2 has proved is the one in force when it
 * ended — and every post names that capture as `armedCaptureId`. A post never
 * mixes captures: a drain takes the contiguous run of the oldest event's
 * capture, up to {@link BATCH_MAX_EVENTS}, and since captures only ever move
 * forward, the old capture's events all precede the new one's. The body is
 * serialised once, so a batch retried across a capture stop and start still
 * names the capture it was recorded in on every attempt, and the service
 * refuses it whole rather than storing it under the next capture.
 *
 * Evidence this processor loses is reported, not only counted. A per-capture
 * ledger, at most {@link MAX_LOSS_LEDGER_CAPTURES} captures in arming order,
 * is credited with the events the buffer cap evicted, the events of a batch
 * that failed every attempt or was refused outright, and those of a batch that
 * could not be serialised. A failed batch's events are credited
 * conservatively: a request that timed out may have been stored by the
 * service before its answer was lost, so for such a batch the count is an
 * upper bound. Only the figure can overstate — the events themselves are
 * idempotent in the store, so a batch that did arrive is held once.
 *
 * Loss travels as a *report* with a stable identity. The first post for a
 * capture with unreported loss mints a random `lossReportId` and moves the
 * capture's whole pending count into that report, and the body carries it as
 * `droppedCount` beside `lossReportId`; every retry of the post sends the same
 * bytes. A `2xx` delivers the report, whatever the acknowledgement says. Any
 * other end — the attempts exhausted, a permanent refusal — leaves it exactly
 * as it was, and the capture's next post resends the same id and the same
 * count rather than handing the count back to be re-reported under a new
 * name. That is what makes retries and resends safe: the service applies a
 * report at most once per capture and id, so a report it recorded before
 * answering `5xx`, or whose `2xx` never arrived, is not counted twice. Loss
 * recorded while a report is outstanding — the failed batch's own events among
 * it — waits beside the report and becomes a new one, under a new id, only
 * once the outstanding report is delivered: a capture holds at most one report
 * at a time, and a count is never folded into a report that has already been
 * sent.
 *
 * A capture with loss pending and no buffered event left gets loss-only
 * reports, `{ projectRoot, events: [], armedCaptureId, droppedCount, lossReportId }`,
 * at the end of a drain: its outstanding report first, then one for the loss
 * recorded behind it. Never in a drain where a batch has just failed, because
 * the transport is down or refusing and the report would only fail with it;
 * and never on a timer of its own, because a service that is away must not be
 * polled: the next event, the flush `./control.ts` makes on every stop and
 * re-arm, or the shutdown drain carries it. The report names the ledger's
 * capture, never the gate's — `./control.ts` clears the gate before its
 * disable-path flush.
 *
 * What is not loss is not reported: spans a drop rule refused (by design, and
 * a replaced capture's would be refused by the service anyway), events the
 * service received and did not store (it already knows), and evidence
 * discarded after the credential was refused (nothing can be posted again).
 * Loss that can no longer be reported is abandoned and counted rather than
 * held for a post that cannot happen: the oldest capture's when the ledger
 * passes its bound, and all of it when the credential is refused or when
 * `shutdown()` finishes. The one exception is a report riding on a post still
 * in flight, which that post settles: reported on a `2xx`, and otherwise
 * abandoned unless its capture's entry survived and a reopened processor can
 * still resend it.
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
 *   counts. The batch is counted as posted in full,
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

import { newSpanId, nowEpochMs } from '@debuggen/shared';
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
 * status tables, the acknowledgement's byte bound, the loss ledger's capture
 * bound and its per-capture report bound — describes the ingest contract
 * rather than the envelope, and says so where it is declared.
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

/**
 * Captures the loss ledger holds unreported loss for at once.
 *
 * Only the newest one or two entries can ever be delivered: the service
 * accepts a post only while it names the project's open capture, and captures
 * move forward, never back. An older entry lives on only because the flush
 * `./control.ts` makes on a stop or re-arm may still reach the service before
 * it moves on. Eight is several stop/re-arm cycles during one outage of the
 * service with room to spare, while the ledger stays eight short ids and
 * counts however long the dev server runs. Past the bound the oldest capture —
 * the one certain to be closed — has its pending loss, both its outstanding
 * report and what waits behind it, moved to
 * {@link DebuggenSpanProcessorStats.abandonedLossEvents}.
 *
 * Exported so the suite drives the real bound rather than a copy of it.
 */
export const MAX_LOSS_LEDGER_CAPTURES = 8;

/**
 * Loss-only reports one drain sends for one capture, at most.
 *
 * Not a tunable but the shape of a ledger entry: a capture holds at most one
 * outstanding report and the loss recorded behind it, so emptying it takes the
 * outstanding report and then one new report for the rest. Stopping there is
 * what keeps a drain finite even if loss keeps arriving while its reports are
 * on the wire; whatever arrives is the next drain's.
 */
const LOSS_REPORTS_PER_CAPTURE = 2;

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
   * The reason it exists: the service assigns `sessionId`, `captureId` and
   * `ingestSeq` when it receives a batch (module documentation)
   * and reads the batch's `armedCaptureId` only to refuse one naming a capture
   * it no longer has open, so two windows armed under **one** capture id look
   * the same to it. Comparing {@link captureId} at `onEnd` does not catch a
   * replaced capture either: a span that started inside capture A and ends
   * after B was armed reads B's id, because that is the only id there is by
   * then.
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
 * {@link buffered}, which is the current queue depth, {@link pendingLossEvents},
 * which is the loss not yet reported, and {@link credentialRejected}, which is
 * a terminal state rather than a count.
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
   * A span that started inside capture A and ended after capture B was armed,
   * or after A was re-armed under the same id. Its work belongs to a window
   * the service has closed: posted under A's name it would be refused there as
   * a stale capture, and in a same-id re-arm nothing on the wire could tell it
   * from the new window's evidence. It is dropped before conversion and is not
   * reported as loss, since the capture it belongs to can no longer take it.
   * `./control.ts` flushes A before it arms B, which is what gets A's
   * *finished* spans out in time; this counter is the ones that were still
   * running.
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

  /**
   * Events lost with a batch that exhausted {@link MAX_POST_ATTEMPTS}.
   *
   * Conservative: an attempt that timed out may have been stored by the
   * service before its answer was lost, so this is an upper bound. The events
   * are idempotent in the store; only this count can overstate.
   */
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
   * Loss-only reports — `{ events: [], armedCaptureId, droppedCount,
   * lossReportId }` — the service answered with a `2xx`.
   *
   * Counted here and nowhere else: a loss report carries no event, so it is
   * never on {@link postedBatches}, {@link refusedBatches},
   * {@link unacknowledgedBatches} or {@link failedBatches}, and never moves
   * {@link postedEvents}. One that failed is not counted at all; its report
   * stays on {@link pendingLossEvents}, unchanged, for the capture's next post
   * to resend.
   */
  readonly lossReportBatches: number;

  /**
   * Lost events reported to the service as `droppedCount` in a post it
   * answered with a `2xx`, whether the count rode on a batch of events or on a
   * loss-only report.
   *
   * Credited once per report, when the first `2xx` for a post carrying it
   * arrives: the attempts and resends before it carried the same
   * `lossReportId` and count, which the service applies at most once.
   *
   * Every event credited to the loss ledger — {@link droppedOverflow},
   * {@link droppedFailedBatch} and {@link droppedUnserializable} — is on
   * exactly one of this, {@link pendingLossEvents} and
   * {@link abandonedLossEvents}, so the three always add up to those three.
   */
  readonly reportedLossEvents: number;

  /**
   * Lost events recorded and not yet reported: every capture's outstanding
   * report plus the loss waiting behind it, with a report riding on a post
   * that is in flight counted once.
   *
   * A current value, not a cumulative one. It falls when a report is
   * delivered or abandoned. A failed post leaves it unchanged: the report it
   * carried stays reserved, under the same id, rather than being handed back.
   */
  readonly pendingLossEvents: number;

  /**
   * Lost events whose report was given up: the oldest capture's pending loss
   * when the ledger passed {@link MAX_LOSS_LEDGER_CAPTURES}, everything pending
   * when the credential was refused, and everything still pending when
   * `shutdown()` finished.
   *
   * Non-zero means loss the service's capture ledger was never told of.
   */
  readonly abandonedLossEvents: number;

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
 * The `droppedCount` field of a diagnostic about one post, present only when
 * the post reported loss.
 *
 * Spread into a field bag, so a post that carried no loss is described by the
 * same fields it always was.
 *
 * @param droppedCount The loss the post carried, `0` for none.
 * @returns `{ droppedCount }`, or an empty bag.
 */
function lossField(droppedCount: number): { readonly droppedCount?: number } {
  return droppedCount > 0 ? { droppedCount } : {};
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
 * One converted event waiting in the buffer, with the capture it was recorded
 * in.
 *
 * The capture travels beside the event rather than on it, because the ingress
 * schema is strict and `captureId` is a key only the service may assign; it is
 * what a drain groups by and what the post's `armedCaptureId` names.
 */
interface BufferedEvent {
  /** The event, exactly as it will be posted. */
  readonly event: TelemetryEventIngress;
  /** The capture the event's span was recorded in: never `null` once buffered. */
  readonly captureId: string;
}

/**
 * One capture's loss as the service is told of it: a count under an identity
 * that never changes (module overview, *One capture per post, and the loss it
 * reports*).
 *
 * Minted when a post first carries the capture's pending loss, and then sent
 * unchanged — the same id, the same count — by every attempt and every resend
 * until a `2xx` delivers it. The service applies a report at most once per
 * capture and id, which is what makes resending one it may already have
 * recorded safe.
 */
interface LossReport {
  /**
   * The report's identity, `lossReportId` on the wire: 16 random lowercase
   * hex characters from `@debuggen/shared`'s `newSpanId`, unique per report
   * and derived from nothing this process holds.
   */
  readonly id: string;
  /** The lost events it reports, `droppedCount` on the wire; at least one. */
  readonly count: number;
}

/**
 * One capture's unreported loss in the ledger.
 *
 * Two parts, because a count that has travelled under an id can never again
 * be merged with one that has not: `reserved` is the report already minted and
 * possibly already recorded by the service, `unreserved` the loss recorded
 * since, which becomes a report of its own only once `reserved` is delivered.
 * An entry exists only while one of the two is non-empty.
 */
interface LossLedgerEntry {
  /** The capture's outstanding report, resent unchanged until delivered. */
  reserved: LossReport | undefined;
  /** Loss recorded and not yet in any report; `0` when there is none. */
  unreserved: number;
}

/**
 * Everything one ingest post carries besides the project root.
 *
 * A batch of events has at least one event; a loss-only report has none and
 * carries a {@link LossReport}. Without one the body omits `droppedCount` and
 * `lossReportId` both, rather than sending a zero or an id with no count.
 */
interface IngestPayload {
  /** The capture every event of the post was recorded in. */
  readonly armedCaptureId: string;
  /** The events, all of that capture; empty only in a loss-only report. */
  readonly events: readonly TelemetryEventIngress[];
  /** That capture's report riding on this post, or `undefined` for none. */
  readonly lossReport: LossReport | undefined;
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

  /**
   * Converted events waiting for a flush, each with its capture; the oldest is
   * at index 0, so one capture's events form one contiguous run.
   */
  readonly #buffer: BufferedEvent[] = [];

  /**
   * Unreported loss per capture, in the order the captures were first credited
   * (module overview, *One capture per post, and the loss it reports*).
   *
   * Bounded to {@link MAX_LOSS_LEDGER_CAPTURES} entries. Entries are updated
   * in place, so a capture keeps its position however many times its report
   * is resent or its loss grows, and the bound always evicts the capture that
   * was credited first.
   */
  readonly #lossLedger = new Map<string, LossLedgerEntry>();

  /**
   * The report riding on the post in flight, or `undefined`.
   *
   * One suffices because drains are serialised and a drain posts one body at a
   * time. It is what lets the ledger be evicted or abandoned while that post
   * is on the wire without the report being counted twice: whatever happens to
   * its entry meanwhile, the post settles the report itself, and
   * {@link DebuggenSpanProcessorStats.pendingLossEvents} counts it here and
   * nowhere else until then.
   */
  #lossReportInFlight: LossReport | undefined;

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
   * transport has stopped" are the same fact. Keeping only the first would make
   * the hint's own promise — *server-side telemetry stops until the dev server
   * is relaunched* — a claim nothing enforces, with the drain still posting to
   * the endpoint that had just refused it.
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

  /** {@link DebuggenSpanProcessorStats.lossReportBatches} */
  #lossReportBatches = 0;

  /** {@link DebuggenSpanProcessorStats.reportedLossEvents} */
  #reportedLossEvents = 0;

  /** {@link DebuggenSpanProcessorStats.abandonedLossEvents} */
  #abandonedLossEvents = 0;

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
      lossReportBatches: this.#lossReportBatches,
      reportedLossEvents: this.#reportedLossEvents,
      pendingLossEvents: this.#pendingLossEvents(),
      abandonedLossEvents: this.#abandonedLossEvents,
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
      // rule that keeps one capture's evidence out of another's: a replaced
      // capture's span would be posted naming a capture the service has
      // closed, and a same-id re-arm's could not be told apart there at all.
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

      // The capture the span *ran in*, which the stale check has just proved
      // is the current one — stated through the stamp where there is one so
      // the sequence a span is numbered in, and the capture its post names,
      // cannot belong to another capture.
      const recordedIn = stamp?.captureId ?? captureId;
      const context: ConvertContext = {
        captureId: recordedIn,
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
      this.#enqueue(clockOffsetMs === undefined ? event : { ...event, clockOffsetMs }, recordedIn);
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
   * {@link SHUTDOWN_FLUSH_DEADLINE_MS}. The final drain also carries every
   * capture's pending loss, as a loss-only report where no event of that
   * capture is left to carry it. Anything still queued afterwards is abandoned
   * and counted rather than held, and so is any loss still unreported.
   * Idempotent, and it never rejects.
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

    // Nothing posts after this point, so pending loss has no future carrier;
    // a post the deadline left in flight settles its own reservation, and
    // what it hands back lands on the abandoned counter directly.
    this.#abandonPendingLoss('shutdown');
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
   * before the one under investigation. Every discarded event is counted and
   * credited to the loss ledger under the capture it was recorded in, and the
   * warning is deferred to the next flush window so a burst produces one line
   * rather than thousands.
   *
   * @param event A converted, ingest-ready event.
   * @param captureId The capture its span was recorded in.
   */
  #enqueue(event: TelemetryEventIngress, captureId: string): void {
    if (this.#buffer.length >= MAX_BUFFERED_EVENTS) {
      const overflow = this.#buffer.length - MAX_BUFFERED_EVENTS + 1;
      const evicted = this.#buffer.splice(0, overflow);
      this.#droppedOverflow += overflow;
      this.#overflowSinceWarning += overflow;
      for (const entry of evicted) {
        this.#recordLoss(entry.captureId, 1);
      }
    }

    this.#buffer.push({ event, captureId });

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
   * Post the buffer, one single-capture batch at a time, up to
   * {@link MAX_DRAIN_BATCHES}, then report the loss no batch carried.
   *
   * The cap is what makes this terminate on a server that is producing spans as
   * fast as they are being posted: whatever arrives after it is reached belongs
   * to the next window. A buffer spanning several captures needs one batch more
   * per capture boundary, and what the cap leaves behind is likewise the next
   * window's. Batches are taken out of the buffer before they are posted, so an
   * event is never sent twice, and a batch that could not be delivered is
   * dropped rather than re-queued (module overview) — its events credited to
   * its capture's loss.
   *
   * A delivered batch is accounted by what its acknowledgement said
   * ({@link #recordAcknowledgement}), and whatever the service refused during
   * the drain is summarised once at its end ({@link #reportRefusals}). The
   * loss-only reports ({@link #reportPendingLoss}) follow the batches and are
   * skipped when one of them failed; they are bounded by
   * {@link LOSS_REPORTS_PER_CAPTURE} for each of the ledger's
   * {@link MAX_LOSS_LEDGER_CAPTURES}, so they cannot keep a drain alive either.
   *
   * Never throws, whatever a batch does.
   *
   * @param mode `normal` for the full attempt budget, `final` for one attempt.
   */
  async #drain(mode: DrainMode): Promise<void> {
    this.#reportOverflow();
    // This drain takes the buffer, so a window armed for what is in it has
    // nothing left to flush. Left armed, it would fire a drain holding only
    // pending loss and send a loss-only report on a timer — the polling of an
    // absent service that loss alone must never cause. The end of this drain
    // re-arms a window for whatever it leaves behind or arrives meanwhile.
    this.#clearFlushTimer();

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
      // Set when a batch of this drain got no answer the service stood behind:
      // the transport is down or refusing, and a loss report sent now would
      // only fail with it, so the reports wait for the next drain.
      let batchFailed = false;

      for (let batches = 0; batches < MAX_DRAIN_BATCHES; batches += 1) {
        const batch = this.#takeBatch();
        if (batch === undefined) {
          break;
        }
        const { captureId, events } = batch;
        const outcome = await this.#postCarryingLoss(
          captureId,
          events,
          this.#reserveLoss(captureId),
          attempts,
        );

        if (outcome.kind === 'sent') {
          this.#recordAcknowledgement(events.length, outcome.reading);
          continue;
        }

        this.#failedBatches += 1;
        if (outcome.kind === 'unserializable') {
          this.#droppedUnserializable += events.length;
        } else {
          this.#droppedFailedBatch += events.length;
          batchFailed = true;
        }
        this.#recordLoss(captureId, events.length);

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

      if (!batchFailed) {
        await this.#reportPendingLoss(attempts);
        // A loss report can be what the endpoint refuses the credential on.
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
   * every piece of evidence this condition cost. The discarded events are not
   * loss the service is told about — no post can reach it again — and the loss
   * that was already pending is abandoned for the same reason. Diagnostics stay
   * at `debug`: the one line a developer can act on was already written at
   * `warn`, once.
   */
  #discardAfterCredentialRejection(): void {
    this.#abandonPendingLoss('credential-rejected');

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

  /**
   * Take the next batch out of the buffer: the contiguous run of the oldest
   * event's capture, at most {@link BATCH_MAX_EVENTS} long.
   *
   * Contiguity is enough because captures only move forward: every event of
   * the capture being replaced was buffered before the first event of the one
   * replacing it, so the run ends exactly where the next capture begins and no
   * post ever mixes two.
   *
   * @returns The batch and the capture it was recorded in, or `undefined` when
   * the buffer is empty.
   */
  #takeBatch():
    { readonly captureId: string; readonly events: TelemetryEventIngress[] } | undefined {
    const head = this.#buffer[0];
    if (head === undefined) {
      return undefined;
    }
    const { captureId } = head;
    const limit = Math.min(this.#buffer.length, BATCH_MAX_EVENTS);
    let run = 1;
    while (run < limit && this.#buffer[run]?.captureId === captureId) {
      run += 1;
    }
    const taken = this.#buffer.splice(0, run);
    return { captureId, events: taken.map((entry) => entry.event) };
  }

  /**
   * Send the loss-only reports for every capture whose loss is pending and no
   * event of which is still buffered to carry it.
   *
   * A capture that still has buffered events is skipped, because its next
   * batch carries the report. Otherwise it gets up to
   * {@link LOSS_REPORTS_PER_CAPTURE}: its outstanding report, resent under the
   * same id, and then — once that one is delivered — a new report for the loss
   * recorded behind it, so a capture is emptied in one drain rather than one
   * report per drain. The walk follows the ledger's order, oldest capture
   * first, over a snapshot of its keys — a report's settlement and an overflow
   * during a post both write the ledger — and stops at the first report that
   * fails to reach the service, leaving the rest pending for the next drain
   * rather than failing each of them in turn. It is never scheduled on its
   * own: loss alone arms no flush window.
   *
   * @param attempts Attempts each report gets, as the drain's batches do.
   */
  async #reportPendingLoss(attempts: number): Promise<void> {
    const captures = [...this.#lossLedger.keys()];
    for (const captureId of captures) {
      for (let sent = 0; sent < LOSS_REPORTS_PER_CAPTURE; sent += 1) {
        if (this.#credentialRejected) {
          return;
        }
        if (this.#buffer.some((entry) => entry.captureId === captureId)) {
          break;
        }
        // `undefined` when the capture has nothing pending, and also when no
        // identity could be minted: a report is never posted without one.
        const lossReport = this.#reserveLoss(captureId);
        if (lossReport === undefined) {
          break;
        }

        const outcome = await this.#postCarryingLoss(captureId, [], lossReport, attempts);
        if (outcome.kind === 'failed') {
          return;
        }
        if (outcome.kind === 'unserializable') {
          break;
        }
        this.#lossReportBatches += 1;
      }
    }
  }

  /*
   * -------------------------------------------------------------------------
   * Loss ledger
   * -------------------------------------------------------------------------
   */

  /**
   * Post one capture's events with that capture's loss report on the body, and
   * settle the report whatever becomes of the post.
   *
   * The report is marked as in flight for exactly as long as the post runs,
   * and the `finally` is what guarantees it is settled — delivered, kept for a
   * resend, or abandoned — even if something below were to throw.
   *
   * @param captureId The capture the events were recorded in.
   * @param events Its events; empty for a loss-only report.
   * @param lossReport The report {@link #reserveLoss} returned for the
   * capture, or `undefined` when no loss rides on this post.
   * @param attempts Attempts the post gets.
   * @returns What became of the post. The events' own loss is the caller's to
   * credit; only the report is settled here.
   */
  async #postCarryingLoss(
    captureId: string,
    events: readonly TelemetryEventIngress[],
    lossReport: LossReport | undefined,
    attempts: number,
  ): Promise<BatchOutcome> {
    this.#lossReportInFlight = lossReport;
    let delivered = false;
    try {
      const outcome = await this.#postBatch(
        { armedCaptureId: captureId, events, lossReport },
        attempts,
      );
      delivered = outcome.kind === 'sent';
      return outcome;
    } finally {
      this.#lossReportInFlight = undefined;
      if (lossReport !== undefined) {
        this.#settleReservation(captureId, lossReport, delivered);
      }
    }
  }

  /**
   * The report the capture's next post carries: its outstanding one, or a new
   * one holding everything pending.
   *
   * An outstanding report is returned as it is — same object, same id, same
   * count — however many posts it has already ridden on, because the service
   * may have recorded it on any of them. Only a capture with no outstanding
   * report mints one, moving its whole unreserved count into it; the entry is
   * updated in place, so the capture keeps its position in the ledger.
   *
   * @param captureId The capture the post names.
   * @returns The report to send, or `undefined` when nothing is pending or no
   * identity could be minted — in which case the loss stays where it was.
   */
  #reserveLoss(captureId: string): LossReport | undefined {
    const entry = this.#lossLedger.get(captureId);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.reserved !== undefined) {
      return entry.reserved;
    }
    if (entry.unreserved <= 0) {
      return undefined;
    }
    const id = this.#mintLossReportId();
    if (id === undefined) {
      return undefined;
    }
    const report: LossReport = { id, count: entry.unreserved };
    entry.reserved = report;
    entry.unreserved = 0;
    return report;
  }

  /**
   * A fresh `lossReportId`: 16 random lowercase hex characters.
   *
   * `@debuggen/shared`'s span-id generator, because it is the random id this
   * process already draws from Web Crypto — unique per call, well inside the
   * identifier grammar (1 to 64 characters, no whitespace) and derived from
   * nothing the process holds, the credential least of all. It throws only on
   * a host with no working randomness source, and then the loss is left
   * unreserved and the post travels without it rather than under an identity
   * that could collide.
   *
   * @returns The id, or `undefined` when none could be generated.
   */
  #mintLossReportId(): string | undefined {
    try {
      return newSpanId();
    } catch (error) {
      this.#internalErrors += 1;
      this.#log(
        'debug',
        'a telemetry loss report could not be given an identity; its loss stays pending',
        {
          error: describeError(error),
        },
      );
      return undefined;
    }
  }

  /**
   * Settle a report once the post that carried it has concluded.
   *
   * A `2xx` delivers it, whatever its acknowledgement said: it is the
   * service's decision about those bytes, exactly as for the events. Anything
   * else leaves it exactly as it was — the same object on the capture's entry,
   * never merged into the loss recorded since and never given a new id — so
   * the capture's next post resends what the service may already have
   * recorded, and the service's per-report deduplication absorbs it.
   *
   * The report is abandoned instead when nothing could resend it: its entry
   * was evicted or abandoned while the post was on the wire, or the
   * credential has been refused, or `shutdown()` has finished.
   *
   * @param captureId The capture the post named.
   * @param report The report the post carried.
   * @param delivered Whether the service answered the post with a `2xx`.
   */
  #settleReservation(captureId: string, report: LossReport, delivered: boolean): void {
    const entry = this.#lossLedger.get(captureId);
    const held = entry?.reserved === report;

    if (delivered) {
      this.#reportedLossEvents += report.count;
    } else if (held && !this.#credentialRejected && !this.#shutdownComplete) {
      return;
    } else {
      this.#abandonedLossEvents += report.count;
    }

    if (entry !== undefined && held) {
      entry.reserved = undefined;
      if (entry.unreserved === 0) {
        this.#lossLedger.delete(captureId);
      }
    }
  }

  /**
   * Credit lost events to the capture they were recorded in.
   *
   * Called for events the buffer cap evicted and for the events of a batch
   * that failed or could not be serialised. The count joins the capture's
   * unreserved loss, never its outstanding report, whose count has already
   * travelled under its id. Once the credential has been refused or
   * `shutdown()` has finished no post can carry the count, so it goes
   * straight to {@link DebuggenSpanProcessorStats.abandonedLossEvents}. A
   * capture new to a full ledger evicts the oldest one, whose pending loss is
   * abandoned.
   *
   * @param captureId The capture the events belonged to.
   * @param events How many were lost; nothing happens for fewer than one.
   */
  #recordLoss(captureId: string, events: number): void {
    if (events <= 0) {
      return;
    }
    if (this.#credentialRejected || this.#shutdownComplete) {
      this.#abandonedLossEvents += events;
      return;
    }

    const entry = this.#lossLedger.get(captureId);
    if (entry !== undefined) {
      // In place: the capture keeps its position in the ledger.
      entry.unreserved += events;
      return;
    }

    this.#lossLedger.set(captureId, { reserved: undefined, unreserved: events });
    if (this.#lossLedger.size <= MAX_LOSS_LEDGER_CAPTURES) {
      return;
    }

    const oldest = this.#lossLedger.entries().next();
    if (oldest.done === true) {
      return;
    }
    const [evictedCapture, evictedEntry] = oldest.value;
    this.#lossLedger.delete(evictedCapture);
    const evictedEvents = this.#releaseEntry(evictedEntry);
    this.#abandonedLossEvents += evictedEvents;
    this.#log('debug', 'the oldest capture with unreported telemetry loss was abandoned', {
      events: evictedEvents,
      ledgerLimit: MAX_LOSS_LEDGER_CAPTURES,
      abandonedTotal: this.#abandonedLossEvents,
    });
  }

  /**
   * Abandon every pending count: no post will carry it.
   *
   * A report riding on a post still in flight is not touched, and neither is
   * the entry holding it; that post settles it, reporting it on a `2xx` and
   * otherwise abandoning it unless the processor was reopened meanwhile
   * ({@link #settleReservation}). Every other report, and all unreserved loss,
   * is abandoned and its entry removed.
   *
   * @param reason Why nothing more can be reported, for the diagnostic.
   */
  #abandonPendingLoss(reason: 'credential-rejected' | 'shutdown'): void {
    let events = 0;
    for (const [captureId, entry] of this.#lossLedger) {
      events += this.#releaseEntry(entry);
      if (entry.reserved === undefined) {
        // Deleting the entry being visited is safe during `Map` iteration.
        this.#lossLedger.delete(captureId);
      }
    }
    if (events === 0) {
      return;
    }
    this.#abandonedLossEvents += events;
    this.#log('debug', 'unreported telemetry loss was abandoned', {
      events,
      reason,
      abandonedTotal: this.#abandonedLossEvents,
    });
  }

  /**
   * Empty an entry of everything no post in flight will settle, and say how
   * much that was.
   *
   * The unreserved loss is always released, and so is the outstanding report
   * unless it is the one on the wire: {@link #postCarryingLoss} settles that
   * one itself, so releasing it here as well would count it twice. The caller
   * adds the result to {@link DebuggenSpanProcessorStats.abandonedLossEvents}
   * and decides what becomes of the entry.
   *
   * @param entry The entry being abandoned.
   * @returns The events released from it.
   */
  #releaseEntry(entry: LossLedgerEntry): number {
    let events = entry.unreserved;
    entry.unreserved = 0;
    if (entry.reserved !== undefined && entry.reserved !== this.#lossReportInFlight) {
      events += entry.reserved.count;
      entry.reserved = undefined;
    }
    return events;
  }

  /**
   * The loss recorded and not yet reported or abandoned: every entry's
   * outstanding report and unreserved loss, with the report on the post in
   * flight counted once — here, rather than through its entry, since the
   * entry may have been evicted or abandoned while the post is on the wire.
   *
   * @returns {@link DebuggenSpanProcessorStats.pendingLossEvents}.
   */
  #pendingLossEvents(): number {
    const inFlight = this.#lossReportInFlight;
    let total = inFlight?.count ?? 0;
    for (const entry of this.#lossLedger.values()) {
      total += entry.unreserved;
      if (entry.reserved !== undefined && entry.reserved !== inFlight) {
        total += entry.reserved.count;
      }
    }
    return total;
  }

  /*
   * -------------------------------------------------------------------------
   * Transport
   * -------------------------------------------------------------------------
   */

  /**
   * Serialise one batch — or one loss-only report — and post it, retrying
   * within the attempt budget.
   *
   * The body is built once and reused across attempts: it cannot change between
   * them, re-serialising would be the most expensive part of a retry, and the
   * bytes the first attempt sent are the ones every retry must send. That
   * includes `armedCaptureId`: a batch retried after the gate was re-armed for
   * another capture still names the capture its events were recorded in. It
   * includes the loss report too: every attempt carries the same
   * `lossReportId` and `droppedCount`, so an attempt the service recorded
   * before its answer was lost is recognised when the next one arrives.
   *
   * @param payload The capture, its events (already removed from the buffer)
   * and the loss report riding on this post.
   * @param maxAttempts Attempts permitted, at least one.
   * @returns What became of the post.
   */
  async #postBatch(payload: IngestPayload, maxAttempts: number): Promise<BatchOutcome> {
    const { armedCaptureId, events, lossReport } = payload;
    const droppedCount = lossReport?.count ?? 0;
    if (events.length === 0 && lossReport === undefined) {
      // Nothing to send and nothing to count: an acknowledgement of zero events
      // lands on no counter, and an empty batch reporting no loss is one the
      // service refuses.
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
      // The `POST /telemetry/ingest` body plus its delivery context: the
      // credential's project root and the events `./convert.ts` produced,
      // carrying nothing but the `clockOffsetMs` `onEnd` stamped when each was
      // created; the capture they were recorded in; and that capture's loss
      // report, `droppedCount` with its `lossReportId`, present only when
      // there is one, because the contract admits no zero count and no id
      // without a count.
      // Serialised once: every retry below sends these bytes, so no event is
      // ever restamped, no retry renames its capture and no retry re-identifies
      // its loss.
      const projectRoot = this.#config.projectRoot;
      body = JSON.stringify(
        lossReport === undefined
          ? { projectRoot, events, armedCaptureId }
          : {
              projectRoot,
              events,
              armedCaptureId,
              droppedCount: lossReport.count,
              lossReportId: lossReport.id,
            },
      );
    } catch (error) {
      this.#log('debug', 'a telemetry batch could not be serialised', {
        events: events.length,
        error: describeError(error),
      });
      return { kind: 'unserializable' };
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await this.#attemptPost(body, events.length, droppedCount);

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
      ...lossField(droppedCount),
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
   * @param body The serialised
   * `{ projectRoot, events, armedCaptureId, droppedCount?, lossReportId? }` payload.
   * @param eventCount How many events it carries: what the acknowledgement's
   * counts are clamped to, and a diagnostic field.
   * @param droppedCount The loss it reports, `0` for none; a diagnostic field.
   */
  async #attemptPost(body: string, eventCount: number, droppedCount: number): Promise<PostOutcome> {
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
        this.#logAcknowledgement(response.status, eventCount, droppedCount, reading);
        return { kind: 'sent', reading };
      }

      // A non-`2xx` body is never read: the status is the whole decision, and
      // the stream is released rather than left to the garbage collector
      // holding a connection.
      await releaseResponseBody(response);
      return this.#classifyRejection(response.status, eventCount, droppedCount);
    } catch (error) {
      // A refused connection, a DNS failure, an abort at the timeout, or a
      // `fetch` implementation that threw. All of them are moments rather than
      // answers, so the caller may try again.
      this.#log('debug', 'telemetry batch could not be delivered', {
        url: this.#config.ingestUrl,
        events: eventCount,
        ...lossField(droppedCount),
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
   * refusals is {@link #reportRefusals}, written once per drain at most. A
   * loss-only report has no event for an acknowledgement to count, so its
   * answer is recorded as delivering the loss and nothing more.
   *
   * @param status The `2xx` status.
   * @param eventCount Events in the batch.
   * @param droppedCount The loss the post reported, `0` for none.
   * @param reading What its acknowledgement said, or why it said nothing.
   */
  #logAcknowledgement(
    status: number,
    eventCount: number,
    droppedCount: number,
    reading: AcknowledgementReading,
  ): void {
    if (eventCount === 0) {
      this.#log('debug', 'telemetry loss report delivered', { status, droppedCount });
      return;
    }

    if (reading.kind === 'unacknowledged') {
      this.#log('debug', 'telemetry batch accepted without a readable acknowledgement', {
        events: eventCount,
        ...lossField(droppedCount),
        status,
        reason: reading.reason,
      });
      return;
    }

    const { accepted, rejected, clamped } = reading.acknowledgement;
    this.#log('debug', 'telemetry batch acknowledged', {
      events: eventCount,
      ...lossField(droppedCount),
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
   * @param droppedCount The loss the batch reported, `0` for none; diagnostics
   * only.
   */
  #classifyRejection(status: number, eventCount: number, droppedCount: number): PostOutcome {
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
        ...lossField(droppedCount),
      });
      return { kind: 'permanent' };
    }

    this.#log('debug', 'the local service could not accept a telemetry batch', {
      status,
      events: eventCount,
      ...lossField(droppedCount),
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
