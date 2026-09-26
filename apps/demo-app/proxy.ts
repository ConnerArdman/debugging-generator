/**
 * Lumen Supply - the request proxy: the product route's 404, decided before anything renders.
 *
 * Next.js runs this file on the server ahead of routing, for the addresses `config.matcher` names
 * and for nothing else. Its one job is to answer "does a product own this slug?" for
 * `/products/[slug]` while the response's status line can still say so, and to hand every other
 * outcome to the route unchanged.
 *
 * WHY THE CHECK LIVES HERE AND NOT IN THE PAGE
 * `app/loading.tsx` is the root segment's loading boundary, so the product route renders inside a
 * Suspense boundary. Next.js starts streaming as soon as that boundary's fallback is ready, and a
 * streamed response has already sent its `200` status line: a `notFound()` the page raises after
 * that point replaces the markup with `app/not-found.tsx` and marks it `robots: noindex`, but it
 * cannot change the status. Next.js's own guidance for exactly this case - the "Status Codes"
 * section of the `loading` file convention, shipped with the framework at
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md` - is to
 * establish that the resource exists before the body is streamed, by running the check in
 * `proxy` and rewriting a missing slug to a not-found route. That is this file.
 *
 * WHAT IT ANSWERS
 *   - A segment holding a dot never reaches the check at all. `/products/` is also where the
 *     storefront's product artwork is served from - `public/products/*.svg`, the addresses the
 *     seeded catalog stores as each product's image - and Next.js runs a proxy before it serves a
 *     `public/` file, so a check that saw those addresses would rewrite every product image to the
 *     not-found route. A slug is lowercase words joined by hyphens and can never hold a dot, so
 *     {@link config} leaves every dotted segment out and Next.js answers it after its own check
 *     for a public file: the artwork that exists is served, and a dotted address that names no
 *     file is rewritten to the same not-found route - and answered with a 404 - by the one
 *     `afterFiles` rewrite in `next.config.ts`, which Next applies after that file check and before
 *     it matches the dynamic product route.
 *   - A segment the product slug schema rejects is rewritten to the not-found route: it can name no
 *     product, and the page would answer it with `notFound()` for the same reason.
 *   - A well-formed slug no product owns is rewritten to the not-found route, which answers with a
 *     404 status and `app/not-found.tsx`'s "Page not found". What "the not-found route" is here -
 *     an address no route owns, rather than Next.js's own `/_not-found` entry - is explained at
 *     {@link TARGET}.
 *   - A slug a product owns passes through untouched, and the page renders it as it always has.
 *   - A segment that is not valid percent-encoding passes through untouched, so Next.js answers it
 *     the way it answers any malformed address.
 *   - A lookup that fails - the database is unreachable, the driver refused the connection - passes
 *     through too. An infrastructure fault is not a statement about the address, so it must never
 *     become a 404: the page reads the product itself and answers the failure with its own "could
 *     not be loaded" notice.
 *
 * The page keeps its own `notFound()` calls. They are the render's guarantee for the two cases this
 * file cannot settle - a lookup that fell through, and a product removed between this read and the
 * page's - and in those cases the not-found page is streamed with a `200` and `robots: noindex`,
 * which is Next.js's documented answer once the body has started.
 *
 * WHAT IT COSTS
 * One indexed read per matched request: `SELECT 1 ... LIMIT 1` against the unique index on
 * `products.slug`, returning no column of the row. The lookup is by exactly the key the page's own
 * read uses - a `findUnique` on `slug` - so the two cannot disagree about whether a slug exists.
 * It runs for client-side navigations and prefetches of a product page as well as for full page
 * loads: Next.js strips its internal Flight headers (`rsc`, `next-router-prefetch`, ...) from the
 * request a proxy sees, precisely so that an RSC request and the HTML request for the same address
 * are answered alike, which leaves nothing here to tell them apart by - and nothing that should.
 *
 * WHAT IT SHARES WITH THE APPLICATION
 * The read goes through the application's single `pg.Pool` from `@/server/db/pool`, not a pool of
 * its own, so this check draws on the same connection limit as every other query and adds no second
 * set of connections to the database. Next.js compiles this file apart from the routes, so that
 * module is evaluated once for each; the pool it parks on `globalThis` is what makes both
 * evaluations answer with the same pool in one server process. `pg` stays an external package that
 * both load from `node_modules`, never a copy bundled into either, so this read runs on the same
 * driver module as every other query the process makes.
 *
 * The slug is parsed with `productSlugParamsSchema`, the schema the page parses its segment with,
 * and the parsed value - trimmed, as the page trims it - is what is looked up.
 *
 * WHAT IT DOES NOT DECLARE
 * No `runtime` export: a proxy runs on Node.js by default in Next.js 16, which is what the pool's
 * driver needs, and the `proxy` file convention rejects a `runtime` option outright.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { pool } from '@/server/db/pool';
import { productSlugParamsSchema } from '@/server/validation/products';

/**
 * The address prefix of a product page, up to and including the separator before its slug. It
 * mirrors the matcher below, which cannot be written in terms of it: Next.js reads `config` from
 * the source at build time, so its values must be literals.
 */
const PREFIX = '/products/';

/**
 * Where an address no product owns is rewritten: an address no route owns. Next.js answers an
 * unmatched address by setting a 404 status and rendering `app/not-found.tsx` inside the root
 * layout, and it does so for the HTML request and the RSC request alike, in `next dev` and in
 * `next start`. The address in the browser is unchanged; only what answers it is.
 *
 * It is deliberately not `/_not-found`, the entry Next.js builds from `app/not-found.tsx`.
 * Rewritten to that entry directly, an HTML request is answered with a 404 but a production RSC
 * request - a client-side navigation or a prefetch - is answered with the not-found payload under
 * a `200`, because the entry is then served as an ordinary page rather than as the answer to an
 * unmatched address.
 *
 * The leading underscore is what keeps this address unowned: the App Router treats a folder named
 * `_something` as private and never routes it, so no file added under `app/` can turn it into a
 * page, and it sits outside `/_next/`, which Next.js reserves for its own assets. Nothing in
 * `public/` carries the name either.
 *
 * `next.config.ts` rewrites a dotted product address that names no file to this same address, as
 * its `MISSING` constant; the two literals must stay equal, and each file names the other.
 */
const TARGET = '/_missing';

/**
 * The existence check, parameterised so the slug is never part of the statement's text. `SELECT 1`
 * and `LIMIT 1` keep the answer to one constant column of at most one row: whether the row exists
 * is the whole question.
 */
const LOOKUP = 'SELECT 1 FROM "products" WHERE "slug" = $1 LIMIT 1';

/**
 * Which requests reach {@link proxy}: a product page, and nothing else - not the catalog, not the
 * product endpoint, not a static asset. `:slug` matches exactly one path segment, so a deeper path
 * never reaches the check and is answered by routing like any address no route owns, and its
 * pattern, `[^/.]+`, admits no dot, so the product artwork served from `public/products/` - every
 * address of the form `/products/<name>.svg` - is never checked and never rewritten.
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

  // The matcher guarantees one non-empty segment; this holds the function to that on its own terms
  // rather than on the matcher's, so a changed matcher can widen what reaches the check but never
  // what it rewrites.
  if (segment.length === 0 || segment.includes('/')) {
    return NextResponse.next();
  }

  // The path arrives percent-encoded, and the page receives its segment decoded, so the value is
  // decoded here before it is parsed. A sequence that does not decode is not a slug this file can
  // speak for: it passes through for Next.js to answer.
  let decoded: string;

  try {
    decoded = decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) {
      return NextResponse.next();
    }

    throw error;
  }

  // A dot - literal, which the matcher already keeps out, or percent-encoded as `%2E`, which it
  // cannot see - marks a file address rather than a slug, and a file under `public/products/` is
  // Next.js's to serve. It passes through, so no product image is ever rewritten from here.
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
    // One line for whoever is watching the server, carrying a fixed label and the failure's kind
    // only: a message or a stack may hold a host, a statement or a connection string. The request
    // continues to the page, whose own read reports the same fault to the reader.
    console.error(
      'Lumen Supply: a product address could not be checked:',
      error instanceof Error ? error.name : typeof error,
    );
  }

  return NextResponse.next();
}
