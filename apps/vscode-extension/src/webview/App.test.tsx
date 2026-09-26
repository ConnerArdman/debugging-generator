/**
 * `webview/App` — request correlation and draft retention, end to end through the view.
 *
 * `./vscode-api` is replaced with a scripted host channel: `isVsCodeApiAvailable` answers `true`,
 * `postToHost` records every message and answers whether it was delivered, and `subscribeToHost`
 * captures App's handler so each case pushes the frames the real host would — including the one
 * `actionResult` the host posts per request, echoing that request's id. The view is mounted under
 * `StrictMode`, as `main.tsx` mounts it, so reducers and effects run twice where React says they
 * may.
 *
 * What this suite protects:
 *
 *   - every request App posts carries its own id (32 lowercase hex characters) and passes the
 *     host's parser; `openFile` carries none;
 *   - a pending question survives everything that is not its own result — the session-less reset
 *     snapshot, a different session reopened from the Sessions tree, an informational notice and an
 *     unrelated error — so no duplicate can be raised; its accepted result clears the draft, its
 *     failed result restores the form with the draft and the retry hint, and an accepted result with
 *     no live updates still clears it;
 *   - a pending "Stop capture" is not re-enabled by the answer to "Pick element";
 *   - a pending follow-up survives End session and its `ended` snapshot, unrelated status changes
 *     and notices; only its own result settles it, keeping or clearing the draft accordingly;
 *   - opening a file while a question is pending settles nothing;
 *   - the safety timeout gives a request up at 150 s, not before, and its late result is ignored;
 *   - a request the host channel refused keeps the draft with the retry hint.
 *
 * Fixtures are realistic `SessionRecord`s and `WebviewState`s with neutral, synthetic wording
 * (AAP 0.5.4).
 */
import type { SessionRecord, SessionStatus } from '@debuggen/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isWebviewRequestMessage, parseWebviewToHostMessage } from '../webview-messages';
import type {
  ActionResultStatus,
  HostToWebviewMessage,
  WebviewRequestType,
  WebviewState,
  WebviewToHostMessage,
  WebviewToHostMessageOf,
  WebviewToHostMessageType,
} from '../webview-messages';

import { App } from './App';
import { PENDING_ACTION_TIMEOUT_MS } from './pending-actions';

// ---------------------------------------------------------------------------
// The scripted host channel
// ---------------------------------------------------------------------------

const channel = vi.hoisted(() => ({
  /** App's subscription, once its effect has run. */
  handler: undefined as ((message: HostToWebviewMessage) => void) | undefined,
  /** Whether the next `postToHost` is delivered. */
  deliver: true,
  /** Every message App posted, in order. */
  posted: [] as WebviewToHostMessage[],
}));

vi.mock('./vscode-api', () => ({
  isVsCodeApiAvailable: (): boolean => true,
  postToHost: (message: WebviewToHostMessage): boolean => {
    channel.posted.push(message);
    return channel.deliver;
  },
  subscribeToHost: (handler: (message: HostToWebviewMessage) => void): (() => void) => {
    channel.handler = handler;
    return () => {
      if (channel.handler === handler) {
        channel.handler = undefined;
      }
    };
  },
}));

beforeEach(() => {
  channel.handler = undefined;
  channel.deliver = true;
  channel.posted = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * Delivers one host frame to the mounted view.
 *
 * @param message The frame, as the host would post it.
 */
function push(message: HostToWebviewMessage): void {
  const handler = channel.handler;
  if (handler === undefined) {
    throw new Error('App has not subscribed to the host channel');
  }
  act(() => {
    handler(message);
  });
}

/** Pushes a `state` frame. */
function pushState(state: WebviewState): void {
  push({ type: 'state', state });
}

/** The messages of `type` App has posted so far, in order. */
function postedOf<K extends WebviewToHostMessageType>(type: K): WebviewToHostMessageOf<K>[] {
  return channel.posted.filter(
    (message): message is WebviewToHostMessageOf<K> => message.type === type,
  );
}

/**
 * The id of the last request of `action` App posted.
 *
 * @param action The request type.
 * @returns Its `requestId`.
 */
function lastRequestId(action: WebviewRequestType): string {
  const last = postedOf(action).at(-1);
  if (last === undefined) {
    throw new Error(`App has posted no ${action} request`);
  }
  return last.requestId;
}

/**
 * Pushes the host's `actionResult` for a request — by default the last one of `action` App
 * posted, which is what the real host answers.
 *
 * @param action The request type the result names.
 * @param status How the host's handling ended.
 * @param requestId The id the result echoes.
 */
function answer(
  action: WebviewRequestType,
  status: ActionResultStatus,
  requestId: string = lastRequestId(action),
): void {
  push({ type: 'actionResult', requestId, action, status });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The shape of every id App mints: 16 random bytes as 32 lowercase hex characters. */
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;

const SESSION_ID = 'ses_4k2p9dq7m1zx0c3v';
const NEXT_SESSION_ID = 'ses_0z9y8x7w6v5u4t3s';
const CAPTURE_ID = 'cap_7f3q0m2zk1x8ab9c';
const RELEVANT_FILE = 'src/lib/task-runner.ts';
const RELEVANT_FILES: WebviewState['relevantFiles'] = [
  { file: RELEVANT_FILE, reason: 'Runs the task the question is about.', score: 0.9 },
];

/** A complete session record, shaped as the service persists it. */
function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: '/home/example/workspace/site',
    projectName: 'site',
    devServerUrl: 'http://localhost:3000',
    createdAt: 1_758_000_000_000,
    updatedAt: 1_758_000_030_000,
    status: 'generated',
    question: 'Why does this action take so long?',
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: { understand: 'v001', investigate: 'v001' },
    provider: { id: 'deterministic' },
    ...overrides,
  };
}

/** A complete webview snapshot, as `ExtensionState.toWebviewState()` builds it. */
function webviewState(overrides: Partial<WebviewState> = {}): WebviewState {
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
    ...overrides,
  };
}

/** A snapshot of the active session in `status`. */
function sessionState(
  status: SessionStatus,
  overrides: Partial<WebviewState> = {},
  record: Partial<SessionRecord> = {},
): WebviewState {
  return webviewState({
    session: sessionRecord({
      status,
      boundTab: { tabId: 7, url: 'http://localhost:3000/' },
      ...record,
    }),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const QUESTION_FIELD = 'What do you want to debug?';
const QUESTION_SUBMIT = 'Ask question';
/** `LoadingState` appends an ellipsis to its label, so the busy copies are matched as substrings. */
const QUESTION_PENDING = 'Submitting your question';
const QUESTION_RETRY_HINT =
  'Your question was not confirmed, so it is kept here. Press “Ask question” to try again.';
const FOLLOW_UP_FIELD = 'Follow-up question';
const FOLLOW_UP_SUBMIT = 'Ask follow-up';
const FOLLOW_UP_PENDING = 'Processing the follow-up question';
const FOLLOW_UP_RETRY_HINT =
  'Your follow-up question was not confirmed, so it is kept here. Press “Ask follow-up” to try again.';
const STOP_CAPTURE = 'Stop capture';
const START_CAPTURE = 'Start capture';
const CAPTURE_PENDING = 'Updating the capture';
const PICK_ELEMENT = 'Pick element';
/** `TargetBadge`'s busy label: the request only asks the bound panel to enter picker mode. */
const PICK_PENDING = 'Asking Chrome DevTools to enter picker mode';
const END_SESSION = 'End session';
const SESSION_ENDED = 'Session ended.';
const LAUNCH_DEV_SERVER = 'Launch dev server';
const PAIR_CHROME = 'Pair Chrome DevTools';
const UNDELIVERED = 'That action could not be passed to the editor.';

/** A text area found by its label. */
function field(label: string): HTMLTextAreaElement {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error(`expected "${label}" to label a <textarea>`);
  }
  return element;
}

/** A button found by its accessible name. */
function button(name: string): HTMLButtonElement {
  const element = screen.getByRole('button', { name });
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`expected "${name}" to be a <button>`);
  }
  return element;
}

/** Whether a busy label (matched as a substring) is on screen. */
function busy(label: string): boolean {
  return screen.queryByText(label, { exact: false }) !== null;
}

/** Mounts the view as `main.tsx` does and delivers the opening snapshot. */
function mount(opening: WebviewState): void {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  pushState(opening);
}

/** Types `text` into the question field and presses "Ask question". */
function askQuestion(text: string): void {
  fireEvent.change(field(QUESTION_FIELD), { target: { value: text } });
  fireEvent.click(button(QUESTION_SUBMIT));
}

/** Types `text` into the follow-up field and presses "Ask follow-up". */
function askFollowUp(text: string): void {
  fireEvent.change(field(FOLLOW_UP_FIELD), { target: { value: text } });
  fireEvent.click(button(FOLLOW_UP_SUBMIT));
}

/** Whether the question form is showing its pending state instead of the field. */
function questionPending(): boolean {
  return busy(QUESTION_PENDING) && screen.queryByLabelText(QUESTION_FIELD) === null;
}

// ---------------------------------------------------------------------------
// Request ids
// ---------------------------------------------------------------------------

describe('App — request ids', () => {
  it('gives every request a distinct 32-hex id the host accepts, and openFile none', () => {
    mount(webviewState());

    fireEvent.click(button(LAUNCH_DEV_SERVER));
    fireEvent.click(button(PAIR_CHROME));
    fireEvent.click(button(PICK_ELEMENT));
    askQuestion('Why does the list take so long to appear?');

    pushState(sessionState('ready', { relevantFiles: RELEVANT_FILES }));
    fireEvent.click(button(START_CAPTURE));
    fireEvent.click(button(RELEVANT_FILE));
    fireEvent.click(button(END_SESSION));

    const requests = channel.posted.filter(isWebviewRequestMessage);
    expect(requests.map((message) => message.type)).toEqual([
      'launchDevServer',
      'pairChrome',
      'requestTarget',
      'askQuestion',
      'startCapture',
      'endSession',
    ]);
    const ids = requests.map((message) => message.requestId);
    for (const id of ids) {
      expect(id).toMatch(REQUEST_ID_PATTERN);
    }
    expect(new Set(ids).size).toBe(ids.length);

    // The only frames without an id are the file opens, posted exactly as composed.
    const unidentified = channel.posted.filter((message) => !isWebviewRequestMessage(message));
    expect(unidentified).toEqual([
      {
        type: 'openFile',
        location: {
          file: RELEVANT_FILE,
          line: 1,
          column: 1,
          resolvedBy: 'code-graph',
          confidence: expect.any(Number) as unknown,
        },
      },
    ]);
    expect(unidentified[0]).not.toHaveProperty('requestId');

    // Every frame App posted is one the host's parser accepts as it is.
    for (const message of channel.posted) {
      expect(parseWebviewToHostMessage(message)).toEqual({ ok: true, message });
    }
  });
});

// ---------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------

describe('App — asking a question', () => {
  it('stays pending through unrelated snapshots and notices, and clears the draft on its own accepted result', () => {
    mount(webviewState());

    askQuestion('  Why does the list take so long to appear?  ');

    expect(postedOf('askQuestion')).toEqual([
      {
        type: 'askQuestion',
        requestId: expect.stringMatching(REQUEST_ID_PATTERN) as unknown,
        question: 'Why does the list take so long to appear?',
      },
    ]);
    expect(questionPending()).toBe(true);

    // `state.resetSession()` pushes a snapshot without a session before POST /sessions resolves.
    pushState(webviewState());
    // A different session reopened from the Sessions tree meanwhile.
    pushState(sessionState('generated', {}, { id: NEXT_SESSION_ID }));
    // An informational notice and an unrelated error belong to other requests.
    push({ type: 'notice', level: 'info', message: 'Reopened the stored session.' });
    push({
      type: 'notice',
      level: 'error',
      message: 'Could not launch the dev server: no start script was found.',
    });

    expect(questionPending()).toBe(true);
    // Nothing on screen can raise a second question.
    expect(screen.queryByRole('button', { name: QUESTION_SUBMIT })).toBeNull();
    expect(postedOf('askQuestion')).toHaveLength(1);

    // The new session's own snapshot is presentational too.
    pushState(sessionState('created'));
    expect(questionPending()).toBe(true);

    answer('askQuestion', 'accepted');

    expect(questionPending()).toBe(false);
    expect(field(QUESTION_FIELD).value).toBe('');
    // The new session is mid-pipeline, so the form is inert rather than ready for a duplicate.
    expect(field(QUESTION_FIELD).disabled).toBe(true);
    expect(screen.queryByText(QUESTION_RETRY_HINT)).toBeNull();
    expect(postedOf('askQuestion')).toHaveLength(1);
  });

  it('restores the form with the draft and the retry hint on its own failed result', () => {
    mount(webviewState());

    askQuestion('Why does the list take so long to appear?');
    const firstId = lastRequestId('askQuestion');
    pushState(webviewState());
    push({
      type: 'notice',
      level: 'error',
      message: 'Could not start the session: the local service is not running.',
      hint: 'Run “Debug Generator: Start Local Service”.',
    });
    // The error explains the failure; the result is what ends the request.
    expect(questionPending()).toBe(true);

    answer('askQuestion', 'failed');

    expect(questionPending()).toBe(false);
    expect(field(QUESTION_FIELD).value).toBe('Why does the list take so long to appear?');
    expect(field(QUESTION_FIELD).disabled).toBe(false);
    expect(screen.getByText(QUESTION_RETRY_HINT)).toBeTruthy();
    expect(
      screen.getByText('Could not start the session: the local service is not running.'),
    ).toBeTruthy();

    // Retrying sends the kept question again, under a new id, and retires the hint.
    fireEvent.click(button(QUESTION_SUBMIT));
    expect(postedOf('askQuestion')).toHaveLength(2);
    expect(lastRequestId('askQuestion')).not.toBe(firstId);
    expect(questionPending()).toBe(true);

    // A second answer to the first request settles nothing.
    answer('askQuestion', 'accepted', firstId);
    expect(questionPending()).toBe(true);
  });

  it('clears the draft when the host accepted the question without live updates', () => {
    mount(webviewState());

    askQuestion('Why does the list take so long to appear?');
    push({
      type: 'notice',
      level: 'info',
      message:
        'Session started, but live updates are unavailable until the connection to the local service is restored.',
    });
    pushState(webviewState());
    expect(questionPending()).toBe(true);

    answer('askQuestion', 'accepted');

    expect(questionPending()).toBe(false);
    expect(field(QUESTION_FIELD).value).toBe('');
    expect(screen.queryByText(QUESTION_RETRY_HINT)).toBeNull();
  });

  it('keeps the draft and shows the retry hint when the question could not be posted', () => {
    mount(webviewState());
    channel.deliver = false;

    askQuestion('Why does the list take so long to appear?');

    expect(postedOf('askQuestion')).toHaveLength(1);
    expect(questionPending()).toBe(false);
    expect(field(QUESTION_FIELD).value).toBe('Why does the list take so long to appear?');
    expect(screen.getByText(QUESTION_RETRY_HINT)).toBeTruthy();
    expect(screen.getByText(UNDELIVERED)).toBeTruthy();

    // Once the channel is back, the retry is an ordinary pending request.
    channel.deliver = true;
    fireEvent.click(button(QUESTION_SUBMIT));
    expect(postedOf('askQuestion')).toHaveLength(2);
    expect(questionPending()).toBe(true);
  });

  it('is not settled by opening a relevant file while the question is pending', () => {
    mount(sessionState('generated', { relevantFiles: RELEVANT_FILES }));

    askQuestion('What happens after the task finishes?');
    expect(questionPending()).toBe(true);

    fireEvent.click(button(RELEVANT_FILE));
    const [open] = postedOf('openFile');
    expect(open).toBeDefined();
    expect(open).not.toHaveProperty('requestId');
    expect(questionPending()).toBe(true);

    // The provider acknowledges the open with a snapshot of the unchanged session.
    pushState(sessionState('generated', { relevantFiles: RELEVANT_FILES }));
    expect(questionPending()).toBe(true);
    expect(postedOf('askQuestion')).toHaveLength(1);

    answer('askQuestion', 'accepted');
    expect(questionPending()).toBe(false);
    expect(field(QUESTION_FIELD).value).toBe('');
  });

  it('gives a pending question up at the safety timeout, not before, and ignores its late result', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_758_000_000_000);
    mount(webviewState());

    askQuestion('Why does the list take so long to appear?');
    pushState(webviewState());

    act(() => {
      vi.advanceTimersByTime(PENDING_ACTION_TIMEOUT_MS - 1);
    });
    expect(PENDING_ACTION_TIMEOUT_MS).toBe(150_000);
    expect(questionPending()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(questionPending()).toBe(false);
    expect(field(QUESTION_FIELD).value).toBe('Why does the list take so long to appear?');
    expect(screen.getByText(QUESTION_RETRY_HINT)).toBeTruthy();

    // The request was given up, so its answer arriving now changes nothing.
    answer('askQuestion', 'accepted');
    expect(field(QUESTION_FIELD).value).toBe('Why does the list take so long to appear?');
    expect(screen.getByText(QUESTION_RETRY_HINT)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Capture and target
// ---------------------------------------------------------------------------

describe('App — stopping a capture while picking a target', () => {
  it('keeps Stop capture pending until its own result, whatever answers Pick element', () => {
    mount(
      sessionState('capturing', {
        capture: { active: true, captureId: CAPTURE_ID, eventCount: 12 },
      }),
    );

    fireEvent.click(button(STOP_CAPTURE));
    expect(busy(CAPTURE_PENDING)).toBe(true);

    fireEvent.click(button(PICK_ELEMENT));
    expect(busy(PICK_PENDING)).toBe(true);

    // The host answers the pick with its informational notice and its own result.
    push({
      type: 'notice',
      level: 'info',
      message: 'Asked the Debug Generator panel in Chrome DevTools to enter picker mode.',
    });
    // An informational notice settles nothing: the pick is still pending until its result.
    expect(busy(PICK_PENDING)).toBe(true);
    answer('requestTarget', 'accepted');

    expect(busy(PICK_PENDING)).toBe(false);
    expect(button(PICK_ELEMENT)).toBeTruthy();
    expect(busy(CAPTURE_PENDING)).toBe(true);
    expect(screen.queryByRole('button', { name: STOP_CAPTURE })).toBeNull();

    // Neither a result naming Stop capture with the pick's id nor the capture counter settles it.
    answer('stopCapture', 'accepted', lastRequestId('requestTarget'));
    pushState(
      sessionState('capturing', {
        capture: { active: true, captureId: CAPTURE_ID, eventCount: 20 },
      }),
    );
    expect(busy(CAPTURE_PENDING)).toBe(true);
    expect(postedOf('stopCapture')).toHaveLength(1);

    pushState(
      sessionState('analyzing', {
        capture: { active: false, captureId: CAPTURE_ID, eventCount: 20 },
      }),
    );
    answer('stopCapture', 'accepted');

    expect(busy(CAPTURE_PENDING)).toBe(false);
    expect(postedOf('stopCapture')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The follow-up
// ---------------------------------------------------------------------------

describe('App — asking a follow-up', () => {
  const followUp = { question: 'Why did that step run twice?', askedAt: 1_758_000_040_000 };
  const cleanCleanup = { status: 'clean' as const, completedAt: 1_758_000_050_000, conflicts: [] };

  it('is not settled by End session or its ended snapshot, only by its own result', () => {
    mount(sessionState('generated'));

    askFollowUp('Why did that step run twice?');
    expect(busy(FOLLOW_UP_PENDING)).toBe(true);

    fireEvent.click(button(END_SESSION));
    push({
      type: 'notice',
      level: 'info',
      message: 'Session ended. Every file modification was reverted.',
    });
    pushState(sessionState('ended', { cleanup: cleanCleanup }, { cleanup: cleanCleanup }));
    answer('endSession', 'accepted');

    // End session settled on its own result; the follow-up is still awaiting its own.
    expect(screen.getByText(SESSION_ENDED)).toBeTruthy();
    expect(busy(FOLLOW_UP_PENDING)).toBe(true);
    expect(postedOf('askFollowUp')).toHaveLength(1);

    answer('askFollowUp', 'failed');

    expect(busy(FOLLOW_UP_PENDING)).toBe(false);
    // An ended session takes no follow-up, so the field stays closed rather than inviting a retry.
    expect(screen.queryByLabelText(FOLLOW_UP_FIELD)).toBeNull();
  });

  it('keeps the draft with the retry hint on its own failed result, through unrelated frames', () => {
    mount(sessionState('generated'));

    askFollowUp('Why did that step run twice?');

    // A connection blip, a capture counter, a status change and a warning belong to other things.
    pushState(
      sessionState('generated', {
        connection: {
          status: 'reconnecting',
          serviceUrl: 'http://127.0.0.1:43117',
          serviceReachable: true,
          provider: 'deterministic',
        },
      }),
    );
    pushState(sessionState('generated', { capture: { active: false, eventCount: 14 } }));
    pushState(sessionState('analyzing'));
    pushState(sessionState('generated'));
    push({ type: 'notice', level: 'warning', message: 'Some files could not be restored.' });

    expect(busy(FOLLOW_UP_PENDING)).toBe(true);
    expect(screen.queryByLabelText(FOLLOW_UP_FIELD)).toBeNull();

    push({
      type: 'notice',
      level: 'error',
      message: 'Could not send the follow-up question: the session is busy.',
    });
    answer('askFollowUp', 'failed');

    expect(busy(FOLLOW_UP_PENDING)).toBe(false);
    expect(field(FOLLOW_UP_FIELD).value).toBe('Why did that step run twice?');
    expect(screen.getByText(FOLLOW_UP_RETRY_HINT)).toBeTruthy();
    // Focus, lost when the field was replaced by the busy state, is back on the field.
    expect(document.activeElement).toBe(field(FOLLOW_UP_FIELD));
  });

  it('clears the draft on its own accepted result', () => {
    mount(sessionState('generated'));

    askFollowUp('  Why did that step run twice?  ');
    expect(postedOf('askFollowUp')).toEqual([
      {
        type: 'askFollowUp',
        requestId: expect.stringMatching(REQUEST_ID_PATTERN) as unknown,
        question: 'Why did that step run twice?',
      },
    ]);

    // The follow-up is recorded and re-analysed from the stored capture.
    pushState(sessionState('analyzing', {}, { followUps: [followUp] }));
    pushState(sessionState('generated', {}, { followUps: [followUp] }));
    expect(busy(FOLLOW_UP_PENDING)).toBe(true);

    answer('askFollowUp', 'accepted');

    expect(busy(FOLLOW_UP_PENDING)).toBe(false);
    expect(field(FOLLOW_UP_FIELD).value).toBe('');
    expect(screen.queryByText(FOLLOW_UP_RETRY_HINT)).toBeNull();
    expect(postedOf('askFollowUp')).toHaveLength(1);
  });
});
