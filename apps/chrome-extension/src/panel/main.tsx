/**
 * The browser entry point of the "Debug Generator" DevTools panel — the module
 * `./panel.html` loads with `<script type="module" src="./main.tsx">`.
 *
 * ## What this module owns
 *
 * Exactly three start-up acts, in this order, and nothing else:
 *
 *   1. **The design system's stylesheet.** `@debuggen/panel-renderer` ships its
 *      CSS as a separate `./styles.css` export (AAP 0.6.1): the JavaScript
 *      barrel never imports it, so the panel is unstyled unless an entry point
 *      does. It is this module's first import, which makes Vite emit it as the
 *      panel document's stylesheet and guarantees the `--dg-*` custom
 *      properties and the component classes exist before React mounts. It is
 *      also the panel's only styling act: no component, and nothing here, ships
 *      inline styles, a `<style>` block or a hand-written class (AAP 0.6.4).
 *   2. **The theme, before first paint.** `getPanelThemeSnapshot()` resolves
 *      the DevTools theme through the panel document's theme store and
 *      `applyPanelTheme()` writes the renderer's theme attribute on the
 *      document root, synchronously, before the React root is created. That is
 *      what prevents a flash of the wrong token set when the tab opens, and
 *      what lets the panel chrome outside the generated panel's own theme root
 *      (header, connection status, drawer, live tail) resolve its tokens. Dark
 *      is the default token set (AAP 0.6.3), and it is also what resolution
 *      falls back to when `chrome.devtools` is absent — the browser suite opens
 *      this page directly as an extension page (AAP 0.8.3), so this module
 *      adds no `chrome.*` access of its own.
 *   3. **The React root.** React 19's `createRoot` mounts {@link ThemedApp}
 *      into the element `./panel.html` declares, inside `<StrictMode>`.
 *      `ThemedApp` keeps the theme live after mount: it reads the store with
 *      `useSyncExternalStore(subscribePanelTheme, getPanelThemeSnapshot)`, so
 *      a DevTools theme switch (pushed through `setThemeChangeHandler`, or
 *      found when the panel is shown again) re-renders `App` — and through
 *      `PanelView`, `PanelHost` — with the new theme, and a layout effect
 *      applies the same value to the document root in that commit, before the
 *      browser paints it. StrictMode is kept on deliberately: the connection
 *      lifecycle `App` owns is reference-counted (`state/connection.ts`) and
 *      the theme store's host registration follows its subscriber count, so
 *      the development-only double effect leaves exactly one runtime port and
 *      one theme-change handler, and StrictMode is what keeps every panel
 *      effect honest about that idempotence.
 *
 * ## Failures are visible, never blank
 *
 * The mount element's id is a contract with `./panel.html`. When it is
 * missing, this module throws an `Error` naming the id it expected instead of
 * mounting nowhere: a DevTools tab that stays silently empty is the one failure
 * a developer cannot diagnose (AAP 0.5.5), whereas a thrown error surfaces in
 * the panel's console and in the browser suite's page-error listener.
 *
 * ## Boundaries
 *
 * No state of its own, no runtime port, no message handling, no socket, no
 * `fetch`, no storage, no layout and no error boundary: `./theme` owns the
 * theme store `ThemedApp` reads, `App` owns composition and `state/*` owns the
 * connection and every piece of session state. The imports
 * are the renderer stylesheet, `react`, `react-dom/client`, `./App` and
 * `./theme`; nothing Node-only, nothing from another process's workspace.
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
 * The panel's root component: {@link App}, rendered in the live DevTools theme.
 *
 * The theme comes from the panel document's theme store, so a DevTools theme
 * change after mount re-renders `App` (and, through `PanelView`, `PanelHost`)
 * with the new value. The layout effect writes that same value to the document
 * root during the commit that renders it, so the panel chrome outside
 * `PanelHost` and the generated panel inside it never paint in different token
 * sets. `App`'s contract is unchanged: it receives one `theme` prop.
 */
function ThemedApp(): ReactElement {
  const theme = useSyncExternalStore(subscribePanelTheme, getPanelThemeSnapshot);
  useLayoutEffect(() => {
    applyPanelTheme(theme);
  }, [theme]);
  return <App theme={theme} />;
}

// Theme first — resolved through the store and applied to the document root
// before the React root exists, so the first paint already uses the requested
// token set. `ThemedApp` starts from this same snapshot and follows it.
applyPanelTheme(getPanelThemeSnapshot());

createRoot(findMountElement()).render(
  <StrictMode>
    <ThemedApp />
  </StrictMode>,
);
