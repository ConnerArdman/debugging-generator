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
 * 2. **Resolve attribution once.** `attributor.resolveBatch(context)` names the
 *    session and the open capture window from the batch's *transport* identity
 *    (the bound tab, or the `server-agent` credential's scoped project). A
 *    refusal is a drop: the whole batch is counted under its `DropReason` and
 *    **nothing is parsed, hashed, persisted or broadcast** — which is what makes
 *    "an unrelated plan collects no backend telemetry" true end to end.
 * 3. **One request-key hasher per batch.** The session's secret is read from
 *    the store and `createRequestKeyHasher` is called once, so the
 *    non-extractable HMAC key is imported once per batch, not once per event.
 *    The secret lives in a local variable for the length of that call and
 *    nowhere else — never in a log record, a report, an error or a broadcast.
 * 4. **Parse every element** with `parseTelemetryEventIngress`. A malformed
 *    element is counted as `invalid` and skipped; its siblings continue. The
 *    strict ingress schema refuses `sessionId`, `captureId` and `ingestSeq`, so
 *    nothing is added to an event before this step.
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
 * 8. **Persist** — one `telemetry.insertMany` call for the whole batch. The
 *    store assigns `ingestSeq` and returns the rows as it holds them; a store
 *    failure is a typed `Err` and nothing is retried or broadcast.
 * 9. **Correlate** — `correlator.onEventsPersisted` with the rows the store
 *    **returned** (they carry `ingestSeq`, the final ordering tie-break). A
 *    failure is logged and counted, never fatal: the evidence is durable.
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
 * ## Time base
 *
 * `startTime` (epoch milliseconds as a double) and `duration` (milliseconds)
 * pass through untouched for both tiers. The injected clock is read only to
 * measure this module's own elapsed time for the summary log line.
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
 * // ../server/ws.ts — a telemetry.event frame relayed for an inspected tab:
 * const fromTab = await ingest.ingestFromAgent({ tabId, events: payload.events });
 *
 * // ../server/routes/telemetry.ts — POST /telemetry/ingest with a server-agent credential:
 * const fromServer = await ingest.ingestFromServerAgent({
 *   projectRoot: body.projectRoot,
 *   scopedProjectRoot: principal.scope,
 *   events: body.events,
 * });
 * if (fromServer.ok) {
 *   return c.json(toIngestResponse(fromServer.value), 202);
 * }
 * ```
 *
 * @module
 */

import { telemetryEventPayloadSchema, telemetryIngestRequestSchema } from '@debuggen/protocol';
import type { TelemetryIngestResponse } from '@debuggen/protocol';
import { DebuggenError, err, isErr, noopLogger, nowEpochMs, ok, roundMs } from '@debuggen/shared';
import type {
  CaptureId,
  DebuggenErrorCode,
  LogFields,
  Logger,
  Result,
  SessionId,
  TraceId,
} from '@debuggen/shared';
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

import { LOG_BINDING_KEYS, sessionLogger, subsystemLogger } from '../logging.js';
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

/** The issue code recorded for an element whose properties could not even be read. */
const UNREADABLE_ISSUE_CODE = 'unreadable';

/** The most distinct issue codes or field names one log record lists. */
const MAX_LOGGED_ISSUE_LABELS = 16;

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
 * The telemetry store, as far as ingest needs it: one bulk write.
 *
 * `insertMany` takes **already-redacted, attributed** events without an
 * `ingestSeq`, writes them in one transaction (`ON CONFLICT(id)` replays of an
 * identical event are skipped, not refused) and returns the batch as the store
 * holds it — every offered event, each carrying its store-assigned `ingestSeq`.
 *
 * @see ../store/telemetry-repo.js — `TelemetryRepo.insertMany`, the implementation.
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

/** Everything {@link createTelemetryIngest} is given; all of it injected. */
export interface TelemetryIngestDeps {
  /** The telemetry store; only `insertMany` is called. */
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
  /** The service logger; defaults to `noopLogger`. Bound to `subsystem: "telemetry.ingest"`. */
  readonly logger?: Logger | undefined;
  /** The clock this module's own elapsed time is read from; defaults to `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
  /**
   * A lower batch ceiling. Only a positive integer at most
   * {@link MAX_INGEST_BATCH} is honoured — the option may lower the transport
   * bound, never raise it; any other value is treated as absent.
   */
  readonly maxBatch?: number | undefined;
  /** The privacy primitives; defaults to {@link DEFAULT_INGEST_PRIVACY}. See its notes. */
  readonly privacy?: IngestPrivacyPrimitives | undefined;
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
  /** Producer-supplied service-assigned attribute keys removed (a producer may never set them). */
  readonly serviceKeysStripped: number;
  /** Failures that were counted rather than failing the batch. */
  readonly failures: IngestFailureCounts;
  /** The trace ids the correlator rebuilt, in first-seen order; empty without a correlator. */
  readonly tracesTouched: readonly TraceId[];
  /** The session the batch was attributed to, once resolved. */
  readonly sessionId?: SessionId;
  /** The capture window the batch was attributed to, once resolved. */
  readonly captureId?: CaptureId;
  /** Why the whole batch was dropped, when attribution refused it. */
  readonly batchDropReason?: DropReason;
  /** The code of that refusal (for example `UNAUTHORIZED` for a project-scope mismatch). */
  readonly batchDropCode?: DebuggenErrorCode;
}

/**
 * The browser-agent transport's input: the inspected tab the frame was
 * relayed for and the frame's `events`.
 *
 * `tabId` must come from the **authenticated DevTools connection** the frame
 * arrived on — never from the page. `documentId`, `producerId` and `url` are
 * diagnostic context from the agent's `agent.ready`, not authorization facts.
 */
export interface AgentIngestInput extends Omit<BrowserIngestContext, 'origin'> {
  /** The `events` of the `telemetry.event` payload, as received; validated here element by element. */
  readonly events: unknown;
}

/**
 * The server-agent transport's input: the ingest body's `projectRoot` and
 * `events`, and the credential's scope.
 *
 * `scopedProjectRoot` is the project the presented `server-agent` credential
 * is bound to, as resolved by `../server/auth.ts` — **never** a value read
 * from the request body. The two roots must agree for anything to be stored
 * (AAP §0.5.6); the attributor enforces it.
 */
export interface ServerAgentIngestInput extends Omit<ServerIngestContext, 'origin'> {
  /** The `events` of the `POST /telemetry/ingest` body, as received; validated here element by element. */
  readonly events: unknown;
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
   * The caller is `../server/ws.ts`. Builds a `browser-agent` context and
   * delegates to {@link ingest}.
   *
   * @param input The tab identity and the frame's events.
   * @returns As {@link ingest}; a malformed `input` is a `PROTOCOL_INVALID_MESSAGE` `Err`.
   */
  ingestFromAgent(input: AgentIngestInput): Promise<Result<IngestReport, DebuggenError>>;

  /**
   * Ingests a `POST /telemetry/ingest` body from the dev-server preload. The
   * caller is `../server/routes/telemetry.ts`. Builds a `server-agent` context
   * carrying both project roots and delegates to {@link ingest}.
   *
   * @param input The body's project and events, and the credential's scope.
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
  serviceKeysStripped: number;
  readonly failures: MutableFailureCounts;
  tracesTouched: readonly TraceId[];
  sessionId?: SessionId;
  captureId?: CaptureId;
  batchDropReason?: DropReason;
  batchDropCode?: DebuggenErrorCode;
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
    failures: { requestKey: 0, redaction: 0, attribution: 0, correlation: 0, tail: 0 },
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
    serviceKeysStripped: state.serviceKeysStripped,
    failures: Object.freeze({ ...state.failures }),
    tracesTouched: Object.freeze([...state.tracesTouched]),
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    ...(state.captureId === undefined ? {} : { captureId: state.captureId }),
    ...(state.batchDropReason === undefined ? {} : { batchDropReason: state.batchDropReason }),
    ...(state.batchDropCode === undefined ? {} : { batchDropCode: state.batchDropCode }),
  };

  return Object.freeze(report);
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
  const root = deps.logger ?? noopLogger;

  /**
   * Derives a logger without letting a faulty logger fail the batch: logging
   * is advisory, the pipeline's decisions stand without it.
   */
  function derive(build: () => Logger): Logger {
    try {
      return build();
    } catch {
      return noopLogger;
    }
  }

  const log = derive(() => subsystemLogger(root, INGEST_SUBSYSTEM));

  /** Writes one record; a logger that throws is ignored. */
  function emit(target: Logger, level: IngestLogLevel, message: string, fields: LogFields): void {
    try {
      target[level](message, fields);
    } catch {
      // Advisory only.
    }
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

  /** Step 9: correlation of the returned rows; failure is counted, never fatal. */
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
    emit(scoped, 'warn', 'telemetry correlation failed; the batch stays persisted', {
      code,
      persisted: rows.length,
    });
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
    emit(scoped, 'warn', 'telemetry live tail refused the batch; the batch stays persisted', {
      code,
      persisted: rows.length,
    });
  }

  /** The pipeline of the module notes, steps 1 to 11, in order. */
  async function run(
    context: IngestContext,
    events: unknown,
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
      emit(log, 'warn', 'telemetry batch refused before ingest', {
        ...originFields,
        code: bounded.error.code,
        ...(bounded.error.details ?? {}),
      });
      return bounded;
    }

    const { source, received } = bounded.value;
    const state = newRunState(received);

    if (received === 0) {
      emit(log, 'debug', 'empty telemetry batch ignored', originFields);
      return ok(toReport(state));
    }

    // 2. Resolve attribution once. A refusal drops the whole batch before any
    //    element is read, hashed, persisted or broadcast.
    const resolved = await resolveAttribution(context);

    if (isErr(resolved)) {
      const reason = attributionDropReason(resolved.error);
      const error = asDebuggenError(resolved.error, 'resolveBatch', 'INTERNAL');

      if (reason === undefined) {
        emit(log, 'warn', 'telemetry batch attribution failed', {
          ...originFields,
          code: error.code,
          received,
        });
        return err(error);
      }

      state.dropped[reason] = received;
      state.batchDropReason = reason;
      state.batchDropCode = error.code;
      emit(log, 'debug', 'telemetry batch dropped by attribution', {
        ...originFields,
        reason,
        code: error.code,
        received,
      });
      return ok(toReport(state));
    }

    const attribution = resolved.value;
    const sessionId = attribution.sessionId;
    state.sessionId = sessionId;
    state.captureId = attribution.captureId;
    const scoped = derive(() => sessionLogger(log, sessionId, attribution.captureId));

    // 3. One request-key hasher per batch, from the session's secret.
    const hasher = await batchHasher(sessionId);

    if (isErr(hasher)) {
      emit(scoped, 'warn', 'telemetry batch refused: the request-key secret is unavailable', {
        ...originFields,
        code: hasher.error.code,
        received,
      });
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
      emit(scoped, 'warn', 'malformed telemetry events skipped', {
        ...originFields,
        invalid: state.invalid,
        received,
        issueCodes: [...issueCodes],
        fields: [...issueFields],
      });
    }

    if (state.serviceKeysStripped > 0) {
      emit(scoped, 'warn', 'producer-supplied service-assigned attributes discarded', {
        ...originFields,
        count: state.serviceKeysStripped,
      });
    }

    const perEventFailures =
      state.failures.requestKey + state.failures.redaction + state.failures.attribution;

    if (perEventFailures > 0) {
      emit(scoped, 'warn', 'telemetry events degraded or not stored during ingest', {
        ...originFields,
        requestKey: state.failures.requestKey,
        redaction: state.failures.redaction,
        attribution: state.failures.attribution,
      });
    }

    // 8. Persist — one write; the store assigns `ingestSeq`.
    if (collected.length > 0) {
      const stored = await persist(collected);

      if (isErr(stored)) {
        emit(scoped, 'warn', 'telemetry batch could not be persisted', {
          ...originFields,
          code: stored.error.code,
          attributed: collected.length,
        });
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

    // 11. Report.
    const finishedAt = readClock();
    emit(scoped, 'debug', 'telemetry batch ingested', {
      ...originFields,
      received,
      parsed: state.parsed,
      invalid: state.invalid,
      dropped: droppedTotal(state.dropped),
      persisted: state.persisted,
      inserted: state.inserted,
      skipped: state.skipped,
      requestKeysComputed: state.requestKeysComputed,
      tracesTouched: state.tracesTouched.length,
      ...(startedAt === undefined || finishedAt === undefined
        ? {}
        : { elapsedMs: roundMs(Math.max(0, finishedAt - startedAt)) }),
    });

    return ok(toReport(state));
  }

  async function ingest(
    context: IngestContext,
    events: unknown,
  ): Promise<Result<IngestReport, DebuggenError>> {
    try {
      return await run(context, events);
    } catch {
      // Every step above guards its own dependency; reaching this is a defect,
      // reported as a typed error rather than a rejected promise.
      emit(log, 'error', 'telemetry ingest failed unexpectedly', { code: 'INTERNAL' });
      return err(dependencyError('ingest', 'INTERNAL'));
    }
  }

  function ingestFromAgent(input: AgentIngestInput): Promise<Result<IngestReport, DebuggenError>> {
    let context: BrowserIngestContext;
    let events: unknown;

    try {
      context = {
        origin: 'browser-agent',
        tabId: input.tabId,
        ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
        ...(input.producerId === undefined ? {} : { producerId: input.producerId }),
        ...(input.url === undefined ? {} : { url: input.url }),
      };
      events = input.events;
    } catch {
      return Promise.resolve(err(invalidBatchError('unreadable-input')));
    }

    return ingest(context, events);
  }

  function ingestFromServerAgent(
    input: ServerAgentIngestInput,
  ): Promise<Result<IngestReport, DebuggenError>> {
    let context: ServerIngestContext;
    let events: unknown;

    try {
      context = {
        origin: 'server-agent',
        projectRoot: input.projectRoot,
        scopedProjectRoot: input.scopedProjectRoot,
        ...(input.producerId === undefined ? {} : { producerId: input.producerId }),
      };
      events = input.events;
    } catch {
      return Promise.resolve(err(invalidBatchError('unreadable-input')));
    }

    return ingest(context, events);
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
 * @param report The report of one ingest call.
 * @returns The body the route answers with.
 */
export function toIngestResponse(report: IngestReport): TelemetryIngestResponse {
  const accepted = report.persisted;
  const rejected = Math.max(0, report.received - accepted);

  return rejected === 0 ? { accepted } : { accepted, rejected };
}
