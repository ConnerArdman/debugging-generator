/**
 * Build configuration for the **library entry** of `@debuggen/telemetry`.
 *
 * This package is the evidence layer of the product (AAP 0.2.2): it owns the one
 * `TelemetryEvent` definition, the redaction rules, the trace correlator and the
 * capture aggregates, plus two runtime-specific artefacts — the page-injected
 * browser agent and the dev-server Node preload. Three build steps, run in the
 * order `package.json` states, produce those artefacts:
 *
 *   tsup (this file)      -> dist/index.js  dist/index.js.map  dist/index.d.ts
 *   node esbuild.agent.mjs -> dist/browser-agent.iife.js   (IIFE, page, MAIN world)
 *   node esbuild.node.mjs  -> dist/node/register.mjs        (Node --import preload)
 *
 * Only the first line is this file's responsibility, and it is exactly the `"."`
 * condition of the `exports` map (`types: ./dist/index.d.ts`,
 * `import: ./dist/index.js`). The `"./node/register"` condition is
 * `esbuild.node.mjs`'s, and the agent bundle is not exported at all — it is
 * copied verbatim into `apps/chrome-extension/public/agent.iife.js` by
 * `scripts/copy-agent.mjs`.
 *
 * ## Why the two esbuild artefacts are not entries here
 *
 * They are not "more of the same bundle with different names". The agent must be
 * a single self-contained IIFE with `bippy` and the redaction primitives inlined
 * (nothing can be resolved from a page at `document_start`); the preload must be
 * a `.mjs` side-effecting module that keeps the OpenTelemetry SDK and the Prisma
 * and pg instrumentations external so it patches the *same* module instances the
 * developer's `next dev` process loaded. Adding either to `entry` below would
 * emit a third, wrongly-shaped copy under a name the `exports` map does not
 * advertise — and `sideEffects` in `package.json` only marks
 * `./dist/node/register.mjs`, so a tsup-emitted preload would additionally be
 * tree-shaken away by consumers.
 *
 * ## `clean: true` and a shared `dist/`
 *
 * All three steps write into one `dist/`, and only this one cleans it. That is
 * safe solely because `"build": "tsup && node esbuild.agent.mjs && node
 * esbuild.node.mjs"` runs tsup first. Reversing or parallelising that script
 * would delete `dist/browser-agent.iife.js` and `dist/node/register.mjs` after
 * they were built, and the failure would surface far from here: a Chrome
 * extension whose content script is missing, and a `next dev` launch whose
 * `--import` target does not exist. The guard is the script order plus the
 * post-build check that both files still exist.
 *
 * ## Relationship to `tsc -b`
 *
 * `tsconfig.json` is `composite` and `emitDeclarationOnly` and writes into
 * `packages/telemetry/.tsbuild`: that is the `pnpm typecheck` gate, not a build.
 * Shipping artefacts come from this file and land in `dist/`, which `.gitignore`
 * and `.prettierignore` both exclude, so the output is regenerated from source
 * on every CI run and never committed.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  /**
   * The object form is load-bearing, exactly as in `packages/shared`: tsup
   * derives the output path from the key, so this key *is* `dist/index.js` with
   * `dist/index.d.ts` beside it. The array form infers paths by stripping the
   * longest common directory of the inputs, which agrees today and would
   * silently disagree the moment the entry list changed — a drift the `exports`
   * map cannot absorb.
   *
   * One entry, and only this one. `src/node/register.ts` and everything under
   * `src/browser/**` belong to the sibling esbuild scripts (see the header).
   */
  entry: {
    index: 'src/index.ts',
  },

  outDir: 'dist',

  /**
   * ESM only: `package.json` declares `"type": "module"` and the `"."` condition
   * offers a single `import` target. Every consumer of this entry —
   * `apps/local-service`, `packages/instrumentation`, `packages/panel-schema`,
   * `packages/panel-renderer`, `packages/protocol` and the DevTools panel — is
   * ESM or is bundled by a bundler that prefers ESM, so a CJS output would be
   * dead bytes and a second `exports` condition nobody reads.
   */
  format: ['esm'],

  /**
   * Matches `target: "ES2023"` in `tsconfig.base.json`. Node 24.21.0 and Chrome
   * 153 both implement ES2023 in full, so nothing is downlevelled and the
   * emitted JavaScript stays close to the authored source, which keeps the
   * sourcemaps readable.
   */
  target: 'es2023',

  /**
   * Deliberate and load-bearing — this is the one option where this file
   * diverges from `packages/shared/tsup.config.ts`.
   *
   * The `"."` entry is consumed from both runtimes: `apps/local-service` imports
   * the correlator, the aggregates and the redactor in Node, while
   * `packages/panel-renderer` and `apps/chrome-extension` import the event and
   * aggregate types — and may pull a runtime helper such as a formatter — into a
   * page bundle. Under tsup's default `platform: 'node'`, a `node:*` import that
   * crept into `src/schema/**`, `src/redaction/**`, `src/correlation/**` or
   * `src/aggregate/**` would be quietly externalised and ship inside this
   * barrel, and the breakage would appear only later as an unresolved builtin in
   * the DevTools panel's Vite build or as a runtime explosion in the page.
   * `platform: 'neutral'` removes that escape hatch: esbuild has no Node builtin
   * list to fall back on, so such an import fails this build loudly instead.
   *
   * Two consequences the authors of `src/**` must honour for that to hold:
   *
   * - `src/redaction/request-key.ts` computes its HMAC-SHA256 with WebCrypto
   *   (`globalThis.crypto.subtle`, present in Node 24 and in every supported
   *   browser), never with `node:crypto`.
   * - `src/index.ts` re-exports nothing from `src/node/**` or `src/browser/**`.
   *   Those subtrees are the preload and the agent; their runtime-specific code
   *   reaches its consumers through the two esbuild artefacts, not through this
   *   barrel.
   *
   * Neutral also empties esbuild's `mainFields`/`conditions` defaults, which is
   * harmless here: every third-party specifier stays external (see the closing
   * note), so this build resolves nothing but relative paths inside `src/`.
   */
  platform: 'neutral',

  /**
   * Declarations are non-negotiable: `dist/index.d.ts` is what every workspace
   * above this one type-checks against, including the single `TelemetryEvent` /
   * `TelemetryEventIngress` definition that `packages/protocol` embeds in its
   * message schemas.
   *
   * The three overrides are required, not defensive. tsup's declaration step
   * builds its own TypeScript program from the `tsconfig` named at the bottom of
   * this file and then layers its own options on top:
   *
   * - `composite` / `incremental` are inherited (the root solution file
   *   references this project for `tsc -b`). A composite program must list every
   *   input, while tsup's program is seeded with one entry file and follows
   *   imports, so the barrel's own re-exports are reported as "not listed within
   *   the file list of project" (TS6307). The options also bind the program to
   *   the build stamp and declaration directory of the typecheck gate
   *   (`.tsbuild/`), which is not where this build writes. Disabling them for
   *   the declaration program alone leaves the gate untouched — and it does not
   *   weaken the reference to `packages/shared`, whose `dist/index.d.ts` is
   *   resolved through the pnpm workspace link and that package's `exports` map
   *   exactly as the runtime resolves it.
   * - `ignoreDeprecations` answers tsup 8.5.1 setting `baseUrl` on that program
   *   unconditionally (`baseUrl: compilerOptions.baseUrl || '.'`) — a value this
   *   repository deliberately never declares. TypeScript 6.0.3 raises `baseUrl`
   *   from a deprecation warning to the hard error TS5101 and names
   *   `"ignoreDeprecations": "6.0"` as the acknowledgement. Nothing in the
   *   repository can stop tsup from injecting it, so the acknowledgement is the
   *   fix; it is scoped to this one program and falls away when tsup stops.
   *
   * Everything else is still inherited — `strict`, `noUncheckedIndexedAccess`,
   * `verbatimModuleSyntax`, `exactOptionalPropertyTypes` and the NodeNext
   * resolution that makes the `.js`-suffixed relative specifiers in `src/**`
   * type-check — so these declarations are the ones the gate would emit.
   */
  dts: {
    compilerOptions: {
      composite: false,
      incremental: false,
      ignoreDeprecations: '6.0',
    },
  },

  /**
   * Switched off for the same reason `packages/shared` switches it off, and here
   * it also keeps the `platform: 'neutral'` guarantee above honest. tsup 8.5.1
   * implements `removeNodeProtocol: true` (still the default; its own docs call
   * that temporary) as a resolve plugin that rewrites `node:x` to `x` *and*
   * marks it external — which would swallow precisely the failure neutral is
   * here to raise, turning a Node-only import in the browser-safe barrel back
   * into a silent external. With it off, `node:crypto` stays unresolvable and
   * the build stops.
   */
  removeNodeProtocol: false,

  /**
   * Chained through the tree-shaking pass below, so the maps point at the
   * TypeScript sources rather than at the intermediate bundle. One cosmetic
   * consequence: that pass re-appends its own `sourceMappingURL` comment to a
   * chunk that already carries an identical one, so each emitted file ends with
   * the same comment twice. Both name the same file and the last one wins in
   * every consumer.
   */
  sourcemap: true,

  /**
   * `dist/` is wiped before the library bundle is written, so an artefact left
   * behind by an earlier layout can never masquerade as a current one for a
   * consumer resolving through the `exports` map. Read the header's note on the
   * `build` script order before changing this: the two esbuild artefacts share
   * this directory and are produced after this step precisely because of it.
   */
  clean: true,

  /**
   * No shared chunks. Chunk names are content-addressed, so splitting would put
   * files in `dist/` whose names the `exports` map does not state — and this
   * package's `dist/` is shared with two esbuild outputs, so an unexpected file
   * there is also an ambiguity for the post-build existence check. With a single
   * entry there is nothing to share anyway.
   */
  splitting: false,

  treeshake: true,

  /**
   * Resolved relative to this file, so both the transform and the declaration
   * program above read this workspace's own `tsconfig.json` — NodeNext
   * resolution, `rootDir: "src"`, the `ES2023`+`DOM` lib set that lets one
   * program type both runtimes — rather than whatever config happens to sit
   * above the process's working directory.
   */
  tsconfig: './tsconfig.json',

  /**
   * Externals are left to tsup's default, which keeps every `dependencies` and
   * `peerDependencies` entry external, and nothing here overrides it with
   * `noExternal`:
   *
   * - `@debuggen/shared` must stay a live workspace link so that its own
   *   `exports` conditions apply at the consumer — the browser-safe `"."` entry
   *   for page code, `"./node"` for the service. Inlining it would freeze one
   *   choice for everybody and hide the layering the AAP's edge list defines.
   * - `zod` is the schema library of six workspaces; two copies would mean two
   *   registries of Zod internals and `instanceof` checks that disagree.
   * - The OpenTelemetry family, `@prisma/instrumentation` and `bippy` are the
   *   preload's and the agent's dependencies. They must not be dragged into the
   *   barrel at all: the two esbuild scripts decide, per artefact, what to
   *   inline (the agent) and what to leave to the host process (the preload).
   *
   * No banner, footer, `define` or `env` is declared either: nothing in this
   * output may vary with a clock, a build counter or an ambient variable, so two
   * builds of one commit produce byte-identical artefacts.
   */
});
