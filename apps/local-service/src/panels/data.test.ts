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
 *    only while rows remain and `null` on the last page.
 * 2. **Stable order.** Every chain ends in `id`, so a multi-page walk under each
 *    permitted sort visits every row exactly once even when many rows tie on
 *    the sort key; an inapplicable sort falls back to the source default.
 * 3. **Shape.** Every one of the ten sources answers with the member of the
 *    protocol's `DataResult` union for its source — validated here with
 *    `parseDataResult` — the single-value sources carry no page, and `metrics`
 *    keeps `METRIC_IDS` order, including an unavailable value.
 * 4. **Scope.** One capture is read — the named one, else the open one, else
 *    the latest — never a capture of another session and never two at once.
 * 5. **Failure and privacy.** A store failure is a typed `Err`, a throwing port
 *    is `STORE_ERROR`, and no captured value reaches an error or a log record.
 *
 * ## Fixture conventions
 *
 * The store and the capture lookups are in-file fakes implementing only the
 * port methods the module declares, so most of this suite opens no database.
 * One block runs the flat sources against the real SQLite store, because the
 * resolver delegates their ordering to it and the stated chains must match
 * what the store actually does. Timings are explicit offsets from one fixed
 * epoch base, identifiers come from `@debuggen/shared`'s minting functions, and
 * names are invented and generic — nothing here names a symbol or a route of
 * any real project (AAP §0.5.4).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_SORTS,
  DATA_QUERY_SOURCES,
} from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySort, DataQuerySource } from '@debuggen/panel-schema';
import { parseDataResult } from '@debuggen/protocol';
import type { CaptureRecord, DataResult, SessionRecord } from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  createConsoleLogger,
  err,
  newCaptureId,
  newEventId,
  newProducerId,
  newSessionId,
  newSpanId,
  newTraceId,
  ok,
  unwrap,
} from '@debuggen/shared';
import type {
  CaptureId,
  LogRecord,
  Logger,
  ProducerId,
  Result,
  SessionId,
  SpanId,
  TraceId,
} from '@debuggen/shared';
import {
  ERROR_KINDS,
  METRIC_IDS,
  STATE_KINDS,
  TELEMETRY_KINDS,
  allowedTiersFor,
  computeCaptureSummary,
} from '@debuggen/telemetry';
import type {
  CaptureSummary,
  TelemetryEvent,
  TelemetryKind,
  TelemetryTier,
} from '@debuggen/telemetry';

import { openStore } from '../store/db.js';
import type { Store } from '../store/db.js';
import { createSessionsRepo } from '../store/sessions-repo.js';
import type { StoredCapture } from '../store/sessions-repo.js';
import {
  TELEMETRY_QUERY_DEFAULT_LIMIT,
  TELEMETRY_QUERY_MAX_LIMIT,
  createTelemetryRepo,
} from '../store/telemetry-repo.js';
import type {
  PersistableTelemetryEvent,
  TelemetryPage,
  TelemetryQuery,
  TelemetryReadOptions,
} from '../store/telemetry-repo.js';
import { createTraceCorrelator } from '../telemetry/correlate.js';
import type { TelemetryRepoLike } from '../telemetry/correlate.js';
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
  SessionCapturePort,
  SortChain,
  SortedDataSource,
} from './data.js';

/* -------------------------------------------------------------------------------------------------
 * Fixture constants
 * ---------------------------------------------------------------------------------------------- */

/** The epoch millisecond every offset in this file is measured from. */
const BASE_TIME = 1_768_000_000_000;

/** The session most cases read. */
const SESSION_A: SessionId = newSessionId();

/** A second session, for the ownership refusals. */
const SESSION_B: SessionId = newSessionId();

/** The capture most fixtures belong to. */
const CAPTURE_A1: CaptureId = newCaptureId();

/** A second capture of {@link SESSION_A}, whose events must never leak into a read of the first. */
const CAPTURE_A2: CaptureId = newCaptureId();

/** A capture of {@link SESSION_B}. */
const CAPTURE_B1: CaptureId = newCaptureId();

/** The trace most fixtures belong to. */
const TRACE_MAIN: TraceId = newTraceId();

/** The producer every fixture is emitted by unless a case says otherwise. */
const PRODUCER: ProducerId = newProducerId();

/**
 * The value that must never reach a log record or an error payload, assembled
 * at run time so a search for any one segment catches a partial leak.
 */
const SENTINEL_SEGMENTS: readonly string[] = ['quillwort', 'marlinspike', 'gossamer'];
const SENTINEL = `${SENTINEL_SEGMENTS.join('-')}-never-log-me`;

/* -------------------------------------------------------------------------------------------------
 * Event fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The store's arrival counter; never reset, like `ingest_seq`. */
let ingestOrdinal = 0;

/** Per-producer emission counters. */
let seqOrdinal = 0;

/** `offsetMs` after {@link BASE_TIME}. */
function at(offsetMs: number): number {
  return BASE_TIME + offsetMs;
}

/** The first tier the kind/tier table permits, so every fixture passes the schema. */
function tierFor(kind: TelemetryKind): TelemetryTier {
  const [tier] = allowedTiersFor(kind);
  if (tier === undefined) {
    throw new Error(`no tier is allowed for kind ${kind}`);
  }
  return tier;
}

/** What a case may vary about one persisted event. */
interface EventOverrides {
  readonly id?: string;
  readonly sessionId?: SessionId;
  readonly captureId?: CaptureId;
  readonly traceId?: TraceId;
  readonly spanId?: SpanId;
  readonly parentSpanId?: SpanId;
  readonly kind?: TelemetryKind;
  readonly name?: string;
  readonly startTime?: number;
  readonly duration?: number;
  readonly attributes?: Record<string, unknown>;
}

/** One event as the store accepts it for writing: every field but the arrival number. */
function makeWritable(overrides: EventOverrides = {}): PersistableTelemetryEvent {
  const kind = overrides.kind ?? 'function';
  seqOrdinal += 1;
  return {
    id: overrides.id ?? newEventId(),
    traceId: overrides.traceId ?? TRACE_MAIN,
    spanId: overrides.spanId ?? newSpanId(),
    ...(overrides.parentSpanId !== undefined ? { parentSpanId: overrides.parentSpanId } : {}),
    kind,
    name: overrides.name ?? 'operation',
    startTime: overrides.startTime ?? at(1),
    duration: overrides.duration ?? 1.5,
    tier: tierFor(kind),
    attributes: overrides.attributes ?? {},
    status: 'ok',
    producerId: PRODUCER,
    seq: seqOrdinal,
    sessionId: overrides.sessionId ?? SESSION_A,
    captureId: overrides.captureId ?? CAPTURE_A1,
  };
}

/** One persisted event with every field the store holds. */
function makeEvent(overrides: EventOverrides = {}): TelemetryEvent {
  ingestOrdinal += 1;
  return { ...makeWritable(overrides), ingestSeq: ingestOrdinal };
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

/** A browser request carrying the ingest-assigned grouping key. */
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
  });
}

/** A database statement execution. */
function queryEvent(statement: string, offsetMs: number, duration = 3): TelemetryEvent {
  return makeEvent({
    kind: 'db.query',
    name: 'SELECT',
    startTime: at(offsetMs),
    duration,
    attributes: { 'db.system': 'postgresql', 'db.statement': statement },
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

/** An in-memory store: the three reads the resolver and the real correlator perform. */
interface FakeStore extends PanelTelemetryPort, TelemetryRepoLike {
  /** Every `query` call, in order. */
  readonly calls: TelemetryQuery[];
}

/** Whether `event` matches the narrowing a store read carries. */
function matchesQuery(event: TelemetryEvent, filter: TelemetryQuery): boolean {
  return (
    event.sessionId === filter.sessionId &&
    (filter.captureId === undefined || event.captureId === filter.captureId) &&
    (filter.traceId === undefined || event.traceId === filter.traceId) &&
    (filter.kinds === undefined || filter.kinds.includes(event.kind)) &&
    (filter.tier === undefined || event.tier === filter.tier) &&
    (filter.minDuration === undefined || event.duration >= filter.minDuration) &&
    (filter.component === undefined || event.attributes['component'] === filter.component)
  );
}

/** A page of `rows` for `offset`/`limit`, `nextOffset` absent on the last page. */
function pageOf(rows: readonly TelemetryEvent[], offset: number, limit: number): TelemetryPage {
  const page = rows.slice(offset, offset + Math.min(limit, TELEMETRY_QUERY_MAX_LIMIT));
  const following = offset + page.length;
  return {
    rows: page,
    total: rows.length,
    ...(page.length > 0 && following < rows.length ? { nextOffset: following } : {}),
  };
}

/**
 * A store over a fixed event list.
 *
 * Its ordering is written independently of `SOURCE_SORT_KEYS` — the real-store
 * block is what ties the two together — and it refuses a row read ordered by
 * `count_desc`, which the resolver must never send for a flat source.
 */
function fakeStore(events: readonly TelemetryEvent[]): FakeStore {
  const calls: TelemetryQuery[] = [];
  return {
    calls,
    query(filter: TelemetryQuery): Result<TelemetryPage, DebuggenError> {
      calls.push(filter);
      if (filter.sort === 'count_desc') {
        return err(new DebuggenError('STORE_ERROR', 'The fake store refuses count_desc rows.'));
      }
      const rows = events.filter((event) => matchesQuery(event, filter));
      rows.sort((left, right) =>
        filter.sort === 'duration_desc'
          ? right.duration - left.duration || byCodeUnit(left.id, right.id)
          : left.startTime - right.startTime || byCodeUnit(left.id, right.id),
      );
      return ok(pageOf(rows, filter.offset ?? 0, filter.limit ?? TELEMETRY_QUERY_DEFAULT_LIMIT));
    },
    listByTrace(
      sessionId: SessionId,
      traceId: string,
      options?: TelemetryReadOptions,
    ): Result<TelemetryPage, DebuggenError> {
      const rows = events.filter(
        (event) =>
          event.sessionId === sessionId &&
          event.traceId === traceId &&
          (options?.captureId === undefined || event.captureId === options.captureId),
      );
      rows.sort(
        (left, right) =>
          left.startTime - right.startTime ||
          byCodeUnit(left.producerId, right.producerId) ||
          left.seq - right.seq ||
          left.ingestSeq - right.ingestSeq,
      );
      return ok(
        pageOf(rows, options?.offset ?? 0, options?.limit ?? TELEMETRY_QUERY_DEFAULT_LIMIT),
      );
    },
    listTraceIds(sessionId: SessionId, captureId?: CaptureId): Result<string[], DebuggenError> {
      const rows = events
        .filter(
          (event) =>
            event.sessionId === sessionId &&
            (captureId === undefined || event.captureId === captureId),
        )
        .sort(
          (left, right) => left.startTime - right.startTime || left.ingestSeq - right.ingestSeq,
        );
      return ok([...new Set(rows.map((event) => event.traceId))]);
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
  const startedAt = options.startedAt ?? BASE_TIME;
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
    storedCapture(SESSION_A, CAPTURE_A2, { startedAt: BASE_TIME + 5_000, stopped: true }),
    storedCapture(SESSION_B, CAPTURE_B1, { stopped: true }),
  ];
}

/** A resolver over fakes, with every log record kept for the privacy checks. */
interface Harness {
  readonly resolver: PanelDataResolver;
  readonly store: FakeStore;
  readonly records: LogRecord[];
}

/** What a harness may replace. */
interface HarnessOptions {
  readonly captures?: readonly StoredCapture[];
  readonly withoutSessions?: boolean;
  readonly summaries?: CaptureSummaryPort;
  readonly telemetry?: PanelTelemetryPort;
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
  const store = fakeStore(events);
  const deps: PanelDataResolverDeps = {
    telemetry: options.telemetry ?? store,
    correlator: createTraceCorrelator({ telemetry: store }),
    sessions:
      options.withoutSessions === true
        ? undefined
        : sessionsPort(options.captures ?? defaultCaptures()),
    captures: options.summaries,
    logger,
    now: () => BASE_TIME,
  };
  return { resolver: createPanelDataResolver(deps), store, records };
}

/** The context most cases read: session A, capture A1. */
const CONTEXT_A1 = Object.freeze({ sessionId: SESSION_A, captureId: CAPTURE_A1 });

/** Resolves, and fails the test with the error's code when the resolver refused. */
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

/** The rows of a paged result, by id. */
function rowIds(result: DataResult): string[] {
  switch (result.source) {
    case 'spans':
      return result.spans.map((row) => row.id);
    case 'events':
      return result.events.map((row) => row.id);
    case 'renders':
      return result.renders.map((row) => row.id);
    case 'requests':
      return result.requests.map((row) => row.id);
    case 'queries':
      return result.queries.map((row) => row.id);
    case 'stateTransitions':
      return result.stateTransitions.map((row) => row.id);
    case 'metrics':
      return result.metrics.map((row) => row.id);
    case 'trace':
    case 'componentTree':
    case 'graph':
      throw new Error(`source ${result.source} is not paged`);
  }
}

/** Walks every page of a query, `pageSize` at a time, and returns every row id seen. */
async function walkAll(
  resolver: PanelDataResolver,
  query: DataQuery,
  pageSize: number,
): Promise<{ readonly ids: string[]; readonly totals: number[]; readonly pages: number }> {
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
    ids.push(...rowIds(result));
    totals.push(result.total);
    expect(result.limit).toBe(pageSize);
    expect(result.offset).toBe(offset);
    offset = result.nextOffset;
  }
  return { ids, totals, pages };
}

/** Every string in the log records and in an error, for the privacy checks. */
function textOf(value: unknown): string {
  return JSON.stringify(value) ?? '';
}

/* -------------------------------------------------------------------------------------------------
 * Paging
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

  it('never carries a hasMore flag or an absent nextOffset', () => {
    const page = buildDataPage(4, { limit: 4, offset: 0 }, 4);
    expect(Object.keys(page).sort()).toStrictEqual(['limit', 'nextOffset', 'offset', 'total']);
    expect(page.nextOffset).toBeNull();
  });
});

/* -------------------------------------------------------------------------------------------------
 * Ordering tables
 * ---------------------------------------------------------------------------------------------- */

/** The sortable sources, read off the default table so no source name is restated. */
const SORTED_SOURCES = Object.keys(DEFAULT_SORT_BY_SOURCE) as SortedDataSource[];

describe('SOURCE_SORT_KEYS and DEFAULT_SORT_BY_SOURCE', () => {
  it('covers exactly the paged sources whose order a query may choose', () => {
    expect([...SORTED_SOURCES].sort()).toStrictEqual(Object.keys(SOURCE_SORT_KEYS).sort());
    for (const source of SORTED_SOURCES) {
      expect(DATA_QUERY_SOURCES).toContain(source);
    }
  });

  it('ends every chain in id ascending', () => {
    for (const source of SORTED_SOURCES) {
      const chains: Readonly<
        Partial<Record<DataQuerySort, readonly { field: string; direction: string }[]>>
      > = SOURCE_SORT_KEYS[source];
      for (const chain of Object.values(chains)) {
        expect(chain.at(-1)).toStrictEqual({ field: 'id', direction: 'asc' });
      }
    }
  });

  it('gives every source a default that has a chain', () => {
    for (const source of SORTED_SOURCES) {
      const chains: Readonly<Partial<Record<DataQuerySort, unknown>>> = SOURCE_SORT_KEYS[source];
      expect(chains[DEFAULT_SORT_BY_SOURCE[source]]).toBeDefined();
    }
  });

  it('keeps an applicable sort and falls back to the default for an inapplicable or absent one', () => {
    for (const source of SORTED_SOURCES) {
      const chains: Readonly<Partial<Record<DataQuerySort, unknown>>> = SOURCE_SORT_KEYS[source];
      expect(effectiveSort(source, undefined)).toBe(DEFAULT_SORT_BY_SOURCE[source]);
      for (const sort of DATA_QUERY_SORTS) {
        const expected = chains[sort] === undefined ? DEFAULT_SORT_BY_SOURCE[source] : sort;
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
 * The flat sources
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

describe('spans and events', () => {
  it('pushes the default sort, the default page and the span kinds into the store read', async () => {
    const { resolver, store } = harness(flatFixture());
    const result = await resolved(resolver, { source: 'spans' });

    expect(store.calls).toHaveLength(1);
    const [call] = store.calls;
    expect(call).toMatchObject({
      sessionId: SESSION_A,
      captureId: CAPTURE_A1,
      sort: DEFAULT_SORT_BY_SOURCE.spans,
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: DATA_QUERY_DEFAULT_OFFSET,
      kinds: SPAN_SOURCE_KINDS,
    });
    expect(result.source).toBe('spans');
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
    expect(store.calls[0]).toMatchObject({
      traceId: TRACE_MAIN,
      kinds: ['function'],
      tier: 'browser',
      minDuration: 2,
      component: 'Alpha',
    });
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

  it('clamps a limit above the ceiling before it reaches the store', async () => {
    const { resolver, store } = harness(flatFixture());
    const result = await resolved(resolver, { source: 'events', limit: DATA_QUERY_MAX_LIMIT + 10 });
    expect(store.calls[0]?.limit).toBe(DATA_QUERY_MAX_LIMIT);
    expect('limit' in result).toBe(true);
    if ('limit' in result) {
      expect(result.limit).toBe(DATA_QUERY_MAX_LIMIT);
    }
  });

  it.each(['spans', 'events'] as const)(
    'walks %s page by page under each permitted sort without repeating or skipping a row',
    async (source) => {
      const events = flatFixture();
      const { resolver } = harness(events);
      const sorts = Object.keys(SOURCE_SORT_KEYS[source]) as DataQuerySort[];
      expect(sorts.length).toBeGreaterThan(1);

      for (const sort of sorts) {
        const walk = await walkAll(resolver, { source, sort }, 5);
        const expected = events.filter(
          (event) =>
            event.sessionId === SESSION_A &&
            event.captureId === CAPTURE_A1 &&
            (source === 'events' || SPAN_SOURCE_KINDS.includes(event.kind)),
        );
        expect(new Set(walk.ids).size).toBe(walk.ids.length);
        expect([...walk.ids].sort()).toStrictEqual(expected.map((event) => event.id).sort());
        expect(walk.totals.every((total) => total === expected.length)).toBe(true);
        expect(walk.pages).toBe(Math.ceil(expected.length / 5));
      }
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * The aggregate sources
 * ---------------------------------------------------------------------------------------------- */

/** Seven components, several tying on render count and on first start. */
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

  it.each(Object.keys(SOURCE_SORT_KEYS.renders) as DataQuerySort[])(
    'walks every component exactly once under %s',
    async (sort) => {
      const { resolver } = harness(renderFixture());
      const full = await resolved(resolver, { source: 'renders', sort });
      const walk = await walkAll(resolver, { source: 'renders', sort }, 3);
      expect(new Set(walk.ids).size).toBe(8);
      expect(walk.ids).toStrictEqual(rowIds(full));
    },
  );

  it('narrows to one component', async () => {
    const { resolver } = harness(renderFixture());
    const result = await resolved(resolver, {
      source: 'renders',
      filter: { component: 'Charlie' },
    });
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
    }
  });

  it.each(Object.keys(SOURCE_SORT_KEYS.requests) as DataQuerySort[])(
    'walks every group exactly once under %s',
    async (sort) => {
      const events = Array.from({ length: 9 }, (_, index) =>
        requestEvent(`key-${String(index % 5)}`, `/api/list?page=?`, index * 5, 4),
      );
      const { resolver } = harness(events);
      const full = await resolved(resolver, { source: 'requests', sort });
      const walk = await walkAll(resolver, { source: 'requests', sort }, 2);
      expect(new Set(walk.ids).size).toBe(5);
      expect(walk.ids).toStrictEqual(rowIds(full));
    },
  );
});

describe('queries', () => {
  it.each(Object.keys(SOURCE_SORT_KEYS.queries) as DataQuerySort[])(
    'walks every statement group exactly once under %s',
    async (sort) => {
      const events = Array.from({ length: 10 }, (_, index) =>
        queryEvent(`SELECT column_${String(index % 4)} FROM rows WHERE id = $1`, index * 3, 2),
      );
      const { resolver } = harness(events);
      const full = await resolved(resolver, { source: 'queries', sort });
      const walk = await walkAll(resolver, { source: 'queries', sort }, 3);
      expect(new Set(walk.ids).size).toBe(4);
      expect(walk.ids).toStrictEqual(rowIds(full));
    },
  );
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

describe('componentTree and graph', () => {
  it('answers a capture without rendering evidence with a null tree and no page', async () => {
    const { resolver } = harness([makeEvent({ kind: 'function' })]);
    const result = await resolved(resolver, { source: 'componentTree', limit: 1, offset: 3 });
    expect(result).toStrictEqual({ source: 'componentTree', componentTree: null });
  });

  it('builds the snapshot from the capture’s renders', async () => {
    const { resolver } = harness(renderFixture());
    const result = await resolved(resolver, { source: 'componentTree' });
    expect(Object.keys(result).sort()).toStrictEqual(['componentTree', 'source']);
    expect(result.source).toBe('componentTree');
    if (result.source === 'componentTree') {
      expect(result.componentTree?.roots.length).toBeGreaterThan(0);
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
  const TRACE_EARLY: TraceId = newTraceId();
  const TRACE_LATE: TraceId = newTraceId();

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

  it('resolves the named trace from this capture’s events only, with no page', async () => {
    const { resolver } = harness(traceFixture());
    const result = await resolved(resolver, {
      source: 'trace',
      filter: { traceId: TRACE_EARLY },
      limit: 1,
    });
    expect(Object.keys(result).sort()).toStrictEqual(['source', 'trace']);
    expect(result.source).toBe('trace');
    if (result.source === 'trace') {
      expect(result.trace?.traceId).toBe(TRACE_EARLY);
      expect(result.trace?.nodeCount).toBe(2);
    }
  });

  it('defaults to the capture’s first trace, or to its stored primary trace', async () => {
    const plain = await resolved(harness(traceFixture()).resolver, { source: 'trace' });
    expect(plain.source).toBe('trace');
    if (plain.source === 'trace') {
      expect(plain.trace?.traceId).toBe(TRACE_EARLY);
    }

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

  it('answers an unknown trace id, and a capture without traces, with null', async () => {
    const unknown = await resolved(harness(traceFixture()).resolver, {
      source: 'trace',
      filter: { traceId: newTraceId() },
    });
    expect(unknown).toStrictEqual({ source: 'trace', trace: null });
    const empty = await resolved(harness([]).resolver, { source: 'trace' });
    expect(empty).toStrictEqual({ source: 'trace', trace: null });
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
    }
  });

  it('keeps the fixed order under an explicit window, which the protocol validates', async () => {
    const events = metricFixture();
    const { resolver } = harness(events);
    const window = await resolved(resolver, { source: 'metrics', limit: 3, offset: 3 });
    expect(window.source).toBe('metrics');
    if (window.source === 'metrics') {
      expect(window.metrics.map((metric) => metric.id)).toStrictEqual(METRIC_IDS.slice(3, 6));
      expect(window.nextOffset).toBe(6);
    }
    const walk = await walkAll(resolver, { source: 'metrics' }, 4);
    expect(walk.ids).toStrictEqual([...METRIC_IDS]);
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
    const { resolver } = harness(events, { summaries });
    const result = await resolved(resolver, { source: 'metrics', filter: { tier: 'db' } });
    expect(loads).toBe(0);
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
      {
        sessionId: SESSION_A,
      },
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

/** One query per source, carrying nothing but the source. */
const QUERIES_BY_SOURCE: readonly DataQuery[] = DATA_QUERY_SOURCES.map((source) => ({ source }));

describe('capture scoping', () => {
  it('refuses a named capture that belongs to another session', async () => {
    const { resolver, store } = harness(everythingFixture());
    const result = await resolver.resolve(
      { sessionId: SESSION_A, captureId: CAPTURE_B1 },
      { source: 'events' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SESSION_INVALID_STATE');
    }
    expect(store.calls).toHaveLength(0);
  });

  it('refuses a named capture the store does not hold', async () => {
    const { resolver } = harness(everythingFixture());
    const result = await resolver.resolve(
      { sessionId: SESSION_A, captureId: newCaptureId() },
      { source: 'renders' },
    );
    expect(result.ok ? undefined : result.error.code).toBe('SESSION_INVALID_STATE');
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

  it('answers every source with its empty value for a session that has not captured', async () => {
    const { resolver, store } = harness(everythingFixture(), { captures: [] });
    for (const query of QUERIES_BY_SOURCE) {
      const result = await resolved(resolver, query, { sessionId: SESSION_A });
      expect(result.source).toBe(query.source);
      if ('total' in result) {
        expect(result.total).toBe(0);
        expect(result.nextOffset).toBeNull();
      }
    }
    expect(store.calls).toHaveLength(0);
  });

  it('reads a named capture without a lookup, and refuses to guess one', async () => {
    const withCapture = harness(everythingFixture(), { withoutSessions: true });
    await resolved(withCapture.resolver, { source: 'events' });
    expect(withCapture.store.calls[0]?.captureId).toBe(CAPTURE_A1);

    const result = await withCapture.resolver.resolve(
      { sessionId: SESSION_A },
      { source: 'events' },
    );
    expect(result.ok ? undefined : result.error.code).toBe('SESSION_INVALID_STATE');
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
 * Shape of every source
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
    expect(pagedSources.sort()).toStrictEqual([...SORTED_SOURCES, 'metrics'].sort());
  });
});

/* -------------------------------------------------------------------------------------------------
 * Failure and privacy
 * ---------------------------------------------------------------------------------------------- */

describe('failure and privacy', () => {
  it('passes a store refusal through as its own typed error', async () => {
    const refusing: PanelTelemetryPort = {
      query: () =>
        err(
          new DebuggenError('STORE_ERROR', 'The store refused the read.', {
            details: { reason: 'unknown-kind' },
          }),
        ),
    };
    const { resolver } = harness([], { telemetry: refusing });
    for (const source of ['events', 'renders', 'metrics'] as const) {
      const result = await resolver.resolve(CONTEXT_A1, { source });
      expect(result.ok ? undefined : result.error.code).toBe('STORE_ERROR');
    }
  });

  it('converts a throwing port into STORE_ERROR without echoing what it threw', async () => {
    const throwing: PanelTelemetryPort = {
      query: () => {
        throw new Error(SENTINEL);
      },
    };
    const { resolver, records } = harness([], { telemetry: throwing });
    const result = await resolver.resolve(CONTEXT_A1, { source: 'spans' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STORE_ERROR');
      expect(DebuggenError.is(result.error)).toBe(true);
      for (const segment of SENTINEL_SEGMENTS) {
        expect(textOf({ ...result.error, message: result.error.message })).not.toContain(segment);
      }
    }
    for (const segment of SENTINEL_SEGMENTS) {
      expect(textOf(records)).not.toContain(segment);
    }
  });

  it('never logs a captured name, URL, statement or attribute value', async () => {
    const events = [
      makeEvent({ kind: 'interaction', name: SENTINEL }),
      requestEvent(SENTINEL, `/api/${SENTINEL}`, 1),
      queryEvent(`SELECT ${SENTINEL} FROM rows`, 2),
      renderEvent(SENTINEL, 3),
      stateEvent(SENTINEL, 4),
    ];
    const { resolver, records } = harness(events);
    for (const query of QUERIES_BY_SOURCE) {
      await resolved(resolver, query);
      await resolved(resolver, { ...query, sort: 'count_desc', filter: { component: SENTINEL } });
    }
    expect(records.length).toBeGreaterThan(0);
    for (const segment of SENTINEL_SEGMENTS) {
      expect(textOf(records)).not.toContain(segment);
    }
  });

  it('answers a source outside the vocabulary with INTERNAL rather than throwing', async () => {
    const { resolver } = harness(everythingFixture());
    const bogus = { source: 'unheard-of' } as unknown as DataQuery;
    const result = await resolver.resolve(CONTEXT_A1, bogus);
    expect(result.ok ? undefined : result.error.code).toBe('INTERNAL');
  });

  it('refuses a paging value outside its domain before reading anything', async () => {
    const { resolver, store } = harness(everythingFixture());
    const result = await resolver.resolve(CONTEXT_A1, { source: 'events', offset: -1 });
    expect(result.ok ? undefined : result.error.code).toBe('PANEL_INVALID');
    expect(store.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Against the real store
 * ---------------------------------------------------------------------------------------------- */

/** A minimal session record the sessions repository accepts. */
function sessionRecord(sessionId: SessionId): SessionRecord {
  return {
    id: sessionId,
    projectRoot: '/home/dev/projects/example',
    projectName: 'example',
    devServerUrl: 'http://127.0.0.1:20041',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    status: 'capturing',
    question: 'Why is this interaction slow?',
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
  };
}

describe('the flat sources against the real store', () => {
  let directory: string;
  let store: Store;
  let written: TelemetryEvent[];
  let resolver: PanelDataResolver;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'debuggen-panel-data-'));
    store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite') }));
    const sessions = createSessionsRepo({ store, now: () => BASE_TIME });
    unwrap(sessions.insert(sessionRecord(SESSION_A)));
    unwrap(
      sessions.startCapture({
        sessionId: SESSION_A,
        planVersion: 1,
        captureId: CAPTURE_A1,
        startedAt: BASE_TIME,
      }),
    );
    const telemetry = createTelemetryRepo({ store });
    const batch = Array.from({ length: 23 }, (_, index) =>
      makeWritable({
        kind: index % 7 === 0 ? 'state' : 'function',
        startTime: at(Math.floor(index / 4) * 2.5),
        duration: index % 7 === 0 ? 0 : ([4, 1.5, 4, 8][index % 4] ?? 1),
      }),
    );
    written = unwrap(telemetry.insertMany(batch)).events;
    resolver = createPanelDataResolver({
      telemetry,
      correlator: createTraceCorrelator({ telemetry }),
      sessions,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['spans', 'events'] as const)(
    'pages %s in exactly the stated chain order under each permitted sort',
    async (source) => {
      const table: Readonly<Partial<Record<DataQuerySort, SortChain<TelemetryEvent>>>> =
        SOURCE_SORT_KEYS[source];
      const expectedRows = written.filter(
        (event) => source === 'events' || SPAN_SOURCE_KINDS.includes(event.kind),
      );
      for (const sort of Object.keys(table) as DataQuerySort[]) {
        const chain = table[sort];
        if (chain === undefined) {
          throw new Error(`no chain for ${sort}`);
        }
        const walk = await walkAll(resolver, { source, sort }, 4);
        expect(walk.ids).toStrictEqual(orderRows(expectedRows, chain).map((event) => event.id));
        expect(walk.totals.every((total) => total === expectedRows.length)).toBe(true);
      }
    },
  );

  it('reads the session’s open capture and answers every source from the real store', async () => {
    for (const query of QUERIES_BY_SOURCE) {
      const result = await resolved(resolver, query, { sessionId: SESSION_A });
      expect(result.source).toBe(query.source);
    }
  });
});
