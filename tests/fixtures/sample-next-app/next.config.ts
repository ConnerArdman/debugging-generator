/**
 * Next.js configuration for the generic fixture application (AAP 0.7.1 Group 6).
 *
 * This directory is a small, ordinary Next.js 16 App Router project that the browser and
 * end-to-end suites point the debugging tool at when they need to prove the tool works on an
 * application it has never seen: nothing here shares a name, a route or a dependency with the
 * repository's own demonstration application, and nothing here imports anything the repository
 * builds. The configuration is therefore as close to empty as it can be while still holding one
 * guarantee the fixture cannot do without.
 *
 * THE ROOT PIN - the only two options this file sets, and the reason it exists.
 *
 * Both options below answer the same question with the same value: which directory is the top of
 * this project? Left unanswered, Next.js infers it by walking up from the project directory until
 * it finds a lockfile, and in this repository that walk does not stop until it reaches the
 * repository root - a directory that holds every other workspace and several hundred megabytes of
 * installed dependencies. Two consequences follow, and both matter here:
 *
 *   - the dev server announces, and traces files against, a root far above this application, so
 *     module resolution and file tracing take in a tree that has nothing to do with it; and
 *   - the inference prints a warning about an inferred workspace root, which is noise in a suite
 *     whose whole job is to watch a dev server's output for signs of the tool's own work.
 *
 * Pinning also has to survive relocation, which is the second half of the requirement. The
 * service's integration suites copy this directory to a temporary path and run the copy, so the
 * pin may not be a constant, may not point outside this directory, and may not assume this
 * directory's position in any checkout. `import.meta.dirname` satisfies all three: it is the
 * directory of whichever copy of this file Next.js actually loaded, resolved at load time.
 *
 * The pin cuts both ways, and whatever starts this application has to know it: the root is also
 * the boundary of what the bundler is allowed to read ("files outside of the workspace root are
 * not compiled"), so this application's dependencies have to be resolvable from inside this
 * directory. A `node_modules` directory here resolves; one above this directory does not, and a
 * `node_modules` symlink whose target lies outside this directory is rejected outright. That is
 * the same rule in place and in a copy, which is the point of pinning rather than inferring.
 *
 * Nothing else is configured, and the emptiness is deliberate. The fixture's value is being an
 * application the tool knows nothing about, so every option added here would be one more property
 * of the target that a passing test might quietly depend on. Specifically absent:
 *
 *   - no `basePath` and no `assetPrefix`: the application answers at `/`, which is what the
 *     extension's host permissions cover and what the suites navigate to;
 *   - no `distDir` and no `output`: build and dev output stays in `.next/`, the directory this
 *     folder's ignore rules cover, because the cleanup guarantee is asserted as an empty
 *     `git status --porcelain` for this path;
 *   - no `serverExternalPackages` override: the default list is what keeps runtime dependencies
 *     resolvable as real module requests, which is the precondition for a tracer installed before
 *     the server starts to be able to wrap them;
 *   - no tracing or instrumentation wiring of any kind, and no `instrumentation.ts` hook: the
 *     product attaches tracing from outside, by launching the dev server with a Node preload, and
 *     this fixture must import nothing the product publishes;
 *   - no `env`, `images`, `redirects`, `rewrites`, `headers`, `webpack` or `compiler` block, and
 *     no `typescript` or `reactStrictMode` override, so the application compiles and behaves like
 *     the stock App Router project it is meant to represent;
 *   - no port: the port is a command-line concern of the start script, never a baked-in value.
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
 * The configuration Next.js loads for this fixture application.
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
