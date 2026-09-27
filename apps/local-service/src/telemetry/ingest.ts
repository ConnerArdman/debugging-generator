/**
 * Telemetry ingest — the evidence entry point of the local service.
 *
 * Every runtime signal the product ever shows a developer passes through this
 * module exactly once: the page agent's interactions, React commits, requests
 * and performance entries (relayed by the Chrome service worker as a
 * `telemetry.event` frame) and the dev-server preload's HTTP, route-handler,
 * function and database spans (posted to `POST /telemetry/ingest`). It is the
 * first of the two redaction points of AAP §0.5.2 — the one that runs "before
 * any event is persisted or broadcast" — and the middle of AAP §0.7.1 Group 2:
 * "validate ingress → compute `request_key` → redact → attribute to the bound
 * session's active capture → persist → correlate incrementally → tail to
 * DevTools".
 *
 * ## The pipeline, in order — the order is the privacy guarantee
 *
 * 1. **Bound the batch.** The batch must be an array of at most
 *    {@link MAX_INGEST_BATCH} elements (or the lower `maxBatch` a caller
 *    configured). Anything else is a typed `Err`; a batch is never truncated.
 *    An empty batch is answered with an empty report and touches nothing,
 *    unless it is a **loss-only** batch: no events beside a positive loss
 *    report, which either producer sends when no later batch will carry its
 *    loss (at a capture's end). A loss-only batch goes through steps 1, 2 and
 *    2½ only, then straight to step 11.
 * 2. **Resolve attribution once.** `attributor.resolveBatch(context)` names the
 *    session and the open capture window from the batch's *transport* identity
 *    (the bound tab, or the `server-agent` credential's scoped project). A
 *    refusal is a drop: the whole batch is counted under its `DropReason` and
 *    **nothing is parsed, hashed, persisted or broadcast** — which is what makes
 *    "an unrelated plan collects no backend telemetry" true end to end. A
 *    batch of either transport whose `armedCaptureId` — the capture it was
 *    recorded for — is not the open capture is refused here as
 *    `stale-capture` (see `./attribute.ts`).
 * 2½. **Account producer loss.** A batch of either transport may say how many
 *    events its producer discarded since its previous loss report
 *    (`droppedCount`): the page agent's buffer is bounded at 5 000 events
 *    while the bridge is away, and the dev-server preload's
 *    exporter caps its buffer and gives up on a batch it could not deliver.
 *    Once the batch is attributed, that count is handed to the store's
 *    optional loss ledger (`telemetry.recordProducerLoss`) against the
 *    **attributed** session and capture, so the capture's summary can say its
 *    evidence is incomplete rather than look whole. It is recorded here, before
 *    the batch's own events are processed, because the loss happened whatever
 *    becomes of them; a refused batch records nothing, since the capture its
 *    loss belongs to is exactly what could not be established — a loss-only
 *    batch and a `stale-capture` batch included. A ledger failure is logged and
 *    never fails the batch. For a loss-only batch this is the whole of its
 *    work: no secret is read and nothing is parsed, persisted, correlated or
 *    tailed.
 *    A server batch may name its loss report (`lossReportId`): the preload's
 *    exporter keeps one id for every retry and resend of the same report,
 *    because it sends the same body again after a failure — including one
 *    this pipeline had already recorded the loss of, before a later step
 *    failed the batch or the acknowledgement was lost. A named report is
 *    applied to a capture once: after the ledger has accepted it, a delivery
 *    repeating the same attributed capture and id records nothing and adds
 *    nothing to the report's `producerDropped`, while the rest of its batch is
 *    processed as usual. Until the ledger has accepted it — no ledger, a
 *    refusal or a failure — a repeat is recorded like a first delivery. An id
 *    is only ever a de-duplication key, bounded by
 *    {@link MAX_APPLIED_LOSS_REPORTS}: it attributes and authorizes nothing,
 *    and no record carries it. A report without an id, or with a malformed
 *    one, is recorded on every delivery.
 * 3. **One request-key hasher per batch.** The session's secret is read from
 *    the store and `createRequestKeyHasher` is called once, so the
 *    non-extractable HMAC key is imported once per batch, not once per event.
 *    The secret lives in a local variable for the length of that call and
 *    nowhere else — never in a log record, a report, an error or a broadcast.
 * 4. **Parse every element** with `parseTelemetryEventIngress`. A malformed
 *    element is counted as `invalid` and skipped; its siblings continue. The
 *    strict ingress schema refuses `sessionId`, `captureId` and `ingestSeq`, so
 *    nothing is added to an event before this step. It is also what validates
 *    a producer's optional `clockOffsetMs`: a whole number of milliseconds
 *    within `±CLOCK_OFFSET_BOUND_MS`, so a fractional or out-of-bound offset
 *    makes its element `invalid` rather than reaching the store.
 * 5. **Assign `request_key`** — from the **unredacted** URL, before step 6.
 *    Producer-supplied service-assigned keys are stripped from every event
 *    first; then a request-kind event carrying a method and a URL receives the
 *    digest under the upstream `SERVICE_ASSIGNED_ATTRIBUTE_KEYS` name. A digest
 *    that cannot be computed costs the event its duplicate group, never the
 *    event itself.
 * 6. **Redact** — `redactEvent`, exactly once per event, on the event that now
 *    carries its key. Nothing unredacted leaves this step: an event the
 *    redactor cannot process is counted and never stored.
 * 7. **Attribute** — `attributor.attributeEvent` stamps `sessionId` and
 *    `captureId` and applies the tier gate; a dropped event is counted under
 *    its reason and never stored.
 * 7½. **Locate** — the optional `sources` port places every attributed event
 *    in the project's code (AAP §0.4.2, "Source resolution path": patch
 *    metadata, route map, code graph, or the fetch initiator mapped through the
 *    dev server's source map). A producer-stamped `source` is a **claim**, not
 *    a location: the page agent shares the page's main world, so a page script
 *    can stamp any event it posts. Every event goes to the port — a `patch`
 *    claim with it, for corroboration against the modification journal; a
 *    claim on any other route withheld, since only a patch records a position
 *    a producer can carry — and the stored `source` is exactly the port's
 *    answer for that event id; a claim the port does not return is removed and
 *    counted in `sourcesRefused`. It runs on redacted, attributed events and
 *    **before** persistence, so the stored document, the correlator and the
 *    live tail all carry the same verified location. A failure is counted and
 *    logged, never fatal: the event is stored without a location — its claim
 *    removed too, since nothing verified it — rather than not at all. Without
 *    a port no claim can be verified, so none is kept.
 *    The step is bounded by the locate budget ({@link DEFAULT_LOCATE_BUDGET_MS}):
 *    the locator is asked to answer with what it has when the budget fires and
 *    is no longer awaited once {@link LOCATE_BUDGET_GRACE_MS} more has passed,
 *    so a slow dev server or index can delay a batch by that much and never
 *    stall live capture; events left unplaced are counted as
 *    `sourcesUnplacedByBudget`, and a claim the budget left unverified is
 *    removed like any other.
 * 8. **Persist** — one `telemetry.insertMany` call for the whole batch. The
 *    store assigns `ingestSeq` and returns the rows as it holds them; a store
 *    failure is a typed `Err` and nothing is retried or broadcast. The events
 *    carrying a `clockOffsetMs` are counted as they are handed over
 *    (`clockOffsetsReported`); the store projects each offset into
 *    `telemetry_events.clock_offset_ms`.
 * 9. **Correlate** — `correlator.onEventsPersisted` with the rows the store
 *    **returned** (they carry the attribution and `ingestSeq`). The correlator
 *    marks the traces they touch stale, in time proportional to the batch and
 *    with no store read, and each rebuilds once from the store on its next
 *    read, however many batches landed in between. A failure is logged and
 *    counted, never fatal: the evidence is durable.
 * 10. **Tail** — `liveTail.push` with the same returned rows. A failure is
 *     logged and counted, never fatal. The tail de-duplicates by event id, so
 *     rows the store skipped as idempotent replays are safe to send again.
 * 11. **Report** — `ok(IngestReport)`: counts, identifiers and trace ids only.
 *
 * Steps 4 to 7 run strictly in that order for every event. They are executed
 * phase by phase over the batch (every element parsed, then every key computed
 * concurrently on the shared hasher, then each event redacted and attributed),
 * which preserves the per-event order while letting the HMAC work overlap.
 *
 * Moving any step is a defect, and the colocated suite proves the order with
 * call-order spies. In particular: redaction after persistence or after the
 * tail would store or broadcast raw captured data; a key computed after
 * redaction would hash `productId=?` for every request and merge distinct
 * requests into one "duplicate" group.
 *
 * ## Sharing the event loop
 *
 * Every call ends — after step 11, whatever the outcome, a refusal or a typed
 * `Err` included — with one genuine **macrotask** turn (`setImmediate` from
 * `node:timers/promises`, or the injected {@link TelemetryIngestDeps.yieldTurn})
 * before its promise settles. The report is decided before the turn and is
 * returned unchanged after it; nothing is read, written or logged during it.
 *
 * The turn exists because a batch need not await any real I/O: the store is
 * synchronous (`node:sqlite`), a render-only batch computes no `request_key`
 * digest, and a locator that answers from memory settles in microtasks. The
 * WebSocket surface (`../server/ws.ts`) chains one connection's frames on a
 * promise, so without the turn a connection's whole backlog of such batches
 * would drain inside a single macrotask — and every other client of the
 * process would wait for it: `GET /health`, the other sockets, and the
 * `client.ping` the same connection queued behind its telemetry, answered in
 * frame order only once the backlog is gone. With the turn, the event loop
 * services timers, sockets and HTTP between any two batches, so one
 * producer's backlog delays the others by at most one batch.
 *
 * ## Failure contract
 *
 * Nothing here throws and no returned promise rejects — not for `null`, not
 * for a non-array, not for an element with a throwing getter, and not when an
 * injected dependency throws. Every fallible step answers with a `Result`:
 *
 * - a malformed element is counted and skipped (partial success, AAP §0.5.5);
 * - an unresolvable batch is `ok` with the drop counted, so a route can answer
 *   "accepted, nothing stored" rather than a `5xx` a producer would retry
 *   (`report.batchDropReason` and `report.batchDropCode` let a route answer a
 *   `project-scope-mismatch` as an authorization refusal instead, if it
 *   chooses);
 * - a non-array or over-size batch, an unavailable request-key secret and a
 *   store failure are typed `Err`s carrying a code from `@debuggen/shared`'s
 *   closed vocabulary, and a WebSocket caller keeps its socket open.
 *
 * ## Privacy of what this module says
 *
 * Log records carry counts, identifiers, error codes and schema vocabulary
 * only — never an event `name`, an attribute value, a URL, a `db.statement`, a
 * header value, a `request_key` digest or the session secret — and no caught
 * value is ever echoed into a log record or an error payload. Validation
 * failures are summarised by zod issue codes and top-level schema field names
 * taken from the upstream parse helper, never by the rejected value.
 *
 * ## Rate of what this module says
 *
 * Producers choose how often they send, so no warning or error is written per
 * batch unconditionally. Each is admitted by one {@link createLogThrottle} per
 * pipeline, keyed by its class and scope — the session once the batch is
 * attributed; before that the producer: the origin with the relayed tab, or
 * with a digest of the server agent's credential project — and optionally its
 * error code: one record per key per {@link LOG_THROTTLE_INTERVAL_MS}, at most
 * {@link LOG_THROTTLE_MAX_RECORDS_PER_INTERVAL} across all keys, each written
 * record carrying `suppressed` (and `suppressedUntracked`) counts of what was
 * held back. Held-back occurrences that no later record carries are written as
 * a trailing summary (`trailingSummary: true`) one interval later, so a flood
 * that stops is still reported. The debug records of batches that stored
 * nothing — empty, loss-only, dropped whole, or entirely malformed — pass
 * through a separate throttle of the same shape, keyed by their producer (and
 * session, once attributed), so the first such batch of every producer in an
 * interval is reported whole and only its repeats are summarised; the debug
 * record of a batch that stored evidence is not throttled, being bounded by
 * the evidence itself. Keys are never written.
 *
 * ## Time base
 *
 * `startTime` (epoch milliseconds as a double) and `duration` (milliseconds)
 * pass through untouched for both tiers. The injected clock is read only to
 * measure this module's own elapsed time for the summary log line and to pace
 * the log throttle.
 *
 * A producer's `clockOffsetMs` — its informational estimate of `server clock −
 * producer clock` (AAP 0.2.3, `@debuggen/telemetry`'s `ClockOffsetEstimator`),
 * stamped once when it created the event — passes through the same way: it is
 * validated at step 4 and persisted at step 8, and it is never applied to
 * `startTime` or `duration` and never re-derived here. The service's clock
 * plays no part in it; the summary log line carries only how many events
 * reported one and the largest magnitude among them.
 *
 * @example
 * ```ts
 * const ingest = createTelemetryIngest({
 *   telemetry: telemetryRepo,
 *   sessions: sessionsRepo,
 *   attributor: createIngestAttributor({ sessions: sessionsRepo, sessionManager, logger }),
 *   correlator,
 *   liveTail,
 *   logger,
 * });
 *
 * // ../server/routes/telemetry.ts — a telemetry.event frame relayed for an inspected tab:
 * const fromTab = await ingest.ingestFromAgent({
 *   tabId,
 *   events: payload.events,
 *   ...(payload.armedCaptureId === undefined ? {} : { armedCaptureId: payload.armedCaptureId }),
 *   ...(payload.droppedCount === undefined ? {} : { droppedCount: payload.droppedCount }),
 * });
 *
 * // ../server/routes/telemetry.ts — POST /telemetry/ingest with a server-agent credential:
 * const fromServer = await ingest.ingestFromServerAgent({
 *   projectRoot: body.projectRoot,
 *   scopedProjectRoot: principal.scope,
 *   events: body.events,
 *   ...(body.armedCaptureId === undefined ? {} : { armedCaptureId: body.armedCaptureId }),
 *   ...(body.droppedCount === undefined ? {} : { droppedCount: body.droppedCount }),
 *   ...(body.lossReportId === undefined ? {} : { lossReportId: body.lossReportId }),
 * });
 * if (fromServer.ok) {
 *   return c.json(toIngestResponse(fromServer.value), 202);
 * }
 * ```
 *
 * @module
 */

import { setImmediate as nextMacrotask } from 'node:timers/promises';

import { telemetryEventPayloadSchema, telemetryIngestRequestSchema } from '@debuggen/protocol';
import type { TelemetryIngestResponse } from '@debuggen/protocol';
import { DebuggenError, err, isErr, noopLogger, nowEpochMs, ok, roundMs } from '@debuggen/shared';
import type {
  CaptureId,
  DebuggenErrorCode,
  LogFields,
  Logger,
  ProducerId,
  Result,
  SessionId,
  SourceLocation,
  SourceResolvedBy,
  TraceId,
} from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';
import {
  KIND_ATTRIBUTE_KEYS,
  REQUEST_KINDS,
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
  createRequestKeyHasher,
  parseTelemetryEventIngress,
  redactEvent,
  telemetryEventIngressSchema,
} from '@debuggen/telemetry';
import type {
  FETCH_ATTRIBUTE_KEYS,
  RequestKeyHasher,
  TelemetryEvent,
  TelemetryEventIngress,
  XHR_ATTRIBUTE_KEYS,
} from '@debuggen/telemetry';

import { LOG_BINDING_KEYS, guardLogger, sessionLogger, subsystemLogger } from '../logging.js';
import type { InsertTelemetryResult, PersistableTelemetryEvent } from '../store/telemetry-repo.js';
import {
  DROP_REASONS,
  INGEST_ORIGIN_CLIENT_KIND,
  attributionDropReason,
  isDropReason,
} from './attribute.js';
import type {
  AttributedEvent,
  BrowserIngestContext,
  DropReason,
  IngestAttribution,
  IngestAttributor,
  IngestContext,
  IngestOrigin,
  ServerIngestContext,
} from './attribute.js';
import type { TraceCorrelator } from './correlate.js';
import type { LiveTail } from './live-tail.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `subsystem` binding every record from this module carries, so a
 * session's ingest activity can be filtered without matching message text.
 */
export const INGEST_SUBSYSTEM = 'telemetry.ingest';

/**
 * A structural view of a Zod array schema: just enough to read the bounds its
 * checks declare. Zod exposes a schema's definition, including its checks, as
 * `def`; each check describes itself on `_zod.def`.
 */
interface ArraySchemaView {
  readonly def: { readonly checks?: readonly unknown[] | undefined };
}

/**
 * Reads a record-shaped property of an unknown value, or `undefined`.
 *
 * @param value Any value.
 * @param key The property to read.
 * @returns The property's value when `value` is a non-null object, otherwise `undefined`.
 */
function readProperty(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;
}

/**
 * The smallest `max_length` bound an array schema declares.
 *
 * @param schema The array schema of one transport's `events` field.
 * @returns The declared maximum element count, or `undefined` when the schema
 * declares none that this function can read.
 */
function declaredMaxItems(schema: ArraySchemaView): number | undefined {
  try {
    let bound: number | undefined;

    for (const check of schema.def.checks ?? []) {
      const definition = readProperty(readProperty(check, '_zod'), 'def');
      const kind = readProperty(definition, 'check');
      const maximum = readProperty(definition, 'maximum');

      if (
        kind === 'max_length' &&
        typeof maximum === 'number' &&
        Number.isSafeInteger(maximum) &&
        maximum > 0
      ) {
        bound = bound === undefined ? maximum : Math.min(bound, maximum);
      }
    }

    return bound;
  } catch {
    return undefined;
  }
}

/**
 * The transport batch bound, read from the two protocol schemas that own it.
 *
 * @returns The smaller of the two bounds, or `0` when neither can be read —
 * fail closed, so a batch is refused rather than accepted without a ceiling.
 */
function transportBatchBound(): number {
  const bounds = [
    declaredMaxItems(telemetryEventPayloadSchema.shape.events),
    declaredMaxItems(telemetryIngestRequestSchema.shape.events),
  ].filter((bound): bound is number => bound !== undefined);

  return bounds.length === 0 ? 0 : Math.min(...bounds);
}

/**
 * The most events one ingest call accepts.
 *
 * Taken from `@debuggen/protocol`, never restated: it is the element bound
 * that protocol's `telemetry.event` payload schema and its
 * `POST /telemetry/ingest` request schema each declare on their `events`
 * array (both hold the transport ceiling that package keeps module-local as
 * `MAX_EVENTS_PER_BATCH`, which it deliberately does not export because
 * `@debuggen/telemetry` exports a different number under that name). The
 * smaller of the two is used, so a batch this module accepts is one either
 * transport would have accepted.
 *
 * It is a ceiling on a malformed or hostile batch, not a quota: the page agent
 * flushes a few hundred events per frame and the preload a few hundred spans
 * per request. A longer batch is refused whole — never truncated.
 */
export const MAX_INGEST_BATCH: number = transportBatchBound();

/**
 * An attribute key both request-kind vocabularies declare, so a rename
 * upstream fails the constants below at compile time.
 */
type RequestAttributeKey = Extract<
  (typeof FETCH_ATTRIBUTE_KEYS)[number],
  (typeof XHR_ATTRIBUTE_KEYS)[number]
>;

/** The request attribute carrying the URL. */
const URL_ATTRIBUTE: RequestAttributeKey = 'url';

/** The request attribute carrying the HTTP method. */
const METHOD_ATTRIBUTE: RequestAttributeKey = 'http.method';

/**
 * The attribute the `request_key` digest is written under.
 *
 * Derived from the upstream vocabulary rather than spelled here: the member of
 * `SERVICE_ASSIGNED_ATTRIBUTE_KEYS` that every request kind (`REQUEST_KINDS`)
 * declares in its attribute catalog — the key the service assigns to
 * requests, and the one `@debuggen/telemetry`'s request aggregates group by.
 * `undefined` only if an upstream edit removed it from either list, in which
 * case no digest is written (grouping degrades, evidence is kept) while
 * producer-supplied service-assigned keys are still stripped.
 */
export const INGEST_REQUEST_KEY_ATTRIBUTE: string | undefined =
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS.find(
    (key) =>
      REQUEST_KINDS.length > 0 &&
      REQUEST_KINDS.every((kind) => KIND_ATTRIBUTE_KEYS[kind].includes(key)),
  );

/** Service-assigned attribute keys, which a producer may never set. */
const SERVICE_ASSIGNED_KEYS: ReadonlySet<string> = new Set<string>(SERVICE_ASSIGNED_ATTRIBUTE_KEYS);

/** The kinds that receive a `request_key`: requests initiated by the page. */
const REQUEST_KIND_SET: ReadonlySet<string> = new Set<string>(REQUEST_KINDS);

/**
 * The top-level field names of an ingress event: schema vocabulary, and so the
 * only path segments a validation-failure log record may name.
 */
const INGRESS_FIELD_NAMES: ReadonlySet<string> = new Set<string>(
  Object.keys(telemetryEventIngressSchema.shape),
);

/**
 * The only resolution route a producer may claim for its own event.
 *
 * AAP §0.4.2 ("Source resolution path") gives producers exactly one location
 * to carry: the position `@debuggen/instrumentation` recorded when it patched
 * a function, which both tiers' span helpers stamp `resolvedBy: 'patch'`. Every
 * other route — route map, code graph, source map, React owner chain — is the
 * service's own computation from the event's evidence, so a producer-stamped
 * location on one of them is not a candidate worth vetting: it is removed
 * before step 7½'s locator sees the event, and the locator computes its own.
 * A `patch` claim is still only a claim; the locator corroborates it against
 * the session's modification journal.
 */
const PRODUCER_CLAIMABLE_ROUTES: ReadonlySet<SourceResolvedBy> = new Set<SourceResolvedBy>([
  'patch',
]);

/** The issue code recorded for an element whose properties could not even be read. */
const UNREADABLE_ISSUE_CODE = 'unreadable';

/** The most distinct issue codes or field names one log record lists. */
const MAX_LOGGED_ISSUE_LABELS = 16;

/**
 * How long step 7½ may hold a batch by default, in milliseconds.
 *
 * Locating is enrichment; persistence and the live tail are the evidence. The
 * source-map route waits on the dev server (up to `fetchSourceMap`'s five-second
 * timeout per chunk), so without a bound one slow chunk would delay every event
 * of the batch — and the DevTools tail with it. A second and a half covers an
 * index already in memory and a warm dev server with room to spare; whatever is
 * still unplaced then is stored without a location, counted in
 * {@link IngestReport.sourcesUnplacedByBudget}.
 */
export const DEFAULT_LOCATE_BUDGET_MS = 1_500;

/**
 * The largest budget {@link TelemetryIngestDeps.locateBudgetMs} honours. A
 * longer wait would hold the live tail past what a developer watching it reads
 * as live, which is the stall the budget exists to prevent.
 */
export const MAX_LOCATE_BUDGET_MS = 10_000;

/**
 * How long past its budget a locator is still awaited before ingest stops
 * waiting for it. The budget is a request — "answer with what you have" — and
 * this is its enforcement: a locator that ignores the signal cannot hold a batch
 * longer than the budget plus this grace.
 */
export const LOCATE_BUDGET_GRACE_MS = 100;

/**
 * How many applied loss reports one pipeline remembers: **4 096**
 * `(capture, lossReportId)` keys, the oldest forgotten first.
 *
 * The keys exist so that a loss report the preload's exporter sends again is
 * applied to its capture once (pipeline step 2½). A report is sent again only
 * while it is still the exporter's to deliver: within one batch's bounded
 * attempts, or on the next post for its capture after those attempts failed —
 * and the exporter posts one batch at a time and reports loss only when it
 * discarded events. So a repeat arrives after a handful of other reports have
 * been applied, not thousands, and a key this bound forgets is one no producer
 * still sends. Each key holds a capture id and an id of at most
 * {@link MAX_LOSS_REPORT_ID_LENGTH} characters, so the whole set stays well
 * under a megabyte.
 *
 * The keys live for the process, like the ledger they guard: the store's
 * producer-loss ledger is itself in memory, so a service restart empties both,
 * and the ledger then reports the open capture as unaccounted. No total
 * outlives the keys that keep it from counting a report twice, and keys that
 * outlived the ledger would protect nothing.
 */
export const MAX_APPLIED_LOSS_REPORTS = 4_096;

/**
 * The longest `lossReportId` step 2½ keys a report on: the bound
 * `@debuggen/protocol` holds every identifier field of a telemetry body to.
 */
const MAX_LOSS_REPORT_ID_LENGTH = 64;

/**
 * The default end-of-call turn (see "Sharing the event loop" in the module
 * notes): resolves in the check phase of the next event-loop iteration, after
 * the timers, the socket reads and the HTTP requests that were ready — the one
 * scheduling primitive Node guarantees to let pending I/O callbacks run first.
 *
 * `setImmediate` rather than `setTimeout(0)`, which Node clamps to 1 ms and
 * would cap a connection's ingest rate at a thousand batches a second for no
 * gain; and rather than `process.nextTick` or a resolved promise, which run
 * before I/O and so would yield nothing.
 *
 * @returns A promise that settles one macrotask later; it never rejects.
 */
export function yieldMacrotask(): Promise<void> {
  return nextMacrotask();
}

/* -------------------------------------------------------------------------------------------------
 * Consumer-side ports
 *
 * Narrow structural views of the collaborators, listing only what this module
 * calls. The real repositories, attributor, correlator and live tail satisfy
 * them as they stand; a suite can drive the pipeline with plain objects.
 * ---------------------------------------------------------------------------------------------- */

/** A value, or a promise of it: the repositories are synchronous, a double may not be. */
type MaybePromise<T> = T | PromiseLike<T>;

/**
 * One producer-loss report, as ingest hands it to the store's ledger: how many
 * events a producer said it discarded before delivery, accounted against the
 * session and capture its batch was **attributed** to (never a capture the
 * producer named). Identifiers and a count only.
 *
 * Declared structurally here so this module does not depend on the store's
 * own declaration; `TelemetryRepo.recordProducerLoss` accepts this shape.
 */
export interface ProducerLossReportLike {
  /** The session the reporting batch was attributed to. */
  readonly sessionId: SessionId;
  /** The capture window the reporting batch was attributed to. */
  readonly captureId: CaptureId;
  /** The producer id the transport announced, when it announced one. Diagnostic only. */
  readonly producerId?: ProducerId | undefined;
  /** Events the producer discarded since its previous loss report; a positive safe integer. */
  readonly droppedEvents: number;
}

/**
 * The telemetry store, as far as ingest needs it: one bulk write, and the
 * optional producer-loss ledger.
 *
 * `insertMany` takes **already-redacted, attributed** events without an
 * `ingestSeq`, writes them in one transaction (`ON CONFLICT(id)` replays of an
 * identical event are skipped, not refused) and returns the batch as the store
 * holds it — every offered event, each carrying its store-assigned `ingestSeq`.
 *
 * @see ../store/telemetry-repo.js — `TelemetryRepo`, the implementation.
 */
export interface TelemetryRepoLike {
  /**
   * Persists one batch.
   *
   * @param events The redacted, attributed events, in producer order.
   * @returns The stored rows with the insert and skip counts, or the refusal.
   */
  insertMany(
    events: readonly PersistableTelemetryEvent[],
  ): MaybePromise<Result<InsertTelemetryResult, DebuggenError>>;

  /**
   * Adds one producer-loss report to the capture's ledger, which the capture
   * summary reads when the window closes (pipeline step 2½).
   *
   * Optional: a store without a ledger still ingests every batch, and the
   * reported count still appears in {@link IngestReport.producerDropped}.
   * Called only with a positive count, only for an attributed batch, and at
   * most once per batch — and never again for a named report
   * (`lossReportId`) it has already answered `ok` for against the same
   * capture. `ok` carries the ledger's count for the capture after the report,
   * which ingest only logs, and is what marks a named report applied; an `Err`
   * is logged, leaves a named report free to be recorded by a retry, and never
   * fails the batch.
   *
   * @param report The attributed session and capture, and the count.
   * @returns The capture's recorded loss, or the refusal.
   */
  recordProducerLoss?(report: ProducerLossReportLike): MaybePromise<Result<number, DebuggenError>>;
}

/**
 * The sessions store, as far as ingest needs it: the per-session request-key
 * secret of AAP §0.5.2, kept only in the store.
 *
 * @see ../store/sessions-repo.js — `SessionsRepo.getOrCreateRequestKeySecret`,
 * the implementation over the `session_keys` table.
 */
export interface SessionsRepoLike {
  /**
   * Reads (minting on first use) one session's request-key secret.
   *
   * @param sessionId The session the batch was attributed to.
   * @returns The 64-character lowercase hex secret, or the refusal.
   */
  getOrCreateRequestKeySecret(sessionId: SessionId): MaybePromise<Result<string, DebuggenError>>;
}

/**
 * The attribution gate, as far as ingest needs it: the once-per-batch
 * resolution and the once-per-event stamp.
 *
 * @see ./attribute.js — `createIngestAttributor`, the implementation.
 */
export type IngestAttributorLike = Pick<IngestAttributor, 'resolveBatch' | 'attributeEvent'>;

/**
 * The trace correlator, as far as ingest needs it.
 *
 * @see ./correlate.js — `createTraceCorrelator`, the implementation.
 */
export type TraceCorrelatorLike = Pick<TraceCorrelator, 'onEventsPersisted'>;

/**
 * The live tail, as far as ingest needs it.
 *
 * @see ./live-tail.js — `createLiveTail`, the implementation.
 */
export type LiveTailLike = Pick<LiveTail, 'push'>;

/**
 * The two privacy primitives ingest runs, as an injectable pair.
 *
 * Production wiring never supplies this: the default is
 * {@link DEFAULT_INGEST_PRIVACY}, the real `@debuggen/telemetry` functions.
 * The seam exists so a suite can wrap the **real** functions in spies that
 * delegate — observing the call order without stubbing the privacy layer.
 * Whatever is supplied must be the upstream function or a transparent wrapper
 * of it; a substitute that does not redact defeats AAP §0.5.2.
 */
export interface IngestPrivacyPrimitives {
  /** Builds the batch's keyed-hash `request_key` hasher from the session secret. */
  readonly createRequestKeyHasher: typeof createRequestKeyHasher;
  /** Redacts one event before anything persists or broadcasts it. */
  readonly redactEvent: typeof redactEvent;
}

/** The privacy primitives of `@debuggen/telemetry`: what ingest runs unless a suite wraps them. */
export const DEFAULT_INGEST_PRIVACY: IngestPrivacyPrimitives = Object.freeze({
  createRequestKeyHasher,
  redactEvent,
});

/** What ingest tells a locator about one call. */
export interface IngestLocateOptions {
  /**
   * The batch's locate budget: aborted when
   * {@link TelemetryIngestDeps.locateBudgetMs} has elapsed. It asks for the
   * answer **as it stands** — a locator should stop starting new work and
   * answer `ok` with the locations found so far — not for a cancellation, and
   * an `Err` after it fired still counts as a locate failure. A locator that
   * ignores it is stopped waiting for {@link LOCATE_BUDGET_GRACE_MS} later.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * The source-location port of step 7½: `../source/resolve.ts` behind a
 * per-session adapter that `../main.ts` wires (the session's project root,
 * code index, modification journal and dev-server origin).
 *
 * Handed every redacted, attributed event of one batch at once, so the
 * resolver shares one source-map cache across them. An event may arrive with a
 * producer-stamped `patch` `source`; that is a **claim** for the resolver to
 * corroborate against the session's modification journal, never a location to
 * keep. A claim on any other route is removed before the port sees the event
 * (no producer records one, AAP §0.4.2), so the port computes that location
 * itself. The port answers the locations it vouches for, keyed by event id, and
 * leaves the rest out: whatever it leaves out is stored without a `source`, the
 * producer's claim removed.
 */
export interface IngestSourceLocator {
  /**
   * Places the events it can.
   *
   * @param events The batch's redacted, attributed events that carry no `source`.
   * @param attribution The session and capture the batch was attributed to.
   * @param options The batch's locate budget; see {@link IngestLocateOptions}.
   * @returns The locations found, keyed by event id, or the failure.
   */
  locate(
    events: readonly AttributedEvent[],
    attribution: IngestAttribution,
    options?: IngestLocateOptions,
  ): Promise<Result<ReadonlyMap<string, SourceLocation>, DebuggenError>>;
}

/** Everything {@link createTelemetryIngest} is given; all of it injected. */
export interface TelemetryIngestDeps {
  /** The telemetry store; `insertMany` is called, and `recordProducerLoss` when it exists. */
  readonly telemetry: TelemetryRepoLike;
  /** The sessions store; only `getOrCreateRequestKeySecret` is called. */
  readonly sessions: SessionsRepoLike;
  /** The attribution gate: which session and capture a batch belongs to. */
  readonly attributor: IngestAttributorLike;
  /**
   * The trace correlator. Optional so ingest degrades to "persist only" rather
   * than failing when the subsystem is absent.
   */
  readonly correlator?: TraceCorrelatorLike | undefined;
  /** The DevTools live tail. Optional for the same reason as {@link correlator}. */
  readonly liveTail?: LiveTailLike | undefined;
  /**
   * Places attributed events in the project's source before they are stored
   * (step 7½). Optional for the same reason as {@link correlator}: without it
   * events are stored without a `source` — a producer-stamped one is removed,
   * because nothing could verify it.
   */
  readonly sources?: IngestSourceLocator | undefined;
  /**
   * How long step 7½ may hold a batch, in milliseconds; defaults to
   * {@link DEFAULT_LOCATE_BUDGET_MS}. Only a positive finite value no larger
   * than {@link MAX_LOCATE_BUDGET_MS} is honoured; any other value is treated
   * as absent.
   */
  readonly locateBudgetMs?: number | undefined;
  /** The service logger; defaults to `noopLogger`. Bound to `subsystem: "telemetry.ingest"`. */
  readonly logger?: Logger | undefined;
  /**
   * The clock this module's own elapsed time and its log throttle's intervals
   * are read from; defaults to `nowEpochMs`.
   */
  readonly now?: (() => number) | undefined;
  /**
   * A lower batch ceiling. Only a positive integer at most
   * {@link MAX_INGEST_BATCH} is honoured — the option may lower the transport
   * bound, never raise it; any other value is treated as absent.
   */
  readonly maxBatch?: number | undefined;
  /** The privacy primitives; defaults to {@link DEFAULT_INGEST_PRIVACY}. See its notes. */
  readonly privacy?: IngestPrivacyPrimitives | undefined;
  /**
   * The turn every call yields before its promise settles; defaults to
   * {@link yieldMacrotask}. See "Sharing the event loop" in the module notes.
   * An override must resolve after at least one macrotask for the guarantee to
   * hold — a suite injects a recording one to observe where the turn falls. A
   * throw or rejection is contained: the batch's report is returned regardless.
   */
  readonly yieldTurn?: (() => Promise<unknown>) | undefined;
}

/**
 * Per-event and per-batch failures that did not fail the batch.
 *
 * Every count is of events except `correlation` and `tail`, which are `0` or
 * `1`: each of those steps runs once per batch.
 */
export interface IngestFailureCounts {
  /** Request events stored without a `request_key` because the digest could not be computed. */
  readonly requestKey: number;
  /**
   * Events that could not be made safe to store — the service-key strip or the
   * redactor failed on them — and were therefore **not** stored.
   */
  readonly redaction: number;
  /** Events the attributor could not decide on, and which were therefore not stored. */
  readonly attribution: number;
  /**
   * `1` when locating the batch's events failed; they were stored without a
   * location, producer-stamped claims included (counted in `sourcesRefused`).
   */
  readonly location: number;
  /** `1` when correlating the persisted rows failed; the rows stay persisted. */
  readonly correlation: number;
  /** `1` when the live tail refused or failed the persisted rows; the rows stay persisted. */
  readonly tail: number;
}

/**
 * What one ingest call did: counts, identifiers and trace ids only — never an
 * event's content, a digest or the session secret.
 */
export interface IngestReport {
  /** Elements the batch held. */
  readonly received: number;
  /** Elements that parsed as producer events. */
  readonly parsed: number;
  /** Elements that did not parse, skipped. */
  readonly invalid: number;
  /**
   * Events refused by attribution, per reason; every reason is present. A
   * batch-level drop counts the whole batch under its reason.
   */
  readonly dropped: Readonly<Record<DropReason, number>>;
  /** Rows the store returned for this batch: written plus idempotent replays. */
  readonly persisted: number;
  /** Rows actually written. */
  readonly inserted: number;
  /** Rows the store already held as the identical event, skipped without error. */
  readonly skipped: number;
  /** Request events that received a `request_key`. */
  readonly requestKeysComputed: number;
  /**
   * Events stored with a `source`: every one is the locator's answer (step 7½),
   * including a producer claim the locator confirmed.
   */
  readonly sourcesLocated: number;
  /**
   * Events step 7½ had not placed when the locate budget expired, and which
   * were therefore stored without a location; `0` when the locator answered
   * within its budget.
   */
  readonly sourcesUnplacedByBudget: number;
  /**
   * Events that arrived with a producer-stamped `source` and were stored with
   * none, because step 7½'s locator returned no location for them — the claim
   * refused on verification, or unverifiable because the locator is absent or
   * failed. A claim the locator replaced with its own answer counts in
   * {@link sourcesLocated} instead.
   */
  readonly sourcesRefused: number;
  /** Producer-supplied service-assigned attribute keys removed (a producer may never set them). */
  readonly serviceKeysStripped: number;
  /**
   * Events handed to the store carrying a producer-reported `clockOffsetMs`
   * (step 8), idempotent replays included. The offsets themselves are stored,
   * never applied; `0` when no event of the batch reported one.
   */
  readonly clockOffsetsReported: number;
  /** Failures that were counted rather than failing the batch. */
  readonly failures: IngestFailureCounts;
  /**
   * The trace ids the correlator marked stale for a rebuild on their next read,
   * in first-seen order; empty without a correlator.
   */
  readonly tracesTouched: readonly TraceId[];
  /** The session the batch was attributed to, once resolved. */
  readonly sessionId?: SessionId;
  /** The capture window the batch was attributed to, once resolved. */
  readonly captureId?: CaptureId;
  /** Why the whole batch was dropped, when attribution refused it. */
  readonly batchDropReason?: DropReason;
  /** The code of that refusal (for example `UNAUTHORIZED` for a project-scope mismatch). */
  readonly batchDropCode?: DebuggenErrorCode;
  /**
   * Events the producer reported discarding before this batch, accounted
   * against {@link captureId} (pipeline step 2½). Present only when the batch
   * was attributed and the count is above zero — whether or not the store has
   * a loss ledger to record it in — and absent when the batch repeats a named
   * loss report the ledger already recorded against that capture, which is
   * not new loss.
   */
  readonly producerDropped?: number;
}

/**
 * The browser-agent transport's input: the inspected tab the frame was
 * relayed for and the frame's `events`.
 *
 * `tabId` must come from the **authenticated DevTools connection** the frame
 * arrived on — never from the page. `documentId`, `producerId` and `url` are
 * diagnostic context from the agent's `agent.ready`, not authorization facts.
 * `armedCaptureId` and `droppedCount` are the payload's delivery context:
 * the first is refusal-only (a batch naming another capture than the open one
 * is dropped as `stale-capture`, see `./attribute.ts`), the second is the
 * producer's loss report (pipeline step 2½).
 */
export interface AgentIngestInput extends Omit<BrowserIngestContext, 'origin'> {
  /** The `events` of the `telemetry.event` payload, as received; validated here element by element. */
  readonly events: unknown;
  /**
   * The payload's `droppedCount`: events the page agent discarded since its
   * previous loss report. Absent means none were reported; a value that is not
   * a non-negative safe integer is ignored (and logged without its value).
   */
  readonly droppedCount?: number | undefined;
}

/**
 * The server-agent transport's input: the ingest body's `projectRoot`,
 * `events` and delivery context, and the credential's scope.
 *
 * `scopedProjectRoot` is the project the presented `server-agent` credential
 * is bound to, as resolved by `../server/auth.ts` — **never** a value read
 * from the request body. The two roots must agree for anything to be stored
 * at all; the attributor enforces it. `armedCaptureId` and
 * `droppedCount` are the body's delivery context, read exactly as the
 * browser transport's are: the first is refusal-only (a batch naming another
 * capture than the open one is dropped as `stale-capture`, see
 * `./attribute.ts`), the second is the producer's loss report (pipeline
 * step 2½). `lossReportId` is this transport's alone: the identity of that
 * loss report, so a body the exporter sends again is accounted once.
 */
export interface ServerAgentIngestInput extends Omit<ServerIngestContext, 'origin'> {
  /** The `events` of the `POST /telemetry/ingest` body, as received; validated here element by element. */
  readonly events: unknown;
  /**
   * The body's `droppedCount`: events the preload's exporter discarded since
   * its previous loss report. Absent means none were reported; a value that
   * is not a non-negative safe integer is ignored (and logged without its
   * value).
   */
  readonly droppedCount?: number | undefined;
  /**
   * The body's `lossReportId`: the producer-chosen identity of the body's loss
   * report, stable across every retry and resend of that report. One id names
   * one report — one count, for one capture — so a producer that reports
   * further loss names it with a new id.
   *
   * Used only to apply a report once (pipeline step 2½): a delivery whose
   * attributed capture and id the ledger already accepted is not counted
   * again. It never attributes a batch, chooses a session or a capture, or
   * authorizes anything, and it is never logged. Read only beside a
   * `droppedCount` above zero; a value that is not an identifier — a string of
   * 1 to 64 characters without surrounding whitespace, as
   * `telemetryIngestRequestSchema` requires — is ignored with a warning that
   * omits it, and the loss is recorded as if the body named no report.
   */
  readonly lossReportId?: string | undefined;
}

/** The ingest pipeline of one service process. No method throws and no promise rejects. */
export interface TelemetryIngest {
  /**
   * Runs one batch through the pipeline described in the module notes.
   *
   * @param context The batch's transport identity.
   * @param events The batch as received: expected to be an array of producer
   * events, validated here element by element.
   * @returns `ok(report)` — including for a batch attribution dropped whole —
   * or a typed `Err` for a non-array or over-size batch, an unavailable
   * request-key secret or a store failure.
   */
  ingest(context: IngestContext, events: unknown): Promise<Result<IngestReport, DebuggenError>>;

  /**
   * Ingests a `telemetry.event` frame relayed by the Chrome service worker.
   * The caller is `../server/routes/telemetry.ts`, for frames `../server/ws.ts`
   * hands it. Builds a `browser-agent` context (carrying `armedCaptureId` when
   * given), delegates to {@link ingest}'s pipeline and accounts `droppedCount`
   * against the attributed capture.
   *
   * @param input The tab identity and the frame's events.
   * @returns As {@link ingest}; a malformed `input` is a `PROTOCOL_INVALID_MESSAGE` `Err`.
   */
  ingestFromAgent(input: AgentIngestInput): Promise<Result<IngestReport, DebuggenError>>;

  /**
   * Ingests a `POST /telemetry/ingest` body from the dev-server preload. The
   * caller is `../server/routes/telemetry.ts`. Builds a `server-agent` context
   * carrying both project roots (and `armedCaptureId` when given), delegates
   * to {@link ingest}'s pipeline and accounts `droppedCount` against the
   * attributed capture — once per `lossReportId` when the body names its
   * report.
   *
   * @param input The body's project, events and delivery context, and the
   * credential's scope.
   * @returns As {@link ingest}; a malformed `input` is a `PROTOCOL_INVALID_MESSAGE` `Err`.
   */
  ingestFromServerAgent(
    input: ServerAgentIngestInput,
  ): Promise<Result<IngestReport, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Internals: errors, counters and the report
 * ---------------------------------------------------------------------------------------------- */

/** The failure counters while a batch runs. */
interface MutableFailureCounts {
  requestKey: number;
  redaction: number;
  attribution: number;
  location: number;
  correlation: number;
  tail: number;
}

/** Everything one run accumulates before it is frozen into an {@link IngestReport}. */
interface RunState {
  received: number;
  parsed: number;
  invalid: number;
  readonly dropped: Record<DropReason, number>;
  persisted: number;
  inserted: number;
  skipped: number;
  requestKeysComputed: number;
  sourcesLocated: number;
  sourcesUnplacedByBudget: number;
  sourcesRefused: number;
  serviceKeysStripped: number;
  clockOffsetsReported: number;
  readonly failures: MutableFailureCounts;
  tracesTouched: readonly TraceId[];
  sessionId?: SessionId;
  captureId?: CaptureId;
  batchDropReason?: DropReason;
  batchDropCode?: DebuggenErrorCode;
  producerDropped?: number;
}

/** What the request-key step made of one parsed event. */
type KeyStepOutcome =
  | {
      /** The event may continue to redaction. */
      readonly kind: 'ready';
      /** The event, with service-assigned keys stripped and the digest written when computed. */
      readonly event: TelemetryEventIngress;
      /** Whether a `request_key` was written. */
      readonly keyed: boolean;
      /** Whether a digest was attempted and could not be computed. */
      readonly keyFailed: boolean;
      /** How many producer-supplied service-assigned keys were removed. */
      readonly stripped: number;
    }
  | {
      /** The event's attributes could not be read safely; it must not be stored. */
      readonly kind: 'unsafe';
    };

/** What the digest lookup found for one event. */
type DigestOutcome =
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'digest'; readonly value: string }
  | { readonly kind: 'failed' };

/** A fresh counter per drop reason, every reason present at zero. */
function emptyDropCounts(): Record<DropReason, number> {
  const counts = {} as Record<DropReason, number>;

  for (const reason of DROP_REASONS) {
    counts[reason] = 0;
  }

  return counts;
}

/** A fresh run state for a batch of `received` elements. */
function newRunState(received: number): RunState {
  return {
    received,
    parsed: 0,
    invalid: 0,
    dropped: emptyDropCounts(),
    persisted: 0,
    inserted: 0,
    skipped: 0,
    requestKeysComputed: 0,
    serviceKeysStripped: 0,
    clockOffsetsReported: 0,
    failures: {
      requestKey: 0,
      redaction: 0,
      attribution: 0,
      location: 0,
      correlation: 0,
      tail: 0,
    },
    sourcesLocated: 0,
    sourcesUnplacedByBudget: 0,
    sourcesRefused: 0,
    tracesTouched: [],
  };
}

/** The sum of every drop count. */
function droppedTotal(dropped: Readonly<Record<DropReason, number>>): number {
  let total = 0;

  for (const reason of DROP_REASONS) {
    total += dropped[reason];
  }

  return total;
}

/** What the events handed to the store said about their producers' clocks. */
interface ClockOffsetTally {
  /** How many of the events carried a `clockOffsetMs`. */
  readonly reported: number;
  /** The largest `|clockOffsetMs|` among them; `undefined` when none carried one. */
  readonly maxAbsMs: number | undefined;
}

/**
 * Counts the producer-reported clock offsets of the events step 8 is about to
 * hand to the store. A read only: every offset stays exactly as its producer
 * stamped it and the ingress schema validated it.
 *
 * @param events The redacted, attributed, located events of the batch.
 * @returns The count and the largest magnitude.
 */
function tallyClockOffsets(events: readonly AttributedEvent[]): ClockOffsetTally {
  let reported = 0;
  let maxAbsMs: number | undefined;

  for (const event of events) {
    const offset = event.clockOffsetMs;

    if (offset === undefined) {
      continue;
    }

    reported += 1;
    const magnitude = Math.abs(offset);

    if (maxAbsMs === undefined || magnitude > maxAbsMs) {
      maxAbsMs = magnitude;
    }
  }

  return { reported, maxAbsMs };
}

/** Freezes a run state into the report returned to the caller. */
function toReport(state: RunState): IngestReport {
  const report: IngestReport = {
    received: state.received,
    parsed: state.parsed,
    invalid: state.invalid,
    dropped: Object.freeze({ ...state.dropped }),
    persisted: state.persisted,
    inserted: state.inserted,
    skipped: state.skipped,
    requestKeysComputed: state.requestKeysComputed,
    sourcesLocated: state.sourcesLocated,
    sourcesUnplacedByBudget: state.sourcesUnplacedByBudget,
    sourcesRefused: state.sourcesRefused,
    serviceKeysStripped: state.serviceKeysStripped,
    clockOffsetsReported: state.clockOffsetsReported,
    failures: Object.freeze({ ...state.failures }),
    tracesTouched: Object.freeze([...state.tracesTouched]),
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    ...(state.captureId === undefined ? {} : { captureId: state.captureId }),
    ...(state.batchDropReason === undefined ? {} : { batchDropReason: state.batchDropReason }),
    ...(state.batchDropCode === undefined ? {} : { batchDropCode: state.batchDropCode }),
    ...(state.producerDropped === undefined ? {} : { producerDropped: state.producerDropped }),
  };

  return Object.freeze(report);
}

/** What step 7½ made of one batch: the events to store and what happened to their locations. */
interface SourcePlacement {
  /** The batch in producer order, each event carrying only the location the locator answered. */
  readonly events: readonly AttributedEvent[];
  /** Events that received a location from the locator. */
  readonly located: number;
  /** Producer-stamped locations removed with nothing in their stead: the locator returned none. */
  readonly refused: number;
}

/**
 * `event` without its `source`: the shape stored for an unverified claim.
 *
 * @param event An attributed event carrying a producer-stamped `source`.
 * @returns A shallow copy with the `source` key absent (not set to `undefined`).
 */
function withoutSource(event: AttributedEvent): AttributedEvent {
  const copy: AttributedEvent = { ...event };
  Reflect.deleteProperty(copy, 'source');
  return copy;
}

/**
 * `event` as step 7½'s locator is handed it: a claim on a route no producer may
 * stamp ({@link PRODUCER_CLAIMABLE_ROUTES}) is removed first, so the locator
 * computes that location from the event's own evidence instead of vetting a
 * producer's assertion of it. A `patch` claim is kept for corroboration.
 *
 * @param event A redacted, attributed event, with or without a claim.
 * @returns `event` itself, or a copy without its unclaimable `source`.
 */
function asLocatorCandidate(event: AttributedEvent): AttributedEvent {
  const claim = event.source;
  return claim === undefined || PRODUCER_CLAIMABLE_ROUTES.has(claim.resolvedBy)
    ? event
    : withoutSource(event);
}

/**
 * Settles every event's `source` on the locator's answer alone.
 *
 * A producer-stamped `source` is a **claim**: the browser agent runs in the
 * page's main world, where any page script can stamp an event through the
 * public span helper or post a forged frame, and the dev-server preload is no
 * more authoritative about a location than the service's own resolver. So an
 * event keeps a location only when the locator returned one for its id — the
 * resolver's vetted, re-stamped answer, which for a `patch` claim means the
 * modification journal corroborated it — and any claim without such an answer
 * is removed. With no answer at all (`found` is `undefined`: no locator, or one
 * that failed) every claim is removed, because none could be verified.
 *
 * `events` are the batch as attribution left it, claims included, so a claim
 * {@link asLocatorCandidate} withheld from the locator is still counted when
 * the locator placed nothing in its stead.
 *
 * @param events The redacted, attributed batch, in producer order.
 * @param found The locator's locations keyed by event id, or `undefined` when there is no answer.
 * @returns The events to store with the located and refused counts.
 * @throws Only when `found` itself throws on read; the caller treats that as a locator failure.
 */
function placeSources(
  events: readonly AttributedEvent[],
  found: ReadonlyMap<string, SourceLocation> | undefined,
): SourcePlacement {
  let located = 0;
  let refused = 0;

  const placed = events.map((event) => {
    // Deliberately not `found?.get`: an `ok` answer that is not a map must
    // throw here, so the caller counts it as a failure instead of trusting it.
    const source = found === undefined ? undefined : found.get(event.id);

    if (source !== undefined) {
      located += 1;
      return { ...event, source };
    }

    if (event.source === undefined) {
      return event;
    }

    refused += 1;
    return withoutSource(event);
  });

  return { events: placed, located, refused };
}

/**
 * Whether `value` is a usable loss count: a non-negative safe integer, the
 * range the `droppedCount` of both transports admits
 * (`telemetryEventPayloadSchema`, `telemetryIngestRequestSchema`).
 */
function isLossCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Whether `value` is a usable loss-report id: a non-empty string of at most
 * {@link MAX_LOSS_REPORT_ID_LENGTH} characters with no leading or trailing
 * whitespace — the identifier rule `telemetryIngestRequestSchema` holds the
 * body's `lossReportId` to.
 */
function isLossReportId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_LOSS_REPORT_ID_LENGTH &&
    value.trim().length === value.length
  );
}

/**
 * The key a named loss report is applied under: its attributed capture and its
 * id. The capture id is length-prefixed, so no pair of values can spell
 * another pair's key whatever characters the id holds. Held in memory only,
 * never written.
 *
 * @param captureId The capture the reporting batch was attributed to.
 * @param lossReportId The report's validated id.
 */
function lossReportKey(captureId: CaptureId, lossReportId: string): string {
  return `${String(captureId.length)}:${captureId}:${lossReportId}`;
}

/**
 * The refusal for a batch whose shape is wrong before any element is read.
 *
 * @param problem Which structural problem was found — a fixed label, never a value.
 */
function invalidBatchError(
  problem: 'not-an-array' | 'unreadable-batch' | 'unreadable-input',
): DebuggenError {
  return new DebuggenError(
    'PROTOCOL_INVALID_MESSAGE',
    'A telemetry batch must be an array of producer events.',
    {
      hint: 'Send the events of a telemetry.event payload or of a POST /telemetry/ingest body as an array; each element is validated individually.',
      details: { problem },
    },
  );
}

/** The refusal for a batch longer than the ceiling; counts only. */
function oversizeBatchError(received: number, maxBatch: number): DebuggenError {
  return new DebuggenError(
    'PROTOCOL_INVALID_MESSAGE',
    `A telemetry batch may carry at most ${String(maxBatch)} events.`,
    {
      hint: 'Split the batch: producers flush far smaller batches, so a longer one is refused whole rather than truncated.',
      details: { problem: 'batch-too-large', received, maxBatch },
    },
  );
}

/**
 * The error reported when a dependency threw or answered with something that
 * is not a `DebuggenError`. Carries the operation name only: the caught value
 * may hold captured data, so it is neither echoed nor attached as a cause.
 */
function dependencyError(operation: string, code: DebuggenErrorCode): DebuggenError {
  return new DebuggenError(code, `Telemetry ingest could not complete ${operation}.`, {
    hint: 'The batch was not stored. The service log records the failing operation; the producer may resend the batch.',
    details: { operation },
  });
}

/** `value` when it is a `DebuggenError`, otherwise {@link dependencyError}. */
function asDebuggenError(
  value: unknown,
  operation: string,
  code: DebuggenErrorCode,
): DebuggenError {
  return DebuggenError.is(value) ? value : dependencyError(operation, code);
}

/**
 * The issue codes and top-level schema fields of a validation failure.
 *
 * Read from the upstream parse helper's `details.issues`, which already holds
 * structure only; the field is further restricted to the ingress schema's own
 * top-level names, so no page-supplied attribute key can reach a log record.
 */
function issueLabels(error: unknown): { readonly codes: string[]; readonly fields: string[] } {
  const codes: string[] = [];
  const fields: string[] = [];
  const issues = readProperty(readProperty(error, 'details'), 'issues');

  if (!Array.isArray(issues)) {
    return { codes, fields };
  }

  for (const issue of issues as readonly unknown[]) {
    const code = readProperty(issue, 'code');
    const path = readProperty(issue, 'path');

    if (typeof code === 'string' && code.length > 0) {
      codes.push(code);
    }

    if (typeof path === 'string') {
      const field = path.split('.')[0] ?? '';

      if (INGRESS_FIELD_NAMES.has(field)) {
        fields.push(field);
      }
    }
  }

  return { codes, fields };
}

/** Adds each label to a bounded, de-duplicated set. */
function collectLabels(target: Set<string>, labels: readonly string[]): void {
  for (const label of labels) {
    if (target.size >= MAX_LOGGED_ISSUE_LABELS) {
      return;
    }

    target.add(label);
  }
}

/**
 * The batch ceiling in force: the configured one when it lowers the transport
 * bound, otherwise the transport bound itself.
 */
function effectiveMaxBatch(option: number | undefined): number {
  return option !== undefined &&
    Number.isSafeInteger(option) &&
    option > 0 &&
    option <= MAX_INGEST_BATCH
    ? option
    : MAX_INGEST_BATCH;
}

/**
 * The locate budget in force: the configured one when it is a positive finite
 * number no larger than {@link MAX_LOCATE_BUDGET_MS}, otherwise
 * {@link DEFAULT_LOCATE_BUDGET_MS}.
 */
function effectiveLocateBudget(option: number | undefined): number {
  return option !== undefined &&
    Number.isFinite(option) &&
    option > 0 &&
    option <= MAX_LOCATE_BUDGET_MS
    ? option
    : DEFAULT_LOCATE_BUDGET_MS;
}

/** How a locator's call ended, as {@link locateWithinBudget} observed it. */
type LocateAnswer =
  | {
      /** The locator answered, within its budget or after it fired. */
      readonly kind: 'answered';
      readonly result: Result<ReadonlyMap<string, SourceLocation>, DebuggenError>;
      /** Whether the budget had fired by the time it answered. */
      readonly budgetExpired: boolean;
    }
  | {
      /** The locator threw or rejected. */
      readonly kind: 'threw';
    }
  | {
      /** The locator had not answered by the budget plus its grace; ingest stopped waiting. */
      readonly kind: 'overran';
    };

/**
 * Calls a locator under a budget.
 *
 * An `AbortController` fires at `budgetMs` and is handed to the locator as its
 * {@link IngestLocateOptions.signal}; a second timer, {@link LOCATE_BUDGET_GRACE_MS}
 * later, ends the wait for a locator that ignored it. Both timers are `unref`'d,
 * so neither keeps the process alive, and both are cleared however the call
 * ends. A locator promise still pending when the wait ends is left to settle on
 * its own: its outcome is observed (so a late rejection is never unhandled) and
 * discarded.
 *
 * @param locator The injected locator.
 * @param events The events to place.
 * @param attribution The batch's attribution.
 * @param budgetMs The budget in force.
 * @returns How the call ended; never rejects.
 */
async function locateWithinBudget(
  locator: IngestSourceLocator,
  events: readonly AttributedEvent[],
  attribution: IngestAttribution,
  budgetMs: number,
): Promise<LocateAnswer> {
  const budget = new AbortController();
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const overran = new Promise<LocateAnswer>((resolve) => {
    budgetTimer = setTimeout(() => {
      budget.abort();
    }, budgetMs);
    graceTimer = setTimeout(() => {
      resolve({ kind: 'overran' });
    }, budgetMs + LOCATE_BUDGET_GRACE_MS);
    budgetTimer.unref();
    graceTimer.unref();
  });

  const answered = Promise.resolve()
    .then(() => locator.locate(events, attribution, { signal: budget.signal }))
    .then(
      (result): LocateAnswer => ({
        kind: 'answered',
        result,
        budgetExpired: budget.signal.aborted,
      }),
      (): LocateAnswer => ({ kind: 'threw' }),
    );

  try {
    return await Promise.race([answered, overran]);
  } finally {
    clearTimeout(budgetTimer);
    clearTimeout(graceTimer);
  }
}

/**
 * Removes producer-supplied service-assigned keys from an attribute bag.
 *
 * A producer can neither compute a `request_key` (it does not hold the session
 * secret) nor be trusted with one: a page that could set it could choose which
 * of its requests are reported as duplicates of each other. So whatever
 * arrives under a service-assigned key is discarded, on every kind, before the
 * service writes its own.
 *
 * @returns The bag unchanged (same reference) when nothing was removed.
 */
function stripServiceAssignedKeys(attributes: TelemetryEventIngress['attributes']): {
  readonly attributes: TelemetryEventIngress['attributes'];
  readonly stripped: number;
} {
  let stripped = 0;

  for (const key of Object.keys(attributes)) {
    if (SERVICE_ASSIGNED_KEYS.has(key)) {
      stripped += 1;
    }
  }

  if (stripped === 0) {
    return { attributes, stripped };
  }

  const kept: TelemetryEventIngress['attributes'] = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (!SERVICE_ASSIGNED_KEYS.has(key)) {
      kept[key] = value;
    }
  }

  return { attributes: kept, stripped };
}

/**
 * Computes one event's `request_key` from its **unredacted** method and URL.
 *
 * Only a request kind (`REQUEST_KINDS`) carrying a non-blank method and a
 * non-empty URL is keyed; every other event is `not-applicable` and the hasher
 * is not called for it.
 */
async function digestFor(
  kind: TelemetryEventIngress['kind'],
  attributes: TelemetryEventIngress['attributes'],
  hasher: RequestKeyHasher,
): Promise<DigestOutcome> {
  if (INGEST_REQUEST_KEY_ATTRIBUTE === undefined || !REQUEST_KIND_SET.has(kind)) {
    return { kind: 'not-applicable' };
  }

  const method = attributes[METHOD_ATTRIBUTE];
  const url = attributes[URL_ATTRIBUTE];

  if (
    typeof method !== 'string' ||
    method.trim().length === 0 ||
    typeof url !== 'string' ||
    url.length === 0
  ) {
    return { kind: 'not-applicable' };
  }

  try {
    const digest = await hasher.compute(method, url);

    return digest.ok && typeof digest.value === 'string'
      ? { kind: 'digest', value: digest.value }
      : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * Step 5 for one event: strip producer-supplied service keys, then write the
 * `request_key` digest.
 *
 * WHY THIS PRECEDES REDACTION: redaction replaces every query-parameter value
 * with `?`, so `productId=A` and `productId=B` are both stored and displayed as
 * `productId=?`. The digest must still tell them apart — two requests that
 * differ only in a parameter are distinct requests — while two byte-identical
 * requests must collide, which is what duplicate detection counts. Only the
 * unredacted URL carries that difference; a digest taken after masking would
 * hash `productId=?` for every request and merge them all into one false
 * "duplicate" group. The digest itself is exempt from redaction because its
 * key is service-assigned.
 */
async function assignRequestKey(
  event: TelemetryEventIngress,
  hasher: RequestKeyHasher,
): Promise<KeyStepOutcome> {
  let attributes: TelemetryEventIngress['attributes'];
  let stripped: number;

  try {
    const cleaned = stripServiceAssignedKeys(event.attributes);
    attributes = cleaned.attributes;
    stripped = cleaned.stripped;
  } catch {
    return { kind: 'unsafe' };
  }

  const digest = await digestFor(event.kind, attributes, hasher);

  if (digest.kind === 'digest' && INGEST_REQUEST_KEY_ATTRIBUTE !== undefined) {
    return {
      kind: 'ready',
      event: {
        ...event,
        attributes: { ...attributes, [INGEST_REQUEST_KEY_ATTRIBUTE]: digest.value },
      },
      keyed: true,
      keyFailed: false,
      stripped,
    };
  }

  return {
    kind: 'ready',
    event: stripped === 0 ? event : { ...event, attributes },
    keyed: false,
    keyFailed: digest.kind === 'failed',
    stripped,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The log throttle
 *
 * A batch or frame is cheap to send and a warning is not cheap to write: a
 * page script can post malformed telemetry as fast as the bridge relays it,
 * and one unconditional record per batch would turn that into unbounded log
 * growth (CWE-400). Every warning and error this module writes — and those of
 * `../server/routes/telemetry.ts`, which imports this throttle — is admitted
 * by a {@link LogThrottle} first, which coalesces repeats into a count.
 * ---------------------------------------------------------------------------------------------- */

/**
 * How long, by default, a {@link createLogThrottle} key waits between two
 * written records, in milliseconds — the live tail's own reporting cadence.
 */
export const LOG_THROTTLE_INTERVAL_MS = 10_000;

/**
 * How many records, by default, a {@link createLogThrottle} writes per
 * interval across all of its keys together, so that many distinct keys cannot
 * defeat the per-key bound.
 */
export const LOG_THROTTLE_MAX_RECORDS_PER_INTERVAL = 32;

/** How many keys, by default, a {@link createLogThrottle} tracks at once. */
export const LOG_THROTTLE_MAX_KEYS = 256;

/**
 * How many consecutive trailing-summary wake-ups a {@link createLogThrottle}
 * makes that find nothing due before it stops waking until the next hold-back
 * — so a clock that does not advance cannot keep a timer cycling forever.
 */
const LOG_THROTTLE_MAX_IDLE_WAKEUPS = 3;

/**
 * Schedules one trailing-summary wake-up of a {@link createLogThrottle}. The
 * default is an `unref`'d `setTimeout`, so a pending summary never keeps the
 * process alive.
 */
export type LogThrottleScheduler = (callback: () => void, delayMs: number) => void;

/**
 * Held-back occurrences of one key that no later record carried, handed to
 * {@link LogThrottleOptions.onSummary} once the key's interval has passed.
 *
 * @typeParam P What the caller handed {@link LogThrottle.admit} with the
 * key's latest held-back occurrence.
 */
export interface LogThrottleSummary<P> {
  /** The payload of the key's latest held-back occurrence. */
  readonly payload: P;
  /** How many occurrences of the key were held back and never written. */
  readonly suppressed: number;
  /** As {@link LogThrottleVerdict.suppressedUntracked}. */
  readonly suppressedUntracked: number;
}

/** The default {@link LogThrottleScheduler}: an unref'd `setTimeout`. */
function unrefTimeout(callback: () => void, delayMs: number): void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
}

/**
 * What {@link createLogThrottle} is built from; every option has a default.
 *
 * @typeParam P The payload a caller hands {@link LogThrottle.admit} for its
 * trailing summaries; `undefined` when it writes none.
 */
export interface LogThrottleOptions<P = undefined> {
  /**
   * Writes a trailing summary: called for a key whose held-back occurrences
   * no later record carried, once its interval has passed, subject to the same
   * ceiling across keys as written records. Without it nothing is scheduled
   * and a count waits for the key's next written record. It must not throw; a
   * throw is ignored.
   */
  readonly onSummary?: ((summary: LogThrottleSummary<P>) => void) | undefined;
  /** Schedules the trailing-summary wake-ups; defaults to an unref'd `setTimeout`. */
  readonly scheduler?: LogThrottleScheduler | undefined;
  /**
   * The least time between two written records of one key, in milliseconds;
   * defaults to {@link LOG_THROTTLE_INTERVAL_MS}. A value that is not a
   * positive finite number keeps the default.
   */
  readonly intervalMs?: number | undefined;
  /**
   * The most records written per interval across every key; defaults to
   * {@link LOG_THROTTLE_MAX_RECORDS_PER_INTERVAL}. A value that is not a
   * positive safe integer keeps the default.
   */
  readonly maxRecordsPerInterval?: number | undefined;
  /**
   * The most keys tracked; defaults to {@link LOG_THROTTLE_MAX_KEYS}. The least
   * recently admitted key is forgotten first. A value that is not a positive
   * safe integer keeps the default.
   */
  readonly maxKeys?: number | undefined;
  /**
   * The clock intervals are measured on, in epoch milliseconds; defaults to
   * `nowEpochMs`. A reading that throws or is not finite is replaced by the
   * last good one, and a reading earlier than a key's last record (the clock
   * stepped back) ends that key's interval rather than extending it.
   */
  readonly now?: (() => number) | undefined;
}

/** The answer of {@link LogThrottle.admit} for one occurrence. */
export interface LogThrottleVerdict {
  /** Whether the caller should write its record now. */
  readonly write: boolean;
  /**
   * When `write` is true: how many occurrences of this key were held back
   * since its previous written record. Always `0` when `write` is false.
   */
  readonly suppressed: number;
  /**
   * When `write` is true: how many held-back occurrences belonged to keys the
   * throttle stopped tracking (evicted by `maxKeys`) before they could be
   * reported, reported once on the next written record of any key. Always
   * `0` when `write` is false.
   */
  readonly suppressedUntracked: number;
}

/**
 * A coalescing rate limit for log records, keyed by what the record is about.
 *
 * @typeParam P The payload kept for a trailing summary (see {@link LogThrottleOptions.onSummary}).
 */
export interface LogThrottle<P = undefined> {
  /**
   * Admits one occurrence of `key`.
   *
   * A key is written at most once per interval; occurrences in between are
   * counted and carried by the key's next written record — or, when the
   * throttle writes trailing summaries and no such record comes, by a summary
   * once the interval has passed. Across all keys at most
   * `maxRecordsPerInterval` records and summaries are written per interval; a
   * key the global ceiling holds back keeps its count and is written once the
   * ceiling allows. Keys are the caller's bookkeeping and are never written
   * anywhere.
   *
   * @param key What the record is about — a message class and its scope.
   * @param payload What a trailing summary of this occurrence would write; the
   * latest held-back occurrence's payload is the one kept, and an absent
   * (`undefined`) payload keeps the previous one.
   * @returns Whether to write, and the counts the written record must carry.
   * Never throws.
   */
  admit(key: string, payload?: P): LogThrottleVerdict;
}

/** The verdict for an occurrence that is held back. */
const HELD_BACK: LogThrottleVerdict = Object.freeze({
  write: false,
  suppressed: 0,
  suppressedUntracked: 0,
});

/**
 * Creates a {@link LogThrottle}.
 *
 * Its state is bounded: at most `maxKeys` keys, each a timestamp, a count and
 * the latest held-back payload, plus one window counter, one count of evicted
 * occurrences and at most one pending wake-up.
 *
 * Without `onSummary` nothing is scheduled: a count is carried by the key's
 * next written record, so a key that never recurs keeps its count until it is
 * evicted, when the count moves to `suppressedUntracked` of the next record of
 * any key. With `onSummary`, the first hold-back schedules a wake-up one
 * interval on — by then the key, and the window, are due — which hands every
 * due key's count to `onSummary` (within the ceiling across keys) and wakes
 * again while counts are left. A flood that stops is therefore still reported,
 * one interval after it began being held back.
 *
 * @param options The interval, the global ceiling, the key bound, the clock
 * and the trailing summaries.
 * @returns The throttle. Neither creating it nor admitting to it throws.
 *
 * @example
 * ```ts
 * const throttle = createLogThrottle({ now: clock });
 * const verdict = throttle.admit(`malformed\u0000${sessionId}`);
 * if (verdict.write) {
 *   logger.warn('malformed telemetry events skipped', {
 *     invalid,
 *     ...suppressionFields(verdict),
 *   });
 * }
 * ```
 */
export function createLogThrottle<P = undefined>(
  options: LogThrottleOptions<P> = {},
): LogThrottle<P> {
  const intervalMs =
    typeof options.intervalMs === 'number' &&
    Number.isFinite(options.intervalMs) &&
    options.intervalMs > 0
      ? options.intervalMs
      : LOG_THROTTLE_INTERVAL_MS;
  const maxRecords = positiveSafeIntegerOr(
    options.maxRecordsPerInterval,
    LOG_THROTTLE_MAX_RECORDS_PER_INTERVAL,
  );
  const maxKeys = positiveSafeIntegerOr(options.maxKeys, LOG_THROTTLE_MAX_KEYS);
  const clock = options.now ?? nowEpochMs;
  const onSummary = options.onSummary;
  const scheduler = options.scheduler ?? unrefTimeout;

  /**
   * One key: when its last record was written, what was held back since, and
   * the payload of the latest held-back occurrence (for its trailing summary).
   */
  interface KeyState {
    writtenAt: number | undefined;
    pending: number;
    payload: { readonly value: P } | undefined;
  }

  /** Insertion-ordered, so the first entry is the least recently admitted key. */
  const keys = new Map<string, KeyState>();
  let windowStartedAt: number | undefined;
  let writtenInWindow = 0;
  let untracked = 0;
  let lastReading = 0;
  /** Whether a trailing-summary wake-up is pending. */
  let wakeupPending = false;
  /** Consecutive wake-ups that found nothing due; see {@link LOG_THROTTLE_MAX_IDLE_WAKEUPS}. */
  let idleWakeups = 0;

  function readClock(): number {
    try {
      const reading = clock();
      if (Number.isFinite(reading)) {
        lastReading = reading;
      }
    } catch {
      // Fall through to the last good reading.
    }
    return lastReading;
  }

  /** Whether an interval that began at `since` is over at `at`, or the clock stepped back. */
  function intervalOver(since: number, at: number): boolean {
    return at < since || at - since >= intervalMs;
  }

  /** The key's state, created on first use and moved to most recently admitted. */
  function stateOf(key: string): KeyState {
    const held = keys.get(key);
    if (held !== undefined) {
      keys.delete(key);
      keys.set(key, held);
      return held;
    }

    const fresh: KeyState = { writtenAt: undefined, pending: 0, payload: undefined };
    keys.set(key, fresh);

    while (keys.size > maxKeys) {
      const oldest = keys.entries().next();
      if (oldest.done === true) {
        break;
      }
      const [oldestKey, oldestState] = oldest.value;
      keys.delete(oldestKey);
      untracked += oldestState.pending;
    }

    return fresh;
  }

  /** Opens a fresh ceiling window when the current one is over at `at`. */
  function rollWindow(at: number): void {
    if (windowStartedAt === undefined || intervalOver(windowStartedAt, at)) {
      windowStartedAt = at;
      writtenInWindow = 0;
    }
  }

  /**
   * Counts one held-back occurrence, keeps its payload (an absent one keeps
   * the previous) and schedules its summary.
   */
  function holdBack(state: KeyState, payload: P | undefined): void {
    state.pending += 1;
    if (payload !== undefined) {
      state.payload = { value: payload };
    }
    idleWakeups = 0;
    scheduleWakeup();
  }

  /**
   * Schedules one wake-up an interval on, when summaries are written and none
   * is pending. By then every key held back so far is due and the window has
   * rolled, so the wake-up can write them.
   */
  function scheduleWakeup(): void {
    if (onSummary === undefined || wakeupPending) {
      return;
    }
    wakeupPending = true;
    try {
      scheduler(wakeup, intervalMs);
    } catch {
      // No timer: the counts wait for the keys' next written records instead.
      wakeupPending = false;
    }
  }

  /**
   * Writes the trailing summary of every due key with a count and a payload,
   * oldest first, within the ceiling across keys; wakes again while counts are
   * left, and stops after {@link LOG_THROTTLE_MAX_IDLE_WAKEUPS} wake-ups in a
   * row that could write nothing.
   */
  function wakeup(): void {
    wakeupPending = false;
    if (onSummary === undefined) {
      return;
    }
    try {
      const at = readClock();
      rollWindow(at);
      let written = 0;
      let left = false;
      for (const state of keys.values()) {
        const held = state.payload;
        if (state.pending === 0 || held === undefined) {
          continue;
        }
        if (
          (state.writtenAt !== undefined && !intervalOver(state.writtenAt, at)) ||
          writtenInWindow >= maxRecords
        ) {
          left = true;
          continue;
        }
        writtenInWindow += 1;
        written += 1;
        const summary: LogThrottleSummary<P> = Object.freeze({
          payload: held.value,
          suppressed: state.pending,
          suppressedUntracked: untracked,
        });
        state.pending = 0;
        state.payload = undefined;
        state.writtenAt = at;
        untracked = 0;
        try {
          onSummary(summary);
        } catch {
          // Advisory only: the count is spent whether or not the sink took it.
        }
      }
      idleWakeups = written > 0 ? 0 : idleWakeups + 1;
      if (left && idleWakeups < LOG_THROTTLE_MAX_IDLE_WAKEUPS) {
        scheduleWakeup();
      }
    } catch {
      // Unreachable; a fault here ends the wake-ups rather than repeating it.
    }
  }

  function admit(key: string, payload?: P): LogThrottleVerdict {
    try {
      const at = readClock();
      const state = stateOf(key);

      if (state.writtenAt !== undefined && !intervalOver(state.writtenAt, at)) {
        holdBack(state, payload);
        return HELD_BACK;
      }

      rollWindow(at);

      if (writtenInWindow >= maxRecords) {
        holdBack(state, payload);
        return HELD_BACK;
      }

      writtenInWindow += 1;
      const verdict: LogThrottleVerdict = Object.freeze({
        write: true,
        suppressed: state.pending,
        suppressedUntracked: untracked,
      });
      state.pending = 0;
      state.payload = undefined;
      state.writtenAt = at;
      untracked = 0;
      return verdict;
    } catch {
      // Unreachable with a string key; a fault here holds the record back
      // rather than letting the throttle itself become the flood.
      return HELD_BACK;
    }
  }

  return Object.freeze({ admit });
}

/**
 * The fields a written record adds for a verdict: `suppressed` and
 * `suppressedUntracked`, each only when non-zero, so a record that coalesced
 * nothing is unchanged.
 *
 * @param verdict The verdict {@link LogThrottle.admit} answered with `write: true`.
 * @returns The counts to spread into the record's fields.
 */
export function suppressionFields(verdict: LogThrottleVerdict): LogFields {
  return {
    ...(verdict.suppressed > 0 ? { suppressed: verdict.suppressed } : {}),
    ...(verdict.suppressedUntracked > 0
      ? { suppressedUntracked: verdict.suppressedUntracked }
      : {}),
  };
}

/**
 * The fields a trailing summary adds to the record it re-writes: `suppressed`
 * — every occurrence it reports, none of which was written — `trailingSummary`,
 * which marks the record as a report of held-back occurrences rather than a new
 * one, and `suppressedUntracked` when non-zero. The rest of the record's fields
 * are those of the latest held-back occurrence.
 *
 * @param summary A summary {@link LogThrottleOptions.onSummary} was handed.
 * @returns The counts to spread into the re-written record's fields.
 */
export function summaryFields(summary: LogThrottleSummary<unknown>): LogFields {
  return {
    suppressed: summary.suppressed,
    trailingSummary: true,
    ...(summary.suppressedUntracked > 0
      ? { suppressedUntracked: summary.suppressedUntracked }
      : {}),
  };
}

/** `value` when it is a positive safe integer, otherwise `fallback`. */
function positiveSafeIntegerOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * The classes of warning and error this module writes, each a throttle key
 * prefix. A key adds the record's scope (and its error code where it carries
 * one), so a flood of one class in one scope cannot hide another.
 */
const WARNING_CLASS = Object.freeze({
  batchRefused: 'batch-refused',
  attributionFailed: 'attribution-failed',
  secretUnavailable: 'secret-unavailable',
  malformedEvents: 'malformed-events',
  serviceKeysStripped: 'service-keys-stripped',
  malformedLossReportId: 'malformed-loss-report-id',
  eventsDegraded: 'events-degraded',
  locateBudget: 'locate-budget',
  locateFailed: 'locate-failed',
  correlationFailed: 'correlation-failed',
  tailRefused: 'tail-refused',
  persistFailed: 'persist-failed',
  unexpected: 'unexpected',
});

/**
 * The classes of debug record the debug throttle admits: those of a batch
 * that stored nothing, and that of a loss report already applied — each of
 * which a producer can repeat as often as it sends.
 */
const DEBUG_CLASS = Object.freeze({
  emptyBatch: 'empty-batch',
  droppedBatch: 'dropped-batch',
  storedNothing: 'stored-nothing',
  lossReportRepeated: 'loss-report-repeated',
});

/** How much of a project digest a throttle key keeps: 64 bits, ample to tell a machine's projects apart. */
const SCOPE_DIGEST_CHARS = 16;

/** One throttle key from its parts; the separator cannot occur in an id or a code. */
function throttleKey(...parts: readonly string[]): string {
  return parts.join('\u0000');
}

/**
 * The producer scope of a record: the origin and the relayed tab for a page
 * agent; the origin and a digest of the credential's project (the transport's
 * scope, never the body's claim) for a server agent. So one producer's flood
 * is summarised under its own keys and never holds back another producer's
 * records. Never a project path, and never written: it only keys the throttle.
 */
function unattributedScope(context: unknown, origin: IngestOrigin | undefined): string {
  try {
    if (origin === 'server-agent') {
      const scoped = readProperty(context, 'scopedProjectRoot');
      return typeof scoped === 'string'
        ? `${origin}:${sha256Hex(scoped).slice(0, SCOPE_DIGEST_CHARS)}`
        : origin;
    }
    if (origin !== 'browser-agent') {
      return origin ?? 'unknown-origin';
    }
    const tabId = readProperty(context, 'tabId');
    return typeof tabId === 'number' && Number.isSafeInteger(tabId)
      ? `${origin}:${String(tabId)}`
      : origin;
  } catch {
    return origin ?? 'unknown-origin';
  }
}

/** The scope of a record written once the batch is attributed: its session. */
function sessionScope(sessionId: SessionId): string {
  return `session:${sessionId}`;
}

/* -------------------------------------------------------------------------------------------------
 * The pipeline
 * ---------------------------------------------------------------------------------------------- */

/** The logging levels this module writes at. */
type IngestLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The origin a context names, when it names a known one; never throws. */
function originOf(context: unknown): IngestOrigin | undefined {
  try {
    const origin = readProperty(context, 'origin');

    return typeof origin === 'string' && Object.hasOwn(INGEST_ORIGIN_CLIENT_KIND, origin)
      ? (origin as IngestOrigin)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates the ingest pipeline of one service process.
 *
 * @param deps The collaborators, all injected; see {@link TelemetryIngestDeps}.
 * @returns The pipeline and its two transport wrappers.
 */
export function createTelemetryIngest(deps: TelemetryIngestDeps): TelemetryIngest {
  const privacy = deps.privacy ?? DEFAULT_INGEST_PRIVACY;
  const clock = deps.now ?? nowEpochMs;
  const maxBatch = effectiveMaxBatch(deps.maxBatch);
  const locateBudgetMs = effectiveLocateBudget(deps.locateBudgetMs);
  // Logging is advisory: the pipeline's decisions stand without it. The root is
  // guarded before any child is derived, so neither `child()` nor any level
  // method of it or of a logger derived from it can throw — a failed write is
  // dropped and counted by the shared best-effort policy of `../logging.ts`.
  const root = guardLogger(deps.logger ?? noopLogger);
  const log = subsystemLogger(root, INGEST_SUBSYSTEM);
  const yieldTurn = deps.yieldTurn ?? yieldMacrotask;

  /** Writes one record through a logger derived from the guarded root; it never throws. */
  function emit(target: Logger, level: IngestLogLevel, message: string, fields: LogFields): void {
    target[level](message, fields);
  }

  /** A record a throttle may hold back, kept whole so its trailing summary can re-write it. */
  interface HeldRecord {
    readonly target: Logger;
    readonly level: IngestLogLevel;
    readonly message: string;
    readonly fields: LogFields;
  }

  /** Re-writes a held-back record as its trailing summary. */
  const writeSummary = (summary: LogThrottleSummary<HeldRecord>): void => {
    const { target, level, message, fields } = summary.payload;
    emit(target, level, message, { ...fields, ...summaryFields(summary) });
  };

  /** Admits every warning and error of this pipeline; see "The log throttle". */
  const throttle = createLogThrottle<HeldRecord>({ now: clock, onSummary: writeSummary });

  /**
   * Admits the debug records of batches that stored nothing — ignored, dropped
   * whole, or entirely malformed — which a producer can repeat as often as it
   * sends. A separate throttle, so they never take a warning's place under the
   * ceiling. The debug record of a batch that stored evidence is not throttled:
   * it is bounded by the evidence itself.
   */
  const debugThrottle = createLogThrottle<HeldRecord>({ now: clock, onSummary: writeSummary });

  /**
   * Writes a record through `through`: at most one per `key` per interval,
   * carrying how many occurrences were held back since the previous one, and a
   * trailing summary of the held-back ones when no later record carries them.
   */
  function emitThrough(
    through: LogThrottle<HeldRecord>,
    target: Logger,
    level: IngestLogLevel,
    key: string,
    message: string,
    fields: LogFields,
  ): void {
    const verdict = through.admit(key, { target, level, message, fields });

    if (verdict.write) {
      emit(target, level, message, { ...fields, ...suppressionFields(verdict) });
    }
  }

  /** Writes a warning or an error through the warning throttle. */
  function emitThrottled(
    target: Logger,
    level: 'warn' | 'error',
    key: string,
    message: string,
    fields: LogFields,
  ): void {
    emitThrough(throttle, target, level, key, message, fields);
  }

  /** Writes the debug record of a batch that stored nothing through the debug throttle. */
  function emitDebugThrottled(
    target: Logger,
    key: string,
    message: string,
    fields: LogFields,
  ): void {
    emitThrough(debugThrottle, target, 'debug', key, message, fields);
  }

  /** The throttle scope of a run: its session once attributed. */
  function runScope(state: RunState): string {
    return state.sessionId === undefined ? 'unattributed' : sessionScope(state.sessionId);
  }

  /** The clock's reading, or `undefined` when it throws or is not finite. */
  function readClock(): number | undefined {
    try {
      const value = clock();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Step 1: the batch must be an array no longer than the ceiling. Reads the
   * length once; elements are read one at a time in step 4.
   */
  function boundBatch(
    events: unknown,
  ): Result<{ readonly source: readonly unknown[]; readonly received: number }, DebuggenError> {
    try {
      if (!Array.isArray(events)) {
        return err(invalidBatchError('not-an-array'));
      }

      const source: readonly unknown[] = events;
      const received = source.length;

      if (!Number.isSafeInteger(received) || received < 0) {
        return err(invalidBatchError('unreadable-batch'));
      }

      return received > maxBatch
        ? err(oversizeBatchError(received, maxBatch))
        : ok({ source, received });
    } catch {
      return err(invalidBatchError('unreadable-batch'));
    }
  }

  /** Step 2: one resolution for the whole batch; a throwing attributor is an `INTERNAL` error. */
  async function resolveAttribution(
    context: IngestContext,
  ): Promise<Result<IngestAttribution, DebuggenError>> {
    try {
      return await deps.attributor.resolveBatch(context);
    } catch {
      return err(dependencyError('resolveBatch', 'INTERNAL'));
    }
  }

  /**
   * The named loss reports the ledger has accepted, as {@link lossReportKey}
   * keys in the order they were accepted, at most
   * {@link MAX_APPLIED_LOSS_REPORTS} of them. A `Set` iterates in insertion
   * order, so its first key is the oldest — the one forgotten first. Owned by
   * this pipeline and written only on the service's one event loop.
   */
  const appliedLossReports = new Set<string>();

  /**
   * Ledger writes of named loss reports still in progress, by the same key. A
   * delivery of a report whose earlier delivery is still being recorded waits
   * for that write to settle before it decides, so two concurrent deliveries
   * of one report cannot both find it unapplied. An entry is the write itself
   * (which, like every step here, does not reject) and is removed once it has
   * settled, so there are never more entries than ingest calls in progress.
   */
  const lossReportsInFlight = new Map<string, Promise<void>>();

  /**
   * Marks a named report applied, forgetting the oldest keys past
   * {@link MAX_APPLIED_LOSS_REPORTS}.
   */
  function rememberAppliedLossReport(key: string): void {
    appliedLossReports.add(key);

    while (appliedLossReports.size > MAX_APPLIED_LOSS_REPORTS) {
      const oldest = appliedLossReports.values().next();

      if (oldest.done === true) {
        return;
      }

      appliedLossReports.delete(oldest.value);
    }
  }

  /**
   * The key a delivery's loss report is applied under, or `undefined` when the
   * delivery names no usable report. A malformed id is ignored with a warning
   * that omits it, so its loss is recorded as un-keyed rather than lost.
   */
  function lossReportKeyOf(
    attribution: IngestAttribution,
    reportedLossId: unknown,
    state: RunState,
    scoped: Logger,
    originFields: LogFields,
  ): string | undefined {
    if (reportedLossId === undefined) {
      return undefined;
    }

    if (!isLossReportId(reportedLossId)) {
      emitThrottled(
        scoped,
        'warn',
        throttleKey(WARNING_CLASS.malformedLossReportId, runScope(state)),
        'a malformed producer loss report id was ignored; the loss is recorded without it',
        originFields,
      );
      return undefined;
    }

    return lossReportKey(attribution.captureId, reportedLossId);
  }

  /**
   * Step 2½: the producer's loss report, accounted against the capture the
   * batch was just attributed to — never against one the producer named.
   *
   * `reportedLoss` is the transport's `droppedCount` as received: absent or
   * `0` is no report, anything but a non-negative safe integer is ignored with
   * a warning that omits the value. `reportedLossId` is the report's
   * `lossReportId` as received, read only beside a positive count: absent or
   * malformed (ignored with a warning that omits it), the report is recorded
   * on every delivery.
   *
   * A named report is applied once per attributed capture. A delivery whose
   * `(capture, id)` the ledger has already accepted records nothing: it is
   * logged at `debug` without the id, and the count is not set on the report,
   * since it is not new loss. Otherwise the count is set on the report and
   * handed to the store's ledger when the store has one, and the key is marked
   * applied only when the ledger answers `ok` — without a ledger, or after a
   * refusal or a failure, a retry of the report is still recorded. A delivery
   * arriving while an earlier delivery's write of the same key is in progress
   * waits for that write to settle first.
   *
   * Nothing here fails the batch: a refused, failing or throwing ledger is
   * logged with its code only.
   */
  async function recordLoss(
    attribution: IngestAttribution,
    reportedLoss: unknown,
    reportedLossId: unknown,
    state: RunState,
    scoped: Logger,
    originFields: LogFields,
  ): Promise<void> {
    if (reportedLoss === undefined) {
      return;
    }

    if (!isLossCount(reportedLoss)) {
      emit(scoped, 'warn', 'a malformed producer loss report was ignored', originFields);
      return;
    }

    if (reportedLoss === 0) {
      return;
    }

    const key = lossReportKeyOf(attribution, reportedLossId, state, scoped, originFields);

    if (key === undefined) {
      await applyLoss(attribution, reportedLoss, state, scoped, originFields);
      return;
    }

    // Re-read after every wait: a write that did not reach the ledger leaves
    // the key free, and the next waiter to resume starts its own.
    for (
      let pending = lossReportsInFlight.get(key);
      pending !== undefined;
      pending = lossReportsInFlight.get(key)
    ) {
      await pending;
    }

    if (appliedLossReports.has(key)) {
      emitDebugThrottled(
        scoped,
        throttleKey(DEBUG_CLASS.lossReportRepeated, runScope(state)),
        'a repeated producer loss report was already recorded against the capture; not counted again',
        { ...originFields, droppedEvents: reportedLoss },
      );
      return;
    }

    // Registered before the first await, so a concurrent delivery of the same
    // report sees it; the key is marked inside the chain, before any waiter
    // resumes, and only when the ledger accepted the report.
    const write = applyLoss(attribution, reportedLoss, state, scoped, originFields).then(
      (accepted) => {
        if (accepted) {
          rememberAppliedLossReport(key);
        }
      },
    );
    lossReportsInFlight.set(key, write);

    try {
      await write;
    } finally {
      if (lossReportsInFlight.get(key) === write) {
        lossReportsInFlight.delete(key);
      }
    }
  }

  /**
   * Step 2½'s write: sets the count on the report and hands it to the store's
   * ledger when the store has one.
   *
   * @returns `true` only when the ledger answered `ok` — the one outcome that
   * marks a named report applied; `false` without a ledger (logged at `info`)
   * and for a refused or throwing one (logged at `warn` with its code only).
   */
  async function applyLoss(
    attribution: IngestAttribution,
    reportedLoss: number,
    state: RunState,
    scoped: Logger,
    originFields: LogFields,
  ): Promise<boolean> {
    state.producerDropped = reportedLoss;

    const store = deps.telemetry;
    let code: DebuggenErrorCode;

    try {
      if (typeof store.recordProducerLoss !== 'function') {
        emit(scoped, 'info', 'a producer reported discarded events; no loss ledger is wired', {
          ...originFields,
          droppedEvents: reportedLoss,
        });
        return false;
      }

      const recorded = await store.recordProducerLoss({
        sessionId: attribution.sessionId,
        captureId: attribution.captureId,
        ...(attribution.producerId === undefined ? {} : { producerId: attribution.producerId }),
        droppedEvents: reportedLoss,
      });

      if (recorded.ok) {
        emit(scoped, 'info', 'a producer reported discarded events; recorded against the capture', {
          ...originFields,
          droppedEvents: reportedLoss,
          ...(isLossCount(recorded.value) ? { captureDroppedEvents: recorded.value } : {}),
        });
        return true;
      }

      code = asDebuggenError(recorded.error, 'recordProducerLoss', 'STORE_ERROR').code;
    } catch {
      code = 'STORE_ERROR';
    }

    emit(scoped, 'warn', 'a producer loss report could not be recorded; the batch continues', {
      ...originFields,
      code,
      droppedEvents: reportedLoss,
    });
    return false;
  }

  /**
   * Step 3: the session's secret, read once, turned into the batch's hasher
   * once. The secret is held in this function's local scope only.
   */
  async function batchHasher(
    sessionId: SessionId,
  ): Promise<Result<RequestKeyHasher, DebuggenError>> {
    let secret: Result<string, DebuggenError>;

    try {
      secret = await deps.sessions.getOrCreateRequestKeySecret(sessionId);
    } catch {
      return err(dependencyError('getOrCreateRequestKeySecret', 'STORE_ERROR'));
    }

    if (!secret.ok) {
      return err(asDebuggenError(secret.error, 'getOrCreateRequestKeySecret', 'STORE_ERROR'));
    }

    if (typeof secret.value !== 'string') {
      return err(dependencyError('getOrCreateRequestKeySecret', 'STORE_ERROR'));
    }

    try {
      const hasher = privacy.createRequestKeyHasher(secret.value);

      return hasher.ok
        ? ok(hasher.value)
        : err(asDebuggenError(hasher.error, 'createRequestKeyHasher', 'INTERNAL'));
    } catch {
      return err(dependencyError('createRequestKeyHasher', 'INTERNAL'));
    }
  }

  /**
   * Step 4 for one element: read and validate it. A throwing getter anywhere
   * in the element is a validation failure of that element alone.
   */
  function parseElement(
    source: readonly unknown[],
    index: number,
  ): Result<TelemetryEventIngress, unknown> {
    try {
      const candidate: unknown = source[index];
      return parseTelemetryEventIngress(candidate);
    } catch {
      return err({ details: { issues: [{ path: '', code: UNREADABLE_ISSUE_CODE }] } });
    }
  }

  /** Step 6 for one event: redaction, exactly once; `undefined` when the redactor failed. */
  function redactOne(event: TelemetryEventIngress): TelemetryEventIngress | undefined {
    try {
      return privacy.redactEvent(event);
    } catch {
      return undefined;
    }
  }

  /** Step 7 for one event: the attributor's verdict, counted into `state`. */
  function attributeOne(
    event: TelemetryEventIngress,
    attribution: IngestAttribution,
    state: RunState,
  ): AttributedEvent | undefined {
    try {
      const outcome = deps.attributor.attributeEvent(event, attribution);

      if (outcome.kind === 'attributed') {
        return outcome.event;
      }

      if (isDropReason(outcome.reason)) {
        state.dropped[outcome.reason] += 1;
      } else {
        state.failures.attribution += 1;
      }

      return undefined;
    } catch {
      state.failures.attribution += 1;
      return undefined;
    }
  }

  /** Step 8: one write for the batch. */
  async function persist(
    events: readonly AttributedEvent[],
  ): Promise<Result<InsertTelemetryResult, DebuggenError>> {
    try {
      const stored = await deps.telemetry.insertMany(events);

      if (!stored.ok) {
        return err(asDebuggenError(stored.error, 'insertMany', 'STORE_ERROR'));
      }

      return Array.isArray(stored.value.events)
        ? stored
        : err(dependencyError('insertMany', 'STORE_ERROR'));
    } catch {
      return err(dependencyError('insertMany', 'STORE_ERROR'));
    }
  }

  /**
   * Step 7½: every stored `source` is the locator's answer, within the locate
   * budget; a failure is counted and a budget that expired is counted, neither
   * is fatal, and either way the batch continues to persistence.
   *
   * The whole batch is handed over — a `patch` claim included, because it is
   * corroborated against the session's modification journal rather than
   * recomputed, while a claim on any other route is withheld (see
   * {@link asLocatorCandidate}) — and each event keeps exactly the location the
   * locator returned for its id. A producer-stamped `source` the locator did
   * not return, or that could not be checked at all (no port, an `Err`, a
   * throw, an unreadable answer, a budget that ran out first), is removed and
   * counted in `sourcesRefused`.
   */
  async function locate(
    events: readonly AttributedEvent[],
    attribution: IngestAttribution,
    state: RunState,
    scoped: Logger,
  ): Promise<readonly AttributedEvent[]> {
    const sources = deps.sources;

    if (events.length === 0) {
      return events;
    }

    let code: DebuggenErrorCode | undefined;
    let placement: SourcePlacement | undefined;
    let budgetExpired = false;

    if (sources !== undefined) {
      const answer = await locateWithinBudget(
        sources,
        events.map(asLocatorCandidate),
        attribution,
        locateBudgetMs,
      );

      if (answer.kind === 'overran') {
        budgetExpired = true;
      } else if (answer.kind === 'threw') {
        code = 'INTERNAL';
      } else {
        budgetExpired = answer.budgetExpired;
        try {
          const located = answer.result;

          if (located.ok) {
            // Read inside the guard: an answer that is not a readable map is a
            // locator failure like any other, not a reason to trust the claims.
            placement = placeSources(events, located.value);
          } else {
            code = asDebuggenError(located.error, 'locate', 'INTERNAL').code;
          }
        } catch {
          code = 'INTERNAL';
        }
      }
    }

    const settled = placement ?? placeSources(events, undefined);
    state.sourcesLocated += settled.located;
    state.sourcesRefused += settled.refused;

    if (budgetExpired) {
      const unplaced = events.length - settled.located;
      state.sourcesUnplacedByBudget = unplaced;

      if (unplaced > 0) {
        emitThrottled(
          scoped,
          'warn',
          throttleKey(WARNING_CLASS.locateBudget, runScope(state)),
          'telemetry events were not located within the budget; they are stored without one',
          { pending: events.length, unplaced, budgetMs: locateBudgetMs },
        );
      }
    }

    if (code !== undefined) {
      state.failures.location = 1;
      emitThrottled(
        scoped,
        'warn',
        throttleKey(WARNING_CLASS.locateFailed, runScope(state), code),
        'telemetry events could not be located; they are stored without one',
        { code, pending: events.length, sourcesRefused: settled.refused },
      );
    }

    return settled.events;
  }

  /**
   * Step 9: hands the returned rows to the correlator, which marks the traces
   * they touch stale for a coalesced rebuild on the next read; failure is
   * counted, never fatal.
   */
  async function correlate(
    rows: readonly TelemetryEvent[],
    state: RunState,
    scoped: Logger,
  ): Promise<void> {
    const correlator = deps.correlator;

    if (correlator === undefined) {
      return;
    }

    let code: DebuggenErrorCode;

    try {
      const update = await correlator.onEventsPersisted(rows);

      if (update.ok) {
        const touched: unknown = update.value.tracesTouched;
        state.tracesTouched = Array.isArray(touched)
          ? touched.filter((traceId): traceId is TraceId => typeof traceId === 'string')
          : [];
        return;
      }

      code = asDebuggenError(update.error, 'onEventsPersisted', 'INTERNAL').code;
    } catch {
      code = 'INTERNAL';
    }

    state.failures.correlation = 1;
    emitThrottled(
      scoped,
      'warn',
      throttleKey(WARNING_CLASS.correlationFailed, runScope(state), code),
      'telemetry correlation failed; the batch stays persisted',
      { code, persisted: rows.length },
    );
  }

  /** Step 10: the live tail of the returned rows; failure is counted, never fatal. */
  function tail(
    rows: readonly TelemetryEvent[],
    sessionId: SessionId,
    state: RunState,
    scoped: Logger,
  ): void {
    const liveTail = deps.liveTail;

    if (liveTail === undefined) {
      return;
    }

    let code: DebuggenErrorCode;

    try {
      const pushed = liveTail.push(sessionId, rows);

      if (pushed.ok) {
        return;
      }

      code = asDebuggenError(pushed.error, 'push', 'INTERNAL').code;
    } catch {
      code = 'INTERNAL';
    }

    state.failures.tail = 1;
    emitThrottled(
      scoped,
      'warn',
      throttleKey(WARNING_CLASS.tailRefused, sessionScope(sessionId), code),
      'telemetry live tail refused the batch; the batch stays persisted',
      { code, persisted: rows.length },
    );
  }

  /**
   * The pipeline of the module notes, steps 1 to 11, in order — a loss-only
   * batch runs steps 1, 2 and 2½, then 11. A repeat of a named loss report
   * already applied to the attributed capture records no loss at step 2½;
   * the rest of its batch runs as any other, so a retried body's events are
   * still stored when its first delivery failed after recording the loss.
   *
   * @param reportedLoss The transport's `droppedCount`, as received — either
   * transport may carry one (step 2½); `undefined` when it carried none.
   * @param reportedLossId The transport's `lossReportId`, as received — only
   * the server transport carries one (step 2½); `undefined` when it carried
   * none.
   */
  async function run(
    context: IngestContext,
    events: unknown,
    reportedLoss: unknown,
    reportedLossId: unknown,
  ): Promise<Result<IngestReport, DebuggenError>> {
    const startedAt = readClock();
    const origin = originOf(context);
    const originFields: LogFields =
      origin === undefined
        ? {}
        : { origin, [LOG_BINDING_KEYS.client]: INGEST_ORIGIN_CLIENT_KIND[origin] };

    // 1. Bound the batch.
    const bounded = boundBatch(events);

    if (isErr(bounded)) {
      emitThrottled(
        log,
        'warn',
        throttleKey(
          WARNING_CLASS.batchRefused,
          unattributedScope(context, origin),
          bounded.error.code,
        ),
        'telemetry batch refused before ingest',
        { ...originFields, code: bounded.error.code, ...(bounded.error.details ?? {}) },
      );
      return bounded;
    }

    const { source, received } = bounded.value;
    const state = newRunState(received);
    // An event-less batch says something only as a loss report (see the module
    // notes, step 1), which either transport may carry.
    const lossOnly = received === 0 && isLossCount(reportedLoss) && reportedLoss > 0;

    if (received === 0 && !lossOnly) {
      emitDebugThrottled(
        log,
        throttleKey(DEBUG_CLASS.emptyBatch, unattributedScope(context, origin)),
        'empty telemetry batch ignored',
        originFields,
      );
      return ok(toReport(state));
    }

    // 2. Resolve attribution once. A refusal drops the whole batch before any
    //    element is read, hashed, persisted or broadcast.
    const resolved = await resolveAttribution(context);

    if (isErr(resolved)) {
      const reason = attributionDropReason(resolved.error);
      const error = asDebuggenError(resolved.error, 'resolveBatch', 'INTERNAL');

      if (reason === undefined) {
        emitThrottled(
          log,
          'warn',
          throttleKey(
            WARNING_CLASS.attributionFailed,
            unattributedScope(context, origin),
            error.code,
          ),
          'telemetry batch attribution failed',
          { ...originFields, code: error.code, received },
        );
        return err(error);
      }

      state.dropped[reason] = received;
      state.batchDropReason = reason;
      state.batchDropCode = error.code;
      emitDebugThrottled(
        log,
        throttleKey(DEBUG_CLASS.droppedBatch, unattributedScope(context, origin), reason),
        'telemetry batch dropped by attribution',
        { ...originFields, reason, code: error.code, received },
      );
      return ok(toReport(state));
    }

    const attribution = resolved.value;
    const sessionId = attribution.sessionId;
    state.sessionId = sessionId;
    state.captureId = attribution.captureId;
    const scoped = sessionLogger(log, sessionId, attribution.captureId);

    // 2½. The producer's loss report, against the capture just resolved —
    //     once per named report and capture.
    await recordLoss(attribution, reportedLoss, reportedLossId, state, scoped, originFields);

    // A loss-only batch ends here, at step 11: it holds nothing to key, parse,
    // persist, correlate or tail, so the session's secret is not even read.
    if (lossOnly) {
      emitDebugThrottled(
        scoped,
        throttleKey(DEBUG_CLASS.storedNothing, runScope(state), unattributedScope(context, origin)),
        'loss-only telemetry batch accounted',
        {
          ...originFields,
          received,
          ...(state.producerDropped === undefined
            ? {}
            : { producerDropped: state.producerDropped }),
        },
      );
      return ok(toReport(state));
    }

    // 3. One request-key hasher per batch, from the session's secret.
    const hasher = await batchHasher(sessionId);

    if (isErr(hasher)) {
      emitThrottled(
        scoped,
        'warn',
        throttleKey(WARNING_CLASS.secretUnavailable, runScope(state), hasher.error.code),
        'telemetry batch refused: the request-key secret is unavailable',
        { ...originFields, code: hasher.error.code, received },
      );
      return hasher;
    }

    // 4. Parse every element; a malformed one is counted and skipped.
    const valid: TelemetryEventIngress[] = [];
    const issueCodes = new Set<string>();
    const issueFields = new Set<string>();

    for (let index = 0; index < received; index += 1) {
      const parsed = parseElement(source, index);

      if (parsed.ok) {
        valid.push(parsed.value);
      } else {
        state.invalid += 1;
        const labels = issueLabels(parsed.error);
        collectLabels(issueCodes, labels.codes);
        collectLabels(issueFields, labels.fields);
      }
    }

    state.parsed = valid.length;

    // 5. `request_key` from the UNREDACTED URL — before redaction, see assignRequestKey.
    const keyed = await Promise.all(valid.map((event) => assignRequestKey(event, hasher.value)));

    // 6. Redact, then 7. attribute — each exactly once per event, in that order.
    const collected: AttributedEvent[] = [];

    for (const outcome of keyed) {
      if (outcome.kind === 'unsafe') {
        state.failures.redaction += 1;
        continue;
      }

      state.serviceKeysStripped += outcome.stripped;

      if (outcome.keyed) {
        state.requestKeysComputed += 1;
      } else if (outcome.keyFailed) {
        state.failures.requestKey += 1;
      }

      const redacted = redactOne(outcome.event);

      if (redacted === undefined) {
        state.failures.redaction += 1;
        continue;
      }

      const attributed = attributeOne(redacted, attribution, state);

      if (attributed !== undefined) {
        collected.push(attributed);
      }
    }

    if (state.invalid > 0) {
      emitThrottled(
        scoped,
        'warn',
        throttleKey(WARNING_CLASS.malformedEvents, runScope(state)),
        'malformed telemetry events skipped',
        {
          ...originFields,
          invalid: state.invalid,
          received,
          issueCodes: [...issueCodes],
          fields: [...issueFields],
        },
      );
    }

    if (state.serviceKeysStripped > 0) {
      emitThrottled(
        scoped,
        'warn',
        throttleKey(WARNING_CLASS.serviceKeysStripped, runScope(state)),
        'producer-supplied service-assigned attributes discarded',
        { ...originFields, count: state.serviceKeysStripped },
      );
    }

    const perEventFailures =
      state.failures.requestKey + state.failures.redaction + state.failures.attribution;

    if (perEventFailures > 0) {
      emitThrottled(
        scoped,
        'warn',
        throttleKey(WARNING_CLASS.eventsDegraded, runScope(state)),
        'telemetry events degraded or not stored during ingest',
        {
          ...originFields,
          requestKey: state.failures.requestKey,
          redaction: state.failures.redaction,
          attribution: state.failures.attribution,
        },
      );
    }

    // 7½. Locate — before persistence, so the stored row, the correlator and the tail agree
    //     on a location the locator vouched for; an unverified producer claim is removed here.
    const placed = await locate(collected, attribution, state, scoped);

    // 8. Persist — one write; the store assigns `ingestSeq` and projects each
    //    producer's `clockOffsetMs`, which is counted here and never applied.
    const clockOffsets = tallyClockOffsets(placed);
    state.clockOffsetsReported = clockOffsets.reported;

    if (placed.length > 0) {
      const stored = await persist(placed);

      if (isErr(stored)) {
        emitThrottled(
          scoped,
          'warn',
          throttleKey(WARNING_CLASS.persistFailed, runScope(state), stored.error.code),
          'telemetry batch could not be persisted',
          { ...originFields, code: stored.error.code, attributed: placed.length },
        );
        return stored;
      }

      const rows = stored.value.events;
      state.persisted = rows.length;
      state.inserted = stored.value.inserted;
      state.skipped = stored.value.skipped;

      // 9. Correlate the rows the store returned; 10. tail the same rows.
      if (rows.length > 0) {
        await correlate(rows, state, scoped);
        tail(rows, sessionId, state, scoped);
      }
    }

    // 11. Report. A batch that stored nothing is reported through the debug
    //     throttle, since a producer can repeat it without bound.
    const finishedAt = readClock();
    const summary: LogFields = {
      ...originFields,
      received,
      parsed: state.parsed,
      invalid: state.invalid,
      dropped: droppedTotal(state.dropped),
      persisted: state.persisted,
      inserted: state.inserted,
      skipped: state.skipped,
      requestKeysComputed: state.requestKeysComputed,
      sourcesLocated: state.sourcesLocated,
      sourcesUnplacedByBudget: state.sourcesUnplacedByBudget,
      sourcesRefused: state.sourcesRefused,
      tracesTouched: state.tracesTouched.length,
      ...(state.producerDropped === undefined ? {} : { producerDropped: state.producerDropped }),
      clockOffsetsReported: state.clockOffsetsReported,
      ...(clockOffsets.maxAbsMs === undefined
        ? {}
        : { maxAbsClockOffsetMs: clockOffsets.maxAbsMs }),
      ...(startedAt === undefined || finishedAt === undefined
        ? {}
        : { elapsedMs: roundMs(Math.max(0, finishedAt - startedAt)) }),
    };
    if (state.persisted > 0) {
      emit(scoped, 'debug', 'telemetry batch ingested', summary);
    } else {
      emitDebugThrottled(
        scoped,
        throttleKey(DEBUG_CLASS.storedNothing, runScope(state), unattributedScope(context, origin)),
        'telemetry batch ingested',
        summary,
      );
    }

    return ok(toReport(state));
  }

  /**
   * The end-of-call turn (see "Sharing the event loop"): awaited once per
   * call, after the outcome is decided. An injected turn that throws or
   * rejects costs the yield, never the report — the batch has already been
   * processed, and a rejection here would break the never-rejects guarantee.
   */
  async function afterTurn(
    outcome: Result<IngestReport, DebuggenError>,
  ): Promise<Result<IngestReport, DebuggenError>> {
    try {
      await yieldTurn();
    } catch {
      emitThrottled(
        log,
        'warn',
        throttleKey(WARNING_CLASS.unexpected, 'yield'),
        'the end-of-batch event-loop turn failed; the batch report is unaffected',
        { code: 'INTERNAL' },
      );
    }
    return outcome;
  }

  /**
   * {@link run} behind the never-rejects guarantee, with the transport's loss
   * report and its id, followed by the end-of-call macrotask turn.
   */
  async function execute(
    context: IngestContext,
    events: unknown,
    reportedLoss: unknown,
    reportedLossId: unknown,
  ): Promise<Result<IngestReport, DebuggenError>> {
    let outcome: Result<IngestReport, DebuggenError>;
    try {
      outcome = await run(context, events, reportedLoss, reportedLossId);
    } catch {
      // Every step above guards its own dependency; reaching this is a defect,
      // reported as a typed error rather than a rejected promise.
      emitThrottled(
        log,
        'error',
        throttleKey(WARNING_CLASS.unexpected, unattributedScope(context, originOf(context))),
        'telemetry ingest failed unexpectedly',
        { code: 'INTERNAL' },
      );
      outcome = err(dependencyError('ingest', 'INTERNAL'));
    }
    // Whatever the outcome, the next batch — of this connection or any other —
    // and every waiting timer, socket read and HTTP request get the loop first.
    return afterTurn(outcome);
  }

  function ingest(
    context: IngestContext,
    events: unknown,
  ): Promise<Result<IngestReport, DebuggenError>> {
    return execute(context, events, undefined, undefined);
  }

  function ingestFromAgent(input: AgentIngestInput): Promise<Result<IngestReport, DebuggenError>> {
    let context: BrowserIngestContext;
    let events: unknown;
    let reportedLoss: unknown;

    try {
      context = {
        origin: 'browser-agent',
        tabId: input.tabId,
        ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
        ...(input.producerId === undefined ? {} : { producerId: input.producerId }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.armedCaptureId === undefined ? {} : { armedCaptureId: input.armedCaptureId }),
      };
      events = input.events;
      reportedLoss = input.droppedCount;
    } catch {
      return afterTurn(err(invalidBatchError('unreadable-input')));
    }

    // A relayed frame names no loss report — only the HTTP transport retries a
    // body in place — so its loss is recorded on every delivery.
    return execute(context, events, reportedLoss, undefined);
  }

  function ingestFromServerAgent(
    input: ServerAgentIngestInput,
  ): Promise<Result<IngestReport, DebuggenError>> {
    let context: ServerIngestContext;
    let events: unknown;
    let reportedLoss: unknown;
    let reportedLossId: unknown;

    try {
      context = {
        origin: 'server-agent',
        projectRoot: input.projectRoot,
        scopedProjectRoot: input.scopedProjectRoot,
        ...(input.producerId === undefined ? {} : { producerId: input.producerId }),
        ...(input.armedCaptureId === undefined ? {} : { armedCaptureId: input.armedCaptureId }),
      };
      events = input.events;
      reportedLoss = input.droppedCount;
      reportedLossId = input.lossReportId;
    } catch {
      return afterTurn(err(invalidBatchError('unreadable-input')));
    }

    // The same delivery context as a relayed frame: the named capture is
    // compared by the attributor (refusal-only), and the loss is accounted
    // against the capture the batch is attributed to at step 2½ — once per
    // `lossReportId`, which stays out of the context: it attributes nothing.
    return execute(context, events, reportedLoss, reportedLossId);
  }

  return Object.freeze({ ingest, ingestFromAgent, ingestFromServerAgent });
}

/**
 * The `POST /telemetry/ingest` response for a report.
 *
 * `accepted` is how many of the batch's events the store now holds (written or
 * already present as the identical event); `rejected` is every other element —
 * malformed, dropped by attribution, or not safe to store — and is omitted
 * when zero, as the response schema prescribes.
 *
 * The route answers `202` whatever the counts, because the service did decide
 * about every event, so the body — not the status — is the acknowledgement:
 * the Node preload's exporter (`packages/telemetry/src/node/exporter.ts`)
 * counts `accepted` as posted and `rejected` as dropped by the service, and a
 * batch answered with `accepted: 0` as refused rather than posted.
 *
 * @param report The report of one ingest call.
 * @returns The body the route answers with.
 */
export function toIngestResponse(report: IngestReport): TelemetryIngestResponse {
  const accepted = report.persisted;
  const rejected = Math.max(0, report.received - accepted);

  return rejected === 0 ? { accepted } : { accepted, rejected };
}
