/**
 * The contract of `components/StatusBar` — the always-visible status line of
 * the editor view (AAP 0.7.3: "service connection, provider").
 *
 * Pinned here:
 *
 *   - **A pill per connection state**, with the tone and wording each state is
 *     given, inside a polite live region (never `role="alert"` for a transient
 *     reconnect — AAP 0.5.5's "Reconnecting…").
 *   - **A pill per session status**, total over the protocol's eleven statuses.
 *   - **The provider verbatim**, and nothing invented when it is absent.
 *   - **The retry callback**, offered only while the connection is not
 *     established, and invoked with no arguments.
 *   - **The three states**: empty (the connection pill still renders), loading
 *     (badge plus text, never a skeleton) and error (an `ErrorState` for a
 *     `closed` connection with no retry, outside the live region).
 *   - **Privacy**: no credential-shaped string reaches the screen, even when the
 *     configured service URL carries one.
 *   - **Exhaustiveness at runtime**: a value outside the union fails loudly.
 *
 * Fixture values are generic vocabulary written for this suite; no inspected
 * project's names appear in it (AAP 0.5.4).
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CONNECTION_STATES, SESSION_STATUSES } from '@debuggen/protocol';
import type { ConnectionState, SessionStatus } from '@debuggen/protocol';

import { StatusBar } from './StatusBar';

/** The service URL a default installation is configured with. */
const SERVICE_URL = 'http://127.0.0.1:43117';

/*
 * An obviously fake user-information pair for the privacy cases. It is joined
 * at runtime rather than written as one literal so that no contiguous URL with
 * embedded user information exists in tracked source for the secrets gate to
 * flag (AAP 0.3.4) — the same fragment technique that gate uses on itself.
 * Neither half is, or resembles, a real credential.
 */
const FAKE_USER = 'example-user';
const FAKE_SECRET = 'not-a-real-secret';
const FAKE_USER_INFO = [FAKE_USER, FAKE_SECRET].join(':');

/** A no-op callback for the cases that only observe rendering. */
function noop(): void {
  // Intentionally empty: these cases assert on rendering only.
}

/**
 * The live region the bar renders.
 *
 * @returns The `role="status"` element named for the view.
 */
function statusRegion(): HTMLElement {
  return screen.getByRole('status', { name: 'Debug Generator status' });
}

/**
 * The single badge whose visible label is `label`.
 *
 * @param label The badge text.
 * @returns The `.dg-badge` element.
 */
function badge(label: string): HTMLElement {
  return screen.getByText(label, { selector: '.dg-badge' });
}

/** Tone and wording each connection state must render with. */
const EXPECTED_CONNECTION: Readonly<
  Record<ConnectionState, { tone: string; label: string; detail?: string }>
> = {
  connecting: {
    tone: 'dg-badge--info',
    label: 'Connecting…',
    detail: 'Contacting the local service.',
  },
  open: { tone: 'dg-badge--success', label: 'Connected' },
  reconnecting: {
    tone: 'dg-badge--warning',
    label: 'Reconnecting…',
    detail: 'Connection lost. Retrying automatically.',
  },
  closed: {
    tone: 'dg-badge--danger',
    label: 'Disconnected',
    detail: 'Not connected to the local service.',
  },
};

/** Tone and wording each session status must render with. */
const EXPECTED_SESSION: Readonly<Record<SessionStatus, { tone: string; label: string }>> = {
  created: { tone: 'dg-badge--neutral', label: 'Created' },
  understanding: { tone: 'dg-badge--info', label: 'Understanding' },
  investigating: { tone: 'dg-badge--info', label: 'Investigating' },
  planning: { tone: 'dg-badge--info', label: 'Planning' },
  instrumenting: { tone: 'dg-badge--info', label: 'Instrumenting' },
  ready: { tone: 'dg-badge--accent', label: 'Ready to capture' },
  capturing: { tone: 'dg-badge--warning', label: 'Capturing' },
  analyzing: { tone: 'dg-badge--info', label: 'Analyzing' },
  generated: { tone: 'dg-badge--success', label: 'Panel generated' },
  ended: { tone: 'dg-badge--neutral', label: 'Ended' },
  failed: { tone: 'dg-badge--danger', label: 'Failed' },
};

describe('StatusBar connection pill', () => {
  it.each(CONNECTION_STATES.map((state) => [state]))(
    'renders the %s state as a toned, labelled badge inside the polite live region',
    (state) => {
      const expected = EXPECTED_CONNECTION[state];
      render(<StatusBar connection={state} onRetryConnection={noop} />);

      const region = statusRegion();
      expect(region.getAttribute('aria-atomic')).toBe('false');
      expect(region.getAttribute('data-connection-status')).toBe(state);

      const pill = within(region).getByText(expected.label, { selector: '.dg-badge' });
      expect(pill.classList.contains(expected.tone)).toBe(true);
      expect(within(region).getByText('Service')).toBeDefined();

      if (expected.detail === undefined) {
        expect(region.textContent).not.toContain('local service');
      } else {
        expect(within(region).getByText(expected.detail)).toBeDefined();
      }

      // A transient state is never announced as an alert.
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it('covers every connection state the protocol declares', () => {
    expect(Object.keys(EXPECTED_CONNECTION).sort()).toEqual([...CONNECTION_STATES].sort());
  });

  it('renders the loading states as badge plus text, never as a skeleton', () => {
    const { rerender } = render(<StatusBar connection="connecting" />);
    expect(badge('Connecting…')).toBeDefined();
    expect(screen.getByText('Contacting the local service.')).toBeDefined();
    expect(document.querySelector('.dg-loading-state')).toBeNull();

    rerender(<StatusBar connection="reconnecting" />);
    expect(badge('Reconnecting…')).toBeDefined();
    expect(screen.getByText('Connection lost. Retrying automatically.')).toBeDefined();
    expect(document.querySelector('.dg-loading-state')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('switches pills in place as the connection state changes, keeping one live region', () => {
    const { rerender } = render(<StatusBar connection="open" />);
    expect(badge('Connected')).toBeDefined();

    rerender(<StatusBar connection="reconnecting" />);
    expect(screen.queryByText('Connected', { selector: '.dg-badge' })).toBeNull();
    expect(badge('Reconnecting…')).toBeDefined();
    expect(screen.getAllByRole('status')).toHaveLength(1);

    rerender(<StatusBar connection="open" />);
    expect(badge('Connected')).toBeDefined();
    expect(screen.queryByText('Reconnecting…')).toBeNull();
  });
});

describe('StatusBar retry', () => {
  it('invokes onRetryConnection once, with no arguments, when the retry control is activated', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn<() => void>();
    render(<StatusBar connection="closed" onRetryConnection={onRetry} />);

    const retry = screen.getByRole('button', { name: 'Retry connection' });
    expect(retry).toHaveProperty('type', 'button');
    await user.click(retry);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith();
  });

  it('is reachable and operable from the keyboard', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn<() => void>();
    render(<StatusBar connection="reconnecting" onRetryConnection={onRetry} />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retry connection' }));
    await user.keyboard('{Enter}');

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each([['connecting'], ['reconnecting'], ['closed']] as const)(
    'offers the retry control while the connection is %s',
    (state) => {
      render(<StatusBar connection={state} onRetryConnection={noop} />);
      expect(screen.getByRole('button', { name: 'Retry connection' })).toBeDefined();
    },
  );

  it('offers no retry control once the connection is open', () => {
    render(<StatusBar connection="open" onRetryConnection={noop} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers no retry control when the parent supplied no callback', () => {
    render(<StatusBar connection="reconnecting" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('StatusBar error state', () => {
  it('reports a closed connection with no retry as an ErrorState outside the live region', () => {
    render(<StatusBar connection="closed" serviceUrl={SERVICE_URL} />);

    const alert = screen.getByRole('alert');
    expect(alert.classList.contains('dg-error-state')).toBe(true);
    expect(within(alert).getByText('Local service unavailable')).toBeDefined();
    expect(
      within(alert).getByText(
        'This view is not connected to the local Debug Generator service, so sessions cannot start or update.',
      ),
    ).toBeDefined();
    expect(alert.textContent).toContain('Start Local Service');

    // The bar itself stays: the pill still states the connection, and the
    // failure is announced once, by the alert, not nested inside the status.
    const region = statusRegion();
    expect(within(region).getByText('Disconnected', { selector: '.dg-badge' })).toBeDefined();
    expect(within(region).queryByRole('alert')).toBeNull();
    expect(region.contains(alert)).toBe(false);
    expect(within(region).queryByText('Not connected to the local service.')).toBeNull();
  });

  it('keeps a recoverable closed connection inline: badge, explanation and retry, no alert', () => {
    render(<StatusBar connection="closed" onRetryConnection={noop} />);

    const region = statusRegion();
    expect(within(region).getByText('Disconnected', { selector: '.dg-badge' })).toBeDefined();
    expect(within(region).getByText('Not connected to the local service.')).toBeDefined();
    expect(within(region).getByRole('button', { name: 'Retry connection' })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([['connecting'], ['open'], ['reconnecting']] as const)(
    'renders no ErrorState for the %s state even without a retry',
    (state) => {
      render(<StatusBar connection={state} />);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(document.querySelector('.dg-error-state')).toBeNull();
    },
  );
});

describe('StatusBar session status', () => {
  it.each(SESSION_STATUSES.map((status) => [status]))(
    'renders the %s status as a toned, labelled badge',
    (status) => {
      const expected = EXPECTED_SESSION[status];
      render(<StatusBar connection="open" sessionStatus={status} />);

      const region = statusRegion();
      const pill = within(region).getByText(expected.label, { selector: '.dg-badge' });
      expect(pill.classList.contains(expected.tone)).toBe(true);
      expect(pill.getAttribute('data-session-status')).toBe(status);
      expect(within(region).getByText('Session')).toBeDefined();
    },
  );

  it('covers every session status the protocol declares', () => {
    expect(Object.keys(EXPECTED_SESSION).sort()).toEqual([...SESSION_STATUSES].sort());
  });

  it('renders no session badge before a session exists', () => {
    render(<StatusBar connection="open" provider="deterministic" />);
    expect(screen.queryByText('Session')).toBeNull();
    expect(document.querySelector('[data-session-status]')).toBeNull();
  });
});

describe('StatusBar provider and service URL', () => {
  it('renders the provider name verbatim as an outline badge', () => {
    render(<StatusBar connection="open" provider="Custom-Provider_2" />);

    const pill = badge('Custom-Provider_2');
    expect(pill.classList.contains('dg-badge--outline')).toBe(true);
    expect(pill.textContent).toBe('Custom-Provider_2');
    expect(screen.getByText('Provider')).toBeDefined();
  });

  it.each([['deterministic'], ['anthropic']])(
    'renders the %s provider exactly as given',
    (name) => {
      render(<StatusBar connection="open" provider={name} />);
      expect(badge(name).textContent).toBe(name);
    },
  );

  it('invents no provider when none is configured, and ignores a blank one', () => {
    const { rerender } = render(<StatusBar connection="open" />);
    expect(screen.queryByText('Provider')).toBeNull();

    rerender(<StatusBar connection="open" provider="   " />);
    expect(screen.queryByText('Provider')).toBeNull();
    expect(document.querySelectorAll('.dg-badge')).toHaveLength(1);
  });

  it('renders the service URL as monospace code with its full value as the tooltip', () => {
    render(<StatusBar connection="open" serviceUrl={SERVICE_URL} />);

    const code = screen.getByText(SERVICE_URL);
    expect(code.tagName).toBe('CODE');
    expect(code.classList.contains('dg-code--sm')).toBe(true);
    expect(code.classList.contains('dgv-status-bar__item')).toBe(true);
    expect(code.getAttribute('title')).toBe(SERVICE_URL);
  });

  it('keeps a service URL path', () => {
    render(<StatusBar connection="open" serviceUrl="ws://localhost:43117/ws" />);
    expect(screen.getByText('ws://localhost:43117/ws').tagName).toBe('CODE');
  });

  it('renders nothing for an absent or blank service URL', () => {
    const { rerender } = render(<StatusBar connection="open" />);
    expect(document.querySelector('code')).toBeNull();

    rerender(<StatusBar connection="open" serviceUrl="  " />);
    expect(document.querySelector('code')).toBeNull();
  });
});

describe('StatusBar empty state', () => {
  it('still renders the connection pill with nothing else supplied, and no placeholder values', () => {
    render(<StatusBar connection="open" />);

    const region = statusRegion();
    expect(within(region).getByText('Connected', { selector: '.dg-badge' })).toBeDefined();
    expect(region.querySelectorAll('.dg-badge')).toHaveLength(1);
    expect(region.textContent).toBe('ServiceConnected');
    expect(region.textContent).not.toMatch(/undefined|null|n\/a/i);
  });

  it('carries the root class and appends the caller class', () => {
    const { container } = render(<StatusBar connection="open" className="extra-placement" />);

    const root = container.firstElementChild;
    expect(root?.classList.contains('dgv-status-bar')).toBe(true);
    expect(root?.classList.contains('extra-placement')).toBe(true);
    expect(root?.classList.contains('dg-stack')).toBe(true);
  });
});

describe('StatusBar privacy', () => {
  /**
   * Every piece of text and every attribute value the bar puts in the
   * document, so a credential cannot hide in a tooltip or a data attribute.
   *
   * @param root The rendered container.
   * @returns The concatenated text and attribute values.
   */
  function everythingRendered(root: HTMLElement): string {
    const attributes = [root, ...root.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].map((attribute) => attribute.value),
    );
    return [root.textContent, ...attributes].join('\n');
  }

  it('strips user information, query and fragment from the displayed service URL', () => {
    const { container } = render(
      <StatusBar
        connection="open"
        serviceUrl={`http://${FAKE_USER_INFO}@127.0.0.1:43117/base?token=abc123#frag`}
        provider="deterministic"
        sessionStatus="capturing"
      />,
    );

    const code = screen.getByText('http://127.0.0.1:43117/base');
    expect(code.getAttribute('title')).toBe('http://127.0.0.1:43117/base');

    const rendered = everythingRendered(container);
    expect(rendered).not.toContain(FAKE_USER);
    expect(rendered).not.toContain(FAKE_SECRET);
    expect(rendered).not.toContain('token=');
    expect(rendered).not.toContain('abc123');
    expect(rendered).not.toContain('frag');
  });

  it('scrubs a service URL that does not parse as a web URL', () => {
    const { container } = render(
      <StatusBar connection="open" serviceUrl={`${FAKE_USER_INFO}@127.0.0.1:43117?key=abc`} />,
    );

    expect(screen.getByText('127.0.0.1:43117').tagName).toBe('CODE');
    const rendered = everythingRendered(container);
    expect(rendered).not.toContain(FAKE_SECRET);
    expect(rendered).not.toContain('key=');
  });

  it('renders no credential-shaped string in any state', () => {
    const credentialShapes = [
      /bearer\s/i,
      /\bsk-[a-z0-9-]{8,}/i,
      /\beyJ[A-Za-z0-9_-]{8,}\./,
      /api[_-]?key/i,
      /password/i,
      /[?&](?:token|key|secret)=/i,
    ];

    for (const connection of CONNECTION_STATES) {
      const { container, unmount } = render(
        <StatusBar
          connection={connection}
          serviceUrl={SERVICE_URL}
          provider="deterministic"
          sessionStatus="generated"
        />,
      );
      const rendered = everythingRendered(container);
      for (const shape of credentialShapes) {
        expect(rendered).not.toMatch(shape);
      }
      unmount();
    }
  });

  it('never logs', async () => {
    const user = userEvent.setup();
    const logged = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];

    const { rerender } = render(
      <StatusBar
        connection="reconnecting"
        serviceUrl={SERVICE_URL}
        provider="deterministic"
        sessionStatus="ready"
        onRetryConnection={noop}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Retry connection' }));
    rerender(<StatusBar connection="closed" serviceUrl={SERVICE_URL} />);

    for (const spy of logged) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe('StatusBar exhaustiveness', () => {
  it('fails loudly on a connection state outside the union', () => {
    // React 19 reports an uncaught render error through `console.error` as well
    // as rethrowing it; silence the report so the assertion is the only output.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unknownState = 'suspended' as unknown as ConnectionState;

    expect(() => render(<StatusBar connection={unknownState} />)).toThrow(
      /Unhandled service connection state/,
    );
    reported.mockRestore();
  });

  it('fails loudly on a session status outside the union', () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unknownStatus = 'paused' as unknown as SessionStatus;

    expect(() => render(<StatusBar connection="open" sessionStatus={unknownStatus} />)).toThrow(
      /Unhandled session status/,
    );
    reported.mockRestore();
  });
});
