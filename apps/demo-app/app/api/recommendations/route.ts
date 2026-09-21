/**
 * `GET /api/recommendations` - the suggestions shown alongside a product.
 *
 * The handler does what a route handler in this workspace does and nothing
 * else: it parses the query string with the schema that declares it, hands the
 * parsed values to the service that answers it, and serializes that answer as
 * it stands - the items are already stated in `RecommendationItem` from
 * `@/lib/types`, so nothing is renamed, rounded or re-shaped on the way out.
 *
 * Failures are not shaped here either. Whatever is thrown - a query this
 * endpoint does not accept, a product that is not in the catalog, a database
 * error - is handed to the single mapper in `@/server/errors`, so this endpoint
 * reports a failure in the same envelope as every other one.
 */

import { storefrontErrorResponse } from '@/server/errors';
import { listRelatedProducts } from '@/server/services/recommendation.service';
import { recommendationsQuerySchema } from '@/server/validation/recommendations';

export const dynamic = 'force-dynamic';

/**
 * Answers the suggestions for the product a request names.
 *
 * The query arrives as a record of strings, which is what the schema is written
 * to read: a parameter nobody stated is an absent key rather than a `null`, so
 * `limit` resolves to its default instead of being rejected. The parsed values
 * are passed on unchanged - a bound belongs in the schema, not here.
 *
 * @param request The incoming request; its URL carries `productId` and `limit`.
 * @returns `200` with the suggestions as a JSON array, or the shared failure
 *   envelope with the status the mapper chose.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const query = recommendationsQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );

    const items = await listRelatedProducts(query);

    return Response.json(items, {
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
