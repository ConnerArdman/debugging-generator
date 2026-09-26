/**
 * `GET /api/cart` - the cart this browser is shopping with.
 *
 * Every parameter is optional: `cartQuerySchema` in `@/server/validation/cart`
 * defaults the session token when none is sent and strips unknown parameters,
 * so an empty query is a complete request. The `CartView` is returned exactly
 * as `@/server/services/cart.service` built it, and every response is
 * `no-store` because a cart is read again straight after each change to it.
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
 * empty one opened for it - or the failure envelope `storefrontErrorResponse`
 * builds: `404` when a checkout is holding this session's cart, and `400` when
 * the query itself was rejected.
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
