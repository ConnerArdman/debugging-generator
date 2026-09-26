/**
 * `GET /api/shipping/quote` - which services can carry a shipment to a
 * destination, what each costs and how long each takes.
 *
 * `shippingQuoteQuerySchema` in `@/server/validation/shipping` declares and
 * bounds every parameter and defaults all but the destination postal code, so
 * that code alone is a complete request. The origin the carrier is reached at
 * is read off the request rather than configured, and the service checks it
 * against `@/server/origin` before addressing anything to it. The
 * `ShippingQuoteResult` from `@/server/services/shipping.service` is returned
 * as it stands. A rate holds only for the moment it was quoted, so the segment
 * is dynamic, every response is `no-store` and nothing is memoized at module
 * scope.
 */

import type { ShippingQuoteResult } from '@/lib/types';
import { storefrontErrorResponse } from '@/server/errors';
import { quote, type ShippingQuoteInput } from '@/server/services/shipping.service';
import { shippingQuoteQuerySchema } from '@/server/validation/shipping';

/**
 * Answer every request by rating the shipment it names rather than from a
 * build-time render or a cached entry. It also keeps `next build` from reaching
 * for a carrier or a database it has no reason to need: there is nothing here to
 * prerender.
 */
export const dynamic = 'force-dynamic';

/**
 * Quotes the shipping services offered to the destination a request names.
 *
 * @param request The incoming request. Its query string carries the destination
 * postal code and, optionally, the country that code is in, what the shipment
 * weighs, how many units travel in it and which tier of service to quote
 * around.
 * @returns 200 with a `ShippingQuoteResult` - the services on offer, the
 * destination they were quoted for and the instant they were quoted at, with
 * `id: null` because a quote taken for a destination rather than for a cart is
 * not recorded. This endpoint is therefore safe to repeat: it writes nothing,
 * which is what a `GET` a browser, a prefetch or a retry may replay has to be.
 * A destination with no service offered to it is answered with no options,
 * which is a result rather than a failure. Any failure is answered by
 * `storefrontErrorResponse` in the one envelope every endpoint of this
 * application uses: 400 for a query the schema rejected - including a postal
 * code that is not a complete one for its country - or a request that was not
 * addressed to this store, 502 when the carrier could not be reached, refused
 * the shipment or answered with nothing this storefront can read, and a message
 * that names no value the caller supplied for anything else.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    // Read once: the same URL carries both the parameters that describe the
    // shipment and the authority the carrier is reached on.
    const url = new URL(request.url);

    // A query string carries scalars only, and `Object.fromEntries` collapses a
    // repeated key to its last value, which is the right reading for every
    // parameter this endpoint accepts. A parameter nobody stated is an absent
    // key rather than a `null`, so the schema's default takes over instead of
    // coercing nothing to a figure, and unknown parameters are stripped - a
    // checkout URL that also carries a campaign parameter still asks a
    // perfectly good question.
    const query: ShippingQuoteInput = shippingQuoteQuerySchema.parse(
      Object.fromEntries(url.searchParams),
    );

    const result: ShippingQuoteResult = await quote(query, url.origin);

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
