/**
 * Colocated tests for `./summary.ts`: the closed metric vocabulary's published
 * *values* and the capture rollup that carries them.
 *
 * ## What this suite is for
 *
 * Three properties of this module are contracts rather than implementation
 * details, and each is invisible when it breaks:
 *
 * 1. **The metric id set and its order.** `packages/panel-schema` validates a
 *    `metricCards` node's `metrics` against the vocabulary, the renderer draws
 *    one card per id and the prose layer names the counting ones in a
 *    sentence. A renamed or reordered id does not throw anywhere — it yields a
 *    card reading `n/a` beside a number the capture did record. The list is
 *    therefore **restated as data** below, in AAP 0.2.3's order, and compared:
 *    a check that asserted `METRIC_IDS.length === 14`, or compared the
 *    vocabulary with itself, would keep passing through the drift it exists to
 *    catch.
 * 2. **The arithmetic.** Per-tier durations are interval unions, not sums;
 *    blocking time is the excess past the long-task threshold; a failure is
 *    counted once however many ways it qualifies. Each of those is a decision
 *    that produces a plausible wrong number when got wrong, so each is pinned
 *    with overlapping, adversarial fixtures rather than with one happy path.
 * 3. **Honesty.** An unmeasurable metric must be published *without* a value,
 *    and a render whose trigger could not be determined must never be counted
 *    as an unchanged render (AAP 0.8.4, 0.2.3). Both are asserted on the
 *    published shape — the absence of a `value` **key**, not a falsy value.
 *
 * ## What the compiler already guarantees, and is not re-tested here
 *
 * `METRIC_DEFINITIONS` is annotated `Record<MetricId, MetricDefinition>`, so a
 * missing or invented entry is a compile error, and the measurement record
 * inside `computeMetrics` is annotated the same way. What the compiler cannot
 * see is whether each entry describes the id it is filed under, whether the
 * zero-filled tallies cover their vocabularies, and whether the numbers are
 * right; those are asserted below.
 *
 * Fixtures are schema-valid persisted events — `isTelemetryEvent` accepts
 * every one — because this module runs on what the store holds, and a fixture
 * that could not be persisted would be testing a shape the product never sees.
 */

import { describe, expect, it } from 'vitest';

import {
  FETCH_ATTRIBUTE_KEYS,
  PERF_ENTRY_ATTRIBUTE_KEYS,
  PERF_LONGTASK_ATTRIBUTE_KEYS,
  RENDER_ATTRIBUTE_KEYS,
  RENDER_TRIGGERS,
  metricUnitFor,
  type MetricId,
  type RenderTrigger,
} from '../schema/attributes.js';
import { isTelemetryEvent, type TelemetryEvent } from '../schema/event.js';
import {
  TELEMETRY_KINDS,
  TELEMETRY_TIERS,
  allowedTiersFor,
  type TelemetryKind,
  type TelemetryStatus,
  type TelemetryTier,
} from '../schema/kinds.js';
import { aggregateQueries } from './queries.js';
import { aggregateRenders } from './renders.js';
import { aggregateRequests, countDuplicateRequests } from './requests.js';
import {
  DEFAULT_MAX_TRACE_IDS,
  DEFAULT_TOP_N,
  LONG_TASK_BLOCKING_THRESHOLD_MS,
  METRIC_DEFINITIONS,
  METRIC_IDS,
  computeCaptureSummary,
  computeMetrics,
  type CaptureSummary,
  type MetricValue,
} from './summary.js';

/*
 * ---------------------------------------------------------------------------
 * The plan, restated as data
 * ---------------------------------------------------------------------------
 */

/**
 * The fourteen ids AAP 0.2.3 fixes, in the plan's order.
 *
 * Written out rather than derived: the plan is a document, so comparing the
 * code against it means restating it here. This array is the one place in the
 * suite where a metric id is spelled by hand.
 */
const PLANNED_METRIC_IDS: readonly string[] = [
  'total_duration',
  'frontend_duration',
  'backend_duration',
  'database_duration',
  'render_count',
  'unchanged_render_count',
  'render_trigger_unknown_count',
  'request_count',
  'query_count',
  'transferred_bytes',
  'blocking_time',
  'duplicate_request_count',
  'long_task_count',
  'error_count',
];

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Kinds, tiers and attribute keys come from the schema modules, so a fixture
 * cannot drift from the vocabulary the module under test classifies by. The
 * attribute keys are annotated with their catalog's tuple type, which makes a
 * misspelling a compile error.
 * ---------------------------------------------------------------------------
 */

/** The interaction kind: the browser-side root of a correlated trace. */
const INTERACTION_KIND: TelemetryKind = 'interaction';

/** The render kind, the only one the render aggregate counts. */
const RENDER_KIND: TelemetryKind = 'render';

/** The browser's request kind. */
const FETCH_KIND: TelemetryKind = 'fetch';

/** The framework's incoming-request kind. */
const HTTP_SERVER_KIND: TelemetryKind = 'http.server';

/** The named-function kind, produced on either tier. */
const FUNCTION_KIND: TelemetryKind = 'function';

/** The database kind. */
const DB_QUERY_KIND: TelemetryKind = 'db.query';

/** The long-task kind. */
const LONG_TASK_KIND: TelemetryKind = 'perf.longtask';

/** The other performance kind, which is never a long task. */
const PERF_ENTRY_KIND: TelemetryKind = 'perf.entry';

/** The page-error kind. */
const ERROR_KIND: TelemetryKind = 'error';

/** The navigation kind, which can also report a transfer size. */
const NAVIGATION_KIND: TelemetryKind = 'navigation';

/** The three tiers, named so a fixture states the tier it means. */
const BROWSER_TIER: TelemetryTier = 'browser';
const SERVER_TIER: TelemetryTier = 'server';
const DATABASE_TIER: TelemetryTier = 'db';

/** Statuses a fixture sets. */
const OK_STATUS: TelemetryStatus = 'ok';
const ERROR_STATUS: TelemetryStatus = 'error';

/** Render attribute keys, from the render catalog. */
const COMPONENT_ATTRIBUTE: (typeof RENDER_ATTRIBUTE_KEYS)[number] = 'component';
const TRIGGER_ATTRIBUTE: (typeof RENDER_ATTRIBUTE_KEYS)[number] = 'trigger';

/** Request attribute keys, from the fetch catalog. */
const METHOD_ATTRIBUTE: (typeof FETCH_ATTRIBUTE_KEYS)[number] = 'http.method';
const URL_ATTRIBUTE: (typeof FETCH_ATTRIBUTE_KEYS)[number] = 'url';
const REQUEST_KEY_ATTRIBUTE: (typeof FETCH_ATTRIBUTE_KEYS)[number] = 'request_key';
const TRANSFER_SIZE_ATTRIBUTE: (typeof PERF_ENTRY_ATTRIBUTE_KEYS)[number] = 'transferSize';

/** The long task's own blocking-time key. */
const BLOCKING_TIME_ATTRIBUTE: (typeof PERF_LONGTASK_ATTRIBUTE_KEYS)[number] = 'blockingTime';

/** The two trigger members whose totals are published as metrics. */
const UNCHANGED_TRIGGER: RenderTrigger = 'unchanged';
const UNKNOWN_TRIGGER: RenderTrigger = 'unknown';

/** A trigger that is neither of those two. */
const PROPS_TRIGGER: RenderTrigger = 'props';

/*
 * ---------------------------------------------------------------------------
 * Fixture construction
 * ---------------------------------------------------------------------------
 */

/** Inside the epoch window the event schema accepts, with sub-millisecond precision. */
const BASE_TIME = 1_764_547_200_000.5;

/** The capture every fixture belongs to. */
const CAPTURE_ID = 'cap_0000000000000001';

/** The session that owns it. */
const SESSION_ID = 'ses_0000000000000001';

/** The producer most fixtures come from. */
const PRODUCER_ID = 'prd_0000000000000001';

/** A second producer, for the distinct-producer assertions. */
const SECOND_PRODUCER_ID = 'prd_0000000000000002';

/** Monotonic source of every fixture identifier, so ids are reproducible. */
let fixtureOrdinal = 0;

/** The next ordinal. */
function nextOrdinal(): number {
  fixtureOrdinal += 1;
  return fixtureOrdinal;
}

/** `ordinal` as exactly `length` lowercase hex digits, which the schema requires. */
function hexId(length: number, ordinal: number): string {
  const digits = ordinal.toString(16);
  if (digits.length > length) {
    throw new Error(`fixture ordinal ${String(ordinal)} exceeds ${String(length)} hex digits`);
  }
  return digits.padStart(length, '0');
}

/** A fresh trace id: 32 lowercase hex characters. */
function nextTraceId(): string {
  return hexId(32, nextOrdinal());
}

/** A fresh span id: 16 lowercase hex characters. */
function nextSpanId(): string {
  return hexId(16, nextOrdinal());
}

/** A fresh event id in the product's `evt_…` shape. */
function nextEventId(): string {
  return `evt_${hexId(16, nextOrdinal())}`;
}

/** The first tier the catalog permits for `kind`, so a fixture is always well-formed. */
function defaultTierFor(kind: TelemetryKind): TelemetryTier {
  const [tier] = allowedTiersFor(kind);
  if (tier === undefined) {
    throw new Error(`the kind "${kind}" permits no tier`);
  }
  return tier;
}

/** What a fixture may override. */
interface EventOverrides {
  readonly id?: string;
  readonly kind?: TelemetryKind;
  readonly tier?: TelemetryTier;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly name?: string;
  readonly startTime?: number;
  readonly duration?: number;
  readonly status?: TelemetryStatus;
  readonly producerId?: string;
  readonly seq?: number;
  readonly attributes?: Record<string, unknown>;
}

/**
 * One persisted event with every required field populated.
 *
 * The kind's first permitted tier is used unless the case names one, so a
 * fixture cannot accidentally describe a database span produced by the browser
 * — a combination the event schema rejects and the store therefore never
 * holds.
 */
function makeEvent(overrides: EventOverrides = {}): TelemetryEvent {
  const kind = overrides.kind ?? INTERACTION_KIND;
  const ordinal = nextOrdinal();
  return {
    id: overrides.id ?? nextEventId(),
    traceId: overrides.traceId ?? nextTraceId(),
    spanId: overrides.spanId ?? nextSpanId(),
    ...(overrides.parentSpanId !== undefined ? { parentSpanId: overrides.parentSpanId } : {}),
    kind,
    name: overrides.name ?? `fixture ${String(ordinal)}`,
    startTime: overrides.startTime ?? BASE_TIME,
    duration: overrides.duration ?? 1,
    tier: overrides.tier ?? defaultTierFor(kind),
    attributes: overrides.attributes ?? {},
    status: overrides.status ?? OK_STATUS,
    producerId: overrides.producerId ?? PRODUCER_ID,
    seq: overrides.seq ?? ordinal,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq: ordinal,
  };
}

/** A render of `component` with the given trigger. */
function makeRenderEvent(component: string, trigger: RenderTrigger, duration = 2): TelemetryEvent {
  return makeEvent({
    kind: RENDER_KIND,
    duration,
    attributes: { [COMPONENT_ATTRIBUTE]: component, [TRIGGER_ATTRIBUTE]: trigger },
  });
}

/** A browser request, optionally sharing a request key with another fixture. */
function makeRequestEvent(
  overrides: {
    readonly url?: string;
    readonly requestKey?: string;
    readonly startTime?: number;
    readonly duration?: number;
    readonly transferSize?: number;
    readonly status?: TelemetryStatus;
    readonly traceId?: string;
  } = {},
): TelemetryEvent {
  const attributes: Record<string, unknown> = {
    [METHOD_ATTRIBUTE]: 'GET',
    [URL_ATTRIBUTE]: overrides.url ?? '/api/items',
    [REQUEST_KEY_ATTRIBUTE]: overrides.requestKey ?? `key-${String(nextOrdinal())}`,
  };
  if (overrides.transferSize !== undefined) {
    attributes[TRANSFER_SIZE_ATTRIBUTE] = overrides.transferSize;
  }
  return makeEvent({
    kind: FETCH_KIND,
    ...(overrides.traceId !== undefined ? { traceId: overrides.traceId } : {}),
    ...(overrides.startTime !== undefined ? { startTime: overrides.startTime } : {}),
    ...(overrides.duration !== undefined ? { duration: overrides.duration } : {}),
    ...(overrides.status !== undefined ? { status: overrides.status } : {}),
    attributes,
  });
}

/** A long task, with or without the producer's own blocking-time figure. */
function makeLongTaskEvent(duration: number, blockingTime?: number): TelemetryEvent {
  const attributes: Record<string, unknown> = {};
  if (blockingTime !== undefined) {
    attributes[BLOCKING_TIME_ATTRIBUTE] = blockingTime;
  }
  return makeEvent({ kind: LONG_TASK_KIND, duration, attributes });
}

/** The value of one metric, by id. */
function metric(values: readonly MetricValue[], id: MetricId): MetricValue {
  const found = values.find((value) => value.id === id);
  if (found === undefined) {
    throw new Error(`the metric "${id}" was not published`);
  }
  return found;
}

/** The number one metric published, failing the case when it published none. */
function valueOf(values: readonly MetricValue[], id: MetricId): number {
  const published = metric(values, id);
  const { value } = published;
  if (value === undefined) {
    throw new Error(`the metric "${id}" was published without a value`);
  }
  return value;
}

/** A structural clone, for the non-mutation checks. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The context every summary fixture is built with. */
function makeContext(): { captureId: string; sessionId: string } {
  return { captureId: CAPTURE_ID, sessionId: SESSION_ID };
}

/*
 * ---------------------------------------------------------------------------
 * The vocabulary and its definitions
 * ---------------------------------------------------------------------------
 */

describe('the computed-metric vocabulary', () => {
  it('publishes exactly the fourteen ids the plan fixes, in the plan order', () => {
    expect([...METRIC_IDS]).toEqual(PLANNED_METRIC_IDS);
  });

  it('holds no duplicate id', () => {
    expect(new Set(METRIC_IDS).size).toBe(METRIC_IDS.length);
  });

  it('defines every id exactly once, keyed by the id it describes', () => {
    expect(Object.keys(METRIC_DEFINITIONS).sort()).toEqual([...METRIC_IDS].sort());
    for (const id of METRIC_IDS) {
      expect(METRIC_DEFINITIONS[id].id).toBe(id);
    }
  });

  it('takes each unit from the vocabulary and derives the formatting kind from it', () => {
    const kindByUnit: Readonly<Record<string, string>> = {
      milliseconds: 'duration',
      count: 'count',
      bytes: 'bytes',
    };
    for (const id of METRIC_IDS) {
      const definition = METRIC_DEFINITIONS[id];
      expect(definition.unit).toBe(metricUnitFor(id));
      expect(definition.kind).toBe(kindByUnit[definition.unit]);
    }
  });

  it('labels and describes every metric as a rule, in generic product vocabulary', () => {
    for (const id of METRIC_IDS) {
      const { label, description } = METRIC_DEFINITIONS[id];
      expect(label.length).toBeGreaterThan(0);
      expect(label.trim()).toBe(label);
      // The descriptions are surfaced to the panel-generation prompt, so each
      // has to be a complete sentence rather than a fragment.
      expect(description.length).toBeGreaterThan(20);
      expect(description.endsWith('.')).toBe(true);
    }
  });

  it('names the threshold and bounds the plan states', () => {
    expect(LONG_TASK_BLOCKING_THRESHOLD_MS).toBe(50);
    expect(DEFAULT_TOP_N).toBe(10);
    expect(DEFAULT_MAX_TRACE_IDS).toBe(50);
  });

  it('classifies renders by members of the trigger vocabulary', () => {
    // The two totals this module publishes separately must be real members,
    // and they must be different members: conflating them would let a render
    // nobody could classify be reported as one with stable inputs.
    expect(RENDER_TRIGGERS).toContain(UNCHANGED_TRIGGER);
    expect(RENDER_TRIGGERS).toContain(UNKNOWN_TRIGGER);
    expect(UNCHANGED_TRIGGER).not.toBe(UNKNOWN_TRIGGER);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Fixture sanity
 * ---------------------------------------------------------------------------
 */

describe('the fixtures', () => {
  it('are events the store could hold', () => {
    expect(isTelemetryEvent(makeEvent())).toBe(true);
    expect(isTelemetryEvent(makeRenderEvent('Widget', PROPS_TRIGGER))).toBe(true);
    expect(isTelemetryEvent(makeRequestEvent({ transferSize: 10 }))).toBe(true);
    expect(isTelemetryEvent(makeLongTaskEvent(120, 70))).toBe(true);
    expect(isTelemetryEvent(makeEvent({ kind: DB_QUERY_KIND, tier: DATABASE_TIER }))).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * computeMetrics
 * ---------------------------------------------------------------------------
 */

describe('computeMetrics', () => {
  it('publishes fourteen values in vocabulary order, labelled from the definitions', () => {
    const values = computeMetrics([makeEvent()]);

    expect(values).toHaveLength(METRIC_IDS.length);
    expect(values.map((value) => value.id)).toEqual([...METRIC_IDS]);
    for (const value of values) {
      const definition = METRIC_DEFINITIONS[value.id];
      expect(value.label).toBe(definition.label);
      expect(value.unit).toBe(definition.unit);
    }
  });

  it('measures the total duration as the latest end minus the earliest start', () => {
    const values = computeMetrics([
      makeEvent({ startTime: BASE_TIME, duration: 10 }),
      makeEvent({ startTime: BASE_TIME + 5, duration: 20 }),
    ]);

    expect(valueOf(values, 'total_duration')).toBe(25);
  });

  it('unions overlapping intervals per tier instead of summing them', () => {
    const traceId = nextTraceId();
    const events = [
      // The interaction covers the whole window: [0, 100].
      makeEvent({ traceId, kind: INTERACTION_KIND, startTime: BASE_TIME, duration: 100 }),
      // Two server spans, the second nested inside the first: [10, 60] ∪ [20, 40] = 50 ms.
      makeEvent({
        traceId,
        kind: HTTP_SERVER_KIND,
        startTime: BASE_TIME + 10,
        duration: 50,
      }),
      makeEvent({
        traceId,
        kind: FUNCTION_KIND,
        tier: SERVER_TIER,
        startTime: BASE_TIME + 20,
        duration: 20,
      }),
      // Two overlapping statements: [25, 35] ∪ [30, 40] = 15 ms, not 20.
      makeEvent({
        traceId,
        kind: DB_QUERY_KIND,
        tier: DATABASE_TIER,
        startTime: BASE_TIME + 25,
        duration: 10,
      }),
      makeEvent({
        traceId,
        kind: DB_QUERY_KIND,
        tier: DATABASE_TIER,
        startTime: BASE_TIME + 30,
        duration: 10,
      }),
    ];

    const values = computeMetrics(events);
    const total = valueOf(values, 'total_duration');
    const frontend = valueOf(values, 'frontend_duration');
    const backend = valueOf(values, 'backend_duration');
    const database = valueOf(values, 'database_duration');

    expect(backend).toBe(50);
    expect(database).toBe(15);
    // The browser's union minus the server's: the page's waiting time belongs
    // to the backend, so the two parts never exceed the whole.
    expect(frontend).toBe(50);
    expect(frontend + backend).toBeLessThanOrEqual(total);
    expect(database).toBeLessThanOrEqual(backend);
  });

  it('attributes a browser interaction wholly to the front end when no server span exists', () => {
    const values = computeMetrics([
      makeEvent({ kind: INTERACTION_KIND, startTime: BASE_TIME, duration: 40 }),
    ]);

    expect(valueOf(values, 'frontend_duration')).toBe(40);
    expect(valueOf(values, 'backend_duration')).toBe(0);
    expect(valueOf(values, 'database_duration')).toBe(0);
  });

  it('counts an unclassifiable render apart from an unchanged one', () => {
    const values = computeMetrics([
      makeRenderEvent('Alpha', UNCHANGED_TRIGGER),
      makeRenderEvent('Alpha', UNCHANGED_TRIGGER),
      makeRenderEvent('Beta', UNKNOWN_TRIGGER),
      makeRenderEvent('Beta', PROPS_TRIGGER),
    ]);

    expect(valueOf(values, 'render_count')).toBe(4);
    expect(valueOf(values, 'unchanged_render_count')).toBe(2);
    expect(valueOf(values, 'render_trigger_unknown_count')).toBe(1);
  });

  it('never folds an unknown trigger into the unchanged total', () => {
    const values = computeMetrics([makeRenderEvent('Alpha', UNKNOWN_TRIGGER)]);

    expect(valueOf(values, 'render_count')).toBe(1);
    expect(valueOf(values, 'unchanged_render_count')).toBe(0);
    expect(valueOf(values, 'render_trigger_unknown_count')).toBe(1);
  });

  it('counts requests and statements per occurrence, through their kind groups', () => {
    const values = computeMetrics([
      makeRequestEvent(),
      makeRequestEvent(),
      // A server-side outgoing request is not a request the page issued.
      makeEvent({ kind: 'http.client', tier: SERVER_TIER }),
      makeEvent({ kind: DB_QUERY_KIND, tier: DATABASE_TIER }),
      makeEvent({ kind: DB_QUERY_KIND, tier: DATABASE_TIER }),
      makeEvent({ kind: DB_QUERY_KIND, tier: DATABASE_TIER }),
    ]);

    expect(valueOf(values, 'request_count')).toBe(2);
    expect(valueOf(values, 'query_count')).toBe(3);
  });

  it('reports duplicate requests exactly as the request aggregate counts them', () => {
    const sharedKey = 'shared-request-key';
    const events = [
      makeRequestEvent({ requestKey: sharedKey, startTime: BASE_TIME }),
      makeRequestEvent({ requestKey: sharedKey, startTime: BASE_TIME + 10 }),
      makeRequestEvent({ requestKey: sharedKey, startTime: BASE_TIME + 20 }),
      makeRequestEvent({ requestKey: 'lonely-request-key', startTime: BASE_TIME + 30 }),
    ];

    const expected = countDuplicateRequests(aggregateRequests(events));
    expect(expected).toBe(2);
    expect(valueOf(computeMetrics(events), 'duplicate_request_count')).toBe(expected);
  });

  it('honours a duplicate window narrow enough to separate the occurrences', () => {
    const sharedKey = 'windowed-request-key';
    const events = [
      makeRequestEvent({ requestKey: sharedKey, startTime: BASE_TIME }),
      makeRequestEvent({ requestKey: sharedKey, startTime: BASE_TIME + 500 }),
    ];

    expect(valueOf(computeMetrics(events), 'duplicate_request_count')).toBe(1);
    expect(
      valueOf(computeMetrics(events, { duplicateWindowMs: 100 }), 'duplicate_request_count'),
    ).toBe(0);
  });

  it('publishes no transferred-bytes value when nothing reported a size', () => {
    const published = metric(
      computeMetrics([makeRequestEvent(), makeRequestEvent()]),
      'transferred_bytes',
    );

    expect(published.available).toBe(false);
    // The absence of the key, not a falsy value: a zero here would claim the
    // capture observed no bytes.
    expect('value' in published).toBe(false);
    expect(published.note).toBeDefined();
  });

  it('sums the reported sizes when every candidate reported one', () => {
    const published = metric(
      computeMetrics([
        makeRequestEvent({ url: '/api/one', transferSize: 1000 }),
        makeRequestEvent({ url: '/api/two', transferSize: 500 }),
      ]),
      'transferred_bytes',
    );

    expect(published.available).toBe(true);
    expect(published.value).toBe(1500);
    expect(published.note).toBeUndefined();
  });

  it('reports a partial sum with a coverage note when only some candidates reported', () => {
    const published = metric(
      computeMetrics([
        makeRequestEvent({ url: '/api/one', transferSize: 700 }),
        makeRequestEvent(),
      ]),
      'transferred_bytes',
    );

    expect(published.value).toBe(700);
    expect(published.note).toBeDefined();
  });

  it('counts one response once when both the request and its resource entry report it', () => {
    const url = '/api/items';
    const values = computeMetrics([
      makeRequestEvent({ url, transferSize: 800 }),
      makeEvent({
        kind: PERF_ENTRY_KIND,
        attributes: { [URL_ATTRIBUTE]: url, [TRANSFER_SIZE_ATTRIBUTE]: 800 },
      }),
    ]);

    expect(valueOf(values, 'transferred_bytes')).toBe(800);
  });

  it('adds resource and navigation sizes the page did not request through fetch', () => {
    const values = computeMetrics([
      makeRequestEvent({ url: '/api/items', transferSize: 100 }),
      makeEvent({
        kind: PERF_ENTRY_KIND,
        attributes: { [URL_ATTRIBUTE]: '/static/app.js', [TRANSFER_SIZE_ATTRIBUTE]: 400 },
      }),
      makeEvent({
        kind: NAVIGATION_KIND,
        attributes: { [URL_ATTRIBUTE]: '/catalog', [TRANSFER_SIZE_ATTRIBUTE]: 250 },
      }),
    ]);

    expect(valueOf(values, 'transferred_bytes')).toBe(750);
  });

  it('measures blocking time as each long task beyond the threshold', () => {
    const durations = [120, 60, 40];
    const expected = durations.reduce(
      (total, duration) => total + Math.max(0, duration - LONG_TASK_BLOCKING_THRESHOLD_MS),
      0,
    );
    const values = computeMetrics(durations.map((duration) => makeLongTaskEvent(duration)));

    expect(expected).toBe(80);
    expect(valueOf(values, 'blocking_time')).toBe(expected);
    expect(valueOf(values, 'long_task_count')).toBe(durations.length);
  });

  it("prefers the producer's own blocking-time figure where it reported one", () => {
    const values = computeMetrics([makeLongTaskEvent(120, 90)]);

    expect(valueOf(values, 'blocking_time')).toBe(90);
  });

  it('counts long tasks only, not every performance entry', () => {
    const values = computeMetrics([
      makeLongTaskEvent(70),
      makeLongTaskEvent(80),
      makeEvent({ kind: PERF_ENTRY_KIND }),
    ]);

    expect(valueOf(values, 'long_task_count')).toBe(2);
  });

  it('counts a failure once, however many ways it qualifies', () => {
    const values = computeMetrics([
      // A failure by kind.
      makeEvent({ kind: ERROR_KIND, tier: BROWSER_TIER }),
      // A failure by status on a kind that is not a failure kind.
      makeRequestEvent({ status: ERROR_STATUS }),
      // Both at once: still one failure.
      makeEvent({ kind: ERROR_KIND, tier: BROWSER_TIER, status: ERROR_STATUS }),
      makeEvent(),
    ]);

    expect(valueOf(values, 'error_count')).toBe(3);
  });

  it('answers an empty capture with fourteen honest values', () => {
    const values = computeMetrics([]);

    expect(values).toHaveLength(METRIC_IDS.length);
    expect(values.map((value) => value.id)).toEqual([...METRIC_IDS]);
    for (const value of values) {
      if (value.id === 'transferred_bytes') {
        expect(value.available).toBe(false);
        expect('value' in value).toBe(false);
        continue;
      }
      expect(value.available).toBe(true);
      expect(value.value).toBe(0);
    }
  });

  it('produces the same values from precomputed aggregates as from the events', () => {
    const sharedKey = 'precomputed-request-key';
    const events = [
      makeRenderEvent('Alpha', UNCHANGED_TRIGGER),
      makeRenderEvent('Alpha', UNKNOWN_TRIGGER),
      makeRequestEvent({ requestKey: sharedKey, startTime: BASE_TIME }),
      makeRequestEvent({ requestKey: sharedKey, startTime: BASE_TIME + 5 }),
    ];

    const fromEvents = computeMetrics(events);
    const fromAggregates = computeMetrics(events, {
      precomputed: { requests: aggregateRequests(events) },
    });

    expect(fromAggregates).toEqual(fromEvents);
  });

  it('accepts precomputed renders and query groups without changing a number', () => {
    const events = [
      makeRenderEvent('Alpha', UNCHANGED_TRIGGER),
      makeRenderEvent('Beta', UNKNOWN_TRIGGER),
      makeEvent({
        kind: DB_QUERY_KIND,
        tier: DATABASE_TIER,
        duration: 12,
        attributes: { 'db.statement': 'select col_a from t1 where id = $1' },
      }),
    ];

    const fromAggregates = computeMetrics(events, {
      precomputed: {
        // Aggregated *with* occurrence lists here, which the counts must not
        // depend on: a bound cuts samples, never arithmetic.
        renders: aggregateRenders(events),
        queries: aggregateQueries(events),
      },
    });

    expect(fromAggregates).toEqual(computeMetrics(events));
    expect(valueOf(fromAggregates, 'render_count')).toBe(2);
    expect(valueOf(fromAggregates, 'unchanged_render_count')).toBe(1);
    expect(valueOf(fromAggregates, 'render_trigger_unknown_count')).toBe(1);
    expect(valueOf(fromAggregates, 'query_count')).toBe(1);
  });

  it('does not mutate the events it is given', () => {
    const events = [
      makeRenderEvent('Alpha', PROPS_TRIGGER),
      makeRequestEvent({ transferSize: 42 }),
      makeLongTaskEvent(90),
    ];
    const before = clone(events);

    computeMetrics(events);

    expect(clone(events)).toEqual(before);
  });
});

/*
 * ---------------------------------------------------------------------------
 * computeCaptureSummary
 * ---------------------------------------------------------------------------
 */

describe('computeCaptureSummary', () => {
  it('takes its identity from the caller and its window from the events', () => {
    const summary = computeCaptureSummary(
      [
        makeEvent({ startTime: BASE_TIME, duration: 10 }),
        makeEvent({ startTime: BASE_TIME + 40, duration: 10 }),
      ],
      makeContext(),
    );

    expect(summary.captureId).toBe(CAPTURE_ID);
    expect(summary.sessionId).toBe(SESSION_ID);
    expect(summary.startTime).toBe(BASE_TIME);
    expect(summary.endTime).toBe(BASE_TIME + 50);
    expect(summary.durationMs).toBe(50);
    expect(summary.eventCount).toBe(2);
  });

  it('omits the session id when the caller named none', () => {
    const summary = computeCaptureSummary([makeEvent()], { captureId: CAPTURE_ID });

    expect('sessionId' in summary).toBe(false);
  });

  it('lists the distinct traces and producers deterministically', () => {
    const first = nextTraceId();
    const second = nextTraceId();
    const summary = computeCaptureSummary(
      [
        makeEvent({ traceId: second, producerId: SECOND_PRODUCER_ID }),
        makeEvent({ traceId: first }),
        makeEvent({ traceId: first, producerId: SECOND_PRODUCER_ID }),
      ],
      makeContext(),
    );

    expect(summary.traceCount).toBe(2);
    expect([...summary.traceIds]).toEqual([first, second].sort());
    expect([...summary.producerIds]).toEqual([PRODUCER_ID, SECOND_PRODUCER_ID].sort());
  });

  it('zero-fills the tier and kind tallies over their whole vocabularies', () => {
    const summary = computeCaptureSummary(
      [makeRenderEvent('Alpha', PROPS_TRIGGER), makeRequestEvent()],
      makeContext(),
    );

    expect(Object.keys(summary.tierCounts).sort()).toEqual([...TELEMETRY_TIERS].sort());
    expect(Object.keys(summary.kindCounts).sort()).toEqual([...TELEMETRY_KINDS].sort());
    expect(summary.tierCounts[BROWSER_TIER]).toBe(2);
    expect(summary.tierCounts[SERVER_TIER]).toBe(0);
    expect(summary.kindCounts[RENDER_KIND]).toBe(1);
    expect(summary.kindCounts[FETCH_KIND]).toBe(1);
    expect(summary.kindCounts[DB_QUERY_KIND]).toBe(0);
  });

  it('carries all fourteen metrics and names the unavailable ones', () => {
    const summary = computeCaptureSummary([makeRequestEvent()], makeContext());

    expect(summary.metrics.map((value) => value.id)).toEqual([...METRIC_IDS]);
    expect([...summary.unavailableMetrics]).toEqual(['transferred_bytes']);
    for (const id of summary.unavailableMetrics) {
      expect(metric(summary.metrics, id).available).toBe(false);
    }
  });

  it('anchors on the longest trace', () => {
    const short = nextTraceId();
    const long = nextTraceId();
    const summary = computeCaptureSummary(
      [
        makeEvent({ traceId: short, startTime: BASE_TIME, duration: 20 }),
        makeEvent({ traceId: long, startTime: BASE_TIME + 100, duration: 200 }),
      ],
      makeContext(),
    );

    expect(summary.primaryTraceId).toBe(long);
  });

  it('breaks a tie on total duration by the earlier start', () => {
    const later = nextTraceId();
    const earlier = nextTraceId();
    const summary = computeCaptureSummary(
      [
        makeEvent({ traceId: later, startTime: BASE_TIME + 50, duration: 30 }),
        makeEvent({ traceId: earlier, startTime: BASE_TIME, duration: 30 }),
      ],
      makeContext(),
    );

    expect(summary.primaryTraceId).toBe(earlier);
  });

  it('breaks a tie on duration and start by the lower id', () => {
    const traceIds = [nextTraceId(), nextTraceId()].sort();
    const [lower] = traceIds;
    const summary = computeCaptureSummary(
      traceIds.map((traceId) => makeEvent({ traceId, startTime: BASE_TIME, duration: 30 })),
      makeContext(),
    );

    expect(summary.primaryTraceId).toBe(lower);
  });

  it('ranks the top spans by duration and reports their self time', () => {
    const traceId = nextTraceId();
    const parentSpanId = nextSpanId();
    const events = [
      makeEvent({
        traceId,
        spanId: parentSpanId,
        kind: HTTP_SERVER_KIND,
        startTime: BASE_TIME,
        duration: 100,
      }),
      makeEvent({
        traceId,
        parentSpanId,
        kind: DB_QUERY_KIND,
        tier: DATABASE_TIER,
        startTime: BASE_TIME + 10,
        duration: 40,
      }),
      makeEvent({ traceId, kind: PERF_ENTRY_KIND, startTime: BASE_TIME, duration: 1 }),
    ];

    const summary = computeCaptureSummary(events, makeContext());
    const [slowest, second] = summary.topSpans;

    expect(summary.topSpans).toHaveLength(3);
    expect(slowest?.durationMs).toBe(100);
    // 100 ms inclusive, 40 ms of which its child covered.
    expect(slowest?.selfTimeMs).toBe(60);
    expect(second?.durationMs).toBe(40);
    expect(second?.selfTimeMs).toBe(40);
  });

  it('orders equally slow spans by id, so the ranking is reproducible', () => {
    const events = [
      makeEvent({ id: 'evt_00000000000000ff', duration: 10 }),
      makeEvent({ id: 'evt_00000000000000aa', duration: 10 }),
    ];

    const summary = computeCaptureSummary(events, makeContext());

    expect(summary.topSpans.map((span) => span.id)).toEqual([
      'evt_00000000000000aa',
      'evt_00000000000000ff',
    ]);
  });

  it('orders the sections the way their aggregates do', () => {
    const duplicateKey = 'section-duplicate-key';
    const events = [
      makeRenderEvent('Busy', PROPS_TRIGGER),
      makeRenderEvent('Busy', PROPS_TRIGGER),
      makeRenderEvent('Quiet', PROPS_TRIGGER),
      makeRequestEvent({ requestKey: duplicateKey, startTime: BASE_TIME }),
      makeRequestEvent({ requestKey: duplicateKey, startTime: BASE_TIME + 5 }),
      makeRequestEvent({ requestKey: 'section-lonely-key', startTime: BASE_TIME + 10 }),
      makeEvent({
        kind: DB_QUERY_KIND,
        tier: DATABASE_TIER,
        duration: 5,
        attributes: { 'db.statement': 'select col_a from t1 where id = $1' },
      }),
      makeEvent({
        kind: DB_QUERY_KIND,
        tier: DATABASE_TIER,
        duration: 90,
        attributes: { 'db.statement': 'select col_b from t2 where id = $1' },
      }),
    ];

    const summary = computeCaptureSummary(events, makeContext());

    expect(summary.topRenders.map((stat) => stat.component)).toEqual(['Busy', 'Quiet']);
    expect(summary.topRenders[0]?.renderCount).toBe(2);
    expect(summary.topRequests[0]?.hasDuplicates).toBe(true);
    expect(summary.topQueries.map((group) => group.totalDurationMs)).toEqual([90, 5]);
  });

  it('lists the failures in time order', () => {
    const late = makeEvent({ kind: ERROR_KIND, startTime: BASE_TIME + 30 });
    const early = makeEvent({ kind: ERROR_KIND, startTime: BASE_TIME });
    const middle = makeRequestEvent({ status: ERROR_STATUS, startTime: BASE_TIME + 10 });

    const summary = computeCaptureSummary([late, early, middle], makeContext());

    expect(summary.errors.map((error) => error.id)).toEqual([early.id, middle.id, late.id]);
    expect(summary.errors.map((error) => error.startTime)).toEqual([
      BASE_TIME,
      BASE_TIME + 10,
      BASE_TIME + 30,
    ]);
  });

  it('publishes no stack or message beyond the redacted span name for a failure', () => {
    const failure = makeEvent({
      kind: ERROR_KIND,
      name: 'TypeError',
      attributes: { 'error.stack': 'at somewhere (file.ts:1:1)' },
    });

    const summary = computeCaptureSummary([failure], makeContext());
    const [published] = summary.errors;

    expect(published?.name).toBe('TypeError');
    expect(JSON.stringify(summary)).not.toContain('error.stack');
  });

  it('bounds each section by topN and says so', () => {
    const events = [
      makeEvent({ duration: 30 }),
      makeEvent({ duration: 20 }),
      makeEvent({ duration: 10 }),
    ];

    const bounded = computeCaptureSummary(events, makeContext(), { topN: 1 });
    const whole = computeCaptureSummary(events, makeContext());

    expect(bounded.topSpans).toHaveLength(1);
    expect(bounded.topSpans[0]?.durationMs).toBe(30);
    expect(bounded.truncated).toBe(true);
    expect(bounded.eventCount).toBe(3);
    expect(whole.topSpans).toHaveLength(3);
    expect(whole.truncated).toBe(false);
  });

  it('clips the trace list and reports the true trace count', () => {
    const events = Array.from({ length: DEFAULT_MAX_TRACE_IDS + 1 }, () =>
      makeEvent({ traceId: nextTraceId() }),
    );

    const summary = computeCaptureSummary(events, makeContext(), { topN: events.length });

    expect(summary.traceCount).toBe(DEFAULT_MAX_TRACE_IDS + 1);
    expect(summary.traceIds).toHaveLength(DEFAULT_MAX_TRACE_IDS);
    expect(summary.truncated).toBe(true);
  });

  it('embeds the component tree only when asked', () => {
    const events = [makeRenderEvent('Alpha', PROPS_TRIGGER)];

    expect('componentTree' in computeCaptureSummary(events, makeContext())).toBe(false);

    const withTree = computeCaptureSummary(events, makeContext(), { includeComponentTree: true });
    expect(withTree.componentTree?.nodeCount).toBeGreaterThan(0);
  });

  it('answers an empty capture without throwing and without looking successful', () => {
    const summary = computeCaptureSummary([], { captureId: CAPTURE_ID });

    expect(summary.eventCount).toBe(0);
    expect(summary.startTime).toBe(0);
    expect(summary.endTime).toBe(0);
    expect(summary.durationMs).toBe(0);
    expect(summary.traceCount).toBe(0);
    expect(summary.traceIds).toEqual([]);
    expect('primaryTraceId' in summary).toBe(false);
    expect(summary.producerIds).toEqual([]);
    expect(summary.topSpans).toEqual([]);
    expect(summary.topRenders).toEqual([]);
    expect(summary.topRequests).toEqual([]);
    expect(summary.topQueries).toEqual([]);
    expect(summary.errors).toEqual([]);
    expect('componentTree' in summary).toBe(false);
    expect(summary.truncated).toBe(false);
    expect(summary.metrics).toHaveLength(METRIC_IDS.length);
    expect([...summary.unavailableMetrics]).toEqual(['transferred_bytes']);
    expect(valueOf(summary.metrics, 'total_duration')).toBe(0);
  });

  it('agrees with computeMetrics about the same capture', () => {
    const events = [
      makeEvent({ kind: INTERACTION_KIND, startTime: BASE_TIME, duration: 100 }),
      makeRenderEvent('Alpha', UNCHANGED_TRIGGER),
      makeRequestEvent({ transferSize: 64 }),
      makeLongTaskEvent(140),
    ];

    const summary = computeCaptureSummary(events, makeContext());

    expect(summary.metrics).toEqual(computeMetrics(events));
  });

  it('survives a JSON round trip unchanged', () => {
    const summary: CaptureSummary = computeCaptureSummary(
      [
        makeEvent({ kind: INTERACTION_KIND, duration: 100 }),
        makeRenderEvent('Alpha', PROPS_TRIGGER),
        makeRequestEvent({ transferSize: 10 }),
        makeEvent({ kind: DB_QUERY_KIND, tier: DATABASE_TIER, duration: 7 }),
        makeEvent({ kind: ERROR_KIND }),
      ],
      makeContext(),
      { includeComponentTree: true },
    );

    expect(clone(summary)).toEqual(summary);
  });

  it('does not mutate the events it is given', () => {
    const events = [
      makeEvent({ kind: INTERACTION_KIND, duration: 50 }),
      makeRenderEvent('Alpha', PROPS_TRIGGER),
      makeRequestEvent({ transferSize: 10 }),
    ];
    const before = clone(events);

    computeCaptureSummary(events, makeContext(), { includeComponentTree: true });

    expect(clone(events)).toEqual(before);
  });

  it('falls back to the default bound when topN is unusable', () => {
    const events = Array.from({ length: DEFAULT_TOP_N + 2 }, (_unused, index) =>
      makeEvent({ duration: index + 1 }),
    );

    const summary = computeCaptureSummary(events, makeContext(), { topN: Number.NaN });

    expect(summary.topSpans).toHaveLength(DEFAULT_TOP_N);
    expect(summary.truncated).toBe(true);
  });
});
