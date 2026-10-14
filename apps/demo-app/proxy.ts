/**
 * Lumen Supply - the request proxy: the product route's 404, decided before anything renders.
 *
 * The root `app/loading.tsx` wraps `/products/[slug]` in a Suspense boundary, so the page streams
 * after its `200` status line is sent and a `notFound()` raised there cannot change the status.
 * Whether a product owns the slug is therefore settled here, before the body starts:
 *   - A segment holding a dot is never looked up. Product artwork is served from
 *     `public/products/*.svg` under the same prefix, and a slug never holds a dot, so
 *     {@link config} leaves dotted segments out; a dotted address that names no file is answered
 *     with a 404 by the `afterFiles` rewrite in `next.config.ts`.
 *   - A segment the slug schema rejects, and a well-formed slug no product owns, are rewritten to
 *     {@link TARGET}.
 *   - An owned slug, a segment that is not valid percent-encoding and a lookup that fails pass
 *     through untouched: an infrastructure fault is not a statement about the address, so the page
 *     answers it with its own "could not be loaded" notice.
 * The page keeps its own `notFound()` for what this file cannot settle: a lookup that fell through,
 * or a product removed between this read and the page's.
 *
 * The read goes through the application's shared pool from `@/server/db/pool`, adding no
 * connections of its own, and parses the segment with the page's `productSlugParamsSchema` and
 * looks it up by the same `slug` key, so the two cannot disagree about whether a product exists.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { pool } from '@/server/db/pool';
import { productSlugParamsSchema } from '@/server/validation/products';

/**
 * The address prefix of a product page. The matcher below repeats it as a literal because Next.js
 * reads `config` from the source at build time.
 */
const PREFIX = '/products/';

/**
 * Where a slug no product owns is rewritten: an address no route owns, which Next.js answers with
 * a 404 and `app/not-found.tsx` for the HTML and the RSC request alike, leaving the browser's
 * address unchanged.
 *
 * It is not `/_not-found`, the entry Next.js builds from `app/not-found.tsx`: rewritten there, a
 * production RSC request - a client-side navigation or a prefetch - receives the not-found payload
 * under a `200`, because the entry is served as an ordinary page. The leading underscore keeps the
 * address unowned, since the App Router never routes a `_`-prefixed folder, and no file in
 * `public/` carries the name.
 *
 * Must equal `MISSING` in `next.config.ts`, which rewrites a dotted product address that names no
 * file to the same address.
 */
const TARGET = '/_missing';

/**
 * The existence check: a read of the unique index on `products.slug` that returns no column of
 * the row.
 */
const LOOKUP = 'SELECT 1 FROM "products" WHERE "slug" = $1 LIMIT 1';

/**
 * Only a single-segment product page without a dot reaches {@link proxy}: deeper paths are left to
 * routing, and dotted segments to the `public/products/` artwork.
 */
export const config = { matcher: '/products/:slug([^/.]+)' };

/**
 * Answer one product-page request: rewrite it to the not-found route when no product can own its
 * slug, and let it through otherwise.
 *
 * @param request The incoming request, as Next.js hands it to a proxy.
 * @returns A rewrite to {@link TARGET} for a slug no product owns or can own, and a pass-through
 * for every other outcome, including every failure to find out.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const address = request.nextUrl.pathname;
  const segment = address.startsWith(PREFIX) ? address.slice(PREFIX.length) : '';

  // Repeats the matcher's one-segment guarantee, so a widened matcher never widens the rewrites.
  if (segment.length === 0 || segment.includes('/')) {
    return NextResponse.next();
  }

  // The page receives its segment decoded; one that does not decode is left to Next.js.
  let decoded: string;

  try {
    decoded = decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) {
      return NextResponse.next();
    }

    throw error;
  }

  // A percent-encoded dot (`%2E`) gets past the matcher but still marks a file address, not a slug.
  if (decoded.includes('.')) {
    return NextResponse.next();
  }

  const requested = productSlugParamsSchema.safeParse({ slug: decoded });

  if (!requested.success) {
    return NextResponse.rewrite(new URL(TARGET, request.url));
  }

  try {
    const found = await pool.query(LOOKUP, [requested.data.slug]);

    if (found.rows.length === 0) {
      return NextResponse.rewrite(new URL(TARGET, request.url));
    }
  } catch (error) {
    // A fixed label and the failure's kind only: a message or a stack may hold a host, a statement
    // or a connection string. The page's own read reports the fault to the reader.
    console.error(
      'Lumen Supply: a product address could not be checked:',
      error instanceof Error ? error.name : typeof error,
    );
  }

  return NextResponse.next();
}
