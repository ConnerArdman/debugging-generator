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
 *   - **Direction controls are shown, never obeyed**: a U+202E/U+202C pair in
 *     the provider or the service URL prints as visible escapes.
 *   - **The retry callback**, offered as an enabled control in every state but
 *     `open`, and invoked exactly once, with no arguments, when activated.
 *   - **The three states**: empty (the connection pill still renders), loading
 *     (badge plus text, never a skeleton) and error (an `ErrorState` for a
 *     `closed` connection with no retry, outside the live region).
 *   - **Privacy**: no credential-shaped string reaches the screen, even when the
 *     configured service URL carries one.
 *   - **Exhaustiveness at runtime**: a value outside the union fails loudly.
 *
 * ## Why the loops read the real vocabularies
 *
 * Every per-member case iterates the tuples the protocol exports
 * (`CONNECTION_STATES`, `SESSION_STATUSES`) rather than a list copied into this
 * file, and the expectation tables are total `Record`s keyed by the component's
 * own prop types — the connection state as `WebviewState` in
 * `../../webview-messages` carries it. A state added upstream therefore breaks
 * this suite twice: the tables stop type-checking until the new member is given
 * a label, and the runtime coverage cases fail until the component renders one.
 *
 * ## Harness
 *
 * Harness functions are imported explicitly and every mounted tree is cleaned
 * up by this file's own `afterEach`, so the suite does not depend on the
 * project's `globals` setting for Testing Library's automatic cleanup. Spies are
 * restored in the same hook, so a failing assertion cannot leak a silenced
 * `console` into the next case.
 *
 * Fixture values are generic vocabulary written for this suite; no inspected
 * project's names appear in it (AAP 0.5.4).
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONNECTION_STATES, SESSION_STATUSES } from '@debuggen/protocol';
import type { SessionStatus } from '@debuggen/protocol';
import type { ReactElement } from 'react';

import type { WebviewState } from '../../webview-messages';
import { StatusBar } from './StatusBar';

/**
 * The connection vocabulary exactly as the component's `connection` prop and
 * the host's snapshot type it — read off `WebviewState`, never restated.
 */
type ConnectionStatus = WebviewState['connection']['status'];

/**
 * Every connection state the suite iterates. Assigning the protocol's tuple to
 * the snapshot's type proves the tuple holds nothing the prop does not accept;
 * the total `EXPECTED_CONNECTION` table below proves the converse, so the two
 * vocabularies cannot drift apart without a typecheck failure here.
 */
const CONNECTION_CASES: readonly ConnectionStatus[] = CONNECTION_STATES;

/** Every session status the suite iterates, straight from the protocol. */
const SESSION_CASES: readonly SessionStatus[] = SESSION_STATUSES;

/** The service URL a default installation is configured with. */
const SERVICE_URL = 'http://127.0.0.1:43117';

/**
 * A neutral provider name written for this suite. It is deliberately neither a
 * vendor nor one of the product's configured provider ids, so a component that
 * defaulted to either could not pass the verbatim and absent cases by accident.
 */
const SYNTHETIC_PROVIDER = 'synthetic-provider.v2';

/** The five `console` methods the bar must never call (AAP 0.5.2). */
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/*
 * Credential shapes that must never reach the screen (AAP 0.5.6). The bar never
 * receives a token, so these document and guard that boundary. Each literal is
 * a bare prefix with nothing after it, so no tracked credential shape exists
 * here for the secrets gate to flag (AAP 0.3.4).
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /sk-/,
  /Bearer /,
  /bearer\s/i,
  /ghp_/,
  /github_pat_/,
  /AKIA/,
  /\beyJ[A-Za-z0-9_-]{8,}\./,
  /api[_-]?key/i,
  /password/i,
  /[?&](?:token|key|secret)=/i,
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

/**
 * The concatenated text content of every badge the bar rendered, in document
 * order — how each pill's label reaches the screen.
 *
 * @param root The element to search.
 * @returns One entry per `.dg-badge`, its text trimmed.
 */
function badgeLabels(root: ParentNode): string[] {
  return [...root.querySelectorAll('.dg-badge')].map((element) =>
    (element.textContent ?? '').trim(),
  );
}

/**
 * Renders the bar with the given props, unmounts it, and returns what it put
 * on screen — for the cases that sweep every state in one test.
 *
 * @param element The `<StatusBar>` element to render.
 * @returns Every text and attribute value the render produced.
 */
function renderAndCollect(element: ReactElement): string {
  const { container, unmount } = render(element);
  const rendered = everythingRendered(container);
  unmount();
  return rendered;
}

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

/** Tone and wording each connection state must render with. */
const EXPECTED_CONNECTION: Readonly<
  Record<ConnectionStatus, { tone: string; label: string; detail?: string }>
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
  it.each(CONNECTION_CASES.map((state) => [state]))(
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
    expect(Object.keys(EXPECTED_CONNECTION).sort()).toEqual([...CONNECTION_CASES].sort());
  });

  it('gives every connection state a non-empty label of its own, without throwing', () => {
    const labels = CONNECTION_CASES.map((state) => {
      expect(() => render(<StatusBar connection={state} />)).not.toThrow();
      const rendered = badgeLabels(statusRegion());
      cleanup();

      // Exactly one pill: the connection badge, and it carries words.
      expect(rendered).toHaveLength(1);
      const [label = ''] = rendered;
      expect(label).not.toBe('');
      return label;
    });

    // No two states collapse onto the same wording, so the state is legible
    // from the text alone and never from the tone colour alone (AAP 0.6.4).
    expect(new Set(labels).size).toBe(CONNECTION_CASES.length);
  });

  it('renders a reconnect as a polite inline pill plus retry, never as an alert', () => {
    render(<StatusBar connection="reconnecting" onRetryConnection={noop} />);

    const region = statusRegion();
    expect(region.getAttribute('role')).toBe('status');
    expect(within(region).getByText('Reconnecting…', { selector: '.dg-badge' })).toBeDefined();
    expect(within(region).getByRole('button', { name: 'Retry connection' })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('.dg-error-state')).toBeNull();
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

  // Every state that is not `open` must offer a retry that actually works: an
  // enabled control whose activation reaches the parent exactly once, with no
  // arguments. Existence alone would pass a control that is rendered disabled
  // or wired to nothing, so each state gets its own spy and its own click.
  it.each([['connecting'], ['reconnecting'], ['closed']] as const)(
    'offers an enabled retry control while the connection is %s, and activating it retries once',
    async (state) => {
      const user = userEvent.setup();
      const onRetry = vi.fn<() => void>();
      render(<StatusBar connection={state} onRetryConnection={onRetry} />);

      // The bar's only button is the retry control.
      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(1);
      const retry = screen.getByRole('button', { name: 'Retry connection' });
      expect(buttons[0]).toBe(retry);

      // Enabled by every route a control can be disabled: the native
      // attribute, the ARIA state and the design system's disabled modifier.
      expect(retry).toBeInstanceOf(HTMLButtonElement);
      expect((retry as HTMLButtonElement).disabled).toBe(false);
      expect(retry.getAttribute('aria-disabled')).not.toBe('true');
      expect(retry.classList.contains('dg-is-disabled')).toBe(false);

      // Rendering alone never retries.
      expect(onRetry).not.toHaveBeenCalled();

      await user.click(retry);

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith();
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
  it.each(SESSION_CASES.map((status) => [status]))(
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
    expect(Object.keys(EXPECTED_SESSION).sort()).toEqual([...SESSION_CASES].sort());
  });

  it('gives every session status a non-empty label of its own, without throwing', () => {
    const labels = SESSION_CASES.map((status) => {
      expect(() => render(<StatusBar connection="open" sessionStatus={status} />)).not.toThrow();
      const pill = document.querySelector(`[data-session-status="${status}"]`);
      const label = (pill?.textContent ?? '').trim();
      cleanup();

      expect(pill).not.toBeNull();
      expect(label).not.toBe('');
      return label;
    });

    expect(new Set(labels).size).toBe(SESSION_CASES.length);
  });

  it('renders a failed session as a failure, distinguishable from every other status', () => {
    const failed: SessionStatus = 'failed';
    expect(SESSION_CASES).toContain(failed);

    render(<StatusBar connection="open" sessionStatus={failed} />);
    const pill = screen.getByText('Failed', { selector: '.dg-badge' });
    expect(pill.getAttribute('data-session-status')).toBe(failed);
    expect(pill.classList.contains('dg-badge--danger')).toBe(true);
    cleanup();

    // No other status shares the failure's wording or its danger tone, so a
    // failed stage can never read as progress or as a result (AAP 0.5.5).
    for (const status of SESSION_CASES.filter((candidate) => candidate !== failed)) {
      render(<StatusBar connection="open" sessionStatus={status} />);
      const other = document.querySelector(`[data-session-status="${status}"]`);
      expect(other).not.toBeNull();
      expect(other?.textContent).not.toBe('Failed');
      expect(other?.classList.contains('dg-badge--danger')).toBe(false);
      cleanup();
    }
  });

  it('renders no session badge before a session exists', () => {
    render(<StatusBar connection="open" provider={SYNTHETIC_PROVIDER} />);
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

  it.each([[SYNTHETIC_PROVIDER], ['Provider With Spaces'], ['x']])(
    'renders the %s provider exactly as given',
    (name) => {
      render(<StatusBar connection="open" provider={name} />);
      expect(badge(name).textContent).toBe(name);
    },
  );

  it('invents no provider when none is configured, and ignores a blank one', () => {
    const { rerender } = render(<StatusBar connection="open" />);
    // No provider label, no provider badge, and no provider name of the
    // component's own choosing: the only pill is the connection's (AAP 0.5.3 —
    // the provider comes from configuration, never from a default in code).
    expect(screen.queryByText('Provider')).toBeNull();
    expect(document.querySelector('.dg-badge--outline')).toBeNull();
    expect(badgeLabels(document.body)).toEqual(['Connected']);

    rerender(<StatusBar connection="open" provider="   " />);
    expect(screen.queryByText('Provider')).toBeNull();
    expect(document.querySelector('.dg-badge--outline')).toBeNull();
    expect(badgeLabels(document.body)).toEqual(['Connected']);
  });

  it('shows a supplied provider in every connection state, and none when it is omitted', () => {
    for (const connection of CONNECTION_CASES) {
      const withProvider = renderAndCollect(
        <StatusBar connection={connection} provider={SYNTHETIC_PROVIDER} />,
      );
      expect(withProvider).toContain(SYNTHETIC_PROVIDER);

      render(<StatusBar connection={connection} />);
      expect(document.querySelector('.dg-badge--outline')).toBeNull();
      expect(screen.queryByText('Provider')).toBeNull();
      cleanup();
    }
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

  it.each(CONNECTION_CASES.map((state) => [state]))(
    'never renders a blank area for %s with every optional prop omitted',
    (state) => {
      render(<StatusBar connection={state} />);

      const region = statusRegion();
      // The connection pill is the one element that is always there.
      expect(badgeLabels(region)).toEqual([EXPECTED_CONNECTION[state].label]);
      // Nothing optional was supplied, so nothing optional is drawn: no URL,
      // no session, no provider, no retry — and no stand-in value for any of
      // them.
      expect(region.querySelector('code')).toBeNull();
      expect(region.querySelector('[data-session-status]')).toBeNull();
      expect(region.querySelector('.dg-badge--outline')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      expect(within(region).queryByText('Session')).toBeNull();
      expect(within(region).queryByText('Provider')).toBeNull();
      expect(document.body.textContent).not.toMatch(/undefined|null|n\/a|unknown|—/i);
    },
  );

  it('carries the root class and appends the caller class', () => {
    const { container } = render(<StatusBar connection="open" className="extra-placement" />);

    const root = container.firstElementChild;
    expect(root?.classList.contains('dgv-status-bar')).toBe(true);
    expect(root?.classList.contains('extra-placement')).toBe(true);
    expect(root?.classList.contains('dg-stack')).toBe(true);
  });
});

describe('StatusBar privacy', () => {
  it('strips user information, query and fragment from the displayed service URL', () => {
    const { container } = render(
      <StatusBar
        connection="open"
        serviceUrl={`http://${FAKE_USER_INFO}@127.0.0.1:43117/base?token=abc123#frag`}
        provider={SYNTHETIC_PROVIDER}
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
    // Every connection state crossed with "no session" and every session
    // status, with and without a retry — each combination the bar can draw.
    const sessionCases: readonly (SessionStatus | undefined)[] = [undefined, ...SESSION_CASES];

    for (const connection of CONNECTION_CASES) {
      for (const sessionStatus of sessionCases) {
        for (const onRetryConnection of [undefined, noop]) {
          const rendered = renderAndCollect(
            <StatusBar
              connection={connection}
              serviceUrl={SERVICE_URL}
              provider={SYNTHETIC_PROVIDER}
              sessionStatus={sessionStatus}
              onRetryConnection={onRetryConnection}
            />,
          );
          for (const shape of CREDENTIAL_SHAPES) {
            expect(rendered).not.toMatch(shape);
          }
        }
      }
    }

    // And with every optional prop omitted.
    for (const connection of CONNECTION_CASES) {
      const rendered = renderAndCollect(<StatusBar connection={connection} />);
      for (const shape of CREDENTIAL_SHAPES) {
        expect(rendered).not.toMatch(shape);
      }
    }
  });

  it('never logs, in any state, including when the retry control is used', async () => {
    const user = userEvent.setup();
    const logged = CONSOLE_METHODS.map((method) => vi.spyOn(console, method));

    for (const connection of CONNECTION_CASES) {
      for (const sessionStatus of [undefined, ...SESSION_CASES]) {
        render(
          <StatusBar
            connection={connection}
            serviceUrl={SERVICE_URL}
            provider={SYNTHETIC_PROVIDER}
            sessionStatus={sessionStatus}
          />,
        );
        cleanup();
      }
    }

    const { rerender } = render(
      <StatusBar
        connection="reconnecting"
        serviceUrl={SERVICE_URL}
        provider={SYNTHETIC_PROVIDER}
        sessionStatus="ready"
        onRetryConnection={noop}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Retry connection' }));
    rerender(<StatusBar connection="closed" serviceUrl={SERVICE_URL} />);

    for (const spy of logged) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('StatusBar exhaustiveness', () => {
  it('fails loudly on a connection state outside the union', () => {
    // React 19 reports an uncaught render error through `console.error` as well
    // as rethrowing it; silence the report so the assertion is the only output.
    // The `afterEach` hook restores the spy even if the assertion fails.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unknownState = 'suspended' as unknown as ConnectionStatus;
    expect(CONNECTION_CASES).not.toContain(unknownState);

    expect(() => render(<StatusBar connection={unknownState} />)).toThrow(
      /Unhandled service connection state/,
    );
  });

  it('fails loudly on a session status outside the union', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unknownStatus = 'paused' as unknown as SessionStatus;
    expect(SESSION_CASES).not.toContain(unknownStatus);

    expect(() => render(<StatusBar connection="open" sessionStatus={unknownStatus} />)).toThrow(
      /Unhandled session status/,
    );
  });
});

describe('StatusBar direction controls', () => {
  /**
   * A right-to-left override (U+202E) and its pop (U+202C) inside the two
   * configured strings the bar shows. Every code point is written as an escape
   * so this suite is not itself a carrier of what it defends against.
   */
  const PROVIDER = 'synthetic\u202Eredivorp\u202C';

  /** Not a parseable URL, so the bar shows it as scrubbed text, not rebuilt. */
  const SERVICE_TEXT = 'local\u202Ehost\u202C:43117/ws';

  /** Any of the twelve Unicode bidirectional formatting controls, raw. */
  const RAW_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

  it('shows each control of the provider and the service URL as a visible escape', () => {
    const { container } = render(
      <StatusBar connection="open" provider={PROVIDER} serviceUrl={SERVICE_TEXT} />,
    );

    expect(badge('synthetic\\u202Eredivorp\\u202C').textContent).toBe(
      'synthetic\\u202Eredivorp\\u202C',
    );
    const code = container.querySelector('code');
    expect(code?.textContent).toBe('local\\u202Ehost\\u202C:43117/ws');
    expect(code?.getAttribute('title')).toBe('local\\u202Ehost\\u202C:43117/ws');

    expect(container.textContent).not.toMatch(RAW_CONTROL);
    for (const element of Array.from(container.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.value).not.toMatch(RAW_CONTROL);
      }
    }
  });
});
