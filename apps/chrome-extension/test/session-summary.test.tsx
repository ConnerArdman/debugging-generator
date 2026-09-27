/**
 * `panel/components/SessionSummary` — the summary's disclosure and its progress rows.
 *
 * AAP §0.7.3 makes `PanelView` the body of the DevTools panel; a session's few dozen progress rows
 * must not push a generated panel below the fold (QA VIS-F07), so the summary collapses to a
 * digest the composition root controls. AAP §0.6.4 requires every control to be a renderer
 * primitive and every visual value a token; the e2e and browser suites locate the summary as the
 * region named exactly "Session" and read the question and the project name inside it.
 *
 * What this suite protects:
 *
 *   - without the disclosure props the summary renders expanded, exactly as before, with no
 *     control;
 *   - expanded, the control is a `Button` with `aria-expanded="true"` and `aria-controls` naming
 *     the details it hides; collapsed, `aria-expanded="false"`, no dangling `aria-controls`, and
 *     activating it asks the root to flip the state;
 *   - collapsed, the region keeps its name "Session" and shows the status badge, the project name,
 *     the question, the latest progress row verbatim with its status badge, and the counts —
 *     nothing else: no block, no follow-up list, no progress list;
 *   - rows settled by the store render with their final badge: no "Running" beside a finished or
 *     failed stage (QA VIS-F03, OBS-F14);
 *   - no inline style is written.
 *
 * The component is rendered directly with the props the composition root passes; the progress rows
 * of the settle cases come from the real store, driven with protocol envelopes. Fixture strings are
 * the service's generic vocabulary; no inspected project's names appear.
 */
import type { ModificationRecord, SessionRecord } from '@debuggen/protocol';
import { createEnvelope } from '@debuggen/protocol';
import type { MessagePayload } from '@debuggen/protocol';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionSummary } from '../src/panel/components/SessionSummary';
import type { SessionSummaryProps } from '../src/panel/components/SessionSummary';
import {
  applyRelayedMessage,
  getPanelSnapshot,
  resetPanelStore,
  setBindingState,
} from '../src/panel/state/session-store';
import type { PanelProgressEntry } from '../src/panel/state/session-store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-summary-0001';
const T0 = 1_700_000_000_000;

const SESSION: SessionRecord = {
  id: SESSION_ID,
  projectRoot: '/workspace/sample-project',
  projectName: 'sample-project',
  devServerUrl: 'http://127.0.0.1:3100',
  createdAt: T0,
  updatedAt: T0,
  status: 'generated',
  question: 'Why does the item list take long to appear?',
  followUps: [{ question: 'Which request is the slowest?', askedAt: T0 + 100 }],
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

const MODIFICATION: ModificationRecord = {
  id: 'mod_0123456789abcdef',
  sessionId: SESSION_ID,
  planVersion: 1,
  file: 'src/lib/thing.ts',
  originalHash: 'a'.repeat(64),
  backupPath: `/tmp/debuggen/backups/${SESSION_ID}/${'a'.repeat(64)}`,
  instrumentedHash: 'b'.repeat(64),
  appliedAt: T0 + 20,
  status: 'applied',
  diff: '',
};

const UNDERSTAND_HEADER = 'Understanding problem';
const UNDERSTAND_FAILURE = `${UNDERSTAND_HEADER} failed: Model provider unavailable (MODEL_UNAVAILABLE).`;
const UNDERSTAND_FAILURE_DETAIL =
  'Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER. (error code: MODEL_UNAVAILABLE, ref: ref-0001)';
const INSTRUMENT_HEADER = 'Preparing instrumentation';
const RELOAD_REQUEST =
  'Reload the page so the Debug Generator hook is in place before React loads.';

/** Three rows as the store holds them: two done, one failed — the failed one is not the newest. */
const PROGRESS: readonly PanelProgressEntry[] = [
  { stage: 'understand', status: 'done', message: UNDERSTAND_HEADER, ts: T0 + 1 },
  {
    stage: 'instrument',
    status: 'failed',
    message: 'Could not enable Server spans: no preload.',
    ts: T0 + 2,
  },
  { stage: 'generate-panel', status: 'done', message: 'Generating debugging panel', ts: T0 + 9 },
];

const SHOW_DETAILS = 'Show session details';
const HIDE_DETAILS = 'Hide session details';

/** Render the summary with the root's props, overridden by `overrides`. */
function renderSummary(overrides: Partial<SessionSummaryProps> = {}): ReturnType<typeof render> {
  return render(
    <SessionSummary
      session={SESSION}
      progress={PROGRESS}
      modifications={[MODIFICATION]}
      runtimeHooks={['React renders']}
      unavailable={[]}
      {...overrides}
    />,
  );
}

/** The summary region, located exactly as the browser and e2e suites locate it. */
function summaryRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'Session' });
}

type ProgressPayload = MessagePayload<'session.progress'>;

/** Relay one `session.progress` frame into the real store. */
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

beforeEach(() => {
  resetPanelStore({ includeConnection: true });
  setBindingState({
    kind: 'bound',
    sessionId: SESSION_ID,
    tabId: 7,
    url: 'http://127.0.0.1:3100/',
  });
});

afterEach(() => {
  cleanup();
  resetPanelStore({ includeConnection: true });
});

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

describe('SessionSummary — without the disclosure props', () => {
  it('renders expanded with every block and no control', () => {
    renderSummary();

    const region = summaryRegion();
    expect(within(region).queryByRole('button', { name: SHOW_DETAILS })).toBeNull();
    expect(within(region).queryByRole('button', { name: HIDE_DETAILS })).toBeNull();
    for (const title of ['Progress', 'Instrumentation', 'Signals']) {
      expect(within(region).getByRole('heading', { level: 3, name: title })).toBeTruthy();
    }
    expect(within(region).getByText('Which request is the slowest?')).toBeTruthy();
  });
});

describe('SessionSummary — expanded with a disclosure control', () => {
  it('is a Button with aria-expanded="true" naming the details it hides', async () => {
    const onToggleCollapsed = vi.fn<() => void>();
    const user = userEvent.setup();
    renderSummary({ collapsed: false, onToggleCollapsed });

    const region = summaryRegion();
    const control = within(region).getByRole('button', { name: HIDE_DETAILS });
    expect(control.getAttribute('aria-expanded')).toBe('true');
    const controlsId = control.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    const details = document.getElementById(controlsId ?? '');
    expect(details).not.toBeNull();
    expect(
      within(details ?? region).getByRole('heading', { level: 3, name: 'Progress' }),
    ).toBeTruthy();
    expect(details?.contains(control)).toBe(false);

    await user.click(control);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });
});

describe('SessionSummary — collapsed', () => {
  it('keeps the region named "Session" with the status, project, question, latest row and counts', () => {
    renderSummary({ collapsed: true, onToggleCollapsed: () => undefined });

    const region = summaryRegion();
    expect(within(region).getByRole('heading', { level: 2, name: 'Session' })).toBeTruthy();
    expect(within(region).getByText('Generated')).toBeTruthy();
    expect(within(region).getByText(SESSION.projectName)).toBeTruthy();
    expect(within(region).getByText(SESSION.question)).toBeTruthy();
    // The latest row by the service's stamp, verbatim, with its status word.
    const latest = within(region).getByText('Generating debugging panel');
    // The badge's glyph is decorative (`aria-hidden`) but part of the text content.
    expect(latest.closest('p')?.textContent).toBe(
      '✓Done generate-panel Generating debugging panel',
    );
    expect(within(region).getByText('3 steps · 1 failed · 1 modified file')).toBeTruthy();
  });

  it('shows nothing else: no block, no follow-up list and no progress list', () => {
    renderSummary({ collapsed: true, onToggleCollapsed: () => undefined });

    const region = summaryRegion();
    expect(within(region).queryAllByRole('heading', { level: 3 })).toHaveLength(0);
    expect(within(region).queryByRole('list')).toBeNull();
    expect(within(region).queryByRole('grid')).toBeNull();
    expect(within(region).queryByText('Which request is the slowest?')).toBeNull();
    expect(within(region).queryByText('Could not enable Server spans: no preload.')).toBeNull();
  });

  it('offers "Show session details" with aria-expanded="false" and no dangling aria-controls', async () => {
    const onToggleCollapsed = vi.fn<() => void>();
    const user = userEvent.setup();
    renderSummary({ collapsed: true, onToggleCollapsed });

    const control = within(summaryRegion()).getByRole('button', { name: SHOW_DETAILS });
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(control.hasAttribute('aria-controls')).toBe(false);

    await user.click(control);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('states zero counts and no latest row before any progress arrived', () => {
    renderSummary({
      collapsed: true,
      onToggleCollapsed: () => undefined,
      progress: [],
      modifications: [],
    });

    const region = summaryRegion();
    expect(within(region).getByText('0 steps · 0 modified files')).toBeTruthy();
    expect(within(region).queryByText('Done')).toBeNull();
  });

  it('writes no inline style of its own in either state', () => {
    /** Styled elements outside the renderer's own grid primitive, which owns its track geometry. */
    const ownStyled = (root: HTMLElement): Element[] =>
      [...root.querySelectorAll('[style]')].filter(
        (element) => element.closest('[role="grid"]') === null,
      );
    const view = renderSummary({ collapsed: true, onToggleCollapsed: () => undefined });
    expect(view.container.querySelectorAll('[style]')).toHaveLength(0);
    view.rerender(
      <SessionSummary
        session={SESSION}
        progress={PROGRESS}
        modifications={[MODIFICATION]}
        runtimeHooks={['React renders']}
        unavailable={[]}
        collapsed={false}
        onToggleCollapsed={() => undefined}
      />,
    );
    expect(ownStyled(view.container)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Settled rows
// ---------------------------------------------------------------------------

describe('SessionSummary — rows the store settled', () => {
  it('shows the stage failure in place of its header, with no Running badge', () => {
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);

    renderSummary({
      session: { ...SESSION, status: 'failed' },
      progress: getPanelSnapshot().progress,
    });

    const progressBlock = within(summaryRegion()).getByRole('region', { name: 'Progress' });
    const items = within(progressBlock).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toBe(
      `✕Failed understand ${UNDERSTAND_FAILURE}${UNDERSTAND_FAILURE_DETAIL}`,
    );
    expect(within(summaryRegion()).queryByText('Running')).toBeNull();
  });

  it('shows the "Reload the page…" request done once the stage is ready to capture', () => {
    relayProgress('instrument', 'running', INSTRUMENT_HEADER, T0);
    relayProgress('instrument', 'running', RELOAD_REQUEST, T0 + 1);
    relayProgress('instrument', 'done', INSTRUMENT_HEADER, T0 + 4);
    relayProgress('instrument', 'done', 'Ready to capture', T0 + 5);

    renderSummary({
      session: { ...SESSION, status: 'ready' },
      progress: getPanelSnapshot().progress,
    });

    const region = summaryRegion();
    expect(within(region).queryByText('Running')).toBeNull();
    const reload = within(region).getByText(RELOAD_REQUEST).closest('li');
    expect(reload?.textContent).toContain('Done');
    expect(within(region).getAllByText('Done')).toHaveLength(3);
  });

  it('shows the latest row by stamp when collapsed, even where a failure replaced its header', () => {
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('investigate', 'running', 'Investigating code', T0 + 1);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);

    renderSummary({
      session: { ...SESSION, status: 'failed' },
      progress: getPanelSnapshot().progress,
      collapsed: true,
      onToggleCollapsed: () => undefined,
    });

    const latest = within(summaryRegion()).getByText(UNDERSTAND_FAILURE);
    expect(latest.closest('p')?.textContent).toBe(`✕Failed understand ${UNDERSTAND_FAILURE}`);
  });
});
