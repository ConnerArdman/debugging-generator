/**
 * Tests for `./requests.ts`: request grouping, duplicate windowing and the
 * arithmetic behind the `request_count` and `duplicate_request_count` metrics.
 *
 * ## The one semantic this file exists to pin
 *
 * Grouping is keyed by the service-assigned `request_key` attribute and **never
 * by the URL the event carries**. AAP 0.5.2 states the requirement in its own
 * words: `productId=A` and `productId=B` must stay distinct while
 * byte-identical requests collide — even though both are stored, and displayed,
 * with their parameter values masked. By the time an event reaches an aggregate
 * its query values are already `?`, so grouping on that string would report two
 * unrelated requests as duplicates of each other, and grouping on a *masked*
 * digest would report every request in a capture as one group.
 *
 * `../redaction/request-key.test.ts` holds the producing half of that guarantee
 * (a digest computed from an already-masked URL differs from the real one, and
 * `../redaction/redactor.ts` exempts the key from masking so it survives
 * ingest). This suite is the consuming half: the decisive case below feeds two
 * events whose `url` strings are *byte-identical* and whose keys differ, and
 * requires two groups. Nothing downstream can detect a regression here — a
 * wrong grouping still renders, still badges, still adds up — so it is caught
 * at this layer or not at all.
 *
 * ## What else is asserted, and why each assertion earns its place
 *
 * - **Redundant versus total.** `duplicateCount` counts *redundant*
 *   occurrences (the sum of `count - 1` over the windows), not windows and not
 *   occurrences. `./summary.ts` publishes exactly this number as the
 *   `duplicate_request_count` metric card while the `requestTable` badges the
 *   same groups (AAP 0.6.2), so a drift between the two definitions would make
 *   a generated panel contradict itself in front of the developer.
 *   `countDuplicateRequests` is therefore asserted to equal the summed
 *   `duplicateCount` of the groups it is given, including the zero cases.
 * - **The cluster-anchor rule.** A request issued every 900 ms for a minute is
 *   healthy; four inside 22 ms is the finding (AAP 0.5.4's analysis example).
 *   Those two only stay distinguishable if an occurrence is measured against
 *   its cluster's *anchor* rather than against its predecessor, so the slow
 *   trickle case below asserts the window count and every window boundary —
 *   neighbour chaining would merge the trickle into one burst of six.
 * - **Nothing is lost.** An unreadable method, an unreadable URL, a hostile
 *   attribute getter and a blank key each cost their own field and nothing
 *   else: every case asserts that the summed `count` still equals the number of
 *   request events handed in.
 * - **A total, stable order.** The service pages these groups with
 *   `limit`/`offset` and uses `id` as its stable secondary key (AAP 0.4.2), so
 *   the base order must be total and reproducible. The ordering fixture below
 *   carries a tie at every level, and the determinism case shuffles the input
 *   and requires an identical result — group ids and window ids included.
 * - **Purity.** The input array and its events are asserted untouched, and the
 *   result is asserted to survive a JSON round trip, because these groups cross
 *   a WebSocket inside `CaptureSummary` and an HTTP response as the `requests`
 *   DataResult.
 * - **Pending is a marker, never an absence.** A request still on the wire at
 *   the end of its capture arrives as an in-flight snapshot, and only the
 *   boolean marker makes it pending; a missing status code never does. The
 *   in-flight section asserts what a pending occurrence may not do — carry a
 *   code, count as a failure, claim a resource entry — and that a settled event
 *   of the same span supersedes its snapshot, so one request is never reported
 *   as a duplicate of itself.
 *
 * ## Two fixture sources, on purpose
 *
 * Most cases below build their events inline, because a windowing boundary or a
 * hostile attribute is stated most clearly by the two-event fixture written for
 * it. The **final section** drives the same module from the committed capture
 * `packages/telemetry/test/fixtures/capture-batch.json`, which it reads from
 * disk at run time and validates element by element against the persisted
 * schema of `../schema/event.ts` before it asserts anything. That file is
 * deterministic repository data — a curated, already-redacted sample authored
 * and reviewed in the repository (AAP 0.2.5 lists it; 0.3.4 permits only
 * redacted samples to be committed), never a recording taken off a running
 * browser — which is what makes exact assertions on its groups,
 * windows and counts legitimate, and it is the only place in this suite where a
 * *whole* capture reaches the aggregate: seven request events among
 * twenty-eight that must leave no trace in the result.
 *
 * ## Fixture conventions
 *
 * Every path, component and parameter name here is invented (`/api/items`,
 * `/api/things`, `ListRow`, `SidePanel`, `DetailPane`) so that nothing in this
 * file could serve as demo knowledge a pipeline is supposed to discover by
 * analysing code (AAP 0.5.4). `productId` is the single borrowed name, and it
 * is borrowed from the privacy model's own sentence about this guarantee so
 * that the decisive case is recognisably the one the specification names.
 *
 * URLs are written **as they arrive**: already redacted, with query values
 * masked to `?`. That is what makes the decisive case possible at all, and it
 * is why no fixture needs a real parameter value.
 *
 * Request keys are assembled at run time from a short label and a run of one
 * character rather than written out as dense 64-character literals — and the
 * fixture-driven section keeps that convention by reading each key off the
 * parsed event instead of repeating the digest the JSON file holds, so this
 * tracked TypeScript file still contains no dense value bound to a key-like
 * name:
 * `scripts/check-secrets.mjs` scans this tracked file and its entropy rule
 * looks for exactly such a string bound to a name containing "key", so the
 * convention `../redaction/request-key.test.ts` established is followed here
 * too. The keys stay the shape a real digest has, and nothing in
 * `./requests.ts` parses or verifies them: the module is built
 * `platform: "neutral"`, imports no hashing primitive, and reads the key as an
 * opaque string. Supplying keys directly is therefore the intended contract
 * rather than a shortcut.
 *
 * Identifiers are minted from a counter instead of at random, so a failing
 * assertion names the same event on every run and the occurrence order — start
 * time, then id — is predictable by construction.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_RESOLUTION_CONFIDENCE, ID_PREFIXES, roundMs } from '@debuggen/shared';
import type { EventId, SourceLocation, SpanId, TraceId } from '@debuggen/shared';

import {
  FETCH_ATTRIBUTE_KEYS,
  PERF_ENTRY_ATTRIBUTE_KEYS,
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
  XHR_ATTRIBUTE_KEYS,
  attributeKeysFor,
} from '../schema/attributes.js';
import { isTelemetryEvent, telemetryEventSchema } from '../schema/event.js';
import type { TelemetryEvent } from '../schema/event.js';
import { PERF_KINDS, REQUEST_KINDS, TELEMETRY_KINDS, allowedTiersFor } from '../schema/kinds.js';
import type { TelemetryKind, TelemetryStatus, TelemetryTier } from '../schema/kinds.js';
import {
  DEFAULT_DUPLICATE_WINDOW_MS,
  DEFAULT_MAX_OCCURRENCES_PER_GROUP,
  DEFAULT_MAX_REQUEST_OCCURRENCES_PER_GROUP,
  DEFAULT_RESOURCE_TIMING_TOLERANCE_MS,
  INITIATOR_OWNER_SEPARATOR,
  MAX_INITIATOR_LABEL_LENGTH,
  MAX_INITIATOR_NAME_LENGTH,
  MAX_INITIATOR_OWNER_NAMES,
  REQUEST_GROUPED_BY,
  REQUEST_INITIATOR_BASES,
  REQUEST_IN_FLIGHT_ATTRIBUTE,
  REQUEST_TRANSFER_SOURCES,
  RESOURCE_ENTRY_TYPE,
  RESOURCE_TIMING_URL_ATTRIBUTE,
  TRANSFER_SIZE_EXPOSED_ATTRIBUTE,
  UNKNOWN_METHOD_LABEL,
  UNKNOWN_URL_LABEL,
  aggregateRequests,
  countDuplicateRequests,
  readExposedTransferSize,
} from './requests.js';
import type {
  DuplicateWindow,
  RequestAggregateOptions,
  RequestGroup,
  RequestOccurrence,
} from './requests.js';

/*
 * ---------------------------------------------------------------------------
 * Vocabulary
 *
 * Attribute keys, kinds, tiers and statuses are taken from the schema modules
 * that own them, never spelled freehand. The constants below follow the idiom
 * `./requests.ts` itself uses — a literal *typed against* the catalog — so a
 * rename upstream is a compile error in this file rather than a fixture that
 * silently stops populating the field under test.
 * ---------------------------------------------------------------------------
 */

/** A key the attribute catalog declares for the request-shaped kinds. */
type RequestAttributeKey = (typeof FETCH_ATTRIBUTE_KEYS)[number];

/** The request method. */
const METHOD_ATTRIBUTE: RequestAttributeKey = 'http.method';

/** The redacted request URL: a display string, never a grouping input. */
const URL_ATTRIBUTE: RequestAttributeKey = 'url';

/** The response status code. */
const STATUS_CODE_ATTRIBUTE: RequestAttributeKey = 'http.status_code';

/** The label for whatever started the request. */
const INITIATOR_ATTRIBUTE: RequestAttributeKey = 'initiator';

/** Bytes over the wire, as `PerformanceResourceTiming` spells it. */
const TRANSFER_SIZE_ATTRIBUTE: RequestAttributeKey = 'transferSize';

/**
 * A key the attribute catalog declares for resource-timing entries.
 *
 * The join reads the other half of one exchange, so its fixtures type their
 * keys against the resource-entry tuple exactly as the request fixtures type
 * theirs against the request tuple.
 */
type ResourceAttributeKey = (typeof PERF_ENTRY_ATTRIBUTE_KEYS)[number];

/** Which `PerformanceEntry` type a `perf.entry` event describes. */
const ENTRY_TYPE_ATTRIBUTE: ResourceAttributeKey = 'entry.type';

/** What initiated a resource load: `fetch`, `xmlhttprequest`, `link`, … */
const INITIATOR_TYPE_ATTRIBUTE: ResourceAttributeKey = 'initiator.type';

/**
 * The kind a resource-timing entry arrives as.
 *
 * Narrowed out of the performance kind group rather than written freehand: the
 * group holds a long task and a performance entry, and only the second can
 * describe a response.
 */
function resourceEntryKind(): TelemetryKind {
  const kind = PERF_KINDS.find((candidate) => candidate === 'perf.entry');
  if (kind === undefined) {
    throw new Error('PERF_KINDS no longer declares the performance-entry kind');
  }
  return kind;
}

/** @see resourceEntryKind */
const RESOURCE_ENTRY_EVENT_KIND = resourceEntryKind();

/**
 * The grouping key's attribute name, *read* from the catalog rather than typed.
 *
 * It is the one key that is both declared for the request kinds and listed in
 * `SERVICE_ASSIGNED_ATTRIBUTE_KEYS` — which is precisely how `./requests.ts`
 * identifies it, and the trust boundary its `REQUEST_KEY_IS_SERVICE_ASSIGNED`
 * flag gates on. Deriving the name from that intersection means this suite
 * cannot disagree with the module about which attribute it is testing, and a
 * future edit that made the key producer-supplied fails loudly here instead of
 * quietly letting a page choose its own duplicates.
 */
function requestScopedServiceAssignedKey(): RequestAttributeKey {
  const declared = FETCH_ATTRIBUTE_KEYS.filter((key) =>
    SERVICE_ASSIGNED_ATTRIBUTE_KEYS.includes(key),
  );
  const [only] = declared;
  if (only === undefined || declared.length !== 1) {
    throw new Error(
      `expected exactly one service-assigned request attribute, found ${String(declared.length)}: ${declared.join(', ')}`,
    );
  }
  return only;
}

/** @see requestScopedServiceAssignedKey */
const REQUEST_KEY_ATTRIBUTE = requestScopedServiceAssignedKey();

/**
 * A member of the request kind group, narrowed rather than asserted.
 *
 * `REQUEST_KINDS` is typed `readonly TelemetryKind[]` so that a consumer can
 * call `.includes()` with any kind, which means indexing it yields
 * `TelemetryKind | undefined` under `noUncheckedIndexedAccess`. The throw makes
 * the narrowing honest: a group that shrank below two members reports that
 * instead of producing an `undefined` kind.
 */
function requestKindAt(index: number): TelemetryKind {
  const kind = REQUEST_KINDS[index];
  if (kind === undefined) {
    throw new Error(`REQUEST_KINDS declares no kind at index ${String(index)}`);
  }
  return kind;
}

/** The kind every fixture uses unless it is specifically about the other one. */
const PRIMARY_REQUEST_KIND = requestKindAt(0);

/** The second request transport, for the mixed-transport case. */
const SECONDARY_REQUEST_KIND = requestKindAt(1);

/**
 * A tier the kind/tier table permits for `kind`.
 *
 * Fixtures take their tier from `KIND_ALLOWED_TIERS` rather than stating one,
 * so every event this file builds satisfies the persisted schema's cross-field
 * check by construction — including the events of every non-request kind swept
 * through the "ignored kinds" case.
 */
function firstAllowedTier(kind: TelemetryKind): TelemetryTier {
  const [tier] = allowedTiersFor(kind);
  if (tier === undefined) {
    throw new Error(`KIND_ALLOWED_TIERS lists no tier for kind "${kind}"`);
  }
  return tier;
}

/** The keyed key space. */
const BY_REQUEST_KEY = REQUEST_GROUPED_BY[0];

/** The documented `method + path` fallback key space. */
const BY_METHOD_PATH = REQUEST_GROUPED_BY[1];

/** A successful span status. */
const OK_STATUS: TelemetryStatus = 'ok';

/** A failed span status, which counts as an error with any status code. */
const ERROR_STATUS: TelemetryStatus = 'error';

/** The status a producer reports when it has nothing to say. */
const UNSET_STATUS: TelemetryStatus = 'unset';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Invented names only (see the header): a path, a component or a parameter
 * borrowed from the demo application would make this file the shortcut the
 * anti-hardcoding gate exists to prevent.
 * ---------------------------------------------------------------------------
 */

/** A generic read method. */
const GET_METHOD = 'GET';

/** A generic write method, for the per-method separation case. */
const POST_METHOD = 'POST';

/** The collection path every fixture uses unless the case needs a second one. */
const ITEMS_PATH = '/api/items';

/** A second, unrelated path. */
const THINGS_PATH = '/api/things';

/**
 * The redacted form of a parameterised request, as it arrives.
 *
 * The value is already masked — this is the whole point of the decisive case:
 * two requests that differed only in `productId` are indistinguishable by this
 * string, so only the key can keep them apart.
 */
const MASKED_ITEMS_URL = `${ITEMS_PATH}?productId=?`;

/** A second masked URL that differs from {@link MASKED_ITEMS_URL} in display. */
const MASKED_ITEMS_CURSOR_URL = `${ITEMS_PATH}?cursor=?`;

/** The initiating component every fixture reports unless the case varies it. */
const DEFAULT_INITIATOR = 'ListRow';

/** A second initiating component: two of them is a different finding. */
const SECOND_INITIATOR = 'SidePanel';

/** A third initiating component, for the distinctness case. */
const THIRD_INITIATOR = 'DetailPane';

/*
 * ---------------------------------------------------------------------------
 * The harness
 * ---------------------------------------------------------------------------
 */

/**
 * The epoch millisecond every offset in this file is measured from.
 *
 * Inside the schema's accepted window, and carrying a fractional part on
 * purpose: `startTime` is a double with sub-millisecond precision, so the
 * default fixture exercises that even in the cases that are about something
 * else.
 */
const BASE_TIME = 1_764_547_200_000.5;

/** The duration a fixture reports unless the case is about timing. */
const DEFAULT_DURATION_MS = 12.5;

/** The status code a fixture reports unless the case is about statuses. */
const DEFAULT_STATUS_CODE = 200;

/** Length of the hex digest `../redaction/request-key.ts` produces. */
const REQUEST_KEY_HEX_LENGTH = 64;

/** One counter behind every minted identifier, so each fixture is distinct. */
let fixtureOrdinal = 0;

/** The next ordinal; the only source of variation in a fixture identifier. */
function nextOrdinal(): number {
  fixtureOrdinal += 1;
  return fixtureOrdinal;
}

/**
 * `ordinal` as exactly `length` lowercase hex digits.
 *
 * Trace and span ids are pattern-validated by the event schema (32 and 16
 * lowercase hex characters), so a fixture cannot invent a readable id here; a
 * zero-padded counter is both valid and reproducible.
 */
function hexId(length: number, ordinal: number): string {
  const digits = ordinal.toString(16);
  if (digits.length > length) {
    throw new Error(
      `fixture ordinal ${String(ordinal)} does not fit in ${String(length)} hex digits`,
    );
  }
  return digits.padStart(length, '0');
}

/** A fresh, deterministic trace id. */
function nextTraceId(): TraceId {
  return hexId(32, nextOrdinal());
}

/** A fresh, deterministic span id. */
function nextSpanId(): SpanId {
  return hexId(16, nextOrdinal());
}

/** A fresh, deterministic event id in the product's `evt_…` shape. */
function nextEventId(): EventId {
  return `${ID_PREFIXES.event}_${hexId(16, nextOrdinal())}`;
}

/** The single producer every fixture is attributed to. */
const PRODUCER_ID = `${ID_PREFIXES.producer}_${hexId(16, 1)}`;

/** The session every fixture belongs to. */
const SESSION_ID = `${ID_PREFIXES.session}_${hexId(16, 1)}`;

/** The capture window every fixture was recorded in. */
const CAPTURE_ID = `${ID_PREFIXES.capture}_${hexId(16, 1)}`;

/** The producer's monotonic counter, scoped to `(producerId, captureId)`. */
let producerSeq = -1;

/** The next per-producer sequence number; zero-based. */
function nextSeq(): number {
  producerSeq += 1;
  return producerSeq;
}

/** The store's arrival counter; one-based, so a persisted event never carries 0. */
let ingestSeq = 0;

/** The next store-assigned arrival number. */
function nextIngestSeq(): number {
  ingestSeq += 1;
  return ingestSeq;
}

/**
 * An opaque stand-in for the digest ingest assigns, distinguished by `label`.
 *
 * Assembled rather than written out for the reason the header records, and
 * padded to a real digest's length so no fixture accidentally depends on the
 * key being short. `label` also orders the keyed group ids (`req:k:<key>`),
 * which is what makes the id tie-break case below readable.
 */
function opaqueRequestKey(label: string): string {
  if (label.length === 0 || label.length > REQUEST_KEY_HEX_LENGTH) {
    throw new Error(`a request-key label must be 1..${String(REQUEST_KEY_HEX_LENGTH)} characters`);
  }
  return `${label}${'0'.repeat(REQUEST_KEY_HEX_LENGTH)}`.slice(0, REQUEST_KEY_HEX_LENGTH);
}

/**
 * What a fixture may override.
 *
 * Split deliberately into event fields and the five request attributes, so a
 * case states what it is about (`{ requestKey, startTime }`) instead of
 * rebuilding an attribute bag. The three escape hatches at the end exist for
 * the hostile cases: `omitAttributes` removes a key entirely,
 * `extraAttributes` writes a value of the wrong type over a default, and
 * `throwingAttributes` installs a getter that throws — which must be installed
 * with `Object.defineProperty` rather than merged, since an object spread would
 * invoke it here instead of inside the module under test.
 */
interface RequestEventOverrides {
  readonly id?: EventId;
  readonly traceId?: TraceId;
  readonly spanId?: SpanId;
  readonly parentSpanId?: SpanId;
  readonly kind?: TelemetryKind;
  readonly tier?: TelemetryTier;
  readonly name?: string;
  readonly startTime?: number;
  readonly duration?: number;
  readonly status?: TelemetryStatus;
  readonly source?: SourceLocation;
  readonly redacted?: readonly string[];
  readonly method?: string;
  readonly url?: string;
  readonly statusCode?: number;
  readonly initiator?: string;
  readonly requestKey?: string;
  readonly transferSize?: number;
  readonly omitAttributes?: readonly RequestAttributeKey[];
  readonly extraAttributes?: Record<string, unknown>;
  readonly throwingAttributes?: readonly RequestAttributeKey[];
}

/**
 * One persisted request event: every field the store holds, populated.
 *
 * `transferSize` is the one attribute that is absent by default, because the
 * "`transferredBytes` is missing rather than zero" case (AAP 0.6.6's recorded
 * gap) needs a fixture that never reported a size. Every other attribute the
 * aggregate reads is present, so a case that removes one is visibly doing so.
 *
 * The default `request_key` is **distinct per fixture**: ingest gives two
 * byte-identical requests the same key, so a case that wants two occurrences of
 * one logical request says so by passing the same key. Nothing here groups by
 * accident.
 *
 * @param overrides Fields and attributes to replace.
 * @returns A fresh event; `isTelemetryEvent` accepts it unless the case
 * deliberately installs a hostile attribute.
 */
function makeRequestEvent(overrides: RequestEventOverrides = {}): TelemetryEvent {
  const kind = overrides.kind ?? PRIMARY_REQUEST_KIND;
  const method = overrides.method ?? GET_METHOD;
  const url = overrides.url ?? ITEMS_PATH;
  const omitted = new Set<string>(overrides.omitAttributes ?? []);
  const attributes: Record<string, unknown> = {};

  if (!omitted.has(METHOD_ATTRIBUTE)) {
    attributes[METHOD_ATTRIBUTE] = method;
  }
  if (!omitted.has(URL_ATTRIBUTE)) {
    attributes[URL_ATTRIBUTE] = url;
  }
  if (!omitted.has(STATUS_CODE_ATTRIBUTE)) {
    attributes[STATUS_CODE_ATTRIBUTE] = overrides.statusCode ?? DEFAULT_STATUS_CODE;
  }
  if (!omitted.has(INITIATOR_ATTRIBUTE)) {
    attributes[INITIATOR_ATTRIBUTE] = overrides.initiator ?? DEFAULT_INITIATOR;
  }
  if (!omitted.has(REQUEST_KEY_ATTRIBUTE)) {
    attributes[REQUEST_KEY_ATTRIBUTE] =
      overrides.requestKey ?? opaqueRequestKey(`f${hexId(8, nextOrdinal())}`);
  }
  if (overrides.transferSize !== undefined && !omitted.has(TRANSFER_SIZE_ATTRIBUTE)) {
    attributes[TRANSFER_SIZE_ATTRIBUTE] = overrides.transferSize;
  }

  for (const [key, value] of Object.entries(overrides.extraAttributes ?? {})) {
    attributes[key] = value;
  }
  for (const key of overrides.throwingAttributes ?? []) {
    Object.defineProperty(attributes, key, {
      configurable: true,
      enumerable: true,
      get(): never {
        throw new Error(`the "${key}" attribute is hostile by design`);
      },
    });
  }

  return {
    id: overrides.id ?? nextEventId(),
    traceId: overrides.traceId ?? nextTraceId(),
    spanId: overrides.spanId ?? nextSpanId(),
    ...(overrides.parentSpanId !== undefined ? { parentSpanId: overrides.parentSpanId } : {}),
    kind,
    name: overrides.name ?? `${method} ${url}`,
    startTime: overrides.startTime ?? BASE_TIME,
    duration: overrides.duration ?? DEFAULT_DURATION_MS,
    tier: overrides.tier ?? firstAllowedTier(kind),
    attributes,
    status: overrides.status ?? OK_STATUS,
    producerId: PRODUCER_ID,
    seq: nextSeq(),
    ...(overrides.source !== undefined ? { source: overrides.source } : {}),
    ...(overrides.redacted !== undefined ? { redacted: [...overrides.redacted] } : {}),
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq: nextIngestSeq(),
  };
}

/**
 * `offsetsMs.length` occurrences of one logical request, sharing `requestKey`.
 *
 * The offsets are millisecond deltas from {@link BASE_TIME} (or from
 * `overrides.startTime`), so a windowing case reads as the timeline it is
 * about: `[0, 7, 14, 22]` is the burst AAP 0.5.4 describes.
 *
 * @param requestKey The key every event carries — the grouping input.
 * @param offsetsMs Start offsets in milliseconds, in any order.
 * @param overrides Applied to every event of the series.
 * @returns One event per offset, in the order the offsets were given.
 */
function makeKeyedSeries(
  requestKey: string,
  offsetsMs: readonly number[],
  overrides: RequestEventOverrides = {},
): TelemetryEvent[] {
  const anchor = overrides.startTime ?? BASE_TIME;
  return offsetsMs.map((offsetMs) =>
    makeRequestEvent({ ...overrides, requestKey, startTime: anchor + offsetMs }),
  );
}

/**
 * A source location a fetch initiator could plausibly resolve to.
 *
 * Typed against the schema `@debuggen/shared` owns, so a change to that shape
 * is a compile error here rather than an occurrence field that stops arriving.
 */
function makeSourceLocation(file: string, line: number, symbol: string): SourceLocation {
  return {
    file,
    line,
    column: 5,
    symbol,
    resolvedBy: 'source-map',
    confidence: DEFAULT_RESOLUTION_CONFIDENCE['source-map'],
  };
}

/*
 * ---------------------------------------------------------------------------
 * Narrowing helpers
 *
 * `noUncheckedIndexedAccess` is in force, and this file narrows instead of
 * asserting: a helper that throws names what was expected and what the list
 * actually held, which a non-null assertion cannot do.
 * ---------------------------------------------------------------------------
 */

/** The element at `index`, or a failure naming what was expected. */
function elementAt<T>(list: readonly T[], index: number, what: string): T {
  const value = list[index];
  if (value === undefined) {
    throw new Error(
      `expected ${what} at index ${String(index)}; the list holds ${String(list.length)}`,
    );
  }
  return value;
}

/** The single group a case produced, or a failure showing how many there were. */
function onlyGroup(groups: readonly RequestGroup[]): RequestGroup {
  expect(groups.map((group) => group.id)).toHaveLength(1);
  return elementAt(groups, 0, 'a request group');
}

/** The group at `index` of the base order. */
function groupAt(groups: readonly RequestGroup[], index: number): RequestGroup {
  return elementAt(groups, index, 'a request group');
}

/** The occurrence at `index` of a group's canonical order. */
function occurrenceAt(group: RequestGroup, index: number): RequestOccurrence {
  return elementAt(group.occurrences, index, `an occurrence of group ${group.id}`);
}

/** The duplicate window at `index` of a group's time order. */
function windowAt(group: RequestGroup, index: number): DuplicateWindow {
  return elementAt(group.duplicateWindows, index, `a duplicate window of group ${group.id}`);
}

/** Every event's id, in the order the events were given. */
function idsOf(events: readonly TelemetryEvent[]): readonly EventId[] {
  return events.map((event) => event.id);
}

/**
 * A fixed permutation of `items`, with no randomness.
 *
 * Order-independence has to be asserted against a *reproducible* rearrangement:
 * a shuffle driven by `Math.random` would make a failure unrepeatable, which is
 * the opposite of what a determinism test is for. Taking every third element
 * starting at 2, then at 0, then at 1 visits every index exactly once and
 * separates neighbours that the aggregate would otherwise see in arrival order.
 */
function deterministicShuffle<T>(items: readonly T[]): T[] {
  const shuffled: T[] = [];
  for (const start of [2, 0, 1]) {
    for (let index = start; index < items.length; index += 3) {
      shuffled.push(elementAt(items, index, 'an input event'));
    }
  }
  return shuffled;
}

/** Summed occurrences across groups: the count no case may lose an event from. */
function totalCount(groups: readonly RequestGroup[]): number {
  return groups.reduce((sum, group) => sum + group.count, 0);
}

/** Summed redundant occurrences, computed independently of the module. */
function totalDuplicateCount(groups: readonly RequestGroup[]): number {
  return groups.reduce((sum, group) => sum + group.duplicateCount, 0);
}

/**
 * The same group, having asserted that none of its occurrences clustered.
 *
 * Used by the cases that are about something else — statuses, initiators,
 * sizes — and space their occurrences well beyond the window on purpose. The
 * assertion states that intent, so a fixture edited to a tighter spacing fails
 * here with a clear reason instead of quietly changing what the case measures.
 */
function noDuplicates(group: RequestGroup): RequestGroup {
  expect(group.duplicateWindows).toStrictEqual([]);
  expect(group.duplicateCount).toBe(0);
  return group;
}

/*
 * ---------------------------------------------------------------------------
 * The harness itself
 *
 * A fixture that the persisted schema would reject, or two fixtures that
 * accidentally share an identifier, would make every case below vacuous. What
 * follows covers the inline builder only; the committed capture this suite also
 * reads is held to the same schema by `describe('the committed capture
 * fixture')` at the end of the file, beside the loader that reads it.
 * ---------------------------------------------------------------------------
 */

describe('the request fixture harness', () => {
  it('builds events the persisted event schema accepts', () => {
    expect(isTelemetryEvent(makeRequestEvent())).toBe(true);
    expect(
      isTelemetryEvent(
        makeRequestEvent({
          kind: SECONDARY_REQUEST_KIND,
          url: MASKED_ITEMS_URL,
          transferSize: 2048,
          source: makeSourceLocation('src/ui/list-row.ts', 84, 'loadItems'),
          redacted: [`attributes.${URL_ATTRIBUTE}`],
          parentSpanId: nextSpanId(),
          status: ERROR_STATUS,
          statusCode: 500,
        }),
      ),
    ).toBe(true);
  });

  it('reads the grouping key name from the attribute catalog', () => {
    // Both memberships are load-bearing in `./requests.ts`: the key is
    // declared on the request kinds (so it may be read there at all) and
    // service-assigned (so it may be trusted as a grouping input). The module
    // degrades to the `method-path` space if the second ever stops holding.
    expect(FETCH_ATTRIBUTE_KEYS).toContain(REQUEST_KEY_ATTRIBUTE);
    expect(SERVICE_ASSIGNED_ATTRIBUTE_KEYS).toContain(REQUEST_KEY_ATTRIBUTE);
  });

  it('mints a distinct identifier for every fixture', () => {
    const events = [
      makeRequestEvent(),
      makeRequestEvent(),
      makeRequestEvent(),
      makeRequestEvent(),
      makeRequestEvent(),
    ];

    expect(new Set(idsOf(events)).size).toBe(events.length);
    expect(new Set(events.map((event) => event.spanId)).size).toBe(events.length);
    expect(new Set(events.map((event) => event.traceId)).size).toBe(events.length);
    // The default key is per-fixture, so nothing groups unless a case says so.
    expect(new Set(events.map((event) => event.attributes[REQUEST_KEY_ATTRIBUTE])).size).toBe(
      events.length,
    );
  });

  it('rearranges an input reproducibly and completely', () => {
    expect(deterministicShuffle([0, 1, 2, 3, 4])).toStrictEqual([2, 0, 3, 1, 4]);
    expect(deterministicShuffle([0, 1, 2, 3, 4])).toStrictEqual(
      deterministicShuffle([0, 1, 2, 3, 4]),
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * Grouping: the named semantic
 * ---------------------------------------------------------------------------
 */

describe('aggregateRequests grouping', () => {
  it('returns nothing for an empty capture', () => {
    expect(aggregateRequests([])).toStrictEqual([]);
  });

  it('collapses two occurrences that share a request key into one group', () => {
    const requestKey = opaqueRequestKey('a1');
    const events = makeKeyedSeries(requestKey, [0, 120], { url: MASKED_ITEMS_URL });

    const group = onlyGroup(aggregateRequests(events));

    expect(group.groupedBy).toBe(BY_REQUEST_KEY);
    expect(group.requestKey).toBe(requestKey);
    expect(group.count).toBe(2);
    expect(group.method).toBe(GET_METHOD);
    expect(group.url).toBe(MASKED_ITEMS_URL);
    expect(group.path).toBe(ITEMS_PATH);
    expect(group.occurrences.map((occurrence) => occurrence.eventId)).toStrictEqual(idsOf(events));
  });

  it('keeps requests apart when their keys differ and their redacted URLs are identical', () => {
    // THE DECISIVE CASE. AAP 0.5.2: "`productId=A` and `productId=B` are
    // distinct while byte-identical requests collide, even though both URLs
    // are stored with their parameter values replaced". Both events below
    // carry the *same* string in `url` - that is what redaction leaves behind -
    // and differ only in the key ingest computed from the unredacted URL. Two
    // groups is therefore the mechanical proof that grouping does not read
    // `url`: a module that grouped on the display string would return one
    // group here and report two unrelated requests as duplicates of each
    // other, which is the confident-and-wrong finding this key space exists to
    // prevent. The `redacted` field records that the masking already happened.
    const firstKey = opaqueRequestKey('a1');
    const secondKey = opaqueRequestKey('a2');
    const redacted = [`attributes.${URL_ATTRIBUTE}`];
    const events = [
      makeRequestEvent({ requestKey: firstKey, url: MASKED_ITEMS_URL, redacted }),
      makeRequestEvent({
        requestKey: secondKey,
        url: MASKED_ITEMS_URL,
        startTime: BASE_TIME + 3,
        redacted,
      }),
    ];

    const groups = aggregateRequests(events);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.url)).toStrictEqual([MASKED_ITEMS_URL, MASKED_ITEMS_URL]);
    // Equal on every ordering key except `id`, so the base order is the id
    // order and the key labels make it predictable.
    expect(groups.map((group) => group.requestKey)).toStrictEqual([firstKey, secondKey]);
    expect(groups.map((group) => group.count)).toStrictEqual([1, 1]);
    expect(groups.map((group) => group.hasDuplicates)).toStrictEqual([false, false]);
    expect(new Set(groups.map((group) => group.id)).size).toBe(2);
    expect(countDuplicateRequests(groups)).toBe(0);
  });

  it('collapses occurrences that share a key even when their displayed URLs differ', () => {
    // The mirror of the decisive case, and deliberately impossible in
    // production: ingest would never key two different query strings alike.
    // That is exactly what makes it a clean probe - only a module reading
    // `url` could split this group - and it pins which value wins for display:
    // the canonically earliest occurrence's.
    const requestKey = opaqueRequestKey('b1');
    const events = [
      makeRequestEvent({ requestKey, url: MASKED_ITEMS_URL }),
      makeRequestEvent({
        requestKey,
        url: MASKED_ITEMS_CURSOR_URL,
        startTime: BASE_TIME + 4,
      }),
    ];

    const group = onlyGroup(aggregateRequests(events));

    expect(group.groupedBy).toBe(BY_REQUEST_KEY);
    expect(group.count).toBe(2);
    expect(group.url).toBe(MASKED_ITEMS_URL);
    expect(group.path).toBe(ITEMS_PATH);
  });

  it('falls back to method and path when no key is present, and says which space it used', () => {
    const events = [
      makeRequestEvent({ omitAttributes: [REQUEST_KEY_ATTRIBUTE] }),
      makeRequestEvent({ omitAttributes: [REQUEST_KEY_ATTRIBUTE], startTime: BASE_TIME + 9 }),
    ];

    const group = onlyGroup(aggregateRequests(events));

    expect(group.groupedBy).toBe(BY_METHOD_PATH);
    expect(group.count).toBe(2);
    expect(group.method).toBe(GET_METHOD);
    expect(group.path).toBe(ITEMS_PATH);
    // Absent rather than empty: a fallback group has no key to report, and the
    // field must be missing so a JSON round trip cannot turn it into `null`.
    expect(group.requestKey).toBeUndefined();
    expect(Object.hasOwn(group, 'requestKey')).toBe(false);
  });

  it('never mixes the two key spaces for one method and path', () => {
    const requestKey = opaqueRequestKey('c1');
    const events = [
      makeRequestEvent({ requestKey }),
      makeRequestEvent({ omitAttributes: [REQUEST_KEY_ATTRIBUTE], startTime: BASE_TIME + 2 }),
    ];

    const groups = aggregateRequests(events);

    expect(groups).toHaveLength(2);
    expect([...groups.map((group) => group.groupedBy)].sort()).toStrictEqual(
      [...REQUEST_GROUPED_BY].sort(),
    );
    expect(groups.map((group) => group.count)).toStrictEqual([1, 1]);
    expect(new Set(groups.map((group) => group.id)).size).toBe(2);
    expect(totalCount(groups)).toBe(events.length);
  });

  it('separates different methods, and different paths, in the fallback space', () => {
    const events = [
      makeRequestEvent({ omitAttributes: [REQUEST_KEY_ATTRIBUTE] }),
      makeRequestEvent({
        omitAttributes: [REQUEST_KEY_ATTRIBUTE],
        method: POST_METHOD,
        startTime: BASE_TIME + 1,
      }),
      makeRequestEvent({
        omitAttributes: [REQUEST_KEY_ATTRIBUTE],
        url: THINGS_PATH,
        startTime: BASE_TIME + 2,
      }),
    ];

    const groups = aggregateRequests(events);

    expect(groups).toHaveLength(3);
    expect(totalCount(groups)).toBe(events.length);
    expect([...groups.map((group) => `${group.method} ${group.path}`)].sort()).toStrictEqual(
      [
        `${GET_METHOD} ${ITEMS_PATH}`,
        `${GET_METHOD} ${THINGS_PATH}`,
        `${POST_METHOD} ${ITEMS_PATH}`,
      ].sort(),
    );
  });

  it('labels an unreadable method or URL and loses no event', () => {
    const events = [
      makeRequestEvent({ omitAttributes: [REQUEST_KEY_ATTRIBUTE, METHOD_ATTRIBUTE] }),
      makeRequestEvent({
        omitAttributes: [REQUEST_KEY_ATTRIBUTE, URL_ATTRIBUTE],
        startTime: BASE_TIME + 1,
      }),
      makeRequestEvent({
        omitAttributes: [REQUEST_KEY_ATTRIBUTE, METHOD_ATTRIBUTE, URL_ATTRIBUTE],
        startTime: BASE_TIME + 2,
      }),
    ];

    const groups = aggregateRequests(events);

    // Evidence is labelled, never discarded: three unreadable events are three
    // visible groups, and the summed count still accounts for every one.
    expect(groups).toHaveLength(3);
    expect(totalCount(groups)).toBe(events.length);
    expect([...groups.map((group) => `${group.method} ${group.url}`)].sort()).toStrictEqual(
      [
        `${GET_METHOD} ${UNKNOWN_URL_LABEL}`,
        `${UNKNOWN_METHOD_LABEL} ${ITEMS_PATH}`,
        `${UNKNOWN_METHOD_LABEL} ${UNKNOWN_URL_LABEL}`,
      ].sort(),
    );
    // A URL-less event gets the label as its path too, never an invented '/'.
    expect(
      groups
        .filter((group) => group.url === UNKNOWN_URL_LABEL)
        .map((group) => group.path === UNKNOWN_URL_LABEL),
    ).toStrictEqual([true, true]);
  });

  it('keeps one logical request together across both browser transports', () => {
    const requestKey = opaqueRequestKey('c2');
    const events = [
      makeRequestEvent({ requestKey, kind: PRIMARY_REQUEST_KIND }),
      makeRequestEvent({
        requestKey,
        kind: SECONDARY_REQUEST_KIND,
        startTime: BASE_TIME + 6,
      }),
    ];

    const group = onlyGroup(aggregateRequests(events));

    expect(group.count).toBe(2);
    expect(group.occurrences.map((occurrence) => occurrence.kind)).toStrictEqual([
      PRIMARY_REQUEST_KIND,
      SECONDARY_REQUEST_KIND,
    ]);
  });

  it('reports on the request kinds only, and ignores every other kind', () => {
    // Swept over the whole vocabulary rather than a sample, so a kind added
    // upstream is classified here on its first run: it either joins the
    // request group and is aggregated, or it is ignored. `http.client` - the
    // server's own outgoing request - is deliberately in the second set.
    const ignoredKinds = TELEMETRY_KINDS.filter((kind) => !REQUEST_KINDS.includes(kind));
    const ignoredEvents = ignoredKinds.map((kind, index) =>
      makeRequestEvent({ kind, startTime: BASE_TIME + index }),
    );

    expect(ignoredKinds.length).toBeGreaterThan(0);
    expect(aggregateRequests(ignoredEvents)).toStrictEqual([]);

    const requestEvents = REQUEST_KINDS.map((kind, index) =>
      makeRequestEvent({ kind, requestKey: opaqueRequestKey(`e${String(index)}`) }),
    );

    expect(aggregateRequests([...ignoredEvents, ...requestEvents])).toHaveLength(
      REQUEST_KINDS.length,
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * Path derivation
 *
 * The path is derived by string scan, not by `new URL()`, so that it agrees
 * byte for byte with the `url` it travels to the panel beside.
 * ---------------------------------------------------------------------------
 */

describe('aggregateRequests path derivation', () => {
  /** The single group produced by one event carrying `url`. */
  function groupForUrl(url: string, label: string): RequestGroup {
    return onlyGroup(
      aggregateRequests([makeRequestEvent({ url, requestKey: opaqueRequestKey(label) })]),
    );
  }

  it('excludes the query and the fragment without normalising anything', () => {
    const url = `http://LocalHost:8123/api/items%2Fdeep/a%20b?productId=?#section`;

    const group = groupForUrl(url, 'd1');

    // Byte-faithful: the mixed-case host, the explicit non-default port and
    // both percent-escapes survive, because `new URL()` would have lower-cased
    // the host, decoded `%20` and made the stored display string disagree with
    // the derived path.
    expect(group.url).toBe(url);
    expect(group.path).toBe('/api/items%2Fdeep/a%20b');
    expect(group.path).not.toContain('?');
    expect(group.path).not.toContain('#');
  });

  it('cuts at a fragment that precedes a literal question mark', () => {
    const group = groupForUrl(`${ITEMS_PATH}#section?notaquery`, 'd2');

    expect(group.path).toBe(ITEMS_PATH);
  });

  it('reports no path for an authority that has none, rather than inventing one', () => {
    const url = 'http://localhost:8123?productId=?';

    const group = groupForUrl(url, 'd3');

    expect(group.path).toBe('');
    expect(group.url).toBe(url);
  });

  it('handles a protocol-relative reference', () => {
    expect(groupForUrl(`//localhost:8123${THINGS_PATH}`, 'd4').path).toBe(THINGS_PATH);
  });

  it('returns a relative reference as it stands', () => {
    expect(groupForUrl(ITEMS_PATH, 'd5').path).toBe(ITEMS_PATH);
  });

  it('returns an opaque reference as it stands', () => {
    const url = 'data:text/plain,inline';

    expect(groupForUrl(url, 'd6').path).toBe(url);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Duplicate windowing
 *
 * Repetition on its own is not a defect. These cases pin the line between a
 * burst and a healthy refetch, and the rule that keeps them apart.
 * ---------------------------------------------------------------------------
 */

describe('aggregateRequests duplicate windowing', () => {
  it('reports four identical requests inside 22 ms as one window of three redundant calls', () => {
    // AAP 0.5.4's analysis example, verbatim: "4 requests to /api/prices
    // occurred within 22 ms". The distinction this case exists to hold is
    // total versus redundant - four occurrences, three of them wasted - since
    // `./summary.ts` publishes the redundant number as
    // `duplicate_request_count` while the table shows the total.
    const requestKey = opaqueRequestKey('g1');
    const events = makeKeyedSeries(requestKey, [0, 7, 14, 22], { url: MASKED_ITEMS_URL });

    const group = onlyGroup(aggregateRequests(events));

    expect(group.count).toBe(4);
    expect(group.duplicateCount).toBe(3);
    expect(group.hasDuplicates).toBe(true);
    expect(group.duplicateWindows).toHaveLength(1);

    const window = windowAt(group, 0);

    expect(window.count).toBe(4);
    expect(window.redundantCount).toBe(3);
    expect(window.startTime).toBe(BASE_TIME);
    expect(window.endTime).toBe(BASE_TIME + 22);
    expect(window.endTime - window.startTime).toBeLessThanOrEqual(DEFAULT_DUPLICATE_WINDOW_MS);
    expect(window.eventIds).toStrictEqual(idsOf(events));
    expect(countDuplicateRequests([group])).toBe(3);
  });

  it('reports no duplicates when two occurrences fall outside the window', () => {
    const requestKey = opaqueRequestKey('g2');
    const events = makeKeyedSeries(requestKey, [0, DEFAULT_DUPLICATE_WINDOW_MS + 1]);

    const group = onlyGroup(aggregateRequests(events));

    // Two clusters, each holding a single occurrence, so no window is emitted
    // at all: a view that refetches after a pause is healthy, and reporting it
    // as a duplicate would bury the findings that matter.
    expect(group.count).toBe(2);
    expect(group.duplicateWindows).toStrictEqual([]);
    expect(group.duplicateCount).toBe(0);
    expect(group.hasDuplicates).toBe(false);
  });

  it('includes an occurrence exactly one window after the anchor', () => {
    const requestKey = opaqueRequestKey('g3');
    const events = makeKeyedSeries(requestKey, [0, DEFAULT_DUPLICATE_WINDOW_MS]);

    const group = onlyGroup(aggregateRequests(events));

    // The boundary is inclusive, which is the documented behaviour; the case
    // above is one millisecond past it.
    expect(group.duplicateWindows).toHaveLength(1);
    expect(windowAt(group, 0).count).toBe(2);
    expect(group.duplicateCount).toBe(1);
  });

  it('never merges a slow trickle into one giant window', () => {
    // Each occurrence starts 900 ms after its predecessor - inside the window -
    // while the series spans four and a half windows in total. Measuring each
    // candidate against its *cluster anchor* yields three pairs; chaining from
    // each neighbour instead would yield one window of six and report a
    // once-a-second refetch as a burst, which is the opposite of the finding.
    const requestKey = opaqueRequestKey('g4');
    const offsets = [0, 900, 1800, 2700, 3600, 4500];
    const events = makeKeyedSeries(requestKey, offsets);

    const group = onlyGroup(aggregateRequests(events));

    expect(group.count).toBe(6);
    expect(group.duplicateWindows).toHaveLength(3);
    expect(group.duplicateCount).toBe(3);
    expect(
      group.duplicateWindows.map((window) => [
        window.startTime - BASE_TIME,
        window.endTime - BASE_TIME,
      ]),
    ).toStrictEqual([
      [0, 900],
      [1800, 2700],
      [3600, 4500],
    ]);
    expect(group.duplicateWindows.map((window) => window.count)).toStrictEqual([2, 2, 2]);
  });

  it('gives every cluster an ordinal, including the singletons that emit no window', () => {
    // The lone occurrence at offset 0 is cluster 0, so the pair that follows is
    // cluster 1 and its window id ends in `w1`. That is what keeps a window's
    // id stable when an earlier singleton gains a partner in a later capture.
    const requestKey = opaqueRequestKey('g5');
    const events = makeKeyedSeries(requestKey, [0, 5000, 5100]);

    const group = onlyGroup(aggregateRequests(events));

    expect(group.duplicateWindows).toHaveLength(1);
    expect(windowAt(group, 0).id).toBe(`${group.id}#w1`);
    expect(windowAt(group, 0).count).toBe(2);
    expect(group.duplicateCount).toBe(1);
  });

  it('honours a tightened duplicate window', () => {
    const requestKey = opaqueRequestKey('g6');
    const events = makeKeyedSeries(requestKey, [0, 7, 14, 22]);
    const tightened: RequestAggregateOptions = { duplicateWindowMs: 10 };

    const group = onlyGroup(aggregateRequests(events, tightened));

    // The burst of four splits into two pairs: the analysis stage can ask for a
    // stricter reading without the aggregate changing its arithmetic.
    expect(group.count).toBe(4);
    expect(group.duplicateWindows).toHaveLength(2);
    expect(group.duplicateWindows.map((window) => window.count)).toStrictEqual([2, 2]);
    expect(group.duplicateCount).toBe(2);
  });

  it('separates a previously duplicate pair when the window is tightened past it', () => {
    const requestKey = opaqueRequestKey('g7');
    const events = makeKeyedSeries(requestKey, [0, 7, 14, 22]);

    const group = onlyGroup(aggregateRequests(events, { duplicateWindowMs: 5 }));

    expect(group.count).toBe(4);
    expect(group.duplicateWindows).toStrictEqual([]);
    expect(group.duplicateCount).toBe(0);
    expect(group.hasDuplicates).toBe(false);
  });

  it('honours a zero window, clustering only occurrences that share a start time', () => {
    const requestKey = opaqueRequestKey('g8');
    const events = makeKeyedSeries(requestKey, [0, 0, 5]);

    const group = onlyGroup(aggregateRequests(events, { duplicateWindowMs: 0 }));

    expect(group.count).toBe(3);
    expect(group.duplicateWindows).toHaveLength(1);
    expect(windowAt(group, 0).count).toBe(2);
    expect(windowAt(group, 0).eventIds).toStrictEqual(idsOf(events).slice(0, 2));
    expect(group.duplicateCount).toBe(1);
  });

  it('falls back to the default window for an unusable option', () => {
    const offsets = [0, 7, 14, 22];
    const expected = onlyGroup(
      aggregateRequests(makeKeyedSeries(opaqueRequestKey('g9'), offsets)),
    ).duplicateCount;

    for (const duplicateWindowMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const group = onlyGroup(
        aggregateRequests(makeKeyedSeries(opaqueRequestKey('ga'), offsets), {
          duplicateWindowMs,
        }),
      );

      // A negative or non-finite window is a caller mistake, and the documented
      // response is the default rather than a silently empty or all-inclusive
      // result.
      expect(group.duplicateCount).toBe(expected);
    }

    expect(expected).toBe(3);
  });

  it('lists a window\u2019s occurrences in time order however they arrived', () => {
    const requestKey = opaqueRequestKey('gb');
    const events = makeKeyedSeries(requestKey, [0, 7, 14, 22]);

    const group = onlyGroup(aggregateRequests(deterministicShuffle(events)));
    const window = windowAt(group, 0);

    expect(window.eventIds).toStrictEqual(idsOf(events));
    expect(window.startTime).toBe(BASE_TIME);
    expect(window.endTime).toBe(BASE_TIME + 22);
    expect(group.occurrences.map((occurrence) => occurrence.startTime)).toStrictEqual([
      BASE_TIME,
      BASE_TIME + 7,
      BASE_TIME + 14,
      BASE_TIME + 22,
    ]);
  });

  it('mints window ids deterministically from the group id', () => {
    const requestKey = opaqueRequestKey('gc');
    const events = makeKeyedSeries(requestKey, [0, 5, 3000, 3005]);

    const first = onlyGroup(aggregateRequests(events));
    const second = onlyGroup(aggregateRequests(deterministicShuffle(events)));

    expect(first.duplicateWindows.map((window) => window.id)).toStrictEqual([
      `${first.id}#w0`,
      `${first.id}#w1`,
    ]);
    expect(second.duplicateWindows.map((window) => window.id)).toStrictEqual(
      first.duplicateWindows.map((window) => window.id),
    );
    expect(first.duplicateCount).toBe(2);
  });

  it('computes windows over every occurrence, even when the exposed list is bounded', () => {
    const requestKey = opaqueRequestKey('gd');
    const events = makeKeyedSeries(requestKey, [0, 1, 2, 3, 4]);

    const group = onlyGroup(aggregateRequests(events, { maxOccurrencesPerGroup: 2 }));

    // Truncating the list must never change the evidence: five occurrences,
    // four of them redundant, with every event id still named in the window.
    expect(group.count).toBe(5);
    expect(group.occurrences).toHaveLength(2);
    expect(group.occurrencesTruncated).toBe(true);
    expect(windowAt(group, 0).count).toBe(5);
    expect(windowAt(group, 0).eventIds).toStrictEqual(idsOf(events));
    expect(group.duplicateCount).toBe(4);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The `duplicate_request_count` metric
 * ---------------------------------------------------------------------------
 */

describe('countDuplicateRequests', () => {
  it('sums the redundant occurrences of every group', () => {
    // `./summary.ts` publishes exactly this number as the
    // `duplicate_request_count` metric instead of computing a sum of its own,
    // which is what makes the metric card and the request table's duplicate
    // badges the same arithmetic fact rather than two that can drift apart.
    const burst = makeKeyedSeries(opaqueRequestKey('h1'), [0, 7, 14, 22]);
    const pair = makeKeyedSeries(opaqueRequestKey('h2'), [0, 5]);
    const spread = makeKeyedSeries(opaqueRequestKey('h3'), [0, 2000, 4000]);

    const groups = aggregateRequests([...burst, ...pair, ...spread]);

    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.duplicateCount)).toStrictEqual([3, 1, 0]);
    expect(countDuplicateRequests(groups)).toBe(4);
    expect(countDuplicateRequests(groups)).toBe(totalDuplicateCount(groups));
  });

  it('reports zero for a capture in which nothing repeated', () => {
    const groups = aggregateRequests([
      makeRequestEvent({ requestKey: opaqueRequestKey('h4') }),
      makeRequestEvent({ requestKey: opaqueRequestKey('h5'), startTime: BASE_TIME + 1 }),
    ]);

    expect(groups.every((group) => !group.hasDuplicates)).toBe(true);
    expect(countDuplicateRequests(groups)).toBe(0);
    expect(countDuplicateRequests(groups)).toBe(totalDuplicateCount(groups));
  });

  it('reports zero for no groups at all', () => {
    expect(countDuplicateRequests([])).toBe(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Aggregated fields
 * ---------------------------------------------------------------------------
 */

describe('aggregateRequests aggregates', () => {
  it('computes the timing aggregates over every occurrence', () => {
    const requestKey = opaqueRequestKey('i1');
    const events = [
      makeRequestEvent({ requestKey, startTime: BASE_TIME, duration: 10 }),
      makeRequestEvent({ requestKey, startTime: BASE_TIME + 30, duration: 40.5 }),
      makeRequestEvent({ requestKey, startTime: BASE_TIME + 65, duration: 7.25 }),
    ];

    const group = onlyGroup(aggregateRequests(events));

    expect(group.count).toBe(3);
    expect(group.totalDurationMs).toBe(57.75);
    expect(group.averageDurationMs).toBe(roundMs(57.75 / 3));
    expect(group.averageDurationMs).toBe(19.25);
    expect(group.minDurationMs).toBe(7.25);
    expect(group.maxDurationMs).toBe(40.5);
    expect(group.firstStartTime).toBe(BASE_TIME);
    expect(group.lastStartTime).toBe(BASE_TIME + 65);

    const second = occurrenceAt(group, 1);

    // `endTime` is precomputed so the renderer does no timing arithmetic of its
    // own, and it is in the same epoch-millisecond base as `startTime`.
    expect(second.startTime).toBe(BASE_TIME + 30);
    expect(second.durationMs).toBe(40.5);
    expect(second.endTime).toBe(BASE_TIME + 70.5);
  });

  it('reports distinct status codes in ascending order and counts every failure once', () => {
    const requestKey = opaqueRequestKey('i2');
    const events = [
      makeRequestEvent({ requestKey, statusCode: 200, status: OK_STATUS }),
      makeRequestEvent({
        requestKey,
        statusCode: 404,
        status: OK_STATUS,
        startTime: BASE_TIME + 2000,
      }),
      makeRequestEvent({
        requestKey,
        statusCode: 500,
        status: ERROR_STATUS,
        startTime: BASE_TIME + 4000,
      }),
      makeRequestEvent({
        requestKey,
        statusCode: 200,
        status: ERROR_STATUS,
        startTime: BASE_TIME + 6000,
      }),
      makeRequestEvent({
        requestKey,
        omitAttributes: [STATUS_CODE_ATTRIBUTE],
        status: UNSET_STATUS,
        startTime: BASE_TIME + 8000,
      }),
    ];

    const group = noDuplicates(onlyGroup(aggregateRequests(events)));

    expect(group.count).toBe(5);
    expect(group.statusCodes).toStrictEqual([200, 404, 500]);
    // Three failures: the client error, the server error - whose span status is
    // `error` as well, and which must still count once - and the occurrence
    // that returned 200 but whose span failed, because a transport-level
    // failure with a successful code is still a failed request.
    expect(group.errorCount).toBe(3);

    const withoutCode = occurrenceAt(group, 4);

    expect(withoutCode.statusCode).toBeUndefined();
    expect(Object.hasOwn(withoutCode, 'statusCode')).toBe(false);
    expect(withoutCode.status).toBe(UNSET_STATUS);
  });

  it('keeps every distinct initiator, sorted', () => {
    // AAP 0.8.2 recognises the duplicate-request defect by exactly this field:
    // one component firing twice and two components each firing once are
    // different findings with different fixes, so the set is never collapsed to
    // its first entry.
    const requestKey = opaqueRequestKey('i3');
    const events = [
      makeRequestEvent({ requestKey, initiator: SECOND_INITIATOR }),
      makeRequestEvent({
        requestKey,
        initiator: THIRD_INITIATOR,
        startTime: BASE_TIME + 2000,
      }),
      makeRequestEvent({
        requestKey,
        initiator: DEFAULT_INITIATOR,
        startTime: BASE_TIME + 4000,
      }),
      makeRequestEvent({
        requestKey,
        initiator: SECOND_INITIATOR,
        startTime: BASE_TIME + 6000,
      }),
    ];

    const group = onlyGroup(aggregateRequests(events));

    expect(group.count).toBe(4);
    // Code-unit order: DetailPane, ListRow, SidePanel - locale-independent, so
    // the panel shows the same order on every machine.
    expect(group.initiators).toStrictEqual([THIRD_INITIATOR, DEFAULT_INITIATOR, SECOND_INITIATOR]);
  });

  it('reports no initiators when no occurrence named one', () => {
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({
          requestKey: opaqueRequestKey('i4'),
          omitAttributes: [INITIATOR_ATTRIBUTE],
        }),
      ]),
    );

    expect(group.initiators).toStrictEqual([]);
    expect(group.count).toBe(1);
  });

  it('omits transferredBytes when no occurrence reported a size', () => {
    // AAP 0.6.6 records this as a known gap: `transferSize` is exposed for
    // same-origin fetches only, so the field must be able to be *missing* for
    // the metric card to show "n/a" instead of a misleading zero.
    const group = onlyGroup(aggregateRequests(makeKeyedSeries(opaqueRequestKey('i5'), [0, 5])));

    expect(group.transferredBytes).toBeUndefined();
    expect(Object.hasOwn(group, 'transferredBytes')).toBe(false);
  });

  it('sums transferredBytes over the occurrences that reported one', () => {
    const requestKey = opaqueRequestKey('i6');
    const events = [
      makeRequestEvent({ requestKey, transferSize: 1024.4 }),
      makeRequestEvent({ requestKey, transferSize: 2048.4, startTime: BASE_TIME + 5 }),
      makeRequestEvent({ requestKey, startTime: BASE_TIME + 10 }),
    ];

    const group = onlyGroup(aggregateRequests(events));

    // Summed over the two that reported, rounded to whole bytes, and the
    // occurrence that reported nothing neither contributes nor blocks.
    expect(group.transferredBytes).toBe(3073);
    expect(group.count).toBe(3);
    expect(occurrenceAt(group, 0).transferredBytes).toBe(1024.4);
    expect(Object.hasOwn(occurrenceAt(group, 2), 'transferredBytes')).toBe(false);
  });

  it('preserves every occurrence field the request table expands to', () => {
    const requestKey = opaqueRequestKey('i7');
    const source = makeSourceLocation('src/ui/list-row.ts', 84, 'loadItems');
    const parentSpanId = nextSpanId();
    const events = [
      makeRequestEvent({
        requestKey,
        source,
        parentSpanId,
        transferSize: 512,
        url: MASKED_ITEMS_URL,
      }),
      makeRequestEvent({
        requestKey,
        startTime: BASE_TIME + 4,
        omitAttributes: [INITIATOR_ATTRIBUTE],
      }),
    ];
    const first = elementAt(events, 0, 'the first input event');

    const group = onlyGroup(aggregateRequests(events));
    const occurrence = occurrenceAt(group, 0);
    const plain = occurrenceAt(group, 1);

    // The panel's row expands to each occurrence with its own initiator source
    // link (AAP 0.6.2), so the location has to survive per occurrence rather
    // than being folded into the group.
    expect(occurrence.source).toStrictEqual(source);
    expect(occurrence.parentSpanId).toBe(parentSpanId);
    expect(occurrence.initiator).toBe(DEFAULT_INITIATOR);
    expect(occurrence.transferredBytes).toBe(512);
    expect(occurrence.traceId).toBe(first.traceId);
    expect(occurrence.spanId).toBe(first.spanId);
    expect(occurrence.tier).toBe(firstAllowedTier(PRIMARY_REQUEST_KIND));
    expect(occurrence.kind).toBe(PRIMARY_REQUEST_KIND);
    expect(occurrence.status).toBe(OK_STATUS);
    // One value under two names: `id` is the stable paging key the service
    // sorts by, `eventId` is what a panel selects the underlying event with.
    expect(occurrence.id).toBe(first.id);
    expect(occurrence.eventId).toBe(occurrence.id);

    // Absent, never null: a producer that said nothing leaves the field off.
    expect(Object.hasOwn(plain, 'source')).toBe(false);
    expect(Object.hasOwn(plain, 'initiator')).toBe(false);
    expect(Object.hasOwn(plain, 'parentSpanId')).toBe(false);
    expect(Object.hasOwn(plain, 'transferredBytes')).toBe(false);
  });

  it('bounds the occurrence list as asked, and says when it did', () => {
    const requestKey = opaqueRequestKey('i8');
    const events = makeKeyedSeries(requestKey, [0, 1, 2, 3, 4]);
    const expectedIds = idsOf(events);

    const bounded = onlyGroup(aggregateRequests(events, { maxOccurrencesPerGroup: 2 }));
    const floored = onlyGroup(aggregateRequests(events, { maxOccurrencesPerGroup: 2.7 }));
    const none = onlyGroup(aggregateRequests(events, { maxOccurrencesPerGroup: 0 }));
    const unbounded = onlyGroup(aggregateRequests(events));
    const defaulted = onlyGroup(aggregateRequests(events, { maxOccurrencesPerGroup: Number.NaN }));

    // Truncation keeps the canonical order and takes from the front, so the
    // earliest occurrences are the ones a developer sees.
    expect(bounded.occurrences.map((occurrence) => occurrence.eventId)).toStrictEqual(
      expectedIds.slice(0, 2),
    );
    expect(bounded.occurrencesTruncated).toBe(true);
    expect(floored.occurrences).toHaveLength(2);

    // Zero omits the lists entirely while every count survives.
    expect(none.occurrences).toStrictEqual([]);
    expect(none.occurrencesTruncated).toBe(true);
    expect(none.count).toBe(5);
    expect(none.duplicateCount).toBe(4);

    expect(unbounded.occurrences).toHaveLength(5);
    expect(unbounded.occurrencesTruncated).toBe(false);
    expect(defaulted.occurrences).toHaveLength(5);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Initiator labels
 *
 * The browser agent records a call-site stack of generated-chunk frames, and
 * every one begins in the application's shared request helper, so a label
 * taken from that text would name one helper for every request of the page.
 * These cases pin the header's "Initiator labels": the runtime component chain
 * first, then a producer's own label, then the resolved call site, then the
 * stack's first frame — with the stack itself kept beside the label.
 * ---------------------------------------------------------------------------
 */

/** A request key the initiator cases share, labelled per case. */
function initiatorKey(label: string): string {
  return opaqueRequestKey(`n${label}`);
}

/** The component that ran the effect in the two-mount cases. */
const RAIL_COMPONENT = 'ReadingsRail';

/** The owners above the first mount, nearest first. */
const HEADER_OWNERS = ['ConsoleHeader', 'ConsolePage'] as const;

/** The owners above the second mount, nearest first. */
const DETAIL_OWNERS = ['GaugeDetail', 'ConsolePage'] as const;

/**
 * A V8 initiator stack as `../browser/fetch.ts` records it: the shared helper's
 * frames first, then the hook's effect, then React's own frames — which is
 * exactly what both mounts of one component produce, frame for frame.
 */
const HOOK_STACK = [
  '    at __orig (http://127.0.0.1:4100/_next/static/chunks/src_lib_client_1a._.js:610:30)',
  '    at __orig (http://127.0.0.1:4100/_next/static/chunks/src_lib_client_1a._.js:628:16)',
  '    at useReadings.useEffect (http://127.0.0.1:4100/_next/static/chunks/src_hooks_2b._.js:44:9)',
  '    at Object.react_stack_bottom_frame (http://127.0.0.1:4100/_next/static/chunks/react-dom_3c._.js:14944:22)',
].join('\n');

/** The same call site reached through different framework frames. */
const HOOK_STACK_OTHER_FRAMEWORK_FRAMES = [
  '    at __orig (http://127.0.0.1:4100/_next/static/chunks/src_lib_client_1a._.js:610:30)',
  '    at __orig (http://127.0.0.1:4100/_next/static/chunks/src_lib_client_1a._.js:628:16)',
  '    at useReadings.useEffect (http://127.0.0.1:4100/_next/static/chunks/src_hooks_2b._.js:44:9)',
  '    at runWithFiberInDEV (http://127.0.0.1:4100/_next/static/chunks/react-dom_3c._.js:761:74)',
].join('\n');

/** Where the service's source-map route resolved {@link HOOK_STACK}. */
const HOOK_SOURCE = makeSourceLocation('src/hooks/useReadings.ts', 44, 'useReadings');

describe('aggregateRequests initiator labels', () => {
  it('labels a resolved stack by its call site and keeps the stack beside the label', () => {
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({
          requestKey: initiatorKey('1'),
          initiator: HOOK_STACK,
          source: HOOK_SOURCE,
        }),
      ]),
    );
    const occurrence = occurrenceAt(group, 0);

    expect(occurrence.initiator).toBe('useReadings (src/hooks/useReadings.ts:44)');
    expect(occurrence.initiatorBasis).toBe('source');
    expect(occurrence.initiatorStack).toBe(HOOK_STACK);
    expect(occurrence.source).toStrictEqual(HOOK_SOURCE);
    expect(group.initiators).toStrictEqual(['useReadings (src/hooks/useReadings.ts:44)']);
  });

  it('labels a location without a symbol by its file and line alone', () => {
    const unnamed: SourceLocation = {
      file: HOOK_SOURCE.file,
      line: HOOK_SOURCE.line,
      column: HOOK_SOURCE.column,
      resolvedBy: HOOK_SOURCE.resolvedBy,
      confidence: HOOK_SOURCE.confidence,
    };
    const occurrence = occurrenceAt(
      onlyGroup(
        aggregateRequests([
          makeRequestEvent({
            requestKey: initiatorKey('2'),
            initiator: HOOK_STACK,
            source: unnamed,
          }),
        ]),
      ),
      0,
    );

    expect(occurrence.initiator).toBe('src/hooks/useReadings.ts:44');
    expect(occurrence.initiatorBasis).toBe('source');
  });

  it('gives one call site one initiator, whatever framework frames its stacks carried', () => {
    const requestKey = initiatorKey('3');
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({ requestKey, initiator: HOOK_STACK, source: HOOK_SOURCE }),
        makeRequestEvent({
          requestKey,
          initiator: HOOK_STACK_OTHER_FRAMEWORK_FRAMES,
          source: HOOK_SOURCE,
          startTime: BASE_TIME + 5,
        }),
      ]),
    );

    expect(group.count).toBe(2);
    expect(group.duplicateCount).toBe(1);
    expect(group.initiators).toStrictEqual(['useReadings (src/hooks/useReadings.ts:44)']);
    expect(group.occurrences.map((occurrence) => occurrence.initiatorStack)).toStrictEqual([
      HOOK_STACK,
      HOOK_STACK_OTHER_FRAMEWORK_FRAMES,
    ]);
  });

  it('falls back on the first frame, shortened to its file, when nothing resolved the stack', () => {
    const occurrence = occurrenceAt(
      onlyGroup(
        aggregateRequests([
          makeRequestEvent({ requestKey: initiatorKey('4'), initiator: HOOK_STACK }),
        ]),
      ),
      0,
    );

    expect(occurrence.initiator).toBe('__orig (src_lib_client_1a._.js:610:30)');
    expect(occurrence.initiatorBasis).toBe('frame');
    expect(occurrence.initiatorStack).toBe(HOOK_STACK);
    expect(Object.hasOwn(occurrence, 'source')).toBe(false);
  });

  it('reads the first frame past a message line, in both engines’ frame formats', () => {
    const labelOf = (initiator: string, label: string): string | undefined =>
      occurrenceAt(
        onlyGroup(
          aggregateRequests([makeRequestEvent({ requestKey: initiatorKey(label), initiator })]),
        ),
        0,
      ).initiator;

    expect(labelOf(`Error\n${HOOK_STACK}`, '5')).toBe('__orig (src_lib_client_1a._.js:610:30)');
    expect(labelOf('    at http://127.0.0.1:4100/chunks/anon_4d._.js:12:3', '6')).toBe(
      'anon_4d._.js:12:3',
    );
    expect(
      labelOf(
        'loadReadings@http://127.0.0.1:4100/chunks/src_hooks_2b._.js:44:9\n@debugger eval code:1:1',
        '7',
      ),
    ).toBe('loadReadings (src_hooks_2b._.js:44:9)');
    expect(labelOf('@http://127.0.0.1:4100/chunks/src_hooks_2b._.js:44:9', '8')).toBe(
      'src_hooks_2b._.js:44:9',
    );
  });

  it('keeps a label the producer wrote itself verbatim, with no basis and no stack', () => {
    const labels = ['WidgetPanel', 'at home', 'src/ui/list-row.ts:84:9', 'mail@example'];
    for (const [index, initiator] of labels.entries()) {
      const occurrence = occurrenceAt(
        onlyGroup(
          aggregateRequests([
            makeRequestEvent({
              requestKey: initiatorKey(`9${String(index)}`),
              initiator,
              source: HOOK_SOURCE,
            }),
          ]),
        ),
        0,
      );

      expect(occurrence.initiator).toBe(initiator);
      expect(Object.hasOwn(occurrence, 'initiatorBasis')).toBe(false);
      expect(Object.hasOwn(occurrence, 'initiatorStack')).toBe(false);
    }
  });

  it('names a component with one owner chain in its group by the component alone, keeping the chain', () => {
    const occurrence = occurrenceAt(
      onlyGroup(
        aggregateRequests([
          makeRequestEvent({
            requestKey: initiatorKey('a'),
            initiator: HOOK_STACK,
            source: HOOK_SOURCE,
            extraAttributes: {
              initiatorComponent: RAIL_COMPONENT,
              initiatorOwners: [...HEADER_OWNERS],
            },
          }),
        ]),
      ),
      0,
    );

    // Nothing in the group needs telling apart, so no framework wrapper is
    // named — and the whole chain is still there for a reader who wants it.
    expect(occurrence.initiator).toBe(RAIL_COMPONENT);
    expect(occurrence.initiatorOwners).toStrictEqual([...HEADER_OWNERS]);
    expect(occurrence.initiatorBasis).toBe('component');
    expect(occurrence.initiatorStack).toBe(HOOK_STACK);
    // The call site is still the occurrence's own: the label says who, the
    // location says where.
    expect(occurrence.source).toStrictEqual(HOOK_SOURCE);
  });

  it('tells two mounts of one component apart although their stacks are identical', () => {
    // AAP 0.8.2 defect 3: one duplicate group, two initiating components.
    const requestKey = initiatorKey('b');
    const mount = (owners: readonly string[], offsetMs: number): TelemetryEvent =>
      makeRequestEvent({
        requestKey,
        initiator: HOOK_STACK,
        source: HOOK_SOURCE,
        startTime: BASE_TIME + offsetMs,
        extraAttributes: { initiatorComponent: RAIL_COMPONENT, initiatorOwners: [...owners] },
      });

    const group = onlyGroup(
      aggregateRequests([
        mount(HEADER_OWNERS, 0),
        mount(DETAIL_OWNERS, 3),
        mount(HEADER_OWNERS, 400),
        mount(DETAIL_OWNERS, 404),
      ]),
    );

    expect(group.count).toBe(4);
    expect(group.duplicateCount).toBe(3);
    // The nearest owner already tells the mounts apart, so it is the only one
    // named; the shared `ConsolePage` above both would add nothing.
    expect(group.initiators).toStrictEqual([
      'ReadingsRail ‹ ConsoleHeader',
      'ReadingsRail ‹ GaugeDetail',
    ]);
    const counts = new Map<string, number>();
    for (const occurrence of group.occurrences) {
      const label = occurrence.initiator ?? '';
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    expect([...counts.entries()]).toStrictEqual([
      ['ReadingsRail ‹ ConsoleHeader', 2],
      ['ReadingsRail ‹ GaugeDetail', 2],
    ]);
    expect(group.occurrences.map((occurrence) => occurrence.initiatorOwners)).toStrictEqual([
      [...HEADER_OWNERS],
      [...DETAIL_OWNERS],
      [...HEADER_OWNERS],
      [...DETAIL_OWNERS],
    ]);
  });

  it('names as many owners as it takes to tell mounts apart, per component and in any order', () => {
    const requestKey = initiatorKey('g');
    const request = (
      component: string,
      owners: readonly string[],
      offsetMs: number,
    ): TelemetryEvent =>
      makeRequestEvent({
        requestKey,
        initiator: HOOK_STACK,
        source: HOOK_SOURCE,
        startTime: BASE_TIME + offsetMs,
        extraAttributes: { initiatorComponent: component, initiatorOwners: [...owners] },
      });
    const events = [
      // Two mounts that share their nearest owner and part at the second.
      request(RAIL_COMPONENT, ['Section', 'ConsoleHeader', 'ConsolePage'], 0),
      request(RAIL_COMPONENT, ['Section', 'GaugeDetail', 'ConsolePage'], 1),
      // A mount whose chain is a prefix of another's: told apart by length.
      request('GaugeDial', ['Section'], 2),
      request('GaugeDial', ['Section', 'ConsolePage'], 3),
      // A component with a single chain stays bare, whatever its neighbours need.
      request('StatusBar', ['ConsoleHeader', 'ConsolePage'], 4),
    ];

    const forward = onlyGroup(aggregateRequests(events));
    const backward = onlyGroup(aggregateRequests([...events].reverse()));

    expect(forward.initiators).toStrictEqual([
      'GaugeDial ‹ Section',
      'GaugeDial ‹ Section ‹ ConsolePage',
      'ReadingsRail ‹ Section ‹ ConsoleHeader',
      'ReadingsRail ‹ Section ‹ GaugeDetail',
      'StatusBar',
    ]);
    expect(backward.initiators).toStrictEqual(forward.initiators);
    expect(backward.occurrences).toStrictEqual(forward.occurrences);
  });

  it('decides the owner depth over every occurrence, not the published slice', () => {
    const requestKey = initiatorKey('h');
    const events = [HEADER_OWNERS, HEADER_OWNERS, DETAIL_OWNERS].map((owners, index) =>
      makeRequestEvent({
        requestKey,
        initiator: HOOK_STACK,
        startTime: BASE_TIME + index,
        extraAttributes: { initiatorComponent: RAIL_COMPONENT, initiatorOwners: [...owners] },
      }),
    );

    const group = onlyGroup(aggregateRequests(events, { maxOccurrencesPerGroup: 1 }));

    expect(group.occurrencesTruncated).toBe(true);
    expect(occurrenceAt(group, 0).initiator).toBe('ReadingsRail ‹ ConsoleHeader');
    expect(group.initiators).toStrictEqual([
      'ReadingsRail ‹ ConsoleHeader',
      'ReadingsRail ‹ GaugeDetail',
    ]);
  });

  it('labels a component with no owners by the component alone, even without a stack', () => {
    const occurrence = occurrenceAt(
      onlyGroup(
        aggregateRequests([
          makeRequestEvent({
            requestKey: initiatorKey('c'),
            omitAttributes: [INITIATOR_ATTRIBUTE],
            extraAttributes: { initiatorComponent: `  ${RAIL_COMPONENT}  `, initiatorOwners: [] },
          }),
        ]),
      ),
      0,
    );

    expect(occurrence.initiator).toBe(RAIL_COMPONENT);
    expect(occurrence.initiatorBasis).toBe('component');
    expect(Object.hasOwn(occurrence, 'initiatorStack')).toBe(false);
    expect(Object.hasOwn(occurrence, 'initiatorOwners')).toBe(false);
  });

  it('bounds the owner chain and each name, and skips owners that are not names', () => {
    const longName = `${'Q'.repeat(MAX_INITIATOR_NAME_LENGTH)}Overflow`;
    const owners: unknown[] = [
      '',
      '   ',
      7,
      null,
      { name: 'Hidden' },
      longName,
      ...Array.from(
        { length: MAX_INITIATOR_OWNER_NAMES + 3 },
        (_unused, index) => `Owner${String(index)}`,
      ),
    ];
    const occurrence = occurrenceAt(
      onlyGroup(
        aggregateRequests([
          makeRequestEvent({
            requestKey: initiatorKey('d'),
            initiator: HOOK_STACK,
            extraAttributes: {
              initiatorComponent: `${'R'.repeat(MAX_INITIATOR_NAME_LENGTH)}Overflow`,
              initiatorOwners: owners,
            },
          }),
        ]),
      ),
      0,
    );
    const kept = occurrence.initiatorOwners ?? [];

    expect(occurrence.initiator).toBe('R'.repeat(MAX_INITIATOR_NAME_LENGTH));
    expect(kept).toHaveLength(MAX_INITIATOR_OWNER_NAMES);
    expect(kept[0]).toBe('Q'.repeat(MAX_INITIATOR_NAME_LENGTH));
    expect(kept.at(-1)).toBe(`Owner${String(MAX_INITIATOR_OWNER_NAMES - 2)}`);
  });

  it('never cuts a full-length chain short, so the label bound cannot merge two mounts', () => {
    // Every name at its bound, and two chains that differ only in the last
    // owner's presence: the label that tells them apart is the longest one
    // the aggregate can build, and it must survive whole.
    const component = 'R'.repeat(MAX_INITIATOR_NAME_LENGTH);
    const longest = Array.from(
      { length: MAX_INITIATOR_OWNER_NAMES },
      (_unused, index) => `${'Q'.repeat(MAX_INITIATOR_NAME_LENGTH - 1)}${String(index)}`,
    );
    const requestKey = initiatorKey('i');
    const group = onlyGroup(
      aggregateRequests(
        [longest, longest.slice(0, -1)].map((owners, index) =>
          makeRequestEvent({
            requestKey,
            initiator: HOOK_STACK,
            startTime: BASE_TIME + index,
            extraAttributes: { initiatorComponent: component, initiatorOwners: owners },
          }),
        ),
      ),
    );
    const full = occurrenceAt(group, 0).initiator ?? '';

    expect(full.split(INITIATOR_OWNER_SEPARATOR)).toStrictEqual([component, ...longest]);
    expect([...full].length).toBe(MAX_INITIATOR_LABEL_LENGTH);
    expect(group.initiators).toHaveLength(2);
  });

  it('ignores component evidence that is not a name, and owners that are not a list', () => {
    const requestKey = initiatorKey('e');
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({
          requestKey,
          initiator: HOOK_STACK,
          source: HOOK_SOURCE,
          extraAttributes: { initiatorComponent: '   ', initiatorOwners: [...HEADER_OWNERS] },
        }),
        makeRequestEvent({
          requestKey,
          initiator: HOOK_STACK,
          source: HOOK_SOURCE,
          startTime: BASE_TIME + 1,
          extraAttributes: { initiatorComponent: 42 },
        }),
        makeRequestEvent({
          requestKey,
          initiator: HOOK_STACK,
          source: HOOK_SOURCE,
          startTime: BASE_TIME + 2,
          extraAttributes: { initiatorComponent: RAIL_COMPONENT, initiatorOwners: 'ConsoleHeader' },
        }),
      ]),
    );

    expect(group.occurrences.map((occurrence) => occurrence.initiatorBasis)).toStrictEqual([
      'source',
      'source',
      'component',
    ]);
    expect(group.initiators).toStrictEqual([
      RAIL_COMPONENT,
      'useReadings (src/hooks/useReadings.ts:44)',
    ]);
  });

  it('costs a hostile owner list only the owners it could not read', () => {
    const hostile = new Proxy([...HEADER_OWNERS], {
      get(target, property, receiver): unknown {
        if (property === '1') {
          throw new Error('the owner list is hostile by design');
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const occurrence = occurrenceAt(
      onlyGroup(
        aggregateRequests([
          makeRequestEvent({
            requestKey: initiatorKey('f'),
            initiator: HOOK_STACK,
            extraAttributes: { initiatorComponent: RAIL_COMPONENT, initiatorOwners: hostile },
          }),
        ]),
      ),
      0,
    );

    expect(occurrence.initiator).toBe(RAIL_COMPONENT);
    expect(occurrence.initiatorOwners).toStrictEqual(['ConsoleHeader']);
    expect(occurrence.initiatorBasis).toBe('component');
  });

  it('declares every basis it can publish', () => {
    expect([...REQUEST_INITIATOR_BASES]).toStrictEqual(['component', 'source', 'frame']);
    expect(Object.isFrozen(REQUEST_INITIATOR_BASES)).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Order, determinism and purity
 * ---------------------------------------------------------------------------
 */

describe('aggregateRequests ordering', () => {
  /** Keys labelled so that the keyed group ids sort in the same order. */
  const DUPLICATED_KEY = opaqueRequestKey('j1');
  const FREQUENT_KEY = opaqueRequestKey('j2');
  const SLOW_KEY = opaqueRequestKey('j3');
  const FAST_KEY = opaqueRequestKey('j4');
  const TIE_FIRST_KEY = opaqueRequestKey('j5');
  const TIE_SECOND_KEY = opaqueRequestKey('j6');

  /**
   * A capture carrying a tie at every level of the base order.
   *
   * `duplicated` leads on `duplicateCount`; `frequent` and the two-occurrence
   * groups tie there and are separated by `count`; `slow` and `fast` tie on
   * both and are separated by `totalDurationMs`; the last two tie on all three
   * and can only be separated by `id`.
   */
  function makeOrderingCapture(): TelemetryEvent[] {
    return [
      ...makeKeyedSeries(DUPLICATED_KEY, [0, 5], { duration: 1 }),
      ...makeKeyedSeries(FREQUENT_KEY, [0, 3000, 6000], { duration: 1 }),
      ...makeKeyedSeries(SLOW_KEY, [0, 3000], { duration: 50 }),
      ...makeKeyedSeries(FAST_KEY, [0, 3000], { duration: 5 }),
      ...makeKeyedSeries(TIE_FIRST_KEY, [0], { duration: 7 }),
      ...makeKeyedSeries(TIE_SECOND_KEY, [0], { duration: 7 }),
    ];
  }

  it('orders by redundancy, then frequency, then total time, then id', () => {
    const groups = aggregateRequests(makeOrderingCapture());

    expect(groups.map((group) => group.requestKey)).toStrictEqual([
      DUPLICATED_KEY,
      FREQUENT_KEY,
      SLOW_KEY,
      FAST_KEY,
      TIE_FIRST_KEY,
      TIE_SECOND_KEY,
    ]);
    // The shape of each tie, so a failure says which level broke.
    expect(groups.map((group) => group.duplicateCount)).toStrictEqual([1, 0, 0, 0, 0, 0]);
    expect(groups.map((group) => group.count)).toStrictEqual([2, 3, 2, 2, 1, 1]);
    expect(groups.map((group) => group.totalDurationMs)).toStrictEqual([2, 3, 100, 10, 7, 7]);
  });

  it('produces an identical result whatever order the events arrive in', () => {
    // The service pages this array with `limit`/`offset` and re-sorts per
    // `DataQuery.sort` (AAP 0.4.2). Without a total, arrival-independent base
    // order, two pages of one result could omit a group or repeat it.
    const events = makeOrderingCapture();

    const base = aggregateRequests(events);
    const shuffled = aggregateRequests(deterministicShuffle(events));

    expect(shuffled).toStrictEqual(base);
    expect(shuffled.map((group) => group.id)).toStrictEqual(base.map((group) => group.id));
    expect(countDuplicateRequests(shuffled)).toBe(countDuplicateRequests(base));
  });

  it('mutates neither the input array nor its events', () => {
    const events = [
      ...makeKeyedSeries(opaqueRequestKey('k1'), [0, 5, 10]),
      makeRequestEvent({
        requestKey: opaqueRequestKey('k2'),
        source: makeSourceLocation('src/ui/side-panel.ts', 21, 'refresh'),
        redacted: [`attributes.${URL_ATTRIBUTE}`],
        url: MASKED_ITEMS_URL,
        transferSize: 128,
      }),
    ];
    const snapshot = structuredClone(events);
    const references = [...events];

    const groups = aggregateRequests(events);

    expect(groups.length).toBeGreaterThan(0);
    expect(events).toStrictEqual(snapshot);
    expect(events).toHaveLength(references.length);
    events.forEach((event, index) => {
      expect(event).toBe(elementAt(references, index, 'an input event'));
    });
  });

  it('returns a result that survives the transports it travels on', () => {
    // These groups ride inside `CaptureSummary` over a WebSocket and answer
    // `POST /sessions/:id/panel-data` as the `requests` DataResult, so a value
    // that JSON cannot carry - a cycle, a `Set`, an `undefined` sitting on a
    // key - would fail at the boundary rather than here.
    const groups = aggregateRequests([
      ...makeKeyedSeries(opaqueRequestKey('k3'), [0, 7, 14, 22], { transferSize: 64 }),
      makeRequestEvent({ omitAttributes: [REQUEST_KEY_ATTRIBUTE] }),
    ]);

    expect(groups).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(groups))).toStrictEqual(groups);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Robustness
 *
 * `../schema/event.ts` checks attribute values only shallowly for
 * transportability, so an exotic value reaches an aggregate. The contract is
 * that a hostile attribute costs its own field and nothing else: the module
 * never throws, and the event never disappears from the totals. One malformed
 * event must not lose a batch of five thousand (AAP 0.5.5).
 * ---------------------------------------------------------------------------
 */

describe('aggregateRequests robustness', () => {
  it('labels a method or URL of the wrong type', () => {
    const events = [
      makeRequestEvent({
        requestKey: opaqueRequestKey('l1'),
        extraAttributes: { [METHOD_ATTRIBUTE]: 405 },
      }),
      makeRequestEvent({
        requestKey: opaqueRequestKey('l2'),
        startTime: BASE_TIME + 1,
        extraAttributes: { [URL_ATTRIBUTE]: { href: ITEMS_PATH } },
      }),
    ];

    const groups = aggregateRequests(events);

    expect(totalCount(groups)).toBe(events.length);
    expect(groupAt(groups, 0).method).toBe(UNKNOWN_METHOD_LABEL);
    expect(groupAt(groups, 0).url).toBe(ITEMS_PATH);
    expect(groupAt(groups, 1).url).toBe(UNKNOWN_URL_LABEL);
    expect(groupAt(groups, 1).path).toBe(UNKNOWN_URL_LABEL);
    expect(groupAt(groups, 1).method).toBe(GET_METHOD);
  });

  it('labels a blank or whitespace-only method or URL', () => {
    const events = [
      makeRequestEvent({
        requestKey: opaqueRequestKey('l3'),
        extraAttributes: { [METHOD_ATTRIBUTE]: '   ', [URL_ATTRIBUTE]: '' },
      }),
    ];

    const group = onlyGroup(aggregateRequests(events));

    expect(group.method).toBe(UNKNOWN_METHOD_LABEL);
    expect(group.url).toBe(UNKNOWN_URL_LABEL);
    expect(group.path).toBe(UNKNOWN_URL_LABEL);
    expect(group.count).toBe(1);
  });

  it('tolerates an attribute getter that throws', () => {
    const events = [
      makeRequestEvent({
        requestKey: opaqueRequestKey('l4'),
        throwingAttributes: [URL_ATTRIBUTE],
      }),
      makeRequestEvent({
        startTime: BASE_TIME + 1,
        throwingAttributes: [REQUEST_KEY_ATTRIBUTE],
      }),
    ];

    expect(() => aggregateRequests(events)).not.toThrow();

    const groups = aggregateRequests(events);
    const keyed = groups.filter((group) => group.groupedBy === BY_REQUEST_KEY);
    const fallback = groups.filter((group) => group.groupedBy === BY_METHOD_PATH);

    expect(totalCount(groups)).toBe(events.length);
    // The unreadable URL costs the URL and the path, nothing else.
    expect(keyed).toHaveLength(1);
    expect(elementAt(keyed, 0, 'the keyed group').url).toBe(UNKNOWN_URL_LABEL);
    expect(elementAt(keyed, 0, 'the keyed group').method).toBe(GET_METHOD);
    // The unreadable key costs the keyed space, and the event lands in the
    // documented fallback rather than vanishing.
    expect(fallback).toHaveLength(1);
    expect(elementAt(fallback, 0, 'the fallback group').path).toBe(ITEMS_PATH);
  });

  it('treats a blank key as no key and groups such events with the truly keyless', () => {
    const events = [
      makeRequestEvent({ extraAttributes: { [REQUEST_KEY_ATTRIBUTE]: '' } }),
      makeRequestEvent({
        startTime: BASE_TIME + 1,
        extraAttributes: { [REQUEST_KEY_ATTRIBUTE]: '   ' },
      }),
      makeRequestEvent({ startTime: BASE_TIME + 2, omitAttributes: [REQUEST_KEY_ATTRIBUTE] }),
    ];

    const group = onlyGroup(aggregateRequests(events));

    expect(group.groupedBy).toBe(BY_METHOD_PATH);
    expect(group.count).toBe(3);
    expect(group.requestKey).toBeUndefined();
  });

  it('treats a negative, NaN or infinite duration as no time at all', () => {
    const requestKey = opaqueRequestKey('l5');
    const events = [
      makeRequestEvent({ requestKey, duration: -5 }),
      makeRequestEvent({ requestKey, duration: Number.NaN, startTime: BASE_TIME + 2000 }),
      makeRequestEvent({
        requestKey,
        duration: Number.POSITIVE_INFINITY,
        startTime: BASE_TIME + 4000,
      }),
    ];

    const group = noDuplicates(onlyGroup(aggregateRequests(events)));

    // Zero, not `NaN`: one unusable reading must not poison a capture's totals
    // or make the group's sort position non-deterministic.
    expect(group.occurrences.map((occurrence) => occurrence.durationMs)).toStrictEqual([0, 0, 0]);
    expect(group.totalDurationMs).toBe(0);
    expect(group.averageDurationMs).toBe(0);
    expect(group.minDurationMs).toBe(0);
    expect(group.maxDurationMs).toBe(0);
    // `-0` is normalised, so a JSON round trip and an `Object.is` comparison
    // agree with each other.
    expect(Object.is(group.totalDurationMs, 0)).toBe(true);
    expect(Object.is(occurrenceAt(group, 0).durationMs, 0)).toBe(true);
  });

  it('keeps a group whose start time is unusable', () => {
    const events = [
      makeRequestEvent({
        requestKey: opaqueRequestKey('l6'),
        startTime: Number.NaN,
        duration: Number.NaN,
      }),
    ];

    const group = onlyGroup(aggregateRequests(events));
    const occurrence = occurrenceAt(group, 0);

    expect(group.count).toBe(1);
    expect(occurrence.startTime).toBe(0);
    expect(occurrence.durationMs).toBe(0);
    expect(occurrence.endTime).toBe(0);
    expect(group.firstStartTime).toBe(0);
    expect(group.lastStartTime).toBe(0);
    expect(Number.isNaN(group.averageDurationMs)).toBe(false);
  });

  it('ignores a status code that is not an integer', () => {
    const requestKey = opaqueRequestKey('l7');
    const events = [
      makeRequestEvent({ requestKey, extraAttributes: { [STATUS_CODE_ATTRIBUTE]: 200.5 } }),
      makeRequestEvent({
        requestKey,
        startTime: BASE_TIME + 2000,
        extraAttributes: { [STATUS_CODE_ATTRIBUTE]: '500' },
      }),
    ];

    const group = noDuplicates(onlyGroup(aggregateRequests(events)));

    // A code that cannot be read is no code; inventing one would put a failure
    // in the panel that the capture never observed.
    expect(group.statusCodes).toStrictEqual([]);
    expect(group.errorCount).toBe(0);
    expect(group.count).toBe(2);
  });

  it('ignores a transfer size that is negative or not a number', () => {
    const requestKey = opaqueRequestKey('l8');
    const events = [
      makeRequestEvent({ requestKey, transferSize: -1 }),
      makeRequestEvent({
        requestKey,
        startTime: BASE_TIME + 2000,
        extraAttributes: { [TRANSFER_SIZE_ATTRIBUTE]: 'unknown' },
      }),
    ];

    const group = noDuplicates(onlyGroup(aggregateRequests(events)));

    expect(group.transferredBytes).toBeUndefined();
    expect(Object.hasOwn(group, 'transferredBytes')).toBe(false);
    expect(group.count).toBe(2);
  });

  it('survives a capture in which every attribute is hostile at once', () => {
    const events = [
      makeRequestEvent({
        throwingAttributes: [
          METHOD_ATTRIBUTE,
          URL_ATTRIBUTE,
          STATUS_CODE_ATTRIBUTE,
          INITIATOR_ATTRIBUTE,
          TRANSFER_SIZE_ATTRIBUTE,
          REQUEST_KEY_ATTRIBUTE,
        ],
      }),
      makeRequestEvent({
        startTime: BASE_TIME + 1,
        throwingAttributes: [
          METHOD_ATTRIBUTE,
          URL_ATTRIBUTE,
          STATUS_CODE_ATTRIBUTE,
          INITIATOR_ATTRIBUTE,
          TRANSFER_SIZE_ATTRIBUTE,
          REQUEST_KEY_ATTRIBUTE,
        ],
      }),
    ];

    const group = onlyGroup(aggregateRequests(events));

    // Both events reduce to the same labelled fallback identity, and both are
    // still counted: the worst case is an uninformative row, never a lost one.
    expect(group.groupedBy).toBe(BY_METHOD_PATH);
    expect(group.method).toBe(UNKNOWN_METHOD_LABEL);
    expect(group.url).toBe(UNKNOWN_URL_LABEL);
    expect(group.count).toBe(events.length);
    expect(group.statusCodes).toStrictEqual([]);
    expect(group.initiators).toStrictEqual([]);
    expect(group.transferredBytes).toBeUndefined();
  });
});

/*
 * ---------------------------------------------------------------------------
 * The published contract
 *
 * Every export of `./requests.ts` is exercised here or above, and each default
 * is asserted to be what the no-options path actually uses - a constant that
 * merely *claims* to be the default is a documentation bug that no other case
 * would catch.
 * ---------------------------------------------------------------------------
 */

describe('the requests module contract', () => {
  it('exports the duplicate window the no-options path applies', () => {
    expect(Number.isFinite(DEFAULT_DUPLICATE_WINDOW_MS)).toBe(true);
    expect(DEFAULT_DUPLICATE_WINDOW_MS).toBeGreaterThan(0);

    const events = makeKeyedSeries(opaqueRequestKey('m1'), [0, 7, 14, 22]);

    expect(aggregateRequests(events)).toStrictEqual(
      aggregateRequests(events, { duplicateWindowMs: DEFAULT_DUPLICATE_WINDOW_MS }),
    );
  });

  it('exports the occurrence bound the no-options path applies, and its request-scoped alias', () => {
    expect(Number.isInteger(DEFAULT_MAX_OCCURRENCES_PER_GROUP)).toBe(true);
    expect(DEFAULT_MAX_OCCURRENCES_PER_GROUP).toBeGreaterThan(0);
    // The alias exists so the flat aggregate barrel can re-export one
    // unambiguous name; it must stay the same bound, not a second policy.
    expect(DEFAULT_MAX_REQUEST_OCCURRENCES_PER_GROUP).toBe(DEFAULT_MAX_OCCURRENCES_PER_GROUP);

    const events = makeKeyedSeries(opaqueRequestKey('m2'), [0, 5]);

    expect(aggregateRequests(events)).toStrictEqual(
      aggregateRequests(events, {
        maxOccurrencesPerGroup: DEFAULT_MAX_REQUEST_OCCURRENCES_PER_GROUP,
      }),
    );
  });

  it('publishes the two key spaces as a frozen, duplicate-free vocabulary', () => {
    expect(Object.isFrozen(REQUEST_GROUPED_BY)).toBe(true);
    expect(REQUEST_GROUPED_BY).toStrictEqual([BY_REQUEST_KEY, BY_METHOD_PATH]);
    expect(new Set(REQUEST_GROUPED_BY).size).toBe(REQUEST_GROUPED_BY.length);
  });

  it('publishes labels no real method or URL can collide with', () => {
    expect(UNKNOWN_METHOD_LABEL).not.toBe(UNKNOWN_URL_LABEL);
    for (const label of [UNKNOWN_METHOD_LABEL, UNKNOWN_URL_LABEL]) {
      expect(label.length).toBeGreaterThan(0);
      // A space: no HTTP method token and no URL may contain one, so a labelled
      // group can never be mistaken for an observed value.
      expect(label).toContain(' ');
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The resource-timing join
 *
 * No request API reports how many bytes crossed the wire; only
 * `PerformanceResourceTiming` does (AAP 0.6.6), and `../browser/perf.ts`
 * observes those entries as `perf.entry` events of their own. This section is
 * the consuming half of that contract: it pins the identity the two producers
 * agree on, the timing constraint that makes a masked URL safe to join on, and
 * the one-entry-one-request rule the `transferred_bytes` metric depends on.
 *
 * Why each case earns its place:
 *
 * - **Identity.** A request is written `/api/items` and its entry is named
 *   `http://app.localhost/api/items`, so without the resolved identity the
 *   producer emits there is nothing to match and the bytes are lost. Both the
 *   resolved key and the as-written fallback are asserted.
 * - **Timing.** Redaction masks `?productId=A` and `?productId=B` to one
 *   string, so identity alone would let one response's bytes land on a
 *   different request. The two-requests-one-URL case is the decisive one: each
 *   occurrence must take *its own* entry.
 * - **Exposure.** A cross-origin response reports `transferSize: 0` with
 *   nothing measured, and counting that zero is what AAP 0.8.4 forbids. The
 *   truth table of `readExposedTransferSize` is asserted directly, because
 *   `./summary.ts` publishes the metric from the same reader.
 * - **Claims.** `./summary.ts` adds the entries *nobody* claimed, so an entry
 *   a request accounted for must be reported as claimed even when the
 *   request's own reading won. A missing claim double-counts a response on the
 *   metric card while the table stays right.
 *
 * Fixture URLs stay invented and stay in their redacted form, exactly as the
 * rest of this file's do.
 * ---------------------------------------------------------------------------
 */

/** The origin a fixture's resolved identity is built against; invented. */
const RESOURCE_FIXTURE_ORIGIN = 'http://app.localhost';

/** The `entry.type` of a paint mark: a `perf.entry` that never carries bytes. */
const PAINT_ENTRY_TYPE = 'paint';

/** What a resource-timing fixture may state. */
interface ResourceEventOverrides {
  /** The entry's URL; absolute in a real capture. */
  readonly url?: string;
  /** Start of the load, in epoch milliseconds. */
  readonly startTime?: number;
  /** Duration of the load, in milliseconds. */
  readonly duration?: number;
  /** The measured size. */
  readonly transferSize?: number;
  /** The producer's exposure verdict; omitted when the case is about absence. */
  readonly transferSizeExposed?: boolean;
  /** `fetch`, `xmlhttprequest`, `link`, … */
  readonly initiatorType?: string;
  /** `resource` unless the case is about a paint mark. */
  readonly entryType?: string;
  /** A fixed id, for the cases that assert on which entry was claimed. */
  readonly id?: EventId;
}

/**
 * One persisted resource-timing event, as `../browser/perf.ts` emits it.
 *
 * `entry.type` and the exposure verdict are present by default because a real
 * producer always writes both; a case that wants an unlabelled or legacy entry
 * says so. The kind and tier come from the schema, so every fixture satisfies
 * the persisted event contract by construction.
 */
function makeResourceEvent(overrides: ResourceEventOverrides = {}): TelemetryEvent {
  const attributes: Record<string, unknown> = {
    [ENTRY_TYPE_ATTRIBUTE]: overrides.entryType ?? RESOURCE_ENTRY_TYPE,
  };
  if (overrides.url !== undefined) {
    attributes[URL_ATTRIBUTE] = overrides.url;
  }
  if (overrides.initiatorType !== undefined) {
    attributes[INITIATOR_TYPE_ATTRIBUTE] = overrides.initiatorType;
  }
  if (overrides.transferSize !== undefined) {
    attributes[TRANSFER_SIZE_ATTRIBUTE] = overrides.transferSize;
  }
  if (overrides.transferSizeExposed !== undefined) {
    attributes[TRANSFER_SIZE_EXPOSED_ATTRIBUTE] = overrides.transferSizeExposed;
  }

  return {
    id: overrides.id ?? nextEventId(),
    traceId: nextTraceId(),
    spanId: nextSpanId(),
    kind: RESOURCE_ENTRY_EVENT_KIND,
    name: RESOURCE_ENTRY_TYPE,
    startTime: overrides.startTime ?? BASE_TIME,
    duration: overrides.duration ?? DEFAULT_DURATION_MS,
    tier: firstAllowedTier(RESOURCE_ENTRY_EVENT_KIND),
    attributes,
    status: OK_STATUS,
    producerId: PRODUCER_ID,
    seq: nextSeq(),
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq: nextIngestSeq(),
  };
}

describe('aggregateRequests resource-timing join', () => {
  it('attributes a resource entry to the request that caused it, by resolved identity', () => {
    // The shape a real capture has: the application wrote a relative URL, so
    // the request event carries the absolute identity beside it, and the entry
    // is named by that absolute URL alone.
    const requestKey = opaqueRequestKey('j1');
    const request = makeRequestEvent({
      requestKey,
      url: ITEMS_PATH,
      extraAttributes: {
        [RESOURCE_TIMING_URL_ATTRIBUTE]: `${RESOURCE_FIXTURE_ORIGIN}${ITEMS_PATH}`,
      },
    });
    const entry = makeResourceEvent({
      url: `${RESOURCE_FIXTURE_ORIGIN}${ITEMS_PATH}`,
      transferSize: 4096,
      transferSizeExposed: true,
      initiatorType: 'fetch',
    });

    const group = onlyGroup(aggregateRequests([request, entry]));
    const occurrence = occurrenceAt(group, 0);

    expect(occurrence.transferredBytes).toBe(4096);
    expect(occurrence.transferSource).toBe('resource-timing');
    expect(occurrence.transferEventId).toBe(entry.id);
    expect(group.transferredBytes).toBe(4096);
    expect(group.transferEventIds).toStrictEqual([entry.id]);
    // The entry is evidence about a request, never a request of its own.
    expect(group.count).toBe(1);
  });

  it('falls back to the URL as written when no resolved identity was reported', () => {
    // A producer that predates `resourceTimingUrl`, or an application that
    // wrote the absolute URL itself: the display URL is then the identity.
    const requestKey = opaqueRequestKey('j2');
    const absolute = `${RESOURCE_FIXTURE_ORIGIN}${THINGS_PATH}`;
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({ requestKey, url: absolute }),
        makeResourceEvent({ url: absolute, transferSize: 128, transferSizeExposed: true }),
      ]),
    );

    expect(group.transferredBytes).toBe(128);
    expect(occurrenceAt(group, 0).transferSource).toBe('resource-timing');
  });

  it('joins nothing when no entry names the same URL', () => {
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({ requestKey: opaqueRequestKey('j3'), url: ITEMS_PATH }),
        makeResourceEvent({ url: THINGS_PATH, transferSize: 900, transferSizeExposed: true }),
      ]),
    );

    expect(group.transferredBytes).toBeUndefined();
    expect(Object.hasOwn(group, 'transferredBytes')).toBe(false);
    expect(Object.hasOwn(group, 'transferEventIds')).toBe(false);
    expect(Object.hasOwn(occurrenceAt(group, 0), 'transferSource')).toBe(false);
  });

  it('joins nothing when the entry started outside the request window and the tolerance', () => {
    const requestKey = opaqueRequestKey('j4');
    const events = [
      makeRequestEvent({ requestKey, url: ITEMS_PATH, startTime: BASE_TIME, duration: 10 }),
      makeResourceEvent({
        url: ITEMS_PATH,
        // Past the request's end (BASE_TIME + 10) by more than the tolerance.
        startTime: BASE_TIME + 10 + DEFAULT_RESOURCE_TIMING_TOLERANCE_MS + 1,
        transferSize: 512,
        transferSizeExposed: true,
      }),
    ];

    expect(onlyGroup(aggregateRequests(events)).transferredBytes).toBeUndefined();

    // The boundary is inclusive, and the tolerance is an option: widening it
    // by one millisecond admits exactly this entry.
    const widened = onlyGroup(
      aggregateRequests(events, {
        resourceTimingToleranceMs: DEFAULT_RESOURCE_TIMING_TOLERANCE_MS + 1,
      }),
    );

    expect(widened.transferredBytes).toBe(512);
  });

  it('gives each of two requests for one masked URL its own entry', () => {
    // The decisive case. Both requests display as `…?productId=?` and only
    // their keys keep them apart; two responses of different sizes arrived.
    // Identity alone cannot tell which is which, so the nearest start decides
    // and neither entry may be counted twice.
    const events = [
      makeRequestEvent({
        requestKey: opaqueRequestKey('j5a'),
        url: MASKED_ITEMS_URL,
        startTime: BASE_TIME,
        duration: 8,
      }),
      makeRequestEvent({
        requestKey: opaqueRequestKey('j5b'),
        url: MASKED_ITEMS_URL,
        startTime: BASE_TIME + 30,
        duration: 8,
      }),
      makeResourceEvent({ url: MASKED_ITEMS_URL, startTime: BASE_TIME, transferSize: 100 }),
      makeResourceEvent({ url: MASKED_ITEMS_URL, startTime: BASE_TIME + 30, transferSize: 700 }),
    ];

    const groups = aggregateRequests(events);
    const first = groups.find((group) => group.transferredBytes === 100);
    const second = groups.find((group) => group.transferredBytes === 700);

    expect(groups).toHaveLength(2);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Two distinct claims: the sum over the capture is 800, never 1400 and
    // never 200.
    const claimed = groups.flatMap((group) => [...(group.transferEventIds ?? [])]);
    expect(new Set(claimed).size).toBe(2);
    expect(groups.reduce((sum, group) => sum + (group.transferredBytes ?? 0), 0)).toBe(800);
  });

  it('never lets one entry answer for two occurrences that both fit it', () => {
    // The one-entry-one-request rule, isolated. Both occurrences of this group
    // qualify for the single entry on identity *and* timing — it started
    // between them, well inside both windows — so the rule is the only thing
    // deciding the total. Without it the group would report 128 bytes for a
    // 64-byte response, and `transferred_bytes` would inherit the error.
    const requestKey = opaqueRequestKey('j6');
    const entry = makeResourceEvent({
      url: ITEMS_PATH,
      startTime: BASE_TIME + 1,
      transferSize: 64,
      transferSizeExposed: true,
    });
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({ requestKey, url: ITEMS_PATH, startTime: BASE_TIME, duration: 4 }),
        makeRequestEvent({ requestKey, url: ITEMS_PATH, startTime: BASE_TIME + 3, duration: 4 }),
        entry,
      ]),
    );

    expect(group.count).toBe(2);
    expect(group.transferredBytes).toBe(64);
    expect(group.transferEventIds).toStrictEqual([entry.id]);
    // The earlier occurrence takes it, since the join walks occurrences in
    // canonical order; the later one reports nothing rather than borrowing the
    // same number.
    expect(occurrenceAt(group, 0).transferEventId).toBe(entry.id);
    expect(Object.hasOwn(occurrenceAt(group, 1), 'transferEventId')).toBe(false);
    expect(Object.hasOwn(occurrenceAt(group, 1), 'transferredBytes')).toBe(false);
  });

  it('leaves a request unjoined when the only entry belongs to another one', () => {
    // Two requests for one URL far apart in time, one entry: the timing
    // constraint hands it to the request it actually describes, and the other
    // reports nothing.
    const events = [
      makeRequestEvent({
        requestKey: opaqueRequestKey('j6a'),
        url: ITEMS_PATH,
        startTime: BASE_TIME,
        duration: 5,
      }),
      makeRequestEvent({
        requestKey: opaqueRequestKey('j6b'),
        url: ITEMS_PATH,
        startTime: BASE_TIME + 500,
        duration: 5,
      }),
      makeResourceEvent({ url: ITEMS_PATH, startTime: BASE_TIME + 500, transferSize: 64 }),
    ];

    const groups = aggregateRequests(events);
    const withBytes = groups.filter((group) => group.transferredBytes !== undefined);

    expect(groups).toHaveLength(2);
    expect(withBytes).toHaveLength(1);
    expect(elementAt(withBytes, 0, 'the joined group').transferredBytes).toBe(64);
  });

  it('prefers the entry whose initiator type matches the request transport', () => {
    // A page that preloads a URL and then fetches it produces two entries for
    // one URL in one window. The fetch's own entry is the one that describes
    // the request; the preload's is a different load of the same resource.
    const requestKey = opaqueRequestKey('j7');
    const fetchEntryId = nextEventId();
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({ requestKey, url: ITEMS_PATH, startTime: BASE_TIME, duration: 20 }),
        makeResourceEvent({
          url: ITEMS_PATH,
          startTime: BASE_TIME,
          transferSize: 10,
          initiatorType: 'link',
        }),
        makeResourceEvent({
          id: fetchEntryId,
          url: ITEMS_PATH,
          startTime: BASE_TIME + 5,
          transferSize: 2048,
          initiatorType: 'fetch',
        }),
      ]),
    );

    // Chosen despite starting further from the request: the transport match
    // outranks proximity.
    expect(group.transferredBytes).toBe(2048);
    expect(group.transferEventIds).toStrictEqual([fetchEntryId]);
  });

  it('leaves a lone entry unclaimed when its transport contradicts the request', () => {
    // The same collision with the fetch's own entry missing — a cross-origin
    // response, a service worker that answered from a cache, a buffer that had
    // already rolled over. All that is left is the preload's entry: the same
    // URL, inside the window, and demonstrably a *different* load, because a
    // fetch is never attributed to `link`.
    //
    // Nothing here is a matter of degree. Taking it as a last resort would put
    // the preload's byte count on the fetch's row and into
    // `transferred_bytes`, where it reads as a measurement of this request;
    // declining leaves the column empty, which AAP 0.6.6 provides for and a
    // developer can act on. The group survives either way — this only decides
    // whether it carries a number that is about something else.
    const requestKey = opaqueRequestKey('j7b');
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({ requestKey, url: ITEMS_PATH, startTime: BASE_TIME, duration: 20 }),
        makeResourceEvent({
          url: ITEMS_PATH,
          startTime: BASE_TIME,
          transferSize: 10,
          initiatorType: 'link',
        }),
      ]),
    );

    expect(group.transferredBytes).toBeUndefined();
    expect(Object.hasOwn(group, 'transferEventIds')).toBe(false);
    // Still one request, counted and timed: only the byte claim was refused.
    expect(group.count).toBe(1);
  });

  it('claims an entry that names no transport, which most hosts do not', () => {
    // The boundary the case above is drawn against. An absent `initiatorType`
    // — a shimmed host, a redirect chain, a service-worker response — is not
    // evidence of a different load, so identity and timing still decide, as
    // they did before any transport was consulted.
    const entryId = nextEventId();
    const requestKey = opaqueRequestKey('j7c');
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({ requestKey, url: ITEMS_PATH, startTime: BASE_TIME, duration: 20 }),
        makeResourceEvent({ id: entryId, url: ITEMS_PATH, startTime: BASE_TIME, transferSize: 10 }),
      ]),
    );

    expect(group.transferredBytes).toBe(10);
    expect(group.transferEventIds).toStrictEqual([entryId]);
  });

  it('ignores an entry whose bytes the host did not expose, and a paint mark', () => {
    const requestKey = opaqueRequestKey('j8');
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({ requestKey, url: ITEMS_PATH }),
        // A cross-origin response without `Timing-Allow-Origin`: the zero is
        // the specification's "not exposed", not a measurement.
        makeResourceEvent({ url: ITEMS_PATH, transferSize: 0, transferSizeExposed: false }),
        // A paint mark carrying a size it has no business carrying.
        makeResourceEvent({
          url: ITEMS_PATH,
          entryType: PAINT_ENTRY_TYPE,
          transferSize: 5000,
          transferSizeExposed: true,
        }),
      ]),
    );

    expect(group.transferredBytes).toBeUndefined();
    expect(Object.hasOwn(group, 'transferEventIds')).toBe(false);
  });

  it('keeps the request’s own exposed size authoritative, and still records the claim', () => {
    // The page's own account of its own request wins; the entry is claimed all
    // the same, because `./summary.ts` adds the entries nobody claimed and
    // this response has already been counted.
    const requestKey = opaqueRequestKey('j9');
    const entry = makeResourceEvent({
      url: ITEMS_PATH,
      transferSize: 4000,
      transferSizeExposed: true,
    });
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({ requestKey, url: ITEMS_PATH, transferSize: 1234 }),
        entry,
      ]),
    );
    const occurrence = occurrenceAt(group, 0);

    expect(occurrence.transferredBytes).toBe(1234);
    expect(occurrence.transferSource).toBe('request');
    expect(occurrence.transferEventId).toBe(entry.id);
    expect(group.transferredBytes).toBe(1234);
    expect(group.transferEventIds).toStrictEqual([entry.id]);
  });

  it('sums a group’s joined occurrences and lists every claim, ascending', () => {
    const requestKey = opaqueRequestKey('ja');
    const events = [
      makeRequestEvent({ requestKey, url: ITEMS_PATH, startTime: BASE_TIME, duration: 4 }),
      makeRequestEvent({ requestKey, url: ITEMS_PATH, startTime: BASE_TIME + 9, duration: 4 }),
      makeResourceEvent({ url: ITEMS_PATH, startTime: BASE_TIME, transferSize: 300 }),
      makeResourceEvent({ url: ITEMS_PATH, startTime: BASE_TIME + 9, transferSize: 45 }),
    ];

    const group = onlyGroup(aggregateRequests(events));
    const claims = [...(group.transferEventIds ?? [])];

    expect(group.count).toBe(2);
    expect(group.duplicateCount).toBe(1);
    expect(group.transferredBytes).toBe(345);
    expect(claims).toHaveLength(2);
    expect(claims).toStrictEqual([...claims].sort());
  });

  it('pairs identically however the events arrive', () => {
    const events = [
      makeRequestEvent({
        requestKey: opaqueRequestKey('jb1'),
        url: MASKED_ITEMS_URL,
        startTime: BASE_TIME,
        duration: 6,
      }),
      makeRequestEvent({
        requestKey: opaqueRequestKey('jb2'),
        url: MASKED_ITEMS_URL,
        startTime: BASE_TIME + 20,
        duration: 6,
      }),
      makeResourceEvent({ url: MASKED_ITEMS_URL, startTime: BASE_TIME, transferSize: 11 }),
      makeResourceEvent({ url: MASKED_ITEMS_URL, startTime: BASE_TIME + 20, transferSize: 22 }),
      makeResourceEvent({ url: THINGS_PATH, startTime: BASE_TIME + 1, transferSize: 33 }),
    ];

    // The join runs over occurrences in canonical order, so the pairing is a
    // function of the events and not of their arrival order — the property the
    // service's paging depends on for every aggregate.
    expect(aggregateRequests([...events].reverse())).toStrictEqual(aggregateRequests(events));
  });

  it('does not mutate the resource entries it reads', () => {
    const entry = makeResourceEvent({ url: ITEMS_PATH, transferSize: 77 });
    const before = JSON.parse(JSON.stringify(entry)) as unknown;

    aggregateRequests([
      makeRequestEvent({ requestKey: opaqueRequestKey('jc'), url: ITEMS_PATH }),
      entry,
    ]);

    expect(JSON.parse(JSON.stringify(entry))).toStrictEqual(before);
  });

  it('survives a resource entry whose every attribute is hostile', () => {
    const entry = makeResourceEvent({ url: ITEMS_PATH, transferSize: 88 });
    for (const key of [
      ENTRY_TYPE_ATTRIBUTE,
      URL_ATTRIBUTE,
      TRANSFER_SIZE_ATTRIBUTE,
      TRANSFER_SIZE_EXPOSED_ATTRIBUTE,
      INITIATOR_TYPE_ATTRIBUTE,
    ]) {
      Object.defineProperty(entry.attributes, key, {
        configurable: true,
        enumerable: true,
        get(): never {
          throw new Error(`the "${key}" attribute is hostile by design`);
        },
      });
    }

    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({ requestKey: opaqueRequestKey('jd'), url: ITEMS_PATH }),
        entry,
      ]),
    );

    expect(group.count).toBe(1);
    expect(group.transferredBytes).toBeUndefined();
  });
});

describe('readExposedTransferSize', () => {
  it('takes a reading the producer says was exposed, zero included', () => {
    // A same-origin response served from cache transferred nothing, and that
    // is an observation rather than a gap.
    expect(
      readExposedTransferSize(makeResourceEvent({ transferSize: 0, transferSizeExposed: true })),
    ).toBe(0);
    expect(
      readExposedTransferSize(makeResourceEvent({ transferSize: 950, transferSizeExposed: true })),
    ).toBe(950);
  });

  it('refuses a reading the producer says was not exposed, however large', () => {
    // An explicit `false` is decisive: whatever number sits beside it is the
    // host's placeholder, not a measurement.
    expect(
      readExposedTransferSize(makeResourceEvent({ transferSize: 0, transferSizeExposed: false })),
    ).toBeUndefined();
    expect(
      readExposedTransferSize(makeResourceEvent({ transferSize: 700, transferSizeExposed: false })),
    ).toBeUndefined();
  });

  it('accepts a positive number and refuses a bare zero when the producer said nothing', () => {
    // The legacy case. A positive figure is still evidence; a zero with no
    // verdict cannot be told from a withheld count, so the metric must be able
    // to report `n/a` rather than claim a measurement (AAP 0.6.6, 0.8.4).
    expect(readExposedTransferSize(makeResourceEvent({ transferSize: 42 }))).toBe(42);
    expect(readExposedTransferSize(makeResourceEvent({ transferSize: 0 }))).toBeUndefined();
  });

  it('refuses anything that is not a usable number', () => {
    expect(readExposedTransferSize(makeResourceEvent())).toBeUndefined();
    expect(
      readExposedTransferSize(makeResourceEvent({ transferSize: -1, transferSizeExposed: true })),
    ).toBeUndefined();
    expect(
      readExposedTransferSize(
        makeRequestEvent({ extraAttributes: { [TRANSFER_SIZE_ATTRIBUTE]: 'a lot' } }),
      ),
    ).toBeUndefined();
  });
});

describe('the resource-timing contract', () => {
  it('spells the two invented attribute keys exactly as the producers write them', () => {
    // Neither key is in `../schema/attributes.ts` yet, so the producer and the
    // consumer each spell it once: `../browser/fetch.ts` writes
    // `resourceTimingUrl` and `../browser/perf.ts` writes
    // `transferSizeExposed`. Pinning the literals here is what makes a
    // one-sided rename a test failure instead of a column that silently stops
    // populating. When the catalog adopts them, these assertions become a
    // check that the constants follow it.
    expect(RESOURCE_TIMING_URL_ATTRIBUTE).toBe('resourceTimingUrl');
    expect(TRANSFER_SIZE_EXPOSED_ATTRIBUTE).toBe('transferSizeExposed');
    // Both are producer-supplied, so neither may be mistaken for a
    // service-assigned key that redaction exempts from masking.
    for (const key of [RESOURCE_TIMING_URL_ATTRIBUTE, TRANSFER_SIZE_EXPOSED_ATTRIBUTE]) {
      expect(SERVICE_ASSIGNED_ATTRIBUTE_KEYS).not.toContain(key);
    }
  });

  it('exports the tolerance the no-options path applies', () => {
    expect(Number.isFinite(DEFAULT_RESOURCE_TIMING_TOLERANCE_MS)).toBe(true);
    expect(DEFAULT_RESOURCE_TIMING_TOLERANCE_MS).toBeGreaterThan(0);

    const events = [
      makeRequestEvent({ requestKey: opaqueRequestKey('n1'), url: ITEMS_PATH }),
      makeResourceEvent({ url: ITEMS_PATH, transferSize: 64 }),
    ];

    expect(aggregateRequests(events)).toStrictEqual(
      aggregateRequests(events, {
        resourceTimingToleranceMs: DEFAULT_RESOURCE_TIMING_TOLERANCE_MS,
      }),
    );
  });

  it('falls back to the default tolerance for an unusable option', () => {
    const events = [
      makeRequestEvent({ requestKey: opaqueRequestKey('n2'), url: ITEMS_PATH }),
      makeResourceEvent({ url: ITEMS_PATH, transferSize: 64 }),
    ];
    const expected = aggregateRequests(events);

    for (const resourceTimingToleranceMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(aggregateRequests(events, { resourceTimingToleranceMs })).toStrictEqual(expected);
    }
  });

  it('publishes the transfer sources as a frozen, duplicate-free vocabulary', () => {
    expect(Object.isFrozen(REQUEST_TRANSFER_SOURCES)).toBe(true);
    expect(new Set(REQUEST_TRANSFER_SOURCES).size).toBe(REQUEST_TRANSFER_SOURCES.length);
    expect(REQUEST_TRANSFER_SOURCES).toContain('request');
    expect(REQUEST_TRANSFER_SOURCES).toContain('resource-timing');
  });

  it('names the resource entry type the join and the summary both test for', () => {
    expect(RESOURCE_ENTRY_TYPE).toBe('resource');
  });
});

/*
 * ---------------------------------------------------------------------------
 * In-flight snapshots
 *
 * A request still on the wire when its capture ended is reported by
 * `../browser/fetch.ts` as one snapshot event carrying the in-flight marker,
 * no status code and span status `unset`. What these cases pin, and why:
 *
 * - **Only the marker makes a request pending.** A network error, an abort and
 *   an opaque response all settle without a code, so a missing code read as
 *   "still waiting" would state something the capture never observed.
 * - **A pending occurrence says nothing about a response.** No code, no
 *   failure, no bytes and no resource-timing claim — a claim would take an
 *   entry away from the settled request it belongs to, or from the unclaimed
 *   total `./summary.ts` adds.
 * - **One request is one occurrence.** A settled event supersedes a snapshot of
 *   its own span and several snapshots of one span collapse to the latest, or
 *   the duplicate-request finding would be raised against a request and its own
 *   snapshot.
 * - **Nothing else moves.** A capture with no snapshot keeps every group shape
 *   it had, `pendingCount` included by its absence.
 * ---------------------------------------------------------------------------
 */

/**
 * One in-flight snapshot, shaped as the producer emits it: the marker, span
 * status `unset` and no status code.
 *
 * Built on {@link makeRequestEvent} so every other attribute is the default a
 * settled fixture carries; `overrides` may still reinstate a status code or a
 * status, which is how the cases that ignore one are stated.
 */
function makeInFlightEvent(overrides: RequestEventOverrides = {}): TelemetryEvent {
  return makeRequestEvent({
    status: UNSET_STATUS,
    ...overrides,
    omitAttributes:
      overrides.statusCode === undefined
        ? [STATUS_CODE_ATTRIBUTE, ...(overrides.omitAttributes ?? [])]
        : [...(overrides.omitAttributes ?? [])],
    extraAttributes: { ...overrides.extraAttributes, [REQUEST_IN_FLIGHT_ATTRIBUTE]: true },
  });
}

describe('aggregateRequests in-flight snapshots', () => {
  it('builds snapshot fixtures the persisted event schema accepts', () => {
    const snapshot = makeInFlightEvent();

    expect(isTelemetryEvent(snapshot)).toBe(true);
    expect(snapshot.attributes[REQUEST_IN_FLIGHT_ATTRIBUTE]).toBe(true);
    expect(Object.hasOwn(snapshot.attributes, STATUS_CODE_ATTRIBUTE)).toBe(false);
    expect(snapshot.status).toBe(UNSET_STATUS);
  });

  it('marks an occurrence pending only when the marker is the boolean true', () => {
    // Every fixture here lacks a status code, which is the point: the absence
    // is shared, and only the first one is pending.
    const markerKey = opaqueRequestKey('p1');
    const markers: readonly (readonly [string, unknown])[] = [
      [opaqueRequestKey('p2'), 'true'],
      [opaqueRequestKey('p3'), 1],
      [opaqueRequestKey('p4'), false],
    ];
    const absentKey = opaqueRequestKey('p5');
    const events = [
      makeInFlightEvent({ requestKey: markerKey }),
      ...markers.map(([requestKey, value]) =>
        makeRequestEvent({
          requestKey,
          status: UNSET_STATUS,
          omitAttributes: [STATUS_CODE_ATTRIBUTE],
          extraAttributes: { [REQUEST_IN_FLIGHT_ATTRIBUTE]: value },
        }),
      ),
      makeRequestEvent({
        requestKey: absentKey,
        status: UNSET_STATUS,
        omitAttributes: [STATUS_CODE_ATTRIBUTE],
      }),
    ];

    const groups = aggregateRequests(events);
    expect(totalCount(groups)).toBe(events.length);

    for (const group of groups) {
      const occurrence = occurrenceAt(group, 0);
      if (group.requestKey === markerKey) {
        expect(occurrence.pending).toBe(true);
        expect(group.pendingCount).toBe(1);
        continue;
      }
      expect(Object.hasOwn(occurrence, 'pending')).toBe(false);
      expect(Object.hasOwn(group, 'pendingCount')).toBe(false);
    }
  });

  it('publishes no status code for a pending occurrence, even when the event carried one', () => {
    const group = onlyGroup(
      aggregateRequests([
        makeInFlightEvent({ requestKey: opaqueRequestKey('p6'), statusCode: 200 }),
      ]),
    );
    const occurrence = occurrenceAt(group, 0);

    expect(occurrence.pending).toBe(true);
    expect(Object.hasOwn(occurrence, 'statusCode')).toBe(false);
    expect(occurrence.status).toBe(UNSET_STATUS);
    expect(group.statusCodes).toStrictEqual([]);
  });

  it('never counts a pending occurrence as a failure, whatever status it reported', () => {
    // A code at the error floor and an `error` span status would each make a
    // settled occurrence a failure; neither may for a request still waiting.
    const group = onlyGroup(
      aggregateRequests([
        makeInFlightEvent({
          requestKey: opaqueRequestKey('p7'),
          statusCode: 503,
          status: ERROR_STATUS,
        }),
      ]),
    );

    expect(group.errorCount).toBe(0);
    expect(group.statusCodes).toStrictEqual([]);
    expect(group.pendingCount).toBe(1);
    // The span status travels as the producer reported it.
    expect(occurrenceAt(group, 0).status).toBe(ERROR_STATUS);
  });

  it('keeps a pending occurrence out of the resource-timing join, leaving the entry unclaimed', () => {
    const resolvedUrl = `${RESOURCE_FIXTURE_ORIGIN}${ITEMS_PATH}`;
    const request = makeInFlightEvent({
      requestKey: opaqueRequestKey('p8'),
      url: ITEMS_PATH,
      transferSize: 512,
      extraAttributes: { [RESOURCE_TIMING_URL_ATTRIBUTE]: resolvedUrl },
    });
    const entry = makeResourceEvent({
      url: resolvedUrl,
      transferSize: 4096,
      transferSizeExposed: true,
      initiatorType: 'fetch',
    });

    const group = onlyGroup(aggregateRequests([request, entry]));
    const occurrence = occurrenceAt(group, 0);

    // Neither the request's own size nor the entry's: nothing had arrived.
    for (const field of ['transferredBytes', 'transferSource', 'transferEventId']) {
      expect(Object.hasOwn(occurrence, field)).toBe(false);
    }
    expect(Object.hasOwn(group, 'transferredBytes')).toBe(false);
    expect(Object.hasOwn(group, 'transferEventIds')).toBe(false);
  });

  it('leaves a matching entry to the settled request it belongs to', () => {
    // The pending request comes first in canonical order, so a claim made by it
    // would leave the settled request — the one the entry measured — with
    // nothing.
    const resolvedUrl = `${RESOURCE_FIXTURE_ORIGIN}${ITEMS_PATH}`;
    const identity = { [RESOURCE_TIMING_URL_ATTRIBUTE]: resolvedUrl };
    const pendingKey = opaqueRequestKey('p9');
    const settledKey = opaqueRequestKey('pa');
    const events = [
      makeInFlightEvent({
        requestKey: pendingKey,
        url: ITEMS_PATH,
        startTime: BASE_TIME,
        duration: 40,
        extraAttributes: identity,
      }),
      makeRequestEvent({
        requestKey: settledKey,
        url: ITEMS_PATH,
        startTime: BASE_TIME + 5,
        extraAttributes: identity,
      }),
    ];
    const entry = makeResourceEvent({
      url: resolvedUrl,
      startTime: BASE_TIME + 5,
      transferSize: 2048,
      transferSizeExposed: true,
      initiatorType: 'fetch',
    });

    const groups = aggregateRequests([...events, entry]);
    const pendingGroup = elementAt(
      groups.filter((group) => group.requestKey === pendingKey),
      0,
      'the pending group',
    );
    const settledGroup = elementAt(
      groups.filter((group) => group.requestKey === settledKey),
      0,
      'the settled group',
    );

    expect(Object.hasOwn(pendingGroup, 'transferEventIds')).toBe(false);
    expect(occurrenceAt(settledGroup, 0).transferEventId).toBe(entry.id);
    expect(settledGroup.transferredBytes).toBe(2048);
  });

  it('counts pending occurrences over every occurrence, before truncation', () => {
    const requestKey = opaqueRequestKey('pb');
    const events = [
      ...makeKeyedSeries(requestKey, [0, 3000]),
      makeInFlightEvent({ requestKey, startTime: BASE_TIME + 6000 }),
      makeInFlightEvent({ requestKey, startTime: BASE_TIME + 9000 }),
      makeInFlightEvent({ requestKey, startTime: BASE_TIME + 12_000 }),
    ];

    const bounded = noDuplicates(
      onlyGroup(aggregateRequests(events, { maxOccurrencesPerGroup: 2 })),
    );
    const none = onlyGroup(aggregateRequests(events, { maxOccurrencesPerGroup: 0 }));

    expect(bounded.count).toBe(5);
    expect(bounded.pendingCount).toBe(3);
    expect(bounded.occurrencesTruncated).toBe(true);
    // The listed occurrences are the two settled ones; the count still holds
    // the three pending ones the list omits.
    expect(bounded.occurrences.map((occurrence) => occurrence.pending)).toStrictEqual([
      undefined,
      undefined,
    ]);
    expect(none.pendingCount).toBe(3);
    expect(none.occurrences).toStrictEqual([]);
  });

  it('adds no pending field to a capture that holds no snapshot', () => {
    const groups = aggregateRequests([
      ...makeKeyedSeries(opaqueRequestKey('pc'), [0, 7, 14]),
      makeRequestEvent({ omitAttributes: [REQUEST_KEY_ATTRIBUTE, STATUS_CODE_ATTRIBUTE] }),
    ]);

    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(Object.hasOwn(group, 'pendingCount')).toBe(false);
      for (const occurrence of group.occurrences) {
        expect(Object.hasOwn(occurrence, 'pending')).toBe(false);
      }
    }
  });

  it('lets a settled event of the same span supersede its snapshot', () => {
    const requestKey = opaqueRequestKey('pd');
    const traceId = nextTraceId();
    const spanId = nextSpanId();
    const snapshot = makeInFlightEvent({ requestKey, traceId, spanId, duration: 30 });
    const settled = makeRequestEvent({ requestKey, traceId, spanId, duration: 45 });

    for (const events of [
      [snapshot, settled],
      [settled, snapshot],
    ]) {
      const group = noDuplicates(onlyGroup(aggregateRequests(events)));
      const occurrence = occurrenceAt(group, 0);

      // One request, observed finishing: never a duplicate of its own snapshot.
      expect(group.count).toBe(1);
      expect(occurrence.eventId).toBe(settled.id);
      expect(Object.hasOwn(occurrence, 'pending')).toBe(false);
      expect(occurrence.statusCode).toBe(DEFAULT_STATUS_CODE);
      expect(Object.hasOwn(group, 'pendingCount')).toBe(false);
      expect(group.totalDurationMs).toBe(45);
    }
  });

  it('pairs a snapshot with a settled event by trace and span together', () => {
    // The same span id under a different trace is a different request, so the
    // snapshot stands — and, issued inside the window, it is a duplicate.
    const requestKey = opaqueRequestKey('pe');
    const spanId = nextSpanId();
    const group = onlyGroup(
      aggregateRequests([
        makeInFlightEvent({ requestKey, spanId, traceId: nextTraceId() }),
        makeRequestEvent({ requestKey, spanId, traceId: nextTraceId(), startTime: BASE_TIME + 3 }),
      ]),
    );

    expect(group.count).toBe(2);
    expect(group.pendingCount).toBe(1);
    expect(group.duplicateCount).toBe(1);
  });

  it('keeps only the latest of several snapshots of one span, whatever their order', () => {
    const requestKey = opaqueRequestKey('pf');
    const traceId = nextTraceId();
    const spanId = nextSpanId();
    // Ids are minted in ascending order, so `latestTied` is the smaller of the
    // two snapshots sharing the latest end time and must win the tie.
    const latestTied = makeInFlightEvent({ requestKey, traceId, spanId, duration: 30 });
    const alsoLatest = makeInFlightEvent({ requestKey, traceId, spanId, duration: 30 });
    const earlier = makeInFlightEvent({ requestKey, traceId, spanId, duration: 10 });
    const events = [earlier, alsoLatest, latestTied];

    for (const arrangement of [events, [...events].reverse(), deterministicShuffle(events)]) {
      const group = noDuplicates(onlyGroup(aggregateRequests(arrangement)));

      expect(group.count).toBe(1);
      expect(group.pendingCount).toBe(1);
      expect(occurrenceAt(group, 0).eventId).toBe(latestTied.id);
      expect(group.totalDurationMs).toBe(30);
    }
  });

  it('never drops or merges two settled events that share a span', () => {
    const requestKey = opaqueRequestKey('pg');
    const traceId = nextTraceId();
    const spanId = nextSpanId();
    const first = makeRequestEvent({ requestKey, traceId, spanId });
    const second = makeRequestEvent({ requestKey, traceId, spanId, startTime: BASE_TIME + 4 });

    const group = onlyGroup(aggregateRequests([first, second]));

    expect(group.count).toBe(2);
    expect(group.occurrences.map((occurrence) => occurrence.eventId)).toStrictEqual([
      first.id,
      second.id,
    ]);
  });

  it('reads a mixed group’s codes and failures from its settled occurrences', () => {
    const requestKey = opaqueRequestKey('ph');
    const group = noDuplicates(
      onlyGroup(
        aggregateRequests([
          makeRequestEvent({ requestKey, statusCode: 200 }),
          makeRequestEvent({ requestKey, statusCode: 500, startTime: BASE_TIME + 3000 }),
          makeInFlightEvent({ requestKey, startTime: BASE_TIME + 6000 }),
        ]),
      ),
    );

    expect(group.count).toBe(3);
    expect(group.pendingCount).toBe(1);
    expect(group.statusCodes).toStrictEqual([200, 500]);
    expect(group.errorCount).toBe(1);
  });

  it('includes a pending occurrence’s elapsed time in the durations, as a lower bound', () => {
    const requestKey = opaqueRequestKey('pi');
    const group = noDuplicates(
      onlyGroup(
        aggregateRequests([
          makeRequestEvent({ requestKey, duration: 10 }),
          makeInFlightEvent({ requestKey, startTime: BASE_TIME + 3000, duration: 40 }),
        ]),
      ),
    );
    const pending = occurrenceAt(group, 1);

    expect(group.totalDurationMs).toBe(50);
    expect(group.averageDurationMs).toBe(25);
    expect(group.maxDurationMs).toBe(40);
    expect(group.minDurationMs).toBe(10);
    // The end is the observation instant, which is all the capture knows.
    expect(pending.pending).toBe(true);
    expect(pending.endTime).toBe(roundMs(BASE_TIME + 3000 + 40));
  });

  it('sweeps a pending occurrence into a duplicate window by its issuance start', () => {
    const requestKey = opaqueRequestKey('pj');
    const settled = makeRequestEvent({ requestKey });
    const pending = makeInFlightEvent({ requestKey, startTime: BASE_TIME + 5 });

    const group = onlyGroup(aggregateRequests([settled, pending]));
    const duplicateWindow = windowAt(group, 0);

    expect(group.duplicateCount).toBe(1);
    expect(duplicateWindow.eventIds).toStrictEqual([settled.id, pending.id]);
    // A window is bounded by issuance, so its end is the pending request's
    // start rather than any completion it has not reached.
    expect(duplicateWindow.endTime).toBe(BASE_TIME + 5);
  });

  it('survives the transports it travels on and leaves its input untouched', () => {
    const requestKey = opaqueRequestKey('pk');
    const traceId = nextTraceId();
    const spanId = nextSpanId();
    const events = [
      makeRequestEvent({ requestKey, statusCode: 404 }),
      makeInFlightEvent({ requestKey, startTime: BASE_TIME + 9 }),
      makeInFlightEvent({ requestKey, traceId, spanId, startTime: BASE_TIME + 2000 }),
      makeRequestEvent({ requestKey, traceId, spanId, startTime: BASE_TIME + 2000 }),
      makeResourceEvent({ url: ITEMS_PATH, transferSize: 64, transferSizeExposed: true }),
    ];
    const snapshot = structuredClone(events);
    const references = [...events];

    const groups = aggregateRequests(events);
    const group = onlyGroup(groups);

    expect(group.count).toBe(3);
    expect(group.pendingCount).toBe(1);
    expect(JSON.parse(JSON.stringify(groups))).toStrictEqual(groups);
    expect(events).toStrictEqual(snapshot);
    events.forEach((event, index) => {
      expect(event).toBe(elementAt(references, index, 'an input event'));
    });
  });

  it('spells the in-flight key exactly as the producer writes it', () => {
    // `../browser/fetch.ts` writes the key and may not import this module, so
    // `../browser/in-flight-requests.test.ts` pins the producer to this
    // constant and this case pins the constant to its literal.
    expect(REQUEST_IN_FLIGHT_ATTRIBUTE).toBe('inFlight');
    expect(SERVICE_ASSIGNED_ATTRIBUTE_KEYS).not.toContain(REQUEST_IN_FLIGHT_ATTRIBUTE);
  });

  it('reads a key the attribute catalog declares for every request kind', () => {
    // The catalog is the authoritative vocabulary (AAP 0.2.3): the panel node
    // catalog derives `requestTable.reads` from it, so a pending signal the
    // aggregate reads but the catalog omitted would be evidence no reader was
    // told about. Both transports carry it, and so does every request kind.
    expect(FETCH_ATTRIBUTE_KEYS).toContain(REQUEST_IN_FLIGHT_ATTRIBUTE);
    expect(XHR_ATTRIBUTE_KEYS).toContain(REQUEST_IN_FLIGHT_ATTRIBUTE);
    expect(REQUEST_KINDS.length).toBeGreaterThan(0);
    for (const kind of REQUEST_KINDS) {
      expect(attributeKeysFor(kind)).toContain(REQUEST_IN_FLIGHT_ATTRIBUTE);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Status codes, failures and the occurrences that reported no code
 *
 * `statusCodes` lists the codes the settled occurrences reported, so an
 * occurrence that settled without one — an abort, a network error, an opaque
 * response — is absent from it while `errorCount` may count it. The group
 * therefore states how many such occurrences it holds, so that every
 * occurrence is accounted for: pending, settled with a code, or settled
 * without one.
 * ---------------------------------------------------------------------------
 */

/**
 * How many of a group's occurrences its three accounts cover: its pending
 * ones, its settled ones without a code, and the listed occurrences whose codes
 * `statusCodes` holds. Read off an untruncated list, it must equal the count.
 *
 * @param group A group whose occurrence list was not truncated.
 * @returns The occurrences accounted for.
 */
function accountedFor(group: RequestGroup): number {
  const withCode = group.occurrences.filter(
    (occurrence) => occurrence.pending !== true && occurrence.statusCode !== undefined,
  ).length;
  return (group.pendingCount ?? 0) + (group.noStatusCodeCount ?? 0) + withCode;
}

describe('aggregateRequests status reconciliation', () => {
  it('counts the aborted occurrences a list of successful codes leaves out', () => {
    // The reported case: two answered requests and two aborted by the page.
    // The codes are [200] and two occurrences failed; the count of settled
    // occurrences without a code is what makes both statements agree.
    const requestKey = opaqueRequestKey('ns1');
    const events = [
      makeRequestEvent({ requestKey, statusCode: 200, status: OK_STATUS }),
      makeRequestEvent({
        requestKey,
        statusCode: 200,
        status: OK_STATUS,
        startTime: BASE_TIME + 4000,
      }),
      ...[8000, 12_000].map((offset) =>
        makeRequestEvent({
          requestKey,
          status: ERROR_STATUS,
          startTime: BASE_TIME + offset,
          omitAttributes: [STATUS_CODE_ATTRIBUTE],
          extraAttributes: { aborted: true },
        }),
      ),
    ];

    const group = onlyGroup(aggregateRequests(events));

    expect(group.count).toBe(4);
    expect(group.statusCodes).toStrictEqual([200]);
    expect(group.errorCount).toBe(2);
    expect(group.noStatusCodeCount).toBe(2);
    expect(Object.hasOwn(group, 'pendingCount')).toBe(false);
    expect(accountedFor(group)).toBe(group.count);
    // The occurrences themselves carry no code, and their span status is kept.
    const codeless = group.occurrences.filter((occurrence) => occurrence.statusCode === undefined);
    expect(codeless.map((occurrence) => occurrence.status)).toStrictEqual([
      ERROR_STATUS,
      ERROR_STATUS,
    ]);
  });

  it('counts a settled occurrence without a code whether or not it failed', () => {
    // An opaque response settles `ok` with no code to report; it is counted,
    // and it is no failure, so `errorCount` and the new count move apart.
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({
          requestKey: opaqueRequestKey('ns2'),
          status: OK_STATUS,
          omitAttributes: [STATUS_CODE_ATTRIBUTE],
        }),
        makeRequestEvent({
          requestKey: opaqueRequestKey('ns2'),
          status: UNSET_STATUS,
          startTime: BASE_TIME + 4000,
          omitAttributes: [STATUS_CODE_ATTRIBUTE],
        }),
      ]),
    );

    expect(group.statusCodes).toStrictEqual([]);
    expect(group.errorCount).toBe(0);
    expect(group.noStatusCodeCount).toBe(2);
    expect(accountedFor(group)).toBe(group.count);
  });

  it('never counts a pending occurrence as one that settled without a code', () => {
    const requestKey = opaqueRequestKey('ns3');
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({ requestKey }),
        makeInFlightEvent({ requestKey, startTime: BASE_TIME + 4000 }),
      ]),
    );

    expect(group.pendingCount).toBe(1);
    expect(Object.hasOwn(group, 'noStatusCodeCount')).toBe(false);
    expect(accountedFor(group)).toBe(group.count);
  });

  it('counts over every occurrence, before truncation', () => {
    const requestKey = opaqueRequestKey('ns4');
    const events = [
      ...makeKeyedSeries(requestKey, [0, 3000]),
      ...[6000, 9000, 12_000].map((offset) =>
        makeRequestEvent({
          requestKey,
          status: ERROR_STATUS,
          startTime: BASE_TIME + offset,
          omitAttributes: [STATUS_CODE_ATTRIBUTE],
        }),
      ),
    ];

    const bounded = onlyGroup(aggregateRequests(events, { maxOccurrencesPerGroup: 2 }));
    const none = onlyGroup(aggregateRequests(events, { maxOccurrencesPerGroup: 0 }));

    expect(bounded.occurrencesTruncated).toBe(true);
    expect(bounded.noStatusCodeCount).toBe(3);
    expect(bounded.errorCount).toBe(3);
    expect(none.noStatusCodeCount).toBe(3);
    expect(none.occurrences).toStrictEqual([]);
  });

  it('adds no field to a capture in which every settled request reported a code', () => {
    const groups = aggregateRequests([
      ...makeKeyedSeries(opaqueRequestKey('ns5'), [0, 7, 14]),
      makeRequestEvent({ requestKey: opaqueRequestKey('ns6'), statusCode: 503 }),
    ]);

    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(Object.hasOwn(group, 'noStatusCodeCount')).toBe(false);
      expect(accountedFor(group)).toBe(group.count);
    }
  });

  it('treats a code that is not a finite integer as no code at all', () => {
    // The occurrence publishes no `statusCode` for a malformed value, so the
    // group counts it with the occurrences that reported none.
    const group = onlyGroup(
      aggregateRequests([
        makeRequestEvent({
          requestKey: opaqueRequestKey('ns7'),
          status: ERROR_STATUS,
          omitAttributes: [STATUS_CODE_ATTRIBUTE],
          extraAttributes: { [STATUS_CODE_ATTRIBUTE]: '500' },
        }),
      ]),
    );

    expect(occurrenceAt(group, 0).statusCode).toBeUndefined();
    expect(group.statusCodes).toStrictEqual([]);
    expect(group.noStatusCodeCount).toBe(1);
    expect(group.errorCount).toBe(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The resource-timing join at scale
 *
 * `./requests.ts` finds each occurrence's entry with binary searches, skip
 * pointers and a range minimum instead of scanning every candidate its URL
 * holds, because the service feeds the `requests` source tens of thousands of
 * events and the scan made the duplicate-request case — many requests to one
 * URL — quadratic. The index is an optimisation only if it changes nothing, so
 * this section holds it to two things:
 *
 * - **The pairing of the scan it replaced.** {@link referenceJoin} is that
 *   scan, restated rule for rule: identity buckets sorted by start then id, the
 *   transport rank that rejects a foreign stated type, the timing window, the
 *   nearest start, the smallest id, and the first-met entry on a full tie.
 *   Seeded captures — few URLs, both identities, stated, unstated and foreign
 *   initiator types, shared start times, overlapping windows, zero tolerance,
 *   pending requests, requests that report their own size, entries sharing an
 *   id, and a family of magnitudes at which distinct starts round to one
 *   distance — must produce the reference's transfer fields on every
 *   occurrence and the reference's claims and bytes on every group.
 * - **The cost it promises.** Twenty-five thousand requests to one URL against
 *   twenty-five thousand entries, spaced and all at one instant, must join in
 *   well under {@link JOIN_VOLUME_BOUND_MS}, each request claiming exactly one
 *   entry of its own. The scan needed about 25 000² candidate visits for it.
 *
 * The generator is a seeded PRNG rather than `Math.random`, so a failing seed
 * reproduces exactly and names itself in the assertion message.
 * ---------------------------------------------------------------------------
 */

/** The resolved identity of {@link ITEMS_PATH} in the cases below. */
const ABSOLUTE_ITEMS_URL = `${RESOURCE_FIXTURE_ORIGIN}${ITEMS_PATH}`;

/** The resolved identity of {@link THINGS_PATH}. */
const ABSOLUTE_THINGS_URL = `${RESOURCE_FIXTURE_ORIGIN}${THINGS_PATH}`;

/**
 * The `initiator.type` Resource Timing reports for each request kind, as the
 * module's header states it. Restated rather than imported: the reference must
 * not share a single line with the implementation it checks.
 */
const REFERENCE_INITIATOR_TYPE_BY_KIND = new Map<TelemetryKind, string>([
  ['fetch', 'fetch'],
  ['xhr', 'xmlhttprequest'],
]);

/** How many seeded captures the differential case compares. */
const DIFFERENTIAL_CAPTURE_COUNT = 500;

/** Requests, and entries, in each high-volume case. */
const JOIN_VOLUME = 25_000;

/**
 * The time a high-volume join must finish inside, in milliseconds.
 *
 * Generous on purpose — a loaded CI runner must not fail it — and still two
 * orders of magnitude below what the per-occurrence scan took for the same
 * capture.
 */
const JOIN_VOLUME_BOUND_MS = 3_000;

/** The transfer fields the join publishes on one occurrence. */
interface JoinOutcome {
  readonly transferEventId: EventId | undefined;
  readonly transferredBytes: number | undefined;
  readonly transferSource: RequestOccurrence['transferSource'];
}

/** The outcome of an occurrence the join left alone. */
const NO_JOIN: JoinOutcome = {
  transferEventId: undefined,
  transferredBytes: undefined,
  transferSource: undefined,
};

/** A resource entry as the reference scan holds it. */
interface ReferenceCandidate {
  readonly eventId: EventId;
  readonly startTime: number;
  readonly initiatorType: string | undefined;
  readonly bytes: number;
  claimed: boolean;
}

/** A non-blank string attribute: the only shape a URL or a type is read in. */
function nonBlankAttribute(event: TelemetryEvent, key: string): string | undefined {
  const value = event.attributes[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Code-unit order, the order the module compares every id in. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Start time, then id: the order of a bucket and of the occurrences. */
function compareStartThenId(
  left: { readonly startTime: number; readonly id: string },
  right: { readonly startTime: number; readonly id: string },
): number {
  if (left.startTime !== right.startTime) {
    return left.startTime < right.startTime ? -1 : 1;
  }
  return compareCodeUnits(left.id, right.id);
}

/**
 * The join as a scan of every candidate — the implementation `./requests.ts`
 * replaced — restated for differential testing.
 *
 * Deliberately naive, O(requests × entries) and written for obviousness. It is
 * fed only the generated captures below, whose events are well formed and
 * whose spans are all distinct, so no snapshot is superseded and every
 * attribute can be read directly.
 *
 * @returns each request event's transfer fields, by event id.
 */
function referenceJoin(
  events: readonly TelemetryEvent[],
  toleranceMs: number,
): Map<EventId, JoinOutcome> {
  const buckets = new Map<string, ReferenceCandidate[]>();
  for (const event of events) {
    if (event.kind !== RESOURCE_ENTRY_EVENT_KIND) {
      continue;
    }
    const entryType = event.attributes[ENTRY_TYPE_ATTRIBUTE];
    if (entryType !== undefined && entryType !== RESOURCE_ENTRY_TYPE) {
      continue;
    }
    const url = nonBlankAttribute(event, URL_ATTRIBUTE);
    const bytes = readExposedTransferSize(event);
    if (url === undefined || bytes === undefined) {
      continue;
    }
    const bucket = buckets.get(url) ?? [];
    bucket.push({
      eventId: event.id,
      startTime: event.startTime,
      initiatorType: nonBlankAttribute(event, INITIATOR_TYPE_ATTRIBUTE),
      bytes,
      claimed: false,
    });
    buckets.set(url, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) =>
      compareStartThenId(
        { startTime: left.startTime, id: left.eventId },
        { startTime: right.startTime, id: right.eventId },
      ),
    );
  }

  const requests = events
    .filter((event) => REQUEST_KINDS.includes(event.kind))
    .sort(compareStartThenId);

  const outcomes = new Map<EventId, JoinOutcome>();
  for (const request of requests) {
    if (request.attributes[REQUEST_IN_FLIGHT_ATTRIBUTE] === true) {
      outcomes.set(request.id, NO_JOIN);
      continue;
    }

    const startTime = request.startTime;
    const endTime = roundMs(startTime + roundMs(Math.max(0, request.duration)));
    const earliest = startTime - toleranceMs;
    const latest = endTime + toleranceMs;
    const expected = REFERENCE_INITIATOR_TYPE_BY_KIND.get(request.kind);
    const resolved = nonBlankAttribute(request, RESOURCE_TIMING_URL_ATTRIBUTE);
    const written = nonBlankAttribute(request, URL_ATTRIBUTE);
    const identities: string[] = [];
    if (resolved !== undefined) {
      identities.push(resolved);
    }
    if (written !== undefined && written !== resolved) {
      identities.push(written);
    }

    let best: ReferenceCandidate | undefined;
    let bestRank: readonly [number, number] | undefined;
    for (const identity of identities) {
      for (const candidate of buckets.get(identity) ?? []) {
        if (candidate.claimed || candidate.startTime < earliest || candidate.startTime > latest) {
          continue;
        }
        if (
          expected !== undefined &&
          candidate.initiatorType !== undefined &&
          candidate.initiatorType !== expected
        ) {
          continue;
        }
        const rank: readonly [number, number] = [
          candidate.initiatorType === expected ? 0 : 1,
          Math.abs(candidate.startTime - startTime),
        ];
        if (
          bestRank === undefined ||
          rank[0] < bestRank[0] ||
          (rank[0] === bestRank[0] && rank[1] < bestRank[1]) ||
          (rank[0] === bestRank[0] &&
            rank[1] === bestRank[1] &&
            best !== undefined &&
            compareCodeUnits(candidate.eventId, best.eventId) < 0)
        ) {
          best = candidate;
          bestRank = rank;
        }
      }
    }
    if (best !== undefined) {
      best.claimed = true;
    }

    const own = readExposedTransferSize(request);
    let transferSource: JoinOutcome['transferSource'];
    if (own !== undefined) {
      transferSource = 'request';
    } else if (best !== undefined) {
      transferSource = 'resource-timing';
    }
    outcomes.set(request.id, {
      transferEventId: best?.eventId,
      transferredBytes: own ?? best?.bytes,
      transferSource,
    });
  }
  return outcomes;
}

/** Every occurrence's transfer fields as the module published them, by event id. */
function publishedJoinOutcomes(groups: readonly RequestGroup[]): Map<EventId, JoinOutcome> {
  const outcomes = new Map<EventId, JoinOutcome>();
  for (const group of groups) {
    for (const occurrence of group.occurrences) {
      outcomes.set(occurrence.eventId, {
        transferEventId: occurrence.transferEventId,
        transferredBytes: occurrence.transferredBytes,
        transferSource: occurrence.transferSource,
      });
    }
  }
  return outcomes;
}

/** A map's entries ordered by key, so two maps compare independently of insertion order. */
function entriesByKey<T>(map: ReadonlyMap<string, T>): (readonly [string, T])[] {
  return [...map.entries()].sort(([left], [right]) => compareCodeUnits(left, right));
}

/**
 * mulberry32: a 32-bit seeded PRNG, uniform on `[0, 1)`. Small, fast and
 * fully determined by its seed, which is all a differential generator needs.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One element of `items`, drawn by `random`. */
function choose<T>(random: () => number, items: readonly T[]): T {
  return elementAt(items, Math.floor(random() * items.length), 'a generator choice');
}

/** A seeded Fisher–Yates permutation of `items`. */
function seededShuffle<T>(random: () => number, items: readonly T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const current = elementAt(shuffled, index, 'a shuffled event');
    shuffled[index] = elementAt(shuffled, other, 'a shuffled event');
    shuffled[other] = current;
  }
  return shuffled;
}

/**
 * Request starts of the magnitude family in which distinct candidate starts
 * round to one distance: `-1` and `1` sit a distance of exactly `1` from every
 * start in `1e-20 … 5e-20`, because the subtraction rounds away the
 * difference between them.
 */
const COLLAPSING_REQUEST_STARTS = [-1, 1, 2] as const;

/** Entry starts of the same family, near-equal and exactly representable alike. */
const COLLAPSING_ENTRY_STARTS = [1e-20, 2e-20, 3e-20, 5e-20, -1, 1, 2, 3, 1 + Number.EPSILON];

/** The initiator types an entry may state; `''` stands for "states none". */
const GENERATED_INITIATOR_TYPES = ['', '', 'fetch', 'xmlhttprequest', 'link', 'script'] as const;

/** One seeded capture and the tolerance its aggregation runs under. */
interface GeneratedJoinCapture {
  readonly events: readonly TelemetryEvent[];
  /** The options handed to the module; the tolerance is sometimes left to its default. */
  readonly options: RequestAggregateOptions;
  /** The tolerance those options resolve to, for the reference. */
  readonly toleranceMs: number;
}

/** The URL `written` resolves to: relative paths gain the fixture origin. */
function absoluteUrlOf(written: string): string {
  return written.startsWith('/') ? `${RESOURCE_FIXTURE_ORIGIN}${written}` : written;
}

/**
 * A random capture shaped to reach every branch of the join.
 *
 * A quarter of the seeds draw from the magnitude family above; the rest use
 * epoch milliseconds on a 2.5 ms grid, so starts coincide often, windows
 * overlap, and a tolerance of zero or one leaves some entries just outside.
 */
function generateJoinCapture(seed: number): GeneratedJoinCapture {
  const random = seededRandom(seed);
  const collapsing = random() < 0.25;
  const requestStart = (): number =>
    collapsing
      ? choose(random, COLLAPSING_REQUEST_STARTS)
      : BASE_TIME + Math.floor(random() * 24) * 2.5 + choose(random, [0, 0, 0.25]);
  const entryStart = (): number =>
    collapsing
      ? choose(random, COLLAPSING_ENTRY_STARTS)
      : BASE_TIME - 10 + Math.floor(random() * 32) * 2.5 + choose(random, [0, 0, 0.25]);
  const duration = (): number =>
    collapsing ? choose(random, [0, 1]) : choose(random, [0, 1, 2.5, 7.5, 20]);
  const toleranceMs = collapsing
    ? choose(random, [0, 1, 2])
    : choose(random, [0, 1, 5, DEFAULT_RESOURCE_TIMING_TOLERANCE_MS]);
  // Half the default-tolerance captures omit the option, so the no-options
  // path is compared as well as the stated one.
  const leaveToleranceToDefault =
    toleranceMs === DEFAULT_RESOURCE_TIMING_TOLERANCE_MS && random() < 0.5;

  const requestKeys = [opaqueRequestKey('d1'), opaqueRequestKey('d2'), opaqueRequestKey('d3')];
  const writtenUrls = [ITEMS_PATH, THINGS_PATH, ABSOLUTE_ITEMS_URL, ABSOLUTE_THINGS_URL];
  const events: TelemetryEvent[] = [];

  const requestCount = 1 + Math.floor(random() * 30);
  for (let index = 0; index < requestCount; index += 1) {
    const written = choose(random, writtenUrls);
    const resolvedRoll = random();
    let resolved: string | undefined;
    if (resolvedRoll < 0.55) {
      resolved = absoluteUrlOf(written);
    } else if (resolvedRoll < 0.7) {
      resolved = choose(random, [ABSOLUTE_ITEMS_URL, ABSOLUTE_THINGS_URL]);
    }
    const overrides: RequestEventOverrides = {
      kind: choose(random, REQUEST_KINDS),
      url: written,
      requestKey: choose(random, requestKeys),
      startTime: requestStart(),
      duration: duration(),
      ...(random() < 0.2 ? { transferSize: Math.floor(random() * 4000) } : {}),
      extraAttributes: resolved === undefined ? {} : { [RESOURCE_TIMING_URL_ATTRIBUTE]: resolved },
    };
    events.push(random() < 0.15 ? makeInFlightEvent(overrides) : makeRequestEvent(overrides));
  }

  const entryIds: EventId[] = [];
  const entryCount = Math.floor(random() * 41);
  for (let index = 0; index < entryCount; index += 1) {
    const reusedId = entryIds.length > 0 && random() < 0.06 ? choose(random, entryIds) : undefined;
    const stated = choose(random, GENERATED_INITIATOR_TYPES);
    const exposedRoll = random();
    const entry = makeResourceEvent({
      url: choose(random, [...writtenUrls, ABSOLUTE_ITEMS_URL]),
      startTime: entryStart(),
      transferSize: Math.floor(random() * 5000),
      ...(exposedRoll < 0.85 ? { transferSizeExposed: true } : {}),
      ...(exposedRoll >= 0.85 && exposedRoll < 0.95 ? { transferSizeExposed: false } : {}),
      ...(stated === '' ? {} : { initiatorType: stated }),
      ...(random() < 0.03 ? { entryType: PAINT_ENTRY_TYPE } : {}),
      ...(reusedId === undefined ? {} : { id: reusedId }),
    });
    entryIds.push(entry.id);
    events.push(entry);
  }

  return {
    events: seededShuffle(random, events),
    options: {
      maxOccurrencesPerGroup: Number.MAX_SAFE_INTEGER,
      ...(leaveToleranceToDefault ? {} : { resourceTimingToleranceMs: toleranceMs }),
    },
    toleranceMs,
  };
}

describe('aggregateRequests resource-timing join at scale', () => {
  it('pairs every occurrence exactly as a scan of every candidate would, across seeded captures', () => {
    let joinedByTiming = 0;
    let joinedByOwnSize = 0;
    let leftUnjoined = 0;

    for (let seed = 1; seed <= DIFFERENTIAL_CAPTURE_COUNT; seed += 1) {
      const capture = generateJoinCapture(seed);
      const requestCount = capture.events.filter((event) =>
        REQUEST_KINDS.includes(event.kind),
      ).length;

      const groups = aggregateRequests(capture.events, capture.options);
      const expected = referenceJoin(capture.events, capture.toleranceMs);

      expect(totalCount(groups), `seed ${String(seed)}: occurrences`).toBe(requestCount);
      expect(
        entriesByKey(publishedJoinOutcomes(groups)),
        `seed ${String(seed)}: occurrence transfer fields`,
      ).toStrictEqual(entriesByKey(expected));

      for (const group of groups) {
        expect(group.occurrencesTruncated).toBe(false);
        const outcomes = group.occurrences.map((occurrence) => expected.get(occurrence.eventId));
        const claims = [
          ...new Set(outcomes.flatMap((outcome) => outcome?.transferEventId ?? [])),
        ].sort(compareCodeUnits);
        const sizes = outcomes.flatMap((outcome) => outcome?.transferredBytes ?? []);
        const where = `seed ${String(seed)}: group ${group.id}`;

        expect(group.transferEventIds ?? [], `${where} claims`).toStrictEqual(claims);
        expect(group.transferredBytes, `${where} bytes`).toBe(
          sizes.length === 0 ? undefined : Math.round(sizes.reduce((sum, size) => sum + size, 0)),
        );
      }

      for (const outcome of expected.values()) {
        if (outcome.transferSource === 'resource-timing') {
          joinedByTiming += 1;
        } else if (outcome.transferSource === 'request') {
          joinedByOwnSize += 1;
        } else {
          leftUnjoined += 1;
        }
      }
    }

    // The generator is not vacuous: every outcome the join can reach occurred.
    expect(joinedByTiming).toBeGreaterThan(DIFFERENTIAL_CAPTURE_COUNT);
    expect(joinedByOwnSize).toBeGreaterThan(0);
    expect(leftUnjoined).toBeGreaterThan(0);
  });

  it('breaks a distance tie by event id even between distinct starts that round to one distance', () => {
    // From a start of 1 ms, entries starting at 1e-20 ms and 2e-20 ms are both
    // exactly 1 ms away once the subtraction is rounded, although their starts
    // differ. The scan saw a tie there and took the smaller event id, so the
    // index must too — rather than the entry nearest the split by position.
    expect(Math.abs(1e-20 - 1)).toBe(Math.abs(2e-20 - 1));
    expect(Math.abs(1e-20 + 1)).toBe(Math.abs(2e-20 + 1));

    const smallerId = nextEventId();
    const largerId = nextEventId();
    expect(compareCodeUnits(smallerId, largerId)).toBe(-1);

    // Left of the request's start, the larger id sits nearer the split.
    const left = onlyGroup(
      aggregateRequests(
        [
          makeRequestEvent({
            requestKey: opaqueRequestKey('t1'),
            url: ITEMS_PATH,
            startTime: 1,
            duration: 0,
          }),
          makeResourceEvent({ id: smallerId, url: ITEMS_PATH, startTime: 1e-20, transferSize: 11 }),
          makeResourceEvent({ id: largerId, url: ITEMS_PATH, startTime: 2e-20, transferSize: 22 }),
        ],
        { resourceTimingToleranceMs: 1 },
      ),
    );
    expect(occurrenceAt(left, 0).transferEventId).toBe(smallerId);
    expect(left.transferredBytes).toBe(11);

    // Right of it, mirrored: the larger id starts first after the split.
    const right = onlyGroup(
      aggregateRequests(
        [
          makeRequestEvent({
            requestKey: opaqueRequestKey('t2'),
            url: ITEMS_PATH,
            startTime: -1,
            duration: 0,
          }),
          makeResourceEvent({ id: largerId, url: ITEMS_PATH, startTime: 1e-20, transferSize: 33 }),
          makeResourceEvent({ id: smallerId, url: ITEMS_PATH, startTime: 2e-20, transferSize: 44 }),
        ],
        { resourceTimingToleranceMs: 2 },
      ),
    );
    expect(occurrenceAt(right, 0).transferEventId).toBe(smallerId);
    expect(right.transferredBytes).toBe(44);
  });

  it(
    'joins 25 000 overlapping requests to one URL against 25 000 entries, each claiming its own',
    { timeout: 60_000 },
    () => {
      // Requests issued every 2 ms that each stay open until the capture ends
      // — polls or streams to one URL — so every entry that starts after a
      // request lies inside its window, and the scan had every one of them to
      // rank. Request i starts 0.5 ms before entry i and the entries before it
      // are already claimed, so i must take exactly i.
      const requestKey = opaqueRequestKey('v1');
      const openForMs = JOIN_VOLUME * 2;
      const requests: TelemetryEvent[] = [];
      const entries: TelemetryEvent[] = [];
      let expectedBytes = 0;
      for (let index = 0; index < JOIN_VOLUME; index += 1) {
        const startTime = BASE_TIME + index * 2;
        const transferSize = 100 + (index % 900);
        expectedBytes += transferSize;
        requests.push(
          makeRequestEvent({
            requestKey,
            url: ITEMS_PATH,
            startTime,
            duration: openForMs - index * 2,
            extraAttributes: { [RESOURCE_TIMING_URL_ATTRIBUTE]: ABSOLUTE_ITEMS_URL },
          }),
        );
        entries.push(
          makeResourceEvent({
            url: ABSOLUTE_ITEMS_URL,
            startTime: startTime + 0.5,
            transferSize,
            transferSizeExposed: true,
            initiatorType: 'fetch',
          }),
        );
      }
      const events = [...entries].reverse().concat(requests);

      const startedAt = performance.now();
      const groups = aggregateRequests(events, { maxOccurrencesPerGroup: JOIN_VOLUME });
      const elapsedMs = performance.now() - startedAt;

      expect(elapsedMs).toBeLessThan(JOIN_VOLUME_BOUND_MS);
      const group = onlyGroup(groups);
      expect(group.count).toBe(JOIN_VOLUME);
      expect(group.occurrences.map((occurrence) => occurrence.transferEventId)).toStrictEqual(
        idsOf(entries),
      );
      expect(new Set(group.transferEventIds).size).toBe(JOIN_VOLUME);
      expect(group.transferredBytes).toBe(expectedBytes);
    },
  );

  it(
    'joins 25 000 simultaneous requests to one URL against 25 000 entries, smallest id first',
    { timeout: 60_000 },
    () => {
      // The degenerate burst: every request and every entry at one instant, so
      // every entry is equally close to every request and only the event id
      // decides. Requests are joined in id order and each takes the smallest
      // unclaimed entry id, so the pairing is the two id orders side by side.
      const requestKey = opaqueRequestKey('v2');
      const requests: TelemetryEvent[] = [];
      const entries: TelemetryEvent[] = [];
      for (let index = 0; index < JOIN_VOLUME; index += 1) {
        requests.push(
          makeRequestEvent({ requestKey, url: ITEMS_PATH, startTime: BASE_TIME, duration: 0 }),
        );
        entries.push(
          makeResourceEvent({ url: ITEMS_PATH, startTime: BASE_TIME, transferSize: 1 + index }),
        );
      }
      const events = requests.concat([...entries].reverse());

      const startedAt = performance.now();
      const groups = aggregateRequests(events, { maxOccurrencesPerGroup: JOIN_VOLUME });
      const elapsedMs = performance.now() - startedAt;

      expect(elapsedMs).toBeLessThan(JOIN_VOLUME_BOUND_MS);
      const group = onlyGroup(groups);
      expect(group.count).toBe(JOIN_VOLUME);
      expect(group.occurrences.map((occurrence) => occurrence.eventId)).toStrictEqual(
        idsOf(requests),
      );
      expect(group.occurrences.map((occurrence) => occurrence.transferEventId)).toStrictEqual(
        idsOf(entries),
      );
      expect(new Set(group.transferEventIds).size).toBe(JOIN_VOLUME);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * The committed capture fixture
 *
 * `packages/telemetry/test/fixtures/capture-batch.json` is this package's
 * curated, already-redacted capture: thirty-five persisted events of eleven kinds,
 * one trace, one capture window and two producers, spanning the browser, server
 * and database tiers. It is repository data rather than captured telemetry —
 * hand-authored and reviewed, with every URL query value already masked, which
 * is the only form a sample may be committed in (AAP 0.5.2, and the fixture
 * carve-out of 0.3.4's never-committed list) — and it is deterministic, which
 * is what makes the exact assertions below legitimate rather than brittle.
 *
 * What driving the module from it adds to the inline cases above:
 *
 * - **The fixture is a contract, so it is validated as one.** Every element is
 *   parsed through the persisted schema of `../schema/event.ts` before a single
 *   assertion runs — the same gate the store applies to a row it reads back.
 *   Without that parse, a fixture that had drifted out of the persisted shape
 *   would sit in the tree proving nothing.
 * - **The decisive grouping case arrives as data rather than as a
 *   construction.** Two `/api/items/detail` fetches whose redacted URLs are
 *   byte-identical carry *different* keys, because their query values differed
 *   before redaction; four `/api/summary` fetches inside twenty-two
 *   milliseconds carry *one*. Both halves of AAP 0.5.2's sentence therefore
 *   hold on a sample shaped like what ingest produces, and not only on events
 *   this file assembled to make the point.
 * - **It is a whole capture.** Twenty-eight of the thirty-five events are not
 *   request-shaped — an interaction, renders and commits, route handlers and
 *   server functions, database queries, state transitions, a long task, an
 *   error, and the two `http.server` spans that answered two of the fetches and
 *   carry the same `request_key` — so "reports on the request kinds only" is
 *   exercised against a realistic mixture instead of a swept list of kinds.
 *
 * ## How the file is reached
 *
 * `fileURLToPath` first, then `join` — never
 * `new URL('../../test/fixtures/capture-batch.json', import.meta.url)`. The
 * `telemetry` Vitest project runs under happy-dom, whose global `URL` resolves
 * a relative specifier against the document's `http://localhost` origin instead
 * of the `file:` base it was handed, so the tidier one-liner (the form this
 * package's `tsconfig.json` notes suggest) throws `The URL must be of scheme
 * file` here. `../redaction/rules.test.ts` records the same resolution for the
 * same reason.
 *
 * The file is read, never `import`ed: the package pins `rootDir` to `src` and
 * leaves `test/**` outside the program, and a JSON import would hand this suite
 * an `any`-shaped literal typed by the fixture rather than by the schema — the
 * trap that same tsconfig note describes. It is read once at module scope, and
 * every case takes a `structuredClone` of the parsed events, so no case can
 * observe another's mutation and the purity guarantee asserted above holds here
 * too.
 * ---------------------------------------------------------------------------
 */

/** This package's committed fixture directory, `test/fixtures`. */
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

/** The persisted capture this section is driven from. */
const CAPTURE_BATCH_FIXTURE_PATH = join(FIXTURES_DIR, 'capture-batch.json');

/**
 * The committed capture, parsed and validated element by element.
 *
 * A failure names the element's index and the schema issues by path and code
 * only — never a value — which is the discipline `../schema/event.ts`'s own
 * rejection helper follows, and which keeps a fixture value out of a test log
 * even for a sample that carries nothing sensitive.
 *
 * @returns Every event of the fixture, in the order the file holds them.
 */
function readCaptureBatchFixture(): readonly TelemetryEvent[] {
  const parsed: unknown = JSON.parse(readFileSync(CAPTURE_BATCH_FIXTURE_PATH, 'utf8'));

  if (!Array.isArray(parsed)) {
    throw new Error(`${CAPTURE_BATCH_FIXTURE_PATH} must hold an array of persisted events`);
  }

  return parsed.map((candidate: unknown, index): TelemetryEvent => {
    const result = telemetryEventSchema.safeParse(candidate);

    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.code}`)
        .join('; ');
      throw new Error(
        `capture-batch.json[${String(index)}] is not a persisted telemetry event (${issues})`,
      );
    }

    return result.data;
  });
}

/** @see readCaptureBatchFixture */
const CAPTURE_BATCH_EVENTS: readonly TelemetryEvent[] = readCaptureBatchFixture();

/** A fresh copy of the committed capture, so no case shares state with another. */
function captureBatchEvents(): readonly TelemetryEvent[] {
  return structuredClone(CAPTURE_BATCH_EVENTS);
}

/*
 * The fixture's own facts, stated here so that an edit to the JSON file fails
 * in this suite with a readable diff instead of quietly changing what the cases
 * below measure. They are counts and identifiers only: every request key is
 * read off the parsed event (see the header's note on key literals).
 */

/** Events the committed capture holds, all told. */
const FIXTURE_EVENT_COUNT = 35;

/** Of those, the ones whose kind is a request kind — the aggregate's input. */
const FIXTURE_REQUEST_EVENT_COUNT = 7;

/** The rest, which must reach the aggregate and leave no trace in its output. */
const FIXTURE_IGNORED_EVENT_COUNT = FIXTURE_EVENT_COUNT - FIXTURE_REQUEST_EVENT_COUNT;

/** Ignored events that nevertheless carry a `request_key`: the server's spans. */
const FIXTURE_KEYED_SERVER_SPAN_COUNT = 2;

/** Distinct request keys in the capture, and therefore groups in the result. */
const FIXTURE_REQUEST_GROUP_COUNT = 4;

/** Redundant occurrences the whole capture holds: the burst's three. */
const FIXTURE_REDUNDANT_REQUEST_COUNT = 3;

/** The fetch that was issued once, and that the server also spanned. */
const FIXTURE_ITEMS_FETCH_ID = 'evt_j3n7p1r5v9x3c7fk';

/** The four byte-identical fetches of the burst, in the order they were issued. */
const FIXTURE_BURST_FETCH_IDS = [
  'evt_r9w3y7b1g5h9k3ns',
  'evt_s0x4z8c2h6j0m4pt',
  'evt_t1y5b9d3j7k1n5qv',
  'evt_w3b7d1g5m9n3q7sx',
] as const;

/** The two fetches whose query values differed before redaction masked them. */
const FIXTURE_DETAIL_FETCH_IDS = ['evt_k4q8s2v6z0b4f8gm', 'evt_m5r9t3w7b1c5g9hn'] as const;

/** The origin every request in the capture was issued against. */
const FIXTURE_ORIGIN = 'http://localhost:3000';

/** The path the burst was issued against. */
const FIXTURE_BURST_PATH = '/api/summary';

/** The path of the single request the server also spanned. */
const FIXTURE_ITEMS_PATH = '/api/items';

/** The path both differently parameterised fetches share. */
const FIXTURE_DETAIL_PATH = '/api/items/detail';

/** The redacted URL every occurrence of the burst carries, values already masked. */
const FIXTURE_BURST_URL = `${FIXTURE_ORIGIN}${FIXTURE_BURST_PATH}?groupId=?&window=?`;

/** The redacted URL of the request the server also spanned. */
const FIXTURE_ITEMS_URL = `${FIXTURE_ORIGIN}${FIXTURE_ITEMS_PATH}?filter=?&page=?`;

/** The redacted URL both detail fetches carry, byte for byte. */
const FIXTURE_DETAIL_URL = `${FIXTURE_ORIGIN}${FIXTURE_DETAIL_PATH}?itemId=?`;

/** The hook that issued the first half of the burst, and the items fetch. */
const FIXTURE_HOOK_INITIATOR = 'fetchItemList';

/** The component that issued the second half of the burst. */
const FIXTURE_COMPONENT_INITIATOR = 'WidgetPanel';

/** The component that issued both detail fetches. */
const FIXTURE_DETAIL_INITIATOR = 'ItemRow';

/** The interaction span every fetch of the capture is a child of. */
const FIXTURE_INTERACTION_SPAN_ID = 'd1a83f5c27e90b46';

/** The event the fixture identifies as `id`, or a failure naming the absent id. */
function fixtureEvent(events: readonly TelemetryEvent[], id: string): TelemetryEvent {
  const found = events.find((event) => event.id === id);
  if (found === undefined) {
    throw new Error(`the committed capture holds no event "${id}"`);
  }
  return found;
}

/**
 * The service-assigned key an event carries, narrowed from its attribute bag.
 *
 * The bag is `Record<string, unknown>` by schema, so the narrowing is real work
 * rather than a cast: a fixture that lost its key, or gained a key of the wrong
 * type, names itself here instead of silently sending an event into the
 * `method-path` fallback and changing the group count.
 */
function fixtureRequestKey(event: TelemetryEvent): string {
  const key = event.attributes[REQUEST_KEY_ATTRIBUTE];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`event "${event.id}" carries no ${REQUEST_KEY_ATTRIBUTE} attribute`);
  }
  return key;
}

/** The group formed from `requestKey`, or a failure naming the ids the result has. */
function groupForRequestKey(groups: readonly RequestGroup[], requestKey: string): RequestGroup {
  const found = groups.find((group) => group.requestKey === requestKey);
  if (found === undefined) {
    throw new Error(
      `no group was formed from that request key; the result holds ${String(groups.length)}: ${groups
        .map((group) => group.id)
        .join(', ')}`,
    );
  }
  return found;
}

/** The consecutive differences of `values`, in the order they were given. */
function consecutiveGaps(values: readonly number[]): number[] {
  return values
    .slice(1)
    .map((value, index) => value - elementAt(values, index, 'a preceding start time'));
}

describe('the committed capture fixture', () => {
  it('reads one whole capture from disk and the persisted schema accepts every event', () => {
    expect(CAPTURE_BATCH_EVENTS).toHaveLength(FIXTURE_EVENT_COUNT);
    expect(CAPTURE_BATCH_EVENTS.every((event) => isTelemetryEvent(event))).toBe(true);
    // One trace, one capture and one session: the aggregate is handed a single
    // capture window, which is what `POST /sessions/:id/panel-data` asks it for.
    expect(new Set(CAPTURE_BATCH_EVENTS.map((event) => event.traceId)).size).toBe(1);
    expect(new Set(CAPTURE_BATCH_EVENTS.map((event) => event.captureId)).size).toBe(1);
    expect(new Set(CAPTURE_BATCH_EVENTS.map((event) => event.sessionId)).size).toBe(1);
    // Store-assigned arrival numbers, contiguous and one-based, so the file
    // really is a capture in arrival order rather than a bag of events.
    expect(CAPTURE_BATCH_EVENTS.map((event) => event.ingestSeq)).toStrictEqual(
      Array.from({ length: FIXTURE_EVENT_COUNT }, (_unused, index) => index + 1),
    );
    // A clone per case, and the clone is a faithful copy.
    expect(captureBatchEvents()).toStrictEqual(CAPTURE_BATCH_EVENTS);
    expect(captureBatchEvents()).not.toBe(CAPTURE_BATCH_EVENTS);
  });

  it('holds seven request events among twenty-eight the aggregate must ignore', () => {
    const events = captureBatchEvents();
    const requestEvents = events.filter((event) => REQUEST_KINDS.includes(event.kind));
    const ignoredEvents = events.filter((event) => !REQUEST_KINDS.includes(event.kind));
    const keyedServerSpans = ignoredEvents.filter(
      (event) => typeof event.attributes[REQUEST_KEY_ATTRIBUTE] === 'string',
    );

    expect(requestEvents).toHaveLength(FIXTURE_REQUEST_EVENT_COUNT);
    expect(ignoredEvents).toHaveLength(FIXTURE_IGNORED_EVENT_COUNT);
    expect(keyedServerSpans).toHaveLength(FIXTURE_KEYED_SERVER_SPAN_COUNT);
    // Every request event populates the five attributes the aggregate reads,
    // so a case that observes a missing field below is observing the module's
    // behaviour and not a gap in the fixture.
    for (const event of requestEvents) {
      expect(typeof event.attributes[METHOD_ATTRIBUTE]).toBe('string');
      expect(typeof event.attributes[URL_ATTRIBUTE]).toBe('string');
      expect(typeof event.attributes[STATUS_CODE_ATTRIBUTE]).toBe('number');
      expect(typeof event.attributes[INITIATOR_ATTRIBUTE]).toBe('string');
      expect(fixtureRequestKey(event)).toMatch(/^[0-9a-f]+$/);
      expect(fixtureRequestKey(event)).toHaveLength(REQUEST_KEY_HEX_LENGTH);
      // The sample is committed already redacted: the URL was masked and the
      // key was exempted, which is exactly why grouping still works on it
      // (AAP 0.5.2, `../redaction/redactor.ts`).
      expect(event.redacted).toStrictEqual([URL_ATTRIBUTE]);
      expect(event.redacted).not.toContain(REQUEST_KEY_ATTRIBUTE);
    }
  });

  it('carries the byte-identical burst and the parameterised pair as data', () => {
    const events = captureBatchEvents();
    const burst = FIXTURE_BURST_FETCH_IDS.map((id) => fixtureEvent(events, id));
    const detail = FIXTURE_DETAIL_FETCH_IDS.map((id) => fixtureEvent(events, id));

    // Four issues of one request: identical URLs, one key, and start times in
    // the order the id list states, so every expectation below can be written
    // against that order.
    expect(burst.map((event) => event.attributes[URL_ATTRIBUTE])).toStrictEqual(
      Array.from(FIXTURE_BURST_FETCH_IDS, () => FIXTURE_BURST_URL),
    );
    expect(new Set(burst.map(fixtureRequestKey)).size).toBe(1);
    expect(consecutiveGaps(burst.map((event) => event.startTime)).every((gap) => gap > 0)).toBe(
      true,
    );

    // Two unrelated requests that redaction made indistinguishable: same URL,
    // different keys. This is the pair whose separation only the pre-redaction
    // key can produce.
    expect(detail.map((event) => event.attributes[URL_ATTRIBUTE])).toStrictEqual([
      FIXTURE_DETAIL_URL,
      FIXTURE_DETAIL_URL,
    ]);
    expect(new Set(detail.map(fixtureRequestKey)).size).toBe(2);
    expect(new Set([...burst, ...detail].map(fixtureRequestKey)).size).toBe(3);
  });
});

describe('aggregateRequests over the committed capture fixture', () => {
  it('reports one group per distinct request key, in the documented base order', () => {
    const events = captureBatchEvents();
    const burstKey = fixtureRequestKey(
      fixtureEvent(events, elementAt(FIXTURE_BURST_FETCH_IDS, 0, 'the first burst fetch')),
    );
    const itemsKey = fixtureRequestKey(fixtureEvent(events, FIXTURE_ITEMS_FETCH_ID));
    const detailKeys = FIXTURE_DETAIL_FETCH_IDS.map((id) =>
      fixtureRequestKey(fixtureEvent(events, id)),
    );

    const groups = aggregateRequests(events);

    // Pinned, so an edit to the fixture surfaces here rather than as a changed
    // metric in a panel nobody is looking at.
    expect(groups).toHaveLength(FIXTURE_REQUEST_GROUP_COUNT);
    expect(groups.map((group) => group.groupedBy)).toStrictEqual(
      Array.from(groups, () => BY_REQUEST_KEY),
    );
    // Redundancy first, then frequency, then total time: the burst leads, the
    // three singletons follow in descending duration.
    expect(groups.map((group) => group.requestKey)).toStrictEqual([
      burstKey,
      itemsKey,
      ...detailKeys,
    ]);
    expect(groups.map((group) => group.count)).toStrictEqual([4, 1, 1, 1]);
    expect(groups.map((group) => group.duplicateCount)).toStrictEqual([3, 0, 0, 0]);
    expect(groups.map((group) => group.totalDurationMs)).toStrictEqual([
      689.547, 1112.65, 96.4, 88.1,
    ]);
    expect(groups.map((group) => group.method)).toStrictEqual(Array.from(groups, () => GET_METHOD));
    expect(groups.map((group) => group.url)).toStrictEqual([
      FIXTURE_BURST_URL,
      FIXTURE_ITEMS_URL,
      FIXTURE_DETAIL_URL,
      FIXTURE_DETAIL_URL,
    ]);
    expect(groups.map((group) => group.path)).toStrictEqual([
      FIXTURE_BURST_PATH,
      FIXTURE_ITEMS_PATH,
      FIXTURE_DETAIL_PATH,
      FIXTURE_DETAIL_PATH,
    ]);
    // Every request event is accounted for exactly once, and every group id is
    // distinct even where two groups agree on every displayed field.
    expect(totalCount(groups)).toBe(FIXTURE_REQUEST_EVENT_COUNT);
    expect(new Set(groups.map((group) => group.id)).size).toBe(FIXTURE_REQUEST_GROUP_COUNT);
  });

  it('keeps the two differently parameterised detail fetches in separate groups', () => {
    // THE DECISIVE CASE, driven by the fixture. The two events display the same
    // masked URL and were issued 12.5 ms apart - well inside the default
    // window - so nothing except the pre-redaction key can keep them apart. A
    // module that grouped on the URL would return one group of two here and
    // badge two unrelated requests as duplicates of each other.
    const events = captureBatchEvents();
    const detail = FIXTURE_DETAIL_FETCH_IDS.map((id) => fixtureEvent(events, id));
    const first = elementAt(detail, 0, 'the first detail fetch');
    const second = elementAt(detail, 1, 'the second detail fetch');

    expect(second.startTime - first.startTime).toBeLessThan(DEFAULT_DUPLICATE_WINDOW_MS);

    const groups = aggregateRequests(events);
    const firstGroup = groupForRequestKey(groups, fixtureRequestKey(first));
    const secondGroup = groupForRequestKey(groups, fixtureRequestKey(second));

    expect(firstGroup.id).not.toBe(secondGroup.id);
    expect([firstGroup.count, secondGroup.count]).toStrictEqual([1, 1]);
    expect([firstGroup.duplicateCount, secondGroup.duplicateCount]).toStrictEqual([0, 0]);
    expect([firstGroup.hasDuplicates, secondGroup.hasDuplicates]).toStrictEqual([false, false]);
    expect(firstGroup.duplicateWindows).toStrictEqual([]);
    expect(secondGroup.duplicateWindows).toStrictEqual([]);
    // Identical display, distinct evidence.
    expect([firstGroup.url, secondGroup.url]).toStrictEqual([
      FIXTURE_DETAIL_URL,
      FIXTURE_DETAIL_URL,
    ]);
    expect(firstGroup.occurrences.map((occurrence) => occurrence.eventId)).toStrictEqual([
      first.id,
    ]);
    expect(secondGroup.occurrences.map((occurrence) => occurrence.eventId)).toStrictEqual([
      second.id,
    ]);
    expect([firstGroup.initiators, secondGroup.initiators]).toStrictEqual([
      [FIXTURE_DETAIL_INITIATOR],
      [FIXTURE_DETAIL_INITIATOR],
    ]);
  });

  it('collapses the four identical fetches into one window of three redundant calls', () => {
    const events = captureBatchEvents();
    const burst = FIXTURE_BURST_FETCH_IDS.map((id) => fixtureEvent(events, id));
    const anchor = elementAt(burst, 0, 'the first burst fetch');
    const last = elementAt(burst, FIXTURE_BURST_FETCH_IDS.length - 1, 'the last burst fetch');

    const group = groupForRequestKey(aggregateRequests(events), fixtureRequestKey(anchor));

    expect(group.count).toBe(4);
    expect(group.duplicateCount).toBe(3);
    expect(group.hasDuplicates).toBe(true);
    expect(group.duplicateWindows).toHaveLength(1);

    const window = windowAt(group, 0);

    // The window bounds issuance - first start to last start - so the product's
    // worked analysis example ("4 requests to /api/prices occurred within
    // 22 ms", AAP 0.1.2) reads straight off it. The fixture's own spread is
    // 21.942 ms, comfortably inside the one-second default window.
    expect(window.id).toBe(`${group.id}#w0`);
    expect(window.startTime).toBe(anchor.startTime);
    expect(window.endTime).toBe(last.startTime);
    expect(roundMs(window.endTime - window.startTime)).toBe(21.942);
    expect(window.endTime - window.startTime).toBeLessThan(DEFAULT_DUPLICATE_WINDOW_MS);
    expect(window.count).toBe(4);
    expect(window.redundantCount).toBe(3);
    expect(window.eventIds).toStrictEqual([...FIXTURE_BURST_FETCH_IDS]);
    // The group's own span agrees with the single window it emitted.
    expect(group.firstStartTime).toBe(anchor.startTime);
    expect(group.lastStartTime).toBe(last.startTime);
  });

  it('splits that window when the duplicate window is narrowed to the burst\u2019s own largest gap', () => {
    const events = captureBatchEvents();
    const starts = FIXTURE_BURST_FETCH_IDS.map((id) => fixtureEvent(events, id).startTime);
    const gaps = consecutiveGaps(starts);
    // Derived from the fixture's own timestamps rather than stated as a
    // literal, so a re-timed fixture cannot leave this case asserting against
    // a spacing the file no longer has.
    const narrowedWindowMs = Math.max(...gaps);
    const anchorStart = elementAt(starts, 0, 'the first burst start time');
    const secondStart = elementAt(starts, 1, 'the second burst start time');
    const thirdStart = elementAt(starts, 2, 'the third burst start time');
    const lastStart = elementAt(starts, 3, 'the last burst start time');

    // The preconditions that make the split meaningful, asserted so that a
    // fixture edit reports which of them stopped holding: every neighbour is
    // still within one narrowed window of its predecessor, the narrowed window
    // is shorter than the burst's total spread, and the first cluster's anchor
    // cannot reach the third occurrence.
    expect(gaps).toHaveLength(3);
    expect(gaps.every((gap) => gap <= narrowedWindowMs)).toBe(true);
    expect(narrowedWindowMs).toBeLessThan(lastStart - anchorStart);
    expect(thirdStart - anchorStart).toBeGreaterThan(narrowedWindowMs);

    const narrowed = aggregateRequests(events, { duplicateWindowMs: narrowedWindowMs });
    const group = groupForRequestKey(
      narrowed,
      fixtureRequestKey(
        fixtureEvent(events, elementAt(FIXTURE_BURST_FETCH_IDS, 0, 'the first burst fetch')),
      ),
    );

    // Two pairs rather than one burst of four: the analysis stage can ask for a
    // stricter reading of the same capture, and the count of *occurrences* is
    // untouched by it.
    expect(group.count).toBe(4);
    expect(group.duplicateWindows).toHaveLength(2);
    expect(
      group.duplicateWindows.map((duplicateWindow) => [
        duplicateWindow.startTime,
        duplicateWindow.endTime,
      ]),
    ).toStrictEqual([
      [anchorStart, secondStart],
      [thirdStart, lastStart],
    ]);
    expect(group.duplicateWindows.map((duplicateWindow) => duplicateWindow.count)).toStrictEqual([
      2, 2,
    ]);
    expect(
      group.duplicateWindows.map((duplicateWindow) => duplicateWindow.redundantCount),
    ).toStrictEqual([1, 1]);
    expect(group.duplicateWindows.map((duplicateWindow) => duplicateWindow.eventIds)).toStrictEqual(
      [FIXTURE_BURST_FETCH_IDS.slice(0, 2), FIXTURE_BURST_FETCH_IDS.slice(2)],
    );
    expect(group.duplicateWindows.map((duplicateWindow) => duplicateWindow.id)).toStrictEqual([
      `${group.id}#w0`,
      `${group.id}#w1`,
    ]);
    expect(group.duplicateCount).toBe(2);
    expect(countDuplicateRequests(narrowed)).toBe(2);
  });

  it('describes every occurrence of the burst, in issue order, with its own evidence', () => {
    const events = captureBatchEvents();
    const burst = FIXTURE_BURST_FETCH_IDS.map((id) => fixtureEvent(events, id));
    const anchor = elementAt(burst, 0, 'the first burst fetch');

    const group = groupForRequestKey(aggregateRequests(events), fixtureRequestKey(anchor));

    expect(group.occurrences).toHaveLength(4);
    expect(group.occurrencesTruncated).toBe(false);
    expect(group.occurrences.map((occurrence) => occurrence.eventId)).toStrictEqual([
      ...FIXTURE_BURST_FETCH_IDS,
    ]);
    expect(group.occurrences.map((occurrence) => occurrence.startTime)).toStrictEqual(
      burst.map((event) => event.startTime),
    );
    expect(group.occurrences.map((occurrence) => occurrence.durationMs)).toStrictEqual([
      672.4, 6.418, 5.822, 4.907,
    ]);
    // The initiator set is the finding: the first two issues came from a hook,
    // the last two from the component that consumes it, which is a different
    // fix from one caller firing four times (AAP 0.8.2).
    expect(group.occurrences.map((occurrence) => occurrence.initiator)).toStrictEqual([
      FIXTURE_HOOK_INITIATOR,
      FIXTURE_HOOK_INITIATOR,
      FIXTURE_COMPONENT_INITIATOR,
      FIXTURE_COMPONENT_INITIATOR,
    ]);
    // Code-unit order, and both labels kept: 'WidgetPanel' before
    // 'fetchItemList' because upper case sorts first.
    expect(group.initiators).toStrictEqual([FIXTURE_COMPONENT_INITIATOR, FIXTURE_HOOK_INITIATOR]);
    expect(group.occurrences.map((occurrence) => occurrence.status)).toStrictEqual(
      Array.from(group.occurrences, () => OK_STATUS),
    );
    expect(group.occurrences.map((occurrence) => occurrence.statusCode)).toStrictEqual([
      200, 200, 200, 200,
    ]);
    expect(group.statusCodes).toStrictEqual([200]);
    expect(group.errorCount).toBe(0);
    expect(group.occurrences.map((occurrence) => occurrence.kind)).toStrictEqual(
      Array.from(group.occurrences, () => PRIMARY_REQUEST_KIND),
    );
    expect(group.occurrences.map((occurrence) => occurrence.tier)).toStrictEqual(
      Array.from(group.occurrences, () => firstAllowedTier(PRIMARY_REQUEST_KIND)),
    );
    // Each occurrence keeps the location its own initiator resolved to, and the
    // two resolvers the fixture exercises stay distinguishable, because the
    // request row expands to a source link per occurrence (AAP 0.6.2).
    expect(group.occurrences.map((occurrence) => occurrence.source)).toStrictEqual(
      burst.map((event) => event.source),
    );
    expect(group.occurrences.map((occurrence) => occurrence.source?.resolvedBy)).toStrictEqual([
      'source-map',
      'source-map',
      'react-owner',
      'react-owner',
    ]);
    expect(group.occurrences.map((occurrence) => occurrence.source?.symbol)).toStrictEqual([
      FIXTURE_HOOK_INITIATOR,
      FIXTURE_HOOK_INITIATOR,
      FIXTURE_COMPONENT_INITIATOR,
      FIXTURE_COMPONENT_INITIATOR,
    ]);
    // Trace attribution survives per occurrence: one trace, and the
    // interaction span every fetch of this capture hangs off.
    expect(group.occurrences.map((occurrence) => occurrence.traceId)).toStrictEqual(
      burst.map((event) => event.traceId),
    );
    expect(group.occurrences.map((occurrence) => occurrence.parentSpanId)).toStrictEqual(
      Array.from(group.occurrences, () => FIXTURE_INTERACTION_SPAN_ID),
    );
    expect(group.occurrences.map((occurrence) => occurrence.spanId)).toStrictEqual(
      burst.map((event) => event.spanId),
    );
    // One value under two names, on a fixture-sourced event as on a built one.
    expect(group.occurrences.map((occurrence) => occurrence.id)).toStrictEqual(
      group.occurrences.map((occurrence) => occurrence.eventId),
    );

    const first = occurrenceAt(group, 0);

    expect(first.endTime).toBe(1_789_812_901_212.518);
    expect(group.averageDurationMs).toBe(roundMs(group.totalDurationMs / group.count));
    expect(group.averageDurationMs).toBe(172.387);
    expect(group.maxDurationMs).toBe(672.4);
    expect(group.minDurationMs).toBe(4.907);
  });

  it('ignores every event whose kind is not a request kind, the keyed server spans included', () => {
    const events = captureBatchEvents();
    const ignoredEvents = events.filter((event) => !REQUEST_KINDS.includes(event.kind));
    const keyedServerSpans = ignoredEvents.filter(
      (event) => typeof event.attributes[REQUEST_KEY_ATTRIBUTE] === 'string',
    );
    const itemsFetch = fixtureEvent(events, FIXTURE_ITEMS_FETCH_ID);
    const burstKey = fixtureRequestKey(
      fixtureEvent(events, elementAt(FIXTURE_BURST_FETCH_IDS, 0, 'the first burst fetch')),
    );

    // Twenty-eight events - an interaction, renders and commits, route
    // handlers, server functions, statements and the database tier's own
    // lifecycle spans, state transitions, a long task, an error and the two
    // server spans - produce no group at all.
    expect(ignoredEvents).toHaveLength(FIXTURE_IGNORED_EVENT_COUNT);
    expect(aggregateRequests(ignoredEvents)).toStrictEqual([]);

    // The two server spans carry the *same* keys as two of the fetches, and are
    // still not occurrences of them: `requests` is the browser's view of a
    // request, and the server's half of it is the waterfall's row (AAP 0.6.2).
    // Were they counted, the items group would report two occurrences and the
    // burst five, inflating both the `request_count` card and the badge.
    expect(keyedServerSpans.map(fixtureRequestKey)).toStrictEqual([
      fixtureRequestKey(itemsFetch),
      burstKey,
    ]);

    const groups = aggregateRequests(events);
    const itemsGroup = groupForRequestKey(groups, fixtureRequestKey(itemsFetch));

    expect(itemsGroup.count).toBe(1);
    expect(itemsGroup.occurrences.map((occurrence) => occurrence.eventId)).toStrictEqual([
      itemsFetch.id,
    ]);
    expect(itemsGroup.initiators).toStrictEqual([FIXTURE_HOOK_INITIATOR]);
    expect(itemsGroup.hasDuplicates).toBe(false);
    expect(groupForRequestKey(groups, burstKey).count).toBe(4);
    expect(totalCount(groups)).toBe(FIXTURE_REQUEST_EVENT_COUNT);
  });

  it('publishes three redundant requests for the whole capture', () => {
    const events = captureBatchEvents();

    const groups = aggregateRequests(events);

    // The `duplicate_request_count` metric card `./summary.ts` publishes for
    // this capture, and the same arithmetic the request table badges: three
    // redundant calls, all of them in the one group that repeated.
    expect(countDuplicateRequests(groups)).toBe(FIXTURE_REDUNDANT_REQUEST_COUNT);
    expect(countDuplicateRequests(groups)).toBe(totalDuplicateCount(groups));
    expect(groups.filter((group) => group.hasDuplicates).map((group) => group.count)).toStrictEqual(
      [4],
    );
    expect(
      groups.flatMap((group) => group.duplicateWindows).map((window) => window.redundantCount),
    ).toStrictEqual([FIXTURE_REDUNDANT_REQUEST_COUNT]);
  });
});
