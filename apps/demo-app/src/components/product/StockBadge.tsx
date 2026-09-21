/**
 * Lumen Supply - the availability chip on a product detail page.
 *
 * It answers the one question a buyer asks beside the add-to-cart control: can this product be
 * ordered right now, and how much of it? The chip itself is `@/components/ui/Badge`, which knows
 * nothing about stock and nothing about this application's data model; this component is the piece
 * that turns a `StockState` into one of that primitive's five tones and hands it a label
 * `@/lib/format` has already worded.
 *
 * WHY THE MAPPING LIVES HERE
 * Three surfaces show availability - this chip, the catalog card and the dashboard's low-stock
 * list - and each of them phrases and sizes it differently. Pushing the state-to-tone decision
 * down into the badge would make every new availability state a change to the storefront's
 * smallest primitive; keeping it here leaves the primitive domain-agnostic and puts the decision
 * in the component whose design it belongs to.
 *
 * A SERVER COMPONENT
 * No `'use client'`, no hooks, no state and nothing read from the browser or the clock: the
 * product route already holds the payload and passes the two fields below as props, so the markup
 * the server sends is the markup the browser keeps. That also lets a server component and a client
 * component place it equally.
 *
 * COLOUR IS NEVER THE MESSAGE
 * `formatStockLabel` names the state in words, so the chip reads the same in greyscale, through a
 * screen reader and to anyone who cannot separate the green from the red. The tone and the leading
 * dot only reinforce that text, which is also why nothing here adds a `role` or an `aria-label`:
 * the label is the information, and renaming it would only hide it.
 *
 * LAYOUT
 * The wrapper is a bare flex box owned by `StockBadge.module.css`: it wraps, so on a narrow
 * viewport the note drops under the chip rather than widening the line of product copy it sits on,
 * and it carries no colour, border or padding of its own - the chip already knows how to look.
 */

import clsx from 'clsx';

import type { ComponentProps, ReactElement } from 'react';

import { Badge } from '@/components/ui/Badge';
import { formatQuantityLabel, formatStockLabel } from '@/lib/format';
import type { StockState } from '@/lib/types';

import styles from './StockBadge.module.css';

/**
 * The tones the badge accepts, read off the component rather than restated here. The five
 * literals are declared once, in the primitive that owns the stylesheet selecting them, so a tone
 * renamed there becomes a compile error in the map below instead of a chip that quietly renders
 * unstyled.
 */
type StockTone = NonNullable<ComponentProps<typeof Badge>['tone']>;

/**
 * The chip's inputs: the two fields the product payload already carries, and nothing else.
 *
 * Local and deliberately not exported, like every other props type in this workspace - a page that
 * needs the shape writes `ComponentProps<typeof StockBadge>` rather than putting a second name
 * into circulation.
 */
interface Props {
  /**
   * How freely the product can be sold, as the server derived it for this payload
   * (`ProductSummary.stockState`). It is a presentation state, not a stored column, so this
   * component re-applies no threshold of its own.
   */
  state: StockState;

  /**
   * Units available to promise across every warehouse (`ProductSummary.availableQuantity`). The
   * chip's label prints it, so the caller passes it for every state - including the one whose
   * label has no number to print.
   */
  available: number;

  /**
   * The placing component's own class, composed after the module's `root` class for the margin or
   * grid position the chip cannot know about.
   */
  className?: string | undefined;
}

/**
 * Which tone paints each availability state.
 *
 * A `Record` over the finite union rather than a `switch` with a `default`: a fourth state added
 * to `StockState` becomes a compile error right here instead of falling through to a neutral chip
 * that says nothing, and indexing the map with a `StockState` yields a tone rather than
 * `StockTone | undefined` under this repository's `noUncheckedIndexedAccess`.
 */
const STOCK_TONES: Record<StockState, StockTone> = {
  IN_STOCK: 'success',
  LOW_STOCK: 'warning',
  OUT_OF_STOCK: 'danger',
};

/**
 * Which state the wrapper marks with `data-emphasis="true"` - the attribute
 * `StockBadge.module.css` keys the note's danger colour off. Only the state a product cannot be
 * ordered in is emphasised; the other two are ordinary availability, where a supporting line
 * should read as quietly as it looks. Exhaustive for the same reason as the tone map above, and an
 * attribute rather than a second class name because a variant class would have to be read through
 * a computed key that hides a typo until the page renders.
 *
 * It doubles as the test for whether the chip has left a number for the note to add:
 * `formatStockLabel` prints the units to promise beside every state that has any to promise and
 * drops the count from the unsellable one, so this is exactly the state where a count is new
 * information rather than a repetition of the label.
 */
const STOCK_EMPHASIS: Record<StockState, boolean> = {
  IN_STOCK: false,
  LOW_STOCK: false,
  OUT_OF_STOCK: true,
};

/**
 * Render the availability chip for one product, with the supporting count where there is one.
 *
 * @example
 * // On the product detail page, from the payload the route already resolved.
 * <StockBadge state={product.stockState} available={product.availableQuantity} />
 */
export function StockBadge({ state, available, className }: Props): ReactElement {
  const emphasise = STOCK_EMPHASIS[state];

  // A display-only clamp. A negative figure reaches this component whenever a payload counts more
  // units promised than held, and `In stock (-3)` is a worse thing to print than `In stock (0)`.
  // Nothing is written back anywhere, so the clamp changes the sentence and not the data. A
  // missing count survives it unchanged - `Math.max` leaves `NaN` alone - and reaches
  // `formatQuantityLabel`, which prints an em dash for it instead of a zero the page would be
  // asserting as fact.
  const units = Math.max(0, Math.trunc(available));

  // The note is worth a line only when it says something the chip's label does not: a real count
  // against a product nothing can be ordered from. An em dash on its own would be a line with no
  // content, so a count the page cannot print does not get one.
  const counted = emphasise && Number.isFinite(units) && units > 0;

  return (
    <span className={clsx(styles.root, className)} data-emphasis={emphasise ? 'true' : undefined}>
      <Badge tone={STOCK_TONES[state]} dot>
        {formatStockLabel(state, units)}
      </Badge>
      {counted ? (
        <span className={styles.note}>{formatQuantityLabel(units)} reported available</span>
      ) : null}
    </span>
  );
}
