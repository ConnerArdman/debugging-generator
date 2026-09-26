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
 * between them (`./CheckoutSummaryPanel.module.css`), the note under the figures, and the states
 * the composed components cannot cover - the totals-only placing with nothing to total, and the
 * same placing for a cart whose contents nobody established. Everything else belongs to what it
 * composes:
 *
 *   - `CartLineList` reads the cart itself and resolves its own states: a failure the shopper can
 *     retry, placeholders while the cart is first read, the block that says the cart is empty, and
 *     the lines. That is why no lines are passed to it, and why the empty case is left to it
 *     wherever the list is shown rather than being decided a second time here.
 *   - `CartTotalsPanel` reads the cart's totals itself and prints every figure - the units, the
 *     merchandise subtotal, the charge rows this column hands it, the closing figure they add up
 *     to, the free-freight state and the dispatch promise. It renders inside
 *     `@/components/ui/Card`, so `.totals` below is placement only and nothing wraps it in a
 *     second card.
 *
 * THE CHARGE ROWS ARE THIS COLUMN'S ONE CONTRIBUTION TO THE FIGURES
 * A cart knows what the merchandise comes to and nothing else, so a review column that printed
 * that subtotal as the order's total would quote a buyer less than the order they are about to
 * place - the freight they chose is part of it. So this column names the charges: the freight the
 * buyer chose, which `./CheckoutCharges` carries here from `./CheckoutForm` beside it, and the
 * discount and the tax, which the endpoint settles when it writes the order and which are
 * therefore listed with no amount rather than left out. `CartTotalsPanel` labels its closing row
 * "Estimated total" for as long as any of them is unsettled, which is the truthful description of
 * a figure assembled from a priced cart, a quoted rate and two charges nobody has computed yet.
 *
 * `variant="page"` for both, which is the arrangement `/cart` uses: the document scrolls, so
 * neither block caps its own height the way the cart drawer's compact variant does. A capped,
 * separately scrolling list beside a long checkout form would hide the very lines the column
 * exists to show.
 *
 * AND ONLY UNTIL IT HAS BEEN PLACED
 * Placing the order ends the review, and `./CheckoutCharges` is how this column learns it has been:
 * `./CheckoutForm` beside it swaps its fields for the receipt and publishes the fact, and this
 * column then shows that the order was placed instead of continuing to review it. Continuing would
 * be worse than showing nothing, on two counts. The figures would be wrong - the order was priced
 * when it was written, against the data of that moment, and the closing estimate assembled here
 * from a cart, a quoted rate and two charges nobody had computed is not what the buyer was charged -
 * and the lines carry quantity and remove controls, which would be offering changes to a cart that
 * has become an order. The receipt beside this column is where the figures that apply are printed,
 * so this column points at it rather than repeating them.
 *
 * AN ORDER IS ONLY REVIEWED WHERE THERE IS A CART TO REVIEW
 * `@/hooks/useCartSummary` publishes either the cart's totals or the reason there are none, and
 * this column asks that question first. A cart whose contents were never established - the first
 * read still in flight, or a read that came back a failure - has no order to review: the figures
 * are not shown, the charges are not quoted over a subtotal nobody read, the closing estimate is
 * not assembled from the two, and the note that qualifies them is not printed. Nor is the empty
 * block: its illustration and "nothing to review yet" assert an order with nothing in it, which is
 * a different statement from an order the storefront cannot see. Where the lines are listed, the
 * state already has its surface in `CartLineList` - the failure notice with its retry, or the
 * placeholders while the read is in flight - so this column adds nothing beside it and simply
 * shows no figures.
 *
 * NO FIGURE AND NO REQUEST ORIGINATES HERE
 * `@/hooks/useCartSummary` is read for three things only: whether the cart's contents are
 * established and hold anything at all, and the two counts the column's opening reading states.
 * Nothing is summed, no amount is divided
 * out of cents, no threshold is compared and there is no `Intl` instance in this file - every
 * string is either published by that hook or produced by `@/lib/format`, which pins the store's
 * locale, currency and time zone. The cart itself belongs to `@/providers/CartProvider`: this file
 * issues no request, keeps no copy of the lines and imports no API client.
 *
 * That still holds now that a freight amount appears in the column, and it is worth saying why:
 * the figure is *published to* this column, not derived in it. `./CheckoutForm` holds the freight
 * lookup for the destination in its own fields, prices the chosen service exactly as the service
 * group prints it, and publishes the result; this file reads that value and hands it on in a
 * charge row. No rate is looked up here, no service is chosen here, and the cents are added up by
 * the component that prints the closing row.
 *
 * THE DELIVERY ESTIMATE IS THE CHOSEN SERVICE'S, NOT THE STORE'S
 * A cart's own reading carries the storefront's standing dispatch promise, which is one transit
 * time for every shopper because a cart has no destination and no service. A review column does
 * have both - they are in the form beside it - and the services quoted for one destination differ
 * by days as much as by price, so printing the standing promise here states a delivery date for a
 * service the buyer did not choose, directly beneath the charge for the one they did. So the
 * estimate printed with these figures is always the one quoted for the chosen service: the column
 * hands the totals block the cart's reading with that one member replaced. The wording is
 * `@/lib/format`'s, the same function every other transit estimate in the storefront goes through,
 * and the dispatch cut-off beside it is untouched - that is a statement about when the warehouse
 * ships, which no choice of carrier service changes.
 *
 * The member is replaced even when no charge is published, and that case is the reason this is an
 * override rather than a fallback. With no service chosen - or none quotable for the address in
 * the fields - the cart's own reading still carries the standing promise, and printing it here
 * would put "Arrives in 2 days" under a Freight row that says the charge is still to be
 * established: a delivery date for an order with no carrier, in the one state where the page has
 * least business promising one. So it says the same thing the charge rows say, in their words.
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
import { CartTotalsPanel, type CartCharge } from '@/components/cart/CartTotalsPanel';
import { BlankSlate } from '@/components/ui/BlankSlate';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { useCartSummary, type CartSummary } from '@/hooks/useCartSummary';
import { formatQuantityLabel, formatShippingEtaLabel } from '@/lib/format';

import { useOrderPlaced, useSelectedFreight } from './CheckoutCharges';

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

/**
 * The opening reading while the cart is still being read, where there are no counts to state.
 *
 * Deliberately not {@link EMPTY_READING}: a cart nobody has read yet is not an order with nothing
 * in it, and a reader arriving at this landmark is entitled to the difference.
 */
const PENDING_READING = 'Your cart is being read, so there is nothing to review yet.';

/** The opening reading where the read came back a failure and the contents were never established. */
const UNAVAILABLE_READING = 'Your cart could not be read, so this order cannot be reviewed yet.';

/**
 * The line the totals-only placing prints in place of the figures while the contents are unknown.
 *
 * Short, because the reading above already carries the fuller sentence for a reader, and because
 * the notice a buyer acts on belongs to `CartLineList` - which this placing has turned off. It
 * states which of the two states the cart is in and nothing about what it holds.
 */
const PENDING_BODY = 'Your cart has not been read yet.';
const UNAVAILABLE_BODY = 'Your cart could not be read.';

/** The heading and sentence of the block shown when there is nothing to total. */
const EMPTY_HEADING = 'Nothing to review yet';
const EMPTY_BODY =
  'Add items to your cart and they will be listed here before you place the order.';

/**
 * The opening reading once the order has been placed, where there is no longer an order to review.
 *
 * Distinct from every other reading in this file because it is the only one that is not about the
 * cart: the lines have become an order, and what that order came to is on the receipt beside this
 * column rather than estimated here.
 */
const PLACED_READING = 'This order has been placed, so there is nothing left to review.';

/** The heading and sentence of the block this column shows in place of the review, for the same. */
const PLACED_HEADING = 'Order placed';
const PLACED_BODY =
  'The items you ordered, what they came to and where they are going are on the confirmation ' +
  'beside this column.';

/**
 * Alternative text for that block's illustration, which `@/components/ui/BlankSlate` draws from
 * `public/illustrations/empty-cart.svg`. The caller chooses it because only the caller knows what
 * its own heading says.
 *
 * It serves the placed-order block below as well, because alternative text describes the drawing
 * rather than the heading beside it, and both blocks draw the same one - a cart with nothing in it,
 * which is what a cart that has become an order leaves behind.
 */
const EMPTY_ART_ALT = 'An empty shopping cart';

/* ---------------------------------------------------------------------------
 * The charge rows
 *
 * Three rows, in the order a buyer reads them, and each is a statement about what is known rather
 * than a figure invented to fill a column. Their ids are the charges' own names, which is what
 * `CartCharge` keys its rows on; their labels are what the column prints.
 * ------------------------------------------------------------------------- */

/** The freight row: the rate quoted for the service chosen in the form beside this column. */
const FREIGHT_CHARGE_ID = 'freight';
const FREIGHT_CHARGE_LABEL = 'Freight';

/**
 * The delivery estimate before a freight service has been quoted and chosen.
 *
 * Worded as the charge rows beside it are worded, and for the same reason: transit time is a
 * property of the service the order ships by, so with no service there is no estimate to state -
 * only the fact that there is not one yet. It reads after the row's visually-hidden "Delivery
 * estimate:" prefix, so the sentence is a completion of that phrase rather than a sentence of its
 * own.
 */
const UNQUOTED_DELIVERY_LABEL = 'Confirmed once a shipping service is quoted';

/**
 * The discount row. Listed with no amount on purpose: contract prices and promotions are applied
 * by the checkout service against the data of the moment, so the only honest thing this review can
 * say about them is that they are settled on the order.
 */
const DISCOUNT_CHARGE_ID = 'discounts';
const DISCOUNT_CHARGE_LABEL = 'Discounts';

/** The tax row, for the same reason: the order's destination decides it, and the order is not
 * written yet. */
const TAX_CHARGE_ID = 'tax';
const TAX_CHARGE_LABEL = 'Tax';

/**
 * The caption under the figures: what the rows above it are and are not.
 *
 * Every clause is load-bearing, and each one is a claim some server stands behind. The freight
 * figure is the rate the carrier quoted for this shipment - these units, to this destination, by
 * the chosen service - which is the same question `POST /api/checkout` puts to the carrier when it
 * writes the order, so the note says it is quoted for the order and re-rated when the order is
 * placed rather than promising it as the final charge. The discount and the tax carry no amount
 * because the checkout request works both out against the data of the moment. And the closing
 * figure is called an estimate for exactly as long as any of that is unsettled.
 *
 * What the note deliberately does not mention is a freight allowance. The storefront's
 * free-freight offer is a property of the cart's merchandise subtotal and the checkout service
 * charges the quoted freight whatever that subtotal is, so a clause about an allowance being
 * "settled on the order" would be this page promising a reduction no server applies.
 */
const REVIEW_NOTE =
  'Freight is the rate quoted for these units, this destination and the chosen service, and it is ' +
  're-rated when the order is placed. Discounts and tax are worked out on the order at that ' +
  'point, so the total above is an estimate rather than the final charge.';

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
  const freight = useSelectedFreight();
  const placed = useOrderPlaced();

  const trimmed = heading.trim();
  const title = trimmed.length > 0 ? trimmed : DEFAULT_HEADING;

  /*
   * Once the order has been placed there is nothing here to review, and going on reviewing would
   * be worse than showing nothing. The cart those lines came from is an order now: it was priced
   * when the order was written, against the data of that moment, so the closing figure this column
   * assembles is no longer the figure the buyer was charged - and the lines carry quantity controls,
   * which would be offering changes to a cart that no longer exists. So the column says the order
   * was placed and points at the receipt, which is where the figures that do apply are printed.
   *
   * It is returned before anything else is worked out, because none of it is about this state: the
   * counts, the charge rows and the note all describe an order under review.
   */
  if (placed) {
    return (
      <section className={clsx(styles.root, className)} aria-label={title}>
        <h2 className={styles.heading}>{title}</h2>
        <VisuallyHidden>{PLACED_READING}</VisuallyHidden>

        <div className={styles.empty}>
          <BlankSlate art="empty-cart" alt={EMPTY_ART_ALT} heading={PLACED_HEADING}>
            {PLACED_BODY}
          </BlankSlate>
        </div>
      </section>
    );
  }

  /*
   * One sentence, read only to assistive technology, that says what the column covers before
   * either block below it is reached. A shopper sees the same thing at a glance from the lines and
   * the figures; a reader arriving at the landmark has neither yet.
   *
   * Which sentence it is turns on whether the cart's contents are established at all.
   * `@/hooks/useCartSummary` publishes either the totals or the reason there are none, so an
   * unread cart states that it is unread: the counts do not exist to be quoted, and "there is
   * nothing in this order yet" would tell a buyer their cart is empty when the storefront simply
   * cannot see it. The counts come from the summary rather than being counted here -
   * `unitCountLabel` is the grouped wording the hook publishes, and the line count goes through
   * the same formatter every other count in the storefront does.
   */
  let reading: string;
  if (!summary.contentsKnown) {
    reading = summary.unknownReason === 'loading' ? PENDING_READING : UNAVAILABLE_READING;
  } else if (summary.isCartEmpty) {
    reading = EMPTY_READING;
  } else {
    const units = `${summary.unitCountLabel} ${
      summary.unitCount === 1 ? UNIT_NOUN : UNIT_NOUN_PLURAL
    }`;
    const products = `${formatQuantityLabel(summary.lineCount)} ${
      summary.lineCount === 1 ? PRODUCT_NOUN : PRODUCT_NOUN_PLURAL
    }`;

    reading = `${units} ${ACROSS_WORD} ${products}`;
  }

  /*
   * The figures are shown whenever there is a cart to total, and also whenever the lines are
   * listed - `CartLineList` says that the cart is empty in that case, and the figures beneath it
   * still state the free-freight offer. Only the totals-only placing with an empty cart has
   * nothing to print, and that is the one state this column resolves itself.
   *
   * A cart whose contents are not established shows no figures at all, whichever placing this is:
   * charges quoted over a subtotal nobody read, and a closing figure assembled from the two, would
   * be an estimate of an order the storefront cannot see. Where the lines are listed, that state
   * already has a surface - `CartLineList` carries the failure notice with its retry, or the
   * placeholders while the read is in flight - so this column adds nothing beside it; where they
   * are not, the block below states it in a line of its own.
   */
  const totalsShown = summary.contentsKnown && (showLines || !summary.isCartEmpty);

  /*
   * What the order adds to the merchandise subtotal, as the totals block prints it.
   *
   * The freight row is the published charge when the buyer has chosen a service and a rate exists
   * for it - with the service's own wording as the row's quiet detail, so the row says which
   * service the figure is for - and a row with no amount before that, because a freight charge
   * nobody has quoted yet is not a freight charge of nothing. The other two carry no amount at
   * all: the checkout service applies contract prices and promotions and works out tax when it
   * writes the order, so this column lists them as charges still to be settled rather than
   * omitting them and letting the closing figure look complete.
   *
   * Built on each render and handed straight down. There is no `useMemo` here and none is wanted:
   * the block below holds no `memo`, so a stable array identity would buy nothing.
   */
  const charges: readonly CartCharge[] = [
    freight === null
      ? { id: FREIGHT_CHARGE_ID, label: FREIGHT_CHARGE_LABEL, amountCents: null }
      : {
          id: FREIGHT_CHARGE_ID,
          label: FREIGHT_CHARGE_LABEL,
          detail: freight.label,
          amountCents: freight.amountCents,
        },
    { id: DISCOUNT_CHARGE_ID, label: DISCOUNT_CHARGE_LABEL, amountCents: null },
    { id: TAX_CHARGE_ID, label: TAX_CHARGE_LABEL, amountCents: null },
  ];

  /*
   * The cart's reading as the figures are printed from, with the delivery estimate re-stated for
   * the service the buyer chose; see the header.
   *
   * One member is replaced and every other is passed through untouched, including the dispatch
   * countdown - so the line beneath the figures reads "Arrives in 5 days" for the five-day service
   * chosen beside it while still carrying the store's own cut-off, and reads
   * {@link UNQUOTED_DELIVERY_LABEL} beside that same cut-off when no service has been quoted.
   *
   * `CartSummary` is two different statements about a cart - its totals, or the reason there are
   * none - and the annotation is what keeps them apart: the spread carries `contentsKnown` and
   * every member of whichever reading this is straight through, so replacing the estimate cannot
   * turn a cart nobody read into one that appears to have figures, and the compiler would refuse
   * the assignment if it did.
   */
  const reviewedTotals: CartSummary = {
    ...summary,
    estimatedDeliveryLabel:
      freight === null ? UNQUOTED_DELIVERY_LABEL : formatShippingEtaLabel(freight.estimatedDays),
  };

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
          <CartTotalsPanel
            variant="page"
            heading={SUPPRESSED_TOTALS_HEADING}
            summary={reviewedTotals}
            charges={charges}
          />
        </div>
      ) : null}

      {/*
        The two states the column resolves itself, and neither of them is the other. A cart the
        server answered with nothing in gets the blank slate, which says so; a cart whose contents
        nobody established gets a line stating that instead, because the illustration and "nothing
        to review yet" would both assert an empty order the storefront never saw. Where the lines
        are listed there is nothing to add in either case - `CartLineList` owns the empty block and
        the failure notice for the same cart - so this is the totals-only placing alone.

        `.empty` is placement - it gives the block room in the column - so it goes on a wrapper
        rather than on `BlankSlate`, whose own module owns the column the illustration, heading and
        sentence are stacked in. No `action`: this file has no token-styled link of its own, and
        the site header offers the way back to the catalog from every page.
      */}
      {totalsShown || showLines ? null : (
        <div className={styles.empty}>
          {summary.contentsKnown ? (
            <BlankSlate art="empty-cart" alt={EMPTY_ART_ALT} heading={EMPTY_HEADING}>
              {EMPTY_BODY}
            </BlankSlate>
          ) : (
            <p className={styles.meta}>
              {summary.unknownReason === 'loading' ? PENDING_BODY : UNAVAILABLE_BODY}
            </p>
          )}
        </div>
      )}

      {/* The note explains what the figures above it leave out, so it is printed only when there
          are figures to qualify - never for an empty cart, and never for one whose contents were
          not established, where there is no estimate for it to qualify. */}
      {summary.contentsKnown && !summary.isCartEmpty ? (
        <p className={styles.meta}>{REVIEW_NOTE}</p>
      ) : null}
    </section>
  );
}
