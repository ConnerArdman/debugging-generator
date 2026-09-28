/**
 * `../src/panel/components/PanelView.tsx` when a follow-up's panel replaces the
 * one on screen.
 *
 * The DevTools panel keeps `PanelView` mounted for the whole session and hands
 * it each new specification the service broadcasts, so a follow-up question's
 * answer — `panelVersion n + 1`, `supersedes` naming the panel it replaces
 * (AAP 0.4.2) — arrives as a prop change on a mounted view. What this suite
 * pins, through the real `PanelHost` beneath it:
 *
 * - **The version is visible.** The new panel's head shows "Version 2" and
 *   "Updates version 1" beside a title the view does not change.
 * - **The replacement is announced once.** The host's polite live region, the
 *   same element before and after, carries the new version's sentence.
 * - **Focus stays in the panel.** Focus on an evidence chip of version 1 lands
 *   on the title of version 2 rather than on `<body>`.
 * - **Each generation reads its own panel's evidence.** Every query the views
 *   make carries the id of the panel they were drawn for.
 * - **A hostile failure stays legible (QA-SEC F02).** Markup and a
 *   right-to-left override pair in the generation failure's message render as
 *   text, each direction control printed as its visible `\u202E`-style escape.
 *
 * Collected by the root `vitest.config.ts` into the `chrome-extension` project
 * (happy-dom). Every string here is generic vocabulary written for this suite;
 * it names nothing of an inspected project.
 */

import { containsDirectionControl, createDataProvider } from '@debuggen/panel-renderer';
import type {
  DataProvider,
  DataQueryResolver,
  DataResultFor,
  PanelHostActions,
} from '@debuggen/panel-renderer';
import { PANEL_SPEC_VERSION } from '@debuggen/panel-schema';
import type { PanelSpec } from '@debuggen/panel-schema';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PanelView } from '../src/panel/components/PanelView';

afterEach(cleanup);

/** The session both generations belong to. */
const SESSION_ID = 'ses_panel_view_suite';

/** The first generation's id, which the second supersedes. */
const FIRST_PANEL_ID = 'pnl_panel_view_first';

/** The second generation's id. */
const SECOND_PANEL_ID = 'pnl_panel_view_second';

/** The title both generations carry. */
const PANEL_TITLE = 'Where the interaction spent its time';

/** The one metric the panel's view asks for. */
const METRIC_ID = 'render_count';

/** What the stub resolver answers every metrics query with. */
const METRIC_VALUES: DataResultFor<'metrics'> = [
  { id: METRIC_ID, label: 'Recorded renders', unit: 'count', available: true, value: 4 },
];

/**
 * One generation of the suite's panel.
 *
 * @param panelVersion 1 for the first answer, 2 for the follow-up's.
 * @returns A fresh specification.
 */
function makeSpec(panelVersion: 1 | 2): PanelSpec {
  const later = panelVersion === 2;

  return {
    version: PANEL_SPEC_VERSION,
    id: later ? SECOND_PANEL_ID : FIRST_PANEL_ID,
    sessionId: SESSION_ID,
    panelVersion,
    ...(later ? { supersedes: FIRST_PANEL_ID } : {}),
    title: PANEL_TITLE,
    summary: {
      observed: [
        {
          statement: 'The slowest operation took most of the interaction.',
          evidence: [{ eventId: 'evt-first', label: 'first citation' }],
        },
      ],
      likelyCauses: [],
    },
    layout: [
      {
        type: 'metricCards',
        id: 'node-metrics',
        title: 'Recorded work',
        query: { source: 'metrics' },
        metrics: [METRIC_ID],
      },
    ],
  };
}

/** The stub transport: its provider and its recorded resolver. */
interface StubTransport {
  readonly provider: DataProvider;
  readonly resolve: Mock<DataQueryResolver>;
}

/** A transport answering metrics queries and rejecting anything else. */
function makeTransport(): StubTransport {
  const resolve = vi.fn<DataQueryResolver>((query) =>
    query.source === 'metrics'
      ? Promise.resolve({ source: 'metrics', data: METRIC_VALUES, total: METRIC_VALUES.length })
      : Promise.reject(new Error(`This suite answers no "${query.source}" query.`)),
  );

  return { provider: createDataProvider(resolve), resolve };
}

/** The panel's host actions; nothing in this suite activates them. */
function makeActions(): PanelHostActions {
  return { selectEvent: vi.fn(), openSource: vi.fn() };
}

/** Waits until no view is still loading. */
async function settled(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
}

/** The host's version live region, outside the replaced column. */
function liveRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>(
    '.dg-panel-shell__viewport > [aria-live="polite"]',
  );
  if (region === null) {
    throw new Error('the panel rendered no version live region');
  }

  return region;
}

describe('PanelView replacing a panel with its follow-up version', () => {
  it('shows and announces the new version and keeps focus inside the panel', async () => {
    const { provider, resolve } = makeTransport();
    const actions = makeActions();
    const draw = (spec: PanelSpec) => (
      <PanelView spec={spec} dataProvider={provider} actions={actions} theme="dark" />
    );

    const { rerender } = render(draw(makeSpec(1)));
    await settled();

    // Version 1 states no version, and its live region is silent.
    expect(screen.queryByText(/^Version \d/u)).toBeNull();
    const region = liveRegion();
    expect(region.textContent).toBe('');

    const chip = screen.getByRole('button', { name: 'first citation' });
    act(() => {
      chip.focus();
    });
    expect(document.activeElement).toBe(chip);

    rerender(draw(makeSpec(2)));
    await settled();

    // The title is unchanged, the version sits beside it, and the same live
    // region now says what changed.
    const title = screen.getByRole('heading', { level: 2, name: PANEL_TITLE });
    screen.getByText('Version 2');
    screen.getByText('Updates version 1');
    expect(liveRegion()).toBe(region);
    expect(region.textContent).toBe('Showing version 2 of this panel, which updates version 1.');

    // Focus followed the reader into the new panel rather than falling out.
    expect(chip.isConnected).toBe(false);
    expect(document.activeElement).toBe(title);

    // Each generation's views read that generation's own evidence.
    const panelIds = resolve.mock.calls.map(([, context]) => context.panelId);
    expect(panelIds).toContain(FIRST_PANEL_ID);
    expect(panelIds.at(-1)).toBe(SECOND_PANEL_ID);
  });

  it('shows the version of a panel that first mounts as a later generation', async () => {
    const { provider } = makeTransport();

    render(
      <PanelView spec={makeSpec(2)} dataProvider={provider} actions={makeActions()} theme="dark" />,
    );
    await settled();

    screen.getByText('Version 2');
    screen.getByText('Updates version 1');
    expect(screen.getByRole('heading', { level: 2, name: PANEL_TITLE }).textContent).toBe(
      PANEL_TITLE,
    );
  });
});

/**
 * The label QA-SEC F02 ingested: markup wrapped in U+202E RIGHT-TO-LEFT
 * OVERRIDE and U+202C POP DIRECTIONAL FORMATTING, which drew its tail reversed
 * while `textContent` stayed logical.
 */
const BIDI_LABEL = 'QA_BIDI \u202E</td><script>alert(7)</script>\u202C';

/** The same label as the view prints it: each control as its visible escape. */
const REVEALED_LABEL = 'QA_BIDI \\u202E</td><script>alert(7)</script>\\u202C';

describe('PanelView — hostile failure text', () => {
  it("prints each direction control of the failure's message as its visible escape", () => {
    const { provider } = makeTransport();

    render(
      <PanelView
        spec={undefined}
        status="error"
        error={{ message: `Analysis stopped: ${BIDI_LABEL}` }}
        dataProvider={provider}
        actions={makeActions()}
        theme="dark"
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(`Analysis stopped: ${REVEALED_LABEL}`);
    expect(document.querySelector('script')).toBeNull();
    expect(containsDirectionControl(document.body.textContent)).toBe(false);
    for (const element of document.body.querySelectorAll('*')) {
      for (const attribute of Array.from(element.attributes)) {
        expect(containsDirectionControl(attribute.value), attribute.name).toBe(false);
      }
    }
  });
});
