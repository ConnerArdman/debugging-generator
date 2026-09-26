/**
 * Request aggregation: the `requests` DataResult of AAP 0.4.2 and the evidence
 * behind every duplicate-request finding the product reports.
 *
 * `POST /sessions/:id/panel-data { source: "requests" }` answers with the
 * `RequestGroup[]` computed here. The `requestTable` panel node renders one row
 * per logical request, badges the groups that repeated, and expands to the
 * individual occurrences with their initiator source links (AAP 0.6.2); the
 * `request_count` and `duplicate_request_count` metric cards are computed from
 * the same groups in `./summary.ts`, so the badge and the card can never
 * disagree.
 *
 * ## The grouping key is the pre-redaction request key, never the shown URL
 *
 * A group is keyed by the `request_key` attribute: the HMAC the ingest path
 * computes from the *unredacted* method, path and sorted query pairs, with a
 * per-session key kept only in the store (AAP 0.5.2, `../redaction/request-key.ts`).
 * Two consequences shape this module.
 *
 * - Grouping never reads the `url` attribute. By the time an event reaches an
 *   aggregate its query values are masked, so `/api/items?id=1` and
 *   `/api/items?id=2` both display as `/api/items?id=?`; grouping on that
 *   string would report two unrelated requests as duplicates of each other.
 *   Grouping on the key keeps them apart and still collapses byte-identical
 *   repeats. `url` is carried for display only.
 * - The key is read as an opaque lowercase-hex string. Nothing here parses,
 *   validates the digest, re-derives or reverses it, and no hashing primitive
 *   is imported: this file belongs to the `platform: "neutral"` bundle, which
 *   has neither WebCrypto nor a Node builtin available. `../redaction/redactor.ts`
 *   exempts the key from masking precisely so this module can still group.
 *
 * An event without a usable key must still be reported, so it falls back to a
 * `method + path` key and says so through `RequestGroup.groupedBy`. The two key
 * spaces are never mixed inside one group.
 *
 * ## Duplicate detection is windowed
 *
 * Repetition on its own is not a defect: a view that refetches once a minute is
 * healthy, four identical requests inside 22 ms is not (AAP 0.5.4's analysis
 * example). Occurrences are therefore swept into windows, only a window holding
 * two or more occurrences counts, and `duplicateCount` reports the number of
 * *redundant* occurrences rather than the number of windows.
 *
 * ## Transferred bytes arrive by a join, not from the request span
 *
 * A request span cannot report how many bytes crossed the wire: `fetch` and
 * `XMLHttpRequest` expose no such figure, and the only browser API that does
 * is `PerformanceResourceTiming` (AAP 0.6.6). `../browser/perf.ts` observes
 * those entries as `perf.entry` events, and this module is where the two
 * halves of one exchange are put back together — {@link joinResourceTimings},
 * the "join resource entries to `fetch` spans by URL and start time" the
 * producer modules are written against.
 *
 * Four rules make the join safe to base a metric on:
 *
 * - **Identity is a URL, compared after redaction.** A request event carries
 *   `resourceTimingUrl`, the absolute URL the browser will file its resource
 *   entry under, beside the `url` the application wrote; a resource entry
 *   carries that same absolute URL as its own `url`. Redaction is
 *   deterministic and masks both through the same handler, so the masked
 *   strings match exactly when the raw ones did. The as-written `url` is the
 *   fallback identity, for a producer that predates the key.
 * - **Timing narrows what identity cannot.** Masking makes `?id=1` and
 *   `?id=2` indistinguishable, so identity alone could attach one response's
 *   bytes to another request for the same path. A candidate qualifies only if
 *   it started inside the request's own window, widened by
 *   {@link DEFAULT_RESOURCE_TIMING_TOLERANCE_MS}, and among the qualifying
 *   candidates the closest start wins.
 * - **One entry, one request.** A claimed entry is never offered again, so two
 *   requests for the same URL take two different entries and a group's
 *   `transferredBytes` can never count one response twice. Claims are recorded
 *   on the occurrence (`transferEventId`) and on the group
 *   (`transferEventIds`) precisely so `./summary.ts` can add the resource
 *   entries *nobody* claimed without double-counting the ones that were.
 * - **Bytes must have been exposed.** A cross-origin response served without
 *   `Timing-Allow-Origin` reports `transferSize: 0`, which is an absence
 *   rather than a measurement; {@link readExposedTransferSize} is the single
 *   reader that tells the two apart, and an unexposed entry is not a candidate
 *   at all.
 *
 * The join is a function of the events alone: occurrences are considered in
 * canonical order and candidates in start order, so the same capture yields
 * the same pairing however the events arrived. It is also sub-quadratic —
 * O((r + c) · log c) for r requests and c resource entries, however many of
 * them share one URL — because each identity is indexed once and searched by
 * binary search, skip pointers and a range minimum rather than scanned per
 * request; the join section below states the algorithm.
 *
 * ## Pending requests
 *
 * A request still on the wire when its capture ended reaches this module as an
 * **in-flight snapshot**: the one event `../browser/fetch.ts` emits for it at
 * the capture boundary, marked with {@link REQUEST_IN_FLIGHT_ATTRIBUTE}. The
 * rules that keep such a request from being misread:
 *
 * - **Only the marker makes a request pending.** An event is pending exactly
 *   when that attribute is the boolean `true`; the string `'true'`, `1`,
 *   `false` and absence all read as settled. A missing status code never does:
 *   a network error, an abort and an opaque response all settle without one.
 * - **A pending occurrence reports no response.** It is published with
 *   `pending: true` and without a `statusCode`, even if the event carried one;
 *   its own transfer size is not read and it takes no part in the
 *   resource-timing join, so it claims no entry and any entry that matches it
 *   stays available to a settled request, or unclaimed for `./summary.ts`. Its
 *   span status is carried as reported.
 * - **It is never a failure.** Nothing had failed when it was observed, so a
 *   group's `statusCodes` and `errorCount` describe its settled occurrences
 *   only.
 * - **It is counted.** A group carries `pendingCount` — pending occurrences
 *   over every occurrence, before `maxOccurrencesPerGroup` truncation — only
 *   when at least one is pending. Absence means zero, so a capture with no
 *   pending request produces exactly the groups it always did.
 * - **A settled event supersedes a snapshot of its own span.** A settled event
 *   sharing a snapshot's `(traceId, spanId)` is the same request, observed
 *   finishing, so the snapshot is dropped before the join and before grouping
 *   and is counted nowhere; keeping both would report one request as a
 *   duplicate of itself. Several snapshots of one span with no settled event
 *   collapse to exactly one — the latest observation (largest `endTime`, then
 *   smallest id), whatever order they arrived in. Settled events are never
 *   dropped or merged: two settled events sharing a span both stay.
 * - **Its timing is a lower bound.** Its duration is the time it had been
 *   outstanding when observed, and that elapsed time is included in the
 *   group's duration figures. Duplicate windows are swept by issuance start,
 *   which a pending request has like any other.
 *
 * ## Purity
 *
 * The input is an already-ingested, already-redacted event list. This module
 * returns new objects, mutates nothing, performs no I/O, opens no socket,
 * touches no store, reads no clock and throws nothing: a malformed attribute is
 * skipped field by field, never fatally. It runs identically in the page, in the
 * service and in a test.
 */

import type { EventId, SourceLocation, SpanId, TraceId } from '@debuggen/shared';
import { clampNonNegative, roundMs } from '@debuggen/shared';

import {
  FETCH_ATTRIBUTE_KEYS,
  PERF_ENTRY_ATTRIBUTE_KEYS,
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
} from '../schema/attributes.js';
import type { TelemetryEvent } from '../schema/event.js';
import { PERF_KINDS, REQUEST_KINDS, type TelemetryKind } from '../schema/kinds.js';

/*
 * ---------------------------------------------------------------------------
 * Attribute keys
 *
 * `../schema/attributes.ts` owns every key name; no aggregate may spell one
 * itself. The constants below are therefore named locally and *typed* against
 * that catalog, which is the idiom `../redaction/url.ts` established: a rename
 * upstream becomes a build error here instead of a column that silently stops
 * populating.
 * ---------------------------------------------------------------------------
 */

/**
 * A key the attribute catalog declares for the request-shaped kinds.
 *
 * `FETCH_ATTRIBUTE_KEYS` and `XHR_ATTRIBUTE_KEYS` are declared separately there
 * but mirror each other key for key by that catalog's own statement, so one of
 * them types every constant below and the other needs no import.
 */
type RequestAttributeKey = (typeof FETCH_ATTRIBUTE_KEYS)[number];

/** The request method, e.g. `GET`. */
const METHOD_ATTRIBUTE: RequestAttributeKey = 'http.method';

/** The redacted request URL: a display string, never a grouping input. */
const URL_ATTRIBUTE: RequestAttributeKey = 'url';

/** The response status code. */
const STATUS_CODE_ATTRIBUTE: RequestAttributeKey = 'http.status_code';

/** A label for whatever started the request (a component or a stack frame). */
const INITIATOR_ATTRIBUTE: RequestAttributeKey = 'initiator';

/**
 * Bytes over the wire, from `PerformanceResourceTiming.transferSize`.
 *
 * Note the deliberate difference in spelling: the *attribute* is `transferSize`
 * because that is what the timing entry calls it, while the aggregated *field*
 * is {@link RequestGroup.transferredBytes}, matching the `transferred_bytes`
 * metric id. Same quantity, two vocabularies, one conversion point.
 */
const TRANSFER_SIZE_ATTRIBUTE: RequestAttributeKey = 'transferSize';

/** The service-assigned grouping key described in this module's header. */
const REQUEST_KEY_ATTRIBUTE: RequestAttributeKey = 'request_key';

/**
 * A key the attribute catalog declares for resource-timing entries.
 *
 * The join reads the other half of the exchange, so the resource-entry
 * vocabulary types its constants exactly as the request vocabulary types the
 * ones above.
 */
type ResourceAttributeKey = (typeof PERF_ENTRY_ATTRIBUTE_KEYS)[number];

/**
 * Which `PerformanceEntry` type a `perf.entry` event describes.
 *
 * `perf.entry` covers resource loads and paint marks, and only the first can
 * carry bytes, so the join reads this key instead of inferring the shape from
 * which other attributes happen to be present.
 */
const ENTRY_TYPE_ATTRIBUTE: ResourceAttributeKey = 'entry.type';

/** The resource entry's own URL: absolute, and the join's identity. */
const RESOURCE_URL_ATTRIBUTE: ResourceAttributeKey = 'url';

/** What initiated the load — `fetch`, `xmlhttprequest`, `script`, `link`, … */
const INITIATOR_TYPE_ATTRIBUTE: ResourceAttributeKey = 'initiator.type';

/**
 * The absolute URL a request event will appear under in the Resource Timing
 * buffer.
 *
 * **Not declared by the catalog.** `../browser/fetch.ts` invents the spelling
 * and documents why the key exists; this is the consumer-side half of the same
 * contract, exported so a test can pin the two spellings together and so
 * `./summary.ts` never re-states it. When `../schema/attributes.ts` adopts the
 * key in the `fetch` and `xhr` tuples, this constant becomes a typed read of
 * the catalog like its neighbours above.
 */
export const RESOURCE_TIMING_URL_ATTRIBUTE = 'resourceTimingUrl';

/**
 * Whether Resource Timing exposed byte counts for an event at all.
 *
 * **Not declared by the catalog.** `../browser/perf.ts` invents the spelling
 * and states the reasoning: a cross-origin response served without
 * `Timing-Allow-Origin` reports every size as `0`, which is indistinguishable
 * by value from a same-origin response that genuinely transferred nothing, so
 * the producer answers the question explicitly rather than leaving a consumer
 * to guess. Exported for the same reasons as
 * {@link RESOURCE_TIMING_URL_ATTRIBUTE}, and read by
 * {@link readExposedTransferSize}, which is the only place either module
 * interprets it.
 */
export const TRANSFER_SIZE_EXPOSED_ATTRIBUTE = 'transferSizeExposed';

/**
 * Whether a request event is an **in-flight snapshot** rather than a settled
 * request.
 *
 * **Declared by the catalog** in the `fetch` and `xhr` tuples of
 * `../schema/attributes.ts`, and typed against that declaration with
 * `satisfies` like the request keys at the top of this module: a rename
 * upstream is a build error here, while the exported constant keeps its literal
 * spelling for the producer-side test that pins `../browser/fetch.ts` to it. A
 * producer writes it — as the boolean `true`, never any other value — on the
 * one event it emits for a request that was still on the wire when the capture
 * it belongs to ended: the request had started and had not settled, so the
 * event carries no status code, reports span status `unset`, and measures its
 * duration up to the moment of the snapshot rather than to a completion.
 *
 * It is the only thing that makes a request *pending*. An absent status code is
 * not: a network error, an abort and a cross-origin refusal all settle without
 * one, and reading any of them as "still waiting" would state something the
 * capture never observed.
 */
export const REQUEST_IN_FLIGHT_ATTRIBUTE = 'inFlight' satisfies RequestAttributeKey;

/**
 * Whether the grouping key is still a service-assigned attribute.
 *
 * This is a trust boundary, not decoration. The key may be grouped on only
 * because the ingest path computes it: a page cannot forge one, which is why
 * `../redaction/redactor.ts` exempts exactly the service-assigned keys from
 * masking. Were a future edit to move the key out of that group — making it
 * producer-supplied — a page could decide which of its requests appear as
 * duplicates of each other. The reader is gated on this flag so that change
 * degrades to the documented `method-path` key space instead.
 */
const REQUEST_KEY_IS_SERVICE_ASSIGNED: boolean =
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS.includes(REQUEST_KEY_ATTRIBUTE);

/*
 * ---------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------
 */

/**
 * The window inside which identical requests are considered duplicates, in
 * milliseconds.
 *
 * AAP 0.5.4's analysis example observes four identical requests within 22 ms,
 * comfortably inside this default, while a view that refetches every few
 * seconds stays outside it. It is an option
 * ({@link RequestAggregateOptions.duplicateWindowMs}) so the analysis stage can
 * tighten the window when a question calls for a stricter reading.
 */
export const DEFAULT_DUPLICATE_WINDOW_MS = 1000;

/**
 * How many occurrences a group carries at most.
 *
 * The bound exists because an aggregate can ride inside `CaptureSummary` over a
 * WebSocket (AAP 0.4.2's `capture.stopped`), and a capture can hold thousands
 * of requests. Counts, durations and duplicate windows are always computed over
 * *every* occurrence; only the exposed list is bounded, and
 * {@link RequestGroup.occurrencesTruncated} says when it was.
 */
export const DEFAULT_MAX_OCCURRENCES_PER_GROUP = 200;

/**
 * Request-scoped alias of {@link DEFAULT_MAX_OCCURRENCES_PER_GROUP}: the same
 * bound under a name that is unique across the aggregate folder.
 *
 * `./queries.ts` exports a bound of its own called
 * `DEFAULT_MAX_OCCURRENCES_PER_GROUP`, and `../index.ts` re-exports every
 * aggregate module flat, so a `export *` barrel would find that one name
 * exported twice — ambiguous under `isolatedModules`. The barrel resolves such
 * a clash with an explicit named re-export rather than by renaming either
 * source symbol, and this alias is the name it can re-export: importing it
 * needs no disambiguation now and stays correct if the barrel later picks it
 * up.
 */
export const DEFAULT_MAX_REQUEST_OCCURRENCES_PER_GROUP = DEFAULT_MAX_OCCURRENCES_PER_GROUP;

/**
 * Stand-in for a request whose method could not be read.
 *
 * Evidence is never silently discarded — the correlator attaches orphan spans
 * rather than dropping them, and an aggregate follows the same policy — so such
 * an event is grouped under this label and remains visible.
 */
export const UNKNOWN_METHOD_LABEL = '(unknown method)';

/** Stand-in for a request whose URL could not be read. */
export const UNKNOWN_URL_LABEL = '(unknown url)';

/**
 * How a group's identity was established.
 *
 * `request-key` is the normal case. `method-path` is the documented fallback,
 * used only when an event carries no usable key — a producer that predates
 * attribution, or an event ingested outside the normal path. A group says which
 * it is so the panel and the analysis stage can weigh it accordingly: a
 * `method-path` group collapses requests that differ in their query values,
 * which is exactly the conflation the key exists to prevent.
 */
export const REQUEST_GROUPED_BY = Object.freeze(['request-key', 'method-path'] as const);

/** @see REQUEST_GROUPED_BY */
export type RequestGroupedBy = (typeof REQUEST_GROUPED_BY)[number];

/**
 * How far outside a request's own window a resource entry may have started and
 * still be considered the same exchange, in milliseconds.
 *
 * A resource entry's `startTime` is the fetch start, so it lies inside the
 * request span in the ordinary case and this tolerance covers only the ways the
 * two readings can disagree at the edges: the request event's duration is
 * rounded to milliseconds before it reaches here, the two producers timestamp
 * at slightly different points of the same operation, and a `fetch` promise
 * settles when the headers arrive while the entry is completed when the body
 * does.
 *
 * Deliberately small. Widening it does not find more matches — identity has
 * already narrowed the candidates to one URL — it only makes it likelier that
 * a *different* request for the same masked URL is credited with this
 * response's bytes, which is the one error the join must not make.
 */
export const DEFAULT_RESOURCE_TIMING_TOLERANCE_MS = 50;

/**
 * The `entry.type` value of a resource load.
 *
 * Named once here because the join tests for it twice: a `perf.entry` event
 * whose type is something else (a paint mark) never carries bytes, and one
 * whose type is missing is admitted, because a producer that omits the label
 * but reports a size has still measured a response.
 */
export const RESOURCE_ENTRY_TYPE = 'resource';

/**
 * Where an occurrence's `transferredBytes` came from.
 *
 * `request` means the request event carried its own exposed size — the
 * authoritative reading when it exists, since it is the page's own account of
 * its own request. `resource-timing` means the number was joined from a
 * `PerformanceResourceTiming` entry, which is the ordinary case in a browser
 * capture because no request API reports a size at all (AAP 0.6.6). The panel
 * and the analysis stage can weigh a number differently for knowing which it
 * is, and a reader of a group's total can see whether a join happened.
 */
export const REQUEST_TRANSFER_SOURCES = Object.freeze(['request', 'resource-timing'] as const);

/** @see REQUEST_TRANSFER_SOURCES */
export type RequestTransferSource = (typeof REQUEST_TRANSFER_SOURCES)[number];

/*
 * ---------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------------
 */

/**
 * One observed execution of a request.
 *
 * Every field is a scalar, a string or a plain object: these shapes cross a
 * WebSocket and an HTTP response, so nothing holds an object cycle and nothing
 * holds a request or response body. Bodies and headers are never captured
 * (AAP 0.5.2); method, redacted URL, status, timing and size are all there is.
 */
export interface RequestOccurrence {
  /**
   * The occurrence's identity, equal to {@link eventId}.
   *
   * Both names exist because the service pages array-valued results with a
   * stable secondary sort key called `id` (AAP 0.4.2), while a panel that wants
   * to select the underlying event reads `eventId`. One value, two contracts.
   */
  readonly id: EventId;
  /** The telemetry event this occurrence was read from. */
  readonly eventId: EventId;
  /** The span that represents the request. */
  readonly spanId: SpanId;
  /** The trace the request belongs to. */
  readonly traceId: TraceId;
  /** The parent span, when the producer reported one. */
  readonly parentSpanId?: SpanId;
  /** Start of the request, in epoch milliseconds (the product's canonical base). */
  readonly startTime: number;
  /** Duration in milliseconds, clamped non-negative and rounded. */
  readonly durationMs: number;
  /** `startTime + durationMs`, precomputed so the renderer does no timing maths. */
  readonly endTime: number;
  /** The response status code, when one was reported as a finite integer. */
  readonly statusCode?: number;
  /** The span status the producer reported. */
  readonly status: TelemetryEvent['status'];
  /**
   * `true` when the occurrence is an in-flight snapshot: the producer saw the
   * request start and not settle before the capture ended (see
   * {@link REQUEST_IN_FLIGHT_ATTRIBUTE}). Absent for every settled request —
   * never `false` — so the field is present exactly when it says something.
   *
   * A pending occurrence has no {@link statusCode} and no transfer figure,
   * because no response had arrived, and it never counts as a failure. Its
   * {@link durationMs} is the time the request had been outstanding when it was
   * observed, which is a lower bound on its real duration, and its
   * {@link endTime} is that observation instant rather than a completion.
   */
  readonly pending?: true;
  /** The initiator label, when the producer reported one. */
  readonly initiator?: string;
  /** Where the request was issued from, when a location could be resolved. */
  readonly source?: SourceLocation;
  /**
   * Bytes over the wire, when a reading was exposed for this occurrence.
   *
   * Absent whenever nothing measured the response — which is the ordinary case
   * for a cross-origin request (AAP 0.6.6) — never `0` standing in for
   * unknown. {@link transferSource} says where a present figure came from.
   */
  readonly transferredBytes?: number;
  /**
   * Which side of the join supplied {@link transferredBytes}; absent with it.
   */
  readonly transferSource?: RequestTransferSource;
  /**
   * The resource-timing event this occurrence was joined to, when the join
   * found one.
   *
   * Present whenever a candidate was claimed, including when the request's own
   * size won as the authoritative reading: the id records the *claim*, which
   * is what stops the same response being counted a second time as an
   * unattributed resource entry. A panel can also use it to open the timing
   * entry behind a byte figure.
   */
  readonly transferEventId?: EventId;
  /** The tier that produced the event. */
  readonly tier: TelemetryEvent['tier'];
  /** The request kind (a member of the catalog's request kind group). */
  readonly kind: TelemetryKind;
}

/**
 * A cluster of two or more occurrences of one request issued close together.
 *
 * `startTime` and `endTime` bound the window of *issuance* — the first and last
 * start, not the last completion — which keeps the invariant
 * `endTime - startTime <= duplicateWindowMs` and makes the observed fact the
 * analysis states ("N identical requests within X ms") readable straight off the
 * window.
 */
export interface DuplicateWindow {
  /** Deterministic id: the group's id plus the cluster's ordinal. */
  readonly id: string;
  /** Start of the earliest occurrence in the window, in epoch milliseconds. */
  readonly startTime: number;
  /** Start of the latest occurrence in the window, in epoch milliseconds. */
  readonly endTime: number;
  /** How many occurrences fell inside the window; always two or more. */
  readonly count: number;
  /** `count - 1`: the occurrences that were redundant. */
  readonly redundantCount: number;
  /**
   * Every occurrence in the window, by event id.
   *
   * Identifiers only, never payloads, so the list is safe to carry in full;
   * {@link count} stays authoritative for the window's size.
   */
  readonly eventIds: readonly EventId[];
}

/**
 * All observed executions of one logical request, with its duplicate evidence.
 *
 * This is the row shape of the `requests` DataResult and the input the
 * `request_count` and `duplicate_request_count` metrics are computed from.
 */
export interface RequestGroup {
  /**
   * Stable, deterministic identity derived from the grouping key.
   *
   * Never random and never an array index: the service uses `id` as the stable
   * secondary sort key when it pages results (AAP 0.4.2), so the same capture
   * aggregated twice must produce the same ids in the same order. The two key
   * spaces carry distinct prefixes, so a crafted method or path cannot produce
   * the id of a keyed group.
   */
  readonly id: string;
  /** The service-assigned key, when the group was formed from one. */
  readonly requestKey?: string;
  /** Which key space formed the group. */
  readonly groupedBy: RequestGroupedBy;
  /** The request method, or {@link UNKNOWN_METHOD_LABEL}. */
  readonly method: string;
  /** The redacted URL as stored, for display. */
  readonly url: string;
  /** The path component of {@link url}, derived by string scan. */
  readonly path: string;
  /** How many occurrences the capture holds, before any truncation. */
  readonly count: number;
  /**
   * Redundant occurrences: the sum of `count - 1` over the duplicate windows.
   *
   * Not the number of windows and not the total number of occurrences. Two
   * separate pairs report 2, a single burst of four reports 3, and a request
   * issued once per second for a minute reports 0.
   */
  readonly duplicateCount: number;
  /** `duplicateCount > 0`. */
  readonly hasDuplicates: boolean;
  /** The clusters that produced {@link duplicateCount}, in time order. */
  readonly duplicateWindows: readonly DuplicateWindow[];
  /** Start of the earliest occurrence, in epoch milliseconds. */
  readonly firstStartTime: number;
  /** Start of the latest occurrence, in epoch milliseconds. */
  readonly lastStartTime: number;
  /** Summed duration of every occurrence, in milliseconds. */
  readonly totalDurationMs: number;
  /** `totalDurationMs / count`, rounded. */
  readonly averageDurationMs: number;
  /** The slowest occurrence's duration, in milliseconds. */
  readonly maxDurationMs: number;
  /** The fastest occurrence's duration, in milliseconds. */
  readonly minDurationMs: number;
  /** Distinct status codes observed, ascending. */
  readonly statusCodes: readonly number[];
  /** Occurrences that failed: status code at or above 400, or span status `error`. */
  readonly errorCount: number;
  /**
   * Occurrences that were still pending when the capture ended — see
   * {@link RequestOccurrence.pending} — counted over every occurrence, before
   * truncation, so it is never larger than {@link count}.
   *
   * Present only when at least one occurrence is pending, like
   * {@link transferredBytes}: absent means none was, which keeps every group
   * shape that predates the field valid. When present, the group's duration
   * figures include those occurrences' elapsed time and are therefore lower
   * bounds, while {@link statusCodes} and {@link errorCount} describe the
   * settled occurrences only.
   */
  readonly pendingCount?: number;
  /**
   * Distinct initiator labels, sorted.
   *
   * Distinctness is load-bearing rather than cosmetic: a duplicate group with
   * *two* initiators is a different finding from one with a single initiator
   * firing twice (AAP 0.8.2), so the set is never collapsed to its first entry.
   */
  readonly initiators: readonly string[];
  /**
   * Summed bytes over the wire, absent unless at least one occurrence has a
   * size.
   *
   * `transferSize` is exposed for same-origin responses only (AAP 0.6.6
   * records this as a known gap), so the field must be able to be missing for
   * the metric card to show "n/a" rather than a misleading zero. Summed over
   * the occurrences that have a figure, each counted once — see the header's
   * "one entry, one request".
   */
  readonly transferredBytes?: number;
  /**
   * The resource-timing events this group's occurrences claimed, ascending,
   * absent when the join matched nothing.
   *
   * Identifiers only, like {@link DuplicateWindow.eventIds}, and the reason
   * the group carries them rather than leaving them on the occurrences: an
   * occurrence list is bounded by
   * {@link RequestAggregateOptions.maxOccurrencesPerGroup} and is omitted
   * entirely when a caller wants arithmetic without samples, while
   * `./summary.ts` must know every claim to add the *unclaimed* resource
   * entries to `transferred_bytes` without counting a response twice.
   */
  readonly transferEventIds?: readonly EventId[];
  /** Occurrences in canonical order, bounded by the option of the same name. */
  readonly occurrences: readonly RequestOccurrence[];
  /** Whether {@link occurrences} omits occurrences that {@link count} includes. */
  readonly occurrencesTruncated: boolean;
}

/** Options for {@link aggregateRequests}. */
export interface RequestAggregateOptions {
  /**
   * Duplicate window in milliseconds; defaults to
   * {@link DEFAULT_DUPLICATE_WINDOW_MS}. A negative or non-finite value falls
   * back to the default; zero is honoured and clusters only occurrences that
   * share a start time exactly.
   */
  readonly duplicateWindowMs?: number;
  /**
   * Maximum occurrences carried per group; defaults to
   * {@link DEFAULT_MAX_OCCURRENCES_PER_GROUP}. Zero omits the lists entirely
   * while leaving every count intact.
   */
  readonly maxOccurrencesPerGroup?: number;
  /**
   * Tolerance for the resource-timing join, in milliseconds; defaults to
   * {@link DEFAULT_RESOURCE_TIMING_TOLERANCE_MS}. A negative or non-finite
   * value falls back to the default; zero requires the entry to have started
   * inside the request's window exactly.
   */
  readonly resourceTimingToleranceMs?: number;
}

/*
 * ---------------------------------------------------------------------------
 * Internals
 * ---------------------------------------------------------------------------
 */

/**
 * The status code at and above which a response counts as a failure.
 *
 * Client and server errors both count: from the developer's side a request that
 * came back 404 and one that came back 503 are equally unsuccessful, and the
 * distinction lives in {@link RequestGroup.statusCodes}, which keeps every
 * observed code.
 */
const HTTP_ERROR_STATUS_FLOOR = 400;

/** Namespace for every group and window id this module mints. */
const GROUP_ID_PREFIX = 'req';

/** The `scheme` production of RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ). */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;

/** The delimiter between a URL's scheme and its authority. */
const SCHEME_SEPARATOR = '://';

/**
 * Locale-independent string order.
 *
 * Code-unit comparison rather than `localeCompare`, so the base order the
 * service pages by is identical on every machine and in every environment.
 */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Canonical occurrence order: start time, then id as the always-distinct key. */
function compareOccurrences(left: RequestOccurrence, right: RequestOccurrence): number {
  if (left.startTime !== right.startTime) {
    return left.startTime < right.startTime ? -1 : 1;
  }
  return compareStrings(left.id, right.id);
}

/**
 * Base group order: most redundant first, then most frequent, then slowest,
 * then by id.
 *
 * The service re-sorts per `DataQuery.sort` (`duration_desc`, `count_desc`,
 * `start_asc`) but pages with `limit`/`offset` (AAP 0.4.2), so the aggregate has
 * to hand it a total, stable order: without one, two pages of the same result
 * could omit a group or repeat it. Duplicates lead because a duplicate group is
 * the finding, and `./summary.ts` takes its `topRequests` off the front of this
 * order.
 */
function compareGroups(left: RequestGroup, right: RequestGroup): number {
  if (left.duplicateCount !== right.duplicateCount) {
    return right.duplicateCount - left.duplicateCount;
  }
  if (left.count !== right.count) {
    return right.count - left.count;
  }
  if (left.totalDurationMs !== right.totalDurationMs) {
    return right.totalDurationMs - left.totalDurationMs;
  }
  return compareStrings(left.id, right.id);
}

/**
 * Read one attribute, tolerating anything.
 *
 * `../schema/event.ts` checks attribute values only shallowly for
 * transportability, so a throwing getter, a proxy or an exotic value can reach
 * an aggregate. Every read therefore goes through here: a hostile attribute
 * costs its own field and nothing else.
 */
function readAttribute(event: TelemetryEvent, key: string): unknown {
  try {
    const attributes = event.attributes;
    if (typeof attributes !== 'object' || attributes === null) {
      return undefined;
    }
    return attributes[key];
  } catch {
    return undefined;
  }
}

/** A string attribute with at least one non-whitespace character, verbatim. */
function readNonBlankString(event: TelemetryEvent, key: string): string | undefined {
  const value = readAttribute(event, key);
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

/** An integer attribute; a non-integer or non-numeric value is skipped. */
function readInteger(event: TelemetryEvent, key: string): number | undefined {
  const value = readAttribute(event, key);
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return undefined;
  }
  return value;
}

/** A finite, non-negative numeric attribute. */
function readNonNegativeNumber(event: TelemetryEvent, key: string): number | undefined {
  const value = readAttribute(event, key);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * The transfer size an event **measured**, or `undefined` when it measured
 * none.
 *
 * The single reader of byte counts in the aggregate layer, exported so that
 * `./summary.ts` applies exactly this rule to the `transferred_bytes` metric
 * rather than a second reading of the same attributes. Three cases, in order:
 *
 * 1. The producer says the counts were **not exposed**
 *    ({@link TRANSFER_SIZE_EXPOSED_ATTRIBUTE} is `false`). Decisive: the value
 *    beside it is the specification's `0` for a failed timing-allow check, not
 *    a measurement, and reporting it would present an absence as an
 *    observation (AAP 0.6.6, 0.8.4).
 * 2. The producer says they **were** exposed. The reading is taken as it
 *    stands, `0` included — a same-origin response served from cache really
 *    did transfer nothing.
 * 3. The producer says **nothing**, which is how an event from a producer that
 *    predates the exposure contract arrives. A positive number is then still a
 *    measurement (nothing withheld reports bytes it did not transfer), while a
 *    bare `0` is ambiguous and is therefore not counted. That is the
 *    conservative direction the metric requires: `n/a` is the honest answer
 *    when "nothing was transferred" and "nothing was measured" cannot be told
 *    apart.
 *
 * A non-numeric, negative or non-finite value is never a reading in any case.
 *
 * @param event Any already-ingested event.
 * @returns The measured bytes, or `undefined`.
 */
export function readExposedTransferSize(event: TelemetryEvent): number | undefined {
  const bytes = readNonNegativeNumber(event, TRANSFER_SIZE_ATTRIBUTE);
  if (bytes === undefined) {
    return undefined;
  }

  const exposed = readAttribute(event, TRANSFER_SIZE_EXPOSED_ATTRIBUTE);
  if (exposed === false) {
    return undefined;
  }
  if (exposed === true) {
    return bytes;
  }
  return bytes > 0 ? bytes : undefined;
}

/**
 * The service-assigned grouping key, or `undefined` when there is none to
 * trust.
 *
 * @see REQUEST_KEY_IS_SERVICE_ASSIGNED for why the flag gates the read.
 */
function readRequestKey(event: TelemetryEvent): string | undefined {
  if (!REQUEST_KEY_IS_SERVICE_ASSIGNED) {
    return undefined;
  }
  return readNonBlankString(event, REQUEST_KEY_ATTRIBUTE);
}

/**
 * A number that can safely take part in arithmetic and ordering.
 *
 * `NaN` and `±Infinity` are the two values that would spread from one bad event
 * through a group's totals and make its sort order non-deterministic, so they
 * become zero here rather than propagating.
 */
function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * The path component of an already-redacted URL, by string scan.
 *
 * `new URL()` is deliberately not used, for the reasons `../redaction/url.ts`
 * documents: it normalises percent-encoding, lower-cases the host, drops
 * default ports and either throws on or invents an origin for a relative
 * reference. Any of those would make the derived path disagree with the stored
 * display string, and both travel to the panel together.
 *
 * The scan is the whole algorithm:
 *
 * - cut at whichever of `?` or `#` appears first, since a fragment may precede
 *   a literal `?` inside it;
 * - drop a leading `scheme://authority` or protocol-relative `//authority`,
 *   leaving everything from the first `/` of the path;
 * - if such an authority has no path at all (`http://host:8080`), return the
 *   empty string rather than inventing `/`: the group's identity should reflect
 *   what was observed, and `url` remains the faithful display string;
 * - anything without a recognisable scheme — an already-relative
 *   `/api/items`, or an opaque `data:` reference — is returned as it stands.
 */
function pathOfUrl(url: string): string {
  const queryIndex = url.indexOf('?');
  const fragmentIndex = url.indexOf('#');
  let end = url.length;
  if (queryIndex >= 0) {
    end = Math.min(end, queryIndex);
  }
  if (fragmentIndex >= 0) {
    end = Math.min(end, fragmentIndex);
  }
  const withoutQuery = url.slice(0, end);

  let authorityStart = -1;
  const separatorIndex = withoutQuery.indexOf(SCHEME_SEPARATOR);
  if (separatorIndex > 0 && SCHEME_PATTERN.test(withoutQuery.slice(0, separatorIndex))) {
    authorityStart = separatorIndex + SCHEME_SEPARATOR.length;
  } else if (withoutQuery.startsWith('//')) {
    authorityStart = '//'.length;
  }
  if (authorityStart < 0) {
    return withoutQuery;
  }

  const pathStart = withoutQuery.indexOf('/', authorityStart);
  return pathStart >= 0 ? withoutQuery.slice(pathStart) : '';
}

/** `req:k:<key>` — the keyed group id space. */
function groupIdForRequestKey(requestKey: string): string {
  return `${GROUP_ID_PREFIX}:k:${requestKey}`;
}

/**
 * `req:m:<method>:<path>` — the fallback group id space.
 *
 * The `k`/`m` segment keeps the two spaces disjoint, so neither a crafted
 * method nor a crafted path can produce the id of a keyed group.
 */
function groupIdForMethodPath(method: string, path: string): string {
  return `${GROUP_ID_PREFIX}:m:${method}:${path}`;
}

/**
 * Whether an occurrence failed: an error status code, or an error span status.
 *
 * A pending occurrence never failed — nothing had come back when it was
 * observed — so it is excluded before either test, whatever span status its
 * producer reported (see the header's "Pending requests").
 */
function isFailedOccurrence(occurrence: RequestOccurrence): boolean {
  if (occurrence.pending === true) {
    return false;
  }
  if (occurrence.statusCode !== undefined && occurrence.statusCode >= HTTP_ERROR_STATUS_FLOOR) {
    return true;
  }
  return occurrence.status === 'error';
}

/**
 * Mutable state for one group while the event list is being walked.
 *
 * Internal to this module and never exported: the published shape is
 * {@link RequestGroup}, whose every field is `readonly`.
 */
interface GroupAccumulator {
  readonly id: string;
  readonly groupedBy: RequestGroupedBy;
  readonly requestKey: string | undefined;
  /** Method, URL and path of the canonically earliest occurrence seen so far. */
  method: string;
  url: string;
  path: string;
  representativeStartTime: number;
  representativeId: EventId;
  readonly occurrences: RequestOccurrence[];
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  firstStartTime: number;
  lastStartTime: number;
  readonly statusCodes: Set<number>;
  errorCount: number;
  /** Pending occurrences merged so far; published only when above zero. */
  pendingCount: number;
  readonly initiators: Set<string>;
  /** Stays `undefined` until an occurrence actually has a size. */
  transferredBytes: number | undefined;
  /**
   * Resource-timing events this group's occurrences claimed.
   *
   * Collected here rather than read back off the published occurrence list,
   * which the caller's bound may have truncated or omitted.
   */
  readonly transferEventIds: Set<EventId>;
}

/**
 * An empty accumulator.
 *
 * The neutral extremes are deliberate: the first merged occurrence wins every
 * comparison, so creation and merging share one code path instead of the
 * first event taking a special one.
 */
function createAccumulator(
  id: string,
  groupedBy: RequestGroupedBy,
  requestKey: string | undefined,
): GroupAccumulator {
  return {
    id,
    groupedBy,
    requestKey,
    method: UNKNOWN_METHOD_LABEL,
    url: UNKNOWN_URL_LABEL,
    path: UNKNOWN_URL_LABEL,
    representativeStartTime: Number.POSITIVE_INFINITY,
    representativeId: '',
    occurrences: [],
    totalDurationMs: 0,
    minDurationMs: Number.POSITIVE_INFINITY,
    maxDurationMs: Number.NEGATIVE_INFINITY,
    firstStartTime: Number.POSITIVE_INFINITY,
    lastStartTime: Number.NEGATIVE_INFINITY,
    statusCodes: new Set<number>(),
    errorCount: 0,
    pendingCount: 0,
    initiators: new Set<string>(),
    transferredBytes: undefined,
    transferEventIds: new Set<EventId>(),
  };
}

/** Whether an occurrence precedes the group's current representative. */
function isEarlierThanRepresentative(
  occurrence: RequestOccurrence,
  accumulator: GroupAccumulator,
): boolean {
  if (occurrence.startTime !== accumulator.representativeStartTime) {
    return occurrence.startTime < accumulator.representativeStartTime;
  }
  return compareStrings(occurrence.id, accumulator.representativeId) < 0;
}

/** Fold one occurrence into its group. */
function mergeOccurrence(
  accumulator: GroupAccumulator,
  occurrence: RequestOccurrence,
  method: string,
  url: string,
  path: string,
): void {
  accumulator.occurrences.push(occurrence);
  accumulator.totalDurationMs += occurrence.durationMs;

  if (occurrence.durationMs < accumulator.minDurationMs) {
    accumulator.minDurationMs = occurrence.durationMs;
  }
  if (occurrence.durationMs > accumulator.maxDurationMs) {
    accumulator.maxDurationMs = occurrence.durationMs;
  }
  if (occurrence.startTime < accumulator.firstStartTime) {
    accumulator.firstStartTime = occurrence.startTime;
  }
  if (occurrence.startTime > accumulator.lastStartTime) {
    accumulator.lastStartTime = occurrence.startTime;
  }
  if (occurrence.statusCode !== undefined) {
    accumulator.statusCodes.add(occurrence.statusCode);
  }
  if (isFailedOccurrence(occurrence)) {
    accumulator.errorCount += 1;
  }
  if (occurrence.pending === true) {
    accumulator.pendingCount += 1;
  }
  if (occurrence.initiator !== undefined) {
    accumulator.initiators.add(occurrence.initiator);
  }
  if (occurrence.transferredBytes !== undefined) {
    accumulator.transferredBytes =
      (accumulator.transferredBytes ?? 0) + occurrence.transferredBytes;
  }
  if (occurrence.transferEventId !== undefined) {
    accumulator.transferEventIds.add(occurrence.transferEventId);
  }
  if (isEarlierThanRepresentative(occurrence, accumulator)) {
    accumulator.method = method;
    accumulator.url = url;
    accumulator.path = path;
    accumulator.representativeStartTime = occurrence.startTime;
    accumulator.representativeId = occurrence.id;
  }
}

/**
 * Sweep a group's occurrences into duplicate windows.
 *
 * The rule is **cluster-anchor**, not neighbour chaining: an occurrence joins
 * the open cluster when it starts within `duplicateWindowMs` of that cluster's
 * *first* occurrence, and opens a new cluster otherwise. Chaining from each
 * neighbour instead would let a long tail of slowly repeating requests — one
 * every 900 ms for a minute, say — merge into a single window and be reported
 * as a burst of duplicates, which is the opposite of the finding. The boundary
 * is inclusive: an occurrence exactly `duplicateWindowMs` after the anchor
 * still joins.
 *
 * Only clusters holding two or more occurrences become windows, but every
 * cluster consumes an ordinal, so a window's id stays stable when an earlier
 * singleton gains a partner in a later capture.
 *
 * @param ordered occurrences already in canonical order.
 */
function buildDuplicateWindows(
  groupId: string,
  ordered: readonly RequestOccurrence[],
  duplicateWindowMs: number,
): readonly DuplicateWindow[] {
  const windows: DuplicateWindow[] = [];
  let clusterStart = 0;
  let clusterOrdinal = 0;

  while (clusterStart < ordered.length) {
    const anchor = ordered[clusterStart];
    if (anchor === undefined) {
      break;
    }

    let clusterEnd = clusterStart + 1;
    while (clusterEnd < ordered.length) {
      const candidate = ordered[clusterEnd];
      if (candidate === undefined) {
        break;
      }
      if (candidate.startTime - anchor.startTime > duplicateWindowMs) {
        break;
      }
      clusterEnd += 1;
    }

    const cluster = ordered.slice(clusterStart, clusterEnd);
    const last = cluster[cluster.length - 1];
    if (cluster.length > 1 && last !== undefined) {
      windows.push({
        id: `${groupId}#w${clusterOrdinal}`,
        startTime: anchor.startTime,
        endTime: last.startTime,
        count: cluster.length,
        redundantCount: cluster.length - 1,
        eventIds: cluster.map((occurrence) => occurrence.eventId),
      });
    }

    clusterOrdinal += 1;
    clusterStart = clusterEnd;
  }

  return windows;
}

/** Turn a finished accumulator into its published group. */
function finalizeGroup(
  accumulator: GroupAccumulator,
  duplicateWindowMs: number,
  maxOccurrences: number,
): RequestGroup {
  const ordered = [...accumulator.occurrences].sort(compareOccurrences);
  const count = ordered.length;

  // Windows and counts are computed over every occurrence, so truncating the
  // exposed list can never change the duplicate evidence.
  const duplicateWindows = buildDuplicateWindows(accumulator.id, ordered, duplicateWindowMs);
  let duplicateCount = 0;
  for (const duplicateWindow of duplicateWindows) {
    duplicateCount += duplicateWindow.redundantCount;
  }

  const occurrences = maxOccurrences >= count ? ordered : ordered.slice(0, maxOccurrences);
  const totalDurationMs = roundMs(accumulator.totalDurationMs);

  return {
    id: accumulator.id,
    ...(accumulator.requestKey !== undefined ? { requestKey: accumulator.requestKey } : {}),
    groupedBy: accumulator.groupedBy,
    method: accumulator.method,
    url: accumulator.url,
    path: accumulator.path,
    count,
    duplicateCount,
    hasDuplicates: duplicateCount > 0,
    duplicateWindows,
    firstStartTime: finiteOrZero(accumulator.firstStartTime),
    lastStartTime: finiteOrZero(accumulator.lastStartTime),
    totalDurationMs,
    averageDurationMs: count > 0 ? roundMs(totalDurationMs / count) : 0,
    maxDurationMs: finiteOrZero(accumulator.maxDurationMs),
    minDurationMs: finiteOrZero(accumulator.minDurationMs),
    statusCodes: [...accumulator.statusCodes].sort((left, right) => left - right),
    errorCount: accumulator.errorCount,
    // Counted in `mergeOccurrence` over every occurrence, so the truncation of
    // the published list above cannot change it; absent when zero, which keeps
    // every group without a pending request exactly the shape it always had.
    ...(accumulator.pendingCount > 0 ? { pendingCount: accumulator.pendingCount } : {}),
    initiators: [...accumulator.initiators].sort(compareStrings),
    ...(accumulator.transferredBytes !== undefined
      ? { transferredBytes: Math.round(accumulator.transferredBytes) }
      : {}),
    ...(accumulator.transferEventIds.size > 0
      ? { transferEventIds: [...accumulator.transferEventIds].sort(compareStrings) }
      : {}),
    occurrences,
    occurrencesTruncated: occurrences.length < count,
  };
}

/** Resolve the duplicate window, falling back on an unusable value. */
function resolveDuplicateWindowMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_DUPLICATE_WINDOW_MS;
  }
  return value;
}

/** Resolve the join tolerance, falling back on an unusable value. */
function resolveResourceTimingToleranceMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_RESOURCE_TIMING_TOLERANCE_MS;
  }
  return value;
}

/** Resolve the occurrence bound, falling back on an unusable value. */
function resolveMaxOccurrences(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_OCCURRENCES_PER_GROUP;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/** Whether an event is one of the kinds this aggregate reports on. */
function isRequestEvent(event: TelemetryEvent): boolean {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  return REQUEST_KINDS.includes(event.kind);
}

/*
 * ---------------------------------------------------------------------------
 * Internals: the resource-timing join
 *
 * The header states the four rules; this section is their implementation and
 * nothing else. It reads only already-redacted attributes, mints no id, and is
 * a pure function of the event list.
 *
 * ## The selection rule
 *
 * For each settled occurrence, in canonical order, the join claims the
 * qualifying unclaimed candidate with the lexicographically smallest
 * `(initiator rank, |candidate start − occurrence start|, event id)`, and among
 * candidates equal on all three the one met first — earlier identity, then
 * earlier position in that identity's `(startTime, eventId)` order. That is
 * the rule a scan of every candidate applies; what follows reaches the same
 * answer without the scan.
 *
 * ## How it is found: O((r + c) · log c)
 *
 * A capture with many requests to one URL — the duplicate-request case this
 * module exists to report — would make a per-occurrence scan of the URL's
 * candidates cost O(r · c) for r requests and c entries: the service feeds the
 * `requests` source up to 50 000 events, and 25 000 requests to one URL
 * against 25 000 entries measured four to ten seconds of synchronous work on
 * the service's event loop that way. The join therefore indexes each identity
 * bucket once:
 *
 * - **Sets by transport.** A bucket is split into one set per stated
 *   `initiator.type` (an unstated type is a set of its own), plus the set of
 *   every candidate, each kept in the bucket's `(startTime, eventId)` order.
 *   The initiator rank then selects whole sets instead of testing candidates:
 *   a request whose transport has a type searches that type's set at rank 0
 *   and the unstated set at rank 1; one whose transport has none searches the
 *   unstated set at rank 0 and the set of every candidate at rank 1, which is
 *   only reached when no rank-0 candidate was found, so every candidate it can
 *   return is genuinely rank 1. A foreign stated type is never searched, which
 *   is the rejection {@link eligibleCandidateSets} documents.
 * - **Binary search for the window.** Within a set, the timing window is the
 *   contiguous run of positions whose start lies in `[earliest, latest]`, and
 *   the occurrence's own start splits it into a left half (earlier starts) and
 *   a right half (the same or later starts). On each half the distance is
 *   monotonic in position, so the nearest unclaimed candidate on either side
 *   is the first unclaimed position walking outward from the split.
 * - **Skip pointers for claims.** "The first unclaimed position at or after
 *   i" and "the last unclaimed position at or before i" are two union-find
 *   forests with path compression: claiming a position links it to its
 *   neighbour, so a run of claimed entries costs amortised O(log c) to cross
 *   however long it grows, rather than a visit per entry.
 * - **A range minimum for ties.** Distances are computed in floating point,
 *   so two distinct starts can round to one distance (a start of `1e-20` and
 *   one of `2e-20` are both exactly `1` from a start of `1`). The candidates
 *   tied with the nearest one therefore form a contiguous run found by a
 *   second binary search — not merely the run sharing its start — and the
 *   smallest event id among that run's unclaimed members comes from a segment
 *   tree over event-id ranks in which a claimed position holds no rank.
 *
 * Each occurrence costs O(log c) per searched set (at most two per identity,
 * at most two identities) and each claim O(log c) per set holding the
 * candidate, so the join is O((r + c) · log c) overall, plus the sort that
 * orders each bucket. Search structures are built only for a set some
 * occurrence actually searches, which is what keeps the scripts, images and
 * stylesheets no request names from costing more than their sort.
 * ---------------------------------------------------------------------------
 */

/**
 * The kind of the event a resource load arrives as.
 *
 * Named because the performance kind group holds both a long task and a
 * performance entry and only the latter can describe a response;
 * {@link isResourceTimingEvent} still selects *through* the group, so a kind
 * that leaves it can never be joined.
 */
const PERF_ENTRY_KIND: TelemetryKind = 'perf.entry';

/** The request kind whose loads Resource Timing labels `fetch`. */
const FETCH_KIND: TelemetryKind = 'fetch';

/** The request kind whose loads Resource Timing labels `xmlhttprequest`. */
const XHR_KIND: TelemetryKind = 'xhr';

/**
 * The `initiator.type` a resource entry carries for each request transport.
 *
 * Hosts agree on these two spellings, so a *stated* type that is neither of
 * them describes a different load of the same URL — a `<link rel="preload">`,
 * a `<script>`, an image — and {@link eligibleCandidateSets} rejects it outright
 * rather than accepting it as a last resort: attributing a preload's bytes to
 * a fetch is a wrong number, which is worse than the honest absence AAP 0.6.6
 * provides for. An entry that states **no** type is still eligible, because a
 * redirect chain, a service-worker response and a shimmed host all produce
 * one, and refusing those would lose a join identity and timing had already
 * established.
 */
const RESOURCE_INITIATOR_TYPE_BY_KIND: ReadonlyMap<TelemetryKind, string> = new Map([
  [FETCH_KIND, 'fetch'],
  [XHR_KIND, 'xmlhttprequest'],
]);

/**
 * One resource-timing entry offered to the join, as read from its event.
 *
 * Only entries that measured something are collected: an entry with no
 * readable URL cannot be matched and an entry with no exposed bytes has
 * nothing to contribute, so admitting either would only let it be claimed —
 * and a claim's purpose is to stop a *measured* response being counted twice.
 */
interface ResourceTimingEntry {
  /** The event the entry arrived as. */
  readonly eventId: EventId;
  /** The entry's URL, already redacted: the join's identity. */
  readonly url: string;
  /** Start of the load, in epoch milliseconds. */
  readonly startTime: number;
  /** The `initiator.type` the host reported, when it reported one. */
  readonly initiatorType: string | undefined;
  /** The measured bytes; always present by construction. */
  readonly bytes: number;
}

/**
 * A resource entry placed in its identity bucket, with the two positions the
 * search structures address it by.
 */
interface ResourceTimingCandidate extends ResourceTimingEntry {
  /**
   * Position in the bucket's `(startTime, eventId)` order, which is also its
   * position in {@link ResourceTimingBucket.everyCandidate}. The selection
   * rule's last tie-break, after identity order.
   */
  readonly bucketIndex: number;
  /** Position in the bucket's set for this candidate's stated initiator type. */
  readonly initiatorTypeIndex: number;
  /**
   * Set once the entry has been attributed to an occurrence; never cleared.
   * The flag is the truth a lazily built search index starts from, while each
   * built index mirrors it in its own skip pointers and rank tree.
   */
  claimed: boolean;
}

/**
 * The search structures over one {@link CandidateSet}, built on first use.
 *
 * Typed arrays rather than object graphs: every field is a flat column
 * addressed by position, which is what makes the binary searches, the
 * union-find walks and the tree updates allocation-free.
 */
interface CandidateSearchIndex {
  /** Each member's start, by position: the key every binary search reads. */
  readonly startTimes: Float64Array;
  /**
   * The "first unclaimed position at or after i" forest: slot `i` is position
   * `i`, and slot `members.length` is the always-unclaimed sentinel meaning
   * "none". A claimed position points at its successor.
   */
  readonly nextParents: Int32Array;
  /**
   * The "last unclaimed position at or before i" forest, shifted by one so the
   * sentinel can sit at slot 0: slot `i + 1` is position `i`, and a claimed
   * position points at its predecessor's slot.
   */
  readonly previousParents: Int32Array;
  /**
   * The member holding each event-id rank. Ranks order positions by event id,
   * then by position, so the smallest rank in a range is exactly the member
   * the selection rule prefers among equally distant candidates.
   */
  readonly positionsByRank: Int32Array;
  /**
   * A bottom-up segment tree of the minimum rank per subtree: leaf
   * `leafCount + i` holds position `i`'s rank, or
   * {@link UNAVAILABLE_RANK} once that position is claimed.
   */
  readonly minRankTree: Int32Array;
  /** The number of leaves: the smallest power of two covering every member. */
  readonly leafCount: number;
}

/** Some of one bucket's candidates, in bucket order, with their search index. */
interface CandidateSet {
  /** Members in ascending `(startTime, eventId)` order. */
  readonly members: readonly ResourceTimingCandidate[];
  /** Built by the first search that reaches this set; `undefined` until then. */
  search: CandidateSearchIndex | undefined;
}

/**
 * Every candidate that shares one identity, viewed the two ways the initiator
 * rank needs: all together, and split by stated `initiator.type`.
 *
 * A candidate belongs to {@link everyCandidate} and to exactly one set of
 * {@link byInitiatorType}; claiming it withdraws it from both.
 */
interface ResourceTimingBucket {
  /** Every candidate of the identity. */
  readonly everyCandidate: CandidateSet;
  /**
   * The candidates of each stated `initiator.type`; the `undefined` key holds
   * those that stated none.
   */
  readonly byInitiatorType: ReadonlyMap<string | undefined, CandidateSet>;
}

/**
 * The rank a claimed position holds in {@link CandidateSearchIndex.minRankTree}.
 *
 * Larger than any real rank, since a set never holds 2³¹ − 1 members, so a
 * range minimum equal to it means the range holds nothing unclaimed.
 */
const UNAVAILABLE_RANK = 0x7fffffff;

/** Whether an event is a resource load this join can read. */
function isResourceTimingEvent(event: TelemetryEvent): boolean {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  if (!PERF_KINDS.includes(event.kind) || event.kind !== PERF_ENTRY_KIND) {
    return false;
  }

  // A labelled paint mark is excluded; an unlabelled entry is admitted,
  // because a producer that omits the label but reports an exposed size has
  // still measured a response.
  const entryType = readAttribute(event, ENTRY_TYPE_ATTRIBUTE);
  return entryType === undefined || entryType === RESOURCE_ENTRY_TYPE;
}

/** Bucket order: start time, then event id; the sort is stable beyond that. */
function compareResourceTimingEntries(
  left: ResourceTimingEntry,
  right: ResourceTimingEntry,
): number {
  if (left.startTime !== right.startTime) {
    return left.startTime < right.startTime ? -1 : 1;
  }
  return compareStrings(left.eventId, right.eventId);
}

/**
 * Place one identity's sorted entries into a bucket: the set of every
 * candidate and one set per stated initiator type, all in bucket order.
 *
 * Only the member lists are built here, in one linear pass; the search index
 * of each set waits for the first occurrence that searches it.
 */
function createResourceTimingBucket(sorted: readonly ResourceTimingEntry[]): ResourceTimingBucket {
  const every: ResourceTimingCandidate[] = [];
  const membersByType = new Map<string | undefined, ResourceTimingCandidate[]>();

  for (const [bucketIndex, entry] of sorted.entries()) {
    let typed = membersByType.get(entry.initiatorType);
    if (typed === undefined) {
      typed = [];
      membersByType.set(entry.initiatorType, typed);
    }
    const candidate: ResourceTimingCandidate = {
      ...entry,
      bucketIndex,
      initiatorTypeIndex: typed.length,
      claimed: false,
    };
    typed.push(candidate);
    every.push(candidate);
  }

  const byInitiatorType = new Map<string | undefined, CandidateSet>();
  for (const [initiatorType, members] of membersByType) {
    byInitiatorType.set(initiatorType, { members, search: undefined });
  }
  return { everyCandidate: { members: every, search: undefined }, byInitiatorType };
}

/**
 * Index the capture's resource entries by identity.
 *
 * Each bucket is sorted by start time, then by event id — stably, so entries
 * equal on both keep their arrival order — and every position the join
 * addresses is taken from that order, so the candidate a given occurrence
 * sees first does not depend on the order the events arrived in beyond what
 * the two keys cannot tell apart.
 */
function collectResourceTimings(
  events: readonly TelemetryEvent[],
): Map<string, ResourceTimingBucket> {
  const entriesByUrl = new Map<string, ResourceTimingEntry[]>();

  for (const event of events) {
    if (!isResourceTimingEvent(event)) {
      continue;
    }
    const url = readNonBlankString(event, RESOURCE_URL_ATTRIBUTE);
    if (url === undefined) {
      continue;
    }
    const bytes = readExposedTransferSize(event);
    if (bytes === undefined) {
      continue;
    }

    const entry: ResourceTimingEntry = {
      eventId: event.id,
      url,
      startTime: finiteOrZero(event.startTime),
      initiatorType: readNonBlankString(event, INITIATOR_TYPE_ATTRIBUTE),
      bytes,
    };

    const entries = entriesByUrl.get(url);
    if (entries === undefined) {
      entriesByUrl.set(url, [entry]);
      continue;
    }
    entries.push(entry);
  }

  const buckets = new Map<string, ResourceTimingBucket>();
  for (const [url, entries] of entriesByUrl) {
    entries.sort(compareResourceTimingEntries);
    buckets.set(url, createResourceTimingBucket(entries));
  }
  return buckets;
}

/**
 * The identities one request may appear under in the timing buffer, in
 * preference order.
 *
 * The resolved absolute URL first, because that is what the browser names the
 * entry with; the as-written URL second, which matches only when the
 * application already wrote an absolute one, and is the fallback for a
 * producer that predates the resolved key. A duplicate between the two is
 * dropped so a candidate bucket is never searched twice.
 */
function resourceIdentitiesOf(event: TelemetryEvent, url: string | undefined): string[] {
  const identities: string[] = [];
  const resolved = readNonBlankString(event, RESOURCE_TIMING_URL_ATTRIBUTE);
  if (resolved !== undefined) {
    identities.push(resolved);
  }
  if (url !== undefined && url !== resolved) {
    identities.push(url);
  }
  return identities;
}

/** A set of one bucket that an occurrence may claim from, at the rank it confers. */
interface EligibleCandidateSet {
  /** The initiator rank every member of {@link set} has for the occurrence; lower wins. */
  readonly initiatorRank: number;
  /** The candidates concerned. */
  readonly set: CandidateSet;
}

/**
 * The sets of one bucket an occurrence may claim from, best rank first.
 *
 * The initiator type decides eligibility before it decides order. A candidate
 * that states a type the request's transport never produces is **rejected** —
 * it is a different load of the same URL, and crediting its bytes to this
 * request would publish a wrong number where AAP 0.6.6 provides for an honest
 * absence — so its set is simply never offered. A candidate whose type
 * matches outranks one that states none, which is what keeps a
 * `<link rel="preload">`-free page from having its fetch matched to an
 * unlabelled entry when its own labelled entry is present. Within a rank the
 * closest start wins, which is the only ordering that behaves correctly when
 * a page issues the same request twice in quick succession.
 *
 * Stated as sets rather than as a per-candidate test, the rule is:
 *
 * - transport type `E` known: the `E` set at rank 0, the unstated set at
 *   rank 1, every other stated type rejected;
 * - transport type unknown: the unstated set at rank 0 (its type equals the
 *   expected one, both being absent) and every stated type at rank 1, offered
 *   as the set of every candidate. The caller searches that set only while no
 *   rank-0 candidate has been found, and a rank-0 search of this same bucket
 *   finding nothing means none of its unclaimed candidates in the window is
 *   unstated, so whatever the set of every candidate returns is a stated type.
 */
function eligibleCandidateSets(
  bucket: ResourceTimingBucket,
  expectedInitiatorType: string | undefined,
): readonly EligibleCandidateSet[] {
  const eligible: EligibleCandidateSet[] = [];
  const unstated = bucket.byInitiatorType.get(undefined);

  if (expectedInitiatorType === undefined) {
    if (unstated !== undefined) {
      eligible.push({ initiatorRank: 0, set: unstated });
    }
    eligible.push({ initiatorRank: 1, set: bucket.everyCandidate });
    return eligible;
  }

  const matching = bucket.byInitiatorType.get(expectedInitiatorType);
  if (matching !== undefined) {
    eligible.push({ initiatorRank: 0, set: matching });
  }
  if (unstated !== undefined) {
    eligible.push({ initiatorRank: 1, set: unstated });
  }
  return eligible;
}

/**
 * How far a candidate started from the occurrence, in milliseconds.
 *
 * The one distance formula of the join — `|candidate − occurrence|`, in that
 * operand order — used for ranking, for the binary searches and for ties
 * alike, so no two readings of "equally close" can disagree by a rounding.
 */
function startDistance(candidateStartTime: number, occurrenceStartTime: number): number {
  return Math.abs(candidateStartTime - occurrenceStartTime);
}

/**
 * An element of a typed column at a position the caller derived from that
 * column's own length.
 *
 * `noUncheckedIndexedAccess` types every indexed read as possibly
 * `undefined`. The join never reads out of range, so `fallback` is never
 * observed; it keeps each read total without an assertion.
 */
function slotAt(column: Int32Array | Float64Array, position: number, fallback: number): number {
  return column[position] ?? fallback;
}

/** The first position in `[from, to)` whose start is at or after `value`; `to` when none is. */
function firstStartAtOrAfter(
  startTimes: Float64Array,
  value: number,
  from: number,
  to: number,
): number {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (slotAt(startTimes, middle, value) < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** The first position in `[from, to)` whose start is after `value`; `to` when none is. */
function firstStartAfter(
  startTimes: Float64Array,
  value: number,
  from: number,
  to: number,
): number {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (slotAt(startTimes, middle, value) <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * The first position in `[from, to]` no further than `distance` from `origin`,
 * where distance does not increase along the range and `to` qualifies.
 */
function firstWithinDistance(
  startTimes: Float64Array,
  origin: number,
  distance: number,
  from: number,
  to: number,
): number {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (startDistance(slotAt(startTimes, middle, origin), origin) <= distance) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return high;
}

/**
 * The last position in `[from, to]` no further than `distance` from `origin`,
 * where distance does not decrease along the range and `from` qualifies.
 */
function lastWithinDistance(
  startTimes: Float64Array,
  origin: number,
  distance: number,
  from: number,
  to: number,
): number {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    if (startDistance(slotAt(startTimes, middle, origin), origin) <= distance) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/**
 * The root of `slot` in a skip forest, compressing the path walked.
 *
 * A root is a slot that is its own parent: an unclaimed position, or the
 * sentinel. Pointing every visited slot straight at the root is what keeps a
 * long run of claimed positions from being walked twice.
 */
function findRoot(parents: Int32Array, slot: number): number {
  let root = slot;
  let parent = slotAt(parents, root, root);
  while (parent !== root) {
    root = parent;
    parent = slotAt(parents, root, root);
  }

  let node = slot;
  while (node !== root) {
    const next = slotAt(parents, node, root);
    parents[node] = root;
    node = next;
  }
  return root;
}

/** The first unclaimed position at or after `position`; the member count when there is none. */
function nextUnclaimed(search: CandidateSearchIndex, position: number): number {
  return findRoot(search.nextParents, position);
}

/** The last unclaimed position at or before `position`; `-1` when there is none. */
function previousUnclaimed(search: CandidateSearchIndex, position: number): number {
  return findRoot(search.previousParents, position + 1) - 1;
}

/** Recompute the tree ancestors of `node` after its value changed. */
function refreshMinRankAncestors(tree: Int32Array, node: number): void {
  let parent = Math.floor(node / 2);
  while (parent >= 1) {
    tree[parent] = Math.min(
      slotAt(tree, 2 * parent, UNAVAILABLE_RANK),
      slotAt(tree, 2 * parent + 1, UNAVAILABLE_RANK),
    );
    parent = Math.floor(parent / 2);
  }
}

/**
 * Withdraw a claimed position from one search index: link it out of both
 * skip forests and give its leaf no rank.
 */
function withdrawPosition(search: CandidateSearchIndex, position: number): void {
  search.nextParents[position] = position + 1;
  search.previousParents[position + 1] = position;
  const leaf = search.leafCount + position;
  search.minRankTree[leaf] = UNAVAILABLE_RANK;
  refreshMinRankAncestors(search.minRankTree, leaf);
}

/**
 * Build the search index of a set's members.
 *
 * O(m log m) for the event-id ranking and O(m) for everything else. A member
 * already claimed through the bucket's other set is withdrawn as its leaf is
 * written, so an index built late agrees with one built at the start.
 */
function buildCandidateSearchIndex(
  members: readonly ResourceTimingCandidate[],
): CandidateSearchIndex {
  const count = members.length;
  let leafCount = 1;
  while (leafCount < count) {
    leafCount *= 2;
  }

  const startTimes = new Float64Array(count);
  const nextParents = new Int32Array(count + 1);
  const previousParents = new Int32Array(count + 1);
  const positionsByRank = new Int32Array(count);
  const minRankTree = new Int32Array(2 * leafCount).fill(UNAVAILABLE_RANK);

  for (let slot = 0; slot <= count; slot += 1) {
    nextParents[slot] = slot;
    previousParents[slot] = slot;
  }

  const byEventId = members
    .map((member, position) => ({ eventId: member.eventId, position }))
    .sort((left, right) => {
      const order = compareStrings(left.eventId, right.eventId);
      return order !== 0 ? order : left.position - right.position;
    });

  for (const [rank, { position }] of byEventId.entries()) {
    positionsByRank[rank] = position;
    minRankTree[leafCount + position] = rank;
  }
  for (const [position, member] of members.entries()) {
    startTimes[position] = member.startTime;
    if (member.claimed) {
      nextParents[position] = position + 1;
      previousParents[position + 1] = position;
      minRankTree[leafCount + position] = UNAVAILABLE_RANK;
    }
  }
  for (let node = leafCount - 1; node >= 1; node -= 1) {
    minRankTree[node] = Math.min(
      slotAt(minRankTree, 2 * node, UNAVAILABLE_RANK),
      slotAt(minRankTree, 2 * node + 1, UNAVAILABLE_RANK),
    );
  }

  return { startTimes, nextParents, previousParents, positionsByRank, minRankTree, leafCount };
}

/** A set's search index, building it on the first search that needs it. */
function searchIndexOf(set: CandidateSet): CandidateSearchIndex {
  if (set.search === undefined) {
    set.search = buildCandidateSearchIndex(set.members);
  }
  return set.search;
}

/**
 * The unclaimed member of `[from, to]` with the smallest event id — the
 * smallest position among equal ids — or `undefined` when all are claimed.
 */
function lowestRankedBetween(
  set: CandidateSet,
  search: CandidateSearchIndex,
  from: number,
  to: number,
): ResourceTimingCandidate | undefined {
  const tree = search.minRankTree;
  let rank = UNAVAILABLE_RANK;
  let left = from + search.leafCount;
  let right = to + search.leafCount + 1;
  while (left < right) {
    if (left % 2 === 1) {
      rank = Math.min(rank, slotAt(tree, left, UNAVAILABLE_RANK));
      left += 1;
    }
    if (right % 2 === 1) {
      right -= 1;
      rank = Math.min(rank, slotAt(tree, right, UNAVAILABLE_RANK));
    }
    left = Math.floor(left / 2);
    right = Math.floor(right / 2);
  }

  if (rank === UNAVAILABLE_RANK) {
    return undefined;
  }
  return set.members[slotAt(search.positionsByRank, rank, -1)];
}

/** The best candidate one set holds for an occurrence, with its distance. */
interface CandidateMatch {
  readonly candidate: ResourceTimingCandidate;
  readonly distance: number;
}

/** Whether `candidate` beats `current` inside one set: distance, event id, then position. */
function isBetterMatchInSet(candidate: CandidateMatch, current: CandidateMatch): boolean {
  if (candidate.distance !== current.distance) {
    return candidate.distance < current.distance;
  }
  const byEventId = compareStrings(candidate.candidate.eventId, current.candidate.eventId);
  if (byEventId !== 0) {
    return byEventId < 0;
  }
  return candidate.candidate.bucketIndex < current.candidate.bucketIndex;
}

/**
 * The time window a candidate must have started in, and the start it is
 * measured from.
 */
interface ClaimWindow {
  /** The occurrence's start minus the tolerance: the earliest admissible start. */
  readonly earliest: number;
  /** The occurrence's end plus the tolerance: the latest admissible start. */
  readonly latest: number;
  /** The occurrence's start, from which every distance is measured. */
  readonly origin: number;
}

/**
 * The best unclaimed member of one set inside the window — nearest start,
 * then smallest event id, then earliest position — or `undefined`.
 *
 * The window is the position run `[first, last]`, split at `pivot`, the first
 * position starting at or after the origin. Right of the split the distance
 * never decreases with position, left of it it never increases, so on each
 * side the nearest unclaimed member is the first one met walking outward,
 * and every member tied with it lies in one contiguous run that a binary
 * search bounds. The tree then names the tied run's smallest event id.
 * O(log m).
 */
function bestMatchInSet(set: CandidateSet, claimWindow: ClaimWindow): CandidateMatch | undefined {
  const count = set.members.length;
  if (count === 0) {
    return undefined;
  }
  const search = searchIndexOf(set);
  const { startTimes } = search;
  const { origin } = claimWindow;

  const first = firstStartAtOrAfter(startTimes, claimWindow.earliest, 0, count);
  const last = firstStartAfter(startTimes, claimWindow.latest, first, count) - 1;
  if (first > last) {
    return undefined;
  }
  // Searching inside [first, last + 1) clamps the split to the window.
  const pivot = firstStartAtOrAfter(startTimes, origin, first, last + 1);

  let best: CandidateMatch | undefined;

  if (pivot <= last) {
    const nearest = nextUnclaimed(search, pivot);
    if (nearest <= last) {
      const distance = startDistance(slotAt(startTimes, nearest, origin), origin);
      const tiedTo = lastWithinDistance(startTimes, origin, distance, nearest, last);
      const candidate = lowestRankedBetween(set, search, nearest, tiedTo);
      if (candidate !== undefined) {
        best = { candidate, distance };
      }
    }
  }

  if (pivot > first) {
    const nearest = previousUnclaimed(search, pivot - 1);
    if (nearest >= first) {
      const distance = startDistance(slotAt(startTimes, nearest, origin), origin);
      const tiedFrom = firstWithinDistance(startTimes, origin, distance, first, nearest);
      const candidate = lowestRankedBetween(set, search, tiedFrom, nearest);
      if (candidate !== undefined) {
        const match: CandidateMatch = { candidate, distance };
        if (best === undefined || isBetterMatchInSet(match, best)) {
          best = match;
        }
      }
    }
  }

  return best;
}

/**
 * Mark a candidate claimed and withdraw it from every built index that holds
 * it: the bucket's set of every candidate and the set of its stated type.
 */
function markClaimed(bucket: ResourceTimingBucket, candidate: ResourceTimingCandidate): void {
  candidate.claimed = true;
  const everySearch = bucket.everyCandidate.search;
  if (everySearch !== undefined) {
    withdrawPosition(everySearch, candidate.bucketIndex);
  }
  const typedSearch = bucket.byInitiatorType.get(candidate.initiatorType)?.search;
  if (typedSearch !== undefined) {
    withdrawPosition(typedSearch, candidate.initiatorTypeIndex);
  }
}

/**
 * Claim the best unclaimed entry for one occurrence, or nothing.
 *
 * Qualification is identity, timing **and** transport: the entry must sit in
 * one of the occurrence's identity buckets, must have started no earlier than
 * the occurrence's start minus the tolerance and no later than its end plus
 * the tolerance, and must not state an `initiator.type` this transport never
 * produces ({@link eligibleCandidateSets} never offers that one). Among the
 * qualifying entries the smallest `(initiator rank, distance, event id)`
 * wins, and among entries equal on all three the one in the earlier identity,
 * then at the earlier bucket position, so the choice is total. The section
 * header states how that is found in O(log c) per searched set.
 *
 * Claiming mutates only this module's own candidate records and search
 * indexes, never an event.
 */
function claimResourceTiming(
  buckets: ReadonlyMap<string, ResourceTimingBucket>,
  identities: readonly string[],
  kind: TelemetryKind,
  startTime: number,
  endTime: number,
  toleranceMs: number,
): ResourceTimingCandidate | undefined {
  const expectedInitiatorType = RESOURCE_INITIATOR_TYPE_BY_KIND.get(kind);
  const claimWindow: ClaimWindow = {
    earliest: startTime - toleranceMs,
    latest: endTime + toleranceMs,
    origin: startTime,
  };

  let best: (CandidateMatch & { readonly initiatorRank: number }) | undefined;
  let bestBucket: ResourceTimingBucket | undefined;

  for (const identity of identities) {
    const bucket = buckets.get(identity);
    if (bucket === undefined) {
      continue;
    }

    for (const { initiatorRank, set } of eligibleCandidateSets(bucket, expectedInitiatorType)) {
      // A worse rank can never win, so its set is not searched at all; this is
      // also what keeps the set of every candidate from answering at rank 1
      // for a candidate the rank-0 search already found.
      if (best !== undefined && best.initiatorRank < initiatorRank) {
        continue;
      }
      const match = bestMatchInSet(set, claimWindow);
      if (match === undefined) {
        continue;
      }
      // Strictly better only: a tie on rank, distance and event id keeps the
      // match from the earlier identity, which was searched first.
      if (
        best === undefined ||
        initiatorRank < best.initiatorRank ||
        (initiatorRank === best.initiatorRank && match.distance < best.distance) ||
        (initiatorRank === best.initiatorRank &&
          match.distance === best.distance &&
          compareStrings(match.candidate.eventId, best.candidate.eventId) < 0)
      ) {
        best = { ...match, initiatorRank };
        bestBucket = bucket;
      }
    }
  }

  if (best === undefined || bestBucket === undefined) {
    return undefined;
  }
  markClaimed(bestBucket, best.candidate);
  return best.candidate;
}

/**
 * One request occurrence before the join, with what the join needs to run.
 *
 * The occurrence is built in two steps because the join has to consider every
 * request in the capture in one canonical order — a per-group pass would let
 * the grouping decide which request got which response — and because
 * {@link RequestOccurrence} is published `readonly`, so its transfer fields are
 * set at construction rather than patched afterwards.
 *
 * Named *unjoined* rather than anything built on "pending": in this module a
 * pending occurrence is an in-flight snapshot ({@link RequestOccurrence.pending}),
 * and every occurrence — settled or not — passes through this shape.
 */
interface UnjoinedOccurrence {
  /** Everything about the occurrence except the three transfer fields. */
  readonly base: RequestOccurrence;
  /** The group this occurrence belongs to. */
  readonly groupId: string;
  /** How that group's identity was established. */
  readonly groupedBy: RequestGroupedBy;
  /** The group's service-assigned key, when it has one. */
  readonly requestKey: string | undefined;
  /** Method, URL and path as this occurrence reported them. */
  readonly method: string;
  readonly url: string;
  readonly path: string;
  /**
   * The identities this request may appear under in the timing buffer; empty
   * for a pending occurrence, which never joins.
   */
  readonly identities: readonly string[];
  /**
   * The occurrence's own exposed size, when the request event carried one;
   * never read for a pending occurrence, whose response had not arrived.
   */
  readonly ownTransferredBytes: number | undefined;
}

/** Canonical order for the join pass: start time, then the always-distinct id. */
function compareUnjoined(left: UnjoinedOccurrence, right: UnjoinedOccurrence): number {
  if (left.base.startTime !== right.base.startTime) {
    return left.base.startTime < right.base.startTime ? -1 : 1;
  }
  return compareStrings(left.base.id, right.base.id);
}

/**
 * Whether one in-flight snapshot is a later observation of its span than
 * another: the larger `endTime` — the snapshot instant — wins, and the
 * smaller id breaks a tie, so the choice is total and independent of arrival
 * order.
 */
function isLaterSnapshot(candidate: RequestOccurrence, current: RequestOccurrence): boolean {
  if (candidate.endTime !== current.endTime) {
    return candidate.endTime > current.endTime;
  }
  return compareStrings(candidate.id, current.id) < 0;
}

/**
 * Apply the header's supersession rule to every occurrence before the join.
 *
 * A pending snapshot survives only when no settled event shares its
 * `(traceId, spanId)` and it is the latest snapshot of that span; every settled
 * occurrence survives unconditionally, so two settled events that share a span
 * both stay, exactly as they did before snapshots existed.
 *
 * Spans are keyed through nested maps rather than a joined string, so no pair
 * of identifiers can spell another pair and no value is ever converted — the
 * module's never-throws guarantee holds for an identifier of any shape.
 *
 * @param occurrences every occurrence the capture holds, in any order.
 * @returns the survivors, in input order; the input itself when no snapshot is
 * present, which leaves a capture without one exactly as it was.
 */
function supersedeInFlightSnapshots(
  occurrences: readonly UnjoinedOccurrence[],
): readonly UnjoinedOccurrence[] {
  const settledSpans = new Map<TraceId, Set<SpanId>>();
  const latestSnapshots = new Map<TraceId, Map<SpanId, UnjoinedOccurrence>>();
  let snapshotCount = 0;

  for (const occurrence of occurrences) {
    const { traceId, spanId } = occurrence.base;
    if (occurrence.base.pending !== true) {
      let spans = settledSpans.get(traceId);
      if (spans === undefined) {
        spans = new Set<SpanId>();
        settledSpans.set(traceId, spans);
      }
      spans.add(spanId);
      continue;
    }

    snapshotCount += 1;
    let snapshots = latestSnapshots.get(traceId);
    if (snapshots === undefined) {
      snapshots = new Map<SpanId, UnjoinedOccurrence>();
      latestSnapshots.set(traceId, snapshots);
    }
    const current = snapshots.get(spanId);
    if (current === undefined || isLaterSnapshot(occurrence.base, current.base)) {
      snapshots.set(spanId, occurrence);
    }
  }

  if (snapshotCount === 0) {
    return occurrences;
  }

  return occurrences.filter((occurrence) => {
    if (occurrence.base.pending !== true) {
      return true;
    }
    const { traceId, spanId } = occurrence.base;
    if (settledSpans.get(traceId)?.has(spanId) === true) {
      return false;
    }
    return latestSnapshots.get(traceId)?.get(spanId) === occurrence;
  });
}

/**
 * Attach transfer evidence to one unjoined occurrence.
 *
 * The request's own exposed size stays authoritative when it has one — it is
 * the page's account of its own request — but a matching entry is still
 * claimed, because an unclaimed entry is added to `transferred_bytes` by
 * `./summary.ts` and this response has already been counted. When the request
 * reported nothing, which is the ordinary browser case, the claimed entry's
 * bytes become the occurrence's.
 *
 * A pending occurrence is returned as it stands: no response had arrived, so
 * it has no bytes to report and must not claim an entry that belongs to a
 * settled request or to `./summary.ts`'s unattributed total.
 */
function resolveOccurrenceTransfer(
  unjoined: UnjoinedOccurrence,
  buckets: ReadonlyMap<string, ResourceTimingBucket>,
  toleranceMs: number,
): RequestOccurrence {
  if (unjoined.base.pending === true) {
    return unjoined.base;
  }

  const claimed =
    unjoined.identities.length === 0
      ? undefined
      : claimResourceTiming(
          buckets,
          unjoined.identities,
          unjoined.base.kind,
          unjoined.base.startTime,
          unjoined.base.endTime,
          toleranceMs,
        );

  const own = unjoined.ownTransferredBytes;
  if (own === undefined && claimed === undefined) {
    return unjoined.base;
  }

  const bytes = own ?? claimed?.bytes;
  const source: RequestTransferSource = own !== undefined ? 'request' : 'resource-timing';

  return {
    ...unjoined.base,
    ...(bytes !== undefined ? { transferredBytes: bytes, transferSource: source } : {}),
    ...(claimed !== undefined ? { transferEventId: claimed.eventId } : {}),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/**
 * Group a capture's requests and detect duplicates.
 *
 * Only the kinds in the catalog's request group are considered. At the time of
 * writing that group holds the browser's two transports — `fetch` and `xhr` —
 * and deliberately excludes the server's own outgoing requests, because a
 * duplicate there is a different finding with a different remedy. The group is
 * imported rather than spelled out, so a kind added upstream flows through here
 * without a change.
 *
 * Selected events are grouped by {@link RequestGroup.groupedBy}: the
 * service-assigned request key where one is present, `method + path` otherwise.
 * No settled event is dropped — an unreadable method or URL is labelled, not
 * discarded — and no input is mutated. The one event that can be left out is an
 * in-flight snapshot another event of the same span supersedes, by the rule in
 * the header's "Pending requests"; it describes a request that is already
 * reported, so leaving it out loses nothing.
 *
 * The capture's `perf.entry` resource events are read too, but never as
 * requests: they are the join candidates of the header's "transferred bytes
 * arrive by a join", and an entry that matches no request contributes nothing
 * here (`./summary.ts` accounts for those). Three passes, in this order and for
 * this reason: occurrences and candidates are built from the events and
 * superseded snapshots are set aside, then every occurrence in the capture is
 * matched in one canonical order — so the pairing cannot depend on how the
 * events were grouped or on the order they arrived — and only then are the
 * matched occurrences folded into their groups.
 *
 * @param events already-ingested, already-redacted events, in any order.
 * @param options window, tolerance and bounding overrides.
 * @returns a new array in the base order {@link compareGroups} defines.
 */
export function aggregateRequests(
  events: readonly TelemetryEvent[],
  options?: RequestAggregateOptions,
): RequestGroup[] {
  const duplicateWindowMs = resolveDuplicateWindowMs(options?.duplicateWindowMs);
  const maxOccurrences = resolveMaxOccurrences(options?.maxOccurrencesPerGroup);
  const toleranceMs = resolveResourceTimingToleranceMs(options?.resourceTimingToleranceMs);

  // Pass 1 — read every request into an unjoined occurrence, set aside the
  // in-flight snapshots a later observation supersedes, and index the resource
  // entries that measured something.
  const read: UnjoinedOccurrence[] = [];
  for (const event of events) {
    if (!isRequestEvent(event)) {
      continue;
    }

    // Strictly the boolean: see the header's "Pending requests" for why nothing
    // else — least of all a missing status code — makes a request pending.
    const pending = readAttribute(event, REQUEST_IN_FLIGHT_ATTRIBUTE) === true;
    const startTime = finiteOrZero(event.startTime);
    const durationMs = roundMs(clampNonNegative(finiteOrZero(event.duration)));
    const method = readNonBlankString(event, METHOD_ATTRIBUTE) ?? UNKNOWN_METHOD_LABEL;
    const rawUrl = readNonBlankString(event, URL_ATTRIBUTE);
    const url = rawUrl ?? UNKNOWN_URL_LABEL;
    const path = rawUrl === undefined ? UNKNOWN_URL_LABEL : pathOfUrl(rawUrl);
    const requestKey = readRequestKey(event);
    // A snapshot's status code is ignored even when present: no response had
    // arrived, so a code on it would describe something the capture never saw.
    const statusCode = pending ? undefined : readInteger(event, STATUS_CODE_ATTRIBUTE);
    const initiator = readNonBlankString(event, INITIATOR_ATTRIBUTE);

    const base: RequestOccurrence = {
      id: event.id,
      eventId: event.id,
      spanId: event.spanId,
      traceId: event.traceId,
      ...(event.parentSpanId !== undefined ? { parentSpanId: event.parentSpanId } : {}),
      startTime,
      durationMs,
      endTime: roundMs(startTime + durationMs),
      ...(statusCode !== undefined ? { statusCode } : {}),
      status: event.status,
      ...(pending ? { pending: true as const } : {}),
      ...(initiator !== undefined ? { initiator } : {}),
      ...(event.source !== undefined ? { source: event.source } : {}),
      tier: event.tier,
      kind: event.kind,
    };

    const groupedBy: RequestGroupedBy = requestKey === undefined ? 'method-path' : 'request-key';
    read.push({
      base,
      groupId:
        requestKey === undefined
          ? groupIdForMethodPath(method, path)
          : groupIdForRequestKey(requestKey),
      groupedBy,
      requestKey,
      method,
      url,
      path,
      identities: pending ? [] : resourceIdentitiesOf(event, rawUrl),
      ownTransferredBytes: pending ? undefined : readExposedTransferSize(event),
    });
  }
  const unjoined = [...supersedeInFlightSnapshots(read)];
  const resourceTimings = collectResourceTimings(events);

  // Pass 2 — the join, in canonical occurrence order.
  unjoined.sort(compareUnjoined);
  const resolved = unjoined.map((occurrence) => ({
    unjoined: occurrence,
    occurrence: resolveOccurrenceTransfer(occurrence, resourceTimings, toleranceMs),
  }));

  // Pass 3 — fold the joined occurrences into their groups.
  const accumulators = new Map<string, GroupAccumulator>();
  for (const { unjoined: source, occurrence } of resolved) {
    let accumulator = accumulators.get(source.groupId);
    if (accumulator === undefined) {
      accumulator = createAccumulator(source.groupId, source.groupedBy, source.requestKey);
      accumulators.set(source.groupId, accumulator);
    }
    mergeOccurrence(accumulator, occurrence, source.method, source.url, source.path);
  }

  const groups: RequestGroup[] = [];
  for (const accumulator of accumulators.values()) {
    groups.push(finalizeGroup(accumulator, duplicateWindowMs, maxOccurrences));
  }
  groups.sort(compareGroups);
  return groups;
}

/**
 * The `duplicate_request_count` metric: how many requests were redundant.
 *
 * This is the single definition of that metric. `./summary.ts` calls it instead
 * of recomputing a sum of its own, so the number on the metric card and the
 * badges in the request table are arithmetically the same fact — a drift
 * between them would make the panel contradict itself in front of the
 * developer.
 *
 * @param groups groups from {@link aggregateRequests}.
 * @returns the summed redundant occurrences; zero when nothing repeated.
 */
export function countDuplicateRequests(groups: readonly RequestGroup[]): number {
  let total = 0;
  for (const group of groups) {
    const duplicateCount = group.duplicateCount;
    if (Number.isFinite(duplicateCount) && duplicateCount > 0) {
      total += duplicateCount;
    }
  }
  return total;
}
