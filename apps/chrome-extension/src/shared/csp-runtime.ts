/**
 * Start-up configuration the extension's content-security policy requires. Every extension page
 * that validates with Zod - the panel (`../panel/main.tsx`) and the devtools page
 * (`../devtools/devtools.ts`) - imports this module for its side effect as its first JavaScript
 * import, and the bridge's build puts it first in the content-script bundle (`vite.config.ts`,
 * `standaloneContentScriptsPlugin`), so it is evaluated before any module that builds a schema.
 *
 * Manifest V3 extension pages run under `script-src 'self' 'wasm-unsafe-eval'`, which no manifest
 * may relax with `'unsafe-eval'`, and the ISOLATED-world bridge runs under an equally eval-free
 * extension policy inside the developer's page. Zod 4 - reached through `./messages` and the
 * `@debuggen/protocol` and `@debuggen/panel-schema` schemas it imports - builds a compiled fast
 * path for every object schema with `new Function`, after probing once whether that is allowed
 * with `new Function('')`. The probe is caught, so nothing breaks, but Chrome still raises a
 * "Content Security Policy of your site blocks the use of 'eval' in JavaScript" issue in DevTools
 * on every load: in the DevTools-on-DevTools window for the two pages, and in the developer's own
 * Issues panel for the bridge. Zod's `jitless` option short-circuits both the probe and the
 * compilation, leaving validation on Zod's interpreted path - the only path this policy permits
 * anyway.
 *
 * The option is written through `globalThis.__zod_globalConfig`, the object Zod 4 adopts as its
 * `globalConfig` at load and reads `jitless` from each time an object schema is constructed.
 * `z.config()` cannot be called instead: it would import Zod, and so evaluate it, from the one
 * module that has to run before Zod does. The existing object is mutated rather than replaced, so
 * the setting holds whether this module or Zod's core happens to evaluate first.
 *
 * Being first in a page's entry module is not enough on its own: the pages share Zod through a
 * separate chunk, and ES modules evaluate every imported chunk before the importing chunk's own
 * body. `vite.config.ts` therefore pins this module into a chunk of its own that each page imports
 * ahead of the Zod chunk, and fails the build if a chunking change ever reverses that order. The
 * VS Code webview applies the same setting in `apps/vscode-extension/src/webview/csp-runtime.ts`.
 *
 * This module imports nothing and has no other effect.
 *
 * @module apps/chrome-extension/src/shared/csp-runtime
 */

/** The member of Zod 4's global configuration object this module sets. */
interface ZodGlobalConfig {
  jitless?: boolean;
}

/**
 * The global scope as Zod 4 leaves it. Reached by narrowing `globalThis` rather than through
 * `declare global`, so no ambient `__zod_globalConfig` global leaks into every module of this
 * program.
 */
interface ZodGlobalScope {
  __zod_globalConfig?: ZodGlobalConfig;
}

const scope = globalThis as ZodGlobalScope;
const zodGlobalConfig = (scope.__zod_globalConfig ??= {});
zodGlobalConfig.jitless = true;
