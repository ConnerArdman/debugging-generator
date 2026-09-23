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
 *
 * ## The two fixture sources, and why both are needed
 *
 * Most cases below build their events with the typed builders in this file:
 * an arithmetic rule is pinned by the smallest capture that can distinguish a
 * right answer from a plausible wrong one, and an overlap, a malformed
 * trigger or a threshold boundary has to be *constructed* to be tested.
 *
 * The three suites at the end of the file run on the opposite kind of input:
 * the committed `packages/telemetry/test/fixtures/capture-batch.json`, read
 * from disk at run time, validated element by element against
 * `telemetryEventSchema` and summarised whole. It is a complete thirty-five-event
 * capture spanning all three tiers — the shape the service really rolls up —
 * and it is checked-in repository data rather than captured telemetry: no
 * network, no clock and no minted identifier take part, every timestamp and
 * identifier in it is a literal in the file, so the expected metric vector
 * and every published section are exact numbers rather than tolerances. The
 * schema parse is itself an assertion — the fixture is a persisted-event
 * corpus other suites and the panel-data sources read, so a drift that made
 * it unparseable would otherwise be discovered by whichever consumer happened
 * to run next.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { isTelemetryEvent, telemetryEventSchema, type TelemetryEvent } from '../schema/event.js';
import {
  ERROR_KINDS,
  QUERY_KINDS,
  REQUEST_KINDS,
  TELEMETRY_KINDS,
  TELEMETRY_TIERS,
  allowedTiersFor,
  type TelemetryKind,
  type TelemetryStatus,
  type TelemetryTier,
} from '../schema/kinds.js';
import { aggregateQueries, isDatabaseStatementEvent } from './queries.js';
import { aggregateRenders } from './renders.js';
import {
  RESOURCE_ENTRY_TYPE,
  RESOURCE_TIMING_URL_ATTRIBUTE,
  TRANSFER_SIZE_EXPOSED_ATTRIBUTE,
  aggregateRequests,
  countDuplicateRequests,
} from './requests.js';
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

/** Which `PerformanceEntry` type a `perf.entry` describes: `resource`, `paint`. */
const ENTRY_TYPE_ATTRIBUTE: (typeof PERF_ENTRY_ATTRIBUTE_KEYS)[number] = 'entry.type';

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
    /**
     * The absolute identity the request's resource-timing entry is named by,
     * as `../browser/fetch.ts` emits it — the key `./requests.ts` joins on.
     */
    readonly resourceTimingUrl?: string;
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
  if (overrides.resourceTimingUrl !== undefined) {
    attributes[RESOURCE_TIMING_URL_ATTRIBUTE] = overrides.resourceTimingUrl;
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
 * A resource-timing entry, as `../browser/perf.ts` emits one.
 *
 * `entry.type` is always written because a real producer always writes it, and
 * the exposure verdict is written only when the case states one: its absence
 * is how an event from a producer that predates the contract arrives, and the
 * metric must treat that differently from an explicit `false`. The URL is the
 * entry's own — absolute in a real capture — and is what `./requests.ts` joins
 * a request to.
 */
function makeResourceTimingEvent(overrides: {
  readonly url: string;
  readonly transferSize?: number;
  readonly exposed?: boolean;
  readonly startTime?: number;
}): TelemetryEvent {
  const attributes: Record<string, unknown> = {
    [ENTRY_TYPE_ATTRIBUTE]: RESOURCE_ENTRY_TYPE,
    [URL_ATTRIBUTE]: overrides.url,
  };
  if (overrides.transferSize !== undefined) {
    attributes[TRANSFER_SIZE_ATTRIBUTE] = overrides.transferSize;
  }
  if (overrides.exposed !== undefined) {
    attributes[TRANSFER_SIZE_EXPOSED_ATTRIBUTE] = overrides.exposed;
  }
  return makeEvent({
    kind: PERF_ENTRY_KIND,
    ...(overrides.startTime !== undefined ? { startTime: overrides.startTime } : {}),
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

/**
 * A database-tier span that ran no statement: the tier's own lifecycle work.
 *
 * Both instrumentations span their overhead — a connection acquisition, an
 * argument serialization, a transaction boundary — and `../node/convert.ts`
 * emits every one of them as `db.query` on the database tier, because there is
 * one database kind and the time really was spent there. The absent
 * `db.statement` is what tells it from an execution, so this builder carries
 * the operation the producer derived and no statement.
 */
function makeLifecycleQueryEvent(
  name: string,
  operation: string,
  placement: { readonly at: number; readonly duration: number },
): TelemetryEvent {
  return makeEvent({
    kind: DB_QUERY_KIND,
    tier: DATABASE_TIER,
    name,
    startTime: BASE_TIME + placement.at,
    duration: placement.duration,
    attributes: { 'db.operation': operation },
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

/**
 * The hand-built fixtures, checked against the persisted event schema.
 *
 * Only the builders in this file are checked here. The suite's *other* corpus
 * — the committed `test/fixtures/capture-batch.json`, which the three suites
 * at the end of the file read from disk at run time — is validated where it is
 * loaded: every element goes through `telemetryEventSchema` as the file is
 * parsed, so an unparseable fixture fails the whole file at collection rather
 * than one case in the middle of it. See {@link CAPTURE_BATCH_EVENTS}.
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

  it('counts requests per occurrence and statements per execution', () => {
    const values = computeMetrics([
      makeRequestEvent(),
      makeRequestEvent(),
      // A server-side outgoing request is not a request the page issued.
      makeEvent({ kind: 'http.client', tier: SERVER_TIER }),
      makeQueryEvent('select col_a from t1 where id = $1', { at: 0, duration: 3 }),
      makeQueryEvent('select col_b from t2 where id = $1', { at: 5, duration: 3 }),
      makeQueryEvent('select col_c from t3 where id = $1', { at: 10, duration: 3 }),
    ]);

    expect(valueOf(values, 'request_count')).toBe(2);
    expect(valueOf(values, 'query_count')).toBe(3);
  });

  it('counts no query for database work that ran no statement', () => {
    // A `db.query` event is a database *span*, and the database tier spans its
    // own overhead too: a pooled connection acquisition, the ORM serializing
    // its arguments, a transaction boundary. None of them is a statement a
    // `queryTable` row could describe (AAP 0.6.2), and counting them made this
    // card report almost three times the statements a capture really ran.
    const events = [
      makeLifecycleQueryEvent('pg-pool.connect', 'connect', { at: 0, duration: 12 }),
      makeLifecycleQueryEvent('prisma:client:serialize', 'serialize', { at: 20, duration: 2 }),
      makeLifecycleQueryEvent('prisma:client:operation', 'operation', { at: 30, duration: 30 }),
    ];
    const values = computeMetrics(events);

    expect(aggregateQueries(events)).toEqual([]);
    expect(valueOf(values, 'query_count')).toBe(0);
    // The evidence is not hidden, only classified: the spans are still counted
    // by kind and their three disjoint intervals are still the capture's
    // database time.
    const summary = computeCaptureSummary(events, makeContext());
    expect(summary.kindCounts[DB_QUERY_KIND]).toBe(3);
    expect(valueOf(summary.metrics, 'database_duration')).toBe(44);
  });

  it('counts one execution two instrumentations both observed once', () => {
    // The ORM over the driver: one statement, spanned by the ORM and again by
    // the driver nested inside it with the same text. The card counts the
    // execution, not the observations.
    const orm = makeQueryEvent('select col_a from t1 where id = $1', { at: 0, duration: 24 });
    const driver = makeQueryEvent('select col_a from t1 where id = $1', {
      at: 4,
      duration: 9,
      traceId: orm.traceId,
      parentSpanId: orm.spanId,
    });
    const events = [orm, driver];

    expect(valueOf(computeMetrics(events), 'query_count')).toBe(1);
    // And the card equals the table, which is the identity this metric is now
    // computed to hold by construction.
    expect(valueOf(computeMetrics(events), 'query_count')).toBe(
      aggregateQueries(events).reduce((running, group) => running + group.executionCount, 0),
    );
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

  it('reports no value when every response withheld its byte counts', () => {
    // The case AAP 0.6.6 describes and the one F26 of the review found
    // mis-reported: a cross-origin response served without
    // `Timing-Allow-Origin` reports `transferSize: 0` with nothing measured.
    // Counting those zeros would publish "0 bytes transferred" as an
    // observation of a capture that measured nothing at all.
    const published = metric(
      computeMetrics([
        makeRequestEvent({ url: '/api/one' }),
        makeResourceTimingEvent({ url: '/api/one', transferSize: 0, exposed: false }),
        // A host that fills the field in while still refusing the timing-allow
        // check. The verdict is decisive whatever the number beside it, which
        // is the half of the rule a zero alone cannot demonstrate.
        makeResourceTimingEvent({ url: '/static/vendor.js', transferSize: 900, exposed: false }),
      ]),
      'transferred_bytes',
    );

    expect(published.available).toBe(false);
    expect('value' in published).toBe(false);
    expect(published.value).not.toBe(0);
    expect(published.note).toBeDefined();
  });

  it('reports no value for a bare zero no producer vouched for', () => {
    // No exposure verdict at all: "nothing was transferred" and "nothing was
    // measured" are indistinguishable, so the card reads `n/a` rather than
    // claiming the first.
    const published = metric(
      computeMetrics([makeResourceTimingEvent({ url: '/static/app.css', transferSize: 0 })]),
      'transferred_bytes',
    );

    expect(published.available).toBe(false);
    expect('value' in published).toBe(false);
  });

  it('counts an exposed zero as the measurement it is', () => {
    // A same-origin response served from cache really did transfer nothing.
    // The producer says so, so the metric publishes the number instead of
    // hiding a real reading behind `n/a`.
    const published = metric(
      computeMetrics([
        makeResourceTimingEvent({ url: '/static/app.css', transferSize: 0, exposed: true }),
      ]),
      'transferred_bytes',
    );

    expect(published.available).toBe(true);
    expect(published.value).toBe(0);
  });

  it('counts a joined response once, from the same groups the table shows', () => {
    // The request carries the absolute identity its resource entry is named
    // by, so `./requests.ts` joins the two and the group already accounts for
    // the bytes. The metric adds the group's figure and skips the claimed
    // entry, which is what keeps the card and the `requestTable` stating one
    // fact (AAP 0.6.2).
    const absolute = 'http://app.localhost/api/items';
    const events = [
      makeRequestEvent({ url: '/api/items', resourceTimingUrl: absolute }),
      makeResourceTimingEvent({ url: absolute, transferSize: 2500, exposed: true }),
    ];
    const groups = aggregateRequests(events);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.transferredBytes).toBe(2500);
    expect(valueOf(computeMetrics(events), 'transferred_bytes')).toBe(2500);
  });

  it('adds the resource entries no request claimed, and only those', () => {
    const absolute = 'http://app.localhost/api/items';
    const values = computeMetrics([
      makeRequestEvent({ url: '/api/items', resourceTimingUrl: absolute }),
      // Claimed by the request above.
      makeResourceTimingEvent({ url: absolute, transferSize: 400, exposed: true }),
      // Nobody requested these two through `fetch`.
      makeResourceTimingEvent({ url: '/static/app.js', transferSize: 50, exposed: true }),
      makeEvent({
        kind: NAVIGATION_KIND,
        attributes: { [URL_ATTRIBUTE]: '/catalog', [TRANSFER_SIZE_ATTRIBUTE]: 25 },
      }),
    ]);

    expect(valueOf(values, 'transferred_bytes')).toBe(475);
  });

  it('puts no coverage caveat on a capture whose paint marks reported nothing', () => {
    // A paint mark is an instant with no response, so it is not a candidate
    // that failed to report — counting it as one would caveat a capture whose
    // coverage is complete.
    const published = metric(
      computeMetrics([
        makeResourceTimingEvent({ url: '/static/app.js', transferSize: 900, exposed: true }),
        makeEvent({ kind: PERF_ENTRY_KIND, attributes: { [ENTRY_TYPE_ATTRIBUTE]: 'paint' } }),
      ]),
      'transferred_bytes',
    );

    expect(published.value).toBe(900);
    expect(published.note).toBeUndefined();
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

/*
 * ---------------------------------------------------------------------------
 * The committed capture fixture
 *
 * `packages/telemetry/test/fixtures/capture-batch.json` is the repository's
 * one complete persisted capture: thirty-five events of a single interaction,
 * spanning the browser agent and the server preload, correlated into one
 * trace and already redacted (AAP 0.5.2 — the URLs carry `?` placeholders and
 * every statement is parameterized). It is the shape the service actually
 * rolls up, so it is summarised whole here rather than approximated by
 * builders: a metric computed correctly on a two-event fixture and wrongly on
 * a real capture is exactly the failure the small fixtures above cannot see.
 *
 * Everything the three suites below expect is a literal, because the input
 * is a literal. The file is checked-in data, not captured telemetry: no clock, no
 * network and no minted identifier take part in reading it, so "the metrics
 * for this capture" is a fixed vector of numbers that either matches or
 * reports a real change in the arithmetic.
 * ---------------------------------------------------------------------------
 */

/**
 * The package's committed fixture directory.
 *
 * Resolved by converting this module's URL to a path **first** and doing path
 * arithmetic after, rather than with `new URL('../../test/fixtures/…',
 * import.meta.url)`: the `telemetry` Vitest project runs under happy-dom,
 * whose global `URL` resolves a relative specifier against the document's
 * `http://localhost` origin instead of against the `file:` base it was handed,
 * which makes the tidier one-liner throw `ERR_INVALID_URL_SCHEME` here. The
 * same resolution is used by `../redaction/rules.test.ts` and
 * `../schema/attributes.test.ts`, and it behaves identically whether Vitest is
 * invoked on this one file or on the whole repository, where the process
 * working directory is the repository root.
 *
 * The fixture is deliberately *read* rather than imported: this package's
 * `tsconfig.json` pins `rootDir` to `src` and excludes `test/**`, so a JSON
 * import would not compile, and reading it is what makes the parse below a
 * runtime contract check rather than a compile-time one.
 */
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

/** The complete persisted capture, as committed. */
const CAPTURE_BATCH_PATH = join(FIXTURES_DIR, 'capture-batch.json');

/**
 * The fixture's events, validated element by element.
 *
 * The parse is the assertion: `telemetryEventSchema` is the store's own
 * strict schema, so a fixture that gained a field the build does not know
 * about, lost an attribution field or paired a kind with a tier the catalog
 * forbids fails here — at collection, with the offending index named — rather
 * than as a puzzling number in one case. Every failure path throws with the
 * fixture's path in the message, because the two most likely causes are a
 * moved file and an edited fixture, and they need different fixes.
 *
 * @returns The thirty-five persisted events, in file order.
 */
function loadCaptureBatch(): readonly TelemetryEvent[] {
  let text: string;
  try {
    text = readFileSync(CAPTURE_BATCH_PATH, 'utf8');
  } catch (cause) {
    throw new Error(
      `the committed capture fixture could not be read at ${CAPTURE_BATCH_PATH}. ` +
        'These suites summarise that file; if it has moved, point this loader at its new ' +
        'path rather than deleting the cases.',
      { cause },
    );
  }

  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`${CAPTURE_BATCH_PATH} must hold a JSON array of persisted telemetry events`);
  }

  return parsed.map((entry: unknown, index): TelemetryEvent => {
    const result = telemetryEventSchema.safeParse(entry);
    if (!result.success) {
      throw new Error(
        `${CAPTURE_BATCH_PATH}[${String(index)}] is not a persisted telemetry event: ` +
          result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; '),
      );
    }
    return result.data;
  });
}

/**
 * The fixture, read and validated once for the whole file.
 *
 * Read at module scope because the file cannot change between two cases of
 * one run, and re-reading it would only turn one filesystem dependency into
 * one per case. Each case is handed a fresh structural copy by
 * {@link captureBatchEvents} instead, so a case that mutated its input could
 * not affect the next — and the copy is itself a round trip through JSON,
 * which is what a persisted event has to survive.
 */
const CAPTURE_BATCH_EVENTS: readonly TelemetryEvent[] = loadCaptureBatch();

/** A private copy of the fixture, for one case. */
function captureBatchEvents(): TelemetryEvent[] {
  return clone([...CAPTURE_BATCH_EVENTS]);
}

/** The capture the fixture belongs to, as its own attribution fields state. */
const FIXTURE_CAPTURE_ID = 'cap_b7d1g4j8m2p5r9tw';

/** The session that owns it. */
const FIXTURE_SESSION_ID = 'ses_t3m8q1v5y9c2f6hk';

/** The single trace every event in the fixture belongs to. */
const FIXTURE_TRACE_ID = '7b1e4d92c0a53f86d24b9e017c35af68';

/** The page agent's producer id: the browser-tier events. */
const FIXTURE_BROWSER_PRODUCER_ID = 'prd_n4q8t2w6z0c3f7jm';

/** The dev-server preload's producer id: the server- and database-tier events. */
const FIXTURE_SERVER_PRODUCER_ID = 'prd_v5y9b3e7h1k4n8qs';

/** How many events the fixture holds. */
const FIXTURE_EVENT_COUNT = 35;

/**
 * How many of the fixture's nine database spans are statement executions.
 *
 * The other three ran no statement: an ORM operation wrapper, an argument
 * serialization and a pooled connection acquisition. They are database-tier
 * work and they are in every tally of database spans; they are not rows of a
 * query table (AAP 0.6.2), which is what `isDatabaseStatementEvent` decides.
 */
const FIXTURE_STATEMENT_EVENT_COUNT = 6;

/**
 * How many of those six are an inner observation of an execution another
 * instrumentation had already spanned.
 *
 * One: the fixture's `pg.query` span nested inside a `prisma:client:db_query`
 * span carrying byte-identical text. One execution, two spans, and the
 * outermost of the two is the one counted — so the capture's executions are
 * {@link FIXTURE_STATEMENT_EVENT_COUNT} minus this.
 */
const FIXTURE_DOUBLE_OBSERVED_STATEMENT_COUNT = 1;

/** The identity a summary of the fixture is built with. */
function fixtureContext(): { captureId: string; sessionId: string } {
  return { captureId: FIXTURE_CAPTURE_ID, sessionId: FIXTURE_SESSION_ID };
}

/** The capture window the fixture's events describe, in Unix epoch milliseconds. */
const FIXTURE_WINDOW = {
  /** The interaction's own start: the earliest event in the capture. */
  startTime: 1_789_812_900_000,
  /** The interaction's end: the latest `startTime + duration` in the capture. */
  endTime: 1_789_812_901_290.408,
  /** `endTime - startTime`, which the interaction span covers exactly. */
  durationMs: 1_290.408,
} as const;

/** One metric this capture measures, and the number it measures. */
interface FixtureMetricExpectation {
  /** The metric id. */
  readonly id: MetricId;
  /** The value the fixture yields, to the module's three-decimal rounding. */
  readonly value: number;
}

/**
 * The metric the fixture cannot pin, and the one id excluded from
 * {@link FIXTURE_METRIC_VALUES}.
 *
 * `transferred_bytes` is the coverage-limited metric (AAP 0.6.6): whether a
 * capture can measure it at all depends on what the platform exposed for each
 * response, and that collection semantic is owned by the request pipeline
 * rather than by this rollup. Pinning a number or an availability flag for it
 * here would state a policy this module does not decide. What *is* pinned is
 * the honesty rule that applies whatever the coverage turns out to be — see
 * the self-consistency case below — and its presence in the vector, which is
 * a contract of this module (AAP 0.2.3).
 */
const COVERAGE_LIMITED_METRIC_ID: MetricId = 'transferred_bytes';

/**
 * Every other metric's exact value for this capture.
 *
 * Stated as data rather than recomputed inside the assertions, so a change
 * in the arithmetic reads as a diff of numbers. Each one is what the
 * fixture's own events come to:
 *
 * - `total_duration` — the interaction span covers the whole capture.
 * - `frontend_duration` — the browser tier's interval union **minus** the
 *   server tier's: the page spent most of its time awaiting the server, and
 *   that time belongs to the backend.
 * - `backend_duration` / `database_duration` — the server and database
 *   unions; the two `/api/items` and `/api/summary` server spans overlap the
 *   database work they issued, so both are unions rather than sums.
 * - the render totals — six renders of three components, two of which
 *   reported stable inputs and one of which could not be classified.
 * - `request_count` — per occurrence, through the request kind group: seven
 *   browser fetches.
 * - `query_count` — per **execution**, through the query groups, which is
 *   five and not the nine `db.query` events the capture holds. Three of those
 *   nine ran no statement at all (an ORM operation wrapper, an argument
 *   serialization, a pooled connection acquisition) and one is the driver's
 *   observation of a statement the ORM had already spanned. The three
 *   lifecycle spans are still in `kindCounts['db.query']` and still in
 *   `database_duration`; what they are not is statements that ran.
 * - `duplicate_request_count` — the four `/api/summary` fetches share one
 *   request key inside the duplicate window, so three of them are redundant.
 * - `blocking_time` — the single 180 ms long task reported 130 ms of
 *   blocking time itself, which the producer's own figure supplies.
 */
const FIXTURE_METRIC_VALUES: readonly FixtureMetricExpectation[] = [
  { id: 'total_duration', value: 1_290.408 },
  { id: 'frontend_duration', value: 111.268 },
  { id: 'backend_duration', value: 1_179.14 },
  { id: 'database_duration', value: 817.697 },
  { id: 'render_count', value: 6 },
  { id: 'unchanged_render_count', value: 2 },
  { id: 'render_trigger_unknown_count', value: 1 },
  { id: 'request_count', value: 7 },
  { id: 'query_count', value: 5 },
  { id: 'blocking_time', value: 130 },
  { id: 'duplicate_request_count', value: 3 },
  { id: 'long_task_count', value: 1 },
  { id: 'error_count', value: 1 },
];

/**
 * Events per kind in the fixture; every kind it does not hold is absent and
 * must be published as zero.
 *
 * Stated as a partial record on purpose: the zero-fill is a contract of the
 * module (a consumer indexes `kindCounts` by any member of the vocabulary),
 * so the cases below read every member of `TELEMETRY_KINDS` and fall back to
 * zero here, which makes a kind added to the vocabulary fail as a missing
 * count rather than as a missing table row.
 */
const FIXTURE_KIND_COUNTS: Readonly<Partial<Record<TelemetryKind, number>>> = {
  interaction: 1,
  render: 6,
  commit: 2,
  fetch: 7,
  'perf.longtask': 1,
  error: 1,
  state: 2,
  'http.server': 2,
  'route.handler': 2,
  function: 2,
  'db.query': 9,
};

/**
 * Events per tier in the fixture: a browser-heavy capture with the server and
 * the database tier both present.
 */
const FIXTURE_TIER_COUNTS: Readonly<Record<TelemetryTier, number>> = {
  browser: 20,
  server: 6,
  db: 9,
};

/** One row of the fixture's span ranking. */
interface ExpectedSpan {
  /** The event id, which is also the evidence reference a fact would cite. */
  readonly id: string;
  /** The span's kind. */
  readonly kind: TelemetryKind;
  /** The tier that produced it. */
  readonly tier: TelemetryTier;
  /** The span name, as the producer reported it. */
  readonly name: string;
  /** Inclusive duration, in milliseconds. */
  readonly durationMs: number;
  /**
   * Own time, in milliseconds: the inclusive duration minus the wall-clock
   * time its direct children covered, read from one correlation of the
   * fixture.
   */
  readonly selfTimeMs: number;
}

/**
 * The ten slowest spans of the fixture, in the order the rollup publishes
 * them.
 *
 * This is the "top spans" evidence the analysis stage is prompted with (AAP
 * 0.4.2), and the fixture makes it a real ranking: the interaction, the fetch
 * it issued, the server span that answered it and the route handler and
 * function beneath that one are nested, so their inclusive durations are
 * nearly identical while their self times differ by two orders of magnitude.
 * A summary that ranked by self time, or that failed to correlate, would
 * still produce ten plausible rows — so both numbers are pinned per row.
 */
const FIXTURE_TOP_SPANS: readonly ExpectedSpan[] = [
  {
    id: 'evt_h2k6m0q4t8w2z6bd',
    kind: 'interaction',
    tier: 'browser',
    name: 'click button',
    durationMs: 1_290.408,
    selfTimeMs: 42.978,
  },
  {
    id: 'evt_j3n7p1r5v9x3c7fk',
    kind: 'fetch',
    tier: 'browser',
    name: 'GET /api/items',
    durationMs: 1_112.65,
    selfTimeMs: 16.366,
  },
  {
    id: 'evt_k4q8s2t6v0y4d8gm',
    kind: 'http.server',
    tier: 'server',
    name: 'GET /api/items',
    durationMs: 1_096.284,
    selfTimeMs: 5.844,
  },
  {
    id: 'evt_m5r9t3w7z1b5f9hn',
    kind: 'route.handler',
    tier: 'server',
    name: 'executing api route (app) /api/items',
    durationMs: 1_090.44,
    selfTimeMs: 11.93,
  },
  {
    id: 'evt_n6s0v4x8c2d6g0jp',
    kind: 'function',
    tier: 'server',
    name: 'loadItems',
    durationMs: 1_078.51,
    selfTimeMs: 457.851,
  },
  {
    id: 'evt_r9w3y7b1g5h9k3ns',
    kind: 'fetch',
    tier: 'browser',
    name: 'GET /api/summary',
    durationMs: 672.4,
    selfTimeMs: 31.9,
  },
  {
    id: 'evt_v2z6c0f4k8m2p6rw',
    kind: 'http.server',
    tier: 'server',
    name: 'GET /api/summary',
    durationMs: 640.5,
    selfTimeMs: 7.22,
  },
  {
    id: 'evt_x4c8f2h6n0p4s8ty',
    kind: 'route.handler',
    tier: 'server',
    name: 'executing api route (app) /api/summary',
    durationMs: 633.28,
    selfTimeMs: 44.4,
  },
  {
    id: 'evt_p7t1w5y9d3f7h1kq',
    kind: 'db.query',
    tier: 'db',
    name: 'SELECT items',
    durationMs: 412.219,
    selfTimeMs: 412.219,
  },
  {
    id: 'evt_y5d9g3j7p1q5t9vz',
    kind: 'function',
    tier: 'server',
    name: 'buildSummary',
    durationMs: 402.66,
    selfTimeMs: 306.542,
  },
];

/** One row of the fixture's component ranking. */
interface ExpectedRender {
  /** The derived, stable row id. */
  readonly id: string;
  /** The component that rendered. */
  readonly component: string;
  /** Renders observed for it. */
  readonly renderCount: number;
  /** Summed render time, in milliseconds. */
  readonly totalDurationMs: number;
  /** Mean render time, in milliseconds. */
  readonly averageDurationMs: number;
  /** Longest single render, in milliseconds. */
  readonly maxDurationMs: number;
  /** Start of its earliest render. */
  readonly firstStartTime: number;
  /** Start of its latest render. */
  readonly lastStartTime: number;
  /** Renders whose inputs were all stable. */
  readonly unchangedRenderCount: number;
  /** Renders whose trigger could not be determined. */
  readonly unknownTriggerCount: number;
  /** The file the component resolved to. */
  readonly sourceFile: string;
}

/**
 * The three components of the fixture, in the order the rollup publishes
 * them: render count descending, then component name ascending.
 *
 * Every component rendered exactly twice here, which is what makes the row
 * order a real test of the tie-break rather than of the primary key.
 */
const FIXTURE_TOP_RENDERS: readonly ExpectedRender[] = [
  {
    id: 'render:ItemList',
    component: 'ItemList',
    renderCount: 2,
    totalDurationMs: 9.322,
    averageDurationMs: 4.661,
    maxDurationMs: 6.118,
    firstStartTime: 1_789_812_900_710.5,
    lastStartTime: 1_789_812_901_227.8,
    unchangedRenderCount: 1,
    unknownTriggerCount: 0,
    sourceFile: 'src/components/ItemList.tsx',
  },
  {
    id: 'render:ItemRow',
    component: 'ItemRow',
    renderCount: 2,
    totalDurationMs: 4.802,
    averageDurationMs: 2.401,
    maxDurationMs: 2.884,
    firstStartTime: 1_789_812_900_717.3,
    lastStartTime: 1_789_812_901_231.5,
    unchangedRenderCount: 1,
    unknownTriggerCount: 1,
    sourceFile: 'src/components/ItemList.tsx',
  },
  {
    id: 'render:WidgetPanel',
    component: 'WidgetPanel',
    renderCount: 2,
    totalDurationMs: 15.814,
    averageDurationMs: 7.907,
    maxDurationMs: 8.204,
    firstStartTime: 1_789_812_900_701.2,
    lastStartTime: 1_789_812_901_219.4,
    unchangedRenderCount: 0,
    unknownTriggerCount: 0,
    sourceFile: 'src/components/WidgetPanel.tsx',
  },
];

/** One row of the fixture's request ranking. */
interface ExpectedRequest {
  /** The derived, stable group id. */
  readonly id: string;
  /** The request key the occurrences share. */
  readonly requestKey: string;
  /** What the group was grouped by. */
  readonly groupedBy: string;
  /** The HTTP method. */
  readonly method: string;
  /** The already-redacted display URL. */
  readonly url: string;
  /** The path portion of it. */
  readonly path: string;
  /** Occurrences in the group. */
  readonly count: number;
  /** Occurrences beyond the first inside a duplicate window. */
  readonly duplicateCount: number;
  /** Summed duration, in milliseconds. */
  readonly totalDurationMs: number;
  /** Mean duration, in milliseconds. */
  readonly averageDurationMs: number;
  /** Fastest occurrence, in milliseconds. */
  readonly minDurationMs: number;
  /** Slowest occurrence, in milliseconds. */
  readonly maxDurationMs: number;
  /** Start of the earliest occurrence. */
  readonly firstStartTime: number;
  /** Start of the latest occurrence. */
  readonly lastStartTime: number;
  /** The distinct status codes observed. */
  readonly statusCodes: readonly number[];
  /** The initiators the producer attributed the requests to, ascending. */
  readonly initiators: readonly string[];
  /** The occurrences' event ids, in canonical order. */
  readonly eventIds: readonly string[];
}

/**
 * The four request groups of the fixture, most redundant first.
 *
 * The capture holds the finding this section exists for: four identical
 * `/api/summary` fetches within twenty-two milliseconds of each other, three
 * of them redundant. It also holds the case that must **not** be grouped —
 * two `/api/items/detail` fetches whose query parameters differ, so their
 * request keys differ and each forms its own group of one (AAP 0.2.3's
 * true-duplicate versus different-parameter distinction).
 */
const FIXTURE_TOP_REQUESTS: readonly ExpectedRequest[] = [
  {
    id: 'req:k:9af72a67410d93b152beeb948a61402b1d6615e03b40fe555f73ec03696f0cef',
    requestKey: '9af72a67410d93b152beeb948a61402b1d6615e03b40fe555f73ec03696f0cef',
    groupedBy: 'request-key',
    method: 'GET',
    url: 'http://localhost:3000/api/summary?groupId=?&window=?',
    path: '/api/summary',
    count: 4,
    duplicateCount: 3,
    totalDurationMs: 689.547,
    averageDurationMs: 172.387,
    minDurationMs: 4.907,
    maxDurationMs: 672.4,
    firstStartTime: 1_789_812_900_540.118,
    lastStartTime: 1_789_812_900_562.06,
    statusCodes: [200],
    initiators: ['WidgetPanel', 'fetchItemList'],
    eventIds: [
      'evt_r9w3y7b1g5h9k3ns',
      'evt_s0x4z8c2h6j0m4pt',
      'evt_t1y5b9d3j7k1n5qv',
      'evt_w3b7d1g5m9n3q7sx',
    ],
  },
  {
    id: 'req:k:5c06eb89dcf6c265e1212356be7bfa790f1224ee1a9616ff9a1d0d7ba0a770fe',
    requestKey: '5c06eb89dcf6c265e1212356be7bfa790f1224ee1a9616ff9a1d0d7ba0a770fe',
    groupedBy: 'request-key',
    method: 'GET',
    url: 'http://localhost:3000/api/items?filter=?&page=?',
    path: '/api/items',
    count: 1,
    duplicateCount: 0,
    totalDurationMs: 1_112.65,
    averageDurationMs: 1_112.65,
    minDurationMs: 1_112.65,
    maxDurationMs: 1_112.65,
    firstStartTime: 1_789_812_900_006.214,
    lastStartTime: 1_789_812_900_006.214,
    statusCodes: [200],
    initiators: ['fetchItemList'],
    eventIds: ['evt_j3n7p1r5v9x3c7fk'],
  },
  {
    id: 'req:k:bd4cefcac7efe8ad41ca80b3d957abf48f8a6b76be1c17e64594fec5466cfbf0',
    requestKey: 'bd4cefcac7efe8ad41ca80b3d957abf48f8a6b76be1c17e64594fec5466cfbf0',
    groupedBy: 'request-key',
    method: 'GET',
    url: 'http://localhost:3000/api/items/detail?itemId=?',
    path: '/api/items/detail',
    count: 1,
    duplicateCount: 0,
    totalDurationMs: 96.4,
    averageDurationMs: 96.4,
    minDurationMs: 96.4,
    maxDurationMs: 96.4,
    firstStartTime: 1_789_812_901_050.2,
    lastStartTime: 1_789_812_901_050.2,
    statusCodes: [200],
    initiators: ['ItemRow'],
    eventIds: ['evt_k4q8s2v6z0b4f8gm'],
  },
  {
    id: 'req:k:4e861d1bbfbea01546bc2c7168931f86f68cb933f384740bc9c4ca9eacaa058e',
    requestKey: '4e861d1bbfbea01546bc2c7168931f86f68cb933f384740bc9c4ca9eacaa058e',
    groupedBy: 'request-key',
    method: 'GET',
    url: 'http://localhost:3000/api/items/detail?itemId=?',
    path: '/api/items/detail',
    count: 1,
    duplicateCount: 0,
    totalDurationMs: 88.1,
    averageDurationMs: 88.1,
    minDurationMs: 88.1,
    maxDurationMs: 88.1,
    firstStartTime: 1_789_812_901_062.7,
    lastStartTime: 1_789_812_901_062.7,
    statusCodes: [200],
    initiators: ['ItemRow'],
    eventIds: ['evt_m5r9t3w7b1c5g9hn'],
  },
];

/** The single duplicate window of the fixture's redundant request group. */
const FIXTURE_DUPLICATE_WINDOW = {
  /** The window's derived id: the group's id with its ordinal appended. */
  id: 'req:k:9af72a67410d93b152beeb948a61402b1d6615e03b40fe555f73ec03696f0cef#w0',
  /** When the first occurrence in the window started. */
  startTime: 1_789_812_900_540.118,
  /** When the last occurrence in the window started. */
  endTime: 1_789_812_900_562.06,
  /** Occurrences inside it. */
  count: 4,
  /** How many of those were redundant: every one after the first. */
  redundantCount: 3,
} as const;

/** One row of the fixture's statement ranking. */
interface ExpectedQuery {
  /** The derived, stable group id. */
  readonly id: string;
  /** The parameterized statement as the producer reported it. */
  readonly statement: string;
  /** Its normalised form, which is what the grouping is keyed on. */
  readonly normalizedStatement: string;
  /** The database system. */
  readonly system: string;
  /** Executions in the group. */
  readonly executionCount: number;
  /** Summed duration, in milliseconds. */
  readonly totalDurationMs: number;
  /** Mean duration, in milliseconds. */
  readonly averageDurationMs: number;
  /** Fastest execution, in milliseconds. */
  readonly minDurationMs: number;
  /** Slowest execution, in milliseconds. */
  readonly maxDurationMs: number;
  /** Start of the earliest execution. */
  readonly firstStartTime: number;
  /** Start of the latest execution. */
  readonly lastStartTime: number;
  /** Rows the executions returned in total. */
  readonly totalRowCount: number;
  /** The callers, in the published order: busiest first, then by name. */
  readonly callerNames: readonly string[];
  /** The executions' event ids, in canonical order. */
  readonly eventIds: readonly string[];
}

/**
 * The three statement groups of the fixture, costliest first.
 *
 * The first group is the one that matters: two executions of the *same*
 * statement with different parameter arities (`IN ($1, $2, $3)` and
 * `IN ($1)`), issued from two different server functions. They group together
 * because normalisation collapses the parameter list, and the group therefore
 * carries two callers — the N+1 shape the query table exists to surface.
 *
 * The third is the fixture's double-observed execution, and every number in it
 * is the **outer** ORM span's: the driver span nested inside it reported the
 * same statement 2.6 ms later and 9.442 ms long, and it is not a second
 * execution. A `totalDurationMs` of 23.76, a `maxDurationMs` of 9.442 or an
 * `executionCount` of 2 here would each be a different way of reporting one
 * statement twice.
 */
const FIXTURE_TOP_QUERIES: readonly ExpectedQuery[] = [
  {
    id: 'qg_49a7517a21794002',
    statement: 'SELECT id, name FROM items WHERE id IN ($1, $2, $3)',
    normalizedStatement: 'SELECT id, name FROM items WHERE id IN (?)',
    system: 'postgresql',
    executionCount: 2,
    totalDurationMs: 508.337,
    averageDurationMs: 254.169,
    minDurationMs: 96.118,
    maxDurationMs: 412.219,
    firstStartTime: 1_789_812_900_036.881,
    lastStartTime: 1_789_812_900_578.44,
    totalRowCount: 4,
    callerNames: ['buildSummary', 'loadItems'],
    eventIds: ['evt_p7t1w5y9d3f7h1kq', 'evt_z6f0h4k8q2r6v0wb'],
  },
  {
    id: 'qg_0ee901a0fd78cd38',
    statement: 'SELECT group_id, label FROM item_groups WHERE group_id = $1',
    normalizedStatement: 'SELECT group_id, label FROM item_groups WHERE group_id = ?',
    system: 'postgresql',
    executionCount: 2,
    totalDurationMs: 394.66,
    averageDurationMs: 197.33,
    minDurationMs: 186.22,
    maxDurationMs: 208.44,
    firstStartTime: 1_789_812_900_455.3,
    lastStartTime: 1_789_812_901_004.6,
    totalRowCount: 2,
    callerNames: ['executing api route (app) /api/summary', 'loadItems'],
    eventIds: ['evt_q8v2x6z0f4g8j2mr', 'evt_j3p7r1t5y9z3d7fk'],
  },
  {
    id: 'qg_7c35798f6e5fe587',
    statement: 'SELECT count(*) AS total FROM items WHERE group_id = $1',
    normalizedStatement: 'SELECT count(*) AS total FROM items WHERE group_id = ?',
    system: 'postgresql',
    executionCount: 1,
    totalDurationMs: 14.318,
    averageDurationMs: 14.318,
    minDurationMs: 14.318,
    maxDurationMs: 14.318,
    firstStartTime: 1_789_812_900_110.3,
    lastStartTime: 1_789_812_900_110.3,
    totalRowCount: 1,
    callerNames: ['loadItems'],
    eventIds: ['evt_y5g9j3n7q1t5w9xb'],
  },
];

/** The fixture's single failure, as the rollup must project it. */
const FIXTURE_ERROR = {
  /** The event's own id. */
  id: 'evt_t1z5b9f2j7m1p5qw',
  /** The span that failed. */
  spanId: '93e6c085b27fd41a',
  /** The failure kind. */
  kind: 'error',
  /** The tier that recorded it. */
  tier: 'browser',
  /** The already-redacted span name. */
  name: 'TypeError',
  /** When it was recorded. */
  startTime: 1_789_812_901_268.9,
  /** The file the source map resolved it to. */
  sourceFile: 'src/components/ItemList.tsx',
  /** The line in that file. */
  sourceLine: 101,
} as const;

/** One node of the fixture's committed component tree. */
interface ExpectedTreeNode {
  /** The derived, path-shaped node id. */
  readonly id: string;
  /** The component at this position. */
  readonly component: string;
  /** Its React key. */
  readonly key: string;
  /** Its depth from the root. */
  readonly depth: number;
  /** Renders observed for the component. */
  readonly renderCount: number;
  /** Summed render time for it, in milliseconds. */
  readonly totalDurationMs: number;
  /** The trigger of its most recent render. */
  readonly lastTrigger: RenderTrigger;
}

/**
 * The fixture's component tree: a single chain, as the second commit's
 * snapshot describes it.
 *
 * The structure comes from the `componentTree` attribute of the *last* commit
 * in the capture (`origin: 'commit-snapshot'`), while the per-node render
 * counts and durations come from the render events — so this table also pins
 * that the two sources are joined rather than one of them being invented.
 */
const FIXTURE_COMPONENT_TREE_CHAIN: readonly ExpectedTreeNode[] = [
  {
    id: 'tree:WidgetPanel[widget-panel]',
    component: 'WidgetPanel',
    key: 'widget-panel',
    depth: 0,
    renderCount: 2,
    totalDurationMs: 15.814,
    lastTrigger: 'context',
  },
  {
    id: 'tree:WidgetPanel[widget-panel]/ItemList[item-list]',
    component: 'ItemList',
    key: 'item-list',
    depth: 1,
    renderCount: 2,
    totalDurationMs: 9.322,
    lastTrigger: 'unchanged',
  },
  {
    id: 'tree:WidgetPanel[widget-panel]/ItemList[item-list]/ItemRow[row-0]',
    component: 'ItemRow',
    key: 'row-0',
    depth: 2,
    renderCount: 2,
    totalDurationMs: 4.802,
    lastTrigger: 'unchanged',
  },
];

/**
 * Text the fixture's events carry and a summary of them must never republish.
 *
 * The fixture is redacted, but redaction is about *values* — it leaves an
 * error stack, an error message and the hook-state previews in the events,
 * because the event log and the state-transition panel source legitimately
 * show them to the developer in the IDE. The summary is a different audience:
 * it is put in front of a model stage (AAP 0.5.2), so every one of these has
 * to be absent from it. Each string below is distinctive enough that its
 * appearance anywhere in the serialised summary is proof of a leak, and
 * general enough not to collide with the structured `source` locations the
 * summary does carry.
 */
const FIXTURE_TEXT_THE_SUMMARY_MUST_NOT_CARRY: readonly string[] = [
  "Cannot read properties of undefined (reading 'label')",
  'at ItemRow (src/components/ItemList.tsx:101:24)',
  'Array(24)',
  '{ groupId: number, window: string, refreshedAt: number }',
];

/**
 * `value` at the precision this module publishes durations in.
 *
 * Every duration in a summary goes through `roundMs`, which keeps three
 * decimals. A figure *derived* from two published numbers therefore has to be
 * compared at that same precision: subtracting two epoch-millisecond doubles
 * of this magnitude carries float error around 10^-8 ms
 * (`1789812901290.408 - 1789812900000` is `1290.407958984375`), and adding
 * two independently rounded durations can exceed their unrounded sum by a
 * hair (`111.268 + 1179.14` is `1290.4080000000001`). Neither is a defect in
 * the arithmetic, and neither would be visible in a panel — but an exact
 * comparison would report both as failures and hide a real change behind that
 * noise.
 */
function atPublishedPrecision(value: number): number {
  return Number(value.toFixed(3));
}

/** The row at `index`, failing the case rather than asserting against `undefined`. */
function rowAt<Row>(rows: readonly Row[], index: number, section: string): Row {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`the ${section} section published no row at index ${String(index)}`);
  }
  return row;
}

/** How many events of `kind` the fixture holds, counted from the corpus itself. */
function fixtureEventsOfKind(kind: TelemetryKind): readonly TelemetryEvent[] {
  return CAPTURE_BATCH_EVENTS.filter((event) => event.kind === kind);
}

/** How many events of any of `kinds` the fixture holds, counted from the corpus itself. */
function fixtureEventsOfKinds(kinds: readonly TelemetryKind[]): readonly TelemetryEvent[] {
  const wanted = new Set(kinds);
  return CAPTURE_BATCH_EVENTS.filter((event) => wanted.has(event.kind));
}

/**
 * The fixture's renders whose `trigger` attribute is exactly `trigger`.
 *
 * Read straight off the corpus, so the render totals can be asserted as
 * identities rather than as restated numbers. Membership is exact — every
 * render in this fixture spells a member of the trigger vocabulary — which is
 * also why a capture with an unreadable trigger is a case for the builder
 * fixtures above rather than for this corpus.
 */
function fixtureRendersTriggeredBy(trigger: RenderTrigger): readonly TelemetryEvent[] {
  return fixtureEventsOfKind(RENDER_KIND).filter(
    (event) => event.attributes[TRIGGER_ATTRIBUTE] === trigger,
  );
}

describe('the committed capture fixture', () => {
  it('is thirty-five persisted events the store could hold, parsed from the file on disk', () => {
    // The loader threw if any element failed `telemetryEventSchema`, so
    // reaching this line already establishes the contract. It is restated
    // through the public guard as well, because that is the predicate every
    // consumer of the fixture uses, and because a loader that silently
    // returned an empty array would otherwise pass every case below.
    expect(CAPTURE_BATCH_EVENTS).toHaveLength(FIXTURE_EVENT_COUNT);
    for (const event of CAPTURE_BATCH_EVENTS) {
      expect(isTelemetryEvent(event)).toBe(true);
    }
  });

  it('is one attributed capture on one trace, from the two producers', () => {
    const sessionIds = new Set(CAPTURE_BATCH_EVENTS.map((event) => event.sessionId));
    const captureIds = new Set(CAPTURE_BATCH_EVENTS.map((event) => event.captureId));
    const traceIds = new Set(CAPTURE_BATCH_EVENTS.map((event) => event.traceId));
    const producerIds = [...new Set(CAPTURE_BATCH_EVENTS.map((event) => event.producerId))].sort();

    expect([...sessionIds]).toEqual([FIXTURE_SESSION_ID]);
    expect([...captureIds]).toEqual([FIXTURE_CAPTURE_ID]);
    expect([...traceIds]).toEqual([FIXTURE_TRACE_ID]);
    expect(producerIds).toEqual([FIXTURE_BROWSER_PRODUCER_ID, FIXTURE_SERVER_PRODUCER_ID]);
  });

  it('carries the store-assigned arrival numbers, one per event in file order', () => {
    // `ingestSeq` is the final, always-distinct tie-break of the canonical
    // order, so a fixture with a repeated or missing arrival number would
    // make the orderings below untestable rather than merely odd.
    expect(CAPTURE_BATCH_EVENTS.map((event) => event.ingestSeq)).toEqual(
      Array.from({ length: FIXTURE_EVENT_COUNT }, (_unused, index) => index + 1),
    );
  });

  it('is fixed repository data rather than captured telemetry', () => {
    // Every timestamp is a literal in the committed file, which is what makes
    // the expected numbers below exact: nothing here was read from a clock at
    // run time, so the capture window cannot drift between two runs. The
    // check is on the corpus, not on a summary, so it fails at its cause.
    for (const event of CAPTURE_BATCH_EVENTS) {
      expect(event.startTime).toBeGreaterThanOrEqual(FIXTURE_WINDOW.startTime);
      expect(event.startTime + event.duration).toBeLessThanOrEqual(FIXTURE_WINDOW.endTime);
    }
    expect(Math.min(...CAPTURE_BATCH_EVENTS.map((event) => event.startTime))).toBe(
      FIXTURE_WINDOW.startTime,
    );
    expect(Math.max(...CAPTURE_BATCH_EVENTS.map((event) => event.startTime + event.duration))).toBe(
      FIXTURE_WINDOW.endTime,
    );
  });

  it('holds the events every kind and tier tally below is derived from', () => {
    for (const kind of TELEMETRY_KINDS) {
      expect(fixtureEventsOfKind(kind)).toHaveLength(FIXTURE_KIND_COUNTS[kind] ?? 0);
    }
    for (const tier of TELEMETRY_TIERS) {
      expect(CAPTURE_BATCH_EVENTS.filter((event) => event.tier === tier)).toHaveLength(
        FIXTURE_TIER_COUNTS[tier],
      );
    }
  });

  it('hands each case a private copy, so no case can affect the next', () => {
    const first = captureBatchEvents();
    const second = captureBatchEvents();

    expect(first).toEqual([...CAPTURE_BATCH_EVENTS]);
    expect(first).not.toBe(second);
    expect(rowAt(first, 0, 'fixture')).not.toBe(rowAt(second, 0, 'fixture'));
  });
});

describe('computeMetrics on the committed capture fixture', () => {
  it('publishes every id in the vocabulary exactly once, in declaration order', () => {
    const values = computeMetrics(captureBatchEvents());
    const publishedIds = values.map((value) => value.id);

    expect(publishedIds).toEqual([...METRIC_IDS]);
    expect(new Set(publishedIds).size).toBe(publishedIds.length);
    expect(values).toHaveLength(METRIC_IDS.length);
  });

  it('labels every value from the definitions and carries the declared unit', () => {
    const values = computeMetrics(captureBatchEvents());

    for (const value of values) {
      const definition = METRIC_DEFINITIONS[value.id];
      expect(value.label).toBe(definition.label);
      expect(value.unit).toBe(definition.unit);
      expect(value.unit).toBe(metricUnitFor(value.id));
    }
  });

  it('measures every id the fixture can pin, and pins every id but one', () => {
    // The table and the coverage-limited id together must cover the
    // vocabulary exactly: a metric added to `METRIC_IDS` fails here until its
    // value on this capture is stated, which is the point of expressing the
    // expectations as data.
    const tabledIds = FIXTURE_METRIC_VALUES.map((expectation) => expectation.id);

    expect([...tabledIds, COVERAGE_LIMITED_METRIC_ID].sort()).toEqual([...METRIC_IDS].sort());
    expect(new Set(tabledIds).size).toBe(tabledIds.length);
    expect(tabledIds).not.toContain(COVERAGE_LIMITED_METRIC_ID);
  });

  it.each(FIXTURE_METRIC_VALUES)(
    'measures $id as $value for this capture',
    ({ id, value }: FixtureMetricExpectation) => {
      const values = computeMetrics(captureBatchEvents());
      const published = metric(values, id);

      expect(published.available).toBe(true);
      expect(published.value).toBe(value);
      expect(valueOf(values, id)).toBe(value);
    },
  );

  it('keeps the coverage-limited metric self-consistent, whatever it could measure', () => {
    // Deliberately no expectation about *whether* this capture could measure
    // transferred bytes: that depends on what the request pipeline reports,
    // and it is not this rollup's decision. What is asserted is the honesty
    // rule the published shape must satisfy either way (AAP 0.8.4): a metric
    // reported unavailable carries the coverage caveat and no `value` KEY at
    // all — not a zero, not an `undefined` — while an available one carries a
    // finite number. The id is present exactly once with the byte unit
    // regardless, because the vocabulary is closed (AAP 0.2.3).
    const values = computeMetrics(captureBatchEvents());
    const matches = values.filter((value) => value.id === COVERAGE_LIMITED_METRIC_ID);
    const published = metric(values, COVERAGE_LIMITED_METRIC_ID);

    expect(matches).toHaveLength(1);
    expect(published.unit).toBe('bytes');
    expect(METRIC_UNITS).toContain(published.unit);

    if (published.available) {
      expect(typeof published.value).toBe('number');
      expect(Number.isFinite(published.value)).toBe(true);
      expect(published.value).toBeGreaterThanOrEqual(0);
    } else {
      expect('value' in published).toBe(false);
      expect(published.note).toBeDefined();
      expect(published.note?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('counts exactly what the corpus holds, through the kind groups', () => {
    // The same numbers as the table above, but derived from the fixture
    // instead of restated: a table that drifted from the file it describes
    // would keep passing against itself, and this is the check that would
    // not. Each identity is also the metric's definition (AAP 0.2.3).
    const values = computeMetrics(captureBatchEvents());
    const failures = CAPTURE_BATCH_EVENTS.filter(
      (event) => ERROR_KINDS.includes(event.kind) || event.status === ERROR_STATUS,
    );

    expect(valueOf(values, 'render_count')).toBe(fixtureEventsOfKind(RENDER_KIND).length);
    expect(valueOf(values, 'request_count')).toBe(fixtureEventsOfKinds(REQUEST_KINDS).length);
    // `query_count` is the one count that is not "events of a kind": three of
    // the nine database spans ran no statement and one is the driver's second
    // observation of a statement the ORM had already spanned, so the capture
    // ran five statements. Both intermediate facts are read off the fixture
    // through the module's own selector, so a fixture that gained or lost one
    // of these shapes fails here rather than quietly changing the metric.
    const databaseEvents = fixtureEventsOfKinds(QUERY_KINDS);
    const statementEvents = databaseEvents.filter((event) => isDatabaseStatementEvent(event));

    expect(databaseEvents).toHaveLength(FIXTURE_KIND_COUNTS[DB_QUERY_KIND] ?? 0);
    expect(statementEvents).toHaveLength(FIXTURE_STATEMENT_EVENT_COUNT);
    expect(valueOf(values, 'query_count')).toBe(
      FIXTURE_STATEMENT_EVENT_COUNT - FIXTURE_DOUBLE_OBSERVED_STATEMENT_COUNT,
    );
    // And the identity the metric is computed to hold: the card is the sum of
    // the query table's execution counts, never a second count beside it.
    expect(valueOf(values, 'query_count')).toBe(
      aggregateQueries(CAPTURE_BATCH_EVENTS).reduce(
        (running, group) => running + group.executionCount,
        0,
      ),
    );
    expect(valueOf(values, 'long_task_count')).toBe(fixtureEventsOfKind(LONG_TASK_KIND).length);
    expect(valueOf(values, 'error_count')).toBe(failures.length);

    // The split the plan insists on, counted from the fixture's own trigger
    // attributes: an unclassifiable render is counted apart from one whose
    // inputs were all stable, never folded into it (AAP 0.2.3, 0.8.4). Every
    // render in this capture states its trigger explicitly, so both totals
    // are identities rather than approximations.
    expect(valueOf(values, 'unchanged_render_count')).toBe(
      fixtureRendersTriggeredBy(UNCHANGED_TRIGGER).length,
    );
    expect(valueOf(values, 'render_trigger_unknown_count')).toBe(
      fixtureRendersTriggeredBy(UNKNOWN_TRIGGER).length,
    );
    expect(
      valueOf(values, 'unchanged_render_count') + valueOf(values, 'render_trigger_unknown_count'),
    ).toBeLessThanOrEqual(valueOf(values, 'render_count'));
  });

  it('keeps the parts within the whole, as the plan states the durations relate', () => {
    const values = computeMetrics(captureBatchEvents());
    const total = valueOf(values, 'total_duration');
    const frontend = valueOf(values, 'frontend_duration');
    const backend = valueOf(values, 'backend_duration');
    const database = valueOf(values, 'database_duration');

    // The invariants documented on `computeMetrics`, exercised on a capture
    // where all three tiers really overlap: the page's time awaiting the
    // server belongs to the backend, and the database spans nest inside the
    // server spans that issued them.
    expect(atPublishedPrecision(frontend + backend)).toBeLessThanOrEqual(total);
    expect(database).toBeLessThanOrEqual(backend);
    expect(total).toBe(FIXTURE_WINDOW.durationMs);
  });

  it('agrees with the rollup, and with itself when handed the rollup aggregates', () => {
    const events = captureBatchEvents();
    const summary = computeCaptureSummary(events, fixtureContext(), { topN: events.length });

    // Nothing was clipped at this bound, so the published sections ARE the
    // complete aggregates the rollup computed — which is what makes them a
    // valid `precomputed` input rather than a truncated one.
    expect(summary.truncated).toBe(false);

    const recomputed = computeMetrics(events, {
      precomputed: {
        renders: summary.topRenders,
        requests: summary.topRequests,
        queries: summary.topQueries,
      },
    });

    // The single-aggregation guarantee: a card and the table beneath it are
    // computed from one aggregation of one capture, so recomputing the
    // metrics from the very rows the rollup published cannot move a number.
    expect(recomputed).toEqual([...summary.metrics]);
    expect(computeMetrics(events)).toEqual([...summary.metrics]);
  });
});

describe('computeCaptureSummary on the committed capture fixture', () => {
  it('takes its identity from the caller and its window from the fixture', () => {
    const summary = computeCaptureSummary(captureBatchEvents(), fixtureContext());

    expect(summary.captureId).toBe(FIXTURE_CAPTURE_ID);
    expect(summary.sessionId).toBe(FIXTURE_SESSION_ID);
    expect(summary.startTime).toBe(FIXTURE_WINDOW.startTime);
    expect(summary.endTime).toBe(FIXTURE_WINDOW.endTime);
    expect(summary.durationMs).toBe(FIXTURE_WINDOW.durationMs);
    expect(atPublishedPrecision(summary.endTime - summary.startTime)).toBe(summary.durationMs);
  });

  it('counts every event it was given, and every tier and kind it holds', () => {
    const events = captureBatchEvents();
    const summary = computeCaptureSummary(events, fixtureContext());

    expect(summary.eventCount).toBe(events.length);
    expect(summary.eventCount).toBe(FIXTURE_EVENT_COUNT);

    for (const tier of TELEMETRY_TIERS) {
      expect(summary.tierCounts[tier]).toBe(FIXTURE_TIER_COUNTS[tier]);
    }
    // Zero-filled over the whole kind vocabulary, so a consumer can index by
    // any member without finding a hole — the fixture holds eleven of the
    // seventeen kinds, and the other six must read zero rather than be absent.
    for (const kind of TELEMETRY_KINDS) {
      expect(summary.kindCounts[kind]).toBe(FIXTURE_KIND_COUNTS[kind] ?? 0);
      expect(summary.kindCounts[kind]).toBe(fixtureEventsOfKind(kind).length);
    }

    const tieredTotal = TELEMETRY_TIERS.reduce(
      (running, tier) => running + summary.tierCounts[tier],
      0,
    );
    const kindedTotal = TELEMETRY_KINDS.reduce(
      (running, kind) => running + summary.kindCounts[kind],
      0,
    );
    expect(tieredTotal).toBe(summary.eventCount);
    expect(kindedTotal).toBe(summary.eventCount);
  });

  it('lists the one trace, anchors on it, and names both producers ascending', () => {
    const summary = computeCaptureSummary(captureBatchEvents(), fixtureContext());

    expect(summary.traceCount).toBe(1);
    expect([...summary.traceIds]).toEqual([FIXTURE_TRACE_ID]);
    expect(summary.primaryTraceId).toBe(FIXTURE_TRACE_ID);
    expect([...summary.producerIds]).toEqual([
      FIXTURE_BROWSER_PRODUCER_ID,
      FIXTURE_SERVER_PRODUCER_ID,
    ]);
    expect([...summary.producerIds]).toEqual([...summary.producerIds].sort());
  });

  it('carries all fourteen metric values and lists only the ones it could not measure', () => {
    const summary = computeCaptureSummary(captureBatchEvents(), fixtureContext());

    expect(summary.metrics.map((value) => value.id)).toEqual([...METRIC_IDS]);
    // Derived from the published values rather than restated, so this stays
    // true whatever coverage the capture had for the byte metric: the list is
    // exactly the unavailable ids, in vocabulary order.
    expect([...summary.unavailableMetrics]).toEqual(
      summary.metrics.filter((value) => !value.available).map((value) => value.id),
    );
    for (const { id, value } of FIXTURE_METRIC_VALUES) {
      expect(summary.unavailableMetrics).not.toContain(id);
      expect(valueOf(summary.metrics, id)).toBe(value);
    }
  });

  it('ranks the ten slowest spans, longest first, with the self time of each', () => {
    const summary = computeCaptureSummary(captureBatchEvents(), fixtureContext());

    expect(summary.topSpans).toHaveLength(DEFAULT_TOP_N);
    expect(summary.topSpans.map((span) => span.id)).toEqual(
      FIXTURE_TOP_SPANS.map((expected) => expected.id),
    );

    FIXTURE_TOP_SPANS.forEach((expected, index) => {
      const published: SpanSummary = rowAt(summary.topSpans, index, 'topSpans');

      expect(published.kind).toBe(expected.kind);
      expect(published.tier).toBe(expected.tier);
      expect(published.name).toBe(expected.name);
      expect(published.durationMs).toBe(expected.durationMs);
      // Self time is the distinction the analysis stage turns into two
      // different findings — "this span did the work" versus "this span
      // waited" — so it is pinned per row rather than merely asserted present.
      expect(published.selfTimeMs).toBe(expected.selfTimeMs);
      expect(published.traceId).toBe(FIXTURE_TRACE_ID);
      // The compact projection: no attribute bag travels in the rollup.
      expect('attributes' in published).toBe(false);
    });

    const durations = summary.topSpans.map((span) => span.durationMs);
    expect(durations).toEqual([...durations].sort((left, right) => right - left));
  });

  it('publishes the three components that rendered, busiest first then by name', () => {
    const events = captureBatchEvents();
    const summary = computeCaptureSummary(events, fixtureContext());

    expect(summary.topRenders).toHaveLength(FIXTURE_TOP_RENDERS.length);

    FIXTURE_TOP_RENDERS.forEach((expected, index) => {
      const published = rowAt(summary.topRenders, index, 'topRenders');

      expect(published.id).toBe(expected.id);
      expect(published.component).toBe(expected.component);
      expect(published.renderCount).toBe(expected.renderCount);
      expect(published.totalDurationMs).toBe(expected.totalDurationMs);
      expect(published.averageDurationMs).toBe(expected.averageDurationMs);
      expect(published.maxDurationMs).toBe(expected.maxDurationMs);
      expect(published.firstStartTime).toBe(expected.firstStartTime);
      expect(published.lastStartTime).toBe(expected.lastStartTime);
      expect(published.unchangedRenderCount).toBe(expected.unchangedRenderCount);
      expect(published.unknownTriggerCount).toBe(expected.unknownTriggerCount);
      expect(published.source?.file).toBe(expected.sourceFile);
      // The rollup aggregates renders counts-only: the per-render occurrence
      // lists are what the `renders` panel-data source is for, and they would
      // dominate the size of a payload that rides on a WebSocket broadcast.
      expect(published.occurrences).toEqual([]);
      expect(published.occurrencesTruncated).toBe(true);
    });

    // The identity `render_count` = the sum of the published counts, which
    // `./renders.ts` documents and this module relies on.
    const summed = summary.topRenders.reduce((running, stat) => running + stat.renderCount, 0);
    expect(summed).toBe(valueOf(summary.metrics, 'render_count'));
    expect(summary.topRenders).toEqual(
      aggregateRenders(events, { includeOccurrences: false, maxOccurrencesPerComponent: 0 }),
    );
  });

  it('publishes the four request groups, most redundant first, with their occurrences', () => {
    const events = captureBatchEvents();
    const summary = computeCaptureSummary(events, fixtureContext());

    expect(summary.topRequests).toHaveLength(FIXTURE_TOP_REQUESTS.length);

    FIXTURE_TOP_REQUESTS.forEach((expected, index) => {
      const published = rowAt(summary.topRequests, index, 'topRequests');

      expect(published.id).toBe(expected.id);
      expect(published.requestKey).toBe(expected.requestKey);
      expect(published.groupedBy).toBe(expected.groupedBy);
      expect(published.method).toBe(expected.method);
      // The already-redacted display URL: the fixture's query values are `?`
      // placeholders, and the summary republishes what the aggregate produced
      // rather than reading the event again.
      expect(published.url).toBe(expected.url);
      expect(published.path).toBe(expected.path);
      expect(published.count).toBe(expected.count);
      expect(published.duplicateCount).toBe(expected.duplicateCount);
      expect(published.hasDuplicates).toBe(expected.duplicateCount > 0);
      expect(published.totalDurationMs).toBe(expected.totalDurationMs);
      expect(published.averageDurationMs).toBe(expected.averageDurationMs);
      expect(published.minDurationMs).toBe(expected.minDurationMs);
      expect(published.maxDurationMs).toBe(expected.maxDurationMs);
      expect(published.firstStartTime).toBe(expected.firstStartTime);
      expect(published.lastStartTime).toBe(expected.lastStartTime);
      expect([...published.statusCodes]).toEqual([...expected.statusCodes]);
      expect(published.errorCount).toBe(0);
      expect([...published.initiators]).toEqual([...expected.initiators]);
      expect(published.occurrences.map((occurrence) => occurrence.id)).toEqual([
        ...expected.eventIds,
      ]);
      expect(published.occurrencesTruncated).toBe(false);
    });

    // The two `/api/items/detail` fetches differ only in a query parameter,
    // so they must NOT share a group: a true duplicate and a
    // different-parameter request support different conclusions (AAP 0.2.3).
    const detailGroups = summary.topRequests.filter((group) => group.path === '/api/items/detail');
    expect(detailGroups).toHaveLength(2);
    expect(new Set(detailGroups.map((group) => group.requestKey)).size).toBe(2);

    expect(summary.topRequests).toEqual(
      aggregateRequests(events, { maxOccurrencesPerGroup: DEFAULT_TOP_N }),
    );
    expect(countDuplicateRequests(summary.topRequests)).toBe(
      valueOf(summary.metrics, 'duplicate_request_count'),
    );
    const occurrences = summary.topRequests.reduce((running, group) => running + group.count, 0);
    expect(occurrences).toBe(valueOf(summary.metrics, 'request_count'));
  });

  it('reports the redundant group as one duplicate window over its four occurrences', () => {
    const summary = computeCaptureSummary(captureBatchEvents(), fixtureContext());
    const redundant = rowAt(summary.topRequests, 0, 'topRequests');
    // Not named `window`: this suite runs under happy-dom, where that
    // identifier is a global.
    const published = rowAt(redundant.duplicateWindows, 0, 'duplicateWindows');

    expect(redundant.duplicateWindows).toHaveLength(1);
    expect(published.id).toBe(FIXTURE_DUPLICATE_WINDOW.id);
    expect(published.startTime).toBe(FIXTURE_DUPLICATE_WINDOW.startTime);
    expect(published.endTime).toBe(FIXTURE_DUPLICATE_WINDOW.endTime);
    expect(published.count).toBe(FIXTURE_DUPLICATE_WINDOW.count);
    expect(published.redundantCount).toBe(FIXTURE_DUPLICATE_WINDOW.redundantCount);
    expect(published.redundantCount).toBe(published.count - 1);
    expect([...published.eventIds]).toEqual([
      ...rowAt(FIXTURE_TOP_REQUESTS, 0, 'expected topRequests').eventIds,
    ]);
    // Every other group of this capture holds a single occurrence, so it has
    // no window at all — an empty list, never a window of one.
    for (const group of summary.topRequests.slice(1)) {
      expect(group.duplicateWindows).toEqual([]);
    }
  });

  it('publishes the three statement groups, costliest first, with their callers', () => {
    const events = captureBatchEvents();
    const summary = computeCaptureSummary(events, fixtureContext());

    expect(summary.topQueries).toHaveLength(FIXTURE_TOP_QUERIES.length);

    FIXTURE_TOP_QUERIES.forEach((expected, index) => {
      const published = rowAt(summary.topQueries, index, 'topQueries');

      expect(published.id).toBe(expected.id);
      // Parameterized text only: the fixture's statements carry `$1`
      // placeholders, and no literal ever reaches this object (AAP 0.5.2).
      expect(published.statement).toBe(expected.statement);
      expect(published.normalizedStatement).toBe(expected.normalizedStatement);
      expect(published.system).toBe(expected.system);
      expect(published.executionCount).toBe(expected.executionCount);
      expect(published.totalDurationMs).toBe(expected.totalDurationMs);
      expect(published.averageDurationMs).toBe(expected.averageDurationMs);
      expect(published.minDurationMs).toBe(expected.minDurationMs);
      expect(published.maxDurationMs).toBe(expected.maxDurationMs);
      expect(published.firstStartTime).toBe(expected.firstStartTime);
      expect(published.lastStartTime).toBe(expected.lastStartTime);
      expect(published.totalRowCount).toBe(expected.totalRowCount);
      expect(published.errorCount).toBe(0);
      expect([...published.traceIds]).toEqual([FIXTURE_TRACE_ID]);
      expect(published.callers.map((caller) => caller.name)).toEqual([...expected.callerNames]);
      expect(published.occurrences.map((occurrence) => occurrence.eventId)).toEqual([
        ...expected.eventIds,
      ]);
      expect(published.occurrencesTruncated).toBe(false);
    });

    const totals = summary.topQueries.map((group) => group.totalDurationMs);
    expect(totals).toEqual([...totals].sort((left, right) => right - left));

    const executions = summary.topQueries.reduce(
      (running, group) => running + group.executionCount,
      0,
    );
    expect(executions).toBe(valueOf(summary.metrics, 'query_count'));
    expect(summary.topQueries).toEqual(
      aggregateQueries(events, { maxOccurrencesPerGroup: DEFAULT_TOP_N }),
    );
  });

  it('publishes the one failure as identity and position, with no stack and no message', () => {
    const summary = computeCaptureSummary(captureBatchEvents(), fixtureContext());
    const published: ErrorSummary = rowAt(summary.errors, 0, 'errors');

    expect(summary.errors).toHaveLength(1);
    expect(published.id).toBe(FIXTURE_ERROR.id);
    expect(published.spanId).toBe(FIXTURE_ERROR.spanId);
    expect(published.traceId).toBe(FIXTURE_TRACE_ID);
    expect(published.kind).toBe(FIXTURE_ERROR.kind);
    expect(published.tier).toBe(FIXTURE_ERROR.tier);
    expect(published.name).toBe(FIXTURE_ERROR.name);
    expect(published.startTime).toBe(FIXTURE_ERROR.startTime);
    expect(published.source?.file).toBe(FIXTURE_ERROR.sourceFile);
    expect(published.source?.line).toBe(FIXTURE_ERROR.sourceLine);
    expect('duration' in published).toBe(false);
    expect('durationMs' in published).toBe(false);
    expect('attributes' in published).toBe(false);
    // The section and the metric count the same failures: the fixture holds
    // one, and it qualifies both by kind and by status, so a rollup that
    // counted the two conditions separately would publish two.
    expect(summary.errors).toHaveLength(valueOf(summary.metrics, 'error_count'));
  });

  it('republishes none of the text the fixture events carry', () => {
    const summary = computeCaptureSummary(captureBatchEvents(), fixtureContext(), {
      includeComponentTree: true,
      topN: FIXTURE_EVENT_COUNT,
    });
    const serialised = JSON.stringify(summary);

    // The rollup is prompted to a model stage (AAP 0.5.2). The fixture's
    // error stack, its message and its hook-state previews are all present in
    // the events and must be absent from this object — asserted on the
    // serialised payload, because that is what actually leaves the process.
    for (const text of FIXTURE_TEXT_THE_SUMMARY_MUST_NOT_CARRY) {
      expect(serialised).not.toContain(text);
    }
  });

  it('embeds the committed commit snapshot as the component tree when asked', () => {
    const summary = computeCaptureSummary(captureBatchEvents(), fixtureContext(), {
      includeComponentTree: true,
    });
    const tree = summary.componentTree;
    if (tree === undefined) {
      throw new Error('the summary embedded no component tree');
    }

    expect(tree.origin).toBe('commit-snapshot');
    expect(tree.degraded).toBe(false);
    expect(tree.truncated).toBe(false);
    expect(tree.traceId).toBe(FIXTURE_TRACE_ID);
    // The structure comes from the LAST commit in the capture, which is the
    // only one of the fixture's two that carries a `componentTree` attribute.
    expect(tree.capturedAt).toBe(1_789_812_901_218.06);
    expect(tree.commitEventId).toBe('evt_n6t0v4y8c2f6h0jq');
    expect(tree.commitSpanId).toBe('4fa07be6152d93c8');
    expect(tree.nodeCount).toBe(FIXTURE_COMPONENT_TREE_CHAIN.length);
    expect(tree.maxDepth).toBe(FIXTURE_COMPONENT_TREE_CHAIN.length - 1);

    // The fixture's tree is a single chain, walked here rather than compared
    // as one literal so a wrong nesting is reported at the node it starts at.
    let level = tree.roots;
    for (const expected of FIXTURE_COMPONENT_TREE_CHAIN) {
      expect(level).toHaveLength(1);
      const node = rowAt(level, 0, `componentTree depth ${String(expected.depth)}`);

      expect(node.id).toBe(expected.id);
      expect(node.component).toBe(expected.component);
      expect(node.key).toBe(expected.key);
      expect(node.depth).toBe(expected.depth);
      expect(node.renderCount).toBe(expected.renderCount);
      expect(node.totalDurationMs).toBe(expected.totalDurationMs);
      expect(node.lastTrigger).toBe(expected.lastTrigger);
      level = node.children;
    }
    expect(level).toEqual([]);

    // Opt-in, because the tree's size is set by the page rather than by
    // `topN` and this object is broadcast over a WebSocket.
    expect('componentTree' in computeCaptureSummary(captureBatchEvents(), fixtureContext())).toBe(
      false,
    );
  });

  it('reports the clip it made at the default bound, and none at the capture size', () => {
    const events = captureBatchEvents();
    const bounded = computeCaptureSummary(events, fixtureContext());

    // Thirty events ranked into ten rows: the clip is never silent, because
    // "these are the slowest spans" and "these are ten of them" support
    // different conclusions. It never means events were dropped — every one
    // is still counted in `eventCount`, the metrics and both tallies.
    expect(bounded.topSpans).toHaveLength(DEFAULT_TOP_N);
    expect(bounded.truncated).toBe(true);
    expect(bounded.eventCount).toBe(events.length);

    const whole = computeCaptureSummary(events, fixtureContext(), { topN: events.length });
    expect(whole.topSpans).toHaveLength(events.length);
    expect(whole.topRenders).toHaveLength(FIXTURE_TOP_RENDERS.length);
    expect(whole.topRequests).toHaveLength(FIXTURE_TOP_REQUESTS.length);
    expect(whole.topQueries).toHaveLength(FIXTURE_TOP_QUERIES.length);
    expect(whole.errors).toHaveLength(1);
    expect(whole.truncated).toBe(false);
    // The clip changes which rows are published, never what was measured.
    expect(whole.metrics).toEqual([...bounded.metrics]);
  });

  it('reads no clock and mints no id, so the fixture summarises identically twice', () => {
    const first = computeCaptureSummary(captureBatchEvents(), fixtureContext(), {
      includeComponentTree: true,
    });
    const second = computeCaptureSummary(captureBatchEvents(), fixtureContext(), {
      includeComponentTree: true,
    });

    // Two processes summarising one capture must agree exactly: the service
    // caches this object, re-renders it from storage and compares it across a
    // followup (AAP 0.4.2), so every ranking tie-break has to be total.
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('is a payload the capture.stopped broadcast can carry, unchanged by a round trip', () => {
    const summary: CaptureSummary = computeCaptureSummary(captureBatchEvents(), fixtureContext(), {
      includeComponentTree: true,
      topN: FIXTURE_EVENT_COUNT,
    });

    // The real rollup of a real capture, walked for anything a JSON payload
    // cannot carry — a `Map`, a `Set`, a class instance, a cycle or an
    // `undefined` inside an array — and then round-tripped. This is the
    // object that crosses the WebSocket (AAP 0.4.2).
    expect(collectTransportViolations(summary, '$', [])).toEqual([]);
    expect(clone(summary)).toEqual(summary);
  });

  it('does not modify the fixture events it was given', () => {
    const events = captureBatchEvents();

    computeCaptureSummary(events, fixtureContext(), {
      includeComponentTree: true,
      topN: FIXTURE_EVENT_COUNT,
    });

    // The service summarises the events it is about to persist and the ones
    // it has already stored, so a rollup that mutated its input would corrupt
    // the store's copy of the capture.
    expect(events).toEqual([...CAPTURE_BATCH_EVENTS]);
  });
});
