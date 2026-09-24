/**
 * Tests for `./telemetry-repo.ts`: the table every piece of evidence this
 * product reasons about passes through.
 *
 * What is on trial here is not a repository's CRUD. Five properties are, and
 * each block below exists because breaking one of them turns a debugging
 * session's answer into a plausible fiction:
 *
 * 1. **The order is total, and it is the one each reader is owed.** A
 *    convenience reader — `listByTrace` above all, which the correlator pages
 *    through — must return rows in `start_time`, then `(producer_id, seq)`,
 *    then `ingest_seq` order, and identical timestamps across two producers are
 *    the ordinary case, not the exotic one, because a page document and a
 *    dev-server process read the same millisecond. The suite pins that SQL
 *    order against `compareEventsCanonical`, the in-memory twin, rather than
 *    against a hand-written expectation. `query`, the panel-data surface, owes
 *    the order AAP 0.4.2 specifies instead — the sort's key, then the event
 *    `id` — and the suite pins it with ids chosen so that id order and
 *    canonical order disagree on every tie.
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
 * a purge, and a bulk insert committing inside one transaction. The parent
 * session and capture rows are written through `./sessions-repo.ts`, as the
 * service writes them, and every fixture event is validated by the telemetry
 * package's own `parseTelemetryEvent` before a test sees it. Nothing under
 * `$DEBUGGEN_HOME` is touched, no environment variable is read and no socket
 * is opened, which is the contract of the `local-service` Vitest project.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_SORTS,
  dataQueryFilterSchema,
  parseDataQuery,
} from '@debuggen/panel-schema';
import type { DataQueryFilter } from '@debuggen/panel-schema';
import type { SessionRecord } from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
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
import type { DebuggenError, LogRecord, Result } from '@debuggen/shared';
import {
  FETCH_ATTRIBUTE_KEYS,
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
  TELEMETRY_KINDS,
  TELEMETRY_TIERS,
  allowedTiersFor,
  compareEventsCanonical,
  parseTelemetryEvent,
} from '@debuggen/telemetry';
import type {
  TelemetryEvent,
  TelemetryKind,
  TelemetryStatus,
  TelemetryTier,
} from '@debuggen/telemetry';

import { openStore } from './db.js';
import type { Store } from './db.js';
import { STORE_SCHEMA_VERSION } from './migrations.js';
import { createSessionsRepo } from './sessions-repo.js';
import type { SessionsRepo } from './sessions-repo.js';
import {
  CANONICAL_ORDER_BY,
  DEFAULT_PURGE_BATCH_SIZE,
  DELETE_OLDER_THAN_BATCH_SQL,
  DELETE_SESSION_BATCH_SQL,
  DELETE_SESSION_OLDER_THAN_BATCH_SQL,
  DURATION_DESC_ORDER_BY,
  EXISTENCE_LOOKUP_CHUNK_SIZE,
  MAX_PURGE_BATCH_SIZE,
  PANEL_DURATION_DESC_ORDER_BY,
  PANEL_SECONDARY_ORDER_BY,
  PANEL_START_ASC_ORDER_BY,
  TELEMETRY_DEFAULT_GROUP_KEY,
  TELEMETRY_GROUP_KEYS,
  TELEMETRY_QUERY_DEFAULT_LIMIT,
  TELEMETRY_QUERY_MAX_LIMIT,
  TELEMETRY_SORTS,
  createTelemetryRepo,
  isTelemetryGroupKey,
} from './telemetry-repo.js';
import type {
  PersistableTelemetryEvent,
  TelemetryGroupPage,
  TelemetryPage,
  TelemetryQuery,
  TelemetryRepo,
} from './telemetry-repo.js';

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

/**
 * The attribute key the service writes the request grouping hash under, read
 * from `@debuggen/telemetry`'s own catalogs rather than typed here: the one key
 * that is both a request (`fetch`) attribute and service-assigned.
 *
 * Deriving it is what makes a rename upstream fail this suite loudly instead of
 * leaving every fixture writing a key the repository no longer denormalises —
 * which would pass every assertion that only checks for `NULL`.
 */
const REQUEST_KEY_ATTRIBUTE: string = ((): string => {
  const requestAttributes: readonly string[] = FETCH_ATTRIBUTE_KEYS;
  const assigned = SERVICE_ASSIGNED_ATTRIBUTE_KEYS.find((candidate) =>
    requestAttributes.includes(candidate),
  );

  if (assigned === undefined) {
    throw new Error('@debuggen/telemetry no longer declares a service-assigned request attribute');
  }

  return assigned;
})();

/** A request grouping key of the shape the ingest path computes: 64 lowercase hex characters. */
function requestKeyOf(seed: string): string {
  return seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64);
}

/**
 * A new session's record, minimal and valid: every container empty, cleanup
 * pending, the deterministic provider — exactly what the session manager
 * persists before the first stage runs.
 */
function sessionRecord(sessionId: string): SessionRecord {
  return {
    id: sessionId,
    projectRoot: '/home/dev/projects/example',
    projectName: 'example',
    devServerUrl: 'http://127.0.0.1:20231',
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

/**
 * Seeds the parent rows every telemetry foreign key requires, through the
 * sessions repository rather than hand-written SQL, so the rows this suite
 * writes against are the rows the service itself would have written.
 *
 * `CAPTURE_A1` is closed before `CAPTURE_A2` opens because the store refuses a
 * second open capture per session (AAP 0.4.2); telemetry attribution does not
 * care whether a capture is still open, so both remain valid targets.
 */
function seedParents(sessions: SessionsRepo): void {
  unwrap(sessions.insert(sessionRecord(SESSION_A)));
  unwrap(sessions.insert(sessionRecord(SESSION_B)));
  unwrap(
    sessions.startCapture({
      sessionId: SESSION_A,
      planVersion: 1,
      captureId: CAPTURE_A1,
      startedAt: BASE_TIME,
    }),
  );
  unwrap(sessions.stopCapture({ captureId: CAPTURE_A1, stoppedAt: BASE_TIME }));
  unwrap(
    sessions.startCapture({
      sessionId: SESSION_A,
      planVersion: 1,
      captureId: CAPTURE_A2,
      startedAt: BASE_TIME,
    }),
  );
  unwrap(
    sessions.startCapture({
      sessionId: SESSION_B,
      planVersion: 1,
      captureId: CAPTURE_B1,
      startedAt: BASE_TIME,
    }),
  );
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
 * The arrival number {@link buildEvent} validates a candidate with. Any positive
 * integer does: the schema bounds the field's shape, and the store assigns the
 * real value. The probe is discarded after validation.
 */
const VALIDATION_INGEST_SEQ = 1;

/**
 * Builds a storable event and proves it is one.
 *
 * Every event is validated through `@debuggen/telemetry`'s own
 * `parseTelemetryEvent` — the persisted schema, strict and with no coercion —
 * so a drifting schema fails loudly here, at the fixture, rather than as a
 * puzzling refusal inside whichever test first meets the drift. A test that
 * needs an event the schema refuses builds it with {@link draftEvent} instead,
 * which makes the intent visible at the call site.
 */
function buildEvent(overrides: EventOverrides = {}): PersistableTelemetryEvent {
  const draft = draftEvent(overrides);
  const parsed = parseTelemetryEvent({ ...draft, ingestSeq: VALIDATION_INGEST_SEQ });

  if (isErr(parsed)) {
    throw new Error(`the fixture builder produced an invalid event: ${parsed.error.message}`);
  }

  return draft;
}

/**
 * Builds a candidate event **without** validating it.
 *
 * The tier defaults to the first one the kind is *allowed* in, read from the
 * telemetry package's own rule, so a candidate is only invalid in the way its
 * overrides make it. Reserved for the refusal paths; everything else goes
 * through {@link buildEvent}.
 */
function draftEvent(overrides: EventOverrides = {}): PersistableTelemetryEvent {
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

/**
 * The {@link TelemetryQuery} fields a panel's `DataQueryFilter` lands on when
 * `../panels/data.ts` spreads it onto a query.
 *
 * `Pick` is the compile-time half of the seam proof: it fails the typecheck
 * gate the moment the panel schema carries a filter key the repository does
 * not declare — the drift that let a singular `tier` be spread onto a query
 * that ignored it. A spread alone proves nothing, because properties arriving
 * through a spread are never checked as excess.
 */
type ForwardedFilter = Pick<TelemetryQuery, keyof DataQueryFilter>;

/**
 * Forwards a parsed panel filter unchanged, as the panel-data resolver does.
 *
 * The declared return type is the other half of the proof: every shared key's
 * type must stay assignable under `exactOptionalPropertyTypes`, or this line
 * stops compiling.
 *
 * @param filter The filter of a parsed `DataQuery`, absent when it named none.
 * @returns The same filter, typed as the query fields it narrows.
 */
function forwardFilter(filter: DataQueryFilter | undefined): ForwardedFilter {
  return filter ?? {};
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

  // The sessions repository keeps the default no-op logger: the log assertions
  // below are about what the telemetry repository and the store say.
  seedParents(createSessionsRepo({ store, now: () => BASE_TIME }));
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
      'queryGroups',
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
    // The DDL of the table the live store actually created — after every
    // migration ran — rather than the file it was created from: a migration
    // that rebuilt the table without the constraint would pass a check of the
    // file and still accept any tier.
    const ddl = store
      .statement(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get('telemetry_events')?.['sql'];

    expect(typeof ddl).toBe('string');

    const match = /CHECK\s*\(\s*tier\s+IN\s*\(([^)]*)\)\s*\)/i.exec(String(ddl));

    expect(match).not.toBeNull();

    const listed = (match?.[1] ?? '')
      .split(',')
      .map((value) => value.trim().replace(/^'/, '').replace(/'$/, ''));

    expect(listed).toEqual([...TELEMETRY_TIERS]);
  });

  it('has the database itself refuse a tier outside the vocabulary', () => {
    // Past the repository's validation on purpose: the constraint is the last
    // line of defence for a row written by any other path.
    expect(() =>
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
          'edge',
          'operation',
          BASE_TIME,
          1,
          PRODUCER_BROWSER,
          0,
          '{}',
        ),
    ).toThrow(/CHECK constraint failed/);

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(0);
  });

  it('defines the canonical order once, and ends every convenience-reader ordering with it', () => {
    expect(CANONICAL_ORDER_BY).toBe('start_time ASC, producer_id ASC, seq ASC, ingest_seq ASC');
    expect(DURATION_DESC_ORDER_BY).toBe(`duration DESC, ${CANONICAL_ORDER_BY}`);
  });

  it('ends every panel-data ordering in the event id, and never in an arrival number', () => {
    // AAP 0.4.2: `sort` orders with a stable secondary key (`id`) per source.
    expect(PANEL_SECONDARY_ORDER_BY).toBe('id ASC');
    expect(PANEL_START_ASC_ORDER_BY).toBe(`start_time ASC, ${PANEL_SECONDARY_ORDER_BY}`);
    expect(PANEL_DURATION_DESC_ORDER_BY).toBe(`duration DESC, ${PANEL_SECONDARY_ORDER_BY}`);

    for (const ordering of [PANEL_START_ASC_ORDER_BY, PANEL_DURATION_DESC_ORDER_BY]) {
      expect(ordering.endsWith(PANEL_SECONDARY_ORDER_BY)).toBe(true);
      expect(ordering).not.toContain('ingest_seq');
      expect(ordering).not.toContain('producer_id');
    }
  });

  it('accepts exactly the panel-data sort vocabulary, and a closed set of group keys', () => {
    // The whole vocabulary, not a subset of it: a panel node's `sort` is
    // forwarded unchanged, so a member missing here would be a panel that
    // validates and then fails to load.
    expect(TELEMETRY_SORTS).toBe(DATA_QUERY_SORTS);
    expect([...TELEMETRY_SORTS].sort()).toEqual(['count_desc', 'duration_desc', 'start_asc']);
    expect([...TELEMETRY_GROUP_KEYS]).toEqual([
      'name',
      'kind',
      'traceId',
      'requestKey',
      'component',
    ]);
    expect(TELEMETRY_DEFAULT_GROUP_KEY).toBe('name');
    expect(TELEMETRY_GROUP_KEYS.every((key) => isTelemetryGroupKey(key))).toBe(true);
    expect(isTelemetryGroupKey('constructor')).toBe(false);
    expect(isTelemetryGroupKey('trace_id')).toBe(false);
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

  it('answers an exact replay of a stored batch by writing nothing and keeping every number', () => {
    // The reconnecting agent's case (AAP 0.5.5): the whole buffer arrives a
    // second time, unchanged.
    const batch = Array.from({ length: 5 }, (_unused, index) =>
      buildEvent({ startTime: BASE_TIME + index }),
    );
    const first = repo.insertMany(batch);

    expect(isErr(first)).toBe(false);

    if (isErr(first)) {
      return;
    }

    expect(first.value.inserted).toBe(batch.length);
    expect(first.value.skipped).toBe(0);

    const numbers = first.value.events.map((event) => event.ingestSeq);

    // Strictly increasing in the order the batch was offered.
    expect(numbers.every((value, index) => index === 0 || value > (numbers[index - 1] ?? 0))).toBe(
      true,
    );

    const replay = repo.insertMany(batch);

    expect(isErr(replay)).toBe(false);

    if (isErr(replay)) {
      return;
    }

    expect(replay.value.inserted).toBe(0);
    expect(replay.value.skipped).toBe(batch.length);
    expect(replay.value.events.map((event) => event.id)).toEqual(batch.map((event) => event.id));
    expect(replay.value.events.map((event) => event.ingestSeq)).toEqual(numbers);
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(batch.length);
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

  it('never reuses an arrival number after a purge', async () => {
    insertOk([buildEvent(), buildEvent(), buildEvent()]);

    expect(unwrap(await repo.deleteBySession(SESSION_A))).toBe(3);

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
    const requestKey = requestKeyOf('a1');
    const [stored] = insertOk([
      buildEvent({ attributes: { [REQUEST_KEY_ATTRIBUTE]: requestKey, 'http.method': 'GET' } }),
    ]);

    // Mirrored, never recomputed: the key is a hash of the unredacted URL that
    // no stored row still holds, so the column can only be a copy.
    expect(readRow(stored?.id ?? '')?.['request_key']).toBe(requestKey);
    expect(stored?.attributes[REQUEST_KEY_ATTRIBUTE]).toBe(requestKey);
  });

  it('keeps every flat column equal to the document it was projected from', () => {
    const parent = newSpanId();
    const requestKey = requestKeyOf('7e');
    const [stored] = insertOk([
      buildEvent({
        kind: 'fetch',
        name: 'alpha-endpoint',
        parentSpanId: parent,
        producerId: PRODUCER_BROWSER,
        seq: 41,
        startTime: BASE_TIME + 3.25,
        duration: 17.5,
        attributes: { [REQUEST_KEY_ATTRIBUTE]: requestKey, 'http.method': 'POST' },
      }),
    ]);

    // Raw SQL is justified here and nowhere else in the suite: what is on trial
    // is the projection itself, which no repository read exposes.
    const row = store
      .statement(
        `SELECT kind, tier, trace_id, span_id, parent_span_id, producer_id, seq, request_key,
                start_time, duration, event
           FROM telemetry_events WHERE id = ?`,
      )
      .get(stored?.id ?? '');
    const document = JSON.parse(String(row?.['event'])) as Record<string, unknown>;
    const attributes = document['attributes'] as Record<string, unknown>;

    expect(row?.['kind']).toBe(document['kind']);
    expect(row?.['tier']).toBe(document['tier']);
    expect(row?.['trace_id']).toBe(document['traceId']);
    expect(row?.['span_id']).toBe(document['spanId']);
    expect(row?.['parent_span_id']).toBe(document['parentSpanId']);
    expect(row?.['producer_id']).toBe(document['producerId']);
    expect(row?.['seq']).toBe(document['seq']);
    expect(row?.['request_key']).toBe(attributes[REQUEST_KEY_ATTRIBUTE]);
    expect(row?.['start_time']).toBe(document['startTime']);
    expect(row?.['duration']).toBe(document['duration']);

    // And the document is the event that was offered, field for field.
    expect(document['parentSpanId']).toBe(parent);
    expect(document['seq']).toBe(41);
  });

  it.each(['sessionId', 'captureId'] as const)(
    'refuses a batch whose element is missing its %s, and writes nothing',
    (field) => {
      const valid = buildEvent();

      // The attribution the service assigns, absent — which is what an event
      // that reached the store without passing through attribution looks like.
      const unattributed: Record<string, unknown> = { ...buildEvent() };

      delete unattributed[field];

      const written = repo.insertMany([
        valid,
        unattributed as unknown as PersistableTelemetryEvent,
      ]);

      expect(isErr(written)).toBe(true);

      if (!isErr(written)) {
        return;
      }

      expect(written.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(written.error.message).toContain(field);
      expect(written.error.details?.['index']).toBe(1);
      expect(written.error.details?.['batchSize']).toBe(2);

      // Refused before the transaction opened, so the valid element is not
      // stored either: a batch is all or nothing.
      expect(unwrap(repo.countBySession(SESSION_A))).toBe(0);
    },
  );

  it('rolls a mixed batch back whole when one element names an unknown capture', () => {
    const earlier = insertOk([buildEvent()]);
    const written = repo.insertMany([
      buildEvent({ startTime: BASE_TIME + 1 }),
      buildEvent({ startTime: BASE_TIME + 2 }),
      buildEvent({ captureId: newCaptureId(), startTime: BASE_TIME + 3 }),
    ]);

    expect(isErr(written)).toBe(true);

    if (isErr(written)) {
      expect(written.error.code).toBe('STORE_ERROR');
      expect(written.error.details?.['reason']).toBe('unknown-attribution');
    }

    // The two valid elements were written inside the batch transaction and
    // rolled back with it; the earlier batch is untouched.
    const page = unwrap(repo.query({ sessionId: SESSION_A }));

    expect(page.total).toBe(1);
    expect(page.rows.map((event) => event.id)).toEqual(earlier.map((event) => event.id));
  });

  it('refuses an event whose kind and tier disagree', () => {
    const written = repo.insertMany([draftEvent({ kind: 'render', tier: 'db' })]);

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

  it.each<readonly [string, string, string, string, string]>([
    ['session A naming a capture of session B', SESSION_A, CAPTURE_A1, CAPTURE_B1, SESSION_B],
    ['session B naming a capture of session A', SESSION_B, CAPTURE_B1, CAPTURE_A1, SESSION_A],
  ])(
    'refuses an event of %s, and rolls the whole batch back',
    (_direction, sessionId, ownCapture, foreignCapture, owningSession) => {
      // Stored by an earlier, correctly attributed batch: the refusal below must
      // leave it exactly as it is.
      const earlier = buildEvent({ sessionId, captureId: ownCapture });

      insertOk([earlier]);

      const earlierDocument = readRow(earlier.id)?.['event'];

      // The valid element comes first, so it is written inside the batch
      // transaction before the misattributed one is reached: the rollback is
      // observable rather than assumed.
      const valid = buildEvent({ sessionId, captureId: ownCapture });
      const misattributed = buildEvent({
        sessionId,
        captureId: foreignCapture,
        attributes: { note: SENTINEL },
      });
      const written = repo.insertMany([valid, misattributed]);

      expect(isErr(written)).toBe(true);

      if (!isErr(written)) {
        return;
      }

      expect(written.error.code).toBe('STORE_ERROR');
      expect(written.error.details?.['reason']).toBe('capture-session-mismatch');
      expect(written.error.details?.['index']).toBe(1);
      expect(written.error.details?.['batchSize']).toBe(2);
      expect(written.error.details?.['sessionId']).toBe(sessionId);
      expect(written.error.details?.['captureId']).toBe(foreignCapture);
      expect(written.error.hint).toBeDefined();

      // The event's own identifiers only: the session that owns the capture is
      // not disclosed, and no captured value is echoed.
      expect(errorText(written.error)).not.toContain(owningSession);
      expect(errorText(written.error)).not.toContain(SENTINEL);
      expect(loggedText()).not.toContain(owningSession);
      expect(loggedText()).not.toContain(SENTINEL);

      // Nothing of the batch survived, and the earlier batch is untouched.
      expect(readRow(valid.id)).toBeUndefined();
      expect(readRow(misattributed.id)).toBeUndefined();
      expect(unwrap(repo.countBySession(sessionId))).toBe(1);
      expect(unwrap(repo.countBySession(owningSession))).toBe(0);
      expect(readRow(earlier.id)?.['event']).toBe(earlierDocument);
    },
  );

  it('keeps a session\u2019s events when another session\u2019s capture is deleted after a refused misattribution', () => {
    const own = buildEvent();

    insertOk([own]);

    const refused = repo.insertMany([buildEvent({ captureId: CAPTURE_B1 })]);

    expect(isErr(refused)).toBe(true);

    if (isErr(refused)) {
      expect(refused.error.details?.['reason']).toBe('capture-session-mismatch');
    }

    // The cascade the ownership check exists for: had the misattributed row
    // been stored, deleting session B's capture would have taken an event of
    // session A with it.
    store.statement('DELETE FROM captures WHERE id = ?').run(CAPTURE_B1);

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(1);
    expect(unwrap(repo.query({ sessionId: SESSION_A })).rows.map((event) => event.id)).toEqual([
      own.id,
    ]);
    expect(readRow(own.id)?.['capture_id']).toBe(CAPTURE_A1);
  });

  it('accepts a batch spanning sessions when every capture is its own session\u2019s, and replays it', () => {
    // Several captures in one batch, interleaved: the per-batch owner memo must
    // answer for each capture separately rather than for the first it read.
    const batch = [
      buildEvent(),
      buildEvent({ sessionId: SESSION_B, captureId: CAPTURE_B1 }),
      buildEvent({ captureId: CAPTURE_A2 }),
      buildEvent({ sessionId: SESSION_B, captureId: CAPTURE_B1 }),
      buildEvent(),
    ];

    const first = unwrap(repo.insertMany(batch));

    expect(first.inserted).toBe(5);
    expect(first.skipped).toBe(0);

    // A clean replay of the same, correctly attributed batch is still skipped
    // row for row, with the arrival numbers the store already holds.
    const replay = unwrap(repo.insertMany(batch));

    expect(replay.inserted).toBe(0);
    expect(replay.skipped).toBe(5);
    expect(replay.events.map((event) => event.ingestSeq)).toEqual(
      first.events.map((event) => event.ingestSeq),
    );
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(3);
    expect(unwrap(repo.countBySession(SESSION_B))).toBe(2);
  });

  it('answers an exact replay with the stored event, not the candidate', () => {
    const event = buildEvent({
      startTime: BASE_TIME + 0.125,
      duration: 3.375,
      attributes: { 'http.method': 'GET', note: SENTINEL },
    });
    const [first] = insertOk([event]);
    const replay = unwrap(repo.insertMany([event]));

    expect(replay.inserted).toBe(0);
    expect(replay.skipped).toBe(1);

    // The persisted row, reconstructed with its own arrival number: exactly
    // what a read returns for it.
    const [returned] = replay.events;
    const [read] = unwrap(repo.query({ sessionId: SESSION_A })).rows;

    expect(returned).toEqual(first);
    expect(returned).toEqual(read);
    expect(returned?.ingestSeq).toBe(1);
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(1);
  });

  it('treats a replay differing only in key order or in an undefined optional field as exact', () => {
    const event = buildEvent({
      attributes: { alpha: 1, nested: { first: 'a', second: [1, 2.5] }, omega: true },
    });

    insertOk([event]);

    // Every key reversed, at the top level and inside the attribute bag, plus
    // two optional fields present as `undefined` where the stored copy has
    // none: the stored JSON document cannot tell any of that apart.
    const reordered = {
      ...Object.fromEntries(Object.entries(event).reverse()),
      attributes: { omega: true, nested: { second: [1, 2.5], first: 'a' }, alpha: 1 },
      parentSpanId: undefined,
      redacted: undefined,
    } as unknown as PersistableTelemetryEvent;

    const replay = repo.insertMany([reordered]);

    expect(isErr(replay)).toBe(false);

    if (isErr(replay)) {
      return;
    }

    expect(replay.value.skipped).toBe(1);
    expect(replay.value.inserted).toBe(0);
    expect(replay.value.events[0]).toEqual({ ...event, ingestSeq: 1 });
  });

  it.each<readonly [string, (event: PersistableTelemetryEvent) => PersistableTelemetryEvent]>([
    ['captureId', (event) => ({ ...event, captureId: CAPTURE_A2 })],
    ['traceId', (event) => ({ ...event, traceId: TRACE_B })],
    // A different double, not a different millisecond: the comparison is
    // exact, so a sub-millisecond drift is a different event.
    ['startTime', (event) => ({ ...event, startTime: event.startTime + 0.001 })],
    ['duration', (event) => ({ ...event, duration: event.duration + 0.5 })],
    [
      'attributes',
      (event) => ({ ...event, attributes: { ...event.attributes, note: `${SENTINEL}-changed` } }),
    ],
    [
      'source',
      (event) => ({
        ...event,
        source: {
          file: 'src/server/report.ts',
          line: 12,
          column: 3,
          resolvedBy: 'patch',
          confidence: 1,
        },
      }),
    ],
  ])(
    'refuses a same-session replay that differs in %s, and rolls the whole batch back',
    (field, mutate) => {
      const original = buildEvent({ attributes: { note: SENTINEL } });

      insertOk([original]);

      const storedDocument = readRow(original.id)?.['event'];
      const before = unwrap(repo.countBySession(SESSION_A));

      // Two new events ahead of the conflicting one, so the rollback is
      // observable: they are written first, inside the batch transaction.
      const written = repo.insertMany([buildEvent(), buildEvent(), mutate(original)]);

      expect(isErr(written)).toBe(true);

      if (!isErr(written)) {
        return;
      }

      expect(written.error.code).toBe('STORE_ERROR');
      expect(written.error.details?.['reason']).toBe('event-id-conflict');
      expect(written.error.details?.['eventId']).toBe(original.id);
      expect(written.error.details?.['fields']).toEqual([field]);
      expect(written.error.message).toContain(field);

      // Nothing of the batch survived, and the stored row is untouched.
      expect(unwrap(repo.countBySession(SESSION_A))).toBe(before);
      expect(readRow(original.id)?.['event']).toBe(storedDocument);

      // Field names only: neither side's captured values reach the error or
      // any log record.
      expect(errorText(written.error)).not.toContain(SENTINEL);
      expect(loggedText()).not.toContain(SENTINEL);
    },
  );

  it('names every differing field, sorted', () => {
    const original = buildEvent();

    insertOk([original]);

    const written = repo.insertMany([
      { ...original, startTime: original.startTime + 1, attributes: { changed: 1 } },
    ]);

    expect(isErr(written)).toBe(true);

    if (isErr(written)) {
      expect(written.error.details?.['fields']).toEqual(['attributes', 'startTime']);
    }
  });

  it('refuses two differing copies of one id inside the same batch', () => {
    const event = buildEvent({ attributes: { note: SENTINEL } });
    const written = repo.insertMany([
      buildEvent(),
      event,
      { ...event, duration: event.duration + 1 },
    ]);

    expect(isErr(written)).toBe(true);

    if (isErr(written)) {
      expect(written.error.details?.['reason']).toBe('event-id-conflict');
      expect(written.error.details?.['fields']).toEqual(['duration']);
      expect(errorText(written.error)).not.toContain(SENTINEL);
    }

    // The first copy was written inside the batch transaction and rolled back
    // with everything else.
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(0);
  });

  it('refuses a replay whose stored row no longer reconstructs, and rolls the batch back', () => {
    const event = buildEvent();

    // The id is held by a row written by another build: valid flat columns, a
    // document this build cannot read, and a captured value inside it.
    store
      .statement(
        `INSERT INTO telemetry_events (
           id, session_id, capture_id, trace_id, span_id, kind, tier,
           name, start_time, duration, producer_id, seq, event
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        SESSION_A,
        CAPTURE_A1,
        TRACE_A,
        event.spanId,
        'fetch',
        'browser',
        'operation',
        BASE_TIME,
        1,
        PRODUCER_BROWSER,
        0,
        JSON.stringify({ unexpected: SENTINEL }),
      );

    const written = repo.insertMany([buildEvent(), event]);

    expect(isErr(written)).toBe(true);

    if (isErr(written)) {
      expect(written.error.code).toBe('STORE_ERROR');
      expect(written.error.details?.['reason']).toBe('stored-event-unreadable');
      expect(written.error.details?.['eventId']).toBe(event.id);
      expect(written.error.details?.['ingestSeq']).toBe(1);
      expect(errorText(written.error)).not.toContain(SENTINEL);
    }

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(1);
    expect(loggedText()).not.toContain(SENTINEL);
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
 * The canonical order of the convenience readers
 * ---------------------------------------------------------------------------------------------- */

/*
 * What this block asserts is the **total row order** only: `start_time`, then
 * `(producer_id, seq)`, then `ingest_seq`, as `CANONICAL_ORDER_BY` spells it.
 * The first key of the full canonical order, parent before child, is a property
 * of the trace *tree* and is the correlator's responsibility
 * (`packages/telemetry/src/correlation/correlator.ts` nests by
 * `(traceId, parentSpanId)` and walks depth-first); a repository ordering rows
 * by it would duplicate that logic in SQL and get it wrong whenever a server
 * clock reads earlier than the browser span that caused it.
 */
describe('the canonical order of the convenience readers', () => {
  it('orders a producer’s interleaved sequence numbers by seq, not by arrival', () => {
    // One producer, one millisecond, the counter offered out of order: only
    // `seq` can decide, and it must beat the arrival number.
    const third = buildEvent({ producerId: PRODUCER_BROWSER, seq: 3 });
    const first = buildEvent({ producerId: PRODUCER_BROWSER, seq: 1 });
    const fourth = buildEvent({ producerId: PRODUCER_BROWSER, seq: 4 });
    const second = buildEvent({ producerId: PRODUCER_BROWSER, seq: 2 });

    const stored = insertOk([third, first, fourth, second]);

    // Arrival order is the offered order…
    expect(stored.map((event) => event.seq)).toEqual([3, 1, 4, 2]);

    // …and the canonical readers ignore it wherever `seq` differs.
    const expected = [first.id, second.id, third.id, fourth.id];

    expect(unwrap(repo.listByTrace(SESSION_A, TRACE_A)).rows.map((event) => event.id)).toEqual(
      expected,
    );
    expect(unwrap(repo.listByCapture(SESSION_A, CAPTURE_A1)).rows.map((event) => event.id)).toEqual(
      expected,
    );
  });

  it('returns the identical sequence on every repetition of the same read', () => {
    const events = [
      buildEvent({ producerId: PRODUCER_SERVER, kind: 'http.server' }),
      buildEvent({ producerId: PRODUCER_BROWSER }),
      buildEvent({ producerId: PRODUCER_SERVER, kind: 'http.server' }),
      buildEvent({ producerId: PRODUCER_BROWSER }),
      buildEvent({ producerId: PRODUCER_BROWSER, startTime: BASE_TIME - 1 }),
    ];

    insertOk(events);

    const reads = Array.from({ length: 3 }, () =>
      unwrap(repo.listByTrace(SESSION_A, TRACE_A)).rows.map((event) => event.id),
    );

    expect(reads[1]).toEqual(reads[0]);
    expect(reads[2]).toEqual(reads[0]);
    expect(new Set(reads[0]).size).toBe(events.length);
  });

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
    const canonical = [...stored].sort(compareEventsCanonical).map((event) => event.id);

    // The read the correlator pages through, and the capture-wide reader: both
    // follow the in-memory twin key for key.
    const page = unwrap(repo.listByTrace(SESSION_A, TRACE_A, { sort: 'start_asc' }));

    expect(page.rows.map((event) => event.id)).toEqual(canonical);
    expect(unwrap(repo.listByCapture(SESSION_A, CAPTURE_A1)).rows.map((event) => event.id)).toEqual(
      canonical,
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

    for (const page of [
      unwrap(repo.listByTrace(SESSION_A, TRACE_A)),
      unwrap(repo.listByCapture(SESSION_A, CAPTURE_A1)),
    ]) {
      expect(page.rows.map((event) => event.id)).toEqual([first.id, second.id]);
      expect(page.rows.map((event) => event.ingestSeq)).toEqual([1, 2]);
    }
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

    const stored = insertOk(events);
    const whole = unwrap(repo.listByCapture(SESSION_A, CAPTURE_A1, { sort: 'duration_desc' }));
    const walked: string[] = [];

    // Pages of three: the boundary falls between the three equal durations, so
    // a tie-break that was not total would repeat or drop a row right there.
    for (let offset = 0; offset < whole.total; offset += 3) {
      const page = unwrap(
        repo.listByCapture(SESSION_A, CAPTURE_A1, { sort: 'duration_desc', limit: 3, offset }),
      );

      walked.push(...page.rows.map((event) => event.id));
    }

    // Every row exactly once, in the same order the single-page read gave: the
    // canonical chain behind `duration DESC` is what makes that true, and it is
    // what decides among equal durations.
    expect(walked).toEqual(whole.rows.map((event) => event.id));
    expect(new Set(walked).size).toBe(events.length);
    expect(whole.rows.map((event) => event.duration)).toEqual([9, 5, 5, 5, 1, 1]);
    expect(whole.rows.filter((event) => event.duration === 5).map((event) => event.id)).toEqual(
      stored
        .filter((event) => event.duration === 5)
        .sort(compareEventsCanonical)
        .map((event) => event.id),
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * The panel-data orderings
 * ---------------------------------------------------------------------------------------------- */

describe('the panel-data orderings of query', () => {
  /**
   * An event id whose first character after the prefix is `rank`, so the
   * suite decides where it sorts.
   *
   * The rest is a fresh id's own random tail, cut so the result keeps the
   * shape `newEventId` produces: `evt_` plus sixteen characters of `[0-9a-z]`.
   */
  function rankedEventId(rank: string): string {
    const prefix = 'evt_';

    return `${prefix}${rank}${newEventId().slice(prefix.length + rank.length)}`;
  }

  /** The ids of a page, in page order. */
  function idsOf(page: TelemetryPage): string[] {
    return page.rows.map((event) => event.id);
  }

  it('builds ranked ids in the shape newEventId produces', () => {
    const pattern = /^evt_[0-9a-z]{16}$/;

    expect(newEventId()).toMatch(pattern);
    expect(rankedEventId('a')).toMatch(pattern);
    expect(rankedEventId('a').startsWith('evt_a')).toBe(true);
  });

  it('breaks a start_asc tie on the event id, not on the canonical chain', () => {
    // One producer, one timestamp, four sequence numbers: the canonical chain
    // orders them by `seq`, and their ids are ranked the opposite way, so id
    // order and canonical order disagree on every pair. Offered shuffled, so
    // arrival order matches neither.
    const d = buildEvent({ id: rankedEventId('d'), seq: 0 });
    const c = buildEvent({ id: rankedEventId('c'), seq: 1 });
    const b = buildEvent({ id: rankedEventId('b'), seq: 2 });
    const a = buildEvent({ id: rankedEventId('a'), seq: 3 });
    // Earlier than every tied row but with the largest id: the start time is
    // still the primary key.
    const earliest = buildEvent({ id: rankedEventId('z'), startTime: BASE_TIME - 1, seq: 4 });

    const stored = insertOk([b, earliest, d, a, c]);
    const panel = unwrap(repo.query({ sessionId: SESSION_A, sort: 'start_asc' }));

    expect(idsOf(panel)).toEqual([earliest.id, a.id, b.id, c.id, d.id]);
    expect(idsOf(unwrap(repo.query({ sessionId: SESSION_A })))).toEqual(idsOf(panel));

    // The canonical readers keep the correlator's order for the same rows.
    const canonical = [...stored].sort(compareEventsCanonical).map((event) => event.id);

    expect(canonical).toEqual([earliest.id, d.id, c.id, b.id, a.id]);
    expect(idsOf(unwrap(repo.listByCapture(SESSION_A, CAPTURE_A1)))).toEqual(canonical);
    expect(idsOf(panel)).not.toEqual(canonical);

    // A two-row walk visits every row once, in the single-page order.
    const walked: string[] = [];
    let offset: number | undefined = 0;

    while (offset !== undefined) {
      const page: TelemetryPage = unwrap(repo.query({ sessionId: SESSION_A, limit: 2, offset }));

      walked.push(...idsOf(page));
      offset = page.nextOffset;
    }

    expect(walked).toEqual(idsOf(panel));
  });

  it('breaks a duration_desc tie on the event id, and pages every row once', () => {
    // One timestamp and one producer throughout, so among equal durations the
    // canonical chain decides by `seq` — and the ids are ranked against it.
    const slowest = buildEvent({ id: rankedEventId('m'), duration: 9, seq: 0 });
    const fiveC = buildEvent({ id: rankedEventId('c'), duration: 5, seq: 1 });
    const fiveB = buildEvent({ id: rankedEventId('b'), duration: 5, seq: 2 });
    const fiveA = buildEvent({ id: rankedEventId('a'), duration: 5, seq: 3 });
    const oneY = buildEvent({ id: rankedEventId('y'), duration: 1, seq: 4 });
    const oneX = buildEvent({ id: rankedEventId('x'), duration: 1, seq: 5 });
    const events = [oneY, fiveB, slowest, oneX, fiveA, fiveC];

    const stored = insertOk(events);
    const whole = unwrap(repo.query({ sessionId: SESSION_A, sort: 'duration_desc' }));

    expect(whole.rows.map((event) => event.duration)).toEqual([9, 5, 5, 5, 1, 1]);
    expect(idsOf(whole)).toEqual([slowest.id, fiveA.id, fiveB.id, fiveC.id, oneX.id, oneY.id]);

    // The canonical reader breaks the same ties on `seq`: the opposite order.
    const canonical = unwrap(repo.listByCapture(SESSION_A, CAPTURE_A1, { sort: 'duration_desc' }));

    expect(canonical.rows.filter((event) => event.duration === 5).map((event) => event.id)).toEqual(
      stored
        .filter((event) => event.duration === 5)
        .sort(compareEventsCanonical)
        .map((event) => event.id),
    );
    expect(idsOf(canonical)).not.toEqual(idsOf(whole));

    const walked: string[] = [];
    let offset: number | undefined = 0;

    while (offset !== undefined) {
      const page: TelemetryPage = unwrap(
        repo.query({ sessionId: SESSION_A, sort: 'duration_desc', limit: 2, offset }),
      );

      walked.push(...idsOf(page));
      offset = page.nextOffset;
    }

    expect(walked).toEqual(idsOf(whole));
    expect(new Set(walked).size).toBe(events.length);
  });

  it('orders count_desc rows by id inside each group and in the ungrouped tail', () => {
    // Inside each group start times ascend while ids descend, so the canonical
    // chain and the id disagree on every pair.
    const named = (id: string, name: string, offset: number, requestKey?: string) =>
      buildEvent({
        id,
        name,
        startTime: BASE_TIME + offset,
        ...(requestKey !== undefined
          ? { attributes: { [REQUEST_KEY_ATTRIBUTE]: requestKey } }
          : {}),
      });
    const requestKey = 'f6'.repeat(32);
    const alphaF = named(rankedEventId('f'), 'alpha', 1);
    const alphaE = named(rankedEventId('e'), 'alpha', 2);
    const alphaD = named(rankedEventId('d'), 'alpha', 3);
    const betaC = named(rankedEventId('c'), 'beta', 4);
    const betaB = named(rankedEventId('b'), 'beta', 5);
    // Grouped by request key, these and the two groups above belong to no
    // group and form the tail.
    const gamma9 = named(rankedEventId('9'), 'gamma', 6);
    const gamma8 = named(rankedEventId('8'), 'gamma', 7);
    const gamma7 = named(rankedEventId('7'), 'gamma', 8);
    const deltaW = named(rankedEventId('w'), 'delta', 9, requestKey);
    const deltaV = named(rankedEventId('v'), 'delta', 10, requestKey);

    const alpha = [alphaF, alphaE, alphaD];
    const beta = [betaC, betaB];
    const keyless = [gamma9, gamma8, gamma7];
    const keyed = [deltaW, deltaV];

    // Offered in an order that, inside each three-row group, matches neither
    // the id order nor the canonical one, so neither could pass by arrival.
    insertOk([alphaE, betaB, gamma8, deltaW, alphaF, gamma9, betaC, alphaD, gamma7, deltaV]);

    const sortedIds = (events: readonly PersistableTelemetryEvent[]): string[] =>
      events.map((event) => event.id).sort();

    // By name: alpha and gamma (3 each) tie on count and the key puts alpha
    // first, then beta and delta (2 each) likewise; inside every group,
    // ascending id.
    const byName = unwrap(repo.query({ sessionId: SESSION_A, sort: 'count_desc', limit: 50 }));

    expect(idsOf(byName)).toEqual([
      ...sortedIds(alpha),
      ...sortedIds(keyless),
      ...sortedIds(beta),
      ...sortedIds(keyed),
    ]);

    // The canonical reader keeps canonical order inside each group instead.
    const canonical = unwrap(
      repo.listByCapture(SESSION_A, CAPTURE_A1, { sort: 'count_desc', limit: 50 }),
    );

    expect(idsOf(canonical)).toEqual([
      ...alpha.map((event) => event.id),
      ...keyless.map((event) => event.id),
      ...beta.map((event) => event.id),
      ...keyed.map((event) => event.id),
    ]);

    // By request key: the one group first, then every keyless row by id.
    const byRequestKey = unwrap(
      repo.query({ sessionId: SESSION_A, sort: 'count_desc', groupBy: 'requestKey', limit: 50 }),
    );

    expect(idsOf(byRequestKey)).toEqual([
      ...sortedIds(keyed),
      ...sortedIds([...alpha, ...beta, ...keyless]),
    ]);

    // A three-row walk visits every row once, in the single-page order.
    const walked: string[] = [];
    let offset: number | undefined = 0;

    while (offset !== undefined) {
      const page: TelemetryPage = unwrap(
        repo.query({ sessionId: SESSION_A, sort: 'count_desc', limit: 3, offset }),
      );

      walked.push(...idsOf(page));
      offset = page.nextOffset;
    }

    expect(walked).toEqual(idsOf(byName));
    expect(new Set(walked).size).toBe(byName.total);
  });
});

/* -------------------------------------------------------------------------------------------------
 * query
 * ---------------------------------------------------------------------------------------------- */

describe('query', () => {
  it('defaults to the first 200 rows, earliest first', () => {
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

  it('answers a page size of zero with the count alone, as a terminal page', () => {
    insertOk([buildEvent(), buildEvent(), buildEvent()]);

    const page = unwrap(repo.query({ sessionId: SESSION_A, limit: 0 }));

    // No `nextOffset`: the page read nothing, so its "next" offset would be its
    // own and a pager following it would request the same empty page forever.
    expect(page).toEqual({ rows: [], total: 3 });
    expect(page.nextOffset).toBeUndefined();

    // The same at an offset inside the result, where rows remain ahead: the
    // count is still the whole filter's, and the page is still terminal.
    const inside = unwrap(repo.query({ sessionId: SESSION_A, limit: 0, offset: 2 }));

    expect(inside).toEqual({ rows: [], total: 3 });
    expect(inside.nextOffset).toBeUndefined();

    // Every convenience reader shares the read path, and with it the rule.
    const byCapture = unwrap(repo.listByCapture(SESSION_A, CAPTURE_A1, { limit: 0, offset: 1 }));

    expect(byCapture).toEqual({ rows: [], total: 3 });
  });

  it('keeps an advancing nextOffset for every page that read a row', () => {
    insertOk([
      buildEvent({ startTime: BASE_TIME }),
      buildEvent({ startTime: BASE_TIME + 1 }),
      buildEvent({ startTime: BASE_TIME + 2 }),
    ]);

    // A page that read one row still points past it, for query and for the
    // canonical reader the correlator walks.
    const first = unwrap(repo.query({ sessionId: SESSION_A, limit: 1, offset: 1 }));
    const traced = unwrap(repo.listByTrace(SESSION_A, TRACE_A, { limit: 1, offset: 1 }));

    expect(first.rows).toHaveLength(1);
    expect(first.nextOffset).toBe(2);
    expect(traced.rows).toHaveLength(1);
    expect(traced.nextOffset).toBe(2);

    // An offset at or past the end reads nothing and ends the walk.
    for (const offset of [3, 10]) {
      const past = unwrap(repo.query({ sessionId: SESSION_A, limit: 5, offset }));

      expect(past).toEqual({ rows: [], total: 3 });
    }
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
    const keyed = buildEvent({ attributes: { [REQUEST_KEY_ATTRIBUTE]: requestKey } });

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

  /**
   * One event per tier, plus a second database span and a `function` span in
   * each of the two tiers that kind may be reported in, each at its own start
   * time and with a tier the kind rules allow.
   */
  function insertTieredEvents(): {
    readonly browserSpan: PersistableTelemetryEvent;
    readonly serverSpan: PersistableTelemetryEvent;
    readonly serverFunction: PersistableTelemetryEvent;
    readonly dbSpan: PersistableTelemetryEvent;
    readonly slowDbSpan: PersistableTelemetryEvent;
    readonly browserFunction: PersistableTelemetryEvent;
  } {
    const events = {
      browserSpan: buildEvent({ kind: 'fetch', startTime: BASE_TIME }),
      serverSpan: buildEvent({
        kind: 'http.server',
        producerId: PRODUCER_SERVER,
        startTime: BASE_TIME + 1,
      }),
      serverFunction: buildEvent({
        kind: 'function',
        tier: 'server',
        producerId: PRODUCER_SERVER,
        startTime: BASE_TIME + 2,
      }),
      dbSpan: buildEvent({
        kind: 'db.query',
        producerId: PRODUCER_SERVER,
        startTime: BASE_TIME + 3,
        duration: 2,
      }),
      slowDbSpan: buildEvent({
        kind: 'db.query',
        producerId: PRODUCER_SERVER,
        startTime: BASE_TIME + 4,
        duration: 40,
      }),
      browserFunction: buildEvent({ kind: 'function', tier: 'browser', startTime: BASE_TIME + 5 }),
    };

    insertOk(Object.values(events));

    return events;
  }

  it('narrows by the singular tier a panel filter carries, excluding every other tier', () => {
    const { dbSpan, slowDbSpan } = insertTieredEvents();

    const dbOnly = unwrap(repo.query({ sessionId: SESSION_A, tier: 'db' }));

    expect(dbOnly.rows.map((event) => event.id)).toEqual([dbSpan.id, slowDbSpan.id]);
    expect(dbOnly.rows.every((event) => event.tier === 'db')).toBe(true);
    expect(dbOnly.total).toBe(2);

    // The convenience readers take the same narrowing through their options.
    const byCapture = unwrap(repo.listByCapture(SESSION_A, CAPTURE_A1, { tier: 'db' }));

    expect(byCapture.rows.map((event) => event.id)).toEqual([dbSpan.id, slowDbSpan.id]);
  });

  it('narrows by a filter parsed from a DataQuery and spread onto the query unchanged', () => {
    const { serverFunction, slowDbSpan } = insertTieredEvents();

    // The seam `../panels/data.ts` crosses: a panel node's query, parsed by the
    // panel-schema's own parser, its filter forwarded without an adapter.
    const parsed = unwrap(
      parseDataQuery({ source: 'spans', filter: { tier: 'db', minDuration: 10 } }),
    );
    const page = unwrap(repo.query({ sessionId: SESSION_A, ...forwardFilter(parsed.filter) }));

    expect(page.rows.map((event) => event.id)).toEqual([slowDbSpan.id]);
    expect(page.total).toBe(1);

    // The strict filter schema itself, for the same seam without the query. A
    // `function` span may be reported by either runtime, so only the tier
    // separates the two stored here.
    const filter = dataQueryFilterSchema.parse({ tier: 'server', kinds: ['function'] });
    const narrowed = unwrap(repo.query({ sessionId: SESSION_A, ...forwardFilter(filter) }));

    expect(narrowed.rows.map((event) => event.id)).toEqual([serverFunction.id]);
    expect(narrowed.total).toBe(1);
  });

  it('composes tier with tiers by AND, for rows and for groups', () => {
    const { serverSpan, serverFunction, dbSpan, slowDbSpan } = insertTieredEvents();

    const both = unwrap(
      repo.query({ sessionId: SESSION_A, tier: 'server', tiers: ['server', 'db'] }),
    );

    expect(both.rows.map((event) => event.id)).toEqual([serverSpan.id, serverFunction.id]);

    // A tier outside the list can match nothing.
    const disjoint = unwrap(repo.query({ sessionId: SESSION_A, tier: 'db', tiers: ['browser'] }));

    expect(disjoint).toEqual({ rows: [], total: 0 });

    // The grouped read shares the filter planner, and with it the narrowing.
    const groups = unwrap(repo.queryGroups({ sessionId: SESSION_A, groupBy: 'kind', tier: 'db' }));

    expect(groups.groups.map((group) => [group.key, group.count])).toEqual([['db.query', 2]]);
    expect(groups.groups[0]?.firstEventId).toBe(dbSpan.id);
    expect(groups.groups[0]?.totalDuration).toBe(dbSpan.duration + slowDbSpan.duration);
    expect(groups.total).toBe(1);

    const noGroups = unwrap(
      repo.queryGroups({ sessionId: SESSION_A, groupBy: 'kind', tier: 'db', tiers: ['browser'] }),
    );

    expect(noGroups).toEqual({ groups: [], total: 0 });
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
      [{ sessionId: SESSION_A, sort: 'not-a-sort' }, 'unknown-sort'],
      // A name on Object.prototype: refused by membership, never looked up.
      [{ sessionId: SESSION_A, sort: 'constructor' }, 'unknown-sort'],
      [{ sessionId: SESSION_A, sort: 'count_desc', groupBy: 'not-a-key' }, 'unknown-group-key'],
      [{ sessionId: SESSION_A, groupBy: 'constructor' }, 'unknown-group-key'],
      [{ sessionId: SESSION_A, kinds: ['not-a-kind'] }, 'unknown-kind'],
      [{ sessionId: SESSION_A, tiers: ['not-a-tier'] }, 'unknown-tier'],
      [{ sessionId: SESSION_A, tier: 'not-a-tier' }, 'unknown-tier'],
      [{ sessionId: SESSION_A, tier: 'constructor', tiers: ['db'] }, 'unknown-tier'],
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

  it('degrades a stored row overwritten with invalid JSON to one counted skip and one warning', () => {
    const stored = insertOk([
      buildEvent({ startTime: BASE_TIME }),
      buildEvent({ startTime: BASE_TIME + 1 }),
      buildEvent({ startTime: BASE_TIME + 2 }),
    ]);
    const [before, poisoned, after] = stored;

    // The document of a row the store already holds is cut short mid-value,
    // with a captured value inside what remains: the file was altered after
    // the row was written.
    store
      .statement('UPDATE telemetry_events SET event = ? WHERE id = ?')
      .run(`{"name":"${SENTINEL}","attributes":{"note":"${SENTINEL}"`, poisoned?.id ?? '');

    logs.length = 0;

    // A throw here would fail the test outright; the read must answer `ok`.
    const read = unwrap(repo.query({ sessionId: SESSION_A }));

    expect(read.rows.map((event) => event.id)).toEqual([before?.id, after?.id]);
    expect(read.total).toBe(3);
    expect(read.skipped).toBe(1);

    const warnings = logs.filter((record) => record.level === 'warn');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ skipped: 1, ingestSeqs: [poisoned?.ingestSeq] });
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
 * count_desc and grouped reads
 * ---------------------------------------------------------------------------------------------- */

describe('count_desc and grouped reads', () => {
  /**
   * Six operation names with counts 3, 2, 2, 2, 1 and 1 — three ties of two
   * and one tie of one, so the tie-break is what decides most of the order —
   * inserted interleaved so neither arrival order nor start order matches the
   * expected group order.
   */
  function insertNamedGroups(): TelemetryEvent[] {
    const names = [
      'gamma',
      'alpha',
      'zeta',
      'beta',
      'delta',
      'alpha',
      'gamma',
      'epsilon',
      'beta',
      'delta',
      'alpha',
    ];

    return insertOk(
      names.map((name, index) =>
        buildEvent({ name, startTime: BASE_TIME + 100 - index, duration: index + 0.25 }),
      ),
    );
  }

  it('accepts every DATA_QUERY_SORTS member, for rows and for groups', () => {
    insertNamedGroups();

    for (const sort of DATA_QUERY_SORTS) {
      const rows = repo.query({ sessionId: SESSION_A, sort });
      const groups = repo.queryGroups({ sessionId: SESSION_A, groupBy: 'name', sort });

      expect(isErr(rows)).toBe(false);
      expect(isErr(groups)).toBe(false);
      expect(unwrap(rows).total).toBe(11);
      expect(unwrap(groups).total).toBe(6);
    }
  });

  it('pages groups largest first, breaking count ties on the key, across a multi-page walk', () => {
    const stored = insertNamedGroups();
    const whole = unwrap(repo.queryGroups({ sessionId: SESSION_A, groupBy: 'name' }));

    expect(whole.groups.map((group) => [group.key, group.count])).toEqual([
      ['alpha', 3],
      ['beta', 2],
      ['delta', 2],
      ['gamma', 2],
      ['epsilon', 1],
      ['zeta', 1],
    ]);
    expect(whole.total).toBe(6);
    expect(whole.nextOffset).toBeUndefined();

    // Each group cites its first stored row and reports its timing unrounded.
    const alpha = stored.filter((event) => event.name === 'alpha');

    expect(whole.groups[0]).toEqual({
      key: 'alpha',
      count: 3,
      firstEventId: alpha[0]?.id,
      firstIngestSeq: alpha[0]?.ingestSeq,
      firstStartTime: Math.min(...alpha.map((event) => event.startTime)),
      totalDuration: alpha.reduce((sum, event) => sum + event.duration, 0),
    });

    // Two groups per page: every group exactly once, in the single-page order.
    const walked: string[] = [];
    const offsets: (number | undefined)[] = [];
    let offset: number | undefined = 0;

    while (offset !== undefined) {
      const page: TelemetryGroupPage = unwrap(
        repo.queryGroups({ sessionId: SESSION_A, groupBy: 'name', limit: 2, offset }),
      );

      expect(page.total).toBe(6);
      walked.push(...page.groups.map((group) => group.key));
      offsets.push(page.nextOffset);
      offset = page.nextOffset;
    }

    expect(offsets).toEqual([2, 4, undefined]);
    expect(walked).toEqual(whole.groups.map((group) => group.key));
    expect(new Set(walked).size).toBe(6);
  });

  it('orders rows by their group\u2019s count, keeping each group together in id order', () => {
    const stored = insertNamedGroups();
    const whole = unwrap(repo.query({ sessionId: SESSION_A, sort: 'count_desc', limit: 50 }));

    expect(whole.rows.map((event) => event.name)).toEqual([
      'alpha',
      'alpha',
      'alpha',
      'beta',
      'beta',
      'delta',
      'delta',
      'gamma',
      'gamma',
      'epsilon',
      'zeta',
    ]);

    // Inside a group the panel-data secondary key decides: ascending event id
    // (AAP 0.4.2), whatever order the rows started or arrived in.
    const alpha = whole.rows.filter((event) => event.name === 'alpha');

    expect(alpha.map((event) => event.id)).toEqual(
      stored
        .filter((event) => event.name === 'alpha')
        .map((event) => event.id)
        .sort(),
    );

    // The convenience readers rank the same groups the same way but keep the
    // canonical chain inside each, exactly as the correlator orders events.
    const canonical = unwrap(
      repo.listByCapture(SESSION_A, CAPTURE_A1, { sort: 'count_desc', limit: 50 }),
    );

    expect(canonical.rows.map((event) => event.name)).toEqual(
      whole.rows.map((event) => event.name),
    );
    expect(
      canonical.rows.filter((event) => event.name === 'alpha').map((event) => event.id),
    ).toEqual(
      stored
        .filter((event) => event.name === 'alpha')
        .sort(compareEventsCanonical)
        .map((event) => event.id),
    );

    // The default group key is the operation name, so naming it changes
    // nothing; and a three-row walk visits every row exactly once.
    const named = unwrap(
      repo.query({ sessionId: SESSION_A, sort: 'count_desc', groupBy: 'name', limit: 50 }),
    );

    expect(named.rows.map((event) => event.id)).toEqual(whole.rows.map((event) => event.id));

    const walked: string[] = [];
    let offset: number | undefined = 0;

    while (offset !== undefined) {
      const page: TelemetryPage = unwrap(
        repo.query({ sessionId: SESSION_A, sort: 'count_desc', limit: 3, offset }),
      );

      walked.push(...page.rows.map((event) => event.id));
      offset = page.nextOffset;
    }

    expect(walked).toEqual(whole.rows.map((event) => event.id));
    expect(new Set(walked).size).toBe(stored.length);
  });

  it('respects the filter, and leaves rows without a key out of every group', () => {
    const keyOne = 'd4'.repeat(32);
    const keyTwo = 'e5'.repeat(32);

    insertOk([
      buildEvent({ attributes: { [REQUEST_KEY_ATTRIBUTE]: keyTwo }, startTime: BASE_TIME + 1 }),
      buildEvent({ attributes: { [REQUEST_KEY_ATTRIBUTE]: keyOne }, startTime: BASE_TIME + 2 }),
      buildEvent({ attributes: { [REQUEST_KEY_ATTRIBUTE]: keyOne }, startTime: BASE_TIME + 3 }),
      buildEvent({ attributes: { [REQUEST_KEY_ATTRIBUTE]: keyOne }, startTime: BASE_TIME + 4 }),
      buildEvent({
        attributes: { [REQUEST_KEY_ATTRIBUTE]: keyTwo },
        captureId: CAPTURE_A2,
        startTime: BASE_TIME + 5,
      }),
      // Not requests: no request key, so no request group.
      buildEvent({ kind: 'interaction', startTime: BASE_TIME + 6 }),
      buildEvent({ kind: 'interaction', startTime: BASE_TIME + 7 }),
      // Another session's request under the same key must not be counted.
      buildEvent({
        sessionId: SESSION_B,
        captureId: CAPTURE_B1,
        attributes: { [REQUEST_KEY_ATTRIBUTE]: keyOne },
      }),
    ]);

    const all = unwrap(repo.queryGroups({ sessionId: SESSION_A, groupBy: 'requestKey' }));

    expect(all.groups.map((group) => [group.key, group.count])).toEqual([
      [keyOne, 3],
      [keyTwo, 2],
    ]);
    expect(all.total).toBe(2);

    const oneCapture = unwrap(
      repo.queryGroups({ sessionId: SESSION_A, groupBy: 'requestKey', captureId: CAPTURE_A1 }),
    );

    expect(oneCapture.groups.map((group) => [group.key, group.count])).toEqual([
      [keyOne, 3],
      [keyTwo, 1],
    ]);

    const byKind = unwrap(
      repo.queryGroups({ sessionId: SESSION_A, groupBy: 'kind', kinds: ['interaction'] }),
    );

    expect(byKind.groups.map((group) => [group.key, group.count])).toEqual([['interaction', 2]]);

    const nothing = unwrap(
      repo.queryGroups({ sessionId: SESSION_A, groupBy: 'requestKey', kinds: [] }),
    );

    expect(nothing).toEqual({ groups: [], total: 0 });

    // Rows: the three keyOne requests, then the two keyTwo requests, then the
    // two interactions that belong to no request group, in canonical order.
    const rows = unwrap(
      repo.query({ sessionId: SESSION_A, sort: 'count_desc', groupBy: 'requestKey' }),
    );

    expect(rows.total).toBe(7);
    expect(rows.rows.map((event) => event.attributes[REQUEST_KEY_ATTRIBUTE] ?? event.kind)).toEqual(
      [keyOne, keyOne, keyOne, keyTwo, keyTwo, 'interaction', 'interaction'],
    );
  });

  it('groups by component only where the attribute is a string', () => {
    insertOk([
      buildEvent({ kind: 'render', attributes: { component: 'Beta' } }),
      buildEvent({ kind: 'render', attributes: { component: 'Alpha' } }),
      buildEvent({ kind: 'render', attributes: { component: 'Beta' } }),
      buildEvent({ kind: 'render', attributes: { component: 42 } }),
      buildEvent({ kind: 'render', attributes: {} }),
    ]);

    const groups = unwrap(repo.queryGroups({ sessionId: SESSION_A, groupBy: 'component' }));

    expect(groups.groups.map((group) => [group.key, group.count])).toEqual([
      ['Beta', 2],
      ['Alpha', 1],
    ]);
    expect(groups.total).toBe(2);
  });

  /**
   * Writes a row another build could have left: valid flat columns, and a
   * document this build cannot reconstruct as an event.
   */
  function plantUnreadableRow(fields: {
    readonly name: string;
    readonly startTime: number;
    readonly document: string;
  }): void {
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
        'render',
        'browser',
        fields.name,
        fields.startTime,
        7,
        PRODUCER_BROWSER,
        nextSeq(PRODUCER_BROWSER),
        fields.document,
      );
  }

  it('keeps grouping and filtering by component when a stored document is not valid JSON', () => {
    const alpha = insertOk([
      buildEvent({ kind: 'render', name: 'render', attributes: { component: 'Alpha' } }),
      buildEvent({ kind: 'render', name: 'render', attributes: { component: 'Alpha' } }),
    ]);
    plantUnreadableRow({ name: 'render', startTime: BASE_TIME + 5, document: '{"attributes":' });
    const beta = insertOk([
      buildEvent({ kind: 'render', name: 'render', attributes: { component: 'Beta' } }),
    ]);

    // SQLite's JSON functions raise on a malformed document; the guarded
    // expressions answer NULL, so the row simply has no component.
    const byComponent = unwrap(repo.queryGroups({ sessionId: SESSION_A, groupBy: 'component' }));

    expect(byComponent.groups.map((group) => [group.key, group.count])).toEqual([
      ['Alpha', 2],
      ['Beta', 1],
    ]);
    expect(byComponent.skipped).toBeUndefined();

    // The two Alpha renders share a start time, so the event id orders them.
    const alphaIds = alpha.map((event) => event.id).sort();
    const filtered = unwrap(repo.query({ sessionId: SESSION_A, component: 'Alpha' }));

    expect(filtered.rows.map((event) => event.id)).toEqual(alphaIds);

    const ranked = unwrap(
      repo.query({ sessionId: SESSION_A, sort: 'count_desc', groupBy: 'component' }),
    );

    // The unreadable row ranks with the rows that have no component and is
    // then skipped and reported, as any row page does.
    expect(ranked.rows.map((event) => event.id)).toEqual([
      ...alphaIds,
      ...beta.map((event) => event.id),
    ]);
    expect(ranked.total).toBe(4);
    expect(ranked.skipped).toBe(1);

    // Under a key read from a flat column the same row reaches the fold, where
    // it is left out of its group and reported.
    const byName = unwrap(repo.queryGroups({ sessionId: SESSION_A, groupBy: 'name' }));

    expect(byName.groups.map((group) => [group.key, group.count])).toEqual([['render', 3]]);
    expect(byName.skipped).toBe(1);
  });

  it('counts and cites readable events only, and reports the rows it left out', () => {
    // The unreadable row is the group's first arrival: it would have been its
    // representative, and its only member for the second key.
    plantUnreadableRow({
      name: 'shared',
      startTime: BASE_TIME - 50,
      document: JSON.stringify({ unexpected: SENTINEL }),
    });
    plantUnreadableRow({
      name: 'ghost',
      startTime: BASE_TIME - 40,
      document: JSON.stringify({ unexpected: SENTINEL }),
    });
    const readable = insertOk([
      buildEvent({ name: 'shared', startTime: BASE_TIME + 1, duration: 2 }),
      buildEvent({ name: 'shared', startTime: BASE_TIME + 2, duration: 3 }),
    ]);

    const page = unwrap(repo.queryGroups({ sessionId: SESSION_A, groupBy: 'name' }));

    expect(page.groups).toEqual([
      {
        key: 'shared',
        count: 2,
        firstEventId: readable[0]?.id,
        firstIngestSeq: readable[0]?.ingestSeq,
        firstStartTime: BASE_TIME + 1,
        totalDuration: 5,
      },
    ]);
    // A group with no readable event does not exist.
    expect(page.total).toBe(1);
    expect(page.skipped).toBe(2);

    // Every representative is an event a read can show.
    const cited = page.groups.map((group) => group.firstEventId);

    expect(unwrap(repo.existingEventIds(SESSION_A, cited)).size).toBe(cited.length);

    const warning = logs.find(
      (record) =>
        record.message ===
        'left telemetry rows that no longer match the event schema out of every group',
    );

    expect(warning?.level).toBe('warn');
    expect(warning?.fields).toMatchObject({ skipped: 2, ingestSeqs: [1, 2] });
    expect(loggedText()).not.toContain(SENTINEL);
  });

  it('orders groups by total duration or by first start under the other two sorts', () => {
    insertOk([
      buildEvent({ name: 'short-many', startTime: BASE_TIME + 1, duration: 1 }),
      buildEvent({ name: 'short-many', startTime: BASE_TIME + 2, duration: 1 }),
      buildEvent({ name: 'short-many', startTime: BASE_TIME + 3, duration: 1 }),
      buildEvent({ name: 'long-once', startTime: BASE_TIME + 4, duration: 50.5 }),
      buildEvent({ name: 'early-tie', startTime: BASE_TIME, duration: 3 }),
    ]);

    const byDuration = unwrap(
      repo.queryGroups({ sessionId: SESSION_A, groupBy: 'name', sort: 'duration_desc' }),
    );

    expect(byDuration.groups.map((group) => [group.key, group.totalDuration])).toEqual([
      ['long-once', 50.5],
      // 3 and 3: tied on total duration, so the key decides.
      ['early-tie', 3],
      ['short-many', 3],
    ]);

    const byStart = unwrap(
      repo.queryGroups({ sessionId: SESSION_A, groupBy: 'name', sort: 'start_asc' }),
    );

    expect(byStart.groups.map((group) => group.key)).toEqual([
      'early-tie',
      'short-many',
      'long-once',
    ]);
  });

  it('pages groups with the row-page bounds, ending the walk at a count-only page', () => {
    insertNamedGroups();

    const countOnly = unwrap(repo.queryGroups({ sessionId: SESSION_A, groupBy: 'name', limit: 0 }));

    // A count-only page returns no group, so it is terminal: its "next" offset
    // would be its own, and a group pager following it would never advance.
    expect(countOnly).toEqual({ groups: [], total: 6 });
    expect(countOnly.nextOffset).toBeUndefined();

    // Likewise at an offset inside the result, with groups still ahead.
    const countInside = unwrap(
      repo.queryGroups({ sessionId: SESSION_A, groupBy: 'name', limit: 0, offset: 3 }),
    );

    expect(countInside).toEqual({ groups: [], total: 6 });
    expect(countInside.nextOffset).toBeUndefined();

    // A page that returned a group still advances past it.
    const oneGroup = unwrap(
      repo.queryGroups({ sessionId: SESSION_A, groupBy: 'name', limit: 1, offset: 3 }),
    );

    expect(oneGroup.groups).toHaveLength(1);
    expect(oneGroup.nextOffset).toBe(4);

    const clamped = unwrap(
      repo.queryGroups({
        sessionId: SESSION_A,
        groupBy: 'name',
        limit: TELEMETRY_QUERY_MAX_LIMIT + 1,
      }),
    );

    expect(clamped.groups).toHaveLength(6);
    expect(clamped.nextOffset).toBeUndefined();

    const past = unwrap(repo.queryGroups({ sessionId: SESSION_A, groupBy: 'name', offset: 6 }));

    expect(past).toEqual({ groups: [], total: 6 });
  });

  it('refuses a grouped query it will not accept, naming the reason', () => {
    const cases = [
      [{ sessionId: SESSION_A }, 'missing-group-key'],
      [{ sessionId: SESSION_A, groupBy: 'trace_id' }, 'unknown-group-key'],
      [{ sessionId: SESSION_A, groupBy: 'constructor' }, 'unknown-group-key'],
      [{ sessionId: SESSION_A, groupBy: 'name', sort: 'not-a-sort' }, 'unknown-sort'],
      [{ sessionId: SESSION_A, groupBy: 'name', limit: -1 }, 'invalid-limit'],
      [{ sessionId: SESSION_A, groupBy: 'name', offset: 1.5 }, 'invalid-offset'],
      [{ sessionId: '', groupBy: 'name' }, 'blank-session-id'],
      [{ sessionId: SESSION_A, groupBy: 'name', kinds: ['not-a-kind'] }, 'unknown-kind'],
      [{ sessionId: SESSION_A, groupBy: 'name', tier: 'not-a-tier' }, 'unknown-tier'],
    ] as const;

    for (const [query, reason] of cases) {
      const result = repo.queryGroups(query as Parameters<TelemetryRepo['queryGroups']>[0]);

      expect(isErr(result)).toBe(true);

      if (isErr(result)) {
        expect(result.error.code).toBe('STORE_ERROR');
        expect(result.error.details?.['reason']).toBe(reason);
      }
    }
  });

  it('never logs a group key, which is captured data', () => {
    insertOk([buildEvent({ name: SENTINEL }), buildEvent({ name: SENTINEL })]);

    const groups = unwrap(repo.queryGroups({ sessionId: SESSION_A, groupBy: 'name' }));

    expect(groups.groups[0]?.key).toBe(SENTINEL);
    unwrap(repo.query({ sessionId: SESSION_A, sort: 'count_desc' }));
    expect(loggedText()).not.toContain(SENTINEL);
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
      attributes: { [REQUEST_KEY_ATTRIBUTE]: requestKey },
      startTime: BASE_TIME + 4,
    });
    const keyedTwo = buildEvent({
      attributes: { [REQUEST_KEY_ATTRIBUTE]: requestKey },
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

  it('agrees with the equivalent query call, reader for reader', () => {
    // Distinct start times throughout, so the canonical order of the readers
    // and the panel-data order of `query` coincide and the comparison can be
    // of whole ordered pages rather than of sets.
    const requestKey = requestKeyOf('c4');
    const root = buildEvent({ kind: 'interaction', startTime: BASE_TIME + 1 });
    const events = [
      root,
      buildEvent({
        parentSpanId: root.spanId,
        startTime: BASE_TIME + 2,
        attributes: { [REQUEST_KEY_ATTRIBUTE]: requestKey },
      }),
      buildEvent({
        parentSpanId: root.spanId,
        startTime: BASE_TIME + 3,
        attributes: { [REQUEST_KEY_ATTRIBUTE]: requestKey },
      }),
      buildEvent({ kind: 'render', startTime: BASE_TIME + 4, captureId: CAPTURE_A2 }),
      buildEvent({ traceId: TRACE_B, startTime: BASE_TIME, kind: 'db.query' }),
      buildEvent({ traceId: TRACE_B, startTime: BASE_TIME + 5, captureId: CAPTURE_A2 }),
      buildEvent({ sessionId: SESSION_B, captureId: CAPTURE_B1, startTime: BASE_TIME + 6 }),
    ];

    insertOk(events);

    function pageOf(page: TelemetryPage): readonly [string[], number] {
      return [page.rows.map((event) => event.id), page.total];
    }

    expect(pageOf(unwrap(repo.listByTrace(SESSION_A, TRACE_A)))).toEqual(
      pageOf(unwrap(repo.query({ sessionId: SESSION_A, traceId: TRACE_A }))),
    );
    expect(pageOf(unwrap(repo.listByCapture(SESSION_A, CAPTURE_A2)))).toEqual(
      pageOf(unwrap(repo.query({ sessionId: SESSION_A, captureId: CAPTURE_A2 }))),
    );
    expect(pageOf(unwrap(repo.listByRequestKey(SESSION_A, requestKey)))).toEqual(
      pageOf(unwrap(repo.query({ sessionId: SESSION_A, requestKey }))),
    );

    // `query` has no parent filter, so the children are the rows of the whole
    // session page that name the parent — in the same order.
    const whole = unwrap(repo.query({ sessionId: SESSION_A }));

    expect(unwrap(repo.listChildren(SESSION_A, root.spanId)).rows.map((event) => event.id)).toEqual(
      whole.rows.filter((event) => event.parentSpanId === root.spanId).map((event) => event.id),
    );
    expect(unwrap(repo.getBySpanId(SESSION_A, root.spanId))).toEqual(
      whole.rows.find((event) => event.spanId === root.spanId),
    );

    // Distinct trace ids, ordered by each trace's earliest start: TRACE_B
    // starts at BASE_TIME, TRACE_A one millisecond later.
    const firstSeen = [...new Set(whole.rows.map((event) => event.traceId))];

    expect(unwrap(repo.listTraceIds(SESSION_A))).toEqual(firstSeen);
    expect(firstSeen).toEqual([TRACE_B, TRACE_A]);

    // Zero-filled over the whole vocabulary, and equal kind for kind to a
    // count-only query narrowed to that kind.
    const counts = unwrap(repo.countByKind(SESSION_A));

    expect(Object.keys(counts).sort()).toEqual([...TELEMETRY_KINDS].sort());

    for (const kind of TELEMETRY_KINDS) {
      expect(counts[kind]).toBe(
        unwrap(repo.query({ sessionId: SESSION_A, kinds: [kind], limit: 0 })).total,
      );
    }
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

  it('narrows a trace shared by two captures to one capture window when asked', () => {
    // One trace id under two captures of the same session: a producer mints
    // trace ids, so nothing keys one to a single capture.
    const firstWindow = [
      buildEvent({ kind: 'interaction', startTime: BASE_TIME }),
      buildEvent({ startTime: BASE_TIME + 3 }),
    ];
    const secondWindow = [
      buildEvent({ captureId: CAPTURE_A2, kind: 'interaction', startTime: BASE_TIME + 1 }),
      buildEvent({ captureId: CAPTURE_A2, startTime: BASE_TIME + 2 }),
      buildEvent({ captureId: CAPTURE_A2, startTime: BASE_TIME + 4 }),
    ];

    insertOk([...secondWindow, ...firstWindow]);

    const everyCapture = unwrap(repo.listByTrace(SESSION_A, TRACE_A));

    expect(everyCapture.total).toBe(5);
    expect(everyCapture.rows.map((event) => event.captureId)).toEqual([
      CAPTURE_A1,
      CAPTURE_A2,
      CAPTURE_A2,
      CAPTURE_A1,
      CAPTURE_A2,
    ]);

    const first = unwrap(repo.listByTrace(SESSION_A, TRACE_A, { captureId: CAPTURE_A1 }));

    expect(first.rows.map((event) => event.id)).toEqual(firstWindow.map((event) => event.id));
    expect(first.total).toBe(firstWindow.length);

    const second = unwrap(repo.listByTrace(SESSION_A, TRACE_A, { captureId: CAPTURE_A2 }));

    expect(second.rows.map((event) => event.id)).toEqual(secondWindow.map((event) => event.id));
    expect(second.total).toBe(secondWindow.length);

    // Narrowed and paged: the page walk is over the capture's rows alone.
    const paged = unwrap(
      repo.listByTrace(SESSION_A, TRACE_A, { captureId: CAPTURE_A2, limit: 2, offset: 0 }),
    );

    expect(paged.rows.map((event) => event.id)).toEqual(
      secondWindow.slice(0, 2).map((event) => event.id),
    );
    expect(paged.total).toBe(secondWindow.length);

    // A capture of another session narrows to nothing rather than reaching it.
    expect(unwrap(repo.listByTrace(SESSION_A, TRACE_A, { captureId: CAPTURE_B1 })).total).toBe(0);
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

/*
 * Why these lookups exist: `src/panels/validate.ts` passes them as the
 * `resolveEventIds` / `resolveTraceIds` options of `validateAgainstCapture`
 * (`packages/panel-schema/src/semantic.ts`). The bounded capture summary alone
 * can only answer `unverifiable` for a citation outside its top-N sections;
 * with the store behind it every citation gets a real verdict, which is this
 * table's contribution to AAP 0.8.4's rule that an observed fact cites
 * evidence the capture actually holds.
 */
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

  it('mirrors every property for trace ids: scope, chunking and de-duplication', () => {
    const traceOfA2 = newTraceId();
    const traceOfB = newTraceId();
    const manyTraces = Array.from({ length: 40 }, () => newTraceId());

    insertOk([
      ...manyTraces.map((traceId, index) => buildEvent({ traceId, startTime: BASE_TIME + index })),
      buildEvent({ traceId: traceOfA2, captureId: CAPTURE_A2 }),
      buildEvent({ traceId: traceOfB, sessionId: SESSION_B, captureId: CAPTURE_B1 }),
    ]);

    // 1 200 cited ids, most of them absent and some cited twice: three
    // statements at the 500-parameter bound, never one over SQLite's limit.
    const absent = Array.from({ length: 1_200 - manyTraces.length * 2 - 2 }, () => newTraceId());
    const cited = [...manyTraces, ...absent, ...manyTraces, traceOfA2, traceOfB];

    expect(cited).toHaveLength(1_200);

    const found = unwrap(repo.existingTraceIds(SESSION_A, cited));

    expect([...found].sort()).toEqual([...manyTraces, traceOfA2].sort());

    // Another session's trace is absent from this session's answer, and a
    // capture narrowing keeps only that capture's traces.
    expect(found.has(traceOfB)).toBe(false);
    expect([...unwrap(repo.existingTraceIds(SESSION_A, cited, CAPTURE_A2))]).toEqual([traceOfA2]);
    expect([...unwrap(repo.existingTraceIds(SESSION_B, cited))]).toEqual([traceOfB]);
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
  /** How many rows of the table started before `cutoff`, read directly. */
  function countOlderThan(cutoff: number): number {
    return Number(
      store
        .statement('SELECT COUNT(*) AS total FROM telemetry_events WHERE start_time < ?')
        .get(cutoff)?.['total'],
    );
  }

  it('counts and deletes one session without reaching another', async () => {
    insertOk([
      buildEvent(),
      buildEvent(),
      buildEvent({ sessionId: SESSION_B, captureId: CAPTURE_B1 }),
    ]);

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(2);
    expect(unwrap(repo.countBySession(SESSION_B))).toBe(1);

    expect(unwrap(await repo.deleteBySession(SESSION_A))).toBe(2);

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(0);
    expect(unwrap(repo.countBySession(SESSION_B))).toBe(1);
  });

  it('deletes in bounded batches, one transaction each, until the predicate is exhausted', async () => {
    const events = Array.from({ length: 7 }, (_unused, index) =>
      buildEvent({ startTime: BASE_TIME + index }),
    );

    insertOk(events);

    const transactions = vi.spyOn(store, 'transaction');

    // A batch size of two forces four statements, each in its own transaction,
    // which is what keeps a large purge from holding the write lock.
    expect(
      unwrap(
        await repo.deleteOlderThan(BASE_TIME + 100, { batchSize: 2, sessionIds: [SESSION_A] }),
      ),
    ).toBe(7);

    expect(transactions).toHaveBeenCalledTimes(4);
    transactions.mockRestore();

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(0);
  });

  it('deletes only what started before the cutoff', async () => {
    const old = buildEvent({ startTime: BASE_TIME });
    const recent = buildEvent({ startTime: BASE_TIME + 1000 });

    insertOk([old, recent]);

    expect(unwrap(await repo.deleteOlderThan(BASE_TIME + 500))).toBe(1);
    expect(unwrap(repo.query({ sessionId: SESSION_A })).rows.map((event) => event.id)).toEqual([
      recent.id,
    ]);
  });

  it('restricts a purge to the sessions it names, and deletes nothing for an empty list', async () => {
    insertOk([buildEvent(), buildEvent({ sessionId: SESSION_B, captureId: CAPTURE_B1 })]);

    expect(unwrap(await repo.deleteOlderThan(BASE_TIME + 100, { sessionIds: [] }))).toBe(0);
    expect(unwrap(await repo.deleteOlderThan(BASE_TIME + 100, { sessionIds: [SESSION_B] }))).toBe(
      1,
    );

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(1);
    expect(unwrap(repo.countBySession(SESSION_B))).toBe(0);
  });

  it('walks named sessions one at a time, honouring the cutoff in each', async () => {
    insertOk([
      buildEvent({ startTime: BASE_TIME }),
      buildEvent({ startTime: BASE_TIME + 1 }),
      buildEvent({ startTime: BASE_TIME + 1000 }),
      buildEvent({ sessionId: SESSION_B, captureId: CAPTURE_B1, startTime: BASE_TIME }),
      buildEvent({ sessionId: SESSION_B, captureId: CAPTURE_B1, startTime: BASE_TIME + 1000 }),
    ]);

    const transactions = vi.spyOn(store, 'transaction');

    // Duplicates are harmless: the session list is de-duplicated first.
    expect(
      unwrap(
        await repo.deleteOlderThan(BASE_TIME + 500, {
          batchSize: 1,
          sessionIds: [SESSION_A, SESSION_B, SESSION_A],
        }),
      ),
    ).toBe(3);

    // Session A: two full batches and the short one that ends it; session B:
    // one full batch and the short one.
    expect(transactions).toHaveBeenCalledTimes(5);
    transactions.mockRestore();

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(1);
    expect(unwrap(repo.countBySession(SESSION_B))).toBe(1);
  });

  it('refuses a purge argument it will not accept, without rejecting', async () => {
    const cases = [
      [Number.NaN, undefined, 'invalid-cutoff'],
      [BASE_TIME, { batchSize: 0 }, 'invalid-batch-size'],
      [BASE_TIME, { batchSize: 1.5 }, 'invalid-batch-size'],
      [BASE_TIME, { sessionIds: [''] }, 'blank-session-id'],
    ] as const;

    for (const [cutoff, options, reason] of cases) {
      const result = await repo.deleteOlderThan(cutoff, options);

      expect(isErr(result)).toBe(true);

      if (isErr(result)) {
        expect(result.error.code).toBe('STORE_ERROR');
        expect(result.error.details?.['reason']).toBe(reason);
      }
    }

    const blank = await repo.deleteBySession('');

    expect(isErr(blank)).toBe(true);

    if (isErr(blank)) {
      expect(blank.error.details?.['reason']).toBe('blank-session-id');
    }
  });

  // 5 001 rows written then purged overruns Vitest's 5 s default on a loaded shared host.
  it('clamps a batch size above MAX_PURGE_BATCH_SIZE instead of refusing it', async () => {
    const events = Array.from({ length: MAX_PURGE_BATCH_SIZE + 1 }, (_unused, index) =>
      buildEvent({ startTime: BASE_TIME + index / 8, seq: index }),
    );

    insertOk(events);

    const transactions = vi.spyOn(store, 'transaction');

    expect(
      unwrap(
        await repo.deleteOlderThan(BASE_TIME + 10_000, { batchSize: MAX_PURGE_BATCH_SIZE * 10 }),
      ),
    ).toBe(events.length);

    // Two statements — the ceiling, then the one row left — where an unclamped
    // batch would have taken everything in one lock hold.
    expect(transactions).toHaveBeenCalledTimes(2);
    transactions.mockRestore();

    const purged = logs.find((record) => record.message === 'purged telemetry older than a cutoff');

    expect(purged?.fields).toMatchObject({
      batchSize: MAX_PURGE_BATCH_SIZE,
      deleted: events.length,
    });
    expect(MAX_PURGE_BATCH_SIZE).toBe(DEFAULT_PURGE_BATCH_SIZE);
  }, 60_000);

  it('yields between batches, so an ingest batch scheduled mid-purge runs before it ends', async () => {
    const cutoff = BASE_TIME + 100;
    const old = Array.from({ length: 10 }, (_unused, index) =>
      buildEvent({ startTime: BASE_TIME + index }),
    );

    insertOk(old);

    let settled = false;
    const purge = repo.deleteOlderThan(cutoff, { batchSize: 2 }).then((result) => {
      settled = true;

      return result;
    });

    // Queued after the purge has started. Under a synchronous sweep it could
    // only run once every batch had committed; here it runs between two of
    // them, with some old rows already gone and some still present.
    const observed = await new Promise<{ settled: boolean; remaining: number; inserted: number }>(
      (resolve) => {
        setImmediate(() => {
          const written = unwrap(repo.insertMany([buildEvent({ startTime: BASE_TIME + 5000 })]));

          resolve({ settled, remaining: countOlderThan(cutoff), inserted: written.inserted });
        });
      },
    );

    expect(observed.settled).toBe(false);
    expect(observed.inserted).toBe(1);
    expect(observed.remaining).toBeGreaterThan(0);
    expect(observed.remaining).toBeLessThan(old.length);

    // The purge still removes every old row and leaves the fresh one alone.
    expect(unwrap(await purge)).toBe(old.length);
    expect(countOlderThan(cutoff)).toBe(0);
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(1);
  });

  it('refuses to run inside a caller\u2019s open transaction, deleting nothing', async () => {
    insertOk(
      Array.from({ length: 7 }, (_unused, index) => buildEvent({ startTime: BASE_TIME + index })),
    );

    let remainingInside = -1;
    let byCutoff: ReturnType<TelemetryRepo['deleteOlderThan']> | undefined;
    let bySession: ReturnType<TelemetryRepo['deleteBySession']> | undefined;

    store.transaction(() => {
      byCutoff = repo.deleteOlderThan(BASE_TIME + 100, { batchSize: 2 });
      bySession = repo.deleteBySession(SESSION_A);

      // Not one batch ran as a savepoint of this transaction: a sweep in here
      // would hold the write lock until the caller committed.
      remainingInside = countOlderThan(BASE_TIME + 100);
    });

    expect(remainingInside).toBe(7);

    for (const pending of [byCutoff, bySession]) {
      expect(pending).toBeDefined();

      const result = await pending!;

      expect(isErr(result)).toBe(true);

      if (isErr(result)) {
        expect(result.error.code).toBe('STORE_ERROR');
        expect(result.error.details?.['reason']).toBe('purge-inside-transaction');
        expect(result.error.details?.['deletedBeforeRefusal']).toBe(0);
        expect(result.error.details?.['batchesCommitted']).toBe(0);
      }
    }

    expect(unwrap(repo.countBySession(SESSION_A))).toBe(7);
  });

  it('stops a sweep, keeping the batches it committed, when a transaction is open by its next batch', async () => {
    insertOk(
      Array.from({ length: 7 }, (_unused, index) => buildEvent({ startTime: BASE_TIME + index })),
    );

    // The first batch runs, and commits, before the promise is returned.
    const purge = repo.deleteOlderThan(BASE_TIME + 100, { batchSize: 2 });

    expect(countOlderThan(BASE_TIME + 100)).toBe(5);

    // Work that opens a transaction while the sweep is yielding: the next
    // batch must not become a savepoint of it.
    store.db.exec('BEGIN');

    let result: Awaited<typeof purge>;

    try {
      result = await purge;

      expect(countOlderThan(BASE_TIME + 100)).toBe(5);
    } finally {
      store.db.exec('ROLLBACK');
    }

    expect(isErr(result)).toBe(true);

    if (isErr(result)) {
      expect(result.error.details?.['reason']).toBe('purge-inside-transaction');
      expect(result.error.details?.['deletedBeforeRefusal']).toBe(2);
      expect(result.error.details?.['batchesCommitted']).toBe(1);
    }

    // The committed batch stays committed; the refused sweep removed nothing
    // more, and a later purge outside any transaction finishes the job.
    expect(countOlderThan(BASE_TIME + 100)).toBe(5);
    expect(unwrap(await repo.deleteOlderThan(BASE_TIME + 100, { batchSize: 2 }))).toBe(5);
    expect(countOlderThan(BASE_TIME + 100)).toBe(0);
  });

  it('resolves a failure between batches as an error rather than rejecting', async () => {
    insertOk(
      Array.from({ length: 6 }, (_unused, index) => buildEvent({ startTime: BASE_TIME + index })),
    );

    const purge = repo.deleteOlderThan(BASE_TIME + 100, { batchSize: 2 });

    // The first batch ran synchronously; the store closes before the second.
    store.close();

    const result = await purge;

    expect(isErr(result)).toBe(true);

    if (isErr(result)) {
      expect(result.error.code).toBe('STORE_ERROR');
    }

    store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite') }));
    repo = createTelemetryRepo({ store });

    // The committed batch stays committed; the rest is still there.
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(4);
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
  it('keeps a captured value out of every log record and every error payload', async () => {
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
    unwrap(repo.queryGroups({ sessionId: SESSION_A, groupBy: 'name' }));
    unwrap(await repo.deleteBySession(SESSION_A));

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

  it('refuses on every path with a code from the closed vocabulary, and no captured value', async () => {
    const carrying = buildEvent({ name: SENTINEL, attributes: { note: SENTINEL } });

    insertOk([carrying]);

    // One refusal per failure family the repository has: schema, attribution,
    // replay conflict, query argument, lookup argument and purge argument.
    const refusals: Result<unknown, DebuggenError>[] = [
      repo.insertMany([{ ...draftEvent({ attributes: { note: SENTINEL } }), duration: -1 }]),
      repo.insertMany([buildEvent({ name: SENTINEL, captureId: newCaptureId() })]),
      repo.insertMany([{ ...carrying, attributes: { note: `${SENTINEL}-changed` } }]),
      repo.query({ sessionId: SESSION_A, sort: SENTINEL as unknown as 'start_asc' }),
      repo.query({ sessionId: SESSION_A, component: SENTINEL, limit: -1 }),
      repo.existingEventIds('', [carrying.id]),
      await repo.deleteOlderThan(Number.NaN),
    ];
    const vocabulary: readonly string[] = DEBUGGEN_ERROR_CODES;

    for (const refusal of refusals) {
      expect(isErr(refusal)).toBe(true);

      if (isErr(refusal)) {
        expect(vocabulary).toContain(refusal.error.code);
        expect(errorText(refusal.error)).not.toContain(SENTINEL);
      }
    }

    expect(loggedText()).not.toContain(SENTINEL);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Bulk insertion and index use
 * ---------------------------------------------------------------------------------------------- */

describe('bulk insertion and index use', () => {
  // Timeout above the 15 s bound asserted below, so that bound, not Vitest's 5 s default, decides.
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
  }, 60_000);

  it('clamps a request for more than the ceiling to 5 000 rows over a larger capture', () => {
    const count = TELEMETRY_QUERY_MAX_LIMIT + 50;
    const events = Array.from({ length: count }, (_unused, index) =>
      buildEvent({ startTime: BASE_TIME + index / 4, seq: index }),
    );

    const started = performance.now();
    const written = unwrap(repo.insertMany(events));

    // One batch, one transaction: well inside the suite's default timeout even
    // on a shared host, where a per-row commit would not be.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(written.inserted).toBe(count);

    const clamped = unwrap(repo.query({ sessionId: SESSION_A, limit: 10_000 }));

    expect(clamped.rows).toHaveLength(TELEMETRY_QUERY_MAX_LIMIT);
    expect(clamped.total).toBe(count);
    expect(clamped.nextOffset).toBe(TELEMETRY_QUERY_MAX_LIMIT);

    const rest = unwrap(
      repo.query({ sessionId: SESSION_A, limit: 10_000, offset: clamped.nextOffset }),
    );

    expect(rest.rows).toHaveLength(count - TELEMETRY_QUERY_MAX_LIMIT);
    expect(rest.nextOffset).toBeUndefined();
    expect(new Set([...clamped.rows, ...rest.rows].map((event) => event.id)).size).toBe(count);
  }, 30_000);

  it('takes every purge batch from a covering purge index, with no sort and no table scan', () => {
    insertOk([
      buildEvent(),
      buildEvent({ startTime: BASE_TIME + 1 }),
      buildEvent({ sessionId: SESSION_B, captureId: CAPTURE_B1 }),
    ]);

    // The exported statement texts themselves, so the plan asserted is the plan
    // the purge runs.
    const cases = [
      [DELETE_OLDER_THAN_BATCH_SQL, 'idx_telemetry_events_start_time_ingest_seq'],
      [DELETE_SESSION_BATCH_SQL, 'idx_telemetry_events_session_id_start_time_ingest_seq'],
      [
        DELETE_SESSION_OLDER_THAN_BATCH_SQL,
        'idx_telemetry_events_session_id_start_time_ingest_seq',
      ],
    ] as const;

    for (const [sql, index] of cases) {
      const plan = queryPlan(sql).join(' | ');

      // The outer DELETE reaches rows by primary key; the batch subquery is an
      // ordered covering-index range that stops at LIMIT.
      expect(plan).toContain('USING INTEGER PRIMARY KEY');
      expect(plan).toContain(`SEARCH telemetry_events USING COVERING INDEX ${index} (`);
      expect(plan).not.toContain('TEMP B-TREE');
      expect(plan).not.toContain('SCAN telemetry_events');
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The index each reader is answered from
 * ---------------------------------------------------------------------------------------------- */

/** The single-column index on `span_id`, declared by the version-1 schema. */
const SPAN_INDEX = 'idx_telemetry_events_span_id';

/** The single-column index on `parent_span_id`, declared by the version-1 schema. */
const PARENT_SPAN_INDEX = 'idx_telemetry_events_parent_span_id';

/** The `(trace_id, start_time)` index, declared by the version-1 schema. */
const TRACE_INDEX = 'idx_telemetry_events_trace_id_start_time';

/** The index SQLite builds for the `UNIQUE` constraint on `telemetry_events.id`. */
const EVENT_ID_INDEX = 'sqlite_autoindex_telemetry_events_1';

/** The `(session_id, capture_id, start_time)` index behind the default page of a capture. */
const CAPTURE_INDEX = 'idx_telemetry_events_session_id_capture_id_start_time';

/** The `(session_id, kind)` index, declared by the version-1 schema. */
const KIND_INDEX = 'idx_telemetry_events_session_id_kind';

/** The `(session_id, kind, start_time, id)` index, added by schema version 3. */
const KIND_ORDER_INDEX = 'idx_telemetry_events_session_id_kind_start_time_id';

/** The `(session_id, request_key)` index, declared by the version-1 schema. */
const REQUEST_KEY_INDEX = 'idx_telemetry_events_session_id_request_key';

/** The `(session_id, request_key, start_time, producer_id, seq)` index, added by schema version 3. */
const REQUEST_KEY_ORDER_INDEX =
  'idx_telemetry_events_session_id_request_key_start_time_producer_id_seq';

/**
 * The version-2 purge index. It leads with `session_id` and satisfies the
 * leading `start_time` term of every read ordering, which is why the planner
 * chose it — and walked a whole session — for span, parent-span, trace,
 * event-id, request-group and single-kind lookups before schema version 3. No
 * reader below may be planned on it.
 */
const SESSION_PURGE_INDEX = 'idx_telemetry_events_session_id_start_time_ingest_seq';

/**
 * How many events {@link seedPlanFixture} stores, across both sessions.
 *
 * The store never runs `ANALYZE`, so the planner reads no statistics and its
 * choice does not depend on this number. It is sized so that a plan walking a
 * whole session instead of one key would be a real cost, while seeding stays
 * cheap enough to repeat per test.
 */
const PLAN_FIXTURE_EVENTS = 2_000;

/**
 * The kinds of one family of consecutive events, in order: an `interaction`
 * root, then its children — one `fetch` carrying a request key and three
 * render-tier events.
 */
const FAMILY_KINDS: readonly TelemetryKind[] = [
  'interaction',
  'fetch',
  'render',
  'commit',
  'render',
];

/** Consecutive events sharing one root span: the root, then its children. */
const FAMILY_SIZE = FAMILY_KINDS.length;

/** How many distinct trace ids {@link seedPlanFixture} spreads its families over. */
const FIXTURE_TRACES = 40;

/** How many distinct request keys {@link seedPlanFixture} spreads its requests over. */
const FIXTURE_REQUEST_KEYS = 8;

/** The keys of {@link SESSION_A}'s data that the plan cases look up. */
interface PlanFixture {
  /** A child span of {@link SESSION_A}. */
  readonly spanId: string;

  /** A root span of {@link SESSION_A}, parent of `FAMILY_SIZE - 1` children. */
  readonly parentSpanId: string;

  /** A trace of {@link SESSION_A}, recorded under {@link CAPTURE_A1}. */
  readonly traceId: string;

  /** A request key {@link SESSION_A} holds many occurrences of. */
  readonly requestKey: string;

  /** Three event ids of {@link SESSION_A}: an `IN` list of several values. */
  readonly eventIds: readonly string[];

  /** Two trace ids of {@link SESSION_A} and one no session holds. */
  readonly traceIds: readonly string[];
}

/**
 * The element of a fixture list at `index`, wrapping around its end.
 *
 * @param items A non-empty list.
 * @param index Any non-negative integer.
 * @returns The element.
 * @throws When the list is empty, which is a defect in the fixture itself.
 */
function cycle<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length];

  if (item === undefined) {
    throw new Error('A plan fixture list must not be empty.');
  }

  return item;
}

/**
 * Stores {@link PLAN_FIXTURE_EVENTS} events in families of {@link FAMILY_SIZE}.
 *
 * Every fourth family belongs to {@link SESSION_B}; the rest alternate between
 * the two captures of {@link SESSION_A}. A family shares one trace and has the
 * kinds {@link FAMILY_KINDS} lists. Because {@link FIXTURE_TRACES} and
 * {@link FIXTURE_REQUEST_KEYS} are multiples of four, every trace and every
 * request key belongs to exactly one session and one capture, and the keys
 * the cases look up all come from family 0: {@link SESSION_A},
 * {@link CAPTURE_A1}.
 *
 * @returns The keys the plan cases look up.
 */
function seedPlanFixture(): PlanFixture {
  const traces = Array.from({ length: FIXTURE_TRACES }, () => newTraceId());
  const requestKeys = Array.from({ length: FIXTURE_REQUEST_KEYS }, (_unused, index) =>
    index.toString(16).padStart(2, '0').repeat(32),
  );
  const events: PersistableTelemetryEvent[] = [];
  let rootSpanId = '';

  for (let index = 0; index < PLAN_FIXTURE_EVENTS; index += 1) {
    const family = Math.floor(index / FAMILY_SIZE);
    const isRoot = index % FAMILY_SIZE === 0;
    const inSessionB = family % 4 === 3;
    const kind = cycle(FAMILY_KINDS, index);
    const spanId = newSpanId();

    if (isRoot) {
      rootSpanId = spanId;
    }

    events.push(
      buildEvent({
        sessionId: inSessionB ? SESSION_B : SESSION_A,
        captureId: inSessionB ? CAPTURE_B1 : family % 2 === 0 ? CAPTURE_A1 : CAPTURE_A2,
        traceId: cycle(traces, family),
        spanId,
        ...(isRoot ? {} : { parentSpanId: rootSpanId }),
        kind,
        startTime: BASE_TIME + index,
        duration: 1 + (index % 7),
        attributes: kind === 'fetch' ? { [REQUEST_KEY_ATTRIBUTE]: cycle(requestKeys, family) } : {},
      }),
    );
  }

  insertOk(events);

  // Family 0: session A, capture A1, the first trace and the first request key.
  const root = cycle(events, 0);
  const request = cycle(events, 1);
  const child = cycle(events, 2);

  return {
    spanId: child.spanId,
    parentSpanId: root.spanId,
    traceId: cycle(traces, 0),
    requestKey: cycle(requestKeys, 0),
    eventIds: [root.id, request.id, child.id],
    traceIds: [cycle(traces, 0), cycle(traces, 1), newTraceId()],
  };
}

/**
 * A store handle that records the text of every statement prepared through it
 * and is otherwise the real store.
 *
 * A `Proxy` rather than a hand-written wrapper, so every other member — the
 * transaction helper and the `db`, `schemaVersion` and `isClosed` getters
 * among them — is the real one without being restated. Reads and calls use the
 * real store as the receiver: its state lives in private class fields, which a
 * getter or method invoked on the proxy itself could not reach.
 *
 * @param real The suite's store.
 * @param texts Receives each statement text, in the order it was prepared.
 * @returns The recording handle.
 */
function recordingStore(real: Store, texts: string[]): Store {
  const statement: Store['statement'] = (sql) => {
    texts.push(sql);

    return real.statement(sql);
  };

  return new Proxy(real, {
    get(target, property): unknown {
      if (property === 'statement') {
        return statement;
      }

      const value: unknown = Reflect.get(target, property, target);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Whether a recorded statement text is a read of the telemetry table. */
function isTelemetrySelect(sql: string): boolean {
  return /^\s*SELECT\b/u.test(sql) && sql.includes('FROM telemetry_events');
}

/**
 * Runs one read through a repository over a {@link recordingStore} and returns
 * every telemetry read it prepared, in order.
 *
 * @param read The reader call.
 * @returns The statement texts the repository actually ran.
 */
function statementsRunBy(
  read: (reader: TelemetryRepo) => Result<unknown, DebuggenError>,
): string[] {
  const texts: string[] = [];
  const result = read(createTelemetryRepo({ store: recordingStore(store, texts) }));

  if (isErr(result)) {
    throw new Error(`A plan case expected its read to succeed: ${result.error.code}`);
  }

  return texts.filter(isTelemetrySelect);
}

describe('the index each reader is answered from', () => {
  /** What the plan of one statement a reader runs must show. */
  interface StatementExpectation {
    /** The indexes the statement may be read from; its plan must name one. */
    readonly from: readonly string[];

    /** Whether the plan must also need no temporary B-tree: the index yields the order. */
    readonly sortFree?: boolean;
  }

  /** One reader call and the plan of each statement it runs, in order. */
  interface ReaderCase {
    readonly reader: string;
    readonly read: (reader: TelemetryRepo, fixture: PlanFixture) => Result<unknown, DebuggenError>;
    readonly statements: readonly StatementExpectation[];
  }

  /**
   * Every reader whose plan the residual session term or a schema-version-3
   * index decides, plus the default capture page, which must keep its own
   * index.
   *
   * A `kinds` filter naming several kinds is absent on purpose: no index yields
   * the start order across several kind ranges, so it keeps the planner's
   * ordered session read (see `./migrations.ts`, schema version 3).
   */
  const READER_CASES: readonly ReaderCase[] = [
    {
      reader: 'getBySpanId',
      read: (reader, fixture) => reader.getBySpanId(SESSION_A, fixture.spanId),
      statements: [{ from: [SPAN_INDEX] }, { from: [SPAN_INDEX] }],
    },
    {
      reader: 'listChildren',
      read: (reader, fixture) => reader.listChildren(SESSION_A, fixture.parentSpanId),
      statements: [{ from: [PARENT_SPAN_INDEX] }, { from: [PARENT_SPAN_INDEX] }],
    },
    {
      reader: 'listByTrace',
      read: (reader, fixture) => reader.listByTrace(SESSION_A, fixture.traceId),
      statements: [{ from: [TRACE_INDEX] }, { from: [TRACE_INDEX] }],
    },
    {
      reader: 'listByTrace narrowed to one capture',
      read: (reader, fixture) =>
        reader.listByTrace(SESSION_A, fixture.traceId, { captureId: CAPTURE_A1 }),
      statements: [{ from: [TRACE_INDEX] }, { from: [TRACE_INDEX] }],
    },
    {
      reader: 'queryGroups narrowed to one trace',
      read: (reader, fixture) =>
        reader.queryGroups({ sessionId: SESSION_A, traceId: fixture.traceId, groupBy: 'name' }),
      statements: [{ from: [TRACE_INDEX] }],
    },
    {
      reader: 'listByRequestKey',
      read: (reader, fixture) => reader.listByRequestKey(SESSION_A, fixture.requestKey),
      statements: [
        { from: [REQUEST_KEY_INDEX, REQUEST_KEY_ORDER_INDEX] },
        { from: [REQUEST_KEY_ORDER_INDEX], sortFree: true },
      ],
    },
    {
      // The panel-data order ends in `id`, which the request-group composite
      // does not carry, so its last term is sorted — over one group's rows,
      // never over the whole capture the capture index would walk.
      reader: 'query narrowed to one request group of one capture',
      read: (reader, fixture) =>
        reader.query({
          sessionId: SESSION_A,
          captureId: CAPTURE_A1,
          requestKey: fixture.requestKey,
        }),
      statements: [
        { from: [REQUEST_KEY_INDEX, REQUEST_KEY_ORDER_INDEX] },
        { from: [REQUEST_KEY_ORDER_INDEX] },
      ],
    },
    {
      reader: 'query narrowed to one kind',
      read: (reader) => reader.query({ sessionId: SESSION_A, kinds: ['fetch'] }),
      statements: [
        { from: [KIND_INDEX, KIND_ORDER_INDEX] },
        { from: [KIND_ORDER_INDEX], sortFree: true },
      ],
    },
    {
      reader: 'query narrowed to one kind of one capture',
      read: (reader) =>
        reader.query({ sessionId: SESSION_A, captureId: CAPTURE_A1, kinds: ['fetch'] }),
      statements: [
        { from: [KIND_INDEX, KIND_ORDER_INDEX] },
        { from: [KIND_ORDER_INDEX], sortFree: true },
      ],
    },
    {
      reader: 'query for the default page of one capture',
      read: (reader) => reader.query({ sessionId: SESSION_A, captureId: CAPTURE_A1 }),
      statements: [{ from: [CAPTURE_INDEX] }, { from: [CAPTURE_INDEX] }],
    },
    {
      reader: 'existingEventIds',
      read: (reader, fixture) => reader.existingEventIds(SESSION_A, fixture.eventIds),
      statements: [{ from: [EVENT_ID_INDEX] }],
    },
    {
      reader: 'existingEventIds narrowed to one capture',
      read: (reader, fixture) => reader.existingEventIds(SESSION_A, fixture.eventIds, CAPTURE_A1),
      statements: [{ from: [EVENT_ID_INDEX] }],
    },
    {
      reader: 'existingTraceIds',
      read: (reader, fixture) => reader.existingTraceIds(SESSION_A, fixture.traceIds),
      statements: [{ from: [TRACE_INDEX] }],
    },
    {
      reader: 'existingTraceIds narrowed to one capture',
      read: (reader, fixture) => reader.existingTraceIds(SESSION_A, fixture.traceIds, CAPTURE_A1),
      statements: [{ from: [TRACE_INDEX] }],
    },
  ];

  it.each(READER_CASES)(
    'plans every statement $reader runs on its own index, never on a walk of the session',
    ({ read, statements }) => {
      const fixture = seedPlanFixture();
      const selects = statementsRunBy((reader) => read(reader, fixture));

      expect(selects).toHaveLength(statements.length);

      for (const [position, expected] of statements.entries()) {
        const sql = selects[position];

        if (sql === undefined) {
          throw new Error(`The reader ran no statement at position ${String(position)}.`);
        }

        // The plan of the exact text the repository prepared, not of a copy.
        const plan = queryPlan(sql).join(' | ');

        expect(plan).toMatch(
          new RegExp(
            `SEARCH telemetry_events USING (?:COVERING )?INDEX (?:${expected.from.join('|')}) \\(`,
            'u',
          ),
        );
        expect(plan).not.toContain(SESSION_PURGE_INDEX);
        expect(plan).not.toContain('SCAN telemetry_events');

        if (expected.sortFree === true) {
          expect(plan).not.toContain('TEMP B-TREE');
        }
      }
    },
  );

  it('keeps a lookup answered from a global index inside its own session', () => {
    const traceId = newTraceId();
    const rootSpanId = newSpanId();
    const childSpanId = newSpanId();

    /** One root and one child, under ids the other session holds too. */
    function family(
      sessionId: string,
      captureId: string,
      startTime: number,
    ): readonly [PersistableTelemetryEvent, PersistableTelemetryEvent] {
      return [
        buildEvent({
          sessionId,
          captureId,
          traceId,
          spanId: rootSpanId,
          kind: 'interaction',
          startTime,
        }),
        buildEvent({
          sessionId,
          captureId,
          traceId,
          spanId: childSpanId,
          parentSpanId: rootSpanId,
          startTime: startTime + 1,
        }),
      ];
    }

    // Session B's copies start first, so a read that lost its session scope
    // would return them ahead of session A's.
    const inB = family(SESSION_B, CAPTURE_B1, BASE_TIME);
    const inA = family(SESSION_A, CAPTURE_A1, BASE_TIME + 10);
    const everyId = [...inA, ...inB].map((event) => event.id);

    insertOk([...inB, ...inA]);

    for (const [sessionId, captureId, [root, child]] of [
      [SESSION_A, CAPTURE_A1, inA],
      [SESSION_B, CAPTURE_B1, inB],
    ] as const) {
      expect(unwrap(repo.getBySpanId(sessionId, rootSpanId))?.id).toBe(root.id);
      expect(unwrap(repo.getBySpanId(sessionId, childSpanId))?.id).toBe(child.id);
      expect(
        unwrap(repo.listChildren(sessionId, rootSpanId)).rows.map((event) => event.id),
      ).toEqual([child.id]);

      const trace = unwrap(repo.listByTrace(sessionId, traceId));

      expect(trace.rows.map((event) => event.id)).toEqual([root.id, child.id]);
      expect(trace.total).toBe(2);
      expect(unwrap(repo.listByTrace(sessionId, traceId, { captureId })).total).toBe(2);
      expect([...unwrap(repo.existingTraceIds(sessionId, [traceId]))]).toEqual([traceId]);
      expect([...unwrap(repo.existingTraceIds(sessionId, [traceId], captureId))]).toEqual([
        traceId,
      ]);
      expect([...unwrap(repo.existingEventIds(sessionId, everyId))].sort()).toEqual(
        [root.id, child.id].sort(),
      );
    }

    // Another session's capture narrows a shared trace to nothing.
    expect(unwrap(repo.listByTrace(SESSION_A, traceId, { captureId: CAPTURE_B1 })).total).toBe(0);
    expect(unwrap(repo.existingTraceIds(SESSION_A, [traceId], CAPTURE_B1)).size).toBe(0);
  });

  it('keeps a request-group read inside its capture when the capture is a residual filter', () => {
    const requestKey = 'c4'.repeat(32);
    const occurrence = (captureId: string, startTime: number): PersistableTelemetryEvent =>
      buildEvent({ captureId, startTime, attributes: { [REQUEST_KEY_ATTRIBUTE]: requestKey } });

    // The same request in both captures of one session, the second capture's
    // occurrence first, so a read that dropped the capture narrowing would
    // return it ahead of the first capture's.
    const inA2 = occurrence(CAPTURE_A2, BASE_TIME);
    const inA1 = [occurrence(CAPTURE_A1, BASE_TIME + 5), occurrence(CAPTURE_A1, BASE_TIME + 6)];

    insertOk([inA2, ...inA1]);

    const narrowed = unwrap(
      repo.query({ sessionId: SESSION_A, captureId: CAPTURE_A1, requestKey }),
    );

    expect(narrowed.rows.map((event) => event.id)).toEqual(inA1.map((event) => event.id));
    expect(narrowed.total).toBe(2);
    expect(
      unwrap(repo.listByRequestKey(SESSION_A, requestKey, { captureId: CAPTURE_A2 })).rows.map(
        (event) => event.id,
      ),
    ).toEqual([inA2.id]);
    expect(
      unwrap(repo.query({ sessionId: SESSION_A, captureId: CAPTURE_B1, requestKey })).total,
    ).toBe(0);
    expect(unwrap(repo.listByRequestKey(SESSION_A, requestKey)).total).toBe(3);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Schema version 3
 * ---------------------------------------------------------------------------------------------- */

describe('schema version 3', () => {
  /** The two indexes version 3 adds, each with its key columns in order. */
  const VERSION_3_INDEXES = [
    [KIND_ORDER_INDEX, ['session_id', 'kind', 'start_time', 'id']],
    [REQUEST_KEY_ORDER_INDEX, ['session_id', 'request_key', 'start_time', 'producer_id', 'seq']],
  ] as const;

  /** A logger whose records land in the suite's `logs`. */
  function collectingLogger(): ReturnType<typeof createConsoleLogger> {
    return createConsoleLogger({
      level: 'trace',
      sink: (record) => {
        logs.push(record);
      },
    });
  }

  /** The key columns of one index, in order, or `[]` when it does not exist. */
  function indexColumns(db: DatabaseSync, index: string): string[] {
    return db
      .prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
      .all(index)
      .map((row) => String(row['name']));
  }

  /** Every telemetry row, in arrival order, as stored. */
  function telemetryRows(db: DatabaseSync): Record<string, unknown>[] {
    return db.prepare('SELECT * FROM telemetry_events ORDER BY ingest_seq').all();
  }

  /**
   * Everything a reopen could change: the header version, every schema object,
   * every bookkeeping row (`updated_at` among them) and every telemetry row.
   */
  function storeSnapshot(db: DatabaseSync): unknown {
    return {
      userVersion: db.prepare('PRAGMA user_version').get()?.['user_version'],
      objects: db
        .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
        .all(),
      meta: db.prepare('SELECT key, value FROM meta ORDER BY key').all(),
      telemetry: telemetryRows(db),
    };
  }

  it('stamps a new store at the current version, with both lookup indexes', () => {
    expect(STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);

    for (const [index, columns] of VERSION_3_INDEXES) {
      expect(indexColumns(store.db, index)).toEqual(columns);
    }
  });

  it('migrates a version-2 store forward, adding both indexes and keeping every row', () => {
    const fixture = seedPlanFixture();
    const databasePath = store.path;
    const rowsBefore = telemetryRows(store.db);

    store.close();

    // Turn the file back into what a version-2 build left behind: stamped 2,
    // with neither version-3 index.
    const legacy = new DatabaseSync(databasePath);

    try {
      for (const [index] of VERSION_3_INDEXES) {
        legacy.exec(`DROP INDEX ${index}`);
      }

      legacy.exec('PRAGMA user_version = 2');

      for (const [index] of VERSION_3_INDEXES) {
        expect(indexColumns(legacy, index)).toEqual([]);
      }
    } finally {
      legacy.close();
    }

    // Only the reopen's records from here on: creating the store in
    // `beforeEach` already logged every rung once.
    logs.length = 0;

    const logger = collectingLogger();

    store = unwrap(openStore({ databasePath, logger }));
    repo = createTelemetryRepo({ store, logger });

    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(store.db.prepare('PRAGMA user_version').get()?.['user_version']).toBe(
      STORE_SCHEMA_VERSION,
    );
    expect(
      store.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.['value'],
    ).toBe(String(STORE_SCHEMA_VERSION));

    for (const [index, columns] of VERSION_3_INDEXES) {
      expect(
        store.db
          .prepare(`SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?`)
          .get(index)?.['tbl_name'],
      ).toBe('telemetry_events');
      expect(indexColumns(store.db, index)).toEqual(columns);
    }

    expect(telemetryRows(store.db)).toEqual(rowsBefore);

    // Every rung above version 2 ran once, lowest first: version 3 leads.
    const applied = logs.filter((record) => record.message.startsWith('applied store migration'));

    expect(applied).toHaveLength(STORE_SCHEMA_VERSION - 2);
    expect(applied[0]?.message).toMatch(/^applied store migration 3 \(/u);

    // The migrated store answers from what the step added.
    const statements = statementsRunBy((reader) =>
      reader.listByRequestKey(SESSION_A, fixture.requestKey),
    );
    const rows = statements.at(-1);

    expect(statements).toHaveLength(2);

    if (rows === undefined) {
      throw new Error('listByRequestKey ran no row statement.');
    }

    expect(queryPlan(rows).join(' | ')).toContain(`USING INDEX ${REQUEST_KEY_ORDER_INDEX} (`);
    expect(unwrap(repo.listByRequestKey(SESSION_A, fixture.requestKey)).total).toBeGreaterThan(0);
  });

  it('reopens a store already at the current version without changing anything', () => {
    seedPlanFixture();

    const databasePath = store.path;
    const before = storeSnapshot(store.db);

    store.close();
    logs.length = 0;

    const logger = collectingLogger();

    store = unwrap(openStore({ databasePath, logger }));
    repo = createTelemetryRepo({ store, logger });

    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(storeSnapshot(store.db)).toEqual(before);
    expect(logs.some((record) => record.message.startsWith('applied store migration'))).toBe(false);
  });
});
