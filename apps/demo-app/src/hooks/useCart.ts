'use client';

/**
 * Lumen Supply - the cart, as the storefront's client components read it.
 *
 * One cart belongs to one browser, and `<CartProvider>` is what holds it: the root layout mounts
 * that provider around the whole application, it reads the cart when the storefront starts, and it
 * owns every change made to the cart afterwards. This module is the one way the rest of the
 * storefront reaches it, so the header badge, the cart drawer, the cart page and the checkout
 * summary all read the same lines, the same counts and the same subtotal at the same moment.
 *
 * Nothing about the cart is computed or asked for here. The totals are derived by the provider from
 * the lines the server returned, and the requests that read and change the cart belong to
 * `@/lib/api-client`, which the provider calls; a second path to either would let two parts of one
 * page disagree about what a buyer has put in their cart.
 */

import { useCartContext, type CartContextValue } from '@/providers/CartProvider';

/**
 * The cart and its operations, re-exported so a component that takes the cart as a prop, or names
 * it in a variable of its own, can write the type beside the hook it read the value from.
 */
export type { CartContextValue } from '@/providers/CartProvider';

/**
 * Reads the cart.
 *
 * A consumer renders straight from the returned value: `lines` for the contents, `lineCount` and
 * `itemCount` for the two counts a cart is quoted by, `subtotalCents` with its `subtotalLabel` for
 * the money, and `estimatedDeliveryLabel` for the transit estimate printed beside it. `syncStatus`
 * and `cartError` say where the cart stands with the server, so a surface can show that a change is
 * being saved, or wording a buyer can act on in place of a total it no longer trusts.
 *
 * The operations that change the cart come back with it - `addLine`, `setLineQuantity`,
 * `removeLine`, `emptyCart` and `refreshCart` - so a quantity stepper, an add-to-cart button and
 * the drawer's remove control all write through the provider rather than keeping a cart of their
 * own. The value is published again after each of them, and every surface reading it prints the
 * cart the provider now holds.
 *
 * Throws when called from a component that is not inside `<CartProvider>`, which `app/layout.tsx`
 * mounts around the whole application. That is a loud failure on purpose: an empty stand-in cart
 * would tell a buyer their cart is empty when the component was merely mounted in the wrong place.
 *
 * @returns The published cart, with the operations that change it.
 */
export function useCart(): CartContextValue {
  return useCartContext();
}
