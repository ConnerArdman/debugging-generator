/**
 * Build configuration for `@debuggen/model-provider`.
 *
 * This package is the model boundary (AAP 0.5.3): the `ModelProvider`
 * interface, the Anthropic and deterministic implementations, the
 * structured-output validator with its repair loop, the versioned prompt loader
 * and the outbound redaction guard. It sits one layer above
 * `@debuggen/shared` and below nothing — `apps/local-service` consumes it, and
 * `apps/vscode-extension` bundles it (through the service) into the VSIX — so
 * `pnpm build` (`pnpm demo:generate && pnpm -r build`) builds `@debuggen/shared`
 * first and then this package, and every consumer type-checks against the
 * declarations emitted here.
 *
 * The one job of this file is to emit — deterministically, on a clean clone,
 * with only `@debuggen/shared` built before it — exactly the two paths that
 * `package.json` `exports` advertises for the single `.` entry:
 *
 *   dist/index.js        dist/index.d.ts
 *
 * A drift between those paths and this configuration does not fail here: it
 * fails later, as an unresolvable `@debuggen/model-provider` import in the
 * service and in the packaged extension. Every option below is therefore stated
 * explicitly rather than left to a tsup default that a future version could
 * change, and the option set and its order mirror
 * `packages/shared/tsup.config.ts` so the two configurations can be read as
 * one.
 *
 * ## Why one entry
 *
 * `@debuggen/shared` needs two entries because part of its surface has to stay
 * browser-safe; `@debuggen/telemetry` adds standalone esbuild bundles for the
 * page agent and the Node preload. Neither applies here: a model call only ever
 * happens in the local service process, so there is no browser-safe subset to
 * separate out and no second artefact to produce. A second entry would be a
 * change to the `exports` map and to AAP 0.2.5, not an edit to this file.
 *
 * ## Relationship to `tsc -b`
 *
 * `tsconfig.json` is `composite` and `emitDeclarationOnly` and writes into
 * `<workspace>/.tsbuild`: that is the `pnpm typecheck` gate, not a build.
 * Shipping artefacts come from this file and land in `dist/`, which
 * `.gitignore` and `.prettierignore` both exclude — so the output is
 * regenerated from source on every CI run and never committed.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  /**
   * The object form is load-bearing even with a single entry. tsup derives each
   * output path from the entry *key*, so `index` is literally `dist/index.js`
   * with `dist/index.d.ts` beside it — the two paths `package.json` `exports`
   * names. The array form would instead infer the path by stripping the longest
   * common directory of the inputs, which happens to give the same answer for
   * one file in `src/` and would silently give a different one the moment the
   * entry moved. The `exports` map cannot tolerate that, and keeping the object
   * form here also keeps this file diff-comparable with its sibling.
   *
   * `src/index.ts` is the package barrel; everything reachable from it is
   * bundled and nothing else is. The colocated tests
   * (`src/structured.test.ts`, `src/prompt-loader.test.ts`,
   * `src/redact-guard.test.ts`, `src/providers/deterministic.test.ts`,
   * `src/providers/anthropic.test.ts`) are inputs to the typecheck gate and to
   * Vitest, never to this build, because the barrel does not import them. That
   * is why no `ignore`/exclude pattern appears below: an exclude would imply
   * the graph could reach them, and it cannot.
   */
  entry: {
    index: 'src/index.ts',
  },

  outDir: 'dist',

  /**
   * ESM only: `package.json` declares `"type": "module"` and its `exports` map
   * offers a single condition per entry. Node 24 loads ESM natively, the
   * service is ESM, and the one CommonJS bundle in the repository (the VS Code
   * extension host) is produced by esbuild from its own sources — so a second
   * format would double the build time to ship dead bytes.
   */
  format: ['esm'],

  /**
   * Matches `target: "ES2023"` in `tsconfig.base.json`. The runtime pin is Node
   * 24.21.0, which implements ES2023 in full, so nothing is downlevelled and
   * the emitted JavaScript stays close to the authored source — which keeps the
   * sourcemaps below readable when a provider call is being debugged.
   */
  target: 'es2023',

  /**
   * Declarations are non-negotiable: `dist/index.d.ts` is what
   * `apps/local-service` type-checks its pipeline stages against, including the
   * generic `generateStructured<T>(schema, req)` signature that carries each
   * stage's Zod authoring schema through to its parsed result.
   *
   * The three overrides below are each required, not defensive. tsup's
   * declaration step builds its own TypeScript program: it reads the `tsconfig`
   * named at the bottom of this file and then layers its own options on top,
   * with its layer winning. Two facts about that program force this block, and
   * `pnpm --filter @debuggen/model-provider build` fails outright without it:
   *
   * - `composite` is set by `tsconfig.json` itself (and `incremental` by
   *   `tsconfig.base.json`) because the root solution file references this
   *   project for `tsc -b`. A composite program must list every input file,
   *   while tsup's program is seeded with one entry file and follows imports
   *   from there, so the barrel's own re-exports are reported as "not listed
   *   within the file list of project" (TS6307). The two options also tie a
   *   program to a build stamp and a declaration directory that belong to the
   *   typecheck gate (`.tsbuild/`), which is not where this build writes.
   *   Disabling them for the declaration program alone leaves the gate
   *   untouched — `tsconfig.json` keeps `composite: true`, as its own comment
   *   requires — and keeps `dist/` free of a stray `.tsbuildinfo`.
   * - `ignoreDeprecations` answers tsup 8.5.1 setting `baseUrl` on that program
   *   unconditionally (`baseUrl: compilerOptions.baseUrl || '.'`) — a value
   *   this repository deliberately never declares. TypeScript 6.0.3, the pinned
   *   compiler, raises `baseUrl` from a deprecation warning to the hard error
   *   TS5101 and names `"ignoreDeprecations": "6.0"` as the way to silence it.
   *   Nothing in the repository can stop tsup from setting it, so the
   *   acknowledgement is the fix; it is scoped to this one program and to
   *   `baseUrl`, and it will fall away when tsup stops injecting the option.
   *
   * Every other compiler option is still inherited — `strict`,
   * `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
   * `exactOptionalPropertyTypes`, and the NodeNext resolution under which this
   * Node-only package is authored — so the declarations emitted here are the
   * ones the typecheck gate would emit. No `.d.ts.map` accompanies them: the
   * same declaration step forces `declarationMap: false`, matching the sibling.
   */
  dts: {
    compilerOptions: {
      composite: false,
      incremental: false,
      ignoreDeprecations: '6.0',
    },
  },

  /**
   * tsup 8.5.1 rewrites `import … from 'node:fs'` to `'fs'` unless this is
   * switched off: its own documentation calls the `true` default temporary and
   * says it flips in the next major version. The prefix has to survive for this
   * package's Node builtins — `node:fs`, `node:path` and `node:url` behind
   * `src/prompt-loader.ts`, which reads the versioned prompt files under
   * `apps/local-service/prompts/**`:
   *
   * - It is the only unambiguous way to name a builtin. `fs` and `path` also
   *   exist as packages on the public registry, so a bare specifier resolves to
   *   whichever the consumer's resolver finds first, while `node:fs` can only
   *   ever be the builtin.
   * - It is how a bundler tells a Node-only import apart from a package it
   *   should try to bundle. Stripping the prefix turns a clean "external
   *   builtin" into an unresolved-module warning — or, worse, a shim — in
   *   `apps/vscode-extension/esbuild.mjs` when the service and this package are
   *   bundled into the VSIX.
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
   * post-processing the output with a footer — neither worth a duplicated
   * comment.
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
   * files in `dist/` whose names are not stated in the `exports` map. With one
   * entry there is nothing to share anyway; stating it keeps the emitted set
   * exactly as wide as the map, whatever a future tsup default does.
   */
  splitting: false,

  treeshake: true,

  /**
   * Resolved relative to this file, so both the transform and the declaration
   * program above read this workspace's own `tsconfig.json` — its NodeNext
   * resolution and `types: ["node"]` — rather than whatever config happens to
   * sit above the process's working directory.
   */
  tsconfig: './tsconfig.json',

  /**
   * Nothing marks `@anthropic-ai/sdk`, `zod` or `@debuggen/shared` as internal.
   * tsup keeps `dependencies` and `peerDependencies` external by default and
   * that default is exactly right here, which is why no `external` array
   * appears — the sibling omits it for the same reason:
   *
   * - `@anthropic-ai/sdk` must survive as a bare specifier so the SDK resolves
   *   its own export conditions and stays a single instance in the service
   *   process. Inlining a network client would also make this bundle unloadable
   *   for offline tests, which import it with `DEBUGGEN_PROVIDER=deterministic`
   *   and must never construct an Anthropic client.
   * - `zod` must be the *same* module instance as the one the caller used to
   *   build the authoring schema it hands to `generateStructured`. A second,
   *   inlined copy would make `instanceof`-based checks and `z.ZodError`
   *   handling fail across the boundary for schemas that are otherwise
   *   identical.
   * - `@debuggen/shared` resolves through its own `exports` map at the
   *   consumer, so the single `SourceLocation` schema, `Result` and
   *   `DebuggenError` definitions stay single-sourced (AAP 0.2.2) instead of
   *   being duplicated into this bundle.
   *
   * Node builtins need no declaration either: under tsup's default `node`
   * platform `node:fs`, `node:path` and `node:url` stay external, so
   * `platform: 'neutral'` would buy nothing and would change how the
   * `main`/`module` fields of any future dependency are resolved.
   */
});
