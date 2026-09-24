/**
 * `components/PairingCode` — the one-time Chrome pairing code of the VS Code view (AAP 0.5.6).
 *
 * What this suite protects:
 *
 *   - the request state: with no code on display, a generic `EmptyState` whose
 *     action raises `onPair` with no arguments;
 *   - the code state: the code rendered byte-for-byte as one selectable `<code>`
 *     inside a polite live region, the absolute expiry as a `<time>`, and the
 *     request-again and hide controls with their argument-free callbacks;
 *   - expiry: a stale code is never shown as usable — on arrival or when the
 *     clock passes `expiresAt` while it is on screen — and the single timer
 *     behind that is released with the code and the component;
 *   - the three states of AAP 0.5.5 and their precedence (error > pending >
 *     empty > data), each through its design-system primitive;
 *   - privacy (AAP 0.5.2): nothing is logged in any state, the code appears in
 *     no attribute and never in the error copy.
 *
 * Harness conventions follow the rest of the repository: the Vitest API is
 * imported explicitly, `cleanup` is registered explicitly, elements are found
 * by role and accessible name, and — with no `jest-dom` here — state is read
 * from DOM properties. The code values are obviously synthetic (AAP 0.5.4).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { PairingCode } from './PairingCode';

/** A synthetic code: never a real one, and plainly a placeholder. */
const SAMPLE_CODE = 'TEST0001';

const MINUTE_MS = 60_000;
const CODE_LIFETIME_MS = 5 * MINUTE_MS;

const REQUEST_NAME = 'Get pairing code';
const RENEW_NAME = 'Get a new code';
const DISMISS_NAME = 'Hide code';
const RETRY_NAME = 'Try again';

/** The same local wall-clock rendering the component uses for the expiry. */
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A button by accessible name, narrowed to its element type. */
function getButton(name: string): HTMLButtonElement {
  const button = screen.getByRole('button', { name });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`expected "${name}" to be a <button>`);
  }
  return button;
}

/** The polite live region that holds the code or the expired notice. */
function getCodeRegion(): HTMLElement {
  return screen.getByRole('status');
}

/** Every `<code>` element in the rendered tree. */
function codeElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('code'));
}

describe('PairingCode — request state (no code)', () => {
  it('explains why pairing is needed and requests a code with no arguments', async () => {
    const onPair = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const user = userEvent.setup();
    const { container } = render(<PairingCode onPair={onPair} onDismiss={onDismiss} />);

    const empty = container.querySelector('.dg-empty-state');
    expect(empty).not.toBeNull();
    expect(empty?.getAttribute('role')).toBe('status');
    expect(screen.getByText(/needs a one-time pairing code before it can connect/)).toBeTruthy();
    expect(codeElements(container)).toHaveLength(0);

    const request = getButton(REQUEST_NAME);
    expect(request.type).toBe('button');
    await user.click(request);

    expect(onPair).toHaveBeenCalledTimes(1);
    expect(onPair).toHaveBeenCalledWith();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('treats a blank code as no code', () => {
    const { container } = render(
      <PairingCode
        code="   "
        expiresAt={Date.now() + CODE_LIFETIME_MS}
        onPair={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(container.querySelector('.dg-empty-state')).not.toBeNull();
    expect(codeElements(container)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: DISMISS_NAME })).toBeNull();
  });

  it('prints no route path in its copy', () => {
    const { container } = render(<PairingCode onPair={vi.fn()} onDismiss={vi.fn()} />);

    expect(container.textContent).not.toMatch(/\/(?:api|pair)\b/);
  });
});

describe('PairingCode — code state', () => {
  it('renders the code as one selectable <code> inside a polite live region', () => {
    const { container } = render(
      <PairingCode
        code={SAMPLE_CODE}
        expiresAt={Date.now() + CODE_LIFETIME_MS}
        onPair={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const region = getCodeRegion();
    expect(region.classList.contains('dgv-pairing__code')).toBe(true);
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByRole('alert')).toBeNull();

    const codes = within(region).getAllByText(SAMPLE_CODE);
    expect(codes).toHaveLength(1);
    const code = codes[0];
    expect(code?.tagName).toBe('CODE');
    expect(code?.textContent).toBe(SAMPLE_CODE);
    expect(code?.classList.contains('dg-code--md')).toBe(true);
    expect(code?.getAttribute('translate')).toBe('no');
    // One text node: never split into per-character boxes that break selection.
    expect(code?.childNodes).toHaveLength(1);
    expect(code?.getAttribute('style')).toBeNull();

    expect(region.textContent).toContain('Pairing code');
    expect(container.textContent).toContain('Enter this code in the Debug Generator panel');
    expect(codeElements(container)).toHaveLength(1);
  });

  it('renders the code byte-for-byte, without trimming it', () => {
    const padded = ` ${SAMPLE_CODE} `;
    const { container } = render(
      <PairingCode
        code={padded}
        expiresAt={Date.now() + CODE_LIFETIME_MS}
        onPair={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(codeElements(container)[0]?.textContent).toBe(padded);
  });

  it('shows the absolute expiry time as a machine-readable <time>', () => {
    const expiresAt = Date.now() + CODE_LIFETIME_MS;
    const { container } = render(
      <PairingCode code={SAMPLE_CODE} expiresAt={expiresAt} onPair={vi.fn()} onDismiss={vi.fn()} />,
    );

    const expiry = container.querySelector('.dgv-pairing__expiry');
    expect(expiry).not.toBeNull();
    expect(expiry?.classList.contains('dg-text--secondary')).toBe(true);
    expect(expiry?.textContent?.startsWith('Expires at ')).toBe(true);

    const time = expiry?.querySelector('time');
    expect(time?.getAttribute('dateTime') ?? time?.getAttribute('datetime')).toBe(
      new Date(expiresAt).toISOString(),
    );
    expect(time?.textContent).toBe(TIME_FORMAT.format(new Date(expiresAt)));
  });

  it('reports an unknown expiry instead of guessing one', () => {
    const { container, rerender } = render(
      <PairingCode code={SAMPLE_CODE} onPair={vi.fn()} onDismiss={vi.fn()} />,
    );

    expect(container.querySelector('.dgv-pairing__expiry')?.textContent).toBe(
      'Expiry time not reported.',
    );
    expect(codeElements(container)[0]?.textContent).toBe(SAMPLE_CODE);

    for (const unusable of [Number.NaN, Number.POSITIVE_INFINITY, 9e15]) {
      rerender(
        <PairingCode
          code={SAMPLE_CODE}
          expiresAt={unusable}
          onPair={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      expect(container.querySelector('.dgv-pairing__expiry')?.textContent).toBe(
        'Expiry time not reported.',
      );
      expect(container.querySelector('time')).toBeNull();
    }
  });

  it('requests a new code and hides the code with argument-free callbacks', async () => {
    const onPair = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const user = userEvent.setup();
    render(
      <PairingCode
        code={SAMPLE_CODE}
        expiresAt={Date.now() + CODE_LIFETIME_MS}
        onPair={onPair}
        onDismiss={onDismiss}
      />,
    );

    const dismiss = getButton(DISMISS_NAME);
    expect(dismiss.type).toBe('button');
    expect(dismiss.classList.contains('dg-button--ghost')).toBe(true);
    await user.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith();
    expect(onPair).not.toHaveBeenCalled();

    const renew = getButton(RENEW_NAME);
    expect(renew.type).toBe('button');
    await user.click(renew);
    expect(onPair).toHaveBeenCalledTimes(1);
    expect(onPair).toHaveBeenCalledWith();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('composes the root block class with the caller class, and nothing stray when blank', () => {
    const { container, rerender } = render(
      <PairingCode code={SAMPLE_CODE} onPair={vi.fn()} onDismiss={vi.fn()} className="placement" />,
    );

    const root = container.firstElementChild;
    expect(root?.classList.contains('dgv-pairing')).toBe(true);
    expect(root?.classList.contains('dg-stack')).toBe(true);
    expect(root?.classList.contains('placement')).toBe(true);

    rerender(
      <PairingCode code={SAMPLE_CODE} onPair={vi.fn()} onDismiss={vi.fn()} className="  " />,
    );
    expect(container.firstElementChild?.classList.contains('dgv-pairing')).toBe(true);
    expect(container.firstElementChild?.getAttribute('class')?.includes('  ')).toBe(false);
  });

  it('uses no raw heading, input or inline style', () => {
    const { container } = render(
      <PairingCode
        code={SAMPLE_CODE}
        expiresAt={Date.now() + CODE_LIFETIME_MS}
        onPair={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      container.querySelector('h1, h2, h3, h4, h5, h6, input, textarea, select, form'),
    ).toBeNull();
    expect(container.querySelector('[style]')).toBeNull();
  });
});

describe('PairingCode — expiry', () => {
  it('never shows a code that is already stale on arrival', async () => {
    const onPair = vi.fn<() => void>();
    const user = userEvent.setup();
    const expiresAt = Date.now() - MINUTE_MS;
    const { container } = render(
      <PairingCode code={SAMPLE_CODE} expiresAt={expiresAt} onPair={onPair} onDismiss={vi.fn()} />,
    );

    expect(container.textContent).not.toContain(SAMPLE_CODE);
    expect(codeElements(container)).toHaveLength(0);

    const region = getCodeRegion();
    const badge = region.querySelector('.dg-badge');
    expect(badge?.textContent).toBe('Expired');
    expect(badge?.classList.contains('dg-badge--warning')).toBe(true);
    expect(region.textContent).toContain('has expired and can no longer be used');
    expect(
      container.querySelector('.dgv-pairing__expiry')?.textContent?.startsWith('Expired at '),
    ).toBe(true);

    await user.click(getButton(RENEW_NAME));
    expect(onPair).toHaveBeenCalledTimes(1);
    expect(onPair).toHaveBeenCalledWith();
    expect(screen.getByRole('button', { name: DISMISS_NAME })).toBeTruthy();
  });

  it('treats a code expiring exactly now as expired', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T12:00:00Z') });
    const { container } = render(
      <PairingCode
        code={SAMPLE_CODE}
        expiresAt={Date.now()}
        onPair={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(codeElements(container)).toHaveLength(0);
    expect(getCodeRegion().textContent).toContain('Expired');
  });

  it('switches to the expired notice in place when the code expires on screen', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T12:00:00Z') });
    const onPair = vi.fn<() => void>();
    const expiresAt = Date.now() + CODE_LIFETIME_MS;
    const { container } = render(
      <PairingCode code={SAMPLE_CODE} expiresAt={expiresAt} onPair={onPair} onDismiss={vi.fn()} />,
    );

    const liveRegion = getCodeRegion();
    expect(within(liveRegion).getByText(SAMPLE_CODE).tagName).toBe('CODE');
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(CODE_LIFETIME_MS - 1);
    });
    expect(within(getCodeRegion()).getByText(SAMPLE_CODE)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.textContent).not.toContain(SAMPLE_CODE);
    // The same live-region element carries the change, so it is announced in place.
    expect(getCodeRegion()).toBe(liveRegion);
    expect(liveRegion.textContent).toContain('Expired');
    expect(vi.getTimerCount()).toBe(0);

    // `fireEvent` rather than `userEvent`: Testing Library's async wrapper
    // drains with a real `setTimeout`, which never fires under fake timers.
    fireEvent.click(getButton(RENEW_NAME));
    expect(onPair).toHaveBeenCalledTimes(1);
    expect(onPair).toHaveBeenCalledWith();
  });

  it('shows a fresh code again when a new one replaces the expired one', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T12:00:00Z') });
    const { container, rerender } = render(
      <PairingCode
        code={SAMPLE_CODE}
        expiresAt={Date.now() - 1}
        onPair={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(codeElements(container)).toHaveLength(0);

    rerender(
      <PairingCode
        code="TEST0002"
        expiresAt={Date.now() + CODE_LIFETIME_MS}
        onPair={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(codeElements(container)[0]?.textContent).toBe('TEST0002');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('waits out an expiry beyond the setTimeout range in bounded hops', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T12:00:00Z') });
    const thirtyDaysMs = 30 * 24 * 60 * MINUTE_MS;
    const { container } = render(
      <PairingCode
        code={SAMPLE_CODE}
        expiresAt={Date.now() + thirtyDaysMs}
        onPair={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(25 * 24 * 60 * MINUTE_MS);
    });
    expect(codeElements(container)[0]?.textContent).toBe(SAMPLE_CODE);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(5 * 24 * 60 * MINUTE_MS);
    });
    expect(codeElements(container)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases its timer when the code goes away and when the component unmounts', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T12:00:00Z') });
    const expiresAt = Date.now() + CODE_LIFETIME_MS;
    const { rerender, unmount } = render(
      <PairingCode code={SAMPLE_CODE} expiresAt={expiresAt} onPair={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(vi.getTimerCount()).toBe(1);

    // A stale `expiresAt` beside an absent code arms nothing.
    rerender(<PairingCode expiresAt={expiresAt} onPair={vi.fn()} onDismiss={vi.fn()} />);
    expect(vi.getTimerCount()).toBe(0);

    rerender(
      <PairingCode code={SAMPLE_CODE} expiresAt={expiresAt} onPair={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('arms no timer for an unknown expiry', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T12:00:00Z') });
    render(<PairingCode code={SAMPLE_CODE} onPair={vi.fn()} onDismiss={vi.fn()} />);

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('PairingCode — loading and error states', () => {
  it('renders LoadingState while a code is requested, over any code on display', () => {
    const { container } = render(
      <PairingCode
        code={SAMPLE_CODE}
        expiresAt={Date.now() + CODE_LIFETIME_MS}
        pending
        onPair={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.textContent).toContain('Requesting a pairing code');
    expect(container.textContent).not.toContain(SAMPLE_CODE);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(container.firstElementChild?.classList.contains('dgv-pairing')).toBe(true);
  });

  it('renders ErrorState with the message and a retry that requests a code', () => {
    const onPair = vi.fn<() => void>();
    const message = 'The local service is not reachable.';
    const { container } = render(
      <PairingCode
        code={SAMPLE_CODE}
        expiresAt={Date.now() + CODE_LIFETIME_MS}
        pending
        error={message}
        onPair={onPair}
        onDismiss={vi.fn()}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain('Could not get a pairing code');
    // Error beats pending, and the code is never echoed into the failure.
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.textContent).not.toContain(SAMPLE_CODE);

    fireEvent.click(getButton(RETRY_NAME));
    expect(onPair).toHaveBeenCalledTimes(1);
    expect(onPair).toHaveBeenCalledWith();
  });

  it('ignores a blank error', () => {
    const { container } = render(
      <PairingCode
        code={SAMPLE_CODE}
        expiresAt={Date.now() + CODE_LIFETIME_MS}
        error="  "
        onPair={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.queryByRole('alert')).toBeNull();
    expect(codeElements(container)[0]?.textContent).toBe(SAMPLE_CODE);
  });
});

describe('PairingCode — privacy', () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  let spies: MockInstance[] = [];

  beforeEach(() => {
    spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
  });

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  it('logs nothing in any state or interaction', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T12:00:00Z') });
    const onPair = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const expiresAt = Date.now() + CODE_LIFETIME_MS;
    const { rerender, unmount } = render(<PairingCode onPair={onPair} onDismiss={onDismiss} />);
    fireEvent.click(getButton(REQUEST_NAME));

    rerender(<PairingCode pending onPair={onPair} onDismiss={onDismiss} />);
    rerender(
      <PairingCode
        code={SAMPLE_CODE}
        expiresAt={expiresAt}
        onPair={onPair}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(getButton(DISMISS_NAME));
    fireEvent.click(getButton(RENEW_NAME));

    act(() => {
      vi.advanceTimersByTime(CODE_LIFETIME_MS);
    });
    fireEvent.click(getButton(RENEW_NAME));

    rerender(
      <PairingCode
        code={SAMPLE_CODE}
        error="Pairing failed."
        onPair={onPair}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(getButton(RETRY_NAME));
    unmount();

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('carries the code in no attribute', () => {
    const { container } = render(
      <PairingCode
        code={SAMPLE_CODE}
        expiresAt={Date.now() + CODE_LIFETIME_MS}
        onPair={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    for (const element of Array.from(container.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.value).not.toContain(SAMPLE_CODE);
      }
    }
  });
});
