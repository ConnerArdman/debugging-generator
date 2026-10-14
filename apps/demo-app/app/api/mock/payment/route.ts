/**
 * `POST /api/mock/payment` - the storefront's stand-in payment processor.
 *
 * Lumen Supply ships without a processor account, so the application answers the
 * authorization request itself: `authorize()` in
 * `@/server/services/payment.service` posts an amount, a currency and what the
 * attempt is for to this endpoint over HTTP, exactly as it would post them to a
 * provider, and reads the outcome back out of the reply. That is what lets a
 * checkout complete on a laptop with nothing behind it but a database.
 *
 * Being a stand-in rather than a provider is why the handler is as short as it
 * is, and it decides three things:
 *
 * 1. **Nothing is judged here.** An authorization turns on a payment
 *    instrument, a balance and a network this application has none of, so the
 *    approval below is unconditional: what the endpoint exercises is the shape
 *    of the exchange - a body that has to be valid, a wait, and a reply in one
 *    fixed shape - and never a verdict about somebody's money. No instrument is
 *    accepted either, because `paymentMockBodySchema` describes a body with no
 *    card number, no verification code and no account in it.
 * 2. **The reply is derived from the request.** The amount comes back as it was
 *    sent and the reference is built from the one the caller named, so two
 *    identical requests are answered identically. The handler reads no
 *    database, calls nothing over the network, keeps no state and does no work
 *    at module scope.
 * 3. **The reply speaks `@/lib/types`.** Money is an integer number of US cents
 *    in a `*Cents` field, the instant the attempt was accepted is an ISO-8601
 *    UTC string, and the body carries exactly the fields
 *    {@link PaymentAuthorization} declares - a `Date` never leaves here, and
 *    neither does a field the caller has no type for, which is why the currency
 *    is validated and then not restated.
 */

import type { PaymentAuthorization } from '@/lib/types';
import { readStorefrontJsonBody, storefrontErrorResponse } from '@/server/errors';
import { paymentMockBodySchema } from '@/server/validation/mocks';

/**
 * An authorization is answered, never described, so the route is handled per
 * request and never prerendered: `next build` authorizes nothing, and no reply
 * is served again for a later attempt.
 */
export const dynamic = 'force-dynamic';

/**
 * Simulated authorization processing time, in milliseconds.
 *
 * A processor takes a moment to answer, and a reply that came back instantly
 * would make the checkout read as though the step were free. It is a flat
 * figure rather than a varying one, so the same request costs the same time on
 * every run.
 */
const DELAY = 120;

/** What an authorization reference issued here begins with. */
const PREFIX = 'AUTH';

/** What a caller is told when the request body was not readable JSON. */
const UNREADABLE = 'The payment request body could not be read as JSON.';

/**
 * Authorizes a payment and answers with how the attempt resolved.
 *
 * @param request The POST whose JSON body `paymentMockBodySchema` describes: an
 * amount in whole US cents, optionally a currency code and optionally the
 * identifier of the order or cart being paid for.
 * @returns 200 with a {@link PaymentAuthorization}, or the storefront's one
 * error envelope: 415 when the body was not declared as `application/json`, 413
 * when it carries more bytes than this endpoint reads, and 400 when the body is
 * not readable JSON or does not match the schema.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    // Read through the one guarded reader in `@/server/errors` rather than with
    // `request.json()`: a body that was not declared as JSON is refused with
    // 415 and one past the store's byte ceiling with 413, both before anything
    // is parsed, and an empty or malformed body comes back as the validation
    // failure it is - the caller's mistake rather than a failure of this
    // endpoint.
    const payload: unknown = await readStorefrontJsonBody(request, { unreadable: UNREADABLE });

    // Parsing throws, and the rejection names every field at fault: the single
    // mapper behind `storefrontErrorResponse` turns it into the same 400 every
    // other endpoint answers an unacceptable body with.
    const body = paymentMockBodySchema.parse(payload);

    // Read once, before the wait, and reported as the instant the attempt was
    // accepted. A second read would describe a moment this handler had already
    // spent.
    const processedAt = new Date().toISOString();

    await new Promise<void>((resolve) => {
      setTimeout(resolve, DELAY);
    });

    // A reference the caller named identifies the attempt; an attempt that
    // named none is identified by what it authorized, which is all it has.
    // Both are derived rather than invented, so a repeated request comes back
    // under the same reference.
    const attempt = body.reference ?? `${body.currency}-${body.amountCents}`;

    const authorization: PaymentAuthorization = {
      authorized: true,
      reference: `${PREFIX}-${attempt}`,
      // Echoed rather than recomputed, so an order reconciles against the total
      // the checkout asked to have authorized.
      amountCents: body.amountCents,
      processedAt,
      declineReason: null,
    };

    return Response.json(authorization, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (error: unknown) {
    return storefrontErrorResponse(error);
  }
}
