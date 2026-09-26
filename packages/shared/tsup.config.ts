/**
 * Build configuration for `@debuggen/shared`.
 *
 * This package sits at the bottom of the acyclic workspace graph (AAP 0.2.2):
 * it depends on no other workspace, so `pnpm build`
 * (`pnpm demo:generate && pnpm -r build`) builds it first and every other
 * workspace loads or bundles the artefacts produced here. The
 * only job of this file is therefore to emit — deterministically, on a clean
 * clone, without anything else having run first — exactly the four paths that
 * `package.json` `exports` advertises:
 *
 *   dist/index.js        dist/index.d.ts        (the `.` entry)
 *   dist/node/index.js   dist/node/index.d.ts   (the `./node` entry)
 *
 * A drift between those paths and this configuration does not fail here: it
 * fails later, as an unresolvable `@debuggen/shared` import in eleven
 * consumers, which is why every option below is stated explicitly rather than
 * left to a tsup default that a future version could change.
 *
 * ## Why two entries
 *
 * The root entry is imported by code that runs in a page (the browser
 * telemetry agent, the panel renderer, the DevTools panel, the VS Code webview)
 * *and* by code that runs in Node (the local service, the telemetry preload,
 * the guard scripts). The `./node` entry holds the parts that cannot exist in a
 * page — SHA-256 hashing over `node:crypto` and the safe-filesystem helpers
 * over `node:fs` — so the browser-safe surface never reaches a bundler with a
 * Node builtin in it. Keeping that split honest is the whole reason this file
 * declares two entries instead of one, and a third entry would be a change to
 * the `exports` map and to AAP 0.2.5 rather than an edit here.
 *
 * ## Relationship to `tsc -b`
 *
 * `tsconfig.json` (inherited from `tsconfig.base.json`) is `composite` and
 * `emitDeclarationOnly`, and it writes into `<workspace>/.tsbuild`: that is the
 * `pnpm typecheck` gate, not a build. Shipping artefacts come from this file
 * and land in `dist/`, which `.gitignore` and `.prettierignore` both exclude —
 * so the output is regenerated from source in CI on every run and never
 * committed.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  /**
   * The object form is load-bearing. tsup derives an output path for each entry
   * from the key, so these two keys *are* `dist/index.js` and
   * `dist/node/index.js` (with the matching `.d.ts` beside each). The array
   * form would instead infer paths by stripping the longest common directory
   * of the inputs — `src/` here — which happens to give the same answer today
   * and would silently give a different one the moment a third entry changed
   * the common base. The `exports` map cannot tolerate that.
   */
  entry: {
    index: 'src/index.ts',
    'node/index': 'src/node/index.ts',
  },

  outDir: 'dist',

  /**
   * ESM only: `package.json` declares `"type": "module"` and its `exports` map
   * offers a single `import` condition per entry. There is no CJS consumer
   * anywhere in the monorepo (Node 24 loads ESM natively, and the one CommonJS
   * bundle in the repo — the VS Code extension host — is produced by esbuild
   * from its own sources), so a second format would double the build time to
   * ship dead bytes.
   */
  format: ['esm'],

  /**
   * Matches `target: "ES2023"` in `tsconfig.base.json`. Node 24.21.0 and
   * Chrome 153 both implement ES2023 in full, so nothing is downlevelled and
   * the emitted JavaScript stays close to the authored source — which keeps the
   * sourcemaps below readable.
   */
  target: 'es2023',

  /**
   * Declarations are non-negotiable: `dist/index.d.ts` and
   * `dist/node/index.d.ts` are the packed-tarball entries of the `exports`
   * map's source-first `types` arrays, carrying the single `SourceLocation` Zod
   * schema this package owns to any consumer outside the repository. Inside
   * it, every other workspace type-checks against this project's `.tsbuild`
   * declarations (root tsconfig.json, `"// no-aliases"`).
   *
   * The three overrides below are each required, not defensive. tsup's
   * declaration step builds its own TypeScript program: it reads the
   * `tsconfig` named at the bottom of this file and then layers its own
   * options on top, with its layer winning. Two facts about that program force
   * this block, and `pnpm --filter @debuggen/shared build` fails outright
   * without it:
   *
   * - `composite` / `incremental` come from `tsconfig.base.json`, because the
   *   root solution file references this project for `tsc -b`. A composite
   *   program must list every input file, while tsup's program is seeded with
   *   one entry file and follows imports from there, so `src/index.ts`'s own
   *   re-exports are reported as "not listed within the file list of project"
   *   (TS6307). The two options also tie a program to a build stamp and a
   *   declaration directory that belong to the typecheck gate (`.tsbuild/`),
   *   which is not where this build writes. Disabling them for the declaration
   *   program alone leaves the gate untouched and keeps `dist/` free of a
   *   stray `.tsbuildinfo`.
   * - `ignoreDeprecations` answers tsup 8.5.1 setting `baseUrl` on that
   *   program unconditionally (`baseUrl: compilerOptions.baseUrl || '.'`) — a
   *   value this repository deliberately never declares. TypeScript 6.0.3, the
   *   pinned compiler, raises `baseUrl` from a deprecation warning to the hard
   *   error TS5101 and names `"ignoreDeprecations": "6.0"` as the way to
   *   silence it. Nothing in the repository can stop tsup from setting it, so
   *   the acknowledgement is the fix; it is scoped to this one program and to
   *   `baseUrl`, and it will fall away when tsup stops injecting the option.
   *
   * Every other compiler option is still inherited — `strict`,
   * `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and the NodeNext
   * resolution that makes the `./node` entry type-check as real Node ESM — so
   * the declarations emitted here are the ones the typecheck gate would emit.
   */
  dts: {
    compilerOptions: {
      composite: false,
      incremental: false,
      ignoreDeprecations: '6.0',
    },
  },

  /**
   * tsup 8.5.1 rewrites `import … from 'node:crypto'` to `'crypto'` unless this
   * is switched off: its own documentation calls the `true` default temporary
   * and says it flips in the next major version. The prefix has to survive
   * here, for the `./node` entry's `node:crypto` and `node:fs` imports:
   *
   * - It is the only unambiguous way to name a builtin. `crypto` and `fs` also
   *   exist as packages on the public registry, so a bare specifier in a
   *   published artefact resolves to whichever of the two the consumer's
   *   resolver finds first, while `node:crypto` can only ever be the builtin.
   * - It is how a bundler tells a Node-only import apart from a package it
   *   should try to bundle. Stripping the prefix turns a clean "external
   *   builtin" into an unresolved module warning — or, worse, a shim — for
   *   every bundler that consumes this package, and the whole point of the
   *   two-entry split above is that this boundary stays legible.
   * - It is what the repository's own reviews grep for when checking that the
   *   root entry stayed browser-safe: `dist/index.js` must contain no `node:`
   *   specifier and `dist/node/index.js` must contain nothing else.
   */
  removeNodeProtocol: false,

  /**
   * Chained through the tree-shaking pass below, so the maps in `dist/` point
   * at the TypeScript sources rather than at the intermediate bundle. One
   * cosmetic consequence of that pass is worth knowing before it looks like a
   * defect: the tree-shaking step re-appends its own `sourceMappingURL`
   * comment to a chunk that already carries an identical one, so each emitted
   * file ends with the same comment twice. Both name the same file, the last
   * one wins in every consumer, and removing it would mean either giving up
   * tree-shaking or post-processing the output with a footer — neither of which
   * is worth a duplicated comment.
   */
  sourcemap: true,

  /**
   * `dist/` is wiped before each build, so a file left behind by an earlier
   * layout (a renamed entry, a removed module) can never masquerade as a
   * current artefact for a consumer resolving through the `exports` map.
   */
  clean: true,

  /**
   * No shared chunks. Chunk names are content-addressed, so splitting would put
   * files in `dist/` whose names are not stated in the `exports` map, and the
   * two entries exist precisely so that the Node-only code stays out of the
   * browser-safe bundle — a chunk shared between them would be the one way to
   * reintroduce it. The duplication this costs is a few hundred bytes of
   * primitive helpers.
   */
  splitting: false,

  treeshake: true,

  /**
   * Resolved relative to this file, so both the transform and the declaration
   * program above read the workspace's own `tsconfig.json` rather than whatever
   * config happens to sit above the process's working directory.
   */
  tsconfig: './tsconfig.json',

  /**
   * Nothing marks `nanoid` or `zod` as internal. tsup keeps `dependencies` and
   * `peerDependencies` external by default and that default is exactly right
   * here: `nanoid` must survive as a bare `import … from 'nanoid'` so that the
   * bundler which finally consumes this package resolves nanoid's own export
   * conditions — the browser build (Web Crypto) for the IIFE telemetry agent,
   * the Node build for the service — instead of inheriting whichever one was
   * baked in at this level. Inlining it would hand the browser agent a Node
   * implementation.
   *
   * Node builtins need no declaration either: under tsup's default `node`
   * platform `node:crypto` and `node:fs` stay external in the `./node` entry,
   * and the root entry imports no builtin at all, so `platform: 'neutral'`
   * would buy nothing and would change how the `main`/`module` fields of any
   * future dependency are resolved.
   */
});
