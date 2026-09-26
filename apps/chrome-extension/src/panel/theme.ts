/**
 * Theme resolution for the "Debug Generator" DevTools panel — the consumer half
 * of `@debuggen/panel-renderer`'s `data-theme` contract (AAP 0.6.1, 0.6.3).
 *
 * The design system splits theming into three jobs and gives each exactly one
 * owner:
 *
 *   1. **Detection** — learning which theme the host wants. The host here is
 *      Chrome DevTools, and its documented signal is
 *      `chrome.devtools.panels.themeName` (AAP 0.2.4). Only this module reads
 *      it, because only this workspace owns the `chrome.*` APIs.
 *   2. **Translation** — deciding what a host signal *means*. The product
 *      specification fixes it for this panel (AAP 0.6.3: "Dark mode is the
 *      default"; the DevTools panel selects `light`/`dark` from
 *      `themeName`): `"default"` and `"dark"` select `dark`, `"light"` selects
 *      `light`, and anything else selects `DEFAULT_PANEL_THEME`. That mapping
 *      is {@link panelThemeFromDevToolsThemeName}, implemented here rather
 *      than delegated to the renderer's `themeFromDevToolsThemeName`, because
 *      that mapper reads `"default"` as Chrome's light theme, is pinned that
 *      way by the renderer's own suite, and lives in a module the editor
 *      webview shares. Only the token sets themselves, their names and their
 *      DOM values come from the renderer, so the two surfaces still agree on
 *      what `dark` and `light` look like.
 *   3. **Application** — putting the attribute where the stylesheet's theme
 *      blocks select on it. The attribute name is `PANEL_THEME_ATTRIBUTE` and
 *      each theme's value comes from `panelThemeAttributeValue`; neither is
 *      ever written here as a literal, because the theme key and its DOM value
 *      are not the same string for every theme, and a hand-written value is a
 *      fully rendered, entirely unstyled panel.
 *
 * ## Two theme roots, one theme
 *
 * {@link applyPanelTheme} sets the attribute on the panel *document root* so
 * that the panel's own chrome — the header, the connection status, the event
 * details drawer and the live tail, none of which sits inside the generated
 * panel — resolves its `--dg-*` custom properties from the requested token set.
 * Inside `PanelHost`, the renderer's `PanelShell` is the theme root of the
 * generated panel and applies the same attribute on its own element from the
 * `theme` prop it is handed. The two are deliberately independent: this module
 * never reaches into, suppresses, overrides or re-applies the attribute inside
 * the `PanelHost` subtree. Callers pass the one theme they resolved here to
 * both, so the two roots always agree.
 *
 * ## Followed for the panel document's lifetime
 *
 * A DevTools theme switch does not reload an open extension panel's document,
 * so a theme resolved only at load would leave both theme roots on the old
 * token set. The panel document's theme store — {@link subscribePanelTheme}
 * and {@link getPanelThemeSnapshot}, an instance of
 * {@link createPanelThemeStore} — therefore follows the host through two
 * channels for as long as anything is subscribed:
 *
 *   - **Push.** `chrome.devtools.panels.setThemeChangeHandler` (Chrome 99+)
 *     calls back with the new theme name, which is adopted as the latest
 *     reported value. The method is feature-detected: an older DevTools build,
 *     an extension page opened directly and the browser suite's stubs do not
 *     provide it. Unsubscribing unsets the handler with the documented
 *     no-argument call, and only while the handler DevTools holds is still
 *     the one this store registered.
 *   - **Re-read on show.** Whenever the panel document becomes visible again
 *     (`visibilitychange` to `visible`) or regains focus, `themeName` is read
 *     once more. A re-read is adopted only when it differs from the previous
 *     read, so a `themeName` the host has not refreshed can never overwrite a
 *     newer pushed value.
 *
 * `./main.tsx` reads the store with React's `useSyncExternalStore` and applies
 * each snapshot to the document root in the same commit that hands it to
 * `App` — and through `PanelView` to `PanelHost` — so the two theme roots
 * always move together. No timer and no poll is involved.
 *
 * ## Works with no DevTools at all
 *
 * The panel page is also opened directly as an ordinary extension page — the
 * browser suite renders `panel.html` that way (AAP 0.8.3) — and unit suites
 * load it with no `chrome` global whatsoever. In both contexts
 * `chrome.devtools` is absent, and resolution falls back silently to
 * `DEFAULT_PANEL_THEME`, the product's dark default and the set the generated
 * stylesheet serves from `:root`. A missing or unreadable host signal is a
 * styled panel in the default theme, never an error and never an unstyled one.
 *
 * ## Boundaries
 *
 * No I/O beyond reading that one DevTools value, registering DevTools' one
 * theme-change handler, listening for the panel document being shown again and
 * writing one DOM attribute: no socket, no `fetch`, no HTTP, no storage, no
 * timer. No visual value lives here either (AAP 0.6.4) — every colour, length
 * and font is a token delivered by the renderer's stylesheet. No React either:
 * the hook that reads the store lives in `./main.tsx`, under the React lint
 * rules. The only imports are `@debuggen/panel-renderer`, `@debuggen/shared`
 * (the injectable logger) and the ambient `chrome` global.
 *
 * @example Panel entry point: apply the resolved theme before the first paint,
 * then follow it, handing the same value to the document root and to the
 * React tree that mounts `PanelHost`.
 * ```tsx
 * import { applyPanelTheme, getPanelThemeSnapshot, subscribePanelTheme } from './theme';
 *
 * applyPanelTheme(getPanelThemeSnapshot());
 *
 * function ThemedApp(): ReactElement {
 *   const theme = useSyncExternalStore(subscribePanelTheme, getPanelThemeSnapshot);
 *   useLayoutEffect(() => {
 *     applyPanelTheme(theme);
 *   }, [theme]);
 *   return <App theme={theme} />;
 * }
 * ```
 *
 * @module
 */

import {
  DEFAULT_PANEL_THEME,
  PANEL_THEME_ATTRIBUTE,
  panelThemeAttributeValue,
} from '@debuggen/panel-renderer';
import type { PanelTheme } from '@debuggen/panel-renderer';
import { noopLogger } from '@debuggen/shared';
import type { Logger } from '@debuggen/shared';

/**
 * The design system's theme union, re-exported so the panel's entry point, its
 * `App` and its `PanelView` share one import site for theme identity.
 */
export type { PanelTheme };

/**
 * The slice of the `chrome` global this module reads, widened to what can
 * actually be present at runtime.
 *
 * `@types/chrome` declares `chrome.devtools.panels.themeName` as always present
 * and always `"default" | "dark"`. That describes a DevTools panel document
 * only: on an extension page opened directly, `chrome.devtools` is undefined,
 * and a DevTools build may report a name the typings do not list — `"light"`
 * among them, which {@link panelThemeFromDevToolsThemeName} still accepts
 * defensively as the explicit light request. Every link is therefore optional
 * and the value itself is `unknown`, so the reads below are checked rather
 * than asserted. `setThemeChangeHandler` is optional for the same reason (it
 * exists from Chrome 99, and the browser suite's stubs provide `themeName`
 * only), and its callback's argument is `unknown` because the host supplies
 * it. The `chrome` namespace is assignable to this shape as it stands — no
 * cast is involved anywhere.
 */
interface DevToolsThemeHost {
  readonly devtools?:
    | {
        readonly panels?: DevToolsThemePanels | undefined;
      }
    | undefined;
}

/** The callback this module registers with `panels.setThemeChangeHandler`. */
type ThemeChangeCallback = (themeName: unknown) => void;

/** The members of `chrome.devtools.panels` this module reads or calls. */
interface DevToolsThemePanels {
  readonly themeName?: unknown;
  /**
   * Registers the one theme-change callback of this document, replacing any
   * earlier one; called with no argument, it unsets it.
   */
  readonly setThemeChangeHandler?: ((callback?: ThemeChangeCallback) => void) | undefined;
}

/**
 * `chrome.devtools.panels`, or `undefined` when this document has no DevTools
 * host: the `chrome` global itself (absent outside an extension context), then
 * `devtools`, then `panels` are guarded in turn. Any exception a host getter
 * might raise propagates to the caller, which owns the fallback.
 */
function readDevToolsPanels(): DevToolsThemePanels | undefined {
  if (typeof chrome === 'undefined') {
    return undefined;
  }
  const host: DevToolsThemeHost = chrome;
  return host.devtools?.panels;
}

/**
 * Reads the raw DevTools theme name, or `undefined` when this document has no
 * DevTools host to ask. The value is accepted only as a string; any exception
 * a host getter might raise propagates to the caller.
 */
function readDevToolsThemeName(): string | undefined {
  const themeName = readDevToolsPanels()?.themeName;
  return typeof themeName === 'string' ? themeName : undefined;
}

/**
 * One guarded read of `chrome.devtools.panels.themeName`: the name — itself
 * `undefined` when there is no host signal — or, when a host getter threw,
 * `readable: false` with what it threw.
 */
type ThemeNameReading =
  | { readonly readable: true; readonly themeName: string | undefined }
  | { readonly readable: false; readonly cause: unknown };

/** {@link readDevToolsThemeName}, with a throwing host turned into a value. */
function readThemeNameGuarded(): ThemeNameReading {
  try {
    return { readable: true, themeName: readDevToolsThemeName() };
  } catch (cause: unknown) {
    return { readable: false, cause };
  }
}

/** A value's error name for a log field — never its message or contents. */
function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause;
}

/**
 * The panel theme a DevTools theme name selects — the product's mapping for
 * this surface (AAP 0.6.3).
 *
 * | `themeName`                          | Panel theme            |
 * | ------------------------------------ | ---------------------- |
 * | `"default"`                          | `dark`                 |
 * | `"dark"`                             | `dark`                 |
 * | `"light"`                            | `light`                |
 * | anything else, `""`, or `undefined`  | `DEFAULT_PANEL_THEME`  |
 *
 * Chrome's own API reference describes `"default"` as DevTools' light theme.
 * The product specification deliberately maps it to `dark` instead: dark mode
 * is the product default, so DevTools' default theme name selects the
 * product's default token set. `"light"` is not a value `@types/chrome` lists
 * (it types the name as `"default" | "dark"`); it is accepted defensively as
 * the explicit light request, and it is the only name that selects the light
 * token set. `highContrast` is never answered — the DevTools panel selects
 * between `dark` and `light` only — and the mapping is total, so it cannot
 * throw.
 *
 * @example
 * ```ts
 * panelThemeFromDevToolsThemeName('default'); // 'dark'
 * panelThemeFromDevToolsThemeName('light'); // 'light'
 * panelThemeFromDevToolsThemeName(undefined); // 'dark' (DEFAULT_PANEL_THEME)
 * ```
 */
export function panelThemeFromDevToolsThemeName(themeName: string | undefined): PanelTheme {
  switch (themeName) {
    case 'default':
    case 'dark':
      return 'dark';
    case 'light':
      return 'light';
    default:
      return DEFAULT_PANEL_THEME;
  }
}

/**
 * Resolves the theme the panel should render in from the DevTools host, once.
 *
 * The raw `chrome.devtools.panels.themeName` string is translated by
 * {@link panelThemeFromDevToolsThemeName}, so `"default"` and `"dark"` resolve
 * to `dark` and `"light"` to `light`. When `chrome`, `chrome.devtools`,
 * `chrome.devtools.panels` or the name itself is missing, or reading any of them
 * throws, the result is `DEFAULT_PANEL_THEME`.
 *
 * This is a one-shot read. To follow the DevTools theme while the panel stays
 * open, read {@link getPanelThemeSnapshot} and {@link subscribePanelTheme}
 * instead; the store behind them starts from this same resolution.
 *
 * @returns The theme to apply; never throws.
 */
export function resolvePanelTheme(): PanelTheme {
  return themeFromReading(readThemeNameGuarded());
}

/**
 * The theme a guarded read selects. A host getter that threw is treated
 * exactly like an absent host signal: the panel renders in the default theme
 * rather than failing to start.
 */
function themeFromReading(reading: ThemeNameReading): PanelTheme {
  return reading.readable
    ? panelThemeFromDevToolsThemeName(reading.themeName)
    : DEFAULT_PANEL_THEME;
}

/**
 * Finds the element the theme attribute belongs on.
 *
 * - No root, or `null`: the current panel document's root element.
 * - A `Document`: that document's root element — which is how a caller targets
 *   a document other than the current one.
 * - An `Element`: that element itself.
 *
 * The `Document` case is distinguished structurally (`'documentElement' in
 * root`) rather than with `instanceof`, which fails across realms — a document
 * from another window or from a test environment's own window. The answer is
 * `null` when there is no document at all, or when the document has no root
 * element yet, which makes {@link applyPanelTheme} a no-op rather than a throw.
 */
function resolveThemeRoot(root: Element | Document | null | undefined): Element | null {
  if (root === undefined || root === null) {
    if (typeof document === 'undefined') {
      return null;
    }
    return documentRootElement(document);
  }
  if ('documentElement' in root) {
    return documentRootElement(root);
  }
  return root;
}

/**
 * A document's root element, widened to the `null` lib.dom's typing omits: a
 * document created without one (`document.implementation.createDocument` with
 * no root name, or one whose root was removed) reports `null` at runtime.
 */
function documentRootElement(doc: Document): Element | null {
  return doc.documentElement;
}

/**
 * Applies a theme to the panel document root, so the panel's own chrome —
 * everything outside the generated panel's `PanelShell` — resolves its `--dg-*`
 * tokens from that theme's value set.
 *
 * Writes `PANEL_THEME_ATTRIBUTE` with `panelThemeAttributeValue(theme)`, for
 * every theme including the default: the default's value selects nothing (its
 * tokens are the stylesheet's `:root` block), so writing it is harmless and
 * keeps the applied theme observable in the DOM. The attribute is left alone
 * when it already holds that value, so re-applying the same theme causes no
 * mutation. With no document, or a document with no root element, nothing is
 * written and nothing is thrown.
 *
 * This never touches the attribute `PanelShell` sets on its own element inside
 * `PanelHost`; hand the same theme to the React tree to keep the two in step.
 *
 * @param theme - The theme to apply, typically from {@link getPanelThemeSnapshot}
 *   or {@link resolvePanelTheme}.
 * @param root - Where to apply it: an element, or a document whose root element
 *   receives it. Omitted or `null`, the current document's root element.
 * @returns `theme`, unchanged, so resolution and application chain:
 *   `applyPanelTheme(resolvePanelTheme())`.
 */
export function applyPanelTheme(theme: PanelTheme, root?: Element | Document | null): PanelTheme {
  const target = resolveThemeRoot(root);
  if (target === null) {
    return theme;
  }
  const value = panelThemeAttributeValue(theme);
  if (target.getAttribute(PANEL_THEME_ATTRIBUTE) !== value) {
    target.setAttribute(PANEL_THEME_ATTRIBUTE, value);
  }
  return theme;
}

// ---------------------------------------------------------------------------
// Following the DevTools theme
// ---------------------------------------------------------------------------

/**
 * A source of the panel theme that React reads with `useSyncExternalStore`
 * (see the module overview, "Followed for the panel document's lifetime").
 */
export interface PanelThemeStore {
  /**
   * The theme the panel should render in now. Resolved from DevTools on first
   * use, exactly as {@link resolvePanelTheme} resolves it, and unchanged until
   * the host reports a different theme, so consecutive calls return the same
   * primitive.
   */
  current(): PanelTheme;
  /**
   * Calls `onChange` after every change of {@link current}'s value. The
   * first subscriber starts following DevTools and the last one to leave
   * stops, so a StrictMode subscribe → unsubscribe → subscribe cycle leaves
   * exactly one registration behind.
   *
   * @returns The unsubscribe function; calling it again is a no-op.
   */
  subscribe(onChange: () => void): () => void;
}

/** What {@link createPanelThemeStore} accepts. */
export interface PanelThemeStoreOptions {
  /**
   * Where degraded host calls are reported. Fields carry error names only.
   * Defaults to silence.
   */
  readonly logger?: Logger | undefined;
}

/**
 * The callback this module most recently registered with
 * `panels.setThemeChangeHandler`, whichever store registered it.
 *
 * DevTools holds a single theme-change handler per document and offers no way
 * to read it back, so this is how a store tells, when its last subscriber
 * leaves, whether the handler DevTools holds is still its own. A store whose
 * handler has since been replaced by another store's leaves it registered.
 */
let registeredThemeChangeCallback: ThemeChangeCallback | undefined;

/**
 * Builds a theme store that follows `chrome.devtools.panels` while subscribed.
 *
 * Creating a store reads nothing: the host is consulted on the first
 * {@link PanelThemeStore.current} or {@link PanelThemeStore.subscribe}.
 * While at least one subscriber is present the store
 *
 *   1. registers a theme-change callback through `setThemeChangeHandler`,
 *      when the host provides that method, and adopts every name it reports;
 *   2. re-reads `themeName` when the document becomes visible again and when
 *      its window regains focus, adopting the value only when it differs from
 *      the previous read — a `themeName` the host never refreshes therefore
 *      cannot undo a pushed change;
 *   3. re-reads once more right after starting, so a change between the first
 *      snapshot and the first subscription is not missed.
 *
 * Every translation goes through {@link panelThemeFromDevToolsThemeName}, and a
 * host call that throws degrades to the other channel instead of failing:
 * a refused registration leaves the re-read channel, and an unreadable
 * `themeName` keeps the current theme.
 *
 * The panel document uses one instance, behind {@link subscribePanelTheme} and
 * {@link getPanelThemeSnapshot}; separate instances exist for tests.
 *
 * @example
 * ```ts
 * const store = createPanelThemeStore({ logger });
 * const stop = store.subscribe(() => {
 *   applyPanelTheme(store.current());
 * });
 * // … later
 * stop();
 * ```
 */
export function createPanelThemeStore(options: PanelThemeStoreOptions = {}): PanelThemeStore {
  const logger = options.logger ?? noopLogger;
  // Each entry is its own object, so one callback subscribed twice is two
  // subscriptions and unsubscribing one leaves the other in place.
  const subscribers = new Set<{ readonly onChange: () => void }>();
  let snapshot: PanelTheme | undefined;
  /** The value the last read of `themeName` returned; pushes never touch it. */
  let lastReadThemeName: string | undefined;
  let following = false;
  let stopFollowing: (() => void) | undefined;

  function currentTheme(): PanelTheme {
    if (snapshot === undefined) {
      const reading = readThemeNameGuarded();
      if (reading.readable) {
        lastReadThemeName = reading.themeName;
      } else {
        logger.debug('The DevTools theme name could not be read; using the default theme.', {
          error: errorName(reading.cause),
        });
      }
      snapshot = themeFromReading(reading);
    }
    return snapshot;
  }

  function publish(next: PanelTheme): void {
    if (next === currentTheme()) {
      return;
    }
    snapshot = next;
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.onChange();
      } catch (cause: unknown) {
        // One failing subscriber must not keep the others on the old theme.
        logger.error('A panel theme subscriber threw.', { error: errorName(cause) });
      }
    }
  }

  /**
   * Re-reads `themeName`. Unforced, the value is adopted only when it differs
   * from the previous read; forced, it is adopted as it stands.
   */
  function rereadThemeName(force: boolean): void {
    const reading = readThemeNameGuarded();
    if (!reading.readable) {
      logger.debug('The DevTools theme name could not be re-read; keeping the current theme.', {
        error: errorName(reading.cause),
      });
      return;
    }
    if (!force && reading.themeName === lastReadThemeName) {
      return;
    }
    lastReadThemeName = reading.themeName;
    publish(panelThemeFromDevToolsThemeName(reading.themeName));
  }

  const onThemeChange: ThemeChangeCallback = (themeName) => {
    if (!following) {
      // Delivered after the last subscriber left; nothing renders from it.
      return;
    }
    if (typeof themeName === 'string') {
      publish(panelThemeFromDevToolsThemeName(themeName));
      return;
    }
    // A notification without a usable name still says the theme changed, so
    // the property is consulted as it stands.
    rereadThemeName(true);
  };

  function releaseThemeChangeHandler(panels: DevToolsThemePanels): void {
    if (registeredThemeChangeCallback !== onThemeChange) {
      // Another store registered its own callback since; it is not ours to unset.
      return;
    }
    registeredThemeChangeCallback = undefined;
    try {
      // The documented way to unset the handler: call it with no argument.
      panels.setThemeChangeHandler?.();
    } catch (cause: unknown) {
      logger.debug('Unsetting the DevTools theme-change handler failed.', {
        error: errorName(cause),
      });
    }
  }

  function startFollowing(): () => void {
    const stops: (() => void)[] = [];
    following = true;

    try {
      const panels = readDevToolsPanels();
      if (panels !== undefined && typeof panels.setThemeChangeHandler === 'function') {
        panels.setThemeChangeHandler(onThemeChange);
        registeredThemeChangeCallback = onThemeChange;
        stops.push(() => {
          releaseThemeChangeHandler(panels);
        });
      }
    } catch (cause: unknown) {
      logger.warn(
        'The DevTools theme-change handler could not be registered; the theme is re-read when the panel is shown.',
        { error: errorName(cause) },
      );
    }

    if (typeof document !== 'undefined') {
      const doc = document;
      const onVisibilityChange = (): void => {
        if (doc.visibilityState === 'visible') {
          rereadThemeName(false);
        }
      };
      doc.addEventListener('visibilitychange', onVisibilityChange);
      stops.push(() => {
        doc.removeEventListener('visibilitychange', onVisibilityChange);
      });
    }
    if (typeof window !== 'undefined') {
      const win = window;
      const onFocus = (): void => {
        rereadThemeName(false);
      };
      win.addEventListener('focus', onFocus);
      stops.push(() => {
        win.removeEventListener('focus', onFocus);
      });
    }

    return () => {
      following = false;
      for (const stop of stops.reverse()) {
        stop();
      }
    };
  }

  return {
    current: currentTheme,
    subscribe(onChange) {
      currentTheme();
      const subscriber = { onChange };
      subscribers.add(subscriber);
      if (stopFollowing === undefined) {
        stopFollowing = startFollowing();
        // Catch up on a change made between the first snapshot and this
        // subscription. It runs once `stopFollowing` is set, so a subscription
        // made from inside this notification joins the running registration
        // instead of starting a second one.
        rereadThemeName(false);
      }
      return () => {
        if (!subscribers.delete(subscriber) || subscribers.size > 0) {
          return;
        }
        const stop = stopFollowing;
        stopFollowing = undefined;
        stop?.();
      };
    },
  };
}

/** The panel document's one theme store; `./main.tsx` renders from it. */
const panelDocumentThemeStore = createPanelThemeStore();

/**
 * Subscribes to the panel document's theme: `onChange` runs after every change
 * of {@link getPanelThemeSnapshot}. A stable function, so it can be handed to
 * `useSyncExternalStore` as is.
 *
 * @returns The unsubscribe function.
 */
export function subscribePanelTheme(onChange: () => void): () => void {
  return panelDocumentThemeStore.subscribe(onChange);
}

/**
 * The panel document's current theme — `useSyncExternalStore`'s snapshot for
 * {@link subscribePanelTheme}, and the value `./main.tsx` applies before the
 * first paint.
 */
export function getPanelThemeSnapshot(): PanelTheme {
  return panelDocumentThemeStore.current();
}
