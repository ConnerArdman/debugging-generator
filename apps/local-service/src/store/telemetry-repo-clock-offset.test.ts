/**
 * Tests for the per-producer clock offset in the session store: schema version
 * 4 of `./migrations.ts`, the `clock_offset_ms` projection written by
 * `./telemetry-repo.ts` and its `listProducerClockOffsets` read.
 *
 * AAP 0.2.3 applies no clock alignment between tiers "beyond a recorded
 * per-producer `clockOffsetMs` (server `Date` header versus local clock,
 * informational)". Each producer stamps its estimate on the events it creates;
 * what is on trial here is the store's half of that promise:
 *
 * 1. **The column exists, and only additively.** A new store carries a
 *    nullable, bounded `clock_offset_ms`; a store a version-4 build left behind
 *    gains it without a single row being rewritten; a direct write the bound
 *    refuses is refused by the database itself.
 * 2. **The value round-trips unchanged.** The offset lands in the column and in
 *    the authoritative `event` document exactly as the producer stamped it, and
 *    every read returns it untouched — as it returns `startTime` and `duration`
 *    untouched: nothing adds one to the other.
 * 3. **Replay semantics hold.** An identical replay, offset included, is
 *    skipped; the same id with a different offset is an `event-id-conflict`.
 * 4. **The diagnostic answers per producer.** `listProducerClockOffsets`
 *    reports the latest, smallest and largest offset, the reporting count and
 *    the tiers of each `(capture, producer)`, in arrival order, with the same
 *    refusals and the same unknown-session answer as every other session read.
 *
 * The store is the real one — `openStore` against an `mkdtemp` sandbox on
 * disk, parent rows written through `./sessions-repo.ts` — and every fixture
 * event is validated by `@debuggen/telemetry`'s own `parseTelemetryEvent`.
 * Nothing under `$DEBUGGEN_HOME` is touched and no socket is opened.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionRecord } from '@debuggen/protocol';
import {
  createConsoleLogger,
  isErr,
  newCaptureId,
  newEventId,
  newProducerId,
  newSessionId,
  newSpanId,
  newTraceId,
  noopLogger,
  unwrap,
} from '@debuggen/shared';
import type { DebuggenError, LogRecord, Result } from '@debuggen/shared';
import {
  CLOCK_OFFSET_BOUND_MS,
  TELEMETRY_TIERS,
  allowedTiersFor,
  parseTelemetryEvent,
} from '@debuggen/telemetry';
import type { TelemetryEvent, TelemetryKind, TelemetryTier } from '@debuggen/telemetry';

import { openStore } from './db.js';
import type { Store } from './db.js';
import { STORE_MIGRATIONS, STORE_SCHEMA_VERSION } from './migrations.js';
import { createSessionsRepo } from './sessions-repo.js';
import { MAX_PRODUCER_CLOCK_OFFSETS, createTelemetryRepo } from './telemetry-repo.js';
import type {
  PersistableTelemetryEvent,
  ProducerClockOffset,
  TelemetryRepo,
} from './telemetry-repo.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The session most cases work in. */
const SESSION_A = newSessionId();

/** A second session, for the scoping assertions. */
const SESSION_B = newSessionId();

/** The first capture of {@link SESSION_A}, closed before the second opens. */
const CAPTURE_A1 = newCaptureId();

/** The second capture of {@link SESSION_A}. */
const CAPTURE_A2 = newCaptureId();

/** The capture of {@link SESSION_B}. */
const CAPTURE_B1 = newCaptureId();

/** A page document's browser agent. */
const PRODUCER_PAGE = newProducerId();

/** A dev server's Node preload, which reports server and database spans. */
const PRODUCER_SERVER = newProducerId();

/** A producer that never reports an offset. */
const PRODUCER_QUIET = newProducerId();

/** An epoch-millisecond base inside the schema's accepted window. */
const BASE_TIME = 1_767_225_600_000;

/** The name of the column schema version 5 adds. */
const COLUMN = 'clock_offset_ms';

/** The description the version-4 ladder step logs and reports. */
const VERSION_5_DESCRIPTION = 'record the per-producer clock offset each telemetry event reports';

/** The SQLite extended result code of a `CHECK` constraint failure. */
const SQLITE_CONSTRAINT_CHECK = 275;

/** The sandbox directory holding the database for one case. */
let directory: string;

/** The store under the repository. */
let store: Store;

/** Every log record the store or the repository emitted. */
let logs: LogRecord[];

/** The repository under test. */
let repo: TelemetryRepo;

/** Per-producer, per-capture sequence counters. */
let sequences: Map<string, number>;

/** The next `seq` for one producer within one capture. */
function nextSeq(producerId: string, captureId: string): number {
  const key = `${captureId}:${producerId}`;
  const next = sequences.get(key) ?? 0;

  sequences.set(key, next + 1);

  return next;
}

/** A logger whose records land in {@link logs}. */
function collectingLogger(): ReturnType<typeof createConsoleLogger> {
  return createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      logs.push(record);
    },
  });
}

/** A new session's record, minimal and valid, as the session manager persists it. */
function sessionRecord(sessionId: string): SessionRecord {
  return {
    id: sessionId,
    projectRoot: '/home/dev/projects/example',
    projectName: 'example',
    devServerUrl: 'http://127.0.0.1:20301',
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

/** Seeds the parent rows every telemetry foreign key requires, through the sessions repository. */
function seedParents(): void {
  const sessions = createSessionsRepo({ store, now: () => BASE_TIME });

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
  readonly kind?: TelemetryKind;
  readonly tier?: TelemetryTier;
  readonly startTime?: number;
  readonly duration?: number;
  readonly producerId?: string;
  readonly clockOffsetMs?: number;
}

/**
 * A storable candidate, **not** validated: the tier defaults to the first one
 * the kind is allowed in, and `clockOffsetMs` is present only when given.
 */
function draftEvent(overrides: EventOverrides = {}): PersistableTelemetryEvent {
  const kind = overrides.kind ?? 'interaction';
  const tier = overrides.tier ?? allowedTiersFor(kind)[0] ?? 'browser';
  const producerId = overrides.producerId ?? PRODUCER_PAGE;
  const captureId = overrides.captureId ?? CAPTURE_A1;

  return {
    id: overrides.id ?? newEventId(),
    sessionId: overrides.sessionId ?? SESSION_A,
    captureId,
    traceId: newTraceId(),
    spanId: newSpanId(),
    kind,
    tier,
    name: 'operation',
    startTime: overrides.startTime ?? BASE_TIME,
    duration: overrides.duration ?? 1,
    attributes: {},
    status: 'ok',
    producerId,
    seq: nextSeq(producerId, captureId),
    ...(overrides.clockOffsetMs === undefined ? {} : { clockOffsetMs: overrides.clockOffsetMs }),
  };
}

/** {@link draftEvent}, proven valid against the persisted schema before a case sees it. */
function buildEvent(overrides: EventOverrides = {}): PersistableTelemetryEvent {
  const draft = draftEvent(overrides);
  const parsed = parseTelemetryEvent({ ...draft, ingestSeq: 1 });

  if (isErr(parsed)) {
    throw new Error(`the fixture builder produced an invalid event: ${parsed.error.message}`);
  }

  return draft;
}

/** Stores events and fails the case if the repository refused them. */
function insertOk(events: readonly PersistableTelemetryEvent[]): TelemetryEvent[] {
  const written = repo.insertMany(events);

  if (isErr(written)) {
    throw new Error(
      `insertMany refused a batch the case expected to succeed: ${written.error.code}`,
    );
  }

  return written.value.events;
}

/** One stored row as raw columns. */
function readRow(id: string): Record<string, unknown> | undefined {
  return store.statement('SELECT * FROM telemetry_events WHERE id = ?').get(id);
}

/** The parsed `event` document of one stored row. */
function storedDocument(id: string): Record<string, unknown> {
  const document = readRow(id)?.['event'];

  if (typeof document !== 'string') {
    throw new Error(`no stored document for ${id}`);
  }

  return JSON.parse(document) as Record<string, unknown>;
}

/** The column `clock_offset_ms` as `pragma_table_info` describes it, if it exists. */
function offsetColumn(db: DatabaseSync): Record<string, unknown> | undefined {
  return db
    .prepare(`SELECT * FROM pragma_table_info('telemetry_events') WHERE name = ?`)
    .get(COLUMN);
}

/** Every telemetry row, in arrival order, as stored. */
function telemetryRows(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM telemetry_events ORDER BY ingest_seq').all();
}

/** The error of an `Err` result; fails the case otherwise. */
function expectError<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (!isErr(result)) {
    throw new Error('expected a refusal, got a value');
  }

  return result.error;
}

/** The arrival number of a stored event; fails the case when it has none. */
function seqOf(event: TelemetryEvent | undefined): number {
  if (event === undefined) {
    throw new Error('expected a stored event');
  }

  return event.ingestSeq;
}

/**
 * Inserts one raw row past the repository, as a writer that bypassed it would.
 *
 * @param offset The value bound to `clock_offset_ms`.
 */
function insertRaw(offset: number | null): void {
  store
    .statement(
      `INSERT INTO telemetry_events (id, session_id, capture_id, trace_id, span_id, kind, tier, name, start_time, duration, producer_id, seq, ${COLUMN}, event)
       VALUES (?, ?, ?, ?, ?, 'interaction', 'browser', 'operation', ?, 1, ?, 0, ?, '{}')`,
    )
    .run(
      newEventId(),
      SESSION_A,
      CAPTURE_A1,
      newTraceId(),
      newSpanId(),
      BASE_TIME,
      PRODUCER_QUIET,
      offset,
    );
}

/** The SQLite extended result code a thrown error carries. */
function errcodeOf(action: () => void): number | undefined {
  try {
    action();
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'errcode' in cause) {
      const { errcode } = cause;

      return typeof errcode === 'number' ? errcode : undefined;
    }

    throw cause;
  }

  return undefined;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'debuggen-clock-offset-'));
  logs = [];
  sequences = new Map();

  const logger = collectingLogger();

  store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite'), logger }));
  repo = createTelemetryRepo({ store, logger });
  seedParents();
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------------------------------
 * Schema version 5
 * ---------------------------------------------------------------------------------------------- */

describe('schema version 5: telemetry_events.clock_offset_ms', () => {
  it('declares the step on the ladder and stamps a new store at the current version', () => {
    const step = STORE_MIGRATIONS.find((candidate) => candidate.version === 5);

    expect(STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    expect(step?.description).toBe(VERSION_5_DESCRIPTION);
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
  });

  it('gives a new store a nullable INTEGER column with no default and no index', () => {
    const column = offsetColumn(store.db);

    expect(column).toBeDefined();
    expect(column?.['type']).toBe('INTEGER');
    expect(column?.['notnull']).toBe(0);
    expect(column?.['dflt_value']).toBeNull();
    expect(column?.['pk']).toBe(0);

    // No index names the column: the ingest path pays for every index.
    const indexes = store.db
      .prepare(`SELECT name FROM pragma_index_list('telemetry_events')`)
      .all()
      .map((row) => String(row['name']));

    expect(indexes.length).toBeGreaterThan(0);

    for (const index of indexes) {
      const columns = store.db
        .prepare('SELECT name FROM pragma_index_info(?)')
        .all(index)
        .map((row) => row['name']);

      expect(columns).not.toContain(COLUMN);
    }
  });

  it('bounds the column with a CHECK built from CLOCK_OFFSET_BOUND_MS', () => {
    // The DDL of the table the live store created, after every migration ran.
    const ddl = String(
      store.db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('telemetry_events')?.['sql'],
    );
    const match = /CHECK\s*\(\s*clock_offset_ms\s+BETWEEN\s+(-?\d+)\s+AND\s+(-?\d+)\s*\)/iu.exec(
      ddl,
    );

    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(-CLOCK_OFFSET_BOUND_MS);
    expect(Number(match?.[2])).toBe(CLOCK_OFFSET_BOUND_MS);
  });

  it('has the database itself refuse an offset outside the bound, and a fractional one', () => {
    // Past the repository's validation on purpose: the constraint is the last
    // line for a row written by any other path.
    expect(errcodeOf(() => insertRaw(CLOCK_OFFSET_BOUND_MS + 1))).toBe(SQLITE_CONSTRAINT_CHECK);
    expect(errcodeOf(() => insertRaw(-CLOCK_OFFSET_BOUND_MS - 1))).toBe(SQLITE_CONSTRAINT_CHECK);
    expect(() => {
      insertRaw(1.5);
    }).toThrow();

    // The bound itself, zero and NULL are all storable.
    expect(errcodeOf(() => insertRaw(CLOCK_OFFSET_BOUND_MS))).toBeUndefined();
    expect(errcodeOf(() => insertRaw(-CLOCK_OFFSET_BOUND_MS))).toBeUndefined();
    expect(errcodeOf(() => insertRaw(0))).toBeUndefined();
    expect(errcodeOf(() => insertRaw(null))).toBeUndefined();
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(4);
  });

  it('is idempotent: the step leaves a table that already has the column untouched', () => {
    const step = STORE_MIGRATIONS.find((candidate) => candidate.version === 5);

    if (step === undefined) {
      throw new Error('the ladder has no version-4 step');
    }

    const before = store.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get('telemetry_events');

    step.apply(store.db, { ddl: '', logger: noopLogger, now: () => BASE_TIME });

    expect(
      store.db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('telemetry_events'),
    ).toEqual(before);
  });

  it('migrates a version-4 store forward, keeping every row with a NULL offset', () => {
    const legacyEvents = insertOk([
      buildEvent({ startTime: BASE_TIME + 0.125, duration: 12.5 }),
      buildEvent({ kind: 'http.server', producerId: PRODUCER_SERVER }),
      buildEvent({ kind: 'db.query', producerId: PRODUCER_SERVER }),
    ]);
    const databasePath = store.path;

    store.close();

    // Turn the file back into what a version-4 build left behind: stamped 4,
    // with no clock_offset_ms column, every row intact.
    const legacy = new DatabaseSync(databasePath);
    let rowsBefore: Record<string, unknown>[];

    try {
      legacy.exec(`ALTER TABLE telemetry_events DROP COLUMN ${COLUMN}`);
      legacy.exec('PRAGMA user_version = 4');

      expect(offsetColumn(legacy)).toBeUndefined();

      rowsBefore = telemetryRows(legacy);
    } finally {
      legacy.close();
    }

    expect(rowsBefore).toHaveLength(legacyEvents.length);

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
    expect(offsetColumn(store.db)?.['type']).toBe('INTEGER');

    // Every rung above version 4 ran once, lowest first: version 5 leads.
    const applied = logs.filter((record) => record.message.startsWith('applied store migration'));

    expect(applied).toHaveLength(STORE_SCHEMA_VERSION - 4);
    expect(applied[0]?.message).toBe(`applied store migration 5 (${VERSION_5_DESCRIPTION})`);

    // No row rewritten: every pre-existing column is as it was, and the new
    // one reads NULL for all of them.
    const rowsAfter = telemetryRows(store.db);

    expect(rowsAfter.map((row) => row[COLUMN])).toEqual(rowsBefore.map(() => null));
    expect(
      rowsAfter.map((row) => {
        const copy: Record<string, unknown> = { ...row };

        Reflect.deleteProperty(copy, COLUMN);

        return copy;
      }),
    ).toEqual(rowsBefore);

    // The legacy rows read back unchanged and report no offset.
    const reread = [...unwrap(repo.listByCapture(SESSION_A, CAPTURE_A1)).rows].sort(
      (left, right) => left.ingestSeq - right.ingestSeq,
    );

    expect(reread).toEqual(legacyEvents);
    expect(reread.some((event) => Object.hasOwn(event, 'clockOffsetMs'))).toBe(false);
    expect(unwrap(repo.listProducerClockOffsets(SESSION_A))).toEqual([]);

    // And the migrated store takes offsets from here on.
    const [reporting] = insertOk([buildEvent({ clockOffsetMs: -275 })]);

    expect(readRow(reporting?.id ?? '')?.[COLUMN]).toBe(-275);
    expect(unwrap(repo.listProducerClockOffsets(SESSION_A))).toEqual([
      {
        captureId: CAPTURE_A1,
        producerId: PRODUCER_PAGE,
        tiers: ['browser'],
        clockOffsetMs: -275,
        minClockOffsetMs: -275,
        maxClockOffsetMs: -275,
        reportingEvents: 1,
        firstIngestSeq: seqOf(reporting),
        lastIngestSeq: seqOf(reporting),
      },
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The write and read paths
 * ---------------------------------------------------------------------------------------------- */

describe('clockOffsetMs on the write and read paths', () => {
  it('projects a reported offset into the column and keeps it in the document', () => {
    const offsets = [250, -1_750, 0, CLOCK_OFFSET_BOUND_MS, -CLOCK_OFFSET_BOUND_MS] as const;
    const reporting = offsets.map((clockOffsetMs) => buildEvent({ clockOffsetMs }));
    const silent = buildEvent();

    insertOk([...reporting, silent]);

    for (const [index, event] of reporting.entries()) {
      expect(readRow(event.id)?.[COLUMN]).toBe(offsets[index]);
      expect(storedDocument(event.id)['clockOffsetMs']).toBe(offsets[index]);
    }

    expect(readRow(silent.id)?.[COLUMN]).toBeNull();
    expect(Object.hasOwn(storedDocument(silent.id), 'clockOffsetMs')).toBe(false);
  });

  it('returns the offset, and the times beside it, unchanged from every read', () => {
    const startTime = BASE_TIME + 41.375;
    const duration = 7.625;
    const reporting = buildEvent({ clockOffsetMs: 1_234, startTime, duration });
    const silent = buildEvent({ startTime: startTime + 1 });
    const [stored] = insertOk([reporting, silent]);

    expect(stored?.clockOffsetMs).toBe(1_234);
    expect(stored?.startTime).toBe(startTime);
    expect(stored?.duration).toBe(duration);

    const byCapture = unwrap(repo.listByCapture(SESSION_A, CAPTURE_A1)).rows;
    const byQuery = unwrap(repo.query({ sessionId: SESSION_A })).rows;
    const bySpan = unwrap(repo.getBySpanId(SESSION_A, reporting.spanId));
    const byTrace = unwrap(repo.listByTrace(SESSION_A, reporting.traceId)).rows;

    for (const read of [byCapture[0], byQuery[0], bySpan, byTrace[0]]) {
      expect(read?.id).toBe(reporting.id);
      expect(read?.clockOffsetMs).toBe(1_234);
      expect(read?.startTime).toBe(startTime);
      expect(read?.duration).toBe(duration);
    }

    const readSilent = byCapture.find((event) => event.id === silent.id);

    expect(readSilent).toBeDefined();
    expect(Object.hasOwn(readSilent ?? {}, 'clockOffsetMs')).toBe(false);
  });

  it.each([
    ['a fractional offset', 1.5],
    ['an offset beyond the bound', CLOCK_OFFSET_BOUND_MS + 1],
    ['an offset below the bound', -CLOCK_OFFSET_BOUND_MS - 1],
    ['a non-finite offset', Number.POSITIVE_INFINITY],
  ])('refuses %s as an invalid event and writes nothing of its batch', (_label, clockOffsetMs) => {
    const valid = buildEvent({ clockOffsetMs: 10 });
    const invalid = draftEvent({ clockOffsetMs });
    const error = expectError(repo.insertMany([valid, invalid]));

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.details?.['index']).toBe(1);
    expect(error.details?.['fields']).toContain('clockOffsetMs');
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(0);
  });

  it('classifies a column CHECK refusal on the write path without naming a value', () => {
    // A store whose bound is tighter than this build's — as a store written by
    // a build with another bound would be — refuses an offset the event schema
    // accepts. The refusal must still come back as a coded Result.
    store.db.exec(`ALTER TABLE telemetry_events DROP COLUMN ${COLUMN}`);
    store.db.exec(
      `ALTER TABLE telemetry_events ADD COLUMN ${COLUMN} INTEGER CHECK (${COLUMN} BETWEEN -10 AND 10)`,
    );

    const error = expectError(repo.insertMany([buildEvent({ clockOffsetMs: 4_321 })]));

    expect(error.code).toBe('STORE_ERROR');
    expect(error.details?.['reason']).toBe('column-check');
    expect(error.message).toContain('clock offset');
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
      '4321',
    );
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(0);
  });

  it('skips an identical replay, offset included, and reports the stored copy', () => {
    const event = buildEvent({ clockOffsetMs: -42 });
    const [first] = insertOk([event]);
    const replay = unwrap(repo.insertMany([event]));

    expect(replay.inserted).toBe(0);
    expect(replay.skipped).toBe(1);
    expect(replay.events).toEqual([first]);
    expect(unwrap(repo.countBySession(SESSION_A))).toBe(1);
    expect(readRow(event.id)?.[COLUMN]).toBe(-42);
  });

  it.each([
    ['a different offset', { clockOffsetMs: 43 }],
    ['no offset at all', {}],
  ])(
    'refuses the same id carrying %s as an event-id conflict naming clockOffsetMs',
    (_label, change) => {
      const event = buildEvent({ clockOffsetMs: -42 });

      insertOk([event]);

      const withoutOffset: Record<string, unknown> = { ...event };

      Reflect.deleteProperty(withoutOffset, 'clockOffsetMs');

      const changed = { ...withoutOffset, ...change } as PersistableTelemetryEvent;
      const error = expectError(repo.insertMany([changed]));

      expect(error.code).toBe('STORE_ERROR');
      expect(error.details?.['reason']).toBe('event-id-conflict');
      expect(error.details?.['fields']).toEqual(['clockOffsetMs']);
      expect(readRow(event.id)?.[COLUMN]).toBe(-42);
      expect(storedDocument(event.id)['clockOffsetMs']).toBe(-42);
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * listProducerClockOffsets
 * ---------------------------------------------------------------------------------------------- */

describe('listProducerClockOffsets', () => {
  /** The stored events of the three-batch fixture, by role. */
  interface ProducerFixture {
    readonly pageFirst: TelemetryEvent;
    readonly pageLatest: TelemetryEvent;
    readonly serverFirst: TelemetryEvent;
    readonly serverLatest: TelemetryEvent;
    readonly secondCapture: TelemetryEvent;
  }

  /**
   * Two producers of capture A1 reporting interleaved offsets over three
   * batches, a silent producer, a server event without an offset, the page
   * producer again in capture A2, and one producer of session B.
   *
   * The page producer's offsets arrive as 120, 80, 100, so its latest (100) is
   * neither its smallest nor its largest. The preload's first reporting event
   * is a database span, so tier order cannot come from arrival order.
   */
  function seedProducers(): ProducerFixture {
    const [pageFirst, serverFirst] = insertOk([
      buildEvent({ clockOffsetMs: 120 }),
      buildEvent({ kind: 'db.query', producerId: PRODUCER_SERVER, clockOffsetMs: -35 }),
      buildEvent({ producerId: PRODUCER_QUIET }),
    ]);
    const [serverLatest] = insertOk([
      buildEvent({ kind: 'http.server', producerId: PRODUCER_SERVER, clockOffsetMs: -40 }),
      buildEvent({ clockOffsetMs: 80 }),
    ]);
    const [pageLatest] = insertOk([
      buildEvent({ clockOffsetMs: 100 }),
      buildEvent({ kind: 'http.server', producerId: PRODUCER_SERVER }),
      buildEvent({ producerId: PRODUCER_QUIET }),
    ]);
    const [secondCapture] = insertOk([buildEvent({ captureId: CAPTURE_A2, clockOffsetMs: 9 })]);

    insertOk([
      buildEvent({
        sessionId: SESSION_B,
        captureId: CAPTURE_B1,
        producerId: newProducerId(),
        clockOffsetMs: 5_000,
      }),
    ]);

    if (
      pageFirst === undefined ||
      pageLatest === undefined ||
      serverFirst === undefined ||
      serverLatest === undefined ||
      secondCapture === undefined
    ) {
      throw new Error('the producer fixture stored fewer events than it wrote');
    }

    return { pageFirst, pageLatest, serverFirst, serverLatest, secondCapture };
  }

  /** The expected summaries of capture A1, in arrival order of each first report. */
  function captureA1Summaries(fixture: ProducerFixture): ProducerClockOffset[] {
    return [
      {
        captureId: CAPTURE_A1,
        producerId: PRODUCER_PAGE,
        tiers: ['browser'],
        clockOffsetMs: 100,
        minClockOffsetMs: 80,
        maxClockOffsetMs: 120,
        reportingEvents: 3,
        firstIngestSeq: fixture.pageFirst.ingestSeq,
        lastIngestSeq: fixture.pageLatest.ingestSeq,
      },
      {
        captureId: CAPTURE_A1,
        producerId: PRODUCER_SERVER,
        tiers: ['server', 'db'],
        clockOffsetMs: -40,
        minClockOffsetMs: -40,
        maxClockOffsetMs: -35,
        reportingEvents: 2,
        firstIngestSeq: fixture.serverFirst.ingestSeq,
        lastIngestSeq: fixture.serverLatest.ingestSeq,
      },
    ];
  }

  it('summarises each producer of each capture: latest, range, count and tiers, in arrival order', () => {
    const fixture = seedProducers();
    const summaries = unwrap(repo.listProducerClockOffsets(SESSION_A));

    expect(summaries).toEqual([
      ...captureA1Summaries(fixture),
      {
        captureId: CAPTURE_A2,
        producerId: PRODUCER_PAGE,
        tiers: ['browser'],
        clockOffsetMs: 9,
        minClockOffsetMs: 9,
        maxClockOffsetMs: 9,
        reportingEvents: 1,
        firstIngestSeq: fixture.secondCapture.ingestSeq,
        lastIngestSeq: fixture.secondCapture.ingestSeq,
      },
    ]);

    // Tiers follow the vocabulary, never arrival; a silent producer has no entry.
    const serverTiers = summaries.find((entry) => entry.producerId === PRODUCER_SERVER)?.tiers;

    expect(serverTiers).toEqual(TELEMETRY_TIERS.filter((tier) => tier !== 'browser'));
    expect(summaries.some((entry) => entry.producerId === PRODUCER_QUIET)).toBe(false);
    expect(Object.isFrozen(summaries)).toBe(true);
    expect(summaries.every((entry) => Object.isFrozen(entry))).toBe(true);
  });

  it('narrows to one capture window', () => {
    const fixture = seedProducers();

    expect(unwrap(repo.listProducerClockOffsets(SESSION_A, { captureId: CAPTURE_A1 }))).toEqual(
      captureA1Summaries(fixture),
    );
    expect(
      unwrap(repo.listProducerClockOffsets(SESSION_A, { captureId: CAPTURE_A2 })).map(
        (entry) => entry.lastIngestSeq,
      ),
    ).toEqual([fixture.secondCapture.ingestSeq]);
    expect(unwrap(repo.listProducerClockOffsets(SESSION_A, { captureId: CAPTURE_B1 }))).toEqual([]);
  });

  it('is scoped to the session it names', () => {
    seedProducers();

    const other = unwrap(repo.listProducerClockOffsets(SESSION_B));

    expect(other).toHaveLength(1);
    expect(other[0]?.captureId).toBe(CAPTURE_B1);
    expect(other[0]?.clockOffsetMs).toBe(5_000);
  });

  it('answers an unknown session, and a session with no offsets, as the other session reads do', () => {
    insertOk([buildEvent(), buildEvent({ producerId: PRODUCER_QUIET })]);

    const unknown = newSessionId();

    expect(unwrap(repo.listTraceIds(unknown))).toEqual([]);
    expect(unwrap(repo.listProducerClockOffsets(unknown))).toEqual([]);
    expect(unwrap(repo.listProducerClockOffsets(SESSION_A))).toEqual([]);
  });

  it('refuses a blank session id and a blank capture id', () => {
    const blankSession = expectError(repo.listProducerClockOffsets(''));

    expect(blankSession.code).toBe('STORE_ERROR');
    expect(blankSession.details?.['reason']).toBe('blank-session-id');
    expect(blankSession.details?.['operation']).toBe('listProducerClockOffsets');

    const blankCapture = expectError(repo.listProducerClockOffsets(SESSION_A, { captureId: '' }));

    expect(blankCapture.code).toBe('STORE_ERROR');
    expect(blankCapture.details?.['reason']).toBe('blank-filter');
    expect(blankCapture.details?.['field']).toBe('captureId');
  });

  it('reports a stored row that no longer holds a producer id rather than returning it', () => {
    const [stored] = insertOk([buildEvent({ clockOffsetMs: 3 })]);

    store
      .statement('UPDATE telemetry_events SET producer_id = ? WHERE id = ?')
      .run('', stored?.id ?? '');

    const error = expectError(repo.listProducerClockOffsets(SESSION_A));

    expect(error.code).toBe('STORE_ERROR');
    expect(error.details?.['column']).toBe('producer_id');
  });

  it(`lists at most MAX_PRODUCER_CLOCK_OFFSETS producers, earliest first, and warns about the rest`, () => {
    const producers = Array.from({ length: MAX_PRODUCER_CLOCK_OFFSETS + 1 }, () => newProducerId());
    const stored = insertOk(
      producers.map((producerId, index) =>
        buildEvent({ producerId, clockOffsetMs: index - MAX_PRODUCER_CLOCK_OFFSETS }),
      ),
    );

    logs.length = 0;

    const summaries = unwrap(repo.listProducerClockOffsets(SESSION_A));

    expect(summaries).toHaveLength(MAX_PRODUCER_CLOCK_OFFSETS);
    expect(summaries.map((entry) => entry.producerId)).toEqual(
      producers.slice(0, MAX_PRODUCER_CLOCK_OFFSETS),
    );
    expect(summaries.at(-1)?.lastIngestSeq).toBe(stored.at(-2)?.ingestSeq);

    const warning = logs.find(
      (record) =>
        record.level === 'warn' && record.fields['operation'] === 'listProducerClockOffsets',
    );

    expect(warning?.fields['listed']).toBe(MAX_PRODUCER_CLOCK_OFFSETS);
  });

  it('is answered from a session-leading index, never a scan of the whole table', () => {
    seedProducers();

    const texts: string[] = [];
    const recording = new Proxy(store, {
      get(target, property): unknown {
        if (property === 'statement') {
          return (sql: string) => {
            texts.push(sql);

            return target.statement(sql);
          };
        }

        const value: unknown = Reflect.get(target, property, target);

        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const reader = createTelemetryRepo({ store: recording });

    unwrap(reader.listProducerClockOffsets(SESSION_A));
    unwrap(reader.listProducerClockOffsets(SESSION_A, { captureId: CAPTURE_A1 }));

    expect(texts).toHaveLength(2);

    for (const sql of texts) {
      const plan = store.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => String(row['detail']));
      const grouped = plan.find((detail) => /\btelemetry_events\b/u.test(detail));

      expect(grouped).toMatch(/USING (?:COVERING )?INDEX idx_telemetry_events_session_id_/u);
      expect(plan.join(' | ')).toMatch(/SEARCH latest USING INTEGER PRIMARY KEY \(rowid=\?\)/u);
    }
  });
});
