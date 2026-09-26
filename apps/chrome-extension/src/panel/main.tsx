/**
 * Entry module of the DevTools panel document (`./panel.html`). Start-up, in order:
 *
 * 1. The renderer stylesheet is the first import: the `@debuggen/panel-renderer` JS
 *    barrel never imports its CSS. It is the panel's only styling act — no inline
 *    styles and no `<style>` block, because every value resolves to a renderer token.
 * 2. The theme store's resolved theme is applied to the document root before
 *    `createRoot`, so the first paint uses the right token set; the extension CSP
 *    rules out doing this with an inline script in the page. Resolution falls back
 *    to dark when `chrome.devtools` is absent, as when the page opens directly as an
 *    extension page, so this module adds no `chrome.*` access.
 * 3. {@link ThemedApp} mounts into `#root` inside `StrictMode`; a missing mount
 *    element throws an `Error` naming the id rather than leaving a blank DevTools tab.
 *
 * @module apps/chrome-extension/src/panel/main
 */

import '@debuggen/panel-renderer/styles.css';

import { StrictMode, useLayoutEffect, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { applyPanelTheme, getPanelThemeSnapshot, subscribePanelTheme } from './theme';

/**
 * The id of the mount element `./panel.html` declares (`<div id="root">`).
 * Renaming it there without renaming it here fails loudly at start-up.
 */
const PANEL_ROOT_ELEMENT_ID = 'root';

/**
 * Finds the panel document's mount element.
 *
 * @throws Error naming {@link PANEL_ROOT_ELEMENT_ID} when the document has no
 *   element with that id, so a broken document is a reported start-up failure
 *   rather than a blank DevTools tab.
 */
function findMountElement(): HTMLElement {
  const container = document.getElementById(PANEL_ROOT_ELEMENT_ID);
  if (container === null) {
    throw new Error(
      `Debug Generator panel: mount element #${PANEL_ROOT_ELEMENT_ID} was not found in ` +
        `${document.location.pathname}. The panel document must contain ` +
        `<div id="${PANEL_ROOT_ELEMENT_ID}"></div> before its module script.`,
    );
  }
  return container;
}

/**
 * Renders {@link App} in the live DevTools theme read from the panel theme store.
 * The layout effect writes the same theme to the document root in the commit that
 * renders it, so the panel chrome and the generated panel never paint in different
 * token sets.
 */
function ThemedApp(): ReactElement {
  const theme = useSyncExternalStore(subscribePanelTheme, getPanelThemeSnapshot);
  useLayoutEffect(() => {
    applyPanelTheme(theme);
  }, [theme]);
  return <App theme={theme} />;
}

// Theme before the React root; `ThemedApp` renders from this same snapshot.
applyPanelTheme(getPanelThemeSnapshot());

createRoot(findMountElement()).render(
  <StrictMode>
    <ThemedApp />
  </StrictMode>,
);
