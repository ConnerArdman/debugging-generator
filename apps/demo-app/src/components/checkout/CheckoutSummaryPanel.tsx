'use client';

/*
 * CheckoutSummaryPanel - the order-review column of the /checkout page.
 *
 * The column answers one question for a buyer about to commit: what exactly am I ordering, and
 * what does it come to? It answers it with the two components the /cart page already uses, in
 * their page arrangement - `@/components/cart/CartLineList` for the lines and
 * `@/components/cart/CartTotalsPanel` for the figures - so the cart a shopper reviewed a moment
 * ago and the order they are about to place are quoted identically. A line row, a quantity
 * control, a money row or a subtotal written a second time here would be a second opinion about
 * the same cart, and the two would disagree the first time either side changed.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DELEGATES
 * It owns the column: the landmark and its heading, the order the blocks are read in, the rhythm
 * between them (`./CheckoutSummaryPanel.module.css`), the note under the figures, and the one
 * state the composed components cannot cover - the totals-only placing with nothing to total.
 * Everything else belongs to what it composes:
 *
 *   - `CartLineList` reads the cart itself and resolves its own states: a failure the shopper can
 *     retry, placeholders while the cart is first read, the block that says the cart is empty, and
 *     the lines. That is why no lines are passed to it, and why the empty case is left to it
 *     wherever the list is shown rather than being decided a second time here.
 *   - `CartTotalsPanel` reads the totals itself and prints every figure - the units, the subtotal,
 *     the closing total, the free-freight state and the dispatch promise. It renders inside
 *     `@/components/ui/Card`, so `.totals` below is placement only and nothing wraps it in a
 *     second card.
 *
 * `variant="page"` for both, which is the arrangement `/cart` uses: the document scrolls, so
 * neither block caps its own height the way the cart drawer's compact variant does. A capped,
 * separately scrolling list beside a long checkout form would hide the very lines the column
 * exists to show.
 *
 * NO FIGURE AND NO REQUEST ORIGINATES HERE
 * `@/hooks/useCartSummary` is read for three things only: whether the cart holds anything at all,
 * and the two counts the column's opening reading states. Nothing is summed, no amount is divided
 * out of cents, no threshold is compared and there is no `Intl` instance in this file - every
 * string is either published by that hook or produced by `@/lib/format`, which pins the store's
 * locale, currency and time zone. The cart itself belongs to `@/providers/CartProvider`: this file
 * issues no request, keeps no copy of the lines and imports no API client.
 *
 * HEADINGS AND THE READING ORDER
 * The column is a `<section>` named by its own heading, so it is reachable as a landmark, and that
 * heading is an `<h2>` - the level `./CheckoutForm` uses for each of its own sections under the
 * page's `<h1>`. Because the column is titled here, `CartTotalsPanel` is handed a blank heading,
 * which suppresses its head slot rather than putting a second title into the outline for the same
 * block of figures. The reading order is heading, opening reading, lines, figures, note.
 *
 * Nothing in this file reads a clock, a random source, `window` or `document`, and it schedules
 * nothing, so the markup the server renders and the markup the browser first produces agree and
 * the column raises no hydration warning.
 */

import clsx from 'clsx';
import type { ReactElement } from 'react';

import { CartLineList } from '@/components/cart/CartLineList';
import { CartTotalsPanel } from '@/components/cart/CartTotalsPanel';
import { BlankSlate } from '@/components/ui/BlankSlate';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { useCartSummary } from '@/hooks/useCartSummary';
import { formatQuantityLabel } from '@/lib/format';

import styles from './CheckoutSummaryPanel.module.css';

/** The column's heading, and its accessible name, when the page does not name it itself. */
const DEFAULT_HEADING = 'Order review';

/**
 * What `CartTotalsPanel` is given as its heading.
 *
 * Blank on purpose: that component suppresses its head slot for a blank heading, which is what a
 * surface that has already titled the column should ask for. See the header.
 */
const SUPPRESSED_TOTALS_HEADING = '';

/** Singular and plural of the unit count: eight of one product and two of another read as ten. */
const UNIT_NOUN = 'unit';
const UNIT_NOUN_PLURAL = 'units';

/** Singular and plural of the line count. A single line holding five units is common here. */
const PRODUCT_NOUN = 'product';
const PRODUCT_NOUN_PLURAL = 'products';

/** Joins the two counts of the opening reading: "10 units across 3 products". */
const ACROSS_WORD = 'across';

/** The opening reading when the cart holds no lines, where the two counts say nothing useful. */
const EMPTY_READING = 'There is nothing in this order yet.';

/** The heading and sentence of the block shown when there is nothing to total. */
const EMPTY_HEADING = 'Nothing to review yet';
const EMPTY_BODY =
  'Add items to your cart and they will be listed here before you place the order.';

/**
 * Alternative text for that block's illustration, which `@/components/ui/BlankSlate` draws from
 * `public/illustrations/empty-cart.svg`. The caller chooses it because only the caller knows what
 * its own heading says.
 */
const EMPTY_ART_ALT = 'An empty shopping cart';

/**
 * The caption under the figures: what the column does not yet include, stated as a note about the
 * review rather than as an amount. Freight, discounts and tax belong to the order the checkout
 * request creates, so quoting any of them beside a cart subtotal would put a figure on the page
 * that no server computed.
 */
const REVIEW_NOTE = 'Freight, discounts and tax are confirmed on the order when it is placed.';

/**
 * The column's inputs.
 *
 * Local and deliberately not exported, like every other props type in this workspace: a caller
 * that needs the shape writes `ComponentProps<typeof CheckoutSummaryPanel>` rather than putting a
 * second name into circulation. The optional fields are spelled `?: T | undefined` because
 * `exactOptionalPropertyTypes` is on here, so a caller may pass a value it is still resolving -
 * including the `string | undefined` a CSS Module lookup is typed as - straight through instead of
 * assembling the element's props conditionally.
 */
interface Props {
  /**
   * The column's heading, and its accessible name. Blank or whitespace falls back to the default
   * rather than suppressing the heading: a region with no name is not a landmark, and the column's
   * blocks would then be read with nothing to attach them to.
   *
   * @default 'Order review'
   */
  heading?: string | undefined;

  /**
   * Whether the reviewed lines are listed above the figures. Leave it on for the checkout column,
   * which is the only place the buyer sees them; turn it off for a placing whose page already
   * lists the cart, where the column then carries the figures alone.
   *
   * @default true
   */
  showLines?: boolean | undefined;

  /** The placing page's own class, for the geometry a column cannot know about. */
  className?: string | undefined;
}

/**
 * Render the order under review: its lines, what it comes to, and what is still to be added.
 *
 * @example The checkout page's second column, beside the form.
 * ```tsx
 * <CheckoutSummaryPanel />
 * ```
 *
 * @example A placing that lists the cart itself and wants the figures only.
 * ```tsx
 * <CheckoutSummaryPanel heading="Order total" showLines={false} />
 * ```
 */
export function CheckoutSummaryPanel({
  heading = DEFAULT_HEADING,
  showLines = true,
  className,
}: Props): ReactElement {
  const summary = useCartSummary();

  const trimmed = heading.trim();
  const title = trimmed.length > 0 ? trimmed : DEFAULT_HEADING;

  /*
   * The counts as words, taken from the summary rather than counted here: `unitCountLabel` is the
   * grouped wording the hook publishes, and the line count goes through the same formatter every
   * other count in the storefront does.
   */
  const units = `${summary.unitCountLabel} ${summary.unitCount === 1 ? UNIT_NOUN : UNIT_NOUN_PLURAL}`;
  const products = `${formatQuantityLabel(summary.lineCount)} ${
    summary.lineCount === 1 ? PRODUCT_NOUN : PRODUCT_NOUN_PLURAL
  }`;

  /*
   * One sentence, read only to assistive technology, that says what the column covers before
   * either block below it is reached. A shopper sees the same thing at a glance from the lines and
   * the figures; a reader arriving at the landmark has neither yet.
   */
  const reading = summary.isCartEmpty ? EMPTY_READING : `${units} ${ACROSS_WORD} ${products}`;

  /*
   * The figures are shown whenever there is a cart to total, and also whenever the lines are
   * listed - `CartLineList` says that the cart is empty in that case, and the figures beneath it
   * still state the free-freight offer. Only the totals-only placing with an empty cart has
   * nothing to print, and that is the one state this column resolves itself.
   */
  const totalsShown = showLines || !summary.isCartEmpty;

  return (
    <section className={clsx(styles.root, className)} aria-label={title}>
      <h2 className={styles.heading}>{title}</h2>
      <VisuallyHidden>{reading}</VisuallyHidden>

      {/*
        The wrapper carries the rule above the lines and the air beneath it; the list owns its own
        column, rows and states, and reads the cart for itself.
      */}
      {showLines ? (
        <div className={styles.lines}>
          <CartLineList variant="page" />
        </div>
      ) : null}

      {totalsShown ? (
        <div className={styles.totals}>
          <CartTotalsPanel variant="page" heading={SUPPRESSED_TOTALS_HEADING} />
        </div>
      ) : (
        /*
         * `.empty` is placement - it gives the block room in the column - so it goes on a wrapper
         * rather than on `BlankSlate`, whose own module owns the column the illustration, heading
         * and sentence are stacked in. No `action`: this file has no token-styled link of its own,
         * and the site header offers the way back to the catalog from every page.
         */
        <div className={styles.empty}>
          <BlankSlate art="empty-cart" alt={EMPTY_ART_ALT} heading={EMPTY_HEADING}>
            {EMPTY_BODY}
          </BlankSlate>
        </div>
      )}

      {/* The note explains what the figures above it leave out, so it is printed only when there
          are figures to qualify. */}
      {summary.isCartEmpty ? null : <p className={styles.meta}>{REVIEW_NOTE}</p>}
    </section>
  );
}
