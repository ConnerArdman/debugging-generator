/**
 * Unit spec for the panel's element targeting: the shared `$0` descriptor
 * parser in `../src/shared/messages.ts`, its use by the devtools page, the
 * `TargetPicker` controls and the "Use selected element" command of
 * `../src/panel/App.tsx`.
 *
 * Four product guarantees run through that path, and this spec holds them:
 *
 * - **The page's answer is bounded before anything else sees it.** The
 *   inspected page controls `window.__DEBUGGEN__.describeTarget`, so both `$0`
 *   readers parse its answer with one bounded, HTTP-URL-aware parser, and the
 *   panel shows nothing — not even an optimistic target — for an answer that
 *   parser refuses.
 * - **What the header paints is redacted.** Credential shapes are removed from
 *   every page-controlled field of the displayed target (text, selector,
 *   component names, URL path and query keys), query values are masked, and the
 *   worker still receives the bounded descriptor itself.
 * - **"Use selected element" can never stay busy.** The evaluation settles
 *   once: on its deadline, when the inspected tab loads a new document (a
 *   same-URL reload included), when its binding changes, or with an answer — and
 *   a late answer from an abandoned evaluation is ignored.
 * - **The two controls behave as one.** They are unavailable, with a reason,
 *   outside DevTools and while no session is bound; they share one in-flight
 *   state; and a failing callback reaches the composition root's error sink
 *   without an unhandled rejection.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). The panel connection module is
 * replaced by `vi.mock` with its real exports plus inert lifecycle functions and
 * a recording `panelRequest`, so no port is opened; the session store is the
 * real one, reset before every case. `chrome.devtools` is a fake installed per
 * case whose `inspectedWindow.eval` and `network.onNavigated` the case drives.
 * Credential-shaped inputs are assembled from pieces, as the repository's secret
 * gate requires of every tracked file.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseInspectedLocation, parseSelectionResult } from '../src/devtools/devtools';
import { App } from '../src/panel/App';
import { TargetPicker } from '../src/panel/components/TargetPicker';
import type { TargetPickerProps } from '../src/panel/components/TargetPicker';
import {
  getPanelSnapshot,
  resetPanelStore,
  setBindingState,
} from '../src/panel/state/session-store';
import {
  SELECTION_MAX_COMPONENT_CHAIN,
  SELECTION_MAX_SELECTOR_LENGTH,
  SELECTION_MAX_URL_LENGTH,
  parseSelectedTargetDescriptor,
} from '../src/shared/messages';

const panelRequest = vi.fn<(kind: string, payload: unknown) => Promise<unknown>>();

vi.mock('../src/panel/state/connection', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/panel/state/connection')>();
  return {
    ...original,
    startPanelConnection: () => ({ stop: (): undefined => undefined }),
    getPanelConnection: () => ({ resync: (): undefined => undefined }),
    onPortDisconnect: () => (): undefined => undefined,
    panelRequest: (kind: string, payload: unknown) => panelRequest(kind, payload),
  };
});

/** A well-formed descriptor, as the agent produces it. */
const VALID = Object.freeze({
  selector: 'main > button.primary',
  tagName: 'button',
  text: 'Place the order',
  componentChain: ['Button', 'Form'],
  url: 'http://127.0.0.1:3000/checkout?step=2',
});

/** A provider-prefixed key body with no digit — the shape a digit heuristic alone misses. */
const LETTERS = 'abcdefghijklmnopqrstuv';
const PROVIDER_SHAPED = 's' + 'k-' + LETTERS;
const FORGE_SHAPED = 'gh' + 'p_' + LETTERS;
const BEARER_SHAPED = 'Bea' + 'rer ' + LETTERS;
/** URL userinfo carrying a password — the connection-string shape. */
const USERINFO_SHAPED = 'user' + ':' + 'pass';

describe('parseSelectedTargetDescriptor', () => {
  it('keeps a well-formed descriptor byte for byte and drops unknown keys', () => {
    expect(parseSelectedTargetDescriptor({ ...VALID, extra: 'ignored' })).toEqual(VALID);
  });

  it('refuses a descriptor whose required fields are out of bounds or not single lines', () => {
    const over = 'a'.repeat(SELECTION_MAX_SELECTOR_LENGTH + 1);
    expect(parseSelectedTargetDescriptor({ ...VALID, selector: over })).toBeUndefined();
    expect(parseSelectedTargetDescriptor({ ...VALID, tagName: 'bu\ntton' })).toBeUndefined();
    expect(parseSelectedTargetDescriptor({ ...VALID, selector: '  ' })).toBeUndefined();
    expect(parseSelectedTargetDescriptor({ ...VALID, componentChain: 'Button' })).toBeUndefined();
    expect(parseSelectedTargetDescriptor(null)).toBeUndefined();
    expect(parseSelectedTargetDescriptor([VALID])).toBeUndefined();
  });

  it('accepts only an absolute http(s) URL with a host, unaltered', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/hosts',
      'data:text/html,hi',
      ' http://127.0.0.1:3000/',
      'http://127.0.0.1:3000/\tx',
      `http://127.0.0.1/${'p'.repeat(SELECTION_MAX_URL_LENGTH)}`,
      '/relative/path',
    ]) {
      expect(parseSelectedTargetDescriptor({ ...VALID, url }), url).toBeUndefined();
    }
    expect(parseSelectedTargetDescriptor({ ...VALID, url: 'https://example.test/a' })?.url).toBe(
      'https://example.test/a',
    );
  });

  it('bounds the component chain nearest-first and reads a bounded window of it', () => {
    const huge = Array.from({ length: 100_000 }, (_, index) => `Component${String(index)}`);
    const parsed = parseSelectedTargetDescriptor({ ...VALID, componentChain: huge });
    expect(parsed?.componentChain).toHaveLength(SELECTION_MAX_COMPONENT_CHAIN);
    expect(parsed?.componentChain[0]).toBe('Component0');

    const mixed = parseSelectedTargetDescriptor({
      ...VALID,
      componentChain: ['Near', '', 7, 'Bell\u0007', 'Far'],
    });
    expect(mixed?.componentChain).toEqual(['Near', 'Far']);

    const allInvalid = parseSelectedTargetDescriptor({
      ...VALID,
      componentChain: Array.from({ length: 1_000 }, () => ''),
    });
    expect(allInvalid?.componentChain).toEqual([]);
  });

  it('drops text that is not a bounded single line instead of truncating it', () => {
    const long = parseSelectedTargetDescriptor({ ...VALID, text: 'x'.repeat(300) });
    expect(long).toBeDefined();
    expect(long !== undefined && 'text' in long).toBe(false);
    const multiLine = parseSelectedTargetDescriptor({ ...VALID, text: 'one\ntwo' });
    expect(multiLine !== undefined && 'text' in multiLine).toBe(false);
  });

  it('never throws, even for an answer whose getters throw', () => {
    const hostile = Object.defineProperty({ ...VALID }, 'selector', {
      enumerable: true,
      get(): never {
        throw new Error('hostile getter');
      },
    });
    expect(parseSelectedTargetDescriptor(hostile)).toBeUndefined();
  });

  it('is exactly what the devtools page applies to its own `$0` answer', () => {
    expect(parseSelectionResult({ ok: true, target: VALID })).toEqual({ ok: true, target: VALID });
    expect(parseSelectionResult({ ok: true, target: { ...VALID, url: 'file:///x' } })).toEqual({
      ok: false,
      reason: 'invalid-descriptor',
    });
    expect(parseInspectedLocation({ url: 'http://a.test/', origin: 'http://a.test' })).toEqual({
      url: 'http://a.test/',
      origin: 'http://a.test',
    });
    expect(parseInspectedLocation({ url: 'http://a.test/\n', origin: 42 })).toEqual({});
  });
});

describe('TargetPicker', () => {
  afterEach(cleanup);

  const props = (overrides: Partial<TargetPickerProps> = {}): TargetPickerProps => ({
    target: undefined,
    pickerActive: false,
    onPick: vi.fn(),
    onUseSelected: vi.fn(),
    devtoolsAvailable: true,
    sessionBound: true,
    onActionError: vi.fn(),
    ...overrides,
  });

  const buttons = (): { pick: HTMLElement; use: HTMLElement } => ({
    pick: screen.getByRole('button', { name: 'Pick element' }),
    use: screen.getByRole('button', { name: 'Use selected element' }),
  });

  it('is unavailable, focusable and explained outside DevTools', () => {
    const onPick = vi.fn();
    render(createElement(TargetPicker, props({ onPick, devtoolsAvailable: false })));
    const { pick, use } = buttons();
    expect(pick.getAttribute('aria-disabled')).toBe('true');
    expect(use.getAttribute('aria-disabled')).toBe('true');
    expect(pick.hasAttribute('disabled')).toBe(false);
    expect(document.body.textContent).toContain(
      'Element selection needs the Debug Generator panel in Chrome DevTools.',
    );
    fireEvent.click(pick);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('is unavailable and explained while no session is bound to the tab', () => {
    const onUseSelected = vi.fn();
    render(createElement(TargetPicker, props({ onUseSelected, sessionBound: false })));
    const { pick, use } = buttons();
    expect(pick.getAttribute('aria-disabled')).toBe('true');
    expect(use.getAttribute('aria-disabled')).toBe('true');
    expect(document.body.textContent).toContain(
      'Element selection needs a Debug Generator session bound to this tab.',
    );
    fireEvent.click(use);
    expect(onUseSelected).not.toHaveBeenCalled();
  });

  it('describes picker mode as a click in the inspected page, cancelled with Escape there', () => {
    const { rerender } = render(createElement(TargetPicker, props()));
    const text = (): string => document.body.textContent;
    expect(text()).toContain(
      "Turns picker mode on or off. While it is on, the next element you click in the inspected page becomes the session's target; press Esc in the page to cancel.",
    );
    // "Pick element" never points at the Elements panel; "Use selected element" does.
    expect(text()).not.toContain('select next in the Elements panel');
    expect(text()).toContain(
      "Uses the element currently selected in the Elements panel as the session's target.",
    );
    expect(screen.queryByText('Picker on')).toBeNull();

    rerender(createElement(TargetPicker, props({ pickerActive: true })));
    expect(buttons().pick.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Picker on')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(
      'Picker mode on. Click an element in the inspected page, or press Escape there to cancel.',
    );

    rerender(createElement(TargetPicker, props({ pickerActive: false })));
    expect(buttons().pick.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('Picker on')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('shares one in-flight state across both controls', async () => {
    let release: () => void = () => undefined;
    const onPick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const onUseSelected = vi.fn();
    render(createElement(TargetPicker, props({ onPick, onUseSelected })));
    const { pick, use } = buttons();

    fireEvent.click(pick);
    fireEvent.click(pick);
    fireEvent.click(use);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onUseSelected).not.toHaveBeenCalled();
    for (const control of [pick, use]) {
      expect(control.getAttribute('aria-busy')).toBe('true');
      expect(control.getAttribute('aria-disabled')).toBe('true');
    }
    expect(screen.getByRole('status').textContent).toBe('Updating the session target.');

    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(use.getAttribute('aria-disabled')).toBeNull();
    expect(use.getAttribute('aria-busy')).toBeNull();
    fireEvent.click(use);
    expect(onUseSelected).toHaveBeenCalledTimes(1);
  });

  it('hands a rejection or a throw to onActionError and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const onActionError = vi.fn();
      const failure = new Error('request failed');
      render(
        createElement(
          TargetPicker,
          props({
            onActionError,
            onUseSelected: () => Promise.reject(failure),
            onPick: () => {
              throw failure;
            },
          }),
        ),
      );
      const { pick, use } = buttons();
      await act(async () => {
        fireEvent.click(use);
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(onActionError).toHaveBeenCalledWith('useSelected', failure);
      expect(use.getAttribute('aria-busy')).toBeNull();
      fireEvent.click(pick);
      expect(onActionError).toHaveBeenCalledWith('pick', failure);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

/** The fake `chrome.devtools` a case drives. */
interface DevtoolsFake {
  readonly evaluate: ReturnType<typeof vi.fn>;
  readonly navigated: Set<(url: string) => void>;
}

describe('App — "Use selected element"', () => {
  let fake: DevtoolsFake;

  beforeEach(() => {
    resetPanelStore({ includeConnection: true });
    panelRequest.mockReset();
    panelRequest.mockImplementation((kind) =>
      Promise.resolve(kind === 'target.selected' ? { accepted: true } : { active: true }),
    );
    const navigated = new Set<(url: string) => void>();
    fake = { evaluate: vi.fn(), navigated };
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      writable: true,
      value: {
        devtools: {
          inspectedWindow: { tabId: 7, eval: fake.evaluate },
          network: {
            onNavigated: {
              addListener: (listener: (url: string) => void) => navigated.add(listener),
              removeListener: (listener: (url: string) => void) => navigated.delete(listener),
            },
          },
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, 'chrome');
  });

  const bind = (url = 'http://127.0.0.1:3000/checkout'): void => {
    setBindingState({ kind: 'bound', sessionId: 'session-1', tabId: 7, url });
  };

  const useSelected = (): HTMLElement =>
    screen.getByRole('button', { name: 'Use selected element' });

  /** The callback of the case's first `inspectedWindow.eval`. */
  const heldCallback = (): ((result: unknown, exceptionInfo?: unknown) => void) => {
    const callback: unknown = fake.evaluate.mock.calls[0]?.[1];
    if (typeof callback !== 'function') {
      throw new Error('inspectedWindow.eval was not called with a callback');
    }
    return (result, exceptionInfo) => {
      Reflect.apply(callback, undefined, [result, exceptionInfo]);
    };
  };

  const flush = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const targetRequests = (): unknown[] =>
    panelRequest.mock.calls.filter(([kind]) => kind === 'target.selected');

  it('keeps both controls unavailable until a session is bound to the tab', () => {
    render(createElement(App, { theme: 'dark' }));
    expect(useSelected().getAttribute('aria-disabled')).toBe('true');
    act(() => {
      bind();
    });
    expect(useSelected().getAttribute('aria-disabled')).toBeNull();
  });

  it('gives up after its deadline with a visible failure and operable controls', async () => {
    vi.useFakeTimers();
    bind();
    render(createElement(App, { theme: 'dark' }));
    fireEvent.click(useSelected());
    expect(fake.evaluate).toHaveBeenCalledTimes(1);
    expect(useSelected().getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(useSelected().getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    const failure = getPanelSnapshot().lastError;
    expect(failure?.code).toBe('AGENT_NOT_READY');
    expect(failure?.message).toContain('did not describe its selected element');
    expect(useSelected().getAttribute('aria-busy')).toBeNull();
    expect(targetRequests()).toEqual([]);
  });

  it('abandons the evaluation on a same-URL reload and ignores the late answer', async () => {
    bind();
    render(createElement(App, { theme: 'dark' }));
    fireEvent.click(useSelected());
    expect(fake.navigated.size).toBe(1);

    await act(async () => {
      for (const listener of fake.navigated) {
        listener('http://127.0.0.1:3000/checkout');
      }
      await Promise.resolve();
    });
    await flush();
    expect(getPanelSnapshot().lastError?.message).toContain('the inspected page changed');
    expect(fake.navigated.size).toBe(0);
    expect(useSelected().getAttribute('aria-busy')).toBeNull();

    heldCallback()(VALID, undefined);
    await flush();
    expect(getPanelSnapshot().target.pending).toBeUndefined();
    expect(targetRequests()).toEqual([]);
  });

  it('abandons the evaluation when the binding changes and ignores the late answer', async () => {
    bind();
    render(createElement(App, { theme: 'dark' }));
    fireEvent.click(useSelected());
    await act(async () => {
      bind('http://127.0.0.1:3000/elsewhere');
      await Promise.resolve();
    });
    await flush();
    expect(getPanelSnapshot().lastError?.message).toContain('the inspected page changed');

    heldCallback()(VALID, undefined);
    await flush();
    expect(getPanelSnapshot().target.pending).toBeUndefined();
    expect(targetRequests()).toEqual([]);
  });

  it('shows nothing for an answer the parser refuses', async () => {
    bind();
    fake.evaluate.mockImplementation((_expression: string, callback: (r: unknown) => void) => {
      callback({ ...VALID, componentChain: 'not an array' });
    });
    render(createElement(App, { theme: 'dark' }));
    fireEvent.click(useSelected());
    await flush();
    expect(getPanelSnapshot().target.pending).toBeUndefined();
    expect(getPanelSnapshot().lastError?.message).toContain('could not be described');
    expect(screen.getByText('No element selected')).toBeTruthy();
    expect(targetRequests()).toEqual([]);
  });

  it('treats an eval exception record as a failure', async () => {
    bind();
    fake.evaluate.mockImplementation(
      (_expression: string, callback: (r: unknown, x?: unknown) => void) => {
        callback(undefined, { isException: true, value: 'thrown' });
      },
    );
    render(createElement(App, { theme: 'dark' }));
    fireEvent.click(useSelected());
    await flush();
    expect(getPanelSnapshot().lastError?.code).toBe('AGENT_NOT_READY');
    expect(targetRequests()).toEqual([]);
  });

  it('paints a redacted copy of every page-controlled field and sends the bounded descriptor', async () => {
    bind();
    const answered = {
      selector: `main > button[data-k="${FORGE_SHAPED}"]`,
      tagName: 'button',
      text: `Key ${PROVIDER_SHAPED} and ${BEARER_SHAPED} here`,
      componentChain: [PROVIDER_SHAPED, 'Form'],
      url: `http://${USERINFO_SHAPED}@127.0.0.1:3000/reset/${PROVIDER_SHAPED}?${FORGE_SHAPED}=1&step=2&flag#frag`,
    };
    fake.evaluate.mockImplementation(
      (_expression: string, callback: (r: unknown, x?: unknown) => void) => {
        callback(answered, undefined);
      },
    );
    render(createElement(App, { theme: 'dark' }));
    fireEvent.click(useSelected());
    await flush();

    expect(targetRequests()).toEqual([
      ['target.selected', { sessionId: 'session-1', target: answered }],
    ]);
    expect(getPanelSnapshot().target.pending).toEqual(answered);

    const painted = document.body.textContent ?? '';
    expect(painted).not.toContain(LETTERS);
    expect(painted).not.toContain(USERINFO_SHAPED);
    expect(painted).toContain('Key [redacted] and Bearer [redacted] here');
    expect(painted).toContain('main > button[data-k="[redacted]"]');
    expect(painted).toContain(
      'http://[redacted]@127.0.0.1:3000/reset/[redacted]?[redacted]=?&step=?&flag#?',
    );
    expect(painted).toContain('Form');
  });

  it('leaves ordinary fields of the displayed target unchanged', async () => {
    bind();
    const answered = {
      selector: 'div.desk-management-panel > button.task-list-item-container',
      tagName: 'button',
      text: 'Internationalization settings',
      componentChain: ['SettingsButton', 'DeskManagementPanel'],
      url: 'http://127.0.0.1:3000/settings',
    };
    fake.evaluate.mockImplementation(
      (_expression: string, callback: (r: unknown, x?: unknown) => void) => {
        callback(answered, undefined);
      },
    );
    render(createElement(App, { theme: 'dark' }));
    fireEvent.click(useSelected());
    await flush();

    const painted = document.body.textContent ?? '';
    expect(painted).toContain(answered.selector);
    expect(painted).toContain(answered.text);
    expect(painted).toContain('DeskManagementPanel');
    expect(painted).toContain(answered.url);
  });
});
