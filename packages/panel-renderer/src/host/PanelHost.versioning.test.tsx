/**
 * `host/PanelHost` when a follow-up's panel replaces the one on screen: the
 * version the new document is, and where keyboard focus goes.
 *
 * A follow-up question stores its answer as `panelVersion n + 1` with
 * `supersedes` naming the panel it replaces (AAP 0.4.2), and a surface hands the
 * mounted host the new specification in place. The host remounts its panel
 * column for the new generation, so this suite pins what a reader keeps across
 * that remount:
 *
 * - **The version is stated.** The head shows "Version n" and "Updates version
 *   n-1" beside a title that is left exactly as the document wrote it; a first
 *   version shows neither.
 * - **The replacement is announced once.** A visually hidden polite live
 *   region, mounted outside the keyed column, changes its text when a later
 *   generation arrives and keeps it on a re-delivery of the same one.
 * - **The document is read, never written.** A deep-frozen specification
 *   renders through a replacement without a throw and without a change.
 * - **Focus is carried into the new panel.** Focus that was inside the
 *   outgoing panel — on an evidence chip, or on a control deep inside a node —
 *   lands on the same node's heading in the new one, matched by node id even
 *   when the follow-up reordered the layout, and otherwise on the panel title;
 *   never on `<body>`. A heading borrows `tabindex="-1"` only while it holds
 *   that focus. Focus that was outside the panel, or that the reader parked in
 *   empty space, is never moved.
 *
 * Every string here is generic vocabulary written for this suite; it names
 * nothing of an inspected project.
 */

import type { PanelNode, PanelSpec, PanelSummary } from '@debuggen/panel-schema';
import { PANEL_SPEC_VERSION } from '@debuggen/panel-schema';
import type { SourceLocation } from '@debuggen/shared';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { createDataProvider } from './DataProvider';
import type { DataProvider, DataQueryResolver, DataResultFor } from './DataProvider';
import type { PanelHostActions } from './PanelActions';
import { PanelHost } from './PanelHost';

afterEach(cleanup);

/*
 * ---------------------------------------------------------------------------
 * Fixture
 * ---------------------------------------------------------------------------
 */

/** The session every panel of this suite belongs to. */
const SESSION_ID = 'ses_versioning_suite';

/** The first generation's id, which the second names as the one it supersedes. */
const FIRST_PANEL_ID = 'pnl_versioning_first';

/** The second generation's id. */
const SECOND_PANEL_ID = 'pnl_versioning_second';

/** The title both generations carry: a follow-up does not retitle the panel. */
const PANEL_TITLE = 'Where the interaction spent its time';

/** The title of the query-backed node, which is also its heading. */
const METRIC_NODE_TITLE = 'Recorded work';

/** The one metric the query-backed node asks for. */
const METRIC_ID = 'render_count';

/** What the stub provider answers every metrics query with. */
const METRIC_VALUES: DataResultFor<'metrics'> = [
  { id: METRIC_ID, label: 'Recorded renders', unit: 'count', available: true, value: 4 },
];

/** Where the standalone source-link node points. */
const NODE_LOCATION: SourceLocation = {
  file: 'src/example/versioned-target.ts',
  line: 12,
  column: 3,
  symbol: 'versionedTarget',
  resolvedBy: 'code-graph',
  confidence: 0.75,
};

/** The live region's sentence once version 2 replaces version 1. */
const SECOND_VERSION_ANNOUNCEMENT = 'Showing version 2 of this panel, which updates version 1.';

/** The summary both generations carry: two observed citations and a cause. */
function makeSummary(): PanelSummary {
  return {
    observed: [
      {
        statement: 'The slowest operation took most of the interaction.',
        evidence: [
          { eventId: 'evt-first', label: 'first citation' },
          { eventId: 'evt-second', label: 'second citation' },
        ],
      },
    ],
    likelyCauses: [
      {
        statement: 'A sequential call chain holds the interaction open.',
        evidence: [{ eventId: 'evt-cause', label: 'cause citation' }],
        confidence: 'medium',
      },
    ],
  };
}

/** The title of the section container around the source link. */
const PLACES_TITLE = 'Suggested places';

/**
 * A titled query-backed node, then a titled section holding a source link —
 * or the same two nodes the other way round, as a follow-up that recomposed
 * the panel would store them. The ids are explicit rather than derived from
 * the position, so reordering moves each node's path but not its id.
 *
 * @param reordered Whether the section comes first.
 * @returns The layout, as a fresh forest.
 */
function makeLayout(reordered = false): PanelNode[] {
  const metrics: PanelNode = {
    type: 'metricCards',
    id: 'node-metrics',
    title: METRIC_NODE_TITLE,
    query: { source: 'metrics' },
    metrics: [METRIC_ID],
  };
  const places: PanelNode = {
    type: 'section',
    id: 'node-places',
    title: PLACES_TITLE,
    children: [{ type: 'sourceLink', id: 'node-places-link', location: { ...NODE_LOCATION } }],
  };

  return reordered ? [places, metrics] : [metrics, places];
}

/**
 * One generation of the suite's panel, as the normaliser would store it: the
 * first carries no `supersedes`, every later one names the first.
 *
 * @param panelVersion The generation.
 * @param reordered Whether the layout is recomposed; see {@link makeLayout}.
 * @returns A fresh specification sharing no object with any other.
 */
function makeSpec(panelVersion: number, reordered = false): PanelSpec {
  const later = panelVersion > 1;

  return {
    version: PANEL_SPEC_VERSION,
    id: later ? SECOND_PANEL_ID : FIRST_PANEL_ID,
    sessionId: SESSION_ID,
    panelVersion,
    ...(later ? { supersedes: FIRST_PANEL_ID } : {}),
    title: PANEL_TITLE,
    summary: makeSummary(),
    layout: makeLayout(reordered),
  };
}

/**
 * Freezes a value and everything reachable from it, so any write the host
 * attempted would throw in strict-mode module code.
 *
 * @param value The value to freeze.
 * @returns The same value, frozen throughout.
 */
function deepFreeze<Value>(value: Value): Value {
  if (typeof value === 'object' && value !== null) {
    for (const member of Object.values(value)) {
      deepFreeze(member);
    }
    Object.freeze(value);
  }

  return value;
}

/*
 * ---------------------------------------------------------------------------
 * The stub host
 * ---------------------------------------------------------------------------
 */

/** A provider answering every metrics query, and rejecting anything else. */
function makeProvider(): DataProvider {
  const resolve = vi.fn<DataQueryResolver>((query) =>
    query.source === 'metrics'
      ? Promise.resolve({ source: 'metrics', data: METRIC_VALUES, total: METRIC_VALUES.length })
      : Promise.reject(new Error(`This suite answers no "${query.source}" query.`)),
  );

  return createDataProvider(resolve);
}

/** Host-form actions whose members do nothing but exist. */
function makeActions(): PanelHostActions {
  return { selectEvent: vi.fn(), openSource: vi.fn() };
}

/** The host a surface mounts, bound to one provider and one actions object. */
interface MountedHost {
  /** Draws the host for `spec`, reusing the provider and the actions. */
  readonly draw: (spec: PanelSpec) => ReactElement;
}

/**
 * A host factory whose provider and actions are stable across renders, as a
 * surface's are.
 *
 * @returns The factory.
 */
function mountedHost(): MountedHost {
  const provider = makeProvider();
  const actions = makeActions();

  return {
    draw: (spec) => <PanelHost spec={spec} dataProvider={provider} actions={actions} />,
  };
}

/** The version live region: the viewport's `aria-live` child outside the column. */
function liveRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>(
    '.dg-panel-shell__viewport > [aria-live="polite"]',
  );
  if (region === null) {
    throw new Error('the panel rendered no version live region');
  }

  return region;
}

/** Waits until no view of the panel is still loading. */
async function settled(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
}

/*
 * ---------------------------------------------------------------------------
 * The version
 * ---------------------------------------------------------------------------
 */

describe('PanelHost panel versions', () => {
  it('shows no version for a first panel, and an empty announcement', async () => {
    const host = mountedHost();
    render(host.draw(makeSpec(1)));
    await settled();

    screen.getByRole('heading', { level: 2, name: PANEL_TITLE });
    expect(screen.queryByText(/^Version \d/u)).toBeNull();
    expect(screen.queryByText(/^Updates /u)).toBeNull();
    expect(liveRegion().textContent).toBe('');
  });

  it('marks a follow-up version beside the unchanged title and announces it once', async () => {
    const host = mountedHost();
    const { rerender } = render(host.draw(makeSpec(1)));
    await settled();
    const region = liveRegion();

    rerender(host.draw(makeSpec(2)));
    await settled();

    // The title is the document's own; the version sits beside it.
    const heading = screen.getByRole('heading', { level: 2, name: PANEL_TITLE });
    expect(heading.textContent).toBe(PANEL_TITLE);
    const badge = screen.getByText('Version 2');
    const updates = screen.getByText('Updates version 1');
    expect(heading.contains(badge)).toBe(false);
    expect(heading.parentElement?.contains(updates)).toBe(true);

    // The same region, outside the replaced column, now says what changed —
    // politely, as one atomic sentence, and visually hidden.
    expect(liveRegion()).toBe(region);
    expect(region.textContent).toBe(SECOND_VERSION_ANNOUNCEMENT);
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.classList.contains('dg-visually-hidden')).toBe(true);
    expect(region.closest('.dg-panel')).toBeNull();
    expect(region.hasAttribute('role')).toBe(false);

    // A re-delivery of the same generation changes nothing to announce.
    rerender(host.draw(makeSpec(2)));
    expect(liveRegion()).toBe(region);
    expect(region.textContent).toBe(SECOND_VERSION_ANNOUNCEMENT);

    // A further follow-up is announced again, naming its own predecessor.
    rerender(host.draw({ ...makeSpec(3), id: 'pnl_versioning_third' }));
    expect(region.textContent).toBe('Showing version 3 of this panel, which updates version 2.');
    screen.getByText('Version 3');
    screen.getByText('Updates version 2');
  });

  it('reads the specification without writing into it', async () => {
    const host = mountedHost();
    const first = deepFreeze(makeSpec(1));
    const second = deepFreeze(makeSpec(2));
    const before = JSON.stringify([first, second]);

    const { rerender } = render(host.draw(first));
    await settled();
    rerender(host.draw(second));
    await settled();

    expect(JSON.stringify([first, second])).toBe(before);
    screen.getByText('Version 2');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Focus across the replacement
 * ---------------------------------------------------------------------------
 */

/** The panel title heading, as a reader's assistive technology finds it. */
function panelTitle(): HTMLElement {
  return screen.getByRole('heading', { level: 2, name: PANEL_TITLE });
}

/** The source-link control inside the titled section container. */
function placesControl(): HTMLElement {
  return within(screen.getByRole('region', { name: PLACES_TITLE })).getByRole('button');
}

/**
 * Focuses an element the way a reader's keyboard would leave it focused,
 * inside `act` because a focused chip updates the head's roving tab stop.
 *
 * @param element The element to focus.
 */
function focusInside(element: HTMLElement): void {
  act(() => {
    element.focus();
  });
  expect(document.activeElement).toBe(element);
}

describe('PanelHost focus across a panel replacement', () => {
  it('moves focus from an evidence chip of version 1 to the title of version 2', async () => {
    const host = mountedHost();
    const { rerender } = render(host.draw(makeSpec(1)));
    await settled();

    const chip = screen.getByRole('button', { name: 'first citation' });
    focusInside(chip);

    rerender(host.draw(makeSpec(2)));

    // The chip went with the old column; focus did not go to the body.
    expect(chip.isConnected).toBe(false);
    const title = panelTitle();
    expect(document.activeElement).toBe(title);
    expect(document.activeElement).not.toBe(document.body);
    expect(title.closest('.dg-panel')).not.toBeNull();

    // A script focus target, never a tab stop.
    expect(title.getAttribute('tabindex')).toBe('-1');
    screen.getByText('Version 2');
  });

  it('keeps focus in the same node, on its heading, when the new panel has that node', async () => {
    const host = mountedHost();
    const { rerender } = render(host.draw(makeSpec(1)));
    await settled();

    const control = placesControl();
    focusInside(control);

    rerender(host.draw(makeSpec(2)));
    await settled();

    // The source link has no heading of its own, so its container's heading
    // takes focus — borrowing a tab index only while it holds it.
    const heading = screen.getByRole('heading', { name: PLACES_TITLE });
    expect(control.isConnected).toBe(false);
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');

    const user = userEvent.setup();
    await user.tab();

    expect(document.activeElement).not.toBe(heading);
    expect(document.activeElement).not.toBe(document.body);
    expect(heading.hasAttribute('tabindex')).toBe(false);
  });

  it('finds the same node by its id when the follow-up reordered the layout', async () => {
    const host = mountedHost();
    const { rerender } = render(host.draw(makeSpec(1)));
    await settled();

    focusInside(placesControl());

    // Same ids, swapped positions: the path the control sat at now holds the
    // metric node, so a path match alone would land on the wrong heading.
    rerender(host.draw(makeSpec(2, true)));
    await settled();

    expect(document.activeElement).toBe(screen.getByRole('heading', { name: PLACES_TITLE }));
    expect(document.activeElement).not.toBe(
      screen.getByRole('heading', { name: METRIC_NODE_TITLE }),
    );
  });

  it('finds the same kind of node when an inserted view shifted position-derived ids', async () => {
    // Ids as the normaliser derives them for unnamed nodes: from the position.
    // Version 2 inserts a view first, so "layout.0" now names a metric view
    // and the section moved to "layout.1".
    const places: PanelNode = {
      type: 'section',
      id: 'layout.0',
      title: PLACES_TITLE,
      children: [{ type: 'sourceLink', id: 'layout.0.children.0', location: { ...NODE_LOCATION } }],
    };
    const first: PanelSpec = { ...makeSpec(1), layout: [places] };
    const second: PanelSpec = {
      ...makeSpec(2),
      layout: [
        {
          type: 'metricCards',
          id: 'layout.0',
          title: METRIC_NODE_TITLE,
          query: { source: 'metrics' },
          metrics: [METRIC_ID],
        },
        {
          ...places,
          id: 'layout.1',
          children: [
            { type: 'sourceLink', id: 'layout.1.children.0', location: { ...NODE_LOCATION } },
          ],
        },
      ],
    };

    const host = mountedHost();
    const { rerender } = render(host.draw(first));
    await settled();
    focusInside(placesControl());

    rerender(host.draw(second));
    await settled();

    // The node at the old id and path is a different kind of view; the reader
    // lands on the section they were in, not on the metric view's heading.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: PLACES_TITLE }));
  });

  it('never takes focus from outside the panel', async () => {
    const host = mountedHost();
    const { rerender } = render(
      <>
        <button type="button">Outside the panel</button>
        {host.draw(makeSpec(1))}
      </>,
    );
    await settled();

    // Focus visits the panel, then the reader moves to a control outside it.
    focusInside(screen.getByRole('button', { name: 'first citation' }));
    const outside = screen.getByRole('button', { name: 'Outside the panel' });
    focusInside(outside);

    rerender(
      <>
        <button type="button">Outside the panel</button>
        {host.draw(makeSpec(2))}
      </>,
    );

    expect(document.activeElement).toBe(outside);
  });

  it('leaves focus where the reader parked it outside every control', async () => {
    const host = mountedHost();
    const { rerender } = render(host.draw(makeSpec(1)));
    await settled();

    const chip = screen.getByRole('button', { name: 'first citation' });
    focusInside(chip);

    // A click into empty space: the chip stays attached and loses focus.
    act(() => {
      chip.blur();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(document.body);

    rerender(host.draw(makeSpec(2)));

    expect(document.activeElement).toBe(document.body);
  });

  it('carries focus across the replacement under StrictMode as well', async () => {
    const host = mountedHost();
    const { rerender } = render(<StrictMode>{host.draw(makeSpec(1))}</StrictMode>);
    await settled();

    focusInside(screen.getByRole('button', { name: 'cause citation' }));

    rerender(<StrictMode>{host.draw(makeSpec(2))}</StrictMode>);

    expect(document.activeElement).toBe(panelTitle());
  });

  it('keeps focus that stays inside a re-delivered panel exactly where it is', async () => {
    const host = mountedHost();
    const { rerender } = render(host.draw(makeSpec(2)));
    await settled();

    const chip = screen.getByRole('button', { name: 'second citation' });
    focusInside(chip);

    // Same session, id and generation: the column is kept, and so is focus.
    rerender(host.draw(makeSpec(2)));

    expect(chip.isConnected).toBe(true);
    expect(document.activeElement).toBe(chip);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Keeping restored focus in view while the new panel settles
 * ---------------------------------------------------------------------------
 */

/**
 * A `ResizeObserver` the test drives: it records what it observes and whether
 * it was disconnected, and `resize()` delivers one observation, as the browser
 * does when a view's data arrives and grows the column.
 */
class ControlledResizeObserver {
  /** Every observer constructed while this class is installed, oldest first. */
  static readonly created: ControlledResizeObserver[] = [];

  readonly observed: Element[] = [];

  disconnected = false;

  readonly #callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
    ControlledResizeObserver.created.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {
    // Nothing is observed per element here; `disconnect` is what the host uses.
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** Delivers one resize observation to the host's callback. */
  resize(): void {
    this.#callback([], this);
  }
}

/** The observer watching the mounted panel column, or a test failure. */
function columnObserver(): ControlledResizeObserver {
  const column = document.querySelector('.dg-panel');
  const observer = ControlledResizeObserver.created.find((entry) =>
    entry.observed.includes(column as Element),
  );
  if (observer === undefined) {
    throw new Error('no resize observer watches the panel column');
  }

  return observer;
}

describe('PanelHost keeps restored focus in view while the new panel settles', () => {
  afterEach(() => {
    ControlledResizeObserver.created.length = 0;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Mounts version 1, focuses the source link inside the titled container and
   * replaces the panel with version 2, whose container heading takes focus.
   *
   * @returns The heading focus was restored to, its reveal spy, and the rerender.
   */
  async function restoreOntoContainerHeading(): Promise<{
    readonly heading: HTMLElement;
    readonly reveal: MockInstance<HTMLElement['scrollIntoView']>;
    readonly rerender: (ui: ReactElement) => void;
    readonly host: MountedHost;
  }> {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
    const reveal = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const host = mountedHost();
    const { rerender } = render(host.draw(makeSpec(1)));
    await settled();

    focusInside(placesControl());
    rerender(host.draw(makeSpec(2)));

    const heading = screen.getByRole('heading', { name: PLACES_TITLE });
    expect(document.activeElement).toBe(heading);
    reveal.mockClear();

    return { heading, reveal, rerender, host };
  }

  it('reveals the restored heading at the top each time the new column grows', async () => {
    const { heading, reveal } = await restoreOntoContainerHeading();
    const observer = columnObserver();

    act(() => {
      observer.resize();
    });
    act(() => {
      observer.resize();
    });

    expect(reveal).toHaveBeenCalledTimes(2);
    expect(reveal.mock.contexts.every((context) => context === heading)).toBe(true);
    expect(reveal).toHaveBeenLastCalledWith({ block: 'start', inline: 'nearest' });
    expect(observer.disconnected).toBe(false);
  });

  it('stops for good the moment the reader scrolls, points or types', async () => {
    const { reveal } = await restoreOntoContainerHeading();
    const observer = columnObserver();

    document.dispatchEvent(new Event('wheel'));
    act(() => {
      observer.resize();
    });

    expect(observer.disconnected).toBe(true);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('stops once focus leaves the restored target', async () => {
    const { heading, reveal } = await restoreOntoContainerHeading();
    const observer = columnObserver();

    act(() => {
      heading.blur();
    });
    act(() => {
      observer.resize();
    });

    expect(observer.disconnected).toBe(true);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('stops once the settle window has elapsed', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
    const reveal = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const host = mountedHost();
    const { rerender } = render(host.draw(makeSpec(1)));
    await settled();

    focusInside(placesControl());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rerender(host.draw(makeSpec(2)));
    const observer = columnObserver();
    reveal.mockClear();

    vi.advanceTimersByTime(10_000);
    act(() => {
      observer.resize();
    });

    expect(observer.disconnected).toBe(true);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('hands the watch to the next replacement and ends it when the host unmounts', async () => {
    const { rerender, host } = await restoreOntoContainerHeading();
    const first = columnObserver();

    rerender(host.draw({ ...makeSpec(3), id: 'pnl_versioning_third' }));

    expect(first.disconnected).toBe(true);
    const second = columnObserver();
    expect(second).not.toBe(first);
    expect(second.disconnected).toBe(false);

    cleanup();
    expect(second.disconnected).toBe(true);
  });

  it('watches nothing when focus was never carried across', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
    const host = mountedHost();
    const { rerender } = render(host.draw(makeSpec(1)));
    await settled();

    rerender(host.draw(makeSpec(2)));

    expect(document.activeElement).toBe(document.body);
    const column = document.querySelector('.dg-panel');
    expect(
      ControlledResizeObserver.created.some((entry) => entry.observed.includes(column as Element)),
    ).toBe(false);
  });
});
