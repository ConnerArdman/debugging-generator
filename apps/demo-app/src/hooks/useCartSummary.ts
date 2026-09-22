'use client';

/**
 * Lumen Supply - the cart's totals, as the storefront prints them.
 *
 * Four surfaces quote the same cart at once: the header badge counts the units in it, the cart
 * drawer and the `/cart` page print the subtotal with how much more buys free freight, and the
 * checkout summary repeats both beside the order being placed. The figures are worked out here,
 * in one place, so none of those surfaces can arrive at a different answer from the others.
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

/** The cart's totals, as the badge, the drawer, the cart page and the checkout summary print. */
export interface CartSummary {
  /** Number of lines in the cart, which is what the drawer and the checkout summary list. */
  readonly lineCount: number;
  /** Quantity summed across the lines: eight of one product and two of another count as ten. */
  readonly unitCount: number;
  /** True while the cart holds no lines at all, which is what a blank slate is shown for. */
  readonly isCartEmpty: boolean;
  /**
   * The lines' totals summed, in cents: the merchandise subtotal, and never an order total.
   * Freight, discounts and tax are not in it - see the note at the head of this module.
   */
  readonly subtotalCents: number;
  /** Wording for {@link CartSummary.subtotalCents}, for example `'$1,299.00'`. */
  readonly subtotalLabel: string;
  /** Wording for {@link CartSummary.unitCount}, grouped for readability, for example `'1,024'`. */
  readonly unitCountLabel: string;
  /** What a subtotal has to reach to be carried at no charge, in cents. */
  readonly freeFreightThresholdCents: number;
  /** How much more merchandise earns free carriage, in cents; `0` once the cart qualifies. */
  readonly freeFreightRemainingCents: number;
  /** Wording for {@link CartSummary.freeFreightRemainingCents}, for example `'$120.00'`. */
  readonly freeFreightRemainingLabel: string;
  /** True once the subtotal has reached {@link CartSummary.freeFreightThresholdCents}. */
  readonly qualifiesForFreeFreight: boolean;
  /** The transit estimate quoted with the totals, as the cart published it. */
  readonly estimatedDeliveryLabel: string;
  /** Milliseconds left until the next dispatch cut-off, or `null` before the first reading. */
  readonly dispatchCountdownMs: number | null;
}

/**
 * The totals `cart` comes to, summed from its lines.
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
 * Reads the cart's totals.
 *
 * A consumer renders straight from the returned {@link CartSummary}: `lineCount` and `unitCount`
 * with their wording for the two counts a cart is quoted by, `subtotalCents` and `subtotalLabel`
 * for the money - which is the merchandise subtotal and nothing more, so a consumer labels it as
 * one - `freeFreightRemainingLabel` with `qualifiesForFreeFreight` for the free-carriage line, and
 * `estimatedDeliveryLabel` with `dispatchCountdownMs` for the delivery promise printed beside
 * them. `isCartEmpty` is what a surface shows its blank slate for.
 *
 * The cart's own state is deliberately not repeated here. A surface that has to say a change is
 * being saved, or show wording in place of a total it no longer trusts, reads `syncStatus` and
 * `cartError` from `@/hooks/useCart` alongside these totals.
 *
 * Throws when called from a component that is not inside `<CartProvider>`, which the root layout
 * mounts around the whole application - the same failure `@/hooks/useCart` reports, for the same
 * reason: totals of an empty stand-in cart would tell a buyer their cart is empty when the
 * component was merely mounted in the wrong place.
 *
 * @returns The totals of the cart the provider has published.
 */
export function useCartSummary(): CartSummary {
  const cart = useCart();

  return useMemo<CartSummary>(() => buildCartSummary(cart), [cart]);
}
