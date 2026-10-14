/**
 * Tests for `./session-view-provider.ts`'s Retry of a failed follow-up: the
 * `retryStage` message for the `followup` stage, and the `askFollowUp` sends
 * whose attempt that Retry may resend.
 *
 * The promise under test is attempt identity: every new ask carries a fresh
 * `attemptId`, and a Retry sends exactly the attempt that failed — **the same
 * attempt id and question** — and never an answered or superseded one. The
 * attempt is chosen by its id and its outcome links, never by comparing
 * question text, counts or timestamps (AAP §0.5.4):
 *
 * - **New asks** — each `askFollowUp` mints its own id with the protocol's
 *   prefix, so a reworded question after a failure is a new follow-up, never
 *   a retry of the failed one.
 * - **Recorded, then failed** — the attempt this view sent, or, with nothing
 *   remembered, the record's latest unanswered identified entry, is resent
 *   once under its id (the service retries it in place — one ladder entry and
 *   one stored row — which `apps/local-service/src/sessions/manager.test.ts`
 *   and `test/integration/followup.test.ts` prove).
 * - **Failed before it was recorded** — the attempt this view sent that the
 *   record does not hold is resent under the same id, ahead of an older
 *   unanswered entry.
 * - **Nothing to resend** — an answered latest follow-up, an attempt answered
 *   since (appended, or retried in place), an attempt a later follow-up
 *   superseded, a latest entry with no attempt id, a session that is not
 *   `failed`, an attempt remembered for another session, or no active session:
 *   nothing is sent, and the developer is told why.
 *
 * A Retry that restarts the session (`instrument` and earlier stages) is
 * covered too: it dispatches `debuggen.startSession` once and leaves the
 * failure on screen, because that command ends the failed session first and
 * may refuse to replace it; a Retry that keeps the session clears the failure
 * at once.
 *
 * ## The `vscode` substitute
 *
 * The editor supplies the `vscode` module at runtime and no installable
 * package provides it, so `vi.mock` registers a factory for the bare
 * specifier, carrying only what resolving the view reaches: `Uri.joinPath`
 * (for the resource root and the two bundle URIs). The provider under test is
 * the real `SessionViewProvider`, resolved into a substitute `WebviewView`
 * whose `onDidReceiveMessage` hands the test the provider's own message
 * handler and whose `postMessage` records every frame. The store and the
 * service client are substitutes exposing only the members these paths read
 * (`src/state.ts` is not used, so this suite does not depend on its internals),
 * and every session record is validated by protocol's `parseSessionRecord`.
 *
 * Every frame a case sends is a request, so it carries a fresh `requestId`
 * exactly as the webview posts it (`src/webview-messages.ts` refuses a request
 * without one), and the provider answers it with one `actionResult` echoing
 * that id — after the snapshot a sent follow-up or a dispatched command posts.
 */

import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FOLLOW_UP_ATTEMPT_ID_PREFIX,
  followUpAttemptIdSchema,
  parseSessionRecord,
} from '@debuggen/protocol';
import type { FollowUpRecord, SessionRecord, SessionStatus } from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  newCaptureId,
  newId,
  newSessionId,
  ok,
  unwrap,
} from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, Result } from '@debuggen/shared';

import type { ServiceClient } from '../service/client';
import type { ExtensionState } from '../state';
import type {
  ActionResultStatus,
  HostToWebviewMessage,
  HostToWebviewMessageOf,
  WebviewRequestType,
  WebviewState,
} from '../webview-messages';
import { SessionViewProvider } from './session-view-provider';

vi.mock('vscode', () => {
  /** A URI as the provider handles it: a path, and the string form the document embeds. */
  interface SubstituteUri {
    readonly path: string;
    toString(): string;
  }

  const uri = (path: string): SubstituteUri => ({
    path,
    toString: () => `vscode-webview://test${path}`,
  });

  return {
    Uri: {
      joinPath: (base: SubstituteUri, ...segments: string[]): SubstituteUri =>
        uri([base.path, ...segments].join('/')),
    },
  };
});

/* -------------------------------------------------------------------------------------------------
 * Fixture vocabulary
 * ---------------------------------------------------------------------------------------------- */

/** When the fixture session was created: 2026-01-01T00:00:00Z. */
const CREATED_AT = 1_767_225_600_000;

/** The session's own question. */
const SESSION_QUESTION = 'Why does the alpha view take long to appear?';

/** A follow-up the service answered. */
const ANSWERED_FOLLOW_UP = 'Which request does the alpha view wait on?';

/** The follow-up whose attempt failed. */
const FAILED_FOLLOW_UP = 'What does the alpha view wait for before it renders?';

/**
 * The string the privacy case plants in a question. Shaped like something that
 * must never be logged and unlikely to occur by accident.
 */
const SENTINEL = 'VIEW-FOLLOW-UP-SENTINEL-2f9d61aa-never-log-me';

/** The warning a Retry with nothing to resend answers with. */
const NOTHING_TO_RESEND = 'There is no follow-up question to send again.';

/** The retry frame the webview posts for a failed follow-up. */
const RETRY_FOLLOW_UP = Object.freeze({ type: 'retryStage', stage: 'followup' });

/** A fresh follow-up attempt id, in the form the view and the service mint. */
function attemptId(): string {
  return newId(FOLLOW_UP_ATTEMPT_ID_PREFIX);
}

/** An answered follow-up attempt: asked, then linked to the evidence that answered it. */
function answered(
  question: string,
  askedAt: number,
  id: string = attemptId(),
  attempt = 1,
): FollowUpRecord {
  return {
    question,
    askedAt,
    attemptId: id,
    attempt,
    needsNewCapture: false,
    captureId: newCaptureId(),
  };
}

/** A follow-up attempt the service recorded but never answered: no outcome link. */
function unanswered(
  question: string,
  askedAt: number,
  id: string = attemptId(),
  attempt = 1,
): FollowUpRecord {
  return { question, askedAt, attemptId: id, attempt };
}

/** An unanswered follow-up stored before attempts were identified: no attempt id, no counter. */
function unidentified(question: string, askedAt: number): FollowUpRecord {
  return { question, askedAt };
}

/**
 * A session record validated by protocol's parser, so a drifting upstream
 * schema fails here, at the fixture.
 */
function sessionRecord(
  id: string,
  status: SessionStatus,
  followUps: readonly FollowUpRecord[],
): SessionRecord {
  return unwrap(
    parseSessionRecord({
      id,
      projectRoot: '/workspace/project-a',
      projectName: 'project-a',
      devServerUrl: 'http://127.0.0.1:4173',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT + 60_000,
      status,
      question: SESSION_QUESTION,
      followUps: [...followUps],
      relevantFiles: [],
      plans: [],
      modifications: [],
      captures: [],
      panelIds: [],
      analyses: [],
      cleanup: { status: 'pending', conflicts: [] },
      promptVersions: {},
      provider: { id: 'deterministic' },
    }),
  );
}

/* -------------------------------------------------------------------------------------------------
 * Substitutes: logger, store, client, view
 * ---------------------------------------------------------------------------------------------- */

/** One call on the capturing logger. */
interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** A {@link Logger} that records every call, bindings merged the way a child applies them. */
function createCapturingLogger(sink: CapturedLog[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      sink.push({ level, message, fields: { ...bindings, ...(fields ?? {}) } });
    };

  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (childBindings: LogFields): Logger =>
      createCapturingLogger(sink, { ...bindings, ...childBindings }),
  };
}

/** The members of the host store the provider's follow-up and retry paths read. */
type StatePort = Pick<
  ExtensionState,
  | 'activeSession'
  | 'activeSessionId'
  | 'onDidChange'
  | 'toWebviewState'
  | 'clearStageFailure'
  | 'clearPairing'
>;

/** The substitute store: its active session is set by each case, as `session.updated` would. */
interface FakeState extends StatePort {
  /** The record the store holds; `undefined` for no active session. */
  session: SessionRecord | undefined;
  /** How many times the provider cleared the failed stage. */
  clearedFailures: number;
}

/** A substitute {@link ExtensionState}: snapshots are built from its session. */
function createFakeState(): FakeState {
  const state: FakeState = {
    session: undefined,
    clearedFailures: 0,
    get activeSession(): SessionRecord | undefined {
      return state.session;
    },
    get activeSessionId(): string | undefined {
      return state.session?.id;
    },
    onDidChange: () => ({ dispose: (): void => undefined }),
    toWebviewState: (): WebviewState => ({
      connection: {
        status: 'open',
        serviceUrl: 'http://127.0.0.1:20000',
        serviceReachable: true,
        provider: 'deterministic',
      },
      ...(state.session === undefined ? {} : { session: state.session }),
      progress: [],
      relevantFiles: [],
      modifications: [],
      capture: { active: false, eventCount: 0 },
      cleanup: { status: 'pending', conflicts: [] },
    }),
    clearStageFailure: (): void => {
      state.clearedFailures += 1;
    },
    clearPairing: (): void => undefined,
  };
  return state;
}

/** The one client operation the follow-up paths call. */
type AskQuestion = ServiceClient['askQuestion'];

/** One `askQuestion` call, as the substitute client received it. */
interface AskCall {
  readonly sessionId: string;
  readonly question: string;
  /** The request's attempt id; `undefined` when the request carried none. */
  readonly attemptId: string | undefined;
}

/** The failure the substitute client answers with when a case says the service failed. */
function serviceFailure(): DebuggenError {
  return new DebuggenError('MODEL_UNAVAILABLE', 'The model provider did not answer.', {
    hint: 'Check the provider configuration, then retry.',
  });
}

/** One case's provider, resolved into a substitute view, and what it did. */
interface Harness {
  readonly state: FakeState;
  readonly asks: AskCall[];
  readonly commands: string[];
  readonly posted: HostToWebviewMessage[];
  readonly logs: CapturedLog[];
  /** What the next `askQuestion` answers; `ok` of the store's session by default. */
  answer: () => Result<SessionRecord, DebuggenError>;
  /**
   * Delivers one request frame to the provider as the webview posts it:
   * `frame` plus a fresh `requestId`.
   *
   * @returns The id the frame carried, which the provider's `actionResult` echoes.
   */
  request(frame: Readonly<Record<string, unknown>>): string;
}

/**
 * Builds the real provider over the substitutes and resolves it into a
 * substitute `WebviewView`, capturing the message handler it subscribes.
 */
function createHarness(): Harness {
  const state = createFakeState();
  const asks: AskCall[] = [];
  const commands: string[] = [];
  const posted: HostToWebviewMessage[] = [];
  const logs: CapturedLog[] = [];
  let receive: ((raw: unknown) => void) | undefined;
  let requestCount = 0;

  const harness: Harness = {
    state,
    asks,
    commands,
    posted,
    logs,
    answer: () => {
      const session = state.session;
      return session === undefined ? err(serviceFailure()) : ok(session);
    },
    request: (frame: Readonly<Record<string, unknown>>): string => {
      if (receive === undefined) {
        throw new Error('the provider has not subscribed to webview messages');
      }
      requestCount += 1;
      // The request-id alphabet of `src/webview-messages.ts`, distinct per request.
      const requestId = `followup-retry-${String(requestCount)}`;
      receive({ ...frame, requestId });
      return requestId;
    },
  };

  const askQuestion: AskQuestion = (sessionId, request) => {
    asks.push({ sessionId, question: request.question, attemptId: request.attemptId });
    return Promise.resolve(harness.answer());
  };

  const provider = new SessionViewProvider({
    extensionUri: {
      path: '/extension',
      toString: () => 'file:///extension',
    } as unknown as vscode.Uri,
    // The substitutes expose exactly the members the provider reads on these paths.
    state: state as unknown as ExtensionState,
    client: { askQuestion } as unknown as ServiceClient,
    logger: createCapturingLogger(logs),
    executeCommand: <T>(command: string): Thenable<T> => {
      commands.push(command);
      return Promise.resolve(undefined as T);
    },
  });

  const webview = {
    options: {},
    html: '',
    cspSource: 'vscode-webview://test',
    asWebviewUri: (target: vscode.Uri): vscode.Uri => target,
    onDidReceiveMessage: (listener: (raw: unknown) => void): vscode.Disposable => {
      receive = listener;
      return {
        dispose: (): void => {
          receive = undefined;
        },
      };
    },
    postMessage: (message: HostToWebviewMessage): Thenable<boolean> => {
      posted.push(message);
      return Promise.resolve(true);
    },
  };
  const view = {
    webview,
    onDidDispose: (): vscode.Disposable => ({ dispose: (): void => undefined }),
  };

  provider.resolveWebviewView(
    view as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    { isCancellationRequested: false } as vscode.CancellationToken,
  );
  expect(provider.isResolved).toBe(true);
  return harness;
}

/** Lets the provider's tracked promises settle. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** The messages of every `notice` frame the provider posted, in order. */
function notices(h: Harness): string[] {
  return h.posted.flatMap((message) => (message.type === 'notice' ? [message.message] : []));
}

/** The `actionResult` frames the provider posted for request `requestId`, in order. */
function resultsOf(h: Harness, requestId: string): HostToWebviewMessageOf<'actionResult'>[] {
  return h.posted.filter(
    (message): message is HostToWebviewMessageOf<'actionResult'> =>
      message.type === 'actionResult' && message.requestId === requestId,
  );
}

/**
 * Asserts that request `requestId` was answered exactly once, with `status`, naming `action`.
 *
 * @param h The case's harness.
 * @param requestId The id the request carried.
 * @param action The request's type.
 * @param status How the provider says its handling ended.
 */
function expectAnswered(
  h: Harness,
  requestId: string,
  action: WebviewRequestType,
  status: ActionResultStatus,
): void {
  expect(resultsOf(h, requestId)).toEqual([{ type: 'actionResult', requestId, action, status }]);
}

/**
 * Asserts that the provider ended its answer to request `requestId` with a fresh snapshot
 * followed by that request's own `accepted` result — the snapshot first, so the view renders
 * the new state before the result re-enables its control.
 *
 * @param h The case's harness.
 * @param requestId The id the request carried.
 * @param action The request's type.
 */
function expectSnapshotThenAccepted(
  h: Harness,
  requestId: string,
  action: WebviewRequestType,
): void {
  expect(h.posted.slice(-2).map((message) => message.type)).toEqual(['state', 'actionResult']);
  expect(h.posted.at(-1)).toEqual({ type: 'actionResult', requestId, action, status: 'accepted' });
  expectAnswered(h, requestId, action, 'accepted');
}

/** The attempt id the provider's `index`-th `askQuestion` call carried, failing when it carried none. */
function sentAttemptId(h: Harness, index: number): string {
  const id = h.asks[index]?.attemptId;
  if (id === undefined) {
    throw new Error(`askQuestion call ${String(index)} carried no attempt id`);
  }
  return id;
}

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

/* -------------------------------------------------------------------------------------------------
 * The cases
 * ---------------------------------------------------------------------------------------------- */

describe('A new follow-up question', () => {
  it('carries a freshly minted attempt id in the protocol’s form', async () => {
    const id = newSessionId();
    h.state.session = sessionRecord(id, 'generated', []);

    const ask = h.request({ type: 'askFollowUp', question: FAILED_FOLLOW_UP });
    await settle();

    const sent = sentAttemptId(h, 0);
    expect(h.asks).toEqual([{ sessionId: id, question: FAILED_FOLLOW_UP, attemptId: sent }]);
    expect(followUpAttemptIdSchema.safeParse(sent).success).toBe(true);
    expect(sent.startsWith(`${FOLLOW_UP_ATTEMPT_ID_PREFIX}_`)).toBe(true);
    // The attempt id is the protocol's, never the view's request id.
    expect(sent).not.toBe(ask);
    // The snapshot is posted ahead of the request's own result, which ends the pending action.
    expectSnapshotThenAccepted(h, ask, 'askFollowUp');
  });

  it('is a new attempt after a failed one, reworded or not: never the failed attempt’s id', async () => {
    const id = newSessionId();
    h.state.session = sessionRecord(id, 'generated', []);
    h.answer = () => err(serviceFailure());
    h.request({ type: 'askFollowUp', question: FAILED_FOLLOW_UP });
    await settle();
    const failed = sentAttemptId(h, 0);
    // Recorded, then failed.
    h.state.session = sessionRecord(id, 'failed', [
      unanswered(FAILED_FOLLOW_UP, CREATED_AT + 2_000, failed),
    ]);
    h.answer = () => ok(sessionRecord(id, 'failed', []));

    h.request({ type: 'askFollowUp', question: `${FAILED_FOLLOW_UP} Before the first paint?` });
    h.request({ type: 'askFollowUp', question: FAILED_FOLLOW_UP });
    await settle();

    const ids = h.asks.map((call) => call.attemptId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids.slice(1)).not.toContain(failed);
  });
});

describe('Retry of a follow-up the service recorded and then failed on', () => {
  it('resends the attempt this view sent under the same attempt id and question', async () => {
    const id = newSessionId();
    const first = answered(ANSWERED_FOLLOW_UP, CREATED_AT + 1_000);
    h.state.session = sessionRecord(id, 'generated', [first]);
    h.request({ type: 'askFollowUp', question: FAILED_FOLLOW_UP });
    await settle();
    const sent = sentAttemptId(h, 0);
    // Recorded under that id with the timestamp of the answered entry — equal
    // timestamps decide nothing — then its decision failed.
    h.state.session = sessionRecord(id, 'failed', [
      first,
      unanswered(FAILED_FOLLOW_UP, first.askedAt, sent),
    ]);

    const retry = h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.state.clearedFailures).toBe(1);
    expect(h.asks).toEqual([
      { sessionId: id, question: FAILED_FOLLOW_UP, attemptId: sent },
      { sessionId: id, question: FAILED_FOLLOW_UP, attemptId: sent },
    ]);
    expect(h.commands).toEqual([]);
    expect(notices(h)).toEqual([]);
    // The resend is answered with a fresh snapshot, then the Retry's own
    // accepted result, which ends the pending action.
    expectSnapshotThenAccepted(h, retry, 'retryStage');
  });

  it('with nothing remembered, resends the record’s latest unanswered attempt under its id', async () => {
    const id = newSessionId();
    const failed = unanswered(FAILED_FOLLOW_UP, CREATED_AT + 2_000);
    h.state.session = sessionRecord(id, 'failed', [
      answered(ANSWERED_FOLLOW_UP, CREATED_AT + 1_000),
      failed,
    ]);

    h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.state.clearedFailures).toBe(1);
    expect(h.asks).toEqual([
      { sessionId: id, question: FAILED_FOLLOW_UP, attemptId: failed.attemptId },
    ]);
    expect(notices(h)).toEqual([]);
  });

  it('resends a retried attempt again under the same id when its retry failed too', async () => {
    const id = newSessionId();
    const failed = unanswered(FAILED_FOLLOW_UP, CREATED_AT + 2_000);
    h.state.session = sessionRecord(id, 'failed', [failed]);
    h.request(RETRY_FOLLOW_UP);
    await settle();
    // Retried in place as attempt 2, and failed again.
    h.state.session = sessionRecord(id, 'failed', [
      unanswered(FAILED_FOLLOW_UP, CREATED_AT + 3_000, failed.attemptId, 2),
    ]);

    h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.asks.map((call) => call.attemptId)).toEqual([failed.attemptId, failed.attemptId]);
  });

  it('reports a resend the service refuses instead of presenting it as sent', async () => {
    const id = newSessionId();
    const failed = unanswered(FAILED_FOLLOW_UP, CREATED_AT + 2_000);
    h.state.session = sessionRecord(id, 'failed', [failed]);
    h.answer = () => err(serviceFailure());

    const retry = h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.asks).toEqual([
      { sessionId: id, question: FAILED_FOLLOW_UP, attemptId: failed.attemptId },
    ]);
    expect(notices(h)).toEqual([
      'Could not send the follow-up question: The model provider did not answer.',
    ]);
    // The Retry itself is answered as failed, so the view never shows it as sent.
    expectAnswered(h, retry, 'retryStage', 'failed');
  });
});

describe('Retry of a follow-up the service never recorded', () => {
  it('resends the attempt this view sent under the same attempt id', async () => {
    const id = newSessionId();
    const ladder = [answered(ANSWERED_FOLLOW_UP, CREATED_AT + 1_000)];
    h.state.session = sessionRecord(id, 'generated', ladder);
    h.answer = () => err(serviceFailure());

    h.request({ type: 'askFollowUp', question: FAILED_FOLLOW_UP });
    await settle();
    // The follow-up failed before it was recorded: the ladder does not hold it.
    h.state.session = sessionRecord(id, 'failed', ladder);
    h.answer = () => ok(sessionRecord(id, 'failed', ladder));

    h.request(RETRY_FOLLOW_UP);
    await settle();

    const sent = sentAttemptId(h, 0);
    expect(h.asks).toEqual([
      { sessionId: id, question: FAILED_FOLLOW_UP, attemptId: sent },
      { sessionId: id, question: FAILED_FOLLOW_UP, attemptId: sent },
    ]);
  });

  it('resends the first follow-up of a session that has none recorded', async () => {
    const id = newSessionId();
    h.state.session = sessionRecord(id, 'generated', []);
    h.answer = () => err(serviceFailure());

    h.request({ type: 'askFollowUp', question: FAILED_FOLLOW_UP });
    await settle();
    h.state.session = sessionRecord(id, 'failed', []);

    h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.asks.map((call) => call.question)).toEqual([FAILED_FOLLOW_UP, FAILED_FOLLOW_UP]);
    expect(h.asks[1]?.attemptId).toBe(sentAttemptId(h, 0));
  });

  it('prefers the attempt this view last sent over an older unanswered one', async () => {
    const id = newSessionId();
    const older = unanswered(ANSWERED_FOLLOW_UP, CREATED_AT + 1_000);
    h.state.session = sessionRecord(id, 'failed', [older]);
    h.answer = () => err(serviceFailure());
    // A new question instead of a Retry of the older attempt; it never reached the record.
    h.request({ type: 'askFollowUp', question: FAILED_FOLLOW_UP });
    await settle();
    h.answer = () => ok(sessionRecord(id, 'failed', [older]));

    h.request(RETRY_FOLLOW_UP);
    await settle();

    const sent = sentAttemptId(h, 0);
    expect(sent).not.toBe(older.attemptId);
    expect(h.asks.at(-1)).toEqual({ sessionId: id, question: FAILED_FOLLOW_UP, attemptId: sent });
  });
});

describe('Retry with no failed follow-up to resend', () => {
  it('sends nothing when the latest follow-up was answered and this view sent none', async () => {
    h.state.session = sessionRecord(newSessionId(), 'failed', [
      answered(ANSWERED_FOLLOW_UP, CREATED_AT + 1_000),
    ]);

    h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.asks).toEqual([]);
    expect(notices(h)).toEqual([NOTHING_TO_RESEND]);
  });

  it('sends nothing once the attempt this view sent was appended and answered', async () => {
    const id = newSessionId();
    const first = answered(ANSWERED_FOLLOW_UP, CREATED_AT + 1_000);
    h.state.session = sessionRecord(id, 'generated', [first]);

    h.request({ type: 'askFollowUp', question: FAILED_FOLLOW_UP });
    await settle();
    // Recorded under its id and answered; a later stage then failed the session.
    h.state.session = sessionRecord(id, 'failed', [
      first,
      answered(FAILED_FOLLOW_UP, CREATED_AT + 2_000, sentAttemptId(h, 0)),
    ]);

    h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.asks).toHaveLength(1);
    expect(notices(h)).toEqual([NOTHING_TO_RESEND]);
  });

  it('sends nothing once a resent attempt was retried in place and answered, although the count did not grow', async () => {
    const id = newSessionId();
    const first = answered(ANSWERED_FOLLOW_UP, CREATED_AT + 1_000);
    const failed = unanswered(FAILED_FOLLOW_UP, CREATED_AT + 2_000);
    h.state.session = sessionRecord(id, 'failed', [first, failed]);

    h.request(RETRY_FOLLOW_UP);
    await settle();
    // The service retried the attempt in place as attempt 2 and answered it; a
    // later stage then failed the session. Two entries, as before.
    h.state.session = sessionRecord(id, 'failed', [
      first,
      answered(FAILED_FOLLOW_UP, CREATED_AT + 3_000, failed.attemptId, 2),
    ]);

    h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.asks).toHaveLength(1);
    expect(notices(h)).toEqual([NOTHING_TO_RESEND]);
  });

  it('sends nothing for an attempt a later answered follow-up superseded', async () => {
    const id = newSessionId();
    h.state.session = sessionRecord(id, 'generated', []);
    h.answer = () => err(serviceFailure());
    h.request({ type: 'askFollowUp', question: FAILED_FOLLOW_UP });
    await settle();
    // Recorded and failed; a later follow-up from elsewhere was answered after it.
    h.state.session = sessionRecord(id, 'failed', [
      unanswered(FAILED_FOLLOW_UP, CREATED_AT + 2_000, sentAttemptId(h, 0)),
      answered(ANSWERED_FOLLOW_UP, CREATED_AT + 3_000),
    ]);

    h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.asks).toHaveLength(1);
    expect(notices(h).at(-1)).toBe(NOTHING_TO_RESEND);
  });

  it('sends nothing for an unanswered latest follow-up that has no attempt id, which could only be duplicated', async () => {
    h.state.session = sessionRecord(newSessionId(), 'failed', [
      unidentified(FAILED_FOLLOW_UP, CREATED_AT + 2_000),
    ]);

    h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.asks).toEqual([]);
    expect(notices(h)).toEqual([NOTHING_TO_RESEND]);
  });

  it('sends nothing for a session that is not failed, even with an unanswered latest follow-up', async () => {
    h.state.session = sessionRecord(newSessionId(), 'analyzing', [
      unanswered(FAILED_FOLLOW_UP, CREATED_AT + 2_000),
    ]);

    h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.asks).toEqual([]);
    expect(notices(h)).toEqual([NOTHING_TO_RESEND]);
  });

  it('sends nothing for an unrecorded attempt remembered for another session', async () => {
    const ladder = [answered(ANSWERED_FOLLOW_UP, CREATED_AT + 1_000)];
    h.state.session = sessionRecord(newSessionId(), 'generated', ladder);
    h.answer = () => err(serviceFailure());
    h.request({ type: 'askFollowUp', question: FAILED_FOLLOW_UP });
    await settle();

    h.state.session = sessionRecord(newSessionId(), 'failed', ladder);
    h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.asks).toHaveLength(1);
    expect(notices(h).at(-1)).toBe(NOTHING_TO_RESEND);
  });

  it('answers a Retry without an active session with the no-session notice', async () => {
    const retry = h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.asks).toEqual([]);
    expect(notices(h)).toEqual(['No active session.']);
    expectAnswered(h, retry, 'retryStage', 'failed');
  });
});

describe('Retry of a stage that restarts the session', () => {
  it('dispatches one debuggen.startSession and keeps the failure until the replacement is adopted', async () => {
    h.state.session = sessionRecord(newSessionId(), 'failed', []);

    const retry = h.request({ type: 'retryStage', stage: 'instrument' });
    await settle();

    // The command ends the failed session before it creates the replacement,
    // and may refuse; the failure (and its Retry) must survive a refusal, so
    // only the adoption of the replacement session clears it.
    expect(h.commands).toEqual(['debuggen.startSession']);
    expect(h.state.clearedFailures).toBe(0);
    expect(h.asks).toEqual([]);
    // The command's snapshot, then the Retry's own accepted result.
    expectSnapshotThenAccepted(h, retry, 'retryStage');
  });

  it('clears the failure at once for a retry that does not replace the session', async () => {
    h.state.session = sessionRecord(newSessionId(), 'failed', []);

    h.request({ type: 'retryStage', stage: 'capture' });
    await settle();

    expect(h.commands).toEqual(['debuggen.startCapture']);
    expect(h.state.clearedFailures).toBe(1);
  });
});

describe('privacy', () => {
  it('never logs a follow-up question, sent or resent', async () => {
    const id = newSessionId();
    const question = `${FAILED_FOLLOW_UP} ${SENTINEL}`;
    h.state.session = sessionRecord(id, 'generated', []);
    h.answer = () => err(serviceFailure());
    h.request({ type: 'askFollowUp', question });
    await settle();
    h.state.session = sessionRecord(id, 'failed', [
      unanswered(question, CREATED_AT + 2_000, sentAttemptId(h, 0)),
    ]);

    h.request(RETRY_FOLLOW_UP);
    await settle();

    expect(h.asks).toHaveLength(2);
    expect(h.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.logs)).not.toContain(SENTINEL);
  });
});
