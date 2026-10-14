/**
 * `GET /api/orders`: one page of a customer's order history.
 *
 * `ordersQuerySchema` in `@/server/validation/orders` declares and bounds every
 * parameter and defaults the page window. `customerId` alone is required,
 * because it has no sensible default: a request naming no customer is a 400
 * rather than an empty page. The `PagedList<OrderSummary>` from
 * `@/server/services/order.service` is returned as it stands. An order's status
 * moves while the customer is watching, so the segment is dynamic, every
 * response is `no-store` and nothing is memoized at module scope.
 */

import type { OrderSummary, PagedList } from '@/lib/types';
import { storefrontErrorResponse } from '@/server/errors';
import { listCustomerOrders, type CustomerOrdersInput } from '@/server/services/order.service';
import { ordersQuerySchema } from '@/server/validation/orders';

/**
 * Answer every request from the database rather than from a build-time render
 * or a cached entry. It also keeps `next build` from reaching for a database it
 * has no reason to need: there is nothing here to prerender.
 */
export const dynamic = 'force-dynamic';

/**
 * Reads one page of a customer's orders, most recently placed first.
 *
 * @param request The incoming request. Its query string carries the customer
 * whose orders these are, the page window, and an optional status to narrow to.
 * @returns 200 with a `PagedList<OrderSummary>` - the page's orders, the number
 * of orders the filter matched, and the page number and size the answer was
 * built with. Any failure is answered by `storefrontErrorResponse` in the one
 * envelope every endpoint of this application uses: 400 for a query the schema
 * rejected, and a message that names no value the caller supplied for anything
 * else.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    // A query string carries scalars only, and `Object.fromEntries` collapses a
    // repeated key to its last value, which is the right reading for every
    // parameter this endpoint accepts. Unknown parameters are stripped by the
    // schema, so a link that arrived carrying a tracking parameter still
    // resolves to a page of orders.
    const query: CustomerOrdersInput = ordersQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );

    const orders: PagedList<OrderSummary> = await listCustomerOrders(query);

    return Response.json(orders, {
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
