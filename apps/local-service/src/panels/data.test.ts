/**
 * Colocated tests for `./data.ts`: the panel-data resolver.
 *
 * What is on trial is the contract this module adds on top of the store and the
 * aggregates, not the aggregates themselves — `packages/telemetry` pins those.
 * Each block exists because breaking it would make a rendered panel show
 * evidence that is wrong while looking right:
 *
 * 1. **Paging.** The defaults come from the imported constants, a large limit is
 *    clamped, `total` is counted before paging, and `nextOffset` is a number
 *    only while rows remain and `null` on the last page — the exact field set
 *    protocol's `DataPage` declares.
 * 2. **Stable order.** Every chain ends in `id`, so a multi-page walk under
 *    every sort of every paged source — `metrics` included — visits every row
 *    exactly once, in the order of one unpaged read, even when many rows tie on
 *    the sort key. Every named sort is the order answered, never replaced by
 *    the source default; the derived keys (a record's name-group size, a
 *    transition's hook-group size and event duration, a metric's measured
 *    value and vocabulary position) are checked against derivations written
 *    here from the fixtures, never by calling the resolver's own.
 * 3. **Shape.** Every one of the ten sources answers with the member of the
 *    protocol's `DataResult` union for its source — validated here with
 *    `parseDataResult` — the single-value sources carry no page, and `metrics`
 *    answers `METRIC_IDS` order when no sort is named, including an
 *    unavailable value.
 * 4. **Push-down.** Every filter field reaches the store read itself, which the
 *    fake store records, so a resolver that loaded a capture whole and filtered
 *    it afterwards fails.
 * 5. **Scope.** One capture is read — the rendered panel's, else the named one,
 *    else the open one, else the latest — never a capture of another session
 *    and never two at once; a panel whose capture was purged reads nothing.
 * 6. **Completeness.** An aggregate is computed from every event of its slice,
 *    past the 50 000 events the resolver once stopped at, each slice being one
 *    scan rather than a page walk; a slice above the ceiling, or a scan that
 *    contradicts its own count, is refused rather than answered from part of
 *    it; a summary is served only when it accounts for every stored event.
 * 7. **The trace source.** The default trace is read directly, the filter keeps
 *    matches and their ancestors, and every answer is held to the node budget.
 * 8. **The aggregate cache.** One traversal of a capture serves every
 *    aggregate source of one filter; the result is kept while the capture's
 *    generation stands — a hit reads the generation and nothing else — and
 *    recomputed as soon as it moves, keyed by filter and capture, bounded by
 *    entries and by the events read, and never holds a failure.
 * 9. **Failure, privacy and purity.** A store failure is a typed `Err`, a
 *    throwing port is `STORE_ERROR`, no captured value reaches an error or a log
 *    record, no request key is minted, the seeded events are never mutated or
 *    re-redacted, and two identical reads are deep-equal whatever the clock says.
 *
 * ## Fixture conventions
 *
 * Every port is an in-file fake implementing only the methods the module
 * declares — the five telemetry reads, the trace read, the capture and panel
 * lookups and the summary load — so nothing here opens a database, a socket or
 * a timer. The
 * store fake orders rows by the store's documented panel orderings (duration
 * descending, start ascending, or — for `count_desc` — the size of each row's
 * group under the requested group key, the key in UTF-8 byte order, then the
 * event id), and a parent-first read (`spans` under `start_asc`) parent before
 * child over start, producer, sequence and arrival, all written independently
 * of `SOURCE_SORT_KEYS` and of the store's own implementation; one assertion
 * ties the stated flat chains to the store's own `ORDER BY` clauses without
 * opening it.
 *
 * Identifiers are deterministic: minted from counters in the formats
 * `@debuggen/shared` mints (`ID_PREFIXES`, 32- and 16-character hex), with event
 * ids permuted so their order is never their creation order — which is what
 * makes the `id` tie-breaker observable. Times are explicit offsets from one
 * fractional epoch-millisecond base. Names are invented and generic — nothing
 * here names a symbol or a route of any real project (AAP §0.5.4) — and the
 * credential-shaped sentinel is assembled at run time from fragments, so the
 * tracked file holds no token literal (AAP §0.3.4).
 */

import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_SORTS,
  DATA_QUERY_SOURCES,
} from '@debuggen/panel-schema';
import type {
  DataQuery,
  DataQueryFilter,
  DataQuerySort,
  DataQuerySource,
} from '@debuggen/panel-schema';
import { dataPageSchema, dataPageShape, parseDataResult } from '@debuggen/protocol';
import type { CaptureRecord, DataResult, DataResultFor } from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  ID_PREFIXES,
  SPAN_ID_PATTERN,
  TRACE_ID_PATTERN,
  createConsoleLogger,
  err,
  ok,
  unwrap,
} from '@debuggen/shared';
import type {
  CaptureId,
  LogRecord,
  Logger,
  PanelId,
  ProducerId,
  SessionId,
  SpanId,
  TraceId,
} from '@debuggen/shared';
import {
  ERROR_KINDS,
  MAX_EPOCH_MS,
  METRIC_IDS,
  MIN_EPOCH_MS,
  RENDER_KINDS,
  STATE_KINDS,
  TELEMETRY_KINDS,
  TELEMETRY_TIERS,
  buildTraceTree,
  computeCaptureSummary,
  createTraceNode,
  isTierAllowedForKind,
  parseTelemetryEvent,
} from '@debuggen/telemetry';
import type {
  CaptureSummary,
  StateTransition,
  TelemetryEvent,
  TelemetryKind,
  TelemetryTier,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';

import {
  CANONICAL_ORDER_BY,
  PANEL_DURATION_DESC_ORDER_BY,
  PANEL_SECONDARY_ORDER_BY,
  PANEL_START_ASC_ORDER_BY,
  TELEMETRY_DEFAULT_GROUP_KEY,
  TELEMETRY_QUERY_DEFAULT_LIMIT,
  TELEMETRY_QUERY_DEFAULT_OFFSET,
  TELEMETRY_QUERY_MAX_LIMIT,
} from '../store/telemetry-repo.js';
import type { PanelCaptureLookup } from '../store/sessions-repo.js';
import type {
  CaptureEventStamp,
  CaptureGeneration,
  TelemetryGroupKey,
  TelemetryQuery,
  TelemetryScan,
  TelemetryScanFilter,
} from '../store/telemetry-repo.js';
import {
  AGGREGATE_CACHE_MAX_ENTRIES,
  AGGREGATE_CACHE_MAX_INPUT_EVENTS,
  DEFAULT_SORT_BY_SOURCE,
  MAX_AGGREGATE_INPUT_EVENTS,
  SOURCE_SORT_KEYS,
  SPAN_SOURCE_KINDS,
  TRACE_NODE_BUDGET,
  applyPage,
  buildDataPage,
  createPanelDataResolver,
  effectiveSort,
  orderRows,
  resolvePaging,
} from './data.js';
import type {
  CaptureSummaryPort,
  DerivedSortKeyName,
  PanelDataContext,
  PanelDataResolver,
  PanelDataResolverDeps,
  PanelTelemetryPort,
  PanelTracePort,
  SessionCapturePort,
  SortChain,
  SortedDataSource,
} from './data.js';

/** What one aggregate computation was handed: the aggregate, and its input event ids in order. */
interface AggregateInput {
  readonly aggregate: string;
  readonly ids: readonly string[];
}

/**
 * The recorder behind {@link recordAggregateInputs}: off unless a case turns
 * it on, so every other case runs the aggregates exactly as shipped.
 */
const aggregateInputs = vi.hoisted(() => ({
  recording: false,
  calls: [] as AggregateInput[],
}));

/**
 * `@debuggen/telemetry` with the seven aggregate computations the resolver
 * calls wrapped to record their input — and otherwise real: each wrapper
 * calls the package's own function with the same arguments and returns its
 * result. What the equality proof of the shared traversal observes.
 */
vi.mock('@debuggen/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@debuggen/telemetry')>();
  const recorded =
    <Args extends readonly [readonly { readonly id: string }[], ...unknown[]], Value>(
      aggregate: string,
      compute: (...args: Args) => Value,
    ) =>
    (...args: Args): Value => {
      if (aggregateInputs.recording) {
        aggregateInputs.calls.push({ aggregate, ids: args[0].map((event) => event.id) });
      }
      return compute(...args);
    };
  return {
    ...actual,
    aggregateRenders: recorded('renders', actual.aggregateRenders),
    buildComponentTreeSnapshot: recorded('componentTree', actual.buildComponentTreeSnapshot),
    aggregateRequests: recorded('requests', actual.aggregateRequests),
    aggregateQueries: recorded('queries', actual.aggregateQueries),
    aggregateStateTransitions: recorded('stateTransitions', actual.aggregateStateTransitions),
    buildDependencyGraph: recorded('graph', actual.buildDependencyGraph),
    computeMetrics: recorded('metrics', actual.computeMetrics),
  };
});

/**
 * Runs `work` with the aggregate recorder on, and returns every aggregate
 * computation it made, in order. Cases using it run one at a time.
 */
async function recordAggregateInputs(work: () => Promise<void>): Promise<AggregateInput[]> {
  aggregateInputs.calls.splice(0);
  aggregateInputs.recording = true;
  try {
    await work();
  } finally {
    aggregateInputs.recording = false;
  }
  return aggregateInputs.calls.splice(0);
}

/**
 * A stored capture as the capture lookups return it, read off the resolver's
 * own port so the fake answers with exactly the shape the resolver consumes.
 */
type StoredCapture = NonNullable<
  Extract<ReturnType<SessionCapturePort['getCapture']>, { readonly ok: true }>['value']
>;

/* -------------------------------------------------------------------------------------------------
 * Deterministic identities
 * ---------------------------------------------------------------------------------------------- */

/** Characters after the prefix and underscore of an opaque id, as `newId` mints it. */
const OPAQUE_SUFFIX_LENGTH = 16;

/** Hex width of a W3C trace id. */
const TRACE_ID_WIDTH = 32;

/** Hex width of a W3C span id. */
const SPAN_ID_WIDTH = 16;

/** An opaque id of the minted shape — `<prefix>_<16 base-36 characters>` — for `ordinal`. */
function opaqueId(prefix: string, ordinal: number): string {
  return `${prefix}_${ordinal.toString(36).padStart(OPAQUE_SUFFIX_LENGTH, '0')}`;
}

/** A lowercase hex id of `width` characters for `ordinal`; never all zero. */
function hexId(ordinal: number, width: number): string {
  return (ordinal + 1).toString(16).padStart(width, '0');
}

/** The trace id for `ordinal`. */
function traceIdFor(ordinal: number): TraceId {
  return hexId(ordinal, TRACE_ID_WIDTH);
}

/**
 * A prime above every event ordinal this file reaches, and a stride coprime
 * with it: `ordinal * stride mod prime` is a permutation, so event ids are
 * unique while consecutive events alternate between high and low ids.
 */
const EVENT_ID_MODULUS = 1_000_003;
const EVENT_ID_STRIDE = 500_009;

/** The event id for `ordinal`: unique, fixed-width, and not in creation order. */
function eventIdFor(ordinal: number): string {
  return opaqueId(ID_PREFIXES.event, (ordinal * EVENT_ID_STRIDE) % EVENT_ID_MODULUS);
}

/** The session most cases read. */
const SESSION_A: SessionId = opaqueId(ID_PREFIXES.session, 1);

/** A second session, for the ownership refusals. */
const SESSION_B: SessionId = opaqueId(ID_PREFIXES.session, 2);

/** The capture most fixtures belong to. */
const CAPTURE_A1: CaptureId = opaqueId(ID_PREFIXES.capture, 1);

/** A second capture of {@link SESSION_A}, whose events must never leak into a read of the first. */
const CAPTURE_A2: CaptureId = opaqueId(ID_PREFIXES.capture, 2);

/** A capture of {@link SESSION_B}. */
const CAPTURE_B1: CaptureId = opaqueId(ID_PREFIXES.capture, 3);

/** A capture id no lookup knows. */
const CAPTURE_UNKNOWN: CaptureId = opaqueId(ID_PREFIXES.capture, 99);

/** The trace most fixtures belong to. */
const TRACE_MAIN: TraceId = traceIdFor(1);

/** A second trace inside capture A1, for the trace-filter cases. */
const TRACE_OTHER: TraceId = traceIdFor(2);

/** A trace id no event carries. */
const TRACE_UNKNOWN: TraceId = traceIdFor(99);

/** The producer every fixture is emitted by. */
const PRODUCER: ProducerId = opaqueId(ID_PREFIXES.producer, 1);

/**
 * The epoch millisecond every offset in this file is measured from —
 * deliberately fractional, because event times are doubles with
 * sub-millisecond precision rather than whole milliseconds.
 */
const BASE_TIME = 1_768_000_000_000.375;

/** The whole-millisecond instant stored capture records start at. */
const CAPTURE_EPOCH = 1_768_000_000_000;

/** `offsetMs` after {@link BASE_TIME}. */
function at(offsetMs: number): number {
  return BASE_TIME + offsetMs;
}

/**
 * The value that must never reach a log record or an error payload, assembled
 * at run time so a search for any one segment catches a partial leak.
 */
const SENTINEL_SEGMENTS: readonly string[] = ['quillwort', 'marlinspike', 'gossamer'];
const SENTINEL = `${SENTINEL_SEGMENTS.join('-')}-never-log-me`;

/**
 * A credential-shaped value — three base64url segments joined by dots, the
 * shape of a signed token — assembled from fragments so no token literal is
 * tracked, and checked for with its distinctive middle segment.
 */
const SECRET_SEGMENT = ['c2VudGluZWw', 'dGhpc2lzZmFrZQ'].join('');
const SECRET_SENTINEL = [['ey', 'J'].join('') + 'hbGciOiJub25lIn0', SECRET_SEGMENT, 'ZmFrZQ'].join(
  '.',
);

/** Every fragment the privacy checks search for. */
const LEAK_MARKERS: readonly string[] = [...SENTINEL_SEGMENTS, SECRET_SEGMENT];

/* -------------------------------------------------------------------------------------------------
 * Event fixtures
 * ---------------------------------------------------------------------------------------------- */

/** Event, span, emission and arrival counters; never reset, like the store's `ingest_seq`. */
let eventOrdinal = 0;
let spanOrdinal = 0;
let seqOrdinal = 0;
let ingestOrdinal = 0;

/** The first tier of `TELEMETRY_TIERS` the kind/tier table permits for `kind`. */
function tierFor(kind: TelemetryKind): TelemetryTier {
  const tier = TELEMETRY_TIERS.find((candidate) => isTierAllowedForKind(kind, candidate));
  if (tier === undefined) {
    throw new Error(`no tier is allowed for kind ${kind}`);
  }
  return tier;
}

/** The first kind of `TELEMETRY_KINDS` the kind/tier table permits on `tier`. */
function kindOnTier(tier: TelemetryTier): TelemetryKind {
  const kind = TELEMETRY_KINDS.find((candidate) => isTierAllowedForKind(candidate, tier));
  if (kind === undefined) {
    throw new Error(`no kind is allowed on tier ${tier}`);
  }
  return kind;
}

/** The attribute path the redactor reports for a masked URL. */
const URL_REDACTION_PATH = 'attributes.url';

/** The attribute path the redactor reports for a statement whose literals it replaced. */
const STATEMENT_REDACTION_PATH = 'attributes.db.statement';

/** What a case may vary about one persisted event. */
interface EventOverrides {
  readonly id?: string;
  readonly sessionId?: SessionId;
  readonly captureId?: CaptureId;
  readonly traceId?: TraceId;
  readonly spanId?: SpanId;
  readonly parentSpanId?: SpanId;
  readonly kind?: TelemetryKind;
  readonly tier?: TelemetryTier;
  readonly name?: string;
  readonly startTime?: number;
  readonly duration?: number;
  readonly attributes?: Record<string, unknown>;
  /** The attribute paths the ingest redactor already replaced. */
  readonly redacted?: readonly string[];
}

/**
 * One persisted event with every field the store holds: fixed-width ids, a
 * kind from the vocabulary with a tier the kind/tier table allows, a
 * fractional epoch-millisecond start, a per-producer `seq` and a one-based
 * `ingestSeq`. `redacted` carries the ingest redactor's path list when the
 * fixture stands for a value that was already masked.
 */
function makeEvent(overrides: EventOverrides = {}): TelemetryEvent {
  const kind = overrides.kind ?? 'function';
  eventOrdinal += 1;
  spanOrdinal += 1;
  seqOrdinal += 1;
  ingestOrdinal += 1;
  return {
    id: overrides.id ?? eventIdFor(eventOrdinal),
    traceId: overrides.traceId ?? TRACE_MAIN,
    spanId: overrides.spanId ?? hexId(spanOrdinal, SPAN_ID_WIDTH),
    ...(overrides.parentSpanId !== undefined ? { parentSpanId: overrides.parentSpanId } : {}),
    kind,
    name: overrides.name ?? 'operation',
    startTime: overrides.startTime ?? at(1),
    duration: overrides.duration ?? 1.5,
    tier: overrides.tier ?? tierFor(kind),
    attributes: overrides.attributes ?? {},
    status: 'ok',
    producerId: PRODUCER,
    seq: seqOrdinal,
    ...(overrides.redacted !== undefined ? { redacted: [...overrides.redacted] } : {}),
    sessionId: overrides.sessionId ?? SESSION_A,
    captureId: overrides.captureId ?? CAPTURE_A1,
    ingestSeq: ingestOrdinal,
  };
}

/** A render event of `component`. */
function renderEvent(component: string, offsetMs: number, duration = 2): TelemetryEvent {
  return makeEvent({
    kind: 'render',
    name: component,
    startTime: at(offsetMs),
    duration,
    attributes: { component, phase: 'update', trigger: 'props' },
  });
}

/** A browser request carrying the ingest-assigned grouping key and an already-masked URL. */
function requestEvent(
  requestKey: string,
  url: string,
  offsetMs: number,
  duration = 5,
): TelemetryEvent {
  return makeEvent({
    kind: 'fetch',
    name: 'GET',
    startTime: at(offsetMs),
    duration,
    attributes: { 'http.method': 'GET', url, 'http.status_code': 200, request_key: requestKey },
    redacted: [URL_REDACTION_PATH],
  });
}

/** A database statement execution, its literals already replaced by placeholders. */
function queryEvent(statement: string, offsetMs: number, duration = 3): TelemetryEvent {
  return makeEvent({
    kind: 'db.query',
    name: 'SELECT',
    startTime: at(offsetMs),
    duration,
    attributes: { 'db.system': 'postgresql', 'db.statement': statement },
    redacted: [STATEMENT_REDACTION_PATH],
  });
}

/** A hook state transition of `component`, attributed to `triggerEventId` when given. */
function stateEvent(component: string, offsetMs: number, triggerEventId?: string): TelemetryEvent {
  return makeEvent({
    kind: 'state',
    name: 'state',
    startTime: at(offsetMs),
    duration: 0,
    attributes: {
      component,
      hookIndex: 0,
      previousValue: { type: 'number', preview: '1', truncated: false },
      nextValue: { type: 'number', preview: '2', truncated: false },
      ...(triggerEventId !== undefined ? { triggerEventId } : {}),
    },
  });
}

/** Freezes `value` and everything reachable from it, so any write by the resolver throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

/* -------------------------------------------------------------------------------------------------
 * Fakes
 * ---------------------------------------------------------------------------------------------- */

/** Code-unit order, as the store's `BINARY` collation compares ids. */
function byCodeUnit(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Start ascending, then id: the order traces are listed and trace nodes are laid out in. */
function byStartThenId(left: TelemetryEvent, right: TelemetryEvent): number {
  return left.startTime - right.startTime || byCodeUnit(left.id, right.id);
}

/** UTF-8 byte order: how the store's `BINARY` collation compares a text key. */
function byUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** An attribute's value when it is text, and `undefined` otherwise. */
function textAttribute(event: TelemetryEvent, key: string): string | undefined {
  const value = event.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Each group key's value on one event, as the store evaluates it: the event's
 * own column, or a text attribute, and `undefined` — SQL `NULL` — for an event
 * that belongs to no group under the key.
 */
const GROUP_KEY_VALUE: Readonly<
  Record<TelemetryGroupKey, (event: TelemetryEvent) => string | undefined>
> = Object.freeze({
  name: (event) => event.name,
  kind: (event) => event.kind,
  traceId: (event) => event.traceId,
  requestKey: (event) => textAttribute(event, 'request_key'),
  component: (event) => textAttribute(event, 'component'),
});

/**
 * The store's panel orderings over one filtered selection, written
 * independently of `SOURCE_SORT_KEYS`: duration descending or start ascending,
 * each broken by the event id; and `count_desc` as the store's
 * `COUNT(key) OVER (PARTITION BY key) DESC, key ASC, id ASC` under `groupBy` —
 * the size of each row's group within the selection (zero for a row in no
 * group, which therefore follows every group), the key in UTF-8 byte order
 * (`NULL` first, as SQLite sorts it ascending), then the event id.
 */
function storeOrder(
  sort: TelemetryQuery['sort'],
  selection: readonly TelemetryEvent[],
  groupBy: TelemetryGroupKey,
): (left: TelemetryEvent, right: TelemetryEvent) => number {
  if (sort === 'duration_desc') {
    return (left, right) => right.duration - left.duration || byCodeUnit(left.id, right.id);
  }
  if (sort === 'count_desc') {
    const keyOf = GROUP_KEY_VALUE[groupBy];
    const sizes = new Map<string, number>();
    for (const event of selection) {
      const key = keyOf(event);
      if (key !== undefined) {
        sizes.set(key, (sizes.get(key) ?? 0) + 1);
      }
    }
    const sizeOf = (event: TelemetryEvent): number => {
      const key = keyOf(event);
      return key === undefined ? 0 : (sizes.get(key) ?? 0);
    };
    const byKey = (left: string | undefined, right: string | undefined): number => {
      if (left === right) {
        return 0;
      }
      if (left === undefined) {
        return -1;
      }
      return right === undefined ? 1 : byUtf8Bytes(left, right);
    };
    return (left, right) =>
      sizeOf(right) - sizeOf(left) ||
      byKey(keyOf(left), keyOf(right)) ||
      byCodeUnit(left.id, right.id);
  }
  return byStartThenId;
}

/**
 * The store's flat canonical chain (`CANONICAL_ORDER_BY`), written
 * independently of the correlator's comparator: start ascending, the producer
 * id in UTF-8 byte order, the producer's sequence number, then the arrival
 * number — always distinct, so the chain is total.
 */
function byFlatCanonical(left: TelemetryEvent, right: TelemetryEvent): number {
  return (
    left.startTime - right.startTime ||
    byUtf8Bytes(left.producerId, right.producerId) ||
    left.seq - right.seq ||
    left.ingestSeq - right.ingestSeq
  );
}

/**
 * A selection in the canonical parent-first order a parent-first store page
 * (`TelemetryQuery.parentFirst`) answers, derived independently of the
 * store's `parentFirstOrder`: repeatedly take the earliest row, in
 * {@link byFlatCanonical} order, whose parent — the earliest row of its trace
 * carrying the span id it names, the row itself excepted — has been taken or
 * is not in the selection; when no row qualifies (a parent cycle), the
 * earliest row left. Naive and quadratic, as the rule reads.
 */
function parentFirstSelection(selection: readonly TelemetryEvent[]): TelemetryEvent[] {
  const flat = [...selection].sort(byFlatCanonical);
  const parentOf = (event: TelemetryEvent): TelemetryEvent | undefined => {
    if (event.parentSpanId === undefined) {
      return undefined;
    }
    const parent = flat.find(
      (candidate) => candidate.traceId === event.traceId && candidate.spanId === event.parentSpanId,
    );
    return parent === event ? undefined : parent;
  };
  const taken = new Set<TelemetryEvent>();
  const ordered: TelemetryEvent[] = [];
  while (ordered.length < flat.length) {
    const next =
      flat.find((event) => {
        const parent = parentOf(event);
        return !taken.has(event) && (parent === undefined || taken.has(parent));
      }) ?? flat.find((event) => !taken.has(event));
    if (next === undefined) {
      break;
    }
    taken.add(next);
    ordered.push(next);
  }
  return ordered;
}

/** Whether `event` matches every narrowing field a store read — a page or a scan — carries. */
function matchesQuery(event: TelemetryEvent, query: TelemetryScanFilter): boolean {
  return (
    event.sessionId === query.sessionId &&
    (query.captureId === undefined || event.captureId === query.captureId) &&
    (query.traceId === undefined || event.traceId === query.traceId) &&
    (query.kinds === undefined || query.kinds.includes(event.kind)) &&
    (query.tiers === undefined || query.tiers.includes(event.tier)) &&
    (query.tier === undefined || event.tier === query.tier) &&
    (query.minDuration === undefined || event.duration >= query.minDuration) &&
    (query.component === undefined || event.attributes['component'] === query.component) &&
    (query.requestKey === undefined || event.attributes['request_key'] === query.requestKey)
  );
}

/** One recorded capture-scoped lookup: `firstTraceId`, `captureStamp` or `captureGeneration`. */
interface ScopeCall {
  readonly sessionId: SessionId;
  readonly captureId: CaptureId | undefined;
}

/** One recorded `scanEvents` call: the filter exactly as the resolver sent it, and its row budget. */
type ScanCall = TelemetryScanFilter & { readonly maxRows: number };

/** The store's read port over an event list, recording every read it serves. */
interface FakeTelemetryRepo extends PanelTelemetryPort {
  /** Every `query` call, in order, exactly as the resolver sent it: the page reads. */
  readonly calls: readonly TelemetryQuery[];
  /** Every `scanEvents` call, in order: the whole-slice reads. */
  readonly scans: readonly ScanCall[];
  /** Every `firstTraceId` call, in order. */
  readonly firstTraceCalls: readonly ScopeCall[];
  /** Every `captureStamp` call, in order. */
  readonly stampCalls: readonly ScopeCall[];
  /** Every `captureGeneration` call, in order. */
  readonly generationCalls: readonly ScopeCall[];
}

/** The stamp the real store computes: the capture's row count and highest `ingestSeq`. */
function stampOf(members: readonly TelemetryEvent[]): CaptureEventStamp {
  return {
    count: members.length,
    maxIngestSeq: members.reduce((highest, event) => Math.max(highest, event.ingestSeq), 0),
  };
}

/**
 * A generation that moves whenever the capture's rows change, as the real
 * store's does: an arrival raises the highest `ingestSeq`, a removal lowers
 * the count. Compared for equality only, like the real one.
 */
function generationOf(members: readonly TelemetryEvent[]): CaptureGeneration {
  const stamp = stampOf(members);
  return { dataVersion: 0, purges: stamp.count, writes: stamp.maxIngestSeq };
}

/**
 * The scan contract of `TelemetryRepo.scanEvents` over an already-filtered,
 * capture-ordered selection: every row when it fits `maxRows`, and otherwise
 * no row and the count that exceeded the budget. The selection is handed back
 * as it is, so a case may pass a frozen array and see any write to it throw.
 */
function scanOf(selection: TelemetryEvent[], maxRows: number): TelemetryScan {
  return selection.length > maxRows
    ? { rows: [], total: selection.length, complete: false }
    : { rows: selection, total: selection.length, complete: true };
}

/**
 * A store over an event list, read afresh on every call so a case may append
 * to it between two reads, as ingest would.
 *
 * It honours every narrowing field, all three panel orderings — `count_desc`
 * ranking rows by their group under `groupBy`, the store's default key
 * (`TELEMETRY_DEFAULT_GROUP_KEY`) when none is named — the parent-first order
 * a `parentFirst` read asks for ({@link parentFirstSelection}), the store's own
 * default and ceiling for `limit`, and `offset`; its page omits `nextOffset` on the
 * last page, as the real store's does. Its scan
 * is the whole selection in `start_time ASC, id ASC` order within the row
 * budget and nothing but the count past it. Its earliest trace is the trace of
 * the capture's earliest event, a tie at that instant going to the event that
 * arrived first (the lower `ingestSeq`); its stamp is the capture's count and
 * highest `ingestSeq`; its generation moves with either — each as the real
 * store defines them.
 */
function createFakeTelemetryRepo(events: readonly TelemetryEvent[]): FakeTelemetryRepo {
  const calls: TelemetryQuery[] = [];
  const scans: ScanCall[] = [];
  const firstTraceCalls: ScopeCall[] = [];
  const stampCalls: ScopeCall[] = [];
  const generationCalls: ScopeCall[] = [];
  return {
    calls,
    scans,
    firstTraceCalls,
    stampCalls,
    generationCalls,
    firstTraceId(sessionId, captureId) {
      firstTraceCalls.push({ sessionId, captureId });
      const [earliest] = eventsInScope(events, sessionId, captureId).sort(
        (left, right) => left.startTime - right.startTime || left.ingestSeq - right.ingestSeq,
      );
      return ok(earliest?.traceId);
    },
    captureStamp(sessionId, captureId) {
      stampCalls.push({ sessionId, captureId });
      return ok(stampOf(eventsInScope(events, sessionId, captureId)));
    },
    captureGeneration(sessionId, captureId) {
      generationCalls.push({ sessionId, captureId });
      return ok(generationOf(eventsInScope(events, sessionId, captureId)));
    },
    scanEvents(filter, maxRows) {
      scans.push(Object.freeze({ ...filter, maxRows }));
      const selection = events.filter((event) => matchesQuery(event, filter)).sort(byStartThenId);
      return ok(scanOf(selection, maxRows));
    },
    query(query) {
      calls.push(Object.freeze({ ...query }));
      const offset = query.offset ?? TELEMETRY_QUERY_DEFAULT_OFFSET;
      const limit = Math.min(
        query.limit ?? TELEMETRY_QUERY_DEFAULT_LIMIT,
        TELEMETRY_QUERY_MAX_LIMIT,
      );
      const selection = events.filter((event) => matchesQuery(event, query));
      const rows =
        query.parentFirst === true
          ? parentFirstSelection(selection)
          : [...selection].sort(
              storeOrder(query.sort, selection, query.groupBy ?? TELEMETRY_DEFAULT_GROUP_KEY),
            );
      const page = rows.slice(offset, offset + limit);
      const following = offset + page.length;
      return ok({
        rows: page,
        total: rows.length,
        ...(page.length > 0 && following < rows.length ? { nextOffset: following } : {}),
      });
    },
  };
}

/** Every read the fake store served — its pages, then its scans — as their narrowings. */
function storeReads(store: FakeTelemetryRepo): readonly TelemetryScanFilter[] {
  return [...store.calls, ...store.scans];
}

/** One recorded trace read. */
interface CorrelatorCall {
  readonly method: 'getTrace';
  readonly sessionId: SessionId;
  readonly traceId: TraceId;
  readonly captureId: CaptureId | undefined;
}

/** How a fake port misbehaves, when a case asks it to. */
type PortFailure = 'refuse' | 'throw';

/** The trace reads over a fixed event list, recording every read it serves. */
interface FakeTraceCorrelator extends PanelTracePort {
  /** Every trace read, in order. */
  readonly calls: readonly CorrelatorCall[];
}

/** The events of `sessionId`, narrowed to `captureId` when one is given. */
function eventsInScope(
  events: readonly TelemetryEvent[],
  sessionId: SessionId,
  captureId: CaptureId | undefined,
): TelemetryEvent[] {
  return events.filter(
    (event) =>
      event.sessionId === sessionId && (captureId === undefined || event.captureId === captureId),
  );
}

/**
 * A small synthetic tree over one trace's events: each event under the event
 * whose span it names as parent, the rest as roots, siblings by start then id.
 */
function syntheticTrace(traceId: TraceId, members: readonly TelemetryEvent[]): TraceTree {
  const spanIds = new Set(members.map((event) => event.spanId));
  const nodeFor = (event: TelemetryEvent, depth: number): TraceNode => {
    const children =
      depth >= members.length
        ? []
        : members
            .filter((child) => child !== event && child.parentSpanId === event.spanId)
            .sort(byStartThenId)
            .map((child) => nodeFor(child, depth + 1));
    return createTraceNode(event, children, depth);
  };
  const roots = members
    .filter((event) => event.parentSpanId === undefined || !spanIds.has(event.parentSpanId))
    .sort(byStartThenId)
    .map((event) => nodeFor(event, 0));
  return buildTraceTree(traceId, roots);
}

/**
 * Trace reads over an event list: a synthetic tree per trace, scoped by session
 * and capture like the real correlator. `failure` makes the read refuse, or
 * throw the sentinel.
 */
function createFakeTraceCorrelator(
  events: readonly TelemetryEvent[],
  failure?: PortFailure,
): FakeTraceCorrelator {
  const calls: CorrelatorCall[] = [];
  const refusal = (): DebuggenError =>
    new DebuggenError('STORE_ERROR', 'The fake correlator refused the read.');
  return {
    calls,
    getTrace(sessionId, traceId, captureId) {
      calls.push({ method: 'getTrace', sessionId, traceId, captureId });
      if (failure === 'throw') {
        throw new Error(SENTINEL);
      }
      if (failure === 'refuse') {
        return Promise.resolve(err(refusal()));
      }
      const members = eventsInScope(events, sessionId, captureId).filter(
        (event) => event.traceId === traceId,
      );
      return Promise.resolve(
        ok(members.length === 0 ? undefined : syntheticTrace(traceId, members)),
      );
    },
  };
}

/** A stored capture of `sessionId`, open unless `stopped`. */
function storedCapture(
  sessionId: SessionId,
  captureId: CaptureId,
  options: {
    readonly startedAt?: number;
    readonly stopped?: boolean;
    readonly summary?: CaptureSummary;
  } = {},
): StoredCapture {
  const startedAt = options.startedAt ?? CAPTURE_EPOCH;
  const capture: CaptureRecord = {
    id: captureId,
    planVersion: 1,
    startedAt,
    ...(options.stopped === true ? { stoppedAt: startedAt + 1_000 } : {}),
    ...(options.summary !== undefined ? { summary: options.summary } : {}),
  };
  return { sessionId, capture };
}

/** A stored panel row as the panel lookup reads it: its session and the capture it links. */
interface StoredPanelLink {
  readonly panelId: PanelId;
  readonly sessionId: SessionId;
  /** The linked capture; absent once the capture has been purged. */
  readonly captureId?: CaptureId;
}

/** The panel every panel-bound case renders. */
const PANEL_A1: PanelId = opaqueId(ID_PREFIXES.panel, 1);

/** A panel of {@link SESSION_A} whose capture has been purged. */
const PANEL_PURGED: PanelId = opaqueId(ID_PREFIXES.panel, 2);

/** A panel of {@link SESSION_B}. */
const PANEL_B1: PanelId = opaqueId(ID_PREFIXES.panel, 3);

/** The panel rows the panel-bound cases know. */
const PANEL_LINKS: readonly StoredPanelLink[] = Object.freeze([
  { panelId: PANEL_A1, sessionId: SESSION_A, captureId: CAPTURE_A1 },
  { panelId: PANEL_PURGED, sessionId: SESSION_A },
  { panelId: PANEL_B1, sessionId: SESSION_B, captureId: CAPTURE_B1 },
]);

/** How many times each capture lookup was asked. */
interface LookupCounts {
  getCapture: number;
  getActiveCapture: number;
  getLatestCapture: number;
  getPanelCapture: number;
}

/**
 * Capture and panel lookups over fixed lists, captures oldest first. The latest
 * capture is the one started last, a later entry winning a tie — the real
 * repository's `started_at DESC, rowid DESC` — and a panel is found only in its
 * own session, as the real join is scoped. `counts` records every lookup.
 */
function sessionsPort(
  captures: readonly StoredCapture[],
  panels: readonly StoredPanelLink[] = PANEL_LINKS,
  counts?: LookupCounts,
): SessionCapturePort {
  return {
    getCapture: (captureId) => {
      if (counts !== undefined) {
        counts.getCapture += 1;
      }
      return ok(captures.find((stored) => stored.capture.id === captureId));
    },
    getActiveCapture: (sessionId) => {
      if (counts !== undefined) {
        counts.getActiveCapture += 1;
      }
      return ok(
        captures.find(
          (stored) => stored.sessionId === sessionId && stored.capture.stoppedAt === undefined,
        ),
      );
    },
    getLatestCapture: (sessionId) => {
      if (counts !== undefined) {
        counts.getLatestCapture += 1;
      }
      let latest: StoredCapture | undefined;
      for (const stored of captures) {
        if (
          stored.sessionId === sessionId &&
          (latest === undefined || stored.capture.startedAt >= latest.capture.startedAt)
        ) {
          latest = stored;
        }
      }
      return ok(latest);
    },
    getPanelCapture: (sessionId, panelId) => {
      if (counts !== undefined) {
        counts.getPanelCapture += 1;
      }
      const panel = panels.find(
        (candidate) => candidate.panelId === panelId && candidate.sessionId === sessionId,
      );
      const lookup: PanelCaptureLookup =
        panel === undefined
          ? { panel: 'unknown' }
          : {
              panel: 'found',
              capture:
                panel.captureId === undefined
                  ? undefined
                  : captures.find((stored) => stored.capture.id === panel.captureId),
            };
      return ok(lookup);
    },
  };
}

/** Lookup counts, all zero. */
function lookupCounts(): LookupCounts {
  return { getCapture: 0, getActiveCapture: 0, getLatestCapture: 0, getPanelCapture: 0 };
}

/** The captures every harness knows unless a case supplies its own. */
function defaultCaptures(): StoredCapture[] {
  return [
    storedCapture(SESSION_A, CAPTURE_A1, { stopped: true }),
    storedCapture(SESSION_A, CAPTURE_A2, { startedAt: CAPTURE_EPOCH + 5_000, stopped: true }),
    storedCapture(SESSION_B, CAPTURE_B1, { stopped: true }),
  ];
}

/** A resolver over fakes, with every log record kept for the privacy checks. */
interface Harness {
  readonly resolver: PanelDataResolver;
  readonly store: FakeTelemetryRepo;
  readonly correlator: FakeTraceCorrelator;
  readonly records: LogRecord[];
}

/** What a harness may replace. */
interface HarnessOptions {
  readonly captures?: readonly StoredCapture[];
  /** The panel rows the panel lookup knows; {@link PANEL_LINKS} unless given. */
  readonly panels?: readonly StoredPanelLink[];
  /** Where the default lookups count their calls. */
  readonly lookups?: LookupCounts;
  readonly withoutSessions?: boolean;
  readonly sessions?: SessionCapturePort;
  readonly summaries?: CaptureSummaryPort;
  readonly telemetry?: PanelTelemetryPort;
  readonly correlatorFailure?: PortFailure;
  readonly now?: () => number;
}

/** Builds a resolver over `events` and the given lookups. */
function harness(events: readonly TelemetryEvent[], options: HarnessOptions = {}): Harness {
  const records: LogRecord[] = [];
  const logger: Logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });
  const store = createFakeTelemetryRepo(events);
  const correlator = createFakeTraceCorrelator(events, options.correlatorFailure);
  const sessions =
    options.sessions ??
    (options.withoutSessions === true
      ? undefined
      : sessionsPort(options.captures ?? defaultCaptures(), options.panels, options.lookups));
  const deps: PanelDataResolverDeps = {
    telemetry: options.telemetry ?? store,
    correlator,
    sessions,
    captures: options.summaries,
    logger,
    now: options.now ?? (() => BASE_TIME),
  };
  return { resolver: createPanelDataResolver(deps), store, correlator, records };
}

/** The context most cases read: session A, capture A1. */
const CONTEXT_A1 = Object.freeze({ sessionId: SESSION_A, captureId: CAPTURE_A1 });

/** Resolves, validates the answer against the protocol, and fails the test on a refusal. */
async function resolved(
  resolver: PanelDataResolver,
  query: DataQuery,
  context: PanelDataContext = CONTEXT_A1,
): Promise<DataResult> {
  const result = await resolver.resolve(context, query);
  if (!result.ok) {
    throw new Error(`expected a result, got ${result.error.code}: ${result.error.message}`);
  }
  expect(parseDataResult(JSON.parse(JSON.stringify(result.value))).ok).toBe(true);
  return result.value;
}

/** Resolves, and fails the test unless the resolver answered with a typed error. */
async function refused(
  resolver: PanelDataResolver,
  query: DataQuery,
  context: PanelDataContext = CONTEXT_A1,
): Promise<DebuggenError> {
  const result = await resolver.resolve(context, query);
  if (result.ok) {
    throw new Error(`expected a refusal, got a ${result.value.source} result`);
  }
  expect(DebuggenError.is(result.error)).toBe(true);
  expect(DEBUGGEN_ERROR_CODES).toContain(result.error.code);
  return result.error;
}

/** The rows of a paged result, in order. */
function rowsOf(result: DataResult): readonly { readonly id: string }[] {
  switch (result.source) {
    case 'spans':
      return result.spans;
    case 'events':
      return result.events;
    case 'renders':
      return result.renders;
    case 'requests':
      return result.requests;
    case 'queries':
      return result.queries;
    case 'stateTransitions':
      return result.stateTransitions;
    case 'metrics':
      return result.metrics;
    case 'trace':
    case 'componentTree':
    case 'graph':
      throw new Error(`source ${result.source} is not paged`);
  }
}

/** The ids of a paged result's rows, in order. */
function rowIds(result: DataResult): string[] {
  return rowsOf(result).map((row) => row.id);
}

/** The values of a `metrics` result, in order; any other result is a test bug. */
function metricsOf(result: DataResult): DataResultFor<'metrics'>['metrics'] {
  if (result.source !== 'metrics') {
    throw new Error(`expected a metrics result, got ${result.source}`);
  }
  return result.metrics;
}

/** What a page walk saw. */
interface PageWalk {
  readonly ids: string[];
  readonly totals: number[];
  readonly pages: number;
}

/**
 * Walks every page of a query, `pageSize` at a time, by following `nextOffset`
 * until it is `null`, and returns every row id seen. Each page's echo is
 * checked on the way: the applied limit and offset, and a `nextOffset` equal
 * to the offset plus the page length whenever it is a number.
 */
async function walkAll(
  resolver: PanelDataResolver,
  query: DataQuery,
  pageSize: number,
): Promise<PageWalk> {
  const ids: string[] = [];
  const totals: number[] = [];
  let offset: number | null = DATA_QUERY_DEFAULT_OFFSET;
  let pages = 0;
  while (offset !== null) {
    pages += 1;
    if (pages > 1_000) {
      throw new Error('the page walk did not terminate');
    }
    const result = await resolved(resolver, { ...query, limit: pageSize, offset });
    if (!('total' in result)) {
      throw new Error(`source ${result.source} is not paged`);
    }
    const pageIds = rowIds(result);
    ids.push(...pageIds);
    totals.push(result.total);
    expect(result.limit).toBe(pageSize);
    expect(result.offset).toBe(offset);
    expect(pageIds.length).toBeLessThanOrEqual(pageSize);
    if (result.nextOffset !== null) {
      expect(pageIds.length).toBeGreaterThan(0);
      expect(result.nextOffset).toBe(offset + pageIds.length);
    }
    offset = result.nextOffset;
  }
  return { ids, totals, pages };
}

/** Everything a value serialises to, for the privacy checks. */
function textOf(value: unknown): string {
  return JSON.stringify(value) ?? '';
}

/** Every text an error could carry anywhere it travels. */
function errorTexts(error: DebuggenError): string {
  return textOf({
    code: error.code,
    message: error.message,
    hint: error.hint,
    details: error.details,
    payload: error.toPayload(),
    own: { ...error },
  });
}

/** Asserts no leak marker occurs in `text`. */
function expectNoLeak(text: string): void {
  for (const marker of LEAK_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

/* -------------------------------------------------------------------------------------------------
 * Ordering helpers, independent of `orderRows`
 * ---------------------------------------------------------------------------------------------- */

/** How a key compares strings, as the resolver's chains declare it. */
type Collation = 'utf16' | 'utf8' | 'natural';

/**
 * One token of a string read in natural order, as this file reads it: a whole
 * run of ASCII digits with the number it writes, or one code point folded to
 * lower case where its lower case is a single code point.
 */
type NaturalToken =
  | { readonly digits: true; readonly value: bigint; readonly first: number }
  | { readonly digits: false; readonly folded: number };

/**
 * A string's natural-order tokens, found with a regular expression and
 * `BigInt` rather than by the resolver's scanning — an independent reading of
 * the `natural` collation, which the resolver's own comparator is held to.
 */
function naturalTokens(text: string): NaturalToken[] {
  return (text.match(/[0-9]+|[\s\S]/gu) ?? []).map((token): NaturalToken => {
    if (/^[0-9]+$/u.test(token)) {
      return { digits: true, value: BigInt(token), first: token.codePointAt(0) ?? 0 };
    }
    const points = [...token.toLowerCase()];
    const [only] = points;
    const folded = points.length === 1 && only !== undefined ? only : token;
    return { digits: false, folded: folded.codePointAt(0) ?? 0 };
  });
}

/** The code point a token ranks by against a token of the other kind: a run's first digit. */
function tokenCodePoint(token: NaturalToken): number {
  return token.digits ? token.first : token.folded;
}

/**
 * Natural order, read independently: digit runs by value, everything else by
 * folded code point, a string that runs out first ahead, and code-unit order
 * between strings natural order leaves equal.
 */
function byNaturalOrder(left: string, right: string): number {
  const leftTokens = naturalTokens(left);
  const rightTokens = naturalTokens(right);
  const shared = Math.min(leftTokens.length, rightTokens.length);
  for (let index = 0; index < shared; index += 1) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    if (leftToken === undefined || rightToken === undefined) {
      throw new Error('a token vanished');
    }
    if (leftToken.digits && rightToken.digits) {
      if (leftToken.value !== rightToken.value) {
        return leftToken.value < rightToken.value ? -1 : 1;
      }
      continue;
    }
    const leftPoint = tokenCodePoint(leftToken);
    const rightPoint = tokenCodePoint(rightToken);
    if (leftPoint !== rightPoint) {
      return leftPoint < rightPoint ? -1 : 1;
    }
  }
  if (leftTokens.length !== rightTokens.length) {
    return leftTokens.length < rightTokens.length ? -1 : 1;
  }
  return byCodeUnit(left, right);
}

/**
 * One key of a chain read generically, whatever the row type: a field of the
 * row, or a value derived for the sort, named from the resolver's closed
 * vocabulary. The derivation itself is never read from the chain.
 */
type GenericKey =
  | {
      readonly field: string;
      readonly direction: 'asc' | 'desc';
      readonly collation?: Collation;
    }
  | {
      readonly derived: DerivedSortKeyName;
      readonly direction: 'asc' | 'desc';
      readonly collation?: Collation;
    };

/** A chain read generically. */
type GenericChain = readonly GenericKey[];

/** The declared chain of `sort` on `source`: every source declares one for every sort. */
function chainFor(source: SortedDataSource, sort: DataQuerySort): GenericChain {
  const chains: Readonly<Record<DataQuerySort, GenericChain>> = SOURCE_SORT_KEYS[source];
  return chains[sort];
}

/** One field of a row, read by name. */
function fieldOf(row: object, field: string): unknown {
  return (row as Readonly<Record<string, unknown>>)[field];
}

/**
 * Numbers numerically; strings by code unit, by UTF-8 bytes under the `utf8`
 * collation, or in natural order under the `natural` one; any other value is a
 * fixture bug.
 */
function compareField(left: unknown, right: unknown, collation: Collation = 'utf16'): number {
  if (typeof left === 'number' && typeof right === 'number') {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    if (collation === 'utf8') {
      return byUtf8Bytes(left, right);
    }
    return collation === 'natural' ? byNaturalOrder(left, right) : byCodeUnit(left, right);
  }
  throw new Error('a chain key holds a value that is neither a number nor a string');
}

/** A derived value per row, or `undefined` where the row has none. */
type DerivedValues = readonly (number | string | undefined)[];

/** Whether two transition rows name the same hook: the same component and the same hook index. */
function sameHook(left: object, right: object): boolean {
  return (
    fieldOf(left, 'component') === fieldOf(right, 'component') &&
    fieldOf(left, 'hookIndex') === fieldOf(right, 'hookIndex')
  );
}

/** Whether a transition row names neither half of a hook: it belongs to no hook group. */
function namesNoHook(row: object): boolean {
  return fieldOf(row, 'component') === undefined && fieldOf(row, 'hookIndex') === undefined;
}

/** A metric row's measured value when it is available in `unit`, and `undefined` otherwise. */
function measuredValueIn(row: object, unit: string): number | undefined {
  const value = fieldOf(row, 'value');
  return fieldOf(row, 'available') === true &&
    fieldOf(row, 'unit') === unit &&
    typeof value === 'number'
    ? value
    : undefined;
}

/**
 * Every derived key the resolver's chains may name, derived here from the
 * rows of one whole answer and the events the case seeded — by counting,
 * filtering and looking up in the fixture, never by calling the resolver's
 * own derivations. The table is total over the resolver's vocabulary, so a
 * derived key added there fails this file's compilation until it is derived
 * here as well.
 */
const INDEPENDENT_DERIVATIONS: Readonly<
  Record<
    DerivedSortKeyName,
    (rows: readonly object[], seeded: readonly TelemetryEvent[]) => DerivedValues
  >
> = Object.freeze({
  parentFirstRank: (rows, seeded) => {
    // Each row's position when the answer's own events are put parent first:
    // the lineage is the answer's, so a parent the filter left out is absent.
    const order = parentFirstSelection(
      seeded.filter((event) => rows.some((row) => fieldOf(row, 'id') === event.id)),
    );
    return rows.map((row) => {
      const position = order.findIndex((event) => event.id === fieldOf(row, 'id'));
      return position === -1 ? undefined : position;
    });
  },
  nameGroupSize: (rows) =>
    rows.map(
      (row) => rows.filter((other) => fieldOf(other, 'name') === fieldOf(row, 'name')).length,
    ),
  hookGroupSize: (rows) =>
    rows.map((row) =>
      namesNoHook(row) ? undefined : rows.filter((other) => sameHook(other, row)).length,
    ),
  hookComponent: (rows) =>
    rows.map((row) => {
      const component = fieldOf(row, 'component');
      return typeof component === 'string' ? component : undefined;
    }),
  hookIndex: (rows) =>
    rows.map((row) => {
      const hookIndex = fieldOf(row, 'hookIndex');
      return typeof hookIndex === 'number' ? hookIndex : undefined;
    }),
  eventDuration: (rows, seeded) =>
    rows.map((row) => seeded.find((event) => event.id === fieldOf(row, 'eventId'))?.duration),
  metricPosition: (rows) =>
    rows.map((row) => {
      const position = METRIC_IDS.findIndex((id) => id === fieldOf(row, 'id'));
      return position === -1 ? undefined : position;
    }),
  measuredMilliseconds: (rows) => rows.map((row) => measuredValueIn(row, 'milliseconds')),
  measuredCount: (rows) => rows.map((row) => measuredValueIn(row, 'count')),
});

/**
 * The comparison a chain states between two rows of one whole answer, by
 * index: every derived key evaluated over all of `rows` by
 * {@link INDEPENDENT_DERIVATIONS}, a row with a derived value ahead of every
 * row without one in either direction, and a field key read off the row.
 */
function chainComparator(
  rows: readonly object[],
  chain: GenericChain,
  seeded: readonly TelemetryEvent[],
): (left: number, right: number) => number {
  const derived = chain.map((key) =>
    'derived' in key ? INDEPENDENT_DERIVATIONS[key.derived](rows, seeded) : [],
  );
  const rowAt = (index: number): object => {
    const row = rows[index];
    if (row === undefined) {
      throw new Error(`no row at ${String(index)}`);
    }
    return row;
  };
  return (left, right) => {
    for (const [position, key] of chain.entries()) {
      let order: number;
      if ('derived' in key) {
        const values = derived[position] ?? [];
        const leftValue = values[left];
        const rightValue = values[right];
        if (leftValue === undefined || rightValue === undefined) {
          order = leftValue === rightValue ? 0 : leftValue === undefined ? 1 : -1;
        } else {
          const compared = compareField(leftValue, rightValue, key.collation);
          order = key.direction === 'desc' ? -compared : compared;
        }
      } else {
        const compared = compareField(
          fieldOf(rowAt(left), key.field),
          fieldOf(rowAt(right), key.field),
          key.collation,
        );
        order = key.direction === 'desc' ? -compared : compared;
      }
      if (order !== 0) {
        return order;
      }
    }
    return 0;
  };
}

/**
 * Asserts `rows` is in strict chain order: every adjacent pair compares below
 * zero, so no two rows tie and every tie on the sort key was broken.
 */
function expectStrictChainOrder(
  rows: readonly object[],
  chain: GenericChain,
  seeded: readonly TelemetryEvent[],
): void {
  const compare = chainComparator(rows, chain, seeded);
  for (let index = 1; index < rows.length; index += 1) {
    expect(compare(index - 1, index)).toBeLessThan(0);
  }
}

/** The sortable sources, read off the default table so no source name is restated. */
const SORTED_SOURCES = Object.keys(DEFAULT_SORT_BY_SOURCE) as SortedDataSource[];

/** One query per source, carrying nothing but the source. */
const QUERIES_BY_SOURCE: readonly DataQuery[] = DATA_QUERY_SOURCES.map((source) => ({ source }));

/** The sources computed from a slice of events rather than read page by page. */
const AGGREGATE_SOURCES: readonly DataQuerySource[] = DATA_QUERY_SOURCES.filter(
  (source) => source !== 'trace' && source !== 'spans' && source !== 'events',
);

/**
 * The aggregate sources whose slice is every kind of the capture — a query's
 * caller, a transition's trigger, a graph's participants and a metric's
 * inputs can be any record — and which therefore take the shared traversal on
 * a miss. The shared-traversal suite asserts the list.
 */
const SHARED_TRAVERSAL_SOURCES: readonly DataQuerySource[] = [
  'queries',
  'stateTransitions',
  'graph',
  'metrics',
];

/** `filter` as a query field: absent when there is none, as exact optional types require. */
function optionalFilter(filter: DataQueryFilter | undefined): {
  readonly filter?: DataQueryFilter;
} {
  return filter === undefined ? {} : { filter };
}

/* -------------------------------------------------------------------------------------------------
 * Capture fixtures
 * ---------------------------------------------------------------------------------------------- */

/**
 * A capture with many ties: twelve timed functions sharing three durations and
 * four start times, two instants that `spans` leaves out, and events of another
 * capture and another session that no read of capture A1 may return.
 */
function flatFixture(): TelemetryEvent[] {
  const work = Array.from({ length: 12 }, (_, index) =>
    makeEvent({
      kind: 'function',
      startTime: at(Math.floor(index / 3) * 10),
      duration: [5, 2, 9][index % 3] ?? 1,
      attributes: { component: index % 2 === 0 ? 'Alpha' : 'Beta' },
    }),
  );
  return [
    ...work,
    makeEvent({ kind: 'state', startTime: at(4), duration: 0 }),
    makeEvent({ kind: 'error', startTime: at(6), duration: 0 }),
    makeEvent({ kind: 'function', captureId: CAPTURE_A2, duration: 50 }),
    makeEvent({ kind: 'function', sessionId: SESSION_B, captureId: CAPTURE_B1, duration: 60 }),
  ];
}

/** Seven components, several tying on render count and on first start, plus one in capture A2. */
function renderFixture(): TelemetryEvent[] {
  const plan: readonly (readonly [string, number])[] = [
    ['Delta', 3],
    ['Alpha', 3],
    ['Echo', 1],
    ['Charlie', 3],
    ['Bravo', 2],
    ['Golf', 2],
    ['Foxtrot', 1],
  ];
  const events: TelemetryEvent[] = [];
  for (const [component, count] of plan) {
    for (let index = 0; index < count; index += 1) {
      events.push(renderEvent(component, index * 10, count));
    }
  }
  events.push(makeEvent({ kind: 'function', startTime: at(2) }));
  events.push(renderEvent('Hotel', 1));
  const other = renderEvent('Hotel', 1);
  events.push({ ...other, captureId: CAPTURE_A2 });
  return events;
}

/**
 * One capture in which every permitted sort of every sortable source ties on
 * its primary key:
 *
 * - eighteen timed functions over two durations and three start times;
 * - six components rendering 3, 3, 2, 2, 1 and 1 times at one equal per-render
 *   duration, every one first rendering at the same instant;
 * - six request groups of 3, 3, 2, 2, 1 and 1 identical requests, every group
 *   first seen at the same instant;
 * - six statement groups executed 2, 2, 2, 1, 1 and 1 times, every group
 *   first run at the same instant;
 * - one interaction and six state transitions at two instants.
 *
 * Plus one event of capture A2 and one of session B, which no read of capture
 * A1 may return.
 */
function tieFixture(): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  for (let index = 0; index < 18; index += 1) {
    events.push(
      makeEvent({
        kind: 'function',
        startTime: at(Math.floor(index / 6) * 10),
        duration: index % 3 === 1 ? 3 : 7,
      }),
    );
  }
  const renderPlan: readonly (readonly [string, number])[] = [
    ['Kilo', 3],
    ['Lima', 3],
    ['Mike', 2],
    ['November', 2],
    ['Oscar', 1],
    ['Papa', 1],
  ];
  for (const [component, count] of renderPlan) {
    for (let index = 0; index < count; index += 1) {
      events.push(renderEvent(component, 30 + index * 4, 1.25));
    }
  }
  const requestPlan: readonly (readonly [string, number])[] = [
    ['rk-a', 3],
    ['rk-b', 3],
    ['rk-c', 2],
    ['rk-d', 2],
    ['rk-e', 1],
    ['rk-f', 1],
  ];
  for (const [requestKey, count] of requestPlan) {
    for (let index = 0; index < count; index += 1) {
      events.push(requestEvent(requestKey, '/api/list?page=?', 50 + index * 2, 2.5));
    }
  }
  const queryPlan: readonly (readonly [string, number])[] = [
    ['SELECT a FROM rows WHERE id = $1', 2],
    ['SELECT b FROM rows WHERE id = $1', 2],
    ['SELECT c FROM rows WHERE id = $1', 2],
    ['SELECT d FROM rows WHERE id = $1', 1],
    ['SELECT e FROM rows WHERE id = $1', 1],
    ['SELECT f FROM rows WHERE id = $1', 1],
  ];
  for (const [statement, count] of queryPlan) {
    for (let index = 0; index < count; index += 1) {
      events.push(queryEvent(statement, 70 + index * 3, 0.75));
    }
  }
  const interaction = makeEvent({ kind: 'interaction', name: 'click', startTime: at(90) });
  events.push(interaction);
  for (const offset of [92, 94]) {
    for (const component of ['Kilo', 'Lima', 'Mike']) {
      events.push(stateEvent(component, offset, interaction.id));
    }
  }
  events.push(makeEvent({ kind: 'function', captureId: CAPTURE_A2, duration: 7 }));
  events.push(makeEvent({ kind: 'function', sessionId: SESSION_B, captureId: CAPTURE_B1 }));
  return events;
}

/** A capture-rich event set: one of everything, in capture A1. */
function everythingFixture(): TelemetryEvent[] {
  const interaction = makeEvent({ kind: 'interaction', name: 'click', startTime: at(0) });
  return [
    interaction,
    requestEvent('key-one', '/api/one', 1),
    queryEvent('SELECT value FROM rows WHERE id = $1', 2),
    renderEvent('Alpha', 3),
    makeEvent({ kind: 'commit', startTime: at(4), attributes: { phase: 'update' } }),
    stateEvent('Alpha', 5, interaction.id),
    makeEvent({ kind: 'error', startTime: at(6), duration: 0 }),
  ];
}

/** `count` timed functions in capture A1, several tying on start and duration. */
function manyEvents(count: number): TelemetryEvent[] {
  return Array.from({ length: count }, (_, index) =>
    makeEvent({ kind: 'function', startTime: at(index % 13), duration: index % 5 }),
  );
}

/** One render each of `count` distinct components in capture A1. */
function manyComponents(count: number): TelemetryEvent[] {
  return Array.from({ length: count }, (_, index) =>
    renderEvent(`Pane${String(index).padStart(4, '0')}`, index % 7, 1),
  );
}

/* -------------------------------------------------------------------------------------------------
 * The fixture builders themselves
 * ---------------------------------------------------------------------------------------------- */

describe('the fixture builders', () => {
  it('build events the persisted schema accepts, with ids of the minted widths and double epoch times', () => {
    const samples = [
      makeEvent(),
      renderEvent('Alpha', 1),
      requestEvent('key-one', '/api/one?x=?', 2),
      queryEvent('SELECT value FROM rows WHERE id = $1', 3),
      stateEvent('Alpha', 4),
      ...TELEMETRY_TIERS.map((tier) => makeEvent({ kind: kindOnTier(tier), tier })),
    ];
    for (const sample of samples) {
      expect(parseTelemetryEvent(sample).ok).toBe(true);
      expect(TRACE_ID_PATTERN.test(sample.traceId)).toBe(true);
      expect(SPAN_ID_PATTERN.test(sample.spanId)).toBe(true);
      expect(sample.id.startsWith(`${ID_PREFIXES.event}_`)).toBe(true);
      expect(sample.id).toHaveLength(ID_PREFIXES.event.length + 1 + OPAQUE_SUFFIX_LENGTH);
      expect(TELEMETRY_KINDS).toContain(sample.kind);
      expect(TELEMETRY_TIERS).toContain(sample.tier);
      expect(isTierAllowedForKind(sample.kind, sample.tier)).toBe(true);
      expect(Number.isInteger(sample.startTime)).toBe(false);
      expect(sample.startTime).toBeGreaterThanOrEqual(MIN_EPOCH_MS);
      expect(sample.startTime).toBeLessThanOrEqual(MAX_EPOCH_MS);
      expect(sample.ingestSeq).toBeGreaterThan(0);
      expect(sample.producerId).toBe(PRODUCER);
    }
    expect(requestEvent('key-one', '/api/one', 0).redacted).toStrictEqual([URL_REDACTION_PATH]);
  });

  it('mint unique event ids whose order is not their creation order', () => {
    const ids = Array.from({ length: 50 }, () => makeEvent().id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort(byCodeUnit)).not.toStrictEqual(ids);
  });

  it('build a tie fixture that ties on the primary key of every sort of every sortable source', async () => {
    const events = tieFixture();
    const { resolver } = harness(events);
    for (const source of SORTED_SOURCES) {
      for (const sort of DATA_QUERY_SORTS) {
        const [primary] = chainFor(source, sort);
        if (primary === undefined) {
          throw new Error(`the chain of ${sort} on ${source} is empty`);
        }
        expect('field' in primary && primary.field === 'id').toBe(false);
        // A metric's vocabulary position is unique by construction: under
        // `start_asc` every metric value ties on start and that position is
        // the whole answer, so it leaves no tie for the id to break.
        if ('derived' in primary && primary.derived === 'metricPosition') {
          continue;
        }
        const whole = await resolved(resolver, { source, sort, limit: DATA_QUERY_MAX_LIMIT });
        const rows = rowsOf(whole);
        // The parent-first rank is a position, unique by construction, so it
        // too leaves no tie for the id; what the fixture must tie on there is
        // the start time the rank orders ready rows by, so the canonical
        // tie-breakers behind it decide.
        if ('derived' in primary && primary.derived === 'parentFirstRank') {
          const starts = rows.map((row) => fieldOf(row, 'startTime'));
          expect(new Set(starts).size).toBeLessThan(starts.length);
          continue;
        }
        const values =
          'derived' in primary
            ? INDEPENDENT_DERIVATIONS[primary.derived](rows, events)
            : rows.map((row) => fieldOf(row, primary.field));
        expect(new Set(values).size).toBeLessThan(values.length);
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Paging primitives
 * ---------------------------------------------------------------------------------------------- */

describe('resolvePaging', () => {
  it('fills an omitted limit and offset from the imported defaults', () => {
    expect(unwrap(resolvePaging({}))).toStrictEqual({
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: DATA_QUERY_DEFAULT_OFFSET,
    });
  });

  it('clamps a limit above the ceiling instead of refusing it', () => {
    expect(unwrap(resolvePaging({ limit: DATA_QUERY_MAX_LIMIT + 1 })).limit).toBe(
      DATA_QUERY_MAX_LIMIT,
    );
    expect(unwrap(resolvePaging({ limit: DATA_QUERY_MAX_LIMIT })).limit).toBe(DATA_QUERY_MAX_LIMIT);
  });

  it('keeps an explicit zero limit and an explicit offset exactly', () => {
    expect(unwrap(resolvePaging({ limit: 0, offset: 37 }))).toStrictEqual({ limit: 0, offset: 37 });
  });

  it.each([
    ['limit', { limit: -1 }],
    ['limit', { limit: 2.5 }],
    ['limit', { limit: Number.NaN }],
    ['offset', { offset: -3 }],
    ['offset', { offset: 0.5 }],
    ['offset', { offset: Number.POSITIVE_INFINITY }],
  ] as const)(
    'refuses a %s outside its domain, naming the field and never the value',
    (field, query) => {
      const result = resolvePaging(query);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PANEL_INVALID');
        expect(DEBUGGEN_ERROR_CODES).toContain(result.error.code);
        expect(result.error.details).toStrictEqual({ field, reason: 'not-a-non-negative-integer' });
      }
    },
  );
});

describe('buildDataPage and applyPage', () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ id: `row-${String(index)}` }));

  it('counts total before paging and points at the next page while rows remain', () => {
    const { items, page } = applyPage(rows, { limit: 3, offset: 0 });
    expect(items.map((row) => row.id)).toStrictEqual(['row-0', 'row-1', 'row-2']);
    expect(page).toStrictEqual({ total: 7, limit: 3, offset: 0, nextOffset: 3 });
  });

  it('honours the offset and ends the walk with null on the last page', () => {
    const { items, page } = applyPage(rows, { limit: 3, offset: 6 });
    expect(items.map((row) => row.id)).toStrictEqual(['row-6']);
    expect(page).toStrictEqual({ total: 7, limit: 3, offset: 6, nextOffset: null });
  });

  it('answers a count-only request and an offset past the end with an empty last page', () => {
    expect(applyPage(rows, { limit: 0, offset: 0 }).page).toStrictEqual({
      total: 7,
      limit: 0,
      offset: 0,
      nextOffset: null,
    });
    expect(applyPage(rows, { limit: 3, offset: 50 })).toStrictEqual({
      items: [],
      page: { total: 7, limit: 3, offset: 50, nextOffset: null },
    });
  });

  it('carries exactly the DataPage fields: no hasMore flag and never an absent nextOffset', () => {
    const page = buildDataPage(4, { limit: 4, offset: 0 }, 4);
    expect(Object.keys(page).sort()).toStrictEqual(Object.keys(dataPageShape).sort());
    expect(page).not.toHaveProperty('hasMore');
    expect(page.nextOffset).toBeNull();
    expect(dataPageSchema.safeParse(page).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Ordering tables
 * ---------------------------------------------------------------------------------------------- */

/** The store column each flat-source chain field orders by. */
const STORE_COLUMN_BY_FIELD: Readonly<Record<string, string>> = Object.freeze({
  startTime: 'start_time',
  duration: 'duration',
  name: 'name',
  producerId: 'producer_id',
  seq: 'seq',
  ingestSeq: 'ingest_seq',
  id: 'id',
});

/**
 * The store expression each derived key of a flat-source chain stands for:
 * `nameGroupSize` is the occurrence count of the row's own `name` group, the
 * window function the store's `count_desc` ranks by under the `name` key.
 */
const STORE_EXPRESSION_BY_DERIVED: Readonly<Partial<Record<DerivedSortKeyName, string>>> =
  Object.freeze({ nameGroupSize: 'COUNT(name) OVER (PARTITION BY name)' });

/** A chain rendered as the store's `ORDER BY` clause; a key the store has no expression for fails. */
function orderByClause(chain: GenericChain): string {
  return chain
    .map((key) => {
      const expression =
        'derived' in key
          ? STORE_EXPRESSION_BY_DERIVED[key.derived]
          : STORE_COLUMN_BY_FIELD[key.field];
      if (expression === undefined) {
        throw new Error('the chain names a key the store does not order by');
      }
      return `${expression} ${key.direction.toUpperCase()}`;
    })
    .join(', ');
}

describe('SOURCE_SORT_KEYS and DEFAULT_SORT_BY_SOURCE', () => {
  it('covers exactly the paged sources, metrics included', () => {
    expect([...SORTED_SOURCES].sort()).toStrictEqual(Object.keys(SOURCE_SORT_KEYS).sort());
    for (const source of SORTED_SOURCES) {
      expect(DATA_QUERY_SOURCES).toContain(source);
    }
    expect(SORTED_SOURCES).toContain('metrics');
  });

  it('declares a chain for every sort on every sortable source', () => {
    for (const source of SORTED_SOURCES) {
      expect(Object.keys(SOURCE_SORT_KEYS[source]).sort()).toStrictEqual(
        [...DATA_QUERY_SORTS].sort(),
      );
    }
  });

  it('ends every chain in id ascending', () => {
    for (const source of SORTED_SOURCES) {
      for (const sort of DATA_QUERY_SORTS) {
        expect(chainFor(source, sort).at(-1)).toStrictEqual({ field: 'id', direction: 'asc' });
      }
    }
  });

  it('gives every source a default from the sort vocabulary, METRIC_IDS order for metrics', () => {
    for (const source of SORTED_SOURCES) {
      expect(DATA_QUERY_SORTS).toContain(DEFAULT_SORT_BY_SOURCE[source]);
    }
    expect(chainFor('metrics', DEFAULT_SORT_BY_SOURCE.metrics)).toStrictEqual([
      expect.objectContaining({ derived: 'metricPosition', direction: 'asc' }),
      { field: 'id', direction: 'asc' },
    ]);
  });

  it('states for the flat sources exactly the orderings the store applies', () => {
    // The store's `count_desc` row ordering under the `name` key, as
    // `TelemetryRepo.query` documents it: group size, the key, then the id.
    const storeOrderBy: Readonly<Record<DataQuerySort, string>> = {
      duration_desc: PANEL_DURATION_DESC_ORDER_BY,
      start_asc: PANEL_START_ASC_ORDER_BY,
      count_desc: `COUNT(name) OVER (PARTITION BY name) DESC, name ASC, ${PANEL_SECONDARY_ORDER_BY}`,
    };
    for (const source of ['spans', 'events'] as const) {
      for (const sort of DATA_QUERY_SORTS) {
        const chain = chainFor(source, sort);
        if (source === 'spans' && sort === 'start_asc') {
          // Parent before child, which no `ORDER BY` states: the store's
          // parent-first page, which ranks rows by its canonical chain — the
          // keys behind the rank — and never reaches the closing id.
          expect(chain[0]).toStrictEqual(
            expect.objectContaining({ derived: 'parentFirstRank', direction: 'asc' }),
          );
          expect(orderByClause(chain.slice(1, -1))).toBe(CANONICAL_ORDER_BY);
          expect(chain[2]).toStrictEqual({
            field: 'producerId',
            direction: 'asc',
            collation: 'utf8',
          });
          continue;
        }
        expect(orderByClause(chain)).toBe(storeOrderBy[sort]);
      }
      // The key is compared as SQLite's `BINARY` collation compares it: by UTF-8 bytes.
      expect(chainFor(source, 'count_desc')[1]).toStrictEqual({
        field: 'name',
        direction: 'asc',
        collation: 'utf8',
      });
    }
  });

  it('answers every named sort on every sortable source in that sort’s own order, never the default’s', async () => {
    const events = tieFixture();
    const { resolver } = harness(events);
    const reordered = new Set<string>();
    for (const source of SORTED_SOURCES) {
      expect(effectiveSort(source, undefined)).toBe(DEFAULT_SORT_BY_SOURCE[source]);
      const byDefault = rowsOf(await resolved(resolver, { source, limit: DATA_QUERY_MAX_LIMIT }));
      const defaultIds = byDefault.map((row) => row.id);
      for (const sort of DATA_QUERY_SORTS) {
        expect(effectiveSort(source, sort)).toBe(sort);
        const answered = await resolved(resolver, { source, sort, limit: DATA_QUERY_MAX_LIMIT });
        // The same rows, put here into the named sort's order by an
        // independent reading of its chain.
        const compare = chainComparator(byDefault, chainFor(source, sort), events);
        const expected = byDefault
          .map((_, index) => index)
          .sort(compare)
          .map((index) => byDefault[index]?.id);
        expect(rowIds(answered)).toStrictEqual(expected);
        if (!expected.every((id, index) => id === defaultIds[index])) {
          reordered.add(`${source} ${sort}`);
        }
      }
    }
    // Not vacuous: every pair a resolver substituting the source default would
    // get wrong orders this fixture differently from that default, and was
    // answered in its own order above. (`stateTransitions` under
    // `duration_desc` ties every instant of this fixture; its own case below
    // separates them.)
    for (const pair of [
      'spans count_desc',
      'events count_desc',
      'stateTransitions count_desc',
      'metrics duration_desc',
      'metrics count_desc',
    ]) {
      expect(reordered).toContain(pair);
    }
  });

  it('breaks a renders tie by the component name in natural order, and no other source’s', () => {
    for (const sort of DATA_QUERY_SORTS) {
      const chain = chainFor('renders', sort);
      expect(chain).toHaveLength(3);
      expect(chain[1]).toStrictEqual({
        field: 'component',
        direction: 'asc',
        collation: 'natural',
      });
    }
    for (const source of SORTED_SOURCES.filter((sorted) => sorted !== 'renders')) {
      for (const sort of DATA_QUERY_SORTS) {
        expect(chainFor(source, sort).some((key) => key.collation === 'natural')).toBe(false);
      }
    }
  });

  it('orders by the chain into a fresh array, breaking every tie by id', () => {
    const rows = [
      { id: 'c', weight: 1 },
      { id: 'a', weight: 2 },
      { id: 'b', weight: 1 },
      { id: 'd', weight: 2 },
    ];
    const chain: SortChain<{ id: string; weight: number }> = [
      { field: 'weight', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ];
    const ordered = orderRows(rows, chain);
    expect(ordered.map((row) => row.id)).toStrictEqual(['a', 'd', 'b', 'c']);
    expect(rows.map((row) => row.id)).toStrictEqual(['c', 'a', 'b', 'd']);
  });
});

describe('SPAN_SOURCE_KINDS', () => {
  it('is every kind except the instant groups, derived from the vocabulary', () => {
    for (const kind of TELEMETRY_KINDS) {
      const instant = ERROR_KINDS.includes(kind) || STATE_KINDS.includes(kind);
      expect(SPAN_SOURCE_KINDS.includes(kind)).toBe(!instant);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The paging contract, end to end through the resolver
 * ---------------------------------------------------------------------------------------------- */

/** Paging values outside their domain, one per field and failure. */
const INVALID_PAGING: readonly (readonly [string, Pick<DataQuery, 'limit' | 'offset'>])[] = [
  ['a negative limit', { limit: -1 }],
  ['a fractional limit', { limit: 1.5 }],
  ['a negative offset', { offset: -1 }],
  ['a fractional offset', { offset: 0.5 }],
];

describe('the paging contract', () => {
  it('returns exactly DATA_QUERY_DEFAULT_LIMIT rows of a flat source when the query names no limit', async () => {
    const seeded = DATA_QUERY_DEFAULT_LIMIT + 37;
    const { resolver, store } = harness(manyEvents(seeded));
    for (const source of ['spans', 'events'] as const) {
      const result = await resolved(resolver, { source });
      expect(rowIds(result)).toHaveLength(DATA_QUERY_DEFAULT_LIMIT);
      expect(result).toMatchObject({
        total: seeded,
        limit: DATA_QUERY_DEFAULT_LIMIT,
        offset: DATA_QUERY_DEFAULT_OFFSET,
        nextOffset: DATA_QUERY_DEFAULT_OFFSET + DATA_QUERY_DEFAULT_LIMIT,
      });
    }
    expect(store.calls.map((call) => call.limit)).toStrictEqual([
      DATA_QUERY_DEFAULT_LIMIT,
      DATA_QUERY_DEFAULT_LIMIT,
    ]);
    expect(store.calls.map((call) => call.offset)).toStrictEqual([
      DATA_QUERY_DEFAULT_OFFSET,
      DATA_QUERY_DEFAULT_OFFSET,
    ]);
  });

  it('returns exactly DATA_QUERY_DEFAULT_LIMIT rows of an aggregate source when the query names no limit', async () => {
    const seeded = DATA_QUERY_DEFAULT_LIMIT + 11;
    const { resolver } = harness(manyComponents(seeded));
    const result = await resolved(resolver, { source: 'renders' });
    expect(rowIds(result)).toHaveLength(DATA_QUERY_DEFAULT_LIMIT);
    expect(result).toMatchObject({
      total: seeded,
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: DATA_QUERY_DEFAULT_OFFSET,
      nextOffset: DATA_QUERY_DEFAULT_OFFSET + DATA_QUERY_DEFAULT_LIMIT,
    });
  });

  it('clamps a limit of DATA_QUERY_MAX_LIMIT + 1 to the ceiling and answers rather than refusing', async () => {
    const seeded = DATA_QUERY_MAX_LIMIT + 5;
    const { resolver, store } = harness(manyEvents(seeded));
    const result = await resolved(resolver, { source: 'events', limit: DATA_QUERY_MAX_LIMIT + 1 });
    expect(rowIds(result)).toHaveLength(DATA_QUERY_MAX_LIMIT);
    expect(result).toMatchObject({
      total: seeded,
      limit: DATA_QUERY_MAX_LIMIT,
      offset: DATA_QUERY_DEFAULT_OFFSET,
      nextOffset: DATA_QUERY_MAX_LIMIT,
    });
    expect(store.calls[0]?.limit).toBe(DATA_QUERY_MAX_LIMIT);

    const metrics = await resolved(resolver, {
      source: 'metrics',
      limit: DATA_QUERY_MAX_LIMIT + 1,
    });
    expect(metrics).toMatchObject({ limit: DATA_QUERY_MAX_LIMIT, nextOffset: null });
    expect(rowIds(metrics)).toStrictEqual([...METRIC_IDS]);
  });

  it('starts at DATA_QUERY_DEFAULT_OFFSET and honours an explicit offset on every kind of source', async () => {
    const events = [...manyEvents(47), ...manyComponents(23)];
    const { resolver, store } = harness(events);
    for (const source of ['events', 'renders'] as const) {
      const whole = rowIds(await resolved(resolver, { source, limit: DATA_QUERY_MAX_LIMIT }));
      const first = await resolved(resolver, { source, limit: 5 });
      expect(first).toMatchObject({ offset: DATA_QUERY_DEFAULT_OFFSET });
      expect(rowIds(first)).toStrictEqual(
        whole.slice(DATA_QUERY_DEFAULT_OFFSET, DATA_QUERY_DEFAULT_OFFSET + 5),
      );
      const later = await resolved(resolver, { source, limit: 5, offset: 10 });
      expect(later).toMatchObject({ offset: 10, nextOffset: 15 });
      expect(rowIds(later)).toStrictEqual(whole.slice(10, 15));
    }
    const eventReads = store.calls.filter((call) => call.limit === 5);
    expect(eventReads.map((call) => call.offset)).toStrictEqual([DATA_QUERY_DEFAULT_OFFSET, 10]);
  });

  it.each(INVALID_PAGING)(
    'refuses %s on every source with a typed error, before reading anything',
    async (_label, paging) => {
      for (const source of DATA_QUERY_SOURCES) {
        const { resolver, store, correlator } = harness(everythingFixture());
        const error = await refused(resolver, { source, ...paging });
        expect(error.code).toBe('PANEL_INVALID');
        expect(store.calls).toHaveLength(0);
        expect(store.scans).toHaveLength(0);
        expect(correlator.calls).toHaveLength(0);
      }
    },
  );

  it('reports total as the count before paging: N rows, a page of 10', async () => {
    const { resolver } = harness([...manyEvents(47), ...manyComponents(23)]);
    const events = await resolved(resolver, { source: 'events', limit: 10 });
    expect(rowIds(events)).toHaveLength(10);
    expect(events).toMatchObject({ total: 47 + 23 });
    const spans = await resolved(resolver, { source: 'spans', limit: 10, offset: 30 });
    expect(rowIds(spans)).toHaveLength(10);
    expect(spans).toMatchObject({ total: 47 + 23 });
    const renders = await resolved(resolver, { source: 'renders', limit: 10 });
    expect(rowIds(renders)).toHaveLength(10);
    expect(renders).toMatchObject({ total: 23 });
  });

  it('carries nextOffset as a number while rows remain and null on the last page, in the DataPage shape', async () => {
    const { resolver } = harness(manyEvents(25));
    const expected: readonly (readonly [number, number, number | null])[] = [
      [0, 10, 10],
      [10, 10, 20],
      [20, 5, null],
    ];
    const pageKeys = Object.keys(dataPageShape).sort();
    for (const [offset, length, nextOffset] of expected) {
      const result = await resolved(resolver, { source: 'events', limit: 10, offset });
      expect(rowIds(result)).toHaveLength(length);
      expect(result).toMatchObject({ total: 25, limit: 10, offset, nextOffset });
      expect(Object.keys(result).sort()).toStrictEqual(['events', 'source', ...pageKeys].sort());
      expect(result).not.toHaveProperty('hasMore');
      const wire: unknown = JSON.parse(JSON.stringify(result));
      expect(wire).toHaveProperty('nextOffset', nextOffset);
    }
  });

  it('answers an offset past the end with an empty last page', async () => {
    const { resolver } = harness(manyEvents(8));
    for (const source of ['events', 'renders'] as const) {
      const result = await resolved(resolver, { source, limit: 4, offset: 400 });
      expect(rowIds(result)).toStrictEqual([]);
      expect(result).toMatchObject({ offset: 400, nextOffset: null });
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The multi-page walk: the strictest check in this file
 * ---------------------------------------------------------------------------------------------- */

/** Every (sortable source, sort) pair: every sort orders every paged source, metrics included. */
const WALK_CASES: readonly (readonly [SortedDataSource, DataQuerySort])[] = SORTED_SOURCES.flatMap(
  (source) => DATA_QUERY_SORTS.map((sort) => [source, sort] as const),
);

/** Page sizes that split the fixture's tie groups at different points. */
const WALK_PAGE_SIZES: readonly number[] = [1, 2, 3, 5];

describe('the multi-page walk', () => {
  it('covers every sort of every sortable source', () => {
    for (const source of SORTED_SOURCES) {
      expect(WALK_CASES.filter(([walked]) => walked === source)).toHaveLength(
        DATA_QUERY_SORTS.length,
      );
    }
    expect(new Set(WALK_CASES.map(([source]) => source)).size).toBe(SORTED_SOURCES.length);
    expect(WALK_CASES).toHaveLength(SORTED_SOURCES.length * DATA_QUERY_SORTS.length);
  });

  it.each(WALK_CASES)(
    '%s under %s: every walk visits each row exactly once, in the order of one unpaged read',
    async (source, sort) => {
      const events = tieFixture();
      const { resolver } = harness(events);
      const chain = chainFor(source, sort);

      const whole = await resolved(resolver, { source, sort, limit: DATA_QUERY_MAX_LIMIT });
      if (!('total' in whole)) {
        throw new Error(`source ${source} is not paged`);
      }
      const rows = rowsOf(whole);
      const wholeIds = rows.map((row) => row.id);
      expect(whole.nextOffset).toBeNull();
      expect(wholeIds).toHaveLength(whole.total);
      expect(new Set(wholeIds).size).toBe(wholeIds.length);
      expect(whole.total).toBeGreaterThan(Math.max(...WALK_PAGE_SIZES));

      // The unpaged read is in strict chain order — every derived key
      // evaluated here from the fixture — so no two rows compare equal and
      // every tie on the sort key was broken.
      expectStrictChainOrder(rows, chain, events);

      for (const pageSize of WALK_PAGE_SIZES) {
        const walk = await walkAll(resolver, { source, sort }, pageSize);
        expect(new Set(walk.ids).size).toBe(walk.ids.length);
        expect(walk.ids).toHaveLength(whole.total);
        expect(walk.ids).toStrictEqual(wholeIds);
        expect(walk.totals.every((total) => total === whole.total)).toBe(true);
        expect(walk.pages).toBe(Math.ceil(whole.total / pageSize));
      }
    },
  );

  it('walks the metrics answered without a sort page by page to exactly METRIC_IDS', async () => {
    const { resolver } = harness(tieFixture());
    for (const pageSize of WALK_PAGE_SIZES) {
      const walk = await walkAll(resolver, { source: 'metrics' }, pageSize);
      expect(walk.ids).toStrictEqual([...METRIC_IDS]);
      expect(walk.totals.every((total) => total === METRIC_IDS.length)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The flat sources
 * ---------------------------------------------------------------------------------------------- */

/** Three events on every tier, each of the first kind the tier permits. */
function tierFixture(): TelemetryEvent[] {
  return TELEMETRY_TIERS.flatMap((tier, tierIndex) =>
    Array.from({ length: 3 }, (_, index) =>
      makeEvent({
        kind: kindOnTier(tier),
        tier,
        startTime: at(tierIndex * 10 + index),
        duration: 1 + index,
      }),
    ),
  );
}

describe('spans and events', () => {
  it('pushes the default sort, the default page and the span kinds into the store read', async () => {
    const { resolver, store } = harness(flatFixture());
    const result = await resolved(resolver, { source: 'spans' });

    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({
      sessionId: SESSION_A,
      captureId: CAPTURE_A1,
      sort: DEFAULT_SORT_BY_SOURCE.spans,
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: DATA_QUERY_DEFAULT_OFFSET,
      kinds: SPAN_SOURCE_KINDS,
    });
    expect(result.source).toBe('spans');
    if (result.source === 'spans') {
      expect(result.spans).toHaveLength(12);
      expect(result.spans.every((span) => SPAN_SOURCE_KINDS.includes(span.kind))).toBe(true);
      expect(result.total).toBe(12);
      expect(result.nextOffset).toBeNull();
    }
  });

  it('reads every kind for events and asks the store for count_desc grouped by the operation name', async () => {
    const events = [
      makeEvent({ kind: 'function', name: 'rare', startTime: at(1) }),
      makeEvent({ kind: 'function', name: 'frequent', startTime: at(2) }),
      makeEvent({ kind: 'state', name: 'frequent', startTime: at(3), duration: 0 }),
      makeEvent({ kind: 'function', name: 'frequent', startTime: at(4) }),
      makeEvent({ kind: 'error', name: 'equal', startTime: at(5), duration: 0 }),
      makeEvent({ kind: 'function', name: 'equal', startTime: at(6) }),
      makeEvent({ kind: 'function', name: 'frequent', captureId: CAPTURE_A2 }),
    ];
    const { resolver, store } = harness(events);
    const result = await resolved(resolver, { source: 'events', sort: 'count_desc' });

    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({ sort: 'count_desc', groupBy: 'name' });
    expect(store.calls[0]?.kinds).toBeUndefined();
    // Largest group of the capture first, a group's rows together; two equal
    // groups by name in byte order; inside a group by id.
    const inCapture = events.filter((event) => event.captureId === CAPTURE_A1);
    const idsNamed = (name: string): string[] =>
      inCapture
        .filter((event) => event.name === name)
        .map((event) => event.id)
        .sort(byCodeUnit);
    expect(rowIds(result)).toStrictEqual([
      ...idsNamed('frequent'),
      ...idsNamed('equal'),
      ...idsNamed('rare'),
    ]);
    expect(result).toMatchObject({ source: 'events', total: inCapture.length, nextOffset: null });
  });

  it('asks the store for every sort exactly as named, on both flat sources', async () => {
    const { resolver, store } = harness(flatFixture());
    for (const source of ['spans', 'events'] as const) {
      for (const sort of DATA_QUERY_SORTS) {
        await resolved(resolver, { source, sort });
      }
    }
    expect(store.calls.map((call) => call.sort)).toStrictEqual([
      ...DATA_QUERY_SORTS,
      ...DATA_QUERY_SORTS,
    ]);
    expect(store.calls.every((call) => call.groupBy === 'name')).toBe(true);
    // Only `spans` under `start_asc` — the canonical parent-first chain — asks
    // for a parent-first page; every other read leaves the field out.
    expect(store.calls.map((call) => call.parentFirst)).toStrictEqual([
      ...DATA_QUERY_SORTS.map((sort) => (sort === 'start_asc' ? true : undefined)),
      ...DATA_QUERY_SORTS.map(() => undefined),
    ]);
    expect(store.calls.filter((call) => 'parentFirst' in call)).toHaveLength(1);
  });

  it('orders spans under start_asc parent first, then by start, producer, sequence and arrival', async () => {
    // The finding's reproduction, in one trace: a root A0; children A2
    // (seq 2), B0 and A1 (seq 1) at one instant; B1, B0's child, 5 ms before
    // them. Producer A's id sorts below B's; the rows arrive shuffled and
    // their ids are permuted, so neither order could produce the answer.
    const producerA: ProducerId = opaqueId(ID_PREFIXES.producer, 2);
    const producerB: ProducerId = opaqueId(ID_PREFIXES.producer, 3);
    expect(byUtf8Bytes(producerA, producerB)).toBeLessThan(0);
    const trace = traceIdFor(3);
    const spanOf = (ordinal: number): SpanId => hexId(9_000 + ordinal, SPAN_ID_WIDTH);
    const emitted = (
      producerId: ProducerId,
      seq: number,
      spanId: SpanId,
      parentSpanId: SpanId | undefined,
      offsetMs: number,
    ): TelemetryEvent => ({
      ...makeEvent({
        traceId: trace,
        spanId,
        ...(parentSpanId !== undefined ? { parentSpanId } : {}),
        startTime: at(offsetMs),
      }),
      producerId,
      seq,
    });
    const b1 = emitted(producerB, 1, spanOf(4), spanOf(3), 15);
    const a2 = emitted(producerA, 2, spanOf(2), spanOf(0), 20);
    const a0 = emitted(producerA, 0, spanOf(0), undefined, 20);
    const b0 = emitted(producerB, 0, spanOf(3), spanOf(0), 20);
    const a1 = emitted(producerA, 1, spanOf(1), spanOf(0), 20);
    // Another trace of the capture, earlier than all of them.
    const elsewhere = makeEvent({ traceId: TRACE_OTHER, startTime: at(1) });
    const events = [b1, a2, elsewhere, a0, b0, a1];
    for (const event of events) {
      expect(parseTelemetryEvent(event).ok).toBe(true);
    }
    const { resolver, store } = harness(events);
    const query: DataQuery = { source: 'spans', filter: { traceId: trace }, sort: 'start_asc' };

    const result = await resolved(resolver, query);

    expect(rowIds(result)).toStrictEqual([a0.id, a1.id, a2.id, b0.id, b1.id]);
    expect(result).toMatchObject({ source: 'spans', total: 5, nextOffset: null });
    expect(store.calls[0]).toMatchObject({ traceId: trace, sort: 'start_asc', parentFirst: true });
    // A walk one row at a time visits each row once, in the same order.
    expect((await walkAll(resolver, query, 1)).ids).toStrictEqual(rowIds(result));

    // The events log keeps its flat order: start, then the event id.
    const log = await resolved(resolver, { ...query, source: 'events' });
    expect(rowIds(log)).toStrictEqual(
      [b1, a2, a0, b0, a1].sort(byStartThenId).map((event) => event.id),
    );
    expect(rowIds(log)[0]).toBe(b1.id);
  });

  it('pushes every filter field into the store, a kinds filter only narrowing the span kinds', async () => {
    const { resolver, store } = harness(flatFixture());
    await resolved(resolver, {
      source: 'spans',
      filter: {
        traceId: TRACE_MAIN,
        kinds: ['function', 'state'],
        tier: 'browser',
        minDuration: 2,
        component: 'Alpha',
      },
    });
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({
      traceId: TRACE_MAIN,
      kinds: ['function'],
      tier: 'browser',
      minDuration: 2,
      component: 'Alpha',
    });
  });

  it.each(TELEMETRY_TIERS)('pushes a %s tier filter into the one events read', async (tier) => {
    const events = tierFixture();
    const { resolver, store } = harness(events);
    const result = await resolved(resolver, { source: 'events', filter: { tier } });
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]?.tier).toBe(tier);
    expect(result.source).toBe('events');
    if (result.source === 'events') {
      expect(result.events.every((event) => event.tier === tier)).toBe(true);
      expect(result.total).toBe(events.filter((event) => event.tier === tier).length);
    }
  });

  it('pushes traceId, kinds and minDuration into the one events read rather than filtering afterwards', async () => {
    const events = [
      renderEvent('Kilo', 1, 3),
      renderEvent('Kilo', 2, 1),
      makeEvent({ kind: 'commit', startTime: at(3), duration: 4, attributes: { phase: 'update' } }),
      makeEvent({ kind: 'function', startTime: at(4), duration: 9 }),
      makeEvent({
        kind: 'render',
        traceId: TRACE_OTHER,
        name: 'Kilo',
        startTime: at(5),
        duration: 5,
        attributes: { component: 'Kilo', phase: 'update', trigger: 'props' },
      }),
    ];
    const filter: DataQueryFilter = {
      traceId: TRACE_MAIN,
      kinds: [...RENDER_KINDS],
      minDuration: 2,
    };
    const { resolver, store } = harness(events);
    const result = await resolved(resolver, { source: 'events', filter });

    expect(store.calls).toHaveLength(1);
    const [call] = store.calls;
    expect(call).toMatchObject({ traceId: TRACE_MAIN, kinds: RENDER_KINDS, minDuration: 2 });
    expect(call?.tier).toBeUndefined();
    expect(call?.component).toBeUndefined();
    const expected = events
      .filter(
        (event) =>
          event.traceId === TRACE_MAIN && RENDER_KINDS.includes(event.kind) && event.duration >= 2,
      )
      .sort(byStartThenId)
      .map((event) => event.id);
    expect(expected).toHaveLength(2);
    expect(rowIds(result)).toStrictEqual(expected);
  });

  it('narrows render-kind events to one component', async () => {
    const { resolver, store } = harness(tieFixture());
    const result = await resolved(resolver, {
      source: 'events',
      filter: { kinds: [...RENDER_KINDS], component: 'Kilo' },
    });
    expect(store.calls[0]).toMatchObject({ kinds: RENDER_KINDS, component: 'Kilo' });
    expect(result.source).toBe('events');
    if (result.source === 'events') {
      expect(result.total).toBe(3);
      expect(
        result.events.every(
          (event) => RENDER_KINDS.includes(event.kind) && event.attributes['component'] === 'Kilo',
        ),
      ).toBe(true);
    }
  });

  it('answers a kinds filter that leaves no span kind with an empty page, without a read', async () => {
    const { resolver, store } = harness(flatFixture());
    const result = await resolved(resolver, {
      source: 'spans',
      filter: { kinds: [...STATE_KINDS] },
    });
    expect(store.calls).toHaveLength(0);
    expect(result).toStrictEqual({
      source: 'spans',
      spans: [],
      total: 0,
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: DATA_QUERY_DEFAULT_OFFSET,
      nextOffset: null,
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * The aggregate sources
 * ---------------------------------------------------------------------------------------------- */

describe('renders', () => {
  it('aggregates the capture’s render records, in the default order, with the page echo', async () => {
    const { resolver, store } = harness(renderFixture());
    const result = await resolved(resolver, { source: 'renders' });

    // One whole-slice scan of the render kinds, held to the ceiling; no page walk.
    expect(store.calls).toHaveLength(0);
    expect(store.scans).toHaveLength(1);
    expect(store.scans[0]).toMatchObject({
      sessionId: SESSION_A,
      captureId: CAPTURE_A1,
      kinds: RENDER_KINDS,
      maxRows: MAX_AGGREGATE_INPUT_EVENTS,
    });
    expect(result.source).toBe('renders');
    if (result.source === 'renders') {
      expect(result.total).toBe(8);
      expect(result.nextOffset).toBeNull();
      const counts = result.renders.map((row) => row.renderCount);
      expect(counts).toStrictEqual([...counts].sort((left, right) => right - left));
      const hotel = result.renders.find((row) => row.component === 'Hotel');
      expect(hotel?.renderCount).toBe(1);
    }
  });

  it('narrows to one component, pushing the component into the slice read', async () => {
    const { resolver, store } = harness(renderFixture());
    const result = await resolved(resolver, {
      source: 'renders',
      filter: { component: 'Charlie' },
    });
    expect(store.scans.length).toBeGreaterThan(0);
    expect(store.scans.every((scan) => scan.component === 'Charlie')).toBe(true);
    expect(result.source).toBe('renders');
    if (result.source === 'renders') {
      expect(result.renders.map((row) => row.component)).toStrictEqual(['Charlie']);
      expect(result.total).toBe(1);
    }
  });

  it('breaks a tie between components by the numbers in their names: Row2 before Row10, under every sort', async () => {
    // One render each at one instant and one duration, so every sort's primary
    // key ties; `Row30` renders twice, so under the count and total-time sorts
    // it leads and the others tie behind it.
    const events = [
      ...['Row20', 'Row2', 'Row10', 'Row3', 'Row1', 'Row02'].map((name) => renderEvent(name, 0, 1)),
      renderEvent('Row30', 0, 1),
      renderEvent('Row30', 5, 1),
    ];
    const { resolver } = harness(events);
    // `Row02` and `Row2` write the same number; code-unit order separates them.
    const tied = ['Row1', 'Row02', 'Row2', 'Row3', 'Row10', 'Row20'];
    const expected: Readonly<Record<DataQuerySort, readonly string[]>> = {
      count_desc: ['Row30', ...tied],
      duration_desc: ['Row30', ...tied],
      start_asc: [...tied, 'Row30'],
    };
    for (const sort of DATA_QUERY_SORTS) {
      const whole = await resolved(resolver, {
        source: 'renders',
        sort,
        limit: DATA_QUERY_MAX_LIMIT,
      });
      expect(whole.source).toBe('renders');
      if (whole.source !== 'renders') {
        continue;
      }
      expect(whole.renders.map((row) => row.component)).toStrictEqual(expected[sort]);
      expectStrictChainOrder(whole.renders, chainFor('renders', sort), events);
      for (const pageSize of [1, 2, 3]) {
        const walk = await walkAll(resolver, { source: 'renders', sort }, pageSize);
        expect(walk.ids).toStrictEqual(rowIds(whole));
      }
    }
  });

  it('folds letter case when it breaks a tie, so upper- and lower-case names interleave', async () => {
    const names = ['Zeta', 'item', 'alpha', 'Item', 'Beta', 'gamma', 'Delta', 'eX', 'eG', 'Ew'];
    const events = names.map((name) => renderEvent(name, 0, 1));
    const { resolver } = harness(events);
    // Not code-unit order, which lists every upper-case name before every
    // lower-case one; names differing only in case stay adjacent, upper first.
    const expected = ['alpha', 'Beta', 'Delta', 'eG', 'Ew', 'eX', 'gamma', 'Item', 'item', 'Zeta'];
    expect([...names].sort(byCodeUnit)).not.toStrictEqual(expected);
    for (const sort of DATA_QUERY_SORTS) {
      const whole = await resolved(resolver, {
        source: 'renders',
        sort,
        limit: DATA_QUERY_MAX_LIMIT,
      });
      expect(whole.source).toBe('renders');
      if (whole.source !== 'renders') {
        continue;
      }
      expect(whole.renders.map((row) => row.component)).toStrictEqual(expected);
      for (const pageSize of [1, 4]) {
        const walk = await walkAll(resolver, { source: 'renders', sort }, pageSize);
        expect(walk.ids).toStrictEqual(rowIds(whole));
      }
    }
  });

  it('orders tied names by the same total, locale-free order an independent reading gives', async () => {
    const names = [
      'Row',
      'Row1a',
      'Row1A',
      'Row01a',
      'row 1',
      'row-1',
      'row_1',
      '9Lives',
      '10Lives',
      'Stage12345678901234567890123',
      'Stage12345678901234567890124',
      'Stage000',
      'Stage0',
      'Émile',
      'émile',
      'Omega',
      'Ωmega',
      'ωmega',
      'İndex',
      'index',
      '𝒜stral',
      'Astral',
    ];
    const events = names.map((name) => renderEvent(name, 0, 1));
    const { resolver } = harness(events);
    const expected = [...names].sort(byNaturalOrder);
    for (const sort of DATA_QUERY_SORTS) {
      const whole = await resolved(resolver, {
        source: 'renders',
        sort,
        limit: DATA_QUERY_MAX_LIMIT,
      });
      expect(whole.source).toBe('renders');
      if (whole.source !== 'renders') {
        continue;
      }
      expect(whole.renders.map((row) => row.component)).toStrictEqual(expected);
      expectStrictChainOrder(whole.renders, chainFor('renders', sort), events);
    }
    // Spot checks the independent reading must itself honour.
    expect(expected.indexOf('9Lives')).toBeLessThan(expected.indexOf('10Lives'));
    expect(expected.indexOf('Row')).toBeLessThan(expected.indexOf('Row1a'));
    expect(expected.indexOf('Stage12345678901234567890123')).toBeLessThan(
      expected.indexOf('Stage12345678901234567890124'),
    );
    expect(expected.indexOf('Stage0') + 1).toBe(expected.indexOf('Stage000'));
    expect(expected.indexOf('Émile') + 1).toBe(expected.indexOf('émile'));
    expect(expected.indexOf('Ωmega') + 1).toBe(expected.indexOf('ωmega'));
  });
});

describe('requests', () => {
  it('groups by the ingest request key, never by the redacted URL', async () => {
    const url = '/api/items?itemId=?';
    const events = [
      requestEvent('key-one', url, 0),
      requestEvent('key-one', url, 20),
      requestEvent('key-two', url, 40),
    ];
    const { resolver } = harness(events);
    const result = await resolved(resolver, { source: 'requests' });
    expect(result.source).toBe('requests');
    if (result.source === 'requests') {
      expect(result.total).toBe(2);
      expect(result.requests.map((group) => group.count)).toStrictEqual([2, 1]);
      expect(result.requests[0]?.duplicateCount).toBe(1);
      expect(result.requests.map((group) => group.requestKey)).toStrictEqual([
        'key-one',
        'key-two',
      ]);
    }
  });
});

describe('stateTransitions', () => {
  /** One interaction, then transitions of two components attributed to it. */
  function transitionFixture(): { events: TelemetryEvent[]; interaction: TelemetryEvent } {
    const interaction = makeEvent({ kind: 'interaction', name: 'click', startTime: at(0) });
    const events = [
      interaction,
      stateEvent('Alpha', 5, interaction.id),
      stateEvent('Beta', 5, interaction.id),
      stateEvent('Alpha', 7, interaction.id),
      stateEvent('Beta', 9, interaction.id),
    ];
    return { events, interaction };
  }

  it('narrows the transitions by component while keeping their triggers resolvable', async () => {
    const { events, interaction } = transitionFixture();
    const { resolver, store } = harness(events);
    const result = await resolved(resolver, {
      source: 'stateTransitions',
      filter: { component: 'Alpha' },
    });

    expect(result.source).toBe('stateTransitions');
    if (result.source === 'stateTransitions') {
      expect(result.total).toBe(2);
      expect(result.stateTransitions.every((row) => row.component === 'Alpha')).toBe(true);
      expect(result.stateTransitions.every((row) => row.triggerEventId === interaction.id)).toBe(
        true,
      );
      expect(result.stateTransitions.every((row) => row.triggerName === interaction.name)).toBe(
        true,
      );
    }
    // One shared traversal: the filter's own selection — every kind, narrowed
    // by the component — then the capture's whole slice, with what the ceiling
    // leaves, as the context the triggers resolve against. The transitions are
    // that selection's state records; every other aggregate source of the
    // filter is computed from the same two reads.
    const alpha = events.filter((event) => event.attributes['component'] === 'Alpha');
    expect(store.calls).toHaveLength(0);
    expect(store.scans).toHaveLength(2);
    const [selection, whole] = store.scans;
    expect(selection).toMatchObject({
      sessionId: SESSION_A,
      captureId: CAPTURE_A1,
      component: 'Alpha',
      maxRows: MAX_AGGREGATE_INPUT_EVENTS,
    });
    expect(selection?.kinds).toBeUndefined();
    expect(whole).toMatchObject({
      sessionId: SESSION_A,
      captureId: CAPTURE_A1,
      maxRows: MAX_AGGREGATE_INPUT_EVENTS - alpha.length,
    });
    expect(whole?.component).toBeUndefined();
    expect(whole?.kinds).toBeUndefined();
    expect(alpha.every((event) => STATE_KINDS.includes(event.kind))).toBe(true);
  });

  it('answers duration_desc longest state event first, equal durations chronologically, and walks it once', async () => {
    const timed = (component: string, offsetMs: number, duration: number): TelemetryEvent => ({
      ...stateEvent(component, offsetMs),
      duration,
    });
    const shortest = timed('Alpha', 5, 0.5);
    const longest = timed('Beta', 7, 4);
    const laterOfTwo = timed('Alpha', 9, 2);
    const earlierOfTwo = timed('Gamma', 1, 2);
    const firstInstant = timed('Beta', 3, 0);
    const lastInstant = timed('Gamma', 11, 0);
    const events = [shortest, longest, laterOfTwo, earlierOfTwo, firstInstant, lastInstant];
    const { resolver } = harness(events);

    const expected = [longest, earlierOfTwo, laterOfTwo, shortest, firstInstant, lastInstant].map(
      (event) => event.id,
    );
    const byDuration = await resolved(resolver, {
      source: 'stateTransitions',
      sort: 'duration_desc',
    });
    expect(rowIds(byDuration)).toStrictEqual(expected);
    const chronological = await resolved(resolver, { source: 'stateTransitions' });
    expect(rowIds(chronological)).not.toStrictEqual(expected);
    for (const pageSize of [1, 4]) {
      const walk = await walkAll(
        resolver,
        { source: 'stateTransitions', sort: 'duration_desc' },
        pageSize,
      );
      expect(walk.ids).toStrictEqual(expected);
    }
  });

  it('ranks a transition whose event duration is unknown after every one with a duration', () => {
    const { events } = transitionFixture();
    const rows = events
      .filter((event) => STATE_KINDS.includes(event.kind))
      .map((event): StateTransition => ({
        id: event.id,
        eventId: event.id,
        spanId: event.spanId,
        traceId: event.traceId,
        startTime: event.startTime,
        changed: true,
      }));
    const [unknown, ...measured] = rows;
    if (unknown === undefined) {
      throw new Error('the fixture holds no transition');
    }
    const durations = new Map(measured.map((row, index) => [row.eventId, index] as const));
    const ordered = orderRows(rows, SOURCE_SORT_KEYS.stateTransitions.duration_desc, {
      eventDurations: durations,
    });
    expect(ordered.at(-1)?.id).toBe(unknown.id);
    expect(ordered.slice(0, -1).map((row) => row.id)).toStrictEqual(
      [...measured].reverse().map((row) => row.id),
    );
  });

  it('answers count_desc most frequently changing hook first, one hook’s rows together, ungrouped rows last', async () => {
    /** A transition of hook `hookIndex` of `component`; either may be left out. */
    const hookEvent = (offsetMs: number, component?: string, hookIndex?: number): TelemetryEvent =>
      makeEvent({
        kind: 'state',
        name: 'state',
        startTime: at(offsetMs),
        duration: 0,
        attributes: {
          ...(component === undefined ? {} : { component }),
          ...(hookIndex === undefined ? {} : { hookIndex }),
          previousValue: { type: 'number', preview: '1', truncated: false },
          nextValue: { type: 'number', preview: '2', truncated: false },
        },
      });
    const upperFirst = [
      hookEvent(5, 'Alpha', 0),
      hookEvent(9, 'Alpha', 0),
      hookEvent(13, 'Alpha', 0),
    ];
    // Two hooks of two transitions each: by code unit `Zeta` precedes
    // `alpha`, where a locale comparison would put `alpha` first.
    const lowerSecond = [hookEvent(2, 'alpha', 1), hookEvent(20, 'alpha', 1)];
    const zeta = [hookEvent(3, 'Zeta', 0), hookEvent(4, 'Zeta', 0)];
    const betaHook = hookEvent(1, 'Beta', 0);
    // Same component, no hook index: a hook of its own, after `Beta`'s hook 0.
    const betaUnindexed = hookEvent(6, 'Beta');
    // Neither half of a hook, like the truncation sentinel: no group, even
    // though two of them would outnumber a hook of one.
    const ungrouped = [hookEvent(0), hookEvent(0.5)];
    const events = [...ungrouped, betaHook, ...lowerSecond, ...zeta, ...upperFirst, betaUnindexed];
    const { resolver } = harness(events);

    const expected = [
      ...upperFirst,
      ...zeta,
      ...lowerSecond,
      betaHook,
      betaUnindexed,
      ...ungrouped,
    ].map((event) => event.id);
    const byCount = await resolved(resolver, { source: 'stateTransitions', sort: 'count_desc' });
    expect(rowIds(byCount)).toStrictEqual(expected);
    for (const pageSize of [1, 3]) {
      const walk = await walkAll(
        resolver,
        { source: 'stateTransitions', sort: 'count_desc' },
        pageSize,
      );
      expect(walk.ids).toStrictEqual(expected);
    }
  });
});

/** The component tree snapshot a `componentTree` result carries. */
type ComponentTreeSnapshotResult = NonNullable<DataResultFor<'componentTree'>['componentTree']>;

/** Every component name in a snapshot's subtree, depth first. */
function componentsIn(nodes: ComponentTreeSnapshotResult['roots']): string[] {
  return nodes.flatMap((node) => [node.component, ...componentsIn(node.children)]);
}

describe('componentTree and graph', () => {
  it('answers a capture without rendering evidence with a null tree and no page', async () => {
    const { resolver } = harness([makeEvent({ kind: 'function' })]);
    const result = await resolved(resolver, { source: 'componentTree', limit: 1, offset: 3 });
    expect(result).toStrictEqual({ source: 'componentTree', componentTree: null });
  });

  it('builds the snapshot from the capture’s renders, as one object without a page', async () => {
    const { resolver } = harness(renderFixture());
    const result = await resolved(resolver, { source: 'componentTree' });
    expect(Object.keys(result).sort()).toStrictEqual(['componentTree', 'source']);
    expect(result).not.toHaveProperty('total');
    expect(result).not.toHaveProperty('nextOffset');
    expect(result.source).toBe('componentTree');
    if (result.source === 'componentTree') {
      expect(result.componentTree?.roots.length).toBeGreaterThan(0);
    }
  });

  it('narrows the component tree to one component’s renders', async () => {
    const { resolver, store } = harness(tieFixture());
    const whole = await resolved(resolver, { source: 'componentTree' });
    expect(whole.source).toBe('componentTree');
    if (whole.source === 'componentTree') {
      const everyone = new Set(componentsIn(whole.componentTree?.roots ?? []));
      expect(everyone.has('Kilo')).toBe(true);
      expect(everyone.has('Lima')).toBe(true);
    }

    const before = store.scans.length;
    const narrowed = await resolved(resolver, {
      source: 'componentTree',
      filter: { component: 'Kilo' },
    });
    const narrowedReads = store.scans.slice(before);
    expect(narrowedReads.length).toBeGreaterThan(0);
    expect(narrowedReads.every((scan) => scan.component === 'Kilo')).toBe(true);
    expect(narrowed.source).toBe('componentTree');
    if (narrowed.source === 'componentTree') {
      const names = componentsIn(narrowed.componentTree?.roots ?? []);
      expect(names.length).toBeGreaterThan(0);
      expect(new Set(names)).toStrictEqual(new Set(['Kilo']));
    }
  });

  it('builds the dependency graph with no page, empty when nothing was captured', async () => {
    const { resolver } = harness(flatFixture());
    const result = await resolved(resolver, { source: 'graph', sort: 'count_desc' });
    expect(Object.keys(result).sort()).toStrictEqual(['graph', 'source']);
    expect(result.source).toBe('graph');
    if (result.source === 'graph') {
      expect(result.graph.nodes.length).toBeGreaterThan(0);
    }
    const empty = await resolved(harness([]).resolver, { source: 'graph' });
    expect(empty.source).toBe('graph');
    if (empty.source === 'graph') {
      expect(empty.graph.nodes).toStrictEqual([]);
      expect(empty.graph.edges).toStrictEqual([]);
    }
  });
});

describe('aggregate filters reach the store', () => {
  it.each(AGGREGATE_SOURCES)(
    'pushes a %s filter into the store reads of its slice',
    async (source) => {
      const filter: DataQueryFilter = { traceId: TRACE_MAIN, tier: 'browser', minDuration: 0.5 };
      const { resolver, store } = harness(everythingFixture());
      await resolved(resolver, { source, filter });

      // Aggregates read whole slices by scan, never by page.
      expect(store.calls).toHaveLength(0);
      expect(store.scans.length).toBeGreaterThan(0);
      for (const scan of store.scans) {
        expect(scan).toMatchObject({
          sessionId: SESSION_A,
          captureId: CAPTURE_A1,
          traceId: TRACE_MAIN,
        });
        expect(scan.requestKey).toBeUndefined();
      }
      expect(store.scans.some((scan) => scan.tier === 'browser' && scan.minDuration === 0.5)).toBe(
        true,
      );
    },
  );
});

/**
 * A telemetry port whose scans `scan` scripts, with no page read, no trace,
 * and a stamp and a generation that never move — for the cases that drive the
 * scan contract directly.
 */
function scriptedTelemetry(scan: PanelTelemetryPort['scanEvents']): PanelTelemetryPort {
  return {
    query: () => err(new DebuggenError('STORE_ERROR', 'The scripted store serves scans only.')),
    scanEvents: scan,
    firstTraceId: () => ok(undefined),
    captureStamp: () => ok({ count: 1, maxIngestSeq: 1 }),
    captureGeneration: () => ok({ dataVersion: 0, purges: 0, writes: 1 }),
  };
}

/**
 * A scan answer that honours the contract for a selection of `total` rows
 * none of which the case needs: complete (and empty) within the budget, and
 * incomplete past it.
 */
function countedScan(total: number, maxRows: number): TelemetryScan {
  return { rows: [], total, complete: total <= maxRows };
}

describe('complete aggregate reads', () => {
  it('aggregates every event of a capture past the 50 000 events it once stopped at, in one scan', async () => {
    const earlier = 50_000;
    const later = 1_234;
    const events: TelemetryEvent[] = [];
    for (let index = 0; index < earlier; index += 1) {
      events.push(renderEvent(`Pane${index % 4}`, index % 97, 1));
    }
    // Later in capture order than every one of the first 50 000, so a read
    // that stopped there would have left every one of them out.
    for (let index = 0; index < later; index += 1) {
      events.push(renderEvent('Tail', 200 + (index % 50), 1));
    }
    const { resolver, store } = harness(events);

    const renders = await resolved(resolver, { source: 'renders', limit: DATA_QUERY_MAX_LIMIT });
    expect(renders.source).toBe('renders');
    if (renders.source === 'renders') {
      expect(renders.total).toBe(5);
      expect(renders.nextOffset).toBeNull();
      const tail = renders.renders.find((row) => row.component === 'Tail');
      expect(tail?.renderCount).toBe(later);
      expect(renders.renders.reduce((sum, row) => sum + row.renderCount, 0)).toBe(earlier + later);
    }
    // More than ten store pages' worth, read as one scan — one count and one
    // ordered statement — rather than a COUNT and an OFFSET page each.
    expect(Math.ceil((earlier + later) / TELEMETRY_QUERY_MAX_LIMIT)).toBeGreaterThan(10);
    expect(store.calls).toHaveLength(0);
    expect(store.scans).toHaveLength(1);
    expect(store.scans[0]).toMatchObject({
      kinds: RENDER_KINDS,
      maxRows: MAX_AGGREGATE_INPUT_EVENTS,
    });

    // No summary is stored, so the unfiltered values are computed — from all of it.
    const metrics = await resolved(resolver, { source: 'metrics' });
    expect(metrics.source).toBe('metrics');
    if (metrics.source === 'metrics') {
      expect(metrics.metrics).toStrictEqual(
        computeCaptureSummary(events, { captureId: CAPTURE_A1 }).metrics,
      );
    }
    expect(store.calls).toHaveLength(0);
  });

  it.each(AGGREGATE_SOURCES)(
    'refuses %s over more events than the ceiling from the count alone, reading no row',
    async (source) => {
      let reads = 0;
      const oversized = scriptedTelemetry((_filter, maxRows) => {
        reads += 1;
        expect(maxRows).toBe(MAX_AGGREGATE_INPUT_EVENTS);
        return ok(countedScan(MAX_AGGREGATE_INPUT_EVENTS + 1, maxRows));
      });
      const { resolver, records } = harness([], { telemetry: oversized });
      const error = await refused(resolver, { source });
      expect(error.code).toBe('PANEL_INVALID');
      expect(error.details).toMatchObject({
        source,
        total: MAX_AGGREGATE_INPUT_EVENTS + 1,
        bound: MAX_AGGREGATE_INPUT_EVENTS,
        reason: 'aggregate-input-too-large',
      });
      expect(error.hint).toBeDefined();
      // A subset source counts its own slice once; an every-kind source counts
      // the shared traversal, then its own slice — and no row is read either way.
      expect(reads).toBe(SHARED_TRAVERSAL_SOURCES.includes(source) ? 2 : 1);
      expect(records.some((record) => record.level === 'warn')).toBe(true);
    },
  );

  it('holds both halves of a subject-narrowed slice to one ceiling', async () => {
    const halves = (subjects: number): PanelTelemetryPort =>
      scriptedTelemetry((filter, maxRows) =>
        ok(
          countedScan(
            filter.component === undefined ? MAX_AGGREGATE_INPUT_EVENTS - 10 : subjects,
            maxRows,
          ),
        ),
      );
    const query: DataQuery = { source: 'stateTransitions', filter: { component: 'Alpha' } };

    const over = await refused(harness([], { telemetry: halves(11) }).resolver, query);
    expect(over.code).toBe('PANEL_INVALID');
    expect(over.details).toMatchObject({
      total: MAX_AGGREGATE_INPUT_EVENTS + 1,
      reason: 'aggregate-input-too-large',
    });

    const atCeiling = await resolved(harness([], { telemetry: halves(10) }).resolver, query);
    expect(atCeiling).toMatchObject({ source: 'stateTransitions', total: 0 });
  });

  it('refuses a scan the store declares incomplete as too large, never answering from its rows', async () => {
    const row = renderEvent('Alpha', 1);
    let reads = 0;
    // Against the contract, the incomplete scan still hands back a row.
    const partial = scriptedTelemetry(() => {
      reads += 1;
      return ok({ rows: [row], total: MAX_AGGREGATE_INPUT_EVENTS + 1, complete: false });
    });
    const error = await refused(harness([], { telemetry: partial }).resolver, {
      source: 'renders',
    });
    expect(error.code).toBe('PANEL_INVALID');
    expect(error.details).toMatchObject({
      total: MAX_AGGREGATE_INPUT_EVENTS + 1,
      reason: 'aggregate-input-too-large',
    });
    expect(reads).toBe(1);
  });

  /** Scans that contradict their own count or row budget. */
  const CONTRADICTORY_SCANS: readonly (readonly [string, (maxRows: number) => TelemetryScan])[] = [
    [
      'claims completeness over more rows than its budget',
      (maxRows) => ({ rows: [], total: maxRows + 1, complete: true }),
    ],
    [
      'claims completeness over more rows than it counted',
      () => ({
        rows: [renderEvent('Alpha', 1), renderEvent('Alpha', 2)],
        total: 1,
        complete: true,
      }),
    ],
    [
      'declares itself incomplete within its budget',
      () => ({ rows: [], total: 3, complete: false }),
    ],
  ];

  it.each(CONTRADICTORY_SCANS)(
    'refuses a scan that %s as scan-inconsistent, for a subset and an all-kinds source',
    async (_label, answer) => {
      for (const source of ['renders', 'graph'] as const) {
        let reads = 0;
        const contradictory = scriptedTelemetry((_filter, maxRows) => {
          reads += 1;
          return ok(answer(maxRows));
        });
        const { resolver, records } = harness([], { telemetry: contradictory });
        const error = await refused(resolver, { source });
        expect(error.code).toBe('STORE_ERROR');
        expect(error.details).toMatchObject({ reason: 'scan-inconsistent' });
        expect(reads).toBe(1);
        expect(records.some((record) => record.level === 'warn')).toBe(true);
      }
    },
  );
});

/**
 * Context rows in the large-slice cases: past the most arguments one spread
 * call can pass on Node 24 (it throws `RangeError` from about 150 000), and
 * within the aggregate ceiling.
 */
const LARGE_CONTEXT_EVENTS = 200_000;

describe('large subject-narrowed slices', () => {
  /**
   * One interaction, two of `Alpha`'s state transitions attributed to it, and
   * {@link LARGE_CONTEXT_EVENTS} timed functions after both — so merging the
   * subjects back into capture order ends with a remainder of every function.
   * Built once, every event and the whole list frozen, and scanned by a store
   * that filters that list and nothing else.
   */
  function largeCapture(): {
    readonly port: PanelTelemetryPort;
    readonly interaction: TelemetryEvent;
    readonly transitions: readonly TelemetryEvent[];
  } {
    const interaction = makeEvent({ kind: 'interaction', name: 'click', startTime: at(0) });
    const transitions = [
      stateEvent('Alpha', 1, interaction.id),
      stateEvent('Alpha', 2, interaction.id),
    ];
    const base = makeEvent({ kind: 'function', duration: 1 });
    const functions = Array.from({ length: LARGE_CONTEXT_EVENTS }, (_, index) =>
      Object.freeze({
        ...base,
        // Past every id `eventIdFor` mints, so no id repeats.
        id: opaqueId(ID_PREFIXES.event, EVENT_ID_MODULUS + index),
        spanId: hexId(EVENT_ID_MODULUS + index, SPAN_ID_WIDTH),
        startTime: at(10 + index / 1_000),
        seq: base.seq + index,
        ingestSeq: base.ingestSeq + index,
      }),
    );
    const whole: TelemetryEvent[] = [interaction, ...transitions, ...functions];
    for (const event of [interaction, ...transitions]) {
      deepFreeze(event);
    }
    Object.freeze(whole);
    const port: PanelTelemetryPort = {
      query: () =>
        err(new DebuggenError('STORE_ERROR', 'The large-slice store serves scans only.')),
      scanEvents: (filter, maxRows) => {
        const selection = whole.filter((event) => matchesQuery(event, filter));
        Object.freeze(selection);
        return ok(scanOf(selection, maxRows));
      },
      firstTraceId: () => ok(interaction.traceId),
      captureStamp: () => ok(stampOf(whole)),
      captureGeneration: () => ok(generationOf(whole)),
    };
    return { port, interaction, transitions };
  }

  it.each(['stateTransitions', 'queries'] as const)(
    'answers a component-narrowed %s over more context rows than a spread can pass',
    async (source) => {
      const { port, interaction, transitions } = largeCapture();
      const { resolver, records } = harness([], { telemetry: port });
      const result = await resolver.resolve(CONTEXT_A1, {
        source,
        filter: { component: 'Alpha' },
      });
      if (!result.ok) {
        throw new Error(`expected a result, got ${result.error.code}: ${result.error.message}`);
      }
      expect(records.some((record) => record.level === 'error')).toBe(false);
      if (result.value.source === 'stateTransitions') {
        expect(result.value.total).toBe(transitions.length);
        expect(result.value.stateTransitions.map((row) => row.id)).toStrictEqual(
          transitions.map((event) => event.id),
        );
        expect(
          result.value.stateTransitions.every((row) => row.triggerEventId === interaction.id),
        ).toBe(true);
      } else {
        // No statement names the component: an empty page, not a failure.
        expect(result.value).toMatchObject({ source: 'queries', total: 0, nextOffset: null });
      }
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * The shared traversal
 * ---------------------------------------------------------------------------------------------- */

/**
 * A capture for the equality proof: every aggregate's records in two traces,
 * `Alpha` records of several kinds and tiers, and records of another capture
 * and another session that no read of capture A1 may return.
 */
function equalityFixture(): TelemetryEvent[] {
  const otherInteraction = makeEvent({
    kind: 'interaction',
    name: 'click',
    traceId: TRACE_OTHER,
    startTime: at(95),
  });
  return [
    ...tieFixture(),
    ...everythingFixture(),
    otherInteraction,
    makeEvent({
      kind: 'render',
      name: 'Alpha',
      traceId: TRACE_OTHER,
      startTime: at(96),
      duration: 4,
      attributes: { component: 'Alpha', phase: 'mount', trigger: 'props' },
    }),
    makeEvent({
      kind: 'state',
      name: 'state',
      traceId: TRACE_OTHER,
      startTime: at(97),
      duration: 0,
      attributes: {
        component: 'Alpha',
        hookIndex: 1,
        previousValue: { type: 'number', preview: '3', truncated: false },
        nextValue: { type: 'number', preview: '4', truncated: false },
        triggerEventId: otherInteraction.id,
      },
    }),
    makeEvent({
      kind: 'fetch',
      name: 'GET',
      traceId: TRACE_OTHER,
      startTime: at(98),
      duration: 6,
      attributes: {
        'http.method': 'GET',
        url: '/api/alpha',
        'http.status_code': 200,
        request_key: 'key-alpha',
        component: 'Alpha',
      },
      redacted: [URL_REDACTION_PATH],
    }),
    queryEvent('SELECT alpha FROM rows WHERE id = $1', 99, 8),
  ];
}

/**
 * One generated panel's aggregate nodes, every-kind sources first: the first
 * takes the traversal and every later one is answered from its bundle.
 */
const COLD_PANEL_ORDER: readonly DataQuerySource[] = [
  'queries',
  'stateTransitions',
  'graph',
  'metrics',
  'renders',
  'componentTree',
  'requests',
];

/** A panel filter, and how many scans one traversal under it takes. */
const COLD_PANEL_CASES: readonly (readonly [string, DataQueryFilter, number])[] = [
  ['a trace filter', { traceId: TRACE_MAIN }, 1],
  ['a filter that narrows by tier', { tier: 'browser' }, 2],
];

/** The filters the shared traversal is proven equal to each source's own read under. */
const EQUALITY_FILTERS: readonly (readonly [string, DataQueryFilter | undefined])[] = [
  ['no filter', undefined],
  ['a trace filter', { traceId: TRACE_MAIN }],
  [
    'a component, kinds, tier and minDuration filter',
    { component: 'Alpha', kinds: ['render', 'state', 'fetch'], tier: 'browser', minDuration: 0 },
  ],
];

/**
 * The fake store with its first scan answered "larger than the budget" from
 * the count alone. The first scan of a cold every-kind read is the shared
 * traversal's, so the resolver falls back to the source's own read, which the
 * store then serves in full — the per-source path, driven through the
 * resolver's own code.
 */
function withoutSharedTraversal(store: FakeTelemetryRepo): PanelTelemetryPort {
  let refused = false;
  return {
    ...store,
    scanEvents: (filter, maxRows) => {
      if (!refused) {
        refused = true;
        return ok({ rows: [], total: maxRows + 1, complete: false });
      }
      return store.scanEvents(filter, maxRows);
    },
  };
}

describe('the shared traversal', () => {
  it('is taken on a miss by exactly the sources that read every kind; the others read their own slice', async () => {
    for (const source of AGGREGATE_SOURCES) {
      const { resolver, store } = harness(everythingFixture());
      const inputs = await recordAggregateInputs(async () => {
        await resolved(resolver, { source });
      });
      if (SHARED_TRAVERSAL_SOURCES.includes(source)) {
        // One read of the capture, and every aggregate source computed from it.
        expect(store.scans).toHaveLength(1);
        expect(store.scans[0]?.kinds).toBeUndefined();
        expect(inputs.map((input) => input.aggregate).sort()).toStrictEqual(
          [...AGGREGATE_SOURCES].sort(),
        );
      } else {
        // A subset source never widens its read to every kind.
        expect(store.scans).toHaveLength(1);
        expect(store.scans[0]?.kinds).toBeDefined();
        expect(inputs.map((input) => input.aggregate)).toStrictEqual([source]);
      }
    }
  });

  it.each(EQUALITY_FILTERS)(
    'hands every aggregate, under %s, exactly the rows of its own read, in the same order',
    async (_label, filter) => {
      const events = equalityFixture();
      const shared = await recordAggregateInputs(async () => {
        await resolved(harness(events).resolver, { source: 'graph', ...optionalFilter(filter) });
      });
      expect(shared.map((input) => input.aggregate).sort()).toStrictEqual(
        [...AGGREGATE_SOURCES].sort(),
      );
      expect(shared.some((input) => input.ids.length > 0)).toBe(true);

      for (const source of AGGREGATE_SOURCES) {
        const store = createFakeTelemetryRepo(events);
        const telemetry = SHARED_TRAVERSAL_SOURCES.includes(source)
          ? withoutSharedTraversal(store)
          : store;
        const own = await recordAggregateInputs(async () => {
          await resolved(harness(events, { telemetry }).resolver, {
            source,
            ...optionalFilter(filter),
          });
        });
        expect(own.map((input) => input.aggregate)).toStrictEqual([source]);
        expect(shared.find((input) => input.aggregate === source)?.ids).toStrictEqual(own[0]?.ids);
      }
    },
  );

  it.each(EQUALITY_FILTERS)(
    'answers the metrics of a traversal under %s exactly as a metrics read of its own does',
    async (_label, filter) => {
      // A statement observed twice — a driver span nested in the ORM's — so
      // `query_count` depends on the duplicate rule, which a traversal that
      // reuses its query groups for the metrics must keep.
      const statement = 'SELECT z FROM rows WHERE id = $1';
      const outer = queryEvent(statement, 99, 4);
      const inner = makeEvent({
        kind: 'db.query',
        name: 'SELECT',
        parentSpanId: outer.spanId,
        startTime: at(99.5),
        duration: 2,
        attributes: { 'db.system': 'postgresql', 'db.statement': statement },
        redacted: [STATEMENT_REDACTION_PATH],
      });
      const events = [...equalityFixture(), outer, inner];
      const query: DataQuery = { source: 'metrics', ...optionalFilter(filter) };

      // Cold `queries` first: the traversal computes every source, the metrics
      // among them, and the metrics read is then answered from its bundle.
      const { resolver, store } = harness(events);
      await resolved(resolver, { source: 'queries', ...optionalFilter(filter) });
      const scans = store.scans.length;
      const shared = metricsOf(await resolved(resolver, query));
      expect(store.scans).toHaveLength(scans);

      const own = metricsOf(
        await resolved(
          harness(events, { telemetry: withoutSharedTraversal(createFakeTelemetryRepo(events)) })
            .resolver,
          query,
        ),
      );
      expect(shared).toStrictEqual(own);
      if (filter === undefined || filter.traceId !== undefined) {
        expect(shared.find((metric) => metric.id === 'query_count')?.value).toBeGreaterThan(0);
      }
    },
  );

  it('proves the equality over inputs the filters actually narrow', async () => {
    const events = equalityFixture();
    // One at a time: the recorder is shared.
    const recorded: AggregateInput[][] = [];
    for (const [, filter] of EQUALITY_FILTERS) {
      recorded.push(
        await recordAggregateInputs(async () => {
          await resolved(harness(events).resolver, { source: 'graph', ...optionalFilter(filter) });
        }),
      );
    }
    const [whole, trace, narrowed] = recorded;
    const idsOf = (inputs: readonly AggregateInput[] | undefined, source: string): number =>
      inputs?.find((input) => input.aggregate === source)?.ids.length ?? 0;
    for (const source of AGGREGATE_SOURCES) {
      expect(idsOf(trace, source)).toBeLessThanOrEqual(idsOf(whole, source));
    }
    // The trace filter drops the other trace; the narrowing filter keeps only
    // `Alpha`'s subjects of the chosen kinds while the context stays whole.
    expect(idsOf(trace, 'graph')).toBeLessThan(idsOf(whole, 'graph'));
    expect(idsOf(narrowed, 'graph')).toBeLessThan(idsOf(trace, 'graph'));
    expect(idsOf(narrowed, 'stateTransitions')).toBeGreaterThan(idsOf(narrowed, 'graph'));
    expect(idsOf(narrowed, 'renders')).toBeGreaterThan(0);
  });

  it.each(COLD_PANEL_CASES)(
    'answers a cold panel of every aggregate source under %s from one traversal, and its repeats from memory',
    async (_label, filter, statements) => {
      const { resolver, store } = harness(equalityFixture());
      const panel: DataQuery[] = COLD_PANEL_ORDER.map((source) => ({ source, filter }));

      for (const query of panel) {
        await resolved(resolver, query);
      }
      expect(store.calls).toHaveLength(0);
      expect(store.scans).toHaveLength(statements);
      if (statements === 2) {
        // The filter's own selection first, then the trace's whole slice with
        // what the ceiling leaves.
        const [selection, whole] = store.scans;
        expect(selection).toMatchObject({ tier: 'browser', maxRows: MAX_AGGREGATE_INPUT_EVENTS });
        expect(whole?.tier).toBeUndefined();
        expect(whole?.maxRows).toBeLessThan(MAX_AGGREGATE_INPUT_EVENTS);
      }

      for (const query of panel) {
        await resolved(resolver, query);
      }
      expect(store.scans).toHaveLength(statements);
      expect(store.stampCalls).toHaveLength(0);
      expect(store.generationCalls).toHaveLength(2 * panel.length);
    },
  );

  it('falls back to each source’s own slice when the traversal is too large, refusing only a slice that is', async () => {
    const alphaRender = renderEvent('Alpha', 1);
    const port = scriptedTelemetry((filter, maxRows) => {
      if (filter.component === undefined) {
        // The trace's whole slice is past the ceiling; a context half is not.
        return ok(
          countedScan(filter.kinds === undefined ? MAX_AGGREGATE_INPUT_EVENTS + 1 : 1_000, maxRows),
        );
      }
      if (filter.kinds === undefined) {
        // So is the filter's own selection of every kind.
        return ok(countedScan(MAX_AGGREGATE_INPUT_EVENTS + 1, maxRows));
      }
      if (filter.kinds.every((kind) => RENDER_KINDS.includes(kind))) {
        return ok({ rows: [alphaRender], total: 1, complete: true });
      }
      return ok(countedScan(10, maxRows));
    });
    const { resolver, records } = harness([], { telemetry: port });
    const filter: DataQueryFilter = { component: 'Alpha' };

    // Subject-narrowed: its context half and its subjects fit together.
    expect(await resolved(resolver, { source: 'queries', filter })).toMatchObject({ total: 0 });
    expect(await resolved(resolver, { source: 'stateTransitions', filter })).toMatchObject({
      total: 0,
    });
    // A subset source reads its own, small slice.
    const renders = await resolved(resolver, { source: 'renders', filter });
    expect(
      renders.source === 'renders' ? renders.renders.map((row) => row.component) : [],
    ).toStrictEqual(['Alpha']);
    // Its own slice is the filter's whole selection, which does not fit.
    const graph = await refused(resolver, { source: 'graph', filter });
    expect(graph.code).toBe('PANEL_INVALID');
    expect(graph.details).toMatchObject({
      source: 'graph',
      total: MAX_AGGREGATE_INPUT_EVENTS + 1,
      reason: 'aggregate-input-too-large',
    });
    expect(records.some((record) => record.level === 'error')).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The aggregate cache
 * ---------------------------------------------------------------------------------------------- */

describe('the aggregate cache', () => {
  it('computes an aggregate once while the capture is unchanged, across pages, sorts and repeats', async () => {
    const { resolver, store } = harness(renderFixture());
    const first = await resolved(resolver, { source: 'renders', limit: 3 });
    const reads = store.scans.length;
    expect(reads).toBe(1);

    await resolved(resolver, { source: 'renders', limit: 3, offset: 3 });
    await resolved(resolver, { source: 'renders', sort: 'duration_desc' });
    const again = await resolved(resolver, { source: 'renders', limit: 3 });

    expect(again).toStrictEqual(first);
    expect(store.scans).toHaveLength(reads);
    // Every read is validated against the generation, hit or miss — and a hit
    // reads nothing else: no stamp, no count, no row.
    expect(store.generationCalls).toHaveLength(4);
    expect(store.stampCalls).toHaveLength(0);
  });

  it('answers a hit with one generation read and nothing else, for every aggregate source and the unfiltered metrics', async () => {
    const events = everythingFixture();
    const prefix = computeCaptureSummary(events.slice(0, 2), {
      captureId: CAPTURE_A1,
      sessionId: SESSION_A,
    });
    const covering = computeCaptureSummary(events, {
      captureId: CAPTURE_A1,
      sessionId: SESSION_A,
    });
    for (const summary of [undefined, covering, prefix]) {
      let loads = 0;
      const summaries: CaptureSummaryPort = {
        loadCaptureSummary: () => {
          loads += 1;
          return Promise.resolve(
            summary === undefined
              ? err(new DebuggenError('STORE_ERROR', 'No summary is held.'))
              : ok(summary),
          );
        },
      };
      const { resolver, store } = harness(events, { summaries });
      const panel: DataQuery[] = [
        ...AGGREGATE_SOURCES.map((source) => ({ source })),
        {
          source: 'metrics',
          filter: { tier: 'browser' },
        },
      ];
      for (const query of panel) {
        await resolved(resolver, query);
      }
      const warm = {
        scans: store.scans.length,
        stamps: store.stampCalls.length,
        generations: store.generationCalls.length,
        loads,
      };
      expect(warm.loads).toBe(1);

      for (let round = 0; round < 3; round += 1) {
        for (const query of panel) {
          await resolved(resolver, query);
        }
      }
      expect(store.scans).toHaveLength(warm.scans);
      expect(store.calls).toHaveLength(0);
      expect(store.stampCalls).toHaveLength(warm.stamps);
      expect(loads).toBe(warm.loads);
      expect(store.generationCalls).toHaveLength(warm.generations + 3 * panel.length);
    }
  });

  it('recomputes as soon as the capture’s rows change, so a reloaded panel sees what arrived since', async () => {
    const events = renderFixture();
    const { resolver, store } = harness(events);
    const query: DataQuery = { source: 'renders', filter: { component: 'Hotel' } };
    const countOf = (result: DataResult): number | undefined =>
      result.source === 'renders' ? result.renders[0]?.renderCount : undefined;

    expect(countOf(await resolved(resolver, query))).toBe(1);
    const afterFirst = store.scans.length;

    const late = renderEvent('Hotel', 30);
    events.push(late);
    expect(countOf(await resolved(resolver, query))).toBe(2);
    expect(store.scans.length).toBeGreaterThan(afterFirst);

    const afterArrival = store.scans.length;
    events.splice(events.indexOf(late), 1);
    expect(countOf(await resolved(resolver, query))).toBe(1);
    expect(store.scans.length).toBeGreaterThan(afterArrival);
  });

  it('recomputes when the generation moves though this connection changed no row', async () => {
    const store = createFakeTelemetryRepo(everythingFixture());
    let dataVersion = 0;
    // Another connection's commit moves `dataVersion` alone.
    const port: PanelTelemetryPort = {
      ...store,
      captureGeneration: (sessionId, captureId) => {
        const generation = store.captureGeneration(sessionId, captureId);
        return generation.ok ? ok({ ...generation.value, dataVersion }) : generation;
      },
    };
    const { resolver } = harness([], { telemetry: port });
    const first = await resolved(resolver, { source: 'queries' });
    await resolved(resolver, { source: 'renders' });
    expect(store.scans).toHaveLength(1);

    dataVersion += 1;
    expect(await resolved(resolver, { source: 'queries' })).toStrictEqual(first);
    expect(store.scans).toHaveLength(2);
    await resolved(resolver, { source: 'renders' });
    expect(store.scans).toHaveLength(2);
  });

  it('keys an entry by filter and capture — one entry serving every source — and reads a kind list as a set', async () => {
    const { resolver, store } = harness(renderFixture());
    const readsAfter = async (query: DataQuery, context?: PanelDataContext): Promise<number> => {
      await resolved(resolver, query, context);
      return store.scans.length;
    };

    const plain = await readsAfter({ source: 'renders' });
    const filtered = await readsAfter({ source: 'renders', filter: { component: 'Charlie' } });
    expect(filtered).toBeGreaterThan(plain);
    // The entry has no component tree yet, and a subset source reads only its own slice.
    const otherSource = await readsAfter({ source: 'componentTree' });
    expect(otherSource).toBeGreaterThan(filtered);
    const otherCapture = await readsAfter(
      { source: 'renders' },
      { sessionId: SESSION_A, captureId: CAPTURE_A2 },
    );
    expect(otherCapture).toBeGreaterThan(otherSource);
    expect(store.scans.at(-1)?.captureId).toBe(CAPTURE_A2);

    // One traversal fills the unfiltered entry for every source not yet read.
    const traversed = await readsAfter({ source: 'graph' });
    expect(traversed).toBe(otherCapture + 1);
    expect(await readsAfter({ source: 'requests' })).toBe(traversed);
    expect(await readsAfter({ source: 'stateTransitions' })).toBe(traversed);

    const listed = await readsAfter({ source: 'renders', filter: { kinds: ['render', 'commit'] } });
    expect(listed).toBeGreaterThan(traversed);
    expect(await readsAfter({ source: 'renders', filter: { kinds: ['commit', 'render'] } })).toBe(
      listed,
    );
  });

  it('never caches a failure', async () => {
    const inner = createFakeTelemetryRepo(renderFixture());
    let failing = true;
    const flaky: PanelTelemetryPort = {
      query: (query) => inner.query(query),
      scanEvents: (filter, maxRows) =>
        failing
          ? err(new DebuggenError('STORE_ERROR', 'The store is unavailable.'))
          : inner.scanEvents(filter, maxRows),
      firstTraceId: (sessionId, captureId) => inner.firstTraceId(sessionId, captureId),
      captureStamp: (sessionId, captureId) => inner.captureStamp(sessionId, captureId),
      captureGeneration: (sessionId, captureId) => inner.captureGeneration(sessionId, captureId),
    };
    const { resolver } = harness([], { telemetry: flaky });
    expect((await refused(resolver, { source: 'renders' })).code).toBe('STORE_ERROR');
    expect((await refused(resolver, { source: 'graph' })).code).toBe('STORE_ERROR');
    failing = false;
    expect(await resolved(resolver, { source: 'renders' })).toMatchObject({ total: 8 });
    expect(await resolved(resolver, { source: 'graph' })).toMatchObject({ source: 'graph' });
  });

  it('evicts the least recently used entry past AGGREGATE_CACHE_MAX_ENTRIES', async () => {
    const { resolver, store } = harness(renderFixture());
    const byIndex = (index: number): DataQuery => ({
      source: 'renders',
      filter: { minDuration: index / 1_000 },
    });
    for (let index = 0; index <= AGGREGATE_CACHE_MAX_ENTRIES; index += 1) {
      await resolved(resolver, byIndex(index));
    }
    const filled = store.scans.length;

    await resolved(resolver, byIndex(AGGREGATE_CACHE_MAX_ENTRIES));
    expect(store.scans).toHaveLength(filled);
    await resolved(resolver, byIndex(0));
    expect(store.scans).toHaveLength(filled + 1);
  });

  it('bounds the cache by the events its entries read, keeping the newest write when a merge would pass it', async () => {
    const render = renderEvent('Alpha', 1);
    const request = requestEvent('key-one', '/api/one', 2);
    const heavyRows = Array.from({ length: AGGREGATE_CACHE_MAX_INPUT_EVENTS }, () => render);
    const port = scriptedTelemetry((filter, maxRows) => {
      let rows: TelemetryEvent[] = [];
      if (filter.kinds?.includes('render') === true) {
        rows = filter.minDuration === 1 ? [render] : heavyRows;
      } else if (filter.kinds?.includes('fetch') === true) {
        rows = [request];
      }
      return ok({ rows, total: rows.length, complete: rows.length <= maxRows });
    });
    let scans = 0;
    const counted: PanelTelemetryPort = {
      ...port,
      scanEvents: (filter, maxRows) => {
        scans += 1;
        return port.scanEvents(filter, maxRows);
      },
    };
    const { resolver } = harness([], { telemetry: counted });
    const heavy: DataQuery = { source: 'renders', filter: { minDuration: 0 } };
    const light: DataQuery = { source: 'renders', filter: { minDuration: 1 } };

    // An entry at the bound is kept...
    await resolved(resolver, heavy);
    await resolved(resolver, heavy);
    expect(scans).toBe(1);
    // ...and evicted, least recently used first, once another entry would pass it.
    await resolved(resolver, light);
    await resolved(resolver, light);
    expect(scans).toBe(2);
    await resolved(resolver, heavy);
    expect(scans).toBe(3);

    // A second source of the heavy entry's filter — its context half and its
    // subjects, two scans — would take the merged entry past the bound: the
    // newest write is kept alone, and the heavy slot is read again.
    await resolved(resolver, { source: 'requests', filter: { minDuration: 0 } });
    expect(scans).toBe(5);
    await resolved(resolver, { source: 'requests', filter: { minDuration: 0 } });
    expect(scans).toBe(5);
    await resolved(resolver, heavy);
    expect(scans).toBe(6);
  });

  it('stops weighing a write once the traversal replaced every slot it supplied', async () => {
    const render = renderEvent('Alpha', 1);
    const work = makeEvent({ kind: 'function', startTime: at(2) });
    const renders = Array.from({ length: 60_000 }, () => render);
    const whole = [...renders, ...Array.from({ length: 40_000 }, () => work)];
    const other = Array.from({ length: 120_000 }, () => render);
    let scans = 0;
    const port = scriptedTelemetry((filter, maxRows) => {
      scans += 1;
      let rows: TelemetryEvent[] = whole;
      if (filter.minDuration !== undefined) {
        rows = other;
      } else if (filter.kinds !== undefined) {
        rows = renders;
      }
      return ok({ rows, total: rows.length, complete: rows.length <= maxRows });
    });
    const { resolver } = harness([], { telemetry: port });
    const elsewhere: DataQuery = { source: 'renders', filter: { minDuration: 0 } };

    await resolved(resolver, elsewhere); // 120 000 events, in its own entry
    await resolved(resolver, { source: 'renders' }); // 60 000 more, in the unfiltered entry
    // The traversal (100 000) replaces the render slot, so the unfiltered entry
    // weighs 100 000 rather than 160 000, and both entries stay within the bound.
    await resolved(resolver, { source: 'queries' });
    expect(scans).toBe(3);
    await resolved(resolver, elsewhere);
    await resolved(resolver, { source: 'renders' });
    await resolved(resolver, { source: 'graph' });
    expect(scans).toBe(3);
  });

  it('keeps one 100 000-event capture as one bundle across all seven sources', async () => {
    const base = everythingFixture();
    const events = [...base, ...manyEvents(100_000 - base.length)];
    expect(events).toHaveLength(100_000);
    const { resolver, store } = harness(events);
    // The subset sources first, each reading its own slice, then one traversal
    // that serves the rest and retires the subset reads' weight.
    const order: readonly DataQuerySource[] = [
      'renders',
      'componentTree',
      'requests',
      'queries',
      'stateTransitions',
      'graph',
      'metrics',
    ];
    for (const source of order) {
      await resolved(resolver, { source });
    }
    expect(store.scans).toHaveLength(4);

    for (let round = 0; round < 2; round += 1) {
      for (const source of order) {
        await resolved(resolver, { source });
      }
    }
    expect(store.scans).toHaveLength(4);
  });
});

/* -------------------------------------------------------------------------------------------------
 * trace
 * ---------------------------------------------------------------------------------------------- */

/** The event ids of a tree in canonical pre-order: parents first, siblings as ordered. */
function preOrderIds(tree: TraceTree | null | undefined): string[] {
  const ids: string[] = [];
  const stack: TraceNode[] = [...(tree?.roots ?? [])].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    ids.push(node.event.id);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
  return ids;
}

describe('trace', () => {
  const TRACE_EARLY: TraceId = traceIdFor(10);
  const TRACE_LATE: TraceId = traceIdFor(11);

  /** Two interactions in capture A1, and the early trace id reused in capture A2. */
  function traceFixture(): TelemetryEvent[] {
    const earlyRoot = makeEvent({ kind: 'interaction', traceId: TRACE_EARLY, startTime: at(0) });
    const lateRoot = makeEvent({ kind: 'interaction', traceId: TRACE_LATE, startTime: at(100) });
    return [
      earlyRoot,
      makeEvent({
        kind: 'fetch',
        traceId: TRACE_EARLY,
        parentSpanId: earlyRoot.spanId,
        startTime: at(1),
      }),
      lateRoot,
      makeEvent({
        kind: 'fetch',
        traceId: TRACE_LATE,
        parentSpanId: lateRoot.spanId,
        startTime: at(101),
      }),
      makeEvent({ kind: 'interaction', traceId: TRACE_EARLY, captureId: CAPTURE_A2 }),
    ];
  }

  it('resolves the named trace from this capture only, as one object with no page', async () => {
    const { resolver, correlator, store } = harness(traceFixture());
    const result = await resolved(resolver, {
      source: 'trace',
      filter: { traceId: TRACE_EARLY },
      limit: 1,
    });
    expect(Object.keys(result).sort()).toStrictEqual(['source', 'trace']);
    expect(result).not.toHaveProperty('total');
    expect(result).not.toHaveProperty('nextOffset');
    expect(result.source).toBe('trace');
    if (result.source === 'trace') {
      expect(result.trace?.traceId).toBe(TRACE_EARLY);
      expect(result.trace?.nodeCount).toBe(2);
      expect(result.trace?.truncated).toBe(false);
    }
    expect(correlator.calls).toStrictEqual([
      { method: 'getTrace', sessionId: SESSION_A, traceId: TRACE_EARLY, captureId: CAPTURE_A1 },
    ]);
    expect(store.calls).toHaveLength(0);
    expect(store.scans).toHaveLength(0);
    expect(store.firstTraceCalls).toHaveLength(0);
  });

  /** A capture whose stored summary names `primaryTraceId` as its primary trace. */
  function withPrimaryTrace(events: readonly TelemetryEvent[], primaryTraceId: TraceId): Harness {
    const summary = computeCaptureSummary(
      events.filter((event) => event.captureId === CAPTURE_A1),
      { captureId: CAPTURE_A1, sessionId: SESSION_A },
    );
    return harness(events, {
      captures: [
        storedCapture(SESSION_A, CAPTURE_A1, {
          stopped: true,
          summary: { ...summary, primaryTraceId },
        }),
      ],
    });
  }

  it('defaults to the stored primary trace, read directly, without looking for another', async () => {
    const { resolver, correlator, store } = withPrimaryTrace(traceFixture(), TRACE_LATE);
    const result = await resolved(resolver, { source: 'trace' });
    expect(result.source).toBe('trace');
    if (result.source === 'trace') {
      expect(result.trace?.traceId).toBe(TRACE_LATE);
    }
    expect(correlator.calls).toStrictEqual([
      { method: 'getTrace', sessionId: SESSION_A, traceId: TRACE_LATE, captureId: CAPTURE_A1 },
    ]);
    expect(store.firstTraceCalls).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
    expect(store.scans).toHaveLength(0);
  });

  it('defaults to the capture’s earliest trace, one indexed read, when no primary trace is held', async () => {
    const plain = harness(traceFixture());
    const first = await resolved(plain.resolver, { source: 'trace' });
    expect(first.source).toBe('trace');
    if (first.source === 'trace') {
      expect(first.trace?.traceId).toBe(TRACE_EARLY);
    }
    expect(plain.store.firstTraceCalls).toStrictEqual([
      { sessionId: SESSION_A, captureId: CAPTURE_A1 },
    ]);
    expect(plain.correlator.calls).toStrictEqual([
      { method: 'getTrace', sessionId: SESSION_A, traceId: TRACE_EARLY, captureId: CAPTURE_A1 },
    ]);

    // A primary trace the capture no longer holds falls back to the earliest one.
    const stale = withPrimaryTrace(traceFixture(), TRACE_UNKNOWN);
    const fallback = await resolved(stale.resolver, { source: 'trace' });
    expect(fallback.source).toBe('trace');
    if (fallback.source === 'trace') {
      expect(fallback.trace?.traceId).toBe(TRACE_EARLY);
    }
    expect(stale.correlator.calls.map((call) => call.traceId)).toStrictEqual([
      TRACE_UNKNOWN,
      TRACE_EARLY,
    ]);
    expect(stale.store.firstTraceCalls).toHaveLength(1);
  });

  it('breaks a tie at the earliest instant toward the event that arrived first, not the smaller trace id', async () => {
    // Stored first, so it carries the lower arrival number — and the larger trace id.
    const arrivedFirst = makeEvent({ kind: 'interaction', traceId: TRACE_LATE, startTime: at(0) });
    const arrivedSecond = makeEvent({
      kind: 'interaction',
      traceId: TRACE_EARLY,
      startTime: at(0),
    });
    expect(arrivedFirst.ingestSeq).toBeLessThan(arrivedSecond.ingestSeq);
    expect(byCodeUnit(TRACE_EARLY, TRACE_LATE)).toBeLessThan(0);

    const { resolver, store, correlator } = harness([arrivedSecond, arrivedFirst]);
    const result = await resolved(resolver, { source: 'trace' });
    expect(result.source).toBe('trace');
    if (result.source === 'trace') {
      expect(result.trace?.traceId).toBe(TRACE_LATE);
    }
    // The store's own rule, taken as it answers: one lookup, one trace read.
    expect(store.firstTraceCalls).toStrictEqual([{ sessionId: SESSION_A, captureId: CAPTURE_A1 }]);
    expect(correlator.calls.map((call) => call.traceId)).toStrictEqual([TRACE_LATE]);
  });

  /** An interaction with a request and a handler under it, and a statement under the request. */
  function branchingTrace(): {
    readonly events: TelemetryEvent[];
    readonly root: TelemetryEvent;
    readonly request: TelemetryEvent;
    readonly handler: TelemetryEvent;
    readonly statement: TelemetryEvent;
  } {
    const root = makeEvent({ kind: 'interaction', traceId: TRACE_OTHER, startTime: at(200) });
    const request = makeEvent({
      kind: 'fetch',
      traceId: TRACE_OTHER,
      parentSpanId: root.spanId,
      startTime: at(201),
      duration: 40,
    });
    const handler = makeEvent({
      kind: 'function',
      traceId: TRACE_OTHER,
      parentSpanId: root.spanId,
      startTime: at(202),
      duration: 2,
    });
    const statement = makeEvent({
      kind: 'db.query',
      traceId: TRACE_OTHER,
      parentSpanId: request.spanId,
      startTime: at(210),
      duration: 30,
    });
    return { events: [root, request, handler, statement], root, request, handler, statement };
  }

  it('narrows a trace to the nodes the filter matches and every ancestor of one', async () => {
    const { events, root, request, handler, statement } = branchingTrace();
    const { resolver, store } = harness(events);
    const shaped = async (filter: DataQueryFilter): Promise<TraceTree | null> => {
      const result = await resolved(resolver, { source: 'trace', filter });
      return result.source === 'trace' ? result.trace : null;
    };

    const whole = await shaped({ traceId: TRACE_OTHER });
    expect(preOrderIds(whole)).toStrictEqual([root.id, request.id, statement.id, handler.id]);

    const statements = await shaped({ traceId: TRACE_OTHER, kinds: ['db.query'] });
    expect(preOrderIds(statements)).toStrictEqual([root.id, request.id, statement.id]);
    expect(statements?.nodeCount).toBe(3);
    expect(statements?.maxDepth).toBe(2);
    expect(statements?.truncated).toBe(false);
    expect(statements?.kinds).toStrictEqual(
      TELEMETRY_KINDS.filter((kind) => ['interaction', 'fetch', 'db.query'].includes(kind)),
    );
    // The matching is the store's own read — one scan — scoped to the trace and the capture.
    expect(store.calls).toHaveLength(0);
    expect(store.scans.at(-1)).toMatchObject({
      sessionId: SESSION_A,
      captureId: CAPTURE_A1,
      traceId: TRACE_OTHER,
      kinds: ['db.query'],
    });

    const slow = await shaped({ traceId: TRACE_OTHER, minDuration: 35 });
    expect(preOrderIds(slow)).toStrictEqual([root.id, request.id]);

    const rootOnly = await shaped({ traceId: TRACE_OTHER, kinds: ['interaction'] });
    expect(preOrderIds(rootOnly)).toStrictEqual([root.id]);
    expect(rootOnly?.roots[0]?.children).toStrictEqual([]);
  });

  it('answers a filter no node of the trace matches with null', async () => {
    const { events } = branchingTrace();
    const { resolver } = harness(events);
    for (const filter of [
      { traceId: TRACE_OTHER, component: 'Nobody' },
      { traceId: TRACE_OTHER, kinds: [] },
      { traceId: TRACE_OTHER, tier: 'server' },
    ] satisfies DataQueryFilter[]) {
      expect(await resolved(resolver, { source: 'trace', filter })).toStrictEqual({
        source: 'trace',
        trace: null,
      });
    }
  });

  it('holds every trace to TRACE_NODE_BUDGET nodes in canonical pre-order, flagged truncated', async () => {
    const root = makeEvent({ kind: 'interaction', traceId: TRACE_OTHER, startTime: at(300) });
    const children = Array.from({ length: TRACE_NODE_BUDGET + 9 }, (_, index) =>
      makeEvent({
        kind: 'function',
        traceId: TRACE_OTHER,
        parentSpanId: root.spanId,
        startTime: at(301 + index / 1_000),
      }),
    );
    const { resolver } = harness([root, ...children]);
    const result = await resolved(resolver, { source: 'trace', filter: { traceId: TRACE_OTHER } });
    expect(result.source).toBe('trace');
    if (result.source === 'trace') {
      expect(result.trace?.nodeCount).toBe(TRACE_NODE_BUDGET);
      expect(result.trace?.truncated).toBe(true);
      expect(result.trace?.primaryRootSpanId).toBe(root.spanId);
      expect(preOrderIds(result.trace)).toStrictEqual([
        root.id,
        ...children.slice(0, TRACE_NODE_BUDGET - 1).map((child) => child.id),
      ]);
    }
  });

  it('answers an unknown trace id, and a capture without traces, with null rather than an error', async () => {
    const known = harness(traceFixture());
    const unknown = await resolved(known.resolver, {
      source: 'trace',
      filter: { traceId: TRACE_UNKNOWN },
    });
    expect(unknown).toStrictEqual({ source: 'trace', trace: null });
    expect(known.correlator.calls).toStrictEqual([
      { method: 'getTrace', sessionId: SESSION_A, traceId: TRACE_UNKNOWN, captureId: CAPTURE_A1 },
    ]);

    const empty = harness([]);
    expect(await resolved(empty.resolver, { source: 'trace' })).toStrictEqual({
      source: 'trace',
      trace: null,
    });
    expect(empty.correlator.calls).toHaveLength(0);
    expect(empty.store.firstTraceCalls).toStrictEqual([
      { sessionId: SESSION_A, captureId: CAPTURE_A1 },
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * metrics
 * ---------------------------------------------------------------------------------------------- */

describe('metrics', () => {
  /** A capture with requests, statements and renders, and no resource timing. */
  function metricFixture(): TelemetryEvent[] {
    return [
      requestEvent('key-one', '/api/one', 0),
      requestEvent('key-one', '/api/one', 10),
      queryEvent('SELECT value FROM rows WHERE id = $1', 12),
      renderEvent('Alpha', 20),
    ];
  }

  /** The summary of the fixture's capture, with its metric values reversed. */
  function reversedSummary(events: readonly TelemetryEvent[]): CaptureSummary {
    const summary = computeCaptureSummary(events, { captureId: CAPTURE_A1, sessionId: SESSION_A });
    return { ...summary, metrics: [...summary.metrics].reverse() };
  }

  it('returns every metric of the loaded summary in METRIC_IDS order when no sort is named, unavailable ones included', async () => {
    const events = metricFixture();
    let loads = 0;
    const summaries: CaptureSummaryPort = {
      loadCaptureSummary: (sessionId, captureId) => {
        loads += 1;
        expect([sessionId, captureId]).toStrictEqual([SESSION_A, CAPTURE_A1]);
        return Promise.resolve(ok(reversedSummary(events)));
      },
    };
    const { resolver } = harness(events, { summaries });
    const result = await resolved(resolver, { source: 'metrics' });

    expect(loads).toBe(1);
    expect(result.source).toBe('metrics');
    if (result.source === 'metrics') {
      expect(result.metrics.map((metric) => metric.id)).toStrictEqual([...METRIC_IDS]);
      expect(result.total).toBe(METRIC_IDS.length);
      expect(result.nextOffset).toBeNull();
      const unavailable = result.metrics.filter((metric) => !metric.available);
      expect(unavailable.length).toBeGreaterThan(0);
      expect(unavailable.every((metric) => metric.value === undefined)).toBe(true);
      expect(unavailable.every((metric) => !('value' in metric))).toBe(true);
    }
  });

  it('answers start_asc, under which every value ties on the capture window, in METRIC_IDS order', async () => {
    const { resolver } = harness(metricFixture());
    const unsorted = await resolved(resolver, { source: 'metrics' });
    const byStart = await resolved(resolver, { source: 'metrics', sort: 'start_asc' });
    expect(rowIds(byStart)).toStrictEqual([...METRIC_IDS]);
    expect(byStart).toStrictEqual(unsorted);
  });

  it.each([
    ['duration_desc', 'milliseconds'],
    ['count_desc', 'count'],
  ] as const)(
    'answers %s with the measured %s values first, largest first, and every other value after them in METRIC_IDS order',
    async (sort, unit) => {
      const { resolver } = harness(metricFixture());
      const unsorted = metricsOf(await resolved(resolver, { source: 'metrics' }));
      expect(unsorted.map((metric) => metric.id)).toStrictEqual([...METRIC_IDS]);

      // Derived here from the unsorted answer: the values measured in the
      // sort's unit, largest first and a tie by vocabulary position; then the
      // rest — another unit, or not measured — as they were.
      const measured = unsorted.filter(
        (metric) => metric.available && metric.unit === unit && typeof metric.value === 'number',
      );
      expect(measured.length).toBeGreaterThan(1);
      const expected = [
        ...[...measured].sort(
          (left, right) =>
            (right.value ?? 0) - (left.value ?? 0) ||
            METRIC_IDS.indexOf(left.id) - METRIC_IDS.indexOf(right.id),
        ),
        ...unsorted.filter((metric) => !measured.includes(metric)),
      ];

      const sorted = await resolved(resolver, { source: 'metrics', sort });
      expect(sorted).toMatchObject({ total: METRIC_IDS.length, nextOffset: null });
      expect(metricsOf(sorted)).toStrictEqual(expected);
      expect(rowIds(sorted)).not.toStrictEqual([...METRIC_IDS]);
      const unavailable = metricsOf(sorted).findIndex((metric) => !metric.available);
      expect(unavailable).toBeGreaterThanOrEqual(measured.length);
    },
  );

  it('honours an explicit window over the sorted order, which the protocol validates', async () => {
    const { resolver } = harness(metricFixture());
    for (const sort of [undefined, ...DATA_QUERY_SORTS]) {
      const sortField = sort === undefined ? {} : { sort };
      const whole = rowIds(await resolved(resolver, { source: 'metrics', ...sortField }));
      const window = await resolved(resolver, {
        source: 'metrics',
        ...sortField,
        limit: 3,
        offset: 3,
      });
      expect(rowIds(window)).toStrictEqual(whole.slice(3, 6));
      expect(window).toMatchObject({ total: METRIC_IDS.length, offset: 3, nextOffset: 6 });
    }
    const unsorted = await resolved(resolver, { source: 'metrics', limit: 3, offset: 3 });
    expect(rowIds(unsorted)).toStrictEqual(METRIC_IDS.slice(3, 6));
  });

  it('uses the capture’s stored summary when no summary port is supplied and it covers every event', async () => {
    const events = metricFixture();
    const stored = reversedSummary(events);
    const { resolver, store } = harness(events, {
      captures: [storedCapture(SESSION_A, CAPTURE_A1, { stopped: true, summary: stored })],
    });
    const result = await resolved(resolver, { source: 'metrics' });
    expect(store.calls).toHaveLength(0);
    expect(store.scans).toHaveLength(0);
    expect(result.source).toBe('metrics');
    if (result.source === 'metrics') {
      expect(result.metrics).toStrictEqual([...stored.metrics].reverse());
      expect(result.metrics.map((metric) => metric.id)).toStrictEqual([...METRIC_IDS]);
    }
  });

  it('never serves a summary computed from fewer events than the capture now holds', async () => {
    const events = metricFixture();
    const expected = computeCaptureSummary(events, { captureId: CAPTURE_A1 }).metrics;
    // A summary of a prefix: the summarizer's bounded read, or one taken
    // before the last events arrived.
    const prefix = computeCaptureSummary(events.slice(0, 2), {
      captureId: CAPTURE_A1,
      sessionId: SESSION_A,
    });
    expect(prefix.metrics).not.toStrictEqual(expected);

    const stored = harness(events, {
      captures: [storedCapture(SESSION_A, CAPTURE_A1, { stopped: true, summary: prefix })],
    });
    const fromStored = await resolved(stored.resolver, { source: 'metrics' });
    expect(fromStored).toMatchObject({ source: 'metrics', metrics: expected });
    expect(stored.store.scans.length).toBeGreaterThan(0);

    const loaded = harness(events, {
      summaries: { loadCaptureSummary: () => Promise.resolve(ok(prefix)) },
    });
    const fromLoaded = await resolved(loaded.resolver, { source: 'metrics' });
    expect(fromLoaded).toMatchObject({ source: 'metrics', metrics: expected });
    expect(loaded.store.scans.length).toBeGreaterThan(0);
  });

  /** A capture above the aggregate ceiling, by its stored count. */
  const ABOVE_CEILING = MAX_AGGREGATE_INPUT_EVENTS + 1_234;

  /**
   * A telemetry port for a capture of `count` stored events whose every scan
   * the store answers by the count alone — past the ceiling, no row — and
   * which records how many scans it served.
   */
  function capturedAtCount(count: number): { readonly port: PanelTelemetryPort; scans(): number } {
    let scans = 0;
    return {
      port: {
        ...scriptedTelemetry((_filter, maxRows) => {
          scans += 1;
          return ok(countedScan(count, maxRows));
        }),
        captureStamp: () => ok({ count, maxIngestSeq: count }),
      },
      scans: () => scans,
    };
  }

  /**
   * The stored summary of a capture above the ceiling, as the capture stage
   * computes it: from the capture's first {@link MAX_AGGREGATE_INPUT_EVENTS}
   * events, its values reversed so the answer's order is proven to be the
   * resolver's.
   */
  function partialSummary(): CaptureSummary {
    return { ...reversedSummary(metricFixture()), eventCount: MAX_AGGREGATE_INPUT_EVENTS };
  }

  it('answers a capture above the ceiling from its stored summary, every value noted with the coverage', async () => {
    const partial = partialSummary();
    const telemetry = capturedAtCount(ABOVE_CEILING);
    const { resolver, records } = harness([], {
      telemetry: telemetry.port,
      captures: [storedCapture(SESSION_A, CAPTURE_A1, { stopped: true, summary: partial })],
    });

    const result = await resolved(resolver, { source: 'metrics' });

    // Nothing was scanned: the capture is too large for any read to aggregate.
    expect(telemetry.scans()).toBe(0);
    const note = 'Based on the first 250,000 of 251,234 captured events.';
    // At least one value carries a note of its own, which the coverage note follows.
    expect(partial.metrics.some((metric) => metric.note !== undefined)).toBe(true);
    const byId = new Map(partial.metrics.map((metric) => [metric.id, metric]));
    const metrics = metricsOf(result);
    expect(metrics.map((metric) => metric.id)).toStrictEqual([...METRIC_IDS]);
    expect(result).toMatchObject({ total: METRIC_IDS.length, nextOffset: null });
    for (const metric of metrics) {
      const summarized = byId.get(metric.id);
      expect(summarized).toBeDefined();
      // The summary's value, availability, label and unit, with the coverage
      // note after any note of its own.
      expect(metric).toStrictEqual({
        ...summarized,
        note: summarized?.note === undefined ? note : `${summarized.note} ${note}`,
      });
    }
    // An unmeasured value stays unmeasured: noted, never given a number.
    const unavailable = metrics.filter((metric) => !metric.available);
    expect(unavailable.length).toBeGreaterThan(0);
    expect(unavailable.every((metric) => !('value' in metric) && metric.note?.endsWith(note))).toBe(
      true,
    );
    expect(
      records.find((record) => record.fields['bound'] === MAX_AGGREGATE_INPUT_EVENTS)?.fields,
    ).toMatchObject({
      source: 'metrics',
      summarized: MAX_AGGREGATE_INPUT_EVENTS,
      stored: ABOVE_CEILING,
    });

    // A repeated read is the cached answer, the same noted values.
    const again = await resolved(resolver, { source: 'metrics' });
    expect(again).toStrictEqual(result);
    expect(telemetry.scans()).toBe(0);
  });

  it('notes the loaded summary of a capture above the ceiling the same way, under any sort', async () => {
    const partial = partialSummary();
    const telemetry = capturedAtCount(ABOVE_CEILING);
    const { resolver } = harness([], {
      telemetry: telemetry.port,
      summaries: { loadCaptureSummary: () => Promise.resolve(ok(partial)) },
    });

    for (const sort of [undefined, ...DATA_QUERY_SORTS]) {
      const result = await resolved(resolver, {
        source: 'metrics',
        ...(sort === undefined ? {} : { sort }),
      });
      const metrics = metricsOf(result);
      expect(metrics).toHaveLength(METRIC_IDS.length);
      expect(
        metrics.every((metric) =>
          metric.note?.endsWith('Based on the first 250,000 of 251,234 captured events.'),
        ),
      ).toBe(true);
    }
    expect(telemetry.scans()).toBe(0);
  });

  it('still refuses the metrics of a capture above the ceiling that has no summary yet', async () => {
    const telemetry = capturedAtCount(ABOVE_CEILING);
    const { resolver } = harness([], { telemetry: telemetry.port });

    const error = await refused(resolver, { source: 'metrics' });

    expect(error.code).toBe('PANEL_INVALID');
    expect(error.details).toMatchObject({
      source: 'metrics',
      total: ABOVE_CEILING,
      bound: MAX_AGGREGATE_INPUT_EVENTS,
      reason: 'aggregate-input-too-large',
    });
    expect(telemetry.scans()).toBeGreaterThan(0);
  });

  it('keeps a filtered read of a capture above the ceiling on its own slice, ignoring the summary', async () => {
    const telemetry = capturedAtCount(ABOVE_CEILING);
    let loads = 0;
    const { resolver } = harness([], {
      telemetry: telemetry.port,
      summaries: {
        loadCaptureSummary: () => {
          loads += 1;
          return Promise.resolve(ok(partialSummary()));
        },
      },
    });

    const error = await refused(resolver, { source: 'metrics', filter: { tier: 'db' } });

    expect(loads).toBe(0);
    expect(error.details).toMatchObject({ reason: 'aggregate-input-too-large' });
  });

  it('computes the values of a capture at the ceiling rather than noting a partial summary', async () => {
    const events = metricFixture();
    const expected = computeCaptureSummary(events, { captureId: CAPTURE_A1 }).metrics;
    // A summary of part of the capture, whose values differ from the whole's.
    const prefix: CaptureSummary = {
      ...computeCaptureSummary(events.slice(0, 2), { captureId: CAPTURE_A1, sessionId: SESSION_A }),
      eventCount: MAX_AGGREGATE_INPUT_EVENTS - 1,
    };
    expect(prefix.metrics).not.toStrictEqual(expected);
    const store = createFakeTelemetryRepo(events);
    // Exactly as many events as one read aggregates: the values are computed.
    const atCeiling: PanelTelemetryPort = {
      ...store,
      captureStamp: () => ok({ count: MAX_AGGREGATE_INPUT_EVENTS, maxIngestSeq: 1 }),
    };
    const { resolver } = harness(events, {
      telemetry: atCeiling,
      captures: [storedCapture(SESSION_A, CAPTURE_A1, { stopped: true, summary: prefix })],
    });

    const result = await resolved(resolver, { source: 'metrics' });

    expect(result).toMatchObject({ source: 'metrics', metrics: expected });
    expect(metricsOf(result).some((metric) => metric.note?.startsWith('Based on'))).toBe(false);
    expect(store.scans.length).toBeGreaterThan(0);
  });

  it('computes the values from the capture when no summary exists, or when the load fails', async () => {
    const events = metricFixture();
    const expected = computeCaptureSummary(events, { captureId: CAPTURE_A1 }).metrics;

    const computed = await resolved(harness(events).resolver, { source: 'metrics' });
    expect(computed.source).toBe('metrics');
    if (computed.source === 'metrics') {
      expect(computed.metrics).toStrictEqual(expected);
    }

    const failing: CaptureSummaryPort = {
      loadCaptureSummary: () =>
        Promise.resolve(err(new DebuggenError('STORE_ERROR', 'The summary could not be read.'))),
    };
    const { resolver, records } = harness(events, { summaries: failing });
    const recovered = await resolved(resolver, { source: 'metrics' });
    expect(recovered.source).toBe('metrics');
    if (recovered.source === 'metrics') {
      expect(recovered.metrics).toStrictEqual(expected);
    }
    expect(records.some((record) => record.level === 'warn')).toBe(true);
  });

  it('computes over the filtered events when the query narrows, ignoring the whole-capture summary', async () => {
    const events = metricFixture();
    let loads = 0;
    const summaries: CaptureSummaryPort = {
      loadCaptureSummary: () => {
        loads += 1;
        return Promise.resolve(ok(reversedSummary(events)));
      },
    };
    const { resolver, store } = harness(events, { summaries });
    const result = await resolved(resolver, { source: 'metrics', filter: { tier: 'db' } });
    expect(loads).toBe(0);
    expect(store.scans.some((scan) => scan.tier === 'db')).toBe(true);
    expect(result.source).toBe('metrics');
    if (result.source === 'metrics') {
      const requestCount = result.metrics.find((metric) => metric.id === 'request_count');
      const queryCount = result.metrics.find((metric) => metric.id === 'query_count');
      expect(requestCount?.value).toBe(0);
      expect(queryCount?.value).toBe(1);
    }
  });

  it('answers a session without a capture with no values at all', async () => {
    const result = await resolved(
      harness([], { captures: [] }).resolver,
      { source: 'metrics' },
      { sessionId: SESSION_A },
    );
    expect(result).toStrictEqual({
      source: 'metrics',
      metrics: [],
      total: 0,
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: DATA_QUERY_DEFAULT_OFFSET,
      nextOffset: null,
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * Capture scoping
 * ---------------------------------------------------------------------------------------------- */

describe('capture scoping', () => {
  it('refuses a named capture that belongs to another session', async () => {
    const { resolver, store } = harness(everythingFixture());
    const error = await refused(
      resolver,
      { source: 'events' },
      { sessionId: SESSION_A, captureId: CAPTURE_B1 },
    );
    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(store.calls).toHaveLength(0);
  });

  it('refuses a named capture the store does not hold', async () => {
    const { resolver } = harness(everythingFixture());
    const error = await refused(
      resolver,
      { source: 'renders' },
      { sessionId: SESSION_A, captureId: CAPTURE_UNKNOWN },
    );
    expect(error.code).toBe('SESSION_INVALID_STATE');
  });

  it('reads the open capture when none is named, and the latest one when none is open', async () => {
    const events = everythingFixture();
    const open = harness(events, {
      captures: [
        storedCapture(SESSION_A, CAPTURE_A1),
        storedCapture(SESSION_A, CAPTURE_A2, { stopped: true }),
      ],
    });
    await resolved(open.resolver, { source: 'events' }, { sessionId: SESSION_A });
    expect(open.store.calls[0]?.captureId).toBe(CAPTURE_A1);

    const lookups = lookupCounts();
    const latest = harness(events, { lookups });
    await resolved(latest.resolver, { source: 'events' }, { sessionId: SESSION_A });
    expect(latest.store.calls[0]?.captureId).toBe(CAPTURE_A2);
    // One indexed lookup of each kind — the port offers no listing to walk.
    expect(lookups).toStrictEqual({
      getCapture: 0,
      getActiveCapture: 1,
      getLatestCapture: 1,
      getPanelCapture: 0,
    });
  });

  it('breaks a tie between two captures started together toward the one stored last', async () => {
    const { resolver, store } = harness(everythingFixture(), {
      captures: [
        storedCapture(SESSION_A, CAPTURE_A1, { stopped: true }),
        storedCapture(SESSION_A, CAPTURE_A2, { stopped: true }),
      ],
    });
    await resolved(resolver, { source: 'events' }, { sessionId: SESSION_A });
    expect(store.calls[0]?.captureId).toBe(CAPTURE_A2);
  });

  it('reads the rendered panel’s own capture while a newer capture is open', async () => {
    const events = [...everythingFixture(), ...renderFixture()];
    const lookups = lookupCounts();
    const { resolver, store, correlator } = harness(events, {
      lookups,
      captures: [
        storedCapture(SESSION_A, CAPTURE_A1, { stopped: true }),
        storedCapture(SESSION_A, CAPTURE_A2, { startedAt: CAPTURE_EPOCH + 5_000 }),
      ],
    });
    const panelContext: PanelDataContext = { sessionId: SESSION_A, panelId: PANEL_A1 };

    for (const query of QUERIES_BY_SOURCE) {
      await resolved(resolver, query, panelContext);
    }
    expect(store.calls.length).toBeGreaterThan(0);
    expect(store.scans.length).toBeGreaterThan(0);
    expect(storeReads(store).every((read) => read.captureId === CAPTURE_A1)).toBe(true);
    expect(correlator.calls.every((call) => call.captureId === CAPTURE_A1)).toBe(true);
    expect(store.stampCalls.every((call) => call.captureId === CAPTURE_A1)).toBe(true);
    expect(lookups.getActiveCapture).toBe(0);
    expect(lookups.getLatestCapture).toBe(0);
    expect(lookups.getPanelCapture).toBe(QUERIES_BY_SOURCE.length);

    const bound = await resolved(resolver, { source: 'renders' }, panelContext);
    const live = await resolved(resolver, { source: 'renders' }, { sessionId: SESSION_A });
    expect(store.scans.at(-1)?.captureId).toBe(CAPTURE_A2);
    expect(bound).not.toStrictEqual(live);

    // Naming the panel's own capture as well is consistent, and reads the same.
    expect(
      await resolved(resolver, { source: 'renders' }, { ...panelContext, captureId: CAPTURE_A1 }),
    ).toStrictEqual(bound);
  });

  it('refuses a panel the session does not hold, before reading any evidence', async () => {
    const { resolver, store, correlator } = harness(everythingFixture());
    const unknownPanel: PanelId = opaqueId(ID_PREFIXES.panel, 99);
    for (const panelId of [PANEL_B1, unknownPanel]) {
      const error = await refused(
        resolver,
        { source: 'renders' },
        { sessionId: SESSION_A, panelId },
      );
      expect(error.code).toBe('SESSION_INVALID_STATE');
      expect(error.details).toMatchObject({ reason: 'panel-not-in-session' });
      expect(errorTexts(error)).not.toContain(panelId);
    }
    expect(store.calls).toHaveLength(0);
    expect(store.scans).toHaveLength(0);
    expect(store.stampCalls).toHaveLength(0);
    expect(store.generationCalls).toHaveLength(0);
    expect(correlator.calls).toHaveLength(0);
  });

  it('answers every source with its empty value once the panel’s capture has been purged', async () => {
    const { resolver, store, correlator } = harness(everythingFixture());
    for (const query of QUERIES_BY_SOURCE) {
      const result = await resolved(resolver, query, {
        sessionId: SESSION_A,
        panelId: PANEL_PURGED,
      });
      expect(result.source).toBe(query.source);
      if ('total' in result) {
        expect(result.total).toBe(0);
        expect(result.nextOffset).toBeNull();
      }
    }
    // Never the open or latest capture instead.
    expect(store.calls).toHaveLength(0);
    expect(store.scans).toHaveLength(0);
    expect(store.stampCalls).toHaveLength(0);
    expect(store.generationCalls).toHaveLength(0);
    expect(store.firstTraceCalls).toHaveLength(0);
    expect(correlator.calls).toHaveLength(0);
  });

  it('refuses a named capture that is not the panel’s own, and a panel with no lookup to find it', async () => {
    const { resolver, store } = harness(everythingFixture());
    for (const context of [
      { sessionId: SESSION_A, panelId: PANEL_A1, captureId: CAPTURE_A2 },
      { sessionId: SESSION_A, panelId: PANEL_PURGED, captureId: CAPTURE_A1 },
    ]) {
      const error = await refused(resolver, { source: 'events' }, context);
      expect(error.code).toBe('SESSION_INVALID_STATE');
      expect(error.details).toMatchObject({ reason: 'panel-capture-mismatch' });
    }
    expect(store.calls).toHaveLength(0);
    expect(store.scans).toHaveLength(0);

    const blind = harness(everythingFixture(), { withoutSessions: true });
    const error = await refused(
      blind.resolver,
      { source: 'events' },
      { sessionId: SESSION_A, panelId: PANEL_A1 },
    );
    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(error.details).toMatchObject({ reason: 'no-capture-lookup' });
    expect(blind.store.calls).toHaveLength(0);
  });

  it('never mixes two captures: with or without a named capture, every row is of the one read', async () => {
    const events = tieFixture();
    for (const [context, captureId] of [
      [CONTEXT_A1, CAPTURE_A1],
      [{ sessionId: SESSION_A }, CAPTURE_A2],
    ] as const) {
      const { resolver, store, correlator } = harness(events);
      for (const source of ['spans', 'events'] as const) {
        const result = await resolved(resolver, { source, limit: DATA_QUERY_MAX_LIMIT }, context);
        const rows = rowsOf(result);
        const expected = events.filter(
          (event) =>
            event.sessionId === SESSION_A &&
            event.captureId === captureId &&
            (source === 'events' || SPAN_SOURCE_KINDS.includes(event.kind)),
        );
        expect(rows.map((row) => row.id).sort(byCodeUnit)).toStrictEqual(
          expected.map((event) => event.id).sort(byCodeUnit),
        );
      }
      for (const query of QUERIES_BY_SOURCE) {
        await resolved(resolver, query, context);
      }
      expect(storeReads(store).every((read) => read.captureId === captureId)).toBe(true);
      expect(correlator.calls.every((call) => call.captureId === captureId)).toBe(true);
    }
  });

  it('answers every source with its empty value for a session that has not captured', async () => {
    const { resolver, store, correlator } = harness(everythingFixture(), { captures: [] });
    for (const query of QUERIES_BY_SOURCE) {
      const result = await resolved(resolver, query, { sessionId: SESSION_A });
      expect(result.source).toBe(query.source);
      if ('total' in result) {
        expect(result.total).toBe(0);
        expect(result.nextOffset).toBeNull();
      }
    }
    expect(store.calls).toHaveLength(0);
    expect(store.scans).toHaveLength(0);
    expect(correlator.calls).toHaveLength(0);
  });

  it('reads a named capture without a lookup, and refuses to guess one', async () => {
    const withCapture = harness(everythingFixture(), { withoutSessions: true });
    await resolved(withCapture.resolver, { source: 'events' });
    expect(withCapture.store.calls[0]?.captureId).toBe(CAPTURE_A1);

    const error = await refused(
      withCapture.resolver,
      { source: 'events' },
      { sessionId: SESSION_A },
    );
    expect(error.code).toBe('SESSION_INVALID_STATE');
  });

  it('scopes every store read of every source by session and capture', async () => {
    const { resolver, store } = harness(everythingFixture());
    for (const query of QUERIES_BY_SOURCE) {
      await resolved(resolver, query);
    }
    expect(store.calls.length).toBeGreaterThan(0);
    expect(store.scans.length).toBeGreaterThan(0);
    for (const read of storeReads(store)) {
      expect(read.sessionId).toBe(SESSION_A);
      expect(read.captureId).toBe(CAPTURE_A1);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Every source
 * ---------------------------------------------------------------------------------------------- */

describe('every source', () => {
  it.each(DATA_QUERY_SOURCES)(
    'answers %s with its own DataResult member',
    async (source: DataQuerySource) => {
      const { resolver } = harness(everythingFixture());
      const result = await resolved(resolver, { source });
      expect(result.source).toBe(source);
      const paged = 'total' in result;
      expect(paged).toBe(Object.keys(result).includes('nextOffset'));
    },
  );

  it('carries a page exactly on the array-valued sources', async () => {
    const { resolver } = harness(everythingFixture());
    const pagedSources: DataQuerySource[] = [];
    for (const query of QUERIES_BY_SOURCE) {
      const result = await resolved(resolver, query);
      if ('total' in result) {
        pagedSources.push(result.source);
      }
    }
    expect(pagedSources.sort()).toStrictEqual([...SORTED_SOURCES].sort());
  });

  it('answers every source for a capture that holds no events with its empty value, as a success', async () => {
    const { resolver } = harness([]);
    for (const query of QUERIES_BY_SOURCE) {
      const result = await resolved(resolver, query);
      expect(result.source).toBe(query.source);
      switch (result.source) {
        case 'trace':
          expect(result.trace).toBeNull();
          break;
        case 'componentTree':
          expect(result.componentTree).toBeNull();
          break;
        case 'graph':
          expect(result.graph.nodes).toStrictEqual([]);
          expect(result.graph.edges).toStrictEqual([]);
          break;
        case 'metrics':
          expect(rowIds(result)).toStrictEqual([...METRIC_IDS]);
          expect(result.nextOffset).toBeNull();
          break;
        default:
          expect(rowIds(result)).toStrictEqual([]);
          expect(result.total).toBe(0);
          expect(result.nextOffset).toBeNull();
      }
    }
  });

  it.each(WALK_CASES)(
    'answers %s under %s identically twice, and an omitted sort exactly as its default',
    async (source, sort) => {
      const { resolver, store } = harness(tieFixture());
      const first = await resolved(resolver, { source, sort, limit: DATA_QUERY_MAX_LIMIT });
      const second = await resolved(resolver, { source, sort, limit: DATA_QUERY_MAX_LIMIT });
      expect(rowIds(first).length).toBeGreaterThan(1);
      expect(second).toStrictEqual(first);
      if (sort === DEFAULT_SORT_BY_SOURCE[source]) {
        const omitted = await resolved(resolver, { source, limit: DATA_QUERY_MAX_LIMIT });
        expect(omitted).toStrictEqual(first);
      }
      if (source === 'spans' || source === 'events') {
        // The flat sources are ordered by the store: the named sort — or the
        // default where none was named — is exactly what reaches it.
        expect(store.calls.every((call) => call.sort === sort)).toBe(true);
      }
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * Failure
 * ---------------------------------------------------------------------------------------------- */

/** The store's own typed refusal. */
function storeRefusal(): DebuggenError {
  return new DebuggenError('STORE_ERROR', 'The store refused the read.', {
    details: { reason: 'unavailable' },
  });
}

/** A telemetry port that refuses every read with the store's own typed error. */
const REFUSING_TELEMETRY: PanelTelemetryPort = {
  query: () => err(storeRefusal()),
  scanEvents: () => err(storeRefusal()),
  firstTraceId: () => err(storeRefusal()),
  captureStamp: () => err(storeRefusal()),
  captureGeneration: () => err(storeRefusal()),
};

/** A telemetry port that throws the sentinel from every read. */
const THROWING_TELEMETRY: PanelTelemetryPort = {
  query: () => {
    throw new Error(SENTINEL);
  },
  scanEvents: () => {
    throw new Error(SENTINEL);
  },
  firstTraceId: () => {
    throw new Error(SENTINEL);
  },
  captureStamp: () => {
    throw new Error(SENTINEL);
  },
  captureGeneration: () => {
    throw new Error(SENTINEL);
  },
};

describe('failure', () => {
  it.each(DATA_QUERY_SOURCES)(
    'answers %s with the typed error of a store that refuses, never rejecting',
    async (source) => {
      const { resolver } = harness(everythingFixture(), {
        telemetry: REFUSING_TELEMETRY,
        correlatorFailure: 'refuse',
      });
      const pending = resolver.resolve(CONTEXT_A1, { source });
      await expect(pending).resolves.toMatchObject({ ok: false });
      const error = await refused(resolver, { source });
      expect(error.code).toBe('STORE_ERROR');
    },
  );

  it.each(DATA_QUERY_SOURCES)(
    'converts a throwing port behind %s into STORE_ERROR without echoing what it threw',
    async (source) => {
      const { resolver, records } = harness(everythingFixture(), {
        telemetry: THROWING_TELEMETRY,
        correlatorFailure: 'throw',
      });
      const error = await refused(resolver, { source });
      expect(error.code).toBe('STORE_ERROR');
      expect(error.details).toMatchObject({ reason: 'port-threw' });
      expectNoLeak(errorTexts(error));
      expectNoLeak(textOf(records));
    },
  );

  it('converts a throwing capture lookup into STORE_ERROR, with a named capture, a panel or neither', async () => {
    const throwing: SessionCapturePort = {
      getCapture: () => {
        throw new Error(SENTINEL);
      },
      getActiveCapture: () => {
        throw new Error(SENTINEL);
      },
      getLatestCapture: () => {
        throw new Error(SENTINEL);
      },
      getPanelCapture: () => {
        throw new Error(SENTINEL);
      },
    };
    const { resolver, store, records } = harness(everythingFixture(), { sessions: throwing });
    for (const context of [
      CONTEXT_A1,
      { sessionId: SESSION_A },
      { sessionId: SESSION_A, panelId: PANEL_A1 },
    ]) {
      const error = await refused(resolver, { source: 'events' }, context);
      expect(error.code).toBe('STORE_ERROR');
      expectNoLeak(errorTexts(error));
    }
    expect(storeReads(store)).toHaveLength(0);
    expectNoLeak(textOf(records));

    // No capture is open, so the latest-capture lookup is reached — and throws.
    const latestThrows: SessionCapturePort = {
      ...sessionsPort([]),
      getLatestCapture: () => {
        throw new Error(SENTINEL);
      },
    };
    const fallback = harness(everythingFixture(), { sessions: latestThrows });
    const error = await refused(fallback.resolver, { source: 'events' }, { sessionId: SESSION_A });
    expect(error.code).toBe('STORE_ERROR');
    expect(error.details).toMatchObject({ reason: 'port-threw' });
    expectNoLeak(errorTexts(error));
    expect(storeReads(fallback.store)).toHaveLength(0);
  });

  it('fails a subject-narrowed read whose second scan fails instead of answering from the first', async () => {
    const interaction = makeEvent({ kind: 'interaction', name: 'click', startTime: at(0) });
    const transition = stateEvent('Alpha', 1, interaction.id);
    let reads = 0;
    const breaking = scriptedTelemetry((filter) => {
      reads += 1;
      if (reads > 1) {
        return err(new DebuggenError('STORE_ERROR', 'The store failed mid-read.'));
      }
      const rows = filter.component === undefined ? [interaction] : [transition];
      return ok({ rows, total: rows.length, complete: true });
    });
    const { resolver } = harness([], { telemetry: breaking });
    const error = await refused(resolver, {
      source: 'stateTransitions',
      filter: { component: 'Alpha' },
    });
    expect(error.code).toBe('STORE_ERROR');
    expect(reads).toBe(2);
  });

  it('answers a source outside the vocabulary with INTERNAL rather than throwing', async () => {
    const { resolver } = harness(everythingFixture());
    const bogus = { source: 'unheard-of' } as unknown as DataQuery;
    const error = await refused(resolver, bogus);
    expect(error.code).toBe('INTERNAL');
  });
});

/* -------------------------------------------------------------------------------------------------
 * Privacy
 * ---------------------------------------------------------------------------------------------- */

describe('privacy', () => {
  /** Captured values planted in a name, a URL, a statement and a request key. */
  function sentinelFixture(): TelemetryEvent[] {
    return [
      makeEvent({ kind: 'interaction', name: SENTINEL }),
      requestEvent(SENTINEL, `/api/${SENTINEL}?token=${SECRET_SENTINEL}`, 1),
      requestEvent(SECRET_SENTINEL, '/api/list?page=?', 2),
      queryEvent(`SELECT ${SENTINEL} FROM rows WHERE secret = '${SECRET_SENTINEL}'`, 3),
      renderEvent(SENTINEL, 4),
      stateEvent(SENTINEL, 5),
      makeEvent({ kind: 'function', name: SECRET_SENTINEL, startTime: at(6) }),
    ];
  }

  it('never logs or reports a captured name, URL, statement or request key, even when a read fails', async () => {
    const events = sentinelFixture();
    const { resolver, records } = harness(events);
    for (const query of QUERIES_BY_SOURCE) {
      await resolved(resolver, query);
      await resolved(resolver, { ...query, sort: 'count_desc', filter: { component: SENTINEL } });
      await resolved(resolver, { ...query, filter: { traceId: TRACE_MAIN, minDuration: 0 } });
    }
    expect(records.length).toBeGreaterThan(0);
    expectNoLeak(textOf(records));

    const errors: DebuggenError[] = [];
    const failing = [
      harness(events, { telemetry: REFUSING_TELEMETRY, correlatorFailure: 'refuse' }),
      harness(events, { telemetry: THROWING_TELEMETRY, correlatorFailure: 'throw' }),
    ];
    for (const failed of failing) {
      for (const query of QUERIES_BY_SOURCE) {
        errors.push(await refused(failed.resolver, { ...query, filter: { component: SENTINEL } }));
      }
      expectNoLeak(textOf(failed.records));
    }
    errors.push(await refused(resolver, { source: 'events', limit: -1 }));
    errors.push(
      await refused(
        resolver,
        { source: 'events' },
        { sessionId: SESSION_A, captureId: CAPTURE_B1 },
      ),
    );
    expect(errors.length).toBe(QUERIES_BY_SOURCE.length * failing.length + 2);
    for (const error of errors) {
      expectNoLeak(errorTexts(error));
    }
  });

  it('never sends, mints or rewrites a request key', async () => {
    const keyed = requestEvent('ingest-key-1', '/api/list?page=?', 0);
    const keyless = makeEvent({
      kind: 'fetch',
      name: 'GET',
      startTime: at(3),
      attributes: { 'http.method': 'GET', url: '/api/other', 'http.status_code': 200 },
    });
    const { resolver, store } = harness([keyed, keyless]);
    for (const query of QUERIES_BY_SOURCE) {
      await resolved(resolver, query);
    }
    expect(store.calls.length).toBeGreaterThan(0);
    expect(store.scans.length).toBeGreaterThan(0);
    expect(storeReads(store).every((read) => read.requestKey === undefined)).toBe(true);

    const requests = await resolved(resolver, { source: 'requests' });
    expect(requests.source).toBe('requests');
    if (requests.source === 'requests') {
      expect(requests.requests).toHaveLength(2);
      const keyedGroup = requests.requests.find((group) => group.requestKey !== undefined);
      const keylessGroup = requests.requests.find((group) => group.requestKey === undefined);
      expect(keyedGroup?.requestKey).toBe(keyed.attributes['request_key']);
      expect(keylessGroup).toBeDefined();
    }

    const events = await resolved(resolver, { source: 'events' });
    expect(events.source).toBe('events');
    if (events.source === 'events') {
      expect(events.events).toStrictEqual([keyed, keyless]);
      expect(events.events[1]?.attributes).not.toHaveProperty('request_key');
    }
  });

  it('returns stored rows exactly as stored: no second redaction, no marker rewritten', async () => {
    const events = tieFixture();
    const { resolver } = harness(events);
    const result = await resolved(resolver, { source: 'events', limit: DATA_QUERY_MAX_LIMIT });
    const expected = events
      .filter((event) => event.sessionId === SESSION_A && event.captureId === CAPTURE_A1)
      .sort(byStartThenId);
    expect(result.source).toBe('events');
    if (result.source === 'events') {
      expect(result.events).toStrictEqual(expected);
      const masked = result.events.filter((event) => event.redacted !== undefined);
      expect(masked.length).toBeGreaterThan(0);
      for (const event of masked) {
        const seeded = events.find((candidate) => candidate.id === event.id);
        expect(event.redacted).toStrictEqual(seeded?.redacted);
        expect(event.attributes).toStrictEqual(seeded?.attributes);
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Purity
 * ---------------------------------------------------------------------------------------------- */

describe('purity', () => {
  it('leaves the seeded events untouched, deeply frozen as they are, under every source and sort', async () => {
    const events = deepFreeze(tieFixture());
    const snapshot = structuredClone(events);
    const { resolver } = harness(events);
    for (const query of QUERIES_BY_SOURCE) {
      for (const sort of DATA_QUERY_SORTS) {
        await resolved(resolver, { ...query, sort, limit: 4, offset: 1 });
        await resolved(resolver, { ...query, sort, filter: { component: 'Kilo' } });
      }
    }
    expect(events).toStrictEqual(snapshot);
  });

  it.each(DATA_QUERY_SOURCES)(
    'answers %s identically twice, however far the clock moves',
    async (source) => {
      let tick = CAPTURE_EPOCH;
      const now = (): number => {
        tick += 1_000;
        return tick;
      };
      const events = tieFixture();
      const { resolver } = harness(events, { now });
      const query: DataQuery = { source, limit: 7, offset: 2 };
      const first = await resolved(resolver, query);
      const second = await resolved(resolver, query);
      expect(second).toStrictEqual(first);

      const fresh = await resolved(harness(events).resolver, query);
      expect(fresh).toStrictEqual(first);
    },
  );
});
