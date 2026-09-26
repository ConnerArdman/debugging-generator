/**
 * `GET /api/products/[slug]` - one product of the Lumen Supply catalog, addressed by its slug.
 *
 * `productSlugParamsSchema` in `@/server/validation/products` owns the slug's shape and length
 * ceiling, shared with the product's own page. `readProductBySlug` raises the not-found failure
 * itself, so nothing here checks existence. Every failure - a rejected segment, an unknown product,
 * an unreachable database - is answered by `storefrontErrorResponse`, so no input value, SQL
 * statement or connection string reaches the caller. Price and stock change while the application
 * runs, so the segment is dynamic and the `ProductDetail` is returned as it stands with `no-store`.
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
 * @returns `200` with the product as JSON, or the shared failure envelope with the status
 *   `storefrontErrorResponse` chose - `400` for a segment the schema rejected, `404` for a slug no
 *   product owns.
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
