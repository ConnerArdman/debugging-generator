/**
 * The contract of `src/panel/components/ConnectionStatus` — the connection pill in the header of
 * the "Debug Generator" DevTools panel (AAP 0.7.3) and what renders beside it.
 *
 * Pinned here:
 *
 *   - **Visible service-down recovery.** In `service-not-running` the remedy is on screen, not
 *     only in a tooltip: the VS Code action by its command-palette title, always, and the shell
 *     command verbatim inside a `code` element when the composition root supplies one. A blank
 *     command is treated exactly like an absent one, and the sentence is punctuated correctly
 *     either way.
 *   - **Nothing beside the pill when nothing is needed.** `connected` and `reconnecting` render no
 *     recovery line.
 *   - **The pairing control.** `not-paired` renders a real button that announces its dialog and
 *     raises the intent once per click.
 *   - **The address control.** `reconnecting` and `service-not-running` render a "Change service
 *     address…" button when — and only when — the owner supplies its callback: a real button that
 *     announces its dialog, raises the intent once per click, sits outside the live region and the
 *     recovery line (whose sentence is unchanged), keeps its element across the two states, and is
 *     named in the tooltip hint only while it is rendered. `connected` and `not-paired` never
 *     render it.
 *   - **The binding notice.** A `tab-left` binding renders `formatTabLeftMessage`'s sentence
 *     inside the live region and names the region with it.
 *   - **The live region.** The recovery line sits outside the `role="status"` element so a
 *     status push never re-announces it, while the region itself stays mounted and announces the
 *     status change.
 *   - **A clean console.** No state or transition makes React (or the component) warn.
 *
 * ## Harness
 *
 * Harness functions are imported explicitly and every mounted tree is cleaned up by this file's
 * own `afterEach`, so the suite does not depend on the project's `globals` setting for Testing
 * Library's automatic cleanup. Spies are restored in the same hook, so a failing assertion cannot
 * leak a spy into the next case. Assertions read DOM properties directly; no custom matchers are
 * installed.
 *
 * Fixture values are generic vocabulary written for this suite; no inspected project's names
 * appear in it (AAP 0.5.4).
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReactElement } from 'react';

import { ConnectionStatus } from '../src/panel/components/ConnectionStatus';
import type { ConnectionStatusProps } from '../src/panel/components/ConnectionStatus';
import {
  PANEL_CONNECTION_LABELS,
  PANEL_CONNECTION_STATUSES,
  formatTabLeftMessage,
} from '../src/shared/messages';
import type { PanelBindingState, PanelConnectionStatus } from '../src/shared/messages';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The command-palette title of the VS Code start-service command, as the palette shows it: the
 * `Debug Generator` category and the `Start Local Service` title the VS Code extension
 * contributes. Written out here rather than imported, so the suite pins the wording a developer
 * sees instead of echoing whatever the component happens to hold.
 */
const PALETTE_TITLE = 'Debug Generator: Start Local Service';

/** The visible recovery sentence when no shell command is supplied. */
const LINE_WITHOUT_COMMAND = `Start it from VS Code with ${PALETTE_TITLE}.`;

/**
 * A generic shell command written for this suite. It carries a flag, a relative path, quoting and
 * a shell operator, so a component that parsed, split, re-quoted or extended the string could not
 * reproduce it byte for byte.
 */
const START_COMMAND = 'node ./service/start.mjs --port 4100 && echo "ready"';

/** The visible recovery sentence when {@link START_COMMAND} is supplied. */
const LINE_WITH_COMMAND = `Start it from VS Code with ${PALETTE_TITLE}, or run ${START_COMMAND} from the Debug Generator repository root.`;

/** A generic service base URL, as the connection slice would carry it. */
const SERVICE_URL = 'http://127.0.0.1:4100';

/** A generic serialized origin for the tab-left notice. */
const LEFT_ORIGIN = 'https://example.test:8443';

/** The `console` methods no render may call. */
const CONSOLE_METHODS = ['error', 'warn'] as const;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A no-op pairing callback for the cases that only observe rendering. */
function noop(): void {
  // Intentionally empty: these cases assert on rendering only.
}

/**
 * A `<ConnectionStatus>` element with the required props filled in and `overrides` applied.
 *
 * @param overrides The props a case varies.
 * @returns The element to render.
 */
function statusElement(overrides: Partial<ConnectionStatusProps> = {}): ReactElement {
  return <ConnectionStatus status="connected" onRequestPairing={noop} {...overrides} />;
}

/**
 * The live region the component renders.
 *
 * @returns The single `role="status"` element.
 */
function statusRegion(): HTMLElement {
  return screen.getByRole('status');
}

/**
 * The visible service-down recovery line: the element that holds the palette title, and the
 * sentence around it. Throws when the line is not rendered, so a case that expects it fails with
 * Testing Library's own diagnostic.
 *
 * `getByText` matches an element's own text, so it finds the emphasised title and never the
 * tooltip bubble, whose single sentence merely contains the title.
 *
 * @returns The element whose text content is the whole recovery sentence.
 */
function recoveryLine(): HTMLElement {
  const title = screen.getByText(PALETTE_TITLE);
  const line = title.parentElement;
  if (line === null) {
    throw new Error('The palette title is not inside a recovery sentence.');
  }
  return line;
}

/**
 * The tooltip bubble, which stays mounted and `hidden` while closed.
 *
 * @returns The `role="tooltip"` element.
 */
function tooltipBubble(): HTMLElement {
  return screen.getByRole('tooltip', { hidden: true });
}

/**
 * The trimmed text content of `element`, or the empty string when it has none. Used for the live
 * region and the tooltip, whose layout wrappers carry no meaningful whitespace; the recovery
 * sentence is compared through its raw `textContent` instead, so the spacing around its
 * punctuation is pinned exactly.
 *
 * @param element The element to read.
 * @returns Its text content, whitespace-normalised to single spaces.
 */
function textOf(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('ConnectionStatus — service not running', () => {
  it('shows the pill and the VS Code action when no start command is supplied', () => {
    const { container } = render(statusElement({ status: 'service-not-running' }));

    expect(textOf(statusRegion())).toBe(PANEL_CONNECTION_LABELS['service-not-running']);
    expect(recoveryLine().textContent).toBe(LINE_WITHOUT_COMMAND);
    expect(container.querySelector('code')).toBeNull();
  });

  it('shows the start command verbatim in a code element, with the repository-root wording', () => {
    render(statusElement({ status: 'service-not-running', serviceStartCommand: START_COMMAND }));

    const line = recoveryLine();
    const codes = line.querySelectorAll('code');
    expect(codes).toHaveLength(1);
    expect(codes[0]?.textContent).toBe(START_COMMAND);
    expect(line.textContent).toBe(LINE_WITH_COMMAND);
  });

  it('trims only the whitespace around a supplied command', () => {
    render(
      statusElement({
        status: 'service-not-running',
        serviceStartCommand: `  ${START_COMMAND}\n`,
      }),
    );

    expect(recoveryLine().querySelector('code')?.textContent).toBe(START_COMMAND);
  });

  it.each([
    ['an empty string', ''],
    ['spaces', '   '],
    ['mixed whitespace', ' \t\n '],
  ])('treats a command of %s like an absent one', (_label, blank) => {
    const { container } = render(
      statusElement({ status: 'service-not-running', serviceStartCommand: blank }),
    );

    expect(recoveryLine().textContent).toBe(LINE_WITHOUT_COMMAND);
    expect(container.querySelector('code')).toBeNull();
    expect(textOf(tooltipBubble())).not.toContain('repository root');
  });

  it('names the same palette title in the tooltip hint, with and without a command', () => {
    const { rerender } = render(
      statusElement({ status: 'service-not-running', serviceUrl: SERVICE_URL }),
    );

    const withoutCommand = textOf(tooltipBubble());
    expect(withoutCommand).toContain(`“${PALETTE_TITLE}”`);
    expect(withoutCommand).toContain(SERVICE_URL);
    expect(withoutCommand).toContain('reconnects automatically');
    expect(withoutCommand).not.toContain('repository root');

    rerender(
      statusElement({
        status: 'service-not-running',
        serviceUrl: SERVICE_URL,
        serviceStartCommand: START_COMMAND,
      }),
    );

    const withCommand = textOf(tooltipBubble());
    expect(withCommand).toContain(`“${PALETTE_TITLE}”`);
    expect(withCommand).toContain('repository root');
    expect(withCommand).toContain('reconnects automatically');
  });

  it('keeps the recovery line outside the live region', () => {
    render(statusElement({ status: 'service-not-running', serviceStartCommand: START_COMMAND }));

    const region = statusRegion();
    expect(region.contains(recoveryLine())).toBe(false);
    expect(textOf(region)).not.toContain(PALETTE_TITLE);
    expect(textOf(region)).not.toContain(START_COMMAND);
  });

  it('announces the change to the service-down status from the same, still-mounted region', () => {
    const { rerender } = render(statusElement({ status: 'connected' }));
    const region = statusRegion();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');

    rerender(statusElement({ status: 'service-not-running' }));

    expect(statusRegion()).toBe(region);
    expect(textOf(region)).toBe(PANEL_CONNECTION_LABELS['service-not-running']);
    expect(region.contains(recoveryLine())).toBe(false);
  });
});

describe('ConnectionStatus — states that need no recovery line', () => {
  it.each(['connected', 'reconnecting'] as const)('renders only the pill when %s', (status) => {
    const { container } = render(
      statusElement({ status, serviceStartCommand: START_COMMAND, serviceUrl: SERVICE_URL }),
    );

    expect(textOf(statusRegion())).toBe(PANEL_CONNECTION_LABELS[status]);
    expect(screen.queryByText(PALETTE_TITLE)).toBeNull();
    expect(container.querySelector('code')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('ConnectionStatus — not paired', () => {
  it('renders a Pair… button that announces its dialog and raises the intent once per click', async () => {
    const user = userEvent.setup();
    const onRequestPairing = vi.fn<() => void>();
    render(statusElement({ status: 'not-paired', onRequestPairing }));

    const button = screen.getByRole('button', { name: 'Pair…' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.hasAttribute('aria-expanded')).toBe(false);
    expect(screen.queryByText(PALETTE_TITLE)).toBeNull();

    await user.click(button);

    expect(onRequestPairing).toHaveBeenCalledTimes(1);
    expect(onRequestPairing).toHaveBeenCalledWith();
  });

  it('reflects the dialog visibility as aria-expanded when the owner reports it', () => {
    const { rerender } = render(statusElement({ status: 'not-paired', pairingDialogOpen: false }));
    expect(screen.getByRole('button', { name: 'Pair…' }).getAttribute('aria-expanded')).toBe(
      'false',
    );

    rerender(statusElement({ status: 'not-paired', pairingDialogOpen: true }));
    expect(screen.getByRole('button', { name: 'Pair…' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });
});

/** The address control's visible label and accessible name. */
const ADDRESS_ACTION = 'Change service address…';

/** The two states in which the worker cannot reach the service. */
const UNREACHABLE_STATUSES = ['reconnecting', 'service-not-running'] as const;

describe('ConnectionStatus — changing the service address', () => {
  it.each(UNREACHABLE_STATUSES)(
    'renders a Change service address… button beside the %s pill that announces its dialog and raises the intent once per click',
    async (status) => {
      const user = userEvent.setup();
      const onRequestAddressChange = vi.fn<() => void>();
      render(statusElement({ status, onRequestAddressChange, serviceStartCommand: START_COMMAND }));

      const button = screen.getByRole('button', { name: ADDRESS_ACTION });
      expect(button.textContent).toBe(ADDRESS_ACTION);
      expect(button.getAttribute('type')).toBe('button');
      expect(button.getAttribute('aria-haspopup')).toBe('dialog');
      expect(button.hasAttribute('aria-expanded')).toBe(false);
      expect(statusRegion().contains(button)).toBe(false);
      expect(textOf(statusRegion())).toBe(PANEL_CONNECTION_LABELS[status]);

      await user.click(button);

      expect(onRequestAddressChange).toHaveBeenCalledTimes(1);
      expect(onRequestAddressChange).toHaveBeenCalledWith();
    },
  );

  it('keeps the recovery line exactly as it reads without the control, and outside it', () => {
    const { rerender } = render(
      statusElement({
        status: 'service-not-running',
        serviceStartCommand: START_COMMAND,
        onRequestAddressChange: noop,
      }),
    );

    const button = screen.getByRole('button', { name: ADDRESS_ACTION });
    expect(recoveryLine().textContent).toBe(LINE_WITH_COMMAND);
    expect(recoveryLine().contains(button)).toBe(false);

    rerender(statusElement({ status: 'service-not-running', onRequestAddressChange: noop }));

    expect(recoveryLine().textContent).toBe(LINE_WITHOUT_COMMAND);
    expect(recoveryLine().contains(screen.getByRole('button', { name: ADDRESS_ACTION }))).toBe(
      false,
    );
  });

  it('reflects the address dialog visibility as aria-expanded when the owner reports it', () => {
    const { rerender } = render(
      statusElement({
        status: 'reconnecting',
        onRequestAddressChange: noop,
        addressDialogOpen: false,
      }),
    );
    expect(screen.getByRole('button', { name: ADDRESS_ACTION }).getAttribute('aria-expanded')).toBe(
      'false',
    );

    rerender(
      statusElement({
        status: 'reconnecting',
        onRequestAddressChange: noop,
        addressDialogOpen: true,
      }),
    );
    expect(screen.getByRole('button', { name: ADDRESS_ACTION }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('keeps the same control element across Reconnecting… and Service not running', () => {
    const { rerender } = render(
      statusElement({ status: 'reconnecting', onRequestAddressChange: noop }),
    );
    const button = screen.getByRole('button', { name: ADDRESS_ACTION });

    rerender(statusElement({ status: 'service-not-running', onRequestAddressChange: noop }));

    expect(screen.getByRole('button', { name: ADDRESS_ACTION })).toBe(button);
    expect(recoveryLine().textContent).toBe(LINE_WITHOUT_COMMAND);
  });

  it.each(['connected', 'not-paired'] as const)(
    'offers no address control when %s, even with the callback',
    (status) => {
      render(statusElement({ status, onRequestAddressChange: noop, serviceUrl: SERVICE_URL }));

      expect(screen.queryByRole('button', { name: ADDRESS_ACTION })).toBeNull();
      expect(textOf(tooltipBubble())).not.toContain(ADDRESS_ACTION);
    },
  );

  it.each(UNREACHABLE_STATUSES)(
    'offers no address control when %s without the callback, and the hint does not name it',
    (status) => {
      render(statusElement({ status, serviceUrl: SERVICE_URL }));

      expect(screen.queryByRole('button', { name: ADDRESS_ACTION })).toBeNull();
      expect(textOf(tooltipBubble())).not.toContain(ADDRESS_ACTION);
    },
  );

  it.each(UNREACHABLE_STATUSES)(
    'names the control in the %s tooltip hint while it is rendered',
    (status) => {
      render(statusElement({ status, serviceUrl: SERVICE_URL, onRequestAddressChange: noop }));

      const hint = textOf(tooltipBubble());
      expect(hint).toContain(ADDRESS_ACTION);
      expect(hint).toContain(SERVICE_URL);
      expect(hint).toContain('pairing');
    },
  );

  it('renders every status with the control offered without an error or a warning', () => {
    const spies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method));
    const { rerender } = render(statusElement());
    for (const status of PANEL_CONNECTION_STATUSES) {
      for (const addressDialogOpen of [undefined, false, true]) {
        rerender(
          statusElement({
            status,
            onRequestAddressChange: noop,
            addressDialogOpen,
            serviceStartCommand: START_COMMAND,
            serviceUrl: SERVICE_URL,
          }),
        );
        expect(textOf(statusRegion())).toBe(PANEL_CONNECTION_LABELS[status]);
      }
    }

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('ConnectionStatus — binding notice', () => {
  it('renders the tab-left notice inside the live region and names the region with it', () => {
    const binding: PanelBindingState = { kind: 'tab-left', origin: LEFT_ORIGIN };
    render(statusElement({ status: 'connected', binding }));

    const notice = screen.getByText(formatTabLeftMessage(LEFT_ORIGIN));
    const region = statusRegion();
    expect(region.contains(notice)).toBe(true);

    const labelledBy = (region.getAttribute('aria-labelledby') ?? '').split(' ');
    expect(labelledBy).toHaveLength(2);
    expect(labelledBy).toContain(notice.id);
  });

  it.each<[string, PanelBindingState]>([
    ['unbound', { kind: 'unbound' }],
    ['bound', { kind: 'bound', sessionId: 'session-1', tabId: 7, url: `${LEFT_ORIGIN}/` }],
  ])('adds nothing for the %s binding', (_kind, binding) => {
    render(statusElement({ status: 'connected', binding }));

    const region = statusRegion();
    expect(textOf(region)).toBe(PANEL_CONNECTION_LABELS.connected);
    expect((region.getAttribute('aria-labelledby') ?? '').split(' ')).toHaveLength(1);
  });
});

describe('ConnectionStatus — console', () => {
  it('renders every status and transition without an error or a warning', () => {
    const spies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method));
    const binding: PanelBindingState = { kind: 'tab-left', origin: LEFT_ORIGIN };
    const commands: readonly (string | undefined)[] = [undefined, '', START_COMMAND];
    const statuses: readonly PanelConnectionStatus[] = PANEL_CONNECTION_STATUSES;

    const { rerender } = render(statusElement());
    for (const status of statuses) {
      for (const serviceStartCommand of commands) {
        rerender(statusElement({ status, serviceStartCommand, serviceUrl: SERVICE_URL, binding }));
        expect(textOf(statusRegion())).toContain(PANEL_CONNECTION_LABELS[status]);
      }
    }

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
