/**
 * The token gate — the suite that keeps the design system's value layer honest
 * (AAP 0.6.1, 0.6.3, 0.6.4).
 *
 * `src/tokens/tokens.ts` is the single source of truth for every visual value,
 * `scripts/build-tokens.mjs` projects it into the committed
 * `src/tokens/tokens.css`, and `src/tokens/theme.ts` owns theme identity and
 * the `data-theme` contract that binds both host surfaces to the generated
 * selectors. Nothing else in this package may state a colour or a metric, so
 * those three modules and one stylesheet are the whole visual contract — and
 * four independent things can go wrong with it. This suite covers each:
 *
 *   1. **Drift.** The stylesheet is regenerated in memory and compared byte for
 *      byte with the committed file, so a hand edit, a stale artifact or a
 *      token value changed without rerunning the generator fails here instead
 *      of shipping a stylesheet that disagrees with the module every component
 *      reads. Naming agreement between `cssVarName` and the generator's
 *      `toCssPropertyName` belongs to the same contract, as does the exact set
 *      of custom properties every theme block declares.
 *   2. **Completeness.** All three value sets declare every token with a usable
 *      value, the high-contrast set differs from the default set in exactly the
 *      documented deltas, the duration steps stay aliases rather than copies,
 *      and the theme-invariant families stay invariant. A theme that silently
 *      inherits the default block's values is the failure this prevents.
 *   3. **Contrast.** Every text/surface and status/surface pair of every theme
 *      is measured and held to the text minimum, and the span-kind scale — used
 *      as fills that carry their own text labels — to the non-text minimum,
 *      with the figures AAP 0.6.3 publishes pinned so a change in the
 *      arithmetic stays distinguishable from a change in the palette.
 *      Accessibility outranks visual fidelity (AAP 0.6.4), so no threshold here
 *      is ever relaxed to make a colour pass: the colour changes instead.
 *   4. **Theme mapping.** The two host signals — the DevTools theme name and
 *      the VS Code webview body class list — translate to the three themes, and
 *      the light high-contrast class resolves to the high-contrast value set
 *      rather than to the light one. That last case is a substring trap with a
 *      real cost: getting it wrong withdraws the high-contrast theme from the
 *      people who asked for it.
 *
 * `pnpm test` is part of the blocking `verify` chain (AAP 0.8.5), so every
 * assertion below is a hard requirement rather than advice, and the suite is
 * deterministic: it reads one committed file, regenerates one string in memory,
 * and touches no network, no clock and no build output.
 *
 * ## Why this file may read from disk
 *
 * It is the only module in this folder permitted to import `node:*`.
 * `packages/panel-renderer/tsconfig.json` carries `types: ["node"]` for this
 * suite alone, and tsup's `platform: "browser"` build fails on a Node builtin
 * anywhere in the shipped import graph, which is what stops the permission from
 * spreading: test files are not build inputs. Every path is resolved from
 * `import.meta.url` rather than from `process.cwd()`, because the working
 * directory differs between a repository-root run and a `pnpm --filter` run.
 *
 * ## How the generator is loaded, and why that looks indirect
 *
 * `renderTokensCss` and `toCssPropertyName` are named exports of
 * `scripts/build-tokens.mjs` precisely so this suite can regenerate the
 * stylesheet in memory. Three things stand between that intent and a plain
 * import, each established here by measurement rather than assumption:
 *
 *   * A static import of an untyped `.mjs` fails the typecheck gate, so the
 *     specifier has to be non-literal — hence a dynamic import of a computed
 *     file URL, with a precise local type for the two functions used.
 *   * The Vitest project for this package runs under happy-dom, whose web-mode
 *     transform prepends its own client import to any module it processes. The
 *     generator is a command-line script whose first line is a `#!` shebang,
 *     and an import ahead of a shebang is a syntax error, so that transform
 *     cannot process it at all.
 *   * A byte-identical copy under `node_modules/` is externalised by the runner
 *     and therefore loaded natively by Node, shebang and all. That is what
 *     {@link loadStylesheetGenerator} does: copy, import, delete. The copy is
 *     the generator byte for byte and the two functions it provides are pure,
 *     so the string compared below is the one the committed stylesheet was
 *     generated from.
 *
 * Solving this in the shared Vitest configuration instead would make a blocking
 * gate depend on a file it does not own; the mechanism here holds under any
 * runner configuration, which is the property a gate needs most.
 *
 * ## The stylesheet is a committed artifact
 *
 * `.prettierignore` and AAP 0.6.1 both treat `src/tokens/tokens.css` as
 * committed, and `tsup.config.ts` concatenates it into `dist/styles.css`. The
 * drift assertion regenerates in memory and compares against the file on disk,
 * which holds whether or not the artifact is tracked — so keep it. Were the
 * stylesheet ever excluded by the root ignore rules, the fix is a negation
 * entry there, never a weakening here, and this assertion is never to become a
 * snapshot: a snapshot records whatever it is given, which is the one thing a
 * drift gate must not do.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  contrastRatio,
  isHexColor,
  meetsContrast,
  roundContrastRatio,
  WCAG_AA_NON_TEXT_CONTRAST,
  WCAG_AA_TEXT_CONTRAST,
} from '../utils/color';
import {
  DEFAULT_PANEL_THEME,
  PANEL_THEME_ATTRIBUTE,
  PANEL_THEME_ATTRIBUTE_VALUES,
  PANEL_THEMES,
  panelThemeAttributeValue,
  panelThemeFromAttributeValue,
  themeFromDevToolsThemeName,
  themeFromVsCodeBodyClass,
  type PanelTheme,
} from './theme';
import { cssVar, cssVarName, DESIGN_TOKENS, type DesignTokens, type TokenKey } from './tokens';

/* -------------------------------------------------------------------------- */
/* Fixtures: the files under test and the generator that produced one of them */
/* -------------------------------------------------------------------------- */

/** This file's own directory. */
const TOKENS_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/** The package root; `src/tokens` sits two levels below it. */
const PACKAGE_ROOT = path.join(TOKENS_DIRECTORY, '..', '..');

/** The committed generated stylesheet under test. */
const STYLESHEET_PATH = path.join(TOKENS_DIRECTORY, 'tokens.css');

/** The generator that produced it. */
const GENERATOR_PATH = path.join(PACKAGE_ROOT, 'scripts', 'build-tokens.mjs');

/** The command that reconciles the stylesheet, quoted in every drift failure. */
const REGENERATE_COMMAND = 'node scripts/build-tokens.mjs';

/**
 * The part of the stylesheet generator this suite uses.
 *
 * Declared locally, and narrowly, because the module is plain JavaScript: the
 * two functions below are the ones AAP 0.6.1 makes this suite responsible for,
 * and naming only those keeps the dynamic import from becoming an untyped
 * surface. `toCssPropertyName` takes a `string` rather than a `TokenKey`
 * because the generator accepts any authored key — checking that it agrees with
 * the typed mapping for every real key is the point of one of the tests.
 */
interface StylesheetGenerator {
  readonly renderTokensCss: (tokens: DesignTokens) => string;
  readonly toCssPropertyName: (key: string) => string;
}

/**
 * Loads the stylesheet generator natively, through a byte-identical copy.
 *
 * The copy lands under `node_modules/`, which the test runner externalises, so
 * Node imports the real module with its shebang intact instead of the runner's
 * web-mode transform failing on it (see this file's header). The copy carries
 * the process id so two concurrent runs cannot collide, and it is removed
 * whether the import succeeds or fails — Node has already registered the module
 * by then, so deleting the file cannot affect the loaded exports.
 */
async function loadStylesheetGenerator(): Promise<StylesheetGenerator> {
  const cacheDirectory = path.join(PACKAGE_ROOT, 'node_modules', '.cache', 'debuggen-tokens');
  const copyPath = path.join(cacheDirectory, `build-tokens.${String(process.pid)}.mjs`);

  try {
    mkdirSync(cacheDirectory, { recursive: true });
    copyFileSync(GENERATOR_PATH, copyPath);

    // The specifier is a computed file URL rather than a literal, so the
    // compiler never tries to resolve an untyped `.mjs`; the loaded namespace
    // is therefore narrowed here, once, to the two functions used below.
    const loaded: unknown = await import(pathToFileURL(copyPath).href);
    return loaded as StylesheetGenerator;
  } catch (error) {
    throw new Error(
      'Could not load the stylesheet generator. This suite copies scripts/build-tokens.mjs to ' +
        `${copyPath} so the test runner loads it natively rather than transforming a ` +
        'command-line script whose first line is a shebang; that copy, or the import of it, ' +
        'failed. The stylesheet itself may still be reconciled with ' +
        `\`${REGENERATE_COMMAND}\`.`,
      { cause: error },
    );
  } finally {
    rmSync(copyPath, { force: true });
  }
}

const generator = await loadStylesheetGenerator();

/** The committed stylesheet, read once for every assertion below. */
const stylesheet = readFileSync(STYLESHEET_PATH, 'utf8');

/* -------------------------------------------------------------------------- */
/* Token inventory                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every token key at runtime, in the declaration order the generated stylesheet
 * carries (the default value set is canonical for both).
 *
 * The assertion on the element type is checked rather than trusted: the tests
 * below compare the property names derived from this list with an explicit
 * catalogue, so a key the type union does not contain, or one it contains and
 * this list does not, fails with a readable diff — and `tsc -b` covers the same
 * ground from the other direction, because a value set that omits a key of the
 * union does not compile.
 */
const TOKEN_KEYS = Object.keys(DESIGN_TOKENS.dark) as TokenKey[];

/**
 * Every custom property the design system declares (AAP 0.6.3), sorted.
 *
 * Written out rather than derived so that a typo, a rename or an invented token
 * fails instead of shipping: a derived list would agree with whatever the token
 * source happens to say. Note the digit boundaries — `--dg-space-0`,
 * `--dg-shadow-1` — which a naive camel-to-kebab conversion renders as
 * `--dg-space0` and `--dg-shadow1`, matching nothing in the stylesheet.
 */
const EXPECTED_CSS_PROPERTY_NAMES: readonly string[] = [
  '--dg-accent',
  '--dg-accent-muted',
  '--dg-border-strong',
  '--dg-border-subtle',
  '--dg-danger',
  '--dg-duration-critical',
  '--dg-duration-fast',
  '--dg-duration-normal',
  '--dg-duration-slow',
  '--dg-focus-ring',
  '--dg-font-mono',
  '--dg-font-ui',
  '--dg-heading',
  '--dg-info',
  '--dg-kind-db',
  '--dg-kind-error',
  '--dg-kind-fetch',
  '--dg-kind-function',
  '--dg-kind-http',
  '--dg-kind-interaction',
  '--dg-kind-render',
  '--dg-mono-md',
  '--dg-mono-sm',
  '--dg-radius-lg',
  '--dg-radius-md',
  '--dg-radius-sm',
  '--dg-shadow-0',
  '--dg-shadow-1',
  '--dg-shadow-2',
  '--dg-space-0',
  '--dg-space-1',
  '--dg-space-2',
  '--dg-space-3',
  '--dg-space-4',
  '--dg-space-5',
  '--dg-space-6',
  '--dg-space-7',
  '--dg-success',
  '--dg-surface-base',
  '--dg-surface-elevated',
  '--dg-surface-overlay',
  '--dg-text-lg',
  '--dg-text-md',
  '--dg-text-muted',
  '--dg-text-primary',
  '--dg-text-secondary',
  '--dg-text-sm',
  '--dg-text-xs',
  '--dg-warning',
  '--dg-z-base',
  '--dg-z-overlay',
  '--dg-z-tooltip',
];

/** The surfaces every foreground token is measured against. */
const SURFACE_KEYS = [
  'surfaceBase',
  'surfaceElevated',
  'surfaceOverlay',
] as const satisfies readonly TokenKey[];

/** The text colours, held to the text contrast minimum on every surface. */
const TEXT_KEYS = [
  'textPrimary',
  'textSecondary',
  'textMuted',
] as const satisfies readonly TokenKey[];

/**
 * The status colours and the accent, all of which appear as text — a badge
 * label, a status word, a link — and are therefore held to the text minimum
 * rather than the non-text one (AAP 0.6.3).
 */
const STATUS_TEXT_KEYS = [
  'success',
  'warning',
  'danger',
  'info',
  'accent',
] as const satisfies readonly TokenKey[];

/**
 * The span-kind scale: categorical fills for timeline lanes, hierarchy blocks
 * and graph nodes. They carry their own text labels, so AAP 0.6.3 holds them to
 * the non-text minimum.
 */
const KIND_FILL_KEYS = [
  'kindInteraction',
  'kindRender',
  'kindFetch',
  'kindHttp',
  'kindFunction',
  'kindDb',
  'kindError',
] as const satisfies readonly TokenKey[];

/**
 * The duration severity steps and the tokens they alias.
 *
 * `declaration` states the expected value literally as well, so the alias
 * contract is pinned to the custom property name a stylesheet consumer reads
 * and not only to whatever `cssVar` currently returns.
 */
const DURATION_ALIASES = [
  { severity: 'durationFast', alias: 'textMuted', declaration: 'var(--dg-text-muted)' },
  { severity: 'durationNormal', alias: 'textPrimary', declaration: 'var(--dg-text-primary)' },
  { severity: 'durationSlow', alias: 'warning', declaration: 'var(--dg-warning)' },
  { severity: 'durationCritical', alias: 'danger', declaration: 'var(--dg-danger)' },
] as const satisfies readonly {
  readonly severity: TokenKey;
  readonly alias: TokenKey;
  readonly declaration: string;
}[];

/**
 * The token families that carry the same value in every theme: a theme changes
 * colour and elevation, never geometry or type (AAP 0.6.3). Grouped by name so
 * a failure says which family drifted.
 */
const THEME_INVARIANT_FAMILIES = [
  {
    family: 'spacing scale',
    keys: ['space0', 'space1', 'space2', 'space3', 'space4', 'space5', 'space6', 'space7'],
  },
  { family: 'font stacks', keys: ['fontUi', 'fontMono'] },
  {
    family: 'type roles',
    keys: ['textXs', 'textSm', 'textMd', 'textLg', 'heading', 'monoSm', 'monoMd'],
  },
  { family: 'radii', keys: ['radiusSm', 'radiusMd', 'radiusLg'] },
  { family: 'stacking levels', keys: ['zBase', 'zOverlay', 'zTooltip'] },
] as const satisfies readonly { readonly family: string; readonly keys: readonly TokenKey[] }[];

/**
 * The keys whose high-contrast value differs from the default theme's, sorted.
 *
 * AAP 0.6.1 states the high-contrast set as the default set with three deltas —
 * borders raised to the primary text colour, a 2 px focus ring, no elevation
 * shadows — which is these five keys, because two of the deltas cover a pair.
 * `shadow0` is absent deliberately: it is `none` in every theme, so removing
 * elevation does not change it.
 */
const HIGH_CONTRAST_DELTA_KEYS: readonly TokenKey[] = [
  'borderStrong',
  'borderSubtle',
  'focusRing',
  'shadow1',
  'shadow2',
];

/**
 * The stylesheet's theme blocks in generated order, with the selector each one
 * carries.
 *
 * The alternate themes' selectors are built from the `data-theme` contract
 * rather than written out, which is what stops `theme.ts` and the stylesheet
 * from drifting apart and leaving a surface unstyled. The default theme is
 * served from `:root` and therefore declares no attribute selector at all —
 * `theme.ts` still maps it, so `PanelShell` can write the attribute for every
 * theme and make the applied theme observable in the DOM.
 */
const STYLESHEET_BLOCKS = [
  { theme: 'dark', selector: ':root' },
  {
    theme: 'light',
    selector: `[${PANEL_THEME_ATTRIBUTE}="${PANEL_THEME_ATTRIBUTE_VALUES.light}"]`,
  },
  {
    theme: 'highContrast',
    selector: `[${PANEL_THEME_ATTRIBUTE}="${PANEL_THEME_ATTRIBUTE_VALUES.highContrast}"]`,
  },
] as const satisfies readonly { readonly theme: PanelTheme; readonly selector: string }[];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** How many times `needle` occurs in `haystack`. */
function occurrencesOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The body of one selector block of the committed stylesheet.
 *
 * Located by its opening line and closed at the first line that is exactly a
 * closing brace, which is the shape the generator emits. A missing block throws
 * with the reconciliation command rather than returning an empty string, so a
 * stylesheet that lost a theme cannot pass a "declares every property" check by
 * having nothing to check.
 */
function styleBlockBody(selector: string): string {
  const opening = `${selector} {`;
  const start = stylesheet.indexOf(opening);
  if (start < 0) {
    throw new Error(
      `The committed stylesheet declares no "${opening}" block. Regenerate it with ` +
        `\`${REGENERATE_COMMAND}\`.`,
    );
  }

  const end = stylesheet.indexOf('\n}', start);
  if (end < 0) {
    throw new Error(
      `The "${opening}" block of the committed stylesheet is never closed. Regenerate it with ` +
        `\`${REGENERATE_COMMAND}\`.`,
    );
  }

  return stylesheet.slice(start + opening.length, end);
}

/** The custom property names one block body declares, in declaration order. */
function declaredCssPropertyNames(blockBody: string): string[] {
  const names: string[] = [];
  for (const match of blockBody.matchAll(/^\s*(--dg-[a-z0-9-]+)\s*:/gmu)) {
    const [, name] = match;
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/** Maps a custom property name back to the token key that declares it. */
const TOKEN_KEY_BY_CSS_PROPERTY: ReadonlyMap<string, TokenKey> = new Map(
  TOKEN_KEYS.map((key) => [cssVarName(key), key] as const),
);

/** A token value that is a reference to exactly one other token. */
const TOKEN_REFERENCE_PATTERN = /^var\((--dg-[a-z0-9-]+)\)$/u;

/**
 * One token's colour in one theme, ready to measure.
 *
 * A value that references another token — the duration steps do — is resolved
 * through exactly one level of indirection *within the same theme*, so an
 * aliased token stays measurable if a future token becomes an alias, while a
 * chain of aliases fails loudly instead of being followed silently. A value
 * that is not a colour at all throws: a pair table naming a spacing step, a
 * font stack or a shadow is a mistake in this suite, and the contrast helpers
 * would otherwise report it as an unparseable colour with no context.
 */
function resolveMeasurableColor(theme: PanelTheme, key: TokenKey): string {
  const values = DESIGN_TOKENS[theme];
  const declared = values[key];
  const reference = TOKEN_REFERENCE_PATTERN.exec(declared);

  let resolved = declared;
  if (reference !== null) {
    const property = reference[1] ?? '';
    const aliased = TOKEN_KEY_BY_CSS_PROPERTY.get(property);
    if (aliased === undefined) {
      throw new Error(
        `${theme}.${key} is declared as "${declared}", which references ${property} — a custom ` +
          'property no token declares.',
      );
    }
    resolved = values[aliased];
  }

  if (!isHexColor(resolved)) {
    throw new Error(
      `${theme}.${key} resolves to "${resolved}", which is not a measurable colour. Only one ` +
        'level of var(...) indirection is resolved, deliberately.',
    );
  }

  return resolved;
}

/** The contrast ratio between two tokens of one theme. */
function measureContrast(theme: PanelTheme, foreground: TokenKey, background: TokenKey): number {
  return contrastRatio(
    resolveMeasurableColor(theme, foreground),
    resolveMeasurableColor(theme, background),
  );
}

/** One measured foreground/background pair. */
interface MeasuredPair {
  readonly theme: PanelTheme;
  readonly foreground: TokenKey;
  readonly background: TokenKey;
  readonly ratio: number;
}

/** Every combination of the given themes, foregrounds and the surface set. */
function measurePairs(
  themes: readonly PanelTheme[],
  foregrounds: readonly TokenKey[],
): MeasuredPair[] {
  const pairs: MeasuredPair[] = [];
  for (const theme of themes) {
    for (const foreground of foregrounds) {
      for (const background of SURFACE_KEYS) {
        pairs.push({
          theme,
          foreground,
          background,
          ratio: measureContrast(theme, foreground, background),
        });
      }
    }
  }
  return pairs;
}

/** The lowest-contrast pair of a measured set. */
function worstPairOf(pairs: readonly MeasuredPair[]): MeasuredPair {
  let worst: MeasuredPair | undefined;
  for (const pair of pairs) {
    if (worst === undefined || pair.ratio < worst.ratio) {
      worst = pair;
    }
  }
  if (worst === undefined) {
    throw new Error('No colour pairs were measured, so no worst pair exists.');
  }
  return worst;
}

/** A measured pair as a single line, for an assertion message. */
function describePair(pair: MeasuredPair, minimum: number): string {
  return (
    `${pair.theme}: ${pair.foreground} on ${pair.background} measures ` +
    `${roundContrastRatio(pair.ratio)}:1, below the ${minimum}:1 minimum`
  );
}

/** An input value as a readable fragment of a test name. */
function describeInput(value: string | readonly string[] | null | undefined): string {
  return JSON.stringify(value) ?? 'undefined';
}

/* -------------------------------------------------------------------------- */
/* 1. Drift and naming agreement (AAP 0.6.1)                                  */
/* -------------------------------------------------------------------------- */

describe('generated token stylesheet', () => {
  it('matches a fresh regeneration of the token source, byte for byte', () => {
    const regenerated = generator.renderTokensCss(DESIGN_TOKENS);
    const outOfDate =
      'src/tokens/tokens.css no longer matches src/tokens/tokens.ts. The stylesheet is ' +
      `generated and never hand-edited: reconcile it with \`${REGENERATE_COMMAND}\` and commit ` +
      'the result.';

    // The line comparison is first because its diff names the drifting
    // declaration; the whole-string comparison that follows is the authority,
    // and catches a difference the line split hides, such as a missing or
    // duplicated trailing newline.
    expect(stylesheet.split('\n'), outOfDate).toEqual(regenerated.split('\n'));
    expect(stylesheet, outOfDate).toBe(regenerated);
  });

  it('declares each theme block exactly once, in generated order', () => {
    const positions: number[] = [];

    for (const { theme, selector } of STYLESHEET_BLOCKS) {
      const opening = `${selector} {`;
      expect(
        occurrencesOf(stylesheet, opening),
        `expected exactly one "${opening}" block for the ${theme} theme`,
      ).toBe(1);
      positions.push(stylesheet.indexOf(opening));
    }

    expect(
      positions,
      'the theme blocks are not in the order the generator emits them (default theme first)',
    ).toEqual([...positions].sort((first, second) => first - second));
  });

  it('scopes its alternate theme blocks with the data-theme contract', () => {
    expect(PANEL_THEME_ATTRIBUTE).toBe('data-theme');

    for (const theme of PANEL_THEMES) {
      const selector = `[${PANEL_THEME_ATTRIBUTE}="${panelThemeAttributeValue(theme)}"]`;
      const declared = occurrencesOf(stylesheet, `${selector} {`);

      if (theme === DEFAULT_PANEL_THEME) {
        // The default theme is served from `:root`, so it applies with no
        // attribute at all. It is still mapped, which is what lets the panel
        // shell write the attribute for every theme.
        expect(
          declared,
          `the ${theme} theme is served from the :root block and needs no attribute selector`,
        ).toBe(0);
      } else {
        expect(declared, `the ${theme} theme has no "${selector}" block`).toBe(1);
      }
    }
  });

  it('names every custom property exactly as the typed mapping does', () => {
    for (const key of TOKEN_KEYS) {
      const name = cssVarName(key);

      expect(name, `${key} must be emitted under a --dg- prefixed name`).toMatch(/^--dg-/u);
      expect(
        generator.toCssPropertyName(key),
        `the stylesheet generator and cssVarName disagree about ${key}`,
      ).toBe(name);
      expect(cssVar(key), `${key} must reference its own custom property`).toBe(`var(${name})`);
    }
  });

  it('declares exactly the catalogued custom properties', () => {
    expect(EXPECTED_CSS_PROPERTY_NAMES).toHaveLength(52);
    expect(
      new Set(EXPECTED_CSS_PROPERTY_NAMES).size,
      'the catalogue lists a custom property twice',
    ).toBe(EXPECTED_CSS_PROPERTY_NAMES.length);
    expect([...EXPECTED_CSS_PROPERTY_NAMES].sort(), 'the catalogue is not sorted').toEqual([
      ...EXPECTED_CSS_PROPERTY_NAMES,
    ]);

    expect(
      TOKEN_KEYS.map((key) => cssVarName(key)).sort(),
      'the token source declares a property the catalogue does not list, or omits one it does',
    ).toEqual([...EXPECTED_CSS_PROPERTY_NAMES]);
  });

  for (const { theme, selector } of STYLESHEET_BLOCKS) {
    it(`declares every custom property in the ${theme} block, in canonical order`, () => {
      const declared = declaredCssPropertyNames(styleBlockBody(selector));

      expect(
        declared,
        `the ${theme} block must declare every property once, in the token source's key order; ` +
          'a block that omits one silently inherits the default theme value',
      ).toEqual(TOKEN_KEYS.map((key) => cssVarName(key)));
      expect(
        [...declared].sort(),
        `the ${theme} block declares a property set other than the catalogue`,
      ).toEqual([...EXPECTED_CSS_PROPERTY_NAMES]);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* 2. Completeness (AAP 0.6.1)                                                */
/* -------------------------------------------------------------------------- */

describe('design token completeness', () => {
  it('declares one value set per theme', () => {
    expect([...PANEL_THEMES].sort(), 'the theme list and the token table disagree').toEqual(
      Object.keys(DESIGN_TOKENS).sort(),
    );
    expect(PANEL_THEMES).toHaveLength(3);
    expect(DEFAULT_PANEL_THEME, 'dark mode is the product default').toBe('dark');
  });

  it('gives every theme the same key set', () => {
    const canonical = [...TOKEN_KEYS].sort();

    for (const theme of PANEL_THEMES) {
      expect(
        Object.keys(DESIGN_TOKENS[theme]).sort(),
        `the ${theme} value set's keys differ from the canonical key list`,
      ).toEqual(canonical);
    }

    // Compared against each other as well, so a key the default set never had
    // cannot pass by being absent everywhere it is checked.
    expect(
      Object.keys(DESIGN_TOKENS.light).sort(),
      'the light and high-contrast value sets declare different keys',
    ).toEqual(Object.keys(DESIGN_TOKENS.highContrast).sort());
  });

  for (const theme of PANEL_THEMES) {
    it(`gives every token of the ${theme} set a usable value`, () => {
      const values = DESIGN_TOKENS[theme];

      for (const key of TOKEN_KEYS) {
        const value = values[key];

        expect(value.length, `${theme}.${key} has no value`).toBeGreaterThan(0);
        expect(value, `${theme}.${key} has leading or trailing whitespace`).toBe(value.trim());
        expect(
          ['undefined', 'null', 'NaN'],
          `${theme}.${key} holds "${value}", a stringified absent value`,
        ).not.toContain(value);
      }
    });
  }

  it('keeps the high-contrast set to the documented deltas', () => {
    const { dark, highContrast } = DESIGN_TOKENS;
    const differing = TOKEN_KEYS.filter((key) => dark[key] !== highContrast[key]).sort();

    expect(
      differing,
      'the high-contrast set is the default set with three deltas — borders raised to the ' +
        'primary text colour, a 2 px focus ring and no elevation shadows — and must be identical ' +
        'everywhere else',
    ).toEqual([...HIGH_CONTRAST_DELTA_KEYS]);

    expect(
      highContrast.borderSubtle,
      'the subtle border is raised to the primary text colour',
    ).toBe(dark.textPrimary);
    expect(
      highContrast.borderStrong,
      'the strong border is raised to the primary text colour',
    ).toBe(dark.textPrimary);
    expect(dark.focusRing.startsWith('1px'), 'the default focus ring is 1 px').toBe(true);
    expect(highContrast.focusRing.startsWith('2px'), 'the high-contrast focus ring is 2 px').toBe(
      true,
    );
    expect(highContrast.shadow1, 'high contrast carries no elevation shadow').toBe('none');
    expect(highContrast.shadow2, 'high contrast carries no elevation shadow').toBe('none');
  });

  for (const theme of PANEL_THEMES) {
    it(`keeps the duration steps aliases in the ${theme} set`, () => {
      const values = DESIGN_TOKENS[theme];

      for (const { severity, alias, declaration } of DURATION_ALIASES) {
        expect(declaration, `${String(alias)} is not referenced as ${declaration}`).toBe(
          cssVar(alias),
        );
        expect(
          values[severity],
          `${theme}.${String(severity)} must alias ${String(alias)} rather than repeat its value, ` +
            'so every theme stays in sync by construction',
        ).toBe(declaration);
      }
    });
  }

  for (const { family, keys } of THEME_INVARIANT_FAMILIES) {
    it(`keeps the ${family} identical in every theme`, () => {
      for (const key of keys) {
        const expected = DESIGN_TOKENS.dark[key];

        for (const theme of PANEL_THEMES) {
          expect(
            DESIGN_TOKENS[theme][key],
            `${theme}.${String(key)} differs from the default theme: a theme changes colour and ` +
              'elevation, never geometry or type',
          ).toBe(expected);
        }
      }
    });
  }
});

/* -------------------------------------------------------------------------- */
/* 3. WCAG contrast (AAP 0.6.3, 0.6.4) — the accessibility gate               */
/* -------------------------------------------------------------------------- */

describe('design token contrast', () => {
  for (const theme of PANEL_THEMES) {
    describe(theme, () => {
      for (const background of SURFACE_KEYS) {
        for (const foreground of TEXT_KEYS) {
          it(`renders ${foreground} on ${background} at the text minimum`, () => {
            const ratio = measureContrast(theme, foreground, background);

            expect(
              meetsContrast(ratio, WCAG_AA_TEXT_CONTRAST),
              describePair({ theme, foreground, background, ratio }, WCAG_AA_TEXT_CONTRAST),
            ).toBe(true);
          });
        }

        for (const foreground of STATUS_TEXT_KEYS) {
          it(`renders ${foreground} as text on ${background} at the text minimum`, () => {
            const ratio = measureContrast(theme, foreground, background);

            expect(
              meetsContrast(ratio, WCAG_AA_TEXT_CONTRAST),
              describePair({ theme, foreground, background, ratio }, WCAG_AA_TEXT_CONTRAST),
            ).toBe(true);
          });
        }

        for (const foreground of KIND_FILL_KEYS) {
          it(`fills ${foreground} on ${background} at the non-text minimum`, () => {
            const ratio = measureContrast(theme, foreground, background);

            expect(
              meetsContrast(ratio, WCAG_AA_NON_TEXT_CONTRAST),
              describePair({ theme, foreground, background, ratio }, WCAG_AA_NON_TEXT_CONTRAST),
            ).toBe(true);
          });
        }
      }
    });
  }

  it('states the high-contrast border colour as an identity rather than a ratio', () => {
    // A border carries no text, so it belongs to no ratio suite above. The
    // guarantee it carries instead is the delta AAP 0.6.1 states: both border
    // colours are the primary text colour, which is the strongest separation
    // the palette has.
    const { highContrast } = DESIGN_TOKENS;

    expect(highContrast.borderSubtle).toBe(highContrast.textPrimary);
    expect(highContrast.borderStrong).toBe(highContrast.textPrimary);
  });
});

describe('published contrast reference figures', () => {
  // These are the figures AAP 0.6.3 publishes, reproduced here to two decimals
  // so a change in the arithmetic stays distinguishable from a change in the
  // palette: the suite above would fail either way, while a mismatch here says
  // which of the two moved. The overlay surface is the extreme of both
  // palettes, so every worst pair sits on it.

  it('reproduces the worst text pair of the dark palette', () => {
    expect(measureContrast('dark', 'textMuted', 'surfaceOverlay')).toBeCloseTo(5.09, 2);
  });

  it('reproduces the worst text pair of the light palette', () => {
    expect(measureContrast('light', 'textMuted', 'surfaceOverlay')).toBeCloseTo(4.82, 2);
  });

  it('reproduces the worst text pair of every theme', () => {
    const worst = worstPairOf(measurePairs(PANEL_THEMES, TEXT_KEYS));

    expect(
      meetsContrast(worst.ratio, WCAG_AA_TEXT_CONTRAST),
      describePair(worst, WCAG_AA_TEXT_CONTRAST),
    ).toBe(true);
    expect(worst.ratio).toBeCloseTo(4.82, 2);
  });

  it('reproduces the worst status-as-text ratio of the two palettes', () => {
    // The high-contrast set repeats the dark colours, so its ratios equal
    // dark's and the two palettes are the whole search space.
    const worst = worstPairOf(measurePairs(['dark', 'light'], STATUS_TEXT_KEYS));

    expect(worst.theme, 'the published worst status pair belongs to the light palette').toBe(
      'light',
    );
    expect(worst.foreground).toBe('danger');
    expect(worst.background).toBe('surfaceOverlay');
    expect(worst.ratio).toBeGreaterThanOrEqual(4.86);
    expect(worst.ratio).toBeCloseTo(4.86, 2);

    expect(
      worstPairOf(measurePairs(['dark'], STATUS_TEXT_KEYS)).ratio,
      "the dark palette's worst status pair",
    ).toBeCloseTo(5.72, 2);
  });

  it('reproduces the tightest span-kind fill ratio', () => {
    // The tightest contrast in the whole design system: the light fetch fill on
    // the light overlay surface, 3.21:1 against a 3:1 bar — a margin of 0.21.
    // A failure in the non-text suite above is therefore almost certainly a
    // changed light kind colour rather than a changed surface.
    const worst = worstPairOf(measurePairs(PANEL_THEMES, KIND_FILL_KEYS));

    expect(worst.theme).toBe('light');
    expect(worst.foreground).toBe('kindFetch');
    expect(worst.background).toBe('surfaceOverlay');
    expect(
      meetsContrast(worst.ratio, WCAG_AA_NON_TEXT_CONTRAST),
      describePair(worst, WCAG_AA_NON_TEXT_CONTRAST),
    ).toBe(true);
    expect(worst.ratio).toBeCloseTo(3.21, 2);
  });

  it('measures the high-contrast palette exactly as the dark palette', () => {
    // Its colours *are* the dark colours (only borders, the focus ring and the
    // elevation shadows differ), so the two must measure identically. This is
    // the assertion that keeps that claim from quietly becoming untrue.
    for (const foreground of [...TEXT_KEYS, ...STATUS_TEXT_KEYS, ...KIND_FILL_KEYS]) {
      for (const background of SURFACE_KEYS) {
        expect(
          measureContrast('highContrast', foreground, background),
          `high contrast diverges from the dark palette at ${foreground} on ${background}`,
        ).toBe(measureContrast('dark', foreground, background));
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Theme identity and the two host mappings                                */
/* -------------------------------------------------------------------------- */

/**
 * The DevTools theme names and the theme each denotes. `"default"` is the name
 * the panel host reports for its light theme; `"light"` is accepted defensively
 * beside it. There is no high-contrast theme name, so that value set is
 * unreachable from this input by design.
 */
const DEVTOOLS_THEME_CASES: readonly (readonly [string | null | undefined, PanelTheme])[] = [
  ['dark', 'dark'],
  ['default', 'light'],
  ['light', 'light'],
  ['', DEFAULT_PANEL_THEME],
  ['a-theme-name-that-does-not-exist', DEFAULT_PANEL_THEME],
  ['DARK', DEFAULT_PANEL_THEME],
  [undefined, DEFAULT_PANEL_THEME],
  [null, DEFAULT_PANEL_THEME],
];

/**
 * The editor webview body class strings and the theme each denotes, including
 * the shapes the host actually produces: one theme class among unrelated ones,
 * and the light high-contrast theme, which carries both high-contrast classes.
 */
const WEBVIEW_BODY_CLASS_CASES: readonly (readonly [string | null | undefined, PanelTheme])[] = [
  ['vscode-light', 'light'],
  ['vscode-dark', 'dark'],
  ['vscode-high-contrast', 'highContrast'],
  ['vscode-high-contrast-light', 'highContrast'],
  ['vscode-high-contrast vscode-high-contrast-light', 'highContrast'],
  ['vscode-high-contrast-light vscode-high-contrast', 'highContrast'],
  ['panel-root vscode-dark reduced-motion', 'dark'],
  ['  vscode-light  ', 'light'],
  ['panel-root reduced-motion', DEFAULT_PANEL_THEME],
  ['vscodedark', DEFAULT_PANEL_THEME],
  ['vscode-light-theme', DEFAULT_PANEL_THEME],
  ['', DEFAULT_PANEL_THEME],
  ['   ', DEFAULT_PANEL_THEME],
  [undefined, DEFAULT_PANEL_THEME],
  [null, DEFAULT_PANEL_THEME],
];

describe('theme identity', () => {
  it('maps every theme to its DOM attribute value, in both directions', () => {
    expect(PANEL_THEME_ATTRIBUTE).toBe('data-theme');
    expect(PANEL_THEME_ATTRIBUTE_VALUES).toEqual({
      dark: 'dark',
      light: 'light',
      highContrast: 'high-contrast',
    });

    for (const theme of PANEL_THEMES) {
      const value = panelThemeAttributeValue(theme);

      expect(value, `${theme} has no attribute value`).toBe(PANEL_THEME_ATTRIBUTE_VALUES[theme]);
      expect(
        panelThemeFromAttributeValue(value),
        `the attribute value "${value}" must read back as ${theme}`,
      ).toBe(theme);
    }
  });

  it('answers the default theme for an attribute value it does not recognise', () => {
    // The camel-case name is the token table's key, never a DOM value: reading
    // it back must not resolve a theme, or the two spellings would both appear
    // to work and only one of them would be styled.
    expect(panelThemeFromAttributeValue('highContrast')).toBe(DEFAULT_PANEL_THEME);
    expect(panelThemeFromAttributeValue('')).toBe(DEFAULT_PANEL_THEME);
    expect(panelThemeFromAttributeValue(null)).toBe(DEFAULT_PANEL_THEME);
    expect(panelThemeFromAttributeValue(undefined)).toBe(DEFAULT_PANEL_THEME);
  });
});

describe('devtools theme name mapping', () => {
  for (const [name, expected] of DEVTOOLS_THEME_CASES) {
    it(`resolves ${describeInput(name)} to the ${expected} theme`, () => {
      expect(themeFromDevToolsThemeName(name)).toBe(expected);
    });
  }

  it('is total: no input throws', () => {
    for (const [name] of DEVTOOLS_THEME_CASES) {
      expect(() => themeFromDevToolsThemeName(name)).not.toThrow();
    }
  });
});

describe('editor webview body class mapping', () => {
  for (const [className, expected] of WEBVIEW_BODY_CLASS_CASES) {
    it(`resolves ${describeInput(className)} to the ${expected} theme`, () => {
      expect(themeFromVsCodeBodyClass(className)).toBe(expected);
    });
  }

  it('never resolves the light high-contrast class to the light theme', () => {
    // The substring trap, and the reason exact-token matching most-specific
    // first is the only correct implementation: `vscode-high-contrast-light`
    // contains both `vscode-high-contrast` and `light`, so a substring test
    // would answer the light value set and withdraw the high-contrast theme
    // from the people who selected it (AAP 0.6.4).
    expect(themeFromVsCodeBodyClass('vscode-high-contrast-light')).not.toBe('light');
    expect(themeFromVsCodeBodyClass('vscode-high-contrast-light')).toBe('highContrast');
    expect(themeFromVsCodeBodyClass('vscode-high-contrast vscode-high-contrast-light')).toBe(
      'highContrast',
    );
  });

  it('reads an iterable of class names as it reads the equivalent string', () => {
    expect(themeFromVsCodeBodyClass(['panel-root', 'vscode-dark'])).toBe('dark');
    expect(themeFromVsCodeBodyClass(new Set(['vscode-high-contrast']))).toBe('highContrast');
    expect(themeFromVsCodeBodyClass(['vscode-light'])).toBe(
      themeFromVsCodeBodyClass('vscode-light'),
    );
    expect(themeFromVsCodeBodyClass([])).toBe(DEFAULT_PANEL_THEME);
    expect(themeFromVsCodeBodyClass(new Set<string>())).toBe(DEFAULT_PANEL_THEME);
  });

  it('reads a live class list as it reads the equivalent string', () => {
    // The shape the editor surface actually passes: the body element's own
    // token list, which is an iterable of class names rather than a string.
    const className = 'panel-root vscode-high-contrast vscode-high-contrast-light';
    const element = document.createElement('div');
    element.className = className;

    expect([...element.classList]).toContain('vscode-high-contrast-light');
    expect(themeFromVsCodeBodyClass(element.classList)).toBe(themeFromVsCodeBodyClass(className));
    expect(themeFromVsCodeBodyClass(element.classList)).toBe('highContrast');
  });

  it('is total: no input throws', () => {
    for (const [className] of WEBVIEW_BODY_CLASS_CASES) {
      expect(() => themeFromVsCodeBodyClass(className)).not.toThrow();
    }

    for (const iterable of [[], [''], ['   '], ['panel-root'], new Set(['vscode-dark'])]) {
      expect(() => themeFromVsCodeBodyClass(iterable)).not.toThrow();
    }
  });

  it('skips a non-string entry an untyped host value carries', () => {
    // The assertion is the point of the case rather than a shortcut: the
    // parameter type admits only strings, while the value actually reaching
    // this boundary comes from a host the compiler does not check. The mapping
    // documents that it skips such an entry instead of throwing on it, so the
    // theme class beside it must still resolve.
    const hostClassNames = ['panel-root', 7, null, 'vscode-dark'] as unknown as string[];

    expect(() => themeFromVsCodeBodyClass(hostClassNames)).not.toThrow();
    expect(themeFromVsCodeBodyClass(hostClassNames)).toBe('dark');
  });
});
