/**
 * Next.js configuration for "Lumen Supply" (AAP 0.7.1 Group 5), the application this
 * repository's debugging tool is pointed at.
 *
 * The configuration is one rewrite and nothing else, and that near-emptiness is the point. This
 * workspace is an ordinary Next.js 16 App Router project, started with plain `next dev`,
 * `next build` and `next start`, so a debugging session against it exercises exactly the code
 * paths a session against any other project would. Every option added here would become a
 * property of the target that the tool had been demonstrated against - and, sooner or later, one
 * it quietly relied on. Four concrete guarantees depend on this file holding no more than it
 * does, and the one entry it holds is explained after them.
 *
 * 1. THE DATABASE TIER STAYS OBSERVABLE - `serverExternalPackages` is left at its default.
 *    Next.js ships a built-in opt-out-of-bundling list (`dist/lib/server-external-packages.jsonc`
 *    in next@16.3.5) that already contains this workspace's only data-access dependencies -
 *    `@prisma/client`, `prisma` and `pg` - and both bundlers read that same list: the webpack
 *    path concatenates any user-supplied array onto it rather than replacing it
 *    (`EXTERNAL_PACKAGES.concat(...config.serverExternalPackages || [])`,
 *    `dist/build/webpack-config.js`), and the Turbopack binary loads the file directly. Those
 *    packages therefore remain real module requests resolved from `node_modules` at runtime,
 *    which is the precondition for a tracer registered *before* the server starts to wrap them
 *    and emit query spans. The tool registers that tracer by launching the dev server with a
 *    `NODE_OPTIONS=--import` preload and never by editing this project (AAP 0.5.1); if these
 *    packages were bundled instead, the wrapping would still be installed but would apply to a
 *    module nobody loads, and the database half of every captured trace would silently vanish.
 *    Restating the default here would add nothing and would drift from Next's list on upgrade.
 *
 * 2. A BUILD NEEDS NO DATABASE - every route segment opts out of static generation itself and
 *    the database client connects on its first query, so `next build` fetches no data and
 *    succeeds with a placeholder connection string and nothing listening (AAP 0.8.5, and the
 *    clean-clone end-to-end spec). Nothing may be added here that reintroduces build-time data
 *    access: no `output: 'export'`, no partial prerendering or component-caching experiment, no
 *    option that turns a dynamic segment back into a statically generated one.
 *
 * 3. THE WORKING TREE STAYS CLEAN - build output must stay inside `.next/`, the only build
 *    directory this workspace's ignore rules cover, because the end-of-session guarantee is
 *    asserted as an empty `git status --porcelain -- apps/demo-app`. Hence no `distDir`, no
 *    `output: 'standalone'` and no output-file-tracing-root adjustment.
 *
 * 4. THE APP ANSWERS WHERE EVERYTHING EXPECTS IT - at `/` on `http://localhost:3000`: the
 *    origin the browser extension's host permissions cover, the tool's dev-server probe
 *    assumes and the test harness defaults to. So no `basePath` and no `assetPrefix`, and the
 *    port stays a command-line concern (`next dev -p <port>`) rather than a baked-in value.
 *
 * Also deliberately absent, so that nothing here has to be undone before this project can
 * stand in for a developer's own:
 *
 *   - no tracing or instrumentation wiring of any kind, for the reason given in (1);
 *   - no `transpilePackages`, and no import of a workspace package in any file of this
 *     workspace: the application depends on none of them (AAP 0.4.2);
 *   - no `typescript.ignoreBuildErrors` - type errors are a blocking gate, not a warning - and
 *     no `eslint` block, which next@16 no longer has: linting is the repository-wide
 *     `eslint . --max-warnings 0` run;
 *   - no `env` block: the connection string is read from the process environment at runtime and
 *     must never be inlined into build output;
 *   - no `images` configuration: artwork is served from this workspace's own `public/` directory
 *     through string `src` paths, so no remote loader or host allowlist is needed;
 *   - no `webpack` or `turbopack` hook, and no `reactStrictMode` override, so the application
 *     compiles and behaves like the stock App Router project it is meant to represent.
 *
 * THE ONE ENTRY: A PRODUCT ADDRESS THAT NAMES A FILE NOBODY SERVES
 * `app/loading.tsx` is the root loading boundary, so `/products/[slug]` renders inside a
 * Suspense boundary and a `notFound()` it raises is streamed under a `200` that has already been
 * sent (the "Status Codes" section of Next's bundled `loading` file-convention docs). `proxy.ts`
 * therefore settles "is there a product here?" before rendering and rewrites an address no
 * product owns to {@link MISSING}, an address no route owns, which Next answers with a 404 and
 * `app/not-found.tsx`. One kind of address cannot be settled there: a segment holding a dot. The
 * product artwork is served from `public/products/<name>.svg`, a proxy runs before Next looks for
 * a public file, and a slug never holds a dot, so the proxy leaves every dotted segment alone and
 * the artwork is served untouched. A dotted segment that names no file would then fall through to
 * the dynamic product route and be answered with a streamed not-found page under a `200`.
 *
 * An `afterFiles` rewrite is the framework's own answer to exactly that ordering: Next applies it
 * after it has checked `public/` and the other files for an exact match and before it matches
 * dynamic routes (`dist/server/lib/router-utils/resolve-routes.js` in next@16.3.5: the proxy,
 * then `beforeFiles`, then `check_fs`, then `afterFiles`). So an artwork address that exists is
 * served by the file check and never reaches the rewrite, and a dotted address under `/products/`
 * that names no file is rewritten to the same unowned address the proxy uses and answered with a
 * 404, for the HTML request and the RSC request alike. The source pattern admits one segment that
 * holds a dot, written literally or percent-encoded as `%2E`, because the file check decodes the
 * path and this pattern is matched against it as sent. It reads no data, changes no build output
 * and touches no guarantee listed above.
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
 * Every option but `rewrites` resolves to the framework default that `next dev`, `next build`
 * and `next start` would use in a project with no configuration file at all. `rewrites` returns
 * only `afterFiles`, for the reason given above; `beforeFiles` and `fallback` stay empty. It is
 * written out as a typed constant rather than exported inline so the annotation is checked once,
 * here, and any future addition is checked against the framework's own types by `tsc -b`.
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
