/**
 * Vite build for the React webview of the VS Code "Debug Generator" view.
 *
 * `pnpm --filter ./apps/vscode-extension run build` is two builds in a
 * load-bearing order: `node esbuild.mjs --production` first, which cleans
 * `dist/` and writes the extension host (`dist/extension.js`), the embedded
 * local service (`dist/service/**`) and the telemetry preload
 * (`dist/telemetry/**`); then `vite build` - this file - which writes
 * `dist/webview` and nothing else. `dist/` is co-owned by the two builds, so
 * `emptyOutDir` below is scoped to `dist/webview` and the order in
 * `package.json` must never be inverted: running esbuild second would delete
 * the webview, running Vite with `outDir: 'dist'` would delete the host.
 *
 * The emitted file names are a cross-folder contract, not an implementation
 * detail. `src/views/session-view-provider.ts` composes the webview HTML itself
 * with a strict content-security policy (`default-src 'none'`, a per-load nonce
 * on the single `<script type="module">`, `style-src ${webview.cspSource}`) and
 * references `dist/webview/main.js` and `dist/webview/main.css` statically
 * through `webview.asWebviewUri`. There is no manifest for it to read, which is
 * the whole reason every name emitted here is fixed and unhashed. If either
 * side of that pair of names changes, both change in the same commit.
 *
 * The webview is always loaded from disk inside VS Code, never from a dev
 * server, so this config deliberately has no `server`/`preview` block, no HMR,
 * no `base` and no public directory. The development loop is `watch:webview`
 * (`vite build --watch`) plus a reload of the extension development host.
 *
 * Styling comes entirely from `@debuggen/panel-renderer`: `src/webview/main.tsx`
 * imports that package's `./styles.css` export - the generated `--dg-*` token
 * set for the dark, light and high-contrast themes plus the component styles -
 * and this build is what lands those bytes in `dist/webview/main.css`. Without
 * it every component silently renders without its token values. There is no
 * Tailwind, no PostCSS plugin and no CSS-in-JS here: `@debuggen/panel-renderer`
 * is the repository's only design system (AAP 0.6), and no third-party styling
 * framework may be added to this build.
 *
 * Nothing environment-dependent is baked into the output. The only build-time
 * substitution is `process.env.NODE_ENV` (see `define` below); the webview
 * receives every piece of state at runtime over the typed host <-> webview
 * message union, so no service URL, credential or workspace path can reach this
 * bundle - which is also what keeps `scripts/check-secrets.mjs` trivially
 * satisfiable and the output byte-identical between machines.
 *
 * The file is `vite.config.mts`, not `vite.config.ts`, and the extension is
 * load-bearing. This config is ESM - `import.meta.url` below has no CommonJS
 * equivalent that survives bundling - while `apps/vscode-extension/package.json`
 * declares no `"type": "module"`, because VS Code loads `main:
 * dist/extension.js` as CommonJS and that manifest has to stay CommonJS. Under
 * that manifest a `.ts` config has an ambiguous module format: Vite's default
 * config loader reported "ESM syntax in a file loaded as CommonJS" on every
 * build, and the `native` loader planned to become the default has Node warn
 * about the same ambiguity. `.mts` is ESM by definition, so both loaders load it
 * without a notice, and the bare `vite build` in every `package.json` script
 * discovers `vite.config.mts` on its own. The sibling
 * `apps/chrome-extension/vite.config.ts` needs no such rename: its package is
 * `"type": "module"`.
 *
 * @module apps/vscode-extension/vite.config
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Absolute path of this workspace, used as the Vite project root.
 *
 * Derived from this file's own location rather than left to `process.cwd()`:
 * `pnpm --filter ./apps/vscode-extension run build:webview` runs with the
 * workspace as the working directory, but `vite build -c
 * apps/vscode-extension/vite.config.mts` from the repository root does not, and
 * `root` is what every relative path below - the entry, the output directory -
 * is resolved against. Pinning it makes the emitted paths independent of the
 * caller's directory.
 */
const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Output directory, relative to `root`.
 *
 * `dist/webview` and never `dist`: see the module header for the co-ownership
 * of `dist/` with `esbuild.mjs`.
 */
const OUT_DIR = 'dist/webview';

/**
 * The single entry of this build.
 *
 * `src/webview/**` is excluded from the host TypeScript program (it is owned by
 * `tsconfig.webview.json`, which supplies the DOM libraries and `jsx:
 * react-jsx` that host code must not see), so this config is the only place
 * that names the entry module. It is resolved to an absolute path because
 * Rolldown reports a bare relative input against its own working directory,
 * which produces a confusing error if the file is missing.
 */
const WEBVIEW_ENTRY = path.resolve(workspaceRoot, 'src/webview/main.tsx');

/**
 * Syntax target of the emitted bundle.
 *
 * The extension manifest declares `engines.vscode: "^1.125.0"`, and VS Code
 * 1.125.0 ships Electron 42.3.0 with Chromium 148; later releases only carry
 * newer Chromium. So every VS Code that can install this extension renders the
 * webview in Chromium 148 or newer, and naming that version documents the
 * runtime instead of guessing at it. Vite's own default,
 * `'baseline-widely-available'` (Chrome 111+), would be a needlessly older
 * baseline for a browser engine that ships with the editor.
 *
 * The webview sources are authored to ES2023 (`tsconfig.base.json` sets both
 * `target` and `lib` to ES2023), so this target never has to downlevel syntax
 * the compiler already accepted - the transform is effectively a pass-through,
 * which is exactly what keeps the emitted code readable against its source map.
 * It is a different value from the sibling `apps/chrome-extension` build's
 * `'chrome111'` for a substantive reason: that number is the documented API
 * floor of a Manifest V3 extension, while this one is the floor of the editor
 * that hosts the webview.
 */
const BUILD_TARGET = 'chrome148';

/**
 * The size budget of the webview bundle, in kB, as Vite's
 * `build.chunkSizeWarningLimit` measures it (minified bytes / 1000). 1,000 kB
 * is the budget the VS Code webview is held to. It replaces Vite's 500 kB
 * default so a build inside the budget is warning-free, and it is a budget
 * rather than a silencer: a `main.js` that outgrows it still prints Vite's
 * "(!) Some chunks are larger than ..." warning.
 */
const CHUNK_SIZE_BUDGET_KB = 1000;

export default defineConfig({
  // Pinned so every emitted path is independent of the caller's directory.
  root: workspaceRoot,

  // No public directory. The stylesheet this build extracts is the webview's
  // only asset, and every file the webview loads has to be reachable through
  // the provider's `localResourceRoots`; a `public/` folder added later would
  // be copied into `dist/webview` and served without anyone declaring it, so
  // the feature is switched off rather than left at its default.
  publicDir: false,

  // React and nothing else: no crxjs (there is no manifest), no HTML plugin
  // (the provider composes the document itself) and no styling framework -
  // `@debuggen/panel-renderer` is the only design system (AAP 0.6).
  plugins: [react()],

  resolve: {
    // One React instance across the webview and `@debuggen/panel-renderer`,
    // which declares react and react-dom 19.3.0 as peer dependencies. pnpm's
    // isolated `node_modules` can present the package's copy at a second
    // physical path, and two React instances make every hook in every rendered
    // component throw "Invalid hook call".
    dedupe: ['react', 'react-dom'],
  },

  // The only build-time substitution, and deliberately the only one: React 19
  // and several transitive libraries branch on `process.env.NODE_ENV`, while a
  // VS Code webview is a browser iframe with no `process` global, so any
  // surviving reference would throw a `ReferenceError` at load. Hard-coded
  // rather than derived from `mode` or from the ambient environment, so
  // `build:webview` and `watch:webview` emit the same bytes on every machine -
  // that is what makes a byte-comparison of two builds meaningful - and so
  // there is exactly one code path to reason about. React's development-only
  // warnings are not lost, they move to where they belong: the
  // `vscode-extension-webview` Vitest project renders the same components
  // through its own transform, with NODE_ENV left at its test default, which
  // selects React's development build.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },

  build: {
    outDir: OUT_DIR,

    // Emptied on every build so a stale chunk can never mask a broken one in
    // the directory the provider serves. This is also Vite's default for an
    // `outDir` inside `root`; it is restated because the property that matters
    // is its scope - it empties `dist/webview` only, never the
    // `dist/extension.js`, `dist/service/**` and `dist/telemetry/**` that
    // `esbuild.mjs` owns.
    emptyOutDir: true,

    target: BUILD_TARGET,

    // Full source maps, written as `main.js.map` beside the bundle with the
    // usual `//# sourceMappingURL=` comment. The webview's developer tools
    // fetch the map relative to the script URL rather than as a document
    // subresource, so the provider's `default-src 'none'` policy does not block
    // it, and it resolves because `main.js` is itself served out of
    // `dist/webview` through `asWebviewUri`. `dist/` is git-ignored, so the
    // extra bytes cost nothing and `.vscodeignore` decides what a packaged VSIX
    // actually carries.
    sourcemap: true,

    // Minified with Oxc, identifiers mangled. Unlike the sibling
    // `apps/chrome-extension` build, whose maps are 'hidden' and which
    // therefore keeps function and class names, this bundle links its map
    // (`sourcemap: true` above) and the webview developer tools load it, so
    // every frame and variable is shown under its source name anyway and full
    // mangling costs no debuggability. Measured against the unminified
    // baseline, `main.js` drops from 1,919 kB to 775 kB, inside
    // CHUNK_SIZE_BUDGET_KB.
    minify: 'oxc',

    // Never minified, stated explicitly because Vite would otherwise derive it
    // from `minify` above. `main.css` keeps its `--dg-*` declarations and theme
    // selectors readable in the Elements pane and greppable on disk, which is
    // how the design-system token contract is checked after a build; it is a
    // single stylesheet read once from local disk, so the bytes are immaterial.
    cssMinify: false,

    // The webview budget, not a silencer: see CHUNK_SIZE_BUDGET_KB.
    chunkSizeWarningLimit: CHUNK_SIZE_BUDGET_KB,

    // One stylesheet for the whole webview, which is what the provider's single
    // static reference requires. With CSS code splitting on, styles are emitted
    // per chunk and the provider would have no way to discover the extra files.
    cssCodeSplit: false,

    // Never inline an asset as a `data:` URI (0 disables the 4 KiB default).
    // Under `default-src 'none'` with only `style-src ${webview.cspSource}`, a
    // `data:` URL inside a `url()` or an `<img>` falls back to `default-src`
    // and is blocked, so every asset has to stay a real file that the provider
    // can serve through `asWebviewUri`.
    assetsInlineLimit: 0,

    // `modulePreload` is deliberately absent, which was measured rather than
    // assumed. Vite's module-preload polyfill is injected only into documents
    // Vite itself generates, and this build generates none, so the polyfill is
    // absent from the bundle either way. The preload *helper* that wraps a
    // dynamic import is emitted either way too, but `codeSplitting: false`
    // below leaves it with an empty dependency list, so it never creates a
    // `<link>` - which matters, because the provider's `default-src 'none'`
    // policy would block one. Setting `modulePreload: false` changes exactly
    // one thing in the output: it replaces the constant
    // `scriptRel = "modulepreload"` with a `detectScriptRel()` feature test
    // whose answer is fixed on Chromium 148. Dead code in a bundle that exists
    // to be read in a debugger is worse than no option at all.

    // `rollupOptions` is Vite 8's supported alias for `rolldownOptions` (Vite
    // 8.3.0 bundles with Rolldown). The alias is silent - only the
    // `optimizeDeps` paths emit a deprecation notice at runtime - and it is the
    // spelling the sibling `apps/chrome-extension/vite.config.ts` uses, so both
    // Vite builds in this repository read the same way.
    rollupOptions: {
      // A single entry, given as a string rather than a name/path map: code
      // splitting can only be disabled for one input, and a one-key map would
      // introduce a chunk name that nothing reads.
      input: WEBVIEW_ENTRY,

      output: {
        // Restated rather than inherited: the provider loads the bundle as
        // `<script type="module" nonce="...">`, so the emitted format is part
        // of the contract described in the module header.
        format: 'es',

        // No `[hash]` anywhere, because the provider references these names
        // statically (see the module header).
        //
        // `assetFileNames` is a literal rather than the usual
        // `[name].[ext]`: with `cssCodeSplit: false` the extracted stylesheet's
        // asset name is `style`, so the pattern form would emit `style.css` and
        // the provider's `main.css` reference would resolve to nothing. The
        // literal is safe only while that stylesheet is the single emitted
        // asset, which it is - the token set uses system font stacks (no
        // `@font-face`, no `url()`) and `lucide-react` renders inline SVG, so
        // nothing else reaches the asset pipeline. A second asset with the same
        // extension would collide with it, and adding one means revisiting this
        // pattern together with the provider's references - and `base`, which
        // this config deliberately leaves at Vite's default: an asset
        // referenced from a stylesheet is emitted as `url('/main.svg')`
        // (measured), and a `vscode-webview://` document resolves that against
        // its own origin root rather than `dist/webview`, so it would 404 and
        // be blocked by `default-src 'none'`. An asset-free webview needs no
        // `base`; the first asset needs a relative one and a look at the
        // provider's `localResourceRoots`.
        entryFileNames: 'main.js',
        chunkFileNames: '[name].js',
        assetFileNames: 'main.[ext]',

        // One JavaScript file. `codeSplitting: false` inlines every dynamic
        // import into the entry - the current, non-deprecated spelling of
        // `inlineDynamicImports: true` - so a lazily imported panel component
        // can never become a second chunk that the provider cannot reference
        // and the content-security policy would refuse to load.
        codeSplitting: false,
      },
    },
  },
});
