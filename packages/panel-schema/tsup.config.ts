/**
 * Build configuration for `@debuggen/panel-schema`.
 *
 * This package is the gate between a language model and the screen (AAP 0.5.3):
 * `apps/local-service` parses a model's structured output against the *authoring*
 * schema here (`PanelSpecInput`), runs the deterministic normaliser
 * (`normalizePanel`), validates the resulting internal `PanelSpec`, and finally
 * checks it semantically against the capture — and only then may a panel reach
 * `PanelHost`. Every one of those four steps is imported from the artefact this
 * file emits, as is the node catalog that `packages/panel-renderer` keys its
 * component registry by. There is therefore exactly one job here: emit —
 * deterministically, on a clean clone, with nothing else having run first — the
 * two paths that `package.json` `exports` advertises for the `"."` condition:
 *
 *   dist/index.js        dist/index.d.ts
 *
 * A drift between those paths and this configuration does not fail here. It
 * fails later, as an unresolvable `@debuggen/panel-schema` import in the local
 * service, the panel renderer, the protocol package and the DevTools panel —
 * which is why every option below is stated explicitly rather than left to a
 * tsup default that a future version could change.
 *
 * ## Why one entry
 *
 * Unlike `@debuggen/shared`, which splits a browser-safe root entry from a
 * `./node` entry, and `@debuggen/telemetry`, which adds a `./node/register`
 * preload and an IIFE agent built by two sibling esbuild scripts, this package
 * has a single public surface (AAP 0.2.2 assigns secondary entries only to those
 * two). Nothing in `src/**` is runtime-specific: it is pure Zod schema and pure
 * data — the authoring schema (`input.ts`), the normaliser (`normalize.ts`), the
 * internal spec and its evidence types (`spec.ts`, `summary.ts`,
 * `nodes/{query,layout,viz}.ts`), the node catalog (`catalog.ts`) and the
 * validators (`validate.ts`, `semantic.ts`, `json-schema.ts`). A second entry
 * would be a change to the `exports` map and to AAP 0.2.5, not an edit here.
 *
 * ## Why the colocated tests cannot reach `dist/`
 *
 * `src/{input,normalize,validate,semantic,catalog}.test.ts` sit beside the
 * modules they cover (the Vitest project `panel-schema` collects every
 * `*.test.ts` under `packages/panel-schema/src`). They stay out of the shipped
 * graph structurally rather than by an ignore rule: the single entry below is
 * `src/index.ts`, tsup follows imports from there, and the barrel re-exports
 * library modules only — so no test file, and no `vitest` specifier, is ever
 * reachable. Post-build greps for `vitest` in `dist/index.js` and
 * `dist/index.d.ts` are the standing check that the barrel kept that promise.
 *
 * ## Relationship to `tsc -b`
 *
 * `tsconfig.json` is `composite` and `emitDeclarationOnly` and writes into
 * `packages/panel-schema/.tsbuild`: that is the `pnpm typecheck` gate, not a
 * build. Shipping artefacts come from this file and land in `dist/`, which
 * `.gitignore` and `.prettierignore` both exclude, so the output is regenerated
 * from source on every CI run and never committed. Because the two workspace
 * dependencies are resolved through their own `exports` maps (their `dist/`),
 * `pnpm build` must run in topological order — `shared` -> `telemetry` -> this
 * package — which `pnpm -r build` guarantees from the `dependencies` field.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  /**
   * The object form is load-bearing, exactly as in `packages/shared` and
   * `packages/telemetry`: tsup derives the output path from the key, so this key
   * *is* `dist/index.js` with `dist/index.d.ts` beside it, byte for byte the
   * paths the sibling `package.json` `exports` block names. The array form would
   * instead infer paths by stripping the longest common directory of the inputs,
   * which agrees for one entry today and would silently disagree the moment the
   * entry list changed — a drift the `exports` map cannot absorb, and one that
   * surfaces at the consumer as "package has no exports" rather than here.
   */
  entry: {
    index: 'src/index.ts',
  },

  outDir: 'dist',

  /**
   * ESM only: `package.json` declares `"type": "module"` and the `"."` condition
   * offers a single `import` target. Every consumer — `apps/local-service`,
   * `packages/protocol`, `packages/panel-renderer` and, through the renderer,
   * the DevTools panel and the VS Code webview — is ESM or is bundled by a
   * bundler that prefers ESM, so a CJS output would be dead bytes behind an
   * `exports` condition nobody reads.
   */
  format: ['esm'],

  /**
   * Matches `target: "ES2023"` in `tsconfig.base.json`. Node 24.21.0 and Chrome
   * 153 both implement ES2023 in full, so nothing is downlevelled and the
   * emitted JavaScript stays close to the authored source — which keeps the
   * sourcemaps below readable and, more importantly, keeps a Zod schema's
   * structure recognisable when a validation error is being read in anger.
   */
  target: 'es2023',

  /**
   * The load-bearing platform choice, and the reason this file follows
   * `packages/telemetry`'s library entry rather than `packages/code-analysis`.
   *
   * This bundle is loaded by a Node process (`apps/local-service` parses,
   * normalises and validates panel specifications) *and* by two page bundles
   * (the DevTools panel and the VS Code webview reach the catalog and the node
   * types through `@debuggen/panel-renderer`). Under tsup's default
   * `platform: 'node'`, a `node:*` import that crept into `src/**` would be
   * quietly externalised and shipped inside this barrel, and the breakage would
   * appear far from its cause — as an unresolved builtin in the panel's Vite
   * build, or as a runtime explosion in the page. `neutral` removes that escape
   * hatch: esbuild has no builtin list to fall back on, so such an import fails
   * *this* build loudly. The same guard covers the other direction: the
   * workspace `tsconfig.json` deliberately omits `"DOM"` from `lib`, so a
   * `window`/`document` reference cannot compile either.
   *
   * Neutral also empties esbuild's `mainFields`/`conditions` defaults, which is
   * harmless here because every third-party specifier stays external (see
   * `external` below), so this build resolves nothing but relative paths inside
   * `src/`.
   */
  platform: 'neutral',

  /**
   * Declarations are the product of this package as much as the JavaScript is:
   * `PanelSpec`, `PanelSpecInput`, `PanelNode`, `PanelNodeInput`, `DataQuery`,
   * `Fact`, `Hypothesis`, `EventRef` and the catalog types are consumed as types
   * by four workspaces, and `dist/index.d.ts` is what a packed tarball carries
   * them in (inside the repository those workspaces type-check against this
   * project's `.tsbuild` declarations; root tsconfig.json, `"// no-aliases"`).
   * The catalog and the validators must stay *values* in `dist/index.js` too —
   * `packages/panel-renderer/src/host/registry.test.ts` imports the catalog from
   * this build output to prove every node type has a renderer component — so the
   * declaration step never replaces the JavaScript entry, it accompanies it.
   *
   * The three overrides are required, not defensive. tsup's declaration step
   * builds its own TypeScript program from the `tsconfig` named at the bottom of
   * this file and then layers its own options on top, with its layer winning:
   *
   * - `composite` / `incremental` are inherited (`tsconfig.base.json` sets both,
   *   and the workspace config restates `composite` because the root solution
   *   file references this project for `tsc -b`). A composite program must list
   *   every input file, whereas tsup's program is seeded with one entry file and
   *   follows imports, so the barrel's own re-exports are reported as "not
   *   listed within the file list of project" (TS6307). The two options also bind
   *   a program to the build stamp and declaration directory of the typecheck
   *   gate (`.tsbuild/`), which is not where this build writes. Disabling them
   *   for the declaration program alone leaves the gate untouched — `composite:
   *   true` stays in `tsconfig.json`, where `tsc -b` needs it — and keeps
   *   `dist/` free of a stray `.tsbuildinfo`.
   * - `ignoreDeprecations` answers tsup 8.5.1 setting `baseUrl` on that program
   *   unconditionally (`baseUrl: compilerOptions.baseUrl || '.'`) — a value this
   *   repository deliberately never declares, because the two workspace
   *   dependencies must resolve through their `exports` maps and not through a
   *   path alias. TypeScript 6.0.3, the pinned compiler, raises `baseUrl` from a
   *   deprecation warning to the hard error TS5101 and names
   *   `"ignoreDeprecations": "6.0"` as the acknowledgement. Nothing in the
   *   repository can stop tsup from injecting the option, so the acknowledgement
   *   is the fix; it is scoped to this one program and to `baseUrl`, and it falls
   *   away when tsup stops injecting it.
   *
   * Every other compiler option is still inherited — `strict`,
   * `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
   * `exactOptionalPropertyTypes` and the NodeNext resolution that makes the
   * `.js`-suffixed relative specifiers in `src/**` type-check — so the
   * declarations emitted here are the ones the typecheck gate would emit.
   */
  dts: {
    compilerOptions: {
      composite: false,
      incremental: false,
      ignoreDeprecations: '6.0',
    },
  },

  /**
   * Switched off for the same reason `packages/telemetry` switches it off, and
   * here it is what keeps the `platform: 'neutral'` guarantee above honest. tsup
   * 8.5.1 implements `removeNodeProtocol: true` (still the default; its own
   * documentation calls that temporary and says it flips in the next major) as a
   * resolve plugin that rewrites `node:x` to `x` *and* marks it external — which
   * would swallow precisely the failure neutral exists to raise, turning a
   * Node-only import in an environment-neutral barrel back into a silent
   * external. With it off, a stray `node:crypto` or `node:fs` stays unresolvable
   * and the build stops. It is also what a review greps for: `dist/index.js`
   * must contain no `node:` specifier at all.
   */
  removeNodeProtocol: false,

  /**
   * Chained through the tree-shaking pass below, so the maps in `dist/` point at
   * the TypeScript sources rather than at the intermediate bundle — the
   * difference between a readable and an unreadable stack frame when a panel
   * specification is rejected deep inside a nested node schema. One cosmetic
   * consequence of that pass is worth knowing before it looks like a defect: it
   * re-appends its own `sourceMappingURL` comment to a chunk that already
   * carries an identical one, so each emitted file ends with the same comment
   * twice. Both name the same file and the last one wins in every consumer.
   */
  sourcemap: true,

  /**
   * `dist/` is wiped before each build, so a file left behind by an earlier
   * layout — a renamed entry, a removed module — can never masquerade as a
   * current artefact for a consumer resolving through the `exports` map. Nothing
   * else writes into this package's `dist/` (unlike `packages/telemetry`, whose
   * two esbuild steps share one directory with tsup), so cleaning is
   * unconditionally safe here.
   */
  clean: true,

  /**
   * No shared chunks. Chunk names are content-addressed, so splitting would put
   * files in `dist/` whose names the `exports` map does not state, and with a
   * single entry there is nothing to share them with in any case.
   */
  splitting: false,

  /**
   * Library output must stay readable: a rejected model output is diagnosed from
   * a Zod issue path plus a stack frame inside this bundle, in the service's log
   * and in the DevTools panel's fallback banner, and minified schema code makes
   * both useless. The bundle is small and is never shipped over a network.
   */
  minify: false,

  /**
   * Stated rather than inherited, matching both sibling library builds. It is
   * `sideEffects: false` in `package.json` that lets a consumer shake the node
   * schemas it does not use; this pass only drops what is unreachable from the
   * barrel within this package, which is safe because every module in `src/**`
   * is pure schema and data with no import-time side effect.
   */
  treeshake: true,

  /**
   * Resolved relative to this file, so both the transform and the declaration
   * program above read this workspace's own `tsconfig.json` — NodeNext module
   * resolution, `rootDir: "src"`, the ES2023-only `lib` set that keeps browser
   * APIs out — rather than whatever config happens to sit above the process's
   * working directory.
   */
  tsconfig: './tsconfig.json',

  /**
   * tsup keeps `dependencies` and `peerDependencies` external by default; the
   * three entries of this package's `dependencies` are restated here so the
   * intent survives a refactor, and each has its own reason to stay a bare
   * specifier in the emitted bundle:
   *
   * - `zod` must be one instance in the consuming process. The local service
   *   validates a model's output against the authoring schema from this package
   *   and then hands the parsed value to `@debuggen/protocol`'s message schemas;
   *   a second copy of zod bundled in here would give those two layers separate
   *   registries of Zod internals, so `instanceof`-style checks and error shapes
   *   would diverge and a valid panel could be rejected at the message boundary.
   * - `@debuggen/shared` must stay a live workspace link so its own `exports`
   *   conditions apply at the consumer — the browser-safe `"."` entry for page
   *   code, `"./node"` for the service. This package uses only the former (the
   *   single `SourceLocation` schema, reused rather than restated), and inlining
   *   it would freeze one choice for everybody and hide the layering AAP 0.2.2
   *   defines.
   * - `@debuggen/telemetry` owns the event kinds, the kind-specific attribute
   *   keys and the fixed metric-id set that the catalog and the data-query
   *   schema build on. Inlining it would duplicate those tables, so a capture
   *   validated by the service and a panel validated in the page could disagree
   *   about which kinds and metrics exist.
   *
   * Node builtins need no entry: `platform: 'neutral'` above gives esbuild no
   * builtin list, which is the point — an accidental builtin import must fail,
   * not be externalised. No `banner`, `footer`, `shims`, `define` or `env` is
   * declared either: nothing in this output may vary with a clock, a build
   * counter or an ambient variable, so two builds of one commit produce
   * byte-identical artefacts.
   */
  external: ['zod', '@debuggen/shared', '@debuggen/telemetry'],
});
