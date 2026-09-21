/**
 * Theme identity and the `data-theme` contract of the design system
 * (AAP 0.6.1, 0.6.3).
 *
 * `src/tokens/tokens.ts` holds three complete token value sets — `dark`, which
 * is the product default and the stylesheet's `:root` block, `light`, and
 * `highContrast`, which exists to serve accessibility (AAP 0.6.4). This module
 * owns everything *about* those three as identities rather than as values:
 *
 *   1. **The theme union.** `PanelTheme` is `keyof DesignTokens`, so theme
 *      identity is structurally locked to the token table. A fourth value set
 *      cannot be added to the tokens without this module failing to compile
 *      until its attribute mapping is supplied — the alternative, a hand-kept
 *      union, would let a surface render unstyled instead.
 *   2. **The `data-theme` contract.** One attribute name and one attribute
 *      value per theme, matching the selectors the generated stylesheet
 *      declares. `src/layout/PanelShell.tsx` is the only module that writes the
 *      attribute; every component below it simply reads `--dg-*` values.
 *   3. **The two host mappings.** The Chrome DevTools panel and the VS Code
 *      webview reach the same three token sets through entirely different host
 *      signals. *Detection* belongs to those consumers, because they own the
 *      Chrome and VS Code APIs — `apps/chrome-extension/src/panel/theme.ts`
 *      reads `chrome.devtools.panels.themeName`, and
 *      `apps/vscode-extension/src/webview/theme.ts` reads the body element's
 *      class list. The *translation* lives here so the two surfaces cannot
 *      disagree about what a signal means (AAP 0.7.3).
 *
 * Consequently this module touches no host global (no `chrome`, no
 * `acquireVsCodeApi`, no `window`, no `document`), performs no DOM write, and
 * has no side effects: both mappings are pure, total string translations that
 * answer with the default theme rather than throwing on input they do not
 * recognise. That is what lets them be unit-tested with no host stubs and what
 * keeps this module safe in either bundle.
 */

import type { DesignTokens } from './tokens';

/**
 * The themes of the design system, derived from the token table so the union
 * can never drift from the value sets that back it.
 *
 * Note the casing: these are the token table's property names
 * (`highContrast`), not the kebab-case strings that appear in the DOM — those
 * are {@link PANEL_THEME_ATTRIBUTE_VALUES}.
 */
export type PanelTheme = keyof DesignTokens;

/**
 * The themes in presentation order, default first.
 *
 * Written out as a literal tuple rather than derived from the token table with
 * `Object.keys(...) as PanelTheme[]`: that cast would assert the relationship
 * instead of checking it, which is the one thing this list must not do. The
 * tuple is verified in both directions instead — `satisfies` rejects a name
 * that is not a theme, {@link UnlistedPanelThemes} rejects a theme the tuple
 * omits, and `src/tokens/tokens.test.ts` additionally compares this array with
 * the runtime keys of the token table.
 */
const PANEL_THEME_TUPLE = [
  'dark',
  'light',
  'highContrast',
] as const satisfies readonly PanelTheme[];

/**
 * Constrains its argument to `never`, so that instantiating it with anything
 * else is a compile error. Used immediately below as an exhaustiveness proof.
 */
type AssertNever<T extends never> = T;

/**
 * Compile-time proof that {@link PANEL_THEME_TUPLE} lists every theme.
 *
 * A fourth value set added to the token table makes the `Exclude` below resolve
 * to that theme's name rather than `never`, which violates `AssertNever`'s
 * constraint and fails the typecheck here — beside the tuple that needs
 * extending — instead of silently shipping a theme no selector can reach.
 */
export type UnlistedPanelThemes = AssertNever<
  Exclude<PanelTheme, (typeof PANEL_THEME_TUPLE)[number]>
>;

/** Every theme of the design system, default first. */
export const PANEL_THEMES: readonly PanelTheme[] = PANEL_THEME_TUPLE;

/**
 * The theme a surface renders when nothing else has been established: dark mode
 * is the product default (AAP 0.6.3), and it is also the value set the
 * generated stylesheet emits under `:root`, so it needs no selector to apply.
 *
 * Both host mappings below fall back to this value, which is why neither can
 * fail: an unrecognised, absent or empty host signal is a styled surface in the
 * default theme, never an unstyled one.
 */
export const DEFAULT_PANEL_THEME: PanelTheme = 'dark';

/**
 * The attribute `src/layout/PanelShell.tsx` sets on the panel root to select a
 * theme, and the attribute the generated stylesheet's theme blocks select on.
 */
export const PANEL_THEME_ATTRIBUTE = 'data-theme';

/**
 * The DOM value of each theme.
 *
 * These strings are a contract with the generated stylesheet: `light` and
 * `highContrast` must equal the values inside its `[data-theme="light"]` and
 * `[data-theme="high-contrast"]` selectors exactly (AAP 0.6.1), and
 * `src/tokens/tokens.test.ts` asserts that the selectors built from this map
 * occur in `src/tokens/tokens.css`.
 *
 * `dark` is mapped even though the stylesheet serves it from `:root` and
 * therefore declares no `[data-theme="dark"]` block: writing the attribute for
 * every theme keeps `PanelShell` branch-free and makes the applied theme
 * observable in the DOM — and assertable in a test — rather than inferable only
 * from the absence of an attribute.
 *
 * The `Record<PanelTheme, string>` annotation is load-bearing. It is what turns
 * a new theme in the token table into a compile error in this file instead of a
 * surface that renders with no token values at all.
 */
export const PANEL_THEME_ATTRIBUTE_VALUES: Readonly<Record<PanelTheme, string>> = {
  dark: 'dark',
  light: 'light',
  highContrast: 'high-contrast',
};

/**
 * The `data-theme` value for a theme — the lookup `PanelShell` performs when it
 * applies a theme to the panel root.
 *
 * Indexing {@link PANEL_THEME_ATTRIBUTE_VALUES} with a `PanelTheme` is total
 * (the record is keyed by the finite union, so `noUncheckedIndexedAccess` does
 * not widen the result to `string | undefined`); an arbitrary string must go
 * through {@link panelThemeFromAttributeValue} instead.
 */
export function panelThemeAttributeValue(theme: PanelTheme): string {
  return PANEL_THEME_ATTRIBUTE_VALUES[theme];
}

/**
 * The theme a `data-theme` value denotes — the inverse of
 * {@link panelThemeAttributeValue}, for reading back an attribute a host or an
 * earlier render set.
 *
 * Total, like every mapping in this module: an absent, empty or unrecognised
 * value answers {@link DEFAULT_PANEL_THEME}. The scan avoids a second literal
 * map, so the two directions cannot disagree.
 */
export function panelThemeFromAttributeValue(value: string | null | undefined): PanelTheme {
  if (value === null || value === undefined) {
    return DEFAULT_PANEL_THEME;
  }
  for (const theme of PANEL_THEMES) {
    if (PANEL_THEME_ATTRIBUTE_VALUES[theme] === value) {
      return theme;
    }
  }
  return DEFAULT_PANEL_THEME;
}

/**
 * The theme a Chrome DevTools theme name denotes.
 *
 * The values are those of `chrome.devtools.panels.themeName`, which the
 * DevTools panel passes straight through: `"dark"` for the dark theme and
 * `"default"` for the light one. The literal `"light"` is accepted as well,
 * defensively — it is not a documented value, but it is the name a reader would
 * expect and costs one comparison to honour.
 *
 * DevTools exposes no high-contrast theme name, so `highContrast` is
 * unreachable from this input by design; VS Code is the surface that can select
 * it (see {@link themeFromVsCodeBodyClass}).
 *
 * Anything else — an unknown name, the empty string, `null` or `undefined` from
 * a DevTools build that predates the property — answers
 * {@link DEFAULT_PANEL_THEME}.
 */
export function themeFromDevToolsThemeName(name: string | null | undefined): PanelTheme {
  switch (name) {
    case 'dark':
      return 'dark';
    case 'default':
    case 'light':
      return 'light';
    default:
      return DEFAULT_PANEL_THEME;
  }
}

/**
 * The theme a VS Code webview body class list denotes.
 *
 * VS Code marks the webview's body element with `vscode-light`, `vscode-dark`,
 * `vscode-high-contrast` or, for the light high-contrast theme,
 * `vscode-high-contrast` *and* `vscode-high-contrast-light` together — amongst
 * unrelated classes and in no guaranteed order. Both accepted input shapes come
 * from that element: a raw `className` string, and an iterable of class names,
 * which a `DOMTokenList` (`body.classList`) satisfies.
 *
 * Matching is by exact token against the split set, most specific first, and
 * never by substring: `vscode-high-contrast-light` *contains*
 * `vscode-high-contrast` and the substring `light`, so a substring test would
 * resolve the light high-contrast theme to the wrong value set and quietly
 * withdraw the high-contrast theme from the users who need it (AAP 0.6.4).
 *
 * Both high-contrast classes therefore answer `highContrast` — the token set
 * that raises borders to the primary text colour, thickens the focus ring and
 * removes elevation shadows — and anything unrecognised answers
 * {@link DEFAULT_PANEL_THEME}.
 */
export function themeFromVsCodeBodyClass(
  input: string | Iterable<string> | null | undefined,
): PanelTheme {
  const classNames = classNameTokens(input);

  // Most specific first. The light high-contrast theme is matched before the
  // plain high-contrast class it accompanies, and both before `vscode-light`,
  // which a high-contrast light theme may also carry.
  if (classNames.has('vscode-high-contrast-light')) {
    return 'highContrast';
  }
  if (classNames.has('vscode-high-contrast')) {
    return 'highContrast';
  }
  if (classNames.has('vscode-light')) {
    return 'light';
  }
  if (classNames.has('vscode-dark')) {
    return 'dark';
  }
  return DEFAULT_PANEL_THEME;
}

/** Splits class names on runs of whitespace, as the DOM itself tokenises them. */
const CLASS_NAME_SEPARATOR = /\s+/;

/**
 * Normalises either accepted class-list shape into a set of non-empty tokens.
 *
 * Each iterated item is split as well, so a single-element iterable holding a
 * whole `className` tokenises correctly, and a non-string item — possible when
 * an untyped host value reaches this boundary — is skipped rather than thrown
 * on, which keeps the exported mapping total.
 */
function classNameTokens(input: string | Iterable<string> | null | undefined): ReadonlySet<string> {
  const classNames = new Set<string>();
  if (input === null || input === undefined) {
    return classNames;
  }

  const items: Iterable<string> = typeof input === 'string' ? [input] : input;
  for (const item of items) {
    if (typeof item !== 'string') {
      continue;
    }
    for (const token of item.split(CLASS_NAME_SEPARATOR)) {
      if (token.length > 0) {
        classNames.add(token);
      }
    }
  }
  return classNames;
}
