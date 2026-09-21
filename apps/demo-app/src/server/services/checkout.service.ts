/**
 * Checkout: turning the cart a visitor is shopping with into a placed order.
 *
 * One operation lives here, and it is the server half of the storefront's
 * "Place order" button. What placing an order consists of is the whole of this
 * module: the cart is read and taken, the units on it are promised, the lines
 * are priced, the freight is quoted, the payment is authorized and the order is
 * written. Each of those is somebody else's expertise - `./cart.service`,
 * `./inventory.service`, `./pricing.service`, `./shipping.service`,
 * `./payment.service` and `./order.service` own one each - so what is left here
 * is the order they happen in and the figures they hand one another. This
 * module issues no query, opens no connection and writes no row of its own.
 *
 * **A cart is taken before anything is spent against it.** The steps after the
 * first hold stock, ask a carrier to rate a shipment and ask a processor to
 * approve an amount, and none of that may happen twice for one cart, so the
 * cart is claimed before any of it. Only the checkout holding the cart reaches
 * a carrier or a processor; a second one is turned away with a collision before
 * it spends anything, and the order and the cart's conversion are written
 * together in one transaction so an order and an orderable cart cannot both
 * exist.
 *
 * **What a failed checkout gives back depends on whether it charged.** The
 * stock always goes back, because no order was written. The cart goes back only
 * while nothing has been sent to the processor, or while the processor has
 * answered that it took nothing: a cart that may carry an authorization is left
 * held instead, so a second attempt cannot authorize the same order again, and
 * the store is told in the log that it has an authorization to settle and no
 * order against it. {@link undo} is where that line is drawn.
 *
 * **The cart belongs to the session, not to the request.** `CheckoutDraft`
 * carries no cart identifier, because a checkout that could name a cart would
 * be a way to buy somebody else's, so the cart is resolved here from the
 * storefront's own session token exactly as `GET /api/cart` resolves it. The
 * token is this module's own copy of the literal, as it is in
 * `@/server/validation/cart` and in the seed script: a readable identifier is a
 * cheaper thing to keep in step than an import edge between a service, a
 * request schema and a script the Prisma CLI runs.
 *
 * **Money is an integer count of US cents, and each figure is computed once.**
 * The merchandise figures are the pricing service's, the freight is the price
 * of the service the customer chose, and the total is those added together.
 * That one total is what the payment is authorized for and what the order is
 * written with, so the amount approved and the amount recorded cannot differ.
 * Nothing is scaled into dollars and back, and neither a `Decimal` nor a `Date`
 * reaches the returned value: it travels through `POST /api/checkout` to the
 * browser and into a client component.
 *
 * **A failure stays a failure.** The services raise the typed errors of
 * `@/server/errors` - a cart that is not there, stock that cannot be promised,
 * a carrier or a processor that did not answer, figures that no longer
 * reconcile - and every one of them leaves here untouched for the single mapper
 * in that module to classify. Three conditions are this module's own to raise,
 * because only a checkout can see them: a cart with nothing in it, a shipping
 * service that is no longer on offer, and a declined authorization. An order is
 * written only once a payment has been approved for its total, so a caller
 * receives either a complete order or an error and never a half-placed one.
 *
 * Nothing here builds a `Response` or turns a failure into a status code:
 * `app/api/checkout/route.ts` owns that boundary and hands this module the
 * parsed body together with the origin it is answering on.
 */

import type {
  CheckoutDraft,
  CheckoutResult,
  PaymentAuthorization,
  ShippingOption,
  ShippingQuoteResult,
} from '@/lib/types';
import {
  StorefrontConflictError,
  StorefrontError,
  StorefrontValidationError,
} from '@/server/errors';

import { readActiveCart } from './cart.service';
import { release, reserveStock } from './inventory.service';
import { claim, recordOrder, unclaim } from './order.service';
import { authorize } from './payment.service';
import { applyPromotions } from './pricing.service';
import { quote } from './shipping.service';

/**
 * The cart a checkout reads, as the storefront's session names it.
 *
 * It is the token the seed script leaves on the one cart it populates and
 * leaves `ACTIVE`, which is what lets a freshly seeded database, a storefront
 * opened for the first time and an automated run all check the same cart out.
 * The literal is duplicated from the seed and from the cart request schema
 * rather than shared with either, for the reason given at the top of this file.
 */
const CART_TOKEN = 'lumen-supply-demo-cart';

/**
 * The currency this store prices and charges in, as its three-letter code.
 *
 * Every price in the catalog is an integer count of US cents, so this is the
 * currency an authorization is asked for; the processor is sent the code rather
 * than left to assume one.
 */
const CURRENCY = 'USD';

/** What a customer is told when the processor declined without saying why. */
const DECLINED = 'The payment was declined, so this order was not placed.';

/**
 * The service the customer chose, as the carrier offers it now.
 *
 * The identifier came from a quote the checkout form was shown, and a quote is
 * a statement about a moment: a service withdrawn since then, and a destination
 * that turns out to have no service at all, both arrive here as an option list
 * without it. Either way the customer chooses again, which is why this is a
 * collision rather than a rejected request - the very same submission was
 * acceptable against the quote it was made from.
 *
 * The quote the store recorded comes back with it, because an order is placed
 * on a quote and not merely at a price: the record of what the customer was
 * quoted is what the order's freight is charged against. A quote with no
 * record is no more usable than a service that is no longer offered, so the two
 * are one outcome here.
 *
 * @param shipping The quote the carrier answered, as the store recorded it.
 * @param id The service the submitted checkout named.
 * @returns The offered service, with the price the freight is charged at, and
 * the quote it was recorded under.
 * @throws StorefrontConflictError When no offered service carries `id`, or when
 * the quote it was offered in was not recorded.
 */
function offered(
  shipping: ShippingQuoteResult,
  id: string,
): { option: ShippingOption; quote: string } {
  const offer = shipping.options.find((entry) => entry.id === id);

  if (offer === undefined || shipping.id === null) {
    throw new StorefrontConflictError(
      'That shipping service is no longer offered to this destination. Choose a service and place the order again.',
    );
  }

  return { option: offer, quote: shipping.id };
}

/**
 * Puts back what a checkout that did not finish had taken, as far as it is safe
 * to, and lets the failure that ended it be the one the caller sees.
 *
 * Two things are taken before a checkout knows whether it will finish: the
 * units the cart was promised, and the cart itself. The units always go back -
 * no order was written, so nothing was sold - and they go back first.
 *
 * The cart is the part that depends on how far the checkout got, and the line
 * is the authorization. Up to the moment an amount is sent to the processor,
 * nothing has been charged and the cart goes back to its session, so a customer
 * whose card was declined or whose cart ran short finds it where they left it
 * and can try again. Once an amount has been sent and the answer is either an
 * approval or no answer at all, an authorization may stand against that cart,
 * and putting it back would let the next attempt authorize the same order a
 * second time. So it is left held: one order that has to be settled by hand is
 * a smaller wrong than two charges, and the state it is left in says exactly
 * that - a held cart, no order, and a line in the log naming both.
 *
 * Neither step is allowed to become the error reported. A cart that could not
 * be put back is a matter for whoever runs the store, and the reason the
 * checkout failed is what the customer needs to be told, so a failure here is
 * logged and swallowed.
 *
 * @param cart The cart the checkout was holding.
 * @param reference The hold it had raised, or `null` if it had not got that far.
 * @param charged Whether an amount reached the processor without a definite
 * answer that nothing was taken.
 */
async function undo(cart: string, reference: string | null, charged: boolean): Promise<void> {
  if (reference !== null) {
    try {
      await release(reference);
    } catch (cause) {
      console.error(`checkout: the stock held for cart ${cart} was not given back`, cause);
    }
  }

  if (charged) {
    console.error(
      `checkout: cart ${cart} is still held because an authorization may stand against it, and no order was written for it - settle it before reopening the cart`,
    );

    return;
  }

  try {
    await unclaim(cart);
  } catch (cause) {
    console.error(`checkout: cart ${cart} was not returned to its session`, cause);
  }
}

/**
 * Places the order the checkout form submitted, and answers with it.
 *
 * @param draft The submitted checkout: who is buying, where the goods are
 * going and which shipping service was chosen. The delivery note it may carry
 * is not retained, because an order has no column to keep one in - the same
 * frankness `./order.service` applies to the destination address.
 * @param origin The scheme and authority this application is answering on, as
 * the route handler read it from its own request. The carrier and the payment
 * processor are reached against it, so nothing here names a host.
 * @returns The order as it was written - its lines, the service it ships by and
 * the destination the draft carried - together with the authorization that paid
 * for it.
 * @throws StorefrontValidationError When the cart holds nothing to order.
 * @throws StorefrontConflictError When another checkout is already holding the
 * cart, when the cart has already become an order, or when the chosen shipping
 * service is not among those now offered to the destination.
 * @throws StorefrontError `PAYMENT_DECLINED` when the processor declined the
 * authorization. No order is written for a payment nobody approved.
 * @throws StorefrontNotFoundError When the session is shopping with no open
 * cart. Everything the services raise - stock that cannot be promised, a
 * carrier or a processor that did not answer, figures that no longer reconcile
 * - propagates as it was raised.
 */
export async function placeOrder(draft: CheckoutDraft, origin: string): Promise<CheckoutResult> {
  const cart = await readActiveCart(CART_TOKEN);

  if (cart.lines.length === 0) {
    throw new StorefrontValidationError(
      'There is nothing in your cart to order. Add an item and place the order again.',
    );
  }

  // The cart is taken before anything is spent against it, so a second checkout
  // of the same cart is turned away here rather than at the end - after it too
  // has held stock, rated a shipment and had an amount approved.
  await claim(cart.id);

  let reference: string | null = null;
  let charged = false;

  try {
    const reservation = await reserveStock(cart.lines);

    reference = reservation.reference;

    const pricing = await applyPromotions(cart.lines);

    const shipping = await quote(
      {
        postalCode: draft.shippingAddress.postalCode,
        itemCount: reservation.units,
        serviceLevel: draft.shippingOptionId,
        cart: cart.id,
      },
      origin,
    );

    const { option, quote: recorded } = offered(shipping, draft.shippingOptionId);
    const freight = option.priceCents;
    const total = pricing.totalCents + freight;

    charged = true;

    let payment: PaymentAuthorization;

    try {
      payment = await authorize(
        { amountCents: total, currency: CURRENCY, reference: cart.id },
        origin,
      );
    } catch (cause) {
      // A request the processor never saw took nothing, and this module can
      // tell: everything the payment service checks before sending - the
      // amount, the currency, the reference and the address it is sending to -
      // it reports as a rejected request, while anything that happened once the
      // request was on its way is an upstream failure. The first is a definite
      // no, so the cart goes back; the second is no answer at all, and a cart
      // that may have been charged is not reopened.
      charged = !(cause instanceof StorefrontValidationError);

      throw cause;
    }

    if (!payment.authorized) {
      // A decline is an answer: the processor took nothing, so the customer
      // keeps their cart and can pay another way.
      charged = false;

      throw new StorefrontError('PAYMENT_DECLINED', 402, payment.declineReason ?? DECLINED);
    }

    const order = await recordOrder({
      cart: cart.id,
      quote: recorded,
      customer: draft.contact,
      address: draft.shippingAddress,
      lines: pricing.lines,
      option,
      payment,
      subtotalCents: pricing.subtotalCents,
      discountCents: pricing.discountCents,
      freightCents: freight,
      totalCents: total,
    });

    return { order, payment };
  } catch (cause) {
    await undo(cart.id, reference, charged);

    throw cause;
  }
}
