/**
 * Tests for the producer clock offset on the ingest path of `./ingest.ts`.
 *
 * AAP 0.2.3 records a per-producer `clockOffsetMs` — the server's `Date` header
 * against the producer's clock — **for information only**: no clock alignment
 * is applied. Each producer stamps its estimate on the events it creates, and
 * ingest's whole job is to let it through untouched: validated by the ingress
 * schema at step 4, persisted at step 8, never added to `startTime` or
 * `duration` and never re-derived from the service's own clock. This suite
 * proves that end to end, from a producer batch to the `clock_offset_ms`
 * column and the per-producer diagnostic read, and proves the two things ingest
 * adds of its own: the `clockOffsetsReported` counter of the report and the
 * count and largest magnitude on the summary log line.
 *
 * The pipeline is the product's own: `createTelemetryIngest` over the real
 * telemetry and sessions repositories of an on-disk store in an `mkdtemp`
 * sandbox, the real privacy primitives and the real attributor. Only the
 * attributor's binding lookups are an in-file table, mapping one tab and one
 * project to the seeded session and capture, so no WebSocket, HTTP server or
 * `$DEBUGGEN_HOME` is involved. The ingest clock is injected.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionRecord } from '@debuggen/protocol';
import {
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
  DebuggenError,
  LogFields,
  LogLevel,
  Logger,
  ProducerId,
  Result,
} from '@debuggen/shared';
import { CLOCK_OFFSET_BOUND_MS } from '@debuggen/telemetry';
import type { TelemetryEventIngress, TelemetryKind, TelemetryTier } from '@debuggen/telemetry';

import { openStore } from '../store/db.js';
import type { Store } from '../store/db.js';
import { createSessionsRepo } from '../store/sessions-repo.js';
import { createTelemetryRepo } from '../store/telemetry-repo.js';
import type { TelemetryRepo } from '../store/telemetry-repo.js';
import { createIngestAttributor } from './attribute.js';
import type { SessionsRepoLike as AttributionStoreLike } from './attribute.js';
import { INGEST_SUBSYSTEM, createTelemetryIngest, toIngestResponse } from './ingest.js';
import type { IngestReport, TelemetryIngest } from './ingest.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The session every batch is attributed to. */
const SESSION = newSessionId();

/** That session's open capture window. */
const CAPTURE = newCaptureId();

/** The inspected tab bound to {@link SESSION}. */
const TAB_ID = 11;

/** The project whose dev-server preload posts to the service. Invented, outside any checkout. */
const PROJECT = '/tmp/project-clock-offset';

/** A page document's browser agent. */
const PAGE_PRODUCER: ProducerId = newProducerId();

/** The dev server's Node preload. */
const SERVER_PRODUCER: ProducerId = newProducerId();

/**
 * The epoch millisecond the fixture events start from: a double with a
 * fractional part, so any arithmetic applied to it is visible under `toBe`.
 */
const BASE_TIME = 1_768_000_000_000.375;

/** The injected ingest clock's reading. */
const INGEST_NOW = 1_768_000_100_000;

/** The summary log line every successful batch ends with. */
const SUMMARY_MESSAGE = 'telemetry batch ingested';

/** The sandbox directory holding the database for one case. */
let directory: string;

/** The store under both repositories. */
let store: Store;

/** The telemetry repository ingest writes through, and the cases read back from. */
let telemetry: TelemetryRepo;

/** Per-producer sequence counters. */
let sequences: Map<string, number>;

/** One record the recording logger received, with every child binding merged in. */
interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** A `Logger` that records every message and fields object, children included. */
function recordingLogger(): { readonly logger: Logger; readonly entries: LogEntry[] } {
  const entries: LogEntry[] = [];

  function make(bindings: LogFields): Logger {
    const writer =
      (level: LogLevel) =>
      (message: string, fields?: LogFields): void => {
        entries.push({ level, message, fields: { ...bindings, ...fields } });
      };

    return {
      level: 'trace',
      trace: writer('trace'),
      debug: writer('debug'),
      info: writer('info'),
      warn: writer('warn'),
      error: writer('error'),
      fatal: writer('fatal'),
      child: (extra) => make({ ...bindings, ...extra }),
    };
  }

  return { logger: make({}), entries };
}

/** A new session's record, minimal and valid, as the session manager persists it. */
function sessionRecord(): SessionRecord {
  return {
    id: SESSION,
    projectRoot: PROJECT,
    projectName: 'project-clock-offset',
    devServerUrl: 'http://127.0.0.1:20303',
    createdAt: INGEST_NOW,
    updatedAt: INGEST_NOW,
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

/** The attributor's binding lookups: {@link TAB_ID} and {@link PROJECT} resolve to the seeded capture. */
const attributionStore: AttributionStoreLike = {
  getBindingByTab: (tabId) => ok(tabId === TAB_ID ? { sessionId: SESSION } : undefined),
  get: (id) => ok(id === SESSION ? { id: SESSION, projectRoot: PROJECT } : undefined),
  getActiveCapture: (id) => ok(id === SESSION ? { capture: { id: CAPTURE } } : undefined),
};

/** What {@link makeEvent} may override. */
interface EventOverrides {
  readonly kind?: TelemetryKind;
  readonly tier?: TelemetryTier;
  readonly producerId?: ProducerId;
  readonly startTime?: number;
  readonly duration?: number;
}

/**
 * A producer event as a transport delivers it, with `clockOffsetMs` present
 * only when `clockOffsetMs` is given — as a producer omits it before its first
 * usable sample. Typed `unknown` for the offset so a case can send what a
 * broken producer would.
 */
function makeEvent(clockOffsetMs?: unknown, overrides: EventOverrides = {}): TelemetryEventIngress {
  const producerId = overrides.producerId ?? PAGE_PRODUCER;
  const seq = sequences.get(producerId) ?? 0;

  sequences.set(producerId, seq + 1);

  const event = {
    id: newEventId(),
    traceId: newTraceId(),
    spanId: newSpanId(),
    kind: overrides.kind ?? 'interaction',
    name: 'click handleAction',
    startTime: overrides.startTime ?? BASE_TIME + seq * 1.5,
    duration: overrides.duration ?? 3.25,
    tier: overrides.tier ?? 'browser',
    attributes: {},
    status: 'ok',
    producerId,
    seq,
    ...(clockOffsetMs === undefined ? {} : { clockOffsetMs }),
  };

  return event as TelemetryEventIngress;
}

/** A server request span from the preload. */
function serverEvent(clockOffsetMs?: unknown): TelemetryEventIngress {
  return makeEvent(clockOffsetMs, {
    kind: 'http.server',
    tier: 'server',
    producerId: SERVER_PRODUCER,
  });
}

/** A database span from the preload. */
function databaseEvent(clockOffsetMs?: unknown): TelemetryEventIngress {
  return makeEvent(clockOffsetMs, { kind: 'db.query', tier: 'db', producerId: SERVER_PRODUCER });
}

/** One pipeline over the real store, and what its logger recorded. */
interface Harness {
  readonly ingest: TelemetryIngest;
  readonly logs: LogEntry[];
}

/**
 * Builds the pipeline.
 *
 * @param now The ingest clock; defaults to {@link INGEST_NOW}.
 */
function harness(now: () => number = () => INGEST_NOW): Harness {
  const { logger, entries } = recordingLogger();
  const ingest = createTelemetryIngest({
    telemetry,
    sessions: createSessionsRepo({ store, now: () => INGEST_NOW }),
    attributor: createIngestAttributor({
      sessions: attributionStore,
      sessionManager: {
        captureOwnerForProject: (projectRoot) =>
          projectRoot === PROJECT ? { sessionId: SESSION, captureId: CAPTURE } : undefined,
      },
      now: () => INGEST_NOW,
    }),
    logger,
    now,
  });

  return { ingest, logs: entries };
}

/** Ingests a batch relayed for {@link TAB_ID}. */
function fromPage(h: Harness, events: unknown): Promise<Result<IngestReport, DebuggenError>> {
  return h.ingest.ingestFromAgent({ tabId: TAB_ID, events });
}

/** Ingests a batch posted by {@link PROJECT}'s preload. */
function fromServer(h: Harness, events: unknown): Promise<Result<IngestReport, DebuggenError>> {
  return h.ingest.ingestFromServerAgent({
    projectRoot: PROJECT,
    scopedProjectRoot: PROJECT,
    events,
  });
}

/** The report of an `ok` result; fails the case with the error code otherwise. */
function expectReport(result: Result<IngestReport, DebuggenError>): IngestReport {
  if (!result.ok) {
    throw new Error(`expected an ingest report, got ${result.error.code}`);
  }

  return result.value;
}

/** One stored row as raw columns. */
function readRow(id: string): Record<string, unknown> | undefined {
  return store.statement('SELECT * FROM telemetry_events WHERE id = ?').get(id);
}

/** The fields of the one summary log line a batch wrote. */
function summaryFields(h: Harness): LogFields {
  const summaries = h.logs.filter((entry) => entry.message === SUMMARY_MESSAGE);

  expect(summaries).toHaveLength(1);
  expect(summaries[0]?.level).toBe('debug');
  expect(summaries[0]?.fields['subsystem']).toBe(INGEST_SUBSYSTEM);

  return summaries[0]?.fields ?? {};
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'debuggen-ingest-clock-offset-'));
  sequences = new Map();
  store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite') }));
  telemetry = createTelemetryRepo({ store });

  const sessions = createSessionsRepo({ store, now: () => INGEST_NOW });

  unwrap(sessions.insert(sessionRecord()));
  unwrap(
    sessions.startCapture({
      sessionId: SESSION,
      planVersion: 1,
      captureId: CAPTURE,
      startedAt: INGEST_NOW,
    }),
  );
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------------------------------
 * The offset passes through untouched
 * ---------------------------------------------------------------------------------------------- */

describe('a producer clock offset on the ingest path', () => {
  it('persists a browser event’s offset unchanged, and its times with it', async () => {
    const h = harness();
    const startTime = BASE_TIME + 12.125;
    const duration = 48.625;
    const event = makeEvent(137, { startTime, duration });
    const report = expectReport(await fromPage(h, [event]));

    expect(report.persisted).toBe(1);
    expect(report.clockOffsetsReported).toBe(1);

    const row = readRow(event.id);

    expect(row?.['clock_offset_ms']).toBe(137);
    expect(row?.['start_time']).toBe(startTime);
    expect(row?.['duration']).toBe(duration);

    const [stored] = unwrap(telemetry.listByCapture(SESSION, CAPTURE)).rows;

    expect(stored?.clockOffsetMs).toBe(137);
    expect(stored?.startTime).toBe(startTime);
    expect(stored?.duration).toBe(duration);
  });

  it('persists the preload’s negative offset on server and database spans alike', async () => {
    const h = harness();
    const events = [serverEvent(-2_500), databaseEvent(-2_500)];
    const report = expectReport(await fromServer(h, events));

    expect(report.persisted).toBe(2);
    expect(report.clockOffsetsReported).toBe(2);

    for (const event of events) {
      expect(readRow(event.id)?.['clock_offset_ms']).toBe(-2_500);
      expect(readRow(event.id)?.['start_time']).toBe(event.startTime);
    }
  });

  it('stores an event without an offset with NULL and does not count it', async () => {
    const h = harness();
    const silent = makeEvent();
    const report = expectReport(await fromPage(h, [silent]));

    expect(report.persisted).toBe(1);
    expect(report.clockOffsetsReported).toBe(0);
    expect(readRow(silent.id)?.['clock_offset_ms']).toBeNull();

    const [stored] = unwrap(telemetry.listByCapture(SESSION, CAPTURE)).rows;

    expect(Object.hasOwn(stored ?? {}, 'clockOffsetMs')).toBe(false);
  });

  it('never derives the offset or the times from the service clock', async () => {
    // Two pipelines whose clocks disagree by an hour store identical rows.
    const early = makeEvent(64);
    const late = makeEvent(64);

    expectReport(
      await fromPage(
        harness(() => INGEST_NOW),
        [early],
      ),
    );
    expectReport(
      await fromPage(
        harness(() => INGEST_NOW + 3_600_000),
        [late],
      ),
    );

    for (const event of [early, late]) {
      const row = readRow(event.id);

      expect(row?.['clock_offset_ms']).toBe(64);
      expect(row?.['start_time']).toBe(event.startTime);
      expect(row?.['duration']).toBe(event.duration);
    }
  });

  it.each([
    ['a fractional offset', 2.5],
    ['an offset beyond the bound', CLOCK_OFFSET_BOUND_MS + 1],
    ['an offset below the bound', -CLOCK_OFFSET_BOUND_MS - 1],
    ['an offset that is not a number', '5'],
  ])('counts %s as invalid and stores its valid siblings', async (_label, clockOffsetMs) => {
    const h = harness();
    const valid = makeEvent(5);
    const broken = makeEvent(clockOffsetMs);
    const report = expectReport(await fromPage(h, [valid, broken]));

    expect(report.received).toBe(2);
    expect(report.parsed).toBe(1);
    expect(report.invalid).toBe(1);
    expect(report.persisted).toBe(1);
    expect(report.clockOffsetsReported).toBe(1);
    expect(readRow(valid.id)?.['clock_offset_ms']).toBe(5);
    expect(readRow(broken.id)).toBeUndefined();
    expect(toIngestResponse(report)).toEqual({ accepted: 1, rejected: 1 });

    const warning = h.logs.find((entry) => entry.message === 'malformed telemetry events skipped');

    expect(warning?.fields['fields']).toContain('clockOffsetMs');
  });

  it('accepts the bound itself in either direction', async () => {
    const h = harness();
    const ahead = makeEvent(CLOCK_OFFSET_BOUND_MS);
    const behind = makeEvent(-CLOCK_OFFSET_BOUND_MS);
    const report = expectReport(await fromPage(h, [ahead, behind]));

    expect(report.invalid).toBe(0);
    expect(report.clockOffsetsReported).toBe(2);
    expect(readRow(ahead.id)?.['clock_offset_ms']).toBe(CLOCK_OFFSET_BOUND_MS);
    expect(readRow(behind.id)?.['clock_offset_ms']).toBe(-CLOCK_OFFSET_BOUND_MS);
  });
});

/* -------------------------------------------------------------------------------------------------
 * What ingest reports about the offsets
 * ---------------------------------------------------------------------------------------------- */

describe('the clock-offset accounting of a batch', () => {
  it('puts the count and the largest magnitude on the summary log line', async () => {
    const h = harness();
    const report = expectReport(
      await fromPage(h, [makeEvent(120), makeEvent(-900), makeEvent(40), makeEvent()]),
    );

    expect(report.clockOffsetsReported).toBe(3);

    const fields = summaryFields(h);

    expect(fields['clockOffsetsReported']).toBe(3);
    expect(fields['maxAbsClockOffsetMs']).toBe(900);
  });

  it('reports zero, and no magnitude, for a batch in which no event carried one', async () => {
    const h = harness();
    const report = expectReport(await fromPage(h, [makeEvent(), makeEvent()]));

    expect(report.clockOffsetsReported).toBe(0);

    const fields = summaryFields(h);

    expect(fields['clockOffsetsReported']).toBe(0);
    expect(Object.hasOwn(fields, 'maxAbsClockOffsetMs')).toBe(false);
  });

  it('counts an identical replay as reported while the store skips it', async () => {
    const h = harness();
    const events = [makeEvent(-18), makeEvent(-18)];

    expectReport(await fromPage(h, events));

    const replay = expectReport(await fromPage(h, events));

    expect(replay.inserted).toBe(0);
    expect(replay.skipped).toBe(2);
    expect(replay.persisted).toBe(2);
    expect(replay.clockOffsetsReported).toBe(2);
    expect(unwrap(telemetry.countBySession(SESSION))).toBe(2);
  });

  it('counts nothing for a batch attribution dropped whole', async () => {
    const h = harness();
    const report = expectReport(
      await h.ingest.ingestFromAgent({ tabId: TAB_ID + 1, events: [makeEvent(7)] }),
    );

    expect(report.batchDropReason).toBeDefined();
    expect(report.clockOffsetsReported).toBe(0);
    expect(unwrap(telemetry.countBySession(SESSION))).toBe(0);
  });

  it('feeds the per-producer diagnostic the store answers', async () => {
    const h = harness();
    const pageFirst = makeEvent(210);
    const pageLatest = makeEvent(190);
    const serverSpan = serverEvent(-60);
    const databaseSpan = databaseEvent(-55);

    expectReport(await fromPage(h, [pageFirst]));
    expectReport(await fromServer(h, [serverSpan, databaseSpan]));
    expectReport(await fromPage(h, [pageLatest, makeEvent()]));

    const summaries = unwrap(telemetry.listProducerClockOffsets(SESSION));

    expect(
      summaries.map(({ producerId, tiers, clockOffsetMs, minClockOffsetMs, maxClockOffsetMs }) => ({
        producerId,
        tiers,
        clockOffsetMs,
        minClockOffsetMs,
        maxClockOffsetMs,
      })),
    ).toEqual([
      {
        producerId: PAGE_PRODUCER,
        tiers: ['browser'],
        clockOffsetMs: 190,
        minClockOffsetMs: 190,
        maxClockOffsetMs: 210,
      },
      {
        producerId: SERVER_PRODUCER,
        tiers: ['server', 'db'],
        clockOffsetMs: -55,
        minClockOffsetMs: -60,
        maxClockOffsetMs: -55,
      },
    ]);
    expect(summaries.map((entry) => entry.reportingEvents)).toEqual([2, 2]);
    expect(summaries.every((entry) => entry.captureId === CAPTURE)).toBe(true);
  });
});
