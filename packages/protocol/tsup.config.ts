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
 * Three separate surfaces load or bundle the artefact this file emits, and
 * nothing else in the package, because both extensions import
 * `@debuggen/protocol` only, never service internals:
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
 * dependencies' runtime conditions resolve into their own `dist/`, which the
 * browser-bundle check below bundles, `pnpm build` must run in topological
 * order: `shared`, then `telemetry`, then `instrumentation` and `panel-schema`,
 * then this package. `pnpm -r build` guarantees exactly that from the
 * `dependencies` field.
 *
 * ## The browser-bundle check
 *
 * `platform: 'neutral'` below proves this package's *own* modules name no
 * builtin, but every dependency is external, so it cannot see what a dependency
 * imports in turn — and the three page-side consumers bundle those dependencies
 * too. The `onSuccess` hook at the bottom of this file closes that gap on the
 * artefact itself: after every build it bundles the freshly written
 * `dist/index.js` for `platform: 'browser'`, resolving each dependency through
 * its `exports` map exactly as the extensions' bundlers will, and fails the
 * build — naming every specifier that did not resolve and the module that
 * imported it — when anything in the transitive graph is Node-only. That is how
 * a `@debuggen/instrumentation` root import (whose graph reaches `node:fs`,
 * `node:os`, `node:path` and `node:crypto` through `@debuggen/code-analysis` and
 * `@debuggen/shared/node`) or a `@debuggen/shared/node` import fails here, in
 * this package's build, instead of in an extension's.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build as bundle } from 'esbuild';
import type { Message } from 'esbuild';
import { defineConfig } from 'tsup';

/**
 * Absolute path of this workspace, derived from this module's own URL rather
 * than from `process.cwd()` — the same derivation `apps/local-service`'s build
 * uses, which tsup's config loader preserves (it rewrites `import.meta.url` in
 * the transpiled config to the original file's URL). The check therefore reads
 * this package's `dist/index.js` however tsup was started, while `entry` and
 * `tsconfig` below keep tsup's own convention of resolving against the process
 * working directory, which `pnpm --filter @debuggen/protocol build` and
 * `pnpm -r build` both set to this workspace.
 */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The repository root, used as esbuild's working directory so every path in a
 * failure report reads repository-relative (`packages/code-analysis/dist/…`).
 * This file sits at `packages/protocol/`, two levels below it.
 */
const REPOSITORY_ROOT = path.resolve(PACKAGE_DIR, '..', '..');

/** The artefact the check bundles: the `"."` entry this build just wrote. */
const BUILT_ENTRY = path.join(PACKAGE_DIR, 'dist', 'index.js');

/**
 * What to do about a failed check, printed with every failure so the message is
 * self-diagnosing in a CI log.
 */
const BROWSER_BUNDLE_HINT = [
  '@debuggen/protocol is bundled into the Chrome MV3 service worker, the DevTools panel and',
  'the VS Code webview, so nothing reachable from dist/index.js may be Node-only (AAP 0.2.2).',
  'Trace each importer named above back to the specifier in packages/protocol/src that',
  'reaches it. The usual causes: importing the @debuggen/instrumentation root instead of',
  '@debuggen/instrumentation/schema; importing @debuggen/shared/node, a node:* builtin or',
  'ws; or a schema module of a dependency starting to import a Node-only module. Fix the',
  'import - never externalise the specifier here, which would only move the failure into',
  'an extension build.',
].join('\n');

/**
 * Failure of the browser-bundle check. A distinct class so the message tsup
 * prints is attributable at a glance: a throw from a function `onSuccess`
 * propagates through tsup 8.5.1's `buildAll()` to the CLI's error handler, which
 * logs it and exits non-zero — which is what fails `pnpm build`, and with it
 * `pnpm verify` and CI.
 *
 * `stack` is replaced with the name and message alone, deliberately: the
 * message already names every unresolved specifier and its importer, and the
 * default stack would bury that under frames from tsup's plumbing in a
 * transpiled copy of this file. A missing `dist/index.js` is reported the same
 * way, as an unresolvable entry with no importer; an error that is not a
 * bundling failure at all — an esbuild service crash — is rethrown untouched
 * and keeps its full stack.
 */
class BrowserBundleError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${BROWSER_BUNDLE_HINT}`);
    this.name = 'BrowserBundleError';
    this.stack = `${this.name}: ${this.message}`;
  }
}

/**
 * Whether a thrown value is esbuild's `BuildFailure`, which carries the build's
 * error messages. Checked structurally because esbuild's error class is not
 * exported as a value.
 *
 * @param error The value `build()` rejected with.
 * @returns `true` when it carries a non-empty `errors` array.
 */
function isBuildFailure(error: unknown): error is { errors: Message[] } {
  if (typeof error !== 'object' || error === null || !('errors' in error)) {
    return false;
  }

  const { errors } = error as { errors: unknown };
  return Array.isArray(errors) && errors.length > 0;
}

/**
 * One esbuild error as a report line: what failed, and where. For an
 * unresolved import esbuild's text names the specifier (`Could not resolve
 * "node:fs"`) and its location is the importing module, so the line reads as
 * "specifier ← importer".
 *
 * @param message One entry of the failure's `errors`.
 * @returns A single indented line.
 */
function describeBundleError(message: Message): string {
  const importer =
    message.location === null
      ? 'an unknown module'
      : `${message.location.file}:${String(message.location.line)}:${String(message.location.column)}`;

  return `  - ${message.text}, imported by ${importer}`;
}

/**
 * Bundles `dist/index.js` for a browser target and fails the build if it
 * cannot be bundled.
 *
 * Runs as tsup's `onSuccess` hook, which tsup 8.5.1 invokes after `clean` and
 * after esbuild has written the JavaScript (clean -> esbuild -> copy public dir
 * -> onSuccess), so the file it reads is the one this build produced. Nothing
 * is written: `write: false` keeps the bundle in memory, and `dist/` stays
 * exactly the artefacts documented above.
 *
 * The options mirror what a page-side bundler does with this package:
 * `platform: 'browser'` gives esbuild no builtin to fall back on and selects the
 * `browser`/`import`/`default` export conditions, and nothing is marked
 * external, so every `@debuggen/*` and `zod` import resolves through the pnpm
 * workspace links and the owning package's `exports` map into its built
 * `dist/`. That is why `pnpm -r build` order matters here as it does for the
 * declarations: a dependency that has not been built fails the check as an
 * unresolvable entry, which is a real failure of the tree, not a false alarm.
 */
async function assertBrowserBundle(): Promise<void> {
  try {
    await bundle({
      absWorkingDir: REPOSITORY_ROOT,
      entryPoints: [BUILT_ENTRY],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });
  } catch (error) {
    if (!isBuildFailure(error)) {
      throw error;
    }

    throw new BrowserBundleError(
      `packages/protocol/dist/index.js does not bundle for a browser target ` +
        `(${String(error.errors.length)} error(s)):\n` +
        error.errors.map(describeBundleError).join('\n'),
    );
  }
}

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
   * externalised with its parent and passes the main build, and so does any
   * Node-only module an external dependency imports in turn. Both are caught one
   * step later, by the browser-bundle check the `onSuccess` hook runs over
   * `dist/index.js` (see the header), and both are held structurally by the
   * authors of `src/**`:
   *
   * - nothing in this package imports `@debuggen/shared/node`; only the
   *   browser-safe `"."` entry is used, which is why the `external` list below
   *   names the package and not that subpath.
   * - nothing in this package imports the `@debuggen/instrumentation` root; only
   *   its browser-safe `./schema` entry is used, because the root bundles the
   *   ts-morph and `node:fs` patch layer.
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
   * `dist/index.d.ts` is where a packed tarball carries the shape of a message:
   * the envelope, the discriminated union over `type`, the HTTP request and
   * response schemas, `SessionRecord`, `AnalysisResult` and the two client
   * classes. Inside the repository the three surfaces read the same shapes from
   * this project's `.tsbuild` declarations (root tsconfig.json,
   * `"// no-aliases"`). The runtime values must stay in `dist/index.js` beside them —
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
   *   `dist/` free of a stray `.tsbuildinfo`. The program still resolves each of
   *   the four workspace dependencies through the pnpm workspace link and its
   *   `exports` map, whose source-first `types` entry supplies current source,
   *   and the emitted declarations keep those imports external.
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
   *   `src/**` imports it only as `@debuggen/instrumentation/schema`, the entry
   *   that holds the Node-free schema layer and none of the ts-morph-backed
   *   patch layer. This one entry covers that subpath as well — tsup's external
   *   matcher accepts `id === name` or `id.startsWith(name + '/')` — so
   *   `dist/index.js` keeps the bare `@debuggen/instrumentation/schema`
   *   specifier. Keeping it external is what keeps one instance of each schema
   *   in the local service, which loads the root entry directly and this
   *   subpath through here: both resolve to the same shared chunk of that
   *   package's build. Inlining it would give this barrel a private copy whose
   *   schemas no longer share identity with the ones the service validates
   *   with.
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

  /**
   * The browser-bundle check described in the header: {@link assertBrowserBundle}
   * bundles the `dist/index.js` this build just wrote for `platform: 'browser'`
   * with every dependency resolved, and a throw from it fails `pnpm build`
   * non-zero with each unresolved specifier and its importer named. A function
   * rather than a shell command because tsup awaits a function inside
   * `buildAll()`, so its rejection fails the build before tsup reports success,
   * whereas a command is spawned without being awaited and only sets the exit
   * code after the fact.
   */
  onSuccess: assertBrowserBundle,
});
