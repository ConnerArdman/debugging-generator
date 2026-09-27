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
 * panel document, created at runtime by `chrome.devtools.panels.create`),
 * bundles the source-module content script (the bridge) into a standalone IIFE
 * itself rather than through crxjs, and enforces the build invariants the
 * manifest depends on but cannot enforce itself - the verbatim pass-through of
 * the pre-built MAIN-world agent bundle, the declaration order of
 * `content_scripts`, and the evaluation of `src/shared/csp-runtime.ts` ahead of
 * Zod on every extension page.
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
import {
  build,
  defineConfig,
  normalizePath,
  type ConfigEnv,
  type Plugin,
  type ResolvedConfig,
  type Rolldown,
  type UserConfig,
} from 'vite';

/**
 * The single source of the manifest, imported WITH its `.ts` extension. Vite's
 * `native` config loader - planned to become the default - hands this file to
 * Node's own ESM loader, which resolves no extensionless relative specifier, so
 * Vite 8's default loader reports an extensionless import here as unsupported
 * on every build. The explicit extension resolves under both loaders; the
 * workspace tsconfig enables `allowImportingTsExtensions` for it, which is
 * legal because that program emits declarations only.
 */
import authoredManifest from './manifest.config.ts';

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
 * touch them; `assertPrebuiltFilesAreVerbatim` proves it after every successful
 * write of `dist/`.
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
 * Oxc minifier settings for every JavaScript file this build emits - the panel,
 * the devtools page, the service worker and the standalone content scripts.
 * `build.minify: 'oxc'` alone would hand Rolldown `minify: true`; this object
 * replaces that default (Vite spreads `rollupOptions.output` over its own
 * output options) and differs from it in one respect only: names survive.
 *
 * `keepNames` preserves the `name` of every function and class through both
 * compression and mangling. `build.sourcemap` is `'hidden'`, so Chrome DevTools
 * never loads a map on its own, and a stack trace from the service worker, the
 * panel or the bridge has to stay legible without one: with names kept, every
 * frame names the function or class the source declares instead of a
 * one-letter mangled identifier, and a `name` read at run time (an error class,
 * a constructor) still returns the authored value. Local variables are still
 * mangled and whitespace is still stripped, which is where the size goes.
 * Measured against the unminified baseline, the panel entry drops from 1,710 kB
 * to 759 kB, the shared `messages` chunk from 630 kB to 279 kB, the service
 * worker from 392 kB to 131 kB and the bridge from 563 kB to 234 kB. The `.map`
 * files are still written for stack-trace resolution.
 *
 * `public/` never passes through this minifier: Vite copies it verbatim, which
 * is what keeps `dist/agent.iife.js` byte-identical to the telemetry build (see
 * {@link PUBLIC_DIR}).
 */
const MINIFY: Rolldown.MinifyOptions = {
  compress: { keepNames: { function: true, class: true } },
  mangle: { keepNames: true },
  codegen: true,
};

/**
 * The size budget of the largest emitted chunk, in kB, as Vite's
 * `build.chunkSizeWarningLimit` measures it (minified bytes / 1000). 1,500 kB
 * is the DevTools panel budget this extension is held to. It replaces Vite's
 * 500 kB default so a build inside the budget is warning-free, and it is a
 * budget rather than a silencer: a chunk that outgrows it still prints Vite's
 * "(!) Some chunks are larger than ..." warning.
 */
const CHUNK_SIZE_BUDGET_KB = 1500;

/**
 * The module that switches Zod 4 to its jitless path before any schema is
 * built, so the extension CSP raises no `eval` issue (see the module itself).
 * The panel and the devtools page import it first; the standalone content
 * scripts get it as the first import of their virtual entry.
 */
const CSP_RUNTIME_MODULE = 'src/shared/csp-runtime.ts';

/** {@link CSP_RUNTIME_MODULE} as Vite and Rolldown identify it: absolute, `/`-separated. */
const CSP_RUNTIME_ID = normalizePath(path.resolve(workspaceRoot, CSP_RUNTIME_MODULE));

/**
 * The chunk {@link CSP_RUNTIME_MODULE} is pinned into. Being the first import of
 * a page's entry module is not enough on its own: Zod lives in a chunk the
 * pages share, and ES modules evaluate every chunk a chunk imports before that
 * chunk's own body, so a setting inlined into the panel's entry chunk would run
 * after Zod. As a chunk of its own it is an import of the entry chunk, emitted
 * and evaluated ahead of the Zod chunk. Rolldown orders a chunk's imports by
 * the bundle's overall execution order rather than by each importer's source
 * order, so {@link assertCspRuntimeRunsFirst} proves the order on the emitted
 * chunk graph of every build instead of trusting the sources. The test is
 * anchored to the module's exact id, so no other module can join the chunk;
 * the priority puts the group ahead of any other that could claim it.
 */
const CSP_RUNTIME_CHUNK_GROUP: Rolldown.CodeSplittingGroup = {
  name: 'csp-runtime',
  test: new RegExp(`^${CSP_RUNTIME_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  priority: 1000,
};

/** A module of the `zod` package, whichever physical path pnpm gave it. */
const ZOD_MODULE = /[\\/]node_modules[\\/]zod[\\/]/;

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
 * How the build treats one authored `content_scripts` entry.
 *
 *   - `prebuilt`: every `js` file is a verbatim asset in `public/`; it is never
 *     transformed, and the entry reaches the built manifest unchanged.
 *   - `standalone`: every `js` file is a source module; this config bundles
 *     each one into a self-contained IIFE (see
 *     {@link standaloneContentScriptsPlugin}) and the entry reaches the built
 *     manifest with only its `js` paths rewritten.
 *   - `crxjs`: a CSS-only entry; @crxjs/vite-plugin emits and rewrites it.
 */
type EntryTreatment = 'prebuilt' | 'standalone' | 'crxjs';

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
 * Decides the {@link EntryTreatment} of one authored entry. No entry that
 * declares a `js` file is ever handed to @crxjs/vite-plugin.
 *
 * WHY PRE-BUILT ENTRIES ARE WITHHELD - measured against @crxjs/vite-plugin
 * 2.7.1 and Vite 8.3.0, not assumed. The plugin's internal
 * `crx:content-scripts-iife` claims every content script whose file name
 * matches `/\.iife\.(ts|tsx|js|jsx|mjs|cjs)$/`
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
 * WHY SOURCE-MODULE ENTRIES ARE WITHHELD - also measured. A source-module
 * content script must be one self-contained IIFE (see
 * {@link standaloneContentScriptsPlugin} for why a crxjs loader is not
 * acceptable), and crxjs's only route to that output is
 * `contentScripts.standaloneFiles`, whose nested library build hardcodes
 * `rollupOptions.output.inlineDynamicImports: true`. Vite 8 sets
 * `codeSplitting: false` for every IIFE output, so each build printed
 * "inlineDynamicImports option is ignored because codeSplitting: false is set"
 * and no crxjs option removes it. This config therefore builds those entries
 * itself, with the same output and without the conflicting option.
 *
 * A mixed entry is rejected rather than guessed at: the two kinds need opposite
 * treatment, so combining them in one entry has no correct build. A
 * source-module entry that also declares `css` is rejected too: its stylesheet
 * would reach crxjs only with the entry itself, and that stylesheet belongs in
 * a CSS-only entry of its own, which crxjs does emit.
 */
function classifyEntry(entry: ContentScript, index: number): EntryTreatment {
  const files = entry.js ?? [];
  if (files.length === 0) {
    // A CSS-only entry has nothing to bundle and nothing to copy; crxjs owns it.
    return 'crxjs';
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
        `bundled into a standalone IIFE; one entry cannot receive both treatments. Split`,
        `them into separate content_scripts entries in manifest.config.ts.`,
      ].join('\n'),
    );
  }
  if (prebuilt.length > 0) {
    return 'prebuilt';
  }

  if ((entry.css ?? []).length > 0) {
    throw new Error(
      [
        `Debug Generator: content_scripts[${index}] declares both source modules and css.`,
        ``,
        ...files.map((file) => `  js  ${file}`),
        ...(entry.css ?? []).map((file) => `  css ${file}`),
        ``,
        `vite.config.ts bundles a source-module content script itself, outside`,
        `@crxjs/vite-plugin, so a stylesheet in the same entry would never be emitted.`,
        `Move the css into a CSS-only content_scripts entry with the same matches in`,
        `manifest.config.ts; @crxjs/vite-plugin emits that one.`,
      ].join('\n'),
    );
  }
  return 'standalone';
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
 * The authored `content_scripts` array split by {@link EntryTreatment}: the
 * part @crxjs/vite-plugin builds, the part this config bundles itself and the
 * part it passes through untouched.
 */
interface ContentScriptPartition {
  /** The authored entries, in the order `manifest.config.ts` declares them. */
  readonly authored: readonly ContentScript[];
  /** Index-aligned treatment of each authored entry. */
  readonly treatments: readonly EntryTreatment[];
  /** The entries handed to crxjs, in authored order: the CSS-only ones. */
  readonly bundled: ContentScript[];
  /**
   * Every source-module `js` file of a `standalone` entry, once each, in
   * authored order - the inputs of {@link standaloneContentScriptsPlugin}.
   */
  readonly standaloneFiles: readonly string[];
}

/**
 * The file a standalone content script is emitted as, relative to `dist/`:
 * its declared directory and base name with a `.js` extension, so
 * `src/content/bridge.ts` becomes `src/content/bridge.js`. This is exactly the
 * name @crxjs/vite-plugin's IIFE build gave it, so the built manifest names the
 * same file it always has.
 */
function standaloneOutputName(file: string): string {
  const { dir, name } = path.posix.parse(file.replace(/^\/+/, ''));
  return dir === '' ? `${name}.js` : `${dir}/${name}.js`;
}

/**
 * Splits the authored entries; see {@link classifyEntry} for the criterion.
 *
 * @throws Error when two different source modules would be emitted under one
 *   file name (`a.ts` and `a.tsx`), or one would overwrite a pre-built asset,
 *   because the manifest could then name only one of them.
 */
function partitionContentScripts(manifest: ResolvedManifest): ContentScriptPartition {
  const authored = manifest.content_scripts ?? [];
  const treatments = authored.map(classifyEntry);
  const standaloneFiles = [
    ...new Set(
      authored.flatMap((entry, index) =>
        treatments[index] === 'standalone' ? (entry.js ?? []) : [],
      ),
    ),
  ];

  const claimed = new Map<string, string>();
  authored.forEach((entry, index) => {
    if (treatments[index] === 'prebuilt') {
      for (const file of entry.js ?? []) {
        claimed.set(file.replace(/^\/+/, ''), `${PUBLIC_DIR}/${file}`);
      }
    }
  });
  for (const file of standaloneFiles) {
    const output = standaloneOutputName(file);
    const owner = claimed.get(output);
    if (owner !== undefined) {
      throw new Error(
        `Debug Generator: content script "${file}" would be emitted as dist/${output}, which ` +
          `${owner} already occupies. Rename one of them in manifest.config.ts.`,
      );
    }
    claimed.set(output, file);
  }

  return {
    authored,
    treatments,
    bundled: authored.filter((_, index) => treatments[index] === 'crxjs'),
    standaloneFiles,
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
 * taking a pre-built entry verbatim, taking a standalone entry verbatim except
 * for its `js`, which becomes the files {@link standaloneContentScriptsPlugin}
 * emitted, and consuming the next rewritten entry otherwise - restores exactly
 * the declaration order `manifest.config.ts` documents as a contract.
 * Re-inserting at the authored index rather than prepending is what keeps a
 * swap of the two entries visible in `dist/manifest.json`, which is what lets
 * `test/manifest.test.ts` fail on it.
 */
function mergeContentScripts(
  partition: ContentScriptPartition,
  rewritten: readonly ContentScript[],
): ContentScript[] {
  const merged: ContentScript[] = [];
  let cursor = 0;

  for (const [index, entry] of partition.authored.entries()) {
    const treatment = partition.treatments[index];
    if (treatment === 'prebuilt') {
      merged.push(structuredClone(entry));
      continue;
    }
    if (treatment === 'standalone') {
      merged.push({ ...structuredClone(entry), js: (entry.js ?? []).map(standaloneOutputName) });
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
 * chunk is written, and Rolldown calls `writeBundle` - where this runs - only
 * once `bundle.write()` has written every file, so the copy is on disk. This
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
    if (partition.treatments[index] !== 'prebuilt') {
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
 * Prefix of the virtual module that is the entry of one standalone content
 * script's build; the declared file follows it. Resolved under Rollup's `\0`
 * convention, so no other plugin tries to read it from disk.
 */
const STANDALONE_ENTRY_PREFIX = 'debuggen:content-script:';

/**
 * A valid JavaScript identifier derived from an output file name. Vite requires
 * `build.lib.name` for the `iife` format; the entry exports nothing, so the
 * emitted IIFE assigns no global under this name.
 */
function iifeGlobalName(outputName: string): string {
  const base = path.posix.basename(outputName, '.js').replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[A-Za-z_$]/.test(base) ? base : `_${base}`;
}

/**
 * Serves the virtual entry of one standalone content-script build: a module
 * that imports each of `modules` for its side effects, in the given order,
 * which is the order they evaluate in inside the emitted IIFE.
 */
function standaloneEntryPlugin(entryId: string, modules: readonly string[]): Plugin {
  const resolvedId = `\0${entryId}`;
  const code = modules.map((module) => `import ${JSON.stringify(module)};`).join('\n');
  return {
    name: 'debuggen:standalone-content-script-entry',
    resolveId(id) {
      return id === entryId ? resolvedId : null;
    },
    load(id) {
      return id === resolvedId ? code : null;
    },
  };
}

/** What one standalone content-script build produced. */
interface StandaloneBuild {
  /** The self-contained IIFE. */
  readonly code: string;
  /** Its source map, when `build.sourcemap` asked for one. */
  readonly map: string | Uint8Array | undefined;
  /** The on-disk modules bundled into it, for `vite build --watch`. */
  readonly watchFiles: readonly string[];
}

/**
 * Bundles one source-module content script into a single self-contained IIFE
 * with a nested Vite library build that is never written to disk: its output
 * is returned to {@link standaloneContentScriptsPlugin}, which emits it into
 * the parent bundle. The virtual entry imports {@link CSP_RUNTIME_MODULE}
 * before the declared file, so inside the one IIFE the jitless setting
 * precedes every Zod module.
 *
 * The nested build inherits exactly what shapes the emitted code - root, mode,
 * log level, syntax target, sourcemap mode and chunk-size budget - from the
 * parent's resolved config, and uses the same {@link MINIFY} settings. It loads
 * no config file (so this file is never re-entered), has no public directory
 * and runs no plugin but its virtual entry. It sets no
 * `inlineDynamicImports`: Vite 8 already emits an IIFE without code splitting,
 * so every dynamic import is inlined, and restating the option is exactly the
 * conflict that made crxjs's equivalent build warn.
 *
 * @throws Error when the build yields no entry chunk, when the CSP runtime is
 *   missing from it or evaluates after a Zod module, or when it yields a file
 *   the manifest could not name (a CSS asset, a second chunk), since Chrome
 *   would never load it.
 */
async function buildStandaloneContentScript(
  config: ResolvedConfig,
  file: string,
  outputName: string,
): Promise<StandaloneBuild> {
  const entryId = `${STANDALONE_ENTRY_PREFIX}${file}`;
  // The CSP runtime first, so Zod runs jitless inside the developer's page and
  // its eval probe raises no CSP issue there; then the declared module.
  const modules = [CSP_RUNTIME_ID, normalizePath(path.resolve(config.root, file))];

  const result = await build({
    configFile: false,
    root: config.root,
    mode: config.mode,
    // Omitted rather than passed as undefined when the parent set none, so the
    // nested build falls back to the same default the parent resolved.
    ...(config.logLevel === undefined ? {} : { logLevel: config.logLevel }),
    publicDir: false,
    plugins: [standaloneEntryPlugin(entryId, modules)],
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      target: config.build.target,
      sourcemap: config.build.sourcemap,
      minify: 'oxc',
      chunkSizeWarningLimit: config.build.chunkSizeWarningLimit,
      lib: {
        entry: entryId,
        formats: ['iife'],
        name: iifeGlobalName(outputName),
        fileName: () => outputName,
      },
      rollupOptions: {
        // Given explicitly because Vite would otherwise resolve `lib.entry`
        // against the root as a file path, which a virtual id is not.
        input: entryId,
        output: {
          entryFileNames: outputName,
          minify: MINIFY,
        },
      },
    },
  });

  const outputs = (Array.isArray(result) ? result : [result]).flatMap((each) => {
    if (!('output' in each)) {
      throw new Error(
        `Debug Generator: the build of content script "${file}" started a watcher instead of ` +
          `returning its output; the nested build must not set build.watch.`,
      );
    }
    return each.output;
  });

  const entry = outputs.find(
    (output): output is Rolldown.OutputChunk => output.type === 'chunk' && output.isEntry,
  );
  if (entry === undefined) {
    throw new Error(
      `Debug Generator: the build of content script "${file}" produced no entry chunk, so ` +
        `dist/${outputName} cannot be emitted.`,
    );
  }

  // `moduleIds` lists the chunk's modules in the order they are rendered, which
  // inside one IIFE is the order they evaluate in.
  const runtimeIndex = entry.moduleIds.indexOf(CSP_RUNTIME_ID);
  const firstZodIndex = entry.moduleIds.findIndex((id) => ZOD_MODULE.test(id));
  if (runtimeIndex === -1 || (firstZodIndex !== -1 && firstZodIndex < runtimeIndex)) {
    throw new Error(
      `Debug Generator: in the build of content script "${file}", ${CSP_RUNTIME_MODULE} ` +
        (runtimeIndex === -1 ? 'is missing' : 'evaluates after Zod') +
        `, so Zod's eval probe would raise a CSP issue in every page the script runs in.`,
    );
  }

  const mapName = entry.sourcemapFileName ?? `${entry.fileName}.map`;
  const mapAsset = outputs.find(
    (output): output is Rolldown.OutputAsset =>
      output.type === 'asset' && output.fileName === mapName,
  );
  const unexpected = outputs.filter((output) => output !== entry && output !== mapAsset);
  if (unexpected.length > 0) {
    throw new Error(
      [
        `Debug Generator: the build of content script "${file}" emitted files beyond its one`,
        `IIFE and source map:`,
        ``,
        ...unexpected.map((output) => `  ${output.fileName}`),
        ``,
        `The manifest names only dist/${outputName}, so Chrome would never load them. A content`,
        `script stylesheet belongs in a CSS-only content_scripts entry in manifest.config.ts.`,
      ].join('\n'),
    );
  }

  return {
    code: entry.code,
    map: mapAsset?.source ?? entry.map?.toString(),
    // Absolute on-disk ids only: virtual modules have none, and anything under
    // node_modules changes only through an install, which restarts the watch.
    // Workspace packages resolve to their real paths outside node_modules, so
    // a rebuilt @debuggen/* dependency still triggers a rebuild.
    watchFiles: entry.moduleIds
      .map((id) => id.split('?', 1)[0] ?? id)
      .filter((id) => path.isAbsolute(id) && !/[\\/]node_modules[\\/]/.test(id)),
  };
}

/**
 * Builds every source-module content script as one self-contained IIFE and
 * emits it into the bundle under the name {@link standaloneOutputName} gives
 * it (`src/content/bridge.ts` -> `dist/src/content/bridge.js`), with its map
 * beside it; {@link prebuiltContentScriptsPlugin} then writes that name into
 * the built manifest at the entry's authored index.
 *
 * WHY AN IIFE - measured, not assumed. A content-script chunk with any import
 * or export is otherwise emitted by crxjs as an async loader that `import()`s a
 * web-accessible module, and src/content/bridge.ts both exports its test
 * surface and shares src/shared/messages.ts with the other surfaces. As a
 * loader the bridge would start after page scripts, so the handshake's "the
 * bridge asks first, at document_start" guarantee
 * (packages/telemetry/src/browser/transport.ts) would not hold, and every
 * localhost page could fetch the extension's chunks.
 *
 * WHY HERE AND NOT IN CRXJS - see {@link classifyEntry}: crxjs's own IIFE
 * build of the same files hardcodes an option Vite 8 ignores and warns about
 * on every build.
 *
 * The nested builds run from `buildStart`, before the parent graph is built, so
 * a failure stops the build before anything is written; every on-disk module
 * they bundled is registered with `addWatchFile`, so `vite build --watch`
 * (this workspace's `dev` script) rebuilds the bridge when any of its sources
 * changes, `src/content/bridge.ts` included, which the parent graph does not
 * contain.
 *
 * Build-only, like {@link prebuiltContentScriptsPlugin}: on the dev server the
 * authored manifest reaches crxjs unchanged and crxjs serves the entry.
 */
function standaloneContentScriptsPlugin(partition: ContentScriptPartition): Plugin {
  let resolvedConfig: ResolvedConfig | undefined;

  return {
    name: 'debuggen:standalone-content-scripts',
    apply: 'build',
    configResolved(config) {
      resolvedConfig = config;
    },
    async buildStart() {
      const config = resolvedConfig;
      if (config === undefined) {
        throw new Error(
          'Debug Generator: debuggen:standalone-content-scripts ran buildStart before ' +
            'configResolved, so the content scripts cannot inherit the build settings.',
        );
      }
      for (const file of partition.standaloneFiles) {
        const fileName = standaloneOutputName(file);
        const built = await buildStandaloneContentScript(config, file, fileName);
        for (const id of built.watchFiles) {
          this.addWatchFile(id);
        }
        this.emitFile({ type: 'asset', fileName, source: built.code });
        if (built.map !== undefined) {
          this.emitFile({ type: 'asset', fileName: `${fileName}.map`, source: built.map });
        }
      }
    },
  };
}

/**
 * Proves, from the emitted chunk graph, that every extension page evaluates
 * {@link CSP_RUNTIME_MODULE} before any Zod module - the ordering the CSP fix
 * depends on and that no type check can see (`test/csp-runtime.test.ts`
 * re-checks the written `dist/` independently):
 *
 *   1. the module sits alone in exactly one chunk that imports nothing, so
 *      evaluating that chunk evaluates nothing else first;
 *   2. every chunk that imports it lists no import ahead of it that reaches a
 *      Zod module, directly or transitively - ES modules evaluate a chunk's
 *      static imports in order, before its own body;
 *   3. every HTML page entry (the panel, the devtools page) whose chunk graph
 *      reaches Zod imports it directly.
 *
 * A failure names the chunks involved and throws, so a chunking change, a
 * reordered import or a page added without the runtime fails the build instead
 * of bringing back an `eval` issue on every DevTools open. Chunks that never
 * import it and are not pages - the service worker - are not checked.
 */
function assertCspRuntimeRunsFirst(bundle: Rolldown.OutputBundle): void {
  const chunks = new Map<string, Rolldown.OutputChunk>();
  for (const output of Object.values(bundle)) {
    if (output.type === 'chunk') {
      chunks.set(output.fileName, output);
    }
  }

  // A plain depth-first walk per question: a bundle has a handful of chunks,
  // and a per-walk `seen` set stays correct across import cycles, where a
  // memoised provisional answer would not.
  const reachesZod = (fileName: string, seen = new Set<string>()): boolean => {
    if (seen.has(fileName)) {
      return false;
    }
    seen.add(fileName);
    const chunk = chunks.get(fileName);
    return (
      chunk !== undefined &&
      (chunk.moduleIds.some((id) => ZOD_MODULE.test(id)) ||
        chunk.imports.some((imported) => reachesZod(imported, seen)))
    );
  };

  const fail = (lines: readonly string[]): never => {
    throw new Error(
      [
        ...lines,
        ``,
        `${CSP_RUNTIME_MODULE} must be evaluated before Zod on every extension page, or Zod's`,
        `eval probe raises a CSP issue on every load. Keep it the first JavaScript import of`,
        `src/panel/main.tsx and src/devtools/devtools.ts, and keep CSP_RUNTIME_CHUNK_GROUP in`,
        `vite.config.ts.`,
      ].join('\n'),
    );
  };

  const hosts = [...chunks.values()].filter((chunk) => chunk.moduleIds.includes(CSP_RUNTIME_ID));
  if (hosts.length > 1) {
    fail([
      `Debug Generator: ${CSP_RUNTIME_MODULE} was emitted into ${hosts.length} chunks ` +
        `(${hosts.map((chunk) => chunk.fileName).join(', ')}).`,
    ]);
  }
  const runtime = hosts[0];
  if (
    runtime !== undefined &&
    (runtime.moduleIds.length !== 1 || runtime.imports.length !== 0 || runtime.isEntry)
  ) {
    fail([
      `Debug Generator: ${CSP_RUNTIME_MODULE} is not alone in its chunk ${runtime.fileName}:`,
      ``,
      ...runtime.moduleIds.map((id) => `  module ${id}`),
      ...runtime.imports.map((id) => `  import ${id}`),
    ]);
  }

  for (const chunk of chunks.values()) {
    const position = runtime === undefined ? -1 : chunk.imports.indexOf(runtime.fileName);
    if (position > 0) {
      const earlier = chunk.imports.slice(0, position).filter((imported) => reachesZod(imported));
      if (earlier.length > 0) {
        fail([
          `Debug Generator: ${chunk.fileName} imports ${earlier.join(', ')} - which reach(es) Zod -`,
          `before ${runtime?.fileName ?? CSP_RUNTIME_MODULE}.`,
        ]);
      }
    }
    const isPage = chunk.isEntry && (chunk.facadeModuleId?.endsWith('.html') ?? false);
    if (isPage && position === -1 && reachesZod(chunk.fileName)) {
      fail([
        `Debug Generator: the page entry ${chunk.fileName} (${chunk.facadeModuleId ?? ''}) loads`,
        `Zod but does not import the ${CSP_RUNTIME_MODULE} chunk.`,
      ]);
    }
  }
}

/**
 * Runs {@link assertCspRuntimeRunsFirst} over the finished bundle. `generateBundle`
 * with `order: 'post'` sees every chunk after all plugins - crxjs included -
 * have added theirs and before any chunk is written, so no chunk of a
 * violating bundle ever reaches `dist/`.
 */
function cspRuntimeOrderPlugin(): Plugin {
  return {
    name: 'debuggen:csp-runtime-order',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        assertCspRuntimeRunsFirst(bundle);
      },
    },
  };
}

/**
 * Puts the content scripts withheld from crxjs back into the manifest crxjs
 * emits, each at its authored index: the pre-built MAIN-world agent verbatim,
 * and every standalone entry with its `js` rewritten to the files
 * {@link standaloneContentScriptsPlugin} emitted.
 *
 * `renderCrxManifest` is awaited for every resolved plugin inside crxjs's own
 * `generateBundle`, after the bundled entries' `js` have been rewritten to
 * output file names and before `manifest.json` is serialised - so the manifest
 * is correct in a single pass and no on-disk file is rewritten afterwards, which
 * is what makes `dist/manifest.json` byte-identical between consecutive builds.
 * `writeBundle` then verifies the copied bytes.
 *
 * `writeBundle` is the one hook whose call proves the emission succeeded:
 * Rolldown calls it only at the end of a `bundle.write()` that wrote every
 * file, after `vite:prepare-out-dir` emptied `dist/` and copied `public/` into
 * it at `renderStart`. `closeBundle` is the wrong stage - measured against Vite
 * 8.3.0 and Rolldown 1.2.9, not assumed. Vite calls `bundle.close()` from a
 * `finally` block, so `closeBundle` runs after a failed build too, and an
 * output-stage failure - one thrown from `renderStart`, `renderChunk`,
 * `generateBundle` or `writeBundle` - reaches neither `buildEnd` nor
 * `closeBundle` as an error (Rolldown reports the first two to `renderError`
 * alone). Verifying in `closeBundle` after a `renderStart` failure that preceded
 * the `public/` copy threw "was not emitted", and that throw from the `finally`
 * replaced the build's real error. A failed build never reaches `writeBundle`,
 * so its own error is the one reported, and no per-build failure state has to
 * be reset between `vite build --watch` rebuilds. `order: 'post'` runs the
 * check after every other plugin's `writeBundle` (Rolldown runs that hook's
 * handlers one after another), so a plugin that rewrites `dist/` from its own
 * `writeBundle` is still caught. A `build.write: false` build neither writes
 * nor copies anything, and is therefore not checked.
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

  return {
    name: 'debuggen:prebuilt-content-scripts',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      publicDir = config.publicDir;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    renderCrxManifest(manifest) {
      return {
        ...manifest,
        content_scripts: mergeContentScripts(partition, manifest.content_scripts ?? []),
      };
    },
    // Reached only by a write that succeeded, and last among the plugins'
    // writeBundle handlers; see the JSDoc above for why this is not closeBundle.
    writeBundle: {
      order: 'post',
      handler() {
        assertPrebuiltFilesAreVerbatim(partition, publicDir, outDir);
      },
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

  // The pre-built and the standalone entries are withheld from crxjs on a build
  // only, which is the mode its IIFE re-bundler and the two content-script
  // plugins below all run in; crxjs is left the CSS-only entries. Any other
  // mode receives the authored manifest exactly as written.
  const crxManifest =
    env.command === 'build' ? { ...manifest, content_scripts: contentScripts.bundled } : manifest;

  return {
    // Pinned so every emitted path is independent of the caller's directory.
    root: workspaceRoot,
    publicDir: PUBLIC_DIR,

    plugins: [
      // React first: the panel document and its components are JSX, and the
      // plugin's transform has to run before crxjs walks the module graph.
      react(),
      // manifest.config.ts remains the only manifest source; the sole edit is
      // the removal of the entries classifyEntry() withholds, which
      // prebuiltContentScriptsPlugin puts back at their authored index. No
      // `contentScripts.standaloneFiles`: standaloneContentScriptsPlugin builds
      // those files, without the option crxjs's own build warns about.
      crx({ manifest: crxManifest }),
      standaloneContentScriptsPlugin(contentScripts),
      prebuiltContentScriptsPlugin(contentScripts),
      cspRuntimeOrderPlugin(),
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

      // 'hidden': maps written, never linked. Every emitted .js file gets its
      // .map beside it for stack-trace resolution, and no file carries a
      // `//# sourceMappingURL=` comment, so Chrome DevTools never fetches one
      // on its own. That matters most for the bridge, which runs inside every
      // localhost page a developer debugs: a linked map would have DevTools on
      // that page fetch and list this extension's TypeScript sources beside
      // the developer's own. standaloneContentScriptsPlugin passes the same
      // mode to the bridge's nested build. dist/ is git-ignored, so the bytes
      // cost nothing.
      sourcemap: 'hidden',

      // Minified with Oxc, names kept. 'hidden' above means Chrome DevTools
      // does not load the maps on its own, so the output must stay debuggable
      // without them: MINIFY keeps every function and class name through
      // compression and mangling, so a stack trace from the service worker or
      // the panel still names the code that threw, and only local identifiers
      // and whitespace are removed. That is what brings the panel entry inside
      // CHUNK_SIZE_BUDGET_KB. `rollupOptions.output.minify` below carries the
      // settings; this switch is what turns the Oxc minifier on at all. Vite
      // derives `cssMinify` from it, so the panel stylesheet is minified too;
      // custom-property names such as `--dg-*` survive CSS minification, and
      // no check reads this stylesheet's text (the VS Code webview's
      // `main.css`, which is grepped for its token contract, opts out).
      minify: 'oxc',

      // The panel budget, not a silencer: see CHUNK_SIZE_BUDGET_KB.
      chunkSizeWarningLimit: CHUNK_SIZE_BUDGET_KB,

      // `rollupOptions` is Vite 8's supported alias for `rolldownOptions`, and it
      // is the field @crxjs/vite-plugin 2.7.1 itself reads; keeping the alias is
      // what makes the plugin see the same input map Vite does.
      rollupOptions: {
        // The panel document, which no manifest field references (see
        // PANEL_HTML). Merged with - not replacing - crxjs's inputs: crxjs emits
        // the manifest chunk, the service worker and the devtools page through
        // `emitFile` (the content scripts come from the two plugins above), so
        // they are unaffected by this map.
        // Vite's HTML stripping of `rollupOptions.input` applies to the dev
        // server only (`crx:stub-input` gates it on `command === 'serve'`), so
        // the entry survives `vite build` and `vite build --watch`.
        input: {
          panel: path.resolve(workspaceRoot, PANEL_HTML),
        },
        output: {
          // Replaces the `minify: true` that `build.minify: 'oxc'` implies with
          // the names-preserving settings documented on MINIFY.
          minify: MINIFY,
          // One pinned chunk and otherwise Rolldown's default splitting: see
          // CSP_RUNTIME_CHUNK_GROUP, and cspRuntimeOrderPlugin for the proof.
          codeSplitting: { groups: [CSP_RUNTIME_CHUNK_GROUP] },
        },
      },
    },
  };
});
