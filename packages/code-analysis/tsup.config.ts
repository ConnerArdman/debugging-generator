/**
 * Build configuration for `@debuggen/code-analysis`.
 *
 * This package turns a *target* project's TypeScript sources into the queryable
 * code graph the pipeline investigates with — imports, symbols, React
 * components, event handlers, API calls, API routes, server functions, database
 * calls — and resolves generated bundle positions back to project-relative
 * source locations. Its position in the acyclic workspace graph (AAP 0.2.2) is
 *
 *   shared -> telemetry -> code-analysis -> instrumentation -> ... -> protocol
 *
 * so `pnpm build` (`pnpm demo:generate && pnpm -r build`, topological) reaches
 * it after `@debuggen/shared` and before `packages/instrumentation` and
 * `apps/local-service`, the only two consumers of what this file emits. Both
 * resolve this package through its `package.json` `exports` map, which points
 * exclusively into `dist/`, so a failure here does not surface here: it
 * surfaces as an unresolvable `@debuggen/code-analysis` import in the
 * instrumentation feasibility checks and in the service's `code-tools.ts`,
 * `source/resolve.ts` and `sessions/progress.ts`. Every option below is
 * therefore stated explicitly rather than left to a tsup default that a future
 * version could change, and the whole job of this file is to emit — on a clean
 * clone, deterministically — exactly the two paths `exports` advertises:
 *
 *   dist/index.js        dist/index.d.ts        (the `.` entry)
 *
 * ## Why one entry
 *
 * Unlike `@debuggen/shared`, which splits a browser-safe root entry from a
 * `./node` entry, this package has a single public surface because every part
 * of it is Node-only: ts-morph walks a real filesystem, the index cache is
 * written under `$DEBUGGEN_HOME/index`, and the source-map resolver fetches a
 * dev-server chunk map over HTTP before handing it to
 * `@jridgewell/trace-mapping`. Nothing here can run in a page, so there is no
 * second surface to keep honest. A second entry would be a change to the
 * `exports` map and to AAP 0.2.5 rather than an edit here.
 *
 * ## Relationship to `tsc -b`
 *
 * `tsconfig.json` is `composite` and `emitDeclarationOnly` and writes into
 * `<workspace>/.tsbuild`: that is the `pnpm typecheck` gate, not a build.
 * Shipping artefacts come from this file and land in `dist/`, which
 * `.gitignore` and `.prettierignore` both exclude — so the output is
 * regenerated from source in CI on every run and never committed.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  /**
   * The object form is load-bearing. tsup derives an output path for each entry
   * from the key, so this key *is* `dist/index.js` (with `dist/index.d.ts`
   * beside it), which is what the `exports` map names. The array form would
   * instead infer the path by stripping the longest common directory of the
   * inputs, which happens to give the same answer for a single entry and would
   * silently give a different one the moment a second entry changed the common
   * base. The `exports` map cannot tolerate that.
   *
   * `src/index.ts` is the package's only public barrel and it re-exports only
   * production modules. The `*.test.ts` suites colocated under `src/`, which
   * the `code-analysis` Vitest project collects, are reached by Vitest alone:
   * they are never imported from the barrel, so the import graph seeded here
   * cannot pull them into `dist/`.
   */
  entry: {
    index: 'src/index.ts',
  },

  outDir: 'dist',

  /**
   * ESM only: `package.json` declares `"type": "module"` and its `exports` map
   * offers a single `import` condition. Both consumers — `packages/instrumentation`
   * and `apps/local-service` — are ESM under Node 24, which loads it natively,
   * so a second format would double the build time to ship dead bytes.
   */
  format: ['esm'],

  /**
   * Matches `target: "ES2023"` in `tsconfig.base.json`. Node 24.21.0 implements
   * ES2023 in full, so nothing is downlevelled and the emitted JavaScript stays
   * close to the authored source — which keeps the sourcemaps below readable.
   */
  target: 'es2023',

  /**
   * The deliberate difference from `@debuggen/shared`, whose root entry must
   * stay loadable in a page and so leaves the platform at tsup's default. This
   * package is Node-only by construction: it drives ts-morph over a real
   * filesystem, reads and writes the JSON index cache through the `./node`
   * entry of `@debuggen/shared`, and fetches source maps from the dev server.
   * It is imported only by `packages/instrumentation` and `apps/local-service`,
   * never by the MAIN-world telemetry agent, the DevTools panel, the VS Code
   * webview or `packages/panel-renderer`, so there is no browser-safety
   * constraint to preserve and stating `node` makes the one supported runtime
   * explicit: Node builtins stay external, and the `node`/`require` export
   * conditions of any dependency are the ones that get resolved.
   */
  platform: 'node',

  /**
   * Declarations are non-negotiable: `dist/index.d.ts` is the `types` condition
   * of the `exports` map and therefore what both consumers compile against, so
   * a broken declaration step here fails their typecheck rather than this
   * build.
   *
   * The three overrides below are each required, not defensive, and they are
   * the same block `packages/shared/tsup.config.ts` carries for the identical
   * `composite` + `dts` combination. tsup's declaration step builds its own
   * TypeScript program: it reads the `tsconfig` named at the bottom of this
   * file and then layers its own options on top, with its layer winning. Two
   * facts about that program force this block:
   *
   * - `composite` / `incremental` come from `tsconfig.json` and
   *   `tsconfig.base.json`, because the root solution file references this
   *   project for `tsc -b`. A composite program must list every input file,
   *   while tsup's program is seeded with one entry file and follows imports
   *   from there, so `src/index.ts`'s own re-exports are reported as "not
   *   listed within the file list of project" (TS6307). The two options also
   *   tie a program to a build stamp and a declaration directory that belong to
   *   the typecheck gate (`.tsbuild/`), which is not where this build writes.
   *   Disabling them for the declaration program alone leaves that gate
   *   untouched — `composite: true` stays in `tsconfig.json`, where the root
   *   solution build needs it — and keeps `dist/` free of a stray
   *   `.tsbuildinfo`.
   * - `ignoreDeprecations` answers tsup 8.5.1 setting `baseUrl` on that program
   *   unconditionally (`baseUrl: compilerOptions.baseUrl || '.'`) — a value this
   *   repository deliberately never declares. TypeScript 6.0.3, the pinned
   *   compiler, raises `baseUrl` from a deprecation warning to the hard error
   *   TS5101 and names `"ignoreDeprecations": "6.0"` as the way to silence it.
   *   Nothing in the repository can stop tsup from setting it, so the
   *   acknowledgement is the fix; it is scoped to this one program and to
   *   `baseUrl`, and it will fall away when tsup stops injecting the option.
   *
   * Every other compiler option is still inherited — `strict`,
   * `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and the NodeNext
   * resolution under which this package's `./x.js` relative specifiers and its
   * `node:` builtin imports type-check as real Node ESM — so the declarations
   * emitted here are the ones the typecheck gate would emit.
   */
  dts: {
    compilerOptions: {
      composite: false,
      incremental: false,
      ignoreDeprecations: '6.0',
    },
  },

  /**
   * tsup 8.5.1 rewrites `import … from 'node:path'` to `'path'` unless this is
   * switched off: its own documentation calls the `true` default temporary and
   * says it flips in the next major version. The prefix has to survive, because
   * this package's project loader, index cache and path normalisation import
   * `node:fs`, `node:path` and `node:crypto` directly:
   *
   * - It is the only unambiguous way to name a builtin. `fs` and `path` also
   *   exist as packages on the public registry, so a bare specifier in a
   *   published artefact resolves to whichever of the two the consumer's
   *   resolver finds first, while `node:path` can only ever be the builtin.
   * - It is how a bundler tells a Node-only import apart from a package it
   *   should try to bundle. Stripping the prefix turns a clean "external
   *   builtin" into an unresolved module warning — or, worse, a shim — in
   *   `apps/local-service`, which bundles this package's output into
   *   `dist/service/main.js` for the VS Code extension's VSIX.
   */
  removeNodeProtocol: false,

  /**
   * Chained through the tree-shaking pass below, so the maps in `dist/` point
   * at the TypeScript sources rather than at the intermediate bundle. One
   * cosmetic consequence of that pass is worth knowing before it looks like a
   * defect: the tree-shaking step re-appends its own `sourceMappingURL` comment
   * to a chunk that already carries an identical one, so the emitted file ends
   * with the same comment twice. Both name the same file, the last one wins in
   * every consumer, and removing it would mean either giving up tree-shaking or
   * post-processing the output with a footer — neither of which is worth a
   * duplicated comment.
   */
  sourcemap: true,

  /**
   * `dist/` is wiped before each build, so a file left behind by an earlier
   * layout (a renamed module, a removed extractor) can never masquerade as a
   * current artefact for a consumer resolving through the `exports` map.
   */
  clean: true,

  /**
   * No shared chunks. Chunk names are content-addressed, so splitting would put
   * files in `dist/` whose names are not stated in the `exports` map; with a
   * single entry there is nothing to share them with in any case. Keeping it
   * off is what makes `dist/` provably the two paths documented above.
   */
  splitting: false,

  treeshake: true,

  /**
   * Resolved relative to this file, so both the transform and the declaration
   * program above read this workspace's own `tsconfig.json` — NodeNext
   * resolution, `rootDir: "src"`, `types: ["node"]` — rather than whatever
   * config happens to sit above the process's working directory.
   */
  tsconfig: './tsconfig.json',

  /**
   * The three runtime `dependencies` of `package.json`, stated explicitly even
   * though tsup keeps `dependencies` and `peerDependencies` external by
   * default. The default is not a guarantee this package can rely on — it reads
   * the manifest at build time, so a dependency moved between fields, or a
   * future default, would silently start inlining code that must not be
   * inlined — and each entry has its own reason to survive as a bare
   * specifier:
   *
   * - `ts-morph` pulls in `@ts-morph/common`, which vendors an entire
   *   TypeScript compiler. Inlining it would bloat every consumer's bundle by
   *   megabytes and break ts-morph's own runtime file resolution, which locates
   *   its bundled `typescript` and default library files relative to the real
   *   module directory on disk.
   * - `@debuggen/shared` must stay external so that one instance of
   *   `DebuggenError` — and the string brand its cross-bundle `instanceof`
   *   substitute compares — is shared with every other workspace in the
   *   process, instead of each bundle carrying a private copy whose errors no
   *   consumer recognises.
   * - `@jridgewell/trace-mapping` is consumed as a peer of the source maps it
   *   decodes and is already ESM, so there is nothing to gain from inlining it
   *   and a duplicated decoder to lose.
   *
   * Node builtins need no entry: under `platform: 'node'` above they are
   * external, and `removeNodeProtocol: false` keeps their specifiers legible.
   */
  external: ['@debuggen/shared', 'ts-morph', '@jridgewell/trace-mapping'],
});
