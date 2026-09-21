/**
 * Checkout: turning the cart a visitor is shopping with into a placed order.
 *
 * One operation lives here, and it is the server half of the storefront's
 * "Place order" button. What placing an order consists of is the whole of this
 * module: the cart is read, the units on it are promised, the lines are priced,
 * the freight is quoted, the payment is authorized and the order is written.
 * Each of those is somebody else's expertise - `./cart.service`,
 * `./inventory.service`, `./pricing.service`, `./shipping.service`,
 * `./payment.service` and `./order.service` own one each - so what is left here
 * is the order they happen in and the figures they hand one another. This
 * module issues no query, opens no connection and writes no row of its own.
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

import type { CheckoutDraft, CheckoutResult, ShippingOption } from '@/lib/types';
import {
  StorefrontConflictError,
  StorefrontError,
  StorefrontValidationError,
} from '@/server/errors';

import { readActiveCart } from './cart.service';
import { reserveStock } from './inventory.service';
import { recordOrder } from './order.service';
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
 * @param options The services the carrier offered for the destination.
 * @param id The service the submitted checkout named.
 * @returns The offered service, with the price the freight is charged at.
 * @throws StorefrontConflictError When no offered service carries `id`.
 */
function offered(options: readonly ShippingOption[], id: string): ShippingOption {
  const offer = options.find((entry) => entry.id === id);

  if (offer === undefined) {
    throw new StorefrontConflictError(
      'That shipping service is no longer offered to this destination. Choose a service and place the order again.',
    );
  }

  return offer;
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
 * @throws StorefrontConflictError When the chosen shipping service is not among
 * those now offered to the destination.
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

  const reservation = await reserveStock(cart.lines);

  const pricing = await applyPromotions(cart.lines);

  const shipping = await quote(
    {
      postalCode: draft.shippingAddress.postalCode,
      itemCount: reservation.units,
      serviceLevel: draft.shippingOptionId,
    },
    origin,
  );

  const option = offered(shipping.options, draft.shippingOptionId);
  const freight = option.priceCents;
  const total = pricing.totalCents + freight;

  const payment = await authorize(
    { amountCents: total, currency: CURRENCY, reference: cart.id },
    origin,
  );

  if (!payment.authorized) {
    throw new StorefrontError('PAYMENT_DECLINED', 402, payment.declineReason ?? DECLINED);
  }

  const order = await recordOrder({
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
}
