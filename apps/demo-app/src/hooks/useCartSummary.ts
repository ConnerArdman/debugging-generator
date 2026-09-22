'use client';

/**
 * Lumen Supply - the cart's totals, as the storefront prints them.
 *
 * Four surfaces quote the same cart at once: the header badge counts the units in it, the cart
 * drawer and the `/cart` page print the subtotal with how much more buys free freight, and the
 * checkout summary repeats both beside the order being placed. The figures are worked out here,
 * in one place, so none of those surfaces can arrive at a different answer from the others.
 *
 * A FIGURE IS PUBLISHED ONLY WHERE THERE IS A CART BEHIND IT
 * The cart's lines come from a read of the server, so an empty array is two different statements:
 * a cart the server answered with nothing in, or contents that a read still in flight, a read
 * already failed, or a change outstanding over a cart nobody ever read has never established. The
 * provider states that distinction on its own `lines` member, and this module is where the
 * storefront decides it once - from positive evidence that the server answered, never from the
 * absence of a failure. What is published is therefore a union -
 * totals for a cart whose contents are established, and the state on its own for a cart whose are
 * not - discriminated by `contentsKnown`, so a surface cannot reach a count or a subtotal without
 * first establishing that there is a cart behind it. There is no zero standing in for an unread
 * cart anywhere below: a count of none, a subtotal of nothing and the word "empty" are all claims
 * about contents somebody read, and a surface printing one of them for a cart nobody read would
 * tell a buyer their cart is empty when the truth is that the storefront cannot see it.
 *
 * EVERY FIGURE PUBLISHED HERE IS MERCHANDISE ONLY, AND NONE OF THEM IS AN ORDER TOTAL
 * The lines the cart holds are all this module can see. It therefore publishes what those lines
 * come to and what that qualifies for - a subtotal, a unit count, a line count, the free-freight
 * threshold and the shortfall against it - and it publishes no freight charge, no discount, no tax
 * and no order total, because none of those is a property of a cart: they belong to the order the
 * checkout request creates, and the storefront's own free-freight offer is measured against the
 * subtotal below rather than applied to an order by the checkout service. So a surface printing
 * `subtotalCents` must label it as the merchandise subtotal it is, and a surface that has to state
 * what an order comes to must add the charges it knows about to this figure and say which of them
 * are still unsettled - which is exactly what the checkout review column does with
 * `@/components/cart/CartTotalsPanel`. A figure from here printed under the word "Total" would
 * quote a buyer less than the order they are about to place.
 *
 * Every figure is summed from the lines the cart published, and every string beside it comes from
 * `@/lib/format`. Money and counts are deliberately not formatted in this module: that one pins
 * the store's locale, currency and time zone, which is what keeps the markup the server rendered
 * and the markup the browser renders identical, and a second formatter here would quietly undo it.
 *
 * Nothing is asked of the server and nothing is remembered between renders. The cart itself - its
 * lines, how it stands with the server, and the operations that change it - belongs to
 * `<CartProvider>`, which `@/hooks/useCart` reads; this module only derives from what that
 * provider published.
 */

import { useMemo } from 'react';

import { useCart, type CartContextValue } from '@/hooks/useCart';
import { formatPriceLabel, formatQuantityLabel } from '@/lib/format';

/**
 * What an order has to reach, in cents, for Lumen Supply to carry it at no charge.
 *
 * It is the merchandise subtotal that is measured against it, never the order total, so the
 * freight and the tax an order attracts are not part of what earns a buyer their free carriage.
 */
const FREE_FREIGHT_THRESHOLD_CENTS = 75_000;

/**
 * Why the cart's contents are not established, for a surface that has to say so.
 *
 * `'loading'` is the server yet to answer - the first read, a refresh over a cart that was holding
 * nothing, or a change in flight over a cart nobody has established - and `'unavailable'` is a
 * read that came back a failure. Both say the same thing about the lines, which is that nobody has
 * established what they are; they are told apart because one is worth waiting for and the other is
 * worth retrying, and a surface words them differently.
 */
export type CartContentsUnknownReason = 'loading' | 'unavailable';

/**
 * What every reading of the cart carries, established contents or not.
 *
 * Both members describe the store's dispatch promise rather than the cart: they are the estimate
 * and the countdown the dispatch provider published, which the cart passes through. A surface may
 * therefore print them beside a figure or in place of one.
 */
interface CartSummaryBase {
  /** The transit estimate quoted with the totals, as the cart published it. */
  readonly estimatedDeliveryLabel: string;
  /** Milliseconds left until the next dispatch cut-off, or `null` before the first reading. */
  readonly dispatchCountdownMs: number | null;
}

/**
 * The cart's totals, as the badge, the drawer, the cart page and the checkout summary print them.
 *
 * Every figure below describes lines the server answered with, which is what
 * {@link CartSummaryKnown.contentsKnown} states: they are reached only after a surface has
 * narrowed on that member, so no figure here can be a reading of a cart nobody managed to read.
 */
export interface CartSummaryKnown extends CartSummaryBase {
  /**
   * Discriminant: the cart published its contents, so every figure below is a fact about them.
   *
   * A later failure does not take it away. A refused change leaves the contents the cart last
   * published in place, so the figures stay the last established ones and a surface goes on
   * quoting them while it shows the failure beside them - which is the whole point of the flag
   * being about the contents rather than about the cart's standing with the server.
   */
  readonly contentsKnown: true;
  /** Number of lines in the cart, which is what the drawer and the checkout summary list. */
  readonly lineCount: number;
  /** Quantity summed across the lines: eight of one product and two of another count as ten. */
  readonly unitCount: number;
  /**
   * True while the established contents hold no lines at all, which is what a blank slate is
   * shown for. It is a cart the server answered with nothing in - never a cart nobody could read,
   * which is the other reading of this union and carries no such claim.
   */
  readonly isCartEmpty: boolean;
  /**
   * The lines' totals summed, in cents: the merchandise subtotal, and never an order total.
   * Freight, discounts and tax are not in it - see the note at the head of this module.
   */
  readonly subtotalCents: number;
  /** Wording for {@link CartSummaryKnown.subtotalCents}, for example `'$1,299.00'`. */
  readonly subtotalLabel: string;
  /** Wording for {@link CartSummaryKnown.unitCount}, grouped for readability, for example `'1,024'`. */
  readonly unitCountLabel: string;
  /** What a subtotal has to reach to be carried at no charge, in cents. */
  readonly freeFreightThresholdCents: number;
  /** How much more merchandise earns free carriage, in cents; `0` once the cart qualifies. */
  readonly freeFreightRemainingCents: number;
  /** Wording for {@link CartSummaryKnown.freeFreightRemainingCents}, for example `'$120.00'`. */
  readonly freeFreightRemainingLabel: string;
  /** True once the subtotal has reached {@link CartSummaryKnown.freeFreightThresholdCents}. */
  readonly qualifiesForFreeFreight: boolean;
}

/**
 * The reading of a cart whose contents nobody has established, which carries no figure at all.
 *
 * It is not an empty cart and must never be printed as one. The lines are empty here because the
 * read that would have filled them is still in flight or came back a failure, so a count, a
 * subtotal or the word "empty" put on screen from this reading would be a claim about a cart the
 * storefront never saw. What a surface prints instead is the state: see
 * {@link CartSummaryUnknown.unknownReason} for which of the two it is.
 */
export interface CartSummaryUnknown extends CartSummaryBase {
  /** Discriminant: the cart's contents are not established, so there is no figure to quote. */
  readonly contentsKnown: false;
  /** Which way the contents came to be unestablished; see {@link CartContentsUnknownReason}. */
  readonly unknownReason: CartContentsUnknownReason;
}

/**
 * What {@link useCartSummary} publishes: the cart's totals, or the reason there are none.
 *
 * A union rather than one shape with optional figures, because the two readings are different
 * statements and a consumer has to have made up its mind which one it is holding before it can
 * print anything. `contentsKnown` is the discriminant, so `summary.subtotalCents` does not compile
 * until a surface has established that there is a cart behind it.
 */
export type CartSummary = CartSummaryKnown | CartSummaryUnknown;

/**
 * Whether the lines `cart` published are contents the storefront established.
 *
 * The provider fills `lines` from a read of the server and states on that member what an empty
 * array means: with no failure published it is a cart the server answered with nothing in, and
 * alongside a failure it is contents the read never established. So lines in hand are established
 * whatever the cart is doing afterwards - a refused change leaves the contents it last published
 * in place - while an empty array needs positive evidence that the server answered with one.
 *
 * `'idle'` is that evidence, and it is the only status that carries it: the provider reaches it
 * exactly where it publishes contents the server returned. The other three do not, and each for
 * its own reason - `'loading'` is a read still in flight, `'error'` is one that failed, and
 * `'saving'` is a change in flight, which clears the failure the previous read published and can
 * be entered from a cart that was never established at all (an addition pressed on a product page
 * after the first read failed). An empty array under `'saving'` is therefore not a cart known to
 * hold nothing; it is the same unread cart with an operation outstanding, and the operation is not
 * evidence of what the cart holds. Requiring `'idle'` costs a known-empty cart the momentary
 * reading of its own zeroes while a change is in flight, which is a figure withheld rather than
 * one invented, and the reading returns as soon as the server answers.
 *
 * `cartError` is compared against `null` rather than tested for truthiness, exactly as the
 * provider's contract requires: a failure it could only describe in an empty string is still a
 * failure, and reading it as absent is what would let a surface go on to claim the cart is empty.
 *
 * @param cart The cart as `<CartProvider>` published it.
 * @returns True when the lines describe contents that were read from the server.
 */
function cartContentsKnown(cart: CartContextValue): boolean {
  return cart.lines.length > 0 || (cart.cartError === null && cart.syncStatus === 'idle');
}

/**
 * The totals `cart` comes to, summed from its lines, or the reason it has none to quote.
 *
 * Contents nobody established yield no figures: the reading returned then carries the state and
 * the dispatch promise alone, so there is no zero for a surface to print as a fact and nothing for
 * one to mistake for an empty cart. See {@link cartContentsKnown} for which of the two a cart is.
 *
 * One pass over the lines produces both figures a cart is quoted by - the units in it and what
 * they come to - so a subtotal can never belong to a different set of lines than the count printed
 * beside it. Each line's total is taken as the server priced it rather than multiplied again here:
 * a contract price or a promotion is the store's to apply, and re-deriving one in the browser would
 * put a second, disagreeing figure on the page.
 *
 * The delivery wording and the dispatch countdown pass straight through. They are quoted with the
 * totals because a buyer reads the two together, and restating either of them in this module would
 * give the storefront a second opinion about when an order leaves the warehouse.
 *
 * @param cart The cart as `<CartProvider>` published it.
 * @returns The totals every surface quoting that cart prints.
 */
function buildCartSummary(cart: CartContextValue): CartSummary {
  if (!cartContentsKnown(cart)) {
    return {
      contentsKnown: false,
      unknownReason: cart.cartError === null ? 'loading' : 'unavailable',
      estimatedDeliveryLabel: cart.estimatedDeliveryLabel,
      dispatchCountdownMs: cart.dispatchCountdownMs,
    };
  }

  let units = 0;
  let subtotalCents = 0;

  for (const line of cart.lines) {
    units += line.quantity;
    subtotalCents += line.lineTotalCents;
  }

  // A cart already over the threshold needs nothing further, so the shortfall floors at zero
  // rather than becoming a negative amount the freight line would print as money owed.
  const freeFreightRemainingCents = Math.max(0, FREE_FREIGHT_THRESHOLD_CENTS - subtotalCents);

  return {
    contentsKnown: true,
    lineCount: cart.lines.length,
    unitCount: units,
    isCartEmpty: cart.lines.length === 0,
    subtotalCents,
    subtotalLabel: formatPriceLabel(subtotalCents),
    unitCountLabel: formatQuantityLabel(units),
    freeFreightThresholdCents: FREE_FREIGHT_THRESHOLD_CENTS,
    freeFreightRemainingCents,
    freeFreightRemainingLabel: formatPriceLabel(freeFreightRemainingCents),
    qualifiesForFreeFreight: freeFreightRemainingCents === 0,
    estimatedDeliveryLabel: cart.estimatedDeliveryLabel,
    dispatchCountdownMs: cart.dispatchCountdownMs,
  };
}

/**
 * Reads the cart's totals, or the reason there are none to read.
 *
 * A consumer starts by narrowing on `contentsKnown`, which is what says which of the two readings
 * it is holding. `false` carries `unknownReason` - `'loading'` or `'unavailable'` - and the
 * dispatch promise, and nothing else: there is no figure to print, and a surface prints the state
 * instead of inventing one. `true` carries the totals, and a consumer renders straight from them:
 * `lineCount` and `unitCount` with their wording for the two counts a cart is quoted by,
 * `subtotalCents` and `subtotalLabel` for the money - which is the merchandise subtotal and
 * nothing more, so a consumer labels it as one - `freeFreightRemainingLabel` with
 * `qualifiesForFreeFreight` for the free-carriage line, and `estimatedDeliveryLabel` with
 * `dispatchCountdownMs` for the delivery promise printed beside them. `isCartEmpty` is what a
 * surface shows its blank slate for, and it is a claim only this branch is entitled to make.
 *
 * The cart's standing with the server is deliberately not repeated here, because it is a different
 * question from what the cart holds: a surface that has to say a change is being saved, or show a
 * failure a buyer can retry beside totals it is still quoting, reads `syncStatus` and `cartError`
 * from `@/hooks/useCart` alongside these figures. `contentsKnown` answers only whether there are
 * figures, which is why it stays `true` through a refused change - the contents the cart last
 * published are still the established ones.
 *
 * Throws when called from a component that is not inside `<CartProvider>`, which the root layout
 * mounts around the whole application - the same failure `@/hooks/useCart` reports, for the same
 * reason: totals of an empty stand-in cart would tell a buyer their cart is empty when the
 * component was merely mounted in the wrong place.
 *
 * @returns The totals of the cart the provider has published, or - where its contents are not
 *   established - the reason there are none to publish.
 */
export function useCartSummary(): CartSummary {
  const cart = useCart();

  return useMemo<CartSummary>(() => buildCartSummary(cart), [cart]);
}
