/**
 * Design tokens — the single source of truth for every visual value in this
 * design system (AAP 0.6.1, 0.6.3).
 *
 * No third-party component library or design system is used, so this module
 * *is* the value layer: every colour, space, font, weight, radius, shadow,
 * focus ring, motion duration, easing function and stacking level that either
 * host surface renders resolves to a `--dg-*` custom property whose value
 * originates here, once. Nothing downstream may define a colour, a metric or a
 * motion constant of its own: AAP 0.6.4 permits only the literals `0`, `none`,
 * `auto`, `inherit`, `currentColor` and `transparent` in a component, so a
 * value that is missing here has no legal way to be expressed — the fix is to
 * add it here, never to inline it in a component.
 *
 * There is likewise no second namespace and no "internal constant" escape
 * hatch. A value declared beside these — under any other prefix, in any other
 * file — sits outside the drift, completeness, theme and contrast checks that
 * are the only reason this table can be trusted, and it takes whatever consumes
 * it outside them too.
 *
 * ## The generated stylesheet
 *
 * The sibling `src/tokens/tokens.css` is GENERATED from this module by
 * `scripts/build-tokens.mjs` (this package's `prebuild` step) and must never be
 * hand-edited: its bytes are compared against a fresh regeneration by
 * `src/tokens/tokens.test.ts`, and it is deliberately exempt from Prettier and
 * ESLint so that comparison is meaningful. The generator emits three selector
 * blocks — `:root` for `dark`, `[data-theme="light"]` for `light` and
 * `[data-theme="high-contrast"]` for `highContrast` — each declaring every
 * token, in the key order of the dark set below. **That insertion order is a
 * contract**: reordering a key silently rewrites the stylesheet.
 *
 * ## Why this file looks so plain
 *
 * The generator imports this module directly and runs it under the runtime's
 * built-in type stripping, which makes two constraints absolute:
 *
 *   1. **Erasable syntax only** — type aliases, interfaces, `as const`,
 *      `satisfies`, `export type`. No `enum`, no `namespace`, no constructor
 *      parameter properties, no decorators.
 *   2. **No imports at all**, not even `import type`. This module is a leaf:
 *      everything it needs, it declares. In particular it must never import
 *      from `../utils/color`, which imports `TokenKey`, `cssVar` and
 *      `cssVarName` from here — that edge is one-way, and a cycle would break
 *      type stripping as well as the layering.
 *
 * It is also free of side effects: importing it reads nothing, writes nothing
 * and touches no global.
 *
 * ## Themes
 *
 * `dark` is the product default. `light` is a complete second value set, not a
 * set of overrides. `highContrast` is the dark set with exactly three
 * deltas — borders raised to the primary text colour, a 2 px focus ring, and
 * no elevation shadows — and is byte-identical to `dark` everywhere else; the
 * token test asserts precisely that, so no other high-contrast value may vary.
 *
 * The colour values are load-bearing rather than decorative: the WCAG ratios
 * the token test pins (worst dark text pair 5.09:1, worst light text pair
 * 4.82:1, worst status-as-text 4.86:1, worst span-kind fill 3.21:1 with a
 * margin of only 0.21) were computed against these exact values. Re-picking or
 * rounding one is a product-wide accessibility regression.
 */

/**
 * The dark value set — the default theme, emitted as the stylesheet's `:root`
 * block. This object is also the canonical key list and the canonical key
 * *order* for all three themes and for the generated CSS.
 */
const darkTokens = {
  // --- Surfaces -------------------------------------------------------------
  /** Page background of a panel. */
  surfaceBase: '#0f1115',
  /** Cards, tables and the details drawer. */
  surfaceElevated: '#161a22',
  /** Tooltips and menus; the darkest surface text is measured against. */
  surfaceOverlay: '#1d2230',

  // --- Borders --------------------------------------------------------------
  /** Dividers and default control outlines. */
  borderSubtle: '#262c3a',
  /** Emphasised separation, such as a table header rule. */
  borderStrong: '#3a4356',

  // --- Text -----------------------------------------------------------------
  /** Body and heading text. */
  textPrimary: '#e6e9f0',
  /** Labels and supporting text. */
  textSecondary: '#a6adbd',
  /** De-emphasised metadata; the lowest-contrast permitted text colour. */
  textMuted: '#8a92a6',

  // --- Accent ---------------------------------------------------------------
  /** Selection, focus ring and links. */
  accent: '#6ea8ff',
  /** Selected-row and active-chip fill behind accent-coloured content. */
  accentMuted: '#2b4470',

  // --- Status ---------------------------------------------------------------
  success: '#3ecf8e',
  warning: '#f5b83d',
  danger: '#ff6b6b',
  info: '#7dd3fc',

  // --- Span kinds -----------------------------------------------------------
  // The categorical scale for timeline lanes, hierarchy blocks and graph
  // nodes. Used as fills carrying text labels, so the scale is held to the
  // 3:1 bar rather than the 4.5:1 text bar.
  kindInteraction: '#c084fc',
  kindRender: '#60a5fa',
  kindFetch: '#34d399',
  kindHttp: '#fbbf24',
  kindFunction: '#f97316',
  kindDb: '#f472b6',
  kindError: '#ef4444',

  // --- Duration severity ----------------------------------------------------
  // Real aliases rather than duplicated colour values: each severity step
  // points at the token it is defined as, so every theme stays in sync by
  // construction. The bucket boundaries that choose between them live in
  // `src/utils/color.ts`, not here.
  /** Alias of the muted text colour. */
  durationFast: 'var(--dg-text-muted)',
  /** Alias of the primary text colour. */
  durationNormal: 'var(--dg-text-primary)',
  /** Alias of the warning colour. */
  durationSlow: 'var(--dg-warning)',
  /** Alias of the danger colour. */
  durationCritical: 'var(--dg-danger)',

  // --- Spacing --------------------------------------------------------------
  // A dense scale: these surfaces show dense, data-heavy views.
  space0: '2px',
  space1: '4px',
  space2: '6px',
  space3: '8px',
  space4: '12px',
  space5: '16px',
  space6: '20px',
  space7: '24px',

  // --- Typography -----------------------------------------------------------
  /** Interface font stack. */
  fontUi: '-apple-system, "Segoe UI", Inter, sans-serif',
  /**
   * Monospace stack for code, statements, paths and numeric columns. Contexts
   * that use it also declare `font-variant-numeric: tabular-nums`, which is a
   * CSS keyword declaration applied in `src/styles` and in the primitives that
   * render code and durations — deliberately not a token of its own.
   */
  fontMono: '"JetBrains Mono", "SF Mono", Menlo, monospace',
  /**
   * The raised interface weight, as a weight on its own.
   *
   * The type roles below are complete `font` shorthands, and the shorthand
   * RESETS weight — so a rule that wants a role's size and line-height but a
   * heavier face has to restate the weight in a declaration of its own. That
   * declaration needs a token, because a numeral written in a stylesheet is a
   * visual value outside this table and AAP 0.6.4 admits none. This is that
   * token, and it is the same weight the `textLg` role carries; the token test
   * pins the two together so they cannot drift apart.
   */
  fontWeightMedium: '500',
  // Type roles are complete `font` shorthands, so a rule can set a role with
  // one declaration: `font: var(--dg-text-sm);`.
  textXs: '400 11px/16px var(--dg-font-ui)',
  textSm: '400 12px/16px var(--dg-font-ui)',
  textMd: '400 13px/18px var(--dg-font-ui)',
  textLg: '500 15px/20px var(--dg-font-ui)',
  heading: '600 16px/22px var(--dg-font-ui)',
  /** Monospace role; weight stated because the shorthand requires it. */
  monoSm: '400 11px/16px var(--dg-font-mono)',
  /** Monospace role; weight stated because the shorthand requires it. */
  monoMd: '400 12px/16px var(--dg-font-mono)',

  // --- Radius ---------------------------------------------------------------
  radiusSm: '2px',
  radiusMd: '4px',
  radiusLg: '6px',

  // --- Elevation ------------------------------------------------------------
  shadow0: 'none',
  shadow1: '0 1px 2px rgba(0, 0, 0, 0.4)',
  shadow2: '0 4px 12px rgba(0, 0, 0, 0.5)',

  // --- Focus ----------------------------------------------------------------
  /** Applied through `:focus-visible`, so pointer clicks show no ring. */
  focusRing: '1px solid var(--dg-accent)',

  // --- Motion ---------------------------------------------------------------
  // Motion is a design decision like any other, so it is stated here rather
  // than in a stylesheet: every transition and animation in `src/styles`
  // resolves its duration and easing to one of these three, which is what keeps
  // hover, focus and selection feedback consistent across every component and
  // keeps the values inside the drift, completeness and theme checks the token
  // test applies to the rest of the table. `@media (prefers-reduced-motion:
  // reduce)` in `src/styles/base.css` switches motion off wholesale and is
  // unaffected by these values.
  /** One interactive state transition — hover, focus, selection. */
  motionDuration: '160ms',
  /** Decelerating easing for feedback that settles rather than overshoots. */
  motionEasing: 'ease-out',
  /** One sweep of a loading skeleton's shimmer. */
  shimmerDuration: '1200ms',

  // --- Stacking -------------------------------------------------------------
  zBase: '0',
  zOverlay: '100',
  zTooltip: '200',
} as const;

/**
 * Every token name, derived from the dark set so the union can never drift
 * from the values that back it.
 */
export type TokenKey = keyof typeof darkTokens;

/**
 * One theme's complete flat value map.
 *
 * A `Record` over the finite key union rather than an index signature: under
 * `noUncheckedIndexedAccess` a lookup with a `TokenKey` therefore yields
 * `string` instead of `string | undefined`, and annotating a theme with this
 * type makes a missing key a compile error and a misspelled key an excess
 * property.
 */
export type TokenValues = Readonly<Record<TokenKey, string>>;

/**
 * The light value set — a complete second palette, emitted under
 * `[data-theme="light"]`. Theme-invariant families (spacing, font stacks, type
 * roles, radii, duration aliases and stacking levels) repeat the dark values
 * verbatim, which is what lets the generator emit three self-contained blocks
 * and lets the token test assert those families are identical.
 */
const lightTokens: TokenValues = {
  // --- Surfaces -------------------------------------------------------------
  surfaceBase: '#ffffff',
  surfaceElevated: '#f4f6fa',
  surfaceOverlay: '#e9edf3',

  // --- Borders --------------------------------------------------------------
  borderSubtle: '#d9dee7',
  borderStrong: '#b6bfcc',

  // --- Text -----------------------------------------------------------------
  textPrimary: '#16191f',
  textSecondary: '#4b5563',
  textMuted: '#5f677a',

  // --- Accent ---------------------------------------------------------------
  accent: '#1f5fd6',
  accentMuted: '#dbe7ff',

  // --- Status ---------------------------------------------------------------
  success: '#146c3f',
  warning: '#8a5a00',
  danger: '#c22b2b',
  info: '#0b6aa8',

  // --- Span kinds -----------------------------------------------------------
  // The tightest contrast in the whole system sits in this group: the fetch
  // fill measures 3.21:1 on the light overlay surface, a margin of 0.21 over
  // the 3:1 bar. No value here may be adjusted.
  kindInteraction: '#7c3aed',
  kindRender: '#2563eb',
  kindFetch: '#059669',
  kindHttp: '#b45309',
  kindFunction: '#c2410c',
  kindDb: '#be185d',
  kindError: '#dc2626',

  // --- Duration severity ----------------------------------------------------
  durationFast: 'var(--dg-text-muted)',
  durationNormal: 'var(--dg-text-primary)',
  durationSlow: 'var(--dg-warning)',
  durationCritical: 'var(--dg-danger)',

  // --- Spacing --------------------------------------------------------------
  space0: '2px',
  space1: '4px',
  space2: '6px',
  space3: '8px',
  space4: '12px',
  space5: '16px',
  space6: '20px',
  space7: '24px',

  // --- Typography -----------------------------------------------------------
  fontUi: '-apple-system, "Segoe UI", Inter, sans-serif',
  fontMono: '"JetBrains Mono", "SF Mono", Menlo, monospace',
  fontWeightMedium: '500',
  textXs: '400 11px/16px var(--dg-font-ui)',
  textSm: '400 12px/16px var(--dg-font-ui)',
  textMd: '400 13px/18px var(--dg-font-ui)',
  textLg: '500 15px/20px var(--dg-font-ui)',
  heading: '600 16px/22px var(--dg-font-ui)',
  monoSm: '400 11px/16px var(--dg-font-mono)',
  monoMd: '400 12px/16px var(--dg-font-mono)',

  // --- Radius ---------------------------------------------------------------
  radiusSm: '2px',
  radiusMd: '4px',
  radiusLg: '6px',

  // --- Elevation ------------------------------------------------------------
  // Same geometry as dark, tinted for a light background.
  shadow0: 'none',
  shadow1: '0 1px 2px rgba(16, 24, 40, 0.08)',
  shadow2: '0 4px 12px rgba(16, 24, 40, 0.16)',

  // --- Focus ----------------------------------------------------------------
  focusRing: '1px solid var(--dg-accent)',

  // --- Motion ---------------------------------------------------------------
  motionDuration: '160ms',
  motionEasing: 'ease-out',
  shimmerDuration: '1200ms',

  // --- Stacking -------------------------------------------------------------
  zBase: '0',
  zOverlay: '100',
  zTooltip: '200',
};

/**
 * The high-contrast value set, emitted under `[data-theme="high-contrast"]`.
 *
 * It is the dark set with exactly three deltas, and the token test asserts
 * every other key is byte-identical to `dark`:
 *
 *   1. both border colours are raised to the primary text colour;
 *   2. the focus ring is 2 px instead of 1 px;
 *   3. elevation shadows are removed, so separation is carried by borders.
 *
 * The colours are therefore dark's colours, which is why its contrast ratios
 * equal dark's and need no separate verification.
 */
const highContrastTokens: TokenValues = {
  // --- Surfaces (as dark) ---------------------------------------------------
  surfaceBase: '#0f1115',
  surfaceElevated: '#161a22',
  surfaceOverlay: '#1d2230',

  // --- Borders (delta 1: raised to the primary text colour) -----------------
  borderSubtle: '#e6e9f0',
  borderStrong: '#e6e9f0',

  // --- Text (as dark) -------------------------------------------------------
  textPrimary: '#e6e9f0',
  textSecondary: '#a6adbd',
  textMuted: '#8a92a6',

  // --- Accent (as dark) -----------------------------------------------------
  accent: '#6ea8ff',
  accentMuted: '#2b4470',

  // --- Status (as dark) -----------------------------------------------------
  success: '#3ecf8e',
  warning: '#f5b83d',
  danger: '#ff6b6b',
  info: '#7dd3fc',

  // --- Span kinds (as dark) -------------------------------------------------
  kindInteraction: '#c084fc',
  kindRender: '#60a5fa',
  kindFetch: '#34d399',
  kindHttp: '#fbbf24',
  kindFunction: '#f97316',
  kindDb: '#f472b6',
  kindError: '#ef4444',

  // --- Duration severity (as dark) ------------------------------------------
  durationFast: 'var(--dg-text-muted)',
  durationNormal: 'var(--dg-text-primary)',
  durationSlow: 'var(--dg-warning)',
  durationCritical: 'var(--dg-danger)',

  // --- Spacing (as dark) ----------------------------------------------------
  space0: '2px',
  space1: '4px',
  space2: '6px',
  space3: '8px',
  space4: '12px',
  space5: '16px',
  space6: '20px',
  space7: '24px',

  // --- Typography (as dark) -------------------------------------------------
  fontUi: '-apple-system, "Segoe UI", Inter, sans-serif',
  fontMono: '"JetBrains Mono", "SF Mono", Menlo, monospace',
  fontWeightMedium: '500',
  textXs: '400 11px/16px var(--dg-font-ui)',
  textSm: '400 12px/16px var(--dg-font-ui)',
  textMd: '400 13px/18px var(--dg-font-ui)',
  textLg: '500 15px/20px var(--dg-font-ui)',
  heading: '600 16px/22px var(--dg-font-ui)',
  monoSm: '400 11px/16px var(--dg-font-mono)',
  monoMd: '400 12px/16px var(--dg-font-mono)',

  // --- Radius (as dark) -----------------------------------------------------
  radiusSm: '2px',
  radiusMd: '4px',
  radiusLg: '6px',

  // --- Elevation (delta 3: no elevation shadows) ----------------------------
  shadow0: 'none',
  shadow1: 'none',
  shadow2: 'none',

  // --- Focus (delta 2: a 2 px ring) -----------------------------------------
  focusRing: '2px solid var(--dg-accent)',

  // --- Motion (as dark) -----------------------------------------------------
  // Reducing motion is a user preference rather than a theme, so the
  // high-contrast set carries the default durations and the
  // `prefers-reduced-motion` block in `src/styles/base.css` remains the one
  // place motion is switched off.
  motionDuration: '160ms',
  motionEasing: 'ease-out',
  shimmerDuration: '1200ms',

  // --- Stacking (as dark) ---------------------------------------------------
  zBase: '0',
  zOverlay: '100',
  zTooltip: '200',
};

/**
 * The three complete value sets of the design system.
 *
 * `src/tokens/theme.ts` derives its theme union as `keyof DesignTokens`, so
 * these three keys are theme identity for the whole package: adding a fourth
 * becomes a compile error there until its attribute mapping is supplied, and
 * the stylesheet generator emits one selector block per key.
 */
export interface DesignTokens {
  /** Default theme; the stylesheet's `:root` block. */
  readonly dark: TokenValues;
  /** Emitted under `[data-theme="light"]`. */
  readonly light: TokenValues;
  /** Emitted under `[data-theme="high-contrast"]`. */
  readonly highContrast: TokenValues;
}

/**
 * The design system's token table: the value every `--dg-*` custom property
 * is generated from, in every theme.
 *
 * Key order within a theme is the generated stylesheet's declaration order and
 * is therefore part of the committed artifact.
 */
export const DESIGN_TOKENS: DesignTokens = {
  dark: darkTokens,
  light: lightTokens,
  highContrast: highContrastTokens,
};

/**
 * The same table under the name the stylesheet generator looks for.
 *
 * `scripts/build-tokens.mjs` loads this module and reads its `tokens` export;
 * `DESIGN_TOKENS` is the canonical name every other consumer imports. This is
 * an alias to the identical object, not a second copy — there is exactly one
 * token table.
 */
export const tokens: DesignTokens = DESIGN_TOKENS;

/**
 * The custom property name a token is emitted as, for example
 * `surfaceBase` → `--dg-surface-base` and `space0` → `--dg-space-0`.
 *
 * The conversion inserts a boundary before each uppercase letter *and* before
 * each digit that follows a letter, then lowercases the result. The digit
 * boundary is the case a plain camel-to-kebab rule gets wrong: it would yield
 * `--dg-space0` and `--dg-shadow1`, which match nothing in the stylesheet.
 *
 * This is the same mapping the stylesheet generator applies, and the token
 * test asserts the two agree for every key.
 */
export function cssVarName(key: TokenKey): string {
  const kebab = key.replace(/([A-Z])/g, '-$1').replace(/([A-Za-z])(\d)/g, '$1-$2');
  return `--dg-${kebab.toLowerCase()}`;
}

/**
 * A token as a CSS value reference, for example
 * `cssVar('surfaceBase')` → `var(--dg-surface-base)`.
 *
 * This is how inline geometry computed in TypeScript — a scale, a lane offset,
 * a severity colour — reaches the stylesheet's values without any component
 * restating one (AAP 0.6.4).
 */
export function cssVar(key: TokenKey): string {
  return `var(${cssVarName(key)})`;
}
