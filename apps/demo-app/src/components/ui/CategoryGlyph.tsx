/*
 * Lumen Supply - the category glyph.
 *
 * A small mark that sits immediately before a category's name: in the catalog's filter chips
 * (`catalog/CategoryFilterChips`, each chip a `ui/Pill`) and in the dashboard's category grouping
 * headers (`dashboard/InventoryLevelsTable`). It lives in `ui/` rather than in either of those
 * folders because both need it and, more importantly, because of the asymmetry it exists to
 * absorb - which has exactly one home, this file.
 *
 * THE ASYMMETRY
 * `apps/demo-app/public/categories/` holds six drawings; the seed creates roughly twice as many
 * categories. Most categories therefore have no art, and every caller passes a slug that came
 * from the API without knowing which kind it is. The rule is absolute: a slug that matches one of
 * the six renders its glyph, and anything else renders NOTHING - no element, no request, no
 * broken-image frame, no `onError` handler, no generic "other" icon, no letter avatar. A chip for
 * a category without art is simply a chip with a word in it, which is a rendering every surface
 * here already supports.
 *
 * `CategoryGlyph.module.css` reaches the same answer independently, and deliberately: `.root`
 * declares no mask image and a transparent fill, and only the six slug rules turn the paint on.
 * Neither half is redundant. A masked element whose mask image is missing is not masked at all and
 * would paint its fill across the whole box, so an unmatched slug that ever reached the DOM would
 * render as a solid square - the broken icon the rule forbids. The component keeps it out of the
 * DOM; the stylesheet makes sure it would show nothing even if it got there.
 *
 * WHY THE PROP IS A `string` AND NOT THE SIX-MEMBER UNION
 * Narrowing happens here, once, in `isKnown`. Typing `slug` to the union would push that decision
 * onto every caller - each holding a `string` from `/api/products` or a Prisma row - and the first
 * one to reach for a cast instead of a check would ship the broken icon this component exists to
 * prevent. A plain `string` in, a guard inside, and the degradation cannot be bypassed by accident.
 *
 * Near misses are rejected rather than repaired: no lowercasing, no trimming, no punctuation
 * fixing. `'Valve'` and `' valve'` are not `'valve'` and render nothing. Coercion would make the
 * mapping dishonest - it would claim a category has art on the strength of a guess about its
 * spelling - and it would hide a real data problem behind an icon that happens to appear. A
 * category either has a drawing under that exact name or it does not.
 *
 * WHY AN EMPTY `<span>` AND NOT AN IMAGE
 * The assets are stroke-only, with `stroke="currentColor"`. Fetched through an image element - the
 * one Next's image component renders included - each becomes an independent document, so that
 * keyword resolves against the file's own root `color` and no rule on this page can reach it. The
 * chips need the opposite: `Pill.module.css` turns a selected chip's `color` white and the glyph
 * has to follow the label into that inversion. So the stylesheet uses the asset as a `mask-image`
 * and paints `background-color: currentColor` through it, which reproduces the drawing in whatever
 * colour the element inherits. This component's whole job on that front is to render an empty box
 * and name its artwork in an attribute; it references no asset in TypeScript at all.
 *
 * That is also why there is no static asset import here. Importing a drawing as a module is typed
 * by the generated, git-ignored `next-env.d.ts`, so a clean clone that has never run a build would
 * fail `pnpm typecheck` on it. The asset paths belong to the stylesheet, which needs no typings.
 *
 * THE VARIANTS ARE ATTRIBUTES, NOT LOOKED-UP CLASSES
 * `CategoryGlyph.module.css` exports one class, `root`, and selects both the size and the artwork
 * with attribute rules. So both props are written straight to the DOM and the styles object is
 * never indexed: a computed key is typed `string | undefined` under this repository's
 * `noUncheckedIndexedAccess` and would hide a typo until the glyph rendered blank in a browser,
 * whereas an attribute is constrained by the types below, cannot apply without the base rule, and
 * is legible in the elements tree - which is what this application is here to be inspected with.
 *
 * DECORATIVE BY CONTRACT
 * `aria-hidden="true"`, and no `role`, `aria-label`, `title` or children. The category name is
 * always adjacent text supplied by the caller, so the glyph carries no information of its own and
 * announcing it would only make a reader hear the category twice. It is never the sole carrier of
 * meaning either - which is what makes it safe for the stylesheet to let forced-colours mode drop
 * the mark entirely, and safe for two thirds of the categories to have no mark at all.
 *
 * RENDER BEHAVIOUR
 * A plain function component: no `memo`, no `useMemo`, no `useCallback`, no state, no effects, no
 * `"use client"` directive - so a server component and a client component render it equally. It
 * re-renders whenever its parent does, on purpose: the catalog's render behaviour is the subject
 * this application exists to exhibit, and a memoized chip would smooth over exactly what is meant
 * to be observed. The output depends only on the props, with nothing read from `window`,
 * `Date.now()` or `Math.random()` during render, so the server's markup and the browser's first
 * markup always agree.
 *
 * NAMING: `scripts/check-no-hardcoding.mjs` harvests this application's declared names into
 * `scripts/no-hardcoding.policy.json`, and no file of the debugging product may then contain one
 * of those literals. Only names of two or more camel-case tokens are harvested, so everything
 * declared here is deliberately single-token (`SLUGS`, `Slug`, `Props`, `isKnown`) or the already
 * policy-bound component name. A `CategorySlug` or `KNOWN_SLUGS` would enter the shared policy,
 * make the committed copy stale and fail `pnpm check:no-hardcoding`.
 */

import clsx from 'clsx';

import styles from './CategoryGlyph.module.css';

/*
 * The categories that have art, alphabetised, exactly mirroring the files in
 * `apps/demo-app/public/categories/` and the six slug rules at the end of the stylesheet beside
 * this file. These three lists are one fact in three places and move together: adding a drawing
 * means adding the file, its rule and its entry here, and a slug with no rule would render an
 * empty box while a rule with no entry here would never be reached.
 *
 * `as const` is what makes the tuple usable as a type below, and keeps it readonly so nothing can
 * push a seventh slug into it at runtime.
 */
const SLUGS = [
  'cable-reel',
  'fastener',
  'hand-tool',
  'power-tool',
  'safety-gear',
  'valve',
] as const;

/** The six slugs as a union - the narrowed form `isKnown` proves and the stylesheet can paint. */
type Slug = (typeof SLUGS)[number];

/**
 * Whether this slug is one of the six that has a drawing.
 *
 * The widening assertion on `SLUGS` is required rather than cosmetic: on the tuple's own type,
 * `includes` accepts only the union, which would reject the `string` this component is deliberately
 * given and defeat the point of checking. Asserting the array - never the input - keeps the
 * narrowing honest, and `includes` avoids the indexed lookups that `noUncheckedIndexedAccess` would
 * type as possibly `undefined`. Comparison is exact: no case folding, no trimming.
 */
function isKnown(value: string): value is Slug {
  return (SLUGS as readonly string[]).includes(value);
}

/**
 * The glyph's inputs. Local and not exported: a caller that needs this shape reads it back with
 * `React.ComponentProps<typeof CategoryGlyph>` rather than importing a second name for it. There is
 * deliberately no `label` or `name` prop and no slug-to-display-name map - the category's name is
 * the caller's text, and this file owns the artwork only.
 */
interface Props {
  /**
   * The category's slug, straight from the API or a database row - no pre-validation expected, and
   * none by the caller wanted. One of `cable-reel`, `fastener`, `hand-tool`, `power-tool`,
   * `safety-gear` or `valve` renders that drawing; every other value, including the empty string
   * and a differently-cased near miss, renders nothing at all.
   */
  slug: string;

  /**
   * Which of the stylesheet's three measures to paint, each a step of the storefront's type scale
   * because the glyph always sits beside a word and is sized to that word: `sm` (15px) for a dense
   * table row, `md` (18px) beside a chip's or a list item's label, `lg` (24px) for a section
   * heading's mark.
   *
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';

  /**
   * An extra class from the placing component, for the margin or grid position the glyph cannot
   * know about. It composes after the base class, so it wins on equal specificity; the size and
   * artwork rules are attribute-qualified and are unaffected by it.
   */
  className?: string;
}

/**
 * Renders one category glyph, or nothing when the category has no drawing.
 *
 * `styles.root` is typed `string | undefined` under `noUncheckedIndexedAccess`, which `clsx` drops
 * when it is absent: a missing class would mean the stylesheet failed to load, and an unstyled
 * empty span is invisible rather than a bare square - the safe direction to fail in for an element
 * that carries no information of its own.
 *
 * @example
 * // Inside a filter chip: the glyph inherits the chip's `color`, so it inverts with the label when
 * // the chip is selected. `category.slug` needs no checking first - that is this component's job.
 * <Pill pressed={selected} onClick={onToggle}>
 *   <CategoryGlyph slug={category.slug} size="sm" />
 *   {category.name}
 * </Pill>
 *
 * @example
 * // A dashboard grouping header, where the name is the heading's own text.
 * <h3>
 *   <CategoryGlyph slug={group.slug} size="lg" /> {group.name}
 * </h3>
 */
export function CategoryGlyph({ slug, size = 'md', className }: Props) {
  // The degradation, and the only branch in this file. Returning `null` - rather than a box with
  // no artwork - is what keeps a category without a drawing out of the DOM entirely, so there is
  // nothing to mis-paint, nothing to request and nothing to announce.
  if (!isKnown(slug)) {
    return null;
  }

  return (
    <span
      className={clsx(styles.root, className)}
      data-slug={slug}
      data-size={size}
      aria-hidden="true"
    />
  );
}
