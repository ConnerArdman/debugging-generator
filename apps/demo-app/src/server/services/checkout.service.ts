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
 * **Nothing is charged for an order the order service would refuse.** The draft
 * is assembled as soon as the freight and the total are known and put through
 * `checkOrderDraft` - every question `recordOrder` can answer from the draft
 * alone - before an amount is sent to the processor, and the very same draft is
 * what the order is then written from. So a submission that is not a recordable
 * order is refused while nothing has been spent, and the figures approved are
 * the figures checked.
 *
 * **What a failed checkout gives back depends on what a second attempt could
 * do.** The stock always goes back, because no order was written. The cart goes
 * back whenever nothing has been sent to the processor, or the processor has
 * answered that it took nothing - a declined card, a rejected request, a cart
 * that ran short, a draft that is not an order. A cart that may carry an
 * authorization is never put back, whatever ended the checkout: putting it back
 * is what would let a second attempt authorize the same order again, and one
 * authorization that has to be settled by hand is a smaller wrong than two
 * charges. The cart it holds and the authorization that may stand against it
 * are named together in the log, so the store can settle them. {@link undo} is
 * where that line is drawn.
 *
 * **A customer is told whether an amount may have been captured.** What a
 * failed checkout leaves the cart in is the store's business; what may have
 * been charged is the customer's, and the two are answered separately for
 * exactly that reason. So every failure this module lets through means no
 * amount was captured, and the one situation that cannot promise that - a
 * payment sent without a readable answer, or an approval this module could not
 * write an order against - is reported as `PAYMENT_STATUS_UNKNOWN` through
 * `paymentStatusUnknown`. Nothing else is rewrapped: a declined card, a short
 * line, a withdrawn service and a cart that is not there all reach the caller
 * exactly as they were raised.
 *
 * **An attempt can be retried without being repeated.** Placing an order is one
 * request whose reply may be lost on the way back, and a caller that cannot tell
 * a lost reply from a request that never arrived would have to choose between
 * abandoning an order and ordering twice. So a submission names the attempt it
 * belongs to - `CheckoutDraft.idempotencyKey` - and repeating that name is
 * answered with what the attempt did rather than with a second attempt: the
 * order it placed, the unresolved payment it left, or the request that is still
 * running. Two things back that up, and they answer at different ranges. Within
 * this process the attempt is remembered, so a repeat is answered with the very
 * result of the first, authorization included. Beyond it - a restarted server, a
 * second worker, a name this process has since forgotten - the store's own
 * records answer, because a cart is finished by the order it became and held by
 * the checkout that took it: a session holding no open cart either has an order
 * that cart became, or a cart an attempt is still holding, or no cart at all,
 * and {@link settled} gives each of those its own answer. The first is
 * `outcome: 'already_placed'`, whenever it was placed; the second is
 * `PAYMENT_STATUS_UNKNOWN`, because an authorization may stand against a held
 * cart; only the third is a customer with nothing to order. So the safe answer
 * does not depend on which process receives the submission or on how long ago
 * the attempt ran, and the cart's own conversion is what makes a second order
 * impossible regardless.
 *
 * **Retrying is safe because the cart decides.** The claim below and the
 * conversion inside the order's transaction are single conditional writes, so of
 * two attempts at one cart exactly one can spend anything and exactly one can
 * write an order, whatever either of them was told.
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
  CartView,
  CheckoutDraft,
  CheckoutResult,
  PaymentAuthorization,
  ShippingOption,
  ShippingQuoteResult,
} from '@/lib/types';
import {
  StorefrontConflictError,
  StorefrontError,
  StorefrontUpstreamError,
  StorefrontValidationError,
  paymentStatusUnknown,
} from '@/server/errors';

import { readActiveCart } from './cart.service';
import { release, reserveStock } from './inventory.service';
import type { CartOutcome, UnpaidOrderDraft } from './order.service';
import { checkOrderDraft, claim, readCartOutcome, recordOrder, unclaim } from './order.service';
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
 * What a customer is told when an amount was approved and the order it was
 * approved for could not be written.
 *
 * It is the one message this module sends that does not end in an invitation to
 * order again, because ordering again is the one thing that could turn a single
 * unsettled authorization into two.
 */
const UNSETTLED =
  'The payment for this order was approved and the order itself could not be completed, so whether you have been charged is unresolved. Do not place it again: check your orders, and contact Lumen Supply if the order is not there.';

/**
 * What a customer is told when an earlier attempt at this order has not
 * settled: the cart is held by it and no order was written against it.
 *
 * It is what a held cart means, and it is deliberately not an invitation to
 * order again - the attempt holding the cart may carry an authorization, and a
 * second attempt is the only way that becomes two.
 */
const HELD =
  'An earlier attempt to place this order has not settled, so whether a payment was taken for it is unresolved. Check your orders before placing it again, and contact Lumen Supply if the order is not there.';

/**
 * What a customer is told when the store could not read what became of an
 * earlier attempt. Checking again is safe, so that is what it asks for.
 */
const UNREADABLE =
  'This store could not check what became of an earlier attempt to place this order, so whether a payment was taken for it is unresolved. Check the order again in a moment rather than placing it a second time.';

/**
 * How long an attempt is remembered after it finished, in milliseconds.
 *
 * It bounds what this process holds and nothing else: what the memory answers
 * quickly - the result of the attempt, the failure it ended in - the store's own
 * records answer afterwards through {@link settled}, so an evicted name is
 * answered no less safely than a remembered one, just with less detail.
 */
const REMEMBER = 900_000;

/** How many attempts are remembered at once, whatever their age. */
const CEILING = 200;

/**
 * What one attempt to place an order is known to have done.
 *
 * `running` holds the very promise the first caller is awaiting, so a repeat
 * joins that attempt instead of starting a second one. `placed` holds its
 * result. `unsettled` holds the unresolved-payment failure it ended in, which a
 * repeat is given again rather than being allowed to authorize the same order a
 * second time. A definite failure is remembered as nothing at all: it wrote no
 * order and took no money, so the name is free to be used again.
 */
type Attempt = { readonly at: number } & (
  | { readonly state: 'running'; readonly pending: Promise<CheckoutResult> }
  | { readonly state: 'placed'; readonly result: CheckoutResult }
  | { readonly state: 'unsettled'; readonly failure: unknown }
);

declare global {
  /**
   * The attempts this process has already seen, if any.
   *
   * `next dev` re-evaluates a server module whenever it or one of its
   * dependencies changes, and a map held in module scope alone would be emptied
   * by every one of those reloads - so an editing session would forget an
   * attempt a browser is still holding the name of. Parking it on `globalThis`
   * outlives module identity and keeps one set of attempts per process, exactly
   * as `@/server/db/prisma` does for its client. What a restart forgets is
   * answered by the store's own records instead.
   */
  var __lumencheckout: Map<string, Attempt> | undefined;
}

/** The attempts this process remembers. */
const attempts: Map<string, Attempt> = globalThis.__lumencheckout ?? new Map<string, Attempt>();

globalThis.__lumencheckout = attempts;

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
 * The cart is the part that depends on how far the checkout got. Up to the
 * moment an amount is sent to the processor, nothing has been charged and the
 * cart goes back to its session, so a customer whose card was declined, whose
 * cart ran short or whose submission was not a recordable order finds it where
 * they left it and can try again.
 *
 * Once an amount has been sent and the answer is either an approval or no
 * answer at all, an authorization may stand against that cart, and the cart is
 * left held - every time, whatever ended the checkout. Putting it back is the
 * one thing that would let the next attempt authorize the same order a second
 * time, and no failure is worth that: one authorization that has to be settled
 * by hand is a smaller wrong than two charges. The state the cart is left in
 * says exactly that - held, with no order against it - and the line in the log
 * names all three: the authorization that may stand, the order that was not
 * written, and the cart that is being held rather than reopened.
 *
 * Nothing is exempt from that rule, because nothing needs to be. A draft the
 * order service cannot record is refused before an amount is sent at all - see
 * {@link attempt} - so the failures that reach here charged are the ones whose
 * order could still have been written: a figure that stopped reconciling with
 * the amount approved, a condition inside the order's transaction, a database
 * that did not answer. For all of them, a cart put back is a second
 * authorization waiting to happen.
 *
 * Holding it is also what makes the answer survive this process. `claim` parked
 * the cart at `ABANDONED` in the database, so `readActiveCart` finds no open
 * cart for the session from then on and {@link settled} answers the cart that
 * exists and became no order with `PAYMENT_STATUS_UNKNOWN` - from any process,
 * however long afterwards, and without this module persisting anything of its
 * own. The customer is told the outcome of their payment is unresolved and asked
 * to check their orders rather than place them again, and recovery is the
 * store's: settle the authorization, then reopen or convert the cart by hand.
 *
 * Neither step is allowed to become the error reported. A cart that could not
 * be put back is a matter for whoever runs the store, and the reason the
 * checkout failed is what the customer needs to be told, so a failure here is
 * logged and swallowed.
 *
 * @param cart The cart the checkout was holding.
 * @param reference The hold it had raised, or `null` if it had not got that far.
 * @param charged Whether an amount reached the processor without a definite
 * answer that nothing was taken. When it did, the cart stays held.
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
    // All three facts in one line, because an operator needs all three: an
    // amount that may have been approved, nothing recorded against it, and the
    // cart deliberately left held rather than returned to its session.
    console.error(
      `checkout: an authorization may stand against cart ${cart} and no order was written for it - the cart is being held rather than returned to its session, so that a second attempt cannot authorize it again. Settle the authorization before reopening the cart`,
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
 * Forgets the attempts nobody can still be asking about.
 *
 * Two bounds, because they answer different things. An attempt that finished
 * long enough ago that no customer is still deciding what to do about it is of
 * no further use, and a process that has seen a great many one-off names should
 * not hold all of them whatever their age. An attempt still running is never
 * forgotten: a caller is holding its name and another may be waiting on it.
 *
 * @param now The moment the current submission arrived.
 */
function forget(now: number): void {
  for (const [key, entry] of attempts) {
    if (entry.state !== 'running' && now - entry.at > REMEMBER) {
      attempts.delete(key);
    }
  }

  // A map preserves insertion order, so the first entry that is not still
  // running is the oldest finished one. The bound is applied before the
  // submission in hand is recorded, so the map never exceeds the ceiling rather
  // than exceeding it by the one entry about to be added.
  while (attempts.size >= CEILING) {
    let oldest: string | null = null;

    for (const [key, entry] of attempts) {
      if (entry.state !== 'running') {
        oldest = key;
        break;
      }
    }

    if (oldest === null) {
      break;
    }

    attempts.delete(oldest);
  }
}

/**
 * The same result, said to be the order the attempt had already placed.
 *
 * The order is untouched - it is the one that was written - and only what the
 * answer claims about this request changes, so a caller can say "this is your
 * order" rather than "your order has been placed" a second time.
 *
 * @param result What the attempt produced.
 */
function again(result: CheckoutResult): CheckoutResult {
  return { ...result, outcome: 'already_placed' };
}

/**
 * What the store's own records say about a session that is holding no open
 * cart, as an answer or as a failure.
 *
 * This is the durable half of not repeating an attempt, and it is what answers
 * once the process that ran the attempt has forgotten it or was never the
 * process that ran it. It is reached only when the session holds no open cart,
 * and a cart that is not open is a cart a checkout took, so each of the three
 * things the records can say has exactly one safe answer:
 *
 * * **It became an order.** That order is the answer, whenever it was placed. A
 *   cutoff here would be a promise that expires without the customer being told,
 *   and the order is no less theirs an hour later.
 * * **It exists and became no order.** An attempt is holding it - running now,
 *   or ended without settling - so an authorization may stand against it and
 *   the outcome is unresolved. It is never reported as a cart that is merely
 *   gone.
 * * **There is no cart.** The session has nothing to order, which is what the
 *   caller's own failure already said, so that failure stands.
 *
 * A read that fails is the fourth case and is treated as the third-worst rather
 * than the best: the records could not be consulted, so nothing is ruled out.
 *
 * The authorization is not part of an answer built here: the store keeps the
 * order and the status the payment left it in, not the processor's record of the
 * attempt, and inventing one would be describing a charge this module did not
 * see.
 *
 * @param cause The failure that established the session holds no open cart.
 * @returns The order that cart became, as an already-placed result.
 * @throws StorefrontError `PAYMENT_STATUS_UNKNOWN` when a cart is being held
 * with no order against it, or when the records could not be read.
 * @throws The caller's own `cause` when this session has no cart at all.
 */
async function settled(cause: unknown): Promise<CheckoutResult> {
  let outcome: CartOutcome | null;

  try {
    outcome = await readCartOutcome(CART_TOKEN);
  } catch (failure) {
    throw paymentStatusUnknown(UNREADABLE, { upstream: 'payment', status: 500, cause: failure });
  }

  if (outcome === null) {
    throw cause;
  }

  if (outcome.order !== null) {
    return { order: outcome.order, payment: null, outcome: 'already_placed' };
  }

  // 409: the submission collides with the attempt holding the cart. The code is
  // what carries the meaning to a customer; the status is what this is to HTTP.
  throw paymentStatusUnknown(HELD, { upstream: 'payment', status: 409 });
}

/**
 * Runs one attempt at placing the order the checkout form submitted.
 *
 * Everything an order involves happens here and in the order it is written;
 * {@link placeOrder} is the door in front of it that decides whether an attempt
 * should run at all.
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
 * @throws StorefrontValidationError When the cart holds nothing to order, and
 * when the assembled order is not one the order service can record - the latter
 * refused by `checkOrderDraft` before any amount is sent to the processor, so a
 * submission that cannot become an order is never charged for.
 * @throws StorefrontConflictError When another checkout is already holding the
 * cart, when the cart has already become an order, when the chosen shipping
 * service is not among those now offered to the destination, or when the
 * assembled order's figures do not reconcile with one another - the last of
 * those, like a non-recordable draft, before any amount is sent.
 * @throws StorefrontError `PAYMENT_DECLINED` when the processor declined the
 * authorization. No order is written for a payment nobody approved.
 * @throws StorefrontError `PAYMENT_STATUS_UNKNOWN` when an amount was sent to
 * the processor and its outcome cannot be established, when an approved amount
 * could not be turned into an order, or when the session's cart is held by an
 * attempt that has not settled. It is the only failure from here that does not
 * mean nothing was captured.
 * @throws StorefrontNotFoundError When the session has no cart at all.
 * Everything else the services raise - stock that cannot be promised, a carrier
 * that did not answer, figures that no longer reconcile - propagates as it was
 * raised.
 */
async function attempt(draft: CheckoutDraft, origin: string): Promise<CheckoutResult> {
  let cart: CartView;

  try {
    cart = await readActiveCart(CART_TOKEN);
  } catch (cause) {
    // No open cart is the state every finished and every unfinished checkout of
    // this session leaves behind, as well as the state a session that never had
    // a cart is in, and those call for different answers - so the records
    // decide, and the caller's failure stands only for the last of them.
    return settled(cause);
  }

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

    // The order is assembled once, here, and the payment is the only thing
    // added to it later: one object means the figures the check passes and the
    // figures the order is written from cannot differ.
    const unpaid: UnpaidOrderDraft = {
      cart: cart.id,
      quote: recorded,
      customer: draft.contact,
      address: draft.shippingAddress,
      lines: pricing.lines,
      option,
      subtotalCents: pricing.subtotalCents,
      discountCents: pricing.discountCents,
      freightCents: freight,
      totalCents: total,
    };

    // Asked before anything is spent, and this is the whole reason it is asked
    // here rather than left to `recordOrder`: every question it answers is
    // answered from the draft alone, so a draft it accepts cannot be refused
    // after an amount has been approved for it - and a refusal after a charge
    // would leave an authorization standing with no order against it and no
    // retry that could ever produce one. A draft it refuses fails with `charged`
    // still false, so the cart goes back to its session like any other
    // pre-authorization failure. It is synchronous and issues no query, so it
    // adds nothing to what this attempt waits for.
    checkOrderDraft(unpaid);

    charged = true;

    let payment: PaymentAuthorization;

    try {
      payment = await authorize(
        { amountCents: total, currency: CURRENCY, reference: cart.id },
        origin,
      );
    } catch (cause) {
      // A payment that took nothing leaves the cart where the customer left it,
      // and the payment service says which failures those are: a rejected
      // request, checked before anything was sent, and a processor that turned
      // the request away, which is an answer that it did not act on it. The
      // failure it raises for everything else - a request sent and not answered
      // readably - leaves an authorization possibly standing, and a cart that
      // may carry one is not reopened.
      charged = !(
        cause instanceof StorefrontValidationError || cause instanceof StorefrontUpstreamError
      );

      throw cause;
    }

    if (!payment.authorized) {
      // A decline is an answer: the processor took nothing, so the customer
      // keeps their cart and can pay another way.
      charged = false;

      throw new StorefrontError('PAYMENT_DECLINED', 402, payment.declineReason ?? DECLINED);
    }

    try {
      const order = await recordOrder({ ...unpaid, payment });

      return { order, payment, outcome: 'placed' };
    } catch (cause) {
      // No failure is told apart here, and none needs to be: a draft the order
      // service refuses outright cannot arrive at this point, because the same
      // questions were put to the same figures above, before the authorization.
      // What can still fail is what could still have become an order - the
      // amount approved disagreeing with the total, a condition inside the
      // order's transaction, a database that did not answer - and for every one
      // of those the cart has to stay held. It does: `charged` is already set
      // and nothing here revises it.
      //
      // An amount has been approved for this order by the time the write is
      // attempted, so a write that does not happen leaves an authorization with
      // nothing recorded against it - whichever of those failed. The customer
      // must be told that rather than told the collision or the fault that
      // caused it: those read as "nothing was charged, place it again", which is
      // the one thing that could authorize this order twice. The cause stays on
      // the error for the server log, and what the cart was left in is not part
      // of the answer: what the cart is in is a matter for the store, and what
      // may have been charged is what the customer is owed.
      throw paymentStatusUnknown(UNSETTLED, { upstream: 'payment', status: 500, cause });
    }
  } catch (cause) {
    await undo(cart.id, reference, charged);

    throw cause;
  }
}

/**
 * Places the order the checkout form submitted, and answers with it.
 *
 * One submission is one attempt, and repeating the name a submission carries is
 * how a caller asks about the attempt it already made rather than making
 * another. A name this process is holding is answered from what it knows: the
 * order the attempt placed, the unresolved payment it left, or - while it is
 * still running - the very result the first caller is waiting for. A name it has
 * never seen runs an attempt of its own.
 *
 * A definite failure is remembered as nothing: it wrote no order and took no
 * money, so the same name may be used to try again once the customer has fixed
 * what was wrong. An unresolved payment is remembered precisely so that it
 * cannot be, because a second attempt at an order that may already carry an
 * authorization is the failure this whole arrangement exists to prevent.
 *
 * @param draft The submitted checkout, including the name of the attempt it
 * belongs to.
 * @param origin The scheme and authority this application is answering on, as
 * the route handler read it from its own request.
 * @returns The order and the authorization that paid for it, as
 * `outcome: 'placed'`, or the order the attempt had already placed, as
 * `outcome: 'already_placed'`.
 * @throws Whatever the attempt raised - see {@link attempt} - or, for a repeat
 * of an attempt that ended with a payment whose outcome is unresolved, that same
 * failure again.
 */
export async function placeOrder(draft: CheckoutDraft, origin: string): Promise<CheckoutResult> {
  const now = Date.now();

  forget(now);

  const key = draft.idempotencyKey;
  const seen = attempts.get(key);

  if (seen !== undefined) {
    if (seen.state === 'placed') {
      return again(seen.result);
    }

    if (seen.state === 'running') {
      return again(await seen.pending);
    }

    throw seen.failure;
  }

  // Recorded before anything is awaited, so a second submission of the same
  // name - which can only arrive once this one yields - finds the attempt in
  // flight instead of starting its own.
  const pending = attempt(draft, origin);

  attempts.set(key, { state: 'running', at: now, pending });

  try {
    const result = await pending;

    attempts.set(key, { state: 'placed', at: Date.now(), result });

    return result;
  } catch (cause) {
    if (cause instanceof StorefrontError && cause.code === 'PAYMENT_STATUS_UNKNOWN') {
      attempts.set(key, { state: 'unsettled', at: Date.now(), failure: cause });
    } else {
      attempts.delete(key);
    }

    throw cause;
  }
}
