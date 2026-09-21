/**
 * `GET /api/orders`: one page of a customer's order history.
 *
 * The handler does three things in a fixed order - parse the query, hand it to
 * the order service, answer with what came back - and deliberately nothing
 * else. There is no SQL here, no paging arithmetic, no money arithmetic and no
 * second copy of the query rules: the schema lives in
 * `@/server/validation/orders`, the work lives in
 * `@/server/services/order.service`, and this module is where the two meet.
 * That is what keeps the same listing available to a server component, which
 * calls the service directly, and to anything speaking HTTP.
 *
 * Four decisions are worth stating because a reader would otherwise reasonably
 * expect the opposite:
 *
 * 1. **The query is parsed with the throwing `parse`, never with its
 *    non-throwing counterpart.** A rejection is left to propagate as the
 *    `ZodError` it is, so the single mapper in `@/server/errors` answers 400
 *    with the field paths it rejected. An endpoint that quietly substituted
 *    defaults for a malformed value would answer somebody else's question,
 *    whereas a page rendering a listing is better off degrading to its first
 *    page than failing - which is why the two read a query differently. A
 *    request naming no customer is therefore a 400 rather than an empty page,
 *    because `customerId` is the one parameter with no sensible default.
 * 2. **Nothing is cached.** An order's status moves while the customer is
 *    watching - paid, then fulfilled - and a history served from a cache would
 *    be quietly out of date. The segment is dynamic, the response says
 *    `no-store`, and nothing is memoized at module scope, so every request is
 *    answered from the database as it stands.
 * 3. **The payload is passed through untouched.** The service already stated
 *    the page in the shapes of `@/lib/types` - integer cents in `*Cents`
 *    fields, an ISO-8601 UTC string for the instant an order was placed - so
 *    re-labelling or re-rounding anything here could only introduce a
 *    disagreement between this endpoint and the components that read it.
 * 4. **CONSUMER CLASSIFICATION: this endpoint is reached over HTTP and has no
 *    browser caller, by design.** `@/lib/api-client` exposes no wrapper for
 *    `GET /api/orders`, and that absence is a designation rather than an
 *    omission: the order-history surface is server-rendered, so
 *    `app/orders/page.tsx` resolves its page of orders by calling the order
 *    service directly instead of issuing an HTTP request back into its own
 *    application, and nothing in the browser issues `GET /api/orders`. The
 *    handler is nevertheless fully validated and bounded by `ordersQuerySchema`
 *    exactly as one with a browser caller would be, because an endpoint
 *    reachable over HTTP is reachable by anyone: having no caller in this
 *    application relaxes nothing about how a request is parsed.
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
 * whose orders these are, the page window, and an optional status to narrow to;
 * `ordersQuerySchema` owns which of those are required and what they default
 * to.
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
