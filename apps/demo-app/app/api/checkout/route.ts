/**
 * `POST /api/checkout` - turns the cart this browser is shopping with into an
 * order.
 *
 * The handler is four steps and nothing else: read the body with the one schema
 * that describes it, read the origin off the request, hand both to the checkout
 * service, and answer with the `CheckoutResult` the service built. The body's
 * shape lives in `@/server/validation/checkout`, everything an order involves -
 * the cart, the stock, the prices, the freight, the authorization and the write -
 * lives in `@/server/services/checkout.service`, and every failure becomes a
 * response through the single mapper in `@/server/errors`. So this file holds no
 * schema, no query, no arithmetic and no error classification of its own: it is
 * the endpoint's HTTP surface and nothing more.
 *
 * `origin` is read from `request.url` rather than from a constant or an
 * environment variable, because the server layer names no host: the services
 * behind this endpoint build the absolute URLs they need from whatever scheme
 * and authority this request arrived on, so the same code answers on a
 * developer's laptop and on a colleague's different port without a value
 * configured anywhere. A request's authority is chosen by whoever sent it,
 * though, so it is checked against `@/server/origin` before it is handed on:
 * the services reached through it are asked to rate a shipment to a customer's
 * address and to approve an amount, and a submission claiming to have arrived
 * somewhere else is refused rather than answered.
 *
 * The result is serialized exactly as the service built it. Money is already an
 * integer count of US cents in its `*Cents` fields and every instant is already
 * an ISO-8601 UTC string, which is why the object is passed to `Response.json`
 * untouched rather than re-mapped here: a field renamed, rounded or reordered in
 * this file would be a second, divergent description of a shape `@/lib/types`
 * already publishes.
 *
 * Placing an order is a write, and each submission is its own attempt against
 * the state of the moment - the cart, the stock and the prices as they stand -
 * so every response says `no-store`, the segment is declared dynamic, and there
 * is no caching, reuse or de-duplication anywhere in this file: one request from
 * the browser is one checkout.
 *
 * That is deliberately not the same as "one request from the browser is one
 * order". A submission names the attempt it belongs to, and repeating that name
 * is how a caller whose reply was lost asks what became of its attempt: the
 * service answers such a repeat with the order the attempt already placed,
 * marked as such in the result's `outcome`, and writes no second one. The
 * decision is the service's because it is a decision about the cart and the
 * order, not about HTTP; this handler neither remembers a submission nor
 * compares two.
 */

import type { CheckoutDraft, CheckoutResult } from '@/lib/types';
import {
  StorefrontValidationError,
  readStorefrontJsonBody,
  storefrontErrorResponse,
} from '@/server/errors';
import { trusted } from '@/server/origin';
import { placeOrder } from '@/server/services/checkout.service';
import { checkoutBodySchema } from '@/server/validation/checkout';

/**
 * An order is placed, never described, so the route is handled per request and
 * never prerendered: `next build` neither reads this route nor needs a database
 * to produce the build output, and no reply is served again for a later
 * submission.
 */
export const dynamic = 'force-dynamic';

/** What a caller is told when the request body was not readable JSON. */
const UNREADABLE = 'The checkout request body could not be read as JSON.';

/**
 * What a caller is told when the request claims to have arrived somewhere this
 * store is not served. It names no address: the one at fault came from the
 * request itself.
 */
const MISADDRESSED = 'This request was not addressed to this store.';

/**
 * Places the order this request submitted and answers with it.
 *
 * @param request The POST whose JSON body `checkoutBodySchema` describes: who is
 * buying, where the goods are going, which shipping service was chosen, any
 * delivery note, and the name of the attempt the submission belongs to. Its URL
 * is read for the origin the services answer on; the cart is not named by the
 * request, because it belongs to this browser's session and the server resolves
 * it.
 * @returns `200` with the `CheckoutResult` - the order and the authorization
 * that paid for it, as `outcome: 'placed'`, or the order the named attempt had
 * already placed, as `outcome: 'already_placed'` - or the mapper's failure
 * envelope: `415` when the body was not declared as `application/json`, `413`
 * when it carries more bytes than this store reads, `400` when the body is not
 * readable JSON, does not match the schema, or the request was not addressed to
 * this store, `404` when the session has no cart at all, `409` when the stock,
 * another checkout of the same cart or the chosen shipping service no longer
 * supports the submission - or when an earlier attempt is still holding this
 * session's cart, `402` when the payment was declined, `502` when a dependency
 * did not answer, and a single generic `500` for anything unaccounted for.
 * Exactly one code says an amount may have been taken -
 * `PAYMENT_STATUS_UNKNOWN`, answered with `409`, `500` or `502` - and every
 * other failure from this endpoint means nothing was captured.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    // Read through the one guarded reader in `@/server/errors` rather than with
    // `request.json()`: a body that was not declared as JSON is refused with 415
    // and one past the store's byte ceiling with 413, both before anything is
    // parsed, and an empty or malformed body comes back as the validation
    // failure it is - the caller's mistake rather than a failure of this
    // endpoint.
    const payload: unknown = await readStorefrontJsonBody(request, { unreadable: UNREADABLE });

    // Parsing throws, and the rejection names every field at fault: the single
    // mapper behind `storefrontErrorResponse` turns it into the same 400 every
    // other endpoint answers an unacceptable body with.
    const draft: CheckoutDraft = checkoutBodySchema.parse(payload);

    const origin = new URL(request.url).origin;

    if (!trusted(origin)) {
      throw new StorefrontValidationError(MISADDRESSED);
    }

    const result: CheckoutResult = await placeOrder(draft, origin);

    return Response.json(result, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return storefrontErrorResponse(error);
  }
}
