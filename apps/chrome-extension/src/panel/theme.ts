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
 *   2. **Translation** — deciding what a host signal *means*. That belongs to
 *      the renderer's `themeFromDevToolsThemeName`, which this module delegates
 *      to verbatim and never re-implements, so the panel and the editor webview
 *      (which translates its own signal through the sibling mapper in the same
 *      module) can never disagree about the three token sets.
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
 * ## Resolved once, at startup
 *
 * `chrome.devtools.panels.themeName` is a read-only value; the DevTools
 * extension API exposes no event announcing a theme change. There is therefore
 * nothing to subscribe to, and this module invents no listener or poll: the
 * theme is resolved once, when the panel document loads, and a DevTools theme
 * changed afterwards is picked up the next time the panel document is loaded.
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
 * No I/O beyond reading that one DevTools value and writing one DOM attribute:
 * no socket, no `fetch`, no HTTP, no storage, no timer. No visual value lives
 * here either (AAP 0.6.4) — every colour, length and font is a token delivered
 * by the renderer's stylesheet. The only imports are `@debuggen/panel-renderer`
 * and the ambient `chrome` global.
 *
 * @example Panel entry point: resolve once, apply to the document root, and
 * hand the same theme to the React tree that mounts `PanelHost`.
 * ```tsx
 * import { applyPanelTheme, resolvePanelTheme } from './theme';
 *
 * const theme = applyPanelTheme(resolvePanelTheme());
 * createRoot(container).render(<App theme={theme} />);
 * ```
 *
 * @module
 */

import {
  DEFAULT_PANEL_THEME,
  PANEL_THEME_ATTRIBUTE,
  panelThemeAttributeValue,
  themeFromDevToolsThemeName,
} from '@debuggen/panel-renderer';
import type { PanelTheme } from '@debuggen/panel-renderer';

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
 * and a future DevTools build may report a name the typings do not list. Every
 * link is therefore optional and the value itself is `unknown`, so the reads
 * below are checked rather than asserted. The `chrome` namespace is assignable
 * to this shape as it stands — no cast is involved anywhere.
 */
interface DevToolsThemeHost {
  readonly devtools?:
    | {
        readonly panels?:
          | {
              readonly themeName?: unknown;
            }
          | undefined;
      }
    | undefined;
}

/**
 * Reads the raw DevTools theme name, or `undefined` when this document has no
 * DevTools host to ask.
 *
 * Each link of `chrome.devtools.panels.themeName` is guarded in turn: the
 * `chrome` global itself (absent outside an extension context), then
 * `devtools`, then `panels`, then the value, which is accepted only as a
 * string. Any exception a host getter might raise propagates to
 * {@link resolvePanelTheme}, which owns the fallback.
 */
function readDevToolsThemeName(): string | undefined {
  if (typeof chrome === 'undefined') {
    return undefined;
  }
  const host: DevToolsThemeHost = chrome;
  const themeName = host.devtools?.panels?.themeName;
  return typeof themeName === 'string' ? themeName : undefined;
}

/**
 * Resolves the theme the panel should render in from the DevTools host.
 *
 * The raw `chrome.devtools.panels.themeName` string is passed straight to the
 * renderer's `themeFromDevToolsThemeName`, so `"dark"` resolves to `dark` and
 * `"default"` — DevTools' name for its light theme — resolves to `light`, by
 * the one mapping both host surfaces share. When `chrome`, `chrome.devtools`,
 * `chrome.devtools.panels` or the name itself is missing, or reading any of them
 * throws, the result is `DEFAULT_PANEL_THEME`.
 *
 * Call it once, at panel startup: DevTools offers no theme-change event to
 * re-resolve on (see the module overview).
 *
 * @returns The theme to apply; never throws.
 */
export function resolvePanelTheme(): PanelTheme {
  let themeName: string | undefined;
  try {
    themeName = readDevToolsThemeName();
  } catch {
    // A host getter that throws is treated exactly like an absent host signal:
    // the panel renders in the default theme rather than failing to start.
    return DEFAULT_PANEL_THEME;
  }
  if (themeName === undefined) {
    return DEFAULT_PANEL_THEME;
  }
  return themeFromDevToolsThemeName(themeName);
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
 * @param theme - The theme to apply, typically from {@link resolvePanelTheme}.
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
