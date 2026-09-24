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
 *   **oldest** buffered events are dropped and counted in `eventsDropped`.
 *   Oldest-first because the tail is a live view: the newest evidence is the
 *   evidence the developer is looking at, and nothing is lost — the
 *   authoritative record is already in the store, where panel-data queries read
 *   it. The tail payload has no field for a drop count, so the count goes to
 *   {@link LiveTail.stats} and to the log, never onto the wire.
 * - **Duplicates:** `TelemetryRepo.insertMany` answers a replayed agent batch
 *   (`ON CONFLICT(id) DO NOTHING`) with the stored rows, so ingest may push an
 *   event the tail has already buffered or sent. Each session keeps a bounded
 *   window of recent event ids — twice the buffer bound, which always covers the
 *   whole buffer plus at least as many recently sent ids — and skips a repeat,
 *   counting it in `duplicatesSkipped`. That is not an error.
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
 * and never builds a per-tab route of its own. The broadcaster is the
 * `SessionBroadcaster` port `../sessions/manager.ts` declares, so no WebSocket
 * or HTTP detail reaches this folder.
 *
 * ## Failure
 *
 * Nothing here throws — not `push`, not `flush`, not a timer callback, and not
 * when an injected broadcaster, scheduler, clock or logger does. Every frame is
 * validated with `parseTelemetryTailPayload` (the non-throwing form of
 * `telemetryTailPayloadSchema.safeParse`) before it is built, so no frame that
 * would fail the schema is ever emitted; a failure is a counted `Err`. A
 * broadcast that throws is caught and counted, that frame's events are not
 * retried (the store holds them), and the rest of the buffer stays queued with
 * the timer re-armed so it is delivered once the transport recovers.
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
import type { ClientKind, TelemetryTailPayload } from '@debuggen/protocol';
import { DebuggenError, err, noopLogger, nowEpochMs, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result, SessionId } from '@debuggen/shared';
import { parseTelemetryEvent } from '@debuggen/telemetry';
import type { TelemetryEvent } from '@debuggen/telemetry';

import { sessionLogger, subsystemLogger } from '../logging.js';
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
 * is handled, a throw is caught and counted), but frames are only paced as
 * documented when the contract holds.
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
 * Everything {@link createLiveTail} is given; everything but the broadcaster is
 * optional and defaults to the production choice.
 */
export interface LiveTailDeps {
  /**
   * Where finished frames go: the session broadcaster port declared by
   * `../sessions/manager.ts`, satisfied in production by the client registry in
   * `../server/clients.ts`. Only `broadcastToKinds` is called, always with
   * {@link TAIL_CLIENT_KINDS}.
   */
  readonly broadcaster: SessionBroadcaster;

  /** The parent logger; records are bound to this subsystem and the session. Defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;

  /**
   * The clock the log throttle reads, in Unix epoch milliseconds. Defaults to
   * `nowEpochMs` from `@debuggen/shared`. Never applied to an event: `startTime`
   * and `duration` are forwarded exactly as the store holds them.
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
  /** Frames handed to the broadcaster without error. */
  readonly framesSent: number;
  /** Events carried by those frames. */
  readonly eventsSent: number;
  /** Events evicted, oldest first, because a session's buffer was full. */
  readonly eventsDropped: number;
  /** Events refused by the provenance guard: not a persisted event of the session they were pushed for. */
  readonly eventsRejected: number;
  /** Events skipped because the same event id was already buffered or recently sent. */
  readonly duplicatesSkipped: number;
  /** Frames that failed validation or whose broadcast threw. */
  readonly framesFailed: number;
  /** Events carried by those failed frames; the store still holds every one. */
  readonly eventsFailed: number;
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
   * failed validation (`PROTOCOL_INVALID_MESSAGE`) or its broadcast threw
   * (`TRANSPORT_DISCONNECTED`). Either way the details carry `eventsSent`, and
   * after a broadcast failure the undelivered remainder stays buffered with the
   * timer re-armed.
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

/** The next step offered when a frame could not be delivered. */
const UNDELIVERED_HINT =
  'The DevTools connection may be reconnecting; undelivered events remain in the store and the rest of the buffer is retried on the next flush.';

/** The next step offered when a frame failed validation. */
const INVALID_FRAME_HINT =
  'A telemetry.tail frame carries only persisted events of its own session; this indicates a defect in the ingest path, and the events remain in the store.';

/** The next step offered when the flush timer could not be scheduled. */
const TIMER_HINT =
  'Buffered events are delivered by the next explicit flush or by the next push that schedules successfully.';

/** The kinds of record the per-session throttle tracks separately. */
type ReportKind =
  'rejected' | 'dropped' | 'duplicates' | 'frameInvalid' | 'broadcastFailed' | 'timerFailed';

/** The log levels this module writes at. */
type ReportLevel = 'debug' | 'warn' | 'error';

/**
 * What each report kind is logged as: a constant message and a level. The
 * messages name counts and never a value; a record's only variable fields are
 * `count`, and for some kinds a bound or an error `code`.
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
  duplicates: {
    level: 'debug',
    message: 'Live tail skipped events it had already buffered or sent',
  },
  frameInvalid: {
    level: 'error',
    message: 'Live tail frame failed validation; its events were not broadcast',
  },
  broadcastFailed: {
    level: 'error',
    message:
      'Live tail broadcast failed; the frame was not delivered and the rest of the buffer is kept',
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
}

/** Everything the live tail holds for one session. */
interface SessionTail {
  readonly sessionId: SessionId;
  /** The session-bound child logger. */
  readonly logger: Logger;
  /** Admitted, not yet sent events, oldest first. */
  readonly buffer: TelemetryEvent[];
  /** Ids of buffered and recently sent or dropped events, in admission order. */
  readonly seen: Set<string>;
  /** The pending flush, if one is armed. */
  armed: ArmedFlush | undefined;
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
  /** The first failure met, if any. */
  readonly failure: DebuggenError | undefined;
}

// ---------------------------------------------------------------------------
// Section D — total helpers
// ---------------------------------------------------------------------------

/**
 * Writes one record, swallowing a logger that throws: logging is diagnostic,
 * and a failing sink must not turn a handled condition into an exception.
 */
function emit(logger: Logger, level: ReportLevel, message: string, fields: LogFields): void {
  try {
    logger[level](message, fields);
  } catch {
    // Deliberately ignored: there is nowhere left to report a failing logger.
  }
}

/**
 * Derives a child logger without trusting the parent's `child` not to throw.
 *
 * @param derive The derivation to attempt.
 * @param fallback The logger to use when it throws.
 * @returns The derived logger, or `fallback`.
 */
function deriveLogger(derive: () => Logger, fallback: Logger): Logger {
  try {
    return derive();
  } catch {
    return fallback;
  }
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
 * Guarded, because an injected scheduler's handle need not.
 */
function unrefTimer(timer: TailTimer): void {
  try {
    timer.unref?.();
  } catch {
    // An `unref` that throws only means the timer keeps the process alive.
  }
}

/** The error `push` answers after {@link LiveTail.close}. */
function closedError(): DebuggenError {
  return new DebuggenError('TRANSPORT_DISCONNECTED', 'The live tail is closed', {
    hint: CLOSED_HINT,
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
 * const frames: ProtocolMessage[] = [];
 * const liveTail = createLiveTail({
 *   broadcaster: {
 *     broadcast: () => undefined,
 *     broadcastToKinds: (_sessionId, _kinds, message) => void frames.push(message),
 *   },
 *   scheduler: { setTimer: () => ({}), clearTimer: () => undefined },
 * });
 * liveTail.push(sessionId, persistedEvents);
 * const flushed = await liveTail.flush(sessionId); // ok(persistedEvents.length)
 * ```
 */
export function createLiveTail(deps: LiveTailDeps): LiveTail {
  const { broadcaster } = deps;
  const rootLogger = deriveLogger(
    () => subsystemLogger(deps.logger ?? noopLogger, TAIL_SUBSYSTEM),
    noopLogger,
  );
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
  };
  let closed = false;
  let lastClockReading = 0;

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
    } catch {
      // Fall through to the last good reading.
    }
    return lastClockReading;
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
      logger: deriveLogger(() => sessionLogger(rootLogger, sessionId), rootLogger),
      buffer: [],
      seen: new Set<string>(),
      armed: undefined,
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
   * pending. The single timer per session is what coalesces a burst.
   */
  function arm(state: SessionTail): Result<void, DebuggenError> {
    if (!isLive(state) || state.armed !== undefined || state.buffer.length === 0) {
      return ok(undefined);
    }
    const armed: ArmedFlush = { timer: undefined };
    state.armed = armed;
    try {
      const timer = scheduler.setTimer(() => {
        onTimer(state, armed);
      }, flushIntervalMs);
      armed.timer = timer;
      unrefTimer(timer);
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
    }
    return ok(undefined);
  }

  /**
   * A scheduled flush: one frame, then re-arm if events remain, so a burst
   * drains across several frames at the coalescing pace. A callback whose
   * token is no longer current — cancelled, superseded, or for a released or
   * closed tail — does nothing.
   */
  function onTimer(state: SessionTail, armed: ArmedFlush): void {
    if (!isLive(state) || state.armed !== armed) {
      return;
    }
    state.armed = undefined;
    drain(state, 1);
    arm(state);
    evictIdle();
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

  /**
   * Validates, wraps and delivers one frame to the session's bound DevTools
   * connection. A frame that fails validation is never built; a broadcast that
   * throws is caught and counted.
   */
  function sendFrame(state: SessionTail, batch: readonly TelemetryEvent[]): FrameOutcome {
    const validated = validateFrame(state.sessionId, batch);
    if (!validated.ok) {
      counters.framesFailed += 1;
      counters.eventsFailed += batch.length;
      report(state, 'frameInvalid', batch.length, { code: validated.error.code });
      return { kind: 'invalid', error: validated.error };
    }

    try {
      broadcaster.broadcastToKinds(
        state.sessionId,
        TAIL_CLIENT_KINDS,
        createEnvelope('telemetry.tail', validated.value),
      );
    } catch (thrown) {
      counters.framesFailed += 1;
      counters.eventsFailed += batch.length;
      report(state, 'broadcastFailed', batch.length, {
        code: codeOf(thrown, 'TRANSPORT_DISCONNECTED'),
      });
      return {
        kind: 'undelivered',
        error: new DebuggenError(
          'TRANSPORT_DISCONNECTED',
          'The live tail could not deliver a frame',
          {
            hint: UNDELIVERED_HINT,
            details: { events: batch.length },
            cause: thrown,
          },
        ),
      };
    }

    counters.framesSent += 1;
    counters.eventsSent += batch.length;
    return { kind: 'sent' };
  }

  /**
   * Sends up to `maxFrames` frames from the front of a session's buffer.
   *
   * An invalid frame is discarded and draining continues, because the next
   * frame holds different events. An undelivered frame stops the drain — the
   * transport is failing, so the rest of the buffer is kept for the next
   * attempt — and its ids leave the dedupe window, so a replay that arrives
   * once the transport recovers is tailed rather than skipped.
   */
  function drain(state: SessionTail, maxFrames: number): DrainOutcome {
    let sent = 0;
    let frames = 0;
    let failure: DebuggenError | undefined;

    while (frames < maxFrames && state.buffer.length > 0 && isLive(state)) {
      frames += 1;
      const batch = state.buffer.splice(0, maxEventsPerFrame);
      const outcome = sendFrame(state, batch);
      if (outcome.kind === 'sent') {
        sent += batch.length;
        continue;
      }
      failure ??= outcome.error;
      if (outcome.kind === 'undelivered') {
        for (const event of batch) {
          state.seen.delete(event.id);
        }
        break;
      }
    }

    return { sent, failure };
  }

  /**
   * An explicit flush of one session: cancel the pending timer, drain the
   * whole buffer, and re-arm only if a failure left events behind.
   */
  function flushSession(state: SessionTail): DrainOutcome {
    disarm(state);
    const outcome = drain(state, Number.POSITIVE_INFINITY);
    const rearmed = arm(state);
    return {
      sent: outcome.sent,
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
            flushError(outcome.failure, { eventsSent: outcome.sent, eventsRemaining: remaining }),
          );
    }

    let sent = 0;
    let remaining = 0;
    let sessionsFailed = 0;
    let firstFailure: DebuggenError | undefined;
    for (const state of [...sessions.values()]) {
      const outcome = flushSession(state);
      sent += outcome.sent;
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
      counters.eventsDropped += excess;
      report(state, 'dropped', excess, { bound: maxBufferedEvents });
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
