'use client';

/**
 * Lumen Supply - the cart, as the storefront's client components read it.
 *
 * One cart belongs to one browser, and the server is what holds it: the root layout mounts
 * `<CartProvider>` around the whole application, that provider reads the cart when the storefront
 * starts, and it carries every later change to the server and publishes the cart the server
 * answered with. This module is the one way the rest of the storefront reaches that published cart,
 * so the header badge, the cart drawer, the cart page and the checkout summary all read the same
 * lines, the same counts and the same subtotal at the same moment - and checkout, which prices the
 * order from the cart the server holds, reads the cart a buyer was last shown.
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
 * being saved, or wording a buyer can act on in place of a total it no longer trusts;
 * `cartErrorTitle` is the heading for that wording, naming the operation that failed, so a surface
 * showing a failure heads it from there rather than fixing a heading of its own - a refused change
 * under a heading about reading the cart sends a buyer to fix something that is not broken.
 *
 * The operations that change the cart come back with it - `addLine`, `setLineQuantity`,
 * `removeLine`, `emptyCart` and `refreshCart` - so a quantity stepper, an add-to-cart button and
 * the drawer's remove control all write through the provider rather than keeping a cart of their
 * own. Each of the four mutations is a request to the server: every one of them returns a promise,
 * the provider republishes the cart the server answered with - totals and prices included - and
 * `syncStatus` says `'saving'` while the request is in flight, `'idle'` once the returned cart is
 * published and `'error'` with wording on `cartError` when it was refused, the previously published
 * cart staying in place so a buyer keeps seeing what they had.
 *
 * No mutation is reported as refused until the provider has read the cart back from the server,
 * because the answer to a request is not always the state of the cart. That read is what decides
 * what the buyer is told, and it is why a control may trust the promise it is holding. A cart found
 * holding what the change asked for - a line already taken out, a quantity already applied, units
 * that went in despite the failure, a cart already emptied - makes the change the success it turned
 * out to be: the contents are published and the promise resolves, with nothing said about a failure
 * the buyer has no reason to hear about and no warning about a change that did happen. Otherwise the
 * contents that read found are published with wording on `cartError` and the promise rejects, so the
 * control that asked - a quantity stepper, a remove button - can report the refusal beside the line
 * it concerns instead of confirming a change the server refused. `addLine` rejects with a
 * `CartAdditionError` from `@/providers/CartProvider` whose `outcome` says whether the units were
 * found absent or whether nothing could be established about them, which is what stops a control
 * stating that a cart it never checked was left as it was; the other three reject with the failure
 * the request came back with.
 *
 * Two changes asked for faster than either can be answered are settled in the order they were made,
 * not the order they come back in: the provider publishes the outcome of the newest request it has
 * issued, so a refusal belonging to a request the buyer has already seen superseded cannot replace a
 * cart that is correct, and a slow success cannot put back contents a later change took out.
 *
 * `refreshCart` is how a surface that has learned the published cart is out of date asks for the
 * current one, and the provider asks for it itself when the browser restores a frozen document or
 * brings the tab back to the front - a cart lives on the server and one browser may be shopping in
 * more than one tab, so figures from before a page was frozen are figures nobody can vouch for. A
 * read the store answers with there being no cart takes the published contents away with it, and
 * `cartError` then qualifies an empty `lines` as contents nobody established rather than as a cart
 * known to hold nothing. Nothing about the cart is changed in the browser alone, so what a surface
 * prints is what checkout will charge for.
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
