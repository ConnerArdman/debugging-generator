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

import { FETCH_ATTRIBUTE_KEYS, SERVICE_ASSIGNED_ATTRIBUTE_KEYS } from '../schema/attributes.js';
import type { TelemetryEvent } from '../schema/event.js';
import { REQUEST_KINDS, type TelemetryKind } from '../schema/kinds.js';

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
  /** The initiator label, when the producer reported one. */
  readonly initiator?: string;
  /** Where the request was issued from, when a location could be resolved. */
  readonly source?: SourceLocation;
  /** Bytes over the wire, when the timing entry exposed them. */
  readonly transferredBytes?: number;
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
   * Distinct initiator labels, sorted.
   *
   * Distinctness is load-bearing rather than cosmetic: a duplicate group with
   * *two* initiators is a different finding from one with a single initiator
   * firing twice (AAP 0.8.2), so the set is never collapsed to its first entry.
   */
  readonly initiators: readonly string[];
  /**
   * Summed bytes over the wire, absent unless at least one occurrence reported
   * a size.
   *
   * `transferSize` is exposed for same-origin fetches only (AAP 0.6.6 records
   * this as a known gap), so the field must be able to be missing for the
   * metric card to show "n/a" rather than a misleading zero.
   */
  readonly transferredBytes?: number;
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

/** Whether an occurrence failed: an error status code, or an error span status. */
function isFailedOccurrence(occurrence: RequestOccurrence): boolean {
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
  readonly initiators: Set<string>;
  /** Stays `undefined` until an occurrence actually reports a size. */
  transferredBytes: number | undefined;
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
    initiators: new Set<string>(),
    transferredBytes: undefined,
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
  if (occurrence.initiator !== undefined) {
    accumulator.initiators.add(occurrence.initiator);
  }
  if (occurrence.transferredBytes !== undefined) {
    accumulator.transferredBytes =
      (accumulator.transferredBytes ?? 0) + occurrence.transferredBytes;
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
    initiators: [...accumulator.initiators].sort(compareStrings),
    ...(accumulator.transferredBytes !== undefined
      ? { transferredBytes: Math.round(accumulator.transferredBytes) }
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
 * No event is dropped — an unreadable method or URL is labelled, not discarded —
 * and no input is mutated.
 *
 * @param events already-ingested, already-redacted events, in any order.
 * @param options window and bounding overrides.
 * @returns a new array in the base order {@link compareGroups} defines.
 */
export function aggregateRequests(
  events: readonly TelemetryEvent[],
  options?: RequestAggregateOptions,
): RequestGroup[] {
  const duplicateWindowMs = resolveDuplicateWindowMs(options?.duplicateWindowMs);
  const maxOccurrences = resolveMaxOccurrences(options?.maxOccurrencesPerGroup);
  const accumulators = new Map<string, GroupAccumulator>();

  for (const event of events) {
    if (!isRequestEvent(event)) {
      continue;
    }

    const startTime = finiteOrZero(event.startTime);
    const durationMs = roundMs(clampNonNegative(finiteOrZero(event.duration)));
    const method = readNonBlankString(event, METHOD_ATTRIBUTE) ?? UNKNOWN_METHOD_LABEL;
    const rawUrl = readNonBlankString(event, URL_ATTRIBUTE);
    const url = rawUrl ?? UNKNOWN_URL_LABEL;
    const path = rawUrl === undefined ? UNKNOWN_URL_LABEL : pathOfUrl(rawUrl);
    const requestKey = readRequestKey(event);
    const statusCode = readInteger(event, STATUS_CODE_ATTRIBUTE);
    const initiator = readNonBlankString(event, INITIATOR_ATTRIBUTE);
    const transferredBytes = readNonNegativeNumber(event, TRANSFER_SIZE_ATTRIBUTE);

    const occurrence: RequestOccurrence = {
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
      ...(initiator !== undefined ? { initiator } : {}),
      ...(event.source !== undefined ? { source: event.source } : {}),
      ...(transferredBytes !== undefined ? { transferredBytes } : {}),
      tier: event.tier,
      kind: event.kind,
    };

    const groupedBy: RequestGroupedBy = requestKey === undefined ? 'method-path' : 'request-key';
    const id =
      requestKey === undefined
        ? groupIdForMethodPath(method, path)
        : groupIdForRequestKey(requestKey);

    let accumulator = accumulators.get(id);
    if (accumulator === undefined) {
      accumulator = createAccumulator(id, groupedBy, requestKey);
      accumulators.set(id, accumulator);
    }
    mergeOccurrence(accumulator, occurrence, method, url, path);
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
