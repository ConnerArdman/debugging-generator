/**
 * The webview stylesheet gate — `./styles.css` consumes the design system's
 * token table and extends it nowhere.
 *
 * The VS Code view layers its `dgv-*` blocks on `@debuggen/panel-renderer`'s
 * stylesheet, and the design system admits only `0`, `none`, `auto`,
 * `inherit`, `currentColor` and `transparent` as literals in either consumer:
 * every colour, length, percentage, ratio, factor and border weight a rule
 * states resolves to a `--dg-*` token generated from the renderer's
 * `src/tokens/tokens.ts`. The renderer's own token suite holds its two
 * stylesheets to that; this suite holds the editor surface to the same
 * contract, so a value the view writes inline — outside the drift,
 * completeness, theme and contrast checks the token table is under — fails
 * the blocking test gate instead of shipping.
 *
 * Five properties are checked, each on the comment-free rules (a header
 * comment quotes example declarations, and prose is not a declaration):
 *
 *   1. the stylesheet declares no custom property of its own;
 *   2. every custom property a rule reads is a catalogued `--dg-*` token,
 *      derived from the token table itself, so a misspelled or invented token
 *      fails here rather than silently resolving to nothing;
 *   3. no number other than zero appears in any value — with or without a unit;
 *   4. no colour is written as a literal;
 *   5. no border or outline width is written as a keyword.
 *
 * ## How the stylesheet is read
 *
 * This project type-checks against DOM libraries only (`tsconfig.webview.json`
 * sets `types: []`, so Node's module declarations are not in scope), yet the
 * suite runs in Node under happy-dom. The file-system and URL modules are
 * therefore loaded through specifiers the compiler does not resolve, and each
 * is narrowed once, here, to the one function used from it; the path is
 * resolved from `import.meta.url` rather than from the working directory,
 * which differs between a repository-root run and a `pnpm --filter` run.
 */

import { cssVarName, DESIGN_TOKENS } from '@debuggen/panel-renderer';
import type { TokenKey } from '@debuggen/panel-renderer';
import { describe, expect, it } from 'vitest';

/** The one file-system function this suite uses. */
interface FileSystem {
  readonly readFileSync: (file: string, encoding: 'utf8') => string;
}

/** The one URL function this suite uses. */
interface UrlModule {
  readonly fileURLToPath: (url: string) => string;
}

/**
 * Loads a Node built-in module behind a specifier the compiler does not try to
 * resolve (see the header), and checks it carries the function this suite
 * calls before narrowing it to the local interface that names it.
 *
 * @param specifier The built-in module to load.
 * @param member The function the suite calls on it.
 * @returns The module, narrowed to the function used.
 */
async function loadBuiltin<Module>(specifier: string, member: string): Promise<Module> {
  const loaded: unknown = await import(/* @vite-ignore */ specifier);
  if (
    typeof loaded !== 'object' ||
    loaded === null ||
    !(member in loaded) ||
    typeof (loaded as Record<string, unknown>)[member] !== 'function'
  ) {
    throw new Error(`${specifier} did not provide ${member}.`);
  }
  return loaded as Module;
}

const { readFileSync } = await loadBuiltin<FileSystem>('node:fs', 'readFileSync');
const { fileURLToPath } = await loadBuiltin<UrlModule>('node:url', 'fileURLToPath');

/**
 * The stylesheet under test: this suite's sibling. Located from this module's
 * own file path — the DOM environment's `URL` resolves against the simulated
 * page rather than the file system, so the path is derived from
 * `import.meta.url` through Node's converter and not through `new URL()`.
 */
const STYLESHEET_PATH = fileURLToPath(import.meta.url).replace(/styles\.test\.ts$/u, 'styles.css');

/** The stylesheet under test, with its comments removed. */
const RULES = readFileSync(STYLESHEET_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');

/** Every custom property the design system declares, from the token table. */
const CATALOGUED_TOKENS: ReadonlySet<string> = new Set(
  (Object.keys(DESIGN_TOKENS.dark) as TokenKey[]).map((key) => cssVarName(key)),
);

/**
 * A number written as a literal anywhere in a value, signed or not, with or
 * without a unit, a percentage sign or a flex unit. The number may not follow
 * a word character or a dot, so digits inside an identifier never match;
 * custom property names are removed before the scan.
 */
const NUMERIC_LITERAL_PATTERN = /(?<![\w.-])[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:[a-z]+|%)?/giu;

/** A colour literal: hexadecimal, or a functional colour notation. */
const COLOUR_LITERAL_PATTERN =
  /#[0-9a-f]{3,8}(?![\w-])|(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/iu;

/** A border or outline width written as a keyword. */
const BORDER_WIDTH_KEYWORD_PATTERN = /(?<![\w-])(?:thin|medium|thick)(?![\w-])/u;

/** The properties whose value carries a border or outline width. */
const BORDER_WIDTH_PROPERTY_PATTERN =
  /^(?:border(?:-(?:block|inline|top|right|bottom|left)(?:-(?:start|end))?)?(?:-width)?|outline(?:-width)?|column-rule(?:-width)?)$/u;

/** One declaration of a rule, split at its first colon. */
interface Declaration {
  readonly selector: string;
  readonly property: string;
  readonly value: string;
}

/**
 * Every declaration of every innermost rule, whitespace-normalised. The
 * stylesheet's rules are flat, so the innermost `{ … }` pairs are exactly its
 * style rules.
 */
function declarations(rules: string): Declaration[] {
  const found: Declaration[] = [];
  for (const match of rules.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const [, selector = '', body = ''] = match;
    for (const raw of body.split(';')) {
      const declaration = raw.replace(/\s+/gu, ' ').trim();
      const separator = declaration.indexOf(':');
      if (separator < 0) {
        continue;
      }
      found.push({
        selector: selector.replace(/\s+/gu, ' ').trim(),
        property: declaration.slice(0, separator).trim(),
        value: declaration.slice(separator + 1).trim(),
      });
    }
  }
  return found;
}

/**
 * The numbers a value writes as literals, other than zero in any unit. Quoted
 * strings and custom property names are removed first, so a token reference
 * such as `var(--dg-space-1)` is never mistaken for a number.
 */
function numericLiteralsIn(value: string): string[] {
  const scanned = value.replace(/(['"])(?:\\.|(?!\1).)*\1/gu, '').replace(/--[\w-]+/gu, '');
  return [...scanned.matchAll(NUMERIC_LITERAL_PATTERN)]
    .map((match) => match[0])
    .filter((literal) => Number.parseFloat(literal) !== 0);
}

/** A declaration as one line, for an assertion message. */
function describeDeclaration({ selector, property, value }: Declaration): string {
  return `${selector} { ${property}: ${value} }`;
}

const DECLARATIONS = declarations(RULES);

describe('webview stylesheet', () => {
  it('has rules to check', () => {
    expect(DECLARATIONS.length, 'the scan found no declarations at all').toBeGreaterThan(0);
  });

  it('declares no custom property of its own', () => {
    expect(
      DECLARATIONS.filter(({ property }) => property.startsWith('--')).map(describeDeclaration),
      'a token declared outside the design system has no single source of truth and is covered ' +
        'by none of its checks',
    ).toEqual([]);
  });

  it('references only catalogued design tokens', () => {
    const referenced = [...new Set([...RULES.matchAll(/var\(\s*(--[\w-]+)/gu)].map((m) => m[1]))];
    const unknown = referenced.filter((name) => name === undefined || !CATALOGUED_TOKENS.has(name));

    expect(referenced.length, 'the scan found no token references at all').toBeGreaterThan(0);
    expect(
      unknown,
      'every custom property the view reads must be a --dg-* token of the design system',
    ).toEqual([]);
  });

  it('states every number other than zero through a token', () => {
    const offenders = DECLARATIONS.flatMap((declaration) => {
      const literals = numericLiteralsIn(declaration.value);
      return literals.length === 0
        ? []
        : [`${describeDeclaration(declaration)} — ${literals.join(', ')}`];
    });

    expect(
      offenders,
      'a number written in the view stylesheet is a value outside the token table: a length, a ' +
        'percentage, a flex or grid factor or a radius. Name the --dg-* token for it — add one to ' +
        "the design system's token table if none fits — or a keyword the design system permits",
    ).toEqual([]);
  });

  it('states every colour through a token', () => {
    expect(
      DECLARATIONS.filter(({ value }) => COLOUR_LITERAL_PATTERN.test(value)).map(
        describeDeclaration,
      ),
      'a colour literal escapes every theme and every contrast check of the design system',
    ).toEqual([]);
  });

  it('states every border and outline width through a token', () => {
    expect(
      DECLARATIONS.filter(
        ({ property, value }) =>
          BORDER_WIDTH_PROPERTY_PATTERN.test(property) && BORDER_WIDTH_KEYWORD_PATTERN.test(value),
      ).map(describeDeclaration),
      'an edge weight is var(--dg-border-width-hairline) or var(--dg-border-width-marker)',
    ).toEqual([]);
  });
});

describe('numeric literal scanner', () => {
  // Pinned against hand-worked answers, so the gate above cannot pass by the
  // scanner missing what it is meant to find.
  const cases = [
    { value: 'var(--dg-space-2)', literals: [] },
    { value: '0', literals: [] },
    { value: '100%', literals: ['100%'] },
    { value: 'calc(100% - var(--dg-space-5))', literals: ['100%'] },
    { value: '1 1 auto', literals: ['1', '1'] },
    { value: '0 1 auto', literals: ['1'] },
    { value: '2', literals: ['2'] },
    { value: 'max-content minmax(0, var(--dg-column-share-default))', literals: [] },
  ] as const;

  for (const { value, literals } of cases) {
    it(`finds [${literals.join(', ')}] in "${value}"`, () => {
      expect(numericLiteralsIn(value)).toEqual(literals);
    });
  }
});
