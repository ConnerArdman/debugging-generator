/**
 * Unit spec for `confirmCaptureStop` in `../src/background/service-worker.ts` — how the worker
 * answers the panel's "Stop capture" request.
 *
 * The service's `POST /sessions/:id/capture/stop` answers only after the whole stop has run —
 * barrier, summary, analysis and panel — while it announces the closed window at once with the
 * `capture.stopped` broadcast. So the worker answers from whichever arrives first, and an HTTP
 * call the transport lost is settled by reading the session back rather than reported as a stop
 * that failed (AAP §0.5.5: a failure is never presented where there was none, and a success is
 * never presented as a failure).
 *
 * The socket bridge is replaced by in-memory doubles: `stopCapture` and `getSession` answer when a
 * case resolves them, and `subscribe` delivers frames a case emits. Ids are neutral synthetic
 * values (AAP §0.5.4).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createEnvelope, MESSAGE_TYPE, parseSessionRecord } from '@debuggen/protocol';
import type { CaptureStopResponse, ProtocolMessage, SessionRecord } from '@debuggen/protocol';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import { computeCaptureSummary } from '@debuggen/telemetry';
import type { CaptureSummary } from '@debuggen/telemetry';

import type { ProtocolSubscribe } from '../src/background/messages';
import { PORT_REQUEST_TIMEOUT_MS } from '../src/background/ports';
import {
  CAPTURE_STOP_READBACK_TIMEOUT_MS,
  CAPTURE_STOP_REQUEST_TIMEOUT_MS,
  confirmCaptureStop,
} from '../src/background/service-worker';
import type { CaptureStopConfirmDeps } from '../src/background/service-worker';
import { PANEL_PORT_REQUEST_TIMEOUT_MS } from '../src/panel/state/connection';

const SESSION = 'ses_4k2p9dq7m1zx0c3v';
const OTHER_SESSION = 'ses_9m3q7w1e5r2t8y4u';
const CAPTURE = 'cap_7f3q0m2zk1x8ab9c';
const TAB = 41;
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

/** A deferred answer a case settles by hand. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function summary(): CaptureSummary {
  return computeCaptureSummary([], { captureId: CAPTURE, sessionId: SESSION });
}

/** The session read back: its capture stopped with a summary, or still running. */
function sessionRecord(stopped: boolean): SessionRecord {
  const parsed = parseSessionRecord({
    id: SESSION,
    projectRoot: '/workspace/app',
    projectName: 'app',
    devServerUrl: 'http://127.0.0.1:20131/',
    createdAt: T0,
    updatedAt: T0 + 60_000,
    status: stopped ? 'analyzing' : 'capturing',
    question: 'Why is this list slow?',
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [
      stopped
        ? {
            id: CAPTURE,
            planVersion: 1,
            startedAt: T0,
            stoppedAt: T0 + 50_000,
            eventCount: 0,
            summary: summary(),
          }
        : { id: CAPTURE, planVersion: 1, startedAt: T0 },
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

/** The doubles behind one `confirmCaptureStop` call, and what they observed. */
interface Harness {
  readonly deps: CaptureStopConfirmDeps;
  readonly stop: Deferred<Result<CaptureStopResponse, DebuggenError>>;
  readonly read: Deferred<Result<SessionRecord, DebuggenError>>;
  readonly stopCalls: { readonly timeoutMs: number | undefined; readonly signal: AbortSignal }[];
  readonly readCalls: { readonly timeoutMs: number | undefined; readonly signal: AbortSignal }[];
  /** Deliver a frame to the handlers subscribed to its type. */
  readonly emit: (message: ProtocolMessage) => void;
  /** How many handlers are subscribed right now. */
  readonly subscribed: () => number;
}

function createHarness(): Harness {
  const stop = deferred<Result<CaptureStopResponse, DebuggenError>>();
  const read = deferred<Result<SessionRecord, DebuggenError>>();
  const stopCalls: Harness['stopCalls'] = [];
  const readCalls: Harness['readCalls'] = [];
  const handlers = new Map<string, Set<(message: ProtocolMessage) => void>>();
  const subscribe = ((type: string, handler: (message: ProtocolMessage) => void) => {
    const set = handlers.get(type) ?? new Set();
    set.add(handler);
    handlers.set(type, set);
    return () => {
      set.delete(handler);
    };
  }) as unknown as ProtocolSubscribe;
  return {
    deps: {
      stopCapture: (_sessionId, options) => {
        stopCalls.push({ timeoutMs: options.timeoutMs, signal: options.signal as AbortSignal });
        return stop.promise;
      },
      getSession: (_sessionId, options) => {
        readCalls.push({ timeoutMs: options.timeoutMs, signal: options.signal as AbortSignal });
        return read.promise;
      },
      subscribe,
    },
    stop,
    read,
    stopCalls,
    readCalls,
    emit: (message) => {
      for (const handler of Array.from(handlers.get(message.type) ?? [])) {
        handler(message);
      }
    },
    subscribed: () => Array.from(handlers.values()).reduce((total, set) => total + set.size, 0),
  };
}

function stoppedFrame(sessionId: string): ProtocolMessage {
  return createEnvelope(MESSAGE_TYPE.CAPTURE_STOPPED, {
    sessionId,
    captureId: CAPTURE,
    summary: summary(),
  });
}

const TIMED_OUT = new DebuggenError(
  'TRANSPORT_DISCONNECTED',
  'The capture.stop request timed out after 20000 ms',
);

/** Let pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await Promise.resolve();
  }
}

let controllers: AbortController[] = [];

function start(harness: Harness): {
  readonly result: Promise<Result<CaptureStopResponse, DebuggenError>>;
  readonly controller: AbortController;
} {
  const controller = new AbortController();
  controllers.push(controller);
  return {
    result: confirmCaptureStop(harness.deps, SESSION, TAB, controller.signal),
    controller,
  };
}

afterEach(() => {
  for (const controller of controllers) {
    controller.abort();
  }
  controllers = [];
});

describe('confirmCaptureStop — deadlines', () => {
  it('waits longer than a default service call, and answers before the panel gives up', () => {
    // A default call to the service gives up at the port deadline less the worker's margin.
    const defaultServiceDeadline = PORT_REQUEST_TIMEOUT_MS - 5_000;
    expect(CAPTURE_STOP_REQUEST_TIMEOUT_MS).toBeGreaterThan(defaultServiceDeadline);
    expect(CAPTURE_STOP_READBACK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CAPTURE_STOP_REQUEST_TIMEOUT_MS + CAPTURE_STOP_READBACK_TIMEOUT_MS).toBeLessThan(
      PANEL_PORT_REQUEST_TIMEOUT_MS,
    );
  });
});

describe('confirmCaptureStop — whichever answer arrives first', () => {
  it('answers the service’s HTTP answer when it arrives first, and stops watching', async () => {
    const harness = createHarness();
    const { result } = start(harness);
    expect(harness.stopCalls[0]?.timeoutMs).toBe(CAPTURE_STOP_REQUEST_TIMEOUT_MS);

    const answer = ok({ summary: summary() });
    harness.stop.resolve(answer);

    await expect(result).resolves.toBe(answer);
    expect(harness.subscribed()).toBe(0);
    expect(harness.readCalls).toHaveLength(0);
  });

  it('answers the capture.stopped broadcast for the session, and releases the HTTP call', async () => {
    const harness = createHarness();
    const { result } = start(harness);

    harness.emit(stoppedFrame(OTHER_SESSION));
    await flush();
    harness.emit(stoppedFrame(SESSION));

    const answered = await result;
    expect(answered.ok).toBe(true);
    expect(answered.ok ? answered.value.summary.captureId : undefined).toBe(CAPTURE);
    expect(harness.stopCalls[0]?.signal.aborted).toBe(true);
    expect(harness.subscribed()).toBe(0);
  });

  it('answers a refusal from the service unchanged, without reading the session back', async () => {
    const harness = createHarness();
    const { result } = start(harness);
    const refusal = err(
      new DebuggenError('SESSION_INVALID_STATE', 'This session is not capturing.'),
    );

    harness.stop.resolve(refusal);

    await expect(result).resolves.toBe(refusal);
    expect(harness.readCalls).toHaveLength(0);
  });
});

describe('confirmCaptureStop — a call the transport lost', () => {
  it('confirms the stop from the session read back', async () => {
    const harness = createHarness();
    const { result } = start(harness);

    harness.stop.resolve(err(TIMED_OUT));
    await flush();
    expect(harness.readCalls[0]?.timeoutMs).toBe(CAPTURE_STOP_READBACK_TIMEOUT_MS);
    harness.read.resolve(ok(sessionRecord(true)));

    const answered = await result;
    expect(answered.ok).toBe(true);
  });

  it('still takes a capture.stopped that arrives during the read-back', async () => {
    const harness = createHarness();
    const { result } = start(harness);

    harness.stop.resolve(err(TIMED_OUT));
    await flush();
    harness.emit(stoppedFrame(SESSION));

    expect((await result).ok).toBe(true);
    expect(harness.readCalls[0]?.signal.aborted).toBe(true);
  });

  it('answers the original failure when the read-back finds the capture still running', async () => {
    const harness = createHarness();
    const { result } = start(harness);

    harness.stop.resolve(err(TIMED_OUT));
    await flush();
    harness.read.resolve(ok(sessionRecord(false)));

    const answered = await result;
    expect(answered.ok).toBe(false);
    expect(answered.ok ? undefined : answered.error).toBe(TIMED_OUT);
  });

  it('answers the original failure when the read-back fails too', async () => {
    const harness = createHarness();
    const { result } = start(harness);

    harness.stop.resolve(err(TIMED_OUT));
    await flush();
    harness.read.resolve(err(new DebuggenError('TRANSPORT_DISCONNECTED', 'offline')));

    const answered = await result;
    expect(answered.ok ? undefined : answered.error).toBe(TIMED_OUT);
  });
});

describe('confirmCaptureStop — cancellation', () => {
  it('ends the wait at once when the request is cancelled, and releases every call', async () => {
    const harness = createHarness();
    const { result, controller } = start(harness);

    controller.abort();

    const answered = await result;
    expect(answered.ok).toBe(false);
    expect(answered.ok ? undefined : answered.error.code).toBe('TRANSPORT_DISCONNECTED');
    expect(harness.stopCalls[0]?.signal.aborted).toBe(true);
    expect(harness.subscribed()).toBe(0);
  });

  it('answers a request cancelled before it began without calling the service', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort(new DebuggenError('TRANSPORT_DISCONNECTED', 'The panel left.'));

    const answered = await confirmCaptureStop(harness.deps, SESSION, TAB, controller.signal);

    expect(answered.ok ? undefined : answered.error.message).toBe('The panel left.');
    expect(harness.stopCalls).toHaveLength(0);
    expect(harness.subscribed()).toBe(0);
  });
});
