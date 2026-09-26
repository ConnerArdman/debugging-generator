/**
 * `GET /api/inventory/summary` - the inventory dashboard's feed: its figures,
 * its stocking locations, one page of stock lines and the lines at or below
 * their reorder point, in one response.
 *
 * `inventorySummaryQuerySchema` in `@/server/validation/inventory` declares,
 * bounds and defaults every parameter, so nothing is defaulted here and a
 * request with no query string parses to the dashboard's opening view. The
 * `InventorySummary` from `@/server/services/inventory.service` is returned as
 * it stands. Stock moves while the dashboard is open, so the segment is
 * dynamic, every response is `no-store` and nothing is memoized at module
 * scope.
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
 * filters. `warehouseId` names one stocking location by its identifier -
 * `WarehouseSummary.id` as `@/lib/types` declares it - while the short code a
 * location is listed under is display wording only; a request that carries no
 * `warehouseId` reports on every location. The two filters do not reach the
 * same figures: the stock-state filter selects the stock lines every figure is
 * computed over, while the movement filter is a question about the ledger and
 * bounds the units-moved figure alone, so adding it to a request leaves the
 * physical-stock totals, the page of lines and the low-stock list exactly as
 * they were.
 * @returns 200 with an `InventorySummary` - the totals across the locations the
 * filters matched, those locations, the page of stock lines with the products
 * naming them, and the most urgent lines at or below their reorder point. Any
 * failure is answered by `storefrontErrorResponse` in the one envelope every
 * endpoint of this application uses: 400 for a query the schema rejected, 404
 * for a stocking location that does not exist, and a message that names no
 * value the caller supplied for anything else.
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
