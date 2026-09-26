/**
 * Colocated unit suite for `./capture.ts`, Stage 4 of the pipeline — the one
 * stage that makes no model call (AAP §0.4.2 Runtime-capture row, §0.5.5,
 * §0.8.3).
 *
 * It pins what happens between "Stop capture" and the window closing:
 *
 * 1. **The stop barrier.** After both producers are disarmed the window stays
 *    open, and the capture's ingest watermark is polled until it stands still
 *    for a quiet period, bounded by a hard ceiling — so the batches the
 *    producers flush on disarm are attributed to the capture that recorded
 *    them. Every ending (`quiescent`, `deadline`, `unverified`,
 *    `not-applicable`) and the cancellation are driven here with an injected
 *    sleeper and monotonic clock, never with real time.
 * 2. **The bounded summary.** The capture's events are read in small pages,
 *    yielding between them, and summarised up to an event ceiling and a
 *    stored-size ceiling; past either, the emptiness rule reads exact per-kind
 *    counts and the coverage reports stored versus summarised events.
 * 3. **The empty-capture rule** (AAP §0.5.5): zero events, or zero browser
 *    interactions for an interaction question — whether or not the
 *    interaction hook was armed.
 * 4. **Coverage.** The summary handed to the session manager — the one it
 *    persists and broadcasts in `capture.stopped` — says whether it covers
 *    everything the producers observed, and an incomplete capture reaches both
 *    user interfaces as one `session.progress` row of counts. A quiet barrier
 *    is unverified when a producer that sent the capture events could not be
 *    confirmed disarmed, and never because of one that sent nothing.
 * 5. **The producer-loss accounting.** The ledger entry is begun when the
 *    window opens and released once it has closed; a capture the ledger cannot
 *    vouch for is never complete, and its loss is reported as a lower bound.
 *
 * Every collaborator is an in-file double shaped as the narrow port the stage
 * declares; the store, the service and the session manager are never started.
 * Fixtures use invented, generic vocabulary only.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DISABLED_SERVER_AGENT_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  PROBLEM_CATEGORIES,
  PROBLEM_ENTITY_KINDS,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  instrumentationPlanSchema,
  problemUnderstandingSchema,
} from '@debuggen/instrumentation';
import type {
  AgentHookConfig,
  InstrumentationPlan,
  ProblemUnderstanding,
} from '@debuggen/instrumentation';
import { sessionRecordSchema } from '@debuggen/protocol';
import type { CaptureRecord, SessionProgressPayload, SessionRecord } from '@debuggen/protocol';
import {
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
} from '@debuggen/shared';
import type { LogRecord, Result } from '@debuggen/shared';
import {
  TELEMETRY_KINDS,
  allowedTiersFor,
  computeCaptureSummary,
  parseTelemetryEvent,
} from '@debuggen/telemetry';
import type { CaptureSummary, TelemetryEvent, TelemetryKind } from '@debuggen/telemetry';

import type { ReadinessVerdict } from '../../instrumentation/readiness.js';
import type { ArmingSnapshot, DisarmCaptureOutcome } from '../../instrumentation/service.js';
import type { StopCaptureOptions } from '../../sessions/manager.js';
import type {
  CaptureIngestWatermark,
  CaptureSummaryPage,
  CaptureSummaryPageOptions,
  ProducerLossTotal,
} from '../../store/telemetry-repo.js';
import {
  CAPTURE_DRAIN_DEFAULTS,
  CAPTURE_EMPTY_MESSAGE,
  INTERACTION_HOOK_OFF_MESSAGE,
  MAX_SUMMARY_BYTES,
  MAX_SUMMARY_EVENTS,
  SUMMARY_PAGE_SIZE,
  classifyCaptureEmptiness,
  createCaptureStage,
  understandingNeedsInteraction,
} from './capture.js';
import type { CaptureDrainTiming, CaptureStageContext, CaptureStageDeps } from './capture.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

const SESSION_ID = newSessionId();
const CAPTURE_ID = newCaptureId();
const PROJECT_ROOT = '/workspace/ledger-tool';
const EPOCH_MS = 1_767_225_600_000;
const PRODUCER_ID = newProducerId();
const TRACE_ID = newTraceId();

/**
 * Planted as every fixture event's name: an event name is captured data, so no
 * log record and no progress row may ever carry it (AAP §0.5.2).
 */
const NAME_SENTINEL = 'quillmarmoteventnametoken';

/** The page-agent hooks of a plan that armed the interaction hook. */
const INTERACTION_HOOKS: AgentHookConfig = Object.freeze({
  ...DORMANT_AGENT_HOOK_CONFIG,
  interactions: true,
  fetch: true,
});

/** The page-agent hooks of a plan that armed requests only: the interaction hook is off. */
const REQUEST_ONLY_HOOKS: AgentHookConfig = Object.freeze({
  ...DORMANT_AGENT_HOOK_CONFIG,
  fetch: true,
});

/** A validated understanding whose question needs a browser interaction. */
const INTERACTION_QUESTION: ProblemUnderstanding = problemUnderstandingSchema.parse({
  category: PROBLEM_CATEGORIES[0],
  signalsNeeded: ['interactions', 'fetch'],
  entities: [{ kind: PROBLEM_ENTITY_KINDS[0], name: 'LedgerTotals' }],
  searchHints: ['ledger totals'],
});

/** A validated understanding that needs no interaction: requests alone answer it. */
const REQUEST_QUESTION: ProblemUnderstanding = problemUnderstandingSchema.parse({
  category: PROBLEM_CATEGORIES[0],
  signalsNeeded: ['fetch'],
  entities: [{ kind: PROBLEM_ENTITY_KINDS[0], name: 'LedgerTotals' }],
  searchHints: ['ledger totals'],
});

/** Plan version 1: one runtime interaction-tracking action, as the plan stage records it. */
const PLAN_V1: InstrumentationPlan = instrumentationPlanSchema.parse({
  version: 1,
  objective: 'Determine why the ledger totals refresh slowly.',
  hypotheses: [],
  capture: ['interaction timing'],
  instrumentationTargets: [
    {
      id: 'act_0000000000000001',
      file: TARGETLESS_FILE,
      symbol: TARGETLESS_SYMBOL,
      type: 'interaction-tracking',
      adapter: 'page-probe',
      mode: 'runtime',
      rationale: 'Time the interaction the developer reported.',
    },
  ],
  sessionId: SESSION_ID,
  planVersion: 1,
});

/** A disarm both producers acknowledged. */
const DISARMED: DisarmCaptureOutcome = Object.freeze({
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  agentDisarmed: true,
  serverAgent: 'delivered',
});

/**
 * One stored event, validated once through the telemetry package's own parser
 * and then cloned per index, so tens of thousands of fixture events cost one
 * parse.
 */
const EVENT_TEMPLATE: TelemetryEvent = ((): TelemetryEvent => {
  const parsed = parseTelemetryEvent({
    id: newEventId(),
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    traceId: TRACE_ID,
    spanId: newSpanId(),
    kind: 'fetch',
    tier: 'browser',
    name: NAME_SENTINEL,
    startTime: EPOCH_MS,
    duration: 1,
    attributes: {},
    status: 'ok',
    producerId: PRODUCER_ID,
    seq: 0,
    ingestSeq: 1,
  });
  if (!parsed.ok) {
    throw new Error(`The event template does not validate: ${parsed.error.message}`);
  }
  return parsed.value;
})();

/** The `index`-th stored event of the capture, of `kind`. */
function eventAt(index: number, kind: TelemetryKind): TelemetryEvent {
  return {
    ...EVENT_TEMPLATE,
    id: `evt_${String(index).padStart(16, '0')}`,
    spanId: index.toString(16).padStart(16, '0'),
    kind,
    tier: allowedTiersFor(kind)[0] ?? EVENT_TEMPLATE.tier,
    startTime: EPOCH_MS + index,
    seq: index,
    ingestSeq: index + 1,
  };
}

/** A watermark of `eventCount` rows whose highest arrival number is the same count. */
function watermark(eventCount: number): CaptureIngestWatermark {
  return { eventCount, lastIngestSeq: eventCount };
}

/** A store failure, as the telemetry repository reports one. */
function storeFailure(): DebuggenError {
  return new DebuggenError('STORE_ERROR', 'The telemetry store could not complete an operation.', {
    details: { reason: 'store-failed' },
  });
}

/* -------------------------------------------------------------------------------------------------
 * The harness
 * ---------------------------------------------------------------------------------------------- */

/** What one harness run is scripted with. Every member has a default. */
interface Script {
  /** How many events the capture holds when it is summarised. */
  readonly stored: number;
  /** The kind of the `index`-th stored event. */
  readonly kindAt: (index: number) => TelemetryKind;
  /** The stored size of the `index`-th event's JSON document, in characters. */
  readonly storedCharsAt: (index: number) => number;
  /**
   * What each watermark poll answers, in order; past the end the last entry
   * repeats. Absent, every poll answers `watermark(stored)`.
   */
  readonly watermarks?: readonly (CaptureIngestWatermark | DebuggenError)[];
  /** Whether the exact per-kind count fails. */
  readonly countByKindFails: boolean;
  /** The producer-loss total the ledger answers. */
  readonly producerLoss: number;
  /** Whether the ledger vouches for that total: it tracked the capture since its window opened. */
  readonly lossAccounted: boolean;
  /** What the disarm answers. */
  readonly disarm: DisarmCaptureOutcome | DebuggenError;
  /** The hooks the service holds for the plan version; `undefined` when it holds none. */
  readonly agentHooks: AgentHookConfig | undefined;
  /** The understanding recorded on the session. */
  readonly understanding: ProblemUnderstanding | undefined;
  /** The session's status when the stage is called. */
  readonly status: SessionRecord['status'];
  /** The capture row as stored: open, unless a test closed it. */
  readonly capture: CaptureRecord;
  /** Whether arming fails, sending the stage down its rollback path. */
  readonly armFails: boolean;
  /** The plan versions recorded on the session. */
  readonly plans: readonly InstrumentationPlan[];
}

/** A virtual monotonic clock whose sleeper advances it by exactly the time asked for. */
interface VirtualClock {
  readonly timing: Pick<CaptureDrainTiming, 'sleep' | 'monotonicNow'>;
  /** Every duration the barrier slept for, in order. */
  readonly sleeps: number[];
  /** How far the clock has advanced. */
  elapsed(): number;
}

function virtualClock(): VirtualClock {
  let time = 0;
  const sleeps: number[] = [];
  return {
    timing: {
      monotonicNow: () => time,
      sleep: (ms) => {
        sleeps.push(ms);
        time += ms;
        return Promise.resolve();
      },
    },
    sleeps,
    elapsed: () => time,
  };
}

/** One `session.progress` call the stage made. */
interface ProgressCall {
  readonly method: 'stageStarted' | 'stageCompleted' | 'stageFailed' | 'finding';
  readonly stage: string;
  readonly message: string | undefined;
}

interface Harness {
  readonly deps: CaptureStageDeps;
  readonly context: CaptureStageContext;
  readonly clock: VirtualClock;
  readonly records: LogRecord[];
  readonly timeline: string[];
  readonly stops: StopCaptureOptions[];
  readonly progress: ProgressCall[];
  readonly telemetry: TelemetryDouble;
  /** The `Capture completed.` log record's fields. */
  completedFields(): Readonly<Record<string, unknown>> | undefined;
}

/** The session record the stage reads, validated against protocol's schema. */
function sessionRecord(script: Script): SessionRecord {
  return sessionRecordSchema.parse({
    id: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    projectName: 'ledger-tool',
    devServerUrl: 'http://127.0.0.1:4173/',
    createdAt: EPOCH_MS,
    updatedAt: EPOCH_MS,
    status: script.status,
    question: 'Why do the ledger totals refresh slowly?',
    ...(script.understanding !== undefined ? { understanding: script.understanding } : {}),
    followUps: [],
    relevantFiles: [],
    plans: [...script.plans],
    modifications: [],
    captures: [script.capture],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
  });
}

/** A zero-filled per-kind count of the scripted stored events. */
function kindCountsOf(script: Script): Record<TelemetryKind, number> {
  const counts = Object.fromEntries(TELEMETRY_KINDS.map((kind) => [kind, 0])) as Record<
    TelemetryKind,
    number
  >;
  for (let index = 0; index < script.stored; index += 1) {
    counts[script.kindAt(index)] += 1;
  }
  return counts;
}

/**
 * The telemetry port, scripted: the capture's events generated per page on
 * demand (so tens of thousands cost nothing until read) with their scripted
 * stored sizes, their exact per-kind count, the scripted watermark polls and
 * the producer-loss total.
 */
function telemetryDouble(script: Script, timeline: string[]) {
  let polls = 0;
  return {
    pageCaptureForSummary: vi.fn(
      (
        _sessionId: string,
        _captureId: string,
        options: CaptureSummaryPageOptions,
      ): Result<CaptureSummaryPage, DebuggenError> => {
        timeline.push('pageCaptureForSummary');
        const { limit, offset } = options;
        const end = Math.min(script.stored, offset + limit);
        const rows: TelemetryEvent[] = [];
        let storedChars = 0;
        for (let index = offset; index < end; index += 1) {
          rows.push(eventAt(index, script.kindAt(index)));
          storedChars += script.storedCharsAt(index);
        }
        // The repository's contract: a full page names the next offset, a short one is the end.
        return ok({
          rows,
          rowsRead: rows.length,
          skipped: 0,
          storedChars,
          ...(limit > 0 && rows.length === limit ? { nextOffset: offset + rows.length } : {}),
        });
      },
    ),
    countByKind: vi.fn((): Result<Record<TelemetryKind, number>, DebuggenError> => {
      timeline.push('countByKind');
      return script.countByKindFails ? err(storeFailure()) : ok(kindCountsOf(script));
    }),
    captureWatermark: vi.fn((): Result<CaptureIngestWatermark, DebuggenError> => {
      timeline.push('watermark');
      const scripted = script.watermarks;
      const answer =
        scripted === undefined || scripted.length === 0
          ? watermark(script.stored)
          : (scripted[Math.min(polls, scripted.length - 1)] ?? watermark(script.stored));
      polls += 1;
      return answer instanceof DebuggenError ? err(answer) : ok(answer);
    }),
    beginProducerLossAccounting: vi.fn((): Result<void, DebuggenError> => {
      timeline.push('beginProducerLossAccounting');
      return ok(undefined);
    }),
    producerLoss: vi.fn((): Result<ProducerLossTotal, DebuggenError> =>
      ok({ droppedEvents: script.producerLoss, accounted: script.lossAccounted }),
    ),
    releaseProducerLoss: vi.fn((): Result<void, DebuggenError> => {
      timeline.push('releaseProducerLoss');
      return ok(undefined);
    }),
  };
}

/** The scripted telemetry port, with its spies. */
type TelemetryDouble = ReturnType<typeof telemetryDouble>;

function harness(
  overrides: Partial<Script> = {},
  drain: Partial<CaptureDrainTiming> = {},
): Harness {
  const script: Script = {
    stored: 3,
    kindAt: (index) => (index === 0 ? 'interaction' : 'fetch'),
    storedCharsAt: () => 500,
    countByKindFails: false,
    producerLoss: 0,
    lossAccounted: true,
    disarm: DISARMED,
    agentHooks: INTERACTION_HOOKS,
    understanding: INTERACTION_QUESTION,
    status: 'capturing',
    capture: { id: CAPTURE_ID, planVersion: 1, startedAt: EPOCH_MS },
    armFails: false,
    plans: [],
    ...overrides,
  };
  const records: LogRecord[] = [];
  const timeline: string[] = [];
  const stops: StopCaptureOptions[] = [];
  const progressCalls: ProgressCall[] = [];
  const clock = virtualClock();
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });
  let session = sessionRecord(script);
  let capture = script.capture;

  const telemetry = telemetryDouble(script, timeline);

  const snapshot = (): ArmingSnapshot | undefined =>
    script.agentHooks === undefined
      ? undefined
      : {
          sessionId: SESSION_ID,
          projectRoot: PROJECT_ROOT,
          activePlanVersion: 1,
          agentHooks: script.agentHooks,
          serverSignals: { ...DISABLED_SERVER_AGENT_SIGNALS, functions: [] },
        };

  /** One recorded progress call, answered as the emitter would. */
  const row =
    (method: ProgressCall['method']) =>
    (
      sessionId: string,
      stage: string,
      message?: string,
    ): Result<SessionProgressPayload, DebuggenError> => {
      timeline.push(`row:${method}`);
      progressCalls.push({ method, stage, message });
      return ok({
        sessionId,
        stage: 'capture',
        status: 'done',
        message: message ?? 'Capture',
      });
    };

  const deps: CaptureStageDeps = {
    instrumentation: {
      armCapture: () => {
        timeline.push('arm');
        return script.armFails
          ? err(new DebuggenError('INTERNAL', 'The producers could not be armed.'))
          : ok({
              sessionId: SESSION_ID,
              captureId: CAPTURE_ID,
              planVersion: 1,
              agentHooks: script.agentHooks ?? DORMANT_AGENT_HOOK_CONFIG,
              serverSignals: DISABLED_SERVER_AGENT_SIGNALS,
              serverAgent: 'not-needed',
            });
      },
      disarmCapture: () => {
        timeline.push('disarm');
        return script.disarm instanceof DebuggenError ? err(script.disarm) : ok(script.disarm);
      },
      arming: snapshot,
    },
    sessions: {
      getCapture: (captureId) =>
        ok(captureId === CAPTURE_ID ? { sessionId: SESSION_ID, capture } : undefined),
      getActiveCapture: () =>
        ok(capture.stoppedAt === undefined ? { sessionId: SESSION_ID, capture } : undefined),
    },
    telemetry,
    sessionManager: {
      get: () => ok(session),
      startCapture: () => {
        timeline.push('startCapture');
        session = { ...session, status: 'capturing' };
        return Promise.resolve(ok({ captureId: CAPTURE_ID }));
      },
      stopCapture: (_sessionId, options) => {
        timeline.push(`stopCapture:${options.next}`);
        stops.push(options);
        capture = { ...capture, stoppedAt: EPOCH_MS + 1, summary: options.summary };
        session = { ...session, status: options.next, captures: [capture] };
        return Promise.resolve(ok(capture));
      },
    },
    progress: {
      stageStarted: row('stageStarted'),
      stageCompleted: row('stageCompleted'),
      stageFailed: (sessionId, failure) => {
        timeline.push('row:stageFailed');
        progressCalls.push({
          method: 'stageFailed',
          stage: failure.stage,
          message: failure.message,
        });
        return ok({ sessionId, stage: failure.stage, status: 'failed', message: failure.message });
      },
      finding: row('finding'),
    },
    registry: { get: () => undefined },
    logger,
    drain: { ...clock.timing, ...drain },
  };

  const context: CaptureStageContext = {
    sessionId: SESSION_ID,
    session,
    projectRoot: PROJECT_ROOT,
    logger,
    // The service clock is frozen on purpose: a barrier timed with it could
    // never observe a quiet period and would only end at its poll guard.
    now: () => EPOCH_MS,
  };

  return {
    deps,
    context,
    clock,
    records,
    timeline,
    stops,
    progress: progressCalls,
    telemetry,
    completedFields: () =>
      records.find((record) => record.message.startsWith('Capture completed'))?.fields,
  };
}

/** The summary the session manager was handed to persist and broadcast. */
function stoppedSummary(h: Harness): CaptureSummary {
  const [stop] = h.stops;
  if (stop === undefined) {
    throw new Error('The capture window was never closed.');
  }
  return stop.summary;
}

/* -------------------------------------------------------------------------------------------------
 * 1. The stop barrier
 * ---------------------------------------------------------------------------------------------- */

describe('the stop barrier', () => {
  it('pins its default timing', () => {
    expect(CAPTURE_DRAIN_DEFAULTS).toEqual({
      pollIntervalMs: 100,
      quietPeriodMs: 600,
      unreachableQuietPeriodMs: 1_500,
      maxDrainMs: 5_000,
    });
  });

  it('keeps the window open until the watermark stands still for the quiet period', async () => {
    const h = harness();

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    expect(h.clock.elapsed()).toBe(CAPTURE_DRAIN_DEFAULTS.quietPeriodMs);
    expect(h.clock.sleeps.every((ms) => ms <= CAPTURE_DRAIN_DEFAULTS.pollIntervalMs)).toBe(true);
    // Disarm first, every poll before the summary, and the window closed last.
    expect(h.timeline[0]).toBe('disarm');
    const lastPoll = h.timeline.lastIndexOf('watermark');
    expect(lastPoll).toBeLessThan(h.timeline.indexOf('pageCaptureForSummary'));
    expect(h.timeline.indexOf('pageCaptureForSummary')).toBeLessThan(
      h.timeline.indexOf('stopCapture:analyzing'),
    );
    expect(h.telemetry.captureWatermark).toHaveBeenCalledTimes(7);
    expect(h.completedFields()).toMatchObject({ drain: 'quiescent' });
  });

  it('restarts the quiet period when a late batch lands, and summarises it', async () => {
    // Two events at the stop, five after the second poll: the flush on disarm.
    const h = harness({ stored: 5, watermarks: [watermark(2), watermark(2), watermark(5)] });

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    expect(h.clock.elapsed()).toBe(200 + CAPTURE_DRAIN_DEFAULTS.quietPeriodMs);
    expect(stoppedSummary(h).eventCount).toBe(5);
    expect(h.completedFields()).toMatchObject({ drain: 'quiescent' });

    // The barrier reports what the watermark counts — arrivals — and never
    // calls it the stored size, which the summary's coverage reports instead.
    const quiet = h.records.find(
      (record) => record.message === 'The capture window went quiet before it closed.',
    );
    expect(quiet?.fields).toMatchObject({ drain: 'quiescent', changes: 1, arrivals: 5 });
    expect(quiet?.fields).not.toHaveProperty('storedEvents');
  });

  it.each([
    {
      // The default capture holds browser events only: the preload sent it
      // nothing, so its missing disarm cannot leave this capture short.
      condition: 'the preload could not be reached',
      disarm: { ...DISARMED, serverAgent: 'unreachable' } as DisarmCaptureOutcome,
      drain: 'quiescent',
    },
    {
      // The page agent sent this capture its events and was never told to stop.
      condition: 'the dormant page configuration was not sent',
      disarm: { ...DISARMED, agentDisarmed: false } as DisarmCaptureOutcome,
      drain: 'unverified',
    },
    {
      condition: 'the disarm itself failed',
      disarm: new DebuggenError('INTERNAL', 'The disarm could not be sent.'),
      drain: 'unverified',
    },
  ])('waits out the longer quiet period when $condition', async ({ disarm, drain }) => {
    const h = harness({ disarm });

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    expect(h.clock.elapsed()).toBe(CAPTURE_DRAIN_DEFAULTS.unreachableQuietPeriodMs);
    expect(h.completedFields()).toMatchObject({ drain });
    expect(stoppedSummary(h).coverage).toMatchObject({ drain, complete: drain === 'quiescent' });
  });

  it('ends at its ceiling when events are still arriving, and still closes the window', async () => {
    const moving = Array.from({ length: 200 }, (_, index) => watermark(index + 1));
    const h = harness({ stored: 200, watermarks: moving });

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    expect(h.clock.elapsed()).toBe(CAPTURE_DRAIN_DEFAULTS.maxDrainMs);
    expect(h.stops).toHaveLength(1);
    expect(h.completedFields()).toMatchObject({ drain: 'deadline' });
    expect(
      h.records.some(
        (record) =>
          record.level === 'warn' &&
          record.fields['drain'] === 'deadline' &&
          record.fields['polls'] === 51,
      ),
    ).toBe(true);
  });

  it.each([
    { when: 'on the first read', watermarks: [storeFailure()], elapsed: 0 },
    {
      when: 'part-way through',
      watermarks: [watermark(3), watermark(3), storeFailure()],
      elapsed: 200,
    },
  ])('is unverified when the watermark cannot be read $when', async ({ watermarks, elapsed }) => {
    const h = harness({ watermarks });

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    expect(h.clock.elapsed()).toBe(elapsed);
    expect(h.stops).toHaveLength(1);
    expect(h.completedFields()).toMatchObject({ drain: 'unverified' });
  });

  it('is unverified when the monotonic clock cannot be read', async () => {
    const h = harness(
      {},
      {
        monotonicNow: () => Number.NaN,
      },
    );

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    expect(h.telemetry.captureWatermark).not.toHaveBeenCalled();
    expect(h.completedFields()).toMatchObject({ drain: 'unverified' });
  });

  it('is not applicable to a window closed earlier, which it summarises without waiting', async () => {
    const h = harness({
      status: 'failed',
      capture: { id: CAPTURE_ID, planVersion: 1, startedAt: EPOCH_MS, stoppedAt: EPOCH_MS + 1 },
    });

    const completed = await createCaptureStage(h.deps).complete(h.context, {
      captureId: CAPTURE_ID,
    });

    expect(completed.ok).toBe(true);
    expect(h.telemetry.captureWatermark).not.toHaveBeenCalled();
    expect(h.clock.sleeps).toEqual([]);
    expect(h.stops).toEqual([]);
    expect(h.completedFields()).toMatchObject({ drain: 'not-applicable', stoppedNow: false });
  });

  it('is not applicable to the rollback of a failed arm, which closes the window at once', async () => {
    const h = harness({ status: 'ready', armFails: true, plans: [PLAN_V1] });

    const armed = await createCaptureStage(h.deps).arm(h.context, {
      readiness: {
        satisfied: true,
        perAdapter: [],
        blocking: [],
        degraded: [],
        remediations: [],
        plannedSignals: [],
        deliverableSignals: [],
        evaluatedAt: EPOCH_MS,
        observed: {},
        reloadRequested: false,
      },
    });

    expect(armed.ok).toBe(false);
    expect(h.telemetry.captureWatermark).not.toHaveBeenCalled();
    expect(h.stops).toHaveLength(1);
    expect(h.stops[0]?.next).toBe('ready');
  });

  it('abandons the capture when the call is cancelled mid-barrier, leaving the window open', async () => {
    const controller = new AbortController();
    const h = harness(
      {},
      {
        sleep: (ms) => {
          if (h.clock.elapsed() >= 200) {
            controller.abort();
          }
          return h.clock.timing.sleep(ms, undefined);
        },
      },
    );

    const completed = await createCaptureStage(h.deps).complete({
      ...h.context,
      signal: controller.signal,
    });

    expect(completed.ok).toBe(false);
    if (!completed.ok) {
      expect(completed.error.details?.['reason']).toBe('aborted');
    }
    expect(h.stops).toEqual([]);
    expect(h.progress.filter((call) => call.method === 'stageFailed')).toEqual([]);
  });

  it('replaces an unusable injected duration with the default', async () => {
    const h = harness({}, { pollIntervalMs: 0, quietPeriodMs: Number.NaN });

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    expect(h.clock.elapsed()).toBe(CAPTURE_DRAIN_DEFAULTS.quietPeriodMs);
    expect(new Set(h.clock.sleeps)).toEqual(new Set([CAPTURE_DRAIN_DEFAULTS.pollIntervalMs]));
  });

  it('wakes the default sleeper as soon as the call is cancelled', async () => {
    const controller = new AbortController();
    const h = harness();
    // The real timer and clock, with durations no test could wait out: only an
    // abort that wakes the sleeper lets this call return inside the suite's timeout.
    const deps: CaptureStageDeps = {
      ...h.deps,
      drain: { pollIntervalMs: 60_000, quietPeriodMs: 120_000, maxDrainMs: 120_000 },
    };
    setTimeout(() => {
      controller.abort();
    }, 10);

    const completed = await createCaptureStage(deps).complete({
      ...h.context,
      signal: controller.signal,
    });

    expect(completed.ok).toBe(false);
    if (!completed.ok) {
      expect(completed.error.details?.['reason']).toBe('aborted');
    }
    expect(h.telemetry.captureWatermark).toHaveBeenCalledTimes(1);
    expect(h.stops).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 2. The bounded summary
 * ---------------------------------------------------------------------------------------------- */

describe('the bounded summary', () => {
  /** The `{ limit, offset }` of every page the stage asked the store for. */
  function pagesAsked(h: Harness): { readonly limit: number; readonly offset: number }[] {
    return h.telemetry.pageCaptureForSummary.mock.calls.map((call) => ({
      limit: call[2].limit,
      offset: call[2].offset,
    }));
  }

  /** The finding rows the stage sent, in order. */
  function findingRows(h: Harness): (string | undefined)[] {
    return h.progress.filter((call) => call.method === 'finding').map((call) => call.message);
  }

  /** Stored events large enough that the byte ceiling binds long before the event ceiling. */
  const RICH_EVENT_CHARS = 10_000;

  /** How many rich events reach {@link MAX_SUMMARY_BYTES}. */
  const RICH_EVENTS_TO_BUDGET = Math.ceil(MAX_SUMMARY_BYTES / RICH_EVENT_CHARS);

  /** How many rich events the walk reads: whole pages, up to the first that reaches the budget. */
  const RICH_EVENTS_READ = Math.ceil(RICH_EVENTS_TO_BUDGET / SUMMARY_PAGE_SIZE) * SUMMARY_PAGE_SIZE;

  it('pins its two ceilings and its page size', () => {
    expect(MAX_SUMMARY_EVENTS).toBe(10_000);
    expect(MAX_SUMMARY_BYTES).toBe(16 * 1024 * 1024);
    expect(SUMMARY_PAGE_SIZE).toBe(250);
    expect(MAX_SUMMARY_EVENTS % SUMMARY_PAGE_SIZE).toBe(0);
  });

  it('summarises a capture within both ceilings in full, one small page at a time', async () => {
    const h = harness({ stored: 1_100 });

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    expect(pagesAsked(h)).toEqual([
      { limit: SUMMARY_PAGE_SIZE, offset: 0 },
      { limit: SUMMARY_PAGE_SIZE, offset: 250 },
      { limit: SUMMARY_PAGE_SIZE, offset: 500 },
      { limit: SUMMARY_PAGE_SIZE, offset: 750 },
      { limit: SUMMARY_PAGE_SIZE, offset: 1_000 },
    ]);
    expect(stoppedSummary(h).eventCount).toBe(1_100);
    expect(stoppedSummary(h).coverage).toMatchObject({ storedEvents: 1_100, complete: true });
    expect(h.telemetry.countByKind).not.toHaveBeenCalled();
  });

  it('yields to the event loop between pages', async () => {
    const h = harness({ stored: 900 });
    let ticks = 0;
    let running = true;
    const tick = (): void => {
      ticks += 1;
      if (running) {
        setImmediate(tick);
      }
    };
    setImmediate(tick);
    const seen: number[] = [];
    const read = h.telemetry.pageCaptureForSummary.getMockImplementation();
    if (read === undefined) {
      throw new Error('The telemetry double has no page implementation.');
    }
    h.telemetry.pageCaptureForSummary.mockImplementation((...args) => {
      seen.push(ticks);
      return read(...args);
    });

    const completed = await createCaptureStage(h.deps).complete(h.context);
    running = false;

    expect(completed.ok).toBe(true);
    expect(seen).toHaveLength(4);
    // Every page after the first ran on a later turn of the event loop.
    for (let page = 1; page < seen.length; page += 1) {
      expect(seen[page]).toBeGreaterThan(seen[page - 1] ?? Number.POSITIVE_INFINITY);
    }
  });

  it(
    'stops at the event ceiling and judges emptiness from the exact per-kind counts',
    { timeout: 60_000 },
    async () => {
      // Every interaction lies past the ceiling: a judgement read off the capped
      // summary alone would call this interaction question's capture empty.
      const beyond = 7;
      const h = harness({
        stored: MAX_SUMMARY_EVENTS + beyond,
        kindAt: (index) => (index >= MAX_SUMMARY_EVENTS ? 'interaction' : 'fetch'),
        watermarks: [watermark(MAX_SUMMARY_EVENTS + beyond)],
      });

      const completed = await createCaptureStage(h.deps).complete(h.context);

      expect(completed.ok).toBe(true);
      const pages = pagesAsked(h);
      expect(pages).toHaveLength(MAX_SUMMARY_EVENTS / SUMMARY_PAGE_SIZE);
      expect(pages.every((page) => page.limit === SUMMARY_PAGE_SIZE)).toBe(true);
      expect(stoppedSummary(h).eventCount).toBe(MAX_SUMMARY_EVENTS);
      expect(h.telemetry.countByKind).toHaveBeenCalledTimes(1);
      if (completed.ok) {
        expect(completed.value.emptiness).toMatchObject({
          empty: false,
          eventCount: MAX_SUMMARY_EVENTS + beyond,
          interactionCount: beyond,
        });
        expect(completed.value.next).toBe('analyzing');
      }
      expect(
        h.records.some(
          (record) =>
            record.level === 'warn' &&
            record.fields['ceiling'] === 'events' &&
            record.fields['storedEvents'] === MAX_SUMMARY_EVENTS + beyond &&
            record.fields['summarizedEvents'] === MAX_SUMMARY_EVENTS,
        ),
      ).toBe(true);
    },
  );

  it('stops rich events at the byte ceiling long before the event ceiling', async () => {
    // Every interaction lies past the byte ceiling, which binds after a few
    // pages: only the exact per-kind counts find them.
    const stored = 3_000;
    const h = harness({
      stored,
      storedCharsAt: () => RICH_EVENT_CHARS,
      kindAt: (index) => (index >= 2_000 ? 'interaction' : 'fetch'),
      watermarks: [watermark(stored)],
    });

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    expect(RICH_EVENTS_READ).toBeLessThan(MAX_SUMMARY_EVENTS);
    expect(pagesAsked(h)).toHaveLength(RICH_EVENTS_READ / SUMMARY_PAGE_SIZE);
    // The ceiling is checked between pages: the walk passes it by less than one page.
    expect(RICH_EVENTS_READ - RICH_EVENTS_TO_BUDGET).toBeLessThan(SUMMARY_PAGE_SIZE);
    expect(stoppedSummary(h).eventCount).toBe(RICH_EVENTS_READ);
    expect(stoppedSummary(h).coverage).toEqual({
      storedEvents: stored,
      summarizedEvents: RICH_EVENTS_READ,
      producerDroppedEvents: 0,
      drain: 'quiescent',
      complete: false,
    });
    expect(h.telemetry.countByKind).toHaveBeenCalledTimes(1);
    if (completed.ok) {
      expect(completed.value.emptiness).toMatchObject({
        empty: false,
        eventCount: stored,
        interactionCount: 1_000,
      });
      expect(completed.value.next).toBe('analyzing');
    }
    expect(findingRows(h)).toEqual([
      `Capture evidence is incomplete. The summary covers the first 1,750 of 3,000 captured events; one summary covers at most 16 MiB of stored event data.`,
    ]);
    expect(
      h.records.some(
        (record) =>
          record.level === 'warn' &&
          record.fields['ceiling'] === 'bytes' &&
          record.fields['storedChars'] === RICH_EVENTS_READ * RICH_EVENT_CHARS,
      ),
    ).toBe(true);
  });

  it('reads the exact size of the window when the byte-capped part held no preload events', async () => {
    // The preload's events lie past the byte ceiling: the capped summary shows
    // none, the exact per-kind counts do, and the unreachable preload's flush
    // therefore stays unconfirmed.
    const stored = 2_000;
    const h = harness({
      stored,
      storedCharsAt: () => RICH_EVENT_CHARS,
      kindAt: (index) => (index >= 1_900 ? 'http.server' : index === 0 ? 'interaction' : 'fetch'),
      watermarks: [watermark(stored)],
      disarm: { ...DISARMED, serverAgent: 'unreachable' },
    });

    await createCaptureStage(h.deps).complete(h.context);

    expect(stoppedSummary(h).tierCounts.server).toBe(0);
    expect(stoppedSummary(h).coverage).toMatchObject({
      storedEvents: stored,
      summarizedEvents: RICH_EVENTS_READ,
      drain: 'unverified',
      complete: false,
    });
    expect(findingRows(h)).toEqual([
      'Capture evidence is incomplete. The summary covers the first 1,750 of 2,000 captured events; one summary covers at most 16 MiB of stored event data. Whether every event in flight when the capture stopped arrived could not be confirmed.',
    ]);
  });

  it('reports a walk that stopped at a ceiling exactly where the capture ended as complete', async () => {
    const h = harness({ stored: MAX_SUMMARY_EVENTS, watermarks: [watermark(MAX_SUMMARY_EVENTS)] });

    await createCaptureStage(h.deps).complete(h.context);

    expect(h.telemetry.countByKind).toHaveBeenCalledTimes(1);
    expect(stoppedSummary(h).coverage).toEqual({
      storedEvents: MAX_SUMMARY_EVENTS,
      summarizedEvents: MAX_SUMMARY_EVENTS,
      producerDroppedEvents: 0,
      drain: 'quiescent',
      complete: true,
    });
    expect(findingRows(h)).toEqual([]);
  });

  it('falls back to the summary counts when the exact count of a capped capture fails', async () => {
    const h = harness({
      stored: MAX_SUMMARY_EVENTS + 3,
      kindAt: (index) => (index >= MAX_SUMMARY_EVENTS ? 'interaction' : 'fetch'),
      watermarks: [watermark(MAX_SUMMARY_EVENTS + 3)],
      countByKindFails: true,
    });

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.value.emptiness).toMatchObject({
        empty: true,
        reason: 'no-interaction',
        eventCount: MAX_SUMMARY_EVENTS,
      });
      expect(completed.value.next).toBe('ready');
    }
    // The capture's size is unknown past the rows read, and the summary is
    // still not whole: the coverage says so rather than claiming it covers all.
    expect(stoppedSummary(h).coverage).toMatchObject({
      storedEvents: MAX_SUMMARY_EVENTS,
      summarizedEvents: MAX_SUMMARY_EVENTS,
      complete: false,
    });
    expect(findingRows(h)).toEqual([
      'Capture evidence is incomplete. The summary covers the first 10,000 captured events; the capture may hold more, and one summary covers at most 10,000 events.',
    ]);
    expect(
      h.records.some(
        (record) =>
          record.level === 'warn' &&
          record.fields['code'] === 'STORE_ERROR' &&
          record.fields['ceiling'] === 'events',
      ),
    ).toBe(true);
  });

  it('fails the completion, leaving the window open, when a page cannot be read', async () => {
    const h = harness();
    h.telemetry.pageCaptureForSummary.mockImplementation(() => err(storeFailure()));

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(false);
    if (!completed.ok) {
      expect(completed.error.code).toBe('STORE_ERROR');
    }
    expect(h.stops).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 3. The empty-capture rule (AAP §0.5.5)
 * ---------------------------------------------------------------------------------------------- */

describe('the empty-capture rule', () => {
  /** Zero-filled counts with the given kinds set. */
  function countsOf(
    set: Partial<Record<TelemetryKind, number>>,
  ): Pick<CaptureSummary, 'eventCount' | 'kindCounts'> {
    const kindCounts = Object.fromEntries(
      TELEMETRY_KINDS.map((kind) => [kind, set[kind] ?? 0]),
    ) as Record<TelemetryKind, number>;
    const eventCount = Object.values(kindCounts).reduce((total, count) => total + count, 0);
    return { eventCount, kindCounts };
  }

  it('calls a capture with no event at all empty, whatever was armed', () => {
    for (const agentHooks of [INTERACTION_HOOKS, REQUEST_ONLY_HOOKS, undefined]) {
      expect(
        classifyCaptureEmptiness(countsOf({}), REQUEST_QUESTION, { agentHooks }),
      ).toMatchObject({ empty: true, reason: 'no-events', message: CAPTURE_EMPTY_MESSAGE });
    }
  });

  it('calls an interaction question empty without an interaction even when the hook was off', () => {
    const emptiness = classifyCaptureEmptiness(countsOf({ fetch: 9 }), INTERACTION_QUESTION, {
      agentHooks: REQUEST_ONLY_HOOKS,
    });

    expect(emptiness).toEqual({
      empty: true,
      reason: 'no-interaction',
      message: CAPTURE_EMPTY_MESSAGE,
      eventCount: 9,
      interactionCount: 0,
      interactionRequired: true,
      interactionHookArmed: false,
    });
    expect(Object.isFrozen(emptiness)).toBe(true);
  });

  it('reports the hook as armed, or leaves the diagnostic out when the arming is unknown', () => {
    expect(
      classifyCaptureEmptiness(countsOf({ fetch: 9 }), INTERACTION_QUESTION, {
        agentHooks: INTERACTION_HOOKS,
      }),
    ).toMatchObject({ empty: true, reason: 'no-interaction', interactionHookArmed: true });

    const unknown = classifyCaptureEmptiness(countsOf({ fetch: 9 }), INTERACTION_QUESTION);
    expect(unknown).toMatchObject({ empty: true, reason: 'no-interaction' });
    expect('interactionHookArmed' in unknown).toBe(false);
  });

  it('holds evidence when the interaction was recorded, or the question needs none', () => {
    expect(
      classifyCaptureEmptiness(countsOf({ interaction: 1, fetch: 4 }), INTERACTION_QUESTION, {
        agentHooks: INTERACTION_HOOKS,
      }),
    ).toEqual({
      empty: false,
      eventCount: 5,
      interactionCount: 1,
      interactionRequired: true,
      interactionHookArmed: true,
    });
    expect(
      classifyCaptureEmptiness(countsOf({ fetch: 4 }), REQUEST_QUESTION, {
        agentHooks: REQUEST_ONLY_HOOKS,
      }),
    ).toMatchObject({ empty: false, interactionRequired: false, interactionHookArmed: false });
  });

  it('asks no interaction of an unclassified understanding, whose signals name what is worth capturing', () => {
    // The rules-based provider answers `other` and adds the interaction signal
    // for any selected element; a page that re-renders while the developer does
    // nothing is still evidence, not an empty capture.
    const unclassified = problemUnderstandingSchema.parse({
      ...INTERACTION_QUESTION,
      category: PROBLEM_CATEGORIES[PROBLEM_CATEGORIES.length - 1],
      signalsNeeded: ['interactions', 'react'],
    });
    expect(unclassified.category).toBe('other');
    expect(understandingNeedsInteraction(unclassified)).toBe(false);
    expect(understandingNeedsInteraction(INTERACTION_QUESTION)).toBe(true);
    expect(
      classifyCaptureEmptiness(countsOf({ render: 12 }), unclassified, {
        agentHooks: INTERACTION_HOOKS,
      }),
    ).toEqual({
      empty: false,
      eventCount: 12,
      interactionCount: 0,
      interactionRequired: false,
      interactionHookArmed: true,
    });
    // An empty window is empty whatever the understanding.
    expect(classifyCaptureEmptiness(countsOf({}), unclassified)).toMatchObject({
      empty: true,
      reason: 'no-events',
    });
  });

  it('sends an interaction question captured with the hook off back to ready, and says why', async () => {
    const h = harness({ agentHooks: REQUEST_ONLY_HOOKS, kindAt: () => 'fetch' });

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.value.emptiness).toMatchObject({
        empty: true,
        reason: 'no-interaction',
        interactionHookArmed: false,
      });
      expect(completed.value.next).toBe('ready');
    }
    expect(h.stops.map((stop) => stop.next)).toEqual(['ready']);
    expect(h.progress).toEqual([
      { method: 'finding', stage: 'capture', message: INTERACTION_HOOK_OFF_MESSAGE },
      { method: 'stageCompleted', stage: 'capture', message: CAPTURE_EMPTY_MESSAGE },
    ]);
  });

  it('adds no hook row when the hook was armed and the page was simply not used', async () => {
    const h = harness({ agentHooks: INTERACTION_HOOKS, kindAt: () => 'fetch' });

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    expect(h.stops.map((stop) => stop.next)).toEqual(['ready']);
    expect(h.progress).toEqual([
      { method: 'stageCompleted', stage: 'capture', message: CAPTURE_EMPTY_MESSAGE },
    ]);
  });

  it('judges a capture whose arming is unknown by the question alone', async () => {
    const h = harness({ agentHooks: undefined, kindAt: () => 'fetch' });

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.value.armed.source).toBe('none');
      expect(completed.value.emptiness).toMatchObject({ empty: true, reason: 'no-interaction' });
      expect('interactionHookArmed' in completed.value.emptiness).toBe(false);
    }
    expect(h.progress.map((call) => call.method)).toEqual(['stageCompleted']);
  });

  it('analyses a question that needs no interaction, whatever the hook', async () => {
    const h = harness({
      agentHooks: REQUEST_ONLY_HOOKS,
      understanding: REQUEST_QUESTION,
      kindAt: () => 'fetch',
    });

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    expect(h.stops.map((stop) => stop.next)).toEqual(['analyzing']);
    expect(h.progress).toEqual([
      { method: 'stageCompleted', stage: 'capture', message: undefined },
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 4. Coverage — what the persisted summary and both user interfaces are told
 * ---------------------------------------------------------------------------------------------- */

describe('coverage', () => {
  /** The finding rows the stage sent, in order. */
  function findings(h: Harness): (string | undefined)[] {
    return h.progress.filter((call) => call.method === 'finding').map((call) => call.message);
  }

  /** Everything the stage logged and sent, as one searchable string. */
  function everythingSaid(h: Harness): string {
    return JSON.stringify({ records: h.records, progress: h.progress });
  }

  it('reports a quiet, fully summarised capture without loss as complete, and adds no row', async () => {
    const h = harness();

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    expect(stoppedSummary(h).coverage).toEqual({
      storedEvents: 3,
      summarizedEvents: 3,
      producerDroppedEvents: 0,
      drain: 'quiescent',
      complete: true,
    });
    if (completed.ok) {
      expect(completed.value.summary).toBe(stoppedSummary(h));
    }
    expect(findings(h)).toEqual([]);
    expect(h.completedFields()).toMatchObject({ coverageComplete: true, storedEvents: 3 });
  });

  it.each([
    {
      loss: 42,
      message:
        'Capture evidence is incomplete. 42 events were discarded by a producer before delivery.',
    },
    {
      loss: 1,
      message:
        'Capture evidence is incomplete. 1 event was discarded by a producer before delivery.',
    },
  ])(
    'carries $loss discarded events into the summary and says so before the closing row',
    async ({ loss, message }) => {
      const h = harness({ producerLoss: loss });

      const completed = await createCaptureStage(h.deps).complete(h.context);

      expect(completed.ok).toBe(true);
      expect(h.telemetry.producerLoss).toHaveBeenCalledWith(SESSION_ID, CAPTURE_ID);
      expect(stoppedSummary(h).coverage).toMatchObject({
        producerDroppedEvents: loss,
        complete: false,
      });
      expect(h.progress).toEqual([
        { method: 'finding', stage: 'capture', message },
        { method: 'stageCompleted', stage: 'capture', message: undefined },
      ]);
    },
  );

  it('marks a capture still receiving events at the ceiling incomplete', async () => {
    const moving = Array.from({ length: 200 }, (_, index) => watermark(index + 1));
    const h = harness({ stored: 200, watermarks: moving });

    await createCaptureStage(h.deps).complete(h.context);

    expect(stoppedSummary(h).coverage).toEqual({
      storedEvents: 200,
      summarizedEvents: 200,
      producerDroppedEvents: 0,
      drain: 'deadline',
      complete: false,
    });
    expect(findings(h)).toEqual([
      'Capture evidence is incomplete. Events were still arriving when the capture stopped, so its last events may be missing.',
    ]);
  });

  it('marks a capture whose barrier could not watch the store incomplete', async () => {
    const h = harness({ watermarks: [storeFailure()] });

    await createCaptureStage(h.deps).complete(h.context);

    expect(stoppedSummary(h).coverage).toMatchObject({ drain: 'unverified', complete: false });
    expect(findings(h)).toEqual([
      'Capture evidence is incomplete. Whether every event in flight when the capture stopped arrived could not be confirmed.',
    ]);
  });

  /** The row an unconfirmed flush adds, and the only one. */
  const UNCONFIRMED_FLUSH_ROW =
    'Capture evidence is incomplete. Whether every event in flight when the capture stopped arrived could not be confirmed.';

  /** The warning that names the producers whose flush could not be confirmed. */
  function unconfirmedFlushRecord(h: Harness): Readonly<Record<string, unknown>> | undefined {
    return h.records.find(
      (record) =>
        record.level === 'warn' && record.fields['reason'] === 'producer-flush-unconfirmed',
    )?.fields;
  }

  it.each([
    { tier: 'server', kind: 'http.server' },
    { tier: 'db', kind: 'db.query' },
  ] as const)(
    'marks a quiet capture incomplete when the unreachable preload had sent it $tier events',
    async ({ kind }) => {
      const h = harness({
        disarm: { ...DISARMED, serverAgent: 'unreachable' },
        kindAt: (index) => (index === 0 ? 'interaction' : kind),
      });

      const completed = await createCaptureStage(h.deps).complete(h.context);

      expect(completed.ok).toBe(true);
      expect(stoppedSummary(h).coverage).toEqual({
        storedEvents: 3,
        summarizedEvents: 3,
        producerDroppedEvents: 0,
        drain: 'unverified',
        complete: false,
      });
      expect(findings(h)).toEqual([UNCONFIRMED_FLUSH_ROW]);
      expect(h.completedFields()).toMatchObject({ drain: 'unverified', coverageComplete: false });
      expect(unconfirmedFlushRecord(h)).toMatchObject({
        drain: 'unverified',
        producers: ['server-agent'],
        serverAgent: 'unreachable',
      });
    },
  );

  it('keeps a quiet page-only capture complete when the preload was unreachable', async () => {
    const h = harness({ disarm: { ...DISARMED, serverAgent: 'unreachable' } });

    await createCaptureStage(h.deps).complete(h.context);

    expect(stoppedSummary(h).coverage).toMatchObject({ drain: 'quiescent', complete: true });
    expect(findings(h)).toEqual([]);
    expect(unconfirmedFlushRecord(h)).toBeUndefined();
  });

  it('marks a quiet capture incomplete when the page agent that sent it events was not disarmed', async () => {
    const h = harness({ disarm: { ...DISARMED, agentDisarmed: false } });

    await createCaptureStage(h.deps).complete(h.context);

    expect(stoppedSummary(h).coverage).toMatchObject({ drain: 'unverified', complete: false });
    expect(findings(h)).toEqual([UNCONFIRMED_FLUSH_ROW]);
    expect(unconfirmedFlushRecord(h)).toMatchObject({
      producers: ['page-agent'],
      agentDisarmed: false,
    });
  });

  it('keeps a quiet server-only capture complete when the page agent was not disarmed', async () => {
    const h = harness({
      disarm: { ...DISARMED, agentDisarmed: false },
      understanding: REQUEST_QUESTION,
      kindAt: () => 'http.server',
    });

    await createCaptureStage(h.deps).complete(h.context);

    expect(stoppedSummary(h).coverage).toMatchObject({ drain: 'quiescent', complete: true });
    expect(findings(h)).toEqual([]);
  });

  it('names both contributing producers when the disarm itself failed', async () => {
    const h = harness({
      disarm: new DebuggenError('INTERNAL', 'The disarm could not be sent.'),
      kindAt: (index) => (index === 0 ? 'interaction' : 'db.query'),
    });

    await createCaptureStage(h.deps).complete(h.context);

    expect(stoppedSummary(h).coverage).toMatchObject({ drain: 'unverified', complete: false });
    expect(findings(h)).toEqual([UNCONFIRMED_FLUSH_ROW]);
    expect(unconfirmedFlushRecord(h)).toMatchObject({
      producers: ['page-agent', 'server-agent'],
      disarm: 'failed',
    });
  });

  it('leaves a barrier that ended at its ceiling a deadline, whatever the producers', async () => {
    const moving = Array.from({ length: 200 }, (_, index) => watermark(index + 1));
    const h = harness({
      stored: 200,
      watermarks: moving,
      disarm: { ...DISARMED, serverAgent: 'unreachable' },
      kindAt: () => 'http.server',
    });

    await createCaptureStage(h.deps).complete(h.context);

    expect(stoppedSummary(h).coverage).toMatchObject({ drain: 'deadline', complete: false });
    expect(unconfirmedFlushRecord(h)).toBeUndefined();
  });

  it('does not report a capture complete when the loss total cannot be read', async () => {
    const h = harness();
    h.telemetry.producerLoss.mockImplementation(() => err(storeFailure()));

    await createCaptureStage(h.deps).complete(h.context);

    expect(stoppedSummary(h).coverage).toEqual({
      storedEvents: 3,
      summarizedEvents: 3,
      producerDroppedEvents: 0,
      drain: 'quiescent',
      complete: false,
    });
    expect(findings(h)).toEqual([
      'Capture evidence is incomplete. Whether any producer discarded events before delivery could not be confirmed.',
    ]);
  });

  it('counts stored rows that no longer validate as not summarised', async () => {
    const h = harness();
    const read = h.telemetry.pageCaptureForSummary.getMockImplementation();
    if (read === undefined) {
      throw new Error('The telemetry double has no page implementation.');
    }
    h.telemetry.pageCaptureForSummary.mockImplementation((...args) => {
      const page = read(...args);
      return page.ok ? ok({ ...page.value, rows: page.value.rows.slice(1), skipped: 1 }) : page;
    });

    await createCaptureStage(h.deps).complete(h.context);

    expect(stoppedSummary(h).coverage).toMatchObject({
      storedEvents: 3,
      summarizedEvents: 2,
      complete: false,
    });
    expect(findings(h)).toEqual([
      'Capture evidence is incomplete. The summary covers 2 of 3 captured events; 1 stored event could not be read back.',
    ]);
  });

  it('reports a capped summary as covering part of the capture, adding coverage and nothing else', async () => {
    const stored = MAX_SUMMARY_EVENTS + 7;
    const h = harness({ stored, kindAt: () => 'interaction', watermarks: [watermark(stored)] });

    await createCaptureStage(h.deps).complete(h.context);

    const summary = stoppedSummary(h);
    expect(summary.coverage).toEqual({
      storedEvents: stored,
      summarizedEvents: MAX_SUMMARY_EVENTS,
      producerDroppedEvents: 0,
      drain: 'quiescent',
      complete: false,
    });
    // The coverage is the only addition: every other field — `truncated`
    // included — is exactly the upstream summary of the events read.
    const events = Array.from({ length: MAX_SUMMARY_EVENTS }, (_, index) =>
      eventAt(index, 'interaction'),
    );
    expect(summary).toEqual({
      ...computeCaptureSummary(events, { captureId: CAPTURE_ID, sessionId: SESSION_ID }),
      coverage: summary.coverage,
    });
    expect(findings(h)).toEqual([
      'Capture evidence is incomplete. The summary covers the first 10,000 of 10,007 captured events; one summary covers at most 10,000 events.',
    ]);
  });

  it('orders the rows: incomplete evidence, then the hook, then the empty-capture sentence', async () => {
    const h = harness({ agentHooks: REQUEST_ONLY_HOOKS, kindAt: () => 'fetch', producerLoss: 5 });

    await createCaptureStage(h.deps).complete(h.context);

    expect(h.progress.map((call) => call.message)).toEqual([
      'Capture evidence is incomplete. 5 events were discarded by a producer before delivery.',
      INTERACTION_HOOK_OFF_MESSAGE,
      CAPTURE_EMPTY_MESSAGE,
    ]);
  });

  it('closes the rollback of a failed arm with a not-applicable coverage', async () => {
    const h = harness({ status: 'ready', armFails: true, plans: [PLAN_V1], stored: 0 });

    await createCaptureStage(h.deps).arm(h.context, {
      readiness: {
        satisfied: true,
        perAdapter: [],
        blocking: [],
        degraded: [],
        remediations: [],
        plannedSignals: [],
        deliverableSignals: [],
        evaluatedAt: EPOCH_MS,
        observed: {},
        reloadRequested: false,
      },
    });

    expect(stoppedSummary(h).coverage).toEqual({
      storedEvents: 0,
      summarizedEvents: 0,
      producerDroppedEvents: 0,
      drain: 'not-applicable',
      complete: true,
    });
    expect(findings(h)).toEqual([]);
  });

  it('attaches a not-applicable coverage to a window closed earlier without sending a row', async () => {
    const h = harness({
      status: 'failed',
      producerLoss: 2,
      capture: { id: CAPTURE_ID, planVersion: 1, startedAt: EPOCH_MS, stoppedAt: EPOCH_MS + 1 },
    });

    const completed = await createCaptureStage(h.deps).complete(h.context, {
      captureId: CAPTURE_ID,
    });

    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.value.summary.coverage).toMatchObject({
        drain: 'not-applicable',
        producerDroppedEvents: 2,
        complete: false,
      });
    }
    expect(h.progress).toEqual([]);
  });

  it('hands a stored summary back as it was stored', async () => {
    const stored: CaptureSummary = {
      ...computeCaptureSummary([eventAt(0, 'interaction')], {
        captureId: CAPTURE_ID,
        sessionId: SESSION_ID,
      }),
      coverage: {
        storedEvents: 1,
        summarizedEvents: 1,
        producerDroppedEvents: 0,
        drain: 'quiescent',
        complete: true,
      },
    };
    const h = harness({
      status: 'failed',
      capture: {
        id: CAPTURE_ID,
        planVersion: 1,
        startedAt: EPOCH_MS,
        stoppedAt: EPOCH_MS + 1,
        summary: stored,
      },
    });

    const completed = await createCaptureStage(h.deps).complete(h.context, {
      captureId: CAPTURE_ID,
    });

    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.value.summarySource).toBe('stored');
      expect(completed.value.summary).toEqual(stored);
    }
    expect(h.telemetry.pageCaptureForSummary).not.toHaveBeenCalled();
    expect(h.telemetry.producerLoss).not.toHaveBeenCalled();
    expect(h.telemetry.captureWatermark).not.toHaveBeenCalled();
  });

  it('never reports a capture complete when the ledger cannot vouch for a loss of zero', async () => {
    // The service restarted while the window was open, or the ledger forgot
    // the capture: no loss report is on record, but none may have been lost.
    const h = harness({ lossAccounted: false });

    await createCaptureStage(h.deps).complete(h.context);

    expect(stoppedSummary(h).coverage).toEqual({
      storedEvents: 3,
      summarizedEvents: 3,
      producerDroppedEvents: 0,
      drain: 'quiescent',
      complete: false,
    });
    expect(findings(h)).toEqual([
      'Capture evidence is incomplete. Whether any producer discarded events before delivery could not be confirmed.',
    ]);
    expect(
      h.records.find((record) => record.fields['reason'] === 'producer-loss-unaccounted')?.fields,
    ).toMatchObject({ producerDroppedEvents: 0 });
  });

  it.each([
    {
      loss: 4,
      message:
        'Capture evidence is incomplete. At least 4 events were discarded by a producer before delivery.',
    },
    {
      loss: 1,
      message:
        'Capture evidence is incomplete. At least 1 event was discarded by a producer before delivery.',
    },
  ])('reports an unaccounted total of $loss as a lower bound', async ({ loss, message }) => {
    const h = harness({ producerLoss: loss, lossAccounted: false });

    await createCaptureStage(h.deps).complete(h.context);

    expect(stoppedSummary(h).coverage).toMatchObject({
      producerDroppedEvents: loss,
      complete: false,
    });
    expect(findings(h)).toEqual([message]);
  });

  it('never logs or sends an event name, whatever it reports', async () => {
    const h = harness({
      agentHooks: REQUEST_ONLY_HOOKS,
      kindAt: () => 'fetch',
      producerLoss: 3,
      watermarks: [storeFailure()],
    });

    await createCaptureStage(h.deps).complete(h.context);

    expect(h.progress.length).toBeGreaterThan(1);
    expect(everythingSaid(h)).not.toContain(NAME_SENTINEL);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 5. The producer-loss accounting — begun with the window, released once it is closed
 * ---------------------------------------------------------------------------------------------- */

describe('the producer-loss accounting', () => {
  /** A satisfied readiness verdict with nothing degraded, as the install reports one. */
  const SATISFIED: ReadinessVerdict = {
    satisfied: true,
    perAdapter: [],
    blocking: [],
    degraded: [],
    remediations: [],
    plannedSignals: [],
    deliverableSignals: [],
    evaluatedAt: EPOCH_MS,
    observed: {},
    reloadRequested: false,
  };

  it('begins as soon as the window opens, before the producers are armed', async () => {
    const h = harness({ status: 'ready', plans: [PLAN_V1] });

    const armed = await createCaptureStage(h.deps).arm(h.context, { readiness: SATISFIED });

    expect(armed.ok).toBe(true);
    expect(h.telemetry.beginProducerLossAccounting).toHaveBeenCalledWith(SESSION_ID, CAPTURE_ID);
    expect(h.timeline.slice(0, 3)).toEqual(['startCapture', 'beginProducerLossAccounting', 'arm']);
    expect(h.telemetry.releaseProducerLoss).not.toHaveBeenCalled();
  });

  it('does not fail the arm when the ledger refuses to begin', async () => {
    const h = harness({ status: 'ready', plans: [PLAN_V1] });
    h.telemetry.beginProducerLossAccounting.mockImplementation(() => err(storeFailure()));

    const armed = await createCaptureStage(h.deps).arm(h.context, { readiness: SATISFIED });

    expect(armed.ok).toBe(true);
    expect(
      h.records.some(
        (record) =>
          record.level === 'warn' &&
          record.message.startsWith('The producer-loss ledger could not begin') &&
          record.fields['code'] === 'STORE_ERROR',
      ),
    ).toBe(true);
  });

  it('is read before the window closes and released only after it has closed', async () => {
    const h = harness();
    h.telemetry.producerLoss.mockImplementation(() => {
      h.timeline.push('producerLoss');
      return ok({ droppedEvents: 0, accounted: true });
    });

    await createCaptureStage(h.deps).complete(h.context);

    const read = h.timeline.indexOf('producerLoss');
    const closed = h.timeline.indexOf('stopCapture:analyzing');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(closed);
    expect(h.timeline.indexOf('releaseProducerLoss')).toBeGreaterThan(closed);
    expect(h.telemetry.releaseProducerLoss).toHaveBeenCalledTimes(1);
    expect(h.telemetry.releaseProducerLoss).toHaveBeenCalledWith(SESSION_ID, CAPTURE_ID);
  });

  it('keeps the accounting of a window that could not be closed', async () => {
    const h = harness();
    const deps: CaptureStageDeps = {
      ...h.deps,
      sessionManager: {
        ...h.deps.sessionManager,
        stopCapture: () => Promise.resolve(err(storeFailure())),
      },
    };

    const completed = await createCaptureStage(deps).complete(h.context);

    expect(completed.ok).toBe(false);
    expect(h.telemetry.releaseProducerLoss).not.toHaveBeenCalled();
  });

  it('releases nothing for a window an earlier call closed', async () => {
    const h = harness({
      status: 'failed',
      capture: { id: CAPTURE_ID, planVersion: 1, startedAt: EPOCH_MS, stoppedAt: EPOCH_MS + 1 },
    });

    await createCaptureStage(h.deps).complete(h.context, { captureId: CAPTURE_ID });

    expect(h.telemetry.releaseProducerLoss).not.toHaveBeenCalled();
  });

  it('releases the window a failed arm closed again, after closing it', async () => {
    const h = harness({ status: 'ready', armFails: true, plans: [PLAN_V1], stored: 0 });

    const armed = await createCaptureStage(h.deps).arm(h.context, { readiness: SATISFIED });

    expect(armed.ok).toBe(false);
    expect(h.timeline.slice(0, 3)).toEqual(['startCapture', 'beginProducerLossAccounting', 'arm']);
    expect(h.timeline.at(-1)).toBe('releaseProducerLoss');
    expect(h.timeline.indexOf('stopCapture:ready')).toBeLessThan(
      h.timeline.indexOf('releaseProducerLoss'),
    );
  });

  it('logs a failed release and still completes the capture', async () => {
    const h = harness();
    h.telemetry.releaseProducerLoss.mockImplementation(() => err(storeFailure()));

    const completed = await createCaptureStage(h.deps).complete(h.context);

    expect(completed.ok).toBe(true);
    expect(h.stops).toHaveLength(1);
    expect(
      h.records.some(
        (record) =>
          record.level === 'warn' &&
          record.message.startsWith('The producer-loss ledger entry of a closed capture') &&
          record.fields['code'] === 'STORE_ERROR',
      ),
    ).toBe(true);
  });
});
