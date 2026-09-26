/**
 * The inbound half of the `debuggen.session` webview channel
 * (`src/views/session-view-provider.ts`), run in the `vscode-extension-host`
 * Vitest project (Node).
 *
 * The provider is resolved against a fake `WebviewView` whose
 * `onDidReceiveMessage` captures the provider's listener, so each case sends a
 * frame exactly as the editor would deliver one. `ExtensionState`,
 * `ServiceClient` and `Logger` are structural fakes: the logger records every
 * call with its message, fields and child bindings, which is what lets the
 * no-leak policy (CWE-532) be asserted over **every** record the provider
 * wrote, not only the one a case expects — `afterEach` checks that no record
 * of any case carries the sentinel or a request id.
 *
 * The request cases assert the host's half of the request contract: every
 * request is answered by exactly one `actionResult` echoing its id, settled
 * only by the notices its own handling raised, and posted after the snapshot or
 * notice that handling produced. Commands run through the `executeCommand`
 * seam; a case that needs a command to stay pending gives it a
 * {@link Deferred} to await, and a command that reports an outcome posts its
 * notice from inside its own execution through {@link CommandInvocation.notify},
 * exactly as `CommandUi.notify` does in the extension.
 *
 * `vscode` is substituted with `vi.mock`, carrying only what resolution and
 * the document shell reach: `Uri.joinPath`, plus `commands.executeCommand` for
 * the default command runner (the cases inject their own through the
 * `executeCommand` seam).
 */

import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DebuggenError, err, ok } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel, Result } from '@debuggen/shared';

import type { ServiceClient } from '../service/client';
import type { ExtensionState } from '../state';
import type { ActionResultStatus, WebviewRequestType, WebviewState } from '../webview-messages';
import { MAX_IN_FLIGHT_REQUESTS, SessionViewProvider } from './session-view-provider';
import type { SessionViewNotice } from './session-view-provider';

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { readonly path: string }, ...segments: string[]) => {
      const path = [base.path, ...segments].join('/');
      return { scheme: 'file', path, fsPath: path, toString: () => `file://${path}` };
    },
  },
  commands: {
    executeCommand: () => Promise.resolve(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------

/**
 * Sender-controlled text that must never reach a log record: shaped like the
 * URL-with-query a malformed frame's `type` could carry.
 */
const SENTINEL = 'https://example.invalid/private-sentinel?q=do-not-log';

const SESSION_ID = 'ses_4k2p9dq7m1zx0c3v';

const UNRECOGNISED_MESSAGE = 'Ignored an unrecognised webview message';
const INVALID_PAYLOAD_MESSAGE = 'Ignored a webview message with an invalid payload';
const DUPLICATE_REQUEST_MESSAGE = 'Ignored a webview request whose id is already in flight';
const CAPACITY_MESSAGE = 'Refused a webview request: too many requests in flight';

/** The notice the provider answers a malformed known action with. */
const MALFORMED_NOTICE = {
  type: 'notice',
  level: 'error',
  message: 'The Debug Generator view sent a request the extension could not read.',
  hint: 'Reload the window; if it happens again, reinstall the extension.',
};

/** The DevTools tab the fake service reports it asked to enter picker mode. */
const BOUND_TAB_ID = 314;

/**
 * The informational notice a `requestTarget` the service accepted is answered
 * with: the service pushed `target.request` to the bound DevTools panel.
 */
const PICKER_MODE_FRAME = {
  type: 'notice',
  level: 'info',
  message: 'Asked the Debug Generator panel in Chrome DevTools to enter picker mode.',
  hint: 'Pick the element in the application\'s tab. It becomes this session\'s target and appears here once the panel reports it; if the panel says picker mode could not start, reload the page there, or select the element in the Elements panel and press "Use selected element".',
};

/** The notice an action that needs a session is answered with when none is active. */
const NO_ACTIVE_SESSION_FRAME = {
  type: 'notice',
  level: 'warning',
  message: 'No active session.',
  hint: 'Ask a question in the Debug Generator view to start one.',
};

/** The hint of the notice raised when VS Code could not run a command at all. */
const COMMAND_FAILURE_HINT =
  'Reload the window to restart the extension; the Debug Generator output channel has the details.';

/** One call the provider made on its logger. */
interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields | undefined;
  readonly bindings: LogFields;
}

/** A logger that records every call, at every level, with its child bindings. */
function recordingLogger(records: LogRecord[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields, bindings });
    };
  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (extra) => recordingLogger(records, { ...bindings, ...extra }),
  };
}

/** The snapshot the fake store answers with. */
function snapshot(): WebviewState {
  return {
    connection: {
      status: 'open',
      serviceUrl: 'http://127.0.0.1:43117',
      serviceReachable: true,
      provider: 'deterministic',
    },
    progress: [],
    relevantFiles: [],
    modifications: [],
    capture: { active: false, eventCount: 0 },
    cleanup: { status: 'pending', conflicts: [] },
  };
}

/** The `state` frame carrying {@link snapshot}. */
function stateFrame(): { readonly type: 'state'; readonly state: WebviewState } {
  return { type: 'state', state: snapshot() };
}

/** A valid `openFile` location. */
function validLocation(): Record<string, unknown> {
  return {
    file: 'src/lib/thing.ts',
    line: 12,
    column: 3,
    resolvedBy: 'code-graph',
    confidence: 0.85,
  };
}

/** Every request id a case minted; `afterEach` asserts that none was logged. */
const mintedRequestIds = new Set<string>();

/**
 * A request id as the view mints one: 32 lowercase hex characters, distinct
 * for every seed.
 *
 * @param seed Distinguishes the ids of one case.
 * @returns The id, remembered for the no-leak check.
 */
function requestId(seed: number): string {
  const id = `a5e1${seed.toString(16).padStart(28, '0')}`;
  mintedRequestIds.add(id);
  return id;
}

/**
 * The `actionResult` frame answering one request.
 *
 * @param id The request's id.
 * @param action The request's type.
 * @param status How the host says it ended.
 * @returns The frame, as the provider posts it.
 */
function actionResult(
  id: string,
  action: WebviewRequestType,
  status: ActionResultStatus,
): Record<string, unknown> {
  return { type: 'actionResult', requestId: id, action, status };
}

/** The `actionResult` frames among `posted`, in order. */
function actionResults(posted: readonly unknown[]): unknown[] {
  return posted.filter(
    (frame) =>
      typeof frame === 'object' &&
      frame !== null &&
      (frame as { readonly type?: unknown }).type === 'actionResult',
  );
}

/** A promise the case settles by hand, standing in for a command still running. */
class Deferred<T = void> {
  readonly promise: Promise<T>;
  private resolver: (value: T) => void = () => undefined;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolver = resolve;
    });
  }

  /** Resolves {@link promise}. */
  resolve(value: T): void {
    this.resolver(value);
  }
}

/**
 * The item at `index`, failing the case when it is missing.
 *
 * @param items The list.
 * @param index The position.
 * @returns The item.
 */
function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${String(index)}`);
  }
  return item;
}

/** One run of a contributed command, as the case's command behaviour sees it. */
interface CommandInvocation {
  readonly command: string;
  readonly args: readonly unknown[];
  /** Posts a notice from inside the command's execution, as `CommandUi.notify` does. */
  readonly notify: (notice: SessionViewNotice) => void;
}

/** What `executeCommand` does when the provider runs a command. */
type CommandBehaviour = (invocation: CommandInvocation) => Promise<unknown>;

/** How one case configures its fakes. */
interface HarnessOptions {
  /** The contributed commands' behaviour; by default each resolves at once. */
  readonly command?: CommandBehaviour;
  /** What `client.askQuestion` resolves to; by default `ok`. */
  readonly followUpResult?: () => Promise<Result<undefined, DebuggenError>>;
  /** When `true`, the store has no active session. */
  readonly noActiveSession?: boolean;
  /** When `true`, `state.clearPairing` throws. */
  readonly clearPairingThrows?: boolean;
}

/** The view side of one resolved document. */
interface FakeViewChannel {
  /** Delivers a frame to the provider's `onDidReceiveMessage` listener. */
  readonly send: (frame: unknown) => void;
  /** Every frame the provider posted to this view. */
  readonly posted: unknown[];
}

/** Everything one case observes. */
interface Harness extends FakeViewChannel {
  readonly provider: SessionViewProvider;
  /** Every command the provider ran, with its arguments. */
  readonly commands: { readonly command: string; readonly args: readonly unknown[] }[];
  /** Every follow-up the provider sent to the service. */
  readonly followUps: { readonly sessionId: string; readonly question: string }[];
  /** The session id of every `target.request` the provider sent to the service. */
  readonly targetRequests: string[];
  /** Every log call the provider made. */
  readonly records: LogRecord[];
  /** How many times the provider cleared the pairing code. */
  clearPairingCalls(): number;
  /** Resolves the provider again against a fresh view, as VS Code does after a reload. */
  resolveAgain(): FakeViewChannel;
}

let provider: SessionViewProvider | undefined;
/** The current case's log records, checked for leaks after it ran. */
let caseRecords: readonly LogRecord[] = [];

afterEach(() => {
  provider?.dispose();
  provider = undefined;
  for (const record of caseRecords) {
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain(SENTINEL);
    for (const id of mintedRequestIds) {
      expect(serialised).not.toContain(id);
    }
  }
  caseRecords = [];
  mintedRequestIds.clear();
});

/**
 * Resolves `target` against a fresh fake view.
 *
 * @param target The provider.
 * @returns The new view's channel.
 */
function resolveInto(target: SessionViewProvider): FakeViewChannel {
  const posted: unknown[] = [];
  let listener: ((raw: unknown) => void) | undefined;
  const webview = {
    options: {},
    html: '',
    cspSource: 'vscode-webview://test-source',
    asWebviewUri: (uri: { readonly path: string }) => ({
      toString: () => `vscode-webview://test-source${uri.path}`,
    }),
    onDidReceiveMessage: (received: (raw: unknown) => void) => {
      listener = received;
      return {
        dispose: () => {
          listener = undefined;
        },
      };
    },
    postMessage: (message: unknown) => {
      posted.push(message);
      return Promise.resolve(true);
    },
  };
  const view = { webview, onDidDispose: () => ({ dispose: () => undefined }) };
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
  target.resolveWebviewView(view as unknown as vscode.WebviewView, { state: undefined }, token);
  expect(listener).toBeDefined();

  return {
    send: (frame) => {
      if (listener === undefined) {
        throw new Error('the provider is not subscribed to this view');
      }
      listener(frame);
    },
    posted,
  };
}

/** Constructs a provider over fakes and resolves it against a fake view. */
function resolveProvider(options: HarnessOptions = {}): Harness {
  const records: LogRecord[] = [];
  caseRecords = records;
  const commands: { command: string; args: readonly unknown[] }[] = [];
  const followUps: { sessionId: string; question: string }[] = [];
  const targetRequests: string[] = [];
  let clearPairingCalls = 0;

  const state = {
    onDidChange: () => ({ dispose: () => undefined }),
    toWebviewState: snapshot,
    activeSessionId: options.noActiveSession === true ? undefined : SESSION_ID,
    activeSession: undefined,
    clearPairing: () => {
      clearPairingCalls += 1;
      if (options.clearPairingThrows === true) {
        throw new DebuggenError('INTERNAL', SENTINEL);
      }
    },
    clearStageFailure: () => undefined,
  };
  const client = {
    askQuestion: (sessionId: string, request: { readonly question: string }) => {
      followUps.push({ sessionId, question: request.question });
      return options.followUpResult?.() ?? Promise.resolve(ok(undefined));
    },
    // "Pick element": the service accepts, having pushed `target.request` to the bound tab.
    requestTarget: (sessionId: string) => {
      targetRequests.push(sessionId);
      return Promise.resolve(ok({ sessionId, tabId: BOUND_TAB_ID }));
    },
  };
  const behaviour: CommandBehaviour = options.command ?? (() => Promise.resolve(undefined));

  const created: SessionViewProvider = new SessionViewProvider({
    extensionUri: { scheme: 'file', path: '/ext', fsPath: '/ext' } as unknown as vscode.Uri,
    state: state as unknown as ExtensionState,
    client: client as unknown as ServiceClient,
    logger: recordingLogger(records),
    nonceFactory: () => 'AAAAAAAAAAAAAAAAAAAAAA',
    executeCommand: <T>(command: string, ...args: unknown[]): Thenable<T> => {
      commands.push({ command, args });
      return behaviour({
        command,
        args,
        notify: (notice) => {
          created.postNotice(notice);
        },
      }).then((value) => value as T);
    },
  });
  provider = created;
  const channel = resolveInto(created);

  return {
    send: channel.send,
    posted: channel.posted,
    provider: created,
    commands,
    followUps,
    targetRequests,
    records,
    clearPairingCalls: () => clearPairingCalls,
    resolveAgain: () => resolveInto(created),
  };
}

/** Lets the provider's promise chains (command, snapshot, result) run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** The WARN records with `message`, in order. */
function warnings(records: readonly LogRecord[], message: string): LogRecord[] {
  return records.filter((record) => record.level === 'warn' && record.message === message);
}

/** The ERROR records with `message`, in order. */
function errors(records: readonly LogRecord[], message: string): LogRecord[] {
  return records.filter((record) => record.level === 'error' && record.message === message);
}

/** Asserts that no log record — message, fields or bindings — contains the sentinel. */
function expectNoSentinelLogged(records: readonly LogRecord[]): void {
  for (const record of records) {
    expect(JSON.stringify(record)).not.toContain(SENTINEL);
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('SessionViewProvider — refused webview frames', () => {
  it('logs an unrecognised frame with its closed rejection only, never its type or content', async () => {
    const harness = resolveProvider();
    const cases: readonly (readonly [unknown, LogFields])[] = [
      [{ type: SENTINEL }, { reason: 'unknown-type' }],
      [{ type: SENTINEL, question: SENTINEL }, { reason: 'unknown-type' }],
      [{ type: 123 }, { reason: 'unknown-type' }],
      [{}, { reason: 'unknown-type' }],
      [{ type: 'state', state: {} }, { reason: 'unknown-type' }],
      [null, { reason: 'not-an-object', valueType: 'null' }],
      [undefined, { reason: 'not-an-object', valueType: 'undefined' }],
      [SENTINEL, { reason: 'not-an-object', valueType: 'string' }],
      ['str', { reason: 'not-an-object', valueType: 'string' }],
      [42, { reason: 'not-an-object', valueType: 'number' }],
      [[], { reason: 'not-an-object', valueType: 'array' }],
      [[{ type: SENTINEL }], { reason: 'not-an-object', valueType: 'array' }],
    ];
    for (const [frame, fields] of cases) {
      harness.send(frame);
      expect(warnings(harness.records, UNRECOGNISED_MESSAGE).at(-1)?.fields).toStrictEqual(fields);
    }
    await settle();

    expect(warnings(harness.records, UNRECOGNISED_MESSAGE)).toHaveLength(cases.length);
    // An unrecognised frame cannot be an action the view is waiting on: it is
    // dropped without a notice and without running anything.
    expect(harness.posted).toStrictEqual([]);
    expect(harness.commands).toStrictEqual([]);
    expectNoSentinelLogged(harness.records);
  });

  it('logs a known action with a missing payload by its type and answers with the malformed notice', async () => {
    const harness = resolveProvider();
    harness.send({ type: 'askQuestion' });
    await settle();

    expect(
      warnings(harness.records, INVALID_PAYLOAD_MESSAGE).map((record) => record.fields),
    ).toStrictEqual([{ type: 'askQuestion' }]);
    expect(harness.posted).toStrictEqual([MALFORMED_NOTICE]);
    expect(harness.commands).toStrictEqual([]);
  });

  it('refuses a request without a valid requestId as a malformed payload, with no result', async () => {
    const harness = resolveProvider();
    harness.send({ type: 'askQuestion', question: 'Why is this slow?' });
    harness.send({ type: 'startCapture' });
    harness.send({ type: 'stopCapture', requestId: '' });
    harness.send({ type: 'endSession', requestId: SENTINEL });
    harness.send({ type: 'requestTarget', requestId: 'a'.repeat(65) });
    harness.send({ type: 'dismissPairing', requestId: 7 });
    await settle();

    expect(
      warnings(harness.records, INVALID_PAYLOAD_MESSAGE).map((record) => record.fields),
    ).toStrictEqual([
      { type: 'askQuestion' },
      { type: 'startCapture' },
      { type: 'stopCapture' },
      { type: 'endSession' },
      { type: 'requestTarget' },
      { type: 'dismissPairing' },
    ]);
    // With no trustworthy id there is no request to answer: the malformed
    // notice is presentational and nothing runs.
    expect(harness.posted).toStrictEqual(Array.from({ length: 6 }, () => MALFORMED_NOTICE));
    expect(actionResults(harness.posted)).toStrictEqual([]);
    expect(harness.commands).toStrictEqual([]);
    expect(harness.clearPairingCalls()).toBe(0);
    expectNoSentinelLogged(harness.records);
  });

  it('refuses a known action carrying an unknown key without logging the key or its value', async () => {
    const harness = resolveProvider();
    harness.send({
      type: 'askQuestion',
      requestId: requestId(1),
      question: 'Why is this slow?',
      [SENTINEL]: SENTINEL,
    });
    harness.send({ type: 'ready', note: SENTINEL });
    await settle();

    expect(
      warnings(harness.records, INVALID_PAYLOAD_MESSAGE).map((record) => record.fields),
    ).toStrictEqual([{ type: 'askQuestion' }, { type: 'ready' }]);
    expect(harness.posted).toStrictEqual([MALFORMED_NOTICE, MALFORMED_NOTICE]);
    expect(harness.commands).toStrictEqual([]);
    expectNoSentinelLogged(harness.records);
  });

  it('refuses an openFile whose location is not a safe project-relative location', async () => {
    const harness = resolveProvider();
    harness.send({ type: 'openFile', location: { ...validLocation(), file: '../x' } });
    harness.send({ type: 'openFile', location: { ...validLocation(), line: 0 } });
    harness.send({ type: 'openFile', location: { ...validLocation(), file: '/etc/passwd' } });
    harness.send({ type: 'openFile', location: { ...validLocation(), line: SENTINEL } });
    await settle();

    expect(
      warnings(harness.records, INVALID_PAYLOAD_MESSAGE).map((record) => record.fields),
    ).toStrictEqual([
      { type: 'openFile' },
      { type: 'openFile' },
      { type: 'openFile' },
      { type: 'openFile' },
    ]);
    expect(harness.posted).toStrictEqual([
      MALFORMED_NOTICE,
      MALFORMED_NOTICE,
      MALFORMED_NOTICE,
      MALFORMED_NOTICE,
    ]);
    expect(harness.commands).toStrictEqual([]);
    expectNoSentinelLogged(harness.records);
  });

  it('refuses a blank or non-text follow-up without calling the service', async () => {
    const harness = resolveProvider();
    harness.send({ type: 'askFollowUp', requestId: requestId(1), question: '   ' });
    harness.send({ type: 'askFollowUp', requestId: requestId(2), question: 7 });
    await settle();

    expect(warnings(harness.records, INVALID_PAYLOAD_MESSAGE)).toHaveLength(2);
    expect(harness.posted).toStrictEqual([MALFORMED_NOTICE, MALFORMED_NOTICE]);
    expect(harness.followUps).toStrictEqual([]);
  });
});

describe('SessionViewProvider — accepted webview frames', () => {
  it('runs debuggen.startSession with the question as typed, then posts the snapshot and the accepted result', async () => {
    const harness = resolveProvider();
    const id = requestId(1);
    harness.send({ type: 'askQuestion', requestId: id, question: '  why?  ' });
    await settle();

    expect(harness.commands).toStrictEqual([
      { command: 'debuggen.startSession', args: [{ question: '  why?  ' }] },
    ]);
    expect(harness.posted).toStrictEqual([
      stateFrame(),
      actionResult(id, 'askQuestion', 'accepted'),
    ]);
    expect(warnings(harness.records, INVALID_PAYLOAD_MESSAGE)).toStrictEqual([]);
    expect(warnings(harness.records, UNRECOGNISED_MESSAGE)).toStrictEqual([]);
    // The answer is logged by its closed type and status only.
    expect(
      harness.records
        .filter((record) => record.message === 'Webview request answered')
        .map((record) => record.fields),
    ).toStrictEqual([{ action: 'askQuestion', status: 'accepted' }]);
  });

  it.each([
    ['startCapture', 'debuggen.startCapture'],
    ['stopCapture', 'debuggen.stopCapture'],
    ['endSession', 'debuggen.endSession'],
    ['launchDevServer', 'debuggen.launchDevServer'],
    ['pairChrome', 'debuggen.pairChrome'],
  ] as const)(
    'runs the command behind %s and accepts it once the command resolved',
    async (type, command) => {
      const gate = new Deferred();
      const harness = resolveProvider({ command: () => gate.promise });
      const id = requestId(1);
      harness.send({ type, requestId: id });
      await settle();

      expect(harness.commands).toStrictEqual([{ command, args: [] }]);
      // Still running: nothing answers the request yet.
      expect(harness.posted).toStrictEqual([]);

      gate.resolve();
      await settle();
      expect(harness.posted).toStrictEqual([stateFrame(), actionResult(id, type, 'accepted')]);
    },
  );

  it('runs debuggen.openSource with the parsed location and posts no result for it', async () => {
    const harness = resolveProvider();
    harness.send({ type: 'openFile', location: validLocation() });
    await settle();

    expect(harness.commands).toStrictEqual([
      { command: 'debuggen.openSource', args: [validLocation()] },
    ]);
    expect(harness.posted).toStrictEqual([stateFrame()]);
  });

  it('answers ready with the current snapshot, logs only the validated type and posts no result', async () => {
    const harness = resolveProvider();
    harness.send({ type: 'ready' });
    await settle();

    expect(harness.posted).toStrictEqual([stateFrame()]);
    const received = harness.records.filter(
      (record) => record.message === 'Webview message received',
    );
    expect(received.map((record) => record.fields)).toStrictEqual([{ type: 'ready' }]);
  });

  it('accepts dismissPairing once the pairing code is cleared', () => {
    const harness = resolveProvider();
    const id = requestId(1);
    harness.send({ type: 'dismissPairing', requestId: id });

    expect(harness.clearPairingCalls()).toBe(1);
    // Synchronous and local: answered before the frame handler returns.
    expect(harness.posted).toStrictEqual([actionResult(id, 'dismissPairing', 'accepted')]);
  });
});

describe('SessionViewProvider — request results are attributed to their own request', () => {
  it('fails a request whose command raised an error notice, before the command resolved, and answers it once', async () => {
    const release = new Deferred();
    const harness = resolveProvider({
      command: async ({ notify }) => {
        await Promise.resolve();
        notify({ level: 'error', message: 'Could not start the capture: no session.' });
        await release.promise;
      },
    });
    const id = requestId(1);
    harness.send({ type: 'startCapture', requestId: id });
    await settle();

    const notice = {
      type: 'notice',
      level: 'error',
      message: 'Could not start the capture: no session.',
    };
    expect(harness.posted).toStrictEqual([notice, actionResult(id, 'startCapture', 'failed')]);

    release.resolve();
    await settle();
    // The command's late completion posts its snapshot, but no second result.
    expect(harness.posted).toStrictEqual([
      notice,
      actionResult(id, 'startCapture', 'failed'),
      stateFrame(),
    ]);
  });

  it('accepts a request whose command raised only an info notice', async () => {
    const harness = resolveProvider({
      command: ({ notify }) => {
        notify({ level: 'info', message: 'Capture started.', hint: 'Interact with the page.' });
        return Promise.resolve(undefined);
      },
    });
    const id = requestId(1);
    harness.send({ type: 'startCapture', requestId: id });
    await settle();

    expect(harness.posted).toStrictEqual([
      {
        type: 'notice',
        level: 'info',
        message: 'Capture started.',
        hint: 'Interact with the page.',
      },
      stateFrame(),
      actionResult(id, 'startCapture', 'accepted'),
    ]);
  });

  it('fails a request whose command raised a warning notice', async () => {
    const harness = resolveProvider({
      command: ({ notify }) => {
        notify({ level: 'warning', message: 'Session ended; live updates are off.' });
        return Promise.resolve(undefined);
      },
    });
    const id = requestId(1);
    harness.send({ type: 'endSession', requestId: id });
    await settle();

    expect(harness.posted).toStrictEqual([
      { type: 'notice', level: 'warning', message: 'Session ended; live updates are off.' },
      actionResult(id, 'endSession', 'failed'),
      stateFrame(),
    ]);
  });

  it('keeps overlapping requests apart: each notice settles only the request that raised it', async () => {
    const stopGate = new Deferred();
    const launchGate = new Deferred();
    const harness = resolveProvider({
      command: async ({ command, notify }) => {
        if (command === 'debuggen.stopCapture') {
          await stopGate.promise;
          notify({ level: 'error', message: 'Could not stop the capture: the service is down.' });
        } else if (command === 'debuggen.launchDevServer') {
          await launchGate.promise;
        }
      },
    });
    const stopId = requestId(1);
    const targetId = requestId(2);
    const launchId = requestId(3);
    harness.send({ type: 'stopCapture', requestId: stopId });
    harness.send({ type: 'launchDevServer', requestId: launchId });
    await settle();
    expect(harness.posted).toStrictEqual([]);

    harness.send({ type: 'requestTarget', requestId: targetId });
    // requestTarget asks the service for the session's bound DevTools tab, so
    // nothing answers it before the service has replied…
    expect(harness.posted).toStrictEqual([]);
    await settle();
    // …and then its own informational notice and its own result answer it,
    // while the two commands are still running: that info notice settles
    // nothing, and neither pending command settles requestTarget.
    expect(harness.targetRequests).toStrictEqual([SESSION_ID]);
    expect(harness.posted).toStrictEqual([
      PICKER_MODE_FRAME,
      actionResult(targetId, 'requestTarget', 'accepted'),
    ]);
    expect(actionResults(harness.posted)).toStrictEqual([
      actionResult(targetId, 'requestTarget', 'accepted'),
    ]);

    // stopCapture's error fails stopCapture only; launchDevServer is still running.
    stopGate.resolve();
    await settle();
    const stopNotice = {
      type: 'notice',
      level: 'error',
      message: 'Could not stop the capture: the service is down.',
    };
    expect(harness.posted).toStrictEqual([
      PICKER_MODE_FRAME,
      actionResult(targetId, 'requestTarget', 'accepted'),
      stopNotice,
      actionResult(stopId, 'stopCapture', 'failed'),
      stateFrame(),
    ]);

    launchGate.resolve();
    await settle();
    expect(harness.posted).toStrictEqual([
      PICKER_MODE_FRAME,
      actionResult(targetId, 'requestTarget', 'accepted'),
      stopNotice,
      actionResult(stopId, 'stopCapture', 'failed'),
      stateFrame(),
      stateFrame(),
      actionResult(launchId, 'launchDevServer', 'accepted'),
    ]);
  });

  it('never attributes a frame without an id to the request whose execution delivered it', async () => {
    const location = validLocation();
    const harness = resolveProvider({
      command: ({ command }) => {
        if (command === 'debuggen.openSource') {
          return Promise.reject(new DebuggenError('INTERNAL', 'The editor is closing.'));
        }
        // An openFile frame delivered while this request's command runs.
        harness.send({ type: 'openFile', location });
        return Promise.resolve(undefined);
      },
    });
    const id = requestId(1);
    harness.send({ type: 'startCapture', requestId: id });
    await settle();

    expect(harness.commands.map((run) => run.command)).toStrictEqual([
      'debuggen.startCapture',
      'debuggen.openSource',
    ]);
    // openFile's failure is shown, but it settles nothing: startCapture is
    // accepted. The two chains are independent, so only membership is asserted
    // across them.
    expect(actionResults(harness.posted)).toStrictEqual([
      actionResult(id, 'startCapture', 'accepted'),
    ]);
    expect(harness.posted).toContainEqual({
      type: 'notice',
      level: 'error',
      message: 'Could not open that source location.',
      hint: COMMAND_FAILURE_HINT,
    });
    expect(harness.posted).toHaveLength(3);
  });

  it('treats a notice raised outside every request scope as presentational', async () => {
    const gate = new Deferred();
    const harness = resolveProvider({ command: () => gate.promise });
    const id = requestId(1);
    harness.send({ type: 'askQuestion', requestId: id, question: 'Why is the page slow?' });
    await settle();

    // A service event surfaced while the request is pending.
    harness.provider.postNotice({
      level: 'error',
      message: 'The Debug Generator service stopped.',
    });
    await settle();
    const notice = {
      type: 'notice',
      level: 'error',
      message: 'The Debug Generator service stopped.',
    };
    expect(harness.posted).toStrictEqual([notice]);

    gate.resolve();
    await settle();
    expect(harness.posted).toStrictEqual([
      notice,
      stateFrame(),
      actionResult(id, 'askQuestion', 'accepted'),
    ]);
  });

  it('fails a request whose command VS Code could not run, after the error notice', async () => {
    const harness = resolveProvider({
      command: () => Promise.reject(new DebuggenError('INTERNAL', SENTINEL)),
    });
    const id = requestId(1);
    harness.send({ type: 'startCapture', requestId: id });
    await settle();

    expect(harness.posted).toStrictEqual([
      {
        type: 'notice',
        level: 'error',
        message: 'Could not start the capture.',
        hint: COMMAND_FAILURE_HINT,
      },
      actionResult(id, 'startCapture', 'failed'),
    ]);
    expect(
      warnings(harness.records, 'Webview action could not run its command').map(
        (record) => record.fields,
      ),
    ).toStrictEqual([
      { action: 'startCapture', command: 'debuggen.startCapture', code: 'INTERNAL' },
    ]);
    expectNoSentinelLogged(harness.records);
  });

  it('fails a request whose tracked work rejected unexpectedly, logging only its code', async () => {
    const harness = resolveProvider({
      followUpResult: () => Promise.reject(new Error(SENTINEL)),
    });
    const id = requestId(1);
    harness.send({ type: 'askFollowUp', requestId: id, question: 'Why twice?' });
    await settle();

    expect(harness.posted).toStrictEqual([actionResult(id, 'askFollowUp', 'failed')]);
    expect(
      errors(harness.records, 'Webview action failed unexpectedly').map((record) => record.fields),
    ).toStrictEqual([{ action: 'askFollowUp', code: 'INTERNAL' }]);
    expectNoSentinelLogged(harness.records);
  });

  it('fails a request whose handling threw synchronously, logging only its code', () => {
    const harness = resolveProvider({ clearPairingThrows: true });
    const id = requestId(1);
    harness.send({ type: 'dismissPairing', requestId: id });

    expect(harness.posted).toStrictEqual([actionResult(id, 'dismissPairing', 'failed')]);
    expect(
      errors(harness.records, 'Webview request failed unexpectedly').map((record) => record.fields),
    ).toStrictEqual([{ action: 'dismissPairing', code: 'INTERNAL' }]);
    expectNoSentinelLogged(harness.records);
  });
});

describe('SessionViewProvider — follow-up and retry requests', () => {
  it('accepts a follow-up the service accepted, after the snapshot', async () => {
    const harness = resolveProvider();
    const id = requestId(1);
    harness.send({ type: 'askFollowUp', requestId: id, question: 'Why did it run twice?' });
    await settle();

    expect(harness.followUps).toStrictEqual([
      { sessionId: SESSION_ID, question: 'Why did it run twice?' },
    ]);
    expect(harness.posted).toStrictEqual([
      stateFrame(),
      actionResult(id, 'askFollowUp', 'accepted'),
    ]);
  });

  it('fails a follow-up the service refused, after the error notice', async () => {
    const harness = resolveProvider({
      followUpResult: () =>
        Promise.resolve(
          err(
            new DebuggenError('SESSION_INVALID_STATE', 'The session is still capturing.', {
              hint: 'Stop the capture first.',
            }),
          ),
        ),
    });
    const id = requestId(1);
    harness.send({ type: 'askFollowUp', requestId: id, question: 'Why did it run twice?' });
    await settle();

    expect(harness.posted).toStrictEqual([
      {
        type: 'notice',
        level: 'error',
        message: 'Could not send the follow-up question: The session is still capturing.',
        hint: 'Stop the capture first.',
      },
      actionResult(id, 'askFollowUp', 'failed'),
    ]);
  });

  it('fails a follow-up with no active session, after the warning notice, without calling the service', async () => {
    const harness = resolveProvider({ noActiveSession: true });
    const id = requestId(1);
    harness.send({ type: 'askFollowUp', requestId: id, question: 'Why did it run twice?' });
    await settle();

    expect(harness.followUps).toStrictEqual([]);
    expect(harness.posted).toStrictEqual([
      NO_ACTIVE_SESSION_FRAME,
      actionResult(id, 'askFollowUp', 'failed'),
    ]);
  });

  it('fails a retry of a stage outside the protocol vocabulary, after the warning notice', async () => {
    const harness = resolveProvider();
    const id = requestId(1);
    harness.send({ type: 'retryStage', requestId: id, stage: SENTINEL });
    await settle();

    expect(harness.commands).toStrictEqual([]);
    expect(harness.posted).toStrictEqual([
      {
        type: 'notice',
        level: 'warning',
        message: `The "${SENTINEL}" stage cannot be retried automatically.`,
        hint: 'Ask the question again to start a new session.',
      },
      actionResult(id, 'retryStage', 'failed'),
    ]);
    expectNoSentinelLogged(harness.records);
  });

  it('accepts a retry of the capture stage once the re-armed capture command resolved', async () => {
    const gate = new Deferred();
    const harness = resolveProvider({ command: () => gate.promise });
    const id = requestId(1);
    harness.send({ type: 'retryStage', requestId: id, stage: 'capture' });
    await settle();

    expect(harness.commands).toStrictEqual([{ command: 'debuggen.startCapture', args: [] }]);
    expect(harness.posted).toStrictEqual([]);

    gate.resolve();
    await settle();
    expect(harness.posted).toStrictEqual([
      stateFrame(),
      actionResult(id, 'retryStage', 'accepted'),
    ]);
  });
});

describe('SessionViewProvider — request bounds and lifecycle', () => {
  it('drops a request whose id is already in flight, logging only its type', async () => {
    const gate = new Deferred();
    const harness = resolveProvider({ command: () => gate.promise });
    const id = requestId(1);
    harness.send({ type: 'startCapture', requestId: id });
    harness.send({ type: 'startCapture', requestId: id });
    harness.send({ type: 'endSession', requestId: id });
    await settle();

    expect(harness.commands).toStrictEqual([{ command: 'debuggen.startCapture', args: [] }]);
    expect(
      warnings(harness.records, DUPLICATE_REQUEST_MESSAGE).map((record) => record.fields),
    ).toStrictEqual([{ type: 'startCapture' }, { type: 'endSession' }]);
    expect(harness.posted).toStrictEqual([]);

    gate.resolve();
    await settle();
    expect(harness.posted).toStrictEqual([
      stateFrame(),
      actionResult(id, 'startCapture', 'accepted'),
    ]);
  });

  it(`refuses a request beyond ${String(MAX_IN_FLIGHT_REQUESTS)} in flight without running it`, async () => {
    expect(MAX_IN_FLIGHT_REQUESTS).toBe(64);
    const harness = resolveProvider({ command: () => new Promise<never>(() => undefined) });
    for (let seed = 1; seed <= MAX_IN_FLIGHT_REQUESTS; seed += 1) {
      harness.send({ type: 'startCapture', requestId: requestId(seed) });
    }
    await settle();
    expect(harness.commands).toHaveLength(MAX_IN_FLIGHT_REQUESTS);
    expect(harness.posted).toStrictEqual([]);

    const overflow = requestId(MAX_IN_FLIGHT_REQUESTS + 1);
    harness.send({ type: 'endSession', requestId: overflow });
    // Answered at once, before anything could run.
    expect(harness.posted).toStrictEqual([actionResult(overflow, 'endSession', 'failed')]);
    await settle();

    expect(harness.commands).toHaveLength(MAX_IN_FLIGHT_REQUESTS);
    expect(harness.commands.some((run) => run.command === 'debuggen.endSession')).toBe(false);
    expect(
      warnings(harness.records, CAPACITY_MESSAGE).map((record) => record.fields),
    ).toStrictEqual([{ type: 'endSession', limit: MAX_IN_FLIGHT_REQUESTS }]);
    expect(harness.posted).toStrictEqual([actionResult(overflow, 'endSession', 'failed')]);
  });

  it('answers nothing for a request that outlived its view, even when the new view reuses its id', async () => {
    const gates: Deferred[] = [];
    const harness = resolveProvider({
      command: async ({ notify }) => {
        const gate = new Deferred();
        gates.push(gate);
        const first = gates.length === 1;
        await gate.promise;
        if (first) {
          notify({ level: 'warning', message: 'The capture ended without events.' });
        }
      },
    });
    const id = requestId(1);
    harness.send({ type: 'startCapture', requestId: id });
    await settle();
    expect(gates).toHaveLength(1);

    const second = harness.resolveAgain();
    second.send({ type: 'startCapture', requestId: id });
    await settle();
    expect(gates).toHaveLength(2);

    // The first document's request completes late, raising a warning inside
    // its own scope: the notice and its snapshot reach the live view, but they
    // answer neither the old request nor the new one that reuses its id.
    itemAt(gates, 0).resolve();
    await settle();
    expect(harness.posted).toStrictEqual([]);
    expect(second.posted).toStrictEqual([
      { type: 'notice', level: 'warning', message: 'The capture ended without events.' },
      stateFrame(),
    ]);

    itemAt(gates, 1).resolve();
    await settle();
    expect(harness.posted).toStrictEqual([]);
    expect(second.posted).toStrictEqual([
      { type: 'notice', level: 'warning', message: 'The capture ended without events.' },
      stateFrame(),
      stateFrame(),
      actionResult(id, 'startCapture', 'accepted'),
    ]);
  });

  it('answers nothing after the provider is disposed', async () => {
    const gate = new Deferred();
    const harness = resolveProvider({ command: () => gate.promise });
    harness.send({ type: 'stopCapture', requestId: requestId(1) });
    await settle();

    harness.provider.dispose();
    gate.resolve();
    await settle();
    expect(harness.posted).toStrictEqual([]);
  });
});
