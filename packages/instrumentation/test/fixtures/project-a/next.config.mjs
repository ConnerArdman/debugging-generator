// Framework-detection signal for this fixture project - the kiln firing studio scheduling app the
// instrumentation suites use as a stand-in target to patch, reject and restore.
//
// The module exists to be *found*, never to be run. Framework detection looks for a `next.config.*`
// module beside a target project's `package.json`, and this file is that on-disk signal. Three
// complementary signals describe this project and have to keep agreeing with one another:
//
//   - this module is the framework signal (a framework config module exists on disk);
//   - the sibling `package.json` is the dependency and package-manager signal;
//   - the module-level `prisma` and `pool` handles under `src/server` are the driver signal.
//
// Nothing here may stand in for what the other two prove, which is why this file carries no
// dependency, driver or router vocabulary at all.
//
// The `.mjs` extension is part of the fixture's contract and must not become `.js`, `.ts` or
// `.cjs`. The sibling `package.json` omits `"type": "module"` - as an ordinary application of this
// framework often does - so the explicit ESM extension is what makes this module unambiguously
// ESM. The extension is also what keeps the file outside the fixture's own TypeScript program: the
// sibling `tsconfig.json` includes the `.ts`, `.tsx`, `.js` and `.jsx` globs only, so this module
// stays discoverable on disk while remaining invisible to the AST layer, and is therefore never
// selectable as a rewrite target. Renaming the file, or widening those globs, breaks both halves
// of that arrangement at once.
//
// Four properties are load-bearing and must survive any edit:
//
//   1. It imports nothing, statically or dynamically. The framework is a version string in the
//      sibling manifest and nothing more. This fixture tree is never installed: it is not a
//      workspace member (the workspace file globs only the application and package directories)
//      and it has no `node_modules` of its own, so no directory on this module's resolution path
//      provides the framework - the single copy installed elsewhere in the repository, for the one
//      application that actually runs it, is not on that path - and a specifier naming it is
//      unresolvable at run time (verified: resolving it from this directory answers
//      ERR_MODULE_NOT_FOUND, here and equally from the temporary copy a suite works on). There is
//      no `require` either: this file is ESM.
//   2. It is inert. No top-level `await`, no environment reads, no logging, no named exports and no
//      asynchronous option, so evaluating the module defines one object and does nothing else.
//   3. It declares no build output. `distDir`, `output`, `outputFileTracingRoot`, `experimental`,
//      `turbopack` and `webpack` are absent by design, so no artefact directory can appear inside
//      this tree and a fresh clone cannot differ from the tree that produced it. `headers`,
//      `rewrites` and `redirects` are absent for that reason and because a function here would be
//      behaviour the fixture does not need and every suite inspecting it would have to allow for.
//   4. It stays trivially analysable. Every value is a static literal, so the whole configuration
//      is readable - by a person or by a parser - without evaluating anything.
//
// A suite that mutates this project copies the tree into a temporary directory of its own first, so
// no absolute or repository-relative path may appear here: the copy has to be exactly as meaningful
// at its new location as the original is here.

const nextConfig = {
  // The one option an ordinary application of this framework almost always sets, and a static
  // boolean rather than a function, which leaves this module with no behaviour worth analysing.
  reactStrictMode: true,
};

export default nextConfig;
