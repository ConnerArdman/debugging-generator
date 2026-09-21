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
 * tunnelled address would each make a base URL written here wrong.
 *
 * The conventions of `@/lib/types` hold at both ends of the call. Money is an
 * integer number of US cents in a `*Cents` field, in the body sent as much as
 * in the {@link PaymentAuthorization} returned, and the instant an attempt was
 * processed is an ISO-8601 UTC string, normalised here from whatever form the
 * reply carried it in. No `Date` reaches the returned value: it goes on into an
 * order and through JSON to the browser.
 *
 * Two rules govern how a reply is read, and they are why the code below is as
 * careful as it is:
 *
 * 1. **An outcome is never invented.** `authorized` is taken from the reply and
 *    from nowhere else. A non-2xx status, a body that is not JSON and a body
 *    that does not state the outcome are all upstream failures, reported
 *    through {@link StorefrontUpstreamError} rather than resolved into an
 *    approval. Every other field has a sound local fallback - the amount asked
 *    for, the reference sent, the moment the reply was read - so a processor
 *    that answers tersely still yields a complete authorization.
 * 2. **A caller's mistake stays a caller's mistake.** The amount, the currency
 *    and the reference are checked here against the same rules the endpoint
 *    enforces, so a fractional amount or a blank reference is reported as the
 *    validation failure it is instead of returning as a bare rejection from a
 *    dependency.
 *
 * A declined authorization is not a failure of this module: it returns with
 * `authorized: false` and the wording to show for it, and the checkout decides
 * what that means for the order it was placing. The module reads no database,
 * keeps no state and does no work at module scope.
 */

import type { PaymentAuthorization } from '@/lib/types';
import { StorefrontUpstreamError, StorefrontValidationError } from '@/server/errors';

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
 * What a visitor is told when the processor's reply could not be read.
 *
 * It says the order was not completed, which is the one thing this module knows
 * for certain in that situation, and names neither the endpoint nor what was
 * wrong with the reply - a reply this application could not parse is not
 * something to quote back to a browser.
 */
const UNREADABLE =
  'The payment service returned a reply this storefront could not read, so this order was not completed.';

/** The wording to show for a decline the processor gave no reason for. */
const DECLINED = 'The payment was declined by the processor.';

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
 * The endpoint's path is resolved against it, so a value that is not an
 * absolute origin is a programming error and surfaces as one.
 *
 * @throws StorefrontValidationError when the amount is not a whole,
 * non-negative number of cents, the currency is not a three-letter code, or no
 * reference was given.
 * @throws StorefrontUpstreamError when the processor could not be reached,
 * answered with a status outside the 2xx range, or answered with a body this
 * module could not read an outcome from.
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

  const currency = input.currency.trim().toUpperCase();

  if (!CURRENCY.test(currency)) {
    throw new StorefrontValidationError('A payment currency must be a three-letter code.');
  }

  const reference = input.reference.trim();

  if (reference.length === 0) {
    throw new StorefrontValidationError('A payment attempt must name what it is being made for.');
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
    // The request did not come back - refused, dropped or out of time. The
    // caught value is kept for the server log only: it may name a host or a
    // port, and neither belongs in a response body.
    throw new StorefrontUpstreamError(
      'The payment service did not respond, so this order was not completed. Please try again in a moment.',
      'payment',
      { cause },
    );
  }

  if (!response.ok) {
    // Whatever the body of a failing reply holds, it is not an outcome: a
    // status outside 2xx is the processor declining to answer the question, not
    // an answer to it.
    throw new StorefrontUpstreamError(
      'The payment service could not process this authorization, so this order was not completed. Please try again in a moment.',
      'payment',
    );
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch (cause) {
    throw new StorefrontUpstreamError(UNREADABLE, 'payment', { cause });
  }

  if (!fields(payload)) {
    throw new StorefrontUpstreamError(UNREADABLE, 'payment');
  }

  const authorized = payload.authorized;

  // The outcome is the one field with no fallback. A reply that does not state
  // it plainly is an upstream failure, because the alternative - assuming an
  // answer - is an order shipped against a payment nobody approved.
  if (typeof authorized !== 'boolean') {
    throw new StorefrontUpstreamError(UNREADABLE, 'payment');
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
