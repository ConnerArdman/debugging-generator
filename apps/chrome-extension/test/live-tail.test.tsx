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
 * The store is driven exactly as `src/panel/state/connection.ts` drives it, with protocol
 * envelopes minted by the protocol's own `createEnvelope`, and reset to its pristine state around
 * every case. Every mounted tree is unmounted by this file's own `afterEach`. Assertions use the
 * DOM itself (no matcher extension is installed in this project).
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvelope } from '@debuggen/protocol';
import { newCaptureId, newMessageId, newSessionId } from '@debuggen/shared';
import type { CaptureId, SessionId } from '@debuggen/shared';
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
