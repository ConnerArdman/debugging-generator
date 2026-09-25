/**
 * Entry module of the "Debug Generator" VS Code webview: the single `dist/webview/main.js` that
 * `src/views/session-view-provider.ts` loads under its nonce'd content-security policy. It imports
 * the design system's stylesheet, then this surface's own, then the strict-CSP runtime options;
 * applies the editor theme before first paint; mounts `App` into `#root`, throwing a named error
 * instead of leaving a blank view when the element is missing (AAP 0.5.5); and posts the one-shot
 * `ready` handshake. Nothing else lives here.
 *
 * @module apps/vscode-extension/src/webview/main
 */

// ORDER IS LOAD-BEARING: never reorder, merge or sort these two imports. The first brings the
// generated `--dg-*` tokens plus the design system's base and component styles — the renderer's JS
// barrel deliberately imports no CSS, so without it every `var(--dg-*)` resolves to nothing. The
// second is this surface's `dgv-*` layout, authored to sit on top of it. Vite emits both into the
// single `dist/webview/main.css` in exactly this order.
import '@debuggen/panel-renderer/styles.css';
import './styles.css';

// First JavaScript import, and it must stay first: it sets the strict-CSP runtime options (Zod's
// `jitless`) before `./App`'s dependency graph builds a single schema. Moving it below `./App`
// brings back an eval probe that the webview's policy reports as a violation on every load.
import './csp-runtime';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import type { WebviewToHostMessageOf } from '../webview-messages';

import { App } from './App';
import { applyWebviewTheme, resolveWebviewTheme } from './theme';
import { postToHost } from './vscode-api';

/**
 * The id of the mount element in the webview document. The document is composed by
 * `src/views/session-view-provider.ts`, which owns the HTML (and `styles.css` treats `#root` as the
 * same cross-file contract); renaming it there without renaming it here fails loudly at start-up.
 */
const WEBVIEW_ROOT_ELEMENT_ID = 'root';

/** The `name` of the error thrown when the mount element is missing, so it reads unambiguously. */
const MOUNT_ERROR_NAME = 'DebugGeneratorWebviewMountError';

/**
 * The handshake. The host answers it with the current `WebviewState` snapshot, which
 * `./vscode-api` buffers until `App` subscribes; the message carries no payload by contract.
 */
const READY_MESSAGE: WebviewToHostMessageOf<'ready'> = { type: 'ready' };

/**
 * Finds the webview document's mount element.
 *
 * @throws Error named {@link MOUNT_ERROR_NAME} when the document has no element with id
 *   {@link WEBVIEW_ROOT_ELEMENT_ID}, so a broken document is a reported start-up failure in the
 *   webview developer tools rather than a silently blank view. It never mounts into an element of
 *   its own making: that would hide the broken provider HTML behind a view that seems to work.
 */
function findMountElement(): HTMLElement {
  const container = document.getElementById(WEBVIEW_ROOT_ELEMENT_ID);
  if (container === null) {
    const error = new Error(
      `Debug Generator webview: mount element #${WEBVIEW_ROOT_ELEMENT_ID} was not found. The ` +
        `webview HTML composed by src/views/session-view-provider.ts must contain ` +
        `<div id="${WEBVIEW_ROOT_ELEMENT_ID}"></div> before its module script.`,
    );
    error.name = MOUNT_ERROR_NAME;
    throw error;
  }
  return container;
}

// Theme first — resolved from the editor's body class and applied to the document root before the
// React root exists, so the first paint already uses the editor's token set. `App` keeps it live
// afterwards through `useWebviewTheme()`, which is not a substitute for this pre-paint write.
applyWebviewTheme(resolveWebviewTheme());

createRoot(findMountElement()).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Exactly once, from module scope and never from an effect: StrictMode double-invokes effects in
// development, which would hand the host two handshakes. Posting before React finishes mounting is
// safe because `./vscode-api` listens eagerly and replays the reply to `App`'s first subscription.
// A `false` result means there is no host channel, which `App` already renders as its own
// no-channel state, so no second failure path is added here.
postToHost(READY_MESSAGE);
