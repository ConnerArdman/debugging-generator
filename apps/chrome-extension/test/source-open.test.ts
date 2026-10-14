/**
 * Unit spec for `forwardSourceOpen` in `../src/background/service-worker.ts` —
 * the worker's half of the click-to-source round trip.
 *
 * The product guarantee held here: a source click is answered by what the
 * editor did, never by whether a socket queued a frame. So the spec asserts
 * that the worker
 *
 * - subscribes to `source.result` and `error` **before** it sends, and sends
 *   the panel's payload unmodified under the id it minted;
 * - settles only on an answer whose `ref` is that id (and, for `source.result`,
 *   whose session is the request's), ignoring every other frame;
 * - maps `opened` → `{ forwarded: true }`, `no-editor` → `{ forwarded: false }`
 *   (the panel's URI fallback), and `failed`, a refusing `error` frame, the
 *   deadline and a cancellation onto typed failures carrying the `ref`;
 * - releases both subscriptions, the abort listener and the timer on every
 *   exit path, so a late answer changes nothing;
 * - reserves every id in the worker's ledger before the send, so the relay
 *   sink withholds the service's correlated `error` refusal from the panels'
 *   general error state (`createSourceOpenRefLedger`,
 *   `isAnsweredSourceOpenRefusal`), and refuses a request **before** sending
 *   it while the ledger is full, rather than evicting an id whose refusal can
 *   still arrive;
 * - forgets an id only when its answer arrived, its frame was never sent, or
 *   the socket it was written to closed;
 * - forwards the service's failure code with a fixed sentence, never its text;
 * - never logs the location.
 *
 * The last block drives the real port hub (`../src/background/ports.ts`) with
 * two panels on two tabs, more outstanding requests than the ledger holds and
 * a refusal quoting a private file name, and asserts that neither panel —
 * the requesting one included — receives that sentence.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). The helper is fully injectable, so
 * every dependency is a recording fake local to this file: a subscribe that
 * dispatches through the protocol's own `isMessageOfType`, a send that records
 * its frames, a manual timer API whose handles are fired by hand, and a
 * recording logger. Importing the worker module composes nothing — its
 * bootstrap finds no `chrome` global. Ids and paths are neutral synthetic
 * values (AAP §0.5.4).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createEnvelope, isMessageOfType, SOURCE_OPEN_RESULT_TIMEOUT_MS } from '@debuggen/protocol';
import type {
  MessagePayload,
  MessageType,
  ProtocolMessage,
  SendOutcome,
  SourceResultPayload,
} from '@debuggen/protocol';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel, Result, SourceLocation } from '@debuggen/shared';

import { workerError } from '../src/background/messages';
import type { ProtocolSend, ProtocolSubscribe, WorkerTimerApi } from '../src/background/messages';
import { createPortHub } from '../src/background/ports';
import type { PortHub, PortRequestHandlers } from '../src/background/ports';
import {
  createSourceOpenRefLedger,
  createSourceOpenRelayFilter,
  createSourceOpenSocketTracker,
  forwardSourceOpen,
  isAnsweredSourceOpenRefusal,
  SOURCE_OPEN_ABORTED_REASON,
  SOURCE_OPEN_FAILED_MESSAGE,
  SOURCE_OPEN_MAX_OUTSTANDING,
  SOURCE_OPEN_REFUSED_MESSAGE,
  SOURCE_OPEN_TIMEOUT_REASON,
} from '../src/background/service-worker';
import type {
  SourceOpenForwardDeps,
  SourceOpenRefLedger,
  SourceOpenSocketStatus,
} from '../src/background/service-worker';
import {
  EXTENSION_CHANNEL,
  isPortPush,
  isPortResponse,
  PORT_PANEL,
  PORT_PROTOCOL_VERSION,
} from '../src/shared/messages';
import type { PortResponse } from '../src/shared/messages';

/*
 * ===========================================================================
 * Fixtures
 * ===========================================================================
 */

const SESSION_ID = 'ses_source_open_a';
const OTHER_SESSION_ID = 'ses_source_open_b';
const MINTED_ID = 'msg_source_open_1';

/** A file name no log line may ever contain. */
const PRIVATE_FILE = 'src/private/sentinel-location.ts';

const LOCATION: SourceLocation = {
  file: PRIVATE_FILE,
  line: 12,
  column: 5,
  resolvedBy: 'code-graph',
  confidence: 0.9,
};

const PAYLOAD: MessagePayload<'source.open'> = { sessionId: SESSION_ID, location: LOCATION };

/*
 * ===========================================================================
 * Fakes
 * ===========================================================================
 */

interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

function createRecordingLogger(entries: LogEntry[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: { ...bindings, ...fields } });
    };
  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (more) => createRecordingLogger(entries, { ...bindings, ...more }),
  };
}

/** One armed timer of the manual timer API. */
interface ArmedTimer {
  readonly handle: number;
  readonly ms: number;
  readonly handler: () => void;
}

/** Everything a case drives or inspects. */
interface Harness {
  readonly deps: SourceOpenForwardDeps;
  /** The live subscriptions, per message type. */
  readonly handlers: Map<MessageType, Set<(message: ProtocolMessage) => void>>;
  /** Every call to `subscribe` and `send`, in order. */
  readonly calls: string[];
  readonly send: Mock<ProtocolSend>;
  readonly armed: Map<number, ArmedTimer>;
  readonly cleared: number[];
  readonly logs: LogEntry[];
  /** Deliver one inbound frame to every live subscriber of its type. */
  readonly deliver: (message: ProtocolMessage) => void;
  /** Fire the one armed timer. */
  readonly fireTimer: () => void;
  /** How many subscriptions are still live, across all types. */
  readonly liveSubscriptions: () => number;
}

function createHarness(overrides: Partial<SourceOpenForwardDeps> = {}): Harness {
  const handlers = new Map<MessageType, Set<(message: ProtocolMessage) => void>>();
  const calls: string[] = [];
  const armed = new Map<number, ArmedTimer>();
  const cleared: number[] = [];
  const logs: LogEntry[] = [];
  let nextHandle = 1;

  const subscribe: ProtocolSubscribe = (type, handler) => {
    calls.push(`subscribe:${type}`);
    const dispatch = (message: ProtocolMessage): void => {
      if (isMessageOfType(message, type)) {
        handler(message);
      }
    };
    const registered = handlers.get(type) ?? new Set<(message: ProtocolMessage) => void>();
    registered.add(dispatch);
    handlers.set(type, registered);
    return () => {
      handlers.get(type)?.delete(dispatch);
    };
  };

  const send = vi.fn<ProtocolSend>((type) => {
    calls.push(`send:${type}`);
    return ok<SendOutcome>('sent');
  });

  const timers: WorkerTimerApi = {
    setTimeout: (handler, ms) => {
      const handle = nextHandle;
      nextHandle += 1;
      armed.set(handle, { handle, ms, handler });
      return handle;
    },
    clearTimeout: (handle) => {
      cleared.push(handle);
      armed.delete(handle);
    },
  };

  const deps: SourceOpenForwardDeps = {
    send,
    subscribe,
    timers,
    newId: () => MINTED_ID,
    logger: createRecordingLogger(logs),
    ...overrides,
  };

  return {
    deps,
    handlers,
    calls,
    send,
    armed,
    cleared,
    logs,
    deliver: (message) => {
      for (const dispatch of [...(handlers.get(message.type) ?? [])]) {
        dispatch(message);
      }
    },
    fireTimer: () => {
      const [timer, ...rest] = [...armed.values()];
      expect(timer, 'exactly one armed timer').toBeDefined();
      expect(rest).toHaveLength(0);
      if (timer !== undefined) {
        armed.delete(timer.handle);
        timer.handler();
      }
    },
    liveSubscriptions: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

function sourceResult(payload: SourceResultPayload): ProtocolMessage {
  return createEnvelope('source.result', payload);
}

function errorFrame(payload: MessagePayload<'error'>): ProtocolMessage {
  return createEnvelope('error', payload);
}

/** The failure of a settled `Result`, asserting that it failed. */
function failureOf<T>(result: Result<T, DebuggenError>): DebuggenError {
  expect(result.ok, 'the result is a failure').toBe(false);
  if (result.ok) {
    throw new Error('expected a failure');
  }
  return result.error;
}

/** Whether a promise has settled, without waiting on it indefinitely. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending');
  const winner = await Promise.race([promise, Promise.resolve(pending)]);
  return winner !== pending;
}

/** Assert every resource the helper held was released. */
function expectReleased(harness: Harness): void {
  expect(harness.liveSubscriptions(), 'no live subscription').toBe(0);
  expect(harness.armed.size, 'no armed timer').toBe(0);
}

/*
 * ===========================================================================
 * Cases
 * ===========================================================================
 */

describe('forwardSourceOpen', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  describe('sending', () => {
    it('subscribes to source.result and error before it sends', async () => {
      const answer = forwardSourceOpen(harness.deps, PAYLOAD);

      expect(harness.calls).toEqual([
        'subscribe:source.result',
        'subscribe:error',
        'send:source.open',
      ]);
      harness.deliver(sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'opened' }));
      await answer;
    });

    it('sends the panel payload unmodified, by reference, under the minted id', async () => {
      const answer = forwardSourceOpen(harness.deps, PAYLOAD);

      expect(harness.send).toHaveBeenCalledTimes(1);
      const [type, payload, options] = harness.send.mock.calls[0] ?? [];
      expect(type).toBe('source.open');
      expect(payload).toBe(PAYLOAD);
      expect(options).toEqual({ id: MINTED_ID });
      harness.deliver(sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'opened' }));
      await answer;
    });

    it('mints a protocol message id by default, within the 64-character ref bound', async () => {
      const defaulted = createHarness({ newId: undefined });
      const answer = forwardSourceOpen(defaulted.deps, PAYLOAD);

      const id = defaulted.send.mock.calls[0]?.[2]?.id;
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^msg_/u);
      expect((id ?? '').length).toBeLessThanOrEqual(64);
      defaulted.deliver(sourceResult({ sessionId: SESSION_ID, ref: id ?? '', status: 'opened' }));
      await expect(answer).resolves.toEqual(ok({ forwarded: true }));
    });

    it('arms the protocol deadline once the frame is handed over', () => {
      void forwardSourceOpen(harness.deps, PAYLOAD);

      expect([...harness.armed.values()].map((timer) => timer.ms)).toEqual([
        SOURCE_OPEN_RESULT_TIMEOUT_MS,
      ]);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'replaces a timeoutMs of %s by the protocol deadline',
      (timeoutMs) => {
        const custom = createHarness({ timeoutMs });
        void forwardSourceOpen(custom.deps, PAYLOAD);

        expect([...custom.armed.values()].map((timer) => timer.ms)).toEqual([
          SOURCE_OPEN_RESULT_TIMEOUT_MS,
        ]);
      },
    );

    it('honours a positive timeoutMs', () => {
      const custom = createHarness({ timeoutMs: 250 });
      void forwardSourceOpen(custom.deps, PAYLOAD);

      expect([...custom.armed.values()].map((timer) => timer.ms)).toEqual([250]);
    });
  });

  describe('source.result', () => {
    it('answers forwarded: true when the editor opened the location', async () => {
      const answer = forwardSourceOpen(harness.deps, PAYLOAD);
      harness.deliver(sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'opened' }));

      await expect(answer).resolves.toEqual(ok({ forwarded: true }));
      expectReleased(harness);
      expect(harness.cleared).toEqual([1]);
    });

    it('answers forwarded: false when no editor is connected', async () => {
      const answer = forwardSourceOpen(harness.deps, PAYLOAD);
      harness.deliver(sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'no-editor' }));

      await expect(answer).resolves.toEqual(ok({ forwarded: false }));
      expectReleased(harness);
    });

    it('answers a failed result with its code and ref, and a fixed sentence in place of its text', async () => {
      const answer = forwardSourceOpen(harness.deps, PAYLOAD);
      harness.deliver(
        sourceResult({
          sessionId: SESSION_ID,
          ref: MINTED_ID,
          status: 'failed',
          error: {
            code: 'PATH_OUTSIDE_PROJECT',
            message: `${PRIVATE_FILE} is outside the project.`,
            hint: `Open ${PRIVATE_FILE} from the Explorer.`,
          },
        }),
      );

      const failure = failureOf(await answer);
      expect(failure).toBeInstanceOf(DebuggenError);
      expect(failure.code).toBe('PATH_OUTSIDE_PROJECT');
      expect(failure.message).toBe(SOURCE_OPEN_FAILED_MESSAGE);
      expect(failure.hint).toBeUndefined();
      expect(failure.details).toEqual({ ref: MINTED_ID });
      expect(JSON.stringify(failure.toPayload())).not.toContain(PRIVATE_FILE);
      expectReleased(harness);
    });

    it('answers a failed result without a hint as a failure without one', async () => {
      const answer = forwardSourceOpen(harness.deps, PAYLOAD);
      harness.deliver(
        sourceResult({
          sessionId: SESSION_ID,
          ref: MINTED_ID,
          status: 'failed',
          error: { code: 'TRANSPORT_DISCONNECTED', message: 'The editor did not answer.' },
        }),
      );

      const failure = failureOf(await answer);
      expect(failure.code).toBe('TRANSPORT_DISCONNECTED');
      expect(failure.message).toBe(SOURCE_OPEN_FAILED_MESSAGE);
      expect(failure.hint).toBeUndefined();
      expect(failure.details).toEqual({ ref: MINTED_ID });
    });

    it('ignores a result for another request', async () => {
      const answer = forwardSourceOpen(harness.deps, PAYLOAD);
      harness.deliver(
        sourceResult({ sessionId: SESSION_ID, ref: 'msg_someone_else', status: 'no-editor' }),
      );

      expect(await isSettled(answer)).toBe(false);
      expect(harness.liveSubscriptions()).toBe(2);
      harness.deliver(sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'opened' }));
      await expect(answer).resolves.toEqual(ok({ forwarded: true }));
    });

    it('ignores, and logs, a result with this ref that names another session', async () => {
      const answer = forwardSourceOpen(harness.deps, PAYLOAD);
      harness.deliver(
        sourceResult({ sessionId: OTHER_SESSION_ID, ref: MINTED_ID, status: 'no-editor' }),
      );

      expect(await isSettled(answer)).toBe(false);
      expect(
        harness.logs.some(
          (entry) => entry.level === 'warn' && entry.message.includes('another session'),
        ),
      ).toBe(true);
      harness.deliver(sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'opened' }));
      await expect(answer).resolves.toEqual(ok({ forwarded: true }));
    });

    it('settles once: a second answer for the same ref changes nothing', async () => {
      const answer = forwardSourceOpen(harness.deps, PAYLOAD);
      const opened = sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'opened' });
      harness.deliver(opened);
      harness.deliver(sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'no-editor' }));

      await expect(answer).resolves.toEqual(ok({ forwarded: true }));
      expectReleased(harness);
    });

    it('settles on an answer delivered while the frame is being handed over, arming no timer', async () => {
      const synchronous = createHarness();
      synchronous.send.mockImplementation(() => {
        synchronous.deliver(
          sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'no-editor' }),
        );
        return ok<SendOutcome>('queued');
      });

      await expect(forwardSourceOpen(synchronous.deps, PAYLOAD)).resolves.toEqual(
        ok({ forwarded: false }),
      );
      expectReleased(synchronous);
      expect(synchronous.cleared).toEqual([]);
    });
  });

  describe('error frames', () => {
    it('answers a refusing error frame with its code and ref, and a fixed sentence', async () => {
      const answer = forwardSourceOpen(harness.deps, PAYLOAD);
      harness.deliver(
        errorFrame({
          code: 'TAB_NOT_BOUND',
          message: `Not bound: ${PRIVATE_FILE}`,
          ref: MINTED_ID,
        }),
      );

      const failure = failureOf(await answer);
      expect(failure.code).toBe('TAB_NOT_BOUND');
      expect(failure.message).toBe(SOURCE_OPEN_REFUSED_MESSAGE);
      expect(failure.details).toEqual({ ref: MINTED_ID });
      expectReleased(harness);
    });

    it('ignores an error frame for another ref, or with none', async () => {
      const answer = forwardSourceOpen(harness.deps, PAYLOAD);
      harness.deliver(errorFrame({ code: 'INTERNAL', message: 'Unrelated.', ref: 'msg_other' }));
      harness.deliver(errorFrame({ code: 'INTERNAL', message: 'Unrelated.' }));

      expect(await isSettled(answer)).toBe(false);
      harness.deliver(sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'opened' }));
      await expect(answer).resolves.toEqual(ok({ forwarded: true }));
    });
  });

  describe('the deadline', () => {
    it('answers TRANSPORT_DISCONNECTED with the timeout reason and the ref', async () => {
      const answer = forwardSourceOpen(harness.deps, PAYLOAD);
      harness.fireTimer();

      const failure = failureOf(await answer);
      expect(failure.code).toBe('TRANSPORT_DISCONNECTED');
      expect(failure.hint).toEqual(expect.any(String));
      expect(failure.details).toEqual({
        reason: SOURCE_OPEN_TIMEOUT_REASON,
        ref: MINTED_ID,
        timeoutMs: SOURCE_OPEN_RESULT_TIMEOUT_MS,
      });
      expectReleased(harness);
    });

    it('drops an answer that arrives after the deadline', async () => {
      const answer = forwardSourceOpen(harness.deps, PAYLOAD);
      harness.fireTimer();
      harness.deliver(sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'opened' }));

      expect(failureOf(await answer).details?.reason).toBe(SOURCE_OPEN_TIMEOUT_REASON);
    });
  });

  describe('cancellation', () => {
    it('answers a cancellation while waiting, and releases everything', async () => {
      const controller = new AbortController();
      const answer = forwardSourceOpen(harness.deps, PAYLOAD, controller.signal);
      controller.abort(workerError('TRANSPORT_DISCONNECTED', 'The panel went away.'));

      const failure = failureOf(await answer);
      expect(failure.code).toBe('TRANSPORT_DISCONNECTED');
      expect(failure.details).toEqual({ reason: SOURCE_OPEN_ABORTED_REASON, ref: MINTED_ID });
      expectReleased(harness);
      expect(harness.cleared).toEqual([1]);
    });

    it('removes its abort listener when an answer settles first', async () => {
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      const answer = forwardSourceOpen(harness.deps, PAYLOAD, controller.signal);
      harness.deliver(sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'opened' }));

      await expect(answer).resolves.toEqual(ok({ forwarded: true }));
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
      controller.abort();
      await expect(answer).resolves.toEqual(ok({ forwarded: true }));
    });

    it('sends nothing for a request already cancelled', async () => {
      const controller = new AbortController();
      controller.abort();

      const failure = failureOf(await forwardSourceOpen(harness.deps, PAYLOAD, controller.signal));
      expect(failure.details).toEqual({ reason: SOURCE_OPEN_ABORTED_REASON, ref: MINTED_ID });
      expect(harness.calls).toEqual([]);
      expectReleased(harness);
    });
  });

  describe('send failures', () => {
    it('answers the socket client refusal as it is, releasing both subscriptions', async () => {
      const refusing = createHarness();
      const refusal = workerError('TRANSPORT_DISCONNECTED', 'The socket is closed.');
      refusing.send.mockReturnValue(err(refusal));

      const failure = failureOf(await forwardSourceOpen(refusing.deps, PAYLOAD));
      expect(failure).toBe(refusal);
      expectReleased(refusing);
      expect(refusing.cleared).toEqual([]);
    });

    it('answers a throwing send as INTERNAL, without rejecting', async () => {
      const throwing = createHarness();
      throwing.send.mockImplementation(() => {
        throw new Error('/home/secret/token=abc');
      });

      const failure = failureOf(await forwardSourceOpen(throwing.deps, PAYLOAD));
      expect(failure.code).toBe('INTERNAL');
      expect(failure.message).not.toContain('/home/secret');
      expect(failure.details).toEqual({ ref: MINTED_ID });
      expectReleased(throwing);
    });

    it('keeps the code of a DebuggenError a send throws', async () => {
      const throwing = createHarness();
      throwing.send.mockImplementation(() => {
        throw workerError('PROTOCOL_INVALID_MESSAGE', 'The frame could not be built.');
      });

      expect(failureOf(await forwardSourceOpen(throwing.deps, PAYLOAD)).code).toBe(
        'PROTOCOL_INVALID_MESSAGE',
      );
      expectReleased(throwing);
    });
  });

  describe('privacy', () => {
    it('never logs the location, on any path', async () => {
      const opened = forwardSourceOpen(harness.deps, PAYLOAD);
      harness.deliver(sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'opened' }));
      await opened;

      const timedOut = forwardSourceOpen(harness.deps, PAYLOAD);
      harness.fireTimer();
      await timedOut;

      const failed = forwardSourceOpen(harness.deps, PAYLOAD);
      harness.deliver(
        sourceResult({
          sessionId: SESSION_ID,
          ref: MINTED_ID,
          status: 'failed',
          error: { code: 'PROJECT_NOT_FOUND', message: 'No project.' },
        }),
      );
      await failed;

      expect(harness.logs.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(harness.logs);
      expect(serialized).not.toContain(PRIVATE_FILE);
      expect(serialized).not.toContain('No project.');
      expect(harness.logs.every((entry) => entry.fields.ref === MINTED_ID)).toBe(true);
    });
  });

  describe('the outstanding-id ledger', () => {
    it('reserves the minted id before the frame is sent', async () => {
      const ledger = createSourceOpenRefLedger();
      const seenAtSend: boolean[] = [];
      const recording = createHarness({
        refs: ledger,
        send: (type) => {
          seenAtSend.push(ledger.has(MINTED_ID));
          return type === 'source.open' ? ok<SendOutcome>('sent') : ok<SendOutcome>('queued');
        },
      });

      const answer = forwardSourceOpen(recording.deps, PAYLOAD);
      expect(seenAtSend).toEqual([true]);
      recording.deliver(sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'opened' }));
      await answer;
      expect(ledger.has(MINTED_ID), 'a source.result answers it, so it is forgotten').toBe(false);
    });

    it('refuses RATE_LIMITED, before subscribing or sending, while the ledger is full', async () => {
      const ledger = createSourceOpenRefLedger(1);
      expect(ledger.reserve('msg_awaiting_answer')).toBe(true);
      const saturated = createHarness({ refs: ledger });

      const failure = failureOf(await forwardSourceOpen(saturated.deps, PAYLOAD));
      expect(failure.code).toBe('RATE_LIMITED');
      expect(failure.hint).toEqual(expect.any(String));
      expect(failure.details).toEqual({ outstanding: 1, limit: SOURCE_OPEN_MAX_OUTSTANDING });
      expect(saturated.calls, 'nothing subscribed, nothing sent').toEqual([]);
      expect(saturated.armed.size).toBe(0);
      expect(ledger.has('msg_awaiting_answer'), 'the waiting id is never displaced').toBe(true);
      expect(ledger.has(MINTED_ID)).toBe(false);
    });

    it('keeps the id after the deadline, when its answer may still arrive', async () => {
      const ledger = createSourceOpenRefLedger();
      const late = createHarness({ refs: ledger });

      const answer = forwardSourceOpen(late.deps, PAYLOAD);
      late.fireTimer();
      await answer;
      expect(ledger.has(MINTED_ID)).toBe(true);
    });

    it('keeps the id on a correlated error, which the relay sink forgets as it withholds it', async () => {
      const ledger = createSourceOpenRefLedger();
      const refused = createHarness({ refs: ledger });

      const answer = forwardSourceOpen(refused.deps, PAYLOAD);
      refused.deliver(errorFrame({ code: 'TAB_NOT_BOUND', message: 'Not bound.', ref: MINTED_ID }));
      await answer;
      expect(ledger.has(MINTED_ID)).toBe(true);
    });

    it('forgets the id when the frame could not be sent', async () => {
      const ledger = createSourceOpenRefLedger();
      const closed = createHarness({
        refs: ledger,
        send: () => err(workerError('TRANSPORT_DISCONNECTED', 'Closed.')),
      });

      await forwardSourceOpen(closed.deps, PAYLOAD);
      expect(ledger.has(MINTED_ID)).toBe(false);
    });

    it('forgets the id when subscribing throws, since nothing was sent', async () => {
      const ledger = createSourceOpenRefLedger();
      const throwing = createHarness({
        refs: ledger,
        subscribe: () => {
          throw new Error('subscribe failed');
        },
      });

      expect(failureOf(await forwardSourceOpen(throwing.deps, PAYLOAD)).code).toBe('INTERNAL');
      expect(ledger.has(MINTED_ID)).toBe(false);
    });

    it('keeps the id when send throws, since the frame may have gone out', async () => {
      const ledger = createSourceOpenRefLedger();
      const throwing = createHarness({
        refs: ledger,
        send: () => {
          throw new Error('send failed');
        },
      });

      expect(failureOf(await forwardSourceOpen(throwing.deps, PAYLOAD)).code).toBe('INTERNAL');
      expect(ledger.has(MINTED_ID)).toBe(true);
    });

    it('records a written frame, which a socket close makes unanswerable', async () => {
      const ledger = createSourceOpenRefLedger();
      const written = createHarness({ refs: ledger });

      const answer = forwardSourceOpen(written.deps, PAYLOAD);
      written.fireTimer();
      await answer;
      ledger.socketClosed();
      expect(ledger.has(MINTED_ID)).toBe(false);
    });

    it('records a queued frame, which a socket close leaves waiting for the next socket', async () => {
      const ledger = createSourceOpenRefLedger();
      const queued = createHarness({ refs: ledger, send: () => ok<SendOutcome>('queued') });

      const answer = forwardSourceOpen(queued.deps, PAYLOAD);
      queued.fireTimer();
      await answer;
      ledger.socketClosed();
      expect(ledger.has(MINTED_ID), 'still queued: it goes out on the next socket').toBe(true);
      ledger.socketOpened();
      ledger.socketClosed();
      expect(ledger.has(MINTED_ID), 'written on that socket, which then closed').toBe(false);
    });

    it('keeps the id for a source.result naming another session', async () => {
      const ledger = createSourceOpenRefLedger();
      const crossed = createHarness({ refs: ledger });

      const answer = forwardSourceOpen(crossed.deps, PAYLOAD);
      crossed.deliver(
        sourceResult({ sessionId: OTHER_SESSION_ID, ref: MINTED_ID, status: 'opened' }),
      );
      expect(ledger.has(MINTED_ID)).toBe(true);
      crossed.deliver(sourceResult({ sessionId: SESSION_ID, ref: MINTED_ID, status: 'opened' }));
      await answer;
      expect(ledger.has(MINTED_ID)).toBe(false);
    });

    it('records nothing for a request cancelled before it was sent', async () => {
      const ledger = createSourceOpenRefLedger();
      const cancelled = createHarness({ refs: ledger });
      const controller = new AbortController();
      controller.abort(new Error('gone'));

      await forwardSourceOpen(cancelled.deps, PAYLOAD, controller.signal);
      expect(ledger.has(MINTED_ID)).toBe(false);
    });
  });
});

describe('createSourceOpenRefLedger', () => {
  it('refuses a reservation past its capacity and never evicts one it holds', () => {
    const ledger = createSourceOpenRefLedger(2);

    expect(ledger.reserve('msg_a')).toBe(true);
    expect(ledger.reserve('msg_b')).toBe(true);
    expect(ledger.reserve('msg_c')).toBe(false);
    expect(ledger.has('msg_a')).toBe(true);
    expect(ledger.has('msg_b')).toBe(true);
    expect(ledger.has('msg_c')).toBe(false);
    expect(ledger.size).toBe(2);
  });

  it('frees a slot when an answered id is forgotten; forgetting an unknown id changes nothing', () => {
    const ledger = createSourceOpenRefLedger(2);
    ledger.reserve('msg_a');
    ledger.reserve('msg_b');
    ledger.forget('msg_a');
    ledger.forget('msg_unknown');

    expect(ledger.reserve('msg_c')).toBe(true);
    expect(ledger.has('msg_a')).toBe(false);
    expect(ledger.has('msg_b')).toBe(true);
    expect(ledger.has('msg_c')).toBe(true);
  });

  it('treats a repeated reservation as the same request, even when full', () => {
    const ledger = createSourceOpenRefLedger(1);

    expect(ledger.reserve('msg_a')).toBe(true);
    expect(ledger.reserve('msg_a')).toBe(true);
    expect(ledger.size).toBe(1);
  });

  it('forgets only the written ids when the socket closes', () => {
    const ledger = createSourceOpenRefLedger();
    ledger.reserve('msg_written');
    ledger.sent('msg_written', 'sent');
    ledger.reserve('msg_queued');
    ledger.sent('msg_queued', 'queued');
    ledger.reserve('msg_reserved');

    ledger.socketClosed();
    expect(ledger.has('msg_written')).toBe(false);
    expect(ledger.has('msg_queued')).toBe(true);
    expect(ledger.has('msg_reserved')).toBe(true);
  });

  it('moves queued ids onto the socket that opens, so its close forgets them', () => {
    const ledger = createSourceOpenRefLedger();
    ledger.reserve('msg_queued');
    ledger.sent('msg_queued', 'queued');

    ledger.socketOpened();
    ledger.socketClosed();
    expect(ledger.has('msg_queued')).toBe(false);
    expect(ledger.size).toBe(0);
  });

  it('ignores an outcome for an id it does not hold', () => {
    const ledger = createSourceOpenRefLedger();
    ledger.sent('msg_unknown', 'sent');

    expect(ledger.has('msg_unknown')).toBe(false);
  });

  it.each([0, -3, 1.5, Number.NaN])('replaces a capacity of %s by the default', (capacity) => {
    const ledger = createSourceOpenRefLedger(capacity);
    for (let index = 0; index < SOURCE_OPEN_MAX_OUTSTANDING; index += 1) {
      expect(ledger.reserve(`msg_${String(index)}`)).toBe(true);
    }

    expect(ledger.reserve(`msg_${String(SOURCE_OPEN_MAX_OUTSTANDING)}`)).toBe(false);
    expect(ledger.has('msg_0')).toBe(true);
  });
});

describe('createSourceOpenSocketTracker', () => {
  /** A tracker over a status the case edits, with its next-task timers held. */
  function createTracked(): {
    readonly ledger: SourceOpenRefLedger;
    readonly observe: () => void;
    readonly set: (status: SourceOpenSocketStatus | undefined) => void;
    readonly runTimers: () => void;
  } {
    const ledger = createSourceOpenRefLedger();
    let status: SourceOpenSocketStatus | undefined = {
      transport: 'connecting',
      queuedFrameCount: 0,
    };
    const pending: (() => void)[] = [];
    const timers: WorkerTimerApi = {
      setTimeout: (handler) => {
        pending.push(handler);
        return pending.length;
      },
      clearTimeout: () => undefined,
    };
    const observe = createSourceOpenSocketTracker(ledger, () => status, timers);
    return {
      ledger,
      observe,
      set: (next) => {
        status = next;
      },
      runTimers: () => {
        for (const handler of pending.splice(0)) {
          handler();
        }
      },
    };
  }

  it('forgets the ids written to a socket when it stops being open', () => {
    const tracked = createTracked();
    tracked.set({ transport: 'open', queuedFrameCount: 0 });
    tracked.observe();
    tracked.ledger.reserve('msg_written');
    tracked.ledger.sent('msg_written', 'sent');

    tracked.set({ transport: 'reconnecting', queuedFrameCount: 0 });
    tracked.observe();
    expect(tracked.ledger.has('msg_written')).toBe(false);
  });

  it('keeps queued ids across a close, and moves them onto the next socket once its queue drained', () => {
    const tracked = createTracked();
    tracked.ledger.reserve('msg_queued');
    tracked.ledger.sent('msg_queued', 'queued');

    // Opens with the queue not yet flushed: nothing moves yet.
    tracked.set({ transport: 'open', queuedFrameCount: 1 });
    tracked.observe();
    tracked.set({ transport: 'open', queuedFrameCount: 0 });
    tracked.runTimers();

    tracked.set({ transport: 'reconnecting', queuedFrameCount: 0 });
    tracked.observe();
    expect(tracked.ledger.has('msg_queued'), 'written on the open socket, which closed').toBe(
      false,
    );
  });

  it('never forgets a queued id whose socket never drained its queue', () => {
    const tracked = createTracked();
    tracked.ledger.reserve('msg_queued');
    tracked.ledger.sent('msg_queued', 'queued');

    tracked.set({ transport: 'open', queuedFrameCount: 1 });
    tracked.observe();
    tracked.runTimers();
    tracked.set({ transport: 'closed', queuedFrameCount: 1 });
    tracked.observe();
    expect(tracked.ledger.has('msg_queued')).toBe(true);
  });

  it('does nothing on a transition between states that are not open', () => {
    const tracked = createTracked();
    tracked.ledger.reserve('msg_written');
    tracked.ledger.sent('msg_written', 'sent');

    tracked.set({ transport: 'reconnecting', queuedFrameCount: 0 });
    tracked.observe();
    tracked.set({ transport: 'closed', queuedFrameCount: 0 });
    tracked.observe();
    expect(tracked.ledger.has('msg_written')).toBe(true);
  });

  it('does nothing while no status is available', () => {
    const tracked = createTracked();
    tracked.ledger.reserve('msg_written');
    tracked.ledger.sent('msg_written', 'sent');
    tracked.set(undefined);

    tracked.observe();
    tracked.runTimers();
    expect(tracked.ledger.has('msg_written')).toBe(true);
  });
});

describe('isAnsweredSourceOpenRefusal', () => {
  const ledger = createSourceOpenRefLedger();
  ledger.reserve(MINTED_ID);

  /** A private sentence the service could have written about a refused path. */
  const PRIVATE_REFUSAL = `${PRIVATE_FILE} is outside the project`;

  it('withholds the error frame that refuses a sent source.open', () => {
    const refusal = createEnvelope('error', {
      code: 'PATH_OUTSIDE_PROJECT',
      message: PRIVATE_REFUSAL,
      ref: MINTED_ID,
    });

    expect(isAnsweredSourceOpenRefusal(refusal, ledger)).toBe(true);
  });

  it('relays an error frame for another request, or with no ref', () => {
    const other = createEnvelope('error', { code: 'INTERNAL', message: 'x', ref: 'msg_other' });
    const bare = createEnvelope('error', { code: 'INTERNAL', message: 'x' });

    expect(isAnsweredSourceOpenRefusal(other, ledger)).toBe(false);
    expect(isAnsweredSourceOpenRefusal(bare, ledger)).toBe(false);
  });

  it('relays every frame that is not an error', () => {
    const progress = createEnvelope('target.request', { sessionId: SESSION_ID });

    expect(isAnsweredSourceOpenRefusal(progress, ledger)).toBe(false);
  });
});

describe('createSourceOpenRelayFilter', () => {
  /** A private sentence the refusal of one tab's click could carry. */
  const PRIVATE_REFUSAL = `${PRIVATE_FILE} is outside the project`;

  function createSink(): {
    readonly ledger: SourceOpenRefLedger;
    readonly relayed: ProtocolMessage[];
    readonly logs: LogEntry[];
    readonly push: ReturnType<typeof createSourceOpenRelayFilter>;
  } {
    const ledger = createSourceOpenRefLedger();
    const relayed: ProtocolMessage[] = [];
    const logs: LogEntry[] = [];
    const push = createSourceOpenRelayFilter(
      ledger,
      (message) => {
        relayed.push(message);
      },
      createRecordingLogger(logs),
    );
    return { ledger, relayed, logs, push };
  }

  it('withholds the refusal of a sent source.open from every panel, and forgets its id', () => {
    const sink = createSink();
    sink.ledger.reserve(MINTED_ID);
    sink.ledger.sent(MINTED_ID, 'sent');

    sink.push(
      createEnvelope('error', {
        code: 'PATH_OUTSIDE_PROJECT',
        message: PRIVATE_REFUSAL,
        ref: MINTED_ID,
      }),
    );

    expect(sink.relayed).toEqual([]);
    expect(sink.ledger.has(MINTED_ID)).toBe(false);
    expect(JSON.stringify(sink.logs)).not.toContain(PRIVATE_FILE);
  });

  it('relays other errors and every other frame unchanged, in order', () => {
    const sink = createSink();
    sink.ledger.reserve(MINTED_ID);
    const unrelated = createEnvelope('error', { code: 'INTERNAL', message: 'x', ref: 'msg_z' });
    const request = createEnvelope('target.request', { sessionId: SESSION_ID });

    sink.push(unrelated);
    sink.push(request);

    expect(sink.relayed).toEqual([unrelated, request]);
    expect(sink.ledger.has(MINTED_ID), 'still awaiting its own answer').toBe(true);
  });

  it('withholds the refusal of every one of a full ledger of requests', () => {
    const sink = createSink();
    const refs = Array.from({ length: SOURCE_OPEN_MAX_OUTSTANDING }, (_, index) => {
      const ref = `msg_pending_${String(index)}`;
      expect(sink.ledger.reserve(ref)).toBe(true);
      return ref;
    });

    for (const ref of refs) {
      sink.push(createEnvelope('error', { code: 'TAB_NOT_BOUND', message: 'x', ref }));
    }

    expect(sink.relayed).toEqual([]);
    expect(refs.some((ref) => sink.ledger.has(ref))).toBe(false);
  });
});

/*
 * ===========================================================================
 * Two panels, a saturated ledger, a private refusal — through the port hub
 * ===========================================================================
 */

describe('source-open refusals across two panels', () => {
  const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
  const TAB_A = 101;
  const TAB_B = 202;
  /** More clicks than the ledger holds, all awaiting an answer. */
  const CLICKS = SOURCE_OPEN_MAX_OUTSTANDING + 44;
  /** What a refusal of one tab's click could say about a private file. */
  const PRIVATE_REFUSAL = `${PRIVATE_FILE} is outside the project folder`;

  /** A panel port, seen from the worker's side. */
  interface PanelPort {
    readonly posted: unknown[];
    /** A panel frame arriving at the worker. */
    readonly emit: (message: unknown) => void;
    readonly port: chrome.runtime.Port;
  }

  function createPanelPort(): PanelPort {
    const listeners = new Set<(message: unknown) => void>();
    const posted: unknown[] = [];
    const event = <Listener>(set: Set<Listener>) => ({
      addListener: (listener: Listener): void => {
        set.add(listener);
      },
      removeListener: (listener: Listener): void => {
        set.delete(listener);
      },
    });
    const fake = {
      name: PORT_PANEL,
      sender: { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/src/panel/panel.html` },
      postMessage: (message: unknown): void => {
        posted.push(message);
      },
      disconnect: (): void => undefined,
      onMessage: event(listeners),
      onDisconnect: event(new Set<() => void>()),
    };
    return {
      posted,
      emit: (message) => {
        for (const listener of [...listeners]) {
          listener(message);
        }
      },
      // The hub reads only the members above; the rest of the type is Chrome's.
      port: fake as unknown as chrome.runtime.Port,
    };
  }

  /** A `source.open` port request from a panel. */
  function sourceOpenRequest(requestId: string): unknown {
    return {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'request',
      requestId,
      kind: 'source.open',
      payload: PAYLOAD,
    };
  }

  /** The `source.open` port responses a panel received, by request id. */
  function responsesOf(panel: PanelPort): Map<string, PortResponse> {
    const responses = new Map<string, PortResponse>();
    for (const frame of panel.posted) {
      if (isPortResponse(frame) && frame.kind === 'source.open') {
        responses.set(frame.requestId, frame);
      }
    }
    return responses;
  }

  /** The failure code of a port response, or `undefined` for a success. */
  function failureCodeOf(response: PortResponse): string | undefined {
    return response.ok ? undefined : response.error.code;
  }

  /** Every protocol push a panel received (what its session store records). */
  function protocolPushesOf(panel: PanelPort): unknown[] {
    return panel.posted.filter((frame) => isPortPush(frame) && frame.kind === 'protocol');
  }

  /** Let the hub's async handlers run. */
  async function drain(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }

  interface World {
    readonly hub: PortHub;
    readonly ledger: SourceOpenRefLedger;
    readonly transport: Harness;
    readonly relay: ReturnType<typeof createSourceOpenRelayFilter>;
    readonly panelA: PanelPort;
    readonly panelB: PanelPort;
    /** The `source.open` frame ids sent to the service, in order. */
    readonly sentIds: () => string[];
    /** One service frame, handed to the socket's subscribers and, when relayed, to the panels. */
    readonly fromService: (message: ProtocolMessage) => void;
  }

  function createWorld(): World {
    const ledger = createSourceOpenRefLedger();
    let minted = 0;
    const transport = createHarness({
      refs: ledger,
      newId: () => {
        minted += 1;
        return `msg_click_${String(minted)}`;
      },
    });
    const unused = (): Promise<Result<never, DebuggenError>> =>
      Promise.resolve(err(workerError('INTERNAL', 'Not used by this suite.')));
    const handlers: PortRequestHandlers = {
      'panelData.query': unused,
      'source.open': (payload, context) =>
        forwardSourceOpen({ ...transport.deps, refs: ledger }, payload, context.signal),
      'capture.start': unused,
      'capture.stop': unused,
      'target.pick': unused,
      'target.selected': unused,
      'pair.complete': unused,
      'session.snapshot': unused,
      'page.reload': unused,
    };
    const hub = createPortHub({
      runtime: { id: EXTENSION_ID },
      timers: transport.deps.timers,
      handlers,
      bridgeHandlers: {
        'agent.ready': () => undefined,
        'telemetry.batch': () => undefined,
        'target.described': () => undefined,
        'agent.error': () => undefined,
      },
      resolveTabForSession: (sessionId) => (sessionId === SESSION_ID ? TAB_A : undefined),
    });
    const relay = createSourceOpenRelayFilter(ledger, hub.relayPush);

    const panelA = createPanelPort();
    const panelB = createPanelPort();
    hub.handleConnect(panelA.port);
    hub.handleConnect(panelB.port);
    const [first, second] = hub.listConnections();
    expect(first?.role).toBe(PORT_PANEL);
    expect(second?.role).toBe(PORT_PANEL);
    if (first === undefined || second === undefined) {
      throw new Error('two panel connections');
    }
    expect(hub.bindPanelTab(first.connectionId, TAB_A)).toBe(true);
    expect(hub.bindPanelTab(second.connectionId, TAB_B)).toBe(true);

    return {
      hub,
      ledger,
      transport,
      relay,
      panelA,
      panelB,
      sentIds: () =>
        transport.send.mock.calls
          .filter(([type]) => type === 'source.open')
          .map(([, , options]) => options?.id ?? ''),
      fromService: (message) => {
        transport.deliver(message);
        // As the socket bridge does: `error` is a relayed type, while a
        // `source.result` goes to the subscribers only.
        if (isMessageOfType(message, 'error')) {
          relay(message);
        }
      },
    };
  }

  it('refuses the clicks past the bound before sending them, and keeps every waiting id', async () => {
    const world = createWorld();
    for (let index = 0; index < CLICKS; index += 1) {
      world.panelA.emit(sourceOpenRequest(`req_click_${String(index)}`));
    }
    await drain();

    const sent = world.sentIds();
    expect(sent).toHaveLength(SOURCE_OPEN_MAX_OUTSTANDING);
    expect(world.ledger.size).toBe(SOURCE_OPEN_MAX_OUTSTANDING);
    expect(
      sent.every((id) => world.ledger.has(id)),
      'no waiting id was evicted',
    ).toBe(true);

    const answered = [...responsesOf(world.panelA).values()];
    expect(answered).toHaveLength(CLICKS - SOURCE_OPEN_MAX_OUTSTANDING);
    for (const response of answered) {
      expect(failureCodeOf(response)).toBe('RATE_LIMITED');
    }
    expect(world.panelB.posted, 'the other panel saw nothing').toEqual([]);
  });

  it('delivers a late private refusal to neither panel, the requesting one included', async () => {
    const world = createWorld();
    for (let index = 0; index < CLICKS; index += 1) {
      world.panelA.emit(sourceOpenRequest(`req_click_${String(index)}`));
    }
    await drain();
    const [oldest, second] = world.sentIds();
    if (oldest === undefined || second === undefined) {
      throw new Error('clicks were sent');
    }

    // The oldest click's pre-handler refusal: session-less, quoting a private
    // file, the frame the hub would otherwise broadcast to every panel.
    world.fromService(
      createEnvelope('error', {
        code: 'PATH_OUTSIDE_PROJECT',
        message: PRIVATE_REFUSAL,
        ref: oldest,
      }),
    );
    // The next click's handler refusal, answered as a `failed` result.
    world.fromService(
      createEnvelope('source.result', {
        sessionId: SESSION_ID,
        ref: second,
        status: 'failed',
        error: { code: 'FS_UNSAFE_PATH', message: PRIVATE_REFUSAL },
      }),
    );
    await drain();

    expect(JSON.stringify(world.panelB.posted), 'the other panel').not.toContain(PRIVATE_FILE);
    expect(world.panelB.posted).toEqual([]);
    expect(JSON.stringify(world.panelA.posted), 'the requesting panel').not.toContain(PRIVATE_FILE);
    expect(protocolPushesOf(world.panelA), 'no raw error reaches its session store').toEqual([]);

    const codes = [...responsesOf(world.panelA).values()]
      .map(failureCodeOf)
      .filter((code) => code !== 'RATE_LIMITED');
    expect(codes.sort()).toEqual(['FS_UNSAFE_PATH', 'PATH_OUTSIDE_PROJECT']);
    expect(world.ledger.has(oldest)).toBe(false);
    expect(world.ledger.has(second)).toBe(false);

    // Two answers freed two slots: the next click is forwarded again.
    world.panelA.emit(sourceOpenRequest('req_after_answers'));
    await drain();
    expect(world.sentIds()).toHaveLength(SOURCE_OPEN_MAX_OUTSTANDING + 1);
  });

  it('still broadcasts an unrelated session-less error, which is what the filter holds back', async () => {
    const world = createWorld();
    world.panelA.emit(sourceOpenRequest('req_one'));
    await drain();

    world.fromService(
      createEnvelope('error', { code: 'INTERNAL', message: 'Unrelated.', ref: 'msg_elsewhere' }),
    );

    expect(protocolPushesOf(world.panelA)).toHaveLength(1);
    expect(protocolPushesOf(world.panelB)).toHaveLength(1);
  });

  it('forgets the ids written to a socket that closed, freeing the bound', async () => {
    const world = createWorld();
    for (let index = 0; index < SOURCE_OPEN_MAX_OUTSTANDING; index += 1) {
      world.panelA.emit(sourceOpenRequest(`req_click_${String(index)}`));
    }
    await drain();
    expect(world.ledger.size).toBe(SOURCE_OPEN_MAX_OUTSTANDING);

    world.ledger.socketClosed();
    expect(world.ledger.size).toBe(0);
    world.panelA.emit(sourceOpenRequest('req_after_close'));
    await drain();
    expect(world.sentIds()).toHaveLength(SOURCE_OPEN_MAX_OUTSTANDING + 1);
  });
});
