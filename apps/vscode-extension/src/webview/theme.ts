/**
 * Theme bridge of the "Debug Generator" VS Code webview (AAP 0.6.3): it detects the editor theme
 * from the `vscode-*` classes VS Code puts on `document.body` and applies it to the document root.
 * The class-to-theme mapping itself is `themeFromVsCodeBodyClass` in `@debuggen/panel-renderer`, so
 * this surface and the DevTools panel cannot disagree; applying the theme inside the renderer
 * subtree belongs to `PanelShell`, from the `theme` prop `App` hands it.
 *
 * @module
 */

import { useEffect, useSyncExternalStore } from 'react';

import {
  DEFAULT_PANEL_THEME,
  PANEL_THEME_ATTRIBUTE,
  PANEL_THEMES,
  panelThemeAttributeValue,
  themeFromVsCodeBodyClass,
} from '@debuggen/panel-renderer';
import type { PanelTheme } from '@debuggen/panel-renderer';

/**
 * The design system's theme union, re-exported so the webview's entry point and `App` share one
 * import site for theme identity — exactly as the DevTools panel's `theme.ts` does.
 */
export type { PanelTheme };

/**
 * The one mutation that can re-theme a live webview: VS Code swaps the classes on the body element
 * in place and fires no event. Nothing broader is observed — no subtree, no child list, no other
 * attribute — so an unrelated DOM change never wakes the observer.
 */
const BODY_CLASS_OBSERVATION: MutationObserverInit = {
  attributes: true,
  attributeFilter: ['class'],
};

/**
 * One live subscription. Each call to {@link subscribeToThemeChanges} gets its own object, so the
 * same callback subscribed twice counts twice and each unsubscribe removes exactly its own entry.
 */
interface ThemeSubscription {
  readonly onStoreChange: () => void;
}

/** The live subscriptions. Its size is the reference count that owns {@link bodyClassObserver}. */
const subscriptions = new Set<ThemeSubscription>();

/**
 * The single shared observer: created by the first subscriber, disconnected and cleared by the
 * last. `null` while nobody subscribes, and also while there is no body to observe.
 */
let bodyClassObserver: MutationObserver | null = null;

/**
 * The theme as last resolved from the body classes. Authoritative only while
 * {@link bodyClassObserver} is live, because only then is every class change guaranteed to refresh
 * it; {@link getThemeSnapshot} resolves afresh otherwise.
 */
let observedTheme: PanelTheme = DEFAULT_PANEL_THEME;

/**
 * The webview's body element, or `null` when there is none to read: no document at all (the
 * module evaluated outside a browser) or a document whose body has not been parsed yet. lib.dom
 * types `document.body` as always present; the wider return type records what the runtime can
 * actually report.
 */
function currentBody(): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.body;
}

/** The document's root element, or `null` with no document or a document that has no root. */
function currentDocumentRoot(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.documentElement;
}

/**
 * Resolves the theme the webview should render in.
 *
 * With no argument the body element's current `className` is read; with one, that string is
 * translated instead (an explicit empty string is honoured as "no theme class"). The translation is
 * the renderer's `themeFromVsCodeBodyClass`, verbatim — both high-contrast classes map to
 * `highContrast`, `vscode-light` to `light`, `vscode-dark` to `dark`, anything else to
 * `DEFAULT_PANEL_THEME`. With no document or no body yet, the answer is `DEFAULT_PANEL_THEME`.
 *
 * @param bodyClassName A body `className` to translate; omitted, the live body is read.
 * @returns The theme to apply; never throws.
 */
export function resolveWebviewTheme(bodyClassName?: string): PanelTheme {
  if (bodyClassName !== undefined) {
    return themeFromVsCodeBodyClass(bodyClassName);
  }
  const body = currentBody();
  return body === null ? DEFAULT_PANEL_THEME : themeFromVsCodeBodyClass(body.className);
}

/**
 * Applies a theme to the document root, so the view's own chrome resolves its `--dg-*` tokens from
 * that theme's value set before and outside any `PanelShell`.
 *
 * The attribute is `PANEL_THEME_ATTRIBUTE` and its value `panelThemeAttributeValue(theme)`; neither
 * is written here as a literal, because a theme key and its DOM value are not the same string for
 * every theme. It is written for the default theme too: the dark set is the stylesheet's `:root`
 * block, so its value matches no selector and is harmless, and writing it keeps the attribute an
 * accurate description of the resolved theme — as `PanelShell` does. An unchanged value causes no
 * DOM mutation. A value that is not a theme at runtime (an untyped or persisted caller input)
 * applies `DEFAULT_PANEL_THEME` rather than writing an attribute no selector can match. With no
 * document, or a document with no root element, nothing is written and nothing is thrown.
 *
 * @param theme The theme to apply, typically from {@link resolveWebviewTheme}.
 * @param root The element to theme; omitted or `null`, the current document's root element.
 */
export function applyWebviewTheme(theme: PanelTheme, root?: Element | null): void {
  const target = root ?? currentDocumentRoot();
  if (target === null) {
    return;
  }
  const knownTheme = PANEL_THEMES.includes(theme) ? theme : DEFAULT_PANEL_THEME;
  const value = panelThemeAttributeValue(knownTheme);
  if (target.getAttribute(PANEL_THEME_ATTRIBUTE) !== value) {
    target.setAttribute(PANEL_THEME_ATTRIBUTE, value);
  }
}

/**
 * Calls every live subscriber once. A subscriber that throws does not starve the ones after it:
 * all are called, then the first error is rethrown so it still surfaces as an uncaught error.
 * Iterates over a copy, so a subscriber that unsubscribes (or subscribes) while being notified
 * cannot disturb the round.
 */
function notifySubscribers(): void {
  let failed = false;
  let firstError: unknown;
  for (const subscription of Array.from(subscriptions)) {
    try {
      subscription.onStoreChange();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  }
  if (failed) {
    throw firstError;
  }
}

/**
 * The observer callback. Re-resolves the theme and notifies only when the *resolved* theme changed,
 * so VS Code adding or removing an unrelated body class never re-renders a subscriber.
 */
function handleBodyClassMutation(): void {
  const next = resolveWebviewTheme();
  if (next === observedTheme) {
    return;
  }
  observedTheme = next;
  notifySubscribers();
}

/**
 * Starts the shared observer unless it is already running. Called on every subscribe, so a
 * subscriber that arrives after the body exists still starts observation if an earlier one found
 * no body (or no `MutationObserver`) and had to skip it.
 */
function ensureObserving(): void {
  if (bodyClassObserver !== null) {
    return;
  }
  observedTheme = resolveWebviewTheme();
  const body = currentBody();
  if (body === null || typeof MutationObserver === 'undefined') {
    return;
  }
  const observer = new MutationObserver(handleBodyClassMutation);
  observer.observe(body, BODY_CLASS_OBSERVATION);
  bodyClassObserver = observer;
}

/** Disconnects and clears the shared observer, once the last subscription is gone. */
function stopObserving(): void {
  if (bodyClassObserver === null) {
    return;
  }
  bodyClassObserver.disconnect();
  bodyClassObserver = null;
}

/**
 * The `subscribe` half of the external store `useSyncExternalStore` reads.
 *
 * Reference counted: the first live subscription creates and starts the one shared observer, the
 * last unsubscribe disconnects it. Under React 19 StrictMode the development-only
 * subscribe → unsubscribe → subscribe cycle therefore goes 1 → 0 (observer disconnected and
 * cleared) → 1 (a fresh observer), leaving exactly one live observer, as does any number of
 * mounted consumers. The returned function is idempotent: calling it again does nothing.
 *
 * @param onStoreChange Called whenever the resolved theme changes.
 * @returns The unsubscribe function.
 */
export function subscribeToThemeChanges(onStoreChange: () => void): () => void {
  const subscription: ThemeSubscription = { onStoreChange };
  subscriptions.add(subscription);
  ensureObserving();
  return () => {
    if (!subscriptions.delete(subscription)) {
      return;
    }
    if (subscriptions.size === 0) {
      stopObserving();
    }
  };
}

/**
 * The `getSnapshot` half of the external store: the current theme, as a primitive string, so
 * `useSyncExternalStore`'s identity comparison is stable by value and cannot loop.
 *
 * While observing it is a variable read; otherwise — before the first subscription, or with no body
 * to observe — it resolves from the body afresh, which is one split of a short class string. With
 * no DOM at all it answers `DEFAULT_PANEL_THEME`, which is why it also serves as the server
 * snapshot.
 */
export function getThemeSnapshot(): PanelTheme {
  return bodyClassObserver === null ? resolveWebviewTheme() : observedTheme;
}

/**
 * The editor's current theme, kept live as VS Code re-themes the webview, and applied to the
 * document root whenever it changes.
 *
 * Pass the result to `PanelShell`'s `theme` prop; the document root receives the same theme here,
 * so the two theme roots always agree. The attribute write is a passive effect, but a store update
 * is a synchronous-lane render, whose passive effects React flushes at the end of the commit — so
 * after a live theme change both roots are re-themed before the next paint.
 *
 * @returns The resolved theme.
 */
export function useWebviewTheme(): PanelTheme {
  const theme = useSyncExternalStore(subscribeToThemeChanges, getThemeSnapshot, getThemeSnapshot);
  useEffect(() => {
    applyWebviewTheme(theme);
  }, [theme]);
  return theme;
}
