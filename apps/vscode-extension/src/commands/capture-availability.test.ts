/**
 * Tests for `./capture-availability.ts` and the two commands that use it,
 * `./start-capture.ts` (`debuggen.startCapture`) and `./stop-capture.ts`
 * (`debuggen.stopCapture`).
 *
 * The availability rules run against plain objects shaped like the store and
 * against the real `ExtensionState`; the context-key binding and the commands
 * run against the real store, whose change event `vi.mock` backs with a
 * synchronous `EventEmitter` substitute (the store itself still coalesces on
 * the microtask queue). Every UI call and every service call is a spy.
 *
 * What is pinned:
 *
 * - availability: no session, `ready`, capturing by status and by the capture
 *   window, `generated`, every other status, an `ended` record and an
 *   acknowledged end, and a session that is no longer the active one;
 * - the binding writes a context key only when its value changes (so binding
 *   while nothing is capturable writes nothing), survives a rejecting or
 *   throwing writer and writes again afterwards, and resets every `true` key on
 *   dispose;
 * - the manifest's `enablement` clauses name exactly the keys the binding
 *   writes;
 * - the ended and refusal notices for every status, in generic product copy
 *   that never carries the raw `status 409` text, a session id or the question;
 * - the commands: an ended session sends no request and shows the ended
 *   notice; a `SESSION_INVALID_STATE` refusal shows the status-aware warning
 *   instead of the raw failure; the ownership conflict still names the owner;
 *   every other failure keeps the error notice.
 */

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SESSION_STATUSES } from '@debuggen/protocol';
import type {
  CaptureStartResponse,
  CaptureStopResponse,
  CaptureSummary,
  SessionRecord,
  SessionStatus,
} from '@debuggen/protocol';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';

import { ExtensionState } from '../state';

import {
  CAPTURE_CAN_START_CONTEXT_KEY,
  CAPTURE_CAN_STOP_CONTEXT_KEY,
  bindCaptureContextKeys,
  captureAvailabilityOf,
  captureRefusalNotice,
  endedSessionNotice,
  isCaptureStateRefusal,
} from './capture-availability';
import type {
  CaptureAvailability,
  CaptureAvailabilityState,
  CaptureCommandKind,
  CaptureContextKey,
} from './capture-availability';
import type { CommandContext, CommandNotice, FailureNoticeOptions } from './index';
import { startCapture } from './start-capture';
import { stopCapture } from './stop-capture';

vi.mock('vscode', () => {
  /** The part of `vscode.EventEmitter` `ExtensionState` uses, delivering synchronously. */
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();

    readonly event = (listener: (value: T) => void): { dispose(): void } => {
      this.listeners.add(listener);
      return {
        dispose: () => {
          this.listeners.delete(listener);
        },
      };
    };

    fire(value: T): void {
      for (const listener of [...this.listeners]) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }
  return { EventEmitter, workspace: {} };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const SESSION_ID = 'ses_capture_availability';
const OTHER_SESSION_ID = 'ses_capture_owner';
const CAPTURE_ID = 'cap_capture_availability';
const ENDPOINT = 'http://127.0.0.1:43117';

/** Question text that must never reach a notice or a log line. */
const QUESTION = 'Why does the order summary flicker after checkout?';

/** The raw failure text the service's scrubbed `409` produces in the protocol client. */
const RAW_REFUSAL_MESSAGE =
  'The capture.start request failed (status 409): The session was not in a state that allows this step.';

/** A complete, schema-shaped session record. */
function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: '/workspace/capture-availability',
    projectName: 'capture-availability',
    devServerUrl: 'http://127.0.0.1:3100',
    createdAt: T0,
    updatedAt: T0,
    status: 'ready',
    question: QUESTION,
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
    ...overrides,
  };
}

/** Every store a case created, disposed after it. */
const stores: ExtensionState[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.dispose();
  }
});

/** A real store, optionally holding `record` as the active session. */
function createStore(record?: SessionRecord): ExtensionState {
  const state = new ExtensionState({ serviceUrl: ENDPOINT, provider: 'deterministic' });
  stores.push(state);
  if (record !== undefined) {
    state.adoptSession(record, ENDPOINT);
  }
  return state;
}

/** Lets the store's microtask flush (and any settled writer promise) run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** A plain object shaped like the store, for the pure availability rules. */
function plainState(options: {
  readonly status?: SessionStatus;
  readonly capturing?: boolean;
  readonly acknowledged?: readonly string[];
}): CaptureAvailabilityState {
  const record =
    options.status === undefined ? undefined : sessionRecord({ status: options.status });
  const acknowledged = new Set(options.acknowledged ?? []);
  return {
    activeSession: record,
    activeSessionId: record?.id,
    captureState: { active: options.capturing ?? false, eventCount: 0 },
    hasAcknowledgedEnd: (sessionId: string) => acknowledged.has(sessionId),
  };
}

/** One log record the fake logger captured. */
interface LogRecord {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/** A logger that records every call. */
function recordingLogger(logs: LogRecord[]): Logger {
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      logs.push({ level, message, fields });
    };
  const logger: Logger = {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => logger,
  };
  return logger;
}

/** A refusal exactly as the protocol client reports the service's `409`. */
function refusalError(
  code: DebuggenErrorCode,
  operation: 'capture.start' | 'capture.stop',
  owningSessionId?: string,
): DebuggenError {
  return new DebuggenError(
    code,
    `The ${operation} request failed (status 409): The session was not in a state that allows this step.`,
    {
      hint: 'Check the session status, then retry the step.',
      details: {
        operation,
        status: 409,
        ...(owningSessionId === undefined ? {} : { owningSessionId }),
      },
    },
  );
}

// ---------------------------------------------------------------------------
// captureAvailabilityOf
// ---------------------------------------------------------------------------

describe('captureAvailabilityOf', () => {
  it('allows nothing when no session is active', () => {
    expect(captureAvailabilityOf(plainState({}))).toEqual({
      canStart: false,
      canStop: false,
      ended: false,
      status: undefined,
    });
  });

  it('allows a start, and only a start, while the session is armed', () => {
    expect(captureAvailabilityOf(plainState({ status: 'ready' }))).toEqual({
      canStart: true,
      canStop: false,
      ended: false,
      status: 'ready',
    });
  });

  it('allows a stop, and only a stop, while the record says capturing', () => {
    expect(captureAvailabilityOf(plainState({ status: 'capturing' }))).toEqual({
      canStart: false,
      canStop: true,
      ended: false,
      status: 'capturing',
    });
  });

  it('treats an open capture window as capturing before the record catches up', () => {
    expect(captureAvailabilityOf(plainState({ status: 'ready', capturing: true }))).toEqual({
      canStart: false,
      canStop: true,
      ended: false,
      status: 'ready',
    });
  });

  it('allows nothing once a result is generated', () => {
    expect(captureAvailabilityOf(plainState({ status: 'generated' }))).toEqual({
      canStart: false,
      canStop: false,
      ended: false,
      status: 'generated',
    });
  });

  it.each(
    SESSION_STATUSES.filter(
      (status) => status !== 'ready' && status !== 'capturing' && status !== 'ended',
    ),
  )('allows nothing while the session is %s', (status) => {
    const availability = captureAvailabilityOf(plainState({ status }));
    expect(availability.canStart).toBe(false);
    expect(availability.canStop).toBe(false);
    expect(availability.ended).toBe(false);
    expect(availability.status).toBe(status);
  });

  it('reports an ended record as ended, even with a capture window still marked open', () => {
    expect(captureAvailabilityOf(plainState({ status: 'ended', capturing: true }))).toEqual({
      canStart: false,
      canStop: false,
      ended: true,
      status: 'ended',
    });
  });

  it('reports an acknowledged end as ended whatever the held record says', () => {
    expect(
      captureAvailabilityOf(plainState({ status: 'ready', acknowledged: [SESSION_ID] })),
    ).toEqual({ canStart: false, canStop: false, ended: true, status: 'ready' });
  });

  it('knows only the end of a session that is no longer the active one', () => {
    const state = plainState({ status: 'capturing', acknowledged: [OTHER_SESSION_ID] });
    expect(captureAvailabilityOf(state, 'ses_unknown')).toEqual({
      canStart: false,
      canStop: false,
      ended: false,
      status: undefined,
    });
    expect(captureAvailabilityOf(state, OTHER_SESSION_ID)).toEqual({
      canStart: false,
      canStop: false,
      ended: true,
      status: undefined,
    });
    expect(captureAvailabilityOf(state, '')).toEqual({
      canStart: false,
      canStop: false,
      ended: false,
      status: undefined,
    });
  });

  it('follows the real store through start, capture and end', () => {
    const state = createStore(sessionRecord({ status: 'ready' }));
    expect(captureAvailabilityOf(state)).toMatchObject({ canStart: true, canStop: false });

    state.applyCaptureStarted({ sessionId: SESSION_ID, captureId: CAPTURE_ID });
    expect(captureAvailabilityOf(state)).toMatchObject({ canStart: false, canStop: true });

    state.applySessionEnded(SESSION_ID, { cleanup: 'clean' });
    expect(captureAvailabilityOf(state)).toEqual({
      canStart: false,
      canStop: false,
      ended: true,
      status: 'ended',
    });
    expect(state.hasAcknowledgedEnd(SESSION_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bindCaptureContextKeys
// ---------------------------------------------------------------------------

/** One `setContext` call. */
type ContextWrite = readonly [CaptureContextKey, boolean];

describe('bindCaptureContextKeys', () => {
  it('writes nothing when bound while nothing is capturable', async () => {
    const state = createStore();
    const writes: ContextWrite[] = [];
    const binding = bindCaptureContextKeys(state, (key, value) => {
      writes.push([key, value]);
    });
    let changes = 0;
    state.onDidChange(() => {
      changes += 1;
    });

    state.setServiceReachable(true);
    await settle();

    expect(changes).toBe(1);
    expect(writes).toEqual([]);
    binding.dispose();
    expect(writes).toEqual([]);
  });

  it('writes a key only when its value changes, through start, capture and end', async () => {
    const state = createStore();
    const writes: ContextWrite[] = [];
    const binding = bindCaptureContextKeys(state, (key, value) => {
      writes.push([key, value]);
      return Promise.resolve(undefined);
    });

    state.adoptSession(sessionRecord({ status: 'ready' }), ENDPOINT);
    await settle();
    expect(writes).toEqual([[CAPTURE_CAN_START_CONTEXT_KEY, true]]);

    // A change that moves neither key writes nothing.
    state.applySessionRecord(sessionRecord({ status: 'ready', updatedAt: T0 + 1 }));
    await settle();
    expect(writes).toHaveLength(1);

    state.applyCaptureStarted({ sessionId: SESSION_ID, captureId: CAPTURE_ID });
    await settle();
    expect(writes.slice(1)).toEqual([
      [CAPTURE_CAN_START_CONTEXT_KEY, false],
      [CAPTURE_CAN_STOP_CONTEXT_KEY, true],
    ]);

    state.applySessionEnded(SESSION_ID, { cleanup: 'clean' });
    await settle();
    expect(writes.slice(3)).toEqual([[CAPTURE_CAN_STOP_CONTEXT_KEY, false]]);

    binding.dispose();
    expect(writes).toHaveLength(4);
  });

  it('evaluates at bind time, so a session already armed enables the start action at once', () => {
    const state = createStore(sessionRecord({ status: 'ready' }));
    const writes: ContextWrite[] = [];
    bindCaptureContextKeys(state, (key, value) => {
      writes.push([key, value]);
    }).dispose();

    expect(writes).toEqual([
      [CAPTURE_CAN_START_CONTEXT_KEY, true],
      [CAPTURE_CAN_START_CONTEXT_KEY, false],
    ]);
  });

  it('logs a rejected write by code, and writes the key again on the next change', async () => {
    const state = createStore();
    const logs: LogRecord[] = [];
    const writes: ContextWrite[] = [];
    let reject = true;
    const binding = bindCaptureContextKeys(
      state,
      (key, value) => {
        writes.push([key, value]);
        return reject
          ? Promise.reject(new DebuggenError('INTERNAL', 'setContext is unavailable'))
          : Promise.resolve(undefined);
      },
      recordingLogger(logs),
    );

    state.adoptSession(sessionRecord({ status: 'ready' }), ENDPOINT);
    await settle();
    expect(writes).toEqual([[CAPTURE_CAN_START_CONTEXT_KEY, true]]);
    expect(logs).toEqual([
      {
        level: 'warn',
        message: 'Capture context key could not be set',
        fields: { contextKey: CAPTURE_CAN_START_CONTEXT_KEY, code: 'INTERNAL' },
      },
    ]);

    // The failed value is unknown now: the next change writes it again.
    reject = false;
    state.applySessionRecord(sessionRecord({ status: 'ready', updatedAt: T0 + 1 }));
    await settle();
    expect(writes).toEqual([
      [CAPTURE_CAN_START_CONTEXT_KEY, true],
      [CAPTURE_CAN_START_CONTEXT_KEY, true],
    ]);
    expect(logs).toHaveLength(1);

    binding.dispose();
  });

  it('never forgets a newer write because an older one failed late', async () => {
    const state = createStore();
    const writes: ContextWrite[] = [];
    let rejectFirst: ((reason: unknown) => void) | undefined;
    const binding = bindCaptureContextKeys(state, (key, value) => {
      writes.push([key, value]);
      if (writes.length === 1) {
        return new Promise((_resolve, rejectWrite) => {
          rejectFirst = rejectWrite;
        });
      }
      return Promise.resolve(undefined);
    });

    state.adoptSession(sessionRecord({ status: 'ready' }), ENDPOINT);
    await settle();
    state.applyCaptureStarted({ sessionId: SESSION_ID, captureId: CAPTURE_ID });
    await settle();
    rejectFirst?.(new Error('late failure'));
    await settle();

    // The start key's newer `false` stands: a later change does not rewrite it.
    state.applySessionRecord(sessionRecord({ status: 'capturing', updatedAt: T0 + 1 }));
    await settle();
    expect(writes).toEqual([
      [CAPTURE_CAN_START_CONTEXT_KEY, true],
      [CAPTURE_CAN_START_CONTEXT_KEY, false],
      [CAPTURE_CAN_STOP_CONTEXT_KEY, true],
    ]);

    binding.dispose();
  });

  it('catches a writer that throws, and keeps evaluating', async () => {
    const state = createStore();
    const logs: LogRecord[] = [];
    const writes: ContextWrite[] = [];
    const binding = bindCaptureContextKeys(
      state,
      (key, value) => {
        writes.push([key, value]);
        throw new Error('synchronous failure');
      },
      recordingLogger(logs),
    );

    state.adoptSession(sessionRecord({ status: 'capturing' }), ENDPOINT);
    await settle();

    expect(writes).toEqual([[CAPTURE_CAN_STOP_CONTEXT_KEY, true]]);
    expect(logs.map((log) => log.fields)).toEqual([
      { contextKey: CAPTURE_CAN_STOP_CONTEXT_KEY, code: 'INTERNAL' },
    ]);
    binding.dispose();
  });

  it('unsubscribes and resets every true key on dispose, once', async () => {
    const state = createStore(sessionRecord({ status: 'capturing' }));
    const writes: ContextWrite[] = [];
    const binding = bindCaptureContextKeys(state, (key, value) => {
      writes.push([key, value]);
    });
    expect(writes).toEqual([[CAPTURE_CAN_STOP_CONTEXT_KEY, true]]);

    binding.dispose();
    binding.dispose();
    expect(writes).toEqual([
      [CAPTURE_CAN_STOP_CONTEXT_KEY, true],
      [CAPTURE_CAN_STOP_CONTEXT_KEY, false],
    ]);

    state.applySessionRecord(sessionRecord({ status: 'ready', updatedAt: T0 + 1 }));
    await settle();
    expect(writes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** The part of `apps/vscode-extension/package.json` these cases read. */
interface ManifestCommands {
  readonly contributes: {
    readonly commands: readonly {
      readonly command: string;
      readonly enablement?: string;
    }[];
    readonly menus: {
      readonly 'view/title': readonly { readonly command: string; readonly when?: string }[];
    };
  };
}

describe('the manifest', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as ManifestCommands;
  const enablementOf = (command: string): string | undefined =>
    manifest.contributes.commands.find((entry) => entry.command === command)?.enablement;

  it('gates the two capture commands on exactly the keys the binding writes', () => {
    expect(enablementOf('debuggen.startCapture')).toBe(CAPTURE_CAN_START_CONTEXT_KEY);
    expect(enablementOf('debuggen.stopCapture')).toBe(CAPTURE_CAN_STOP_CONTEXT_KEY);
  });

  it('keeps both capture commands as title actions of the Session view', () => {
    const titleActions = manifest.contributes.menus['view/title'];
    for (const command of ['debuggen.startCapture', 'debuggen.stopCapture']) {
      expect(titleActions).toContainEqual(
        expect.objectContaining({ command, when: 'view == debuggen.session' }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

/** An availability for a session in `status`, as the store would compute it. */
function availabilityIn(status: SessionStatus, capturing = false): CaptureAvailability {
  return captureAvailabilityOf(plainState({ status, capturing }));
}

/** Asserts the copy carries none of what must never be shown. */
function expectGenericCopy(notice: CommandNotice): void {
  const text = `${notice.message} ${notice.detail ?? ''}`;
  expect(notice.message.trim()).not.toBe('');
  expect(notice.detail?.trim()).not.toBe('');
  expect(text).not.toContain('409');
  expect(text).not.toContain('request failed');
  expect(text).not.toContain(SESSION_ID);
  expect(text).not.toContain(QUESTION);
}

describe('endedSessionNotice', () => {
  it('says the session cannot capture again, and how to start another', () => {
    expect(endedSessionNotice('start')).toEqual({
      level: 'info',
      message: 'This session has ended, so it cannot capture again.',
      detail: 'Ask a new question in the Debug Generator view to start another session.',
    });
  });

  it('says the capture is already closed', () => {
    expect(endedSessionNotice('stop')).toEqual({
      level: 'info',
      message: 'This session has ended; its capture is already closed.',
      detail: 'Ask a new question in the Debug Generator view to start another session.',
    });
  });
});

describe('captureRefusalNotice', () => {
  const PIPELINE: readonly SessionStatus[] = [
    'created',
    'understanding',
    'investigating',
    'planning',
    'instrumenting',
  ];

  it.each(PIPELINE)('start while %s: capture is not available yet', (status) => {
    expect(captureRefusalNotice('start', availabilityIn(status))).toEqual({
      level: 'warning',
      message: 'Capture is not available yet.',
      detail: 'Capture opens once instrumentation is ready.',
    });
  });

  it.each(PIPELINE)('stop while %s: no capture is running', (status) => {
    expect(captureRefusalNotice('stop', availabilityIn(status))).toEqual({
      level: 'warning',
      message: 'No capture is running for this session.',
      detail: 'Capture opens once instrumentation is ready.',
    });
  });

  it('start while generated: points at a follow-up question', () => {
    expect(captureRefusalNotice('start', availabilityIn('generated'))).toEqual({
      level: 'warning',
      message: 'Capture is not available while the session shows a generated result.',
      detail: 'Ask a follow-up question; if it needs new evidence, capture opens again.',
    });
  });

  it('stop while generated: points at a follow-up question', () => {
    expect(captureRefusalNotice('stop', availabilityIn('generated'))).toEqual({
      level: 'warning',
      message: 'No capture is running for this session.',
      detail: 'Ask a follow-up question; if it needs new evidence, capture opens again.',
    });
  });

  it('start while capturing, by status or by the capture window: a capture is already running', () => {
    const expected = {
      level: 'warning',
      message: 'A capture is already running.',
      detail: 'Stop it to analyze what it recorded.',
    };
    expect(captureRefusalNotice('start', availabilityIn('capturing'))).toEqual(expected);
    expect(captureRefusalNotice('start', availabilityIn('ready', true))).toEqual(expected);
  });

  it('stop while the host still shows a capture: it has already stopped', () => {
    expect(captureRefusalNotice('stop', availabilityIn('capturing'))).toEqual({
      level: 'warning',
      message: 'This capture has already stopped.',
      detail: 'The Debug Generator view updates when the local service reports what it recorded.',
    });
  });

  it('start while ready: the service had moved on', () => {
    const notice = captureRefusalNotice('start', availabilityIn('ready'));
    expect(notice.level).toBe('warning');
    expect(notice.message).toBe(
      "The local service did not start a capture in the session's current state.",
    );
    expect(notice.detail).toContain('Debug Generator view');
  });

  it('stop while ready: start a capture first', () => {
    expect(captureRefusalNotice('stop', availabilityIn('ready'))).toEqual({
      level: 'warning',
      message: 'No capture is running for this session.',
      detail: 'Start a capture, reproduce the issue, then stop it.',
    });
  });

  it('while analyzing: the result is on its way', () => {
    expect(captureRefusalNotice('start', availabilityIn('analyzing'))).toEqual({
      level: 'warning',
      message: 'Capture is not available while the last capture is analyzed.',
      detail: 'The result appears in the Debug Generator view when it is ready.',
    });
    expect(captureRefusalNotice('stop', availabilityIn('analyzing'))).toEqual({
      level: 'warning',
      message: 'No capture is running; the last one is being analyzed.',
      detail: 'The result appears in the Debug Generator view when it is ready.',
    });
  });

  it('once failed: retry the stage or end the session', () => {
    const detail = 'Retry the failed stage from the Debug Generator view, or end the session.';
    expect(captureRefusalNotice('start', availabilityIn('failed'))).toEqual({
      level: 'warning',
      message: 'Capture is not available because the session failed.',
      detail,
    });
    expect(captureRefusalNotice('stop', availabilityIn('failed'))).toEqual({
      level: 'warning',
      message: 'No capture is running because the session failed.',
      detail,
    });
  });

  it.each<CaptureCommandKind>(['start', 'stop'])(
    '%s for an ended session: the ended notice',
    (kind) => {
      expect(captureRefusalNotice(kind, availabilityIn('ended'))).toEqual(endedSessionNotice(kind));
      expect(
        captureRefusalNotice(
          kind,
          captureAvailabilityOf(plainState({ status: 'ready', acknowledged: [SESSION_ID] })),
        ),
      ).toEqual(endedSessionNotice(kind));
    },
  );

  it('for a session no longer in view: says so, and how to start one', () => {
    const gone = captureAvailabilityOf(plainState({}), SESSION_ID);
    expect(captureRefusalNotice('start', gone)).toEqual({
      level: 'warning',
      message: 'This session is no longer active, so no capture was started.',
      detail: 'Ask a question in the Debug Generator view to start a session.',
    });
    expect(captureRefusalNotice('stop', gone)).toEqual({
      level: 'warning',
      message: 'This session is no longer active, so there is no capture to stop.',
      detail: 'Ask a question in the Debug Generator view to start a session.',
    });
  });

  it('is generic product copy for every status and both commands', () => {
    for (const kind of ['start', 'stop'] as const) {
      expectGenericCopy(endedSessionNotice(kind));
      for (const status of SESSION_STATUSES) {
        expectGenericCopy(captureRefusalNotice(kind, availabilityIn(status)));
      }
    }
  });
});

describe('isCaptureStateRefusal', () => {
  it('recognises the state refusal by its code, and nothing else', () => {
    expect(isCaptureStateRefusal(refusalError('SESSION_INVALID_STATE', 'capture.start'))).toBe(
      true,
    );
    expect(
      isCaptureStateRefusal(
        refusalError('CAPTURE_ALREADY_ACTIVE', 'capture.start', OTHER_SESSION_ID),
      ),
    ).toBe(false);
    expect(
      isCaptureStateRefusal(new DebuggenError('TRANSPORT_DISCONNECTED', RAW_REFUSAL_MESSAGE)),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/** The scripted answers of the fake service client. */
interface ClientScript {
  readonly start?: () => Result<CaptureStartResponse, DebuggenError>;
  readonly stop?: () => Result<CaptureStopResponse, DebuggenError>;
}

/** The fake context and every spy a case asserts on. */
interface Harness {
  readonly ctx: CommandContext;
  readonly state: ExtensionState;
  readonly logs: LogRecord[];
  readonly startRequests: Mock<(sessionId: string) => Promise<unknown>>;
  readonly stopRequests: Mock<(sessionId: string) => Promise<unknown>>;
  readonly notify: Mock<(notice: CommandNotice) => Promise<string | undefined>>;
  readonly notifyFailure: Mock<
    (error: DebuggenError, options?: FailureNoticeOptions) => Promise<string | undefined>
  >;
  readonly executeCommand: Mock<(command: string, ...args: unknown[]) => Promise<unknown>>;
}

/**
 * Builds the fake context over a real store holding `record` (or no session),
 * a client answering from `script`, and spies for every UI call.
 */
function createHarness(record: SessionRecord | undefined, script: ClientScript = {}): Harness {
  const logs: LogRecord[] = [];
  const state = createStore(record);
  const startRequests = vi.fn((sessionId: string) => {
    expect(sessionId).toBe(SESSION_ID);
    const answer = script.start;
    if (answer === undefined) {
      throw new Error('unscripted capture.start');
    }
    return Promise.resolve(answer());
  });
  const stopRequests = vi.fn((sessionId: string) => {
    expect(sessionId).toBe(SESSION_ID);
    const answer = script.stop;
    if (answer === undefined) {
      throw new Error('unscripted capture.stop');
    }
    return Promise.resolve(answer());
  });
  const notify = vi.fn((notice: CommandNotice) => {
    void notice;
    return Promise.resolve<string | undefined>(undefined);
  });
  const notifyFailure = vi.fn((error: DebuggenError, options?: FailureNoticeOptions) => {
    void error;
    void options;
    return Promise.resolve<string | undefined>(undefined);
  });
  const executeCommand = vi.fn((command: string, ...args: unknown[]) => {
    void command;
    void args;
    return Promise.resolve<unknown>(undefined);
  });

  const ctx = {
    state,
    client: { startCapture: startRequests, stopCapture: stopRequests, state: 'open' },
    logger: recordingLogger(logs),
    ui: { notify, notifyFailure, executeCommand },
    guards: {
      requireActiveSession: () => {
        const sessionId = state.activeSessionId;
        return sessionId === undefined ? undefined : { sessionId, session: state.activeSession };
      },
    },
  } as unknown as CommandContext;

  return {
    ctx,
    state,
    logs,
    startRequests,
    stopRequests,
    notify,
    notifyFailure,
    executeCommand,
  };
}

/** The one notice a case showed through `notify`, with no failure notice. */
function onlyNotice(harness: Harness): CommandNotice {
  expect(harness.notify).toHaveBeenCalledTimes(1);
  expect(harness.notifyFailure).not.toHaveBeenCalled();
  const [call] = harness.notify.mock.calls;
  if (call === undefined) {
    throw new Error('expected a notice');
  }
  return call[0];
}

/** Asserts no log record carries the session id or the question. */
function expectNothingSensitiveLogged(harness: Harness): void {
  const serialised = JSON.stringify(harness.logs);
  expect(serialised).not.toContain(SESSION_ID);
  expect(serialised).not.toContain(QUESTION);
}

describe('debuggen.startCapture', () => {
  it('sends nothing for an ended session and shows the ended notice', async () => {
    const harness = createHarness(sessionRecord({ status: 'ready' }));
    harness.state.applySessionEnded(SESSION_ID, { cleanup: 'clean' });

    await startCapture(harness.ctx);

    expect(harness.startRequests).not.toHaveBeenCalled();
    expect(onlyNotice(harness)).toEqual(endedSessionNotice('start'));
    expect(harness.logs.map((log) => log.fields)).toEqual([{ command: 'debuggen.startCapture' }]);
    expectNothingSensitiveLogged(harness);
  });

  it('shows the status-aware warning, not the raw failure, for a state refusal', async () => {
    const harness = createHarness(sessionRecord({ status: 'generated' }), {
      start: () => err(refusalError('SESSION_INVALID_STATE', 'capture.start')),
    });

    await startCapture(harness.ctx);

    expect(harness.startRequests).toHaveBeenCalledTimes(1);
    const notice = onlyNotice(harness);
    expect(notice).toEqual({
      level: 'warning',
      message: 'Capture is not available while the session shows a generated result.',
      detail: 'Ask a follow-up question; if it needs new evidence, capture opens again.',
    });
    expect(notice.message).not.toContain('status 409');
    expectNothingSensitiveLogged(harness);
  });

  it('words a refusal from the store as it reads once the refusal arrives', async () => {
    const inFlight: { endElsewhere?: () => void } = {};
    const harness = createHarness(sessionRecord({ status: 'ready' }), {
      start: () => {
        inFlight.endElsewhere?.();
        return err(refusalError('SESSION_INVALID_STATE', 'capture.start'));
      },
    });
    // The session ends elsewhere while the request is in flight.
    inFlight.endElsewhere = () => {
      harness.state.applySessionEnded(SESSION_ID, { cleanup: 'clean' });
    };

    await startCapture(harness.ctx);

    expect(harness.startRequests).toHaveBeenCalledTimes(1);
    expect(onlyNotice(harness)).toEqual(endedSessionNotice('start'));
  });

  it('still names the owning session of an ownership conflict, with a reopen action', async () => {
    const harness = createHarness(sessionRecord({ status: 'ready' }), {
      start: () => err(refusalError('CAPTURE_ALREADY_ACTIVE', 'capture.start', OTHER_SESSION_ID)),
    });
    harness.notify.mockResolvedValueOnce('Reopen that session');

    await startCapture(harness.ctx);

    const notice = onlyNotice(harness);
    expect(notice.level).toBe('warning');
    expect(notice.message).toContain(OTHER_SESSION_ID);
    expect(notice.actions).toEqual(['Reopen that session']);
    expect(harness.executeCommand).toHaveBeenCalledWith('debuggen.reopenSession', OTHER_SESSION_ID);
  });

  it('checks for an owning session before treating a 409 as a state refusal', async () => {
    const harness = createHarness(sessionRecord({ status: 'ready' }), {
      start: () => err(refusalError('SESSION_INVALID_STATE', 'capture.start', OTHER_SESSION_ID)),
    });

    await startCapture(harness.ctx);

    expect(onlyNotice(harness).message).toContain(OTHER_SESSION_ID);
  });

  it('keeps the error notice, with its prefix, for every other failure', async () => {
    const failure = new DebuggenError(
      'TRANSPORT_DISCONNECTED',
      'The local service did not answer.',
      {
        hint: 'Start the local service.',
      },
    );
    const harness = createHarness(sessionRecord({ status: 'ready' }), {
      start: () => err(failure),
    });

    await startCapture(harness.ctx);

    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure).toHaveBeenCalledWith(failure, {
      prefix: 'Could not start capture',
    });
  });

  it('shows nothing when the capture starts', async () => {
    const harness = createHarness(sessionRecord({ status: 'ready' }), {
      start: () => ok({ captureId: CAPTURE_ID }),
    });

    await startCapture(harness.ctx);

    expect(harness.startRequests).toHaveBeenCalledTimes(1);
    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.notifyFailure).not.toHaveBeenCalled();
    expect(harness.logs.map((log) => log.fields)).toEqual([{ command: 'debuggen.startCapture' }]);
  });

  it('sends nothing without an active session', async () => {
    const harness = createHarness(undefined);

    await startCapture(harness.ctx);

    expect(harness.startRequests).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });
});

describe('debuggen.stopCapture', () => {
  it('sends nothing for an ended session and shows the ended notice', async () => {
    const harness = createHarness(sessionRecord({ status: 'capturing' }));
    harness.state.applySessionEnded(SESSION_ID, { cleanup: 'clean' });

    await stopCapture(harness.ctx);

    expect(harness.stopRequests).not.toHaveBeenCalled();
    expect(onlyNotice(harness)).toEqual(endedSessionNotice('stop'));
    expect(harness.logs.map((log) => log.fields)).toEqual([{ command: 'debuggen.stopCapture' }]);
    expectNothingSensitiveLogged(harness);
  });

  it('shows the status-aware warning, not the raw failure, for a state refusal', async () => {
    const harness = createHarness(sessionRecord({ status: 'ready' }), {
      stop: () => err(refusalError('SESSION_INVALID_STATE', 'capture.stop')),
    });

    await stopCapture(harness.ctx);

    expect(harness.stopRequests).toHaveBeenCalledTimes(1);
    const notice = onlyNotice(harness);
    expect(notice).toEqual({
      level: 'warning',
      message: 'No capture is running for this session.',
      detail: 'Start a capture, reproduce the issue, then stop it.',
    });
    expect(notice.message).not.toContain('status 409');
  });

  it('says the capture already stopped when the host still showed it running', async () => {
    const harness = createHarness(sessionRecord({ status: 'capturing' }), {
      stop: () => err(refusalError('SESSION_INVALID_STATE', 'capture.stop')),
    });

    await stopCapture(harness.ctx);

    expect(onlyNotice(harness).message).toBe('This capture has already stopped.');
  });

  it('keeps the error notice, with its prefix, for every other failure', async () => {
    const failure = new DebuggenError('STORE_ERROR', 'The session store could not be read.');
    const harness = createHarness(sessionRecord({ status: 'capturing' }), {
      stop: () => err(failure),
    });

    await stopCapture(harness.ctx);

    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.notifyFailure).toHaveBeenCalledWith(failure, {
      prefix: 'Could not stop capture',
    });
  });

  it('still reports what a stopped capture recorded', async () => {
    const summary = {
      captureId: CAPTURE_ID,
      eventCount: 3,
      traceCount: 1,
      tierCounts: { browser: 2, server: 1, db: 0 },
    } as unknown as CaptureSummary;
    const harness = createHarness(sessionRecord({ status: 'capturing' }), {
      stop: () => ok({ summary }),
    });

    await stopCapture(harness.ctx);

    expect(onlyNotice(harness)).toEqual({
      level: 'info',
      message: 'Capture stopped: 3 events across 1 trace (browser 2 · server 1).',
      detail: undefined,
    });
  });
});
