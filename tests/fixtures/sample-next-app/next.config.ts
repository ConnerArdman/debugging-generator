/**
 * Next.js configuration for this App Router application.
 *
 * The application is a small, ordinary Next.js 16 project with one page, one client component and
 * one route handler. This file sets only the two options that pin the project root.
 *
 * THE ROOT PIN
 *
 * Both options below name the same directory as the top of this project. Left unset, Next.js
 * infers the root by walking up from the project directory until it finds a lockfile. This
 * directory has no lockfile of its own, so the walk can end far above the application, with two
 * consequences:
 *
 *   - module resolution and output file tracing take in a directory tree unrelated to the
 *     application; and
 *   - the dev server prints a warning that it inferred the workspace root.
 *
 * `import.meta.dirname` keeps the pin correct wherever this directory is copied or moved: it is the
 * directory of whichever copy of this file Next.js loaded, resolved at load time, so the pin is
 * never a constant, never points outside this directory and assumes nothing about where the
 * directory sits.
 *
 * The root is also the boundary of what the bundler compiles ("files outside of the workspace root
 * are not compiled"), so the application's dependencies must resolve from inside this directory. A
 * `node_modules` directory here resolves; one above this directory does not, and a `node_modules`
 * symlink whose target lies outside this directory is rejected. The rule is the same wherever the
 * directory sits, which is the point of pinning rather than inferring.
 *
 * Every other option keeps its Next.js default:
 *
 *   - no `basePath` and no `assetPrefix`: the application is served at `/`;
 *   - no `distDir` and no `output`: build and dev output stays in `.next/`, which this directory's
 *     `.gitignore` covers;
 *   - no `serverExternalPackages` override: Next.js's built-in list of packages it leaves unbundled
 *     on the server applies unchanged;
 *   - no `env`, `images`, `redirects`, `rewrites`, `headers`, `webpack` or `compiler` block, and
 *     no `typescript` or `reactStrictMode` override, so the application compiles and behaves like a
 *     stock App Router project;
 *   - no port: the `package.json` scripts pass it on the command line.
 *
 * @see https://nextjs.org/docs/app/api-reference/config/next-config-js
 */
import type { NextConfig } from 'next';

/**
 * The directory holding this file, and the top of this project.
 *
 * `import.meta.dirname` is available because this folder's `package.json` declares
 * `"type": "module"`, so Next.js loads this configuration as an ES module. It is an absolute
 * path - which is what both options below require - and it is computed rather than written down,
 * so a copy of this directory placed anywhere pins itself rather than the original location.
 */
const projectRoot = import.meta.dirname;

/**
 * The configuration Next.js loads for this application.
 *
 * Both members are top-level options of `NextConfig` in the pinned Next.js version; neither is an
 * `experimental` entry, and neither needs a cast. `turbopack.root` bounds the bundler that serves
 * `next dev`, and `outputFileTracingRoot` bounds the file tracing a build performs - two separate
 * roots in Next.js's own model, which is why one value is assigned twice rather than once.
 */
const nextConfig: NextConfig = {
  turbopack: { root: projectRoot },
  outputFileTracingRoot: projectRoot,
};

export default nextConfig;
