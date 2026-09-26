/**
 * Price - the money figure of the Lumen Supply storefront. Every monetary value in the application
 * is printed through this component, so no two surfaces can spell the same amount differently.
 *
 * The input is integer cents - a `...Cents` field of `@/lib/types` - with no pre-formatted string,
 * currency or locale prop. The only formatting path is `formatPriceLabel` in `@/lib/format`, whose
 * formatter pins its locale and currency, so the server render and the browser's first render
 * produce the same separators and the figure cannot cause a hydration mismatch. `cents` reaches
 * the formatter without rounding, clamping or coercion, so a wrong amount surfaces as visible
 * text; the formatter converts to the major unit and prints a dash for a non-finite value.
 *
 * Size, tone and strike are data attributes selected by `Price.module.css`, never classes looked
 * up in `styles`. `data-size` and `data-tone` are always written; `data-strike` is written only
 * when true, so `[data-strike]` never matches a price that is actually being charged.
 *
 * The struck figure carries no hidden text and is not an `<s>`: only the caller knows what the
 * comparison is about - a was-price, a pre-discount subtotal - so the caller supplies the
 * accessible wording beside it. No state, effects or client directive; renders on either side.
 */

import clsx from 'clsx';

import { formatPriceLabel } from '@/lib/format';

import styles from './Price.module.css';

/**
 * The figure's inputs. Local and deliberately not exported: nothing else in the application needs
 * to name this shape, a second exported name for it would be a second thing to keep in step, and
 * a caller that does need the props reads them from the component with
 * `React.ComponentProps<typeof Price>`. The tone and size unions are spelled out here rather than
 * shared with the badge and the pill; the words overlap by intention, and repeating three string
 * literals keeps each primitive readable on its own.
 */
interface Props {
  /**
   * The amount, as a whole number of cents - a `...Cents` field of `@/lib/types` passed straight
   * through. Never a major-unit amount and never a string: the component does no conversion and
   * no parsing, so a value in the wrong unit renders as the wrong figure rather than being
   * guessed at.
   */
  cents: number;

  /**
   * Which step of the shared type scale the figure is set in, chosen by where it appears rather
   * than by how large it should look: `sm` for a secondary or compare-at figure, `md` for cart
   * lines, table cells and catalog cards, `lg` for the single headline figure on a page.
   *
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';

  /**
   * How much weight the figure carries. `default` is the primary text colour at semibold;
   * `muted` recedes, for a unit price under a line total or a subtotal that is not the amount
   * being paid; `accent` marks a promotional figure with an underline in the brand colour.
   *
   * @default 'default'
   */
  tone?: 'default' | 'muted' | 'accent';

  /**
   * Draws a line through the digits: this is the price that is not being charged. Pair it with
   * `tone="muted"` for the canonical compare-at figure, and put the words that explain the
   * comparison in the surrounding markup - this component states the presentation only.
   *
   * @default false
   */
  strike?: boolean;

  /**
   * An extra class from the placing component, for the grid position, the text alignment or the
   * margin that a figure cannot know about. It is composed after the base class, so it wins on
   * equal specificity; the size, tone and strike rules are attribute-qualified and are unaffected
   * by it.
   *
   * It spells `| undefined` out, as `ui/Card` and `ui/Skeleton` do, because this workspace
   * compiles with `exactOptionalPropertyTypes`: a bare `className?: string` means "absent or a
   * string" and rejects the present-but-undefined value every realistic caller holds, since a CSS
   * Module lookup is typed `string | undefined` under `noUncheckedIndexedAccess` and the caller
   * pattern is exactly `className={styles.someCell}`.
   */
  className?: string | undefined;
}

/**
 * Renders one monetary amount.
 *
 * @example
 * ```tsx
 * // A cart line total, the headline figure on product detail, and a compare-at pair.
 * <Price cents={line.lineTotalCents} />
 * <Price cents={product.priceCents} size="lg" />
 * <span>
 *   was <Price cents={listPriceCents} size="sm" tone="muted" strike />
 * </span>
 * ```
 */
export function Price({ cents, size = 'md', tone = 'default', strike = false, className }: Props) {
  return (
    <span
      className={clsx(styles.root, className)}
      data-size={size}
      data-tone={tone}
      data-strike={strike ? 'true' : undefined}
    >
      {formatPriceLabel(cents)}
    </span>
  );
}
