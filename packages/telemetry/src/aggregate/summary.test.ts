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
 * 4. **Transportability and reproducibility.** A `CaptureSummary` is the body
 *    of the `capture.stop` response, the payload of the `capture.stopped`
 *    broadcast and an input to the analysis stage (AAP 0.4.2), so it is walked
 *    for anything a JSON payload cannot carry — a `Map`, a `Set`, a class
 *    instance, a cycle, an `undefined` inside an array — and summarised twice
 *    from the same events to prove no clock and no minted identifier leaked
 *    into it. Both are functional requirements of the message contract rather
 *    than hygiene.
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
  COMMIT_ATTRIBUTE_KEYS,
  DB_QUERY_ATTRIBUTE_KEYS,
  ERROR_ATTRIBUTE_KEYS,
  FETCH_ATTRIBUTE_KEYS,
  PERF_ENTRY_ATTRIBUTE_KEYS,
  PERF_LONGTASK_ATTRIBUTE_KEYS,
  RENDER_ATTRIBUTE_KEYS,
  RENDER_TRIGGERS,
  metricUnitFor,
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
// Everything the module publishes is imported *through* the module under
// test, including the four vocabulary symbols it re-exports from
// `../schema/attributes.js` (`METRIC_IDS`, `METRIC_UNITS`, `isMetricId`,
// `MetricId`). The re-export is part of this module's public surface — a
// consumer holding a `CaptureSummary` narrows an untrusted metric id with it
// without a second import — so it is exercised from here rather than from the
// declaring module, which has its own colocated suite.
import {
  DEFAULT_MAX_TRACE_IDS,
  DEFAULT_TOP_N,
  LONG_TASK_BLOCKING_THRESHOLD_MS,
  METRIC_DEFINITIONS,
  METRIC_IDS,
  METRIC_UNITS,
  computeCaptureSummary,
  computeMetrics,
  isMetricId,
  type CaptureSummary,
  type ErrorSummary,
  type MetricId,
  type MetricValue,
  type SpanSummary,
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

/**
 * How many ids the plan fixes.
 *
 * Restated as its own number rather than read from the array above, because
 * the two assertions catch different mistakes: the deep comparison catches a
 * rename or a reordering, and this catches a member added to *both* the
 * implementation and a hand-edited expectation without the cross-package
 * consequence being considered.
 */
const PLANNED_METRIC_COUNT = 14;

/**
 * The shape every metric id has: lower-case words joined by single
 * underscores.
 *
 * A style rule with a functional consequence. The ids are keys in a panel
 * specification's `metricCards.metrics`, written by a model against the
 * schema `packages/panel-schema` builds from this vocabulary, and they appear
 * verbatim in stored specifications. An id in another style would still
 * validate structurally while reading as a different kind of name in every
 * prompt and every panel, so the shape is pinned here and a future addition
 * has to match it.
 */
const METRIC_ID_SHAPE = /^[a-z]+(?:_[a-z]+)*$/;

/** One value `isMetricId` must reject, with the mistake it represents. */
interface MetricIdRejectionCase {
  /** What the value is, for the case name. */
  readonly label: string;
  /** The value handed to the predicate. */
  readonly value: unknown;
}

/**
 * Values that are **not** metric ids, each a near miss of a real one.
 *
 * The predicate's job is to narrow an untrusted value — a metric id read back
 * from a stored panel specification, or arriving from another process — so the
 * cases that matter are the ones a plausible producer really sends: the same
 * words in another style, an absent value, and a value of the wrong type.
 */
const NON_METRIC_IDS: readonly MetricIdRejectionCase[] = [
  { label: 'a hyphenated spelling of a member', value: 'total-duration' },
  { label: 'a camel-case spelling of a member', value: 'totalDuration' },
  { label: 'an upper-case spelling of a member', value: 'TOTAL_DURATION' },
  { label: 'a member with surrounding whitespace', value: ' total_duration ' },
  { label: 'the empty string', value: '' },
  { label: 'a number', value: 42 },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: 'an object that names a member inside itself', value: { id: 'total_duration' } },
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

/**
 * The commit kind: the structural parent of the renders one commit performed.
 *
 * A fixture needs it because `render_count` must count renders and not
 * commits — counting both would inflate every render total, and the inflation
 * would look like the very symptom a re-render question is asked about.
 */
const COMMIT_KIND: TelemetryKind = 'commit';

/** The browser's request kind. */
const FETCH_KIND: TelemetryKind = 'fetch';

/** The framework's incoming-request kind. */
const HTTP_SERVER_KIND: TelemetryKind = 'http.server';

/** The framework's route-handler kind, the child of a request span. */
const ROUTE_HANDLER_KIND: TelemetryKind = 'route.handler';

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

/** Commit attribute keys, from the commit catalog. */
const PHASE_ATTRIBUTE: (typeof COMMIT_ATTRIBUTE_KEYS)[number] = 'phase';
const COMMIT_RENDER_COUNT_ATTRIBUTE: (typeof COMMIT_ATTRIBUTE_KEYS)[number] = 'renderCount';
const ROOT_NAME_ATTRIBUTE: (typeof COMMIT_ATTRIBUTE_KEYS)[number] = 'rootName';

/** The database catalog's statement key, which only ever holds parameterized text. */
const STATEMENT_ATTRIBUTE: (typeof DB_QUERY_ATTRIBUTE_KEYS)[number] = 'db.statement';

/** The error catalog's stack key, which a summary must never republish. */
const ERROR_STACK_ATTRIBUTE: (typeof ERROR_ATTRIBUTE_KEYS)[number] = 'error.stack';

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

/** One render whose trigger cannot be read, with the shape it arrived in. */
interface MalformedTriggerCase {
  /** What is wrong with the attribute, for the case name. */
  readonly label: string;
  /** The render event's attribute bag, verbatim. */
  readonly attributes: Record<string, unknown>;
}

/**
 * A render whose trigger cannot be determined, in every shape it arrives in.
 *
 * Each of these must count into `render_trigger_unknown_count` and **never**
 * into `unchanged_render_count`: "we evaluated props, own hook state and every
 * consumed context and none changed" and "we could not evaluate one of them"
 * support different conclusions, so a capture must never report a
 * stable-input re-render it did not observe (AAP 0.2.3). The classification
 * itself belongs to `./renders.ts`; what is asserted here is that the metrics
 * carry it through without folding the two buckets together.
 */
const MALFORMED_TRIGGER_CASES: readonly MalformedTriggerCase[] = [
  {
    label: 'the attribute is missing',
    attributes: { [COMPONENT_ATTRIBUTE]: 'Gamma' },
  },
  {
    label: 'the attribute is present but undefined',
    attributes: { [COMPONENT_ATTRIBUTE]: 'Gamma', [TRIGGER_ATTRIBUTE]: undefined },
  },
  {
    label: 'an empty string',
    attributes: { [COMPONENT_ATTRIBUTE]: 'Gamma', [TRIGGER_ATTRIBUTE]: '' },
  },
  {
    // The upper-cased spelling of a real member: membership is exact, so a
    // case-insensitive comparison creeping in anywhere would fail here.
    label: 'a string outside the vocabulary',
    attributes: {
      [COMPONENT_ATTRIBUTE]: 'Gamma',
      [TRIGGER_ATTRIBUTE]: UNCHANGED_TRIGGER.toUpperCase(),
    },
  },
  {
    label: 'a number',
    attributes: { [COMPONENT_ATTRIBUTE]: 'Gamma', [TRIGGER_ATTRIBUTE]: 3 },
  },
  {
    label: 'null',
    attributes: { [COMPONENT_ATTRIBUTE]: 'Gamma', [TRIGGER_ATTRIBUTE]: null },
  },
  {
    label: 'an object that names a member inside itself',
    attributes: {
      [COMPONENT_ATTRIBUTE]: 'Gamma',
      [TRIGGER_ATTRIBUTE]: { [TRIGGER_ATTRIBUTE]: UNCHANGED_TRIGGER },
    },
  },
  {
    label: 'an array holding a member',
    attributes: { [COMPONENT_ATTRIBUTE]: 'Gamma', [TRIGGER_ATTRIBUTE]: [UNCHANGED_TRIGGER] },
  },
];

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

/**
 * A render whose attribute bag is supplied verbatim.
 *
 * The malformed-trigger table needs to deliver values the typed builder below
 * cannot express — a missing key, `null`, a number — because the bag has
 * crossed a page boundary, a WebSocket and the store before a metric is
 * computed from it, and every one of those values is something a producer bug
 * can really deliver.
 */
function makeRawRenderEvent(attributes: Record<string, unknown>): TelemetryEvent {
  return makeEvent({ kind: RENDER_KIND, duration: 1, attributes });
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

/**
 * Where one span sits on the capture's time axis, and what it is.
 *
 * Offsets rather than absolute timestamps, because every duration assertion in
 * this suite is about how two intervals overlap: `{ at: 10, duration: 50 }`
 * beside `{ at: 20, duration: 20 }` reads as the nesting it describes, while
 * two epoch millisecond literals do not.
 */
interface SpanPlacement {
  /** The span's kind. */
  readonly kind: TelemetryKind;
  /** Offset from {@link BASE_TIME}, in milliseconds. */
  readonly at: number;
  /** Inclusive duration, in milliseconds. */
  readonly duration: number;
  /** The tier, when the kind permits more than one or the case names it. */
  readonly tier?: TelemetryTier;
  /** The trace, when a case correlates several spans. */
  readonly traceId?: string;
  /** The parent span, when a case nests one span inside another. */
  readonly parentSpanId?: string;
  /** Kind-specific attributes. */
  readonly attributes?: Record<string, unknown>;
  /** A fixed id, when a case asserts on ranking order. */
  readonly id?: string;
  /** The reported status. */
  readonly status?: TelemetryStatus;
}

/** One span placed at an explicit offset and duration. */
function makeSpanAt(placement: SpanPlacement): TelemetryEvent {
  return makeEvent({
    kind: placement.kind,
    startTime: BASE_TIME + placement.at,
    duration: placement.duration,
    ...(placement.tier !== undefined ? { tier: placement.tier } : {}),
    ...(placement.traceId !== undefined ? { traceId: placement.traceId } : {}),
    ...(placement.parentSpanId !== undefined ? { parentSpanId: placement.parentSpanId } : {}),
    ...(placement.attributes !== undefined ? { attributes: placement.attributes } : {}),
    ...(placement.id !== undefined ? { id: placement.id } : {}),
    ...(placement.status !== undefined ? { status: placement.status } : {}),
  });
}

/**
 * A server-tier request-handling span: the framework's answer to one request.
 *
 * Carries no attributes, deliberately. Every assertion built on it is about
 * the interval it occupies, and an attribute the arithmetic does not read
 * would only suggest the number depends on it.
 */
function makeServerSpan(at: number, duration: number, traceId?: string): TelemetryEvent {
  return makeSpanAt({
    kind: HTTP_SERVER_KIND,
    at,
    duration,
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

/** A route-handler span: the child of a request span, on the same tier. */
function makeRouteHandlerSpan(
  at: number,
  duration: number,
  overrides: { readonly traceId?: string; readonly parentSpanId?: string } = {},
): TelemetryEvent {
  return makeSpanAt({
    kind: ROUTE_HANDLER_KIND,
    at,
    duration,
    ...(overrides.traceId !== undefined ? { traceId: overrides.traceId } : {}),
    ...(overrides.parentSpanId !== undefined ? { parentSpanId: overrides.parentSpanId } : {}),
  });
}

/**
 * A database-tier statement execution.
 *
 * The statement is parameterized text with `$1` placeholders — the only form
 * the store ever holds, since `../redaction/sql.ts` replaces inline literals
 * before an event is persisted (AAP 0.5.2). A fixture that carried a literal
 * would be describing a row the product never produces.
 */
function makeQueryEvent(
  statement: string,
  placement: {
    readonly at?: number;
    readonly duration?: number;
    readonly traceId?: string;
    readonly parentSpanId?: string;
  } = {},
): TelemetryEvent {
  return makeSpanAt({
    kind: DB_QUERY_KIND,
    tier: DATABASE_TIER,
    at: placement.at ?? 0,
    duration: placement.duration ?? 1,
    attributes: { [STATEMENT_ATTRIBUTE]: statement },
    ...(placement.traceId !== undefined ? { traceId: placement.traceId } : {}),
    ...(placement.parentSpanId !== undefined ? { parentSpanId: placement.parentSpanId } : {}),
  });
}

/** One React commit: structural, and never counted as a render. */
function makeCommitEvent(rootName: string, renderCount: number, at = 0): TelemetryEvent {
  return makeSpanAt({
    kind: COMMIT_KIND,
    at,
    duration: 4,
    attributes: {
      [PHASE_ATTRIBUTE]: 'update',
      [COMMIT_RENDER_COUNT_ATTRIBUTE]: renderCount,
      [ROOT_NAME_ATTRIBUTE]: rootName,
    },
  });
}

/** A failure by kind: a page error, optionally carrying a scrubbed stack. */
function makeErrorEvent(
  name: string,
  overrides: { readonly at?: number; readonly stack?: string } = {},
): TelemetryEvent {
  return makeEvent({
    kind: ERROR_KIND,
    name,
    startTime: BASE_TIME + (overrides.at ?? 0),
    ...(overrides.stack !== undefined
      ? { attributes: { [ERROR_STACK_ATTRIBUTE]: overrides.stack } }
      : {}),
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

/** One place a published object holds something a JSON payload cannot carry. */
interface TransportViolation {
  /** Where it sits, as a dotted path from the root. */
  readonly path: string;
  /** What was found there. */
  readonly reason: string;
}

/** Whether a value can be enumerated by key. */
function isKeyedObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Every place `value` holds something a `capture.stopped` payload cannot
 * carry.
 *
 * A `CaptureSummary` is broadcast over a WebSocket and stored, so `JSON.parse(
 * JSON.stringify(summary))` has to be the same object. The round-trip
 * comparison below catches most of that, but not all of it: a `Map` and a
 * `Set` both serialise to `{}` and compare equal to another empty object, and
 * an `undefined` element inside an array serialises to `null` in a position a
 * reader will index. Each of those is a silent change of meaning on the wire,
 * so the structure is walked rather than only round-tripped.
 *
 * @param value The value to inspect.
 * @param path Dotted path of `value` from the root, for the failure message.
 * @param seen Objects already on the current path, so a cycle is reported
 * rather than followed.
 */
function collectTransportViolations(
  value: unknown,
  path: string,
  seen: readonly object[],
): TransportViolation[] {
  const violations: TransportViolation[] = [];

  if (value === null) {
    return violations;
  }

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') {
    return violations;
  }
  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      violations.push({ path, reason: 'a non-finite number' });
    }
    return violations;
  }
  if (valueType !== 'object') {
    // `undefined`, a function, a symbol or a bigint: each either disappears
    // or throws at the transport boundary.
    violations.push({ path, reason: valueType });
    return violations;
  }
  if (!isKeyedObject(value)) {
    violations.push({ path, reason: 'a value that cannot be enumerated' });
    return violations;
  }
  if (seen.includes(value)) {
    violations.push({ path, reason: 'a cycle' });
    return violations;
  }
  if (value instanceof Map) {
    violations.push({ path, reason: 'a Map' });
    return violations;
  }
  if (value instanceof Set) {
    violations.push({ path, reason: 'a Set' });
    return violations;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    violations.push({ path, reason: 'a class instance' });
    return violations;
  }

  const nextSeen = [...seen, value];
  for (const key of Object.keys(value)) {
    violations.push(...collectTransportViolations(value[key], `${path}.${key}`, nextSeen));
  }
  return violations;
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
    // The list is CLOSED (AAP 0.2.3). `packages/panel-schema` validates a
    // `metricCards` node's `metrics` against it, the renderer draws one card
    // per id and the deterministic prose layer names the counting ones in a
    // sentence — so adding, renaming or reordering an id here is changing a
    // cross-package contract, not editing a local constant. If this assertion
    // fails, the fix is either to restore the id or to carry the change
    // through the panel schema, the renderer and the prose layer together.
    expect([...METRIC_IDS]).toEqual(PLANNED_METRIC_IDS);
  });

  it('publishes exactly fourteen of them', () => {
    expect(METRIC_IDS).toHaveLength(PLANNED_METRIC_COUNT);
    expect(PLANNED_METRIC_IDS).toHaveLength(PLANNED_METRIC_COUNT);
  });

  it('holds no duplicate id', () => {
    expect(new Set(METRIC_IDS).size).toBe(METRIC_IDS.length);
  });

  it('spells every id in lower snake case', () => {
    for (const id of METRIC_IDS) {
      expect(id).toMatch(METRIC_ID_SHAPE);
    }
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
    // Exhaustive over the unit vocabulary, so a unit added to `METRIC_UNITS`
    // without a formatting class fails here rather than rendering a number in
    // the wrong shape.
    expect(Object.keys(kindByUnit).sort()).toEqual([...METRIC_UNITS].sort());
    for (const id of METRIC_IDS) {
      const definition = METRIC_DEFINITIONS[id];
      expect(METRIC_UNITS).toContain(definition.unit);
      expect(definition.unit).toBe(metricUnitFor(id));
      expect(definition.kind).toBe(kindByUnit[definition.unit]);
    }
  });

  it('accepts every member of the vocabulary as a metric id', () => {
    for (const id of METRIC_IDS) {
      expect(isMetricId(id)).toBe(true);
    }
  });

  it.each(NON_METRIC_IDS)('rejects $label', ({ value }: MetricIdRejectionCase) => {
    expect(isMetricId(value)).toBe(false);
  });

  it('narrows an untrusted value to a usable metric id', () => {
    // What the predicate exists for: a metrics list arriving from another
    // process, narrowed before a definition is looked up. The lookup below
    // type-checks only because the guard narrowed `candidate`.
    const candidate: unknown = PLANNED_METRIC_IDS[0];
    expect(isMetricId(candidate)).toBe(true);
    if (isMetricId(candidate)) {
      const narrowed: MetricId = candidate;
      expect(METRIC_DEFINITIONS[narrowed].id).toBe(narrowed);
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

  it('takes the latest END, not the latest start, as the end of the window', () => {
    const values = computeMetrics([
      // The long one starts first and ends last: [0, 100].
      makeSpanAt({ kind: INTERACTION_KIND, at: 0, duration: 100 }),
      // The last span to START ends well before it: [50, 55]. A window
      // computed from the latest start plus its own duration would read 55.
      makeSpanAt({ kind: RENDER_KIND, at: 50, duration: 5 }),
    ]);

    expect(valueOf(values, 'total_duration')).toBe(100);
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

  it('sums the server tier when its spans do not overlap', () => {
    const traceId = nextTraceId();
    const values = computeMetrics([
      // [0, 20] and [30, 40]: disjoint, so the union *is* the sum. The
      // companion of the overlap case above — a union implementation that
      // silently returned the sum would pass only one of the two.
      makeServerSpan(0, 20, traceId),
      makeRouteHandlerSpan(30, 10, { traceId }),
    ]);

    expect(valueOf(values, 'backend_duration')).toBe(30);
    expect(valueOf(values, 'total_duration')).toBe(40);
  });

  it('attributes a browser interaction wholly to the front end when no server span exists', () => {
    const values = computeMetrics([
      makeEvent({ kind: INTERACTION_KIND, startTime: BASE_TIME, duration: 40 }),
    ]);

    expect(valueOf(values, 'frontend_duration')).toBe(40);
    expect(valueOf(values, 'backend_duration')).toBe(0);
    expect(valueOf(values, 'database_duration')).toBe(0);
  });

  it('reports no front-end time, never a negative one, when the server covered it all', () => {
    const traceId = nextTraceId();
    const values = computeMetrics([
      // The server span [0, 100] covers the browser request [10, 60]
      // entirely: every millisecond the page spent was spent waiting, so the
      // front end accounts for none of it. Subtracting durations rather than
      // intervals would yield -50 here.
      makeServerSpan(0, 100, traceId),
      makeRequestEvent({ traceId, startTime: BASE_TIME + 10, duration: 50 }),
    ]);

    expect(valueOf(values, 'frontend_duration')).toBe(0);
    expect(valueOf(values, 'backend_duration')).toBe(100);
    expect(
      valueOf(values, 'frontend_duration') + valueOf(values, 'backend_duration'),
    ).toBeLessThanOrEqual(valueOf(values, 'total_duration'));
  });

  it('nests database time inside server time', () => {
    const traceId = nextTraceId();
    const server = makeServerSpan(0, 80, traceId);
    const values = computeMetrics([
      server,
      makeRouteHandlerSpan(2, 70, { traceId, parentSpanId: server.spanId }),
      makeQueryEvent('select col_a from t1 where id = $1', {
        at: 10,
        duration: 30,
        traceId,
      }),
      makeQueryEvent('select col_b from t2 where id = $1', {
        at: 30,
        duration: 30,
        traceId,
      }),
    ]);

    // [10, 40] ∪ [30, 60] = 50 ms of wall clock, not the 60 ms the two
    // durations add up to, and never more than the server's own union.
    expect(valueOf(values, 'database_duration')).toBe(50);
    expect(valueOf(values, 'backend_duration')).toBe(80);
    expect(valueOf(values, 'database_duration')).toBeLessThanOrEqual(
      valueOf(values, 'backend_duration'),
    );
  });

  it('rounds every duration to three decimals and never publishes a negative one', () => {
    const traceId = nextTraceId();
    const values = computeMetrics([
      // Sub-millisecond precision is the event contract's, so the arithmetic
      // keeps it and the published number is rounded — not truncated to a
      // whole millisecond, which would erase the difference between a 0.4 ms
      // render and a 40 ms one at the fourth decimal.
      makeSpanAt({ kind: INTERACTION_KIND, at: 0, duration: 12.34567, traceId }),
      makeServerSpan(1, 4.000_49, traceId),
      makeQueryEvent('select col_a from t1 where id = $1', {
        at: 2,
        duration: 2.346_49,
        traceId,
      }),
      // The longest span in the fixture, so it is also what the capture window
      // ends on.
      makeLongTaskEvent(LONG_TASK_BLOCKING_THRESHOLD_MS + 3.141_59),
    ]);

    expect(valueOf(values, 'total_duration')).toBe(53.142);
    expect(valueOf(values, 'backend_duration')).toBe(4);
    expect(valueOf(values, 'database_duration')).toBe(2.346);
    expect(valueOf(values, 'blocking_time')).toBe(3.142);

    for (const published of values) {
      if (published.unit !== 'milliseconds') {
        continue;
      }
      const measured = valueOf(values, published.id);
      expect(measured).toBeGreaterThanOrEqual(0);
      // Three decimals: the value survives a round trip through its own
      // rounding, which a longer fraction would not.
      expect(Math.round(measured * 1000) / 1000).toBe(measured);
    }
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

  it.each(MALFORMED_TRIGGER_CASES)(
    'counts a render as unknown, never as unchanged, when the trigger is $label',
    ({ attributes }: MalformedTriggerCase) => {
      const values = computeMetrics([
        // One render nobody could classify, beside one that really was
        // evaluated and found unchanged: the two totals must stay apart.
        makeRawRenderEvent(attributes),
        makeRenderEvent('Delta', UNCHANGED_TRIGGER),
      ]);

      expect(valueOf(values, 'render_count')).toBe(2);
      expect(valueOf(values, 'render_trigger_unknown_count')).toBe(1);
      expect(valueOf(values, 'unchanged_render_count')).toBe(1);
    },
  );

  it('counts renders and not the commits that performed them', () => {
    const events = [
      makeCommitEvent('AppRoot', 2, 0),
      makeRenderEvent('Alpha', PROPS_TRIGGER),
      makeRenderEvent('Beta', UNCHANGED_TRIGGER),
      makeCommitEvent('AppRoot', 1, 20),
      makeRenderEvent('Alpha', UNKNOWN_TRIGGER),
    ];

    const values = computeMetrics(events);
    const stats = aggregateRenders(events, { includeOccurrences: false });

    // A commit is the structural parent of the renders it performed, so
    // counting it would inflate the very number a re-render question is asked
    // about. The identity `render_count` = the sum of the render aggregate's
    // counts is what `./summary.ts` delegates for, and it is asserted here
    // rather than assumed.
    expect(valueOf(values, 'render_count')).toBe(3);
    expect(valueOf(values, 'render_count')).toBe(
      stats.reduce((total, stat) => total + stat.renderCount, 0),
    );
    expect(stats.map((stat) => stat.component)).toEqual(['Alpha', 'Beta']);
    expect(valueOf(values, 'unchanged_render_count')).toBe(1);
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

  it('counts two occurrences of one request, not the single group they form', () => {
    const sharedKey = 'occurrence-request-key';
    const events = [
      makeRequestEvent({ requestKey: sharedKey, startTime: BASE_TIME }),
      makeRequestEvent({ requestKey: sharedKey, startTime: BASE_TIME + 4 }),
    ];

    // One group, two occurrences. `request_count` answers "how many requests
    // did the page issue", which is the occurrence count; the group count is
    // what the request table's row count would be, and reporting it here
    // would make a duplicate burst look like a single request.
    expect(aggregateRequests(events)).toHaveLength(1);
    expect(valueOf(computeMetrics(events), 'request_count')).toBe(2);
  });

  it('counts each database statement execution, not each distinct statement', () => {
    const statement = 'select col_a from t1 where id = $1';
    const events = [
      makeQueryEvent(statement, { at: 0, duration: 3 }),
      makeQueryEvent(statement, { at: 5, duration: 3 }),
      makeQueryEvent('select col_b from t2 where id = $1', { at: 10, duration: 3 }),
    ];

    // Two statements, three executions: the query table groups, the metric
    // counts.
    expect(aggregateQueries(events)).toHaveLength(2);
    expect(valueOf(computeMetrics(events), 'query_count')).toBe(3);
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
    // capture observed no bytes, turning "we could not measure this" into an
    // observation (AAP 0.6.6, 0.8.4). The card must read `n/a`.
    expect('value' in published).toBe(false);
    expect(published.value).toBeUndefined();
    expect(published.value).not.toBe(0);
    expect(JSON.stringify(published)).not.toContain('"value"');
    expect(published.note).toBeDefined();
    expect(published.note?.length ?? 0).toBeGreaterThan(0);
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

  it('adds nothing for a task at the threshold and only the excess above it', () => {
    // 40 ms is not a long task at all, 60 ms blocks for 10 and 250 ms blocks
    // for 200: Total Blocking Time is the excess past the threshold, summed,
    // and the threshold is read from the module rather than restated as 50.
    const durations = [40, 60, 250];
    const values = computeMetrics(durations.map((duration) => makeLongTaskEvent(duration)));

    expect(valueOf(values, 'blocking_time')).toBe(
      0 + (60 - LONG_TASK_BLOCKING_THRESHOLD_MS) + (250 - LONG_TASK_BLOCKING_THRESHOLD_MS),
    );
    expect(valueOf(values, 'blocking_time')).toBe(210);
    expect(valueOf(values, 'long_task_count')).toBe(durations.length);
  });

  it('reports no blocking time and no long tasks when the capture recorded none', () => {
    const values = computeMetrics([
      makeSpanAt({ kind: INTERACTION_KIND, at: 0, duration: 30 }),
      makeRenderEvent('Alpha', PROPS_TRIGGER),
      makeEvent({ kind: PERF_ENTRY_KIND }),
    ]);

    expect(valueOf(values, 'blocking_time')).toBe(0);
    expect(valueOf(values, 'long_task_count')).toBe(0);
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

  it('reads no clock, so the same events summarise identically twice', () => {
    const events = [
      makeSpanAt({ kind: INTERACTION_KIND, at: 0, duration: 100 }),
      makeRenderEvent('Alpha', UNCHANGED_TRIGGER),
      makeRequestEvent({ startTime: BASE_TIME + 5, duration: 20, transferSize: 64 }),
      makeQueryEvent('select col_a from t1 where id = $1', { at: 10, duration: 30 }),
      makeLongTaskEvent(140),
      makeErrorEvent('RangeError', { at: 60 }),
    ];

    const first = computeCaptureSummary(events, makeContext(), { includeComponentTree: true });
    const second = computeCaptureSummary(events, makeContext(), { includeComponentTree: true });

    // Every field is a function of the events and the caller's context: no
    // identifier is minted and `Date.now()` is never consulted, so two calls
    // are indistinguishable. A summary that embedded "now" would differ here
    // and would make a stored panel un-reproducible.
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.captureId).toBe(CAPTURE_ID);
    expect(first.startTime).toBe(BASE_TIME);
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

    // Every member of both vocabularies carries a real, whole number — a
    // missing key would read as `undefined` in a consumer that indexes the
    // tally by a kind the capture happened not to see, and the vocabularies
    // are iterated rather than sampled so a new kind cannot slip through
    // uncounted. Seventeen kinds is the vocabulary AAP 0.2.3 fixes.
    expect(TELEMETRY_KINDS).toHaveLength(17);
    for (const tier of TELEMETRY_TIERS) {
      const counted = summary.tierCounts[tier];
      expect(typeof counted).toBe('number');
      expect(Number.isInteger(counted)).toBe(true);
      expect(counted).toBeGreaterThanOrEqual(0);
    }
    for (const kind of TELEMETRY_KINDS) {
      const counted = summary.kindCounts[kind];
      expect(typeof counted).toBe('number');
      expect(Number.isInteger(counted)).toBe(true);
      expect(counted).toBeGreaterThanOrEqual(0);
    }
    const tallied = TELEMETRY_KINDS.reduce((total, kind) => total + summary.kindCounts[kind], 0);
    expect(tallied).toBe(summary.eventCount);
    expect(TELEMETRY_TIERS.reduce((total, tier) => total + summary.tierCounts[tier], 0)).toBe(
      summary.eventCount,
    );
  });

  it('carries all fourteen metrics and names the unavailable ones', () => {
    const summary = computeCaptureSummary([makeRequestEvent()], makeContext());

    expect(summary.metrics.map((value) => value.id)).toEqual([...METRIC_IDS]);
    expect([...summary.unavailableMetrics]).toEqual(['transferred_bytes']);
    for (const id of summary.unavailableMetrics) {
      expect(metric(summary.metrics, id).available).toBe(false);
    }
  });

  it('lists exactly the metrics the capture could not measure, and no others', () => {
    const withoutBytes = computeCaptureSummary(
      [makeRequestEvent(), makeRenderEvent('Alpha', PROPS_TRIGGER)],
      makeContext(),
    );
    const withBytes = computeCaptureSummary(
      [makeRequestEvent({ url: '/api/items', transferSize: 2048 })],
      makeContext(),
    );

    // The list is the projection of the values, in vocabulary order, rather
    // than a hand-maintained second opinion about which metric can be
    // missing: a card the renderer shows as `n/a` and an id in this list are
    // the same fact.
    for (const summary of [withoutBytes, withBytes]) {
      expect([...summary.unavailableMetrics]).toEqual(
        summary.metrics.filter((value) => !value.available).map((value) => value.id),
      );
    }
    expect([...withoutBytes.unavailableMetrics]).toEqual(['transferred_bytes']);
    expect([...withBytes.unavailableMetrics]).toEqual([]);
    expect(valueOf(withBytes.metrics, 'transferred_bytes')).toBe(2048);
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
      attributes: { [ERROR_STACK_ATTRIBUTE]: 'at somewhere (file.ts:1:1)' },
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

  it('bounds every section, not only the spans, and orders each as documented', () => {
    const duplicateKey = 'bounded-duplicate-key';
    const events = [
      makeRenderEvent('Busy', PROPS_TRIGGER),
      makeRenderEvent('Busy', PROPS_TRIGGER),
      makeRenderEvent('Quiet', PROPS_TRIGGER),
      makeRequestEvent({ requestKey: duplicateKey, startTime: BASE_TIME }),
      makeRequestEvent({ requestKey: duplicateKey, startTime: BASE_TIME + 5 }),
      makeRequestEvent({ requestKey: 'bounded-lonely-key', startTime: BASE_TIME + 8 }),
      makeQueryEvent('select col_a from t1 where id = $1', { at: 10, duration: 90 }),
      makeQueryEvent('select col_b from t2 where id = $1', { at: 20, duration: 5 }),
      makeErrorEvent('RangeError', { at: 2 }),
      makeErrorEvent('TypeError', { at: 30 }),
    ];

    const bounded = computeCaptureSummary(events, makeContext(), { topN: 1 });

    expect(bounded.topSpans).toHaveLength(1);
    expect(bounded.topRenders).toHaveLength(1);
    expect(bounded.topRequests).toHaveLength(1);
    expect(bounded.topQueries).toHaveLength(1);
    expect(bounded.errors).toHaveLength(1);
    expect(bounded.truncated).toBe(true);

    // Each section keeps the row a reader would have looked for first: the
    // slowest span, the busiest component, the duplicated request, the
    // costliest statement and the earliest failure.
    expect(bounded.topSpans[0]?.durationMs).toBe(90);
    expect(bounded.topRenders[0]?.component).toBe('Busy');
    expect(bounded.topRenders[0]?.renderCount).toBe(2);
    expect(bounded.topRequests[0]?.hasDuplicates).toBe(true);
    expect(bounded.topRequests[0]?.requestKey).toBe(duplicateKey);
    expect(bounded.topQueries[0]?.totalDurationMs).toBe(90);
    expect(bounded.errors[0]?.name).toBe('RangeError');

    // The counts the capture reports are of everything it saw, never of the
    // rows the sections kept.
    expect(bounded.eventCount).toBe(events.length);
    expect(valueOf(bounded.metrics, 'render_count')).toBe(3);
    expect(valueOf(bounded.metrics, 'request_count')).toBe(3);
    expect(valueOf(bounded.metrics, 'query_count')).toBe(2);
    expect(valueOf(bounded.metrics, 'error_count')).toBe(2);
  });

  it('still measures the capture when the caller asks for no rows at all', () => {
    const events = [
      makeSpanAt({ kind: INTERACTION_KIND, at: 0, duration: 40 }),
      makeRenderEvent('Alpha', UNCHANGED_TRIGGER),
      makeRequestEvent({ startTime: BASE_TIME + 5, duration: 10 }),
      makeQueryEvent('select col_a from t1 where id = $1', { at: 8, duration: 6 }),
      makeErrorEvent('TypeError', { at: 20 }),
    ];

    const summary = computeCaptureSummary(events, makeContext(), { topN: 0 });

    // The sections-empty path: a caller that wants the numbers and will fetch
    // rows through `POST /sessions/:id/panel-data` still gets all fourteen
    // metrics, because the metrics are computed from the scan rather than
    // from the published rows.
    expect(summary.topSpans).toEqual([]);
    expect(summary.topRenders).toEqual([]);
    expect(summary.topRequests).toEqual([]);
    expect(summary.topQueries).toEqual([]);
    expect(summary.errors).toEqual([]);
    expect(summary.truncated).toBe(true);
    expect(summary.metrics.map((value) => value.id)).toEqual([...METRIC_IDS]);
    expect(summary.metrics).toHaveLength(PLANNED_METRIC_COUNT);
    expect(valueOf(summary.metrics, 'total_duration')).toBe(40);
    expect(valueOf(summary.metrics, 'render_count')).toBe(1);
    expect(valueOf(summary.metrics, 'query_count')).toBe(1);
    expect(valueOf(summary.metrics, 'error_count')).toBe(1);
  });

  it('projects a span into identity, position and cost, and nothing else', () => {
    const traceId = nextTraceId();
    const server = makeServerSpan(0, 60, traceId);
    const summary = computeCaptureSummary(
      [
        server,
        makeQueryEvent('select col_a from t1 where id = $1', {
          at: 10,
          duration: 20,
          traceId,
          parentSpanId: server.spanId,
        }),
      ],
      makeContext(),
    );
    const [slowest] = summary.topSpans;
    if (slowest === undefined) {
      throw new Error('the summary published no span');
    }
    const projection: SpanSummary = slowest;

    expect(projection.id).toBe(server.id);
    expect(projection.spanId).toBe(server.spanId);
    expect(projection.traceId).toBe(traceId);
    expect(projection.kind).toBe(HTTP_SERVER_KIND);
    expect(projection.tier).toBe(SERVER_TIER);
    expect(projection.name).toBe(server.name);
    expect(projection.startTime).toBe(BASE_TIME);
    expect(projection.durationMs).toBe(60);
    // 60 ms inclusive, 20 ms of which the statement underneath it covered.
    expect(projection.selfTimeMs).toBe(40);
    expect(projection.status).toBe(OK_STATUS);
    // The attribute bag is deliberately not carried: a panel that wants it
    // queries the event by id, and a summary that embedded every bag would
    // not fit the payload it travels in.
    expect('attributes' in projection).toBe(false);
  });

  it('projects a failure into identity and position only', () => {
    const failure = makeErrorEvent('RangeError', { at: 12, stack: 'at handler (redacted:1:1)' });
    const summary = computeCaptureSummary([failure], makeContext());
    const [published] = summary.errors;
    if (published === undefined) {
      throw new Error('the summary published no failure');
    }
    const projection: ErrorSummary = published;

    expect(projection.id).toBe(failure.id);
    expect(projection.spanId).toBe(failure.spanId);
    expect(projection.traceId).toBe(failure.traceId);
    expect(projection.kind).toBe(ERROR_KIND);
    expect(projection.tier).toBe(BROWSER_TIER);
    expect(projection.name).toBe('RangeError');
    expect(projection.startTime).toBe(BASE_TIME + 12);
    // No duration, no status, no attributes: an error summary answers "what
    // failed and when", and a stack can quote source text, so it never
    // travels in a payload that reaches a model stage (AAP 0.5.2).
    expect('duration' in projection).toBe(false);
    expect('durationMs' in projection).toBe(false);
    expect('attributes' in projection).toBe(false);
    expect(JSON.stringify(projection)).not.toContain('redacted:1:1');
  });

  it('clips the trace list and reports the true trace count', () => {
    const events = Array.from({ length: DEFAULT_MAX_TRACE_IDS + 1 }, () =>
      makeEvent({ traceId: nextTraceId() }),
    );

    const summary = computeCaptureSummary(events, makeContext(), { topN: events.length });

    expect(summary.traceCount).toBe(DEFAULT_MAX_TRACE_IDS + 1);
    expect(summary.traceIds).toHaveLength(DEFAULT_MAX_TRACE_IDS);
    expect(summary.truncated).toBe(true);
    // The documented relationship, stated as arithmetic: the count is of the
    // distinct traces the capture holds *before* clipping, and the published
    // list is the first `DEFAULT_MAX_TRACE_IDS` of them. "These are the
    // traces" and "these are fifty of the traces" support different
    // conclusions, so the clip is never silent.
    expect(summary.traceIds).toHaveLength(Math.min(summary.traceCount, DEFAULT_MAX_TRACE_IDS));
    expect(summary.traceCount).toBeGreaterThan(summary.traceIds.length);
  });

  it('publishes each trace once, in ascending order', () => {
    const traceIds = [nextTraceId(), nextTraceId(), nextTraceId()];
    const events = traceIds.flatMap((traceId, index) => [
      makeSpanAt({ kind: INTERACTION_KIND, at: index * 10, duration: 5, traceId }),
      // A second event on the same trace: the list is of traces, not of
      // events, so a repeat must not produce a repeated entry.
      makeSpanAt({ kind: RENDER_KIND, at: index * 10 + 1, duration: 1, traceId }),
    ]);

    const summary = computeCaptureSummary(events, makeContext(), { topN: events.length });
    const published = [...summary.traceIds];

    expect(summary.traceCount).toBe(traceIds.length);
    expect(published).toHaveLength(traceIds.length);
    expect(new Set(published).size).toBe(published.length);
    expect(published).toEqual([...published].sort());
    expect(published).toEqual([...traceIds].sort());
    expect(summary.truncated).toBe(false);
  });

  it('embeds the component tree only when asked', () => {
    const events = [makeRenderEvent('Alpha', PROPS_TRIGGER)];

    expect('componentTree' in computeCaptureSummary(events, makeContext())).toBe(false);

    const withTree = computeCaptureSummary(events, makeContext(), { includeComponentTree: true });
    expect(withTree.componentTree?.nodeCount).toBeGreaterThan(0);
  });

  it('answers an empty capture without throwing and without looking successful', () => {
    // The service takes this path for "No telemetry was captured. Interact
    // with the page while capture is running, then Capture again." (AAP
    // 0.5.5): a capture that recorded nothing must summarise into zeroes,
    // empty sections and an unavailable `transferred_bytes` — never throw, and
    // never read as a successful analysis with nothing in it.
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

  it('holds nothing a WebSocket payload cannot carry', () => {
    const traceId = nextTraceId();
    const server = makeServerSpan(5, 80, traceId);
    const summary: CaptureSummary = computeCaptureSummary(
      [
        makeSpanAt({ kind: INTERACTION_KIND, at: 0, duration: 120, traceId }),
        makeCommitEvent('AppRoot', 2, 1),
        makeRenderEvent('Alpha', PROPS_TRIGGER),
        makeRenderEvent('Alpha', UNCHANGED_TRIGGER),
        makeRawRenderEvent({ [COMPONENT_ATTRIBUTE]: 'Beta' }),
        makeRequestEvent({ traceId, startTime: BASE_TIME + 4, duration: 90, transferSize: 512 }),
        server,
        makeRouteHandlerSpan(6, 70, { traceId, parentSpanId: server.spanId }),
        makeQueryEvent('select col_a from t1 where id = $1', {
          at: 10,
          duration: 40,
          traceId,
        }),
        makeLongTaskEvent(130),
        makeErrorEvent('TypeError', { at: 100, stack: 'at handler (redacted:1:1)' }),
      ],
      makeContext(),
      { includeComponentTree: true },
    );

    // The summary is the `capture.stopped` payload (AAP 0.4.2), so this is a
    // functional requirement rather than hygiene: a `Map`, a `Set`, a class
    // instance, a cycle or an `undefined` inside an array would either throw
    // at the boundary or arrive as something else.
    expect(collectTransportViolations(summary, '$', [])).toEqual([]);
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
