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
 *   2. **The theme, before first paint.** `resolvePanelTheme()` reads the
 *      DevTools theme once and `applyPanelTheme()` writes the renderer's theme
 *      attribute on the document root, synchronously, before the React root is
 *      created. That is what prevents a flash of the wrong token set when the
 *      tab opens, and what lets the panel chrome outside the generated panel's
 *      own theme root (header, connection status, drawer, live tail) resolve
 *      its tokens. Dark is the default token set (AAP 0.6.3), and it is also
 *      what resolution falls back to when `chrome.devtools` is absent — the
 *      browser suite opens this page directly as an extension page (AAP 0.8.3),
 *      so this module adds no `chrome.*` access of its own.
 *   3. **The React root.** React 19's `createRoot` mounts {@link App} into the
 *      element `./panel.html` declares, inside `<StrictMode>`. StrictMode is
 *      kept on deliberately: the connection lifecycle `App` owns is
 *      reference-counted (`state/connection.ts`), so the development-only
 *      double effect leaves exactly one runtime port, and StrictMode is what
 *      keeps every panel effect honest about that idempotence.
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
 * No state, no runtime port, no message handling, no socket, no `fetch`, no
 * storage, no layout and no error boundary: `App` owns composition and
 * `state/*` owns the connection and every piece of session state. The imports
 * are the renderer stylesheet, `react`, `react-dom/client`, `./App` and
 * `./theme`; nothing Node-only, nothing from another process's workspace.
 *
 * @module apps/chrome-extension/src/panel/main
 */

import '@debuggen/panel-renderer/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { applyPanelTheme, resolvePanelTheme } from './theme';

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

// Theme first — resolved once and applied to the document root before the
// React root exists, so the first paint already uses the requested token set.
const theme = resolvePanelTheme();
applyPanelTheme(theme);

createRoot(findMountElement()).render(
  <StrictMode>
    <App theme={theme} />
  </StrictMode>,
);
