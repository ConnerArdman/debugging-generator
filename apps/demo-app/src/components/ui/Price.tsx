/**
 * Price - the money figure of the Lumen Supply storefront.
 *
 * Catalog cards, product detail, cart lines, checkout totals, order history and the dashboard's
 * inventory-value column all print money through this one component, and nothing else in the
 * application formats a monetary value itself. That is the reason it exists: a storefront whose
 * figures are assembled in six places is a storefront whose figures eventually disagree with one
 * another, and a reader who spots two spellings of the same amount stops trusting both.
 *
 * ITS INPUT IS INTEGER CENTS
 * `@/lib/types` denominates every monetary field as a whole number of cents in a property whose
 * name ends in `Cents`, and that is exactly what this component takes. It accepts no
 * pre-formatted string, no currency prop and no locale prop: each of those would be an invitation
 * to format money somewhere else and hand the result here merely to be painted, which is the one
 * thing this component exists to prevent. One formatter, one currency, one locale, application
 * wide.
 *
 * ONE FORMATTER, AND WHY THAT DECIDES HYDRATION
 * The text comes from `formatPriceLabel` in `@/lib/format`, whose number formatter is built with
 * an explicit locale and currency rather than the ambient ones. A formatter built without them
 * resolves against whichever environment constructs it, so a server render and the browser's
 * first render can disagree about the group separator or the decimal mark - and money, being the
 * most separator-dense text on a storefront, is the value most likely to turn that disagreement
 * into a hydration mismatch. Keeping the only formatting path in a single, fully pinned module is
 * what buys the guarantee; calling it from here rather than reimplementing it is how this
 * component holds up its end.
 *
 * NO ARITHMETIC ON THE WAY THROUGH
 * `cents` is handed to the formatter exactly as received - not rounded, not clamped, not divided,
 * not coerced. A figure that arrives wrong therefore surfaces as text a reader and a test can
 * both see, instead of being quietly tidied into something plausible here. The formatter already
 * owns the two decisions that would otherwise tempt a caller into arithmetic: it converts the
 * minor unit to the major one, and it prints a placeholder dash for a value that is not finite,
 * so a missing amount reads as missing rather than as a broken number.
 *
 * THE VARIANT IS AN ATTRIBUTE, NOT A LOOKED-UP CLASS
 * `Price.module.css` exports exactly one class, `root`, and selects the three sizes, the three
 * tones and the struck figure with `.root[data-size='...']`, `.root[data-tone='...']` and
 * `.root[data-strike='true']`. So this component sets attributes and never indexes the styles
 * object: a computed key is typed `string | undefined` under this repository's
 * `noUncheckedIndexedAccess` and hides a typo until the figure renders unstyled in a browser,
 * whereas an attribute is constrained by the prop unions below and is legible in the elements
 * tree - which is what this application exists to be inspected with.
 *
 * `data-size` and `data-tone` are always written, because the stylesheet describes `md` and
 * `default` in its base rule and a second declaration of either would be one more place to drift.
 * `data-strike` is written only when it is true: React omits an attribute whose value is
 * `undefined`, and that omission is what keeps `[data-strike]` from ever matching a price that is
 * actually being charged.
 *
 * THE STRUCK FIGURE CARRIES NO HIDDEN TEXT
 * `strike` asks the stylesheet for its line through the digits and does nothing else. It adds no
 * visually hidden wording, because only the caller knows what the comparison is about - a
 * was-price, a pre-discount subtotal, a superseded quote - and a generic phrase injected here
 * would be read out beside every one of them. An `<s>` element is not used either: screen readers
 * do not announce its boundaries by default, so it would add an element without adding
 * information while splitting the target the stylesheet already selects by attribute. The
 * accessible reading of a comparison is therefore the caller's to supply, in words, in its own
 * markup, beside the struck figure.
 *
 * RENDER BEHAVIOUR
 * A plain function component: no `memo`, no `useMemo`, no `useCallback`, no state, no effects,
 * and nothing read from `window`, `Date.now()` or `Math.random()` while rendering, so the markup
 * the server sends and the markup the browser first produces always agree. It re-renders whenever
 * its parent does, deliberately: prices sit inside cart lines and catalog cards whose re-render
 * behaviour is the subject under investigation in this application, and a memoized figure would
 * hide exactly the cadence an investigation is trying to observe. Holding no hooks, and no client
 * directive either, also lets a server component and a client component render it equally.
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
   */
  className?: string;
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
