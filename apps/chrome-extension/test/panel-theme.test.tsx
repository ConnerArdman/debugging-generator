/**
 * Unit spec for `../src/panel/theme.ts` and the theme wiring of
 * `../src/panel/main.tsx` — how the DevTools panel chooses its token theme and
 * keeps following it after mount (AAP 0.6.3).
 *
 * What this suite protects:
 *
 * - **The mapping.** `chrome.devtools.panels.themeName` `"default"` and
 *   `"dark"` select `dark`, `"light"` selects `light`, and anything else —
 *   unknown, empty, differently cased or absent — selects the dark default.
 *   Only `dark` and `light` are ever answered.
 * - **One-shot resolution.** `resolvePanelTheme` answers the dark default with
 *   no `chrome` global, no `chrome.devtools`, no `panels`, a non-string name or
 *   a throwing getter, and never throws.
 * - **Following the host.** A store built by `createPanelThemeStore` adopts
 *   every name pushed through `setThemeChangeHandler`, re-reads `themeName`
 *   when the panel is shown again (`visibilitychange` to visible, window
 *   `focus`) when the handler is absent, never lets an unrefreshed `themeName`
 *   undo a pushed change, and catches up on a change made before it was
 *   subscribed.
 * - **Symmetric teardown.** The last unsubscribe unsets the DevTools handler
 *   with the documented no-argument call, only while it is still the store's
 *   own; a StrictMode subscribe → unsubscribe → subscribe cycle leaves exactly
 *   one registration; unsubscribing twice is a no-op; late notifications are
 *   ignored.
 * - **Degradation.** A refused registration, an unreadable `themeName` and a
 *   throwing subscriber are logged by error name and never break the store.
 * - **The entry point.** `main.tsx` applies the resolved theme to the document
 *   root before `App` first renders, and a DevTools switch after mount moves
 *   the document root's `data-theme` and the `theme` prop `App` (and through
 *   it `PanelView`/`PanelHost`) receives together.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). The `chrome` global is stubbed per
 * case with `vi.stubGlobal` and restored after it, and the document root's
 * theme attribute is cleared after every case. `App` is replaced by a probe
 * that renders the `theme` prop it receives and records the document root's
 * theme at each render, so the entry point runs exactly as shipped without the
 * panel's runtime port. That case imports `main.tsx` once, into a fresh module
 * graph, and is the last in the file because the React root it mounts lives
 * for the rest of the file.
 */
import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { LogFields, Logger, LogLevel } from '@debuggen/shared';

import {
  applyPanelTheme,
  createPanelThemeStore,
  panelThemeFromDevToolsThemeName,
  resolvePanelTheme,
} from '../src/panel/theme';
import type { PanelTheme } from '../src/panel/theme';

/** What the `App` probe saw: the document root's theme at each of its renders. */
const appProbe = vi.hoisted(() => ({ documentThemes: [] as (string | null)[] }));

vi.mock('../src/panel/App', () => ({
  App: ({ theme }: { readonly theme: string }) => {
    appProbe.documentThemes.push(document.documentElement.getAttribute('data-theme'));
    return <output data-testid="app-theme">{theme}</output>;
  },
}));

/** The attribute the renderer's stylesheet selects a theme on. */
const THEME_ATTRIBUTE = 'data-theme';

/** The callback shape `setThemeChangeHandler` receives. */
type ThemeCallback = (themeName: unknown) => void;

/** A stubbed `chrome.devtools.panels` whose theme-change channel the test drives. */
interface DevtoolsThemeHost {
  readonly panels: {
    themeName: unknown;
    readonly setThemeChangeHandler: Mock<(callback?: ThemeCallback) => void>;
  };
  /** Deliver a theme switch through the registered callback, as DevTools does. */
  emit(themeName: unknown): void;
  /** The callback DevTools currently holds, if any. */
  registered(): ThemeCallback | undefined;
}

/** Installs a DevTools host with a working `setThemeChangeHandler`. */
function stubDevtoolsWithHandler(themeName: unknown): DevtoolsThemeHost {
  let current: ThemeCallback | undefined;
  const panels = {
    themeName,
    setThemeChangeHandler: vi.fn((callback?: ThemeCallback): void => {
      current = callback;
    }),
  };
  vi.stubGlobal('chrome', { devtools: { panels } });
  return {
    panels,
    emit(name) {
      if (current === undefined) {
        throw new Error('No DevTools theme-change handler is registered.');
      }
      current(name);
    },
    registered: () => current,
  };
}

/** Installs a DevTools host that exposes `themeName` only, like the browser suite's stubs. */
function stubDevtoolsWithoutHandler(themeName: unknown): { themeName: unknown } {
  const panels = { themeName };
  vi.stubGlobal('chrome', { devtools: { panels } });
  return panels;
}

/** One recorded log call. */
interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/** A silent logger that remembers its calls. */
interface RecordingLogger extends Logger {
  readonly entries: LogEntry[];
}

function createRecordingLogger(): RecordingLogger {
  const entries: LogEntry[] = [];
  const levelled =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields });
    };
  const logger: RecordingLogger = {
    level: 'silent',
    entries,
    trace: levelled('trace'),
    debug: levelled('debug'),
    info: levelled('info'),
    warn: levelled('warn'),
    error: levelled('error'),
    fatal: levelled('fatal'),
    child: () => logger,
  };
  return logger;
}

/** Make `document.visibilityState` report `state` and announce it. */
function announceVisibility(state: DocumentVisibilityState): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
}

/** The panel window regaining focus. */
function announceFocus(): void {
  window.dispatchEvent(new Event('focus'));
}

afterEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
});

describe('panelThemeFromDevToolsThemeName', () => {
  const table: readonly (readonly [string | undefined, PanelTheme])[] = [
    ['default', 'dark'],
    ['dark', 'dark'],
    ['light', 'light'],
    ['', 'dark'],
    ['high-contrast', 'dark'],
    ['highContrast', 'dark'],
    ['Light', 'dark'],
    ['DARK', 'dark'],
    [' light', 'dark'],
    [undefined, 'dark'],
  ];

  it.each(table)('maps %j to %s', (themeName, expected) => {
    expect(panelThemeFromDevToolsThemeName(themeName)).toBe(expected);
  });

  it('answers only the two token themes the DevTools panel selects between', () => {
    const answered = new Set(
      table.map(([themeName]) => panelThemeFromDevToolsThemeName(themeName)),
    );
    expect(answered).toEqual(new Set<PanelTheme>(['dark', 'light']));
  });
});

describe('resolvePanelTheme', () => {
  it('answers the dark default with no chrome global', () => {
    vi.stubGlobal('chrome', undefined);
    expect(resolvePanelTheme()).toBe('dark');
  });

  it('answers the dark default with no chrome.devtools or no panels', () => {
    vi.stubGlobal('chrome', {});
    expect(resolvePanelTheme()).toBe('dark');
    vi.stubGlobal('chrome', { devtools: {} });
    expect(resolvePanelTheme()).toBe('dark');
  });

  it.each([
    ['default', 'dark'],
    ['dark', 'dark'],
    ['light', 'light'],
  ] as const)('resolves themeName %j to %s', (themeName, expected) => {
    stubDevtoolsWithoutHandler(themeName);
    expect(resolvePanelTheme()).toBe(expected);
  });

  it('answers the dark default for a non-string themeName', () => {
    stubDevtoolsWithoutHandler(42);
    expect(resolvePanelTheme()).toBe('dark');
  });

  it('answers the dark default, without throwing, when the themeName getter throws', () => {
    vi.stubGlobal('chrome', {
      devtools: {
        panels: {
          get themeName(): string {
            throw new Error('The DevTools host is gone.');
          },
        },
      },
    });
    expect(() => resolvePanelTheme()).not.toThrow();
    expect(resolvePanelTheme()).toBe('dark');
  });
});

describe('createPanelThemeStore', () => {
  it('reads nothing until it is first used, then resolves like resolvePanelTheme', () => {
    const read = vi.fn(() => 'light');
    vi.stubGlobal('chrome', {
      devtools: {
        panels: {
          get themeName(): string {
            return read();
          },
        },
      },
    });
    const store = createPanelThemeStore();
    expect(read).not.toHaveBeenCalled();
    expect(store.current()).toBe('light');
    expect(store.current()).toBe(resolvePanelTheme());
  });

  it('adopts every theme DevTools pushes through setThemeChangeHandler', () => {
    const host = stubDevtoolsWithHandler('default');
    const store = createPanelThemeStore();
    const onChange = vi.fn();
    expect(store.current()).toBe('dark');

    store.subscribe(onChange);
    expect(host.panels.setThemeChangeHandler).toHaveBeenCalledTimes(1);
    expect(host.panels.setThemeChangeHandler.mock.lastCall?.[0]).toBeTypeOf('function');
    expect(onChange).not.toHaveBeenCalled();

    host.emit('light');
    expect(store.current()).toBe('light');
    expect(onChange).toHaveBeenCalledTimes(1);

    // The same theme again is no change and notifies nobody.
    host.emit('light');
    expect(onChange).toHaveBeenCalledTimes(1);

    host.emit('dark');
    expect(store.current()).toBe('dark');
    expect(onChange).toHaveBeenCalledTimes(2);

    // "default" selects dark, which is already the theme.
    host.emit('default');
    expect(store.current()).toBe('dark');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('keeps the document root in step when a subscriber applies each snapshot', () => {
    const host = stubDevtoolsWithHandler('default');
    const store = createPanelThemeStore();
    applyPanelTheme(store.current());
    store.subscribe(() => {
      applyPanelTheme(store.current());
    });
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
    host.emit('light');
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe('light');
    host.emit('dark');
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
  });

  it('unsets the handler with the no-argument call and ignores late notifications', () => {
    const host = stubDevtoolsWithHandler('default');
    const store = createPanelThemeStore();
    const onChange = vi.fn();
    const unsubscribe = store.subscribe(onChange);
    const callback = host.registered();
    if (callback === undefined) {
      throw new Error('The store registered no theme-change handler.');
    }

    unsubscribe();
    expect(host.panels.setThemeChangeHandler).toHaveBeenCalledTimes(2);
    expect(host.panels.setThemeChangeHandler).toHaveBeenLastCalledWith();
    expect(host.panels.setThemeChangeHandler.mock.lastCall).toEqual([]);
    expect(host.registered()).toBeUndefined();

    // A notification DevTools had already queued changes nothing.
    callback('light');
    expect(store.current()).toBe('dark');
    expect(onChange).not.toHaveBeenCalled();

    // Unsubscribing again is a no-op.
    unsubscribe();
    expect(host.panels.setThemeChangeHandler).toHaveBeenCalledTimes(2);
  });

  it('leaves exactly one registration after a StrictMode subscribe → unsubscribe → subscribe', () => {
    const host = stubDevtoolsWithHandler('default');
    const store = createPanelThemeStore();
    const first = vi.fn();
    const second = vi.fn();

    store.subscribe(first)();
    store.subscribe(second);

    const calls = host.panels.setThemeChangeHandler.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]?.[0]).toBeTypeOf('function');
    expect(calls[1]).toEqual([]);
    expect(calls[2]?.[0]).toBe(calls[0]?.[0]);

    host.emit('light');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(store.current()).toBe('light');
  });

  it('shares one registration between subscribers and unsets it when the last one leaves', () => {
    const host = stubDevtoolsWithHandler('default');
    const store = createPanelThemeStore();
    const onChange = vi.fn();
    const leaveFirst = store.subscribe(onChange);
    const leaveSecond = store.subscribe(onChange);
    expect(host.panels.setThemeChangeHandler).toHaveBeenCalledTimes(1);

    // The same callback subscribed twice is two subscriptions.
    host.emit('light');
    expect(onChange).toHaveBeenCalledTimes(2);

    leaveFirst();
    expect(host.panels.setThemeChangeHandler).toHaveBeenCalledTimes(1);
    host.emit('dark');
    expect(onChange).toHaveBeenCalledTimes(3);

    leaveSecond();
    expect(host.panels.setThemeChangeHandler).toHaveBeenCalledTimes(2);
    expect(host.panels.setThemeChangeHandler).toHaveBeenLastCalledWith();
  });

  it('unsets the handler only while DevTools still holds its own', () => {
    const host = stubDevtoolsWithHandler('default');
    const earlier = createPanelThemeStore();
    const later = createPanelThemeStore();
    const leaveEarlier = earlier.subscribe(vi.fn());
    const leaveLater = later.subscribe(vi.fn());
    expect(host.panels.setThemeChangeHandler).toHaveBeenCalledTimes(2);

    // The later store replaced the earlier one's handler, so the earlier
    // store's departure must not unset it.
    leaveEarlier();
    expect(host.panels.setThemeChangeHandler).toHaveBeenCalledTimes(2);
    expect(host.registered()).toBeTypeOf('function');
    host.emit('light');
    expect(later.current()).toBe('light');
    expect(earlier.current()).toBe('dark');

    leaveLater();
    expect(host.panels.setThemeChangeHandler).toHaveBeenCalledTimes(3);
    expect(host.panels.setThemeChangeHandler).toHaveBeenLastCalledWith();
    expect(host.registered()).toBeUndefined();
  });

  it('re-reads themeName when the panel is shown again, without setThemeChangeHandler', () => {
    const panels = stubDevtoolsWithoutHandler('default');
    const store = createPanelThemeStore();
    const onChange = vi.fn();
    const unsubscribe = store.subscribe(onChange);
    expect(store.current()).toBe('dark');

    panels.themeName = 'light';
    announceVisibility('hidden');
    expect(store.current()).toBe('dark');
    expect(onChange).not.toHaveBeenCalled();

    announceVisibility('visible');
    expect(store.current()).toBe('light');
    expect(onChange).toHaveBeenCalledTimes(1);

    panels.themeName = 'dark';
    announceFocus();
    expect(store.current()).toBe('dark');
    expect(onChange).toHaveBeenCalledTimes(2);

    // Once unsubscribed, nothing is re-read.
    unsubscribe();
    panels.themeName = 'light';
    announceFocus();
    announceVisibility('visible');
    expect(store.current()).toBe('dark');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('never lets an unrefreshed themeName undo a pushed change, but adopts a changed one', () => {
    const host = stubDevtoolsWithHandler('default');
    const store = createPanelThemeStore();
    store.subscribe(vi.fn());

    host.emit('light');
    announceFocus();
    announceVisibility('visible');
    expect(store.current()).toBe('light');

    host.panels.themeName = 'dark';
    announceFocus();
    expect(store.current()).toBe('dark');
  });

  it('catches up on a change made between the first snapshot and the subscription', () => {
    const panels = stubDevtoolsWithoutHandler('default');
    const store = createPanelThemeStore();
    expect(store.current()).toBe('dark');
    panels.themeName = 'light';
    const onChange = vi.fn();
    store.subscribe(onChange);
    expect(store.current()).toBe('light');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('registers once when a subscription is made from inside the catch-up notification', () => {
    const host = stubDevtoolsWithHandler('default');
    const store = createPanelThemeStore();
    expect(store.current()).toBe('dark');
    host.panels.themeName = 'light';
    const nested = vi.fn();
    const leaves: (() => void)[] = [];
    leaves.push(
      store.subscribe(() => {
        if (leaves.length < 2) {
          leaves.push(store.subscribe(nested));
        }
      }),
    );
    expect(store.current()).toBe('light');
    expect(host.panels.setThemeChangeHandler).toHaveBeenCalledTimes(1);

    host.emit('dark');
    expect(nested).toHaveBeenCalledTimes(1);

    for (const leave of leaves) {
      leave();
    }
    expect(host.panels.setThemeChangeHandler).toHaveBeenCalledTimes(2);
    expect(host.panels.setThemeChangeHandler).toHaveBeenLastCalledWith();
  });

  it('consults themeName when a notification carries no usable name', () => {
    const host = stubDevtoolsWithHandler('default');
    const store = createPanelThemeStore();
    store.subscribe(vi.fn());
    host.panels.themeName = 'light';
    host.emit(undefined);
    expect(store.current()).toBe('light');
  });

  it('falls back to re-reading on show when DevTools refuses the handler', () => {
    const panels: { themeName: unknown; setThemeChangeHandler(): void } = {
      themeName: 'default',
      setThemeChangeHandler(): void {
        throw new Error('Extension context invalidated: raw detail.');
      },
    };
    vi.stubGlobal('chrome', { devtools: { panels } });
    const logger = createRecordingLogger();
    const store = createPanelThemeStore({ logger });

    expect(() => store.subscribe(vi.fn())).not.toThrow();
    expect(logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
    expect(logger.entries[0]?.fields).toEqual({ error: 'Error' });
    expect(JSON.stringify(logger.entries)).not.toContain('raw detail');

    panels.themeName = 'light';
    announceFocus();
    expect(store.current()).toBe('light');
  });

  it('keeps the current theme when themeName becomes unreadable', () => {
    let unreadable = false;
    let themeName = 'default';
    const setThemeChangeHandler = vi.fn();
    vi.stubGlobal('chrome', {
      devtools: {
        panels: {
          get themeName(): string {
            if (unreadable) {
              throw new Error('The DevTools host is gone.');
            }
            return themeName;
          },
          setThemeChangeHandler,
        },
      },
    });
    const logger = createRecordingLogger();
    const store = createPanelThemeStore({ logger });
    store.subscribe(vi.fn());
    themeName = 'light';
    announceFocus();
    expect(store.current()).toBe('light');

    unreadable = true;
    announceFocus();
    expect(store.current()).toBe('light');
    expect(logger.entries.at(-1)).toMatchObject({ level: 'debug', fields: { error: 'Error' } });
  });

  it('notifies every subscriber even when one of them throws', () => {
    const host = stubDevtoolsWithHandler('default');
    const logger = createRecordingLogger();
    const store = createPanelThemeStore({ logger });
    const healthy = vi.fn();
    store.subscribe(() => {
      throw new TypeError('subscriber failure');
    });
    store.subscribe(healthy);

    expect(() => {
      host.emit('light');
    }).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(store.current()).toBe('light');
    expect(logger.entries).toEqual([
      {
        level: 'error',
        message: 'A panel theme subscriber threw.',
        fields: { error: 'TypeError' },
      },
    ]);
  });

  it('follows nothing, and never throws, with no DevTools host at all', () => {
    vi.stubGlobal('chrome', undefined);
    const store = createPanelThemeStore();
    const onChange = vi.fn();
    const unsubscribe = store.subscribe(onChange);
    announceFocus();
    announceVisibility('visible');
    expect(store.current()).toBe('dark');
    expect(onChange).not.toHaveBeenCalled();
    expect(() => {
      unsubscribe();
    }).not.toThrow();
  });
});

// Last in the file: the React root this case mounts is never unmounted.
describe('panel entry point (main.tsx)', () => {
  it('themes the document before mount and moves the document root and App together on a switch', async () => {
    const host = stubDevtoolsWithHandler('default');
    const container = document.createElement('div');
    container.id = 'root';
    document.body.append(container);
    appProbe.documentThemes.length = 0;
    vi.resetModules();

    await act(async () => {
      await import('../src/panel/main');
    });

    const appTheme = (): string | null | undefined =>
      container.querySelector('[data-testid="app-theme"]')?.textContent;
    const documentTheme = (): string | null =>
      document.documentElement.getAttribute(THEME_ATTRIBUTE);

    // First paint: the root was themed before App first rendered.
    expect(appProbe.documentThemes[0]).toBe('dark');
    expect(documentTheme()).toBe('dark');
    expect(appTheme()).toBe('dark');

    // StrictMode's double effect left exactly one registered handler.
    const calls = host.panels.setThemeChangeHandler.mock.calls;
    const registrations = calls.filter((call) => typeof call[0] === 'function').length;
    const unsets = calls.filter((call) => call.length === 0).length;
    expect(registrations).toBe(unsets + 1);
    expect(host.panels.setThemeChangeHandler.mock.lastCall?.[0]).toBeTypeOf('function');

    // A DevTools theme switch after mount moves both theme roots together.
    act(() => {
      host.emit('light');
    });
    expect(documentTheme()).toBe('light');
    expect(appTheme()).toBe('light');

    act(() => {
      host.emit('default');
    });
    expect(documentTheme()).toBe('dark');
    expect(appTheme()).toBe('dark');

    // So does a theme found when the panel is shown again.
    host.panels.themeName = 'light';
    act(() => {
      announceVisibility('visible');
    });
    expect(documentTheme()).toBe('light');
    expect(appTheme()).toBe('light');
  });
});
