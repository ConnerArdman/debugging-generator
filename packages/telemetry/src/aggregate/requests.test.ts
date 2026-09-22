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
 * character rather than written out as dense 64-character literals:
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

import { describe, expect, it } from 'vitest';

import { DEFAULT_RESOLUTION_CONFIDENCE, ID_PREFIXES, roundMs } from '@debuggen/shared';
import type { EventId, SourceLocation, SpanId, TraceId } from '@debuggen/shared';

import { FETCH_ATTRIBUTE_KEYS, SERVICE_ASSIGNED_ATTRIBUTE_KEYS } from '../schema/attributes.js';
import { isTelemetryEvent } from '../schema/event.js';
import type { TelemetryEvent } from '../schema/event.js';
import { REQUEST_KINDS, TELEMETRY_KINDS, allowedTiersFor } from '../schema/kinds.js';
import type { TelemetryKind, TelemetryStatus, TelemetryTier } from '../schema/kinds.js';
import {
  DEFAULT_DUPLICATE_WINDOW_MS,
  DEFAULT_MAX_OCCURRENCES_PER_GROUP,
  DEFAULT_MAX_REQUEST_OCCURRENCES_PER_GROUP,
  REQUEST_GROUPED_BY,
  UNKNOWN_METHOD_LABEL,
  UNKNOWN_URL_LABEL,
  aggregateRequests,
  countDuplicateRequests,
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
 * accidentally share an identifier, would make every case below vacuous.
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
