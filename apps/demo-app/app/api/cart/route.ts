/**
 * `GET /api/cart` - the cart this browser is shopping with.
 *
 * The handler is three steps and nothing else: parse the query with the one
 * schema that describes it, hand the token to the cart service, and answer with
 * the `CartView` the service returned. Validation lives in
 * `@/server/validation/cart`, the cart's own rules and its money live in
 * `@/server/services/cart.service`, and every failure is turned into a response
 * by the single mapper in `@/server/errors` - so this file holds no schema, no
 * query, no arithmetic and no error classification of its own.
 *
 * Nothing about the request is required. `loadCartContents()` in
 * `@/lib/api-client` sends no parameters, the schema's token field carries a
 * default, and an unknown parameter is stripped rather than rejected, so an
 * empty query and a query carrying a campaign tag are both complete requests.
 *
 * A session that has no cart is not a failed request: the service opens one and
 * this endpoint answers with it, empty. So a browser opening the storefront for
 * the first time and a browser whose last cart became an order are both told
 * what their cart holds - nothing - rather than being told there is no cart,
 * and the only state that answers `404` is a cart a checkout is holding.
 *
 * The view is serialized exactly as the service built it. Money is already an
 * integer count of cents in its `*Cents` fields and the one timestamp is
 * already an ISO-8601 UTC string, which is why the object is passed to
 * `Response.json` untouched rather than re-mapped here: a field renamed,
 * rounded or reformatted in this file would be a second, divergent description
 * of a shape `@/lib/types` already publishes.
 *
 * A cart is mutable and is read straight after it is written - the drawer
 * reloads it the moment a line is added - so every response says `no-store` and
 * the segment is declared dynamic. There is no caching layer anywhere in this
 * file, and none is wanted: one request from the browser is one read of the
 * cart.
 */

import { storefrontErrorResponse } from '@/server/errors';
import { readActiveCart } from '@/server/services/cart.service';
import { cartQuerySchema } from '@/server/validation/cart';

/**
 * Renders on every request, so `next build` neither reads this route nor needs
 * a database to produce the build output.
 */
export const dynamic = 'force-dynamic';

/**
 * Answers with the cart the request's session token addresses.
 *
 * @param request The incoming request; only its URL is read.
 * @returns `200` with the cart's `CartView` - the session's open cart, or the
 * empty one opened for it - or the mapper's failure envelope: `404` when a
 * checkout is holding this session's cart, and `400` when the query itself was
 * rejected.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const { sessionToken } = cartQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );

    return Response.json(await readActiveCart(sessionToken), {
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
