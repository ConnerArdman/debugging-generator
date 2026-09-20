/**
 * Build configuration for `@debuggen/protocol`.
 *
 * This package is the single cross-process contract layer (AAP 0.4.2): the
 * WebSocket message envelope (`envelope.ts`), every message payload schema
 * (`messages/**`), the HTTP route constants with their request and response
 * schemas (`http.ts`), the session record (`session-record.ts`), the analysis
 * result (`analysis.ts`), the protocol version (`version.ts`) and the transport
 * client SDK (`client/{ws-client,http-client}.ts`).
 *
 * Three separate surfaces compile against the artefact this file emits, and
 * against nothing else in the package, because AAP 0.4.2 holds both extensions
 * to importing `@debuggen/protocol` only and never service internals:
 *
 *   - `apps/local-service`   real Node 24 ESM, loaded from disk;
 *   - `apps/vscode-extension` an esbuild CommonJS extension-host bundle plus a
 *                             Vite-built React webview;
 *   - `apps/chrome-extension` an MV3 module service worker plus the DevTools
 *                             panel, both bundled by Vite/Rollup.
 *
 * There is therefore exactly one job here: emit — deterministically, on a clean
 * clone, with nothing else having run first — the two paths that `package.json`
 * `exports` advertises for its only condition, `"."`:
 *
 *   dist/index.js        dist/index.d.ts
 *
 * with `dist/index.js.map` beside them. A drift between those paths and this
 * configuration does not fail here; it fails later, in three different
 * toolchains at once, as an unresolvable `@debuggen/protocol` import in the
 * service's own tsup build, in the extension host's esbuild bundle and in the
 * panel's and the webview's Vite builds. The `exports` map, the `entry` key
 * below and the `src/index.ts` barrel are one contract written in three files,
 * which is why every option is stated explicitly rather than left to a tsup
 * default that a future version could change.
 *
 * ## Why one entry
 *
 * `@debuggen/shared` splits a browser-safe root entry from a `./node` entry,
 * and `@debuggen/telemetry` adds a `./node/register` preload plus an IIFE agent
 * built by two sibling esbuild scripts; AAP 0.2.2 assigns secondary entries to
 * those two packages and to no others. This package has a single public
 * surface, and it is deliberately reachable in one way only: everything a
 * consumer needs — the discriminated message union and `parseMessage`, the HTTP
 * route constants and their schemas, `SessionRecord`, `AnalysisResult`,
 * `ReconnectingWsClient` and `HttpClient` — must be re-exported from
 * `src/index.ts`, because nothing else in the package is reachable through the
 * one export condition. A second entry would be a change to the `exports` map
 * and to AAP 0.2.5, not an edit here.
 *
 * ## Why the tests cannot reach `dist/`
 *
 * `src/__tests__/{envelope,messages,http}.test.ts` (AAP 0.8.3) live inside
 * `src/`, so the Vitest project `protocol` collects them and the workspace
 * `tsconfig.json` type-checks them. They stay out of the shipped graph
 * structurally rather than by an ignore rule: the single entry below is
 * `src/index.ts`, tsup follows imports from there, and the barrel re-exports
 * library modules only — so no test file, and no `vitest` specifier, is ever
 * reachable. A post-build grep for `vitest` in `dist/index.js` and
 * `dist/index.d.ts` is the standing check that the barrel kept that promise.
 *
 * ## Relationship to `tsc -b`
 *
 * `tsconfig.json` is `composite` and `emitDeclarationOnly` and writes into
 * `packages/protocol/.tsbuild`: that is the `pnpm typecheck` gate, not a build.
 * Shipping artefacts come from this file and land in `dist/`, which
 * `.gitignore` and `.prettierignore` both exclude, so the output is regenerated
 * from source on every CI run and never committed. Because the four workspace
 * dependencies are resolved through their own `exports` maps — that is, through
 * their `dist/` — `pnpm build` must run in topological order: `shared`, then
 * `telemetry`, then `instrumentation` and `panel-schema`, then this package.
 * `pnpm -r build` guarantees exactly that from the `dependencies` field, and it
 * is also why `pnpm verify` runs `pnpm build` before `pnpm typecheck`.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  /**
   * The object form is load-bearing, exactly as in `packages/shared`,
   * `packages/telemetry` and `packages/panel-schema`: tsup derives the output
   * path from the key, so this key *is* `dist/index.js` with `dist/index.d.ts`
   * beside it — byte for byte the paths the sibling `package.json` `exports`
   * block names for its `"."` condition, and the same two paths its `main` and
   * `types` fields name for any resolver that ignores `exports`. The array form
   * would instead infer paths by stripping the longest common directory of the
   * inputs, which agrees for one entry today and would silently disagree the
   * moment the entry list changed — a drift the `exports` map cannot absorb, and
   * one that surfaces at the consumer as a module-not-found rather than here.
   *
   * One entry, and only this one: this package has no secondary export
   * condition to satisfy.
   */
  entry: {
    index: 'src/index.ts',
  },

  outDir: 'dist',

  /**
   * ESM only: `package.json` declares `"type": "module"` and the `"."` condition
   * offers a single `import` target. Every consumer is ESM or is bundled by a
   * bundler that prefers ESM — including the one CommonJS artefact in the
   * repository, the VS Code extension host, which esbuild produces from its own
   * sources and which therefore consumes this ESM bundle as an input rather than
   * requiring a CJS build of it. A second format would double the build time to
   * ship dead bytes behind an `exports` condition nobody reads.
   */
  format: ['esm'],

  /**
   * Matches `target: "ES2023"` in `tsconfig.base.json`. Node 24.21.0 and Chrome
   * 153 both implement ES2023 in full, so nothing is downlevelled and the
   * emitted JavaScript stays close to the authored source — which keeps the
   * sourcemaps below readable and, more importantly, keeps a Zod schema's
   * structure recognisable when a rejected message is being read in anger.
   */
  target: 'es2023',

  /**
   * The load-bearing option of this file, and the reason it follows
   * `packages/panel-schema` rather than `packages/instrumentation`. Do not relax
   * it to `'node'`.
   *
   * This bundle is loaded by a Node process *and* by three page-side bundles:
   * the MV3 service worker, the DevTools panel and the VS Code webview. Under
   * tsup's default `platform: 'node'`, esbuild has a builtin list to fall back
   * on, so a `node:*` import that crept into `src/**`, or an
   * `import WebSocket from 'ws'` in `src/client/ws-client.ts` written for the
   * convenience of the Node consumers, would be quietly externalised and shipped
   * inside this barrel. The breakage would then appear far from its cause: an
   * unresolved builtin in the panel's Vite build, or a runtime explosion in the
   * page. `neutral` removes that escape hatch — esbuild has no builtin list left
   * to fall back on — and both cases were checked against this configuration:
   * `import 'node:crypto'` in the entry fails with `Could not resolve
   * "node:crypto"` (and TS2882 from the declaration program, because
   * `tsconfig.json` declares no ambient `types`), and `import 'ws'` fails with
   * `Could not resolve "ws"` because `ws` is not a dependency of this package
   * and so is not external either.
   *
   * What this option does *not* catch, and must not be assumed to: a subpath of
   * a package that is already external — `@debuggen/shared/node`, the SHA-256
   * and safe-filesystem entry built over `node:crypto` and `node:fs` — is
   * externalised with its parent and passes this build. That boundary is held
   * structurally instead, and the authors of `src/**` own it:
   *
   * - nothing in this package imports `@debuggen/shared/node`; only the
   *   browser-safe `"."` entry is used, which is why the `external` list below
   *   names the package and not that subpath.
   * - `src/client/ws-client.ts` accepts an *injected* WebSocket constructor
   *   typed by this package's own minimal structural interface, so the service
   *   passes `ws`, the service worker and the webview pass the platform global,
   *   and neither dependency is named here.
   * - `src/client/http-client.ts` uses the web-standard `fetch`, `Headers` and
   *   `AbortController`, all of which exist in Node 24 and in every supported
   *   browser, rather than a Node HTTP client.
   *
   * Neutral also empties esbuild's `mainFields`/`conditions` defaults, which is
   * harmless here because every third-party specifier stays external (see
   * `external` below), so this build resolves nothing but relative paths inside
   * `src/`.
   */
  platform: 'neutral',

  /**
   * Declarations are the product of this package as much as the JavaScript is.
   * `dist/index.d.ts` is the only place the three surfaces can learn the shape
   * of a message: the envelope, the discriminated union over `type`, the HTTP
   * request and response schemas, `SessionRecord`, `AnalysisResult` and the two
   * client classes. The runtime values must stay in `dist/index.js` beside them —
   * `parseMessage`, the Zod schemas and the clients are called, not merely typed
   * — so the declaration step accompanies the JavaScript entry, it never
   * replaces it.
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
   *   `dist/` free of a stray `.tsbuildinfo`. It does not weaken the four
   *   project references either: each dependency's `dist/index.d.ts` is resolved
   *   through the pnpm workspace link and that package's `exports` map, exactly
   *   as the runtime resolves it.
   * - `ignoreDeprecations` answers tsup 8.5.1 setting `baseUrl` on that program
   *   unconditionally (`baseUrl: compilerOptions.baseUrl || '.'`) — a value this
   *   repository deliberately never declares, because the four workspace
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
   * `exactOptionalPropertyTypes`, the empty `types` array and the NodeNext
   * resolution that makes the `.js`-suffixed relative specifiers in `src/**`
   * type-check — so the declarations emitted here are the ones the typecheck gate
   * would emit.
   */
  dts: {
    compilerOptions: {
      composite: false,
      incremental: false,
      ignoreDeprecations: '6.0',
    },
  },

  /**
   * Switched off for the same reason every sibling switches it off, and here it
   * is what keeps the `platform: 'neutral'` guarantee above honest. tsup 8.5.1
   * implements `removeNodeProtocol: true` (still the default; its own
   * documentation calls that temporary and says it flips in the next major) as a
   * resolve plugin that rewrites `node:x` to `x` *and* marks it external — which
   * would swallow precisely the failure neutral exists to raise, turning a
   * Node-only import in an environment-neutral contract layer back into a silent
   * external that three page bundles then inherit. With it off, a stray
   * `node:crypto` stays unresolvable and the build stops. It is also what a
   * review greps for: `dist/index.js` must contain no `node:` specifier at all.
   */
  removeNodeProtocol: false,

  /**
   * Chained through the tree-shaking pass below, so the maps in `dist/` point at
   * the TypeScript sources rather than at the intermediate bundle — the
   * difference between a readable and an unreadable stack frame when a message
   * is rejected deep inside a nested payload schema, which is the one diagnostic
   * every process boundary in this product shares. One cosmetic consequence of
   * that pass is worth knowing before it looks like a defect: it re-appends its
   * own `sourceMappingURL` comment to a chunk that already carries an identical
   * one, so each emitted file ends with the same comment twice. Both name the
   * same file and the last one wins in every consumer.
   */
  sourcemap: true,

  /**
   * `dist/` is wiped before each build, so a file left behind by an earlier
   * layout — a renamed entry, a removed module — can never masquerade as a
   * current artefact for a consumer resolving through the `exports` map.
   * Cleaning is unconditionally safe here precisely because this package has a
   * single build step (`"build": "tsup"`): unlike `packages/telemetry`, whose
   * tsup run must precede two esbuild steps that write the agent and the preload
   * into the same `dist/`, nothing else writes into this directory.
   */
  clean: true,

  /**
   * No shared chunks. Chunk names are content-addressed, so splitting would put
   * files in `dist/` whose names the `exports` map does not state — and with a
   * single entry there is nothing to share them with in any case.
   */
  splitting: false,

  /**
   * Library output must stay readable. A rejected envelope is diagnosed from a
   * Zod issue path plus a stack frame inside this bundle, and that diagnosis
   * happens in the service's pino log, in the DevTools panel's connection status
   * and in the VS Code output channel alike; minified schema code makes all
   * three useless. The bundle is small and is never shipped over a network.
   */
  minify: false,

  /**
   * Stated rather than inherited, matching every sibling library build. It is
   * `sideEffects: false` in `package.json` that lets a consumer shake the
   * message modules it does not use — the DevTools panel never touches the
   * dev-server routes, and the webview never touches the ingest route; this pass
   * only drops what is unreachable from the barrel within this package, which is
   * safe because every module in `src/**` is pure schema, inferred types and two
   * classes with no import-time side effect.
   */
  treeshake: true,

  /**
   * Resolved relative to this file, so both the transform and the declaration
   * program above read this workspace's own `tsconfig.json` — NodeNext module
   * resolution, `rootDir: "src"`, the `ES2023`+`DOM` lib set that types the
   * client SDK's web-standard globals, and the empty `types` array that keeps
   * Node ambients out — rather than whatever config happens to sit above the
   * process's working directory.
   */
  tsconfig: './tsconfig.json',

  /**
   * Every runtime `dependency` of `package.json`, stated explicitly as
   * `packages/panel-schema`, `packages/instrumentation` and
   * `packages/code-analysis` state theirs. tsup keeps `dependencies` and
   * `peerDependencies` external by default, but that default is not a guarantee
   * this package can rely on: it is read from the manifest at build time, so a
   * dependency moved between fields — or a future default — would silently start
   * inlining code that must not be inlined. Each entry has its own reason to
   * survive as a bare specifier:
   *
   * - `@debuggen/instrumentation` owns the `InstrumentationPlan`,
   *   `InstrumentationAction` and `ModificationRecord` shapes carried by
   *   `instrumentation.plan`, `instrumentation.ready` and `cleanup.completed`.
   *   Keeping it external is what lets Rollup and Vite in the two extension
   *   builds tree-shake that package's ts-morph-backed patch layer away: its
   *   schema modules are Node-free, the package declares `sideEffects: false`,
   *   and the panel imports the plan *types* without ever reaching the patcher.
   *   Inlining it here would fuse both halves into this barrel and hand a
   *   browser bundle a vendored TypeScript compiler.
   * - `@debuggen/panel-schema` owns the `PanelSpec` and `DataQuery` types
   *   carried by `panel.generated` and by the panel-data request body. The
   *   service validates a specification against that package's schemas and then
   *   sends it through the message schemas here; a private copy at this level
   *   would let the two layers disagree about what a valid panel is.
   * - `@debuggen/telemetry` owns the one `TelemetryEventIngress` /
   *   `TelemetryEvent` definition that `telemetry.event`, `telemetry.tail` and
   *   the capture messages embed, plus the aggregate result shapes the
   *   panel-data route returns. It must stay the same module the browser agent,
   *   the Node preload and the service already load.
   * - `@debuggen/shared` must stay a live workspace link so its own `exports`
   *   conditions apply at the consumer — the browser-safe `"."` entry for page
   *   code, `"./node"` for the service. This package uses only the former: the
   *   single `SourceLocation` schema that `source.open` and every located
   *   runtime item carry, the id helpers and `DebuggenError`, whose
   *   cross-bundle `instanceof` substitute compares a string brand that only one
   *   shared instance can supply.
   * - `zod` must be one instance in the consuming process. This is the sharpest
   *   case in the repository: the service parses a model's output against
   *   `@debuggen/panel-schema`, hands the parsed value to a message schema here,
   *   and the panel re-validates the envelope on arrival. A second copy bundled
   *   in here would give those layers separate registries of Zod internals, so
   *   `instanceof`-style schema identity and error shapes would diverge and a
   *   valid message could be rejected at the boundary — and it would double the
   *   payload of all three browser bundles for the privilege.
   *
   * Node builtins need no entry: `platform: 'neutral'` above gives esbuild no
   * builtin list, which is the point — an accidental builtin import must fail,
   * not be externalised. No `banner`, `footer`, `shims`, `noExternal`, `define`
   * or `env` is declared either: nothing in this output may vary with a clock, a
   * build counter or an ambient variable, so two builds of one commit produce
   * byte-identical artefacts.
   */
  external: [
    '@debuggen/instrumentation',
    '@debuggen/panel-schema',
    '@debuggen/shared',
    '@debuggen/telemetry',
    'zod',
  ],
});
