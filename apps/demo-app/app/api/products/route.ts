/**
 * `GET /api/products` - one page of the Lumen Supply catalog.
 *
 * The handler does what a route handler in this workspace does and nothing else: it parses the
 * query string with the schema that declares it, hands the parsed values to the service that
 * answers it, and serializes that answer as it stands. The page is already stated in
 * `PagedList<ProductSummary>` from `@/lib/types` - prices are integer cents, stock is a state and a
 * count - so nothing is renamed, rounded, re-sorted or re-paged on the way out, and a caller reads
 * the same fields the catalog's own pages render.
 *
 * Three boundaries meet here, and each belongs to exactly one module:
 *
 * 1. **What a request may say** is `catalogQuerySchema`'s. Every bound - the page ceiling, the page
 *    size cap, the length of a filter - is declared there, so this file restates none of them and
 *    cannot drift from the schema the catalog's own page parses with. The parse is the throwing
 *    `parse` rather than `safeParse`: a query this endpoint does not accept is a failure to report,
 *    not a page to invent, and the resulting `ZodError` is worth more to the caller than a silent
 *    fallback would be.
 * 2. **What the answer is** is `browseCatalog`'s. It owns the statements, the ordering and the
 *    count, and it resolves the page number and page size it actually answered with, which is why
 *    neither is recomputed here.
 * 3. **How a failure reads** is `@/server/errors`'s. Whatever is thrown - a rejected query, a
 *    database that could not be reached - is handed to `storefrontErrorResponse`, the one mapper
 *    every endpoint in this application answers through, so the status and the envelope are chosen
 *    in one place and no field path, statement or connection string can leak from this one.
 *
 * The answer is never stored. A listing states a price and a stock level as they are at the moment
 * it is read, and both change while the application runs, so the response asks every layer between
 * here and the reader to come back for the next one.
 */

import type { PagedList, ProductSummary } from '@/lib/types';
import { catalogQuerySchema, type CatalogQueryInput } from '@/server/validation/products';
import { browseCatalog } from '@/server/services/catalog.service';
import { storefrontErrorResponse } from '@/server/errors';

export const dynamic = 'force-dynamic';

/**
 * Answers one page of the catalog for the filters, ordering and page a request names.
 *
 * The query arrives as a record of single strings, which is the shape `catalogQuerySchema` is
 * written to read: a parameter nobody stated is an absent key rather than a `null`, so a bare
 * `GET /api/products` is a complete request and is answered with the first page in the catalog's own
 * order. Both numbers arrive as text and the schema coerces them.
 *
 * The parsed values are forwarded by name and each of the two filters is spread in only when it
 * holds one: this workspace compiles with `exactOptionalPropertyTypes`, under which `CatalogQuery`'s
 * optional members mean "absent or a value" rather than "possibly present and `undefined`", while a
 * parsed filter nobody stated is typed `string | undefined`. Naming the fields is what carries the
 * distinction across - and it is the same distinction the schema draws, so no value is renamed,
 * defaulted or reinterpreted on the way.
 *
 * @param request The incoming request; its URL carries the catalog's query parameters.
 * @returns `200` with the page as JSON, or the shared failure envelope with the status the mapper
 *   chose - `400` for a query the schema rejected.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const query: CatalogQueryInput = catalogQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );

    const page: PagedList<ProductSummary> = await browseCatalog({
      sort: query.sort,
      page: query.page,
      pageSize: query.pageSize,
      ...(query.categorySlug === undefined ? {} : { categorySlug: query.categorySlug }),
      ...(query.search === undefined ? {} : { search: query.search }),
    });

    return Response.json(page, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (error: unknown) {
    return storefrontErrorResponse(error);
  }
}
