/**
 * Next.js configuration for "Lumen Supply" (AAP 0.7.1 Group 5), the application this
 * repository's debugging tool is pointed at.
 *
 * The configuration is empty, and the emptiness is the point. This workspace is an ordinary
 * Next.js 16 App Router project, started with plain `next dev`, `next build` and `next start`,
 * so a debugging session against it exercises exactly the code paths a session against any
 * other project would. Every option added here would become a property of the target that the
 * tool had been demonstrated against - and, sooner or later, one it quietly relied on. Four
 * concrete guarantees depend on this file staying as it is.
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
 * @see https://nextjs.org/docs/app/api-reference/config/next-config-js
 */
import type { NextConfig } from 'next';

/**
 * The configuration Next.js loads for this workspace.
 *
 * `NextConfig` declares no required members, so this empty object is a complete and valid
 * configuration: every option resolves to the framework default that `next dev`, `next build`
 * and `next start` would use in a project with no configuration file at all. It is written out
 * as a typed constant rather than exported inline so the annotation is checked once, here, and
 * any future addition is checked against the framework's own types by `tsc -b`.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
