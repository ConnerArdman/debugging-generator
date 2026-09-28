/**
 * Unit spec for the BUILT Manifest V3 manifest of the "Debug Generator"
 * extension: `dist/manifest.json`, as `vite build` emits it from
 * `../manifest.config.ts` through `@crxjs/vite-plugin` and the
 * `debuggen:prebuilt-content-scripts` post-build hook in `../vite.config.ts`.
 *
 * Why the built file and not the authored one: the manifest a developer loads
 * unpacked, and the one the Playwright suites pass to `--load-extension`, is the
 * artefact - and the build is where the contract can silently break. crxjs
 * rewrites every source path it bundles and re-bundles anything named
 * `*.iife.js` unless the build keeps it out of its hands; `../vite.config.ts`
 * builds the bridge itself, outside crxjs, and re-assembles `content_scripts`
 * from the authored order. This spec is the load-order guard for the
 * whole extension: if the two content-script entries swap, lose
 * `world: "MAIN"`, lose `run_at: "document_start"`, or if the pre-built agent
 * path is rewritten, the React DevTools hook is no longer installed before
 * React loads and browser telemetry degrades without any error. Nothing else
 * that runs in `pnpm test` catches that.
 *
 * Every expected value below is the one `../manifest.config.ts` declares; that
 * module is the authority, and a change there is a change to this contract.
 * The version is compared against `../package.json` at run time rather than
 * pinned here, because `manifest.config.ts` keeps it as a literal in lockstep
 * with that file and this spec is the check that the two have not drifted.
 *
 * Harness. Collected by the root `vitest.config.ts` into the `chrome-extension`
 * project. Hermetic: filesystem reads only - no browser, no network, no timers.
 * Real-Chromium verification of the same extension lives in `tests/browser/**`.
 * A missing build is a failure, never a skip: root `pnpm verify` builds before
 * it tests, so an absent `dist/manifest.json` means the build did not run or did
 * not succeed, and every case fails with the command that fixes it
 * (`pnpm --filter @debuggen/chrome-extension build`).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

/*
 * ===========================================================================
 * Locations
 * ===========================================================================
 */

/** This spec's directory, resolved from the module URL - never `process.cwd()`. */
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The `@debuggen/chrome-extension` workspace directory. */
const WORKSPACE_DIR = path.resolve(TEST_DIR, '..');

/** The unpacked extension `vite build` emits (`build.outDir` in `vite.config.ts`). */
const DIST_DIR = path.resolve(WORKSPACE_DIR, 'dist');

/** `vite.config.ts` `publicDir`: the prebuild step copies `agent.iife.js` here. */
const PUBLIC_DIR = path.resolve(WORKSPACE_DIR, 'public');

const MANIFEST_PATH = path.join(DIST_DIR, 'manifest.json');
const PACKAGE_JSON_PATH = path.join(WORKSPACE_DIR, 'package.json');

/** The one command that produces `dist/`, named in every build-related failure. */
const BUILD_COMMAND = 'pnpm --filter @debuggen/chrome-extension build';

/*
 * ===========================================================================
 * Expected values - each one is declared by ../manifest.config.ts
 * ===========================================================================
 */

/** `LOCAL_APP_ORIGINS`: the host permissions and each content script's `matches`. */
const LOCAL_APP_ORIGINS = ['http://localhost/*', 'http://127.0.0.1/*'] as const;

/** The least-privilege permission set, one caller each (storage, alarms, tabs). */
const PERMISSIONS = ['storage', 'alarms', 'tabs'] as const;

/** The DevTools page, as authored; crxjs emits it under the same path. */
const DEVTOOLS_PAGE = 'src/devtools/devtools.html';

/** The pre-built MAIN-world agent, copied verbatim from `public/` to the root of `dist/`. */
const AGENT_SCRIPT = 'agent.iife.js';

/**
 * The panel document. No manifest key names it - `src/devtools/devtools.ts`
 * passes this path to `chrome.devtools.panels.create` - so it is emitted only
 * because `vite.config.ts` declares `src/panel/panel.html` as an explicit
 * Rollup input, and `src/panel/panel.html` states this emitted path as a
 * contract.
 */
const PANEL_DOCUMENT = 'src/panel/panel.html';

/** The icon sizes `manifest.config.ts` declares, as the manifest's string keys. */
const ICON_SIZES = ['16', '32', '48', '128'] as const;

/**
 * Top-level manifest keys that must stay absent. `manifest.config.ts` lists the
 * surfaces the extension deliberately does not have (`action`, `options_page`,
 * `omnibox`, `commands`, `externally_connectable`, `web_accessible_resources`);
 * `options_ui` is the other spelling of the options surface, and
 * `optional_permissions` / `optional_host_permissions` would let the extension
 * request at run time what the exact permission assertions below forbid.
 * `web_accessible_resources` is asserted absent from the BUILT manifest, not
 * only from the authored one, because crxjs adds an entry for any
 * content-script chunk it bundles. It bundles none today - the bridge is a
 * self-contained IIFE `vite.config.ts` builds itself - so a build change that
 * would need an entry (a content-script loader chunk, for example) fails here
 * instead of silently making extension files fetchable by web pages.
 * `content_security_policy` is declared, and is asserted in its own block below.
 */
const UNDECLARED_SURFACES = [
  'action',
  'options_page',
  'options_ui',
  'omnibox',
  'commands',
  'externally_connectable',
  'web_accessible_resources',
  'optional_permissions',
  'optional_host_permissions',
] as const;

/**
 * `EXTENSION_PAGES_CSP`: the `content_security_policy.extension_pages` value,
 * character for character. `docs/SECURITY.md` quotes the same string.
 */
const EXTENSION_PAGES_CSP =
  "default-src 'none'; script-src 'self'; object-src 'none'; style-src 'self'; img-src 'self'; " +
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; " +
  "base-uri 'none'; form-action 'none'";

/**
 * The only hosts any source of the policy may name: the two loopback hosts
 * `src/background/auth.ts` (`SERVICE_ENDPOINT_HOSTNAMES`) accepts as the
 * service address.
 */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'] as const;

/**
 * `connect-src`: the extension itself, and the local service over HTTP and its
 * WebSocket on either loopback host, on any port (`DEBUGGEN_PORT` is
 * configurable).
 */
const CONNECT_SOURCES = [
  "'self'",
  'http://127.0.0.1:*',
  'http://localhost:*',
  'ws://127.0.0.1:*',
  'ws://localhost:*',
] as const;

/** The source keywords that would let an extension page run inline code or `eval`. */
const UNSAFE_SOURCE_KEYWORDS = ["'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'"] as const;

/** How deep the diagnostic search for a misplaced panel document descends. */
const PANEL_SEARCH_MAX_DEPTH = 4;

/*
 * ===========================================================================
 * The narrow shape of the built manifest this spec reads
 * ===========================================================================
 */

type JsonRecord = Readonly<Record<string, unknown>>;

/** One `content_scripts` entry; each field is `undefined` when the key is absent. */
interface BuiltContentScript {
  readonly matches: readonly string[] | undefined;
  readonly js: readonly string[] | undefined;
  readonly world: string | undefined;
  readonly runAt: string | undefined;
  readonly allFrames: boolean | undefined;
}

/** The `background` object; each field is `undefined` when the key is absent. */
interface BuiltBackground {
  readonly serviceWorker: string | undefined;
  readonly type: string | undefined;
}

/**
 * The `content_security_policy` object: every policy key it declares, and the
 * `extension_pages` policy (`undefined` when the key is absent).
 */
interface BuiltContentSecurityPolicy {
  readonly keys: readonly string[];
  readonly extensionPages: string | undefined;
}

/**
 * Only the fields this spec asserts. A present field with the wrong JSON type
 * is rejected while parsing (Chrome would refuse such a manifest outright); an
 * absent field is `undefined`, so the case that requires it fails on its own.
 */
interface BuiltManifest {
  readonly keys: readonly string[];
  readonly manifestVersion: number | undefined;
  readonly name: string | undefined;
  readonly version: string | undefined;
  readonly minimumChromeVersion: string | undefined;
  readonly devtoolsPage: string | undefined;
  readonly background: BuiltBackground | undefined;
  readonly permissions: readonly string[] | undefined;
  readonly hostPermissions: readonly string[] | undefined;
  readonly icons: Readonly<Record<string, string>> | undefined;
  readonly contentScripts: readonly BuiltContentScript[] | undefined;
  readonly contentSecurityPolicy: BuiltContentSecurityPolicy | undefined;
}

/*
 * ===========================================================================
 * Parsing helpers
 * ===========================================================================
 */

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return isArray(value) && value.every(isString);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every(isString);
}

/** A human description of a JSON value's kind, for shape errors. */
function describeJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value} (${JSON.stringify(value)})`;
}

/** Reads and parses a JSON file; the result is `unknown` until a guard narrows it. */
function readJson(file: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return parsed;
}

/**
 * `record[key]` narrowed by `guard`, or `undefined` when the key is absent.
 * Throws when the key is present with a value of the wrong JSON type.
 */
function readOptional<T>(
  record: JsonRecord,
  key: string,
  where: string,
  guard: (value: unknown) => value is T,
  expected: string,
): T | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!guard(value)) {
    throw new Error(
      `dist/manifest.json: "${where}${key}" must be ${expected}, but the built file has ` +
        `${describeJson(value)}. Chrome rejects a manifest with this shape. Correct ` +
        `manifest.config.ts (or the post-build hook in vite.config.ts), then run: ${BUILD_COMMAND}`,
    );
  }
  return value;
}

function parseContentScript(value: unknown, index: number): BuiltContentScript {
  const where = `content_scripts[${index}].`;
  if (!isRecord(value)) {
    throw new Error(
      `dist/manifest.json: "content_scripts[${index}]" must be an object, but the built file ` +
        `has ${describeJson(value)}. Rebuild with: ${BUILD_COMMAND}`,
    );
  }
  return {
    matches: readOptional(value, 'matches', where, isStringArray, 'an array of strings'),
    js: readOptional(value, 'js', where, isStringArray, 'an array of strings'),
    world: readOptional(value, 'world', where, isString, 'a string'),
    runAt: readOptional(value, 'run_at', where, isString, 'a string'),
    allFrames: readOptional(value, 'all_frames', where, isBoolean, 'a boolean'),
  };
}

function parseBackground(record: JsonRecord): BuiltBackground | undefined {
  const background = readOptional(record, 'background', '', isRecord, 'an object');
  if (background === undefined) {
    return undefined;
  }
  return {
    serviceWorker: readOptional(background, 'service_worker', 'background.', isString, 'a string'),
    type: readOptional(background, 'type', 'background.', isString, 'a string'),
  };
}

function parseContentSecurityPolicy(record: JsonRecord): BuiltContentSecurityPolicy | undefined {
  const policy = readOptional(record, 'content_security_policy', '', isRecord, 'an object');
  if (policy === undefined) {
    return undefined;
  }
  return {
    keys: Object.keys(policy),
    extensionPages: readOptional(
      policy,
      'extension_pages',
      'content_security_policy.',
      isString,
      'a string',
    ),
  };
}

/** One directive of a serialized policy: its lower-cased name and its source expressions. */
interface CspDirective {
  readonly name: string;
  readonly sources: readonly string[];
}

/**
 * Splits a serialized policy into its directives the way CSP Level 3 parses
 * one: on `;`, each token trimmed, empty tokens dropped, the name lower-cased
 * and the rest split on ASCII whitespace. Duplicates are kept, so the case that
 * forbids them can see them (a browser silently ignores every repeat).
 */
function parseCspDirectives(policy: string): readonly CspDirective[] {
  return policy
    .split(';')
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .map((token) => {
      const [name = '', ...sources] = token.split(/[\t\n\f\r ]+/);
      return { name: name.toLowerCase(), sources };
    });
}

/** Whether a source expression is a quoted keyword such as `'self'` or `'none'`. */
function isKeywordSource(source: string): boolean {
  return source.startsWith("'") && source.endsWith("'");
}

/** A scheme-only source (`https:`, `http:`, `data:`, `blob:`, `ws:`...): every host of that scheme. */
const SCHEME_ONLY_SOURCE = /^[a-z][a-z0-9+.-]*:$/i;

/** A host source: optional `scheme://`, the host, an optional `:port` or `:*`, an optional path. */
const HOST_SOURCE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/:?#]+)(?::(?:\d+|\*))?(?:\/[^?#]*)?$/i;

/** The host a host source names, or `undefined` for anything that is not a host source. */
function hostOf(source: string): string | undefined {
  return HOST_SOURCE.exec(source)?.[1]?.toLowerCase();
}

function parseManifest(raw: unknown): BuiltManifest {
  if (!isRecord(raw)) {
    throw new Error(
      `${MANIFEST_PATH} must hold a JSON object, but it holds ${describeJson(raw)}. ` +
        `Rebuild the extension with: ${BUILD_COMMAND}`,
    );
  }
  const scripts = readOptional(raw, 'content_scripts', '', isArray, 'an array');
  return {
    keys: Object.keys(raw),
    manifestVersion: readOptional(raw, 'manifest_version', '', isNumber, 'a number'),
    name: readOptional(raw, 'name', '', isString, 'a string'),
    version: readOptional(raw, 'version', '', isString, 'a string'),
    minimumChromeVersion: readOptional(raw, 'minimum_chrome_version', '', isString, 'a string'),
    devtoolsPage: readOptional(raw, 'devtools_page', '', isString, 'a string'),
    background: parseBackground(raw),
    permissions: readOptional(raw, 'permissions', '', isStringArray, 'an array of strings'),
    hostPermissions: readOptional(
      raw,
      'host_permissions',
      '',
      isStringArray,
      'an array of strings',
    ),
    icons: readOptional(raw, 'icons', '', isStringRecord, 'an object of string paths'),
    contentScripts: scripts?.map((entry, index) => parseContentScript(entry, index)),
    contentSecurityPolicy: parseContentSecurityPolicy(raw),
  };
}

/** The failure every case reports when `dist/manifest.json` does not exist. */
function missingBuildMessage(): string {
  return [
    `The built extension manifest was not found at ${MANIFEST_PATH}.`,
    '',
    'This spec asserts the manifest `vite build` emits, not manifest.config.ts, because the',
    'build is where content-script order, worlds and paths can silently change. Build the',
    'extension first:',
    '',
    `  ${BUILD_COMMAND}`,
    '',
    '(`pnpm build` at the repository root does the same, after @debuggen/telemetry, whose',
    'agent bundle the prebuild step copies into public/.)',
  ].join('\n');
}

/**
 * Reads `dist/manifest.json`, failing with the remedy when the build is absent
 * or unreadable. Called once, from `beforeAll`; the outcome - manifest or error
 * - is kept, so every case below works against one parsed manifest, and every
 * case FAILS with the same actionable error when there is none (a throwing hook
 * would instead report the cases as skipped).
 */
function loadBuiltManifest(): BuiltManifest {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(missingBuildMessage());
  }
  let raw: unknown;
  try {
    raw = readJson(MANIFEST_PATH);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${MANIFEST_PATH} is not valid JSON (${reason}). Rebuild the extension with: ${BUILD_COMMAND}`,
      { cause: error },
    );
  }
  return parseManifest(raw);
}

/** The `version` of this workspace's `package.json`, which the manifest must carry. */
function readPackageVersion(): string {
  const raw = readJson(PACKAGE_JSON_PATH);
  const version = isRecord(raw) ? raw['version'] : undefined;
  if (!isString(version)) {
    throw new Error(`${PACKAGE_JSON_PATH} declares no string "version" field.`);
  }
  return version;
}

/*
 * ===========================================================================
 * Emitted-file helpers
 * ===========================================================================
 */

/**
 * The absolute file an extension-root-relative path names inside `dist/`, or
 * `undefined` when the path would escape `dist/`. A leading `/` (how Vite links
 * assets from an emitted HTML document) is stripped first.
 */
function resolveUnderDist(emitted: string): string | undefined {
  const resolved = path.resolve(DIST_DIR, emitted.replace(/^\/+/, ''));
  const relative = path.relative(DIST_DIR, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return resolved;
}

/** Whether an extension-root-relative path names a regular file inside `dist/`. */
function existsUnderDist(emitted: string): boolean {
  const resolved = resolveUnderDist(emitted);
  return resolved !== undefined && existsSync(resolved) && statSync(resolved).isFile();
}

/** Every file under `dist/` whose name matches `pattern`, bounded to `maxDepth` levels. */
function findEmittedFiles(pattern: RegExp, maxDepth: number): string[] {
  const found: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth || !existsSync(directory)) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        found.push(path.relative(DIST_DIR, full).split(path.sep).join('/'));
      }
    }
  };
  visit(DIST_DIR, 0);
  return found.sort();
}

/** The `src` of every `<script>` element in an emitted HTML document. */
function scriptSources(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** Sorted copy, for order-insensitive comparisons of string sets. */
function sorted(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

/**
 * The load-order role a content-script entry plays, as a label the order case
 * compares. Anything that is not exactly the agent or exactly one isolated
 * script is labelled with what it actually declares, so a failure shows it.
 */
function roleOf(entry: BuiltContentScript): string {
  const files = entry.js ?? [];
  const world = entry.world ?? 'ISOLATED';
  if (world === 'MAIN' && files.length === 1 && files[0] === AGENT_SCRIPT) {
    return 'MAIN-world agent';
  }
  if (world === 'ISOLATED' && files.length === 1 && !files.includes(AGENT_SCRIPT)) {
    return 'ISOLATED-world bridge';
  }
  return `${world}-world entry loading [${files.join(', ')}]`;
}

/*
 * ===========================================================================
 * The contract
 * ===========================================================================
 */

describe('Debug Generator extension build (dist/manifest.json)', () => {
  /** What `beforeAll` read: the parsed manifest, or the error explaining why there is none. */
  let loaded: { readonly manifest: BuiltManifest } | { readonly error: Error } | undefined;

  /** The parsed manifest, or the load error rethrown so the calling case fails with it. */
  const built = (): BuiltManifest => {
    if (loaded === undefined) {
      throw new Error(
        `dist/manifest.json was not loaded. Build the extension with: ${BUILD_COMMAND}`,
      );
    }
    if ('error' in loaded) {
      throw loaded.error;
    }
    return loaded.manifest;
  };

  /** `content_scripts[index]`, or a failure stating how many entries the build declares. */
  const contentScript = (index: number): BuiltContentScript => {
    const scripts = built().contentScripts ?? [];
    const entry = scripts[index];
    if (entry === undefined) {
      throw new Error(
        `dist/manifest.json declares ${scripts.length} content_scripts entr(ies), so ` +
          `content_scripts[${index}] does not exist. manifest.config.ts declares two: the ` +
          `MAIN-world agent (${AGENT_SCRIPT}) first, then the ISOLATED-world bridge.`,
      );
    }
    return entry;
  };

  beforeAll(() => {
    try {
      loaded = { manifest: loadBuiltManifest() };
    } catch (error) {
      loaded = { error: error instanceof Error ? error : new Error(String(error)) };
    }
  });

  describe('built manifest', () => {
    it('has been built: dist/manifest.json exists and holds a manifest object', () => {
      expect(existsSync(MANIFEST_PATH), missingBuildMessage()).toBe(true);
      expect(built().keys, `${MANIFEST_PATH} holds an empty object`).not.toHaveLength(0);
    });

    it('is a Manifest V3 manifest', () => {
      expect(
        built().manifestVersion,
        '"manifest_version" must be 3: Chrome no longer loads Manifest V2 extensions',
      ).toBe(3);
    });

    it('is named "Debug Generator", the title of the DevTools panel it contributes', () => {
      expect(
        built().name,
        '"name" must be "Debug Generator", the same string src/devtools/devtools.ts gives the panel',
      ).toBe('Debug Generator');
    });

    it('carries the version declared in package.json', () => {
      expect(
        built().version,
        '"version" must equal apps/chrome-extension/package.json "version"; manifest.config.ts ' +
          'keeps its VERSION literal in lockstep with it',
      ).toBe(readPackageVersion());
    });

    it('requires Chrome 153, the Chromium the browser and end-to-end suites run', () => {
      expect(
        built().minimumChromeVersion,
        '"minimum_chrome_version" must be "153" (Playwright 1.63.0 bundles Chromium 153)',
      ).toBe('153');
    });
  });

  describe('background service worker and DevTools page', () => {
    it('declares the background service worker as an ES module', () => {
      expect(
        built().background?.type,
        '"background.type" must be "module": the service worker imports @debuggen/protocol as ESM',
      ).toBe('module');
    });

    it('ships the service worker script it names', () => {
      const serviceWorker = built().background?.serviceWorker;
      expect(
        serviceWorker !== undefined && existsUnderDist(serviceWorker),
        `"background.service_worker" must name a file under dist/ (declared: ${String(serviceWorker)})`,
      ).toBe(true);
    });

    it('names src/devtools/devtools.html as the DevTools page', () => {
      expect(
        built().devtoolsPage,
        `"devtools_page" must be "${DEVTOOLS_PAGE}", the path manifest.config.ts declares`,
      ).toBe(DEVTOOLS_PAGE);
    });

    it('ships the DevTools page it names', () => {
      const page = built().devtoolsPage;
      expect(
        page !== undefined && existsUnderDist(page),
        `"devtools_page" must name a file under dist/ (declared: ${String(page)}); without it ` +
          'DevTools opens without the Debug Generator panel',
      ).toBe(true);
    });
  });

  describe('permissions', () => {
    it('requests exactly the storage, alarms and tabs permissions', () => {
      expect(
        sorted(built().permissions),
        '"permissions" must be exactly storage, alarms and tabs - manifest.config.ts documents ' +
          'one caller for each and no other permission is needed',
      ).toEqual(sorted(PERMISSIONS));
    });

    it('does not request the scripting permission, because both page scripts are static', () => {
      expect(
        built().permissions ?? [],
        '"scripting" must not be requested: the agent and the bridge are declared statically ' +
          'in content_scripts, so nothing is registered or injected at run time',
      ).not.toContain('scripting');
    });

    it('grants host access to the two local app origins and nothing else', () => {
      expect(
        built().hostPermissions,
        `"host_permissions" must be exactly ${LOCAL_APP_ORIGINS.join(' and ')} - the local ` +
          'app origins, which is also what permits a MAIN-world content script on them',
      ).toEqual([...LOCAL_APP_ORIGINS]);
    });

    it('declares no surface beyond the DevTools page, service worker and content scripts', () => {
      const manifestKeys = built().keys;
      expect(
        UNDECLARED_SURFACES.filter((key) => manifestKeys.includes(key)),
        'these manifest keys are not declared by manifest.config.ts and would widen the ' +
          'permission boundary docs/SECURITY.md documents',
      ).toEqual([]);
    });
  });

  describe('extension-page content-security policy', () => {
    /** `content_security_policy.extension_pages`, or a failure explaining its absence. */
    const extensionPagesPolicy = (): string => {
      const policy = built().contentSecurityPolicy?.extensionPages;
      if (policy === undefined) {
        throw new Error(
          'dist/manifest.json declares no "content_security_policy.extension_pages", so every ' +
            "extension page runs under Chrome's default policy, which leaves image loads and " +
            'CORS fetch to any web origin open. manifest.config.ts declares it as ' +
            `EXTENSION_PAGES_CSP; rebuild with: ${BUILD_COMMAND}`,
        );
      }
      return policy;
    };

    /** Every directive of the built policy, in declaration order. */
    const directives = (): readonly CspDirective[] => parseCspDirectives(extensionPagesPolicy());

    /** The sources of one directive, or `undefined` when the policy does not declare it. */
    const sourcesOf = (name: string): readonly string[] | undefined =>
      directives().find((directive) => directive.name === name)?.sources;

    /** `<directive> <source>` for every source of every directive, for failure messages. */
    const everySource = (): readonly { readonly directive: string; readonly source: string }[] =>
      directives().flatMap(({ name, sources }) =>
        sources.map((source) => ({ directive: name, source })),
      );

    it('declares content_security_policy.extension_pages as exactly the documented policy', () => {
      expect(
        extensionPagesPolicy(),
        '"content_security_policy.extension_pages" must equal EXTENSION_PAGES_CSP in ' +
          'manifest.config.ts, the string docs/SECURITY.md quotes',
      ).toBe(EXTENSION_PAGES_CSP);
    });

    it('declares only the extension_pages policy, and no sandbox policy', () => {
      expect(
        built().contentSecurityPolicy?.keys,
        '"content_security_policy" must hold exactly one key, "extension_pages": the ' +
          'extension has no sandboxed page',
      ).toEqual(['extension_pages']);
    });

    it('declares each directive once', () => {
      const names = directives().map((directive) => directive.name);
      expect(
        names.filter((name, index) => names.indexOf(name) !== index),
        'a repeated directive is ignored by the browser, so the policy it appears to add is ' +
          'not enforced',
      ).toEqual([]);
    });

    it("denies every resource type by default: default-src 'none'", () => {
      expect(
        sourcesOf('default-src'),
        "default-src must be exactly 'none', so fonts, frames, media and any directive not " +
          'named fall back to loading nothing',
      ).toEqual(["'none'"]);
    });

    it("loads scripts only from the extension package: script-src exactly 'self'", () => {
      expect(
        sourcesOf('script-src'),
        "script-src must be exactly 'self': no inline script, no eval of any kind and no " +
          'remote script',
      ).toEqual(["'self'"]);
    });

    it('connects only to the extension itself and the local service on the loopback hosts', () => {
      expect(
        sorted(sourcesOf('connect-src')),
        `connect-src must be exactly ${CONNECT_SOURCES.join(' ')}: the service addresses ` +
          'src/background/auth.ts accepts, over HTTP and WebSocket, on any port',
      ).toEqual(sorted(CONNECT_SOURCES));
    });

    it.each(['img-src', 'style-src'])(
      "loads %s only from the extension package: exactly 'self'",
      (name) => {
        const kind = name === 'img-src' ? 'image' : 'stylesheet';
        expect(
          sourcesOf(name),
          `${name} must be exactly 'self': only packaged ${kind}s, never an inline or remote ` +
            `one - a remote ${kind} load is a request to a web origin the host permissions do ` +
            'not govern',
        ).toEqual(["'self'"]);
      },
    );

    it.each(['object-src', 'base-uri', 'form-action'])("declares %s 'none'", (name) => {
      expect(sourcesOf(name), `${name} must be exactly 'none'`).toEqual(["'none'"]);
    });

    it("allows no 'unsafe-inline', 'unsafe-eval' or 'wasm-unsafe-eval' in any directive", () => {
      expect(
        everySource()
          .filter(({ source }) =>
            UNSAFE_SOURCE_KEYWORDS.some((keyword) => keyword === source.toLowerCase()),
          )
          .map(({ directive, source }) => `${directive} ${source}`),
        'no extension page may run inline code or eval; src/shared/csp-runtime.ts keeps Zod ' +
          'jitless so none is needed',
      ).toEqual([]);
    });

    it('names no wildcard host in any directive', () => {
      expect(
        everySource()
          .filter(({ source }) => hostOf(source)?.startsWith('*') === true)
          .map(({ directive, source }) => `${directive} ${source}`),
        'a "*" or "*." host admits web origins; name the loopback hosts explicitly',
      ).toEqual([]);
    });

    it('names no scheme-only source such as https:, http:, data: or blob: in any directive', () => {
      expect(
        everySource()
          .filter(({ source }) => SCHEME_ONLY_SOURCE.test(source))
          .map(({ directive, source }) => `${directive} ${source}`),
        'a scheme-only source admits every host of that scheme',
      ).toEqual([]);
    });

    it('names no host other than 127.0.0.1 and localhost in any directive', () => {
      expect(
        everySource()
          .filter(({ source }) => !isKeywordSource(source) && !SCHEME_ONLY_SOURCE.test(source))
          .filter(({ source }) => {
            const host = hostOf(source);
            return host === undefined || !LOOPBACK_HOSTS.some((loopback) => loopback === host);
          })
          .map(({ directive, source }) => `${directive} ${source}`),
        `every host source must name ${LOOPBACK_HOSTS.join(' or ')}, the loopback hosts the ` +
          'local service is reached on',
      ).toEqual([]);
    });

    it.each([
      {
        name: 'frame-ancestors',
        why: 'DevTools hosts the panel document in a frame of its own, so restricting its ancestors stops the panel from rendering',
      },
      {
        name: 'upgrade-insecure-requests',
        why: "it would rewrite the service's plain-HTTP loopback address to https:",
      },
      {
        name: 'sandbox',
        why: 'a sandboxed extension page loses its origin and with it the extension APIs',
      },
    ])('does not declare $name', ({ name, why }) => {
      expect(
        directives().map((directive) => directive.name),
        `the policy must not declare ${name}: ${why}`,
      ).not.toContain(name);
    });
  });

  describe('content scripts', () => {
    it('declares exactly two static content scripts', () => {
      expect(
        built().contentScripts?.length,
        '"content_scripts" must hold exactly two entries: the MAIN-world agent and the ' +
          'ISOLATED-world bridge',
      ).toBe(2);
    });

    it('injects the MAIN-world telemetry agent first and the isolated-world bridge second', () => {
      expect(
        (built().contentScripts ?? []).map(roleOf),
        'Chrome injects content scripts in declaration order, and the agent must run first to ' +
          'install the React DevTools hook before React loads. Restore the order in ' +
          'manifest.config.ts; if it is already right there, the post-build hook in ' +
          'vite.config.ts no longer re-inserts the agent at its authored index.',
      ).toEqual(['MAIN-world agent', 'ISOLATED-world bridge']);
    });

    it("runs the telemetry agent in the page's MAIN world", () => {
      expect(
        contentScript(0).world,
        `content_scripts[0] (${AGENT_SCRIPT}) must declare world "MAIN": only the page's own ` +
          'realm can see the React DevTools hook and patch fetch/XHR',
      ).toBe('MAIN');
    });

    it('loads the telemetry agent from agent.iife.js at the extension root, unrenamed', () => {
      expect(
        contentScript(0).js,
        `content_scripts[0].js must be exactly ["${AGENT_SCRIPT}"]: the pre-built agent is ` +
          'copied verbatim, never re-bundled or renamed by @crxjs/vite-plugin',
      ).toEqual([AGENT_SCRIPT]);
    });

    it('ships agent.iife.js at the root of dist/', () => {
      expect(
        existsUnderDist(AGENT_SCRIPT),
        `dist/${AGENT_SCRIPT} was not emitted: vite.config.ts publicDir copies it from ` +
          `public/, where the prebuild step puts it. Run: ${BUILD_COMMAND}`,
      ).toBe(true);
    });

    it('ships agent.iife.js byte for byte as the prebuild step copied it into public/', () => {
      const emitted = path.join(DIST_DIR, AGENT_SCRIPT);
      const copied = path.join(PUBLIC_DIR, AGENT_SCRIPT);
      if (!existsSync(emitted) || !existsSync(copied)) {
        throw new Error(
          `Cannot compare ${emitted} with ${copied}: at least one is missing. The prebuild ` +
            '(scripts/copy-agent.mjs) copies packages/telemetry/dist/browser-agent.iife.js ' +
            `into public/, and the build copies it to dist/. Run: ${BUILD_COMMAND}`,
        );
      }
      expect(
        readFileSync(emitted).equals(readFileSync(copied)),
        `dist/${AGENT_SCRIPT} differs from public/${AGENT_SCRIPT}: something in the build ` +
          'transformed the pre-built agent, or dist/ is stale. Rebuild with: ' +
          BUILD_COMMAND,
      ).toBe(true);
    });

    it('runs the bridge in the ISOLATED world', () => {
      expect(
        contentScript(1).world ?? 'ISOLATED',
        'content_scripts[1] (the bridge) must run in the ISOLATED world - declared, or absent ' +
          "as Chrome's default - never in the page's MAIN world",
      ).toBe('ISOLATED');
    });

    it('loads the bridge from the one bundled JavaScript file built from src/content/bridge.ts', () => {
      const files = contentScript(1).js ?? [];
      expect(
        files.length === 1 && /(?:^|\/)bridge[^/]*\.js$/.test(files[0] ?? ''),
        'content_scripts[1].js must name exactly one emitted bridge*.js bundle, built by ' +
          `vite.config.ts from src/content/bridge.ts (declared: [${files.join(', ')}])`,
      ).toBe(true);
    });

    it('ships the bridge bundle it names', () => {
      const files = contentScript(1).js ?? [];
      expect(
        files.filter((file) => !existsUnderDist(file)),
        'content_scripts[1].js names files that are not under dist/',
      ).toEqual([]);
    });

    const ENTRIES = [
      { index: 0, script: 'MAIN-world agent' },
      { index: 1, script: 'ISOLATED-world bridge' },
    ] as const;

    it.each(ENTRIES)('injects the $script at document_start', ({ index, script }) => {
      expect(
        contentScript(index).runAt,
        `content_scripts[${index}] (${script}) must declare run_at "document_start"; Chrome's ` +
          "default, document_idle, runs after the page's own scripts - too late to install the " +
          'React DevTools hook before React loads',
      ).toBe('document_start');
    });

    it.each(ENTRIES)('injects the $script into the top frame only', ({ index, script }) => {
      expect(
        contentScript(index).allFrames,
        `content_scripts[${index}] (${script}) must declare all_frames false`,
      ).toBe(false);
    });

    it.each(ENTRIES)(
      'injects the $script on the two local app origins only',
      ({ index, script }) => {
        expect(
          sorted(contentScript(index).matches),
          `content_scripts[${index}] (${script}) "matches" must be exactly ` +
            LOCAL_APP_ORIGINS.join(' and '),
        ).toEqual(sorted(LOCAL_APP_ORIGINS));
      },
    );
  });

  describe('emitted documents and icons', () => {
    it('declares the 16, 32, 48 and 128 px icons', () => {
      expect(
        sorted(Object.keys(built().icons ?? {})),
        '"icons" must declare exactly the 16, 32, 48 and 128 px sizes manifest.config.ts lists',
      ).toEqual(sorted(ICON_SIZES));
    });

    it.each(ICON_SIZES)('ships the %s px icon it declares', (size) => {
      const icon = built().icons?.[size];
      expect(
        icon !== undefined && existsUnderDist(icon),
        `"icons.${size}" must name a file under dist/ (declared: ${String(icon)}); ` +
          'vite.config.ts publicDir copies public/icons/ there',
      ).toBe(true);
    });

    it('emits the panel document at src/panel/panel.html, the page the panel opens', () => {
      const emitted = existsUnderDist(PANEL_DOCUMENT);
      const elsewhere = emitted
        ? []
        : findEmittedFiles(/^panel.*\.html$/, PANEL_SEARCH_MAX_DEPTH).filter(
            (file) => file !== PANEL_DOCUMENT,
          );
      expect(
        emitted,
        [
          `dist/${PANEL_DOCUMENT} was not emitted. No manifest key names the panel document -`,
          'src/devtools/devtools.ts opens it through chrome.devtools.panels.create - so it is',
          'built only because vite.config.ts declares src/panel/panel.html as an explicit',
          'Rollup input; restore that input.',
          elsewhere.length > 0
            ? `A panel document was emitted elsewhere instead: ${elsewhere.join(', ')}.`
            : 'No panel*.html was emitted anywhere under dist/.',
        ].join(' '),
      ).toBe(true);
    });

    it.each([
      { page: DEVTOOLS_PAGE, role: 'DevTools page' },
      { page: PANEL_DOCUMENT, role: 'panel document' },
    ])('links the $role only to scripts emitted under dist/', ({ page, role }) => {
      const file = resolveUnderDist(page);
      if (file === undefined || !existsUnderDist(page)) {
        throw new Error(`The ${role} dist/${page} was not emitted. Rebuild with: ${BUILD_COMMAND}`);
      }
      const sources = scriptSources(readFileSync(file, 'utf8'));
      expect(
        sources.length,
        `dist/${page} loads no script, so the ${role} does nothing`,
      ).toBeGreaterThan(0);
      expect(
        sources.filter((source) => !existsUnderDist(source)),
        `dist/${page} links scripts that are not emitted under dist/`,
      ).toEqual([]);
    });
  });
});
