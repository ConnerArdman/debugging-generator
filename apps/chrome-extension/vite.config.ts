/**
 * Vite build for the "Debug Generator" Manifest V3 extension.
 *
 * This is the only build of this workspace: `pnpm --filter
 * @debuggen/chrome-extension build` runs `vite build`, which turns
 * `manifest.config.ts` plus the four source surfaces (`src/devtools`,
 * `src/panel`, `src/background`, `src/content`) into the unpacked extension in
 * `dist/`. That directory is a cross-folder contract, not an implementation
 * detail:
 *
 *   - a developer loads it with "Load unpacked";
 *   - the root `playwright.config.ts` exports it as `extensionPath` and hands it
 *     to `--disable-extensions-except` / `--load-extension`, refusing to run at
 *     all when `dist/manifest.json` is missing;
 *   - `test/manifest.test.ts` reads `dist/manifest.json` from disk and asserts
 *     the manifest contract field by field.
 *
 * Division of labour with `manifest.config.ts`: that module is the single source
 * of the manifest and is never duplicated here. This file hands it to
 * `@crxjs/vite-plugin`, adds the one entry point the manifest cannot name (the
 * panel document, created at runtime by `chrome.devtools.panels.create`), and
 * enforces the two build invariants the manifest depends on but cannot enforce
 * itself - the verbatim pass-through of the pre-built MAIN-world agent bundle,
 * and the declaration order of `content_scripts`.
 *
 * Nothing environment-dependent is baked into the output: there is no `define`
 * block, no service URL, no token and no mode-conditional behaviour. The
 * service origin and the paired credential are runtime concerns owned by
 * `src/background/*`, which is what keeps this build reproducible on any machine
 * and keeps `scripts/check-secrets.mjs` trivially satisfiable.
 *
 * @module apps/chrome-extension/vite.config
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { crx, type CrxPlugin, type ManifestV3Export } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, type ConfigEnv, type UserConfig } from 'vite';

/**
 * The single source of the manifest, imported without a file extension because
 * this workspace's program resolves modules the way its bundler does
 * (`moduleResolution: "bundler"`), and a `.ts` specifier would need
 * `allowImportingTsExtensions`, which the workspace tsconfig deliberately does
 * not enable. Vite 8's default (bundled) config loader resolves it; it also
 * prints a forward-compatibility notice that the not-yet-default `native`
 * config loader would require the extension. That notice is expected, is not an
 * error, and is not silenced by an environment variable here - this build stays
 * free of environment-dependent behaviour.
 */
import authoredManifest from './manifest.config';

/**
 * Absolute path of this workspace, used as the Vite project root.
 *
 * Derived from this file's own location rather than left to `process.cwd()`:
 * `pnpm --filter` runs the script with the workspace as the working directory,
 * but `vite build -c apps/chrome-extension/vite.config.ts` from the repository
 * root does not, and @crxjs/vite-plugin resolves every manifest path, content
 * script and HTML document against `config.root`. Pinning it makes the emitted
 * file names independent of the caller's directory.
 */
const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));

/** Output directory - the unpacked extension (see the module header). */
const OUT_DIR = 'dist';

/**
 * Asset directory copied verbatim into the root of `dist/`.
 *
 * Vite's default, restated because it carries a contract: `public/icons/*.png`
 * become `dist/icons/*.png` (the paths `manifest.config.ts` declares under
 * `icons`), and `public/agent.iife.js` - installed by this workspace's
 * `prebuild` step from `packages/telemetry/dist/browser-agent.iife.js` - becomes
 * `dist/agent.iife.js`, the MAIN-world content script. Vite copies these bytes
 * untouched, and no transform, minifier or hashing rule in this config may
 * touch them; `assertPrebuiltFilesAreVerbatim` proves it after every build.
 */
const PUBLIC_DIR = 'public';

/**
 * The panel document, added as an explicit Rollup input.
 *
 * It is deliberately absent from the manifest: the panel page is created at
 * runtime by `chrome.devtools.panels.create(...)` in `src/devtools/devtools.ts`,
 * and putting it in the manifest would make it a declared extension page rather
 * than a DevTools-hosted one. @crxjs/vite-plugin only discovers HTML that the
 * manifest references (`htmlFiles()` reads `devtools_page`, the action popup,
 * the options page, the sandbox pages and the side panel), so without this
 * input the document is never emitted and the DevTools tab opens blank.
 *
 * Vite emits an HTML input at its path relative to the project root, so this
 * value is also the built path and therefore the extension-root-relative string
 * `chrome.devtools.panels.create` must be given: `dist/src/panel/panel.html` ->
 * `"src/panel/panel.html"`. (The devtools page, which crxjs emits from the
 * `devtools_page` key, lands at `dist/src/devtools/devtools.html` for the same
 * reason.) Both were verified against the built output rather than assumed.
 */
const PANEL_HTML = 'src/panel/panel.html';

/**
 * Syntax target of the emitted bundles.
 *
 * `manifest.config.ts` *declares* `minimum_chrome_version: "153"` - the version
 * the Playwright suites actually run, and therefore the only version this
 * extension is proven on - while the APIs it uses have a lower floor
 * (manifest-declared `world: "MAIN"` needs Chrome 111, `chrome.storage.session`
 * needs 102). The emitted syntax follows that documented API floor, which also
 * matches the `target: ['chrome111']` that `packages/telemetry/esbuild.agent.mjs`
 * compiles the MAIN-world agent with, so both halves of the page-side code are
 * built for the same baseline.
 */
const BUILD_TARGET = 'chrome111';

/**
 * The manifest object shape, recovered from the union @crxjs/vite-plugin
 * exports (`ManifestV3 | Promise<ManifestV3> | (env) => ManifestV3 | ...`). The
 * plugin does not export `ManifestV3` itself, and re-declaring it here would be
 * a second, drifting copy of a third-party type.
 */
type ResolvedManifest = Extract<Awaited<ManifestV3Export>, { manifest_version: number }>;

/** One entry of the manifest's `content_scripts` array. */
type ContentScript = NonNullable<ResolvedManifest['content_scripts']>[number];

/** Where a content script's `js` file comes from. */
type ScriptOrigin = 'source' | 'prebuilt' | 'missing';

/**
 * Resolves `manifest.config.ts`'s default export to a plain object, whichever
 * of the three shapes `defineManifest` returned.
 */
async function resolveAuthoredManifest(env: ConfigEnv): Promise<ResolvedManifest> {
  return typeof authoredManifest === 'function'
    ? await authoredManifest(env)
    : await authoredManifest;
}

/**
 * Classifies one declared content-script file.
 *
 * Root first, then `public/`, which is the precedence @crxjs/vite-plugin itself
 * applies when it loads a manifest asset: a file under the project root is a
 * source module it bundles, a file under `public/` is a pre-built asset Vite
 * copies verbatim.
 */
function classifyScriptFile(file: string): ScriptOrigin {
  if (existsSync(path.resolve(workspaceRoot, file))) {
    return 'source';
  }
  if (existsSync(path.resolve(workspaceRoot, PUBLIC_DIR, file))) {
    return 'prebuilt';
  }
  return 'missing';
}

/**
 * True when every `js` file of this entry is a pre-built asset in `public/`, in
 * which case the entry must reach the built manifest verbatim and must never be
 * handed to @crxjs/vite-plugin.
 *
 * WHY THIS EXISTS - measured against @crxjs/vite-plugin 2.7.1 and Vite 8.3.0,
 * not assumed. The plugin's internal `crx:content-scripts-iife` claims every
 * content script whose file name matches `/\.iife\.(ts|tsx|js|jsx|mjs|cjs)$/`
 * and re-bundles it with a nested Vite library build whose entry is
 * `join(config.root, file)`. For the MAIN-world agent that path is
 * `apps/chrome-extension/agent.iife.js`, which does not exist - the bundle lives
 * in `public/` - so the build dies with `[UNRESOLVED_ENTRY] Cannot resolve entry
 * module "agent.iife.js"`. The plugin reads the object passed to `crx()`
 * directly, so no manifest transform hook can hide the entry from it, and
 * `CrxOptions` offers no exclusion (its `contentScripts.standaloneFiles` adds
 * IIFE builds rather than removing them). Re-bundling would be the wrong outcome
 * anyway: it would break both the byte-for-byte copy contract and the
 * before-React hook installation that the whole browser-telemetry story rests
 * on.
 *
 * A mixed entry is rejected rather than guessed at: the two kinds need opposite
 * treatment, so combining them in one entry has no correct build.
 */
function isPrebuiltEntry(entry: ContentScript, index: number): boolean {
  const files = entry.js ?? [];
  if (files.length === 0) {
    // A CSS-only entry has nothing to bundle and nothing to copy; crxjs owns it.
    return false;
  }

  const origins = files.map((file) => ({ file, origin: classifyScriptFile(file) }));
  const missing = origins.filter(({ origin }) => origin === 'missing');
  if (missing.length > 0) {
    throw new Error(missingScriptMessage(missing[0]?.file ?? '', index));
  }

  const prebuilt = origins.filter(({ origin }) => origin === 'prebuilt');
  if (prebuilt.length > 0 && prebuilt.length !== origins.length) {
    throw new Error(
      [
        `Debug Generator: content_scripts[${index}] mixes source modules with pre-built assets.`,
        ``,
        ...origins.map(({ file, origin }) => `  ${file} (${origin})`),
        ``,
        `A pre-built asset is copied verbatim out of ${PUBLIC_DIR}/ and a source module is`,
        `bundled by @crxjs/vite-plugin; one entry cannot receive both treatments. Split`,
        `them into separate content_scripts entries in manifest.config.ts.`,
      ].join('\n'),
    );
  }

  return prebuilt.length > 0;
}

/**
 * Explains a content script that exists in neither the project root nor
 * `public/`. The overwhelmingly likely cause is a build run without this
 * workspace's `prebuild` step, whose native failure - an unresolved entry deep
 * inside a nested Vite build - names neither the file's real home nor the step
 * that installs it.
 */
function missingScriptMessage(file: string, index: number): string {
  return [
    `Debug Generator: content script "${file}" (content_scripts[${index}]) was not found.`,
    ``,
    `  source module expected at: ${path.join(workspaceRoot, file)}`,
    `  pre-built asset expected at: ${path.join(workspaceRoot, PUBLIC_DIR, file)}`,
    ``,
    `A pre-built content script is installed by this workspace's prebuild step, which`,
    `copies packages/telemetry/dist/browser-agent.iife.js into ${PUBLIC_DIR}/. Run:`,
    ``,
    `  pnpm --filter @debuggen/telemetry build`,
    `  node ../../scripts/copy-agent.mjs`,
    ``,
    `or build both workspaces in dependency order with "pnpm build".`,
  ].join('\n');
}

/**
 * The authored `content_scripts` array split into the part @crxjs/vite-plugin
 * builds and the part this config passes through untouched.
 */
interface ContentScriptPartition {
  /** The authored entries, in the order `manifest.config.ts` declares them. */
  readonly authored: readonly ContentScript[];
  /** Index-aligned: `true` where the entry is a pre-built, verbatim asset. */
  readonly prebuilt: readonly boolean[];
  /** The entries handed to crxjs, in authored order, pre-built ones removed. */
  readonly bundled: ContentScript[];
}

/** Splits the authored entries; see {@link isPrebuiltEntry} for the criterion. */
function partitionContentScripts(manifest: ResolvedManifest): ContentScriptPartition {
  const authored = manifest.content_scripts ?? [];
  const prebuilt = authored.map(isPrebuiltEntry);
  return {
    authored,
    prebuilt,
    bundled: authored.filter((_, index) => prebuilt[index] !== true),
  };
}

/** SHA-256 of a file's bytes, as lower-case hex. */
function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Rebuilds the authored `content_scripts` array from crxjs's rewritten one.
 *
 * crxjs replaces each bundled entry's `js` with the emitted file (or loader)
 * name and preserves order and length, so walking the authored array in order -
 * taking a pre-built entry verbatim and consuming the next rewritten entry
 * otherwise - restores exactly the declaration order `manifest.config.ts`
 * documents as a contract. Re-inserting at the authored index rather than
 * prepending is what keeps a swap of the two entries visible in
 * `dist/manifest.json`, which is what lets `test/manifest.test.ts` fail on it.
 */
function mergeContentScripts(
  partition: ContentScriptPartition,
  rewritten: readonly ContentScript[],
): ContentScript[] {
  const merged: ContentScript[] = [];
  let cursor = 0;

  for (const [index, entry] of partition.authored.entries()) {
    if (partition.prebuilt[index] === true) {
      merged.push(structuredClone(entry));
      continue;
    }
    const built = rewritten[cursor];
    cursor += 1;
    if (built === undefined) {
      throw new Error(
        `Debug Generator: @crxjs/vite-plugin returned ${rewritten.length} content script(s) for ` +
          `${partition.bundled.length} bundled entr(ies); content_scripts[${index}] has no built ` +
          `counterpart, so the declaration order of dist/manifest.json cannot be reconstructed.`,
      );
    }
    merged.push(built);
  }

  if (cursor !== rewritten.length) {
    throw new Error(
      `Debug Generator: @crxjs/vite-plugin added ${rewritten.length - cursor} unexpected content ` +
        `script entr(ies). dist/manifest.json would not match manifest.config.ts, so the build is ` +
        `stopped rather than shipping a manifest nobody authored.`,
    );
  }

  return merged;
}

/**
 * Proves that every pre-built content script reached `dist/` byte for byte.
 *
 * Vite copies `public/` into the output directory at `renderStart`, before any
 * chunk is written, so by the time the bundle closes the copy is on disk. This
 * check is what turns "nothing is supposed to touch those bytes" into a
 * guarantee: a hashing rule, a transform or a same-named emitted asset that
 * replaced the agent bundle fails the build here instead of shipping an
 * extension whose MAIN-world script no longer matches what
 * `packages/telemetry` built and `scripts/copy-agent.mjs` installed.
 */
function assertPrebuiltFilesAreVerbatim(
  partition: ContentScriptPartition,
  publicDir: string,
  outDir: string,
): void {
  for (const [index, entry] of partition.authored.entries()) {
    if (partition.prebuilt[index] !== true) {
      continue;
    }
    for (const file of entry.js ?? []) {
      const source = path.resolve(publicDir, file);
      const emitted = path.resolve(outDir, file);
      if (!existsSync(emitted)) {
        throw new Error(
          `Debug Generator: pre-built content script "${file}" was not emitted to ${emitted}. ` +
            `It must be copied verbatim out of ${publicDir}; check that build.copyPublicDir and ` +
            `publicDir are unchanged.`,
        );
      }
      const expected = sha256(source);
      const actual = sha256(emitted);
      if (expected !== actual) {
        throw new Error(
          [
            `Debug Generator: pre-built content script "${file}" was modified by the build.`,
            ``,
            `  ${source}`,
            `    sha256 ${expected}`,
            `  ${emitted}`,
            `    sha256 ${actual}`,
            ``,
            `This file is the MAIN-world telemetry agent declared by content_scripts[${index}] and`,
            `must reach dist/ unchanged (see manifest.config.ts). Remove whatever transform,`,
            `minifier or asset-hashing rule now touches ${PUBLIC_DIR}/.`,
          ].join('\n'),
        );
      }
    }
  }
}

/**
 * Keeps the pre-built MAIN-world content script out of crxjs's hands and puts
 * it back, verbatim and at its authored index, in the manifest crxjs emits.
 *
 * `renderCrxManifest` is awaited for every resolved plugin inside crxjs's own
 * `generateBundle`, after the bundled entries' `js` have been rewritten to
 * output file names and before `manifest.json` is serialised - so the manifest
 * is correct in a single pass and no on-disk file is rewritten afterwards, which
 * is what makes `dist/manifest.json` byte-identical between consecutive builds.
 * `closeBundle` then verifies the copied bytes.
 *
 * `test/manifest.test.ts` is the test that proves both halves: it asserts the
 * two `content_scripts` entries, their worlds, `run_at`, `all_frames` and order
 * in the built manifest.
 *
 * Build-only, because the problem is build-only: crxjs's IIFE re-bundler is
 * itself `apply: 'build'`, and its dev-server path registers every declared
 * content script through its own loader mechanism instead. This workspace's
 * `dev` script is `vite build --watch`, which is a build, so the supported flow
 * is covered either way.
 */
function prebuiltContentScriptsPlugin(partition: ContentScriptPartition): CrxPlugin {
  let publicDir = path.resolve(workspaceRoot, PUBLIC_DIR);
  let outDir = path.resolve(workspaceRoot, OUT_DIR);
  // `closeBundle` also runs when bundling failed, before anything was emitted.
  // Verifying the copy then would throw a misleading "not emitted" error that
  // replaces the real one (an unresolved entry, say), so a failed build skips
  // the check. Reset per build, because `vite build --watch` rebuilds.
  let bundleFailed = false;

  return {
    name: 'debuggen:prebuilt-content-scripts',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      publicDir = config.publicDir;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    buildStart() {
      bundleFailed = false;
    },
    buildEnd(error) {
      if (error !== undefined) bundleFailed = true;
    },
    renderCrxManifest(manifest) {
      return {
        ...manifest,
        content_scripts: mergeContentScripts(partition, manifest.content_scripts ?? []),
      };
    },
    closeBundle(error) {
      if (error !== undefined) bundleFailed = true;
      if (bundleFailed) return;
      assertPrebuiltFilesAreVerbatim(partition, publicDir, outDir);
    },
  };
}

/**
 * The build. Asynchronous because `manifest.config.ts`'s default export may be
 * a function or a promise, and the content-script partition has to be known
 * before `crx()` is constructed.
 *
 * The return type is annotated rather than inferred: without a contextual type,
 * TypeScript widens `sourcemap: 'hidden'` and `target: 'chrome111'` to `string`,
 * the object stops matching `UserConfig`, and `defineConfig` reports the
 * mismatch as an unrelated overload failure.
 */
export default defineConfig(async (env): Promise<UserConfig> => {
  const manifest = await resolveAuthoredManifest(env);

  // Partitioned in every mode, so a content script that exists in neither the
  // project root nor public/ is reported the same way whoever loads this config.
  const contentScripts = partitionContentScripts(manifest);

  // The pre-built entries are withheld from crxjs on a build only, which is the
  // mode its IIFE re-bundler and prebuiltContentScriptsPlugin both run in; any
  // other mode receives the authored manifest exactly as written.
  const crxManifest =
    env.command === 'build' ? { ...manifest, content_scripts: contentScripts.bundled } : manifest;

  // Every bundled content script is built as a standalone, self-contained IIFE
  // (crxjs `contentScripts.standaloneFiles`) - measured, not assumed. A content
  // script chunk with any import or export is otherwise emitted as an async
  // loader that `import()`s a web-accessible module, and src/content/bridge.ts
  // both exports its test surface and shares src/shared/messages.ts with the
  // other surfaces. As a loader the bridge would start after page scripts, so
  // the handshake's "the bridge asks first, at document_start" guarantee
  // (packages/telemetry/src/browser/transport.ts) would not hold, and every
  // localhost page could fetch the extension's chunks. Derived from the
  // manifest, so no content-script path is written twice.
  const standaloneFiles = contentScripts.bundled.flatMap((entry) => entry.js ?? []);

  return {
    // Pinned so every emitted path is independent of the caller's directory.
    root: workspaceRoot,
    publicDir: PUBLIC_DIR,

    plugins: [
      // React first: the panel document and its components are JSX, and the
      // plugin's transform has to run before crxjs walks the module graph.
      react(),
      // manifest.config.ts remains the only manifest source; the sole edit is
      // the removal of the pre-built entries isPrebuiltEntry() identified, which
      // prebuiltContentScriptsPlugin puts back at their authored index.
      crx({ manifest: crxManifest, contentScripts: { standaloneFiles } }),
      prebuiltContentScriptsPlugin(contentScripts),
    ],

    resolve: {
      // One React instance across the panel and @debuggen/panel-renderer, which
      // declares react and react-dom as peers: two copies would break hooks in
      // every rendered component.
      dedupe: ['react', 'react-dom'],
    },

    build: {
      outDir: OUT_DIR,
      // Emptied on every build so a stale chunk can never mask a broken one in
      // the directory Chrome and Playwright load.
      emptyOutDir: true,
      target: BUILD_TARGET,

      // 'hidden', never true or 'inline' - measured, not assumed. crxjs wraps a
      // bundled content-script chunk that has no imports and no exports in an
      // IIFE by appending `})()` to the emitted code; with a trailing
      // `//# sourceMappingURL=...` line comment the appended `})()` lands inside
      // that comment, and `node --check` on the emitted bridge chunk reports
      // `SyntaxError: Unexpected end of input`. Chrome would refuse to run the
      // chunk, so the isolated-world bridge would silently never start and the
      // panel would look merely "quiet". An inline data-URI comment has exactly
      // the same shape and the same flaw. 'hidden' writes the .map files and
      // suppresses only the comment, so the maps stay on disk for stack-trace
      // resolution and no chunk can be corrupted. dist/ is git-ignored, so the
      // bytes cost nothing.
      sourcemap: 'hidden',

      // Not minified, which follows from 'hidden' above rather than from taste:
      // suppressing the sourcemap comment means Chrome DevTools does not load
      // the maps on its own, so a minified service worker or panel frame would
      // only ever show mangled names in a stack trace - in a debugging product,
      // for its own developers. Unminified output keeps those names readable
      // with the maps still available, and this bundle is loaded unpacked from
      // disk by one local browser, so its size is not a shipping concern.
      minify: false,

      // `rollupOptions` is Vite 8's supported alias for `rolldownOptions`, and it
      // is the field @crxjs/vite-plugin 2.7.1 itself reads; keeping the alias is
      // what makes the plugin see the same input map Vite does.
      rollupOptions: {
        // The panel document, which no manifest field references (see
        // PANEL_HTML). Merged with - not replacing - crxjs's inputs: crxjs emits
        // the manifest chunk, the service worker, the content scripts and the
        // devtools page through `emitFile`, so they are unaffected by this map.
        // Vite's HTML stripping of `rollupOptions.input` applies to the dev
        // server only (`crx:stub-input` gates it on `command === 'serve'`), so
        // the entry survives `vite build` and `vite build --watch`.
        input: {
          panel: path.resolve(workspaceRoot, PANEL_HTML),
        },
      },
    },
  };
});
