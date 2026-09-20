/**
 * Next.js configuration of the static indexing corpus that lives under
 * `packages/code-analysis/test/fixtures/sample-next-app`.
 *
 * This module exists to be *found*, never to be run. `packages/code-analysis/src/summary.ts`
 * decides which framework a target project uses partly by looking for a `next.config.*` file
 * beside that project's `package.json`, and this file is that on-disk signal. The detection is
 * layered on purpose and the three layers stay independently testable:
 *
 *   - this file is the *config* signal (a framework config module exists on disk);
 *   - the sibling `package.json` is the *dependency and package-manager* signal;
 *   - the committed `app/` and `pages/` trees are the *router* signal.
 *
 * Keeping route and router vocabulary out of this module is therefore deliberate, not an
 * oversight: nothing here may stand in for what the router trees prove.
 *
 * The `.mjs` extension is part of the fixture's contract and must not become `.js`, `.ts` or
 * `.cjs`. The sibling `package.json` omits `"type": "module"` on purpose - a generic Next.js
 * application often does - so the explicit ESM extension is what makes this module
 * unambiguously ESM, and a detection test may assert the extension itself.
 *
 * Four properties are load-bearing and must survive any edit:
 *
 *   1. It imports nothing, statically or dynamically. The `@debuggen/code-analysis` workspace
 *      pins only ts-morph, `@jridgewell/trace-mapping` and `@debuggen/shared`, so the `next`
 *      package is never installed anywhere in this repository and a module specifier naming it
 *      would be unresolvable at run time. The `@type` annotation below is a comment: it documents
 *      the expected shape exactly as a real target project does, and resolves to nothing.
 *   2. It is inert. No top-level `await`, no environment reads, no logging, no named exports and
 *      no asynchronous option, so evaluating the module defines one object and does nothing else.
 *   3. It declares no build output. `distDir`, `output`, `outputFileTracing*`, `experimental`,
 *      `turbopack` and `webpack` are all absent by design: the repository ignores `.next/`,
 *      `out/` and `dist/`, so an artefact generated inside this corpus could never travel with
 *      it, and a fresh clone would silently differ from the tree that produced it. `rewrites`,
 *      `redirects` and `headers` are absent for the second reason above as well as this one.
 *   4. It stays trivially analysable. Every value is a static literal, so a reader - human or
 *      ts-morph - can see the whole configuration without evaluating anything.
 *
 * The fixture as a whole is read-only input: the unit suite indexes this tree and must leave it
 * byte-identical, so a test that needs to mutate a fixture file copies the tree into a temporary
 * directory of its own first.
 *
 * This file is outside the fixture's TypeScript program as well - the fixture `tsconfig.json`
 * includes TypeScript sources only, by the two globs for the `.ts` and `.tsx` extensions - which
 * is exactly the point: it is discovered as a file on disk, not as a source file of the program
 * under analysis.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  // The single option a generic Next.js application almost always sets, and a static boolean
  // rather than a function, which keeps this module free of behaviour worth analysing.
  reactStrictMode: true,
};

export default nextConfig;
