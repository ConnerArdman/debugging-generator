/**
 * `GET /api/shipping/quote` - which services can carry a shipment to a
 * destination, what each costs and how long each takes.
 *
 * The checkout form asks this endpoint while the customer is still filling it
 * in, through `requestShippingQuote` in `@/lib/api-client`, and the handler does
 * what a route handler in this workspace does and nothing else: it parses the
 * query string with the schema that declares it, hands the parsed shipment and
 * the origin the request arrived on to the service that answers it, and
 * serializes that answer as it stands. There is no tariff arithmetic here, no
 * carrier call, no database access and no second copy of the query rules: the
 * parameters live in `@/server/validation/shipping`, the work lives in
 * `@/server/services/shipping.service`, and this module is where the request and
 * that work meet.
 *
 * Four decisions are worth stating, because a reader would otherwise reasonably
 * expect the opposite:
 *
 * 1. **No parameter is defaulted here, and no rejection is answered here.**
 *    Every parameter this endpoint accepts is declared, bounded and defaulted
 *    once, in `shippingQuoteQuerySchema`, which is why a request naming a
 *    destination and nothing else - the only request the browser makes - parses
 *    to a complete shipment. The throwing `parse` is used deliberately: the
 *    `ZodError` it raises propagates to the single mapper in `@/server/errors`,
 *    which answers 400 in the one envelope every endpoint of this application
 *    uses and names the parameters it rejected without repeating what was
 *    received, because a postal code is somebody's address even when it is
 *    malformed. Quietly substituting a default for a rejected parameter would
 *    quote a shipment nobody described.
 * 2. **The origin is read off the request rather than configured.** The service
 *    reaches the carrier over HTTP and needs an absolute address to reach it at,
 *    and the one place that address is known is the request being served: a host
 *    written into this file or read from the environment would be a second
 *    description of where this application answers, and would be wrong the first
 *    time it was served on another port. A request's authority is chosen by
 *    whoever sent it, so it is checked before anything is addressed to it - by
 *    the service, against `@/server/origin`, which is also the module that
 *    builds the address. This handler passes the value on and judges nothing
 *    about it.
 * 3. **Nothing is cached.** A rate is quoted for the shipment and the moment it
 *    was asked about, so the segment is dynamic, every response says `no-store`,
 *    and nothing is memoized at module scope or de-duplicated in flight: one
 *    request from the browser is one quote, and two identical requests are two.
 *    A destination the customer has since corrected is a different question, and
 *    a rate served again from a cache would answer the earlier one.
 * 4. **The payload is passed through untouched.** The service already stated the
 *    quote in the shapes of `@/lib/types` - money as an integer count of US
 *    cents in its `*Cents` fields, transit time as a whole number of business
 *    days, the instant it was quoted at as an ISO-8601 UTC string - so
 *    re-labelling, re-rounding or reordering anything here could only introduce
 *    a disagreement between this endpoint and the picker that reads it.
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
 * postal code and, optionally, what the shipment weighs, how many units travel
 * in it and which tier of service to quote around; `shippingQuoteQuerySchema`
 * owns which of those are required, what they are bounded to and what they
 * default to, so a request carrying a destination alone is a perfectly good one.
 * Its URL is also read for the origin the carrier is reached on.
 * @returns 200 with a `ShippingQuoteResult` - the quote the store recorded, the
 * services on offer, the destination they were quoted for and the instant they
 * were quoted at - and `no-store`, so neither the dev server nor the browser
 * serves the rates again. A destination with no service offered to it is
 * answered with no options, which is a result rather than a failure. Any failure
 * is answered by `storefrontErrorResponse` in the one envelope every endpoint of
 * this application uses: 400 for a query the schema rejected or a request that
 * was not addressed to this store, 502 when the carrier could not be reached,
 * refused the shipment or answered with nothing this storefront can read, and a
 * message that names no value the caller supplied for anything else.
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
