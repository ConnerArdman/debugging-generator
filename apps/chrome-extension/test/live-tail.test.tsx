/**
 * The live tail's capture notices (`src/panel/components/LiveTail.tsx`).
 *
 * AAP §0.5.5: an application reloading mid-session shows the event-log entry "Page reloaded during
 * capture" while the same capture continues. The store records each such reload as a
 * `page-reloaded` notice (`test/session-store.test.ts` covers when); this suite covers what the
 * pane renders from them — the worded entry with its time and path, newest first, in a labelled
 * list inside the stream region, whether the composition root passes the notices or leaves the
 * pane to read them from the store — and that the notices never show a URL's query or fragment.
 *
 * It also pins the pane's presentation of hostile captured text (QA-SEC F02): an event whose name,
 * attributes and source location carry markup and a right-to-left override pair renders as text,
 * with each direction control printed as its visible `\u202E`-style escape in the row, its title
 * and the source chip's name, while the row's selection, its source chip and the search filter
 * keep working on the raw captured values.
 *
 * The store is driven exactly as `src/panel/state/connection.ts` drives it, with protocol
 * envelopes minted by the protocol's own `createEnvelope`, and reset to its pristine state around
 * every case. Every mounted tree is unmounted by this file's own `afterEach`. Assertions use the
 * DOM itself (no matcher extension is installed in this project).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { containsDirectionControl } from '@debuggen/panel-renderer';
import { createEnvelope } from '@debuggen/protocol';
import { newCaptureId, newMessageId, newSessionId } from '@debuggen/shared';
import type { CaptureId, SessionId, SourceLocation } from '@debuggen/shared';
import type { TelemetryEvent } from '@debuggen/telemetry';
import type { ReactElement } from 'react';

import { LiveTail } from '../src/panel/components/LiveTail';
import type { LiveTailProps } from '../src/panel/components/LiveTail';
import {
  applyRelayedMessage,
  resetPanelStore,
  setBindingState,
} from '../src/panel/state/session-store';
import type { PanelTailNotice } from '../src/panel/state/session-store';

/** The entry's wording, as AAP §0.5.5 states it. */
const RELOAD_LABEL = 'Page reloaded during capture';

/** The notices list's accessible name. */
const NOTICES_NAME = 'Capture notices, newest first';

/** The inspected tab. */
const TAB_ID = 7;

/** The session's dev-server origin. */
const ORIGIN = 'http://127.0.0.1:20131';

/** A plausible epoch-millisecond clock origin. */
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

let sessionId: SessionId;
let captureId: CaptureId;

/** A pane with inert actions and no events; `overrides` replaces any prop. */
function pane(overrides: Partial<LiveTailProps> = {}): ReactElement {
  return (
    <LiveTail
      events={[]}
      capturing
      collapsed={false}
      onToggleCollapsed={vi.fn()}
      actions={{ onOpenSource: vi.fn(), onSelectEvent: vi.fn() }}
      {...overrides}
    />
  );
}

/** A `page-reloaded` notice of the capture under test. */
function notice(path: string, ts: number): PanelTailNotice {
  return {
    id: newMessageId(),
    kind: 'page-reloaded',
    captureId,
    tabId: TAB_ID,
    url: `${ORIGIN}${path}`,
    ts,
  };
}

/** Bind the tab and start a capture in the store. */
function bindAndCapture(): void {
  setBindingState({ kind: 'bound', sessionId, tabId: TAB_ID, url: `${ORIGIN}/` });
  applyRelayedMessage(createEnvelope('capture.started', { sessionId, captureId }, { ts: T0 }));
}

/** Relay the service's announcement of a same-origin navigation of the bound tab. */
function relayNavigated(path: string, ts: number): void {
  applyRelayedMessage(
    createEnvelope(
      'session.bound',
      { sessionId, tabId: TAB_ID, url: `${ORIGIN}${path}`, reason: 'navigated' },
      { ts },
    ),
  );
}

/** The notices list; throws when it is not rendered. */
function noticeList(): HTMLElement {
  return screen.getByRole('list', { name: NOTICES_NAME });
}

/** The text of each entry of the notices list, in document order. */
function entryTexts(): string[] {
  return within(noticeList())
    .getAllByRole('listitem')
    .map((item) => item.textContent);
}

beforeEach(() => {
  resetPanelStore({ includeConnection: true });
  sessionId = newSessionId();
  captureId = newCaptureId();
});

afterEach(() => {
  cleanup();
  resetPanelStore({ includeConnection: true });
});

describe('LiveTail capture notices', () => {
  it('renders the store notices, newest first, when the root passes none', () => {
    bindAndCapture();
    relayNavigated('/first', T0 + 1_000);
    relayNavigated('/second', T0 + 2_000);

    render(pane());

    const texts = entryTexts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain(RELOAD_LABEL);
    expect(texts[0]).toContain('/second');
    expect(texts[1]).toContain(RELOAD_LABEL);
    expect(texts[1]).toContain('/first');
    expect(
      screen
        .getByRole('button', { name: 'Hide live events (0; 2 notices)' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('shows a reload recorded while it is mounted', () => {
    bindAndCapture();
    render(pane());
    expect(screen.queryByRole('list', { name: NOTICES_NAME })).toBeNull();
    screen.getByRole('button', { name: 'Hide live events (0)' });

    act(() => {
      relayNavigated('/after', T0 + 1_000);
    });

    const texts = entryTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(RELOAD_LABEL);
    expect(texts[0]).toContain('/after');
    screen.getByRole('button', { name: 'Hide live events (0; 1 notice)' });
  });

  it('renders the notices the root passes, newest first, in place of the store', () => {
    bindAndCapture();
    relayNavigated('/from-store', T0 + 500);

    render(pane({ notices: [notice('/older', T0 + 1_000), notice('/newer', T0 + 2_000)] }));

    const texts = entryTexts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('/newer');
    expect(texts[1]).toContain('/older');
    expect(screen.queryByText('/from-store')).toBeNull();
  });

  it('renders no list when the root passes an empty list', () => {
    bindAndCapture();
    relayNavigated('/from-store', T0 + 500);

    render(pane({ notices: [] }));

    expect(screen.queryByRole('list', { name: NOTICES_NAME })).toBeNull();
    expect(screen.queryByText(RELOAD_LABEL)).toBeNull();
  });

  it.each([
    ['awaiting the first event', true],
    ['idle', false],
  ])(
    'shows the notices inside the stream region, above its body, while %s',
    (_state, capturing) => {
      render(pane({ capturing, notices: [notice('/page', T0 + 1_000)] }));

      const list = noticeList();
      expect(within(list).getByText(RELOAD_LABEL).textContent).toBe(RELOAD_LABEL);

      // Inside the region the collapse control names…
      const toggle = screen.getByRole('button', { name: 'Hide live events (0; 1 notice)' });
      const regionId = toggle.getAttribute('aria-controls');
      expect(regionId).not.toBeNull();
      const region = document.getElementById(regionId ?? '');
      expect(region?.contains(list)).toBe(true);

      // …and before the stream body: the loading or the empty state.
      const body = screen.getByRole('status');
      expect(region?.contains(body)).toBe(true);
      expect(list.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    },
  );

  it('hides the notices with the stream while collapsed, and counts them in the control', () => {
    render(pane({ collapsed: true, notices: [notice('/page', T0 + 1_000)] }));

    expect(screen.queryByRole('list', { name: NOTICES_NAME })).toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'Show live events (0; 1 notice)' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it("shows only the new document's path, never its query or fragment", () => {
    render(pane({ notices: [notice('/search?token=s3cr3t-value#access=abc', T0 + 1_000)] }));

    const [text] = entryTexts();
    expect(text).toContain('/search');
    expect(text).not.toContain('s3cr3t-value');
    expect(text).not.toContain('access=abc');
    expect(document.body.textContent).not.toContain('s3cr3t-value');
  });

  it('places no live region over or inside the notices', () => {
    render(pane({ notices: [notice('/page', T0 + 1_000)] }));

    const list = noticeList();
    expect(list.closest('[aria-live]')).toBeNull();
    expect(list.querySelector('[aria-live]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What the tail is of the capture
// ---------------------------------------------------------------------------

/** A persisted event of the capture under test, as the tail relays one. */
function tailEvent(index: number): TelemetryEvent {
  const hex = (index + 1).toString(16).padStart(16, '0');
  return {
    id: `evt_${hex}`,
    traceId: `${hex}${hex}`,
    spanId: hex,
    kind: 'render',
    name: `render row ${String(index)}`,
    startTime: T0 + index,
    duration: 1,
    tier: 'browser',
    attributes: {},
    status: 'ok',
    producerId: 'producer-live-tail-test',
    seq: index,
    sessionId,
    captureId,
    ingestSeq: index + 1,
  };
}

describe('LiveTail — events the service did not stream', () => {
  it('names the capture’s total and what was not streamed live beside the rows', () => {
    const events = Array.from({ length: 3 }, (_, index) => tailEvent(index));
    render(pane({ events, droppedCount: 0, capturedCount: 68_111, skippedCount: 55_600 }));

    expect(
      screen.getByText(
        'Showing the newest 3 of 68,111 captured events; 55,600 were not streamed live',
      ),
    ).toBeTruthy();
  });

  it('reads both counts from the store when the root omits them, even with no rows', () => {
    bindAndCapture();
    act(() => {
      applyRelayedMessage(
        createEnvelope('telemetry.tail', {
          sessionId,
          events: [tailEvent(0)],
          captures: [{ captureId, storedEvents: 9_000, skippedEvents: 8_999 }],
        }),
      );
    });
    render(pane({ events: [] }));

    expect(screen.getByText('8,999 of 9,000 captured events were not streamed live')).toBeTruthy();
  });

  it('states nothing while the tail is merely behind the stored count', () => {
    const events = Array.from({ length: 3 }, (_, index) => tailEvent(index));
    render(pane({ events, droppedCount: 0, capturedCount: 400, skippedCount: 0 }));

    expect(screen.queryByText(/not streamed live/u)).toBeNull();
    expect(screen.queryByText(/Showing the newest/u)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hostile captured text: markup and direction controls (QA-SEC F02)
// ---------------------------------------------------------------------------

/**
 * The label QA-SEC F02 ingested: markup wrapped in U+202E RIGHT-TO-LEFT OVERRIDE and U+202C POP
 * DIRECTIONAL FORMATTING, which drew its tail reversed while `textContent` stayed logical.
 */
const BIDI_LABEL = 'QA_BIDI \u202E</td><script>alert(7)</script>\u202C';

/** The same label as the pane prints it: each control as its visible six-character escape. */
const REVEALED_LABEL = 'QA_BIDI \\u202E</td><script>alert(7)</script>\\u202C';

/** The live grid's accessible name. */
const GRID_NAME = 'Live events, newest first';

/** Where the hostile event was resolved: a file and a symbol carrying the label. */
const BIDI_SOURCE: SourceLocation = {
  file: `src/server/${BIDI_LABEL}.ts`,
  line: 12,
  column: 3,
  symbol: BIDI_LABEL,
  resolvedBy: 'patch',
  confidence: 1,
};

/**
 * A server span whose name, attribute value, request target, statement and source location all
 * carry {@link BIDI_LABEL}, as the service stores and tails it.
 */
function bidiEvent(): TelemetryEvent {
  return {
    ...tailEvent(1),
    kind: 'http.server',
    tier: 'server',
    name: BIDI_LABEL,
    attributes: {
      'qa.note': BIDI_LABEL,
      'http.target': `/api/items?label=${BIDI_LABEL}`,
      'db.statement': `SELECT name FROM item WHERE label = '${BIDI_LABEL}'`,
    },
    source: BIDI_SOURCE,
  };
}

/**
 * Asserts that no text a reader sees, hovers or hears under `root` carries a raw direction
 * control: its text content, and every attribute but the `data-*` ones, which are data rather
 * than presentation and keep raw values by contract.
 *
 * @param root The subtree to read; the document body, so a portalled tooltip is read too.
 */
function expectNoRawDirectionControl(root: Element): void {
  expect(containsDirectionControl(root.textContent)).toBe(false);
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of Array.from(element.attributes)) {
      if (!attribute.name.startsWith('data-')) {
        expect(
          containsDirectionControl(attribute.value),
          `${element.tagName.toLowerCase()}[${attribute.name}]`,
        ).toBe(false);
      }
    }
  }
}

/** The live grid; throws when it is not rendered. */
function liveGrid(): HTMLElement {
  return screen.getByRole('grid', { name: GRID_NAME });
}

describe('LiveTail — hostile captured text', () => {
  it('prints each direction control as its visible escape in the row, its title and its chip', () => {
    // The fixture is hostile: the raw controls are in the event the pane receives.
    expect(containsDirectionControl(bidiEvent().name)).toBe(true);
    render(
      pane({
        events: [tailEvent(0), bidiEvent()],
        notices: [notice(`/reports/${BIDI_LABEL}`, T0 + 1_000)],
      }),
    );

    const grid = liveGrid();
    const name = within(grid).getByText(REVEALED_LABEL);
    expect(name.getAttribute('title')).toBe(REVEALED_LABEL);

    const chip = within(grid).getByRole('button', { name: /QA_BIDI/u });
    expect(chip.getAttribute('aria-label')).toContain('\\u202E');
    expect(chip.textContent).toContain('\\u202C');

    // The markup stayed text: nothing was parsed out of it.
    expect(document.querySelector('script')).toBeNull();
    expect(grid.querySelector('td')).toBeNull();
    expectNoRawDirectionControl(document.body);
  });

  it('selects the row and opens its source with the raw captured values', async () => {
    const user = userEvent.setup();
    const onSelectEvent = vi.fn();
    const onOpenSource = vi.fn();
    const hostile = bidiEvent();
    render(pane({ events: [tailEvent(0), hostile], actions: { onOpenSource, onSelectEvent } }));

    const grid = liveGrid();
    await user.click(within(grid).getByText(REVEALED_LABEL));
    expect(onSelectEvent).toHaveBeenCalledTimes(1);
    expect(onSelectEvent).toHaveBeenCalledWith({
      eventId: hostile.id,
      traceId: hostile.traceId,
      spanId: hostile.spanId,
    });

    await user.click(within(grid).getByRole('button', { name: /QA_BIDI/u }));
    expect(onOpenSource).toHaveBeenCalledTimes(1);
    // The very location the event carried, its file and symbol still holding the raw controls.
    expect(onOpenSource.mock.calls[0]?.[0]).toBe(BIDI_SOURCE);
    expect(onOpenSource).toHaveBeenCalledWith(
      expect.objectContaining({ file: `src/server/${BIDI_LABEL}.ts`, symbol: BIDI_LABEL }),
    );
    // The chip's own click selects nothing: the row activation above is the only one.
    expect(onSelectEvent).toHaveBeenCalledTimes(1);
  });

  it('filters on the raw captured name, not on its revealed display', () => {
    render(pane({ events: [tailEvent(0), bidiEvent()] }));
    expect(within(liveGrid()).getByText('render row 0')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search live events' }), {
      target: { value: '\u202E</td>' },
    });

    const grid = liveGrid();
    expect(within(grid).getByText(REVEALED_LABEL)).toBeTruthy();
    expect(within(grid).queryByText('render row 0')).toBeNull();
  });
});
