/**
 * `webview/App` — request correlation and draft retention, end to end through the view.
 *
 * `./vscode-api` is replaced with a scripted host channel: `isVsCodeApiAvailable` answers `true`
 * unless a case withdraws the channel, `postToHost` records every message and answers whether it
 * was delivered, and `subscribeToHost`
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
 *   - the Capture card's copy follows the session status: a follow-up hint once generated,
 *     "Session ended" once ended, and never "Capture becomes available once instrumentation is
 *     ready." after the session has moved past instrumentation;
 *   - a pending follow-up survives End session and its `ended` snapshot, unrelated status changes
 *     and notices; only its own result settles it, keeping or clearing the draft accordingly;
 *   - opening a file while a question is pending settles nothing;
 *   - the safety timeout gives a request up at 150 s, not before, and its late result is ignored;
 *   - a request the host channel refused keeps the draft with the retry hint;
 *   - a pending question stays on screen, read-only and focused, with a visible busy line;
 *   - a question or follow-up over the protocol question limit is never posted: it is withheld at
 *     once with a notice stating the limit, never the host's malformed-frame reply and its 150 s
 *     wait, and the draft is kept without a misleading retry hint;
 *   - the snapshot's `modificationsTotal` reaches the modifications list as its shortfall warning,
 *     whose "Load all modifications" request stays pending until its own result;
 *   - the cleanup outcome lists a conflict's paths in full with "Copy path", hands the conflicts to
 *     the modifications list, and names the files a partial cleanup did not restore;
 *   - the copy follows the session: the question and every follow-up asked are shown verbatim,
 *     the follow-ups with their outcome in words; "Pick element" is offered only to a running
 *     session over a reachable service; the no-session, ended, failed and disconnected states say
 *     why instead of offering a control the host would refuse; and file modifications say
 *     "nothing modified yet" until the plan exists;
 *   - in every state — no host channel, waiting for the first snapshot, and loaded — the shell's
 *     scroll region is the view's first tab stop and is a region named "Debug Generator" by the
 *     view's own visually hidden title, never an anonymous focusable container.
 *
 * Fixtures are realistic `SessionRecord`s and `WebviewState`s with neutral, synthetic wording
 * (AAP 0.5.4).
 */
import type {
  AnalysisResult,
  FollowUpRecord,
  ModificationConflict,
  ModificationRecord,
  SelectedTarget,
  SessionRecord,
  SessionStatus,
} from '@debuggen/protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_WEBVIEW_QUESTION_LENGTH,
  isWebviewRequestMessage,
  parseWebviewToHostMessage,
} from '../webview-messages';
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
  /** Whether the webview API exists — what `isVsCodeApiAvailable` answers when App mounts. */
  available: true,
  /** App's subscription, once its effect has run. */
  handler: undefined as ((message: HostToWebviewMessage) => void) | undefined,
  /** Whether the next `postToHost` is delivered. */
  deliver: true,
  /** Every message App posted, in order. */
  posted: [] as WebviewToHostMessage[],
}));

vi.mock('./vscode-api', () => ({
  isVsCodeApiAvailable: (): boolean => channel.available,
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
  channel.available = true;
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
const CAPTURE_SECTION = 'Capture';
const CAPTURE_UNAVAILABLE = 'Capture becomes available once instrumentation is ready.';
const CAPTURE_ANALYZING =
  'The capture is being analyzed. The result appears under Analysis when it is ready.';
const CAPTURE_FOLLOW_UP_HINT =
  'This capture has been analyzed. Ask a follow-up question below; if it needs new evidence, capture opens here again.';
const CAPTURE_ENDED_TITLE = 'Session ended';
const CAPTURE_ENDED_MESSAGE =
  'Capture is closed for this session. Ask a new question to start another session.';
const CAPTURE_FAILED =
  'Capture is unavailable because the session failed. Retry the failed stage, or end the session and ask the question again.';
const PICK_ELEMENT = 'Pick element';
/** `TargetBadge`'s busy label: the request only asks the bound panel to enter picker mode. */
const PICK_PENDING = 'Asking Chrome DevTools to enter picker mode';
const END_SESSION = 'End session';
const SESSION_ENDED = 'Session ended.';
const LAUNCH_DEV_SERVER = 'Launch dev server';
const PAIR_CHROME = 'Pair Chrome DevTools';
const UNDELIVERED = 'That action could not be passed to the editor.';
/** The limit as the view prints it, in the test run's own locale. */
const LIMIT_TEXT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
  MAX_WEBVIEW_QUESTION_LENGTH,
);
const OVER_LIMIT_NOTICE = `That question is longer than the ${LIMIT_TEXT}-character limit, so it was not sent.`;
const OVER_LIMIT_HINT = `Shorten it to ${LIMIT_TEXT} characters or fewer, then ask again.`;
/** The host's reply to a frame its parser refuses; the view must never provoke it. */
const MALFORMED_HINT_FRAGMENT = 'reinstall the extension';

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

/**
 * Whether the question form is showing its pending state: the visible busy line beside the
 * field, which stays on screen read-only with the submitted draft.
 */
function questionPending(): boolean {
  const questionField = screen.queryByLabelText(QUESTION_FIELD);
  return (
    busy(QUESTION_PENDING) &&
    questionField instanceof HTMLTextAreaElement &&
    questionField.readOnly &&
    !questionField.disabled
  );
}

// ---------------------------------------------------------------------------
// The view's scroll region
// ---------------------------------------------------------------------------

/** The view's own title, which names the shell's scroll region in every state. */
const VIEW_TITLE = 'Debug Generator';
/** The class of `PanelShell`'s scroll viewport, the view's one scroll container. */
const SHELL_VIEWPORT_CLASS = 'dg-panel-shell__viewport';
/** The no-channel state's title. */
const NO_CHANNEL_TITLE = 'This view cannot reach the editor';
/** The loading state's label; `LoadingState` appends an ellipsis, so it is matched as a substring. */
const LOADING_LABEL = 'Loading the Debug Generator session';

/** Mounts the view as `main.tsx` does and delivers nothing, leaving it waiting for its snapshot. */
function mountWithoutSnapshot(): void {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

/**
 * Asserts the shell's scroll viewport is a focusable region named by the view's own hidden title,
 * and that it is the first stop a keyboard user reaches from the top of the document.
 */
async function expectNamedFirstTabStop(): Promise<void> {
  const viewports = document.getElementsByClassName(SHELL_VIEWPORT_CLASS);
  expect(viewports).toHaveLength(1);
  const viewport = viewports.item(0);

  // A region, found by the name a screen reader announces, that is the shell's viewport itself.
  const region = screen.getByRole('region', { name: VIEW_TITLE });
  expect(region).toBe(viewport);
  expect(region.getAttribute('tabindex')).toBe('0');

  // Named by the one level-1 heading the view already renders — no second title was added.
  const titles = screen.getAllByRole('heading', { level: 1 });
  expect(titles).toHaveLength(1);
  const [title] = titles;
  expect(title?.textContent).toBe(VIEW_TITLE);
  expect(title?.id).not.toBe('');
  expect(region.getAttribute('aria-labelledby')).toBe(title?.id);
  expect(region.contains(title ?? null)).toBe(true);

  // From the top of the document, the first Tab lands on the named region.
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  expect(document.activeElement).toBe(document.body);
  await userEvent.setup().tab();
  expect(document.activeElement).toBe(region);
}

describe('App — the view’s scroll region is named and first in the tab order', () => {
  it('without a host channel: the no-channel state’s region is named by the view title', async () => {
    channel.available = false;
    mountWithoutSnapshot();

    expect(screen.getByText(NO_CHANNEL_TITLE)).toBeTruthy();
    await expectNamedFirstTabStop();
  });

  it('before the first snapshot: the loading state’s region is named by the view title', async () => {
    mountWithoutSnapshot();

    expect(busy(LOADING_LABEL)).toBe(true);
    await expectNamedFirstTabStop();
  });

  it('once loaded: the main view’s region is named by the view title', async () => {
    mount(webviewState());

    expect(field(QUESTION_FIELD)).toBeTruthy();
    await expectNamedFirstTabStop();
  });

  it('once loaded with a session: keeps the same name through a later snapshot', async () => {
    mount(sessionState('generated'));
    pushState(sessionState('ended'));

    await expectNamedFirstTabStop();
  });
});

// ---------------------------------------------------------------------------
// Request ids
// ---------------------------------------------------------------------------

describe('App — request ids', () => {
  it('gives every request a distinct 32-hex id the host accepts, and openFile none', () => {
    mount(webviewState());

    fireEvent.click(button(LAUNCH_DEV_SERVER));
    fireEvent.click(button(PAIR_CHROME));
    askQuestion('Why does the list take so long to appear?');

    // A pick is asked of the running session's panel, so it is offered once a session exists.
    pushState(sessionState('ready', { relevantFiles: RELEVANT_FILES }));
    fireEvent.click(button(PICK_ELEMENT));
    fireEvent.click(button(START_CAPTURE));
    fireEvent.click(button(RELEVANT_FILE));
    fireEvent.click(button(END_SESSION));

    const requests = channel.posted.filter(isWebviewRequestMessage);
    expect(requests.map((message) => message.type)).toEqual([
      'launchDevServer',
      'pairChrome',
      'askQuestion',
      'requestTarget',
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
    // Nothing on screen can raise a second question: the field is read-only and the submit
    // control disabled, by pointer and by keyboard alike.
    expect(button(QUESTION_SUBMIT).disabled).toBe(true);
    fireEvent.click(button(QUESTION_SUBMIT));
    fireEvent.keyDown(field(QUESTION_FIELD), { key: 'Enter', ctrlKey: true });
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

  it('keeps the question visible, read-only and focused while a Ctrl+Enter submission is pending', () => {
    mount(sessionState('generated'));
    const question = 'Why does the list take so long to appear?';

    const questionField = field(QUESTION_FIELD);
    questionField.focus();
    fireEvent.change(questionField, { target: { value: question } });
    fireEvent.keyDown(questionField, { key: 'Enter', ctrlKey: true });

    expect(postedOf('askQuestion')).toHaveLength(1);
    expect(questionPending()).toBe(true);
    expect(field(QUESTION_FIELD).value).toBe(question);
    expect(document.activeElement).toBe(field(QUESTION_FIELD));
    expect(screen.getByText(`${QUESTION_PENDING}…`)).toBeTruthy();

    // The new session's snapshot arrives before the result; the field is not disabled under
    // the caret.
    pushState(sessionState('created', {}, { id: NEXT_SESSION_ID }));
    expect(questionPending()).toBe(true);
    expect(document.activeElement).toBe(field(QUESTION_FIELD));

    answer('askQuestion', 'accepted');
    expect(questionPending()).toBe(false);
    expect(field(QUESTION_FIELD).value).toBe('');
  });

  it('never posts a question over the protocol limit, and withholds it at once with the limit stated', () => {
    mount(webviewState());

    // A real text area stops at its maxLength; a value set programmatically does
    // not, which is the path this pre-flight guards. 2 010 characters is the QA
    // reproduction.
    const overLimit = 'q'.repeat(MAX_WEBVIEW_QUESTION_LENGTH + 10);
    askQuestion(overLimit);

    // Nothing reached the host, so no parser refusal and no 150 s wait.
    expect(postedOf('askQuestion')).toEqual([]);
    expect(channel.posted.filter(isWebviewRequestMessage)).toEqual([]);
    expect(questionPending()).toBe(false);
    expect(field(QUESTION_FIELD).value).toBe(overLimit);
    // Nothing was submitted, so the form is not told a submission failed: its "try again" hint
    // would contradict the notice's "shorten it".
    expect(screen.queryByText(QUESTION_RETRY_HINT)).toBeNull();
    expect(screen.getByText(OVER_LIMIT_NOTICE)).toBeTruthy();
    expect(screen.getByText(OVER_LIMIT_HINT)).toBeTruthy();
    expect(screen.queryByText(UNDELIVERED)).toBeNull();
    expect(screen.queryByText(MALFORMED_HINT_FRAGMENT, { exact: false })).toBeNull();

    // Shortened to the limit, the same draft is an ordinary pending request whose
    // frame the host's parser accepts.
    const atLimit = 'q'.repeat(MAX_WEBVIEW_QUESTION_LENGTH);
    askQuestion(atLimit);
    expect(postedOf('askQuestion')).toHaveLength(1);
    const [sent] = postedOf('askQuestion');
    expect(sent?.question).toHaveLength(MAX_WEBVIEW_QUESTION_LENGTH);
    expect(parseWebviewToHostMessage(sent).ok).toBe(true);
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

describe('App — the Capture card follows the session status', () => {
  /** The Capture card: the region its `Section` title names. */
  function captureCard(): HTMLElement {
    return screen.getByRole('region', { name: CAPTURE_SECTION });
  }

  /** The text of the card's `CaptureControls` block, below the section heading, in document order. */
  function captureCopy(): string {
    const block = captureCard().querySelector('.dgv-capture');
    if (block === null) {
      throw new Error('expected the Capture card to hold the capture controls block');
    }
    return block.textContent ?? '';
  }

  it('shows the follow-up hint rather than the instrumentation sentence once generated', () => {
    mount(sessionState('generated'));

    const card = within(captureCard());
    expect(card.getByText(CAPTURE_FOLLOW_UP_HINT)).toBeTruthy();
    expect(card.queryByText(CAPTURE_UNAVAILABLE)).toBeNull();
    expect(card.queryAllByRole('button')).toEqual([]);
    // The Follow-up card the hint points to takes the question.
    expect(field(FOLLOW_UP_FIELD).disabled).toBe(false);
  });

  it('says "Session ended" rather than the instrumentation sentence once ended', () => {
    const cleanCleanup = {
      status: 'clean' as const,
      completedAt: 1_758_000_050_000,
      conflicts: [],
    };
    mount(sessionState('ended', { cleanup: cleanCleanup }, { cleanup: cleanCleanup }));

    const card = within(captureCard());
    expect(card.getByText(CAPTURE_ENDED_TITLE)).toBeTruthy();
    expect(card.getByText(CAPTURE_ENDED_MESSAGE)).toBeTruthy();
    expect(captureCopy()).toBe(`${CAPTURE_ENDED_TITLE}${CAPTURE_ENDED_MESSAGE}`);
    expect(card.queryByText(CAPTURE_UNAVAILABLE)).toBeNull();
    expect(card.queryAllByRole('button')).toEqual([]);
    // The cleanup card keeps its own confirmation beside it.
    expect(screen.getByText(SESSION_ENDED)).toBeTruthy();
    // The new question the copy invites is accepted.
    expect(field(QUESTION_FIELD).disabled).toBe(false);
  });

  it('explains the analysis and the failure in their own words', () => {
    mount(sessionState('analyzing'));
    expect(within(captureCard()).getByText(CAPTURE_ANALYZING)).toBeTruthy();
    expect(within(captureCard()).queryByText(CAPTURE_UNAVAILABLE)).toBeNull();

    pushState(sessionState('failed'));
    expect(within(captureCard()).getByText(CAPTURE_FAILED)).toBeTruthy();
    expect(within(captureCard()).queryByText(CAPTURE_UNAVAILABLE)).toBeNull();
  });

  it('keeps the instrumentation sentence while the pipeline is still preparing the capture', () => {
    mount(sessionState('planning'));

    expect(within(captureCard()).getByText(CAPTURE_UNAVAILABLE)).toBeTruthy();
    expect(within(captureCard()).queryAllByRole('button')).toEqual([]);
  });

  it('walks from the controls to the follow-up hint to "Session ended" as snapshots arrive', () => {
    mount(sessionState('ready'));
    expect(within(captureCard()).getByRole('button', { name: START_CAPTURE })).toBeTruthy();

    pushState(sessionState('generated'));
    expect(captureCopy()).toBe(CAPTURE_FOLLOW_UP_HINT);

    pushState(sessionState('ended'));
    expect(captureCopy()).toBe(`${CAPTURE_ENDED_TITLE}${CAPTURE_ENDED_MESSAGE}`);
    expect(postedOf('startCapture')).toEqual([]);
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

  it('never posts a follow-up over the protocol limit, and withholds it at once with the limit stated', () => {
    mount(sessionState('generated'));

    const overLimit = 'f'.repeat(MAX_WEBVIEW_QUESTION_LENGTH + 1);
    askFollowUp(overLimit);

    expect(postedOf('askFollowUp')).toEqual([]);
    expect(busy(FOLLOW_UP_PENDING)).toBe(false);
    expect(field(FOLLOW_UP_FIELD).value).toBe(overLimit);
    expect(screen.queryByText(FOLLOW_UP_RETRY_HINT)).toBeNull();
    expect(screen.getByText(OVER_LIMIT_NOTICE)).toBeTruthy();
    expect(screen.queryByText(MALFORMED_HINT_FRAGMENT, { exact: false })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Loading the rest of the modification journal
// ---------------------------------------------------------------------------

describe('App — loading the rest of the modification journal', () => {
  const LOAD_ALL = 'Load all modifications';
  const SHORTFALL = 'Showing 0 of 2 recorded file modifications; the rest have not been loaded.';

  it('states the shortfall the snapshot reports and keeps its load request pending until its own result', () => {
    mount(sessionState('generated', { modificationsTotal: 2 }));

    expect(screen.getByText(SHORTFALL)).toBeTruthy();
    expect(screen.queryByText('No files were modified for this session.')).toBeNull();

    fireEvent.click(button(LOAD_ALL));
    const [request] = postedOf('loadModifications');
    expect(request).toEqual({
      type: 'loadModifications',
      requestId: expect.stringMatching(REQUEST_ID_PATTERN) as unknown,
    });
    expect(parseWebviewToHostMessage(request)).toEqual({ ok: true, message: request });
    expect(button(LOAD_ALL).disabled).toBe(true);

    // Neither a snapshot nor a notice settles it; only its own result does.
    pushState(sessionState('generated', { modificationsTotal: 2 }));
    push({
      type: 'notice',
      level: 'warning',
      message: 'Loaded 0 of 2 file modifications recorded for this session.',
    });
    expect(button(LOAD_ALL).disabled).toBe(true);

    answer('loadModifications', 'failed');
    expect(button(LOAD_ALL).disabled).toBe(false);
    expect(postedOf('loadModifications')).toHaveLength(1);
  });

  it('drops the warning once the snapshot no longer counts records the list lacks', () => {
    mount(sessionState('generated', { modificationsTotal: 2 }));
    expect(screen.getByText(SHORTFALL)).toBeTruthy();

    pushState(sessionState('generated', { modificationsTotal: 0 }));

    expect(screen.queryByText(SHORTFALL)).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_ALL })).toBeNull();
    expect(screen.getByText('No files were modified for this session.')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The session cleanup outcome
// ---------------------------------------------------------------------------

describe('App — the session cleanup outcome', () => {
  const EDITED_FILE = 'src/lib/edited/entry.ts';
  const STUCK_FILE = 'src/lib/stuck/worker.ts';
  const RESTORED_FILE = 'src/lib/restored/task.ts';
  const BACKUP_ROOT = '/home/example/.debuggen/backups/ses_4k2p9dq7m1zx0c3v';
  const COMPLETED_AT = 1_758_000_050_000;

  /** One modification record with a distinct id, file and backup. */
  function modification(
    n: number,
    file: string,
    status: ModificationRecord['status'],
  ): ModificationRecord {
    const hash = String(n).repeat(64);
    return {
      id: `mod_${String(n).padStart(16, '0')}`,
      sessionId: SESSION_ID,
      planVersion: 1,
      file,
      originalHash: hash,
      backupPath: `${BACKUP_ROOT}/${hash}`,
      instrumentedHash: 'f'.repeat(64),
      appliedAt: 1_758_000_010_000,
      status,
      diff: `--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,1 @@\n-const a = 0;\n+const a = 1;\n`,
    };
  }

  const edited = modification(1, EDITED_FILE, 'conflict');
  const stuck = modification(2, STUCK_FILE, 'applied');
  const restored = modification(3, RESTORED_FILE, 'reverted');

  const conflict: ModificationConflict = {
    recordId: edited.id,
    sessionId: SESSION_ID,
    file: EDITED_FILE,
    reason: 'content-changed',
    expectedHash: edited.instrumentedHash,
    actualHash: 'e'.repeat(64),
    backupPath: edited.backupPath,
    detectedAt: 1_758_000_040_000,
    message: `'${EDITED_FILE}' was changed after it was instrumented, so nothing was written to it.`,
    diffs: {
      instrumentedToCurrent: `--- a/${EDITED_FILE}\n+++ b/${EDITED_FILE}\n@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;\n`,
    },
  };

  /** Mounts an ended session with `cleanup` and the given records. */
  function mountEnded(
    cleanupState: WebviewState['cleanup'],
    modifications: readonly ModificationRecord[],
    modificationsTotal?: number,
  ): void {
    mount(
      sessionState(
        'ended',
        {
          cleanup: cleanupState,
          modifications: [...modifications],
          ...(modificationsTotal === undefined ? {} : { modificationsTotal }),
        },
        { cleanup: cleanupState, modifications: [...modifications] },
      ),
    );
  }

  it('lists a conflict’s file and backup path in full, wrapped, with "Copy path"', () => {
    mountEnded({ status: 'conflict', completedAt: COMPLETED_AT, conflicts: [conflict] }, [edited]);

    const list = screen.getByRole('list', { name: 'Files left untouched' });
    const codes = Array.from(list.querySelectorAll('code'));
    expect(codes.map((code) => code.textContent)).toEqual([EDITED_FILE, edited.backupPath]);
    for (const code of codes) {
      // Wrapped, never ellipsized: the whole value can be read and selected.
      expect(code.classList.contains('dg-code--wrap')).toBe(true);
    }
    expect(list.textContent ?? '').toContain('Original saved at');
    // The same path is copyable from the modifications list too: one action, one name.
    expect(
      within(list).getByRole('button', {
        name: `Copy path of the saved original of ${EDITED_FILE}`,
      }).textContent,
    ).toBe('Copy path');
  });

  it('passes the conflicts to the modifications list, whose "Open diff" shows the edit', () => {
    mountEnded({ status: 'conflict', completedAt: COMPLETED_AT, conflicts: [conflict] }, [edited]);

    const openDiff = button(`Open diff of your edit to ${EDITED_FILE}`);
    fireEvent.click(openDiff);

    expect(
      screen.getByRole('region', {
        name: `Diff of ${EDITED_FILE} (Your edit since instrumentation)`,
      }).textContent,
    ).toContain('+const a = 2;');
  });

  it('names every file a partial cleanup did not restore, with its status and backup', () => {
    mountEnded(
      { status: 'partial', completedAt: COMPLETED_AT, conflicts: [] },
      [stuck, restored],
      2,
    );

    const list = screen.getByRole('list', { name: 'Files not restored' });
    expect(list.textContent ?? '').toContain(STUCK_FILE);
    expect(list.textContent ?? '').toContain('Applied');
    expect(list.textContent ?? '').toContain(stuck.backupPath);
    expect(list.textContent ?? '').not.toContain(RESTORED_FILE);
    expect(
      within(list).getByRole('button', {
        name: `Copy path of the saved original of ${STUCK_FILE}`,
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Some changes could not be restored automatically. Nothing was overwritten, and the originals are preserved.',
      ),
    ).toBeTruthy();
  });

  it('says every file was restored when the complete journal leaves nothing outstanding', () => {
    mountEnded({ status: 'partial', completedAt: COMPLETED_AT, conflicts: [] }, [restored], 1);

    expect(screen.queryByRole('list', { name: 'Files not restored' })).toBeNull();
    expect(
      screen.getByText(
        'Every file the session changed was restored, but not every cleanup step could be confirmed. Nothing was overwritten.',
      ),
    ).toBeTruthy();
  });

  it('keeps the general partial sentence while the journal has not been counted', () => {
    mountEnded({ status: 'partial', completedAt: COMPLETED_AT, conflicts: [] }, [restored]);

    expect(screen.queryByRole('list', { name: 'Files not restored' })).toBeNull();
    expect(
      screen.getByText(
        'Some changes could not be restored automatically. Nothing was overwritten, and the originals are preserved.',
      ),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Copy that follows the session
// ---------------------------------------------------------------------------

describe('App — copy that follows the session', () => {
  const QUESTION = 'Why does the list take so long to appear?\nIt waits after every click.';
  const QUESTION_LABEL = 'This session’s question';
  const ASKED_LIST = 'Asked in this session';
  const REPICK = 'Pick another element';

  const NO_SESSION_MESSAGE =
    'Ask a question about the behaviour you are debugging. Debug Generator investigates your code, instruments only what it needs, and reports each step here as it happens.';
  const NO_SESSION_SERVICE_MESSAGE =
    'The local Debug Generator service is not reachable, so no session can start yet. Once it is running, ask a question above: Debug Generator investigates your code, instruments only what it needs, and reports each step here as it happens.';

  const FOLLOW_UP_AWAITING = 'Ask a follow-up once the first result is ready.';
  const FOLLOW_UP_WORKING =
    'The session is working on its latest question. Ask another follow-up once that result is ready.';
  const FOLLOW_UP_ENDED =
    'This session has ended, so it takes no more follow-ups. Ask a new question above to start another session.';
  const FOLLOW_UP_FAILED =
    'This session stopped at a failed stage, so it takes no follow-ups. Retry the stage, or ask a new question above.';
  const FOLLOW_UP_SERVICE = 'Start the local Debug Generator service to ask a follow-up.';

  const NOTHING_MODIFIED = 'No files were modified for this session.';
  const NOTHING_MODIFIED_YET = /^No files have been modified yet\./;

  const ANSWERED: FollowUpRecord = {
    question: 'Why did that step run twice?',
    askedAt: 1_758_000_040_000,
    attemptId: 'fua_first',
    attempt: 1,
    needsNewCapture: false,
    captureId: CAPTURE_ID,
    analysisId: 'ana_second',
    panelId: 'pnl_second',
  };
  const RE_ARMED: FollowUpRecord = {
    question: 'Which view started the second request?',
    askedAt: 1_758_000_060_000,
    attemptId: 'fua_second',
    attempt: 1,
    needsNewCapture: true,
    planVersion: 2,
  };

  const ANALYSIS: AnalysisResult = {
    id: 'ana_first',
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    analysisVersion: 1,
    createdAt: 1_758_000_030_000,
    observed: [],
    likelyCauses: [],
    metrics: [],
  };

  const TARGET: SelectedTarget = {
    selector: 'main > section.pane > button[data-role="primary"]',
    tagName: 'button',
    text: 'Run the sample task',
    componentChain: ['InnerTile', 'OuterFrame'],
    url: 'http://localhost:3000/workspace?view=?',
  };

  const CLEAN_CLEANUP = { status: 'clean' as const, completedAt: 1_758_000_050_000, conflicts: [] };

  /** A connection the client has given up on, to a service that did not answer. */
  const DISCONNECTED: WebviewState['connection'] = {
    status: 'closed',
    serviceUrl: 'http://127.0.0.1:43117',
    serviceReachable: false,
    provider: 'deterministic',
  };

  /** A labelled section of the view, found by the group name `App` gives it. */
  function group(name: string): HTMLElement {
    return screen.getByRole('group', { name });
  }

  /** Every button whose accessible text mentions picking an element. */
  function pickButtons(): HTMLElement[] {
    return screen.queryAllByRole('button').filter((element) => /pick/i.test(element.textContent));
  }

  it('shows the session’s question verbatim in the Question section', () => {
    mount(sessionState('investigating', {}, { question: QUESTION }));

    const question = group('Question');
    expect(within(question).getByText(QUESTION_LABEL)).toBeTruthy();
    expect(question.querySelector('.dgv-asked__text')?.textContent).toBe(QUESTION);
    // The form below stays inert mid-pipeline and its field empty: the question is shown, not
    // copied into the draft.
    expect(field(QUESTION_FIELD).value).toBe('');
    expect(field(QUESTION_FIELD).disabled).toBe(true);
  });

  it('lists every follow-up asked, with its outcome in words, above the entry', () => {
    mount(sessionState('generated', { analysis: ANALYSIS }, { followUps: [ANSWERED] }));

    const followUp = group('Follow-up');
    const list = within(followUp).getByRole('list', { name: ASKED_LIST });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('.dgv-asked__text')?.textContent)).toEqual([
      ANSWERED.question,
    ]);
    expect(within(items[0] as HTMLElement).getByText('Answered')).toBeTruthy();
    // A generated session still takes another follow-up.
    expect(field(FOLLOW_UP_FIELD).disabled).toBe(false);
  });

  it('while a follow-up re-arms a capture, lists it as needing one and says the session is working', () => {
    mount(sessionState('ready', { analysis: ANALYSIS }, { followUps: [ANSWERED, RE_ARMED] }));

    const followUp = group('Follow-up');
    const items = within(within(followUp).getByRole('list', { name: ASKED_LIST })).getAllByRole(
      'listitem',
    );
    expect(items.map((item) => item.querySelector('.dg-badge')?.textContent)).toEqual([
      'Answered',
      'Needs a new capture',
    ]);
    expect(within(followUp).getByText(FOLLOW_UP_WORKING)).toBeTruthy();
    expect(within(followUp).queryByText(FOLLOW_UP_AWAITING)).toBeNull();
    expect(screen.queryByLabelText(FOLLOW_UP_FIELD)).toBeNull();
  });

  it('says the first result is awaited before any analysis exists', () => {
    mount(sessionState('ready'));

    expect(within(group('Follow-up')).getByText(FOLLOW_UP_AWAITING)).toBeTruthy();
  });

  it('disconnected with no session: says no session can start yet and offers no pick', () => {
    mount(webviewState({ connection: DISCONNECTED }));

    expect(screen.getByText(NO_SESSION_SERVICE_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(NO_SESSION_MESSAGE)).toBeNull();
    expect(pickButtons()).toEqual([]);
    expect(screen.getByText('No target')).toBeTruthy();
    expect(screen.getByText(/picking one needs the local debug generator service/i)).toBeTruthy();
  });

  it('connected with no session: explains what asking does and offers no pick yet', () => {
    mount(webviewState());

    expect(screen.getByText(NO_SESSION_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(NO_SESSION_SERVICE_MESSAGE)).toBeNull();
    expect(pickButtons()).toEqual([]);
    expect(screen.getByText(/once a session is running, "pick element"/i)).toBeTruthy();
  });

  it('ended: shows the target read-only, offers no pick and says the session takes no follow-ups', () => {
    mount(
      sessionState(
        'ended',
        { target: TARGET, analysis: ANALYSIS, cleanup: CLEAN_CLEANUP },
        { followUps: [ANSWERED], cleanup: CLEAN_CLEANUP },
      ),
    );

    expect(screen.queryByRole('button', { name: REPICK })).toBeNull();
    expect(pickButtons()).toEqual([]);
    expect(screen.getByText('Selected for this session, which has ended.')).toBeTruthy();
    expect(screen.getByText(TARGET.selector)).toBeTruthy();

    const followUp = group('Follow-up');
    expect(within(followUp).getByText(FOLLOW_UP_ENDED)).toBeTruthy();
    expect(within(followUp).queryByText(FOLLOW_UP_AWAITING)).toBeNull();
    // What was asked stays listed after the end.
    expect(within(followUp).getByText(ANSWERED.question)).toBeTruthy();
    expect(screen.getByText(SESSION_ENDED)).toBeTruthy();
  });

  it('failed: offers no pick and says the failed session takes no follow-ups', () => {
    mount(sessionState('failed'));

    expect(pickButtons()).toEqual([]);
    expect(
      screen.getByText(/this session stopped at a failed stage; ask a new question/i),
    ).toBeTruthy();
    expect(within(group('Follow-up')).getByText(FOLLOW_UP_FAILED)).toBeTruthy();
  });

  it.each(['created', 'understanding', 'investigating', 'planning'] as const)(
    '%s: says no file has been modified yet rather than none was',
    (status) => {
      mount(sessionState(status));

      const modifications = group('File modifications');
      expect(within(modifications).getByText(NOTHING_MODIFIED_YET)).toBeTruthy();
      expect(within(modifications).queryByText(NOTHING_MODIFIED)).toBeNull();
    },
  );

  it('generated: offers Pick element, then Pick another element once a target exists', () => {
    mount(sessionState('generated'));

    expect(button(PICK_ELEMENT).disabled).toBe(false);
    expect(within(group('File modifications')).getByText(NOTHING_MODIFIED)).toBeTruthy();

    pushState(sessionState('generated', { target: TARGET }));
    fireEvent.click(button(REPICK));
    expect(postedOf('requestTarget')).toHaveLength(1);
  });

  it('generated with the service unreachable: withholds the pick and the follow-up, saying why', () => {
    mount(sessionState('generated', { connection: DISCONNECTED, analysis: ANALYSIS }));

    expect(pickButtons()).toEqual([]);
    expect(screen.queryByLabelText(FOLLOW_UP_FIELD)).toBeNull();
    expect(within(group('Follow-up')).getByText(FOLLOW_UP_SERVICE)).toBeTruthy();
  });
});
