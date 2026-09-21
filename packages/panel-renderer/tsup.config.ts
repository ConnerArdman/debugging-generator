/**
 * Build configuration for `@debuggen/panel-renderer`.
 *
 * This package is the in-repo design system (AAP 0.6): one token source
 * (`src/tokens/tokens.ts`, from which `scripts/build-tokens.mjs` generates
 * `src/tokens/tokens.css`), the UI primitives, the layout primitives, the
 * thirteen visualization components of the node catalog and the `PanelHost`
 * that renders only validated panel specifications. Two consumers — the Chrome
 * DevTools panel (`apps/chrome-extension/src/panel`) and the VS Code webview
 * (`apps/vscode-extension/src/webview`) — bundle it with Vite, and both of them
 * import *two* things from it, which is exactly what this file has to emit:
 *
 *   dist/index.js   dist/index.js.map   dist/index.d.ts    (the `.` condition)
 *   dist/styles.css                                        (the `./styles.css` condition)
 *
 * Those four paths are not a convention here, they are the literal values of
 * the `exports` map in the sibling `package.json`. A drift between that map and
 * this configuration does not fail here; it fails later, as an unresolvable
 * `@debuggen/panel-renderer` import or — worse, because it fails silently — as
 * a panel that renders with every `--dg-*` custom property undefined. Every
 * option below is therefore stated explicitly rather than left to a tsup
 * default that a future version could change.
 *
 * ## The stylesheet is assembled here, not imported from `src/index.ts`
 *
 * `dist/styles.css` is the concatenation of three inputs, in one fixed order
 * (see `STYLESHEET_INPUTS`): the generated token declarations first, because
 * every rule that follows resolves its values from them, then the base rules,
 * then the component rules. The `onSuccess` hook at the bottom of this file
 * does that concatenation.
 *
 * The alternative — `import './styles/components.css'` from a module in
 * `src/**` and letting tsup's postcss pipeline collect it — is deliberately not
 * used. It would put a CSS side effect inside `dist/index.js`, which
 * `"sideEffects": ["**\/*.css"]` in `package.json` exists precisely to keep out:
 * a consumer that imports one component would then pull the whole stylesheet
 * through the JavaScript graph, and neither Vite bundle could tree-shake the
 * barrel. The JS bundle stays CSS-free; the stylesheet is a second artefact
 * that consumers import by its own specifier.
 *
 * ## Relationship to `tsc -b` and to `prebuild`
 *
 * `tsconfig.json` is `composite` and `emitDeclarationOnly` and writes into
 * `packages/panel-renderer/.tsbuild`: that is the `pnpm typecheck` gate, not a
 * build. Shipping artefacts come from this file and land in `dist/`, which
 * `.gitignore` and `.prettierignore` both exclude, so the output is regenerated
 * from source on every CI run and never committed.
 *
 * `package.json` runs `node scripts/build-tokens.mjs` as `prebuild`
 * (pnpm-workspace.yaml declares `enablePrePostScripts: true`, the setting pnpm
 * honours; `.npmrc` mirrors it for npm), which is what puts
 * `src/tokens/tokens.css` on disk from `src/tokens/tokens.ts`. This file does
 * not run that generator and does not stand in for it: if the generated
 * stylesheet is absent the build stops with a message naming it, because an
 * emitted `dist/styles.css` without the token block is the one failure mode
 * that would look like a successful build and then break every colour, space
 * and font value in both consumers.
 *
 * Because the two workspace dependencies whose types this package consumes are
 * resolved through their own `exports` maps (their `dist/`), `pnpm build` must
 * run in topological order — `shared` -> `telemetry` -> `panel-schema` -> this
 * package — which `pnpm -r build` guarantees from the `dependencies` field.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsup';

/**
 * Absolute path of this workspace, derived from this module's own URL rather
 * than from `process.cwd()`, so every path the stylesheet step reads and writes
 * is anchored to this file's directory however tsup was started.
 *
 * Note the asymmetry it protects against: tsup resolves the `entry` and
 * `tsconfig` options below against the *process* working directory, so the
 * supported invocations are the ones that run with this package as their cwd
 * (`pnpm --filter @debuggen/panel-renderer build`, and each step of
 * `pnpm -r build`). A stylesheet path resolved the same way would silently
 * follow a different cwd — writing into, or reading from, whichever directory
 * the command happened to start in — and that failure would be far harder to
 * read than a missing entry point.
 */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Project-relative path of the single stylesheet the `exports` map advertises. */
const STYLESHEET_OUTPUT = 'dist/styles.css';

interface StylesheetInput {
  /** POSIX, workspace-relative path of the input, as it appears in messages. */
  readonly rel: string;
  /** What this part contributes, and what to do when it is missing. */
  readonly hint: string;
}

/**
 * The three inputs of `dist/styles.css`, in the ONE order the output must carry
 * them. The order is a cascade requirement, not a preference:
 *
 * 1. `src/tokens/tokens.css` declares every `--dg-*` custom property under
 *    `:root`, `[data-theme="light"]` and `[data-theme="high-contrast"]`
 *    (AAP 0.6.3). It is generated from `src/tokens/tokens.ts` by
 *    `scripts/build-tokens.mjs` and is the only place a literal colour, space,
 *    radius or type value is allowed to exist.
 * 2. `src/styles/base.css` holds the reset and the element-level base rules.
 * 3. `src/styles/components.css` holds the component rules, which consume the
 *    custom properties from part 1 and override part 2.
 *
 * Custom properties resolve at use time, so parts 2 and 3 would technically
 * still see the tokens if they came first; the fixed order is what keeps the
 * *cascade* between base and component rules deterministic and the emitted file
 * readable top-to-bottom for the humans who review it. AAP 0.2.5 names exactly
 * `base.css` and `components.css` under `src/styles` — no aggregator, no fourth
 * stylesheet — so adding an input is a change to the AAP and to `package.json`,
 * not an edit here.
 */
const STYLESHEET_INPUTS: readonly StylesheetInput[] = [
  {
    rel: 'src/tokens/tokens.css',
    hint: [
      'That file is GENERATED from src/tokens/tokens.ts by scripts/build-tokens.mjs,',
      'which package.json runs as the `prebuild` script. Its absence means the',
      'generator did not run (for example `tsup` was invoked directly, or',
      "pnpm-workspace.yaml's `enablePrePostScripts` was set to false) or it failed.",
      'Run `pnpm --filter @debuggen/panel-renderer build`, or `node',
      'scripts/build-tokens.mjs` on its own, and build again. It is never',
      'substituted with an empty file: without the --dg-* declarations every',
      'colour, spacing, font and radius value in the DevTools panel and the VS',
      'Code webview would silently resolve to nothing.',
    ].join('\n'),
  },
  {
    rel: 'src/styles/base.css',
    hint: [
      'That file holds the reset and element-level base rules of the design system',
      '(AAP 0.2.5). It is authored, not generated, so restore it from version control',
      'rather than regenerating it.',
    ].join('\n'),
  },
  {
    rel: 'src/styles/components.css',
    hint: [
      'That file holds the component rules of the design system (AAP 0.2.5). It is',
      'authored, not generated, so restore it from version control rather than',
      'regenerating it.',
    ].join('\n'),
  },
];

/**
 * Static header of the emitted stylesheet. It names the inputs so that a reader
 * who opens `dist/styles.css` — in a Vite dev server, in the DevTools Sources
 * tab, inside a packaged VSIX — knows where each rule came from and that the
 * file is not editable. Nothing here varies between builds: no timestamp, no
 * build counter, no content hash, no version number, which is what makes two
 * builds of one commit byte-identical.
 */
const STYLESHEET_HEADER = [
  '/*',
  ' * @debuggen/panel-renderer — dist/styles.css',
  ' *',
  ' * Generated by tsup.config.ts. Do not edit; rebuild with',
  ' * `pnpm --filter @debuggen/panel-renderer build`.',
  ' *',
  ' * Concatenated, in this order, from:',
  ' *   1. src/tokens/tokens.css      (generated from src/tokens/tokens.ts)',
  ' *   2. src/styles/base.css',
  ' *   3. src/styles/components.css',
  ' */',
].join('\n');

/**
 * Failure of the stylesheet assembly step. A distinct class so the message tsup
 * prints is attributable at a glance: tsup's own error handler logs
 * `error.stack` and sets a non-zero exit code, so `StylesheetError: …` plus the
 * hint is what a developer and a CI log both see.
 *
 * `stack` is replaced with the name and message alone, deliberately. The three
 * conditions this class reports are all "an input this build needs is not
 * there", and the message already names the path and what to do about it; the
 * default stack would bury that under a dozen frames from inside tsup's worker
 * plumbing, in a bundled copy of this very file whose line numbers mean nothing
 * to a reader. Any *unexpected* error — a permission failure on the write, say
 * — is not a `StylesheetError` and keeps its full stack.
 */
class StylesheetError extends Error {
  constructor(message: string, hint: string) {
    super(`${message}\n\n${hint}`);
    this.name = 'StylesheetError';
    this.stack = `${this.name}: ${this.message}`;
  }
}

/**
 * Reads one stylesheet part and normalises it for concatenation.
 *
 * Three conditions stop the build, each with the path in the message: absent
 * (which includes a dangling symlink, whose `stat` rejects), not a regular file
 * (a directory where a stylesheet is expected is a broken tree, not an empty
 * one), and whitespace-only — an empty part is the same silent failure as a
 * missing one, so it is treated the same way instead of being concatenated into
 * nothing.
 *
 * Normalisation is limited to what determinism requires: a leading byte-order
 * mark is dropped (it would otherwise sit between the header comment and the
 * first selector, where some parsers reject it), CRLF is folded to LF (a
 * checkout with `core.autocrlf` on must not produce different bytes from a LF
 * checkout), and trailing whitespace is trimmed so the caller controls the
 * exact separator between parts. No other rewriting happens: no minification,
 * no autoprefixing, no reformatting — the values are custom properties, the
 * file is reviewed by humans, and `.prettierignore` deliberately excludes the
 * generated token source from formatting.
 */
async function readStylesheetPart(input: StylesheetInput): Promise<string> {
  const absolute = path.join(PACKAGE_DIR, ...input.rel.split('/'));

  // `stat` rather than `existsSync`: it resolves symlinks, so a dangling link is
  // reported as missing (its `stat` rejects) and a link to a real file is accepted.
  const stats = await stat(absolute).catch(() => null);

  if (stats === null) {
    throw new StylesheetError(
      `cannot assemble ${STYLESHEET_OUTPUT}: ${input.rel} is missing`,
      input.hint,
    );
  }

  if (!stats.isFile()) {
    throw new StylesheetError(
      `cannot assemble ${STYLESHEET_OUTPUT}: ${input.rel} is not a regular file`,
      input.hint,
    );
  }

  const contents = await readFile(absolute, 'utf8');
  const normalised = contents
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n/gu, '\n')
    .trimEnd();

  if (normalised === '') {
    throw new StylesheetError(
      `cannot assemble ${STYLESHEET_OUTPUT}: ${input.rel} is empty`,
      input.hint,
    );
  }

  return normalised;
}

/**
 * Concatenates the three inputs into `dist/styles.css`.
 *
 * Runs as tsup's `onSuccess` hook, which tsup invokes after the output
 * directory has been cleaned and after esbuild has written the JavaScript — in
 * that order, verified against tsup 8.5.1's build sequence
 * (clean -> esbuild -> copy public dir -> onSuccess) rather than assumed, since
 * the reverse order would have `clean: true` delete this file on every build.
 * The declaration step runs concurrently in a worker thread and writes only
 * `dist/index.d.ts`, so it never races this write.
 *
 * `dist/` is created defensively: esbuild has already made it by the time this
 * runs, but the hook must not depend on that to be the only writer.
 */
async function assembleStylesheet(): Promise<void> {
  const parts: string[] = [];
  for (const input of STYLESHEET_INPUTS) {
    parts.push(await readStylesheetPart(input));
  }

  // Exactly one newline joins each part to the next, and the file ends with a
  // single newline. Both are properties of this expression alone: every part was
  // trimmed of trailing whitespace above, so the separator cannot drift with the
  // final-newline convention of an input.
  const stylesheet = `${[STYLESHEET_HEADER, ...parts].join('\n')}\n`;

  const outputPath = path.join(PACKAGE_DIR, ...STYLESHEET_OUTPUT.split('/'));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, stylesheet, 'utf8');
}

export default defineConfig({
  /**
   * The object form is load-bearing, exactly as in `packages/shared`,
   * `packages/telemetry` and `packages/panel-schema`: tsup derives the output
   * path from the key, so this key *is* `dist/index.js` with `dist/index.d.ts`
   * beside it, byte for byte the paths the sibling `package.json` `exports`
   * block names for the `"."` condition. The array form would instead infer
   * paths by stripping the longest common directory of the inputs, which agrees
   * for one entry today and would silently disagree the moment the entry list
   * changed — a drift the `exports` map cannot absorb, and one that surfaces at
   * the consumer as "package has no exports" rather than here.
   *
   * One entry, and only this one. The barrel re-exports the tokens, the
   * primitives, the layout primitives, the visualization components, the host
   * and its registry; a per-component entry would multiply the artefacts
   * without adding a condition to the `exports` map, and the two consumers
   * tree-shake the barrel in their own Vite builds anyway.
   */
  entry: {
    index: 'src/index.ts',
  },

  outDir: 'dist',

  /**
   * ESM only: `package.json` declares `"type": "module"` and the `"."`
   * condition offers a single `default` target. Both consumers are Vite bundles
   * that prefer ESM, so a CJS output would be dead bytes behind a condition
   * nobody reads — and a CJS copy of a React component library is the classic
   * way to end up with two React instances at runtime.
   */
  format: ['esm'],

  /**
   * Matches `target: "ES2023"` in `tsconfig.base.json`. Chrome 153 (the
   * `minimum_chrome_version` the DevTools panel declares) and the Electron
   * runtime behind the VS Code webview both implement ES2023 in full, so
   * nothing is downlevelled and the emitted JavaScript stays close to the
   * authored source — which keeps the sourcemaps readable when a component
   * throws inside a page that is itself being debugged.
   */
  target: 'es2023',

  /**
   * The load-bearing platform choice, and the mechanical half of this package's
   * browser-only boundary — the other half being the workspace
   * `tsconfig.json`, which grants `types: ["node"]` for one colocated test
   * (`src/tokens/tokens.test.ts` reads the generated token CSS with `node:fs`
   * to make the byte-wise drift assertion) and therefore *cannot* express "no
   * Node builtin in library code" through the type system.
   *
   * Under `platform: 'browser'` esbuild has no Node builtin list to fall back
   * on, so a `node:fs`, `node:path` or bare `fs` import anywhere in the
   * `src/index.ts` import graph fails this build loudly instead of shipping
   * inside the barrel. That matters because the breakage would otherwise appear
   * far from its cause: an unresolved builtin in the DevTools panel's Vite
   * build, or a runtime explosion in a page. Colocated `*.test.ts(x)` files are
   * not build inputs — tsup follows imports from the single entry above, and
   * the barrel re-exports library modules only — so the token drift test keeps
   * its `node:fs` import.
   *
   * `browser` (rather than the `neutral` its sibling library builds use) is
   * also the correct resolution profile: it selects the `browser`/`module`
   * export conditions, which is how `lucide-react`, `clsx` and
   * `@tanstack/react-virtual` would be resolved by the two Vite consumers. In
   * practice nothing third-party is resolved here at all, because every
   * package specifier stays external (see `external` below).
   */
  platform: 'browser',

  /**
   * Declarations are as much the product of this package as the JavaScript is:
   * `PanelHostProps`, `DataProvider`, `PanelActions`,
   * `PanelComponentRegistry`, the per-component `Props` interfaces and the
   * token types are what the DevTools panel and the VS Code webview type-check
   * against, and `dist/index.d.ts` is the file the `"."` condition points them
   * at.
   *
   * The three overrides are required, not defensive. tsup's declaration step
   * builds its own TypeScript program from the `tsconfig` named below and then
   * layers its own options on top, with its layer winning:
   *
   * - `composite` / `incremental` are inherited (`tsconfig.base.json` sets
   *   both, and the workspace config restates `composite` because the root
   *   solution file references this project for `tsc -b`). A composite program
   *   must list every input file, whereas tsup's program is seeded with one
   *   entry file and follows imports, so the barrel's own re-exports are
   *   reported as "not listed within the file list of project" (TS6307). The
   *   two options also bind a program to the build stamp and declaration
   *   directory of the typecheck gate (`.tsbuild/`), which is not where this
   *   build writes. Disabling them for the declaration program alone leaves the
   *   gate untouched — `composite: true` stays in `tsconfig.json`, where
   *   `tsc -b` needs it — and keeps `dist/` free of a stray `.tsbuildinfo`.
   * - `ignoreDeprecations` answers tsup 8.5.1 setting `baseUrl` on that program
   *   unconditionally (`baseUrl: compilerOptions.baseUrl || '.'`) — a value
   *   this repository deliberately never declares, because the three workspace
   *   dependencies must resolve through their `exports` maps and not through a
   *   path alias. TypeScript 6.0.3, the pinned compiler, raises `baseUrl` from
   *   a deprecation warning to the hard error TS5101 and names
   *   `"ignoreDeprecations": "6.0"` as the acknowledgement. Nothing in the
   *   repository can stop tsup from injecting the option, so the
   *   acknowledgement is the fix; it is scoped to this one program and to
   *   `baseUrl`, and it falls away when tsup stops injecting it.
   *
   * Every other compiler option is still inherited — `strict`,
   * `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `jsx: "react-jsx"`,
   * the `["ES2023", "DOM", "DOM.Iterable"]` lib set and the bundler module
   * resolution that makes the extensionless relative specifiers in `src/**`
   * resolve — so the declarations emitted here are the ones the typecheck gate
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
   * Switched off for the same reason every sibling library build switches it
   * off, and here it is what keeps the `platform: 'browser'` guarantee above
   * honest. tsup 8.5.1 implements `removeNodeProtocol: true` (still the
   * default; its own documentation calls that temporary and says it flips in
   * the next major) as a resolve plugin that rewrites `node:x` to `x` *and*
   * marks it external — which would swallow precisely the failure the browser
   * platform exists to raise, turning a Node-only import in a page bundle back
   * into a silent external. With it off, a stray `node:fs` stays unresolvable
   * and the build stops. It is also what a review greps for: `dist/index.js`
   * must contain no `node:` specifier and no `require(` of a builtin at all.
   */
  removeNodeProtocol: false,

  /**
   * `dist/index.js.map` is emitted beside the bundle. Both consumers load this
   * package inside a devtool — the DevTools panel is itself a page in Chrome
   * DevTools, the webview is inspected through the VS Code devtools — so a
   * component stack that points at `src/components/Timeline.tsx` instead of at
   * a column in a bundle is the difference between a diagnosable and an
   * undiagnosable render error.
   */
  sourcemap: true,

  /**
   * `dist/` is wiped before each build, so a file left behind by an earlier
   * layout — a renamed entry, a removed component, a stylesheet that used to be
   * emitted under another name — can never masquerade as a current artefact for
   * a consumer resolving through the `exports` map.
   *
   * This is safe next to the `onSuccess` stylesheet write only because of the
   * order tsup runs them in (clean, then esbuild, then `onSuccess`); the
   * ordering is verified, not assumed, and the note on `assembleStylesheet`
   * records it. Nothing else writes into this package's `dist/` — unlike
   * `packages/telemetry`, whose two sibling esbuild scripts share one directory
   * with tsup and depend on their script order for the same reason.
   */
  clean: true,

  /**
   * No shared chunks. Chunk names are content-addressed, so splitting would put
   * files in `dist/` whose names the `exports` map does not state, and with a
   * single entry there is nothing to share them with in any case. It also keeps
   * `dist/` to exactly the four files a reviewer should find there —
   * `index.js`, `index.js.map`, `index.d.ts` and the assembled `styles.css` —
   * so anything else in the directory is a signal rather than noise.
   */
  splitting: false,

  /**
   * Library output must stay readable. A generated panel that renders wrongly
   * is diagnosed from a React component stack and a DOM inspection inside the
   * DevTools panel, and minified component code makes both useless; the bundle
   * is loaded from disk by two local bundlers and never shipped over a network,
   * so there is nothing to trade the readability for. Consumers minify their
   * own production bundles.
   */
  minify: false,

  // NOT declared: `treeshake`. It is deliberately left at tsup's default (off),
  // the one option where this file diverges from its sibling library builds, and
  // the divergence is the point rather than an oversight. Enabling it routes the
  // emitted bundle through an extra rollup pass. This package is the only one in
  // the repository whose barrel is a broad surface of React components that each
  // consumer uses a subset of, and the tree-shaking that matters for it happens
  // in the *consumer's* Vite build, driven by the `sideEffects` field in
  // `package.json` (which lists stylesheets only) — a pass here would drop
  // nothing extra, because everything the barrel exports is reachable from the
  // barrel by definition. What it would add is a second transformer between
  // esbuild and `dist/`: a duplicated `sourceMappingURL` comment on every chunk
  // (a known artefact of that pass, and this package's sourcemaps are
  // load-bearing per `sourcemap` above) and one more place for JSX output and
  // component identity to be rewritten.

  /**
   * Resolved relative to this file, so both the transform and the declaration
   * program above read this workspace's own `tsconfig.json` — the bundler
   * module resolution that makes extensionless relative specifiers work,
   * `rootDir: "src"`, `jsx: "react-jsx"` and the DOM lib set — rather than
   * whatever config happens to sit above the process's working directory.
   */
  tsconfig: './tsconfig.json',

  /**
   * tsup keeps `dependencies` and `peerDependencies` external by default, and
   * its matcher treats a bare name as covering that name's subpaths
   * (`id === p || id.startsWith(p + '/')`). Both facts are restated as explicit
   * entries here, subpaths included, because what each entry prevents is
   * specific and severe:
   *
   * - `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom` and
   *   `react-dom/client` must resolve in the *consumer's* graph. React is a
   *   `peerDependency` for exactly this reason: two copies of React in one page
   *   mean two dispatchers, and every hook this library calls would throw
   *   "Invalid hook call" inside the DevTools panel. The JSX runtime subpaths
   *   are named because the automatic runtime imports them on behalf of every
   *   `.tsx` file in `src/**` — they are the most-imported specifiers in this
   *   package and the least visible in its source.
   * - `@debuggen/panel-schema` must stay one instance: `PANEL_NODE_CATALOG` is
   *   an identity, not just a shape. `src/host/registry.ts` is keyed by the
   *   catalog and `src/host/registry.test.ts` proves one-to-one coverage of it,
   *   while `apps/local-service` validates a panel specification against the
   *   same catalog before it is ever sent; a second bundled copy would let
   *   those two disagree about which node types exist.
   * - `@debuggen/telemetry` owns the aggregate result shapes the components
   *   render (`TelemetryEvent`, `TraceTree`, `RenderStat`, `RequestGroup`,
   *   `QueryGroup`, `StateTransition`, `ComponentTreeSnapshot`, `MetricValue`)
   *   and the fixed metric-id set; `@debuggen/shared` owns `SourceLocation` and
   *   its helpers. Inlining either would duplicate a single-definition contract
   *   that AAP 0.2.3 puts in exactly one place.
   * - `clsx`, `@tanstack/react-virtual` and `lucide-react` stay bare so the
   *   consumer's bundler applies their own export conditions and dedupes them
   *   against its other dependents — `@tanstack/react-virtual` additionally
   *   uses React hooks, so it inherits the single-instance requirement above.
   *
   * Node builtins need no entry: `platform: 'browser'` with
   * `removeNodeProtocol: false` gives esbuild nothing to externalise them to,
   * which is the point. No `banner`, `footer`, `shims`, `define` or `env` is
   * declared either: nothing in this output may vary with a clock, a build
   * counter or an ambient variable, so two builds of one commit produce
   * byte-identical artefacts.
   */
  external: [
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'react-dom',
    'react-dom/client',
    'clsx',
    '@tanstack/react-virtual',
    'lucide-react',
    '@debuggen/panel-schema',
    '@debuggen/telemetry',
    '@debuggen/shared',
  ],

  /**
   * Three esbuild options are pinned directly, each for a reason the tsup-level
   * options cannot express:
   *
   * - `jsx: 'automatic'` restates what `tsconfig.json`'s inherited
   *   `"jsx": "react-jsx"` already asks for, so the transform never depends on
   *   the tsconfig lookup succeeding: the emitted bundle imports
   *   `react/jsx-runtime` and never references a `React` global, which is
   *   required because no `.tsx` file in `src/**` imports the React namespace
   *   and neither consumer defines that global.
   * - `jsxDev: false` keeps the production runtime regardless of `NODE_ENV` or
   *   of a future `"jsx": "react-jsxdev"` edit. The dev runtime injects
   *   `__source` (a file path and line number) into every element, which would
   *   make this bundle depend on the machine that built it — the opposite of
   *   the byte-identical artefact this file guarantees. (The dev runtime is
   *   still listed as external above: an unresolved import is a better failure
   *   than a bundled second copy if that option is ever flipped.)
   * - `legalComments: 'none'` fixes a value esbuild otherwise varies by
   *   platform and bundling mode. Nothing third-party is bundled here — every
   *   package specifier is external — so there is no upstream licence text to
   *   preserve, and the only comments in the input are this repository's own
   *   documentation.
   */
  esbuildOptions(options) {
    options.jsx = 'automatic';
    options.jsxDev = false;
    options.legalComments = 'none';
  },

  /**
   * Emits `dist/styles.css`, the second artefact of this package's `exports`
   * map, after the JavaScript bundle is written. See `assembleStylesheet` and
   * `STYLESHEET_INPUTS` above for the order, the determinism guarantees and the
   * failure modes; a missing or empty input stops the build with a non-zero
   * exit code and a message naming the path.
   */
  onSuccess: assembleStylesheet,
});
