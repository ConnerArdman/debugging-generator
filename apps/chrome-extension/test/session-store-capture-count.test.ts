/**
 * The DevTools panel store's capture counter and stop-failure slice
 * (`src/panel/state/session-store.ts`).
 *
 * The counter beside "Stop capture" is the panel's one running number, and it must be what the
 * capture holds — the service's stored count — not how many events the live tail happened to
 * stream: the tail is bounded and skips the oldest of a burst, which the store still keeps. Each
 * `telemetry.tail` frame carries a per-capture tally (`captures`), and a stopped capture's summary
 * carries `coverage.storedEvents`, which a large capture's capped `summary.eventCount` is not.
 *
 * A failed "Stop capture" request says nothing about the stop when it ended without an answer:
 * the service answers only after analysing the capture, and announces the stop itself with
 * `capture.stopped` long before. So a stop failure is held against its capture and withdrawn as
 * soon as that capture is seen stopped, and `awaitCaptureStopSettled` lets the composition root
 * wait for that confirmation before reporting anything.
 *
 * The store is driven as `src/panel/state/connection.ts` drives it: protocol envelopes from the
 * protocol's own `createEnvelope` go through `applyRelayedMessage`. Every case starts from the
 * pristine store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvelope, parseSessionRecord } from '@debuggen/protocol';
import type { ErrorPayload, SessionRecord, TelemetryTailCaptureTally } from '@debuggen/protocol';
import { newCaptureId, newSessionId } from '@debuggen/shared';
import type { CaptureId, SessionId } from '@debuggen/shared';
import { computeCaptureSummary } from '@debuggen/telemetry';
import type { CaptureSummary, TelemetryEvent } from '@debuggen/telemetry';

import {
  CAPTURE_STOP_CONFIRM_GRACE_MS,
  applyRelayedMessage,
  awaitCaptureStopSettled,
  getPanelSnapshot,
  reportCaptureStopFailure,
  resetPanelStore,
  setBindingState,
  setLastError,
} from '../src/panel/state/session-store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAB_ID = 7;
const ORIGIN = 'http://127.0.0.1:20131';
const BOUND_URL = `${ORIGIN}/catalog`;
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

let sessionId: SessionId;
let captureId: CaptureId;
let otherCaptureId: CaptureId;
let ordinal = 0;

/** A persisted browser event of `capture`, as the tail relays one. */
function tailEvent(capture: CaptureId): TelemetryEvent {
  ordinal += 1;
  const hex = ordinal.toString(16).padStart(16, '0');
  return {
    id: `evt_${hex}`,
    traceId: `${hex}${hex}`,
    spanId: hex,
    kind: 'render',
    name: 'render row',
    startTime: T0 + ordinal,
    duration: 1,
    tier: 'browser',
    attributes: {},
    status: 'ok',
    producerId: 'producer-panel-test',
    seq: ordinal,
    sessionId,
    captureId: capture,
    ingestSeq: ordinal,
  };
}

/** `count` tail events of `capture`. */
function tailEvents(count: number, capture: CaptureId): TelemetryEvent[] {
  return Array.from({ length: count }, () => tailEvent(capture));
}

/** Relay one `telemetry.tail` frame, with the service's per-capture tallies when given. */
function relayTail(
  events: readonly TelemetryEvent[],
  captures?: readonly TelemetryTailCaptureTally[],
): void {
  applyRelayedMessage(
    createEnvelope('telemetry.tail', {
      sessionId,
      events: [...events],
      ...(captures === undefined ? {} : { captures: [...captures] }),
    }),
  );
}

/**
 * A stopped capture's summary whose store held `stored` events although the summary was computed
 * from far fewer — the shape of a large capture the service summarises under its ceiling.
 */
function largeSummary(capture: CaptureId, stored: number): CaptureSummary {
  const summary = computeCaptureSummary([], { captureId: capture, sessionId });
  // The service's summary ceiling, as its capture stage applies it.
  const summarized = Math.min(10_000, stored);
  return {
    ...summary,
    eventCount: summarized,
    coverage: {
      storedEvents: stored,
      summarizedEvents: summarized,
      producerDroppedEvents: 0,
      drain: 'quiescent',
      complete: summarized === stored,
    },
  };
}

function relayStarted(capture: CaptureId, ts = T0 + 1_000): void {
  applyRelayedMessage(createEnvelope('capture.started', { sessionId, captureId: capture }, { ts }));
}

function relayStopped(capture: CaptureId, summary: CaptureSummary, ts = T0 + 60_000): void {
  applyRelayedMessage(
    createEnvelope('capture.stopped', { sessionId, captureId: capture, summary }, { ts }),
  );
}

/** A validated record whose only capture is `capture`, stopped with `summary` when given. */
function sessionRecord(
  capture: CaptureId,
  updatedAt: number,
  stopped?: { readonly summary: CaptureSummary; readonly eventCount: number },
): SessionRecord {
  const parsed = parseSessionRecord({
    id: sessionId,
    projectRoot: '/workspace/app',
    projectName: 'app',
    devServerUrl: `${ORIGIN}/`,
    boundTab: { tabId: TAB_ID, url: BOUND_URL },
    createdAt: T0,
    updatedAt,
    status: stopped === undefined ? 'capturing' : 'analyzing',
    question: 'Why is this list slow?',
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [
      stopped === undefined
        ? { id: capture, planVersion: 1, startedAt: T0 + 1_000 }
        : {
            id: capture,
            planVersion: 1,
            startedAt: T0 + 1_000,
            stoppedAt: T0 + 60_000,
            eventCount: stopped.eventCount,
            summary: stopped.summary,
          },
    ],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
  });
  if (!parsed.ok) {
    throw new Error(`The session record fixture is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

function relayUpdated(session: SessionRecord): void {
  applyRelayedMessage(createEnvelope('session.updated', { session }));
}

/** Bind the panel's tab to the session and start `captureId`. */
function bindAndStart(): void {
  setBindingState({ kind: 'bound', sessionId, tabId: TAB_ID, url: BOUND_URL });
  relayStarted(captureId);
}

const STOP_TIMEOUT: ErrorPayload = Object.freeze({
  code: 'TRANSPORT_DISCONNECTED',
  message: 'Could not stop the capture: The capture.stop request timed out after 20000 ms',
});

beforeEach(() => {
  resetPanelStore({ includeConnection: true });
  sessionId = newSessionId();
  captureId = newCaptureId();
  otherCaptureId = newCaptureId();
});

afterEach(() => {
  vi.useRealTimers();
  resetPanelStore({ includeConnection: true });
});

// ---------------------------------------------------------------------------
// The counter follows the store, not the stream
// ---------------------------------------------------------------------------

describe('the capture counter — tallies from telemetry.tail', () => {
  it('counts what the service stored, however few events the frame streamed', () => {
    bindAndStart();
    relayTail(tailEvents(200, captureId), [
      { captureId, storedEvents: 10_158, skippedEvents: 1_800 },
    ]);

    const capture = getPanelSnapshot().capture;
    expect(capture.eventCount).toBe(10_158);
    expect(capture.tailSkipped).toBe(1_800);
    expect(getPanelSnapshot().liveTail).toHaveLength(200);
  });

  it('never lowers the count or the skipped total for the same capture', () => {
    bindAndStart();
    relayTail(tailEvents(2, captureId), [{ captureId, storedEvents: 500, skippedEvents: 40 }]);
    relayTail(tailEvents(2, captureId), [{ captureId, storedEvents: 300, skippedEvents: 10 }]);

    expect(getPanelSnapshot().capture).toMatchObject({ eventCount: 500, tailSkipped: 40 });
  });

  it('ignores a tally of another capture, and a frame whose tallies omit the capture on screen', () => {
    bindAndStart();
    relayTail(tailEvents(3, captureId), [{ captureId, storedEvents: 3, skippedEvents: 0 }]);
    relayTail(tailEvents(5, otherCaptureId), [
      { captureId: otherCaptureId, storedEvents: 9_999, skippedEvents: 9 },
    ]);

    expect(getPanelSnapshot().capture).toMatchObject({
      captureId,
      eventCount: 3,
      tailSkipped: 0,
    });
  });

  it('without tallies (an older service), counts only the running capture’s own events', () => {
    bindAndStart();
    relayTail([...tailEvents(4, captureId), ...tailEvents(6, otherCaptureId)]);

    expect(getPanelSnapshot().capture.eventCount).toBe(4);
  });

  it('counts nothing while no capture is on screen', () => {
    setBindingState({ kind: 'bound', sessionId, tabId: TAB_ID, url: BOUND_URL });
    relayTail(tailEvents(7, captureId), [{ captureId, storedEvents: 7, skippedEvents: 0 }]);
    relayTail(tailEvents(3, captureId));

    expect(getPanelSnapshot().capture).toMatchObject({ captureId: undefined, eventCount: 0 });
  });
});

describe('the capture counter — a stopped capture', () => {
  it('states the summary’s stored count, not its capped eventCount', () => {
    bindAndStart();
    relayTail(tailEvents(10, captureId), [
      { captureId, storedEvents: 50_000, skippedEvents: 30_000 },
    ]);

    relayStopped(captureId, largeSummary(captureId, 68_111));

    const capture = getPanelSnapshot().capture;
    expect(capture.active).toBe(false);
    expect(capture.eventCount).toBe(68_111);
    // The tail's own skipped count survives the stop: the pane still says it was not streamed.
    expect(capture.tailSkipped).toBe(30_000);
  });

  it('keeps the summary’s count when a late tally arrives, while its skipped count still follows', () => {
    bindAndStart();
    relayStopped(captureId, largeSummary(captureId, 1_200));

    relayTail(tailEvents(2, captureId), [{ captureId, storedEvents: 1_500, skippedEvents: 300 }]);
    relayTail(tailEvents(2, captureId));

    expect(getPanelSnapshot().capture).toMatchObject({
      active: false,
      eventCount: 1_200,
      tailSkipped: 300,
    });
  });

  it('repairs a missed capture.stopped from the record the reconnect replays', () => {
    bindAndStart();
    relayUpdated(sessionRecord(captureId, T0 + 2_000));
    relayTail(tailEvents(3, captureId), [{ captureId, storedEvents: 3_200, skippedEvents: 100 }]);

    // The socket was down when the service announced the stop; the replayed record reports it.
    relayUpdated(
      sessionRecord(captureId, T0 + 61_000, {
        summary: largeSummary(captureId, 68_111),
        eventCount: 10_000,
      }),
    );

    const capture = getPanelSnapshot().capture;
    expect(capture.active).toBe(false);
    expect(capture.eventCount).toBe(68_111);
    expect(capture.summary?.coverage?.storedEvents).toBe(68_111);
    expect(capture.tailSkipped).toBe(100);
  });

  it('keeps a capture seen stopped stopped when an older record still lists it running', () => {
    bindAndStart();
    relayStopped(captureId, largeSummary(captureId, 900));

    relayUpdated(sessionRecord(captureId, T0 + 70_000));

    expect(getPanelSnapshot().capture).toMatchObject({ active: false, eventCount: 900 });
  });
});

// ---------------------------------------------------------------------------
// A stop that failed without an answer
// ---------------------------------------------------------------------------

describe('reportCaptureStopFailure', () => {
  it('shows the failure while the capture still runs, and withdraws it once the stop is seen', () => {
    bindAndStart();

    reportCaptureStopFailure(STOP_TIMEOUT, captureId);
    expect(getPanelSnapshot().lastError).toEqual(STOP_TIMEOUT);
    expect(getPanelSnapshot().capture.stopFailure).toEqual(STOP_TIMEOUT);

    relayStopped(captureId, largeSummary(captureId, 400));
    expect(getPanelSnapshot().lastError).toBeUndefined();
    expect(getPanelSnapshot().capture.stopFailure).toBeUndefined();
  });

  it('withdraws it when the replayed record, not capture.stopped, reports the stop', () => {
    bindAndStart();
    relayUpdated(sessionRecord(captureId, T0 + 2_000));
    reportCaptureStopFailure(STOP_TIMEOUT, captureId);

    relayUpdated(
      sessionRecord(captureId, T0 + 61_000, {
        summary: largeSummary(captureId, 400),
        eventCount: 400,
      }),
    );

    expect(getPanelSnapshot().lastError).toBeUndefined();
  });

  it('shows nothing when the capture is already seen stopped', () => {
    bindAndStart();
    relayStopped(captureId, largeSummary(captureId, 400));

    reportCaptureStopFailure(STOP_TIMEOUT, captureId);

    expect(getPanelSnapshot().lastError).toBeUndefined();
    expect(getPanelSnapshot().capture.stopFailure).toBeUndefined();
  });

  it('shows nothing against a different capture than the one the stop was for', () => {
    bindAndStart();
    relayStopped(captureId, largeSummary(captureId, 400));
    relayStarted(otherCaptureId, T0 + 90_000);

    reportCaptureStopFailure(STOP_TIMEOUT, captureId);

    expect(getPanelSnapshot().lastError).toBeUndefined();
    expect(getPanelSnapshot().capture).toMatchObject({ captureId: otherCaptureId, active: true });
  });

  it('keeps a failure that was real: the capture never stopped', () => {
    bindAndStart();
    reportCaptureStopFailure(STOP_TIMEOUT, captureId);
    relayTail(tailEvents(2, captureId), [{ captureId, storedEvents: 20, skippedEvents: 0 }]);

    expect(getPanelSnapshot().lastError).toEqual(STOP_TIMEOUT);
  });

  it('leaves an error reported since in place when the stop is later seen', () => {
    bindAndStart();
    reportCaptureStopFailure(STOP_TIMEOUT, captureId);
    const later: ErrorPayload = { code: 'INTERNAL', message: 'Something else failed.' };
    setLastError(later);

    relayStopped(captureId, largeSummary(captureId, 400));

    expect(getPanelSnapshot().lastError).toEqual(later);
    expect(getPanelSnapshot().capture.stopFailure).toBeUndefined();
  });
});

describe('awaitCaptureStopSettled', () => {
  it('resolves true at once when the capture is not running', async () => {
    bindAndStart();
    relayStopped(captureId, largeSummary(captureId, 1));

    await expect(awaitCaptureStopSettled(captureId, 10)).resolves.toBe(true);
  });

  it('resolves true when capture.stopped arrives within the grace period', async () => {
    vi.useFakeTimers();
    bindAndStart();
    const settled = awaitCaptureStopSettled(captureId);

    vi.advanceTimersByTime(CAPTURE_STOP_CONFIRM_GRACE_MS - 1);
    relayStopped(captureId, largeSummary(captureId, 5));

    await expect(settled).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves false when the capture still runs after the grace period', async () => {
    vi.useFakeTimers();
    bindAndStart();
    const settled = awaitCaptureStopSettled(captureId);

    vi.advanceTimersByTime(CAPTURE_STOP_CONFIRM_GRACE_MS);

    await expect(settled).resolves.toBe(false);
    expect(getPanelSnapshot().capture.active).toBe(true);
  });

  it('resolves true when the panel leaves the session meanwhile', async () => {
    vi.useFakeTimers();
    bindAndStart();
    const settled = awaitCaptureStopSettled(captureId);

    resetPanelStore({ includeConnection: true });

    await expect(settled).resolves.toBe(true);
  });
});
