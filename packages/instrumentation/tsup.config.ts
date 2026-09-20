/**
 * Build configuration for `@debuggen/instrumentation`.
 *
 * This package owns the reversible-instrumentation layer: the authoring and
 * normalized plan schemas (`InstrumentationPlanInput` -> `normalizePlan` ->
 * `InstrumentationPlan`), the `InstrumentationAdapter` contract and its
 * registry, the six built-in adapters, and the ts-morph function-timing patcher
 * with its hash-recorded backups, conflict detection and cleanup — the only
 * code in the product that writes into a developer's working tree (AAP 0.5.1).
 * Its position in the acyclic workspace graph (AAP 0.2.2) is
 *
 *   shared -> telemetry -> code-analysis -> instrumentation -> protocol -> apps
 *
 * so `pnpm build` (`pnpm demo:generate && pnpm -r build`, topological) reaches
 * it after `@debuggen/shared`, `@debuggen/telemetry` and
 * `@debuggen/code-analysis` and before `@debuggen/protocol` — whose
 * `instrumentation.plan` and `instrumentation.ready` messages embed the plan,
 * action and modification-record types defined here — and before
 * `apps/local-service`, which drives the installer and the cleanup. Both
 * consumers resolve this package through its `package.json` `exports` map,
 * which points exclusively into `dist/`, so a failure here does not surface
 * here: it surfaces as an unresolvable `@debuggen/instrumentation` import in the
 * protocol message schemas and in the service's `instrumentation/service.ts` and
 * `cleanup/cleanup.ts`. Every option below is therefore stated explicitly rather
 * than left to a tsup default that a future version could change, and the whole
 * job of this file is to emit — on a clean clone, deterministically — exactly
 * the two paths `exports`, `main` and `types` advertise:
 *
 *   dist/index.js        dist/index.d.ts        (the `.` entry)
 *
 * ## Why one entry
 *
 * Unlike `@debuggen/shared`, which splits a browser-safe root entry from a
 * `./node` entry, this package has a single public surface because every part
 * of it is Node-only: ts-morph loads a target project from a real filesystem,
 * the patcher backs originals up under `$DEBUGGEN_HOME/backups` and replaces
 * files atomically through `@debuggen/shared/node`, and cleanup re-reads and
 * re-hashes those files. Nothing here can run in a page, and `package.json`
 * offers exactly one export condition, so a second entry would be a change to
 * the `exports` map and to AAP 0.2.5 rather than an edit here.
 *
 * ## Relationship to `tsc -b`
 *
 * `tsconfig.json` is `composite` and `emitDeclarationOnly` and writes into
 * `<workspace>/.tsbuild`: that is the `pnpm typecheck` gate, not a build.
 * Shipping artefacts come from this file and land in `dist/`, which
 * `.gitignore` and `.prettierignore` both exclude — so the output is
 * regenerated from source in CI on every run and never committed.
 *
 * ## Why the shape of the output matters beyond this package
 *
 * `apps/vscode-extension/esbuild.mjs` bundles the whole local service — this
 * package included — into `dist/service/main.js` so the packaged VSIX carries a
 * self-contained service. Emitting ESM whose dependencies survive as bare
 * specifiers is what lets that bundler walk the graph and decide for itself what
 * to inline, instead of inheriting decisions already baked in at this level.
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
   * production modules, so the import graph seeded here is the whole of what
   * reaches `dist/`. Two categories stay out of it by construction:
   *
   * - the `*.test.ts` suites colocated under `src/` (the schema, feasibility,
   *   cleanup, patcher, conflict and adapter tests), which the `instrumentation`
   *   Vitest project collects and the barrel never imports;
   * - `test/fixtures/project-a/**`, the standalone corpus the patcher and
   *   cleanup suites mutate in place at test time. It is not under `src/`, it is
   *   excluded from this workspace's `tsconfig.json`, and nothing in the import
   *   graph references it — the patcher opens a target project by path at
   *   runtime, which is a filesystem operation, not an import — so this build
   *   never reads it.
   */
  entry: {
    index: 'src/index.ts',
  },

  outDir: 'dist',

  /**
   * ESM only: `package.json` declares `"type": "module"` and its `exports` map
   * offers a single `import` condition. Both consumers — `@debuggen/protocol`
   * and `apps/local-service` — are ESM under Node 24, which loads it natively,
   * so a second format would double the build time to ship dead bytes. It is
   * also the format the VS Code extension's esbuild step expects when it inlines
   * the service graph into the VSIX.
   */
  format: ['esm'],

  /**
   * Matches `target: "ES2023"` in `tsconfig.base.json`. Node 24.21.0 implements
   * ES2023 in full, so nothing is downlevelled and the emitted JavaScript stays
   * close to the authored source — which keeps the sourcemaps below readable.
   */
  target: 'es2023',

  /**
   * The same deliberate choice `packages/code-analysis` makes, and the opposite
   * of `@debuggen/telemetry` (`neutral`, so an accidental Node builtin fails its
   * build) and `@debuggen/panel-schema` (`neutral`, because the DevTools panel
   * and the VS Code webview bundle it). This package is Node-only by
   * construction: it drives ts-morph over a real filesystem, records backups and
   * performs atomic replacements through `node:fs` and the `./node` entry of
   * `@debuggen/shared`, and hashes file contents with `node:crypto`. It is
   * imported only by `@debuggen/protocol` (for types) and `apps/local-service`,
   * never by the MAIN-world telemetry agent, the DevTools panel, the VS Code
   * webview or `packages/panel-renderer`, so Node builtins are expected here and
   * stating `node` makes the one supported runtime explicit: builtins stay
   * external, and the `node`/`require` export conditions of any dependency are
   * the ones that get resolved.
   */
  platform: 'node',

  /**
   * Declarations are non-negotiable: `dist/index.d.ts` is the `types` condition
   * of the `exports` map and therefore what both consumers compile against, so
   * a broken declaration step here fails their typecheck rather than this
   * build. `@debuggen/protocol` in particular re-exports these types inside its
   * message schemas, which every process in the product parses against.
   *
   * The three overrides below are each required, not defensive, and they are the
   * same block `packages/shared`, `packages/telemetry`, `packages/code-analysis`
   * and `packages/model-provider` carry for the identical `composite` + `dts`
   * combination; this workspace's `tsconfig.json` names them as the agreed place
   * for the workaround. tsup's declaration step builds its own TypeScript
   * program: it reads the `tsconfig` named at the bottom of this file and then
   * layers its own options on top, with its layer winning. Two facts about that
   * program force this block:
   *
   * - `composite` / `incremental` come from `tsconfig.json` and
   *   `tsconfig.base.json`, because the root solution file references this
   *   project for `tsc -b`. A composite program must list every input file,
   *   while tsup's program is seeded with one entry file and follows imports
   *   from there, so `src/index.ts`'s own re-exports are reported as "not listed
   *   within the file list of project" (TS6307). The two options also tie a
   *   program to a build stamp and a declaration directory that belong to the
   *   typecheck gate (`.tsbuild/`), which is not where this build writes.
   *   Disabling them for the declaration program alone leaves that gate
   *   untouched — `composite: true` stays in `tsconfig.json`, where the root
   *   solution build needs it (TS6306) — and keeps `dist/` free of a stray
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
   * `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `types: ["node"]`, and
   * the NodeNext resolution under which this package's `./x.js` relative
   * specifiers and its `node:` builtin imports type-check as real Node ESM — so
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
   * tsup 8.5.1 rewrites `import … from 'node:fs'` to `'fs'` unless this is
   * switched off: its own documentation calls the `true` default temporary and
   * says it flips in the next major version. The prefix has to survive, because
   * the patcher, the backup store and cleanup import `node:fs`, `node:path` and
   * `node:crypto` directly and through `@debuggen/shared/node`:
   *
   * - It is the only unambiguous way to name a builtin. `fs`, `path` and
   *   `crypto` also exist as packages on the public registry, so a bare
   *   specifier in a published artefact resolves to whichever of the two the
   *   consumer's resolver finds first, while `node:fs` can only ever be the
   *   builtin — and for a module whose whole contract is writing a developer's
   *   files atomically, "whichever `fs` was found" is not an acceptable answer.
   * - It is how a bundler tells a Node-only import apart from a package it
   *   should try to bundle. Stripping the prefix turns a clean "external
   *   builtin" into an unresolved module warning — or, worse, a shim — in the
   *   esbuild step that bundles the service into the VSIX.
   */
  removeNodeProtocol: false,

  /**
   * Chained through the tree-shaking pass below, so the maps in `dist/` point at
   * the TypeScript sources rather than at the intermediate bundle. That matters
   * more here than in most packages: when a patch or a restore misbehaves, the
   * stack trace a developer reads has to name `src/patch/patcher.ts` and a line
   * in it. One cosmetic consequence of the tree-shaking pass is worth knowing
   * before it looks like a defect: it re-appends its own `sourceMappingURL`
   * comment to a chunk that already carries an identical one, so the emitted
   * file ends with the same comment twice. Both name the same file, the last one
   * wins in every consumer, and removing it would mean either giving up
   * tree-shaking or post-processing the output with a footer — neither of which
   * is worth a duplicated comment.
   */
  sourcemap: true,

  /**
   * `dist/` is wiped before each build, so a file left behind by an earlier
   * layout (a renamed adapter, a removed patch module) can never masquerade as a
   * current artefact for a consumer resolving through the `exports` map. It is
   * safe to wipe unconditionally here because this build is the only writer of
   * this `dist/` — unlike `packages/telemetry`, whose two esbuild steps add the
   * browser-agent IIFE and the Node preload to the same directory after tsup has
   * run, and which therefore cannot be cleaned by a later step.
   */
  clean: true,

  /**
   * No shared chunks. Chunk names are content-addressed, so splitting would put
   * files in `dist/` whose names are not stated in the `exports` map; with a
   * single entry there is nothing to share them with in any case. Keeping it off
   * is what makes `dist/` provably the two paths documented above.
   */
  splitting: false,

  /**
   * Unminified on purpose. This is a locally installed developer tool, not a
   * payload shipped over a network: there is no size budget to defend, the
   * output is read by whoever debugs the debugger, and mangled names would make
   * the sourcemaps above less useful in exactly the traces that matter — a
   * failed patch, a conflicted restore. The one bundler downstream of this
   * package (the VSIX service bundle) applies its own minification decision to
   * the whole graph, so making it here would only take that choice away.
   */
  minify: false,

  treeshake: true,

  /**
   * Resolved relative to this file, so both the transform and the declaration
   * program above read this workspace's own `tsconfig.json` — NodeNext
   * resolution, `rootDir: "src"`, `types: ["node"]` — rather than whatever
   * config happens to sit above the process's working directory.
   */
  tsconfig: './tsconfig.json',

  /**
   * Every runtime `dependency` of `package.json`, stated explicitly even though
   * tsup keeps `dependencies` and `peerDependencies` external by default — the
   * same explicitness `packages/code-analysis` applies. The default is not a
   * guarantee this package can rely on: it reads the manifest at build time, so
   * a dependency moved between fields, or a future default, would silently start
   * inlining code that must not be inlined. Each entry has its own reason to
   * survive as a bare specifier:
   *
   * - `ts-morph` pulls in `@ts-morph/common`, which vendors an entire TypeScript
   *   compiler. Inlining it would add megabytes to every consumer's bundle and
   *   break ts-morph's own runtime file resolution, which locates its bundled
   *   `typescript` and default library files relative to the real module
   *   directory on disk. It also keeps one ts-morph instance in the process,
   *   shared with `@debuggen/code-analysis`, instead of a second compiler
   *   loading the same target project again.
   * - `zod` must be a single instance in the consuming process. A second copy
   *   gives schemas a different identity, so `instanceof z.ZodType` checks and
   *   schema reuse diverge across this package, `@debuggen/protocol` and
   *   `@debuggen/panel-schema` — which is precisely how a validated plan would
   *   stop being recognised as one at a process boundary.
   * - `diff` produces the unified diff recorded on every `ModificationRecord`
   *   and rendered in the VS Code modifications list; it is small, already ESM,
   *   and duplicating it would only duplicate a formatter.
   * - `@debuggen/shared` must stay external so that one instance of
   *   `DebuggenError` — and the string brand its cross-bundle `instanceof`
   *   substitute compares — is shared with every other workspace in the process,
   *   instead of each bundle carrying a private copy whose errors no consumer
   *   recognises. The same applies to the `SourceLocation` schema recorded on
   *   every modification and function span.
   * - `@debuggen/telemetry` supplies the event kinds and signal vocabulary the
   *   adapters map their runtime actions onto; it is the same module the browser
   *   agent, the Node preload and the service already load.
   * - `@debuggen/code-analysis` owns the code graph `src/feasibility.ts` queries
   *   before anything is patched, and carries ts-morph itself for the same
   *   reasons listed above.
   *
   * Node builtins need no entry: under `platform: 'node'` above they are
   * external, and `removeNodeProtocol: false` keeps their specifiers legible.
   */
  external: [
    '@debuggen/code-analysis',
    '@debuggen/shared',
    '@debuggen/telemetry',
    'diff',
    'ts-morph',
    'zod',
  ],
});
