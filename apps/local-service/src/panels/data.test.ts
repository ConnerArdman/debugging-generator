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
 * 2. **Stable order.** Every chain ends in `id`, so a multi-page walk under each
 *    permitted sort of each sortable source visits every row exactly once, in
 *    the order of one unpaged read, even when many rows tie on the sort key; an
 *    inapplicable sort falls back to the source default, identically every time.
 * 3. **Shape.** Every one of the ten sources answers with the member of the
 *    protocol's `DataResult` union for its source — validated here with
 *    `parseDataResult` — the single-value sources carry no page, and `metrics`
 *    keeps `METRIC_IDS` order, including an unavailable value.
 * 4. **Push-down.** Every filter field reaches the store read itself, which the
 *    fake store records, so a resolver that loaded a capture whole and filtered
 *    it afterwards fails.
 * 5. **Scope.** One capture is read — the named one, else the open one, else
 *    the latest — never a capture of another session and never two at once.
 * 6. **Failure, privacy and purity.** A store failure is a typed `Err`, a
 *    throwing port is `STORE_ERROR`, no captured value reaches an error or a log
 *    record, no request key is minted, the seeded events are never mutated or
 *    re-redacted, and two identical reads are deep-equal whatever the clock says.
 *
 * ## Fixture conventions
 *
 * Every port is an in-file fake implementing only the methods the module
 * declares — the telemetry read, the two trace reads, the capture lookups and
 * the summary load — so nothing here opens a database, a socket or a timer. The
 * store fake orders rows by the store's documented panel orderings (duration
 * descending or start ascending, then the event id), written independently of
 * `SOURCE_SORT_KEYS`; one assertion ties the stated flat chains to the store's
 * own `ORDER BY` constants without opening it.
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

import { describe, expect, it } from 'vitest';

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
  TelemetryEvent,
  TelemetryKind,
  TelemetryTier,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';

import {
  PANEL_DURATION_DESC_ORDER_BY,
  PANEL_START_ASC_ORDER_BY,
  TELEMETRY_QUERY_DEFAULT_LIMIT,
  TELEMETRY_QUERY_DEFAULT_OFFSET,
  TELEMETRY_QUERY_MAX_LIMIT,
} from '../store/telemetry-repo.js';
import type { TelemetryQuery } from '../store/telemetry-repo.js';
import {
  DEFAULT_SORT_BY_SOURCE,
  MAX_AGGREGATE_INPUT_EVENTS,
  MAX_AGGREGATE_INPUT_PAGES,
  SOURCE_SORT_KEYS,
  SPAN_SOURCE_KINDS,
  applyPage,
  buildDataPage,
  createPanelDataResolver,
  effectiveSort,
  orderRows,
  resolvePaging,
} from './data.js';
import type {
  CaptureSummaryPort,
  PanelDataResolver,
  PanelDataResolverDeps,
  PanelTelemetryPort,
  PanelTracePort,
  SessionCapturePort,
  SortChain,
  SortedDataSource,
} from './data.js';

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

/**
 * The store's panel orderings, written independently of `SOURCE_SORT_KEYS`:
 * duration descending or start ascending, each broken by the event id.
 */
function storeOrder(
  sort: TelemetryQuery['sort'],
): (left: TelemetryEvent, right: TelemetryEvent) => number {
  if (sort === 'duration_desc') {
    return (left, right) => right.duration - left.duration || byCodeUnit(left.id, right.id);
  }
  return byStartThenId;
}

/** Whether `event` matches every narrowing field a store read carries. */
function matchesQuery(event: TelemetryEvent, query: TelemetryQuery): boolean {
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

/** The store's read port over a fixed event list, recording every read it serves. */
interface FakeTelemetryRepo extends PanelTelemetryPort {
  /** Every `query` call, in order, exactly as the resolver sent it. */
  readonly calls: readonly TelemetryQuery[];
}

/**
 * A store over a fixed event list.
 *
 * It honours every narrowing field, both panel orderings, the store's own
 * default and ceiling for `limit`, and `offset`; its page omits `nextOffset`
 * on the last page, as the real store's does. It refuses a row read ordered by
 * `count_desc`, which the resolver must never send for a flat source.
 */
function createFakeTelemetryRepo(events: readonly TelemetryEvent[]): FakeTelemetryRepo {
  const calls: TelemetryQuery[] = [];
  return {
    calls,
    query(query) {
      calls.push(Object.freeze({ ...query }));
      if (query.sort === 'count_desc') {
        return err(new DebuggenError('STORE_ERROR', 'The fake store orders rows by time only.'));
      }
      const offset = query.offset ?? TELEMETRY_QUERY_DEFAULT_OFFSET;
      const limit = Math.min(
        query.limit ?? TELEMETRY_QUERY_DEFAULT_LIMIT,
        TELEMETRY_QUERY_MAX_LIMIT,
      );
      const rows = events
        .filter((event) => matchesQuery(event, query))
        .sort(storeOrder(query.sort));
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

/** One recorded trace read. */
type CorrelatorCall =
  | {
      readonly method: 'listTraceIds';
      readonly sessionId: SessionId;
      readonly captureId: CaptureId | undefined;
    }
  | {
      readonly method: 'getTrace';
      readonly sessionId: SessionId;
      readonly traceId: TraceId;
      readonly captureId: CaptureId | undefined;
    };

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
 * Trace reads over a fixed event list: trace ids in first-event order, and a
 * synthetic tree per trace, both scoped by session and capture like the real
 * correlator. `failure` makes both reads refuse, or throw the sentinel.
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
    listTraceIds(sessionId, captureId) {
      calls.push({ method: 'listTraceIds', sessionId, captureId });
      if (failure === 'throw') {
        throw new Error(SENTINEL);
      }
      if (failure === 'refuse') {
        return Promise.resolve(err(refusal()));
      }
      const ordered = eventsInScope(events, sessionId, captureId).sort(byStartThenId);
      return Promise.resolve(ok([...new Set(ordered.map((event) => event.traceId))]));
    },
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

/** Capture lookups over a fixed list, oldest first. */
function sessionsPort(captures: readonly StoredCapture[]): SessionCapturePort {
  return {
    getCapture: (captureId) => ok(captures.find((stored) => stored.capture.id === captureId)),
    getActiveCapture: (sessionId) =>
      ok(
        captures.find(
          (stored) => stored.sessionId === sessionId && stored.capture.stoppedAt === undefined,
        ),
      ),
    listCaptures: (sessionId) => ok(captures.filter((stored) => stored.sessionId === sessionId)),
  };
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
      : sessionsPort(options.captures ?? defaultCaptures()));
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
  context: { readonly sessionId: SessionId; readonly captureId?: CaptureId } = CONTEXT_A1,
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
  context: { readonly sessionId: SessionId; readonly captureId?: CaptureId } = CONTEXT_A1,
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

/** A chain read generically: its fields and directions, whatever the row type. */
type GenericChain = readonly { readonly field: string; readonly direction: 'asc' | 'desc' }[];

/** The declared chain of `sort` on `source`; throws when the sort does not apply. */
function chainFor(source: SortedDataSource, sort: DataQuerySort): GenericChain {
  const chains: Readonly<Partial<Record<DataQuerySort, GenericChain>>> = SOURCE_SORT_KEYS[source];
  const chain = chains[sort];
  if (chain === undefined) {
    throw new Error(`no chain is declared for ${sort} on ${source}`);
  }
  return chain;
}

/** One field of a row, read by name. */
function fieldOf(row: object, field: string): unknown {
  return (row as Readonly<Record<string, unknown>>)[field];
}

/** Numbers numerically and strings by code unit; any other value is a fixture bug. */
function compareField(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return byCodeUnit(left, right);
  }
  throw new Error('a chain field holds a value that is neither a number nor a string');
}

/** Lexicographic comparison of two rows under a chain. */
function compareByChain(left: object, right: object, chain: GenericChain): number {
  for (const key of chain) {
    const order = compareField(fieldOf(left, key.field), fieldOf(right, key.field));
    if (order !== 0) {
      return key.direction === 'desc' ? -order : order;
    }
  }
  return 0;
}

/** The sortable sources, read off the default table so no source name is restated. */
const SORTED_SOURCES = Object.keys(DEFAULT_SORT_BY_SOURCE) as SortedDataSource[];

/** The sorts that apply to `source`, from its declared chains. */
function sortsFor(source: SortedDataSource): DataQuerySort[] {
  const chains: Readonly<Partial<Record<DataQuerySort, GenericChain>>> = SOURCE_SORT_KEYS[source];
  return DATA_QUERY_SORTS.filter((sort) => chains[sort] !== undefined);
}

/** One query per source, carrying nothing but the source. */
const QUERIES_BY_SOURCE: readonly DataQuery[] = DATA_QUERY_SOURCES.map((source) => ({ source }));

/** The sources computed from a slice of events rather than read page by page. */
const AGGREGATE_SOURCES: readonly DataQuerySource[] = DATA_QUERY_SOURCES.filter(
  (source) => source !== 'trace' && source !== 'spans' && source !== 'events',
);

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

  it('build a tie fixture that ties on the primary key of every permitted sort', async () => {
    const { resolver } = harness(tieFixture());
    for (const source of SORTED_SOURCES) {
      for (const sort of sortsFor(source)) {
        const whole = await resolved(resolver, { source, sort, limit: DATA_QUERY_MAX_LIMIT });
        const [primary] = chainFor(source, sort);
        if (primary === undefined) {
          throw new Error(`the chain of ${sort} on ${source} is empty`);
        }
        expect(primary.field).not.toBe('id');
        const values = rowsOf(whole).map((row) => fieldOf(row, primary.field));
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
  id: 'id',
});

/** A chain rendered as the store's `ORDER BY` clause. */
function orderByClause(chain: GenericChain): string {
  return chain
    .map((key) => `${STORE_COLUMN_BY_FIELD[key.field] ?? key.field} ${key.direction.toUpperCase()}`)
    .join(', ');
}

describe('SOURCE_SORT_KEYS and DEFAULT_SORT_BY_SOURCE', () => {
  it('covers exactly the paged sources whose order a query may choose', () => {
    expect([...SORTED_SOURCES].sort()).toStrictEqual(Object.keys(SOURCE_SORT_KEYS).sort());
    for (const source of SORTED_SOURCES) {
      expect(DATA_QUERY_SOURCES).toContain(source);
    }
  });

  it('ends every chain in id ascending', () => {
    for (const source of SORTED_SOURCES) {
      for (const sort of sortsFor(source)) {
        expect(chainFor(source, sort).at(-1)).toStrictEqual({ field: 'id', direction: 'asc' });
      }
    }
  });

  it('gives every source a default that has a chain', () => {
    for (const source of SORTED_SOURCES) {
      expect(sortsFor(source)).toContain(DEFAULT_SORT_BY_SOURCE[source]);
    }
  });

  it('states for the flat sources exactly the orderings the store applies', () => {
    const storeOrderBy: Readonly<Partial<Record<DataQuerySort, string>>> = {
      duration_desc: PANEL_DURATION_DESC_ORDER_BY,
      start_asc: PANEL_START_ASC_ORDER_BY,
    };
    for (const source of ['spans', 'events'] as const) {
      for (const sort of sortsFor(source)) {
        expect(orderByClause(chainFor(source, sort))).toBe(storeOrderBy[sort]);
      }
    }
  });

  it('keeps an applicable sort and falls back to the default for an inapplicable or absent one', () => {
    for (const source of SORTED_SOURCES) {
      const applicable = sortsFor(source);
      expect(effectiveSort(source, undefined)).toBe(DEFAULT_SORT_BY_SOURCE[source]);
      for (const sort of DATA_QUERY_SORTS) {
        const expected = applicable.includes(sort) ? sort : DEFAULT_SORT_BY_SOURCE[source];
        expect(effectiveSort(source, sort)).toBe(expected);
      }
    }
    expect(effectiveSort('events', 'count_desc')).toBe(DEFAULT_SORT_BY_SOURCE.events);
    expect(effectiveSort('stateTransitions', 'duration_desc')).toBe(
      DEFAULT_SORT_BY_SOURCE.stateTransitions,
    );
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

/** Every permitted (source, sort) pair, from the declared chains. */
const WALK_CASES: readonly (readonly [SortedDataSource, DataQuerySort])[] = SORTED_SOURCES.flatMap(
  (source) => sortsFor(source).map((sort) => [source, sort] as const),
);

/** Page sizes that split the fixture's tie groups at different points. */
const WALK_PAGE_SIZES: readonly number[] = [1, 2, 3, 5];

describe('the multi-page walk', () => {
  it('covers every permitted sort of every sortable source', () => {
    for (const source of SORTED_SOURCES) {
      expect(WALK_CASES.filter(([walked]) => walked === source)).toHaveLength(
        sortsFor(source).length,
      );
    }
    expect(new Set(WALK_CASES.map(([source]) => source)).size).toBe(SORTED_SOURCES.length);
  });

  it.each(WALK_CASES)(
    '%s under %s: every walk visits each row exactly once, in the order of one unpaged read',
    async (source, sort) => {
      const { resolver } = harness(tieFixture());
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

      // The unpaged read is in strict chain order: no two rows compare equal,
      // so every tie on the sort key was broken by the id.
      rows.forEach((row, index) => {
        const previous = rows[index - 1];
        if (previous !== undefined) {
          expect(compareByChain(previous, row, chain)).toBeLessThan(0);
        }
      });

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

  it('walks the fixed metrics order page by page to exactly METRIC_IDS', async () => {
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

  it('reads every kind for events and answers an inapplicable sort in the source default', async () => {
    const { resolver, store } = harness(flatFixture());
    const result = await resolved(resolver, { source: 'events', sort: 'count_desc' });

    expect(store.calls[0]?.sort).toBe(DEFAULT_SORT_BY_SOURCE.events);
    expect(store.calls[0]?.kinds).toBeUndefined();
    expect(result.source).toBe('events');
    if (result.source === 'events') {
      expect(result.total).toBe(14);
      expect(result.events.every((event) => event.captureId === CAPTURE_A1)).toBe(true);
    }
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

    expect(store.calls.every((call) => call.limit === TELEMETRY_QUERY_MAX_LIMIT)).toBe(true);
    expect(store.calls.every((call) => call.captureId === CAPTURE_A1)).toBe(true);
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
    expect(store.calls.every((call) => call.component === 'Charlie')).toBe(true);
    expect(result.source).toBe('renders');
    if (result.source === 'renders') {
      expect(result.renders.map((row) => row.component)).toStrictEqual(['Charlie']);
      expect(result.total).toBe(1);
    }
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
    const subjectReads = store.calls.filter((call) => call.component !== undefined);
    expect(subjectReads.length).toBeGreaterThan(0);
    expect(
      subjectReads.every((call) => call.kinds?.every((kind) => STATE_KINDS.includes(kind))),
    ).toBe(true);
    expect(
      store.calls.some((call) => call.component === undefined && call.kinds === undefined),
    ).toBe(true);
  });

  it('answers an inapplicable sort chronologically and walks every transition once', async () => {
    const { events } = transitionFixture();
    const { resolver } = harness(events);
    const byDuration = await resolved(resolver, {
      source: 'stateTransitions',
      sort: 'duration_desc',
    });
    const chronological = await resolved(resolver, { source: 'stateTransitions' });
    expect(rowIds(byDuration)).toStrictEqual(rowIds(chronological));
    const walk = await walkAll(resolver, { source: 'stateTransitions' }, 1);
    expect(walk.ids).toStrictEqual(rowIds(chronological));
    expect(walk.pages).toBe(4);
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

    const before = store.calls.length;
    const narrowed = await resolved(resolver, {
      source: 'componentTree',
      filter: { component: 'Kilo' },
    });
    const narrowedReads = store.calls.slice(before);
    expect(narrowedReads.length).toBeGreaterThan(0);
    expect(narrowedReads.every((call) => call.component === 'Kilo')).toBe(true);
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

      expect(store.calls.length).toBeGreaterThan(0);
      for (const call of store.calls) {
        expect(call).toMatchObject({
          sessionId: SESSION_A,
          captureId: CAPTURE_A1,
          traceId: TRACE_MAIN,
        });
        expect(call.requestKey).toBeUndefined();
      }
      expect(store.calls.some((call) => call.tier === 'browser' && call.minDuration === 0.5)).toBe(
        true,
      );
    },
  );
});

describe('bounded aggregate reads', () => {
  it('stops after the page bound, each page at the store ceiling, and says so', async () => {
    const rows = [makeEvent({ kind: 'function' })];
    let reads = 0;
    const endless: PanelTelemetryPort = {
      query(filter) {
        reads += 1;
        expect(filter.limit).toBe(TELEMETRY_QUERY_MAX_LIMIT);
        const offset = filter.offset ?? 0;
        return ok({ rows, total: MAX_AGGREGATE_INPUT_EVENTS * 2, nextOffset: offset + 1 });
      },
    };
    const { resolver, records } = harness([], { telemetry: endless });
    const result = await resolved(resolver, { source: 'graph' });
    expect(result.source).toBe('graph');
    expect(reads).toBe(MAX_AGGREGATE_INPUT_PAGES);
    expect(records.some((record) => record.level === 'warn')).toBe(true);
  });

  it('stops at a pager that does not advance', async () => {
    let reads = 0;
    const stuck: PanelTelemetryPort = {
      query(filter) {
        reads += 1;
        return ok({ rows: [], total: 10, nextOffset: filter.offset ?? 0 });
      },
    };
    const { resolver } = harness([], { telemetry: stuck });
    await resolved(resolver, { source: 'renders' });
    expect(reads).toBe(1);
  });
});

/* -------------------------------------------------------------------------------------------------
 * trace
 * ---------------------------------------------------------------------------------------------- */

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
    }
    expect(correlator.calls).toStrictEqual([
      { method: 'getTrace', sessionId: SESSION_A, traceId: TRACE_EARLY, captureId: CAPTURE_A1 },
    ]);
    expect(store.calls).toHaveLength(0);
  });

  it('defaults to the capture’s first trace, or to its stored primary trace', async () => {
    const plain = harness(traceFixture());
    const first = await resolved(plain.resolver, { source: 'trace' });
    expect(first.source).toBe('trace');
    if (first.source === 'trace') {
      expect(first.trace?.traceId).toBe(TRACE_EARLY);
    }
    expect(plain.correlator.calls).toStrictEqual([
      { method: 'listTraceIds', sessionId: SESSION_A, captureId: CAPTURE_A1 },
      { method: 'getTrace', sessionId: SESSION_A, traceId: TRACE_EARLY, captureId: CAPTURE_A1 },
    ]);

    const events = traceFixture();
    const summary = computeCaptureSummary(
      events.filter((event) => event.captureId === CAPTURE_A1),
      { captureId: CAPTURE_A1, sessionId: SESSION_A },
    );
    const withPrimary = await resolved(
      harness(events, {
        captures: [
          storedCapture(SESSION_A, CAPTURE_A1, {
            stopped: true,
            summary: { ...summary, primaryTraceId: TRACE_LATE },
          }),
        ],
      }).resolver,
      { source: 'trace' },
    );
    expect(withPrimary.source).toBe('trace');
    if (withPrimary.source === 'trace') {
      expect(withPrimary.trace?.traceId).toBe(TRACE_LATE);
    }
  });

  it('narrows a trace by its id only, answering the other filter fields with the same tree', async () => {
    const { resolver } = harness(traceFixture());
    const plain = await resolved(resolver, { source: 'trace', filter: { traceId: TRACE_LATE } });
    const narrowed = await resolved(resolver, {
      source: 'trace',
      filter: { traceId: TRACE_LATE, kinds: ['fetch'], minDuration: 1_000, component: 'Alpha' },
    });
    expect(narrowed).toStrictEqual(plain);
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
    expect(empty.correlator.calls.map((call) => call.method)).toStrictEqual(['listTraceIds']);
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

  it('returns every metric of the loaded summary in METRIC_IDS order, unavailable ones included', async () => {
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
    const result = await resolved(resolver, { source: 'metrics', sort: 'count_desc' });

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

  it('keeps the fixed order under every sort and an explicit window, which the protocol validates', async () => {
    const events = metricFixture();
    const { resolver } = harness(events);
    for (const sort of DATA_QUERY_SORTS) {
      const sorted = await resolved(resolver, { source: 'metrics', sort });
      expect(rowIds(sorted)).toStrictEqual([...METRIC_IDS]);
    }
    const window = await resolved(resolver, { source: 'metrics', limit: 3, offset: 3 });
    expect(window.source).toBe('metrics');
    if (window.source === 'metrics') {
      expect(window.metrics.map((metric) => metric.id)).toStrictEqual(METRIC_IDS.slice(3, 6));
      expect(window.nextOffset).toBe(6);
    }
  });

  it('uses the capture’s stored summary when no summary port is supplied', async () => {
    const events = metricFixture();
    const stored = computeCaptureSummary([], { captureId: CAPTURE_A1, sessionId: SESSION_A });
    const { resolver, store } = harness(events, {
      captures: [storedCapture(SESSION_A, CAPTURE_A1, { stopped: true, summary: stored })],
    });
    const result = await resolved(resolver, { source: 'metrics' });
    expect(store.calls).toHaveLength(0);
    expect(result.source).toBe('metrics');
    if (result.source === 'metrics') {
      expect(result.metrics).toStrictEqual(stored.metrics);
      expect(result.metrics.map((metric) => metric.id)).toStrictEqual([...METRIC_IDS]);
    }
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
    expect(store.calls.every((call) => call.tier === 'db')).toBe(true);
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

    const latest = harness(events);
    await resolved(latest.resolver, { source: 'events' }, { sessionId: SESSION_A });
    expect(latest.store.calls[0]?.captureId).toBe(CAPTURE_A2);
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
      expect(store.calls.every((call) => call.captureId === captureId)).toBe(true);
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
    for (const call of store.calls) {
      expect(call.sessionId).toBe(SESSION_A);
      expect(call.captureId).toBe(CAPTURE_A1);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Every source
 * ---------------------------------------------------------------------------------------------- */

/** Every (sortable source, sort that does not apply to it) pair. */
const INAPPLICABLE_CASES: readonly (readonly [SortedDataSource, DataQuerySort])[] =
  SORTED_SOURCES.flatMap((source) =>
    DATA_QUERY_SORTS.filter((sort) => !sortsFor(source).includes(sort)).map(
      (sort) => [source, sort] as const,
    ),
  );

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
    expect(pagedSources.sort()).toStrictEqual([...SORTED_SOURCES, 'metrics'].sort());
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

  it('has sorts that do not apply to some source', () => {
    expect(INAPPLICABLE_CASES.length).toBeGreaterThan(0);
  });

  it.each(INAPPLICABLE_CASES)(
    'answers %s under the inapplicable %s in its default order, identically twice',
    async (source, sort) => {
      const { resolver, store } = harness(tieFixture());
      const first = await resolved(resolver, { source, sort, limit: DATA_QUERY_MAX_LIMIT });
      const second = await resolved(resolver, { source, sort, limit: DATA_QUERY_MAX_LIMIT });
      const byDefault = await resolved(resolver, {
        source,
        sort: DEFAULT_SORT_BY_SOURCE[source],
        limit: DATA_QUERY_MAX_LIMIT,
      });
      expect(rowIds(first).length).toBeGreaterThan(1);
      expect(rowIds(second)).toStrictEqual(rowIds(first));
      expect(first).toStrictEqual(byDefault);
      if (source === 'spans' || source === 'events') {
        // The flat sources are ordered by the store: the default, never the
        // inapplicable sort, is what reaches it.
        expect(store.calls.every((call) => call.sort === DEFAULT_SORT_BY_SOURCE[source])).toBe(
          true,
        );
      }
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * Failure
 * ---------------------------------------------------------------------------------------------- */

/** A telemetry port that refuses every read with the store's own typed error. */
const REFUSING_TELEMETRY: PanelTelemetryPort = {
  query: () =>
    err(
      new DebuggenError('STORE_ERROR', 'The store refused the read.', {
        details: { reason: 'unavailable' },
      }),
    ),
};

/** A telemetry port that throws the sentinel from every read. */
const THROWING_TELEMETRY: PanelTelemetryPort = {
  query: () => {
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

  it('converts a throwing capture lookup into STORE_ERROR, with or without a named capture', async () => {
    const throwing: SessionCapturePort = {
      getCapture: () => {
        throw new Error(SENTINEL);
      },
      getActiveCapture: () => {
        throw new Error(SENTINEL);
      },
      listCaptures: () => {
        throw new Error(SENTINEL);
      },
    };
    const { resolver, store, records } = harness(everythingFixture(), { sessions: throwing });
    for (const context of [CONTEXT_A1, { sessionId: SESSION_A }]) {
      const error = await refused(resolver, { source: 'events' }, context);
      expect(error.code).toBe('STORE_ERROR');
      expectNoLeak(errorTexts(error));
    }
    expect(store.calls).toHaveLength(0);
    expectNoLeak(textOf(records));
  });

  it('fails an aggregate read that breaks on a later page instead of answering from half a slice', async () => {
    const rows = [renderEvent('Alpha', 1)];
    let reads = 0;
    const breaking: PanelTelemetryPort = {
      query: () => {
        reads += 1;
        return reads === 1
          ? ok({ rows, total: rows.length + 1, nextOffset: rows.length })
          : err(new DebuggenError('STORE_ERROR', 'The store failed mid-read.'));
      },
    };
    const { resolver } = harness([], { telemetry: breaking });
    const error = await refused(resolver, { source: 'renders' });
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
    expect(store.calls.every((call) => call.requestKey === undefined)).toBe(true);

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
