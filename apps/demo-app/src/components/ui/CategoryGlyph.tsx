/*
 * Lumen Supply - the category glyph: a small mark before a category's name in the catalog's
 * filter chips and the dashboard's category grouping headers.
 *
 * Only the six slugs with a drawing in `public/categories/` render; any other slug renders
 * nothing - no element, no request, no fallback icon - so a chip for a category without art is
 * simply a chip with a word in it. Matching is exact, with no lowercasing or trimming: `'Valve'`
 * and `' valve'` render nothing rather than a guess about the spelling. `slug` is a plain
 * `string` narrowed here, once, so no caller can skip the check with a cast.
 *
 * The element is an empty `<span>`. `CategoryGlyph.module.css` uses the asset as a `mask-image`
 * and paints `background-color: currentColor` through it, so the glyph follows the chip's text
 * colour into a selected chip's inversion, which an image element cannot do. `.root` declares no
 * mask and a transparent fill, so an unmatched slug that reached the DOM would still paint
 * nothing. There is no static asset import: those are typed only by the generated, git-ignored
 * `next-env.d.ts`, so the asset paths belong to the stylesheet.
 *
 * Size and artwork are data attributes, not classes looked up in `styles`, so the prop unions
 * constrain them and no computed key is typed `string | undefined` under
 * `noUncheckedIndexedAccess`.
 *
 * Decorative: `aria-hidden="true"`, with no role, label or text; the category name is always the
 * caller's adjacent text. No state, effects or client directive, so it renders on either side.
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
