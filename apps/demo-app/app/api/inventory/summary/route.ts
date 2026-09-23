/**
 * `GET /api/inventory/summary` - the inventory dashboard's feed.
 *
 * One request answers the dashboard's whole surface: the figures on its cards,
 * the stocking locations its filter row lists, one page of the stock lines its
 * table renders and the lines that have fallen to their reorder point. The
 * handler does what a route handler in this workspace does and nothing else -
 * it parses the query string with the schema that declares it, hands the parsed
 * values to the service that answers it, and serializes that answer as it
 * stands.
 *
 * Four decisions are worth stating, because a reader would otherwise reasonably
 * expect the opposite:
 *
 * 1. **No parameter is defaulted here.** Every figure and filter this endpoint
 *    accepts is declared, bounded and defaulted once, in
 *    `@/server/validation/inventory`, so a request carrying nothing parses to
 *    the figures the dashboard opens on. A second copy of a default in this
 *    module could only drift from the first, and would answer a slightly
 *    different question than the page rendering the same data.
 * 2. **A rejected query is not answered here either.** The throwing `parse` is
 *    used deliberately: the `ZodError` it raises is left to propagate to the
 *    single mapper in `@/server/errors`, which answers 400 in the one envelope
 *    every endpoint of this application uses and names the parameters it
 *    rejected without echoing what was received. Quietly substituting a default
 *    for a malformed figure would report numbers nobody asked for.
 * 3. **Nothing is cached and nothing is re-shaped.** Stock moves while a
 *    dashboard is open, so the segment is dynamic, the response says
 *    `no-store`, and nothing is memoized at module scope. The payload is
 *    already stated in `InventorySummary` from `@/lib/types` - plain integer
 *    quantities and an ISO-8601 UTC instant - so re-labelling or re-rounding
 *    anything on the way out could only put this endpoint at odds with itself
 *    on the next request.
 * 4. **CONSUMER CLASSIFICATION: this endpoint answers the inventory dashboard
 *    itself.** `app/dashboard/page.tsx` parses its own address and then reads
 *    this endpoint through `loadInventorySummary` in `@/lib/api-client`, so the
 *    figures a reader sees and the figures an outside caller receives are the
 *    same answer to the same request, produced by this code path. The one
 *    client component on that surface - the filter row - changes the page's own
 *    query string rather than fetching anything, and the page's next render
 *    asks here again. The query is parsed and bounded by
 *    `inventorySummaryQuerySchema` whoever sent it, because an endpoint
 *    reachable over HTTP is reachable by anyone: a caller inside this
 *    application relaxes nothing about how a request is parsed.
 *
 * There is no SQL here, no paging arithmetic and no business rule: the work
 * lives in `@/server/services/inventory.service`, and this module is where the
 * request and that work meet.
 */

import type { InventorySummary } from '@/lib/types';
import { storefrontErrorResponse } from '@/server/errors';
import {
  readInventorySummary,
  type InventorySummaryInput,
} from '@/server/services/inventory.service';
import { inventorySummaryQuerySchema } from '@/server/validation/inventory';

/**
 * Answer every request from the database rather than from a build-time render
 * or a cached entry. It also keeps `next build` from reaching for a database it
 * has no reason to need: there is nothing here to prerender.
 */
export const dynamic = 'force-dynamic';

/**
 * Reads the inventory dashboard's figures for the locations, states and lines a
 * request names.
 *
 * @param request The incoming request. Its query string carries an optional
 * `warehouseId`, the headroom above a reorder point that still counts as low,
 * the page window of the stock lines and the optional stock-state and movement
 * filters; `inventorySummaryQuerySchema` owns which of those are accepted, what
 * they are bounded to and what they default to, so a request carrying no query
 * string at all is a perfectly good one. `warehouseId` names one stocking
 * location by its identifier - `WarehouseSummary.id` as `@/lib/types` declares
 * it - while the short code a location is listed under is display wording only;
 * a request that carries no `warehouseId` reports on every location. The two
 * filters do not reach the same figures: the stock-state filter selects the
 * stock lines every figure is computed over, while the movement filter is a
 * question about the ledger and bounds the units-moved figure alone, so adding
 * it to a request leaves the physical-stock totals, the page of lines and the
 * low-stock list exactly as they were.
 * @returns 200 with an `InventorySummary` - the totals across the locations the
 * filters matched, those locations, the page of stock lines with the products
 * naming them, and the most urgent lines at or below their reorder point - and
 * `no-store`, so neither the dev server nor the browser serves the figures
 * again. Any failure is answered by `storefrontErrorResponse` in the one
 * envelope every endpoint of this application uses: 400 for a query the schema
 * rejected, 404 for a stocking location that does not exist, and a message that
 * names no value the caller supplied for anything else.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    // A query string carries scalars only, and `Object.fromEntries` collapses a
    // repeated key to its last value, which is the right reading for every
    // parameter this endpoint accepts. Unknown parameters are stripped by the
    // schema, so a dashboard URL that also carries a campaign parameter still
    // resolves to a set of figures.
    const query: InventorySummaryInput = inventorySummaryQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );

    const summary: InventorySummary = await readInventorySummary(query);

    return Response.json(summary, {
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
