/**
 * Tests for `./telemetry-repo.ts`: the table every piece of evidence this
 * product reasons about passes through.
 *
 * What is on trial here is not a repository's CRUD. Five properties are, and
 * each block below exists because breaking one of them turns a debugging
 * session's answer into a plausible fiction:
 *
 * 1. **The order is total, and it is the one the correlator uses.** A page of
 *    rows must come back in `start_time`, then `(producer_id, seq)`, then
 *    `ingest_seq` order — and identical timestamps across two producers are the
 *    ordinary case, not the exotic one, because a page document and a
 *    dev-server process read the same millisecond. The suite pins the SQL order
 *    against `compareEventsCanonical`, the in-memory twin, rather than against
 *    a hand-written expectation.
 * 2. **Precision survives.** `start_time` and `duration` are `REAL` because the
 *    producers emit sub-millisecond doubles, and a cross-tier timeline is only
 *    correct if the value that comes back is the value that went in — to the
 *    last decimal place.
 * 3. **A replay is idempotent.** The browser agent buffers up to 5 000 events
 *    while its bridge is down and re-sends them on reconnect, so a batch
 *    overlapping one already stored must not duplicate rows, must not renumber
 *    them, and must still report the arrival number each event really has.
 * 4. **Paging is stable, and `total`/`nextOffset` are honest.** A walk over
 *    several pages must visit every row exactly once, including under
 *    `duration_desc`, where equal durations are common.
 * 5. **Privacy.** An event's attributes are captured data. The suite plants a
 *    sentinel inside one and asserts it appears in no log record and in no
 *    error payload — on the success path, on a refusal path and on the
 *    unreadable-row path, which are the three places a value escapes.
 *
 * The store is the real one: `openStore` against an `mkdtemp` sandbox **on
 * disk** rather than in memory, because two of the guarantees above are
 * properties of a file — `AUTOINCREMENT` never reusing an arrival number after
 * a purge, and a bulk insert committing inside one transaction. Nothing under
 * `$DEBUGGEN_HOME` is touched and no socket is opened, which is the contract of
 * the `local-service` Vitest project.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DATA_QUERY_DEFAULT_LIMIT, DATA_QUERY_MAX_LIMIT } from '@debuggen/panel-schema';
import {
  createConsoleLogger,
  isErr,
  newCaptureId,
  newEventId,
  newProducerId,
  newSessionId,
  newSpanId,
  newTraceId,
  unwrap,
} from '@debuggen/shared';
import type { LogRecord } from '@debuggen/shared';
import { TELEMETRY_KINDS, TELEMETRY_TIERS, allowedTiersFor } from '@debuggen/telemetry';
import { compareEventsCanonical } from '@debuggen/telemetry';
import type {
  TelemetryEvent,
  TelemetryKind,
  TelemetryStatus,
  TelemetryTier,
} from '@debuggen/telemetry';

import { openStore } from './db.js';
import type { Store } from './db.js';
import {
  CANONICAL_ORDER_BY,
  DEFAULT_PURGE_BATCH_SIZE,
  DURATION_DESC_ORDER_BY,
  EXISTENCE_LOOKUP_CHUNK_SIZE,
  TELEMETRY_QUERY_DEFAULT_LIMIT,
  TELEMETRY_QUERY_MAX_LIMIT,
  TELEMETRY_SORTS,
  createTelemetryRepo,
} from './telemetry-repo.js';
import type { PersistableTelemetryEvent, TelemetryPage, TelemetryRepo } from './telemetry-repo.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The session most tests work in. */
const SESSION_A = newSessionId();

/** A second session, for the scoping assertions. */
const SESSION_B = newSessionId();

/** The capture most tests work in. */
const CAPTURE_A1 = newCaptureId();

/** A second capture of {@link SESSION_A}, for the narrowing assertions. */
const CAPTURE_A2 = newCaptureId();

/** The capture of {@link SESSION_B}. */
const CAPTURE_B1 = newCaptureId();

/** The trace most events belong to. */
const TRACE_A = newTraceId();

/** A second trace, for the trace-scoping assertions. */
const TRACE_B = newTraceId();

/** The browser producer. */
const PRODUCER_BROWSER = newProducerId();

/** The server producer, which reports the same milliseconds as the browser one. */
const PRODUCER_SERVER = newProducerId();

/**
 * An epoch-millisecond base inside the schema's accepted window, with room for
 * the offsets the tests add.
 */
const BASE_TIME = 1_767_225_600_000;

/**
 * The string the privacy assertions look for.
 *
 * Shaped like something that must never be logged and unlikely to occur by
 * accident, so a match is unambiguous.
 */
const SENTINEL = 'ATTRIBUTE-SENTINEL-4f1c8ab3-never-log-me';

/** The sandbox directory holding the database for one test. */
let directory: string;

/** The store under the repository. */
let store: Store;

/** Every log record either the store or the repository emitted. */
let logs: LogRecord[];

/** The repository under test. */
let repo: TelemetryRepo;

/** Per-producer sequence counters, so every built event has a distinct `seq`. */
let sequences: Map<string, number>;

/** The next `seq` for one producer. */
function nextSeq(producerId: string): number {
  const next = sequences.get(producerId) ?? 0;

  sequences.set(producerId, next + 1);

  return next;
}

/** Inserts the `sessions` row every telemetry foreign key requires. */
function insertSession(sessionId: string): void {
  store
    .statement(
      `INSERT INTO sessions (
         id, project_root, project_name, status, question, dev_server_url, created_at, updated_at, record
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      '/home/dev/projects/example',
      'example',
      'capturing',
      'Why is this interaction slow?',
      'http://127.0.0.1:20171',
      BASE_TIME,
      BASE_TIME,
      '{}',
    );
}

/** Inserts the `captures` row every telemetry foreign key requires. */
function insertCapture(captureId: string, sessionId: string): void {
  store
    .statement(
      `INSERT INTO captures (id, session_id, plan_version, started_at, stopped_at, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(captureId, sessionId, 1, BASE_TIME, null, null);
}

/** What {@link buildEvent} may override. */
interface EventOverrides {
  readonly id?: string;
  readonly sessionId?: string;
  readonly captureId?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly kind?: TelemetryKind;
  readonly tier?: TelemetryTier;
  readonly name?: string;
  readonly startTime?: number;
  readonly duration?: number;
  readonly attributes?: Record<string, unknown>;
  readonly status?: TelemetryStatus;
  readonly producerId?: string;
  readonly seq?: number;
}

/**
 * Builds a storable event.
 *
 * The tier defaults to the first one the kind is *allowed* in, read from the
 * telemetry package's own rule, so the suite cannot accidentally build an event
 * the schema's cross-field check would reject for a reason unrelated to what is
 * being tested.
 */
function buildEvent(overrides: EventOverrides = {}): PersistableTelemetryEvent {
  const kind = overrides.kind ?? 'fetch';
  const producerId = overrides.producerId ?? PRODUCER_BROWSER;
  const allowed = allowedTiersFor(kind);
  const tier = overrides.tier ?? allowed[0] ?? 'browser';

  return {
    id: overrides.id ?? newEventId(),
    sessionId: overrides.sessionId ?? SESSION_A,
    captureId: overrides.captureId ?? CAPTURE_A1,
    traceId: overrides.traceId ?? TRACE_A,
    spanId: overrides.spanId ?? newSpanId(),
    ...(overrides.parentSpanId !== undefined ? { parentSpanId: overrides.parentSpanId } : {}),
    kind,
    tier,
    name: overrides.name ?? 'operation',
    startTime: overrides.startTime ?? BASE_TIME,
    duration: overrides.duration ?? 1,
    attributes: overrides.attributes ?? {},
    status: overrides.status ?? 'ok',
    producerId,
    seq: overrides.seq ?? nextSeq(producerId),
  };
}

/** Stores events and fails the test if the repository refused them. */
function insertOk(events: readonly PersistableTelemetryEvent[]): TelemetryEvent[] {
  const written = repo.insertMany(events);

  if (isErr(written)) {
    throw new Error(
      `insertMany refused a batch the test expected to succeed: ${written.error.code}`,
    );
  }

  return written.value.events;
}

/** Reads one row as raw columns, for the column-for-column assertions. */
function readRow(id: string): Record<string, unknown> | undefined {
  return store.statement('SELECT * FROM telemetry_events WHERE id = ?').get(id);
}

/** Everything the store and the repository said, as one searchable string. */
function loggedText(): string {
  return JSON.stringify(logs);
}

/** Everything an error carries, as one searchable string. */
function errorText(error: {
  readonly message: string;
  readonly hint?: string | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}): string {
  return JSON.stringify({
    message: error.message,
    hint: error.hint,
    details: error.details,
  });
}

/** The `EXPLAIN QUERY PLAN` lines of a statement. */
function queryPlan(sql: string): string[] {
  return store.db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => String(row['detail']));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'debuggen-telemetry-'));
  logs = [];
  sequences = new Map();

  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      logs.push(record);
    },
  });

  store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite'), logger }));
  repo = createTelemetryRepo({ store, logger });

  insertSession(SESSION_A);
  insertSession(SESSION_B);
  insertCapture(CAPTURE_A1, SESSION_A);
  insertCapture(CAPTURE_A2, SESSION_A);
  insertCapture(CAPTURE_B1, SESSION_B);
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------------------------------
 * The contract
 * ---------------------------------------------------------------------------------------------- */

describe('the contract', () => {
  it('exposes every member the service depends on', () => {
    const members = [
      'insertMany',
      'query',
      'listByTrace',
      'listByCapture',
      'listByRequestKey',
      'listChildren',
      'getBySpanId',
      'listTraceIds',
      'countByKind',
      'existingEventIds',
      'existingTraceIds',
      'partitionKnownEventIds',
      'partitionKnownTraceIds',
      'countBySession',
      'deleteBySession',
      'deleteOlderThan',
    ] as const;

    for (const member of members) {
      expect(typeof repo[member]).toBe('function');
    }
  });

  it('keeps the SQL tier vocabulary equal to TELEMETRY_TIERS, in order', () => {
    const ddl = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
    const match = /CHECK\s*\(tier IN \(([^)]*)\)\)/.exec(ddl);

    expect(match).not.toBeNull();

    const listed = (match?.[1] ?? '')
      .split(',')
      .map((value) => value.trim().replace(/^'/, '').replace(/'$/, ''));

    expect(listed).toEqual([...TELEMETRY_TIERS]);
  });

  it('defines the canonical order once, and ends every ordering with it', () => {
    expect(CANONICAL_ORDER_BY).toBe('start_time ASC, producer_id ASC, seq ASC, ingest_seq ASC');
    expect(DURATION_DESC_ORDER_BY).toBe(`duration DESC, ${CANONICAL_ORDER_BY}`);
    expect([...TELEMETRY_SORTS]).toEqual(['start_asc', 'duration_desc']);
  });

  it('takes its paging bounds from the panel-data contract rather than restating them', () => {
    expect(TELEMETRY_QUERY_DEFAULT_LIMIT).toBe(DATA_QUERY_DEFAULT_LIMIT);
    expect(TELEMETRY_QUERY_MAX_LIMIT).toBe(DATA_QUERY_MAX_LIMIT);
    expect(TELEMETRY_QUERY_DEFAULT_LIMIT).toBe(200);
    expect(TELEMETRY_QUERY_MAX_LIMIT).toBe(5000);
    expect(EXISTENCE_LOOKUP_CHUNK_SIZE).toBe(500);
    expect(DEFAULT_PURGE_BATCH_SIZE).toBe(5000);
  });
});

/* -------------------------------------------------------------------------------------------------
 * insertMany
 * ---------------------------------------------------------------------------------------------- */

describe('insertMany', () => {
  it('writes the flat columns and the authoritative document, and round-trips the event', () => {
    const event = buildEvent({
      kind: 'db.query',
      name: 'select',
      startTime: BASE_TIME + 12,
      duration: 8.5,
      parentSpanId: newSpanId(),
      producerId: PRODUCER_SERVER,
      attributes: { 'db.system': 'postgresql', 'db.rowCount': 3 },
    });

    const [stored] = insertOk([event]);

    expect(stored).toEqual({ ...event, ingestSeq: 1 });

    const row = readRow(event.id);

    expect(row).toBeDefined();
    expect(row?.['session_id']).toBe(event.sessionId);
    expect(row?.['capture_id']).toBe(event.captureId);
    expect(row?.['trace_id']).toBe(event.traceId);
    expect(row?.['span_id']).toBe(event.spanId);
    expect(row?.['parent_span_id']).toBe(event.parentSpanId);
    expect(row?.['kind']).toBe('db.query');
    expect(row?.['tier']).toBe('db');
    expect(row?.['name']).toBe('select');
    expect(row?.['start_time']).toBe(BASE_TIME + 12);
    expect(row?.['duration']).toBe(8.5);
    expect(row?.['producer_id']).toBe(PRODUCER_SERVER);
    expect(row?.['request_key']).toBeNull();

    // The document is the authority and carries no second copy of the arrival
    // number the database owns.
    const document: unknown = JSON.parse(String(row?.['event']));

    expect(document).toEqual(event);
    expect(Object.keys(document as Record<string, unknown>)).not.toContain('ingestSeq');
  });

  it('assigns one-based arrival numbers in batch order', () => {
    const stored = insertOk([buildEvent(), buildEvent(), buildEvent()]);

    expect(stored.map((event) => event.ingestSeq)).toEqual([1, 2, 3]);
  });

  it('is an idempotent no-op for an empty batch', () => {
    const written = repo.insertMany([]);

    expect(written).toEqual({ ok: true, value: { events: [], inserted: 0, skipped: 0 } });
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(0);
  });

  it('replays a buffered batch without duplicating or renumbering rows', () => {
    const batch = [buildEvent(), buildEvent(), buildEvent()];
    const first = insertOk(batch);

    // The producer reconnects and re-sends its buffer, with one event it had
    // not managed to send before.
    const extra = buildEvent();
    const replay = repo.insertMany([...batch, extra]);

    expect(isErr(replay)).toBe(false);

    if (isErr(replay)) {
      return;
    }

    expect(replay.value.inserted).toBe(1);
    expect(replay.value.skipped).toBe(3);

    // Every skipped event carries the arrival number the store actually holds,
    // read back rather than invented.
    expect(replay.value.events.slice(0, 3).map((event) => event.ingestSeq)).toEqual(
      first.map((event) => event.ingestSeq),
    );

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(4);
  });

  it('stores one row for an id repeated inside a single batch', () => {
    const event = buildEvent();
    const written = repo.insertMany([event, event]);

    expect(isErr(written)).toBe(false);

    if (isErr(written)) {
      return;
    }

    expect(written.value.inserted).toBe(1);
    expect(written.value.skipped).toBe(1);

    // Both copies report the one arrival number the row really has, so a
    // consumer broadcasting the batch cannot attribute two numbers to one
    // event.
    const [first, second] = written.value.events;

    expect(first?.ingestSeq).toBe(1);
    expect(second?.ingestSeq).toBe(1);
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(1);
  });

  it('never reuses an arrival number after a purge', () => {
    insertOk([buildEvent(), buildEvent(), buildEvent()]);

    expect(unwrap(repo.deleteBySession(SESSION_A))).toBe(3);

    const [afterPurge] = insertOk([buildEvent()]);

    // AUTOINCREMENT rather than a bare rowid alias: the canonical order stays
    // sound across the lifetime of the database precisely because this number
    // cannot repeat one a deleted row already used.
    expect(afterPurge?.ingestSeq).toBeGreaterThan(3);
  });

  it('preserves a sub-millisecond start time exactly', () => {
    const startTime = BASE_TIME + 123.456;
    const duration = 0.375;
    const [stored] = insertOk([buildEvent({ startTime, duration })]);

    expect(stored?.startTime).toBe(startTime);
    expect(stored?.duration).toBe(duration);

    const row = readRow(stored?.id ?? '');

    expect(row?.['start_time']).toBe(startTime);
    expect(row?.['duration']).toBe(duration);

    // Stored as a real rather than coerced to an integer: the whole cross-tier
    // timeline is relative offsets computed from this value.
    const typed = store
      .statement('SELECT typeof(start_time) AS t, typeof(duration) AS d FROM telemetry_events')
      .get();

    expect(typed?.['t']).toBe('real');
    expect(typed?.['d']).toBe('real');

    const page = unwrap(repo.query({ sessionId: SESSION_A }));

    expect(page.rows[0]?.startTime).toBe(startTime);
  });

  it('denormalises the service-assigned request key out of the attributes', () => {
    const requestKey = 'a1'.repeat(32);
    const [stored] = insertOk([
      buildEvent({ attributes: { request_key: requestKey, 'http.method': 'GET' } }),
    ]);

    expect(readRow(stored?.id ?? '')?.['request_key']).toBe(requestKey);
  });

  it('refuses a batch whose element is missing its attribution, and writes nothing', () => {
    const valid = buildEvent();

    // The attribution the service assigns, absent — which is what an event that
    // reached the store without passing through attribution looks like.
    const unattributed: Record<string, unknown> = { ...buildEvent() };

    delete unattributed['captureId'];

    const written = repo.insertMany([valid, unattributed as unknown as PersistableTelemetryEvent]);

    expect(isErr(written)).toBe(true);

    if (!isErr(written)) {
      return;
    }

    expect(written.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(written.error.message).toContain('captureId');
    expect(written.error.details?.['index']).toBe(1);
    expect(written.error.details?.['batchSize']).toBe(2);

    // Refused before the transaction opened, so the valid element is not
    // stored either: a batch is all or nothing.
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(0);
  });

  it('refuses an event whose kind and tier disagree', () => {
    const written = repo.insertMany([buildEvent({ kind: 'render', tier: 'db' })]);

    expect(isErr(written)).toBe(true);

    if (isErr(written)) {
      expect(written.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    }

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(0);
  });

  it('refuses telemetry attributed to a capture the store does not hold', () => {
    const written = repo.insertMany([buildEvent({ captureId: newCaptureId() })]);

    expect(isErr(written)).toBe(true);

    if (isErr(written)) {
      expect(written.error.code).toBe('STORE_ERROR');
      expect(written.error.details?.['reason']).toBe('unknown-attribution');
    }
  });

  it('refuses an event id already stored under another session, and rolls the batch back', () => {
    const shared = buildEvent();

    insertOk([shared]);

    const written = repo.insertMany([
      buildEvent({ sessionId: SESSION_B, captureId: CAPTURE_B1 }),
      { ...shared, sessionId: SESSION_B, captureId: CAPTURE_B1 },
    ]);

    expect(isErr(written)).toBe(true);

    if (isErr(written)) {
      expect(written.error.code).toBe('STORE_ERROR');
      expect(written.error.details?.['reason']).toBe('event-id-reused');
    }

    // The first element of the batch was written and then rolled back.
    expect(unwrap(repo.countBySession(SESSION_B))).toBe(0);
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(1);
  });

  it('logs one line per batch, carrying counts only', () => {
    insertOk([buildEvent({ name: SENTINEL, attributes: { note: SENTINEL } })]);

    const batchLines = logs.filter((record) => record.message === 'stored a telemetry batch');

    expect(batchLines).toHaveLength(1);
    expect(batchLines[0]?.fields).toMatchObject({
      subsystem: 'store',
      repo: 'telemetry',
      operation: 'insertMany',
      batchSize: 1,
      inserted: 1,
      skipped: 0,
    });
    expect(loggedText()).not.toContain(SENTINEL);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The canonical order
 * ---------------------------------------------------------------------------------------------- */

describe('the canonical order', () => {
  it('orders equal start times across two producers exactly as the correlator does', () => {
    // Two producers reporting the same millisecond, offered out of order, with
    // the server producer's second event deliberately sharing its first
    // event's timestamp.
    const browserFirst = buildEvent({ producerId: PRODUCER_BROWSER, seq: 0 });
    const browserSecond = buildEvent({ producerId: PRODUCER_BROWSER, seq: 1 });
    const serverFirst = buildEvent({
      kind: 'http.server',
      producerId: PRODUCER_SERVER,
      seq: 0,
    });
    const serverSecond = buildEvent({
      kind: 'http.server',
      producerId: PRODUCER_SERVER,
      seq: 1,
    });

    const stored = insertOk([serverSecond, browserSecond, serverFirst, browserFirst]);
    const page = unwrap(repo.query({ sessionId: SESSION_A }));

    expect(page.rows.map((event) => event.id)).toEqual(
      [...stored].sort(compareEventsCanonical).map((event) => event.id),
    );

    // And the tie-break really is producer then sequence: the four events share
    // a start time, so nothing else could have decided the order.
    const grouped = page.rows.map((event) => `${event.producerId}:${String(event.seq)}`);

    expect(grouped).toEqual([...grouped].sort());
  });

  it('breaks a start-time tie within one producer on the arrival number when seq repeats', () => {
    // Two events of one producer with the same timestamp AND the same
    // sequence — only possible from a producer bug or a replayed counter, and
    // exactly the case `ingest_seq` exists for.
    const first = buildEvent({ producerId: PRODUCER_BROWSER, seq: 7 });
    const second = buildEvent({ producerId: PRODUCER_BROWSER, seq: 7 });

    insertOk([first, second]);

    const page = unwrap(repo.query({ sessionId: SESSION_A }));

    expect(page.rows.map((event) => event.id)).toEqual([first.id, second.id]);
    expect(page.rows.map((event) => event.ingestSeq)).toEqual([1, 2]);
  });

  it('keeps duration_desc stable across pages when durations repeat', () => {
    const events = [
      buildEvent({ duration: 5 }),
      buildEvent({ duration: 5 }),
      buildEvent({ duration: 5 }),
      buildEvent({ duration: 1 }),
      buildEvent({ duration: 9 }),
      buildEvent({ duration: 1 }),
    ];

    insertOk(events);

    const whole = unwrap(repo.query({ sessionId: SESSION_A, sort: 'duration_desc' }));
    const walked: string[] = [];

    for (let offset = 0; offset < whole.total; offset += 2) {
      const page = unwrap(
        repo.query({ sessionId: SESSION_A, sort: 'duration_desc', limit: 2, offset }),
      );

      walked.push(...page.rows.map((event) => event.id));
    }

    // Every row exactly once, in the same order the single-page read gave: the
    // tie-break chain behind `duration DESC` is what makes that true.
    expect(walked).toEqual(whole.rows.map((event) => event.id));
    expect(new Set(walked).size).toBe(events.length);
    expect(whole.rows.map((event) => event.duration)).toEqual([9, 5, 5, 5, 1, 1]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * query
 * ---------------------------------------------------------------------------------------------- */

describe('query', () => {
  it('defaults to the first 200 rows in canonical order', () => {
    const events = Array.from({ length: TELEMETRY_QUERY_DEFAULT_LIMIT + 5 }, (_unused, index) =>
      buildEvent({ startTime: BASE_TIME + index }),
    );

    insertOk(events);

    const page = unwrap(repo.query({ sessionId: SESSION_A }));

    expect(page.rows).toHaveLength(TELEMETRY_QUERY_DEFAULT_LIMIT);
    expect(page.total).toBe(events.length);
    expect(page.nextOffset).toBe(TELEMETRY_QUERY_DEFAULT_LIMIT);
    expect(page.rows[0]?.startTime).toBe(BASE_TIME);
  });

  it('clamps a page size above the ceiling instead of refusing it', () => {
    insertOk([buildEvent(), buildEvent()]);

    const page = unwrap(
      repo.query({ sessionId: SESSION_A, limit: TELEMETRY_QUERY_MAX_LIMIT + 10_000 }),
    );

    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(2);
    expect(page.nextOffset).toBeUndefined();
  });

  it('answers a page size of zero with the count alone', () => {
    insertOk([buildEvent(), buildEvent(), buildEvent()]);

    const page = unwrap(repo.query({ sessionId: SESSION_A, limit: 0 }));

    expect(page.rows).toEqual([]);
    expect(page.total).toBe(3);
    expect(page.nextOffset).toBe(0);
  });

  it('reports total and nextOffset correctly across a multi-page walk', () => {
    const events = Array.from({ length: 7 }, (_unused, index) =>
      buildEvent({ startTime: BASE_TIME + index }),
    );

    insertOk(events);

    const seen: string[] = [];
    const offsets: (number | undefined)[] = [];
    let offset: number | undefined = 0;

    while (offset !== undefined) {
      const page: TelemetryPage = unwrap(repo.query({ sessionId: SESSION_A, limit: 3, offset }));

      expect(page.total).toBe(7);
      seen.push(...page.rows.map((event) => event.id));
      offsets.push(page.nextOffset);
      offset = page.nextOffset;
    }

    expect(offsets).toEqual([3, 6, undefined]);
    expect(seen).toEqual(events.map((event) => event.id));
  });

  it('narrows by capture, trace, kind, tier, duration, component and request key', () => {
    const requestKey = 'b2'.repeat(32);

    const inCaptureTwo = buildEvent({ captureId: CAPTURE_A2 });
    const inTraceB = buildEvent({ traceId: TRACE_B });
    const render = buildEvent({ kind: 'render', attributes: { component: 'SampleComponent' } });
    const otherRender = buildEvent({ kind: 'render', attributes: { component: 'OtherComponent' } });
    const serverSpan = buildEvent({ kind: 'http.server', producerId: PRODUCER_SERVER });
    const slow = buildEvent({ duration: 640 });
    const keyed = buildEvent({ attributes: { request_key: requestKey } });

    insertOk([inCaptureTwo, inTraceB, render, otherRender, serverSpan, slow, keyed]);

    const byCapture = unwrap(repo.query({ sessionId: SESSION_A, captureId: CAPTURE_A2 }));

    expect(byCapture.rows.map((event) => event.id)).toEqual([inCaptureTwo.id]);

    const byTrace = unwrap(repo.query({ sessionId: SESSION_A, traceId: TRACE_B }));

    expect(byTrace.rows.map((event) => event.id)).toEqual([inTraceB.id]);

    const byKind = unwrap(repo.query({ sessionId: SESSION_A, kinds: ['render'] }));

    expect(byKind.rows.map((event) => event.id).sort()).toEqual([render.id, otherRender.id].sort());

    const byTier = unwrap(repo.query({ sessionId: SESSION_A, tiers: ['server'] }));

    expect(byTier.rows.map((event) => event.id)).toEqual([serverSpan.id]);

    const byDuration = unwrap(repo.query({ sessionId: SESSION_A, minDuration: 100 }));

    expect(byDuration.rows.map((event) => event.id)).toEqual([slow.id]);

    const byComponent = unwrap(repo.query({ sessionId: SESSION_A, component: 'SampleComponent' }));

    expect(byComponent.rows.map((event) => event.id)).toEqual([render.id]);

    const byRequestKey = unwrap(repo.query({ sessionId: SESSION_A, requestKey }));

    expect(byRequestKey.rows.map((event) => event.id)).toEqual([keyed.id]);
  });

  it('never reaches across sessions', () => {
    const mine = buildEvent();

    insertOk([mine, buildEvent({ sessionId: SESSION_B, captureId: CAPTURE_B1 })]);

    const page = unwrap(repo.query({ sessionId: SESSION_A }));

    expect(page.rows.map((event) => event.id)).toEqual([mine.id]);
    expect(page.total).toBe(1);
  });

  it('answers a filter narrowed to nothing with an empty page', () => {
    insertOk([buildEvent()]);

    for (const filter of [
      { sessionId: SESSION_A, kinds: [] },
      { sessionId: SESSION_A, tiers: [] },
    ] as const) {
      const page = unwrap(repo.query(filter));

      expect(page.rows).toEqual([]);
      expect(page.total).toBe(0);
      expect(page.nextOffset).toBeUndefined();
    }
  });

  it('refuses an argument it will not accept, naming the reason', () => {
    const cases = [
      [{ sessionId: '' }, 'blank-session-id'],
      [{ sessionId: SESSION_A, traceId: '' }, 'blank-filter'],
      [{ sessionId: SESSION_A, limit: -1 }, 'invalid-limit'],
      [{ sessionId: SESSION_A, limit: 1.5 }, 'invalid-limit'],
      [{ sessionId: SESSION_A, offset: -1 }, 'invalid-offset'],
      [{ sessionId: SESSION_A, offset: 2.5 }, 'invalid-offset'],
      [{ sessionId: SESSION_A, minDuration: Number.NaN }, 'invalid-min-duration'],
      [{ sessionId: SESSION_A, minDuration: -1 }, 'invalid-min-duration'],
      [{ sessionId: SESSION_A, sort: 'count_desc' }, 'unknown-sort'],
      [{ sessionId: SESSION_A, kinds: ['not-a-kind'] }, 'unknown-kind'],
      [{ sessionId: SESSION_A, tiers: ['not-a-tier'] }, 'unknown-tier'],
    ] as const;

    for (const [filter, reason] of cases) {
      const result = repo.query(filter as Parameters<TelemetryRepo['query']>[0]);

      expect(isErr(result)).toBe(true);

      if (isErr(result)) {
        expect(result.error.code).toBe('STORE_ERROR');
        expect(result.error.details?.['reason']).toBe(reason);
      }
    }
  });

  it('skips a row that no longer validates, counts it, and logs its arrival number only', () => {
    const good = buildEvent({ startTime: BASE_TIME });

    insertOk([good]);

    // A row written by another build: valid flat columns, a document this build
    // cannot reconstruct, and a captured value inside it.
    store
      .statement(
        `INSERT INTO telemetry_events (
           id, session_id, capture_id, trace_id, span_id, parent_span_id, kind, tier,
           name, start_time, duration, producer_id, seq, request_key, event
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newEventId(),
        SESSION_A,
        CAPTURE_A1,
        TRACE_A,
        newSpanId(),
        null,
        'fetch',
        'browser',
        'operation',
        BASE_TIME + 1,
        1,
        PRODUCER_BROWSER,
        99,
        null,
        JSON.stringify({ unexpected: SENTINEL }),
      );

    const page = unwrap(repo.query({ sessionId: SESSION_A }));

    // One poisoned row must not blank out a whole generated panel.
    expect(page.rows.map((event) => event.id)).toEqual([good.id]);
    expect(page.total).toBe(2);
    expect(page.skipped).toBe(1);

    const warning = logs.find(
      (record) => record.message === 'skipped telemetry rows that no longer match the event schema',
    );

    expect(warning?.level).toBe('warn');
    expect(warning?.fields).toMatchObject({ skipped: 1, ingestSeqs: [2] });
    expect(loggedText()).not.toContain(SENTINEL);
  });

  it('advances past an unreadable row so a paging loop cannot stall', () => {
    insertOk([buildEvent({ startTime: BASE_TIME })]);

    store
      .statement(
        `INSERT INTO telemetry_events (
           id, session_id, capture_id, trace_id, span_id, kind, tier,
           name, start_time, duration, producer_id, seq, event
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newEventId(),
        SESSION_A,
        CAPTURE_A1,
        TRACE_A,
        newSpanId(),
        'fetch',
        'browser',
        'operation',
        BASE_TIME + 1,
        1,
        PRODUCER_BROWSER,
        98,
        'not json at all',
      );

    const last = buildEvent({ startTime: BASE_TIME + 2 });

    insertOk([last]);

    const first = unwrap(repo.query({ sessionId: SESSION_A, limit: 2 }));

    // The offset advances by the rows the statement returned, not by the events
    // it kept, so the walk reaches the third row.
    expect(first.nextOffset).toBe(2);
    expect(first.skipped).toBe(1);

    const second = unwrap(repo.query({ sessionId: SESSION_A, limit: 2, offset: first.nextOffset }));

    expect(second.rows.map((event) => event.id)).toEqual([last.id]);
    expect(second.nextOffset).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------------------------------
 * The convenience readers
 * ---------------------------------------------------------------------------------------------- */

describe('the convenience readers', () => {
  it('reads one trace, one capture, one request group and one span\u2019s children', () => {
    const root = buildEvent({ kind: 'interaction', startTime: BASE_TIME });
    const child = buildEvent({
      kind: 'fetch',
      parentSpanId: root.spanId,
      startTime: BASE_TIME + 2,
    });
    const requestKey = 'c3'.repeat(32);
    const keyedOne = buildEvent({
      attributes: { request_key: requestKey },
      startTime: BASE_TIME + 4,
    });
    const keyedTwo = buildEvent({
      attributes: { request_key: requestKey },
      startTime: BASE_TIME + 6,
    });
    const otherTrace = buildEvent({ traceId: TRACE_B, startTime: BASE_TIME + 8 });
    const otherCapture = buildEvent({
      captureId: CAPTURE_A2,
      traceId: TRACE_B,
      startTime: BASE_TIME + 10,
    });

    insertOk([otherCapture, keyedTwo, otherTrace, child, keyedOne, root]);

    expect(unwrap(repo.listByTrace(SESSION_A, TRACE_A)).rows.map((event) => event.id)).toEqual([
      root.id,
      child.id,
      keyedOne.id,
      keyedTwo.id,
    ]);

    expect(unwrap(repo.listByCapture(SESSION_A, CAPTURE_A2)).rows.map((event) => event.id)).toEqual(
      [otherCapture.id],
    );

    expect(
      unwrap(repo.listByRequestKey(SESSION_A, requestKey)).rows.map((event) => event.id),
    ).toEqual([keyedOne.id, keyedTwo.id]);

    expect(unwrap(repo.listChildren(SESSION_A, root.spanId)).rows.map((event) => event.id)).toEqual(
      [child.id],
    );
  });

  it('accepts the same narrowing through a convenience reader as through query', () => {
    const render = buildEvent({ kind: 'render', duration: 12 });

    insertOk([render, buildEvent({ kind: 'fetch', duration: 1 })]);

    const page = unwrap(
      repo.listByTrace(SESSION_A, TRACE_A, { kinds: ['render'], minDuration: 10, limit: 5 }),
    );

    expect(page.rows.map((event) => event.id)).toEqual([render.id]);
    expect(page.total).toBe(1);
  });

  it('reads one span by id, and answers undefined for one it does not hold', () => {
    const event = buildEvent();

    insertOk([event]);

    expect(unwrap(repo.getBySpanId(SESSION_A, event.spanId))?.id).toBe(event.id);
    expect(unwrap(repo.getBySpanId(SESSION_A, newSpanId()))).toBeUndefined();
    expect(unwrap(repo.getBySpanId(SESSION_B, event.spanId))).toBeUndefined();
  });

  it('lists distinct trace ids ordered by each trace\u2019s earliest event', () => {
    insertOk([
      buildEvent({ traceId: TRACE_B, startTime: BASE_TIME + 5 }),
      buildEvent({ traceId: TRACE_A, startTime: BASE_TIME + 1 }),
      buildEvent({ traceId: TRACE_A, startTime: BASE_TIME + 9 }),
      buildEvent({ traceId: TRACE_B, startTime: BASE_TIME + 7, captureId: CAPTURE_A2 }),
    ]);

    expect(unwrap(repo.listTraceIds(SESSION_A))).toEqual([TRACE_A, TRACE_B]);
    expect(unwrap(repo.listTraceIds(SESSION_A, CAPTURE_A2))).toEqual([TRACE_B]);
    expect(unwrap(repo.listTraceIds(SESSION_B))).toEqual([]);
  });

  it('counts by kind, zero-filled over the whole vocabulary', () => {
    insertOk([
      buildEvent({ kind: 'render' }),
      buildEvent({ kind: 'render' }),
      buildEvent({ kind: 'fetch' }),
      buildEvent({ kind: 'db.query', producerId: PRODUCER_SERVER }),
      buildEvent({ kind: 'fetch', captureId: CAPTURE_A2 }),
    ]);

    const counts = unwrap(repo.countByKind(SESSION_A));

    expect(Object.keys(counts).sort()).toEqual([...TELEMETRY_KINDS].sort());
    expect(counts.render).toBe(2);
    expect(counts.fetch).toBe(2);
    expect(counts['db.query']).toBe(1);
    expect(counts.interaction).toBe(0);

    const scoped = unwrap(repo.countByKind(SESSION_A, CAPTURE_A2));

    expect(scoped.fetch).toBe(1);
    expect(scoped.render).toBe(0);
  });

  it('ignores and reports a stored kind outside the vocabulary', () => {
    store
      .statement(
        `INSERT INTO telemetry_events (
           id, session_id, capture_id, trace_id, span_id, kind, tier,
           name, start_time, duration, producer_id, seq, event
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newEventId(),
        SESSION_A,
        CAPTURE_A1,
        TRACE_A,
        newSpanId(),
        'kind.from.another.build',
        'browser',
        'operation',
        BASE_TIME,
        1,
        PRODUCER_BROWSER,
        0,
        '{}',
      );

    const counts = unwrap(repo.countByKind(SESSION_A));

    expect(Object.values(counts).reduce((total, value) => total + value, 0)).toBe(0);
    expect(
      logs.some(
        (record) =>
          record.message === 'ignored telemetry rows whose kind is outside the vocabulary',
      ),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The existence lookups
 * ---------------------------------------------------------------------------------------------- */

describe('the existence lookups', () => {
  it('answers with the subset that exists, scoped to the session and capture', () => {
    const mine = buildEvent();
    const otherCapture = buildEvent({ captureId: CAPTURE_A2 });
    const otherSession = buildEvent({ sessionId: SESSION_B, captureId: CAPTURE_B1 });
    const fabricated = newEventId();

    insertOk([mine, otherCapture, otherSession]);

    const found = unwrap(
      repo.existingEventIds(SESSION_A, [mine.id, otherCapture.id, otherSession.id, fabricated]),
    );

    expect([...found].sort()).toEqual([mine.id, otherCapture.id].sort());

    const scoped = unwrap(repo.existingEventIds(SESSION_A, [mine.id, otherCapture.id], CAPTURE_A1));

    expect([...scoped]).toEqual([mine.id]);

    const traces = unwrap(repo.existingTraceIds(SESSION_A, [TRACE_A, TRACE_B]));

    expect([...traces]).toEqual([TRACE_A]);
  });

  it('answers an empty or all-blank input without touching the database', () => {
    store.close();

    // The handle is closed, so any statement would throw: reaching the database
    // at all would turn these into failures.
    expect(unwrap(repo.existingEventIds(SESSION_A, []))).toEqual(new Set());
    expect(unwrap(repo.existingTraceIds(SESSION_A, ['']))).toEqual(new Set());

    store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite') }));
  });

  it('chunks a large citation list and unions the results', () => {
    const events = Array.from({ length: EXISTENCE_LOOKUP_CHUNK_SIZE + 100 }, (_unused, index) =>
      buildEvent({ startTime: BASE_TIME + index }),
    );

    insertOk(events);

    const real = events.map((event) => event.id);
    const fabricated = Array.from({ length: EXISTENCE_LOOKUP_CHUNK_SIZE + 1 }, () => newEventId());

    // 1 201 distinct ids: three statements at the 500-parameter bound rather
    // than one enormous one.
    const found = unwrap(repo.existingEventIds(SESSION_A, [...real, ...fabricated]));

    expect(found.size).toBe(real.length);

    for (const id of real) {
      expect(found.has(id)).toBe(true);
    }

    for (const id of fabricated) {
      expect(found.has(id)).toBe(false);
    }
  });

  it('de-duplicates the input rather than binding a citation twice', () => {
    const event = buildEvent();

    insertOk([event]);

    const repeated = Array.from({ length: EXISTENCE_LOOKUP_CHUNK_SIZE * 3 }, () => event.id);

    expect(unwrap(repo.existingEventIds(SESSION_A, repeated))).toEqual(new Set([event.id]));
  });

  it('partitions citations into known and unknown for the semantic validator', () => {
    const event = buildEvent();
    const fabricated = newEventId();

    insertOk([event]);

    const events = unwrap(repo.partitionKnownEventIds(SESSION_A, [event.id, fabricated]));

    expect([...events.known]).toEqual([event.id]);
    expect([...events.unknown]).toEqual([fabricated]);

    const traces = unwrap(repo.partitionKnownTraceIds(SESSION_A, [TRACE_A, TRACE_B]));

    expect([...traces.known]).toEqual([TRACE_A]);
    expect([...traces.unknown]).toEqual([TRACE_B]);
  });

  it('refuses a lookup that named no session', () => {
    const result = repo.existingEventIds('', [newEventId()]);

    expect(isErr(result)).toBe(true);

    if (isErr(result)) {
      expect(result.error.code).toBe('STORE_ERROR');
      expect(result.error.details?.['reason']).toBe('blank-session-id');
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Retention
 * ---------------------------------------------------------------------------------------------- */

describe('retention', () => {
  it('counts and deletes one session without reaching another', () => {
    insertOk([
      buildEvent(),
      buildEvent(),
      buildEvent({ sessionId: SESSION_B, captureId: CAPTURE_B1 }),
    ]);

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(2);
    expect(unwrap(repo.countBySession(SESSION_B))).toBe(1);

    expect(unwrap(repo.deleteBySession(SESSION_A))).toBe(2);

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(0);
    expect(unwrap(repo.countBySession(SESSION_B))).toBe(1);
  });

  it('deletes in bounded batches until the predicate is exhausted', () => {
    const events = Array.from({ length: 7 }, (_unused, index) =>
      buildEvent({ startTime: BASE_TIME + index }),
    );

    insertOk(events);

    // A batch size of two forces four statements, each in its own transaction,
    // which is what keeps a large purge from holding the write lock.
    expect(
      unwrap(repo.deleteOlderThan(BASE_TIME + 100, { batchSize: 2, sessionIds: [SESSION_A] })),
    ).toBe(7);

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(0);
  });

  it('deletes only what started before the cutoff', () => {
    const old = buildEvent({ startTime: BASE_TIME });
    const recent = buildEvent({ startTime: BASE_TIME + 1000 });

    insertOk([old, recent]);

    expect(unwrap(repo.deleteOlderThan(BASE_TIME + 500))).toBe(1);
    expect(unwrap(repo.query({ sessionId: SESSION_A })).rows.map((event) => event.id)).toEqual([
      recent.id,
    ]);
  });

  it('restricts a purge to the sessions it names, and deletes nothing for an empty list', () => {
    insertOk([buildEvent(), buildEvent({ sessionId: SESSION_B, captureId: CAPTURE_B1 })]);

    expect(unwrap(repo.deleteOlderThan(BASE_TIME + 100, { sessionIds: [] }))).toBe(0);
    expect(unwrap(repo.deleteOlderThan(BASE_TIME + 100, { sessionIds: [SESSION_B] }))).toBe(1);

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(1);
    expect(unwrap(repo.countBySession(SESSION_B))).toBe(0);
  });

  it('refuses a purge argument it will not accept', () => {
    const cases = [
      [Number.NaN, undefined, 'invalid-cutoff'],
      [BASE_TIME, { batchSize: 0 }, 'invalid-batch-size'],
      [BASE_TIME, { batchSize: 1.5 }, 'invalid-batch-size'],
      [BASE_TIME, { sessionIds: [''] }, 'blank-session-id'],
    ] as const;

    for (const [cutoff, options, reason] of cases) {
      const result = repo.deleteOlderThan(cutoff, options);

      expect(isErr(result)).toBe(true);

      if (isErr(result)) {
        expect(result.error.code).toBe('STORE_ERROR');
        expect(result.error.details?.['reason']).toBe(reason);
      }
    }
  });

  it('loses its rows when the session is deleted, through the schema cascade', () => {
    insertOk([buildEvent(), buildEvent()]);

    store.statement('DELETE FROM sessions WHERE id = ?').run(SESSION_A);

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Privacy
 * ---------------------------------------------------------------------------------------------- */

describe('privacy', () => {
  it('keeps a captured value out of every log record and every error payload', () => {
    const carrying = buildEvent({
      name: SENTINEL,
      attributes: { note: SENTINEL, url: `https://example.test/?token=${SENTINEL}` },
    });

    insertOk([carrying]);

    // The success path: reads, counts and lookups all touch the value.
    unwrap(repo.query({ sessionId: SESSION_A }));
    unwrap(repo.listByTrace(SESSION_A, TRACE_A));
    unwrap(repo.countByKind(SESSION_A));
    unwrap(repo.existingEventIds(SESSION_A, [carrying.id]));
    unwrap(repo.deleteBySession(SESSION_A));

    expect(loggedText()).not.toContain(SENTINEL);

    // The refusal path: the rejected event carries the sentinel in the same
    // attributes bag as the field that failed.
    const refused = repo.insertMany([
      {
        ...buildEvent({ attributes: { note: SENTINEL } }),
        startTime: -1,
      },
    ]);

    expect(isErr(refused)).toBe(true);

    if (isErr(refused)) {
      expect(errorText(refused.error)).not.toContain(SENTINEL);
      expect(refused.error.message).toContain('startTime');
    }

    expect(loggedText()).not.toContain(SENTINEL);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Bulk insertion and index use
 * ---------------------------------------------------------------------------------------------- */

describe('bulk insertion and index use', () => {
  it('stores twenty thousand events in one transaction, numbered without a gap', () => {
    const events = Array.from({ length: 20_000 }, (_unused, index) =>
      buildEvent({ startTime: BASE_TIME + index / 8, seq: index }),
    );

    const started = performance.now();
    const written = repo.insertMany(events);
    const elapsed = performance.now() - started;

    expect(isErr(written)).toBe(false);

    if (isErr(written)) {
      return;
    }

    expect(written.value.inserted).toBe(20_000);
    expect(written.value.skipped).toBe(0);
    expect(written.value.events.at(0)?.ingestSeq).toBe(1);
    expect(written.value.events.at(-1)?.ingestSeq).toBe(20_000);
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(20_000);

    // One transaction, one prepared statement: the measured cost on an idle
    // host is a few hundred milliseconds. The bound is deliberately loose
    // because this suite shares a machine with many others, and what it is
    // guarding is the order of magnitude — a per-row transaction would fsync
    // twenty thousand times and take minutes.
    expect(elapsed).toBeLessThan(15_000);
  });

  it('answers the default page and a trace read from an index, never a table scan', () => {
    insertOk([buildEvent(), buildEvent({ traceId: TRACE_B })]);

    // The statement texts mirror what the read path assembles, including the
    // exported ordering constant, so a change to either shape fails here.
    const defaultPage = queryPlan(
      `SELECT ingest_seq, event FROM telemetry_events
       WHERE session_id = ? AND capture_id = ?
       ORDER BY ${CANONICAL_ORDER_BY} LIMIT ? OFFSET ?`,
    );
    const byTrace = queryPlan(
      `SELECT ingest_seq, event FROM telemetry_events
       WHERE session_id = ? AND trace_id = ?
       ORDER BY ${CANONICAL_ORDER_BY} LIMIT ? OFFSET ?`,
    );
    const count = queryPlan(
      'SELECT COUNT(*) AS total FROM telemetry_events WHERE session_id = ? AND capture_id = ?',
    );

    expect(defaultPage[0]).toContain('idx_telemetry_events_session_id_capture_id_start_time');
    expect(byTrace[0]).toContain('idx_telemetry_events_trace_id_start_time');
    expect(count[0]).toContain('idx_telemetry_events_session_id_capture_id_start_time');

    for (const plan of [defaultPage, byTrace, count]) {
      expect(plan[0]).toContain('SEARCH');
      expect(plan.join(' ')).not.toContain('SCAN telemetry_events');
    }
  });
});
