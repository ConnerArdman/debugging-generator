/**
 * Manifest V3 manifest for the "Debug Generator" Chrome extension.
 *
 * This module is the single source of the manifest. `vite.config.ts` hands the
 * default export to `crx({ manifest })` and @crxjs/vite-plugin writes
 * `dist/manifest.json` - the directory a developer loads unpacked and the one
 * the Playwright `browser` project passes to `--load-extension`. Every value
 * below is asserted field by field against that built file by
 * `test/manifest.test.ts`, so a change here is a change to a tested contract.
 *
 * The surfaces declared, and deliberately no others:
 *   - a DevTools page, which contributes the "Debug Generator" panel;
 *   - a module service worker, which owns the authenticated WebSocket to the
 *     local service, the tab-to-session registry and the arming of the page
 *     agent;
 *   - two statically declared `document_start` content scripts on the local app
 *     origins: the pre-built MAIN-world telemetry agent, then the
 *     ISOLATED-world bridge.
 *
 * Not declared: `action`/`default_popup`, `options_page`, `omnibox`,
 * `commands`, `externally_connectable` and `web_accessible_resources`. The
 * extension has no such surface, and each one would widen the permission
 * boundary documented in `docs/SECURITY.md`. A manifest-declared content script
 * is injected by Chrome from the extension package, so the MAIN-world agent
 * needs no web-accessible-resource entry, and neither does the bridge:
 * `vite.config.ts` builds it as one self-contained IIFE, so it imports no chunk
 * a page would have to be able to fetch.
 *
 * Declared although it adds no surface: `content_security_policy`, which
 * narrows the boundary instead of widening it. Every extension page runs under
 * the deny-by-default policy {@link EXTENSION_PAGES_CSP} rather than Chrome's
 * default one, which restricts scripts and plugins only.
 */
import { defineManifest } from '@crxjs/vite-plugin';

/**
 * Kept in lockstep with this workspace's `package.json` `version`, and written
 * as a literal on purpose: importing `package.json` would add a JSON input to a
 * program whose tsconfig admits exactly four roots. `test/manifest.test.ts`
 * compares the built manifest's `version` against `package.json`, so drift
 * fails the suite instead of shipping.
 */
const VERSION = '0.1.0';

/**
 * The local origins a developer's dev server is reachable on, addressed both
 * ways Chrome resolves it. Generic by requirement - never a project-specific
 * port, path, route or identifier (AAP 0.5.4, `scripts/check-no-hardcoding.mjs`
 * scans this workspace as product source).
 *
 * The same two patterns appear as `host_permissions` and as each content
 * script's `matches`, because they answer different questions: `matches` selects
 * the pages the scripts are injected into, while the host permission is what
 * makes a manifest-declared `world: "MAIN"` script legal on those origins at
 * all. Spread at every use site so no two manifest fields share one mutable
 * array.
 */
const LOCAL_APP_ORIGINS = ['http://localhost/*', 'http://127.0.0.1/*'] as const;

/**
 * The directives of {@link EXTENSION_PAGES_CSP}, one per entry, in the order
 * the policy string lists them.
 */
const EXTENSION_PAGES_CSP_DIRECTIVES = [
  // Deny by default. Every fetch directive not named below falls back to this
  // one - `font-src`, `frame-src`, `media-src`, `manifest-src` and `child-src`
  // - so no font, frame, media file or plugin loads from anywhere.
  "default-src 'none'",
  // Scripts, and through the `worker-src` fallback workers, come only from the
  // extension package. No `'unsafe-inline'`, no `'unsafe-eval'` (which Manifest
  // V3 forbids an extension page in any case) and no `'wasm-unsafe-eval'`:
  // nothing here compiles WebAssembly, and `src/shared/csp-runtime.ts` switches
  // Zod to its jitless path before any schema exists, so no page ever attempts
  // `eval` or `new Function`.
  "script-src 'self'",
  "object-src 'none'",
  // The panel's stylesheet is a file the build emits. React writes `style`
  // props through the CSSOM, which `style-src` does not govern, so no
  // `'unsafe-inline'` is needed for them.
  "style-src 'self'",
  // Only packaged images. Neither `data:` nor `blob:`: no extension page
  // renders an image it did not ship.
  "img-src 'self'",
  // The extension itself, and the local service on exactly the two hosts
  // `src/background/auth.ts` (`parseServiceEndpoint`) accepts as its address -
  // named with `http:`, because the service listens over plain HTTP (CSP also
  // lets an `http:` source match `https:` on the same host, which stays on
  // loopback), and on any port, because `DEBUGGEN_PORT` is configurable (a `:*`
  // port also matches an address whose port is omitted). The `ws:` sources are
  // the service socket: a CSP `http:` source does not match a `ws:` URL. Keep
  // these hosts in step with `SERVICE_ENDPOINT_HOSTNAMES` there and with
  // LOCAL_APP_ORIGINS above.
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  // No `<base>` element can re-point the pages' relative URLs.
  "base-uri 'none'",
  // No form submits anywhere: the pairing dialog's form is handled by script
  // (`preventDefault`) and never navigates.
  "form-action 'none'",
] as const;

/**
 * `content_security_policy.extension_pages`: the policy Chrome enforces on
 * every extension page - the DevTools page, the panel document and the module
 * service worker. The two content scripts are not extension pages and are not
 * governed by it: the MAIN-world agent runs under the developer's page policy,
 * and the ISOLATED-world bridge makes no network request of its own.
 *
 * Why it is declared at all: Chrome's default Manifest V3 policy restricts
 * `script-src` and `object-src` only, and `host_permissions` govern neither
 * image loads nor CORS-enabled `fetch`. Under the default, a script running in
 * an extension page could send data to any web origin through
 * `new Image().src` or `fetch(url, { mode: 'cors' })`; under this policy both
 * are refused and reported as a `securitypolicyviolation`, so nothing an
 * extension page holds can leave the machine by either channel.
 *
 * Deliberately absent:
 *   - `frame-ancestors`: DevTools hosts the panel document in a frame of its
 *     own, so restricting the ancestors would stop the panel from rendering;
 *   - `upgrade-insecure-requests`: it would rewrite the service's plain-HTTP
 *     loopback address to `https:`, which the service does not serve;
 *   - a `sandbox` policy: the extension has no sandboxed page.
 *
 * `docs/SECURITY.md` quotes this string verbatim, and `test/manifest.test.ts`
 * asserts the built value both as a whole and directive by directive.
 */
const EXTENSION_PAGES_CSP = EXTENSION_PAGES_CSP_DIRECTIVES.join('; ');

export default defineManifest({
  manifest_version: 3,

  // Exactly the string `src/devtools/devtools.ts` passes to
  // `chrome.devtools.panels.create`, so the DevTools tab and the extension read
  // as one product.
  name: 'Debug Generator',
  version: VERSION,
  description:
    'Ask a debugging question and get a purpose-built debugging panel for the page you are inspecting.',

  // The version the browser and end-to-end suites actually run: Playwright
  // 1.63.0 bundles Chromium 153.0.8010.12, so 153 is the floor this extension is
  // proven on. The true API floor is lower - manifest `world: "MAIN"` needs 111
  // and `chrome.storage.session` needs 102 - but those versions are untested
  // here, and an untested claim of support is worse than a conservative one.
  minimum_chrome_version: '153',

  // Authored as the paths the icons occupy in the BUILT extension, not as
  // `public/`-prefixed source paths. crxjs resolves a manifest asset against the
  // Vite project root and then against `publicDir`, and emits it under the name
  // declared here, which is also where Vite's own `public/` copy lands:
  // `public/icons/16.png` -> `dist/icons/16.png`. `test/manifest.test.ts`
  // asserts each of these paths exists under `dist/`.
  icons: {
    16: 'icons/16.png',
    32: 'icons/32.png',
    48: 'icons/48.png',
    128: 'icons/128.png',
  },

  // crxjs emits this document and rewrites the path if it has to; the value here
  // is the source location of the page that calls
  // `chrome.devtools.panels.create`.
  devtools_page: 'src/devtools/devtools.html',

  // `type: "module"` is required, not cosmetic: the worker imports
  // `@debuggen/protocol` as ESM. crxjs replaces the source path below with its
  // generated loader in the built manifest but preserves the module type.
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },

  // Least privilege - three permissions, each with one caller:
  //   storage  `chrome.storage.local` for the paired devtools credential and
  //            `chrome.storage.session` for the tab-to-session registry;
  //   alarms   the keepalive that outlives the ~30 s idle suspension Manifest V3
  //            applies to the service worker, so the WebSocket to the local
  //            service is re-established rather than silently dropped;
  //   tabs     `chrome.tabs.onUpdated` (the `tab.navigated` message that keeps or
  //            drops a binding) and the consented `chrome.tabs.reload` that
  //            re-runs the agent ahead of React on an already-loaded page.
  // `scripting` is deliberately absent: both page-side scripts are declared
  // statically below and stay dormant until the service worker configures them,
  // so nothing in this extension registers or injects a script dynamically.
  // `test/manifest.test.ts` asserts that absence on its own.
  permissions: ['storage', 'alarms', 'tabs'],
  // The same two patterns are also what lets the service worker reach the local
  // service. A match pattern without a port matches EVERY port on its host, so
  // a service on whatever loopback port the developer configured
  // (`DEBUGGEN_PORT`, entered as the service address in the pairing dialog) is
  // reachable without widening this list. That is also why the address must
  // name `127.0.0.1` or `localhost` over `http:` - the rule
  // `src/background/auth.ts` (`parseServiceEndpoint`) enforces - since no other
  // host or scheme is granted.
  host_permissions: [...LOCAL_APP_ORIGINS],

  // The egress boundary the host permissions above cannot draw on their own;
  // see EXTENSION_PAGES_CSP. Only `extension_pages`: there is no sandboxed page.
  // @crxjs/vite-plugin 2.7.1 passes the key through to `dist/manifest.json`
  // unchanged on a build.
  content_security_policy: {
    extension_pages: EXTENSION_PAGES_CSP,
  },

  // Two static entries, and the ORDER IS THE CONTRACT: Chrome injects the
  // scripts of one entry in declaration order, so the MAIN-world agent must come
  // first and run at `document_start`. That is what installs the React DevTools
  // hook before the page's React loads - the whole reason the product observes
  // renders without the developer touching their own application. Swap these two
  // entries, drop `world: "MAIN"`, or relax `run_at`, and browser telemetry
  // degrades silently; `test/manifest.test.ts` is the gate that catches it.
  //
  // BUILD CONSTRAINT for `vite.config.ts` (verified against @crxjs/vite-plugin
  // 2.7.1 + Vite 8.3.0, not assumed): `agent.iife.js` is a pre-built asset that
  // `prebuild` (`scripts/copy-agent.mjs`) copies byte for byte from
  // `packages/telemetry/dist/browser-agent.iife.js` into `public/`, and Vite
  // emits it untouched at `dist/agent.iife.js`. It is NOT a source input.
  // crxjs's built-in `crx:content-scripts-iife` plugin, however, claims every
  // content script whose name matches /\.iife\.(ts|tsx|js|jsx|mjs|cjs)$/ and
  // re-bundles it with a nested Vite library build resolved from the project
  // root, which fails outright here ("[UNRESOLVED_ENTRY] Cannot resolve entry
  // module agent.iife.js") because the file lives in `public/`; it reads the
  // object passed to `crx()` directly, so no manifest transform hook can hide
  // the entry from it. `vite.config.ts` therefore passes crxjs this manifest
  // with the MAIN-world entry (and the bridge, see below) filtered out, and a
  // build hook writes `dist/manifest.json` by walking THIS array in order -
  // keeping the MAIN-world entry verbatim, keeping the bridge entry verbatim
  // but for its `js` path, and consuming crxjs's rewritten entries for the rest
  // - then asserts `dist/agent.iife.js` is SHA-256 identical to
  // `public/agent.iife.js`.
  // Re-inserting at the authored index rather than prepending is what keeps the
  // built order equal to the order written here, so swapping these two entries
  // shows up in `dist/manifest.json` and `test/manifest.test.ts` can still fail
  // on it. This array stays the declarative source of the required shape either
  // way, and re-bundling the agent is never an acceptable outcome: it would
  // break both the before-React hook installation and the byte-for-byte copy
  // contract.
  content_scripts: [
    {
      matches: [...LOCAL_APP_ORIGINS],
      js: ['agent.iife.js'],
      world: 'MAIN',
      run_at: 'document_start',
      all_frames: false,
    },
    {
      // The isolated-world relay between the page agent and the service worker.
      // `world: "ISOLATED"` is Chrome's default and is stated explicitly so the
      // boundary between the two scripts is a declaration rather than an
      // omission.
      //
      // BUILD: `vite.config.ts` bundles this TypeScript entry itself - not
      // through crxjs, whose equivalent build warns on every run - into one
      // self-contained IIFE, `dist/src/content/bridge.js`, and writes that path
      // into the built manifest at this index. An IIFE rather than a crxjs
      // loader is what lets it run at `document_start` before any page script.
      // The bundle evaluates `src/shared/csp-runtime.ts` first, so Zod raises no
      // CSP `eval` issue in the developer's page. Its source map is written
      // beside it but never linked (`build.sourcemap: 'hidden'`), so DevTools
      // on the developer's page does not fetch this extension's sources.
      matches: [...LOCAL_APP_ORIGINS],
      js: ['src/content/bridge.ts'],
      world: 'ISOLATED',
      run_at: 'document_start',
      all_frames: false,
    },
  ],
});
