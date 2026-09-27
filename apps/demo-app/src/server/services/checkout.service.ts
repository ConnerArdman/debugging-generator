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
 * are named together in the log, so the store can settle them. What such a
 * cart does give back is the session's open-cart pointer: the cart stays held
 * under the attempt's name, which is all a repeat of that name is answered
 * from, and the session shops on with a fresh cart rather than waiting on a
 * settlement only the store can make. So a running attempt holds both its cart
 * and the pointer, and an attempt that ended unsettled holds its cart alone.
 * {@link undo} is where both lines are drawn.
 *
 * **A customer is told whether an amount may have been captured.** What a
 * failed checkout leaves the cart in is the store's business; what may have
 * been charged is the customer's, and the two are answered separately for
 * exactly that reason. So every failure this module lets through means no
 * amount was captured, and the situations that cannot promise that - a payment
 * sent without a readable answer, an approval this module could not write an
 * order against, and an earlier attempt that still holds a cart or whose record
 * could not be read - are reported as `PAYMENT_STATUS_UNKNOWN` through
 * `paymentStatusUnknown`. Nothing else is rewrapped: a declined card, a short
 * line and a withdrawn service all reach the caller exactly as they were
 * raised.
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
 * records answer, because the claim that takes a cart writes the attempt's name
 * on it and the name stays there when the cart becomes an order. So an attempt
 * this process is not already holding asks the records about its own name first,
 * before the session's cart is read, and {@link recall} gives each thing they
 * can say its own answer. A name whose cart became an order is
 * `outcome: 'already_placed'` with that order, whenever it was placed and
 * whatever the session's cart holds now. A name whose cart is still held, or
 * whose order cannot be found, is `PAYMENT_STATUS_UNKNOWN`, because an
 * authorization may stand against it. A name that holds nothing is a new
 * attempt. What the records say is only ever said about the attempt that name
 * identifies: a session's empty cart is an empty cart, and a cart some other
 * attempt is holding is that attempt's unresolved payment - neither is ever
 * answered with an order some earlier attempt placed. So the answer does not
 * depend on which process receives the submission, on how long ago the attempt
 * ran or on what the session has ordered since, and the cart's own conversion
 * is what makes a second order impossible regardless.
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
 * `@/server/errors` - stock that cannot be promised, a carrier or a processor
 * that did not answer, figures that no longer reconcile - and every one of them
 * leaves here untouched for the single mapper in that module to classify. The
 * one exception is the cart service reporting that a checkout is holding the
 * session's cart, which to a customer is an unresolved payment and is answered
 * as one. Three conditions are this module's own to raise,
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
  OrderDetail,
  PaymentAuthorization,
  ShippingOption,
  ShippingQuoteResult,
} from '@/lib/types';
import {
  StorefrontConflictError,
  StorefrontError,
  StorefrontNotFoundError,
  StorefrontUpstreamError,
  StorefrontValidationError,
  paymentStatusUnknown,
} from '@/server/errors';

import { readActiveCart, vacate } from './cart.service';
import { release, reserveStock } from './inventory.service';
import type { UnpaidOrderDraft } from './order.service';
import { checkOrderDraft, claim, readAttempt, recordOrder, unclaim } from './order.service';
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
 * settled: the cart is held by it and no order was written against it, or the
 * cart it took became an order this store cannot find.
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
 * records answer afterwards through {@link recall}, so an evicted name is
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
 * result. `unsettled` holds the unresolved-payment failure this process's own
 * attempt ended in, which a repeat is given again rather than being allowed to
 * authorize the same order a second time. A definite failure is remembered as
 * nothing at all: it wrote no order and took no money, so the name is free to be
 * used again. So is an unresolved payment that is the records' answer rather
 * than this process's outcome - see {@link answers}: the records are asked
 * again on the next repeat, and may by then say more.
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
 * The unresolved-payment failures that report what the store's records say
 * about an attempt, as opposed to what an attempt this process ran ended in.
 *
 * Both reach {@link placeOrder} as `PAYMENT_STATUS_UNKNOWN`, and only the
 * second is a fact this process established and may repeat: a cart it left held
 * after sending an amount stays that way until the store settles it by hand. The
 * first is a reading of rows somebody else may change - the attempt holding the
 * cart finishes in another worker, the store settles the authorization and
 * reopens or converts the cart, a database that did not answer answers - so it
 * is not remembered, and the next repeat reads the records again. Each failure
 * is marked here as it is raised, by {@link answer}; a set of the failures
 * themselves rather than a flag on them keeps the error the route handler maps
 * exactly the one `paymentStatusUnknown` built. Weakly held, because a failure
 * is of no interest once its request has been answered.
 */
const answers = new WeakSet<StorefrontError>();

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
 * the cart at `ABANDONED` in the database, under the attempt's name, and the
 * cart stays there. So a repeat of that name finds the held cart through
 * {@link recall} and is answered with `PAYMENT_STATUS_UNKNOWN`, from any
 * process, however long afterwards, and without this module persisting anything
 * of its own. The customer is told the outcome of their payment is unresolved
 * and asked to check their orders rather than place them again, and settling
 * it is the store's: settle the authorization, then convert the cart or leave
 * it held, by hand.
 *
 * What the held cart gives up is the session's open-cart pointer, through
 * `vacate`. The pointer is what makes a cart the one its session shops with,
 * and a cart that kept it while waiting on a settlement only the store can make
 * would leave that session - on this storefront, every visitor - with no cart
 * at all until somebody edited the database. Giving it up spends nothing: the
 * cart keeps its status and its name, and a repeat of the name is answered from
 * those alone. The session's next read opens a fresh cart, so a submission
 * under any other name is an attempt at that cart like any other - an empty one
 * is told there is nothing to order - and never a second attempt at this one.
 * While an attempt is still running it keeps the pointer, which is why a
 * submission that arrives meanwhile finds `readActiveCart` reporting a cart
 * being checked out, and is answered with the unresolved payment it may be.
 *
 * No step is allowed to become the error reported. A cart that could not be put
 * back, or could not give up the pointer, is a matter for whoever runs the
 * store, and the reason the checkout failed is what the customer needs to be
 * told, so a failure here is logged and swallowed.
 *
 * @param cart The cart the checkout was holding.
 * @param reference The hold it had raised, or `null` if it had not got that far.
 * @param charged Whether an amount reached the processor without a definite
 * answer that nothing was taken. When it did, the cart stays held and gives up
 * only its session's open-cart pointer.
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
      `checkout: an authorization may stand against cart ${cart} and no order was written for it - the cart is being held under its attempt's name rather than returned to its session, so that a second attempt cannot authorize it again, and its session shops on with a fresh cart. Settle the authorization before converting the cart`,
    );

    // The cart stays held; only the session's open-cart pointer comes off it,
    // so the session is not left without a cart while the store settles this.
    // A pointer that could not come off here is set aside by the cart service
    // once the hold has outlived any attempt, so this failure delays the
    // session's next cart rather than withholding it.
    try {
      await vacate(cart);
    } catch (cause) {
      console.error(
        `checkout: cart ${cart} did not give up its session's open-cart pointer`,
        cause,
      );
    }

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
 * An unresolved-payment failure that is the store's records' answer about an
 * attempt, marked as such in {@link answers}.
 *
 * @param message The customer's sentence: {@link HELD} or {@link UNREADABLE}.
 * @param status `409` where the submission collides with a held attempt, `500`
 * where the records could not be read.
 * @param cause What made the records unreadable, or the refusal that reported
 * the held cart, for the server log.
 */
function answer(message: string, status: number, cause?: unknown): StorefrontError {
  const failure = paymentStatusUnknown(message, { upstream: 'payment', status, cause });

  answers.add(failure);

  return failure;
}

/**
 * What the store's own records say the attempt of this name already did, as an
 * answer, as a failure, or as nothing.
 *
 * This is the durable half of not repeating an attempt, and it is what answers
 * once the process that ran the attempt has forgotten it or was never the
 * process that ran it. The name is on the cart the attempt claimed, so the one
 * record that decides is that cart, and each of the things it can say has
 * exactly one safe answer:
 *
 * * **It became an order.** That order is the answer, whenever it was placed. A
 *   cutoff here would be a promise that expires without the customer being told,
 *   and the order is no less theirs an hour later.
 * * **It is held and became no order**, or it became an order that cannot be
 *   found. An attempt is holding it - running now, or ended without settling -
 *   so an authorization may stand against it and the outcome is unresolved. It
 *   is never reported as a cart that is merely gone.
 * * **The name holds no cart.** The attempt never took one, or took one and put
 *   it back having spent nothing, so there is nothing to answer with and this
 *   submission is an attempt like any other.
 *
 * A read that fails is the fourth case and is treated as the second rather than
 * the third: the records could not be consulted, so nothing is ruled out.
 *
 * The authorization is not part of an answer built here: the store keeps the
 * order and the status the payment left it in, not the processor's record of the
 * attempt, and inventing one would be describing a charge this module did not
 * see.
 *
 * @param key The attempt's name, as the submission carried it.
 * @returns The order the name's cart became, as an already-placed result, or
 * `null` when the name holds no cart of this session.
 * @throws StorefrontError `PAYMENT_STATUS_UNKNOWN` when the name's cart is held
 * with no order against it, when its order cannot be found, or when the records
 * could not be read.
 */
async function recall(key: string): Promise<CheckoutResult | null> {
  let record: { cart: string; order: OrderDetail | null } | null;

  try {
    record = await readAttempt(CART_TOKEN, key);
  } catch (cause) {
    throw answer(UNREADABLE, 500, cause);
  }

  if (record === null) {
    return null;
  }

  if (record.order !== null) {
    return { order: record.order, payment: null, outcome: 'already_placed' };
  }

  // 409: the submission collides with the attempt holding the cart. The code is
  // what carries the meaning to a customer; the status is what this is to HTTP.
  throw answer(HELD, 409);
}

/**
 * Asks the records about this attempt's name once more before a refusal about
 * the session's cart is given, and answers with what they say instead when the
 * name has meanwhile taken a cart.
 *
 * {@link recall} runs before the cart is read, and the cart can change between
 * the two - most importantly under a repeat of this very attempt. A submission
 * whose reply was lost and its repeat can both find the name holding nothing
 * and both read the same open cart; exactly one of them wins the claim, and the
 * other would then report "this cart is already being checked out" - a
 * collision that reads as "nothing was charged" to a caller resolving that
 * attempt, while the winner, which is that same attempt, goes on to charge for
 * it and place the order. The same holds for a cart the winner has already
 * converted, which the storefront replaces with an empty one, and for a cart
 * the winner is holding, which the cart service reports as held. So every
 * refusal about the cart is checked against the name first: a name that now
 * holds a cart is answered from it - its order, or the unresolved payment of
 * the attempt holding it - and only a name that still holds nothing gets the
 * refusal, which is then a true statement about this attempt.
 *
 * @param key The attempt's name, as the submission carried it.
 * @param refusal What this submission would otherwise be told about the cart.
 * @returns The order the name's cart became, as an already-placed result.
 * @throws StorefrontError `PAYMENT_STATUS_UNKNOWN` when the name's cart is held
 * with no order against it, or when the records could not be read.
 * @throws `refusal` when the name still holds no cart of this session.
 */
async function recheck(key: string, refusal: unknown): Promise<CheckoutResult> {
  const later = await recall(key);

  if (later !== null) {
    return later;
  }

  throw refusal;
}

/**
 * Runs one attempt at placing the order the checkout form submitted.
 *
 * Everything an order involves happens here and in the order it is written;
 * {@link placeOrder} is the door in front of it that decides whether an attempt
 * should run at all. The first thing asked is whether this attempt has already
 * been made - {@link recall} - and only a name that holds nothing goes on to the
 * session's cart. Every refusal the session's cart leads to - an empty cart, a
 * held cart, a claim that lost - is put to {@link recheck} before it is given,
 * so a repeat racing the very attempt it repeats is answered with that
 * attempt's outcome rather than with a statement that nothing was charged.
 *
 * @param draft The submitted checkout: who is buying, where the goods are
 * going, which shipping service was chosen and whatever the buyer asked the
 * packers to know, under the name of the attempt it belongs to. The first four
 * are handed to `./order.service`, which stores the contact, the destination and
 * the note with the order; the name goes on the cart the attempt claims.
 * @param origin The scheme and authority this application is answering on, as
 * the route handler read it from its own request. The carrier and the payment
 * processor are reached against it, so nothing here names a host.
 * @returns The order as it was written - its lines, the service it ships by and
 * the destination and note stored with it - together with the authorization
 * that paid for it, or the order this attempt's name had already placed, as
 * `outcome: 'already_placed'` with no authorization.
 * @throws StorefrontValidationError When the session's cart is empty, and when
 * the assembled order is not one the order service can record - the latter
 * refused by `checkOrderDraft` before any amount is sent to the processor, so a
 * submission that cannot become an order is never charged for.
 * @throws StorefrontConflictError When a checkout under another name took the
 * cart, or made it an order, between the read and the claim, when the attempt's
 * name is already on a cart it no longer holds, when the chosen shipping service
 * is not among those now offered to the destination, or when the assembled
 * order's figures do not reconcile with one another - the last of those, like a
 * non-recordable draft, before any amount is sent.
 * @throws StorefrontError `PAYMENT_DECLINED` when the processor declined the
 * authorization. No order is written for a payment nobody approved.
 * @throws StorefrontError `PAYMENT_STATUS_UNKNOWN` when an amount was sent to
 * the processor and its outcome cannot be established, when an approved amount
 * could not be turned into an order, when the attempt's name holds a cart with
 * no order that can be found, when the records of it could not be read, or when
 * the session's cart is held by another attempt that is still running. It is
 * the only failure from here that does not mean nothing was captured.
 * Everything else the services raise - stock that cannot be promised, a carrier
 * that did not answer, figures that no longer reconcile - propagates as it was
 * raised.
 */
async function attempt(draft: CheckoutDraft, origin: string): Promise<CheckoutResult> {
  // Asked before the session's cart is read, because a repeat is about the cart
  // its attempt took and not about the one the session has now: after an order
  // the storefront opens the next cart, and the customer may already have put
  // something in it.
  const earlier = await recall(draft.idempotencyKey);

  if (earlier !== null) {
    return earlier;
  }

  let cart: CartView;

  try {
    cart = await readActiveCart(CART_TOKEN);
  } catch (cause) {
    // The cart service opens a cart for a session that has none, so the one
    // state it reports instead of a cart is a cart a checkout is holding right
    // now: a running attempt holds the session's open-cart pointer, while one
    // that ended unsettled has given the pointer up - its cart still held under
    // its name, for the store to settle - and left the session a fresh cart. An
    // attempt still holding the pointer may carry an authorization, or be about
    // to.
    // It is not this submission's attempt, whose name was asked about above, so
    // it is answered as the unresolved payment it may be and never with an
    // order some other attempt placed - unless the attempt holding it turns out
    // to be this one, taken since the name was asked about, which `recheck`
    // settles. Anything else the read raised is not about an attempt at all and
    // propagates as it was raised.
    if (cause instanceof StorefrontNotFoundError) {
      return recheck(draft.idempotencyKey, answer(HELD, 409, cause));
    }

    throw cause;
  }

  if (cart.lines.length === 0) {
    // Nothing to order. A repeat of an attempt that placed an order was answered
    // above from that attempt's own cart, so an empty cart here is exactly what
    // it looks like, whatever this session ordered before - once `recheck` has
    // ruled out that this very attempt converted the cart in the meantime.
    return recheck(
      draft.idempotencyKey,
      new StorefrontValidationError(
        'There is nothing in your cart to order. Add an item and place the order again.',
      ),
    );
  }

  // The cart is taken before anything is spent against it, so a second checkout
  // of the same cart is turned away here rather than at the end - after it too
  // has held stock, rated a shipment and had an amount approved. The attempt's
  // name is written with the claim, which is what lets a repeat of it be
  // answered from this cart by any process from here on. A claim that fails is
  // put to `recheck` before it is reported: the checkout that won the cart may
  // be this same attempt, and then its outcome is the answer, not a collision.
  try {
    await claim(cart.id, draft.idempotencyKey);
  } catch (cause) {
    return recheck(draft.idempotencyKey, cause);
  }

  let reference: string | null = null;
  let charged = false;

  try {
    const reservation = await reserveStock(cart.lines);

    reference = reservation.reference;

    const pricing = await applyPromotions(cart.lines);

    // Both halves of the destination, because freight is rated to a place and a
    // postal code names one only within a country: quoting the code alone would
    // rate this order to the store's own country whatever address the buyer
    // gave, and the amount charged would then differ from the amount the
    // checkout form showed them for their own destination.
    const shipping = await quote(
      {
        postalCode: draft.shippingAddress.postalCode,
        country: draft.shippingAddress.country,
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
      notes: draft.notes,
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
 * still running - the very result the first caller is waiting for. A name it is
 * not holding runs {@link attempt}, which asks the store's records about that
 * name before it does anything else, so a name this process has never seen is
 * still answered with what the attempt of that name did elsewhere or earlier.
 *
 * A definite failure is remembered as nothing: it wrote no order and took no
 * money, so the same name may be used to try again once the customer has fixed
 * what was wrong. An unresolved payment this process's own attempt ended in is
 * remembered precisely so that it cannot be, because a second attempt at an
 * order that may already carry an authorization is the failure this whole
 * arrangement exists to prevent. An unresolved payment that is the records'
 * answer - a cart still held, records that could not be read - is not
 * remembered: it is marked in {@link answers} as it is raised, the records are
 * what repeat it safely, and the next repeat reads them again and hears
 * whatever they say by then.
 *
 * @param draft The submitted checkout, including the name of the attempt it
 * belongs to.
 * @param origin The scheme and authority this application is answering on, as
 * the route handler read it from its own request.
 * @returns The order and the authorization that paid for it, as
 * `outcome: 'placed'`, or the order the attempt had already placed, as
 * `outcome: 'already_placed'`.
 * @throws Whatever the attempt raised - see {@link attempt} - or, for a repeat
 * of an attempt of this process's that ended with a payment whose outcome is
 * unresolved, that same failure again - or, once `next dev` has re-evaluated
 * this module since, the records' answer about that attempt.
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

    // A failure raised by an earlier evaluation of this module is an instance
    // of that evaluation's error classes: `next dev` re-evaluates the server
    // modules on every edit while this map outlives them on `globalThis`, and
    // the route handler's mapper recognises only the classes it was loaded
    // with, so it would answer the repeat as a fault of its own. Such a failure
    // is forgotten instead, and the records answer the repeat exactly as they
    // answer any name this process no longer holds - as an unresolved payment
    // for as long as the attempt's cart is held.
    if (seen.failure instanceof StorefrontError) {
      throw seen.failure;
    }

    attempts.delete(key);
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
    // Only this process's own unresolved outcome is kept; the records' answer is
    // asked for again on the next repeat - see `answers`.
    if (
      cause instanceof StorefrontError &&
      cause.code === 'PAYMENT_STATUS_UNKNOWN' &&
      !answers.has(cause)
    ) {
      attempts.set(key, { state: 'unsettled', at: Date.now(), failure: cause });
    } else {
      attempts.delete(key);
    }

    throw cause;
  }
}
