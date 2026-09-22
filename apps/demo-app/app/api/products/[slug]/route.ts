/**
 * `GET /api/products/[slug]` - one product of the Lumen Supply catalog, addressed by its slug.
 *
 * The handler does what a route handler in this workspace does and nothing else: it parses the
 * matched route segment with the schema that declares it, hands the segment to the service that
 * answers it, and serializes that answer as it stands. The product is already stated in
 * `ProductDetail` from `@/lib/types` - prices are integer cents, `updatedAt` is an ISO-8601 UTC
 * string, stock is a state and a count per location - so nothing is renamed, rounded, re-ordered
 * or re-labelled on the way out, and a caller reads the same fields the product's own page renders.
 *
 * Three boundaries meet here, and each belongs to exactly one module:
 *
 * 1. **What a request may say** is `productSlugParamsSchema`'s. The slug's shape and its length
 *    ceiling are declared there, so this file restates neither and cannot drift from the schema
 *    the product's own page parses with. The parse is the throwing `parse`: a segment this
 *    endpoint does not accept is a failure to report rather than a lookup to attempt, and the
 *    resulting `ZodError` carries the field path a caller needs.
 * 2. **What the answer is** is `readProductBySlug`'s. It owns the lookup, the per-location stock
 *    ordering and the specification rows, and it raises the not-found failure itself when no
 *    product owns the slug - which is why nothing here pre-checks existence, branches on an absent
 *    value or assembles a 404 of its own.
 * 3. **How a failure reads** is `@/server/errors`'s. Whatever is thrown - a rejected segment, an
 *    unknown product, a database that could not be reached - is handed to
 *    `storefrontErrorResponse`, the one mapper every endpoint in this application answers through,
 *    so the status and the envelope are chosen in one place and no field path, statement or
 *    connection string can leak from this one.
 *
 * The answer is never stored. A product states a price and a stock level as they are at the moment
 * it is read, and both change while the application runs, so the response asks every layer between
 * here and the reader to come back for the next one, and two identical requests each reach the
 * database.
 */

import type { ProductDetail } from '@/lib/types';
import { productSlugParamsSchema, type ProductSlugParamsInput } from '@/server/validation/products';
import { readProductBySlug } from '@/server/services/catalog.service';
import { storefrontErrorResponse } from '@/server/errors';

export const dynamic = 'force-dynamic';

/**
 * Answers the product the address names.
 *
 * The matched segment arrives as a promise in Next.js 16, so it is awaited before it is read - and
 * awaited inside the `try`, which is what puts a segment that never resolves on the same failure
 * path as every other fault instead of leaving it unanswered. The awaited object is handed to the
 * schema whole rather than field by field, so a malformed slug is reported with its field path.
 *
 * The request itself carries nothing this endpoint reads: the address is the entire query. The
 * parameter is still declared, because the segment is the second argument.
 *
 * @param _request The incoming request. Unread: this endpoint takes no query, header or body.
 * @param context The matched route segment, as Next.js hands it over.
 * @returns `200` with the product as JSON, or the shared failure envelope with the status the
 *   mapper chose - `400` for a segment the schema rejected, `404` for a slug no product owns.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const params: ProductSlugParamsInput = productSlugParamsSchema.parse(await context.params);

    const product: ProductDetail = await readProductBySlug(params.slug);

    return Response.json(product, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (error: unknown) {
    return storefrontErrorResponse(error);
  }
}
