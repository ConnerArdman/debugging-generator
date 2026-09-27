/**
 * Payment authorization for the Lumen Supply checkout.
 *
 * A placed order has to be paid for, and this module is the storefront's one
 * door to the payment processor: the checkout hands it the amount it computed
 * and the identifier the attempt belongs to, and receives back how the
 * processor resolved it. Nothing else in the server layer speaks to a
 * processor, so every authorization this application records was built here,
 * from one reply, in one shape.
 *
 * Lumen Supply ships without a processor account, so the endpoint behind this
 * module is the application's own stand-in, `POST /api/mock/payment`. It is
 * reached over HTTP rather than called in process, exactly as a real processor
 * would be: the request leaves this module, carries a JSON body, is held to a
 * timeout and fails in the ways a network dependency fails. The path is
 * resolved against the `origin` the route handler read from its own request,
 * because a server-side `fetch` needs an absolute URL and this process is the
 * wrong place to guess a host - a port chosen at startup, a proxy or a
 * tunnelled address would each make a base URL written here wrong. That origin
 * is checked against `@/server/origin` before anything is addressed to it: it
 * reaches this module from a request, and an amount to charge is not a thing to
 * send wherever a request asked for it to be sent.
 *
 * The conventions of `@/lib/types` hold at both ends of the call. Money is an
 * integer number of US cents in a `*Cents` field, in the body sent as much as
 * in the {@link PaymentAuthorization} returned, and the instant an attempt was
 * processed is an ISO-8601 UTC string, normalised here from whatever form the
 * reply carried it in. No `Date` reaches the returned value: it goes on into an
 * order and through JSON to the browser.
 *
 * Three rules govern how a reply is read, and they are why the code below is as
 * careful as it is:
 *
 * 1. **An outcome is never invented.** `authorized` is taken from the reply and
 *    from nowhere else. A non-2xx status, a body that is not JSON and a body
 *    that does not state the outcome are all failures rather than approvals.
 *    Every other field has a sound local fallback - the amount asked
 *    for, the reference sent, the moment the reply was read - so a processor
 *    that answers tersely still yields a complete authorization.
 * 2. **A failure says whether an amount may have been taken.** That is the one
 *    thing a customer needs from it, and the two kinds are not interchangeable.
 *    A processor that refuses the request it was sent - the client-error
 *    statuses, which say the request was rejected rather than acted on - took
 *    nothing, and that is a {@link StorefrontUpstreamError}. A request that was
 *    sent and not answered readably - a connection that did not come back, a
 *    timeout, a server-side status, a reply whose outcome cannot be read -
 *    leaves an authorization possibly standing, and that is
 *    {@link paymentStatusUnknown}. Collapsing the second into the first would
 *    have the storefront promise a customer they were not charged on the
 *    strength of a reply it never read.
 * 3. **A caller's mistake stays a caller's mistake.** The amount, the currency
 *    and the reference are checked here against the same rules the endpoint
 *    enforces, so a fractional amount, an amount above the most the processor
 *    authorizes in one payment ({@link MAX_PAYMENT_CENTS}) or a blank reference
 *    is reported as the validation failure it is instead of returning as a bare
 *    rejection from a dependency. Nothing has been sent at that point, so
 *    nothing was taken.
 *
 * A declined authorization is not a failure of this module: it returns with
 * `authorized: false` and the wording to show for it, and the checkout decides
 * what that means for the order it was placing. The module reads no database,
 * keeps no state and does no work at module scope.
 */

import { formatPriceLabel } from '@/lib/format';
import { MAX_PAYMENT_CENTS, type PaymentAuthorization } from '@/lib/types';
import {
  StorefrontUpstreamError,
  StorefrontValidationError,
  paymentStatusUnknown,
} from '@/server/errors';
import { trusted } from '@/server/origin';

/**
 * How long the processor is given to answer, in milliseconds.
 *
 * It is a ceiling on a hung connection rather than a performance budget: an
 * authorization that takes longer than this is not going to arrive, while one
 * that takes a moment must never be cut short and reported as a failure when it
 * was about to succeed.
 */
const TIMEOUT = 10_000;

/** The shape of a currency code: three letters, upper case. */
const CURRENCY = /^[A-Z]{3}$/;

/**
 * The one status a client-error reply carries that does not mean the request
 * was rejected unacted-upon: a request the processor timed out on is a request
 * it may have begun.
 */
const TIMED_OUT = 408;

/**
 * What a visitor is told when the processor's reply could not be read.
 *
 * It says what this module actually knows in that situation - the order was not
 * completed, and whether an amount was taken is unresolved - and names neither
 * the endpoint nor what was wrong with the reply: a reply this application could
 * not parse is not something to quote back to a browser. The customer is sent to
 * their orders rather than back to the button, because pressing it again is the
 * one action that could turn an unresolved authorization into two.
 */
const UNREADABLE =
  'The payment service replied in a form this storefront could not read, so this order was not completed and whether the payment was taken is unresolved. Check your orders before placing it again.';

/**
 * What a visitor is told when no reply came back at all: the same unresolved
 * situation, reached by a connection that did not return rather than by one
 * that returned something unreadable.
 */
const UNANSWERED =
  'The payment service did not answer, so this order was not completed and whether the payment was taken is unresolved. Check your orders before placing it again.';

/**
 * What a visitor is told when the processor answered that it could not complete
 * the authorization without saying what became of it - a failing reply that is
 * not the processor turning the request away.
 */
const UNSETTLED =
  'The payment service could not complete this authorization, so this order was not completed and whether the payment was taken is unresolved. Check your orders before placing it again.';

/** The wording to show for a decline the processor gave no reason for. */
const DECLINED = 'The payment was declined by the processor.';

/**
 * What a caller is told when the address it handed over is not one this store
 * may reach itself at. No amount is authorized against it, and the wording
 * repeats no part of the address: it came from the request in the first place.
 */
const MISADDRESSED = 'This request was not addressed to this store, so no payment was attempted.';

/**
 * What a caller is told when the amount is more than the processor authorizes
 * in one payment.
 *
 * The processor would refuse it, and would say only that it refused; asked
 * here first, the refusal names the figure and what to do about it - an order
 * that size is not something trying again will change. Nothing is sent, so
 * nothing is taken, and the sentence says both. The ceiling is worded by
 * `@/lib/format`, the same formatter every price in the storefront is printed
 * through.
 */
const OVERSIZED = `A single payment cannot be more than ${formatPriceLabel(MAX_PAYMENT_CENTS)}, so no payment was attempted and nothing was charged. Reduce the order, then place it again.`;

/**
 * What to authorize: an amount, the currency it is counted in, and what the
 * attempt is for.
 *
 * It exists because no data-transfer type in `@/lib/types` describes a payment
 * request - the browser never asks for an authorization, the checkout does -
 * and a caller is better served by three named fields than by three positional
 * arguments of which two are strings.
 */
export interface PaymentAuthorizationInput {
  /**
   * How much to authorize, as an integer number of US cents, exactly as every
   * other monetary value in the storefront is counted. Zero is accepted:
   * authorizing nothing is how an attempt is made without a charge.
   */
  amountCents: number;

  /**
   * Which currency `amountCents` is counted in, as its three-letter code. It is
   * accepted in either case and sent upper case; the store prices in US
   * dollars, so `USD` is what the checkout passes.
   */
  currency: string;

  /**
   * What the attempt is for: the identifier of the order or cart being paid,
   * which the processor's record of the attempt is tied back to.
   */
  reference: string;
}

/**
 * Whether `value` is a JSON object - the one shape whose fields a reply can be
 * read from.
 *
 * A parsed body arrives as `unknown`, and this is the single narrowing that
 * turns it into something addressable. Reading a key of an object always yields
 * `unknown`, so nothing below may be used before its own type is checked.
 */
function fields(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `value` trimmed when it is a string with something in it, `null` otherwise. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

/** `value` when it is a whole, non-negative number of cents, `null` otherwise. */
function cents(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Whether a failing `status` means the processor turned the request away rather
 * than acting on it.
 *
 * A client-error status is the processor saying the request was not one it would
 * process - malformed, unauthorized, addressed to nothing, refused - and a
 * request that was not processed authorized nothing. A request it timed out on
 * is the exception, because a timeout is reported about work that may have
 * started. Everything else a failing reply can carry - a server-side status, a
 * redirect nothing followed, an informational status - says nothing either way
 * and is therefore unresolved.
 *
 * @param status The status of the failing reply.
 */
function refused(status: number): boolean {
  return status >= 400 && status < 500 && status !== TIMED_OUT;
}

/**
 * `value` as an ISO-8601 UTC string when it is a readable instant, `null`
 * otherwise.
 *
 * Both forms a processor might state an instant in are accepted - a date string
 * and a count of milliseconds since the epoch - and both come out in the one
 * form the storefront's types carry. A value that is neither, or that lands
 * outside the range a date can hold, is refused rather than turned into an
 * invalid date, so the caller can fall back instead of returning nonsense.
 */
function stamp(value: unknown): string | null {
  const time =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;

  if (!Number.isFinite(time)) {
    return null;
  }

  const at = new Date(time);

  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * Authorizes a payment with the processor and reports how the attempt resolved.
 *
 * A returned value is the processor's answer, not a verdict of this module's:
 * `authorized` may be `false`, in which case `declineReason` carries the
 * wording to show, and it is the caller that decides what a decline means for
 * the order it was placing.
 *
 * @param input What to authorize; see {@link PaymentAuthorizationInput}.
 * @param origin The scheme and host this application is answering on - what a
 * route handler reads from its own request, such as `new URL(request.url).origin`.
 * The endpoint's path is resolved against it, so it is checked against
 * `@/server/origin` first: an address this store may not reach itself at is
 * refused before an amount is sent anywhere.
 *
 * @throws StorefrontValidationError when the amount is not a whole,
 * non-negative number of cents or is more than {@link MAX_PAYMENT_CENTS}, the
 * currency is not a three-letter code, no reference was given, or the address
 * handed over is not one this store may reach itself at. Nothing has been sent
 * at that point, so nothing was taken.
 * @throws StorefrontUpstreamError when the processor turned the request away:
 * a client-error status other than a timeout, which is the processor declining
 * to process the request rather than an answer about an amount. Nothing was
 * taken.
 * @throws StorefrontError `PAYMENT_STATUS_UNKNOWN` when the request was sent
 * and its outcome cannot be established - the processor did not answer, timed
 * out, answered with a server-side status, or answered with a body this module
 * could not read an outcome from. An authorization may stand, and the caller
 * must not treat this as a definite refusal.
 *
 * @example
 * ```ts
 * const payment = await authorize(
 *   { amountCents: 48_250, currency: 'USD', reference: order.id },
 *   new URL(request.url).origin,
 * );
 * ```
 */
export async function authorize(
  input: PaymentAuthorizationInput,
  origin: string,
): Promise<PaymentAuthorization> {
  const amount = input.amountCents;

  if (!Number.isInteger(amount) || amount < 0) {
    throw new StorefrontValidationError(
      'A payment amount must be a whole number of cents and cannot be negative.',
    );
  }

  // The processor's own ceiling, asked before anything is sent: the stand-in
  // processor refuses a larger amount with a client error, which would come back
  // as a processor that turned the request away - true, but no help to a buyer
  // whose order is simply larger than one payment can be.
  if (amount > MAX_PAYMENT_CENTS) {
    throw new StorefrontValidationError(OVERSIZED);
  }

  const currency = input.currency.trim().toUpperCase();

  if (!CURRENCY.test(currency)) {
    throw new StorefrontValidationError('A payment currency must be a three-letter code.');
  }

  const reference = input.reference.trim();

  if (reference.length === 0) {
    throw new StorefrontValidationError('A payment attempt must name what it is being made for.');
  }

  if (!trusted(origin)) {
    throw new StorefrontValidationError(MISADDRESSED);
  }

  const url = new URL('/api/mock/payment', origin);
  const body = JSON.stringify({ amountCents: amount, currency, reference });

  let response: Response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      // A payment is a moment in time and its reply is never reusable: the
      // request is made afresh every time, whatever a cache would otherwise
      // make of a POST to this path.
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (cause) {
    // The request left this process and nothing came back - dropped, refused by
    // the transport or out of time - so whether the processor received it and
    // acted on it is not something this module can establish. The caught value
    // is kept for the server log only: it may name a host or a port, and
    // neither belongs in a response body.
    throw paymentStatusUnknown(UNANSWERED, { upstream: 'payment', cause });
  }

  if (!response.ok) {
    // Whatever the body of a failing reply holds, it is not an outcome. Which
    // failure it is, though, decides what a customer is told: a processor that
    // turned the request away authorized nothing, while any other failing reply
    // leaves that unresolved.
    if (refused(response.status)) {
      throw new StorefrontUpstreamError(
        'The payment service would not process this authorization, so nothing was charged and this order was not completed. Please try again in a moment.',
        'payment',
      );
    }

    throw paymentStatusUnknown(UNSETTLED, { upstream: 'payment' });
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch (cause) {
    throw paymentStatusUnknown(UNREADABLE, { upstream: 'payment', cause });
  }

  if (!fields(payload)) {
    throw paymentStatusUnknown(UNREADABLE, { upstream: 'payment' });
  }

  const authorized = payload.authorized;

  // The outcome is the one field with no fallback. A reply that reached this
  // point was the processor answering the request it was sent, so a reply that
  // does not state the outcome plainly leaves it unresolved rather than refused:
  // the alternative - assuming an answer - is either an order shipped against a
  // payment nobody approved or a customer told they were not charged when they
  // were.
  if (typeof authorized !== 'boolean') {
    throw paymentStatusUnknown(UNREADABLE, { upstream: 'payment' });
  }

  return {
    authorized,
    // Each remaining field is the processor's if it stated one, and otherwise
    // what this application already knows: the reference it sent, the amount it
    // asked for, and the moment the reply was read.
    reference: text(payload.reference) ?? reference,
    amountCents: cents(payload.amountCents) ?? amount,
    processedAt: stamp(payload.processedAt) ?? new Date().toISOString(),
    declineReason: authorized ? null : (text(payload.declineReason) ?? DECLINED),
  };
}
