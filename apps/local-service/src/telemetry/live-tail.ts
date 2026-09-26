/**
 * The bounded, redacted live tail: the stream that makes a capture feel alive.
 *
 * While the developer reproduces an issue, the DevTools panel's collapsible
 * `LiveTail` shows interaction, render, fetch and long-task events as they
 * arrive (AAP §0.7.3, §0.8.1 slice 6). This module is the service side of that
 * view: it coalesces the events `./ingest.ts` has just persisted into
 * `telemetry.tail` frames — `{ sessionId, events }`, service → DevTools over the
 * WebSocket (AAP §0.4.2) — and hands each frame to the injected session
 * broadcaster, which delivers it to the DevTools connection bound to the
 * session's tab and to nobody else.
 *
 * ## Where it sits in the ingest pipeline
 *
 * AAP §0.7.1 Group 2 fixes the order, and this module is its last step:
 *
 * 1. validate the producer's ingress event;
 * 2. compute `request_key` from the unredacted URL;
 * 3. redact (`redactEvent`, AAP §0.5.2 — "before any event is persisted or
 *    broadcast");
 * 4. attribute it to the bound session's active capture;
 * 5. persist it — the store assigns `ingestSeq`;
 * 6. correlate it incrementally;
 * 7. **tail it to DevTools — this module.**
 *
 * Redaction therefore happens two steps before anything reaches this file, and
 * this file never calls a redactor: a second, local redaction pass would be a
 * second opinion about what the privacy layer means, and a tail that "fixes"
 * events itself would hide the ingest defect that let them through.
 *
 * ## What it accepts: persisted events, and a provenance guard
 *
 * {@link LiveTail.push} takes `TelemetryEvent` — the **persisted** schema, which
 * is exactly what the `telemetry.tail` payload embeds — and never the ingress
 * type. That is deliberate and it is the first line of defence: the compiler
 * alone makes an unredacted tail impossible for any caller that keeps its
 * types.
 *
 * The second line is run-time, because a type is only a claim. Every event is
 * checked before it is buffered, and one that fails is counted in
 * `eventsRejected`, logged as a count, and never broadcast:
 *
 * - **It must parse as a persisted event.** A value that does not satisfy
 *   `telemetryEventSchema` — above all one without the store-assigned,
 *   one-based `ingestSeq` — did not come back out of the telemetry store, and
 *   the only way into the store is through ingest's redaction step. The
 *   store-assigned fields are the evidence that an event crossed the privacy
 *   boundary.
 * - **It must belong to the session it is pushed for.** An event attributed to
 *   another session would put one session's evidence on another session's
 *   screen.
 *
 * Why not a `redacted === true` flag: the event schema defines `redacted` as the
 * *list of attribute paths* the redactor replaced, absent when nothing needed
 * replacing (`packages/telemetry/src/schema/event.ts`), and both event schemas
 * are strict, so no boolean marker can exist. `redactor.ts` states the
 * consequence itself — provenance "is the ingest path's call ordering, not a
 * field" — and a check on the field would refuse every event that simply
 * carried nothing sensitive. The persisted-schema check is the faithful form of
 * the same guard.
 *
 * ## Pacing: coalesce, cap, drain
 *
 * Nothing is sent from `push`. Each session has one FIFO buffer and at most one
 * pending timer; the first event into an idle buffer arms that timer for
 * {@link TAIL_FLUSH_INTERVAL_MS}, and when it fires one frame of at most
 * {@link TAIL_MAX_EVENTS_PER_FRAME} events is sent in arrival order. If events
 * remain, the timer is re-armed, so a burst drains across several small frames
 * rather than one oversized one and the panel sees a steady stream. An explicit
 * {@link LiveTail.flush} — graceful shutdown, a test — drains the whole buffer
 * at once, still in frames of at most that size.
 *
 * While no DevTools connection receives the frames (see "Delivery") the same
 * timer becomes a retry: it is re-armed with an exponential backoff that starts
 * at the coalescing window and doubles up to {@link TAIL_RETRY_MAX_DELAY_MS}.
 * The first delivery that succeeds resets it, and the retained backlog then
 * drains at the normal pace.
 *
 * ## Bounds
 *
 * - **Per frame:** {@link TAIL_MAX_EVENTS_PER_FRAME}, a hard ceiling that the
 *   `maxEventsPerFrame` option may lower and never raise. It sits far below the
 *   5 000-event bound `telemetryTailPayloadSchema` enforces on every frame; that
 *   bound is module-local to `packages/protocol/src/messages/telemetry.ts` and
 *   deliberately not exported (the identically named `MAX_EVENTS_PER_BATCH` that
 *   `@debuggen/telemetry` exports is the browser agent's 200-event flush trigger,
 *   a different number), so it is not imported here — every frame is validated
 *   against the schema that owns it instead.
 * - **Per session buffer:** {@link TAIL_MAX_BUFFERED_EVENTS}. Past it the
 *   **oldest** buffered events are dropped. Oldest-first because the tail is a
 *   live view: the newest evidence is the evidence the developer is looking at,
 *   and nothing is lost — the authoritative record is already in the store,
 *   where panel-data queries read it. Two causes are told apart: overflow while
 *   frames are being delivered is an ordinary burst, counted in
 *   `eventsDropped`; overflow while an undelivered backlog is waiting for its
 *   panel is **tail truncation for an unreachable panel**, counted in
 *   `eventsTruncatedWhileUndelivered` and logged under its own message. The
 *   tail payload has no field for either count, so they go to
 *   {@link LiveTail.stats} and to the log, never onto the wire.
 * - **Undelivered backlog:** events no connection received stay buffered, at
 *   most the per-session bound, for at most
 *   {@link TAIL_UNDELIVERED_RETENTION_MS} from the first undelivered attempt of
 *   the outage. A panel that reconnects inside that window receives the
 *   backlog — its newest `maxBufferedEvents` events, in their original order —
 *   and then the live stream: that is the bounded replay on reconnect. Once the
 *   window has passed with no delivery the backlog is released, counted in
 *   `eventsExpired`, and the retry timer stops until the next push re-arms it.
 * - **Duplicates:** `TelemetryRepo.insertMany` answers a replayed agent batch
 *   (`ON CONFLICT(id) DO NOTHING`) with the stored rows, so ingest may push an
 *   event the tail has already buffered or sent. Each session keeps a bounded
 *   window of recent event ids — twice the buffer bound, which always covers the
 *   whole buffer plus at least as many recently sent ids — and skips a repeat,
 *   counting it in `duplicatesSkipped`. That is not an error, and it holds for
 *   an undelivered backlog too: those events are still buffered, so a replay
 *   of them is skipped rather than queued twice.
 * - **Sessions:** a session's state lives while it has buffered events or a
 *   pending timer; idle states beyond a small bound are released least recently
 *   used first, and {@link LiveTail.forget} releases one explicitly.
 *
 * ## Delivery: only the bound tab
 *
 * Every frame goes through `broadcaster.broadcastToKinds(sessionId,
 * TAIL_CLIENT_KINDS, frame)`. The service's client registry resolves the
 * `devtools` kind to the one DevTools connection bound to this session's tab
 * (AAP §0.4.2: the binding is the deterministic recipient of `telemetry.tail`),
 * so this module never broadcasts to every client, never reaches the editor,
 * and never builds a per-tab route of its own. The broadcaster is a
 * {@link TailBroadcaster}: the `SessionBroadcaster` port `../sessions/manager.ts`
 * declares, narrowed so `broadcastToKinds` answers how many connections
 * received the frame. That count is the **delivery receipt**, and no WebSocket
 * or HTTP detail reaches this folder.
 *
 * A frame counts as delivered only when the receipt is a positive number. `0`
 * — the bound tab has no online DevTools connection because the panel is
 * closed or reconnecting, no tab is bound, or the registry refused the frame —
 * and a broadcast that throws both leave the frame **undelivered**, and an
 * undelivered frame is never dequeued: the drain reads the front of the buffer,
 * sends it, and removes exactly those events only once the receipt confirms
 * them. So the frame stays first in line, its ids stay in the dedupe window
 * (they are still buffered), and the retry delivers it — and everything behind
 * it — in the original order.
 *
 * ## Failure
 *
 * Nothing here throws — not `push`, not `flush`, not a timer callback, and not
 * when an injected broadcaster, scheduler, clock or logger does. Every frame is
 * validated with `parseTelemetryTailPayload` (the non-throwing form of
 * `telemetryTailPayloadSchema.safeParse`) before it is built, so no frame that
 * would fail the schema is ever emitted. Failures come in two kinds:
 *
 * - **Invalid** — the frame fails validation or its envelope cannot be built.
 *   That is deterministic, so retrying could only fail again: the frame's
 *   events are discarded from the tail (the store holds them), counted in
 *   `framesFailed`/`eventsFailed`, and draining continues with the next frame.
 * - **Undelivered** — zero recipients or a throwing broadcast. That is a
 *   transport condition, so nothing is discarded: the attempt is counted in
 *   `framesUndelivered`, the backlog is kept in order and retried with backoff
 *   (see "Pacing"), and it is released only when the retention window of
 *   "Bounds" runs out.
 *
 * ## Logging
 *
 * Through the injected `Logger`, message-first, bound to
 * `subsystem: "telemetry.live-tail"` and the `sessionId`. **Counts only** —
 * never an event `name`, an attribute value, a URL or a `db.statement` — and
 * repeated warnings are throttled, so a chatty capture cannot flood the log
 * either. Counts suppressed by the throttle are reported when the session's
 * state is released.
 *
 * @example
 * ```ts
 * // `clients` is the client registry: its `broadcastToKinds` count is the receipt.
 * const liveTail = createLiveTail({ broadcaster: clients, logger });
 *
 * // In ./ingest.ts, after insertMany has returned the persisted rows:
 * const tailed = liveTail.push(sessionId, persisted.events);
 * if (!tailed.ok) {
 *   logger.warn('Live tail refused part of a batch', { code: tailed.error.code });
 * }
 *
 * // In ../main.ts, during graceful shutdown:
 * await liveTail.flush();
 * liveTail.close();
 * ```
 *
 * @module
 */

import { createEnvelope, parseTelemetryTailPayload } from '@debuggen/protocol';
import type { ClientKind, ProtocolMessage, TelemetryTailPayload } from '@debuggen/protocol';
import { DebuggenError, err, noopLogger, nowEpochMs, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result, SessionId } from '@debuggen/shared';
import { parseTelemetryEvent } from '@debuggen/telemetry';
import type { TelemetryEvent } from '@debuggen/telemetry';

import { describeException, guardLogger, sessionLogger, subsystemLogger } from '../logging.js';
import type { SessionBroadcaster } from '../sessions/manager.js';

// ---------------------------------------------------------------------------
// Section A — public bounds and routing
// ---------------------------------------------------------------------------

/**
 * How long a session's first buffered event waits before its frame is sent, in
 * milliseconds — the coalescing window.
 *
 * 250 ms is fast enough that the panel reads as live (well under the half
 * second at which a stream starts to feel laggy) and slow enough that a burst —
 * a click whose handler fires a fetch, a React commit of dozens of components
 * and a long task inside one animation frame — lands in one frame instead of
 * dozens.
 */
export const TAIL_FLUSH_INTERVAL_MS = 250;

/**
 * The most events one `telemetry.tail` frame carries — a hard ceiling.
 *
 * Far below the 5 000-event bound `telemetryTailPayloadSchema` enforces (see
 * "Bounds" in the module documentation), so a frame is always cheap for the
 * panel to parse and render and can never approach the schema's limit. The
 * `maxEventsPerFrame` option may lower it and never raise it. At the default
 * interval this still streams up to 800 events per second per session, more
 * than any single interaction produces.
 */
export const TAIL_MAX_EVENTS_PER_FRAME = 200;

/**
 * The most events one session's tail buffer holds before the oldest are dropped
 * — a hard ceiling that the `maxBufferedEvents` option may lower and never
 * raise.
 *
 * Ten full frames: enough to absorb a burst while the transport is briefly
 * away, small enough that a disconnected panel cannot make the service hoard
 * telemetry in memory. Dropped events stay in the store.
 */
export const TAIL_MAX_BUFFERED_EVENTS = 2000;

/**
 * The longest delay between two delivery retries while no DevTools connection
 * receives a session's frames, in milliseconds — the backoff's ceiling.
 *
 * The backoff starts at the coalescing window and doubles (250, 500, 1 000,
 * 2 000 ms at the defaults), so a panel that reconnects within a second or two
 * sees its backlog almost at once, while a panel that stays closed costs one
 * cheap attempt every two seconds. A configured coalescing window longer than
 * this is used as the ceiling instead: a retry is never paced faster than the
 * live stream it stands in for.
 */
export const TAIL_RETRY_MAX_DELAY_MS = 2000;

/**
 * How long an undelivered backlog is retained for a panel that is not
 * receiving, in milliseconds, measured from the first undelivered attempt of
 * the outage.
 *
 * Thirty seconds covers a DevTools reload, a service-worker restart and the
 * panel's reconnect backoff with room to spare. Past it the panel is treated
 * as gone rather than reconnecting: the backlog is released (counted in
 * `eventsExpired`) and the retry timer stops until the next push. Nothing is
 * lost — every event is in the store, where panel-data queries read it.
 */
export const TAIL_UNDELIVERED_RETENTION_MS = 30_000;

/**
 * The client kinds a tail frame is delivered to: the DevTools panel only.
 *
 * Typed against protocol's `ClientKind`, so a change to that vocabulary is a
 * compile error here rather than a silent misroute. The registry resolves
 * `devtools` to the connection bound to the session's tab; the editor never
 * receives the tail.
 */
export const TAIL_CLIENT_KINDS = Object.freeze([
  'devtools',
] as const) satisfies readonly ClientKind[];

// ---------------------------------------------------------------------------
// Section B — public ports and types
// ---------------------------------------------------------------------------

/**
 * An opaque handle for one scheduled flush, as returned by
 * {@link TailScheduler.setTimer}.
 *
 * Only `unref` is ever read, and only if present: when the handle exposes it
 * (Node's `Timeout` does) the live tail calls it, so a pending tail frame never
 * keeps the process alive on its own. A test scheduler may return any object.
 */
export interface TailTimer {
  /** Detaches the timer from the event loop's liveness, when supported. */
  readonly unref?: () => unknown;
}

/**
 * The timer port the live tail schedules its flushes through.
 *
 * Injected so the module is testable with Vitest fake timers or a hand-driven
 * scheduler, and so {@link LiveTail.close} is deterministic. The default is
 * Node's `setTimeout`/`clearTimeout`, resolved at call time so
 * `vi.useFakeTimers()` applies to it.
 *
 * Contract: `setTimer` invokes `fn` once, later — never synchronously from
 * inside `setTimer` — unless `clearTimer` is called with its handle first. The
 * live tail tolerates a scheduler that breaks either rule (a synchronous call
 * is handled — an undelivered attempt made inside it is not re-armed from
 * there, so an unreachable panel cannot recurse — and a throw is caught and
 * counted), but frames are only paced as documented when the contract holds.
 */
export interface TailScheduler {
  /**
   * Schedules `fn` to run once after `ms` milliseconds.
   *
   * @param fn The callback; it never throws.
   * @param ms The delay, in milliseconds.
   * @returns A handle {@link TailScheduler.clearTimer} accepts.
   */
  setTimer(fn: () => void, ms: number): TailTimer;

  /**
   * Cancels a pending callback. Cancelling one that already ran is a no-op.
   *
   * @param timer A handle {@link TailScheduler.setTimer} returned.
   */
  clearTimer(timer: TailTimer): void;
}

/**
 * The broadcaster the live tail delivers through: the `SessionBroadcaster` port
 * `../sessions/manager.ts` declares, narrowed so `broadcastToKinds` reports how
 * many connections received the frame.
 *
 * The narrowing is the whole contract. The session manager's own broadcasts
 * are best effort and it recovers a missed frame through the reopen replay, so
 * its port can afford a `void` result; the live tail has no such replay, and
 * without a count it could not tell a delivered frame from one that reached
 * nobody. The client registry in `../server/clients.ts` already answers the
 * count (0 when the session's bound tab has no online DevTools connection), so
 * `../main.ts` passes it unchanged, and the compiler checks it there.
 *
 * @example
 * ```ts
 * const broadcaster: TailBroadcaster = {
 *   broadcast: () => undefined,
 *   broadcastToKinds: (_sessionId, _kinds, message) => {
 *     frames.push(message);
 *     return 1; // one connection received it
 *   },
 * };
 * ```
 */
export interface TailBroadcaster extends SessionBroadcaster {
  /**
   * Sends `message` to the connected clients of `sessionId` whose kind is in
   * `kinds`.
   *
   * @returns How many connections received the frame — the delivery receipt.
   * Only a positive count confirms delivery; `0` leaves the frame queued for a
   * retry.
   */
  broadcastToKinds(
    sessionId: string,
    kinds: readonly ClientKind[],
    message: ProtocolMessage,
  ): number;
}

/**
 * Everything {@link createLiveTail} is given; everything but the broadcaster is
 * optional and defaults to the production choice.
 */
export interface LiveTailDeps {
  /**
   * Where finished frames go: a {@link TailBroadcaster}, satisfied in
   * production by the client registry in `../server/clients.ts`. Only
   * `broadcastToKinds` is called, always with {@link TAIL_CLIENT_KINDS}, and its
   * count decides whether a frame is dequeued.
   */
  readonly broadcaster: TailBroadcaster;

  /** The parent logger; records are bound to this subsystem and the session. Defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;

  /**
   * The clock the log throttle and the undelivered-retention window read, in
   * Unix epoch milliseconds. Defaults to `nowEpochMs` from `@debuggen/shared`.
   * Never applied to an event: `startTime` and `duration` are forwarded exactly
   * as the store holds them. A clock that throws or answers a non-finite value
   * freezes both at its last good reading, which can only postpone a release:
   * the backlog stays within the buffer bound and retries at the backoff
   * ceiling meanwhile.
   */
  readonly now?: (() => number) | undefined;

  /** The timer port. Defaults to Node's `setTimeout`/`clearTimeout`. */
  readonly scheduler?: TailScheduler | undefined;

  /**
   * The coalescing window, in milliseconds. Defaults to
   * {@link TAIL_FLUSH_INTERVAL_MS}; a value that is not a finite number between
   * 0 and 60 000 falls back to the default with a warning.
   */
  readonly flushIntervalMs?: number | undefined;

  /**
   * The per-frame event cap. Defaults to {@link TAIL_MAX_EVENTS_PER_FRAME}; an
   * integer from 1 up to that ceiling is honoured, anything else falls back to
   * the default with a warning.
   */
  readonly maxEventsPerFrame?: number | undefined;

  /**
   * The per-session buffer bound. Defaults to {@link TAIL_MAX_BUFFERED_EVENTS};
   * an integer from 1 up to that ceiling is honoured, anything else falls back
   * to the default with a warning.
   */
  readonly maxBufferedEvents?: number | undefined;
}

/**
 * A snapshot of the live tail's counters, for tests, diagnostics and the
 * service's health reporting. Every counter is cumulative since
 * {@link createLiveTail}, except `buffered` and `sessions`, which describe the
 * present moment.
 */
export interface LiveTailStats {
  /** Events currently buffered across every session, awaiting a frame. */
  readonly buffered: number;
  /** Sessions whose tail state is currently held. */
  readonly sessions: number;
  /** Frames at least one connection received: the broadcaster's receipt was a positive count. */
  readonly framesSent: number;
  /** Events carried by those frames. */
  readonly eventsSent: number;
  /**
   * Events evicted, oldest first, because a session's buffer was full while its
   * frames were being delivered — ordinary burst overflow. Overflow while an
   * undelivered backlog waits is counted in `eventsTruncatedWhileUndelivered`
   * instead; the two never count the same event.
   */
  readonly eventsDropped: number;
  /** Events refused by the provenance guard: not a persisted event of the session they were pushed for. */
  readonly eventsRejected: number;
  /** Events skipped because the same event id was already buffered or recently sent. */
  readonly duplicatesSkipped: number;
  /**
   * Frames discarded because they failed validation or their envelope could not
   * be built — deterministic failures, never retried. An undelivered frame is
   * not a failed frame: see `framesUndelivered`.
   */
  readonly framesFailed: number;
  /** Events carried by those invalid frames; the store still holds every one. */
  readonly eventsFailed: number;
  /**
   * Delivery attempts no connection received — a receipt of zero, or a
   * broadcast that threw. The frame's events stay buffered and are retried, so
   * one outage counts once per attempt.
   */
  readonly framesUndelivered: number;
  /**
   * Buffered events released unsent because no delivery succeeded within
   * {@link TAIL_UNDELIVERED_RETENTION_MS} of an outage's first undelivered
   * attempt; the store still holds every one.
   */
  readonly eventsExpired: number;
  /**
   * Events evicted, oldest first, from a full buffer while its undelivered
   * backlog was waiting for the panel — tail truncation for an unreachable
   * panel, as opposed to the burst overflow `eventsDropped` counts.
   */
  readonly eventsTruncatedWhileUndelivered: number;
}

/**
 * The live tail. Created once per service process by {@link createLiveTail};
 * fed by `./ingest.ts`, flushed and closed by `../main.ts` on shutdown.
 */
export interface LiveTail {
  /**
   * Buffers a session's freshly persisted events for the next tail frame.
   *
   * Never sends synchronously: the first event into an idle buffer arms the
   * session's flush timer. Events are checked by the provenance guard, then
   * de-duplicated by `id`, then appended in the order given; a full buffer
   * drops its oldest events.
   *
   * @param sessionId The session the events were attributed to.
   * @param events The rows the telemetry store returned — redacted, attributed
   * and carrying `ingestSeq`. An empty array is accepted and does nothing.
   * @returns `ok` when every event was buffered or skipped as a duplicate.
   * `err` with `PROTOCOL_INVALID_MESSAGE` when an argument is malformed or when
   * the provenance guard refused one or more events — the admissible remainder
   * of the batch **is** still buffered, and the details carry only the counts
   * `{ rejected, accepted, duplicates }`; `err` with `INTERNAL` when the flush
   * timer could not be scheduled (the events stay buffered for an explicit
   * flush); `err` with `TRANSPORT_DISCONNECTED` after {@link LiveTail.close},
   * in which case nothing is buffered.
   */
  push(sessionId: SessionId, events: readonly TelemetryEvent[]): Result<void, DebuggenError>;

  /**
   * Sends everything buffered now — for one session, or for every session when
   * `sessionId` is omitted — in frames of at most the per-frame cap, cancelling
   * the pending timers it pre-empts.
   *
   * The promise never rejects. A session with nothing buffered, an unknown
   * session and a closed tail all answer `ok(0)`.
   *
   * @param sessionId The session to flush; omit it to flush all of them.
   * @returns `ok(n)` with the number of events delivered, or `err` when a frame
   * failed validation (`PROTOCOL_INVALID_MESSAGE`; its events were discarded)
   * or no connection received it — a receipt of zero or a throwing broadcast
   * (`TRANSPORT_DISCONNECTED`). Either way the details carry `eventsSent`,
   * `eventsRemaining` and `eventsExpired`. After an undelivered frame the
   * backlog, that frame first, stays buffered with the retry timer armed —
   * unless the outage had outlived {@link TAIL_UNDELIVERED_RETENTION_MS}, in
   * which case the backlog was released and counted in `eventsExpired`.
   */
  flush(sessionId?: SessionId): Promise<Result<number, DebuggenError>>;

  /**
   * Releases one session's tail state — its buffer, pending timer and dedupe
   * window — without sending what is buffered. Call it when a session ends or
   * its tab is unbound; flush first if the remaining events should still reach
   * the panel. Unknown sessions are ignored.
   *
   * @param sessionId The session to release.
   */
  forget(sessionId: SessionId): void;

  /** @returns A snapshot of the counters described by {@link LiveTailStats}. */
  stats(): LiveTailStats;

  /**
   * Cancels every timer and discards every buffer. Idempotent; what `../main.ts`
   * calls during graceful shutdown, after `flush()`. Afterwards `push` answers
   * `err` and `flush` answers `ok(0)`.
   */
  close(): void;
}

// ---------------------------------------------------------------------------
// Section C — module-local policy
// ---------------------------------------------------------------------------

/** The `subsystem` binding of every record this module writes. */
const TAIL_SUBSYSTEM = 'telemetry.live-tail';

/**
 * The shortest gap between two records of the same kind for one session, in
 * milliseconds. Counts that arrive inside the gap are accumulated and reported
 * with the next record, or when the session's state is released.
 */
const TAIL_LOG_INTERVAL_MS = 10_000;

/** The largest coalescing window the `flushIntervalMs` option accepts. */
const TAIL_MAX_FLUSH_INTERVAL_MS = 60_000;

/**
 * The shortest first retry delay, in milliseconds. The backoff starts at the
 * coalescing window, which the `flushIntervalMs` option may set to 0; doubling
 * 0 stays 0, so without this floor a zero-window tail would retry an
 * unreachable panel on every turn of the event loop.
 */
const TAIL_RETRY_MIN_DELAY_MS = 50;

/**
 * How many times the buffer bound the per-session dedupe window spans. Two is
 * the smallest factor that always covers the whole buffer (whose events are
 * always the newest admitted ones) plus as many recently sent ids again.
 */
const TAIL_DEDUPE_WINDOW_FACTOR = 2;

/**
 * How many idle session states (empty buffer, no pending timer) are retained
 * before the least recently used are released. Retaining a few keeps the dedupe
 * window alive across the pause between two bursts; the bound keeps a
 * long-running service from accumulating one window per session it ever saw.
 */
const TAIL_MAX_RETAINED_SESSIONS = 32;

/** The next step offered when the tail is used after {@link LiveTail.close}. */
const CLOSED_HINT =
  'The live tail was closed during shutdown; events are still persisted and can be read through panel-data queries.';

/** The next step offered when the provenance guard refused events. */
const REJECTED_HINT =
  'Only rows returned by the telemetry store for this session may be tailed: push the events insertMany returned, after redaction and attribution in ingest.';

/** The next step offered when no connection received a frame. */
const UNDELIVERED_HINT =
  'No DevTools connection received the frame: the panel may be closed or reconnecting. ' +
  'The events stay buffered in order and are retried with backoff for up to ' +
  `${String(TAIL_UNDELIVERED_RETENTION_MS / 1000)} seconds; every event also remains in the store for panel-data queries.`;

/** The next step offered when a frame failed validation. */
const INVALID_FRAME_HINT =
  'A telemetry.tail frame carries only persisted events of its own session; this indicates a defect in the ingest path, and the events remain in the store.';

/** The next step offered when the flush timer could not be scheduled. */
const TIMER_HINT =
  'Buffered events are delivered by the next explicit flush or by the next push that schedules successfully.';

/** The kinds of record the per-session throttle tracks separately. */
type ReportKind =
  | 'rejected'
  | 'dropped'
  | 'truncated'
  | 'duplicates'
  | 'frameInvalid'
  | 'noRecipient'
  | 'broadcastFailed'
  | 'expired'
  | 'recovered'
  | 'timerFailed';

/** The log levels this module writes at. */
type ReportLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * What each report kind is logged as: a constant message and a level. The
 * messages name counts and never a value; a record's only variable fields are
 * `count` — events for most kinds, failed attempts for `recovered` — and for
 * some kinds a bound, a retention window, an attempt count, an outage duration
 * or an error `code`.
 *
 * `noRecipient` is `debug`: a closed or reconnecting panel is an expected
 * state, and its events are still queued. What does cost the panel evidence —
 * `truncated` and `expired` — is `warn`.
 */
const REPORTS: Readonly<
  Record<ReportKind, { readonly level: ReportLevel; readonly message: string }>
> = Object.freeze({
  rejected: {
    level: 'warn',
    message:
      'Live tail refused events that are not persisted events of this session; they were not broadcast',
  },
  dropped: {
    level: 'warn',
    message:
      'Live tail buffer is full; the oldest buffered events were dropped from the tail (the store still holds them)',
  },
  truncated: {
    level: 'warn',
    message:
      'Live tail truncated the undelivered backlog of an unreachable DevTools panel; the oldest events were dropped from the tail (the store still holds them)',
  },
  duplicates: {
    level: 'debug',
    message: 'Live tail skipped events it had already buffered or sent',
  },
  frameInvalid: {
    level: 'error',
    message: 'Live tail frame failed validation; its events were discarded from the tail',
  },
  noRecipient: {
    level: 'debug',
    message:
      'Live tail frame reached no DevTools connection; its events stay buffered and are retried',
  },
  broadcastFailed: {
    level: 'error',
    message:
      'Live tail broadcast threw; the frame was not delivered and its events stay buffered and are retried',
  },
  expired: {
    level: 'warn',
    message:
      'Live tail released an undelivered backlog after its retention window; no DevTools connection received it (the store still holds it)',
  },
  recovered: {
    level: 'info',
    message: 'Live tail delivery resumed; the retained backlog is being delivered in order',
  },
  timerFailed: {
    level: 'error',
    message: 'Live tail could not schedule its flush timer',
  },
});

/** One throttled report kind's state for one session. */
interface ThrottleEntry {
  /** Occurrences not yet written to the log. */
  pending: number;
  /** When a record of this kind was last written, or `undefined` if never. */
  lastReportedAt: number | undefined;
}

/**
 * A pending flush. The object itself is the arming token: a timer callback acts
 * only while its token is still the session's current one, which makes a
 * cancelled, superseded or synchronously fired callback harmless.
 */
interface ArmedFlush {
  /** The scheduler's handle, once `setTimer` has returned it. */
  timer: TailTimer | undefined;
  /**
   * `true` while `setTimer` is still running for this token. A callback that
   * finds it set was fired synchronously by a scheduler breaking its contract,
   * and must not re-arm a retry from inside that call (see `onTimer`).
   */
  scheduling: boolean;
}

/**
 * A delivery outage: the span from a session's first undelivered attempt to its
 * next confirmed delivery (or to the release of its backlog).
 */
interface TailOutage {
  /** The clock reading of the outage's first undelivered attempt. */
  readonly since: number;
  /** Undelivered attempts so far, the first included. */
  attempts: number;
  /** The delay before the next retry; doubled after each undelivered attempt, up to the ceiling. */
  retryDelayMs: number;
}

/** Everything the live tail holds for one session. */
interface SessionTail {
  readonly sessionId: SessionId;
  /** The session-bound child logger. */
  readonly logger: Logger;
  /**
   * Admitted, not yet delivered events, oldest first. The front frame's events
   * leave only once a positive receipt confirms them (or when they are
   * discarded as an invalid frame, evicted by the bound or expired).
   */
  readonly buffer: TelemetryEvent[];
  /** Ids of buffered and recently sent or dropped events, in admission order. */
  readonly seen: Set<string>;
  /** The pending flush or retry, if one is armed. */
  armed: ArmedFlush | undefined;
  /** The current delivery outage, while the last attempt reached nobody. */
  outage: TailOutage | undefined;
  /**
   * `true` while a frame of this session is inside the broadcaster. A nested
   * drain — a broadcaster that re-enters `flush` — sends nothing, so the front
   * frame can never be delivered twice.
   */
  sending: boolean;
  /** Per-kind throttle state. */
  readonly throttle: Map<ReportKind, ThrottleEntry>;
}

/** How one frame attempt ended. */
type FrameOutcome =
  | { readonly kind: 'sent' }
  | { readonly kind: 'invalid'; readonly error: DebuggenError }
  | { readonly kind: 'undelivered'; readonly error: DebuggenError };

/** What draining a session's buffer achieved. */
interface DrainOutcome {
  /** Events delivered. */
  readonly sent: number;
  /** Events released because the outage outlived the retention window. */
  readonly expired: number;
  /** Whether the drain stopped at an undelivered frame. */
  readonly undelivered: boolean;
  /** The first failure met, if any. */
  readonly failure: DebuggenError | undefined;
}

// ---------------------------------------------------------------------------
// Section D — total helpers
// ---------------------------------------------------------------------------

/**
 * Writes one record. Every logger this module writes to descends from the
 * root {@link createLiveTail} guards with `guardLogger`, so the call cannot
 * throw: a failing sink drops the record under the shared best-effort policy
 * of `../logging.ts` and never turns a handled condition into an exception.
 */
function emit(logger: Logger, level: ReportLevel, message: string, fields: LogFields): void {
  logger[level](message, fields);
}

/**
 * `Array.isArray` as a guard that narrows to `readonly unknown[]` rather than
 * `any[]`, so no element is treated as typed before it has been checked.
 */
function isArrayValue(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * The provenance guard: admits a value into a session's tail, or refuses it.
 *
 * It must parse as a persisted `TelemetryEvent` — the store-assigned fields are
 * the evidence it came back out of the store, which only redacted events enter
 * — and it must be attributed to `sessionId`. The parsed copy is what gets
 * buffered, so every getter is read exactly once, a caller mutating its row
 * afterwards cannot change what is sent, and the frame built from the buffer
 * is plain data. Total: a value with a throwing getter or a hostile proxy is
 * simply refused.
 *
 * @param candidate Any value pushed as an event.
 * @param sessionId The session it was pushed for.
 * @returns The validated event, or `undefined` when it is not a persisted event
 * of that session.
 */
function admit(candidate: unknown, sessionId: SessionId): TelemetryEvent | undefined {
  try {
    const parsed = parseTelemetryEvent(candidate);
    return parsed.ok && parsed.value.sessionId === sessionId ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The code of a thrown value, for a counts-only log record.
 *
 * Only the code is ever logged — a thrown value's message is free text that
 * an injected dependency wrote and this module cannot vouch for.
 *
 * @param thrown Whatever was caught.
 * @param fallback The code to report when the value carries none.
 * @returns A `DebuggenErrorCode`.
 */
function codeOf(thrown: unknown, fallback: DebuggenErrorCode): DebuggenErrorCode {
  try {
    return DebuggenError.from(thrown, fallback).code;
  } catch {
    return fallback;
  }
}

/**
 * Resolves an integer count option against its default and hard ceiling.
 *
 * @returns `value` when it is an integer in `[1, ceiling]`, otherwise
 * `ceiling` (which is also the default), with a warning naming the option.
 */
function resolveCount(
  value: number | undefined,
  ceiling: number,
  option: string,
  logger: Logger,
): number {
  if (value === undefined) {
    return ceiling;
  }
  if (Number.isInteger(value) && value >= 1 && value <= ceiling) {
    return value;
  }
  emit(logger, 'warn', 'Live tail option is out of range; using the default', {
    option,
    min: 1,
    max: ceiling,
    default: ceiling,
  });
  return ceiling;
}

/**
 * Resolves the coalescing window option.
 *
 * @returns `value` when it is a finite number in `[0, 60 000]`, otherwise
 * {@link TAIL_FLUSH_INTERVAL_MS}, with a warning.
 */
function resolveInterval(value: number | undefined, logger: Logger): number {
  if (value === undefined) {
    return TAIL_FLUSH_INTERVAL_MS;
  }
  if (Number.isFinite(value) && value >= 0 && value <= TAIL_MAX_FLUSH_INTERVAL_MS) {
    return value;
  }
  emit(logger, 'warn', 'Live tail option is out of range; using the default', {
    option: 'flushIntervalMs',
    min: 0,
    max: TAIL_MAX_FLUSH_INTERVAL_MS,
    default: TAIL_FLUSH_INTERVAL_MS,
  });
  return TAIL_FLUSH_INTERVAL_MS;
}

/**
 * The default scheduler: Node's timers, looked up at call time so fake timers
 * installed after construction still apply.
 *
 * The live tail only ever sees opaque {@link TailTimer} handles; the real
 * `Timeout` behind each is kept in a `WeakMap`, so `clearTimer` needs no cast
 * and an unknown handle is ignored rather than misinterpreted.
 */
function createNodeTailScheduler(): TailScheduler {
  const handles = new WeakMap<TailTimer, ReturnType<typeof setTimeout>>();

  return Object.freeze({
    setTimer(fn: () => void, ms: number): TailTimer {
      const handle = setTimeout(fn, ms);
      handles.set(handle, handle);
      return handle;
    },
    clearTimer(timer: TailTimer): void {
      const handle = handles.get(timer);
      if (handle !== undefined) {
        handles.delete(timer);
        clearTimeout(handle);
      }
    },
  });
}

/**
 * Lets a pending flush not keep the process alive, when the handle supports it.
 *
 * Guarded, because an injected scheduler's handle need not support it. An
 * `unref` that throws is a best-effort loss, not a failure of the flush: the
 * timer stays referenced, so it keeps the process alive until it fires or is
 * cleared — at most one coalescing window — and the thrown value is handed to
 * `onFailure`, which records that decision.
 *
 * @param timer The handle the scheduler returned.
 * @param onFailure Receives what `unref` threw; must not throw itself.
 */
function unrefTimer(timer: TailTimer, onFailure: (thrown: unknown) => void): void {
  try {
    timer.unref?.();
  } catch (thrown) {
    onFailure(thrown);
  }
}

/** The error `push` answers after {@link LiveTail.close}. */
function closedError(): DebuggenError {
  return new DebuggenError('TRANSPORT_DISCONNECTED', 'The live tail is closed', {
    hint: CLOSED_HINT,
  });
}

/** Why a frame was not delivered: nobody received it, or the broadcaster threw. */
type UndeliveredReason = 'no-recipient' | 'broadcast-threw';

/**
 * The error one undelivered frame is described by. Always
 * `TRANSPORT_DISCONNECTED`: both reasons are transport conditions a retry can
 * outlast, which is what separates them from an invalid frame.
 *
 * @param reason Why the frame was not delivered.
 * @param events How many events the frame carried.
 * @param cause What the broadcaster threw, for `broadcast-threw`.
 * @returns The coded error; its details are the event count and the reason.
 */
function undeliveredError(
  reason: UndeliveredReason,
  events: number,
  cause?: unknown,
): DebuggenError {
  const message =
    reason === 'no-recipient'
      ? 'No DevTools connection received the live-tail frame'
      : 'The live tail could not deliver a frame';
  return new DebuggenError('TRANSPORT_DISCONNECTED', message, {
    hint: UNDELIVERED_HINT,
    details: { events, reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * The error a flush answers when it could not deliver everything: the first
 * failure's code and hint under a constant message, with counts as details.
 *
 * @param failure The first failure the flush met.
 * @param details Counts describing the flush.
 * @returns The coded error, with `failure` as its cause.
 */
function flushError(
  failure: DebuggenError,
  details: Readonly<Record<string, number>>,
): DebuggenError {
  return new DebuggenError(failure.code, 'The live tail could not deliver every buffered event', {
    hint: failure.hint ?? UNDELIVERED_HINT,
    details,
    cause: failure,
  });
}

// ---------------------------------------------------------------------------
// Section E — the live tail
// ---------------------------------------------------------------------------

/**
 * Creates the service's live tail.
 *
 * One instance serves every session: state is created per session on its first
 * push and released once idle (see "Bounds" in the module documentation). The
 * returned object is frozen and every method is total — none throws, whatever
 * the injected dependencies do.
 *
 * @param deps The broadcaster and the optional logger, clock, scheduler and
 * bounds. Out-of-range bounds fall back to their defaults with a warning.
 * @returns The live tail.
 *
 * @example
 * ```ts
 * // A deterministic test: a hand-driven scheduler and a recording broadcaster.
 * // The broadcaster must answer a receipt: a frame counted 0 stays queued.
 * const frames: ProtocolMessage[] = [];
 * const liveTail = createLiveTail({
 *   broadcaster: {
 *     broadcast: () => undefined,
 *     broadcastToKinds: (_sessionId, _kinds, message) => {
 *       frames.push(message);
 *       return 1; // one DevTools connection received it
 *     },
 *   },
 *   scheduler: { setTimer: () => ({}), clearTimer: () => undefined },
 * });
 * liveTail.push(sessionId, persistedEvents);
 * const flushed = await liveTail.flush(sessionId); // ok(persistedEvents.length)
 * ```
 */
export function createLiveTail(deps: LiveTailDeps): LiveTail {
  const { broadcaster } = deps;
  // Guarded before the child is derived, so neither `child()` nor any level
  // method of the root or of a session logger derived from it can throw.
  const rootLogger = subsystemLogger(guardLogger(deps.logger ?? noopLogger), TAIL_SUBSYSTEM);
  const clock = deps.now ?? nowEpochMs;
  const scheduler = deps.scheduler ?? createNodeTailScheduler();
  const flushIntervalMs = resolveInterval(deps.flushIntervalMs, rootLogger);
  const maxEventsPerFrame = resolveCount(
    deps.maxEventsPerFrame,
    TAIL_MAX_EVENTS_PER_FRAME,
    'maxEventsPerFrame',
    rootLogger,
  );
  const maxBufferedEvents = resolveCount(
    deps.maxBufferedEvents,
    TAIL_MAX_BUFFERED_EVENTS,
    'maxBufferedEvents',
    rootLogger,
  );
  const dedupeWindow = maxBufferedEvents * TAIL_DEDUPE_WINDOW_FACTOR;
  /** The first retry delay of an outage: the coalescing window, floored. */
  const retryBaseMs = Math.max(flushIntervalMs, TAIL_RETRY_MIN_DELAY_MS);
  /** The backoff's ceiling; never below the first delay (see {@link TAIL_RETRY_MAX_DELAY_MS}). */
  const retryCeilingMs = Math.max(TAIL_RETRY_MAX_DELAY_MS, retryBaseMs);

  /** Every held session state, least recently pushed first. */
  const sessions = new Map<SessionId, SessionTail>();
  const counters = {
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
  };
  let closed = false;
  let lastClockReading = 0;
  /**
   * Whether a throwing clock, and a throwing timer `unref`, have been recorded.
   * Each is recorded once per tail rather than per occurrence: the clock is
   * read on every throttled report and `unref` runs on every armed flush, and
   * an injected clock or scheduler that fails fails the same way each time, so
   * the first record says everything the rest would without adding volume on
   * the ingest path.
   */
  let clockFailureRecorded = false;
  let unrefFailureRecorded = false;

  /* ---- clock and throttled reporting ---- */

  /**
   * Reads the injected clock. A clock that throws or answers a non-finite
   * value freezes the throttle at its last good reading, which only makes it
   * more conservative: suppressed counts are still reported on release.
   */
  function readClock(): number {
    try {
      const reading = clock();
      if (Number.isFinite(reading)) {
        lastClockReading = reading;
      }
    } catch (thrown) {
      // Fall through to the last good reading; the first failure is recorded
      // by the thrown value's closed class only.
      if (!clockFailureRecorded) {
        clockFailureRecorded = true;
        emit(
          rootLogger,
          'debug',
          'the injected clock threw; the report throttle keeps its last good reading',
          { ...describeException(thrown) },
        );
      }
    }
    return lastClockReading;
  }

  /**
   * Records, once per tail, that a flush timer could not be unref'd and so
   * keeps the process alive until it fires or is cleared. Cannot throw: the
   * logger is guarded and `describeException` is total.
   */
  function recordUnrefFailure(thrown: unknown): void {
    if (unrefFailureRecorded) {
      return;
    }
    unrefFailureRecorded = true;
    emit(
      rootLogger,
      'debug',
      'a flush timer could not be unref’d; it keeps the process alive until it fires or is cleared',
      { ...describeException(thrown) },
    );
  }

  /**
   * Records `count` occurrences of `kind` for a session, writing at most one
   * record per kind per {@link TAIL_LOG_INTERVAL_MS}; a written record carries
   * every occurrence accumulated since the previous one.
   */
  function report(
    state: SessionTail,
    kind: ReportKind,
    count: number,
    extra: LogFields = {},
  ): void {
    if (count <= 0) {
      return;
    }
    let entry = state.throttle.get(kind);
    if (entry === undefined) {
      entry = { pending: 0, lastReportedAt: undefined };
      state.throttle.set(kind, entry);
    }
    entry.pending += count;

    const at = readClock();
    if (entry.lastReportedAt !== undefined && at - entry.lastReportedAt < TAIL_LOG_INTERVAL_MS) {
      return;
    }
    const { level, message } = REPORTS[kind];
    emit(state.logger, level, message, { ...extra, count: entry.pending });
    entry.pending = 0;
    entry.lastReportedAt = at;
  }

  /** Writes whatever the throttle is still holding for a session. */
  function reportSuppressed(state: SessionTail): void {
    for (const [kind, entry] of state.throttle) {
      if (entry.pending > 0) {
        const { level, message } = REPORTS[kind];
        emit(state.logger, level, message, { count: entry.pending, throttled: true });
        entry.pending = 0;
      }
    }
  }

  /* ---- session state ---- */

  /** The session's state, created on first use and moved to most recently used. */
  function stateFor(sessionId: SessionId): SessionTail {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) {
      sessions.delete(sessionId);
      sessions.set(sessionId, existing);
      return existing;
    }
    const created: SessionTail = {
      sessionId,
      logger: sessionLogger(rootLogger, sessionId),
      buffer: [],
      seen: new Set<string>(),
      armed: undefined,
      outage: undefined,
      sending: false,
      throttle: new Map<ReportKind, ThrottleEntry>(),
    };
    sessions.set(sessionId, created);
    return created;
  }

  /** Whether a state is still the one held for its session, in an open tail. */
  function isLive(state: SessionTail): boolean {
    return !closed && sessions.get(state.sessionId) === state;
  }

  /** Adds an id to the session's dedupe window, evicting the oldest past its bound. */
  function remember(state: SessionTail, id: string): void {
    state.seen.add(id);
    while (state.seen.size > dedupeWindow) {
      const oldest = state.seen.values().next();
      if (oldest.done) {
        return;
      }
      state.seen.delete(oldest.value);
    }
  }

  /** Cancels, empties and forgets one session's state, reporting throttled counts first. */
  function release(state: SessionTail): void {
    disarm(state);
    reportSuppressed(state);
    state.buffer.length = 0;
    state.seen.clear();
    state.outage = undefined;
    if (sessions.get(state.sessionId) === state) {
      sessions.delete(state.sessionId);
    }
  }

  /**
   * Releases idle states — nothing buffered, no timer pending — least recently
   * used first, until at most {@link TAIL_MAX_RETAINED_SESSIONS} are held. A
   * state with work outstanding is never released here.
   */
  function evictIdle(): void {
    if (sessions.size <= TAIL_MAX_RETAINED_SESSIONS) {
      return;
    }
    for (const state of sessions.values()) {
      if (sessions.size <= TAIL_MAX_RETAINED_SESSIONS) {
        return;
      }
      if (state.buffer.length === 0 && state.armed === undefined) {
        release(state);
      }
    }
  }

  /* ---- timers ---- */

  /** Cancels a session's pending flush, if any. */
  function disarm(state: SessionTail): void {
    const armed = state.armed;
    if (armed === undefined) {
      return;
    }
    state.armed = undefined;
    if (armed.timer === undefined) {
      return;
    }
    try {
      scheduler.clearTimer(armed.timer);
    } catch (thrown) {
      report(state, 'timerFailed', 1, { code: codeOf(thrown, 'INTERNAL') });
    }
  }

  /**
   * Arms a session's flush timer when it has buffered events and none is
   * pending. The single timer per session is what coalesces a burst; during an
   * outage the same timer is the retry, armed with the outage's backoff delay
   * instead of the coalescing window.
   */
  function arm(state: SessionTail): Result<void, DebuggenError> {
    if (!isLive(state) || state.armed !== undefined || state.buffer.length === 0) {
      return ok(undefined);
    }
    const delayMs = state.outage === undefined ? flushIntervalMs : state.outage.retryDelayMs;
    const armed: ArmedFlush = { timer: undefined, scheduling: true };
    state.armed = armed;
    try {
      const timer = scheduler.setTimer(() => {
        onTimer(state, armed);
      }, delayMs);
      armed.timer = timer;
      unrefTimer(timer, recordUnrefFailure);
    } catch (thrown) {
      if (state.armed === armed) {
        state.armed = undefined;
      }
      report(state, 'timerFailed', 1, { code: codeOf(thrown, 'INTERNAL') });
      return err(
        new DebuggenError('INTERNAL', 'The live tail could not schedule its flush', {
          hint: TIMER_HINT,
          details: { buffered: state.buffer.length },
          cause: thrown,
        }),
      );
    } finally {
      armed.scheduling = false;
    }
    return ok(undefined);
  }

  /**
   * A scheduled flush: one frame, then re-arm if events remain, so a burst
   * drains across several frames at the coalescing pace and an undelivered
   * frame is retried at the backoff pace. A callback whose token is no longer
   * current — cancelled, superseded, or for a released or closed tail — does
   * nothing.
   *
   * A callback a non-conforming scheduler fired synchronously from inside
   * `setTimer` does not re-arm after an undelivered attempt: re-arming would
   * fire the retry at once, inside the same call, and an unreachable panel
   * would turn that into unbounded recursion. The backlog then waits, still
   * bounded, for the next push or flush.
   */
  function onTimer(state: SessionTail, armed: ArmedFlush): void {
    if (!isLive(state) || state.armed !== armed) {
      return;
    }
    state.armed = undefined;
    const outcome = drain(state, 1);
    if (!(armed.scheduling && outcome.undelivered)) {
      arm(state);
    }
    evictIdle();
  }

  /* ---- delivery outages ---- */

  /**
   * Books an undelivered attempt against the session's outage: opens one on the
   * first attempt, doubles the retry delay up to its ceiling on every later
   * one, and releases the backlog once the outage has outlived
   * {@link TAIL_UNDELIVERED_RETENTION_MS}.
   *
   * @returns How many events were released (0 while the window is still open).
   */
  function noteUndelivered(state: SessionTail): number {
    if (!isLive(state)) {
      return 0;
    }
    const at = readClock();
    let outage = state.outage;
    if (outage === undefined) {
      outage = { since: at, attempts: 1, retryDelayMs: retryBaseMs };
      state.outage = outage;
    } else {
      outage.attempts += 1;
      outage.retryDelayMs = Math.min(outage.retryDelayMs * 2, retryCeilingMs);
    }
    if (at - outage.since < TAIL_UNDELIVERED_RETENTION_MS) {
      return 0;
    }
    return expire(state, outage);
  }

  /**
   * Releases a session's undelivered backlog after its retention window: the
   * buffer is emptied and counted, the outage closes, and the retry timer is
   * cancelled — the next push re-arms at the coalescing pace and, if the panel
   * is still unreachable, opens a fresh outage. The ids stay in the dedupe
   * window, as they do for every dropped event.
   *
   * @returns How many events were released.
   */
  function expire(state: SessionTail, outage: TailOutage): number {
    const released = state.buffer.length;
    state.buffer.length = 0;
    state.outage = undefined;
    disarm(state);
    counters.eventsExpired += released;
    report(state, 'expired', released, {
      retentionMs: TAIL_UNDELIVERED_RETENTION_MS,
      attempts: outage.attempts,
    });
    return released;
  }

  /**
   * Closes a session's outage on its first confirmed delivery: the backoff
   * resets, so the retained backlog drains at the coalescing pace.
   */
  function noteDelivered(state: SessionTail): void {
    const outage = state.outage;
    if (outage === undefined) {
      return;
    }
    state.outage = undefined;
    report(state, 'recovered', outage.attempts, {
      outageMs: Math.max(0, readClock() - outage.since),
    });
  }

  /* ---- frames ---- */

  /**
   * Validates a frame's payload against protocol's `telemetry.tail` schema,
   * without throwing. The error is protocol's own, which is built from issue
   * paths and codes and never from a received value.
   */
  function validateFrame(
    sessionId: SessionId,
    events: readonly TelemetryEvent[],
  ): Result<TelemetryTailPayload, DebuggenError> {
    try {
      return parseTelemetryTailPayload({ sessionId, events });
    } catch (thrown) {
      return err(
        new DebuggenError('PROTOCOL_INVALID_MESSAGE', 'A live-tail frame could not be validated', {
          hint: INVALID_FRAME_HINT,
          cause: thrown,
        }),
      );
    }
  }

  /** Counts and reports a frame discarded as invalid, and describes the outcome. */
  function discardInvalid(
    state: SessionTail,
    batch: readonly TelemetryEvent[],
    error: DebuggenError,
  ): FrameOutcome {
    counters.framesFailed += 1;
    counters.eventsFailed += batch.length;
    report(state, 'frameInvalid', batch.length, { code: error.code });
    return { kind: 'invalid', error };
  }

  /**
   * Validates, wraps and delivers one frame to the session's bound DevTools
   * connection, and reads the broadcaster's receipt.
   *
   * - A frame that fails validation is never built, and one whose envelope
   *   cannot be built is never sent: both are `invalid`.
   * - A broadcast that throws, and a receipt that is not a positive count, are
   *   `undelivered` — the caller keeps the events queued.
   * - Only a positive receipt is `sent`, and only a sent frame is counted in
   *   `framesSent`/`eventsSent`.
   *
   * Never mutates the buffer; `drain` decides what leaves it.
   */
  function sendFrame(state: SessionTail, batch: readonly TelemetryEvent[]): FrameOutcome {
    const validated = validateFrame(state.sessionId, batch);
    if (!validated.ok) {
      return discardInvalid(state, batch, validated.error);
    }

    let frame: ProtocolMessage;
    try {
      frame = createEnvelope('telemetry.tail', validated.value);
    } catch (thrown) {
      return discardInvalid(
        state,
        batch,
        new DebuggenError('PROTOCOL_INVALID_MESSAGE', 'A live-tail frame could not be built', {
          hint: INVALID_FRAME_HINT,
          cause: thrown,
        }),
      );
    }

    // Read as `unknown`: the port is structural, and a broadcaster written in
    // plain JavaScript (or a stale double) may still answer `undefined`. Only a
    // positive count is a receipt; anything else is treated as nobody.
    let receipt: unknown;
    try {
      receipt = broadcaster.broadcastToKinds(state.sessionId, TAIL_CLIENT_KINDS, frame);
    } catch (thrown) {
      counters.framesUndelivered += 1;
      report(state, 'broadcastFailed', batch.length, {
        code: codeOf(thrown, 'TRANSPORT_DISCONNECTED'),
      });
      return {
        kind: 'undelivered',
        error: undeliveredError('broadcast-threw', batch.length, thrown),
      };
    }

    if (!(typeof receipt === 'number' && receipt > 0)) {
      counters.framesUndelivered += 1;
      report(state, 'noRecipient', batch.length);
      return { kind: 'undelivered', error: undeliveredError('no-recipient', batch.length) };
    }

    counters.framesSent += 1;
    counters.eventsSent += batch.length;
    return { kind: 'sent' };
  }

  /**
   * Removes a frame's events from the front of the buffer once its attempt has
   * concluded, checking identity rather than trusting a count.
   *
   * The frame was read as the buffer's prefix, but a broadcaster may re-enter
   * the tail while it holds the frame: a `push` can overflow the bound and evict
   * the oldest events — which are this frame's — and a `forget` or `close` can
   * empty the buffer. Both only ever take from the front, so whatever survives
   * of the frame is still the buffer's prefix, in order, and events pushed
   * meanwhile sit behind it. Walking the frame against the front therefore
   * removes exactly the frame's surviving events and never one pushed after it.
   */
  function removeFront(state: SessionTail, batch: readonly TelemetryEvent[]): void {
    let matched = 0;
    for (const event of batch) {
      if (matched < state.buffer.length && state.buffer[matched] === event) {
        matched += 1;
      }
    }
    if (matched > 0) {
      state.buffer.splice(0, matched);
    }
  }

  /**
   * Sends up to `maxFrames` frames from the front of a session's buffer.
   *
   * Each frame is **read** from the front, attempted, and only then removed:
   *
   * - sent — removed, and an open outage closes (the backoff resets);
   * - invalid — removed and discarded, and draining continues, because the
   *   next frame holds different events;
   * - undelivered — **kept**: it stays first in line, in order, with its ids
   *   in the dedupe window because it is still buffered. The drain stops, the
   *   attempt is booked against the outage, and the caller re-arms the retry.
   *
   * A drain entered while this session's frame is inside the broadcaster sends
   * nothing, so a re-entrant flush cannot deliver the same frame twice.
   */
  function drain(state: SessionTail, maxFrames: number): DrainOutcome {
    if (state.sending) {
      return { sent: 0, expired: 0, undelivered: false, failure: undefined };
    }
    let sent = 0;
    let expired = 0;
    let undelivered = false;
    let frames = 0;
    let failure: DebuggenError | undefined;

    while (frames < maxFrames && state.buffer.length > 0 && isLive(state)) {
      frames += 1;
      const batch = state.buffer.slice(0, maxEventsPerFrame);
      let outcome: FrameOutcome;
      state.sending = true;
      try {
        outcome = sendFrame(state, batch);
      } finally {
        state.sending = false;
      }

      if (outcome.kind === 'undelivered') {
        failure ??= outcome.error;
        undelivered = true;
        expired += noteUndelivered(state);
        break;
      }
      removeFront(state, batch);
      if (outcome.kind === 'sent') {
        sent += batch.length;
        noteDelivered(state);
      } else {
        failure ??= outcome.error;
      }
    }

    return { sent, expired, undelivered, failure };
  }

  /**
   * An explicit flush of one session: cancel the pending timer, drain the
   * whole buffer, and re-arm only if events are left behind — after an
   * undelivered frame that is the retry, at the outage's backoff delay.
   */
  function flushSession(state: SessionTail): DrainOutcome {
    disarm(state);
    const outcome = drain(state, Number.POSITIVE_INFINITY);
    const rearmed = arm(state);
    return {
      ...outcome,
      failure: outcome.failure ?? (rearmed.ok ? undefined : rearmed.error),
    };
  }

  /** {@link LiveTail.flush}, synchronously. */
  function flushNow(sessionId: SessionId | undefined): Result<number, DebuggenError> {
    if (closed) {
      return ok(0);
    }

    if (sessionId !== undefined) {
      const state = sessions.get(sessionId);
      if (state === undefined) {
        return ok(0);
      }
      const outcome = flushSession(state);
      const remaining = state.buffer.length;
      evictIdle();
      return outcome.failure === undefined
        ? ok(outcome.sent)
        : err(
            flushError(outcome.failure, {
              eventsSent: outcome.sent,
              eventsRemaining: remaining,
              eventsExpired: outcome.expired,
            }),
          );
    }

    let sent = 0;
    let remaining = 0;
    let expired = 0;
    let sessionsFailed = 0;
    let firstFailure: DebuggenError | undefined;
    for (const state of [...sessions.values()]) {
      const outcome = flushSession(state);
      sent += outcome.sent;
      expired += outcome.expired;
      remaining += state.buffer.length;
      if (outcome.failure !== undefined) {
        sessionsFailed += 1;
        firstFailure ??= outcome.failure;
      }
    }
    evictIdle();
    return firstFailure === undefined
      ? ok(sent)
      : err(
          flushError(firstFailure, {
            eventsSent: sent,
            eventsRemaining: remaining,
            eventsExpired: expired,
            sessionsFailed,
          }),
        );
  }

  /* ---- the public surface ---- */

  function push(
    sessionId: SessionId,
    events: readonly TelemetryEvent[],
  ): Result<void, DebuggenError> {
    if (closed) {
      return err(closedError());
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return err(
        new DebuggenError(
          'PROTOCOL_INVALID_MESSAGE',
          'A live-tail push needs the id of the session its events belong to',
          { hint: REJECTED_HINT },
        ),
      );
    }
    const candidates: unknown = events;
    if (!isArrayValue(candidates)) {
      return err(
        new DebuggenError(
          'PROTOCOL_INVALID_MESSAGE',
          'A live-tail push takes an array of persisted events',
          {
            hint: REJECTED_HINT,
          },
        ),
      );
    }
    if (candidates.length === 0) {
      return ok(undefined);
    }

    const state = stateFor(sessionId);
    let accepted = 0;
    let rejected = 0;
    let duplicates = 0;

    try {
      for (const candidate of candidates) {
        // The provenance guard, before anything is buffered: see the module
        // documentation. A refused value is counted, never read further, never
        // logged and never broadcast.
        const event = admit(candidate, sessionId);
        if (event === undefined) {
          rejected += 1;
          continue;
        }
        // A replayed batch comes back from insertMany as the stored rows, so
        // an id already buffered or recently sent is skipped, not an error.
        if (state.seen.has(event.id)) {
          duplicates += 1;
          continue;
        }
        state.buffer.push(event);
        remember(state, event.id);
        accepted += 1;
      }
    } catch {
      // Only an array whose iteration itself throws (a hostile proxy) gets
      // here; whatever was admitted before the throw stays buffered.
      rejected += 1;
    }

    counters.eventsRejected += rejected;
    counters.duplicatesSkipped += duplicates;
    report(state, 'rejected', rejected);
    report(state, 'duplicates', duplicates);

    const excess = state.buffer.length - maxBufferedEvents;
    if (excess > 0) {
      // Oldest first: the tail is a live view, so the newest evidence is the
      // useful evidence, and the dropped events are already in the store.
      state.buffer.splice(0, excess);
      if (state.outage === undefined) {
        counters.eventsDropped += excess;
        report(state, 'dropped', excess, { bound: maxBufferedEvents });
      } else {
        // The panel is unreachable and its backlog is at the bound: this is
        // the tail truncating what that panel will see on reconnect, not a
        // burst outrunning a healthy stream, so it is counted and logged apart.
        counters.eventsTruncatedWhileUndelivered += excess;
        report(state, 'truncated', excess, { bound: maxBufferedEvents });
      }
    }

    const armed = arm(state);
    evictIdle();

    if (rejected > 0) {
      return err(
        new DebuggenError(
          'PROTOCOL_INVALID_MESSAGE',
          'The live tail refused events that are not persisted events of this session',
          { hint: REJECTED_HINT, details: { rejected, accepted, duplicates } },
        ),
      );
    }
    return armed;
  }

  function forget(sessionId: SessionId): void {
    const state = sessions.get(sessionId);
    if (state !== undefined) {
      release(state);
    }
  }

  function stats(): LiveTailStats {
    let buffered = 0;
    for (const state of sessions.values()) {
      buffered += state.buffer.length;
    }
    return Object.freeze({ buffered, sessions: sessions.size, ...counters });
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    for (const state of [...sessions.values()]) {
      release(state);
    }
    sessions.clear();
  }

  return Object.freeze({
    push,
    flush(sessionId?: SessionId): Promise<Result<number, DebuggenError>> {
      return Promise.resolve(flushNow(sessionId));
    },
    forget,
    stats,
    close,
  });
}
