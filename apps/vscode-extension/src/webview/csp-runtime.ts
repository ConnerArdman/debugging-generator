/**
 * Start-up configuration the webview's content-security policy requires. `./main.tsx` imports this
 * module for its side effect as its first JavaScript import, so it is evaluated before any module
 * of the bundle that builds a schema.
 *
 * The policy `src/views/session-view-provider.ts` serves has no `'unsafe-eval'` (a per-load nonce
 * on the one module script, `default-src 'none'`). Zod 4 — reached transitively through the
 * `@debuggen/shared` and `@debuggen/panel-renderer` values `App` imports — builds a compiled fast
 * path for every object schema with `new Function`, after probing once whether that is allowed with
 * `new Function('')`. The probe is caught, so nothing breaks, but the browser still raises a
 * `securitypolicyviolation` and a "blocks the use of eval" issue in the webview developer tools on
 * every load. Zod's `jitless` option short-circuits both the probe and the compilation, leaving
 * validation on Zod's interpreted path — the only path a strict-CSP page may use anyway.
 *
 * The option is written through `globalThis.__zod_globalConfig`, the object Zod 4 adopts as its
 * `globalConfig` at load and reads `jitless` from each time a schema is constructed. `z.config()`
 * cannot be called instead: `zod` is not a dependency of this workspace, and gaining one for a
 * single flag would widen the import boundary of `apps/vscode-extension`. The existing object is
 * mutated rather than replaced, so the setting holds whether this module or Zod's core happens to
 * evaluate first.
 *
 * @module apps/vscode-extension/src/webview/csp-runtime
 */

/** The member of Zod 4's global configuration object this module sets. */
interface ZodGlobalConfig {
  jitless?: boolean;
}

/**
 * The global scope as Zod 4 leaves it. Reached by narrowing `globalThis`, as `./vscode-api` does
 * for `acquireVsCodeApi`, rather than through `declare global`: this program sets `types: []` and
 * an ambient global would leak into every module of it.
 */
interface ZodGlobalScope {
  __zod_globalConfig?: ZodGlobalConfig;
}

const scope = globalThis as ZodGlobalScope;
const zodGlobalConfig = (scope.__zod_globalConfig ??= {});
zodGlobalConfig.jitless = true;
