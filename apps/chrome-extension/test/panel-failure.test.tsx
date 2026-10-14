/**
 * `panel/App` — how the mounted DevTools panel presents a failed session.
 *
 * AAP §0.5.5: "`failed` is a distinct status rendered by both UIs with the failing stage", and a
 * failure is never presented as a successful analysis. AAP §0.7.3: the panel's states include an
 * "`ErrorState` with the failing stage and retry". The service words a stage's failure itself —
 * `‹stage title› failed: ‹summary›`, with the hint, the error code and a diagnostic reference as
 * the row's detail — so the panel shows those words as they are.
 *
 * What this suite protects:
 *
 *   - the failing stage's row is stated once, verbatim, with its hint: no second stage prefix
 *     ("Problem understanding failed: Understanding problem failed: …") — QA VIS-F13, OBS-F14;
 *   - a failed session without a panel never reads "Could not generate the debugging panel" /
 *     "Analysis stopped before a debugging panel was produced" — QA XL-F26;
 *   - with no failure row, the instrumentation failure is stated with its hint and code; with
 *     neither, the notice says honestly that the failing stage has not reached this panel and where
 *     to find it, and an ordinary ✗ "Could not enable …" row is not mistaken for the failure;
 *   - a panel from an earlier run stays on screen beneath the notice, and the notice's retry
 *     re-reads the session state;
 *   - the progress list shows no stale "Running" row beside the stage's failure;
 *   - beside a generated panel the summary starts collapsed, so the panel — the body of the
 *     DevTools panel — follows it closely (QA VIS-F07); the developer's toggle holds for that panel,
 *     a new panel version collapses it again, and a failed session or a session without a panel
 *     keeps it expanded.
 *
 * Harness: the panel connection module is replaced with one whose `resync` is a spy and which
 * answers no port request, so the real store, data provider, actions and components run unchanged.
 * The store is reset around every case. Fixture strings are the service's generic vocabulary; no
 * inspected project's names appear.
 */
import { PANEL_SPEC_VERSION } from '@debuggen/panel-schema';
import type { PanelSpec } from '@debuggen/panel-schema';
import type { MessagePayload, SessionRecord } from '@debuggen/protocol';
import { createEnvelope, parseSessionRecord } from '@debuggen/protocol';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { App } from '../src/panel/App';
import type * as ConnectionModule from '../src/panel/state/connection';
import {
  applyRelayedMessage,
  applySessionSnapshot,
  resetPanelStore,
} from '../src/panel/state/session-store';

const harness = vi.hoisted(() => ({
  /** Stands in for the connection's hydration re-run, so a case can count it. */
  resync: vi.fn<() => void>(),
}));

vi.mock('../src/panel/state/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  return {
    ...actual,
    startPanelConnection: () => ({ ...actual.getPanelConnection(), stop: () => undefined }),
    getPanelConnection: () => ({ ...actual.getPanelConnection(), resync: harness.resync }),
    onPortDisconnect: () => () => undefined,
    panelRequest: (): Promise<unknown> =>
      Promise.reject(new Error('This suite answers no port request.')),
  };
});

// ---------------------------------------------------------------------------
// Copy the assertions read
// ---------------------------------------------------------------------------

const FAILURE_TITLE = 'The debugging session failed';
const FALLBACK_MESSAGE = 'The session stopped before the failing stage was reported to this panel.';
const FALLBACK_HINT =
  'The failing stage and its next step are listed in the Debug Generator view in VS Code.';
const RELOAD_SESSION_LABEL = 'Reload session state';
const PANEL_VIEW_FAILURE_TITLE = 'Could not generate the debugging panel';
const PANEL_VIEW_FAILURE_MESSAGE = 'Analysis stopped before a debugging panel was produced.';

// ---------------------------------------------------------------------------
// Fixtures — the service's own row shapes
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-failure-0001';
const T0 = 1_700_000_000_000;

const UNDERSTAND_HEADER = 'Understanding problem';
const UNDERSTAND_FAILURE = `${UNDERSTAND_HEADER} failed: Model provider unavailable (MODEL_UNAVAILABLE).`;
const UNDERSTAND_FAILURE_DETAIL =
  'Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER. (error code: MODEL_UNAVAILABLE, ref: ref-0001)';
const INSTRUMENT_HEADER = 'Preparing instrumentation';
const INSTRUMENT_FAILURE = `${INSTRUMENT_HEADER} failed: Instrumentation could not be installed.`;
const INSTRUMENT_FAILURE_DETAIL =
  'Start the dev server from the Debug Generator view, then try again. (error code: INSTRUMENTATION_INSTALL_FAILED, ref: ref-0002)';
const DEGRADATION_ROW = 'Could not enable Server spans: no preload.';

const FAILED_SESSION: SessionRecord = {
  id: SESSION_ID,
  projectRoot: '/workspace/sample-project',
  projectName: 'sample-project',
  devServerUrl: 'http://127.0.0.1:3100',
  createdAt: T0,
  updatedAt: T0,
  status: 'failed',
  question: 'Why does the item list take long to appear?',
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

/** A panel an earlier run of the session generated. */
const EARLIER_PANEL: PanelSpec = {
  version: PANEL_SPEC_VERSION,
  id: 'panel-failure-0001',
  sessionId: SESSION_ID,
  panelVersion: 1,
  title: 'Where the item list spends its time',
  summary: { observed: [], likelyCauses: [] },
  layout: [],
};

/** Show `session` as the bound, connected session, with `panel` when one is given. */
function showSession(session: SessionRecord, panel?: PanelSpec): void {
  applySessionSnapshot({
    session,
    panel,
    connection: { status: 'connected', serviceUrl: 'http://127.0.0.1:43117' },
    binding: { kind: 'bound', sessionId: SESSION_ID, tabId: 7, url: 'http://127.0.0.1:3100/' },
  });
}

type ProgressPayload = MessagePayload<'session.progress'>;

/** Relay one `session.progress` frame for the session under test. */
function relayProgress(
  stage: ProgressPayload['stage'],
  status: ProgressPayload['status'],
  message: string,
  ts: number,
  detail?: string,
): void {
  applyRelayedMessage(
    createEnvelope(
      'session.progress',
      {
        sessionId: SESSION_ID,
        stage,
        status,
        message,
        ...(detail === undefined ? {} : { detail }),
      },
      { ts },
    ),
  );
}

/** The failure notice: the live region whose title reads {@link FAILURE_TITLE}. */
function failureNotice(): HTMLElement {
  const notice = screen.getByText(FAILURE_TITLE).closest('[role="status"]');
  if (!(notice instanceof HTMLElement)) {
    throw new Error('The failure notice is not a polite live region.');
  }
  return notice;
}

/** The "Session" summary region. */
function summaryRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'Session' });
}

let consoleError: MockInstance;
let consoleWarn: MockInstance;

beforeEach(() => {
  resetPanelStore({ includeConnection: true });
  harness.resync.mockReset();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  resetPanelStore({ includeConnection: true });
  expect(consoleError).not.toHaveBeenCalled();
  expect(consoleWarn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('the failed-session fixture', () => {
  it('is a valid SessionRecord', () => {
    expect(parseSessionRecord(FAILED_SESSION).ok).toBe(true);
  });
});

describe('App — a stage failure is stated once, in the service’s words', () => {
  it('shows the failing stage’s row verbatim with its hint, and no doubled prefix anywhere', () => {
    showSession(FAILED_SESSION);
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);

    const { container } = render(<App theme="dark" />);

    const notice = failureNotice();
    expect(within(notice).getByText(UNDERSTAND_FAILURE)).toBeTruthy();
    expect(within(notice).getByText(UNDERSTAND_FAILURE_DETAIL)).toBeTruthy();
    expect(notice.textContent?.split(UNDERSTAND_HEADER)).toHaveLength(2);
    expect(within(notice).getByRole('button', { name: RELOAD_SESSION_LABEL })).toBeTruthy();

    const text = container.textContent ?? '';
    expect(text).not.toContain('Problem understanding');
    expect(text).not.toMatch(/failed: [^.]*failed:/u);
  });

  it('names the failing instrumentation stage with its hint, never blaming analysis', () => {
    showSession(FAILED_SESSION);
    relayProgress('instrument', 'running', INSTRUMENT_HEADER, T0);
    relayProgress('instrument', 'failed', INSTRUMENT_FAILURE, T0 + 5, INSTRUMENT_FAILURE_DETAIL);

    const { container } = render(<App theme="dark" />);

    const notice = failureNotice();
    expect(within(notice).getByText(INSTRUMENT_FAILURE)).toBeTruthy();
    expect(within(notice).getByText(INSTRUMENT_FAILURE_DETAIL)).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).not.toContain(PANEL_VIEW_FAILURE_TITLE);
    expect(text).not.toContain(PANEL_VIEW_FAILURE_MESSAGE);
  });

  it('lists the failure in place of the stage’s header, with no stale Running row', () => {
    showSession(FAILED_SESSION);
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);

    render(<App theme="dark" />);

    const items = within(summaryRegion()).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('Failed');
    expect(items[0]?.textContent).toContain(UNDERSTAND_FAILURE);
    expect(within(summaryRegion()).queryByText('Running')).toBeNull();
  });

  it('states the latest stage failure when an earlier stage failed before it', () => {
    showSession(FAILED_SESSION);
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);
    relayProgress('instrument', 'running', INSTRUMENT_HEADER, T0 + 10);
    relayProgress('instrument', 'failed', INSTRUMENT_FAILURE, T0 + 20, INSTRUMENT_FAILURE_DETAIL);
    // A follow-up re-ran the first stage, which failed last.
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0 + 30);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 40, UNDERSTAND_FAILURE_DETAIL);

    render(<App theme="dark" />);

    const notice = failureNotice();
    expect(within(notice).getByText(UNDERSTAND_FAILURE)).toBeTruthy();
    expect(within(notice).queryByText(INSTRUMENT_FAILURE)).toBeNull();
  });
});

describe('App — a failed session without a failure row', () => {
  it('states the instrumentation failure with its hint and code', () => {
    showSession(FAILED_SESSION);
    applyRelayedMessage(
      createEnvelope(
        'instrumentation.failed',
        {
          sessionId: SESSION_ID,
          error: {
            code: 'INSTRUMENTATION_INSTALL_FAILED',
            message: 'Instrumentation could not be installed.',
            hint: 'Start the dev server from the Debug Generator view, then try again.',
            ref: 'ref-0003',
          },
        },
        { ts: T0 + 5 },
      ),
    );

    render(<App theme="dark" />);

    const notice = failureNotice();
    expect(within(notice).getByText('Instrumentation could not be installed.')).toBeTruthy();
    expect(
      within(notice).getByText(
        'Start the dev server from the Debug Generator view, then try again.',
      ),
    ).toBeTruthy();
    expect(within(notice).getByText('INSTRUMENTATION_INSTALL_FAILED')).toBeTruthy();
    expect(notice.textContent).not.toContain('Instrumentation failed:');
  });

  it('says honestly that the failing stage has not reached this panel, and where to find it', () => {
    showSession(FAILED_SESSION);

    const { container } = render(<App theme="dark" />);

    const notice = failureNotice();
    expect(within(notice).getByText(FALLBACK_MESSAGE)).toBeTruthy();
    expect(within(notice).getByText(FALLBACK_HINT)).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).not.toContain(PANEL_VIEW_FAILURE_TITLE);
    expect(text).not.toContain(PANEL_VIEW_FAILURE_MESSAGE);
  });

  it('does not take an ordinary ✗ “Could not enable …” row for the session’s failure', () => {
    showSession(FAILED_SESSION);
    relayProgress('instrument', 'running', INSTRUMENT_HEADER, T0);
    relayProgress('instrument', 'failed', DEGRADATION_ROW, T0 + 1);

    render(<App theme="dark" />);

    const notice = failureNotice();
    expect(within(notice).getByText(FALLBACK_MESSAGE)).toBeTruthy();
    expect(within(notice).queryByText(DEGRADATION_ROW)).toBeNull();
  });
});

describe('App — a failed session beside a panel from an earlier run', () => {
  it('keeps the earlier panel beneath the notice, and the retry re-reads the session', async () => {
    showSession(FAILED_SESSION, EARLIER_PANEL);
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);
    const user = userEvent.setup();

    render(<App theme="dark" />);

    const notice = failureNotice();
    expect(within(notice).getByText(UNDERSTAND_FAILURE)).toBeTruthy();
    const panelTitle = screen.getByText(EARLIER_PANEL.title);
    expect(
      notice.compareDocumentPosition(panelTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByText(FAILURE_TITLE)).toHaveLength(1);

    await user.click(within(notice).getByRole('button', { name: RELOAD_SESSION_LABEL }));
    expect(harness.resync).toHaveBeenCalledTimes(1);
  });

  it('renders no failure notice once the session is no longer failed', () => {
    showSession({ ...FAILED_SESSION, status: 'generated' }, EARLIER_PANEL);

    render(<App theme="dark" />);

    expect(screen.queryByText(FAILURE_TITLE)).toBeNull();
    expect(screen.getByText(EARLIER_PANEL.title)).toBeTruthy();
  });
});

describe('App — the session summary beside a generated panel', () => {
  const SHOW_DETAILS = 'Show session details';
  const HIDE_DETAILS = 'Hide session details';
  const GENERATED_SESSION: SessionRecord = { ...FAILED_SESSION, status: 'generated' };

  /** Relay the rows a generated session reports, enough to fill an expanded summary. */
  function relayGeneratedRun(): void {
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'done', UNDERSTAND_HEADER, T0 + 1);
    relayProgress('instrument', 'running', INSTRUMENT_HEADER, T0 + 2);
    relayProgress('instrument', 'done', INSTRUMENT_HEADER, T0 + 3);
    relayProgress('instrument', 'done', 'Ready to capture', T0 + 4);
    relayProgress('generate-panel', 'running', 'Generating debugging panel', T0 + 5);
    relayProgress('generate-panel', 'done', 'Generating debugging panel', T0 + 6);
  }

  it('starts collapsed to its digest, with the generated panel right after it', () => {
    showSession(GENERATED_SESSION, EARLIER_PANEL);
    relayGeneratedRun();

    render(<App theme="dark" />);

    const summary = summaryRegion();
    const control = within(summary).getByRole('button', { name: SHOW_DETAILS });
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(within(summary).getByText(GENERATED_SESSION.question)).toBeTruthy();
    expect(within(summary).getByText(GENERATED_SESSION.projectName)).toBeTruthy();
    expect(within(summary).queryByRole('heading', { level: 3 })).toBeNull();
    expect(within(summary).queryByRole('list')).toBeNull();
    expect(within(summary).getByText('4 steps · 0 modified files')).toBeTruthy();

    const panelTitle = screen.getByText(EARLIER_PANEL.title);
    expect(summary.contains(panelTitle)).toBe(false);
    expect(
      summary.compareDocumentPosition(panelTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps the developer’s choice for that panel, and collapses again for a new panel version', async () => {
    showSession(GENERATED_SESSION, EARLIER_PANEL);
    relayGeneratedRun();
    const user = userEvent.setup();

    render(<App theme="dark" />);
    await user.click(within(summaryRegion()).getByRole('button', { name: SHOW_DETAILS }));

    const hide = within(summaryRegion()).getByRole('button', { name: HIDE_DETAILS });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(
      within(summaryRegion()).getByRole('heading', { level: 3, name: 'Progress' }),
    ).toBeTruthy();

    // A live push that changes nothing about the panel keeps the choice.
    act(() => {
      relayProgress('cleanup', 'running', 'Removing instrumentation', T0 + 10);
    });
    expect(within(summaryRegion()).getByRole('button', { name: HIDE_DETAILS })).toBeTruthy();

    // A follow-up's new panel version returns the summary to its default.
    const nextPanel: MessagePayload<'panel.generated'>['panel'] = {
      version: PANEL_SPEC_VERSION,
      id: 'panel-failure-0002',
      sessionId: SESSION_ID,
      panelVersion: 2,
      title: EARLIER_PANEL.title,
      summary: { observed: [], likelyCauses: [] },
      layout: [],
    };
    act(() => {
      applyRelayedMessage(
        createEnvelope(
          'panel.generated',
          { sessionId: SESSION_ID, panelId: nextPanel.id, panel: nextPanel },
          { ts: T0 + 20 },
        ),
      );
    });
    expect(await within(summaryRegion()).findByRole('button', { name: SHOW_DETAILS })).toBeTruthy();
  });

  it('stays expanded for a failed session, even beside an earlier panel', () => {
    showSession(FAILED_SESSION, EARLIER_PANEL);
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);

    render(<App theme="dark" />);

    const hide = within(summaryRegion()).getByRole('button', { name: HIDE_DETAILS });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(
      within(summaryRegion()).getByRole('heading', { level: 3, name: 'Progress' }),
    ).toBeTruthy();
  });

  it('stays expanded while no panel has been generated', () => {
    showSession({ ...FAILED_SESSION, status: 'ready' });

    render(<App theme="dark" />);

    expect(within(summaryRegion()).getByRole('button', { name: HIDE_DETAILS })).toBeTruthy();
    expect(
      within(summaryRegion()).getByRole('heading', { level: 3, name: 'Progress' }),
    ).toBeTruthy();
  });
});
