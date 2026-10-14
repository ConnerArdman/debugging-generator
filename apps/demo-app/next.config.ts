/**
 * Next.js configuration for Lumen Supply.
 *
 * Every option except `rewrites` is left at its framework default. The one rewrite covers dotted
 * product addresses: `proxy.ts` leaves every dotted `/products/` segment alone so the artwork in
 * `public/products/` is served, which would let a dotted address naming no file reach the dynamic
 * product route and get a not-found page streamed under a `200`. An `afterFiles` rewrite runs
 * after Next's public-file check and before dynamic routes, so existing artwork is served first
 * and any other dotted address is rewritten to {@link MISSING} and answered with a 404. The
 * pattern accepts the dot written literally or as `%2E`, because the file check decodes the path
 * while the rewrite source is matched against it as sent.
 *
 * @see https://nextjs.org/docs/app/api-reference/config/next-config-js
 */
import type { NextConfig } from 'next';

/**
 * The address a missing product is answered from: one no route owns, so Next sets a 404 and
 * renders `app/not-found.tsx`. It is the same literal as `TARGET` in `proxy.ts`, which explains
 * why it is not Next's own `/_not-found` entry and why no file can come to own it; the two must
 * stay equal, and each file names the other.
 */
const MISSING = '/_missing';

/**
 * A single segment under `/products/` that holds a dot, literal or percent-encoded - an address
 * shaped like a file rather than like a slug.
 */
const DOTTED_PRODUCT_ADDRESS = '/products/:file([^/]*(?:\\.|%2[Ee])[^/]*)';

/**
 * The configuration Next.js loads for this workspace.
 *
 * `rewrites` returns only `afterFiles`, for the reason given above; `beforeFiles` and `fallback`
 * stay empty. The object is a typed constant so `tsc -b` checks it against Next's `NextConfig`.
 */
const nextConfig: NextConfig = {
  rewrites: () =>
    Promise.resolve({
      beforeFiles: [],
      afterFiles: [{ source: DOTTED_PRODUCT_ADDRESS, destination: MISSING }],
      fallback: [],
    }),
};

export default nextConfig;
